// The feedback operator's registration — the CPU half of `shaders/op-feedback.wgsl`.
//
// Its whole job is arithmetic: turn a layer's params, which are expressed in
// BEATS and BARS because everything in this project is (art direction §3.1),
// into the twelve floats the shader wants for THIS frame at THIS tempo. The
// shader then applies them and knows nothing about music.
//
// What this module deliberately does NOT do:
//   - It does not touch a GPUDevice, a texture or a buffer. A pass module has to
//     stay importable by the preset validator and the golden harness on a
//     machine with no GPU (contracts.ts, file header), so everything here is a
//     string, a number, or a pure function.
//   - It does not own its ping-pong pair. `history` is declared and the renderer
//     allocates, clears and swaps two `rgba16float` targets per layer. 8-bit
//     feedback compounds and dies (plan §3.2) and that is not per-pass tunable.
//   - It does not composite, and — following from that — it does not apply
//     `ctx.opacity` either. `planStack` emits a separate entry for the
//     composite (layers.ts, the `family === 'feedback'` branch), and BOTH of the
//     paths that entry can take already scale by the layer's opacity: the
//     fixed-function one blits through `BLIT_WGSL`, which returns `c * C.opacity`,
//     and the shader-blend one mixes by `C.opacity` in `XOR_WGSL`. Folding
//     opacity in here as well would square it — a layer at 0.5 would composite at
//     0.25 — and worse, it would bake a per-frame envelope value into a buffer
//     that persists for `tau` beats, so a layer fading out would keep re-reading
//     its own faded contribution. Opacity belongs to the composite alone.
//   - It does not read audio. Everything it needs is already in `PassContext`,
//     and binding the audio group would cost a bind-group set per draw to
//     duplicate numbers the CPU already holds.
//
// ---------------------------------------------------------------------------
// The two pieces of arithmetic that matter, both learned the expensive way
// (README, "Notes worth keeping"):
//
// 1. STEADY STATE. An accumulator with per-frame retention k and per-frame
//    contribution B settles at B/(1-k), not at B. At 165 fps with tau = 0.22 s
//    that multiplier is about 36, and the first version of this effect was
//    tuned as though each frame stood alone — it whited out in roughly a
//    second. So the contribution is not a free parameter here. `gain` is the
//    STEADY STATE the user wants, expressed as a multiple of the frame beneath,
//    and the per-frame injection is derived from it:
//
//        inject = gain * (1 - keep)     =>     H_inf = S * gain
//
//    which falls straight out of H = H*keep + S*gain*(1-keep). The consequence
//    worth having is that the look no longer changes with frame rate: at 60 fps
//    and at 165 fps the same preset settles to the same brightness, because
//    both `keep` and `(1 - keep)` move together.
//
// 2. ZOOM IS AN AMPLIFIER ABOVE 1.0. Magnifying the previous frame every pass
//    spreads a feature over `zoom^2` times the area while retaining `keep` of
//    its value, so the total energy in the buffer multiplies by `keep * zoom^2`
//    per pass. Below 1 that converges; above 1 it does not, and the failure
//    looks like the frame slowly filling with light from the outside in — which
//    reads as "the effect is broken" rather than "the parameter is too high".
//    The bound is therefore:
//
//        keep * zoom_frame^2 < 1
//
//    and in the beats domain, where keep = exp(-dt/tau) and zoom_frame =
//    zoom_beat^dt, the `dt` cancels completely:
//
//        exp(-dt/tau) * zoom_beat^(2*dt) < 1
//        -dt/tau + 2*dt*ln(zoom_beat) < 0
//        zoom_beat < exp(1 / (2 * tauBeats))
//
//    A frame-rate-independent limit, which is exactly what we want: at
//    tau = 1 beat it permits zoom up to e^0.5 = 1.649 per beat, and a longer
//    trail automatically permits less. `ZOOM_SAFETY` keeps us off the boundary,
//    where the steady state is finite but enormous. Runaway is therefore not
//    reachable by dragging a slider; it is only reachable by editing this file.
//
//    1.0 is pure fade and is the default, because it is the only value at which
//    the trail is unambiguously a trail.
// ---------------------------------------------------------------------------

import type {
  PassContext,
  PassDescriptor,
  ParamValue,
} from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP, passBindingsWGSL } from '../renderer.ts';
import shaderBody from '../shaders/op-feedback.wgsl';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** f32 count of `FeedbackParams`. Mirrors the struct in the shader, which documents the byte layout. */
const UNIFORM_FLOATS = 12;

// Offsets in FLOATS. Named for the same reason `renderer.ts` names its own: a
// bare index is how `zoom` and `rot` quietly swap places and the result is still
// a plausible-looking frame.
const U_KEEP = 0;
const U_INJECT = 1;
const U_ZOOM = 2;
const U_ROT = 3;
const U_OFFSET = 4;   // vec2
const U_CENTRE = 6;   // vec2
const U_KNEE = 8;
const U_CEILING = 9;
const U_EDGE = 10;
const U_ASPECT = 11;

const TWO_PI = Math.PI * 2;

/**
 * Distance kept from the stability boundary derived above.
 *
 * At exactly `keep * zoom^2 = 1` the sum is only marginally convergent, so the
 * steady state is finite and astronomically bright, which on screen is
 * indistinguishable from runaway. 0.94 costs a few percent of the available
 * zoom range and removes the whole class of "it was fine and then it wasn't".
 */
const ZOOM_SAFETY = 0.94;

/**
 * Largest step the decay is allowed to see, in beats.
 *
 * A tab switch, a shader compile or a garbage collection produces one enormous
 * `dt`. Without a cap, `zoom^dt` for a dt of several beats is a magnification of
 * thousands in a single pass — one frame of garbage that then feeds itself
 * forever. Clamping loses a little decay after a stall, which is invisible;
 * not clamping loses the buffer.
 */
const MAX_DT_BEATS = 0.5;

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/**
 * Defaults for a `feedback` layer of type `'feedback'`.
 *
 * Exported so a preset author writes `{ ...FEEDBACK_DEFAULTS, zoomPerBeat: 1.02 }`
 * rather than rediscovering which keys exist. Every rate is per BEAT or per BAR;
 * `tauBeats` in particular is not seconds, so the same preset reads identically
 * at 90 and at 174 BPM (contracts.ts, `Envelope`).
 */
export const FEEDBACK_DEFAULTS: Readonly<Record<string, ParamValue>> = {
  /** Beats for the trail to fall to 1/e. Longer than about 4 reads as a smear rather than a trail. */
  tauBeats: 1.5,
  /** Steady-state brightness as a multiple of the frame beneath. NOT the per-frame contribution — see the header. */
  gain: 0.85,
  /** Magnification per beat. 1.0 is pure fade; above 1.0 is the tunnel, and is stability-clamped. */
  zoomPerBeat: 1.0,
  /** Rotation of the trail, in turns per bar. Small values (±0.05) are a drift; ±0.25 is a visible spin. */
  rotTurnsPerBar: 0,
  /** Translation per bar, in half-widths of the aspect-corrected frame. */
  driftX: 0,
  driftY: 0,
  /**
   * Warp origin in uv. Feedback is art direction §4.1's stated exception to
   * "nothing radiates from the centre" — a centre is the mechanism here, not a
   * decoration — but the exception is not a requirement, and moving the origin
   * off-centre is most of what stops two feedback layers reading as one.
   */
  centreX: 0.5,
  centreY: 0.5,
  /** Soft clip knee. Below it the trail is untouched. */
  clipKnee: 0.8,
  /**
   * Soft clip asymptote. Deliberately close to 1.0: HDR headroom belongs to the
   * focal element (art direction §2.4), and a trail is by definition not it. A
   * feedback layer allowed up to 3.0 is a feedback layer that bloom finds
   * instead of the subject.
   */
  clipCeiling: 1.3,
  /** Border fade width in uv. Below ~0.01 the clamped edge texel starts to streak. */
  edgeFade: 0.03,
};

/** Read a numeric param, clamped, with a default for absent or non-numeric values. */
function num(
  params: Readonly<Record<string, ParamValue>>,
  key: string,
  fallback: number,
  lo: number,
  hi: number,
): number {
  const raw = params[key];
  const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------

/**
 * Everything that decides the bind group layout, declared once.
 *
 * `passBindingsWGSL` needs it before the descriptor can be finished (the
 * descriptor's `code` is what it generates part of), so the shape is hoisted
 * rather than duplicated. Both defaults would already be correct for a
 * `feedback` family — the renderer infers `accumulator` and `history` — but a
 * feedback pass that silently stopped reading one of its two textures would
 * still render, so they are stated.
 */
const SHAPE = {
  type: 'feedback',
  family: 'feedback',
  /** The frame beneath, so a trail can capture what it is trailing. */
  input: 'accumulator',
  /** The layer's own previous output. The recursion. */
  history: true,
  uniformFloats: UNIFORM_FLOATS,
  code: '',
} as const satisfies PassDescriptor;

/**
 * Bind the params block.
 *
 * The binding NUMBER is never typed into the shader — `renderer.ts` owns the
 * layout and a hand-written number is how a shader ends up one binding out of
 * step, which validates cleanly and samples the wrong resource. `passBindingsWGSL`
 * generates the texture and sampler declarations but not this one, so the shader
 * carries a placeholder and it is substituted here.
 *
 * `require` rather than a silent replace: if the placeholder is ever renamed in
 * the .wgsl file, a no-op substitution would leave `PASS_GROUP_PLACEHOLDER` in
 * the source and fail at shader compile time with a message about an unknown
 * identifier, several layers away from the cause.
 */
function bindParams(source: string): string {
  let out = source;
  // Checked one at a time: a single combined comparison would pass while one of
  // the two placeholders was still in the source, which compiles into a shader
  // that fails at module creation for an unrelated-looking reason.
  for (const [token, value] of [
    ['PASS_GROUP_PLACEHOLDER', String(PASS_GROUP)],
    ['PASS_PARAMS_PLACEHOLDER', String(PASS_BINDING.params)],
  ] as const) {
    if (!out.includes(token)) {
      throw new Error(
        `op-feedback.wgsl no longer contains '${token}'. Its uniform block must be ` +
        'declared `@group(PASS_GROUP_PLACEHOLDER) @binding(PASS_PARAMS_PLACEHOLDER)`, ' +
        'never with literal binding numbers — renderer.ts owns the layout.',
      );
    }
    out = out.replace(token, value);
  }
  return out;
}

export const feedbackPass: PassDescriptor = {
  ...SHAPE,
  code: `${PASS_COMMON_WGSL}\n${passBindingsWGSL(SHAPE)}\n${bindParams(shaderBody)}`,

  /**
   * Half res by default. A trail is soft, low-frequency and already blurred by
   * its own bilinear resampling, so it is the single best candidate in the whole
   * stack for §4.11's "default new layers to ½ and promote deliberately" — and
   * the pair of history targets it owns is 30 MB at 2560×1440, which halving
   * turns into 7.5.
   */
  defaultResolutionScale: 0.5,

  /**
   * Convert this frame's musical rates into the shader's per-frame ones.
   *
   * Everything that could be per-frame is derived from `dtBeats`, never from
   * `dtSeconds` directly and never from a frame count. `dtBeats` already carries
   * the live tempo, so a tempo change mid-track needs no recalculation anywhere
   * (plan §4.10) and a fixed-timestep golden run reproduces exactly (§4.7).
   *
   * When the transport is paused `dtBeats` is 0, and every derived value
   * collapses to identity: keep = 1, inject = 0, zoom = 1, rot = 0. The trail
   * holds untouched, which is precisely what §4.10 specifies for pause, and it
   * falls out of the arithmetic rather than needing a branch.
   */
  writeUniforms(out: Float32Array, ctx: PassContext): void {
    const p = ctx.params;

    const dtRaw = Number.isFinite(ctx.dtBeats) ? ctx.dtBeats : 0;
    const dtBeats = dtRaw <= 0 ? 0 : Math.min(dtRaw, MAX_DT_BEATS);

    const tauBeats = num(p, 'tauBeats', 1.5, 0.05, 64);
    const keep = Math.exp(-dtBeats / tauBeats);

    // Steady state, not per-frame contribution. See the file header, twice.
    const gain = num(p, 'gain', 0.85, 0, 4);
    const inject = gain * (1 - keep) * ctx.opacity;

    // Stability bound: zoom_beat < exp(1 / (2 * tauBeats)). Derived in the
    // header; the safety factor keeps us off the boundary, where the steady
    // state is finite but useless.
    const zoomLimit = Math.exp(ZOOM_SAFETY / (2 * tauBeats));
    const zoomBeat = Math.min(num(p, 'zoomPerBeat', 1, 0.25, 4), zoomLimit);
    const zoom = dtBeats === 0 ? 1 : Math.pow(zoomBeat, dtBeats);

    // Bars, not beats, for the two rates a viewer perceives as travel rather
    // than as pulse — a rotation locked to the bar phrases with the music
    // instead of ticking with it (art direction §3.3).
    const barFraction = dtBeats / 4;
    const rot = num(p, 'rotTurnsPerBar', 0, -4, 4) * TWO_PI * barFraction;
    const driftX = num(p, 'driftX', 0, -2, 2) * barFraction;
    const driftY = num(p, 'driftY', 0, -2, 2) * barFraction;

    const knee = num(p, 'clipKnee', 0.8, 0, 4);
    // The ceiling is forced above the knee. Equal or inverted values would make
    // the roll-off head negative and every bright pixel would come back dark,
    // which looks like a solarise rather than a limiter.
    const ceiling = Math.max(num(p, 'clipCeiling', 1.3, 0, 8), knee + 0.05);

    out[U_KEEP] = keep;
    out[U_INJECT] = inject;
    out[U_ZOOM] = zoom;
    out[U_ROT] = rot;
    out[U_OFFSET] = driftX;
    out[U_OFFSET + 1] = driftY;
    out[U_CENTRE] = num(p, 'centreX', 0.5, -1, 2);
    out[U_CENTRE + 1] = num(p, 'centreY', 0.5, -1, 2);
    out[U_KNEE] = knee;
    out[U_CEILING] = ceiling;
    // Clamped away from zero: `smoothstep` is undefined when edge0 >= edge1,
    // and the shader fades the border with smoothstep(0, edge, d).
    out[U_EDGE] = num(p, 'edgeFade', 0.03, 0.002, 0.5);
    out[U_ASPECT] = ctx.aspect;
  },
};
