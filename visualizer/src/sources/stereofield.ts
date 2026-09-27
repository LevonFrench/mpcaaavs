// The stereo-field scope's registration (plan §6, §8.2). Look: LAB.
//
// Describes the pass and packs its params; the drawing argument — x = pan,
// y = log frequency, weight = magnitude — is in `src-stereofield.wgsl`. No
// device, no buffer, no pipeline; see `scope.ts`.
//
// This is the only layer in the project that reads `audioPan`, and that is the
// point: Phase 0 computed `(L-R)/(L+R)` per BIN and until now nothing consumed
// it, so the buffer, its upload and its accessor were all untested. A layer that
// draws the whole array is the cheapest possible proof that the data path works
// — if the pan buffer were stale, mis-indexed or all zeros, this reads as a
// dead straight line down the middle of the frame and nothing else does.
//
// Same frequency-axis convention as `spectrum.ts`: normalised frequency, a
// fraction of Nyquist, because no `PassContext` carries a sample rate.
//
// Nothing here moves on its own — no spin, no drift, no wall clock. An
// instrument that animates is an instrument you cannot read, and the axes have
// to stay put for the filament's motion to mean anything (§3.4).

import { AUDIO_WGSL } from '../audiogpu.ts';
import type { ParamValue, PassContext, PassDescriptor } from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP } from '../renderer.ts';
import body from '../shaders/src-stereofield.wgsl';

/** See the identical note in `scope.ts` — the binding number is generated, never typed. */
const PARAMS_WGSL = `@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> P : Params;`;

/** Field order. Must match `struct Params` in `src-stereofield.wgsl` float for float. */
const F_GAIN = 0;
const F_GAMMA = 1;
const F_LO = 2;
const F_HI = 3;
const F_SPREAD = 4;
const F_HALF_WIDTH = 5;
const F_WIDTH_VAR = 6;
const F_BODY_LEVEL = 7;
const F_FILL_LEVEL = 8;
const F_AXIS_LEVEL = 9;
const F_PEAK_LEVEL = 10;
const F_GATE = 11;
const PARAM_FLOATS = 12;

/** As `spectrum.ts`: ~31 Hz to ~15.4 kHz at 48 kHz. Shared so two spectrum layers agree. */
const DEFAULT_LO = 0.0013;
const DEFAULT_HI = 0.64;

export const stereoFieldPass: PassDescriptor = {
  type: 'stereofield',
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

  /**
   * Full resolution, and this one means it more than its siblings: the stroke is
   * a few thousandths of the frame wide and its antialiasing is defined in
   * attachment pixels, so a half-res pass is a half-res hairline bilinearly
   * smeared back up — which is precisely the 2003 look §4.5 rejects. Advisory
   * only; §4.11 says the scale is a budget decision and the budget belongs to
   * the show.
   */
  defaultResolutionScale: 1,

  uniformFloats: PARAM_FLOATS,
  writeUniforms(out: Float32Array, ctx: PassContext): void {
    const p = ctx.params;
    out[F_GAIN] = num(p, 'gain', 1.8);
    // Below 1: magnitude is not perceptual, and here it drives WEIGHT as well as
    // brightness, so a linear mapping leaves the whole filament a hairline until
    // something clips.
    out[F_GAMMA] = Math.max(num(p, 'gamma', 0.55), 1e-3);
    const lo = clamp(num(p, 'fLo', DEFAULT_LO), 1e-5, 0.98);
    out[F_LO] = lo;
    out[F_HI] = clamp(num(p, 'fHi', DEFAULT_HI), lo * 1.01, 1);
    // A full pan reaches 80% of the way to the frame edge, not 100%: a filament
    // that touches the edge cannot be told from one that has been clipped by it,
    // and hard-panned content is exactly what this layer exists to show.
    out[F_SPREAD] = clamp(num(p, 'spread', 0.8), 0.05, 1);
    out[F_HALF_WIDTH] = Math.max(num(p, 'thickness', 0.0022), 1e-5) * 0.5;
    // Magnitude as WEIGHT, which is the layer's one idea (§4.4). At 0 this
    // becomes a uniform hairline and loses most of what makes it readable.
    out[F_WIDTH_VAR] = Math.max(num(p, 'widthVar', 6), 0);
    out[F_BODY_LEVEL] = Math.max(num(p, 'bodyLevel', 1), 0);
    // Low by default. Lab is 80%+ negative space (§1.1) and the fill is the
    // first thing that would eat it.
    out[F_FILL_LEVEL] = Math.max(num(p, 'fillLevel', 0.1), 0);
    out[F_AXIS_LEVEL] = Math.max(num(p, 'axisLevel', 0.08), 0);
    out[F_PEAK_LEVEL] = Math.max(num(p, 'peakLevel', 0.22), 0);
    // Silent bins have a pan of whatever 0/0 resolved to. Drawing them puts a
    // meaningless line through the quiet half of the frame, which is the one
    // failure that would make this look like noise rather than measurement.
    out[F_GATE] = clamp(num(p, 'gate', 0.05), 0, 0.9);
  },
};

function num(p: Readonly<Record<string, ParamValue>>, key: string, fallback: number): number {
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
