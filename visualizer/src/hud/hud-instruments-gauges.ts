/** Original procedural gauges; all geometry is inside the authored instrument rectangle. */
import { clamp01, hash01, type Painter } from './hud-painter.ts';
import { HUD_TIMING } from './hud-engine.ts';
import type { HudDrawState } from './hud-engine.ts';

const TAU = Math.PI * 2;
function rail(p: Painter, s: HudDrawState, v: number, col: string, alpha: number, dir: string): void {
  const horizontal = dir === 'ltr' || dir === 'rtl';
  const t = Math.min(1, s.w / 10, s.h / 10), w = Math.max(0, s.w - 4 * t), h = Math.max(0, s.h - 4 * t);
  const len = horizontal ? w * clamp01(v) : h * clamp01(v);
  const x = s.x + 2 * t + (dir === 'rtl' ? w - len : 0), y = s.y + 2 * t + (dir === 'btt' ? h - len : 0);
  p.rect(x, y, horizontal ? len : w, horizontal ? h : len, col, alpha);
}
export function drawGauges(p: Painter, s: HudDrawState): void {
  const l = s.layer, { x, y, w, h, palette: c } = s;
  const thin = Math.min(1, w / 8, h / 8);
  switch (l.k) {
    case 'bar': {
      p.rect(x, y, w, h, c.shade); p.frame(x, y, w, h, thin, s.secondary, 0.7);
      const vertical = l.dir === 'ttb' || l.dir === 'btt', n = l.segs ?? 0;
      if (l.trail || l.beh?.includes('ghost')) rail(p, s, s.trail, c.warn, 0.5, l.dir);
      if (n > 0) {
        const extent = (vertical ? h : w) - 4 * thin, cross = (vertical ? w : h) - 4 * thin, gap = Math.min(thin, extent / n * 0.25), len = extent / n;
        for (let i = 0; i < n; i++) {
          const on = i < Math.ceil(clamp01(s.value) * n), at = (l.dir === 'rtl' || l.dir === 'btt' ? n - 1 - i : i) * len;
          p.rect(x + 2 * thin + (vertical ? 0 : at), y + 2 * thin + (vertical ? at : 0), vertical ? cross : Math.max(0, len - gap), vertical ? Math.max(0, len - gap) : cross, on ? s.color : c.paper, on ? 1 : 0.12);
        }
      } else if (l.style === 'gradient') {
        const v = clamp01(s.value), iw = w - 4 * thin, ih = h - 4 * thin;
        p.ramp(x + 2 * thin + (l.dir === 'rtl' ? iw * (1 - v) : 0), y + 2 * thin + (l.dir === 'btt' ? ih * (1 - v) : 0), vertical ? iw : iw * v, vertical ? ih * v : ih, s.secondary, s.color, vertical);
      } else rail(p, s, s.value, s.color, 1, l.dir);
      if (l.style === 'ticks') for (let i = 1; i < 8; i++) p.rect(x + (vertical ? 0 : w * i / 8), y + (vertical ? h * i / 8 : 0), vertical ? w : thin, vertical ? thin : h, c.ink, 0.5);
      if (l.cap && s.value >= 0.999) p.frame(x + thin, y + thin, w - thin * 2, h - thin * 2, thin, c.hi, 0.6);
      if (l.beh?.includes('refill') && s.timing.localTime < HUD_TIMING.refill) {
        const q = s.timing.localTime / HUD_TIMING.refill;
        p.rect(x + w * q * 0.9, y + thin, w * 0.08, Math.max(0, h - 2 * thin), s.secondary, 0.15 * (1 - q));
      }
      if (s.accent && l.beh?.includes('damageFlicker') && s.audio.onset.any.ageSec < HUD_TIMING.flickerHold) p.rect(x + thin, y + thin, Math.min(w - thin * 2, p.m.logicalWidth * 0.2), Math.min(h * 0.1, p.m.logicalHeight * 0.02), c.warn, 0.2);
      break;
    }
    case 'pips': {
      const n = l.n, vertical = l.dir === 'ttb' || l.dir === 'btt', cell = Math.min((vertical ? w : w / n) / 9, (vertical ? h / n : h) / 9);
      const lit = Math.floor((l.v ? Math.min(n, Math.max(0, s.value)) : clamp01(s.value) * n) + 1e-8);
      for (let i = 0; i < n; i++) {
        const ix = l.dir === 'rtl' || l.dir === 'btt' ? n - 1 - i : i;
        const px = x + (vertical ? w / 2 : (ix + 0.5) * w / n) - cell * 3.5, py = y + (vertical ? (ix + 0.5) * h / n : h / 2) - cell * 3.5;
        p.icon(l.icon ?? 'block', px, py, cell, i < lit ? s.color : c.shade, i < lit ? 1 : 0.5);
      }
      break;
    }
    case 'matrix': {
      const cw = w / l.cols, ch = h / l.rows, gap = Math.min(l.gap ?? 1, cw * 0.2, ch * 0.2), count = l.cols * l.rows;
      const chase = Math.floor(s.timing.beat.pos * 2) % count;
      for (let row = 0; row < l.rows; row++) for (let col = 0; col < l.cols; col++) {
        const index = row * l.cols + col;
        const level = l.mode === 'spectrum' ? band(s, col, l.cols) : clamp01(s.value);
        const on = l.mode === 'chase' ? index === chase : l.mode === 'checker' ? (row + col + Math.floor(s.timing.beat.barPos)) % 2 === 0
          : l.mode === 'sparse' || l.mode === 'vote' ? hash01(s.seed, index, Math.floor(s.timing.beat.barPos)) < level : (l.rows - row) / l.rows <= level;
        p.rect(x + col * cw + gap / 2, y + row * ch + gap / 2, cw - gap, ch - gap, on ? s.color : c.shade, on ? 0.9 : 0.5);
      }
      break;
    }
    case 'slots': {
      const cols = Math.min(l.n, l.cols ?? l.n), rows = Math.ceil(l.n / cols), cw = w / cols, ch = h / rows;
      const sel = l.sel === 'static' ? Math.floor(clamp01(s.value) * (l.n - 1)) : l.sel === 'onset' ? s.audio.live ? s.audio.onset.any.count % l.n : 0 : Math.floor(l.sel === 'beat' ? s.timing.beat.pos : s.timing.beat.barPos) % l.n;
      for (let i = 0; i < l.n; i++) {
        const px = x + i % cols * cw, py = y + Math.floor(i / cols) * ch, inset = Math.min(2, cw * 0.1, ch * 0.1), cell = Math.min((cw - inset * 4) / 7, (ch - inset * 4) / 7);
        p.rect(px + inset, py + inset, cw - inset * 2, ch - inset * 2, c.shade);
        p.frame(px + inset, py + inset, cw - inset * 2, ch - inset * 2, thin, i === sel ? s.color : s.secondary, i === sel ? 1 : 0.4);
        p.icon(l.icon ?? 'box', px + (cw - cell * 7) / 2, py + (ch - cell * 7) / 2, cell, i === sel ? c.hi : s.secondary, 0.85);
      }
      break;
    }
    case 'dial': {
      const cx = x + w / 2, cy = y + h / 2, r = Math.min(w, h) * 0.43, value = clamp01(s.value), a0 = -Math.PI * 0.75, sweep = (l.sweep ?? 270) * Math.PI / 180;
      if (l.style === 'orb') {
        p.disc(cx, cy, r, c.shade); p.disc(cx, cy, r * Math.sqrt(value), s.color, 0.65); p.circle(cx, cy, r, thin, s.secondary);
        p.arc(cx, cy, r * 0.85, Math.PI * 1.1, Math.PI * 0.5, thin, c.hi, 0.5);
      } else {
        const ring = l.style === 'ring', start = ring ? -Math.PI / 2 : a0, angle = ring ? TAU : sweep;
        p.arc(cx, cy, r, start, angle, Math.min(4, r * 0.15), c.shade);
        if (l.style === 'arc' || ring) p.arc(cx, cy, r, start, angle * value, Math.min(3, r * 0.1), s.color);
        const ticks = l.ticks ?? (l.style === 'speedo' ? 12 : 8);
        for (let i = 0; i < ticks; i++) {
          const a = start + angle * i / Math.max(1, ticks - (ring ? 0 : 1));
          p.line(cx + Math.cos(a) * r * 0.78, cy + Math.sin(a) * r * 0.78, cx + Math.cos(a) * r * 0.93, cy + Math.sin(a) * r * 0.93, thin, s.secondary, 0.65);
        }
        if (l.style === 'needle' || l.style === 'speedo') {
          const a = start + angle * value; p.line(cx, cy, cx + Math.cos(a) * r * 0.72, cy + Math.sin(a) * r * 0.72, thin * 2, s.color); p.disc(cx, cy, r * 0.08, c.hi);
        }
      }
      break;
    }
  }
}
export function band(s: HudDrawState, i: number, n: number): number {
  if (!s.audio.live) return 0;
  const names = ['sub', 'low', 'mid', 'high', 'air'] as const, at = (i / Math.max(1, n - 1)) * 4, lo = Math.floor(at), hi = Math.min(4, lo + 1);
  return clamp01(s.audio.band[names[lo]!] * (1 - at + lo) + s.audio.band[names[hi]!] * (at - lo));
}
