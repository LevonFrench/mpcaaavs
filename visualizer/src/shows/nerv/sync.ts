// Ported from bizarro/evangelion app/src/scenes/sync.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// sync — "SYNCHRONIZATION" (build 2: bars 72–78, 134.42 – 145.22 s).
// The Unit-01 activation test with the sync ratio running away. A huge condensed-serif percentage
// climbs 41.3 % → 400 %: the ratio is the build itself (the integral of the rising high-band energy
// plus a step on every kick / clap onset), so it creeps on the pads and jumps on the hits,
// accelerating through the triplet roll of bars 74–75. Around it: the sync graph (the ratio's
// history on a log scale with the absolute borderline and the ego border, over the real high-band
// envelope), two heartbeats converging (PILOT 01 = the real kick onsets, EVA-01 = the same beats
// lagging by a phase that closes as the ratio rises), the activation sequence checklist ticking off
// on the onsets, the absolute-borderline countdown, a harmonics bank (mel spectrum), the pilot's
// voice (the vocal chops type 逃げちゃダメだ), the hex ground filling with the sync level and
// tightening bar by bar. Unit-01 purple frames and lime numbers creep in over the orange.
// Bar 76 (141.62) dropout: the HUD freezes, dims to purple, "同調率 400%" holds, pulsing on the
// riser. Bar 77 (143.42) roll: the HUD comes back stuttering, readouts scramble, rows glitch, the
// two kicks at 144.02 / 144.62 slam, the last ~0.15 s collapses to a CRT line → hard cut to berserk.
import * as THREE from 'three';
import { Scene, type Frame, type PostOverrides } from '../../show/scene.ts';
import { Layer2D } from '../../show/gl.ts';
import { rgba, LIN } from '../../show/palette.ts';
import { F, font } from '../../show/type.ts';
import { clamp, ease, frameIdx, hash, prog, pulse, smoothstep } from '../../show/util.ts';
import { barTime, brackets, chamferPath, condensed, evaLabel, hazard, hexData, jp, makeScanPass, panel, segMeter, sevenSeg, songBar } from './_eva.ts';
import { chrome, meta } from './magi-hud.ts';
import { kickDuck, lastIdx } from './berserk-fx.ts';
import { makeSyncComp, makeSyncGround, mix3, qrsEva, qrsPilot, scramble } from './sync-kit.ts';

const R0 = 41.3, R1 = 400;
const RATE = 200; // sync curve table rate (Hz)
const LOG_LO = Math.log(20), LOG_HI = Math.log(560);

type SeqRow = { t: number; jp: string; en: string; st: 'ok' | 'live' | 'warn' | 'red' };

/** Per-frame values shared by the draw methods (all evaluated at the HUD time `t`). */
type V = {
  t: number; real: number; ratio: number; g: number; creep: number; kd: number; snare: number; roll: number; rollAmt: number; seed: number;
  frame: (a?: number) => string; num: (a?: number) => string; txt: (a?: number) => string; dim: (a?: number) => string;
};

export default class Sync extends Scene {
  bg = makeSyncGround();
  hud = new Layer2D();
  ovl = new Layer2D();
  comp2 = makeSyncComp();
  scan = makeScanPass(0.24);
  mel = new Float32Array(64);
  T = { s: 0, b73: 0, b74: 0, b75: 0, fr: 0, roll: 0, e: 0, h1: 0, h2: 0 };
  E = new Float32Array(1);
  seq: SeqRow[] = [];
  steps: number[] = [];
  voice: number[] = [];
  cross100 = 0;
  wDigits = 0;
  wDec = 0;

  override init() {
    const au = this.ctx.audio, T = this.T;
    T.s = barTime(au, 72); T.b73 = barTime(au, 73); T.b74 = barTime(au, 74); T.b75 = barTime(au, 75);
    T.fr = barTime(au, 76); T.roll = barTime(au, 77); T.e = barTime(au, 78);
    // the two slams of the roll (the strongest kicks inside bar 77)
    const rk = au.events('kick', T.roll, T.e - 0.05).filter(([, s]) => s > 0.5).map(([k]) => k);
    T.h1 = rk[0] ?? T.roll + 0.6; T.h2 = rk[1] ?? T.roll + 1.2;

    // ---- the sync curve: ∫ (base + high-band energy + drums) dt + a step per kick / clap onset
    const N = Math.ceil((T.fr - T.s) * RATE) + 1;
    const E = new Float32Array(N);
    let acc = 0;
    for (let i = 0; i < N; i++) {
      const tt = T.s + i / RATE;
      acc += (0.3 + 1.5 * au.env('high', tt) + 0.5 * au.env('drums', tt)) / RATE;
      E[i] = acc;
    }
    const ons = [
      ...au.events('kick', T.s - 0.01, T.fr).map(([a, s]) => [a, s] as [number, number]),
      ...au.events('snare', T.s - 0.01, T.fr).map(([a, s]) => [a, s * 0.9] as [number, number]),
    ];
    const sum = ons.reduce((q, [, s]) => q + s, 0) || 1;
    const w = (acc * 0.9) / sum; // onsets carry about half of the climb
    for (const [ot, s] of ons) {
      const i0 = Math.max(0, Math.floor((ot - T.s) * RATE));
      for (let i = i0; i < N; i++) E[i]! += w * s * smoothstep(0, 0.07, T.s + i / RATE - ot);
    }
    const top = E[N - 1]!;
    for (let i = 0; i < N; i++) E[i] = E[i]! / top;
    this.E = E;
    // when the ratio crosses the absolute borderline (100 %)
    this.cross100 = T.fr;
    for (let t = T.s; t < T.fr; t += 0.005) if (this.ratioAt(t) >= 100) { this.cross100 = t; break; }

    // data steps (hats + kicks) and the vocal chops
    this.steps = [...au.events('hat', T.s - 4, T.e), ...au.events('kick', T.s - 4, T.e)].map(([a]) => a).sort((a, b) => a - b);
    this.voice = au.events('vocal', T.s - 0.05, T.fr).map(([a]) => a);

    // ---- the activation sequence: rows appear on onsets (min 0.32 s apart) through bars 72–74
    const lines: [string, string][] = [
      ['第1次接続 開始', 'PRIMARY CONNECTION'],
      ['A10神経 接続異常なし', 'A10 NERVE CONNECTION'],
      ['思考言語 日本語で固定', 'THOUGHT LANGUAGE: JPN'],
      ['初期コンタクト 問題なし', 'INITIAL CONTACT: CLEAR'],
      ['双方向回線 開きます', 'BIDIRECTIONAL CIRCUIT'],
      ['ハーモニクス 正常位置', 'HARMONICS NOMINAL'],
    ];
    const pool = [...au.events('kick', T.s + 0.3, T.b75), ...au.events('snare', T.s + 0.3, T.b75), ...au.events('hat', T.s + 0.3, T.b75)].map(([a]) => a).sort((a, b) => a - b);
    const times: number[] = [];
    for (const pt of pool) { if (times.length >= lines.length) break; if (!times.length || pt - times[times.length - 1]! > 0.32) times.push(pt); }
    const rows: SeqRow[] = [
      { t: T.s - 9, jp: '主電源 接続完了', en: 'MAIN POWER CONNECTED', st: 'ok' },
      { t: T.s - 6, jp: '稼働電圧 臨界点突破', en: 'VOLTAGE PAST CRITICAL', st: 'ok' },
      { t: T.s - 4.5, jp: 'エントリープラグ 固定', en: 'ENTRY PLUG LOCKED', st: 'ok' },
      { t: T.s - 3, jp: 'LCL 注水完了', en: 'LCL FILLED', st: 'ok' },
      { t: T.s - 1.5, jp: 'LCL 電化', en: 'LCL ELECTROLYSIS', st: 'ok' },
    ];
    lines.forEach(([j, e], i) => rows.push({ t: times[i] ?? T.s + 0.5 + i * 0.6, jp: j, en: e, st: 'ok' }));
    rows.push({ t: this.cross100, jp: '絶対境界線 突破', en: 'ABSOLUTE BORDERLINE', st: 'warn' });
    rows.push({ t: T.b75, jp: 'シンクロ率 上昇中', en: 'SYNC RATIO RISING', st: 'live' });
    rows.push({ t: T.fr, jp: '自我境界 消失', en: 'EGO BORDER LOST', st: 'red' });
    rows.push({ t: T.h1, jp: '初号機 制御不能', en: 'UNIT-01 NO CONTROL', st: 'red' });
    this.seq = rows.sort((a, b) => a.t - b.t);

    // big-digit metrics (the int part right-aligns on a fixed decimal point)
    const c = this.hud.ctx;
    c.font = font(F.serif(600), 100);
    this.wDigits = c.measureText('400').width / 100;
    this.wDec = c.measureText('.0').width / 100;
  }

  /** Sync ratio at time t (41.3 at bar 72 → 400 at bar 76, then pegged). */
  ratioAt(t: number) {
    const T = this.T;
    if (t >= T.fr) return R1;
    const x = clamp((t - T.s) * RATE, 0, this.E.length - 1.001), i = Math.floor(x), fr = x - i;
    const g = this.E[i]! + (this.E[i + 1]! - this.E[i]!) * fr;
    return R0 * Math.pow(R1 / R0, Math.pow(g, 1.2));
  }
  /** 0..1 sync progress on the log scale (0 = 41.3 %, 1 = 400 %). */
  gAt(t: number) { return Math.log(this.ratioAt(t) / R0) / Math.log(R1 / R0); }

  render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides {
    const { renderer, audio: au } = this.ctx;
    const T = this.T, t = f.t, fi = frameIdx(t);
    const frozen = t >= T.fr && t < T.roll, rolling = t >= T.roll;
    const rollK = prog(t, T.roll, T.e);
    const collapse = prog(t, T.e - 0.2, T.e - 0.05, ease.inQuad);
    const slam = rolling ? Math.max(pulse(t, T.h1, 0.09), pulse(t, T.h2, 0.09)) : 0;

    // ---- HUD time: frozen through the dropout; stuttering (repeats / skips) through the roll
    let tH = t;
    if (frozen) tH = T.fr - 1 / 480;
    if (rolling) {
      const ch = Math.floor(fi / 3);
      if (hash(ch, 11) < 0.3 + 0.45 * rollK) tH = Math.max(T.roll, t - 0.05 - hash(ch, 12) * 0.35);
    }
    const ratio = frozen || rolling ? R1 : this.ratioAt(tH);
    const g = Math.log(ratio / R0) / Math.log(R1 / R0);
    const creep = clamp(smoothstep(0, 1, (songBar(au, tH) - 72) / 4) * 1.05);
    const redK = rolling ? 0.35 * rollK + 0.5 * slam + (hash(Math.floor(fi / 2), 5) < 0.2 ? 0.4 : 0) : 0;
    const v: V = {
      t: tH, real: t, ratio, g, creep, kd: kickDuck(au, tH, 0.24, 0.3), snare: au.hit('snare', tH, 0.1), roll: rolling ? 1 : 0, rollAmt: rollK,
      seed: rolling ? Math.floor(fi / 2) : 0,
      frame: (a = 1) => mix3('orange', 'purple', creep, 'red', redK, a),
      num: (a = 1) => mix3('amber', 'lime', creep, 'red', redK, a),
      txt: (a = 1) => mix3('orange', 'lime', creep * 0.55, 'red', redK, a),
      dim: (a = 1) => mix3('orange', 'purple', creep, 'red', redK * 0.5, a),
    };

    // ---- GL ground
    const bi = clamp(Math.floor(songBar(au, tH)) - 72, 0, 5);
    const u = this.bg.u;
    u.t!.value = tH; u.rad!.value = [40, 34, 29, 25, 22, 22][bi]!; u.lvl!.value = 0.04 + 0.86 * g;
    u.seed!.value = lastIdx(au, 'kick', tH) + lastIdx(au, 'hat', tH); u.kick!.value = v.kd; u.creep!.value = creep; u.glow!.value = au.env('high', tH);
    u.vis!.value = (frozen ? 0.55 : 1) * (1 - clamp(collapse * 2.5));
    (u.colC!.value as number[]).splice(0, 3, ...(creep > 0.5 ? LIN.lime : LIN.amber));
    this.bg.render(renderer, out);

    // ---- HUD
    const L = this.hud; L.clear();
    const c = L.ctx;
    const lt = tH - T.s;
    const on = (grp: number) => {
      const p = (lt - grp * 0.045) / 0.2;
      if (p >= 1) return 1;
      if (p <= 0) return 0;
      return hash(frameIdx(tH), grp) < p ? 1 : 0.15;
    };
    const bar = frozen ? 76 : Math.floor(songBar(au, tH));
    chrome(c, tH, au, {
      no: '13', en: 'SYNCHRONIZATION', jpText: 'シンクロ率 測定', color: v.frame(1), reveal: prog(lt, 0, 0.3, ease.outCubic),
      sub: 'EVA-01 ACTIVATION TEST  //  PILOT 01  //  A10 NERVE LINK  //  初号機 起動試験',
      tick: 'SYNCHRONIZATION IN PROGRESS // シンクロ率 上昇中 // HARMONICS: ALL NOMINAL // A10 NERVE CONNECTION: NO ANOMALY // 双方向回線 開放 // LCL PRESSURE NOMINAL // PILOT 01 // EVA-01 TEST TYPE // ',
    });
    c.globalAlpha = on(0); this.drawRatio(c, v, bar);
    c.globalAlpha = on(1); this.drawGraph(c, v);
    c.globalAlpha = on(2); this.drawPulse(c, v);
    c.globalAlpha = on(3); this.drawSeq(c, v);
    c.globalAlpha = on(4); this.drawBorder(c, v);
    c.globalAlpha = on(5); this.drawHarmonics(c, v);
    c.globalAlpha = 1;
    // clap alarm: frame flare on the claps of bars 74–75
    const ca = v.snare * smoothstep(0.35, 0.6, au.events('snare', tH - 0.2, tH + 0.001).reduce((m, [, s]) => Math.max(m, s), 0));
    if (ca > 0.05 && !frozen) { c.strokeStyle = rgba('red', ca * 0.9); c.lineWidth = 4; c.strokeRect(40, 116, 1840, 906); }

    // ---- composite the HUD: dim purple during the freeze, glitching through the roll
    const sq = 1 - collapse * 0.997;
    const gAmt = rolling ? clamp(0.18 + 0.4 * rollK + 0.9 * slam + (hash(Math.floor(fi / 2), 3) < 0.25 ? 0.35 : 0)) : clamp(v.snare * 0.25 * creep);
    const gSeed = rolling ? Math.floor(fi / 2) % 997 : lastIdx(au, 'snare', tH) * 7;
    this.comp2.draw(renderer, L.upload(), out, {
      amt: gAmt, seed: gSeed, split: rolling ? 2 + 6 * slam : 0.6 + 2 * v.snare, sq, beam: collapse * 1.4 * (1 - 0.7 * prog(t, T.e - 0.05, T.e)),
      opacity: frozen ? 0.32 : 1, tint: frozen ? [0.75, 0.55, 1.1] : [1, 1, 1],
    });

    // ---- the freeze card (bars 76–77)
    if (t >= T.fr) {
      const O = this.ovl; O.clear();
      this.drawCard(O.ctx, t, frozen, rollK, slam);
      const flick = rolling && hash(Math.floor(fi / 2), 9) < 0.18 + 0.25 * rollK ? 0 : 1;
      this.comp2.draw(renderer, O.upload(), out, {
        amt: rolling ? clamp(0.35 + 0.5 * rollK + slam) : 0, seed: (gSeed + 31) % 997, split: rolling ? 3 + 8 * slam : 0,
        opacity: flick, sq, beam: 0,
      });
    }
    this.scan.u.t!.value = t;
    this.scan.render(renderer, out);

    const k0 = t - T.s;
    const sh = rolling ? slam * 14 + (hash(fi, 1) < 0.2 ? 4 : 0) : 0;
    return {
      bloom: 0.62, bloomThreshold: 0.6, halation: 0.1, vignette: 0.42, grain: 0.05,
      ca: 0.8 + 2.4 * v.snare + 3 * Math.exp(-k0 / 0.12) + (rolling ? 2 + 5 * slam + 3 * rollK : 0) + 2.5 * pulse(t, T.fr, 0.1),
      flash: 0.4 * Math.exp(-k0 / 0.09) + 0.25 * pulse(t, T.fr, 0.07) + 0.35 * slam,
      shake: [(hash(fi, 2) - 0.5) * sh * 2, (hash(fi, 3) - 0.5) * sh * 1.4],
      zoom: 1 + 0.035 * Math.exp(-k0 / 0.15) + 0.006 * v.kd + 0.03 * slam + 0.015 * pulse(t, T.fr, 0.12),
    };
  }

  // ================================================================ the big ratio
  drawRatio(c: CanvasRenderingContext2D, v: V, bar: number) {
    const T = this.T;
    const X0 = 64, XR = 1116;
    brackets(c, 56, 122, 1060, 598, 26, v.frame(0.9), 2);
    evaLabel(c, 84, 158, 'synchronization ratio  //  pilot 01 → unit-01', '同調率  シンクロ率', { color: v.txt(1), size: 1.2 });
    // stage chip (per bar)
    const stages: [string, string][] = [['第1次接続', 'PRIMARY'], ['第2次接続', 'SECONDARY'], ['第3次接続', 'TERTIARY'], ['双方向回線', 'BIDIRECTIONAL'], ['限界突破', 'LIMIT BREACHED'], ['制御不能', 'NO CONTROL']];
    const [sj, se] = stages[clamp(bar - 72, 0, 5)]!;
    const cw = 372, cx = XR - 20 - cw;
    chamferPath(c, cx, 136, cw, 34, [0, 12, 0, 12]);
    c.fillStyle = bar >= 76 ? rgba('red', 1) : v.frame(1); c.fill();
    c.fillStyle = rgba('ink', 1); c.textBaseline = 'middle'; c.textAlign = 'left';
    c.font = jp(18, 800, false); c.fillText(sj, cx + 14, 154);
    c.font = font(F.mono(700), 13); c.letterSpacing = '2.5px'; c.textAlign = 'right';
    c.fillText(`${Math.min(bar - 71, 6)}/6  ${se}`, cx + cw - 14, 154); c.letterSpacing = '0px'; c.textAlign = 'left';
    for (let i = 0; i < 6; i++) { c.fillStyle = i <= bar - 72 ? (i >= 4 ? rgba('red', 1) : v.frame(1)) : v.frame(0.15); c.fillRect(cx + i * 63, 176, 58, 5); }

    // digits: int part right-aligned on a fixed decimal point, the decimal and % after it
    const size = 520, sx = 0.56;
    const str = v.ratio.toFixed(1);
    let [ip, dp] = str.split('.') as [string, string];
    if (v.roll) {
      // readouts glitch: mostly 400.0, flipping to test patterns / scrambles in 2-frame chunks
      const hv = hash(v.seed, 61), alt: [string, string][] = [['888', '8'], ['4O0', '0'], ['ERR', '0'], ['400', '4'], ['0', '00']];
      if (hv < 0.08 + 0.22 * v.rollAmt) [ip, dp] = alt[Math.floor(hash(v.seed, 62) * alt.length)]!;
      else if (hv < 0.16 + 0.25 * v.rollAmt) { ip = scramble(ip, v.seed, 0.34); dp = scramble(dp, v.seed + 1, 0.5); }
    }
    const xDot = X0 + 20 + this.wDigits * size * sx;
    const yB = 568;
    const bump = 1 + 0.012 * v.kd;
    // onset flash: the last ratio jump lights the digits bright
    const li = lastIdx(this.ctx.audio, 'kick', v.t, 0.3);
    const jump = li >= 0 && v.t < T.fr ? pulse(v.t, this.ctx.audio.onsets.kick![li]![0], 0.03) : 0;
    const col = jump > 0.5 ? rgba('bone', 1) : v.num(1);
    c.save();
    c.translate(X0, yB); c.scale(bump, bump); c.translate(-X0, -yB);
    condensed(c, ip, xDot, yB, size, { sx, color: col, align: 'right', bold: 0.018 });
    condensed(c, '.' + dp, xDot + 4, yB, size, { sx, color: col, bold: 0.018 });
    const xp = xDot + 10 + this.wDec * size * sx;
    const wp = condensed(c, '%', xp, yB - 8, 250, { sx: 0.62, color: v.num(1), bold: 0.02 });
    c.restore();
    // right of the %: 同調率 + readouts
    const rx = xp + wp + 22;
    c.font = jp(52, 700, true); c.fillStyle = v.txt(1); c.textBaseline = 'alphabetic'; c.textAlign = 'left';
    c.fillText('同調率', rx, 300);
    c.fillStyle = v.frame(0.8); c.fillRect(rx, 318, XR - 20 - rx, 2);
    meta(c, rx, 350, [
      ['PILOT', '01  IKARI'], ['UNIT', 'EVA-01'], ['TARGET', `${R1.toFixed(1)} %`],
      ['DELTA', `+${(v.ratio - R0).toFixed(1)}`], ['RATE', `${this.rate(v.t).toFixed(1)} %/S`], ['LCL', `${(1.02 + 0.3 * v.g).toFixed(2)} ATM`],
      ['A10', `${(88 + 60 * v.g + 4 * v.kd).toFixed(1)} HZ`], ['PLUG', `DEPTH ${(1.6 + 0.4 * v.g).toFixed(2)} M`],
    ].map(([a, b]) => [a!, v.roll ? scramble(b!, v.seed + 7, 0.35) : b!] as [string, string]), { size: 13, keyW: 70, color: v.txt(0.9), lead: 24 });

    // the 0–400 scale bar
    const by = 604, bw = XR - 20 - (X0 + 20), bx = X0 + 20, n = 100;
    const lit = v.ratio / R1;
    const segW = (bw - (n - 1) * 3) / n;
    for (let i = 0; i < n; i++) {
      const k = (i + 0.5) / n;
      const on = k <= lit;
      c.fillStyle = on ? (k > 0.75 ? rgba('red', 1) : k > 0.25 ? v.frame(1) : v.num(1)) : v.dim(0.1);
      c.fillRect(bx + i * (segW + 3), by, segW, 26);
    }
    // ticks + labels
    c.font = font(F.mono(600), 11); c.letterSpacing = '1.5px'; c.textBaseline = 'alphabetic';
    for (let r = 0; r <= 400; r += 25) {
      const x = bx + (r / 400) * bw;
      c.fillStyle = v.txt(r % 100 === 0 ? 0.9 : 0.4);
      c.fillRect(x, by + 30, 1, r % 100 === 0 ? 10 : 5);
      if (r % 100 === 0) { c.textAlign = r === 400 ? 'right' : r === 0 ? 'left' : 'center'; c.fillText(`${r}%`, x, by + 54); }
    }
    c.textAlign = 'left';
    const mark = (r: number, en: string, jpT: string, colr: string) => {
      const x = bx + (r / 400) * bw;
      c.fillStyle = colr; c.fillRect(x - 1, by - 10, 2, 46);
      c.beginPath(); c.moveTo(x - 6, by - 16); c.lineTo(x + 6, by - 16); c.lineTo(x, by - 8); c.closePath(); c.fill();
      c.font = font(F.mono(700), 10); c.letterSpacing = '1.5px'; c.fillText(en, x + 8, by - 10);
      c.font = jp(11, 700, false); c.letterSpacing = '0px'; c.fillText(jpT, x + 8 + en.length * 7.6 + 6, by - 10);
    };
    mark(R0, 'START 41.3', '起動', v.txt(0.9));
    mark(100, 'ABSOLUTE BORDERLINE', '絶対境界線', rgba('amber', 1));
    c.textAlign = 'right';
    {
      const x = bx + bw;
      c.fillStyle = rgba('red', 1); c.fillRect(x - 2, by - 10, 2, 46);
      c.font = font(F.mono(700), 10); c.letterSpacing = '1.5px'; c.fillText('EGO BORDER  自我境界', x - 8, by - 10); c.letterSpacing = '0px';
    }
    c.textAlign = 'left';
    // head
    const hx = bx + lit * bw;
    c.fillStyle = rgba('bone', 1); c.fillRect(hx - 1.5, by - 4, 3, 34);

    // the pilot's voice: each vocal chop types another 逃げちゃダメだ
    const vy = 694;
    const nv = this.voice.filter((x) => x <= v.t).length;
    c.font = font(F.mono(700), 12); c.letterSpacing = '2.2px'; c.fillStyle = v.txt(0.85);
    c.fillText('PILOT VOICE', X0 + 20, vy - 2); c.letterSpacing = '0px';
    c.font = jp(13, 700, false); c.fillText('音声入力', X0 + 20, vy + 16);
    // live level (vocal stem)
    const ve = this.ctx.audio.env('vocal', v.t);
    segMeter(c, X0 + 142, vy - 12, 90, 22, 9, ve, { color: v.num(1), hotFrom: 0.8, dim: v.dim(0.1) });
    const lastV = nv ? this.voice[nv - 1]! : -9;
    c.font = jp(26, 700, true); c.textBaseline = 'middle';
    let x = X0 + 256;
    const shown = Math.min(nv, 4);
    for (let i = 0; i < shown; i++) {
      const newest = i === shown - 1;
      const age = v.t - lastV;
      const full = '逃げちゃダメだ';
      const txt = newest ? full.slice(0, Math.max(1, Math.ceil(clamp(age / 0.18) * full.length))) : full;
      c.fillStyle = newest ? (age < 0.12 ? rgba('bone', 1) : v.num(1)) : v.num(0.3 + 0.15 * i);
      c.fillText(txt, x, vy + 4);
      x += c.measureText(full).width + 22;
    }
    if (!nv) { c.font = font(F.mono(600), 12); c.letterSpacing = '2px'; c.fillStyle = v.txt(0.35); c.fillText('— NO INPUT —  待機中', x, vy + 4); c.letterSpacing = '0px'; }
    c.textBaseline = 'alphabetic';
  }

  /** Ratio climb rate (%/s) over the last 0.25 s. */
  rate(t: number) { return t >= this.T.fr ? 0 : (this.ratioAt(t) - this.ratioAt(t - 0.25)) / 0.25; }

  // ================================================================ sync graph
  drawGraph(c: CanvasRenderingContext2D, v: V) {
    const T = this.T, au = this.ctx.audio;
    const r = panel(c, 56, 732, 1060, 284, { title: 'SYNC GRAPH', jp: '同調グラフ', color: v.frame(1), cut: 16 });
    const gx = r.x + 62, gy = r.y + 4, gw = r.w - 70, gh = r.h - 30;
    const X = (tt: number) => gx + ((tt - T.s) / (T.e - T.s)) * gw;
    const Y = (rr: number) => gy + gh - ((Math.log(rr) - LOG_LO) / (LOG_HI - LOG_LO)) * gh;
    // grid: beats dim, bars bright + labels
    c.lineWidth = 1;
    for (let b = 0; b <= 24; b++) {
      const x = gx + (gw * b) / 24;
      c.fillStyle = b % 4 === 0 ? v.dim(0.4) : v.dim(0.12);
      c.fillRect(x, gy, 1, gh);
      if (b % 4 === 0) {
        c.font = font(F.mono(600), 10); c.letterSpacing = '1.5px'; c.fillStyle = v.txt(0.75);
        c.textAlign = b === 24 ? 'right' : 'left';
        c.fillText(`BAR ${72 + b / 4}`, x + (b === 24 ? -4 : 4), gy + gh + 16);
        c.letterSpacing = '0px'; c.textAlign = 'left';
      }
    }
    for (const rr of [25, 50, 100, 200, 400]) {
      const y = Y(rr);
      c.fillStyle = rr === 100 ? rgba('amber', 0.7) : rr === 400 ? rgba('red', 0.8) : v.dim(0.22);
      if (rr === 100 || rr === 400) { for (let x = gx; x < gx + gw; x += 10) c.fillRect(x, y, 6, 1.5); } else c.fillRect(gx, y, gw, 1);
      c.font = font(F.mono(600), 11); c.textAlign = 'right'; c.fillStyle = rr === 400 ? rgba('red', 1) : rr === 100 ? rgba('amber', 1) : v.txt(0.7);
      c.fillText(`${rr}%`, gx - 8, y + 4); c.textAlign = 'left';
    }
    c.font = font(F.mono(700), 10); c.letterSpacing = '1.5px';
    c.fillStyle = rgba('amber', 0.9); c.fillText('ABSOLUTE BORDERLINE  絶対境界線', gx + 6, Y(100) - 6);
    c.fillStyle = rgba('red', 1); c.fillText('EGO BORDER  自我境界  400%', gx + 6, Y(400) - 6);
    c.letterSpacing = '0px';
    // the real high-band envelope along the bottom (harmonic energy)
    const tEnd = Math.min(v.t, T.e);
    c.beginPath();
    const n = 240;
    for (let i = 0; i <= n; i++) {
      const tt = T.s + ((tEnd - T.s) * i) / n;
      const y = gy + gh - au.env('high', tt) * gh * 0.32;
      if (i) c.lineTo(X(tt), y); else c.moveTo(X(tt), y);
    }
    c.strokeStyle = v.dim(0.55); c.lineWidth = 1; c.stroke();
    c.font = font(F.mono(600), 10); c.fillStyle = v.dim(0.8); c.letterSpacing = '1.5px';
    c.fillText('HF ENERGY  高域', gx + gw - 118, gy + gh - 6); c.letterSpacing = '0px';
    // projected path (dashed) to 400 at bar 76
    if (v.t < T.fr) {
      c.strokeStyle = v.num(0.3); c.setLineDash([4, 6]); c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(X(v.t), Y(v.ratio)); c.lineTo(X(T.fr), Y(R1)); c.stroke(); c.setLineDash([]);
    }
    // onset ticks along the top (the hits that step the ratio)
    for (const [kt, s] of au.events('kick', T.s - 0.01, tEnd)) { c.fillStyle = v.num(0.25 + 0.6 * s); c.fillRect(X(kt) - 1, gy, 2, 5 + 8 * s); }
    for (const [st, s] of au.events('snare', T.s - 0.01, tEnd)) if (s > 0.3) { c.fillStyle = rgba('red', 0.9); c.fillRect(X(st) - 1, gy + gh - 10, 2, 10); }
    // the ratio curve: filled under with vertical hatch, bright line on top
    const pts: [number, number][] = [];
    const m = 320;
    for (let i = 0; i <= m; i++) { const tt = T.s + ((tEnd - T.s) * i) / m; pts.push([X(tt), Y(Math.min(this.ratioAt(tt), R1))]); }
    c.save();
    c.beginPath(); c.moveTo(pts[0]![0], gy + gh);
    for (const [x, y] of pts) c.lineTo(x, y);
    c.lineTo(pts[pts.length - 1]![0], gy + gh); c.closePath(); c.clip();
    c.fillStyle = v.frame(0.2);
    for (let x = gx; x < gx + gw; x += 4) c.fillRect(x, gy, 1, gh);
    c.restore();
    c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.strokeStyle = v.num(1); c.lineWidth = 2.5; c.lineJoin = 'miter'; c.stroke();
    // cursor
    const hx = X(tEnd), hy = Y(v.ratio);
    c.fillStyle = v.txt(0.6); c.fillRect(hx, gy, 1, gh);
    c.fillStyle = rgba('bone', 1); c.fillRect(hx - 5, hy - 5, 10, 10);
    c.font = font(F.mono(700), 12); c.fillStyle = v.num(1); c.letterSpacing = '1.5px';
    const lbl = v.roll ? scramble(`${v.ratio.toFixed(1)}%`, v.seed + 3, 0.5) : `${v.ratio.toFixed(1)}%`;
    c.textAlign = hx > gx + gw - 110 ? 'right' : 'left';
    c.fillText(lbl, hx + (c.textAlign === 'right' ? -12 : 12), hy - 10);
    c.textAlign = 'left'; c.letterSpacing = '0px';
  }

  // ================================================================ two heartbeats converging
  drawPulse(c: CanvasRenderingContext2D, v: V) {
    const au = this.ctx.audio;
    const r = panel(c, 1140, 122, 724, 330, { title: 'NEURAL PULSE', jp: '心拍同期', color: v.frame(1), cut: 16 });
    const gx = r.x, gy = r.y + 22, gw = r.w - 196, gh = r.h - 26;
    // legend
    c.font = font(F.mono(700), 11); c.letterSpacing = '2px'; c.textBaseline = 'alphabetic';
    c.fillStyle = v.num(1); c.fillRect(gx, r.y + 2, 18, 4); c.fillText('PILOT 01', gx + 26, r.y + 8);
    c.fillStyle = rgba('purple', 1); c.fillRect(gx + 130, r.y + 2, 18, 4);
    c.fillStyle = mix3('purple', 'bone', 0.35, 'red', 0); c.fillText('EVA-01', gx + 156, r.y + 8);
    c.letterSpacing = '0px'; c.font = jp(12, 700, false); c.fillStyle = v.txt(0.7); c.fillText('パイロット ／ 初号機', gx + 240, r.y + 8);
    // grid
    c.fillStyle = v.dim(0.1);
    for (let i = 0; i <= 20; i++) c.fillRect(gx + (gw * i) / 20, gy, 1, gh);
    for (let j = 0; j <= 6; j++) c.fillRect(gx, gy + (gh * j) / 6, gw, 1);
    const win = 2.4, kicks = au.events('kick', v.t - win - 0.5, v.t + 0.001).filter(([, s]) => s > 0.25);
    const midP = gy + gh * 0.36, midE = gy + gh * 0.36 + (gh * 0.3) * (1 - v.g), amp = gh * 0.3;
    const N = 360;
    const trace = (fn: (ts: number) => number, mid: number, col: string, lw: number) => {
      c.beginPath();
      for (let i = 0; i <= N; i++) {
        const ts = v.t - win * (1 - i / N), val = fn(ts);
        const x = gx + (gw * i) / N, y = mid - val * amp;
        if (i) c.lineTo(x, y); else c.moveTo(x, y);
      }
      c.strokeStyle = col; c.lineWidth = lw; c.lineJoin = 'round'; c.stroke();
    };
    const lag = (kt: number) => 0.17 * Math.pow(1 - clamp(this.gAt(kt)), 1.4);
    const evaFn = (ts: number) => { let s = 0; for (const [kt, st] of kicks) { const dt = ts - kt - lag(kt); if (dt > -0.1 && dt < 0.2) s += qrsEva(dt) * Math.min(1, st * 1.3) * (0.7 + 0.5 * v.g); } return s; };
    const pilFn = (ts: number) => { let s = au.waveAt(ts)[0] * 0.04; for (const [kt, st] of kicks) { const dt = ts - kt; if (dt > -0.12 && dt < 0.22) s += qrsPilot(dt) * Math.min(1, st * 1.3); } return s; };
    trace(evaFn, midE, rgba('purple', 1), 2.2);
    trace(pilFn, midP, v.g > 0.92 ? rgba('lime', 1) : v.num(1), 1.8);
    // the phase gap between the two newest R peaks
    const lastK = kicks.filter(([kt]) => kt <= v.t).pop();
    const ph = lastK ? lag(lastK[0]) : 0.17;
    if (lastK) {
      const xa = gx + gw * (1 - (v.t - lastK[0]) / win), xb = xa + (gw * ph) / win;
      if (xa > gx) {
        c.strokeStyle = v.txt(0.8); c.lineWidth = 1;
        c.beginPath(); c.moveTo(xa, gy + gh - 18); c.lineTo(xa, gy + gh - 6); c.moveTo(xb, gy + gh - 18); c.lineTo(xb, gy + gh - 6);
        c.moveTo(xa, gy + gh - 12); c.lineTo(xb, gy + gh - 12); c.stroke();
        c.font = font(F.mono(600), 10); c.fillStyle = v.txt(0.9); c.fillText(`Δ${Math.round(ph * 1000)}MS`, Math.min(xb, gx + gw - 60) + 6, gy + gh - 8);
      }
    }
    // readouts
    const rx = r.x + r.w - 180;
    c.fillStyle = v.frame(0.5); c.fillRect(rx - 12, r.y, 1, r.h);
    const strong = kicks.filter(([kt, s]) => s > 0.3 && kt <= v.t);
    const hr = strong.length >= 2 ? 60 / Math.max(0.12, strong[strong.length - 1]![0] - strong[strong.length - 2]![0]) : 72;
    const lbl = (y: number, en: string, jpT: string) => {
      c.font = font(F.mono(600), 11); c.letterSpacing = '2px'; c.fillStyle = v.txt(0.85); c.fillText(en, rx, y); c.letterSpacing = '0px';
      c.font = jp(12, 700, false); c.fillText(jpT, rx + 112, y);
    };
    const sv = (s: string) => (v.roll ? scramble(s, v.seed + 11, 0.5) : s);
    lbl(r.y + 12, 'HEART RATE', '心拍数');
    sevenSeg(c, sv(String(Math.round(Math.min(hr, 999))).padStart(3, ' ')), rx, r.y + 22, 44, v.num(1), v.dim(0.08));
    lbl(r.y + 104, 'PHASE Δ MS', '位相差');
    sevenSeg(c, sv(String(Math.round(ph * 1000)).padStart(3, '0')), rx, r.y + 114, 44, v.num(1), v.dim(0.08));
    lbl(r.y + 196, 'COHERENCE', '同期度');
    segMeter(c, rx, r.y + 206, 168, 14, 16, v.g, { color: v.num(1), hot: rgba('red', 1), hotFrom: 0.88, dim: v.dim(0.1) });
    c.font = font(F.mono(700), 13); c.fillStyle = v.num(1); c.letterSpacing = '2px';
    c.fillText(sv(`${(v.g * 100).toFixed(1)} %`), rx, r.y + 244);
    c.letterSpacing = '0px';
    const lk = lastK ? pulse(v.t, lastK[0], 0.07) : 0;
    c.fillStyle = rgba('red', 0.15 + 0.85 * lk); c.beginPath(); c.arc(rx + 160, r.y + 8, 5, 0, Math.PI * 2); c.fill();
    c.font = font(F.mono(600), 10); c.fillStyle = v.txt(0.6); c.letterSpacing = '1.5px';
    c.fillText('SRC: KICK ONSETS', rx, r.y + r.h - 4); c.letterSpacing = '0px';
  }

  // ================================================================ activation sequence
  drawSeq(c: CanvasRenderingContext2D, v: V) {
    const r = panel(c, 1140, 468, 724, 324, { title: 'ACTIVATION SEQUENCE', jp: '起動シーケンス', color: v.frame(1), cut: 16 });
    const rows = this.seq.filter((q) => q.t <= v.t).slice(-11);
    const lead = 25.5;
    c.textBaseline = 'alphabetic';
    rows.forEach((q, i) => {
      const y = r.y + 16 + i * lead, age = v.t - q.t;
      const idx = this.seq.indexOf(q) + 1;
      const fresh = age < 0.14;
      const stCol = q.st === 'red' ? rgba('red', 1) : q.st === 'warn' ? rgba('amber', 1) : q.st === 'live' ? v.num(1) : mix3('green', 'lime', v.creep, 'red', 0);
      if (fresh) { c.fillStyle = q.st === 'red' ? rgba('red', 0.85) : v.frame(0.75); c.fillRect(r.x - 4, y - 16, r.w + 8, 22); }
      const tc = fresh ? rgba('ink', 1) : v.txt(0.95);
      c.font = font(F.mono(600), 11); c.letterSpacing = '1px'; c.fillStyle = fresh ? tc : v.txt(0.45);
      c.fillText(`${String(idx).padStart(2, '0')} ${q.t < this.T.s ? '---.--' : q.t.toFixed(2).padStart(6, '0')}`, r.x, y);
      c.letterSpacing = '0px';
      c.font = jp(15, 700, false); c.fillStyle = q.st === 'red' && !fresh ? rgba('red', 1) : tc;
      const typed = Math.max(1, Math.ceil(clamp(age / 0.1) * q.jp.length));
      c.fillText(q.jp.slice(0, typed), r.x + 104, y);
      c.font = font(F.mono(600), 11); c.letterSpacing = '1.5px'; c.fillStyle = fresh ? tc : v.txt(0.65);
      c.fillText(q.en, r.x + 300, y); c.letterSpacing = '0px';
      // status chip
      let s = q.st === 'red' ? 'LOST' : q.st === 'warn' ? 'PASS' : q.st === 'live' ? `${v.ratio.toFixed(0)}%` : 'OK';
      if (q.en.startsWith('UNIT-01')) s = 'ERR';
      if (v.roll) s = scramble(s, v.seed + idx, 0.4);
      const chipOn = q.st === 'red' ? ((v.real * 4) % 1 < 0.6 ? 1 : 0.25) : 1;
      chamferPath(c, r.x + r.w - 76, y - 14, 76, 18, [0, 6, 0, 6]);
      c.fillStyle = fresh ? rgba('ink', 1) : stCol; c.globalAlpha *= chipOn; c.fill(); c.globalAlpha /= chipOn;
      c.fillStyle = fresh ? stCol : rgba('ink', 1); c.font = font(F.mono(700), 11); c.letterSpacing = '1.5px'; c.textAlign = 'center';
      c.fillText(s, r.x + r.w - 38, y - 1); c.textAlign = 'left'; c.letterSpacing = '0px';
    });
    // cursor
    if ((v.real * 3) % 1 < 0.6) { c.fillStyle = v.txt(0.9); c.fillRect(r.x, r.y + 16 + rows.length * lead - 12, 9, 14); }
  }

  // ================================================================ borderline countdown
  drawBorder(c: CanvasRenderingContext2D, v: V) {
    const T = this.T;
    const past = v.t >= this.cross100;
    const r = panel(c, 1140, 808, 354, 208, { title: past ? 'EGO BORDER' : 'BORDERLINE', jp: past ? '自我境界' : '絶対境界線', color: past ? rgba('red', 1) : v.frame(1), cut: 14 });
    // stage 1: distance to the absolute borderline (2.50 → 0), stage 2: to the ego border (3.00 → 0)
    const d = past ? (R1 - v.ratio) / 100 : ((100 - v.ratio) / (100 - R0)) * 2.5;
    const col = past ? rgba('red', 1) : v.num(1);
    c.font = font(F.mono(600), 11); c.letterSpacing = '2px'; c.fillStyle = v.txt(0.85); c.textBaseline = 'alphabetic';
    c.fillText(past ? 'DISTANCE TO EGO BORDER' : 'TO ABSOLUTE BORDERLINE', r.x, r.y + 10); c.letterSpacing = '0px';
    c.font = jp(13, 700, false); c.fillText(past ? '自我境界線まで' : '絶対境界線まで', r.x, r.y + 30);
    let s = Math.max(0, d).toFixed(2);
    if (v.roll) s = scramble(s, v.seed + 5, 0.6);
    sevenSeg(c, s, r.x, r.y + 42, 64, col, past ? rgba('red', 0.08) : v.dim(0.08));
    const done = v.t >= T.fr;
    c.font = jp(16, 800, false); c.fillStyle = done ? rgba('red', (v.real * 4) % 1 < 0.6 ? 1 : 0.3) : col;
    c.fillText(done ? '突破  BREACHED' : past ? '絶対境界線 突破済' : '接近中  APPROACHING', r.x, r.y + 138);
    segMeter(c, r.x, r.y + 150, r.w, 10, 24, clamp(1 - Math.max(0, d) / (past ? 3 : 2.5)), { color: col, hot: rgba('red', 1), hotFrom: 0.85, dim: v.dim(0.1) });
  }

  // ================================================================ harmonics bank
  drawHarmonics(c: CanvasRenderingContext2D, v: V) {
    const au = this.ctx.audio;
    au.melFrame(v.t, this.mel);
    const bad = v.ratio > 300;
    const r = panel(c, 1510, 808, 354, 208, { title: 'HARMONICS', jp: 'ハーモニクス', color: v.frame(1), cut: 14 });
    const n = 16, bw = (r.w - (n - 1) * 5) / n, hh = r.h - 40;
    for (let i = 0; i < n; i++) {
      let s = 0; for (let b = i * 4; b < i * 4 + 4; b++) s += this.mel[b]!;
      let lv = smoothstep(0.25, 1, s / 4) * (0.9 + 0.2 * v.kd);
      if (v.roll) lv = hash(v.seed, i) * 0.6 + 0.4;
      segMeter(c, r.x + i * (bw + 5), r.y + 4, bw, hh, 12, clamp(lv), { vertical: true, color: v.num(1), hot: rgba('red', 1), hotFrom: bad ? 0.4 : 0.84, dim: v.dim(0.1), gap: 2 });
    }
    c.font = font(F.mono(700), 11); c.letterSpacing = '1.5px'; c.textBaseline = 'alphabetic';
    c.fillStyle = bad ? rgba('red', (v.real * 4) % 1 < 0.6 ? 1 : 0.35) : mix3('green', 'lime', v.creep, 'red', 0);
    c.fillText(bad ? 'DEVIATION' : 'ALL NOMINAL', r.x, r.y + r.h - 12);
    c.letterSpacing = '0px'; c.font = jp(13, 700, false);
    c.fillText(bad ? '異常値' : '全て正常位置', r.x + 120, r.y + r.h - 12);
    c.font = font(F.mono(500), 10); c.fillStyle = v.txt(0.5); c.textAlign = 'right';
    c.fillText(`${hexData(Math.floor(v.t * 8), 4, 4)}`, r.x + r.w, r.y + r.h - 12); c.textAlign = 'left';
  }

  // ================================================================ the freeze card
  drawCard(c: CanvasRenderingContext2D, t: number, frozen: boolean, rollK: number, slam: number) {
    const au = this.ctx.audio, T = this.T;
    const lvl = au.env('mid', t); // the riser pumps through the dropout
    const k = frozen ? 0.72 + 0.28 * smoothstep(0.2, 0.7, lvl) : 1;
    const inv = slam > 0.45;
    const y0 = 372, h = 336;
    const purple = rgba('purple', 1), lime = rgba('lime', 1);
    c.globalAlpha = 1;
    c.fillStyle = inv ? lime : 'rgba(6,3,12,0.92)'; c.fillRect(0, y0, 1920, h);
    hazard(c, 0, y0, 1920, 18, (t - T.fr) * (frozen ? 0 : 400), inv ? rgba('ink', 1) : purple);
    hazard(c, 0, y0 + h - 18, 1920, 18, -(t - T.fr) * (frozen ? 0 : 400), inv ? rgba('ink', 1) : purple);
    c.globalAlpha = k;
    const fg = inv ? rgba('ink', 1) : lime;
    c.font = jp(200, 800, true); c.fillStyle = inv ? rgba('ink', 1) : rgba('bone', 1); c.textBaseline = 'alphabetic'; c.textAlign = 'right';
    c.fillText('同調率', 930, y0 + 250);
    c.textAlign = 'left';
    let num = '400%';
    if (!frozen) { const sd = Math.floor(frameIdx(t) / 2); num = hash(sd, 21) < 0.15 + 0.3 * rollK ? scramble(num, sd, 0.3) : num; }
    condensed(c, num, 978, y0 + 262, 330, { sx: 0.58, color: fg, bold: 0.03 });
    c.globalAlpha = 1;
    c.font = font(F.mono(700), 15); c.letterSpacing = '4px'; c.fillStyle = inv ? rgba('ink', 1) : purple; c.textAlign = 'center';
    c.fillText('SYNCHRONIZATION RATIO 400 %   //   EGO BORDER BREACHED   //   自我境界線 突破', 960, y0 + h - 34);
    c.letterSpacing = '0px'; c.textAlign = 'left';
    // hold chip + frozen timecode
    const bl = (t * 2.2) % 1 < 0.6;
    chamferPath(c, 64, y0 + 34, 250, 34, [0, 12, 0, 0]);
    c.fillStyle = frozen ? (bl ? purple : rgba('purple', 0.35)) : rgba('red', 1); c.fill();
    c.fillStyle = rgba('ink', 1); c.font = font(F.mono(700), 14); c.letterSpacing = '3px'; c.textBaseline = 'middle';
    c.fillText(frozen ? 'SIGNAL HOLD' : 'SIGNAL ERROR', 78, y0 + 52); c.letterSpacing = '0px';
    c.font = jp(16, 800, false); c.fillText(frozen ? '静止' : '異常', 262, y0 + 52);
    c.textBaseline = 'alphabetic';
    c.font = font(F.mono(600), 13); c.letterSpacing = '2.4px'; c.fillStyle = frozen ? purple : rgba('red', 1); c.textAlign = 'right';
    c.fillText(frozen ? `FRAME HELD @ ${T.fr.toFixed(2)}  //  BAR 076` : `BAR 077  //  ${scramble('ROLLBACK', Math.floor(frameIdx(t) / 3), 0.4)}`, 1856, y0 + 58);
    c.letterSpacing = '0px'; c.textAlign = 'left';
  }
}
