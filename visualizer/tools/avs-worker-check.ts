import assert from 'node:assert/strict';
import { AvsWorkerRenderer, fillAvsPcm, SingleFrameGate } from '../src/avs-worker-client.ts';
import type { AudioSnapshot } from '../src/contracts.ts';
import type { AvsWorkerRequest, AvsWorkerResponse } from '../src/avs-worker-protocol.ts';
import type { AvsPresetAst } from '../src/avs/types.ts';

const gate = new SingleFrameGate();
assert.equal(gate.tryBegin(), true);
for (let i = 0; i < 1_000; i++) assert.equal(gate.tryBegin(), false);
assert.equal(gate.busy, true);
gate.finish();
assert.equal(gate.tryBegin(), true);
gate.finish();

const waveform = new Float32Array([1, -1, 0.5, -0.5]);
const pcm = new Float32Array(576 * 2);
fillAvsPcm(waveform, pcm);
assert.equal(pcm[0], 1);
assert.equal(pcm[575], 0.5);
assert.equal(pcm[576], -1);
assert.equal(pcm[1151], -0.5);
assert.throws(() => fillAvsPcm(waveform, new Float32Array(2)), /1152 samples/);

// Exercise the real client seam with a deterministic worker port. Two rAF-like
// calls while the first render is pending produce one message, not a backlog.
class FakeWorker {
  onmessage: ((event: MessageEvent<AvsWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly messages: AvsWorkerRequest[] = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;
  postMessage(message: AvsWorkerRequest, transfer: Transferable[] = []): void {
    this.messages.push(message);
    this.transfers.push(transfer);
  }
  terminate(): void { this.terminated = true; }
  emit(message: AvsWorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<AvsWorkerResponse>);
  }
}

const fake = new FakeWorker();
let draws = 0;
const client = new AvsWorkerRenderer({
  canvas: { width: 0, height: 0 } as HTMLCanvasElement,
  context: { drawImage() { draws++; } } as unknown as CanvasRenderingContext2D,
  createWorker: () => fake,
});
const loading = client.load(new Uint8Array([1, 2, 3]), 640, 360);
const parsedPreset: AvsPresetAst = {
  version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: false,
  components: [], byteLength: 3,
};
client.setControls([{ path: '1.2', muted: true }]);
fake.emit({ type: 'ready', generation: 1, unsupported: 0, preset: parsedPreset });
await loading;
assert.equal(client.preset, parsedPreset);
const controlsMessage = fake.messages.find((message) => message.type === 'controls');
assert.deepEqual(controlsMessage, {
  type: 'controls', generation: 1, revision: 1,
  controls: [{ path: '1.2', muted: true }],
});
client.setComponentControl('1.2', { solo: true });
assert.deepEqual(fake.messages.at(-1), {
  type: 'controls', generation: 1, revision: 2,
  controls: [{ path: '1.2', muted: true, solo: true }],
});
const audio = { waveform } as AudioSnapshot;
assert.equal(client.render(audio, 640, 360), true);
assert.equal(client.render(audio, 640, 360), false);
const renderMessages = fake.messages.filter((message) => message.type === 'render');
assert.equal(renderMessages.length, 1);
const request = renderMessages[0]!;
assert.equal(request.type, 'render');
let closed = false;
fake.emit({
  type: 'frame', generation: 1, sequence: request.sequence,
  pcm: request.pcm, bitmap: { close() { closed = true; } } as ImageBitmap,
  width: 640, height: 360, unsupported: 0, renderMs: 12,
  effectMs: 10.5, presenter: 'webgpu-exact', uploadMs: 0.4, encodeSubmitMs: 0.2,
  gpuEffectPasses: 2, gpuEffectPlan: '2 exact terminal Blur passes moved to resident WebGPU',
});
assert.equal(draws, 1);
assert.equal(closed, true);
assert.equal(client.lastRenderMs, 12);
assert.equal(client.lastEffectMs, 10.5);
assert.equal(client.presenter, 'webgpu-exact');
assert.equal(client.lastUploadMs, 0.4);
assert.equal(client.lastEncodeSubmitMs, 0.2);
assert.equal(client.gpuEffectPasses, 2);
assert.match(client.gpuEffectPlan, /2 exact terminal Blur/);
assert.equal(client.render(audio, 640, 360), true);
client.dispose();
assert.equal(fake.terminated, true);

// Starting a newer load deliberately rejects the older promise but leaves the
// worker usable. Hosts must treat this as cancellation, not worker failure.
const supersedeWorker = new FakeWorker();
const supersedeClient = new AvsWorkerRenderer({
  canvas: { width: 0, height: 0 } as HTMLCanvasElement,
  context: { drawImage() {} } as unknown as CanvasRenderingContext2D,
  createWorker: () => supersedeWorker,
});
const obsoleteLoad = supersedeClient.load(new Uint8Array([1]), 320, 180);
const currentLoad = supersedeClient.load(new Uint8Array([2]), 640, 360);
await assert.rejects(obsoleteLoad, /AVS preset load superseded/);
supersedeWorker.emit({ type: 'ready', generation: 2, unsupported: 0, preset: parsedPreset });
await currentLoad;
assert.equal(supersedeClient.active, true);
assert.equal(supersedeWorker.terminated, false);
supersedeClient.dispose();

console.log('avs-worker-check: worker client, one-frame backpressure and allocation-free PCM resampling pass');
