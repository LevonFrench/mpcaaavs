// AAAVS visual system V2 preset bank.
//
// Sixteen AVS-minded scenes, four coherent looks. Each scene now builds a small
// effect list: multiple audio geometries interact through non-trivial blends,
// a dedicated history layer carries motion between frames, and spatial passes
// finish the chain. The authored V2 subjects remain, but no longer sit alone on
// a tasteful black field pretending that restraint is the same thing as depth.

import type { LayerSpec, Palette, Preset } from '../contracts.ts';
import type { DirectorEntry } from '../director.ts';

type Slot = LayerSpec['palette'];
type Params = LayerSpec['params'];
type Options = Partial<LayerSpec>;

function gate(
  division: LayerSpec['trigger']['division'],
  euclidK = 1,
  euclidN = 1,
  offsetSteps = 0,
): LayerSpec['trigger'] {
  return { division, euclidK, euclidN, probability: 1, offsetSteps };
}

function fade(attackBeats: number, holdBeats: number, releaseBeats: number): LayerSpec['envelope'] {
  return { attackBeats, holdBeats, releaseBeats };
}

function base(spec: Partial<LayerSpec> & { id: string; type: string }): LayerSpec {
  return {
    family: 'source',
    params: {},
    blend: 'add',
    opacity: 1,
    // Safe continuous default. A recurring trigger with a non-zero attack
    // hard-resets the subject; V2 rhythms live in shape/treatments instead.
    envelope: fade(0, 16.5, 2),
    trigger: gate('4bar'),
    anchor: 'start',
    palette: 'primary',
    enabled: true,
    resolutionScale: 0.5,
    ...spec,
  } as LayerSpec;
}

const sustain = (
  division: LayerSpec['trigger']['division'],
  holdBeats: number,
): Pick<LayerSpec, 'trigger' | 'envelope' | 'anchor'> => ({
  trigger: gate(division),
  envelope: fade(0, holdBeats, 2),
  anchor: 'start',
});

// A bounded accent is allowed to retrigger because its complete envelope is
// shorter than the shortest pulse gap. Primaries never use this helper.
const accentPulse = (
  division: LayerSpec['trigger']['division'],
  attackBeats: number,
  holdBeats: number,
  releaseBeats: number,
): Pick<LayerSpec, 'trigger' | 'envelope' | 'anchor'> => ({
  trigger: gate(division),
  envelope: fade(attackBeats, holdBeats, releaseBeats),
  anchor: 'peak',
});

// One event on the fourth bar of each four-bar phrase. It completes before the
// next event, so unlike a retriggered primary it never resets a live envelope.
const phraseRest = (): Pick<LayerSpec, 'trigger' | 'envelope' | 'anchor'> => ({
  trigger: gate('bar', 1, 4, 1),
  envelope: fade(0, 4, 0),
  anchor: 'start',
});

const source = (id: string, type: string, palette: Slot, params: Params = {}, extra: Options = {}) =>
  base({ id, type, palette, params, ...extra });

const effect = (id: string, type: string, palette: Slot, params: Params = {}, extra: Options = {}) =>
  base({ id, type, family: 'operator', blend: 'replace', palette, params, ...extra });

const memory = (id: string, type: 'temporal-prism' | 'slit-memory' | 'feedback', palette: Slot, params: Params = {}, extra: Options = {}) =>
  base({ id, type, family: 'feedback', blend: 'add', palette, params, ...extra });

const scene = (name: string, seed: number, palette: Palette, layers: LayerSpec[]): Preset =>
  ({ version: 1, name, seed, palette, layers });

// Four palettes only. Each frame stays inside one visual language and exposes
// the same role slots to every pass.
export const V2_LAB: Palette = {
  name: 'v2-lab',
  bg: { l: 0.010, c: 0.006, h: 205, intensity: 1 },
  primary: { l: 0.84, c: 0.14, h: 158, intensity: 1.85 },
  secondary: { l: 0.62, c: 0.085, h: 188, intensity: 0.72 },
  accent: { l: 0.90, c: 0.13, h: 82, intensity: 2.35 },
  ramp: [],
};

export const V2_GRID: Palette = {
  name: 'v2-grid',
  bg: { l: 0.008, c: 0.010, h: 252, intensity: 1 },
  primary: { l: 0.76, c: 0.18, h: 205, intensity: 2.15 },
  secondary: { l: 0.64, c: 0.22, h: 322, intensity: 1.42 },
  accent: { l: 0.91, c: 0.16, h: 62, intensity: 2.85 },
  ramp: [],
};

export const V2_INK: Palette = {
  name: 'v2-ink',
  bg: { l: 0.018, c: 0.008, h: 44, intensity: 1 },
  primary: { l: 0.88, c: 0.025, h: 72, intensity: 1.0 },
  secondary: { l: 0.62, c: 0.025, h: 48, intensity: 0.76 },
  accent: { l: 0.62, c: 0.20, h: 30, intensity: 1.75 },
  ramp: [],
};

export const V2_RAVE: Palette = {
  name: 'v2-rave',
  bg: { l: 0.010, c: 0.018, h: 300, intensity: 1 },
  primary: { l: 0.70, c: 0.25, h: 326, intensity: 2.15 },
  secondary: { l: 0.77, c: 0.17, h: 198, intensity: 1.65 },
  accent: { l: 0.92, c: 0.19, h: 96, intensity: 3.0 },
  ramp: [],
};

// LAB — phosphor geometry pushed through scopes, feedback and optical folds.
export const cathodeOrbit = scene('cathode-orbit', 0x210001, V2_LAB, [
  source('orbit', 'phosphor-orbit', 'primary',
    { scale: 1.1, detail: 1.25, spread: 0.75, rate: 0.125, focusX: -0.24, focusY: 0.07, thickness: 0.75 },
    { resolutionScale: 1, ...sustain('2bar', 8.5) }),
  source('beam-trace', 'scope', 'accent',
    { mode: 'dots', gain: 1.85, thickness: 0.004 },
    { blend: 'max', opacity: 0.7, resolutionScale: 1, ...accentPulse('beat', 0.02, 0.12, 0.55) }),
  memory('tube-burn', 'feedback', 'primary',
    { tauBeats: 1.8, gain: 0.78, zoomPerBeat: 1.018, rotTurnsPerBar: -0.018, centreX: 0.42, centreY: 0.54, clipKnee: 0.72, clipCeiling: 1.12 },
    { opacity: 0.5, ...sustain('2bar', 8.5) }),
  effect('split-phosphor', 'diffraction', 'secondary',
    { amount: 0.36, strength: 0.68, radius: 1.1, detail: 0.85, threshold: 0.38, angle: 0.08 },
    { opacity: 0.48, resolutionScale: 1, ...sustain('bar', 4.5) }),
]);

export const fluxCartography = scene('flux-cartography', 0x210002, V2_LAB, [
  source('field', 'magnetic-flux', 'primary',
    { scale: 1.05, density: 1.18, spread: 1.15, rate: 0.125, focusX: 0.18, focusY: 0.02, thickness: 0.72 },
    { resolutionScale: 0.5, ...sustain('2bar', 8.5) }),
  source('stereo-current', 'stereofield', 'accent',
    { gain: 1.1, gamma: 0.62, spread: 0.86 },
    { blend: 'subtract', opacity: 0.55, resolutionScale: 1, ...sustain('bar', 4.5) }),
  memory('field-memory', 'feedback', 'secondary',
    { tauBeats: 2.6, gain: 0.66, zoomPerBeat: 0.994, rotTurnsPerBar: 0.028, driftX: 0.025, centreX: 0.62, centreY: 0.46, clipKnee: 0.7, clipCeiling: 1.04 },
    { opacity: 0.46, ...sustain('2bar', 8.5) }),
  effect('current-edges', 'edgeflow', 'primary',
    { amount: 0.48, strength: 0.76, radius: 1.1, detail: 1.2, rate: 0.25, angle: -0.12 },
    { opacity: 0.58, resolutionScale: 1, ...sustain('bar', 4.5) }),
]);

export const harmonicSpecimen = scene('harmonic-specimen', 0x210003, V2_LAB, [
  source('knot', 'harmonic-knot', 'primary',
    { scale: 1.18, detail: 1.2, spread: 0.7, rate: 0.125, focusX: -0.12, focusY: 0.02, thickness: 0.8 },
    { resolutionScale: 0.5, ...sustain('2bar', 8.5) }),
  source('radial-harmonics', 'radialbars', 'accent',
    { bars: 48, gain: 0.92, gamma: 0.64, innerRadius: 0.16, reach: 0.36, spinBars: -12 },
    { blend: 'max', opacity: 0.56, resolutionScale: 1, ...sustain('bar', 4.5) }),
  memory('harmonic-afterimage', 'feedback', 'primary',
    { tauBeats: 1.35, gain: 0.82, zoomPerBeat: 1.026, rotTurnsPerBar: 0.04, centreX: 0.47, centreY: 0.48, clipKnee: 0.74, clipCeiling: 1.1 },
    { opacity: 0.52, ...sustain('2bar', 8.5) }),
  effect('glass-harmonics', 'foldglass', 'secondary',
    { amount: 0.46, strength: 0.76, radius: 1.05, detail: 0.9, rate: 0.25, focusX: -0.16, focusY: 0.04, angle: 0.1 },
    { opacity: 0.52, resolutionScale: 1, ...sustain('bar', 4.5) }),
]);

export const quasicrystalScan = scene('quasicrystal-scan', 0x210004, V2_LAB, [
  source('specimen', 'quasicrystal', 'secondary',
    { scale: 1.18, density: 0.78, detail: 0.8, rate: 0.0625, focusX: 0.24, focusY: -0.04, thickness: 0.65, bias: 0.42 },
    { opacity: 0.78, resolutionScale: 0.5, ...sustain('4bar', 16.5) }),
  source('crystal-scope', 'scope', 'accent',
    { mode: 'line', gain: 2.1, thickness: 0.0035 },
    { blend: 'xor', opacity: 0.38, resolutionScale: 1, ...accentPulse('half', 0.02, 0.14, 0.28) }),
  memory('crystal-recursion', 'feedback', 'secondary',
    { tauBeats: 3.4, gain: 0.58, zoomPerBeat: 1.008, rotTurnsPerBar: -0.012, driftY: 0.018, centreX: 0.58, centreY: 0.4, clipKnee: 0.68, clipCeiling: 0.98 },
    { opacity: 0.42, ...sustain('2bar', 8.5) }),
  effect('crystal-ranks', 'rank-stretch', 'primary',
    { amount: 0.42, strength: 0.62, radius: 1.0, detail: 1.4, rate: 0.125, angle: 0.25 },
    { opacity: 0.46, resolutionScale: 1, ...sustain('2bar', 8.5) }),
]);

// GRID — fixed horizon, continuous travel, structural light.
export const cathedralDrive = scene('cathedral-drive', 0x220001, V2_GRID, [
  source('architecture', 'spectral-cathedral', 'primary',
    { scale: 1.1, density: 1.0, detail: 1.25, rate: 0.5, focusX: 0, focusY: -0.03, thickness: 0.8 },
    { resolutionScale: 0.5, ...sustain('2bar', 8.5) }),
  source('cathedral-meter', 'spectrum', 'accent',
    { bars: 72, gain: 1.08, gamma: 0.58, height: 0.44 },
    { blend: 'max', opacity: 0.5, resolutionScale: 1, ...accentPulse('beat', 0.02, 0.14, 0.55) }),
  memory('nave-feedback', 'feedback', 'primary',
    { tauBeats: 1.55, gain: 0.8, zoomPerBeat: 1.022, driftY: -0.02, centreX: 0.5, centreY: 0.66, clipKnee: 0.74, clipCeiling: 1.12 },
    { opacity: 0.52, ...sustain('2bar', 8.5) }),
  effect('horizon-diffraction', 'diffraction', 'accent',
    { amount: 0.38, strength: 0.72, radius: 1.2, detail: 0.7, threshold: 0.58, angle: 0 },
    { opacity: 0.34, resolutionScale: 1, ...accentPulse('bar', 0.05, 0.45, 2.4) }),
]);

export const eclipseTransit = scene('eclipse-transit', 0x220002, V2_GRID, [
  source('eclipse', 'eclipse-corona', 'accent',
    { scale: 1.12, density: 1.05, detail: 0.9, rate: 0.25, spread: 0.8, focusX: 0.34, focusY: 0.18, thickness: 0.75 },
    { resolutionScale: 1, ...sustain('2bar', 8.5) }),
  source('distant-arches', 'spectral-cathedral', 'secondary',
    { scale: 0.92, density: 0.6, detail: 0.7, rate: 0.25, focusX: 0, focusY: -0.12, thickness: 0.58 },
    { opacity: 0.3, resolutionScale: 0.5, ...sustain('4bar', 16.5) }),
  source('eclipse-dial', 'radialbars', 'primary',
    { bars: 40, gain: 1.0, gamma: 0.6, innerRadius: 0.2, reach: 0.3, centreX: 0.34, centreY: 0.18, spinBars: 16 },
    { blend: 'subtract', opacity: 0.46, resolutionScale: 1, ...sustain('bar', 4.5) }),
  memory('umbra-trail', 'feedback', 'secondary',
    { tauBeats: 2.1, gain: 0.7, zoomPerBeat: 1.014, rotTurnsPerBar: 0.022, centreX: 0.34, centreY: 0.18, clipKnee: 0.7, clipCeiling: 1.04 },
    { opacity: 0.44, ...sustain('2bar', 8.5) }),
  effect('optic', 'lensfield', 'primary',
    { amount: 0.28, strength: 0.52, radius: 0.75, detail: 1, focusX: 0.34, focusY: 0.18, mix: 0.7 },
    { opacity: 0.28, resolutionScale: 1, ...accentPulse('bar', 0.05, 0.35, 2.2) }),
]);

export const moireTerminal = scene('moire-terminal', 0x220003, V2_GRID, [
  source('portal', 'moire-portal', 'primary',
    { scale: 1.08, density: 0.86, detail: 0.85, rate: 0.25, focusX: -0.3, focusY: 0.08, thickness: 0.62 },
    { resolutionScale: 0.5, ...sustain('2bar', 8.5) }),
  source('terminal-horizon', 'spectral-cathedral', 'secondary',
    { scale: 1.08, density: 0.52, detail: 0.62, rate: 0.125, focusX: 0, focusY: -0.16, thickness: 0.5 },
    { opacity: 0.16, resolutionScale: 0.5, ...sustain('4bar', 16.5) }),
  source('terminal-bars', 'spectrum', 'accent',
    { bars: 96, gain: 1.2, gamma: 0.54, height: 0.34 },
    { blend: 'xor', opacity: 0.34, resolutionScale: 1, ...accentPulse('half', 0.015, 0.12, 0.3) }),
  memory('moire-burn', 'feedback', 'primary',
    { tauBeats: 1.9, gain: 0.74, zoomPerBeat: 0.991, rotTurnsPerBar: -0.032, driftX: -0.018, centreX: 0.36, centreY: 0.54, clipKnee: 0.69, clipCeiling: 1.02 },
    { opacity: 0.5, ...sustain('2bar', 8.5) }),
  effect('etched-terminal', 'engrave', 'secondary',
    { amount: 0.5, strength: 0.74, radius: 1.1, detail: 1.25, rate: 0.25, angle: -0.08 },
    { opacity: 0.56, resolutionScale: 1, ...sustain('bar', 4.5) }),
]);

export const signalArchitecture = scene('signal-architecture', 0x220004, V2_GRID, [
  source('facade', 'spectral-loom', 'primary',
    { scale: 1.12, density: 0.9, detail: 0.72, rate: 0.25, focusX: 0.22, focusY: 0, thickness: 0.64 },
    { resolutionScale: 0.5, ...sustain('2bar', 8.5) }),
  source('facade-horizon', 'spectral-cathedral', 'secondary',
    { scale: 1.12, density: 0.46, detail: 0.56, rate: 0.125, focusX: 0, focusY: -0.18, thickness: 0.46 },
    { opacity: 0.14, resolutionScale: 0.5, ...sustain('4bar', 16.5) }),
  source('facade-scope', 'scope', 'accent',
    { mode: 'line', gain: 2.35, thickness: 0.0045 },
    { blend: 'max', opacity: 0.62, resolutionScale: 1, ...accentPulse('beat', 0.015, 0.12, 0.58) }),
  memory('facade-echo', 'feedback', 'secondary',
    { tauBeats: 1.45, gain: 0.84, zoomPerBeat: 1.028, driftY: 0.025, centreX: 0.64, centreY: 0.58, clipKnee: 0.76, clipCeiling: 1.14 },
    { opacity: 0.48, ...sustain('2bar', 8.5) }),
  effect('architectural-split', 'diffraction', 'primary',
    { amount: 0.32, strength: 0.64, radius: 1.2, detail: 1.1, threshold: 0.46, angle: 0.22 },
    { opacity: 0.44, resolutionScale: 1, ...sustain('bar', 4.5) }),
]);

// INK — quiet evolution, paper/black/vermilion, no visible loop.
export const vortexManuscript = scene('vortex-manuscript', 0x230001, V2_INK, [
  source('vortex', 'ink-vortex', 'primary',
    { scale: 1.2, density: 0.74, detail: 1.15, rate: 0.0625, focusX: -0.34, focusY: 0.08, thickness: 0.8 },
    { opacity: 0.88, resolutionScale: 0.5, ...sustain('4bar', 16.5) }),
  memory('wash-memory', 'slit-memory', 'secondary',
    { tauBeats: 7.2, gain: 0.18, driftY: 0.012, splitPx: 0.7, rate: 0.03125, detail: 0.3, clipKnee: 0.56, clipCeiling: 0.84 },
    { opacity: 0.13, resolutionScale: 0.5, ...sustain('2bar', 8.5) }),
  source('ink-oscilloscope', 'scope', 'accent',
    { mode: 'dots', gain: 1.7, thickness: 0.003 },
    { blend: 'multiply', opacity: 0.52, resolutionScale: 1, ...accentPulse('beat', 0.02, 0.1, 0.52) }),
  memory('vortex-recursion', 'feedback', 'primary',
    { tauBeats: 3.8, gain: 0.5, zoomPerBeat: 1.006, rotTurnsPerBar: 0.024, driftX: 0.014, centreX: 0.34, centreY: 0.46, clipKnee: 0.6, clipCeiling: 0.88 },
    { opacity: 0.36, ...sustain('2bar', 8.5) }),
  effect('paper-negative', 'negative-space', 'primary',
    { amount: 0.32, strength: 0.62, radius: 1.1, detail: 0.8, threshold: 0.54 },
    { opacity: 0.38, resolutionScale: 1, ...sustain('2bar', 8.5) }),
]);

export const botanicalSignal = scene('botanical-signal', 0x230002, V2_INK, [
  source('garden', 'signal-garden', 'primary',
    { scale: 1.05, density: 0.72, detail: 0.7, rate: 0.125, spread: 0.7, focusX: 0.16, focusY: -0.02, thickness: 0.75 },
    { resolutionScale: 0.5, ...sustain('4bar', 16.5) }),
  memory('garden-memory', 'slit-memory', 'secondary',
    { tauBeats: 5.6, gain: 0.2, driftX: 0.01, splitPx: 0.65, rate: 0.03125, detail: 0.28, clipKnee: 0.58, clipCeiling: 0.86 },
    { opacity: 0.12, resolutionScale: 0.5, ...sustain('2bar', 8.5) }),
  source('spore-cloud', 'particles', 'accent',
    { density: 1.1, scale: 0.8, spread: 1.25, speed: 0.58 },
    { blend: 'max', opacity: 0.44, resolutionScale: 0.5, ...accentPulse('beat', 0.02, 0.12, 0.54) }),
  memory('root-afterimage', 'feedback', 'secondary',
    { tauBeats: 2.9, gain: 0.58, zoomPerBeat: 1.012, rotTurnsPerBar: -0.018, driftY: 0.012, centreX: 0.58, centreY: 0.44, clipKnee: 0.62, clipCeiling: 0.92 },
    { opacity: 0.4, ...sustain('2bar', 8.5) }),
  effect('vein-flow', 'edgeflow', 'primary',
    { amount: 0.38, strength: 0.66, radius: 0.95, detail: 1.3, rate: 0.125, angle: 0.16 },
    { opacity: 0.44, resolutionScale: 1, ...sustain('bar', 4.5) }),
]);

export const paperAttractor = scene('paper-attractor', 0x230003, V2_INK, [
  source('ink-map', 'clifford', 'primary',
    {
      aBase: -1.4, aHigh: 0.08, aPulse: 0.04,
      brightBase: 0.046, brightLevel: 0.105, brightEnv: 0.03,
      thickness: 0.0018, spinBars: 96, hueBars: 160,
    },
    { opacity: 0.7, resolutionScale: 1, ...sustain('4bar', 16.5) }),
  memory('paper-age', 'slit-memory', 'secondary',
    { tauBeats: 6.4, gain: 0.22, splitPx: 0.8, rate: 0.03125, detail: 0.35, clipKnee: 0.58, clipCeiling: 0.88 },
    { opacity: 0.16, resolutionScale: 0.5, ...sustain('2bar', 8.5) }),
  source('paper-trace', 'scope', 'accent',
    { mode: 'line', gain: 1.45, thickness: 0.0028 },
    { blend: 'subtract', opacity: 0.42, resolutionScale: 1, ...accentPulse('beat', 0.02, 0.12, 0.55) }),
  memory('map-recursion', 'feedback', 'primary',
    { tauBeats: 4.2, gain: 0.46, zoomPerBeat: 0.997, rotTurnsPerBar: 0.014, driftX: -0.01, centreX: 0.44, centreY: 0.52, clipKnee: 0.58, clipCeiling: 0.86 },
    { opacity: 0.34, ...sustain('2bar', 8.5) }),
  effect('attractor-engraving', 'engrave', 'primary',
    { amount: 0.58, strength: 0.82, radius: 0.9, detail: 1.45, rate: 0.0625, angle: -0.18 },
    { opacity: 0.6, resolutionScale: 1, ...sustain('2bar', 8.5) }),
]);

export const blackWaterLoom = scene('black-water-loom', 0x230004, V2_INK, [
  source('loom', 'spectral-loom', 'primary',
    { scale: 1.18, density: 0.62, detail: 0.58, rate: 0.0625, spread: 0.65, focusX: -0.2, focusY: 0.03, thickness: 0.65 },
    { opacity: 0.74, resolutionScale: 1, ...sustain('4bar', 16.5) }),
  memory('old-ink', 'slit-memory', 'secondary',
    { tauBeats: 3.2, gain: 0.3, splitPx: 1.4, rate: 0.0625, detail: 0.5, clipKnee: 0.62, clipCeiling: 0.94 },
    { opacity: 0.22, resolutionScale: 0.5, ...sustain('2bar', 8.5) }),
  source('loom-spectrum', 'spectrum', 'accent',
    { bars: 80, gain: 0.9, gamma: 0.68, height: 0.38 },
    { blend: 'xor', opacity: 0.28, resolutionScale: 1, ...accentPulse('half', 0.02, 0.12, 0.3) }),
  memory('black-water-feedback', 'feedback', 'primary',
    { tauBeats: 3.25, gain: 0.56, zoomPerBeat: 1.01, rotTurnsPerBar: -0.02, driftY: -0.012, centreX: 0.38, centreY: 0.56, clipKnee: 0.61, clipCeiling: 0.9 },
    { opacity: 0.38, ...sustain('2bar', 8.5) }),
  effect('two-ink-print', 'riso', 'accent',
    { amount: 0.42, strength: 0.7, radius: 1, detail: 1.15, rate: 0.125, angle: 0.12 },
    { opacity: 0.48, resolutionScale: 1, ...sustain('bar', 4.5) }),
]);

// RAVE — authored impact, bounded rest, one dominant deformation at a time.
export const prismOverload = scene('prism-overload', 0x240001, V2_RAVE, [
  source('wings', 'butterfly', 'primary',
    { gain: 1.35, gamma: 0.58, span: 0.28, spread: 0.96, centreY: 0.52, bodyLevel: 0.34, capLevel: 1.2, stereo: 1, weightVar: 1.7 },
    { resolutionScale: 1, ...sustain('4bar', 16.5) }),
  memory('prism-memory', 'temporal-prism', 'secondary',
    { tauBeats: 1.0, gain: 0.62, driftX: 0.02, splitPx: 3.2, rate: 0.5, detail: 1.0, focusX: -0.24, focusY: 0.08 },
    { opacity: 0.46, resolutionScale: 0.5, ...sustain('2bar', 8.5) }),
  source('prism-meter', 'spectrum', 'accent',
    { bars: 96, gain: 1.28, gamma: 0.5, height: 0.5 },
    { blend: 'xor', opacity: 0.46, resolutionScale: 1, ...accentPulse('half', 0.015, 0.11, 0.3) }),
  effect('prism-split', 'diffraction', 'secondary',
    { amount: 0.62, strength: 0.92, radius: 1.4, detail: 1.3, threshold: 0.32, angle: 0.16 },
    { opacity: 0.68, resolutionScale: 1, ...accentPulse('beat', 0.015, 0.12, 0.58) }),
  effect('phrase-rest', 'drop-rest', 'accent',
    { amount: 1, strength: 1 },
    { opacity: 1, resolutionScale: 1, ...phraseRest() }),
]);

export const foldEngine = scene('fold-engine', 0x240002, V2_RAVE, [
  source('spiral-array', 'radialbars', 'primary',
    { bars: 56, gain: 1.15, gamma: 0.58, gap: 0.24, innerRadius: 0.18, reach: 0.42, centreX: 0.2, centreY: -0.06, bodyLevel: 0.48, capLevel: 1.25, sweep: 0.86, spinBars: 8 },
    { resolutionScale: 1, ...sustain('4bar', 16.5) }),
  source('fold-scope', 'scope', 'accent',
    { mode: 'dots', gain: 2.4, thickness: 0.0045 },
    { blend: 'max', opacity: 0.72, resolutionScale: 1, ...accentPulse('beat', 0.015, 0.1, 0.55) }),
  memory('fold-feedback', 'feedback', 'secondary',
    { tauBeats: 1.05, gain: 0.88, zoomPerBeat: 1.035, rotTurnsPerBar: 0.06, driftX: 0.02, centreX: 0.35, centreY: 0.46, clipKnee: 0.78, clipCeiling: 1.18 },
    { opacity: 0.56, ...sustain('2bar', 8.5) }),
  effect('fold', 'foldglass', 'secondary',
    { amount: 0.62, strength: 0.9, radius: 1.15, detail: 1.0, rate: 0.5, focusX: 0.26, focusY: 0.02, angle: 0.18 },
    { opacity: 0.64, resolutionScale: 1, ...accentPulse('half', 0.04, 0.18, 0.7) }),
  effect('phrase-rest', 'drop-rest', 'accent',
    { amount: 1, strength: 1 },
    { opacity: 1, resolutionScale: 1, ...phraseRest() }),
]);

export const temporalArray = scene('temporal-array', 0x240003, V2_RAVE, [
  source('three-lobe', 'halvorsen', 'secondary',
    { trajectories: 24000, substeps: 8, simPerBeat: 0.2, spinBars: 12, hueBars: 24, brightBase: 0.07, brightLevel: 0.15, brightEnv: 0.02, fit: 0.082, thickness: 0.0022 },
    { resolutionScale: 0.5, ...sustain('4bar', 16.5) }),
  memory('slits', 'slit-memory', 'primary',
    { tauBeats: 1.15, gain: 0.72, driftY: 0.025, splitPx: 3.5, rate: 0.5, detail: 1.3, clipKnee: 0.78, clipCeiling: 1.18 },
    { opacity: 0.52, resolutionScale: 0.5, ...sustain('2bar', 8.5) }),
  source('array-spectrum', 'spectrum', 'accent',
    { bars: 64, gain: 1.18, gamma: 0.55, height: 0.46 },
    { blend: 'subtract', opacity: 0.48, resolutionScale: 1, ...accentPulse('beat', 0.015, 0.12, 0.58) }),
  effect('array-diffraction', 'diffraction', 'secondary',
    { amount: 0.5, strength: 0.84, radius: 1.25, detail: 1.5, threshold: 0.38, angle: -0.22 },
    { opacity: 0.58, resolutionScale: 1, ...accentPulse('half', 0.02, 0.14, 0.3) }),
  effect('phrase-rest', 'drop-rest', 'accent',
    { amount: 1, strength: 1 },
    { opacity: 1, resolutionScale: 1, ...phraseRest() }),
]);

export const eclipseDrop = scene('eclipse-drop', 0x240004, V2_RAVE, [
  source('black-sun', 'eclipse-corona', 'accent',
    { scale: 1.28, density: 1.5, detail: 1.25, rate: 0.5, spread: 1.35, focusX: -0.32, focusY: 0.12, thickness: 0.95 },
    { resolutionScale: 1, ...sustain('4bar', 16.5) }),
  memory('corona-memory', 'temporal-prism', 'secondary',
    { tauBeats: 0.85, gain: 0.58, driftX: 0.03, splitPx: 4.0, rate: 1, detail: 1.2, focusX: -0.32, focusY: 0.12 },
    { opacity: 0.42, resolutionScale: 0.5, ...sustain('2bar', 8.5) }),
  source('corona-dial', 'radialbars', 'primary',
    { bars: 60, gain: 1.25, gamma: 0.52, innerRadius: 0.14, reach: 0.46, centreX: -0.32, centreY: 0.12, spinBars: -8 },
    { blend: 'max', opacity: 0.54, resolutionScale: 1, ...accentPulse('beat', 0.015, 0.12, 0.58) }),
  memory('black-sun-feedback', 'feedback', 'primary',
    { tauBeats: 0.9, gain: 0.9, zoomPerBeat: 1.04, rotTurnsPerBar: -0.075, driftY: 0.018, centreX: 0.34, centreY: 0.58, clipKnee: 0.8, clipCeiling: 1.2 },
    { opacity: 0.58, ...sustain('2bar', 8.5) }),
  effect('corona-lens', 'lensfield', 'accent',
    { amount: 0.44, strength: 0.82, radius: 0.9, detail: 1.25, focusX: -0.32, focusY: 0.12, mix: 0.78 },
    { opacity: 0.54, resolutionScale: 1, ...accentPulse('half', 0.02, 0.14, 0.3) }),
  effect('phrase-rest', 'drop-rest', 'primary',
    { amount: 1, strength: 1 },
    { opacity: 1, resolutionScale: 1, ...phraseRest() }),
]);

export const V2_PRESETS: readonly Preset[] = [
  cathodeOrbit, fluxCartography, harmonicSpecimen, quasicrystalScan,
  cathedralDrive, eclipseTransit, moireTerminal, signalArchitecture,
  vortexManuscript, botanicalSignal, paperAttractor, blackWaterLoom,
  prismOverload, foldEngine, temporalArray, eclipseDrop,
];

export const V2_PRESET_BANK: readonly DirectorEntry[] = [
  { preset: cathodeOrbit, look: 'lab', cost: 'light', weight: 1, maxEnergy: 0.46 },
  { preset: fluxCartography, look: 'lab', cost: 'light', weight: 0.95, maxEnergy: 0.58 },
  { preset: harmonicSpecimen, look: 'lab', cost: 'light', weight: 0.9, maxEnergy: 0.62 },
  { preset: quasicrystalScan, look: 'lab', cost: 'light', weight: 0.8, maxEnergy: 0.52 },
  { preset: cathedralDrive, look: 'grid', cost: 'medium', weight: 1, minEnergy: 0.18 },
  { preset: eclipseTransit, look: 'grid', cost: 'medium', weight: 0.9, minEnergy: 0.14 },
  { preset: moireTerminal, look: 'grid', cost: 'medium', weight: 0.9, minEnergy: 0.2 },
  { preset: signalArchitecture, look: 'grid', cost: 'medium', weight: 0.95, minEnergy: 0.22 },
  { preset: vortexManuscript, look: 'ink', cost: 'light', weight: 0.9, maxEnergy: 0.48 },
  { preset: botanicalSignal, look: 'ink', cost: 'light', weight: 0.95, maxEnergy: 0.58 },
  { preset: paperAttractor, look: 'ink', cost: 'heavy', weight: 0.82, maxEnergy: 0.46 },
  { preset: blackWaterLoom, look: 'ink', cost: 'medium', weight: 0.88, maxEnergy: 0.62 },
  { preset: prismOverload, look: 'rave', cost: 'heavy', weight: 1.05, minEnergy: 0.42 },
  { preset: foldEngine, look: 'rave', cost: 'heavy', weight: 1.0, minEnergy: 0.38 },
  { preset: temporalArray, look: 'rave', cost: 'heavy', weight: 1.0, minEnergy: 0.36 },
  { preset: eclipseDrop, look: 'rave', cost: 'heavy', weight: 1.1, minEnergy: 0.46 },
];
