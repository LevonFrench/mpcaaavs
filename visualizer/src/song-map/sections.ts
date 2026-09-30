// Section boundaries and roles from bar-synchronous features.
//
// Boundaries: Foote checkerboard novelty on a banded bar-to-bar distance (no dense matrix, so
// memory is linear in bars for long mixes), peak-picked, snapped to downbeats by construction and
// to the 4-bar phrase grid when the phrase bar is nearly as novel. Roles: energy level, drum
// density, low-band presence and energy trend; a rising section before an energy jump is a build
// and the jump downbeat is the drop. These are heuristics, not calibrated probabilities.
import { median } from './dsp.ts';
import type { SectionRole, SongMapFeature, SongMapSection } from './types.ts';

export interface SectionInput {
  readonly fps: number;
  readonly duration: number;
  readonly islands: readonly (readonly [number, number])[];
  readonly downbeats: readonly number[];
  readonly bar0?: number;
  readonly features: Record<SongMapFeature, Float32Array>;
  readonly kicks: readonly (readonly [number, number])[];
  readonly snares: readonly (readonly [number, number])[];
  readonly hats: readonly (readonly [number, number])[];
  readonly spec: Uint8Array;
  readonly specStride: number;
  readonly chromaOffset: number;
  readonly downbeatConfidence: number;
  /** Bass pitch per frame (MIDI, 0 = unvoiced). Optional: without it low-end presence falls back to the bass band level. */
  readonly bassMidi?: Float32Array;
  /** Track length in frames, or null while it is unknown (live scan). An island that ends earlier never gets an 'outro'. */
  readonly trackFrames?: number | null;
}

export interface SectionResult { readonly sections: SongMapSection[]; readonly confidence: number; readonly boundaries: number[] }

interface Bar { voiced: number; start: number; end: number; beats: number; db: number; v: Float64Array; rms: number; low: number; bass: number; drums: number; high: number; kick: number; snare: number; hat: number }
interface Draft { a: number; b: number; start: number; end: number }

const DENSE: SongMapFeature[] = ['rms', 'low', 'mid', 'high', 'drums', 'bass', 'other', 'vocal'];
const BASS_MIDI_MAX = 47;   // below about 155 Hz: bass register
const round3 = (x: number) => Math.round(x * 1000) / 1000;

function countIn(list: readonly (readonly [number, number])[], t0: number, t1: number): number {
  let lo = 0, hi = list.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (list[m]![0] < t0) lo = m + 1; else hi = m; }
  let c = 0; for (let j = lo; j < list.length && list[j]![0] < t1; j++) c++;
  return c;
}

function bars(input: SectionInput, a: number, b: number): Bar[] {
  const { fps } = input, t0 = a / fps, t1 = Math.min(input.duration, b / fps);
  const edges = input.downbeats.filter(t => t > t0 + .05 && t < t1 - .05);
  const period = edges.length > 1 ? (edges[edges.length - 1]! - edges[0]!) / (edges.length - 1) : 2;
  // A pickup or a release tail shorter than a bar joins its neighbour: padding is not a section.
  if (edges.length > 1 && edges[0]! - t0 < .95 * period) edges.shift();
  if (edges.length > 1 && t1 - edges[edges.length - 1]! < .95 * period) edges.pop();
  const points = [t0, ...edges, t1];
  const dbIndex = (t: number) => { let best = -1, d = Infinity; for (let i = 0; i < input.downbeats.length; i++) { const e = Math.abs(input.downbeats[i]! - t); if (e < d) { d = e; best = i; } } return best; };
  const firstEdge = edges.length ? dbIndex(edges[0]!) : -1;
  const out: Bar[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const start = points[i]!, end = points[i + 1]!;
    const f0 = Math.max(a, Math.floor(start * fps)), f1 = Math.max(f0 + 1, Math.min(b, Math.floor(end * fps)));
    const v = new Float64Array(DENSE.length + 3 + 12);
    for (let k = 0; k < DENSE.length; k++) {
      const x = input.features[DENSE[k]!]; let s = 0;
      for (let f = f0; f < f1; f++) s += x[f]!;
      v[k] = s / (f1 - f0);
    }
    const beats = Math.max(.25, 4 * (end - start) / period);
    const kick = countIn(input.kicks, start, end) / beats, snare = countIn(input.snares, start, end) / beats, hat = countIn(input.hats, start, end) / beats;
    v[DENSE.length] = Math.min(2, kick); v[DENSE.length + 1] = Math.min(2, snare); v[DENSE.length + 2] = Math.min(4, hat) / 2;
    for (let c = 0; c < 12; c++) {
      let s = 0; for (let f = f0; f < f1; f++) s += input.spec[f * input.specStride + input.chromaOffset + c]!;
      v[DENSE.length + 3 + c] = s / (f1 - f0) / 255;
    }
    let voiced = 0;
    if (input.bassMidi) { for (let f = f0; f < f1; f++) { const m = input.bassMidi[f] ?? 0; if (m > 0 && m <= BASS_MIDI_MAX) voiced++; } voiced /= f1 - f0; }
    out.push({ voiced, start, end, beats, db: i === 0 ? firstEdge - 1 : dbIndex(start), v, rms: v[0]!, low: v[1]!, bass: v[5]!, high: v[3]!, drums: v[4]!, kick, snare, hat });
  }
  return out;
}

function standardize(list: Bar[]): Float64Array[] {
  const dims = list[0]?.v.length ?? 0, n = list.length;
  const out = list.map(bar => bar.v.slice());
  for (let d = 0; d < dims; d++) {
    if (d >= DENSE.length + 3) { for (const v of out) v[d] = v[d]! * .7; continue; }
    let m = 0; for (const v of out) m += v[d]!; m /= n;
    let s = 0; for (const v of out) s += (v[d]! - m) ** 2; s = Math.sqrt(s / n) + .05;
    for (const v of out) v[d] = (v[d]! - m) / s;
  }
  return out;
}

function distance(x: Float64Array, y: Float64Array): number { let s = 0; for (let d = 0; d < x.length; d++) s += (x[d]! - y[d]!) ** 2; return Math.sqrt(s); }

/** Foote novelty for a boundary before bar b with half-width K (edges truncated). */
function novelty(z: Float64Array[], b: number, K: number): number {
  const lo = Math.max(0, b - K), hi = Math.min(z.length, b + K);
  if (b - lo < 1 || hi - b < 1) return 0;
  let cross = 0, cc = 0, within = 0, wc = 0;
  for (let i = lo; i < hi; i++) for (let j = i + 1; j < hi; j++) {
    const d = distance(z[i]!, z[j]!);
    if ((i < b) !== (j < b)) { cross += d; cc++; } else { within += d; wc++; }
  }
  return cc ? cross / cc - (wc ? within / wc : 0) : 0;
}

function linearSlope(values: number[]): number {
  const n = values.length; if (n < 2) return 0;
  const mx = (n - 1) / 2, my = values.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (i - mx) * (values[i]! - my); sxx += (i - mx) ** 2; }
  return sxy / sxx;
}

interface Stats { len: number; energy: number; drums: boolean; low: boolean; rising: boolean; roll: boolean; drumRate: number; snareRate: number; silent: boolean }

function stats(list: Bar[], d: Draft, maxDrums: number, maxBass: number, pitched: boolean): Stats {
  const span = list.slice(d.a, d.b);
  const avg = (f: (bar: Bar) => number) => span.reduce((s, bar) => s + f(bar) * bar.beats, 0) / Math.max(1e-9, span.reduce((s, bar) => s + bar.beats, 0));
  const energy = avg(bar => bar.rms), drumRate = avg(bar => bar.kick + bar.snare), drumLevel = avg(bar => bar.drums), bass = avg(bar => bar.bass);
  const trend = span.map(bar => bar.rms + .5 * bar.high + .25 * Math.min(2, bar.snare));
  const rise = linearSlope(trend) * Math.max(1, span.length - 1);
  const half = Math.max(1, Math.floor(span.length / 2));
  const snareFirst = span.slice(0, half).reduce((s, bar) => s + bar.snare, 0) / half;
  const snareLast = span.slice(half).reduce((s, bar) => s + bar.snare, 0) / Math.max(1, span.length - half);
  return {
    len: span.length, energy,
    drums: drumRate >= .35 || avg(bar => bar.hat) >= .5 || drumLevel >= .7 * maxDrums,
    low: pitched ? avg(bar => bar.voiced) >= .5 : bass >= .4 * maxBass,
    rising: rise >= .12,
    roll: snareLast >= .5 && snareLast >= 1.5 * snareFirst + .1,
    drumRate,
    snareRate: avg(bar => bar.snare),
    silent: energy < .03,
  };
}

function label(list: Bar[], drafts: Draft[], pitched: boolean, atStart: boolean, atEnd: boolean): SectionRole[] {
  const maxDrums = Math.max(1e-9, ...list.map(bar => bar.drums)), maxBass = Math.max(1e-9, ...list.map(bar => bar.bass));
  const st = drafts.map(d => stats(list, d, maxDrums, maxBass, pitched));
  const n = st.length, last = n - 1;
  const maxE = Math.max(1e-9, ...st.map(s => s.energy));
  const full = st.map(s => s.drums && s.low);
  const maxFull = Math.max(1e-9, ...st.filter((_, i) => full[i]).map(s => s.energy));
  const high = st.map((s, i) => full[i]! && s.energy >= .85 * maxFull);
  // Snare rolls and rising sections build; a drop is a full, high-energy section that is not itself building.
  // A riser is also a full-drum section whose bass has been cut while the level stays up.
  const building = st.map(s => s.rising || s.roll || s.snareRate >= 1.5 || (s.drums && !s.low && s.energy >= .5 * maxE));
  const dropLike = st.map((s, i) => high[i]! && !building[i]);
  const roles = new Array<SectionRole | null>(n).fill(null);
  for (let i = last - 1; i >= 0; i--) {
    const next = roles[i + 1] === 'build' ? i + 1 : -1;
    if (building[i] && (dropLike[i + 1] || next >= 0) && st[i]!.drums !== undefined) {
      if (dropLike[i + 1] || (next >= 0 && st[i]!.energy <= st[next]!.energy + .02)) roles[i] = 'build';
    }
  }
  for (let i = 1; i < n; i++) {
    if (roles[i] || !dropLike[i]) continue;
    const prev = roles[i - 1];
    if (prev === 'build' || prev === 'drop' || (!st[i - 1]!.drums && i - 1 > 0) || (prev === null && i - 1 > 0 && st[i]!.energy - st[i - 1]!.energy >= .1)) roles[i] = 'drop';
  }
  for (let i = 0; i < n; i++) {
    if (roles[i]) continue;
    const s = st[i]!;
    if (i === 0 && atStart && (!s.drums || s.energy < .7 * maxE)) roles[i] = 'intro';
    else if (i === last && atEnd && i > 0 && (!s.drums || s.energy < .7 * maxE || st[i - 1]!.energy - s.energy > .08)) roles[i] = 'outro';
    else if (!s.drums) roles[i] = !s.low && s.len >= 4 ? 'breakdown' : 'break';
    else roles[i] = 'groove';
  }
  return roles as SectionRole[];
}

function islandSections(input: SectionInput, a: number, b: number): { drafts: Draft[]; roles: SectionRole[]; strengths: number[]; list: Bar[] } {
  const list = bars(input, a, b);
  if (!list.length) return { drafts: [], roles: [], strengths: [], list };
  const phraseRef = input.bar0 === undefined ? -1 : input.downbeats.findIndex(t => Math.abs(t - input.bar0!) < 1e-3);
  const z = standardize(list), n = list.length;
  const N = new Float64Array(n);
  for (let bar = 1; bar < n; bar++) N[bar] = .3 * novelty(z, bar, 2) + .4 * novelty(z, bar, 4) + .3 * novelty(z, bar, 8);
  const values = Array.from(N.subarray(1));
  const max = Math.max(1e-9, ...values), med = values.length ? median(values) : 0;
  const mad = values.length ? median(values.map(v => Math.abs(v - med))) : 0;
  const thr = Math.max(.25 * max, med + 1.2 * 1.4826 * mad);
  const onPhrase = (bar: number) => phraseRef < 0 || list[bar]!.db < 0 || ((list[bar]!.db - phraseRef) % 4 + 4) % 4 === 0;
  const picked = new Map<number, number>();
  for (let bar = 1; bar < n; bar++) {
    const v = N[bar]!;
    if (v < thr || v < N[bar - 1]! || (bar + 1 < n && v < N[bar + 1]!)) continue;
    let at = bar;
    if (!onPhrase(bar)) for (const p of [bar - 1, bar + 1]) if (p >= 1 && p < n && onPhrase(p) && N[p]! >= .6 * v) { at = p; break; }
    picked.set(at, Math.max(picked.get(at) ?? 0, v));
  }
  const cuts = [...picked.keys()].sort((x, y) => x - y);
  // Sections shorter than 2 bars need strong boundaries on both sides.
  const strong = (bar: number) => (picked.get(bar) ?? 0) >= .5 * max;
  const kept: number[] = [];
  for (const cut of cuts) {
    const prev = kept[kept.length - 1] ?? 0;
    if (cut - prev < 2 && !(strong(cut) && (prev === 0 || strong(prev)))) {
      if (prev !== 0 && (picked.get(cut) ?? 0) > (picked.get(prev) ?? 0)) kept[kept.length - 1] = cut;
      continue;
    }
    kept.push(cut);
  }
  // Near-silent leading/trailing bars are padding, not sections.
  const silentBar = (bar: Bar) => bar.rms < .03;
  while (kept.length && list.slice(kept[kept.length - 1]!).every(silentBar)) kept.pop();
  while (kept.length && list.slice(0, kept[0]!).every(silentBar)) kept.shift();
  const edges = [0, ...kept, n];
  const drafts: Draft[] = [];
  for (let i = 0; i + 1 < edges.length; i++) drafts.push({ a: edges[i]!, b: edges[i + 1]!, start: list[edges[i]!]!.start, end: list[edges[i + 1]! - 1]!.end });
  const roles = label(list, drafts, input.bassMidi !== undefined, a === 0, input.trackFrames !== undefined && input.trackFrames !== null && b >= input.trackFrames);
  // A build is one story into its drop: consecutive build sections merge.
  for (let i = drafts.length - 1; i > 0; i--) {
    if (roles[i] === 'build' && roles[i - 1] === 'build') {
      drafts[i - 1] = { ...drafts[i - 1]!, b: drafts[i]!.b, end: drafts[i]!.end };
      drafts.splice(i, 1); roles.splice(i, 1);
      const cut = kept.indexOf(drafts[i - 1]!.b); void cut;
    }
  }
  const final = new Set(drafts.slice(1).map(d => d.a));
  const strengths = kept.filter(cut => final.has(cut)).map(cut => Math.min(1, (picked.get(cut) ?? 0) / max));
  return { drafts, roles, strengths, list };
}

export function analyzeSections(input: SectionInput): SectionResult {
  const sections: SongMapSection[] = [], boundaries: number[] = [];
  const counts = new Map<SectionRole, number>(), strengths: number[] = [];
  const totals = new Map<SectionRole, number>();
  const pending: { role: SectionRole; start: number; end: number; energy: number }[] = [];
  for (const [a, b] of input.islands) {
    const { drafts, roles, strengths: s } = islandSections(input, a, b);
    strengths.push(...s);
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i]!, role = roles[i]!;
      const f0 = Math.floor(d.start * input.fps), f1 = Math.max(f0 + 1, Math.floor(d.end * input.fps));
      let e = 0; for (let f = f0; f < f1; f++) e += input.features.rms[f] ?? 0;
      pending.push({ role, start: d.start, end: d.end, energy: e / (f1 - f0) });
      totals.set(role, (totals.get(role) ?? 0) + 1);
      if (i > 0) boundaries.push(round3(d.start));
    }
  }
  let previous: SongMapSection | null = null, suffix = 0, base = '';
  for (const p of pending) {
    let name: string;
    if (previous && previous.role === p.role && Math.abs(previous.end - p.start) < 1e-6) {
      // A continuation of the same role (upstream drop1, drop1b).
      suffix = Math.min(suffix + 1, 25); name = base + String.fromCharCode(97 + suffix);
    } else {
      suffix = 0;
      const count = (counts.get(p.role) ?? 0) + 1; counts.set(p.role, count);
      name = base = (totals.get(p.role) ?? 0) > 1 ? `${p.role}${count}` : p.role;
    }
    const section: SongMapSection = { name, role: p.role, start: round3(p.start), end: round3(p.end), energy: round3(Math.max(0, Math.min(1, p.energy))) };
    sections.push(section); previous = section;
  }
  const boundaryStrength = strengths.length ? strengths.reduce((s, v) => s + v, 0) / strengths.length : 0;
  const confidence = sections.length ? Math.round(Math.min(1, boundaryStrength * (.5 + .5 * input.downbeatConfidence)) * 1000) / 1000 : 0;
  return { sections, confidence, boundaries };
}
