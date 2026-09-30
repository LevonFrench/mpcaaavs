// The show director: assigns a show's plates to any song from its song map (AAAVS addition).
//
// Upstream (bizarro/evangelion app/src/timeline.ts) is hand-cut to one song's bars. planShow() derives
// an equivalent edit from section roles, and reproduces upstream's timeline exactly on the reference
// fixture (tools/check-show-plan.mjs):
//
//  1. Section boundaries snap to the nearest downbeat; sections shorter than two bars join the previous
//     one (a one-bar break is a fill, not a plate).
//  2. A short break (<= 4 bars) right before a drop is a bridge: the show's bridge plate (NERV: plug)
//     takes the break and the first half of the drop (at most 8 bars), so its story (insertion, then the
//     lock) turns on the drop downbeat; the rest of the drop goes on as a drop plate.
//  3. Long sections split on 8-bar phrases when their length is a multiple of 8, else into near-equal
//     parts (shorter first). Max plate length per role: drops 12 bars, everything else 8 (intro and outro 16).
//  4. Plates come from per-role candidate lists in order, skipping a repeat of the previous plate; the
//     first intro part gets the intro plate and the last outro part the outro plate.
//  5. Every plate window starts and ends on a downbeat (hard cuts, including on drop downbeats) and
//     carries a bar map from its home bars, so its story resolves on the window's last bar.
import { beatsPerBarOf } from '../song-map/meter.ts';
import type { SectionRole, SongMapJSON } from '../song-map/types.ts';
import type { BarMap } from './bar-map.ts';

export interface ShowPlateDef {
  /** Home window in the show's reference bar numbering [start, end). */
  home: readonly [number, number];
}

export interface ShowDef {
  /** downbeats[k + barOff] is reference bar k (see bar-map.ts). */
  barOff: number;
  plates: Readonly<Record<string, ShowPlateDef>>;
  /** Candidate plates per section role, in preference order. */
  roles: Readonly<Record<SectionRole, readonly string[]>>;
  /** Plate for a short break leading into a drop. */
  bridge?: string;
  /** Plates reserved for the first intro part and the last outro part. */
  intro?: string;
  outro?: string;
  maxBars?: Partial<Record<SectionRole, number>>;
}

export interface PlannedPlate {
  id: string;
  role: SectionRole | 'bridge';
  start: number;
  end: number;
  /** Window in song downbeat indices [startBar, endBar). */
  startBar: number;
  endBar: number;
  barMap: BarMap;
  params: Record<string, unknown>;
}

const DEFAULT_MAX: Record<SectionRole, number> = { intro: 16, groove: 8, break: 8, build: 8, drop: 12, breakdown: 8, outro: 16 };

/** A song's downbeat grid: the map's downbeats, else every beatsPerBar-th beat (4 unless the map says otherwise), else the tempo from 0. */
export function downbeatGrid(map: SongMapJSON): number[] {
  if (map.downbeats && map.downbeats.length >= 2) return map.downbeats;
  const perBar = beatsPerBarOf(map.beatsPerBar), bar = (perBar * 60) / (map.bpm > 0 ? map.bpm : 120);
  if (map.beats && map.beats.length >= 8) {
    const out: number[] = [];
    for (let i = 0; i < map.beats.length; i += perBar) out.push(map.beats[i]!);
    return out;
  }
  const out: number[] = [];
  for (let t = 0; t < map.duration + bar; t += bar) out.push(t);
  return out;
}

/** Continuous downbeat index at t (upstream AudioData.barAt, extrapolated outside the grid). */
export function barIndexAt(d: readonly number[], t: number): number {
  if (d.length < 2) return 0;
  if (t <= d[0]!) return (t - d[0]!) / (d[1]! - d[0]!);
  if (t >= d[d.length - 1]!) return d.length - 1 + (t - d[d.length - 1]!) / (d[d.length - 1]! - d[d.length - 2]!);
  let lo = 0, hi = d.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (d[m]! <= t) lo = m; else hi = m; }
  return lo + (t - d[lo]!) / (d[hi]! - d[lo]!);
}

/** Time of downbeat index i (extrapolated with the neighbouring bar length). */
export function barIndexTime(d: readonly number[], i: number): number {
  if (i >= 0 && i < d.length) return d[i]!;
  if (d.length < 2) return 0;
  if (i < 0) return d[0]! + i * (d[1]! - d[0]!);
  return d[d.length - 1]! + (i - d.length + 1) * (d[d.length - 1]! - d[d.length - 2]!);
}

interface Seg { role: SectionRole; a: number; b: number; name: string }

/** Part lengths for a segment of n bars with a maximum of max bars per part. */
export function splitBars(n: number, max: number): number[] {
  if (n <= max) return [n];
  if (n % 8 === 0) return new Array(n / 8).fill(8);
  const k = Math.ceil(n / max), base = Math.floor(n / k), extra = n - base * k;
  return Array.from({ length: k }, (_, i) => base + (i >= k - extra ? 1 : 0));
}

export function planShow(map: SongMapJSON, show: ShowDef, params: Record<string, unknown> = {}): PlannedPlate[] {
  const d = downbeatGrid(map);
  const max = { ...DEFAULT_MAX, ...(show.maxBars ?? {}) };
  const first = Math.ceil(barIndexAt(d, 0) - 1e-3);
  const last = Math.max(first + 1, Math.ceil(barIndexAt(d, map.duration) - 1e-3));
  // 1. snap sections to downbeats
  let segs: Seg[] = [];
  const sections = map.sections.length ? map.sections : [{ name: 'song', role: 'groove' as SectionRole, start: 0, end: map.duration, energy: 0.5 }];
  sections.forEach((s, i) => {
    const a = i === 0 ? first : Math.max(first, Math.round(barIndexAt(d, s.start)));
    const b = i === sections.length - 1 ? last : Math.min(last, Math.round(barIndexAt(d, s.end)));
    if (b > a) segs.push({ role: s.role, a, b, name: s.name });
  });
  for (let i = 1; i < segs.length; i++) segs[i]!.a = segs[i - 1]!.b; // no gaps or overlaps after snapping
  segs = segs.filter((s) => s.b > s.a);
  // sections shorter than two bars join the previous one (or the next, at the start)
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (s.b - s.a >= 2 || segs.length === 1) continue;
    if (i > 0) { segs[i - 1]!.b = s.b; segs.splice(i, 1); i--; }
    else if (segs.length > 1) { segs[1]!.a = s.a; segs.splice(0, 1); i--; }
  }
  // 2 + 3. parts
  type Part = { role: SectionRole | 'bridge'; a: number; b: number; drop?: number; introFirst?: boolean; outroLast?: boolean };
  const parts: Part[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!, next = segs[i + 1];
    const n = s.b - s.a;
    if (show.bridge && s.role === 'break' && n <= 4 && next?.role === 'drop') {
      const dn = next.b - next.a, take = Math.min(8, Math.floor(dn / 2));
      parts.push({ role: 'bridge', a: s.a, b: next.a + take, drop: next.a });
      if (dn - take > 0) for (const len of splitBars(dn - take, max.drop)) parts.push({ role: 'drop', a: parts[parts.length - 1]!.b, b: parts[parts.length - 1]!.b + len });
      i++;
      continue;
    }
    let a = s.a;
    const lens = splitBars(n, max[s.role]);
    lens.forEach((len, k) => {
      parts.push({ role: s.role, a, b: a + len, introFirst: s.role === 'intro' && k === 0, outroLast: s.role === 'outro' && k === lens.length - 1 });
      a += len;
    });
  }
  // 4. plates
  const cursor: Record<string, number> = {};
  const out: PlannedPlate[] = [];
  let prev = '';
  let introUsed = false;
  for (const p of parts) {
    let id: string | undefined;
    let role: SectionRole | 'bridge' = p.role;
    if (p.role === 'bridge') id = show.bridge;
    else if (p.introFirst && show.intro && !introUsed) { id = show.intro; introUsed = true; }
    else if (p.outroLast && show.outro) id = show.outro;
    if (!id) {
      // extra intro parts play as grooves, early outro parts as breakdowns
      if (role === 'intro') role = 'groove';
      if (role === 'outro') role = 'breakdown';
      const list = show.roles[role as SectionRole].filter((x) => x in show.plates);
      if (!list.length) throw new Error(`show has no plate for role ${role}`);
      let k = cursor[role] ?? 0;
      if (list.length > 1 && list[k % list.length] === prev) k++;
      id = list[k % list.length]!;
      cursor[role] = k + 1;
    }
    const def = show.plates[id];
    if (!def) throw new Error(`unknown plate ${id}`);
    const start = p.a === first ? 0 : barIndexTime(d, p.a);
    const end = p.b === last ? map.duration : barIndexTime(d, p.b);
    const pr: Record<string, unknown> = { ...params };
    if (p.drop !== undefined) pr.drop = barIndexTime(d, p.drop);
    out.push({
      id, role, start, end, startBar: p.a, endBar: p.b, params: pr,
      barMap: { barOff: show.barOff, homeStart: def.home[0], homeEnd: def.home[1], songStart: p.a, songEnd: p.b },
    });
    prev = id;
  }
  return out;
}
