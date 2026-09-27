import { OFFLINE_SAMPLE_RATE } from './timebase.ts';

export interface DecodedAudioLike {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

/** Read-only API over a privately copied interleaved 48 kHz stereo buffer. */
export class StereoAnalysisBuffer {
  readonly sampleRate = OFFLINE_SAMPLE_RATE;
  readonly channels = 2;
  readonly totalSamplesPerChannel: number;
  readonly durationSeconds: number;
  readonly sourceSha256?: string;
  readonly sourceSampleFormat: string;
  readonly sourcePath: string;
  #samples: Float32Array;

  constructor(interleavedStereo48k: Float32Array, metadata: {
    sourceSha256?: string;
    sourceSampleFormat?: string;
    sourcePath?: string;
  } = {}) {
    if ((interleavedStereo48k.length & 1) !== 0) throw new RangeError('stereo analysis PCM must contain complete L/R frames');
    this.#samples = interleavedStereo48k.slice();
    this.totalSamplesPerChannel = this.#samples.length / 2;
    this.durationSeconds = this.totalSamplesPerChannel / OFFLINE_SAMPLE_RATE;
    this.sourceSha256 = metadata.sourceSha256;
    this.sourceSampleFormat = metadata.sourceSampleFormat ?? 'float32_analysis';
    this.sourcePath = metadata.sourcePath ?? 'track.wav';
    Object.freeze(this);
  }

  sample(channel: 0 | 1, sampleIndex: number): number {
    if (!Number.isInteger(sampleIndex) || sampleIndex < 0 || sampleIndex >= this.totalSamplesPerChannel) return 0;
    return this.#samples[sampleIndex * 2 + channel]!;
  }

  copyInterleaved(): Float32Array { return this.#samples.slice(); }

  copyRange(start: number, end: number): Float32Array {
    validateRange(start, end, this.totalSamplesPerChannel);
    return this.#samples.slice(start * 2, end * 2);
  }

  readPlanar(start: number, sampleCount: number, left: Float32Array, right: Float32Array): void {
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(sampleCount) || sampleCount < 0) {
      throw new RangeError('readPlanar range must use non-negative integers');
    }
    if (left.length < sampleCount || right.length < sampleCount) throw new RangeError('readPlanar targets are too small');
    for (let i = 0; i < sampleCount; i++) {
      const source = start + i;
      left[i] = source < this.totalSamplesPerChannel ? this.#samples[source * 2]! : 0;
      right[i] = source < this.totalSamplesPerChannel ? this.#samples[source * 2 + 1]! : 0;
    }
  }
}

export function normalizeDecodedAudio(decoded: DecodedAudioLike, metadata: ConstructorParameters<typeof StereoAnalysisBuffer>[1] = {}): StereoAnalysisBuffer {
  if (!Number.isFinite(decoded.sampleRate) || decoded.sampleRate <= 0 || decoded.numberOfChannels < 1 || decoded.length < 0) {
    throw new RangeError('invalid decoded audio contract');
  }
  const outputLength = Math.round(decoded.length * OFFLINE_SAMPLE_RATE / decoded.sampleRate);
  const output = new Float32Array(outputLength * 2);
  const left = decoded.getChannelData(0);
  const right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : left;
  if (left.length < decoded.length || right.length < decoded.length) throw new RangeError('decoded channel is shorter than decoded.length');
  if (decoded.sampleRate === OFFLINE_SAMPLE_RATE) {
    for (let i = 0; i < outputLength; i++) {
      output[i * 2] = finiteSample(left[i]);
      output[i * 2 + 1] = finiteSample(right[i]);
    }
  } else {
    const ratio = decoded.sampleRate / OFFLINE_SAMPLE_RATE;
    for (let i = 0; i < outputLength; i++) {
      const position = i * ratio;
      const a = Math.min(decoded.length - 1, Math.floor(position));
      const b = Math.min(decoded.length - 1, a + 1);
      const mix = position - a;
      output[i * 2] = lerp(finiteSample(left[a]), finiteSample(left[b]), mix);
      output[i * 2 + 1] = lerp(finiteSample(right[a]), finiteSample(right[b]), mix);
    }
  }
  return new StereoAnalysisBuffer(output, metadata);
}

function finiteSample(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value!));
}
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function validateRange(start: number, end: number, length: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > length) {
    throw new RangeError(`invalid sample range [${start}, ${end}) for ${length} samples`);
  }
}
