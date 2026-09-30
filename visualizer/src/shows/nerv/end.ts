// Ported from bizarro/evangelion app/src/scenes/end.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// end — "END" (outro, pads to silence, bar 96 = 177.62 s → the song's end, 184.4 s).
// The bookend of `boot`. Bar 96: the terminal shuts down (the boot screen in reverse): shutdown
// lines type out on the hats, a green PSYCHOGRAPH monitor sweeps once per bar over the previous
// sweep (the impact's loud last bar still on the phosphor) while the real channels die, vital
// readouts settle. Bar 97: hard cut to the credits card (the boot title card mirrored, hard right).
// Bar 98: 終劇. Under both cards the pilot's psychograph keeps sweeping: the pads fade, the last
// vocal chops are the last blips, then it flatlines and the numbers read zero. CRT power-off: the
// frame collapses to a line, then a dot, then black.
//
// Audio mapping:
//  - PSYCHOGRAPH CH1 / card strip: the raw waveform (min/max per column, soft-compressed)
//  - CH2 pads: env('other') × mel-band-30 wiggle; CH3 rhythm: env('drums') × band 4; CH4 Angel:
//    env('vocal') × band 46 (cyan). A channel reads SIGNAL LOST when its smoothed envelope is gone.
//  - shutdown lines trigger on the hat onsets; the terminal cursor blinks on the grid
//  - SYNC RATIO = 400 × smoothed rms, PULSE = 133 × smoothed drums, meters = pads / bass / drums
//  - ACTIVITY LIMIT 7-seg = time left in the song (the battery countdown, reaching 00:00.00)
import * as THREE from 'three';
import { Scene, type Frame, type PostOverrides } from '../../show/scene.ts';
import { Layer2D, clearRT } from '../../show/gl.ts';
import { rgba } from '../../show/palette.ts';
import { F, font } from '../../show/type.ts';
import { clamp, ease, frameIdx, hash, prog, pulse } from '../../show/util.ts';
import { barTime, condensed, evaLabel, hexPath, jp, makeScanPass, panel, segMeter, sevenSeg, W, H } from './_eva.ts';
import { fitCondensedSize, nervText, unitName } from './show-text.ts';
import { graticule, makeCrtLine, segW, smoothEnv, sweepTrace } from './end-kit.ts';

const LINES = [
  'PATTERN ANALYSIS ......... OFFLINE',
  'NEURAL INTERFACE ......... RELEASED',
  'A10 NERVE CLIP ........... OPEN',
  'MAGI LINK  CASPER-3 ...... OFFLINE',
  'MAGI LINK  BALTHASAR-2 ... OFFLINE',
  'MAGI LINK  MELCHIOR-1 .... OFFLINE',
  'AUDIO CHANNEL  133.33 BPM  END',
  'CENTRAL DOGMA ACCESS ..... SEALED',
  'NERV OS  REV 3.11 ........ HALT',
];

type Ch = { en: string; jp: string; stem: string; band: number; col: 'green' | 'cyan'; gain: number };
/** SYNC RATIO from the smoothed rms: 400 % at full level, exactly 0 once the pads are gone. */
const settle = (rms: number) => 400 * clamp((rms - 0.03) / 0.97);

const CHS: Ch[] = [
  { en: 'CH1  PILOT 01  SIGNAL', jp: '神経接続', stem: 'rms', band: 0, col: 'green', gain: 0.95 },
  { en: 'CH2  PILOT 02  HARMONIC', jp: '同調波形', stem: 'other', band: 30, col: 'green', gain: 1.3 },
  { en: 'CH3  PILOT 03  RHYTHM', jp: '心拍', stem: 'drums', band: 4, col: 'green', gain: 1.3 },
  { en: 'CH4  TARGET  PATTERN', jp: '使徒反応', stem: 'vocal', band: 46, col: 'cyan', gain: 1.5 },
];

export default class End extends Scene {
  L = new Layer2D();
  scan = makeScanPass(0.24);
  crt = makeCrtLine();
  T = { s: 0, e: 0, card1: 0, card2: 0, off: 0, zero: 0, lines: [] as number[] };
  // AAAVS: track title / artist from the show params (upstream: its own song)
  tx = nervText(this.ctx.params);

  override init() {
    const au = this.ctx.audio, s = this.ctx.start, e = this.ctx.end;
    const card1 = barTime(au, 97), card2 = barTime(au, 98);
    // shutdown lines: the first on the cut, then one per hat; any left over fill the rest of the bar
    const hats = au.events('hat', s + 0.08, card1 - 0.25).map((h) => h[0]);
    const lines = [s + 0.04, ...hats].slice(0, LINES.length);
    const last = lines[lines.length - 1]!, left = LINES.length - lines.length;
    for (let i = 1; i <= left; i++) lines.push(last + ((card1 - 0.42 - last) * i) / left);
    const off = Math.min(e, au.duration) - 0.49;
    // the countdowns reach 00:00.00 a beat before the power-off
    this.T = { s, e, card1, card2, off, zero: off - 0.12, lines };
  }

  render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides {
    const { renderer, audio: au, comp } = this.ctx;
    const T = this.T, t = f.t;
    clearRT(renderer, out, [0.0015, 0.0012, 0.001]);
    const L = this.L; L.clear();
    const c = L.ctx;
    const phase = t < T.card1 ? 0 : t < T.card2 ? 1 : 2;
    const songEnd = au.duration;

    if (phase === 0) this.shutdown(c, f);
    else {
      if (phase === 1) this.creditCard(c, t);
      else this.endCard(c, t);
      this.strip(c, t);
    }

    // CRT power-off: squash to a line, then to a dot, then black
    const p1 = prog(t, T.off, T.off + 0.14, ease.inCubic);
    const p2 = prog(t, T.off + 0.14, T.off + 0.27, ease.inCubic);
    const p3 = prog(t, T.off + 0.27, T.off + 0.4, ease.outCubic);
    const sy = 1 - 0.997 * p1, sx = 1 - 0.994 * p2;
    if (p2 < 1) comp.draw(renderer, L.upload(), out, { scale: [1 / sx, 1 / sy], tint: [1 + 2 * p1, 1 + 2 * p1, 1 + 2 * p1], opacity: 1 - p2 });
    if (p1 > 0 && p3 < 1) {
      (this.crt.u.lineHalf!.value as THREE.Vector2).set(Math.max(1.5, 960 * sx), Math.min(2.5, Math.max(0.6, 540 * sy)));
      this.crt.u.lineGain!.value = prog(p1, 0.55, 1, ease.inQuad) * (1 - p3);
      this.crt.render(renderer, out);
    }
    this.scan.u.t!.value = t;
    this.scan.render(renderer, out);

    const cut = phase === 1 ? pulse(t, T.card1, 0.07) : phase === 2 ? pulse(t, T.card2, 0.07) : 0;
    const open = Math.exp(-Math.max(0, t - T.s) / 0.08);
    const gone = t >= T.off + 0.4 || t >= songEnd - 0.02;
    return {
      bloom: 0.55, bloomThreshold: 0.68, halation: 0.1, vignette: 0.45, grain: gone ? 0 : 0.05,
      ca: 1.0 + 2.5 * cut + 2 * open, flash: 0.32 * cut,
      fade: gone ? 1 : 0,
    };
  }

  /** Bar 96: the boot screen in reverse (terminal shutdown + psychograph + vital readouts). */
  shutdown(c: CanvasRenderingContext2D, f: Frame) {
    const au = this.ctx.audio, T = this.T, t = f.t, lt = t - T.s;
    // CRT flicker-on over the first frames, group by group (the impact wall ended in black)
    const on = (g: number) => {
      const p = (lt - g * 0.04) / 0.18;
      if (p >= 1) return 1;
      if (p <= 0) return 0;
      return hash(frameIdx(t), g, 11) < p ? 1 : 0.12;
    };
    // ---- header (mirror of boot's SYSTEM START)
    c.globalAlpha = on(0);
    c.fillStyle = rgba('orange', 1); c.fillRect(120, 120, 1680, 3);
    evaLabel(c, 120, 106, 'system shutdown  //  end of operation');
    c.font = jp(20, 700, false); c.fillStyle = rgba('orange', 1); c.textAlign = 'right';
    c.fillText('システム停止  作戦終了', 1800, 108); c.textAlign = 'left';
    for (let x = 120; x <= 1800; x += 24) c.fillRect(x, 123, 1, (x - 120) % 120 === 0 ? 8 : 4);

    // ---- terminal: shutdown lines type out on the hats
    c.globalAlpha = on(1);
    {
      const x = 120, y0 = 186;
      c.font = font(F.mono(500), 20);
      c.textBaseline = 'alphabetic';
      let cursorAt: [number, number] | null = null;
      LINES.forEach((ln, i) => {
        const t0 = T.lines[i]!;
        const n = Math.floor(clamp((t - t0) / 0.14) * ln.length);
        if (n <= 0) return;
        const y = y0 + i * 34;
        const s = ln.slice(0, n);
        const cutAt = ln.lastIndexOf(' ') + 1;
        c.fillStyle = rgba('orange', 0.92);
        if (n === ln.length) {
          c.fillText(ln.slice(0, cutAt), x, y);
          const fl = pulse(t, t0 + 0.14, 0.08);
          c.fillStyle = rgba('red', 0.95);
          const wx = x + c.measureText(ln.slice(0, cutAt)).width;
          if (fl > 0.05) { c.globalAlpha = on(1) * fl; c.fillRect(wx - 3, y - 19, c.measureText(ln.slice(cutAt)).width + 6, 24); c.globalAlpha = on(1); c.fillStyle = fl > 0.5 ? rgba('ink', 1) : rgba('red', 0.95); }
          c.fillText(ln.slice(cutAt), wx, y);
        } else { c.fillText(s, x, y); cursorAt = [x + c.measureText(s).width + 2, y]; }
        if (i === LINES.length - 1 && n === ln.length) cursorAt = [x, y + 34];
      });
      const ca = cursorAt as [number, number] | null;
      if (ca && ((t * 3) % 1) < 0.6) { c.fillStyle = rgba('orange', 0.9); c.fillRect(ca[0], ca[1] - 18, 11, 22); }
    }

    // ---- vital signs: numbers settling to zero
    c.globalAlpha = on(2);
    const vp = panel(c, 120, 520, 520, 446, { title: 'VITAL SIGNS', jp: '生体反応', cut: 16 });
    this.vitals(c, t, vp);

    // ---- the psychograph: 4 channels sweeping once per bar
    c.globalAlpha = on(3);
    const pp = panel(c, 680, 164, 1120, 802, { title: 'PSYCHOGRAPH', jp: '心理グラフ', cut: 20, color: rgba('green', 1) });
    {
      // header-right: channel status hexes (lit while that channel still carries signal)
      const live = CHS.map((ch) => smoothEnv(au, ch.stem, t, 0.5) > (ch.stem === 'vocal' ? 0.05 : 0.02));
      c.font = font(F.mono(600), 12); c.letterSpacing = '2px'; c.textAlign = 'right'; c.textBaseline = 'middle';
      c.fillStyle = rgba('green', 0.85);
      c.fillText(`SWEEP 1 BAR  1.80 S/DIV  //  ${live.filter(Boolean).length}/4 LIVE`, 1790 - 4 * 26 - 12, 180);
      c.letterSpacing = '0px'; c.textAlign = 'left';
      CHS.forEach((ch, i) => {
        hexPath(c, 1790 - (3 - i) * 26 - 10, 180, 10.5);
        c.fillStyle = live[i] ? rgba(ch.col, 0.9) : rgba('red', 0.25 + 0.6 * ((t * 2.5) % 1 < 0.5 ? 1 : 0));
        c.fill();
      });
      const x = pp.x + 8, w = pp.w - 16, top = pp.y + 4, chH = (pp.h - 8) / 4;
      const t0 = barTime(au, 96), period = barTime(au, 97) - t0;
      CHS.forEach((ch, i) => {
        const y = top + i * chH, gy = y + 30, gh = chH - 44;
        graticule(c, x, gy, w, gh, ch.col, 1, 16);
        // label strip
        c.fillStyle = rgba(ch.col, 1); c.font = font(F.mono(700), 13); c.letterSpacing = '2.4px'; c.textBaseline = 'alphabetic';
        c.fillText(ch.en, x, y + 20);
        const tw = c.measureText(ch.en).width; c.letterSpacing = '0px';
        c.font = jp(14, 700, false); c.fillText(ch.jp, x + tw + 12, y + 20);
        const sm = smoothEnv(au, ch.stem, t, 0.5);
        const dead = sm < (ch.stem === 'vocal' ? 0.05 : 0.02);
        const r = sweepTrace(c, au, t, ch.stem === 'rms'
          ? { x, y: gy, w, h: gh, t0, period, kind: 'wave', color: ch.col, gain: ch.gain, k: 0.6, lw: 1.3 }
          : { x, y: gy, w, h: gh, t0, period, kind: 'line', color: ch.col, gain: ch.gain, lw: 1.8, sample: (tc) => au.env(ch.stem, tc) * (au.mel(tc, ch.band) - 0.45) * 1.6 });
        // readout right
        c.font = font(F.mono(600), 12); c.letterSpacing = '1.5px'; c.textAlign = 'right';
        if (dead && ch.stem !== 'vocal') {
          const bl = (t * 3) % 1 < 0.62;
          c.fillStyle = rgba('red', bl ? 1 : 0.35);
          c.fillText('SIGNAL LOST  信号途絶', x + w, y + 20);
        } else if (dead) {
          c.fillStyle = rgba('cyan', 0.7); c.fillText('NO PATTERN  反応なし', x + w, y + 20);
        } else {
          c.fillStyle = rgba(ch.col, 0.9);
          c.fillText(`AMP ${(sm * (ch.stem === 'rms' ? 1 : 1)).toFixed(3)}  PK ${r.headV.toFixed(2)}`, x + w, y + 20);
        }
        c.letterSpacing = '0px'; c.textAlign = 'left';
      });
    }
    // bottom rule + ticker-like status (mirror of boot)
    c.globalAlpha = on(4);
    c.fillStyle = rgba('orange', 0.6); c.fillRect(120, 1012, 1680, 1);
    c.font = font(F.mono(600), 13); c.letterSpacing = '2px'; c.fillStyle = rgba('orange', 0.7);
    c.fillText(`${this.tx.title} // AUDIO CHANNEL CLOSING // PILOTS RECOVERED // EVA-01 RETURNED TO CAGE // 作戦終了`, 124, 1000);
    c.letterSpacing = '0px';
    c.globalAlpha = 1;
  }

  /** The settling readouts in the VITAL SIGNS panel. */
  vitals(c: CanvasRenderingContext2D, t: number, r: { x: number; y: number; w: number; h: number }) {
    const au = this.ctx.audio;
    const rms = smoothEnv(au, 'rms', t, 0.7), drums = smoothEnv(au, 'drums', t, 0.7);
    const sync = settle(rms), bpm = Math.round(au.bpm * clamp((drums - 0.01) * 1.3));
    // SYNC RATIO
    c.fillStyle = rgba('orange', 1); c.font = font(F.mono(700), 13); c.letterSpacing = '2.4px'; c.textBaseline = 'alphabetic';
    c.fillText('SYNC RATIO', r.x + 4, r.y + 16); c.letterSpacing = '0px';
    c.font = jp(14, 700, false); c.fillText('同調率', r.x + 130, r.y + 16);
    const sv = sync.toFixed(1).padStart(5, '0');
    const nw = condensed(c, sv, r.x + 2, r.y + 124, 128, { sx: 0.62, color: rgba('amber', 1) });
    condensed(c, '%', r.x + 8 + nw, r.y + 124, 64, { sx: 0.62, color: rgba('amber', 0.8) });
    // PULSE (7-seg) + PADS / BASS / DRUMS meters
    const py = r.y + 150;
    c.fillStyle = rgba('green', 1); c.font = font(F.mono(700), 13); c.letterSpacing = '2.4px';
    c.fillText('PULSE', r.x + 4, py + 12); c.letterSpacing = '0px';
    c.font = jp(14, 700, false); c.fillText('心拍数', r.x + 66, py + 12);
    sevenSeg(c, String(bpm).padStart(3, '0'), r.x + 4, py + 24, 50, rgba('green', 1), rgba('green', 0.07));
    c.font = font(F.mono(500), 11); c.fillStyle = rgba('green', 0.7); c.fillText('BPM', r.x + 4 + segW('000', 50) + 6, py + 72);
    const mx = r.x + 196, mw = r.w - 200;
    ([['PADS', 'other', '和音'], ['BASS', 'bass', '低音'], ['DRUMS', 'drums', '打楽器']] as const).forEach(([en, stem, j], i) => {
      const y = py + 4 + i * 28;
      const v = clamp(smoothEnv(au, stem, t, 0.4) * 1.1);
      c.fillStyle = rgba('orange', 0.9); c.font = font(F.mono(600), 11); c.letterSpacing = '1.5px';
      c.fillText(en, mx, y + 12); c.letterSpacing = '0px';
      c.font = jp(11, 600, false); c.fillText(j, mx + 50, y + 12);
      // segMeter sets globalAlpha itself: skip it while the panel flickers on, restore after
      const ga = c.globalAlpha;
      if (ga > 0.5) segMeter(c, mx + 96, y + 1, mw - 96, 14, 18, v, { hotFrom: 0.85 });
      c.globalAlpha = ga;
    });
    // ACTIVITY LIMIT countdown: the time left in the song
    const ay = r.y + 262;
    c.fillStyle = rgba('orange', 0.5); c.fillRect(r.x, ay - 12, r.w, 1);
    const rem = Math.max(0, this.T.zero - t);
    const ss = Math.floor(rem), cs = Math.floor((rem - ss) * 100);
    const low = rem < 3;
    const col = low ? rgba('red', 1) : rgba('orange', 1);
    c.fillStyle = col; c.font = jp(22, 800, false); c.fillText('活動限界まで', r.x + 4, ay + 22);
    c.font = font(F.mono(700), 12); c.letterSpacing = '2.4px'; c.fillText('ACTIVITY LIMIT  INTERNAL', r.x + 4, ay + 44); c.letterSpacing = '0px';
    sevenSeg(c, `00:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`, r.x + 4, ay + 60, 76, col, rgba('orange', 0.07));
  }

  /** Bar 97: the credits card, the boot title card mirrored (hard right). */
  creditCard(c: CanvasRenderingContext2D, t: number) {
    const bone = rgba('bone', 1);
    c.globalAlpha = clamp((t - this.T.card1) / 0.05);
    condensed(c, "EPISODE:26'", 1770, 230, 64, { sx: 0.62, color: bone, align: 'right' });
    c.font = jp(30, 600, true); c.fillStyle = bone; c.textAlign = 'left';
    c.fillText('まごころを、君に', 150, 230);
    condensed(c, 'MUSIC', 1770, 420, 150, { sx: 0.56, color: bone, align: 'right' });
    condensed(c, this.tx.artist, 1776, 680, fitCondensedSize(c, this.tx.artist, 300, 0.56, 1620), { sx: 0.56, color: bone, align: 'right' });
    const q = `“${this.tx.title}”`;
    condensed(c, q, 1770, 800, fitCondensedSize(c, q, 96, 0.6, 1000), { sx: 0.6, color: bone, align: 'right' });
    c.font = jp(46, 700, true); c.textAlign = 'left';
    c.fillText(`音楽「${this.tx.titleJp}」`, 150, 800);
    c.globalAlpha = 1;
  }

  /** Bar 98 → end: 終劇. */
  endCard(c: CanvasRenderingContext2D, t: number) {
    c.globalAlpha = clamp((t - this.T.card2) / 0.05);
    c.font = jp(330, 800, true); c.fillStyle = rgba('bone', 1); c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    c.fillText('終劇', 960, 640);
    c.textAlign = 'left';
    c.globalAlpha = 1;
  }

  /** Under both cards: the pilot's psychograph strip (the real waveform) and the settled numbers. */
  strip(c: CanvasRenderingContext2D, t: number) {
    const au = this.ctx.audio;
    const x = 150, w = 1620, y = 900, h = 64;
    const t0 = barTime(au, 97), period = barTime(au, 98) - t0;
    const rms = smoothEnv(au, 'rms', t, 0.7);
    const flat = smoothEnv(au, 'rms', t, 0.3) < 0.03;
    c.save();
    graticule(c, x, y, w, h, 'green', 0.55, 24);
    sweepTrace(c, au, t, { x, y, w, h, t0, period, kind: 'wave', color: 'green', gain: 0.8, k: 0.5, lw: 1, alpha: 0.3 });
    // the pilot's trace: pads (mel wiggle gated by the level) + the last vocal chops as blips
    sweepTrace(c, au, t, {
      x, y, w, h, t0, period, kind: 'line', color: 'green', gain: 1.5, lw: 1.9,
      sample: (tc) => Math.sqrt(au.env('rms', tc)) * (au.mel(tc, 30) - 0.58) * 2.2 + au.env('vocal', tc) * (au.mel(tc, 40) - 0.35) * 1.5,
    });
    c.font = font(F.mono(600), 12); c.letterSpacing = '2.4px'; c.textBaseline = 'alphabetic';
    c.fillStyle = rgba('green', 0.85);
    c.fillText('PSYCHOGRAPH  PILOT 01', x, y - 12);
    const tw = c.measureText('PSYCHOGRAPH  PILOT 01').width; c.letterSpacing = '0px';
    c.font = jp(13, 700, false); c.fillText('心理グラフ', x + tw + 10, y - 12);
    // right: sync ratio + activity limit, settling to zero
    const rem = Math.max(0, this.T.zero - t), ss = Math.floor(rem), cs = Math.floor((rem - ss) * 100);
    const tc = `00:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
    const sw = segW(tc, 22, 2.8);
    const col = rem < 3 ? rgba('red', 1) : rgba('orange', 1);
    sevenSeg(c, tc, x + w - sw, y - 34, 22, col, rgba('orange', 0.06), { thick: 2.8 });
    c.font = font(F.mono(600), 12); c.letterSpacing = '2.4px'; c.textAlign = 'right'; c.fillStyle = rgba('orange', 0.85);
    c.fillText(`SYNC ${settle(rms).toFixed(1).padStart(5, '0')}%   活動限界`, x + w - sw - 18, y - 12);
    if (flat) {
      c.fillStyle = rgba('red', (t * 2.5) % 1 < 0.6 ? 1 : 0.3);
      c.fillText('FLATLINE  信号途絶', x + w, y + h + 24);
    } else {
      c.fillStyle = rgba('green', 0.6);
      c.fillText(`AMP ${rms.toFixed(3)}`, x + w, y + h + 24);
    }
    c.restore();
  }
}

void W; void H;
