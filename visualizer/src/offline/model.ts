import type { OfflineOutputProfile } from './profiles.ts';

export type OfflineRenderMode = 'preset' | 'auto';
export type OfflineEventKind = 'kick' | 'snare' | 'hat' | 'onset' | 'beat' | 'bar';

export type OfflineOutputTarget =
  | { readonly kind: 'directory-handle'; readonly handle: FileSystemDirectoryHandle }
  | { readonly kind: 'download' }
  | { readonly kind: 'path'; readonly path: string };

export interface OfflineRenderRequest {
  readonly audioFile: Blob;
  readonly mode: OfflineRenderMode;
  readonly presetId?: string;
  readonly customPresetBytes?: Uint8Array;
  readonly profileId: string;
  readonly seed: number;
  readonly bpm?: number;
  readonly meter?: string;
  readonly downbeatSample?: number;
  readonly availablePresetIds?: readonly string[];
  readonly output: OfflineOutputTarget;
}

export interface OfflineTempoAuthority {
  readonly bpm: number;
  readonly meterNumerator: number;
  readonly meterDenominator: number;
  readonly downbeatSample: number;
  readonly authority: 'provided' | 'analyzed' | 'analyzed_then_reviewed' | 'assumed_unreviewed';
}

export interface OfflineMusicalEvent {
  readonly id: string;
  readonly kind: OfflineEventKind;
  readonly sample: number;
  readonly frame: number;
  readonly confidence: number;
  readonly strength: number;
}

export interface OfflineFrameFeatures {
  readonly frame: number;
  readonly sample_start: number;
  readonly sample_end: number;
  readonly time_seconds: number;
  readonly global_beat: number;
  readonly bar: number;
  readonly slot_240: number;
  readonly beat_phase: number;
  readonly bar_phase: number;
  readonly bpm: number;
  readonly rms: Readonly<{ master: number; left: number; right: number }>;
  readonly peak: Readonly<{ master: number; left: number; right: number }>;
  readonly energy: Readonly<{ low: number; mid: number; high: number }>;
  readonly spectral_centroid: number;
  readonly spectral_flux: number;
  readonly onset_strength: number;
  readonly events: readonly Readonly<{ kind: OfflineEventKind; confidence: number; sample: number }>[];
  readonly active_preset: string;
  readonly active_layers: readonly string[];
  readonly deterministic_seed: number;
  readonly transition: Readonly<{ active: boolean; progress: number; from?: string; to?: string }>;
}

export interface PresetScheduleEntry {
  readonly index: number;
  readonly sampleStart: number;
  readonly sampleEnd: number;
  readonly frameStart: number;
  readonly frameEnd: number;
  readonly presetId: string;
  readonly seed: number;
  readonly transitionSamples: number;
}

export interface PresetScheduleLedger {
  readonly mode: OfflineRenderMode;
  readonly sourceSeed: number;
  readonly entries: readonly PresetScheduleEntry[];
  readonly sha256?: string;
}

export interface OfflineAnchor {
  readonly id: string;
  readonly role: 'reference' | 'first' | 'last';
  readonly frame: number;
  readonly sample: number;
  readonly reason: string;
  readonly sourceEventId?: string;
  readonly pngPath: string;
  readonly pngSha256?: string;
}

export interface OfflineSegment {
  readonly id: string;
  readonly sampleStart: number;
  readonly sampleEnd: number;
  readonly frameStart: number;
  readonly frameEnd: number;
  readonly editorialFrameCount: number;
  readonly imageInputs: readonly string[];
  readonly audioInputs: readonly string[];
  readonly promptSlot: number;
  readonly h3GenerationFrameRequest: number | null;
  readonly h3FramePolicy: 'unresolved_requires_minimax_adapter';
}

export interface OfflineAnalysisResult {
  readonly analyzer: 'aaavs_tier_a_three_band_v1';
  readonly tempo: OfflineTempoAuthority;
  readonly frames: readonly OfflineFrameFeatures[];
  readonly events: readonly OfflineMusicalEvent[];
  readonly anchors: readonly OfflineAnchor[];
  readonly segments: readonly OfflineSegment[];
}

export interface OfflineRenderPlan {
  readonly schema: 'aaavs_offline_render_plan_v1';
  readonly profile: OfflineOutputProfile;
  readonly totalSamplesPerChannel: number;
  readonly durationSeconds: number;
  readonly frameCount: number;
  readonly schedule: PresetScheduleLedger;
  readonly analysis: OfflineAnalysisResult;
}

/** Mirrors FlashMode in src/flash-limiter.ts; kept local so the model has no page imports. */
export type OfflineFlashLimitMode = 'off' | 'limit' | 'strict';

export interface OfflineManifest {
  readonly schema: 'aaavs_minimax_anchor_package_v1';
  readonly source_audio: {
    readonly path: string;
    readonly sha256: string;
    readonly sample_rate: 48_000;
    readonly channels: 2;
    readonly sample_format: string;
    readonly total_samples_per_channel: number;
  };
  readonly original_input?: {
    readonly path: string;
    readonly sha256: string;
    readonly note: 'decoded_and_normalized_to_source_audio';
  };
  readonly video: {
    readonly width: number;
    readonly height: number;
    readonly fps_num: number;
    readonly fps_den: number;
    readonly samples_per_frame: number | null;
    readonly frame_count: number;
    readonly color: 'sRGB RGB24';
    readonly transition_blend?: 'srgb-integer' | 'linear-light';
    readonly flash_limit?: { readonly mode: OfflineFlashLimitMode; readonly limited_frames: number };
    /** Every frame PNG carries an sRGB chunk; the pixel ledger hashes pre-filter RGB24, unaffected by it. */
    readonly png_color_chunk?: 'sRGB rendering-intent 0';
  };
  readonly tempo: OfflineTempoAuthority;
  readonly preset_authority: { readonly id: string; readonly sha256?: string; readonly seed: number; readonly mode: OfflineRenderMode };
  readonly renderer_authority: { readonly commit: string; readonly bundle_sha256: string; readonly user_agent?: string; readonly gpu_adapter?: string };
  readonly sidecars: Readonly<Record<string, string>>;
  readonly determinism: {
    readonly event_manifest_sha256: string;
    readonly schedule_sha256: string;
    readonly cross_adapter_pixels_guaranteed: false;
    readonly pixel_semantics?: {
      readonly version: number;
      readonly pcm_window: string;
      readonly cue_start: string;
      readonly randomness: string;
      readonly custom_bpm_clock: string;
    };
  };
}
