import { analyzeOfflineTrack } from '../src/offline/analyzer.ts';
import { StereoAnalysisBuffer } from '../src/offline/audio-buffer.ts';
import { resolvePresetSchedule } from '../src/offline/schedule.ts';
import { canonicalTimebase, OFFLINE_SAMPLE_RATE } from '../src/offline/timebase.ts';
import { PERCEPTUAL_BAND_EDGES_HZ } from '../src/audio-features.ts';

type ExpectedEvent = Readonly<{ kind: 'kick' | 'snare' | 'hat' | 'onset'; sample: number }>;

function ok(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}

function fixture(): { buffer: StereoAnalysisBuffer; expected: readonly ExpectedEvent[] } {
  const seconds = 4;
  const frames = seconds * OFFLINE_SAMPLE_RATE;
  const pcm = new Float32Array(frames * 2);
  const expected: ExpectedEvent[] = [];
  let noiseState = 0x714ac93d;
  const noise = (): number => {
    noiseState = (Math.imul(noiseState, 1664525) + 1013904223) >>> 0;
    return noiseState / 0x80000000 - 1;
  };
  const mix = (sample: number, left: number, right = left): void => {
    if (sample < 0 || sample >= frames) return;
    pcm[sample * 2] = Math.max(-1, Math.min(1, pcm[sample * 2]! + left));
    pcm[sample * 2 + 1] = Math.max(-1, Math.min(1, pcm[sample * 2 + 1]! + right));
  };
  // A quiet, continuously moving tonal bed exercises adaptive whitening: it
  // must not become a stream of false attacks as it crosses band boundaries.
  let sweepPhase = 0;
  for (let sample = 0; sample < frames; sample++) {
    const progress = sample / Math.max(1, frames - 1);
    const frequency = 180 * Math.pow(12_000 / 180, progress);
    sweepPhase += 2 * Math.PI * frequency / OFFLINE_SAMPLE_RATE;
    const value = Math.sin(sweepPhase) * .008;
    mix(sample, value, value * .91);
  }
  const addKick = (time: number, gain: number): void => {
    const start = Math.round(time * OFFLINE_SAMPLE_RATE);
    for (let i = 0; i < Math.round(.11 * OFFLINE_SAMPLE_RATE); i++) {
      const t = i / OFFLINE_SAMPLE_RATE;
      const phase = 2 * Math.PI * (75 * t - 90 * t * t);
      const value = gain * Math.exp(-t * 34) * Math.sin(phase);
      mix(start + i, value, value * .94);
    }
    expected.push({ kind: 'kick', sample: start });
  };
  const addSnare = (time: number, gain: number): void => {
    const start = Math.round(time * OFFLINE_SAMPLE_RATE);
    let previous = 0;
    for (let i = 0; i < Math.round(.075 * OFFLINE_SAMPLE_RATE); i++) {
      const t = i / OFFLINE_SAMPLE_RATE;
      const raw = noise();
      const highPassed = raw - previous * .92;
      previous = raw;
      const body = Math.sin(2 * Math.PI * 190 * t) * .35;
      const value = gain * Math.exp(-t * 43) * (highPassed * .72 + body);
      mix(start + i, value, -value * .72);
    }
    expected.push({ kind: 'snare', sample: start });
  };
  const addHat = (time: number, gain: number): void => {
    const start = Math.round(time * OFFLINE_SAMPLE_RATE);
    for (let i = 0; i < Math.round(.035 * OFFLINE_SAMPLE_RATE); i++) {
      const t = i / OFFLINE_SAMPLE_RATE;
      const value = gain * Math.exp(-t * 95) * (
        Math.sin(2 * Math.PI * 8_700 * t) + Math.sin(2 * Math.PI * 11_300 * t) * .7
      ) * .55;
      mix(start + i, value * .82, value);
    }
    expected.push({ kind: 'hat', sample: start });
  };
  const addTonal = (time: number, gain: number): void => {
    const start = Math.round(time * OFFLINE_SAMPLE_RATE);
    for (let i = 0; i < Math.round(.12 * OFFLINE_SAMPLE_RATE); i++) {
      const t = i / OFFLINE_SAMPLE_RATE;
      const value = gain * Math.exp(-t * 25) * Math.sin(2 * Math.PI * 880 * t);
      mix(start + i, value, value);
    }
    expected.push({ kind: 'onset', sample: start });
  };

  const gains = [.09, .28, .82] as const;
  for (let cycle = 0; cycle < 3; cycle++) {
    const base = .50 + cycle;
    const gain = gains[cycle]!;
    addKick(base, gain);
    addSnare(base + .25, gain);
    addHat(base + .50, gain);
    addTonal(base + .75, gain);
  }
  return { buffer: new StereoAnalysisBuffer(pcm), expected };
}

const { buffer, expected } = fixture();
const timebase = canonicalTimebase();
const tempo = Object.freeze({
  bpm: 120, meterNumerator: 4, meterDenominator: 4, downbeatSample: 0,
  authority: 'provided' as const,
});
const schedule = resolvePresetSchedule({
  mode: 'preset', presetId: 'fixture', seed: 1,
  totalSamples: buffer.totalSamplesPerChannel, bpm: tempo.bpm,
  beatsPerBar: tempo.meterNumerator, downbeatSample: tempo.downbeatSample,
}, timebase);
const analysis = analyzeOfflineTrack(buffer, { tempo, schedule, timebase });
const repeated = analyzeOfflineTrack(buffer, { tempo, schedule, timebase });
const musical = analysis.events.filter((event) => event.kind !== 'beat' && event.kind !== 'bar');
const tolerance = 1_024;
let matched = 0;
let correctlyClassified = 0;
for (const target of expected) {
  const nearest = musical.reduce<typeof musical[number] | undefined>((best, event) =>
    !best || Math.abs(event.sample - target.sample) < Math.abs(best.sample - target.sample) ? event : best, undefined);
  if (nearest && Math.abs(nearest.sample - target.sample) <= tolerance) {
    matched++;
    if (nearest.kind === target.kind) correctlyClassified++;
  }
}
const falsePositives = musical.filter((event) =>
  !expected.some((target) => Math.abs(event.sample - target.sample) <= tolerance)).length;
const confusion = new Map<string, number>();
const evidence: Array<Record<string, number | string>> = [];
for (const target of expected) {
  const nearest = musical.reduce<typeof musical[number] | undefined>((best, event) =>
    !best || Math.abs(event.sample - target.sample) < Math.abs(best.sample - target.sample) ? event : best, undefined);
  const predicted = nearest && Math.abs(nearest.sample - target.sample) <= tolerance ? nearest.kind : 'miss';
  const key = `${target.kind}->${predicted}`;
  confusion.set(key, (confusion.get(key) ?? 0) + 1);
  evidence.push({ expected: target.kind, predicted, ...spectralEvidence(buffer, target.sample) });
}
console.log(JSON.stringify({ expected: expected.length, detected: musical.length, matched, correctlyClassified, falsePositives }));
console.log(JSON.stringify({ confusion: Object.fromEntries(confusion), evidence }));
ok(analysis.frames.length === timebase.frameCount(buffer.totalSamplesPerChannel), 'offline analysis preserves exact frame ledger');
ok(analysis.frames.at(-1)?.sample_end === buffer.totalSamplesPerChannel, 'offline analysis preserves the exact final sample');
ok(matched === expected.length, `gain/sweep fixture missed ${expected.length - matched} attacks`);
ok(falsePositives === 0, `gain/sweep fixture emitted ${falsePositives} false attacks`);
ok(correctlyClassified === expected.length, `perceptual classifier regressed (${correctlyClassified}/${expected.length})`);
ok(JSON.stringify(analysis.events) === JSON.stringify(repeated.events), 'offline event extraction is deterministic');
ok(JSON.stringify(analysis.frames) === JSON.stringify(repeated.frames), 'offline frame features are deterministic');

console.log('offline audio: exact ledger, 12/12 gain-scaled attacks, zero sweep false positives, deterministic shared multiband analysis passed');

function spectralEvidence(buffer: StereoAnalysisBuffer, start: number): { low: number; mid: number; high: number; flatness: number } {
  const bins = 256;
  const magnitudes = new Float64Array(bins);
  for (let bin = 0; bin < bins; bin++) {
    let real = 0;
    let imaginary = 0;
    for (let i = 0; i < 512; i++) {
      const mono = (buffer.sample(0, start + i) + buffer.sample(1, start + i)) * .5;
      const window = .5 - .5 * Math.cos(2 * Math.PI * i / 511);
      const angle = -2 * Math.PI * bin * i / 512;
      real += mono * window * Math.cos(angle);
      imaginary += mono * window * Math.sin(angle);
    }
    magnitudes[bin] = Math.sqrt(real * real + imaginary * imaginary);
  }
  let logSum = 0, linearSum = 0;
  for (const magnitude of magnitudes) { logSum += Math.log(magnitude + 1e-12); linearSum += magnitude; }
  const flatness = linearSum > 0 ? Math.exp(logSum / bins) / (linearSum / bins) : 0;
  const group = (loBand: number, hiBand: number): number => {
    let sum = 0;
    for (let band = loBand; band < hiBand; band++) {
      const lo = Math.floor(PERCEPTUAL_BAND_EDGES_HZ[band]! / 24_000 * bins);
      const hi = Math.max(lo + 1, Math.ceil(PERCEPTUAL_BAND_EDGES_HZ[band + 1]! / 24_000 * bins));
      let bandSum = 0;
      for (let bin = lo; bin < Math.min(bins, hi); bin++) bandSum += magnitudes[bin]!;
      sum += bandSum / Math.max(1, hi - lo);
    }
    return sum / Math.max(1, hiBand - loBand);
  };
  return {
    low: Number(group(0, 2).toFixed(5)), mid: Number(group(2, 7).toFixed(5)),
    high: Number(group(7, 12).toFixed(5)), flatness: Number(flatness.toFixed(5)),
  };
}
