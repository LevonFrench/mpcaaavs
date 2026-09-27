// The wavegrid source's registration (plan §8.1). Look: GRID.
//
// A perspective line grid displaced by the waveform — the rippled sheet under a
// fixed horizon. The drawing argument, and the three defences that keep the far
// rows from flickering, are in `src-wavegrid.wgsl`.
//
// The two things this file is responsible for that the shader cannot be:
//
//   - The vertex count. Rows and columns are two line FAMILIES out of one index
//     range, and `vertexCount` here and the decode in the vertex shader must
//     agree exactly: a count larger than the decode understands draws garbage
//     segments at index zero, and a smaller one silently truncates the far edge
//     of the sheet. One formula, stated once, in `segmentCount`.
//   - The travel direction. `travelFrac` runs 1 -> 0 rather than 0 -> 1, because
//     rows must approach the viewer; the sheet retreating is the same animation
//     played backwards and reads as falling rather than flying.
//
// Determinism (§4.7): the scroll and the travel are clock divisions off
// `ctx.beats`, there is no wall clock and no `Math.random`.

import { AUDIO_WGSL } from '../audiogpu.ts';
import type { ParamValue, PassContext, PassDescriptor } from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP } from '../renderer.ts';
import body from '../shaders/src-wavegrid.wgsl';

/** See the note in `ribbon.ts`: the binding number is generated, never typed. */
const PARAMS_WGSL = `@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> P : Params;`;

/** Field order. Must match `struct Params` in `src-wavegrid.wgsl` float for float. */
const F_ROWS = 0;
const F_COLS = 1;
const F_AMP = 2;
const F_HALF_WIDTH = 3;
const F_SPAN_X = 4;
const F_Z_NEAR = 5;
const F_Z_SPAN = 6;
const F_TRAVEL = 7;
const F_HORIZON = 8;
const F_CAM_Y = 9;
const F_FOCAL = 10;
const F_WINDOW = 11;
const F_WEIGHT_VAR = 12;
const F_FOG = 13;
const F_SCROLL = 14;
const F_STEREO = 15;
const F_Z_WAVE = 16;
const F_DEPTH_AMP = 17;
const F_CREST = 18;
// 19 is the struct's tail pad. Never written, never read.
const PARAM_FLOATS = 20;

const DEFAULT_ROWS = 48;
const DEFAULT_COLS = 64;

/**
 * Ceiling per axis. 192x192 is ~73k segments, 440k vertices — already more than
 * the sheet can show at 1440p. A preset arrives over a URL hash and `rows: 1e6`
 * is a plausible typo; it must cost the layer its intent, not the page its
 * frame time.
 */
const MAX_AXIS = 192;

export const wavegridPass: PassDescriptor = {
  type: 'wavegrid',
  family: 'source',
  input: 'none',
  usesAudio: true,
  code: [PASS_COMMON_WGSL, AUDIO_WGSL, PARAMS_WGSL, body].join('\n'),

  draw: {
    kind: 'vertices',
    // Six per segment quad, zero at progress 0 — a spent layer is a true no-op.
    vertexCount: (ctx) => (ctx.progress > 0 ? 6 * segmentCount(ctx.params) : 0),
  },

  /**
   * Full resolution, and here it is less advisory than elsewhere: the far rows
   * are already at the sub-pixel clamp, and halving the attachment halves the
   * depth at which the grid stops resolving — the horizon goes bald.
   */
  defaultResolutionScale: 1,

  uniformFloats: PARAM_FLOATS,
  writeUniforms(out: Float32Array, ctx: PassContext): void {
    const p = ctx.params;

    out[F_ROWS] = axis(p, 'rows', DEFAULT_ROWS);
    out[F_COLS] = axis(p, 'cols', DEFAULT_COLS);
    out[F_AMP] = Math.max(num(p, 'amp', 0.42), 0);
    out[F_HALF_WIDTH] = Math.max(num(p, 'thickness', 0.011), 0) * 0.5;

    // World geometry. The near edge has to run off BOTH sides of the frame or
    // the sheet floats in the middle with two visible corners, and the depth it
    // has to clear is not `zNear` — the nearest row sits at
    // `zNear + travelFrac * zSpan / rows`, so at the far end of its travel it is
    // a whole row spacing further away. With the defaults that worst case is
    // z = 2.14, and 4.0 / 2.14 = 1.87 unit against a 16:9 half-width of 1.78.
    // 2.6 was NOT enough: it gives 1.21 at that same depth and the corners show.
    out[F_SPAN_X] = Math.max(num(p, 'spanX', 4), 1e-3);
    const zNear = Math.max(num(p, 'zNear', 1.6), 1e-2);
    out[F_Z_NEAR] = zNear;
    out[F_Z_SPAN] = Math.max(num(p, 'depth', 26), 1e-2);
    // Fixed. The discipline of the GRID look (§1.2) is that the horizon does not
    // move, so this is a composition constant and never an audio target.
    out[F_HORIZON] = num(p, 'horizon', 0.3);
    out[F_CAM_Y] = num(p, 'cameraHeight', 1.5);
    out[F_FOCAL] = Math.max(num(p, 'focal', 1), 1e-3);

    out[F_WINDOW] = clamp01(num(p, 'window', 1));
    out[F_WEIGHT_VAR] = clamp01(num(p, 'weightVar', 0.7));
    out[F_FOG] = Math.max(num(p, 'fog', 0.11), 0);
    out[F_STEREO] = clamp01(num(p, 'stereo', 0.8));
    out[F_Z_WAVE] = num(p, 'zWave', 0.09);
    out[F_DEPTH_AMP] = Math.max(num(p, 'depthDamp', 0.1), 0);
    out[F_CREST] = Math.max(num(p, 'crest', 0.9), 0);

    // Travel, on a clock division and counting DOWN so the rows approach. One
    // full cycle advances the sheet by exactly one row spacing, so the INTERIOR
    // is the same picture at 0 and at 1. The ends are not — `strokeAt` fades the
    // near row over exactly one spacing to cover the row that gets replaced.
    const travelBeats = Math.max(num(p, 'travelBeats', 1), 1e-3);
    out[F_TRAVEL] = 1 - fract(ctx.beats / travelBeats);
    // The waveform's own phase moves on a slower division than the travel, so
    // the ripple and the grid do not lock into one motion (§3.4).
    const scrollBeats = Math.max(num(p, 'scrollBeats', 16), 1e-3);
    out[F_SCROLL] = fract(ctx.beats / scrollBeats);
  },
};

/**
 * Segments, resolved identically here and in the vertex shader's decode.
 *
 * `rows` polylines of `cols - 1` segments across the sheet, plus `cols`
 * polylines of `rows - 1` segments into the distance.
 */
function segmentCount(p: Readonly<Record<string, ParamValue>>): number {
  const rows = axis(p, 'rows', DEFAULT_ROWS);
  const cols = axis(p, 'cols', DEFAULT_COLS);
  return rows * (cols - 1) + cols * (rows - 1);
}

function axis(p: Readonly<Record<string, ParamValue>>, key: string, fallback: number): number {
  const n = Math.floor(num(p, key, fallback));
  return n < 2 ? 2 : n > MAX_AXIS ? MAX_AXIS : n;
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
