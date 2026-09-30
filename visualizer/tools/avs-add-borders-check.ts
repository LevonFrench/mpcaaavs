import {
  AVS_AUDIO_SAMPLES, AVS_ADD_BORDERS_APE_ID, AvsEffectRegistry, AvsExecutor,
  AvsFramebuffer, decodeAvsAddBorders, registerAvsAddBorders,
  type AvsAudioFrame, type AvsComponent, type AvsPresetAst,
} from '../src/avs/index.ts';
let checks = 0;
const payload = new Uint8Array(12);
const view = new DataView(payload.buffer);
view.setInt32(0, 1, true); view.setInt32(4, 0x123456, true); view.setInt32(8, 1, true);
const config = decodeAvsAddBorders(payload);
equal(config.color, 0x123456, 'color decoded'); equal(config.size, 1, 'size decoded');
const component: AvsComponent = { effectId: 16384, apeId: AVS_ADD_BORDERS_APE_ID, payload,
  fileOffset: 0, path: '1', children: [], list: null, listCode: null };
const preset: AvsPresetAst = { version: 2, header: 'Nullsoft AVS Preset 0.2\u001a',
  clearEveryFrame: false, components: [component], byteLength: 0 };
const framebuffer = new AvsFramebuffer(3, 3); framebuffer.clear(0xffffff);
new AvsExecutor(preset, registerAvsAddBorders(new AvsEffectRegistry())).render(framebuffer, audio());
equal(framebuffer.pixels[0], 0x123456, 'border pixel painted');
equal(framebuffer.pixels[4], 0xffffff, 'interior preserved');
console.log(`avs-add-borders-check: PASS (${checks} assertions)`);
function audio(): AvsAudioFrame { return { waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
  spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)], beat: false, beatLevel: 0 }; }
function equal(actual: unknown, expected: unknown, label: string): void { checks++; if (actual !== expected) throw new Error(`${label}: ${String(actual)} != ${String(expected)}`); }
