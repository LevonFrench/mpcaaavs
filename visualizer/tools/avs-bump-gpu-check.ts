import assert from 'node:assert/strict';
import {
  AVS_AUDIO_SAMPLES, AvsEffectRegistry, AvsExecutor, AvsFramebuffer,
  assessExactGpuBump, buildExactAvsBumpWgsl, prepareExactAvsBumpGpuFrame,
  registerAvsBump, renderExactAvsBumpCpu,
  type AvsAudioFrame, type AvsBumpConfig, type AvsComponent, type AvsPresetAst,
} from '../src/avs/index.ts';

let assertions = 0;
const base = bumpConfig();
assert.deepEqual(assessExactGpuBump(base, { terminal: true }), {
  eligible: true, reason: 'terminal current-frame Bump has independent output pixels',
}); assertions++;
assert.match(assessExactGpuBump({ ...base, enabled: false }, { terminal: true }).reason, /disabled/); assertions++;
assert.match(assessExactGpuBump(base, { terminal: false }).reason, /non-terminal/); assertions++;
assert.match(assessExactGpuBump({ ...base, buffer: 1 }, { terminal: true }).reason, /global depth/); assertions++;
assert.deepEqual([...prepareExactAvsBumpGpuFrame({ currentDepth: 100, lightX: 5, lightY: 4 }, 10, 8)], [10, 8, 5, 4, 256, 0, 0, 0]); assertions++;
assert.throws(() => prepareExactAvsBumpGpuFrame({ currentDepth: 1, lightX: -1, lightY: 0 }, 2, 2), /lightX/); assertions++;
assert.throws(() => prepareExactAvsBumpGpuFrame({ currentDepth: Number.NaN, lightX: 0, lightY: 0 }, 2, 2), /finite/); assertions++;

for (const overrides of [
  {}, { invertDepth: true }, { showLight: true }, { additive: true }, { average: true },
  { additive: true, average: true }, { depth: -30 },
] satisfies Array<Partial<AvsBumpConfig>>) {
  const config = bumpConfig(overrides);
  const source = deterministicPixels(19 * 13, assertions + 1);
  // Force the current-frame zero-neighbor suppression and show-light interaction.
  source.fill(0, 5 * 19 + 5, 5 * 19 + 10);
  const expected = renderExistingBump(source, 19, 13, config);
  const actual = renderExactAvsBumpCpu(source, 19, 13, config, { currentDepth: config.depth, lightX: 9, lightY: 6 });
  assert.deepEqual(actual, expected, `CPU pixel oracle differs for ${JSON.stringify(overrides)}`); assertions++;
}

const shader = buildExactAvsBumpWgsl(bumpConfig({ showLight: true, invertDepth: true, additive: true }));
assert.match(shader, /left\|right\|above\|below/); assertions++;
assert.match(shader, /min\(i32\(pixel&255u\)\+amount,254\)/); assertions++;
assert.match(shader, /additive\(lit, original\)/); assertions++;
assert.match(shader, /i32\(x\)==params\.light_x/); assertions++;

console.log(`avs-bump-gpu-check: PASS (${assertions} assertions)`);

function bumpConfig(overrides: Partial<AvsBumpConfig> = {}): AvsBumpConfig {
  return {
    enabled: true, onBeat: false, beatDurationFrames: 15, depth: 100, beatDepth: 100,
    additive: false, average: false, frame: 'x=.5;y=.5;bi=1', beat: '', init: '',
    showLight: false, invertDepth: false, oldStyle: false, buffer: 0, ...overrides,
  };
}
function renderExistingBump(source: Uint32Array, width: number, height: number, config: AvsBumpConfig): Uint32Array {
  const component: AvsComponent = { effectId: 29, apeId: null, payload: encode(config), fileOffset: 0, path: '0', children: [], list: null, listCode: null };
  const preset: AvsPresetAst = { version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: false, components: [component], byteLength: component.payload.length };
  const framebuffer = new AvsFramebuffer(width, height, new Uint32Array(source));
  new AvsExecutor(preset, registerAvsBump(new AvsEffectRegistry())).render(framebuffer, silentAudio());
  return new Uint32Array(framebuffer.pixels);
}
function encode(config: AvsBumpConfig): Uint8Array {
  const text = new TextEncoder();
  const strings = [config.frame, config.beat, config.init].map(value => text.encode(`${value}\0`));
  const payload = new Uint8Array(28 + strings.reduce((sum, value) => sum + 4 + value.length, 0) + 16);
  const view = new DataView(payload.buffer); let offset = 0;
  for (const value of [config.enabled ? 1 : 0, config.onBeat ? 1 : 0, config.beatDurationFrames, config.depth, config.beatDepth, config.additive ? 1 : 0, config.average ? 1 : 0]) {
    view.setInt32(offset, value, true); offset += 4;
  }
  for (const value of strings) { view.setInt32(offset, value.length, true); offset += 4; payload.set(value, offset); offset += value.length; }
  for (const value of [config.showLight ? 1 : 0, config.invertDepth ? 1 : 0, config.oldStyle ? 1 : 0, config.buffer]) {
    view.setInt32(offset, value, true); offset += 4;
  }
  return payload;
}
function silentAudio(): AvsAudioFrame {
  return { waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)], spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)], beat: false, beatLevel: 0 };
}
function deterministicPixels(count: number, seed: number): Uint32Array {
  const result = new Uint32Array(count); let state = (0x9e3779b9 ^ seed) >>> 0;
  for (let index = 0; index < count; index++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; result[index] = state & 0x00ffffff; }
  return result;
}
