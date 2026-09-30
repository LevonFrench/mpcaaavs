// Show definitions by id (pure data, no GL): what planShow() needs to plan a show on any song map. The still renderer plans with these in
// Node; the show worker pairs them with the scene classes (src/shows/scenes.ts).
import type { ShowDef } from '../show/plan.ts';
import { NERV_SHOW } from './nerv/show-def.ts';
import { PIXEL_STAGE_SHOW } from './pixel-stage/show-def.ts';

export const SHOW_IDS = ['nerv', 'pixel-stage'] as const;
export type ShowId = typeof SHOW_IDS[number];
export const SHOW_DEFS: Readonly<Record<ShowId, ShowDef>> = { nerv: NERV_SHOW, 'pixel-stage': PIXEL_STAGE_SHOW };
export const isShowId = (x: unknown): x is ShowId => typeof x === 'string' && (SHOW_IDS as readonly string[]).includes(x);
