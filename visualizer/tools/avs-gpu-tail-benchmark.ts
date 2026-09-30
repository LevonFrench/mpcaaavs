import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import {
  AVS_AUDIO_SAMPLES, AvsCompatibilityRuntime, createAvsCompatibilityRegistry, parseAvsPreset,
  registerAvsBeatParticleEffects, type AvsAudioFrame,
} from '../src/avs/index.ts';
import { planTerminalExactGpuPasses } from '../src/avs/gpu-preset-plan.ts';

// Measures how much CPU time the exact terminal GPU tail removes: the full
// preset (reference) against the CPU prefix left after extraction. The two
// runtimes are stepped alternately on the same frame, so drift in machine load
// hits both equally, and the saving is reported with a bootstrap 95% interval.

const args = process.argv.slice(2);
const file = resolve(args.find(value => value.endsWith('.avs'))
  ?? 'assets/avs-presets/community-picks/el-vis - golden.avs');
const readOption = (name: string, fallback: number): number => {
  const value = args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  return value === undefined ? fallback : Number(value);
};
const warmupFrames = readOption('warmup-frames', 30);
const measuredFrames = readOption('frames', 120);
const width = readOption('width', 640);
const height = readOption('height', 360);

const bytes = readFileSync(file);
const preset = parseAvsPreset(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const plan = planTerminalExactGpuPasses(preset);
if (plan.passes.length === 0) throw new Error(`Preset has no eligible exact GPU tail: ${plan.reason}`);
const frames = Array.from({ length: warmupFrames + measuredFrames }, (_, frame) => deterministicAudio(frame));
const registry = () => {
  const created = createAvsCompatibilityRegistry({ randomInt: () => 0 });
  // Deterministic Custom BPM clock (the default reads the wall clock).
  let tick = 0;
  return registerAvsBeatParticleEffects(created, { now: () => (tick += 25) });
};
const reference = new AvsCompatibilityRuntime(preset, width, height, registry());
const cpuPrefix = new AvsCompatibilityRuntime(plan.cpuPreset, width, height, registry());
reference.render(frames[0]!, true);
cpuPrefix.render(frames[0]!, true);

const referenceSamples: number[] = [];
const prefixSamples: number[] = [];
const savings: number[] = [];
for (let index = 0; index < frames.length; index++) {
  // Alternate which runtime goes first so cache warmth from the previous
  // render does not systematically favour one side.
  const referenceFirst = index % 2 === 0;
  const a = referenceFirst ? time(reference, frames[index]!) : time(cpuPrefix, frames[index]!);
  const b = referenceFirst ? time(cpuPrefix, frames[index]!) : time(reference, frames[index]!);
  if (index < warmupFrames) continue;
  const referenceMs = referenceFirst ? a : b;
  const prefixMs = referenceFirst ? b : a;
  referenceSamples.push(referenceMs);
  prefixSamples.push(prefixMs);
  savings.push(referenceMs - prefixMs);
}

console.log(JSON.stringify({
  preset: file, width, height, warmupFrames, measuredFrames, interleaved: true,
  gpuPasses: plan.passes.length,
  gpuComponents: plan.extractedComponents,
  fusedPointwiseOperations: plan.fusedPointwiseOperations,
  reference: stats(referenceSamples),
  cpuPrefix: stats(prefixSamples),
  cpuTailSavedMs: median(savings),
  cpuTailSavedMsCi95: bootstrapMedianCi(savings),
}, null, 2));

function time(runtime: AvsCompatibilityRuntime, frame: AvsAudioFrame): number {
  const started = performance.now();
  runtime.render(frame);
  return performance.now() - started;
}

function stats(samples: readonly number[]): { medianMs: number; p95Ms: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return { medianMs: median(sorted), p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]! };
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) * 0.5;
}

/** Percentile bootstrap of the median paired saving; fixed-seed LCG keeps the interval reproducible. */
function bootstrapMedianCi(samples: readonly number[], rounds = 2000): [number, number] {
  let seed = 0x2545f491;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x1_0000_0000; };
  const medians: number[] = [];
  const draw = new Array<number>(samples.length);
  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < samples.length; i++) draw[i] = samples[Math.floor(next() * samples.length)]!;
    medians.push(median(draw));
  }
  medians.sort((a, b) => a - b);
  return [medians[Math.floor(rounds * 0.025)]!, medians[Math.ceil(rounds * 0.975) - 1]!];
}

function deterministicAudio(frame: number): AvsAudioFrame {
  const waveform = [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)] as const;
  const spectrum = [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)] as const;
  for (let channel = 0; channel < 2; channel++) for (let index = 0; index < AVS_AUDIO_SAMPLES; index++) {
    waveform[channel][index] = Math.trunc(Math.sin(index * (channel ? 0.113 : 0.071) + frame * 0.37) * 72) & 255;
    spectrum[channel][index] = Math.max(0, 220 - Math.trunc(index * 0.35) - channel * 17);
  }
  const beat = frame % 5 === 1;
  return { waveform, spectrum, beat, beatLevel: beat ? 576 * 72 : 576 * 24 };
}
