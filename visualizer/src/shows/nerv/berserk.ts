// Ported from bizarro/evangelion app/src/scenes/berserk.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// berserk — "暴走" (DROP 3, the final drop: bars 78–87, 145.22 – 161.42 s).
// Unit-01 goes berserk. Hard cut in on a full-screen 暴走 slam, then the berserker HUD: the giant
// kanji + BERSERK card on the left; a polar hex spectrum (the real mel spectrum, bass at the bottom,
// highs at the top, mirrored) that explodes outward on every kick inside a bearing ring with the
// sync ratio pegged at 400 %; an ECG tracing the actual kick onsets (heart rate = the kick rate);
// 24 limiter meters pinned in the red; power / signal / pilot panels on the right. Claps are
// row glitches + panel alarms, hats tick the ring, the bar-86 fill red-shifts everything.
import * as THREE from 'three';
import { Scene, type Frame, type PostOverrides } from '../../show/scene.ts';
import { FSPass, Layer2D, clearRT } from '../../show/gl.ts';
import { rgba } from '../../show/palette.ts';
import { F, font } from '../../show/type.ts';
import { clamp, ease, frameIdx, hash, prog, TAU } from '../../show/util.ts';
import { SPECTRUM_GLSL, spectrumUniforms } from '../../show/spectrum.ts';
import { barTime, brackets, chamferPath, condensed, evaLabel, GLSL_EVA, hazard, hexData, jp, makeScanPass, panel, segMeter, sevenSeg, ticker } from './_eva.ts';
import { kickDuck, lastIdx, lastT, makeGlitchComp, mix } from './berserk-fx.ts';
import { nervText, unitName } from './show-text.ts';


const CX = 1215, CY = 470; // hex spectrum centre (logical px, y down)

const BG = /* glsl */ `
${SPECTRUM_GLSL}
${GLSL_EVA}
uniform float t, kickT, kickS, clapT, bass, kick, snare, hat, fseed, redk, vis;
uniform vec2 ctr;
void main() {
  vec2 px = vec2(FRAG_PX.x, 1080.0 - FRAG_PX.y);
  vec2 p = px - ctr;
  float r = 23.0;
  vec4 hc = hexCell(p, r);
  vec2 g = hc.xy, cc = p - g;
  float d = length(cc);
  float h = hash12(hc.zw);
  // angle from straight down (0) to straight up (pi), mirrored left/right: bass at the bottom
  float a = acos(clamp(cc.y / max(d, 1e-3), -1.0, 1.0));
  float band = 1.0 + a / 3.14159 * 56.0;
  float m = 0.5 * melAt(t, band) + 0.3 * melAt(t - 0.025, band) + 0.2 * melAt(t - 0.05, band);
  float lev = smoothstep(0.28, 1.0, m);
  float Rin = 96.0, Rout = Rin + lev * (250.0 + 60.0 * bass) * (1.0 + 0.35 * kick);
  float lit = step(Rin, d) * step(d, Rout);
  float rim = lit * step(Rout - 2.2 * r, d);
  float e = hexEdge(g, r);
  float fillM = smoothstep(2.0, 3.2, e);
  float line = pxLine(abs(e - 1.2), 0.4, 1.3);
  // idle grid: faint purple hairlines fading out with distance
  float fall = 1.0 - smoothstep(180.0, 760.0, d);
  vec3 col = C_PURPLE * line * 0.10 * fall;
  // the spectrum body: purple → red outward, rim cells lime (red on the fill)
  float k = smoothstep(Rin, Rin + 330.0, d);
  vec3 body = mix(C_PURPLE * 0.55, C_RED * 0.9, k);
  vec3 rimC = mix(C_LIME * 1.25, C_RED * 1.6, redk);
  col += fillM * lit * mix(body * (0.35 + 0.35 * h), rimC, rim);
  col += line * lit * mix(C_PURPLE, C_RED, k) * 0.5;
  // kick shockwave: a ring of cells blown outward from the core
  float age = t - kickT;
  float sw = Rin + age * 1500.0;
  float ring = exp(-abs(d - sw) / 34.0) * exp(-age * 3.5) * kickS * step(0.0, age);
  col += fillM * ring * mix(C_RED * 1.8, C_BONE * 1.4, step(0.85, h)) * (0.4 + 0.6 * step(0.35, h));
  // clap: a random scatter of cells shatter red-hot
  float cage = t - clapT;
  col += fillM * step(h, 0.22) * step(d, 640.0) * exp(-cage * 7.0) * step(0.0, cage) * C_RED * 1.3 * step(0.5, hash12(hc.zw + 3.7));
  // hats: sparkle
  col += fillM * step(1.0 - hat * 0.05, hash12(hc.zw + fseed)) * fall * C_LIME * 0.9;
  // core octagon glow
  col += C_PURPLE * 0.12 * (1.0 - smoothstep(0.0, Rin, d)) * (0.5 + kick);
  fragColor = vec4(col * vis, 1.0);
}`;

export default class Berserk extends Scene {
  bg = new FSPass(BG, {
    t: { value: 0 }, kickT: { value: -10 }, kickS: { value: 0 }, clapT: { value: -10 }, bass: { value: 0 }, kick: { value: 0 },
    snare: { value: 0 }, hat: { value: 0 }, fseed: { value: 0 }, redk: { value: 0 }, vis: { value: 1 }, ctr: { value: new THREE.Vector2(CX, CY) },
  });
  hud = new Layer2D();
  glitch = makeGlitchComp();
  scan = makeScanPass(0.24);
  mel = new Float32Array(64);
  T = { s: 0, e: 0, intro: 0, fill: 0 };

  override init() {
    const au = this.ctx.audio;
    Object.assign(this.bg.u, spectrumUniforms(this.ctx.spectrum));
    this.T.s = barTime(au, 78); this.T.e = barTime(au, 87); this.T.fill = barTime(au, 86);
    // the intro slam holds until the second kick of the drop
    const k2 = (au.onsets.kick ?? []).find(([kt, s]) => kt > this.T.s + 0.3 && s > 0.6);
    this.T.intro = k2 ? k2[0] : this.T.s + 0.6;
  }

  render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides {
    const { renderer, audio: au } = this.ctx;
    const T = this.T, t = f.t, fi = frameIdx(t);
    const kd = kickDuck(au, t);
    const snare = au.hit('snare', t, 0.12), hat = au.hit('hat', t, 0.06), kick = au.hit('kick', t, 0.1);
    const bass = clamp(f.a.bass * 1.2);
    const fillK = prog(t, T.fill, T.e, ease.inQuad); // bar 86 fill: red-shift + glitch ramp
    const inIntro = t < T.intro;
    const barIdx = Math.floor((t - T.s) / 1.8);
    const phraseT = T.s + Math.floor((t - T.s) / 3.6) * 3.6;
    const slam = Math.exp(-(t - phraseT) / 0.09);
    const ki = lastIdx(au, 'kick', t, 0.6), kT = ki >= 0 ? au.onsets.kick![ki]![0] : -10, kS = ki >= 0 ? au.onsets.kick![ki]![1] : 0;
    const ci = lastIdx(au, 'snare', t, 0.6), cT = ci >= 0 ? au.onsets.snare![ci]![0] : -10;

    // ---------------------------------------------------------------- GL background
    const u = this.bg.u;
    u.t!.value = t; u.kickT!.value = kT; u.kickS!.value = kS; u.clapT!.value = cT; u.bass!.value = bass; u.kick!.value = kick;
    u.snare!.value = snare; u.hat!.value = hat; u.fseed!.value = fi % 997; u.redk!.value = fillK; u.vis!.value = inIntro ? 0 : 1;
    this.bg.render(renderer, out);

    // ---------------------------------------------------------------- HUD
    const L = this.hud; L.clear();
    const c = L.ctx;
    const lime = (a = 1) => mix('lime', 'red', fillK, a);
    const purp = (a = 1) => mix('purple', 'red', fillK * 0.6, a);

    if (inIntro) {
      this.drawIntro(c, t);
    } else {
      // outer frame
      c.strokeStyle = purp(0.55); c.lineWidth = 1;
      c.strokeRect(30, 26, 1860, 1028);
      brackets(c, 30, 26, 1860, 1028, 30, purp(1), 3);
      this.drawTop(c, t, cT, fillK);
      this.drawTitle(c, t, slam, kd, snare, fillK, barIdx);
      this.drawRing(c, t, hat, kick, bass, fillK);
      this.drawRight(c, t, cT, ci, fillK);
      this.drawECG(c, t, fillK);
      this.drawLimiter(c, t, fillK);
      // clap alarm: red frame flare
      const ca = Math.exp(-(t - cT) / 0.08);
      if (ca > 0.02) { c.strokeStyle = rgba('red', ca); c.lineWidth = 6; c.strokeRect(34, 30, 1852, 1020); }
      void lime;
    }

    const gAmt = clamp(snare * 0.75 + fillK * 0.6 + (inIntro ? 0.3 * Math.exp(-(t - T.s) / 0.2) : 0) + (hash(fi, 5) < 0.04 + fillK * 0.2 ? 0.4 : 0));
    this.glitch.draw(renderer, L.upload(), out, gAmt, (lastIdx(au, 'snare', t) * 13 + Math.floor(fi / 3) * (fillK > 0.3 ? 1 : 0)) % 1000, 1.2 + kick * 2);
    this.scan.u.t!.value = t;
    this.scan.render(renderer, out);

    const kSh = hash(ki, 3) - 0.5, kSh2 = hash(ki, 4) - 0.5;
    const flash = 1.1 * Math.exp(-(t - T.s) / 0.1) + (barIdx > 0 && barIdx % 2 === 0 ? 0.22 * slam : 0) + 0.05 * snare;
    return {
      bloom: 0.8, bloomThreshold: 0.55, halation: 0.12, vignette: 0.42, grain: 0.06,
      ca: 1.3 + snare * 5 + fillK * 3,
      flash,
      shake: [kSh * 16 * kd + (inIntro ? (hash(fi, 1) - 0.5) * 24 : 0), kSh2 * 12 * kd + (inIntro ? (hash(fi, 2) - 0.5) * 18 : 0)],
      zoom: 1 + 0.018 * kd + 0.1 * Math.exp(-(t - T.s) / 0.12) + 0.03 * slam,
    };
  }

  // the first 0.6 s: full-screen 暴走 slam on black with hazard bands
  drawIntro(c: CanvasRenderingContext2D, t: number) {
    const k = t - this.T.s;
    hazard(c, 0, 0, 1920, 90, k * 400, rgba('red', 1));
    hazard(c, 0, 990, 1920, 90, -k * 400, rgba('red', 1));
    const s = 1 + 0.25 * Math.exp(-k / 0.07);
    c.save();
    c.translate(960, 560); c.scale(s, s);
    c.font = jp(640, 700, true); c.fillStyle = rgba('red', 1); c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('暴走', 0, 20);
    c.restore();
    condensed(c, 'BERSERK', 960, 970, 110, { sx: 0.6, color: rgba('lime', 1), align: 'center' });
    evaLabel(c, 60, 130, 'unit-01 // limiter release', '初号機 リミッター解除', { color: rgba('lime', 1), size: 1.3 });
    evaLabel(c, 1860, 130, 'activity limit exceeded', '活動限界突破', { color: rgba('red', 1), size: 1.3, align: 'right' });
  }

  drawTop(c: CanvasRenderingContext2D, t: number, cT: number, fillK: number) {
    const ca = Math.exp(-(t - cT) / 0.1);
    hazard(c, 60, 44, 230, 32, t * 70, rgba('red', 1));
    hazard(c, 1630, 44, 230, 32, -t * 70, rgba('red', 1));
    // centre band: ticker, inverted to a red block on each clap
    if (ca > 0.3) { c.fillStyle = rgba('red', ca); c.fillRect(306, 44, 1308, 32); }
    c.fillStyle = rgba('red', 0.8); c.fillRect(306, 42, 1308, 1); c.fillRect(306, 77, 1308, 1);
    ticker(c, 312, 66, 1296, 'ACTIVITY LIMIT EXCEEDED // 活動限界突破 // UNIT-01 BERSERK // 暴走 // SYNC RATIO 400% // PILOT CONTROL LOST // NEURAL LINK REVERSED // 神経接続逆流 //', t, { speed: 260, color: ca > 0.3 ? rgba('ink', 1) : mix('red', 'red', fillK, 0.95), size: 16 });
  }

  drawTitle(c: CanvasRenderingContext2D, t: number, slam: number, kd: number, snare: number, fillK: number, barIdx: number) {
    const lime = mix('lime', 'red', fillK);
    evaLabel(c, 96, 136, `${unitName(nervText(this.ctx.params)).toLowerCase()} // status`, `${nervText(this.ctx.params).unitJp}初号機  状態`, { color: mix('lime', 'red', fillK, 0.9), size: 1.1 });
    // status tab
    c.fillStyle = rgba('red', 1);
    chamferPath(c, 96, 176, 250, 30, [0, 14, 0, 0]); c.fill();
    c.fillStyle = rgba('ink', 1); c.font = font(F.mono(700), 15); c.letterSpacing = '3px'; c.textBaseline = 'middle';
    c.fillText('MODE: BERSERK', 108, 192); c.letterSpacing = '0px';
    c.fillStyle = rgba('red', blinkOn(t, 3) ? 1 : 0.25); c.fillRect(360, 180, 22, 22);
    c.font = jp(20, 700, false); c.fillStyle = rgba('red', 0.95); c.fillText('制御不能', 394, 192);
    // the kanji: slams on each 2-bar phrase, bounces on the kick
    const s = 1 + 0.14 * slam;
    c.save();
    c.translate(475, 400 + kd * 8); c.scale(s, s);
    c.font = jp(390, 700, true); c.fillStyle = rgba('red', 1); c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('暴走', 0, 0);
    c.restore();
    c.textAlign = 'left';
    // BERSERK card
    condensed(c, 'BERSERK', 92, 792, 250, { sx: 0.56, color: lime, bold: 0.03 });
    // under-rule with bar counter
    c.fillStyle = lime; c.fillRect(96, 812, 690, 3);
    c.font = font(F.mono(600), 14); c.letterSpacing = '2.4px'; c.fillStyle = lime; c.textBaseline = 'alphabetic';
    c.fillText(`PHASE ${String(barIdx + 1).padStart(2, '0')}/09   EVA-01 TEST TYPE`, 96, 836);
    c.letterSpacing = '0px';
    c.font = jp(17, 600, false); c.textAlign = 'right'; c.fillText('試験初号機', 786, 836); c.textAlign = 'left';
    void snare;
  }

  drawRing(c: CanvasRenderingContext2D, t: number, hat: number, kick: number, bass: number, fillK: number) {
    const R = 392 + kick * 10, pc = (a: number) => mix('purple', 'red', fillK * 0.6, a);
    c.save();
    c.translate(CX, CY);
    c.strokeStyle = pc(0.9); c.lineWidth = 1.5;
    c.beginPath(); c.arc(0, 0, R, 0, TAU); c.stroke();
    c.strokeStyle = pc(0.4); c.lineWidth = 1;
    c.beginPath(); c.arc(0, 0, R - 18, 0, TAU); c.stroke();
    // 144 ticks; hats light a band that walks around the ring
    const hb = Math.floor(t / 0.225) % 144;
    for (let i = 0; i < 144; i++) {
      const a = (i / 144) * TAU - Math.PI / 2, maj = i % 12 === 0;
      const near = ((i - hb + 144) % 144) < 10;
      const len = maj ? 16 : 7;
      c.strokeStyle = near ? mix('lime', 'red', fillK, 0.5 + 0.5 * hat) : pc(maj ? 0.9 : 0.45);
      c.lineWidth = maj ? 2 : 1;
      c.beginPath(); c.moveTo(Math.cos(a) * R, Math.sin(a) * R); c.lineTo(Math.cos(a) * (R + len), Math.sin(a) * (R + len)); c.stroke();
    }
    // bearing labels
    c.font = font(F.mono(500), 11); c.fillStyle = pc(0.8); c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU - Math.PI / 2;
      c.fillText(String(i * 30).padStart(3, '0'), Math.cos(a) * (R + 32), Math.sin(a) * (R + 32));
    }
    // rotating red arcs: one turn per 2 bars, pushed by the bass
    const rot = (t / 3.6) * TAU;
    c.strokeStyle = rgba('red', 0.9); c.lineWidth = 5;
    for (let k = 0; k < 3; k++) {
      const a0 = rot + (k * TAU) / 3;
      c.beginPath(); c.arc(0, 0, R - 9, a0, a0 + 0.3 + 0.25 * bass); c.stroke();
    }
    // crosshair stubs
    c.strokeStyle = pc(0.6); c.lineWidth = 1;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      c.beginPath(); c.moveTo(dx * (R + 46), dy * (R + 46)); c.lineTo(dx * (R + 70), dy * (R + 70)); c.stroke();
    }
    // core: octagon + the pegged sync ratio
    c.beginPath();
    for (let i = 0; i < 8; i++) { const a = Math.PI / 8 + (i * TAU) / 8; const x = Math.cos(a) * 84, y = Math.sin(a) * 84; if (i) c.lineTo(x, y); else c.moveTo(x, y); }
    c.closePath(); c.fillStyle = 'rgba(8,4,14,0.85)'; c.fill(); c.strokeStyle = pc(1); c.lineWidth = 2; c.stroke();
    const jitter = hash(frameIdx(t), 9) < 0.08 ? '4O0' : '400';
    c.restore();
    sevenSeg(c, jitter === '400' ? '400' : '888', CX - 49, CY - 34, 50, mix('lime', 'red', fillK), rgba('lime', 0.06), { glow: 0 });
    c.font = font(F.mono(700), 12); c.fillStyle = pc(1); c.textAlign = 'center'; c.letterSpacing = '2px'; c.textBaseline = 'alphabetic';
    c.fillText('SYNC %', CX, CY + 36); c.letterSpacing = '0px';
    c.font = jp(15, 700, false); c.fillText('同調率', CX, CY + 56);
    // band labels on the axis: bass at the bottom, highs on top
    c.font = font(F.mono(500), 11); c.fillStyle = pc(0.8);
    c.fillText('16 kHz', CX, CY - R - 56); c.fillText('30 Hz', CX, CY + R + 58);
    c.textAlign = 'left';
    evaLabel(c, CX - R - 30, CY - R + 10, 'harmonic field', '調和場 暴走', { color: pc(1) });
    evaLabel(c, CX + R + 30, CY + R - 30, 'mel 64 // mirrored', '周波数解析', { color: pc(1), align: 'right' });
  }

  drawRight(c: CanvasRenderingContext2D, t: number, cT: number, ci: number, fillK: number) {
    const x = 1650, w = 210;
    const alarm = Math.exp(-(t - cT) / 0.12);
    const which = ((ci % 3) + 3) % 3; // the clap alarms one of the three panels
    // POWER
    const hot0 = which === 0 ? alarm : 0;
    const r0 = panel(c, x, 116, w, 206, { title: 'POWER', jp: '電源', color: rgba('red', 1), fill: hot0 > 0.3 ? `rgba(110,0,0,${0.5 + 0.4 * hot0})` : undefined });
    sevenSeg(c, '00:00:00', r0.x, r0.y + 4, 30, rgba('red', blinkOn(t, 2.2) ? 1 : 0.35), rgba('red', 0.08));
    labelRow(c, r0.x, r0.y + 62, 'INTERNAL', '0 %', rgba('red', 1));
    segMeter(c, r0.x, r0.y + 70, r0.w, 10, 12, 0, { dim: rgba('red', 0.14) });
    labelRow(c, r0.x, r0.y + 100, 'EXTERNAL', 'CUT', rgba('red', 1));
    c.font = jp(15, 700, false); c.fillStyle = rgba('red', 0.95); c.fillText('内部電源 0  外部電源 切断', r0.x, r0.y + 126);
    c.font = font(F.mono(700), 12); c.fillStyle = mix('lime', 'red', fillK); c.letterSpacing = '1.6px';
    c.fillText('STILL MOVING', r0.x, r0.y + 148); c.letterSpacing = '0px';
    // SIGNAL: hex rows stepping on the hats
    const hot1 = which === 1 ? alarm : 0;
    const r1 = panel(c, x, 340, w, 250, { title: 'SIGNAL', jp: '信号', color: mix('purple', 'red', fillK * 0.6), fill: hot1 > 0.3 ? `rgba(110,0,0,${0.5 + 0.4 * hot1})` : undefined });
    const step = lastIdx(this.ctx.audio, 'hat', t) + lastIdx(this.ctx.audio, 'kick', t);
    c.font = font(F.mono(500), 12.5); c.textBaseline = 'alphabetic';
    for (let i = 0; i < 9; i++) {
      const s = step - i, err = hash(s, 77) < 0.18;
      c.fillStyle = err ? rgba('red', 1) : mix('lime', 'red', fillK, 0.85 - i * 0.07);
      c.fillText(err ? `${hexData(s, 1, 4)} ERR ${hexData(s, 2, 4)}` : `${hexData(s, 1, 4)} ${hexData(s, 3, 8)}`, r1.x, r1.y + 12 + i * 20);
    }
    // PILOT
    const hot2 = which === 2 ? alarm : 0;
    const r2 = panel(c, x, 608, w, 214, { title: 'PILOT 01', color: mix('lime', 'red', fillK), fill: hot2 > 0.3 ? `rgba(110,0,0,${0.5 + 0.4 * hot2})` : undefined });
    labelRow(c, r2.x, r2.y + 14, 'RESPONSE', 'NONE', rgba('red', 1));
    labelRow(c, r2.x, r2.y + 40, 'NEURAL', 'REVERSE', rgba('red', 1));
    labelRow(c, r2.x, r2.y + 66, 'EGO BORDER', 'LOST', rgba('red', 1));
    c.font = jp(15, 700, false); c.fillStyle = rgba('red', 0.95);
    c.fillText('応答なし  神経接続逆流', r2.x, r2.y + 94);
    // big blinking block
    c.fillStyle = rgba('red', blinkOn(t, 4) ? 0.95 : 0.2);
    chamferPath(c, r2.x, r2.y + 110, r2.w, 38, 8); c.fill();
    c.fillStyle = rgba('ink', 1); c.font = font(F.mono(700), 15); c.letterSpacing = '3px'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('WARNING', r2.x + r2.w / 2, r2.y + 130); c.letterSpacing = '0px'; c.textAlign = 'left';
  }

  // ECG: the heart is the kick. QRS complexes on the actual kick onsets, the last 2 bars scrolling.
  drawECG(c: CanvasRenderingContext2D, t: number, fillK: number) {
    const au = this.ctx.audio;
    const r = panel(c, 60, 858, 1080, 158, { title: 'ECG', jp: '心電図', color: mix('lime', 'red', fillK) });
    const gx = r.x, gy = r.y, gw = r.w - 190, gh = r.h;
    c.strokeStyle = mix('lime', 'red', fillK, 0.09); c.lineWidth = 1;
    c.beginPath();
    for (let i = 0; i <= 24; i++) { const x = gx + (gw * i) / 24; c.moveTo(x, gy); c.lineTo(x, gy + gh); }
    for (let j = 0; j <= 4; j++) { const y = gy + (gh * j) / 4; c.moveTo(gx, y); c.lineTo(gx + gw, y); }
    c.stroke();
    const win = 3.6, kicks = au.events('kick', t - win - 0.4, t + 0.01);
    const qrs = (dt: number) =>
      0.12 * Math.exp(-(((dt + 0.09) / 0.025) ** 2)) - 0.18 * Math.exp(-(((dt + 0.018) / 0.008) ** 2))
      + 1.0 * Math.exp(-((dt / 0.009) ** 2)) - 0.35 * Math.exp(-(((dt - 0.022) / 0.01) ** 2)) + 0.2 * Math.exp(-(((dt - 0.17) / 0.04) ** 2));
    const mid = gy + gh * 0.62, amp = gh * 0.56;
    const N = 420;
    c.beginPath();
    let hx = 0, hy = 0;
    for (let i = 0; i <= N; i++) {
      const ts = t - win * (1 - i / N);
      let v = 0;
      for (const [kt, s] of kicks) { const dt = ts - kt; if (dt > -0.15 && dt < 0.3) v += qrs(dt) * Math.min(1, s * 1.1); }
      v += au.waveAt(ts)[0] * 0.05;
      const x = gx + (gw * i) / N, y = mid - v * amp;
      if (i) c.lineTo(x, y); else c.moveTo(x, y);
      hx = x; hy = y;
    }
    c.strokeStyle = mix('lime', 'red', fillK, 1); c.lineWidth = 2; c.lineJoin = 'round'; c.stroke();
    c.fillStyle = rgba('bone', 1); c.beginPath(); c.arc(hx, hy, 3.5, 0, TAU); c.fill();
    // heart rate = interval between the last two strong kicks
    const strong = kicks.filter(([, s]) => s > 0.6);
    const hr = strong.length >= 2 ? 60 / (strong[strong.length - 1]![0] - strong[strong.length - 2]![0]) : 100;
    const rx = r.x + r.w - 170;
    c.fillStyle = mix('lime', 'red', fillK, 0.5); c.fillRect(rx - 10, gy, 1, gh);
    c.font = font(F.mono(600), 12); c.letterSpacing = '2px'; c.fillStyle = mix('lime', 'red', fillK); c.textBaseline = 'alphabetic';
    c.fillText('HEART RATE', rx, gy + 12); c.letterSpacing = '0px';
    sevenSeg(c, String(Math.round(Math.min(hr, 299))).padStart(3, ' '), rx, gy + 22, 52, mix('lime', 'red', fillK), rgba('lime', 0.07));
    c.font = jp(15, 700, false); c.fillText('心拍数  BPM', rx, gy + 102);
    const lk = lastT(au, 'kick', t, 0.6);
    c.fillStyle = rgba('red', Math.exp(-(t - lk) / 0.08)); c.beginPath(); c.arc(rx + 150, gy + 8, 6, 0, TAU); c.fill();
  }

  // 24 limiters: mel bands, pinned in the red, with an OVER flag
  drawLimiter(c: CanvasRenderingContext2D, t: number, fillK: number) {
    const au = this.ctx.audio;
    au.melFrame(t, this.mel);
    const r = panel(c, 1160, 858, 700, 158, { title: 'LIMITER', jp: 'リミッター全解除', color: mix('purple', 'red', fillK * 0.6) });
    const n = 24, gw = r.w, bw = (gw - (n - 1) * 5) / n;
    for (let i = 0; i < n; i++) {
      const b = 1 + i * 2.5;
      const v = 0.72 + 0.28 * clamp((this.mel[Math.floor(b)]! - 0.3) / 0.7);
      segMeter(c, r.x + i * (bw + 5), r.y + 6, bw, r.h - 26, 10, v, { vertical: true, color: mix('purple', 'red', fillK), hot: rgba('red', 1), hotFrom: 0.5, dim: rgba('purple', 0.12), gap: 2 });
    }
    c.font = font(F.mono(700), 11); c.fillStyle = rgba('red', blinkOn(t, 5) ? 1 : 0.3); c.letterSpacing = '2px'; c.textBaseline = 'alphabetic';
    for (let i = 0; i < n; i += 4) c.fillText('OVR', r.x + i * (bw + 5), r.y + r.h + 4);
    c.letterSpacing = '0px';
  }
}

const blinkOn = (t: number, hz: number) => ((t * hz) % 1) < 0.55;

function labelRow(c: CanvasRenderingContext2D, x: number, y: number, k: string, v: string, col: string) {
  c.font = font(F.mono(500), 12); c.letterSpacing = '1.5px'; c.textBaseline = 'alphabetic';
  c.fillStyle = col; c.globalAlpha = 0.75; c.fillText(k, x, y);
  c.globalAlpha = 1; c.font = font(F.mono(700), 13); c.textAlign = 'right'; c.fillText(v, x + 190, y); c.textAlign = 'left';
  c.letterSpacing = '0px';
}
