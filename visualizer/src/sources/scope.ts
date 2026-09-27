// The oscilloscope source's registration (plan §8.1). Look: LAB.
//
// This module's whole job is to describe the pass: its WGSL, how many vertices
// it wants, and how its params pack into the uniform block. The drawing argument
// lives in `src-scope.wgsl`; the scheduling argument lives in `layers.ts`; the
// GPU lives in `renderer.ts`. Nothing here touches a device, a buffer or a
// pipeline, which is what keeps it importable by the preset validator and the
// golden harness on a machine with no GPU at all.
//
// It deliberately does NOT own defaults for anything the PRESET should decide —
// blend, opacity, envelope, palette slot and resolution scale are all `LayerSpec`
// fields and are absent here on purpose. The `p_*` defaults below are only what
// a param means when a preset omits it.

import { AUDIO_WGSL } from '../audiogpu.ts';
import type { ParamValue, PassContext, PassDescriptor } from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP } from '../renderer.ts';
import body from '../shaders/src-scope.wgsl';

/**
 * The params binding, generated rather than typed.
 *
 * It cannot live in the `.wgsl` file: that file is loaded as text and has no way
 * to interpolate `PASS_BINDING`, so the number would have to be hand-written —
 * which is precisely the drift `passBindingsWGSL` exists to prevent. `struct
 * Params` is declared in the shader body and the reference here is forward, which
 * WGSL allows: the scope of a module-scope declaration is the whole module.
 *
 * `passBindingsWGSL` is not called because this pass declares no input, no
 * history and no storage, so it would return an empty string. If any of those
 * are ever added, add the call rather than the declarations.
 */
const PARAMS_WGSL = `@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> P : Params;`;

/** Field order. Must match `struct Params` in `src-scope.wgsl` float for float. */
const F_MODE = 0;
const F_GAIN = 1;
const F_HALF_WIDTH = 2;
const F_SEGMENTS = 3;
const F_RADIUS = 4;
const F_CENTRE_X = 5;
const F_CENTRE_Y = 6;
const F_SPREAD = 7;
const F_WEIGHT_VAR = 8;
const F_WINDOW = 9;
const F_SPIN = 10;
// 11 is the struct's tail pad. Never written, never read.
const PARAM_FLOATS = 12;

const MODES = ['line', 'circle', 'lissajous'] as const;

/**
 * Segments in the trace. 512 is a segment every ~5 px across a 2560-wide frame,
 * which is finer than the eye resolves a curve and coarse enough that the join
 * arithmetic in the vertex shader is 3k invocations rather than 24k.
 */
const DEFAULT_SEGMENTS = 512;

export const scopePass: PassDescriptor = {
  type: 'scope',
  family: 'source',
  // A source draws INTO the accumulator, so it cannot sample it. Explicit
  // because the default is easy to assume the other way round.
  input: 'none',
  usesAudio: true,
  code: [PASS_COMMON_WGSL, AUDIO_WGSL, PARAMS_WGSL, body].join('\n'),

  draw: {
    kind: 'vertices',
    // Six vertices per segment quad, and ZERO at progress 0 — a spent layer is a
    // true no-op (Phase 5 DoD), not a draw that happens to be transparent.
    vertexCount: (ctx) => (ctx.progress > 0 ? 6 * segmentCount(ctx.params) : 0),
  },

  /**
   * Thin analytic-AA line work is exactly what per-layer resolution scaling
   * destroys: the stroke is defined in pixels of the ATTACHMENT, so at half res
   * it is a half-res line bilinearly smeared back up. Advisory only — §4.11 says
   * the scale is a budget decision and the budget belongs to the show.
   */
  defaultResolutionScale: 1,

  uniformFloats: PARAM_FLOATS,
  writeUniforms(out: Float32Array, ctx: PassContext): void {
    const p = ctx.params;
    out[F_MODE] = MODES.indexOf(mode(p, 'mode', 'line'));
    out[F_GAIN] = num(p, 'gain', 0.55);
    out[F_HALF_WIDTH] = Math.max(num(p, 'thickness', 0.0035), 0) * 0.5;
    out[F_SEGMENTS] = segmentCount(p);
    out[F_RADIUS] = num(p, 'radius', 0.45);
    // Off-centre by default. Art-direction §4.1: nothing radiates from the
    // centre of the frame unless a centre IS the mechanism, and a circular scope
    // pinned dead centre is the "pulse from the middle" the document rejects.
    // The Lissajous is the honest exception — a vectorscope's origin is its zero
    // — and a preset that wants it centred sets these to 0.
    out[F_CENTRE_X] = num(p, 'centreX', -0.16);
    out[F_CENTRE_Y] = num(p, 'centreY', 0.08);
    // Aspect applied here rather than in the shader so the trace spans the frame
    // at any aspect while circles stay round. The shader works in unit space
    // (y in [-1,1], x in [-aspect, aspect]) and knows nothing about this.
    out[F_SPREAD] = num(p, 'spread', 0.86) * ctx.aspect;
    out[F_WEIGHT_VAR] = clamp01(num(p, 'weightVar', 0.7));
    out[F_WINDOW] = clamp01(num(p, 'window', 1));
    // Rotation on a clock division, never on wall-clock seconds (§3.1). The
    // fractional part is taken before scaling so the angle never grows large
    // enough for f32 to lose the low bits of a slow spin.
    const spinBeats = Math.max(num(p, 'spinBeats', 32), 1e-3);
    out[F_SPIN] = fract(ctx.beats / spinBeats) * Math.PI * 2;
  },
};

function segmentCount(p: Readonly<Record<string, ParamValue>>): number {
  return Math.max(2, Math.round(num(p, 'segments', DEFAULT_SEGMENTS)));
}

function num(p: Readonly<Record<string, ParamValue>>, key: string, fallback: number): number {
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function mode(
  p: Readonly<Record<string, ParamValue>>,
  key: string,
  fallback: (typeof MODES)[number],
): (typeof MODES)[number] {
  const v = p[key];
  const found = MODES.find((m) => m === v);
  return found ?? fallback;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Positive fractional part. `%` keeps the sign of the dividend and beats can be negative on a pre-roll. */
function fract(v: number): number {
  return v - Math.floor(v);
}
