// The Clifford attractor — plan §8.3, the iterated-map half of the family.
//
// LOOK: `ink` (art-direction §1.3). This is a DENSITY, not a set of strokes:
// tens of thousands of orbits each deposit one faint dot per frame and the
// accumulator integrates them into the map's invariant measure. What comes out
// is a soft-edged figure with a wide tonal range and no hard line anywhere in
// it — which is sumi-e, not neon. Put it under a feedback trail with a long tau
// and give it a warm-black background; a single frame of this source on its own
// is a faint dust of dots and looks like nothing at all.
//
// ---------------------------------------------------------------------------
// A MAP IS NOT A FLOW. This is the one thing to get right here.
//
// Lorenz, Rossler, Thomas and Halvorsen are continuous systems: a step is a
// small displacement along a smooth curve, so consecutive samples can be joined
// into a SEGMENT, and doing that is most of the visual quality in those sources.
//
// Clifford is `p[n+1] = f(p[n])` with no dt at all. Successive iterates land far
// apart and are essentially uncorrelated in position, so joining them draws
// chords straight across the figure and obliterates the structure. We plot
// POINTS. That difference is why this file exists separately rather than
// parameterising `rossler.ts`.
// ---------------------------------------------------------------------------
//
// The musical-time obligation lands differently too. A map has no step size to
// scale, so the rate that must be fixed per BEAT is the ITERATION rate, and the
// mechanism for that is an absolute iteration counter carried in the storage
// buffer — see the long note in `attractor-map-main.wgsl`.

import type {
  ParamValue,
  PassContext,
  PassDescriptor,
  StorageSpec,
} from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP, passBindingsWGSL } from '../renderer.ts';
import HASH_BODY from '../shaders/attractor-common.wgsl';
import MAP_BODY from '../shaders/attr-clifford.wgsl';
import COMPUTE_MAIN from '../shaders/attractor-map-main.wgsl';
import RENDER_BODY from '../shaders/attractor-map.wgsl';

// ---------------------------------------------------------------------------
// Uniform block — one block, both stages (`renderer.ts` writes it once per
// stage from the same descriptor, so there is exactly one layout per pass).
// ---------------------------------------------------------------------------

const UNIFORM_FLOATS = 14;

const U_ITER_TARGET = 0;
const U_MAX_STEPS = 1;
const U_PA = 2;
const U_PB = 3;
const U_PC = 4;
const U_PD = 5;
const U_COUNT = 6;
const U_RESEED = 7;
const U_SPIN = 8;
const U_SCALE = 9;
const U_HALF_WIDTH = 10;
const U_BRIGHT = 11;
const U_HUE_SHIFT = 12;
const U_HUE_SPREAD = 13;

const TAU = Math.PI * 2;

const PARAMS_WGSL = /* wgsl */`
struct Clifford {
  iterTarget : f32,   // absolute iterate index every orbit should have reached
  maxSteps   : f32,   // cap on catch-up per dispatch
  pa         : f32,   // a — canonical -1.4. Audio drives this one.
  pb         : f32,   // b — canonical  1.6
  pc         : f32,   // c — canonical  1.0
  pd         : f32,   // d — canonical  0.7
  count      : f32,   // orbits
  reseed     : f32,   // > 0.5 re-scatters every orbit
  spin       : f32,   // radians, in the picture plane
  scale      : f32,   // figure -> NDC fit
  halfWidth  : f32,   // half-width of a point sprite, NDC, before weight variation
  bright     : f32,   // per-frame contribution per point. Tiny; see below.
  hueShift   : f32,   // radians
  hueSpread  : f32,   // radians of hue walked across the figure's full width
};

@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> P : Clifford;
`;

const STORAGE_RW_WGSL =
  `@group(${PASS_GROUP}) @binding(${PASS_BINDING.storage0}) ` +
  `var<storage, read_write> points : array<f32>;`;

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/**
 * CANONICAL VALUES, stated because a wrong constant gives a blob rather than an
 * attractor: a = -1.4, b = 1.6, c = 1.0, d = 0.7 (Pickover). Those give the
 * familiar folded double lobe.
 *
 *   x' = sin(a*y) + c*cos(a*x)
 *   y' = sin(b*x) + d*cos(b*y)
 *
 * Bounded by construction — |x| <= 1 + |c|, |y| <= 1 + |d| for ANY parameters.
 * That guarantees numerical safety, not visual quality: some bounded `a`
 * intervals converge to tiny periodic rings. The default drive below therefore
 * stays inside a regression-tested chaotic corridor.
 */
export const CLIFFORD_DEFAULTS: Readonly<Record<string, ParamValue>> = {
  /**
   * Independent orbits. Higher than the flows: each orbit contributes ONE dot
   * per frame rather than a segment, so the count is the sample count of the
   * density estimate and the picture is grainy below ~50k. 96k orbits is a
   * 1.5 MB buffer and 576k vertices.
   */
  orbits: 96_000,
  /**
   * Iterates per BEAT. This is the musical rate — at 128 BPM and 165 fps it is
   * ~5.5 iterates per frame, so every orbit lands somewhere genuinely new each
   * frame and the density resamples continuously. Lower it and the cloud starts
   * to visibly hold still between beats; raise it and the resampling is faster
   * than the accumulator can integrate.
   */
  itersPerBeat: 900,
  /**
   * Cap on catch-up per dispatch. Bounds the work after a tab switch — see
   * `attractor-map-main.wgsl`.
   *
   * It must exceed the NORMAL per-frame figure at the LOWEST refresh rate the
   * show runs at, not at the highest. 900 iterates/beat at 128 BPM is 1920/s,
   * which is 11.6 per frame at 165 fps but 32 at 60 Hz and 64 at 30 Hz — and
   * below the cap the orbit silently resamples slower than the beat rate this
   * source's whole musical-time mechanism exists to guarantee. 96 covers 30 Hz
   * with margin and costs nothing on a frame that is not catching up.
   */
  maxSteps: 96,
  /** The one audio drives. */
  aBase: -1.4,
  /**
   * How far the HIGH band pushes a. `a` is the coefficient that refolds the
   * figure rather than stretching it, so this is a change of SHAPE (§3.3).
   *
   * High band deliberately: this is the detail/sparkle role in the layer-role
   * table, and the flows in this family are on sub, low and mid.
   *
   * Keep this together with `aPulse` inside the tested -1.40..-1.28 corridor.
   * The former 0.45 drive crossed narrow periodic windows around -1.05..-0.90,
   * collapsing 96k independent orbits into one-to-twelve point rings.
   */
  aHigh: 0.08,
  /** Envelope contribution; bounded with `aHigh` so full drive reaches -1.28. */
  aPulse: 0.04,
  b: 1.6,
  c: 1.0,
  d: 0.7,
  /**
   * Bars per revolution of the whole figure. Very slow — a rigid rotation, not
   * a centre-out pulse (art-direction §4.1 forbids the latter, not the former),
   * and at 64 bars it reads as drift rather than as spin.
   */
  spinBars: 64,
  /** Bars per full hue rotation. Slow: three hues maximum (§2.2). */
  hueBars: 56,
  /**
   * Per-frame contribution PER POINT, and it is tiny for two compounding
   * reasons: there are 96k of them, and with a trail of retention k the
   * accumulator settles at B/(1-k) — ~50x at a one-beat tau and 165 fps. Tuned
   * as though a frame stood alone this whites out in about a second.
   */
  brightBase: 0.035,
  brightLevel: 0.070,
  brightEnv: 0.050,
  /** Figure -> NDC fit. |x| <= 2 at the canonical c, so 2 * 0.42 = 0.84 NDC. */
  fit: 0.42,
  /** Half-width of a point sprite in NDC, before the per-orbit weight variation. */
  thickness: 0.0022,
  /**
   * Radians of hue walked across the FULL width of the figure (the shader
   * normalises by the |x| <= 2 bound). 0.55 rad is 31 degrees — one hue and its
   * neighbours, per art-direction §2.2, which forbids hue variety within a
   * frame while allowing the whole band to rotate over bars.
   */
  hueSpread: 0.55,
};

/**
 * Hard ceiling on the buffer. 524 288 orbits is 8 MB and 3.1 M vertices; a
 * preset arrives over a URL hash and `orbits: 1e9` is a plausible typo.
 */
const MAX_ORBITS = 524_288;

/** Bytes per orbit: 4 floats. Layout is in `attractor-map-main.wgsl`. */
const BYTES_PER_ORBIT = 4 * 4;

/**
 * Ceiling on the absolute iterate index.
 *
 * The counter lives in an f32 uniform and an f32 buffer slot, and f32 holds
 * integers exactly only below 2^24. Past that the target and the stored count
 * would round to the same value at different times and the orbits would advance
 * erratically. At the default 900 iterates/beat and 128 BPM this is reached
 * after ~2.4 hours of continuous playback, at which point the figure stops
 * animating but stays correct — a frozen picture rather than a corrupted one.
 */
const MAX_ITER_TARGET = 16_777_216;

/** Bounds on the driven coefficient. Past ~2.4 the sines alias into even noise. */
const A_LIMIT = 2.4;

function num(
  params: Readonly<Record<string, ParamValue>>,
  key: string,
  lo: number,
  hi: number,
): number {
  const fallback = CLIFFORD_DEFAULTS[key];
  const raw = params[key] ?? fallback;
  const v = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(v)) return typeof fallback === 'number' ? fallback : lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Orbit count, resolved identically everywhere it is asked for. `bytes`,
 * `workgroups` and `vertexCount` must agree exactly.
 */
function orbitCount(params: Readonly<Record<string, ParamValue>>): number {
  return Math.max(1, Math.floor(num(params, 'orbits', 1, MAX_ORBITS)));
}

/** Positive fractional part. `%` keeps the sign of the dividend and beats can be negative on a pre-roll. */
function fract(v: number): number {
  return v - Math.floor(v);
}

// ---------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------

/**
 * The orbit buffer.
 *
 * No `init`: the renderer zero-fills, the compute shader reads a zero seeded
 * flag as "scatter me", and the scatter is a pure function of the orbit index
 * evaluated on the GPU — identical on every run (§4.7) with no CPU seeding step.
 * The transient is burned in there too, so the uniform square the scatter starts
 * as is never drawn.
 */
const POINTS: StorageSpec = {
  label: 'points',
  bytes: (params) => orbitCount(params) * BYTES_PER_ORBIT,
};

const SHAPE = {
  type: 'clifford',
  family: 'source',
  input: 'none',
  uniformFloats: UNIFORM_FLOATS,
  storage: [POINTS],
} as const;

export const cliffordPass: PassDescriptor = {
  ...SHAPE,

  code: [
    PASS_COMMON_WGSL,
    PARAMS_WGSL,
    passBindingsWGSL({ ...SHAPE, code: '' }),
    RENDER_BODY,
  ].join('\n'),

  compute: {
    // Order is load-bearing: WGSL resolves module-scope names in declaration
    // order, so the hash precedes the seed that calls it and `mapStep` precedes
    // the main that iterates it.
    code: [
      PASS_COMMON_WGSL,
      PARAMS_WGSL,
      STORAGE_RW_WGSL,
      HASH_BODY,
      MAP_BODY,
      COMPUTE_MAIN,
    ].join('\n'),
    entryPoint: 'main',
    workgroups: (ctx) => orbitCount(ctx.params) / 64,
  },

  draw: {
    kind: 'vertices',
    // Six vertices per point sprite, and ZERO at progress 0 — a spent layer is
    // a true no-op (Phase 5 DoD), not a draw that happens to be transparent.
    vertexCount: (ctx) => (ctx.progress > 0 ? 6 * orbitCount(ctx.params) : 0),
  },

  /**
   * Full resolution. The sprites are ~2e-3 NDC — a couple of pixels at 1440p —
   * and a half-res pass would land two orbits in one texel and destroy the
   * density gradient this source is entirely made of. Advisory only (§4.11).
   */
  defaultResolutionScale: 1,

  writeUniforms(out: Float32Array, ctx: PassContext): void {
    const p = ctx.params;

    // The musical rate, as an ABSOLUTE target rather than a per-frame count.
    // Per-frame fails outright: at 900 iterates/beat and 165 fps the per-frame
    // figure is 5.5, and any scheme that floors a per-frame count loses the
    // fraction — at a high refresh rate it can floor to zero and the map never
    // advances at all.
    const rate = num(p, 'itersPerBeat', 0, 100_000);
    const target = Math.floor(Math.max(0, ctx.beats) * rate);
    out[U_ITER_TARGET] = Math.min(target, MAX_ITER_TARGET);
    out[U_MAX_STEPS] = Math.max(1, Math.floor(num(p, 'maxSteps', 1, 4096)));

    // Audio drives a coefficient, not the brightness. `a` refolds the lobes;
    // clamped as a SUM because the individual terms are independently sane and
    // it is their total the map sees.
    const a = num(p, 'aBase', -A_LIMIT, A_LIMIT)
      + ctx.audio.bands.high * num(p, 'aHigh', -A_LIMIT, A_LIMIT)
      + ctx.progress * num(p, 'aPulse', -A_LIMIT, A_LIMIT);
    out[U_PA] = Math.min(Math.max(a, -A_LIMIT), A_LIMIT);
    out[U_PB] = num(p, 'b', -A_LIMIT, A_LIMIT);
    out[U_PC] = num(p, 'c', -2, 2);
    out[U_PD] = num(p, 'd', -2, 2);

    out[U_COUNT] = orbitCount(p);
    // Never set from a param. A reseed is a transport event (§4.10).
    out[U_RESEED] = 0;

    // Bars, not beats, and absolute rather than integrated — an integrated
    // angle is a function of frame history and fails §4.7. The fractional part
    // is taken BEFORE scaling so f32 never loses the low bits of a slow drift.
    out[U_SPIN] = fract(ctx.bars / Math.max(num(p, 'spinBars', 1e-3, 4096), 1e-3)) * TAU;
    out[U_HUE_SHIFT] = fract(ctx.bars / Math.max(num(p, 'hueBars', 1e-3, 4096), 1e-3)) * TAU;

    // Portrait canvases are the tight case, so fit against the smaller axis.
    out[U_SCALE] = num(p, 'fit', 0, 4) * Math.min(1, ctx.aspect * 1.15);
    out[U_HALF_WIDTH] = num(p, 'thickness', 1e-5, 0.1);

    // NOT multiplied by ctx.opacity — `C.opacity` is applied in the fragment
    // shader and doing both would square it.
    out[U_BRIGHT] = num(p, 'brightBase', 0, 1)
      + ctx.audio.level * num(p, 'brightLevel', 0, 1)
      + ctx.progress * num(p, 'brightEnv', 0, 1);

    out[U_HUE_SPREAD] = num(p, 'hueSpread', 0, 6.283);
  },
};
