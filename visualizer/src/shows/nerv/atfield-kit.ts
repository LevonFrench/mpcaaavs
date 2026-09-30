// Ported from bizarro/evangelion app/src/scenes/atfield-kit.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// Shared helpers for the atfield / alert / plug plates: onset lookups for shader uniforms, the NERV
// header strip, vertical Japanese captions, status rows, a waveform scope and octagon paths.
import * as THREE from 'three';
import type { AudioData } from '../../show/audio.ts';
import { rgba } from '../../show/palette.ts';
import { F, font } from '../../show/type.ts';
import { clamp } from '../../show/util.ts';
import { jp } from './_eva.ts';

/** Onsets of a kind within [t0, t1] (precomputed once per scene). */
export function onsetList(au: AudioData, kind: string, t0: number, t1: number, minStrength = 0) {
  return (au.onsets[kind] ?? []).filter(([t, s]) => t >= t0 && t <= t1 && s >= minStrength);
}

/** Index of the last onset at or before t (-1 if none). */
export function lastIdx(list: [number, number][], t: number) {
  let lo = 0, hi = list.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (list[m]![0] <= t) lo = m + 1; else hi = m; }
  return lo - 1;
}

/** Fill a vec2 uniform array with the n most recent onsets (time, strength); unused slots get t = -1e3. */
export function fillRecent(arr: THREE.Vector2[], list: [number, number][], t: number, gate = 1) {
  const i0 = lastIdx(list, t);
  for (let k = 0; k < arr.length; k++) {
    const e = list[i0 - k];
    if (e) arr[k]!.set(e[0], e[1] * gate); else arr[k]!.set(-1e3, 0);
  }
}
export const vec2Array = (n: number) => Array.from({ length: n }, () => new THREE.Vector2(-1e3, 0));

/**
 * The plate header strip: a solid tab with the title knocked out (EN + JP), a mono subtitle, a thin
 * rule across and a right-aligned JP/mono caption. y = top of the tab.
 */
export function headerStrip(c: CanvasRenderingContext2D, x: number, y: number, w: number, o: { tag: string; tagJp?: string; sub?: string; right?: string; rightJp?: string; color?: string; hot?: number }) {
  const col = o.color ?? rgba('orange', 1), h = 34;
  c.save();
  c.font = font(F.mono(700), 17); c.letterSpacing = '3px';
  const tw = c.measureText(o.tag).width;
  c.letterSpacing = '0px';
  c.font = jp(19, 700, false);
  const jw = o.tagJp ? c.measureText(o.tagJp).width + 18 : 0;
  const bw = tw + jw + 44;
  c.fillStyle = col;
  c.beginPath(); c.moveTo(x, y); c.lineTo(x + bw, y); c.lineTo(x + bw + h * 0.7, y + h); c.lineTo(x, y + h); c.closePath(); c.fill();
  c.fillStyle = rgba('ink', 1); c.textBaseline = 'middle';
  c.font = font(F.mono(700), 17); c.letterSpacing = '3px';
  c.fillText(o.tag, x + 14, y + h / 2 + 1);
  c.letterSpacing = '0px';
  if (o.tagJp) { c.font = jp(19, 700, false); c.fillText(o.tagJp, x + 14 + tw + 14, y + h / 2 + 1); }
  // rule + small end-caps
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

/** Vertical Japanese text (top to bottom), one glyph per line. */
export function jpVertical(c: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, serif = true, lead = 1.08) {
  c.save();
  c.font = jp(size, 700, serif); c.fillStyle = color; c.textAlign = 'center'; c.textBaseline = 'top';
  let yy = y;
  for (const ch of text) { c.fillText(ch, x, yy); yy += size * lead; }
  c.restore();
  return yy;
}

/**
 * A status row: EN label (mono caps) + JP, dotted leader, value right-aligned in `vcol`.
 * Returns the row height.
 */
export function statusRow(c: CanvasRenderingContext2D, x: number, y: number, w: number, en: string, jpText: string, value: string, vcol: string, o: { col?: string; box?: boolean } = {}) {
  const col = o.col ?? rgba('orange', 0.9);
  c.save();
  c.textBaseline = 'alphabetic';
  c.font = font(F.mono(600), 13); c.letterSpacing = '2px'; c.fillStyle = col;
  c.fillText(en, x, y);
  const ew = c.measureText(en).width;
  c.letterSpacing = '0px';
  c.font = jp(13, 600, false); c.fillStyle = rgba('orange', 0.6);
  c.fillText(jpText, x + ew + 10, y);
  const jw = c.measureText(jpText).width;
  c.font = font(F.mono(700), 13); c.letterSpacing = '1.5px';
  const vw = c.measureText(value).width;
  // leader dots
  c.fillStyle = rgba('orange', 0.35);
  for (let d = x + ew + jw + 20; d < x + w - vw - 16; d += 6) c.fillRect(d, y - 2, 2, 2);
  if (o.box) {
    c.fillStyle = vcol; c.fillRect(x + w - vw - 10, y - 13, vw + 10, 17);
    c.fillStyle = rgba('ink', 1);
  } else c.fillStyle = vcol;
  c.textAlign = 'right';
  c.fillText(value, x + w - (o.box ? 5 : 0), y);
  c.restore();
}

/** A waveform scope of the real signal: `win` seconds centred on t, drawn in a rect with a graticule. */
export function waveScope(c: CanvasRenderingContext2D, au: AudioData, t: number, x: number, y: number, w: number, h: number, o: { win?: number; col?: string; gain?: number; ch?: 0 | 1 | 2; grid?: boolean; n?: number; lw?: number } = {}) {
  const win = o.win ?? 0.04, n = o.n ?? 240, g = o.gain ?? 0.9;
  c.save();
  if (o.grid !== false) {
    c.strokeStyle = rgba('orange', 0.18); c.lineWidth = 1;
    c.beginPath();
    for (let i = 1; i < 8; i++) { const gx = x + (w * i) / 8; c.moveTo(gx, y); c.lineTo(gx, y + h); }
    for (let i = 1; i < 4; i++) { const gy = y + (h * i) / 4; c.moveTo(x, gy); c.lineTo(x + w, gy); }
    c.stroke();
    c.strokeStyle = rgba('orange', 0.35); c.beginPath(); c.moveTo(x, y + h / 2); c.lineTo(x + w, y + h / 2); c.stroke();
  }
  const s: [number, number] = [0, 0];
  c.strokeStyle = o.col ?? rgba('orange', 1); c.lineWidth = o.lw ?? 1.6; c.lineJoin = 'round';
  c.beginPath();
  for (let i = 0; i <= n; i++) {
    au.waveAt(t - win / 2 + (win * i) / n, s);
    const v = o.ch === 0 ? s[0] : o.ch === 1 ? s[1] : (s[0] + s[1]) / 2;
    const px = x + (w * i) / n, py = y + h / 2 - clamp(v * g, -1, 1) * h * 0.46;
    if (i) c.lineTo(px, py); else c.moveTo(px, py);
  }
  c.stroke();
  c.restore();
}

/** Regular octagon path (flat sides on the axes), circumscribed "radius" r = apothem. */
export function octPath(c: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  const k = r * Math.tan(Math.PI / 8);
  c.beginPath();
  c.moveTo(cx - k, cy - r); c.lineTo(cx + k, cy - r); c.lineTo(cx + r, cy - k); c.lineTo(cx + r, cy + k);
  c.lineTo(cx + k, cy + r); c.lineTo(cx - k, cy + r); c.lineTo(cx - r, cy + k); c.lineTo(cx - r, cy - k); c.closePath();
}

/** Mel band index → approximate centre frequency label (30 Hz – 16 kHz, 64 bands). */
export function melHz(band: number, bands = 64) {
  const m = (f: number) => 2595 * Math.log10(1 + f / 700), im = (x: number) => 700 * (Math.pow(10, x / 2595) - 1);
  const f = im(m(30) + ((m(16000) - m(30)) * (band + 0.5)) / bands);
  return f >= 1000 ? `${(f / 1000).toFixed(1)}K` : `${Math.round(f)}`;
}

/** Mean of mel bands [b0, b1) at t. */
export function melMean(au: AudioData, t: number, b0: number, b1: number) {
  let s = 0;
  for (let b = b0; b < b1; b++) s += au.mel(t, b);
  return s / Math.max(1, b1 - b0);
}

/** Tracked mono text helper. */
export function mono(c: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, o: { w?: number; track?: number; align?: CanvasTextAlign; base?: CanvasTextBaseline } = {}) {
  c.font = font(F.mono(o.w ?? 500), size); c.letterSpacing = `${o.track ?? size * 0.16}px`;
  c.fillStyle = color; c.textAlign = o.align ?? 'left'; c.textBaseline = o.base ?? 'alphabetic';
  c.fillText(s, x, y);
  c.letterSpacing = '0px'; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
}
