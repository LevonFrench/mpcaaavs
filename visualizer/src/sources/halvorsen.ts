// Halvorsen's cyclically symmetric attractor — plan §8.3.
//
// LOOK: `rave` (art-direction §1.4). Three interlocking lobes at 120 degrees,
// dense, fast, and with genuine depth structure once it spins — it is the
// showiest member of the family and the one that survives being stacked under
// operators. If it shares a preset with another attractor, one of them must
// have its contrast pulled right down (§4.2, one focal point).
//
// Mechanism as `rossler.ts` and `thomas.ts`: a compute prepass advances M
// independent trajectories through a persistent storage buffer, and the draw
// reads that buffer from the vertex stage and emits a quad per SEGMENT. The
// shared shader bodies are `attractor-flow-main.wgsl` and
// `attractor-flow.wgsl`.
//
// The thing that makes this one different from its two siblings, and the thing
// to be careful with: its basin is FINITE. The quadratic terms diverge in finite
// time outside it, so both the scatter (tight, in `attr-halvorsen.wgsl`) and the
// clamp on the driven `a` below are load-bearing rather than defensive.

import type {
  ParamValue,
  PassContext,
  PassDescriptor,
  StorageSpec,
} from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP, passBindingsWGSL } from '../renderer.ts';
import HASH_BODY from '../shaders/attractor-common.wgsl';
import FIELD_BODY from '../shaders/attr-halvorsen.wgsl';
import COMPUTE_MAIN from '../shaders/attractor-flow-main.wgsl';
import RENDER_BODY from '../shaders/attractor-flow.wgsl';

// ---------------------------------------------------------------------------
// Uniform block — one block, both stages. See `rossler.ts` for the argument.
// ---------------------------------------------------------------------------

const UNIFORM_FLOATS = 17;

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

const PARAMS_WGSL = /* wgsl */`
struct Halvorsen {
  dt        : f32,   // simulation time per SUBSTEP. Derived from dtBeats on the CPU.
  steps     : f32,   // substeps per dispatch
  pa        : f32,   // a — the damping. Canonical 1.4. Audio drives it.
  pb        : f32,   // unused; the shared flow layout carries three coefficients
  pc        : f32,   // unused
  count     : f32,
  reseed    : f32,
  spin      : f32,
  scale     : f32,
  halfWidth : f32,
  bright    : f32,
  hueShift  : f32,
  centreX   : f32,
  centreY   : f32,
  centreZ   : f32,
  depthK    : f32,
  hueSpread : f32,
};

@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> P : Halvorsen;
`;

const STORAGE_RW_WGSL =
  `@group(${PASS_GROUP}) @binding(${PASS_BINDING.storage0}) ` +
  `var<storage, read_write> points : array<f32>;`;

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/**
 * CANONICAL VALUE, stated because a wrong constant gives a blob rather than an
 * attractor: a = 1.4. The 4s and the squares in the field are structural — a
 * Halvorsen with different ones is a different system, not a differently-tuned
 * one, which is why `a` is the only coefficient exposed.
 *
 * a ~ 1.9 collapses toward a limit cycle; 1.4 is the canonical three-lobed
 * figure; ~1.2 opens the lobes; below ~1.1 the trajectory escapes.
 */
export const HALVORSEN_DEFAULTS: Readonly<Record<string, ParamValue>> = {
  trajectories: 24_000,
  /**
   * Eight rather than six. The quadratic terms make this the stiffest member of
   * the family — |dp/dt| reaches ~90 near the lobe extremes — so the same
   * per-beat travel needs a finer substep to stay smooth under forward Euler.
   */
  substeps: 8,
  /**
   * Simulation time per BEAT. Much smaller than the other two because the field
   * is much faster: at |dp/dt| ~ 70 over a ~15-unit figure, 0.20 per beat is
   * about the same fraction of the extent per frame as Rossler's 1.5.
   */
  simPerBeat: 0.20,
  /** The damping, and the bifurcation parameter. */
  aBase: 1.4,
  /**
   * How far the SUB band pushes a, negative so that the low end OPENS the lobes.
   * Sub rather than low or mid — Thomas is on low and Rossler on mid, so the
   * three never breathe together (art-direction §3.3).
   */
  aSub: -0.14,
  /** How far the layer's envelope pushes a. */
  aPulse: -0.08,
  /** Bars per revolution. The fastest of the three; `rave` motion is on the bar. */
  spinBars: 20,
  hueBars: 40,
  /** Per-frame contribution, tuned FOR the accumulator (steady state is B/(1-k)). */
  brightBase: 0.060,
  brightLevel: 0.120,
  brightEnv: 0.080,
  /**
   * World -> NDC fit. The figure spans roughly [-9, 5] on each axis about a
   * centroid near -2, so ~7.5 units of radius; 7.5 * 0.08 * 1.4 lands near
   * 0.84 NDC.
   */
  fit: 0.08,
  thickness: 0.0018,
  /** The centroid. Cyclic symmetry means the same offset on all three axes. */
  centreX: -2.0,
  centreY: -2.0,
  centreZ: -2.0,
  /** Depth range is ~+/-7.5, so 0.03 gives roughly 0.8x..1.3x. */
  depthK: 0.03,
  hueSpread: 1.0,
};

const MAX_TRAJECTORIES = 262_144;
const BYTES_PER_TRAJECTORY = 8 * 4;
const MAX_DT_BEATS = 0.5;

/**
 * Bounds on the driven damping, applied to the SUM.
 *
 * The floor is the important one and it is not a round number by accident:
 * below roughly a = 1.1 the attracting set stops existing and every trajectory
 * escapes to infinity, so the divergence guard fires for all of them at once and
 * the layer goes black. 1.18 keeps a margin. The ceiling merely stops the figure
 * collapsing to an invisible limit cycle on a quiet passage.
 */
const A_MIN = 1.18;
const A_MAX = 1.90;

function num(
  params: Readonly<Record<string, ParamValue>>,
  key: string,
  lo: number,
  hi: number,
): number {
  const fallback = HALVORSEN_DEFAULTS[key];
  const raw = params[key] ?? fallback;
  const v = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(v)) return typeof fallback === 'number' ? fallback : lo;
  return v < lo ? lo : v > hi ? hi : v;
}

function trajectoryCount(params: Readonly<Record<string, ParamValue>>): number {
  return Math.max(1, Math.floor(num(params, 'trajectories', 1, MAX_TRAJECTORIES)));
}

function fract(v: number): number {
  return v - Math.floor(v);
}

// ---------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------

const POINTS: StorageSpec = {
  label: 'points',
  bytes: (params) => trajectoryCount(params) * BYTES_PER_TRAJECTORY,
};

const SHAPE = {
  type: 'halvorsen',
  family: 'source',
  input: 'none',
  uniformFloats: UNIFORM_FLOATS,
  storage: [POINTS],
} as const;

export const halvorsenPass: PassDescriptor = {
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
      FIELD_BODY,
      COMPUTE_MAIN,
    ].join('\n'),
    entryPoint: 'main',
    workgroups: (ctx) => trajectoryCount(ctx.params) / 64,
  },

  draw: {
    kind: 'vertices',
    vertexCount: (ctx) => (ctx.progress > 0 ? 6 * trajectoryCount(ctx.params) : 0),
  },

  defaultResolutionScale: 1,

  writeUniforms(out: Float32Array, ctx: PassContext): void {
    const p = ctx.params;

    const count = trajectoryCount(p);
    const substeps = Math.max(1, Math.floor(num(p, 'substeps', 1, 64)));

    const dtRaw = Number.isFinite(ctx.dtBeats) ? ctx.dtBeats : 0;
    const dtBeats = dtRaw <= 0 ? 0 : Math.min(dtRaw, MAX_DT_BEATS);
    out[U_DT] = (num(p, 'simPerBeat', 0, 64) * dtBeats) / substeps;
    out[U_STEPS] = substeps;

    // Audio drives the damping, which is this system's bifurcation parameter —
    // the lobes open and close with it. Clamped as a SUM: see A_MIN.
    const a = num(p, 'aBase', 0, 8)
      + ctx.audio.bands.sub * num(p, 'aSub', -8, 8)
      + ctx.progress * num(p, 'aPulse', -8, 8);
    out[U_PA] = Math.min(Math.max(a, A_MIN), A_MAX);
    out[U_PB] = 0;
    out[U_PC] = 0;

    out[U_COUNT] = count;
    out[U_RESEED] = 0;

    out[U_SPIN] = fract(ctx.bars / Math.max(num(p, 'spinBars', 1e-3, 4096), 1e-3)) * TAU;
    out[U_HUE_SHIFT] = fract(ctx.bars / Math.max(num(p, 'hueBars', 1e-3, 4096), 1e-3)) * TAU;

    out[U_SCALE] = num(p, 'fit', 0, 1) * Math.min(1, ctx.aspect * 1.15);
    out[U_HALF_WIDTH] = num(p, 'thickness', 0, 0.1);

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
