// Ported from bizarro/evangelion app/src/scenes/harmonics.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// harmonics — "HARMONICS" (groove 2 cont., bars 18–24, 37.22 – 48.02 s; bar 23 = pad-swell fill).
// The Eva harmonics / waveform analyser. A big segmented bar spectrum (the real 64-band mel spectrum:
// orange blocks, red tops, amber peak-hold ticks) on a hex-lattice ground; below it a mirrored
// waveform strip scrolling over the last two bars (L above, R below, the upcoming bar dimmed);
// right column: a ring of 12 chroma hexes around the dominant pitch class, band level meters and
// a pilot/Eva scope pair (L/R traces). Kicks bounce the analyser, claps invert the header tab and
// light the CLIP lamp, hats step the log rows. Bar 23 (the pad swell, no bass): status flips from
// HARMONICS NORMAL (green) to DEVIATION (amber), the analyser goes amber.
import * as THREE from 'three';
import { Scene, type Frame, type PostOverrides } from '../../show/scene.ts';
import { FSPass, Layer2D, clearRT } from '../../show/gl.ts';
import { rgba } from '../../show/palette.ts';
import { F, font } from '../../show/type.ts';
import { clamp, ease, prog, smoothstep, frameIdx } from '../../show/util.ts';
import { SPECTRUM_GLSL, spectrumUniforms } from '../../show/spectrum.ts';
import {
  barTime, songBar, duck, condensed, evaLabel, panel, chamferPath, brackets, hexPath, jp, sevenSeg, segMeter,
  scale, ticker, hexData, makeScanPass, GLSL_EVA,
} from './_eva.ts';

const NB = 64; // mel bands
const ROWS = 28; // block rows in the analyser
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// layout (logical px, y down)
const SP = { x: 146, y: 282, w: 1214, h: 404 }; // analyser blocks
const WV = { x: 146, y: 818, w: 1214, h: 132 }; // waveform strip
const WIN_PAST = 3.6, WIN_FUT = 1.2; // waveform strip window (s)

const mel = (f: number) => 2595 * Math.log10(1 + f / 700);
const M0 = mel(30), M1 = mel(16000);
/** Fractional mel band whose centre is at frequency f (librosa-style: n+2 equally spaced mel points). */
const bandOf = (f: number) => ((mel(f) - M0) / (M1 - M0)) * (NB + 1) - 1;
const hzOf = (b: number) => 700 * (Math.pow(10, (M0 + ((b + 1) / (NB + 1)) * (M1 - M0)) / 2595) - 1);
const shape = (x: number) => Math.pow(clamp((x - 0.42) / 0.58), 1.45);

const FRAG = /* glsl */ `
${SPECTRUM_GLSL}
${GLSL_EVA}
uniform float t, uV[${NB}], uP[${NB}], uDuck, uFill, uClap, uIn;
uniform vec4 uS, uWv;
uniform vec2 uWin; // past, future seconds

vec3 hudCol(float fill) { return mix(C_ORANGE, C_AMBER, fill); }

void main() {
  vec2 p = vec2(FRAG_PX.x, 1080.0 - FRAG_PX.y);
  vec3 col = C_INK;
  vec3 base = hudCol(uFill);
  float bright = (1.0 - 0.22 * uDuck) * uIn;

  // ---------------- analyser
  vec2 q = p - uS.xy - vec2(0.0, uDuck * 4.0);
  if (q.x > -30.0 && q.x < uS.z + 30.0 && q.y > -40.0 && q.y < uS.w + 10.0) {
    // hex-lattice ground
    vec4 hc = hexCell(q + vec2(0.0, 7.0), 17.0);
    float he = hexEdge(hc.xy, 17.0);
    float lat = pxLine(he, 0.4, 1.3) * 0.05;
    // dB grid lines every 4 rows
    float rh = uS.w / ${ROWS}.0;
    float gy = abs(mod(uS.w - q.y + 0.5 * rh * 0.0, rh * 4.0));
    float grid = pxLine(min(gy, rh * 4.0 - gy), 0.3, 1.2) * 0.07;
    col += base * (lat + grid) * uIn;
  }
  if (q.x >= 0.0 && q.x < uS.z && q.y >= 0.0 && q.y < uS.w) {
    float cw = uS.z / ${NB}.0, rh = uS.w / ${ROWS}.0;
    int b = int(q.x / cw);
    float fx = q.x - float(b) * cw;
    float r = (uS.w - q.y) / rh;
    int ri = int(r);
    float fy = (r - float(ri)) * rh;
    bool inBlock = fx > 2.0 && fx < cw - 2.0 && fy > 3.0;
    float v = uV[b] * ${ROWS}.0;
    float lit = float(ri) < floor(v) ? 1.0 : float(ri) < v ? v - float(ri) : 0.0;
    float k = float(ri) / ${ROWS}.0;
    vec3 bc = k > 0.82 ? C_RED : k > 0.64 ? mix(base, C_AMBER, 0.7) : base;
    if (inBlock) {
      col += bc * 0.045;
      col += bc * lit * (0.78 + 0.4 * k + 0.7 * uClap * step(0.82, k)) * bright;
      // inner bevel: the block's top edge a touch hotter
      col += bc * lit * 0.35 * step(rh - 4.5, fy) * bright;
    }
    // peak-hold tick
    float pk = uP[b] * ${ROWS}.0;
    float py = uS.w - pk * rh;
    float dpk = abs(q.y - py);
    if (fx > 1.0 && fx < cw - 1.0 && pk > 0.6) col += mix(C_AMBER, C_RED, step(0.82, uP[b])) * (1.0 - smoothstep(0.8, 1.8, dpk)) * 1.6 * uIn;
  }

  // ---------------- mirrored waveform strip
  vec2 w = p - uWv.xy;
  if (w.x >= 0.0 && w.x < uWv.z && w.y >= 0.0 && w.y < uWv.w) {
    float colW = 3.0;
    float ci = floor(w.x / colW);
    float u = (ci + 0.5) * colW / uWv.z;
    float span = uWin.x + uWin.y;
    float tc = t - uWin.x + u * span;
    float dt = span * colW / uWv.z;
    float aL = 0.0, aR = 0.0;
    for (int i = 0; i < 10; i++) {
      vec2 s = waveAt(tc + (float(i) / 9.0 - 0.5) * dt);
      aL = max(aL, abs(s.x)); aR = max(aR, abs(s.y));
    }
    float mid = uWv.w * 0.5;
    float dy = w.y - mid;
    float a = dy < 0.0 ? aL : aR;
    float hgt = pow(a, 0.8) * (mid - 4.0);
    float inBar = step(abs(dy), hgt) * step(1.0, abs(dy)) * step(mod(w.x, colW), colW - 1.0);
    bool fut = tc > t;
    float age = (t - tc) / uWin.x;
    vec3 wc = fut ? C_GRAPHITE * 0.9 : mix(base * 1.25, base * 0.45, clamp(age, 0.0, 1.0));
    if (!fut && t - tc < 0.06) wc = C_AMBER * 1.8;
    col += wc * inBar * uIn;
    // centre rule + faint envelope line
    col += base * pxLine(abs(dy), 0.3, 1.0) * 0.35 * uIn;
  }
  fragColor = vec4(col, 1.0);
}`;

export default class Harmonics extends Scene {
  bg: FSPass;
  text = new Layer2D();
  scan = makeScanPass(0.22);
  V = new Float32Array(NB);
  P = new Float32Array(NB);
  ch = new Float32Array(12);
  T = { s: 0, e: 0, fill: 0, b18: 0 };

  constructor(ctx: ConstructorParameters<typeof Scene>[0]) {
    super(ctx);
    this.bg = new FSPass(FRAG, {
      t: { value: 0 }, uV: { value: this.V }, uP: { value: this.P }, uDuck: { value: 0 }, uFill: { value: 0 }, uClap: { value: 0 }, uIn: { value: 1 },
      uS: { value: new THREE.Vector4(SP.x, SP.y, SP.w, SP.h) }, uWv: { value: new THREE.Vector4(WV.x, WV.y, WV.w, WV.h) },
      uWin: { value: new THREE.Vector2(WIN_PAST, WIN_FUT) },
      ...spectrumUniforms(ctx.spectrum),
    });
  }

  override init() {
    const au = this.ctx.audio;
    this.T.s = this.ctx.start; this.T.e = this.ctx.end;
    this.T.fill = barTime(au, 23);
    this.T.b18 = barTime(au, 18);
  }

  render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides {
    const { renderer, audio: au } = this.ctx;
    const T = this.T, t = f.t;
    const d = duck(f, au);
    const fill = smoothstep(T.fill - 0.02, T.fill + 0.12, t);
    const clap = au.hit('snare', t, 0.1);
    const lt = t - T.s;
    const inA = prog(lt, 0, 0.18, ease.outCubic); // power-on over the first frames

    // ---- per-band values + peak hold (a falling max over the last 0.8 s)
    for (let b = 0; b < NB; b++) {
      const v = shape(au.mel(t, b));
      let pk = v;
      for (let k = 1; k <= 16; k++) { const dt = k * 0.05; pk = Math.max(pk, shape(au.mel(t - dt, b)) - dt * dt * 1.6); }
      this.V[b] = v * inA; this.P[b] = pk * inA;
    }
    au.chroma(t, this.ch);

    clearRT(renderer, out, [0.0015, 0.0012, 0.001]);
    const u = this.bg.u;
    u.t!.value = t; u.uDuck!.value = d; u.uFill!.value = fill; u.uClap!.value = clap; u.uIn!.value = inA;
    this.bg.render(renderer, out);

    const L = this.text; L.clear();
    const c = L.ctx;
    const O = fill > 0.5 ? 'amber' : 'orange';
    const oc = (a: number) => rgba(O, a);
    c.textBaseline = 'alphabetic';
    c.globalAlpha = inA;

    // ================= header band
    evaLabel(c, 80, 78, 'eva unit-01  //  harmonic analysis', undefined, { color: oc(0.8) });
    condensed(c, 'HARMONICS', 72, 190, 138, { sx: 0.56, color: rgba('bone', 1), bold: 0.03 });
    c.font = jp(34, 700, true); c.fillStyle = oc(1); c.fillText('ハーモニクス', 552, 150);
    c.font = jp(20, 600, false); c.fillText('波形解析  第一発令所', 554, 186);
    // log rows (step one line per hat)
    const nh = au.events('hat', T.s - 20, t).length;
    c.font = font(F.mono(500), 13); c.letterSpacing = '1px';
    for (let r = 0; r < 5; r++) {
      const idx = nh - r;
      const band = Math.floor(((idx * 37) % NB + NB) % NB);
      const lvl = (this.V[band]! * 12 - 6).toFixed(1);
      const s = `${(0x3f00 + idx * 16).toString(16).toUpperCase().slice(-4)}  BAND ${String(band).padStart(2, '0')}  ${lvl.startsWith('-') ? '' : '+'}${lvl}dB  ${hexData(idx, 3, 6)}  ${r === 0 ? '<' : ' '}`;
      c.fillStyle = oc(r === 0 ? 0.95 : 0.55 - r * 0.08);
      c.fillText(s, 880, 88 + r * 21);
    }
    c.letterSpacing = '0px';
    // status box
    {
      const x = 1410, y = 64, w = 430, h = 132;
      const warn = fill > 0.5;
      const bl = warn ? (((t - T.fill) * 2.222) % 1 < 0.6 ? 1 : 0.35) : 1;
      const col = warn ? rgba('amber', 1) : rgba('green', 1);
      chamferPath(c, x, y, w, h, [0, 18, 0, 18]);
      c.fillStyle = warn ? `rgba(60,36,0,${0.35 + 0.35 * bl})` : 'rgba(4,30,12,0.55)'; c.fill();
      c.strokeStyle = col; c.lineWidth = 2; c.stroke();
      c.fillStyle = col; c.fillRect(x, y, 16, h);
      evaLabel(c, x + 34, y + 30, 'harmonics status', warn ? '波形 異常' : '波形 正常', { color: col });
      c.globalAlpha = inA * (0.4 + 0.6 * bl);
      condensed(c, warn ? 'DEVIATION' : 'NORMAL', x + w - 22, y + h - 24, 76, { sx: 0.6, color: col, align: 'right' });
      c.globalAlpha = inA;
      // tiny lamps
      for (let i = 0; i < 6; i++) {
        const on = warn ? (i < 2 + Math.floor(((t - T.fill) * 4.44) % 5)) : i < 3;
        c.fillStyle = on ? col : rgba('graphite', 0.8);
        c.fillRect(x + 34 + i * 18, y + h - 34, 12, 8);
      }
    }

    // ================= main analyser panel
    {
      const x = 80, y = 216, w = 1300, h = 526;
      const inv = clap > 0.45;
      panel(c, x, y, w, h, { title: 'spectrum analyser', jp: '周波数解析', color: inv ? rgba('red', 1) : oc(1), fill: 'rgba(0,0,0,0)' });
      // right side header info
      c.font = font(F.mono(600), 13); c.letterSpacing = '2px'; c.textAlign = 'right'; c.fillStyle = oc(0.85);
      c.fillText(`64 BANDS  30Hz-16kHz  MEL  //  CH.MIX`, x + w - 24, y + 21);
      c.letterSpacing = '0px'; c.textAlign = 'left';
      // CLIP lamp
      c.fillStyle = clap > 0.2 ? rgba('red', 0.4 + 0.6 * clamp(clap * 1.4)) : rgba('blood', 0.5);
      chamferPath(c, x + w - 470, y + 6, 60, 18, 5); c.fill();
      c.fillStyle = rgba('ink', 1); c.font = font(F.mono(700), 12); c.fillText('CLIP', x + w - 455, y + 20);
      // dB scale (left) and band axis (bottom)
      const yo = d * 4;
      c.font = font(F.mono(500), 11); c.textAlign = 'right'; c.fillStyle = oc(0.7);
      for (let r = 0; r <= ROWS; r += 4) {
        const yy = SP.y + SP.h - (r / ROWS) * SP.h + yo;
        c.fillText(r === ROWS ? '0' : `-${((ROWS - r) / 4) * 6}`, SP.x - 14, yy + 4);
        c.fillStyle = oc(0.5); c.fillRect(SP.x - 10, yy, 5, 1); c.fillStyle = oc(0.7);
      }
      c.fillText('dB', SP.x - 14, SP.y - 16 + yo);
      c.textAlign = 'center';
      const hz = [100, 200, 400, 600, 1000, 2000, 4000, 8000, 12000];
      const cw = SP.w / NB;
      for (const fq of hz) {
        const bx = SP.x + (bandOf(fq) + 0.5) * cw;
        c.fillStyle = oc(0.5); c.fillRect(bx, SP.y + SP.h + 8 + yo, 1, 7);
        c.fillStyle = oc(0.8);
        c.fillText(fq >= 1000 ? `${fq / 1000}k` : `${fq}`, bx, SP.y + SP.h + 30 + yo);
      }
      c.textAlign = 'left';
      c.fillStyle = oc(0.6); c.fillText('Hz', SP.x + SP.w + 6, SP.y + SP.h + 30 + yo);
      // peak marker: the loudest band right now
      let bi = 0; for (let b = 1; b < NB; b++) if (this.V[b]! > this.V[bi]!) bi = b;
      const px = SP.x + (bi + 0.5) * cw, py = SP.y + SP.h - this.V[bi]! * SP.h + yo;
      c.strokeStyle = rgba('amber', 0.9); c.lineWidth = 1.2;
      c.beginPath(); c.moveTo(px, py - 8); c.lineTo(px + 18, py - 30); c.lineTo(px + 96, py - 30); c.stroke();
      c.font = font(F.mono(600), 12); c.fillStyle = rgba('amber', 1);
      const hzp = hzOf(bi);
      c.fillText(`PK ${hzp >= 1000 ? (hzp / 1000).toFixed(2) + 'k' : hzp.toFixed(0)}`, px + 22, py - 35);
      // hex badges on the frame corners
      for (const [hx, hy] of [[x + w - 26, y + h - 26], [x + 26, y + h - 26]] as const) {
        hexPath(c, hx, hy, 12); c.strokeStyle = oc(0.8); c.lineWidth = 1.5; c.stroke();
        hexPath(c, hx, hy, 6); c.fillStyle = oc(0.5 + 0.5 * d); c.fill();
      }
      brackets(c, SP.x - 6, SP.y - 6 + yo, SP.w + 12, SP.h + 12, 14, oc(0.55), 1.5);
      // fill warning chip
      if (fill > 0) {
        const bl = ((t - T.fill) * 4.444) % 1 < 0.55 ? 1 : 0.3;
        const cx = x + w - 360, cy = y + 50;
        c.globalAlpha = inA * fill;
        chamferPath(c, cx, cy, 330, 64, 10);
        c.fillStyle = `rgba(50,30,0,${0.5 + 0.3 * bl})`; c.fill();
        c.strokeStyle = rgba('amber', 1); c.lineWidth = 2; c.stroke();
        c.fillStyle = rgba('amber', 0.4 + 0.6 * bl);
        c.font = font(F.mono(700), 18); c.letterSpacing = '3px'; c.fillText('PAD SWELL', cx + 16, cy + 28);
        c.letterSpacing = '0px'; c.font = jp(16, 700, false); c.fillText('低域消失  注意', cx + 16, cy + 52);
        const dev = (8 + 30 * au.env('other', t)).toFixed(1);
        condensed(c, `+${dev}%`, cx + 316, cy + 50, 46, { sx: 0.62, color: rgba('amber', 1), align: 'right' });
        c.globalAlpha = inA;
      }
    }

    // ================= waveform strip panel
    {
      const x = 80, y = 762, w = 1300, h = 214;
      panel(c, x, y, w, h, { title: 'harmonic waveform', jp: '波形', color: oc(1), fill: 'rgba(0,0,0,0)' });
      c.font = font(F.mono(600), 13); c.letterSpacing = '2px'; c.textAlign = 'right'; c.fillStyle = oc(0.85);
      c.fillText('L / R  PEAK  2 BARS', x + w - 24, y + 21);
      c.letterSpacing = '0px'; c.textAlign = 'left';
      const span = WIN_PAST + WIN_FUT;
      const tx = (tt: number) => WV.x + ((tt - (t - WIN_PAST)) / span) * WV.w;
      // bar + beat ticks
      const b0 = Math.floor(songBar(au, t - WIN_PAST)), b1 = Math.ceil(songBar(au, t + WIN_FUT));
      c.font = font(F.mono(600), 11);
      for (let k = b0; k <= b1; k++) {
        const bt = barTime(au, k);
        for (let q = 0; q < 4; q++) {
          const xx = tx(bt + q * 0.45);
          if (xx < WV.x || xx > WV.x + WV.w) continue;
          c.fillStyle = oc(q === 0 ? 0.8 : 0.35);
          c.fillRect(xx, WV.y - (q === 0 ? 12 : 6), 1, q === 0 ? 12 : 6);
          c.fillRect(xx, WV.y + WV.h, 1, q === 0 ? 10 : 5);
          if (q === 0) c.fillText(`${k}`, xx + 4, WV.y - 3);
        }
      }
      // playhead
      const ph = tx(t);
      c.fillStyle = rgba('amber', 1); c.fillRect(ph - 1, WV.y - 14, 2, WV.h + 28);
      c.beginPath(); c.moveTo(ph - 7, WV.y - 20); c.lineTo(ph + 7, WV.y - 20); c.lineTo(ph, WV.y - 12); c.closePath(); c.fill();
      c.font = font(F.mono(600), 11); c.fillStyle = oc(0.7);
      c.fillText('L', WV.x - 22, WV.y + 30); c.fillText('R', WV.x - 22, WV.y + WV.h - 18);
      c.fillStyle = rgba('graphite', 1); c.fillText('NEXT', ph + 12, WV.y + WV.h + 12);
    }

    // ================= right column: chroma ring
    const ch = this.ch;
    {
      const x = 1410, y = 216, w = 430, h = 318;
      panel(c, x, y, w, h, { title: 'chroma', jp: '音階分析', color: oc(1) });
      const cx = x + 162, cy = y + 180, R = 104;
      let top = 0; for (let k = 1; k < 12; k++) if (ch[k]! > ch[top]!) top = k;
      // tick ring
      c.strokeStyle = oc(0.35); c.lineWidth = 1;
      c.beginPath(); c.arc(cx, cy, R + 34, 0, Math.PI * 2); c.stroke();
      for (let k = 0; k < 48; k++) {
        const a = -Math.PI / 2 + (k / 48) * Math.PI * 2, l = k % 4 === 0 ? 8 : 4;
        c.beginPath(); c.moveTo(cx + Math.cos(a) * (R + 34), cy + Math.sin(a) * (R + 34)); c.lineTo(cx + Math.cos(a) * (R + 34 + l), cy + Math.sin(a) * (R + 34 + l)); c.stroke();
      }
      // pointer to the dominant note
      const at = -Math.PI / 2 + (top / 12) * Math.PI * 2;
      c.strokeStyle = rgba('amber', 0.9); c.lineWidth = 2;
      c.beginPath(); c.moveTo(cx + Math.cos(at) * 56, cy + Math.sin(at) * 56); c.lineTo(cx + Math.cos(at) * (R - 30), cy + Math.sin(at) * (R - 30)); c.stroke();
      for (let k = 0; k < 12; k++) {
        const a = -Math.PI / 2 + (k / 12) * Math.PI * 2;
        const hx = cx + Math.cos(a) * R, hy = cy + Math.sin(a) * R;
        const v = Math.pow(ch[k]!, 1.6);
        hexPath(c, hx, hy, 25, Math.PI / 6);
        c.fillStyle = k === top ? rgba('amber', 0.25 + 0.75 * v) : oc(0.06 + 0.8 * v);
        c.fill();
        c.strokeStyle = oc(0.8); c.lineWidth = 1.3; c.stroke();
        c.font = font(F.mono(700), 13); c.textAlign = 'center';
        c.fillStyle = v > 0.45 ? rgba('ink', 1) : oc(0.9);
        c.fillText(NOTES[k]!, hx, hy + 5);
      }
      hexPath(c, cx, cy, 52, Math.PI / 6);
      c.fillStyle = 'rgba(30,18,6,0.9)'; c.fill(); c.strokeStyle = oc(1); c.lineWidth = 2; c.stroke();
      condensed(c, NOTES[top]!, cx, cy + 22, 64, { sx: 0.7, color: rgba('bone', 1), align: 'center' });
      c.font = font(F.mono(600), 10); c.fillStyle = oc(0.8); c.fillText('KEY', cx, cy - 28);
      c.textAlign = 'left';
      // ranked list
      const order = [...Array(12).keys()].sort((a, b) => ch[b]! - ch[a]!).slice(0, 5);
      c.font = font(F.mono(600), 13);
      order.forEach((k, i) => {
        const yy = y + 70 + i * 44;
        c.fillStyle = oc(i === 0 ? 1 : 0.75);
        c.fillText(`${NOTES[k]!.padEnd(2, ' ')}  ${(ch[k]! * 100).toFixed(0).padStart(3, ' ')}%`, x + 318, yy);
        segMeter(c, x + 318, yy + 8, 92, 6, 10, ch[k]!, { color: oc(1), hot: rgba('amber', 1), hotFrom: 0.8, dim: oc(0.1) });
      });
      c.font = jp(14, 600, false); c.fillStyle = oc(0.7); c.fillText('主音', x + 318, y + h - 18);
    }

    // ================= band levels
    {
      const x = 1410, y = 548, w = 430, h = 194;
      panel(c, x, y, w, h, { title: 'band levels', jp: '帯域', color: oc(1) });
      const avg = (b0: number, b1: number) => { let s = 0; for (let b = b0; b <= b1; b++) s += this.V[b]!; return s / (b1 - b0 + 1); };
      const bands: [string, number][] = [
        ['SUB', avg(0, 5)], ['LOW', avg(6, 15)], ['MID', avg(16, 34)], ['HIGH', avg(35, 63)],
        ['BASS', clamp(au.env('bass', t) * 1.25)], ['PAD', clamp(au.env('other', t) * 1.1)],
      ];
      bands.forEach(([nm, v], i) => {
        const bx = x + 28 + i * 66, by = y + 58;
        c.font = font(F.mono(600), 12); c.fillStyle = oc(0.9); c.textAlign = 'center';
        c.fillText((v * 100).toFixed(0).padStart(2, '0'), bx + 16, by - 6);
        segMeter(c, bx, by, 32, 94, 14, v, { vertical: true, color: oc(1), hot: rgba('red', 1), hotFrom: 0.78, dim: oc(0.09), gap: 2 });
        c.fillStyle = oc(0.8); c.fillText(nm, bx + 16, by + 114);
        c.textAlign = 'left';
      });
    }

    // ================= pilot / eva scope
    {
      const x = 1410, y = 762, w = 430, h = 214;
      panel(c, x, y, w, h, { title: 'sync harmonics', jp: '同期', color: oc(1) });
      const gx = x + 20, gy = y + 50, gw = w - 40, gh = h - 70;
      c.strokeStyle = oc(0.14); c.lineWidth = 1;
      c.beginPath();
      for (let i = 0; i <= 8; i++) { c.moveTo(gx + (i / 8) * gw, gy); c.lineTo(gx + (i / 8) * gw, gy + gh); }
      for (let i = 0; i <= 4; i++) { c.moveTo(gx, gy + (i / 4) * gh); c.lineTo(gx + gw, gy + (i / 4) * gh); }
      c.stroke();
      c.strokeStyle = oc(0.4); c.beginPath(); c.moveTo(gx, gy + gh / 2); c.lineTo(gx + gw, gy + gh / 2); c.stroke();
      // trigger: last rising zero crossing of L within 30 ms before t
      const tmp: [number, number] = [0, 0];
      let t0 = t - 0.03;
      let prev = au.waveAt(t - 0.03, tmp)[0];
      for (let s = t - 0.03 + 1 / 11025; s < t - 0.002; s += 1 / 11025) {
        const v = au.waveAt(s, tmp)[0];
        if (prev < 0 && v >= 0) t0 = s;
        prev = v;
      }
      const win = 0.028, N = 220;
      for (const [chn, col, lw] of [[1, rgba('green', 0.85), 1.4], [0, rgba('amber', 1), 1.8]] as const) {
        c.strokeStyle = col; c.lineWidth = lw; c.beginPath();
        for (let i = 0; i <= N; i++) {
          const v = au.waveAt(t0 + (i / N) * win, tmp)[chn];
          const xx = gx + (i / N) * gw, yy = gy + gh / 2 - v * gh * 0.46;
          if (i) c.lineTo(xx, yy); else c.moveTo(xx, yy);
        }
        c.stroke();
      }
      c.font = font(F.mono(600), 11); c.fillStyle = rgba('amber', 1); c.fillText('PILOT', gx + 6, gy + 14);
      c.fillStyle = rgba('green', 1); c.fillText('EVA-01', gx + 58, gy + 14);
      const bm = au.bassMidi(t);
      c.textAlign = 'right'; c.fillStyle = oc(0.9);
      c.fillText(bm > 0 ? `F0 ${(440 * Math.pow(2, (bm - 69) / 12)).toFixed(1)}Hz ${NOTES[Math.round(bm) % 12]}${Math.floor(Math.round(bm) / 12) - 1}` : 'F0 ---.-Hz', gx + gw - 6, gy + 14);
      c.textAlign = 'left';
    }

    // ================= footer: bar counter + ticker
    {
      const bar = songBar(au, t);
      const bi = Math.floor(bar), beat = Math.floor((bar - bi) * au.beatsPerBar) + 1;
      sevenSeg(c, `${String(bi).padStart(2, '0')}.${beat}`, 80, 998, 34, oc(1), oc(0.08));
      c.font = font(F.mono(600), 11); c.fillStyle = oc(0.7); c.fillText('BAR.BEAT', 80, 1052);
      const secs = t;
      const mm = Math.floor(secs / 60), ss = Math.floor(secs % 60), cc = Math.floor((secs % 1) * 100);
      sevenSeg(c, `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}:${String(cc).padStart(2, '0')}`, 234, 998, 34, oc(0.85), oc(0.08));
      c.fillText('T+', 234, 1052);
      ticker(c, 560, 1024, 1280, fill > 0.5
        ? 'WARNING // HARMONIC DEVIATION // LOW BAND DROPOUT // 低域消失 // PAD SWELL DETECTED // STAND BY FOR BREAK // 待機'
        : 'HARMONICS NORMAL // 波形 正常 // SYNC 133.33 BPM // EVA-01 PILOT LINK STABLE // A10 NERVE CONNECTION OK // 神経接続 良好', t, { speed: 110, color: oc(0.65) });
      c.fillStyle = oc(0.5); c.fillRect(560, 1036, 1280, 1);
      scale(c, 560, 996, 1840, 996, 64, { major: 8, tick: 4, color: oc(0.35) });
    }
    c.globalAlpha = 1;
    void frameIdx;

    this.ctx.comp.draw(renderer, L.upload(), out);
    this.scan.u.t!.value = t;
    this.scan.render(renderer, out);
    return { bloom: 0.6, bloomThreshold: 0.75, halation: 0.1, vignette: 0.4, ca: 0.9 + 1.2 * clap, grain: 0.05 };
  }
}
