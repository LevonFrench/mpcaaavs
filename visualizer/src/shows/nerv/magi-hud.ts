// Ported from bizarro/evangelion app/src/scenes/magi-hud.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// Shared chrome for the groove plates (magi, psycho, radar): the NERV terminal header / footer
// strips, a dim GL hex-grid ground, and small helpers. Built on the kit in _eva.ts.
import { FSPass } from '../../show/gl.ts';
import { LIN, rgba, type PaletteKey } from '../../show/palette.ts';
import { F, font } from '../../show/type.ts';
import { clamp } from '../../show/util.ts';
import type { AudioData } from '../../show/audio.ts';
import { GLSL_EVA, chamferPath, jp, sevenSeg, songBar, ticker } from './_eva.ts';

/** Linear colour triplet scaled by k (LineBatch colours; > 1 blooms). */
export const lin = (key: PaletteKey, k = 1): [number, number, number] => [LIN[key][0] * k, LIN[key][1] * k, LIN[key][2] * k];

/** Pointy-top GL hex grid ground: very dim lines, a few cells breathing, brightening on the kick. */
export function makeHexGround(r = 36) {
  return new FSPass(/* glsl */ `
    ${GLSL_EVA}
    uniform float t, k, a, seed;
    uniform vec3 col;
    void main() {
      vec2 p = FRAG_PX;
      vec4 h = hexCell(p, ${r.toFixed(1)});
      float e = hexEdge(h.xy, ${r.toFixed(1)});
      float line = pxLine(e, 0.5, 1.5);
      float n = hash12(h.zw + seed * 1.37);
      float cell = step(0.985, n) * smoothstep(0.0, 8.0, e);
      vec2 uv = p / vec2(1920.0, 1080.0) - 0.5;
      float fall = 1.0 - smoothstep(0.25, 0.75, length(uv * vec2(1.0, 1.4)));
      vec3 c = C_INK + col * (line * a * (0.55 + 0.45 * fall) * (1.0 + 1.2 * k) + cell * a * 0.35);
      fragColor = vec4(c, 1.0);
    }`, { t: { value: 0 }, k: { value: 0 }, a: { value: 0.05 }, seed: { value: 0 }, col: { value: [...LIN.orange] } });
}

export interface ChromeOpts {
  /** plate number, title (EN caps) and Japanese title */
  no: string; en: string; jpText: string;
  /** secondary line under the title */
  sub?: string;
  color?: string;
  /** footer ticker */
  tick?: string;
  /** 0..1 reveal (the plate's opening wipe) */
  reveal?: number;
}

/**
 * Header strip (y 30..100): solid plate-number tab, title + JP, a long ruled line with ticks,
 * song time in 7-seg and the bar counter on the right. Footer (y 1030..1060): rule + ticker.
 */
export function chrome(c: CanvasRenderingContext2D, t: number, au: AudioData, o: ChromeOpts) {
  const col = o.color ?? rgba('orange', 1), rv = o.reveal ?? 1;
  const X0 = 56, X1 = 1864;
  c.save();
  // number tab
  c.fillStyle = col;
  chamferPath(c, X0, 34, 78, 52, [0, 16, 0, 0]); c.fill();
  c.fillStyle = rgba('ink', 1);
  c.font = font(F.mono(700), 30); c.textBaseline = 'middle'; c.textAlign = 'center';
  c.fillText(o.no, X0 + 36, 62);
  // title
  c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  c.fillStyle = col;
  c.font = font(F.mono(700), 22); c.letterSpacing = '5px';
  c.fillText(o.en, X0 + 96, 60);
  const tw = c.measureText(o.en).width;
  c.letterSpacing = '0px';
  c.font = jp(22, 700, false);
  c.fillText(o.jpText, X0 + 96 + tw + 18, 60);
  if (o.sub) { c.font = font(F.mono(500), 12); c.letterSpacing = '2.4px'; c.globalAlpha = 0.75; c.fillText(o.sub, X0 + 96, 82); c.globalAlpha = 1; c.letterSpacing = '0px'; }
  // rule with ticks
  const rw = (X1 - X0) * rv;
  c.fillRect(X0, 100, rw, 2);
  c.globalAlpha = 0.6;
  for (let x = X0; x <= X0 + rw; x += 24) c.fillRect(x, 102, 1, (x - X0) % 120 === 0 ? 8 : 4);
  c.globalAlpha = 1;
  // right: song time as 7-seg + bar/beat counter
  const mm = Math.floor(t / 60), ss = t - mm * 60;
  const tc = `${String(mm).padStart(2, '0')}:${ss.toFixed(2).padStart(5, '0')}`;
  const w7 = segWidth(tc, 30, 3.6);
  sevenSeg(c, tc, X1 - w7, 40, 30, col, rgba('orange', 0.08), { thick: 3.6 });
  const b = songBar(au, t), bi = Math.floor(b), beat = Math.floor((b - bi) * au.beatsPerBar) + 1;
  c.font = font(F.mono(600), 12); c.letterSpacing = '2.4px'; c.textAlign = 'right';
  c.fillText(`BAR ${String(bi).padStart(3, '0')}  BEAT ${beat}  133.33 BPM`, X1 - w7 - 24, 58);
  c.font = jp(13, 600, false); c.letterSpacing = '0px';
  c.fillText('経過時間  小節  拍', X1 - w7 - 24, 80);
  // beat pips
  for (let i = 0; i < 4; i++) {
    c.globalAlpha = i + 1 === beat ? 1 : 0.18;
    c.fillRect(X1 - w7 - 24 - 150 + i * 18, 86, 12, 5);
  }
  c.globalAlpha = 1;
  // footer
  c.textAlign = 'left';
  c.fillRect(X0, 1028, rw, 1);
  if (o.tick) ticker(c, X0 + 250, 1054, X1 - X0 - 250, o.tick, t, { speed: 70, color: rgba('orange', 0.6), size: 12 });
  c.fillStyle = col;
  chamferPath(c, X0, 1036, 230, 26, [0, 0, 10, 0]); c.fill();
  c.fillStyle = rgba('ink', 1); c.font = font(F.mono(700), 12); c.letterSpacing = '2px'; c.textBaseline = 'middle';
  c.fillText('NERV HQ  中央作戦室', X0 + 10, 1050);
  c.restore();
}

/** Width sevenSeg() will draw `text` at digit height h (thickness `thick`, default h * 0.11). */
export function segWidth(text: string, h: number, thick = h * 0.11) {
  let w = 0;
  for (const ch of text) w += ch === ':' || ch === '.' ? thick * 2.6 : h * 0.52 + thick * 1.2;
  return w;
}

/** Key : value metadata column (the MAGI-screen "CODE : 473" voice). */
export function meta(c: CanvasRenderingContext2D, x: number, y: number, rows: [string, string][], o: { color?: string; size?: number; lead?: number; keyW?: number } = {}) {
  const s = o.size ?? 13, lead = o.lead ?? s * 1.65, kw = o.keyW ?? 118;
  c.save();
  c.fillStyle = o.color ?? rgba('orange', 1);
  c.font = font(F.mono(600), s); c.letterSpacing = '1.5px'; c.textBaseline = 'alphabetic';
  rows.forEach(([k, v], i) => { c.fillText(k, x, y + i * lead); c.fillText(': ' + v, x + kw, y + i * lead); });
  c.restore();
}

/** Clamp helper for alpha fades of a whole group. */
export const fadeIn = (t: number, t0: number, dur = 0.25) => clamp((t - t0) / dur);
