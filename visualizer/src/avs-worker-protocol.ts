/** Messages shared by the imported-AVS render worker and its browser client. */
import type { AvsComponentControl } from './avs/executor.ts';
import type { AvsAudioFrame, AvsPresetAst } from './avs/types.ts';
import type { AvsFrameGraphLane } from './avs/gpu-frame-graph.ts';
import type { NervSceneFrame, NervSceneId } from './nerv-scenes.ts';
import type { ClockGrid, HudNamedInterval, HudTempo, HudTrack } from './mpc-timing-types.ts';

/**
 * Previous-scene timing and transition fields shared by the NERV and HUD frames
 * (docs/design/CONTRACT.md C-11 and 2.4). Every field is optional; absent means the
 * behaviour that existed before the field was added.
 */
export interface SceneFadeFields {
  readonly previousTime?: number;
  readonly previousLocalTime?: number;
  readonly previousSceneStart?: number;
  readonly previousSceneEnd?: number | null;
  readonly blend?: number;
  /** Integer 0..TRANSITION_COUNT-1 (src/mpc-contract.ts). */
  readonly transitionMode?: number;
  readonly transitionSeed?: number;
  /** Finite, 0 < x <= 64; default 4. */
  readonly transitionBeats?: number;
  /** Integer 0..3; default 0. */
  readonly transitionBoundary?: number;
  /** Integer 0..1; default 1. */
  readonly transitionAccent?: number;
  /** Default false. */
  readonly transitionReduced?: boolean;
  /** Finite, >= 0; feeds TransitionEnv.seconds (exact under tempo maps). */
  readonly fadeSeconds?: number;
}

/** Absolute playback clock. The NERV worker is stateless across seeks. */
export interface NervPlaybackFrame extends Omit<NervSceneFrame, 'scene' | 'audio'>, SceneFadeFields {
  readonly previousScene?: NervSceneId;
}

/** Absolute playback frame for the HUD scene worker (Half 2). `previous` is identity only; its timing travels in the SceneFadeFields. */
export interface HudPlaybackFrame extends SceneFadeFields {
  readonly time: number;
  readonly seed: number;
  readonly revision: number;
  readonly grid: ClockGrid | null;
  readonly sceneStart: number;
  readonly sceneEnd: number | null;
  readonly tempo: HudTempo | null;
  readonly named?: readonly HudNamedInterval[];
  readonly track: HudTrack;
  /** The 64-float signal ABI of the HUD engine; null when no analysis is available. */
  readonly signals: Float32Array | null;
  readonly motion: 'full' | 'reduced';
  readonly flash: 'off' | 'limit' | 'strict';
  readonly previous?: { readonly sha256: string; readonly kind: 'hud' | 'nerv'; readonly scene?: NervSceneId };
}

export interface AvsWorkerLoadMessage {
  readonly type: 'load';
  readonly generation: number;
  readonly preset: ArrayBuffer;
  /** Optional package-scoped assets supplied by the full-collection host. */
  readonly bitmaps?: readonly { readonly name: string; readonly bytes: ArrayBuffer }[];
  /** Policy-resolved render size (AVS classic is identical to the historical fixed size). */
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
  readonly hud?: HudPlaybackFrame;
  /** Policy-resolved render size. */
  readonly width: number;
  readonly height: number;
  /** Stage timing (src/perf-worker.ts), honoured by the show worker only and absent (off) by default: mode 1 CPU timestamps, 2 with a GPU wait around GL stages; `sent` = the host's epoch time at postMessage. */
  readonly perf?: { readonly mode: 0 | 1 | 2; readonly sent?: number };
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

/** Cache one previous-scene manifest by hash in the HUD worker so a direct seek into a transition can rebuild both sides. */
export interface AvsWorkerStashMessage {
  readonly type: 'stash';
  readonly generation: number;
  readonly sha256: string;
  readonly preset: ArrayBuffer;
}

export type AvsWorkerRequest = AvsWorkerLoadMessage | AvsWorkerRenderMessage | AvsWorkerClearMessage | AvsWorkerControlsMessage;

/**
 * Inbox of the HUD scene worker: every AVS request plus `stash`. AvsWorkerRequest itself is deliberately
 * unchanged so the frozen AVS worker and client keep their exhaustive narrowing (contract Amendment A-1).
 */
export type HudWorkerRequest = AvsWorkerRequest | AvsWorkerStashMessage;

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
  /** HUD worker draw statistics (Half 2). */
  readonly hudStats?: {
    readonly draws: number; readonly fills: number; readonly strokes: number; readonly texts: number; readonly paths: number;
    readonly saves: number; readonly gradients: number; readonly clips: number; readonly area: number; readonly instruments: number;
    readonly skipped: number; readonly flashEvents: number; readonly degraded: number;
  };
  readonly renderMs: number;
  /** Per-stage timing of this frame (show worker only, and only when the render message asked for it: src/perf-trace.ts). */
  readonly perf?: import('./perf-trace.ts').WorkerPerfFrame;
}

export interface AvsWorkerErrorMessage {
  readonly type: 'error';
  readonly generation: number;
  readonly message: string;
  readonly fatal: boolean;
}

export type AvsWorkerResponse = AvsWorkerReadyMessage | AvsWorkerControlsAppliedMessage | AvsWorkerFrameMessage | AvsWorkerErrorMessage;
