// Build-time feature derivation over the compact FeatureStore. Runs over every covered frame
// each time a map revision is published; HPSS-lite results are cached per frame and only
// recomputed where a neighbouring region was still missing.
import { GrowF32, GrowU8, clamp01, percentile, smoothEnv } from './dsp.ts';
import { CHROMA_BINS, FPS, MEL_BANDS, MEL_DB_FLOOR, type FeatureStore, type OnsetCandidate } from './frames.ts';
import type { SongMapFeature } from './types.ts';

export const FEATURE_NAMES: readonly SongMapFeature[] = ['rms', 'low', 'mid', 'high', 'vocal', 'drums', 'bass', 'other'];
const HPSS_TIME = 6;   // +-6 frames (130 ms) harmonic median
const HPSS_FREQ = 4;   // +-4 mel bands percussive median

export interface Derived {
  readonly n: number;
  readonly covered: Uint8Array;
  readonly islands: readonly (readonly [number, number])[];
  readonly features: Record<SongMapFeature, Float32Array>;
  /** Log-mel flux (all bands) and drum-band flux, 100 fps, for rhythm analysis. */
  readonly om: Float32Array;
  readonly od: Float32Array;
  readonly onsets: { kick: [number, number][]; snare: [number, number][]; hat: [number, number][]; vocal: [number, number][] };
  readonly bassMidi: Float32Array;
  /** Frame-major: MEL_BANDS normalised mel bytes then CHROMA_BINS chroma bytes. */
  readonly spec: Uint8Array;
  readonly melBandLimited: boolean;
  readonly hatBandLimited: boolean;
}

/** Per-frame HPSS-lite cache: 0 missing, 1 provisional (window truncated by a coverage gap), 2 final. */
export class HpssCache {
  readonly state = new GrowU8(1024);
  readonly perc = new GrowF32(1024);
  readonly hLow = new GrowF32(1024);
  readonly hMid = new GrowF32(1024);
  readonly hOther = new GrowF32(1024);
  bytes(): number { return this.state.data.byteLength + this.perc.data.byteLength * 4; }
}

const POWER = new Float64Array(256);
for (let q = 0; q < 256; q++) POWER[q] = Math.pow(10, (q / 2 + MEL_DB_FLOOR) / 10);

export function coveredFrames(store: FeatureStore): { n: number; covered: Uint8Array; islands: [number, number][] } {
  const n = store.frameCount ?? store.extent;
  const covered = new Uint8Array(n), islands: [number, number][] = [];
  const have = store.have.data;
  let start = -1;
  for (let f = 0; f < n; f++) {
    const ok = f < have.length && (have[f]! & 3) === 3;
    covered[f] = ok ? 1 : 0;
    if (ok && start < 0) start = f;
    if (!ok && start >= 0) { islands.push([start, f]); start = -1; }
  }
  if (start >= 0) islands.push([start, n]);
  return { n, covered, islands };
}

function updateHpss(store: FeatureStore, cache: HpssCache, n: number, covered: Uint8Array): void {
  cache.state.ensure(n); for (const g of [cache.perc, cache.hLow, cache.hMid, cache.hOther]) g.ensure(n);
  const mel = store.mel.data, centers = store.bank.centers, state = cache.state.data;
  const tbuf = new Uint8Array(2 * HPSS_TIME + 1), fbuf = new Uint8Array(2 * HPSS_FREQ + 1);
  const H = new Float64Array(MEL_BANDS);
  for (let f = 0; f < n; f++) {
    if (!covered[f] || state[f] === 2) continue;
    let complete = true;
    for (let g = f - HPSS_TIME; g <= f + HPSS_TIME; g++) if (g >= 0 && g < n && !covered[g]) { complete = false; break; }
    for (let b = 0; b < MEL_BANDS; b++) {
      let c = 0;
      for (let g = f - HPSS_TIME; g <= f + HPSS_TIME; g++) {
        if (g < 0 || g >= n || !covered[g]) continue;
        const v = mel[g * MEL_BANDS + b]!;
        let i = c++; while (i > 0 && tbuf[i - 1]! > v) { tbuf[i] = tbuf[i - 1]!; i--; } tbuf[i] = v;
      }
      H[b] = POWER[tbuf[c >> 1]!]!;
    }
    let perc = 0, low = 0, mid = 0, other = 0;
    const o = f * MEL_BANDS;
    for (let b = 0; b < MEL_BANDS; b++) {
      let c = 0;
      for (let q = Math.max(0, b - HPSS_FREQ); q <= Math.min(MEL_BANDS - 1, b + HPSS_FREQ); q++) {
        const v = mel[o + q]!;
        let i = c++; while (i > 0 && fbuf[i - 1]! > v) { fbuf[i] = fbuf[i - 1]!; i--; } fbuf[i] = v;
      }
      const p = POWER[fbuf[c >> 1]!]!, h = H[b]!, x = POWER[mel[o + b]!]!;
      const h2 = h * h, p2 = p * p, den = h2 + p2 + 1e-30;
      const xp = x * p2 / den, xh = x * h2 / den, hz = centers[b]!;
      perc += xp;
      if (hz < 250) low += xh;
      if (hz >= 300 && hz <= 3400) mid += xh;
      if (hz >= 250 && hz <= 8000) other += xh;
    }
    cache.perc.data[f] = perc; cache.hLow.data[f] = low; cache.hMid.data[f] = mid; cache.hOther.data[f] = other;
    state[f] = complete ? 2 : 1;
  }
}

function envelope(raw: Float32Array, islands: readonly (readonly [number, number])[], covered: Uint8Array): Float32Array {
  const out = raw.slice();
  for (const [a, b] of islands) smoothEnv(out, a, b, FPS);
  const ref = percentile(out, 99, covered) + 1e-12;
  for (let i = 0; i < out.length; i++) out[i] = covered[i] ? clamp01(out[i]! / ref) : 0;
  return out;
}

/** upstream strength01: 5th..95th percentile of the peak measure mapped to 0.2..1. */
function strength01(values: number[]): number[] {
  if (!values.length) return [];
  const lo = percentile(values, 5), hi = percentile(values, 95);
  return values.map(v => clamp01((v - lo) / (hi - lo + 1e-9) * .8 + .2));
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

function finalizeOnsets(store: FeatureStore, vocalRaw: Float32Array, harmonicMid: Float32Array, islands: readonly (readonly [number, number])[], covered: Uint8Array) {
  const sort = (list: OnsetCandidate[]) => [...list].sort((a, b) => a.t - b.t);
  // Kicks: low-band attacks that decay (a sustained bass note entering is not a drum hit).
  const kicks = sort(store.onsets.kick).filter(c => c.extra >= 3);
  // Snares: 1.5-5 kHz attacks with a long noisy 0.5-5 kHz tail (upstream drum_onsets rule).
  let snares = sort(store.onsets.snare);
  if (snares.length) {
    const tails = snares.map(c => c.extra), thr = percentile(tails, 95) - 25;
    snares = snares.filter((c, i) => {
      let near = -Infinity;
      for (let j = i; j >= 0 && c.t - snares[j]!.t < 2.5; j--) near = Math.max(near, tails[j]!);
      for (let j = i + 1; j < snares.length && snares[j]!.t - c.t < 2.5; j++) near = Math.max(near, tails[j]!);
      return c.extra - near > -8 && c.extra > thr;
    });
  }
  // Hats: remove attacks within 40 ms of a snare or 30 ms of a kick.
  const near = (list: OnsetCandidate[], t: number, gap: number) => {
    let lo = 0, hi = list.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (list[m]!.t < t) lo = m + 1; else hi = m; }
    return (lo < list.length && Math.abs(list[lo]!.t - t) <= gap) || (lo > 0 && Math.abs(list[lo - 1]!.t - t) <= gap);
  };
  const hats = sort(store.onsets.hat).filter(c => !near(snares, c.t, .04) && !near(kicks, c.t, .03));
  const pack = (list: OnsetCandidate[], strength: number[]) => list.map((c, i) => [round3(c.t), round3(strength[i]!)] as [number, number]);
  const kick = pack(kicks, strength01(kicks.map(c => c.db)));
  const snare = pack(snares, strength01(snares.map(c => c.extra)));
  const hat = pack(hats, strength01(hats.map(c => c.db)));
  // Vocal-ish onsets: positive log flux of the harmonic 300-3400 Hz proxy while it is active.
  const vocal: [number, number][] = [];
  const db = new Float32Array(vocalRaw.length), mdb = new Float32Array(vocalRaw.length);
  for (let f = 0; f < db.length; f++) { db[f] = 10 * Math.log10(vocalRaw[f]! + 1e-10); mdb[f] = 10 * Math.log10(harmonicMid[f]! + 1e-10); }
  const ref = percentile(db, 99, covered);
  const flux = new Float32Array(db.length);
  for (const [a, b] of islands) for (let f = a + 2; f < b; f++) flux[f] = Math.max(0, mdb[f]! - (mdb[f - 1]! + mdb[f - 2]!) / 2);
  const peaks: [number, number][] = [];
  for (const [a, b] of islands) {
    for (let f = a + 2; f < b - 8; f++) {
      const v = flux[f]!;
      if (v < 4 || v < flux[f - 1]! || v <= flux[f + 1]!) continue;
      const level = db[f + 3]!;
      if (level < ref - 20) continue;
      // A note, not a click: the harmonic mid-band stays up for at least 60 ms.
      let sustained = true;
      for (let k = 1; k <= 6; k++) if (db[f + k]! < level - 6) { sustained = false; break; }
      if (!sustained) continue;
      const last = peaks[peaks.length - 1];
      if (last && f - last[0] * FPS < 9) { if (v > last[1]) peaks[peaks.length - 1] = [f / FPS, v]; continue; }
      peaks.push([f / FPS, v]);
    }
  }
  if (peaks.length) {
    const s95 = percentile(peaks.map(p => p[1]), 95) + 1e-9;
    for (const [t, v] of peaks) vocal.push([round3(t), round3(Math.min(1, Math.max(.1, v / s95)))]);
  }
  return { kick, snare, hat, vocal };
}

/** Running minimum over +-radius frames inside each island (monotone deque, O(n)). */
function runningMin(x: Float32Array, islands: readonly (readonly [number, number])[], radius: number): Float32Array {
  const out = new Float32Array(x.length), dq = new Int32Array(x.length);
  for (const [a, b] of islands) {
    let head = 0, tail = 0, next = a;
    for (let f = a; f < b; f++) {
      const hi = Math.min(b - 1, f + radius);
      while (next <= hi) { while (tail > head && x[dq[tail - 1]!]! >= x[next]!) tail--; dq[tail++] = next++; }
      while (dq[head]! < f - radius) head++;
      out[f] = x[dq[head]!]!;
    }
  }
  return out;
}

function medianFilter5(x: Float32Array, islands: readonly (readonly [number, number])[]): Float32Array {
  const out = x.slice(), w = new Float64Array(5);
  for (const [a, b] of islands) for (let f = a; f < b; f++) {
    let c = 0;
    for (let g = f - 2; g <= f + 2; g++) { const v = g < a || g >= b ? 0 : x[g]!; let i = c++; while (i > 0 && w[i - 1]! > v) { w[i] = w[i - 1]!; i--; } w[i] = v; }
    out[f] = w[2]!;
  }
  return out;
}

export function deriveFeatures(store: FeatureStore, cache: HpssCache): Derived {
  const { n, covered, islands } = coveredFrames(store);
  updateHpss(store, cache, n, covered);
  const raw = (g: GrowF32, map?: (v: number) => number) => {
    const out = new Float32Array(n);
    for (let f = 0; f < n; f++) if (covered[f]) out[f] = map ? map(g.get(f)) : g.get(f);
    return out;
  };
  const sqrt = Math.sqrt;
  const hMid = raw(cache.hMid);
  // Vocal proxy: harmonic 300-3400 Hz energy above its 2 s floor (sustained pads sit at the floor).
  const smoothMid = new Float32Array(n);
  for (const [a, b] of islands) for (let f = a; f < b; f++) smoothMid[f] = (hMid[Math.max(a, f - 1)]! + hMid[f]! + hMid[Math.min(b - 1, f + 1)]!) / 3;
  const floor = runningMin(smoothMid, islands, 100);
  const vocalRaw = new Float32Array(n);
  for (let f = 0; f < n; f++) vocalRaw[f] = Math.max(0, hMid[f]! - 1.5 * floor[f]!);
  const features = {
    rms: envelope(raw(store.rms), islands, covered),
    low: envelope(raw(store.low), islands, covered),
    mid: envelope(raw(store.mid), islands, covered),
    high: envelope(raw(store.high), islands, covered),
    vocal: envelope(vocalRaw.map(sqrt), islands, covered),
    drums: envelope(raw(cache.perc, sqrt), islands, covered),
    bass: envelope(raw(cache.hLow, sqrt), islands, covered),
    other: envelope(raw(cache.hOther, sqrt), islands, covered),
  } satisfies Record<SongMapFeature, Float32Array>;

  // Rhythm onset envelopes from the stored log-mel frames (0.5 dB units).
  const om = new Float32Array(n), od = new Float32Array(n), mel = store.mel.data, centers = store.bank.centers;
  const drumBand = new Uint8Array(MEL_BANDS);
  for (let b = 0; b < MEL_BANDS; b++) drumBand[b] = centers[b]! < 200 || (centers[b]! >= 1500 && centers[b]! <= 10000) ? 1 : 0;
  for (const [a, b] of islands) for (let f = a + 1; f < b; f++) {
    let all = 0, drum = 0, count = 0;
    for (let q = 0; q < MEL_BANDS; q++) {
      const d = Math.max(0, mel[f * MEL_BANDS + q]! - mel[(f - 1) * MEL_BANDS + q]!) / 2;
      all += d; if (drumBand[q]) { drum += d; count++; }
    }
    om[f] = all / MEL_BANDS; od[f] = count ? drum / count : 0;
  }

  // Spectrum: per-band normalised dB (floor = max(2nd pct, global max - 80), peak = 99.5th pct), then chroma.
  const S = MEL_BANDS + CHROMA_BINS, spec = new Uint8Array(n * S);
  let coveredCount = 0; for (let f = 0; f < n; f++) coveredCount += covered[f]!;
  if (coveredCount) {
    const hist = new Int32Array(MEL_BANDS * 256);
    let maxQ = 0;
    for (let f = 0; f < n; f++) if (covered[f]) for (let b = 0; b < MEL_BANDS; b++) { const q = mel[f * MEL_BANDS + b]!; hist[b * 256 + q]!++; if (q > maxQ) maxQ = q; }
    const pct = (b: number, p: number) => {
      const target = (coveredCount - 1) * p / 100; let acc = 0;
      for (let q = 0; q < 256; q++) { acc += hist[b * 256 + q]!; if (acc > target) return q; }
      return 255;
    };
    const lo = new Float64Array(MEL_BANDS), span = new Float64Array(MEL_BANDS);
    for (let b = 0; b < MEL_BANDS; b++) {
      const l = Math.max(pct(b, 2), maxQ - 160), h = pct(b, 99.5);
      lo[b] = l; span[b] = Math.max(1e-6, h - l);
    }
    for (let f = 0; f < n; f++) {
      if (!covered[f]) continue;
      for (let b = 0; b < MEL_BANDS; b++) spec[f * S + b] = Math.round(clamp01((mel[f * MEL_BANDS + b]! - lo[b]!) / span[b]!) * 255);
    }
  }
  // Chroma at 25 fps: 3-slot smoothing (upstream 9-frame uniform filter), linear to 100 fps.
  const slots = Math.ceil(n / 4), chroma = store.chroma.data, chromaHave = store.chromaHave.data;
  const smooth = new Float32Array(slots * CHROMA_BINS), smoothHave = new Uint8Array(slots);
  for (let s = 0; s < slots; s++) {
    if (!(s < chromaHave.length && chromaHave[s])) continue;
    let count = 0;
    for (let d = -1; d <= 1; d++) {
      const t = s + d;
      if (t < 0 || t >= slots || t >= chromaHave.length || !chromaHave[t]) continue;
      count++;
      for (let k = 0; k < CHROMA_BINS; k++) smooth[s * CHROMA_BINS + k]! += chroma[t * CHROMA_BINS + k]!;
    }
    for (let k = 0; k < CHROMA_BINS; k++) smooth[s * CHROMA_BINS + k]! /= count;
    smoothHave[s] = 1;
  }
  for (let f = 0; f < n; f++) {
    if (!covered[f]) continue;
    const s0 = f >> 2, s1 = s0 + 1, frac = (f & 3) / 4;
    const a = smoothHave[s0] ? s0 : smoothHave[s1] ? s1 : -1;
    if (a < 0) continue;
    const b = s1 < slots && smoothHave[s1] ? s1 : a;
    for (let k = 0; k < CHROMA_BINS; k++) {
      const v = smooth[a * CHROMA_BINS + k]! * (a === s0 ? 1 - frac : 1) + (a === s0 ? smooth[b * CHROMA_BINS + k]! * frac : 0);
      spec[f * S + MEL_BANDS + k] = Math.round(Math.max(0, Math.min(255, v)));
    }
  }

  // Bass pitch: YIN f0 of the low path, voiced where aperiodic < 0.3 and the low band is within 30 dB of its 99th pct.
  const lowDb = new Float32Array(n);
  for (let f = 0; f < n; f++) lowDb[f] = 20 * Math.log10(store.low.get(f) + 1e-9);
  const lowRef = percentile(lowDb, 99, covered);
  const midiRaw = new Float32Array(n), pitchHave = store.pitchHave.data;
  for (let f = 0; f < n; f++) {
    if (!covered[f]) continue;
    const g = (f & 1) === 0 ? f : (f + 1 < n && pitchHave[f + 1] ? f + 1 : f - 1);
    if (g < 0 || g >= pitchHave.length || !pitchHave[g]) continue;
    const hz = store.pitchHz.get(g), aper = store.pitchAper.get(g);
    if (hz >= 30 && hz <= 320 && aper < .3 && lowDb[f]! > lowRef - 30) midiRaw[f] = 69 + 12 * Math.log2(hz / 440);
  }
  const bassMidi = medianFilter5(midiRaw, islands);

  const onsets = finalizeOnsets(store, vocalRaw, hMid, islands, covered);
  return {
    n, covered, islands, features, om, od, onsets, bassMidi, spec,
    melBandLimited: store.sampleRate / 2 < 16000,
    hatBandLimited: store.sampleRate * .45 <= 7000,
  };
}
