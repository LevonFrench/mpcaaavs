/** Shared, media-time lane director for sets, all sets, library and explicit preset selections. */
import type { LocalAvsPreset } from './avs/local-collection.ts';
import { eligiblePresets } from './mpc-preset-eligibility.ts';
import { MAX_SCENE_CUES, compileSceneClock, scheduleSceneCue, type ClockFrame, type SceneClock, type SessionSceneCue } from './mpc-scene-clock.ts';
import type { PresetSetup } from './mpc-setups.ts';
import { hash32 } from './mpc-transition.ts';
import { parseMultiViewPlan, type MultiViewPlan, type MultiViewSource } from './multi-view-model.ts';

export interface MultiViewSet { readonly id: string; readonly name: string; readonly order: readonly number[] }
export interface MultiViewLaneFrame {
  readonly pane: number;
  readonly phase: ClockFrame;
  readonly next: ClockFrame;
  readonly clock: SceneClock;
  readonly sourceLabel: string;
  readonly order: readonly number[];
}
interface Pool { label: string; order: readonly number[] }
interface Lane { clock: SceneClock; setsClock: SceneClock; source: MultiViewSource; groups: readonly Pool[]; members: ReadonlySet<number>; setOrder: readonly number[] }
export function multiViewSetsFromSetups(setups: readonly PresetSetup[], catalog: readonly LocalAvsPreset[]): MultiViewSet[] {
  const byHash = new Map(catalog.map((preset, i) => [preset.sha256, i]));
  return setups.map(set => ({ id: set.id, name: set.name, order: set.presets.flatMap(hash => byHash.has(hash) ? [byHash.get(hash)!] : []) }));
}
function rotate<T>(values: readonly T[], start: number): T[] { const n = values.length; return n ? [...values.slice(start % n), ...values.slice(0, start % n)] : []; }
/** Interleave sets and deduplicate by catalog index, preserving each set's authored order. */
export function interleaveMultiViewSets(sets: readonly MultiViewSet[]): number[] {
  const out: number[] = [], seen = new Set<number>(); let max = 0; for (const set of sets) max = Math.max(max, set.order.length);
  for (let i = 0; i < max; i++) for (const set of sets) { const index = set.order[i]; if (index !== undefined && !seen.has(index)) { seen.add(index); out.push(index); } }
  return out;
}
/** Tolerance when two lane boundaries produced by the same arithmetic are compared (lane seconds). */
const BOUNDARY_EPS = 1e-9;
/** A manual choice for a lane boundary that clips a preset span or changes the set. `at` is lane beat-domain time (virtual 120 BPM seconds). */
export interface MultiViewBoundaryCue { readonly at: number; readonly index: number }
/**
 * Session-owned lane history. Manual cues, clipped-boundary choices and per-pane Auto holds live here, OUTSIDE the disposable clock
 * compilation, so a settings, rating, failure or set refresh recompiles the clock without discarding a queued choice or seek replay.
 * A cue whose preset left the pool is ignored while it is ineligible (bounded history). Only the explicit resets clear entries.
 */
export class MultiViewLaneState {
  private cues: SessionSceneCue[][] = [];
  private marks: MultiViewBoundaryCue[][] = [];
  private holds: (number | undefined)[] = [];
  cuesFor(pane: number): readonly SessionSceneCue[] { return this.cues[pane] ?? []; }
  boundariesFor(pane: number): readonly MultiViewBoundaryCue[] { return this.marks[pane] ?? []; }
  /** Media position whose selection the pane holds while its own Auto is off; undefined holds the first scene. */
  holdFor(pane: number): number | undefined { return this.holds[pane]; }
  /** Queue at the lane boundary after `phase`; repeated choices before it replace the pending cue (scheduleSceneCue rules). */
  queueCue(pane: number, phase: Pick<ClockFrame, 'ordinal'>, index: number): void { this.cues[pane] = scheduleSceneCue(this.cues[pane] ?? [], phase, index); }
  /** Queue for a clipped or set-changing boundary at lane time `at`; a repeated choice for the same boundary replaces it. */
  queueBoundary(pane: number, at: number, index: number): void {
    if (!Number.isFinite(at) || at < 0 || !Number.isSafeInteger(index) || index < 0) throw Error('Cannot queue an invalid boundary choice');
    const marks = (this.marks[pane] ?? []).filter(m => Math.abs(m.at - at) > BOUNDARY_EPS);
    if (marks.length >= MAX_SCENE_CUES) throw Error(`This panel has ${MAX_SCENE_CUES} boundary choices. Change its source to start a new history.`);
    marks.push({ at, index }); marks.sort((a, b) => a.at - b.at); this.marks[pane] = marks;
  }
  hold(pane: number, position: number): void { if (Number.isFinite(position)) this.holds[pane] = position; }
  release(pane: number): void { this.holds[pane] = undefined; }
  /** Explicit reset: one pane when its lane identity (source, bars, stagger, shuffle, meter) changes, or every pane for a new session. */
  reset(pane?: number): void {
    if (pane === undefined) { this.cues = []; this.marks = []; this.holds = []; return; }
    this.cues[pane] = []; this.marks[pane] = []; this.holds[pane] = undefined;
  }
}
/** A lane read before it is mapped to song time: the lane-time phase, its visible end and whether that next boundary is clipped. */
interface LaneRead { readonly frame: MultiViewLaneFrame; readonly phase: ClockFrame; readonly nextAt: number; readonly clipped: boolean }
export class MultiViewClock {
  readonly plan: MultiViewPlan;
  private readonly lanes: readonly Lane[];
  private readonly failed: ReadonlySet<number>;
  private readonly songClock: SceneClock;
  /** `state` is owned by the caller and outlives this compilation; a fresh one is created for a standalone clock. */
  constructor(plan: MultiViewPlan, catalog: readonly LocalAvsPreset[], sets: readonly MultiViewSet[], failed: ReadonlySet<number> = new Set(), private readonly state = new MultiViewLaneState()) {
    this.plan = parseMultiViewPlan(plan); this.failed = new Set(failed);
    this.songClock = compileSceneClock(this.plan.timing);
    const byHash = new Map(catalog.map((preset, i) => [preset.sha256, i])), seenSets = new Set<string>(), uniqueSets = sets.filter(set => { if (seenSets.has(set.id)) return false; seenSets.add(set.id); return true; });
    const sanitize = (order: readonly number[]) => [...new Set(order)].filter(i => Number.isSafeInteger(i) && i >= 0 && i < catalog.length);
    this.lanes = this.plan.panes.slice(0, this.plan.count).map((pane, i) => {
      const source = pane.source ?? this.plan.source;
      const filter = (order: readonly number[]) => Object.freeze(rotate(eligiblePresets(catalog, sanitize(order), pane.shuffle, this.plan.minimumRating, this.failed), i));
      let groups: Pool[];
      if (source.kind === 'set') { const set = uniqueSets.find(s => s.id === source.id); groups = [{ label: set?.name ?? 'Missing set', order: filter(set?.order ?? []) }]; }
      else if (source.kind === 'all-sets' && source.traversal === 'sets') groups = rotate(uniqueSets.map(s => ({ label: s.name, order: filter(s.order) })).filter(g => g.order.length), i);
      else { const order = source.kind === 'all-sets' ? interleaveMultiViewSets(uniqueSets) : source.kind === 'presets' ? source.hashes.flatMap(h => byHash.has(h) ? [byHash.get(h)!] : []) : catalog.map((_, index) => index);
        groups = [{ label: source.kind === 'all-sets' ? 'All sets · mixed' : source.kind === 'presets' ? 'Selected presets' : 'All presets', order: filter(order) }]; }
      // Selection runs in beat-domain virtual seconds at 120 BPM. Bounds are mapped back through ONE song grid,
      // so staggered panels keep the same musical phase, named intervals and tempo changes as every other panel.
      const timing = { enabled: true, bpm: 120, offsetSeconds: 0, barsPerScene: pane.bars, beatsPerBar: this.plan.timing.beatsPerBar ?? 4, seed: hash32(this.plan.timing.seed ^ Math.imul(i + 1, 0x9e3779b1)) };
      return { source, groups, members: new Set(groups.flatMap(g => g.order)), setOrder: Object.freeze(groups.map((_, g) => g)), clock: compileSceneClock(timing),
        setsClock: compileSceneClock({ ...timing, barsPerScene: source.kind === 'all-sets' ? source.barsPerSet : 32 }) };
    });
  }
  /**
   * Queue a manual choice within this panel's source. Precedence: the choice wins the panel's NEXT VISIBLE boundary.
   * - An ordinary preset boundary records a lane cue; the sequence then continues from the chosen preset.
   * - A shorter set boundary that clips the preset span, or any boundary where the set changes, records a boundary choice that owns
   *   exactly the next visible span; set traversal resumes at the boundary after it.
   * Other panels keep their sequences. Returns false when the preset is outside the pane's current pool or the history is full.
   */
  queue(pane: number, index: number, position: number): boolean {
    const read = this.read(position)[pane]; if (!read || !read.frame.order.includes(index)) return false;
    try { if (read.clipped) this.state.queueBoundary(pane, read.nextAt, index); else this.state.queueCue(pane, read.phase, index); }
    catch { return false; }
    return true;
  }
  /** No-frame-history selection. Reconstructs independently on seek; never opens more than four visible panes. */
  at(position: number): readonly (MultiViewLaneFrame | null)[] { return this.read(position).map(read => read?.frame ?? null); }
  private read(position: number): readonly (LaneRead | null)[] {
    if (!Number.isFinite(position)) return this.lanes.map(() => null);
    const used = new Set<number>();
    return this.lanes.map((lane, i) => {
      const pane = this.plan.panes[i]!, grid = this.songClock.grid, bpb = this.plan.timing.beatsPerBar ?? 4, shift = pane.phaseBars * bpb;
      // A pane whose own Auto is off holds the selection it showed when Auto went off (the global Auto precedent), not the first scene.
      const hold = this.state.holdFor(i);
      const virtual = pane.auto ? Math.max(0, grid.beatAt(position) - shift) / 2 : hold === undefined ? 0 : Math.max(0, grid.beatAt(hold) - shift) / 2;
      if (!Number.isFinite(virtual)) return null;
      const cues = this.state.cuesFor(i), marks = this.state.boundariesFor(i);
      const setPhase = lane.setsClock.at(virtual, lane.setOrder, false);
      const group = lane.groups[setPhase?.index ?? 0];
      if (!group?.order.length) return null;
      let order = group.order;
      const read = (o: readonly number[], at = virtual) => lane.clock.at(at, o, pane.shuffle, cues.filter(cue => o.includes(cue.index)));
      let phase = read(order); if (!phase) return null;
      // Deconflict only equal initial choices; the remaining pool follows its own saved lane clock.
      if (this.plan.avoidDuplicates && used.has(phase.index) && order.some(index => !used.has(index))) {
        order = Object.freeze(order.filter(index => !used.has(index))); phase = read(order); if (!phase) return null;
      }
      const traversal = lane.source.kind === 'all-sets' && lane.source.traversal === 'sets';
      const groupEnd = traversal ? setPhase?.end ?? phase.end : phase.end;
      const nextAt = Math.min(phase.end, groupEnd);
      const begin = traversal ? Math.max(phase.start, setPhase?.start ?? phase.start) : phase.start;
      const mark = (at: number) => marks.find(m => Math.abs(m.at - at) <= BOUNDARY_EPS && lane.members.has(m.index));
      // A boundary choice owns the whole visible span that opens at its boundary.
      const owned = mark(begin); if (owned && owned.index !== phase.index) phase = { ...phase, index: owned.index };
      used.add(phase.index);
      let next = pane.auto ? read(order, nextAt) ?? phase : phase, nextGroup = group;
      if (pane.auto && traversal) {
        const nextSet = lane.setsClock.at(nextAt, lane.setOrder, false), candidate = lane.groups[nextSet?.index ?? 0];
        if (candidate?.order.length && candidate !== group) { nextGroup = candidate; next = read(candidate.order, nextAt)!; }
      }
      const queued = pane.auto ? mark(nextAt) : undefined; if (queued && queued.index !== next.index) next = { ...next, index: queued.index };
      // "Clipped": a set boundary cuts this preset span short, or the set changes at the next visible boundary.
      const clipped = traversal && (nextAt < phase.end - BOUNDARY_EPS || nextGroup !== group);
      const musical = this.songClock.at(position, MUSICAL_ORDER, false); if (!musical) return null;
      const map = (p: ClockFrame, begin: number, finish: number): ClockFrame => {
        const startBeat = begin * 2 + shift, endBeat = finish * 2 + shift, start = grid.timeAt(startBeat), end = grid.timeAt(endBeat), localTime = Math.max(0, Math.min(end - start, position - start));
        return { ...p, start, end, startBeat, endBeat, duration: end - start, localTime, progress: end > start ? localTime / (end - start) : 0,
          bpm: musical.bpm, beat: musical.beat, bar: musical.bar, beatInBar: musical.beatInBar, beatPhase: musical.beatPhase, barPhase: musical.barPhase,
          remaining: Math.max(0, end - position), barsRemaining: Math.max(0, endBeat - grid.beatAt(position)) / bpb, countIn: Math.max(0, start - position),
          previousStart: grid.timeAt(p.previousStart * 2 + shift), previousFrozen: Math.max(0, start - grid.timeAt(p.previousStart * 2 + shift)), fade: null };
      };
      return { frame: { pane: i, phase: map(phase, begin, nextAt), next: map(next, nextAt, next.end), clock: this.songClock, sourceLabel: group.label, order }, phase, nextAt, clipped };
    });
  }
}
const MUSICAL_ORDER = Object.freeze([0]);
