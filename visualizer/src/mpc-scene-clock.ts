/** Saved musical clock. It never follows the live tempo detector or wall time.
 * v1 keys: enabled, bpm, offsetSeconds, barsPerScene, seed. v2 (docs/design/TIMING-SYSTEM-V2.md 5.2, CONTRACT 2.2.2) adds optional
 * beatsPerBar, barsPattern (+patternHold), tempoMap, script and intervals. Defaults are omitted and `version: 2` is written only
 * when a v2 field is present, so a v1 timing round-trips as exactly its five keys.
 */
import { BEAT_EPS, compileGrid, compilePattern, type BeatGrid, type ClockGrid, type ScenePattern, type TempoChange } from './mpc-beat-grid.ts';
import type { HudNamedInterval } from './mpc-timing-types.ts';
import { pickFade, planFade, type ConcreteFade, type FadeAnchor, type FadeSpec } from './mpc-transition-timing.ts';
export type { TempoChange } from './mpc-beat-grid.ts';

/** A cue authored into the timing itself: at scene ordinal `ordinal`, play the preset with this sha256. Resolved to a catalog index by the host. */
export interface ScriptedCue { readonly ordinal: number; readonly preset: string }
/** A named span in clock beats (since the offset) that HUD counters can bind to independently of scene length. */
export interface NamedInterval { readonly id: string; readonly startBeat: number; readonly endBeat: number }
export interface SceneTiming {
  enabled: boolean;
  bpm: number;
  offsetSeconds: number;
  barsPerScene: number;
  seed: number;
  /** v2. Written as 2 whenever any field below is present. */
  version?: 2;
  beatsPerBar?: number;
  barsPattern?: readonly number[];
  patternHold?: boolean;
  tempoMap?: readonly TempoChange[];
  script?: readonly ScriptedCue[];
  intervals?: readonly NamedInterval[];
}
export interface ScenePhase {
  index: number;
  previousIndex: number;
  ordinal: number;
  start: number;
  localTime: number;
  progress: number;
  duration: number;
}
/** A manual choice recorded on the musical timeline for this playback session. */
export interface SessionSceneCue {
  ordinal: number;
  index: number;
}
export const MAX_SCENE_CUES = 1024;
export const MAX_TEMPO_MAP = 256, MAX_SCRIPT = 1024, MAX_INTERVALS = 64, MAX_BARS_PATTERN = 64;
export const defaultSceneTiming: Readonly<SceneTiming> = Object.freeze({ enabled: false, bpm: 120, offsetSeconds: 0, barsPerScene: 8, seed: 1 });

const V1_MESSAGE = 'Scene timing requires 20–400 BPM, an offset from −3600 to 3600 seconds, 1–128 bars and a whole-number seed from 0 to 4294967295.';
const isInt = (value: unknown, low: number, high: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high;
const HASH = /^[0-9a-f]{64}$/, INTERVAL_ID = /^[a-z0-9_-]{1,32}$/;

/** Omitted timing keeps pre-timeline setup files compatible. Supplied timing is strict. */
export function parseSceneTiming(value: unknown): SceneTiming {
  if (value === undefined) return { ...defaultSceneTiming };
  if (!value || typeof value !== 'object') throw Error('Invalid repeatable scene timing');
  const v = value as Record<string, unknown>;
  if (typeof v.enabled !== 'boolean' || typeof v.bpm !== 'number' || !Number.isFinite(v.bpm) || v.bpm < 20 || v.bpm > 400
    || typeof v.offsetSeconds !== 'number' || !Number.isFinite(v.offsetSeconds) || Math.abs(v.offsetSeconds) > 3600
    || typeof v.barsPerScene !== 'number' || !Number.isInteger(v.barsPerScene) || v.barsPerScene < 1 || v.barsPerScene > 128
    || typeof v.seed !== 'number' || !Number.isInteger(v.seed) || v.seed < 0 || v.seed > 0xffffffff) throw Error(V1_MESSAGE);
  const result: SceneTiming = { enabled: v.enabled, bpm: v.bpm, offsetSeconds: v.offsetSeconds, barsPerScene: v.barsPerScene, seed: v.seed };
  // Unknown keys are dropped; a future `version` keeps the fields this build understands.
  if (v.version !== undefined && (typeof v.version !== 'number' || !Number.isInteger(v.version) || v.version < 1)) throw Error('Scene timing version must be a positive whole number');
  const extra: Record<string, unknown> = {};
  if (v.beatsPerBar !== undefined) {
    if (!isInt(v.beatsPerBar, 1, 16)) throw Error('Scene timing beatsPerBar must be a whole number from 1 to 16');
    if (v.beatsPerBar !== 4) extra.beatsPerBar = v.beatsPerBar;
  }
  if (v.barsPattern !== undefined) {
    const p = v.barsPattern;
    if (!Array.isArray(p) || p.length < 1 || p.length > MAX_BARS_PATTERN || p.some(b => !isInt(b, 1, 128))) throw Error('Scene timing barsPattern must list 1 to 64 whole numbers from 1 to 128');
    extra.barsPattern = [...p];
  }
  if (v.patternHold !== undefined) {
    if (typeof v.patternHold !== 'boolean') throw Error('Scene timing patternHold must be true or false');
    if (v.patternHold) extra.patternHold = true;
  }
  if (v.tempoMap !== undefined) {
    const m = v.tempoMap;
    if (!Array.isArray(m) || m.length < 1 || m.length > MAX_TEMPO_MAP) throw Error('Scene timing tempoMap must list 1 to 256 tempo changes');
    let previous = result.offsetSeconds;
    const changes: TempoChange[] = [];
    for (const c of m as unknown[]) {
      const e = c as Record<string, unknown> | null;
      if (!e || typeof e !== 'object' || typeof e.at !== 'number' || !Number.isFinite(e.at) || e.at <= previous || e.at > 1e6
        || typeof e.bpm !== 'number' || !Number.isFinite(e.bpm) || e.bpm < 20 || e.bpm > 400) throw Error('Scene timing tempoMap changes must follow the offset in increasing time order, at most 1000000 seconds, at 20–400 BPM');
      changes.push({ at: e.at, bpm: e.bpm }); previous = e.at;
    }
    extra.tempoMap = changes;
  }
  if (v.script !== undefined) {
    const s = v.script;
    if (!Array.isArray(s) || s.length > MAX_SCRIPT) throw Error('Scene timing script must list at most 1024 cues');
    let previous = -1;
    const cues: ScriptedCue[] = [];
    for (const c of s as unknown[]) {
      const e = c as Record<string, unknown> | null;
      if (!e || typeof e !== 'object' || typeof e.ordinal !== 'number' || !Number.isSafeInteger(e.ordinal) || e.ordinal <= previous || typeof e.preset !== 'string' || !HASH.test(e.preset)) throw Error('Scene timing script cues need increasing whole-number ordinals and sha256 presets');
      cues.push({ ordinal: e.ordinal, preset: e.preset }); previous = e.ordinal;
    }
    if (cues.length) extra.script = cues;
  }
  if (v.intervals !== undefined) {
    const list = v.intervals;
    if (!Array.isArray(list) || list.length > MAX_INTERVALS) throw Error('Scene timing intervals must list at most 64 intervals');
    const ids = new Set<string>(), intervals: NamedInterval[] = [];
    for (const c of list as unknown[]) {
      const e = c as Record<string, unknown> | null;
      if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !INTERVAL_ID.test(e.id) || ids.has(e.id)
        || typeof e.startBeat !== 'number' || typeof e.endBeat !== 'number' || !Number.isFinite(e.startBeat) || !Number.isFinite(e.endBeat)
        || e.startBeat < 0 || e.startBeat >= e.endBeat || e.endBeat > 1e7) throw Error('Scene timing intervals need unique ids (a–z, 0–9, _ and -, up to 32) and 0 <= startBeat < endBeat <= 10000000');
      ids.add(e.id); intervals.push({ id: e.id, startBeat: e.startBeat, endBeat: e.endBeat });
    }
    if (intervals.length) extra.intervals = intervals;
  }
  if (Object.keys(extra).length) Object.assign(result, { version: 2 }, extra);
  return result;
}
export function validateSceneTiming(value: unknown): value is SceneTiming {
  if (value === undefined) return false;
  try { parseSceneTiming(value); return true; } catch { return false; }
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let n = state; n = Math.imul(n ^ (n >>> 15), n | 1); n ^= n + Math.imul(n ^ (n >>> 7), n | 61); return ((n ^ (n >>> 14)) >>> 0) / 4294967296; };
}
function shuffled(values: readonly number[], seed: number): number[] {
  const result = [...values], next = random(seed);
  for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [result[i], result[j]] = [result[j]!, result[i]!]; }
  return result;
}

/** A cycle's final entry is known without evaluating earlier cycles, so seeking is O(n).
 * Reserving it, and excluding the prior cycle's final entry from the first slot,
 * allows a new permutation every cycle without repeating across the boundary.
 * With only two entries, alternating is the only no-repeat ordering.
 * Also the seeded bag behind Random transition timing (mpc-transition-timing.ts).
 */
export function cycleOrder(base: readonly number[], cycle: number, seed: number): readonly number[] {
  if (base.length <= 2) return base;
  const last = base[cycle % base.length]!, previousLast = base[(cycle + base.length - 1) % base.length]!;
  const middle = shuffled(base.filter(index => index !== last), (seed ^ Math.imul(cycle + 1, 0x9e3779b1)) >>> 0);
  if (middle[0] === previousLast) [middle[0], middle[1]] = [middle[1]!, middle[0]!];
  return [...middle, last];
}

// Validation of an order or a cue list is memoised by array identity. Callers treat both as immutable and pass a new array to change them
// (every producer in the host already does); this keeps a compiled clock O(log n) per frame instead of O(n) for the large folders BRW plays.
const validOrders = new WeakMap<readonly number[], ReadonlySet<number>>();
function orderMembers(order: readonly number[]): ReadonlySet<number> {
  const known = validOrders.get(order);
  if (known) return known;
  const members = new Set(order);
  if (order.some(index => !Number.isSafeInteger(index) || index < 0) || members.size !== order.length) throw Error('Scene order requires unique nonnegative preset indices');
  validOrders.set(order, members);
  return members;
}
const validCues = new WeakMap<readonly SessionSceneCue[], readonly number[] | null>();
function validateCues(cues: readonly SessionSceneCue[], order?: readonly number[], members?: ReadonlySet<number>): void {
  if (!Array.isArray(cues) || cues.length > MAX_SCENE_CUES) throw Error(`A repeatable session supports at most ${MAX_SCENE_CUES} scene cues`);
  if (validCues.has(cues) && validCues.get(cues) === (order ?? null)) return;
  let previous = -1;
  for (const cue of cues) {
    if (!cue || !Number.isSafeInteger(cue.ordinal) || cue.ordinal <= previous || !Number.isSafeInteger(cue.index) || cue.index < 0
      || (order !== undefined && !(members ? members.has(cue.index) : order.includes(cue.index)))) throw Error('Scene cues require increasing nonnegative ordinals and preset indices from the active setup');
    previous = cue.ordinal;
  }
  validCues.set(cues, order ?? null);
}

/** Queue one choice at the next scene boundary. Repeated choices before that
 * boundary replace the pending cue; past and later recorded cues remain intact.
 * Never drop old cues to make room: replay must continue to use the same history.
 */
export function scheduleSceneCue(cues: readonly SessionSceneCue[], phase: Pick<ScenePhase, 'ordinal'>, target: number): SessionSceneCue[] {
  validateCues(cues);
  if (!Number.isSafeInteger(phase.ordinal) || phase.ordinal < 0 || phase.ordinal >= Number.MAX_SAFE_INTEGER
    || !Number.isSafeInteger(target) || target < 0) throw Error('Cannot queue an invalid scene cue');
  const ordinal = phase.ordinal + 1, result = cues.map(cue => ({ ...cue }));
  const at = result.findIndex(cue => cue.ordinal >= ordinal);
  if (at >= 0 && result[at]!.ordinal === ordinal) result[at] = { ordinal, index: target };
  else {
    if (result.length === MAX_SCENE_CUES) throw Error(`This session has ${MAX_SCENE_CUES} scene cues. Reactivate the setup to start a new session.`);
    result.splice(at < 0 ? result.length : at, 0, { ordinal, index: target });
  }
  return result;
}

/** Scene selection by ordinal. Results equal the v1 selection exactly; only recomputation is avoided (per order, per cue, per cycle). */
interface CueEntry { index: number; position: number; base: number[]; sequences: Map<number, readonly number[]> }
class Selector {
  private order: readonly number[] | null = null;
  private shuffle = false;
  private base: readonly number[] = [];
  private cycles = new Map<number, readonly number[]>();
  private cued = new Map<number, CueEntry>();
  constructor(private readonly seed: number) {}
  /** The scene at ordinal `n`; `cues` are sorted by ordinal and already validated. */
  at(n: number, order: readonly number[], shuffle: boolean, cues: readonly SessionSceneCue[]): number {
    if (this.order !== order || this.shuffle !== shuffle) {
      this.order = order; this.shuffle = shuffle; this.cycles = new Map(); this.cued = new Map();
      this.base = shuffle ? shuffled(order, this.seed) : order;
    }
    let low = 0, high = cues.length;
    while (low < high) { const middle = Math.floor((low + high) / 2); if (cues[middle]!.ordinal <= n) low = middle + 1; else high = middle; }
    const cue = low ? cues[low - 1] : undefined;
    if (cue) return this.cuedIndex(n, cue);
    if (!shuffle) return order[n % order.length]!;
    const cycle = Math.floor(n / order.length);
    let sequence = this.cycles.get(cycle);
    if (!sequence) { if (this.cycles.size > 8) this.cycles.clear(); sequence = cycleOrder(this.base, cycle, this.seed); this.cycles.set(cycle, sequence); }
    return sequence[n % order.length]!;
  }
  /** The first shuffled cycle begins with the requested scene. Its last slot is
   * reserved exactly as in cycleOrder, so later cycles can be evaluated directly
   * after a seek and cannot repeat the preceding cycle's final scene.
   */
  private cuedIndex(n: number, cue: SessionSceneCue): number {
    const order = this.order!, relative = n - cue.ordinal;
    let entry = this.cued.get(cue.ordinal);
    if (!entry || entry.index !== cue.index) {
      if (this.cued.size > 64) this.cued.clear();
      entry = { index: cue.index, position: 0, base: [], sequences: new Map() };
      if (!this.shuffle) entry.position = order.indexOf(cue.index);
      else {
        entry.base = shuffled(order, (this.seed ^ Math.imul(cue.ordinal + 1, 0x85ebca6b)) >>> 0);
        const base = entry.base;
        if (base.length <= 2) { if (base[0] !== cue.index) [base[0], base[1]] = [base[1]!, base[0]!]; }
        // base[0] is cycle zero's final scene; the explicitly requested first scene
        // must occupy a different slot when the setup has more than one preset.
        else if (base[0] === cue.index) [base[0], base[1]] = [base[1]!, base[0]!];
      }
      this.cued.set(cue.ordinal, entry);
    }
    if (!this.shuffle) return order[(entry.position + relative) % order.length]!;
    const base = entry.base;
    if (base.length <= 2) return base[relative % base.length]!;
    const cycle = Math.floor(relative / base.length);
    let sequence = entry.sequences.get(cycle);
    if (!sequence) {
      const built = [...cycleOrder(base, cycle, (this.seed ^ Math.imul(cue.ordinal + 1, 0x85ebca6b)) >>> 0)];
      if (cycle === 0) { const chosen = built.indexOf(cue.index); [built[0], built[chosen]] = [built[chosen]!, built[0]!]; }
      if (entry.sequences.size > 8) entry.sequences.clear();
      entry.sequences.set(cycle, sequence = built);
    }
    return sequence[relative % base.length]!;
  }
}

/** Scene geometry: the ordinal's span in beats since the offset and in absolute seconds. `end` of scene n is bitwise the `start` of n + 1. */
interface Span { ordinal: number; startBeat: number; endBeat: number; start: number; end: number; duration: number }
interface Core {
  t: SceneTiming;
  /** No v2 timing field changes the arithmetic: the original v1 formulas run, bit for bit. */
  legacy: boolean;
  beatsPerBar: number;
  legacyDuration: number;
  grid: BeatGrid | null;
  pattern: ScenePattern | null;
}
const usesGrid = (t: SceneTiming): boolean => (t.beatsPerBar !== undefined && t.beatsPerBar !== 4) || t.barsPattern !== undefined || (t.tempoMap !== undefined && t.tempoMap.length > 0);
function coreOf(t: SceneTiming, full: boolean): Core {
  const beatsPerBar = t.beatsPerBar ?? 4, legacy = !usesGrid(t);
  const grid = full || !legacy ? compileGrid(t.bpm, t.offsetSeconds, t.tempoMap ?? []) : null;
  const pattern = full || !legacy ? compilePattern(t.barsPattern ?? [t.barsPerScene], beatsPerBar, t.patternHold ?? false) : null;
  return { t, legacy, beatsPerBar, legacyDuration: 240 * t.barsPerScene / t.bpm, grid, pattern };
}
function spanOf(c: Core, ordinal: number): Span {
  if (c.legacy) {
    const d = c.legacyDuration, beats = c.t.barsPerScene * 4;
    return { ordinal, startBeat: ordinal * beats, endBeat: (ordinal + 1) * beats, start: c.t.offsetSeconds + ordinal * d, end: c.t.offsetSeconds + (ordinal + 1) * d, duration: d };
  }
  const startBeat = c.pattern!.startBeat(ordinal), endBeat = startBeat + c.pattern!.beats(ordinal);
  const start = c.grid!.timeAt(startBeat), end = c.grid!.timeAt(endBeat);
  return { ordinal, startBeat, endBeat, start, end, duration: end - start };
}
/** The scene playing at `position` (media seconds, negative reads as 0) plus its local time; null for an unsafe ordinal. */
function locate(c: Core, position: number): { span: Span; localTime: number } | null {
  const pos = Math.max(0, position);
  if (c.legacy) {
    const d = c.legacyDuration, elapsed = Math.max(0, pos - c.t.offsetSeconds);
    // Tolerance only absorbs rounding at a computed boundary (less than a nanosecond).
    const ordinal = Math.floor((elapsed + 1e-10) / d);
    if (!Number.isSafeInteger(ordinal)) return null;
    return { span: spanOf(c, ordinal), localTime: Math.max(0, Math.min(d, elapsed - ordinal * d)) };
  }
  const found = c.pattern!.at(c.grid!.beatAt(pos));
  if (!Number.isSafeInteger(found.ordinal)) return null;
  const span = spanOf(c, found.ordinal);
  return { span, localTime: Math.max(0, Math.min(span.duration, pos - span.start)) };
}
function guard(order: readonly number[], cues: readonly SessionSceneCue[]): void {
  const members = orderMembers(order);
  validateCues(cues, order, members);
}

/** Derive the scene directly from song time and recorded choices. Pause, seek and
 * replay never depend on the order frames were evaluated. Beats per bar default to four.
 * Before the offset, the first scene holds at time zero. A timing with no v2 field takes the original arithmetic.
 */
export function sceneAt(position: number, order: readonly number[], timing: SceneTiming, shuffle: boolean, cues: readonly SessionSceneCue[] = []): ScenePhase | null {
  if (!timing.enabled || !order.length || !Number.isFinite(position)) return null;
  const t = parseSceneTiming(timing);
  guard(order, cues);
  const c = coreOf(t, false), at = locate(c, position);
  if (!at) return null;
  const selector = new Selector(t.seed), { span } = at;
  return { index: selector.at(span.ordinal, order, shuffle, cues), previousIndex: selector.at(Math.max(0, span.ordinal - 1), order, shuffle, cues), ordinal: span.ordinal,
    start: span.start, localTime: at.localTime, progress: at.localTime / span.duration, duration: span.duration };
}

/** A fade resolved by the clock. `from`/`to` are catalog indices. The window is [boundary - pivot * seconds, boundary + (1 - pivot) * seconds]
 * with pivot 0 (start anchor), 1 (end anchor) or the style's hit fraction. `progress` is time-domain, (position - start) / seconds. */
export interface FadeWindow {
  ordinal: number; from: number; to: number; start: number; end: number; seconds: number; beats: number;
  timing: ConcreteFade; anchor: FadeAnchor; pivot: number; progress: number;
}
export interface ClockFrame extends ScenePhase {
  /** Absolute end of this scene; bitwise the `start` of the next. */
  end: number;
  startBeat: number; endBeat: number;
  /** Beats since the offset (0 before it), whole beat and bar indices are 0-based. */
  beat: number; bar: number; beatInBar: number; beatPhase: number; barPhase: number; beatsPerBar: number;
  /** Instantaneous tempo (the tempo map applies). */
  bpm: number;
  beatProgress: number;
  remaining: number;
  barsRemaining: number;
  /** Seconds until the offset; 0 afterwards. */
  countIn: number;
  /** Local times for the outgoing plate: it started at `previousStart` and ended after `previousFrozen` seconds (0 for the first scene). */
  previousStart: number; previousFrozen: number;
  fade: FadeWindow | null;
}
export interface SceneClockHooks {
  /** Hit fraction for a style of `beats` at the boundary of scene `ordinal` (anchor 2 only; without it `hit` behaves as start, C-06). */
  pivotForBeats?(beats: number, ordinal: number): number;
}
export interface SceneClock {
  readonly timing: SceneTiming;
  readonly grid: BeatGrid;
  /** The wire grid for worker frames (offset, bpm, beatsPerBar, tempo changes). */
  readonly clockGrid: ClockGrid;
  /** `fade` (optional) resolves the transition window of this frame with the seeded Random bag, indexed by incoming scene ordinal. */
  at(position: number, order: readonly number[], shuffle: boolean, cues?: readonly SessionSceneCue[], fade?: FadeSpec, hooks?: SceneClockHooks): ClockFrame | null;
  /** 1-based bar and beat-in-bar since the offset ("bar 17.3"); 1.1 before the offset. */
  barBeat(position: number): { bar: number; beat: number };
  /** Bar position of a scene boundary, `pattern.startBeat(ordinal) / beatsPerBar`, for `boundaryLevel`. */
  boundaryBar(ordinal: number): number;
  /** `timing.intervals` resolved to absolute seconds through the grid (`start = timeAt(startBeat)`, `end = timeAt(endBeat)`), in the shape the HUD frame carries. */
  readonly intervals: readonly HudNamedInterval[];
  /** The named intervals running at `position`: `start <= position < end`. A shared empty array when none runs; never allocates per frame in that case. */
  activeIntervals(position: number): readonly HudNamedInterval[];
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
/** Compile once per activation. Validates the timing; per-frame order and cue validation is memoised by array identity. */
export function compileSceneClock(timing: SceneTiming): SceneClock {
  const t = parseSceneTiming(timing), c = coreOf(t, true), grid = c.grid!, bpb = c.beatsPerBar;
  const clockGrid: ClockGrid = Object.freeze({ offset: t.offsetSeconds, bpm: t.bpm, beatsPerBar: bpb,
    ...(t.tempoMap?.length ? { changes: t.tempoMap.map(m => Object.freeze([m.at, m.bpm] as const)) } : {}) });
  const selector = new Selector(t.seed);
  const none: readonly HudNamedInterval[] = Object.freeze([]);
  const intervals: readonly HudNamedInterval[] = t.intervals?.length ? Object.freeze(t.intervals.map(iv => Object.freeze({ id: iv.id, start: grid.timeAt(iv.startBeat), end: grid.timeAt(iv.endBeat) }))) : none;
  /** The window of the boundary that opens scene `n` (n >= 1), or null when the fade is Instant. */
  const windowFor = (n: number, spec: FadeSpec, hooks: SceneClockHooks | undefined, order: readonly number[], shuffle: boolean, cues: readonly SessionSceneCue[]): FadeWindow | null => {
    const into = spanOf(c, n), out = spanOf(c, n - 1), pick = pickFade(spec, n, t.seed);
    const tempoFree = grid.constant;
    const base = { bpm: tempoFree ? t.bpm : grid.bpmAt(into.start), beatsPerBar: bpb, ...(tempoFree ? {} : { grid, boundaryBeat: into.startBeat }),
      ...(hooks?.pivotForBeats ? { pivotForBeats: (beats: number) => hooks.pivotForBeats!(beats, n) } : {}) };
    // Start and end anchors keep whole scenes. A peak anchored on a style's hit point may borrow from both sides, so each side is limited to
    // half its scene: the tail of one window and the head of the next then always fit inside the scene between them.
    const halved = spec.anchor === 2 && !!hooks?.pivotForBeats;
    const cap = (pivot: number): number => halved ? Math.min(pivot < 1 ? into.duration / (2 * (1 - pivot)) : Infinity, pivot > 0 ? out.duration / (2 * pivot) : Infinity)
      : pivot <= 0 ? into.duration : out.duration;
    let plan = planFade(spec, pick, spec.anchor === 2 ? base : { ...base, capSeconds: cap(spec.anchor === 1 ? 1 : 0) });
    if (spec.anchor === 2) {
      plan = planFade(spec, pick, { ...base, capSeconds: cap(plan.pivot) });
      const limit = cap(plan.pivot);
      if (plan.seconds > limit) plan = { ...plan, beats: plan.seconds > 0 ? plan.beats * limit / plan.seconds : 0, seconds: limit };
    }
    if (!(plan.seconds > 0)) return null;
    return { ordinal: n, from: selector.at(n - 1, order, shuffle, cues), to: selector.at(n, order, shuffle, cues), start: into.start - plan.pivot * plan.seconds,
      end: into.start + (1 - plan.pivot) * plan.seconds, seconds: plan.seconds, beats: plan.beats, timing: plan.timing, anchor: plan.anchor, pivot: plan.pivot, progress: 0 };
  };
  return {
    timing: t, grid, clockGrid,
    at(position, order, shuffle, cues = [], fade, hooks) {
      if (!t.enabled || !order.length || !Number.isFinite(position)) return null;
      guard(order, cues);
      const found = locate(c, position);
      if (!found) return null;
      const { span, localTime } = found, pos = Math.max(0, position), n = span.ordinal;
      const beat = grid.beatAt(pos), whole = Math.floor(beat + BEAT_EPS), bar = Math.floor(whole / bpb), beatInBar = whole - bar * bpb, beatPhase = clamp01(beat - whole);
      const previous = n > 0 ? spanOf(c, n - 1) : span;
      let window: FadeWindow | null = null;
      if (fade) {
        // A window that ends the fade on a boundary (pivot > 0) opens before the boundary, so the next one may already be running.
        if (fade.anchor !== 0) {
          const upcoming = windowFor(n + 1, fade, hooks, order, shuffle, cues);
          if (upcoming && pos >= upcoming.start) window = upcoming;
        }
        if (!window && n >= 1) { const current = windowFor(n, fade, hooks, order, shuffle, cues); if (current && pos < current.end) window = current; }
        if (window) window = { ...window, progress: clamp01((pos - window.start) / window.seconds) };
      }
      return { index: selector.at(n, order, shuffle, cues), previousIndex: selector.at(Math.max(0, n - 1), order, shuffle, cues), ordinal: n, start: span.start, localTime,
        progress: localTime / span.duration, duration: span.duration, end: span.end, startBeat: span.startBeat, endBeat: span.endBeat, beat, bar, beatInBar, beatPhase,
        barPhase: (beatInBar + beatPhase) / bpb, beatsPerBar: bpb, bpm: grid.bpmAt(pos), beatProgress: clamp01((beat - span.startBeat) / (span.endBeat - span.startBeat)),
        remaining: Math.max(0, span.end - pos), barsRemaining: Math.max(0, Math.ceil((span.endBeat - beat) / bpb - 1e-9)), countIn: Math.max(0, t.offsetSeconds - pos),
        previousStart: previous.start, previousFrozen: n > 0 ? previous.duration : 0, fade: window };
    },
    barBeat(position) {
      const beat = grid.beatAt(Number.isFinite(position) ? Math.max(0, position) : 0), whole = Math.floor(beat + BEAT_EPS), bar = Math.floor(whole / bpb);
      return { bar: bar + 1, beat: whole - bar * bpb + 1 };
    },
    boundaryBar(ordinal) { return spanOf(c, Math.max(0, Math.floor(ordinal))).startBeat / bpb; },
    intervals,
    activeIntervals(position) {
      if (!intervals.length || !Number.isFinite(position)) return none;
      const running = intervals.filter(iv => position >= iv.start && position < iv.end);
      return running.length ? running : none;
    },
  };
}
