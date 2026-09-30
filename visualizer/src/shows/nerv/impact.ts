// Ported from bizarro/evangelion app/src/scenes/impact.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// impact — "THIRD IMPACT" (drop 3b, bars 87–96, 161.42 – 177.62 s).
// The NERV control wall: a 4×4 grid of mini instruments all running at once, every one of them a
// real visualizer (psychograph = the waveform, harmonics = the mel spectrum, the countdown = the time
// left in the plate, radar = one sweep per bar, A.T. field = kick ripples, MAGI = votes on the kicks,
// ECG = the kick onsets, SEELE = the chroma, the log = the hats, Instrumentality = kicks counted).
// Behind the wall a giant cross of light grows out of the central gutters and pushes the grid apart,
// while the red horizon of the LCL sea rises. Every 2-bar phrase the wall reconfigures: the
// instruments rotate one slot outward from the cross. Everything red-shifts towards the end; bar 95,
// the last bar, the panels fail one by one to black, outer ones first, and the cross collapses.
import * as THREE from 'three';
import { Scene, type Frame, type PostOverrides } from '../../show/scene.ts';
import { Layer2D } from '../../show/gl.ts';
import { rgba, type PaletteKey } from '../../show/palette.ts';
import { F, font } from '../../show/type.ts';
import { clamp, ease, frameIdx, hash, mulberry32, prog } from '../../show/util.ts';
import { barTime, brackets, chamferPath, jp, makeScanPass, panel } from './_eva.ts';
import { kickDuck, lastIdx, makeGlitchComp, mix } from './berserk-fx.ts';
import { drawTitle, INSTRUMENTS, makeImpactBG, wallChrome, type Rect, type S } from './impact-kit.ts';

const CX = 960, CY = 566; // the cross (and the wall's central gutters), logical px, y down
const NS = 14; // cyclable slots (16 cells minus the 2-cell title)
const RED_W: Partial<Record<PaletteKey, number>> = { orange: 1, amber: 0.85, green: 1, cyan: 0.55, lime: 0.9, purple: 0.7, bone: 0.35, red: 0 };

type Slot = { row: number; col: number; span: number };

export default class Impact extends Scene {
  bg = makeImpactBG();
  L = new Layer2D();
  glitch = makeGlitchComp();
  scan = makeScanPass(0.24);
  mel = new Float32Array(64);
  chroma = new Float32Array(12);
  kicks: [number, number, boolean][] = [];
  T = { s: 0, e: 0, b95: 0 };
  /** 14 slots in reading order (row, col); the title spans row 0 cols 0–1 */
  slots: Slot[] = [];
  base: number[] = [];
  /** fail times in bar 95: slots 0..13, then 14 = chrome, 15 = title */
  fail: number[] = [];
  /** per-slot reconfiguration delay (radial from the cross) */
  delay: number[] = [];

  override init() {
    const au = this.ctx.audio;
    this.T = { s: barTime(au, 87), e: barTime(au, 96), b95: barTime(au, 95) };
    const snares = au.events('snare', this.T.s - 2, this.T.e + 1).map((x) => x[0]);
    this.kicks = au.events('kick', this.T.s - 3, this.T.e + 1).filter((k) => k[1] > 0.5)
      .map(([kt, st]) => [kt, st, snares.some((x) => Math.abs(x - kt) < 0.05)]);
    for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) if (!(row === 0 && col < 2)) this.slots.push({ row, col, span: 1 });
    // a seeded base order; phrase p shows base[(slot + 5p) % 14]
    const rnd = mulberry32(87);
    this.base = Array.from({ length: NS }, (_, i) => i);
    for (let i = NS - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [this.base[i], this.base[j]] = [this.base[j]!, this.base[i]!]; }
    // radial order from the cross: centre-most slots switch first, outer ones fail first
    const centre = this.slots.map((s) => Math.hypot((s.col - 1.5) * 1.1, (s.row - 1.5)) + hash(s.row, s.col, 3) * 0.35);
    const mx = Math.max(...centre);
    this.delay = centre.map((d) => 0.02 + 0.2 * (d / mx));
    const order = centre.map((d, i) => [d, i] as [number, number]).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
    order.splice(7, 0, 14); // the header / footer die halfway through
    order.push(15); //         the title card is the last to go
    this.fail = new Array(16).fill(0);
    order.forEach((idx, k) => { this.fail[idx] = this.T.b95 + 0.06 + k * 0.088; });
  }

  /** Grid rect of a slot for the current central gutter half-widths. */
  cell(row: number, col: number, span: number, gx: number, gy: number): Rect {
    const X0 = 56, X1 = 1864, Y0 = 118, Y1 = 1016, g = 14;
    const lw = (CX - gx - X0 - g) / 2, rw = (X1 - CX - gx - g) / 2;
    const th = (CY - gy - Y0 - g) / 2, bh = (Y1 - CY - gy - g) / 2;
    const xs = [X0, X0 + lw + g, CX + gx, CX + gx + rw + g], ws = [lw, lw, rw, rw];
    const ys = [Y0, Y0 + th + g, CY + gy, CY + gy + bh + g], hs = [th, th, bh, bh];
    const w = span === 2 ? ws[col]! * 2 + g : ws[col]!;
    return { x: xs[col]!, y: ys[row]!, w, h: hs[row]! };
  }

  render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides {
    const { renderer, audio: au } = this.ctx;
    const T = this.T, t = f.t, fi = frameIdx(t), lt = t - T.s;
    const kd = kickDuck(au, t, 0.3, 0.5);
    const snare = au.hit('snare', t, 0.12), hat = au.hit('hat', t, 0.06), kick = au.hit('kick', t, 0.1), vox = au.hit('vocal', t, 0.15);
    const bass = clamp(f.a.bass * 1.15);
    const phraseRaw = Math.floor(lt / 3.6), phrase = clamp(phraseRaw, 0, 4);
    const phraseT = T.s + phrase * 3.6;
    const slam = Math.exp(-(t - phraseT) / 0.09);
    const red = clamp(0.08 + 0.8 * prog(t, T.s + 1.8, T.b95, ease.inQuad) + 0.12 * prog(t, T.b95, T.b95 + 0.4));
    const grow = prog(t, T.s, T.b95 + 0.9, ease.inQuad);
    const lastFail = this.fail[15]!;
    const collapse = prog(t, lastFail + 0.04, T.e - 0.03, ease.inOutCubic);
    const gx = 14 + 26 * grow, gy = 10 + 18 * grow;
    const ci = lastIdx(au, 'snare', t, 0.5), cT = ci >= 0 ? au.onsets.snare![ci]![0] : -1e9;
    const ki = lastIdx(au, 'kick', t, 0.5), kT = ki >= 0 ? au.onsets.kick![ki]![0] : -1e9;
    const vi = lastIdx(au, 'vocal', t, 0.2), vT = vi >= 0 ? au.onsets.vocal![vi]![0] : -1e9;
    au.melFrame(t, this.mel); au.chroma(t, this.chroma);
    const C = (k: PaletteKey, a = 1) => (k === 'red' ? rgba('red', a) : mix(k, 'red', red * (RED_W[k] ?? 1), a));
    const s: S = {
      au, t, fi, red, kd, kick, snare, hat, vox, bass, rms: f.a.rms, mel: this.mel, chroma: this.chroma, T0: T.s, T1: T.e,
      phrase, nHat: lastIdx(au, 'hat', t) + 1, nKick: this.kicks.filter((k) => k[0] >= T.s - 0.05 && k[0] <= t).length,
      kT, cT, vT, kicks: this.kicks, C,
    };

    // ---------------------------------------------------------------- GL background
    const u = this.bg.u;
    u.t!.value = t; u.grow!.value = grow; u.pulseK!.value = kd; u.bassK!.value = bass; u.redk!.value = red;
    u.collapse!.value = collapse; u.fseed!.value = fi % 997;
    u.groundA!.value = 1 - prog(t, T.b95 + 0.6, lastFail, ease.linear);
    u.horizA!.value = (0.35 + 0.65 * grow) * (1 - 0.7 * collapse);
    (u.ctr!.value as THREE.Vector2).set(CX, CY);
    this.bg.render(renderer, out);

    // ---------------------------------------------------------------- the wall
    const L = this.L; L.clear();
    const c = L.ctx;
    const power = (idx: number, t0: number) => { // CRT power-on flicker (0 / 1)
      const p = (t - t0) / 0.16;
      if (p >= 1) return 1;
      if (p <= 0) return 0;
      return hash(fi, idx, 17) < p ? 1 : 0;
    };
    const failState = (idx: number) => t - this.fail[idx]!; // < 0: alive

    // chrome
    const chF = failState(14);
    if (chF < 0.1 && (chF < 0 || hash(fi, 99) < 0.5)) wallChrome(c, s, prog(lt, 0, 0.3, ease.outCubic));

    // title (fixed)
    {
      const r = this.cell(0, 0, 2, gx, gy), tf = failState(15);
      c.save();
      if (tf < 0) { c.globalAlpha = power(20, T.s); drawTitle(c, r, s, slam); }
      else this.drawFail(c, r, tf, 15, s, true);
      c.restore();
    }

    // the 14 mini instruments
    const alarmSlot = ci >= 0 ? Math.floor(hash(ci, 41) * NS) : -1, alarm = Math.exp(-(t - cT) / 0.13);
    const voxSlot = vi >= 0 ? Math.floor(hash(vi, 43) * NS) : -1, voxA = Math.exp(-(t - vT) / 0.3);
    for (let i = 0; i < NS; i++) {
      const sl = this.slots[i]!;
      const r = this.cell(sl.row, sl.col, sl.span, gx, gy);
      const tf = failState(i);
      if (tf >= 0) { this.drawFail(c, r, tf, i, s, false); continue; }
      // which instrument: the current phrase's, once this slot has reconfigured
      const pUse = Math.min(3, phrase);
      const t0 = T.s + pUse * 3.6 + (pUse === 0 ? this.delay[i]! * 0.6 : this.delay[i]!);
      let p = pUse, on = 1;
      if (t < t0) { p = pUse - 1; on = p < 0 ? 0 : 1; }
      else on = power(i, t0);
      if (p < 0 || !on) { this.drawBlank(c, r, s, i, p < 0 && pUse === 0 ? 'STANDBY' : 'RECONFIGURING'); continue; }
      const inst = INSTRUMENTS[this.base[(i + 5 * p) % NS]!]!;
      const flip = Math.exp(-(t - t0) / 0.14) * (t >= t0 ? 1 : 0);
      const hot = i === alarmSlot ? alarm : 0;
      const col = C(inst.color);
      c.save();
      const inner = panel(c, r.x, r.y, r.w, r.h, {
        title: inst.title, jp: inst.jp, color: hot > 0.35 ? rgba('red', 1) : col, header: 24, cut: 12,
        fill: hot > 0.3 ? `rgba(120,0,0,${0.5 + 0.4 * hot})` : 'rgba(12,8,4,0.88)',
      });
      if (flip > 0.02) { // reconfiguration flash: the new panel lights up in its colour
        chamferPath(c, r.x, r.y, r.w, r.h, [0, 12, 0, 12]); c.fillStyle = mix(inst.color, 'red', red * 0.8, 0.55 * flip); c.fill();
      }
      // slot id + live dot in the header's right end
      c.font = font(F.mono(600), 10); c.letterSpacing = '1.5px'; c.textAlign = 'right'; c.textBaseline = 'middle';
      c.fillStyle = C('orange', 0.7);
      c.fillText(`${String.fromCharCode(65 + sl.row)}-${sl.col + 1}  CH.${String((i * 7 + p * 3) % 64).padStart(2, '0')}`, r.x + r.w - 30, r.y + 13);
      c.letterSpacing = '0px'; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
      c.fillStyle = hot > 0.3 ? rgba('red', 1) : col; c.globalAlpha = 0.35 + 0.65 * Math.max(kd, hot);
      c.fillRect(r.x + r.w - 22, r.y + 9, 8, 8); c.globalAlpha = 1;
      c.beginPath(); c.rect(r.x + 2, r.y + 26, r.w - 4, r.h - 28); c.clip();
      inst.draw(c, inner, s);
      c.restore();
      // the Angel speaks: cyan brackets on a panel
      if (i === voxSlot && voxA > 0.05) {
        const g = 6 + 10 * (1 - voxA);
        brackets(c, r.x - g, r.y - g, r.w + 2 * g, r.h + 2 * g, 22, rgba('cyan', voxA), 2.5);
        c.fillStyle = rgba('cyan', voxA); chamferPath(c, r.x + r.w - 164, r.y + 3, 158, 19, [0, 6, 0, 6]); c.fill();
        c.fillStyle = rgba('ink', 1); c.font = font(F.mono(700), 11); c.letterSpacing = '2px'; c.textBaseline = 'middle';
        c.fillText('PATTERN BLUE', r.x + r.w - 156, r.y + 13); c.letterSpacing = '0px';
        c.font = jp(12, 800, false); c.fillText('使徒', r.x + r.w - 44, r.y + 13); c.textBaseline = 'alphabetic';
      }
    }

    // gutter markers on the cross axes (the wall's seams): tick rails along the central gutters
    if (collapse < 1) {
      const ga = (1 - prog(t, T.b95, lastFail, ease.linear)) * 0.8;
      c.fillStyle = C('amber', ga);
      for (let y = 124; y < 1010; y += 18) { if (Math.abs(y - CY) < gy + 4) continue; c.fillRect(CX - gx + 3, y, 5, 1); c.fillRect(CX + gx - 8, y, 5, 1); }
      for (let x = 62; x < 1860; x += 18) { if (Math.abs(x - CX) < gx + 4) continue; c.fillRect(x, CY - gy + 2, 1, 4); c.fillRect(x, CY + gy - 6, 1, 4); }
    }

    // ---------------------------------------------------------------- composite
    const failBurst = [...this.fail].reduce((a, tf) => a + (t >= tf ? Math.exp(-(t - tf) / 0.06) : 0), 0);
    const gAmt = clamp(snare * 0.3 + red * 0.12 + 0.5 * slam * (phrase > 0 ? 1 : 0) + 0.6 * failBurst + (hash(fi, 5) < 0.02 + red * 0.08 ? 0.35 : 0));
    this.glitch.draw(renderer, L.upload(), out, gAmt, (ci * 13 + phrase * 7 + (t > T.b95 ? fi : 0)) % 1000, 0.6 + 1.5 * kick + 2 * red);
    this.scan.u.t!.value = t;
    this.scan.render(renderer, out);

    const kSh = hash(ki, 3) - 0.5, kSh2 = hash(ki, 4) - 0.5;
    return {
      bloom: 0.72 + 0.18 * grow, bloomThreshold: 0.6, halation: 0.1, vignette: 0.4, grain: 0.05,
      ca: 1 + 2.5 * snare + 2.5 * red + 3 * failBurst,
      flash: 0.9 * Math.exp(-lt / 0.1) + (phrase > 0 && phrase === phraseRaw ? 0.22 * slam : 0) + 0.04 * snare,
      shake: [kSh * 8 * kd * (0.5 + red), kSh2 * 6 * kd * (0.5 + red)],
      zoom: 1 + 0.008 * kd + 0.06 * Math.exp(-lt / 0.12) + 0.015 * slam * (phrase > 0 ? 1 : 0),
    };
  }

  /** An empty panel frame (a slot between instruments / before power-on). */
  drawBlank(c: CanvasRenderingContext2D, r: Rect, s: S, i: number, label: string) {
    c.save();
    chamferPath(c, r.x, r.y, r.w, r.h, [0, 12, 0, 12]);
    c.fillStyle = 'rgba(6,4,2,0.92)'; c.fill();
    c.strokeStyle = s.C('orange', 0.35); c.lineWidth = 1; c.stroke();
    c.fillStyle = s.C('orange', 0.55); c.font = font(F.mono(700), 12); c.letterSpacing = '3px'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(`${String.fromCharCode(65 + this.slots[i]!.row)}-${this.slots[i]!.col + 1}  ${label}`, r.x + r.w / 2, r.y + r.h / 2 - 8);
    c.letterSpacing = '0px'; c.font = jp(13, 700, false);
    c.fillText(label === 'STANDBY' ? '待機中' : '再構成中', r.x + r.w / 2, r.y + r.h / 2 + 12);
    c.restore();
  }

  /** A failing panel: glitch, SIGNAL LOST in red, then black. */
  drawFail(c: CanvasRenderingContext2D, r: Rect, tf: number, idx: number, s: S, title: boolean) {
    const fi = s.fi;
    c.save();
    if (tf < 0.1) {
      // the panel tears: a red block with offset scan rows
      if (hash(fi, idx, 3) < 0.6) {
        c.fillStyle = rgba('red', 0.85); c.fillRect(r.x, r.y, r.w, r.h);
        c.fillStyle = rgba('ink', 1);
        for (let k = 0; k < 6; k++) { const y = r.y + hash(fi, idx, k) * r.h; c.fillRect(r.x, y, r.w, 3 + 12 * hash(fi, idx, k + 9)); }
      }
    } else if (tf < 0.36) {
      const on = ((tf * 14) % 1) < 0.6;
      chamferPath(c, r.x, r.y, r.w, r.h, [0, 12, 0, 12]);
      c.fillStyle = on ? 'rgba(70,0,0,0.92)' : 'rgba(8,0,0,0.92)'; c.fill();
      c.strokeStyle = rgba('red', 1); c.lineWidth = 2; c.stroke();
      c.fillStyle = rgba('red', on ? 1 : 0.5); c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = font(F.mono(700), title ? 30 : 20); c.letterSpacing = '4px';
      c.fillText('SIGNAL LOST', r.x + r.w / 2, r.y + r.h / 2 - 12);
      c.letterSpacing = '0px'; c.font = jp(title ? 26 : 18, 800, false);
      c.fillText('信号途絶', r.x + r.w / 2, r.y + r.h / 2 + 18);
      c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    } else {
      const a = 0.35 * (1 - clamp((tf - 0.36) / 0.4));
      chamferPath(c, r.x, r.y, r.w, r.h, [0, 12, 0, 12]); c.fillStyle = 'rgba(0,0,0,1)'; c.fill();
      if (a > 0.01) { c.strokeStyle = rgba('red', a); c.lineWidth = 1; c.stroke(); }
    }
    c.restore();
  }
}
