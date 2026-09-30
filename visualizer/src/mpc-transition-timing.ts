/** Transition timing (docs/design/TIMING-SYSTEM-V2.md section 4, CONTRACT C-03 to C-08 and C-33).
 * One pure resolution shared by the clocked path, the live Auto path and the tests: a stored fade spec plus a boundary
 * ordinal gives a concrete fade (`pickFade`), and a concrete fade plus tempo gives a length in seconds (`planFade`).
 * No Math.random, Date.now or performance.now here: a pick is a function of (spec, ordinal, seed) alone, so it replays after a seek.
 */
import { BEATS_FROM_FADE, DURATION_MS_MAX, DURATION_MS_MIN, FADE_ANCHOR_COUNT, FADE_FROM_BEATS, FADE_RANDOM_SET_ALL, FADE_RANDOM_SET_MIN, FADE_TIMING_COUNT, LEGACY_BEATS } from './mpc-contract.ts';
import type { BeatGrid } from './mpc-beat-grid.ts';
import { cycleOrder } from './mpc-scene-clock.ts';

export const FADE_TIMING = ['seconds', 'instant', 'beat1', 'beat2', 'bar1', 'bar2', 'random'] as const;
/** Labels for menus and the Setup Builder, index = FadeTiming. "1 bar" replaces the legacy "4 beats" (Q08). */
export const FADE_TIMING_LABELS: readonly string[] = ['Seconds', 'Instant', '1 beat', '2 beats', '1 bar', '2 bars', 'Random'];
export type FadeTiming = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type ConcreteFade = 0 | 1 | 2 | 3 | 4 | 5;
/** 0 the boundary starts the fade, 1 it ends the fade, 2 it is the peak (`hit`; behaves as start until a pivot is supplied, C-06). */
export type FadeAnchor = 0 | 1 | 2;
export interface FadeSpec { timing: FadeTiming; randomSet: number; anchor: FadeAnchor; fixedMs: number }
export const defaultFadeSpec: Readonly<FadeSpec> = Object.freeze({ timing: 0, randomSet: FADE_RANDOM_SET_ALL, anchor: 0, fixedMs: 2000 } as FadeSpec);
/** `beats` is the musical length after caps (0 when unknown or Instant, at most 64 for the wire). `pivot` is 0 start, 1 end, else the hit fraction. */
export interface FadePlan { timing: ConcreteFade; beats: number; seconds: number; anchor: FadeAnchor; pivot: number }

/** Absolute limit for beat-derived lengths, seconds. */
export const FADE_BEAT_LIMIT_SECONDS = 16;
/** Wire limit for `transitionBeats`. */
export const FADE_WIRE_BEATS_MAX = 64;

const isInt = (value: unknown, low: number, high: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high;
const clampMs = (ms: number): number => Math.min(DURATION_MS_MAX, Math.max(DURATION_MS_MIN, ms));

/** Legacy `beats` (0, 1, 2, 4) to the new enum; anything else reads as Seconds. */
export function fadeFromBeats(beats: number): FadeTiming {
  return ((LEGACY_BEATS as readonly number[]).includes(beats) ? FADE_FROM_BEATS[beats]! : 0) as FadeTiming;
}
/** The legacy projection written next to `fadeTiming` so an older build still loads the file (Instant, 2 bars and Random project to 0). */
export function beatsFromFade(timing: FadeTiming): number {
  return isInt(timing, 0, FADE_TIMING_COUNT - 1) ? BEATS_FROM_FADE[timing]! : 0;
}

/** Tolerant parse of the host and native `settings` fields. A missing or invalid `fadeTiming` derives from a valid `beats`
 * first, then falls back to `current` (default: the default spec, i.e. a full-state snapshot where absent means default). */
export function parseFadeFields(raw: Record<string, unknown>, current: Readonly<FadeSpec> = defaultFadeSpec): FadeSpec {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const timing = isInt(r.fadeTiming, 0, FADE_TIMING_COUNT - 1) ? r.fadeTiming
    : typeof r.beats === 'number' && (LEGACY_BEATS as readonly number[]).includes(r.beats) ? FADE_FROM_BEATS[r.beats]! : current.timing;
  const randomSet = isInt(r.fadeRandomSet, FADE_RANDOM_SET_MIN, FADE_RANDOM_SET_ALL) ? r.fadeRandomSet : current.randomSet;
  const anchor = isInt(r.fadeAnchor, 0, FADE_ANCHOR_COUNT - 1) ? r.fadeAnchor : current.anchor;
  const fixedMs = typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) ? Math.round(clampMs(r.durationMs)) : current.fixedMs;
  return { timing: timing as FadeTiming, randomSet, anchor: anchor as FadeAnchor, fixedMs };
}

const CONCRETE: readonly ConcreteFade[] = [1, 2, 3, 4, 5];
/** Random draws one of the five musical lengths per boundary from `spec.randomSet` (bit i is CONCRETE[i]) as a seeded bag:
 * every member appears once per cycle of k boundaries, permuted per cycle, and for k >= 3 no member repeats across a cycle seam.
 * `index` is the incoming scene ordinal on the clock, or a per-activation counter live. Any other timing is returned as is.
 * A mask that is not an integer in 1..31 is treated as all five members. */
export function pickFade(spec: FadeSpec, index: number, seed: number): ConcreteFade {
  if (spec.timing !== 6) return (isInt(spec.timing, 0, 5) ? spec.timing : 0) as ConcreteFade;
  const mask = isInt(spec.randomSet, FADE_RANDOM_SET_MIN, FADE_RANDOM_SET_ALL) ? spec.randomSet : FADE_RANDOM_SET_ALL;
  const base = CONCRETE.filter((_, i) => (mask >> i) & 1);
  const n = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  return cycleOrder(base, Math.floor(n / base.length), ((Number.isFinite(seed) ? seed : 0) ^ 0xa5f1c3d7) >>> 0)[n % base.length] as ConcreteFade;
}

export interface FadeContext {
  /** Live or fixed tempo; null when unknown (every beat-derived mode then resolves to `fixedMs`). Ignored when `grid` is given. */
  bpm: number | null;
  beatsPerBar: number;
  /** Upper bound in seconds (the incoming or outgoing scene, or the live phrase). */
  capSeconds?: number;
  /** A non-constant grid: beats convert to seconds exactly through it, so a fade ends on a real beat across a tempo change. */
  grid?: BeatGrid;
  /** Boundary position in beats since the offset (needed with `grid`). */
  boundaryBeat?: number;
  /** Hit fraction of a style for a length in beats (TRX `TransitionMeta.hit`); only consulted for anchor 2. */
  pivotForBeats?: (beats: number) => number;
}

const pivotOf = (anchor: FadeAnchor, beats: number, ctx: FadeContext): number => {
  if (anchor === 1) return 1;
  if (anchor !== 2 || !ctx.pivotForBeats || !(beats > 0)) return 0;
  const p = ctx.pivotForBeats(beats);
  return Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
};

/** Length of a concrete fade. Instant is 0 seconds; a beat mode without tempo is `fixedMs`; beat lengths are limited to 16 s;
 * `capSeconds` bounds every mode. Pure. */
export function planFade(spec: FadeSpec, pick: ConcreteFade, ctx: FadeContext): FadePlan {
  const anchor = (isInt(spec.anchor, 0, FADE_ANCHOR_COUNT - 1) ? spec.anchor : 0) as FadeAnchor;
  const timing = (isInt(pick, 0, 5) ? pick : 0) as ConcreteFade;
  if (timing === 1) return { timing, beats: 0, seconds: 0, anchor, pivot: pivotOf(anchor, 0, ctx) };
  const perBar = isInt(ctx.beatsPerBar, 1, 16) ? ctx.beatsPerBar : 4;
  const cap = typeof ctx.capSeconds === 'number' && Number.isFinite(ctx.capSeconds) ? Math.max(0, ctx.capSeconds) : Infinity;
  const fixed = clampMs(Number.isFinite(spec.fixedMs) ? spec.fixedMs : 2000) / 1000;
  const gridded = !!ctx.grid && typeof ctx.boundaryBeat === 'number' && Number.isFinite(ctx.boundaryBeat);
  const bpm = typeof ctx.bpm === 'number' && Number.isFinite(ctx.bpm) && ctx.bpm > 0 ? ctx.bpm : null;
  const wanted = timing === 2 ? 1 : timing === 3 ? 2 : timing === 4 ? perBar : timing === 5 ? 2 * perBar : 0;
  let seconds: number, beats: number;
  if (timing === 0 || (!gridded && bpm === null)) {
    seconds = fixed; beats = bpm !== null ? fixed * bpm / 60 : 0;
    if (gridded) { const g = ctx.grid!, t0 = g.timeAt(ctx.boundaryBeat!); beats = g.beatAt(t0 + fixed) - g.beatAt(t0); }
  } else {
    if (gridded) {
      const g = ctx.grid!, b = ctx.boundaryBeat!;
      seconds = anchor === 1 ? g.timeAt(b) - g.timeAt(b - wanted) : g.timeAt(b + wanted) - g.timeAt(b);
    } else seconds = wanted * 60 / bpm!;
    beats = wanted;
    if (seconds > FADE_BEAT_LIMIT_SECONDS) { beats = beats * FADE_BEAT_LIMIT_SECONDS / seconds; seconds = FADE_BEAT_LIMIT_SECONDS; }
  }
  if (seconds > cap) { beats = seconds > 0 ? beats * cap / seconds : 0; seconds = cap; }
  beats = Math.min(FADE_WIRE_BEATS_MAX, Math.max(0, beats));
  return { timing, beats, seconds, anchor, pivot: pivotOf(anchor, beats, ctx) };
}

/** How strong the scene boundary is, 0..3, for transition styles that scale drama with the musical position (C-33).
 * `absBar` is `pattern.startBeat(n) / beatsPerBar`: 3 on every 16th bar, 2 on every 4th, else 1. `null` (live, manual, adaptive) is 0,
 * except live Auto with a fixed phrase of at least 4 bars (`liveBars`), which is 2. */
export function boundaryLevel(absBar: number | null, liveBars?: number): 0 | 1 | 2 | 3 {
  if (absBar === null || absBar === undefined) return typeof liveBars === 'number' && liveBars >= 4 ? 2 : 0;
  if (!Number.isFinite(absBar) || absBar < 0) return 0;
  return absBar % 16 === 0 ? 3 : absBar % 4 === 0 ? 2 : 1;
}
