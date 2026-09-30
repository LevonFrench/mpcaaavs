// Ported from bizarro/evangelion app/src/scenes/atfield.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// atfield — "A.T. FIELD" (DROP 1, bars 35–45, 67.82–85.82 s).
// Hard cut in on the drop: the Absolute Terror field as a full-screen shader. An octagonal shield of
// orange hex planes, lit by the real spectrum: each cell shows the mel energy at a delay proportional
// to its octagonal radius, so every kick (low bands) visibly ripples outward as a ring of cells, and
// the angle within each octant picks a higher band (the texture of the field is the mix). On top:
// crisp octagon wavefronts + lattice warp per kick, claps shatter a ring of cells (red fragments),
// hats sparkle cells, bass tilts and swells the field. Overlay: the NERV terminal around it (field
// strength 7-seg, wave pattern scope, octant layer meters, status list, hex dump, vertical JP), the
// condensed "A.T. FIELD" card (full-screen slam on the downbeat, then docked bottom-left).
import * as THREE from 'three';
import { Scene, type Frame, type PostOverrides } from '../../show/scene.ts';
import { FSPass, Layer2D, W, H } from '../../show/gl.ts';
import { rgba } from '../../show/palette.ts';
import { F, font } from '../../show/type.ts';
import { SPECTRUM_GLSL, spectrumUniforms } from '../../show/spectrum.ts';
import { clamp, ease, frameIdx, prog, pulse, smoothstep } from '../../show/util.ts';
import { GLSL_EVA, barTime, brackets, condensed, duck, evaLabel, hexData, jp, makeScanPass, panel, segMeter, sevenSeg, songBar, ticker } from './_eva.ts';
import { fillRecent, headerStrip, jpVertical, lastIdx, melHz, melMean, mono, octPath, onsetList, statusRow, vec2Array, waveScope } from './atfield-kit.ts';

const FIELD_FRAG = /* glsl */ `
${GLSL_EVA}
${SPECTRUM_GLSL}
uniform float t, fi, zoom, deploy, red, glitch, bass, kickNow, breach;
uniform vec2 center, tilt;
uniform vec2 uKick[8];
uniform vec2 uClap[3];
uniform vec2 uHat[4];

const float R = 0.036;      // cell circumradius (plane units = frame heights)
const float V = 0.5;        // spectrum propagation speed (plane units / s)
const float VK = 1.35;      // kick wavefront speed
const float VC = 1.1;       // clap shatter ring speed

float oct(vec2 v) { v = abs(v); return max(max(v.x, v.y), (v.x + v.y) * 0.70710678); }

void main() {
  vec2 px = FRAG_PX;
  // hard row glitch on claps (rows offset horizontally, stable over the frame's shutter)
  float row = floor(px.y / 7.0);
  float gh = hash12(vec2(row, fi));
  if (gh < 0.16 * glitch) px.x += (hash12(vec2(row * 1.7, fi + 3.1)) - 0.5) * 120.0 * glitch;

  vec2 q = (px - center) / ${H.toFixed(1)};
  // the field plane, tilted in perspective (bass leans it), zoomed on the kick
  float w = 1.0 + dot(q, tilt);
  vec2 p = q / w * zoom;
  float dp0 = oct(p);
  float fw0 = fwidth(dp0);

  // ---- kick wavefronts: lattice warp + crisp octagon lines
  float warp = 0.0, fronts = 0.0, cellFront = 0.0;
  for (int i = 0; i < 8; i++) {
    float age = t - uKick[i].x;
    if (age < 0.0 || age > 1.8) continue;
    float a = uKick[i].y * exp(-age * 1.9);
    float d = dp0 - age * VK;
    warp += a * exp(-d * d / 0.0035);
    fronts += a * pxLine(abs(d) / max(fw0, 1e-5), 0.6, 2.2);
    fronts += a * 0.35 * exp(-abs(d) / 0.012) * step(d, 0.0) ;
  }
  p *= 1.0 - 0.035 * warp;
  float dp = oct(p);

  // ---- main hex lattice
  vec4 hc = hexCell(p, R);
  vec2 g = hc.xy, id = hc.zw, cc = p - g;
  float dc = oct(cc);
  float Rmax = deploy * (0.40 + 0.06 * bass);
  float inside = smoothstep(Rmax + 0.03, Rmax - 0.03, dc);

  // spectrum history: radius = delay, angle within the octant = band
  float lag = dc / V;
  float eL = melAvg(t - lag, 0.0, 5.0); eL = pow(smoothstep(0.55, 1.0, eL), 1.6);
  float ang = atan(cc.y, cc.x);
  float a8 = abs(fract(ang / (TAU / 8.0) + 0.5) * 2.0 - 1.0);
  float eH = pow(smoothstep(0.5, 1.0, melAt(t - lag, 10.0 + a8 * 46.0)), 2.0);

  for (int i = 0; i < 8; i++) {
    float age = t - uKick[i].x;
    if (age < 0.0 || age > 1.8) continue;
    float d = dc - age * VK;
    cellFront += uKick[i].y * exp(-age * 1.6) * exp(-d * d / 0.0022);
  }

  // clap shatter: a ring of cells breaks into shrunken, displaced red fragments
  float sh = 0.0;
  for (int i = 0; i < 3; i++) {
    float age = t - uClap[i].x;
    if (age < 0.0 || age > 1.2) continue;
    float d = dc - (0.06 + age * VC);
    sh = max(sh, uClap[i].y * exp(-d * d / 0.0045) * exp(-age * 2.4));
  }
  vec2 jit = (hash22(id + 13.1) - 0.5) * R * 1.3 * sh;
  float rr = R * (1.0 - 0.55 * sh * hash12(id + 2.7));
  float e = hexEdge(g - jit, rr);
  float fwp = length(fwidth(p));
  float epx = e / max(fwp, 1e-6);         // distance to the cell border in physical px
  float gap = 2.2 * PX_SCALE;
  float fill = smoothstep(gap, gap + 1.0, epx);
  float rim = pxLine(abs(epx - gap - 1.2 * PX_SCALE), 0.6, 1.8);
  float inner = pxLine(abs(epx - (R * 0.5) / max(fwp, 1e-6)), 0.5, 1.5); // inner hex echo

  // hat sparkle + high-band glitter
  float spark = 0.0;
  for (int i = 0; i < 4; i++) {
    float age = t - uHat[i].x;
    if (age < 0.0 || age > 0.5) continue;
    if (hash12(id + uHat[i].x * 13.7) < 0.05) spark += uHat[i].y * exp(-age / 0.07);
  }
  float hi = melAvg(t, 44.0, 56.0);
  if (hash12(id + floor(t * 15.0) * 7.31) < 0.03 * smoothstep(0.5, 1.0, hi)) spark += 0.8;

  float I = 0.06 + 1.1 * eL * (1.0 - 0.45 * dc / max(Rmax, 0.1)) + 0.4 * eH + 1.3 * cellFront + 1.6 * spark;
  I *= inside;
  I *= 0.8 + 0.35 * kickNow;

  vec3 hot = mix(C_ORANGE, C_AMBER, smoothstep(0.7, 1.5, I));
  vec3 col = vec3(0.0);
  col += hot * I * (0.07 * fill + 1.1 * rim + 0.25 * inner * eH);
  col += hot * 0.5 * cellFront * fill * inside;
  col += C_BONE * smoothstep(1.2, 2.4, I) * rim * 0.8;
  col = mix(col, C_RED * (0.3 * fill + 1.8 * rim) * (0.4 + I), sh * inside);

  // ---- back plane: fine lattice, deeper (parallax), faint
  vec2 pb = q / (1.0 + dot(q, tilt * 0.6)) * (zoom * 0.72 + 0.28);
  vec4 hb = hexCell(pb, 0.017);
  float eb = hexEdge(hb.xy, 0.017) / max(length(fwidth(pb)), 1e-6);
  float lb = pxLine(eb, 0.3, 1.2);
  float db = oct(pb);
  col += C_ORANGE * lb * (0.035 + 0.25 * fronts * 0.3 + 0.08 * smoothstep(Rmax + 0.2, Rmax, db)) * (1.0 - inside * 0.6);

  // ---- octagon range guides, 8 spokes, wavefront lines
  float gd = abs(fract(dp0 / 0.12 + 0.5) - 0.5) * 0.12;
  col += C_ORANGE * 0.10 * pxLine(gd / max(fw0, 1e-5), 0.3, 1.2) * smoothstep(0.95, 0.4, dp0);
  float sa = atan(q.y, q.x);
  float spoke = abs(fract(sa / (TAU / 8.0) + 0.5) - 0.5) * (TAU / 8.0) * length(q);
  col += C_ORANGE * 0.06 * pxLine(spoke / max(fwidth(q.x) + fwidth(q.y), 1e-5) * 0.7, 0.3, 1.0) * step(0.08, dp0);
  col += mix(C_AMBER, C_BONE, 0.3) * fronts * 1.3;
  // the rim of the deployed field
  col += C_AMBER * 1.2 * pxLine(abs(dp0 - Rmax - 0.035) / max(fw0, 1e-5), 0.8, 2.4) * deploy;

  // ---- core: the field's origin
  col += C_AMBER * (0.5 + 1.5 * kickNow) * exp(-dp / 0.022) * deploy;
  col += C_ORANGE * 0.06 * exp(-dp / 0.35) * deploy;

  // red end-of-plate shift (pattern blue incoming) + breach tint
  float l = luma(col);
  col = mix(col, C_RED * (0.3 + l * 3.0), red);
  col += C_RED * 0.02 * breach * smoothstep(0.9, 0.2, dp0);
  fragColor = vec4(col, 1.0);
}`;

const TICK = 'A.T. FIELD DEPLOYED // ABSOLUTE TERROR FIELD // 位相空間 展開 // PHASE SPACE EXPANDING // FIELD INTERFERENCE: NONE // EVA-01 STANDING BY // MAGI CONSENSUS 3/3 // ';

export default class ATField extends Scene {
  field!: FSPass;
  text = new Layer2D();
  scan = makeScanPass(0.24);
  kicks: [number, number][] = [];
  claps: [number, number][] = [];
  hats: [number, number][] = [];
  T = { s: 0, e: 0, b35: 0, b44: 0 };
  uk = vec2Array(8); uc = vec2Array(3); uh = vec2Array(4);
  mel = new Float32Array(64);

  override init() {
    const au = this.ctx.audio;
    this.T = { s: this.ctx.start, e: this.ctx.end, b35: barTime(au, 35), b44: barTime(au, 44) };
    this.kicks = onsetList(au, 'kick', this.T.s - 0.05, this.T.e, 0.3);
    this.claps = onsetList(au, 'snare', this.T.s - 0.05, this.T.e, 0.5);
    this.hats = onsetList(au, 'hat', this.T.s - 0.05, this.T.e);
    this.field = new FSPass(FIELD_FRAG, {
      t: { value: 0 }, fi: { value: 0 }, zoom: { value: 1 }, deploy: { value: 1 }, red: { value: 0 }, glitch: { value: 0 }, bass: { value: 0 }, kickNow: { value: 0 }, breach: { value: 0 },
      center: { value: new THREE.Vector2(W / 2, H / 2) }, tilt: { value: new THREE.Vector2() },
      uKick: { value: this.uk }, uClap: { value: this.uc }, uHat: { value: this.uh },
      ...spectrumUniforms(this.ctx.spectrum),
    });
  }

  render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides {
    const { renderer, audio: au } = this.ctx;
    const T = this.T, t = f.t, lt = t - T.s;
    const dk = duck(f, au, 1);
    const kick = au.hit('kick', t, 0.1);
    const clap = au.hit('snare', t, 0.12);
    const bass = clamp(au.env('bass', t));
    const bar = songBar(au, t), barI = Math.floor(bar + 1e-4), bp = bar - barI;
    const slam = lt < 0.9;                               // bar 35, beats 1-2: the full-screen card
    const endK = t >= T.b44 + 0.9 ? prog(t, T.b44 + 0.9, T.e, ease.inQuad) : 0; // last 2 beats: red shift
    const phrase = pulse(t, barTime(au, barI - ((barI - 35) % 2)), 0.18); // every 2 bars: punch

    // ---- field uniforms
    fillRecent(this.uk, this.kicks, t);
    fillRecent(this.uc, this.claps, t);
    fillRecent(this.uh, this.hats, t);
    const u = this.field.u;
    u.t!.value = t; u.fi!.value = frameIdx(t);
    u.deploy!.value = 0.3 + 0.7 * prog(lt, 0, 0.5, ease.outExpo);
    u.zoom!.value = (1.0 - 0.05 * dk - 0.08 * pulse(t, T.b35, 0.25)) * (1 - 0.04 * endK);
    u.bass!.value = bass;
    u.kickNow!.value = kick;
    u.red!.value = endK * (0.6 + 0.4 * ((frameIdx(t) >> 2) & 1));
    u.glitch!.value = clamp(clap * 0.9 + endK * 0.8);
    u.breach!.value = clap;
    (u.tilt!.value as THREE.Vector2).set(0.12 * Math.sin(t * 0.37) + 0.08 * bass * Math.sin(t * 1.3), 0.1 * Math.cos(t * 0.29) - 0.06 * bass);
    this.field.render(renderer, out);

    // ---- overlay
    const L = this.text; L.clear();
    const c = L.ctx;
    const nx = -dk * 3, ny = dk * 4; // kick nudge for the panels

    if (slam) {
      // the full-screen title card, stepped in on the downbeat (hard HUD steps, no tweens)
      const k = lt / 0.9;
      c.fillStyle = 'rgba(5,4,3,0.82)'; c.fillRect(0, 300, W, 480);
      c.fillStyle = rgba('orange', 1); c.fillRect(0, 296, W, 4); c.fillRect(0, 780, W, 4);
      const s = k < 0.06 ? 1.08 : 1;
      condensed(c, 'A.T. FIELD', W / 2, 700, 440 * s, { sx: 0.56, color: rgba('bone', 1), align: 'center' });
      c.font = jp(46, 700, true); c.fillStyle = rgba('orange', 1); c.textAlign = 'center';
      c.fillText('絶対恐怖領域　全開', W / 2, 860);
      mono(c, 'ABSOLUTE TERROR FIELD // FULL DEPLOYMENT', W / 2, 262, 20, rgba('orange', 1), { w: 700, align: 'center', track: 5 });
      c.textAlign = 'left';
    } else {
      c.save(); c.translate(nx, ny);
      headerStrip(c, 40, 34, W - 80, { tag: 'A.T. FIELD', tagJp: 'ATフィールド', sub: 'ABSOLUTE TERROR FIELD  //  PHASE SPACE DEPLOYMENT', right: `BAR ${String(barI).padStart(2, '0')}/45  T+${lt.toFixed(2)}`, rightJp: '位相空間 展開' });

      // ---- left: field strength
      const lx = 40, lw = 400;
      const r1 = panel(c, lx, 100, lw, 250, { title: 'FIELD STRENGTH', jp: '位相空間強度' });
      const strength = 1180 + 2700 * bass + 520 * kick;
      mono(c, 'OUTPUT', r1.x + 2, r1.y + 16, 12, rgba('orange', 0.7));
      sevenSeg(c, strength.toFixed(1).padStart(6, '0'), r1.x, r1.y + 26, 76, rgba('amber', 1), rgba('orange', 0.07), { glow: 8 });
      mono(c, 'MJ', r1.x + r1.w - 30, r1.y + 100, 14, rgba('orange', 0.8), { w: 700 });
      segMeter(c, r1.x, r1.y + 122, r1.w, 20, 30, clamp(0.25 + 0.75 * bass + 0.2 * kick), { hotFrom: 0.83 });
      const s0: [number, number] = [0, 0];
      let lrms = 0, rrms = 0;
      for (let i = 0; i < 32; i++) { au.waveAt(t - i * 0.0012, s0); lrms = Math.max(lrms, Math.abs(s0[0])); rrms = Math.max(rrms, Math.abs(s0[1])); }
      mono(c, 'L', r1.x, r1.y + 168, 12, rgba('orange', 0.8), { w: 700 });
      segMeter(c, r1.x + 20, r1.y + 158, r1.w - 20, 11, 40, lrms, { hotFrom: 0.9 });
      mono(c, 'R', r1.x, r1.y + 186, 12, rgba('orange', 0.8), { w: 700 });
      segMeter(c, r1.x + 20, r1.y + 176, r1.w - 20, 11, 40, rrms, { hotFrom: 0.9 });

      // ---- left: wave pattern (the real waveform)
      const r2 = panel(c, lx, 366, lw, 196, { title: 'WAVE PATTERN', jp: '波形' });
      waveScope(c, au, t, r2.x, r2.y, r2.w, r2.h - 14, { win: 0.045, col: rgba('amber', 1), gain: 1.1 });
      mono(c, 'PATTERN ORANGE', r2.x, r2.y + r2.h + 2, 11, rgba('orange', 0.75), { w: 600 });
      mono(c, `${(au.bassMidi(t) || 0).toFixed(1).padStart(4, '0')} MIDI`, r2.x + r2.w, r2.y + r2.h + 2, 11, rgba('orange', 0.75), { w: 600, align: 'right' });

      // ---- right: status list
      const rx = W - 440, rw = 400;
      const r3 = panel(c, rx, 100, rw, 262, { title: 'FIELD STATUS', jp: '状態' });
      const dep = prog(lt, 0.9, 1.8, ease.outCubic);
      const breach = clap > 0.35;
      statusRow(c, r3.x, r3.y + 18, r3.w, 'PHASE SPACE', '位相空間', dep < 1 ? `${(dep * 100).toFixed(1)}%` : 'EXPANDED', rgba('green', 1));
      statusRow(c, r3.x, r3.y + 46, r3.w, 'INTEGRITY', '強度', `${(92 + 7.9 * bass).toFixed(1)}%`, rgba('amber', 1));
      statusRow(c, r3.x, r3.y + 74, r3.w, 'INTERFERENCE', '干渉', breach ? 'BREACH' : 'NONE', breach ? rgba('red', 1) : rgba('green', 1), { box: breach });
      statusRow(c, r3.x, r3.y + 102, r3.w, 'NEUTRALIZE', '中和', `${(clap * 38).toFixed(1).padStart(4, '0')}%`, rgba('amber', 1));
      statusRow(c, r3.x, r3.y + 130, r3.w, 'WAVE FRONT', '波面', `R${String(Math.floor(((t - (this.kicks[lastIdx(this.kicks, t)]?.[0] ?? t)) * 1.35) / 0.12) + 1).padStart(2, '0')}`, rgba('amber', 1));
      statusRow(c, r3.x, r3.y + 158, r3.w, 'SYNC', '同調', 'LOCKED', rgba('green', 1));
      statusRow(c, r3.x, r3.y + 186, r3.w, 'MAGI', 'マギ', '3/3 承認', rgba('green', 1));

      // ---- right: the eight octant layers (the angle → band mapping of the field)
      const r4 = panel(c, rx, 378, rw, 262, { title: 'OCTANT LAYERS', jp: '層' });
      for (let i = 0; i < 8; i++) {
        const b0 = 10 + Math.round((i * 46) / 8), b1 = 10 + Math.round(((i + 1) * 46) / 8);
        const v = smoothstep(0.35, 1, melMean(au, t, b0, b1));
        const yy = r4.y + 4 + i * 27;
        mono(c, `L${i + 1}`, r4.x, yy + 12, 12, rgba('orange', 0.85), { w: 700 });
        segMeter(c, r4.x + 34, yy, r4.w - 110, 14, 24, v, { hotFrom: 0.85 });
        mono(c, `${melHz(b0)}`, r4.x + r4.w, yy + 12, 11, rgba('orange', 0.65), { align: 'right' });
      }

      // ---- right: hex dump, a row per 8th
      const step = Math.floor(f.beat * 2);
      c.font = font(F.mono(400), 12);
      for (let r = 0; r < 11; r++) {
        const hot = r === 0;
        c.fillStyle = rgba(hot ? 'amber' : 'orange', hot ? 0.95 : 0.5 - r * 0.03);
        c.fillText(`${(0xa7f0 + ((step + r) % 64) * 16).toString(16).toUpperCase()}  ${hexData(r, step - r, 8)} ${hexData(r + 40, step - r, 8)}`, rx + 10, 670 + r * 19);
      }
      // vertical JP caption on the right edge
      jpVertical(c, '絶対恐怖領域', W - 26, 110, 22, rgba('orange', 0.75), true);

      // ---- centre: reticle, octagon labels, origin readout
      const cx = W / 2, cy = H / 2;
      c.strokeStyle = rgba('orange', 0.5); c.lineWidth = 1;
      c.beginPath();
      c.moveTo(cx - 470, cy); c.lineTo(cx - 40, cy); c.moveTo(cx + 40, cy); c.lineTo(cx + 470, cy);
      c.moveTo(cx, cy - 500); c.lineTo(cx, cy - 40); c.moveTo(cx, cy + 40); c.lineTo(cx, cy + 500);
      for (let i = -20; i <= 20; i++) { if (!i) continue; const l = i % 5 ? 4 : 9; c.moveTo(cx + i * 22, cy - l); c.lineTo(cx + i * 22, cy + l); c.moveTo(cx - l, cy + i * 22); c.lineTo(cx + l, cy + i * 22); }
      c.stroke();
      octPath(c, cx, cy, 30 + 6 * kick); c.strokeStyle = rgba('amber', 0.9); c.lineWidth = 1.5; c.stroke();
      brackets(c, cx - 60, cy - 60, 120, 120, 14, rgba('orange', 0.9), 2);
      for (let i = 1; i <= 4; i++) mono(c, `R-${String(i).padStart(2, '0')}`, cx + i * 0.12 * H * 0.7071 + 6, cy - i * 0.12 * H * 0.7071 - 4, 11, rgba('orange', 0.7), { w: 600 });
      mono(c, `ORIGIN X+0.000 Y+0.000  θ ${(Math.sin(t * 0.37) * 6.9).toFixed(2)}°`, cx + 70, cy + 80, 11, rgba('orange', 0.8), { w: 600 });
      // clap: the breach tag
      if (breach) {
        const a = clamp((clap - 0.35) * 3);
        c.globalAlpha = a;
        c.fillStyle = rgba('red', 1); c.fillRect(cx - 150, cy - 170, 300, 44);
        mono(c, 'FIELD BREACH', cx, cy - 141, 20, rgba('ink', 1), { w: 700, align: 'center', track: 4 });
        c.font = jp(18, 700, false); c.fillStyle = rgba('red', 1); c.textAlign = 'center'; c.fillText('侵食　検知', cx, cy - 180); c.textAlign = 'left';
        c.globalAlpha = 1;
      }
      c.restore();

      // ---- the docked title card, bottom-left (on its own black block)
      c.save(); c.beginPath(); c.moveTo(30, 612); c.lineTo(560, 612); c.lineTo(600, 652); c.lineTo(600, 1062); c.lineTo(30, 1062); c.closePath();
      c.fillStyle = 'rgba(5,4,3,0.9)'; c.fill(); c.strokeStyle = rgba('orange', 0.6); c.lineWidth = 1.5; c.stroke(); c.restore();
      const tc = endK > 0 && ((frameIdx(t) >> 2) & 1) ? rgba('red', 1) : rgba('bone', 1);
      mono(c, 'ABSOLUTE TERROR FIELD', 50, 640, 15, rgba('orange', 1), { w: 700, track: 4 });
      condensed(c, 'A.T.', 44, 842, 250, { sx: 0.58, color: tc });
      condensed(c, 'FIELD', 44, 1040, 250, { sx: 0.58, color: tc });
      c.font = jp(34, 700, true); c.fillStyle = rgba('orange', 1);
      c.fillText('位相空間', 432, 790); c.fillText('展開', 432, 834);
      evaLabel(c, 434, 870, 'phase space', undefined, { size: 0.9 });
      // bottom ticker
      ticker(c, 620, 1046, W - 660, TICK, t, { speed: 110, color: rgba('orange', 0.75) });
      c.fillStyle = rgba('orange', 0.6); c.fillRect(620, 1056, W - 660, 1);
      // end: incoming warning
      if (endK > 0) {
        const on = (frameIdx(t) >> 3) & 1;
        c.fillStyle = rgba('red', on ? 1 : 0.35); c.fillRect(W / 2 - 260, 900, 520, 52);
        mono(c, 'WARNING // PATTERN BLUE', W / 2, 935, 22, rgba('ink', 1), { w: 700, align: 'center', track: 4 });
      }
    }
    this.ctx.comp.draw(renderer, L.upload(), out);
    this.scan.u.t!.value = t;
    this.scan.render(renderer, out);

    const hit0 = pulse(t, T.b35, 0.09);
    const sh = 7 * hit0 + 2.2 * kick * (bp < 0.02 ? 1 : 0.4);
    const fi = frameIdx(t);
    return {
      bloom: 0.75, bloomThreshold: 0.7, bloomRadius: 0.75, halation: 0.12, vignette: 0.5, grain: 0.05,
      ca: 1.2 + 3 * clap + 5 * hit0,
      flash: 0.4 * pulse(t, T.b35, 0.035) + 0.06 * pulse(t, barTime(au, barI), 0.04) * (barI % 2 ? 0 : 1),
      zoom: 1 + 0.05 * hit0 + 0.012 * phrase + 0.006 * dk,
      shake: [sh * Math.sin(fi * 2.1), sh * Math.cos(fi * 1.7)],
    };
  }
}
