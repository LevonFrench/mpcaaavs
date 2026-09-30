// Scene classes by show id and plate id (GL): the show worker's registry.
import type { SceneClass } from '../show/scene.ts';
import type { ShowId } from './defs.ts';
import { NERV_SCENE_CLASSES } from './nerv/index.ts';
import { PIXEL_STAGE_SCENE_CLASSES } from './pixel-stage/index.ts';

export const SHOW_SCENES: Readonly<Record<ShowId, Readonly<Record<string, SceneClass>>>> = { nerv: NERV_SCENE_CLASSES, 'pixel-stage': PIXEL_STAGE_SCENE_CLASSES };
