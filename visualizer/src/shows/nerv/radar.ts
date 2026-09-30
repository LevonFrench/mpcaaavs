// Ported from bizarro/evangelion app/src/scenes/radar.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// radar — "TACTICAL" (groove 2, bars 13–18, 28.22 – 37.22 s).
// The top-down tactical radar over Tokyo-3: range rings on a phosphor terrain map, a sweep that
// turns once per bar (north on every downbeat), and a bearing bezel. The UN defence line are
// orange blips painted by the sweep: each echo is frozen at the moment the beam passes (its size
// is that unit's mel band at that instant) and fades until the next turn. A spectrum ring around
// the scope is painted the same way (the mel spectrum, one sector per band). The Angel is the cyan
// contact closing in from the north-east sea (bass sets its echo); every strong clap is its attack:
// red beam, the nearest UN unit is LOST, the 使徒接近 warning blinks. On bar 17 it crosses the
// inner defence ring (防衛線突破). Kicks fire the radar pulse (a ring racing out, rings bounce),
// hats scroll the transmitter log. Around it: the contact list (rows light as the beam passes),
// an A-scope (range trace = the real waveform + echoes on the beam's bearing), target data, the
// UN forces tally and the time to contact.
import * as THREE from 'three';
import { Scene, type Frame, type PostOverrides } from '../../show/scene.ts';
import { FSPass, Layer2D } from '../../show/gl.ts';
import { LineBatch } from '../../show/lines.ts';
import { rgba } from '../../show/palette.ts';
import { SPECTRUM_GLSL, spectrumUniforms } from '../../show/spectrum.ts';
import { F, font } from '../../show/type.ts';
import { clamp, ease, frameIdx, hash, prog, pulse, smoothstep, springStep, TAU } from '../../show/util.ts';
import { GLSL_EVA, barTime, chamferPath, duck, evaLabel, hexData, jp, makeScanPass, panel, segMeter, sevenSeg, songBar, warningBox } from './_eva.ts';
import { chrome, meta } from './magi-hud.ts';
import { arcB, countB, dashB, lastOnsetB, lc, makeUnits, polyB, typeJp, wrap, type Unit } from './radar-kit.ts';

const CX = 960, CY = 586, RS = 340; // scope centre / radius (px)
const KM = 40; // scope range
const DEG = Math.PI / 180;
const KICK_MIN = 0.6, CLAP_MIN = 0.85;

type Kill = { t: number; u: number; ax: number; ay: number };

export default class Radar extends Scene {
  bg!: FSPass;
  lb = new LineBatch(14000);
  L = new Layer2D();
  scan = makeScanPass(0.24);
  units: Unit[] = makeUnits(18);
  kills: Kill[] = [];
  T = { s: 0, e: 0, bar: 1.8, b17: 0 };
  wv: [number, number] = [0, 0];

  override init() {
    const au = this.ctx.audio, s = this.ctx.start, e = this.ctx.end;
    this.T = { s, e, bar: barTime(au, 14) - barTime(au, 13), b17: barTime(au, 17) };
    this.bg = new FSPass(/* glsl */ `
      ${GLSL_EVA}
      ${SPECTRUM_GLSL}
      uniform float t, uSweep, uBar, uP0, uP1, uDk, uClap, uOn, uBreach, uRing;
      uniform vec2 uAng;
      const vec2 CC = vec2(${CX}.0, ${CY}.0);
      const float RS = ${RS}.0;
      float brgOf(vec2 d) { float b = atan(d.x, -d.y); return b < 0.0 ? b + TAU : b; }
      vec3 ping(float a, float r) {
        if (a < 0.0 || a > 0.7) return vec3(0.0);
        float rp = 20.0 + a * 720.0, dd = abs(r - rp);
        return C_AMBER * (pxLine(dd, 0.8, 2.4) * 0.7 + exp(-dd / 16.0) * 0.1) * exp(-a / 0.2);
      }
      void main() {
        vec2 p = vec2(FRAG_PX.x, 1080.0 - FRAG_PX.y);
        vec3 col = C_INK;
        // ground: the groove plates' dim hex grid
        vec4 hc = hexCell(p, 38.0);
        float he = hexEdge(hc.xy, 38.0);
        float cellOn = step(0.985, hash12(hc.zw + 3.1)) * smoothstep(0.0, 8.0, he);
        col += C_ORANGE * (pxLine(he, 0.5, 1.5) * 0.055 * (1.0 + 1.2 * uDk) + cellOn * 0.02);
        vec2 d = p - CC; float r = length(d);
        if (p.x > 424.0 && p.x < 1496.0 && p.y > 120.0 && p.y < 1016.0) {
          col = C_INK;
          vec2 g = mod(d, 24.0) - 12.0;
          col += C_ORANGE * 0.07 * pxLine(length(g), 0.5, 1.4);
        }
        float brg = brgOf(d);
        float behind = mod(uSweep - brg, TAU);
        if (r < RS) {
          vec2 q = d / RS;
          // Tokyo-3 terrain: the sea to the north-east, contoured hills, the city grid at the centre
          float hgt = fbm(q * 2.1 + vec2(4.3, 1.7), 5) * 0.9 - dot(q, vec2(0.72, -0.66)) * 0.95 + 0.08;
          float land = smoothstep(-0.004, 0.004, hgt);
          float cv = hgt * 11.0, cw = max(fwidth(cv) * PX_SCALE, 1e-4);
          float contour = land * pxLine(abs(fract(cv + 0.5) - 0.5) / cw, 0.3, 1.2);
          float coast = pxLine(abs(hgt) / max(fwidth(hgt) * PX_SCALE, 1e-4), 0.6, 1.8);
          float sea = (1.0 - land) * pxLine(abs(mod(p.y, 6.0) - 3.0), 0.3, 1.0);
          vec2 cg = d + 9.0;
          vec2 cell = floor(cg / 18.0), cf = mod(cg, 18.0);
          float cityMask = land * (1.0 - smoothstep(RS * 0.16, RS * 0.22, r));
          float grid = pxLine(min(cf.x, cf.y), 0.4, 1.2);
          float bldg = step(0.55, hash12(cell + 7.0)) * step(3.0, cf.x) * step(cf.x, 15.0) * step(3.0, cf.y) * step(cf.y, 15.0);
          float city = cityMask * (grid * 0.8 + bldg * 0.35);
          float trail = exp(-behind * 2.3);
          float lit = 0.2 + 0.95 * trail;
          float s = land * 0.045 + contour * 0.15 + coast * 0.5 + sea * 0.06 + city * 0.32;
          vec3 sc = C_ORANGE * s * lit;
          sc += C_ORANGE * trail * 0.07 + C_AMBER * exp(-behind * 28.0) * 0.2;
          sc += ping(uP0, r) + ping(uP1, r);
          // the Angel's attack: red bloom around it on the clap
          sc += C_RED * uClap * 0.5 * exp(-length(p - uAng) / 70.0);
          // after the breach the inner defence zone glows red
          sc += C_RED * 0.05 * uBreach * (1.0 - smoothstep(RS * 0.38, RS * 0.4, r));
          sc *= 1.0 - 0.4 * smoothstep(RS * 0.75, RS, r);
          col = C_INK * 0.6 + sc * uOn;
        } else if (r > 345.0 && r < 376.0) {
          // spectrum ring: sector k = mel band (mirrored east/west), painted when the beam passes
          float sec = floor(brg / (TAU / 90.0));
          float bh = mod(uSweep - (sec + 0.5) * TAU / 90.0, TAU);
          float tp = t - bh / TAU * uBar;
          float band = (sec < 45.0 ? sec : 89.0 - sec) * 63.0 / 44.0;
          float e = smoothstep(0.3, 1.0, melAt(tp, band)) * (0.85 + 0.25 * uRing);
          float rr = (r - 346.0) / 29.0, si = floor(rr * 5.0), sf = fract(rr * 5.0);
          float af = fract(brg / (TAU / 90.0));
          float shape = step(0.1, af) * step(af, 0.9) * step(0.2, sf);
          float fresh = exp(-bh * 1.6);
          float on = step(si + 0.5, e * 5.0 + 0.3);
          vec3 cc = si >= 4.0 ? C_RED : si >= 3.0 ? C_AMBER : C_ORANGE;
          col += shape * uOn * (on * cc * (0.45 + 0.55 * fresh) + (1.0 - on) * C_ORANGE * 0.06);
        }
        fragColor = vec4(col, 1.0);
      }`, {
      t: { value: 0 }, uSweep: { value: 0 }, uBar: { value: this.T.bar }, uP0: { value: -1 }, uP1: { value: -1 }, uDk: { value: 0 }, uClap: { value: 0 },
      uOn: { value: 1 }, uBreach: { value: 0 }, uRing: { value: 0 }, uAng: { value: new THREE.Vector2() }, ...spectrumUniforms(this.ctx.spectrum),
    });

    // every strong clap: the Angel strikes the nearest surviving unit
    const claps = au.events('snare', s, e).filter((c) => c[1] >= CLAP_MIN);
    for (const [ct] of claps) {
      const [ax, ay] = this.angelXY(ct);
      let best = -1, bd = 1e9;
      this.units.forEach((u, i) => {
        if (u.lost < ct) return;
        const [ux, uy] = this.unitXY(u, ct);
        const dd = Math.hypot(ux - ax, uy - ay);
        if (dd < bd) { bd = dd; best = i; }
      });
      if (best >= 0) { this.units[best]!.lost = ct; this.kills.push({ t: ct, u: best, ax, ay }); }
    }
  }

  // ------------------------------------------------ positions (normalized, 1 = scope rim)
  angelR(t: number) {
    const { s, b17 } = this.T, q = (t - s) / (b17 - s);
    if (q < 0) return 0.95 - 0.33 * q;
    if (q < 1) return 0.95 - 0.55 * (0.6 * q + 0.4 * q * q);
    return 0.4 - 0.14 * ((t - b17) / (this.T.e - b17));
  }
  angelB(t: number) { return (47 + 6 * Math.sin(t * 0.37) + 3 * this.ctx.audio.env('bass', t)) * DEG; }
  angelXY(t: number): [number, number] { const r = this.angelR(t), b = this.angelB(t); return [Math.sin(b) * r, -Math.cos(b) * r]; }
  unitBR(u: Unit, t: number): [number, number] { const dt = t - this.T.s; return [wrap(u.b0 + u.vb * dt), clamp(u.r0 + u.vr * dt, 0.08, 0.97)]; }
  unitXY(u: Unit, t: number): [number, number] { const [b, r] = this.unitBR(u, t); return [Math.sin(b) * r, -Math.cos(b) * r]; }

  render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides {
    const { renderer, audio: au, comp } = this.ctx;
    const T = this.T, t = f.t, lt = t - T.s, BAR = T.bar;
    const dk = duck(f, au);
    const fi = frameIdx(t);
    const sweep = TAU * (((songBar(au, t) % 1) + 1) % 1);
    const passT = (b: number) => t - (wrap(sweep - b) / TAU) * BAR; // when the beam last crossed bearing b
    // onsets
    const k0 = lastOnsetB(au, 'kick', t, KICK_MIN), k1 = lastOnsetB(au, 'kick', t, KICK_MIN, 1);
    const kAge = t - k0, snap = kAge < 2 ? 1 - springStep(kAge, 3.4, 0.4) : 0;
    const cT = lastOnsetB(au, 'snare', t, 0.5), cStr = au.onsets.snare?.find((x) => x[0] === cT)?.[1] ?? 0;
    const cp = pulse(t, cT, 0.12) * cStr;
    const kill = [...this.kills].reverse().find((k) => k.t <= t);
    const kAgeK = kill ? t - kill.t : 1e9, kp = kill ? pulse(t, kill.t, 0.1) : 0;
    const hats = countB(au, 'hat', T.s - 4, t);
    const pulses = countB(au, 'kick', T.s, t, KICK_MIN);
    const breach = t >= T.b17, bp = breach ? pulse(t, T.b17, 0.15) : 0;
    const lost = this.units.filter((u) => u.lost <= t).length;
    // the Angel, as painted by the beam
    const aB = this.angelB(t), aTp = passT(aB), aAge = t - aTp;
    const [anx, any_] = this.angelXY(aTp);
    const AX = CX + anx * RS, AY = CY + any_ * RS;
    const aE = clamp(au.env('bass', aTp) * 1.3);
    const aRkm = this.angelR(t) * KM;
    // opening: the scope and panels flick on over the first beat
    const on = (g: number) => {
      const p = (lt - g * 0.05) / 0.22;
      if (p >= 1) return 1;
      if (p <= 0) return 0;
      return hash(fi, g) < p ? 1 : 0.15;
    };

    // ============================================== GL: ground, terrain, sweep phosphor, spectrum ring
    const bg = this.bg.u;
    bg.t!.value = t; bg.uSweep!.value = sweep; bg.uP0!.value = k0 > -1e8 ? t - k0 : -1; bg.uP1!.value = k1 > -1e8 ? t - k1 : -1;
    bg.uDk!.value = dk * 0.6 + f.a.kick * 0.4; bg.uClap!.value = kp; bg.uOn!.value = on(0); bg.uBreach!.value = breach ? 1 + 2 * bp : 0;
    bg.uRing!.value = dk; (bg.uAng!.value as THREE.Vector2).set(kill ? CX + kill.ax * RS : AX, kill ? CY + kill.ay * RS : AY);
    this.bg.render(renderer, out);

    // ============================================== GL: scope line work
    const lb = this.lb; lb.clear();
    const oA = on(0);
    const O = lc('orange', 1.0), Oh = lc('orange', 1.5), A = lc('amber', 1.3), RED = lc('red', 1.6), CYN = lc('cyan', 1.7), BN = lc('bone', 2.2);
    const ringK = 1 + 0.012 * snap;
    for (let k = 1; k <= 5; k++) {
      const outer = k === 5, rr = (RS * k) / 5 * (outer ? 1 : ringK);
      const red = breach && k === 2;
      arcB(lb, CX, CY, rr, outer ? 2.4 : red ? 1.8 : 1.1, red ? RED : outer ? Oh : O, oA * (outer ? 1 : 0.4 + 0.45 * Math.exp(-kAge / 0.18)), 0, TAU, 160);
    }
    // radials: cardinal axes solid, every 30° faint
    for (let i = 0; i < 12; i++) {
      const b = i * 30 * DEG, card = i % 3 === 0;
      lb.seg2(CX + Math.sin(b) * 10, CY - Math.cos(b) * 10, CX + Math.sin(b) * RS, CY - Math.cos(b) * RS, 1, O, oA * (card ? 0.4 : 0.16));
    }
    // bearing bezel: 1° ticks, 5° / 10° longer, inner and outer rules
    arcB(lb, CX, CY, 380, 1.2, O, oA * 0.8, 0, TAU, 180);
    arcB(lb, CX, CY, 399, 2, Oh, oA, 0, TAU, 180);
    for (let i = 0; i < 360; i++) {
      const b = i * DEG, l = i % 10 === 0 ? 16 : i % 5 === 0 ? 10 : 5;
      const near = Math.exp(-wrap(sweep - b) * 5);
      lb.seg2(CX + Math.sin(b) * 381, CY - Math.cos(b) * 381, CX + Math.sin(b) * (381 + l), CY - Math.cos(b) * (381 + l), i % 10 === 0 ? 1.6 : 1, near > 0.3 ? A : O, oA * (0.55 + 0.45 * near));
    }
    // sweep: the beam line + a leading glow
    {
      const sx = Math.sin(sweep), sy = -Math.cos(sweep);
      lb.seg2(CX, CY, CX + sx * (RS + 36), CY + sy * (RS + 36), 2.4, BN, oA);
      lb.seg2(CX, CY, CX + sx * RS, CY + sy * RS, 9, lc('amber', 0.7), oA * 0.25);
      // bezel caret
      const bx = CX + sx * 404, by = CY + sy * 404, nx = -sy, ny = sx;
      lb.seg2(bx, by, bx + sx * 12 + nx * 7, by + sy * 12 + ny * 7, 2, A, oA);
      lb.seg2(bx, by, bx + sx * 12 - nx * 7, by + sy * 12 - ny * 7, 2, A, oA);
    }
    // HQ marker at the centre
    polyB(lb, CX, CY, 9, 4, Math.PI / 4, 1.6, Oh, oA);
    polyB(lb, CX, CY, 16, 6, 0, 1, O, oA * 0.6);

    // UN force echoes
    const shown = this.units.map((u, i) => {
      const [bNow] = this.unitBR(u, t);
      const tp = passT(bNow), age = t - tp;
      const [b, r] = this.unitBR(u, tp);
      const e = smoothstep(0.3, 1, au.mel(tp, u.band));
      const x = CX + Math.sin(b) * r * RS, y = CY - Math.cos(b) * r * RS;
      const dead = u.lost <= t, dying = u.lost <= t && t - u.lost < 0.6;
      return { u, i, b, r, x, y, e, age, tp, dead, dying };
    });
    for (const s of shown) {
      const glow = Math.exp(-s.age / 0.45), fade = 0.3 + 0.7 * Math.exp(-s.age / 1.1);
      const sz = 4 + 9 * s.e;
      if (s.dead) {
        const k = s.dying ? 1 : 0.45;
        const col = s.dying && fi % 4 < 2 ? BN : RED;
        const z = 8 + (s.dying ? 14 * pulse(t, s.u.lost, 0.12) : 0);
        lb.seg2(s.x - z, s.y - z, s.x + z, s.y + z, 2, col, oA * k);
        lb.seg2(s.x - z, s.y + z, s.x + z, s.y - z, 2, col, oA * k);
        if (s.dying) arcB(lb, s.x, s.y, 10 + (t - s.u.lost) * 160, 2, RED, oA * (1 - (t - s.u.lost) / 0.6), 0, TAU, 28);
        continue;
      }
      const col = lc('orange', 0.9 + 2.2 * glow);
      // the radar paint: a short arc smeared along the bearing, sized by the echo
      const span = (sz * 1.6) / Math.max(40, s.r * RS);
      arcB(lb, CX, CY, s.r * RS, 2 + 3 * s.e, lc('amber', 0.5 + 1.2 * glow), oA * fade * 0.6, s.b - span, s.b + span, 6);
      // NATO-ish symbol per type
      const ty = s.u.type;
      if (ty === 'VTOL') arcB(lb, s.x, s.y, sz * 0.8, 1.6, col, oA * fade, 0, TAU, 12);
      else if (ty === 'TANK') polyB(lb, s.x, s.y, sz, 3, 0, 1.6, col, oA * fade);
      else if (ty === 'MLRS') polyB(lb, s.x, s.y, sz, 4, Math.PI / 4, 1.6, col, oA * fade);
      else if (ty === 'SAM') { polyB(lb, s.x, s.y, sz, 4, 0, 1.6, col, oA * fade); lb.seg2(s.x, s.y - sz, s.x, s.y + sz, 1, col, oA * fade); }
      else { polyB(lb, s.x, s.y, sz * 1.1, 6, 0, 1.6, lc('amber', 1 + 2 * glow), oA * fade); lb.seg2(s.x - 3, s.y, s.x + 3, s.y, 2, col, oA * fade); }
    }

    // the Angel: track history (one fix per past sweep), predicted path, echo + hex marker
    {
      let px = AX, py = AY;
      for (let k = 1; k <= 7; k++) {
        const [hx, hy] = this.angelXY(aTp - k * BAR);
        const x = CX + hx * RS, y = CY + hy * RS;
        if (Math.hypot(hx, hy) > 1) break;
        lb.seg2(px, py, x, y, 1, CYN, oA * 0.45);
        polyB(lb, x, y, 3.5, 4, 0, 1.4, CYN, oA * (0.8 - k * 0.09));
        px = x; py = y;
      }
      dashB(lb, AX, AY, CX, CY, 8, 7, 1.2, CYN, oA * 0.5, -t * 40);
      const glow = Math.exp(-aAge / 0.5);
      const cc = lc('cyan', 1.4 + 2.2 * glow);
      const S = 11 + 16 * aE;
      polyB(lb, AX, AY, S, 4, 0, 2.4, cc, oA);
      polyB(lb, AX, AY, S * 0.45, 4, 0, 2, cc, oA);
      polyB(lb, AX, AY, 30 + 8 * aE, 6, t * 0.8, 1.2, CYN, oA * 0.8);
      const span = (S * 1.8) / Math.max(40, this.angelR(aTp) * RS);
      arcB(lb, CX, CY, this.angelR(aTp) * RS, 3 + 5 * aE, lc('cyan', 0.6 + 1.4 * glow), oA * 0.6, aB - span, aB + span, 8);
    }
    // the attack (strong claps): beam to the unit it destroys, A.T. field octagons
    if (kill && kAgeK < 0.4) {
      const u = this.units[kill.u]!, [ux, uy] = this.unitXY(u, kill.t);
      const ax = CX + kill.ax * RS, ay = CY + kill.ay * RS, tx = CX + ux * RS, ty = CY + uy * RS;
      const k = Math.exp(-kAgeK / 0.1);
      lb.seg2(ax, ay, tx, ty, 2 + 6 * k, lc('red', 1 + 3 * k), k);
      lb.seg2(ax, ay, tx, ty, 1.2, BN, k);
      for (let j = 0; j < 3; j++) {
        const rr = 30 + kAgeK * 260 - j * 14;
        if (rr > 0) polyB(lb, ax, ay, rr, 8, Math.PI / 8, j ? 1.2 : 2, j ? CYN : RED, (1 - kAgeK / 0.4) ** 2 * (1 - j * 0.3));
      }
    }
    lb.render(renderer, out);

    // ============================================== Canvas: panels, labels, readouts
    const L = this.L; L.clear();
    const c = L.ctx;
    c.textBaseline = 'alphabetic';
    chrome(c, t, au, {
      no: '04', en: 'TACTICAL RADAR', jpText: '戦術レーダー 第3新東京市', sub: 'TOP-DOWN SURVEILLANCE  //  RANGE 40 KM  //  SWEEP 1 REV/BAR  //  使徒接近中',
      reveal: prog(lt, 0, 0.3, ease.outCubic),
      tick: 'ANGEL APPROACHING FROM SAGAMI BAY // PATTERN BLUE CONFIRMED // UN FORCES ENGAGING // 第一種戦闘配置 // ALL PERSONNEL TO LEVEL 1 BATTLE STATIONS // 国連軍 迎撃開始 // TOKYO-3 DEFENCE SYSTEM ONLINE',
    });

    // ---- centre panel frame (transparent: the scope is GL underneath)
    c.globalAlpha = on(0);
    panel(c, 424, 120, 1072, 896, { title: 'TACTICAL', jp: '戦術状況表示', cut: 22, fill: 'rgba(0,0,0,0)' });
    // bearing numbers
    c.font = font(F.mono(600), 13); c.fillStyle = rgba('orange', 0.95); c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let i = 0; i < 36; i += 3) {
      const b = i * 10 * DEG;
      c.fillText(String(i * 10).padStart(3, '0'), CX + Math.sin(b) * 416, CY - Math.cos(b) * 416);
    }
    c.font = jp(15, 700, false);
    [['北', 0], ['東', 90], ['南', 180], ['西', 270]].forEach(([k, d]) => {
      const b = (d as number) * DEG + 5.5 * DEG;
      c.fillText(k as string, CX + Math.sin(b) * 418, CY - Math.cos(b) * 418);
    });
    // range labels along the north-west radial
    c.font = font(F.mono(500), 11); c.fillStyle = rgba('orange', 0.7); c.textAlign = 'left';
    for (let k = 1; k <= 5; k++) {
      const rr = (RS * k) / 5, b = -12 * DEG;
      c.fillText(`${(KM * k) / 5}`, CX + Math.sin(b) * rr + 3, CY - Math.cos(b) * rr + 8);
    }
    c.fillText('KM', CX + Math.sin(-12 * DEG) * RS + 22, CY - Math.cos(-12 * DEG) * RS + 8);
    // HQ label
    c.font = font(F.mono(700), 10); c.fillStyle = rgba('orange', 0.95); c.letterSpacing = '1.5px';
    c.fillText('NERV HQ', CX + 20, CY + 26); c.letterSpacing = '0px';
    c.font = jp(11, 600, false); c.fillText('本部', CX + 20, CY + 40);
    // blip labels (fade with the echo)
    c.font = font(F.mono(600), 10); c.letterSpacing = '1px';
    for (const s of shown) {
      const dt = t - s.u.lost;
      const a = s.dead ? (dt < 1.2 ? 1 : 0.4) : 0.25 + 0.75 * Math.exp(-s.age / 0.9);
      c.globalAlpha = on(0) * a;
      c.fillStyle = s.dead ? rgba('red', 1) : rgba('orange', 1);
      c.textAlign = s.x > CX ? 'left' : 'right';
      const ox = s.x > CX ? 14 : -14;
      c.fillText(s.dead && dt < 1.2 ? `${s.u.id} LOST` : s.u.id, s.x + ox, s.y - 6);
    }
    c.letterSpacing = '0px'; c.globalAlpha = on(0);
    // the Angel tag: leader line + box
    {
      const lx = AX + 70, ly = AY - 86;
      c.strokeStyle = rgba('cyan', 0.9); c.lineWidth = 1.2;
      c.beginPath(); c.moveTo(AX + 22, AY - 22); c.lineTo(lx - 10, ly + 26); c.lineTo(lx, ly + 26); c.stroke();
      chamferPath(c, lx, ly - 4, 196, 60, [0, 10, 0, 10]);
      c.fillStyle = kp > 0.3 ? rgba('red', 0.9) : 'rgba(0,10,16,0.82)'; c.fill();
      c.strokeStyle = rgba(kp > 0.3 ? 'red' : 'cyan', 1); c.stroke();
      c.fillStyle = kp > 0.3 ? rgba('ink', 1) : rgba('cyan', 1);
      c.font = font(F.mono(700), 13); c.letterSpacing = '2px'; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
      c.fillText('TARGET  使徒', lx + 10, ly + 14);
      c.font = font(F.mono(500), 11); c.letterSpacing = '1px';
      c.fillText(`RNG ${aRkm.toFixed(1)} KM  BRG ${(aB / DEG).toFixed(1).padStart(5, '0')}`, lx + 10, ly + 32);
      c.fillText('BLOOD TYPE: BLUE', lx + 10, ly + 48);
      c.letterSpacing = '0px';
    }
    // corner readouts inside the tactical panel
    meta(c, 444, 184, [['RANGE', `${KM} KM`], ['RING', `${KM / 5} KM`], ['SWEEP', `${(sweep / DEG).toFixed(1).padStart(5, '0')}°`], ['RPM', (60 / BAR).toFixed(2)]], { size: 12, keyW: 64 });
    {
      // top right: pulse counter
      c.fillStyle = rgba('orange', 0.85); c.font = font(F.mono(600), 11); c.letterSpacing = '2px'; c.textAlign = 'right';
      c.fillText('TX PULSE  送信', 1476, 180); c.letterSpacing = '0px';
      const ps = String(pulses).padStart(3, '0'), pw = ps.length * (30 * 0.52 + 3.6 * 1.2);
      sevenSeg(c, ps, 1476 - pw, 190, 30, rgba('amber', 1), rgba('orange', 0.08), { thick: 3.6 });
      segMeter(c, 1476 - 120, 230, 120, 8, 12, clamp(Math.exp(-kAge / 0.25)), { hotFrom: 2 });
      c.textAlign = 'left';
    }
    {
      // bottom left: legend
      const lx = 446, ly = 900;
      const items: [number, number, string, string][] = [[0, 0, 'VTOL', typeJp('VTOL')], [3, 0, 'ARMOUR', typeJp('TANK')], [4, Math.PI / 4, 'MLRS', typeJp('MLRS')], [4, 0, 'SAM', typeJp('SAM')], [6, 0, 'N2 MINE', typeJp('N2')], [4, 0, 'ANGEL', '使徒']];
      c.font = font(F.mono(600), 11); c.letterSpacing = '1.5px'; c.lineWidth = 1.4;
      items.forEach(([n, rot, en, j], i) => {
        const col = rgba(en === 'ANGEL' ? 'cyan' : 'orange', 0.95), yy = ly - 16 + i * 19;
        c.fillStyle = col; c.strokeStyle = col;
        c.beginPath();
        if (n === 0) c.arc(lx + 6, yy - 4, 5, 0, TAU);
        else for (let k = 0; k <= n; k++) { const a = rot + (k / n) * TAU; c.lineTo(lx + 6 + Math.sin(a) * 6.5, yy - 4 - Math.cos(a) * 6.5); }
        c.stroke();
        c.fillText(en, lx + 22, yy); c.font = jp(11, 600, false); c.fillText(j, lx + 106, yy); c.font = font(F.mono(600), 11);
      });
      c.letterSpacing = '0px';
    }
    {
      // bottom right: defence line status
      const x = 1476, y = 930;
      const col = breach ? 'red' : 'orange';
      c.textAlign = 'right';
      if (breach && bp > 0.2 && fi % 6 < 3) { c.fillStyle = rgba('red', 1); c.fillRect(x - 214, y - 20, 216, 50); }
      c.fillStyle = breach && bp > 0.2 && fi % 6 < 3 ? rgba('ink', 1) : rgba(col, 1);
      c.font = font(F.mono(700), 13); c.letterSpacing = '2px';
      c.fillText(breach ? 'DEFENCE LINE BREACHED' : 'DEFENCE LINE HOLDING', x - 6, y);
      c.font = jp(16, 700, false); c.letterSpacing = '0px';
      c.fillText(breach ? '第2防衛線 突破' : '第2防衛線 維持', x - 6, y + 22);
      c.font = font(F.mono(500), 11); c.fillStyle = rgba('orange', 0.75); c.letterSpacing = '1.5px';
      c.fillText(`ZONE 2  ${(KM * 0.4).toFixed(0)} KM`, x - 6, y + 56); c.letterSpacing = '0px';
      c.textAlign = 'left';
    }
    c.globalAlpha = 1;

    // ============================================== left column
    // contact list: sorted by bearing, so the lit row runs down the list as the beam turns
    c.globalAlpha = on(4);
    const cl = panel(c, 56, 120, 344, 508, { title: 'CONTACTS', jp: '探知目標', cut: 16 });
    {
      const x = cl.x, lead = 21;
      c.font = font(F.mono(600), 11); c.letterSpacing = '1px'; c.fillStyle = rgba('orange', 0.6);
      c.fillText('ID     TYPE   BRG    RNG   RET', x + 2, cl.y + 10);
      c.fillRect(x, cl.y + 16, cl.w, 1);
      const rows = [...shown].sort((a, b) => a.b - b.b);
      // pinned: the Angel
      let y = cl.y + 36;
      {
        const fl = aAge < 0.12;
        c.fillStyle = rgba('cyan', fl ? 1 : 0.18); c.fillRect(x - 2, y - 14, cl.w + 4, 19);
        c.fillStyle = fl ? rgba('ink', 1) : rgba('cyan', 1);
        c.font = font(F.mono(700), 12.5); c.letterSpacing = '0.5px';
        c.fillText(`ANGEL  BLUE   ${(aB / DEG).toFixed(1).padStart(5, '0')}  ${aRkm.toFixed(1).padStart(4, ' ')}`, x + 2, y);
        segMeter(c, x + cl.w - 52, y - 10, 50, 11, 5, aE, { color: fl ? rgba('ink', 1) : rgba('cyan', 1), hotFrom: 2, dim: rgba('cyan', 0.15), gap: 2 });
      }
      y += lead + 2;
      c.font = font(F.mono(500), 12.5);
      for (const s of rows) {
        const fl = !s.dead && s.age < 0.1;
        const rd = s.dead;
        if (fl) { c.fillStyle = rgba('orange', 0.9); c.fillRect(x - 2, y - 14, cl.w + 4, 19); }
        if (s.dying && fi % 4 < 2) { c.fillStyle = rgba('red', 0.9); c.fillRect(x - 2, y - 14, cl.w + 4, 19); }
        const txtCol = fl || (s.dying && fi % 4 < 2) ? rgba('ink', 1) : rd ? rgba('red', 0.9) : rgba('orange', 0.45 + 0.5 * Math.exp(-s.age / 0.8));
        c.fillStyle = txtCol;
        const brg = (s.b / DEG).toFixed(1).padStart(5, '0'), rng = (s.r * KM).toFixed(1).padStart(4, ' ');
        c.fillText(`${s.u.id.padEnd(6)} ${s.u.type.padEnd(5)}  ${brg}  ${rng}`, x + 2, y);
        if (rd) { c.font = font(F.mono(700), 11); c.fillText('LOST 喪失', x + cl.w - 66, y); c.font = font(F.mono(500), 12.5); }
        else segMeter(c, x + cl.w - 52, y - 10, 50, 11, 5, s.e, { color: fl ? rgba('ink', 1) : rgba('orange', 1), hotFrom: 0.8, dim: rgba('orange', 0.1), gap: 2 });
        y += lead;
      }
      c.letterSpacing = '0px';
    }
    // A-scope: range trace on the beam's bearing (grass = the real waveform, echoes = contacts)
    const as = panel(c, 56, 644, 344, 200, { title: 'A-SCOPE', jp: '距離反射', cut: 16 });
    {
      const x = as.x, y = as.y, w = as.w, h = as.h - 26, base = y + h;
      c.strokeStyle = rgba('orange', 0.15); c.lineWidth = 1; c.beginPath();
      for (let i = 0; i <= 10; i++) { c.moveTo(x + (w * i) / 10, y); c.lineTo(x + (w * i) / 10, base); }
      for (let i = 0; i <= 4; i++) { c.moveTo(x, y + (h * i) / 4); c.lineTo(x + w, y + (h * i) / 4); }
      c.stroke();
      const echoes: [number, number, boolean][] = [];
      for (const s of shown) if (!s.dead) { const db = Math.abs(((sweep - s.b + Math.PI * 3) % TAU) - Math.PI); if (db < 14 * DEG) echoes.push([s.r, s.e * (1 - db / (14 * DEG)), false]); }
      { const db = Math.abs(((sweep - aB + Math.PI * 3) % TAU) - Math.PI); if (db < 14 * DEG) echoes.push([this.angelR(t), (0.6 + 0.4 * aE) * (1 - db / (14 * DEG)), true]); }
      const N = 220, pts: number[] = [];
      for (let i = 0; i <= N; i++) {
        const u = i / N;
        au.waveAt(t - 0.05 + u * 0.05, this.wv);
        let v = Math.abs(this.wv[0] + this.wv[1]) * 0.5 * 0.35 * (1 - 0.6 * u) + 0.02;
        for (const [er, ee] of echoes) v += ee * 0.85 * Math.exp(-(((u - er) / 0.012) ** 2));
        pts.push(base - clamp(v, 0, 1.05) * h * 0.92);
      }
      c.beginPath(); c.moveTo(x, base);
      pts.forEach((py, i) => c.lineTo(x + (w * i) / N, py));
      c.lineTo(x + w, base); c.closePath(); c.fillStyle = rgba('orange', 0.14); c.fill();
      c.beginPath(); pts.forEach((py, i) => (i ? c.lineTo(x + (w * i) / N, py) : c.moveTo(x, py)));
      c.strokeStyle = rgba('amber', 1); c.lineWidth = 1.5; c.stroke();
      for (const [er, ee, ang] of echoes) if (ang && ee > 0.2) {
        c.fillStyle = rgba('cyan', 1); c.fillRect(x + er * w - 1, y, 2, h);
        c.font = font(F.mono(700), 10); c.fillText('ANGEL', x + er * w + 4, y + 10);
      }
      c.font = font(F.mono(500), 10); c.fillStyle = rgba('orange', 0.7); c.letterSpacing = '1px';
      for (let i = 0; i <= 4; i++) { c.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center'; c.fillText(`${i * 10}`, x + (w * i) / 4, base + 13); }
      c.textAlign = 'left'; c.letterSpacing = '0px';
      c.font = font(F.mono(600), 11); c.fillStyle = rgba('orange', 0.9); c.letterSpacing = '1.5px'; c.textAlign = 'right';
      c.fillText(`BEAM ${(sweep / DEG).toFixed(0).padStart(3, '0')}°  RANGE KM`, x + w - 2, y + 12);
      c.fillText(`ECHO ${String(echoes.length).padStart(2, '0')}`, x + w - 2, y + 28); c.textAlign = 'left'; c.letterSpacing = '0px';
    }
    // transmitter: pulse power + a hat-stepped log
    const tx = panel(c, 56, 860, 344, 156, { title: 'TRANSMITTER', jp: '送信機', cut: 16 });
    {
      c.fillStyle = rgba('orange', 0.85); c.font = font(F.mono(600), 11); c.letterSpacing = '1.5px';
      c.fillText('PWR', tx.x, tx.y + 10); c.letterSpacing = '0px';
      segMeter(c, tx.x + 36, tx.y + 2, tx.w - 36, 10, 30, clamp(0.25 + 0.75 * f.a.rms + 0.25 * Math.exp(-kAge / 0.15)), { hotFrom: 0.9 });
      c.font = font(F.mono(500), 11.5); c.letterSpacing = '0.5px';
      for (let r = 0; r < 4; r++) {
        const s = hats - r;
        c.fillStyle = rgba('orange', r === 0 ? 0.95 : 0.5 - r * 0.08);
        c.fillText(`${(0x5c00 + s * 16).toString(16).toUpperCase()} TX ${hexData(s, 5, 6)} RX ${hexData(s, 6, 6)} ${['OK', 'OK', 'ECHO', 'OK', 'SYNC'][((s % 5) + 5) % 5]}`, tx.x, tx.y + 32 + r * 19);
      }
      c.letterSpacing = '0px';
    }

    // ============================================== right column
    c.globalAlpha = on(6);
    const tg = panel(c, 1520, 120, 344, 408, { title: 'TARGET', jp: '目標', cut: 16, color: rgba(kp > 0.3 ? 'red' : 'cyan', 1) });
    {
      const x = tg.x, y = tg.y;
      c.fillStyle = rgba('cyan', 1); c.font = jp(52, 800, true); c.textBaseline = 'alphabetic';
      c.fillText('使徒', x, y + 50);
      c.font = font(F.mono(700), 14); c.letterSpacing = '3px'; c.fillText('ANGEL', x + 122, y + 22);
      c.font = font(F.mono(500), 11); c.letterSpacing = '1.5px'; c.fillStyle = rgba('cyan', 0.8);
      c.fillText('CLASS: UNKNOWN', x + 122, y + 40); c.fillText('CONTACT 001', x + 122, y + 55); c.letterSpacing = '0px';
      c.fillStyle = rgba('cyan', 0.85); c.font = font(F.mono(600), 11); c.letterSpacing = '2px';
      c.fillText('RANGE  距離', x, y + 84); c.letterSpacing = '0px';
      const rw = sevenSeg(c, aRkm.toFixed(2).padStart(5, '0'), x, y + 94, 58, rgba('cyan', 1), rgba('cyan', 0.07), { thick: 6.5 });
      c.font = font(F.mono(700), 18); c.fillText('KM', x + rw + 10, y + 150);
      const spd = 180 + 60 * aE;
      meta(c, x, y + 186, [
        ['BEARING', `${(aB / DEG).toFixed(2)}°`],
        ['SPEED', `${spd.toFixed(0)} KM/H`],
        ['ALTITUDE', `${(0.12 + 0.03 * aE).toFixed(3)} KM`],
        ['A.T. FIELD', kp > 0.1 ? 'DEPLOYED' : 'DETECTED'],
      ], { size: 12, keyW: 96, color: rgba('cyan', 1) });
      // BLOOD TYPE: BLUE bar
      c.fillStyle = rgba('cyan', 0.95); c.fillRect(x, y + 256, tg.w, 26);
      c.fillStyle = rgba('ink', 1); c.font = font(F.mono(700), 14); c.letterSpacing = '2px';
      c.fillText('BLOOD TYPE: BLUE', x + 8, y + 274); c.letterSpacing = '0px';
      c.font = jp(14, 700, false); c.textAlign = 'right'; c.fillText('パターン青', x + tg.w - 8, y + 274); c.textAlign = 'left';
      // signature: 2 s of the bass envelope
      const sy = y + 298, sh = tg.h - 300;
      c.strokeStyle = rgba('cyan', 0.15); c.lineWidth = 1; c.strokeRect(x, sy, tg.w, sh);
      c.beginPath();
      for (let i = 0; i <= 120; i++) {
        const v = au.env('bass', t - 2 + (i / 120) * 2) * 0.7 + au.env('low', t - 2 + (i / 120) * 2) * 0.3;
        const px = x + (tg.w * i) / 120, py = sy + sh - 4 - clamp(v) * (sh - 8);
        if (i) c.lineTo(px, py); else c.moveTo(px, py);
      }
      c.strokeStyle = rgba('cyan', 1); c.lineWidth = 1.5; c.stroke();
      c.font = font(F.mono(500), 10); c.fillStyle = rgba('cyan', 0.75); c.letterSpacing = '1px';
      c.fillText('SIGNATURE  固有波形', x + 4, sy + 12); c.letterSpacing = '0px';
    }
    // the warning: blinks on every clap, the strong ones hardest
    warningBox(c, 1520, 544, 344, 150, breach ? 'BREACH' : 'WARNING', breach ? '防衛線突破' : '使徒接近中', {
      blink: 0.22 + 0.78 * clamp(cp * 1.1 + bp), phase: countB(au, 'snare', T.s, t, 0.5) * 26,
    });
    // UN forces tally + time to contact
    const un = panel(c, 1520, 710, 344, 306, { title: 'UN FORCES', jp: '国連軍', cut: 16 });
    {
      const x = un.x, y = un.y, act = this.units.length - lost;
      c.font = font(F.mono(600), 11); c.letterSpacing = '2px';
      c.fillStyle = rgba('orange', 1); c.fillText('ACTIVE 稼働', x, y + 10);
      sevenSeg(c, String(act).padStart(2, '0'), x, y + 20, 48, rgba('amber', 1), rgba('orange', 0.07));
      c.fillStyle = rgba('red', 1); c.fillText('LOST 喪失', x + 170, y + 10);
      const lostHot = kill && kAgeK < 0.3 && fi % 4 < 2;
      sevenSeg(c, String(lost).padStart(2, '0'), x + 170, y + 20, 48, rgba(lostHot ? 'bone' : 'red', 1), rgba('red', 0.07));
      c.letterSpacing = '0px';
      // unit strip: one cell per unit, red once lost
      const cw = un.w / this.units.length;
      this.units.forEach((u, i) => {
        const dead = u.lost <= t;
        c.fillStyle = dead ? rgba('red', u.lost > t - 0.3 && fi % 4 < 2 ? 1 : 0.85) : rgba('orange', 0.75);
        c.fillRect(x + i * cw + 1, y + 82, cw - 2, 12);
      });
      c.fillStyle = rgba('orange', 0.3); c.fillRect(x, y + 106, un.w, 1);
      // time to contact: the Angel's range at its closing speed
      const ttc = Math.max(0, T.e - t); // contact at the plate's last downbeat
      const ss = Math.floor(ttc), cs = Math.floor((ttc - ss) * 100);
      c.font = font(F.mono(600), 11); c.letterSpacing = '2px'; c.fillStyle = rgba(breach ? 'red' : 'orange', 1);
      c.fillText('TIME TO CONTACT', x, y + 128); c.letterSpacing = '0px';
      c.font = jp(13, 700, false); c.fillText('接触まで', x + 170, y + 128);
      const hot = ttc < 60 / au.bpm && fi % 6 < 3;
      sevenSeg(c, `${String(Math.min(99, ss)).padStart(2, '0')}:${String(cs).padStart(2, '0')}`, x, y + 140, 62, rgba(hot ? 'bone' : breach ? 'red' : 'amber', 1), rgba('orange', 0.07), { thick: 7 });
      segMeter(c, x, y + 216, un.w, 12, 34, clamp(1 - this.angelR(t) / 0.95), { hotFrom: 0.72 });
      c.font = font(F.mono(500), 10); c.fillStyle = rgba('orange', 0.7); c.letterSpacing = '1px';
      c.fillText('APPROACH  接近率', x, y + 246);
      c.textAlign = 'right'; c.fillText(`${(clamp(1 - this.angelR(t) / 0.95) * 100).toFixed(1)} %`, x + un.w, y + 246); c.textAlign = 'left';
      c.letterSpacing = '0px';
    }
    c.globalAlpha = 1;

    comp.draw(renderer, L.upload(), out);
    this.scan.u.t!.value = t;
    this.scan.render(renderer, out);

    return {
      bloom: 0.6, bloomThreshold: 0.62, halation: 0.08, vignette: 0.42, grain: 0.05,
      ca: 0.8 + 1.6 * cp + 2.5 * kp + 3 * Math.exp(-lt / 0.12) + 2 * bp,
      flash: 0.2 * Math.exp(-lt / 0.09) + 0.03 * bp * bp,
      zoom: 1 + 0.025 * Math.exp(-lt / 0.15) + 0.004 * dk,
    };
  }
}
