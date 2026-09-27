import {
  AVS_PRESET_SOURCES, type AvsPresetEntry, type AvsPresetSourceId,
} from './avs/preset-sources.ts';
import { OfflineRenderClient, offlineBoundBy, type OfflineRenderClientStart } from './offline-render-client.ts';
import type { OfflineRenderProgressMessage, OfflineRenderTelemetry } from './offline-render-protocol.ts';
import {
  bindAnchorHashes,
  createOfflineManifest,
  normalizeDecodedAudio,
  OFFLINE_PACKAGE_NAMES,
  OFFLINE_PIXEL_SEMANTICS,
  OUTPUT_PROFILES,
  prepareOfflineRender,
  serializePixelLedger,
  sha256Hex,
  TransactionalPackageWriter,
  type OfflineRenderSession,
  type PackageSink,
  type StereoAnalysisBuffer,
} from './offline/index.ts';
import {
  createOfflineStudio,
  type OfflineProgress,
  type OfflineStudioController,
  type OfflineStudioDraft,
  type OfflineTrackSummary,
} from './offline-studio.ts';

interface BrowserOfflineStudio {
  readonly studio: OfflineStudioController;
  dispose(): void;
}

/** Wire the full-screen offline studio to the deterministic engine and AVS worker. */
export function createBrowserOfflineStudio(): BrowserOfflineStudio {
  let analysisBuffer: StereoAnalysisBuffer | null = null;
  let session: OfflineRenderSession | null = null;
  let client: OfflineRenderClient | null = null;
  let previewAt = 0;
  let outputDirectory: FileSystemDirectoryHandle | null = null;
  let disposed = false;

  const studio = createOfflineStudio({
    presets: [],
    profiles: OUTPUT_PROFILES.map((profile) => ({
      id: profile.id, label: profile.label,
      width: profile.width, height: profile.height,
      fpsNum: profile.fpsNumerator, fpsDen: profile.fpsDenominator,
      purpose: profilePurpose(profile.kind), authority: profile.canonicalMiniMaxAuthority,
      availability: profile.frameFormat === 'png-rgb24' ? 'browser' : 'post-render',
    })),
    async onAnalyzeTrack(file) {
      studio.setState({ status: 'analyzing', error: null });
      const sourceSha256 = await sha256Hex(file);
      const context = new AudioContext({ sampleRate: 48_000 });
      try {
        const decoded = await context.decodeAudioData(await file.arrayBuffer());
        analysisBuffer = normalizeDecodedAudio(decoded, {
          sourceSha256, sourceSampleFormat: file.type || 'decoded_audio', sourcePath: file.name,
        });
      } finally {
        await context.close();
      }
      const waveform = overviewWaveform(analysisBuffer);
      const summary: OfflineTrackSummary = {
        name: file.name, durationSeconds: analysisBuffer.durationSeconds,
        sampleRate: analysisBuffer.sampleRate, channels: analysisBuffer.channels,
        totalSamplesPerChannel: analysisBuffer.totalSamplesPerChannel,
        sha256: sourceSha256, waveform,
      };
      studio.setWaveform(waveform);
      return summary;
    },
    async onStart(draft) {
      if (!analysisBuffer) throw new Error('Analyze an audio track before rendering.');
      if (draft.bpm === null || !(draft.bpm > 0)) {
        throw new Error('Confirm a positive BPM before rendering; AAAVS will not label a 120 BPM fallback as analyzed.');
      }
      if (!isDirectoryHandle(draft.outputDirectoryHandle)) {
        throw new Error('Choose an empty output directory. Full track packages require the File System Access API.');
      }
      outputDirectory = draft.outputDirectoryHandle;
      studio.appendLog('Freezing timeline, events, anchors and preset schedule');
      const sourceId = selectedSourceId(draft);
      const availableEntries = draft.customPresetFile
        ? Object.freeze([])
        : draft.mode === 'auto'
          ? await AVS_PRESET_SOURCES.autoBank(sourceId)
          : Object.freeze([await AVS_PRESET_SOURCES.require(sourceId, draft.presetId ?? '')]);
      if (draft.mode === 'auto' && availableEntries.length === 0) {
        throw new Error(`${sourceId} has no compatible AVS presets available for automatic rendering.`);
      }
      session = prepareOfflineRender(analysisBuffer, {
        profileId: draft.profileId, mode: draft.mode,
        ...(draft.mode === 'preset' ? { presetId: selectedPresetId(draft, availableEntries[0]) } : {}),
        ...(draft.mode === 'auto' ? { availablePresetIds: availableEntries.map((preset) => preset.ledgerId) } : {}),
        seed: draft.seed, bpm: draft.bpm, meter: draft.meter, downbeatSample: draft.downbeatSample,
      });
      const prepared = await preparePresets(session, draft, availableEntries);
      const pcm = planarCopy(analysisBuffer);
      const profile = session.plan.profile;
      const workerInput: OfflineRenderClientStart = {
        jobId: crypto.randomUUID(), width: profile.width, height: profile.height,
        fpsNum: profile.fpsNumerator, fpsDen: profile.fpsDenominator,
        sampleRate: 48_000, totalSamples: analysisBuffer.totalSamplesPerChannel,
        left: pcm.left, right: pcm.right,
        presetBank: prepared.bank, presetCues: prepared.cues,
        outputDirectory,
        ...(draft.linearLightTransitions ? { transitionBlend: 'linear-light' as const } : {}),
        ...(draft.flashLimitFrames ? { flashLimit: 'limit' as const } : {}),
      };
      const startedAt = performance.now();
      client = new OfflineRenderClient({
        onStarted(frameCount, encoderWorkers) {
          studio.appendLog(`Worker armed for ${frameCount.toLocaleString()} frame-complete renders`);
          studio.appendLog(encoderWorkers > 0
            ? `PNG encoding on ${encoderWorkers} dedicated worker${encoderWorkers === 1 ? '' : 's'}`
            : 'PNG encoding shares the render thread (encoder workers unavailable)', encoderWorkers > 0 ? 'info' : 'warning');
          studio.updateProgress({ stage: 'Rendering RGB24 frames', totalFrames: frameCount });
        },
        onProgress(progress) {
          const elapsedSeconds = progress.elapsedMs / 1_000;
          const throughput = elapsedSeconds > 0 ? progress.writtenFrames / elapsedSeconds : 0;
          const remaining = progress.frameCount - progress.writtenFrames;
          studio.updateProgress({
            stage: 'Rendering · encoding · hashing · writing',
            completedFrames: progress.writtenFrames, totalFrames: progress.frameCount,
            elapsedSeconds, etaSeconds: throughput > 0 ? remaining / throughput : undefined,
            throughputFps: throughput, encodeFps: encodeFps(progress),
            queueDepth: progress.queueDepth,
            ...(progress.telemetry ? { boundBy: boundByLabel(progress.telemetry, progress.elapsedMs) } : {}),
          });
          if (performance.now() - previewAt > 700 && progress.writtenFrames > 0) {
            previewAt = performance.now();
            void showPreview(outputDirectory!, progress.writtenFrames - 1, studio.previewCanvas);
          }
        },
      });

      try {
        const rendered = await client.start(workerInput);
        studio.setState({ validation: [
          { id: 'frames', label: 'Frame sequence complete', detail: `${rendered.frameCount.toLocaleString()} RGB24 PNGs`, status: 'passed' },
          { id: 'package', label: 'Finalizing authority package', detail: 'WAV, ledgers, hashes and manifest', status: 'working' },
        ] });
        studio.appendLog('All frames written; building WAV and machine-readable sidecars');
        const writer = new TransactionalPackageWriter(new DirectoryPackageSink(outputDirectory));
        for (const artifact of rendered.artifacts) writer.registerExisting(artifact.path, artifact.sha256);
        const boundPlan = bindAnchorHashes(session.plan, writer.hashes);
        await writer.writeStandardSidecars(boundPlan, analysisBuffer);
        const pixelLedgerSha256 = await writer.write(OFFLINE_PACKAGE_NAMES.pixels, serializePixelLedger(rendered.artifacts));
        const bundleSha256 = await currentOfflineWorkerSha256();
        const encoderBundleSha256 = rendered.encoderBundleSha256;
        const manifest = await createOfflineManifest(boundPlan, analysisBuffer, {
          commit: 'browser-build', bundleSha256, userAgent: navigator.userAgent,
          ...(encoderBundleSha256 ? { encoderBundleSha256 } : {}),
        }, writer.hashes, {
          pixelLedger: { path: OFFLINE_PACKAGE_NAMES.pixels, sha256: pixelLedgerSha256, frameCount: rendered.frameCount },
          transitionBlend: rendered.transitionBlend,
          flashLimit: { mode: rendered.flashLimit, limitedFrames: rendered.flashLimitedFrames },
          ...(rendered.pixelSemanticsVersion === OFFLINE_PIXEL_SEMANTICS.version ? { pixelSemantics: OFFLINE_PIXEL_SEMANTICS } : {}),
        });
        if (rendered.flashLimit !== 'off') {
          studio.appendLog(`Flash limiting (${rendered.flashLimit}) changed ${rendered.flashLimitedFrames.toLocaleString()} of ${rendered.frameCount.toLocaleString()} frames`);
        }
        if (rendered.telemetry) studio.appendLog(telemetrySummary(rendered.telemetry, rendered.elapsedMs));
        const presetAuthoritySha256 = draft.mode === 'preset'
          ? prepared.bank.find((entry) => entry.presetId === boundPlan.schedule.entries[0]!.presetId)!.presetSha256
          : await sha256Hex(JSON.stringify(boundPlan.schedule));
        await writer.finalize(Object.freeze({
          ...manifest,
          preset_authority: Object.freeze({ ...manifest.preset_authority, sha256: presetAuthoritySha256 }),
        }));
        const manifestFile = await outputDirectory.getFileHandle(OFFLINE_PACKAGE_NAMES.manifest).then((handle) => handle.getFile());
        const manifestSha256 = await sha256Hex(manifestFile);
        const elapsedSeconds = (performance.now() - startedAt) / 1_000;
        studio.updateProgress({
          stage: 'Validated package complete', completedFrames: rendered.frameCount,
          totalFrames: rendered.frameCount, elapsedSeconds,
          throughputFps: rendered.frameCount / Math.max(.001, elapsedSeconds), queueDepth: 0,
        });
        studio.setState({
          status: 'completed', canResume: false,
          validation: [
            { id: 'frames', label: 'Frame sequence complete', detail: `${rendered.frameCount.toLocaleString()} RGB24 PNGs`, status: 'passed' },
            { id: 'clock', label: 'Sample clock verified', detail: `${session.plan.totalSamplesPerChannel.toLocaleString()} source samples`, status: 'passed' },
            { id: 'hashes', label: 'Package hashes committed', detail: 'sha256sums.txt + final manifest', status: 'passed' },
          ],
          result: {
            outputPath: outputDirectory.name, frameCount: rendered.frameCount,
            durationSeconds: session.plan.durationSeconds, manifestSha256,
          },
        });
        studio.appendLog(`Package committed · manifest ${manifestSha256.slice(0, 16)}…`, 'success');
        await showPreview(outputDirectory, rendered.frameCount - 1, studio.previewCanvas);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          studio.setState({ status: 'cancelled', canResume: false, error: null });
          return;
        }
        throw error;
      } finally {
        client?.dispose();
        client = null;
      }
    },
    onPause() { client?.pause(); },
    onResume() { client?.resume(); },
    onCancel() { client?.cancel(); },
    async onChooseOutputDirectory() {
      if (!('showDirectoryPicker' in window)) {
        throw new Error('Directory export needs Chrome or Edge with the File System Access API.');
      }
      return (window as Window & { showDirectoryPicker(): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
    },
    async onSeekPreview(frame) {
      if (outputDirectory) await showPreview(outputDirectory, frame, studio.previewCanvas);
    },
  });

  const refreshPresetCatalogs = async (): Promise<void> => {
    const snapshots = await AVS_PRESET_SOURCES.snapshots();
    if (disposed) return;
    for (const snapshot of snapshots) {
      if (snapshot.error) studio.appendLog(`${snapshot.label} unavailable: ${snapshot.error}`, 'warning');
    }
    studio.setPresets(snapshots.flatMap((snapshot) => snapshot.entries.map((preset) => ({
      id: preset.id,
      name: preset.name,
      collection: snapshot.label,
      kind: preset.sourceId,
      available: preset.autoEligible !== false,
      unavailableReason: preset.unavailableReason,
    }))));
    const total = snapshots.reduce((sum, snapshot) => sum + snapshot.entries.length, 0);
    studio.appendLog(`${total.toLocaleString()} AVS presets indexed from shared live/offline sources`, 'success');
  };
  const unsubscribe = AVS_PRESET_SOURCES.subscribe((sourceId) => {
    if (sourceId === undefined || sourceId === 'local' || sourceId === 'personal') void refreshPresetCatalogs();
  });
  void refreshPresetCatalogs();

  return {
    studio,
    dispose() { disposed = true; unsubscribe(); client?.dispose(); studio.dispose(); },
  };
}

function isDirectoryHandle(value: unknown): value is FileSystemDirectoryHandle {
  return typeof value === 'object' && value !== null
    && 'kind' in value && value.kind === 'directory'
    && 'getDirectoryHandle' in value && typeof value.getDirectoryHandle === 'function'
    && 'getFileHandle' in value && typeof value.getFileHandle === 'function';
}

async function preparePresets(
  session: OfflineRenderSession,
  draft: OfflineStudioDraft,
  sourceEntries: readonly AvsPresetEntry[],
): Promise<{
  bank: OfflineRenderClientStart['presetBank'];
  cues: OfflineRenderClientStart['presetCues'];
}> {
  const customId = draft.customPresetFile ? `custom:${draft.customPresetFile.name}` : '';
  const ids = [...new Set(session.plan.schedule.entries.map((entry) => entry.presetId))];
  const bank = [] as Array<OfflineRenderClientStart['presetBank'][number]>;
  for (const id of ids) {
    let bytes: Uint8Array;
    if (draft.customPresetFile && id === customId) bytes = new Uint8Array(await draft.customPresetFile.arrayBuffer());
    else {
      const preset = sourceEntries.find((candidate) => candidate.ledgerId === id);
      if (!preset) throw new Error(`Offline schedule references unknown AVS preset ${id}`);
      bytes = await preset.load();
    }
    bank.push({ presetId: id, presetSha256: await sha256Hex(bytes), bytes });
  }
  const fps = session.plan.profile.fpsNumerator / session.plan.profile.fpsDenominator;
  const cues = session.plan.schedule.entries.map((entry, index) => ({
    frame: index === 0 ? 0 : entry.frameStart,
    presetId: entry.presetId, seed: entry.seed,
    transitionFrames: Math.round(entry.transitionSamples / 48_000 * fps),
  }));
  return { bank, cues };
}

function selectedPresetId(draft: OfflineStudioDraft, preset?: AvsPresetEntry): string {
  if (draft.customPresetFile) return `custom:${draft.customPresetFile.name}`;
  if (!preset) throw new Error('Choose an AVS preset for fixed mode.');
  return preset.ledgerId;
}

function selectedSourceId(draft: OfflineStudioDraft): AvsPresetSourceId {
  return draft.presetKind === 'local' || draft.presetKind === 'personal' ? draft.presetKind : 'bundled';
}

function planarCopy(buffer: StereoAnalysisBuffer): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(buffer.totalSamplesPerChannel);
  const right = new Float32Array(buffer.totalSamplesPerChannel);
  buffer.readPlanar(0, buffer.totalSamplesPerChannel, left, right);
  return { left, right };
}

function overviewWaveform(buffer: StereoAnalysisBuffer, points = 2_048): Float32Array {
  const output = new Float32Array(Math.min(points, Math.max(1, buffer.totalSamplesPerChannel)));
  const span = buffer.totalSamplesPerChannel / output.length;
  for (let i = 0; i < output.length; i++) {
    const start = Math.floor(i * span);
    const end = Math.max(start + 1, Math.floor((i + 1) * span));
    let peak = 0;
    for (let sample = start; sample < end; sample++) {
      peak = Math.max(peak, Math.abs(buffer.sample(0, sample)), Math.abs(buffer.sample(1, sample)));
    }
    output[i] = peak;
  }
  return output;
}

async function showPreview(
  directory: FileSystemDirectoryHandle,
  frame: number,
  canvas: HTMLCanvasElement,
): Promise<void> {
  try {
    const frames = await directory.getDirectoryHandle('frames');
    const handle = await frames.getFileHandle(`frame_${String(frame).padStart(6, '0')}.png`);
    const bitmap = await createImageBitmap(await handle.getFile());
    const context = canvas.getContext('2d', { alpha: false });
    context?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
  } catch { /* Frame may not have reached disk yet; the next progress pulse retries. */ }
}

async function currentOfflineWorkerSha256(): Promise<string> {
  return bundleSha256Of('./offline-render.worker.js');
}

async function bundleSha256Of(path: string): Promise<string> {
  const response = await fetch(new URL(path, import.meta.url));
  if (!response.ok) throw new Error(`Could not hash offline renderer bundle ${path}: HTTP ${response.status}`);
  return sha256Hex(await response.blob());
}

/** Aggregate encoder throughput: frames per second of encoder-busy wall time, overlap counted once. */
function encodeFps(progress: OfflineRenderProgressMessage): number | undefined {
  const busyMs = progress.telemetry?.encodeBusyMs ?? progress.encodeWriteMs;
  return busyMs > 0 ? progress.writtenFrames / (busyMs / 1_000) : undefined;
}

function boundByLabel(telemetry: OfflineRenderTelemetry, elapsedMs: number): string {
  const stall = elapsedMs > 0 ? Math.round(telemetry.loopStallMs / elapsedMs * 100) : 0;
  return `${offlineBoundBy(telemetry, elapsedMs)} · ${stall}% stall`;
}

function telemetrySummary(telemetry: OfflineRenderTelemetry, elapsedMs: number): string {
  const seconds = (value: number) => `${(value / 1_000).toFixed(1)} s`;
  const workers = telemetry.encoderWorkers > 0
    ? `${telemetry.encoderWorkers} encoder worker${telemetry.encoderWorkers === 1 ? '' : 's'}`
    : 'in-thread encoding';
  return `Bound by ${offlineBoundBy(telemetry, elapsedMs)} · render ${seconds(telemetry.renderCpuMs)}`
    + ` · pack/blend ${seconds(telemetry.packBlendMs)} · loop stall ${seconds(telemetry.loopStallMs)}`
    + ` · encoder busy ${seconds(telemetry.encodeBusyMs)} · ${workers}`;
}

function profilePurpose(kind: string): string {
  switch (kind) {
    case 'authority': return 'Authoritative RGB24 PNG + WAV package';
    case 'performance': return 'Frame-complete performance qualification';
    case 'delivery': return 'Delivery-resolution RGB24 frame package';
    case 'diagnostic': return 'Diagnostic RGB24 frame package';
    case 'review': return 'Review-resolution source frame package';
    case 'archive': return 'Lossless source frame package';
    default: return 'Deterministic RGB24 frame package';
  }
}

class DirectoryPackageSink implements PackageSink {
  constructor(private readonly root: FileSystemDirectoryHandle) {}

  async write(path: string, data: Uint8Array): Promise<void> {
    const parts = path.split('/');
    const name = parts.pop();
    if (!name) throw new Error(`Invalid output path ${path}`);
    let directory = this.root;
    for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
    try {
      await directory.getFileHandle(name);
      throw new Error(`Refusing to overwrite package file ${path}`);
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error;
    }
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(data.buffer instanceof ArrayBuffer ? data as Uint8Array<ArrayBuffer> : data.slice());
      await writable.close();
    } catch (error) {
      try { await writable.abort(); } catch { /* retain original error */ }
      throw error;
    }
  }

  async commit(): Promise<void> { /* manifest is the final completion marker */ }
  async abort(): Promise<void> { /* partial packages intentionally retain no manifest */ }
}
