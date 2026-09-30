/** Signal rails, synthetic scopes and restrained effects. Live values decorate, never determine a deadline. */
import { HUD_TIMING, type HudDrawState } from './hud-engine.ts';
import { band } from './hud-instruments-gauges.ts';
import { clamp01, hash01, type Painter } from './hud-painter.ts';

const TAU = Math.PI * 2;
export function drawSignal(p: Painter, s: HudDrawState): void {
  const l = s.layer, { x, y, w, h, palette: c } = s, t = Math.min(1, w / 10, h / 10);
  switch (l.k) {
    case 'spectrum': {
      const vertical = l.dir !== 'ltr' && l.dir !== 'rtl', cw = (vertical ? w : h) / l.bars, gap = cw * 0.2;
      for (let i = 0; i < l.bars; i++) {
        const raw = band(s, i, l.bars), value = l.scale === 'sqrt' ? Math.sqrt(raw) : l.scale === 'log' ? Math.log1p(raw * 9) / Math.log(10) : raw;
        const extent = (vertical ? h : w) * value, at = i * cw + gap / 2;
        const px = x + (vertical ? at : l.dir === 'rtl' ? w - extent : 0), py = y + (vertical ? l.dir === 'ttb' ? 0 : h - extent : at);
        if (l.seg) for (let k = 0; k < l.seg; k++) {
          if ((k + 0.5) / l.seg > value) continue;
          const len = (vertical ? h : w) / l.seg, pos = k * len, reverse = vertical ? l.dir !== 'ttb' : l.dir === 'rtl';
          p.rect(x + (vertical ? at : reverse ? w - pos - len : pos), y + (vertical ? reverse ? h - pos - len : pos : at), vertical ? cw - gap : len * 0.75, vertical ? len * 0.75 : cw - gap, s.color, 0.8);
        } else p.rect(px, py, vertical ? cw - gap : extent, vertical ? extent : cw - gap, s.color, 0.8);
        if (l.hold || l.beh?.includes('peakHold')) {
          // An instantaneous analytical peak envelope from the signal's last onset, not a seek-dependent accumulator.
          const peak = Math.max(value, s.audio.live ? s.audio.onset.any.strength - s.audio.onset.any.ageSec * HUD_TIMING.peakDecay : 0), pos = Math.max(0, Math.min(vertical ? h : w, (vertical ? h : w) * peak));
          p.rect(x + (vertical ? at : l.dir === 'rtl' ? w - pos : pos), y + (vertical ? l.dir === 'ttb' ? pos : h - pos : at), vertical ? cw - gap : t, vertical ? t : cw - gap, s.secondary, 0.55);
        }
      }
      if (l.mirror) p.frame(x, y, w, h, t, s.secondary, 0.2);
      break;
    }
    case 'scope': {
      if (l.grid) { for (let i = 1; i < 5; i++) { p.line(x + t, y + h * i / 5, x + w - t, y + h * i / 5, t, s.secondary, 0.2); p.line(x + w * i / 5, y + t, x + w * i / 5, y + h - t, t, s.secondary, 0.2); } }
      const pts: number[] = [], level = s.audio.live ? clamp01(s.audio.rms) : 0, flat = s.timing.scene.known && s.timing.scene.progress === 1;
      for (let i = 0; i <= 64; i++) {
        const at = i / 64, phase = at * TAU, wave = flat ? 0 : l.mode === 'ecg' ? ecg((at * 2 + s.phase) % 1) : Math.sin(phase * 3 + s.phase * TAU) * (0.12 + level * 0.2);
        if (l.mode === 'lissajous') pts.push(x + w * (0.5 + Math.sin(phase * 3) * (0.12 + level * 0.25)), y + h * (0.5 + Math.sin(phase * 2 + s.phase * TAU) * (0.12 + level * 0.25)));
        else pts.push(x + t + (w - 2 * t) * at, y + h * (0.5 + wave * 0.8));
      }
      p.polyline(pts, 65, t, s.color, 0.8);
      if (l.ch === 'both') { const other = pts.map((n, i) => i % 2 ? y + h - (n - y) : n); p.polyline(other, 65, t, s.secondary, 0.4); }
      break;
    }
    case 'rain': {
      const cw = w / l.cols, cell = Math.min(cw / 7, h / 30), speed = s.reduced ? HUD_TIMING.reducedRain : 0.4 + (s.audio.live ? s.audio.rms : 0) * 0.6;
      const set = l.set === 'bin' ? '01' : l.set === 'hex' ? '0123456789ABCDEF' : l.set === 'dots' ? '.:' : '+-=:[]<>/';
      const rows = Math.min(12, Math.max(1, Math.floor(h / Math.max(cell * 9, 0.01))));
      for (let col = 0; col < l.cols; col++) {
        const phase = (hash01(s.seed, col) + s.timing.localTime * speed * 0.05) % 1;
        const rowHead = Math.floor(phase * rows);
        for (let row = 0; row < rows; row++) {
          const distance = (rowHead - row + rows) % rows;
          if (distance > 3) continue;
          const char = set[Math.floor(hash01(s.seed, col * rows + row, Math.floor(s.timing.localTime * speed)) * set.length)]!;
          p.pixelText(char, x + col * cw + (cw - cell * 5) / 2, y + row * h / rows, cell, distance === 0 ? c.hi : s.color, 0.65 * (1 - distance / 4));
        }
      }
      break;
    }
    case 'fx': {
      const amount = clamp01(l.amount);
      if (l.fx === 'scanlines') {
        const n = Math.min(48, Math.max(1, Math.floor(h / 4)));
        for (let i = 0; i < n; i++) p.rect(x, y + i * h / n, w, Math.min(1, h / n * 0.2), c.ink, amount * 0.25);
      } else if (l.fx === 'vignette') p.vignette(x, y, w, h, c.ink, amount * 0.5);
      else if (l.fx === 'grain') for (let i = 0; i < 24; i++) { const n = s.reduced ? 0 : Math.floor(s.timing.localTime * 4); p.rect(x + hash01(s.seed, i, n) * (w - t), y + hash01(s.seed, i + 24, n) * (h - t), t, t, s.color, amount * 0.1); }
      else if (l.fx === 'glow') p.frame(x, y, w, h, Math.min(w, h) * 0.03, s.color, amount * 0.08);
      else if (l.fx === 'flash' && s.accent && !s.reduced && s.policy.flash !== 'off') {
        // Entire effects occupy under 8% of frame; the final composite FlashGate remains authoritative.
        const ww = Math.min(w, Math.sqrt(HUD_TIMING.accentArea) * p.m.logicalWidth), hh = Math.min(h, Math.sqrt(HUD_TIMING.accentArea) * p.m.logicalHeight);
        p.rect(x + (w - ww) / 2, y + (h - hh) / 2, ww, hh, s.color, Math.min(HUD_TIMING.flashAmount, amount));
      }
      // Shake intentionally affects only a local marker; it never shifts unbounded canvas geometry.
      else if (l.fx === 'shake' && s.accent && !s.reduced) {
        const k = Math.floor(s.timing.localTime * HUD_TIMING.shakeHz), dx = (hash01(s.seed, k) - 0.5) * Math.min(HUD_TIMING.shakePx, w * 0.02);
        p.frame(x + w * 0.1 + dx, y + h * 0.1, w * 0.8, h * 0.8, t, s.secondary, amount * 0.4);
      }
      break;
    }
  }
}
function ecg(x: number): number {
  const bump = (at: number, width: number, height: number) => height * Math.exp(-(((x - at) / width) ** 2));
  return bump(0.16, 0.035, 0.06) - bump(0.3, 0.018, 0.1) + bump(0.34, 0.012, 0.45) - bump(0.38, 0.02, 0.17) + bump(0.6, 0.07, 0.12);
}
