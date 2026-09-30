/** Deterministic scene-clock readouts. Text is geometry from the original HUD font, never kit pixels. */
import { drawHudText, HUD_TIMING, type HudDrawState } from './hud-engine.ts';
import { clamp01, type Painter } from './hud-painter.ts';

export function drawReadouts(p: Painter, s: HudDrawState): void {
  const l = s.layer, { x, y, w, h, palette: c } = s;
  switch (l.k) {
    case 'label': drawHudText(p, s, s.text, l.font ?? 'pixel', l.align ?? 'left', l.size === 's' ? 0.55 : l.size === 'm' ? 0.75 : 1); break;
    case 'counter': drawHudText(p, s, s.text, l.font ?? 'pixel'); break;
    case 'timer': drawHudText(p, s, s.text, l.font ?? 'seg', 'center', l.beh?.includes('urgent') && s.number <= (l.urgent ?? 10) && !s.reduced ? 0.9 + 0.04 * Math.sin(s.timing.localTime * Math.PI * 2 * HUD_TIMING.urgentHz) : 1); break;
    case 'terminal': {
      const lines = l.lines, all = lines.join('\n'), progress = l.reveal === 'static' ? 1 : l.reveal === 'beat' ? clamp01(s.timing.beat.scenePos / Math.max(1, s.timing.sceneBeats)) : clamp01(s.value);
      const shown = Math.floor(all.length * progress), cell = Math.max(0.01, Math.min(w / Math.max(6, Math.max(...lines.map(t => t.length), 1) * 6), h / Math.max(9, lines.length * 9)));
      let offset = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!, n = Math.max(0, Math.min(line.length, shown - offset)); offset += line.length + 1;
        let text = line.slice(0, n);
        if (l.mode === 'hex') text = text.split('').map(ch => (ch.charCodeAt(0) % 16).toString(16).toUpperCase()).join('');
        if (text) p.pixelText(text, x + cell, y + i * cell * 9 + cell, cell * 0.9, s.color);
        if (l.cursor && n < line.length && shown >= offset - line.length - 1 && Math.floor(s.timing.localTime * 2) % 2 === 0) p.rect(x + (n * 6 + 1) * cell, y + i * cell * 9 + cell, cell * 4, cell * 7, s.secondary, 0.5);
      }
      break;
    }
    case 'warning': {
      p.rect(x, y, w, h, c.shade, 0.9);
      const edge = Math.min(2, h * 0.15, w * 0.15); p.frame(x, y, w, h, edge, s.color, 0.8);
      if (l.style === 'hazard' || l.beh?.includes('stripes')) {
        const band = Math.min(h * 0.15, 4), n = Math.min(24, Math.max(2, Math.floor(w / Math.max(1, h * 0.3))));
        for (let i = 0; i < n; i += 2) { p.rect(x + i * w / n, y, w / n, band, s.secondary, 0.65); p.rect(x + i * w / n, y + h - band, w / n, band, s.secondary, 0.65); }
      }
      drawHudText(p, s, s.text, 'pixel', 'center', 0.75); break;
    }
    case 'combo': {
      const count = s.audio.live ? s.audio.onset.any.count % 99 + 1 : 0;
      drawHudText(p, s, `${s.text} ${count}`, 'pixel', 'center', s.reduced ? 0.9 : 0.85 + 0.1 * Math.exp(-s.cueAge / HUD_TIMING.popHold));
      if (l.rank) p.frame(x, y, w, h, Math.min(1, w / 10, h / 10), s.secondary, 0.6);
      break;
    }
    case 'banner': {
      const t = Math.min(2, w / 10, h / 10);
      p.rect(x, y, w, h, c.shade, 0.95); p.frame(x, y, w, h, t, s.secondary, 0.8);
      const reveal = !s.reduced && (s.cueStyle === 'slide' || l.beh?.includes('slide')) ? clamp01(s.cueAge / HUD_TIMING.popHold) : 1;
      drawHudText(p, { ...s, h: h * (0.7 + reveal * 0.3), y: y + h * (1 - reveal) * 0.15 }, s.text, 'pixel', 'center', s.cueStyle === 'pop' || l.beh?.includes('pop') ? 0.85 + 0.1 * Math.exp(-s.cueAge / HUD_TIMING.popHold) : 0.85); break;
    }
  }
}
