// Ported from bizarro/evangelion app/src/scenes/city-kit.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// Helpers for the city plate (TOKYO-3): the procedural city (lots, armament towers, districts),
// the Hakone caldera terrain with Lake Ashi (heightfield, contour lines by marching squares, lake
// hatching), GPU geometry for the hidden-line occluders, and small audio lookups.
// Everything is seeded: the city is identical on every load.
import * as THREE from 'three';
import type { AudioData } from '../../show/audio.ts';
import { LIN, type PaletteKey } from '../../show/palette.ts';
import { fbm2, hash, smoothstep, TAU } from '../../show/util.ts';

export type RGB = [number, number, number];
/** Linear palette colour times an intensity (values > 1 bloom). */
export const lc = (k: PaletteKey, s = 1): RGB => [LIN[k][0] * s, LIN[k][1] * s, LIN[k][2] * s];
export const mixc = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ---------------------------------------------------------------- audio lookups
/** Time of the last onset of `kind` at or before t (strength >= min), or -1e9. */
export function lastOnset(au: AudioData, kind: string, t: number, min = 0): number {
  const list = au.onsets[kind];
  if (!list) return -1e9;
  let lo = 0, hi = list.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (list[m]![0] <= t) lo = m + 1; else hi = m; }
  for (let i = lo - 1; i >= 0; i--) if (list[i]![1] >= min) return list[i]![0];
  return -1e9;
}

/** Mel frame averaged over a trailing window (slow breathing for pads). */
export function melSmooth(au: AudioData, t: number, out: Float32Array, win = 0.3, taps = 6): Float32Array {
  out.fill(0);
  for (let k = 0; k < taps; k++) {
    const tt = t - (win * k) / Math.max(1, taps - 1);
    for (let b = 0; b < out.length; b++) out[b]! += au.mel(tt, b * (au.MEL / out.length)) / taps;
  }
  return out;
}

// ---------------------------------------------------------------- terrain
/** City radius (world units ≈ 10 m) and the lake. */
export const CITY_R = 100;
export const LAKE = { x: -168, z: 176, a: -0.78, rx: 62, rz: 128 };

/** Hakone caldera: flat city floor, a ring of mountains, Lake Ashi carved in the south-west. */
export function terrainH(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const ring = smoothstep(118, 230, r);
  const n = fbm2(x * 0.0085 + 3.1, z * 0.0085 - 1.7, 4, 11);
  const ridge = 1 - Math.abs(fbm2(x * 0.004 - 5, z * 0.004 + 2, 3, 23));
  let h = ring * (46 + 38 * n + 34 * ridge * smoothstep(200, 330, r));
  // outer fall-off so the far rim reads as a skyline, not a wall
  h *= 1 - 0.45 * smoothstep(380, 520, r);
  // Lake Ashi
  const dx = x - LAKE.x, dz = z - LAKE.z, ca = Math.cos(LAKE.a), sa = Math.sin(LAKE.a);
  const u = (dx * ca - dz * sa) / LAKE.rx, v = (dx * sa + dz * ca) / LAKE.rz;
  h -= 110 * Math.exp(-(u * u + v * v) * 1.6);
  return h;
}

export type Seg3 = [number, number, number, number, number, number, number]; // a.xyz, b.xyz, level

/**
 * Contour lines of terrainH on an n×n grid over [-S, S]², at the given levels (marching squares,
 * segments on the triangulated surface's edges). Returns flat segment list.
 */
export function contours(S: number, n: number, levels: number[]): { segs: Seg3[]; grid: Float32Array } {
  const grid = new Float32Array((n + 1) * (n + 1));
  const X = (i: number) => -S + (2 * S * i) / n;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) grid[j * (n + 1) + i] = terrainH(X(i), X(j));
  const segs: Seg3[] = [];
  const g = (i: number, j: number) => grid[j * (n + 1) + i]!;
  for (const L of levels) {
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const v0 = g(i, j), v1 = g(i + 1, j), v2 = g(i + 1, j + 1), v3 = g(i, j + 1);
      const idx = (v0 > L ? 1 : 0) | (v1 > L ? 2 : 0) | (v2 > L ? 4 : 0) | (v3 > L ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      const x0 = X(i), x1 = X(i + 1), z0 = X(j), z1 = X(j + 1);
      // edge points: e0 bottom (v0-v1), e1 right (v1-v2), e2 top (v3-v2), e3 left (v0-v3)
      const e = (k: number): [number, number] => {
        if (k === 0) { const f = (L - v0) / (v1 - v0); return [x0 + (x1 - x0) * f, z0]; }
        if (k === 1) { const f = (L - v1) / (v2 - v1); return [x1, z0 + (z1 - z0) * f]; }
        if (k === 2) { const f = (L - v3) / (v2 - v3); return [x0 + (x1 - x0) * f, z1]; }
        const f = (L - v0) / (v3 - v0); return [x0, z0 + (z1 - z0) * f];
      };
      const pairs: [number, number][] = ({
        1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 5: [[3, 2], [0, 1]], 6: [[0, 2]], 7: [[3, 2]],
        8: [[2, 3]], 9: [[0, 2]], 10: [[0, 3], [1, 2]], 11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[0, 3]],
      } as Record<number, [number, number][]>)[idx]!;
      for (const [a, b] of pairs) {
        const p = e(a), q = e(b);
        segs.push([p[0], Math.max(L, 0), p[1], q[0], Math.max(L, 0), q[1], L]);
      }
    }
  }
  return { segs, grid };
}

/** Lake hatching: horizontal (world-x) spans where the terrain is under water, every `step` units. */
export function lakeHatch(step: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let z = LAKE.z - 170; z <= LAKE.z + 170; z += step) {
    let inside = false, x0 = 0;
    for (let x = LAKE.x - 170; x <= LAKE.x + 170; x += 1.5) {
      const w = terrainH(x, z) < -1.5;
      if (w && !inside) { inside = true; x0 = x; }
      if (!w && inside) { inside = false; if (x - x0 > 3) out.push([x0 + 1.5, x - 1.5, z]); }
    }
  }
  return out;
}

/** Occluder mesh for the terrain (water clamped flat at 0). */
export function terrainGeometry(S: number, n: number, grid: Float32Array): THREE.BufferGeometry {
  const pos = new Float32Array((n + 1) * (n + 1) * 3);
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const k = j * (n + 1) + i;
    pos[k * 3] = -S + (2 * S * i) / n; pos[k * 3 + 1] = Math.max(0, grid[k]!); pos[k * 3 + 2] = -S + (2 * S * j) / n;
  }
  const idx: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

// ---------------------------------------------------------------- the city
export interface Bldg {
  x0: number; z0: number; x1: number; z1: number;
  /** full height, kind (0 low-rise, 1 armament tower), mel band, deploy delay (s from plate start) */
  h: number; tower: boolean; band: number; delay: number;
  /** district index, distance to centre, stable id */
  d: number; r: number; id: number;
}

/** 0 = the centre disc, 1..6 = 60° sectors counter-clockwise from +x (sector 3 faces Lake Ashi). */
export const DISTRICTS = [
  { en: 'CENTRAL', jp: '中央区', code: 'C-00' },
  { en: 'GORA', jp: '強羅', code: 'N-01' },
  { en: 'SENGOKUHARA', jp: '仙石原', code: 'N-02' },
  { en: 'MOTOHAKONE', jp: '元箱根', code: 'W-03' },
  { en: 'YUMOTO', jp: '湯本', code: 'S-04' },
  { en: 'MIYANOSHITA', jp: '宮ノ下', code: 'E-05' },
  { en: 'OWAKUDANI', jp: '大涌谷', code: 'E-06' },
];

/** District of a point: the centre disc, then six 60° sectors. */
export function districtOf(x: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r < 34) return 0;
  const a = (Math.atan2(z, x) + TAU) % TAU;
  return 1 + Math.floor((a / TAU) * 6) % 6;
}
export const districtAngle = (d: number) => ((d - 1 + 0.5) / 6) * TAU;

/** Blocks on a street grid inside the city disc, each split into 1–4 lots. */
export function buildCity(bands: number): Bldg[] {
  const out: Bldg[] = [];
  const BLOCK = 13, ROAD = 3.2;
  const N = Math.ceil(CITY_R / BLOCK) + 1;
  let id = 0;
  for (let bj = -N; bj < N; bj++) for (let bi = -N; bi < N; bi++) {
    // avenues every 4th street are wider
    const ax = bi % 4 === 0 ? ROAD * 1.6 : ROAD, az = bj % 4 === 0 ? ROAD * 1.6 : ROAD;
    const bx0 = bi * BLOCK + ax / 2, bz0 = bj * BLOCK + az / 2, bx1 = (bi + 1) * BLOCK - ROAD / 2, bz1 = (bj + 1) * BLOCK - ROAD / 2;
    const cx = (bx0 + bx1) / 2, cz = (bz0 + bz1) / 2, rc = Math.hypot(cx, cz);
    if (rc > CITY_R - 4) continue;
    if (rc < 11) continue; // the central plaza (geofront access)
    const split = hash(bi, bj, 1);
    const sx = split < 0.35 ? 1 : 2, sz = split < 0.2 ? 1 : split > 0.7 ? 2 : 1;
    for (let lj = 0; lj < sz; lj++) for (let li = 0; li < sx; li++) {
      const gap = 1.1;
      const x0 = bx0 + ((bx1 - bx0) * li) / sx + (li ? gap / 2 : 0.4), x1 = bx0 + ((bx1 - bx0) * (li + 1)) / sx - (li < sx - 1 ? gap / 2 : 0.4);
      const z0 = bz0 + ((bz1 - bz0) * lj) / sz + (lj ? gap / 2 : 0.4), z1 = bz0 + ((bz1 - bz0) * (lj + 1)) / sz - (lj < sz - 1 ? gap / 2 : 0.4);
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, r = Math.hypot(mx, mz);
      if (r > CITY_R - 2) continue;
      const hs = hash(bi, bj, li, lj, 7), core = Math.exp(-((r / 52) ** 2));
      const tower = r < 78 && hash(bi, bj, li, lj, 9) < 0.08 + 0.3 * core;
      // towers are slimmer than their lot
      let X0 = x0, X1 = x1, Z0 = z0, Z1 = z1;
      if (tower) {
        const s = 0.72 + 0.12 * hs, w = (x1 - x0) * s, d = (z1 - z0) * s;
        X0 = mx - w / 2; X1 = mx + w / 2; Z0 = mz - d / 2; Z1 = mz + d / 2;
      }
      const h = tower ? 22 + 40 * core * (0.55 + 0.45 * hs) + 10 * hash(id, 3) : 2.2 + 6 * hs + 8 * core * hs * hs;
      const a = (Math.atan2(mz, mx) + TAU) % TAU;
      const band = Math.min(bands - 1, Math.floor((a / TAU) * bands));
      const delay = tower ? 0.15 + 1.5 * (1 - r / CITY_R) * 0.6 + 1.1 * hash(id, 5) : 0;
      out.push({ x0: X0, z0: Z0, x1: X1, z1: Z1, h, tower, band, delay, d: districtOf(mx, mz), r, id: id++ });
    }
  }
  return out;
}

/** Instanced unit boxes (0..1 in y) with per-instance rect / height / glow. */
export function boxGeometry(n: number) {
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0.5, 0.5, 0.5);
  const g = new THREE.InstancedBufferGeometry();
  g.setIndex(box.getIndex());
  g.setAttribute('position', box.getAttribute('position'));
  g.setAttribute('normal', box.getAttribute('normal'));
  const rect = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
  const hg = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3); // height, scan glow, cyan
  rect.setUsage(THREE.DynamicDrawUsage); hg.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('iRect', rect);
  g.setAttribute('iH', hg);
  g.instanceCount = n;
  return { g, rect, hg };
}
