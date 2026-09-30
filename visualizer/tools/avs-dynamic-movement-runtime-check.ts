import {
  AVS_AUDIO_SAMPLES,
  AvsEffectRegistry,
  AvsExecutor,
  AvsFramebuffer,
  decodeAvsDynamicMovement,
  registerAvsDynamicMovement,
  type AvsAudioFrame,
  type AvsComponent,
  type AvsPresetAst,
} from '../src/avs/index.ts';

let checks = 0;
const payload = dynamicPayload('alpha=1', '', '', '', {
  bilinear: false, rectangular: true, gridWidth: 2, gridHeight: 2,
  blend: false, wrap: false, buffer: 0, noMove: true,
});
const decoded = decodeAvsDynamicMovement(payload);
equal(decoded.point, 'alpha=1', 'point script decoded');
equal(decoded.gridWidth, 2, 'grid width decoded');
equal(decoded.rectangular, true, 'rectangular mode decoded');
equal(decoded.noMove, true, 'no-move mode decoded');

const component: AvsComponent = {
  effectId: 43, apeId: null, payload, fileOffset: 0, path: '1',
  children: [], list: null, listCode: null,
};
const preset: AvsPresetAst = {
  version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: false,
  components: [component], byteLength: 0,
};
const registry = registerAvsDynamicMovement(new AvsEffectRegistry());
const executor = new AvsExecutor(preset, registry);
const framebuffer = new AvsFramebuffer(3, 3);
framebuffer.clear(0xffffff);
const stats = executor.render(framebuffer, emptyAudio());
equal(framebuffer.pixels[0], 0, 'no-move alpha mask clears current framebuffer');
equal(framebuffer.pixels[8], 0, 'mask covers final pixel');
equal(stats.rendered, 1, 'dynamic movement executed');

const goldenCases = [
  { width: 2, height: 2, bilinear: true, blend: false, wrap: false, hash: 824051977 },
  { width: 7, height: 5, bilinear: true, blend: false, wrap: true, hash: 611738712 },
  { width: 11, height: 8, bilinear: true, blend: true, wrap: false, hash: 3198723961 },
  { width: 13, height: 9, bilinear: true, blend: true, wrap: true, hash: 171445900 },
  { width: 17, height: 10, bilinear: false, blend: false, wrap: false, hash: 2194013787 },
  { width: 19, height: 12, bilinear: false, blend: true, wrap: true, hash: 1243571716 },
] as const;
for (const [caseIndex, test] of goldenCases.entries()) {
  const testPayload = dynamicPayload('x=x*0.73+0.19;y=y*0.67-0.13;alpha=0.37', '', '', '', {
    bilinear: test.bilinear, rectangular: true, gridWidth: 5, gridHeight: 4,
    blend: test.blend, wrap: test.wrap, buffer: 0, noMove: false,
  });
  const testPreset: AvsPresetAst = {
    version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: false,
    components: [{
      effectId: 43, apeId: null, payload: testPayload, fileOffset: 0, path: `golden:${caseIndex}`,
      children: [], list: null, listCode: null,
    }],
    byteLength: testPayload.length,
  };
  const testFramebuffer = new AvsFramebuffer(test.width, test.height, randomPixels(test.width * test.height, caseIndex + 1));
  const testExecutor = new AvsExecutor(testPreset, registerAvsDynamicMovement(new AvsEffectRegistry()));
  testExecutor.render(testFramebuffer, emptyAudio());
  equal(hashPixels(testFramebuffer.pixels), test.hash, `golden movement case ${caseIndex}`);
}

console.log(`avs-dynamic-movement-runtime-check: PASS (${checks} assertions)`);

interface Options {
  bilinear: boolean; rectangular: boolean; gridWidth: number; gridHeight: number;
  blend: boolean; wrap: boolean; buffer: number; noMove: boolean;
}
function dynamicPayload(
  point: string, frame: string, beat: string, init: string, options: Options,
): Uint8Array {
  const strings = [point, frame, beat, init].map(encodedString);
  const bytes = new Uint8Array(1 + strings.reduce((n, value) => n + 4 + value.length, 0) + 32);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  bytes[offset++] = 1;
  for (const value of strings) {
    view.setUint32(offset, value.length, true); offset += 4;
    bytes.set(value, offset); offset += value.length;
  }
  for (const value of [
    options.bilinear, options.rectangular, options.gridWidth, options.gridHeight,
    options.blend, options.wrap, options.buffer, options.noMove,
  ]) { view.setInt32(offset, Number(value), true); offset += 4; }
  return bytes;
}
function encodedString(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length + 1);
  for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i) & 255;
  return bytes;
}
function emptyAudio(): AvsAudioFrame {
  return {
    waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    beat: false, beatLevel: 0,
  };
}
function randomPixels(length: number, seed: number): Uint32Array {
  const pixels = new Uint32Array(length);
  let random = (seed * 0x9e3779b9) >>> 0;
  for (let index = 0; index < length; index++) {
    random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
    pixels[index] = random & 0x00ffffff;
  }
  return pixels;
}
function hashPixels(pixels: Uint32Array): number {
  let hash = 0x811c9dc5;
  for (const pixel of pixels) hash = Math.imul(hash ^ pixel, 0x01000193);
  return hash >>> 0;
}
function equal(actual: unknown, expected: unknown, label: string): void {
  checks++;
  if (actual !== expected) throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`);
}
