/** Beat grid, scene pattern and per-frame musical signals (docs/design/TIMING-SYSTEM-V2.md 5.3 and 5.5, CONTRACT 2.3.2).
 * Pure: no DOM, no clocks, no randomness. Everything is a function of media time, so pause, seek and replay agree.
 * Beat zero sits at `offset`; a tempo change is a strictly increasing list of (time, bpm) steps after it. Lookups are
 * O(log n) over prefix sums and never scan earlier scenes. Scene boundaries are integer beats, recovered through
 * `floor(beat + BEAT_EPS)`, which absorbs the sub-ulp error of `beatAt(timeAt(n))`.
 */
import type { ClockGrid, IntervalSignals, TimingSignals } from './mpc-timing-types.ts';
export type { ClockGrid, IntervalSignals, TimingSignals } from './mpc-timing-types.ts';

/** Tolerance, in beats, that replaces the v1 clock's 1e-10-second boundary tolerance. */
export const BEAT_EPS = 1e-9;
/** A tempo step: from `at` seconds onward the tempo is `bpm`. */
export interface TempoChange { readonly at: number; readonly bpm: number }
export interface BeatGrid {
  /** Beats since the offset; 0 at or before it. Continuous and strictly increasing afterwards. */
  beatAt(t: number): number;
  /** Inverse of `beatAt` for beats greater than 0; the offset for 0 or less. */
  timeAt(beat: number): number;
  /** Tempo in force at `t` (a change applies from its own time). */
  bpmAt(t: number): number;
  readonly constant: boolean;
}
export interface SceneSpan { readonly ordinal: number; readonly startBeat: number; readonly beats: number }
export interface ScenePattern {
  /** The scene containing the beat position (beats since the offset), tolerant by BEAT_EPS at a boundary. */
  at(beat: number): SceneSpan;
  /** First beat of a scene ordinal (negative ordinals read as 0). */
  startBeat(ordinal: number): number;
  /** Length in beats of a scene ordinal (negative ordinals read as 0). */
  beats(ordinal: number): number;
}
/** Largest supported number of tempo steps (the wire `grid.changes` cap). */
export const MAX_TEMPO_CHANGES = 256;
const BPM_MIN = 20, BPM_MAX = 400;

/** Index of the first element greater than `x` in an ascending array. `probe` is a test hook counting steps. */
function upperBound(values: ArrayLike<number>, x: number, probe?: () => void): number {
  let low = 0, high = values.length;
  while (low < high) { probe?.(); const middle = (low + high) >>> 1; if (values[middle]! <= x) low = middle + 1; else high = middle; }
  return low;
}

/** Compile a beat grid. Throws `Invalid beat grid` for a non-finite offset, a tempo outside 20..400, more than 256 changes,
 * or changes that are not strictly increasing and strictly after the offset. */
export function compileGrid(bpm: number, offset: number, changes: readonly TempoChange[] = [], probe?: () => void): BeatGrid {
  if (!Number.isFinite(offset) || !(bpm >= BPM_MIN && bpm <= BPM_MAX) || !Array.isArray(changes) || changes.length > MAX_TEMPO_CHANGES) throw Error('Invalid beat grid');
  const count = changes.length + 1;
  const T = new Float64Array(count), B = new Float64Array(count), R = new Float64Array(count);
  T[0] = offset; B[0] = 0; R[0] = bpm;
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    if (!c || !Number.isFinite(c.at) || !(c.at > T[i]!) || !(c.bpm >= BPM_MIN && c.bpm <= BPM_MAX)) throw Error('Invalid beat grid');
    B[i + 1] = B[i]! + (c.at - T[i]!) * R[i]! / 60; T[i + 1] = c.at; R[i + 1] = c.bpm;
  }
  return {
    constant: count === 1,
    beatAt(t) {
      if (!(t > offset)) return 0;
      const i = upperBound(T, t, probe) - 1;
      return B[i]! + (t - T[i]!) * R[i]! / 60;
    },
    timeAt(beat) {
      if (!(beat > 0)) return offset;
      const j = Math.max(0, upperBound(B, beat, probe) - 1);
      return T[j]! + (beat - B[j]!) * 60 / R[j]!;
    },
    bpmAt(t) { return t > offset ? R[Math.max(0, upperBound(T, t, probe) - 1)]! : R[0]!; },
  };
}

/** Compile a scene-length pattern (bars per scene, in order). Cyclic unless `hold`, which repeats the last entry forever.
 * Throws `Invalid scene pattern` for an empty list, a non-integer or non-positive bar count, or beatsPerBar outside 1..16. */
export function compilePattern(bars: readonly number[], beatsPerBar: number, hold: boolean, probe?: () => void): ScenePattern {
  if (!Array.isArray(bars) || !bars.length || !Number.isInteger(beatsPerBar) || beatsPerBar < 1 || beatsPerBar > 16
    || bars.some(b => !Number.isInteger(b) || b < 1 || b > 1e6)) throw Error('Invalid scene pattern');
  const m = bars.length, S = new Float64Array(m), P = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) { S[i] = bars[i]! * beatsPerBar; P[i + 1] = P[i]! + S[i]!; }
  const total = P[m]!, last = P[m - 1]!, lastLength = S[m - 1]!;
  const ordinalOf = (n: number) => Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  return {
    at(beat) {
      const x = (Number.isFinite(beat) ? Math.max(0, beat) : beat > 0 ? Infinity : 0) + BEAT_EPS;
      if (hold && x >= last) {
        const k = Math.floor((x - last) / lastLength);
        return { ordinal: m - 1 + k, startBeat: last + k * lastLength, beats: lastLength };
      }
      let cycle = Math.floor(x / total), r = x - cycle * total;
      if (r < 0) { cycle--; r += total; }
      const i = Math.max(0, Math.min(m - 1, upperBound(P, r, probe) - 1));
      return { ordinal: cycle * m + i, startBeat: cycle * total + P[i]!, beats: S[i]! };
    },
    startBeat(ordinal) {
      const n = ordinalOf(ordinal);
      if (hold && n >= m - 1) return last + (n - (m - 1)) * lastLength;
      return Math.floor(n / m) * total + P[n % m]!;
    },
    beats(ordinal) {
      const n = ordinalOf(ordinal);
      return hold && n >= m ? lastLength : S[n % m]!;
    },
  };
}

/** Wire grid to compiled grid; null when the wire grid is malformed (callers fall back to the legacy derivation). */
const gridCache: { wire: ClockGrid | null; compiled: BeatGrid | null } = { wire: null, compiled: null };
const sameWire = (a: ClockGrid, b: ClockGrid): boolean => {
  if (a === b) return true;
  if (a.offset !== b.offset || a.bpm !== b.bpm || a.beatsPerBar !== b.beatsPerBar) return false;
  const x = a.changes, y = b.changes;
  if (x === y) return true;
  if (!x || !y || x.length !== y.length) return !(x?.length) && !(y?.length);
  for (let i = 0; i < x.length; i++) if (x[i]![0] !== y[i]![0] || x[i]![1] !== y[i]![1]) return false;
  return true;
};
/** Compile a wire `ClockGrid` (offset, bpm, optional [at, bpm] changes). Returns null for a malformed grid, never throws. */
export function compileClockGrid(grid: ClockGrid | null | undefined): BeatGrid | null {
  if (!grid || typeof grid !== 'object' || !Number.isInteger(grid.beatsPerBar) || grid.beatsPerBar < 1 || grid.beatsPerBar > 16) return null;
  if (gridCache.wire && gridCache.compiled && sameWire(gridCache.wire, grid)) return gridCache.compiled;
  try {
    const changes = (grid.changes ?? []).map(pair => ({ at: pair[0], bpm: pair[1] }));
    const compiled = compileGrid(grid.bpm, grid.offset, changes);
    // Keep a private copy: the cache must not follow later mutation of a caller's object.
    gridCache.wire = { offset: grid.offset, bpm: grid.bpm, beatsPerBar: grid.beatsPerBar, ...(grid.changes?.length ? { changes: grid.changes.map(p => [p[0], p[1]] as const) } : {}) };
    gridCache.compiled = compiled;
    return compiled;
  } catch { return null; }
}

/** Scene interval signals at `time`: progress 0..1, remaining and elapsed seconds, exact endpoints. Null unless start < end. */
export function intervalSignals(time: number, start: number | null | undefined, end: number | null | undefined): IntervalSignals | null {
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) || !(end > start) || !Number.isFinite(time)) return null;
  const elapsed = Math.max(0, time - start), remaining = Math.max(0, end - time);
  const progress = time >= end ? 1 : time <= start ? 0 : Math.min(1, Math.max(0, (time - start) / (end - start)));
  return { start, end, progress, remaining, elapsed };
}

const fract = (value: number): number => value - Math.floor(value);
const finite = (value: number): number => Number.isFinite(value) ? value : 0;
const mod = (value: number, size: number): number => ((value % size) + size) % size;

/** Pure; runs inside renderNervScene and the HUD worker. With `grid` null it reproduces today's legacy derivation exactly:
 * `sceneBeat = localTime * bpm / 60`, `beatPhase = fract(sceneBeat)`, `bar = floor(time * bpm / 240)`, four beats per bar.
 * With a grid the bar is offset-aware, `beatsPerBar` is the grid's, and `sceneBeat` counts from the scene start.
 * `interval` is present whenever both scene bounds are finite with start < end, with or without a grid. */
export function timingSignals(time: number, grid: ClockGrid | null, sceneStart: number | null, sceneEnd: number | null,
  fallback: { bpm: number; localTime: number }): TimingSignals {
  const interval = intervalSignals(time, sceneStart, sceneEnd);
  const compiled = grid ? compileClockGrid(grid) : null;
  if (!compiled || !grid) {
    const bpm = finite(fallback.bpm), sceneBeat = finite(fallback.localTime) * bpm / 60, t = finite(time);
    return { beat: t * bpm / 60, sceneBeat, bar: Math.floor(t * bpm / 240), beatInBar: mod(Math.floor(sceneBeat), 4), beatPhase: fract(sceneBeat),
      barPhase: fract(sceneBeat / 4), beatsPerBar: 4, interval };
  }
  const beatsPerBar = grid.beatsPerBar, beat = compiled.beatAt(finite(time));
  const whole = Math.floor(beat + BEAT_EPS), beatPhase = Math.min(1, Math.max(0, beat - whole));
  const bar = Math.floor(whole / beatsPerBar), beatInBar = whole - bar * beatsPerBar;
  const sceneBeat = typeof sceneStart === 'number' && Number.isFinite(sceneStart) ? Math.max(0, beat - compiled.beatAt(sceneStart)) : beat;
  return { beat, sceneBeat, bar, beatInBar, beatPhase, barPhase: (beatInBar + beatPhase) / beatsPerBar, beatsPerBar, interval };
}
