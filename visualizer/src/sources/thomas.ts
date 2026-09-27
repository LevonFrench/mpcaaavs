// Thomas' cyclically symmetric attractor — plan §8.3.
//
// LOOK: `ink` (art-direction §1.3). This is the quiet member of the family and
// the only attractor that suits that look. Three reasons, all structural rather
// than stylistic:
//
//   - Its speed is O(1) everywhere. There are no fast lobe transits, so there
//     are no bright chords and no flicker — the figure evolves rather than
//     flashing.
//   - It is cyclically symmetric in x, y, z, so it has no privileged axis and no
//     centre to radiate from (§4.1).
//   - Its route to chaos is a single slow slide down `b`, which is exactly the
//     "it evolves, it does not loop" discipline: a slow parameter drift produces
//     a genuinely different figure rather than a phase of the same one.
//
// Drawn as segments from a compute prepass over a persistent storage buffer;
// the mechanism, the buffer layout and the draw are shared with `rossler.ts` and
// `halvorsen.ts` (`attractor-flow-main.wgsl`, `attractor-flow.wgsl`). The
// descriptor, the struct and the parameter table are this file's own, because
// the coefficients mean different things per system and one shared defaults
// table is how a value from the wrong attractor gets in.

import type {
  ParamValue,
  PassContext,
  PassDescriptor,
  StorageSpec,
} from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP, passBindingsWGSL } from '../renderer.ts';
import HASH_BODY from '../shaders/attractor-common.wgsl';
import FIELD_BODY from '../shaders/attr-thomas.wgsl';
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
struct Thomas {
  dt        : f32,   // simulation time per SUBSTEP. Derived from dtBeats on the CPU.
  steps     : f32,   // substeps per dispatch
  pa        : f32,   // b — the dissipation. Canonical 0.208186. Audio drives it.
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

@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> P : Thomas;
`;

const STORAGE_RW_WGSL =
  `@group(${PASS_GROUP}) @binding(${PASS_BINDING.storage0}) ` +
  `var<storage, read_write> points : array<f32>;`;

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/**
 * CANONICAL VALUE, stated because a wrong constant gives a blob rather than an
 * attractor: b = 0.208186 (Thomas, 1999). The whole bifurcation structure lives
 * in that one number — above 0.32787 everything decays to the origin, ~0.32 is
 * a single limit cycle, 0.208186 is the canonical chaotic figure, and below
 * ~0.1 it opens into a much larger space-filling tangle.
 *
 * The base here is 0.19 rather than 0.208186 on purpose: audio drives `b`
 * DOWNWARD (louder is more chaotic), so the base sits a little below canonical
 * and the quiet state is the canonical figure's near neighbour rather than its
 * collapsed one.
 */
export const THOMAS_DEFAULTS: Readonly<Record<string, ParamValue>> = {
  trajectories: 24_000,
  substeps: 6,
  /**
   * Simulation time per BEAT. Thomas is SLOW — |dp/dt| is about 1.4 — so it
   * needs a much larger figure than Lorenz's 0.85 to travel the same fraction
   * of its (+/-4.6) extent per beat.
   */
  simPerBeat: 4.0,
  /** Dissipation. See the header note on why this is below canonical. */
  bBase: 0.19,
  /**
   * How far the LOW band pushes b, negative so that louder is LESS damped and
   * therefore more chaotic. The direction matters: driving b upward would
   * collapse the figure to a ring on the loud parts, which is backwards from
   * what the ear expects.
   *
   * Low band rather than mid — Rossler is on mid and Halvorsen on sub, so the
   * three attractors breathe on different drivers (art-direction §3.3).
   */
  bLow: -0.075,
  /** How far the layer's envelope pushes b. Small: this look does not snap. */
  bPulse: -0.030,
  /** Bars per revolution. Slower than the others; `ink` motion is /8, /16. */
  spinBars: 32,
  hueBars: 48,
  /** Per-frame contribution, tuned FOR the accumulator (steady state is B/(1-k)). */
  brightBase: 0.055,
  brightLevel: 0.100,
  brightEnv: 0.075,
  /** World -> NDC fit. The attractor fills a cube of ~+/-4.6, so 4.6*0.13*1.3 ~ 0.78 NDC. */
  fit: 0.13,
  /** Half-width in NDC before the shader's depth/speed variation. */
  thickness: 0.0018,
  /** Cyclically symmetric about the origin — there is nothing to offset. */
  centreX: 0,
  centreY: 0,
  centreZ: 0,
  /**
   * Depth range is ~+/-4.6, and `depth = 1/(1 + z*k)` is NOT symmetric about 1:
   * at k = 0.09 the far end is 0.71x but the near end is 1.71x, not the 1.5x the
   * `fit` note above budgets for — 4.6 * 0.13 * 1.71 is 1.02 NDC, so the near
   * corners of the cube fall off the frame. 0.07 gives 0.73x..1.48x, which is
   * the range this was documented as and the one `fit` was fitted against.
   */
  depthK: 0.07,
  hueSpread: 0.8,
};

const MAX_TRAJECTORIES = 262_144;
const BYTES_PER_TRAJECTORY = 8 * 4;
const MAX_DT_BEATS = 0.5;

/**
 * Bounds on the driven dissipation, applied to the SUM.
 *
 * Not cosmetic. At b <= 0 the system is conservative and the trajectories
 * perform an unbounded "labyrinth walk" — they diffuse outward forever, trip the
 * divergence guard in a body, and the whole field reseeds at once, which reads
 * as a flash. The floor keeps it dissipative; the ceiling keeps it from
 * collapsing to the origin and rendering nothing.
 */
const B_MIN = 0.03;
const B_MAX = 0.32;

function num(
  params: Readonly<Record<string, ParamValue>>,
  key: string,
  lo: number,
  hi: number,
): number {
  const fallback = THOMAS_DEFAULTS[key];
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
  type: 'thomas',
  family: 'source',
  input: 'none',
  uniformFloats: UNIFORM_FLOATS,
  storage: [POINTS],
} as const;

export const thomasPass: PassDescriptor = {
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

    // Audio drives the dissipation, which IS this system's bifurcation
    // parameter — the figure opens from a limit cycle to a space-filling tangle
    // as it falls. Shape, not brightness (art-direction §3.3).
    const b = num(p, 'bBase', 0, 1)
      + ctx.audio.bands.low * num(p, 'bLow', -1, 1)
      + ctx.progress * num(p, 'bPulse', -1, 1);
    out[U_PA] = Math.min(Math.max(b, B_MIN), B_MAX);
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
