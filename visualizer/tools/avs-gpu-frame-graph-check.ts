import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { copyAvsPixelsToRgba } from '../src/avs-presentation.ts';
import {
  AVS_GPU_TERMINAL_CAPABILITY,
  AVS_PACKED_PRESENT_WGSL,
  PackedAvsGpuFrameGraph,
  assertAvsPassCompatible,
  assertAvsPresentCanvasConfiguration,
  assertPackedAvsFrame,
  avsPresentCanvasConfiguration,
  planPackedAvsFrameGraph,
  unpackAvsPixel,
  type AvsFrameGraphTiming,
} from '../src/avs/gpu-frame-graph.ts';

const plan = planPackedAvsFrameGraph(640, 360, 1 << 20);
assert.deepEqual(plan, {
  width: 640, height: 360, pixels: 230_400,
  framebufferBytes: 921_600, residentBytes: 1_843_200,
});
assert.throws(() => planPackedAvsFrameGraph(640, 360, 900_000), /adapter limit/);
assert.throws(() => planPackedAvsFrameGraph(0, 360), /Invalid/);
assert.equal(AVS_GPU_TERMINAL_CAPABILITY.lane, 'exact');
assert.equal(AVS_GPU_TERMINAL_CAPABILITY.byteExact, true);
assert.doesNotThrow(() => assertAvsPassCompatible('exact', AVS_GPU_TERMINAL_CAPABILITY));
assert.throws(() => assertAvsPassCompatible('exact', {
  id: 'hardware-linear-movement', backend: 'webgpu', lane: '120', byteExact: false,
  reason: 'hardware filtering changes AVS integer truncation',
}), /explicit 120 lane/);
assert.doesNotThrow(() => assertAvsPassCompatible('120', {
  id: 'hardware-linear-movement', backend: 'webgpu', lane: '120', byteExact: false,
  reason: 'hardware filtering changes AVS integer truncation',
}));
assert.match(AVS_PACKED_PRESENT_WGSL, /var<storage, read> avs_pixels: array<u32>/);
assert.match(AVS_PACKED_PRESENT_WGSL, /pixel >> 16u/);
assert.doesNotMatch(AVS_PACKED_PRESENT_WGSL, /textureSample|textureLoad|sampler/);

// Differentially verify the terminal integer unpack contract against the
// existing CPU oracle over deterministic edge values and 65,536 seeded words.
const pixels = new Uint32Array(65_544);
pixels.set([0, 0xffffff, 0xff0000, 0x00ff00, 0x0000ff, 0x123456, 0x010101, 0xfefefe]);
let state = 0x9e3779b9;
for (let index = 8; index < pixels.length; index++) {
  state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
  pixels[index] = state & 0x00ffffff;
}
const rgba = new Uint8ClampedArray(pixels.length * 4);
copyAvsPixelsToRgba(pixels, rgba);
for (let index = 0; index < pixels.length; index++) {
  const expected = unpackAvsPixel(pixels[index]!);
  const offset = index * 4;
  assert.deepEqual(Array.from(rgba.subarray(offset, offset + 4)), expected);
}
assert.doesNotThrow(() => assertPackedAvsFrame(pixels, pixels.length));
assert.throws(() => assertPackedAvsFrame(pixels, pixels.length - 1), /expected/);

// VQ10 colour guardrail. The terminal writes f32(c) / 255 into an 8-bit unorm
// target; the unorm store must return exactly c for every channel value, and
// the present configuration must not add any colour transform on top.
for (let channel = 0; channel <= 255; channel++) {
  const stored = Math.round(Math.fround(Math.fround(channel) / 255) * 255);
  assert.equal(stored, channel, `unorm8 round trip of ${channel}`);
}
const guardDevice = {} as GPUDevice;
for (const format of ['bgra8unorm', 'rgba8unorm'] as const) {
  const configuration = avsPresentCanvasConfiguration(guardDevice, format);
  assert.equal(configuration.format, format);
  assert.equal(configuration.alphaMode, 'opaque');
  assert.equal(configuration.colorSpace, 'srgb');
  assert.equal(configuration.viewFormats, undefined);
  assert.equal((configuration as { toneMapping?: unknown }).toneMapping, undefined);
}
const badConfigurations: readonly [Record<string, unknown>, RegExp][] = [
  [{ format: 'bgra8unorm-srgb' }, /re-encode/],
  [{ format: 'rgba16float' }, /8-bit unorm/],
  [{ format: 'bgra8unorm', viewFormats: ['bgra8unorm-srgb'] }, /viewFormats/],
  [{ format: 'bgra8unorm', alphaMode: 'premultiplied' }, /opaque/],
  [{ format: 'bgra8unorm', colorSpace: 'display-p3' }, /srgb/],
  [{ format: 'bgra8unorm', toneMapping: { mode: 'extended' } }, /SDR/],
];
for (const [bad, pattern] of badConfigurations) {
  assert.throws(() => assertAvsPresentCanvasConfiguration({ device: guardDevice, ...bad } as unknown as GPUCanvasConfiguration), pattern);
}

await checkFrameGraphLifecycle();

// Deterministic 640x360 terminal CPU-preparation microbenchmark. This reports
// only the work replaced by the GPU ingress, never GPU execution time.
const full = new Uint32Array(plan.pixels);
for (let index = 0; index < full.length; index++) full[index] = (index * 0x45d9f3b) & 0x00ffffff;
const fullRgba = new Uint8ClampedArray(plan.framebufferBytes);
for (let warmup = 0; warmup < 20; warmup++) copyAvsPixelsToRgba(full, fullRgba);
const oldSamples = measure(100, () => copyAvsPixelsToRgba(full, fullRgba));
const directSamples = measure(100, () => assertPackedAvsFrame(full, plan.pixels));
const oldMedian = median(oldSamples);
const directMedian = median(directSamples);
assert.ok(oldMedian > directMedian, `expected direct packed ingress ${directMedian}ms < RGBA copy ${oldMedian}ms`);

console.log(
  'avs-gpu-frame-graph-check: exact packed-u32 terminal contract, colour guardrail and ' +
  'device-reuse/loss/timestamp lifecycle pass; ' +
  `640x360 CPU preparation median ${oldMedian.toFixed(4)} ms -> ${directMedian.toFixed(4)} ms ` +
  `(GPU upload/execution deliberately excluded)`,
);

function measure(iterations: number, run: () => void): number[] {
  const samples: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  return samples;
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return (sorted[middle - 1]! + sorted[middle]!) * 0.5;
}

/**
 * Drives the real PackedAvsGpuFrameGraph host code against a recording fake
 * WebGPU. It proves lifecycle wiring only (device reuse on resize, loss and
 * error reporting, timestamp plumbing); pixels are covered by the browser check.
 */
async function checkFrameGraphLifecycle(): Promise<void> {
  const fake = installFakeWebGpu();
  try {
    const losses: string[] = [];
    const errors: string[] = [];
    const timings: AvsFrameGraphTiming[] = [];
    const canvas = fake.canvas(1, 1);
    const graph = await PackedAvsGpuFrameGraph.create({
      canvas: canvas as unknown as OffscreenCanvas, width: 640, height: 360, timestamps: true,
      onTiming: (timing) => timings.push(timing),
      onDeviceLost: (reason) => losses.push(reason),
      onUncapturedError: (message) => errors.push(message),
    });
    assert.ok(graph);
    assert.equal(fake.requestDeviceCalls.length, 1);
    assert.deepEqual(fake.requestDeviceCalls[0], { requiredFeatures: ['timestamp-query'] });
    assert.ok(graph.timer?.enabled);
    assert.equal(canvas.width, 640);
    assert.equal(canvas.height, 360);
    assert.doesNotThrow(() => assertAvsPresentCanvasConfiguration(fake.configurations.at(-1)!));
    assert.equal(fake.configurations.at(-1)!.colorSpace, 'srgb');
    const firstFramebuffers = fake.buffers.filter((buffer) => /^AVS frame graph (primary|secondary)$/.test(buffer.label));
    assert.deepEqual(firstFramebuffers.map((buffer) => buffer.size), [921_600, 921_600]);

    // One external node plus the terminal: both are timed, and the readback
    // is never awaited by the frame path.
    const encodedSizes: [number, number][] = [];
    const node = graph.compileExternalPass(() => ({
      capability: AVS_GPU_TERMINAL_CAPABILITY,
      encode: (context) => { encodedSizes.push([context.width, context.height]); },
    }));
    graph.uploadExecuteAndPresent(new Uint32Array(640 * 360), [node]);
    const terminal = fake.renderPasses.at(-1)!;
    const attachment = Array.from(terminal.colorAttachments)[0]!;
    assert.equal(terminal.label, 'AVS exact terminal pass');
    assert.deepEqual(attachment.clearValue, { r: 0, g: 0, b: 0, a: 1 });
    assert.equal(attachment.loadOp, 'clear');
    assert.equal(attachment.storeOp, 'store');
    assert.ok(terminal.timestampWrites, 'terminal pass carries timestamp writes');
    assert.equal(fake.computePasses, 2, 'one begin and one end marker around the node');
    assert.equal(graph.gpuMs, undefined, 'no GPU time before the readback lands');
    await flushMicrotasks();
    assert.equal(graph.gpuMs, 2, 'one 1 ms node span plus the 1 ms terminal pass');
    assert.ok(timings.some((timing) => timing.gpuCompleteMs !== undefined));

    // Resize keeps the device: new resident buffers at the new size, the old
    // ones destroyed, canvas and width uniform updated, nothing requested.
    assert.equal(graph.resize(640, 360), false);
    assert.equal(graph.resize(800, 450), true);
    assert.equal(fake.requestAdapterCalls, 1);
    assert.equal(fake.requestDeviceCalls.length, 1);
    assert.ok(firstFramebuffers.every((buffer) => buffer.destroyed));
    const live = fake.buffers.filter((buffer) => !buffer.destroyed && /^AVS frame graph (primary|secondary)$/.test(buffer.label));
    assert.deepEqual(live.map((buffer) => buffer.size), [800 * 450 * 4, 800 * 450 * 4]);
    assert.equal(fake.widthWrites.at(-1), 800);
    assert.equal(canvas.width, 800);
    assert.equal(canvas.height, 450);
    assert.deepEqual(graph.plan, planPackedAvsFrameGraph(800, 450));
    assert.doesNotThrow(() => assertAvsPresentCanvasConfiguration(fake.configurations.at(-1)!));
    assert.throws(() => graph.resize(0, 450), /Invalid/);
    assert.deepEqual(graph.plan, planPackedAvsFrameGraph(800, 450), 'a rejected size leaves the graph intact');
    assert.equal(graph.resize(800, 450, '120'), true, 'a lane change needs no new device');
    assert.equal(graph.lane, '120');
    graph.uploadExecuteAndPresent(new Uint32Array(800 * 450), [node]);
    assert.deepEqual(encodedSizes.at(-1), [800, 450]);

    // Uncaptured errors and device loss reach the host; destroy() does not
    // masquerade as a loss.
    fake.devices[0]!.fireUncapturedError('Buffer used in submit while destroyed');
    assert.deepEqual(errors, ['Buffer used in submit while destroyed']);
    fake.devices[0]!.loseDevice('unknown', 'TDR');
    await flushMicrotasks();
    assert.deepEqual(losses, ['unknown: TDR']);
    assert.equal(graph.lost, 'unknown: TDR');
    graph.destroy();

    const quietLosses: string[] = [];
    const plain = await PackedAvsGpuFrameGraph.create({
      canvas: fake.canvas(1, 1) as unknown as OffscreenCanvas, width: 32, height: 16,
      onDeviceLost: (reason) => quietLosses.push(reason),
    });
    assert.ok(plain);
    assert.equal(fake.requestDeviceCalls.at(-1), undefined, 'no features requested unless timestamps are asked for');
    assert.equal(plain.timer, null);
    const computeBefore = fake.computePasses;
    plain.uploadAndPresent(new Uint32Array(32 * 16));
    assert.equal(fake.computePasses, computeBefore, 'untimed frames encode no marker passes');
    assert.equal(fake.renderPasses.at(-1)!.timestampWrites, undefined);
    plain.destroy();
    await flushMicrotasks();
    assert.deepEqual(quietLosses, []);
  } finally {
    fake.uninstall();
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

interface FakeBuffer {
  readonly label: string;
  readonly size: number;
  destroyed: boolean;
  destroy(): void;
  mapAsync(): Promise<void>;
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  unmap(): void;
}

interface FakeDeviceControl {
  fireUncapturedError(message: string): void;
  loseDevice(reason: string, message: string): void;
}

function installFakeWebGpu() {
  const buffers: FakeBuffer[] = [];
  const configurations: GPUCanvasConfiguration[] = [];
  const renderPasses: GPURenderPassDescriptor[] = [];
  const widthWrites: number[] = [];
  const requestDeviceCalls: unknown[] = [];
  const devices: FakeDeviceControl[] = [];
  const counters = { computePasses: 0, requestAdapterCalls: 0 };
  const globals = globalThis as Record<string, unknown>;
  const previous = {
    usage: Object.getOwnPropertyDescriptor(globalThis, 'GPUBufferUsage'),
    map: Object.getOwnPropertyDescriptor(globalThis, 'GPUMapMode'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  };
  globals.GPUBufferUsage = {
    MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
    VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
  };
  globals.GPUMapMode = { READ: 1, WRITE: 2 };
  const pass = () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, draw() {}, end() {} });
  const createDevice = () => {
    let resolveLost!: (info: { reason: string; message: string }) => void;
    const lost = new Promise<{ reason: string; message: string }>((resolve) => { resolveLost = resolve; });
    const listeners: ((event: unknown) => void)[] = [];
    const device = {
      limits: { maxStorageBufferBindingSize: 1 << 28 },
      lost,
      queue: {
        writeBuffer(buffer: FakeBuffer, _offset: number, data: ArrayBufferView | ArrayBuffer) {
          if (buffer.label !== 'AVS frame graph width') return;
          const bytes = ArrayBuffer.isView(data) ? data.buffer : data;
          widthWrites.push(new Uint32Array(bytes)[0]!);
        },
        submit() {},
        onSubmittedWorkDone: () => Promise.resolve(),
      },
      createBuffer(descriptor: GPUBufferDescriptor): FakeBuffer {
        const buffer: FakeBuffer = {
          label: descriptor.label ?? '', size: descriptor.size, destroyed: false,
          destroy() { buffer.destroyed = true; },
          mapAsync: () => Promise.resolve(),
          // Synthetic timestamps: pair i begins at i*10 ms and lasts exactly 1 ms.
          getMappedRange(_offset = 0, size = descriptor.size) {
            const words = new BigUint64Array(size / 8);
            for (let index = 0; index + 1 < words.length; index += 2) {
              words[index] = BigInt(index * 5_000_000);
              words[index + 1] = BigInt(index * 5_000_000 + 1_000_000);
            }
            return words.buffer;
          },
          unmap() {},
        };
        buffers.push(buffer);
        return buffer;
      },
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createBindGroup: (descriptor: GPUBindGroupDescriptor) => ({ descriptor }),
      createQuerySet: () => ({ destroy() {} }),
      createCommandEncoder: () => ({
        beginComputePass() { counters.computePasses++; return pass(); },
        beginRenderPass(descriptor: GPURenderPassDescriptor) { renderPasses.push(descriptor); return pass(); },
        resolveQuerySet() {},
        copyBufferToBuffer() {},
        finish: () => ({}),
      }),
      addEventListener(type: string, listener: (event: unknown) => void) {
        if (type === 'uncapturederror') listeners.push(listener);
      },
      destroy() { resolveLost({ reason: 'destroyed', message: '' }); },
    };
    devices.push({
      fireUncapturedError: (message) => { for (const listener of listeners) listener({ error: { message } }); },
      loseDevice: (reason, message) => resolveLost({ reason, message }),
    });
    return device;
  };
  const adapter = {
    features: new Set(['timestamp-query']),
    async requestDevice(descriptor?: unknown) { requestDeviceCalls.push(descriptor); return createDevice(); },
  };
  const gpu = {
    async requestAdapter() { counters.requestAdapterCalls++; return adapter; },
    getPreferredCanvasFormat: () => 'bgra8unorm',
  };
  Object.defineProperty(globalThis, 'navigator', { value: { gpu }, configurable: true, writable: true });
  const restore = (name: string, descriptor: PropertyDescriptor | undefined) => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globals[name];
  };
  return {
    buffers, configurations, renderPasses, widthWrites, requestDeviceCalls, devices,
    get computePasses() { return counters.computePasses; },
    get requestAdapterCalls() { return counters.requestAdapterCalls; },
    canvas(width: number, height: number) {
      const context = {
        configure(configuration: GPUCanvasConfiguration) { configurations.push(configuration); },
        unconfigure() {},
        getCurrentTexture: () => ({ createView: () => ({}) }),
      };
      return { width, height, getContext: () => context };
    },
    uninstall() {
      restore('GPUBufferUsage', previous.usage);
      restore('GPUMapMode', previous.map);
      restore('navigator', previous.navigator);
    },
  };
}
