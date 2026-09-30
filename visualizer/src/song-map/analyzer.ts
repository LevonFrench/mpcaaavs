// Song-map analyzer: region-scheduled streaming scan plus global refinement over compact features.
import { deriveFeatures, FEATURE_NAMES, HpssCache } from './features.ts';
import { CHROMA_BINS, FeatureStore, FPS, LOW_RATE, MEL_BANDS, MEL_FMAX, MEL_FMIN, REGION_CONTEXT_SECONDS, RegionScanner } from './frames.ts';
import { analyzeRhythm } from './rhythm.ts';
import { analyzeSections } from './sections.ts';
import { SONG_MAP_VERSION, type SongMapBinary, type SongMapFeature, type SongMapJSON } from './types.ts';

export const SONG_MAP_ANALYZER = 'aaavs-song-map-cpu-1';
/** Region core length. A scheduling and memory boundary, never a musical one. */
export const REGION_CORE_SECONDS = 300;
export const DEFAULT_MAX_WAVE_SECONDS = 600;

export interface SongMapAnalyzerOptions {
  readonly sampleRate: number;
  /** Track length in samples, or null for a live stream whose length is unknown. */
  readonly totalSamples: number | null;
  readonly maxWaveSeconds?: number;
}

export interface RegionPlan {
  readonly index: number;
  readonly coreStart: number;
  readonly coreEnd: number;
  readonly feedStart: number;
  readonly feedEnd: number;
}

/**
 * Five-minute cores with REGION_CONTEXT_SECONDS of context each side. Files up to one core are one region.
 * `firstCoreSeconds` shortens only the first core so the first useful result arrives early.
 */
export function planRegions(totalSamples: number, sampleRate: number, coreSeconds = REGION_CORE_SECONDS, firstCoreSeconds = coreSeconds): RegionPlan[] {
  const core = Math.max(1, Math.round(coreSeconds * sampleRate)), first = Math.max(1, Math.round(firstCoreSeconds * sampleRate));
  const context = Math.round(REGION_CONTEXT_SECONDS * sampleRate);
  const plans: RegionPlan[] = [];
  for (let start = 0, index = 0; start < totalSamples; index++) {
    const end = Math.min(totalSamples, start + (index === 0 ? first : core));
    plans.push({ index, coreStart: start, coreEnd: end, feedStart: Math.max(0, start - context), feedEnd: Math.min(totalSamples, end + context) });
    start = end;
  }
  return plans;
}

/** The region under the playhead first, then the following regions, then the earlier ones. */
export function orderRegions(plans: readonly RegionPlan[], playheadSample: number, done: ReadonlySet<number> = new Set()): RegionPlan[] {
  const open = plans.filter(p => !done.has(p.index));
  const current = open.findIndex(p => playheadSample >= p.coreStart && playheadSample < p.coreEnd);
  if (current < 0) return open;
  const pivot = open[current]!.index;
  return [...open.filter(p => p.index >= pivot), ...open.filter(p => p.index < pivot)];
}

export interface SongMapSnapshot {
  readonly map: SongMapJSON;
  readonly binary: SongMapBinary;
  /** Analysed spans in seconds. Decoded coverage, not a promise that labels there are right. */
  readonly coverage: [number, number][];
  readonly complete: boolean;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

export class SongMapAnalyzer {
  readonly store: FeatureStore;
  private readonly hpss = new HpssCache();
  private scanner: RegionScanner | null = null;

  constructor(options: SongMapAnalyzerOptions) {
    this.store = new FeatureStore(options.sampleRate, options.totalSamples, options.maxWaveSeconds ?? DEFAULT_MAX_WAVE_SECONDS);
  }

  get sampleRate(): number { return this.store.sampleRate; }

  /** Starts a contiguous PCM run at feedStart whose items in [coreStart, coreEnd) are stored. */
  beginRegion(feedStart: number, coreStart: number, coreEnd: number): void {
    if (this.scanner) throw new Error('Previous region not finished');
    this.scanner = new RegionScanner(this.store, feedStart, coreStart, coreEnd);
  }
  push(left: Float32Array, right: Float32Array): void {
    if (!this.scanner) throw new Error('No region in progress');
    this.scanner.push(left, right);
  }
  endRegion(atTrackEnd: boolean): void {
    if (!this.scanner) return;
    this.scanner.finish(atTrackEnd); this.scanner = null;
  }
  get regionPosition(): number | null { return this.scanner?.position ?? null; }

  /** Convenience for tests and offline callers: analyse one planned region from a random-access source. */
  scanRegion(plan: RegionPlan, read: (start: number, length: number) => { left: Float32Array; right: Float32Array }, block = 16384): void {
    this.beginRegion(plan.feedStart, plan.coreStart, plan.coreEnd);
    for (let s = plan.feedStart; s < plan.feedEnd; s += block) {
      const { left, right } = read(s, Math.min(block, plan.feedEnd - s));
      this.push(left, right);
    }
    this.endRegion(this.store.totalSamples !== null && plan.feedEnd >= this.store.totalSamples);
  }

  bytes(): number { return this.store.bytes() + this.hpss.bytes(); }

  /** Global refinement over everything analysed so far. */
  build(): SongMapSnapshot {
    const store = this.store, derived = deriveFeatures(store, this.hpss);
    const duration = store.totalSamples !== null ? store.totalSamples / store.sampleRate : derived.n / FPS;
    const S = MEL_BANDS + CHROMA_BINS;
    const rhythm = analyzeRhythm({
      fps: FPS, duration, islands: derived.islands, om: derived.om, od: derived.od,
      kicks: derived.onsets.kick, snares: derived.onsets.snare, features: derived.features,
      spec: derived.spec, specStride: S, chromaOffset: MEL_BANDS,
    });
    const sections = analyzeSections({
      fps: FPS, duration, islands: derived.islands, downbeats: rhythm.downbeats, ...(rhythm.bar0 !== undefined ? { bar0: rhythm.bar0 } : {}),
      features: derived.features, kicks: derived.onsets.kick, snares: derived.onsets.snare, hats: derived.onsets.hat,
      spec: derived.spec, specStride: S, chromaOffset: MEL_BANDS, downbeatConfidence: rhythm.confidence.downbeat, bassMidi: derived.bassMidi, trackFrames: store.frameCount,
    });
    const features = {} as Record<SongMapFeature, number[]>;
    for (const name of FEATURE_NAMES) features[name] = Array.from(derived.features[name], round3);
    const coverage: [number, number][] = derived.islands.map(([a, b]) => [round3(a / FPS), round3(Math.min(duration, b / FPS))]);
    const complete = derived.islands.length === 1 && derived.islands[0]![0] === 0 && derived.islands[0]![1] === derived.n && store.frameCount !== null;
    // The waveform ships only when every sample of it has been analysed.
    const waveFrames = store.maxWaveFrames;
    let waveReady = complete && waveFrames > 0 && store.totalSamples !== null && waveFrames >= Math.ceil(store.totalSamples * LOW_RATE / store.sampleRate) - 1;
    let wave = new Float32Array(0);
    if (waveReady) {
      wave = store.wave.slice(0, waveFrames * 2);
      let peak = 0; for (let i = 0; i < wave.length; i++) peak = Math.max(peak, Math.abs(wave[i]!));
      if (peak > 0) for (let i = 0; i < wave.length; i++) wave[i] = Math.max(-1, Math.min(1, wave[i]! / peak));
      else waveReady = false;
    }
    const approximations = ['vocal', 'drums', 'bass', 'other', 'bass_midi', 'chroma', 'onsets.kick', 'onsets.snare', 'onsets.hat', 'onsets.vocal'];
    if (derived.melBandLimited) approximations.push('spectrum.mel-bandlimited');
    if (derived.hatBandLimited) approximations.push('onsets.hat-bandlimited');
    if (!complete) approximations.push('partial');
    const map: SongMapJSON = {
      version: SONG_MAP_VERSION,
      duration: round3(duration),
      bpm: rhythm.bpm,
      fps: FPS,
      beats: rhythm.beats,
      downbeats: rhythm.downbeats,
      ...(rhythm.bar0 !== undefined ? { bar0: rhythm.bar0 } : {}),
      sections: sections.sections,
      features,
      onsets: derived.onsets,
      bass_midi: Array.from(derived.bassMidi, x => Math.round(x * 100) / 100),
      spectrum: { frames: derived.n, mel: MEL_BANDS, chroma: CHROMA_BINS, fmin: MEL_FMIN, fmax: MEL_FMAX },
      ...(waveReady ? { wave: { rate: LOW_RATE, channels: 2, frames: waveFrames } } : {}),
      confidence: { tempo: rhythm.confidence.tempo, downbeat: rhythm.confidence.downbeat, sections: sections.confidence },
      approximations,
    };
    return { map, binary: { spec: derived.spec, wave }, coverage, complete };
  }
}
