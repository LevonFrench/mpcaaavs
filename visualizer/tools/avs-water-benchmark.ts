import { performance } from 'node:perf_hooks';
import {
  AVS_AUDIO_SAMPLES,
  AvsExecutor,
  AvsFramebuffer,
  registerAvsBasicTransforms,
  type AvsAudioFrame,
  type AvsComponent,
  type AvsPresetAst,
} from '../src/avs/index.ts';

const width = 640;
const height = 360;
const frames = Number(process.argv.find(arg => arg.startsWith('--frames='))?.slice(9) ?? 40);
const payload = new Uint8Array(4);
new DataView(payload.buffer).setInt32(0, 1, true);
const component: AvsComponent = {
  effectId: 20, apeId: null, payload, fileOffset: 0, path: '1',
  children: [], list: null, listCode: null,
};
const preset: AvsPresetAst = {
  version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: false,
  components: [component], byteLength: payload.length,
};
const audio: AvsAudioFrame = {
  waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
  spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
  beat: false, beatLevel: 0,
};
const pixels = new Uint32Array(width * height);
let random = 0x9e3779b9;
for (let index = 0; index < pixels.length; index++) {
  random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
  pixels[index] = random & 0x00ffffff;
}
const framebuffer = new AvsFramebuffer(width, height, pixels);
const executor = new AvsExecutor(preset, registerAvsBasicTransforms());
for (let frame = 0; frame < 8; frame++) executor.render(framebuffer, audio);
const samples: number[] = [];
for (let frame = 0; frame < frames; frame++) {
  const started = performance.now();
  executor.render(framebuffer, audio);
  samples.push(performance.now() - started);
}
let checksum = 0x811c9dc5;
for (const pixel of framebuffer.pixels) checksum = Math.imul(checksum ^ pixel, 0x01000193);
samples.sort((a, b) => a - b);
console.log(JSON.stringify({
  width, height, frames,
  medianMs: percentile(samples, 0.5),
  p95Ms: percentile(samples, 0.95),
  checksum: checksum >>> 0,
}));

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}
