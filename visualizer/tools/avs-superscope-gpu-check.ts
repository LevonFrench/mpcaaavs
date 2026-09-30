import {
  AVS_ENHANCED_SUPERSCOPE_GPU_CAPABILITY,
  EnhancedSuperScopeGpuGenerator,
  EnhancedSuperScopeGpuTerminalPass,
  compileEnhancedSuperScopeGpu,
} from '../src/avs/effects/superscope-gpu.ts';
import { AvsEelGlobalState } from '../src/avs/eel/vm.ts';
import { planTerminalEnhancedSuperScope } from '../src/avs/superscope-gpu-plan.ts';
import { AVS_AUDIO_SAMPLES, type AvsAudioFrame, type AvsComponent, type AvsPresetAst } from '../src/avs/types.ts';

let checks = 0;
const pure = compileEnhancedSuperScopeGpu(
  'phase=i*$pi*2+time;x=cos(phase)*(.4+v*.2);y=sin(phase)*(.4+v*.2);red=.5;green=.25;blue=.75;skip=below(abs(v),.01)',
);
assert(pure.eligible, 'point-independent script is GPU eligible');
if (!pure.eligible) throw new Error(pure.reason);
equal(pure.program.workgroupSize, 256, 'generator uses 256-wide workgroups');
equal(pure.program.outputStrideBytes, 16, 'GPU raster handoff is one packed 16-byte point');
assert(pure.program.uniformNames.includes('time'), 'frame variable becomes one scalar GPU input');
assert(pure.program.uniformNames.includes('drawmode'), 'unwritten output state is sampled once');
assert(pure.program.wgsl.includes('@compute @workgroup_size(256)'), 'compute entry generated');
assert(pure.program.wgsl.includes('points[index] = ScopePoint'), 'point output remains GPU resident');
equal(pure.program.usesHostAudio, false, 'pure point script avoids full host-audio upload');

const audioProgram = compileEnhancedSuperScopeGpu('x=i*2-1;y=getosc(i,.02,0)+getspec(i,.02,1)');
assert(audioProgram.eligible, 'read-only audio host calls are GPU eligible');
if (!audioProgram.eligible) throw new Error(audioProgram.reason);
equal(audioProgram.program.usesHostAudio, true, 'audio host dependency is explicit');
assert(audioProgram.program.wgsl.includes('fn avs_audio('), 'audio averaging runs inside compute shader');

rejected('phase+=.01;x=phase;y=0', 'point-to-point accumulator rejected');
rejected('x=rand(20);y=0', 'random state rejected');
rejected('x=megabuf(i);y=0', 'stateful memory rejected');
rejected('if(above(i,.5),assign(x,1),assign(x,-1));y=0', 'conditional mutation rejected');

// The analyzer is intentionally conservative under fuzz: every generated
// accumulator must reject, while a pure per-point equivalent must compile.
let seed = 0x4a17c9e3;
for (let index = 0; index < 256; index++) {
  seed = xorshift(seed);
  const scale = (seed & 1023) / 257 + .01;
  assert(compileEnhancedSuperScopeGpu(`x=i*${scale};y=v`).eligible, `pure fuzz ${index}`);
  assert(!compileEnhancedSuperScopeGpu(`x+=i*${scale};y=v`).eligible, `stateful fuzz ${index}`);
}

equal(AVS_ENHANCED_SUPERSCOPE_GPU_CAPABILITY.byteExact, false, 'enhanced lane never claims exactness');
equal(AVS_ENHANCED_SUPERSCOPE_GPU_CAPABILITY.lane, '120', 'enhanced lane is explicit');

// Mock resource test proves each frame uploads fixed-size audio/scalars only;
// generated O(point-count) output never crosses back to CPU.
const usage = { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4, UNIFORM: 8 };
Object.defineProperty(globalThis, 'GPUBufferUsage', { configurable: true, value: usage });
const writes: number[] = [];
let dispatches = 0;
const buffers: Array<{ size: number; destroyed: boolean; destroy(): void }> = [];
const device = {
  limits: { maxStorageBufferBindingSize: 16 * 1024 * 1024 },
  queue: { writeBuffer: (_buffer: unknown, _offset: number, data: ArrayBuffer | ArrayBufferView, dataOffset = 0, size?: number) => {
    const total = ArrayBuffer.isView(data) ? data.byteLength : data.byteLength;
    writes.push(size ?? total - dataOffset);
  } },
  createShaderModule: (descriptor: { code: string }) => ({ descriptor }),
  createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
  createBuffer: ({ size }: { size: number }) => {
    const buffer = { size, destroyed: false, destroy() { this.destroyed = true; } };
    buffers.push(buffer);
    return buffer;
  },
  createBindGroup: () => ({}),
} as unknown as GPUDevice;
const generator = new EnhancedSuperScopeGpuGenerator(device, pure.program, 1_000);
const count = generator.writeFrame({
  count: 777, width: 640, height: 360, xor: 128,
  audio: new Uint8Array(576), variables: { time: 2.5, drawmode: 1, linesize: 2 },
});
equal(count, 777, 'frame point count preserved');
equal(writes.length, 3, 'one fixed audio, scalar, and parameter upload');
equal(writes[0], 576 * 4, 'audio upload is fixed 2.25 KiB');
assert(writes.reduce((sum, value) => sum + value, 0) < 2_500, 'CPU to GPU traffic is independent of point count');
const encoder = {
  beginComputePass: () => ({
    setPipeline() {}, setBindGroup() {}, dispatchWorkgroups(value: number) { dispatches = value; }, end() {},
  }),
} as unknown as GPUCommandEncoder;
const dispatched = generator.encode(encoder, count);
equal(dispatches, 4, 'dispatch covers count without idle CPU point loop');
equal(dispatched.outputStrideBytes, 16, 'dispatch exposes GPU raster handoff format');
equal(dispatched.count, 777, 'dispatch reports bounded point count');
generator.destroy();
assert(buffers.every(buffer => buffer.destroyed), 'resident buffers destroyed');

const terminalComponent: AvsComponent = {
  effectId: 36, apeId: null, path: '0', fileOffset: 0, children: [], list: null, listCode: null,
  payload: scopePayload('x=i*2-1;y=v', '', '', 'n=33', false),
};
const terminalPreset: AvsPresetAst = {
  version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: true,
  components: [terminalComponent], byteLength: terminalComponent.payload.byteLength,
};
const planned = planTerminalEnhancedSuperScope(terminalPreset);
assert(planned.component === terminalComponent, 'terminal point-independent scope extracted');
equal(planned.cpuPreset.components.length, 0, 'enhanced terminal removed from CPU suffix');
equal(planTerminalEnhancedSuperScope({ ...terminalPreset, clearEveryFrame: false }).component, null, 'root feedback fails closed');
equal(planTerminalEnhancedSuperScope({
  ...terminalPreset, components: [{ ...terminalComponent, payload: scopePayload('x=i;y=v', '', '', 'n=33', true) }],
}).component, null, 'line raster stays ordered CPU');
equal(planTerminalEnhancedSuperScope({
  ...terminalPreset, components: [{ ...terminalComponent, payload: scopePayload('x+=i;y=v', '', '', 'n=33', false) }],
}).component, null, 'point accumulator stays ordered CPU');

if (!planned.program || !planned.config) throw new Error('terminal plan missing compiled state');
const beforeTerminalWrites = writes.length;
const terminal = new EnhancedSuperScopeGpuTerminalPass(
  device, planned.config, planned.program, new AvsEelGlobalState(), 1234, 1_000,
);
terminal.updateFrame(emptyAudio(), 640, 360);
equal(writes.length - beforeTerminalWrites, 4, 'live pass uploads selected audio, scalars, generator and raster params');
const liveDispatches: number[] = [];
let copiedBytes = 0;
const liveEncoder = {
  copyBufferToBuffer: (_source: unknown, _so: number, _target: unknown, _to: number, bytes: number) => { copiedBytes = bytes; },
  beginComputePass: () => ({
    setPipeline() {}, setBindGroup() {}, dispatchWorkgroups(value: number) { liveDispatches.push(value); }, end() {},
  }),
} as unknown as GPUCommandEncoder;
terminal.encode({ device, encoder: liveEncoder, width: 640, height: 360,
  source: {} as GPUBuffer, target: {} as GPUBuffer });
equal(copiedBytes, 640 * 360 * 4, 'terminal pass preserves CPU prefix before raster');
equal(liveDispatches.join(','), '1,1', '33 points generate then raster in resident compute passes');
terminal.destroy();

console.log(`avs-superscope-gpu-check: PASS (${checks} assertions)`);

function rejected(source: string, label: string): void {
  const result = compileEnhancedSuperScopeGpu(source);
  assert(!result.eligible, label);
}
function xorshift(value: number): number {
  value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
  return value >>> 0;
}
function assert(value: unknown, label: string): asserts value {
  checks++;
  if (!value) throw new Error(label);
}
function equal(actual: unknown, expected: unknown, label: string): void {
  checks++;
  if (actual !== expected) throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`);
}

function scopePayload(point: string, frame: string, beat: string, init: string, lines: boolean): Uint8Array {
  const scripts = [point, frame, beat, init].map(value => {
    const bytes = new Uint8Array(value.length + 1);
    for (let index = 0; index < value.length; index++) bytes[index] = value.charCodeAt(index) & 255;
    return bytes;
  });
  const bytes = new Uint8Array(1 + scripts.reduce((sum, script) => sum + 4 + script.length, 0) + 16);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  bytes[offset++] = 1;
  for (const script of scripts) {
    view.setUint32(offset, script.length, true); offset += 4;
    bytes.set(script, offset); offset += script.length;
  }
  view.setInt32(offset, 0, true); offset += 4;
  view.setInt32(offset, 1, true); offset += 4;
  view.setInt32(offset, 0x00ffffff, true); offset += 4;
  view.setInt32(offset, lines ? 1 : 0, true);
  return bytes;
}
function emptyAudio(): AvsAudioFrame {
  return {
    waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    beat: false, beatLevel: 0,
  };
}
