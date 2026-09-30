import type { ClockGrid, HudNamedInterval, HudTempo, HudTrack, IntervalSignals, TimingSignals } from '../mpc-timing-types.ts';
import { BEAT_EPS, compileClockGrid, compileGrid, timingSignals, type BeatGrid } from '../mpc-beat-grid.ts';
import { parseTimeRef, type HudEventSpec, type HudIntervalDecl, type HudTimeRef } from './hud-manifest.ts';
export type { ClockGrid as HudClockGrid, HudNamedInterval, HudTempo, HudTrack, IntervalSignals, TimingSignals } from '../mpc-timing-types.ts';

/** HUD clock: the pure timing a HUD scene sees (docs/design/HUD-PACK-ENGINE.md sections 3.5 and 3.6; CONTRACT.md 2.3.9).
 * Everything here is a closed-form function of (media time, scene interval, beat grid, manifest): no `Date.now`, no `Math.random`, no history,
 * so a seek, a pause and a repeat reproduce the same values. Live audio never enters this module.
 * The host fills `HudTimingInput`; the worker calls `deriveHudTiming` once per frame.
 * Status: integrated and CPU-checked (tools/check-hud-clock.mjs); live timing acceptance remains separate. */
/** Same tolerance as the shared beat grid (`BEAT_EPS`), in beats. */
export const HUD_BEAT_EPS = BEAT_EPS;
/** Cycle length in bars when the scene end is unknown (manifest `timing.freeBars` overrides). */
export const HUD_FREE_BARS = 8;
/** Tempo used when neither a saved grid nor a locked live tempo exists. */
export const HUD_FALLBACK_BPM = 120;
/** The live tracker and the fallback grid have no true downbeat, so they count fixed bars of four beats. */
export const HUD_LIVE_BEATS_PER_BAR = 4;
/** `clock.sweep`: seconds per free-running sweep cycle. An authored default, replaceable when sourced values exist. */
export const HUD_SWEEP_SECONDS = 8;
/** Event `pulse` decay constant in seconds (section 3.6). */
export const HUD_EVENT_TAU = 0.25;
/** Value of an event's `since` and `next` when there is no such event (also the cap), in seconds. */
export const HUD_EVENT_FAR = 60;
const MAX_TIME = 1e9;
const MAX_NAMED = 64;

export type HudClockSource = 'scene-clock' | 'tempo' | 'fallback';

// ---------------------------------------------------------------------------------------------------------------- beat clock
/** Beat clock with the same semantics as the shared beat grid: beat 0 at `offset`, `beatAt` is 0 before it, `timeAt` is its inverse. */
export interface HudClock {
  readonly source: HudClockSource;
  readonly beatsPerBar: number;
  /** True when the tempo never changes. */
  readonly constant: boolean;
  beatAt(t: number): number;
  timeAt(beat: number): number;
  bpmAt(t: number): number;
}
const fin = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** A grid is usable when its numbers are finite and in the ranges the scene clock accepts. The worker rejects an invalid grid; the pure functions here treat it as absent. */
export function validHudGrid(g: unknown): g is ClockGrid {
  if (!isObject(g)) return false;
  const { offset, bpm, beatsPerBar, changes } = g;
  if (typeof offset !== 'number' || !Number.isFinite(offset) || Math.abs(offset) > 1e7) return false;
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm < 20 || bpm > 400) return false;
  if (typeof beatsPerBar !== 'number' || !Number.isInteger(beatsPerBar) || beatsPerBar < 1 || beatsPerBar > 16) return false;
  if (changes === undefined) return true;
  if (!Array.isArray(changes) || changes.length > 256) return false;
  let previous = offset;
  for (const pair of changes) {
    if (!Array.isArray(pair) || pair.length !== 2) return false;
    const [at, r] = pair as [unknown, unknown];
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= previous || at > 1e7 || typeof r !== 'number' || !Number.isFinite(r) || r < 20 || r > 400) return false;
    previous = at;
  }
  return true;
}

function adapt(source: HudClockSource, grid: BeatGrid, beatsPerBar: number): HudClock {
  return { source, beatsPerBar, constant: grid.constant, beatAt: t => grid.beatAt(t), timeAt: b => grid.timeAt(b), bpmAt: t => grid.bpmAt(t) };
}
let gridMemo: { grid: BeatGrid; beatsPerBar: number; clock: HudClock } | null = null;
/** The shared beat grid as a HUD clock; null for a malformed wire grid. The shared compiler caches the last grid, and so does this adapter. */
export function hudGridClock(grid: ClockGrid): HudClock | null {
  const compiled = compileClockGrid(grid);
  if (!compiled) return null;
  const m = gridMemo;
  if (m && m.grid === compiled && m.beatsPerBar === grid.beatsPerBar) return m.clock;
  const clock = adapt('scene-clock', compiled, grid.beatsPerBar);
  gridMemo = { grid: compiled, beatsPerBar: grid.beatsPerBar, clock };
  return clock;
}
let linearMemo: { source: HudClockSource; start: number; bpm: number; clock: HudClock } | null = null;
/** Constant-tempo clock with beat 0 at the scene start (live tracker and fallback), built on the shared grid compiler. */
export function hudLinearClock(source: 'tempo' | 'fallback', start: number, bpm: number): HudClock {
  const m = linearMemo;
  if (m && m.source === source && m.start === start && m.bpm === bpm) return m.clock;
  const clock = adapt(source, compileGrid(bpm, start), HUD_LIVE_BEATS_PER_BAR);
  linearMemo = { source, start, bpm, clock };
  return clock;
}

// ---------------------------------------------------------------------------------------------------------------- timing derivation
export interface HudTimingInput {
  readonly time: number;
  readonly grid: ClockGrid | null;
  readonly sceneStart: number;
  readonly sceneEnd: number | null;
  readonly tempo: HudTempo | null;
  /** The setup's named intervals resolved to seconds. Pass every one of them (`SceneClock.intervals`), not only the running ones (`activeIntervals`): an interval outside its
   * window reads as not started (progress 0, full remaining) or finished (progress 1, remaining 0), both `known`, and only an id that is absent from this list falls back to the
   * manifest's declared default (`HudTimingOptions.declared`). Passing only the running ones lets the declared default shadow a saved interval between its windows. */
  readonly named?: readonly HudNamedInterval[];
  readonly track: HudTrack;
}
/** A time span with progress and bar counts. When `known` is false the numbers describe the authored free cycle (`freeBars` bars), never a real deadline. */
export interface HudSpan {
  readonly known: boolean; readonly duration: number; readonly elapsed: number; readonly progress: number; readonly remaining: number;
  readonly totalBars: number; readonly elapsedBars: number; readonly remainingBars: number; readonly freePhase: number;
}
export interface HudBeat {
  /** Beats since the clock origin (saved grid), the live tracker's index plus phase, or beats since the scene start (fallback). */
  readonly pos: number;
  /** Beats since the scene start, 0 before it. */
  readonly scenePos: number;
  /** `scenePos` wrapped by the free cycle when the scene end is unknown; equal to `scenePos` otherwise. Event schedules key off this. */
  readonly cyclePos: number;
  readonly phase: number; readonly inBar: number; readonly barPos: number; readonly barPhase: number; readonly barIndex: number;
  readonly beatsPerBar: number; readonly bpm: number; readonly source: HudClockSource;
}
export interface HudTiming {
  readonly time: number; readonly localTime: number;
  /** Seconds past the scene end (an outgoing scene during a fade), else 0. */
  readonly overrun: number;
  readonly sceneStart: number; readonly sceneEnd: number | null;
  /** The scene interval, or its authored free cycle when the end is unknown. */
  readonly scene: HudSpan;
  /** Named intervals by id: host-resolved ones, then the manifest's declared defaults. Read with `Object.hasOwn`. An unresolved id is an unknown span (`known` false). */
  readonly named: Readonly<Record<string, HudSpan>>;
  readonly beat: HudBeat;
  readonly track: { readonly position: number; readonly duration: number | null; readonly progress: number; readonly remaining: number; readonly known: boolean };
  /** Free-cycle length in bars. */
  readonly freeBars: number;
  /** Clock beat at the scene start, and the scene's length in beats (the free cycle's length when the end is unknown). */
  readonly sceneBeatStart: number; readonly sceneBeats: number;
  readonly clock: HudClock;
}
export interface HudTimingOptions {
  /** The manifest's `intervals`: authored defaults used for an id the host did not resolve. */
  readonly declared?: Readonly<Record<string, HudIntervalDecl>>;
}

const modulo = (x: number, m: number): number => { const r = x - Math.floor(x / m) * m; return r < 0 || r >= m ? 0 : r; };
function freeSpan(cyclePos: number, freeBars: number, bpb: number, bpm: number): HudSpan {
  const total = freeBars * bpb, phase = clamp(cyclePos / total, 0, 1), duration = total * 60 / bpm;
  return { known: false, duration, elapsed: phase * duration, progress: phase, remaining: duration - phase * duration, totalBars: freeBars, elapsedBars: cyclePos / bpb,
    remainingBars: Math.max(0, Math.ceil(freeBars - cyclePos / bpb - 1e-9)), freePhase: phase };
}
/** `shared` is the shared clock's interval signals for the same span; when given, progress and remaining are taken from it so the two can never disagree.
 * Before the span starts (a preloaded scene, a count-in) the scene has not begun: progress and elapsed are 0 and `remaining` is the full duration, never more. */
function knownSpan(time: number, a: number, b: number, clock: HudClock, freePhase: number, shared: IntervalSignals | null = null): HudSpan {
  const bpb = clock.beatsPerBar, duration = b - a, at = clamp(time, a, b);
  const startBeat = clock.beatAt(a), endBeat = clock.beatAt(b), nowBeat = clock.beatAt(at);
  return { known: true, duration, elapsed: at - a, progress: shared ? shared.progress : time <= a ? 0 : time >= b ? 1 : (time - a) / duration,
    remaining: Math.min(duration, shared ? shared.remaining : Math.max(0, b - time)),
    totalBars: (endBeat - startBeat) / bpb, elapsedBars: (nowBeat - startBeat) / bpb, remainingBars: Math.max(0, Math.ceil((endBeat - nowBeat) / bpb - 1e-9)), freePhase };
}
interface RefContext { readonly clock: HudClock; readonly sceneBeatStart: number; readonly sceneBeats: number; readonly known: boolean }
/** Scene-relative beat of a reference (the anchor beats plus a signed offset). Seconds offsets go through the clock so tempo maps stay exact. */
function refBeat(p: HudTimeRef, x: RefContext): number {
  const base = p.anchor === 's' ? 0 : p.anchor === 'e' ? x.sceneBeats : p.frac * x.sceneBeats;
  if (p.anchor === 'f') return base;
  if (p.unit === 'b') return base + p.offset * x.clock.beatsPerBar;
  return x.clock.beatAt(x.clock.timeAt(x.sceneBeatStart + base) + p.offset) - x.sceneBeatStart;
}
function refSeconds(p: HudTimeRef, x: RefContext): number | null {
  if ((p.anchor === 'e' || p.anchor === 'f') && !x.known) return null;
  const base = p.anchor === 's' ? 0 : p.anchor === 'e' ? x.sceneBeats : p.frac * x.sceneBeats;
  if (p.anchor === 'f' || p.unit === 'b') return x.clock.timeAt(x.sceneBeatStart + refBeat(p, x));
  return x.clock.timeAt(x.sceneBeatStart + base) + p.offset;
}
const contextOf = (t: HudTiming): RefContext => ({ clock: t.clock, sceneBeatStart: t.sceneBeatStart, sceneBeats: t.sceneBeats, known: t.scene.known });

/** Derive everything a HUD scene needs from the host's numbers. Total: bad input (NaN, infinities, an invalid grid) selects the documented fallback and never throws.
 * `freeBars` is the manifest's `timing.freeBars`. */
export function deriveHudTiming(input: HudTimingInput, freeBars: number, options: HudTimingOptions = {}): HudTiming {
  const fb = Number.isFinite(freeBars) ? clamp(Math.round(freeBars), 1, 32) : HUD_FREE_BARS;
  const time = clamp(fin(input.time, 0), -MAX_TIME, MAX_TIME), start = clamp(fin(input.sceneStart, 0), -MAX_TIME, MAX_TIME);
  const endRaw = input.sceneEnd;
  const end = typeof endRaw === 'number' && Number.isFinite(endRaw) && endRaw > start && endRaw <= MAX_TIME ? endRaw : null;
  const gridClock = input.grid ? hudGridClock(input.grid) : null, grid = gridClock ? input.grid : null;
  const t = input.tempo;
  const tempo = !gridClock && isObject(t) && t.locked === true && typeof t.bpm === 'number' && Number.isFinite(t.bpm) && t.bpm >= 20 && t.bpm <= 400 ? t : null;
  const clock = gridClock ?? (tempo ? hudLinearClock('tempo', start, tempo.bpm) : hudLinearClock('fallback', start, HUD_FALLBACK_BPM));
  const bpb = clock.beatsPerBar, localTime = Math.max(0, time - start);
  const sceneBeatStart = clock.beatAt(start), known = end !== null;
  const freeBeats = fb * bpb;

  // beat block: a saved grid composes the shared signals; the live tempo and the fallback add only what those lack
  let beat: Omit<HudBeat, 'cyclePos'>, scenePos: number, shared: TimingSignals | null = null;
  if (grid) {
    const s = shared = timingSignals(time, grid, start, end, { bpm: grid.bpm, localTime });
    scenePos = s.sceneBeat;
    beat = { pos: s.beat, scenePos, phase: s.beatPhase, inBar: s.beatInBar, barPos: s.bar + s.barPhase, barPhase: s.barPhase, barIndex: s.bar, beatsPerBar: bpb, bpm: clock.bpmAt(time), source: 'scene-clock' };
  } else if (tempo) {
    const index = Math.floor(fin(tempo.beatIndex, 0)), phase = clamp(fin(tempo.beatPhase, 0), 0, 1);
    const inBar = ((index % bpb) + bpb) % bpb;
    scenePos = clock.beatAt(time);
    beat = { pos: index + phase, scenePos, phase, inBar, barPos: Math.floor(index / bpb) + (inBar + phase) / bpb, barPhase: (inBar + phase) / bpb, barIndex: Math.floor(index / bpb), beatsPerBar: bpb, bpm: tempo.bpm, source: 'tempo' };
  } else {
    scenePos = clock.beatAt(time);
    const whole = Math.floor(scenePos + HUD_BEAT_EPS), phase = clamp(scenePos - whole, 0, 1), barIndex = Math.floor(whole / bpb), inBar = whole - barIndex * bpb;
    beat = { pos: scenePos, scenePos, phase, inBar, barPos: barIndex + (inBar + phase) / bpb, barPhase: clamp((inBar + phase) / bpb, 0, 1), barIndex, beatsPerBar: bpb, bpm: HUD_FALLBACK_BPM, source: 'fallback' };
  }
  const sceneBeats = known ? clock.beatAt(end) - sceneBeatStart : freeBeats;
  const cyclePos = known ? scenePos : modulo(scenePos, freeBeats);
  const freePhase = clamp(modulo(scenePos, freeBeats) / freeBeats, 0, 1);
  const scene = known ? knownSpan(time, start, end, clock, freePhase, shared?.interval ?? null) : freeSpan(modulo(scenePos, freeBeats), fb, bpb, beat.bpm);

  const tr = isObject(input.track) ? input.track : { position: 0, duration: null };
  const duration = typeof tr.duration === 'number' && Number.isFinite(tr.duration) && tr.duration > 0 ? tr.duration : null;
  const position = Math.max(0, fin(tr.position, 0));
  const track = { position, duration, progress: duration ? clamp(position / duration, 0, 1) : 0, remaining: duration ? Math.max(0, duration - position) : 0, known: duration !== null };

  const timing: HudTiming = {
    time, localTime, overrun: end !== null ? Math.max(0, time - end) : 0, sceneStart: start, sceneEnd: end, scene, named: {},
    beat: { ...beat, cyclePos }, track, freeBars: fb, sceneBeatStart, sceneBeats, clock,
  };
  // named intervals: what the host resolved, then the manifest's declared defaults for the ids it did not
  const named: Record<string, HudSpan> = {};
  const given = new Set<string>();
  const x = contextOf(timing);
  if (Array.isArray(input.named)) {
    for (const n of input.named.slice(0, MAX_NAMED)) {
      if (!isObject(n) || typeof n.id !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(n.id) || n.id === '__proto__') continue;
      const a = fin(n.start, NaN), b = fin(n.end, NaN);
      if (!(b > a)) continue;
      given.add(n.id);
      named[n.id] = knownSpan(time, a, b, clock, freePhase);
    }
  }
  if (options.declared) {
    for (const id of Object.keys(options.declared)) {
      if (given.has(id) || id === '__proto__') continue;
      const d = options.declared[id]!, f = parseTimeRef(d.from), tt = parseTimeRef(d.to);
      const a = f ? refSeconds(f, x) : null, b = tt ? refSeconds(tt, x) : null;
      named[id] = a !== null && b !== null && b > a ? knownSpan(time, a, b, clock, freePhase) : freeSpan(modulo(scenePos, freeBeats), fb, bpb, beat.bpm);
    }
  }
  return { ...timing, named };
}

/** Absolute media seconds of a time reference (`s+2b`, `e-1b`, `e-0`, `s+1.5`, `f0.5`), or null when it cannot be resolved (an end- or fraction-based
 * reference while the scene end is unknown). References before the clock origin clamp to it. */
export function resolveHudTimeRef(ref: string | HudTimeRef, timing: HudTiming): number | null {
  const p = typeof ref === 'string' ? parseTimeRef(ref) : ref;
  return p ? refSeconds(p, contextOf(timing)) : null;
}

/** `ceil(remaining - 1e-9)`: whole seconds a countdown shows; reaches 0 exactly at the scene end at any frame rate. */
export const hudCountdown = (remaining: number): number => Math.max(0, Math.ceil(remaining - 1e-9));

const SPAN_FIELDS = ['progress', 'remaining', 'remaining01', 'elapsed', 'remainingBars', 'elapsedBars', 'totalBars', 'known', 'freePhase'] as const;
function spanValue(s: HudSpan, field: string): number | undefined {
  switch (field) {
    case 'progress': return s.progress;
    case 'remaining': return s.remaining;
    case 'remaining01': return s.duration > 0 ? clamp(s.remaining / s.duration, 0, 1) : 0;
    case 'elapsed': return s.elapsed;
    case 'remainingBars': return s.remainingBars;
    case 'elapsedBars': return s.elapsedBars;
    case 'totalBars': return s.totalBars;
    case 'known': return s.known ? 1 : 0;
    case 'freePhase': return s.freePhase;
    default: return undefined;
  }
}
/** Numeric value of a timing signal (`interval`, `iv`, `clock` or `track` group) so every consumer reads one definition. Undefined for an unknown field, or an `iv` id
 * the timing does not carry (the caller then uses the binding's `fb`). `id` names the interval for the `iv` group. */
export function hudTimingValue(timing: HudTiming, group: 'interval' | 'iv' | 'clock' | 'track', field: string, id?: string): number | undefined {
  switch (group) {
    case 'interval': return field === 'overrun' ? timing.overrun : spanValue(timing.scene, field);
    case 'iv': { const s = id !== undefined && Object.hasOwn(timing.named, id) ? timing.named[id] : undefined; return s ? spanValue(s, field) : undefined; }
    case 'clock': {
      const b = timing.beat;
      switch (field) {
        case 'beatPhase': return b.phase;
        case 'beatInBar': return b.inBar;
        case 'barPhase': return b.barPhase;
        case 'barIndex': return b.barIndex;
        case 'beatPos': return b.pos;
        case 'bpm': return b.bpm;
        case 'sweep': return modulo(timing.localTime, HUD_SWEEP_SECONDS) / HUD_SWEEP_SECONDS;
        default: return undefined;
      }
    }
    case 'track': {
      const k = timing.track;
      switch (field) {
        case 'position': return k.position;
        case 'duration': return k.duration ?? 0;
        case 'progress': return k.progress;
        case 'remaining': return k.remaining;
        case 'known': return k.known ? 1 : 0;
        default: return undefined;
      }
    }
  }
}
export const HUD_SPAN_FIELDS: readonly string[] = SPAN_FIELDS;

// ---------------------------------------------------------------------------------------------------------------- event schedules
/** A planned event set: ascending slot indices and the cumulative weight after each event (the last is exactly 1). */
export interface HudEventPlan { readonly slots: number; readonly at: readonly number[]; readonly cum: readonly number[] }
export interface HudEventValues {
  /** Cumulative weight of the events so far, 0..1, exactly 1 after the last. */ readonly cum: number;
  /** `1 - cum`, exactly 0 after the last event. */ readonly remaining: number;
  readonly count: number;
  /** 1 at an event, decaying with `HUD_EVENT_TAU`. */ readonly pulse: number;
  /** Seconds since the last event, capped at `HUD_EVENT_FAR`. */ readonly since: number;
  /** Seconds until the next event, capped at `HUD_EVENT_FAR`. */ readonly next: number;
}
/** Hash of (seed, k) in [0, 1). Normative for schedules: changing it changes every scene that uses events. */
export function hudHash(seed: number, k: number): number {
  let n = Math.imul((seed ^ 0x9e3779b9) + k * 0x85ebca6b + 1, 0x45d9f3b) >>> 0;
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = (n ^ (n >>> 16)) >>> 0;
  return n / 4294967296;
}
const plans = new Map<string, HudEventPlan>();
/** Stratified, seeded schedule on `slots` grid slots (section 3.6). Split [0, slots) into n strata with boundaries `round(slots * (k/n)^(2^bias))`, take one seeded slot per stratum,
 * drop a slot when fewer than `gap` empty slots separate it from the previous event, weight each kept event `0.6 + 0.8 * hash`, and normalise. Strictly increasing,
 * at most `min(n, slots)` events, `cum` strictly increasing and exactly 1 at the last event. Pure in its arguments. */
export function planHudEvent(spec: Pick<HudEventSpec, 'n' | 'seed' | 'bias' | 'gap'>, slots: number): HudEventPlan {
  const S = Number.isFinite(slots) ? Math.max(0, Math.floor(slots)) : 0, seed = fin(spec.seed, 0) >>> 0, bias = clamp(fin(spec.bias, 0), -1, 1), gap = Math.max(0, Math.floor(fin(spec.gap, 0)));
  const n = Math.min(Math.max(0, Math.floor(fin(spec.n, 0))), S, 64);
  const key = `${S}|${n}|${seed}|${bias}|${gap}`;
  const hit = plans.get(key);
  if (hit) return hit;
  const at: number[] = [], weights: number[] = [];
  if (n > 0) {
    const g = 2 ** bias, edge = (k: number) => Math.round(S * Math.pow(k / n, g));
    let last = -1e9;
    for (let k = 0; k < n; k++) {
      const lo = edge(k), hi = Math.max(lo + 1, edge(k + 1)), s = Math.min(S - 1, lo + Math.floor(hudHash(seed, k) * (hi - lo)));
      if (s - last > gap) { at.push(s); weights.push(0.6 + 0.8 * hudHash(seed, 1000 + k)); last = s; }
    }
  }
  const total = weights.reduce((a, w) => a + w, 0), cum: number[] = [];
  let run = 0;
  for (const w of weights) { run += w; cum.push(run / total); }
  const plan: HudEventPlan = Object.freeze({ slots: S, at: Object.freeze(at), cum: Object.freeze(cum) });
  if (plans.size >= 256) plans.clear();
  plans.set(key, plan);
  return plan;
}
const unitBeats = (on: HudEventSpec['on'], bpb: number): number => (on === 'beat' ? 1 : on === 'bar' ? bpb : bpb / 2);
/** The event window in scene-relative beats: where slot 0 begins, the slot length and the slot count. `from`/`to` default to the whole scene (or free cycle). */
export function hudEventWindow(spec: Pick<HudEventSpec, 'on' | 'from' | 'to'>, timing: HudTiming): { start: number; unit: number; slots: number } {
  const x = contextOf(timing), unit = unitBeats(spec.on, timing.beat.beatsPerBar), total = timing.sceneBeats;
  const pf = spec.from ? parseTimeRef(spec.from) : null, pt = spec.to ? parseTimeRef(spec.to) : null;
  const from = clamp(pf ? refBeat(pf, x) : 0, 0, total), to = clamp(pt ? refBeat(pt, x) : total, 0, total);
  return { start: from, unit, slots: to > from ? Math.max(1, Math.floor((to - from) / unit + HUD_BEAT_EPS)) : 0 };
}
/** Values of one event set at `timing`. Independent of evaluation order: a seek shows the same values a continuous run would. */
export function evalHudEvent(spec: HudEventSpec, timing: HudTiming): HudEventValues {
  const w = hudEventWindow(spec, timing), plan = planHudEvent(spec, w.slots);
  const x = (timing.beat.cyclePos - w.start) / w.unit, whole = Math.floor(x + HUD_BEAT_EPS);
  let lo = 0, hi = plan.at.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (plan.at[mid]! <= whole) lo = mid + 1; else hi = mid; }
  const count = lo, secondsPerSlot = w.unit * 60 / timing.beat.bpm;
  const cum = count ? plan.cum[count - 1]! : 0;
  // Constant clocks retain their original arithmetic. Across tempo steps seconds must come from the inverse grid, not the
  // instantaneous BPM. A free schedule repeats on its current cycle's absolute beat origin, even after a distant seek.
  const cycleOrigin = timing.beat.scenePos - timing.beat.cyclePos;
  const eventTime = (slot: number): number => timing.clock.timeAt(timing.sceneBeatStart + cycleOrigin + w.start + slot * w.unit);
  const since = count ? Math.min(HUD_EVENT_FAR, Math.max(0, timing.clock.constant ? (x - plan.at[count - 1]!) * secondsPerSlot : timing.time - eventTime(plan.at[count - 1]!))) : HUD_EVENT_FAR;
  const next = count < plan.at.length ? Math.min(HUD_EVENT_FAR, Math.max(0, timing.clock.constant ? (plan.at[count]! - x) * secondsPerSlot : eventTime(plan.at[count]!) - timing.time)) : HUD_EVENT_FAR;
  return { cum, remaining: 1 - cum, count, pulse: count && since < HUD_EVENT_FAR ? Math.exp(-since / HUD_EVENT_TAU) : 0, since, next };
}
/** Values of every declared event set. Keys are the manifest's event ids. */
export function evalHudEvents(events: Readonly<Record<string, HudEventSpec>> | undefined, timing: HudTiming): Record<string, HudEventValues> {
  const out: Record<string, HudEventValues> = {};
  if (events) for (const id of Object.keys(events)) if (id !== '__proto__') out[id] = evalHudEvent(events[id]!, timing);
  return out;
}
/** Read a field of an event set's values by the signal field name (`cum`, `remaining`, `count`, `pulse`, `since`, `next`). */
export function hudEventField(values: HudEventValues, field: string): number | undefined {
  switch (field) {
    case 'cum': return values.cum;
    case 'remaining': return values.remaining;
    case 'count': return values.count;
    case 'pulse': return values.pulse;
    case 'since': return values.since;
    case 'next': return values.next;
    default: return undefined;
  }
}
