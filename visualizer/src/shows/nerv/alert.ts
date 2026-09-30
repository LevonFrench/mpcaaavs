// Ported from bizarro/evangelion app/src/scenes/alert.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// alert — "PATTERN BLUE" (drop 1b, bars 45–54, 85.82 – 102.02 s).
// Full alarm. Hard cut in on a full-screen 緊急事態 / EMERGENCY slam (bar 45, the highest-energy
// downbeat), then the NERV emergency terminal:
//  - behind everything, a GL wall of EMERGENCY / WARNING / DANGER tiles: each column is a mel band
//    (bass at the centre, highs out to the edges), rows read the spectrum with a delay so the mix
//    flows out from the middle; a rotating siren beam sweeps once per bar; every clap sends a ring of
//    inverted (solid red) tiles out from the centre and row-glitches the wall; hats flicker tiles.
//  - centre: the big EMERGENCY warning box (inverts solid red on every clap, hazard bands step on the
//    clap count), the cyan PATTERN BLUE card (the vocal chops = the Angel speaking: cyan glyph bursts
//    and target locks), the intercept countdown (the bar grid) with a siren scope and spectrum strip.
//  - left: a 3×5 grid of alert panels, one sector per clap flips solid red and stays alerted, so
//    the alarm spreads over the plate; an emergency log that types a row per kick/clap/hat.
//  - right: the Angel analysis (a rotating crystal octahedron sized by the bass, BLOOD TYPE: BLUE,
//    解析中 / CODE 601 status), and the approach panel (range closing over the plate, sensor meters).
// Kicks shake the frame and bounce the panels. Last beat: panels fail out, the wall turns blue.
import * as THREE from 'three';
import { Scene, type Frame, type PostOverrides } from '../../show/scene.ts';
import { FSPass, Layer2D, W } from '../../show/gl.ts';
import { LIN, rgba } from '../../show/palette.ts';
import { F, font } from '../../show/type.ts';
import { SPECTRUM_GLSL, spectrumUniforms } from '../../show/spectrum.ts';
import { clamp, ease, frameIdx, hash, pulse, smoothstep, TAU } from '../../show/util.ts';
import { brackets, hexGrid, chamferPath, duck, hazard, hexData, jp, makeScanPass, panel, segMeter, sevenSeg, songBar, ticker } from './_eva.ts';
import { TILE, WordCache, drawOctahedron, fillRecent, headerStrip, jpText, lastIdx, makeTileAtlas, mono, onsetList, statusRow, vec2Array, waveScope, type Onset } from './alert-kit.ts';

const WALL_FRAG = /* glsl */ `
${SPECTRUM_GLSL}
uniform sampler2D atlas;
uniform float t, fi, sweep, kickAmt, bounce, glitch, blueK, slam, fail;
uniform vec2 uClap[4];
uniform vec2 uHat[3];
uniform vec3 cRed, cBlue;

const vec2 TS = vec2(${TILE.w.toFixed(1)}, ${TILE.h.toFixed(1)});
const vec2 PITCH = vec2(${(TILE.w + 6).toFixed(1)}, ${(TILE.h + 6).toFixed(1)});
const float NV = ${TILE.n.toFixed(1)};

void main() {
  vec2 px = vec2(FRAG_PX.x, 1080.0 - FRAG_PX.y);
  // clap row glitch (stable over the frame's shutter)
  float row7 = floor(px.y / 9.0);
  if (hash12(vec2(row7, fi)) < 0.14 * glitch) px.x += (hash12(vec2(row7 * 1.7, fi + 3.1)) - 0.5) * 140.0 * glitch;
  // kick bounce: the whole wall breathes about the centre
  vec2 ctr = vec2(960.0, 540.0);
  vec2 p = ctr + (px - ctr) * (1.0 - 0.014 * bounce);
  // grid, centred: a tile straddles the centre column and row
  vec2 g = (p - ctr) / PITCH + 0.5;
  vec2 id = floor(g);
  vec2 lp = (fract(g) - 0.5) * PITCH + TS * 0.5;          // tile-local px (0..TS inside)
  float inTile = step(0.0, lp.x) * step(lp.x, TS.x) * step(0.0, lp.y) * step(lp.y, TS.y);
  float h = hash12(id + 7.3);
  float v = h < 0.52 ? 0.0 : h < 0.72 ? 1.0 : h < 0.86 ? 2.0 : 3.0;
  vec2 uv = vec2(lp.x / TS.x, (v * TS.y + clamp(lp.y, 0.5, TS.y - 0.5)) / (TS.y * NV));
  vec3 m = texture(atlas, uv).rgb * inTile;               // r frame, g text, b interior

  // spectrum: column = band (bass at the centre), rows read it with a delay (flows outward)
  float ax = abs(id.x), ay = abs(id.y);
  float band = 2.0 + ax / 6.5 * 48.0 + h * 3.0;
  float e = melAt(t - ay * 0.035, band);
  e = pow(smoothstep(0.5, 1.0, e), 1.7);
  float d = length(id * vec2(1.0, 0.45 * PITCH.y / PITCH.x * 2.2));

  // siren: two opposite beams, one turn per bar
  vec2 tc = id * PITCH;
  float ang = atan(tc.y, tc.x);
  float beam = pow(max(0.0, cos(ang - sweep)), 18.0) + 0.6 * pow(max(0.0, cos(ang - sweep - 3.14159)), 18.0);
  beam *= smoothstep(0.5, 2.5, d);

  // claps: a ring of tiles inverts, travelling out from the centre; a scatter of tiles on the hit
  float inv = 0.0;
  for (int i = 0; i < 4; i++) {
    float age = t - uClap[i].x;
    if (age < 0.0 || age > 1.2) continue;
    float front = d - age * 26.0;
    inv = max(inv, uClap[i].y * exp(-front * front / 2.2) * exp(-age * 1.6));
    if (age < 0.16 && hash12(id + uClap[i].x * 3.1) < 0.2) inv = max(inv, uClap[i].y);
  }
  float spark = 0.0;
  for (int i = 0; i < 3; i++) {
    float age = t - uHat[i].x;
    if (age < 0.0 || age > 0.4) continue;
    if (hash12(id + uHat[i].x * 11.3) < 0.08) spark += uHat[i].y * exp(-age / 0.08);
  }
  inv = max(inv, slam);
  float solid = step(0.5, inv);

  float I = 0.025 + 0.42 * e + 0.75 * beam + 0.18 * kickAmt + 0.8 * spark;
  I *= 1.0 - 0.6 * smoothstep(3.0, 9.0, d) * (1.0 - beam);
  vec3 base = mix(cRed, cBlue, blueK);
  vec3 col = base * (m.r * I * 0.9 + m.g * I * 1.1 + m.b * I * 0.015);
  col += vec3(1.0, 0.55, 0.1) * m.g * spark * 0.6;
  // inverted tile: solid red, text knocked out black
  vec3 solidC = base * (0.75 + 0.3 * e) * (m.b * (1.0 - m.g) + m.r * 0.4);
  col = mix(col, solidC, solid);
  // faint red wash where the beam is, and a glow at the centre on the kick
  col += base * 0.025 * beam + base * 0.02 * kickAmt * exp(-d / 5.0);
  col *= 1.0 - fail;
  fragColor = vec4(col, 1.0);
}`;

const SECTORS: [string, string][] = [
  ['SECTOR-01', '第1区画'], ['SECTOR-02', '第2区画'], ['SECTOR-03', '第3区画'],
  ['GEOFRONT', 'ジオフロント'], ['TOKYO-3', '第3新東京市'], ['CENTRAL DOGMA', 'セントラルドグマ'],
  ['EVA-00', '零号機'], ['EVA-01', '初号機'], ['CAGE', 'ケイジ'],
  ['MAGI', 'マギ'], ['UMBILICAL', '電源'], ['N2 MINE', 'N2地雷'],
  ['UN FORCES', '国連軍'], ['JSSDF', '戦自'], ['SHELTER', 'シェルター'],
];
const TICK_A = 'EMERGENCY // 緊急事態 // PATTERN BLUE CONFIRMED // BLOOD TYPE: BLUE // 使徒 接近中 // ALL PERSONNEL TO LEVEL-1 BATTLE STATIONS // 第一種戦闘配置 // CIVILIANS EVACUATE TO SHELTERS // ';
const TICK_B = 'CODE 601 // 解析不能 // A.T. FIELD DETECTED // MAGI ANALYSIS IN PROGRESS // 目標 移動中 // TOKYO-3 DEFENCE SYSTEMS ARMED // 迎撃システム 起動 // ';

type LogRow = { t: number; kind: 'kick' | 'clap' | 'hat' | 'pre' | 'voc'; text: string; s: number };

export default class Alert extends Scene {
  wall!: FSPass;
  L = new Layer2D();
  scan = makeScanPass(0.24);
  words = new WordCache();
  kicks: Onset[] = []; claps: Onset[] = []; hats: Onset[] = []; vox: Onset[] = [];
  uc = vec2Array(4); uh = vec2Array(3);
  order: number[] = [];
  log: LogRow[] = [];
  mel = new Float32Array(64);
  T = { s: 0, e: 0, last: 0 };

  override init() {
    const au = this.ctx.audio, s = this.ctx.start, e = this.ctx.end;
    this.T = { s, e, last: e - 0.45 };
    this.kicks = onsetList(au, 'kick', s - 0.05, e, 0.4);
    this.claps = onsetList(au, 'snare', s - 0.03, e, 0.55);
    this.hats = onsetList(au, 'hat', s - 0.05, e + 0.5);
    this.vox = onsetList(au, 'vocal', s - 0.05, e);
    // the order in which the claps alert the sectors (seeded shuffle)
    this.order = SECTORS.map((_, i) => i).sort((a, b) => hash(a, 45) - hash(b, 45));
    const rows: LogRow[] = [];
    this.kicks.forEach(([kt, ks], i) => rows.push({ t: kt, kind: 'kick', s: ks, text: `${kt.toFixed(2).padStart(6, '0')} PULSE  ${hexData(i, 5, 4)}  AMP ${ks.toFixed(2)}` }));
    this.claps.forEach(([ct, cs], i) => {
      const sec = SECTORS[this.order[i % SECTORS.length]!]![0];
      rows.push({ t: ct, kind: 'clap', s: cs, text: `${ct.toFixed(2).padStart(6, '0')} ALERT  ${sec}` });
    });
    this.hats.forEach(([ht, hs], i) => rows.push({ t: ht, kind: 'hat', s: hs, text: `${ht.toFixed(2).padStart(6, '0')} SCAN   ${hexData(i, 17, 6)}` }));
    this.vox.forEach(([vt, vs]) => rows.push({ t: vt, kind: 'voc', s: vs, text: `${vt.toFixed(2).padStart(6, '0')} SIGNAL 使徒 BLUE` }));
    for (let i = 0; i < 20; i++) rows.push({ t: s - 0.2 - i * 0.3, kind: 'pre', s: 0.3 + 0.4 * hash(i, 3), text: `${(s - 0.2 - i * 0.3).toFixed(2).padStart(6, '0')} FIELD  ${hexData(i, 91, 6)}` });
    this.log = rows.sort((a, b) => a.t - b.t);

    this.wall = new FSPass(WALL_FRAG, {
      atlas: { value: makeTileAtlas() },
      t: { value: 0 }, fi: { value: 0 }, sweep: { value: 0 }, kickAmt: { value: 0 }, bounce: { value: 0 }, glitch: { value: 0 }, blueK: { value: 0 }, slam: { value: 0 }, fail: { value: 0 },
      uClap: { value: this.uc }, uHat: { value: this.uh },
      cRed: { value: new THREE.Vector3(...LIN.red) }, cBlue: { value: new THREE.Vector3(...LIN.cyan) },
      ...spectrumUniforms(this.ctx.spectrum),
    });
  }

  render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides {
    const { renderer, audio: au, comp } = this.ctx;
    const T = this.T, t = f.t, lt = t - T.s;
    const fi = frameIdx(t);
    const dk = duck(f, au);
    const kick = au.hit('kick', t, 0.09);
    const clap = au.hit('snare', t, 0.1);
    const bass = clamp(au.env('bass', t));
    const bar = songBar(au, t), barI = Math.floor(bar + 1e-4), bp = bar - barI;
    const ci = lastIdx(this.claps, t), clapN = ci + 1;
    const lastClapT = ci >= 0 ? this.claps[ci]![0] : -1e3;
    const clapInv = t - lastClapT < 0.15;                 // "every clap inverts a panel red"
    const hi = lastIdx(this.hats, t), hatN = hi + 1;
    const vi = lastIdx(this.vox, t);
    const vox = vi >= 0 ? pulse(t, this.vox[vi]![0], 0.18) : 0;
    const voxOn = vi >= 0 && t - this.vox[vi]![0] < 0.55;
    const slam = lt < 0.61;
    const endK = t >= T.last ? clamp((t - T.last) / 0.45) : 0;
    au.melFrame(t, this.mel);

    // ---- the wall
    fillRecent(this.uc, this.claps, t);
    fillRecent(this.uh, this.hats, t);
    const u = this.wall.u;
    u.t!.value = t; u.fi!.value = fi;
    u.sweep!.value = (bar % 1) * TAU - Math.PI / 2;
    u.kickAmt!.value = kick; u.bounce!.value = dk;
    u.glitch!.value = clamp(clap * 1.1);
    u.slam!.value = slam ? (lt < 0.3 ? 1 : 0) : 0;
    u.blueK!.value = endK > 0 ? ((fi >> 2) & 1 ? 1 : 0.35) : 0;
    u.fail!.value = 0;
    this.wall.render(renderer, out);

    const L = this.L; L.clear();
    const c = L.ctx;

    if (slam) {
      this.slamCard(c, lt);
    } else {
      // panels fail one by one over the last beat
      const failAt = (g: number) => endK > 0 && endK > 0.12 + g * 0.14;
      const nx = -dk * 3, ny = dk * 4;
      c.save(); c.translate(nx, ny);
      // ---------------------------------------------------------------- top chrome
      const hzPh = t * 50 + clapN * 22;
      c.fillStyle = 'rgba(12,0,0,0.9)'; c.fillRect(0, 0, W, 24);
      hazard(c, 0, 0, W, 24, hzPh, rgba('red', clapInv ? 1 : 0.85), 'rgba(0,0,0,0)', 22);
      c.fillStyle = 'rgba(8,0,0,0.99)'; c.fillRect(0, 24, W, 52);
      headerStrip(c, 40, 34, W - 80, {
        tag: 'EMERGENCY', tagJp: '緊急事態', color: rgba('red', 1), tab: clapInv ? rgba('bone', 1) : rgba('red', 1),
        sub: 'PATTERN BLUE  //  ANGEL CONFIRMED  //  NERV HQ', right: `BAR ${String(barI).padStart(2, '0')}/54  T+${lt.toFixed(2).padStart(5, '0')}`, rightJp: '第一種戦闘配置',
      });

      // ---------------------------------------------------------------- left column
      if (!failAt(4)) this.alertGrid(c, t, clapN, lastClapT);
      if (!failAt(2)) this.logPanel(c, t);
      // ---------------------------------------------------------------- centre
      if (!failAt(5)) this.emergencyBox(c, t, clapInv, clap, hzPh, clapN);
      this.patternBlue(c, t, vox, voxOn, endK);
      if (!failAt(1)) {
        c.fillStyle = 'rgba(8,0,0,0.99)'; c.fillRect(580, 404, 760, 18);
        c.fillStyle = rgba('red', 1); c.fillRect(580, 404, 64, 18);
        mono(c, '警報', 612, 418, 12, rgba('ink', 1), { w: 700, align: 'center' });
        ticker(c, 652, 418, 680, TICK_B, t, { speed: 90, color: rgba('amber', 0.9), size: 11 });
      }
      if (!failAt(1)) this.intercept(c, t, barI, bp, dk);
      // ---------------------------------------------------------------- right column
      if (!failAt(3)) this.analysis(c, t, bass, kick, hatN, vox, voxOn, clapInv);
      if (!failAt(0)) this.approach(c, t, bass);
      // ---------------------------------------------------------------- bottom chrome
      c.fillStyle = 'rgba(12,0,0,0.92)'; c.fillRect(0, 1016, W, 64);
      c.fillStyle = rgba('red', 1);
      chamferPath(c, 40, 1020, 250, 26, [0, 0, 10, 0]); c.fill();
      mono(c, 'NERV HQ  中央作戦室', 50, 1038, 12, rgba('ink', 1), { w: 700, track: 2 });
      ticker(c, 306, 1039, W - 346, TICK_A, t, { speed: 140, color: rgba('red', 0.95), size: 13 });
      c.fillStyle = rgba('red', 0.6); c.fillRect(306, 1048, W - 346, 1);
      hazard(c, 0, 1056, W, 24, -hzPh, rgba('red', clapInv ? 1 : 0.85), 'rgba(0,0,0,0)', 22);
      c.restore();
    }

    comp.draw(renderer, L.upload(), out);
    this.scan.u.t!.value = t;
    this.scan.render(renderer, out);

    const hit0 = pulse(t, T.s, 0.1);
    const sh = 9 * hit0 + 3.2 * kick + 1.5 * clap;
    return {
      bloom: 0.5, bloomThreshold: 0.72, bloomRadius: 0.5, halation: 0, vignette: 0.5, grain: 0.05,
      ca: 0.6 + 2.4 * clap + 5 * hit0 + 1.2 * vox,
      flash: 0.5 * pulse(t, T.s, 0.04),
      zoom: 1 + 0.06 * hit0 + 0.007 * dk,
      shake: [sh * Math.sin(fi * 2.3), sh * Math.cos(fi * 1.9)],
    };
  }

  // ================================================================ the opening slam
  slamCard(c: CanvasRenderingContext2D, lt: number) {
    const second = lt >= 0.3;
    c.fillStyle = 'rgba(5,0,0,0.99)'; c.fillRect(0, 250, W, 580);
    c.fillStyle = rgba('red', 1); c.fillRect(0, 244, W, 6); c.fillRect(0, 830, W, 6);
    hazard(c, 0, 196, W, 40, lt * 300, rgba('red', 1), 'rgba(0,0,0,0)', 34);
    hazard(c, 0, 844, W, 40, -lt * 300, rgba('red', 1), 'rgba(0,0,0,0)', 34);
    if (!second) {
      const s = lt < 0.05 ? 1.07 : 1;
      this.words.draw(c, 'EMERGENCY', W / 2, 740, 470, { sx: 0.5, color: rgba('bone', 1), align: 'center', scale: s });
      mono(c, 'NERV HQ // ALL PERSONNEL // LEVEL-1 BATTLE STATIONS', W / 2, 300, 22, rgba('red', 1), { w: 700, align: 'center', track: 6 });
    } else {
      this.words.draw(c, '緊急事態', W / 2, 680, 330, { sx: 1, color: rgba('red', 1), align: 'center', family: jp(330, 800, true) });
      mono(c, 'EMERGENCY  //  PATTERN BLUE  //  使徒接近', W / 2, 790, 26, rgba('bone', 1), { w: 700, align: 'center', track: 8 });
    }
  }

  // ================================================================ left: alert grid
  alertGrid(c: CanvasRenderingContext2D, t: number, clapN: number, lastClapT: number) {
    const au = this.ctx.audio;
    const x0 = 40, y0 = 84, w = 500, h = 560;
    const r = panel(c, x0, y0, w, h, { title: 'ALERT STATUS', jp: '警報状況', color: rgba('red', 1), fill: 'rgba(9,2,1,0.994)' });
    const cols = 3, rows = 5, g = 8;
    const tw = (r.w - g * (cols - 1)) / cols, th = 82;
    // alert state per sector: index of the clap that alerted it (-1 = normal)
    const hitBy = new Array(SECTORS.length).fill(-1);
    for (let k = 0; k < clapN; k++) hitBy[this.order[k % SECTORS.length]!] = k;
    let nAlert = 0;
    for (let i = 0; i < SECTORS.length; i++) {
      const cx = r.x + (i % cols) * (tw + g), cy = r.y + 4 + Math.floor(i / cols) * (th + g);
      const hk = hitBy[i];
      const ht = hk >= 0 ? this.claps[hk]![0] : -1e3;
      const fresh = t - ht < 0.32;
      const alerted = hk >= 0;
      if (alerted) nAlert++;
      const band = 3 + i * 3.6;
      const e = smoothstep(0.4, 1, au.mel(t, band));
      chamferPath(c, cx, cy, tw, th, [0, 10, 0, 0]);
      if (fresh) { c.fillStyle = rgba('red', 1); c.fill(); }
      else { c.fillStyle = alerted ? 'rgba(60,0,0,0.75)' : 'rgba(0,0,0,0.5)'; c.fill(); }
      c.strokeStyle = alerted ? rgba('red', 1) : rgba('orange', 0.55); c.lineWidth = alerted ? 2 : 1; c.stroke();
      const ink = fresh ? rgba('ink', 1) : alerted ? rgba('red', 1) : rgba('orange', 0.9);
      mono(c, SECTORS[i]![0], cx + 8, cy + 18, 11.5, ink, { w: 700, track: 1.4 });
      jpText(c, SECTORS[i]![1], cx + 8, cy + 36, 12, fresh ? ink : alerted ? rgba('red', 0.8) : rgba('orange', 0.6));
      // status word
      const blinkOn = ((t * 4) % 1) < 0.62;
      const word = fresh ? 'BREACH' : alerted ? 'ALERT' : 'NORMAL';
      if (alerted && !fresh && blinkOn) { c.fillStyle = rgba('red', 1); c.fillRect(cx + tw - 58, cy + 26, 52, 15); }
      mono(c, word, cx + tw - 7, cy + 38, 10.5, fresh ? ink : alerted ? (blinkOn ? rgba('ink', 1) : rgba('red', 1)) : rgba('green', 0.9), { w: 700, track: 1, align: 'right' });
      // mini meter: the sector's band
      segMeter(c, cx + 8, cy + th - 22, tw - 16, 10, 14, e, { color: fresh ? rgba('ink', 1) : alerted ? rgba('red', 1) : rgba('orange', 1), dim: fresh ? 'rgba(0,0,0,0.25)' : rgba(alerted ? 'red' : 'orange', 0.1), hotFrom: fresh ? 2 : 0.8 });
    }
    // footer: alert count and level
    const fy = r.y + 4 + rows * (th + g) + 14;
    mono(c, `SECTORS ALERTED  ${String(nAlert).padStart(2, '0')}/${SECTORS.length}`, r.x, fy, 12, rgba('red', 1), { w: 700, track: 2 });
    segMeter(c, r.x + 250, fy - 11, r.w - 250, 12, SECTORS.length, nAlert / SECTORS.length, { color: rgba('red', 1), dim: rgba('red', 0.12), hotFrom: 2 });
    void lastClapT;
  }

  // ================================================================ left: emergency log
  logPanel(c: CanvasRenderingContext2D, t: number) {
    const r = panel(c, 40, 660, 500, 342, { title: 'EMERGENCY LOG', jp: '緊急記録', color: rgba('red', 1), fill: 'rgba(9,2,1,0.994)' });
    let lo = -1;
    { let a = 0, b = this.log.length; while (a < b) { const m = (a + b) >> 1; if (this.log[m]!.t <= t) a = m + 1; else b = m; } lo = a - 1; }
    const N = 14, lead = 20;
    const vis = this.log.slice(Math.max(0, lo - N + 1), lo + 1);
    c.font = font(F.mono(500), 12.5);
    vis.forEach((row, i) => {
      const y = r.y + 12 + i * lead;
      const newest = i === vis.length - 1, age = t - row.t;
      let txt = row.text;
      if (newest) txt = txt.slice(0, Math.max(1, Math.floor(clamp(age / 0.07) * txt.length)));
      if (row.kind === 'clap') {
        if (age < 0.14) { c.fillStyle = rgba('red', 1); c.fillRect(r.x - 2, y - 13, r.w + 4, 17); c.fillStyle = rgba('ink', 1); }
        else c.fillStyle = rgba('red', 1);
      } else if (row.kind === 'voc') c.fillStyle = rgba('cyan', 1);
      else if (row.kind === 'kick') c.fillStyle = rgba('orange', 0.45 + 0.5 * (i / N));
      else c.fillStyle = rgba('amber', 0.4 + 0.4 * (i / N));
      c.fillText(txt, r.x + 2, y);
      // level bar per row (the onset strength) + channel tag
      const bx = r.x + 312, bwid = 104;
      const colr = row.kind === 'clap' ? rgba('red', 1) : row.kind === 'voc' ? rgba('cyan', 1) : row.kind === 'hat' ? rgba('amber', 0.8) : rgba('orange', 0.85);
      segMeter(c, bx, y - 10, bwid, 9, 13, clamp(row.s) * (newest ? clamp(age / 0.07) : 1), { color: colr, dim: rgba('orange', 0.07), hotFrom: 2 });
      mono(c, row.kind === 'clap' ? 'CLP' : row.kind === 'kick' ? 'KCK' : row.kind === 'hat' ? 'HAT' : row.kind === 'voc' ? 'VOX' : 'SYS', bx + bwid + 8, y, 10.5, colr, { w: 700, track: 1 });
      c.font = font(F.mono(500), 12.5);
    });
    if (((t * 3) % 1) < 0.6) { c.fillStyle = rgba('red', 0.9); c.fillRect(r.x + 2, r.y + 12 + Math.min(vis.length, N) * lead - 12, 9, 14); }
    
  }

  // ================================================================ centre: the EMERGENCY box
  emergencyBox(c: CanvasRenderingContext2D, t: number, inv: boolean, clap: number, phase: number, clapN: number) {
    const x = 580, y = 84, w = 760, h = 318;
    const col = rgba('red', 1);
    c.save();
    chamferPath(c, x, y, w, h, 22);
    c.fillStyle = inv ? col : "rgba(30,0,0,0.994)"; c.fill();
    c.strokeStyle = col; c.lineWidth = 3; c.stroke();
    chamferPath(c, x + 7, y + 7, w - 14, h - 14, 17);
    c.strokeStyle = inv ? rgba('ink', 1) : rgba('red', 0.5); c.lineWidth = 1; c.stroke();
    const ink = inv ? rgba('ink', 1) : col;
    const band = 36;
    hazard(c, x + 20, y + 18, w - 40, band, phase, ink, 'rgba(0,0,0,0)', 24);
    hazard(c, x + 20, y + h - 18 - band, w - 40, band, -phase, ink, 'rgba(0,0,0,0)', 24);
    // the word
    const s = pulse(t, this.claps[Math.max(0, clapN - 1)]?.[0] ?? -9, 0.05) > 0.5 ? 1.03 : 1;
    this.words.draw(c, 'EMERGENCY', x + w / 2, y + 204, 164, { sx: 0.54, color: inv ? rgba('ink', 1) : rgba('bone', 1), align: 'center', bold: 0.03, scale: s });
    c.font = jp(34, 800, true); c.fillStyle = ink; c.textAlign = 'center';
    c.fillText('緊急事態発生', x + w / 2, y + 252);
    c.textAlign = 'left';
    // side stamps
    mono(c, 'LEVEL', x + 32, y + 90, 12, ink, { w: 700, track: 3 });
    sevenSeg(c, '1', x + 34, y + 100, 64, ink, inv ? null : rgba('red', 0.1), { thick: 7 });
    jpText(c, '第一種', x + 32, y + 190, 15, ink);
    jpText(c, '警戒態勢', x + 32, y + 210, 15, ink);
    mono(c, 'ALARM', x + w - 32, y + 90, 12, ink, { w: 700, track: 3, align: 'right' });
    sevenSeg(c, String(clapN).padStart(2, '0'), x + w - 104, y + 100, 64, ink, inv ? null : rgba('red', 0.1), { thick: 7 });
    jpText(c, '警報発令', x + w - 32, y + 190, 15, ink, { align: 'right' });
    mono(c, hexData(clapN, 3, 6), x + w - 32, y + 210, 11, ink, { w: 600, align: 'right' });
    c.restore();
  }

  // ================================================================ centre: PATTERN BLUE
  patternBlue(c: CanvasRenderingContext2D, t: number, vox: number, voxOn: boolean, endK: number) {
    const x = 580, y = 424, w = 760, h = 244;
    const cyan = rgba('cyan', 1);
    c.save();
    chamferPath(c, x, y, w, h, [18, 0, 18, 0]);
    c.fillStyle = voxOn && vox > 0.4 ? rgba('cyan', 1) : 'rgba(0,6,11,0.99)'; c.fill();
    c.strokeStyle = cyan; c.lineWidth = 2; c.stroke();
    const solid = voxOn && vox > 0.4;
    const ink = solid ? rgba('ink', 1) : cyan;
    // header line
    c.fillStyle = cyan; c.fillRect(x + 18, y + 14, 214, 22);
    mono(c, 'WAVE PATTERN', x + 28, y + 30, 13, rgba('ink', 1), { w: 700, track: 3 });
    mono(c, 'ANALYSIS: CONFIRMED  //  MAGI 3/3', x + 246, y + 30, 12, ink, { w: 600, track: 2.2 });
    mono(c, hexData(Math.floor(t * 8), 44, 8), x + w - 20, y + 30, 11, ink, { w: 500, align: 'right' });
    // the words
    const big = endK > 0 ? rgba('bone', 1) : solid ? rgba('ink', 1) : cyan;
    this.words.draw(c, 'PATTERN BLUE', x + w / 2, y + 170, 150, { sx: 0.56, color: big, align: 'center', bold: 0.028 });
    c.font = jp(26, 800, false); c.fillStyle = ink; c.textAlign = 'center';
    c.fillText('パターン青　使徒と確認', x + w / 2, y + 214);
    c.textAlign = 'left';
    brackets(c, x + 10, y + 46, w - 20, h - 58, 16, ink, 2);
    // the Angel speaks: glyph burst around the card
    if (voxOn) {
      const k = Math.floor(t * 20);
      const G = ['使', '徒', '青', '目', '標', 'パ', 'タ', 'ン', '解', '析', '∴', '◇'];
      c.font = jp(22, 800, true); c.fillStyle = cyan;
      for (let i = 0; i < 26; i++) {
        if (hash(i, k, 3) > 0.55 + 0.45 * (1 - vox)) continue;
        const a = hash(i, 7) * TAU, rr = 1 + hash(i, k) * 0.35;
        const gx = x + w / 2 + Math.cos(a) * (w / 2 + 30) * rr, gy = y + h / 2 + Math.sin(a) * (h / 2 + 24) * rr;
        c.globalAlpha = 0.5 + 0.5 * vox;
        c.fillText(G[Math.floor(hash(i, k, 9) * G.length)]!, gx, gy);
      }
      c.globalAlpha = 1;
    }
    c.restore();
  }

  // ================================================================ centre bottom: intercept countdown
  intercept(c: CanvasRenderingContext2D, t: number, barI: number, bp: number, dk: number) {
    const au = this.ctx.audio;
    const r = panel(c, 580, 690, 760, 312, { title: 'INTERCEPT', jp: '迎撃準備', color: rgba('red', 1), fill: 'rgba(9,2,1,0.994)' });
    const rem = Math.max(0, this.T.e - t);
    const ss = Math.floor(rem), cs = Math.floor((rem - ss) * 100);
    mono(c, 'TIME TO CONTACT', r.x, r.y + 14, 12, rgba('red', 0.9), { w: 700, track: 2.4 });
    jpText(c, '接触まで', r.x + 196, r.y + 15, 14, rgba('red', 0.9));
    sevenSeg(c, `00:${String(ss).padStart(2, '0')}:${String(cs).padStart(2, '0')}`, r.x, r.y + 28, 70, rgba('red', 1), rgba('red', 0.09), { thick: 8.5 });
    // bar pips: bars 45..53
    const px = r.x, py = r.y + 118;
    for (let b = 45; b <= 53; b++) {
      const i = b - 45, on = b < barI ? 1 : b === barI ? 0.5 + 0.5 * (1 - bp) : 0;
      c.fillStyle = on > 0 ? rgba('red', b === barI ? 1 : 0.8) : rgba('red', 0.12);
      c.fillRect(px + i * 42, py, 36, 12);
      mono(c, String(b), px + i * 42 + 18, py + 28, 10, rgba('red', on > 0 ? 0.9 : 0.4), { w: 600, align: 'center', track: 1 });
    }
    // siren scope (the real waveform)
    const sx = r.x + 404, sw = r.w - 404;
    c.strokeStyle = rgba('red', 0.5); c.lineWidth = 1; c.strokeRect(sx, r.y + 4, sw, 130);
    waveScope(c, au, t, sx + 2, r.y + 6, sw - 4, 126, { win: 0.05, col: rgba('amber', 1), grid: rgba('red', 0.16), gain: 1.1 });
    mono(c, 'SIREN INPUT', sx + 6, r.y + 22, 10.5, rgba('red', 0.9), { w: 700, track: 2 });
    mono(c, `${(20 * Math.log10(Math.max(1e-3, au.env('rms', t)))).toFixed(1)} DB`, sx + sw - 6, r.y + 22, 10.5, rgba('red', 0.9), { w: 600, align: 'right' });
    // spectrum strip
    const gy = r.y + 170, gh = r.h - 176, n = 64, bw = r.w / n, segs = 9;
    const pLit = new Path2D(), pHot = new Path2D(), pDim = new Path2D();
    for (let b = 0; b < n; b++) {
      const e = smoothstep(0.35, 1, this.mel[b]!) * (0.92 + 0.12 * dk);
      const lit = e * segs;
      for (let s = 0; s < segs; s++) {
        const p = s < lit ? (s >= segs - 2 ? pHot : pLit) : pDim;
        p.rect(r.x + b * bw + 1, gy + gh - (s + 1) * (gh / segs) + 1, bw - 2, gh / segs - 2);
      }
    }
    c.fillStyle = rgba('red', 0.07); c.fill(pDim);
    c.fillStyle = rgba('red', 0.95); c.fill(pLit);
    c.fillStyle = rgba('amber', 1); c.fill(pHot);
  }

  // ================================================================ right: Angel analysis
  analysis(c: CanvasRenderingContext2D, t: number, bass: number, kick: number, hatN: number, vox: number, voxOn: boolean, clapInv: boolean) {
    const cyan = rgba('cyan', 1);
    const r = panel(c, 1380, 84, 500, 560, { title: 'TARGET ANALYSIS', jp: '目標解析', color: cyan, fill: 'rgba(0,5,9,0.994)' });
    // viewport
    const vx = r.x, vy = r.y, vw = r.w, vh = 290, cx = vx + vw / 2, cy = vy + vh / 2 + 4;
    c.save();
    c.beginPath(); c.rect(vx, vy, vw, vh); c.clip();
    // hex lattice: cells near the Angel light up with the high bands
    c.lineWidth = 1;
    const hot = new Path2D(), dim = new Path2D();
    hexGrid(vx - 10, vy - 10, vw + 20, vh + 20, 19, (hx, hy, col, row) => {
      const dd = Math.hypot(hx - cx, hy - cy);
      const e = smoothstep(0.5, 1, this.ctx.audio.mel(t - dd * 0.0008, 30 + ((col * 7 + row * 3) % 26)));
      const p = dd < 150 && e > 0.55 && hash(col, row, hatN) > 0.45 ? hot : dim;
      for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + (i * TAU) / 6, qx = hx + 17 * Math.cos(a), qy = hy + 17 * Math.sin(a); if (i) p.lineTo(qx, qy); else p.moveTo(qx, qy); }
      p.closePath();
    });
    c.strokeStyle = rgba('cyan', 0.14); c.stroke(dim);
    c.fillStyle = rgba('cyan', 0.16); c.fill(hot); c.strokeStyle = rgba('cyan', 0.5); c.stroke(hot);
    // range rings + crosshair
    c.strokeStyle = rgba('cyan', 0.4);
    for (let k = 1; k <= 3; k++) { c.beginPath(); c.arc(cx, cy, 44 * k + 10 * kick, 0, TAU); c.stroke(); }
    c.beginPath(); c.moveTo(vx, cy); c.lineTo(vx + vw, cy); c.moveTo(cx, vy); c.lineTo(cx, vy + vh); c.stroke();
    // the Angel: a rotating crystal, sized by the bass, spinning a step on every hat
    const yaw = t * 0.9 + hatN * 0.35, pitch = 0.32 + 0.08 * Math.sin(t * 0.7);
    const R = 62 + 34 * bass + 10 * kick;
    drawOctahedron(c, cx, cy, R * 1.5, yaw * 0.6, pitch, { col: rgba('cyan', 0.25), lw: 1, edgeA: 0.6 });
    drawOctahedron(c, cx, cy, R, yaw, pitch, { col: rgba('cyan', 1), lw: 1.8, face: (k) => rgba('cyan', 0.1 + 0.4 * k + 0.3 * vox) });
    c.restore();
    // target lock brackets: snap tight on the vocal chops
    const lockS = voxOn ? 1 - 0.35 * vox : 1;
    const bw = (R * 2.4 + 40) * lockS, bh = (R * 3.4 + 30) * lockS;
    brackets(c, cx - bw / 2, cy - bh / 2, bw, bh, 16, voxOn ? rgba('bone', 1) : cyan, 2);
    mono(c, voxOn ? 'TARGET LOCK' : 'TRACKING', cx + bw / 2 + 8, cy - bh / 2 + 10, 11, cyan, { w: 700, track: 2 });
    mono(c, `X ${(cx + Math.sin(t) * 40).toFixed(1)}  Y ${(cy + Math.cos(t * 0.8) * 30).toFixed(1)}`, vx + 8, vy + vh - 10, 10.5, rgba('cyan', 0.8), { w: 600 });
    mono(c, `ROT ${((yaw * 57.3) % 360).toFixed(1).padStart(5, '0')}°`, vx + vw - 8, vy + vh - 10, 10.5, rgba('cyan', 0.8), { w: 600, align: 'right' });
    c.fillStyle = rgba('cyan', 0.5); c.fillRect(vx, vy + vh + 4, vw, 1);
    // BLOOD TYPE: BLUE
    const by = vy + vh + 14;
    chamferPath(c, vx, by, vw, 64, [0, 14, 0, 14]);
    c.fillStyle = clapInv ? rgba('red', 1) : cyan; c.fill();
    mono(c, 'BLOOD TYPE', vx + 16, by + 26, 15, rgba('ink', 1), { w: 700, track: 3 });
    jpText(c, '血液型', vx + 16, by + 50, 16, rgba('ink', 1));
    this.words.draw(c, 'BLUE', vx + vw - 18, by + 56, 66, { sx: 0.62, color: rgba('ink', 1), align: 'right', bold: 0.03 });
    // status rows
    const sy = by + 92, analysing = ((t * 2.5) % 1) < 0.7;
    const code601 = Math.floor(songBar(this.ctx.audio, t)) % 2 === 1;
    const jc = rgba('cyan', 0.55);
    statusRow(c, vx, sy, vw, 'PATTERN', 'パターン', 'BLUE', cyan, { col: cyan, jcol: jc, box: true });
    statusRow(c, vx, sy + 26, vw, 'A.T. FIELD', 'ATフィールド', 'DETECTED', rgba('red', 1), { col: cyan, jcol: jc });
    statusRow(c, vx, sy + 52, vw, 'ANALYSIS', '解析', code601 ? 'CODE 601  解析不能' : analysing ? '解析中' : '', code601 ? rgba('red', 1) : cyan, { col: cyan, jcol: jc, box: code601 && analysing });
    statusRow(c, vx, sy + 78, vw, 'ENERGY', 'エネルギー', `${(412 + 380 * bass + 90 * kick).toFixed(1)} TW`, cyan, { col: cyan, jcol: jc });
  }

  // ================================================================ right: approach
  approach(c: CanvasRenderingContext2D, t: number, bass: number) {
    const au = this.ctx.audio;
    const cyan = rgba('cyan', 1);
    const r = panel(c, 1380, 660, 500, 342, { title: 'APPROACH', jp: '使徒接近', color: rgba('red', 1), fill: 'rgba(9,2,1,0.994)' });
    const p = clamp((t - this.T.s) / (this.T.e - this.T.s));
    const dist = 12.4 - 11.6 * ease.inQuad(p);
    mono(c, 'DISTANCE TO TOKYO-3', r.x, r.y + 14, 12, rgba('red', 0.9), { w: 700, track: 2.2 });
    jpText(c, '距離', r.x + 262, r.y + 15, 14, rgba('red', 0.9));
    sevenSeg(c, dist.toFixed(2).padStart(5, '0'), r.x, r.y + 28, 58, cyan, rgba('cyan', 0.08), { thick: 7 });
    mono(c, 'KM', r.x + 236, r.y + 84, 16, cyan, { w: 700 });
    // range scale: tokyo-3 at the left, the Angel closing in from the right
    const sx = r.x, sy = r.y + 130, sw = r.w;
    c.fillStyle = rgba('red', 0.8); c.fillRect(sx, sy, sw, 2);
    for (let i = 0; i <= 26; i++) c.fillRect(sx + (sw * i) / 26, sy - (i % 5 ? 4 : 9), 1, i % 5 ? 4 : 9);
    for (let i = 0; i <= 25; i += 5) mono(c, String(i / 2).padStart(2, ' '), sx + (sw * i) / 26, sy + 18, 10, rgba('red', 0.7), { align: 'center', w: 500 });
    c.fillStyle = rgba('orange', 1); c.fillRect(sx, sy - 16, 6, 16);
    const mx = sx + (sw * dist) / 13;
    c.fillStyle = cyan; c.beginPath(); c.moveTo(mx, sy - 4); c.lineTo(mx - 9, sy - 20); c.lineTo(mx + 9, sy - 20); c.closePath(); c.fill();
    mono(c, '使徒', mx, sy - 26, 11, cyan, { align: 'center', w: 700 });
    // UN force blips on the line (light when the Angel passes)
    for (let k = 0; k < 6; k++) {
      const bxk = 1.2 + k * 1.9, passed = dist < bxk;
      c.fillStyle = passed ? rgba('red', 0.3) : rgba('orange', 0.9);
      c.fillRect(sx + (sw * bxk) / 13 - 3, sy + 4, 6, 6);
    }
    // sensor array: 12 vertical meters (the spectrum in 12 groups) + field intensity from the bass
    const my = r.y + 170, mh = r.h - 176;
    for (let k = 0; k < 12; k++) {
      let s = 0; for (let b = k * 5; b < k * 5 + 5; b++) s += this.mel[b]!;
      segMeter(c, r.x + k * 26, my, 18, mh, 12, smoothstep(0.35, 1, s / 5), { vertical: true, color: rgba('red', 1), dim: rgba('red', 0.1), hot: rgba('amber', 1), hotFrom: 0.8 });
    }
    const fx = r.x + 322;
    mono(c, 'A.T. FIELD', fx, my + 10, 11, cyan, { w: 700, track: 2 });
    jpText(c, '位相空間 強度', fx, my + 30, 13, rgba('cyan', 0.8));
    segMeter(c, fx, my + 40, r.w - 322, 14, 12, clamp(0.3 + 0.7 * bass), { color: cyan, dim: rgba('cyan', 0.1), hot: rgba('bone', 1), hotFrom: 0.9 });
    sevenSeg(c, String(Math.round(40 + 59 * bass)).padStart(2, '0'), fx, my + 64, 30, cyan, rgba('cyan', 0.08), { thick: 4 });
    mono(c, '% FIELD', fx + 52, my + 92, 11, cyan, { w: 700 });
    mono(c, `BASS ${(au.bassMidi(t) || 0).toFixed(1)} MIDI`, fx, my + mh, 10, rgba('cyan', 0.75), { w: 600 });
  }
}

