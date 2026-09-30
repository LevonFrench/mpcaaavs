// Ported from bizarro/evangelion app/src/scenes/_eva.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// The NERV HQ terminal kit, shared by every plate so the whole video reads as one interface
// (docs/TREATMENT.md, "Style bible"). Canvas2D helpers work in logical 1920x1080 px.
//
//  - type: condensed title-card serif (evaTitle / condensed), Japanese labels (JP_SERIF / JP_SANS),
//    mono data (IBM Plex Mono via F.mono)
//  - shapes: chamfered panels, corner brackets, hexagons and hex grids, hazard stripes
//  - instruments: 7-segment digits, segmented level meters, warning boxes, tickers, scales
//  - motion: duck() (the sidechain bounce), songBar()/barTime() on the song's bar grid
//  - GL: makeScanPass() (CRT scanlines + phosphor mask, multiplied over the frame), GLSL_EVA (hexes)
import * as THREE from 'three';
import type { AudioData } from '../../show/audio.ts';
import type { Frame } from '../../show/scene.ts';
import { FSPass, W, H } from '../../show/gl.ts';
import { rgba } from '../../show/palette.ts';
import { F, font } from '../../show/type.ts';
import { clamp, hash, TAU } from '../../show/util.ts';

// ---------------------------------------------------------------- song grid
/** Index offset: au.downbeats[k + BAR_OFF] is song bar k (bar 0 at 4.82 s). */
export const BAR_OFF = 2;
export const barTime = (au: AudioData, k: number) => au.downbeats[k + BAR_OFF] ?? (au.downbeats[au.downbeats.length - 1]! + (k + BAR_OFF - au.downbeats.length + 1) * (240 / au.bpm));
export const songBar = (au: AudioData, t: number) => au.barAt(t) - BAR_OFF;

/** The sidechain bounce 0..1 (1 = full dip on the kick), faded out when the drums are. */
export function duck(f: Frame, a: AudioData, weight = 1): number {
  return (1 - a.pump(f.t)) * clamp(f.a.drums * 1.4) * weight;
}

// ---------------------------------------------------------------- type
// AAAVS: the bundled Noto JP subsets come first so Japanese renders identically on every machine
// (upstream relied on the macOS system fonts listed after them).
export const JP_SERIF = '"ShowJPSerif", "Hiragino Mincho ProN", "Hiragino Mincho Pro", "Yu Mincho", "Songti SC", serif';
export const JP_SANS = '"ShowJPSans", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "PingFang SC", sans-serif';
export const jp = (px: number, weight = 600, serif = true) => `${weight} ${px}px ${serif ? JP_SERIF : JP_SANS}`;

/**
 * Condensed heavy serif, the title-card voice: Cormorant 600 squeezed horizontally (sx < 1).
 * align 'left' | 'center' | 'right'. Returns the drawn width.
 */
export function condensed(c: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, o: { sx?: number; color?: string; align?: CanvasTextAlign; tracking?: number; weight?: number; family?: string; bold?: number } = {}) {
  const sx = o.sx ?? 0.62;
  c.save();
  c.font = o.family ? `${o.weight ?? 600} ${size}px ${o.family}` : font(F.serif(o.weight ?? 600), size);
  c.letterSpacing = `${o.tracking ?? 0}px`;
  c.textBaseline = 'alphabetic';
  const w = c.measureText(text).width * sx;
  const al = o.align ?? 'left';
  const x0 = al === 'center' ? x - w / 2 : al === 'right' ? x - w : x;
  c.translate(x0, y);
  c.scale(sx, 1);
  c.textAlign = 'left';
  c.fillStyle = o.color ?? rgba('bone', 1);
  c.fillText(text, 0, 0);
  // embolden (Cormorant is lighter than the title-card serif): a same-colour stroke, `bold` × size
  const bd = o.bold ?? 0.022;
  if (bd > 0) { c.strokeStyle = c.fillStyle; c.lineWidth = size * bd; c.lineJoin = 'miter'; c.strokeText(text, 0, 0); }
  c.restore();
  return w;
}

/**
 * The episode title card: stacked lines of condensed serif in very different sizes, white on
 * black, hard-left or hard-right aligned. `lines`: [text, size, sx?][].
 */
export function evaTitle(c: CanvasRenderingContext2D, x: number, y: number, lines: [string, number, number?][], o: { color?: string; align?: CanvasTextAlign; lead?: number; reveal?: number } = {}) {
  let yy = y;
  const n = lines.length, rev = o.reveal ?? 1;
  lines.forEach(([txt, size, sx], i) => {
    yy += size * (o.lead ?? 0.86);
    if (i / n >= rev) return;
    condensed(c, txt, x, yy, size, { sx: sx ?? 0.6, color: o.color, align: o.align });
  });
  return yy;
}

/** Small tracked mono label with an optional Japanese line (the HUD's bilingual captions). */
export function evaLabel(c: CanvasRenderingContext2D, x: number, y: number, en: string, jpText?: string, o: { color?: string; size?: number; align?: CanvasTextAlign; alpha?: number } = {}) {
  const s = o.size ?? 1, a = o.alpha ?? 1;
  c.save();
  c.globalAlpha *= a;
  c.textAlign = o.align ?? 'left';
  c.textBaseline = 'alphabetic';
  c.fillStyle = o.color ?? rgba('orange', 1);
  c.font = font(F.mono(600), 13 * s);
  c.letterSpacing = `${2.4 * s}px`;
  c.fillText(en.toUpperCase(), x, y);
  c.letterSpacing = '0px';
  if (jpText) { c.font = jp(15 * s, 600, false); c.fillText(jpText, x, y + 20 * s); }
  c.restore();
}

// ---------------------------------------------------------------- shapes
/** Path of a rectangle with chamfered (45°) corners; `cut` px, per-corner via [tl, tr, br, bl]. */
export function chamferPath(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, cut: number | [number, number, number, number] = 14) {
  const [a, b, d, e] = typeof cut === 'number' ? [cut, cut, cut, cut] : cut;
  c.beginPath();
  c.moveTo(x + a, y); c.lineTo(x + w - b, y); c.lineTo(x + w, y + b);
  c.lineTo(x + w, y + h - d); c.lineTo(x + w - d, y + h); c.lineTo(x + e, y + h);
  c.lineTo(x, y + h - e); c.lineTo(x, y + a); c.closePath();
}

/**
 * A NERV panel: chamfered outline, dark fill, a header tab with a title (EN + optional JP) and a
 * thin inner rule. Returns the content rect below the header.
 */
export function panel(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, o: { title?: string; jp?: string; color?: string; fill?: string; cut?: number; alpha?: number; header?: number; lw?: number } = {}) {
  const col = o.color ?? rgba('orange', 1), a = o.alpha ?? 1, cut = o.cut ?? 16, hh = o.title ? (o.header ?? 30) : 0;
  c.save();
  c.globalAlpha *= a;
  chamferPath(c, x, y, w, h, [0, cut, 0, cut]);
  c.fillStyle = o.fill ?? 'rgba(18,12,6,0.72)';
  c.fill();
  c.strokeStyle = col; c.lineWidth = o.lw ?? 1.5;
  c.stroke();
  if (o.title) {
    // header tab: solid colour block with the title knocked out in black
    c.fillStyle = col;
    chamferPath(c, x, y, Math.min(w * 0.62, 32 + o.title.length * 11.5 + (o.jp ? o.jp.length * 17 + 16 : 0)), hh, [0, hh * 0.6, 0, 0]);
    c.fill();
    c.fillStyle = rgba('ink', 1);
    c.font = font(F.mono(700), 14); c.letterSpacing = '2px'; c.textBaseline = 'middle';
    c.fillText(o.title.toUpperCase(), x + 12, y + hh / 2 + 1);
    const tw = c.measureText(o.title.toUpperCase()).width;
    c.letterSpacing = '0px';
    if (o.jp) { c.font = jp(15, 700, false); c.fillText(o.jp, x + 24 + tw, y + hh / 2 + 1); }
    c.strokeStyle = col; c.globalAlpha *= 0.5; c.lineWidth = 1;
    c.beginPath(); c.moveTo(x + 6, y + hh + 4); c.lineTo(x + w - 6, y + hh + 4); c.stroke();
  }
  c.restore();
  return { x: x + 10, y: y + hh + 12, w: w - 20, h: h - hh - 22 };
}

/** Corner brackets around a rect (targeting frames). */
export function brackets(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, len = 18, color = rgba('orange', 1), lw = 2) {
  c.save();
  c.strokeStyle = color; c.lineWidth = lw; c.lineCap = 'square';
  c.beginPath();
  c.moveTo(x, y + len); c.lineTo(x, y); c.lineTo(x + len, y);
  c.moveTo(x + w - len, y); c.lineTo(x + w, y); c.lineTo(x + w, y + len);
  c.moveTo(x + w, y + h - len); c.lineTo(x + w, y + h); c.lineTo(x + w - len, y + h);
  c.moveTo(x + len, y + h); c.lineTo(x, y + h); c.lineTo(x, y + h - len);
  c.stroke();
  c.restore();
}

/** Hexagon path (pointy-top when rot = 0; rot = π/6 for flat-top). */
export function hexPath(c: CanvasRenderingContext2D, cx: number, cy: number, r: number, rot = 0) {
  c.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = rot + Math.PI / 6 + (i * TAU) / 6;
    const px = cx + r * Math.cos(a), py = cy + r * Math.sin(a);
    if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
  }
  c.closePath();
}

/**
 * Visit a pointy-top hex grid covering the rect: fn(cx, cy, col, row, index). `r` = circumradius,
 * `gap` shrinks the drawn cell (call hexPath(c, cx, cy, r - gap) yourself).
 */
export function hexGrid(x: number, y: number, w: number, h: number, r: number, fn: (cx: number, cy: number, col: number, row: number, i: number) => void) {
  const dx = Math.sqrt(3) * r, dy = 1.5 * r;
  let i = 0;
  for (let row = 0; y + row * dy <= y + h + r; row++) {
    for (let col = 0; x + col * dx <= x + w + dx; col++) {
      fn(x + col * dx + (row % 2 ? dx / 2 : 0), y + row * dy, col, row, i++);
    }
  }
}

/** Diagonal hazard stripes filling a rect (the EMERGENCY band); `phase` scrolls them (px). */
export function hazard(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, phase = 0, a = rgba('red', 1), b = 'rgba(0,0,0,0)', stripe = 26) {
  c.save();
  c.beginPath(); c.rect(x, y, w, h); c.clip();
  if (b !== 'rgba(0,0,0,0)') { c.fillStyle = b; c.fillRect(x, y, w, h); }
  c.fillStyle = a;
  const p = ((phase % (stripe * 2)) + stripe * 2) % (stripe * 2);
  for (let sx = x - h - stripe * 2 + p; sx < x + w + stripe; sx += stripe * 2) {
    c.beginPath();
    c.moveTo(sx, y + h); c.lineTo(sx + h, y); c.lineTo(sx + h + stripe, y); c.lineTo(sx + stripe, y + h);
    c.closePath(); c.fill();
  }
  c.restore();
}

// ---------------------------------------------------------------- instruments
// segments: a top, b upper-right, c lower-right, d bottom, e lower-left, f upper-left, g middle
const SEG: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg', '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
  '-': 'g', ' ': '', A: 'abcefg', E: 'adefg', F: 'aefg', H: 'bcefg', L: 'def', P: 'abefg', r: 'eg', o: 'cdeg', U: 'bcdef', n: 'ceg', t: 'defg', d: 'bcdeg', b: 'cdefg', C: 'adef', S: 'acdfg',
};
/**
 * 7-segment readout (the battery countdown voice). `h` digit height; unlit segments drawn in
 * `dim` (pass null to skip). Supports ':' and '.'. Returns the width.
 */
export function sevenSeg(c: CanvasRenderingContext2D, text: string, x: number, y: number, h: number, color = rgba('orange', 1), dim: string | null = rgba('orange', 0.08), o: { skew?: number; thick?: number; glow?: number } = {}) {
  const w = h * 0.52, t = o.thick ?? h * 0.11, sk = o.skew ?? 0.1, gap = t * 0.18;
  let cx = x;
  c.save();
  if (o.glow) { c.shadowColor = color; c.shadowBlur = o.glow; }
  const seg = (on: boolean, pts: [number, number][]) => {
    if (!on && !dim) return;
    c.fillStyle = on ? color : dim!;
    c.beginPath();
    pts.forEach(([px, py], i) => { const X = cx + px + (h - py) * sk, Y = y + py; if (i) c.lineTo(X, Y); else c.moveTo(X, Y); });
    c.closePath(); c.fill();
  };
  for (const ch of text) {
    if (ch === ':' || ch === '.') {
      c.fillStyle = color;
      if (ch === ':') { c.fillRect(cx + t * 0.6 + h * 0.66 * sk, y + h * 0.3, t, t); c.fillRect(cx + t * 0.6 + h * 0.3 * sk, y + h * 0.66, t, t); }
      else c.fillRect(cx + t * 0.4, y + h - t, t, t);
      cx += t * 2.6; continue;
    }
    const on = SEG[ch] ?? '';
    const m = h / 2, hw = t / 2;
    // horizontal: a (top), g (mid), d (bottom); vertical: f,b (upper), e,c (lower)
    const hz = (yy: number): [number, number][] => [[gap + hw, yy], [gap + t, yy - hw], [w - gap - t, yy - hw], [w - gap - hw, yy], [w - gap - t, yy + hw], [gap + t, yy + hw]];
    const vt = (xx: number, y0: number, y1: number): [number, number][] => [[xx, y0 + gap + hw], [xx + hw, y0 + gap + t], [xx + hw, y1 - gap - t], [xx, y1 - gap - hw], [xx - hw, y1 - gap - t], [xx - hw, y0 + gap + t]];
    seg(on.includes('a'), hz(hw)); seg(on.includes('g'), hz(m)); seg(on.includes('d'), hz(h - hw));
    seg(on.includes('f'), vt(hw, 0, m)); seg(on.includes('b'), vt(w - hw, 0, m));
    seg(on.includes('e'), vt(hw, m, h)); seg(on.includes('c'), vt(w - hw, m, h));
    cx += w + t * 1.2;
  }
  c.restore();
  return cx - x;
}

/** Segmented level meter (n blocks) filled to v (0..1); horizontal unless vertical. */
export function segMeter(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, n: number, v: number, o: { color?: string; hot?: string; hotFrom?: number; dim?: string; vertical?: boolean; gap?: number } = {}) {
  const g = o.gap ?? 2, lit = v * n;
  for (let i = 0; i < n; i++) {
    const k = i / n;
    const col = k >= (o.hotFrom ?? 0.8) ? (o.hot ?? rgba('red', 1)) : (o.color ?? rgba('orange', 1));
    const on = i < Math.floor(lit) ? 1 : i < lit ? lit - i : 0;
    c.fillStyle = on > 0 ? col : (o.dim ?? rgba('orange', 0.1));
    c.globalAlpha = on > 0 ? 0.35 + 0.65 * on : 1;
    if (o.vertical) { const bh = (h - g * (n - 1)) / n; c.fillRect(x, y + h - (i + 1) * bh - i * g, w, bh); }
    else { const bw = (w - g * (n - 1)) / n; c.fillRect(x + i * (bw + g), y, bw, h); }
  }
  c.globalAlpha = 1;
}

/** Tick scale along a line with labels every `major` ticks (rulers on gauges). */
export function scale(c: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, n: number, o: { major?: number; tick?: number; color?: string; label?: (i: number) => string | null; side?: 1 | -1 } = {}) {
  const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy), nx = (dy / L) * (o.side ?? 1), ny = (-dx / L) * (o.side ?? 1), tk = o.tick ?? 6, mj = o.major ?? 5;
  c.save();
  c.strokeStyle = o.color ?? rgba('orange', 0.8); c.fillStyle = o.color ?? rgba('orange', 0.8); c.lineWidth = 1;
  c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1);
  for (let i = 0; i <= n; i++) {
    const px = x0 + (dx * i) / n, py = y0 + (dy * i) / n, len = i % mj === 0 ? tk * 1.8 : tk;
    c.moveTo(px, py); c.lineTo(px + nx * len, py + ny * len);
  }
  c.stroke();
  if (o.label) {
    c.font = font(F.mono(500), 11); c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let i = 0; i <= n; i += mj) { const s = o.label(i); if (s) c.fillText(s, x0 + (dx * i) / n + nx * (tk * 1.8 + 12), y0 + (dy * i) / n + ny * (tk * 1.8 + 12)); }
  }
  c.restore();
}

/**
 * The EMERGENCY box: red chamfered frame, hazard bands top and bottom, a big condensed word and a
 * Japanese line. `blink` 0..1 (drive with claps); `phase` scrolls the stripes.
 */
export function warningBox(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, word: string, jpText: string, o: { blink?: number; phase?: number; color?: string } = {}) {
  const col = o.color ?? rgba('red', 1), bl = o.blink ?? 1;
  c.save();
  chamferPath(c, x, y, w, h, 18);
  c.fillStyle = `rgba(40,0,0,${0.55 + 0.35 * bl})`; c.fill();
  c.strokeStyle = col; c.lineWidth = 3; c.stroke();
  const band = h * 0.14;
  hazard(c, x + 10, y + 10, w - 20, band, o.phase ?? 0, col);
  hazard(c, x + 10, y + h - 10 - band, w - 20, band, -(o.phase ?? 0), col);
  c.globalAlpha = 0.4 + 0.6 * bl;
  condensed(c, word, x + w / 2, y + h * 0.66, h * 0.46, { sx: 0.58, color: col, align: 'center' });
  c.font = jp(h * 0.11, 700, false); c.fillStyle = col; c.textAlign = 'center';
  c.fillText(jpText, x + w / 2, y + h * 0.8);
  c.restore();
}

/** A scrolling text ticker clipped to [x, x + w]; `speed` px/s. */
export function ticker(c: CanvasRenderingContext2D, x: number, y: number, w: number, text: string, t: number, o: { speed?: number; color?: string; size?: number } = {}) {
  c.save();
  c.beginPath(); c.rect(x, y - (o.size ?? 13) - 4, w, (o.size ?? 13) + 10); c.clip();
  c.font = font(F.mono(500), o.size ?? 13); c.fillStyle = o.color ?? rgba('orange', 0.85); c.letterSpacing = '2px';
  const tw = c.measureText(text + '   ').width;
  let off = -((t * (o.speed ?? 80)) % tw);
  for (; off < w; off += tw) c.fillText(text + '   ', x + off, y);
  c.restore();
}

/** Deterministic flicker 0/1 for blinking indicators (per output frame is too fast; this is per `rate` Hz). */
export const blink = (t: number, rate = 4, duty = 0.5) => ((t * rate) % 1) < duty ? 1 : 0;

/** Pseudo-random hex data string (terminal filler), stable for (seed, step). */
export function hexData(seed: number, step: number, n = 8) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(hash(seed, step, i) * 16).toString(16).toUpperCase();
  return s;
}

// ---------------------------------------------------------------- GL
/**
 * CRT look multiplied over the frame: horizontal scanlines (every 3 logical px), a faint RGB
 * phosphor mask and a slow rolling bar. Call after drawing the frame: scan.render(renderer, out).
 */
export function makeScanPass(strength = 0.22) {
  const p = new FSPass(/* glsl */ `
    uniform float t, k;
    void main() {
      vec2 px = FRAG_PX;
      float line = 0.5 + 0.5 * cos(px.y * TAU / 3.0);
      float roll = 0.04 * smoothstep(0.0, 1.0, 1.0 - abs(fract(vUv.y * 0.6 - t * 0.12) - 0.5) * 8.0);
      vec3 m = vec3(1.0) - k * (1.0 - line) * 0.9;
      float col = mod(floor(px.x), 3.0);
      m *= 1.0 - k * 0.12 * vec3(col != 0.0, col != 1.0, col != 2.0);
      fragColor = vec4(m + roll, 1.0);
    }`, { t: { value: 0 }, k: { value: strength } }, { blending: THREE.CustomBlending, transparent: true });
  p.mat.blendEquation = THREE.AddEquation;
  p.mat.blendSrc = THREE.DstColorFactor;
  p.mat.blendDst = THREE.ZeroFactor;
  p.mat.blendSrcAlpha = THREE.ZeroFactor;
  p.mat.blendDstAlpha = THREE.OneFactor;
  return p;
}

/**
 * GLSL: pointy-top hex grid. hexCell(p, r) → vec4(local.xy, id.xy) for circumradius r;
 * hexEdge(local, r) → distance to the cell border (0 at the edge, r*0.866 at the centre).
 */
export const GLSL_EVA = /* glsl */ `
vec4 hexCell(vec2 p, float r) {
  vec2 s = vec2(1.7320508, 1.5) * r;
  vec2 a = mod(p, vec2(s.x, s.y * 2.0)) - vec2(s.x * 0.5, s.y);
  vec2 b = mod(p - vec2(s.x * 0.5, s.y), vec2(s.x, s.y * 2.0)) - vec2(s.x * 0.5, s.y);
  vec2 g = dot(a, a) < dot(b, b) ? a : b;
  return vec4(g, floor((p - g) / (r * 0.5) + 0.5));
}
float hexEdge(vec2 g, float r) {
  vec2 q = abs(g);
  float d = max(q.x, dot(q, vec2(0.5, 0.8660254)));
  return r * 0.8660254 - d;
}`;

export { W, H };
