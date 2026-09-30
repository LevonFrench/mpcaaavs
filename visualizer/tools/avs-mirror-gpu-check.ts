import assert from 'node:assert/strict';
import {
  AVS_AUDIO_SAMPLES, AVS_EXACT_MIRROR_WGSL, AvsExecutor, AvsFramebuffer,
  ExactAvsMirrorCpuState, decodeAvsMirror, planExactAvsMirrorGpu,
  prepareExactAvsMirrorGpuFrame, registerAvsClassicEffects, renderExactAvsMirrorCpu,
  type AvsAudioFrame, type AvsComponent, type AvsMirrorConfig, type AvsPresetAst,
} from '../src/avs/index.ts';

let assertions = 0;
assert.deepEqual(decodeAvsMirror(payload([1, 31, 0, 1, 0])), { enabled: true, mode: 15, randomOnBeat: false, smooth: true, slower: 1 }); assertions++;
const base = mirrorConfig();
assert.equal(planExactAvsMirrorGpu(base, 640, 360, { terminal: true, mirrorInstances: 1 }).eligible, true); assertions++;
assert.match(planExactAvsMirrorGpu({ ...base, randomOnBeat: true }, 640, 360, { terminal: true, mirrorInstances: 1 }).reason!, /beat-random/); assertions++;
assert.match(planExactAvsMirrorGpu(base, 640, 360, { terminal: false, mirrorInstances: 1 }).reason!, /non-terminal/); assertions++;
assert.match(planExactAvsMirrorGpu(base, 640, 360, { terminal: true, mirrorInstances: 2 }).reason!, /shared/); assertions++;
assert.throws(() => prepareExactAvsMirrorGpuFrame({ mode: 1, smooth: true, divisor: [0, 0, 0, 16] }, 2, 2), /divisors/); assertions++;

for (const [width, height] of [[6, 4], [5, 5]] as const) for (let mode = 0; mode < 16; mode++) {
  const source = deterministicPixels(width * height, mode + width * 101);
  const frame = { mode, smooth: false, divisor: [0, 0, 0, 0] as const };
  assert.deepEqual(renderExactAvsMirrorCpu(source, width, height, frame), renderExistingOnce(source, width, height, mirrorConfig({ mode })), `static mode ${mode} ${width}x${height}`); assertions++;
}

const smoothConfig = mirrorConfig({ mode: 5, smooth: true, slower: 2 });
const cpuState = new ExactAvsMirrorCpuState(), existing = existingSequenceRenderer(7, 5, smoothConfig);
const observedDivisors: number[][] = [];
for (let frameIndex = 0; frameIndex < 20; frameIndex++) {
  const source = deterministicPixels(35, 0x7000 + frameIndex), frame = cpuState.next(smoothConfig); observedDivisors.push([...frame.divisor]);
  assert.deepEqual(renderExactAvsMirrorCpu(source, 7, 5, frame), existing(source), `smooth frame ${frameIndex}`); assertions++;
}
assert.deepEqual(observedDivisors.slice(0, 5).map(value => [value[0], value[2]]), [[1, 1], [1, 1], [2, 2], [2, 2], [3, 3]]); assertions++;
assert.match(AVS_EXACT_MIRROR_WGSL, /right_after=apply_direction/); assertions++;
assert.match(AVS_EXACT_MIRROR_WGSL, /after_top_to_bottom\(x,mirrored\)/); assertions++;
assert.match(AVS_EXACT_MIRROR_WGSL, /\(current&255u\)>>4u/); assertions++;
console.log(`avs-mirror-gpu-check: PASS (${assertions} assertions)`);

function mirrorConfig(overrides: Partial<AvsMirrorConfig> = {}): AvsMirrorConfig { return { enabled: true, mode: 5, randomOnBeat: false, smooth: false, slower: 4, ...overrides }; }
function renderExistingOnce(source: Uint32Array, width: number, height: number, config: AvsMirrorConfig): Uint32Array { return existingSequenceRenderer(width, height, config)(source); }
function existingSequenceRenderer(width: number, height: number, config: AvsMirrorConfig): (source: Uint32Array) => Uint32Array {
  const component: AvsComponent = { effectId: 26, apeId: null, payload: encode(config), fileOffset: 0, path: '0', children: [], list: null, listCode: null };
  const preset: AvsPresetAst = { version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: false, components: [component], byteLength: component.payload.length };
  const executor = new AvsExecutor(preset, registerAvsClassicEffects());
  return source => { const framebuffer = new AvsFramebuffer(width, height, new Uint32Array(source)); executor.render(framebuffer, silentAudio()); return new Uint32Array(framebuffer.pixels); };
}
function encode(config: AvsMirrorConfig): Uint8Array { return payload([config.enabled ? 1 : 0, config.mode, config.randomOnBeat ? 1 : 0, config.smooth ? 1 : 0, config.slower]); }
function payload(values: readonly number[]): Uint8Array { const bytes = new Uint8Array(values.length * 4), view = new DataView(bytes.buffer); values.forEach((value, index) => view.setInt32(index * 4, value, true)); return bytes; }
function silentAudio(): AvsAudioFrame { return { waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)], spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)], beat: false, beatLevel: 0 }; }
function deterministicPixels(count: number, seed: number): Uint32Array { const output = new Uint32Array(count); let state = seed >>> 0; for (let index = 0; index < count; index++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; output[index] = state >>> 0; } return output; }
