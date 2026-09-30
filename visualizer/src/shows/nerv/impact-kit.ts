// Ported from bizarro/evangelion app/src/scenes/impact-kit.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// Helpers for the impact plate ("THIRD IMPACT", drop 3b): the background shader (the cross of light
// and the red horizon of the LCL sea behind the control wall), the red-shifting header / footer, and
// the wall's mini instruments. Each instrument draws into a panel's content rect from a shared
// per-frame state `S` (song time, audio, red-shift). Built on _eva.ts; echoes the earlier plates.
import * as THREE from 'three';
import type { AudioData } from '../../show/audio.ts';
import { FSPass } from '../../show/gl.ts';
import { rgba, type PaletteKey } from '../../show/palette.ts';
import { F, font } from '../../show/type.ts';
import { clamp, hash, noise1, smoothstep, TAU } from '../../show/util.ts';
import { chamferPath, condensed, GLSL_EVA, hazard, hexData, jp, segMeter, sevenSeg, songBar, ticker, warningBox } from './_eva.ts';
import { segWidth } from './magi-hud.ts';
import { melHz, octPath } from './atfield-kit.ts';

export type Rect = { x: number; y: number; w: number; h: number };

/** Per-frame state shared by the instruments. */
export interface S {
  au: AudioData;
  t: number;
  fi: number;
  /** 0..1 red-shift of the whole wall */
  red: number;
  /** kick bounce 0..1, decaying hit pulses */
  kd: number; kick: number; snare: number; hat: number; vox: number;
  bass: number; rms: number;
  mel: Float32Array; chroma: Float32Array;
  /** plate window */
  T0: number; T1: number;
  phrase: number;
  /** onset counters (step the data rows) */
  nHat: number; nKick: number;
  /** last kick / clap / vocal onset times */
  kT: number; cT: number; vT: number;
  /** kicks in the plate window (+ margin): [t, strength, with a clap] */
  kicks: [number, number, boolean][];
  /** red-shifted palette colour */
  C: (k: PaletteKey, a?: number) => string;
}

// ------------------------------------------------------------------ background
/**
 * Terminal black with a faint hex ground, the red horizon of the LCL sea rising from the bottom and
 * the giant cross of light centred on the wall's central gutters. `grow` 0..1 over the plate,
 * `pulseK` the kick bounce, `collapse` 0..1 shrinks the cross to a point at the very end.
 */
export function makeImpactBG() {
  return new FSPass(/* glsl */ `
    ${GLSL_EVA}
    uniform float t, grow, pulseK, bassK, redk, collapse, fseed, groundA, horizA;
    uniform vec2 ctr;
    void main() {
      vec2 p = vec2(FRAG_PX.x, 1080.0 - FRAG_PX.y);
      vec3 col = C_INK;
      // hex ground
      vec4 hc = hexCell(p - ctr, 34.0);
      float e = hexEdge(hc.xy, 34.0);
      float hl = pxLine(e, 0.5, 1.5);
      col += mix(C_ORANGE, C_RED, redk) * hl * 0.045 * groundA;
      // the red horizon (LCL sea): a curved edge rising with grow, glow above, banded sea below
      float dxh = (p.x - ctr.x) / 960.0;
      float hy = 1080.0 - (30.0 + 330.0 * grow) + dxh * dxh * 140.0;
      float above = hy - p.y;
      float glowH = exp(-max(above, 0.0) / (70.0 + 260.0 * grow)) * step(0.0, above);
      float seaD = max(-above, 0.0);
      float band = 0.5 + 0.5 * cos((p.y + t * 18.0) * TAU / 7.0);
      vec3 sea = C_BLOOD * (0.55 + 0.25 * band) * (1.0 - 0.5 * smoothstep(0.0, 300.0, seaD)) + C_RED * 0.3 * exp(-seaD / 30.0);
      float edge = exp(-abs(above) / 1.6);
      col += horizA * (C_RED * (0.55 * glowH * (0.8 + 0.4 * bassK)) + (1.0 - step(0.0, above)) * sea + C_RED * 2.2 * edge + C_AMBER * 0.6 * edge * redk);
      // the cross of light
      float ax = abs(p.x - ctr.x), ay = abs(p.y - ctr.y);
      float I = (0.4 + 0.6 * grow) * (1.0 + 0.35 * pulseK) * (1.0 - collapse * 0.6);
      float wv = (2.2 + 9.0 * grow) * (1.0 + 0.4 * pulseK) * (1.0 - collapse) + 0.35;
      float armL = (260.0 + 760.0 * grow) * (1.0 - collapse);
      float armV = mix(1300.0, 0.0, collapse);
      float streak = 0.75 + 0.25 * hash12(vec2(floor(p.y / 4.0), fseed));
      float streakH = 0.8 + 0.2 * hash12(vec2(floor(p.x / 4.0), fseed + 3.0));
      float vFall = 1.0 - smoothstep(armV * 0.35, armV, ay);
      float hFall = 1.0 - smoothstep(armL * 0.4, armL, ax);
      float coreV = exp(-ax / wv) * vFall * streak;
      float coreH = exp(-ay / (wv * 0.8)) * hFall * streakH;
      float haloV = exp(-ax / (22.0 + 64.0 * grow)) * vFall;
      float haloH = exp(-ay / (16.0 + 44.0 * grow)) * hFall;
      float centre = exp(-length(p - ctr) / (30.0 + 60.0 * grow));
      vec3 hot = mix(C_BONE, mix(C_BONE, C_RED, 0.25), redk);
      vec3 haloC = mix(C_AMBER, C_RED, 0.35 + 0.65 * redk);
      col += I * (hot * 3.0 * max(coreV, coreH) + haloC * 0.45 * max(haloV, haloH) + hot * 1.2 * centre);
      fragColor = vec4(col, 1.0);
    }`, {
    t: { value: 0 }, grow: { value: 0 }, pulseK: { value: 0 }, bassK: { value: 0 }, redk: { value: 0 }, collapse: { value: 0 },
    fseed: { value: 0 }, groundA: { value: 1 }, horizA: { value: 1 }, ctr: { value: new THREE.Vector2(960, 566) },
  });
}

// ------------------------------------------------------------------ text helpers
export function mono(c: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, o: { w?: number; track?: number; align?: CanvasTextAlign; base?: CanvasTextBaseline } = {}) {
  c.font = font(F.mono(o.w ?? 600), size); c.letterSpacing = `${o.track ?? size * 0.14}px`;
  c.fillStyle = color; c.textAlign = o.align ?? 'left'; c.textBaseline = o.base ?? 'alphabetic';
  c.fillText(s, x, y);
  c.letterSpacing = '0px'; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
}
export function jt(c: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, o: { w?: number; serif?: boolean; align?: CanvasTextAlign; base?: CanvasTextBaseline } = {}) {
  c.font = jp(size, o.w ?? 700, o.serif ?? false); c.fillStyle = color; c.textAlign = o.align ?? 'left'; c.textBaseline = o.base ?? 'alphabetic';
  c.fillText(s, x, y);
  c.textAlign = 'left'; c.textBaseline = 'alphabetic';
}
const pad2 = (n: number) => String(Math.max(0, Math.floor(n))).padStart(2, '0');

// ------------------------------------------------------------------ header / footer
/** The wall's header strip and footer ticker (magi-hud's chrome, red-shifting). */
export function wallChrome(c: CanvasRenderingContext2D, s: S, reveal: number) {
  const { t, au, C } = s;
  const col = C('orange'), X0 = 56, X1 = 1864;
  c.save();
  c.fillStyle = col;
  chamferPath(c, X0, 34, 78, 52, [0, 16, 0, 0]); c.fill();
  c.fillStyle = rgba('ink', 1); c.font = font(F.mono(700), 30); c.textBaseline = 'middle'; c.textAlign = 'center';
  c.fillText('15', X0 + 36, 62);
  c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  c.fillStyle = col; c.font = font(F.mono(700), 22); c.letterSpacing = '5px';
  c.fillText('THIRD IMPACT', X0 + 96, 60);
  const tw = c.measureText('THIRD IMPACT').width;
  c.letterSpacing = '0px'; c.font = jp(22, 700, false);
  c.fillText('サードインパクト  中央制御壁', X0 + 96 + tw + 18, 60);
  c.font = font(F.mono(500), 12); c.letterSpacing = '2.4px'; c.globalAlpha = 0.75;
  c.fillText('CONTROL WALL  //  ALL SYSTEMS  //  ANTI-A.T. FIELD EXPANDING  //  人類補完計画 発動', X0 + 96, 82);
  c.globalAlpha = 1; c.letterSpacing = '0px';
  // hazard block mid-header, stepping on the claps
  const hzX = 1010, hzW = 250;
  hazard(c, hzX, 44, hzW, 30, Math.floor(s.nHat) * 13 + t * 40, C('red', 0.9));
  c.strokeStyle = C('red'); c.lineWidth = 1.5; c.strokeRect(hzX, 44, hzW, 30);
  const rw = (X1 - X0) * reveal;
  c.fillRect(X0, 100, rw, 2);
  c.globalAlpha = 0.6;
  for (let x = X0; x <= X0 + rw; x += 24) c.fillRect(x, 102, 1, (x - X0) % 120 === 0 ? 8 : 4);
  c.globalAlpha = 1;
  const mm = Math.floor(t / 60), ss = t - mm * 60;
  const tc = `${pad2(mm)}:${ss.toFixed(2).padStart(5, '0')}`;
  const w7 = segWidth(tc, 30, 3.6);
  sevenSeg(c, tc, X1 - w7, 40, 30, col, C('orange', 0.08), { thick: 3.6 });
  const b = songBar(au, t), bi = Math.floor(b), beat = Math.floor((b - bi) * 4) + 1;
  c.font = font(F.mono(600), 12); c.letterSpacing = '2.4px'; c.textAlign = 'right';
  c.fillText(`BAR ${String(bi).padStart(3, '0')}  BEAT ${beat}  133.33 BPM`, X1 - w7 - 24, 58);
  c.font = jp(13, 600, false); c.letterSpacing = '0px';
  c.fillText('経過時間  小節  拍', X1 - w7 - 24, 80);
  for (let i = 0; i < 4; i++) { c.globalAlpha = i + 1 === beat ? 1 : 0.18; c.fillRect(X1 - w7 - 24 - 150 + i * 18, 86, 12, 5); }
  c.globalAlpha = 1; c.textAlign = 'left';
  // footer
  c.fillRect(X0, 1028, rw, 1);
  ticker(c, X0 + 250, 1054, X1 - X0 - 250, 'THIRD IMPACT // サードインパクト // ANTI-A.T. FIELD CRITICAL // 自我境界 崩壊 // EGO BORDER COLLAPSE // LCL CONVERSION // 生命の樹 // TREE OF LIFE // ALL SYSTEMS FAILING // 全システム停止 //', t, { speed: 110, color: C('orange', 0.65), size: 12 });
  c.fillStyle = col;
  chamferPath(c, X0, 1036, 230, 26, [0, 0, 10, 0]); c.fill();
  c.fillStyle = rgba('ink', 1); c.font = font(F.mono(700), 12); c.letterSpacing = '2px'; c.textBaseline = 'middle';
  c.fillText('NERV HQ  中央作戦室', X0 + 10, 1050);
  c.restore();
}

// ------------------------------------------------------------------ the title cell
export function drawTitle(c: CanvasRenderingContext2D, r: Rect, s: S, slam: number) {
  const { C } = s;
  const bone = s.red > 0.5 ? rgba('bone', 1) : rgba('bone', 1);
  c.save();
  // frame: brackets + inner rule
  c.strokeStyle = C('orange', 0.5); c.lineWidth = 1; c.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
  cornerTicks(c, r, C('orange'));
  const sc = 1 + 0.05 * slam;
  c.save();
  c.translate(r.x + 22, r.y + 138); c.scale(sc, sc);
  const tw = condensed(c, 'THIRD', 0, 0, 150, { sx: 0.56, color: bone, bold: 0.03 });
  condensed(c, 'IMPACT', tw + 22, 0, 150, { sx: 0.56, color: C('red'), bold: 0.03 });
  c.restore();
  // the rule, jp, project line
  c.fillStyle = C('orange'); c.fillRect(r.x + 24, r.y + 154, r.w - 250, 3);
  jt(c, 'サードインパクト', r.x + 24, r.y + 192, 30, bone, { serif: true, w: 800 });
  mono(c, 'HUMAN INSTRUMENTALITY PROJECT', r.x + 290, r.y + 180, 12, C('orange'));
  jt(c, '人類補完計画  最終段階', r.x + 290, r.y + 200, 14, C('orange', 0.85));
  // phase counter (the 2-bar phrases)
  const px = r.x + r.w - 206, py = r.y + 22;
  mono(c, 'PHASE', px, py + 10, 12, C('orange'));
  jt(c, '段階', px + 64, py + 11, 13, C('orange', 0.8));
  const w7 = sevenSeg(c, `0${s.phrase + 1}`, px, py + 22, 62, s.phrase === 4 ? C('red') : C('amber'), C('orange', 0.07), { thick: 7 });
  mono(c, '/05', px + w7 + 8, py + 82, 18, C('orange', 0.8), { w: 700 });
  mono(c, ['BAR 087', 'BAR 089', 'BAR 091', 'BAR 093', 'BAR 095'][s.phrase]!, px + w7 + 8, py + 44, 11, C('orange', 0.7));
  for (let i = 0; i < 5; i++) {
    c.fillStyle = i <= s.phrase ? (i === 4 ? C('red') : C('amber')) : C('orange', 0.12);
    c.fillRect(px + i * 36, py + 98, 30, 8);
  }
  // hazard foot on the right
  hazard(c, r.x + r.w - 206, r.y + 142, 184, 18, s.t * 60, C('red', 0.9));
  mono(c, 'SEQ 15 // CRITICAL', r.x + r.w - 206, r.y + 186, 11, C('red'));
  jt(c, '臨界', r.x + r.w - 206, r.y + 204, 14, C('red'));
  c.restore();
}

function cornerTicks(c: CanvasRenderingContext2D, r: Rect, col: string, len = 16) {
  c.strokeStyle = col; c.lineWidth = 2.5;
  c.beginPath();
  c.moveTo(r.x, r.y + len); c.lineTo(r.x, r.y); c.lineTo(r.x + len, r.y);
  c.moveTo(r.x + r.w - len, r.y); c.lineTo(r.x + r.w, r.y); c.lineTo(r.x + r.w, r.y + len);
  c.moveTo(r.x + r.w, r.y + r.h - len); c.lineTo(r.x + r.w, r.y + r.h); c.lineTo(r.x + r.w - len, r.y + r.h);
  c.moveTo(r.x + len, r.y + r.h); c.lineTo(r.x, r.y + r.h); c.lineTo(r.x, r.y + r.h - len);
  c.stroke();
}

// ------------------------------------------------------------------ instruments
export interface Instrument { id: string; title: string; jp: string; color: PaletteKey; draw: (c: CanvasRenderingContext2D, r: Rect, s: S) => void }

function grid(c: CanvasRenderingContext2D, r: Rect, nx: number, ny: number, col: string) {
  c.strokeStyle = col; c.lineWidth = 1; c.beginPath();
  for (let i = 0; i <= nx; i++) { const x = Math.round(r.x + (r.w * i) / nx) + 0.5; c.moveTo(x, r.y); c.lineTo(x, r.y + r.h); }
  for (let j = 0; j <= ny; j++) { const y = Math.round(r.y + (r.h * j) / ny) + 0.5; c.moveTo(r.x, y); c.lineTo(r.x + r.w, y); }
  c.stroke();
}

/** 1. PSYCHOGRAPH: three pilot channels: the real L / R waveform and the bass-stem envelope. */
const psycho: Instrument = {
  id: 'psycho', title: 'PSYCHOGRAPH', jp: '心理グラフ', color: 'green', draw(c, r, s) {
    const { au, t, C } = s;
    const lw = 74, gx = r.x + lw, gw = r.w - lw, ch = r.h / 3;
    const smp: [number, number] = [0, 0];
    for (let k = 0; k < 3; k++) {
      const y0 = r.y + k * ch, cy = y0 + ch / 2;
      grid(c, { x: gx, y: y0 + 2, w: gw, h: ch - 4 }, 12, 2, C('green', 0.1));
      mono(c, `PILOT 0${k + 1}`, r.x, cy - 2, 11, C('green'));
      mono(c, ['A10 L', 'A10 R', 'EGO'][k]!, r.x, cy + 13, 10, C('green', 0.6));
      c.strokeStyle = C('green'); c.lineWidth = 1.4; c.lineJoin = 'round'; c.beginPath();
      const N = 150;
      for (let i = 0; i <= N; i++) {
        let v: number;
        if (k < 2) { const win = k === 0 ? 0.05 : 0.12; au.waveAt(t - win + (win * i) / N, smp); v = smp[k]! * 0.95; }
        else { const ts = t - 2.4 + (2.4 * i) / N; v = (au.env('bass', ts) - 0.55) * 1.8 + au.hit('kick', ts, 0.05) * 0.5; }
        const x = gx + (gw * i) / N, y = cy - clamp(v, -1, 1) * (ch / 2 - 4);
        if (i) c.lineTo(x, y); else c.moveTo(x, y);
      }
      c.stroke();
    }
    // flatline flag: pilot 03's ego border
    if (s.red > 0.45 && ((s.t * 3) % 1) < 0.6) { mono(c, 'EGO BORDER LOST', r.x + r.w - 4, r.y + r.h - 4, 10, C('red'), { align: 'right', w: 700 }); }
  },
};

/** 2. HARMONICS: segmented mel spectrum with peak-hold ticks (the harmonics plate in miniature). */
const harmonics: Instrument = {
  id: 'harmonics', title: 'HARMONICS', jp: '調和解析', color: 'orange', draw(c, r, s) {
    const { au, t, C } = s;
    const n = 40, segs = 12, lab = 16, bh = r.h - lab, bw = r.w / n;
    const sh = bh / segs;
    for (let b = 0; b < n; b++) {
      const band = 1 + b * 1.5;
      const e = clamp(smoothstep(0.3, 1, au.mel(t, band)) * (0.9 + 0.2 * s.kd));
      let pk = e;
      for (let k = 1; k <= 5; k++) pk = Math.max(pk, smoothstep(0.3, 1, au.mel(t - k * 0.09, band)) * (1 - k * 0.04));
      const lit = e * segs;
      for (let q = 0; q < segs; q++) {
        const on = q < lit;
        c.fillStyle = on ? (q >= segs - 2 ? C('red') : q >= segs - 4 ? C('amber') : C('orange')) : C('orange', 0.08);
        c.fillRect(r.x + b * bw + 1, r.y + bh - (q + 1) * sh + 1, bw - 2, sh - 2);
      }
      c.fillStyle = C('bone', 0.9);
      c.fillRect(r.x + b * bw + 1, r.y + bh - pk * bh - 1, bw - 2, 2);
    }
    for (const b of [0, 13, 26, 39]) mono(c, `${melHz(1 + b * 1.5)}`, r.x + b * bw + bw / 2, r.y + r.h, 9.5, C('orange', 0.7), { align: 'center', w: 500 });
    mono(c, s.red > 0.6 ? 'HARMONICS: CRITICAL' : 'HARMONICS: UNSTABLE', r.x + r.w, r.y + 10, 10, s.red > 0.6 ? C('red') : C('amber'), { align: 'right', w: 700 });
  },
};

/** 3. ACTIVITY LIMIT: the battery countdown to the end of the plate. */
const battery: Instrument = {
  id: 'battery', title: 'ACTIVITY LIMIT', jp: '活動限界', color: 'orange', draw(c, r, s) {
    const { t, C } = s;
    const rem = Math.max(0, s.T1 - t), frac = rem / (s.T1 - s.T0);
    const crit = rem < 5.4;
    const on = !crit || ((t * 4) % 1) < 0.65;
    const txt = `${pad2(rem / 60)}:${pad2(rem % 60)}:${pad2((rem % 1) * 100)}`;
    const col = crit ? C('red', on ? 1 : 0.35) : C('amber');
    jt(c, '活動限界まで', r.x, r.y + 16, 16, crit ? C('red') : C('orange'));
    mono(c, 'INTERNAL BATTERY', r.x + 112, r.y + 14, 11, C('orange', 0.8));
    const h = Math.min(74, r.h * 0.44);
    sevenSeg(c, txt, r.x, r.y + 28, h, col, C('orange', 0.07), { thick: h * 0.12 });
    const my = r.y + 38 + h;
    mono(c, 'INT', r.x, my + 11, 11, C('orange'));
    segMeter(c, r.x + 38, my, r.w - 38, 13, 24, frac, { color: C('amber'), hot: C('red'), hotFrom: 2, dim: C('orange', 0.1) });
    mono(c, 'EXT', r.x, my + 34, 11, C('orange'));
    c.fillStyle = C('red', ((t * 2) % 1) < 0.6 ? 1 : 0.4); c.fillRect(r.x + 38, my + 23, 90, 13);
    mono(c, 'CUT', r.x + 83, my + 34, 11, rgba('ink', 1), { align: 'center', w: 700 });
    jt(c, '外部電源 切断', r.x + 140, my + 35, 13, C('red'));
    mono(c, `${(frac * 100).toFixed(1)}%`, r.x + r.w, my + 34, 12, C('amber'), { align: 'right', w: 700 });
  },
};

/** 4. TACTICAL: a mini radar, one sweep per bar; the Angel closing in as the plate runs out. */
const radar: Instrument = {
  id: 'radar', title: 'TACTICAL', jp: '戦術', color: 'orange', draw(c, r, s) {
    const { au, t, C } = s;
    const R = Math.min(r.h, r.w * 0.5) / 2 - 2, cx = r.x + R + 2, cy = r.y + r.h / 2;
    c.save();
    c.strokeStyle = C('orange', 0.28); c.lineWidth = 1;
    for (let k = 1; k <= 4; k++) { c.beginPath(); c.arc(cx, cy, (R * k) / 4 * (1 + 0.03 * s.kd * (k === 4 ? 1 : 0)), 0, TAU); c.stroke(); }
    c.beginPath(); c.moveTo(cx - R, cy); c.lineTo(cx + R, cy); c.moveTo(cx, cy - R); c.lineTo(cx, cy + R); c.stroke();
    c.strokeStyle = C('orange', 0.9); c.lineWidth = 1.5; c.beginPath(); c.arc(cx, cy, R, 0, TAU); c.stroke();
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * TAU, l = i % 6 === 0 ? 7 : 3;
      c.beginPath(); c.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); c.lineTo(cx + Math.cos(a) * (R - l), cy + Math.sin(a) * (R - l)); c.stroke();
    }
    // sweep: one turn per bar, with a fading wedge
    const b = songBar(au, t), sw = (b - Math.floor(b)) * TAU - Math.PI / 2;
    for (let k = 0; k < 14; k++) {
      c.fillStyle = C('amber', 0.16 * (1 - k / 14));
      c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, R, sw - (k + 1) * 0.06, sw - k * 0.06); c.closePath(); c.fill();
    }
    c.strokeStyle = C('amber'); c.lineWidth = 2; c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(sw) * R, cy + Math.sin(sw) * R); c.stroke();
    // contacts: UN forces, lit as the sweep passes, size from their spectrum band
    for (let i = 0; i < 11; i++) {
      const a = hash(i, 11) * TAU - Math.PI / 2, d = (0.3 + 0.62 * hash(i, 12)) * R;
      const since = (((sw - a) % TAU) + TAU) % TAU / TAU; // 0 just swept .. 1 about to be swept
      const lit = Math.exp(-since * 4);
      const e = smoothstep(0.3, 1, s.mel[4 + i * 5]!);
      c.fillStyle = C('orange', 0.25 + 0.75 * lit);
      const sz = 2.5 + 4 * e;
      c.fillRect(cx + Math.cos(a) * d - sz / 2, cy + Math.sin(a) * d - sz / 2, sz, sz);
    }
    // the Angel: cyan, closing in
    const prog = clamp((t - s.T0) / (s.T1 - s.T0));
    const aa = -0.6 + 0.3 * Math.sin(t * 0.7), ad = R * (0.85 - 0.8 * prog);
    const ax = cx + Math.cos(aa) * ad, ay = cy + Math.sin(aa) * ad;
    const vp = Math.exp(-(t - s.vT) / 0.2);
    c.strokeStyle = C('cyan'); c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(ax, ay - 7); c.lineTo(ax + 7, ay); c.lineTo(ax, ay + 7); c.lineTo(ax - 7, ay); c.closePath(); c.stroke();
    c.fillStyle = C('cyan', 0.5 + 0.5 * vp); c.fill();
    if (vp > 0.05) { c.strokeStyle = C('cyan', vp); c.beginPath(); c.arc(ax, ay, 10 + 20 * (1 - vp), 0, TAU); c.stroke(); }
    c.restore();
    // readouts
    const tx = r.x + 2 * R + 20;
    mono(c, 'ANGEL', tx, r.y + 14, 11, C('cyan'), { w: 700 });
    jt(c, '使徒接近', tx + 60, r.y + 15, 14, C('cyan'));
    mono(c, 'RANGE', tx, r.y + 40, 10, C('orange', 0.7));
    sevenSeg(c, (ad / R * 12).toFixed(1).padStart(4, '0'), tx, r.y + 48, 34, C('cyan'), C('cyan', 0.07), { thick: 4 });
    mono(c, 'KM', tx + 108, r.y + 80, 10, C('cyan', 0.8));
    mono(c, `BRG ${String(Math.round(((aa + Math.PI / 2) / TAU) * 360 + 360) % 360).padStart(3, '0')}`, tx, r.y + 106, 11, C('orange'));
    mono(c, `SWEEP ${String(Math.floor(b)).padStart(3, '0')}`, tx, r.y + 124, 11, C('orange'));
    mono(c, 'PATTERN BLUE', tx, r.y + r.h - 4, 11, C('cyan', 0.6 + 0.4 * vp), { w: 700 });
  },
};

/** 5. A.T. FIELD: hex cells rippling out from the core on every kick, claps shatter cells. */
const field: Instrument = {
  id: 'field', title: 'A.T. FIELD', jp: '位相空間', color: 'orange', draw(c, r, s) {
    const { t, C } = s;
    const hr = 10, dx = Math.sqrt(3) * hr, dy = 1.5 * hr;
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const age = t - s.kT, cage = t - s.cT;
    const ringR = age * 520, ringA = Math.exp(-age * 2.6);
    const P = [new Path2D(), new Path2D(), new Path2D(), new Path2D()]; // dim, mid, hot, shattered
    const cols = Math.floor(r.w / dx), rows = Math.floor(r.h / dy);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const x = r.x + dx / 2 + i * dx + (j % 2 ? dx / 2 : 0), y = r.y + hr + j * dy;
        if (x > r.x + r.w - dx / 2 || y > r.y + r.h - hr * 0.8) continue;
        const d = Math.hypot(x - cx, (y - cy) * 1.4);
        const h = hash(i, j, 5);
        let v = s.bass * 0.5 * (0.3 + 0.7 * h) * (1 - d / 340) + 0.18 * s.kd * (h > 0.5 ? 1 : 0);
        v += Math.exp(-Math.abs(d - ringR) / 18) * ringA * 1.3 + Math.exp(-Math.abs(d - ringR * 0.55) / 12) * ringA * 0.5;
        v += s.hat * (h > 0.93 ? 0.8 : 0);
        const shat = cage < 0.22 && hash(i, j, Math.round(s.cT * 100)) < 0.16;
        const k = shat ? 3 : v > 0.6 ? 2 : v > 0.2 ? 1 : 0;
        const p = P[k]!, rr = k === 0 ? hr - 3 : hr - 1.6;
        for (let q = 0; q < 6; q++) {
          const a = Math.PI / 6 + (q * Math.PI) / 3, px = x + rr * Math.cos(a), py = y + rr * Math.sin(a);
          if (q === 0) p.moveTo(px, py); else p.lineTo(px, py);
        }
        p.closePath();
      }
    }
    c.fillStyle = C('orange', 0.16); c.fill(P[0]!);
    c.fillStyle = C('orange', 0.55); c.fill(P[1]!);
    c.fillStyle = C('amber', 1); c.fill(P[2]!);
    c.fillStyle = rgba('red', 1); c.fill(P[3]!);
    // octagon of the field core + strength readout
    c.strokeStyle = C('amber'); c.lineWidth = 2;
    octPath(c, cx, cy, 30 + 6 * s.kd); c.stroke();
    c.fillStyle = 'rgba(5,4,3,0.85)'; c.fill();
    mono(c, `${Math.round(40 + 60 * s.bass)}`, cx, cy + 6, 16, C('bone'), { align: 'center', w: 700 });
    mono(c, 'FIELD STRENGTH', r.x, r.y + r.h - 2, 10, C('orange'), { w: 700 });
    mono(c, s.red > 0.5 ? 'ANTI-A.T. FIELD' : 'PHASE SPACE OPEN', r.x + r.w, r.y + r.h - 2, 10, s.red > 0.5 ? C('red') : C('orange'), { align: 'right', w: 700 });
  },
};

/** 6. ALERT: the EMERGENCY box, blinking on the claps; the word changes with the phrase. */
const WORDS: [string, string][] = [['EMERGENCY', '緊急事態'], ['WARNING', '警告'], ['DANGER', '危険'], ['IMPACT', '衝撃'], ['FAILURE', '停止']];
const alert: Instrument = {
  id: 'alert', title: 'ALERT', jp: '警報', color: 'red', draw(c, r, s) {
    const [w, j] = WORDS[Math.min(4, s.phrase)]!;
    warningBox(c, r.x, r.y, r.w, r.h, w, j, { blink: 0.3 + 0.7 * Math.max(s.snare, s.kd * 0.4), phase: s.t * 90 });
  },
};

/** 7. SYNCHRO: the sync ratio past 400 %, overflowing; a history graph underneath. */
const sync: Instrument = {
  id: 'sync', title: 'SYNCHRO', jp: '同調率', color: 'lime', draw(c, r, s) {
    const { t, C } = s;
    const p = clamp((t - s.T0) / (s.T1 - s.T0));
    const val = 400 + 599.9 * p * p;
    let txt = val.toFixed(1).padStart(5, '0');
    if (s.snare > 0.5) txt = txt.replace(/\d/g, (d, i: number) => (hash(s.fi, i) < 0.5 ? '8' : d));
    const lime = C('lime');
    jt(c, '同調率', r.x, r.y + 16, 16, lime);
    mono(c, 'SYNC RATIO  PILOT 01', r.x + 62, r.y + 14, 11, lime);
    const h = Math.min(62, r.h * 0.38);
    const w7 = sevenSeg(c, txt, r.x, r.y + 28, h, lime, C('lime', 0.07), { thick: h * 0.12 });
    condensed(c, '%', r.x + w7 + 8, r.y + 28 + h, h * 1.05, { sx: 0.7, color: lime });
    if (((t * 3) % 1) < 0.6) {
      chamferPath(c, r.x + r.w - 92, r.y + 30, 92, 22, [0, 7, 0, 7]); c.fillStyle = C('red'); c.fill();
      mono(c, 'OVERFLOW', r.x + r.w - 46, r.y + 45, 11, rgba('ink', 1), { align: 'center', w: 700 });
    }
    // history graph: the ratio + the vocal/other stem riding on it
    const gy = r.y + 40 + h, gh = r.y + r.h - gy;
    grid(c, { x: r.x, y: gy, w: r.w, h: gh }, 16, 3, C('lime', 0.1));
    c.strokeStyle = C('purple'); c.lineWidth = 1.2; c.beginPath();
    for (let i = 0; i <= 120; i++) {
      const ts = t - 3.6 + (3.6 * i) / 120, x = r.x + (r.w * i) / 120;
      const v = s.au.env('other', ts);
      const y = gy + gh - v * gh * 0.9;
      if (i) c.lineTo(x, y); else c.moveTo(x, y);
    }
    c.stroke();
    c.strokeStyle = lime; c.lineWidth = 2; c.beginPath();
    for (let i = 0; i <= 120; i++) {
      const ts = t - 3.6 + (3.6 * i) / 120, x = r.x + (r.w * i) / 120;
      const pp = clamp((ts - s.T0) / (s.T1 - s.T0));
      const y = gy + gh - clamp(0.25 + 0.7 * pp * pp + 0.05 * s.au.hit('kick', ts, 0.05)) * gh;
      if (i) c.lineTo(x, y); else c.moveTo(x, y);
    }
    c.stroke();
  },
};

/** 8. MAGI: three processors vote on each kick (in turn); claps reject; the end is unanimous 否決. */
const magi: Instrument = {
  id: 'magi', title: 'MAGI', jp: '三賢者', color: 'orange', draw(c, r, s) {
    const { t, C } = s;
    const names = ['MELCHIOR·1', 'BALTHASAR·2', 'CASPER·3'];
    // votes: kick k goes to unit k % 3; rejected if a clap is on it or once the wall has turned red
    const st: ({ ok: boolean; t: number } | null)[] = [null, null, null];
    let idx = 0;
    for (const [kt, , clap] of s.kicks) {
      if (kt > t) break;
      const late = kt > s.T1 - 5.4;
      st[idx % 3] = { ok: !clap && !late && hash(idx, 31) > s.red * 0.9, t: kt };
      idx++;
    }
    const bw = (r.w - 150) / 2 - 6, bh = (r.h - 12) / 2;
    const pos: [number, number][] = [[r.x + bw / 2 + 3, r.y], [r.x, r.y + bh + 12], [r.x + bw + 12, r.y + bh + 12]];
    const order = [1, 2, 0]; // BALTHASAR top, CASPER bottom-left, MELCHIOR bottom-right
    for (let k = 0; k < 3; k++) {
      const u = order[k]!, v = st[u], [x, y] = pos[k]!;
      const key: PaletteKey = v ? (v.ok ? 'green' : 'red') : 'orange';
      const fl = v ? Math.exp(-(t - v.t) / 0.12) : 0;
      chamferPath(c, x, y, bw, bh, k === 0 ? [4, 4, 16, 16] : k === 1 ? [4, 16, 4, 4] : [16, 4, 4, 4]);
      c.fillStyle = 'rgba(8,5,2,0.92)'; c.fill();
      if (v) { c.fillStyle = C(key, 0.14 + 0.7 * fl); c.fill(); }
      c.strokeStyle = C(key); c.lineWidth = 2; c.stroke();
      c.fillStyle = C(key); c.fillRect(x + 6, y + bh - 17, bw - 12, 13);
      mono(c, names[u]!, x + bw / 2, y + bh - 6, 9.5, rgba('ink', 1), { align: 'center', w: 700 });
      if (v) jt(c, v.ok ? '承認' : '否決', x + bw / 2, y + (bh - 17) / 2 + 2, Math.min(34, bh * 0.52), fl > 0.5 ? rgba('bone', 1) : C(key), { serif: true, w: 800, align: 'center', base: 'middle' });
    }
    const nNo = st.filter((v) => v && !v.ok).length, nOk = st.filter((v) => v?.ok).length;
    const rx = r.x + r.w - 136, ok = nOk >= 2, no = nNo >= 2;
    const key: PaletteKey = ok ? 'green' : no ? 'red' : 'orange';
    mono(c, 'RESOLUTION', rx, r.y + 12, 11, C('orange'));
    jt(c, '決議', rx + 96, r.y + 13, 13, C('orange', 0.8));
    chamferPath(c, rx, r.y + 22, 136, 70, [0, 0, 14, 0]);
    c.fillStyle = no && s.red > 0.7 ? C('red', 0.9) : 'rgba(0,0,0,0.6)'; c.fill();
    c.strokeStyle = C(key); c.lineWidth = 2; c.stroke();
    jt(c, ok ? '承認' : no ? '否決' : '審議中', rx + 68, r.y + 60, ok || no ? 40 : 28, no && s.red > 0.7 ? rgba('ink', 1) : C(key), { serif: true, w: 800, align: 'center', base: 'middle' });
    mono(c, `VOTE ${String(idx).padStart(3, '0')}`, rx, r.y + 112, 11, C('orange'));
    mono(c, `${nOk} APPROVE  ${nNo} REJECT`, rx, r.y + 130, 10, C('orange', 0.75));
    if (s.red > 0.7) mono(c, 'SELF-DESTRUCT', rx, r.y + r.h - 2, 11, C('red', ((t * 4) % 1) < 0.6 ? 1 : 0.3), { w: 700 });
  },
};

/** 9. PILOT VITALS: an ECG whose QRS complexes are the actual kick onsets; heart rate from them. */
const qrs = (dt: number) =>
  0.12 * Math.exp(-(((dt + 0.09) / 0.025) ** 2)) - 0.18 * Math.exp(-(((dt + 0.018) / 0.008) ** 2))
  + 1.0 * Math.exp(-((dt / 0.009) ** 2)) - 0.35 * Math.exp(-(((dt - 0.022) / 0.01) ** 2)) + 0.2 * Math.exp(-(((dt - 0.17) / 0.04) ** 2));
const ecg: Instrument = {
  id: 'ecg', title: 'PILOT VITALS', jp: '心電図', color: 'green', draw(c, r, s) {
    const { au, t, C } = s;
    const gw = r.w - 118, gh = r.h;
    grid(c, { x: r.x, y: r.y, w: gw, h: gh }, 16, 4, C('green', 0.1));
    const win = 2.4, kicks = au.events('kick', t - win - 0.4, t + 0.01);
    const mid = r.y + gh * 0.62, amp = gh * 0.55, N = 260;
    c.beginPath();
    let hx = 0, hy = 0;
    const smp: [number, number] = [0, 0];
    for (let i = 0; i <= N; i++) {
      const ts = t - win * (1 - i / N);
      let v = 0;
      for (const [kt, st] of kicks) { const dt = ts - kt; if (dt > -0.15 && dt < 0.3) v += qrs(dt) * Math.min(1, st * 1.1); }
      v += au.waveAt(ts, smp)[0] * 0.05;
      const x = r.x + (gw * i) / N, y = mid - v * amp;
      if (i) c.lineTo(x, y); else c.moveTo(x, y);
      hx = x; hy = y;
    }
    c.strokeStyle = C('green'); c.lineWidth = 1.8; c.lineJoin = 'round'; c.stroke();
    c.fillStyle = rgba('bone', 1); c.beginPath(); c.arc(hx, hy, 3, 0, TAU); c.fill();
    const strong = kicks.filter(([, v]) => v > 0.6);
    const hr = strong.length >= 2 ? 60 / (strong[strong.length - 1]![0] - strong[strong.length - 2]![0]) : 100;
    const rx = r.x + gw + 14;
    mono(c, 'HR', rx, r.y + 12, 11, C('green'));
    jt(c, '心拍数', rx + 30, r.y + 13, 13, C('green', 0.8));
    sevenSeg(c, String(Math.round(Math.min(hr, 299))).padStart(3, ' '), rx, r.y + 24, 40, C('green'), C('green', 0.07), { thick: 5 });
    mono(c, 'BPM', rx, r.y + 86, 10, C('green', 0.7));
    c.fillStyle = C('red', Math.exp(-(t - s.kT) / 0.08)); c.beginPath(); c.arc(rx + 90, r.y + 8, 5, 0, TAU); c.fill();
    mono(c, 'SpO2', rx, r.y + 112, 10, C('green', 0.7));
    mono(c, `${Math.round(97 - 60 * s.red)}%`, rx + 96, r.y + 112, 12, s.red > 0.5 ? C('red') : C('green'), { align: 'right', w: 700 });
    mono(c, 'LCL', rx, r.y + 132, 10, C('green', 0.7));
    mono(c, `${(0.2 + 0.8 * s.red).toFixed(2)}`, rx + 96, r.y + 132, 12, C('amber'), { align: 'right', w: 700 });
  },
};

/** 10. TARGET: cyan reticle, the Angel drifting with the bass, brackets snapping on the kicks. */
const target: Instrument = {
  id: 'target', title: 'TARGET', jp: '目標', color: 'cyan', draw(c, r, s) {
    const { t, C } = s;
    const R = r.h / 2 - 4, cx = r.x + r.w * 0.36, cy = r.y + r.h / 2;
    const cyan = C('cyan');
    c.strokeStyle = C('cyan', 0.3); c.lineWidth = 1;
    for (const k of [0.33, 0.66]) { c.beginPath(); c.arc(cx, cy, R * k, 0, TAU); c.stroke(); }
    c.strokeStyle = C('cyan', 0.9); c.lineWidth = 1.6; c.beginPath(); c.arc(cx, cy, R, 0, TAU); c.stroke();
    c.beginPath();
    c.moveTo(cx - R - 14, cy); c.lineTo(cx - 12, cy); c.moveTo(cx + 12, cy); c.lineTo(cx + R + 14, cy);
    c.moveTo(cx, cy - R - 6); c.lineTo(cx, cy - 12); c.moveTo(cx, cy + 12); c.lineTo(cx, cy + R + 6);
    c.stroke();
    for (let i = -8; i <= 8; i++) { if (!i) continue; const l = i % 4 === 0 ? 7 : 3.5; c.beginPath(); c.moveTo(cx + i * R / 8, cy - l); c.lineTo(cx + i * R / 8, cy + l); c.stroke(); }
    // the angel: drifts with the bass
    const ax = cx + noise1(t * 0.8, 2) * R * 0.5 + Math.sin(t * 2.1) * 10 * s.bass;
    const ay = cy + noise1(t * 0.6, 9) * R * 0.4;
    const vp = Math.exp(-(t - s.vT) / 0.25);
    const sz = 16 + 5 * s.kd;
    c.strokeStyle = cyan; c.lineWidth = 1.6;
    c.beginPath(); c.moveTo(ax, ay - sz); c.lineTo(ax + sz * 0.7, ay); c.lineTo(ax, ay + sz); c.lineTo(ax - sz * 0.7, ay); c.closePath();
    c.moveTo(ax - sz * 0.7, ay); c.lineTo(ax + sz * 0.7, ay); c.moveTo(ax, ay - sz); c.lineTo(ax, ay + sz);
    c.stroke();
    c.fillStyle = C('cyan', 0.18 + 0.5 * vp); c.beginPath(); c.moveTo(ax, ay - sz); c.lineTo(ax + sz * 0.7, ay); c.lineTo(ax, ay + sz); c.lineTo(ax - sz * 0.7, ay); c.closePath(); c.fill();
    // lock brackets: snap in on the kick
    const bs = 26 + 22 * (1 - Math.exp(-(t - s.kT) / 0.1)) * 0 + 34 * Math.exp(-(t - s.kT) / 0.12);
    const bc = s.red > 0.6 ? C('red') : C('amber');
    c.strokeStyle = bc; c.lineWidth = 2;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const x = ax + sx * bs, y = ay + sy * bs;
      c.beginPath(); c.moveTo(x, y - sy * 9); c.lineTo(x, y); c.lineTo(x - sx * 9, y); c.stroke();
    }
    const tx = r.x + r.w * 0.36 + R + 30;
    mono(c, 'BLOOD TYPE', tx, r.y + 14, 11, cyan);
    condensed(c, 'BLUE', tx, r.y + 58, 50, { sx: 0.62, color: cyan });
    jt(c, 'パターン青', tx + 76, r.y + 52, 15, cyan);
    mono(c, `AZ  ${(180 + (ax - cx) * 0.3).toFixed(2)}`, tx, r.y + 88, 11, C('orange'));
    mono(c, `EL  ${(12 + (cy - ay) * 0.2).toFixed(2)}`, tx, r.y + 106, 11, C('orange'));
    mono(c, s.red > 0.6 ? 'LOCK LOST' : 'TRACKING', tx, r.y + 130, 11, s.red > 0.6 ? C('red') : C('amber'), { w: 700 });
    if (vp > 0.05) mono(c, '使徒 ANGEL', ax, ay - sz - 8, 10, C('cyan', vp), { align: 'center', w: 700 });
  },
};

/** 11. SEELE: twelve SOUND ONLY monoliths, each a chroma bin of the harmonic stem. */
const seele: Instrument = {
  id: 'seele', title: 'SEELE', jp: 'ゼーレ', color: 'red', draw(c, r, s) {
    const { C } = s;
    const n = 12, g = 6, mw = (r.w - g * (n - 1)) / n, mh = r.h - 22;
    let top = 0; for (let k = 1; k < n; k++) if (s.chroma[k]! > s.chroma[top]!) top = k;
    for (let k = 0; k < n; k++) {
      const x = r.x + k * (mw + g), e = smoothstep(0.2, 1, s.chroma[k]!);
      const hot = k === top;
      c.fillStyle = 'rgba(2,1,1,0.95)'; c.fillRect(x, r.y, mw, mh);
      c.strokeStyle = rgba('red', 0.25 + 0.75 * e); c.lineWidth = hot ? 2 : 1; c.strokeRect(x + 0.5, r.y + 0.5, mw - 1, mh - 1);
      if (hot) { c.fillStyle = rgba('red', 0.12 + 0.2 * s.bass); c.fillRect(x, r.y, mw, mh); }
      mono(c, String(k + 1).padStart(2, '0'), x + mw / 2, r.y + 24, Math.min(15, mw * 0.5), rgba('red', 0.35 + 0.65 * e), { align: 'center', w: 700, track: 0 });
      c.save(); c.translate(x + mw / 2 + 4, r.y + 38); c.rotate(Math.PI / 2);
      mono(c, 'SOUND ONLY', 0, 0, 9, rgba('red', 0.25 + 0.7 * e), { w: 700, track: 1.5 });
      c.restore();
      c.fillStyle = rgba('red', 0.2 + 0.8 * e); c.fillRect(x + 3, r.y + mh - 6 - e * 26, mw - 6, e * 26);
    }
    mono(c, 'C  C#  D  D#  E  F  F#  G  G#  A  A#  B', r.x, r.y + r.h, 9.5, C('red', 0.7), { w: 500, track: 0.8 });
    mono(c, `VOICE ${String(top + 1).padStart(2, '0')}`, r.x + r.w, r.y + r.h, 10, rgba('red', 1), { align: 'right', w: 700 });
  },
};

/** 12. SYSTEM LOG: rows scroll on the hats and kicks; errors multiply as the wall turns red. */
const MSG = ['ANTI-AT FIELD', 'EGO BORDER', 'LCL CONVERT', 'SEED OF LIFE', 'LILITH SYNC', 'LANCE/LONGINUS', 'S2 ENGINE', 'DIRAC SEA', 'TREE OF LIFE', 'SEPHIROTH', 'GEOFRONT', 'CENTRAL DOGMA', 'TERMINAL DOGMA', 'MAGI LINK'];
const log: Instrument = {
  id: 'log', title: 'SYSTEM LOG', jp: '処理記録', color: 'orange', draw(c, r, s) {
    const { C } = s;
    const step = s.nHat + s.nKick, lead = 16.5, N = Math.floor(r.h / lead);
    c.font = font(F.mono(500), 12);
    for (let i = 0; i < N; i++) {
      const k = step - (N - 1 - i);
      const err = hash(k, 7) < 0.12 + 0.6 * s.red;
      const m = MSG[Math.floor(hash(k, 3) * MSG.length)]!;
      const state = err ? (hash(k, 9) < 0.5 ? 'CRIT' : 'LOST') : 'OK';
      const y = r.y + 12 + i * lead;
      const newest = i === N - 1;
      if (newest && err) { c.fillStyle = C('red', 0.85); c.fillRect(r.x - 2, y - 12, r.w + 4, 15); }
      mono(c, `${hexData(k, 1, 4)} ${m.padEnd(15)}${state}`, r.x, y, 12, newest && err ? rgba('ink', 1) : err ? C('red') : C('orange', 0.35 + 0.6 * (i / N)), { w: 500, track: 0.6 });
    }
  },
};

/** 13. TOKYO-3: the city skyline, towers breathing with the mel bands, a scan line per bar. */
const city: Instrument = {
  id: 'city', title: 'TOKYO-3', jp: '第3新東京市', color: 'orange', draw(c, r, s) {
    const { au, t, C } = s;
    const n = 34, gy = r.y + r.h - 14;
    c.fillStyle = C('orange', 0.9); c.fillRect(r.x, gy, r.w, 1.5);
    let x = r.x;
    const sx = r.x + ((songBar(au, t) % 1 + 1) % 1) * r.w;
    for (let i = 0; i < n && x < r.x + r.w; i++) {
      const w = 8 + hash(i, 1) * 10, e = smoothstep(0.25, 1, s.mel[3 + i]!);
      const h = (r.h - 30) * (0.12 + 0.3 * hash(i, 2) + 0.55 * e);
      const near = Math.abs(x + w / 2 - sx) < 22;
      c.fillStyle = 'rgba(12,7,3,0.95)'; c.fillRect(x, gy - h, w - 2, h);
      c.strokeStyle = C(near ? 'amber' : 'orange', near ? 1 : 0.7); c.lineWidth = 1; c.strokeRect(x + 0.5, gy - h + 0.5, w - 3, h - 1);
      c.fillStyle = C('amber', 0.5);
      for (let wy = gy - h + 5; wy < gy - 4; wy += 6) if (hash(i, Math.round(wy), s.nHat % 7) < 0.3 + 0.4 * e) c.fillRect(x + 3, wy, 2, 2);
      x += w;
    }
    c.fillStyle = C('amber', 0.8); c.fillRect(sx, r.y, 1.5, gy - r.y);
    mono(c, 'DISTRICT 03  //  ARMOR PLATE: RETRACTED', r.x, r.y + r.h, 9.5, C('orange', 0.8), { w: 500 });
    mono(c, s.red > 0.5 ? 'EVACUATE' : 'SHELTER', r.x + r.w, r.y + 10, 10, s.red > 0.5 ? C('red') : C('amber'), { align: 'right', w: 700 });
  },
};

/** 14. INSTRUMENTALITY: the stages of the project, each filled by the kicks (5 per stage). */
const STAGES: [string, string][] = [['LANCE OF LONGINUS', 'ロンギヌスの槍'], ['ANTI-A.T. FIELD', '反A.T.フィールド'], ['EGO BORDER', '自我境界'], ['LCL CONVERSION', 'LCL化'], ['TREE OF LIFE', '生命の樹'], ['COMPLEMENTATION', '補完']];
const project: Instrument = {
  id: 'project', title: 'INSTRUMENTALITY', jp: '人類補完計画', color: 'red', draw(c, r, s) {
    const { C } = s;
    const lead = r.h / STAGES.length;
    const per = 4.8; // kicks per stage
    STAGES.forEach(([en, j], i) => {
      const y = r.y + i * lead;
      const p = clamp((s.nKick + 1 - s.kd * 0.9 - i * per) / per);
      const done = p >= 1, act = p > 0 && !done;
      mono(c, en, r.x, y + 13, 11, done ? C('red') : act ? C('amber') : C('orange', 0.45), { w: 700, track: 1.2 });
      jt(c, j, r.x + 176, y + 14, 12, done ? C('red', 0.9) : C('orange', act ? 0.9 : 0.4));
      segMeter(c, r.x + 270, y + 4, r.w - 340, 11, 16, p, { color: done ? C('red') : C('amber'), hot: C('red'), hotFrom: 2, dim: C('orange', 0.1), gap: 2 });
      const tag = done ? '完了' : act ? '進行' : '待機';
      c.fillStyle = done ? C('red') : act ? C('amber', ((s.t * 4) % 1) < 0.6 ? 1 : 0.4) : C('orange', 0.15);
      c.fillRect(r.x + r.w - 58, y + 1, 58, 17);
      jt(c, tag, r.x + r.w - 29, y + 15, 13, rgba('ink', 1), { align: 'center' });
    });
  },
};

export const INSTRUMENTS: Instrument[] = [psycho, harmonics, battery, radar, field, alert, sync, magi, ecg, target, seele, log, city, project];
