// The Pixel Stage show definition (pure data, no GL): a neutral demo show for the sprite layer. Plates use only the procedural test pack.
// Director mapping follows docs/design/SPRITE-SHOW-KIT.md "Section roles map to plate modes": intro = title/select, groove = dance and walk-through
// with projectile play, break = poses and menus, build = charge-up with a boss approaching and meters filling, drop = supers and a screen-wide
// moment, outro = exits. The home windows are the plates' nominal length in bars; the sprite plates read the song's own bar grid.
import type { ShowDef } from '../../show/plan.ts';

export const PIXEL_STAGE_PLATE_IDS = ['select', 'duel', 'march', 'charge', 'finale', 'gallery'] as const;
export type PixelStagePlateId = typeof PIXEL_STAGE_PLATE_IDS[number];

export const PIXEL_STAGE_SHOW: ShowDef = {
  barOff: 0,
  plates: {
    select: { home: [0, 8] }, duel: { home: [0, 8] }, march: { home: [0, 8] }, charge: { home: [0, 8] }, finale: { home: [0, 8] }, gallery: { home: [0, 8] },
  },
  roles: {
    intro: ['select'],
    groove: ['duel', 'march'],
    break: ['gallery'],
    build: ['charge'],
    drop: ['finale'],
    breakdown: ['gallery', 'select'],
    outro: ['gallery'],
  },
  intro: 'select',
  outro: 'gallery',
  maxBars: { drop: 8 },
};

/** Display names of the plates (the header line). */
export const PIXEL_STAGE_NAMES: Record<PixelStagePlateId, string> = { select: 'SELECT', duel: 'DUEL', march: 'MARCH', charge: 'CHARGE', finale: 'FINALE', gallery: 'GALLERY' };
