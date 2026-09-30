/** Setup Builder timing tools (docs/design/TIMING-SYSTEM-V2.md 5.7, CONTRACT 2.3.2).
 * Pure, one-shot edits to a draft `SceneTiming`: tap tempo, offset nudge, "downbeat here", "restart sequence here" and "use detected tempo".
 * The saved clock never follows the live detector or wall time, so every function here is a plain function of numbers: media seconds in,
 * a new number (or timing) out. Nothing reads a clock, the DOM or randomness. Results are rounded to a microsecond so stored files stay tidy;
 * a repeated tool call is idempotent (a position already on a bar line changes nothing).
 */
import { compileGrid, type BeatGrid } from './mpc-beat-grid.ts';
import type { SceneTiming } from './mpc-scene-clock.ts';

/** Largest |offsetSeconds| a setup accepts. */
export const OFFSET_LIMIT = 3600;
/** A gap over this many seconds starts a new tap set. */
export const TAP_GAP_SECONDS = 2;
/** Taps kept (the oldest is forgotten), taps required for an estimate, and how far an interval may stray from the median. */
export const TAP_MAX = 12, TAP_MIN = 4, TAP_TOLERANCE = 0.25;
/** A tap interval may span this many beats when the player missed some. */
const TAP_MAX_BEATS_PER_TAP = 4;
/** Five microseconds of slack: more than a microsecond-rounded offset can lose, so a second "downbeat here" changes nothing. */
const SNAP_SECONDS = 5e-6;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const micro = (value: number): number => Math.round(value * 1e6) / 1e6 + 0;
const clampOffset = (value: number): number => Math.min(OFFSET_LIMIT, Math.max(-OFFSET_LIMIT, value));

/** Tap tempo over media time. `tap` takes the media position of one tap (the page maps a click to `position + min(0.25, sinceLastAudio)` while
 * playing) and returns the current estimate in BPM, or null while there is none.
 *
 * A gap over two seconds, a timestamp that does not advance (a seek, or taps while paused) and a non-finite timestamp start over or are ignored.
 * At most twelve taps are kept and at least four are needed. A tap whose interval from the previous accepted tap is more than 25 percent off the
 * median interval is rejected (a stray extra tap); an interval of two to five median beats counts as missed beats. The tempo is the least-squares
 * slope of tap time over beat index, rounded to 0.01 and accepted only from 20 to 400 BPM. */
export class TapTempo {
  private taps: number[] = [];
  /** Taps in the current set (at most twelve). */
  get count(): number { return this.taps.length; }
  reset(): void { this.taps.length = 0; }
  tap(mediaSeconds: number): number | null {
    if (!finite(mediaSeconds)) return this.estimate();
    const last = this.taps[this.taps.length - 1];
    if (last !== undefined && (mediaSeconds <= last || mediaSeconds - last > TAP_GAP_SECONDS)) this.taps.length = 0;
    this.taps.push(mediaSeconds);
    if (this.taps.length > TAP_MAX) this.taps.shift();
    return this.estimate();
  }
  private estimate(): number | null {
    const t = this.taps, n = t.length;
    if (n < TAP_MIN) return null;
    const gaps: number[] = [];
    for (let i = 1; i < n; i++) gaps.push(t[i]! - t[i - 1]!);
    const sorted = gaps.slice().sort((a, b) => a - b), mid = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    if (!(median > 0)) return null;
    // A stray first tap must not poison every later one, so the accepted run may start at any of the first three taps; the longest run wins.
    let best: { index: number; time: number }[] = [];
    for (let start = 0; start < Math.min(3, n); start++) {
      const run = [{ index: 0, time: t[start]! }];
      for (let i = start + 1; i < n; i++) {
        const previous = run[run.length - 1]!, dt = t[i]! - previous.time, k = Math.max(1, Math.round(dt / median));
        if (k > TAP_MAX_BEATS_PER_TAP || Math.abs(dt - k * median) > TAP_TOLERANCE * median) continue;
        run.push({ index: previous.index + k, time: t[i]! });
      }
      if (run.length > best.length) best = run;
    }
    if (best.length < TAP_MIN) return null;
    const origin = best[0]!.time, m = best.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const p of best) { const y = p.time - origin; sx += p.index; sy += y; sxx += p.index * p.index; sxy += p.index * y; }
    const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx);
    if (!(slope > 0)) return null;
    const bpm = Math.round(6000 / slope) / 100;
    return bpm >= 20 && bpm <= 400 ? bpm : null;
  }
}

/** `offset + deltaSeconds`, rounded to a microsecond and clamped to +-3600. A non-finite offset reads as 0; a non-finite delta changes nothing. */
export function nudgeOffset(offset: number, deltaSeconds: number): number {
  const base = finite(offset) ? offset : 0;
  return clampOffset(micro(finite(deltaSeconds) ? base + deltaSeconds : base));
}

/** The new `offsetSeconds` that puts a bar line at `position`: the offset moves forward by the distance from the previous bar line, less than one
 * bar, in beats through the tempo map and the timing's `beatsPerBar`. A position already on a bar line (within five microseconds) returns the
 * offset unchanged, so the tool is idempotent. Before the offset the base tempo extends backwards. Scene lengths stay relative to the offset. The
 * result may pass the first tempo change; `rebaseTiming` keeps the tempo timeline when the draft adopts it. */
export function downbeatHere(timing: SceneTiming, position: number): number {
  const offset = finite(timing.offsetSeconds) ? timing.offsetSeconds : 0;
  if (!finite(position) || !finite(timing.bpm) || !(timing.bpm > 0)) return offset;
  const perBar = Number.isInteger(timing.beatsPerBar) && timing.beatsPerBar! >= 1 && timing.beatsPerBar! <= 16 ? timing.beatsPerBar! : 4;
  let grid: BeatGrid;
  try { grid = compileGrid(timing.bpm, offset, timing.tempoMap ?? []); } catch { return offset; }
  const beats = position > offset ? grid.beatAt(position) : -(offset - position) * timing.bpm / 60;
  const into = ((beats % perBar) + perBar) % perBar, second = 60 / timing.bpm;
  if (into * second < SNAP_SECONDS || (perBar - into) * second < SNAP_SECONDS) return offset;
  return clampOffset(micro(grid.timeAt(into)));
}

/** "Restart sequence here": the first scene starts at `position`. Rounded to a microsecond and clamped to +-3600; non-finite reads as 0. */
export function restartHere(position: number): number {
  return clampOffset(micro(finite(position) ? position : 0));
}

/** "Use detected tempo". Null unless the live tracker is locked on a tempo that rounds to 20 to 400 BPM with a beat phase in 0..1 and `position` is finite.
 * `bpm` is the detected tempo rounded to 0.01. `offsetSeconds` is the beat of that grid nearest to `currentOffset` (default 0, the start of the
 * song): the most recent detected beat is `position - phase * 60 / detected bpm`, and the offset steps from it by whole beats of the rounded
 * tempo, so the saved grid passes through that beat and drifts only as far as 0.01 BPM allows. The tracker has no downbeat, so bar 1 lands on
 * that beat; Downbeat here or a one-beat nudge realigns it. `beatsPerBar` is reserved for a tracker that reports one and has no effect today.
 * One shot: the saved clock never follows the detector afterwards. */
export function captureTempo(tempo: { locked: boolean; bpm: number; phase: number }, position: number, beatsPerBar = 4, currentOffset = 0): { bpm: number; offsetSeconds: number } | null {
  void beatsPerBar;
  if (!tempo || tempo.locked !== true || !finite(tempo.bpm) || !(tempo.bpm > 0) || !finite(tempo.phase) || tempo.phase < 0 || tempo.phase > 1 || !finite(position)) return null;
  const bpm = Math.round(tempo.bpm * 100) / 100;
  if (bpm < 20 || bpm > 400) return null;
  const last = position - tempo.phase * 60 / tempo.bpm, period = 60 / bpm, near = finite(currentOffset) ? currentOffset : 0;
  return { bpm, offsetSeconds: clampOffset(micro(last + Math.round((near - last) / period) * period)) };
}

/** The five v1 keys, then the keys a v2 timing may carry, in the order the parser writes them. */
const V1_KEYS = ['enabled', 'bpm', 'offsetSeconds', 'barsPerScene', 'seed'] as const;
const V2_KEYS = ['beatsPerBar', 'barsPattern', 'patternHold', 'tempoMap', 'script', 'intervals'] as const;

/** Remove default-valued v2 fields from a draft in place and set `version` to 2 exactly when a v2 field remains (contract 2.2.2: a v1 timing
 * serialises as its five keys). Default values: `beatsPerBar` 4, `patternHold` false, a pattern equal to `[barsPerScene]` (which also makes
 * `patternHold` meaningless), and empty `tempoMap`, `script` and `intervals`. Values that are not valid are left for the parser to report; keys the parser does not know are dropped. */
export function tidyTiming(timing: SceneTiming): SceneTiming {
  const t = timing as unknown as Record<string, unknown>;
  if (t.beatsPerBar === 4) delete t.beatsPerBar;
  const pattern = t.barsPattern;
  if (Array.isArray(pattern) && pattern.length === 1 && pattern[0] === t.barsPerScene) { delete t.barsPattern; delete t.patternHold; }
  if (t.patternHold === false || (t.barsPattern === undefined && t.patternHold !== undefined)) delete t.patternHold;
  for (const key of ['tempoMap', 'script', 'intervals'] as const) if (Array.isArray(t[key]) && (t[key] as unknown[]).length === 0) delete t[key];
  if (V2_KEYS.some(key => t[key] !== undefined)) t.version = 2; else delete t.version;
  // Key order is the parser's, so a tidied draft serialises exactly like a parsed one.
  const kept = new Map<string, unknown>();
  for (const key of [...V1_KEYS, 'version', ...V2_KEYS]) if (key in t) kept.set(key, t[key]);
  for (const key of Object.keys(t)) delete t[key];
  for (const [key, value] of kept) t[key] = value;
  return timing;
}

/** Move the first scene to `offsetSeconds` without changing the tempo timeline: changes at or before the new offset are folded into the base
 * `bpm` (the tempo in force there) and removed from `tempoMap`, so beat counts between any two later times are unchanged. Returns a new timing;
 * the input is untouched. The offset is rounded to a microsecond and clamped to +-3600. */
export function rebaseTiming(timing: SceneTiming, offsetSeconds: number): SceneTiming {
  const offset = clampOffset(micro(finite(offsetSeconds) ? offsetSeconds : 0));
  const result: SceneTiming = { ...timing, offsetSeconds: offset };
  const map = timing.tempoMap;
  if (map?.length) {
    let bpm = timing.bpm;
    const later: { at: number; bpm: number }[] = [];
    for (const change of map) { if (change.at <= offset) bpm = change.bpm; else later.push({ at: change.at, bpm: change.bpm }); }
    result.bpm = bpm;
    if (later.length) result.tempoMap = later; else delete result.tempoMap;
  }
  return tidyTiming(result);
}

/** Replace the contents of `target` with those of `source`, in place (the Setup Builder draft is edited in place). */
export function replaceTiming(target: SceneTiming, source: SceneTiming): void {
  const t = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(t)) delete t[key];
  Object.assign(t, source);
}
