// The Rossler attractor — plan §8.3, the strange-attractor family.
//
// LOOK: `lab` (art-direction §1.1), and it is the member of the family that
// belongs there. Rossler at its canonical parameters is a single scroll — one
// band of trajectories folding once — so it draws as ONE LINE, which is the
// whole discipline of that look. Lorenz has two lobes and a chord between them;
// Halvorsen has three; Rossler has one, and a single clean ribbon on near-black
// is a vectorscope photograph. It is a legitimate `rave` source too, but if it
// is used there it should be the only attractor on screen (§4.2).
//
// STRUCTURE: this is `lorenz.ts` with the shape-specific parts moved out to
// shaders. The compute prepass advances M independent trajectories in a storage
// buffer — parallel ACROSS trajectories, serial ALONG each, because
// p[n+1] = f(p[n]) cannot be split — and the draw reads that buffer from the
// vertex stage and emits a quad per segment. Segments, not dots: N gaussian
// dots average into fog, N short segments resolve into filaments.
//
// The three continuous members (this, Thomas, Halvorsen) share
// `attractor-flow-main.wgsl` and `attractor-flow.wgsl` and therefore share one
// uniform LAYOUT. Each still declares its own descriptor, its own struct and its
// own parameter table, because the coefficients mean different things and a
// shared defaults table is how `c = 5.7` ends up in a system that wanted 1.4.

import type {
  ParamValue,
  PassContext,
  PassDescriptor,
  StorageSpec,
} from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP, passBindingsWGSL } from '../renderer.ts';
import HASH_BODY from '../shaders/attractor-common.wgsl';
import FIELD_BODY from '../shaders/attr-rossler.wgsl';
import COMPUTE_MAIN from '../shaders/attractor-flow-main.wgsl';
import RENDER_BODY from '../shaders/attractor-flow.wgsl';

// ---------------------------------------------------------------------------
// Uniform block
// ---------------------------------------------------------------------------

/**
 * f32 count of `struct Rossler`. ONE block serves BOTH stages, because
 * `renderer.ts` calls `writeUniforms` once per stage with the same descriptor —
 * there is exactly one uniform layout per pass. The compute stage reads the
 * first seven fields and the render stage the last ten; each ignores the
 * other's, which costs nothing and removes the possibility of the two
 * disagreeing about `count`.
 */
const UNIFORM_FLOATS = 17;

// Offsets in FLOATS. Named, because a bare index is how `pb` and `pc` quietly
// swap places and the result is still a plausible-looking attractor.
const U_DT = 0;
const U_STEPS = 1;
const U_PA = 2;
const U_PB = 3;
const U_PC = 4;
const U_COUNT = 5;
const U_RESEED = 6;
const U_SPIN = 7;
const U_SCALE = 8;
const U_HALF_WIDTH = 9;
const U_BRIGHT = 10;
const U_HUE_SHIFT = 11;
const U_CENTRE_X = 12;
const U_CENTRE_Y = 13;
const U_CENTRE_Z = 14;
const U_DEPTH_K = 15;
const U_HUE_SPREAD = 16;

const TAU = Math.PI * 2;

/**
 * The struct, declared here rather than in either `.wgsl` file because both
 * stages must see the SAME field order. Two copies in two files is two things to
 * edit and one of them will be missed, and the failure mode is a compute pass
 * integrating with the render pass's line width.
 */
const PARAMS_WGSL = /* wgsl */`
struct Rossler {
  dt        : f32,   // simulation time per SUBSTEP. Derived from dtBeats on the CPU.
  steps     : f32,   // substeps per dispatch
  pa        : f32,   // a — canonical 0.2
  pb        : f32,   // b — canonical 0.2
  pc        : f32,   // c — canonical 5.7. The bifurcation parameter; audio drives it.
  count     : f32,   // trajectories
  reseed    : f32,   // > 0.5 scatters every trajectory again
  spin      : f32,   // radians about the vertical
  scale     : f32,   // world -> NDC fit
  halfWidth : f32,   // half-width of a segment, NDC, before the weight variation
  bright    : f32,   // per-frame contribution. Tiny; see below.
  hueShift  : f32,   // radians
  centreX   : f32,   // world point the projection centres on
  centreY   : f32,
  centreZ   : f32,
  depthK    : f32,   // perspective strength
  hueSpread : f32,   // radians of hue walked across the depth range
};

@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> P : Rossler;
`;

/**
 * The compute stage's view of the storage buffer.
 *
 * `passBindingsWGSL` generates the RENDER stage's declaration (`read`); there is
 * deliberately no generator for the compute one, because the renderer's compute
 * layout declares it writable and this is the only place that fact is written
 * down in WGSL. The binding number still comes from `PASS_BINDING`.
 */
const STORAGE_RW_WGSL =
  `@group(${PASS_GROUP}) @binding(${PASS_BINDING.storage0}) ` +
  `var<storage, read_write> points : array<f32>;`;

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/**
 * Defaults, and the authoritative list of what this source understands.
 *
 * CANONICAL VALUES, stated because a wrong constant here gives a blob rather
 * than an attractor: a = 0.2, b = 0.2, c = 5.7 (Rossler, 1976). The
 * period-doubling cascade in `c` runs 2.5 (one loop) -> 3.5 -> 4.0 -> 4.23
 * (chaos) -> 5.7 (canonical) -> 12+ (a wide flat band).
 */
export const ROSSLER_DEFAULTS: Readonly<Record<string, ParamValue>> = {
  /** Independent trajectories. 24k segments is ~144k vertices and a 768 KB buffer. */
  trajectories: 24_000,
  /** Euler substeps per dispatch. More substeps buy a smoother curve, not a faster one. */
  substeps: 6,
  /**
   * Simulation time advanced per BEAT. Rossler's orbital period is ~6 time
   * units at the canonical parameters, so 1.5 is a quarter turn of the scroll
   * per beat — fast enough to read as travel, slow enough that a frame's
   * segment is short.
   */
  simPerBeat: 1.5,
  a: 0.2,
  b: 0.2,
  /** The bifurcation parameter. */
  cBase: 5.7,
  /**
   * How far the MID band pushes c. Mid rather than low deliberately — the low
   * band is Lorenz's driver, and art-direction §3.3 says two layers on the same
   * driver breathe together and read as one pulsing blob.
   *
   * 5.7 + 4.5 = 10.2 at a full mid band: the scroll opens from a ribbon into a
   * broad chaotic sheet. That is a change of SHAPE, which is what a driver is
   * for.
   */
  cMid: 4.5,
  /** How far the layer's envelope pushes c. */
  cPulse: 2.0,
  /** Bars per full revolution. Bars, not seconds — the spin phrases with the music. */
  spinBars: 24,
  /** Bars per full hue rotation. Slow: three hues maximum (art-direction §2.2). */
  hueBars: 64,
  /**
   * Per-frame brightness floor. TINY on purpose: with a trail of retention k the
   * accumulator settles at B/(1-k), which at a one-beat tau and 165 fps is ~50x.
   * Tuning this as though each frame stood alone is what blows the frame out to
   * white in about a second.
   */
  brightBase: 0.060,
  /** Added per unit of broadband level. */
  brightLevel: 0.120,
  /** Added per unit of envelope. */
  brightEnv: 0.080,
  /**
   * World -> NDC fit. The attractor spans x in [-10,12] and y in [-11,8] at
   * c = 5.7, so ~11 units from the centre below; 11 * 0.042 * 1.52 (the near
   * end of the perspective — `depth = 1/(1 + z*k)` is not symmetric about 1, so
   * the near gain is larger than the far loss) lands around 0.70 NDC, which
   * leaves headroom for the figure growing as audio pushes c up.
   */
  fit: 0.042,
  /** Half-width of a segment in NDC, before the depth/speed variation in the shader. */
  thickness: 0.0016,
  /** Centre of the figure at c = 5.7. z is offset because the z spike is one-sided. */
  centreX: 1.0,
  centreY: -1.5,
  centreZ: 6.0,
  /** Perspective strength. The rotated depth range is ~+/-19, so 0.018 gives roughly 0.7x..1.5x. */
  depthK: 0.018,
  /** Radians of hue walked across that depth range. Narrow — one hue and its neighbours. */
  hueSpread: 0.9,
};

/**
 * Hard ceiling on the buffer. 262 144 trajectories is 8 MB and 1.6 M vertices.
 * A preset arrives over a URL hash and `trajectories: 1e9` is a plausible typo;
 * it must cost the layer its intent, not the page its memory.
 */
const MAX_TRAJECTORIES = 262_144;

/** Bytes per trajectory: 8 floats. Layout is in `attractor-flow-main.wgsl`. */
const BYTES_PER_TRAJECTORY = 8 * 4;

/**
 * Largest step the integration is allowed to see, in beats.
 *
 * A tab switch or a shader compile produces one enormous `dt`, and Euler steps
 * of a huge `dt` throw every trajectory past the divergence guard at once — the
 * whole attractor reseeds and the frame flashes. Clamping loses a little travel
 * after a stall, which is invisible.
 */
const MAX_DT_BEATS = 0.5;

function num(
  params: Readonly<Record<string, ParamValue>>,
  key: string,
  lo: number,
  hi: number,
): number {
  const fallback = ROSSLER_DEFAULTS[key];
  const raw = params[key] ?? fallback;
  const v = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(v)) return typeof fallback === 'number' ? fallback : lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Trajectory count, resolved identically everywhere it is asked for.
 *
 * `bytes`, `workgroups` and `vertexCount` must agree exactly: a vertex count
 * larger than the buffer reads past the end, and a dispatch larger than the
 * buffer is a validation error. One function, three callers.
 */
function trajectoryCount(params: Readonly<Record<string, ParamValue>>): number {
  return Math.max(1, Math.floor(num(params, 'trajectories', 1, MAX_TRAJECTORIES)));
}

/** Positive fractional part. `%` keeps the sign of the dividend, and beats can be negative on a pre-roll. */
function fract(v: number): number {
  return v - Math.floor(v);
}

// ---------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------

/**
 * The trajectory buffer.
 *
 * No `init`. The renderer zero-fills a freshly allocated buffer and the compute
 * shader treats a zero seeded-flag as "scatter me", so the initial positions are
 * a pure function of the trajectory index computed on the GPU — identical on
 * every run (§4.7) with no CPU seeding step and no `hash11` ported to
 * TypeScript that would then have to stay bit-identical forever.
 */
const POINTS: StorageSpec = {
  label: 'points',
  bytes: (params) => trajectoryCount(params) * BYTES_PER_TRAJECTORY,
};

/**
 * The shape fields, declared once. `passBindingsWGSL` needs a descriptor to
 * generate the storage declaration and the descriptor needs that declaration to
 * have its `code`; writing the shape twice compiles perfectly and generates a
 * binding set that does not match the layout `renderer.ts` builds.
 *
 * `input: 'none'` is explicit even though `source` defaults to it: a source
 * draws INTO the accumulator and so may not sample it.
 */
const SHAPE = {
  type: 'rossler',
  family: 'source',
  input: 'none',
  uniformFloats: UNIFORM_FLOATS,
  storage: [POINTS],
} as const;

export const rosslerPass: PassDescriptor = {
  ...SHAPE,

  code: [
    PASS_COMMON_WGSL,
    PARAMS_WGSL,
    passBindingsWGSL({ ...SHAPE, code: '' }),
    RENDER_BODY,
  ].join('\n'),

  compute: {
    // Order is load-bearing: WGSL resolves module-scope names in declaration
    // order, so the hash comes before the seed that calls it and the field comes
    // before the main that integrates it.
    code: [
      PASS_COMMON_WGSL,
      PARAMS_WGSL,
      STORAGE_RW_WGSL,
      HASH_BODY,
      FIELD_BODY,
      COMPUTE_MAIN,
    ].join('\n'),
    entryPoint: 'main',
    // `@workgroup_size(64)` in the shader. `Math.ceil` is applied by the
    // renderer, so a count that is not a multiple of 64 dispatches one partial
    // group and the shader's `i >= P.count` guard retires the excess threads.
    workgroups: (ctx) => trajectoryCount(ctx.params) / 64,
  },

  draw: {
    kind: 'vertices',
    // Six vertices per segment quad, and ZERO at progress 0 — a spent layer is a
    // true no-op (Phase 5 DoD), not a draw that happens to be transparent.
    vertexCount: (ctx) => (ctx.progress > 0 ? 6 * trajectoryCount(ctx.params) : 0),
  },

  /**
   * Full resolution. The segments are ~1.6e-3 NDC half-width — thinner than two
   * pixels at 1440p — and their antialiasing is defined in attachment pixels, so
   * a half-res pass is a half-res line smeared bilinearly back up. Advisory
   * only; §4.11 says the scale is a budget decision.
   */
  defaultResolutionScale: 1,

  writeUniforms(out: Float32Array, ctx: PassContext): void {
    const p = ctx.params;

    const count = trajectoryCount(p);
    const substeps = Math.max(1, Math.floor(num(p, 'substeps', 1, 64)));

    // Integration rate per BEAT, not per frame. A fixed step per frame is both
    // frame-rate dependent and musically meaningless.
    const dtRaw = Number.isFinite(ctx.dtBeats) ? ctx.dtBeats : 0;
    const dtBeats = dtRaw <= 0 ? 0 : Math.min(dtRaw, MAX_DT_BEATS);
    out[U_DT] = (num(p, 'simPerBeat', 0, 64) * dtBeats) / substeps;
    out[U_STEPS] = substeps;

    out[U_PA] = num(p, 'a', -4, 4);
    out[U_PB] = num(p, 'b', -4, 4);

    // Audio drives the system's PARAMETER, not just its brightness. `c` is the
    // bifurcation parameter, so pushing it walks the period-doubling cascade and
    // the figure genuinely changes shape (art-direction §3.3).
    //
    // Clamped as a SUM rather than per term: the terms are independently sane
    // and their total is what the integrator sees, and below ~2 the attractor
    // collapses to a point while above ~24 the Euler step is no longer stable at
    // this `dt`.
    const c = num(p, 'cBase', 0, 32)
      + ctx.audio.bands.mid * num(p, 'cMid', -32, 32)
      + ctx.progress * num(p, 'cPulse', -32, 32);
    out[U_PC] = Math.min(Math.max(c, 2.0), 24.0);

    out[U_COUNT] = count;
    // Never set from a param. A reseed is a transport event (§4.10) and belongs
    // to whatever handles seek and track change, not to a preset value that
    // would re-scatter the attractor on every dispatch.
    out[U_RESEED] = 0;

    // Bars, not beats, for the two rates a viewer reads as travel rather than as
    // pulse. Absolute rather than integrated — an integrated angle is a function
    // of frame history and fails §4.7 — and the fractional part is taken BEFORE
    // scaling so the angle never grows large enough for f32 to lose the low bits
    // of a slow spin.
    out[U_SPIN] = fract(ctx.bars / Math.max(num(p, 'spinBars', 1e-3, 4096), 1e-3)) * TAU;
    out[U_HUE_SHIFT] = fract(ctx.bars / Math.max(num(p, 'hueBars', 1e-3, 4096), 1e-3)) * TAU;

    // Portrait canvases are the tight case, so fit against the smaller axis.
    out[U_SCALE] = num(p, 'fit', 0, 1) * Math.min(1, ctx.aspect * 1.15);
    out[U_HALF_WIDTH] = num(p, 'thickness', 0, 0.1);

    // NOT multiplied by ctx.opacity — `C.opacity` is applied in the fragment
    // shader, and doing both would square it.
    out[U_BRIGHT] = num(p, 'brightBase', 0, 1)
      + ctx.audio.level * num(p, 'brightLevel', 0, 1)
      + ctx.progress * num(p, 'brightEnv', 0, 1);

    out[U_CENTRE_X] = num(p, 'centreX', -256, 256);
    out[U_CENTRE_Y] = num(p, 'centreY', -256, 256);
    out[U_CENTRE_Z] = num(p, 'centreZ', -256, 256);
    out[U_DEPTH_K] = num(p, 'depthK', 1e-4, 1);
    out[U_HUE_SPREAD] = num(p, 'hueSpread', 0, 6.283);
  },
};
