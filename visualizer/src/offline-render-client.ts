import type {
  OfflineFrameArtifact,
  OfflinePresetCueTransfer,
  OfflinePresetTransfer,
  OfflineRenderCompleteMessage,
  OfflineRenderProgressMessage,
  OfflineRenderStartMessage,
  OfflineRenderTelemetry,
  OfflineRenderWorkerRequest,
  OfflineRenderWorkerResponse,
  OfflineTransitionBlend,
} from './offline-render-protocol.ts';
import type { FlashMode } from './flash-limiter.ts';

interface OfflineWorkerPort {
  onmessage: ((event: MessageEvent<OfflineRenderWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: OfflineRenderWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface OfflineRenderClientStart {
  readonly jobId: string;
  readonly width: number;
  readonly height: number;
  readonly fpsNum: number;
  readonly fpsDen: number;
  readonly sampleRate: 48000;
  readonly totalSamples: number;
  readonly left: Float32Array;
  readonly right: Float32Array;
  readonly presetBank: readonly {
    readonly presetId: string;
    readonly presetSha256: string;
    readonly bytes: Uint8Array;
  }[];
  readonly presetCues: readonly OfflinePresetCueTransfer[];
  readonly outputDirectory: FileSystemDirectoryHandle;
  /** Opt-in crossfade compositing; omitted means the historical 'srgb-integer'. */
  readonly transitionBlend?: OfflineTransitionBlend;
  /** Opt-in flash limiting; omitted means 'off' (bytes unchanged). */
  readonly flashLimit?: FlashMode;
  /** Upper bound on dedicated PNG encoder workers; 0 forces in-thread encoding. */
  readonly maxEncoderWorkers?: number;
  /** Debug only: probe for an existing file before every frame write. */
  readonly debugRefuseExistingFrames?: boolean;
}

export interface OfflineRenderClientOptions {
  readonly createWorker?: () => OfflineWorkerPort;
  readonly onStarted?: (frameCount: number, encoderWorkers: number) => void;
  readonly onProgress?: (progress: OfflineRenderProgressMessage) => void;
  readonly onPaused?: (paused: boolean) => void;
}

export interface OfflineRenderResult {
  readonly frameCount: number;
  readonly elapsedMs: number;
  readonly renderMs: number;
  readonly encodeWriteMs: number;
  readonly peakQueueDepth: number;
  readonly artifacts: readonly OfflineFrameArtifact[];
  readonly telemetry?: OfflineRenderTelemetry;
  readonly transitionBlend: OfflineTransitionBlend;
  readonly flashLimit: FlashMode;
  readonly flashLimitedFrames: number;
  /** Absent when the worker predates versioned pixel semantics (version 1). */
  readonly pixelSemanticsVersion?: number;
  readonly encoderBundleSha256?: string;
}

export type OfflineBoundBy = 'render' | 'encode' | 'io';

/**
 * Which stage limits an export. When the render loop rarely waits for a free
 * scanline buffer it is render-bound; otherwise encode/IO backpressure is the
 * limit, split by whether DEFLATE or hash+write dominates encoder time.
 */
export function offlineBoundBy(telemetry: OfflineRenderTelemetry, elapsedMs: number): OfflineBoundBy {
  const stallShare = elapsedMs > 0 ? telemetry.loopStallMs / elapsedMs : 0;
  if (stallShare < .15) return 'render';
  return telemetry.writeMs > telemetry.deflateMs ? 'io' : 'encode';
}

/** True when a File System Access directory contains at least one entry. */
export async function directoryIsNonempty(directory: FileSystemDirectoryHandle): Promise<boolean> {
  const iterable = directory as FileSystemDirectoryHandle & {
    values(): AsyncIterableIterator<FileSystemHandle>;
  };
  for await (const _entry of iterable.values()) return true;
  return false;
}

/**
 * Owns one offline render worker. A client instance intentionally runs one job
 * at a time so no second producer can bypass the worker's bounded PNG queue.
 */
export class OfflineRenderClient {
  private readonly worker: OfflineWorkerPort;
  private readonly options: OfflineRenderClientOptions;
  private activeJobId = '';
  private resolve: ((result: OfflineRenderResult) => void) | null = null;
  private reject: ((error: Error) => void) | null = null;
  private disposed = false;

  constructor(options: OfflineRenderClientOptions = {}) {
    this.options = options;
    this.worker = options.createWorker?.() ?? new Worker(
      new URL('./offline-render.worker.js', import.meta.url),
      { type: 'module', name: 'aaavs-offline-renderer' },
    );
    this.worker.onmessage = (event) => this.receive(event.data);
    this.worker.onerror = (event) => this.fail(new Error(event.message || 'Offline render worker failed'));
  }

  get active(): boolean { return this.activeJobId !== '' && this.resolve !== null; }

  async start(input: OfflineRenderClientStart): Promise<OfflineRenderResult> {
    if (this.disposed) throw new Error('Offline render client has been disposed');
    if (this.active) throw new Error('An offline render is already active');
    if (await directoryIsNonempty(input.outputDirectory)) {
      throw new Error('Output directory must be empty. AAAVS will not overwrite an existing package.');
    }

    const left = transferableBuffer(input.left);
    const right = transferableBuffer(input.right);
    const presetBank: OfflinePresetTransfer[] = input.presetBank.map((preset) => ({
      presetId: preset.presetId,
      presetSha256: preset.presetSha256,
      bytes: transferableBuffer(preset.bytes),
    }));
    const presetCues: OfflinePresetCueTransfer[] = input.presetCues.map((cue) => ({
      frame: cue.frame,
      presetId: cue.presetId,
      seed: cue.seed,
      transitionFrames: cue.transitionFrames,
    }));
    const message: OfflineRenderStartMessage = {
      type: 'start', jobId: input.jobId,
      width: input.width, height: input.height,
      fpsNum: input.fpsNum, fpsDen: input.fpsDen,
      sampleRate: input.sampleRate, totalSamples: input.totalSamples,
      left, right, presetBank, presetCues, outputDirectory: input.outputDirectory,
      ...(input.transitionBlend ? { transitionBlend: input.transitionBlend } : {}),
      ...(input.flashLimit && input.flashLimit !== 'off' ? { flashLimit: input.flashLimit } : {}),
      ...(input.maxEncoderWorkers !== undefined ? { maxEncoderWorkers: input.maxEncoderWorkers } : {}),
      ...(input.debugRefuseExistingFrames ? { debugRefuseExistingFrames: true } : {}),
    };
    const transfer: Transferable[] = [left, right, ...presetBank.map((preset) => preset.bytes)];
    this.activeJobId = input.jobId;
    return new Promise<OfflineRenderResult>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.worker.postMessage(message, transfer);
    });
  }

  pause(): void { this.control('pause'); }
  resume(): void { this.control('resume'); }
  cancel(): void { this.control('cancel'); }

  dispose(): void {
    if (this.disposed) return;
    if (this.active) this.cancel();
    this.disposed = true;
    this.fail(new Error('Offline render client disposed'));
    this.worker.terminate();
  }

  private control(type: 'pause' | 'resume' | 'cancel'): void {
    if (!this.active) return;
    this.worker.postMessage({ type, jobId: this.activeJobId });
  }

  private receive(message: OfflineRenderWorkerResponse): void {
    if (message.jobId !== this.activeJobId) return;
    if (message.type === 'started') {
      this.options.onStarted?.(message.frameCount, message.encoderWorkers ?? 0);
      return;
    }
    if (message.type === 'progress') {
      this.options.onProgress?.(message);
      return;
    }
    if (message.type === 'paused' || message.type === 'resumed') {
      this.options.onPaused?.(message.type === 'paused');
      return;
    }
    if (message.type === 'complete') {
      const resolve = this.resolve;
      this.clearActive();
      resolve?.(completeResult(message));
      return;
    }
    if (message.type === 'cancelled') {
      this.fail(new DOMException('Offline render cancelled', 'AbortError'));
      return;
    }
    if (message.type === 'error') this.fail(new Error(message.message));
  }

  private fail(error: Error): void {
    const reject = this.reject;
    this.clearActive();
    reject?.(error);
  }

  private clearActive(): void {
    this.activeJobId = '';
    this.resolve = null;
    this.reject = null;
  }
}

function transferableBuffer(view: ArrayBufferView): ArrayBuffer {
  if (view.buffer instanceof ArrayBuffer && view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
    return view.buffer;
  }
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return copy.buffer;
}

function completeResult(message: OfflineRenderCompleteMessage): OfflineRenderResult {
  return {
    frameCount: message.frameCount,
    elapsedMs: message.elapsedMs,
    renderMs: message.renderMs,
    encodeWriteMs: message.encodeWriteMs,
    peakQueueDepth: message.peakQueueDepth,
    artifacts: message.artifacts,
    ...(message.telemetry ? { telemetry: message.telemetry } : {}),
    transitionBlend: message.transitionBlend ?? 'srgb-integer',
    flashLimit: message.flashLimit ?? 'off',
    flashLimitedFrames: message.flashLimitedFrames ?? 0,
    ...(message.pixelSemanticsVersion !== undefined ? { pixelSemanticsVersion: message.pixelSemanticsVersion } : {}),
    ...(message.encoderBundleSha256 ? { encoderBundleSha256: message.encoderBundleSha256 } : {}),
  };
}
