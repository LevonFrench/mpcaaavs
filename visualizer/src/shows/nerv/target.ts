// Ported from bizarro/evangelion app/src/scenes/target.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// target — "POSITRON RIFLE" (drop 2 cont., bars 60–65, 112.82 – 121.82 s; drums + bass, no pads).
// Operation Yashima through the sniper scope: the Angel (a cyan wireframe octahedron) drifts with
// the bass inside a big reticle; the scope's bezel is the live mel spectrum, the horizontal hair
// carries the real waveform. The lock tightens and the rifle charges over each 2-bar phrase, then
// FIRES (bars 62, 64 and the last beat): a white beam along the aim line, flash, shake. Kicks snap
// the lock brackets and bounce the rings, claps pulse an A.T. FIELD ripple and the warning box,
// hats step the correction readouts and the data rows.
import * as THREE from 'three';
import { Scene, type Frame, type PostOverrides } from '../../show/scene.ts';
import { FSPass, Layer2D } from '../../show/gl.ts';
import { LineBatch } from '../../show/lines.ts';
import { rgba } from '../../show/palette.ts';
import { F, font } from '../../show/type.ts';
import { clamp, ease, hash, noise1, prog, pulse, smoothstep, springStep, TAU, frameIdx } from '../../show/util.ts';
import { barTime, condensed, duck, evaLabel, hexData, jp, makeScanPass, panel, segMeter, sevenSeg, ticker, warningBox, GLSL_EVA } from './_eva.ts';
import { arc2, brackets2, dash2, lastOnset, lc, melSmooth, onsetCount } from './target-kit.ts';

const CX = 800, CY = 548, R = 360;

export default class Target extends Scene {
  bg = new FSPass(/* glsl */ `
    ${GLSL_EVA}
    uniform float t, R, dim, fire, ridge;
    uniform vec2 C;
    void main() {
      vec2 p = vec2(FRAG_PX.x, 1080.0 - FRAG_PX.y);
      vec3 col = C_INK;
      // dot grid outside the scope
      vec2 g = mod(p, 30.0) - 15.0;
      col += C_ORANGE * 0.05 * pxLine(length(g), 0.6, 1.6);
      float d = length(p - C);
      if (d < R) {
        vec3 s = C_INK * 0.6;
        // faint hex field in the sky
        vec4 hc = hexCell(p - C, 30.0);
        s += C_ORANGE * 0.035 * pxLine(hexEdge(hc.xy, 30.0), 0.5, 1.5);
        // the Yashima ridge: a dark plateau under a bright contour
        float x = p.x;
        float ry = C.y + 150.0 + 34.0 * sin(x * 0.011 + 1.3) + 18.0 * sin(x * 0.031) + 60.0 * smoothstep(C.x - 120.0, C.x + 330.0, x) - 50.0 * smoothstep(C.x - 400.0, C.x - 120.0, x);
        if (p.y > ry) {
          s = C_INK2 * 0.7;
          s += C_ORANGE * 0.07 * pxLine(abs(mod(p.y - ry, 7.0) - 3.5), 0.4, 1.2) * smoothstep(0.0, 80.0, p.y - ry);
          s += C_ORANGE * (0.55 + 0.4 * ridge) * pxLine(p.y - ry, 0.8, 2.0);
        }
        // tower lights on the far city behind the ridge
        float lx = floor(x / 9.0);
        float lh = hash11(lx) * 40.0;
        if (p.y < ry && p.y > ry - lh && hash11(lx * 3.1) > 0.55) s += C_ORANGE * 0.035;
        // rim darkening, and the fire bloom around the aim point
        s *= 1.0 - 0.6 * smoothstep(R * 0.72, R, d);
        s += C_BONE * fire * 0.5 * exp(-d / 180.0);
        col = s * dim;
      }
      fragColor = vec4(col, 1.0);
    }`, { t: { value: 0 }, R: { value: R }, C: { value: new THREE.Vector2(CX, CY) }, dim: { value: 1 }, fire: { value: 0 }, ridge: { value: 0 } });
  lb = new LineBatch(24000);
  text = new Layer2D();
  scan = makeScanPass(0.24);
  mel = new Float32Array(48);
  fires: number[] = [];
  b: number[] = [];

  override init() {
    const au = this.ctx.audio;
    for (let k = 60; k <= 65; k++) this.b[k] = barTime(au, k);
    const beat = 60 / au.bpm;
    this.fires = [this.b[62]!, this.b[64]!, this.b[65]! - beat];
  }

  render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides {
    const { renderer, audio: au } = this.ctx;
    const t = f.t, B = this.b, FI = this.fires;
    const d = duck(f, au);
    const bass = clamp(au.env('bass', t) * 1.2);

    // ---- phrase clock: charge + lock build over each phrase, then FIRE
    let ph = 0; while (ph < FI.length && t >= FI[ph]!) ph++;
    const lastFire = ph > 0 ? FI[ph - 1]! : -1e9;
    const pStart = ph === 0 ? this.ctx.start : lastFire + 0.35;
    const pEnd = ph < FI.length ? FI[ph]! : this.ctx.end + 1;
    const charge = ph >= FI.length ? clamp(1 - (t - lastFire) / 0.3) : prog(t, pStart, pEnd, ease.inQuad) * (t < lastFire + 0.35 ? 0 : 1);
    const lock = ph >= FI.length ? 1 : Math.max(prog(t, pStart + 0.2, pEnd - 0.3, ease.inOutCubic), 1 - prog(t, lastFire + 0.45, lastFire + 1.5, ease.inOutCubic));
    const tf = t - lastFire, fp = tf >= 0 ? pulse(t, lastFire, 0.09) : 0, fireHold = tf >= 0 && tf < 0.6 ? 1 : 0;

    // ---- the kick snap, clap ripple, hat steps
    const kT = lastOnset(au, 'kick', t, 0.5), kk = t - kT;
    const snap = 1 - springStep(kk, 3.2, 0.42);
    const cT = lastOnset(au, 'snare', t, 0.4), cp = pulse(t, cT, 0.13);
    const hats = onsetCount(au, 'hat', this.ctx.start - 2, t);
    const fi = frameIdx(t);

    // ---- target drift (bass = mass): wanders off the crosshair until the lock pulls it in
    const wob = 1 - lock;
    const TX = CX + wob * (noise1(t * 0.55, 3) * 230 + Math.sin(t * 1.7) * 60 * bass) + (tf >= 0 && tf < 0.5 ? (hash(fi, 1) - 0.5) * 16 * fp : 0);
    const TY = CY + wob * (noise1(t * 0.43, 7) * 120 - 40);
    const dist = Math.hypot(TX - CX, TY - CY);
    const locked = dist < 8;
    const bright = 1 - 0.18 * d;

    // ================================================================ GL: background
    this.bg.u.t!.value = t;
    this.bg.u.dim!.value = bright;
    this.bg.u.fire!.value = fp;
    this.bg.u.ridge!.value = bass;
    this.bg.render(renderer, out);

    // ================================================================ GL: scope lines
    const lb = this.lb; lb.clear();
    const O = lc('orange', 1.05 * bright), Oh = lc('orange', 1.6 * bright), A = lc('amber', 1.2), RED = lc('red', 1.5), CY_ = lc('cyan', 1.8), BN = lc('bone', 3);
    const r0 = R * (1 - 0.012 * d);
    arc2(lb, CX, CY, r0, 2.4, Oh, 1, 0, TAU, 180);
    arc2(lb, CX, CY, r0 - 10, 1, O, 0.5, 0, TAU, 180);
    for (const k of [0.25, 0.5, 0.75]) arc2(lb, CX, CY, r0 * k * (1 + 0.03 * bass * k), 1, O, 0.32, 0, TAU, 120);
    // rotating azimuth bezel: ticks every 2 degrees just inside the rim
    const az = 0.35 * Math.sin(t * 0.21) + (TX - CX) * 0.0012;
    for (let i = 0; i < 180; i++) {
      const a = az + (i / 180) * TAU, mj = i % 5 === 0, l = mj ? 16 : 7;
      const ca = Math.cos(a), sa = Math.sin(a);
      lb.seg2(CX + ca * (r0 - 10), CY + sa * (r0 - 10), CX + ca * (r0 - 10 - l), CY + sa * (r0 - 10 - l), mj ? 1.6 : 1, O, mj ? 0.9 : 0.5);
    }
    // the mel spectrum as a halo around the scope (low bands at the top, mirrored left/right)
    melSmooth(au, t, this.mel, 0.04, 3);
    for (let i = 0; i < 96; i++) {
      const band = i < 48 ? i : 95 - i, m = smoothstep(0.3, 1, this.mel[band]!);
      const a = -Math.PI / 2 + ((i + 0.5) / 96) * TAU, ca = Math.cos(a), sa = Math.sin(a);
      const r1 = R + 18, len = 3 + 46 * m * (1 - 0.25 * d);
      lb.seg2(CX + ca * r1, CY + sa * r1, CX + ca * (r1 + len), CY + sa * (r1 + len), 5.5, m > 0.86 ? RED : O, 0.45 + 0.55 * m);
    }
    arc2(lb, CX, CY, R + 12, 1, O, 0.4, 0, TAU, 160);
    // crosshair: heavy posts outside, hairlines inside, mil ticks
    const gap = 26 + 30 * (1 - lock);
    for (const [ux, uy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      lb.seg2(CX + ux * r0, CY + uy * r0, CX + ux * r0 * 0.62, CY + uy * r0 * 0.62, 7, Oh, 0.95);
      lb.seg2(CX + ux * r0 * 0.62, CY + uy * r0 * 0.62, CX + ux * gap, CY + uy * gap, 1.2, Oh, 0.9);
      for (let k = 1; k * 18 < r0 * 0.62; k++) {
        const s = k * 18, l = k % 5 === 0 ? 11 : 5;
        if (s < gap) continue;
        lb.seg2(CX + ux * s - uy * l, CY + uy * s - ux * l, CX + ux * s + uy * l, CY + uy * s + ux * l, 1, O, 0.7);
      }
    }
    arc2(lb, CX, CY, 5, 1.4, Oh, 1, 0, TAU, 16);
    // the real waveform riding the horizontal hair (~70 ms window)
    {
      const n = 260, x0 = CX - r0 * 0.6, x1 = CX + r0 * 0.6, wv: [number, number] = [0, 0];
      let px = 0, py = 0;
      for (let i = 0; i <= n; i++) {
        const u = i / n, x = x0 + (x1 - x0) * u;
        au.waveAt(t - 0.035 + u * 0.07, wv);
        const env = Math.sin(Math.PI * u);
        const y = CY + 80 + ((wv[0] + wv[1]) * 0.5) * 70 * env;
        if (i) lb.seg2(px, py, x, y, 1.3, A, 0.75);
        px = x; py = y;
      }
      lb.seg2(x0, CY + 80, x1, CY + 80, 1, O, 0.18);
    }
    // aim line: from the rifle (lower right, beyond the rim) to the target
    const RX = CX + R * 0.78, RYY = CY + R * 0.63;
    dash2(lb, RX, RYY, TX, TY, 10, 8, 1, O, 0.55, -t * 60);
    if (tf >= 0 && tf < 0.6) {
      const k = Math.exp(-tf / 0.12);
      lb.seg2(RX + (RX - TX) * 0.4, RYY + (RYY - TY) * 0.4, TX, TY, 5 + 10 * k, BN, k);
      lb.seg2(RX + (RX - TX) * 0.4, RYY + (RYY - TY) * 0.4, TX, TY, 26 + 30 * k, lc('amber', 0.6), 0.5 * k);
      for (let j = 0; j < 4; j++) arc2(lb, TX, TY, 30 + tf * (300 + j * 180), 2 * k + 0.5, j % 2 ? A : BN, k * 0.9, 0, TAU, 64);
    }
    // clap: A.T. FIELD octagon ripple around the Angel
    if (cp > 0.02) {
      const rr = 70 + (t - cT) * 520;
      for (let s = 0; s < 3; s++) {
        const r2 = rr - s * 16;
        if (r2 <= 0) continue;
        for (let i = 0; i < 8; i++) {
          const a0 = (i / 8) * TAU + Math.PI / 8, a1 = ((i + 1) / 8) * TAU + Math.PI / 8;
          lb.seg2(TX + Math.cos(a0) * r2, TY + Math.sin(a0) * r2, TX + Math.cos(a1) * r2, TY + Math.sin(a1) * r2, 2, O, cp * (1 - s * 0.3));
        }
      }
    }
    // the Angel: a slowly turning wireframe octahedron (Ramiel), bass swells it
    {
      const S = 58 * (1 + 0.1 * bass) * (1 + 0.25 * fp), ang = t * 0.9, tl = 0.28;
      const V = [[0, -1.45, 0], [0, 1.45, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].map(([x, y, z]) => {
        const xr = x! * Math.cos(ang) - z! * Math.sin(ang), zr = x! * Math.sin(ang) + z! * Math.cos(ang);
        const yr = y! * Math.cos(tl) - zr * Math.sin(tl), z2 = y! * Math.sin(tl) + zr * Math.cos(tl);
        const k = 1 / (1 + z2 * 0.12);
        return [TX + xr * S * k, TY + yr * S * k, z2];
      });
      const E = [[0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [1, 3], [1, 4], [1, 5], [2, 4], [4, 3], [3, 5], [5, 2]];
      const cc = fp > 0.05 ? lc('bone', 2 + 3 * fp) : CY_;
      for (const [i, j] of E) {
        const p = V[i!]!, q = V[j!]!, back = (p[2]! + q[2]!) * 0.5 > 0.2;
        lb.seg2(p[0]!, p[1]!, q[0]!, q[1]!, back ? 1 : 2, cc, back ? 0.35 : 1);
      }
      arc2(lb, TX, TY, 6 + 3 * f.a.kick, 3, cc, 0.9, 0, TAU, 12);
    }
    // lock brackets: snap in on every kick, go red when locked
    {
      const s = (84 + 60 * wob) * (1 + 0.55 * snap);
      const col = locked ? RED : CY_;
      brackets2(lb, TX - s, TY - s, 2 * s, 2 * s, 22, 2.2, col, 0.95);
      // converging carets
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + Math.PI / 4, rr = s * 1.35;
        const ex = TX + Math.cos(a) * rr, ey = TY + Math.sin(a) * rr;
        const nx = -Math.sin(a) * 9, ny = Math.cos(a) * 9, ix = Math.cos(a) * 14, iy = Math.sin(a) * 14;
        lb.seg2(ex + nx + ix, ey + ny + iy, ex, ey, 1.6, col, 0.8);
        lb.seg2(ex - nx + ix, ey - ny + iy, ex, ey, 1.6, col, 0.8);
      }
      // tracking line target -> crosshair
      if (!locked) dash2(lb, CX, CY, TX, TY, 4, 5, 1, CY_, 0.6);
    }
    // ---- right: power-grid spectrum bars (the mel spectrum, one bar per band)
    const PX = 1290, PY = 930, PW_ = 550, PH_ = 160;
    for (let i = 0; i < 48; i++) {
      const m = smoothstep(0.25, 1, this.mel[i]!) * (1 - 0.2 * d);
      const x = PX + (i + 0.5) * (PW_ / 48), h = 4 + PH_ * m;
      lb.seg2(x, PY, x, PY - h, PW_ / 48 - 3.5, m > 0.85 ? RED : lc('amber', 0.9), 0.85);
      lb.seg2(x - 4, PY - h - 5, x + 4, PY - h - 5, 1.4, O, 0.8);
    }
    lb.render(renderer, out);

    // ================================================================ Canvas: HUD
    const L = this.text; L.clear();
    const c = L.ctx;
    c.textBaseline = 'alphabetic';
    // top header rule
    c.fillStyle = rgba('orange', 0.9); c.fillRect(60, 56, 1800, 2);
    evaLabel(c, 60, 44, 'nerv // tactical ops // sniper mode', undefined, { alpha: 0.85 });
    c.font = jp(16, 700, false); c.fillStyle = rgba('orange', 0.85); c.textAlign = 'right';
    c.fillText('狙撃モード　作戦進行中', 1860, 44); c.textAlign = 'left';
    const barNo = Math.floor(au.barAt(t)) - 2;
    evaLabel(c, 960, 44, `bar ${String(barNo).padStart(3, '0')} · ${(t - this.ctx.start).toFixed(2).padStart(5, '0')}s`, undefined, { align: 'center', alpha: 0.7 });

    // ---- left column: title card
    evaLabel(c, 60, 100, 'operation yashima', 'ヤシマ作戦', { color: rgba('orange', 1) });
    condensed(c, 'POSITRON', 56, 228, 104, { sx: 0.58, color: rgba('bone', 1) });
    condensed(c, 'RIFLE', 52, 396, 206, { sx: 0.56, color: rgba('bone', 1) });
    c.font = jp(38, 700, true); c.fillStyle = rgba('orange', 1); c.fillText('陽電子砲', 62, 450);

    // ---- left: target data panel
    {
      const r = panel(c, 60, 480, 300, 250, { title: 'target', jp: '目標' });
      const range = 8.72 - 0.9 * (1 - wob) + 0.05 * noise1(t * 2, 4);
      c.fillStyle = rgba('orange', 0.9); c.font = font(F.mono(600), 12); c.letterSpacing = '2px';
      c.fillText('RANGE  距離', r.x, r.y + 12);
      sevenSeg(c, range.toFixed(2), r.x, r.y + 22, 50, rgba('amber', 1), rgba('orange', 0.08));
      c.fillStyle = rgba('orange', 0.9); c.font = font(F.mono(600), 18); c.fillText('KM', r.x + 170, r.y + 70);
      const rows: [string, string][] = [
        ['AZIMUTH', `${(184.5 + (TX - CX) * 0.02).toFixed(2)}°`],
        ['ELEVATION', `${(12.4 - (TY - CY) * 0.015).toFixed(2)}°`],
        ['ALT', `${(1.34 + 0.02 * bass).toFixed(3)} KM`],
      ];
      c.font = font(F.mono(500), 14);
      rows.forEach(([k, v], i) => {
        const y = r.y + 104 + i * 22;
        c.fillStyle = rgba('orange', 0.7); c.fillText(k, r.x, y);
        c.fillStyle = rgba('amber', 1); c.textAlign = 'right'; c.fillText(v, r.x + r.w, y); c.textAlign = 'left';
      });
      // BLOOD TYPE: BLUE tag
      c.fillStyle = rgba('cyan', 0.95); c.fillRect(r.x, r.y + 166, r.w, 26);
      c.fillStyle = rgba('ink', 1); c.font = font(F.mono(700), 14); c.letterSpacing = '2px';
      c.fillText('BLOOD TYPE: BLUE', r.x + 8, r.y + 184);
      c.font = jp(14, 700, false); c.textAlign = 'right'; c.fillText('パターン青', r.x + r.w - 8, r.y + 184); c.textAlign = 'left';
      c.letterSpacing = '0px';
    }
    // clap: A.T. FIELD warning box
    warningBox(c, 60, 748, 300, 140, 'A.T.FIELD', 'ATフィールド 展開中', { blink: 0.25 + 0.75 * cp, phase: t * 30 + onsetCount(au, 'snare', this.ctx.start, t) * 26 });
    // hat-stepped hex rows
    c.font = font(F.mono(400), 12); c.letterSpacing = '1px';
    for (let r = 0; r < 4; r++) {
      const s = hats + r;
      c.fillStyle = rgba('orange', r === 0 ? 0.9 : 0.45);
      c.fillText(`${(0x7a00 + s * 16).toString(16).toUpperCase()} ${hexData(s, 3, 8)} ${hexData(s, 9, 6)}`, 62, 918 + r * 18);
    }
    c.letterSpacing = '0px';

    // ---- scope labels: bezel degrees, mil numbers, target tag
    c.font = font(F.mono(500), 11); c.fillStyle = rgba('orange', 0.75); c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let i = 0; i < 12; i++) {
      const a = az + (i / 12) * TAU, rr = R - 44;
      const deg = (Math.round(184 + i * 30) % 360).toString().padStart(3, '0');
      c.fillText(deg, CX + Math.cos(a) * rr, CY + Math.sin(a) * rr);
    }
    for (let k = 5; k * 18 < R * 0.62; k += 5) {
      c.fillText(String(k), CX + k * 18, CY - 20); c.fillText(String(k), CX - 20, CY - k * 18);
    }
    c.textBaseline = 'alphabetic'; c.textAlign = 'left';
    {
      const s = (84 + 60 * wob) * (1 + 0.55 * snap);
      const lx = TX + s + 14, ly = TY - s + 8;
      c.fillStyle = rgba(locked ? 'red' : 'cyan', 1);
      c.font = font(F.mono(700), 13); c.letterSpacing = '2px';
      c.fillText(locked ? 'LOCK ON' : 'TRACKING', lx, ly);
      c.font = jp(14, 700, false); c.fillText(locked ? '照準固定' : '目標追尾', lx, ly + 18);
      c.font = font(F.mono(500), 11); c.letterSpacing = '1px';
      c.fillText(`ERR ${(dist * 0.012).toFixed(3)} MRAD`, lx, ly + 36);
      c.letterSpacing = '0px';
    }
    // scope readouts on the glass
    c.font = font(F.mono(600), 12); c.letterSpacing = '2px'; c.fillStyle = rgba('orange', 0.8);
    c.fillText(`ZOOM ×${(24 + 8 * lock).toFixed(1)}`, CX - 150, CY - R + 92);
    c.textAlign = 'right'; c.fillText(`LOCK ${(lock * 100).toFixed(0).padStart(3, '0')}%`, CX + 150, CY - R + 92); c.textAlign = 'left';
    c.fillStyle = rgba('orange', 0.55); c.fillText('TARGET SIGNATURE // WAVEFORM', CX - R * 0.6, CY + 136);
    c.font = jp(12, 600, false); c.fillText('波形解析', CX - R * 0.6, CY + 154);
    c.letterSpacing = '0px';
    // FIRE caption in the scope
    if (fireHold) {
      const a = tf < 0.45 ? 1 : 1 - (tf - 0.45) / 0.15;
      c.globalAlpha = a;
      condensed(c, 'FIRE', CX - R * 0.62, CY - R * 0.28, 150, { sx: 0.58, color: rgba('red', 1) });
      c.font = jp(34, 800, true); c.fillStyle = rgba('red', 1); c.fillText('発射', CX - R * 0.6, CY - R * 0.28 + 44);
      c.globalAlpha = 1;
    }

    // ---- right: rifle status panel (inverts red on FIRE)
    {
      const x = 1270, y = 90, w = 590, h = 330;
      const hot = fireHold > 0 && tf < 0.45;
      const r = panel(c, x, y, w, h, { title: 'positron rifle', jp: '陽電子砲 状態', color: rgba(hot ? 'red' : 'orange', 1), fill: hot ? rgba('red', 0.92) : undefined });
      const ink = hot ? rgba('ink', 1) : rgba('orange', 1);
      c.fillStyle = hot ? rgba('ink', 1) : rgba('orange', 0.85); c.font = font(F.mono(600), 12); c.letterSpacing = '2px';
      c.fillText('CHARGE  充電率', r.x + 4, r.y + 14); c.letterSpacing = '0px';
      const pct = (hot ? 100 : charge * 100).toFixed(1).padStart(5, '0');
      sevenSeg(c, pct, r.x + 4, r.y + 28, 104, hot ? rgba('ink', 1) : rgba(charge > 0.97 ? 'red' : 'amber', 1), hot ? null : rgba('orange', 0.08));
      condensed(c, '%', r.x + 330, r.y + 128, 70, { color: ink, sx: 0.7 });
      // status stack
      const st: [string, string, boolean][] = [
        ['CHARGING', '充電中', !hot && charge < 0.97 && charge > 0],
        ['READY', '射撃準備', !hot && charge >= 0.97],
        ['FIRE', '発射', hot],
      ];
      st.forEach(([en, j], i) => {
        const yy = r.y + 14 + i * 40, xx = r.x + 410;
        c.strokeStyle = hot ? rgba('ink', 1) : rgba('orange', 0.6); c.lineWidth = 1.2;
        c.strokeRect(xx, yy, 150, 32);
        if (en === 'READY' && !hot && charge >= 0.97 && frameIdx(t) % 8 < 4) { /* blink */ } else if (st[i]![2]) { c.fillStyle = hot ? rgba('ink', 1) : rgba(en === 'READY' ? 'red' : 'orange', 1); c.fillRect(xx, yy, 150, 32); }
        c.fillStyle = st[i]![2] ? (hot ? rgba('red', 1) : rgba('ink', 1)) : (hot ? rgba('ink', 1) : rgba('orange', 0.7));
        c.font = font(F.mono(700), 13); c.letterSpacing = '2px'; c.fillText(en, xx + 8, yy + 21); c.letterSpacing = '0px';
        c.font = jp(13, 700, false); c.textAlign = 'right'; c.fillText(j, xx + 142, yy + 21); c.textAlign = 'left';
      });
      segMeter(c, r.x + 4, r.y + 158, r.w - 8, 26, 50, charge, { color: hot ? rgba('ink', 1) : rgba('orange', 1), hot: hot ? rgba('ink', 1) : rgba('red', 1), hotFrom: 0.9, dim: hot ? rgba('ink', 0.25) : rgba('orange', 0.1) });
      c.fillStyle = hot ? rgba('ink', 1) : rgba('orange', 0.85); c.font = font(F.mono(500), 13); c.letterSpacing = '1.5px';
      const kw = Math.round(180000000 * (0.2 + 0.8 * charge) + noise1(t * 7) * 400000).toLocaleString('en-US');
      c.fillText(`ENERGY SUPPLY  ${kw.padStart(11, ' ')} KW`, r.x + 4, r.y + 214);
      c.fillText(`SHOT ${String(Math.min(ph + 1, 3)).padStart(2, '0')}/03   BARREL ${(480 + 900 * charge * charge).toFixed(0)} K`, r.x + 4, r.y + 236);
      c.letterSpacing = '0px';
      c.font = jp(14, 700, false); c.textAlign = 'right'; c.fillText('日本全国より送電', r.x + r.w - 4, r.y + 214); c.textAlign = 'left';
    }
    // ---- right: firing corrections (hats step the values, bass swings the needles)
    {
      const r = panel(c, 1270, 440, 590, 250, { title: 'correction', jp: '射撃補正' });
      const rows: [string, string, number, string][] = [
        ['WIND', '風向風速', noise1(hats * 0.37, 11) * 0.8 + 0.2 * bass, 'M/S'],
        ['GRAVITY', '重力', 0.2 + 0.5 * bass, 'G'],
        ['GEOMAGNETIC', '地磁気', noise1(hats * 0.23, 21) * 0.9, 'μT'],
        ['EARTH ROT.', '地球自転', Math.sin(t * 0.3) * 0.5, 'MRAD'],
      ];
      rows.forEach(([en, j, v], i) => {
        const y = r.y + 12 + i * 48;
        c.fillStyle = rgba('orange', 0.9); c.font = font(F.mono(600), 13); c.letterSpacing = '2px'; c.fillText(en, r.x + 4, y + 8); c.letterSpacing = '0px';
        c.font = jp(13, 600, false); c.fillStyle = rgba('orange', 0.6); c.fillText(j, r.x + 4, y + 28);
        // centre-zero bar with needle
        const bx = r.x + 190, bw = 250, by = y + 6;
        c.fillStyle = rgba('orange', 0.12); c.fillRect(bx, by, bw, 16);
        c.fillStyle = rgba('orange', 0.6);
        for (let k = 0; k <= 10; k++) c.fillRect(bx + (k * bw) / 10, by + 18, 1, k % 5 === 0 ? 8 : 4);
        const nv = clamp(v, -1, 1), nx = bx + bw / 2 + (nv * bw) / 2;
        c.fillStyle = rgba(Math.abs(nv) > 0.8 ? 'red' : 'amber', 0.85);
        c.fillRect(Math.min(nx, bx + bw / 2), by + 3, Math.abs(nx - bx - bw / 2), 10);
        c.fillStyle = rgba('bone', 1); c.fillRect(nx - 1, by - 3, 3, 22);
        c.fillStyle = rgba('amber', 1); c.font = font(F.mono(600), 15); c.textAlign = 'right';
        c.fillText(`${nv >= 0 ? '+' : '−'}${Math.abs(nv * 12.5).toFixed(2)}`, r.x + r.w - 4, y + 20); c.textAlign = 'left';
      });
    }
    // ---- right: power grid (spectrum) panel frame + labels
    {
      panel(c, 1270, 710, 590, 250, { title: 'power grid', jp: '送電網 負荷' });
      c.fillStyle = rgba('orange', 0.6); c.font = font(F.mono(500), 10); c.letterSpacing = '1px';
      const hz = ['30', '120', '500', '2K', '8K', '16K'];
      hz.forEach((s, i) => c.fillText(s, 1290 + i * 104, 948));
      c.letterSpacing = '0px';
      c.fillStyle = rgba('orange', 0.3); c.fillRect(1290, 931, 550, 1);
    }
    // bottom ticker + rule
    c.fillStyle = rgba('orange', 0.6); c.fillRect(60, 1000, 1800, 1);
    ticker(c, 60, 1026, 1800, 'OPERATION YASHIMA // POSITRON RIFLE: ALL POWER OF JAPAN ROUTED TO FIRING POINT // TARGET: 5TH ANGEL // A.T. FIELD NEUTRALISATION: UNIT-01 // 日本全国 停電中 //', t, { speed: 110, color: rgba('orange', 0.7) });

    this.ctx.comp.draw(renderer, L.upload(), out);
    this.scan.u.t!.value = t;
    this.scan.render(renderer, out);
    const sh = tf >= 0 && tf < 0.4 ? 14 * fp : 0;
    return {
      bloom: 0.75, bloomThreshold: 0.75, halation: 0.12, vignette: 0.42, grain: 0.05,
      ca: 1.0 + 4 * fp, flash: 0.1 * fp,
      shake: [(hash(fi, 7) - 0.5) * sh, (hash(fi, 8) - 0.5) * sh],
      zoom: 1 + 0.006 * d + 0.02 * fp,
    };
  }
}
