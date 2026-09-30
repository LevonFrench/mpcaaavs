import { performance } from 'node:perf_hooks';
import {
  AVS_AUDIO_SAMPLES, AvsCompatibilityRuntime, createAvsCompatibilityRegistry,
  type AvsAudioFrame, type AvsBitmap, type AvsComponent, type AvsPresetAst,
} from '../src/avs/index.ts';

const width = 640, height = 360;
const frames = Number(process.argv.find(value => value.startsWith('--frames='))?.slice(9) ?? 80);
const bitmap: AvsBitmap = { width: 8, height: 8, pixels: patternedPixels(64) };
const registry = createAvsCompatibilityRegistry({}, { bitmapResolver: () => bitmap });
const audio: AvsAudioFrame = {
  waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
  spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
  beat: false, beatLevel: 0,
};

const scenarios = [
  benchmark('Roto nearest replace', component(9, ints([31, 18, 0, 0, 0, 31, 0, 0]))),
  benchmark('Roto bilinear blend', component(9, ints([40, 18, 1, 0, 0, 31, 0, 1]))),
  benchmark('Blitter zoom-in nearest', component(4, ints([20, 30, 0, 0, 0]))),
  benchmark('Blitter zoom-in bilinear blend', component(4, ints([20, 30, 1, 0, 1]))),
  benchmark('Blitter zoom-out blend', component(4, ints([40, 30, 1, 0, 0]))),
  benchmark('Texer 4096 ordered 8x8 stamps', component(-1, texerPayload('synthetic.bmp', 2, 4096), 'Texer')),
  benchmark('Texer II 1024 ordered 8x8 stamps', component(-1, texer2Payload('synthetic.bmp'), 'Acko.net: Texer II')),
];
console.log(JSON.stringify({ width, height, frames, scenarios }, null, 2));

function benchmark(name: string, effect: AvsComponent): { name: string; medianMs: number; p95Ms: number; checksum: number } {
  const preset: AvsPresetAst = {
    version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: false,
    components: [effect], byteLength: effect.payload.byteLength,
  };
  const runtime = new AvsCompatibilityRuntime(preset, width, height, registry);
  runtime.framebuffer.pixels.set(patternedPixels(width * height));
  for (let index = 0; index < 8; index++) runtime.render(audio);
  const samples: number[] = [];
  for (let index = 0; index < frames; index++) {
    const started = performance.now(); runtime.render(audio); samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  let checksum = 0x811c9dc5;
  for (const pixel of runtime.framebuffer.pixels) checksum = Math.imul(checksum ^ pixel, 0x01000193);
  return { name, medianMs: percentile(samples, .5), p95Ms: percentile(samples, .95), checksum: checksum >>> 0 };
}

function component(effectId: number, payload: Uint8Array, apeId: string | null = null): AvsComponent {
  return { effectId, apeId, payload, fileOffset: 0, path: '1', children: [], list: null, listCode: null };
}
function ints(values: readonly number[]): Uint8Array {
  const payload = new Uint8Array(values.length * 4); const view = new DataView(payload.buffer);
  values.forEach((value, index) => view.setInt32(index * 4, value, true)); return payload;
}
function texerPayload(name: string, mode: number, particles: number): Uint8Array {
  const payload = new Uint8Array(288); payload.set(new TextEncoder().encode(name).subarray(0, 259), 16);
  const view = new DataView(payload.buffer); view.setInt32(276, mode, true); view.setInt32(280, particles, true); return payload;
}
function texer2Payload(name: string): Uint8Array {
  const scripts = ['n=1024', '', '', 'x=(i%32)/16-1;y=floor(i*32)/16384-1'];
  const encoded = scripts.map(value => new TextEncoder().encode(value));
  const payload = new Uint8Array(280 + encoded.reduce((sum, value) => sum + 4 + value.length, 0));
  const view = new DataView(payload.buffer); view.setInt32(0, 0, true);
  payload.set(new TextEncoder().encode(name).subarray(0, 259), 4);
  let offset = 280;
  for (const value of encoded) { view.setUint32(offset, value.length, true); offset += 4; payload.set(value, offset); offset += value.length; }
  return payload;
}
function patternedPixels(length: number): Uint32Array {
  const pixels = new Uint32Array(length); let state = 0x424c4954;
  for (let index = 0; index < length; index++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; pixels[index] = state & 0xffffff; }
  return pixels;
}
function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}
