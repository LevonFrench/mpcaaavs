import {
  AVS_AUDIO_SAMPLES,
  AVS_FFT_BINS,
  AVS_FFT_SIZE,
  type AvsAudioFrame,
} from './types.ts';

export interface AvsStereoPcm {
  readonly left: Float32Array;
  readonly right?: Float32Array;
}

/** Stateful reproduction of AVS's default amplitude-transient beat detector. */
export class AvsBeatDetector {
  private slowPeak = 0;
  private fastPeak = 0;
  private lastTriggerPeak = 0;

  reset(): void {
    this.slowPeak = 0;
    this.fastPeak = 0;
    this.lastTriggerPeak = 0;
  }

  update(waveform: readonly [Uint8Array, Uint8Array]): { beat: boolean; level: number } {
    let left = 0;
    let right = 0;
    for (let i = 0; i < AVS_AUDIO_SAMPLES; i++) {
      left += Math.abs(signedByte(waveform[0][i]!));
      right += Math.abs(signedByte(waveform[1][i]!));
    }
    const level = Math.max(left, right);
    this.slowPeak = (125 * this.slowPeak + 3 * this.fastPeak) / 128;
    const beat = level >= (34 / 32) * this.slowPeak && level > AVS_AUDIO_SAMPLES * 16;
    if (beat) {
      this.slowPeak = (level + this.lastTriggerPeak) * 0.5;
      this.lastTriggerPeak = level;
    } else {
      // AVS only advances/decays the fast peak on a non-triggering callback.
      // Updating it before this branch subtly raises the baseline after hits.
      this.fastPeak = Math.max(level, this.fastPeak * 14 / 16);
    }
    return { beat, level };
  }
}

/**
 * Winamp-host-compatible adapter that produces the byte-domain arrays consumed
 * by classic AVS. AVS itself receives these arrays from the visualization host;
 * the FFT/windowing here reproduces the open Winamp host implementation.
 *
 * The transform intentionally follows Winamp's visualization host instead of
 * Web Audio's AnalyserNode: signed PCM high bytes, DC blocking, a 512-sample
 * Hann window, a real FFT, inter-bin averaging, and AVS's logarithmic remap.
 */
export class AvsAudioAnalyser {
  private readonly beat = new AvsBeatDetector();

  reset(): void {
    this.beat.reset();
  }

  analyse(pcm: AvsStereoPcm): AvsAudioFrame {
    if (pcm.left.length < AVS_AUDIO_SAMPLES) {
      throw new RangeError(`AVS audio analysis needs ${AVS_AUDIO_SAMPLES} PCM frames`);
    }
    const right = pcm.right ?? pcm.left;
    if (right.length < AVS_AUDIO_SAMPLES) {
      throw new RangeError(`AVS right channel needs ${AVS_AUDIO_SAMPLES} PCM frames`);
    }

    const waveform = [pcmBytes(pcm.left), pcmBytes(right)] as const;
    const spectrum = [
      spectrumBytes(waveform[0]),
      spectrumBytes(waveform[1]),
    ] as const;
    const hit = this.beat.update(waveform);
    return { waveform, spectrum, beat: hit.beat, beatLevel: hit.level };
  }
}

/** AVS's nonlinear post-FFT byte mapping, exported for fixtures/importers. */
export function avsLogSpectrumByte(value: number): number {
  const x = clamp(value, 0, 255);
  return clamp(Math.floor(255 * Math.log(1 + 60 * x / 255) / Math.log(60)), 0, 255);
}

/**
 * The bridge between host callbacks and AVS render frames. Spectrum callbacks
 * are log-mapped and max-held until consumed; waveform is latest-copy. This is
 * why a short spectral hit between two video frames is still visible.
 */
export class AvsAudioAccumulator {
  private readonly waveform = [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)] as const;
  private readonly spectrum = [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)] as const;
  private readonly beat = new AvsBeatDetector();
  private beatLatched = false;
  private beatLevel = 0;

  push(
    waveform: readonly [Uint8Array, Uint8Array],
    spectrum: readonly [Uint8Array, Uint8Array],
  ): void {
    validateHostFrame(waveform, 'waveform');
    validateHostFrame(spectrum, 'spectrum');
    for (let channel = 0; channel < 2; channel++) {
      this.waveform[channel]!.set(waveform[channel]!);
      const held = this.spectrum[channel]!;
      const incoming = spectrum[channel]!;
      for (let i = 0; i < AVS_AUDIO_SAMPLES; i++) {
        const mapped = avsLogSpectrumByte(incoming[i]!);
        if (mapped > held[i]!) held[i] = mapped;
      }
    }
    const hit = this.beat.update(waveform);
    this.beatLatched ||= hit.beat;
    this.beatLevel = hit.level;
  }

  consume(): AvsAudioFrame {
    const waveform = [this.waveform[0].slice(), this.waveform[1].slice()] as const;
    const spectrum = [this.spectrum[0].slice(), this.spectrum[1].slice()] as const;
    const frame = { waveform, spectrum, beat: this.beatLatched, beatLevel: this.beatLevel };
    this.spectrum[0].fill(0);
    this.spectrum[1].fill(0);
    this.beatLatched = false;
    return frame;
  }

  reset(): void {
    this.waveform[0].fill(0); this.waveform[1].fill(0);
    this.spectrum[0].fill(0); this.spectrum[1].fill(0);
    this.beat.reset(); this.beatLatched = false; this.beatLevel = 0;
  }
}

/** EEL getosc/getspec channel numbering: 0=center, 1=left, 2=right. */
export function avsAudioSample(
  frame: AvsAudioFrame,
  kind: 'osc' | 'spec',
  band: number,
  width: number,
  channelValue: number,
): number {
  const channel = Math.floor(channelValue + 0.5);
  if (channel < 0 || channel > 2) return 0;
  let centre = Math.trunc(band * AVS_AUDIO_SAMPLES);
  let span = Math.max(1, Math.trunc(width * AVS_AUDIO_SAMPLES));
  centre -= Math.trunc(span / 2);
  if (centre < 0) { span += centre; centre = 0; }
  if (centre > AVS_AUDIO_SAMPLES - 1) centre = AVS_AUDIO_SAMPLES - 1;
  if (centre + span > AVS_AUDIO_SAMPLES) span = AVS_AUDIO_SAMPLES - centre;
  if (span <= 0) return 0;
  const end = centre + span;
  let sum = 0;
  let count = 0;
  for (let i = centre; i < end; i++) {
    const read = (ch: 0 | 1): number => kind === 'osc'
      ? ((frame.waveform[ch][i]! ^ 128) - 128) / 127.5
      : frame.spectrum[ch][i]! / 255;
    sum += channel === 0 ? (read(0) + read(1)) * 0.5 : read((channel - 1) as 0 | 1);
    count++;
  }
  return count > 0 ? sum / count : 0;
}

function pcmBytes(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(AVS_AUDIO_SAMPLES);
  for (let i = 0; i < out.length; i++) {
    const value = clamp(samples[i]!, -1, 1);
    const pcm16 = value <= -1 ? -32_768 : Math.round(value * 32_767);
    out[i] = (pcm16 >> 8) & 0xff;
  }
  return out;
}

function spectrumBytes(waveform: Uint8Array): Uint8Array {
  const re = new Float64Array(AVS_FFT_SIZE);
  const im = new Float64Array(AVS_FFT_SIZE);
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < AVS_FFT_SIZE; i++) {
    const x = signedByte(waveform[i]!);
    const y = x - x1 + 0.99 * y1;
    x1 = x;
    y1 = y;
    const hann = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (AVS_FFT_SIZE - 1));
    re[i] = y * hann;
  }
  fft(re, im);

  const out = new Uint8Array(AVS_AUDIO_SAMPLES);
  let last = 0;
  for (let bin = 0; bin < AVS_FFT_BINS; bin++) {
    const magnitude = clamp(Math.hypot(re[bin]!, im[bin]!) / 16, 0, 255);
    // Winamp doubles each FFT bin in the 576-byte visualization view: the
    // first byte interpolates with the preceding frequency bin, not with the
    // same bin from the previous audio callback.
    const smooth = (magnitude + last) * 0.5;
    out[bin * 2] = avsLogSpectrumByte(smooth);
    out[bin * 2 + 1] = avsLogSpectrumByte(magnitude);
    last = magnitude;
  }
  // The host fills AVS's 64 non-FFT slots with a repeated half-decay tail.
  for (let i = AVS_FFT_SIZE; i < AVS_AUDIO_SAMPLES; i++) {
    last *= 0.5;
    out[i] = avsLogSpectrumByte(last);
  }
  return out;
}

/** In-place radix-2 forward FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = -2 * Math.PI / size;
    const stepR = Math.cos(angle);
    const stepI = Math.sin(angle);
    for (let base = 0; base < n; base += size) {
      let wr = 1;
      let wi = 0;
      for (let j = 0; j < size / 2; j++) {
        const even = base + j;
        const odd = even + size / 2;
        const tr = wr * re[odd]! - wi * im[odd]!;
        const ti = wr * im[odd]! + wi * re[odd]!;
        re[odd] = re[even]! - tr;
        im[odd] = im[even]! - ti;
        re[even] = re[even]! + tr;
        im[even] = im[even]! + ti;
        const nextWr = wr * stepR - wi * stepI;
        wi = wr * stepI + wi * stepR;
        wr = nextWr;
      }
    }
  }
}

function signedByte(value: number): number { return value < 128 ? value : value - 256; }
function validateHostFrame(frame: readonly [Uint8Array, Uint8Array], label: string): void {
  if (frame[0].length < AVS_AUDIO_SAMPLES || frame[1].length < AVS_AUDIO_SAMPLES) {
    throw new RangeError(`AVS ${label} callback needs two ${AVS_AUDIO_SAMPLES}-byte channels`);
  }
}
function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}
