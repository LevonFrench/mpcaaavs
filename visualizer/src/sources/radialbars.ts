// The radial-bars source's registration (plan §8.2). Look: GRID.
//
// Describes the pass and packs its params; the drawing argument is in
// `src-radialbars.wgsl`. No device, no buffer, no pipeline — see `scope.ts` for
// the full statement of why that matters.
//
// It shares the frequency-axis convention with `spectrum.ts`: the shader wants
// NORMALISED frequency (0 = DC, 1 = Nyquist) because that is what `fftAt` takes,
// and no `PassContext` carries a sample rate, so the axis is a fraction of
// Nyquist with the Hz equivalents written down for the common case.
//
// It deliberately does NOT expose a "radius pulses with the level" param.
// A ring that grows on every kick is exactly art-direction §4.1's centred radial
// pulse — the ring HAS a centre by construction, which is fine, but adding
// centre-out motion on top of it is the anti-pattern the document names.

import { AUDIO_WGSL } from '../audiogpu.ts';
import type { ParamValue, PassContext, PassDescriptor } from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP } from '../renderer.ts';
import body from '../shaders/src-radialbars.wgsl';

/** See the identical note in `scope.ts` — the binding number is generated, never typed. */
const PARAMS_WGSL = `@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> P : Params;`;

/** Field order. Must match `struct Params` in `src-radialbars.wgsl` float for float. */
const F_BARS = 0;
const F_GAIN = 1;
const F_GAMMA = 2;
const F_LO = 3;
const F_HI = 4;
const F_GAP = 5;
const F_INNER = 6;
const F_REACH = 7;
const F_CENTRE_X = 8;
const F_CENTRE_Y = 9;
const F_CAP_HALF = 10;
const F_BODY_LEVEL = 11;
const F_CAP_LEVEL = 12;
const F_WEIGHT_VAR = 13;
const F_SWEEP = 14;
const F_SPIN = 15;
const PARAM_FLOATS = 16;

/**
 * Default axis, as a fraction of Nyquist. At 48 kHz these are ~31 Hz and
 * ~15.4 kHz. Identical to `spectrum.ts` on purpose: two spectrum layers in one
 * preset that disagree about where the axis starts read as two unrelated
 * instruments rather than as two views of one signal.
 *
 * The bottom cannot be zero — the axis is geometric and a ratio to zero has no
 * logarithm. A preset that sets `fLo` to 0 gets the clamp back.
 */
const DEFAULT_LO = 0.0013;
const DEFAULT_HI = 0.64;

export const radialBarsPass: PassDescriptor = {
  type: 'radialbars',
  family: 'source',
  // A source draws INTO the accumulator, so it cannot sample it.
  input: 'none',
  usesAudio: true,
  code: [PASS_COMMON_WGSL, AUDIO_WGSL, PARAMS_WGSL, body].join('\n'),

  // Fullscreen geometry, issued as a vertex count so progress 0 draws literally
  // nothing (Phase 5 DoD). The vertex shader is still `fullscreenTriangle`.
  draw: {
    kind: 'vertices',
    vertexCount: (ctx) => (ctx.progress > 0 ? 3 : 0),
  },

  /** Analytic wedge and cap edges are defined in attachment pixels; see `scope.ts`. */
  defaultResolutionScale: 1,

  uniformFloats: PARAM_FLOATS,
  writeUniforms(out: Float32Array, ctx: PassContext): void {
    const p = ctx.params;
    // 64 wedges over a ~9-octave axis is ~7 per octave — coarse enough that a
    // wedge is several pixels wide at the inner radius, fine enough to read as
    // pitch. More cells than there are pixels at `inner` is a moire pattern.
    out[F_BARS] = Math.max(1, Math.round(num(p, 'bars', 64)));
    out[F_GAIN] = num(p, 'gain', 1.6);
    // Below 1: magnitude is not perceptual, and a linear mapping leaves the ring
    // a thin fringe with four spikes on it.
    out[F_GAMMA] = Math.max(num(p, 'gamma', 0.62), 1e-3);
    const lo = clamp(num(p, 'fLo', DEFAULT_LO), 1e-5, 0.98);
    out[F_LO] = lo;
    out[F_HI] = clamp(num(p, 'fHi', DEFAULT_HI), lo * 1.01, 1);
    out[F_GAP] = clamp(num(p, 'gap', 0.34), 0, 0.95);
    // The inner radius is the whole reason this reads as a ring rather than as a
    // disc — see the shader header. Floored well above zero deliberately: a
    // preset that sets it to 0 is asking for 64 wedges to meet at a point.
    out[F_INNER] = clamp(num(p, 'innerRadius', 0.26), 0.04, 1.5);
    out[F_REACH] = Math.max(num(p, 'reach', 0.34), 0);
    // Off-centre by default. Art-direction §4.1: a radial SOURCE has a centre by
    // construction and that is legitimate, but pinning it to the middle of the
    // frame is what makes it read as a pulse from the middle. A preset that
    // wants it dead centre sets these to 0.
    out[F_CENTRE_X] = num(p, 'centreX', -0.18);
    out[F_CENTRE_Y] = num(p, 'centreY', 0.06);
    out[F_CAP_HALF] = Math.max(num(p, 'capThickness', 0.008), 1e-4);
    out[F_BODY_LEVEL] = Math.max(num(p, 'bodyLevel', 0.55), 0);
    // The cap is the brightest thing the layer draws and the only part with any
    // claim on HDR headroom — which it only gets if the layer's palette slot
    // already has it. Art-direction §2.4 keeps that decision in the palette.
    // Set to 0 to turn peak-hold off entirely.
    out[F_CAP_LEVEL] = Math.max(num(p, 'capLevel', 1), 0);
    // Bass wedges heavier than treble ones. Uniform stroke width reads flat and
    // machine-drawn (§4.4); 0 restores it for a preset that wants the clock face.
    out[F_WEIGHT_VAR] = clamp(num(p, 'weightVar', 0.6), 0, 1.8);
    // Under a full turn, so the top of the axis is not hard against the bottom
    // of it. See the shader header — the gap is what makes the seam read as the
    // end of a scale instead of as a glitch.
    out[F_SWEEP] = clamp(num(p, 'sweep', 0.93), 0.05, 1);
    // Rotation on a clock division, never on wall-clock seconds (§3.1). The
    // fractional part is taken BEFORE scaling so the angle never grows large
    // enough for f32 to lose the low bits of a slow spin. Bars, not beats: this
    // is travel, and travel phrases (§3.3).
    const spinBars = Math.max(num(p, 'spinBars', 32), 1e-3);
    out[F_SPIN] = fract(ctx.bars / spinBars) * Math.PI * 2;
  },
};

function num(p: Readonly<Record<string, ParamValue>>, key: string, fallback: number): number {
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Positive fractional part. `%` keeps the sign of the dividend and bars can be negative on a pre-roll. */
function fract(v: number): number {
  return v - Math.floor(v);
}
