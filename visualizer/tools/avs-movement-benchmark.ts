import { performance } from 'node:perf_hooks';
import {
  AVS_AUDIO_SAMPLES,
  AvsEffectRegistry,
  AvsExecutor,
  AvsFramebuffer,
  registerAvsMovement,
  type AvsAudioFrame,
  type AvsComponent,
  type AvsPresetAst,
} from '../src/avs/index.ts';

const width = 640;
const height = 360;
const frames = Number(process.argv.find((arg) => arg.startsWith('--frames='))?.slice(9) ?? 80);
const audio: AvsAudioFrame = {
  waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
  spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
  beat: false,
  beatLevel: 0,
};

const results = [
  runScenario('nearest-replace', movementPayload(2)),
  runScenario('nearest-blend', movementPayload(2, { blend: true })),
  runScenario('bilinear-replace', movementPayload(32_767, {
    expression: 'x=x+1/sw;y=y', rectangular: true, subpixel: true, wrap: true,
  })),
  runScenario('bilinear-blend', movementPayload(32_767, {
    expression: 'x=x+1/sw;y=y', rectangular: true, subpixel: true, wrap: true, blend: true,
  })),
  runScenario('forward-maximum', movementPayload(2, { sourceMapped: 1 })),
  runScenario('forward-maximum-blend', movementPayload(2, { sourceMapped: 1, blend: true })),
];
console.log(JSON.stringify({ width, height, frames, results }));

function runScenario(
  name: string,
  payload: Uint8Array,
): { name: string; medianMs: number; p95Ms: number; checksum: number } {
  const component: AvsComponent = {
    effectId: 15,
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
  const executor = new AvsExecutor(preset, registerAvsMovement(new AvsEffectRegistry()));
  for (let frame = 0; frame < 12; frame++) executor.render(framebuffer, audio);
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

function movementPayload(
  effect: number,
  options: {
    expression?: string;
    blend?: boolean;
    sourceMapped?: number;
    rectangular?: boolean;
    subpixel?: boolean;
    wrap?: boolean;
  } = {},
): Uint8Array {
  const expression = new TextEncoder().encode(`${options.expression ?? ''}\0`);
  const customBytes = effect === 32_767 ? 1 + 4 + expression.length : 0;
  const payload = new Uint8Array(4 + customBytes + 20);
  const view = new DataView(payload.buffer);
  let offset = 0;
  view.setInt32(offset, effect, true); offset += 4;
  if (effect === 32_767) {
    payload[offset++] = 1;
    view.setInt32(offset, expression.length, true); offset += 4;
    payload.set(expression, offset); offset += expression.length;
  }
  view.setInt32(offset, options.blend ? 1 : 0, true); offset += 4;
  view.setInt32(offset, options.sourceMapped ?? 0, true); offset += 4;
  view.setInt32(offset, options.rectangular ? 1 : 0, true); offset += 4;
  view.setInt32(offset, options.subpixel ? 1 : 0, true); offset += 4;
  view.setInt32(offset, options.wrap ? 1 : 0, true);
  return payload;
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}
