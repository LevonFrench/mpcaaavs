/**
 * Signals v2: the live-audio feature bus for HUD scenes (docs/design/HUD-PACK-ENGINE.md 3.2-3.4 and Appendix B,
 * docs/design/CONTRACT.md 2.3.8). Wired into the shared native/Player host and CPU-checked; audible and live A/V-sync acceptance remain separate.
 *
 * Pure module: no DOM, no timers, no clock, no randomness. Every output is a function of the sequence of `push` calls
 * (media time and PCM), the `snapshot` arguments and the options, so a replay after `reset()` is bit-identical.
 *
 * Runs on the main thread beside the AVS analyser: `push` once per normalised 576-sample hop (44.1 kHz, `[L576 | R576]`),
 * `snapshot` once per render request, `reset` on seek, track change or discontinuity. The snapshot is packed into a
 * `Float32Array(64)` (Appendix B) that travels in the render message; `unpackHudSignals` reads it in the worker.
 *
 * Conventions (part of signal version 2; a change bumps the version):
 * - Pan is -1 hard left .. +1 hard right (the studio worklet's `(L-R)/(L+R)` is the opposite sign). 0 for mono or silence.
 * - `t` is the media time of the newest pushed hop as given to `push` (the hop's first sample); the audio it covers ends
 *   one hop (13.06 ms) later. `dt` is the media time since the previous snapshot at a different time, clamped 0.001..0.25.
 *   Repeated snapshots at the same (or an earlier) time return the same `dt` and the same `fired` flags, so several
 *   render slots may call `snapshot` for one frame.
 * - Bands, rms, flux, contour and onsets are LIVE DECORATION: never authoritative, zero while `live` is false.
 *   `legacy` and `beat` are pass-through of the slot's own consumed AVS frame and are valid even when `live` is false.
 * - The event groups kick/snare/hat/tonal are frequency-shape heuristics, not isolated instruments; prefer `any` and the
 *   band energies for anything that must not misfire. Accuracy on real music has NOT been measured (the check uses a
 *   synthetic click track as regression bounds).
 */
import { AdaptiveMultibandDetector } from '../audio-features.ts';
import type { AvsAudioFrame } from '../avs/types.ts';

export const HUD_BANDS = ['sub', 'low', 'mid', 'high', 'air'] as const;   // Hz edges 0/80/250/2k/8k/20k, same names as the studio AudioSnapshot
export type HudBand = typeof HUD_BANDS[number];
export const HUD_GROUPS = ['kick', 'snare', 'hat', 'tonal', 'any'] as const;   // heuristic event groups, not isolated instruments
export type HudGroup = typeof HUD_GROUPS[number];
export const HUD_BAND_EDGES_HZ: readonly number[] = Object.freeze([0, 80, 250, 2000, 8000, 20000]);

export interface HudSignalOptions {
  readonly norm: { readonly releaseSec: number; readonly floorSec: number; readonly minSpan: number; readonly priors: Readonly<Record<HudBand, number>> }; // defaults 8, 4, 0.05, 0.6
  readonly rate: Readonly<Record<HudGroup, number>>;         // max accepted events per second: any 8, kick 5, snare 5, hat 8, tonal 6 (token bucket, burst 3)
  readonly contour: { readonly fastSec: number; readonly slowSec: number };  // 1 and 8
  readonly rampSec: number;                                  // 0.25: live=false until this much audio has been analysed after a reset
}
export interface HudOnset { readonly env: number; readonly fired: boolean; readonly count: number; readonly ageSec: number; readonly strength: number }
export interface HudSignalsV2 {
  readonly version: 2;
  readonly t: number;                     // media seconds of the newest analysed hop
  readonly dt: number;                    // seconds since the previous snapshot, clamped 0.001..0.25
  readonly live: boolean;                 // false = paused / silent / ramping: instruments hold rest values
  readonly rms: number;                   // 0..1 adaptively normalised broadband level
  readonly band: Readonly<Record<HudBand, number>>;    // 0..1 adaptively normalised, L/R power mean
  readonly bandL: Readonly<Record<HudBand, number>>;
  readonly bandR: Readonly<Record<HudBand, number>>;
  readonly pan: number;                   // -1 left .. +1 right; energy-weighted; 0 for mono or silence
  readonly panBand: Readonly<Record<HudBand, number>>;
  readonly width: number;                 // 0..1, S/(M+S) from the time-domain hop
  readonly flux: number;                  // 0..1 broadband positive flux, normalised
  readonly centroid: number;              // 0..1 log-frequency centroid
  readonly contour: { readonly fast: number; readonly slow: number; readonly slope: number; readonly tension: number }; // fast/slow: EMAs of the raw mean band level (not normalised); tension > 0.5 = building
  readonly onset: Readonly<Record<HudGroup, HudOnset>>;
  /** AVS detector pass-through. `level` is the RAW `beatLevel` (a sum of 576 absolute bytes, up to 73,728), not 0..1: do not divide by 255. */
  readonly beat: { readonly latched: boolean; readonly level: number };
  readonly legacy: { readonly low: number; readonly mid: number; readonly high: number; readonly level: number }; // bit-exact to nerv-scenes band(), from the slot's own consumed frame
}

export const HUD_SIGNALS_VERSION = 2;
export const HUD_SIGNAL_FLOATS = 64;
/** Appendix B, one shared table: the host packs and the worker unpacks with these offsets. Groups are HUD_GROUPS order, bands HUD_BANDS order. */
export const HUD_SIGNAL_OFFSETS = Object.freeze({
  version: 0, t: 1, dt: 2, live: 3, rms: 4, pan: 5, width: 6, flux: 7, centroid: 8,
  contour: 9, beatLatched: 13, beatLevel: 14, band: 15, bandL: 20, bandR: 25, panBand: 30,
  onsetEnv: 35, onsetFired: 40, onsetCount: 45, onsetAge: 50, onsetStrength: 55, legacy: 60,
} as const);
/** Onset counts wrap at 2^24 so they stay exact in a float32. */
export const HUD_COUNT_WRAP = 1 << 24;
export const HUD_AGE_MAX = 60;
/** Upper bound of the raw AVS `beatLevel` carried in `beat.level` (576 bytes x 128). */
export const HUD_BEAT_LEVEL_MAX = 73728;

export const DEFAULT_HUD_SIGNAL_OPTIONS: HudSignalOptions = Object.freeze({
  norm: Object.freeze({ releaseSec: 8, floorSec: 4, minSpan: 0.05, priors: Object.freeze({ sub: 0.6, low: 0.6, mid: 0.6, high: 0.6, air: 0.6 }) }),
  rate: Object.freeze({ kick: 5, snare: 5, hat: 8, tonal: 6, any: 8 }),
  contour: Object.freeze({ fastSec: 1, slowSec: 8 }),
  rampSec: 0.25,
});

// ---- analysis constants (signal version 2) ----
const SAMPLE_RATE = 44100, HOP = 576, FFT_SIZE = 2048, BINS = FFT_SIZE / 2;
const HOP_SEC = HOP / SAMPLE_RATE;
const NOMINAL_DT = 1 / 60;
const DT_MIN = 0.001, DT_MAX = 0.25;
const DISCONTINUITY_SEC = 0.5;         // a forward gap this large (or any backward step beyond half a hop) resets the bus
const STALE_SEC = 0.5;                 // a snapshot this far past the newest hop is not live
const SILENCE_RMS = 1e-4;              // -80 dBFS hop rms
const SILENCE_HOLD_SEC = 0.25;
const BURST = 3;
const LEVEL_DB_FLOOR = -100, LEVEL_DB_SPAN = 90;          // band level v = clamp01((dB + 100) / 90)
const BAND_GATE_LO = 0.05, BAND_GATE_HI = 0.15;           // v below this is silence (-95.5 dB), fully open above
const RMS_GATE_LO = 0.002, RMS_GATE_HI = 0.01;
const PAN_TAU = 0.1, WIDTH_TAU = 0.15, CENTROID_TAU = 0.1, TENSION_TAU = 0.5;
const RMS_ATTACK = 0.008, RMS_RELEASE = 0.1;
const FLUX_PEAK_PRIOR = 0.25, FLUX_PEAK_FLOOR = 0.05, FLUX_RELEASE = 0.06;
const ONSET_RELEASE: Readonly<Record<HudGroup, number>> = { kick: 0.16, snare: 0.12, hat: 0.06, tonal: 0.22, any: 0.14 };
const ONSET_CODE_TO_GROUP = [-1, 0, 1, 2, 3] as const;    // detector class code (kick, snare, hat, tonal) -> HUD_GROUPS index
const LN_20 = Math.log(20), LN_RANGE = Math.log(20000) - LN_20;
const DB_PER_LN = 20 / Math.LN10;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);   // NaN -> 0
const fin = (v: number): number => (Number.isFinite(v) ? v : 0);
const coef = (dt: number, tau: number): number => 1 - Math.exp(-dt / tau);
const levelOf = (amplitude: number): number => clamp01((DB_PER_LN * Math.log(amplitude + 1e-12) - LEVEL_DB_FLOOR) / LEVEL_DB_SPAN);
const pos = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);
const nonNeg = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
const panOf = (left: number, right: number): number => {
  const s = left + right;
  if (!(s > 1e-9)) return 0;
  const p = (right - left) / s;
  return Math.abs(p) < 1e-5 ? 0 : p;      // numerical noise of the two-real-signals FFT split must not read as pan
};

function sanitizeOptions(o?: Partial<HudSignalOptions>): HudSignalOptions {
  const d = DEFAULT_HUD_SIGNAL_OPTIONS;
  const on = (o?.norm ?? {}) as Partial<HudSignalOptions['norm']>;
  const priors = {} as Record<HudBand, number>;
  for (const b of HUD_BANDS) {
    const p = (on.priors as Partial<Record<HudBand, number>> | undefined)?.[b];
    priors[b] = typeof p === 'number' && Number.isFinite(p) ? clamp01(p) : d.norm.priors[b];   // a finite prior is clamped to 0..1
  }
  const rate = {} as Record<HudGroup, number>;
  for (const g of HUD_GROUPS) rate[g] = nonNeg((o?.rate as Partial<Record<HudGroup, number>> | undefined)?.[g], d.rate[g]);
  const oc = (o?.contour ?? {}) as Partial<HudSignalOptions['contour']>;
  return Object.freeze({
    norm: Object.freeze({ releaseSec: pos(on.releaseSec, d.norm.releaseSec), floorSec: pos(on.floorSec, d.norm.floorSec), minSpan: pos(on.minSpan, d.norm.minSpan), priors: Object.freeze(priors) }),
    rate: Object.freeze(rate),
    contour: Object.freeze({ fastSec: pos(oc.fastSec, d.contour.fastSec), slowSec: pos(oc.slowSec, d.contour.slowSec) }),
    rampSec: nonNeg(o?.rampSec, d.rampSec),
  });
}

/** Peak/floor follower. Peak: instant attack, decays toward the input over `releaseSec`. Floor: instant fall, rises toward the input over `floorSec`. */
class Track {
  peak: number; floor = 0;
  constructor(readonly prior: number) { this.peak = prior; }
  reset(): void { this.peak = this.prior; this.floor = 0; }
  step(v: number, release: number, rise: number): void {
    this.peak = v >= this.peak ? v : this.peak + (v - this.peak) * release;
    this.floor = v <= this.floor ? v : this.floor + (v - this.floor) * rise;
  }
  /** n = clamp01((v - floor) / max(peak - floor, minSpan)); a span below `minSpan` is centred so a steady input reads 0.5. */
  map(v: number, minSpan: number, gateLo: number, gateHi: number): number {
    const span = this.peak - this.floor;
    let lo = this.floor, width = span;
    if (span < minSpan) { lo = this.floor - (minSpan - span) / 2; width = minSpan; }
    const gate = clamp01((v - gateLo) / (gateHi - gateLo));
    return clamp01((v - lo) / width) * gate;
  }
}

/** Two-real-signals FFT of `L + iR`, radix-2, allocation-free. */
class Fft {
  readonly cos = new Float64Array(FFT_SIZE / 2);
  readonly sin = new Float64Array(FFT_SIZE / 2);
  readonly rev = new Uint16Array(FFT_SIZE);
  constructor() {
    for (let i = 0; i < FFT_SIZE / 2; i++) { this.cos[i] = Math.cos(-2 * Math.PI * i / FFT_SIZE); this.sin[i] = Math.sin(-2 * Math.PI * i / FFT_SIZE); }
    for (let i = 0, j = 0; i < FFT_SIZE; i++) { this.rev[i] = j; let bit = FFT_SIZE >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; }
  }
  run(re: Float64Array, im: Float64Array): void {
    const { cos, sin, rev } = this;
    for (let i = 0; i < FFT_SIZE; i++) {
      const j = rev[i]!;
      if (i < j) { let t = re[i]!; re[i] = re[j]!; re[j] = t; t = im[i]!; im[i] = im[j]!; im[j] = t; }
    }
    for (let size = 2; size <= FFT_SIZE; size <<= 1) {
      const half = size >> 1, step = FFT_SIZE / size;
      for (let base = 0; base < FFT_SIZE; base += size) {
        for (let k = 0, w = 0; k < half; k++, w += step) {
          const e = base + k, o = e + half, c = cos[w]!, s = sin[w]!;
          const tr = c * re[o]! - s * im[o]!, ti = c * im[o]! + s * re[o]!;
          re[o] = re[e]! - tr; im[o] = im[e]! - ti; re[e] = re[e]! + tr; im[e] = im[e]! + ti;
        }
      }
    }
  }
}

/** Bin ranges of the five public bands on the 21.53 Hz grid: [start, end) with bin 0 (DC) always excluded. */
const BAND_BINS: readonly (readonly [number, number])[] = HUD_BANDS.map((_, b) => {
  const binHz = SAMPLE_RATE / FFT_SIZE;
  return [Math.max(1, Math.round(HUD_BAND_EDGES_HZ[b]! / binHz)), Math.round(HUD_BAND_EDGES_HZ[b + 1]! / binHz)] as const;
});
const CENTROID_LAST_BIN = BAND_BINS[BAND_BINS.length - 1]![1];
const LN_FREQ = Float64Array.from({ length: BINS }, (_, k) => Math.log(Math.max(1, k) * SAMPLE_RATE / FFT_SIZE));

/** Legacy NERV band level, reproduced expression for expression so the values are bit-identical to nerv-scenes `band()` (the check compares them). */
function legacyBand(audio: AvsAudioFrame, start: number, end: number): number {
  let sum = 0, peak = 0;
  for (let i = start; i < end; i++) {
    const v = ((audio.spectrum[0][i] ?? 0) + (audio.spectrum[1][i] ?? 0)) / 510;
    sum += v * v; peak = Math.max(peak, v);
  }
  const value = .6 * peak + .4 * Math.sqrt(sum / Math.max(1, end - start));
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
/** The four legacy values a NERV scene derives from an AVS frame (slots 0..10, 10..93, 93..512; level is their mean). Zeros for a malformed frame. */
export function hudLegacyBands(audio: AvsAudioFrame | null | undefined): { low: number; mid: number; high: number; level: number } {
  if (!audio || !audio.spectrum || !audio.spectrum[0] || !audio.spectrum[1]) return { low: 0, mid: 0, high: 0, level: 0 };
  const low = legacyBand(audio, 0, 10), mid = legacyBand(audio, 10, 93), high = legacyBand(audio, 93, 512);
  return { low, mid, high, level: (low + mid + high) / 3 };
}

const blankOnset = (): HudOnset => ({ env: 0, fired: false, count: 0, ageSec: HUD_AGE_MAX, strength: 0 });

/** A rest snapshot: version, times and `live=false`, everything else zero (an onset age of 60). What a worker uses when the frame carries no signals. */
export function emptyHudSignals(t = 0, dt = NOMINAL_DT): HudSignalsV2 {
  const zero = (): Record<HudBand, number> => ({ sub: 0, low: 0, mid: 0, high: 0, air: 0 });
  const onset = {} as Record<HudGroup, HudOnset>;
  for (const g of HUD_GROUPS) onset[g] = blankOnset();
  return {
    version: 2, t: fin(t), dt: clamp(fin(dt), DT_MIN, DT_MAX), live: false, rms: 0, band: zero(), bandL: zero(), bandR: zero(), pan: 0, panBand: zero(),
    width: 0, flux: 0, centroid: 0, contour: { fast: 0, slow: 0, slope: 0, tension: 0 }, onset,
    beat: { latched: false, level: 0 }, legacy: { low: 0, mid: 0, high: 0, level: 0 },
  };
}

/** Packs a snapshot object into the Appendix B layout (tests and hosts that build signals by hand). Non-finite values become 0. */
export function packHudSignals(s: HudSignalsV2, out: Float32Array = new Float32Array(HUD_SIGNAL_FLOATS)): Float32Array {
  const o = HUD_SIGNAL_OFFSETS;
  out.fill(0, 0, HUD_SIGNAL_FLOATS);
  out[o.version] = HUD_SIGNALS_VERSION; out[o.t] = fin(s.t); out[o.dt] = fin(s.dt); out[o.live] = s.live ? 1 : 0;
  out[o.rms] = fin(s.rms); out[o.pan] = fin(s.pan); out[o.width] = fin(s.width); out[o.flux] = fin(s.flux); out[o.centroid] = fin(s.centroid);
  out[o.contour] = fin(s.contour.fast); out[o.contour + 1] = fin(s.contour.slow); out[o.contour + 2] = fin(s.contour.slope); out[o.contour + 3] = fin(s.contour.tension);
  out[o.beatLatched] = s.beat.latched ? 1 : 0; out[o.beatLevel] = fin(s.beat.level);
  HUD_BANDS.forEach((b, i) => { out[o.band + i] = fin(s.band[b]); out[o.bandL + i] = fin(s.bandL[b]); out[o.bandR + i] = fin(s.bandR[b]); out[o.panBand + i] = fin(s.panBand[b]); });
  HUD_GROUPS.forEach((g, i) => {
    const e = s.onset[g];
    out[o.onsetEnv + i] = fin(e.env); out[o.onsetFired + i] = e.fired ? 1 : 0; out[o.onsetCount + i] = fin(e.count) % HUD_COUNT_WRAP;
    out[o.onsetAge + i] = clamp(fin(e.ageSec), 0, HUD_AGE_MAX); out[o.onsetStrength + i] = fin(e.strength);
  });
  out[o.legacy] = fin(s.legacy.low); out[o.legacy + 1] = fin(s.legacy.mid); out[o.legacy + 2] = fin(s.legacy.high); out[o.legacy + 3] = fin(s.legacy.level);
  return out;
}

/** Reads the Appendix B layout. Returns null when the array is missing, short or of another version. Values are float32-rounded, as transported. */
export function unpackHudSignals(a: ArrayLike<number> | null | undefined): HudSignalsV2 | null {
  if (!a || a.length < HUD_SIGNAL_FLOATS || a[HUD_SIGNAL_OFFSETS.version] !== HUD_SIGNALS_VERSION) return null;
  const o = HUD_SIGNAL_OFFSETS, at = (i: number): number => fin(a[i] ?? 0);
  const bands = (base: number): Record<HudBand, number> => ({ sub: at(base), low: at(base + 1), mid: at(base + 2), high: at(base + 3), air: at(base + 4) });
  const onset = {} as Record<HudGroup, HudOnset>;
  HUD_GROUPS.forEach((g, i) => {
    onset[g] = { env: at(o.onsetEnv + i), fired: at(o.onsetFired + i) >= 0.5, count: at(o.onsetCount + i), ageSec: at(o.onsetAge + i), strength: at(o.onsetStrength + i) };
  });
  return {
    version: 2, t: at(o.t), dt: at(o.dt), live: at(o.live) >= 0.5, rms: at(o.rms), band: bands(o.band), bandL: bands(o.bandL), bandR: bands(o.bandR),
    pan: at(o.pan), panBand: bands(o.panBand), width: at(o.width), flux: at(o.flux), centroid: at(o.centroid),
    contour: { fast: at(o.contour), slow: at(o.contour + 1), slope: at(o.contour + 2), tension: at(o.contour + 3) }, onset,
    beat: { latched: at(o.beatLatched) >= 0.5, level: at(o.beatLevel) },
    legacy: { low: at(o.legacy), mid: at(o.legacy + 1), high: at(o.legacy + 2), level: at(o.legacy + 3) },
  };
}

export class HudSignalBus {
  readonly options: HudSignalOptions;
  private readonly fft = new Fft();
  private readonly win = new Float64Array(FFT_SIZE);
  private readonly winScale: number;
  private readonly ringL = new Float64Array(FFT_SIZE);
  private readonly ringR = new Float64Array(FFT_SIZE);
  private readonly re = new Float64Array(FFT_SIZE);
  private readonly im = new Float64Array(FFT_SIZE);
  private readonly magL = new Float64Array(BINS);
  private readonly magR = new Float64Array(BINS);
  private readonly spec = new Float32Array(BINS);
  private readonly detector = new AdaptiveMultibandDetector(SAMPLE_RATE, BINS, SAMPLE_RATE / HOP);
  private readonly bandTracks: Track[];
  private readonly rmsTrack: Track;
  private readonly releaseCoef: number;
  private readonly floorCoef: number;
  private readonly bucket: Float64Array;                 // per-group token bucket
  private readonly envDecay: Float64Array;
  private readonly fastCoef: number;
  private readonly slowCoef: number;
  // per-hop state
  private hops = 0;                                      // hops analysed since the last reset
  private lastT = 0;
  private silentSec = 0;
  private rmsEnv = 0;
  private fluxPeak = FLUX_PEAK_PRIOR;
  private fluxEnv = 0;
  private smL = new Float64Array(5);                     // smoothed band energies (sum of squared magnitudes) for pan
  private smR = new Float64Array(5);
  private smMid = 0; private smSide = 0;                 // smoothed M/S mean squares for width
  private smNum = 0; private smDen = 0;                  // smoothed centroid numerator / denominator
  private contourFast = 0; private contourSlow = 0; private tension = 0.5;
  // published values (updated by push)
  private readonly nBand = new Float64Array(5);
  private readonly nBandL = new Float64Array(5);
  private readonly nBandR = new Float64Array(5);
  private readonly nPanBand = new Float64Array(5);
  private nRms = 0; private nPan = 0; private nWidth = 0; private nFlux = 0; private nCentroid = 0;
  private readonly env = new Float64Array(5);
  private readonly strength = new Float64Array(5);
  private readonly total = new Float64Array(5);          // accepted events since reset (not wrapped)
  private readonly lastFire = new Float64Array(5).fill(-Infinity);
  // snapshot state
  private snapT = -Infinity;
  private snapDt = NOMINAL_DT;
  private readonly firedBase = new Float64Array(5);
  private readonly fired = new Uint8Array(5);

  constructor(options?: Partial<HudSignalOptions>) {
    const opt = this.options = sanitizeOptions(options);
    let wsum = 0;
    for (let i = 0; i < FFT_SIZE; i++) { this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)); wsum += this.win[i]!; }
    this.winScale = 2 / wsum;
    this.bandTracks = HUD_BANDS.map(b => new Track(opt.norm.priors[b]));
    this.rmsTrack = new Track(HUD_BANDS.reduce((s, b) => s + opt.norm.priors[b], 0) / HUD_BANDS.length);
    this.releaseCoef = coef(HOP_SEC, opt.norm.releaseSec);
    this.floorCoef = coef(HOP_SEC, opt.norm.floorSec);
    this.fastCoef = coef(HOP_SEC, opt.contour.fastSec);
    this.slowCoef = coef(HOP_SEC, opt.contour.slowSec);
    this.bucket = new Float64Array(5);
    this.envDecay = Float64Array.from(HUD_GROUPS, g => Math.exp(-HOP_SEC / ONSET_RELEASE[g]));
    this.reset();
  }

  /** Seek, track change, discontinuity: forgets all history; `live` stays false for `rampSec` of new audio. */
  reset(): void {
    this.ringL.fill(0); this.ringR.fill(0);
    this.detector.reset();
    for (const t of this.bandTracks) t.reset();
    this.rmsTrack.reset();
    this.hops = 0; this.lastT = 0; this.silentSec = 0; this.rmsEnv = 0; this.fluxPeak = FLUX_PEAK_PRIOR; this.fluxEnv = 0;
    this.smL.fill(0); this.smR.fill(0); this.smMid = 0; this.smSide = 0; this.smNum = 0; this.smDen = 0;
    this.contourFast = 0; this.contourSlow = 0; this.tension = 0.5;
    this.nBand.fill(0); this.nBandL.fill(0); this.nBandR.fill(0); this.nPanBand.fill(0);
    this.nRms = 0; this.nPan = 0; this.nWidth = 0; this.nFlux = 0; this.nCentroid = 0;
    this.env.fill(0); this.strength.fill(0); this.total.fill(0); this.lastFire.fill(-Infinity);
    HUD_GROUPS.forEach((g, i) => { this.bucket[i] = this.options.rate[g] > 0 ? BURST : 0; });
    this.snapT = -Infinity; this.snapDt = NOMINAL_DT; this.firedBase.fill(0); this.fired.fill(0);
  }

  /**
   * One normalised hop: `pcm` is `[L576 | R576]` at 44.1 kHz, `mediaTime` the media time of its first sample. A hop with the wrong
   * length or a non-finite time is ignored; non-finite samples read as 0 and samples are clamped to +-1. A time that steps back by more
   * than half a hop or forward by more than 0.5 s counts as a discontinuity and resets first; a duplicate (within half a hop) is dropped.
   */
  push(pcm: Float32Array, mediaTime: number): void {
    if (!pcm || pcm.length !== 2 * HOP || !Number.isFinite(mediaTime)) return;
    if (this.hops > 0) {
      const d = mediaTime - this.lastT;
      if (d < -HOP_SEC * 0.5 || d > DISCONTINUITY_SEC) this.reset();
      else if (Math.abs(d) < HOP_SEC * 0.5) return;
    }
    const opt = this.options;
    // ---- time domain: ring, hop energies ----
    const ringL = this.ringL, ringR = this.ringR;
    ringL.copyWithin(0, HOP); ringR.copyWithin(0, HOP);
    let sl = 0, sr = 0, sm = 0, ss = 0;
    for (let i = 0; i < HOP; i++) {
      const a = pcm[i]!, b = pcm[HOP + i]!;
      const l = a > 1 ? 1 : a < -1 ? -1 : a === a ? a : 0, r = b > 1 ? 1 : b < -1 ? -1 : b === b ? b : 0;
      ringL[FFT_SIZE - HOP + i] = l; ringR[FFT_SIZE - HOP + i] = r;
      sl += l * l; sr += r * r;
      const m = (l + r) * 0.5, s = (l - r) * 0.5;
      sm += m * m; ss += s * s;
    }
    this.hops++;
    this.lastT = mediaTime;
    const elapsed = this.hops * HOP_SEC;
    const hopRms = Math.sqrt((sl + sr) / (2 * HOP));
    this.silentSec = hopRms < SILENCE_RMS ? this.silentSec + HOP_SEC : 0;

    // ---- spectrum: one complex FFT for both channels ----
    const { re, im, magL, magR, spec, win, winScale } = this;
    for (let i = 0; i < FFT_SIZE; i++) { re[i] = ringL[i]! * win[i]!; im[i] = ringR[i]! * win[i]!; }
    this.fft.run(re, im);
    let sumLin = 0, sumLog = 0;
    magL[0] = 0; magR[0] = 0; spec[0] = 0;
    for (let k = 1; k < BINS; k++) {
      const j = FFT_SIZE - k;
      const lr = (re[k]! + re[j]!) / 2, li = (im[k]! - im[j]!) / 2, rr = (im[k]! + im[j]!) / 2, ri = (re[j]! - re[k]!) / 2;
      const ml = Math.sqrt(lr * lr + li * li) * winScale, mr = Math.sqrt(rr * rr + ri * ri) * winScale;
      magL[k] = ml; magR[k] = mr;
      const db = DB_PER_LN * Math.log((ml + mr) / 2 + 1e-12);
      const v = clamp01((db + 100) / 70);          // the AnalyserNode dB curve the shared detector expects
      spec[k] = v; sumLin += v; sumLog += Math.log(v + 1e-6);
    }
    const flat = sumLin > 0 ? Math.exp(sumLog / (BINS - 1)) / (sumLin / (BINS - 1)) : 0;
    const det = this.detector.analyse(spec, 1, elapsed, HOP_SEC, flat);

    // ---- bands, adaptive normalisation, pan ----
    const release = this.releaseCoef, rise = this.floorCoef, minSpan = opt.norm.minSpan, panCoef = coef(HOP_SEC, PAN_TAU);
    let meanLevel = 0, totalL = 0, totalR = 0;
    for (let b = 0; b < 5; b++) {
      const [s, e] = BAND_BINS[b]!;
      let el = 0, er = 0;
      for (let k = s; k < e; k++) { el += magL[k]! * magL[k]!; er += magR[k]! * magR[k]!; }
      const n = Math.max(1, e - s);
      const track = this.bandTracks[b]!;
      const vMean = levelOf(Math.sqrt((el + er) / (2 * n)));
      track.step(vMean, release, rise);
      const nb = track.map(vMean, minSpan, BAND_GATE_LO, BAND_GATE_HI);
      this.nBand[b] = nb; meanLevel += vMean;
      this.nBandL[b] = track.map(levelOf(Math.sqrt(el / n)), minSpan, BAND_GATE_LO, BAND_GATE_HI);
      this.nBandR[b] = track.map(levelOf(Math.sqrt(er / n)), minSpan, BAND_GATE_LO, BAND_GATE_HI);
      const sL = this.smL[b]! + (el - this.smL[b]!) * panCoef, sR = this.smR[b]! + (er - this.smR[b]!) * panCoef;
      this.smL[b] = sL; this.smR[b] = sR;
      this.nPanBand[b] = panOf(Math.sqrt(sL), Math.sqrt(sR));
      totalL += sL; totalR += sR;
    }
    this.nPan = panOf(Math.sqrt(totalL), Math.sqrt(totalR));
    meanLevel /= 5;

    // ---- broadband level, width, centroid ----
    const rmsCoef = coef(HOP_SEC, hopRms > this.rmsEnv ? RMS_ATTACK : RMS_RELEASE);
    this.rmsEnv += (hopRms - this.rmsEnv) * rmsCoef;
    const vRms = clamp01(this.rmsEnv * 4);         // the studio's level before normalisation
    this.rmsTrack.step(vRms, release, rise);
    this.nRms = this.rmsTrack.map(vRms, minSpan, RMS_GATE_LO, RMS_GATE_HI);
    const wCoef = coef(HOP_SEC, WIDTH_TAU);
    this.smMid += (sm / HOP - this.smMid) * wCoef; this.smSide += (ss / HOP - this.smSide) * wCoef;
    const mN = Math.sqrt(this.smMid), sN = Math.sqrt(this.smSide);
    this.nWidth = mN + sN > 1e-5 ? sN / (mN + sN) : 0;
    let num = 0, den = 0;
    for (let k = 1; k < CENTROID_LAST_BIN; k++) { const w = (magL[k]! + magR[k]!) * 0.5; num += w * LN_FREQ[k]!; den += w; }
    const cCoef = coef(HOP_SEC, CENTROID_TAU);
    this.smNum += (num - this.smNum) * cCoef; this.smDen += (den - this.smDen) * cCoef;
    this.nCentroid = this.smDen > 1e-9 ? clamp01((this.smNum / this.smDen - LN_20) / LN_RANGE) : 0;

    // ---- flux ----
    const flux = fin(det.flux);
    this.fluxPeak = Math.max(flux, this.fluxPeak * Math.exp(-HOP_SEC / opt.norm.releaseSec));
    this.fluxEnv = Math.max(clamp01(flux / Math.max(this.fluxPeak, FLUX_PEAK_FLOOR)), this.fluxEnv * Math.exp(-HOP_SEC / FLUX_RELEASE));
    this.nFlux = this.fluxEnv;

    // ---- contour ----
    // The contour follows the raw mean band level (dB-mapped, not adaptively normalised: normaliser warm-up would read as a fade).
    // Both averages track the input until the 2048-sample window has filled, so the partial first windows do not read as a build.
    if (this.hops <= FFT_SIZE / HOP + 1) { this.contourFast = meanLevel; this.contourSlow = meanLevel; }
    else { this.contourFast += (meanLevel - this.contourFast) * this.fastCoef; this.contourSlow += (meanLevel - this.contourSlow) * this.slowCoef; }
    const slope = clamp((this.contourFast - this.contourSlow) / 0.25, -1, 1);
    this.tension += (clamp01(0.5 + 2.2 * slope) - this.tension) * coef(HOP_SEC, TENSION_TAU);

    // ---- onsets: decay, refill buckets, accept through the rate limit ----
    for (let g = 0; g < 5; g++) {
      this.env[g] = this.env[g]! * this.envDecay[g]!;
      this.bucket[g] = Math.min(BURST, this.bucket[g]! + opt.rate[HUD_GROUPS[g]!] * HOP_SEC);
    }
    const code = det.onsetClassCode;
    if (code > 0 && code < ONSET_CODE_TO_GROUP.length) {
      const strength = clamp01(fin(det.onsetStrength));
      for (const g of [ONSET_CODE_TO_GROUP[code]!, 4]) {
        if (this.bucket[g]! < 1) continue;
        this.bucket[g] = this.bucket[g]! - 1;
        this.env[g] = Math.max(this.env[g]!, strength);
        this.strength[g] = strength; this.total[g] = this.total[g]! + 1; this.lastFire[g] = mediaTime;
      }
    }
  }

  /**
   * One per render request. `avs` is that slot's consumed (max-held) frame and feeds only `legacy` and `beat`. Returns a new packed
   * `Float32Array(64)` (Appendix B), or fills `out` when given. Never throws: a malformed `avs` gives zero legacy values.
   */
  snapshot(mediaTime: number, avs: AvsAudioFrame, out: Float32Array = new Float32Array(HUD_SIGNAL_FLOATS)): Float32Array {
    if (Number.isFinite(mediaTime) && mediaTime > this.snapT + 1e-9) {
      this.snapDt = this.snapT === -Infinity ? NOMINAL_DT : clamp(mediaTime - this.snapT, DT_MIN, DT_MAX);
      this.snapT = mediaTime;
      for (let g = 0; g < 5; g++) { this.fired[g] = this.total[g] !== this.firedBase[g] ? 1 : 0; this.firedBase[g] = this.total[g]!; }
    }
    const o = HUD_SIGNAL_OFFSETS, opt = this.options;
    out.fill(0, 0, HUD_SIGNAL_FLOATS);
    const t = this.hops > 0 ? this.lastT : fin(mediaTime);
    const stale = this.hops === 0 || (Number.isFinite(mediaTime) && mediaTime - this.lastT > STALE_SEC);
    const live = !stale && this.hops * HOP_SEC >= opt.rampSec && this.silentSec < SILENCE_HOLD_SEC;
    out[o.version] = HUD_SIGNALS_VERSION; out[o.t] = t; out[o.dt] = this.snapDt; out[o.live] = live ? 1 : 0;
    if (live) {
      out[o.rms] = this.nRms; out[o.pan] = this.nPan; out[o.width] = this.nWidth; out[o.flux] = this.nFlux; out[o.centroid] = this.nCentroid;
      out[o.contour] = this.contourFast; out[o.contour + 1] = this.contourSlow;
      out[o.contour + 2] = clamp((this.contourFast - this.contourSlow) / 0.25, -1, 1); out[o.contour + 3] = this.tension;
      for (let b = 0; b < 5; b++) { out[o.band + b] = this.nBand[b]!; out[o.bandL + b] = this.nBandL[b]!; out[o.bandR + b] = this.nBandR[b]!; out[o.panBand + b] = this.nPanBand[b]!; }
      for (let g = 0; g < 5; g++) { out[o.onsetEnv + g] = this.env[g]!; out[o.onsetFired + g] = this.fired[g]!; out[o.onsetStrength + g] = this.strength[g]!; }
    }
    for (let g = 0; g < 5; g++) {
      out[o.onsetCount + g] = this.total[g]! % HUD_COUNT_WRAP;
      out[o.onsetAge + g] = this.lastFire[g] === -Infinity ? HUD_AGE_MAX : clamp(this.lastT - this.lastFire[g]!, 0, HUD_AGE_MAX);
    }
    if (avs) {
      out[o.beatLatched] = avs.beat === true ? 1 : 0;
      out[o.beatLevel] = clamp(fin(Number(avs.beatLevel)), 0, HUD_COUNT_WRAP);
    }
    const legacy = hudLegacyBands(avs);
    out[o.legacy] = legacy.low; out[o.legacy + 1] = legacy.mid; out[o.legacy + 2] = legacy.high; out[o.legacy + 3] = legacy.level;
    return out;
  }
}
