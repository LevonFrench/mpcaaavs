// The mirrored-butterfly source's registration (plan §8.2). Look: GRID.
//
// Describes the pass and packs its params; the drawing argument — low
// frequencies at the centre line, upper wing from L and lower from R — is in
// `src-butterfly.wgsl`. No device, no buffer, no pipeline; see `scope.ts`.
//
// Same frequency-axis convention as `spectrum.ts` and `radialbars.ts`: the
// shader wants NORMALISED frequency (0 = DC, 1 = Nyquist) because that is what
// `fftAt`/`fftStereoAt` take, and no `PassContext` carries a sample rate.
//
// Nothing here moves on its own. The layer has one motion — the wings — and it
// belongs to the audio; a butterfly that also drifts or breathes is two
// competing motions in one source (§3.4), and the second one would have to come
// from somewhere, which in practice means a wall clock.

import { AUDIO_WGSL } from '../audiogpu.ts';
import type { ParamValue, PassContext, PassDescriptor } from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP } from '../renderer.ts';
import body from '../shaders/src-butterfly.wgsl';

/** See the identical note in `scope.ts` — the binding number is generated, never typed. */
const PARAMS_WGSL = `@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> P : Params;`;

/** Field order. Must match `struct Params` in `src-butterfly.wgsl` float for float. */
const F_GAIN = 0;
const F_GAMMA = 1;
const F_LO = 2;
const F_HI = 3;
const F_SPAN = 4;
const F_SPREAD = 5;
const F_CENTRE_Y = 6;
const F_CAP_HALF = 7;
const F_BODY_LEVEL = 8;
const F_CAP_LEVEL = 9;
const F_STEREO = 10;
const F_WEIGHT_VAR = 11;
const PARAM_FLOATS = 12;

/** As `spectrum.ts`: ~31 Hz to ~15.4 kHz at 48 kHz. Shared so two spectrum layers agree. */
const DEFAULT_LO = 0.0013;
const DEFAULT_HI = 0.64;

export const butterflyPass: PassDescriptor = {
  type: 'butterfly',
  family: 'source',
  input: 'none',
  usesAudio: true,
  code: [PASS_COMMON_WGSL, AUDIO_WGSL, PARAMS_WGSL, body].join('\n'),

  // Fullscreen geometry, issued as a vertex count so progress 0 draws literally
  // nothing (Phase 5 DoD).
  draw: {
    kind: 'vertices',
    vertexCount: (ctx) => (ctx.progress > 0 ? 3 : 0),
  },

  /** The contour is a thin analytic edge defined in attachment pixels; see `scope.ts`. */
  defaultResolutionScale: 1,

  uniformFloats: PARAM_FLOATS,
  writeUniforms(out: Float32Array, ctx: PassContext): void {
    const p = ctx.params;
    out[F_GAIN] = num(p, 'gain', 1.6);
    // Below 1: magnitude is not perceptual, and a linear mapping collapses the
    // wings into a flat line with a spike at the body.
    out[F_GAMMA] = Math.max(num(p, 'gamma', 0.62), 1e-3);
    const lo = clamp(num(p, 'fLo', DEFAULT_LO), 1e-5, 0.98);
    out[F_LO] = lo;
    out[F_HI] = clamp(num(p, 'fHi', DEFAULT_HI), lo * 1.01, 1);
    // Each wing reaches a fifth of the frame at full scale, so both together are
    // 40% and the sky above and below is the other 60% — grid wants ~50%
    // negative space and this composition has two horizons to keep clear (§1.2).
    out[F_SPAN] = clamp(num(p, 'span', 0.2), 0, 0.5);
    out[F_SPREAD] = clamp(num(p, 'spread', 0.92), 0.05, 1);
    out[F_CENTRE_Y] = clamp(num(p, 'centreY', 0.5), 0, 1);
    out[F_CAP_HALF] = Math.max(num(p, 'capThickness', 0.0035), 1e-4);
    out[F_BODY_LEVEL] = Math.max(num(p, 'bodyLevel', 0.4), 0);
    // The contour is the brightest thing the layer draws and the only part with
    // any claim on HDR headroom — which it only gets if the palette slot already
    // has it (§2.4).
    out[F_CAP_LEVEL] = Math.max(num(p, 'capLevel', 1), 0);
    // 1 = upper wing is L, lower is R. Mono material draws a symmetric moth
    // either way; this is what makes wide material breathe asymmetrically
    // instead of being mirrored decoration. 0 restores the plain mirror.
    out[F_STEREO] = clamp(num(p, 'stereo', 1), 0, 1);
    // Heavier contour at the body than at the tips. Uniform stroke width reads
    // flat and machine-drawn (§4.4).
    out[F_WEIGHT_VAR] = clamp(num(p, 'weightVar', 1.4), 0, 6);
  },
};

function num(p: Readonly<Record<string, ParamValue>>, key: string, fallback: number): number {
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
