import { performance } from 'node:perf_hooks';
import {
  AVS_AUDIO_SAMPLES,
  AvsExecutor,
  AvsFramebuffer,
  registerAvsClassicEffects,
  type AvsAudioFrame,
  type AvsComponent,
  type AvsPresetAst,
} from '../src/avs/index.ts';

const width = 640;
const height = 360;
const iterations = Number(process.argv.find(arg => arg.startsWith('--frames='))?.slice(9) ?? 30);
const audio: AvsAudioFrame = {
  waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
  spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
  beat: false, beatLevel: 0,
};
const initial = new Uint32Array(width * height);
let random = 0x6d2b79f5;
for (let index = 0; index < initial.length; index++) {
  random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
  initial[index] = random & 0x00ffffff;
}

for (const mode of [1, 2, 3]) {
  for (const roundUp of [0, 1]) {
    const component = blurComponent(mode, roundUp);
    const preset: AvsPresetAst = {
      version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: false,
      components: [component], byteLength: component.payload.byteLength,
    };
    const executor = new AvsExecutor(preset, registerAvsClassicEffects());
    const framebuffer = new AvsFramebuffer(width, height, initial.slice());
    for (let warmup = 0; warmup < 8; warmup++) executor.render(framebuffer, audio);
    const samples: number[] = [];
    for (let frame = 0; frame < iterations; frame++) {
      const started = performance.now();
      executor.render(framebuffer, audio);
      samples.push(performance.now() - started);
    }
    let checksum = 0x811c9dc5;
    for (const pixel of framebuffer.pixels) checksum = Math.imul(checksum ^ pixel, 0x01000193);
    console.log(JSON.stringify({
      mode, roundUp: Boolean(roundUp), width, height, iterations,
      medianMs: median(samples), p95Ms: percentile(samples, 0.95), checksum: checksum >>> 0,
    }));
  }
}

function blurComponent(mode: number, roundUp: number): AvsComponent {
  const payload = new Uint8Array(8);
  const view = new DataView(payload.buffer);
  view.setInt32(0, mode, true);
  view.setInt32(4, roundUp, true);
  return { effectId: 6, apeId: null, payload, fileOffset: 0, path: '1', children: [], list: null, listCode: null };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) * 0.5;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}
