// Ported from bizarro/evangelion app/src/scenes/alert-kit.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// Helpers for the alert plate ("PATTERN BLUE"): onset lookups, the EMERGENCY tile atlas for the GL
// alert wall, the header strip, status rows, the Angel wireframe and small text helpers.
import * as THREE from 'three';
import { createCanvas } from '../../show/canvas.ts';
import type { AudioData } from '../../show/audio.ts';
import { SCALE } from '../../show/gl.ts';
import { rgba } from '../../show/palette.ts';
import { F, font } from '../../show/type.ts';
import { clamp } from '../../show/util.ts';
import { chamferPath, condensed, jp } from './_eva.ts';

export type Onset = [number, number];

/** Onsets of a kind within [t0, t1] with strength ≥ min (precomputed once per scene). */
export function onsetList(au: AudioData, kind: string, t0: number, t1: number, min = 0): Onset[] {
  return (au.onsets[kind] ?? []).filter(([t, s]) => t >= t0 && t <= t1 && s >= min);
}

/** Index of the last onset at or before t (-1 if none). */
export function lastIdx(list: Onset[], t: number) {
  let lo = 0, hi = list.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (list[m]![0] <= t) lo = m + 1; else hi = m; }
  return lo - 1;
}

/** Fill a vec2 uniform array with the n most recent onsets (time, strength); unused slots get t = -1e3. */
export function fillRecent(arr: THREE.Vector2[], list: Onset[], t: number) {
  const i0 = lastIdx(list, t);
  for (let k = 0; k < arr.length; k++) {
    const e = list[i0 - k];
    if (e) arr[k]!.set(e[0], e[1]); else arr[k]!.set(-1e3, 0);
  }
}
export const vec2Array = (n: number) => Array.from({ length: n }, () => new THREE.Vector2(-1e3, 0));

/** Tracked mono text. */
export function mono(c: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, o: { w?: number; track?: number; align?: CanvasTextAlign; base?: CanvasTextBaseline } = {}) {
  c.font = font(F.mono(o.w ?? 500), size); c.letterSpacing = `${o.track ?? size * 0.16}px`;
  c.fillStyle = color; c.textAlign = o.align ?? 'left'; c.textBaseline = o.base ?? 'alphabetic';
  c.fillText(s, x, y);
  c.letterSpacing = '0px'; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
}

/** Japanese text. */
export function jpText(c: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, o: { w?: number; serif?: boolean; align?: CanvasTextAlign; base?: CanvasTextBaseline } = {}) {
  c.font = jp(size, o.w ?? 700, o.serif ?? false); c.fillStyle = color; c.textAlign = o.align ?? 'left'; c.textBaseline = o.base ?? 'alphabetic';
  c.fillText(s, x, y);
  c.textAlign = 'left'; c.textBaseline = 'alphabetic';
}

/**
 * The plate header strip: a solid tab with the title knocked out (EN + JP), a mono subtitle, a thin
 * rule across and a right-aligned JP/mono caption. y = top of the tab.
 */
export function headerStrip(c: CanvasRenderingContext2D, x: number, y: number, w: number, o: { tag: string; tagJp?: string; sub?: string; right?: string; rightJp?: string; color?: string; tab?: string }) {
  const col = o.color ?? rgba('orange', 1), h = 34;
  c.save();
  c.font = font(F.mono(700), 17); c.letterSpacing = '3px';
  const tw = c.measureText(o.tag).width;
  c.letterSpacing = '0px';
  c.font = jp(19, 700, false);
  const jw = o.tagJp ? c.measureText(o.tagJp).width + 18 : 0;
  const bw = tw + jw + 44;
  c.fillStyle = o.tab ?? col;
  c.beginPath(); c.moveTo(x, y); c.lineTo(x + bw, y); c.lineTo(x + bw + h * 0.7, y + h); c.lineTo(x, y + h); c.closePath(); c.fill();
  c.fillStyle = rgba('ink', 1); c.textBaseline = 'middle';
  c.font = font(F.mono(700), 17); c.letterSpacing = '3px';
  c.fillText(o.tag, x + 14, y + h / 2 + 1);
  c.letterSpacing = '0px';
  if (o.tagJp) { c.font = jp(19, 700, false); c.fillText(o.tagJp, x + 14 + tw + 14, y + h / 2 + 1); }
  c.fillStyle = col;
  c.fillRect(x + bw + h * 0.7 + 8, y + h - 2, w - bw - h * 0.7 - 8, 2);
  c.fillRect(x + w - 60, y + h - 8, 60, 6);
  if (o.sub) {
    c.font = font(F.mono(500), 13); c.letterSpacing = '2.5px'; c.textBaseline = 'alphabetic';
    c.fillText(o.sub, x + bw + h * 0.7 + 18, y + h - 10);
  }
  if (o.right || o.rightJp) {
    c.textAlign = 'right'; c.textBaseline = 'alphabetic';
    let rx = x + w - 72;
    if (o.rightJp) { c.font = jp(22, 700, true); c.letterSpacing = '0px'; c.fillText(o.rightJp, rx, y + h - 10); rx -= c.measureText(o.rightJp).width + 16; }
    if (o.right) { c.font = font(F.mono(600), 13); c.letterSpacing = '2.5px'; c.fillText(o.right, rx, y + h - 10); }
  }
  c.restore();
}

/** A status row: EN label + JP, dotted leader, value right-aligned in `vcol` (boxed when `box`). */
export function statusRow(c: CanvasRenderingContext2D, x: number, y: number, w: number, en: string, jpS: string, value: string, vcol: string, o: { col?: string; jcol?: string; box?: boolean } = {}) {
  const col = o.col ?? rgba('orange', 0.9);
  c.save();
  c.textBaseline = 'alphabetic';
  c.font = font(F.mono(600), 13); c.letterSpacing = '2px'; c.fillStyle = col;
  c.fillText(en, x, y);
  const ew = c.measureText(en).width;
  c.letterSpacing = '0px';
  c.font = jp(13, 600, false); c.fillStyle = o.jcol ?? rgba('orange', 0.6);
  c.fillText(jpS, x + ew + 10, y);
  const jw = c.measureText(jpS).width;
  c.font = font(F.mono(700), 13); c.letterSpacing = '1.5px';
  const vw = c.measureText(value).width;
  c.fillStyle = o.jcol ?? rgba('orange', 0.35);
  c.globalAlpha *= 0.6;
  for (let d = x + ew + jw + 20; d < x + w - vw - 16; d += 6) c.fillRect(d, y - 2, 2, 2);
  c.globalAlpha /= 0.6;
  if (o.box) { c.fillStyle = vcol; c.fillRect(x + w - vw - 10, y - 13, vw + 10, 17); c.fillStyle = rgba('ink', 1); }
  else c.fillStyle = vcol;
  c.textAlign = 'right';
  c.fillText(value, x + w - (o.box ? 5 : 0), y);
  c.restore();
}

/** A waveform scope of the real signal: `win` seconds ending at t. */
export function waveScope(c: CanvasRenderingContext2D, au: AudioData, t: number, x: number, y: number, w: number, h: number, o: { win?: number; col?: string; grid?: string; gain?: number; n?: number; lw?: number } = {}) {
  const win = o.win ?? 0.04, n = o.n ?? 200, g = o.gain ?? 0.9;
  c.save();
  if (o.grid) {
    c.strokeStyle = o.grid; c.lineWidth = 1;
    c.beginPath();
    for (let i = 1; i < 8; i++) { const gx = x + (w * i) / 8; c.moveTo(gx, y); c.lineTo(gx, y + h); }
    for (let i = 1; i < 4; i++) { const gy = y + (h * i) / 4; c.moveTo(x, gy); c.lineTo(x + w, gy); }
    c.stroke();
  }
  const s: [number, number] = [0, 0];
  c.strokeStyle = o.col ?? rgba('orange', 1); c.lineWidth = o.lw ?? 1.6; c.lineJoin = 'round';
  c.beginPath();
  for (let i = 0; i <= n; i++) {
    au.waveAt(t - win + (win * i) / n, s);
    const v = (s[0] + s[1]) / 2;
    const px = x + (w * i) / n, py = y + h / 2 - clamp(v * g, -1, 1) * h * 0.46;
    if (i) c.lineTo(px, py); else c.moveTo(px, py);
  }
  c.stroke();
  c.restore();
}

/** Vertical Japanese text (top to bottom). */
export function jpVertical(c: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, serif = true, lead = 1.08) {
  c.save();
  c.font = jp(size, 700, serif); c.fillStyle = color; c.textAlign = 'center'; c.textBaseline = 'top';
  let yy = y;
  for (const ch of text) { c.fillText(ch, x, yy); yy += size * lead; }
  c.restore();
  return yy;
}

// ---------------------------------------------------------------- the alert wall atlas
/** Tile size of the GL alert wall (logical px) and the variants in the atlas (top to bottom). */
export const TILE = { w: 150, h: 54, n: 4 };
const TILE_TEXT: [string, string, string][] = [
  ['EMERGENCY', '緊急事態', 'E-01'],
  ['WARNING', '警告', 'W-02'],
  ['DANGER', '危険', 'D-03'],
  ['ALERT', '非常警報', 'A-04'],
];

/**
 * Atlas of the wall tiles, one variant per row, as channel masks: R = frame, G = text, B = interior.
 * Drawn at SCALE so it stays crisp at 4K (sampled 1:1).
 */
export function makeTileAtlas(): THREE.CanvasTexture {
  const { w, h, n } = TILE;
  const cv = createCanvas();
  cv.width = w * SCALE; cv.height = h * n * SCALE;
  const c = cv.getContext('2d')!;
  c.scale(SCALE, SCALE);
  c.fillStyle = '#000'; c.fillRect(0, 0, w, h * n);
  c.globalCompositeOperation = 'lighter';
  TILE_TEXT.forEach(([en, jpS, code], i) => {
    const y0 = i * h;
    // interior (B)
    chamferPath(c, 3, y0 + 3, w - 6, h - 6, [0, 9, 0, 9]);
    c.fillStyle = '#0000ff'; c.fill();
    // frame (R): outline + a solid left notch bar
    c.strokeStyle = '#ff0000'; c.lineWidth = 2; c.stroke();
    c.fillStyle = '#ff0000'; c.fillRect(8, y0 + 9, 4, h - 18);
    // text (G)
    c.fillStyle = '#00ff00';
    c.font = font(F.archivo(75, 900), en.length > 7 ? 23 : 26);
    c.textBaseline = 'alphabetic'; c.textAlign = 'left';
    c.letterSpacing = '1px';
    c.fillText(en, 19, y0 + 29);
    c.letterSpacing = '0px';
    c.font = jp(12, 700, false);
    c.fillText(jpS, 19, y0 + 45);
    c.font = font(F.mono(600), 9); c.letterSpacing = '1px'; c.textAlign = 'right';
    c.fillText(code, w - 12, y0 + 45);
    c.letterSpacing = '0px';
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------- the Angel (octahedron)
const OCT_V: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const OCT_F: [number, number, number][] = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]];

/**
 * The Angel as a rotating crystal octahedron (orthographic, slightly squashed vertical axis):
 * faces lit by their normal, edges bright. `yaw`, `pitch` in radians; r = half-diagonal (px).
 */
export function drawOctahedron(c: CanvasRenderingContext2D, cx: number, cy: number, r: number, yaw: number, pitch: number, o: { col?: string; face?: (k: number) => string; lw?: number; stretch?: number; edgeA?: number } = {}) {
  const cy_ = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), st = o.stretch ?? 1.35;
  const P = OCT_V.map(([x, y, z]) => {
    y *= st;
    const x1 = x * cy_ + z * sy, z1 = -x * sy + z * cy_;
    const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
    return [cx + x1 * r, cy - y2 * r, z2] as [number, number, number];
  });
  const faces = OCT_F.map((f) => {
    const [a, b, d] = f.map((i) => P[i]!) as [[number, number, number], [number, number, number], [number, number, number]];
    const cross = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
    return { f, z: (a[2] + b[2] + d[2]) / 3, cross };
  }).sort((p, q) => p.z - q.z);
  c.save();
  c.lineJoin = 'round';
  for (const fc of faces) {
    const [a, b, d] = fc.f.map((i) => P[i]!) as [[number, number, number], [number, number, number], [number, number, number]];
    c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.lineTo(d[0], d[1]); c.closePath();
    // front faces (cw on screen) lit by a fake light from upper-left
    const front = fc.cross < 0;
    const k = clamp(0.5 + 0.5 * ((a[0] + b[0] + d[0]) / 3 - cx) / -r * 0.6 + 0.5 * ((a[1] + b[1] + d[1]) / 3 - cy) / -r * 0.5);
    if (front && o.face) { c.fillStyle = o.face(k); c.fill(); }
    c.strokeStyle = o.col ?? rgba('cyan', 1);
    c.globalAlpha = front ? (o.edgeA ?? 1) : (o.edgeA ?? 1) * 0.3;
    c.lineWidth = o.lw ?? 1.5; c.stroke();
    c.globalAlpha = 1;
  }
  c.restore();
  return P;
}

// ---------------------------------------------------------------- cached big type
/**
 * Large condensed-serif words are expensive to fill + stroke every frame (big glyphs skip the glyph
 * cache), so they are rendered once into SCALE-resolution sprites. `draw` places the sprite with
 * the same anchor as condensed(): (x, baseline y), align left/center/right, optional scale about it.
 */
export class WordCache {
  private m = new Map<string, { cv: HTMLCanvasElement; w: number; h: number; pad: number; base: number }>();
  private get(text: string, size: number, color: string, sx: number, bold: number, family?: string) {
    const key = `${text}|${size}|${color}|${sx}|${bold}|${family ?? ''}`;
    let e = this.m.get(key);
    if (!e) {
      const pad = Math.ceil(size * 0.08), base = Math.ceil(size * 1.0) + pad, h = Math.ceil(size * 1.3) + pad * 2;
      const probe = createCanvas().getContext('2d')!;
      probe.font = family ?? font(F.serif(600), size);
      const w = Math.ceil(probe.measureText(text).width * sx) + pad * 2;
      const cv = createCanvas();
      cv.width = Math.ceil(w * SCALE); cv.height = Math.ceil(h * SCALE);
      const c = cv.getContext('2d')!;
      c.scale(SCALE, SCALE);
      if (family) {
        c.font = family; c.fillStyle = color; c.textBaseline = 'alphabetic';
        c.save(); c.translate(pad, base); c.scale(sx, 1); c.fillText(text, 0, 0); c.restore();
      } else condensed(c, text, pad, base, size, { sx, color, bold });
      e = { cv, w, h, pad, base };
      this.m.set(key, e);
    }
    return e;
  }
  draw(c: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, o: { color: string; sx?: number; bold?: number; align?: 'left' | 'center' | 'right'; scale?: number; family?: string }) {
    const e = this.get(text, size, o.color, o.sx ?? 0.62, o.bold ?? 0.022, o.family);
    const k = o.scale ?? 1, inner = e.w - e.pad * 2;
    const ax = o.align === 'center' ? inner / 2 : o.align === 'right' ? inner : 0;
    c.drawImage(e.cv, x - (ax + e.pad) * k, y - e.base * k, e.w * k, e.h * k);
  }
}
