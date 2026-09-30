// Tempo, beat grid and bar phase from the song-map onset envelopes.
//
// Strategy (after bizarro/evangelion analyze.py fit_grid, generalised to any track):
// an autocorrelation comb proposes the beat period, windowed local tempi split the track into
// constant-tempo regions, each region gets a constant grid fitted to the onset envelope and
// refined by least squares on kick/snare attacks, the metrical octave is chosen from where
// kicks and snares fall, and regions are joined where the score switches from one grid to the next.
// Downbeats use the upstream "most change across the grid" rule plus backbeat evidence.
import { median, percentile } from './dsp.ts';
import type { SongMapFeature } from './types.ts';

export const MIN_BPM = 70;
export const MAX_BPM = 200;
const LOCAL_WINDOW = 1024;
const LOCAL_HOP = 256;

export interface RhythmInput {
  readonly fps: number;
  readonly duration: number;
  readonly islands: readonly (readonly [number, number])[];
  readonly om: Float32Array;
  readonly od: Float32Array;
  readonly kicks: readonly (readonly [number, number])[];
  readonly snares: readonly (readonly [number, number])[];
  readonly features: Record<SongMapFeature, Float32Array>;
  /** Frame-major spectrum bytes (mel then chroma) for harmonic-change evidence. */
  readonly spec: Uint8Array;
  readonly specStride: number;
  readonly chromaOffset: number;
}

export interface TempoRegion { readonly start: number; readonly end: number; readonly bpm: number }
export interface RhythmResult {
  readonly bpm: number;
  readonly beats: number[];
  readonly downbeats: number[];
  readonly bar0?: number;
  readonly regions: TempoRegion[];
  readonly confidence: { tempo: number; downbeat: number };
  /** Per-beat structural change score (aligned with `beats`), reused by section analysis. */
  readonly change: number[];
}

interface Grid { period: number; offset: number; score: number }
interface Region { a: number; b: number; bpm: number; grid: Grid }

const round4 = (x: number) => Math.round(x * 10000) / 10000;

function autocorr(o: Float32Array, maxLag: number): Float64Array {
  const n = o.length, R = new Float64Array(maxLag + 2);
  let mean = 0; for (let i = 0; i < n; i++) mean += o[i]!; mean /= Math.max(1, n);
  const c = new Float64Array(n); for (let i = 0; i < n; i++) c[i] = o[i]! - mean;
  for (let L = 0; L <= maxLag + 1 && L < n; L++) { let s = 0; for (let i = L; i < n; i++) s += c[i]! * c[i - L]!; R[L] = s; }
  const r0 = R[0]! || 1;
  for (let L = 0; L < R.length; L++) R[L] = R[L]! / r0;
  return R;
}
function at(R: Float64Array, x: number): number {
  const i = Math.floor(x), f = x - i;
  if (i + 1 >= R.length) return 0;
  return R[i]! * (1 - f) + R[i + 1]! * f;
}

/** Best beat-period lag (frames) by a harmonic comb over the autocorrelation. */
function combLag(R: Float64Array, fps: number, lo: number, hi: number, weights: readonly number[]): { lag: number; score: number } {
  let best = { lag: (lo + hi) / 2, score: -Infinity };
  for (let L = lo; L <= hi; L += .05) {
    let s = 0;
    for (let m = 0; m < weights.length; m++) s += weights[m]! * at(R, L * (m + 1));
    if (s > best.score) best = { lag: L, score: s };
  }
  void fps;
  return best;
}

function max3(o: Float32Array): Float32Array {
  const out = new Float32Array(o.length);
  for (let i = 0; i < o.length; i++) out[i] = Math.max(o[Math.max(0, i - 1)]!, o[i]!, o[Math.min(o.length - 1, i + 1)]!);
  return out;
}

/** Mean max3-envelope value at grid times in [t0, t1) (times relative to the island origin). */
function gridScore(m3: Float32Array, fps: number, period: number, offset: number, t0: number, t1: number): number {
  let k = Math.ceil((t0 - offset) / period), sum = 0, count = 0;
  for (let t = offset + k * period; t < t1; t = offset + (++k) * period) {
    const idx = Math.round(t * fps);
    if (idx < 1 || idx >= m3.length - 1) continue;
    sum += m3[idx]!; count++;
  }
  return count ? sum / count : 0;
}

function fitGrid(m3: Float32Array, fps: number, bpm: number, t0: number, t1: number, relRange = .015): Grid {
  let best: Grid = { period: 60 / bpm, offset: t0, score: -1 };
  for (let b = bpm * (1 - relRange); b <= bpm * (1 + relRange); b += bpm * .0004) {
    const P = 60 / b;
    for (let off = t0; off < t0 + P; off += .005) {
      const s = gridScore(m3, fps, P, off, t0, t1);
      if (s > best.score) best = { period: P, offset: off, score: s };
    }
  }
  const b0 = 60 / best.period, o0 = best.offset;
  for (let b = b0 * .9995; b <= b0 * 1.0005; b += b0 * .00002) {
    const P = 60 / b;
    for (let off = o0 - .01; off <= o0 + .01; off += .001) {
      const s = gridScore(m3, fps, P, off, t0, t1);
      if (s > best.score) best = { period: P, offset: off, score: s };
    }
  }
  return best;
}

/** Least-squares refinement of period and phase on percussive attacks close to the grid. */
function refineGrid(grid: Grid, attacks: readonly (readonly [number, number])[], t0: number, t1: number): Grid {
  let { period, offset } = grid;
  for (const tol of [.05, .03, .02]) {
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, count = 0;
    for (const [t, s] of attacks) {
      if (t < t0 || t >= t1) continue;
      const k = Math.round((t - offset) / period), r = t - (offset + k * period);
      if (Math.abs(r) > tol) continue;
      const w = .25 + s;
      sw += w; sx += w * k; sy += w * t; sxx += w * k * k; sxy += w * k * t; count++;
    }
    const den = sw * sxx - sx * sx;
    if (count < 8 || Math.abs(den) < 1e-9) break;
    const P = (sw * sxy - sx * sy) / den, off = (sy - P * sx) / sw;
    if (!(Math.abs(P / period - 1) < .005)) break;
    period = P; offset = off;
  }
  return { ...grid, period, offset };
}

function localTempi(o: Float32Array, fps: number, familyLag: number): { center: number; bpm: number; weak: boolean }[] {
  const out: { center: number; bpm: number; weak: boolean }[] = [];
  const n = o.length;
  const windows: [number, number][] = [];
  if (n < LOCAL_WINDOW) windows.push([0, n]);
  else for (let s = 0; s + LOCAL_WINDOW <= n; s += LOCAL_HOP) windows.push([s, s + LOCAL_WINDOW]);
  const lo = 60 * fps / MAX_BPM, hi = 60 * fps / MIN_BPM;
  const energies = windows.map(([s, e]) => { let sum = 0; for (let i = s; i < e; i++) sum += o[i]!; return sum / (e - s); });
  const typical = median(energies);
  for (let w = 0; w < windows.length; w++) {
    const [s, e] = windows[w]!;
    const R = autocorr(o.subarray(s, e), Math.ceil(2 * hi) + 2);
    const { lag, score } = combLag(R, fps, lo, hi, [1, .5]);
    // Windows without clear periodic onsets (pads, silence) carry no tempo evidence.
    const weak = score < .2 || energies[w]! < .3 * typical;
    // Fold to the global metrical octave.
    let folded = lag;
    while (folded < familyLag / Math.SQRT2) folded *= 2;
    while (folded > familyLag * Math.SQRT2) folded /= 2;
    out.push({ center: (s + e) / 2, bpm: 60 * fps / folded, weak });
  }
  return out;
}

function segment(all: { center: number; bpm: number; weak: boolean }[], n: number): { a: number; b: number; bpm: number }[] {
  const strong = all.filter(t => !t.weak), tempi = strong.length ? strong : all;
  if (!tempi.length) return [];
  const regions: { a: number; b: number; members: number[] }[] = [{ a: 0, b: n, members: [tempi[0]!.bpm] }];
  let deviating: number[] = [];
  for (let w = 1; w < tempi.length; w++) {
    const current = regions[regions.length - 1]!, level = median(current.members), bpm = tempi[w]!.bpm;
    if (Math.abs(bpm / level - 1) > .02) {
      deviating.push(w);
      if (deviating.length >= 3) {
        const consistent = deviating.every(i => Math.abs(tempi[i]!.bpm / tempi[deviating[0]!]!.bpm - 1) < .02);
        if (consistent) {
          const boundary = Math.round(tempi[deviating[0]!]!.center);
          current.b = boundary;
          regions.push({ a: boundary, b: n, members: deviating.map(i => tempi[i]!.bpm) });
          deviating = [];
        } else deviating.shift();
      }
    } else {
      current.members.push(bpm); deviating = [];
    }
  }
  const merged: { a: number; b: number; bpm: number }[] = [];
  for (const r of regions) {
    const bpm = median(r.members), last = merged[merged.length - 1];
    if (last && Math.abs(bpm / last.bpm - 1) < .01) { last.b = r.b; continue; }
    merged.push({ a: r.a, b: r.b, bpm });
  }
  return merged;
}

function impulses(list: readonly (readonly [number, number])[], originFrame: number, length: number, fps: number): Float32Array {
  const out = new Float32Array(length);
  for (const [t, s] of list) {
    const i = Math.round(t * fps) - originFrame;
    for (let d = -1; d <= 1; d++) if (i + d >= 0 && i + d < length) out[i + d] = Math.max(out[i + d]!, s);
  }
  return out;
}

/** Sum of an envelope at grid beats versus at the midpoints between them. */
function midpointRatio(env: Float32Array, fps: number, grid: Grid, t0: number, t1: number): { ratio: number; beats: number } {
  let beats = 0, mids = 0;
  let k = Math.ceil((t0 - grid.offset) / grid.period);
  for (let t = grid.offset + k * grid.period; t < t1; t = grid.offset + (++k) * grid.period) {
    const i = Math.round(t * fps), j = Math.round((t + grid.period / 2) * fps);
    if (i >= 0 && i < env.length) beats += env[i]!;
    if (j >= 0 && j < env.length && t + grid.period / 2 < t1) mids += env[j]!;
  }
  return { ratio: beats > 1e-9 ? mids / beats : Infinity, beats };
}

/**
 * Metrical octave. With snares present, the backbeat defines the bar: snares every other beat of the
 * fastest in-range grid mean that grid is the beat; snares every fourth beat mean the beat is half as
 * fast (unless that falls below the conventional 85 BPM). Without snares, drums landing midway between
 * beats as strongly as on them mean the grid is too slow.
 */
function chooseOctave(m3: Float32Array, ks: Float32Array, o: Float32Array, fps: number, bpm: number, t0: number, t1: number,
  attacks: readonly (readonly [number, number])[], snares: readonly (readonly [number, number])[]): { bpm: number; grid: Grid } {
  const family: number[] = [];
  for (let k = -2; k <= 2; k++) { const f = bpm * 2 ** k; if (f >= MIN_BPM && f < MAX_BPM) family.push(f); }
  if (!family.length) family.push(Math.min(MAX_BPM - 1, Math.max(MIN_BPM, bpm)));
  const fit = (f: number) => refineGrid(fitGrid(m3, fps, f, t0, t1), attacks, t0, t1);
  const fastest = family[family.length - 1]!, fastGrid = fit(fastest);
  const p = [0, 0, 0, 0];
  let onGrid = 0, offGrid = 0;
  for (const [t, s] of snares) {
    if (t < t0 || t >= t1) continue;
    const k = Math.round((t - fastGrid.offset) / fastGrid.period), r = t - (fastGrid.offset + k * fastGrid.period);
    if (Math.abs(r) < .2 * fastGrid.period) { p[((k % 4) + 4) % 4]! += s; onGrid += s; } else offGrid += s;
  }
  if (onGrid >= 4 && onGrid >= offGrid) {
    const q = p.map(v => v / onGrid);
    let top = 0; for (let i = 1; i < 4; i++) if (q[i]! > q[top]!) top = i;
    const everyFourth = q[top]! >= .5 && q[top]! >= 2 * q[(top + 2) % 4]!;
    if (everyFourth && fastest / 2 >= 85 && family.length > 1) { const g = fit(fastest / 2); return { bpm: 60 / g.period, grid: g }; }
    return { bpm: 60 / fastGrid.period, grid: fastGrid };
  }
  const evaluated = family.map(f => {
    const grid = f === fastest ? fastGrid : fit(f);
    const drums = midpointRatio(ks, fps, grid, t0, t1);
    const ratio = drums.beats > 1 ? drums.ratio : midpointRatio(o, fps, grid, t0, t1).ratio;
    return { bpm: 60 / grid.period, grid, ratio };
  });
  const valid = evaluated.filter(e => e.ratio < .6);
  const pick = valid.find(e => e.bpm >= 85) ?? valid[0] ?? evaluated[evaluated.length - 1]!;
  return { bpm: pick.bpm, grid: pick.grid };
}

function gridBeats(grid: Grid, t0: number, t1: number): number[] {
  const out: number[] = [];
  let k = Math.ceil((t0 - grid.offset) / grid.period - 1e-9);
  for (let t = grid.offset + k * grid.period; t < t1; t = grid.offset + (++k) * grid.period) out.push(t);
  return out;
}

function prefix(values: Float32Array, a: number, b: number): Float64Array {
  const p = new Float64Array(b - a + 1);
  for (let i = a; i < b; i++) p[i - a + 1] = p[i - a]! + values[i]!;
  return p;
}

interface PhaseResult { phase: number; confidence: number; change: number[] }

/** Bar phase (mod 4) of a run of beats: structural change, backbeat snares and kick emphasis. */
function barPhase(input: RhythmInput, a: number, b: number, beats: number[]): PhaseResult {
  const { fps, features } = input;
  const names: SongMapFeature[] = ['rms', 'low', 'drums', 'bass', 'other', 'high', 'vocal'];
  const sums = names.map(k => prefix(features[k], a, b));
  const chromaSums: Float64Array[] = [];
  for (let c = 0; c < 12; c++) {
    const col = new Float32Array(b - a);
    for (let f = a; f < b; f++) col[f - a] = input.spec[f * input.specStride + input.chromaOffset + c]!;
    chromaSums.push(prefix(col, 0, b - a));
  }
  const n = beats.length, energies = names.map(() => new Float64Array(n)), chroma = Array.from({ length: n }, () => new Float64Array(12));
  for (let i = 0; i < n; i++) {
    const t = beats[i]!, next = beats[i + 1] ?? t + (i > 0 ? t - beats[i - 1]! : .5);
    const f0 = Math.max(a, Math.min(b - 1, Math.round(t * fps))), f1 = Math.max(f0 + 1, Math.min(b, Math.round(next * fps)));
    for (let k = 0; k < names.length; k++) energies[k]![i] = (sums[k]![f1 - a]! - sums[k]![f0 - a]!) / (f1 - f0);
    for (let c = 0; c < 12; c++) chroma[i]![c] = (chromaSums[c]![f1 - a]! - chromaSums[c]![f0 - a]!) / (f1 - f0);
  }
  const change = new Array<number>(n).fill(0);
  change[0] = NaN; // no previous beat inside this tempo region
  for (let k = 0; k < names.length; k++) {
    const d = new Float64Array(n);
    for (let i = 1; i < n; i++) d[i] = Math.abs(Math.log(energies[k]![i]! + .01) - Math.log(energies[k]![i - 1]! + .01));
    const sd = Math.sqrt(d.reduce((s, v) => s + v * v, 0) / Math.max(1, n - 1)) + 1e-9;
    for (let i = 1; i < n; i++) change[i]! += d[i]! / sd;
  }
  {
    const d = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      let dot = 0, na = 0, nb = 0;
      for (let c = 0; c < 12; c++) { dot += chroma[i]![c]! * chroma[i - 1]![c]!; na += chroma[i]![c]! ** 2; nb += chroma[i - 1]![c]! ** 2; }
      d[i] = na > 0 && nb > 0 ? 1 - dot / Math.sqrt(na * nb) : 0;
    }
    const sd = Math.sqrt(d.reduce((s, v) => s + v * v, 0) / Math.max(1, n - 1)) + 1e-9;
    for (let i = 1; i < n; i++) change[i]! += d[i]! / sd;
  }
  const strengthNear = (list: readonly (readonly [number, number])[], t: number) => {
    let lo = 0, hi = list.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (list[m]![0] < t - .06) lo = m + 1; else hi = m; }
    let s = 0;
    for (let j = lo; j < list.length && list[j]![0] <= t + .06; j++) s = Math.max(s, list[j]![1]);
    return s;
  };
  const kick = beats.map(t => strengthNear(input.kicks, t)), snare = beats.map(t => strengthNear(input.snares, t));
  const mean = (x: number[], ph: number) => { let s = 0, c = 0; for (let i = ph; i < x.length; i += 4) if (Number.isFinite(x[i]!)) { s += x[i]!; c++; } return c ? s / c : 0; };
  const z = (v: number[]) => { const m = v.reduce((s, x) => s + x, 0) / v.length; const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length) + 1e-9; return v.map(x => (x - m) / sd); };
  const phases = [0, 1, 2, 3];
  const zc = z(phases.map(ph => mean(change, ph)));
  const zs = z(phases.map(ph => mean(snare, (ph + 1) % 4) + mean(snare, (ph + 3) % 4) - mean(snare, ph) - mean(snare, (ph + 2) % 4)));
  const zk = z(phases.map(ph => mean(kick, ph) - mean(kick, (ph + 2) % 4) * .5));
  const snareEvidence = snare.some(s => s > 0), kickEvidence = kick.some(s => s > 0);
  const scores = phases.map(ph => zc[ph]! + (snareEvidence ? .5 * zs[ph]! : 0) + (kickEvidence ? .25 * zk[ph]! : 0));
  const order = [...phases].sort((x, y) => scores[y]! - scores[x]!);
  const margin = scores[order[0]!]! - scores[order[1]!]!;
  return { phase: order[0]!, confidence: Math.max(0, Math.min(1, margin / 1.5)), change };
}

function analyzeIsland(input: RhythmInput, a: number, b: number) {
  const { fps } = input, n = b - a;
  if (n < 4 * fps) return null;
  const odRef = percentile(input.od.subarray(a, b), 99) + 1e-9, omRef = percentile(input.om.subarray(a, b), 99) + 1e-9;
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = input.od[a + i]! / odRef + input.om[a + i]! / omRef;
  const m3 = max3(o);
  const lo = 60 * fps / MAX_BPM, hi = 60 * fps / MIN_BPM;
  const R = autocorr(o, Math.ceil(4 * hi) + 2);
  const global = combLag(R, fps, lo, hi, [1, .7, .5, .35]);
  const regionsRaw = segment(localTempi(o, fps, global.lag), n);
  const t1 = n / fps;
  const origin = a / fps;
  const rel = (list: readonly (readonly [number, number])[]) => list.filter(([t]) => t >= origin && t < origin + t1).map(([t, s]) => [t - origin, s] as [number, number]);
  const kicks = rel(input.kicks), snares = rel(input.snares);
  const attacks = [...kicks, ...snares].sort((x, y) => x[0] - y[0]);
  const ks = impulses([...kicks, ...snares], 0, n, fps);
  const regions: Region[] = regionsRaw.map(r => {
    const s0 = r.a / fps, s1 = r.b / fps;
    const { bpm, grid } = chooseOctave(m3, ks, o, fps, r.bpm, s0, s1, attacks, snares);
    return { a: r.a, b: r.b, bpm, grid };
  });
  // Join neighbouring regions where the onset score switches grids.
  const beats: number[] = [];
  const regionStarts: number[] = [];
  let cursor = 0;
  for (let r = 0; r < regions.length; r++) {
    const region = regions[r]!, next = regions[r + 1];
    let end = t1;
    if (next) {
      const guess = region.b / fps, span = 10;
      const candidates = gridBeats(region.grid, Math.max(cursor, guess - span), Math.min(t1, guess + span));
      let bestT = guess, bestScore = -Infinity;
      for (const tb of [...candidates, guess]) {
        const sa = gridBeats(region.grid, Math.max(cursor, guess - span), tb).reduce((s, t) => s + (m3[Math.round(t * fps)] ?? 0), 0);
        const sb = gridBeats(next.grid, tb, Math.min(t1, guess + span)).reduce((s, t) => s + (m3[Math.round(t * fps)] ?? 0), 0);
        if (sa + sb > bestScore) { bestScore = sa + sb; bestT = tb; }
      }
      end = bestT;
    }
    regionStarts.push(beats.length);
    for (const t of gridBeats(region.grid, cursor, end)) {
      const last = beats[beats.length - 1];
      if (last !== undefined && t - last < .6 * region.grid.period) continue;
      beats.push(t);
    }
    region.a = Math.round(cursor * fps); region.b = Math.round(end * fps);
    cursor = end;
  }
  // Confidence: onset score on the grid against 8th/16th off-grid positions.
  let conf = 0, weight = 0;
  for (const region of regions) {
    const s0 = region.a / fps, s1 = region.b / fps, P = region.grid.period;
    const on = gridScore(m3, fps, P, region.grid.offset, s0, s1);
    const off = (gridScore(m3, fps, P, region.grid.offset + P / 4, s0, s1) + gridScore(m3, fps, P, region.grid.offset + P / 2, s0, s1)
      + gridScore(m3, fps, P, region.grid.offset + 3 * P / 4, s0, s1)) / 3;
    conf += Math.max(0, Math.min(1, (on - off) / (on + 1e-9) * 1.5)) * (s1 - s0); weight += s1 - s0;
  }
  const absolute = beats.map(t => t + origin).filter(t => t >= 0 && t <= input.duration);
  // Bar phase per tempo region.
  const downbeats: number[] = [], change: number[] = [];
  let downConf = 0, downWeight = 0;
  for (let r = 0; r < regions.length; r++) {
    const from = regionStarts[r]!, to = regionStarts[r + 1] ?? beats.length;
    const regionBeats = beats.slice(from, to).map(t => t + origin);
    if (!regionBeats.length) continue;
    const phase = barPhase(input, a, b, regionBeats);
    for (let i = phase.phase; i < regionBeats.length; i += 4) downbeats.push(regionBeats[i]!);
    change.push(...phase.change);
    downConf += phase.confidence * regionBeats.length; downWeight += regionBeats.length;
  }
  return {
    beats: absolute, downbeats: downbeats.filter(t => t >= 0 && t <= input.duration), change: change.slice(0, absolute.length),
    regions: regions.map(r => ({ start: round4(origin + r.a / fps), end: round4(origin + r.b / fps), bpm: r.bpm })),
    tempoConfidence: weight ? conf / weight : 0, downbeatConfidence: downWeight ? downConf / downWeight : 0, span: t1,
  };
}

export function analyzeRhythm(input: RhythmInput): RhythmResult {
  const beats: number[] = [], downbeats: number[] = [], change: number[] = [], regions: TempoRegion[] = [];
  let tc = 0, dc = 0, w = 0;
  for (const [a, b] of input.islands) {
    const result = analyzeIsland(input, a, b);
    if (!result) continue;
    beats.push(...result.beats); downbeats.push(...result.downbeats); change.push(...result.change); regions.push(...result.regions);
    tc += result.tempoConfidence * result.span; dc += result.downbeatConfidence * result.span; w += result.span;
  }
  let bpm = 0, total = 0;
  if (regions.length) {
    // Duration-weighted median tempo.
    const sorted = [...regions].sort((x, y) => x.bpm - y.bpm), span = sorted.reduce((s, r) => s + r.end - r.start, 0);
    for (const r of sorted) { total += r.end - r.start; if (total >= span / 2) { bpm = r.bpm; break; } }
  }
  // Phrase phase: the bar offset (mod 8) whose downbeats carry the most change (upstream bar0).
  let bar0: number | undefined;
  if (downbeats.length >= 8) {
    const beatIndex = new Map<number, number>(beats.map((t, i) => [t, i]));
    const bch = downbeats.map(t => change[beatIndex.get(t) ?? -1] ?? NaN);
    let best = 0, bestScore = -Infinity;
    for (let q = 0; q < 8; q++) {
      let s = 0, c = 0;
      for (let j = q; j < bch.length; j += 8) if (Number.isFinite(bch[j]!)) { s += bch[j]!; c++; }
      if (c && s / c > bestScore) { bestScore = s / c; best = q; }
    }
    bar0 = round4(downbeats[best]!);
  }
  return {
    bpm: Math.round(bpm * 1000) / 1000, beats: beats.map(round4), downbeats: downbeats.map(round4), bar0, regions,
    confidence: { tempo: w ? Math.round(tc / w * 1000) / 1000 : 0, downbeat: w ? Math.round(dc / w * 1000) / 1000 : 0 },
    change,
  };
}
