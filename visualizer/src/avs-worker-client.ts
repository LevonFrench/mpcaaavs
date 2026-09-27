import type { AudioSnapshot } from './contracts.ts';
import type { AvsWorkerFrameMessage, AvsWorkerRequest, AvsWorkerResponse } from './avs-worker-protocol.ts';
import type { AvsComponentControl } from './avs/executor.ts';
import type { AvsPresetAst } from './avs/types.ts';
import type { AvsFrameGraphLane } from './avs/gpu-frame-graph.ts';
import { avsPresentationLayout, type AvsPresentationLayout, type AvsUpscaleMode } from './avs-presentation.ts';
import { AVS_PCM_SAMPLES, fillAvsPcm } from './avs/frame-utils.ts';

/** Resample the app's interleaved waveform into AVS's two 576-sample channels (shared with offline). */
export { fillAvsPcm };

interface WorkerPort {
  onmessage: ((event: MessageEvent<AvsWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: AvsWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface AvsWorkerRendererOptions {
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
  readonly createWorker?: () => WorkerPort;
  readonly onFrame?: () => void;
  /**
   * Called whenever the worker becomes idle (a frame, current or stale, came
   * back). Hosts dispatch the next frame here instead of waiting for the next
   * rAF, so a 17 ms preset at 60 Hz is not quantised to 30 fps.
   */
  readonly onIdle?: () => void;
  /**
   * Hold the newest completed bitmap until the host calls `presentLatest` from
   * rAF, closing any bitmap a newer frame supersedes. Off by default: frames
   * are drawn on arrival, as before.
   */
  readonly latchFrames?: boolean;
  /** Exact by default; `120` explicitly enables approximate GPU generators. */
  readonly gpuLane?: AvsFrameGraphLane;
}

/**
 * The backpressure primitive is deliberately tiny and independently tested:
 * no amount of rAF traffic can create a queue behind a pathological preset.
 */
export class SingleFrameGate {
  private pending = false;

  get busy(): boolean { return this.pending; }

  tryBegin(): boolean {
    if (this.pending) return false;
    this.pending = true;
    return true;
  }

  finish(): void { this.pending = false; }
}

/**
 * Owns one AVS module worker and presents completed ImageBitmaps on the main
 * thread. Rendering, EEL, FFT, packed-RGB conversion and ImageData upload all
 * stay in the worker; the UI thread only resamples 4.5 KiB of audio and draws a
 * transferred bitmap.
 */
export class AvsWorkerRenderer {
  private readonly worker: WorkerPort;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly onFrame?: () => void;
  private readonly onIdle?: () => void;
  private readonly latchFrames: boolean;
  private latest: AvsWorkerFrameMessage | null = null;
  private readonly gate = new SingleFrameGate();
  private generation = 0;
  private sequence = 0;
  private pcm = new Float32Array(AVS_PCM_SAMPLES * 2);
  private loadResolve: (() => void) | null = null;
  private loadReject: ((error: Error) => void) | null = null;
  private loaded = false;
  private disposed = false;
  private emaMs = 0;
  private controlRevision = 0;
  private pendingControls: readonly AvsComponentControl[] = [];
  private readonly gpuLane: AvsFrameGraphLane;

  preset: AvsPresetAst | null = null;

  unsupported = 0;
  lastRenderMs = 0;
  lastPresentMs = 0;
  lastEffectMs = 0;
  lastUploadMs = 0;
  lastEncodeSubmitMs = 0;
  /** GPU timestamp-query time of the last frame (undefined without timestamp support), its readback latency, and the last GPU error. */
  gpuMs: number | undefined = undefined;
  gpuLatencyMs: number | undefined = undefined;
  gpuError: string | undefined = undefined;
  /** The real AVS raster of the last frame, from the worker (the canvas may be prescaled). */
  lastWidth = 0;
  lastHeight = 0;
  /** Current-preset frames the worker completed, and how many of them a newer frame replaced unseen. */
  renderedFrames = 0;
  supersededFrames = 0;
  presenter: 'webgpu-exact' | 'webgpu-enhanced' | 'cpu-image-data' = 'cpu-image-data';
  gpuEffectPasses = 0;
  gpuEffectComponents = 0;
  gpuFusedPointwiseOperations = 0;
  gpuEffectPlan = 'exact CPU fallback';
  gpuEnhancedSuperScope = false;
  gpuEnhancedDynamicMovement = false;
  gpuEnhancedDynamicMovementResidentMap = false;
  gpuEnhancedMovementEel = false;

  static supported(): boolean {
    return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
  }

  constructor(options: AvsWorkerRendererOptions) {
    this.canvas = options.canvas;
    this.context = options.context;
    this.onFrame = options.onFrame;
    this.onIdle = options.onIdle;
    this.latchFrames = options.latchFrames ?? false;
    this.gpuLane = options.gpuLane ?? 'exact';
    this.worker = options.createWorker?.()
      ?? new Worker(new URL('./avs-render.worker.js', import.meta.url), { type: 'module', name: 'aaavs-compat-renderer' });
    this.worker.onmessage = (event) => this.receive(event.data);
    this.worker.onerror = (event) => {
      this.failLoad(new Error(event.message || 'AVS render worker failed'));
      this.gate.finish();
    };
  }

  get active(): boolean { return this.loaded && !this.disposed; }
  get busy(): boolean { return this.gate.busy; }
  get averageRenderMs(): number { return this.emaMs; }
  /** A latched frame is waiting for `presentLatest`. */
  get hasFrame(): boolean { return this.latest !== null; }

  load(bytes: Uint8Array, width: number, height: number): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('AVS render worker has been disposed'));
    this.clear();
    const generation = this.generation;
    // Normalise a potentially shared/view-backed input to one transferable
    // ArrayBuffer. This is one copy per preset load, never one per frame.
    const preset = new Uint8Array(bytes).buffer;
    return new Promise<void>((resolve, reject) => {
      this.loadResolve = resolve;
      this.loadReject = reject;
      this.worker.postMessage({ type: 'load', generation, preset, width, height, gpuLane: this.gpuLane }, [preset]);
    });
  }

  /** Replace controls on the actual parsed worker graph. Safe before load completes. */
  setControls(controls: readonly AvsComponentControl[]): void {
    if (this.disposed) return;
    this.pendingControls = controls.map((control) => ({ ...control }));
    if (!this.loaded) return;
    this.worker.postMessage({
      type: 'controls', generation: this.generation, revision: ++this.controlRevision,
      controls: this.pendingControls,
    });
  }

  setComponentControl(path: string, patch: Omit<AvsComponentControl, 'path'>): void {
    const current = this.pendingControls.find((control) => control.path === path) ?? { path };
    this.setControls([
      ...this.pendingControls.filter((control) => control.path !== path),
      { ...current, ...patch, path },
    ]);
  }

  /** Dispatches at most one frame. False means an existing frame is still running. */
  render(audio: AudioSnapshot, width: number, height: number): boolean {
    if (!this.active || !this.gate.tryBegin()) return false;
    fillAvsPcm(audio.waveform, this.pcm);
    const pcm = this.pcm.buffer;
    this.worker.postMessage({
      type: 'render', generation: this.generation, sequence: ++this.sequence,
      pcm, width, height,
    }, [pcm]);
    return true;
  }

  clear(): void {
    if (this.disposed) return;
    this.failLoad(new Error('AVS preset load superseded'));
    this.generation++;
    this.loaded = false;
    this.preset = null;
    this.pendingControls = [];
    this.dropLatest();
    this.gate.finish();
    this.worker.postMessage({ type: 'clear', generation: this.generation });
  }

  /**
   * Draw the latched frame (latchFrames mode), normally from rAF so the canvas
   * changes on vsync. `draw` defaults to the unscaled 1:1 draw. The bitmap is
   * closed afterwards either way. False when nothing new arrived.
   */
  presentLatest(draw?: (bitmap: ImageBitmap, width: number, height: number) => void): boolean {
    const frame = this.latest;
    if (!frame) return false;
    this.latest = null;
    const started = performance.now();
    try {
      if (draw) draw(frame.bitmap, frame.width, frame.height);
      else this.drawUnscaled(frame);
    } finally {
      frame.bitmap.close();
    }
    this.lastPresentMs = performance.now() - started;
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.worker.terminate();
  }

  private receive(message: AvsWorkerResponse): void {
    if (message.type === 'frame') {
      // Reclaim the transferred audio storage even for a stale preset frame.
      this.pcm = new Float32Array(message.pcm);
      this.gate.finish();
      if (message.generation !== this.generation || !this.loaded) {
        message.bitmap.close();
        this.onIdle?.();
        return;
      }
      this.renderedFrames++;
      if (this.latchFrames) {
        if (this.latest) {
          this.latest.bitmap.close();
          this.supersededFrames++;
        }
        this.latest = message;
      } else {
        const started = performance.now();
        this.drawUnscaled(message);
        message.bitmap.close();
        this.lastPresentMs = performance.now() - started;
      }
      this.lastWidth = message.width;
      this.lastHeight = message.height;
      this.lastRenderMs = message.renderMs;
      this.lastEffectMs = message.effectMs ?? message.renderMs;
      this.lastUploadMs = message.uploadMs ?? 0;
      this.lastEncodeSubmitMs = message.encodeSubmitMs ?? 0;
      this.gpuMs = message.gpuMs;
      this.gpuLatencyMs = message.gpuLatencyMs;
      this.gpuError = message.gpuError;
      this.presenter = message.presenter ?? 'cpu-image-data';
      this.gpuEffectPasses = message.gpuEffectPasses ?? 0;
      this.gpuEffectComponents = message.gpuEffectComponents ?? 0;
      this.gpuFusedPointwiseOperations = message.gpuFusedPointwiseOperations ?? 0;
      this.gpuEffectPlan = message.gpuEffectPlan ?? 'exact CPU fallback';
      this.gpuEnhancedSuperScope = message.gpuEnhancedSuperScope ?? false;
      this.gpuEnhancedDynamicMovement = message.gpuEnhancedDynamicMovement ?? false;
      this.gpuEnhancedDynamicMovementResidentMap = message.gpuEnhancedDynamicMovementResidentMap ?? false;
      this.gpuEnhancedMovementEel = message.gpuEnhancedMovementEel ?? false;
      this.emaMs = this.emaMs === 0 ? message.renderMs : this.emaMs * 0.85 + message.renderMs * 0.15;
      this.unsupported = message.unsupported;
      this.onFrame?.();
      this.onIdle?.();
      return;
    }
    if (message.generation !== this.generation) return;
    if (message.type === 'ready') {
      this.loaded = true;
      this.unsupported = message.unsupported;
      this.preset = message.preset;
      if (this.pendingControls.length) {
        this.worker.postMessage({
          type: 'controls', generation: this.generation, revision: ++this.controlRevision,
          controls: this.pendingControls,
        });
      }
      this.loadResolve?.();
      this.loadResolve = null;
      this.loadReject = null;
      return;
    }
    if (message.type === 'controls-applied') return;
    const error = new Error(message.message);
    this.failLoad(error);
    this.gate.finish();
  }

  private drawUnscaled(frame: AvsWorkerFrameMessage): void {
    if (this.canvas.width !== frame.width || this.canvas.height !== frame.height) {
      this.canvas.width = frame.width;
      this.canvas.height = frame.height;
    }
    this.context.drawImage(frame.bitmap, 0, 0);
  }

  private dropLatest(): void {
    this.latest?.bitmap.close();
    this.latest = null;
  }

  private failLoad(error: Error): void {
    this.loadReject?.(error);
    this.loadResolve = null;
    this.loadReject = null;
  }
}

/** Viewport in device pixels plus the DPR that converts them back to CSS pixels. */
export interface AvsViewport {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

/** The viewport in DEVICE pixels, from the uncapped DPR (the WebGPU surface caps DPR at 2). */
export function currentAvsViewport(): AvsViewport {
  const dpr = window.devicePixelRatio || 1;
  return {
    width: Math.max(1, Math.round(window.innerWidth * dpr)),
    height: Math.max(1, Math.round(window.innerHeight * dpr)),
    dpr,
  };
}

/**
 * Puts an AVS raster on the visible 2D canvas under an `AvsUpscaleMode`. The
 * AVS pixels themselves are never touched: this only chooses the backing-store
 * size, an integer nearest-neighbour prescale and the CSS box and filter.
 *
 * In the default `pixelated` mode the canvas is the raster, drawn 1:1 and
 * stretched by CSS with nearest, which is exactly the pre-existing path.
 */
export class AvsCanvasPresenter {
  mode: AvsUpscaleMode = 'pixelated';
  /** Crisp rasters: exact k x k blocks covering the viewport (see avsPresentationLayout). */
  integerCover = false;
  private cssKey = '';
  private scratch: HTMLCanvasElement | null = null;
  private scratchContext: CanvasRenderingContext2D | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly context: CanvasRenderingContext2D,
  ) {}

  /** Draw a bitmap or canvas holding a `width` x `height` AVS raster. */
  present(source: CanvasImageSource, width: number, height: number, viewport: AvsViewport): void {
    const layout = this.apply(width, height, viewport);
    if (layout.prescale === 1) {
      this.context.drawImage(source, 0, 0);
      return;
    }
    this.context.imageSmoothingEnabled = false;
    this.context.drawImage(source, 0, 0, layout.canvasWidth, layout.canvasHeight);
  }

  /** The CPU fallback's ImageData. 1:1 layouts keep the direct putImageData. */
  presentImageData(image: ImageData, viewport: AvsViewport): void {
    const layout = this.apply(image.width, image.height, viewport);
    if (layout.prescale === 1) {
      this.context.putImageData(image, 0, 0);
      return;
    }
    if (!this.scratch) {
      this.scratch = document.createElement('canvas');
      this.scratchContext = this.scratch.getContext('2d', { alpha: false });
    }
    if (!this.scratchContext) return;
    if (this.scratch.width !== image.width || this.scratch.height !== image.height) {
      this.scratch.width = image.width;
      this.scratch.height = image.height;
    }
    this.scratchContext.putImageData(image, 0, 0);
    this.context.imageSmoothingEnabled = false;
    this.context.drawImage(this.scratch, 0, 0, layout.canvasWidth, layout.canvasHeight);
  }

  private apply(width: number, height: number, viewport: AvsViewport): AvsPresentationLayout {
    const layout = avsPresentationLayout(this.mode, width, height, viewport.width, viewport.height, this.integerCover);
    if (this.canvas.width !== layout.canvasWidth || this.canvas.height !== layout.canvasHeight) {
      this.canvas.width = layout.canvasWidth;
      this.canvas.height = layout.canvasHeight;
    }
    const box = layout.box;
    const key = box
      ? `${box.left},${box.top},${box.width},${box.height},${viewport.dpr},${layout.imageRendering}`
      : layout.imageRendering;
    if (key !== this.cssKey) {
      this.cssKey = key;
      const style = this.canvas.style;
      style.imageRendering = layout.imageRendering;
      if (box) {
        const css = (devicePx: number): string => `${devicePx / viewport.dpr}px`;
        style.inset = 'auto';
        style.left = css(box.left);
        style.top = css(box.top);
        style.width = css(box.width);
        style.height = css(box.height);
        // Letterbox bars: black, whatever the WebGPU stage underneath last held.
        style.boxShadow = '0 0 0 100vmax #000';
      } else {
        style.inset = '0';
        style.width = '100vw';
        style.height = '100vh';
        style.boxShadow = '';
      }
    }
    return layout;
  }
}
