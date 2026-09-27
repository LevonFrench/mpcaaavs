// The ribbon source's registration (plan §8.1). Look: INK.
//
// The waveform as a twisted band with a normal and a light on it, not a stroked
// line — the drawing argument is in `src-ribbon.wgsl` and the whole of it is
// that a band has a surface and a line does not.
//
// Same division of labour as `scope.ts`: this module is data plus pure
// functions, so the preset validator and the golden harness can import it on a
// machine with no adapter. It owns no device, no buffer, no pipeline, and none
// of the fields the PRESET should decide (blend, opacity, envelope, palette
// slot, resolution scale are all `LayerSpec`). The `p_*` defaults below are only
// what a param means when a preset omits it.
//
// Determinism (§4.7): every rate below is a clock division read off `ctx.beats`,
// there is no wall clock and no `Math.random`, and `fract` is taken BEFORE the
// scale so a slow rate never grows an angle large enough for f32 to lose its low
// bits.

import { AUDIO_WGSL } from '../audiogpu.ts';
import type { ParamValue, PassContext, PassDescriptor } from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP } from '../renderer.ts';
import body from '../shaders/src-ribbon.wgsl';

/**
 * The params binding, generated rather than typed — the `.wgsl` file is loaded
 * as text and cannot interpolate `PASS_BINDING`, so hand-writing the number
 * there is exactly the drift `passBindingsWGSL` exists to prevent. `struct
 * Params` is declared in the shader body; the forward reference is legal because
 * a module-scope declaration's scope is the whole module.
 *
 * `passBindingsWGSL` is not called: this pass declares no input, no history and
 * no storage, so it would return an empty string. Add the call rather than the
 * declarations if that ever changes.
 */
const PARAMS_WGSL = `@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> P : Params;`;

/** Field order. Must match `struct Params` in `src-ribbon.wgsl` float for float. */
const F_GAIN = 0;
const F_HALF_WIDTH = 1;
const F_SEGMENTS = 2;
const F_SPREAD = 3;
const F_CENTRE_X = 4;
const F_CENTRE_Y = 5;
const F_TWIST_TURNS = 6;
const F_TWIST_PHASE = 7;
const F_WEIGHT_VAR = 8;
const F_WINDOW = 9;
const F_SCROLL = 10;
const F_STEREO_WIDTH = 11;
const F_GLOSS = 12;
const F_SHADE = 13;
const F_TAPER = 14;
// 15 is the struct's tail pad. Never written, never read.
const PARAM_FLOATS = 16;

const TAU = Math.PI * 2;

/**
 * Segments along the band. Higher than the scope's 512 because this one has a
 * width to keep smooth as well as a path: a visible facet on a silhouette is far
 * more obvious than one on a hairline. 768 is still 4.6k vertices.
 */
const DEFAULT_SEGMENTS = 768;

/** Ceiling on the vertex count a preset can ask for. A preset arrives over a URL hash. */
const MAX_SEGMENTS = 8192;

export const ribbonPass: PassDescriptor = {
  type: 'ribbon',
  family: 'source',
  // A source draws INTO the accumulator and so may not sample it. Explicit
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
   * Full resolution. The band's edge is analytic and its highlight is a
   * ~1-pixel lobe; both are defined in ATTACHMENT pixels, so a half-res pass is
   * a half-res edge bilinearly smeared back up. Advisory only — §4.11 says the
   * scale is a budget decision and the budget belongs to the show.
   */
  defaultResolutionScale: 1,

  uniformFloats: PARAM_FLOATS,
  writeUniforms(out: Float32Array, ctx: PassContext): void {
    const p = ctx.params;

    out[F_GAIN] = num(p, 'gain', 0.28);
    out[F_HALF_WIDTH] = Math.max(num(p, 'width', 0.055), 0) * 0.5;
    out[F_SEGMENTS] = segmentCount(p);
    // Aspect applied here, not in the shader, so the band spans the frame at any
    // aspect while the width stays in unit-y and the twist stays circular.
    out[F_SPREAD] = num(p, 'spread', 0.82) * ctx.aspect;
    // Off-centre by default (§4.1). A band lying across the middle of the frame
    // is the composition every waveform visualiser already has.
    out[F_CENTRE_X] = num(p, 'centreX', 0.05);
    out[F_CENTRE_Y] = num(p, 'centreY', -0.13);

    out[F_TWIST_TURNS] = num(p, 'twistTurns', 1.35) * TAU;
    // Bars, not beats: the roll is travel, not pulse, and §3.3 wants the layers
    // moving at different rates. Absolute rather than integrated, so two runs
    // over the same audio arrive at the same angle whatever the frame pacing.
    const twistBars = Math.max(num(p, 'twistBars', 24), 1e-3);
    out[F_TWIST_PHASE] = fract(ctx.bars / twistBars) * TAU;

    out[F_WEIGHT_VAR] = clamp01(num(p, 'weightVar', 0.75));
    out[F_WINDOW] = clamp01(num(p, 'window', 1));
    // The waveform slides through the band on its own division, so the shape
    // travels along the stroke instead of sitting still and merely wobbling.
    const scrollBeats = Math.max(num(p, 'scrollBeats', 8), 1e-3);
    out[F_SCROLL] = fract(ctx.beats / scrollBeats);

    out[F_STEREO_WIDTH] = Math.max(num(p, 'stereoWidth', 0.9), 0);

    // The one term allowed above 1.0 (§2.4), and it is scaled by the palette
    // slot's own intensity so an `accent` ribbon glints and a `bg` one does not.
    out[F_GLOSS] = Math.max(num(p, 'gloss', 0.55), 0) * Math.max(ctx.color.intensity, 0);
    // Not zero. A band whose far side is black has a hole in it rather than a
    // shadow, and §2.3 asks for the value RANGE, not for a clipped floor.
    out[F_SHADE] = clamp01(num(p, 'shade', 0.22));
    out[F_TAPER] = Math.max(num(p, 'taper', 0.55), 0.05);
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
