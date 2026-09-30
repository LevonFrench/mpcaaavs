// Ported from bizarro/evangelion app/src/scenes/seele-kit.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// Helpers for the seele plate ("SOUND ONLY"): the council layout and camera (shared by the GL
// ray tracer and the Canvas2D callouts, so leader lines land on the monoliths), the monolith face
// atlas, the speaker track (bass pitch class → member) and the smoothed chroma per member.
import * as THREE from 'three';
import { createCanvas } from '../../show/canvas.ts';
import type { AudioData } from '../../show/audio.ts';
import { W, H } from '../../show/gl.ts';
import { F, font } from '../../show/type.ts';
import { clamp, smoothstep, TAU } from '../../show/util.ts';
import { jp } from './_eva.ts';

export const PC = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const PC_ASCII = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// ---------------------------------------------------------------- the council (world units, y up)
/** Monolith half extents: width, height, depth. */
export const MONO = { hw: 0.56, hh: 1.66, hd: 0.14 };
/** Ring of 12 around CENTER; member k (pitch class k) sits at clock angle k·30° + OFF (0 = far side, + = right). */
export const RING = { cx: 0, cz: 14, r: 6.4, off: TAU / 24 };
export const FLOOR_Y = -3.35;
/** Camera: height, distance from the ring centre, vertical half-FOV tangent. */
export const CAM = { h: 7.4, dist: 21, tanY: 0.335 };

export type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Clock angle of member k. */
export const memberAngle = (k: number) => k * (TAU / 12) + RING.off;

/** Member k's base position (before the float bob): on the ring, heights staggered. */
export function memberBase(k: number): V3 {
  const a = memberAngle(k);
  // tiered: the far side of the ring floats higher (the council looms over the accused)
  const y = 1.1 * Math.cos(a) + 0.3 * Math.sin(k * 2.39 + 0.7) + 0.15 * Math.cos(k * 1.13);
  return [RING.cx + RING.r * Math.sin(a), y, RING.cz + RING.r * Math.cos(a)];
}

/** Member k at time t: slow independent float (a few cm, periods of 7–11 s). */
export function memberPos(k: number, t: number): V3 {
  const b = memberBase(k);
  return [b[0], b[1] + 0.09 * Math.sin(t * (0.55 + 0.07 * k) + k * 1.7), b[2]];
}

/** Every face is turned toward the accused (the camera's home point, the ring's open south). */
export function memberYaw(k: number) {
  const p = memberBase(k);
  const home: V3 = [0, 0, RING.cz - CAM.dist];
  return Math.atan2(home[0] - p[0], home[2] - p[2]);
}

export interface Cam { pos: V3; right: V3; up: V3; fwd: V3; tanX: number; tanY: number }

export function makeCam(pos: V3, target: V3, tanY = CAM.tanY): Cam {
  const fwd = norm(sub(target, pos));
  const right = norm(cross([0, 1, 0], fwd));
  const up = cross(fwd, right);
  return { pos, right, up, fwd, tanX: tanY * (W / H), tanY };
}

/** World → logical screen px (y down) and view depth; depth <= 0 behind the camera. */
export function project(cam: Cam, p: V3): [number, number, number] {
  const d = sub(p, cam.pos);
  const z = dot(d, cam.fwd);
  const x = dot(d, cam.right) / (z * cam.tanX), y = dot(d, cam.up) / (z * cam.tanY);
  return [W / 2 * (1 + x), H / 2 * (1 - y), z];
}

/** The four face corners of member k at time t (screen px), TL TR BR BL. */
export function faceCorners(cam: Cam, k: number, t: number): [number, number][] {
  const p = memberPos(k, t), yaw = memberYaw(k);
  const r: V3 = [Math.cos(yaw), 0, -Math.sin(yaw)], f: V3 = [Math.sin(yaw), 0, Math.cos(yaw)];
  const c = (sx: number, sy: number): [number, number] => {
    const q: V3 = [p[0] + r[0] * sx * MONO.hw + f[0] * MONO.hd, p[1] + sy * MONO.hh, p[2] + r[2] * sx * MONO.hw + f[2] * MONO.hd];
    const s = project(cam, q);
    return [s[0], s[1]];
  };
  // local +x (r) points to the viewer's left when the face looks at the camera
  return [c(1, 1), c(-1, 1), c(-1, -1), c(1, -1)];
}

// ---------------------------------------------------------------- face atlas
export const ATLAS = { cols: 6, rows: 2, cw: 384, ch: 1178 };

/**
 * The monolith faces: R = the member's live text (number + SOUND ONLY), G = dim furniture (rules,
 * ticks, small captions), B = the voice meter's frame. Drawn once; the shader colours them.
 */
export function makeFaceAtlas(): THREE.Texture {
  const { cols, rows, cw, ch } = ATLAS;
  const cv = createCanvas();
  cv.width = cols * cw; cv.height = rows * ch;
  const c = cv.getContext('2d')!;
  c.fillStyle = '#000'; c.fillRect(0, 0, cv.width, cv.height);
  c.globalCompositeOperation = 'lighter';
  const R = '#ff0000', G = '#00ff00', B = '#0000ff';
  for (let k = 0; k < 12; k++) {
    const x0 = (k % cols) * cw, y0 = Math.floor(k / cols) * ch;
    c.save();
    c.translate(x0, y0);
    c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    const cx = cw / 2;
    // furniture: top rule + tick row, corner marks, bottom caption
    c.fillStyle = G;
    c.fillRect(34, 92, cw - 68, 4);
    for (let i = 0; i <= 16; i++) c.fillRect(34 + ((cw - 68) * i) / 16 - 1, 100, 3, i % 4 ? 8 : 16);
    c.font = font(F.mono(600), 24); c.letterSpacing = '7px';
    c.fillText('MEMBER', cx + 3, 72);
    c.letterSpacing = '0px';
    // the number: huge heavy condensed sans (the monolith voice)
    c.fillStyle = R;
    c.font = font(F.archivo(62, 900), 330);
    c.fillText(String(k + 1).padStart(2, '0'), cx, 470);
    // SOUND ONLY, fitted to the face
    c.font = font(F.archivo(75, 900), 84);
    const sw = c.measureText('SOUND').width;
    const s = Math.min(1, (cw - 64) / sw);
    c.save(); c.translate(cx, 600); c.scale(s, 1); c.fillText('SOUND', 0, 0); c.restore();
    c.save(); c.translate(cx, 688); c.scale(s, 1); c.fillText('ONLY', 0, 0); c.restore();
    c.fillStyle = G;
    c.font = jp(40, 700, false);
    c.fillText('音声のみ', cx, 760);
    // voice meter frame (the meter itself is drawn by the shader in uv 0.14..0.22)
    c.fillStyle = B;
    const my0 = ch * (1 - 0.232), my1 = ch * (1 - 0.128);
    c.fillRect(30, my0, cw - 60, 3); c.fillRect(30, my1, cw - 60, 3);
    c.fillRect(30, my0, 3, my1 - my0); c.fillRect(cw - 33, my0, 3, my1 - my0);
    c.fillStyle = G;
    c.font = font(F.mono(600), 26); c.letterSpacing = '4px';
    c.fillText(`PC-${String(k).padStart(2, '0')}  ${PC_ASCII[k]}`, cx + 2, ch - 64);
    c.letterSpacing = '0px';
    c.fillRect(34, ch - 44, cw - 68, 3);
    c.restore();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------- audio → council
export interface Turn { t0: number; t1: number; pc: number }

/** The speaker track: bass pitch class over [t0, t1], changes accepted after 80 ms of stability. */
export function speakerTurns(au: AudioData, t0: number, t1: number): Turn[] {
  const dt = 0.01, hold = 0.08;
  const turns: Turn[] = [];
  let cur = -1, cand = -1, candT = t0;
  for (let t = t0; t <= t1; t += dt) {
    const m = au.bassMidi(t);
    const pc = m > 0 ? ((Math.round(m) % 12) + 12) % 12 : -1;
    if (pc === cur) { cand = -1; continue; }
    if (pc !== cand) { cand = pc; candT = t; continue; }
    if (t - candT >= hold) {
      if (turns.length) turns[turns.length - 1]!.t1 = candT;
      if (pc >= 0) turns.push({ t0: candT, t1: Infinity, pc });
      cur = pc; cand = -1;
    }
  }
  return turns;
}

/** The turn active at t (or null). */
export function turnAt(turns: Turn[], t: number): Turn | null {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i]!.t0 <= t) return t < turns[i]!.t1 ? turns[i]! : null;
  return null;
}

/** 0..1 "speaking" weight of every member at t: 150 ms attack, 350 ms release. */
export function speakWeights(turns: Turn[], t: number, out: number[]) {
  out.fill(0);
  for (const tr of turns) {
    if (tr.t0 > t) break;
    const w = smoothstep(0, 0.15, t - tr.t0) * (1 - smoothstep(0, 0.35, t - tr.t1));
    out[tr.pc] = Math.max(out[tr.pc]!, w);
  }
  return out;
}

const chTmp = new Float32Array(12);
/** Chroma of the harmonic stem, averaged over the last ~0.3 s (linear-weighted), per member. */
export function smoothChroma(au: AudioData, t: number, out: number[]) {
  out.fill(0);
  let wsum = 0;
  for (let i = 0; i < 8; i++) {
    const w = 8 - i;
    au.chroma(t - i * 0.04, chTmp);
    for (let k = 0; k < 12; k++) out[k]! += chTmp[k]! * w;
    wsum += w;
  }
  for (let k = 0; k < 12; k++) out[k] = clamp(out[k]! / wsum);
  return out;
}

/** Bass MIDI → "F1 43.65 HZ". */
export function noteLabel(m: number) {
  if (m <= 0) return '—';
  const n = Math.round(m), hz = 440 * Math.pow(2, (m - 69) / 12);
  return `${PC_ASCII[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}  ${hz.toFixed(2)} HZ`;
}

// ---------------------------------------------------------------- the minutes
/** Council lines (JP + EN), assigned in order to the turns / bars of the session. */
export const MINUTES: [string, string][] = [
  ['予定外の使徒侵攻だな。', 'AN UNSCHEDULED ANGEL INCURSION.'],
  ['計画の遅延は認められん。', 'NO DELAY TO THE PLAN WILL BE PERMITTED.'],
  ['死海文書の記述どおりだ。', 'AS WRITTEN IN THE DEAD SEA SCROLLS.'],
  ['時計の針は元には戻らない。', 'THE HANDS OF THE CLOCK DO NOT TURN BACK.'],
  ['約束の時が近づいている。', 'THE PROMISED TIME DRAWS NEAR.'],
  ['全ては我らのシナリオ通りに。', 'ALL ACCORDING TO OUR SCENARIO.'],
  ['人類補完計画。唯一の希望だ。', 'INSTRUMENTALITY. OUR ONLY HOPE.'],
];

/** Canvas2D: draw text vertically (one glyph per line), centred on x. */
export function vtext(c: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, serif = true) {
  c.save();
  c.font = jp(size, 700, serif); c.fillStyle = color; c.textAlign = 'center'; c.textBaseline = 'top';
  [...s].forEach((ch, i) => c.fillText(ch, x, y + i * size * 1.08));
  c.restore();
}

/** Segmented level meter (horizontal) that respects the context's globalAlpha (the kit's resets it). */
export function meterH(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, n: number, v: number, col: string, dim: string, hot?: string, hotFrom = 0.86) {
  const g = 2, bw = (w - g * (n - 1)) / n, lit = v * n;
  for (let i = 0; i < n; i++) {
    const on = i < Math.floor(lit) ? 1 : i < lit ? lit - i : 0;
    c.fillStyle = on > 0 ? (hot && i / n >= hotFrom ? hot : col) : dim;
    c.fillRect(x + i * (bw + g), y, bw, h);
  }
}
