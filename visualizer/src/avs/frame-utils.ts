/**
 * Pure per-frame helpers shared by the live AVS worker client and the offline
 * render worker, so both lanes feed and composite AVS frames the same way.
 *
 * Nothing in the AVS runtime imports this file: it only prepares the 576-point
 * PCM window a runtime consumes and mixes packed frames a runtime produced, so
 * it cannot move a compatibility pixel.
 */

/** AVS's fixed per-channel PCM window. */
export const AVS_PCM_SAMPLES = 576;

/**
 * THE rounding convention for decimating `frames` source samples into AVS's
 * 576-point window: nearest-lower source sample, `trunc(i * frames / 576)`,
 * clamped to the last sample. This is the live worker client's historical
 * formula and is authoritative for both lanes. The offline lane's former
 * `sampleStart + trunc(i * available / 576)` computes the identical index for
 * every nonempty interval (and offline intervals are never empty), so adopting
 * this did not change any offline byte.
 */
export function avsPcmSourceIndex(i: number, frames: number): number {
  return Math.min(frames - 1, Math.trunc(i * frames / AVS_PCM_SAMPLES));
}

/**
 * Resample an interleaved stereo waveform into AVS's two 576-sample channels,
 * packed as [left 0..575, right 0..575]. A missing right sample repeats the
 * left one; an empty waveform yields silence.
 */
export function fillAvsPcm(waveform: Float32Array, pcm: Float32Array): void {
  if (pcm.length !== AVS_PCM_SAMPLES * 2) {
    throw new RangeError(`AVS PCM buffer must contain ${AVS_PCM_SAMPLES * 2} samples`);
  }
  const frames = Math.max(1, Math.trunc(waveform.length / 2));
  for (let i = 0; i < AVS_PCM_SAMPLES; i++) {
    const source = avsPcmSourceIndex(i, frames);
    const left = waveform[source * 2] ?? 0;
    pcm[i] = left;
    pcm[AVS_PCM_SAMPLES + i] = waveform[source * 2 + 1] ?? left;
  }
}

/**
 * The same window over planar channels restricted to `[sampleStart,
 * sampleEnd)`: exactly `fillAvsPcm` applied to the interleaved copy of that
 * interval. An empty interval yields silence (as `fillAvsPcm` does for an
 * empty waveform).
 */
export function fillAvsPcmPlanar(
  left: Float32Array,
  right: Float32Array,
  sampleStart: number,
  sampleEnd: number,
  pcmLeft: Float32Array,
  pcmRight: Float32Array,
): void {
  if (pcmLeft.length !== AVS_PCM_SAMPLES || pcmRight.length !== AVS_PCM_SAMPLES) {
    throw new RangeError(`AVS PCM channels must contain ${AVS_PCM_SAMPLES} samples each`);
  }
  const frames = Math.max(0, sampleEnd - sampleStart);
  if (frames === 0) {
    pcmLeft.fill(0);
    pcmRight.fill(0);
    return;
  }
  for (let i = 0; i < AVS_PCM_SAMPLES; i++) {
    const source = sampleStart + avsPcmSourceIndex(i, frames);
    const sample = left[source] ?? 0;
    pcmLeft[i] = sample;
    pcmRight[i] = right[source] ?? sample;
  }
}

/** Crossfade position quantised to the 0..256 integer alpha both blends use. */
export function crossfadeAlpha256(mix: number): number {
  return Math.max(0, Math.min(256, Math.round(mix * 256)));
}

/**
 * Integer crossfade of packed 0x00RRGGBB frames on 8-bit sRGB code values:
 * `(from * (256 - a) + to * a) >> 8` per channel. The offline default
 * ('srgb-integer'); its bytes are part of the offline pixel ledger.
 */
export function blendPackedRgb(from: Uint32Array, to: Uint32Array, mix: number, output: Uint32Array): void {
  const alpha = crossfadeAlpha256(mix);
  const inverse = 256 - alpha;
  for (let i = 0; i < output.length; i++) {
    const a = from[i]!;
    const b = to[i]!;
    const r = (((a >>> 16) * inverse + (b >>> 16) * alpha) >>> 8) & 0xff;
    const g = ((((a >>> 8) & 0xff) * inverse + ((b >>> 8) & 0xff) * alpha) >>> 8) & 0xff;
    const blue = (((a & 0xff) * inverse + (b & 0xff) * alpha) >>> 8) & 0xff;
    output[i] = (r << 16) | (g << 8) | blue;
  }
}

let srgbToLinear: Float32Array | null = null;
let linearToSrgb: Uint8Array | null = null;
const LINEAR_LUT_MAX = 65_535;

/**
 * Opt-in linear-light crossfade. Uses the same quantized alpha as the default
 * blend; decodes sRGB through a 256-entry LUT, mixes, and re-encodes through a
 * 16-bit LUT with round-to-nearest, which round-trips every 8-bit code exactly.
 */
export function blendPackedRgbLinearLight(from: Uint32Array, to: Uint32Array, mix: number, output: Uint32Array): void {
  if (!srgbToLinear || !linearToSrgb) {
    srgbToLinear = new Float32Array(256);
    for (let code = 0; code < 256; code++) {
      const v = code / 255;
      srgbToLinear[code] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }
    linearToSrgb = new Uint8Array(LINEAR_LUT_MAX + 1);
    for (let i = 0; i <= LINEAR_LUT_MAX; i++) {
      const l = i / LINEAR_LUT_MAX;
      const v = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
      linearToSrgb[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
  }
  const decode = srgbToLinear;
  const encode = linearToSrgb;
  const alpha = crossfadeAlpha256(mix) / 256;
  const inverse = 1 - alpha;
  const scale = LINEAR_LUT_MAX;
  for (let i = 0; i < output.length; i++) {
    const a = from[i]!;
    const b = to[i]!;
    const r = encode[((decode[(a >>> 16) & 0xff]! * inverse + decode[(b >>> 16) & 0xff]! * alpha) * scale + .5) | 0]!;
    const g = encode[((decode[(a >>> 8) & 0xff]! * inverse + decode[(b >>> 8) & 0xff]! * alpha) * scale + .5) | 0]!;
    const blue = encode[((decode[a & 0xff]! * inverse + decode[b & 0xff]! * alpha) * scale + .5) | 0]!;
    output[i] = (r << 16) | (g << 8) | blue;
  }
}
