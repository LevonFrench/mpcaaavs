// Ported from bizarro/evangelion app/src/scenes/psycho.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// psycho — "PSYCHOGRAPH" (groove 1 cont., bars 7–13, 17.42 – 28.22 s; bar 12 = one-bar break).
// The pilots' psychograph monitor: six green-phosphor EEG strips written by a sweep cursor that
// crosses the screen once per bar (the trace ahead of the cursor is last bar's, dimmed by phosphor
// persistence, with an erase gap before the head). The channels are real audio (psycho-kit.ts):
// α = the mix waveform, PULSE = an ECG complex on every kick, θ = the bass stem at its pitch,
// β = the highs ringing on the hats, γ = the pads, δ = a red spike on every clap.
// Left: three pilot cards (sync ratio from their two channels) and a delay-embedded phase portrait
// of the real waveform (the "psyche attractor") with persistence. Right: a chroma "mental graph"
// 12-gon with ghost polygons, the A10 nerve-link meters per channel and the monitor status with an
// event log. Bottom: a green mel waterfall. Bar 12 (26.42, the pad-swell break): every channel is
// written flat, only a weak pulse survives, the flatlines throb on the hats, "SIGNAL LOST 信号途絶"
// blinks; the last beat resyncs (amber, jitter ramping back) into the next plate.
import * as THREE from 'three';
import { Scene, type Frame, type PostOverrides } from '../../show/scene.ts';
import { FSPass, Layer2D } from '../../show/gl.ts';
import { LIN, rgba } from '../../show/palette.ts';
import { F, font } from '../../show/type.ts';
import { clamp, ease, frameIdx, hash, prog, pulse, smoothstep } from '../../show/util.ts';
import { SPECTRUM_GLSL, spectrumUniforms } from '../../show/spectrum.ts';
import { barTime, chamferPath, condensed, duck, hazard, hexPath, jp, makeScanPass, hexData, panel, sevenSeg, songBar, GLSL_EVA } from './_eva.ts';
import { chrome, makeHexGround, meta } from './magi-hud.ts';
import { NCH, buildBank, peakAbs, segMeterA, span, type Bank } from './psycho-kit.ts';

// trace area of the psychograph (logical px, y down)
const TR = { x: 606, y: 214, w: 780, h: 672 };
const SH = TR.h / NCH; // strip height
const NCOL = TR.w;
const WF = { x: 614, y: 948, w: 862, h: 58 }; // waterfall
const WF_WIN = 3.6;
const GAP = 0.07; // erase gap ahead of the write head (s)
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const CH = [
  { id: 'α-WAVE', jp: 'アルファ波', src: 'SIGNAL MIX', pilot: 1 },
  { id: 'PULSE', jp: '心拍', src: 'KICK', pilot: 1 },
  { id: 'θ-WAVE', jp: 'シータ波', src: 'BASS STEM', pilot: 2 },
  { id: 'β-WAVE', jp: 'ベータ波', src: 'HIGH BAND', pilot: 2 },
  { id: 'γ-WAVE', jp: 'ガンマ波', src: 'PAD STEM', pilot: 3 },
  { id: 'δ-SPIKE', jp: '刺激反応', src: 'CLAP', pilot: 3 },
];
const PILOTS = [
  { no: '01', name: 'IKARI SHINJI', jp: '碇 シンジ', unit: 'EVA-01', ujp: '初号機', base: 41.3 },
  { no: '02', name: 'SOHRYU ASUKA', jp: '惣流 アスカ', unit: 'EVA-02', ujp: '弐号機', base: 58.8 },
  { no: '03', name: 'AYANAMI REI', jp: '綾波 レイ', unit: 'EVA-00', ujp: '零号機', base: 36.2 },
];

const FRAG = /* glsl */ `
${SPECTRUM_GLSL}
${GLSL_EVA}
uniform sampler2D uData;
uniform float t, uHead, uBrk, uRes, uThrob, uDuck, uIn, uClap;
uniform vec4 uR, uWf, uMask;
const int NCOL = ${NCOL};
const float SH = ${SH.toFixed(3)};

vec4 colAt(int x, int ch) { return texelFetch(uData, ivec2(clamp(x, 0, NCOL - 1), ch), 0); }

void main() {
  vec2 p = vec2(FRAG_PX.x, 1080.0 - FRAG_PX.y);
  vec3 col = vec3(0.0);
  vec3 G = C_GREEN;
  vec3 hot = mix(C_GREEN, C_AMBER, uRes);

  // ------------------------------------------------ psychograph strips
  vec2 q = p - uR.xy;
  if (q.x >= 0.0 && q.x < uR.z && q.y >= 0.0 && q.y < uR.w) {
    int ch = int(q.y / SH);
    float ly = q.y - float(ch) * SH;
    float cy = SH * 0.5, amp = SH * 0.5 - 10.0;
    // graticule: beat lines, 16th dots, centre dashes, strip rules
    float bw = uR.z / 4.0, sw = uR.z / 16.0;
    float gx = abs(mod(q.x + 0.5, bw) - 0.5);
    float g16 = abs(mod(q.x + 0.5, sw) - 0.5);
    float gy = abs(ly - cy);
    float grid = pxLine(gx, 0.3, 1.1) * 0.10;
    grid += pxLine(g16, 0.3, 1.0) * step(mod(ly, 6.0), 1.2) * 0.07;
    grid += pxLine(gy, 0.3, 1.0) * step(mod(q.x, 8.0), 4.0) * 0.12;
    grid += pxLine(abs(ly - cy + amp), 0.3, 1.0) * step(mod(q.x, 4.0), 1.0) * 0.06;
    grid += pxLine(abs(ly - cy - amp), 0.3, 1.0) * step(mod(q.x, 4.0), 1.0) * 0.06;
    grid += pxLine(min(ly, SH - ly), 0.3, 1.0) * 0.14;
    col += G * grid * uIn;

    // trace: vertical spans per column, distance to the nearest span within ±3 px
    int x = int(q.x);
    float best = 1e9, bAge = 9.0, bAmp = 0.0;
    for (int k = -3; k <= 3; k++) {
      vec4 a = colAt(x + k, ch);
      if (a.w < 0.5) continue;
      vec4 b = colAt(x + k - 1, ch);
      float lo = a.x, hi = a.y;
      if (b.w > 0.5) { float m = 0.5 * (b.x + b.y); lo = min(lo, m); hi = max(hi, m); }
      float top = cy - hi * amp, bot = cy - lo * amp;
      float dy = max(max(top - ly, ly - bot), 0.0);
      float d = length(vec2(float(k), dy));
      if (d < best) { best = d; bAge = a.z; bAmp = max(abs(a.x), abs(a.y)); }
    }
    if (best < 1e8) {
      float pers = mix(0.1, 1.0, exp(-bAge / 0.6));
      float head = exp(-bAge / 0.045);
      float bright = pers * (1.0 - 0.22 * uDuck) + head * 1.4;
      bright *= 1.0 + uBrk * uThrob * 1.6;
      vec3 tc = G;
      if (ch == 5) tc = mix(G, C_RED, smoothstep(0.12, 0.4, bAmp));
      tc = mix(tc, hot, uRes * 0.8);
      float core = pxLine(best, 0.55, 1.5);
      float glow = exp(-best * 0.45) * 0.28 + exp(-best * 0.12) * 0.05;
      col += tc * (core * 0.95 + glow) * bright * uIn;
    }
    // write head: bright bar + erase-gap shading
    float dh = q.x - uHead;
    col += hot * (pxLine(abs(dh), 0.5, 1.6) * 0.9 + exp(-abs(dh) * 0.25) * 0.08) * uIn;
    if (dh > 0.0) col *= mix(0.25, 1.0, smoothstep(0.0, 40.0, dh));
    // clap: the δ strip washes red
    if (ch == 5) col += C_RED * uClap * 0.09 * (1.0 - smoothstep(0.0, SH * 0.5, abs(ly - cy)) * 0.5) * uIn;
    // occluded by the break overlay box
    if (p.x > uMask.x && p.x < uMask.x + uMask.z && p.y > uMask.y && p.y < uMask.y + uMask.w) col = vec3(0.0);
  }

  // ------------------------------------------------ mel waterfall (time →, bands ↑)
  vec2 w = p - uWf.xy;
  if (w.x >= 0.0 && w.x < uWf.z && w.y >= 0.0 && w.y < uWf.w) {
    float cwid = 3.0, rh = uWf.w / 16.0;
    float ci = floor(w.x / cwid), ri = floor((uWf.w - w.y) / rh);
    float tc = t - ${WF_WIN.toFixed(2)} * (1.0 - (ci + 0.5) * cwid / uWf.z);
    float band = ri * 4.0 + 1.5;
    float e = smoothstep(0.35, 1.0, melAt(tc, band));
    float cell = step(mod(w.x, cwid), cwid - 1.0) * step(1.0, mod(uWf.w - w.y, rh));
    float age = (t - tc) / ${WF_WIN.toFixed(2)};
    vec3 wc = e > 0.93 ? C_AMBER : G;
    col += wc * cell * (0.05 + e * e * (1.0 - 0.6 * age) * 0.95) * uIn;
    if (t - tc < 0.04) col += G * cell * 0.25;
  }
  fragColor = vec4(col, 1.0);
}`;

export default class Psycho extends Scene {
  L = new Layer2D();
  ground = makeHexGround(38);
  scan = makeScanPass(0.24);
  trace: FSPass;
  data = new Float32Array(NCOL * NCH * 4);
  tex: THREE.DataTexture;
  bank!: Bank;
  T = { s: 0, e: 0, b12: 0, b13: 0 };
  hats: number[] = [];
  ev: { t: number; kind: 'kick' | 'clap' | 'hat'; s: number }[] = [];
  ch = new Float32Array(12);
  mask: number[] = [0, 0, 0, 0];

  constructor(ctx: ConstructorParameters<typeof Scene>[0]) {
    super(ctx);
    this.tex = new THREE.DataTexture(this.data, NCOL, NCH, THREE.RGBAFormat, THREE.FloatType);
    this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter;
    this.tex.generateMipmaps = false;
    this.trace = new FSPass(FRAG, {
      uData: { value: this.tex }, t: { value: 0 }, uHead: { value: 0 }, uBrk: { value: 0 }, uRes: { value: 0 }, uThrob: { value: 0 },
      uDuck: { value: 0 }, uIn: { value: 1 }, uClap: { value: 0 },
      uR: { value: new THREE.Vector4(TR.x, TR.y, TR.w, TR.h) }, uMask: { value: new THREE.Vector4(0, 0, 0, 0) }, uWf: { value: new THREE.Vector4(WF.x, WF.y, WF.w, WF.h) },
      ...spectrumUniforms(ctx.spectrum),
    }, { blending: THREE.AdditiveBlending, transparent: true });
  }

  override init() {
    const au = this.ctx.audio, s = this.ctx.start, e = this.ctx.end;
    this.T = { s, e, b12: barTime(au, 12), b13: barTime(au, 13) };
    this.bank = buildBank(au, barTime(au, 5) - 0.2, e + 0.4, this.T.b12, this.T.b13);
    this.hats = au.events('hat', s - 4, e).map((h) => h[0]);
    const ev: typeof this.ev = [];
    for (const [kt, st] of au.events('kick', s - 4, e)) if (st > 0.15) ev.push({ t: kt, kind: 'kick', s: st });
    for (const [ct, st] of au.events('snare', s - 4, e)) ev.push({ t: ct + 0.001, kind: 'clap', s: st });
    for (const [ht, st] of au.events('hat', s - 4, e)) ev.push({ t: ht, kind: 'hat', s: st });
    this.ev = ev.sort((a, b) => a.t - b.t);
  }

  /** Sweep geometry at t: current bar start/end, previous bar start. */
  sweep(t: number) {
    const au = this.ctx.audio;
    const k = Math.floor(songBar(au, t) + 1e-6);
    return { k, b0: barTime(au, k), b1: barTime(au, k + 1), bp: barTime(au, k - 1) };
  }

  fillData(t: number) {
    const { b0, b1, bp } = this.sweep(t);
    const P = b1 - b0, Pp = b0 - bp, D = this.data, o: [number, number] = [0, 0];
    for (let x = 0; x < NCOL; x++) {
      const u0 = x / NCOL, u1 = (x + 1) / NCOL;
      let ta = b0 + u0 * P, tb = b0 + u1 * P, valid = 1;
      if (tb > t) {
        if (ta < t + GAP) valid = ta <= t ? 1 : 0; // the head column / erase gap
        if (ta > t) { ta = bp + u0 * Pp; tb = bp + u1 * Pp; }
        else tb = t;
      }
      const age = t - tb;
      for (let c = 0; c < NCH; c++) {
        span(this.bank, c, ta, tb, o);
        const i = (c * NCOL + x) * 4;
        D[i] = o[0]; D[i + 1] = o[1]; D[i + 2] = age; D[i + 3] = valid;
      }
    }
    this.tex.needsUpdate = true;
    return (t - b0) / P;
  }

  render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides {
    const { renderer, audio: au, comp } = this.ctx;
    const T = this.T, t = f.t, lt = t - T.s;
    const dk = duck(f, au);
    const clap = au.hit('snare', t, 0.1);
    const hatHit = au.hit('hat', t, 0.07);
    const hatN = this.hats.filter((h) => h <= t).length;
    const inBrk = t >= T.b12 && t < T.b13;
    const lb = T.b13 - 0.45;
    const res = t >= lb && t < T.b13 ? clamp((t - lb) / 0.45) : 0; // resync (last beat of the break)
    const brk = inBrk ? 1 - res : 0;
    const beatPh = inBrk ? ((t - T.b12) / 0.45) % 1 : 0;
    const throb = inBrk ? Math.max(0.55 * Math.exp(-beatPh * 5), hatHit) : 0;

    // ---- ground
    this.ground.u.t!.value = t; this.ground.u.k!.value = dk * 0.6 + f.a.kick * 0.4; this.ground.u.seed!.value = hatN;
    this.ground.u.a!.value = 0.05; this.ground.u.col!.value = inBrk ? LIN.red.map((v) => v * 0.7) : [...LIN.orange];
    this.ground.render(renderer, out);

    const L = this.L; L.clear();
    const c = L.ctx;
    const on = (g: number) => {
      const p = (lt - g * 0.05) / 0.22;
      if (p >= 1) return 1;
      if (p <= 0) return 0;
      return hash(frameIdx(t), g, 7) < p ? 1 : 0.15;
    };
    const G = (a: number) => rgba('green', a);
    const O = (a: number) => rgba('orange', a);
    const stateCol = inBrk ? (res > 0 ? 'amber' : 'red') : 'green';

    chrome(c, t, au, {
      no: '03', en: 'PSYCHOGRAPH', jpText: '心理グラフ 精神波形',
      sub: 'PILOT MENTAL STATE MONITOR  //  3 PILOTS  6 CHANNELS  //  搭乗者精神状態監視',
      reveal: prog(lt, 0, 0.3, ease.outCubic),
      tick: 'PSYCHOGRAPH DISPLAY // A10 NERVE CONNECTION MONITOR // 神経接続 // PILOT 01 02 03 // SWEEP = 1 BAR 1.80 S // 心理グラフ // MENTAL CONTAMINATION CHECK // 精神汚染 // NERV 第一発令所',
    });

    // ===================================================== centre: the psychograph
    const head = this.fillData(t);
    c.globalAlpha = on(0);
    const hdrCol = clap > 0.5 && !inBrk ? rgba('red', 1) : inBrk ? rgba(stateCol, 1) : G(1);
    panel(c, 424, 120, 1072, 782, { title: 'PSYCHOGRAPH DISPLAY', jp: '心理グラフ', cut: 22, color: hdrCol });
    {
      const sw = this.sweep(t);
      c.font = font(F.mono(600), 12); c.letterSpacing = '2px'; c.textAlign = 'right'; c.fillStyle = G(0.85);
      c.fillText(`6 CH  //  SWEEP ${String(sw.k).padStart(3, '0')}  //  ${(sw.b1 - sw.b0).toFixed(2)} S/SWEEP  //  ±1.0 U/DIV`, 1476, 141);
      c.letterSpacing = '0px'; c.textAlign = 'left';
      // time ruler above the strips
      const ry = TR.y - 14;
      c.fillStyle = G(0.6); c.fillRect(TR.x, ry, TR.w, 1);
      for (let i = 0; i <= 16; i++) {
        const x = TR.x + (TR.w * i) / 16, mj = i % 4 === 0;
        c.fillStyle = G(mj ? 0.85 : 0.4); c.fillRect(x, ry - (mj ? 10 : 5), 1, mj ? 10 : 5);
        if (mj && i < 16) { c.font = font(F.mono(700), 11); c.fillText(`${i / 4 + 1}`, x + 5, ry - 3); }
      }
      c.font = font(F.mono(600), 10); c.fillStyle = G(0.6); c.letterSpacing = '1.5px';
      c.fillText('BEAT', TR.x - 44, ry - 3); c.letterSpacing = '0px';
      // head marker
      const hx = TR.x + head * TR.w;
      c.fillStyle = stateCol === 'green' ? G(1) : rgba(stateCol, 1);
      c.beginPath(); c.moveTo(hx - 7, ry - 16); c.lineTo(hx + 7, ry - 16); c.lineTo(hx, ry - 6); c.closePath(); c.fill();
      c.fillRect(TR.x, TR.y + TR.h + 6, TR.w * head, 3);
      c.fillStyle = G(0.15); c.fillRect(TR.x + TR.w * head, TR.y + TR.h + 6, TR.w * (1 - head), 3);

      // per-strip labels (left) and readouts (right)
      for (let i = 0; i < NCH; i++) {
        const y = TR.y + i * SH, C = CH[i]!;
        const pk = peakAbs(this.bank, i, t, 0.08);
        const dead = inBrk && res === 0 && i !== 1;
        const lc = dead ? rgba('red', 0.9) : i === 5 && pk > 0.3 ? rgba('red', 1) : G(1);
        // channel hex badge
        hexPath(c, 452, y + 30, 14); c.strokeStyle = lc; c.lineWidth = 1.5; c.stroke();
        hexPath(c, 452, y + 30, 9); c.fillStyle = dead ? rgba('red', 0.25 + 0.5 * throb) : G(0.12 + 0.8 * clamp(pk * 1.3)); c.fill();
        c.fillStyle = pk > 0.5 && !dead ? rgba('ink', 1) : lc; c.font = font(F.mono(700), 11); c.textAlign = 'center';
        c.fillText(`${i + 1}`, 452, y + 34); c.textAlign = 'left';
        c.fillStyle = lc; c.font = font(F.mono(700), 14); c.letterSpacing = '2px';
        c.fillText(C.id, 474, y + 28); c.letterSpacing = '0px';
        c.font = jp(13, 600, false); c.fillStyle = dead ? rgba('red', 0.8) : G(0.75); c.fillText(C.jp, 474, y + 48);
        c.font = font(F.mono(500), 10); c.letterSpacing = '1.5px'; c.fillStyle = G(0.55);
        c.fillText(`PILOT 0${C.pilot}`, 444, y + 72);
        c.fillText(C.src, 444, y + 86); c.letterSpacing = '0px';
        if (dead) { c.fillStyle = rgba('red', 0.5 + 0.5 * throb); c.font = font(F.mono(700), 10); c.letterSpacing = '1.5px'; c.fillText('NO SIGNAL', 444, y + 100); c.letterSpacing = '0px'; }
        // right readout
        const rx = 1398;
        c.fillStyle = lc; c.font = font(F.mono(700), 17);
        c.fillText(dead ? '-.--' : pk.toFixed(2), rx, y + 32);
        c.font = font(F.mono(500), 10); c.fillStyle = G(0.55); c.letterSpacing = '1.5px';
        c.fillText('PK U', rx + 50, y + 32);
        let sub = '';
        if (i === 2) { const m = au.bassMidi(t); sub = m > 0 ? `${NOTES[Math.round(m) % 12]}${Math.floor(Math.round(m) / 12) - 1} ${(440 * Math.pow(2, (m - 69) / 12)).toFixed(1)}` : 'F0 --.-'; }
        else if (i === 1) { const bpm = 60 / 0.6; sub = `${inBrk ? '---' : bpm.toFixed(0)} BPM`; }
        else sub = ['8-13 HZ', '', '', '13-30 HZ', '30+ HZ', 'STIM'][i]!;
        c.fillText(sub, rx, y + 50); c.letterSpacing = '0px';
        segMeterA(c, rx, y + 62, 78, 7, 12, dead ? 0 : clamp(pk * 1.1), { color: i === 5 ? rgba('red', 1) : G(1), hot: rgba('red', 1), hotFrom: 0.84, dim: G(0.1), gap: 2 });
        // gain marks at the strip edge
        c.fillStyle = G(0.5); c.font = font(F.mono(500), 9); c.textAlign = 'right';
        c.fillText('+1', TR.x - 6, y + 13); c.fillText('0', TR.x - 6, y + SH / 2 + 3); c.fillText('-1', TR.x - 6, y + SH - 6); c.textAlign = 'left';
      }
      // break overlay
      if (inBrk) {
        const bx = TR.x + TR.w / 2 - 250, by = TR.y + SH * 2 + 6, bw = 500, bh = SH * 2 - 12;
        this.mask = [bx + 2, by + 2, bw - 4, bh - 4];
        const bl = res > 0 ? 1 : 0.35 + 0.65 * Math.max(throb, ((t - T.b12) * 4.444) % 1 < 0.5 ? 1 : 0);
        const col = res > 0 ? 'amber' : 'red';
        chamferPath(c, bx, by, bw, bh, 16);
        c.fillStyle = res > 0 ? 'rgba(40,24,0,0.86)' : `rgba(34,0,0,${0.7 + 0.2 * bl})`; c.fill();
        c.strokeStyle = rgba(col, 1); c.lineWidth = 3; c.stroke();
        hazard(c, bx + 10, by + 10, bw - 20, 14, (t - T.b12) * 60, rgba(col, 0.9));
        hazard(c, bx + 10, by + bh - 24, bw - 20, 14, -(t - T.b12) * 60, rgba(col, 0.9));
        c.globalAlpha = on(0) * bl;
        condensed(c, res > 0 ? 'RESYNC' : 'SIGNAL LOST', bx + bw / 2, by + bh * 0.58, 82, { sx: 0.58, color: rgba(col, 1), align: 'center' });
        c.font = jp(20, 800, false); c.fillStyle = rgba(col, 1); c.textAlign = 'center';
        c.fillText(res > 0 ? '再同調  神経接続 回復' : '信号途絶  心理グラフ 反応消失', bx + bw / 2, by + bh * 0.74);
        c.textAlign = 'left';
        c.globalAlpha = on(0);
        if (res > 0) segMeterA(c, bx + 40, by + bh - 44, bw - 80, 8, 30, res, { color: rgba('amber', 1), hotFrom: 2, dim: rgba('amber', 0.12) });
      }
    }

    // ===================================================== bottom: mel waterfall
    c.globalAlpha = on(4);
    const wp = panel(c, 424, 916, 1072, 100, { title: 'SPECTRAL DENSITY', jp: '周波数密度', header: 24, cut: 14, color: G(1) });
    meta(c, wp.x + 4, wp.y + 14, [['MEL', '16 BANDS'], ['SPAN', '2 BARS'], ['FLOOR', `${(-48 + 10 * f.a.rms).toFixed(1)} DB`]], { size: 11, lead: 17, keyW: 52, color: G(0.9) });
    c.fillStyle = G(0.8); c.font = font(F.mono(600), 10); c.letterSpacing = '1.5px'; c.textAlign = 'right';
    c.fillText('16K', WF.x - 6, WF.y + 9); c.fillText('30', WF.x - 6, WF.y + WF.h); c.textAlign = 'left'; c.letterSpacing = '0px';
    c.fillStyle = rgba('amber', 0.9); c.fillRect(WF.x + WF.w - 1, WF.y - 4, 2, WF.h + 8);

    // ===================================================== left: pilot cards
    const sm = (name: string) => { let s = 0; for (let k = 0; k < 8; k++) s += au.env(name, t - k * 0.06); return s / 8; };
    const syn = [
      PILOTS[0]!.base + 22 * sm('drums') + 8 * sm('rms'),
      PILOTS[1]!.base + 18 * sm('bass') + 10 * sm('high'),
      PILOTS[2]!.base + 26 * sm('other') + 6 * sm('drums'),
    ];
    for (let p = 0; p < 3; p++) {
      c.globalAlpha = on(1 + p);
      const P = PILOTS[p]!, y = 120 + p * 162;
      const lost = inBrk && res === 0;
      const pc = lost ? rgba('red', 1) : G(1);
      const r = panel(c, 56, y, 344, 150, { title: `PILOT ${P.no}`, jp: P.jp, cut: 16, header: 28, color: p === 0 ? O(1) : O(1) });
      c.fillStyle = O(1); c.font = font(F.mono(700), 13); c.letterSpacing = '2px';
      c.fillText(P.name, r.x, r.y + 12); c.letterSpacing = '0px';
      c.font = font(F.mono(500), 11); c.fillStyle = O(0.7); c.letterSpacing = '1.5px';
      c.fillText(`${P.unit}`, r.x, r.y + 32); c.letterSpacing = '0px';
      c.font = jp(13, 600, false); c.fillText(P.ujp, r.x + 58, r.y + 32);
      c.font = font(F.mono(500), 10); c.fillStyle = O(0.6); c.letterSpacing = '1.5px';
      c.fillText('SYNC RATIO  同調率', r.x, r.y + 56); c.letterSpacing = '0px';
      const v = lost ? syn[p]! * (0.2 + 0.1 * throb) : syn[p]!;
      const txt = v.toFixed(1).padStart(4, '0');
      const sw7 = sevenSeg(c, txt, r.x + 150, r.y + 2, 42, pc, G(0.07), { thick: 5 });
      c.fillStyle = pc; c.font = font(F.mono(700), 16); c.fillText('%', r.x + 156 + sw7, r.y + 42);
      segMeterA(c, r.x, r.y + 66, r.w, 9, 32, clamp(v / 100), { color: pc, hot: rgba('amber', 1), hotFrom: 0.7, dim: G(0.08), gap: 2 });
      // nerve link lamp
      const lampOn = lost ? throb > 0.4 : true;
      c.fillStyle = lampOn ? pc : rgba('blood', 0.6);
      chamferPath(c, r.x + r.w - 104, r.y + 80, 104, 18, [0, 6, 0, 6]); c.fill();
      c.fillStyle = rgba('ink', 1); c.font = jp(12, 800, false); c.textAlign = 'center';
      c.fillText(lost ? '神経接続 途絶' : '神経接続 良好', r.x + r.w - 52, r.y + 94); c.textAlign = 'left';
      c.fillStyle = O(0.55); c.font = font(F.mono(500), 10); c.letterSpacing = '1.2px';
      c.fillText(`CH ${p * 2 + 1}+${p * 2 + 2}  ${hexData(p, Math.floor(t * 4.444))}`, r.x, r.y + 94); c.letterSpacing = '0px';
    }

    // ===================================================== left: phase portrait
    c.globalAlpha = on(4);
    const lp = panel(c, 56, 606, 344, 410, { title: 'PHASE MAP', jp: '位相図', cut: 16, color: G(1) });
    {
      const cx = lp.x + lp.w / 2, cy = lp.y + 150, R = 142;
      c.strokeStyle = G(0.16); c.lineWidth = 1;
      c.beginPath();
      for (let i = -4; i <= 4; i++) { c.moveTo(cx - R, cy + (R * i) / 4); c.lineTo(cx + R, cy + (R * i) / 4); c.moveTo(cx + (R * i) / 4, cy - R); c.lineTo(cx + (R * i) / 4, cy + R); }
      c.stroke();
      c.strokeStyle = G(0.4);
      c.beginPath(); c.moveTo(cx - R, cy); c.lineTo(cx + R, cy); c.moveTo(cx, cy - R); c.lineTo(cx, cy + R); c.stroke();
      c.beginPath(); c.arc(cx, cy, R * 0.5, 0, Math.PI * 2); c.stroke();
      c.strokeStyle = G(0.7); c.lineWidth = 1.5;
      c.strokeRect(cx - R, cy - R, R * 2, R * 2);
      for (let i = 0; i <= 16; i++) { const x = cx - R + (2 * R * i) / 16; c.fillStyle = G(0.6); c.fillRect(x, cy + R, 1, i % 4 ? 3 : 7); c.fillRect(cx - R - (i % 4 ? 3 : 7), cy - R + (2 * R * i) / 16, i % 4 ? 3 : 7, 1); }
      // delay embedding of the real mix: x = s(τ), y = s(τ − δ); δ = a quarter bass period
      const m = au.bassMidi(t), f0 = m > 0 ? 440 * Math.pow(2, (m - 69) / 12) : 55;
      const dl = 1 / (4 * f0), smp: [number, number] = [0, 0];
      const S = (tt: number) => { let v = 0; for (let j = 0; j < 10; j++) { au.waveAt(tt + (j - 4.5) * 0.0004, smp); v += smp[0] + smp[1]; } return v / 20; };
      c.save(); c.beginPath(); c.rect(cx - R, cy - R, 2 * R, 2 * R); c.clip();
      const gain = R * 1.15;
      for (let k = 5; k >= 0; k--) {
        const te = t - k * 0.03, win = 0.07, N = 300;
        c.strokeStyle = k === 0 ? rgba(stateCol === 'green' ? 'green' : stateCol, 1) : G(0.5 * Math.pow(0.62, k));
        c.lineWidth = k === 0 ? 1.7 : 1.2;
        c.beginPath();
        for (let i = 0; i <= N; i++) {
          const tt = te - win + (win * i) / N;
          const px = cx + clamp(S(tt) * 1.1, -1.2, 1.2) * gain * 0.8, py = cy - clamp(S(tt - dl) * 1.1, -1.2, 1.2) * gain * 0.8;
          if (i) c.lineTo(px, py); else c.moveTo(px, py);
        }
        c.stroke();
      }
      c.restore();
      if (inBrk && res === 0) {
        c.strokeStyle = rgba('red', 0.3 + 0.7 * throb); c.lineWidth = 1.5;
        c.beginPath(); c.arc(cx, cy, 16 + 40 * beatPh, 0, Math.PI * 2); c.stroke();
        c.fillStyle = rgba('red', 0.5 + 0.5 * throb); c.font = font(F.mono(700), 12); c.letterSpacing = '2px'; c.textAlign = 'center';
        c.fillText('NO RESPONSE', cx, cy - 64); c.font = jp(13, 700, false); c.letterSpacing = '0px'; c.fillText('無反応', cx, cy + 76); c.textAlign = 'left';
      }
      meta(c, lp.x + 4, cy + R + 30, [
        ['DELAY', `${(dl * 1000).toFixed(2)} MS  (λ/4)`],
        ['F0', m > 0 ? `${f0.toFixed(1)} HZ  ${NOTES[Math.round(m) % 12]}${Math.floor(Math.round(m) / 12) - 1}` : '--.- HZ  UNVOICED'],
        ['ENERGY', `${(20 * Math.log10(Math.max(1e-3, f.a.rms))).toFixed(1)} DB`],
      ], { size: 11, lead: 18, keyW: 62, color: G(0.9) });
      c.font = jp(13, 600, false); c.fillStyle = G(0.7); c.textAlign = 'right';
      c.fillText('精神位相 アトラクタ', lp.x + lp.w, cy + R + 30); c.textAlign = 'left';
    }

    // ===================================================== right: mental graph (chroma 12-gon)
    c.globalAlpha = on(5);
    const mp = panel(c, 1520, 120, 344, 392, { title: 'MENTAL MAP', jp: '精神', cut: 16, color: G(1) });
    {
      const cx = mp.x + mp.w / 2, cy = mp.y + 150, R = 118;
      const ang = (k: number) => -Math.PI / 2 + (k / 12) * Math.PI * 2;
      c.strokeStyle = G(0.2); c.lineWidth = 1;
      for (let r = 1; r <= 4; r++) {
        c.beginPath();
        for (let k = 0; k <= 12; k++) { const a = ang(k), x = cx + Math.cos(a) * R * r / 4, y = cy + Math.sin(a) * R * r / 4; if (k) c.lineTo(x, y); else c.moveTo(x, y); }
        c.stroke();
      }
      c.beginPath();
      for (let k = 0; k < 12; k++) { const a = ang(k); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); }
      c.stroke();
      c.font = font(F.mono(600), 10); c.textAlign = 'center'; c.textBaseline = 'middle';
      au.chroma(t, this.ch);
      let top = 0; for (let k = 1; k < 12; k++) if (this.ch[k]! > this.ch[top]!) top = k;
      for (let k = 0; k < 12; k++) { const a = ang(k); c.fillStyle = k === top ? rgba('amber', 1) : G(0.7); c.fillText(NOTES[k]!, cx + Math.cos(a) * (R + 15), cy + Math.sin(a) * (R + 15)); }
      c.textBaseline = 'alphabetic';
      const cr = new Float32Array(12);
      for (let g = 4; g >= 0; g--) {
        au.chroma(t - g * 0.12, cr);
        c.beginPath();
        for (let k = 0; k <= 12; k++) { const a = ang(k % 12), v = 0.12 + 0.88 * Math.pow(cr[k % 12]!, 1.3); const x = cx + Math.cos(a) * R * v, y = cy + Math.sin(a) * R * v; if (k) c.lineTo(x, y); else c.moveTo(x, y); }
        if (g === 0) { c.fillStyle = G(0.14 + 0.1 * dk); c.fill(); c.strokeStyle = G(1); c.lineWidth = 2; }
        else { c.strokeStyle = G(0.45 * Math.pow(0.6, g)); c.lineWidth = 1; }
        c.stroke();
      }
      hexPath(c, cx, cy, 22, Math.PI / 6); c.fillStyle = 'rgba(4,14,6,0.92)'; c.fill(); c.strokeStyle = G(1); c.lineWidth = 1.5; c.stroke();
      condensed(c, NOTES[top]!, cx, cy + 12, 34, { sx: 0.7, color: rgba('bone', 1), align: 'center' });
      c.textAlign = 'left';
      // contamination: the pads as the Angel's influence, rising through the break
      const cont = clamp(au.env('other', t) * (inBrk ? 92 : 14) + (inBrk ? 4 * throb : 0), 0, 99.9);
      const cc = cont > 40 ? rgba('red', 1) : cont > 12 ? rgba('amber', 1) : G(1);
      c.fillStyle = G(0.8); c.font = font(F.mono(600), 11); c.letterSpacing = '1.5px';
      c.fillText('CONTAMINATION', mp.x, mp.y + 316); c.letterSpacing = '0px';
      c.font = jp(13, 700, false); c.fillText('精神汚染', mp.x, mp.y + 336);
      sevenSeg(c, cont.toFixed(1).padStart(4, '0'), mp.x + 150, mp.y + 300, 38, cc, G(0.07), { thick: 4.5 });
      c.fillStyle = cc; c.font = font(F.mono(700), 14); c.fillText('%', mp.x + 290, mp.y + 336);
    }

    // ===================================================== right: A10 nerve link meters
    c.globalAlpha = on(6);
    const np = panel(c, 1520, 526, 344, 236, { title: 'A10 LINK', jp: '神経', cut: 16 });
    for (let i = 0; i < NCH; i++) {
      const y = np.y + 6 + i * 31;
      const v = inBrk && res === 0 && i !== 1 ? 0.02 : clamp(peakAbs(this.bank, i, t, 0.15) * 1.05);
      c.fillStyle = O(1); c.font = font(F.mono(700), 11); c.letterSpacing = '1.5px';
      c.fillText(`A10-${i + 1}`, np.x, y + 12); c.letterSpacing = '0px';
      segMeterA(c, np.x + 64, y + 2, 206, 12, 24, v, { color: i === 5 ? rgba('red', 1) : G(1), hot: rgba('red', 1), hotFrom: 0.85, dim: O(0.08), gap: 2 });
      c.fillStyle = O(0.9); c.font = font(F.mono(600), 11); c.textAlign = 'right';
      c.fillText(String(Math.round(v * 99)).padStart(2, '0'), np.x + np.w, y + 12); c.textAlign = 'left';
    }

    // ===================================================== right: monitor status + event log
    c.globalAlpha = on(7);
    const sp = panel(c, 1520, 776, 344, 240, { title: 'MONITOR', jp: '監視状態', cut: 16, color: inBrk ? rgba(stateCol, 1) : undefined });
    {
      const x = sp.x, y = sp.y, w = sp.w;
      const sc = rgba(stateCol, 1);
      const bl = inBrk && res === 0 ? 0.35 + 0.65 * Math.max(throb, ((t - T.b12) * 4.444) % 1 < 0.5 ? 1 : 0) : 1;
      chamferPath(c, x, y, w, 70, [0, 14, 0, 14]);
      c.fillStyle = inBrk ? (res > 0 ? 'rgba(50,30,0,0.7)' : `rgba(50,0,0,${0.4 + 0.4 * bl})`) : 'rgba(4,30,12,0.55)'; c.fill();
      c.strokeStyle = sc; c.lineWidth = 2; c.stroke();
      c.fillStyle = sc; c.fillRect(x, y, 12, 70);
      c.globalAlpha = on(7) * bl;
      c.font = jp(30, 800, true); c.fillText(inBrk ? (res > 0 ? '再同調' : '反応消失') : '安定', x + 26, y + 46);
      condensed(c, inBrk ? (res > 0 ? 'RESYNC' : 'FLATLINE') : 'STABLE', x + w - 14, y + 54, 54, { sx: 0.6, color: sc, align: 'right' });
      c.globalAlpha = on(7);
      // event log: last 5 events
      const past = this.ev.filter((e) => e.t <= t).slice(-5);
      c.font = font(F.mono(500), 11.5);
      past.forEach((e, i) => {
        const yy = y + 96 + i * 19;
        const age = t - e.t;
        const col = e.kind === 'clap' ? 'red' : e.kind === 'kick' ? 'green' : 'orange';
        const txt = `${e.t.toFixed(2).padStart(6, '0')}  ${e.kind === 'kick' ? 'PULSE   R-WAVE' : e.kind === 'clap' ? 'STIM    δ-SPIKE' : 'SAMPLE  β-RING'}  ${(e.s * 99).toFixed(0).padStart(2, '0')}`;
        if (i === past.length - 1 && age < 0.1) { c.fillStyle = rgba(col, 0.85); c.fillRect(x - 2, yy - 13, w + 4, 17); c.fillStyle = rgba('ink', 1); }
        else c.fillStyle = rgba(col, 0.4 + 0.5 * (i / 4));
        c.fillText(txt, x + 2, yy);
      });
    }
    c.globalAlpha = 1;

    comp.draw(renderer, L.upload(), out);

    // ---- traces + waterfall (additive, over the panels)
    const u = this.trace.u;
    u.t!.value = t; u.uHead!.value = head * TR.w; u.uBrk!.value = brk; u.uRes!.value = res; u.uThrob!.value = throb;
    u.uDuck!.value = dk; u.uIn!.value = on(0); u.uClap!.value = inBrk ? 0 : clap;
    (u.uMask!.value as THREE.Vector4).set(...(inBrk ? this.mask : [0, 0, 0, 0]) as [number, number, number, number]);
    this.trace.render(renderer, out);

    this.scan.u.t!.value = t;
    this.scan.render(renderer, out);

    const k0 = lt;
    const bi = t >= T.b12 ? t - T.b12 : 1e9;
    return {
      bloom: 0.65, bloomThreshold: 0.6, halation: 0.08, vignette: 0.42, grain: 0.05,
      ca: 0.8 + 2 * clap + 3 * Math.exp(-k0 / 0.12) + 3 * pulse(t, T.b12, 0.1) + 2.5 * res * (hash(frameIdx(t), 3) > 0.6 ? 1 : 0),
      flash: 0.3 * Math.exp(-k0 / 0.03) + 0.2 * pulse(t, T.b12, 0.06),
      zoom: 1 + 0.03 * Math.exp(-k0 / 0.15) + 0.004 * dk - 0.01 * Math.exp(-bi / 0.2),
      shake: res > 0 && hash(frameIdx(t), 5) > 0.7 ? [(hash(frameIdx(t), 6) - 0.5) * 8 * res, 0] : [0, 0],
    };
  }
}

void smoothstep;
