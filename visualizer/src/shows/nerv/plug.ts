// Ported from bizarro/evangelion app/src/scenes/plug.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// plug — "ENTRY PLUG" (break 2 → drop 2, bars 54–60, 102.02 – 112.82 s).
// First-person inside the entry plug: an octagonal tunnel of hex-plated walls and frame rings
// receding to the Eva's core, rendered as one full-screen shader. The camera depth is the integral
// of a speed that is a pure function of the song (Drive, precomputed at init): during the two break
// bars (pads only) the plug screws in slowly while the LCL floods the view from the bottom (bubbles,
// meniscus, the 注水 readouts climb with the pads). On the drop (bar 56) the plug locks — hard stop,
// flash, the 神経接続 開始 card, the plug walls flicker through the interface colours while the bass
// swells — then the first kick launches the race: every kick is a speed impulse (and a light ping
// shooting down the tunnel), claps send a red ring, the bass swells the core and pushes the base
// speed. The walls are a world-fixed spectrogram: each hex plate is written with the live mel
// spectrum (angle = band, low at the floor) at the far end of the tunnel and then rushes past.
// Around it: plug depth + socket schematic, LCL panel, a kick-driven ECG, the startup call-outs
// ticked off one per strong kick (A10 神経接続 … シンクロ率 41.3%), sync ratio and harmonics.
// Last beat: 発進 (LAUNCH), hard cut to the positron rifle.
import * as THREE from 'three';
import { Scene, type Frame, type PostOverrides } from '../../show/scene.ts';
import { FSPass, Layer2D, W, H } from '../../show/gl.ts';
import { LIN, rgba, type PaletteKey } from '../../show/palette.ts';
import { F, font } from '../../show/type.ts';
import { SPECTRUM_GLSL, spectrumUniforms } from '../../show/spectrum.ts';
import { clamp, ease, frameIdx, hash, prog, pulse, smoothstep } from '../../show/util.ts';
import { GLSL_EVA, barTime, brackets, chamferPath, condensed, duck, hexData, jp, makeScanPass, panel, segMeter, sevenSeg, songBar, ticker } from './_eva.ts';
import { fillRecent, headerStrip, jpVertical, mono, octPath, onsetList, statusRow, vec2Array, waveScope } from './atfield-kit.ts';
import { Drive, STAGES, ecgTrace, plugSchematic } from './plug-kit.ts';
import { nervText, unitName } from './show-text.ts';


const PF = 'rgba(8,5,2,0.88)'; // panel fill: opaque enough to read over the tunnel
const CX = 960, CY = 470; // vanishing point (canvas px, y down)
const DZ = 1.6; //           frame ring spacing (world units; tunnel apothem = 1)
const DW = 7.0; //           the spectrogram is written this far ahead of the camera

const TUNNEL_FRAG = /* glsl */ `
${GLSL_EVA}
${SPECTRUM_GLSL}
uniform float t, zc, fov, roll, lcl, clarity, bass, kickNow, fi, race, flickAmt, pad, vel, glitch, coreK;
uniform vec3 flickCol;
uniform vec2 center;
uniform sampler2D uZT;
uniform vec3 uZTInfo;          // z0, texels per unit, n
uniform vec2 uKick[8];
uniform vec2 uClap[4];

const float FL = 0.82842712;   // octagon face length (apothem 1)
const float CR = 0.079716;     // wall hex circumradius: 48 cells around (sqrt3 * CR * 48 = 8 * FL)
const float DZ = ${DZ.toFixed(3)};
const float DW = ${DW.toFixed(3)};

float octR(vec2 v) { v = abs(v); return max(max(v.x, v.y), (v.x + v.y) * 0.70710678); }
float writeTime(float z) {
  float x = clamp((z - uZTInfo.x) * uZTInfo.y, 0.0, uZTInfo.z - 1.001);
  int i = int(floor(x));
  float a = texelFetch(uZT, ivec2(i, 0), 0).r, b = texelFetch(uZT, ivec2(i + 1, 0), 0).r;
  return min(mix(a, b, x - float(i)), t);
}

void main() {
  vec2 px = FRAG_PX;
  // clap row glitch (stable over the frame's shutter)
  float row = floor(px.y / 6.0);
  if (hash12(vec2(row, fi)) < 0.12 * glitch) px.x += (hash12(vec2(row * 1.7, fi + 3.1)) - 0.5) * 90.0 * glitch;

  vec2 q = (px - center) / ${H.toFixed(1)};
  float cr = cos(roll), sr = sin(roll);
  q = mat2(cr, sr, -sr, cr) * q;
  float o = max(octR(q), 1e-4);
  float zd = fov / o;                 // distance ahead to the wall hit
  float zw = zc + zd;                 // world depth of the hit
  float ang = atan(q.y, q.x);
  float kf = floor(ang / (TAU / 8.0) + 0.5);
  float s = tan(ang - kf * TAU / 8.0);  // position along the face, ±FL/2 at the corners
  float u = kf * FL + s;              // unrolled wall coordinate (period 8 FL)
  float fwu = min(fwidth(u), fwidth(mod(u, 8.0 * FL)));
  float fwz = max(fwidth(zw), 1e-6);
  vec2 wp = vec2(u, zw);

  // ---- wall plates: hex grid, each plate lit by the spectrum it was written with
  vec4 hc = hexCell(wp, CR);
  vec2 g = hc.xy, cc = wp - g;
  float fwp = max(length(vec2(fwu, fwz)), 1e-6);
  float epx = hexEdge(g, CR) / fwp;
  float lod = smoothstep(0.5, 0.12, fwp / CR);
  float edgeL = pxLine(epx, 0.5, 1.6) * lod;
  float fillM = mix(0.55, smoothstep(1.6, 3.2, epx), lod);
  float tau = writeTime(cc.y - DW);
  float ub = abs(mod(cc.x + 2.0 * FL + 4.0 * FL, 8.0 * FL) - 4.0 * FL) / (4.0 * FL); // 0 floor .. 1 ceiling
  float en = pow(smoothstep(0.62, 1.0, melAt(tau, mix(1.0, 58.0, ub))), 2.2);
  float cellH = hash12(hc.zw + 7.3);

  // ---- frame rings (every DZ; heavy segmented ribs every 4th)
  float rk = floor(zw / DZ + 0.5);
  float rd = abs(zw - rk * DZ);
  float heavy = step(abs(mod(rk, 4.0)), 0.5);
  float ringL = pxLine(rd / fwz, 0.6, 1.8);
  float ribW = mix(0.03, 0.085, heavy);
  float rib = smoothstep(ribW + fwz, ribW, rd) * mix(1.0, step(0.07, abs(s)) * step(abs(s), 0.37), heavy);
  float tr = writeTime(rk * DZ - DW);
  float eR = pow(smoothstep(0.5, 1.0, 0.5 * (melAt(tr, 1.5) + melAt(tr, 4.5))), 1.4);

  // ---- corner rails and speed streaks
  float railL = pxLine(abs(FL * 0.5 - abs(s)) / max(fwu, 1e-6), 0.6, 1.8);
  float cw = FL / 6.0;
  float cid = floor(u / cw);
  float lineU = pxLine(abs(fract(u / cw) - 0.5) * cw / max(fwu, 1e-6), 0.4, 1.3);
  float sg = fract(zw * 0.11 + hash11(cid * 3.7) * 9.0);
  float streak = lineU * step(0.55, hash11(cid + 0.5)) * smoothstep(0.0, 0.05, sg) * smoothstep(0.02 + 0.006 * vel, 0.0, sg - 0.05);

  // ---- kick pings (light shooting down the tunnel) and clap rings (red)
  float ping = 0.0, clapR = 0.0;
  for (int i = 0; i < 8; i++) {
    float age = t - uKick[i].x;
    if (age < 0.0 || age > 1.0) continue;
    float d = zd - (0.6 + age * 34.0);
    ping += uKick[i].y * exp(-age * 3.2) * exp(-d * d / 1.4);
  }
  for (int i = 0; i < 4; i++) {
    float age = t - uClap[i].x;
    if (age < 0.0 || age > 1.2) continue;
    float d = zd - (0.9 + age * 20.0);
    clapR += uClap[i].y * exp(-age * 2.6) * exp(-d * d / 0.35);
  }

  // ---- compose the wall
  float fog = exp(-zd * 0.07);
  float nearDim = 0.08 + 0.92 * smoothstep(1.1, 4.2, zd);
  vec3 hot = mix(C_ORANGE, C_AMBER, sat(en * 0.7 + ping * 0.6));
  vec3 wall = C_ORANGE * 0.003;
  wall += hot * (0.0015 + 0.2 * en * step(0.45, cellH)) * fillM * (0.5 + 0.7 * cellH);
  wall += C_ORANGE * (0.045 + 0.4 * en) * edgeL;
  wall += C_ORANGE * (0.45 + 1.1 * eR + 0.6 * pad * (1.0 - race)) * ringL;
  wall += C_ORANGE * rib * mix(0.10, 0.32 + 0.5 * eR, heavy);
  wall += C_AMBER * (0.35 + 0.5 * eR) * railL;
  wall += C_AMBER * streak * 2.2 * race * smoothstep(8.0, 30.0, vel);
  wall += hot * ping * (0.35 * fillM + 1.4 * ringL + 0.5 * edgeL + 0.4 * rib);
  wall += C_BONE * smoothstep(0.9, 1.6, ping + en * 0.6) * ringL * 0.6;
  wall = mix(wall, C_RED * (0.12 * fillM + 2.0 * ringL + 1.0 * rib + 0.6 * edgeL), sat(clapR));
  // interface flicker at the lock (the plug walls cycling colours before the link settles)
  wall = mix(wall, flickCol * (luma(wall) * 2.6 + 0.02 * fillM), flickAmt);
  vec3 col = wall * fog * nearDim;

  // ---- depth haze (LCL volume) and the core light at the far end
  col += C_ORANGE * 0.025 * (1.0 - fog) * (0.6 + 0.4 * pad);
  col += C_AMBER * exp(-o / 0.05) * (0.25 + 0.35 * coreK);
  col += C_BONE * exp(-o / 0.011) * (0.6 + 1.6 * coreK);
  col += C_AMBER * 0.35 * (kickNow * race) * exp(-o / 0.12);

  // ---- LCL: the fluid line rises from the floor during the break; clears after electrolysis
  vec2 sp = FRAG_PX;
  float L = lcl * 1180.0 - 60.0 + (6.0 * sin(sp.x * 0.012 + t * 2.1) + 3.0 * sin(sp.x * 0.031 - t * 3.4)) * (1.0 - step(1.0, lcl));
  float wet = step(sp.y, L);
  float tintK = 1.0 - 0.65 * clarity;
  vec3 wetCol = col * mix(vec3(1.0), vec3(1.05, 0.72, 0.42), tintK) + C_ORANGE * 0.004 * tintK;
  vec3 dryCol = mix(col, vec3(luma(col)), 0.55) * 0.42;
  col = mix(dryCol, wetCol, wet);
  col += C_AMBER * 1.3 * pxLine(abs(sp.y - L) * PX_SCALE, 0.8, 2.2) * (1.0 - step(1.0, lcl));
  col += C_ORANGE * 0.10 * exp(-max(L - sp.y, 0.0) / 30.0) * wet * (1.0 - step(1.0, lcl));
  // bubbles: columns of rising rings, dense while flooding, sparse after
  float bub = 0.0;
  for (int j = 0; j < 2; j++) {
    float cs = j == 0 ? 54.0 : 31.0;
    float colI = floor(sp.x / cs);
    float vb = (j == 0 ? 170.0 : 110.0) + hash11(colI * 1.3 + float(j) * 17.0) * 160.0;
    float yy = sp.y - t * vb;
    float cellY = floor(yy / cs);
    vec2 id = vec2(colI, cellY + float(j) * 101.0);
    float h1 = hash12(id);
    float dens = mix(0.05, 0.22, 1.0 - clarity) * (j == 0 ? 1.0 : 0.7);
    if (h1 < dens) {
      vec2 c0 = vec2((colI + 0.5 + 0.3 * sin(t * 3.0 + h1 * 40.0)) * cs, (cellY + 0.5) * cs + t * vb);
      float r = (j == 0 ? 3.0 : 1.8) + 4.0 * hash12(id + 3.1);
      float d = abs(length(sp - c0) - r);
      bub += pxLine(d * PX_SCALE, 0.5, 1.4) * (0.5 + 0.5 * h1 / dens);
    }
  }
  col += C_AMBER * 0.4 * bub * wet;

  fragColor = vec4(col, 1.0);
}`;

const TICK = (unit: string) => 'ENTRY PLUG INSERTION // エントリープラグ挿入 // LCL 注水 // PLUG LOCK // 神経接続 開始 // A10 NERVE CONNECTION: NO ABNORMALITY // 双方向回線 開きます // HARMONICS ALL NORMAL // SYNC RATIO 41.3% // ' + unit + ' STANDING BY // ';

// interface flicker colours at the lock (stepped per 16th)
const FLICK: PaletteKey[] = ['orange', 'red', 'green', 'amber', 'bone', 'red', 'orange', 'green', 'purple', 'amber', 'red', 'bone'];

export default class Plug extends Scene {
  tunnel!: FSPass;
  text = new Layer2D();
  scan = makeScanPass(0.24);
  drive!: Drive;
  T = { s: 0, e: 0, lock: 0, k1: 0, lcl: 0, fire: 0, beat: 0.45 };
  kicks: [number, number][] = [];
  kicksAll: [number, number][] = [];
  claps: [number, number][] = [];
  hats: number[] = [];
  done: number[] = [];
  act: number[] = [];
  uk = vec2Array(8); uc = vec2Array(4);
  mel = new Float32Array(64);
  roll0 = 0;

  override init() {
    const au = this.ctx.audio;
    const s = this.ctx.start, e = this.ctx.end, beat = 60 / au.bpm;
    const d2 = au.sections.find((x) => x.name === 'drop2');
    // AAAVS: other songs name their sections differently; the planner passes the drop downbeat as params.drop
    const pd = this.ctx.params.drop;
    const lock = d2 && d2.start > s && d2.start < e ? d2.start : typeof pd === 'number' && pd > s && pd < e ? pd : barTime(au, 56);
    const strong = onsetList(au, 'kick', lock + 0.3, e - 0.2, 0.8);
    const k1 = strong[0]?.[0] ?? lock + beat * 4 / 3;
    this.T = { s, e, lock, k1, lcl: lock - beat, fire: e - beat, beat };
    this.kicksAll = onsetList(au, 'kick', s - 3, e, 0.3);
    this.kicks = this.kicksAll.filter(([t]) => t >= k1 - 0.03);
    this.claps = onsetList(au, 'snare', k1 - 0.05, e, 0.5);
    this.hats = onsetList(au, 'hat', s - 3, e).map((h) => h[0]);
    this.roll0 = 0.2 * (lock - s);

    // startup call-outs: 0–3 on the break's clock, 4–14 one per strong kick after the lock
    const dn: number[] = [s + 0.25, lock, this.T.lcl, lock];
    const nK = STAGES.length - 4;
    for (let i = 0; i < nK; i++) dn.push(strong[i]?.[0] ?? k1 + ((this.T.fire - 0.1 - k1) * i) / (nK - 1));
    this.done = dn;
    this.act = dn.map((_, i) => (i === 0 ? s : i === 1 ? s : i === 2 ? s + 0.45 : i === 3 ? lock - 2 * beat : dn[i - 1]!));

    // the insertion drive: z(t) = ∫ speed(t) dt, speed a pure function of the song
    const speed = (t: number) => {
      const bass = clamp(au.env('bass', t));
      if (t < lock) return 1.3 + 1.7 * clamp(au.env('other', t));
      if (t < k1) { const k = (t - lock) / (k1 - lock); return 0.12 + 11 * k * k * (0.5 + 0.5 * bass); }
      return 11 + 6 * bass + 46 * au.hit('kick', t, 0.06);
    };
    this.drive = new Drive(s - 4, e + 0.5, 1 / 1000, speed);
    const inv = this.drive.inverseTexture(4096);

    this.tunnel = new FSPass(TUNNEL_FRAG, {
      t: { value: 0 }, zc: { value: 0 }, fov: { value: 0.95 }, roll: { value: 0 }, lcl: { value: 0 }, clarity: { value: 0 },
      bass: { value: 0 }, kickNow: { value: 0 }, fi: { value: 0 }, race: { value: 0 }, flickAmt: { value: 0 }, pad: { value: 0 },
      vel: { value: 0 }, glitch: { value: 0 }, coreK: { value: 0 },
      flickCol: { value: new THREE.Vector3(...LIN.orange) }, center: { value: new THREE.Vector2(CX, H - CY) },
      uZT: { value: inv.tex }, uZTInfo: { value: inv.info },
      uKick: { value: this.uk }, uClap: { value: this.uc },
      ...spectrumUniforms(this.ctx.spectrum),
    });
  }

  roll(t: number, bass: number) {
    const T = this.T;
    if (t < T.lock) return 0.2 * (t - T.s);
    const a = t - T.lock;
    return this.roll0 + 0.06 * Math.exp(-a * 5) * Math.sin(a * 30) + 0.03 * Math.sin(t * 1.7) * bass;
  }

  /** Number of hats so far (data rows step on the hats). */
  hatStep(t: number) {
    let lo = 0, hi = this.hats.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.hats[m]! <= t) lo = m + 1; else hi = m; }
    return lo;
  }

  /** Stage state: 0 pending, 1 active, 2 done; plus the time since done. */
  stage(i: number, t: number): [number, number] {
    if (t >= this.done[i]!) return [2, t - this.done[i]!];
    if (t >= this.act[i]!) return [1, 0];
    return [0, 0];
  }

  render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides {
    const { renderer, audio: au } = this.ctx;
    const T = this.T, t = f.t, lt = t - T.s, fi = frameIdx(t);
    const dk = duck(f, au, 1);
    const kick = au.hit('kick', t, 0.1) * (t >= T.k1 - 0.03 ? 1 : 0);
    const clap = t >= T.k1 - 0.05 ? au.hit('snare', t, 0.12) : 0;
    const bass = clamp(au.env('bass', t));
    const pad = clamp(au.env('other', t));
    const bar = songBar(au, t), barI = Math.floor(bar + 1e-4);
    const locked = t >= T.lock, race = t >= T.k1 ? 1 : 0;
    const lockPh = locked && !race; // the 神経接続 card
    const fire = t >= T.fire;
    const vel = this.drive.vel(t);
    const zc = this.drive.at(t);
    const roll = this.roll(t, bass);
    const lcl = locked ? 1.02 : clamp(prog(t, T.s + 0.15, T.lcl, ease.inOutQuad) * 1.02, 0, 1.02);
    const clar = prog(t, this.done[5]!, this.done[5]! + 0.35, ease.outCubic);

    // ---- tunnel
    fillRecent(this.uk, this.kicks, t);
    fillRecent(this.uc, this.claps, t);
    const u = this.tunnel.u;
    u.t!.value = t; u.fi!.value = fi; u.zc!.value = zc; u.roll!.value = roll;
    u.fov!.value = 0.95 - 0.2 * clamp((vel - 10) / 40) + 0.04 * pulse(t, T.lock, 0.08);
    u.lcl!.value = lcl; u.clarity!.value = clar; u.bass!.value = bass; u.kickNow!.value = kick;
    u.race!.value = race; u.pad!.value = pad; u.vel!.value = vel; u.glitch!.value = clap;
    u.coreK!.value = (locked ? 0.4 + 0.9 * bass : 0.15 * pad) + 1.2 * pulse(t, T.lock, 0.12) + (fire ? 2 * prog(t, T.fire, T.e, ease.inQuad) : 0);
    const fk = lockPh ? Math.floor((t - T.lock) / (T.beat / 4)) : 0;
    u.flickAmt!.value = lockPh ? 0.85 * (1 - 0.5 * prog(t, T.lock, T.k1)) : 0;
    (u.flickCol!.value as THREE.Vector3).set(...LIN[FLICK[fk % FLICK.length]!]);
    this.tunnel.render(renderer, out);

    // ---- overlay
    const L = this.text; L.clear();
    const c = L.ctx;
    const nx = -dk * 3, ny = dk * 4;
    const O = (a = 1) => rgba('orange', a);

    c.save(); c.translate(nx, ny);
    const phaseJp = fire ? '発進' : race ? '神経接続' : locked ? 'プラグ固定' : 'LCL注水';
    headerStrip(c, 40, 34, W - 80, { tag: 'ENTRY PLUG', tagJp: 'エントリープラグ', sub: `${unitName(nervText(this.ctx.params))}  //  INSERTION + ACTIVATION SEQUENCE`, right: `BAR ${String(barI).padStart(2, '0')}/60  T+${lt.toFixed(2)}`, rightJp: phaseJp });

    // ================= left column
    const lx = 40, lw = 390;
    // P1: plug depth + socket schematic
    const ins = locked ? 1 : prog(zc, this.drive.at(T.s), this.drive.at(T.lock), ease.linear);
    const r1 = panel(c, lx, 100, lw, 330, { title: 'PLUG DEPTH', jp: '挿入深度', fill: PF });
    mono(c, 'INSERTION', r1.x, r1.y + 14, 11, O(0.7), { w: 600 });
    const depth = 43.6 * ins;
    sevenSeg(c, depth.toFixed(2).padStart(5, '0'), r1.x, r1.y + 24, 56, locked ? rgba('amber', 1) : rgba('amber', 0.95), O(0.07));
    mono(c, 'M', r1.x + 196, r1.y + 78, 13, O(0.8), { w: 700 });
    const rowsY = r1.y + 112;
    const kv = (k: string, v: string, y: number, vc = O(1)) => { mono(c, k, r1.x, y, 11, O(0.65), { w: 600 }); mono(c, v, r1.x + 206, y, 12, vc, { w: 700, align: 'right' }); };
    kv('ROTATION', `${((roll * 180) / Math.PI).toFixed(2)}°`, rowsY);
    kv('VELOCITY', `${vel.toFixed(1).padStart(5, '0')} m/s`, rowsY + 22);
    kv('ANGLE', `${(0.4 * Math.sin(t * 0.8)).toFixed(3)} rad`, rowsY + 44);
    kv('STATUS', locked ? 'LOCKED' : 'INSERTING', rowsY + 66, locked ? rgba('green', 1) : rgba('amber', blinkA(t, 3)));
    c.font = jp(13, 600, false); c.fillStyle = O(0.7); c.fillText(locked ? 'プラグ固定完了' : '挿入中', r1.x, rowsY + 90);
    const hs = this.hatStep(t);
    c.font = font(F.mono(400), 10);
    for (let r = 0; r < 4; r++) { c.fillStyle = O(r === 0 ? 0.85 : 0.45 - r * 0.08); c.fillText(`${(0x5e0 + ((hs + r) % 64) * 8).toString(16).toUpperCase()} ${hexData(r + 11, hs - r, 8)}`, r1.x, rowsY + 114 + r * 14); }
    plugSchematic(c, r1.x + 214, r1.y, 156, r1.h - 38, ins, prog(t, T.lock, T.lock + 0.12), {});
    segMeter(c, r1.x, r1.y + r1.h - 16, r1.w, 12, 36, ins, { hotFrom: 1.1, color: rgba('amber', 1) });

    // P2: LCL
    const r2 = panel(c, lx, 446, lw, 262, { title: 'LCL', jp: '注水', fill: PF });
    const lclP = clamp(lcl) * 100;
    mono(c, clar > 0 ? 'ELECTROLYSIS' : 'FLOODING', r2.x, r2.y + 14, 11, O(0.7), { w: 600 });
    sevenSeg(c, lclP.toFixed(1).padStart(5, '0'), r2.x, r2.y + 24, 50, lclP >= 100 ? rgba('green', 1) : rgba('amber', 1), O(0.07));
    mono(c, '%', r2.x + 196, r2.y + 70, 14, O(0.8), { w: 700 });
    // vertical tank
    segMeter(c, r2.x + r2.w - 40, r2.y + 4, 40, 110, 16, clamp(lcl), { vertical: true, hotFrom: 1.1, color: rgba('amber', 1) });
    mono(c, 'TANK', r2.x + r2.w - 20, r2.y + 130, 10, O(0.7), { w: 600, align: 'center' });
    const press = 101.3 + 38 * clamp(lcl) + 6 * bass;
    statusRow(c, r2.x, r2.y + 100, r2.w - 60, 'PRESSURE', '圧力', `${press.toFixed(1)} kPa`, rgba('amber', 1));
    statusRow(c, r2.x, r2.y + 124, r2.w - 60, 'TEMP', '温度', `${(35.4 + 1.2 * clamp(lcl) + 0.2 * pad).toFixed(1)}°C`, rgba('amber', 1));
    statusRow(c, r2.x, r2.y + 148, r2.w, 'O2 SATURATION', '酸素', `${(62 + 36 * clamp(lcl)).toFixed(1)}%`, rgba('amber', 1));
    const el = this.stage(5, t);
    statusRow(c, r2.x, r2.y + 172, r2.w, 'ELECTROLYSIS', '電化', el[0] === 2 ? 'ON' : el[0] === 1 ? 'STANDBY' : 'OFF', el[0] === 2 ? rgba('green', 1) : O(0.8), { box: el[0] === 2 && el[1] < 0.3 });
    mono(c, `${hexData(3, Math.floor(f.beat * 2), 6)}  VISC ${(1.02 + 0.03 * pad).toFixed(3)}  PH 7.${String(Math.floor(pad * 90)).padStart(2, '0')}`, r2.x, r2.y + r2.h - 4, 10, O(0.5), { w: 500 });

    // P3: pulse (ECG from the kicks, over the real waveform)
    const clapHot = clap > 0.3;
    const r3 = panel(c, lx, 724, lw, 276, { title: 'PULSE', jp: '脈拍', fill: PF, color: clapHot ? rgba('red', 1) : undefined });
    c.strokeStyle = O(0.14); c.lineWidth = 1; c.beginPath();
    for (let i = 1; i < 10; i++) { const gx = r3.x + (r3.w * i) / 10; c.moveTo(gx, r3.y); c.lineTo(gx, r3.y + 130); }
    for (let i = 1; i < 4; i++) { const gy = r3.y + (130 * i) / 4; c.moveTo(r3.x, gy); c.lineTo(r3.x + r3.w, gy); }
    c.stroke();
    ecgTrace(c, au, this.kicks, t, r3.x, r3.y, r3.w, 130, { col: rgba('green', 1), span: 2.4 });
    waveScope(c, au, t, r3.x, r3.y + 140, r3.w, 56, { win: 0.05, col: rgba('amber', 0.9), gain: 1.0, grid: false, n: 180, lw: 1.2 });
    const hr = race ? 133 + Math.round(8 * kick) : 0;
    mono(c, 'HR', r3.x, r3.y + r3.h - 4, 11, O(0.7), { w: 600 });
    mono(c, race ? `${hr} BPM` : '--- BPM', r3.x + 30, r3.y + r3.h - 4, 13, race ? rgba('green', 1) : O(0.5), { w: 700 });
    mono(c, `NERVE ${race ? 'ACTIVE' : 'IDLE'}`, r3.x + r3.w, r3.y + r3.h - 4, 11, race ? rgba('green', 1) : O(0.6), { w: 700, align: 'right' });
    c.font = jp(13, 600, false); c.fillStyle = O(0.6); c.textAlign = 'center'; c.fillText('パイロット 心拍', r3.x + r3.w / 2, r3.y + r3.h - 4); c.textAlign = 'left';

    // ================= right column
    const rx = W - 430, rw = 390;
    const rA = panel(c, rx, 100, rw, 500, { title: 'STARTUP', jp: '起動手順', fill: PF });
    for (let i = 0; i < STAGES.length; i++) {
      const st = STAGES[i]!, [s, ago] = this.stage(i, t);
      const yy = rA.y + 18 + i * 29.3;
      const fresh = s === 2 && ago < 0.35;
      if (fresh) { c.fillStyle = rgba(st.col ?? 'green', 0.9 * (1 - ago / 0.35)); c.fillRect(rA.x - 4, yy - 16, rA.w + 8, 23); }
      const lc = s === 0 ? O(0.3) : fresh ? rgba('ink', 1) : O(0.95);
      mono(c, String(i + 1).padStart(2, '0'), rA.x, yy, 11, s === 0 ? O(0.25) : O(0.6), { w: 600 });
      mono(c, st.en, rA.x + 30, yy, 12, lc, { w: 600, track: 1.6 });
      c.font = font(F.mono(600), 12); c.letterSpacing = '1.6px';
      const ew = c.measureText(st.en).width; c.letterSpacing = '0px';
      c.font = jp(12, 600, false); c.fillStyle = s === 0 ? O(0.22) : fresh ? rgba('ink', 1) : O(0.6);
      c.fillText(st.jp, rA.x + 30 + ew + 8, yy);
      const v = s === 2 ? st.ok : s === 1 ? (blinkA(t, 4) > 0.5 ? '••••' : '') : '----';
      const vc = s === 2 ? (fresh ? rgba('ink', 1) : rgba(st.col ?? 'green', 1)) : s === 1 ? rgba('amber', 1) : O(0.25);
      c.font = /[^\x00-\x7f]/.test(v) ? jp(13, 700, false) : font(F.mono(700), 12);
      c.fillStyle = vc; c.textAlign = 'right'; c.letterSpacing = '1.5px';
      c.fillText(v, rA.x + rA.w, yy); c.textAlign = 'left'; c.letterSpacing = '0px';
      if (s === 1) { c.fillStyle = rgba('amber', 1); c.fillRect(rA.x + 22, yy - 9, 4, 9); }
    }

    // sync ratio
    const rB = panel(c, rx, 616, rw, 190, { title: 'SYNC RATIO', jp: 'シンクロ率', fill: PF });
    const sA = this.done[7]!, sB = this.done[13]!;
    let sync = -1;
    if (t >= sA) sync = t >= sB ? 41.3 : 41.3 * ease.outCubic(prog(t, sA, sB)) + (hash(fi >> 1, 3) - 0.5) * 3 * (1 - prog(t, sA, sB));
    const sTxt = sync < 0 ? '--.-' : clamp(sync, 0, 99.9).toFixed(1).padStart(4, '0');
    sevenSeg(c, sTxt, rB.x, rB.y + 6, 84, sync >= 41.3 ? rgba('amber', 1) : rgba('orange', 1), O(0.07));
    condensed(c, '%', rB.x + 256, rB.y + 86, 64, { color: O(1) });
    segMeter(c, rB.x, rB.y + 104, rB.w, 14, 40, sync < 0 ? 0 : sync / 100, { hotFrom: 0.9 });
    mono(c, sync >= 41.3 ? 'SYNCHRONIZED  同調完了' : sync >= 0 ? 'SYNCHRONIZING  同調中' : 'AWAITING LINK  待機', rB.x, rB.y + rB.h - 2, 11, sync >= 41.3 ? rgba('green', 1) : O(0.8), { w: 700 });
    mono(c, 'ABS. BORDER 0.0', rB.x + rB.w, rB.y + rB.h - 2, 10, O(0.55), { align: 'right' });

    // harmonics
    const rC = panel(c, rx, 822, rw, 178, { title: 'HARMONICS', jp: 'ハーモニクス', fill: PF });
    au.melFrame(t, this.mel);
    const nb = 48, bw = rC.w / nb;
    for (let i = 0; i < nb; i++) {
      const v = smoothstep(0.45, 1, this.mel[Math.floor((i * 60) / nb)]!);
      const hh = 6 + v * 88;
      c.fillStyle = v > 0.94 ? rgba('red', 1) : v > 0.7 ? rgba('amber', 1) : O(0.85);
      c.fillRect(rC.x + i * bw, rC.y + 96 - hh, bw - 2, hh);
    }
    c.fillStyle = O(0.4); c.fillRect(rC.x, rC.y + 98, rC.w, 1);
    const hOk = t >= this.done[12]!;
    mono(c, hOk ? 'ALL NORMAL' : 'MEASURING', rC.x, rC.y + rC.h - 4, 12, hOk ? rgba('green', 1) : rgba('amber', 1), { w: 700 });
    c.font = jp(13, 700, false); c.fillStyle = hOk ? rgba('green', 1) : rgba('amber', 1); c.fillText(hOk ? '全て正常値' : '計測中', rC.x + 106, rC.y + rC.h - 4);
    mono(c, '30 — 16K HZ', rC.x + rC.w, rC.y + rC.h - 4, 10, O(0.55), { align: 'right' });

    // ================= centre: reticle, ring labels, top readout
    const cyc = Math.cos(roll), syc = Math.sin(roll);
    const fov = u.fov!.value as number;
    // frame labels on the heavy ribs ahead (the 3D rings as HUD objects)
    const k0 = Math.ceil((zc + 1.2) / DZ), k1 = Math.floor((zc + 16) / DZ);
    c.font = font(F.mono(600), 11); c.letterSpacing = '1px';
    for (let k = k0; k <= k1; k++) {
      if (k % 4) continue;
      const zd = k * DZ - zc, r = (fov / zd) * H;
      const a = clamp(Math.exp(-zd * 0.07) * 1.3) * clamp((zd - 1.2) / 1.2);
      // upper-right corner of the octagon in tunnel coords (y up), back to screen
      const tx = r, ty = r * Math.tan(Math.PI / 8);
      const sx = CX + tx * cyc - ty * syc, sy = CY - (tx * syc + ty * cyc);
      c.strokeStyle = O(0.8 * a); c.lineWidth = 1;
      c.beginPath(); c.moveTo(sx + 4, sy - 4); c.lineTo(sx + 26, sy - 26); c.lineTo(sx + 96, sy - 26); c.stroke();
      c.fillStyle = O(0.95 * a);
      c.fillText(`F-${String(k).padStart(3, '0')}`, sx + 30, sy - 31);
      c.fillStyle = O(0.6 * a);
      c.fillText(`${(zd * 4.2).toFixed(1)}m`, sx + 30, sy - 12);
    }
    c.letterSpacing = '0px';
    // reticle
    octPath(c, CX, CY, 46 + 8 * kick); c.strokeStyle = rgba('amber', 0.9); c.lineWidth = 1.5; c.stroke();
    brackets(c, CX - 96, CY - 96, 192, 192, 18, O(0.85), 2);
    c.strokeStyle = O(0.5); c.lineWidth = 1; c.beginPath();
    c.moveTo(CX - 160, CY); c.lineTo(CX - 110, CY); c.moveTo(CX + 110, CY); c.lineTo(CX + 160, CY);
    c.moveTo(CX, CY - 160); c.lineTo(CX, CY - 110); c.moveTo(CX, CY + 110); c.lineTo(CX, CY + 160);
    c.stroke();
    mono(c, `Z ${(zc * 4.2).toFixed(1).padStart(6, '0')}`, CX + 104, CY + 120, 11, O(0.8), { w: 600 });
    mono(c, `θ ${((roll * 180) / Math.PI).toFixed(1)}°`, CX - 104, CY + 120, 11, O(0.8), { w: 600, align: 'right' });
    // top readout: countdown to the link (break) → velocity (race)
    c.save();
    chamferPath(c, CX - 160, 104, 320, 112, [0, 0, 18, 18]);
    c.fillStyle = 'rgba(5,4,3,0.82)'; c.fill(); c.strokeStyle = O(0.55); c.lineWidth = 1; c.stroke();
    c.restore();
    if (!locked) {
      const rem = Math.max(0, T.lock - t);
      mono(c, 'NEURAL LINK IN', CX, 128, 12, O(0.8), { w: 700, align: 'center', track: 4 });
      const txt = `00:${rem.toFixed(2).padStart(5, '0')}`;
      sevenSeg(c, txt, CX - 118, 138, 46, rgba('amber', 1), O(0.07));
      c.font = jp(15, 700, false); c.fillStyle = O(0.8); c.textAlign = 'center'; c.fillText('神経接続まで', CX, 206); c.textAlign = 'left';
    } else {
      mono(c, race ? 'VELOCITY' : 'PLUG LOCKED', CX, 128, 12, race ? O(0.8) : rgba('green', 1), { w: 700, align: 'center', track: 4 });
      const txt = vel.toFixed(1).padStart(5, '0');
      sevenSeg(c, txt, CX - 88, 138, 46, rgba('amber', 1), O(0.07));
      mono(c, 'M/S', CX + 92, 180, 12, O(0.8), { w: 700 });
      c.font = jp(15, 700, false); c.fillStyle = O(0.8); c.textAlign = 'center'; c.fillText(race ? '神経接続 進行中' : 'プラグ固定', CX, 206); c.textAlign = 'left';
    }
    // vertical JP on the tunnel edges
    jpVertical(c, 'エントリープラグ', 470, 250, 20, O(0.55), true);
    jpVertical(c, '神経接続', W - 470, 250, 20, O(0.55), true);
    c.restore();

    // ================= title card, bottom centre
    const bx = 470, by = 822, bwid = W - 940, bh = 178;
    c.save();
    chamferPath(c, bx, by, bwid, bh, [0, 26, 0, 26]);
    c.fillStyle = 'rgba(5,4,3,0.86)'; c.fill(); c.strokeStyle = O(0.6); c.lineWidth = 1.5; c.stroke();
    c.restore();
    mono(c, locked ? 'NEURAL CONNECTION // UNIT-01' : 'INSERTION // UNIT-01', bx + 24, by + 28, 13, O(1), { w: 700, track: 4 });
    condensed(c, 'ENTRY PLUG', bx + 20, by + 160, 150, { sx: 0.58, color: rgba('bone', 1) });
    // right half: the current call-out (the latest stage done, or the one in progress), stepped per kick
    let cur = 0;
    for (let i = 0; i < STAGES.length; i++) if (t >= this.done[i]!) cur = i;
    const nxt = STAGES.findIndex((_, i) => t < this.done[i]! && t >= this.act[i]!);
    const showI = locked ? cur : Math.max(0, nxt);
    const stI = STAGES[showI]!, ago = t - this.done[showI]!;
    const doneNow = t >= this.done[showI]!;
    const cxR = bx + bwid - 24;
    if (doneNow && ago < 0.16) { c.fillStyle = rgba(stI.col ?? 'green', 1); c.fillRect(bx + 560, by + 44, bwid - 584, 122); }
    const inv = doneNow && ago < 0.16;
    c.textAlign = 'right';
    mono(c, `STAGE ${String(showI + 1).padStart(2, '0')}/${STAGES.length}`, cxR, by + 28, 12, O(0.8), { w: 700, align: 'right', track: 3 });
    c.font = jp(stI.jp.length > 7 ? 34 : 40, 700, true); c.fillStyle = inv ? rgba('ink', 1) : O(1); c.textAlign = 'right';
    c.fillText(stI.jp, cxR, by + 100);
    mono(c, stI.en, cxR - 150, by + 134, 13, inv ? rgba('ink', 1) : O(0.85), { w: 700, align: 'right', track: 2.5 });
    const val = doneNow ? stI.ok : blinkA(t, 4) > 0.5 ? 'IN PROGRESS' : '';
    c.font = /[^\x00-\x7f]/.test(val) ? jp(17, 700, false) : font(F.mono(700), 14);
    c.fillStyle = inv ? rgba('ink', 1) : doneNow ? rgba(stI.col ?? 'green', 1) : rgba('amber', 1); c.textAlign = 'right';
    c.fillText(val, cxR, by + 134);
    mono(c, '3RD CHILDREN  //  サードチルドレン', cxR, by + 164, 11, inv ? rgba('ink', 1) : O(0.6), { w: 600, align: 'right' });
    c.textAlign = 'left';
    ticker(c, 40, 1046, W - 80, TICK(unitName(nervText(this.ctx.params))), t, { speed: 110, color: O(0.7) });
    c.fillStyle = O(0.6); c.fillRect(40, 1056, W - 80, 1);

    // ================= the lock card (bar 56 downbeat → first kick)
    if (lockPh) {
      const k = (t - T.lock) / (T.k1 - T.lock);
      c.fillStyle = 'rgba(5,4,3,0.84)'; c.fillRect(0, 330, W, 300);
      c.fillStyle = O(1); c.fillRect(0, 326, W, 4); c.fillRect(0, 630, W, 4);
      const s = k < 0.08 ? 1.06 : 1;
      c.font = jp(150 * s, 800, true); c.fillStyle = rgba('bone', 1); c.textAlign = 'center';
      c.fillText('神経接続　開始', CX, 540);
      mono(c, 'NEURAL CONNECTION // START', CX, 590, 22, O(1), { w: 700, align: 'center', track: 6 });
      mono(c, `PLUG LOCKED  //  LCL 100%  //  ${hexData(9, fi >> 2, 8)}`, CX, 366, 14, O(0.85), { w: 600, align: 'center', track: 4 });
      c.textAlign = 'left';
    }
    // ================= launch (last beat)
    if (fire) {
      const k = (t - T.fire) / (T.e - T.fire);
      c.fillStyle = 'rgba(5,4,3,0.8)'; c.fillRect(0, 360, W, 250);
      c.fillStyle = rgba('red', 1); c.fillRect(0, 356, W, 4); c.fillRect(0, 610, W, 4);
      c.font = jp(170 * (k < 0.1 ? 1.08 : 1), 800, true); c.fillStyle = rgba('bone', 1); c.textAlign = 'center';
      c.fillText('発進', CX, 540);
      mono(c, `${unitName(nervText(this.ctx.params))}  //  LAUNCH`, CX, 590, 20, rgba('red', 1), { w: 700, align: 'center', track: 6 });
      c.textAlign = 'left';
    }

    this.ctx.comp.draw(renderer, L.upload(), out);
    this.scan.u.t!.value = t;
    this.scan.render(renderer, out);

    const hit0 = pulse(t, T.lock, 0.1), hitF = pulse(t, T.fire, 0.08), hitK = pulse(t, T.k1, 0.1);
    const sh = 8 * hit0 + 6 * hitK + 5 * hitF + 2.2 * kick;
    return {
      bloom: 0.72, bloomThreshold: 0.78, bloomRadius: 0.75, halation: 0.12, vignette: 0.55, grain: 0.05,
      ca: 1.0 + 2.5 * clap + 4 * hit0 + 3 * hitK,
      flash: 0.45 * pulse(t, T.lock, 0.04) + 0.3 * pulse(t, T.k1, 0.035) + 0.5 * pulse(t, T.fire, 0.05),
      zoom: 1 + 0.04 * hit0 + 0.03 * hitK + 0.008 * dk,
      shake: [sh * Math.sin(fi * 2.1), sh * Math.cos(fi * 1.7)],
    };
  }
}

/** 0/1 blink at `rate` Hz (song-time based). */
function blinkA(t: number, rate: number) { return (t * rate) % 1 < 0.55 ? 1 : 0.25; }
