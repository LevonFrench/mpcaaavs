/** A minimal plate body showing the fallback path: it asks for slots and never asks whether a pack exists.
 * With `pack === null` (the public build) everything is drawn from the procedural stand-ins, with the same sizes, anchors and timing
 * the real art would use. Real show plates follow this shape. Neutral slot names only; no game art here. */
import { drawGlyphs, drawSprite, type SpriteContext, type SpriteSlot, type SpriteSource } from './draw.ts';
import type { AssetPack } from './pack.ts';

export const EXAMPLE_SLOTS = Object.freeze({
  hero: { region: 'hero', role: 'actor', size: [48, 64], tone: '#4fb3d9' },
  note: { region: 'note', role: 'projectile', size: [16, 16], tone: '#f2c14e' },
  spark: { region: 'spark', role: 'effect', size: [48, 48], tone: '#ffffff' },
  gem: { region: 'gem', role: 'pickup', size: [16, 16], tone: '#e4572e' },
  meter: { region: 'meter', role: 'hud', size: [96, 12], tone: '#76b041' },
  stage: { region: 'stage', role: 'background', size: [320, 180], tone: '#3a506b' },
} as const satisfies Record<string, SpriteSlot>);
export const EXAMPLE_FONT = 'digits';

/** Draws one frame from media-time alone. `beat` is the song position in beats; there is no clock and no randomness in here. */
export function drawExamplePlate(ctx: SpriteContext, pack: AssetPack | null, beat: number): Record<string, SpriteSource> {
  const frame = beat * 12, used: Record<string, SpriteSource> = {};
  used.stage = drawSprite(ctx, pack, EXAMPLE_SLOTS.stage, 0, 0, { time: frame });
  used.hero = drawSprite(ctx, pack, EXAMPLE_SLOTS.hero, 80, 150, { time: frame, verb: beat % 4 < 2 ? 'idle' : 'attack' });
  used.note = drawSprite(ctx, pack, EXAMPLE_SLOTS.note, 100 + ((beat % 4) / 4) * 160, 120, { time: frame });
  used.spark = drawSprite(ctx, pack, EXAMPLE_SLOTS.spark, 260, 120, { time: (beat % 1) * 12 });
  used.gem = drawSprite(ctx, pack, EXAMPLE_SLOTS.gem, 200, 150, { time: frame });
  used.meter = drawSprite(ctx, pack, EXAMPLE_SLOTS.meter, 16, 12, { fill: (beat % 8) / 8 });
  drawGlyphs(ctx, pack, EXAMPLE_FONT, String(Math.floor(beat) % 100).padStart(2, '0'), 280, 8, 12);
  return used;
}
