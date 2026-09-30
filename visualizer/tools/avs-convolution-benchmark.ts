import { readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  AVS_AUDIO_SAMPLES,
  AVS_CONVOLUTION_APE_ID,
  AvsExecutor,
  AvsFramebuffer,
  decodeAvsConvolutionConfig,
  parseAvsPreset,
  registerAvsConvolutionFilter,
  type AvsAudioFrame,
  type AvsComponent,
  type AvsPresetAst,
} from '../src/avs/index.ts';

const width = 640;
const height = 360;
const frames = Number(process.argv.find((arg) => arg.startsWith('--frames='))?.slice(9) ?? 12);
const focus = process.argv.find((arg) => arg.startsWith('--focus='))?.slice(8).toLowerCase() ?? '';
const roots = [
  resolve('assets/avs-presets/community-picks'),
  resolve('assets/avs-presets/winamp-5-picks'),
];
const audio: AvsAudioFrame = {
  waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
  spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
  beat: false,
  beatLevel: 0,
};
const initial = new Uint32Array(width * height);
let random = 0x9e3779b9;
for (let index = 0; index < initial.length; index++) {
  random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
  initial[index] = random >>> 0;
}

interface CorpusConvolution { readonly name: string; readonly component: AvsComponent }
const instances: CorpusConvolution[] = [];
for (const root of roots) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.avs')) continue;
    const ast = parseAvsPreset(new Uint8Array(readFileSync(resolve(root, entry.name))));
    walk(ast.components, (component) => {
      if (component.apeId === AVS_CONVOLUTION_APE_ID) {
        instances.push({ name: basename(entry.name), component });
      }
    });
  }
}

const selected = focus ? instances.filter(({ name }) => name.toLowerCase().includes(focus)) : instances;
const results = selected.map(({ name, component }, instanceIndex) => {
  const config = decodeAvsConvolutionConfig(component.payload);
  const samples: number[] = [];
  const framebuffer = new AvsFramebuffer(width, height, new Uint32Array(initial));
  const isolated: AvsComponent = { ...component, path: `convolution-bench-${instanceIndex}` };
  const preset: AvsPresetAst = {
    version: 2,
    header: 'Nullsoft AVS Preset 0.2\u001a',
    clearEveryFrame: false,
    components: [isolated],
    byteLength: component.payload.byteLength,
  };
  const executor = new AvsExecutor(preset, registerAvsConvolutionFilter());
  for (let frame = -3; frame < frames; frame++) {
    framebuffer.pixels.set(initial);
    const started = performance.now();
    executor.render(framebuffer, audio);
    const elapsed = performance.now() - started;
    if (frame >= 0) samples.push(elapsed);
  }
  const checksum = hash(framebuffer.pixels);
  samples.sort((a, b) => a - b);
  return {
    name,
    flags: { wrap: config.wrap, absolute: config.absolute, twoPass: config.twoPass },
    nonzero: config.kernel.filter((value) => value !== 0).length,
    positiveMagnitude: config.kernel.reduce((sum, value) => sum + Math.max(0, value), 0),
    negativeMagnitude: config.kernel.reduce((sum, value) => sum + Math.max(0, -value), 0),
    bias: config.bias,
    scale: config.scale,
    kernel: config.kernel,
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    checksum,
  };
});
// Walk-order checksum of every instance: equal across two builds = identical pixels.
const corpusChecksum = results.reduce((checksum, result) => Math.imul(checksum ^ result.checksum, 0x01000193), 0x811c9dc5) >>> 0;
const totalMedianMs = results.reduce((sum, result) => sum + result.medianMs, 0);
results.sort((left, right) => right.medianMs - left.medianMs);
console.log(JSON.stringify({
  width, height, frames, instances: results.length, totalMedianMs, corpusChecksum, results,
}, null, 2));
console.error(`avs-convolution-benchmark: ${results.length} instances, summed median ${totalMedianMs.toFixed(1)} ms/frame, `
  + `corpus checksum ${corpusChecksum.toString(16).padStart(8, '0')}`);

function walk(components: readonly AvsComponent[], visit: (component: AvsComponent) => void): void {
  for (const component of components) {
    visit(component);
    walk(component.children, visit);
  }
}

function hash(pixels: Uint32Array): number {
  let checksum = 0x811c9dc5;
  for (const pixel of pixels) checksum = Math.imul(checksum ^ pixel, 0x01000193);
  return checksum >>> 0;
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}
