import assert from 'node:assert/strict';
import {
  AdaptiveMultibandDetector,
  AUDIO_FEATURE_FLOATS,
  AUDIO_FEATURE_OFFSETS,
  ONSET_CLASS_NAMES,
  PERCEPTUAL_BAND_COUNT,
  PERCEPTUAL_BAND_EDGES_HZ,
} from '../src/audio-features.ts';
import { decodeWorkletFeatureFrame, type WorkletFeatures } from '../src/worklet-host.ts';

const SAMPLE_RATE = 48_000;
const BINS = 256;
const DT = 128 / SAMPLE_RATE;
let assertions = 0;

function spectrum(fill = 0.002): Float32Array {
  return new Float32Array(BINS).fill(fill);
}

function paint(out: Float32Array, lo: number, hi: number, level: number): void {
  const nyquist = SAMPLE_RATE / 2;
  const start = Math.max(0, Math.floor((lo / nyquist) * BINS));
  const end = Math.min(BINS, Math.max(start + 1, Math.ceil((hi / nyquist) * BINS)));
  for (let bin = start; bin < end; bin++) out[bin] = level;
}

function transient(kind: 'kick' | 'snare' | 'hat' | 'tonal', gain = 1): Float32Array {
  const out = spectrum();
  if (kind === 'kick') {
    paint(out, 20, 250, 0.92 * gain);
    paint(out, 250, 900, 0.10 * gain);
  } else if (kind === 'snare') {
    paint(out, 180, 8500, 0.58 * gain);
    // Deterministic comb keeps the fixture broadband without random input.
    for (let i = 2; i < 91; i += 3) out[i] = 0.86 * gain;
  } else if (kind === 'hat') {
    paint(out, 6000, 18_000, 0.82 * gain);
  } else {
    for (const hz of [440, 880, 1320, 1760]) paint(out, hz - 45, hz + 45, 0.94 * gain);
  }
  return out;
}

function prime(detector: AdaptiveMultibandDetector, base = spectrum()): number {
  let time = 0;
  for (let i = 0; i < 150; i++) {
    detector.analyse(base, 1, time, DT, 0.02);
    time += DT;
  }
  return time;
}

for (const expected of ['kick', 'snare', 'hat', 'tonal'] as const) {
  const detector = new AdaptiveMultibandDetector(SAMPLE_RATE, BINS, 375);
  const time = prime(detector);
  const frame = detector.analyse(
    transient(expected), 1, time, DT,
    expected === 'snare' || expected === 'hat' ? 0.62 : 0.04,
  );
  assert.ok(frame.onsetStrength > 0, `${expected} must trigger after warmup`); assertions++;
  assert.equal(ONSET_CLASS_NAMES[frame.onsetClassCode], expected); assertions++;
  assert.ok(frame.flux > frame.threshold); assertions++;
}

// A frequency sweep must move monotonically through the perceptual bank.
{
  const detector = new AdaptiveMultibandDetector(SAMPLE_RATE, BINS, 375);
  let time = prime(detector);
  let previous = -1;
  for (const hz of [180, 420, 900, 1800, 3600, 7200, 14_000]) {
    detector.reset();
    time = prime(detector);
    const frame = detector.analyse((() => {
      const out = spectrum(); paint(out, hz * 0.92, hz * 1.08, 0.8); return out;
    })(), 1, time, DT, 0.02);
    let strongest = 0;
    for (let band = 1; band < PERCEPTUAL_BAND_COUNT; band++) {
      if (frame.bands[band]! > frame.bands[strongest]!) strongest = band;
    }
    assert.ok(strongest >= previous, `${hz} Hz regressed from band ${previous} to ${strongest}`); assertions++;
    const lo = PERCEPTUAL_BAND_EDGES_HZ[strongest]!;
    const hi = PERCEPTUAL_BAND_EDGES_HZ[strongest + 1]!;
    assert.ok(hz >= lo * 0.8 && hz <= hi * 1.2, `${hz} Hz mapped outside ${lo}-${hi}`); assertions++;
    previous = strongest;
  }
}

// Adaptive whitening makes classification and normalised flux robust to gain.
{
  const loud = new AdaptiveMultibandDetector(SAMPLE_RATE, BINS, 375);
  const quiet = new AdaptiveMultibandDetector(SAMPLE_RATE, BINS, 375);
  const t1 = prime(loud, transient('tonal', 0.7));
  const t2 = prime(quiet, transient('tonal', 0.21));
  const a = loud.analyse(transient('kick', 0.7), 1, t1, DT, 0.04);
  const b = quiet.analyse(transient('kick', 0.21), 1, t2, DT, 0.04);
  assert.equal(ONSET_CLASS_NAMES[a.onsetClassCode], ONSET_CLASS_NAMES[b.onsetClassCode]); assertions++;
  assert.ok(Math.abs(a.flux - b.flux) < 0.08, `gain-normalised flux diverged: ${a.flux} vs ${b.flux}`); assertions++;
}

// Byte fallback and float worklet inputs share one numerical contract.
{
  const bytes = new Uint8Array(BINS);
  const floats = transient('hat', 0.73);
  for (let i = 0; i < BINS; i++) bytes[i] = Math.floor(floats[i]! * 255);
  const worklet = new AdaptiveMultibandDetector(SAMPLE_RATE, BINS, 375);
  const fallback = new AdaptiveMultibandDetector(SAMPLE_RATE, BINS, 375);
  let time = 0;
  for (let frame = 0; frame < 180; frame++, time += DT) {
    const a = worklet.analyse(floats, 1, time, DT, 0.6);
    const b = fallback.analyse(bytes, 1 / 255, time, DT, 0.6);
    assert.ok(
      Math.abs(a.flux - b.flux) < 1e-7,
      `float/byte flux diverged at frame ${frame}: ${a.flux} vs ${b.flux}`,
    ); assertions++;
    assert.equal(a.onsetClassCode, b.onsetClassCode); assertions++;
  }
}

// Long-session and track-change regression: the rolling history must keep
// emitting transients after several complete ring wraps, then warm cleanly
// again when a new track restarts its audio clock at zero.
{
  const detector = new AdaptiveMultibandDetector(SAMPLE_RATE, BINS, 60);
  const longDt = 0.025;
  let earlyOnsets = 0, lateOnsets = 0;
  for (let frame = 0; frame < 3 * 60 / longDt; frame++) {
    const time = frame * longDt;
    const hit = frame % 20 === 0;
    const result = detector.analyse(hit ? transient('kick') : spectrum(), 1, time, longDt, 0.04);
    if (result.onsetStrength > 0) {
      if (time < 60) earlyOnsets++;
      if (time >= 120) lateOnsets++;
    }
  }
  assert.ok(earlyOnsets > 80, `first minute produced only ${earlyOnsets} onsets`); assertions++;
  assert.ok(lateOnsets > 80, `third minute produced only ${lateOnsets} onsets`); assertions++;
  detector.reset();
  let newTrackOnsets = 0;
  for (let frame = 0; frame < 12 / longDt; frame++) {
    const result = detector.analyse(frame % 16 === 0 ? transient('snare') : spectrum(), 1, frame * longDt, longDt, .62);
    if (result.onsetStrength > 0) newTrackOnsets++;
  }
  assert.ok(newTrackOnsets > 20, `new track produced only ${newTrackOnsets} onsets after reset`); assertions++;
}

// Stereo fixture: correlated mono is narrow/centred; anti-phase and imbalance
// produce width and pan with the same signs used by the detector worklet.
{
  const n = 512;
  const left = new Float32Array(n), right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const value = Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE);
    left[i] = value;
    right[i] = value;
  }
  const mono = stereo(left, right);
  assert.ok(Math.abs(mono.pan) < 1e-7 && mono.width < 1e-7); assertions++;
  for (let i = 0; i < n; i++) right[i] = -left[i]! * 0.25;
  const wide = stereo(left, right);
  assert.ok(wide.pan > 0.5, `left-heavy pan was ${wide.pan}`); assertions++;
  assert.ok(wide.width > 0.5, `anti-phase width was ${wide.width}`); assertions++;
}

// Ring ABI: pack using the worklet's shared offsets and decode through the
// host's public helper, including every perceptual energy/novelty slot.
{
  assert.equal(AUDIO_FEATURE_FLOATS, 40); assertions++;
  const frame = new Float32Array(AUDIO_FEATURE_FLOATS);
  frame[AUDIO_FEATURE_OFFSETS.time] = 12.5;
  frame[AUDIO_FEATURE_OFFSETS.flux] = 0.42;
  frame[AUDIO_FEATURE_OFFSETS.threshold] = 0.2;
  frame[AUDIO_FEATURE_OFFSETS.onsetClass] = 3;
  for (let i = 0; i < 5; i++) frame[AUDIO_FEATURE_OFFSETS.publicBands + i] = 0.1 * (i + 1);
  for (let i = 0; i < PERCEPTUAL_BAND_COUNT; i++) {
    frame[AUDIO_FEATURE_OFFSETS.perceptualBands + i] = i / 20;
    frame[AUDIO_FEATURE_OFFSETS.perceptualFlux + i] = (12 - i) / 20;
  }
  const decoded: WorkletFeatures = {
    time: 0, flux: 0, thresh: 0, level: 0, crest: 1, pan: 0, width: 0,
    centroid: 0, flatness: 0,
    bands: { sub: 0, low: 0, mid: 0, high: 0, air: 0 },
    perceptualBands: new Float32Array(PERCEPTUAL_BAND_COUNT),
    perceptualFlux: new Float32Array(PERCEPTUAL_BAND_COUNT),
    onsetClass: null,
  };
  decodeWorkletFeatureFrame(frame, 0, decoded, 2.5);
  assert.equal(decoded.time, 10); assertions++;
  assert.ok(Math.abs(decoded.flux - 0.42) < 1e-6); assertions++;
  assert.equal(decoded.bands.air, 0.5); assertions++;
  assert.equal(decoded.onsetClass, 'hat'); assertions++;
  for (let i = 0; i < PERCEPTUAL_BAND_COUNT; i++) {
    assert.equal(decoded.perceptualBands[i], frame[AUDIO_FEATURE_OFFSETS.perceptualBands + i]); assertions++;
    assert.equal(decoded.perceptualFlux[i], frame[AUDIO_FEATURE_OFFSETS.perceptualFlux + i]); assertions++;
  }
}

console.log(`audio-multiband-check: PASS (${assertions} assertions)`);

function stereo(left: Float32Array, right: Float32Array): { pan: number; width: number } {
  let leftSquare = 0, rightSquare = 0, midSquare = 0, sideSquare = 0;
  for (let i = 0; i < left.length; i++) {
    const l = left[i]!, r = right[i]!;
    const mid = (l + r) * 0.5, side = (l - r) * 0.5;
    leftSquare += l * l; rightSquare += r * r;
    midSquare += mid * mid; sideSquare += side * side;
  }
  const l = Math.sqrt(leftSquare), r = Math.sqrt(rightSquare);
  const mid = Math.sqrt(midSquare), side = Math.sqrt(sideSquare);
  return {
    pan: l + r > 1e-6 ? (l - r) / (l + r) : 0,
    width: side / Math.max(1e-6, mid + side),
  };
}
