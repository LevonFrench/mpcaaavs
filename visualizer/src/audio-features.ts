// Shared realtime audio-feature core.
//
// This module is deliberately free of DOM and Web Audio objects so the exact
// same detector can be bundled into the AudioWorklet and used by audio.ts's
// AnalyserNode fallback. All storage is allocated by the constructor; analyse()
// only mutates preallocated typed arrays and its stable result object.

import type { OnsetClass } from './contracts.ts';

/** Approximately octave-spaced bands, with extra resolution through presence. */
export const PERCEPTUAL_BAND_EDGES_HZ = [
  0, 125, 250, 500, 750, 1000, 1500, 2500, 4000, 6000, 8500, 12000, 20000,
] as const;
export const PERCEPTUAL_BAND_COUNT = PERCEPTUAL_BAND_EDGES_HZ.length - 1;

export const ONSET_CLASS_NAMES: readonly (OnsetClass | null)[] = [
  null, 'kick', 'snare', 'hat', 'tonal',
];
export const ONSET_CLASS_KICK = 1;
export const ONSET_CLASS_SNARE = 2;
export const ONSET_CLASS_HAT = 3;
export const ONSET_CLASS_TONAL = 4;

/** SharedArrayBuffer feature-frame ABI, shared by worklet and host. */
export const AUDIO_FEATURE_OFFSETS = Object.freeze({
  time: 0,
  flux: 1,
  threshold: 2,
  level: 3,
  crest: 4,
  pan: 5,
  width: 6,
  centroid: 7,
  flatness: 8,
  publicBands: 9,
  onsetStrength: 14,
  onsetClass: 15,
  perceptualBands: 16,
  perceptualFlux: 16 + PERCEPTUAL_BAND_COUNT,
} as const);
export const AUDIO_FEATURE_FLOATS = 16 + PERCEPTUAL_BAND_COUNT * 2;

const PUBLIC_EDGES = [0, 80, 250, 2000, 8000, 20000] as const;
const PUBLIC_GAINS = [1.6, 1.5, 2.2, 3.0, 3.0] as const;
const PUBLIC_BAND_COUNT = 5;

const HISTORY_SECONDS = 1.1;
const WARMUP_SECONDS = 0.25;
const THRESHOLD_SIGMA = 1.55;
const FLUX_FLOOR = 0.012;
const MIN_GAP_SECONDS = 0.09;
const WHITEN_FLOOR = 0.02;
const WHITEN_DECAY_PER_SECOND = 0.36;
const ENERGY_ATTACK_SECONDS = 0.012;
const ENERGY_RELEASE_SECONDS = 0.18;
const FLUX_ATTACK_SECONDS = 0.004;
const FLUX_RELEASE_SECONDS = 0.085;
const EMPTY_TIME = -1e9;
const SPECTRUM_MIN_DB = -100;
const SPECTRUM_DB_RANGE = 70;

export interface MultibandFrame {
  flux: number;
  threshold: number;
  onsetStrength: number;
  onsetClassCode: number;
  /** Raw-energy attack/release envelopes, one per perceptual band. */
  readonly bands: Float32Array;
  /** Adaptively whitened positive spectral flux envelopes. */
  readonly bandFlux: Float32Array;
  /** Five backwards-compatible AVS-facing aggregate bands. */
  readonly publicBands: Float32Array;
}

/**
 * Causal, perceptual multiband onset detector.
 *
 * `spectrum` uses the AnalyserNode 0..1 dB-normalised curve. `scale` lets the
 * fallback pass Uint8Array data without an intermediate conversion buffer.
 */
export class AdaptiveMultibandDetector {
  readonly result: MultibandFrame = {
    flux: 0,
    threshold: 0,
    onsetStrength: 0,
    onsetClassCode: 0,
    bands: new Float32Array(PERCEPTUAL_BAND_COUNT),
    bandFlux: new Float32Array(PERCEPTUAL_BAND_COUNT),
    publicBands: new Float32Array(PUBLIC_BAND_COUNT),
  };

  private readonly bandStart = new Int16Array(PERCEPTUAL_BAND_COUNT);
  private readonly bandEnd = new Int16Array(PERCEPTUAL_BAND_COUNT);
  private readonly publicWeights = new Float32Array(PUBLIC_BAND_COUNT * PERCEPTUAL_BAND_COUNT);
  private readonly publicWeightSums = new Float32Array(PUBLIC_BAND_COUNT);
  private readonly energy = new Float32Array(PERCEPTUAL_BAND_COUNT);
  private readonly classificationEnergy = new Float32Array(PERCEPTUAL_BAND_COUNT);
  private readonly positiveFlux = new Float32Array(PERCEPTUAL_BAND_COUNT);
  private readonly peak = new Float32Array(PERCEPTUAL_BAND_COUNT);
  private readonly previous = new Float32Array(PERCEPTUAL_BAND_COUNT);
  private readonly linearMagnitude = new Float32Array(256);
  private readonly historyTime: Float32Array;
  private readonly historyFlux: Float32Array;
  private readonly historyCapacity: number;
  private historyHead = 0;
  private historyCount = 0;
  private historySum = 0;
  private historySquareSum = 0;
  private historyFirstTime = EMPTY_TIME;
  private lastOnset = EMPTY_TIME;
  private activeBands = 0;

  constructor(sampleRate: number, spectrumBins: number, maximumFramesPerSecond = 1000) {
    const nyquist = Math.max(1, sampleRate * 0.5);
    for (let value = 0; value < 256; value++) {
      const db = SPECTRUM_MIN_DB + value / 255 * SPECTRUM_DB_RANGE;
      this.linearMagnitude[value] = Math.pow(10, db / 20);
    }
    for (let band = 0; band < PERCEPTUAL_BAND_COUNT; band++) {
      const lo = PERCEPTUAL_BAND_EDGES_HZ[band]!;
      const hi = Math.min(nyquist, PERCEPTUAL_BAND_EDGES_HZ[band + 1]!);
      const start = Math.min(spectrumBins, Math.max(0, Math.floor((lo / nyquist) * spectrumBins)));
      const end = hi > lo
        ? Math.min(spectrumBins, Math.max(start + 1, Math.ceil((hi / nyquist) * spectrumBins)))
        : start;
      this.bandStart[band] = start;
      this.bandEnd[band] = end;
      if (end > start) this.activeBands++;

      const perceptualHi = PERCEPTUAL_BAND_EDGES_HZ[band + 1]!;
      for (let pub = 0; pub < PUBLIC_BAND_COUNT; pub++) {
        const overlap = Math.max(
          0,
          Math.min(perceptualHi, PUBLIC_EDGES[pub + 1]!) - Math.max(lo, PUBLIC_EDGES[pub]!),
        );
        const weight = overlap / Math.max(1, perceptualHi - lo);
        this.publicWeights[pub * PERCEPTUAL_BAND_COUNT + band] = weight;
        this.publicWeightSums[pub] = this.publicWeightSums[pub]! + weight;
      }
    }

    this.historyCapacity = Math.max(32, Math.ceil(HISTORY_SECONDS * maximumFramesPerSecond) + 4);
    this.historyTime = new Float32Array(this.historyCapacity);
    this.historyFlux = new Float32Array(this.historyCapacity);
    this.reset();
  }

  reset(): void {
    this.result.flux = 0;
    this.result.threshold = 0;
    this.result.onsetStrength = 0;
    this.result.onsetClassCode = 0;
    this.result.bands.fill(0);
    this.result.bandFlux.fill(0);
    this.result.publicBands.fill(0);
    this.energy.fill(0);
    this.classificationEnergy.fill(0);
    this.positiveFlux.fill(0);
    this.peak.fill(WHITEN_FLOOR);
    this.previous.fill(0);
    this.historyTime.fill(EMPTY_TIME);
    this.historyFlux.fill(0);
    this.historyHead = 0;
    this.historyCount = 0;
    this.historySum = 0;
    this.historySquareSum = 0;
    this.historyFirstTime = EMPTY_TIME;
    this.lastOnset = EMPTY_TIME;
  }

  analyse(
    spectrum: ArrayLike<number>,
    scale: number,
    time: number,
    dt: number,
    flatness: number,
  ): MultibandFrame {
    const safeDt = Math.max(1e-5, Math.min(0.25, dt));
    const peakDecay = Math.pow(WHITEN_DECAY_PER_SECOND, safeDt);
    let flux = 0;
    let active = 0;

    for (let band = 0; band < PERCEPTUAL_BAND_COUNT; band++) {
      const start = this.bandStart[band]!;
      const end = Math.min(this.bandEnd[band]!, spectrum.length);
      let square = 0;
      let linearSquare = 0;
      for (let bin = start; bin < end; bin++) {
        // AnalyserNode's byte path is floor(255*x). Quantising the worklet's
        // float curve to that same grid costs <0.4% amplitude resolution and
        // makes fallback/worklet state evolution byte-for-byte reproducible.
        const raw = (spectrum[bin] ?? 0) * scale;
        const quantized = Math.floor(Math.max(0, Math.min(1, raw)) * 255 + 1e-6);
        const value = quantized / 255;
        square += value * value;
        const linear = this.linearMagnitude[quantized]!;
        linearSquare += linear * linear;
      }
      const energy = end > start ? Math.sqrt(square / (end - start)) : 0;
      this.energy[band] = energy;
      this.classificationEnergy[band] = end > start ? Math.sqrt(linearSquare / (end - start)) : 0;

      const oldEnvelope = this.result.bands[band]!;
      const energyTau = energy > oldEnvelope ? ENERGY_ATTACK_SECONDS : ENERGY_RELEASE_SECONDS;
      const energyCoeff = Math.exp(-safeDt / energyTau);
      this.result.bands[band] = energy + (oldEnvelope - energy) * energyCoeff;

      const peak = Math.max(energy, this.peak[band]! * peakDecay, WHITEN_FLOOR);
      this.peak[band] = peak;
      const normalised = energy / peak;
      const positive = Math.max(0, normalised - this.previous[band]!);
      this.positiveFlux[band] = positive;
      this.previous[band] = normalised;

      const oldFlux = this.result.bandFlux[band]!;
      const fluxTau = positive > oldFlux ? FLUX_ATTACK_SECONDS : FLUX_RELEASE_SECONDS;
      const fluxCoeff = Math.exp(-safeDt / fluxTau);
      this.result.bandFlux[band] = positive + (oldFlux - positive) * fluxCoeff;
      if (end > start) {
        flux += positive;
        active++;
      }
    }
    flux /= Math.max(1, active);

    this.expireHistory(time);
    const mean = this.historyCount > 0 ? this.historySum / this.historyCount : 0;
    const variance = this.historyCount > 0
      ? Math.max(0, this.historySquareSum / this.historyCount - mean * mean)
      : 0;
    const threshold = mean + THRESHOLD_SIGMA * Math.sqrt(variance);
    const warmed = this.historyFirstTime > EMPTY_TIME * 0.5 && time - this.historyFirstTime >= WARMUP_SECONDS;

    let onsetStrength = 0;
    let onsetClassCode = 0;
    if (
      warmed && flux > threshold && flux > FLUX_FLOOR &&
      time - this.lastOnset > MIN_GAP_SECONDS
    ) {
      this.lastOnset = time;
      onsetStrength = clamp01(0.55 + ((flux - threshold) / Math.max(threshold, 1e-4)) * 0.45);
      onsetClassCode = this.classify(flatness);
    }

    this.pushHistory(time, flux);
    this.aggregatePublicBands();
    this.result.flux = flux;
    this.result.threshold = threshold;
    this.result.onsetStrength = onsetStrength;
    this.result.onsetClassCode = onsetClassCode;
    return this.result;
  }

  private classify(flatness: number): number {
    let low = 0, mid = 0, high = 0;
    let lowCount = 0, midCount = 0, highCount = 0;
    for (let band = 0; band < PERCEPTUAL_BAND_COUNT; band++) {
      if (this.bandEnd[band]! <= this.bandStart[band]!) continue;
      // Novelty decides WHEN an event happened. The current spectral energy
      // decides WHAT it was. Classifying from novelty alone makes a quiet
      // tonal attack inherit whichever whitening band a sweep/background just
      // vacated, producing gain-dependent kick/snare labels.
      const density = this.classificationEnergy[band]! * (0.2 + this.positiveFlux[band]!);
      if (band < 2) { low += density; lowCount++; }
      else if (band < 7) { mid += density; midCount++; }
      else { high += density; highCount++; }
    }
    low /= Math.max(1, lowCount);
    mid /= Math.max(1, midCount);
    high /= Math.max(1, highCount);
    const total = low + mid + high + 1e-6;
    const lowShare = low / total;
    const highShare = high / total;
    // Linearised magnitude rejects the broad low dB skirt produced by a Hann
    // window. That skirt is useful for display but made tonal/hats look like
    // broadband novelty when classified on the normalised dB curve itself.
    if (highShare > 0.40) return ONSET_CLASS_HAT;
    if (flatness > 0.28) return ONSET_CLASS_SNARE;
    if (lowShare > 0.56) return ONSET_CLASS_KICK;
    return ONSET_CLASS_TONAL;
  }

  private aggregatePublicBands(): void {
    for (let pub = 0; pub < PUBLIC_BAND_COUNT; pub++) {
      let sum = 0;
      for (let band = 0; band < PERCEPTUAL_BAND_COUNT; band++) {
        sum += this.result.bands[band]! * this.publicWeights[pub * PERCEPTUAL_BAND_COUNT + band]!;
      }
      this.result.publicBands[pub] = clamp01(
        (sum / Math.max(1e-6, this.publicWeightSums[pub]!)) * PUBLIC_GAINS[pub]!,
      );
    }
  }

  private expireHistory(time: number): void {
    while (this.historyCount > 0) {
      const tail = (this.historyHead - this.historyCount + this.historyCapacity) % this.historyCapacity;
      if (time - this.historyTime[tail]! <= HISTORY_SECONDS) break;
      const old = this.historyFlux[tail]!;
      this.historySum -= old;
      this.historySquareSum -= old * old;
      this.historyCount--;
    }
    if (this.historyCount === 0) this.historyFirstTime = EMPTY_TIME;
    else {
      const tail = (this.historyHead - this.historyCount + this.historyCapacity) % this.historyCapacity;
      this.historyFirstTime = this.historyTime[tail]!;
    }
  }

  private pushHistory(time: number, flux: number): void {
    if (this.historyCount === this.historyCapacity) {
      const old = this.historyFlux[this.historyHead]!;
      this.historySum -= old;
      this.historySquareSum -= old * old;
      this.historyCount--;
    }
    this.historyTime[this.historyHead] = time;
    this.historyFlux[this.historyHead] = flux;
    this.historyHead = (this.historyHead + 1) % this.historyCapacity;
    this.historyCount++;
    this.historySum += flux;
    this.historySquareSum += flux * flux;
    if (this.historyCount === 1) this.historyFirstTime = time;
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
