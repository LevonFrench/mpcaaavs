/** Messages shared by the imported-AVS render worker and its browser client. */
import type { AvsComponentControl } from './avs/executor.ts';
import type { AvsAudioFrame, AvsPresetAst } from './avs/types.ts';
import type { AvsFrameGraphLane } from './avs/gpu-frame-graph.ts';
import type { NervSceneFrame, NervSceneId } from './nerv-scenes.ts';

/** Absolute playback clock. The NERV worker is stateless across seeks. */
export interface NervPlaybackFrame extends Omit<NervSceneFrame, 'scene' | 'audio'> {
  readonly previousScene?: NervSceneId;
  readonly previousLocalTime?: number;
  readonly previousTime?: number;
  readonly blend?: number;
  readonly transitionMode?: number;
  readonly transitionSeed?: number;
}

export interface AvsWorkerLoadMessage {
  readonly type: 'load';
  readonly generation: number;
  readonly preset: ArrayBuffer;
  /** Optional package-scoped assets supplied by the full-collection host. */
  readonly bitmaps?: readonly { readonly name: string; readonly bytes: ArrayBuffer }[];
  readonly width: number;
  readonly height: number;
  readonly gpuLane: AvsFrameGraphLane;
}

export interface AvsWorkerRenderMessage {
  readonly type: 'render';
  readonly generation: number;
  readonly sequence: number;
  readonly pcm: ArrayBuffer;
  /** Host-accumulated full-band audio; legacy clients may continue sending PCM only. */
  readonly audio?: AvsAudioFrame;
  readonly nerv?: NervPlaybackFrame;
  readonly width: number;
  readonly height: number;
}

export interface AvsWorkerClearMessage {
  readonly type: 'clear';
  readonly generation: number;
}

export interface AvsWorkerControlsMessage {
  readonly type: 'controls';
  readonly generation: number;
  readonly revision: number;
  readonly controls: readonly AvsComponentControl[];
}

export type AvsWorkerRequest = AvsWorkerLoadMessage | AvsWorkerRenderMessage | AvsWorkerClearMessage | AvsWorkerControlsMessage;

export interface AvsWorkerReadyMessage {
  readonly type: 'ready';
  readonly generation: number;
  readonly unsupported: number;
  /** Parsed graph returned once so the editor can display the real AVS tree. */
  readonly preset: AvsPresetAst;
}

export interface AvsWorkerControlsAppliedMessage {
  readonly type: 'controls-applied';
  readonly generation: number;
  readonly revision: number;
}

export interface AvsWorkerFrameMessage {
  readonly type: 'frame';
  readonly generation: number;
  readonly sequence: number;
  readonly bitmap: ImageBitmap;
  /** Returned to the browser so the next request reuses the same audio storage. */
  readonly pcm: ArrayBuffer;
  readonly width: number;
  readonly height: number;
  readonly unsupported: number;
  /** Total compatibility-effect execution, excluding terminal presentation. */
  readonly effectMs?: number;
  readonly presenter?: 'webgpu-exact' | 'webgpu-enhanced' | 'cpu-image-data';
  /** CPU time spent queueing the packed u32 upload (WebGPU only). */
  readonly uploadMs?: number;
  /** CPU time spent encoding/submitting the terminal pass (WebGPU only). */
  readonly encodeSubmitMs?: number;
  readonly gpuEffectPasses?: number;
  /** Logical AVS components removed from the CPU suffix. */
  readonly gpuEffectComponents?: number;
  /** Stateless pointwise AVS operations represented inside fused passes. */
  readonly gpuFusedPointwiseOperations?: number;
  readonly gpuEffectPlan?: string;
  readonly gpuEnhancedSuperScope?: boolean;
  readonly gpuEnhancedDynamicMovement?: boolean;
  readonly gpuEnhancedDynamicMovementResidentMap?: boolean;
  readonly gpuEnhancedMovementEel?: boolean;
  /** Rolling-average GPU time of the node chain plus terminal pass (timestamp-query only). */
  readonly gpuMs?: number;
  /**
   * Worker frame start to GPU queue completion for the most recently completed
   * frame. Excludes the postMessage hop and the main-thread drawImage.
   */
  readonly gpuLatencyMs?: number;
  /** Most recent device-lost reason or uncaptured GPU error. Sticky after a recovery. */
  readonly gpuError?: string;
  readonly renderMs: number;
}

export interface AvsWorkerErrorMessage {
  readonly type: 'error';
  readonly generation: number;
  readonly message: string;
  readonly fatal: boolean;
}

export type AvsWorkerResponse = AvsWorkerReadyMessage | AvsWorkerControlsAppliedMessage | AvsWorkerFrameMessage | AvsWorkerErrorMessage;
