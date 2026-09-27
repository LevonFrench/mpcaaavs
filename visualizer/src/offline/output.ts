import { StereoAnalysisBuffer } from './audio-buffer.ts';
import { sha256Hex, stableJson } from './hash.ts';
import type { OfflineAnalysisResult, OfflineFlashLimitMode, OfflineManifest, OfflineRenderPlan } from './model.ts';
import type { OfflinePixelSemantics } from './pixel-semantics.ts';
import { CANONICAL_SAMPLES_PER_FRAME } from './timebase.ts';

export const OFFLINE_PACKAGE_NAMES = Object.freeze({
  manifest: 'manifest.json', features: 'features.frames.jsonl', events: 'events.json',
  anchors: 'anchors.json', segments: 'segments.json', checksums: 'sha256sums.txt', audio: 'audio/track.wav',
  pixels: 'pixels.rgb24.sha256.jsonl',
});

/** Describes exactly what each pixel-ledger hash covers, recorded in the manifest. */
export const PIXEL_LEDGER_HASH_INPUT = 'sha256 of unfiltered RGB24 bytes, row-major, width*3 bytes per row, no PNG filter bytes';

export interface PixelLedgerEntry {
  readonly frame: number;
  readonly path: string;
  readonly rgbSha256: string;
}

/**
 * One JSON line per frame binding each PNG path to the hash of its decoded
 * pixels, so frame authority survives a change of PNG encoder or zlib build.
 */
export function serializePixelLedger(entries: readonly PixelLedgerEntry[]): string {
  return entries.map((entry) => stableJson({ frame: entry.frame, path: entry.path, rgb24_sha256: entry.rgbSha256 })).join('\n')
    + (entries.length ? '\n' : '');
}

export function offlineFramePath(frame: number): string {
  if (!Number.isSafeInteger(frame) || frame < 0) throw new RangeError('frame must be non-negative');
  return `frames/frame_${frame.toString().padStart(6, '0')}.png`;
}

export function serializeFeaturesJsonl(analysis: OfflineAnalysisResult): string {
  return analysis.frames.map((frame) => stableJson(frame)).join('\n') + (analysis.frames.length ? '\n' : '');
}
export function serializeEvents(analysis: OfflineAnalysisResult): string { return stableJson(analysis.events, 2) + '\n'; }
export function serializeAnchors(analysis: OfflineAnalysisResult): string { return stableJson(analysis.anchors, 2) + '\n'; }
export function serializeSegments(analysis: OfflineAnalysisResult): string { return stableJson(analysis.segments, 2) + '\n'; }

/** Canonical 48 kHz stereo PCM signed 16-bit little-endian WAVE. */
export function encodeStereoPcmS16leWav(buffer: StereoAnalysisBuffer, start = 0, end = buffer.totalSamplesPerChannel): Uint8Array {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > buffer.totalSamplesPerChannel) {
    throw new RangeError('invalid WAV sample interval');
  }
  const frames = end - start;
  const dataBytes = frames * 4;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  ascii(bytes, 0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); ascii(bytes, 8, 'WAVE');
  ascii(bytes, 12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 2, true); view.setUint32(24, 48_000, true); view.setUint32(28, 192_000, true);
  view.setUint16(32, 4, true); view.setUint16(34, 16, true); ascii(bytes, 36, 'data'); view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let sample = start; sample < end; sample++) {
    view.setInt16(offset, pcm16(buffer.sample(0, sample)), true);
    view.setInt16(offset + 2, pcm16(buffer.sample(1, sample)), true);
    offset += 4;
  }
  return bytes;
}

export interface RendererAuthority {
  readonly commit: string;
  readonly bundleSha256: string;
  /** Hash of the PNG encoder worker bundle when frames were encoded off the render thread. */
  readonly encoderBundleSha256?: string;
  readonly userAgent?: string;
  readonly gpuAdapter?: string;
}

/**
 * Optional authority records added to the v1 manifest. Absent fields keep the
 * manifest exactly as before; each opt-in that changes pixels is named here.
 */
export interface OfflineManifestExtras {
  /** Path and hash of the pixel ledger written with serializePixelLedger. */
  readonly pixelLedger?: { readonly path: string; readonly sha256: string; readonly frameCount: number };
  /** Crossfade compositing used for preset transitions ('srgb-integer' is the historical default). */
  readonly transitionBlend?: 'srgb-integer' | 'linear-light';
  /**
   * Flash limiting applied to the written frames. 'off' is the default and
   * leaves pixels untouched; the mode is recorded either way when given.
   */
  readonly flashLimit?: { readonly mode: OfflineFlashLimitMode; readonly limitedFrames: number };
  /** The renderer's frame semantics (OFFLINE_PIXEL_SEMANTICS for this build). */
  readonly pixelSemantics?: OfflinePixelSemantics;
}

export function bindAnchorHashes(plan: OfflineRenderPlan, hashes: Readonly<Record<string, string>>): OfflineRenderPlan {
  const anchors = plan.analysis.anchors.map((anchor) => {
    const pngSha256 = hashes[anchor.pngPath];
    if (!pngSha256) throw new Error(`missing authoritative anchor hash: ${anchor.pngPath}`);
    return Object.freeze({ ...anchor, pngSha256 });
  });
  return Object.freeze({
    ...plan,
    analysis: Object.freeze({ ...plan.analysis, anchors: Object.freeze(anchors) }),
  });
}

export async function createOfflineManifest(
  plan: OfflineRenderPlan,
  buffer: StereoAnalysisBuffer,
  renderer: RendererAuthority,
  hashes: Readonly<Record<string, string>>,
  extras: OfflineManifestExtras = {},
): Promise<OfflineManifest> {
  const sourceSha256 = hashes[OFFLINE_PACKAGE_NAMES.audio]
    ?? await sha256Hex(encodeStereoPcmS16leWav(buffer));
  const scheduleSha256 = await sha256Hex(stableJson(plan.schedule));
  const eventSha256 = await sha256Hex(serializeEvents(plan.analysis));
  const exactSamplesPerFrame = plan.profile.fpsDenominator === 1 && 48_000 % plan.profile.fpsNumerator === 0
    ? 48_000 / plan.profile.fpsNumerator : null;
  const firstPreset = plan.schedule.entries[0];
  if (!firstPreset) throw new Error('cannot create manifest for an empty schedule');
  return Object.freeze({
    schema: 'aaavs_minimax_anchor_package_v1',
    source_audio: Object.freeze({
      path: OFFLINE_PACKAGE_NAMES.audio, sha256: sourceSha256, sample_rate: 48_000, channels: 2,
      sample_format: 'pcm_s16le', total_samples_per_channel: buffer.totalSamplesPerChannel,
    }),
    ...(buffer.sourceSha256 ? {
      original_input: Object.freeze({
        path: buffer.sourcePath, sha256: buffer.sourceSha256,
        note: 'decoded_and_normalized_to_source_audio' as const,
      }),
    } : {}),
    video: Object.freeze({
      width: plan.profile.width, height: plan.profile.height,
      fps_num: plan.profile.fpsNumerator, fps_den: plan.profile.fpsDenominator,
      samples_per_frame: exactSamplesPerFrame, frame_count: plan.frameCount, color: 'sRGB RGB24',
      ...(extras.transitionBlend ? { transition_blend: extras.transitionBlend } : {}),
      ...(extras.flashLimit ? {
        flash_limit: Object.freeze({ mode: extras.flashLimit.mode, limited_frames: extras.flashLimit.limitedFrames }),
      } : {}),
      png_color_chunk: 'sRGB rendering-intent 0',
    }),
    tempo: plan.analysis.tempo,
    preset_authority: Object.freeze({
      id: plan.schedule.mode === 'preset' ? firstPreset.presetId : 'deterministic-auto-ledger',
      seed: plan.schedule.sourceSeed, mode: plan.schedule.mode,
    }),
    renderer_authority: Object.freeze({
      commit: renderer.commit, bundle_sha256: renderer.bundleSha256,
      ...(renderer.encoderBundleSha256 ? { encoder_bundle_sha256: renderer.encoderBundleSha256 } : {}),
      ...(renderer.userAgent ? { user_agent: renderer.userAgent } : {}),
      ...(renderer.gpuAdapter ? { gpu_adapter: renderer.gpuAdapter } : {}),
    }),
    ...(extras.pixelLedger ? {
      pixel_authority: Object.freeze({
        ledger: extras.pixelLedger.path, sha256: extras.pixelLedger.sha256,
        frame_count: extras.pixelLedger.frameCount, hash_input: PIXEL_LEDGER_HASH_INPUT,
      }),
    } : {}),
    sidecars: Object.freeze({ ...hashes }),
    determinism: Object.freeze({
      event_manifest_sha256: eventSha256, schedule_sha256: scheduleSha256,
      cross_adapter_pixels_guaranteed: false,
      ...(extras.pixelSemantics ? { pixel_semantics: Object.freeze({ ...extras.pixelSemantics }) } : {}),
    }),
  });
}

export interface PackageSink {
  /** Implementations must stage writes outside the final package name. */
  write(path: string, data: Uint8Array): Promise<void>;
  /** Atomically promotes the validated staging area where the platform permits it. */
  commit(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export class TransactionalPackageWriter {
  readonly #sink: PackageSink;
  readonly #hashes = new Map<string, string>();
  #state: 'open' | 'committed' | 'aborted' = 'open';

  constructor(sink: PackageSink) { this.#sink = sink; }
  get hashes(): Readonly<Record<string, string>> { return Object.freeze(Object.fromEntries(this.#hashes)); }

  async write(path: string, data: string | Uint8Array): Promise<string> {
    this.assertOpen();
    validatePackagePath(path);
    if (this.#hashes.has(path)) throw new Error(`package path already written: ${path}`);
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const hash = await sha256Hex(bytes);
    await this.#sink.write(path, bytes);
    this.#hashes.set(path, hash);
    return hash;
  }

  registerExisting(path: string, sha256: string): void {
    this.assertOpen();
    validatePackagePath(path);
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`invalid SHA-256 for ${path}`);
    if (this.#hashes.has(path)) throw new Error(`package path already registered: ${path}`);
    this.#hashes.set(path, sha256);
  }

  async writeStandardSidecars(plan: OfflineRenderPlan, buffer: StereoAnalysisBuffer): Promise<void> {
    await this.write(OFFLINE_PACKAGE_NAMES.features, serializeFeaturesJsonl(plan.analysis));
    await this.write(OFFLINE_PACKAGE_NAMES.events, serializeEvents(plan.analysis));
    await this.write(OFFLINE_PACKAGE_NAMES.anchors, serializeAnchors(plan.analysis));
    await this.write(OFFLINE_PACKAGE_NAMES.segments, serializeSegments(plan.analysis));
    await this.write(OFFLINE_PACKAGE_NAMES.audio, encodeStereoPcmS16leWav(buffer));
    for (const segment of plan.analysis.segments) {
      await this.write(segment.audioInputs[0]!, encodeStereoPcmS16leWav(buffer, segment.sampleStart, segment.sampleEnd));
    }
  }

  async finalize(manifest: OfflineManifest): Promise<void> {
    const checksumText = [...this.#hashes].sort(([a], [b]) => a.localeCompare(b))
      .map(([path, hash]) => `${hash}  ${path}`).join('\n') + '\n';
    // sha256sums cannot contain itself or the last-written completion manifest
    // without circular definitions.
    const checksumHash = await this.write(OFFLINE_PACKAGE_NAMES.checksums, checksumText);
    const boundManifest: OfflineManifest = Object.freeze({
      ...manifest,
      sidecars: Object.freeze({ ...manifest.sidecars, [OFFLINE_PACKAGE_NAMES.checksums]: checksumHash }),
    });
    await this.write(OFFLINE_PACKAGE_NAMES.manifest, stableJson(boundManifest, 2) + '\n');
    await this.#sink.commit();
    this.#state = 'committed';
  }

  async abort(reason?: unknown): Promise<void> {
    if (this.#state !== 'open') return;
    this.#state = 'aborted';
    await this.#sink.abort(reason);
  }
  private assertOpen(): void { if (this.#state !== 'open') throw new Error(`package transaction is ${this.#state}`); }
}

function pcm16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0));
  return clamped <= -1 ? -32_768 : Math.round(clamped * 32_767);
}
function ascii(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) target[offset + i] = text.charCodeAt(i);
}
function validatePackagePath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) throw new Error(`unsafe package path: ${path}`);
}

// Compile-time assertion documenting the canonical authority's exact ratio.
void CANONICAL_SAMPLES_PER_FRAME;
