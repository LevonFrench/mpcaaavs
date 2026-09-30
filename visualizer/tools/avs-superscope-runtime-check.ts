import {
  AVS_AUDIO_SAMPLES,
  AvsEffectRegistry,
  AvsExecutor,
  AvsFramebuffer,
  decodeAvsSuperScope,
  registerAvsSuperScope,
  type AvsAudioFrame,
  type AvsComponent,
  type AvsPresetAst,
} from '../src/avs/index.ts';

let checks = 0;
const payload = superScopePayload(
  'x=i*2-1;y=0',
  '',
  '',
  'n=3',
  0,
  [0xff0000],
  false,
);
const decoded = decodeAvsSuperScope(payload);
equal(decoded.point, 'x=i*2-1;y=0', 'point script decoded');
equal(decoded.init, 'n=3', 'init script decoded');
equal(decoded.channel, 0, 'channel decoded');
equal(decoded.colors[0], 0xff0000, 'color decoded');
equal(decoded.lines, false, 'draw mode decoded');

const component: AvsComponent = {
  effectId: 36, apeId: null, payload, fileOffset: 0, path: '1',
  children: [], list: null, listCode: null,
};
const preset: AvsPresetAst = {
  version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: true,
  components: [component], byteLength: 0,
};
const registry = registerAvsSuperScope(new AvsEffectRegistry());
const executor = new AvsExecutor(preset, registry);
const framebuffer = new AvsFramebuffer(5, 1);
executor.render(framebuffer, emptyAudio());
equal(framebuffer.pixels[0], 0xfb0000, 'first point uses AVS 63/64 color phase');
equal(framebuffer.pixels[2], 0xfb0000, 'middle point rendered');
equal(framebuffer.pixels[4], 0, 'native coordinate +1 maps just outside framebuffer');

console.log(`avs-superscope-runtime-check: PASS (${checks} assertions)`);

function superScopePayload(
  point: string,
  frame: string,
  beat: string,
  init: string,
  channel: number,
  colors: readonly number[],
  lines: boolean,
): Uint8Array {
  const strings = [point, frame, beat, init].map(encodedString);
  const size = 1 + strings.reduce((sum, value) => sum + 4 + value.length, 0) + 12 + colors.length * 4;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  bytes[offset++] = 1;
  for (const value of strings) {
    view.setUint32(offset, value.length, true); offset += 4;
    bytes.set(value, offset); offset += value.length;
  }
  view.setInt32(offset, channel, true); offset += 4;
  view.setInt32(offset, colors.length, true); offset += 4;
  for (const color of colors) { view.setInt32(offset, color, true); offset += 4; }
  view.setInt32(offset, lines ? 1 : 0, true);
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

function equal(actual: unknown, expected: unknown, label: string): void {
  checks++;
  if (actual !== expected) throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`);
}
