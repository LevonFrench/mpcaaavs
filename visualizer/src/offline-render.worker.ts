import type { AvsCompatibilityRuntime } from './avs/index.ts';
import { loadBundledAvsBitmapResolver } from './avs/bundled-bitmaps.ts';
import { blendPackedRgb, blendPackedRgbLinearLight, fillAvsPcmPlanar } from './avs/frame-utils.ts';
import { createFrameStats, FlashLimiter, limitPackedFrame, parseFlashMode, type FlashMode } from './flash-limiter.ts';
import {
  createOfflineAvsRegistry,
  fillOfflineAvsPcm,
  offlineFrameTimeMs,
  OFFLINE_PIXEL_SEMANTICS_VERSION,
  renderOfflineAvsFrame,
  startOfflineAvsCue,
  type OfflineAvsClock,
} from './offline/avs-cue.ts';
import {
  choosePngEncodeSlots,
  choosePngEncoderWorkers,
  frameFileName,
  packRgbScanlines,
  rgbRasterBytes,
  rgbScanlineBytes,
  sha256Hex,
  writePngFrame,
  type PngFrameWriteResult,
} from './offline-png.ts';
import type {
  OfflineEncodeWorkerRequest,
  OfflineEncodeWorkerResponse,
  OfflineFrameArtifact,
  OfflineRenderStartMessage,
  OfflineRenderTelemetry,
  OfflineRenderWorkerRequest,
  OfflineRenderWorkerResponse,
  OfflineTransitionBlend,
} from './offline-render-protocol.ts';

interface OfflineWorkerScope {
  onmessage: ((event: MessageEvent<OfflineRenderWorkerRequest>) => void) | null;
  postMessage(message: OfflineRenderWorkerResponse): void;
}

const scope = globalThis as unknown as OfflineWorkerScope;
const AVS_SAMPLES = 576;
const ENCODER_READY_TIMEOUT_MS = 10_000;

let activeJobId = '';
let cancelled = false;
let paused = false;
let resumeWaiters: (() => void)[] = [];
let renderedFrames = 0;
let writtenFrames = 0;

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'start') {
    if (activeJobId) {
      scope.postMessage({ type: 'error', jobId: message.jobId, message: 'An offline render is already active' });
      return;
    }
    activeJobId = message.jobId;
    void run(message).catch((error: unknown) => {
      scope.postMessage({
        type: 'error', jobId: message.jobId,
        message: error instanceof Error ? error.message : String(error),
      });
      resetJob();
    });
    return;
  }
  if (message.jobId !== activeJobId) return;
  if (message.type === 'cancel') {
    cancelled = true;
    releasePause();
  } else if (message.type === 'pause' && !paused) {
    paused = true;
    scope.postMessage({ type: 'paused', jobId: activeJobId });
  } else if (message.type === 'resume' && paused) {
    releasePause();
    scope.postMessage({ type: 'resumed', jobId: activeJobId });
  }
};

async function run(message: OfflineRenderStartMessage): Promise<void> {
  validate(message);
  await assertDirectoryEmpty(message.outputDirectory);
  const framesDirectory = await message.outputDirectory.getDirectoryHandle('frames', { create: true });
  const samplesPerFrame = message.sampleRate * message.fpsDen / message.fpsNum;
  const frameCount = Math.ceil(message.totalSamples / samplesPerFrame);
  const left = new Float32Array(message.left, 0, message.totalSamples);
  const right = new Float32Array(message.right, 0, message.totalSamples);
  const pcm = { left: new Float32Array(AVS_SAMPLES), right: new Float32Array(AVS_SAMPLES) };
  const transitionBlend: OfflineTransitionBlend = message.transitionBlend ?? 'srgb-integer';
  const blend = transitionBlend === 'linear-light' ? blendPackedRgbLinearLight : blendPackedRgb;
  const hardwareConcurrency = globalThis.navigator?.hardwareConcurrency ?? 4;
  const refuseExisting = message.debugRefuseExistingFrames === true;
  const encodeSlots = choosePngEncodeSlots(message.width, message.height, hardwareConcurrency);
  const wantedEncoders = Math.min(
    choosePngEncoderWorkers(message.width, message.height, hardwareConcurrency),
    Math.max(0, Math.trunc(message.maxEncoderWorkers ?? 3)),
  );
  const sink = await createWorkerPoolSink(
    wantedEncoders, Math.max(wantedEncoders, encodeSlots), message.width, message.height,
    framesDirectory, refuseExisting,
  ) ?? new InThreadEncodeSink(encodeSlots, message.width, message.height, framesDirectory, refuseExisting);
  // The unfiltered raster is hashed per frame; digest() copies its input at
  // call time, so one reusable buffer is enough.
  const rgbRaster = new Uint8Array(rgbRasterBytes(message.width, message.height));
  const artifacts = new Array<OfflineFrameArtifact | undefined>(frameCount);
  const encoded = new Array<PngFrameWriteResult | undefined>(frameCount);
  const rgbHashes = new Array<Promise<string> | undefined>(frameCount);
  const resolver = await loadBundledAvsBitmapResolver();
  // Offline reseeds AVS randomness at every cue BY DESIGN (owner decision
  // 2026-09-26): each cue gets a fresh registry whose only entropy is the
  // cue's ledger seed, so a cue's own runtime renders identically whatever
  // preceded it (a crossfade still composites the outgoing cue's frames, and
  // opt-in flash limiting carries its 1 s window across cues, so the written
  // frames of those spans depend on what came before). Live has no cues and
  // keeps one stream per preset load. Custom BPM's clock is the output frame
  // time, shared by the incoming and outgoing runtimes.
  // See src/offline/avs-cue.ts for the full frame semantics and their version.
  const clock: OfflineAvsClock = { nowMs: 0 };
  const createSeededRegistry = (seed: number) => createOfflineAvsRegistry(seed, { bitmapResolver: resolver, clock });
  // Opt-in flash limiting ('off' by default, recorded in the manifest). It
  // runs on a copy of the composed frame, never on a runtime framebuffer (the
  // preset's feedback state), with t = frame / fps, so it is deterministic for
  // a whole-job serial render (its state spans the job from frame 0).
  const flashLimit: FlashMode = message.flashLimit ?? 'off';
  const flash = flashLimit === 'off' ? null : {
    limiter: new FlashLimiter(flashLimit),
    stats: createFrameStats(),
    present: new Uint32Array(message.width * message.height),
    prevOut: new Uint32Array(message.width * message.height),
  };
  let flashLimitedFrames = 0;
  const presetBank = new Map(message.presetBank.map((preset) => [preset.presetId, preset.bytes]));
  let cueIndex = -1;
  let runtime: AvsCompatibilityRuntime | null = null;
  let outgoingRuntime: AvsCompatibilityRuntime | null = null;
  let transitionStartFrame = 0;
  let transitionFrames = 0;
  const transitionPixels = new Uint32Array(message.width * message.height);
  let renderMsTotal = 0;
  let renderCpuMs = 0;
  let packBlendMs = 0;
  let loopStallMs = 0;
  let encodeWriteMsTotal = 0;
  let deflateMs = 0;
  let writeMs = 0;
  let peakQueueDepth = 0;
  let lastProgressAt = 0;
  const startedAt = performance.now();
  const telemetry = (): OfflineRenderTelemetry => ({
    renderCpuMs, packBlendMs, loopStallMs, encodeBusyMs: sink.busyMs(),
    deflateMs, writeMs, encoderWorkers: sink.encoderWorkers,
  });

  scope.postMessage({ type: 'started', jobId: message.jobId, frameCount, encoderWorkers: sink.encoderWorkers });

  const onEncoded = (frame: number, result: PngFrameWriteResult | null): void => {
    if (!result) return;
    encoded[frame] = result;
    writtenFrames++;
    // Per-frame latency sum, kept for compatibility; see telemetry.encodeBusyMs
    // for the overlap-free figure.
    encodeWriteMsTotal += result.deflateMs + result.writeMs;
    deflateMs += result.deflateMs;
    writeMs += result.writeMs;
    const now = performance.now();
    if (now - lastProgressAt >= 100 || writtenFrames === frameCount) {
      lastProgressAt = now;
      scope.postMessage({
        type: 'progress', jobId: message.jobId,
        renderedFrames, writtenFrames, frameCount,
        queueDepth: sink.inFlight(), elapsedMs: now - startedAt,
        renderMs: renderMsTotal, encodeWriteMs: encodeWriteMsTotal,
        telemetry: telemetry(),
      });
    }
  };

  try {
    for (let frame = 0; frame < frameCount; frame++) {
      await waitWhilePaused();
      if (cancelled) break;

      const stallStarted = performance.now();
      const scanlines = await sink.acquire();
      loopStallMs += performance.now() - stallStarted;
      if (cancelled) {
        sink.release(scanlines);
        break;
      }

      while (cueIndex + 1 < message.presetCues.length
        && message.presetCues[cueIndex + 1]!.frame <= frame) {
        cueIndex++;
        const cue = message.presetCues[cueIndex]!;
        const presetBytes = presetBank.get(cue.presetId);
        if (!presetBytes) throw new Error(`Preset ${cue.presetId} is missing from the transferred bank`);
        outgoingRuntime = runtime;
        clock.nowMs = offlineFrameTimeMs(frame, message.fpsNum, message.fpsDen);
        runtime = startOfflineAvsCue(presetBytes, message.width, message.height, createSeededRegistry(cue.seed));
        transitionStartFrame = frame;
        transitionFrames = cue.transitionFrames;
      }
      if (!runtime) throw new Error(`No preset is active at output frame ${frame}`);

      const sampleStart = frame * samplesPerFrame;
      const sampleEnd = Math.min(sampleStart + samplesPerFrame, message.totalSamples);
      fillOfflineAvsPcm(left, right, sampleStart, sampleEnd, pcm);
      clock.nowMs = offlineFrameTimeMs(frame, message.fpsNum, message.fpsDen);
      const renderStarted = performance.now();
      const rendered = renderOfflineAvsFrame(runtime, pcm);
      const transitionProgress = transitionFrames > 0
        ? Math.min(1, (frame - transitionStartFrame) / transitionFrames) : 1;
      let packStarted: number;
      let composed: Uint32Array;
      if (outgoingRuntime && transitionProgress < 1) {
        const outgoing = renderOfflineAvsFrame(outgoingRuntime, pcm);
        packStarted = performance.now();
        blend(outgoing.framebuffer.pixels, rendered.framebuffer.pixels, transitionProgress, transitionPixels);
        composed = transitionPixels;
      } else {
        outgoingRuntime = null;
        packStarted = performance.now();
        composed = rendered.framebuffer.pixels;
      }
      if (flash) {
        flash.present.set(composed);
        const decision = limitPackedFrame(
          flash.limiter, flash.stats, flash.present, flash.prevOut,
          message.width, message.height, frame * message.fpsDen / message.fpsNum,
        );
        if (decision.blend < 1) flashLimitedFrames++;
        composed = flash.present;
      }
      packRgbScanlines(composed, message.width, message.height, scanlines, rgbRaster);
      const packed = performance.now();
      renderCpuMs += packStarted - renderStarted;
      packBlendMs += packed - packStarted;
      renderMsTotal += packed - renderStarted;
      rgbHashes[frame] = sha256Hex(rgbRaster);
      renderedFrames++;
      sink.submit(scanlines, frame, (result) => onEncoded(frame, result));
      peakQueueDepth = Math.max(peakQueueDepth, sink.inFlight());
    }

    if (cancelled) sink.cancel();
    await sink.drain();
  } catch (error) {
    // Stop frames still in flight from committing after the job has failed;
    // resetJob clears the shared cancel flag, so the sink needs its own.
    sink.cancel();
    throw error;
  } finally {
    sink.dispose();
  }
  if (cancelled) {
    scope.postMessage({ type: 'cancelled', jobId: message.jobId, renderedFrames, writtenFrames });
    resetJob();
    return;
  }
  for (let frame = 0; frame < frameCount; frame++) {
    const result = encoded[frame];
    const rgbHash = rgbHashes[frame];
    if (!result || !rgbHash) continue;
    const sampleStart = frame * samplesPerFrame;
    artifacts[frame] = {
      frame, path: `frames/${frameFileName(frame)}`, sha256: result.sha256, rgbSha256: await rgbHash,
      bytes: result.bytes, sampleStart, sampleEnd: Math.min(sampleStart + samplesPerFrame, message.totalSamples),
    };
  }
  const completeArtifacts = artifacts.filter((artifact): artifact is OfflineFrameArtifact => artifact !== undefined);
  if (completeArtifacts.length !== frameCount) {
    throw new Error(`Frame ledger is incomplete: expected ${frameCount}, wrote ${completeArtifacts.length}`);
  }
  scope.postMessage({
    type: 'complete', jobId: message.jobId, frameCount,
    elapsedMs: performance.now() - startedAt,
    renderMs: renderMsTotal, encodeWriteMs: encodeWriteMsTotal,
    peakQueueDepth, artifacts: completeArtifacts,
    telemetry: telemetry(), transitionBlend,
    flashLimit, flashLimitedFrames, pixelSemanticsVersion: OFFLINE_PIXEL_SEMANTICS_VERSION,
    ...(sink.bundleSha256 ? { encoderBundleSha256: sink.bundleSha256 } : {}),
  });
  resetJob();
}

/**
 * A bounded ring of filtered-scanline buffers plus whatever encodes them. The
 * render loop acquires a free buffer (waiting here is the loop stall), packs a
 * frame into it and submits it; the buffer returns to the ring once written.
 */
abstract class EncodeSink {
  abstract readonly encoderWorkers: number;
  /** SHA-256 of the encoder worker bundle, when frames are encoded off-thread. */
  readonly bundleSha256: string | undefined = undefined;
  #free: Uint8Array[] = [];
  #waiters: { resolve: (buffer: Uint8Array) => void; reject: (error: Error) => void }[] = [];
  #inFlight = 0;
  #busyMs = 0;
  #busySince = 0;
  #idleWaiters: (() => void)[] = [];
  protected failure: Error | null = null;

  protected constructor(buffers: Uint8Array[]) { this.#free = buffers; }

  acquire(): Promise<Uint8Array> {
    if (this.failure) return Promise.reject(this.failure);
    const buffer = this.#free.pop();
    if (buffer) return Promise.resolve(buffer);
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  release(buffer: Uint8Array): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve(buffer);
    else this.#free.push(buffer);
  }

  inFlight(): number { return this.#inFlight; }

  /** Union of intervals with at least one frame in encode/write. */
  busyMs(): number {
    return this.#busyMs + (this.#inFlight > 0 ? performance.now() - this.#busySince : 0);
  }

  abstract submit(buffer: Uint8Array, frame: number, done: (result: PngFrameWriteResult | null) => void): void;
  abstract cancel(): void;
  abstract dispose(): void;

  /** Wait for every submitted frame to settle, then surface the first failure. */
  async drain(): Promise<void> {
    while (this.#inFlight > 0) await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
    if (this.failure) throw this.failure;
  }

  protected begin(): void {
    if (this.#inFlight++ === 0) this.#busySince = performance.now();
  }

  protected end(): void {
    if (--this.#inFlight === 0) {
      this.#busyMs += performance.now() - this.#busySince;
      const waiters = this.#idleWaiters;
      this.#idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  protected fail(error: Error): void {
    this.failure ??= error;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter.reject(this.failure);
  }
}

/** Fallback: DEFLATE on the render worker's own thread, interleaved with rendering. */
class InThreadEncodeSink extends EncodeSink {
  readonly encoderWorkers = 0;
  #cancelled = false;
  readonly #isCancelled = () => this.#cancelled || cancelled;

  constructor(
    slots: number,
    private readonly width: number,
    private readonly height: number,
    private readonly framesDirectory: FileSystemDirectoryHandle,
    private readonly refuseExisting: boolean,
  ) {
    super(Array.from({ length: slots }, () => new Uint8Array(rgbScanlineBytes(width, height))));
  }

  submit(buffer: Uint8Array, frame: number, done: (result: PngFrameWriteResult | null) => void): void {
    this.begin();
    void writePngFrame(this.framesDirectory, buffer, this.width, this.height, frame, {
      refuseExisting: this.refuseExisting, cancelled: this.#isCancelled,
    }).then((result) => done(result), (error: unknown) => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }).finally(() => {
      this.release(buffer);
      this.end();
    });
  }

  cancel(): void { this.#cancelled = true; }
  dispose(): void { /* nothing to release */ }
}

interface EncoderPort {
  onmessage: ((event: MessageEvent<OfflineEncodeWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: OfflineEncodeWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}

/** 1-3 dedicated encoder workers fed by transferring scanline buffers. */
class WorkerPoolSink extends EncodeSink {
  readonly #pending = new Map<number, { worker: number; done: (result: PngFrameWriteResult | null) => void }>();
  readonly #load: number[];

  constructor(
    private readonly workers: readonly EncoderPort[],
    buffers: Uint8Array[],
    override readonly bundleSha256: string,
  ) {
    super(buffers);
    this.#load = workers.map(() => 0);
    workers.forEach((worker) => {
      worker.onmessage = (event) => this.#receive(event.data);
      worker.onerror = (event) => {
        event.preventDefault?.();
        this.#abandonAll(new Error(event.message || 'PNG encoder worker failed'));
      };
    });
  }

  get encoderWorkers(): number { return this.workers.length; }

  submit(buffer: Uint8Array, frame: number, done: (result: PngFrameWriteResult | null) => void): void {
    let target = 0;
    for (let i = 1; i < this.#load.length; i++) if (this.#load[i]! < this.#load[target]!) target = i;
    const storage = buffer.buffer as ArrayBuffer;
    this.begin();
    this.#load[target]!++;
    this.#pending.set(frame, { worker: target, done });
    this.workers[target]!.postMessage({ type: 'encode', frame, scanlines: storage }, [storage]);
  }

  cancel(): void {
    for (const worker of this.workers) worker.postMessage({ type: 'cancel' });
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate();
  }

  #receive(message: OfflineEncodeWorkerResponse): void {
    if (message.type === 'ready') return;
    const frame = message.frame;
    const pending = frame === undefined ? undefined : this.#pending.get(frame);
    if (message.type === 'error') {
      this.fail(new Error(message.message));
      if (!pending) {
        this.#abandonAll(this.failure!);
        return;
      }
    }
    if (!pending || frame === undefined) return;
    this.#pending.delete(frame);
    this.#load[pending.worker]!--;
    if (message.type === 'encoded') pending.done(message.result);
    if (message.scanlines) this.release(new Uint8Array(message.scanlines));
    this.end();
  }

  /** A worker died: its transferred buffers are gone, so settle every pending frame as failed. */
  #abandonAll(error: Error): void {
    this.fail(error);
    for (const [frame, pending] of this.#pending) {
      this.#pending.delete(frame);
      this.#load[pending.worker]!--;
      this.end();
    }
  }
}

/**
 * Start encoder workers and wait until each reports ready. Returns null, so the
 * caller falls back to in-thread encoding, when workers are unavailable, the
 * encoder bundle is missing, or it fails to start in time.
 *
 * The self-contained encoder bundle is fetched and started from a blob URL:
 * a missing bundle shows up as a plain HTTP status instead of an opaque worker
 * error, some embedded Chromium hosts refuse nested workers loaded by network
 * URL but accept blob URLs, and the manifest can record the hash of the exact
 * bytes that encoded the frames.
 */
async function createWorkerPoolSink(
  count: number,
  bufferCount: number,
  width: number,
  height: number,
  framesDirectory: FileSystemDirectoryHandle,
  refuseExisting: boolean,
): Promise<WorkerPoolSink | null> {
  if (count <= 0 || typeof Worker === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  let scriptUrl: string;
  let bundleSha256: string;
  try {
    const response = await fetch(new URL('./offline-encode.worker.js', import.meta.url));
    if (!response.ok) return null;
    const bundle = new Uint8Array(await response.arrayBuffer());
    bundleSha256 = await sha256Hex(bundle);
    scriptUrl = URL.createObjectURL(new Blob([bundle], { type: 'text/javascript' }));
  } catch {
    return null;
  }
  const workers: EncoderPort[] = [];
  try {
    for (let i = 0; i < count; i++) {
      workers.push(new Worker(
        scriptUrl,
        { type: 'module', name: `aaavs-offline-encoder-${i}` },
      ) as unknown as EncoderPort);
    }
    await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('PNG encoder worker did not start')), ENCODER_READY_TIMEOUT_MS);
      worker.onmessage = (event) => {
        if (event.data.type !== 'ready') return;
        clearTimeout(timer);
        resolve();
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        clearTimeout(timer);
        reject(new Error(event.message || 'PNG encoder worker failed to load'));
      };
      worker.postMessage({ type: 'init', width, height, framesDirectory, refuseExisting });
    })));
  } catch {
    for (const worker of workers) worker.terminate();
    return null;
  } finally {
    URL.revokeObjectURL(scriptUrl);
  }
  const buffers = Array.from({ length: bufferCount }, () => new Uint8Array(rgbScanlineBytes(width, height)));
  return new WorkerPoolSink(workers, buffers, bundleSha256);
}

function validate(message: OfflineRenderStartMessage): void {
  if (!message.jobId) throw new Error('Offline render job id is required');
  if (!Number.isSafeInteger(message.width) || !Number.isSafeInteger(message.height)
    || message.width <= 0 || message.height <= 0) throw new Error('Invalid output raster');
  if (message.sampleRate !== 48000) throw new Error('Offline render input must be normalized to 48 kHz');
  if (!Number.isSafeInteger(message.fpsNum) || !Number.isSafeInteger(message.fpsDen)
    || message.fpsNum <= 0 || message.fpsDen <= 0) throw new Error('Invalid output frame rate');
  if ((message.sampleRate * message.fpsDen) % message.fpsNum !== 0) {
    throw new Error('Profile frame rate must map to an integer number of 48 kHz samples');
  }
  if (!Number.isSafeInteger(message.totalSamples) || message.totalSamples <= 0) {
    throw new Error('Offline render needs at least one audio sample');
  }
  if (message.left.byteLength !== message.totalSamples * 4
    || message.right.byteLength !== message.totalSamples * 4) {
    throw new Error('Frozen PCM channel lengths do not match totalSamples');
  }
  if (message.presetCues.length === 0 || message.presetCues[0]!.frame !== 0) {
    throw new Error('Preset ledger must begin at frame zero');
  }
  if (message.transitionBlend !== undefined
    && message.transitionBlend !== 'srgb-integer' && message.transitionBlend !== 'linear-light') {
    throw new Error(`Unknown transition blend: ${String(message.transitionBlend)}`);
  }
  if (message.flashLimit !== undefined && parseFlashMode(message.flashLimit, 'off') !== message.flashLimit) {
    throw new Error(`Unknown flash limit mode: ${String(message.flashLimit)}`);
  }
  let prior = -1;
  for (const cue of message.presetCues) {
    if (!Number.isSafeInteger(cue.frame) || cue.frame <= prior
      || !Number.isSafeInteger(cue.transitionFrames) || cue.transitionFrames < 0) {
      throw new Error('Preset ledger must contain nonempty presets at strictly increasing frames');
    }
    prior = cue.frame;
  }
  if (message.presetBank.length === 0) throw new Error('Preset bank may not be empty');
  const ids = new Set<string>();
  for (const preset of message.presetBank) {
    if (!preset.presetId || preset.bytes.byteLength === 0 || ids.has(preset.presetId)) {
      throw new Error('Preset bank ids must be unique and byte buffers nonempty');
    }
    ids.add(preset.presetId);
  }
  for (const cue of message.presetCues) if (!ids.has(cue.presetId)) throw new Error(`Cue preset is absent: ${cue.presetId}`);
}

/**
 * Sample one complete output-frame interval into AVS's fixed 576-point input.
 * Kept as an export for existing callers; the rounding is the live worker's
 * fillAvsPcm convention (src/avs/frame-utils.ts), which yields the same index
 * as this lane's former formula for every nonempty interval.
 */
export function fillFramePcm(
  left: Float32Array,
  right: Float32Array,
  sampleStart: number,
  sampleEnd: number,
  pcmLeft: Float32Array,
  pcmRight: Float32Array,
): void {
  fillAvsPcmPlanar(left, right, sampleStart, sampleEnd, pcmLeft, pcmRight);
}

async function waitWhilePaused(): Promise<void> {
  if (!paused || cancelled) return;
  await new Promise<void>((resolve) => resumeWaiters.push(resolve));
}

function releasePause(): void {
  paused = false;
  const waiters = resumeWaiters;
  resumeWaiters = [];
  for (const resolve of waiters) resolve();
}

async function assertDirectoryEmpty(directory: FileSystemDirectoryHandle): Promise<void> {
  const iterable = directory as FileSystemDirectoryHandle & {
    values(): AsyncIterableIterator<FileSystemHandle>;
  };
  for await (const _entry of iterable.values()) {
    throw new Error('Output directory became nonempty before rendering; refusing to overwrite it');
  }
}

function resetJob(): void {
  activeJobId = '';
  cancelled = false;
  paused = false;
  renderedFrames = 0;
  writtenFrames = 0;
  releasePause();
}
