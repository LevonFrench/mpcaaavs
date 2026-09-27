/** Browser-worker protocol for deterministic, frame-complete AVS exports. */

import type { FlashMode } from './flash-limiter.ts';

export interface OfflinePresetTransfer {
  readonly presetId: string;
  readonly presetSha256: string;
  readonly bytes: ArrayBuffer;
}

export interface OfflinePresetCueTransfer {
  /** Inclusive output frame at which this preset becomes active. */
  readonly frame: number;
  readonly presetId: string;
  readonly seed: number;
  /** Crossfade duration beginning at this cue. Zero for the initial cue. */
  readonly transitionFrames: number;
}

export interface OfflineRenderStartMessage {
  readonly type: 'start';
  readonly jobId: string;
  readonly width: number;
  readonly height: number;
  readonly fpsNum: number;
  readonly fpsDen: number;
  readonly sampleRate: 48000;
  readonly totalSamples: number;
  /** Immutable, deinterleaved, normalized 48 kHz analysis channels. */
  readonly left: ArrayBuffer;
  readonly right: ArrayBuffer;
  /** One transferred byte buffer per unique preset used by the cue ledger. */
  readonly presetBank: readonly OfflinePresetTransfer[];
  /** Sorted, deterministic preset schedule. The first cue must start at frame zero. */
  readonly presetCues: readonly OfflinePresetCueTransfer[];
  /** Already checked by the client; the worker checks again before creating frames/. */
  readonly outputDirectory: FileSystemDirectoryHandle;
  /**
   * Crossfade compositing for preset transitions. 'srgb-integer' (default) is
   * the historical integer mix of 8-bit sRGB code values; 'linear-light' mixes
   * in linear light and is an explicit opt-in recorded in the manifest.
   */
  readonly transitionBlend?: OfflineTransitionBlend;
  /**
   * Opt-in photosensitive flash limiting of the written frames. Omitted or
   * 'off' (the default) leaves every byte unchanged; 'limit' / 'strict' run the
   * deterministic in-place limiter (src/flash-limiter.ts) on the composed frame
   * and are recorded in the manifest.
   */
  readonly flashLimit?: FlashMode;
  /** Debug only: probe for an existing file before every frame write. */
  readonly debugRefuseExistingFrames?: boolean;
  /** Upper bound on dedicated PNG encoder workers; 0 forces in-thread encoding. */
  readonly maxEncoderWorkers?: number;
}

export type OfflineTransitionBlend = 'srgb-integer' | 'linear-light';

/**
 * Per-stage timings for the render loop. All values are milliseconds of wall
 * time; encodeBusyMs is the union of intervals with at least one frame in
 * encode/write, so it never exceeds elapsed time however many run at once.
 */
export interface OfflineRenderTelemetry {
  /** renderPcm calls only (both runtimes during a transition). */
  readonly renderCpuMs: number;
  /** Transition blend plus RGB scanline packing. */
  readonly packBlendMs: number;
  /** Time the render loop waited for a free scanline buffer (encode/IO backpressure). */
  readonly loopStallMs: number;
  /** Union of intervals during which any frame was being encoded or written. */
  readonly encodeBusyMs: number;
  /** Summed per-frame DEFLATE wall time across encoders. */
  readonly deflateMs: number;
  /** Summed per-frame hash + file write wall time across encoders. */
  readonly writeMs: number;
  /** Dedicated encoder workers in use; 0 means encoding shares the render thread. */
  readonly encoderWorkers: number;
}

export interface OfflineRenderControlMessage {
  readonly type: 'pause' | 'resume' | 'cancel';
  readonly jobId: string;
}

export type OfflineRenderWorkerRequest = OfflineRenderStartMessage | OfflineRenderControlMessage;

export interface OfflineFrameArtifact {
  readonly frame: number;
  readonly path: string;
  readonly sha256: string;
  /**
   * SHA-256 of the unfiltered RGB24 raster (row-major, width*3 bytes per row,
   * no PNG filter bytes). Encoder-independent pixel authority.
   */
  readonly rgbSha256: string;
  readonly bytes: number;
  readonly sampleStart: number;
  readonly sampleEnd: number;
}

export interface OfflineRenderStartedMessage {
  readonly type: 'started';
  readonly jobId: string;
  readonly frameCount: number;
  readonly encoderWorkers?: number;
}

export interface OfflineRenderProgressMessage {
  readonly type: 'progress';
  readonly jobId: string;
  readonly renderedFrames: number;
  readonly writtenFrames: number;
  readonly frameCount: number;
  readonly queueDepth: number;
  readonly elapsedMs: number;
  readonly renderMs: number;
  readonly encodeWriteMs: number;
  readonly telemetry?: OfflineRenderTelemetry;
}

export interface OfflineRenderCompleteMessage {
  readonly type: 'complete';
  readonly jobId: string;
  readonly frameCount: number;
  readonly elapsedMs: number;
  readonly renderMs: number;
  readonly encodeWriteMs: number;
  readonly peakQueueDepth: number;
  readonly artifacts: readonly OfflineFrameArtifact[];
  readonly telemetry?: OfflineRenderTelemetry;
  readonly transitionBlend?: OfflineTransitionBlend;
  /** Flash limiting applied to the written frames ('off' when absent). */
  readonly flashLimit?: FlashMode;
  /** Frames whose written pixels the flash limiter changed. */
  readonly flashLimitedFrames?: number;
  /** OFFLINE_PIXEL_SEMANTICS_VERSION of the worker that rendered the frames. */
  readonly pixelSemanticsVersion?: number;
  /** SHA-256 of the encoder worker bundle bytes that encoded the frames, when off-thread. */
  readonly encoderBundleSha256?: string;
}

export interface OfflineRenderPausedMessage {
  readonly type: 'paused' | 'resumed';
  readonly jobId: string;
}

export interface OfflineRenderCancelledMessage {
  readonly type: 'cancelled';
  readonly jobId: string;
  readonly renderedFrames: number;
  readonly writtenFrames: number;
}

export interface OfflineRenderErrorMessage {
  readonly type: 'error';
  readonly jobId: string;
  readonly message: string;
}

export type OfflineRenderWorkerResponse =
  | OfflineRenderStartedMessage
  | OfflineRenderProgressMessage
  | OfflineRenderCompleteMessage
  | OfflineRenderPausedMessage
  | OfflineRenderCancelledMessage
  | OfflineRenderErrorMessage;

/*
 * Render worker <-> PNG encoder worker. The render worker owns a ring of
 * filtered-scanline buffers and transfers one per frame; the encoder deflates,
 * hashes and writes it with the same writePngFrame used in-thread, then
 * transfers the buffer back for reuse.
 */

export interface OfflineEncodeInitMessage {
  readonly type: 'init';
  readonly width: number;
  readonly height: number;
  /** The package's frames/ directory; handles are structured-cloneable. */
  readonly framesDirectory: FileSystemDirectoryHandle;
  readonly refuseExisting: boolean;
}

export interface OfflineEncodeFrameMessage {
  readonly type: 'encode';
  readonly frame: number;
  /** Transferred filter-Sub scanlines, rgbScanlineBytes(width, height) long. */
  readonly scanlines: ArrayBuffer;
}

export interface OfflineEncodeCancelMessage {
  readonly type: 'cancel';
}

export type OfflineEncodeWorkerRequest =
  | OfflineEncodeInitMessage
  | OfflineEncodeFrameMessage
  | OfflineEncodeCancelMessage;

export interface OfflineEncodeReadyMessage {
  readonly type: 'ready';
}

export interface OfflineEncodeDoneMessage {
  readonly type: 'encoded';
  readonly frame: number;
  /** Returned storage for the next frame. */
  readonly scanlines: ArrayBuffer;
  /** Null when cancelled before the file was committed. */
  readonly result: {
    readonly sha256: string;
    readonly bytes: number;
    readonly deflateMs: number;
    readonly writeMs: number;
  } | null;
}

export interface OfflineEncodeErrorMessage {
  readonly type: 'error';
  readonly message: string;
  readonly frame?: number;
  readonly scanlines?: ArrayBuffer;
}

export type OfflineEncodeWorkerResponse =
  | OfflineEncodeReadyMessage
  | OfflineEncodeDoneMessage
  | OfflineEncodeErrorMessage;
