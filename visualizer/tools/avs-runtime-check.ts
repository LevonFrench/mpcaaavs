import {
  AVS_AUDIO_SAMPLES,
  AvsCompatibilityRuntime,
  type AvsComponent,
  type AvsPresetAst,
} from '../src/avs/index.ts';

let checks = 0;
const payload = new Uint8Array(20);
const view = new DataView(payload.buffer);
view.setInt32(0, 1, true);
view.setInt32(4, 0x112233, true);
const component: AvsComponent = {
  effectId: 25, apeId: null, payload, fileOffset: 0, path: '1',
  children: [], list: null, listCode: null,
};
const preset: AvsPresetAst = {
  version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: false,
  components: [component], byteLength: 0,
};
const runtime = new AvsCompatibilityRuntime(preset, 2, 1);
const frame = runtime.render();
equal(frame.framebuffer.pixels[0], 0x112233, 'default registry executes Clear Screen');
equal(frame.stats.rendered, 1, 'effect execution reported');
const rgba = runtime.rgbaBytes();
equal(Array.from(rgba).join(','), '17,34,51,255,17,34,51,255', 'packed RGB converts to RGBA');
runtime.resize(1, 2);
equal(runtime.framebuffer.pixels.length, 2, 'runtime resize recreates compatibility surface');

const waveform = [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)] as const;
const spectrum = [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)] as const;
runtime.pushHostAudio(waveform, spectrum);
equal(runtime.renderHostFrame().framebuffer.width, 1, 'host-audio render path executes');

console.log(`avs-runtime-check: PASS (${checks} assertions)`);
function equal(actual: unknown, expected: unknown, label: string): void {
  checks++;
  if (actual !== expected) throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`);
}
