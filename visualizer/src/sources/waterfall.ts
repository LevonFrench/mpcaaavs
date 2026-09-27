// The waterfall source's registration (scrolling spectrogram). Look: GRID.
//
// Describes the pass and packs its params; the drawing argument — the log axis,
// the max-resampling, the OKLab ramp and, above all, the ring offset — is in
// `src-waterfall.wgsl`. No device, no buffer, no pipeline: see `scope.ts` for
// the full statement of why that matters.
//
// The one thing worth stating on this side is what `span` is and is not. The
// spectrogram ring holds `SPECTROGRAM_ROWS` rows and gains one per ANALYSIS
// frame, and the analysis runs off the same rAF the renderer does — so the wall
// time a row represents is whatever the frame rate happened to be, and there is
// no honest conversion from rows to beats anywhere in the current contract.
// `span` is therefore a fraction of the held history, dimensionless, and NOT a
// duration in beats. Expressing it in beats would mean inventing a rows-per-beat
// figure that is simply not true, which is worse than a unitless dial: the
// picture would claim a musical grid it does not have. If `AudioSnapshot` ever
// carries an analysis rate, this is the parameter that should start using it.

import { AUDIO_WGSL } from '../audiogpu.ts';
import type { ParamValue, PassContext, PassDescriptor } from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP } from '../renderer.ts';
import body from '../shaders/src-waterfall.wgsl';

/** See the identical note in `scope.ts` — the binding number is generated, never typed. */
const PARAMS_WGSL = `@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> P : Params;`;

/** Field order. Must match `struct Params` in `src-waterfall.wgsl` float for float. */
const F_ORIENT = 0;
const F_FLIP = 1;
const F_SPAN = 2;
const F_GAIN = 3;
const F_GAMMA = 4;
const F_LO = 5;
const F_HI = 6;
const F_FLOOR = 7;
const F_CX = 8;
const F_CY = 9;
const F_HW = 10;
const F_HH = 11;
const F_HUE_SPREAD = 12;
const F_EDGE = 13;
const F_TOP = 14;
// 15 is the struct's tail pad. Never written, never read.
const PARAM_FLOATS = 16;

const ORIENTATIONS = ['vertical', 'horizontal'] as const;

/**
 * Default axis, as a fraction of Nyquist — the same figures `spectrum.ts` uses,
 * and for the same reason: at 48 kHz these are ~31 Hz and ~15.4 kHz, low enough
 * for the fundamental of a kick and high enough for hats, with nothing above
 * where the spectrum is mostly dither.
 *
 * The bottom of the axis is NOT zero and cannot be: the axis is geometric and a
 * ratio to zero has no logarithm.
 */
const DEFAULT_LO = 0.0013;
const DEFAULT_HI = 0.64;

/**
 * Widest hue excursion the ramp is allowed, in radians.
 *
 * ~0.9 rad is 52 degrees — a rotation, not a sweep. Uncapped, a preset could set
 * this to 2*pi and get exactly the rainbow LUT the art direction names as the
 * number-one amateur tell (§2.2, §5). The cap is here rather than in the shader
 * because a clamp is cheaper on the CPU and the shader should not have to
 * defend itself against its own uniform block.
 */
const MAX_HUE_SPREAD = 0.9;

export const waterfallPass: PassDescriptor = {
  type: 'waterfall',
  family: 'source',
  // A source draws INTO the accumulator, so it cannot sample it. Explicit
  // because the default is easy to assume the other way round.
  input: 'none',
  usesAudio: true,
  code: [PASS_COMMON_WGSL, AUDIO_WGSL, PARAMS_WGSL, body].join('\n'),

  // Fullscreen geometry, issued as a vertex count so that progress 0 draws
  // literally nothing (Phase 5 DoD) rather than a full-frame pass that happens
  // to be transparent.
  draw: {
    kind: 'vertices',
    vertexCount: (ctx) => (ctx.progress > 0 ? 3 : 0),
  },

  /**
   * The panel edge and the "now" line are analytic edges defined in attachment
   * pixels, so a half-res pass is a half-res edge smeared bilinearly back up.
   * Advisory only — §4.11 says the scale is a budget decision and the budget
   * belongs to the show.
   */
  defaultResolutionScale: 1,

  uniformFloats: PARAM_FLOATS,
  writeUniforms(out: Float32Array, ctx: PassContext): void {
    const p = ctx.params;

    out[F_ORIENT] = ORIENTATIONS.indexOf(orientation(p, 'orientation', 'vertical'));
    out[F_FLIP] = bool(p, 'flip', false) ? 1 : 0;
    // The whole ring by default. Less than 1 is a faster scroll over a shorter
    // window, which is what a busy track wants.
    out[F_SPAN] = clamp(num(p, 'span', 1), 0.02, 1);

    out[F_GAIN] = Math.max(num(p, 'gain', 1.5), 0);
    // Below 1: magnitude is not perceptual, and a linear mapping puts everything
    // interesting in the bottom fifth of the ramp.
    out[F_GAMMA] = Math.max(num(p, 'gamma', 0.55), 1e-3);

    const lo = clamp(num(p, 'fLo', DEFAULT_LO), 1e-5, 0.98);
    out[F_LO] = lo;
    out[F_HI] = clamp(num(p, 'fHi', DEFAULT_HI), lo * 1.01, 1);

    // The floor knee. Deep blacks are not a side effect of a dark palette, they
    // are a decision (§2.3) — without this the whole panel sits on the ramp's
    // darkest stop and reads as a grey slab.
    out[F_FLOOR] = clamp(num(p, 'floorKnee', 0.14), 1e-4, 0.9);

    // A panel, not the whole frame. Grid wants ~50% negative space and a
    // full-bleed spectrogram has none at all (§4.3). A preset that genuinely
    // wants full bleed sets halfWidth and halfHeight to 0.5.
    out[F_CX] = num(p, 'centreX', 0.5);
    out[F_CY] = num(p, 'centreY', 0.62);
    out[F_HW] = clamp(num(p, 'halfWidth', 0.46), 1e-3, 0.5);
    out[F_HH] = clamp(num(p, 'halfHeight', 0.3), 1e-3, 0.5);

    // A rotation of at most ~50 degrees across the whole ramp. See MAX_HUE_SPREAD.
    out[F_HUE_SPREAD] = clamp(num(p, 'hueSpread', 0.32), 0, MAX_HUE_SPREAD);

    // The leading edge is the panel's one lit line. It is deliberately modest by
    // default: it marks "now", it is not the subject.
    out[F_EDGE] = Math.max(num(p, 'edgeLevel', 0.55), 0);

    // Multiplier on whatever HDR headroom the palette slot already has, applied
    // to the hottest cells alone. 1 means "exactly what the palette said", and
    // §2.4 keeps that decision in the palette rather than here.
    out[F_TOP] = Math.max(num(p, 'topLevel', 1), 0);
  },
};

function num(p: Readonly<Record<string, ParamValue>>, key: string, fallback: number): number {
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function bool(p: Readonly<Record<string, ParamValue>>, key: string, fallback: boolean): boolean {
  const v = p[key];
  return typeof v === 'boolean' ? v : fallback;
}

function orientation(
  p: Readonly<Record<string, ParamValue>>,
  key: string,
  fallback: (typeof ORIENTATIONS)[number],
): (typeof ORIENTATIONS)[number] {
  const v = p[key];
  const found = ORIENTATIONS.find((m) => m === v);
  return found ?? fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
