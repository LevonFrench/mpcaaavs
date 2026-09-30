// The choreographer (Task 5, item 5). It turns a song map's events into a script of clips, projectiles, effects, banners and hit punches
// for one plate window, following the grammar of docs/design/SPRITE-SHOW-KIT.md ("Choreography grammar"):
//
//  - every action is placed with LOOK-AHEAD: the clip starts `bigTick / 60` s before its event, so its `big` frame (the release, the
//    impact, the flash) lands exactly on the event; hitstop (4-12 ticks by onset strength) then freezes the clip after that frame;
//  - kicks drive attacks and launches, snares drive guards, parries and deaths, hats drive light swings, downbeats drive poses, the drop
//    downbeat drives the screen-wide moment (flash, shake, super);
//  - call and response: performers of side A and B take the stage in alternating phrases (`phraseBars` bars each); the performer whose
//    turn it is calls on the kicks, the other answers on the snares;
//  - projectiles are notes: launched on the big frame, they land on a whole beat (flight beats from the launch rounded up to the grid);
//  - nothing is simulated: no health reaches zero, nobody wins, loses or clears; enemies that die on a snare respawn on the next downbeat.
//
// The script is a pure function of (song map, pack, plan, window, seed). The renderer evaluates it at any time t, so a seek needs no
// replay (Stage in perform.ts). Events of a kind with no data in the window (a tempo-only live fallback) are synthesised from the beat
// grid so the stage still moves in time.
import type { ClipVerb, MotionModel } from '../../asset-packs/manifest.ts';
import type { SectionRole } from '../../song-map/types.ts';
import { TICK, TICK_RATE, bigTick, bigFrameTime, hitstopTicks, loopBeats, oneShotDuration, clipTotalTicks, startForEvent, type ClipTiming, type Hitstop } from './clip.ts';
import { landingBeat, type MotionSpec } from './motion.ts';

/** The analysis the choreographer reads (AudioData implements it). */
export interface ChoreoAudio {
  readonly duration: number;
  readonly bpm: number;
  songDownbeats(): readonly number[];
  beatAt(t: number): number;
  timeOfBeat(i: number): number;
  songBarAt(t: number): number;
  songBarTime(b: number): number;
  events(kind: string, t0: number, t1: number): [number, number][];
  sectionAt(t: number): { role: SectionRole; start: number; end: number };
  env(name: string, t: number): number;
  readonly sections: readonly { role: SectionRole; start: number; end: number }[];
}
/** The pack lookups it needs. */
export interface ChoreoPack {
  actorClip(actorId: string, verb: ClipVerb): { id: string; clip: ClipTiming } | undefined;
  regionOf(id: string, role: 'projectile'): { spawn: readonly [number, number] } | undefined;
}

export type LaneSource = 'kick' | 'snare' | 'hat' | 'vocal' | 'downbeat' | 'drop';
export interface LaunchSpec {
  readonly region: string;
  readonly model: MotionModel;
  /** Minimum flight in beats; the landing is rounded up to a whole beat. For orbit: lifetime in beats. */
  readonly beats: number;
  readonly amp?: number;
  /** spread: shots per launch. */
  readonly count?: number;
  /** Where the shot starts: the owner's hand (default), above the screen, or the floor under the target. */
  readonly origin?: 'owner' | 'sky' | 'floor';
}
export interface LaneSpec {
  readonly source: LaneSource;
  /** Candidate verbs, cycled; a verb the actor has no clip for is skipped. */
  readonly verbs: readonly ClipVerb[];
  /** With call and response: the lane is active while the performer's side has the call, or while it answers. */
  readonly turn?: 'call' | 'response';
  readonly minStrength?: number;
  readonly maxPerBar?: number;
  readonly minGap?: number;
  /** downbeat lanes: one event every N bars (default 1). */
  readonly every?: number;
  readonly hitstop?: boolean;
  readonly target?: string;
  /** The target's reaction clip (default 'hurt'; 'none' for no reaction). */
  readonly reaction?: ClipVerb | 'none';
  readonly fx?: string;
  /** Melee reach in px: the impact point in front of the performer. */
  readonly reach?: number;
  readonly launch?: LaunchSpec;
  /** Super: flash, ring and a screen freeze on its big frame. */
  readonly screenwide?: boolean;
}
export interface PerformerSpec {
  readonly id: string;
  readonly actor: string;
  readonly x: number;
  readonly y: number;
  readonly facing: 'left' | 'right';
  readonly palette?: string;
  readonly scale?: number;
  readonly side?: 'A' | 'B';
  /** The looping verb between actions, optionally per section role. */
  readonly base: ClipVerb;
  readonly baseByRole?: Partial<Record<SectionRole, ClipVerb>>;
  /** Idle float with a bob on the beat (motion model `hover`), amplitude in px. */
  readonly hover?: number;
  /** The loop's phase offset in beats. */
  readonly beatOffset?: number;
  readonly lanes: readonly LaneSpec[];
}
export interface StagePlan {
  readonly performers: readonly PerformerSpec[];
  /** Bars per call and per response (default 2). */
  readonly phraseBars?: number;
  /** Banner text for a section role; absent roles get no banner. */
  readonly banners?: Partial<Record<SectionRole, string>>;
}

export interface ScriptAction {
  readonly id: number;
  readonly performer: string;
  readonly verb: ClipVerb;
  readonly clip: string;
  readonly timing: ClipTiming;
  /** Clip start time (s). */
  readonly start: number;
  /** Start after the previous action of this performer was cut (truncated when the next action begins). */
  end: number;
  /** The musical event the big frame lands on, and the time the big frame actually shows. */
  readonly event: number;
  readonly bigTime: number;
  readonly strength: number;
  readonly hitstops: readonly Hitstop[];
  readonly cause: LaneSource | 'reaction' | 'respawn';
}
export interface ScriptShot { readonly id: number; readonly owner: string; readonly region: string; readonly spec: MotionSpec; readonly t0: number; readonly t1: number; readonly impact: string | null; readonly strength: number }
export interface ScriptFx { readonly region: string; readonly x: number; readonly y: number; readonly t: number; readonly flip?: boolean; readonly scale?: number }
export interface ScriptBanner { readonly text: string; readonly t0: number; readonly t1: number }
export interface ScriptPunch { readonly t: number; readonly kind: 'hit' | 'super' | 'drop'; readonly shake: number; readonly zoom: number; readonly flash: number; readonly ticks: number }
export interface ScriptFreeze { readonly t: number; readonly ticks: number; readonly who: readonly string[] | '*' }
export interface ScriptHidden { readonly performer: string; readonly t0: number; readonly t1: number }
export interface ScriptBase { readonly performer: string; readonly t0: number; readonly t1: number; readonly verb: ClipVerb; readonly clip: string; readonly timing: ClipTiming; readonly beats: number }

export interface Script {
  readonly window: readonly [number, number];
  readonly seed: number;
  readonly actions: ScriptAction[];
  readonly shots: ScriptShot[];
  readonly fx: ScriptFx[];
  readonly banners: ScriptBanner[];
  readonly punches: ScriptPunch[];
  readonly freezes: ScriptFreeze[];
  readonly hidden: ScriptHidden[];
  readonly bases: ScriptBase[];
  /** Event kinds that had no data in the window and were synthesised from the beat grid. */
  readonly synthesized: string[];
}

const MELEE_HITSTOP: ReadonlySet<ClipVerb> = new Set<ClipVerb>(['attack', 'special', 'swing', 'super', 'parry', 'dash']);
/** Ticks after a big frame (and its hitstop) before the performer may cut into its next action. */
const RECOVERY_TICKS = 6;

const hash32 = (a: number, b: number): number => { let h = (a ^ Math.imul(b + 0x9e3779b9, 0x85ebca6b)) >>> 0; h = Math.imul(h ^ (h >>> 16), 0x7feb352d); h = Math.imul(h ^ (h >>> 15), 0x846ca68b); return (h ^ (h >>> 16)) >>> 0; };

interface Ev { t: number; s: number }

/** Events of a kind in [t0, t1): the song map's, or (when it has none there) a pattern on the beat grid. */
function eventsOf(au: ChoreoAudio, kind: 'kick' | 'snare' | 'hat' | 'vocal', t0: number, t1: number, synth: string[]): Ev[] {
  const real = au.events(kind, t0, t1).map(([t, s]) => ({ t, s }));
  const bars = Math.max(1, au.songBarAt(t1) - au.songBarAt(t0));
  if (real.length >= Math.min(2, bars)) return real;
  if (kind === 'vocal') return real;
  if (!synth.includes(kind)) synth.push(kind);
  const out: Ev[] = [];
  const b0 = Math.floor(au.beatAt(t0)) - 1, b1 = Math.ceil(au.beatAt(t1)) + 1;
  const db = au.songDownbeats();
  const dbBeat = db.length ? Math.round(au.beatAt(db[0]!)) : 0;
  for (let b = b0; b <= b1; b++) {
    const pos = (((b - dbBeat) % 4) + 4) % 4;
    if (kind === 'kick' && (pos === 0 || pos === 2)) out.push({ t: au.timeOfBeat(b), s: pos === 0 ? 0.95 : 0.75 });
    if (kind === 'snare' && (pos === 1 || pos === 3)) out.push({ t: au.timeOfBeat(b), s: 0.8 });
    if (kind === 'hat') { out.push({ t: au.timeOfBeat(b + 0.5), s: 0.35 }); }
  }
  return out.filter((e) => e.t >= t0 && e.t < t1);
}

/** Keep the strongest events: drop the weak, enforce a minimum gap (the stronger of two close events wins) and a cap per bar. */
function thin(au: ChoreoAudio, evs: Ev[], lane: LaneSpec): Ev[] {
  let out = evs.filter((e) => e.s >= (lane.minStrength ?? 0)).sort((a, b) => a.t - b.t);
  const gap = lane.minGap ?? 0.1;
  const kept: Ev[] = [];
  for (const e of out) {
    const last = kept[kept.length - 1];
    if (last && e.t - last.t < gap) { if (e.s > last.s) kept[kept.length - 1] = e; } else kept.push(e);
  }
  out = kept;
  if (lane.maxPerBar) {
    const byBar = new Map<number, Ev[]>();
    for (const e of out) { const b = Math.floor(au.songBarAt(e.t) + 1e-6); (byBar.get(b) ?? byBar.set(b, []).get(b)!).push(e); }
    const keep = new Set<Ev>();
    for (const list of byBar.values()) for (const e of [...list].sort((a, b) => b.s - a.s || a.t - b.t).slice(0, lane.maxPerBar)) keep.add(e);
    out = out.filter((e) => keep.has(e));
  }
  return out;
}

export function choreograph(au: ChoreoAudio, pack: ChoreoPack, plan: StagePlan, window: readonly [number, number], seed = 1): Script {
  const [t0, t1] = window;
  const db = au.songDownbeats();
  const synthesized: string[] = [];
  const script: Script = { window, seed, actions: [], shots: [], fx: [], banners: [], punches: [], freezes: [], hidden: [], bases: [], synthesized };
  const phrase = Math.max(1, plan.phraseBars ?? 2);
  const bar0 = Math.floor(au.songBarAt(t0) + 1e-3);
  const byId = new Map(plan.performers.map((p) => [p.id, p] as const));
  const dirOf = (p: PerformerSpec) => (p.facing === 'right' ? 1 : -1);
  const activeSide = (t: number): 'A' | 'B' => (Math.floor((Math.floor(au.songBarAt(t) + 1e-6) - bar0) / phrase) % 2 === 0 ? 'A' : 'B');
  const turnOk = (p: PerformerSpec, lane: LaneSpec, t: number) => !lane.turn || !p.side || (lane.turn === 'call') === (p.side === activeSide(t));

  // ---- base loops per section role (one segment per section the window overlaps)
  plan.performers.forEach((p, pi) => {
    const segs: { a: number; b: number; role: SectionRole }[] = [];
    for (const s of au.sections.length ? au.sections : [{ role: 'groove' as SectionRole, start: t0, end: t1 }]) {
      const a = Math.max(t0, s.start), b = Math.min(t1, s.end);
      if (b > a + 1e-6) segs.push({ a, b, role: s.role });
    }
    if (!segs.length) segs.push({ a: t0, b: t1, role: au.sectionAt(t0).role });
    for (const seg of segs) {
      const verb = p.baseByRole?.[seg.role] ?? p.base;
      const c = pack.actorClip(p.actor, verb) ?? pack.actorClip(p.actor, 'idle');
      if (!c) continue;
      const beatSec = au.timeOfBeat(Math.floor(au.beatAt(seg.a)) + 1) - au.timeOfBeat(Math.floor(au.beatAt(seg.a)));
      script.bases.push({ performer: p.id, t0: seg.a, t1: seg.b, verb, clip: c.id, timing: c.clip, beats: loopBeats(clipTotalTicks(c.clip.hold), beatSec) });
    }
    void pi;
  });

  // ---- candidate events of every lane
  interface Cand { t: number; s: number; p: PerformerSpec; lane: LaneSpec; li: number; order: number }
  const cands: Cand[] = [];
  let order = 0;
  for (const p of plan.performers) p.lanes.forEach((lane, li) => {
    let evs: Ev[] = [];
    if (lane.source === 'kick' || lane.source === 'snare' || lane.source === 'hat' || lane.source === 'vocal') evs = eventsOf(au, lane.source, t0, t1, synthesized);
    else if (lane.source === 'downbeat') {
      const every = Math.max(1, lane.every ?? 1);
      evs = db.map((t, i) => ({ t, s: i % every === 0 ? 0.7 : -1 })).filter((e) => e.s > 0 && e.t >= t0 && e.t < t1 && Math.round(au.songBarAt(e.t)) % every === 0);
    } else {
      // the drop moment: one bar after each drop downbeat in the window (so the windup shows), or two beats after when the window is short
      for (const s of au.sections) if (s.role === 'drop' && s.start >= t0 - 0.05 && s.start < t1) {
        const bar = au.songBarAt(s.start);
        const te = au.songBarTime(Math.round(bar) + 1) < t1 - 0.4 ? au.songBarTime(Math.round(bar) + 1) : au.timeOfBeat(au.beatAt(s.start) + 2);
        if (te < t1) evs.push({ t: te, s: 1 });
      }
    }
    for (const e of thin(au, evs, lane)) if (turnOk(p, lane, e.t)) cands.push({ t: e.t, s: e.s, p, lane, li, order: order++ });
  });
  cands.sort((a, b) => a.t - b.t || a.order - b.order);

  // ---- place actions
  const dead = new Map<string, number>();
  const freeAt = new Map<string, number>(), lastAction = new Map<string, ScriptAction>(), counter = new Map<string, number>();
  let nextId = 1, shotId = 1;
  const place = (p: PerformerSpec, verbs: readonly ClipVerb[], te: number, strength: number, cause: ScriptAction['cause'], withHitstop: boolean, rot: number): ScriptAction | null => {
    for (let k = 0; k < verbs.length; k++) {
      const verb = verbs[(rot + k) % verbs.length]!;
      const c = pack.actorClip(p.actor, verb);
      if (!c) continue;
      const start = startForEvent(c.clip, te);
      if (start < (freeAt.get(p.id) ?? -Infinity) - 1e-9) continue;
      if (cause !== 'respawn' && cause !== 'reaction' && start < (dead.get(p.id) ?? -Infinity)) continue;
      if (cause === 'reaction' && te < (dead.get(p.id) ?? -Infinity)) continue;
      const ticks = withHitstop && MELEE_HITSTOP.has(verb) ? hitstopTicks(strength) : 0;
      const hitstops: Hitstop[] = ticks ? [{ t: te, ticks }] : [];
      const a: ScriptAction = { id: nextId++, performer: p.id, verb, clip: c.id, timing: c.clip, start, end: start + oneShotDuration(c.clip, hitstops), event: te, bigTime: bigFrameTime(c.clip, start), strength, hitstops, cause };
      const prev = lastAction.get(p.id);
      if (prev && prev.end > start) prev.end = start;
      lastAction.set(p.id, a);
      freeAt.set(p.id, te + (ticks + RECOVERY_TICKS) * TICK);
      script.actions.push(a);
      return a;
    }
    return null;
  };

  const face = (p: PerformerSpec) => dirOf(p);
  const react = (target: PerformerSpec, verb: ClipVerb, te: number, strength: number, hitstopTicksOfAttacker: number) => {
    const a = place(target, [verb, 'hurt'], te, strength, 'reaction', false, 0);
    if (a && hitstopTicksOfAttacker) (a.hitstops as Hitstop[]).push({ t: a.bigTime, ticks: hitstopTicksOfAttacker });
    if (a && hitstopTicksOfAttacker) a.end += hitstopTicksOfAttacker * TICK;
    return a;
  };
  const spawnAfter = (p: PerformerSpec, die: ScriptAction) => {
    // dead until the next downbeat after the death's last frame: the respawn's big frame lands on that downbeat
    const hidden: { performer: string; t0: number; t1: number } = { performer: p.id, t0: die.end, t1: t1 };
    script.hidden.push(hidden);
    const sp = pack.actorClip(p.actor, 'spawn');
    if (!sp) { hidden.t1 = die.end + 0.5; dead.set(p.id, hidden.t1); return; }
    const need = die.end + bigTick(sp.clip) * TICK;
    const te = db.find((t) => t >= need) ?? au.timeOfBeat(Math.ceil(au.beatAt(need)));
    dead.set(p.id, te);
    if (te >= t1) return;
    const a = place(p, ['spawn'], te, 0.5, 'respawn', false, 0);
    if (a) hidden.t1 = a.start;
  };

  for (const cnd of cands) {
    const { p, lane } = cnd;
    const key = `${p.id}:${cnd.li}`, n = counter.get(key) ?? 0;
    counter.set(key, n + 1);
    const rot = (n + (hash32(seed, cnd.li + p.id.length) % Math.max(1, lane.verbs.length))) % Math.max(1, lane.verbs.length);
    const a = place(p, lane.verbs, cnd.t, cnd.s, lane.source, lane.hitstop !== false && !lane.screenwide, rot);
    if (!a) continue;
    const target = lane.target ? byId.get(lane.target) : undefined;
    const hs = a.hitstops.reduce((m, h) => m + h.ticks, 0);
    if (a.verb === 'die') { script.fx.push({ region: lane.fx ?? 'burst', x: p.x, y: p.y - 14, t: a.bigTime }); spawnAfter(p, a); }
    // the impact of a melee action (or any action without a launch): spark at the reach point, reaction of the target, a punch
    if (!lane.launch && lane.fx && a.verb !== 'die') {
      const ix = p.x + face(p) * (lane.reach ?? 16), iy = p.y - 16;
      script.fx.push({ region: lane.fx, x: ix, y: iy, t: a.event, flip: p.facing === 'left' });
      if (target && lane.reaction !== 'none') react(target, lane.reaction ?? 'hurt', a.event, cnd.s, hs);
      if (hs) { script.punches.push({ t: a.event, kind: 'hit', shake: 1 + Math.round(cnd.s * 2), zoom: 1 + 0.004 * hs, flash: 0, ticks: hs }); script.freezes.push({ t: a.event, ticks: hs, who: [p.id, ...(target ? [target.id] : [])] }); }
    }
    if (lane.launch) {
      const L = lane.launch, rg = pack.regionOf(L.region, 'projectile');
      const beat0 = au.beatAt(a.event), beat1 = landingBeat(beat0, L.beats);
      const t = target ?? p;
      const origin: [number, number] = L.origin === 'sky' ? [t.x + (hash32(seed, a.id) % 40) - 20, -20] : [p.x + face(p) * (rg?.spawn[0] ?? 10), p.y - (rg?.spawn[1] ?? 14)];
      const dest: [number, number] = L.origin === 'floor' ? [t.x, t.y] : [t.x - face(p) * 4, t.y - 14];
      const count = L.model === 'spread' ? Math.max(1, L.count ?? 5) : 1;
      const flight = beat1 - beat0;
      for (let i = 0; i < count; i++) {
        const spec: MotionSpec = {
          model: L.model, from: origin, to: dest, beat0, beat1, amp: L.amp, count, index: i,
          periodBeats: L.model === 'sine' ? flight / Math.max(1, Math.round(flight)) : undefined,
        };
        script.shots.push({ id: shotId++, owner: p.id, region: L.region, spec, t0: a.event, t1: au.timeOfBeat(beat1), impact: lane.fx ?? null, strength: cnd.s });
      }
      const tl = au.timeOfBeat(beat1);
      if (lane.fx && tl < t1) {
        script.fx.push({ region: lane.fx, x: dest[0], y: dest[1], t: tl });
        if (target && lane.reaction !== 'none') react(target, lane.reaction ?? 'hurt', tl, cnd.s, 0);
        script.punches.push({ t: tl, kind: 'hit', shake: 1 + Math.round(cnd.s * 2), zoom: 1.01, flash: 0, ticks: 0 });
      }
    }
    if (lane.screenwide) {
      const ticks = 12;
      script.freezes.push({ t: a.bigTime, ticks, who: '*' });
      script.fx.push({ region: 'flash', x: p.x + face(p) * 12, y: p.y - 18, t: a.bigTime, scale: 3 });
      script.fx.push({ region: 'ring', x: p.x, y: p.y - 14, t: a.bigTime, scale: 2 });
      script.punches.push({ t: a.bigTime, kind: 'super', shake: 6, zoom: 1.08, flash: 0.55, ticks });
    }
  }

  // ---- punctuation: a banner and a screen punch at each section start inside the window, stronger on the drop
  for (const s of au.sections.length ? au.sections : []) {
    if (s.start < t0 - 0.05 || s.start >= t1) continue;
    const text = plan.banners?.[s.role], ts = Math.max(t0, s.start);
    if (text) script.banners.push({ text, t0: ts, t1: Math.min(t1, au.timeOfBeat(au.beatAt(ts) + 3)) });
    if (s.role === 'drop') script.punches.push({ t: ts, kind: 'drop', shake: 5, zoom: 1.05, flash: 0.45, ticks: 0 });
  }
  script.actions.sort((a, b) => a.start - b.start || a.id - b.id);
  script.punches.sort((a, b) => a.t - b.t);
  void TICK_RATE;
  return script;
}
