// AAAVS visual system V2: ten authored, audio-native subjects.
//
// Each source owns a shader and a small, semantic uniform schema.  Existing V2
// presets still use the first-generation generic keys, so every writer accepts
// those keys as a compatibility fallback.  New presets should use the named
// keys documented by each writer below.

import { AUDIO_WGSL } from '../audiogpu.ts';
import type { ParamValue, PassDescriptor } from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP } from '../renderer.ts';
import visualV2Common from '../shaders/visual-v2-sources/common.wgsl';
import eclipseCoronaBody from '../shaders/visual-v2-sources/eclipse-corona.wgsl';
import harmonicKnotBody from '../shaders/visual-v2-sources/harmonic-knot.wgsl';
import inkVortexBody from '../shaders/visual-v2-sources/ink-vortex.wgsl';
import magneticFluxBody from '../shaders/visual-v2-sources/magnetic-flux.wgsl';
import moirePortalBody from '../shaders/visual-v2-sources/moire-portal.wgsl';
import phosphorOrbitBody from '../shaders/visual-v2-sources/phosphor-orbit.wgsl';
import quasicrystalBody from '../shaders/visual-v2-sources/quasicrystal.wgsl';
import signalGardenBody from '../shaders/visual-v2-sources/signal-garden.wgsl';
import spectralCathedralBody from '../shaders/visual-v2-sources/spectral-cathedral.wgsl';
import spectralLoomBody from '../shaders/visual-v2-sources/spectral-loom.wgsl';

const PARAMS_BINDING =
  `@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> P : Params;`;

export type VisualV2SourceType =
  | 'phosphor-orbit'
  | 'quasicrystal'
  | 'magnetic-flux'
  | 'spectral-loom'
  | 'harmonic-knot'
  | 'eclipse-corona'
  | 'moire-portal'
  | 'ink-vortex'
  | 'signal-garden'
  | 'spectral-cathedral';

/** Generic-key compatibility defaults. Per-source writers expose the semantic names. */
export const VISUAL_V2_SOURCE_DEFAULTS: Readonly<Record<string, ParamValue>> = {
  amount: 1,
  scale: 1,
  density: 1,
  detail: 1,
  rate: 0.25,
  spread: 1,
  focusX: -0.22,
  focusY: 0.06,
  thickness: 1,
  bias: 0.5,
};

type Params = Readonly<Record<string, ParamValue>>;
type UniformWriter = NonNullable<PassDescriptor['writeUniforms']>;

// Periods are musical bar divisions, not free-running rates. Values are kept
// as ratios in source so additions cannot smuggle a decimal clock multiplier
// into a shader. A zero period is the explicit "hold" state.
const MUSICAL_PERIOD_BARS = [
  1 / 16, 1 / 8, 1 / 4, 1 / 2,
  1, 2, 4, 8, 16, 32, 64, 128,
] as const;

function finite(params: Params, key: string): number | undefined {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function semanticNumber(
  params: Params,
  semanticKey: string,
  legacyKey: string,
  fallback: number,
  lo: number,
  hi: number,
): number {
  const value = finite(params, semanticKey) ?? finite(params, legacyKey) ?? fallback;
  return value < lo ? lo : value > hi ? hi : value;
}

function snapPeriodBars(value: number): number {
  if (Math.abs(value) < 1e-8) return 0;
  const direction = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value);
  let closest: number = MUSICAL_PERIOD_BARS[0];
  let distance = Math.abs(magnitude - closest);
  for (const candidate of MUSICAL_PERIOD_BARS) {
    const nextDistance = Math.abs(magnitude - candidate);
    if (nextDistance < distance) {
      closest = candidate;
      distance = nextDistance;
    }
  }
  return closest * direction;
}

/**
 * Read an explicit semantic period first. Legacy `rate` was turns per bar, so
 * its exact conversion is `periodBars = 1 / rate`; the result is snapped to
 * the declared rational grid. Negative periods preserve reverse motion.
 */
function musicalPeriodBars(
  params: Params,
  semanticKey: string,
  fallbackPeriodBars: number,
): number {
  const explicit = finite(params, semanticKey);
  if (explicit !== undefined) return snapPeriodBars(explicit);
  const legacyRate = finite(params, 'rate');
  if (legacyRate === undefined) return snapPeriodBars(fallbackPeriodBars);
  if (Math.abs(legacyRate) < 1e-8) return 0;
  return snapPeriodBars(1 / legacyRate);
}

function pass(type: VisualV2SourceType) {
  return (
    body: string,
    uniformFloats: number,
    defaultResolutionScale: number,
    writeUniforms: UniformWriter,
  ): PassDescriptor => ({
    type,
    family: 'source',
    input: 'none',
    usesAudio: true,
    uniformFloats,
    code: [PASS_COMMON_WGSL, AUDIO_WGSL, PARAMS_BINDING, visualV2Common, body].join('\n'),
    defaultResolutionScale,
    writeUniforms,
  });
}

// Schema: orbitGain, orbitScale, harmonicDetail, waveformBend,
// orbitPeriodBars, orbitCenterX, orbitCenterY, traceThickness.
export const phosphorOrbitPass = pass('phosphor-orbit')(phosphorOrbitBody, 8, 1,
  (out, ctx) => {
    const p = ctx.params;
    out[0] = semanticNumber(p, 'orbitGain', 'amount', 1, 0, 4);
    out[1] = semanticNumber(p, 'orbitScale', 'scale', 1, 0.1, 4);
    out[2] = semanticNumber(p, 'harmonicDetail', 'detail', 1, 0.1, 4);
    out[3] = semanticNumber(p, 'waveformBend', 'spread', 1, 0.05, 4);
    out[4] = musicalPeriodBars(p, 'orbitPeriodBars', 4);
    out[5] = semanticNumber(p, 'orbitCenterX', 'focusX', -0.22, -1.5, 1.5);
    out[6] = semanticNumber(p, 'orbitCenterY', 'focusY', 0.06, -1.5, 1.5);
    out[7] = semanticNumber(p, 'traceThickness', 'thickness', 1, 0.25, 6);
  });

// Schema: crystalGain, specimenScale, axisDensity, ridgeDetail,
// driftPeriodBars, specimenCenterX/Y, ridgeThickness, nodeBias (+ 3 pads).
export const quasicrystalPass = pass('quasicrystal')(quasicrystalBody, 12, 0.5,
  (out, ctx) => {
    const p = ctx.params;
    out[0] = semanticNumber(p, 'crystalGain', 'amount', 1, 0, 4);
    out[1] = semanticNumber(p, 'specimenScale', 'scale', 1, 0.1, 4);
    out[2] = semanticNumber(p, 'axisDensity', 'density', 1, 0.1, 4);
    out[3] = semanticNumber(p, 'ridgeDetail', 'detail', 1, 0.1, 4);
    out[4] = musicalPeriodBars(p, 'driftPeriodBars', 4);
    out[5] = semanticNumber(p, 'specimenCenterX', 'focusX', -0.22, -1.5, 1.5);
    out[6] = semanticNumber(p, 'specimenCenterY', 'focusY', 0.06, -1.5, 1.5);
    out[7] = semanticNumber(p, 'ridgeThickness', 'thickness', 1, 0.25, 6);
    out[8] = semanticNumber(p, 'nodeBias', 'bias', 0.5, 0, 1);
  });

// Schema: fluxGain, fieldScale, contourDensity, poleSeparation,
// rotationPeriodBars, fieldCenterX, fieldCenterY, contourThickness.
export const magneticFluxPass = pass('magnetic-flux')(magneticFluxBody, 8, 0.5,
  (out, ctx) => {
    const p = ctx.params;
    out[0] = semanticNumber(p, 'fluxGain', 'amount', 1, 0, 4);
    out[1] = semanticNumber(p, 'fieldScale', 'scale', 1, 0.1, 4);
    out[2] = semanticNumber(p, 'contourDensity', 'density', 1, 0.1, 4);
    out[3] = semanticNumber(p, 'poleSeparation', 'spread', 1, 0.05, 4);
    out[4] = musicalPeriodBars(p, 'rotationPeriodBars', 4);
    out[5] = semanticNumber(p, 'fieldCenterX', 'focusX', -0.22, -1.5, 1.5);
    out[6] = semanticNumber(p, 'fieldCenterY', 'focusY', 0.06, -1.5, 1.5);
    out[7] = semanticNumber(p, 'contourThickness', 'thickness', 1, 0.25, 6);
  });

// Schema: loomGain, loomScale, warpDensity, weftDensity, weavePeriodBars,
// stereoSpread, loomCenterX/Y, threadThickness (+ 3 pads).
export const spectralLoomPass = pass('spectral-loom')(spectralLoomBody, 12, 0.5,
  (out, ctx) => {
    const p = ctx.params;
    out[0] = semanticNumber(p, 'loomGain', 'amount', 1, 0, 4);
    out[1] = semanticNumber(p, 'loomScale', 'scale', 1, 0.1, 4);
    out[2] = semanticNumber(p, 'warpDensity', 'density', 1, 0.1, 4);
    out[3] = semanticNumber(p, 'weftDensity', 'detail', 1, 0.1, 4);
    out[4] = musicalPeriodBars(p, 'weavePeriodBars', 4);
    out[5] = semanticNumber(p, 'stereoSpread', 'spread', 1, 0.05, 4);
    out[6] = semanticNumber(p, 'loomCenterX', 'focusX', -0.22, -1.5, 1.5);
    out[7] = semanticNumber(p, 'loomCenterY', 'focusY', 0.06, -1.5, 1.5);
    out[8] = semanticNumber(p, 'threadThickness', 'thickness', 1, 0.25, 6);
  });

// Schema: knotGain, knotScale, resonanceDetail, tubeSpread,
// cameraPeriodBars, knotCenterX, knotCenterY, tubeThickness.
export const harmonicKnotPass = pass('harmonic-knot')(harmonicKnotBody, 8, 0.5,
  (out, ctx) => {
    const p = ctx.params;
    out[0] = semanticNumber(p, 'knotGain', 'amount', 1, 0, 4);
    out[1] = semanticNumber(p, 'knotScale', 'scale', 1, 0.1, 4);
    out[2] = semanticNumber(p, 'resonanceDetail', 'detail', 1, 0.1, 4);
    out[3] = semanticNumber(p, 'tubeSpread', 'spread', 1, 0.05, 4);
    out[4] = musicalPeriodBars(p, 'cameraPeriodBars', 4);
    out[5] = semanticNumber(p, 'knotCenterX', 'focusX', -0.22, -1.5, 1.5);
    out[6] = semanticNumber(p, 'knotCenterY', 'focusY', 0.06, -1.5, 1.5);
    out[7] = semanticNumber(p, 'tubeThickness', 'thickness', 1, 0.25, 6);
  });

// Schema: coronaGain, diskScale, rayDensity, haloDetail, scanPeriodBars,
// coronaSpread, diskCenterX/Y, rimThickness (+ 3 pads).
export const eclipseCoronaPass = pass('eclipse-corona')(eclipseCoronaBody, 12, 1,
  (out, ctx) => {
    const p = ctx.params;
    out[0] = semanticNumber(p, 'coronaGain', 'amount', 1, 0, 4);
    out[1] = semanticNumber(p, 'diskScale', 'scale', 1, 0.1, 4);
    out[2] = semanticNumber(p, 'rayDensity', 'density', 1, 0.1, 4);
    out[3] = semanticNumber(p, 'haloDetail', 'detail', 1, 0.1, 4);
    out[4] = musicalPeriodBars(p, 'scanPeriodBars', 4);
    out[5] = semanticNumber(p, 'coronaSpread', 'spread', 1, 0.05, 4);
    out[6] = semanticNumber(p, 'diskCenterX', 'focusX', -0.22, -1.5, 1.5);
    out[7] = semanticNumber(p, 'diskCenterY', 'focusY', 0.06, -1.5, 1.5);
    out[8] = semanticNumber(p, 'rimThickness', 'thickness', 1, 0.25, 6);
  });

// Schema: moireGain, portalScale, screenDensity, screenDetune,
// turnPeriodBars, portalCenterX, portalCenterY, screenThickness.
export const moirePortalPass = pass('moire-portal')(moirePortalBody, 8, 0.5,
  (out, ctx) => {
    const p = ctx.params;
    out[0] = semanticNumber(p, 'moireGain', 'amount', 1, 0, 4);
    out[1] = semanticNumber(p, 'portalScale', 'scale', 1, 0.1, 4);
    out[2] = semanticNumber(p, 'screenDensity', 'density', 1, 0.1, 4);
    out[3] = semanticNumber(p, 'screenDetune', 'detail', 1, 0.1, 4);
    out[4] = musicalPeriodBars(p, 'turnPeriodBars', 4);
    out[5] = semanticNumber(p, 'portalCenterX', 'focusX', -0.22, -1.5, 1.5);
    out[6] = semanticNumber(p, 'portalCenterY', 'focusY', 0.06, -1.5, 1.5);
    out[7] = semanticNumber(p, 'screenThickness', 'thickness', 1, 0.25, 6);
  });

// Schema: inkGain, vortexScale, filamentDensity, curlDetail,
// evolutionPeriodBars, vortexCenterX, vortexCenterY, filamentThickness.
export const inkVortexPass = pass('ink-vortex')(inkVortexBody, 8, 0.5,
  (out, ctx) => {
    const p = ctx.params;
    out[0] = semanticNumber(p, 'inkGain', 'amount', 1, 0, 4);
    out[1] = semanticNumber(p, 'vortexScale', 'scale', 1, 0.1, 4);
    out[2] = semanticNumber(p, 'filamentDensity', 'density', 1, 0.1, 4);
    out[3] = semanticNumber(p, 'curlDetail', 'detail', 1, 0.1, 4);
    out[4] = musicalPeriodBars(p, 'evolutionPeriodBars', 4);
    out[5] = semanticNumber(p, 'vortexCenterX', 'focusX', -0.22, -1.5, 1.5);
    out[6] = semanticNumber(p, 'vortexCenterY', 'focusY', 0.06, -1.5, 1.5);
    out[7] = semanticNumber(p, 'filamentThickness', 'thickness', 1, 0.25, 6);
  });

// Schema: gardenGain, gardenScale, stemDensity, branchDetail, swayPeriodBars,
// swaySpread, gardenCenterX/Y, stemThickness (+ 3 pads).
export const signalGardenPass = pass('signal-garden')(signalGardenBody, 12, 0.5,
  (out, ctx) => {
    const p = ctx.params;
    out[0] = semanticNumber(p, 'gardenGain', 'amount', 1, 0, 4);
    out[1] = semanticNumber(p, 'gardenScale', 'scale', 1, 0.1, 4);
    out[2] = semanticNumber(p, 'stemDensity', 'density', 1, 0.1, 4);
    out[3] = semanticNumber(p, 'branchDetail', 'detail', 1, 0.1, 4);
    out[4] = musicalPeriodBars(p, 'swayPeriodBars', 4);
    out[5] = semanticNumber(p, 'swaySpread', 'spread', 1, 0.05, 4);
    out[6] = semanticNumber(p, 'gardenCenterX', 'focusX', -0.22, -1.5, 1.5);
    out[7] = semanticNumber(p, 'gardenCenterY', 'focusY', 0.06, -1.5, 1.5);
    out[8] = semanticNumber(p, 'stemThickness', 'thickness', 1, 0.25, 6);
  });

// Schema: cathedralGain, frameScale, bayDensity, columnDetail,
// travelPeriodBars, horizonCenterX, horizonCenterY, architectureThickness.
export const spectralCathedralPass = pass('spectral-cathedral')(spectralCathedralBody, 8, 0.5,
  (out, ctx) => {
    const p = ctx.params;
    out[0] = semanticNumber(p, 'cathedralGain', 'amount', 1, 0, 4);
    out[1] = semanticNumber(p, 'frameScale', 'scale', 1, 0.1, 4);
    out[2] = semanticNumber(p, 'bayDensity', 'density', 1, 0.1, 4);
    out[3] = semanticNumber(p, 'columnDetail', 'detail', 1, 0.1, 4);
    out[4] = musicalPeriodBars(p, 'travelPeriodBars', 4);
    out[5] = semanticNumber(p, 'horizonCenterX', 'focusX', -0.22, -1.5, 1.5);
    out[6] = semanticNumber(p, 'horizonCenterY', 'focusY', 0.06, -1.5, 1.5);
    out[7] = semanticNumber(p, 'architectureThickness', 'thickness', 1, 0.25, 6);
  });

export const VISUAL_V2_SOURCE_PASSES: readonly PassDescriptor[] = [
  phosphorOrbitPass,
  quasicrystalPass,
  magneticFluxPass,
  spectralLoomPass,
  harmonicKnotPass,
  eclipseCoronaPass,
  moirePortalPass,
  inkVortexPass,
  signalGardenPass,
  spectralCathedralPass,
];
