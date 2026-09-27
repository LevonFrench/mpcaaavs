export const OFFLINE_SAMPLE_RATE = 48_000;
export const CANONICAL_FPS_NUMERATOR = 24;
export const CANONICAL_FPS_DENOMINATOR = 1;
export const CANONICAL_SAMPLES_PER_FRAME = 2_000;

export interface SampleRange {
  readonly start: number;
  readonly end: number;
}

/** Exact non-negative rational sample/frame mapping. No floating clock is accumulated. */
export class RationalTimebase {
  readonly sampleRate: number;
  readonly fpsNumerator: number;
  readonly fpsDenominator: number;

  constructor(sampleRate: number, fpsNumerator: number, fpsDenominator = 1) {
    assertPositiveInteger(sampleRate, 'sampleRate');
    assertPositiveInteger(fpsNumerator, 'fpsNumerator');
    assertPositiveInteger(fpsDenominator, 'fpsDenominator');
    this.sampleRate = sampleRate;
    this.fpsNumerator = fpsNumerator;
    this.fpsDenominator = fpsDenominator;
    Object.freeze(this);
  }

  frameStartSample(frame: number): number {
    assertNonNegativeInteger(frame, 'frame');
    return safeNumber(BigInt(frame) * BigInt(this.sampleRate) * BigInt(this.fpsDenominator) / BigInt(this.fpsNumerator));
  }

  frameEndSample(frame: number, totalSamples: number): number {
    assertNonNegativeInteger(totalSamples, 'totalSamples');
    return Math.min(totalSamples, this.frameStartSample(frame + 1));
  }

  frameRange(frame: number, totalSamples: number): SampleRange {
    const start = Math.min(totalSamples, this.frameStartSample(frame));
    return Object.freeze({ start, end: this.frameEndSample(frame, totalSamples) });
  }

  frameCount(totalSamples: number): number {
    assertNonNegativeInteger(totalSamples, 'totalSamples');
    const numerator = BigInt(totalSamples) * BigInt(this.fpsNumerator);
    const denominator = BigInt(this.sampleRate) * BigInt(this.fpsDenominator);
    return safeNumber((numerator + denominator - 1n) / denominator);
  }

  timeSecondsAtFrame(frame: number): number {
    assertNonNegativeInteger(frame, 'frame');
    return frame * this.fpsDenominator / this.fpsNumerator;
  }

  frameAtSample(sample: number, rounding: 'floor' | 'nearest' = 'floor'): number {
    assertNonNegativeInteger(sample, 'sample');
    const numerator = BigInt(sample) * BigInt(this.fpsNumerator);
    const denominator = BigInt(this.sampleRate) * BigInt(this.fpsDenominator);
    if (rounding === 'nearest') return safeNumber((numerator + denominator / 2n) / denominator);
    // Inverse of the floored frame-start mapping: find the greatest frame f
    // whose floor(f * samples/rate) is <= sample.
    const nextNumerator = BigInt(sample + 1) * BigInt(this.fpsNumerator);
    return safeNumber((nextNumerator + denominator - 1n) / denominator - 1n);
  }
}

/** Cumulative beat boundary; callers pass the global beat index, never a rounded delta. */
export function cumulativeBeatBoundarySample(globalBeat: number, bpm: number, sampleRate = OFFLINE_SAMPLE_RATE): number {
  if (!Number.isFinite(globalBeat) || globalBeat < 0) throw new RangeError('globalBeat must be finite and non-negative');
  if (!Number.isFinite(bpm) || bpm <= 0) throw new RangeError('bpm must be finite and positive');
  return Math.round(globalBeat * sampleRate * 60 / bpm);
}

export function canonicalTimebase(): RationalTimebase {
  return new RationalTimebase(OFFLINE_SAMPLE_RATE, CANONICAL_FPS_NUMERATOR, CANONICAL_FPS_DENOMINATOR);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
}
function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
}
function safeNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError('timebase result exceeds Number safe integer range');
  return result;
}
