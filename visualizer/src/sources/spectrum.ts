// The spectrum source's registration (plan §8.2). Look: GRID.
//
// Describes the pass and packs its params; the drawing argument is in
// `src-spectrum.wgsl`. No device, no buffer, no pipeline — see `scope.ts` for the
// full statement of why that matters.
//
// The one non-obvious job this file has is the frequency axis. The shader wants
// NORMALISED frequency (0 = DC, 1 = Nyquist) because that is what `fftAt` takes,
// but a preset should be able to say "20 Hz to 16 kHz" and mean it. The
// conversion needs the sample rate, which no pass context carries, so the axis is
// expressed as a fraction of Nyquist with the Hz equivalents written down here
// for the common case. If a sample rate ever reaches `PassContext`, this is the
// place that should start using it.

import { AUDIO_WGSL } from '../audiogpu.ts';
import type { ParamValue, PassContext, PassDescriptor } from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP } from '../renderer.ts';
import body from '../shaders/src-spectrum.wgsl';

/** See the identical note in `scope.ts` — the binding number is generated, never typed. */
const PARAMS_WGSL = `@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> P : Params;`;

/** Field order. Must match `struct Params` in `src-spectrum.wgsl` float for float. */
const F_MODE = 0;
const F_BARS = 1;
const F_GAIN = 2;
const F_GAMMA = 3;
const F_LO = 4;
const F_HI = 5;
const F_GAP = 6;
const F_PAN = 7;
const F_CAP_HALF = 8;
const F_BODY_LEVEL = 9;
const F_CAP_LEVEL = 10;
const F_HEIGHT = 11;
// --- LED ladder, orthogonal to `mode` and to `bars` -------------------------
// Deliberately its own axis: 16 dots and 64 capsules are both reachable without
// a new mode, which is what "mix and match" has to mean to be worth having.
const F_SEGMENTS = 12;
const F_SEG_GAP = 13;
const F_LED_OFF = 14;
const F_LED_STYLE = 15;
// --- peak, drivable independently of the bar --------------------------------
const F_PEAK_GLOW = 16;
const F_PEAK_PULSE = 17;
// 20 floats = 80 bytes. WGSL requires the struct to be a multiple of 16.
const PARAM_FLOATS = 20;

/** Lamp shapes. Combine freely with any `bars` count. */
const LED_STYLES = [
  'solid',
  'segment',
  'dot',
  'capsule',
  'vu',
  'diamond',
  'matrix',
  'split',
] as const;

/** Band counts a preset is likely to want. Any number works; these are handy. */
export const BAND_COUNTS = [16, 24, 32, 48, 64] as const;

const MODES = ['bars', 'ribbon'] as const;

/**
 * Default axis, as a fraction of Nyquist. At 48 kHz these are ~31 Hz and
 * ~15.4 kHz — low enough to include the fundamental of a kick, high enough to
 * include hats, and nothing above where the spectrum is mostly dither.
 *
 * The bottom of the axis is NOT zero and cannot be: the axis is geometric, and a
 * ratio to zero has no logarithm. A preset that sets `fLo` to 0 gets this back.
 */
const DEFAULT_LO = 0.0013;
const DEFAULT_HI = 0.64;

export const spectrumPass: PassDescriptor = {
  type: 'spectrum',
  family: 'source',
  input: 'none',
  usesAudio: true,
  code: [PASS_COMMON_WGSL, AUDIO_WGSL, PARAMS_WGSL, body].join('\n'),

  // Fullscreen geometry, but issued as a vertex count so that progress 0 draws
  // literally nothing (Phase 5 DoD). The vertex shader is still
  // `fullscreenTriangle`; only the count is conditional.
  draw: {
    kind: 'vertices',
    vertexCount: (ctx) => (ctx.progress > 0 ? 3 : 0),
  },

  /** Analytic bar and cap edges are defined in attachment pixels; see `scope.ts`. */
  defaultResolutionScale: 1,

  uniformFloats: PARAM_FLOATS,
  writeUniforms(out: Float32Array, ctx: PassContext): void {
    const p = ctx.params;
    out[F_MODE] = MODES.indexOf(mode(p, 'mode', 'bars'));
    // 48 cells is four octaves at one per semitone, which is the resolution at
    // which bars still read as pitch rather than as texture. More cells than
    // there are pixels per cell is a moire pattern, not a spectrum.
    out[F_BARS] = Math.max(1, Math.round(num(p, 'bars', 48)));
    // 1.0, NOT the 1.6 this shipped with.
    //
    // `shape()` clamps pow(m*gain, gamma) to 1 before scaling by `height`, so
    // gain 1.6 clamps every bin above m = 0.625 and renders all of them at the
    // SAME height. Measured against real music the bin distribution is
    // median 0.47, p75 0.56, p95 0.67 — so a quarter to a half of the frame sat
    // on the clamp and the bars read as maxed out and unreactive. At gain 1.0
    // the same distribution maps to 0.62 / 0.71 / 0.78 with nothing clamped,
    // and gamma alone does the shaping it was there to do.
    out[F_GAIN] = num(p, 'gain', 1.0);
    // Below 1: magnitude is not perceptual, and a linear mapping puts everything
    // interesting in the bottom fifth of the frame.
    out[F_GAMMA] = Math.max(num(p, 'gamma', 0.62), 1e-3);
    const lo = clamp(num(p, 'fLo', DEFAULT_LO), 1e-5, 0.98);
    out[F_LO] = lo;
    out[F_HI] = clamp(num(p, 'fHi', DEFAULT_HI), lo * 1.01, 1);
    out[F_GAP] = clamp(num(p, 'gap', 0.32), 0, 0.95);
    // 0 pins the cells to a fixed grid; 1 lets a band slide a whole cell towards
    // its own stereo position (plan §6). Off by default — it is a striking
    // effect on wide material and pure noise on a mono mix.
    out[F_PAN] = clamp(num(p, 'pan', 0), 0, 1);
    out[F_CAP_HALF] = Math.max(num(p, 'capThickness', 0.006), 1e-4);
    out[F_BODY_LEVEL] = Math.max(num(p, 'bodyLevel', 0.55), 0);
    // The cap is the brightest thing the layer draws and the only part with any
    // claim on HDR headroom — which it only gets if the layer's palette slot
    // already has it. Art-direction §2.4 keeps that decision in the palette, not
    // here. Set to 0 to turn peak-hold off entirely.
    out[F_CAP_LEVEL] = Math.max(num(p, 'capLevel', 1), 0);
    // Bars reach under half the frame by default. Grid wants ~50% negative
    // space and the sky is where it lives (art-direction §1.2).
    out[F_HEIGHT] = clamp(num(p, 'height', 0.42), 0, 1);

    // 12 rows is the classic hi-fi ladder. Enough to read as discrete, few
    // enough that each lamp is a real target at 16 bands.
    out[F_SEGMENTS] = Math.max(1, Math.round(num(p, 'segments', 12)));
    out[F_SEG_GAP] = clamp(num(p, 'segGap', 0.32), 0, 0.95);
    // The UNLIT lamp level. This is the whole illusion — a ladder that draws
    // only its lit rows reads as a bar chart with gaps, not as hardware.
    out[F_LED_OFF] = clamp(num(p, 'ledOff', 0.1), 0, 1);
    const style = String(p['ledStyle'] ?? 'solid');
    const si = LED_STYLES.indexOf(style as (typeof LED_STYLES)[number]);
    out[F_LED_STYLE] = si < 0 ? 0 : si;

    out[F_PEAK_GLOW] = Math.max(num(p, 'peakGlow', 0), 0);
    out[F_PEAK_PULSE] = clamp(num(p, 'peakPulse', 0), 0, 1);
  },
};

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

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
