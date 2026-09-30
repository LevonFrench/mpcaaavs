import { strict as assert } from 'node:assert';
import {
  choosePngEncodeSlots,
  encodeRgb24Png,
  frameFileName,
  packRgbScanlines,
  rgbScanlineBytes,
} from '../src/offline-png.ts';
import { OfflineRenderClient, directoryIsNonempty } from '../src/offline-render-client.ts';
import type { OfflineRenderWorkerRequest, OfflineRenderWorkerResponse } from '../src/offline-render-protocol.ts';

class EmptyDirectory {
  async *values(): AsyncIterableIterator<FileSystemHandle> { /* empty */ }
}

class NonemptyDirectory {
  async *values(): AsyncIterableIterator<FileSystemHandle> {
    yield { kind: 'file', name: 'already-here.txt', isSameEntry: async () => false } as FileSystemHandle;
  }
}

class MockWorker {
  onmessage: ((event: MessageEvent<OfflineRenderWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: OfflineRenderWorkerRequest[] = [];
  terminated = false;
  postMessage(message: OfflineRenderWorkerRequest): void { this.sent.push(message); }
  terminate(): void { this.terminated = true; }
  emit(message: OfflineRenderWorkerResponse): void { this.onmessage?.({ data: message } as MessageEvent<OfflineRenderWorkerResponse>); }
}

assert.equal(rgbScanlineBytes(2, 2), 14);
const rows = new Uint8Array(14);
packRgbScanlines(new Uint32Array([0x112233, 0xa0b0c0, 0x010203, 0xfefdfc]), 2, 2, rows);
assert.deepEqual([...rows], [1, 0x11, 0x22, 0x33, 0x8f, 0x8e, 0x8d, 1, 1, 2, 3, 0xfd, 0xfb, 0xf9]);
assert.equal(frameFileName(42), 'frame_000042.png');
assert.throws(() => frameFileName(-1), /outside/);
assert.equal(choosePngEncodeSlots(1280, 720, 8), 4);
assert.equal(choosePngEncodeSlots(3840, 2160, 8), 1);

const png = await encodeRgb24Png(rows, 2, 2);
assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
assert.equal(String.fromCharCode(...png.subarray(12, 16)), 'IHDR');
assert.equal(png[24], 8, '8-bit channel depth');
assert.equal(png[25], 2, 'PNG color type 2 is RGB without alpha');
assert.ok(findAscii(png, 'sRGB') >= 0);
assert.deepEqual(await decodeRgb24Png(png), [
  0x11, 0x22, 0x33, 0xa0, 0xb0, 0xc0,
  1, 2, 3, 0xfe, 0xfd, 0xfc,
], 'Sub-filtered PNG must reconstruct the authority RGB bytes exactly');

assert.equal(await directoryIsNonempty(new EmptyDirectory() as unknown as FileSystemDirectoryHandle), false);
assert.equal(await directoryIsNonempty(new NonemptyDirectory() as unknown as FileSystemDirectoryHandle), true);

const worker = new MockWorker();
let progressFrames = 0;
const client = new OfflineRenderClient({
  createWorker: () => worker,
  onProgress(progress) { progressFrames = progress.writtenFrames; },
});
const outputDirectory = new EmptyDirectory() as unknown as FileSystemDirectoryHandle;
const promise = client.start({
  jobId: 'test', width: 2, height: 2, fpsNum: 24, fpsDen: 1,
  sampleRate: 48000, totalSamples: 2,
  left: new Float32Array([.1, .2]), right: new Float32Array([.3, .4]),
  presetBank: [{ presetId: 'fixed', presetSha256: 'abc', bytes: new Uint8Array([1]) }],
  presetCues: [{ frame: 0, presetId: 'fixed', seed: 1, transitionFrames: 0 }],
  outputDirectory,
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(worker.sent[0]?.type, 'start');
worker.emit({
  type: 'progress', jobId: 'test', renderedFrames: 1, writtenFrames: 1,
  frameCount: 1, queueDepth: 1, elapsedMs: 2, renderMs: 1, encodeWriteMs: 1,
});
assert.equal(progressFrames, 1);
worker.emit({
  type: 'complete', jobId: 'test', frameCount: 1, elapsedMs: 2,
  renderMs: 1, encodeWriteMs: 1, peakQueueDepth: 1, artifacts: [],
});
assert.equal((await promise).frameCount, 1);
client.dispose();
assert.equal(worker.terminated, true);

const refusingWorker = new MockWorker();
const refusingClient = new OfflineRenderClient({ createWorker: () => refusingWorker });
await assert.rejects(() => refusingClient.start({
  jobId: 'refuse', width: 2, height: 2, fpsNum: 24, fpsDen: 1,
  sampleRate: 48000, totalSamples: 1,
  left: new Float32Array(1), right: new Float32Array(1),
  presetBank: [{ presetId: 'fixed', presetSha256: 'abc', bytes: new Uint8Array([1]) }],
  presetCues: [{ frame: 0, presetId: 'fixed', seed: 1, transitionFrames: 0 }],
  outputDirectory: new NonemptyDirectory() as unknown as FileSystemDirectoryHandle,
}), /must be empty/);
assert.equal(refusingWorker.sent.length, 0);
refusingClient.dispose();

console.log('offline render client / RGB24 PNG checks passed');

function findAscii(haystack: Uint8Array, needle: string): number {
  const bytes = [...needle].map((character) => character.charCodeAt(0));
  outer: for (let i = 0; i <= haystack.length - bytes.length; i++) {
    for (let j = 0; j < bytes.length; j++) if (haystack[i + j] !== bytes[j]) continue outer;
    return i;
  }
  return -1;
}

async function decodeRgb24Png(png: Uint8Array): Promise<number[]> {
  const idatAt = findAscii(png, 'IDAT');
  assert.ok(idatAt >= 0);
  const dataLength = readU32(png, idatAt - 4);
  const compressed = png.subarray(idatAt + 4, idatAt + 4 + dataLength);
  const source = new Blob([compressed]).stream();
  const inflated = new Uint8Array(await new Response(
    source.pipeThrough(new DecompressionStream('deflate')),
  ).arrayBuffer());
  const decoded: number[] = [];
  const stride = 6;
  for (let row = 0; row < 2; row++) {
    const start = row * (stride + 1);
    assert.equal(inflated[start], 1);
    for (let byte = 0; byte < stride; byte++) {
      const prior = byte >= 3 ? decoded[row * stride + byte - 3]! : 0;
      decoded.push((inflated[start + 1 + byte]! + prior) & 0xff);
    }
  }
  return decoded;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16)
    | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}
