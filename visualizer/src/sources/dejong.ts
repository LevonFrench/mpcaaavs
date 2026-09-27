// The Peter de Jong attractor — plan §8.3, the iterated-map half of the family.
//
// LOOK: `rave` (art-direction §1.4). Where Clifford is a soft two-lobed wash,
// De Jong at its canonical parameters is a four-armed web with hard caustic
// edges where the density piles up, and those edges take saturated additive
// colour without turning to mud. It is the one member of the family that reads
// as GRAPHIC rather than as smoke.
//
// ---------------------------------------------------------------------------
// A MAP IS NOT A FLOW — the same warning as `clifford.ts`, for the same reason.
// `p[n+1] = f(p[n])` with no dt: successive iterates land far apart, so drawing
// segments between them paints chords across the figure. POINTS only, and the
// image is built by density through the accumulator.
// ---------------------------------------------------------------------------
//
// Musical time therefore lands on the ITERATION rate rather than a step size,
// carried as an absolute counter in the storage buffer — see the long note in
// `attractor-map-main.wgsl`.

import type {
  ParamValue,
  PassContext,
  PassDescriptor,
  StorageSpec,
} from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP, passBindingsWGSL } from '../renderer.ts';
import HASH_BODY from '../shaders/attractor-common.wgsl';
import MAP_BODY from '../shaders/attr-dejong.wgsl';
import COMPUTE_MAIN from '../shaders/attractor-map-main.wgsl';
import RENDER_BODY from '../shaders/attractor-map.wgsl';

// ---------------------------------------------------------------------------
// Uniform block — one block, both stages. See `clifford.ts` for the argument.
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
struct DeJong {
  iterTarget : f32,   // absolute iterate index every orbit should have reached
  maxSteps   : f32,   // cap on catch-up per dispatch
  pa         : f32,   // a — canonical  1.4
  pb         : f32,   // b — canonical -2.3
  pc         : f32,   // c — canonical  2.4. Audio drives this one.
  pd         : f32,   // d — canonical -2.1
  count      : f32,   // orbits
  reseed     : f32,   // > 0.5 re-scatters every orbit
  spin       : f32,   // radians, in the picture plane
  scale      : f32,   // figure -> NDC fit
  halfWidth  : f32,   // half-width of a point sprite, NDC, before weight variation
  bright     : f32,   // per-frame contribution per point. Tiny; see below.
  hueShift   : f32,   // radians
  hueSpread  : f32,   // radians of hue walked across the figure's full width
};

@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> P : DeJong;
`;

const STORAGE_RW_WGSL =
  `@group(${PASS_GROUP}) @binding(${PASS_BINDING.storage0}) ` +
  `var<storage, read_write> points : array<f32>;`;

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/**
 * CANONICAL VALUES, stated because a wrong constant gives a blob rather than an
 * attractor: a = 1.4, b = -2.3, c = 2.4, d = -2.1. That is the widely
 * reproduced set and the one that gives the four-armed web.
 *
 *   x' = sin(a*y) - cos(b*x)
 *   y' = sin(c*x) - cos(d*y)
 *
 * Bounded by construction at |x|, |y| <= 2 for any coefficients, so a
 * coefficient can be swept hard from audio with no risk of escape.
 */
export const DEJONG_DEFAULTS: Readonly<Record<string, ParamValue>> = {
  /**
   * Independent orbits. Each contributes ONE dot per frame — the count is the
   * sample count of the density estimate, and the web's thin filaments are the
   * first thing to disappear when it is too low.
   */
  orbits: 96_000,
  /**
   * Iterates per BEAT — the musical rate. Slower than Clifford's on purpose:
   * De Jong's filaments are narrow, and resampling them too fast reads as noise
   * rather than as structure. At 128 BPM and 165 fps this is ~4.4 per frame.
   */
  itersPerBeat: 720,
  /**
   * Cap on catch-up per dispatch. It must exceed the normal per-frame figure at
   * the LOWEST refresh rate, not the highest: 720/beat at 128 BPM is 4.4 per
   * frame at 165 fps but 26 at 60 Hz and 51 at 30 Hz, and below the cap the
   * orbit resamples slower than the beat rate rather than catching up.
   */
  maxSteps: 96,
  a: 1.4,
  b: -2.3,
  /** The one audio drives. */
  cBase: 2.4,
  /**
   * How far the MID band pushes c. All four coefficients are structural in this
   * map, but `a` and `b` set the overall armature while `c` rearranges the
   * filaments inside it — which reads as the figure MOVING rather than as the
   * figure being replaced. That is the change worth handing to audio (§3.3).
   *
   * Mid band: Clifford is on high, and the three flows are on sub, low and mid
   * — this shares mid with Rossler, so the two should not be stacked in one
   * preset (art-direction §3.3).
   */
  cMid: 0.7,
  /** How far the layer's envelope pushes c. */
  cPulse: 0.4,
  d: -2.1,
  /** Bars per revolution. A rigid, very slow rotation — drift, not spin. */
  spinBars: 80,
  /** Bars per full hue rotation. Faster than Clifford's; `rave` may move. */
  hueBars: 40,
  /**
   * Per-frame contribution PER POINT. Tiny for two compounding reasons: 96k
   * points, and an accumulator whose steady state is B/(1-k) — ~50x at a
   * one-beat tau and 165 fps.
   */
  brightBase: 0.035,
  brightLevel: 0.070,
  brightEnv: 0.050,
  /** Figure -> NDC fit. |x| <= 2 always, so 2 * 0.42 = 0.84 NDC. */
  fit: 0.42,
  /** Half-width of a point sprite in NDC, before the per-orbit weight variation. */
  thickness: 0.0020,
  /**
   * Radians of hue walked across the FULL width of the figure — the shader
   * normalises by the |x| <= 2 bound. 0.6 rad is 34 degrees: one hue and its
   * neighbours (§2.2), a little wider than Clifford's because `rave` may move.
   */
  hueSpread: 0.6,
};

const MAX_ORBITS = 524_288;

/** Bytes per orbit: 4 floats. Layout is in `attractor-map-main.wgsl`. */
const BYTES_PER_ORBIT = 4 * 4;

/**
 * Ceiling on the absolute iterate index — f32 holds integers exactly only below
 * 2^24, and past that the target and the stored count round unpredictably
 * against each other. At 720 iterates/beat and 128 BPM this is ~3 hours of
 * continuous playback, after which the figure freezes rather than corrupting.
 */
const MAX_ITER_TARGET = 16_777_216;

/**
 * Bounds on the coefficients. Past about 3 the two sines alias against each
 * other and the figure degenerates into even noise — bounded noise, but noise.
 */
const COEF_LIMIT = 3.0;

function num(
  params: Readonly<Record<string, ParamValue>>,
  key: string,
  lo: number,
  hi: number,
): number {
  const fallback = DEJONG_DEFAULTS[key];
  const raw = params[key] ?? fallback;
  const v = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(v)) return typeof fallback === 'number' ? fallback : lo;
  return v < lo ? lo : v > hi ? hi : v;
}

function orbitCount(params: Readonly<Record<string, ParamValue>>): number {
  return Math.max(1, Math.floor(num(params, 'orbits', 1, MAX_ORBITS)));
}

function fract(v: number): number {
  return v - Math.floor(v);
}

// ---------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------

/**
 * The orbit buffer. No `init` — the scatter is a pure function of the orbit
 * index evaluated on the GPU from a zero-filled buffer (§4.7), and the
 * transient is burned in there so the uniform square it starts as is never
 * drawn.
 */
const POINTS: StorageSpec = {
  label: 'points',
  bytes: (params) => orbitCount(params) * BYTES_PER_ORBIT,
};

const SHAPE = {
  type: 'dejong',
  family: 'source',
  input: 'none',
  uniformFloats: UNIFORM_FLOATS,
  storage: [POINTS],
} as const;

export const dejongPass: PassDescriptor = {
  ...SHAPE,

  code: [
    PASS_COMMON_WGSL,
    PARAMS_WGSL,
    passBindingsWGSL({ ...SHAPE, code: '' }),
    RENDER_BODY,
  ].join('\n'),

  compute: {
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
    // Six vertices per point sprite, ZERO at progress 0 — a true no-op.
    vertexCount: (ctx) => (ctx.progress > 0 ? 6 * orbitCount(ctx.params) : 0),
  },

  /** Full resolution: half-res would land two orbits in one texel and flatten the density. */
  defaultResolutionScale: 1,

  writeUniforms(out: Float32Array, ctx: PassContext): void {
    const p = ctx.params;

    // ABSOLUTE iterate target. A per-frame count would lose the fraction and,
    // at a high refresh rate, floor to zero and never advance.
    const rate = num(p, 'itersPerBeat', 0, 100_000);
    const target = Math.floor(Math.max(0, ctx.beats) * rate);
    out[U_ITER_TARGET] = Math.min(target, MAX_ITER_TARGET);
    out[U_MAX_STEPS] = Math.max(1, Math.floor(num(p, 'maxSteps', 1, 4096)));

    out[U_PA] = num(p, 'a', -COEF_LIMIT, COEF_LIMIT);
    out[U_PB] = num(p, 'b', -COEF_LIMIT, COEF_LIMIT);

    // Audio drives a coefficient, not the brightness — the filaments rearrange.
    // Clamped as a SUM: the terms are independently sane, their total is what
    // the map sees.
    const c = num(p, 'cBase', -COEF_LIMIT, COEF_LIMIT)
      + ctx.audio.bands.mid * num(p, 'cMid', -COEF_LIMIT, COEF_LIMIT)
      + ctx.progress * num(p, 'cPulse', -COEF_LIMIT, COEF_LIMIT);
    out[U_PC] = Math.min(Math.max(c, -COEF_LIMIT), COEF_LIMIT);
    out[U_PD] = num(p, 'd', -COEF_LIMIT, COEF_LIMIT);

    out[U_COUNT] = orbitCount(p);
    out[U_RESEED] = 0;

    out[U_SPIN] = fract(ctx.bars / Math.max(num(p, 'spinBars', 1e-3, 4096), 1e-3)) * TAU;
    out[U_HUE_SHIFT] = fract(ctx.bars / Math.max(num(p, 'hueBars', 1e-3, 4096), 1e-3)) * TAU;

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
