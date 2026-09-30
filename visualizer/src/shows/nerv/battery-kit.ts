// Ported from bizarro/evangelion app/src/scenes/battery-kit.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// Helpers for the battery plate ("INTERNAL BATTERY", build 1): the terminal header/footer, the
// GL composite (hex ground + UI layer with row glitch, alarm wash and the CRT power-off), the
// battery-cell icon meter, colour mixing and the plate's audio-derived event lists.
import * as THREE from 'three';
import { FSPass } from '../../show/gl.ts';
import { HEX, LIN, rgba } from '../../show/palette.ts';
import { F, font } from '../../show/type.ts';
import { clamp } from '../../show/util.ts';
import type { AudioData } from '../../show/audio.ts';
import { GLSL_EVA, chamferPath, jp, sevenSeg, songBar, ticker } from './_eva.ts';

// ---------------------------------------------------------------- colour
const rgbOf = (key: string) => {
  const n = parseInt(((HEX as Record<string, string>)[key] ?? key).replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
};
/** CSS colour between two palette keys (k = 0 → a, 1 → b). */
export function mixc(a: string, b: string, k: number, alpha = 1) {
  const A = rgbOf(a), B = rgbOf(b), q = clamp(k);
  return `rgba(${Math.round(A[0] + (B[0] - A[0]) * q)},${Math.round(A[1] + (B[1] - A[1]) * q)},${Math.round(A[2] + (B[2] - A[2]) * q)},${alpha})`;
}

// ---------------------------------------------------------------- text helpers
/** Width sevenSeg() draws `text` at digit height h (thickness `thick`, default h * 0.11). */
export function segWidth(text: string, h: number, thick = h * 0.11) {
  let w = 0;
  for (const ch of text) w += ch === ':' || ch === '.' ? thick * 2.6 : h * 0.52 + thick * 1.2;
  return w;
}

/** Tracked mono text. */
export function mono(c: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, o: { w?: number; track?: number; align?: CanvasTextAlign } = {}) {
  c.font = font(F.mono(o.w ?? 600), size);
  c.letterSpacing = `${o.track ?? size * 0.16}px`;
  c.fillStyle = color; c.textAlign = o.align ?? 'left'; c.textBaseline = 'alphabetic';
  c.fillText(s, x, y);
  c.letterSpacing = '0px'; c.textAlign = 'left';
}

/** Key : value metadata column. */
export function meta(c: CanvasRenderingContext2D, x: number, y: number, rows: [string, string][], o: { color?: string; size?: number; lead?: number; keyW?: number } = {}) {
  const s = o.size ?? 13, lead = o.lead ?? s * 1.65, kw = o.keyW ?? 118;
  c.save();
  c.fillStyle = o.color ?? rgba('orange', 1);
  c.font = font(F.mono(600), s); c.letterSpacing = '1.5px'; c.textBaseline = 'alphabetic';
  rows.forEach(([k, v], i) => { c.fillText(k, x, y + i * lead); c.fillText(': ' + v, x + kw, y + i * lead); });
  c.restore();
}

// ---------------------------------------------------------------- chrome
/**
 * Header strip (y 30..108): plate-number tab, title + JP, sub line, ruled line with ticks, song
 * time 7-seg + bar/beat counter; footer (y 1028..1062): rule, NERV HQ tab, ticker.
 */
export function batteryChrome(c: CanvasRenderingContext2D, t: number, au: AudioData, o: { col: string; dim: string; tick: string; right?: string; rightJp?: string }) {
  const col = o.col, X0 = 56, X1 = 1864;
  c.save();
  c.fillStyle = col;
  chamferPath(c, X0, 34, 78, 52, [0, 16, 0, 0]); c.fill();
  c.fillStyle = rgba('ink', 1);
  c.font = font(F.mono(700), 30); c.textBaseline = 'middle'; c.textAlign = 'center';
  c.fillText('07', X0 + 36, 62);
  c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  c.fillStyle = col;
  c.font = font(F.mono(700), 22); c.letterSpacing = '5px';
  c.fillText('INTERNAL BATTERY', X0 + 96, 60);
  const tw = c.measureText('INTERNAL BATTERY').width;
  c.letterSpacing = '0px';
  c.font = jp(22, 700, false);
  c.fillText('内部電源  活動限界', X0 + 96 + tw + 18, 60);
  c.font = font(F.mono(500), 12); c.letterSpacing = '2.4px'; c.globalAlpha = 0.75;
  c.fillText('EVA UNIT-01  //  UMBILICAL CABLE MONITOR  //  S2-LESS POWER SUPPLY  //  エントリープラグ電源系統', X0 + 96, 82);
  c.globalAlpha = 1; c.letterSpacing = '0px';
  c.fillRect(X0, 100, X1 - X0, 2);
  c.globalAlpha = 0.6;
  for (let x = X0; x <= X1; x += 24) c.fillRect(x, 102, 1, (x - X0) % 120 === 0 ? 8 : 4);
  c.globalAlpha = 1;
  const mm = Math.floor(t / 60), ss = t - mm * 60;
  const tc = `${String(mm).padStart(2, '0')}:${ss.toFixed(2).padStart(5, '0')}`;
  const w7 = segWidth(tc, 30, 3.6);
  sevenSeg(c, tc, X1 - w7, 40, 30, col, o.dim, { thick: 3.6 });
  const b = songBar(au, t), bi = Math.floor(b), beat = Math.floor((b - bi) * au.beatsPerBar) + 1;
  c.font = font(F.mono(600), 12); c.letterSpacing = '2.4px'; c.textAlign = 'right';
  c.fillText(o.right ?? `BAR ${String(bi).padStart(3, '0')}  BEAT ${beat}  133.33 BPM`, X1 - w7 - 24, 58);
  c.font = jp(13, 600, false); c.letterSpacing = '0px';
  c.fillText(o.rightJp ?? '経過時間  小節  拍', X1 - w7 - 24, 80);
  for (let i = 0; i < 4; i++) {
    c.globalAlpha = i + 1 === beat ? 1 : 0.18;
    c.fillRect(X1 - w7 - 24 - 150 + i * 18, 86, 12, 5);
  }
  c.globalAlpha = 1;
  c.textAlign = 'left';
  c.fillRect(X0, 1028, X1 - X0, 1);
  ticker(c, X0 + 250, 1054, X1 - X0 - 250, o.tick, t, { speed: 90, color: col.replace(/,[\d.]+\)$/, ',0.62)'), size: 12 });
  c.fillStyle = col;
  chamferPath(c, X0, 1036, 230, 26, [0, 0, 10, 0]); c.fill();
  c.fillStyle = rgba('ink', 1); c.font = font(F.mono(700), 12); c.letterSpacing = '2px'; c.textBaseline = 'middle';
  c.fillText('NERV HQ  中央作戦室', X0 + 10, 1050);
  c.restore();
}

// ---------------------------------------------------------------- instruments
/**
 * A battery-cell icon meter (vertical): terminal cap, chamfered case, n blocks lit from the bottom
 * to `v`. Low charge turns the lit blocks red; `flash` 0..1 brightens the top block (load spike).
 */
export function batteryCell(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, n: number, v: number, o: { col: string; low: string; dim: string; flash?: number; lw?: number }) {
  const cap = 10, g = 3;
  c.save();
  c.fillStyle = o.col;
  c.fillRect(x + w * 0.32, y, w * 0.36, cap - 2);
  chamferPath(c, x, y + cap, w, h - cap, [0, 8, 0, 8]);
  c.strokeStyle = o.col; c.lineWidth = o.lw ?? 2; c.stroke();
  const ix = x + 6, iy = y + cap + 6, iw = w - 12, ih = h - cap - 12;
  const bh = (ih - g * (n - 1)) / n, lit = clamp(v) * n;
  const isLow = v < 0.25;
  for (let i = 0; i < n; i++) {
    const on = i < Math.floor(lit) ? 1 : i < lit ? lit - i : 0;
    const by = iy + ih - (i + 1) * bh - i * g;
    c.fillStyle = on > 0 ? (isLow ? o.low : o.col) : o.dim;
    c.globalAlpha = on > 0 ? 0.3 + 0.7 * on : 1;
    c.fillRect(ix, by, iw, bh);
    if (on > 0 && i === Math.ceil(lit) - 1 && (o.flash ?? 0) > 0) {
      c.globalAlpha = o.flash!; c.fillStyle = rgba('bone', 1); c.fillRect(ix, by, iw, bh);
    }
  }
  c.restore();
}

/** Semicircular needle gauge (the bass voltmeter). v 0..1; `ticks` major divisions labelled by fn. */
export function needleGauge(c: CanvasRenderingContext2D, cx: number, cy: number, r: number, v: number, o: { col: string; hot: string; label: (i: number) => string; n?: number; redFrom?: number }) {
  const n = o.n ?? 10, a0 = Math.PI * 1.1, a1 = Math.PI * 1.9;
  c.save();
  c.lineWidth = 1.2; c.strokeStyle = o.col;
  c.beginPath(); c.arc(cx, cy, r, a0, a1); c.stroke();
  // red zone
  const rz = o.redFrom ?? 0.8;
  c.strokeStyle = o.hot; c.lineWidth = 6;
  c.beginPath(); c.arc(cx, cy, r - 5, a0 + (a1 - a0) * rz, a1); c.stroke();
  c.lineWidth = 1.2;
  for (let i = 0; i <= n * 5; i++) {
    const a = a0 + ((a1 - a0) * i) / (n * 5), major = i % 5 === 0;
    const r0 = r - (major ? 14 : 8);
    c.strokeStyle = i / (n * 5) >= rz ? o.hot : o.col;
    c.beginPath(); c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); c.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); c.stroke();
    if (major && (i / 5) % 2 === 0) {
      c.fillStyle = o.col; c.font = font(F.mono(500), 10); c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(o.label(i / 5), cx + Math.cos(a) * (r - 26), cy + Math.sin(a) * (r - 26));
    }
  }
  const a = a0 + (a1 - a0) * clamp(v);
  c.strokeStyle = rgba('amber', 1); c.lineWidth = 2.4;
  c.beginPath(); c.moveTo(cx - Math.cos(a) * 10, cy - Math.sin(a) * 10); c.lineTo(cx + Math.cos(a) * (r - 4), cy + Math.sin(a) * (r - 4)); c.stroke();
  c.fillStyle = rgba('amber', 1); c.beginPath(); c.arc(cx, cy, 5, 0, Math.PI * 2); c.fill();
  c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  c.restore();
}

// ---------------------------------------------------------------- audio events
/**
 * Vocal-chop times in [t0, t1]: onsets from the analysis plus local maxima of the vocal-stem
 * envelope (the chops late in the build are too dense for the onset detector), min spacing `gap`.
 */
export function vocalChops(au: AudioData, t0: number, t1: number, thr = 0.42, gap = 0.2): number[] {
  const out: number[] = [];
  const cand: number[] = au.events('vocal', t0, t1).filter((e) => e[1] > 0.2).map((e) => e[0]);
  const dt = 0.01;
  for (let t = t0 + dt; t < t1 - dt; t += dt) {
    const v = au.env('vocal', t);
    if (v > thr && v >= au.env('vocal', t - dt) && v > au.env('vocal', t + dt) && v - Math.min(au.env('vocal', t - 0.12), au.env('vocal', t + 0.12)) > 0.08) cand.push(t);
  }
  cand.sort((a, b) => a - b);
  for (const t of cand) if (!out.length || t - out[out.length - 1]! >= gap) out.push(t);
  return out;
}

/** Index of the last element <= t in a sorted array (-1 if none). */
export function lastIdx(arr: number[], t: number) {
  let lo = 0, hi = arr.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m]! <= t) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}

// ---------------------------------------------------------------- GL
/**
 * The plate's single GL pass: hex-grid ground + the UI layer composited on top with hard row
 * glitches (uGlitch, per frame index), an edge-weighted red alarm wash (uAlarm), a global power
 * level (uPower, flicker/dim) and the CRT power-off collapse (uOff: 0 on → 1 black).
 */
export function makeBatteryComp(tex: THREE.Texture) {
  return new FSPass(/* glsl */ `
    ${GLSL_EVA}
    uniform sampler2D uTex;
    uniform float uT, uFi, uGlitch, uAlarm, uPower, uOff, uKick, uGround;
    uniform vec3 uGroundCol;
    vec4 ui(vec2 uv) { vec4 c = texture(uTex, uv); return vec4(c.rgb * c.a, c.a); }
    void main() {
      vec2 px = FRAG_PX;
      vec2 uv = vUv;
      // CRT power-off: squash the picture vertically into a line, then the line into a dot
      float sq = 1.0 - smoothstep(0.0, 0.55, uOff) * 0.995;
      float sx = 1.0 - smoothstep(0.55, 0.9, uOff) * 0.998;
      vec2 cuv = vec2((uv.x - 0.5) / sx + 0.5, (uv.y - 0.5) / sq + 0.5);
      float inside = step(0.0, cuv.x) * step(cuv.x, 1.0) * step(0.0, cuv.y) * step(cuv.y, 1.0);
      // row glitch: bands of rows displaced horizontally (stable over a frame's shutter)
      float row = floor(px.y / 9.0);
      float g = hash12(vec2(row, uFi));
      float band = step(1.0 - 0.22 * uGlitch, hash12(vec2(floor(px.y / 46.0), uFi + 7.0)));
      float off = (g < 0.2 * uGlitch || band > 0.5) ? (hash12(vec2(row * 1.3, uFi + 1.7)) - 0.5) * 0.09 * uGlitch : 0.0;
      vec2 suv = cuv + vec2(off, 0.0);
      // ground: dim hex lattice, a few cells lit, brighter on the kick
      vec2 gp = vec2(px.x, 1080.0 - px.y);
      vec4 h = hexCell(gp, 38.0);
      float e = hexEdge(h.xy, 38.0);
      float line = pxLine(e, 0.5, 1.5);
      float cell = step(0.986, hash12(h.zw + floor(uT * 2.2222) * 1.37)) * smoothstep(0.0, 8.0, e);
      vec2 q = gp / vec2(1920.0, 1080.0) - 0.5;
      float fall = 1.0 - smoothstep(0.25, 0.75, length(q * vec2(1.0, 1.4)));
      vec3 col = C_INK + uGroundCol * (line * uGround * (0.55 + 0.45 * fall) * (1.0 + 1.2 * uKick) + cell * uGround * 0.35);
      // UI, with a slight RGB split on glitch rows
      vec4 a = ui(suv);
      if (off != 0.0) { a.r = ui(suv + vec2(0.004, 0.0)).r; a.b = ui(suv - vec2(0.004, 0.0)).b; }
      col = col * (1.0 - a.a) + a.rgb;
      // alarm wash: red from the edges, strongest on the frame border
      float edge = smoothstep(0.18, 0.62, length(q * vec2(1.0, 1.25)));
      col += C_RED * uAlarm * (0.006 + 0.11 * edge * edge);
      col *= uPower;
      // power-off: the collapsing picture brightens into an orange-white line, then black
      float lineGlow = smoothstep(0.35, 0.6, uOff) * (1.0 - smoothstep(0.85, 1.0, uOff));
      col = col * inside * (1.0 + 2.5 * smoothstep(0.2, 0.55, uOff));
      float dy = abs(uv.y - 0.5) * 1080.0, dx = abs(uv.x - 0.5) * 1920.0;
      float ln = exp(-dy / 2.2) * (1.0 - smoothstep(960.0 * sx - 40.0, 960.0 * sx + 4.0, dx));
      col += mix(C_ORANGE, C_BONE, 0.6) * ln * lineGlow * 3.0;
      col *= 1.0 - step(0.999, uOff);
      fragColor = vec4(col, 1.0);
    }`, {
    uTex: { value: tex }, uT: { value: 0 }, uFi: { value: 0 }, uGlitch: { value: 0 }, uAlarm: { value: 0 }, uPower: { value: 1 },
    uOff: { value: 0 }, uKick: { value: 0 }, uGround: { value: 0.05 }, uGroundCol: { value: new THREE.Vector3(...LIN.orange) },
  });
}
