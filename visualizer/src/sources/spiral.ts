// The spiral source's registration (plan §8.1). Look: LAB.
//
// An Archimedean spiral: radius grows with the sample index, the sample itself
// perturbs it. The drawing argument — and the argument about why the inner turns
// do not solidify — is in `src-spiral.wgsl`.
//
// The one piece of real work in this file is `writeUniforms`'s wobble clamp.
// Adjacent turns are `(rOuter - rInner) / turns` apart; a radial displacement
// larger than half of that makes turn n cross turn n+1, and a spiral whose turns
// cross is a scribble. The preset supplies an intent (`gain`) and this clamps it
// against the geometry the preset also chose, so no combination of params can
// produce the scribble. Doing it here rather than in the shader means it is
// checkable by the golden harness on a machine with no GPU.
//
// Same division of labour as `scope.ts`: no device, no buffer, no pipeline, and
// none of the fields the preset owns (blend, opacity, envelope, palette slot,
// resolution scale). Determinism (§4.7): every rate is a clock division off
// `ctx.beats`, no wall clock, no `Math.random`.

import { AUDIO_WGSL } from '../audiogpu.ts';
import type { ParamValue, PassContext, PassDescriptor } from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP } from '../renderer.ts';
import body from '../shaders/src-spiral.wgsl';

/** See the note in `ribbon.ts`: the binding number is generated, never typed. */
const PARAMS_WGSL = `@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> P : Params;`;

/** Field order. Must match `struct Params` in `src-spiral.wgsl` float for float. */
const F_GAIN = 0;
const F_HALF_WIDTH = 1;
const F_SEGMENTS = 2;
const F_TURNS = 3;
const F_R_INNER = 4;
const F_R_OUTER = 5;
const F_CENTRE_X = 6;
const F_CENTRE_Y = 7;
const F_SPIN = 8;
const F_WINDOW = 9;
const F_SCROLL = 10;
const F_WEIGHT_VAR = 11;
const F_TAPER_INNER = 12;
const F_INNER_FADE = 13;
const F_SWIRL = 14;
// 15 is the struct's tail pad. Never written, never read.
const PARAM_FLOATS = 16;

const TAU = Math.PI * 2;

/**
 * Segments in the path. A spiral is longer than a scope trace by roughly its
 * turn count, so it needs proportionally more of them: 1536 across eight turns
 * is ~190 per turn, which is smooth at the outer radius and generous at the
 * inner one.
 */
const DEFAULT_SEGMENTS = 1536;
const MAX_SEGMENTS = 16_384;

/**
 * The largest fraction of the turn spacing the radial wobble may occupy.
 *
 * Below 0.5 two adjacent turns cannot meet even when one swings out and the
 * other swings in; 0.42 leaves a visible gap at full deflection, which is what
 * keeps the figure legible as a spiral rather than as a band.
 */
const MAX_WOBBLE = 0.42;

export const spiralPass: PassDescriptor = {
  type: 'spiral',
  family: 'source',
  input: 'none',
  usesAudio: true,
  code: [PASS_COMMON_WGSL, AUDIO_WGSL, PARAMS_WGSL, body].join('\n'),

  draw: {
    kind: 'vertices',
    // Six per segment quad, zero at progress 0 — a spent layer is a true no-op.
    vertexCount: (ctx) => (ctx.progress > 0 ? 6 * segmentCount(ctx.params) : 0),
  },

  /** Thin tapered line work. See the note in `scope.ts`; the same argument holds. */
  defaultResolutionScale: 1,

  uniformFloats: PARAM_FLOATS,
  writeUniforms(out: Float32Array, ctx: PassContext): void {
    const p = ctx.params;

    const turns = Math.max(num(p, 'turns', 8), 0.5);
    const rInner = Math.max(num(p, 'rInner', 0.04), 0);
    const rOuter = Math.max(num(p, 'rOuter', 0.92), rInner + 1e-3);
    const spacing = (rOuter - rInner) / turns;

    // The clamp described in the header. `gain` is an intent; the geometry the
    // preset also chose decides how much of it can be honoured.
    out[F_GAIN] = Math.min(Math.max(num(p, 'gain', 0.09), 0), spacing * MAX_WOBBLE);
    out[F_HALF_WIDTH] = Math.max(num(p, 'thickness', 0.004), 0) * 0.5;
    out[F_SEGMENTS] = segmentCount(p);
    out[F_TURNS] = turns;
    out[F_R_INNER] = rInner;
    out[F_R_OUTER] = rOuter;
    // Off-centre by default (§4.1). The spiral's own centre is legitimate — it
    // is a radial SOURCE — but there is no reason for it to be the frame's.
    out[F_CENTRE_X] = num(p, 'centreX', 0.12);
    out[F_CENTRE_Y] = num(p, 'centreY', -0.06);

    // Rotation on a clock division, never on wall-clock seconds (§3.1). The
    // fractional part is taken before scaling so a slow spin never loses its low
    // bits to f32.
    const spinBars = Math.max(num(p, 'spinBars', 12), 1e-3);
    out[F_SPIN] = fract(ctx.bars / spinBars) * TAU;

    out[F_WINDOW] = clamp01(num(p, 'window', 1));
    const scrollBeats = Math.max(num(p, 'scrollBeats', 4), 1e-3);
    out[F_SCROLL] = fract(ctx.beats / scrollBeats);

    out[F_WEIGHT_VAR] = clamp01(num(p, 'weightVar', 0.7));
    // Taper and fade are the two halves of the crowding fix and are clamped
    // apart from each other: a preset may make the centre thin without making it
    // dim, but it cannot make either of them 1 and get the solid disc back
    // unless it asks for exactly that.
    out[F_TAPER_INNER] = clamp01(num(p, 'taperInner', 0.28));
    out[F_INNER_FADE] = clamp01(num(p, 'innerFade', 0.22));

    // Angular wobble, in radians, capped at eight segments' worth of angular
    // step. Eight rather than one: at the default 1536 segments over 8 turns a
    // single step is 0.033 rad, which is below the shear being visible at all.
    // The cap is a bound on how far the shear can drag the path relative to the
    // sampling rate, not a guarantee that two adjacent samples cannot cross —
    // the guarantee that matters is the RADIAL one above, which is what keeps
    // adjacent turns apart.
    const step = (turns * TAU) / segmentCount(p);
    out[F_SWIRL] = Math.min(Math.max(num(p, 'swirl', 0.35), 0), step * 8);
  },
};

function segmentCount(p: Readonly<Record<string, ParamValue>>): number {
  const n = Math.round(num(p, 'segments', DEFAULT_SEGMENTS));
  return n < 2 ? 2 : n > MAX_SEGMENTS ? MAX_SEGMENTS : n;
}

function num(p: Readonly<Record<string, ParamValue>>, key: string, fallback: number): number {
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Positive fractional part. `%` keeps the sign of the dividend and beats can be negative on a pre-roll. */
function fract(v: number): number {
  return v - Math.floor(v);
}
