/** Shared, media-time lane director for sets, all sets, library and explicit preset selections. */
import type { LocalAvsPreset } from './avs/local-collection.ts';
import { eligiblePresets } from './mpc-preset-eligibility.ts';
import { compileSceneClock, scheduleSceneCue, type ClockFrame, type SceneClock, type SessionSceneCue } from './mpc-scene-clock.ts';
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
interface Lane { clock: SceneClock; setsClock: SceneClock; source: MultiViewSource; groups: readonly Pool[]; setOrder: readonly number[] }
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
export class MultiViewClock {
  readonly plan: MultiViewPlan;
  private readonly lanes: readonly Lane[];
  private readonly failed: ReadonlySet<number>;
  private readonly songClock: SceneClock;
  private readonly cues: SessionSceneCue[][];
  constructor(plan: MultiViewPlan, catalog: readonly LocalAvsPreset[], sets: readonly MultiViewSet[], failed: ReadonlySet<number> = new Set()) {
    this.plan = parseMultiViewPlan(plan); this.failed = new Set(failed);
    this.songClock = compileSceneClock(this.plan.timing);
    this.cues = Array.from({ length: this.plan.count }, () => []);
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
      return { source, groups, setOrder: Object.freeze(groups.map((_, g) => g)), clock: compileSceneClock(timing), setsClock: compileSceneClock({ ...timing, barsPerScene: source.kind === 'all-sets' ? source.barsPerSet : 32 }) };
    });
  }
  /** Queue a manual choice within this panel's source at its next musical boundary. Other panels keep their sequences. */
  queue(pane: number, index: number, position: number): boolean {
    const frame = this.at(position)[pane]; if (!frame || !frame.order.includes(index)) return false;
    this.cues[pane] = scheduleSceneCue(this.cues[pane]!, frame.phase, index); return true;
  }
  /** No-frame-history selection. Reconstructs independently on seek; never opens more than four visible panes. */
  at(position: number): readonly (MultiViewLaneFrame | null)[] {
    if (!Number.isFinite(position)) return this.lanes.map(() => null);
    const used = new Set<number>();
    return this.lanes.map((lane, i) => {
      const pane = this.plan.panes[i]!, grid = this.songClock.grid, bpb = this.plan.timing.beatsPerBar ?? 4, shift = pane.phaseBars * bpb;
      const virtual = Math.max(0, grid.beatAt(position) - shift) / 2;
      const setPhase = lane.setsClock.at(pane.auto ? virtual : 0, lane.setOrder, false);
      const group = lane.groups[setPhase?.index ?? 0];
      if (!group?.order.length) return null;
      let order = group.order;
      const read = (o: readonly number[]) => lane.clock.at(pane.auto ? virtual : 0, o, pane.shuffle, this.cues[i]!.filter(cue => o.includes(cue.index)));
      let phase = read(order); if (!phase) return null;
      // Deconflict only equal initial choices; the remaining pool follows its own saved lane clock.
      if (this.plan.avoidDuplicates && used.has(phase.index) && order.some(index => !used.has(index))) {
        order = Object.freeze(order.filter(index => !used.has(index))); phase = read(order); if (!phase) return null;
      }
      used.add(phase.index);
      const groupEnd = lane.source.kind === 'all-sets' && lane.source.traversal === 'sets' ? setPhase?.end ?? phase.end : phase.end;
      const nextAt = Math.min(phase.end, groupEnd);
      let next = pane.auto ? lane.clock.at(nextAt, order, pane.shuffle, this.cues[i]!.filter(cue => order.includes(cue.index))) ?? phase : phase;
      if (pane.auto && lane.source.kind === 'all-sets' && lane.source.traversal === 'sets') {
        const nextSet = lane.setsClock.at(nextAt, lane.setOrder, false), nextGroup = lane.groups[nextSet?.index ?? 0];
        if (nextGroup?.order.length && nextGroup !== group) next = lane.clock.at(nextAt, nextGroup.order, pane.shuffle, this.cues[i]!.filter(cue => nextGroup.order.includes(cue.index)))!;
      }
      const musical = this.songClock.at(position, MUSICAL_ORDER, false); if (!musical) return null;
      const map = (p: ClockFrame, begin: number, finish: number): ClockFrame => {
        const startBeat = begin * 2 + shift, endBeat = finish * 2 + shift, start = grid.timeAt(startBeat), end = grid.timeAt(endBeat), localTime = Math.max(0, Math.min(end - start, position - start));
        return { ...p, start, end, startBeat, endBeat, duration: end - start, localTime, progress: end > start ? localTime / (end - start) : 0,
          bpm: musical.bpm, beat: musical.beat, bar: musical.bar, beatInBar: musical.beatInBar, beatPhase: musical.beatPhase, barPhase: musical.barPhase,
          remaining: Math.max(0, end - position), barsRemaining: Math.max(0, endBeat - grid.beatAt(position)) / bpb, countIn: Math.max(0, start - position),
          previousStart: grid.timeAt(p.previousStart * 2 + shift), previousFrozen: Math.max(0, start - grid.timeAt(p.previousStart * 2 + shift)), fade: null };
      };
      const begin = lane.source.kind === 'all-sets' && lane.source.traversal === 'sets' ? Math.max(phase.start, setPhase?.start ?? phase.start) : phase.start;
      return { pane: i, phase: map(phase, begin, nextAt), next: map(next, nextAt, next.end), clock: this.songClock, sourceLabel: group.label, order };
    });
  }
}
const MUSICAL_ORDER = Object.freeze([0]);
