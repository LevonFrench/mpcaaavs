// Read-only musical clock over one published song map. Immutable: a new revision is a new clock, so a
// late scan result can never change what a caller already evaluated from an older revision. Every
// answer is a pure function of (map, revision, t); nothing reads a wall clock.
//
// Semantics follow bizarro/evangelion's AudioData (MIT): beat and bar indices are continuous, are 0 at
// the first beat/downbeat, interpolate linearly between explicit timestamps (so tempo changes need no
// global BPM) and extrapolate with the nearest local period outside the grid. The map carries no meter,
// so a bar is the span between explicit downbeats and beatInBar assumes four beats per bar.
import type { SectionRole, SongMapJSON, SongMapSection } from './types.ts';

export interface SectionPosition {
  readonly section: SongMapSection;
  readonly index: number;
  /** Progress through the section, clamped to 0..1. */
  readonly p: number;
}

export type BoundaryKind = 'section' | 'bar' | 'beat';
export interface Boundary {
  readonly kind: BoundaryKind;
  /** Media time in seconds, strictly after the query time. */
  readonly time: number;
  /** Index of the section, downbeat or beat that starts at `time`. */
  readonly index: number;
  /** The section starting at a section boundary. */
  readonly section?: SongMapSection;
}

export interface BarPosition {
  /** Continuous bar index (0 at the first downbeat, negative before it). */
  readonly bar: number;
  /** Continuous beat within the bar, 0 <= beatInBar < 4. */
  readonly beatInBar: number;
  /** 0..1 through the bar. */
  readonly phase: number;
}

const BEATS_PER_BAR = 4;

/** Number of entries <= t. */
function upperBound(list: readonly number[], t: number): number {
  let lo = 0, hi = list.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (list[m]! <= t) lo = m + 1; else hi = m; }
  return lo;
}

/** Continuous index of t on an explicit timestamp list; `fallbackPeriod` serves lists shorter than two entries. */
function indexAt(times: readonly number[], t: number, fallbackPeriod: number): number {
  const n = times.length;
  if (n === 0) return t / fallbackPeriod;
  if (n === 1) return (t - times[0]!) / fallbackPeriod;
  if (t <= times[0]!) return (t - times[0]!) / (times[1]! - times[0]!);
  if (t >= times[n - 1]!) return n - 1 + (t - times[n - 1]!) / (times[n - 1]! - times[n - 2]!);
  const hi = upperBound(times, t), lo = hi - 1;
  return lo + (t - times[lo]!) / (times[hi]! - times[lo]!);
}

function timeOf(times: readonly number[], index: number, fallbackPeriod: number): number {
  const n = times.length;
  if (n === 0) return index * fallbackPeriod;
  if (n === 1) return times[0]! + index * fallbackPeriod;
  if (index <= 0) return times[0]! + index * (times[1]! - times[0]!);
  if (index >= n - 1) return times[n - 1]! + (index - (n - 1)) * (times[n - 1]! - times[n - 2]!);
  const k = Math.floor(index);
  return times[k]! + (times[k + 1]! - times[k]!) * (index - k);
}

export class SongMapClock {
  readonly map: SongMapJSON;
  /** Analysis revision this clock was built from; strictly increasing for one track. */
  readonly revision: number;
  /** Decoded spans in seconds (null: the whole map is trusted). */
  readonly coverage: readonly (readonly [number, number])[] | null;
  private readonly beats: readonly number[];
  private readonly downbeats: readonly number[];
  private readonly sections: readonly SongMapSection[];
  private readonly beatPeriod: number;

  constructor(map: SongMapJSON, revision = 0, coverage?: readonly (readonly [number, number])[]) {
    if (!Number.isInteger(revision) || revision < 0) throw new RangeError('Invalid revision');
    this.map = map; this.revision = revision; this.coverage = coverage ?? null;
    this.beats = map.beats; this.downbeats = map.downbeats; this.sections = map.sections;
    this.beatPeriod = map.bpm > 0 ? 60 / map.bpm : .5;
  }

  get duration(): number { return this.map.duration; }
  get bpm(): number { return this.map.bpm; }

  /** Local tempo at t from the surrounding beat interval (the map BPM without a grid). */
  bpmAt(t: number): number {
    const b = this.beats;
    if (b.length < 2) return this.map.bpm;
    const i = Math.max(1, Math.min(b.length - 1, upperBound(b, t)));
    return 60 / (b[i]! - b[i - 1]!);
  }

  /** Section under t. Times before the first section resolve to it and times at or after the last end to the last. */
  sectionAt(t: number): SectionPosition | null {
    const s = this.sections;
    if (!s.length) return null;
    let lo = 0, hi = s.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (s[m]!.start <= t) lo = m + 1; else hi = m; }
    const index = Math.max(0, lo - 1), section = s[index]!, span = section.end - section.start;
    return { section, index, p: span > 0 ? Math.max(0, Math.min(1, (t - section.start) / span)) : 1 };
  }

  roleAt(t: number): SectionRole | null { return this.sectionAt(t)?.section.role ?? null; }

  /**
   * First boundary strictly after t. `section` boundaries are section starts (the start of the first
   * section is never "next"), `bar` boundaries are downbeats, `beat` boundaries are beats.
   */
  nextBoundary(t: number, kind: BoundaryKind = 'section'): Boundary | null {
    if (kind === 'section') {
      const s = this.sections;
      let lo = 0, hi = s.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (s[m]!.start <= t) lo = m + 1; else hi = m; }
      const index = Math.max(1, lo);
      if (index >= s.length) return null;
      return { kind, time: s[index]!.start, index, section: s[index]! };
    }
    const list = kind === 'bar' ? this.downbeats : this.beats;
    const index = upperBound(list, t);
    if (index >= list.length) return null;
    return { kind, time: list[index]!, index };
  }

  /** Continuous beat index (0 at the first beat). */
  beatAt(t: number): number { return indexAt(this.beats, t, this.beatPeriod); }
  /** Time of a (fractional) beat index. */
  timeOfBeat(beat: number): number { return timeOf(this.beats, beat, this.beatPeriod); }
  /** Continuous bar index from downbeats (0 at the first downbeat). Without downbeats, four beats per bar. */
  barAt(t: number): number {
    if (this.downbeats.length >= 2) return indexAt(this.downbeats, t, this.beatPeriod * BEATS_PER_BAR);
    return this.beatAt(t) / BEATS_PER_BAR;
  }
  timeOfBar(bar: number): number {
    if (this.downbeats.length >= 2) return timeOf(this.downbeats, bar, this.beatPeriod * BEATS_PER_BAR);
    return this.timeOfBeat(bar * BEATS_PER_BAR);
  }
  /** Bar, beat inside the bar and phase, from the downbeat grid. */
  barPosition(t: number): BarPosition {
    const bar = this.barAt(t), phase = bar - Math.floor(bar);
    return { bar, beatInBar: Math.min(BEATS_PER_BAR - 1e-9, phase * BEATS_PER_BAR), phase };
  }
  /** Nearest beat time to t. */
  nearestBeat(t: number): number { return this.timeOfBeat(Math.round(this.beatAt(t))); }

  /** True when t lies inside an analysed span (always true for a complete map). */
  covered(t: number): boolean {
    if (!this.coverage) return true;
    for (const [a, b] of this.coverage) if (t >= a && t < b) return true;
    return false;
  }

  /** Progress 0..1 from `start` to `end`, clamped: the interval-counter rule of the HUD driver spec. */
  static progress(t: number, start: number, end: number): number {
    if (!(end > start)) return t >= end ? 1 : 0;
    return Math.max(0, Math.min(1, (t - start) / (end - start)));
  }
}
