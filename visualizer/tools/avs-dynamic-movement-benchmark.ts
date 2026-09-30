import { performance } from 'node:perf_hooks';
import {
  AVS_AUDIO_SAMPLES,
  AvsEffectRegistry,
  AvsExecutor,
  AvsFramebuffer,
  registerAvsDynamicMovement,
  type AvsAudioFrame,
  type AvsComponent,
  type AvsPresetAst,
} from '../src/avs/index.ts';

const width = 640;
const height = 360;
const frames = Number(process.argv.find((arg) => arg.startsWith('--frames='))?.slice(9) ?? 40);
const audio: AvsAudioFrame = {
  waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
  spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
  beat: false,
  beatLevel: 0,
};

const results = [
  runScenario('bilinear-replace', { bilinear: true, blend: false, wrap: false }),
  runScenario('bilinear-blend', { bilinear: true, blend: true, wrap: false }),
  runScenario('nearest-blend-wrap', { bilinear: false, blend: true, wrap: true }),
  runScenario('no-move-mask', { bilinear: true, blend: true, wrap: false, noMove: true }),
];
console.log(JSON.stringify({ width, height, frames, results }));

function runScenario(
  name: string,
  options: { bilinear: boolean; blend: boolean; wrap: boolean; noMove?: boolean },
): { name: string; medianMs: number; p95Ms: number; checksum: number } {
  const payload = dynamicPayload(options);
  const component: AvsComponent = {
    effectId: 43,
    apeId: null,
    payload,
    fileOffset: 0,
    path: `benchmark:${name}`,
    children: [],
    list: null,
    listCode: null,
  };
  const preset: AvsPresetAst = {
    version: 2,
    header: 'Nullsoft AVS Preset 0.2\u001a',
    clearEveryFrame: false,
    components: [component],
    byteLength: payload.length,
  };
  const pixels = new Uint32Array(width * height);
  let random = 0x9e3779b9;
  for (let index = 0; index < pixels.length; index++) {
    random ^= random << 13;
    random ^= random >>> 17;
    random ^= random << 5;
    pixels[index] = random & 0x00ffffff;
  }
  const framebuffer = new AvsFramebuffer(width, height, pixels);
  const executor = new AvsExecutor(preset, registerAvsDynamicMovement(new AvsEffectRegistry()));
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
  return {
    name,
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    checksum: checksum >>> 0,
  };
}

function dynamicPayload(options: { bilinear: boolean; blend: boolean; wrap: boolean; noMove?: boolean }): Uint8Array {
  const strings = ['', '', '', ''].map(encodedString);
  const bytes = new Uint8Array(1 + strings.reduce((sum, value) => sum + 4 + value.length, 0) + 32);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  bytes[offset++] = 1;
  for (const value of strings) {
    view.setUint32(offset, value.length, true);
    offset += 4;
    bytes.set(value, offset);
    offset += value.length;
  }
  for (const value of [
    options.bilinear,
    true,
    16,
    16,
    options.blend,
    options.wrap,
    0,
    options.noMove ?? false,
  ]) {
    view.setInt32(offset, Number(value), true);
    offset += 4;
  }
  return bytes;
}

function encodedString(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length + 1);
  for (let index = 0; index < value.length; index++) bytes[index] = value.charCodeAt(index) & 255;
  return bytes;
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}
