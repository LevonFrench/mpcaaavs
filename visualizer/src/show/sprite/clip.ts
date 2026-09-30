// Clip timing for the sprite layer (docs/design/SPRITE-SHOW-KIT.md, "Choreography grammar", retiming rules).
//
// A pack's clips hold each frame for a number of source frames, i.e. ticks of the game's 60 Hz clock (TICK_RATE). Two kinds of
// playback, both pure functions of media time so a seek lands on the same frame as playing through:
//
//  - loops (idle, walk, run, hover) retime to beat multiples: one turn of the loop lasts a whole number of beats and its phase is
//    read from the beat grid (beat index, not seconds), so it stays locked through tempo changes and seeks;
//  - one-shots (attacks, specials, deaths) keep their native tick timing; only their start moves. Their `big` frame (the release,
//    the impact, the flash) is placed on a musical event by starting the clip `bigTick / 60` s earlier (look-ahead);
//  - hitstop freezes a one-shot for 4-12 ticks at its big frame, scaled by the onset's strength. The freeze stretches the clip
//    after the big frame; it never moves the big frame itself.
import { clipFrameIndex } from '../../asset-packs/pack.ts';

/** Source-frame clock of the packs (ticks per second). */
export const TICK_RATE = 60;
export const TICK = 1 / TICK_RATE;
export const HITSTOP_MIN_TICKS = 4;
export const HITSTOP_MAX_TICKS = 12;
/** Float slack when turning seconds into ticks, so a frame that is due exactly at t shows at t. */
const EPS = 1e-6;

export interface ClipTiming {
  /** Ticks each frame is shown. */
  readonly hold: readonly number[];
  readonly loop: boolean;
  /** Frame indices where the release, impact or flash lands. */
  readonly big: readonly number[];
}

export interface Hitstop { readonly t: number; readonly ticks: number }

export const clipTotalTicks = (hold: readonly number[]): number => { let n = 0; for (const h of hold) n += h; return n; };

/** Tick at which frame `index` starts. */
export function frameStartTick(hold: readonly number[], index: number): number {
  let n = 0;
  for (let i = 0; i < index && i < hold.length; i++) n += hold[i]!;
  return n;
}

/** Index of the frame an event should land on: the clip's first `big` frame; a one-shot without one uses its middle frame, a loop its first. */
export function bigFrameIndex(timing: ClipTiming): number {
  if (timing.big.length) return timing.big[0]!;
  return timing.loop ? 0 : Math.floor((timing.hold.length - 1) / 2);
}

/** Ticks from the clip's start to its big frame. */
export const bigTick = (timing: ClipTiming): number => frameStartTick(timing.hold, bigFrameIndex(timing));

/** Hitstop length in ticks for an onset strength 0..1: 4 for a ghost note, 12 for the hardest hit. */
export function hitstopTicks(strength: number): number {
  const s = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 0;
  return Math.min(HITSTOP_MAX_TICKS, Math.max(HITSTOP_MIN_TICKS, Math.round(HITSTOP_MIN_TICKS + (HITSTOP_MAX_TICKS - HITSTOP_MIN_TICKS) * s)));
}

/** Whole beats one turn of a loop lasts: its native length in beats, rounded to the nearest whole beat (at least 1, at most `max`). */
export function loopBeats(totalTicks: number, beatSeconds: number, max = 16): number {
  const native = totalTicks / TICK_RATE / Math.max(1e-3, beatSeconds);
  return Math.min(max, Math.max(1, Math.round(native)));
}

/** Frame of a loop at continuous beat index `beat`, given the beat it started on and its length in whole beats. */
export function loopFrame(hold: readonly number[], beatsPerLoop: number, startBeat: number, beat: number): number {
  const total = clipTotalTicks(hold);
  const x = (beat - startBeat) / beatsPerLoop;
  const phase = x - Math.floor(x);
  return clipFrameIndex(hold, true, Math.min(total - 1e-9, phase * total));
}

/** Seconds of [start, t] spent frozen by hitstops (each freeze lasts ticks / 60 s from its time). */
export function frozenSeconds(hitstops: readonly Hitstop[], t: number): number {
  let f = 0;
  for (const h of hitstops) { const d = h.ticks * TICK; f += Math.min(d, Math.max(0, t - h.t)); }
  return f;
}

/** Native ticks a one-shot that started at `start` has played at time t (frozen time excluded). Negative before the start. */
export function oneShotTicks(start: number, hitstops: readonly Hitstop[], t: number): number {
  return (t - start - frozenSeconds(hitstops, t)) * TICK_RATE;
}

/** Frame of a one-shot at time t: native timing from `start`, frozen during its hitstops; the last frame is held. */
export function oneShotFrame(timing: ClipTiming, start: number, hitstops: readonly Hitstop[], t: number): number {
  return clipFrameIndex(timing.hold, false, Math.max(0, oneShotTicks(start, hitstops, t) + EPS));
}

/** Clip start time that puts the big frame at `eventTime`. */
export const startForEvent = (timing: ClipTiming, eventTime: number): number => eventTime - bigTick(timing) * TICK;

/** Time the big frame first shows for a one-shot that started at `start`. */
export const bigFrameTime = (timing: ClipTiming, start: number): number => start + bigTick(timing) * TICK;

/** Seconds a one-shot lasts including its hitstops. */
export const oneShotDuration = (timing: ClipTiming, hitstops: readonly Hitstop[]): number =>
  clipTotalTicks(timing.hold) * TICK + hitstops.reduce((n, h) => n + h.ticks * TICK, 0);

/** The sample time that shows what 60 Hz video frame `k` would show (frames are displayed at k / 60). */
export const videoFrameTime = (k: number): number => k * TICK;
