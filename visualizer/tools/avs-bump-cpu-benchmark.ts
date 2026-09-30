import { performance } from 'node:perf_hooks';
import { renderExactAvsBumpCpu, type AvsBumpConfig } from '../src/avs/index.ts';

const width = 640, height = 360, source = deterministicPixels(width * height);
const frame = { currentDepth: 100, lightX: 320, lightY: 180 };
const modes: Array<{ name: string; config: AvsBumpConfig }> = [
  { name: 'replace', config: bumpConfig() },
  { name: 'replace-invert-showlight', config: bumpConfig({ invertDepth: true, showLight: true }) },
  { name: 'additive', config: bumpConfig({ additive: true }) },
  { name: 'average', config: bumpConfig({ average: true }) },
];
const rows = modes.map(({ name, config }) => {
  for (let warmup = 0; warmup < 5; warmup++) renderExactAvsBumpCpu(source, width, height, config, frame);
  const samples: number[] = [];
  for (let sample = 0; sample < 25; sample++) { const started = performance.now(); renderExactAvsBumpCpu(source, width, height, config, frame); samples.push(performance.now() - started); }
  return { name, medianMs: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95), minMs: Math.min(...samples), maxMs: Math.max(...samples), samples };
});
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}`, width, height, pixels: source.length, warmup: 5, iterations: 25, rows }, null, 2));

function bumpConfig(overrides: Partial<AvsBumpConfig> = {}): AvsBumpConfig { return { enabled: true, onBeat: false, beatDurationFrames: 15, depth: 100, beatDepth: 100, additive: false, average: false, frame: '', beat: '', init: '', showLight: false, invertDepth: false, oldStyle: false, buffer: 0, ...overrides }; }
function deterministicPixels(count: number): Uint32Array { const result = new Uint32Array(count); let state = 0x9e3779b9; for (let index = 0; index < count; index++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; result[index] = state & 0x00ffffff; } return result; }
function percentile(values: readonly number[], fraction: number): number { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!; }
