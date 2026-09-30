// Deterministic DSP kernels for the song-map scanner. No platform FFT, no wall clock,
// no allocation in per-sample or per-frame paths. The radix-2 structure mirrors the
// offline analyzer's fixed 512-point FFT, generalised to any power-of-two size.

/** Real-input FFT of size n (power of two) computed as one n/2-point complex FFT. */
export class RealFft {
  readonly size: number;
  private readonly half: number;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly reverse: Uint32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly postCos: Float64Array;
  private readonly postSin: Float64Array;
  /** Power spectrum |X[k]|^2 for k = 0..n/2, written by `power()`. */
  readonly out: Float64Array;

  constructor(size: number) {
    if (!Number.isInteger(Math.log2(size)) || size < 8) throw new RangeError('RealFft size must be a power of two >= 8');
    this.size = size;
    const half = size >> 1;
    this.half = half;
    this.re = new Float64Array(half);
    this.im = new Float64Array(half);
    this.reverse = new Uint32Array(half);
    const bits = Math.log2(half);
    for (let i = 0; i < half; i++) {
      let value = i, reversed = 0;
      for (let b = 0; b < bits; b++) { reversed = (reversed << 1) | (value & 1); value >>>= 1; }
      this.reverse[i] = reversed;
    }
    this.cos = new Float64Array(half >> 1 || 1);
    this.sin = new Float64Array(half >> 1 || 1);
    for (let i = 0; i < (half >> 1); i++) {
      const a = -2 * Math.PI * i / half;
      this.cos[i] = Math.cos(a); this.sin[i] = Math.sin(a);
    }
    this.postCos = new Float64Array(half);
    this.postSin = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      const a = -2 * Math.PI * k / size;
      this.postCos[k] = Math.cos(a); this.postSin[k] = Math.sin(a);
    }
    this.out = new Float64Array(half + 1);
  }

  /** input.length === size (already windowed). Writes the power spectrum into `out`. */
  power(input: Float64Array): Float64Array {
    const { half, re, im, reverse } = this;
    for (let i = 0; i < half; i++) {
      const j = reverse[i]!;
      re[j] = input[2 * i]!;
      im[j] = input[2 * i + 1]!;
    }
    for (let size = 2; size <= half; size <<= 1) {
      const h = size >> 1, step = half / size;
      for (let base = 0; base < half; base += size) {
        for (let o = 0; o < h; o++) {
          const t = o * step, c = this.cos[t]!, s = this.sin[t]!;
          const u = base + o, l = u + h;
          const lr = re[l]! * c - im[l]! * s, li = re[l]! * s + im[l]! * c;
          const ur = re[u]!, ui = im[u]!;
          re[u] = ur + lr; im[u] = ui + li; re[l] = ur - lr; im[l] = ui - li;
        }
      }
    }
    const out = this.out;
    // Split the packed spectrum Z into the even/odd real sequences' spectra.
    const r0 = re[0]!, i0 = im[0]!;
    out[0] = (r0 + i0) * (r0 + i0);
    out[half] = (r0 - i0) * (r0 - i0);
    for (let k = 1; k < half; k++) {
      const ar = re[k]!, ai = im[k]!, br = re[half - k]!, bi = -im[half - k]!;
      const er = (ar + br) * .5, ei = (ai + bi) * .5;
      const or = (ai - bi) * .5, oi = -(ar - br) * .5;
      const c = this.postCos[k]!, s = this.postSin[k]!;
      const xr = er + or * c - oi * s, xi = ei + or * s + oi * c;
      out[k] = xr * xr + xi * xi;
    }
    return out;
  }
}

export function hann(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = .5 - .5 * Math.cos(2 * Math.PI * i / size);
  return w;
}

/** Second-order section, direct form II transposed, float64 state. */
export class Biquad {
  private z1 = 0; private z2 = 0;
  constructor(private b0: number, private b1: number, private b2: number, private a1: number, private a2: number) {}
  static lowpass(hz: number, rate: number, q: number): Biquad {
    const w = 2 * Math.PI * hz / rate, c = Math.cos(w), alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha;
    return new Biquad((1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, -2 * c / a0, (1 - alpha) / a0);
  }
  static highpass(hz: number, rate: number, q: number): Biquad {
    const w = 2 * Math.PI * hz / rate, c = Math.cos(w), alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha;
    return new Biquad((1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - alpha) / a0);
  }
  reset(): void { this.z1 = 0; this.z2 = 0; }
  push(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** Fourth-order Butterworth low/high-pass (two cascaded sections). Disabled (outputs 0) above 0.45 * rate. */
export class Butter4 {
  private readonly a: Biquad | null;
  private readonly b: Biquad | null;
  readonly enabled: boolean;
  constructor(kind: 'low' | 'high', hz: number, rate: number) {
    this.enabled = hz > 0 && hz < rate * .45;
    const make = kind === 'low' ? Biquad.lowpass : Biquad.highpass;
    this.a = this.enabled ? make(hz, rate, 0.5411961) : null;
    this.b = this.enabled ? make(hz, rate, 1.3065630) : null;
  }
  reset(): void { this.a?.reset(); this.b?.reset(); }
  push(x: number): number { return this.a && this.b ? this.b.push(this.a.push(x)) : 0; }
}

/** Slaney mel scale (librosa default, htk=false). */
export function hzToMel(hz: number): number {
  const fSp = 200 / 3, minLogHz = 1000, minLogMel = minLogHz / fSp, logStep = Math.log(6.4) / 27;
  return hz >= minLogHz ? minLogMel + Math.log(hz / minLogHz) / logStep : hz / fSp;
}
export function melToHz(mel: number): number {
  const fSp = 200 / 3, minLogHz = 1000, minLogMel = minLogHz / fSp, logStep = Math.log(6.4) / 27;
  return mel >= minLogMel ? minLogHz * Math.exp(logStep * (mel - minLogMel)) : fSp * mel;
}

export interface MelBank {
  readonly bands: number;
  readonly centers: Float64Array;
  /** Sparse filters: first bin and weights per band. */
  readonly first: Int32Array;
  readonly weights: Float64Array[];
}

/**
 * Triangular Slaney-normalised mel filters over an FFT of `size` at `rate`. Filters narrower than
 * one FFT bin are widened to the bin spacing so no band is empty at coarse resolution; bands above
 * Nyquist are all-zero (reported as band-limited by the caller).
 */
export function melBank(bands: number, fmin: number, fmax: number, size: number, rate: number): MelBank {
  const bins = size / 2 + 1, df = rate / size, nyquist = rate / 2;
  const mMin = hzToMel(fmin), mMax = hzToMel(fmax);
  const edges = new Float64Array(bands + 2);
  for (let i = 0; i < bands + 2; i++) edges[i] = melToHz(mMin + (mMax - mMin) * i / (bands + 1));
  const first = new Int32Array(bands), weights: Float64Array[] = [], centers = new Float64Array(bands);
  for (let b = 0; b < bands; b++) {
    let lo = edges[b]!, mid = edges[b + 1]!, hi = edges[b + 2]!;
    centers[b] = mid;
    if (mid >= nyquist) { first[b] = 0; weights.push(new Float64Array(0)); continue; }
    lo = Math.min(lo, mid - df); hi = Math.max(hi, mid + df);
    const start = Math.max(0, Math.ceil(lo / df)), end = Math.min(bins - 1, Math.floor(hi / df));
    const w = new Float64Array(Math.max(0, end - start + 1));
    let sum = 0;
    for (let k = start; k <= end; k++) {
      const f = k * df;
      const v = f <= mid ? (f - lo) / (mid - lo) : (hi - f) / (hi - mid);
      w[k - start] = Math.max(0, v); sum += Math.max(0, v);
    }
    // Slaney normalisation: unit area in Hz, so band powers are densities (also for widened filters).
    for (let k = 0; k < w.length; k++) w[k] = sum > 0 ? w[k]! / (sum * df) : 0;
    first[b] = start; weights.push(w);
  }
  return { bands, centers, first, weights };
}

/** Windowed-sinc kernel table for fractional-position resampling (cutoff relative to the input rate). */
export class SincTable {
  readonly half: number;
  readonly phases = 256;
  readonly kernels: Float64Array[];
  constructor(inRate: number, outRate: number, zeroCrossings = 16) {
    const ratio = Math.min(1, outRate / inRate), cutoff = .45 * ratio * 2; // normalised to input Nyquist = 1
    this.half = Math.ceil(zeroCrossings / ratio);
    this.kernels = [];
    for (let p = 0; p < this.phases; p++) {
      const k = new Float64Array(2 * this.half + 1); let sum = 0;
      for (let i = -this.half; i <= this.half; i++) {
        const x = i - p / this.phases, v = cutoff * x;
        const sinc = Math.abs(v) < 1e-12 ? 1 : Math.sin(Math.PI * v) / (Math.PI * v);
        const w = .5 + .5 * Math.cos(Math.PI * x / (this.half + 1));
        k[i + this.half] = sinc * w; sum += sinc * w;
      }
      for (let i = 0; i < k.length; i++) k[i] = k[i]! / sum;
      this.kernels.push(k);
    }
  }
}

/** Symmetric FIR lowpass taps (windowed sinc), cutoff in Hz at `rate`. */
export function firLowpass(cutoffHz: number, rate: number, half: number): Float64Array {
  const taps = new Float64Array(2 * half + 1), fc = 2 * cutoffHz / rate; let sum = 0;
  for (let i = -half; i <= half; i++) {
    const v = fc * i, sinc = i === 0 ? 1 : Math.sin(Math.PI * v) / (Math.PI * v);
    const w = .5 + .5 * Math.cos(Math.PI * i / (half + 1));
    taps[i + half] = sinc * w; sum += sinc * w;
  }
  for (let i = 0; i < taps.length; i++) taps[i] = taps[i]! / sum;
  return taps;
}

/** One-pole follower with fast attack and slower release (upstream smooth_env). */
export function smoothEnv(x: Float32Array, start: number, end: number, fps: number, attack = .010, release = .090): void {
  const aa = Math.exp(-1 / (attack * fps)), ar = Math.exp(-1 / (release * fps));
  let s = 0;
  for (let i = start; i < end; i++) {
    const v = x[i]!, a = v > s ? aa : ar;
    s = a * s + (1 - a) * v;
    x[i] = s;
  }
}

/** Percentile (linear interpolation, numpy default) of the values selected by `mask`. */
export function percentile(values: ArrayLike<number>, pct: number, mask?: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < values.length; i++) if (!mask || mask[i]) n++;
  if (n === 0) return 0;
  const copy = new Float64Array(n); let j = 0;
  for (let i = 0; i < values.length; i++) if (!mask || mask[i]) copy[j++] = values[i]!;
  copy.sort();
  const pos = (n - 1) * pct / 100, lo = Math.floor(pos), f = pos - lo;
  return lo + 1 < n ? copy[lo]! * (1 - f) + copy[lo + 1]! * f : copy[lo]!;
}

export function median(values: ArrayLike<number>): number { return percentile(values, 50); }

export function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }

/** Growable Float32 storage indexed by absolute position (unwritten positions read as 0). */
export class GrowF32 {
  data: Float32Array;
  constructor(initial: number) { this.data = new Float32Array(Math.max(16, initial)); }
  ensure(length: number): void {
    if (length <= this.data.length) return;
    let size = this.data.length;
    while (size < length) size = Math.ceil(size * 1.5);
    const next = new Float32Array(size); next.set(this.data); this.data = next;
  }
  set(index: number, value: number): void { this.ensure(index + 1); this.data[index] = value; }
  get(index: number): number { return index < this.data.length ? this.data[index]! : 0; }
}

export class GrowU8 {
  data: Uint8Array;
  constructor(initial: number) { this.data = new Uint8Array(Math.max(16, initial)); }
  ensure(length: number): void {
    if (length <= this.data.length) return;
    let size = this.data.length;
    while (size < length) size = Math.ceil(size * 1.5);
    const next = new Uint8Array(size); next.set(this.data); this.data = next;
  }
}
