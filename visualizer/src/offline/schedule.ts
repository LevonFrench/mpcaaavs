import type { OfflineRenderMode, PresetScheduleEntry, PresetScheduleLedger } from './model.ts';
import { cumulativeBeatBoundarySample, type RationalTimebase } from './timebase.ts';

export interface PresetScheduleOptions {
  readonly mode: OfflineRenderMode;
  readonly presetId?: string;
  readonly availablePresetIds?: readonly string[];
  readonly seed: number;
  readonly totalSamples: number;
  readonly bpm: number;
  readonly beatsPerBar: number;
  readonly downbeatSample: number;
  readonly barsPerAutoPreset?: number;
  readonly transitionBeats?: number;
}

export function resolvePresetSchedule(options: PresetScheduleOptions, timebase: RationalTimebase): PresetScheduleLedger {
  validate(options);
  const seed = options.seed >>> 0;
  if (options.mode === 'preset') {
    const presetId = options.presetId!;
    return freezeLedger('preset', seed, [{
      index: 0, sampleStart: 0, sampleEnd: options.totalSamples,
      frameStart: 0, frameEnd: timebase.frameCount(options.totalSamples),
      presetId, seed, transitionSamples: 0,
    }]);
  }

  const candidates = [...new Set(options.availablePresetIds!)].sort();
  const beatsPerEntry = options.beatsPerBar * (options.barsPerAutoPreset ?? 4);
  const transitionSamples = Math.max(0, cumulativeBeatBoundarySample(options.transitionBeats ?? 2, options.bpm));
  const entries: PresetScheduleEntry[] = [];
  let beat = 0;
  let previous = -1;
  while (true) {
    const relativeStart = cumulativeBeatBoundarySample(beat, options.bpm);
    const relativeEnd = cumulativeBeatBoundarySample(beat + beatsPerEntry, options.bpm);
    // The first cue must cover frame zero even when the reviewed downbeat is
    // later than sample zero. Subsequent cues remain grid-locked to downbeat.
    const sampleStart = entries.length === 0 ? 0 : Math.max(0, options.downbeatSample + relativeStart);
    if (sampleStart >= options.totalSamples && entries.length > 0) break;
    const sampleEnd = Math.min(options.totalSamples, Math.max(sampleStart, options.downbeatSample + relativeEnd));
    let candidate = deterministicIndex(seed, entries.length, candidates.length);
    if (candidate === previous && candidates.length > 1) candidate = (candidate + 1) % candidates.length;
    entries.push(Object.freeze({
      index: entries.length, sampleStart, sampleEnd,
      frameStart: timebase.frameAtSample(sampleStart, 'nearest'),
      frameEnd: sampleEnd === options.totalSamples ? timebase.frameCount(options.totalSamples) : timebase.frameAtSample(sampleEnd, 'nearest'),
      presetId: candidates[candidate]!, seed: mixSeed(seed, entries.length),
      transitionSamples: entries.length === 0 ? 0 : Math.min(transitionSamples, Math.max(0, sampleEnd - sampleStart)),
    }));
    previous = candidate;
    beat += beatsPerEntry;
    if (sampleEnd >= options.totalSamples) break;
  }
  return freezeLedger('auto', seed, entries);
}

export function scheduleEntryAtSample(ledger: PresetScheduleLedger, sample: number): PresetScheduleEntry {
  let lo = 0;
  let hi = ledger.entries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ledger.entries[mid]!.sampleStart <= sample) lo = mid;
    else hi = mid - 1;
  }
  return ledger.entries[lo]!;
}

function freezeLedger(mode: OfflineRenderMode, sourceSeed: number, entries: PresetScheduleEntry[]): PresetScheduleLedger {
  return Object.freeze({ mode, sourceSeed, entries: Object.freeze(entries.map((entry) => Object.freeze(entry))) });
}
function deterministicIndex(seed: number, index: number, length: number): number {
  return mixSeed(seed, index) % length;
}
function mixSeed(seed: number, index: number): number {
  let x = (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); x ^= x >>> 16;
  return x >>> 0;
}
function validate(options: PresetScheduleOptions): void {
  if (!Number.isSafeInteger(options.totalSamples) || options.totalSamples < 0) throw new RangeError('totalSamples must be non-negative');
  if (!Number.isFinite(options.bpm) || options.bpm <= 0) throw new RangeError('bpm must be positive');
  if (!Number.isInteger(options.beatsPerBar) || options.beatsPerBar <= 0) throw new RangeError('beatsPerBar must be positive');
  if (options.mode === 'preset' && !options.presetId) throw new Error('preset mode requires presetId');
  if (options.mode === 'auto' && (!options.availablePresetIds || options.availablePresetIds.length === 0)) {
    throw new Error('auto mode requires at least one available preset id');
  }
}
