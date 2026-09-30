/** Original panels, decorative beds, abstract faces and spatial instruments. No commercial artwork or logos. */
import { HUD_TIMING, drawHudText, type HudDrawState } from './hud-engine.ts';
import { hash01, noise1, clamp01, type Painter } from './hud-painter.ts';

const TAU = Math.PI * 2;
export function drawSpatial(p: Painter, s: HudDrawState): void {
  const l = s.layer, { x, y, w, h, palette: c } = s, t = Math.min(1, w / 10, h / 10);
  switch (l.k) {
    case 'panel': {
      p.rect(x, y, w, h, c.shade); p.frame(x, y, w, h, t, s.color, 0.75);
      if (l.style === 'bevel' || l.style === 'steel' || l.style === 'brick') {
        p.rect(x + t, y + t, w - 2 * t, t, c.hi, 0.6); p.rect(x + t, y + t, t, h - 2 * t, c.hi, 0.4);
        p.rect(x + t, y + h - 2 * t, w - 2 * t, t, c.ink, 0.8);
      }
      if (l.style === 'rail') { p.rect(x + t, y + h * 0.35, w - t * 2, t, s.secondary, 0.4); p.rect(x + t, y + h * 0.65, w - t * 2, t, s.secondary, 0.4); }
      if (l.style === 'notch' || l.style === 'bracket') {
        const len = Math.min(w, h) * 0.2;
        for (const a of [0, 1]) for (const b of [0, 1]) { const xx = x + a * (w - len), yy = y + b * (h - t); p.rect(xx, yy, len, t, c.hi); }
      }
      if (l.style === 'crt') for (let i = 1; i < 12; i++) p.rect(x + t, y + h * i / 12, w - 2 * t, t, c.ink, 0.2);
      if (l.style === 'brick') for (let row = 1; row < 4; row++) { p.rect(x, y + row * h / 4, w, t, c.ink, 0.5); for (let col = 1; col < 6; col++) p.rect(x + (col + (row % 2) * 0.5) * w / 6, y + (row - 1) * h / 4, t, h / 4, c.ink, 0.4); }
      if (l.title) drawHudText(p, { ...s, y: y + t, h: Math.min(h * 0.3, 16) }, l.title, 'pixel', 'left', 0.8);
      break;
    }
    case 'viewport': {
      // Energy changes detail alpha by <= .07, never full-surface brightness. Bed motion is analytical media time.
      const energy = Math.min(0.35, l.energy ?? 0.15), a = 0.12 + energy * clamp01(s.value) * 0.2, time = s.reduced ? s.timing.localTime * 0.1 : s.timing.localTime;
      if (l.bed === 'gradient') p.ramp(x, y, w, h, c.ink, c.shade, true, 1);
      else p.rect(x, y, w, h, c.ink);
      if (l.bed === 'starfield' || l.bed === 'noise') for (let i = 0; i < (l.bed === 'noise' ? 32 : 24); i++) {
        const px = x + hash01(s.seed, i) * (w - t * 2) + t, py = y + ((hash01(s.seed, i, 1) + time * 0.006 * (1 + i % 3)) % 1) * (h - t * 2) + t;
        p.rect(px, py, t, t, s.secondary, a * 2);
      }
      if (l.bed === 'grid' || l.bed === 'horizon' || l.bed === 'tunnel' || l.bed === 'circuit') {
        for (let i = 1; i < 9; i++) { p.line(x + t, y + h * i / 9, x + w - t, y + h * i / 9, t, s.secondary, a); p.line(x + w * i / 9, y + t, x + w * i / 9, y + h - t, t, s.secondary, a); }
        if (l.bed === 'horizon') for (let i = 0; i < 9; i++) p.line(x + w / 2, y + h * 0.45, x + t + (w - t * 2) * i / 8, y + h - t, t, s.color, a);
        if (l.bed === 'tunnel') for (let i = 0; i < 4; i++) { const k = ((i / 4 + time * 0.015) % 1) * 0.45; p.frame(x + w * k, y + h * k, w * (1 - 2 * k), h * (1 - 2 * k), t, s.color, a); }
      }
      if (l.bed === 'city') for (let i = 0; i < 16; i++) { const hh = h * (0.05 + hash01(s.seed, i) * 0.25); p.rect(x + i * w / 16, y + h - hh, w / 16 * 0.8, hh, s.secondary, a); }
      if (l.bed === 'waves') for (let row = 0; row < 3; row++) { const pts: number[] = []; for (let i = 0; i <= 24; i++) pts.push(x + t + (w - 2 * t) * i / 24, y + h * (row + 1) / 4 + Math.sin(i / 24 * TAU + time * 0.2) * h * 0.06); p.polyline(pts, 25, t, s.secondary, a); }
      if (l.frame) p.frame(x, y, w, h, t, s.secondary, 0.5);
      break;
    }
    case 'portrait': {
      p.rect(x, y, w, h, c.shade); p.frame(x, y, w, h, t, s.secondary, 0.7);
      const cx = x + w / 2, cy = y + h / 2, rr = Math.min(w, h) * 0.37, dead = s.timing.scene.known && s.timing.scene.progress >= 1 && l.beh?.includes('dead');
      const pan = s.audio.live && Math.abs(s.audio.pan) >= HUD_TIMING.gazeOn && l.beh?.includes('look') ? Math.sign(s.audio.pan) : 0;
      const blinkPeriod = HUD_TIMING.blinkMin + hash01(s.seed, 0) * (HUD_TIMING.blinkMax - HUD_TIMING.blinkMin), blink = l.beh?.includes('blink') && s.timing.localTime % blinkPeriod < HUD_TIMING.blinkHold;
      const hurt = !s.reduced && l.beh?.includes('hurt') && s.audio.live && s.audio.onset.kick.strength > HUD_TIMING.hurtThreshold && s.audio.onset.kick.ageSec < HUD_TIMING.hurtHold;
      const face = hurt ? c.warn : s.color;
      if (l.style === 'emblem') { p.polygon([cx, cy - rr, cx + rr, cy, cx, cy + rr, cx - rr, cy], 4, face, 0.5); p.circle(cx, cy, rr * 0.6, t, c.hi, 0.7); }
      else {
        if (l.style === 'eye') { p.circle(cx, cy, rr, t, s.secondary, 0.8); p.disc(cx + pan * rr * 0.15, cy, rr * (blink ? 0.06 : 0.3), face); }
        else {
          p.polygon([cx - rr * 0.65, cy - rr, cx + rr * 0.65, cy - rr, cx + rr, cy + rr * 0.3, cx + rr * 0.45, cy + rr, cx - rr * 0.45, cy + rr, cx - rr, cy + rr * 0.3], 6, face, 0.28);
          if (l.style === 'visor' || l.style === 'mask') p.rect(cx - rr * 0.7, cy - rr * 0.28, rr * 1.4, rr * 0.25, s.secondary, 0.8);
          else for (const side of [-1, 1]) {
            const ex = cx + side * rr * 0.38 + pan * rr * 0.1, ey = cy - rr * 0.15;
            if (dead) { p.line(ex - rr * 0.1, ey - rr * 0.1, ex + rr * 0.1, ey + rr * 0.1, t, c.hi); p.line(ex - rr * 0.1, ey + rr * 0.1, ex + rr * 0.1, ey - rr * 0.1, t, c.hi); }
            else p.rect(ex - rr * 0.13, ey, rr * 0.26, blink ? t : rr * 0.12, c.hi);
          }
          const grin = l.beh?.includes('grin') && s.audio.live && s.audio.contour.tension > HUD_TIMING.grinThreshold;
          p.line(cx - rr * 0.3, cy + rr * 0.45, cx + rr * 0.3, cy + rr * (grin ? 0.3 : 0.45), t, s.secondary);
        }
      }
      break;
    }
    case 'radar': {
      const cx = x + w / 2, cy = y + h / 2, r = Math.min(w, h) * 0.43, rings = l.rings ?? 3;
      p.disc(cx, cy, r, c.shade, 0.75); p.circle(cx, cy, r, t, s.color, 0.6);
      for (let i = 1; i <= rings; i++) p.circle(cx, cy, r * i / (rings + 1), t, s.secondary, 0.22);
      p.line(cx - r, cy, cx + r, cy, t, s.secondary, 0.3); p.line(cx, cy - r, cx, cy + r, t, s.secondary, 0.3);
      const phase = l.sweep === 'beat' ? s.timing.beat.phase : l.sweep === 'free' ? (s.timing.localTime / (l.period ?? 8)) % 1 : s.timing.beat.barPhase;
      const angle = phase * TAU * (s.reduced ? 0.25 : 1) - Math.PI / 2;
      if (l.style !== 'minimap') p.line(cx, cy, cx + Math.cos(angle) * r * 0.95, cy + Math.sin(angle) * r * 0.95, t, s.color, 0.65);
      for (let i = 0; i < (l.blips ?? 8); i++) {
        const a = hash01(s.seed, i) * TAU, distance = Math.sqrt(hash01(s.seed, i, 1)) * r * 0.8, diff = ((angle - a + TAU * 4) % TAU) / TAU;
        const ping = Math.exp(-diff * 9), size = Math.min(r * 0.04, Math.max(t, r * 0.015));
        p.disc(cx + Math.cos(a) * distance, cy + Math.sin(a) * distance, size, s.secondary, 0.25 + 0.65 * ping);
      }
      break;
    }
    case 'reticle': {
      const drift = s.reduced ? 0 : l.drift ?? (l.beh?.includes('drift') ? 0.3 : 0), cx = x + w * (0.5 + (noise1(s.seed, s.timing.localTime * 0.05) - 0.5) * drift * 0.2), cy = y + h * (0.5 + (noise1(s.seed + 1, s.timing.localTime * 0.07) - 0.5) * drift * 0.2);
      const r = Math.min(w, h) * (s.reduced ? 0.3 : 0.3 - s.lock * 0.04), gap = r * 0.2;
      if (l.style === 'diamond') p.polyline([cx, cy - r, cx + r, cy, cx, cy + r, cx - r, cy], 4, t, s.color, 0.8, true);
      else if (l.style === 'pipper') { p.circle(cx, cy, r, t, s.color); p.disc(cx, cy, t, c.hi); }
      else {
        p.line(cx - r, cy, cx - gap, cy, t, s.color); p.line(cx + gap, cy, cx + r, cy, t, s.color);
        p.line(cx, cy - r, cx, cy - gap, t, s.color); p.line(cx, cy + gap, cx, cy + r, t, s.color);
        if (l.style === 'brackets' || l.style === 'trench') p.frame(cx - r, cy - r, r * 2, r * 2, t, s.secondary, 0.45);
      }
      for (let i = 0; i < (l.ticks ?? 0); i++) p.rect(x + w * (i + 0.5) / Math.max(1, l.ticks ?? 1), y + h * 0.85, t, Math.min(3, h * 0.05), s.secondary, 0.6);
      if (l.beh?.includes('lock') && s.lock > 0) p.circle(cx, cy, r * 0.72, t, c.ok, s.lock * 0.6);
      break;
    }
  }
}
