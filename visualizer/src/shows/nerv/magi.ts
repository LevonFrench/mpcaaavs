// Ported from bizarro/evangelion app/src/scenes/magi.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// magi — "MAGI SYSTEM" (groove 1: drums + bass enter, bars 2–7, 8.42 – 17.42 s).
// The classic MAGI deliberation screen: BALTHASAR·2 / CASPER·3 / MELCHIOR·1 as three chamfered
// processors joined by thick bars around a condensed "MAGI". Each processor is a hex-cell spectrum
// analyser of its own band (MELCHIOR low, BALTHASAR mid, CASPER high). Every kick casts a vote from
// the next unit in turn: a plain kick = 承認 APPROVE (green), a kick with the clap = 否決 REJECT (red).
// On bar 6 all three approve at once (全会一致, unanimous) and the resolution locks to 可決.
// Around it: the 提訴 / 決議 boxes with the MAGI metadata, a system log that scrolls on the hats,
// an input oscilloscope, a vote tally, processor load meters, the input routing spectrum.
import * as THREE from 'three';
import { Scene, type Frame, type PostOverrides } from '../../show/scene.ts';
import { Layer2D } from '../../show/gl.ts';
import { rgba } from '../../show/palette.ts';
import { F, font } from '../../show/type.ts';
import { clamp, ease, frameIdx, hash, prog, pulse, smoothstep } from '../../show/util.ts';
import { barTime, chamferPath, condensed, duck, evaLabel, hexData, jp, makeScanPass, panel, segMeter, sevenSeg, W, H } from './_eva.ts';
import { chrome, makeHexGround, meta, segWidth } from './magi-hud.ts';
import { nervText } from './show-text.ts';


type Vote = { t: number; u: number; ok: boolean; all?: boolean };
type LogRow = { t: number; kind: 'hat' | 'vote'; text: string; ok?: boolean };

const UNITS = [
  { name: 'MELCHIOR·1', jp: 'メルキオール', band: [0, 20] as [number, number], range: 'LOW  30–250 HZ' },
  { name: 'BALTHASAR·2', jp: 'バルタザール', band: [21, 42] as [number, number], range: 'MID  250–2.5K HZ' },
  { name: 'CASPER·3', jp: 'カスパー', band: [43, 63] as [number, number], range: 'HIGH 2.5K–16K HZ' },
];
// block rects [x, y, w, h] and chamfers [tl, tr, br, bl]
const BLK: { r: [number, number, number, number]; cut: [number, number, number, number]; head: 'top' | 'bottom' }[] = [
  { r: [1044, 628, 400, 222], cut: [74, 10, 10, 10], head: 'bottom' }, // MELCHIOR (bottom right)
  { r: [760, 184, 400, 222], cut: [10, 10, 74, 74], head: 'top' }, //     BALTHASAR (top)
  { r: [476, 628, 400, 222], cut: [10, 74, 10, 10], head: 'bottom' }, //  CASPER (bottom left)
];
const SQ3 = Math.sqrt(3);

function addHex(c: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
    if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
  }
  c.closePath();
}

export default class Magi extends Scene {
  L = new Layer2D();
  ground = makeHexGround(38);
  scan = makeScanPass(0.24);
  votes: Vote[] = [];
  log: LogRow[] = [];
  hats: number[] = [];
  T = { s: 0, e: 0, uni: 0 };
  mel = new Float32Array(64);

  override init() {
    const au = this.ctx.audio, s = this.ctx.start, e = this.ctx.end;
    this.T = { s, e, uni: barTime(au, 6) };
    const snares = au.events('snare', s - 0.1, e).map((x) => x[0]);
    const kicks = au.events('kick', s - 0.02, e).filter((k) => k[1] > 0.35);
    let n = 0;
    for (const [kt] of kicks) {
      if (kt >= this.T.uni - 0.03 && kt < this.T.uni + 0.03) continue;
      const clap = snares.some((st) => Math.abs(st - kt) < 0.05);
      const ok = kt >= this.T.uni ? true : !clap;
      this.votes.push({ t: kt, u: n % 3, ok });
      n++;
    }
    for (let u = 0; u < 3; u++) this.votes.push({ t: this.T.uni, u, ok: true, all: true });
    this.votes.sort((a, b) => a.t - b.t);
    // system log: a row per hat and per vote
    this.hats = au.events('hat', s - 2, e).map((h) => h[0]);
    const rows: LogRow[] = this.hats.map((ht, i) => ({ t: ht, kind: 'hat', text: `${(0x3f00 + i * 16).toString(16).toUpperCase()}  ${['SYNC', 'PARSE', 'QUERY', 'CACHE', 'LINK', 'EVAL'][i % 6]!.padEnd(6)}${hexData(i, 3, 6)} ${hexData(i, 9, 4)}` }));
    for (const v of this.votes) rows.push({ t: v.t, kind: 'vote', ok: v.ok, text: `${v.t.toFixed(2).padStart(6, '0')} ${UNITS[v.u]!.name.padEnd(12)}${v.ok ? 'APPROVE' : 'REJECT'}` });
    // pre-plate history so the log is full on the first frame
    for (let i = 0; i < 30; i++) rows.push({ t: s - 3 - i * 0.2, kind: 'hat', text: `${(0x3a00 + i * 16).toString(16).toUpperCase()}  BOOT  ${hexData(i, 77, 6)} ${hexData(i, 78, 4)}` });
    this.log = rows.sort((a, b) => a.t - b.t);
  }

  /** The unit's current vote (last one at or before t) or null. */
  state(u: number, t: number): Vote | null {
    let v: Vote | null = null;
    for (const x of this.votes) { if (x.t > t) break; if (x.u === u) v = x; }
    return v;
  }

  render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides {
    const { renderer, audio: au, comp } = this.ctx;
    const T = this.T, t = f.t, lt = t - T.s;
    const dk = duck(f, au);
    const clapHit = au.hit('snare', t, 0.1);
    const hatN = this.hats.filter((h) => h <= t).length;
    au.melFrame(t, this.mel);

    // ---- ground
    this.ground.u.t!.value = t; this.ground.u.k!.value = dk * 0.6 + f.a.kick * 0.4; this.ground.u.seed!.value = hatN; this.ground.u.a!.value = 0.055;
    this.ground.render(renderer, out);

    const L = this.L; L.clear();
    const c = L.ctx;
    // opening: panels flick on over the first beat (CRT power-on), group by group
    const on = (g: number) => {
      const p = (lt - g * 0.05) / 0.22;
      if (p >= 1) return 1;
      if (p <= 0) return 0;
      return hash(frameIdx(t), g) < p ? 1 : 0.15;
    };

    const states = [0, 1, 2].map((u) => this.state(u, t));
    const nOk = states.filter((s) => s?.ok).length, nNo = states.filter((s) => s && !s.ok).length;
    const unanimous = t >= T.uni;

    chrome(c, t, au, { no: '02', en: 'MAGI SYSTEM', jpText: 'マギ・システム 審議', sub: 'SUPERCOMPUTER DELIBERATION  //  3 UNITS ONLINE  //  第7世代有機コンピュータ', reveal: prog(lt, 0, 0.3, ease.outCubic), tick: `MAGI DELIBERATION IN PROGRESS // MELCHIOR·1 BALTHASAR·2 CASPER·3 // AUDIO QUERY: ${nervText(this.ctx.params).file} // 審議中 // PRIORITY AAA // GEHIRN LEGACY CODE 473` });

    // ================= centre: the MAGI diagram
    c.globalAlpha = on(0);
    panel(c, 424, 120, 1072, 782, { title: 'MAGI', jp: '三賢者', cut: 22 });
    // 提訴 (appeal) and 決議 (resolution) boxes
    const kbox = (x: number, y: number, w: number, kan: string, en: string, col: string, solid = false) => {
      chamferPath(c, x, y, w, 62, [0, 14, 0, 14]);
      c.fillStyle = solid ? col : 'rgba(0,0,0,0.6)'; c.fill();
      c.strokeStyle = col; c.lineWidth = 2; c.stroke();
      c.fillStyle = solid ? rgba('ink', 1) : col;
      c.font = jp(38, 800, true); c.textBaseline = 'middle'; c.textAlign = 'left';
      c.fillText(kan, x + 16, y + 33);
      c.font = font(F.mono(700), 13); c.letterSpacing = '3px';
      c.fillText(en, x + 108, y + 33); c.letterSpacing = '0px';
    };
    kbox(448, 170, 270, '提訴', 'APPEAL', rgba('orange', 1));
    meta(c, 452, 268, [['CODE', '473'], ['FILE', 'MAGI_SYS'], ['EXTENTION', '3023'], ['EX_MODE', 'OFF'], ['PRIORITY', 'AAA'], ['QUERY', `${String(this.votes.filter((v) => v.t <= t).length).padStart(3, '0')}`]], { size: 13, keyW: 104 });

    // resolution
    const resCol = unanimous || nOk >= 2 ? rgba('green', 1) : nNo >= 2 ? rgba('red', 1) : rgba('orange', 1);
    kbox(1202, 170, 270, '決議', 'RESOLUTION', rgba('orange', 1));
    {
      const x = 1202, y = 246, w = 270, h = 132;
      const lastVote = this.votes.filter((v) => v.t <= t).pop();
      const fl = lastVote ? pulse(t, lastVote.t, 0.09) : 0;
      chamferPath(c, x, y, w, h, [0, 0, 18, 0]);
      c.fillStyle = unanimous ? resCol : 'rgba(0,0,0,0.6)'; c.globalAlpha = on(0) * (unanimous ? 0.85 + 0.15 * fl : 1); c.fill(); c.globalAlpha = on(0);
      c.strokeStyle = resCol; c.lineWidth = 3; c.stroke();
      const kan = unanimous ? '可決' : nOk >= 2 ? '承認' : nNo >= 2 ? '否決' : '審議中';
      const en = unanimous ? 'PASSED  UNANIMOUS' : nOk >= 2 ? 'APPROVED  2/3' : nNo >= 2 ? 'REJECTED  2/3' : 'DELIBERATING';
      c.fillStyle = unanimous ? rgba('ink', 1) : resCol;
      c.font = jp(kan.length > 2 ? 54 : 70, 800, true); c.textAlign = 'center'; c.textBaseline = 'middle';
      c.globalAlpha = on(0) * (unanimous ? 1 : 0.75 + 0.25 * (1 - fl));
      c.fillText(kan, x + w / 2, y + 58);
      c.globalAlpha = on(0);
      c.font = font(F.mono(700), 13); c.letterSpacing = '3px';
      c.fillText(en, x + w / 2, y + 112); c.letterSpacing = '0px'; c.textAlign = 'left';
    }

    // connecting bars (behind the blocks), with data packets running along them
    const bars: [number, number, number, number][] = [[800, 370, 846, 666], [1120, 370, 1074, 666], [876, 740, 1044, 740]];
    c.lineCap = 'butt';
    bars.forEach(([x0, y0, x1, y1], i) => {
      c.strokeStyle = rgba('orange', 0.9); c.lineWidth = 16;
      c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
      c.strokeStyle = rgba('ink', 1); c.lineWidth = 6;
      c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
      for (let k = 0; k < 3; k++) {
        const ph = (t * 1.1 + k / 3 + i * 0.21) % 1, dir = i === 1 ? 1 - ph : ph;
        c.fillStyle = rgba('amber', 0.9 * (0.5 + 0.5 * dk));
        c.fillRect(x0 + (x1 - x0) * dir - 3, y0 + (y1 - y0) * dir - 3, 6, 6);
      }
    });

    // centre label
    const mg = 1 + 0.02 * dk;
    c.save(); c.translate(960, 560); c.scale(mg, mg);
    condensed(c, 'MAGI', 0, 38, 150, { sx: 0.6, color: rgba('orange', 1), align: 'center', bold: 0.03 });
    c.restore();
    evaLabel(c, 960, 626, 'supercomputer system', undefined, { align: 'center', alpha: 0.85 });
    c.font = jp(15, 600, false); c.fillStyle = rgba('orange', 0.85); c.textAlign = 'center';
    c.fillText('人格移植OS  三系統合議制', 960, 650); c.textAlign = 'left';

    // the three processors
    for (let u = 0; u < 3; u++) this.block(c, u, t, states[u] ?? null, dk, on(1 + u));
    c.globalAlpha = 1;

    // ================= input routing spectrum (bottom centre)
    c.globalAlpha = on(4);
    const sp = panel(c, 424, 916, 1072, 100, { title: 'INPUT ROUTING', jp: '入力分配', header: 24, cut: 14 });
    {
      const n = 64, gx = sp.x + 190, gw = sp.w - 190, bw = gw / n, bh = sp.h - 14, segs = 10;
      meta(c, sp.x + 4, sp.y + 14, [['MEL', '64 BANDS'], ['SPAN', '30–16K HZ'], ['GAIN', `${(-6 + 12 * f.a.rms).toFixed(1)} DB`]], { size: 11, lead: 17, keyW: 48 });
      for (let b = 0; b < n; b++) {
        const e = smoothstep(0.3, 1, this.mel[b]!), u = b <= 20 ? 0 : b <= 42 ? 1 : 2;
        const st = states[u];
        const col = st ? (st.ok ? rgba('green', 1) : rgba('red', 1)) : rgba('orange', 1);
        const lit = e * segs;
        for (let s = 0; s < segs; s++) {
          const y = sp.y + bh - (s + 1) * (bh / segs);
          c.fillStyle = s < lit ? (s >= segs - 2 ? rgba('amber', 1) : col) : rgba('orange', 0.08);
          c.fillRect(gx + b * bw + 1, y + 1, bw - 2, bh / segs - 2);
        }
      }
      // zone brackets
      [[0, 20], [21, 42], [43, 63]].forEach(([a, b], i) => {
        const x0 = gx + a! * bw, x1 = gx + (b! + 1) * bw;
        c.fillStyle = rgba('orange', 0.8); c.fillRect(x0 + 2, sp.y + bh + 3, x1 - x0 - 4, 2);
        c.font = font(F.mono(600), 10); c.letterSpacing = '1.5px'; c.textAlign = 'center';
        c.fillText(`${UNITS[i]!.name}  ${UNITS[i]!.range}`, (x0 + x1) / 2, sp.y + bh + 16);
        c.letterSpacing = '0px'; c.textAlign = 'left';
      });
    }

    // ================= left column: system log + input scope
    c.globalAlpha = on(5);
    const lg = panel(c, 56, 120, 344, 590, { title: 'SYSTEM LOG', jp: '処理記録', cut: 16 });
    {
      const rows = this.log.filter((r) => r.t <= t);
      const N = 27, lead = 19.5;
      const vis = rows.slice(-N);
      c.font = font(F.mono(500), 12.5); c.textBaseline = 'alphabetic';
      vis.forEach((r, i) => {
        const y = lg.y + 14 + i * lead;
        const newest = i === vis.length - 1;
        const age = t - r.t;
        let txt = r.text;
        if (newest) txt = txt.slice(0, Math.max(1, Math.floor(clamp(age / 0.08) * txt.length)));
        if (r.kind === 'vote') {
          const col = r.ok ? 'green' : 'red';
          if (age < 0.12) { c.fillStyle = rgba(col, 0.85); c.fillRect(lg.x - 2, y - 13, lg.w + 4, 17); c.fillStyle = rgba('ink', 1); }
          else c.fillStyle = rgba(col, 0.95);
        } else c.fillStyle = rgba('orange', 0.35 + 0.55 * (i / N));
        c.fillText(txt, lg.x + 2, y);
      });
      if (((t * 3) % 1) < 0.6) { c.fillStyle = rgba('orange', 0.9); c.fillRect(lg.x + 2, lg.y + 14 + Math.min(vis.length, N) * lead - 12, 9, 14); }
    }
    const sc = panel(c, 56, 726, 344, 290, { title: 'INPUT SIGNAL', jp: '入力信号', cut: 16 });
    {
      const x = sc.x, y = sc.y, w = sc.w, h = sc.h - 38, cy = y + h / 2;
      // graticule
      c.strokeStyle = rgba('orange', 0.16); c.lineWidth = 1;
      c.beginPath();
      for (let i = 0; i <= 8; i++) { c.moveTo(x + (w * i) / 8, y); c.lineTo(x + (w * i) / 8, y + h); }
      for (let i = 0; i <= 4; i++) { c.moveTo(x, y + (h * i) / 4); c.lineTo(x + w, y + (h * i) / 4); }
      c.stroke();
      c.strokeStyle = rgba('orange', 0.4); c.beginPath(); c.moveTo(x, cy); c.lineTo(x + w, cy); c.stroke();
      // trace: 60 ms of the real waveform, triggered on a rising zero crossing
      const win = 0.06, rate = au.waveRate;
      let t0 = t - win;
      const smp: [number, number] = [0, 0];
      for (let k = 0; k < 220; k++) {
        const ta = t0 - k / rate, a0 = au.waveAt(ta, smp)[0], a1 = au.waveAt(ta + 1 / rate, smp)[0];
        if (a0 <= 0 && a1 > 0) { t0 = ta; break; }
      }
      c.strokeStyle = rgba('amber', 1); c.lineWidth = 1.6; c.beginPath();
      for (let i = 0; i <= 300; i++) {
        const v = au.waveAt(t0 + (win * i) / 300, smp);
        const px = x + (w * i) / 300, py = cy - (v[0] + v[1]) * 0.5 * h * 0.62;
        if (i) c.lineTo(px, py); else c.moveTo(px, py);
      }
      c.stroke();
      meta(c, x, y + h + 24, [['RMS', `${(20 * Math.log10(Math.max(1e-3, f.a.rms))).toFixed(1)} DB   PEAK ${(f.a.rms * 1.41).toFixed(2)}`]], { size: 11, keyW: 36 });
    }

    // ================= right column: tally, load, deliberation
    c.globalAlpha = on(6);
    const tl = panel(c, 1520, 120, 344, 360, { title: 'VOTE TALLY', jp: '投票集計', cut: 16 });
    {
      const past = this.votes.filter((v) => v.t <= t);
      for (let u = 0; u < 3; u++) {
        const y = tl.y + 10 + u * 74;
        const st = states[u];
        const col = st ? (st.ok ? rgba('green', 1) : rgba('red', 1)) : rgba('orange', 1);
        c.fillStyle = rgba('orange', 1); c.font = font(F.mono(700), 14); c.letterSpacing = '2px';
        c.fillText(UNITS[u]!.name, tl.x, y + 12); c.letterSpacing = '0px';
        c.font = jp(13, 600, false); c.fillStyle = rgba('orange', 0.7); c.fillText(UNITS[u]!.jp, tl.x + 150, y + 12);
        // state chip
        chamferPath(c, tl.x + tl.w - 70, y - 2, 70, 20, [0, 6, 0, 6]); c.fillStyle = col; c.fill();
        c.fillStyle = rgba('ink', 1); c.font = jp(13, 800, false); c.textAlign = 'center';
        c.fillText(st ? (st.ok ? '承認' : '否決') : '待機', tl.x + tl.w - 35, y + 13); c.textAlign = 'left';
        // history of this unit's last 16 votes
        const hist = past.filter((v) => v.u === u).slice(-16);
        for (let i = 0; i < 16; i++) {
          const v = hist[i];
          c.fillStyle = v ? (v.ok ? rgba('green', 0.9) : rgba('red', 0.9)) : rgba('orange', 0.1);
          c.fillRect(tl.x + i * 20, y + 26, 16, 16);
        }
        c.fillStyle = rgba('orange', 0.3); c.fillRect(tl.x, y + 56, tl.w, 1);
      }
      const nA = past.filter((v) => v.ok).length, nR = past.length - nA;
      const y = tl.y + 238;
      c.fillStyle = rgba('green', 1); c.font = jp(16, 800, false); c.fillText('承認', tl.x, y + 18);
      c.font = font(F.mono(600), 11); c.letterSpacing = '2px'; c.fillText('APPROVE', tl.x, y + 36); c.letterSpacing = '0px';
      sevenSeg(c, String(nA).padStart(2, '0'), tl.x + 78, y, 44, rgba('green', 1), rgba('green', 0.07));
      c.fillStyle = rgba('red', 1); c.font = jp(16, 800, false); c.fillText('否決', tl.x + 172, y + 18);
      c.font = font(F.mono(600), 11); c.letterSpacing = '2px'; c.fillText('REJECT', tl.x + 172, y + 36); c.letterSpacing = '0px';
      sevenSeg(c, String(nR).padStart(2, '0'), tl.x + 248, y, 44, rgba('red', 1), rgba('red', 0.07));
    }
    const ld = panel(c, 1520, 496, 344, 280, { title: 'PROCESSOR LOAD', jp: '演算負荷', cut: 16 });
    {
      for (let u = 0; u < 3; u++) {
        const [b0, b1] = UNITS[u]!.band;
        let s = 0; for (let b = b0; b <= b1; b++) s += this.mel[b]!;
        const v = clamp(smoothstep(0.25, 0.95, s / (b1 - b0 + 1)) * (0.85 + 0.25 * dk));
        const x = ld.x + 14 + u * 110;
        segMeter(c, x, ld.y + 4, 46, ld.h - 58, 16, v, { vertical: true, hotFrom: 0.85 });
        sevenSeg(c, String(Math.round(v * 99)).padStart(2, '0'), x + 54, ld.y + ld.h - 90, 30, rgba('amber', 1), rgba('orange', 0.07), { thick: 3.6 });
        c.fillStyle = rgba('orange', 1); c.font = font(F.mono(700), 12); c.letterSpacing = '1.5px';
        c.fillText(['MEL-1', 'BAL-2', 'CAS-3'][u]!, x, ld.y + ld.h - 34); c.letterSpacing = '0px';
        c.font = font(F.mono(500), 10); c.fillStyle = rgba('orange', 0.6); c.fillText('%LOAD', x + 54, ld.y + ld.h - 100);
      }
    }
    const dl = panel(c, 1520, 792, 344, 224, { title: 'DELIBERATION', jp: '審議', cut: 16, color: unanimous ? rgba('green', 1) : undefined });
    {
      const rem = Math.max(0, T.uni - t);
      const col = unanimous ? rgba('green', 1) : rgba('orange', 1);
      c.fillStyle = col; c.font = font(F.mono(600), 11); c.letterSpacing = '2px';
      c.fillText(unanimous ? 'RESOLUTION LOCKED' : 'TIME TO RESOLUTION', dl.x, dl.y + 12); c.letterSpacing = '0px';
      c.font = jp(13, 600, false); c.fillText(unanimous ? '決議確定' : '決議まで', dl.x + 200, dl.y + 12);
      const ss = Math.floor(rem), cs = Math.floor((rem - ss) * 100);
      sevenSeg(c, `${String(ss).padStart(2, '0')}:${String(cs).padStart(2, '0')}`, dl.x, dl.y + 26, 58, col, rgba('orange', 0.07), { glow: unanimous ? 0 : 0 });
      segMeter(c, dl.x, dl.y + 100, dl.w, 14, 30, clamp((t - T.s) / (T.uni - T.s)), { color: col, hotFrom: 2 });
      const status = unanimous ? '全会一致  UNANIMOUS' : ((t * 2.2) % 1 < 0.7 ? '審議中  DELIBERATING' : '');
      c.fillStyle = col; c.font = jp(18, 800, false); c.fillText(status, dl.x, dl.y + 150);
    }
    c.globalAlpha = 1;

    comp.draw(renderer, L.upload(), out);
    this.scan.u.t!.value = t;
    this.scan.render(renderer, out);

    const k0 = lt; // drum entry impact
    return {
      bloom: 0.6, bloomThreshold: 0.62, halation: 0.08, vignette: 0.42, grain: 0.05,
      ca: 0.8 + 2.2 * clapHit + 3 * Math.exp(-k0 / 0.12) + (unanimous ? 2.5 * pulse(t, T.uni, 0.12) : 0),
      flash: 0.45 * Math.exp(-k0 / 0.09) + (unanimous ? 0.3 * pulse(t, T.uni, 0.08) : 0),
      zoom: 1 + 0.035 * Math.exp(-k0 / 0.15) + 0.004 * dk,
    };
  }

  /** One MAGI processor: chamfered block, name strip, hex-cell spectrum of its band, the vote. */
  block(c: CanvasRenderingContext2D, u: number, t: number, st: Vote | null, dk: number, alpha: number) {
    const au = this.ctx.audio;
    const { r: [x, y, w, h], cut, head } = BLK[u]!;
    const U = UNITS[u]!;
    const colKey = st ? (st.ok ? 'green' : 'red') : 'orange';
    const col = rgba(colKey, 1);
    const fl = st ? pulse(t, st.t, st.all ? 0.35 : 0.14) : 0;
    const fillA = st ? 0.16 + 0.8 * fl : 0;
    const solid = fillA > 0.5;
    c.save();
    c.globalAlpha = alpha;
    // body
    chamferPath(c, x, y, w, h, cut);
    c.fillStyle = 'rgba(8,5,2,0.92)'; c.fill();
    if (fillA > 0) { c.fillStyle = rgba(colKey, fillA); c.fill(); }
    c.save(); c.clip();
    // name strip
    const hh = 30, sy = head === 'top' ? y : y + h - hh;
    c.fillStyle = col; c.fillRect(x, sy, w, hh);
    c.fillStyle = rgba('ink', 1); c.font = font(F.mono(700), 16); c.letterSpacing = '3px'; c.textBaseline = 'middle';
    const nx = head === 'top' ? x + 16 : u === 0 ? x + 16 : x + 16;
    c.fillText(U.name, nx, sy + hh / 2 + 1); c.letterSpacing = '0px';
    c.font = jp(14, 700, false); c.textAlign = 'right';
    c.fillText(U.jp, x + w - 14, sy + hh / 2 + 1); c.textAlign = 'left';
    // hex spectrum
    const by = head === 'top' ? y + hh + 4 : y + 4, bh = h - hh - 8;
    const r = 11.5, dx = SQ3 * r, dy = 1.5 * r;
    const cols = Math.floor((w - 16) / dx), rows = Math.floor((bh - r) / dy) + 1;
    const [b0, b1] = U.band;
    const lit = new Path2D(), dim = new Path2D(), top = new Path2D();
    for (let ci = 0; ci < cols; ci++) {
      const band = b0 + ((b1 - b0) * ci) / (cols - 1);
      const e = smoothstep(0.3, 1, au.mel(t, band)) * (0.9 + 0.2 * dk);
      const lvl = e * rows;
      for (let ri = 0; ri < rows; ri++) {
        const cx = x + 8 + dx / 2 + ci * dx + (ri % 2 ? dx / 2 : 0);
        if (cx > x + w - 8) continue;
        const cy = by + bh - r - ri * dy;
        const p = ri < Math.floor(lvl) ? lit : ri < lvl ? top : dim;
        const pr = p === dim ? r - 3 : r - 2;
        // Path2D has no closePath-safe helper beyond the same calls:
        for (let i = 0; i < 6; i++) {
          const a = Math.PI / 6 + (i * Math.PI) / 3, px = cx + pr * Math.cos(a), py = cy + pr * Math.sin(a);
          if (i === 0) p.moveTo(px, py); else p.lineTo(px, py);
        }
        p.closePath();
      }
    }
    if (solid) {
      c.fillStyle = rgba('ink', 0.55); c.fill(lit); c.fillStyle = rgba('ink', 0.8); c.fill(top);
    } else {
      c.fillStyle = rgba(colKey, 0.08); c.fill(dim);
      c.fillStyle = rgba(colKey, 0.78); c.fill(lit);
      c.fillStyle = rgba(st ? colKey : 'amber', 1); c.fill(top);
    }
    c.restore();
    chamferPath(c, x, y, w, h, cut);
    c.strokeStyle = col; c.lineWidth = 3; c.stroke();
    // the vote: big kanji in a knocked-out plate at the block centre
    if (st) {
      const kan = st.ok ? '承認' : '否決';
      const kx = x + w / 2, ky = (head === 'top' ? y + hh + (h - hh) / 2 : y + (h - hh) / 2) + 2;
      const pw = 208, ph = 96;
      chamferPath(c, kx - pw / 2, ky - ph / 2, pw, ph, 12);
      c.fillStyle = solid ? col : 'rgba(5,4,3,0.88)'; c.fill();
      c.strokeStyle = col; c.lineWidth = 2; c.stroke();
      c.fillStyle = solid ? rgba('ink', 1) : col;
      c.font = jp(74, 800, true); c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(kan, kx, ky + 4);
      c.textAlign = 'left';
    }
    c.restore();
    void addHex;
  }
}

void W; void H;
