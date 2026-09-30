// Shared HUD pieces of the Pixel Stage plates: every readout is a meter of the music (docs/design/SPRITE-SHOW-KIT.md "HUD as meters").
import { clipFrameIndex } from '../../asset-packs/pack.ts';
import { loopFrame } from '../../show/sprite/clip.ts';
import { banner, box, counterText, countOnsets, ghostBar, ghostLevel, lin, segmentedMeter, solid, text, timerText, type RGB } from '../../show/sprite/hud.ts';
import type { HudContext } from '../../show/sprite/scene.ts';
import { pushFrame, type SpriteDraw } from '../../show/sprite/perform.ts';

export const INK: RGB = lin('#eaf2ff'), DIM: RGB = lin('#7f8fc0'), HOT: RGB = lin('#ffd23f', 1.4), COOL: RGB = lin('#6fe3ff', 1.3), ROSE: RGB = lin('#ff6fd0', 1.3), GOOD: RGB = lin('#5fe38a');
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Energy 0..1 of a band, lifted so a quiet bar still shows (a meter never reads empty in music). */
export const band = (h: HudContext, name: string, t = h.t) => Math.max(0.1, Math.min(1, h.au.env(name, t) * 1.25));

/** The top line: plate number and name, bar and beat, tempo, timecode. A panel with caption text. */
export function header(h: HudContext, tint: RGB = INK, accent: RGB = HOT): SpriteDraw[] {
  const w = h.nativeW, z = 1000, bar = Math.floor(h.bar) + 1, beat = Math.floor(h.beat % 4 + 4) % 4 + 1;
  const out = box(h.pack, 'panel', 2, 2, w - 4, 13, z);
  out.push(...text(h.pack, 'caps', `P${String(h.plateNo).padStart(2, '0')} ${h.plateName}`, 7, 5, { tint: accent, z: z + 1 }));
  out.push(...text(h.pack, 'caps', `BAR ${counterText(bar, 3)}.${beat}`, w / 2, 5, { align: 'center', tint, z: z + 1 }));
  out.push(...text(h.pack, 'caps', `${Math.round(h.au.bpm)} BPM  ${timerText(h.t)}`, w - 7, 5, { align: 'right', tint, z: z + 1 }));
  return out;
}

/** A row of equaliser columns from the mel bands, each with a peak cap that falls (ghost). */
export function eq(h: HudContext, x: number, y: number, n: number, maxH: number, colW = 3, gap = 1, hi: RGB = COOL, lo: RGB = ROSE): SpriteDraw[] {
  const out: SpriteDraw[] = [], z = 900;
  for (let i = 0; i < n; i++) {
    const b = (i * 56) / Math.max(1, n - 1), { value, ghost } = ghostLevel((tt) => h.au.mel(tt, b), h.t, { samples: 10, rate: 1.4, hold: 0.06 });
    const vh = Math.round(value * maxH), gh = Math.round(ghost * maxH), bx = x + i * (colW + gap), k = n > 1 ? i / (n - 1) : 0;
    const col: RGB = [lo[0] + (hi[0] - lo[0]) * k, lo[1] + (hi[1] - lo[1]) * k, lo[2] + (hi[2] - lo[2]) * k];
    out.push(solid(bx, y + maxH - vh, colW, vh, col, z));
    if (gh > vh) out.push(solid(bx, y + maxH - gh - 1, colW, 1, INK, z + 0.1));
  }
  return out;
}

/** A scrolling ticker of counts (kicks, snares, hats so far in the plate), one screen width per two bars. */
export function ticker(h: HudContext, y: number, tint: RGB = DIM): SpriteDraw[] {
  const c = (k: string) => counterText(countOnsets(h.au.onsets, k, h.start, h.t), 4);
  const line = `KICK ${c('kick')}  SNARE ${c('snare')}  HAT ${c('hat')}  ${h.section.role.toUpperCase()}  `;
  const out: SpriteDraw[] = [solid(0, y - 2, h.nativeW, 11, [0.01, 0.012, 0.03], 950, 0.85)];
  const lw = line.length * 6, off = Math.floor(((h.bar * h.nativeW * 0.5) % lw + lw) % lw);
  for (let x = -off; x < h.nativeW; x += lw) out.push(...text(h.pack, 'caps', line, x, y, { tint, z: 951 }));
  return out;
}

/** Bars left in the section (a timer that counts bars, not seconds). */
export function barsLeft(h: HudContext): number { return Math.max(0, Math.ceil(h.au.songBarAt(h.section.end) - h.bar - 1e-6)); }

/** A named ghost-drain bar whose level is a band of the music. */
export function energyBar(h: HudContext, x: number, y: number, w: number, label: string, level: (t: number) => number, fill: RGB, rtl = false, labelTint: RGB = INK): SpriteDraw[] {
  const { value, ghost } = ghostLevel(level, h.t);
  return [
    ...ghostBar(h.pack, x, y + 9, w, 9, value, ghost, { fill, ghost: lin('#ffffff', 0.9), pitch: 0, frame: 'bar-frame', rtl }),
    ...text(h.pack, 'caps', label, rtl ? x + w : x, y, { align: rtl ? 'right' : 'left', tint: labelTint, z: 960 }),
  ];
}

/** A charge meter that fills across the section and flashes MAX when full. */
export function chargeMeter(h: HudContext, x: number, y: number, n: number, level: number, segH = 7, low: RGB = lin('#2a8cff', 1.2), high: RGB = lin('#ff5a1a', 1.4)): SpriteDraw[] {
  return segmentedMeter(h.pack, x, y, n, segH, level, h.beat, { low, high, segW: 6, gap: 1, frame: 'panel', label: { font: 'caps', tint: HOT } });
}

/** Props: lamps that flicker on the floor and scroll with it. */
export function lamps(h: HudContext, y: number, spacing: number, palette: string, barsPerScreen: number, tint?: RGB): SpriteDraw[] {
  const clip = h.pack.clip('lamp-flicker'), frames = h.pack.clipFrames('lamp-flicker');
  if (!clip || !frames) return [];
  const f = frames[clipFrameIndex(clip.hold, true, h.t * 60)]!, out: SpriteDraw[] = [];
  const total = spacing * 6, off = Math.floor(((h.bar / barsPerScreen) * h.nativeW % total + total) % total);
  for (let x = -off + 30; x < h.nativeW + 20; x += spacing) if (x > -20) pushFrame(out, f, x, y, false, 1, palette, 50, 'normal', 1);
  void tint;
  return out;
}

/** An idle portrait from a pack actor (frame of its idle loop on the beat). */
export function portrait(h: HudContext, actor: string, x: number, y: number, flip = false, verb: 'idle' | 'walk' = 'idle', z = 960, beatShift = 0): SpriteDraw[] {
  const c = h.pack.actorClip(actor, verb), region = h.pack.regionOf(actor, 'actor');
  if (!c || !region) return [];
  const frames = h.pack.clipFrames(c.id)!, out: SpriteDraw[] = [];
  pushFrame(out, frames[loopFrame(c.clip.hold, 2, 0, h.beat + beatShift)]!, x, y, flip !== (region.facing === 'left'), 1, region.palette, z, 'normal');
  return out;
}

export { banner, box, clamp01, counterText, ghostLevel, lin, solid, text, timerText, countOnsets, segmentedMeter };
