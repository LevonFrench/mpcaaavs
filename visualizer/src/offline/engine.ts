import type { AvsStereoPcm } from '../avs/audio.ts';
import type { AudioSnapshot, TimelineEvent } from '../contracts.ts';
import { StaticTimeline } from '../timeline.ts';
import { analyzeOfflineTrack } from './analyzer.ts';
import { StereoAnalysisBuffer } from './audio-buffer.ts';
import type {
  OfflineFrameFeatures, OfflineRenderMode, OfflineRenderPlan, OfflineTempoAuthority,
  PresetScheduleEntry,
} from './model.ts';
import { outputProfile } from './profiles.ts';
import { resolvePresetSchedule, scheduleEntryAtSample } from './schedule.ts';
import { OFFLINE_SAMPLE_RATE, RationalTimebase } from './timebase.ts';

export interface PrepareOfflineRenderOptions {
  readonly profileId: string;
  readonly mode: OfflineRenderMode;
  readonly presetId?: string;
  readonly availablePresetIds?: readonly string[];
  readonly seed: number;
  readonly bpm?: number;
  readonly meter?: string;
  readonly downbeatSample?: number;
}

export interface OfflineFrameInput {
  readonly frameIndex: number;
  readonly features: OfflineFrameFeatures;
  readonly preset: PresetScheduleEntry;
  readonly pcm: AvsStereoPcm;
  readonly audioSnapshot: AudioSnapshot;
}

/**
 * Frozen analysis and schedule for one export. The browser pixel pipeline that
 * consumes this plan lives in offline-render.worker.ts: one render thread runs
 * the AVS runtimes and packs Sub-filtered RGB scanlines, then 1-3 encoder
 * workers (offline-encode.worker.ts, in-thread fallback) DEFLATE and write
 * each PNG. Every frame is hashed twice: the PNG bytes (sha256sums, anchors)
 * and the unfiltered RGB24 raster (pixels.rgb24.sha256.jsonl), so pixel
 * authority does not depend on the encoder.
 */
export class OfflineRenderSession {
  readonly buffer: StereoAnalysisBuffer;
  readonly plan: OfflineRenderPlan;
  readonly timeline: StaticTimeline;
  readonly #pcmLeft = new Float32Array(576);
  readonly #pcmRight = new Float32Array(576);
  readonly #waveform = new Float32Array(576 * 2);
  readonly #spectrum = new Float32Array(256 * 2);
  readonly #bandPan = new Float32Array(256);
  readonly #spectrogram = new Float32Array(256);
  readonly #peaks = new Float32Array(256);
  readonly #perceptualBands = new Float32Array(12);
  readonly #perceptualFlux = new Float32Array(12);

  constructor(buffer: StereoAnalysisBuffer, plan: OfflineRenderPlan) {
    this.buffer = buffer;
    this.plan = plan;
    const events: TimelineEvent[] = plan.analysis.events
      .filter((event): event is typeof event & { kind: 'kick' | 'snare' | 'hat' | 'onset' } =>
        event.kind === 'kick' || event.kind === 'snare' || event.kind === 'hat' || event.kind === 'onset')
      .map((event) => ({
        time: event.sample / OFFLINE_SAMPLE_RATE,
        slot: (event.sample - plan.analysis.tempo.downbeatSample) / (OFFLINE_SAMPLE_RATE * 60 / plan.analysis.tempo.bpm) * 240,
        kind: 'onset', onsetClass: event.kind === 'onset' ? 'tonal' : event.kind,
        strength: event.strength, confidence: event.confidence,
      }));
    this.timeline = StaticTimeline.fromTempo(
      plan.analysis.tempo.bpm,
      plan.analysis.tempo.downbeatSample / OFFLINE_SAMPLE_RATE,
      buffer.durationSeconds,
      { events },
    );
  }

  /** Reuses backing arrays. Consumers must render/copy before asking for the next frame. */
  frameAt(frameIndex: number): OfflineFrameInput {
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0 || frameIndex >= this.plan.frameCount) {
      throw new RangeError(`frame ${frameIndex} outside [0, ${this.plan.frameCount})`);
    }
    const features = this.plan.analysis.frames[frameIndex]!;
    const centre = features.sample_start;
    this.buffer.readPlanar(centre, 576, this.#pcmLeft, this.#pcmRight);
    for (let i = 0; i < 576; i++) {
      this.#waveform[i * 2] = this.#pcmLeft[i]!;
      this.#waveform[i * 2 + 1] = this.#pcmRight[i]!;
    }
    // AVS builds its exact host-compatible FFT from `pcm`. The native snapshot
    // exposes deterministic frame features; frequency-bin arrays stay zero in
    // this Tier-A baseline until the shared native analyzer gets an offline API.
    this.#spectrum.fill(0); this.#bandPan.fill(0); this.#spectrogram.fill(0); this.#peaks.fill(0);
    const total = features.energy.low + features.energy.mid + features.energy.high || 1;
    const snapshot: AudioSnapshot = {
      time: features.time_seconds, level: features.rms.master, beat: features.onset_strength,
      bands: {
        sub: features.energy.low / total, low: features.energy.low / total,
        mid: features.energy.mid / total, high: features.energy.high / total,
        air: features.energy.high / total,
      },
      pan: features.rms.left + features.rms.right > 0
        ? (features.rms.right - features.rms.left) / (features.rms.right + features.rms.left) : 0,
      width: 0, crest: features.rms.master > 1e-9 ? features.peak.master / features.rms.master : 0,
      centroid: features.spectral_centroid, flatness: 0,
      perceptualBands: this.#perceptualBands, perceptualFlux: this.#perceptualFlux,
      waveform: this.#waveform, spectrum: this.#spectrum, bandPan: this.#bandPan,
      spectrogram: this.#spectrogram, spectrogramRow: 0, peaks: this.#peaks,
    };
    return Object.freeze({
      frameIndex, features,
      preset: scheduleEntryAtSample(this.plan.schedule, features.sample_start),
      pcm: Object.freeze({ left: this.#pcmLeft, right: this.#pcmRight }),
      audioSnapshot: snapshot,
    });
  }
}

export function prepareOfflineRender(buffer: StereoAnalysisBuffer, options: PrepareOfflineRenderOptions): OfflineRenderSession {
  const profile = outputProfile(options.profileId);
  const timebase = new RationalTimebase(OFFLINE_SAMPLE_RATE, profile.fpsNumerator, profile.fpsDenominator);
  const { numerator, denominator } = parseMeter(options.meter ?? '4/4');
  const tempo: OfflineTempoAuthority = Object.freeze({
    bpm: options.bpm ?? 120, meterNumerator: numerator, meterDenominator: denominator,
    downbeatSample: options.downbeatSample ?? 0,
    authority: options.bpm === undefined ? 'assumed_unreviewed' : 'provided',
  });
  // Tempo estimation is a declared boundary for v1: when BPM is absent this
  // baseline uses 120 but explicitly marks it unreviewed. The GUI must surface
  // and review it before treating the package as MiniMax authority.
  const schedule = resolvePresetSchedule({
    mode: options.mode, presetId: options.presetId, availablePresetIds: options.availablePresetIds,
    seed: options.seed, totalSamples: buffer.totalSamplesPerChannel,
    bpm: tempo.bpm, beatsPerBar: tempo.meterNumerator, downbeatSample: tempo.downbeatSample,
  }, timebase);
  const analysis = analyzeOfflineTrack(buffer, { tempo, schedule, timebase });
  const plan: OfflineRenderPlan = Object.freeze({
    schema: 'aaavs_offline_render_plan_v1', profile,
    totalSamplesPerChannel: buffer.totalSamplesPerChannel,
    durationSeconds: buffer.durationSeconds, frameCount: timebase.frameCount(buffer.totalSamplesPerChannel),
    schedule, analysis,
  });
  return new OfflineRenderSession(buffer, plan);
}

function parseMeter(value: string): { numerator: number; denominator: number } {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) throw new Error(`invalid meter ${value}; expected numerator/denominator`);
  const numerator = Number(match[1]), denominator = Number(match[2]);
  if (numerator <= 0 || denominator <= 0) throw new Error(`invalid meter ${value}`);
  return { numerator, denominator };
}
