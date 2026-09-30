// Ported from bizarro/evangelion app/src/scenes/boot.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// boot — "SYSTEM START" (intro, pads only, 0 – 8.42 s).
// A NERV terminal boots: mono lines type out down the left, a hex emblem assembles cell by cell
// on the pad swells, orange rules sweep in; on the last bar the screen clears to the episode title
// card (condensed serif, stacked sizes). Hard cut into `magi` when the drums enter.
import * as THREE from 'three';
import { Scene, type Frame, type PostOverrides } from '../../show/scene.ts';
import { Layer2D, clearRT } from '../../show/gl.ts';
import { rgba } from '../../show/palette.ts';
import { F, font } from '../../show/type.ts';
import { clamp, ease, prog, hash } from '../../show/util.ts';
import { fitCondensedSize, nervText, unitName } from './show-text.ts';
import { barTime, condensed, evaLabel, hexGrid, hexPath, hexData, jp, makeScanPass, ticker, W, H } from './_eva.ts';

const LINES = [
  'NERV OS  REV 3.11  (C)2015 GEHIRN',
  'BOOT SEQUENCE ............ OK',
  'MAGI LINK  MELCHIOR-1 .... OK',
  'MAGI LINK  BALTHASAR-2 ... OK',
  'MAGI LINK  CASPER-3 ...... OK',
  'CENTRAL DOGMA ACCESS ..... GRANTED',
  'AUDIO CHANNEL  133.33 BPM  LOCKED',
  'NEURAL INTERFACE ......... STANDBY',
  'PATTERN ANALYSIS ......... READY',
];

export default class Boot extends Scene {
  text = new Layer2D();
  scan = makeScanPass(0.24);
  T = { s: 0, e: 0, card: 0 };
  // AAAVS: track title from the show params, tempo from the analysis (upstream: its own song, 133.33 BPM)
  tx = nervText(this.ctx.params);
  lines = LINES.map((l) => l.replace('133.33', this.ctx.audio.bpm.toFixed(2)));

  override init() {
    const au = this.ctx.audio;
    this.T.s = this.ctx.start; this.T.e = this.ctx.end;
    this.T.card = barTime(au, 1); // the last bar before the drums: title card
  }

  render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides {
    const { renderer, audio: au } = this.ctx;
    const T = this.T, t = f.t;
    clearRT(renderer, out, [0.0015, 0.0012, 0.001]);
    const L = this.text; L.clear();
    const c = L.ctx;
    const pad = clamp(au.env('other', t) * 1.3);
    const inCard = t >= T.card;

    if (!inCard) {
      // ---- terminal: lines type out, one every ~0.55 s
      const x = 120, y0 = 200;
      c.font = font(F.mono(500), 20);
      c.textBaseline = 'alphabetic';
      this.lines.forEach((ln, i) => {
        const t0 = T.s + 0.35 + i * 0.52;
        const n = Math.floor(clamp((t - t0) / 0.3) * ln.length);
        if (n <= 0) return;
        const ok = ln.endsWith('OK') || ln.endsWith('GRANTED') || ln.endsWith('LOCKED') || ln.endsWith('READY');
        const s = ln.slice(0, n);
        c.fillStyle = rgba('orange', 0.92);
        if (ok && n === ln.length) {
          const cut = ln.lastIndexOf(' ') + 1;
          c.fillText(ln.slice(0, cut), x, y0 + i * 36);
          c.fillStyle = rgba('green', 0.95);
          c.fillText(ln.slice(cut), x + c.measureText(ln.slice(0, cut)).width, y0 + i * 36);
        } else c.fillText(s, x, y0 + i * 36);
        // cursor on the line being typed
        if (n < ln.length && ((t * 3) % 1) < 0.6) { c.fillStyle = rgba('orange', 0.9); c.fillRect(x + c.measureText(s).width + 2, y0 + i * 36 - 18, 11, 22); }
      });
      // header rule + label
      const rw = prog(t, T.s + 0.1, T.s + 1.2, ease.outCubic);
      c.fillStyle = rgba('orange', 1); c.fillRect(120, 120, 1680 * rw, 3);
      evaLabel(c, 120, 106, 'system start', undefined, { alpha: rw });
      c.font = jp(20, 700, false); c.fillStyle = rgba('orange', rw); c.textAlign = 'right';
      c.fillText('システム起動', 1800, 108); c.textAlign = 'left';
      // hex dump column (right), a row per hat-ish step
      const step = Math.floor((t - T.s) * 6);
      c.font = font(F.mono(400), 13);
      for (let r = 0; r < 18; r++) {
        const a = clamp((t - T.s - 0.8 - r * 0.12) * 2) * 0.55;
        if (a <= 0) continue;
        c.fillStyle = rgba('orange', a);
        c.fillText(`${(0x3f00 + r * 16).toString(16).toUpperCase()}  ${hexData(r, step + r, 8)} ${hexData(r + 50, step, 8)}`, 1480, 220 + r * 24);
      }
      // the hex emblem: cells light up from the centre outward as the pads swell
      const cx = 1050, cy = 560, R = 250;
      const grow = prog(t, T.s + 1.0, T.card - 0.2, ease.inOutCubic);
      hexGrid(cx - R - 40, cy - R - 40, 2 * R + 80, 2 * R + 80, 22, (hx, hy, _c, _r, i) => {
        const d = Math.hypot(hx - cx, hy - cy);
        if (d > R) return;
        const k = d / R;
        const on = clamp((grow * 1.25 - k) * 6 + (hash(i, 7) - 0.5) * 0.6);
        if (on <= 0) return;
        hexPath(c, hx, hy, 20);
        const hot = hash(i, Math.floor(t * 8)) < 0.04 + 0.1 * pad;
        c.strokeStyle = rgba(hot ? 'amber' : 'orange', (0.25 + 0.5 * on) * (0.7 + 0.3 * pad));
        c.lineWidth = 1.5; c.stroke();
        if (k < 0.34 || hot) { c.fillStyle = rgba('orange', 0.18 * on + (hot ? 0.35 : 0)); c.fill(); }
      });
      // outer ring + ticks
      c.strokeStyle = rgba('orange', 0.8 * grow); c.lineWidth = 2;
      c.beginPath(); c.arc(cx, cy, R + 24, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * grow); c.stroke();
      for (let k = 0; k < 72; k++) {
        if (k / 72 > grow) break;
        const a = -Math.PI / 2 + (k / 72) * Math.PI * 2, l = k % 6 === 0 ? 14 : 6;
        c.beginPath(); c.moveTo(cx + Math.cos(a) * (R + 30), cy + Math.sin(a) * (R + 30)); c.lineTo(cx + Math.cos(a) * (R + 30 + l), cy + Math.sin(a) * (R + 30 + l)); c.stroke();
      }
      // bottom ticker
      ticker(c, 120, 1000, 1680, `${this.tx.title} // AUDIO SYNC ESTABLISHED // ${au.bpm.toFixed(2)} BPM // PATTERN ORANGE // ALL SYSTEMS NOMINAL`, t, { speed: 90, color: rgba('orange', 0.6) });
      c.fillStyle = rgba('orange', 0.6); c.fillRect(120, 1012, 1680, 1);
    } else {
      // ---- the title card (one bar): white condensed serif, episode-card layout
      const k = t - T.card;
      const a = clamp(k / 0.06);
      c.globalAlpha = a;
      condensed(c, 'EPISODE:01', 160, 250, 64, { sx: 0.62, color: rgba('bone', 1) });
      const [l1, l2] = this.tx.titleLines;
      if (l1) condensed(c, l1, 150, 560, fitCondensedSize(c, l1, 330, 0.56, 1640), { sx: 0.56, color: rgba('bone', 1) });
      condensed(c, l2, 150, 860, fitCondensedSize(c, l2, 330, 0.56, 1640), { sx: 0.56, color: rgba('bone', 1) });
      c.font = jp(52, 700, true); c.fillStyle = rgba('bone', 1); c.textAlign = 'right';
      c.fillText(this.tx.titleJp, 1790, 940);
      c.font = jp(30, 600, true);
      c.fillText('使徒、襲来', 1790, 250);
      c.textAlign = 'left';
      c.globalAlpha = 1;
    }
    this.ctx.comp.draw(renderer, L.upload(), out);
    this.scan.u.t!.value = t;
    this.scan.render(renderer, out);
    return { bloom: 0.5, bloomThreshold: 0.7, halation: 0.1, vignette: 0.45, ca: 1.0, grain: 0.05, flash: inCard ? 0.35 * Math.exp(-(t - T.card) / 0.08) : 0 };
  }
}

void W; void H;
