// Ported from bizarro/evangelion app/src/scenes/end-kit.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// Helpers for the `end` plate: the sweep-style psychograph trace (an EKG monitor whose head
// crosses the channel once per bar, over the previous sweep), time-smoothed envelopes for the
// settling readouts, and the CRT power-off line.
import * as THREE from 'three';
import type { AudioData } from '../../show/audio.ts';
import { FSPass } from '../../show/gl.ts';
import { rgba, type PaletteKey } from '../../show/palette.ts';
import { clamp } from '../../show/util.ts';

/** Mean of a stem envelope over [t - win, t] (n taps): a deterministic "settling" value. */
export function smoothEnv(au: AudioData, name: string, t: number, win = 0.6, n = 16) {
  let s = 0;
  for (let i = 0; i < n; i++) s += au.env(name, t - (win * i) / (n - 1));
  return s / n;
}

/** Width sevenSeg() draws `text` at digit height h (thickness `thick`, default h * 0.11). */
export function segW(text: string, h: number, thick = h * 0.11) {
  let w = 0;
  for (const ch of text) w += ch === ':' || ch === '.' ? thick * 2.6 : h * 0.52 + thick * 1.2;
  return w;
}

/** Signed soft compression so a fading signal stays readable until it is really gone. */
const comp = (v: number, k: number) => Math.sign(v) * Math.pow(Math.abs(v), k);

export interface SweepOpts {
  x: number; y: number; w: number; h: number;
  /** sweep origin (a downbeat) and period (one bar) */
  t0: number; period: number;
  /** 'wave': min/max band of the raw waveform; 'line': polyline of sample(tc) (-1..1) */
  kind: 'wave' | 'line';
  sample?: (tc: number) => number;
  color?: PaletteKey;
  gain?: number;
  /** compression exponent for the waveform band (0.5 = sqrt) */
  k?: number;
  lw?: number;
  /** blank gap ahead of the head (fraction of the width) */
  gap?: number;
  cols?: number;
  alpha?: number;
}

/**
 * Sweep trace: the head writes left→right once per `period`; ahead of it (after a small blank gap)
 * the previous sweep is still on the phosphor, dimmer with age. Pure function of t.
 * Returns the head position (px) and the head's current value.
 */
export function sweepTrace(c: CanvasRenderingContext2D, au: AudioData, t: number, o: SweepOpts) {
  const N = o.cols ?? Math.round(o.w / 2.5), gap = o.gap ?? 0.035, col = o.color ?? 'green', A = o.alpha ?? 1;
  const cy = o.y + o.h / 2, amp = (o.h / 2) * (o.gain ?? 1), k = o.k ?? 0.5;
  const u = (t - o.t0) / o.period, sw = Math.floor(u), ph = u - sw;
  const tAt = (p: number) => (p <= ph ? o.t0 + (sw + p) * o.period : o.t0 + (sw - 1 + p) * o.period);
  const smp: [number, number] = [0, 0];
  // age → alpha gradient along x: fresh at the head, oldest just past the gap
  const grad = c.createLinearGradient(o.x, 0, o.x + o.w, 0);
  const al = (p: number) => { const age = t - tAt(p); return clamp(1 - (age / o.period) * 0.72, 0.12, 1); };
  for (let i = 0; i <= 24; i++) { const p = i / 24; grad.addColorStop(p, rgba(col, A * al(p))); }
  const hp = Math.round(ph * N), gp = Math.round((ph + gap) * N);
  const inGap = (i: number) => i > hp && i <= gp;
  c.save();
  c.beginPath(); c.rect(o.x, o.y - 2, o.w, o.h + 4); c.clip();
  c.strokeStyle = grad; c.fillStyle = grad; c.lineJoin = 'round'; c.lineCap = 'round';
  c.lineWidth = o.lw ?? 1.6;
  let headV = 0;
  if (o.kind === 'wave') {
    // min/max of the waveform over each column's time slice, drawn as a mirrored filled band
    const dtc = o.period / N, S = 6, ga = c.globalAlpha;
    const top: number[] = [], bot: number[] = [];
    for (let i = 0; i <= N; i++) {
      const tc = tAt(i / N);
      let lo = 0, hi = 0;
      for (let s = 0; s < S; s++) { const v = au.waveAt(tc + (dtc * s) / S, smp); const m = (v[0] + v[1]) * 0.5; if (m < lo) lo = m; if (m > hi) hi = m; }
      top.push(cy - comp(hi, k) * amp); bot.push(cy - comp(lo, k) * amp);
      if (i === hp) headV = Math.max(hi, -lo);
    }
    const band = (i0: number, i1: number) => {
      if (i1 <= i0) return;
      c.beginPath();
      for (let i = i0; i <= i1; i++) { const px = o.x + (o.w * i) / N; if (i === i0) c.moveTo(px, top[i]!); else c.lineTo(px, top[i]!); }
      for (let i = i1; i >= i0; i--) c.lineTo(o.x + (o.w * i) / N, bot[i]!);
      c.closePath();
      c.globalAlpha = ga * 0.28; c.fill();
      c.globalAlpha = ga; c.stroke();
    };
    band(0, hp); band(Math.min(N, gp + 1), N);
  } else {
    const f = o.sample!;
    const ys: number[] = [];
    for (let i = 0; i <= N; i++) { const v = f(tAt(i / N)); ys.push(cy - clamp(v, -1.2, 1.2) * amp); if (i === hp) headV = v; }
    c.beginPath();
    let pen = false;
    for (let i = 0; i <= N; i++) {
      if (inGap(i)) { pen = false; continue; }
      const px = o.x + (o.w * i) / N;
      if (!pen) { c.moveTo(px, ys[i]!); pen = true; } else c.lineTo(px, ys[i]!);
    }
    c.stroke();
  }
  // the writing head: a bright dot with a short hot tail
  const hx = o.x + ph * o.w;
  const hy = o.kind === 'wave' ? cy : cy - clamp(o.sample!(t), -1.2, 1.2) * amp;
  c.fillStyle = rgba(col, A); c.shadowColor = rgba(col, A); c.shadowBlur = 10;
  c.beginPath(); c.arc(hx, hy, 3.2, 0, Math.PI * 2); c.fill();
  c.restore();
  return { hx, headV };
}

/** Graticule for a scope channel: dim minor grid, a brighter centre line, edge ticks. */
export function graticule(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, col: PaletteKey = 'green', a = 1, div = 12) {
  c.save();
  c.strokeStyle = rgba(col, 0.1 * a); c.lineWidth = 1;
  c.beginPath();
  for (let i = 0; i <= div; i++) { const px = Math.round(x + (w * i) / div) + 0.5; c.moveTo(px, y); c.lineTo(px, y + h); }
  for (let j = 0; j <= 4; j++) { const py = Math.round(y + (h * j) / 4) + 0.5; c.moveTo(x, py); c.lineTo(x + w, py); }
  c.stroke();
  c.strokeStyle = rgba(col, 0.32 * a);
  c.beginPath(); c.moveTo(x, Math.round(y + h / 2) + 0.5); c.lineTo(x + w, Math.round(y + h / 2) + 0.5);
  for (let i = 0; i <= div * 5; i++) { const px = Math.round(x + (w * i) / (div * 5)) + 0.5, l = i % 5 === 0 ? 7 : 3; c.moveTo(px, y + h / 2 - l); c.lineTo(px, y + h / 2 + l); }
  c.stroke();
  c.restore();
}

/**
 * CRT power-off: an additive horizontal line / dot at the screen centre (half-size lineHalf in
 * logical px, gain lineGain), drawn over the squashed frame.
 */
export function makeCrtLine() {
  const p = new FSPass(/* glsl */ `
    uniform vec2 lineHalf;
    uniform float lineGain;
    void main() {
      vec2 p = FRAG_PX - vec2(960.0, 540.0);
      vec2 q = max(abs(p) - lineHalf, 0.0);
      float d = length(q);
      float core = exp(-d * d / 4.5);
      float halo = exp(-d / 18.0) * 0.3 + exp(-d / 80.0) * 0.05;
      vec3 col = C_BONE * core * 2.2 + mix(C_ORANGE, C_BONE, 0.35) * halo;
      fragColor = vec4(col * lineGain, 1.0);
    }`, { lineHalf: { value: new THREE.Vector2(960, 1) }, lineGain: { value: 0 } }, { blending: THREE.AdditiveBlending, transparent: true });
  return p;
}
