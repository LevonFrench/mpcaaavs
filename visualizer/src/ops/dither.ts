// The `dither` operator's registration — the CPU half of `shaders/op-dither.wgsl`.
//
// Independently authored from standard ordered-dither concepts. The Bayer
// threshold is bit-interleaved; the clustered screen is a crossed-cosine field
// designed for this layer graph and its deterministic replay contract.
//
// Dithering was not in the plan at all, and it earns its place for the reason
// plan §7 gives: operators MULTIPLY. One pass yields a dithered version of all
// seventeen sources.
//
// What this module deliberately does NOT do:
//   - No GPU handles. It is a `PassDescriptor` and pure functions, importable
//     by the preset validator and the golden harness on a machine with no
//     adapter.
//   - No wall clock and no `Math.random`. The noise pattern seeds from the
//     LAYER (`ctx.seed`), so two runs of a preset dither identically (§4.7).
//     A time-seeded dither crawls and breaks the golden harness.
//   - No error diffusion. See the note in the shader: Floyd-Steinberg is
//     serial by construction and cannot be a fragment pass.
//   - No opinion about blend or z-order. It crossfades on `amount`, so it is a
//     true no-op at 0 rather than a fade to black.

import type { ParamValue, PassContext, PassDescriptor } from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP, passBindingsWGSL } from '../renderer.ts';
import DITHER_WGSL from '../shaders/op-dither.wgsl';

/** Field order. Must match `struct Dither` below, float for float. */
const F_AMOUNT = 0;
const F_PATTERN = 1;
const F_CELL_PX = 2;
const F_LEVELS = 3;
const F_MONO = 4;
const F_TINT = 5;
const F_SCREEN_SCALE = 6;
const F_PAD = 7;
/** 8 floats = 32 bytes, a multiple of 16 (WGSL uniform alignment). */
const DITHER_FLOATS = 8;

const PATTERNS = ['bayer', 'halftone', 'noise'] as const;
export type DitherPattern = (typeof PATTERNS)[number];

const DITHER_DECL = `
struct Dither {
  amount      : f32,
  pattern     : f32,
  cellPx      : f32,
  levels      : f32,
  mono        : f32,
  tint        : f32,
  screenScale : f32,
  pad         : f32,
};
@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> D : Dither;
`;

function num(p: Readonly<Record<string, ParamValue>>, k: string, d: number): number {
  const v = p[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

const SHAPE = {
  type: 'dither',
  family: 'operator',
  /** The accumulated frame. This operator draws nothing of its own. */
  input: 'accumulator',
  uniformFloats: DITHER_FLOATS,
  code: '',
} as const satisfies PassDescriptor;

export const DITHER_DEFAULTS = {
  amount: 1,
  pattern: 'bayer' as DitherPattern,
  cellPx: 3,
  levels: 4,
  mono: false,
  tint: 0,
  screenScale: 0.5,
};

export const ditherPass: PassDescriptor = {
  ...SHAPE,
  code: [
    PASS_COMMON_WGSL,
    passBindingsWGSL(SHAPE),
    DITHER_DECL,
    DITHER_WGSL,
  ].join('\n'),

  /**
   * Full resolution, and this one genuinely needs it.
   *
   * The pass already quantises position itself through `cellPx`, so running the
   * PASS at half resolution would dither a blurred copy and then be upsampled —
   * two resamplings fighting, and the pattern that is the entire point comes
   * back soft. If it needs to be cheaper, raise `cellPx`; that costs nothing
   * and is what the parameter is for.
   */
  defaultResolutionScale: 1,

  writeUniforms(out: Float32Array, ctx: PassContext): void {
    const p = ctx.params;

    // Folded into `amount` rather than applied by the renderer, so the envelope
    // dials the EFFECT in and out instead of fading the frame to black.
    out[F_AMOUNT] = clamp(num(p, 'amount', DITHER_DEFAULTS.amount), 0, 1) * ctx.progress;

    const pat = String(p['pattern'] ?? DITHER_DEFAULTS.pattern);
    const pi = PATTERNS.indexOf(pat as DitherPattern);
    out[F_PATTERN] = pi < 0 ? 0 : pi;

    // In attachment pixels, not UV: a dither cell is a physical thing and must
    // not change size when the layer's resolution scale does.
    out[F_CELL_PX] = Math.max(1, num(p, 'cellPx', DITHER_DEFAULTS.cellPx));

    // Two levels is pure black-and-white, which is the classic look and also
    // the one that most needs a sensible `cellPx`.
    out[F_LEVELS] = Math.max(2, Math.round(num(p, 'levels', DITHER_DEFAULTS.levels)));

    out[F_MONO] = p['mono'] === true ? 1 : 0;
    out[F_TINT] = clamp(num(p, 'tint', DITHER_DEFAULTS.tint), 0, 1);

    // Scales the halftone screen independently of the cell grid, which is what
    // lets a coarse dot sit on a fine pixel grid — the print look.
    out[F_SCREEN_SCALE] = Math.max(0.05, num(p, 'screenScale', DITHER_DEFAULTS.screenScale));

    out[F_PAD] = 0;
  },
};
