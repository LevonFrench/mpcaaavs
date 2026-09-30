// Ported from bizarro/evangelion app/src/scenes/target-kit.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// Small helpers shared by the target / city / sync plates (LineBatch shapes, event lookups,
// smoothed spectrum). Kept here so the shared _eva.ts kit stays untouched.
import type { AudioData } from '../../show/audio.ts';
import type { LineBatch } from '../../show/lines.ts';
import { LIN, type PaletteKey } from '../../show/palette.ts';
import { TAU } from '../../show/util.ts';

export type RGB = [number, number, number];
/** Linear palette colour times an intensity (values > 1 bloom). */
export const lc = (k: PaletteKey, s = 1): RGB => [LIN[k][0] * s, LIN[k][1] * s, LIN[k][2] * s];
export const mixc = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Arc (or full circle) as a LineBatch polyline. Angles in radians, 0 = +x, clockwise on screen. */
export function arc2(lb: LineBatch, cx: number, cy: number, r: number, w: number, rgb: RGB, a = 1, a0 = 0, a1 = TAU, n = 0) {
  const segs = n || Math.max(8, Math.ceil((Math.abs(a1 - a0) * r) / 10));
  let px = cx + Math.cos(a0) * r, py = cy + Math.sin(a0) * r;
  for (let i = 1; i <= segs; i++) {
    const an = a0 + ((a1 - a0) * i) / segs, x = cx + Math.cos(an) * r, y = cy + Math.sin(an) * r;
    lb.seg2(px, py, x, y, w, rgb, a);
    px = x; py = y;
  }
}

/** Dashed straight line. */
export function dash2(lb: LineBatch, ax: number, ay: number, bx: number, by: number, on: number, off: number, w: number, rgb: RGB, a = 1, phase = 0) {
  const L = Math.hypot(bx - ax, by - ay); if (L < 1) return;
  const ux = (bx - ax) / L, uy = (by - ay) / L, P = on + off;
  for (let s = -(((phase % P) + P) % P); s < L; s += P) {
    const s0 = Math.max(0, s), s1 = Math.min(L, s + on);
    if (s1 > s0) lb.seg2(ax + ux * s0, ay + uy * s0, ax + ux * s1, ay + uy * s1, w, rgb, a);
  }
}

/** Corner brackets as line segments. */
export function brackets2(lb: LineBatch, x: number, y: number, w: number, h: number, len: number, lw: number, rgb: RGB, a = 1) {
  lb.seg2(x, y, x + len, y, lw, rgb, a); lb.seg2(x, y, x, y + len, lw, rgb, a);
  lb.seg2(x + w, y, x + w - len, y, lw, rgb, a); lb.seg2(x + w, y, x + w, y + len, lw, rgb, a);
  lb.seg2(x, y + h, x + len, y + h, lw, rgb, a); lb.seg2(x, y + h, x, y + h - len, lw, rgb, a);
  lb.seg2(x + w, y + h, x + w - len, y + h, lw, rgb, a); lb.seg2(x + w, y + h, x + w, y + h - len, lw, rgb, a);
}

/** Time of the last onset of `kind` at or before t (strength ≥ min), or -1e9. */
export function lastOnset(au: AudioData, kind: string, t: number, min = 0): number {
  const list = au.onsets[kind];
  if (!list) return -1e9;
  let lo = 0, hi = list.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (list[m]![0] <= t) lo = m + 1; else hi = m; }
  for (let i = lo - 1; i >= 0; i--) if (list[i]![1] >= min) return list[i]![0];
  return -1e9;
}
/** Number of onsets of `kind` in [t0, t] (strength ≥ min): a step counter for hat-driven scrolling. */
export function onsetCount(au: AudioData, kind: string, t0: number, t: number, min = 0): number {
  const list = au.onsets[kind];
  if (!list) return 0;
  let n = 0;
  for (const [ot, s] of list) { if (ot > t) break; if (ot >= t0 && s >= min) n++; }
  return n;
}

/** Mel frame averaged over a short trailing window (smoother breathing for pads). */
export function melSmooth(au: AudioData, t: number, out: Float32Array, win = 0.12, taps = 4): Float32Array {
  out.fill(0);
  for (let k = 0; k < taps; k++) {
    const tt = t - (win * k) / Math.max(1, taps - 1);
    for (let b = 0; b < out.length; b++) out[b]! += au.mel(tt, b * (au.MEL / out.length)) / taps;
  }
  return out;
}

/** Scramble digits of a string (keeps non-digits) for glitching readouts. */
export function scrambleDigits(s: string, seed: number, amount: number, h: (a: number, b: number, c: number) => number): string {
  let o = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    o += ch >= '0' && ch <= '9' && h(seed, i, 3) < amount ? String(Math.floor(h(seed, i, 9) * 10)) : ch;
  }
  return o;
}
