// The kaleidoscope operator — registration for `shaders/kaleido.wgsl`.
//
// Plan §7: operators are multiplicative, so eight sources times five operators
// is forty looks and the operators are worth building first. This one is the
// oldest pass in the project — it was the operator in the Phase 0 vertical slice
// — and all that changed here is where its numbers come from: `main.ts`'s
// module-level `state` object before, `LayerSpec.params` plus the audio clock
// now.
//
// What this module deliberately does NOT do:
//   - No GPUDevice, no texture, no pipeline. Data and pure functions, so the
//     preset validator and the golden harness can import it with no adapter
//     present (contracts.ts, file header).
//   - No wall clock. The rotation is a function of `ctx.bars`, which is the
//     audio clock (§4.6). `ctx.time` is not read at all.
//   - No binding numbers. `PASS_BINDING` supplies every one.
//   - No opinion about blend, opacity or z-order. Those are the layer's.
//
// Art-direction §4.1 names this pass as its own stated exception: nothing else
// in the project may radiate from the centre of the frame, because that reads as
// a cheap "pulse from the middle". A kaleidoscope's entire point IS a centre —
// which is exactly why it is the exception rather than the rule, and why the
// document says it should not be applied to everything.

import type { ParamValue, PassContext, PassDescriptor } from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP, passBindingsWGSL } from '../renderer.ts';
import KALEIDO_WGSL from '../shaders/kaleido.wgsl';

/** f32 count of `struct Kal`. Mirrors the WGSL declaration, field for field. */
const KAL_FLOATS = 4;

// Offsets in FLOATS. Named for the same reason `renderer.ts` names its own.
const U_SEGMENTS = 0;
const U_ROTATE = 1;
const U_MIX = 2;
// 3 is the struct's tail pad. Never written, never read.

const TAU = Math.PI * 2;

/**
 * Upper bound on the wedge count.
 *
 * Not taste — at 64 wedges each is 5.6 degrees wide, which at 1440p is a few
 * pixels at the centre, so every wedge is sampling the same handful of texels
 * and the result is a radial smear rather than a kaleidoscope. A preset arrives
 * over a URL hash and must not be able to ask for 10 000.
 */
const MAX_SEGMENTS = 64;

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/**
 * Defaults, and the authoritative list of what this operator understands.
 *
 * These are the values the verified vertical slice ran with, so a layer that
 * sets none of them looks exactly like the Phase 0 build.
 */
export const KALEIDO_DEFAULTS: Readonly<Record<string, ParamValue>> = {
  /** Wedges. Below 2 the pass is a bypass, which is a legitimate state and is how the `1` key worked. */
  segments: 6,
  /**
   * Bars per full revolution of the fold. Bars, not seconds — a rotation locked
   * to the bar phrases with the music instead of ticking against it
   * (art-direction §3.3). 64 reproduces the slice, where the shared spin angle
   * (a revolution every 16 bars) was scaled by 0.25 on its way into this pass.
   */
  rotBars: 64,
  /** 0..1 against the untransformed frame. Below ~0.5 the fold reads as a texture rather than a structure. */
  mix: 0.7,
};

function num(
  params: Readonly<Record<string, ParamValue>>,
  key: string,
  lo: number,
  hi: number,
): number {
  const fallback = KALEIDO_DEFAULTS[key];
  const raw = params[key] ?? fallback;
  const v = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(v)) return typeof fallback === 'number' ? fallback : lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/** Positive fractional part. `%` keeps the sign of the dividend and beats can be negative on a pre-roll. */
function fract(v: number): number {
  return v - Math.floor(v);
}

// ---------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------

/**
 * The shape fields, declared once — `passBindingsWGSL` needs them to generate
 * the `src`/`samp` declarations and the descriptor needs those declarations to
 * have its `code`. Declaring the shape twice would compile perfectly and build a
 * binding set that does not match the layout `renderer.ts` derives from the real
 * descriptor.
 *
 * `input: 'accumulator'` is what an operator IS — it transforms the frame
 * composited so far — and stating it is what makes the ping-pong cost explicit
 * rather than inferred.
 */
const SHAPE = {
  /** Matches `LayerSpec.type` in the default preset. Not `'kaleido'`. */
  type: 'kaleidoscope',
  family: 'operator',
  input: 'accumulator',
  uniformFloats: KAL_FLOATS,
} as const;

/**
 * The pass's own uniform binding, generated rather than typed.
 *
 * `passBindingsWGSL` covers every binding whose declaration the renderer can
 * know — input, sampler, history, storage — but not this one, because the struct
 * belongs to the pass. Appending it here is the closest available thing to the
 * same guarantee: `PASS_BINDING.params` is imported, so the number cannot drift.
 * It goes after the shader source because that is where `struct Kal` is
 * declared.
 */
const PARAMS_DECL =
  `@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> K : Kal;`;

export const kaleidoPass: PassDescriptor = {
  ...SHAPE,
  code: [
    PASS_COMMON_WGSL,
    passBindingsWGSL({ ...SHAPE, code: '' }),
    KALEIDO_WGSL,
    PARAMS_DECL,
  ].join('\n'),

  /**
   * Full resolution by default.
   *
   * A fold multiplies spatial frequency the same way tiling does — N wedges of
   * the source packed into the same frame — so it is a poor candidate for
   * §4.11's half-res path, and the aliasing it produces is radial, which is the
   * kind the eye is best at seeing. Advisory only; a preset that needs the
   * bandwidth back can still ask for it.
   */
  defaultResolutionScale: 1,

  writeUniforms(out: Float32Array, ctx: PassContext): void {
    const p = ctx.params;
    out[U_SEGMENTS] = Math.floor(num(p, 'segments', 0, MAX_SEGMENTS));
    // Absolute, not integrated. An angle accumulated frame by frame is a
    // function of the frame history and so is not reproducible across runs,
    // which §4.7 forbids outright. The fractional part is taken before scaling
    // so the value the shader receives stays small and exact through a long set.
    out[U_ROTATE] = fract(ctx.bars / Math.max(num(p, 'rotBars', 1e-3, 4096), 1e-3)) * TAU;
    out[U_MIX] = num(p, 'mix', 0, 1);
    // Aspect is NOT packed here. The shader reads `C.aspect`, which the renderer
    // fills from the attachment it is actually writing — a param copy is a
    // second value that goes stale the moment a resolution scale is applied.
  },
};
