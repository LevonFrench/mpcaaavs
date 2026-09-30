// Ported from bizarro/evangelion app/src/scenes/plug-kit.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// Helpers for the plug plate: the deterministic insertion drive (camera depth integrated once from the
// audio at init, looked up by song time), the startup sequence list, an ECG trace driven by the
// kicks, and the plug / socket cross-section schematic.
import * as THREE from 'three';
import type { AudioData } from '../../show/audio.ts';
import { rgba } from '../../show/palette.ts';
import { F, font } from '../../show/type.ts';
import { clamp } from '../../show/util.ts';
import { jp } from './_eva.ts';
import { lastIdx } from './atfield-kit.ts';

/**
 * Camera depth z(t) = ∫ speed. The speed is a pure function of song time (audio envelopes, onsets),
 * integrated once at init on a fine fixed grid, so every sub-frame of every render gets the same z
 * for the same t regardless of the order frames are rendered in.
 */
export class Drive {
  z: Float32Array;
  constructor(public t0: number, public t1: number, public dt: number, speed: (t: number) => number) {
    const n = Math.ceil((t1 - t0) / dt) + 1;
    this.z = new Float32Array(n);
    let z = 0, vPrev = speed(t0);
    for (let i = 1; i < n; i++) {
      const v = speed(t0 + i * dt);
      z += 0.5 * (v + vPrev) * dt;
      this.z[i] = z;
      vPrev = v;
    }
  }
  at(t: number) {
    const x = clamp((t - this.t0) / this.dt, 0, this.z.length - 1.0001);
    const i = Math.floor(x), f = x - i;
    return this.z[i]! * (1 - f) + this.z[i + 1]! * f;
  }
  /** Speed by finite difference of the table (for readouts). */
  vel(t: number) { return (this.at(t + 0.004) - this.at(t - 0.004)) / 0.008; }
  /** Inverse table z → t as a float texture (n texels spanning the whole z range). */
  inverseTexture(n = 4096) {
    const z0 = this.z[0]!, z1 = this.z[this.z.length - 1]!;
    const data = new Float32Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const zi = z0 + ((z1 - z0) * i) / (n - 1);
      while (j < this.z.length - 2 && this.z[j + 1]! < zi) j++;
      const a = this.z[j]!, b = this.z[j + 1]!;
      data[i] = this.t0 + (j + clamp((zi - a) / Math.max(b - a, 1e-9))) * this.dt;
    }
    const tex = new THREE.DataTexture(data, n, 1, THREE.RedFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return { tex, info: new THREE.Vector3(z0, (n - 1) / Math.max(z1 - z0, 1e-6), n) };
  }
}

/** The startup sequence (the anime's activation call-outs). `ok` = the value shown when done. */
export const STAGES: { en: string; jp: string; ok: string; col?: 'amber' | 'green' }[] = [
  { en: 'MAIN POWER', jp: '主電源接続', ok: 'CONNECTED' },
  { en: 'PLUG INSERTION', jp: 'エントリープラグ挿入', ok: 'COMPLETE' },
  { en: 'LCL FLOODING', jp: 'LCL注水', ok: '100%' },
  { en: 'PLUG LOCK', jp: 'プラグ固定', ok: 'LOCKED' },
  { en: 'ALL CIRCUITS', jp: '全回路動力伝達', ok: 'POWERED' },
  { en: 'LCL ELECTROLYSIS', jp: 'LCL電化', ok: 'CLEAR' },
  { en: 'PRIMARY CONTACT', jp: '第1次接続開始', ok: 'OPEN' },
  { en: 'A10 NERVE LINK', jp: 'A10神経接続', ok: '異常なし' },
  { en: 'INITIAL CONTACT', jp: '初期コンタクト', ok: '問題なし' },
  { en: 'BIDIRECTIONAL', jp: '双方向回線', ok: '開放' },
  { en: 'THOUGHT LANGUAGE', jp: '思考言語', ok: '日本語' },
  { en: 'PULSE', jp: 'パルス', ok: '正常' },
  { en: 'HARMONICS', jp: 'ハーモニクス', ok: '全て正常' },
  { en: 'SYNC RATIO', jp: 'シンクロ率', ok: '41.3%', col: 'amber' },
  { en: 'BERSERK', jp: '暴走', ok: 'なし' },
];

/**
 * ECG-style pulse trace: every kick in the list draws a P-QRS-T complex scaled by its strength,
 * riding on the real waveform as baseline noise. `span` seconds of history, newest at the right.
 */
export function ecgTrace(c: CanvasRenderingContext2D, au: AudioData, kicks: [number, number][], t: number, x: number, y: number, w: number, h: number, o: { span?: number; col?: string; n?: number; gain?: number } = {}) {
  const span = o.span ?? 2.4, n = o.n ?? 300, g = o.gain ?? 1;
  const s: [number, number] = [0, 0];
  const shape = (dt: number) =>
    0.12 * Math.exp(-(((dt + 0.07) / 0.025) ** 2)) +
    1.0 * Math.exp(-(((dt - 0.006) / 0.007) ** 2)) -
    0.38 * Math.exp(-(((dt - 0.026) / 0.009) ** 2)) +
    0.2 * Math.exp(-(((dt - 0.15) / 0.04) ** 2));
  c.save();
  c.strokeStyle = o.col ?? rgba('green', 1); c.lineWidth = 1.8; c.lineJoin = 'round';
  c.beginPath();
  for (let i = 0; i <= n; i++) {
    const ti = t - span + (span * i) / n;
    let v = 0;
    const k0 = lastIdx(kicks, ti + 0.1);
    for (let k = k0; k >= 0 && k > k0 - 3; k--) { const [kt, ks] = kicks[k]!; v += ks * shape(ti - kt); }
    au.waveAt(ti, s);
    v += 0.05 * (s[0] + s[1]);
    const px = x + (w * i) / n, py = y + h * 0.62 - clamp(v * g, -0.6, 1.1) * h * 0.55;
    if (i) c.lineTo(px, py); else c.moveTo(px, py);
  }
  c.stroke();
  // write head
  c.fillStyle = o.col ?? rgba('green', 1);
  c.fillRect(x + w - 3, y, 3, h);
  c.restore();
}

/**
 * Cross-section of the Eva's spine socket with the entry plug sliding in: `ins` 0..1 insertion,
 * `lock` 0..1 closes the armour clamps. A tick scale (metres) runs down the left.
 */
export function plugSchematic(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, ins: number, lock: number, o: { depth?: number; col?: string; hot?: string } = {}) {
  const col = o.col ?? rgba('orange', 1), hot = o.hot ?? rgba('amber', 1), D = o.depth ?? 45;
  c.save();
  // socket walls (hatched armour either side)
  const sw = w * 0.52, sx = x + (w - sw) / 2 + 12, top = y + 26, bot = y + h;
  c.strokeStyle = col; c.lineWidth = 1.5;
  c.beginPath();
  c.moveTo(sx - 24, top); c.lineTo(sx, top); c.lineTo(sx, bot - 10); c.lineTo(sx + 10, bot);
  c.lineTo(sx + sw - 10, bot); c.lineTo(sx + sw, bot - 10); c.lineTo(sx + sw, top); c.lineTo(sx + sw + 24, top);
  c.stroke();
  c.save();
  c.beginPath(); c.rect(sx - 22, top, 20, bot - top); c.rect(sx + sw + 2, top, 20, bot - top); c.clip();
  c.strokeStyle = rgba('orange', 0.35); c.lineWidth = 1;
  c.beginPath();
  for (let yy = top - 40; yy < bot + 40; yy += 8) { c.moveTo(sx - 24, yy + 22); c.lineTo(sx + 2, yy); c.moveTo(sx + sw, yy + 22); c.lineTo(sx + sw + 26, yy); }
  c.stroke();
  c.restore();
  // depth scale
  c.fillStyle = col; c.font = font(F.mono(500), 10); c.textAlign = 'right'; c.textBaseline = 'middle';
  for (let i = 0; i <= 9; i++) {
    const yy = top + ((bot - top - 12) * i) / 9;
    c.fillRect(sx - 40, yy, i % 3 === 0 ? 12 : 6, 1);
    if (i % 3 === 0) c.fillText(`${Math.round((D * i) / 9)}`, sx - 44, yy);
  }
  // the plug capsule
  const pw = sw - 22, ph = (bot - top) * 0.62, px = sx + 11;
  const pyC = top - ph + 20 + clamp(ins) * (bot - 12 - ph - (top - ph + 20));
  c.save();
  c.beginPath(); c.rect(sx - 60, y, sw + 120, bot - y + 20); c.clip();
  c.fillStyle = 'rgba(40,20,4,0.9)';
  c.beginPath();
  c.moveTo(px, pyC); c.lineTo(px + pw, pyC); c.lineTo(px + pw, pyC + ph - pw * 0.35); c.lineTo(px + pw * 0.5, pyC + ph); c.lineTo(px, pyC + ph - pw * 0.35); c.closePath();
  c.fill();
  c.strokeStyle = hot; c.lineWidth = 2; c.stroke();
  // capsule bands
  c.strokeStyle = rgba('amber', 0.55); c.lineWidth = 1;
  c.beginPath();
  for (let k = 1; k < 5; k++) { const yy = pyC + (ph * 0.75 * k) / 5; c.moveTo(px + 4, yy); c.lineTo(px + pw - 4, yy); }
  c.stroke();
  c.fillStyle = hot; c.font = font(F.mono(700), 10); c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('01', px + pw / 2, pyC + ph * 0.42);
  c.restore();
  // armour clamps closing at the lock
  const cl = lock * 14;
  c.fillStyle = lock > 0.99 ? rgba('green', 1) : col;
  for (const yy of [top + 18, top + (bot - top) * 0.5]) {
    c.beginPath(); c.moveTo(sx, yy - 6); c.lineTo(sx + cl, yy); c.lineTo(sx, yy + 6); c.closePath(); c.fill();
    c.beginPath(); c.moveTo(sx + sw, yy - 6); c.lineTo(sx + sw - cl, yy); c.lineTo(sx + sw, yy + 6); c.closePath(); c.fill();
  }
  c.restore();
}

/** Small tracked mono + JP caption pair on one baseline. */
export function capJP(c: CanvasRenderingContext2D, en: string, jpText: string, x: number, y: number, col: string, size = 12) {
  c.save();
  c.font = font(F.mono(600), size); c.letterSpacing = `${size * 0.18}px`; c.fillStyle = col; c.textBaseline = 'alphabetic';
  c.fillText(en, x, y);
  const w = c.measureText(en).width;
  c.letterSpacing = '0px'; c.font = jp(size + 1, 600, false); c.globalAlpha *= 0.75;
  c.fillText(jpText, x + w + 8, y);
  c.restore();
}
