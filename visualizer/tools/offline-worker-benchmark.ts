import { readFileSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  OfflineRenderStartMessage,
  OfflineRenderWorkerResponse,
} from '../src/offline-render-protocol.ts';

async function main(): Promise<void> {
  const width = Number(process.env.AAAVS_BENCH_WIDTH ?? 640);
  const height = Number(process.env.AAAVS_BENCH_HEIGHT ?? 360);
  const frames = Number(process.env.AAAVS_BENCH_FRAMES ?? 48);
  const outputRoot = process.env.AAAVS_BENCH_OUTPUT;
  if (!outputRoot) throw new Error('AAAVS_BENCH_OUTPUT must point to an empty temporary directory');

const root = new NodeDirectoryHandle(outputRoot, 'benchmark-output');
let resolveComplete!: (message: OfflineRenderWorkerResponse) => void;
const completed = new Promise<OfflineRenderWorkerResponse>((resolve) => { resolveComplete = resolve; });
const workerGlobal = globalThis as typeof globalThis & {
  onmessage: ((event: MessageEvent<OfflineRenderStartMessage>) => void) | null;
  postMessage(message: OfflineRenderWorkerResponse): void;
};
workerGlobal.postMessage = (message) => {
  if (message.type === 'complete' || message.type === 'error' || message.type === 'cancelled') {
    resolveComplete(message);
  }
};
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = input instanceof URL ? input : new URL(String(input));
  if (url.protocol === 'file:') return new Response(await readFile(fileURLToPath(url)));
  return nativeFetch(input, init);
};
await import('../src/offline-render.worker.ts');

const samplesPerFrame = 2000;
const totalSamples = frames * samplesPerFrame;
const left = new Float32Array(totalSamples);
const right = new Float32Array(totalSamples);
for (let sample = 0; sample < totalSamples; sample++) {
  left[sample] = Math.sin(sample * .013) * .8;
  right[sample] = Math.sin(sample * .017 + .4) * .8;
}
const presetFile = resolve('assets/avs-presets/community-picks/yathosho - sakura.avs');
const preset = readFileSync(presetFile);
const presetBytes = preset.buffer.slice(preset.byteOffset, preset.byteOffset + preset.byteLength);
const message: OfflineRenderStartMessage = {
  type: 'start',
  jobId: 'offline-worker-benchmark',
  width, height,
  fpsNum: 24, fpsDen: 1,
  sampleRate: 48000,
  totalSamples,
  left: left.buffer,
  right: right.buffer,
  presetBank: [{ presetId: 'sakura', presetSha256: 'benchmark', bytes: presetBytes }],
  presetCues: [{ frame: 0, presetId: 'sakura', seed: 0x12345678, transitionFrames: 0 }],
  outputDirectory: root as unknown as FileSystemDirectoryHandle,
};
workerGlobal.onmessage?.({ data: message } as MessageEvent<OfflineRenderStartMessage>);
const result = await completed;
if (result.type !== 'complete') throw new Error(JSON.stringify(result));
const outputBytes = result.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
console.log(JSON.stringify({
  width, height, frames,
  elapsedMs: round(result.elapsedMs),
  renderMs: round(result.renderMs),
  encodeWriteAggregateMs: round(result.encodeWriteMs),
  wallFramesPerSecond: round(frames * 1000 / result.elapsedMs),
  renderFramesPerSecond: round(frames * 1000 / result.renderMs),
  peakQueueDepth: result.peakQueueDepth,
  outputBytes,
  meanPngBytes: Math.round(outputBytes / frames),
}));
}

class NodeDirectoryHandle {
  readonly kind = 'directory' as const;
  constructor(readonly path: string, readonly name: string) {}
  async *values(): AsyncIterableIterator<FileSystemHandle> {
    // The harness gives the worker a newly-created, empty root.
  }
  async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions): Promise<FileSystemDirectoryHandle> {
    const path = resolve(this.path, name);
    if (options?.create) await mkdir(path, { recursive: false });
    return new NodeDirectoryHandle(path, name) as unknown as FileSystemDirectoryHandle;
  }
  async getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<FileSystemFileHandle> {
    const path = resolve(this.path, name);
    if (!options?.create) {
      try { await access(path); } catch { throw new DOMException('Missing', 'NotFoundError'); }
    }
    return new NodeFileHandle(path, name) as unknown as FileSystemFileHandle;
  }
}

class NodeFileHandle {
  readonly kind = 'file' as const;
  constructor(readonly path: string, readonly name: string) {}
  async createWritable(): Promise<FileSystemWritableFileStream> {
    let pending: Uint8Array | null = null;
    return {
      write: async (data: FileSystemWriteChunkType) => {
        if (!(data instanceof Uint8Array)) throw new TypeError('Benchmark accepts Uint8Array writes only');
        pending = data.slice();
      },
      close: async () => {
        if (!pending) throw new Error('No frame bytes were written');
        await writeFile(this.path, pending);
      },
      abort: async () => { pending = null; },
    } as FileSystemWritableFileStream;
  }
}

await main();

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
