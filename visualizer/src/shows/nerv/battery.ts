// Ported from bizarro/evangelion app/src/scenes/battery.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// battery — "INTERNAL BATTERY" (build 1, bars 29–35, 57.02 – 67.82 s).
// The activity-limit countdown. On the first kick of the build (drums re-enter) the umbilical cable
// is purged: 外部電源 切断, the Eva switches to its internal battery and the huge 7-segment timer
// starts counting down from 05:00:00, accelerating to 00:00:00 exactly on bar 34 (where the music
// drops out). The countdown is a real audio integral: 72 % a steepening curve of the build's
// progress, 28 % the running sum of the kicks (every kick visibly bites a chunk off the clock and
// off the discharge curve). Around it: the umbilical schematic, three battery cells draining in
// sequence, a bass voltmeter, the output draw scope (drum envelope), a discharge log of the whole
// build (the real rms envelope past / future, the discharge curve, the vocal stem in cyan) and a
// warning log where every vocal chop (bars 31–33, the Angel speaking) spawns a warning, glitches
// the frame and drops a cyan lock-on bracket over the digits. The clap roll (bars 32–33) steps the
// hazard bands and pushes the alarm wash. Bar 34: 00:00:00, STOP, panels lose power one by one; the
// riser glitches the frozen digits, the hit at beat 3.67 flashes the timer inverted red, and the
// last beat collapses the CRT into a line → black → hard cut to the A.T. FIELD drop.
import * as THREE from 'three';
import { Scene, type Frame, type PostOverrides } from '../../show/scene.ts';
import { Layer2D } from '../../show/gl.ts';
import { rgba } from '../../show/palette.ts';
import { F, font } from '../../show/type.ts';
import { clamp, ease, frameIdx, hash, prog, pulse, smoothstep } from '../../show/util.ts';
import { barTime, brackets, chamferPath, condensed, duck, hazard, hexData, hexPath, jp, panel, segMeter, sevenSeg, warningBox } from './_eva.ts';
import { batteryCell, batteryChrome, lastIdx, makeBatteryComp, meta, mixc, mono, needleGauge, segWidth, vocalChops } from './battery-kit.ts';

type Ev = { t: number; jp: string; en: string; col: string };

const FULL = 300; // 05:00:00 in seconds
const CHOP_TXT: [string, string, string][] = [
  ['使徒 反応', 'ANGEL SIGNAL', 'cyan'], ['電圧低下', 'VOLTAGE DROP', 'red'], ['音声 干渉', 'VOICE INTERFERENCE', 'cyan'],
  ['出力 不安定', 'OUTPUT UNSTABLE', 'red'], ['パターン青', 'PATTERN BLUE', 'cyan'], ['電源 異常', 'POWER FAULT', 'red'],
  ['同調 障害', 'SYNC NOISE', 'amber'], ['残量 警告', 'CHARGE WARNING', 'red'],
];
const MODES: [string, string][] = [['STOP', '停止'], ['SLOW', '低速'], ['NORMAL', '通常'], ['RACING', '全開']];

/** MM:SS:CC of a remaining time in seconds. */
const fmt = (r: number) => {
  const cs = Math.max(0, Math.floor(r * 100));
  const m = Math.floor(cs / 6000), s = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(c).padStart(2, '0')}`;
};

export default class Battery extends Scene {
  L = new Layer2D();
  comp = makeBatteryComp(this.L.texture);
  T = { s: 0, e: 0, cut: 0, b31: 0, b32: 0, b33: 0, b34: 0, hit: 0 };
  kicks: [number, number][] = [];
  kTot = 1;
  chops: number[] = [];
  snares: number[] = [];
  hats: number[] = [];
  evs: Ev[] = [];

  override init() {
    const au = this.ctx.audio, s = this.ctx.start, e = this.ctx.end;
    const T = this.T;
    T.s = s; T.e = e;
    T.b31 = barTime(au, 31); T.b32 = barTime(au, 32); T.b33 = barTime(au, 33); T.b34 = barTime(au, 34);
    // the cable purge: first strong kick of the build (the drums re-entering)
    T.cut = au.events('kick', s, s + 1.2).find((k) => k[1] > 0.5)?.[0] ?? s + 0.45;
    // the bar-34 hit (the fill's big kick+clap before the drop)
    T.hit = au.events('kick', T.b34 + 0.6, e - 0.15).find((k) => k[1] > 0.8)?.[0] ?? T.b34 + 1.2;
    this.kicks = au.events('kick', T.cut + 0.01, T.b34 - 0.08).filter((k) => k[1] > 0.3);
    this.kTot = this.kicks.reduce((a, k) => a + k[1], 0) || 1;
    this.chops = vocalChops(au, T.b31 - 0.25, T.b34 - 0.05);
    this.snares = au.events('snare', s, e).filter((x) => x[1] > 0.3).map((x) => x[0]);
    this.hats = au.events('hat', s - 6, e).map((x) => x[0]);
    const ev: Ev[] = [{ t: T.cut, jp: '外部電源 切断', en: 'EXTERNAL POWER CUT', col: 'red' }, { t: T.cut + 0.45, jp: '内部電源 作動', en: 'INTERNAL BATTERY ON', col: 'amber' }];
    this.chops.forEach((ct, i) => { const [j, en, col] = CHOP_TXT[i % CHOP_TXT.length]!; ev.push({ t: ct, jp: j, en, col }); });
    ev.push({ t: T.cut + 0.9, jp: 'S²機関 未搭載', en: 'NO S² ENGINE', col: 'orange' });
    ev.push({ t: barTime(au, 30), jp: '放電率 上昇', en: 'DRAIN RATE RISING', col: 'amber' });
    ev.push({ t: barTime(au, 30) + 0.9, jp: '予備電源 待機', en: 'RESERVE STANDBY', col: 'orange' });
    let t60 = T.b33; for (let tt = T.cut; tt < T.b34; tt += 0.01) if (this.remain(tt) <= 60) { t60 = tt; break; }
    ev.push({ t: t60, jp: '残り 1分', en: 'ONE MINUTE LEFT', col: 'red' });
    ev.push({ t: T.b34, jp: '活動限界', en: 'ACTIVITY LIMIT', col: 'red' });
    this.evs = ev.sort((a, b) => a.t - b.t);
  }

  /** Discharge fraction 0..1 (0 = full) at time t. */
  drain(t: number) {
    const T = this.T;
    if (t <= T.cut) return 0;
    if (t >= T.b34) return 1;
    const p = (t - T.cut) / (T.b34 - T.cut);
    let k = 0;
    for (const [kt, w] of this.kicks) { if (kt > t) break; k += w * ease.outCubic(clamp((t - kt) / 0.07)); }
    return clamp(0.72 * Math.pow(p, 1.9) + 0.28 * (k / this.kTot));
  }
  remain(t: number) { return FULL * (1 - this.drain(t)); }

  render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides {
    const { renderer, audio: au } = this.ctx;
    const T = this.T, t = f.t, lt = t - T.s;
    const dk = duck(f, au);
    const kick = au.hit('kick', t, 0.08);
    const R = this.remain(t);
    const cutOn = t >= T.cut, zero = t >= T.b34, hitOn = t >= T.hit;
    const racing = t >= T.b31 && !zero;
    // alarm: rises through the clap roll; snares flash it
    const snHit = au.hit('snare', t, 0.06);
    const roll = smoothstep(T.b32, T.b34, t);
    const alarm = zero ? 0.3 + 0.4 * ((t - T.b34) * 2.222 % 1 < 0.5 ? 1 : 0) : clamp(roll * 0.4 + snHit * roll * 0.8);
    // hazard stripe step: one step per clap
    const snN = lastIdx(this.snares, t) + 1;
    const ci = lastIdx(this.chops, t), lastChop = ci >= 0 ? this.chops[ci]! : -9;
    const chopP = pulse(t, lastChop, 0.07);
    const hatN = lastIdx(this.hats, t) + 1;
    // warm → red: the HUD itself heats up through bar 33, fully red at zero
    const heat = zero ? 1 : smoothstep(T.b33 - 0.2, T.b34, t) * 0.55;
    const oc = (a: number) => mixc('orange', 'red', heat, a);
    const dgc = (a: number) => zero ? rgba('red', a) : mixc('amber', 'red', smoothstep(100, 45, R), a);

    // power: panels switch off one by one after zero (with a CRT flicker)
    const powerOn = (g: number) => {
      const p0 = (lt - g * 0.05) / 0.22; // opening power-on
      let v = p0 >= 1 ? 1 : p0 <= 0 ? 0 : (hash(frameIdx(t), g) < p0 ? 1 : 0.15);
      if (zero && g !== 0) {
        const off = T.b34 + 0.06 + g * 0.075;
        if (t > off + 0.12) v = 0.07;
        else if (t > off) v *= hash(frameIdx(t), g, 3) < 0.5 ? 0.9 : 0.1;
      }
      return v;
    };

    const L = this.L; L.clear();
    const c = L.ctx;
    c.textBaseline = 'alphabetic';

    // ================= chrome
    c.globalAlpha = zero ? 0.35 + 0.25 * alarm : 1;
    batteryChrome(c, t, au, {
      col: oc(1), dim: oc(0.08),
      tick: zero
        ? 'ACTIVITY LIMIT REACHED // 活動限界 // INTERNAL BATTERY DEPLETED // 内部電源 残量ゼロ // EVA UNIT-01 ACTIVITY STOPPED // 活動停止 // '
        : 'UMBILICAL CABLE PURGED // アンビリカルケーブル 切断 // SWITCHING TO INTERNAL POWER // 内部電源に切り替え // ACTIVITY LIMIT IMMINENT // 活動限界まで // EVA UNIT-01 // S-TYPE EQUIPMENT NOT INSTALLED // ',
    });

    // ================= centre: the activity-limit timer
    this.timer(c, t, R, { oc, dgc, alarm, dk, kick, snN, racing, zero, hitOn, chopP, heat, on: powerOn(0) });

    // ================= left column
    c.globalAlpha = powerOn(1);
    if (c.globalAlpha > 0) this.source(c, t, cutOn, oc, dk);
    c.globalAlpha = powerOn(3);
    if (c.globalAlpha > 0) this.cells(c, t, oc, kick, hatN);

    // ================= right column
    c.globalAlpha = powerOn(2);
    if (c.globalAlpha > 0) this.output(c, t, oc, dk);
    c.globalAlpha = zero ? 1 : powerOn(4);
    this.warnings(c, t, oc, chopP, snHit, zero);

    // ================= bottom: discharge log
    c.globalAlpha = powerOn(5);
    if (c.globalAlpha > 0) this.log(c, t, oc);
    if (zero) this.limitCard(c, t);
    c.globalAlpha = 1;

    // ---- GL composite
    const u = this.comp.u;
    const riser = zero && !hitOn ? smoothstep(T.b34 + 0.75, T.hit, t) : 0;
    const hitP = hitOn ? pulse(t, T.hit, 0.1) : 0;
    const off = prog(t, T.e - 0.17, T.e - 0.03, ease.inQuad);
    u.uT!.value = t; u.uFi!.value = frameIdx(t) % 997;
    u.uGlitch!.value = clamp(chopP * 0.9 + riser * 0.8 * (hash(frameIdx(t), 5) < 0.5 ? 1 : 0.3) + hitP * 0.7 + 0.5 * pulse(t, T.cut, 0.08) + 0.6 * pulse(t, T.b34, 0.07));
    u.uAlarm!.value = alarm * (zero ? 0.8 : 1) + hitP * 0.6;
    u.uPower!.value = zero ? 0.78 + 0.22 * (hash(frameIdx(t), 9) < 0.85 ? 1 : 0) : 1;
    u.uOff!.value = off;
    u.uKick!.value = zero ? 0 : dk * 0.6 + kick * 0.4;
    u.uGround!.value = zero ? 0.025 : 0.05;
    (u.uGroundCol!.value as THREE.Vector3).set(1, 0.194 * (1 - heat) + 0.01 * heat, 0.01);
    L.upload();
    this.comp.render(renderer, out);

    return {
      bloom: hitOn ? 0.32 : 0.62, bloomThreshold: hitOn ? 0.8 : 0.64, halation: 0.1, vignette: 0.42, grain: 0.05,
      ca: 0.8 + 1.6 * snHit * roll + 3 * chopP + 3.5 * Math.exp(-lt / 0.1) + 3 * pulse(t, T.cut, 0.12) + 4 * hitP,
      flash: 0.35 * pulse(t, T.cut, 0.07) + 0.25 * pulse(t, T.b34, 0.08) + 0.18 * pulse(t, T.hit, 0.04),
      zoom: 1 + 0.004 * dk + 0.02 * pulse(t, T.cut, 0.12) + 0.03 * hitP + 0.012 * riser,
      shake: hitOn ? [Math.sin(t * 173) * 9 * hitP, Math.cos(t * 191) * 7 * hitP] : [Math.sin(t * 157) * 3 * chopP, 0],
    };
  }

  // ---------------------------------------------------------------- the timer
  timer(c: CanvasRenderingContext2D, t: number, R: number, o: { oc: (a: number) => string; dgc: (a: number) => string; alarm: number; dk: number; kick: number; snN: number; racing: boolean; zero: boolean; hitOn: boolean; chopP: number; heat: number; on: number }) {
    const T = this.T, { oc } = o;
    const x = 380, y = 128, w = 1160, h = 562;
    const hitP = o.hitOn ? pulse(t, T.hit, 0.16) : 0;
    // the hit: the timer inverts (solid red, black digits), then strobes on 16ths until the cut
    const inv = o.hitOn && (t - T.hit < 0.22 || Math.floor((t - T.hit) / 0.1125) % 2 === 0);
    c.save();
    c.globalAlpha = o.on;
    const frameCol = o.zero ? rgba('red', 1) : oc(1);
    panel(c, x, y, w, h, { title: 'activity limit', jp: '活動限界', color: frameCol, fill: inv ? rgba('red', 0.94) : 'rgba(10,6,3,0.82)', cut: 22 });
    // hazard bands above/below the panel: step one stripe per clap through the roll
    const hz = smoothstep(this.T.b32 - 0.1, this.T.b32 + 0.1, t);
    if (hz > 0) {
      c.globalAlpha = o.on * hz;
      hazard(c, x, y - 12, w, 7, o.snN * 13, rgba('red', 0.9), 'rgba(0,0,0,0)', 13);
      hazard(c, x, y + h + 5, w, 7, -o.snN * 13, rgba('red', 0.9), 'rgba(0,0,0,0)', 13);
      c.globalAlpha = o.on;
    }
    // header right: status text
    mono(c, o.zero ? 'STATUS : ACTIVITY STOPPED' : o.racing ? 'STATUS : DISCHARGE CRITICAL' : t >= T.cut ? 'STATUS : INTERNAL SUPPLY' : 'STATUS : EXTERNAL SUPPLY', x + w - 24, y + 21, 13, o.zero ? rgba('red', 1) : oc(0.85), { align: 'right' });

    // label row
    const lc = inv ? rgba('ink', 1) : o.zero ? rgba('red', 1) : oc(1);
    c.fillStyle = lc; c.font = jp(60, 800, true); c.textAlign = 'left';
    c.fillText('活動限界まで', x + 30, y + 118);
    mono(c, 'ACTIVE TIME REMAINING', x + 34, y + 150, 15, inv ? rgba('ink', 1) : oc(0.85), { w: 700, track: 4 });
    c.font = jp(15, 600, false); c.fillStyle = inv ? rgba('ink', 1) : oc(0.7);
    c.fillText('エヴァンゲリオン初号機  内部電源残量', x + 34, y + 174);

    // INTERNAL / EXTERNAL chips
    const chip = (cx: number, en: string, j: string, st: 'on' | 'off' | 'cut' | 'dead', sub: string) => {
      const cy = y + 62, cw = 214, ch = 90;
      const colK = st === 'on' ? 'amber' : st === 'cut' || st === 'dead' ? 'red' : 'orange';
      const solid = st === 'on' || (st === 'cut' && (t - T.cut) * 4 % 1 < 0.5 && t - T.cut < 1.4);
      chamferPath(c, cx, cy, cw, ch, [0, 14, 0, 14]);
      c.fillStyle = solid ? rgba(colK, st === 'on' ? 0.95 : 0.85) : 'rgba(0,0,0,0.55)'; c.fill();
      c.strokeStyle = rgba(colK, st === 'off' ? 0.45 : 1); c.lineWidth = 2; c.stroke();
      const tc = solid ? rgba('ink', 1) : rgba(colK, st === 'off' ? 0.45 : 1);
      mono(c, en, cx + 16, cy + 30, 20, tc, { w: 700, track: 4 });
      c.font = jp(22, 800, false); c.fillStyle = tc; c.fillText(j, cx + 16, cy + 64);
      mono(c, sub, cx + cw - 14, cy + 64, 13, tc, { w: 700, align: 'right', track: 2 });
      if (st === 'cut' || st === 'dead') { c.strokeStyle = solid ? rgba('ink', 1) : rgba('red', 1); c.lineWidth = 3; c.beginPath(); c.moveTo(cx + 8, cy + ch - 8); c.lineTo(cx + cw - 8, cy + 8); c.stroke(); }
    };
    const cut = t >= T.cut;
    chip(x + w - 488, 'INTERNAL', '内部電源', o.zero ? 'dead' : cut ? 'on' : 'off', o.zero ? '0%' : cut ? 'ON' : 'STBY');
    chip(x + w - 256, 'EXTERNAL', '外部電源', cut ? 'cut' : 'on', cut ? '切断' : '接続');

    // digits
    const txt = fmt(R);
    const dh = 248, dw = segWidth(txt, dh);
    const blinkZ = o.zero && !o.hitOn ? ((t - T.b34) * 4.444 % 1 < 0.55 ? 1 : 0.18) : 1;
    const riser = o.zero && !o.hitOn ? smoothstep(T.b34 + 0.75, T.hit, t) : 0;
    const sc = 1 + 0.012 * o.dk + 0.03 * hitP;
    const dx0 = x + w / 2 - dw / 2 - 10, dy0 = y + 200;
    c.save();
    c.translate(x + w / 2, dy0 + dh / 2); c.scale(sc, sc); c.translate(-(x + w / 2), -(dy0 + dh / 2));
    // ghost 8s behind (the LCD's unlit segments)
    const dcol = inv ? rgba('ink', 1) : o.dgc(blinkZ);
    const ghost = inv ? rgba('ink', 0.12) : o.zero ? rgba('red', 0.07) : o.dgc(0.075);
    if (riser > 0 && hash(frameIdx(t), 11) < 0.3 + 0.5 * riser) {
      // riser: the frozen digits tear (sliced horizontally, offset)
      for (let k = 0; k < 5; k++) {
        const sy = dy0 + (k * dh) / 5;
        c.save(); c.beginPath(); c.rect(x, sy, w, dh / 5); c.clip();
        sevenSeg(c, txt, dx0 + (hash(frameIdx(t), k) - 0.5) * 60 * riser, dy0, dh, dcol, ghost, { skew: 0.08 });
        c.restore();
      }
    } else sevenSeg(c, txt, dx0, dy0, dh, dcol, ghost, { skew: 0.08 });
    // group captions
    const gw = segWidth('00', dh), cw = segWidth(':', dh);
    ['MIN', 'SEC', '1/100'].forEach((s, i) => mono(c, s, dx0 + i * (gw + cw) + gw / 2, dy0 + dh + 24, 13, inv ? rgba('ink', 1) : oc(0.7), { align: 'center', track: 3 }));
    c.restore();

    // vocal chops: cyan lock-on brackets over the digits (the Angel speaks)
    for (let i = Math.max(0, lastIdx(this.chops, t) - 2); i <= lastIdx(this.chops, t); i++) {
      const ct = this.chops[i]!, age = t - ct;
      if (age > 0.34 || o.zero) continue;
      const a = 1 - age / 0.34;
      const bx = x + 150 + hash(i, 1) * (w - 420), by = y + 206 + hash(i, 2) * 150, bw = 120 + hash(i, 3) * 90, bh = 70 + hash(i, 4) * 40;
      const sh = (1 - a) * 10;
      c.globalAlpha = o.on * a;
      brackets(c, bx - sh, by - sh, bw + sh * 2, bh + sh * 2, 14, rgba('cyan', 1), 2.4);
      c.fillStyle = rgba('cyan', 0.12 * a); c.fillRect(bx, by, bw, bh);
      mono(c, `VOX ${String(i + 1).padStart(2, '0')}  ${(clamp(this.ctx.audio.env('vocal', ct) * 1.1) * 100).toFixed(0)}%`, bx + 2, by - sh - 8, 12, rgba('cyan', 1), { w: 700 });
      c.font = jp(18, 800, false); c.fillStyle = rgba('cyan', 1); c.fillText('使徒', bx + bw - 40, by + bh + sh + 22);
      for (let k = 0; k < 5; k++) { hexPath(c, bx + bw * hash(i, k, 7), by + bh * hash(i, k, 8), 5 + 4 * hash(i, k, 9)); c.fill(); }
      c.globalAlpha = o.on;
    }

    // mode row
    const my = y + 484, mw = (w - 60 - 3 * 12) / 4, mh = 44;
    const active = o.zero ? 0 : o.racing ? 3 : 2;
    MODES.forEach(([en, j], i) => {
      const mx = x + 30 + i * (mw + 12);
      const on = i === active;
      const k = on ? (i === 0 ? 'red' : i === 3 ? 'amber' : 'orange') : 'orange';
      const bl = on && i === 3 ? (o.chopP > 0.3 ? 0.55 : 1) : on && i === 0 ? (((t - T.b34) * 2.222) % 1 < 0.6 ? 1 : 0.45) : 1;
      chamferPath(c, mx, my, mw, mh, [0, 10, 0, 10]);
      c.fillStyle = on ? rgba(k, 0.9 * bl) : 'rgba(0,0,0,0.5)'; c.fill();
      c.strokeStyle = on ? rgba(k, 1) : inv ? rgba('ink', 0.6) : oc(0.35); c.lineWidth = 1.5; c.stroke();
      const tc = on ? rgba('ink', 1) : inv ? rgba('ink', 0.7) : oc(0.45);
      mono(c, en, mx + 18, my + 29, 19, tc, { w: 700, track: 5 });
      c.font = jp(17, 700, false); c.fillStyle = tc; c.textAlign = 'right'; c.fillText(j, mx + mw - 16, my + 29); c.textAlign = 'left';
    });
    // remaining bar
    segMeter(c, x + 30, y + h - 30, w - 60, 10, 90, R / FULL, { color: inv ? rgba('ink', 1) : o.dgc(1), hot: o.dgc(1), hotFrom: 2, dim: inv ? rgba('ink', 0.2) : oc(0.1), gap: 3 });
    c.restore();
  }

  // ---------------------------------------------------------------- left: power source + umbilical
  source(c: CanvasRenderingContext2D, t: number, cut: boolean, oc: (a: number) => string, dk: number) {
    const T = this.T, au = this.ctx.audio;
    const x = 56, y = 128, w = 300, h = 400;
    const p = panel(c, x, y, w, h, { title: 'supply', jp: '電源', color: oc(1) });
    // umbilical schematic
    const cx = x + w / 2, sy = p.y + 12;
    c.save();
    c.beginPath(); c.rect(p.x, p.y, p.w, 208); c.clip();
    // grid
    c.strokeStyle = oc(0.1); c.lineWidth = 1; c.beginPath();
    for (let gx = p.x; gx <= p.x + p.w; gx += 20) { c.moveTo(gx, p.y); c.lineTo(gx, p.y + 208); }
    for (let gy = p.y; gy <= p.y + 208; gy += 20) { c.moveTo(p.x, gy); c.lineTo(p.x + p.w, gy); }
    c.stroke();
    // socket (the Eva's back)
    chamferPath(c, cx - 86, sy, 172, 58, [0, 12, 0, 12]);
    c.fillStyle = 'rgba(0,0,0,0.7)'; c.fill(); c.strokeStyle = oc(1); c.lineWidth = 2; c.stroke();
    mono(c, 'UNIT-01  REAR', cx - 74, sy + 22, 11, oc(0.9), { w: 700 });
    c.font = jp(12, 600, false); c.fillStyle = oc(0.7); c.fillText('背部 ソケット', cx - 74, sy + 42);
    c.fillStyle = cut ? rgba('red', 0.9) : oc(0.9); c.fillRect(cx + 34, sy + 14, 36, 30);
    c.fillStyle = rgba('ink', 1); c.fillRect(cx - 24, sy + 50, 48, 10);
    // plug + cable; after the purge it falls away and swings
    const age = t - T.cut;
    const drop = cut ? Math.min(1, age / 0.4) ** 2 * 38 : 0;
    const sway = cut ? Math.sin(age * 7) * Math.exp(-age * 1.6) * 0.22 : 0;
    c.save();
    c.translate(cx, sy + 60 + drop); c.rotate(sway);
    c.fillStyle = cut ? rgba('red', 1) : oc(1);
    chamferPath(c, -22, 0, 44, 38, [0, 0, 8, 8]); c.fill();
    c.fillStyle = rgba('ink', 1); c.fillRect(-12, 8, 24, 5); c.fillRect(-12, 18, 24, 5);
    c.lineCap = 'butt';
    c.strokeStyle = cut ? rgba('red', 0.95) : oc(0.95); c.lineWidth = 16;
    c.beginPath(); c.moveTo(0, 38); c.lineTo(0, 76); c.quadraticCurveTo(0, 110, 60, 128); c.lineTo(200, 170); c.stroke();
    c.strokeStyle = rgba('ink', 1); c.lineWidth = 6; c.stroke();
    // current packets along the cable (stop when cut)
    if (!cut) for (let k = 0; k < 4; k++) { const ph = (t * 1.4 + k / 4) % 1; c.fillStyle = rgba('amber', 1); c.fillRect(-3, 40 + ph * 36, 6, 6); }
    c.restore();
    // sparks at the socket after the purge (re-fire on kicks, decaying)
    if (cut) {
      const sp = pulse(t, T.cut, 0.25) + 0.5 * au.hit('kick', t, 0.05) * Math.exp(-age * 0.5);
      const fi = frameIdx(t);
      c.strokeStyle = rgba('amber', 1); c.lineWidth = 1.5; c.beginPath();
      for (let k = 0; k < 14; k++) {
        if (hash(fi, k) > sp * 1.4) continue;
        const a = Math.PI * (0.15 + 0.7 * hash(fi, k, 1)), r0 = 6, r1 = 12 + 40 * hash(fi, k, 2) * sp;
        c.moveTo(cx + Math.cos(a) * r0, sy + 62 + Math.sin(a) * r0); c.lineTo(cx + Math.cos(a) * r1, sy + 62 + Math.sin(a) * r1);
      }
      c.stroke();
      // 切断 tag in the gap
      const bl = age < 1.6 ? ((age * 4.444) % 1 < 0.6 ? 1 : 0.2) : 1;
      c.globalAlpha *= bl;
      chamferPath(c, x + 20, sy + 82, 86, 36, 6); c.fillStyle = rgba('red', 0.9); c.fill();
      c.fillStyle = rgba('ink', 1); c.font = jp(22, 800, false); c.fillText('切断', x + 38, sy + 108);
      c.globalAlpha /= bl;
    } else {
      chamferPath(c, x + 20, sy + 82, 86, 36, 6); c.strokeStyle = rgba('green', 1); c.lineWidth = 1.5; c.stroke();
      c.fillStyle = rgba('green', 1); c.font = jp(22, 800, false); c.fillText('接続', x + 38, sy + 108);
    }
    c.restore();
    mono(c, 'UMBILICAL CABLE', p.x, p.y + 226, 12, oc(0.9), { w: 700, track: 2 });
    c.font = jp(12, 600, false); c.fillStyle = oc(0.6); c.textAlign = 'right'; c.fillText('アンビリカルケーブル', p.x + p.w, p.y + 226); c.textAlign = 'left';
    c.fillStyle = oc(0.35); c.fillRect(p.x, p.y + 234, p.w, 1);
    // status rows
    const bass = au.env('bass', t);
    const rows: [string, string, string, string][] = [
      ['EXTERNAL', '外部電源', cut ? 'CUT' : 'OK', cut ? 'red' : 'green'],
      ['INTERNAL', '内部電源', cut ? 'ACTIVE' : 'STBY', cut ? 'amber' : 'orange'],
      ['S² ENGINE', 'S機関', 'N/A', 'orange'],
      ['BUS VOLT', '電圧', `${(380 + 160 * bass - 40 * dk).toFixed(1)}V`, 'orange'],
    ];
    rows.forEach(([en, j, v, k], i) => {
      const ry = p.y + 258 + i * 26;
      mono(c, en, p.x, ry, 12, oc(0.9), { w: 600, track: 1.5 });
      c.font = jp(12, 600, false); c.fillStyle = oc(0.6); c.fillText(j, p.x + 104, ry);
      mono(c, v, p.x + p.w, ry, 13, rgba(k, 1), { w: 700, align: 'right', track: 1.5 });
    });
  }

  // ---------------------------------------------------------------- left: battery cells
  cells(c: CanvasRenderingContext2D, t: number, oc: (a: number) => string, kick: number, hatN: number) {
    const x = 56, y = 544, w = 300, h = 466;
    const p = panel(c, x, y, w, h, { title: 'cells', jp: '電池残量', color: oc(1) });
    const d = this.drain(t);
    const segs: [number, number][] = [[0, 0.45], [0.45, 0.8], [0.8, 1]];
    const names = ['MAIN', 'SUB', 'RESERVE'];
    segs.forEach(([a, b], i) => {
      const v = 1 - clamp((d - a) / (b - a));
      const draining = d > a && d < b;
      const cx = p.x + 6 + i * 96;
      batteryCell(c, cx, p.y + 8, 76, 244, 14, v, { col: oc(1), low: rgba('red', 1), dim: oc(0.08), flash: draining ? kick * 0.8 : 0 });
      const pct = String(Math.round(v * 100)).padStart(3, ' ').replace(/ /g, v >= 1 ? ' ' : '0');
      sevenSeg(c, pct.trim().padStart(3, '0'), cx + 2, p.y + 266, 26, v < 0.25 ? rgba('red', 1) : rgba('amber', 1), oc(0.07), { thick: 3.4 });
      mono(c, '%', cx + 66, p.y + 290, 11, oc(0.7));
      mono(c, names[i]!, cx, p.y + 316, 12, draining ? rgba('amber', 1) : oc(0.8), { w: 700, track: 2 });
      c.fillStyle = draining ? rgba('amber', 1) : v <= 0 ? rgba('red', 0.8) : oc(0.25);
      c.fillRect(cx, p.y + 324, 76, 4);
    });
    // cell log: steps one row per hat
    c.fillStyle = oc(0.3); c.fillRect(p.x, p.y + 340, p.w, 1);
    c.font = font(F.mono(500), 11.5); c.letterSpacing = '1px';
    for (let r = 0; r < 4; r++) {
      const idx = hatN - r;
      c.fillStyle = oc(r === 0 ? 0.95 : 0.6 - r * 0.1);
      c.fillText(`${(0x5a00 + idx * 16).toString(16).toUpperCase()} CELL${(idx % 3) + 1} ${hexData(idx, 21, 4)} ${(2.1 - d * 0.6 - 0.05 * ((idx * 7) % 5)).toFixed(2)}V`, p.x, p.y + 362 + r * 18);
    }
    c.letterSpacing = '0px';
  }

  // ---------------------------------------------------------------- right: output gauge + draw scope
  output(c: CanvasRenderingContext2D, t: number, oc: (a: number) => string, dk: number) {
    const au = this.ctx.audio;
    const x = 1564, y = 128, w = 300, h = 380;
    const p = panel(c, x, y, w, h, { title: 'output', jp: '出力', color: oc(1) });
    const bass = au.env('bass', t);
    needleGauge(c, p.x + p.w / 2, p.y + 128, 116, clamp(bass * 0.92 + 0.08 * dk), { col: oc(0.85), hot: rgba('red', 0.9), label: (i) => String(i * 100), redFrom: 0.78 });
    mono(c, 'BUS V', p.x, p.y + 12, 11, oc(0.8), { w: 700, track: 2 });
    c.font = jp(12, 600, false); c.fillStyle = oc(0.6); c.textAlign = 'right'; c.fillText('低音負荷', p.x + p.w, p.y + 12); c.textAlign = 'left';
    mono(c, `${(au.bassMidi(t) > 0 ? 440 * Math.pow(2, (au.bassMidi(t) - 69) / 12) : 0).toFixed(1)} HZ`, p.x, p.y + 142, 11, rgba('amber', 0.9), { w: 700, track: 2 });
    // output kW (rms) and the drain rate (how fast the clock is running)
    const kw = (clamp(au.env('rms', t)) * 1850).toFixed(0).padStart(4, '0');
    mono(c, 'OUTPUT', p.x, p.y + 162, 11, oc(0.75), { w: 600 });
    sevenSeg(c, kw, p.x, p.y + 170, 34, rgba('amber', 1), oc(0.07), { thick: 4 });
    mono(c, 'kW', p.x + 110, p.y + 202, 11, oc(0.75));
    const rate = (this.remain(t - 0.06) - this.remain(t + 0.06)) / 0.12;
    mono(c, 'DRAIN RATE', p.x + 150, p.y + 162, 11, oc(0.75), { w: 600 });
    sevenSeg(c, (t < this.T.cut ? 0 : rate).toFixed(1).padStart(4, '0').slice(-5), p.x + 150, p.y + 170, 34, rate > 60 ? rgba('red', 1) : rgba('amber', 1), oc(0.07), { thick: 4 });
    mono(c, '×', p.x + 272, p.y + 202, 13, oc(0.75));
    // rolling drum draw scope: last 1.5 bars
    const gx = p.x, gy = p.y + 222, gw = p.w, gh = p.h - 236;
    c.strokeStyle = oc(0.14); c.lineWidth = 1; c.beginPath();
    for (let i = 0; i <= 6; i++) { c.moveTo(gx + (gw * i) / 6, gy); c.lineTo(gx + (gw * i) / 6, gy + gh); }
    for (let i = 0; i <= 3; i++) { c.moveTo(gx, gy + (gh * i) / 3); c.lineTo(gx + gw, gy + (gh * i) / 3); }
    c.stroke();
    const span = 2.7, N = 150;
    c.beginPath(); c.moveTo(gx, gy + gh);
    for (let i = 0; i <= N; i++) {
      const tt = t - span + (span * i) / N;
      const v = clamp(au.env('drums', tt) * 1.6);
      c.lineTo(gx + (gw * i) / N, gy + gh - v * gh * 0.92);
    }
    c.lineTo(gx + gw, gy + gh); c.closePath();
    c.fillStyle = oc(0.22); c.fill();
    c.strokeStyle = rgba('amber', 1); c.lineWidth = 1.5; c.stroke();
    // beat ticks on the scope
    const b0 = Math.floor((t - span - 4.82) / 0.45), b1 = Math.floor((t - 4.82) / 0.45);
    for (let b = b0; b <= b1; b++) {
      const bt = 4.82 + b * 0.45, xx = gx + ((bt - (t - span)) / span) * gw;
      if (xx < gx) continue;
      c.fillStyle = oc(b % 4 === 0 ? 0.7 : 0.3); c.fillRect(xx, gy + gh, 1, b % 4 === 0 ? 8 : 4);
    }
    mono(c, 'DRUM LOAD', gx + 4, gy + 14, 10, oc(0.8));
  }

  // ---------------------------------------------------------------- right: warnings
  warnings(c: CanvasRenderingContext2D, t: number, oc: (a: number) => string, chopP: number, snHit: number, zero: boolean) {
    const T = this.T;
    const x = 1564, y = 524, w = 300, h = 486;
    const base = c.globalAlpha;
    const p = panel(c, x, y, w, h, { title: 'alerts', jp: '警告', color: zero ? rgba('red', 1) : oc(1) });
    // the warning box: armed from bar 31, blinks on chops (and on claps in the roll)
    const armed = t >= T.b31;
    if (armed || zero) {
      const bl = zero ? ((t - T.b34) * 4.444 % 1 < 0.55 ? 1 : 0.25) : clamp(0.25 + chopP * 1.2 + snHit * 0.6);
      warningBox(c, p.x, p.y + 4, p.w, 140, zero ? 'LIMIT' : 'WARNING', zero ? '活動限界' : '警告  使徒 反応', { blink: bl, phase: (lastIdx(this.snares, t) + 1) * 13 });
    } else {
      chamferPath(c, p.x, p.y + 4, p.w, 140, 18);
      c.fillStyle = 'rgba(0,0,0,0.5)'; c.fill(); c.strokeStyle = oc(0.4); c.lineWidth = 1.5; c.stroke();
      condensed(c, 'NOMINAL', p.x + p.w / 2, p.y + 96, 64, { sx: 0.58, color: oc(0.5), align: 'center' });
      c.font = jp(15, 700, false); c.fillStyle = oc(0.5); c.textAlign = 'center'; c.fillText('異常なし', p.x + p.w / 2, p.y + 124); c.textAlign = 'left';
    }
    // event rows, newest on top
    const past = this.evs.filter((e) => e.t <= t);
    const vis = past.slice(-6).reverse();
    vis.forEach((e, i) => {
      const ry = p.y + 162 + i * 48;
      const age = t - e.t;
      const fresh = age < 0.14;
      c.globalAlpha = base * (i === 0 ? 1 : 0.85 - i * 0.09);
      chamferPath(c, p.x, ry, 112, 26, [0, 8, 0, 0]);
      c.fillStyle = rgba(e.col, fresh ? 1 : 0.85); c.fill();
      c.fillStyle = rgba('ink', 1); c.font = jp(14, 800, false); c.fillText(e.jp, p.x + 7, ry + 19);
      if (fresh) { c.fillStyle = rgba(e.col, 0.25); c.fillRect(p.x, ry, p.w, 40); }
      mono(c, e.en, p.x + 120, ry + 18, 10.5, rgba(e.col, 1), { w: 700, track: 1 });
      mono(c, `T-${fmt(this.remain(e.t))}   @${e.t.toFixed(2)}`, p.x + 120, ry + 36, 10, oc(0.6), { w: 500, track: 1 });
    });
    c.globalAlpha = base;
  }

  // ---------------------------------------------------------------- bottom: discharge log
  log(c: CanvasRenderingContext2D, t: number, oc: (a: number) => string) {
    const T = this.T, au = this.ctx.audio;
    const x = 380, y = 706, w = 1160, h = 304;
    const p = panel(c, x, y, w, h, { title: 'discharge log', jp: '放電記録', color: oc(1) });
    mono(c, 'BARS 29–35  //  RMS LOAD  ·  DISCHARGE CURVE  ·  VOCAL STEM', x + w - 24, y + 21, 12, oc(0.8), { align: 'right', track: 2 });
    const gx = p.x + 70, gy = p.y + 26, gw = p.w - 84, gh = p.h - 56;
    const tx = (tt: number) => gx + ((tt - T.s) / (T.e - T.s)) * gw;
    // axis
    c.font = font(F.mono(500), 11); c.textAlign = 'right';
    for (let k = 0; k <= 4; k++) {
      const yy = gy + (gh * k) / 4;
      c.fillStyle = oc(0.7); c.fillText(`${100 - k * 25}%`, gx - 10, yy + 4);
      c.fillStyle = oc(0.12); c.fillRect(gx, yy, gw, 1);
    }
    c.textAlign = 'left';
    // bar grid
    for (let k = 29; k <= 35; k++) {
      const bt = barTime(au, k), xx = tx(bt);
      c.fillStyle = oc(k === 34 ? 0.9 : 0.4); c.fillRect(xx, gy - 6, 1, gh + 12);
      for (let q = 1; q < 4 && k < 35; q++) { c.fillStyle = oc(0.15); c.fillRect(tx(bt + q * 0.45), gy, 1, gh); }
      mono(c, `${k}`, xx + 4, gy + gh + 18, 11, oc(0.8), { w: 700 });
    }
    // rms load columns: past bright, future dim (the build's shape, the bar-34 hole ahead)
    const colW = 4, n = Math.floor(gw / colW);
    const past = new Path2D(), fut = new Path2D();
    for (let i = 0; i < n; i++) {
      const tt = T.s + ((i + 0.5) / n) * (T.e - T.s);
      const v = Math.pow(clamp(au.env('rms', tt)), 1.3);
      const hh = v * gh * 0.62;
      (tt <= t ? past : fut).rect(gx + i * colW, gy + gh - hh, colW - 1.2, hh);
    }
    c.fillStyle = rgba('graphite', 0.9); c.fill(fut);
    c.fillStyle = oc(0.62); c.fill(past);
    // vocal stem in cyan (top band, hanging down)
    c.beginPath();
    for (let i = 0; i <= n; i++) {
      const tt = T.s + (i / n) * (T.e - T.s);
      if (tt > t) break;
      const v = clamp(au.env('vocal', tt));
      c.lineTo(gx + i * colW, gy + gh - v * gh * 0.62);
    }
    c.strokeStyle = rgba('cyan', 0.9); c.lineWidth = 1.4; c.stroke();
    for (const ct of this.chops) {
      if (ct > t) break;
      const xx = tx(ct); c.fillStyle = rgba('cyan', 1); c.fillRect(xx - 1, gy - 8, 2, 10);
    }
    // discharge curve (past solid, predicted future dashed)
    const curve = (t0: number, t1: number) => {
      c.beginPath();
      const m = Math.max(2, Math.ceil((t1 - t0) / 0.02));
      for (let i = 0; i <= m; i++) {
        const tt = t0 + ((t1 - t0) * i) / m;
        const yy = gy + gh * this.drain(tt);
        if (i) c.lineTo(tx(tt), yy); else c.moveTo(tx(tt), yy);
      }
    };
    const tn = Math.min(t, T.e);
    curve(T.s, tn); c.strokeStyle = rgba('amber', 1); c.lineWidth = 2.6; c.stroke();
    if (tn < T.e) { curve(tn, T.e); c.setLineDash([6, 6]); c.strokeStyle = oc(0.5); c.lineWidth = 1.4; c.stroke(); c.setLineDash([]); }
    // playhead + readout
    const px = tx(tn), py = gy + gh * this.drain(tn);
    c.fillStyle = rgba('amber', 1); c.fillRect(px - 1, gy - 10, 2, gh + 16);
    c.beginPath(); c.moveTo(px - 7, gy - 16); c.lineTo(px + 7, gy - 16); c.lineTo(px, gy - 8); c.closePath(); c.fill();
    hexPath(c, px, py, 7); c.fill();
    const lab = `T-${fmt(this.remain(tn))}`, right = px > gx + gw - 170;
    mono(c, lab, px + (right ? -14 : 14), py - 12, 13, rgba('amber', 1), { w: 700, align: right ? 'right' : 'left' });
    // flags
    const flag = (tt: number, s: string, col: string, up = 0, left = false) => {
      const xx = tx(tt);
      c.fillStyle = col; c.fillRect(xx, gy + gh - 64 - up, 1, 64 + up);
      c.font = jp(12, 800, false);
      const tw = c.measureText(s).width, fx = left ? xx - tw - 14 : xx;
      chamferPath(c, fx, gy + gh - 84 - up, tw + 14, 20, left ? [6, 0, 0, 0] : [0, 6, 0, 0]); c.fill();
      c.fillStyle = rgba('ink', 1); c.fillText(s, fx + 7, gy + gh - 69 - up);
    };
    c.font = jp(12, 800, false);
    flag(T.cut, '外部電源 切断', t >= T.cut ? rgba('red', 1) : oc(0.5), 40);
    flag(T.b34, '活動限界', t >= T.b34 ? rgba('red', 1) : oc(0.6), 40);
    flag(T.e - 0.02, 'DROP  A.T.', oc(0.6), 110, true);
  }

  /** After zero: the big red card that replaces the dead discharge log. */
  limitCard(c: CanvasRenderingContext2D, t: number) {
    const T = this.T;
    const a = smoothstep(T.b34 + 0.56, T.b34 + 0.62, t);
    if (a <= 0) return;
    const bl = t >= T.hit ? 1 : ((t - T.b34) * 2.222 % 1 < 0.62 ? 1 : 0.35);
    c.save();
    c.globalAlpha = a;
    chamferPath(c, 384, 736, 1152, 262, [0, 22, 0, 22]); c.fillStyle = 'rgba(10,0,0,0.9)'; c.fill();
    c.strokeStyle = rgba('red', 0.5); c.lineWidth = 1.5; c.stroke();
    c.globalAlpha = a * bl;
    condensed(c, 'ACTIVITY LIMIT', 400, 900, 170, { sx: 0.56, color: rgba('red', 1), bold: 0.03 });
    c.font = jp(58, 800, true); c.fillStyle = rgba('red', 1); c.textAlign = 'right';
    c.fillText('活動停止', 1520, 868);
    c.font = jp(20, 700, false); c.fillText('内部電源 残量ゼロ  エヴァ初号機 沈黙', 1520, 904);
    c.textAlign = 'left';
    c.fillStyle = rgba('red', 1); c.fillRect(400, 930, 1120, 3);
    meta(c, 400, 962, [['RESIDUAL', '0.00%   CELLS 0/3   BUS 000.0V']], { color: rgba('red', 0.8), size: 13, keyW: 104 });
    c.restore();
  }
}
