// The operator registry.
//
// One list, so that `main.ts` registers every operator by importing a directory
// rather than by remembering a set of names. The failure this prevents is
// specific and has already happened once in this project: a pass module lands,
// typechecks, bundles, and is never registered, so every preset that names it
// prints one `no pass registered for type` warning and renders nothing. A
// barrel makes "written" and "reachable" the same act.
//
// It holds NO device, NO buffer and NO pipeline — a `PassDescriptor` is data
// plus pure functions (contracts.ts), which is what lets the preset validator
// and the golden harness import this on a machine with no GPU.
//
// `feedbackPass` lives here because its shader is an operator's shader and it
// sits next to the others on disk, but its `family` is `'feedback'`, not
// `'operator'` — the family decides scheduling (`planStack` gives it its own
// history pair and a separate composite entry) and the renderer refuses any
// layer whose `LayerSpec.family` disagrees with its descriptor. A preset that
// wants a trail therefore writes `family: 'feedback'`.

import type { PassDescriptor } from '../contracts.ts';

import { ditherPass } from './dither.ts';
import { feedbackPass } from './feedback.ts';
import { kaleidoPass } from './kaleido.ts';
import { mirrorPass } from './mirror.ts';
import { polarPass } from './polar.ts';
import { tilePass } from './tile.ts';
import {
  bloomPass, chromaticPass, displacePass, glitchPass, gradePass, crtPass,
  contourPass, neonPass, scanwarpPass,
} from './modernfx.ts';
import { VISUAL_V2_OPERATOR_PASSES } from './visual-v2.ts';
import { TEMPORAL_V2_PASSES } from './temporal-v2.ts';

/**
 * Every pass in this directory, in alphabetical order by module.
 *
 * Order is irrelevant to the renderer — `register` is keyed by `type` — so it is
 * alphabetical rather than meaningful, which stops it drifting into an implied
 * priority nobody wrote down.
 */
export const OPERATOR_PASSES: readonly PassDescriptor[] = [
  // V2 first: authored composition and genuine temporal treatments.
  ...VISUAL_V2_OPERATOR_PASSES,
  ...TEMPORAL_V2_PASSES,
  ditherPass,
  feedbackPass,
  kaleidoPass,
  mirrorPass,
  polarPass,
  tilePass,
  bloomPass,
  chromaticPass,
  displacePass,
  glitchPass,
  gradePass,
  crtPass,
  contourPass,
  neonPass,
  scanwarpPass,
];

export { feedbackPass, FEEDBACK_DEFAULTS } from './feedback.ts';
export { kaleidoPass, KALEIDO_DEFAULTS } from './kaleido.ts';
export { mirrorPass, MIRROR_DEFAULTS } from './mirror.ts';
export { polarPass, POLAR_DEFAULTS } from './polar.ts';
export { tilePass, TILE_DEFAULTS } from './tile.ts';

export { ditherPass, DITHER_DEFAULTS } from './dither.ts';
export {
  bloomPass, chromaticPass, displacePass, glitchPass, gradePass, crtPass,
  contourPass, neonPass, scanwarpPass, MODERN_FX_DEFAULTS,
} from './modernfx.ts';
export {
  negativeSpacePass, diffractionPass, engravePass, foldglassPass,
  rankStretchPass, risoPass, edgeflowPass, lensfieldPass, dropRestPass,
  VISUAL_V2_OPERATOR_PASSES, VISUAL_V2_OPERATOR_DEFAULTS,
} from './visual-v2.ts';
export {
  temporalPrismPass, slitMemoryPass, TEMPORAL_V2_PASSES, TEMPORAL_V2_DEFAULTS,
} from './temporal-v2.ts';
