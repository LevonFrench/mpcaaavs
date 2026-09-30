// Ported from bizarro/evangelion app/src/scenes/radar-kit.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// Helpers for the radar plate (LineBatch shapes, onset lookups, the unit roster). Local copies
// so the shared kits (_eva.ts, magi-hud.ts, target-kit.ts) stay untouched.
import type { AudioData } from '../../show/audio.ts';
import type { LineBatch } from '../../show/lines.ts';
import { LIN, type PaletteKey } from '../../show/palette.ts';
import { mulberry32, TAU } from '../../show/util.ts';

export type RGB = [number, number, number];
/** Linear palette colour times an intensity (values > 1 bloom). */
export const lc = (k: PaletteKey, s = 1): RGB => [LIN[k][0] * s, LIN[k][1] * s, LIN[k][2] * s];

/** Arc/circle as a polyline; angles are radar bearings (0 = north, clockwise). */
export function arcB(lb: LineBatch, cx: number, cy: number, r: number, w: number, rgb: RGB, a = 1, b0 = 0, b1 = TAU, n = 0) {
  const segs = n || Math.max(6, Math.ceil((Math.abs(b1 - b0) * r) / 9));
  let px = cx + Math.sin(b0) * r, py = cy - Math.cos(b0) * r;
  for (let i = 1; i <= segs; i++) {
    const an = b0 + ((b1 - b0) * i) / segs, x = cx + Math.sin(an) * r, y = cy - Math.cos(an) * r;
    lb.seg2(px, py, x, y, w, rgb, a);
    px = x; py = y;
  }
}

/** Closed regular polygon (n sides, rotation rot) as segments. */
export function polyB(lb: LineBatch, cx: number, cy: number, r: number, n: number, rot: number, w: number, rgb: RGB, a = 1) {
  for (let i = 0; i < n; i++) {
    const a0 = rot + (i / n) * TAU, a1 = rot + ((i + 1) / n) * TAU;
    lb.seg2(cx + Math.sin(a0) * r, cy - Math.cos(a0) * r, cx + Math.sin(a1) * r, cy - Math.cos(a1) * r, w, rgb, a);
  }
}

/** Dashed straight line. */
export function dashB(lb: LineBatch, ax: number, ay: number, bx: number, by: number, on: number, off: number, w: number, rgb: RGB, a = 1, phase = 0) {
  const L = Math.hypot(bx - ax, by - ay); if (L < 1) return;
  const ux = (bx - ax) / L, uy = (by - ay) / L, P = on + off;
  for (let s = -(((phase % P) + P) % P); s < L; s += P) {
    const s0 = Math.max(0, s), s1 = Math.min(L, s + on);
    if (s1 > s0) lb.seg2(ax + ux * s0, ay + uy * s0, ax + ux * s1, ay + uy * s1, w, rgb, a);
  }
}

/** Time of the last onset of `kind` at or before t with strength ≥ min, or -1e9. */
export function lastOnsetB(au: AudioData, kind: string, t: number, min = 0, skip = 0): number {
  const list = au.onsets[kind];
  if (!list) return -1e9;
  let lo = 0, hi = list.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (list[m]![0] <= t) lo = m + 1; else hi = m; }
  let k = 0;
  for (let i = lo - 1; i >= 0; i--) if (list[i]![1] >= min) { if (k++ === skip) return list[i]![0]; }
  return -1e9;
}

/** Number of onsets of `kind` in [t0, t] with strength ≥ min. */
export function countB(au: AudioData, kind: string, t0: number, t: number, min = 0): number {
  const list = au.onsets[kind];
  if (!list) return 0;
  let n = 0;
  for (const [ot, s] of list) { if (ot > t) break; if (ot >= t0 && s >= min) n++; }
  return n;
}

/** Wrap an angle to [0, TAU). */
export const wrap = (a: number) => ((a % TAU) + TAU) % TAU;

// ---------------------------------------------------------------- the UN forces
export type UnitType = 'VTOL' | 'TANK' | 'MLRS' | 'SAM' | 'N2';
export interface Unit {
  id: string; type: UnitType;
  /** bearing (rad) and normalized range (0..1 of the scope) at the plate start, and drift per s */
  b0: number; r0: number; vb: number; vr: number;
  /** mel band that sets the echo size */
  band: number;
  /** time the Angel destroys it (a clap), or Infinity */
  lost: number;
}

const TYPE_JP: Record<UnitType, string> = { VTOL: '攻撃機', TANK: '戦車', MLRS: '砲撃', SAM: '対空', N2: 'N2地雷' };
export const typeJp = (t: UnitType) => TYPE_JP[t];

/** A seeded roster: the UN defence line concentrated on the Angel's approach (north-east). */
export function makeUnits(n = 18, seed = 1995): Unit[] {
  const rnd = mulberry32(seed);
  const types: UnitType[] = ['VTOL', 'TANK', 'MLRS', 'TANK', 'SAM', 'VTOL', 'MLRS', 'TANK', 'N2'];
  const out: Unit[] = [];
  for (let i = 0; i < n; i++) {
    const type = types[i % types.length]!;
    const front = i % 3 !== 2;
    const b0 = front ? (48 + (rnd() - 0.5) * 150) * (Math.PI / 180) : rnd() * TAU;
    const r0 = type === 'N2' ? 0.5 + rnd() * 0.2 : 0.2 + rnd() * 0.66;
    const vb = type === 'VTOL' ? (rnd() < 0.5 ? -1 : 1) * (0.05 + rnd() * 0.06) : (rnd() - 0.5) * 0.01;
    const vr = type === 'VTOL' ? (rnd() - 0.5) * 0.02 : type === 'TANK' ? 0.004 + rnd() * 0.004 : 0;
    const num = String(3 + i * 4 + Math.floor(rnd() * 3)).padStart(2, '0');
    out.push({ id: `${type === 'N2' ? 'N2' : type.slice(0, 2)}-${num}`, type, b0, r0, vb, vr, band: 2 + ((i * 37) % 58), lost: Infinity });
  }
  return out;
}
