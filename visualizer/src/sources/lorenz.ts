// The Lorenz attractor source — registration for `shaders/lorenz.wgsl` (the
// compute prepass) and `shaders/points.wgsl` (the draw).
//
// This is the one pass in the project that uses BOTH halves of the descriptor
// contract at once, and it is the reason `ComputeSpec` and `StorageSpec` exist:
//
//   - `storage` is a persistent buffer of 24k trajectories. A trajectory is
//     p[n+1] = f(p[n]) and cannot be recomputed from scratch each frame, so the
//     state has to live somewhere that survives (§4.5). The renderer allocates
//     one per LAYER, so two `lorenz` layers are two independent systems sharing
//     one pipeline.
//   - `compute` advances every trajectory before any render pass in the frame,
//     writing that buffer as `read_write`. The vertex stage then reads the same
//     buffer as `read` — an asymmetry that is not a style choice: a writable
//     storage binding is not visible to a vertex stage, and the vertex stage is
//     precisely what draws this.
//
// What this module deliberately does NOT do:
//   - No GPUDevice, no buffer, no pipeline. It is data plus pure functions, so
//     the preset validator and the golden harness can import it on a machine
//     with no adapter (contracts.ts, file header).
//   - No wall clock and no `Math.random`. Every rate below is per BEAT or per
//     BAR and derives from `ctx.dtBeats` / `ctx.beats`, which are the audio
//     clock (§4.6). The trajectory scatter is a pure function of the trajectory
//     index, evaluated in the compute shader (see `seedPoint`), so it is
//     identical on every run without a CPU seeding step.
//   - No binding numbers. Every one comes from `PASS_BINDING`.
//
// ---------------------------------------------------------------------------
// Ported from the hard-coded chain in `main.ts`, and what changed on the way
// ---------------------------------------------------------------------------
//
// The integration, the projection, the segment geometry, the divergence guard
// and the seeded scatter are byte-for-byte the same arithmetic. Three things
// could not survive the move verbatim, and all three are STATE the old chain
// kept in a module-level `state` object:
//
// 1. `state.spin` and `state.hue` were INTEGRATED (`spin += dBars * TAU / n`).
//    An integrated angle is a function of the frame history, so two runs over
//    the same audio with different frame pacing end at different angles — which
//    fails §4.7 outright. They are absolute here: `fract(bars / barsPerTurn)`.
//    Same rate, same look, and reproducible. The only observable difference is
//    after a tempo CHANGE, where the absolute form re-derives the angle from
//    the current tempo instead of carrying the integral forward.
//
// 2. `state.pulse` was a second, parallel envelope: the scheduler set it to 1
//    on every beat and it decayed at exp(-dt * 4.5). The layer's OWN envelope
//    (`ctx.progress`) is fed by the same scheduler through the same beat
//    trigger, so the two were the same signal computed twice. The pulse term
//    and the envelope term are therefore folded into one `ctx.progress` term
//    here — `brightEnv` is the sum of the old pulse and env coefficients, and
//    `rhoPulse` is unchanged. A layer whose envelope has not been triggered
//    (tempo not locked yet) resolves to nothing and never reaches a pass at
//    all, which the old chain hid behind its non-zero brightness floor.
//
// 3. `aspect` is `C.aspect` now rather than a param, because the renderer knows
//    the attachment size and a param copy of it disagrees the moment a
//    resolution scale is applied.
// ---------------------------------------------------------------------------

import type {
  ParamValue,
  PassContext,
  PassDescriptor,
  StorageSpec,
} from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP, passBindingsWGSL } from '../renderer.ts';
import COMPUTE_BODY from '../shaders/lorenz.wgsl';
import RENDER_BODY from '../shaders/points.wgsl';

// ---------------------------------------------------------------------------
// Uniform block
// ---------------------------------------------------------------------------

/**
 * f32 count of `struct Lorenz`. One block serves BOTH stages.
 *
 * That is not an economy, it is forced: `renderer.ts` calls `writeUniforms` once
 * per stage with the same descriptor, so there is exactly one uniform layout for
 * a pass. The compute stage reads the first seven fields and the render stage
 * the last five; each ignores the other's, which costs nothing and removes the
 * possibility of the two disagreeing about `count`.
 */
const UNIFORM_FLOATS = 12;

// Offsets in FLOATS. Named for the same reason `renderer.ts` names its own: a
// bare index is how `rho` and `sigma` quietly swap places and the result is
// still a plausible-looking attractor.
const U_DT = 0;
const U_STEPS = 1;
const U_RHO = 2;
const U_SIGMA = 3;
const U_BETA = 4;
const U_COUNT = 5;
const U_RESEED = 6;
const U_SPIN = 7;
const U_SCALE = 8;
const U_HALF_WIDTH = 9;
const U_BRIGHT = 10;
const U_HUE_SHIFT = 11;

const TAU = Math.PI * 2;

/**
 * The struct, declared once and prepended to both shaders.
 *
 * In TypeScript rather than in either `.wgsl` file because both stages must see
 * the SAME field order — two copies in two files is two things to edit and one
 * of them will be missed, and the failure mode is a compute pass integrating
 * with the render pass's line width.
 */
const PARAMS_WGSL = /* wgsl */`
struct Lorenz {
  dt        : f32,   // Lorenz time per SUBSTEP. Derived from dtBeats on the CPU.
  steps     : f32,   // substeps per dispatch
  rho       : f32,   // bifurcation parameter — audio drives this
  sigma     : f32,
  beta      : f32,
  count     : f32,   // trajectories
  reseed    : f32,   // > 0.5 scatters every trajectory again
  spin      : f32,   // radians about the vertical
  scale     : f32,   // world -> NDC fit
  halfWidth : f32,   // half-width of a segment, NDC
  bright    : f32,   // per-frame contribution. Tiny; see below.
  hueShift  : f32,   // radians
};

@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> P : Lorenz;
`;

/**
 * The compute stage's view of the storage buffer.
 *
 * `passBindingsWGSL` generates the RENDER stage's declaration (`read`) and there
 * is deliberately no generator for the compute one — the renderer's compute
 * layout declares it `storage` (writable) and this is the only place that fact
 * is written down in WGSL. The binding number still comes from `PASS_BINDING`,
 * so it cannot drift out of step with the layout.
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
 * The values are the ones the verified vertical slice ran with, so a layer that
 * sets none of them renders exactly what `main.ts` rendered.
 */
export const LORENZ_DEFAULTS: Readonly<Record<string, ParamValue>> = {
  /** Independent trajectories. 24k segments is ~144k vertices — trivial for the GPU, and the buffer is 768 KB. */
  trajectories: 24_000,
  /** Euler substeps per dispatch. More substeps buy a smoother curve, not a faster one. */
  substeps: 6,
  /** Lorenz time units advanced per BEAT. The whole reason the ribbons travel with the music. */
  simPerBeat: 0.85,
  /** Classic Lorenz constants. `rho` is the one audio moves. */
  sigma: 10,
  beta: 8 / 3,
  rhoBase: 28,
  /** How far the low band pushes rho. Pushing rho changes the attractor's SHAPE, not just its brightness. */
  rhoLow: 14,
  /** How far the layer's envelope pushes rho. */
  rhoPulse: 6,
  /** Bars per full revolution. Bars, not seconds — the spin phrases with the music. */
  spinBars: 16,
  /** Bars per full hue rotation. Slow: three hues maximum (art-direction §2.2). */
  hueBars: 48,
  /**
   * Per-frame brightness floor. TINY on purpose: with a trail of retention k the
   * accumulator settles at B/(1-k), which at a 1-beat tau and 165 fps is ~50x.
   * Tuning this as though each frame stood alone is what blew the first attempt
   * out to white in about a second.
   */
  brightBase: 0.060,
  /** Added per unit of broadband level. */
  brightLevel: 0.120,
  /** Added per unit of envelope. The old chain's `pulse` and `env` terms, summed — see the header. */
  brightEnv: 0.080,
  /**
   * World -> NDC fit. The attractor spans x in [-20,20] and z in [0,50] (so
   * +/-25 once centred), and weak perspective widens that by up to ~1.4x.
   * 25 * s * 1.4 should land near 0.85 NDC, hence ~0.022.
   */
  fit: 0.022,
  /** Half-width of a segment in NDC. Below ~0.001 the gaussian has nothing to fall across. */
  thickness: 0.0016,
};

/**
 * Hard ceiling on the buffer.
 *
 * 262 144 trajectories is 8 MB of storage and 1.6 M vertices. A preset arrives
 * over a URL hash and `trajectories: 1e9` is a plausible typo; it must cost the
 * layer its intent, not the page its memory.
 */
const MAX_TRAJECTORIES = 262_144;

/** Bytes per trajectory: 8 floats (see the layout note in `lorenz.wgsl`). */
const BYTES_PER_TRAJECTORY = 8 * 4;

/**
 * Largest step the integration is allowed to see, in beats.
 *
 * A tab switch or a shader compile produces one enormous `dt`, and six Euler
 * steps of a huge `dt` throw every trajectory past the divergence guard at once
 * — the whole attractor reseeds and the frame flashes. Clamping loses a little
 * travel after a stall, which is invisible. The old chain clamped the same thing
 * in seconds (`Math.min(dt, 1/20)`); beats is the correct domain for it.
 */
const MAX_DT_BEATS = 0.5;

function num(
  params: Readonly<Record<string, ParamValue>>,
  key: string,
  lo: number,
  hi: number,
): number {
  const fallback = LORENZ_DEFAULTS[key];
  const raw = params[key] ?? fallback;
  const v = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(v)) return typeof fallback === 'number' ? fallback : lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Trajectory count, resolved identically everywhere it is asked for.
 *
 * `bytes`, `workgroups` and `vertexCount` must agree exactly: a vertex count
 * larger than the buffer reads past the end (zeroed, so it draws a degenerate
 * segment at the origin rather than failing), and a dispatch larger than the
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
 * No `init`. The renderer zero-fills a freshly allocated buffer, and the compute
 * shader treats a zero seeded-flag as "scatter me" — so the initial positions
 * are a pure function of the trajectory index, computed on the GPU, identical on
 * every run (§4.7). Seeding on the CPU instead would mean porting `hash11` to
 * TypeScript and keeping the two bit-identical forever, for no gain.
 *
 * The consequence, stated because it is a real limitation and not an oversight:
 * the scatter does not mix `layer.seed`, so two `lorenz` layers in one stack
 * start from the same 24k points. They diverge immediately if their params
 * differ and not at all if they do not. Mixing the seed in is a two-line change
 * to `seedPoint`, and it changes every existing preset's picture, so it is not
 * made here.
 */
const POINTS: StorageSpec = {
  label: 'points',
  bytes: (params) => trajectoryCount(params) * BYTES_PER_TRAJECTORY,
};

/**
 * The shape fields, declared once.
 *
 * `passBindingsWGSL` needs a descriptor to generate the storage declaration, and
 * the descriptor needs that declaration to have its `code`. Writing the shape
 * twice would compile perfectly and generate a binding set that does not match
 * the layout `renderer.ts` builds from the real descriptor.
 *
 * `input: 'none'` is explicit even though `source` already defaults to it: a
 * source draws INTO the accumulator and so may not sample it, and that is worth
 * stating where someone might otherwise add it.
 */
const SHAPE = {
  type: 'lorenz',
  family: 'source',
  input: 'none',
  uniformFloats: UNIFORM_FLOATS,
  storage: [POINTS],
} as const;

export const lorenzPass: PassDescriptor = {
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
      COMPUTE_BODY,
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
   * a half-res pass is a half-res line smeared bilinearly back up. Advisory only;
   * §4.11 says the scale is a budget decision and the budget belongs to the show.
   */
  defaultResolutionScale: 1,

  writeUniforms(out: Float32Array, ctx: PassContext): void {
    const p = ctx.params;

    const count = trajectoryCount(p);
    const substeps = Math.max(1, Math.floor(num(p, 'substeps', 1, 64)));

    // Integration rate per BEAT, not per frame. A fixed step per frame is both
    // frame-rate dependent (the attractor ran faster at 165 fps than at 60) and
    // musically meaningless.
    const dtRaw = Number.isFinite(ctx.dtBeats) ? ctx.dtBeats : 0;
    const dtBeats = dtRaw <= 0 ? 0 : Math.min(dtRaw, MAX_DT_BEATS);
    out[U_DT] = (num(p, 'simPerBeat', 0, 64) * dtBeats) / substeps;
    out[U_STEPS] = substeps;

    // Audio drives the system's PARAMETERS, not just its brightness. rho is the
    // bifurcation parameter — pushing it makes the attractor genuinely change
    // shape rather than merely getting brighter (art-direction §3.3).
    out[U_RHO] = num(p, 'rhoBase', 0, 200)
      + ctx.audio.bands.low * num(p, 'rhoLow', -64, 64)
      + ctx.progress * num(p, 'rhoPulse', -64, 64);
    out[U_SIGMA] = num(p, 'sigma', 0, 100);
    out[U_BETA] = num(p, 'beta', 0, 100);
    out[U_COUNT] = count;
    // Never set from a param. A reseed is a transport event (§4.10) and belongs
    // to whatever handles seek and track change, not to a preset value that
    // would re-scatter the attractor on every single dispatch.
    out[U_RESEED] = 0;

    // Bars, not beats, for the two rates a viewer reads as travel rather than as
    // pulse. Absolute rather than integrated — see the header, point 1 — and the
    // fractional part is taken BEFORE scaling so the angle never grows large
    // enough for f32 to lose the low bits of a slow spin.
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
  },
};
