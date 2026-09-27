// The two Timeline implementations and the look-ahead scheduler (plan §4.2, §4.3).
//
// One job: turn "what the music is doing" into "which layers fire, and exactly
// when", on the audio clock and nothing else (§4.6).
//
// The load-bearing idea is that `Scheduler` talks to `Timeline` and to nothing
// below it. It cannot see a TempoTracker, an AudioContext, a decoded buffer or a
// tier. That is not tidiness — it is the mitigation for the "two tiers diverge
// into two engines" risk in §12. If the scheduler could ask which tier it holds
// it would eventually branch on the answer, and then there are two schedulers to
// fix every time. The Tier B -> Tier A upgrade of §5.3 is a pointer assignment
// precisely because that question cannot be asked.
//
// What this module deliberately does NOT do:
//   - own or advance a tempo tracker. `clock.ts` does that; `TierBTimeline`
//     wraps one it is handed and never constructs one.
//   - render, hold GPU state, or know what a layer looks like.
//   - decide *what* an event means. It answers "fire now, or not yet".
//   - quantise swing. Swing is a continuous offset applied at schedule time and
//     the grid is not consulted about it (§4.4).
//   - reach for wall-clock time. Every number below is audio-clock seconds or
//     grid slots; there is no `performance.now()` and no `Date.now()` path.

import {
  SLOTS_PER_BEAT,
  SLOTS_PER_BAR,
  anchorLeadBeats,
  secondsPerSlot,
  type Anchor,
  type DivisionName,
  type Envelope,
  type Timeline,
  type TimelineEvent,
  type TriggerSpec,
} from './contracts.ts';
import { hash2, hashString } from './rng.ts';
import type { TempoTracker } from './clock.ts';

// ---------------------------------------------------------------------------
// The division table
// ---------------------------------------------------------------------------

/**
 * Slots per tick for every named division (§4.4).
 *
 * The whole reason the grid is 240 and not UnrealTracks' 16 is this table: at
 * 240 = LCM(16, 12, 5) every entry below is an INTEGER stride, so a triplet, a
 * quintuplet and a dotted eighth are all exact grid positions rather than
 * accumulating rounding error over a track. `assertIntegerStrides()` at the
 * bottom of this section proves it at module load rather than trusting the
 * arithmetic in a comment.
 *
 *   1/64        15    240/16
 *   1/32        30    240/8
 *   1/16        60    240/4
 *   1/8        120    240/2
 *   beat       240
 *   half       480    two beats
 *   bar        960    four beats, 4/4 assumed throughout v1
 *   2bar      1920
 *   4bar      3840
 *   1/8T        80    240/3   — the reason 16 slots/beat was not enough
 *   1/16T       40    240/6
 *   1/4quint    48    240/5   — the reason 48 slots/beat was not enough either
 *   1/8dot     180    240*3/4
 *
 * Septuplets are absent on purpose (§13): they would need 1680 slots/beat and
 * the plan closed that question. §4.4's `/5` and `/7` are *phrase lengths* in
 * bars, which is a different mechanism — see `PHRASE_BARS`.
 */
export const DIVISION_SLOTS: Readonly<Record<DivisionName, number>> = {
  '1/64':     SLOTS_PER_BEAT / 16,
  '1/32':     SLOTS_PER_BEAT / 8,
  '1/16':     SLOTS_PER_BEAT / 4,
  '1/8':      SLOTS_PER_BEAT / 2,
  'beat':     SLOTS_PER_BEAT,
  'half':     SLOTS_PER_BEAT * 2,
  'bar':      SLOTS_PER_BAR,
  '2bar':     SLOTS_PER_BAR * 2,
  '4bar':     SLOTS_PER_BAR * 4,
  '1/8T':     SLOTS_PER_BEAT / 3,
  '1/16T':    SLOTS_PER_BEAT / 6,
  '1/4quint': SLOTS_PER_BEAT / 5,
  '1/8dot':   (SLOTS_PER_BEAT * 3) / 4,
};

/**
 * Odd phrase lengths (§4.4). A layer on a 5- or 7-bar cycle phases against 4/4
 * and re-aligns every 5 or 7 bars, so a long show never reads as looped. These
 * are cycle lengths, not divisions — nothing here subdivides a beat by 7, which
 * is why the 240 grid survives them.
 */
export const PHRASE_BARS = [4, 5, 7] as const;

/** Non-negotiable invariant of the table above, checked once at module load. */
function assertIntegerStrides(): void {
  for (const name of Object.keys(DIVISION_SLOTS) as DivisionName[]) {
    const slots = DIVISION_SLOTS[name];
    if (!Number.isInteger(slots) || slots <= 0) {
      throw new Error(
        `Division '${name}' is ${slots} slots, which is not a positive integer. ` +
        `The 240-slot grid (plan §3.1) exists to make every division exact; a ` +
        `fractional stride drifts silently over a track.`,
      );
    }
  }
}
assertIntegerStrides();

export function divisionSlots(division: DivisionName): number {
  return DIVISION_SLOTS[division];
}

// ---------------------------------------------------------------------------
// Euclidean rhythms (§4.4)
// ---------------------------------------------------------------------------

/**
 * E(k, n) by Bjorklund's algorithm — k onsets spread as evenly as possible over
 * n steps. E(3,8) is the tresillo, E(5,8) the cinquillo, E(2,5) a clave; two
 * integers reach essentially every rhythm worth having, which is a far better
 * control than a 16-step grid.
 *
 * Purely combinatorial and therefore deterministic by construction — there is no
 * seed to get wrong (§4.7). k = 0 returns all-false because silence has to be
 * expressible (art direction §3.5); k >= n returns all-true.
 *
 * Results are cached because a layer asks for the same (k, n) every frame for
 * the life of a preset, and the pattern is immutable.
 *
 * The cache is nested (steps -> onsets) rather than keyed by an arithmetic
 * combination of the two. A flat `onsets * 4096 + steps` key looks fine and is
 * not: E(0, 5000) and E(1, 904) hash to the same number, so the second layer
 * silently inherits the first one's pattern and goes dead. Two map lookups cost
 * nothing next to a wrong rhythm nobody can explain.
 */
const euclidCache = new Map<number, Map<number, readonly boolean[]>>();

export function euclid(k: number, n: number): readonly boolean[] {
  const steps = Math.max(0, Math.floor(n));
  if (steps === 0) return [];
  const onsets = Math.max(0, Math.min(steps, Math.floor(k)));

  let byOnsets = euclidCache.get(steps);
  if (byOnsets === undefined) {
    byOnsets = new Map<number, readonly boolean[]>();
    euclidCache.set(steps, byOnsets);
  }
  const hit = byOnsets.get(onsets);
  if (hit !== undefined) return hit;

  const pattern = bjorklund(onsets, steps);
  byOnsets.set(onsets, pattern);
  return pattern;
}

function bjorklund(k: number, n: number): readonly boolean[] {
  if (k === 0) return new Array<boolean>(n).fill(false);
  if (k === n) return new Array<boolean>(n).fill(true);

  // Bjorklund is the same recursion as Euclid's GCD, run on sequences instead of
  // numbers: repeatedly distribute the shorter group into the longer one and
  // recurse on what is left over. Kept iterative because the recursive form
  // reads worse and this runs once per (k, n) ever.
  let head: boolean[][] = Array.from({ length: k }, () => [true]);
  let tail: boolean[][] = Array.from({ length: n - k }, () => [false]);

  while (tail.length > 1 && head.length > 1) {
    const pairs = Math.min(head.length, tail.length);
    const merged: boolean[][] = [];
    for (let i = 0; i < pairs; i++) merged.push([...head[i]!, ...tail[i]!]);
    const remainder = head.length > pairs ? head.slice(pairs) : tail.slice(pairs);
    head = merged;
    tail = remainder;
  }

  const out: boolean[] = [];
  for (const group of head) out.push(...group);
  for (const group of tail) out.push(...group);
  return out;
}

/**
 * Does tick `tick` survive the trigger's Euclidean pattern?
 *
 * `offsetSteps` rotates the pattern so two layers can share a rhythm out of
 * phase. The modulo is written twice because `%` on a negative tick is negative
 * in JavaScript, and a negative index silently reads `undefined` under
 * `noUncheckedIndexedAccess` — which then reads as "never fires" and looks like
 * a dead layer rather than a bug.
 */
function euclidAllows(trigger: TriggerSpec, tick: number): boolean {
  const n = Math.max(0, Math.floor(trigger.euclidN));
  if (n === 0) return false; // no steps is no pattern, which is silence, which is legal
  const pattern = euclid(trigger.euclidK, n);
  const index = (((tick + Math.floor(trigger.offsetSteps)) % n) + n) % n;
  return pattern[index] === true;
}

// ---------------------------------------------------------------------------
// Swing (§4.4)
// ---------------------------------------------------------------------------

/**
 * Swing offset for one tick, in SLOTS — fractional, and deliberately so.
 *
 * Swing delays every second subdivision by `swing/2` of a subdivision. 0 is
 * straight and 2/3 puts the offbeat exactly on the triplet — the plan's "0-66%"
 * is that same number rounded, and the clamp uses 2/3 rather than 0.66 so the
 * triplet feel is actually reachable rather than one part in three hundred shy
 * of it. Everything between is a real setting a human would choose.
 *
 * The plan is explicit that this is a
 * continuous offset applied at schedule time and not a grid quantisation: at
 * 240 slots/beat a 1/8 pair is 120 slots, so quantising swing would give 120
 * usable values and, worse, would make swing interact with the division stride.
 * A swung event therefore has a fractional `slot`, which `TimelineEvent`
 * documents as legal.
 *
 * Only ever delays, never advances. That matters to the scheduler: an event's
 * swung fire time is always >= its straight fire time, so scanning ticks up to
 * the straight horizon cannot miss a swung one.
 */
const MAX_SWING = 2 / 3;

function swingSlots(swing: number, stride: number, tick: number): number {
  if (swing <= 0) return 0;
  if ((tick & 1) === 0) return 0;
  return Math.min(swing, MAX_SWING) * stride * 0.5;
}

// ---------------------------------------------------------------------------
// Static (Tier A) timeline
// ---------------------------------------------------------------------------

/** Extra, non-grid events a Tier A analysis produced: onsets, sections, drops. */
export interface StaticTimelineInit {
  /** Strictly increasing audio-clock beat times. At least two. */
  readonly beatTimes: readonly number[];
  /** Which beat index is bar 1. Downbeat detection gives this; `idx % 4` does not (§6). */
  readonly downbeatOffset?: number;
  /** Content-dependent and structural events, in time order. Merged into `eventsBetween`. */
  readonly events?: readonly TimelineEvent[];
  /** Track length. Defaults to the last beat time; `horizonSec` reports it. */
  readonly durationSec?: number;
}

/**
 * Tier A: the whole grid is known before a sample is played (§4.2).
 *
 * `horizonSec` is the entire track and `confidence` is 1, which is the *only*
 * way this differs from `TierBTimeline` as far as anything downstream can tell.
 * Nothing constructs one of these yet — pre-analysis is Phase 1 — and that is
 * fine: writing it now is what proves the interface is real rather than a
 * description of the tempo tracker with extra steps.
 *
 * The grid is stored as explicit beat times rather than a bpm, because a real
 * track's tempo is not constant and a single bpm accumulates error across five
 * minutes. `fromTempo` exists for click tracks and tests and simply synthesises
 * the array, so there is one interpolation path and not two.
 */
export class StaticTimeline implements Timeline {
  private readonly beats: readonly number[];
  private readonly extra: readonly TimelineEvent[];
  private readonly downbeatOffset: number;
  readonly horizonSec: number;
  readonly confidence = 1;

  constructor(init: StaticTimelineInit) {
    if (init.beatTimes.length < 2) {
      throw new Error('StaticTimeline needs at least two beat times to have a tempo at all.');
    }
    // Every method below divides by a segment length, so a repeated or
    // out-of-order beat time yields Infinity or NaN rather than an error. NaN
    // then propagates into the scheduler's tick index, where it compares false
    // against everything and the layer simply stops firing — a silent death
    // several modules away from the malformed analysis that caused it. One O(n)
    // scan per track buys a stack trace pointing at the actual culprit.
    for (let i = 1; i < init.beatTimes.length; i++) {
      if (!(init.beatTimes[i]! > init.beatTimes[i - 1]!)) {
        throw new Error(
          `StaticTimeline beat times must be strictly increasing; index ${i} is ` +
          `${init.beatTimes[i]!} after ${init.beatTimes[i - 1]!}.`,
        );
      }
    }
    this.beats = init.beatTimes;
    this.extra = [...(init.events ?? [])].sort((a, b) => a.time - b.time);
    this.downbeatOffset = Math.floor(init.downbeatOffset ?? 0);
    this.horizonSec = init.durationSec ?? this.beats[this.beats.length - 1]!;
  }

  /** A constant-tempo grid. For click fixtures and the golden-image harness. */
  static fromTempo(
    bpm: number,
    offsetSec: number,
    durationSec: number,
    init?: Omit<StaticTimelineInit, 'beatTimes' | 'durationSec'>,
  ): StaticTimeline {
    if (!(bpm > 0)) throw new Error(`StaticTimeline.fromTempo needs a positive bpm, got ${bpm}.`);
    const period = 60 / bpm;
    const count = Math.max(2, Math.ceil((durationSec - offsetSec) / period) + 2);
    const beatTimes = new Array<number>(count);
    for (let i = 0; i < count; i++) beatTimes[i] = offsetSec + i * period;
    return new StaticTimeline({ ...init, beatTimes, durationSec });
  }

  bpm(atSec: number): number {
    const i = this.beatIndexAt(atSec);
    const a = this.beats[i]!;
    const b = this.beats[i + 1]!;
    return 60 / (b - a);
  }

  slotAt(atSec: number): number {
    const i = this.beatIndexAt(atSec);
    const a = this.beats[i]!;
    const b = this.beats[i + 1]!;
    // Linear inside the segment, and linearly extrapolated outside it using the
    // first/last segment's tempo. Extrapolation keeps slotAt monotonic and
    // total, which the scheduler's inverse solve relies on.
    return (i + (atSec - a) / (b - a)) * SLOTS_PER_BEAT;
  }

  eventsBetween(a: number, b: number): TimelineEvent[] {
    const out: TimelineEvent[] = [];
    if (!(b > a)) return out;

    // Grid events. Half-open [a, b) so a rolling window cannot double-fire.
    const firstBeat = Math.max(0, Math.ceil(this.slotAt(a) / SLOTS_PER_BEAT));
    for (let i = firstBeat; i < this.beats.length; i++) {
      const t = this.beats[i]!;
      if (t < a) continue;
      if (t >= b) break;
      out.push(beatEvent(i - this.downbeatOffset, t, i * SLOTS_PER_BEAT));
    }

    // Binary search rather than scanning from zero. A pre-analysed five-minute
    // track carries thousands of onsets, this runs every frame, and a linear
    // `continue` past all of them costs more as the track plays — which reads
    // as the visualiser getting gradually more expensive the longer it runs,
    // and is a horrible thing to have to diagnose later.
    for (let i = this.extraIndexAt(a); i < this.extra.length; i++) {
      const e = this.extra[i]!;
      if (e.time >= b) break;
      out.push(e);
    }

    out.sort((x, y) => x.time - y.time);
    return out;
  }

  /** First index in `extra` with `time >= at`. `extra.length` if there is none. */
  private extraIndexAt(at: number): number {
    let lo = 0;
    let hi = this.extra.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.extra[mid]!.time < at) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Index of the segment containing `atSec`, clamped so extrapolation is total. */
  private beatIndexAt(atSec: number): number {
    const last = this.beats.length - 2;
    if (atSec <= this.beats[0]!) return 0;
    if (atSec >= this.beats[last + 1]!) return last;
    let lo = 0;
    let hi = last;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.beats[mid]! <= atSec) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

// ---------------------------------------------------------------------------
// Tier B (live) timeline
// ---------------------------------------------------------------------------

/** Two bars of look-ahead is all a realtime tracker can honestly claim (§4.2). */
const TIER_B_HORIZON_BARS = 2;

/**
 * Onset retention while the tracker is NOT locked, in seconds.
 *
 * Unlocked there is no tempo and therefore no horizon to prune against, and an
 * input that never locks — silence, speech, a mic in a quiet room — is the
 * normal case rather than the exception. Without a fallback window the onset
 * array grows for the lifetime of the tab. Generous enough to cover two bars of
 * anything slower than 60 BPM, so a lock arriving late still finds its history.
 */
const TIER_B_UNLOCKED_KEEP_SEC = 8;

/**
 * Tier B: a `TempoTracker` from `clock.ts`, wearing the Timeline interface.
 *
 * It wraps rather than extends, and it never constructs the tracker, because the
 * tracker is fed by the onset detector and its lifetime belongs to the audio
 * engine. The only state added here is `bias`, and it exists for one reason:
 *
 * The tracker re-anchors `nextBeat` when an onset disagrees with the prediction
 * (a 25% pull, by design — that is what keeps it locked to a drifting DJ set).
 * A re-anchor moves the derived slot position, and it can move it BACKWARDS. A
 * slot counter that runs backwards kills the grid silently — it is the exact bug
 * §3.2 records Pulse losing an evening to, and the Timeline contract explicitly
 * forbids it. So the raw tracker position is offset by an accumulated `bias`
 * that only ever grows, applied in `update()` where "now" is known. The grid
 * stays continuous across a tempo change (§4.10: keep phase, recompute the
 * horizon) and the phase correction shows up as a slightly early or late beat
 * rather than as a rewind.
 */
export class TierBTimeline implements Timeline {
  private anchorTime = 0;
  private anchorSlot = 0;
  private secPerBeat = 0;
  private bias = 0;
  private maxSlot = Number.NEGATIVE_INFINITY;
  private readonly onsets: TimelineEvent[] = [];

  constructor(private readonly tracker: TempoTracker) {}

  /**
   * Sample the tracker for this frame. Call once per frame with the audio clock,
   * before anything asks the timeline a question — every method below reads the
   * snapshot taken here rather than the live tracker, so that all layers in one
   * frame agree about "now" (the same reasoning as `AudioSnapshot`).
   */
  update(now: number): void {
    this.tracker.update(now);
    if (!this.tracker.locked || !this.tracker.bpm) {
      this.secPerBeat = 0;
      // Pruned on this path too. Skipping it here is what turns "never locks"
      // into an unbounded array.
      this.pruneOnsets(now);
      return;
    }
    this.secPerBeat = 60 / this.tracker.bpm;
    this.anchorTime = now;

    const raw = (this.tracker.beatIndex + this.tracker.phase) * SLOTS_PER_BEAT;
    const biased = raw + this.bias;
    if (biased < this.maxSlot) this.bias += this.maxSlot - biased;
    this.anchorSlot = raw + this.bias;
    this.maxSlot = this.anchorSlot;

    this.pruneOnsets(now);
  }

  /**
   * Drop onsets older than the horizon; past that they are history, and history
   * is what the spectrogram is for.
   *
   * In place, via one `splice`, rather than reassigning the result of a
   * `filter`. Once the buffer is full the stale-front condition is true on
   * roughly every frame, so `filter` there is a fresh array per frame in the
   * per-frame path — exactly the GC pressure §4.9 goes out of its way to keep
   * out of the audio path.
   */
  private pruneOnsets(now: number): void {
    const keepFrom = now - (this.secPerBeat > 0 ? this.horizonSec : TIER_B_UNLOCKED_KEEP_SEC);
    let drop = 0;
    while (drop < this.onsets.length && this.onsets[drop]!.time < keepFrom) drop++;
    if (drop > 0) this.onsets.splice(0, drop);
  }

  /**
   * Record a detected onset so `eventsBetween` can report it.
   *
   * These are content-dependent and therefore unavoidably reactive on this tier
   * (§4.3) — they are already in the past when they arrive, and the scheduler
   * fires them immediately rather than pretending it saw them coming. Tier A
   * gets the same events ahead of time and the consumer does not change.
   */
  addOnset(e: TimelineEvent): void {
    this.onsets.push(e);
  }

  /**
   * Everything invalid across a seek or a track change (§4.10).
   *
   * Must be called on a backwards seek, and the tracker reset alongside it.
   * Skipping it does not corrupt anything: the monotonicity bias absorbs
   * whatever the tracker's position drops by, so the grid stalls at its
   * high-water mark until real time catches back up rather than rewinding. On a
   * long seek that stall is long, and every layer is silent for the duration.
   * Stillness is a much better failure than a rewound grid, but it is still a
   * failure, so reset on seek.
   */
  reset(): void {
    this.anchorTime = 0;
    this.anchorSlot = 0;
    this.secPerBeat = 0;
    this.bias = 0;
    this.maxSlot = Number.NEGATIVE_INFINITY;
    this.onsets.length = 0;
  }

  /** Re-anchor after a musical seek without forcing the detector to relock. */
  seekByBeats(beats: number, targetTime: number): void {
    if (this.secPerBeat <= 0 || !Number.isFinite(beats) || !Number.isFinite(targetTime)) return;
    this.anchorTime = targetTime;
    this.anchorSlot = Math.max(0, this.anchorSlot + beats * SLOTS_PER_BEAT);
    this.maxSlot = this.anchorSlot;
    this.onsets.length = 0;
  }

  bpm(_atSec: number): number {
    return this.tracker.locked ? this.tracker.bpm : 0;
  }

  slotAt(atSec: number): number {
    if (this.secPerBeat <= 0) return 0;
    return this.anchorSlot + ((atSec - this.anchorTime) / this.secPerBeat) * SLOTS_PER_BEAT;
  }

  eventsBetween(a: number, b: number): TimelineEvent[] {
    const out: TimelineEvent[] = [];
    if (this.secPerBeat <= 0 || !(b > a)) return out;

    const secPerBeat = this.secPerBeat;
    const firstBeat = Math.ceil(this.slotAt(a) / SLOTS_PER_BEAT);
    const lastBeat = Math.floor(this.slotAt(b) / SLOTS_PER_BEAT);
    for (let i = firstBeat; i <= lastBeat; i++) {
      const slot = i * SLOTS_PER_BEAT;
      const t = this.anchorTime + ((slot - this.anchorSlot) / SLOTS_PER_BEAT) * secPerBeat;
      if (t < a || t >= b) continue;
      // Bar 1 is wherever we happened to lock until downbeat detection lands
      // (§6). Reported as a downbeat anyway, with confidence saying how much to
      // trust it — §12: never a boolean.
      out.push({ ...beatEvent(i, t, slot), confidence: this.confidence });
    }

    for (const e of this.onsets) {
      if (e.time >= a && e.time < b) out.push(e);
    }

    out.sort((x, y) => x.time - y.time);
    return out;
  }

  get horizonSec(): number {
    if (this.secPerBeat <= 0) return 0;
    return this.secPerBeat * (SLOTS_PER_BAR / SLOTS_PER_BEAT) * TIER_B_HORIZON_BARS;
  }

  get confidence(): number {
    return this.tracker.locked ? this.tracker.confidence : 0;
  }
}

/** Beat or downbeat, decided by position in the bar. Shared by both tiers. */
function beatEvent(beatIndex: number, time: number, slot: number): TimelineEvent {
  const inBar = ((beatIndex % 4) + 4) % 4;
  // 'bar' is deliberately never emitted. A downbeat and a bar boundary are the
  // same instant, and two events at one time means every consumer has to
  // de-duplicate or fire twice. 'downbeat' carries the information.
  return { time, slot, kind: inBar === 0 ? 'downbeat' : 'beat' };
}

// ---------------------------------------------------------------------------
// Scheduler (§4.3)
// ---------------------------------------------------------------------------

/** What one layer wants from the grid. Stable for the life of the preset. */
export interface ScheduleRequest {
  /** Stable per layer — `LayerSpec.id`, never the array index. Keys the fire state and the probability hash. */
  readonly key: string;
  readonly trigger: TriggerSpec;
  readonly anchor: Anchor;
  readonly envelope: Envelope;
  /** 0..2/3, continuous, clamped. Delays every second subdivision (§4.4). */
  readonly swing?: number;
  /** Preset seed, so probability is reproducible across runs (§4.7). */
  readonly seed?: number;
}

/** One event that is due to fire on this poll. */
export interface FiredEvent {
  readonly key: string;
  readonly division: DivisionName;
  readonly anchor: Anchor;
  /** Tick index on this division since slot 0. Monotonic; the Euclidean step derives from it. */
  readonly tick: number;
  /** Grid position of the event. Fractional when swung. */
  readonly slot: number;
  /** Audio-clock time the event LANDS — the beat itself, not the fire time. */
  readonly time: number;
  /** `time - lead`. Always <= the `now` passed to `due()`. */
  readonly fireTime: number;
  /** How late this poll is against the ideal fire time. Frame quantisation, mostly. Debug only. */
  readonly lateBy: number;
}

/** Backstop against a wild tempo estimate turning one frame into a burst. */
const MAX_PER_POLL = 32;
/** Further behind than this and we skip rather than catch up — see `due()`. */
const MAX_CATCHUP_TICKS = 256;

/**
 * The look-ahead scheduler.
 *
 * Reacting is always late: onset -> detect (>= 1 frame) -> attack (200 ms) ->
 * visual peak ~250 ms after the transient, which at 128 BPM is over half a beat.
 * No amount of detection tuning fixes that, so instead we look ahead and fire
 * early by exactly the amount the effect needs:
 *
 *     t_fire = t_event - anchorOffset - outputLatency - userOffset.audio
 *
 * `anchorOffset` comes from the layer's anchor and envelope IN BEATS and is
 * converted to seconds at the local tempo, so a preset transposes to any tempo
 * unchanged. `outputLatency` and the user offsets are wall-clock seconds and do
 * not scale with tempo — keeping the two domains separate until the last
 * addition is the whole reason `anchorLeadBeats` lives in `contracts.ts` and
 * returns beats.
 *
 * Supersedes the crude `Scheduler` in `clock.ts`, which knows about
 * `TempoTracker` directly and therefore cannot see a Tier A timeline at all.
 */
export class Scheduler {
  /**
   * Real hardware/OS output latency. Read `ctx.outputLatency` EVERY frame and
   * assign it here — it is 5–40 ms typically, much worse on Bluetooth, and it
   * changes at runtime when the output device does (§4.6).
   */
  outputLatency = 0;
  /** The persisted audio offset of §3.1's three. Video and input offsets are not this module's business. */
  userAudioOffset = 0;

  /** Last tick fired per request key. `undefined` means "not primed yet". */
  private lastTick = new Map<string, number>();

  /**
   * Flush all scheduled state (§4.10).
   *
   * Called on seek, on track change, and whenever the Timeline instance is
   * swapped (Tier B -> Tier A). Not called on pause: pause stops polling, and
   * resume must not replay the events it missed, which is exactly what the
   * priming behaviour in `due()` gives us for free.
   */
  reset(key?: string): void {
    if (key === undefined) this.lastTick.clear();
    else this.lastTick.delete(key);
  }

  /**
   * Events for `req` whose fire time has arrived at `now`.
   *
   * Contract, and each clause is there because breaking it is a real failure
   * mode seen in this kind of code:
   *
   *  - Never returns the same tick twice, even if `now` goes backwards slightly
   *    or the timeline re-anchors. State is a tick INDEX, not a time.
   *  - Never skips a tick between two polls: the window is [lastTick+1, due],
   *    not "whatever is closest to now", so a long frame emits the backlog
   *    rather than dropping it.
   *  - Survives a tempo change: ticks are grid positions and the grid is
   *    continuous through a tempo change by construction (§4.10). Only the
   *    seconds-per-slot conversion moves.
   *  - After `reset()` the first poll fires NOTHING. It primes the tick cursor
   *    at the current position, which is what makes a seek land cleanly instead
   *    of dumping the whole gap into one frame.
   */
  due(timeline: Timeline, now: number, req: ScheduleRequest): FiredEvent[] {
    const out: FiredEvent[] = [];

    const bpm = timeline.bpm(now);
    if (!(bpm > 0)) return out;

    const stride = DIVISION_SLOTS[req.trigger.division];
    const secPerSlot = secondsPerSlot(bpm);
    const lead =
      anchorLeadBeats(req.anchor, req.envelope) * (60 / bpm) +
      this.outputLatency +
      this.userAudioOffset;

    // The straight (unswung) horizon: an event later than this cannot be due,
    // because swing only ever delays. Scanning to here is a safe superset.
    const horizonSlot = timeline.slotAt(now + lead);
    const dueTick = Math.floor(horizonSlot / stride);

    const primed = this.lastTick.get(req.key);
    if (primed === undefined) {
      this.lastTick.set(req.key, dueTick);
      return out;
    }

    // A gap this large means a seek nobody told us about, a stalled tab, or a
    // tempo estimate that jumped. Firing 4000 queued events into one frame is
    // never the right answer — snap the cursor and carry on.
    let cursor = primed;
    if (dueTick - cursor > MAX_CATCHUP_TICKS) cursor = dueTick - 1;

    const seed = req.seed ?? 0;
    const keyHash = hashString(req.key) ^ seed;
    const swing = req.swing ?? 0;

    for (let tick = cursor + 1; tick <= dueTick; tick++) {
      const slot = tick * stride + swingSlots(swing, stride, tick);
      const time = solveTime(timeline, slot, now, secPerSlot);
      const fireTime = time - lead;
      // Swing pushed this one past the horizon. Stop WITHOUT advancing the
      // cursor, so it fires on a later poll rather than being lost.
      if (fireTime > now) break;

      this.lastTick.set(req.key, tick);

      if (!euclidAllows(req.trigger, tick)) continue;
      if (req.trigger.probability < 1 && hash2(keyHash, tick) >= req.trigger.probability) continue;

      out.push({
        key: req.key,
        division: req.trigger.division,
        anchor: req.anchor,
        tick,
        slot,
        time,
        fireTime,
        lateBy: now - fireTime,
      });
      if (out.length >= MAX_PER_POLL) break;
    }

    return out;
  }

  /**
   * Content-dependent and structural events over the same poll window
   * (§4.3) — onsets, sections, drops. Grid events are excluded because `due()`
   * already produces those from the division, and emitting both would fire every
   * beat twice.
   *
   * `from` is the previous poll's `now`; the window is half-open, matching
   * `Timeline.eventsBetween`, so nothing is seen twice and nothing falls between
   * two frames.
   */
  content(timeline: Timeline, from: number, now: number): TimelineEvent[] {
    if (!(now > from)) return [];
    return timeline
      .eventsBetween(from, now)
      .filter((e) => e.kind !== 'beat' && e.kind !== 'downbeat' && e.kind !== 'bar' && e.kind !== 'division');
  }
}

/**
 * Invert `Timeline.slotAt` — the time at which the grid reaches `slot`.
 *
 * The Timeline interface deliberately has no `timeAtSlot`, because adding one
 * would mean both tiers implement an inverse and one of them would eventually
 * disagree with its own forward mapping. Instead we solve numerically against
 * the forward map, which cannot diverge from itself.
 *
 * Two Newton steps are enough and usually one is: `slotAt` is piecewise linear
 * in both implementations, so a step lands exactly whenever the guess is already
 * in the right segment, and a look-ahead of a beat or two is almost never more
 * than one segment away.
 */
function solveTime(timeline: Timeline, slot: number, near: number, secPerSlot: number): number {
  let t = near + (slot - timeline.slotAt(near)) * secPerSlot;
  for (let i = 0; i < 2; i++) {
    const err = slot - timeline.slotAt(t);
    if (Math.abs(err) < 1e-6) break;
    const bpm = timeline.bpm(t);
    t += err * (bpm > 0 ? secondsPerSlot(bpm) : secPerSlot);
  }
  return t;
}

// ---------------------------------------------------------------------------
// Musical LFOs (§4.4)
// ---------------------------------------------------------------------------

/**
 * A sine at a musical rate — "/8 modulating warp amount" is a locked two-bar
 * breath, not a free-running oscillator that beats against the track.
 *
 * Phase is derived from the slot position rather than accumulated, so it is
 * correct immediately after a seek with no state to reset (§4.10), and it is
 * reproducible for the golden-image harness (§4.7).
 *
 * `phraseBars` supports §4.4's odd cycle lengths: 5 or 7 bars phases against 4/4
 * and re-aligns every 5 or 7 bars.
 */
export function lfoPhase(timeline: Timeline, atSec: number, phraseBars: number): number {
  const period = SLOTS_PER_BAR * Math.max(1e-6, phraseBars);
  const slot = timeline.slotAt(atSec);
  return (((slot / period) % 1) + 1) % 1;
}

/** Unit sine on a musical cycle, -1..1. */
export function lfoSine(timeline: Timeline, atSec: number, phraseBars: number): number {
  return Math.sin(lfoPhase(timeline, atSec, phraseBars) * Math.PI * 2);
}
