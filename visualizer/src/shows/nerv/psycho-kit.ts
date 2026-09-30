// Ported from bizarro/evangelion app/src/scenes/psycho-kit.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// Signal bank for the psycho plate: six psychograph channels precomputed from the audio analysis
// at RATE Hz (min/max per slot) over the plate window, so the sweep display is a pure lookup of
// song time. Channels:
//   0 α  the real mix waveform (min/max envelope of the raw samples)
//   1 PULSE  an ECG trace: a P-QRS-T complex on every kick (strength-scaled)
//   2 θ  the bass stem: bass envelope × an oscillation at the bass pitch (÷ 4, phase-continuous)
//   3 β  the highs: high-band envelope × noise + a ringing burst on every hat
//   4 γ  the pads: slow waves scaled by the "other" stem, frequency from the dominant chroma
//   5 δ  the clap: a damped spike on every clap over a faint drum-envelope baseline
// The bar-12 break gates everything to a flatline (only a weak pulse on the beat survives), and the
// last beat of the break ramps the channels back with resync jitter.
import type { AudioData } from '../../show/audio.ts';
import { clamp, hash } from '../../show/util.ts';

export const RATE = 600;
export const NCH = 6;

const gauss = (x: number, s: number) => Math.exp(-(x * x) / (2 * s * s));
/** ECG template (d seconds from the R peak), R = 1. */
export const ecg = (d: number) =>
  0.13 * gauss(d + 0.1, 0.02) - 0.16 * gauss(d + 0.02, 0.006) + gauss(d, 0.0065) - 0.34 * gauss(d - 0.019, 0.007) + 0.26 * gauss(d - 0.17, 0.034);

/** Smooth value noise in -1..1. */
export function vnoise(x: number, seed: number) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return (hash(i, seed) * (1 - u) + hash(i + 1, seed) * u) * 2 - 1;
}

export interface Bank {
  t0: number;
  n: number;
  mn: Float32Array[];
  mx: Float32Array[];
}

/** The break gate: 1 outside, ~0.03 flat inside, the last beat ramps back. */
export function gate(t: number, b12: number, b13: number) {
  if (t < b12) return 1;
  const lb = b13 - 0.45;
  if (t < lb) return Math.max(0.025, 1 - (t - b12) / 0.05);
  if (t < b13) { const p = (t - lb) / 0.45; return 0.025 + 0.7 * p * p; }
  return 1;
}

export function buildBank(au: AudioData, t0: number, t1: number, b12: number, b13: number): Bank {
  const n = Math.ceil((t1 - t0) * RATE);
  const mn = Array.from({ length: NCH }, () => new Float32Array(n));
  const mx = Array.from({ length: NCH }, () => new Float32Array(n));
  const kicks = au.events('kick', t0 - 1, t1 + 1).filter((k) => k[1] > 0.12);
  const hats = au.events('hat', t0 - 1, t1 + 1);
  const claps = au.events('snare', t0 - 1, t1 + 1);
  const W = au.wave, wn = W.length >> 1, wr = au.waveRate;
  const ch = new Float32Array(12);
  let phase = 0, fd = 11, gphase = 0;
  const lb = b13 - 0.45;
  for (let i = 0; i < n; i++) {
    const t = t0 + (i + 0.5) / RATE;
    const g = gate(t, b12, b13);
    // resync jitter in the last beat of the break
    const rs = t >= lb && t < b13 ? (hash(Math.floor(t * 90), 7) > 0.8 ? (hash(Math.floor(t * 90), 9) * 2 - 1) * 0.6 * ((t - lb) / 0.45) : 0) : 0;
    // 0: raw waveform min/max over the slot
    {
      const a = Math.max(0, Math.floor((t0 + i / RATE) * wr)), b = Math.min(wn - 1, Math.ceil((t0 + (i + 1) / RATE) * wr));
      let lo = 1, hi = -1;
      for (let s = a; s <= b; s++) { const v = (W[2 * s]! + W[2 * s + 1]!) * 0.5; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (hi < lo) lo = hi = 0;
      mn[0]![i] = clamp(lo * 1.05 * g + rs, -1, 1); mx[0]![i] = clamp(hi * 1.05 * g + rs, -1, 1);
    }
    // 1: ECG on the kicks (+ a weak pulse on every beat through the break, ungated)
    {
      let v = 0;
      for (const [kt, s] of kicks) { const d = t - kt; if (d > -0.2 && d < 0.35) v += s * ecg(d) * 0.92; }
      v *= g;
      if (t >= b12 && t < b13) {
        const bt = b12 + Math.floor((t - b12) / 0.45) * 0.45;
        v += 0.2 * ecg(t - bt - 0.05);
      }
      v += 0.03 * Math.sin(t * 2.1) + 0.015 * vnoise(t * 40, 3);
      mn[1]![i] = mx[1]![i] = clamp(v + rs * 0.5, -1, 1);
    }
    // 2: bass stem: env × oscillation at pitch/4
    {
      const m = au.bassMidi(t);
      if (m > 0) fd = (440 * Math.pow(2, (m - 69) / 12)) / 4;
      phase += (Math.PI * 2 * fd) / RATE;
      const e = au.env('bass', t);
      const v = e * 1.15 * Math.sin(phase) * (0.85 + 0.15 * Math.sin(phase * 0.25));
      mn[2]![i] = mx[2]![i] = clamp(v * g + rs, -1, 1);
    }
    // 3: highs: noise × high env + ringing bursts on hats
    {
      const e = au.env('high', t);
      let v = e * 0.7 * (vnoise(t * 160, 11) * 0.7 + vnoise(t * 420, 12) * 0.3);
      for (const [ht, s] of hats) { const d = t - ht; if (d >= 0 && d < 0.09) v += s * 0.95 * Math.exp(-d / 0.018) * Math.sin(d * Math.PI * 2 * 70); }
      mn[3]![i] = mx[3]![i] = clamp(v * g + rs, -1, 1);
    }
    // 4: pads: slow waves, frequency from the dominant chroma bin
    {
      const e = au.env('other', t);
      au.chroma(t, ch);
      let top = 0; for (let k = 1; k < 12; k++) if (ch[k]! > ch[top]!) top = k;
      gphase += (Math.PI * 2 * (2.2 + top * 0.35)) / RATE;
      const v = e * (0.62 * Math.sin(gphase) + 0.28 * Math.sin(gphase * 2.7 + 1.3) + 0.12 * vnoise(t * 30, 21)) + 0.06 * vnoise(t * 9, 22);
      mn[4]![i] = mx[4]![i] = clamp(v * 1.2 * g + rs, -1, 1);
    }
    // 5: claps: damped spike + faint drum baseline
    {
      let v = au.env('drums', t) * 0.1 * vnoise(t * 90, 31);
      for (const [ct, s] of claps) { const d = t - ct; if (d >= -0.004 && d < 0.2) v += s * 1.1 * (d < 0 ? -0.3 * (1 + d / 0.004) : Math.exp(-d / 0.045) * Math.cos(d * Math.PI * 2 * 17)); }
      mn[5]![i] = mx[5]![i] = clamp(v * g + rs, -1, 1);
    }
  }
  return { t0, n, mn, mx };
}

/** Min / max of channel ch over [ta, tb] (slots), written into out[0], out[1]. */
export function span(b: Bank, ch: number, ta: number, tb: number, out: [number, number]) {
  let i0 = Math.floor((ta - b.t0) * RATE), i1 = Math.floor((tb - b.t0) * RATE);
  i0 = Math.max(0, Math.min(b.n - 1, i0)); i1 = Math.max(i0, Math.min(b.n - 1, i1));
  let lo = 1e9, hi = -1e9;
  const A = b.mn[ch]!, B = b.mx[ch]!;
  for (let i = i0; i <= i1; i++) { if (A[i]! < lo) lo = A[i]!; if (B[i]! > hi) hi = B[i]!; }
  out[0] = lo; out[1] = hi;
  return out;
}

/** Peak |value| of channel ch over [t - w, t]. */
export function peakAbs(b: Bank, ch: number, t: number, w = 0.06) {
  const o: [number, number] = [0, 0];
  span(b, ch, t - w, t, o);
  return Math.max(Math.abs(o[0]), Math.abs(o[1]));
}

/**
 * segMeter() from _eva.ts, but multiplied by the context's current globalAlpha (the kit's version
 * resets alpha to 1, which breaks group fades) and restoring it afterwards.
 */
export function segMeterA(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, n: number, v: number, o: { color: string; hot?: string; hotFrom?: number; dim: string; vertical?: boolean; gap?: number }) {
  const base = c.globalAlpha, g = o.gap ?? 2, lit = v * n;
  for (let i = 0; i < n; i++) {
    const col = i / n >= (o.hotFrom ?? 0.8) ? (o.hot ?? o.color) : o.color;
    const on = i < Math.floor(lit) ? 1 : i < lit ? lit - i : 0;
    c.fillStyle = on > 0 ? col : o.dim;
    c.globalAlpha = base * (on > 0 ? 0.35 + 0.65 * on : 1);
    if (o.vertical) { const bh = (h - g * (n - 1)) / n; c.fillRect(x, y + h - (i + 1) * bh - i * g, w, bh); }
    else { const bw = (w - g * (n - 1)) / n; c.fillRect(x + i * (bw + g), y, bw, h); }
  }
  c.globalAlpha = base;
}
