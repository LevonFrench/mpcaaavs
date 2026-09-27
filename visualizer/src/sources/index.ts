// The source registry. See `../ops/index.ts` for the argument; it is the same
// one, and the two files are deliberately symmetrical.
//
// A `source` reads nothing and draws INTO the accumulator, which is what lets
// `planStack` merge a consecutive run of them into a single render pass — the
// largest saving available at 2K120 (§4.11). Every descriptor here therefore
// declares `input: 'none'`; the renderer would force it anyway, but stating it
// is what keeps someone from adding `input: 'accumulator'` to a source and
// wondering why it samples black.
//
// Grouped by family rather than alphabetically: which art-direction look (§1) a
// source belongs to matters far more when building a preset than where its name
// falls in the alphabet.

import type { PassDescriptor } from '../contracts.ts';

// --- strange attractors (plan §8.3) ------------------------------------------
// Continuous 3D FLOWS. A compute prepass advances M independent trajectories in
// a storage buffer — parallel across trajectories, serial along each, because
// p[n+1] = f(p[n]) cannot be split — then a draw pass emits a quad per SEGMENT.
// Segments, not dots: 24k gaussian points average into fog.
import { lorenzPass } from './lorenz.ts';
import { rosslerPass } from './rossler.ts';
import { thomasPass } from './thomas.ts';
import { halvorsenPass } from './halvorsen.ts';
// 2D iterated MAPS, not flows. Each step jumps a long way, so drawing segments
// between successive points paints chords across the figure — these plot points
// and let density build the image instead.
import { cliffordPass } from './clifford.ts';
import { dejongPass } from './dejong.ts';

// --- waveform (plan §8.1) ----------------------------------------------------
import { scopePass } from './scope.ts';
import { ribbonPass } from './ribbon.ts';
import { spiralPass } from './spiral.ts';
import { wavegridPass } from './wavegrid.ts';

// --- spectrum (plan §8.2) ----------------------------------------------------
import { spectrumPass } from './spectrum.ts';
import { radialBarsPass } from './radialbars.ts';
import { butterflyPass } from './butterfly.ts';
// The payoff of the Phase 0 stereo work: every bin drawn at its own pan
// position. The only consumer of per-bin pan anywhere in the project.
import { stereoFieldPass } from './stereofield.ts';

// --- history-backed (read the spectrogram ring) ------------------------------
import { waterfallPass } from './waterfall.ts';
import { scopetunnelPass } from './scopetunnel.ts';

// --- audio-native geometry (plan §8.6) ---------------------------------------
import { chladniPass } from './chladni.ts';
import {
  particlesPass, lissajousPass, reactionPass, voronoiPass,
  flowfieldPass, heightmeshPass, hypercylinderPass, gridtunnelPass, dometunnelPass, pylonsPass,
} from './generative.ts';
import { VISUAL_V2_SOURCE_PASSES } from './visual-v2.ts';

/**
 * Every source in this directory.
 *
 * Order is meaningless to the renderer — a layer names its `type` and this is a
 * lookup. It is not meaningless to a human, so it stays grouped.
 */
export const SOURCE_PASSES: readonly PassDescriptor[] = [
  // V2 authored subjects are first so the add-layer menu presents the current
  // visual language before the compatibility library.
  ...VISUAL_V2_SOURCE_PASSES,
  // attractors — flows
  lorenzPass, rosslerPass, thomasPass, halvorsenPass,
  // attractors — maps
  cliffordPass, dejongPass,
  // waveform
  scopePass, ribbonPass, spiralPass, wavegridPass,
  // spectrum
  spectrumPass, radialBarsPass, butterflyPass, stereoFieldPass,
  // history
  waterfallPass, scopetunnelPass,
  // geometry
  chladniPass,
  // procedural audio fields
  particlesPass, lissajousPass, reactionPass, voronoiPass,
  flowfieldPass, heightmeshPass, hypercylinderPass, gridtunnelPass, dometunnelPass, pylonsPass,
];

export { lorenzPass, LORENZ_DEFAULTS } from './lorenz.ts';
export { rosslerPass } from './rossler.ts';
export { thomasPass } from './thomas.ts';
export { halvorsenPass } from './halvorsen.ts';
export { cliffordPass } from './clifford.ts';
export { dejongPass } from './dejong.ts';
export { scopePass } from './scope.ts';
export { ribbonPass } from './ribbon.ts';
export { spiralPass } from './spiral.ts';
export { wavegridPass } from './wavegrid.ts';
export { spectrumPass } from './spectrum.ts';
export { radialBarsPass } from './radialbars.ts';
export { butterflyPass } from './butterfly.ts';
export { stereoFieldPass } from './stereofield.ts';
export { waterfallPass } from './waterfall.ts';
export { scopetunnelPass } from './scopetunnel.ts';
export { chladniPass } from './chladni.ts';
export {
  particlesPass, lissajousPass, reactionPass, voronoiPass,
  flowfieldPass, heightmeshPass, hypercylinderPass, gridtunnelPass, dometunnelPass, pylonsPass,
  GENERATIVE_DEFAULTS,
} from './generative.ts';
export {
  phosphorOrbitPass, quasicrystalPass, magneticFluxPass, spectralLoomPass,
  harmonicKnotPass, eclipseCoronaPass, moirePortalPass, inkVortexPass,
  signalGardenPass, spectralCathedralPass, VISUAL_V2_SOURCE_PASSES,
  VISUAL_V2_SOURCE_DEFAULTS,
} from './visual-v2.ts';
