// The preset banks. The public V2 bank is deliberately AVS-like: several audio
// drawings feed a history layer and then a short transformation chain. The
// older restrained scenes remain exported for URLs and authored timelines.

import type { LayerSpec, Palette, Preset } from '../contracts.ts';
import type { DirectorEntry } from '../director.ts';
import { V2_PRESETS, V2_PRESET_BANK } from './visual-v2.ts';

function layer(spec: Partial<LayerSpec> & { id: string; type: string }): LayerSpec {
  return {
    family: 'source', params: {}, blend: 'add', opacity: 1,
    envelope: { attackBeats: 0.3, holdBeats: 2, releaseBeats: 4 },
    trigger: { division: 'bar', euclidK: 1, euclidN: 1, probability: 1, offsetSteps: 0 },
    anchor: 'peak', palette: 'primary', enabled: true, resolutionScale: 1,
    ...spec,
  } as LayerSpec;
}

type Slot = LayerSpec['palette'];
type Options = Partial<LayerSpec>;
type Params = LayerSpec['params'];
const gate = (division: LayerSpec['trigger']['division'], euclidK = 1, euclidN = 1): LayerSpec['trigger'] =>
  ({ division, euclidK, euclidN, probability: 1, offsetSteps: 0 });
const fade = (attackBeats: number, holdBeats: number, releaseBeats: number): LayerSpec['envelope'] =>
  ({ attackBeats, holdBeats, releaseBeats });
const source = (id: string, type: string, palette: Slot, params: Params = {}, extra: Options = {}) =>
  layer({ id, type, palette, params, ...extra });
const effect = (id: string, type: string, palette: Slot, params: Params = {}, extra: Options = {}) =>
  layer({ id, type, family: 'operator', palette, params, ...extra });
const trail = (id: string, palette: Slot, params: Params = {}, extra: Options = {}) =>
  layer({ id, type: 'feedback', family: 'feedback', palette, params, ...extra });
const scene = (name: string, seed: number, palette: Palette, layers: LayerSpec[]): Preset => ({ version: 1, name, seed, palette, layers });

// --- palettes ---------------------------------------------------------------

const LAB: Palette = {
  name: 'lab',
  bg: { l: 0.025, c: 0.008, h: 205, intensity: 1 },
  primary: { l: 0.82, c: 0.15, h: 158, intensity: 1.8 },
  secondary: { l: 0.62, c: 0.10, h: 190, intensity: 0.8 },
  accent: { l: 0.88, c: 0.14, h: 82, intensity: 2.4 },
  ramp: [],
};
const GRID: Palette = {
  name: 'grid',
  bg: { l: 0.012, c: 0.008, h: 250, intensity: 1 },
  primary: { l: 0.78, c: 0.18, h: 205, intensity: 2.45 },
  secondary: { l: 0.66, c: 0.23, h: 320, intensity: 2.0 },
  accent: { l: 0.90, c: 0.18, h: 58, intensity: 3.0 },
  ramp: [],
};
const RAVE: Palette = {
  name: 'rave',
  bg: { l: 0.018, c: 0.018, h: 318, intensity: 1 },
  primary: { l: 0.66, c: 0.25, h: 18, intensity: 2.0 },
  secondary: { l: 0.75, c: 0.16, h: 200, intensity: 1.1 },
  accent: { l: 0.93, c: 0.18, h: 104, intensity: 3.0 },
  ramp: [],
};
const PRISM: Palette = {
  name: 'prism',
  bg: { l: 0.020, c: 0.020, h: 260, intensity: 1 },
  primary: { l: 0.75, c: 0.17, h: 205, intensity: 1.9 },
  secondary: { l: 0.64, c: 0.17, h: 282, intensity: 1.15 },
  accent: { l: 0.90, c: 0.12, h: 75, intensity: 2.6 },
  ramp: [],
};
const ABYSS: Palette = {
  name: 'abyss',
  bg: { l: 0.014, c: 0.012, h: 235, intensity: 1 },
  primary: { l: 0.68, c: 0.15, h: 192, intensity: 1.8 },
  secondary: { l: 0.47, c: 0.11, h: 235, intensity: 0.85 },
  accent: { l: 0.83, c: 0.14, h: 165, intensity: 2.3 },
  ramp: [],
};
const SIGNAL: Palette = {
  name: 'signal',
  bg: { l: 0.021, c: 0.015, h: 35, intensity: 1 },
  primary: { l: 0.79, c: 0.14, h: 56, intensity: 1.8 },
  secondary: { l: 0.58, c: 0.10, h: 28, intensity: 0.9 },
  accent: { l: 0.91, c: 0.12, h: 88, intensity: 2.5 },
  ramp: [],
};

// --- scenes -----------------------------------------------------------------

const lab = scene('lab', 0x1ab, LAB, [
  source('plate', 'chladni', 'secondary', { contrast: 0.72 }, { opacity: 0.3, trigger: gate('2bar'), envelope: fade(1.4, 5, 6) }),
  source('trace', 'scope', 'primary', { mode: 'line', gain: 2.05, thickness: 0.0055 }, { trigger: gate('beat'), envelope: fade(0.08, 1, 3) }),
  effect('phosphor-grade', 'grade', 'primary', { amount: 0.34, strength: 0.5, mix: 0.58 }, { opacity: 0.45, trigger: gate('bar'), envelope: fade(0.3, 3, 5) }),
  effect('tube', 'crt', 'secondary', { amount: 0.32, strength: 0.35, detail: 0.9, mix: 0.58 }, { opacity: 0.38, trigger: gate('2bar'), envelope: fade(1, 5, 6) }),
]);

const grid = scene('grid', 0x9d, GRID, [
  source('foreground-terrain', 'heightmesh', 'primary', { scale: 0.92, density: 1.55, detail: 1.65, speed: 0.58 }, { opacity: 1, trigger: gate('bar'), envelope: fade(0.2, 5, 7) }),
  source('dome-stage', 'dometunnel', 'secondary', { scale: 1, density: 0.92, detail: 0.95, speed: 0.46 }, { opacity: 0.78, trigger: gate('2bar'), envelope: fade(0.45, 6, 8) }),
  source('horizon-pylons', 'pylons', 'accent', { density: 1.2, detail: 1.45, speed: 0.75 }, { opacity: 0.74, trigger: gate('beat'), envelope: fade(0.04, 1.8, 3.4) }),
  effect('electric-halo', 'neon', 'primary', { amount: 0.68, strength: 0.96, radius: 1.35, detail: 1.0, mix: 0.24 }, { opacity: 0.66, trigger: gate('bar'), envelope: fade(0.2, 4, 6), resolutionScale: 0.5 }),
]);

const rave = scene('rave', 0x0a11ce, RAVE, [
  source('vector-stage', 'gridtunnel', 'primary', { density: 1.25, detail: 1.05, spread: 1.15, speed: 1.35 }, { trigger: gate('beat'), envelope: fade(0.04, 1, 2.5) }),
  source('meter', 'spectrum', 'accent', { bars: 72, gain: 1.05, gamma: 0.62 }, { opacity: 0.58, trigger: gate('beat'), envelope: fade(0.04, 1.2, 2.4) }),
  trail('heat', 'primary', { tauBeats: 1.2, gain: 0.55, zoomPerBeat: 1.018, clipKnee: 0.72, clipCeiling: 1.12 }, { opacity: 0.48, trigger: gate('beat'), envelope: fade(0.08, 2, 4), resolutionScale: 0.5 }),
  effect('rolling-scan', 'scanwarp', 'secondary', { amount: 0.42, strength: 0.68, radius: 1.2, detail: 1.1, speed: 1.4, mix: 0.7 }, { opacity: 0.48, trigger: gate('bar'), envelope: fade(0.04, 1.4, 2) }),
]);

const prism = scene('prism', 0x0a115c, PRISM, [
  source('flow-map', 'flowfield', 'primary', { scale: 1.05, density: 0.88, detail: 1.3, spread: 1.05, speed: 0.52 }, { trigger: gate('beat'), envelope: fade(0.1, 1.5, 3.5), resolutionScale: 0.5 }),
  source('facets', 'voronoi', 'secondary', { density: 0.78, scale: 1.2, spread: 0.8, speed: 0.5 }, { opacity: 0.30, trigger: gate('2bar'), envelope: fade(0.8, 5, 6) }),
  effect('inked-bands', 'contour', 'secondary', { amount: 0.56, strength: 0.72, radius: 1.0, detail: 0.9, mix: 0.35 }, { opacity: 0.54, trigger: gate('4bar'), envelope: fade(1, 6, 8) }),
  effect('halo', 'bloom', 'accent', { amount: 0.52, strength: 0.9, radius: 1.4 }, { opacity: 0.58, trigger: gate('bar'), envelope: fade(0.4, 3, 5), resolutionScale: 0.5 }),
]);

const abyss = scene('abyss', 0xab155, ABYSS, [
  source('depth', 'waterfall', 'secondary', { gain: 0.92, speed: 0.42 }, { opacity: 0.56, trigger: gate('bar'), envelope: fade(0.8, 4, 7) }),
  source('tide', 'reaction', 'primary', { scale: 0.85, density: 0.85, detail: 1.25, speed: 0.36 }, { opacity: 0.76, trigger: gate('beat'), envelope: fade(0.2, 2, 5), resolutionScale: 0.5 }),
  trail('undertow', 'secondary', { tauBeats: 2.3, gain: 0.42, zoomPerBeat: 0.996, clipKnee: 0.7, clipCeiling: 1.05 }, { opacity: 0.42, trigger: gate('2bar'), envelope: fade(0.4, 5, 8), resolutionScale: 0.5 }),
  effect('blue-hour', 'grade', 'primary', { amount: 0.42, strength: 0.46, mix: 0.72 }, { opacity: 0.42, trigger: gate('4bar'), envelope: fade(1, 6, 8) }),
]);

const signal = scene('signal', 0x517aa1, SIGNAL, [
  source('main-trace', 'scope', 'primary', { mode: 'line', gain: 1.85, thickness: 0.005 }, { trigger: gate('beat'), envelope: fade(0.05, 1.1, 2.8) }),
  source('dial', 'radialbars', 'accent', { bars: 44, gain: 0.9, gamma: 0.7, reach: 0.28 }, { opacity: 0.5, trigger: gate('bar'), envelope: fade(0.4, 3, 5) }),
  source('ghost-trace', 'scope', 'secondary', { mode: 'dots', gain: 1.2, thickness: 0.003 }, { opacity: 0.34, trigger: gate('2bar'), envelope: fade(0.7, 4, 6) }),
  effect('display', 'crt', 'secondary', { amount: 0.46, strength: 0.46, detail: 1.1, mix: 0.76 }, { opacity: 0.54, trigger: gate('2bar'), envelope: fade(0.7, 5, 6) }),
]);

const bloom = scene('bloom', 0xb100, PRISM, [
  source('pollen', 'particles', 'primary', { density: 0.78, scale: 1.4, spread: 1.35, speed: 0.62 }, { trigger: gate('beat'), envelope: fade(0.12, 2, 4) }),
  source('plate', 'chladni', 'secondary', { contrast: 0.6 }, { opacity: 0.28, trigger: gate('2bar'), envelope: fade(1, 5, 7) }),
  effect('soft-light', 'bloom', 'accent', { amount: 0.72, strength: 1.1, radius: 1.7 }, { opacity: 0.7, trigger: gate('bar'), envelope: fade(0.3, 3, 5), resolutionScale: 0.5 }),
  effect('wash', 'grade', 'primary', { amount: 0.3, strength: 0.25, mix: 0.5 }, { opacity: 0.3, trigger: gate('4bar'), envelope: fade(1, 6, 8) }),
]);

const lattice = scene('lattice', 0x1a771ce, GRID, [
  source('floor', 'wavegrid', 'secondary', { gain: 0.74, density: 1.2 }, { trigger: gate('bar'), envelope: fade(0.5, 4, 6) }),
  source('cells', 'voronoi', 'primary', { density: 1.1, scale: 0.94, spread: 0.75, speed: 0.44 }, { opacity: 0.48, trigger: gate('2bar'), envelope: fade(0.7, 5, 7) }),
  effect('panels', 'tile', 'accent', { amount: 0.32, mix: 0.3, detail: 1.1 }, { opacity: 0.36, trigger: gate('4bar'), envelope: fade(1, 6, 8) }),
  effect('shear', 'displace', 'secondary', { amount: 0.28, strength: 0.46, radius: 0.9, detail: 1.3, speed: 0.65 }, { opacity: 0.38, trigger: gate('bar'), envelope: fade(0.25, 2.5, 4) }),
]);

const rotor = scene('rotor', 0x70107, SIGNAL, [
  source('sweep', 'radialbars', 'primary', { bars: 52, gain: 1.0, gamma: 0.64, reach: 0.34, spinBars: 20 }, { trigger: gate('beat'), envelope: fade(0.06, 1.5, 3) }),
  source('coil', 'spiral', 'secondary', { turns: 4.5, thickness: 0.003, spinBars: 18 }, { opacity: 0.42, trigger: gate('bar'), envelope: fade(0.4, 3, 5) }),
  effect('orbit', 'polar', 'accent', { amount: 0.4, mix: 0.34, radius: 1.2 }, { opacity: 0.43, trigger: gate('2bar'), envelope: fade(0.8, 5, 7) }),
  effect('split-beam', 'chromatic', 'secondary', { amount: 0.28, strength: 0.45, radius: 1.1, speed: 0.4 }, { opacity: 0.34, trigger: gate('4bar'), envelope: fade(1, 6, 8) }),
]);

const velocity = scene('velocity', 0x0e10c17, ABYSS, [
  source('warp-cage', 'hypercylinder', 'primary', { density: 1.05, detail: 1.15, spread: 1.05, speed: 1.15 }, { trigger: gate('beat'), envelope: fade(0.06, 1.3, 3) }),
  source('tunnel', 'gridtunnel', 'secondary', { density: 0.85, detail: 0.9, spread: 0.8, speed: 0.66 }, { opacity: 0.48, trigger: gate('bar'), envelope: fade(0.5, 4, 6) }),
  trail('wake', 'primary', { tauBeats: 1.6, gain: 0.45, zoomPerBeat: 1.012, clipKnee: 0.7, clipCeiling: 1.08 }, { opacity: 0.43, trigger: gate('beat'), envelope: fade(0.08, 2, 4), resolutionScale: 0.5 }),
  effect('beam-warp', 'scanwarp', 'secondary', { amount: 0.28, strength: 0.42, radius: 0.9, detail: 0.75, speed: 0.55, mix: 0.45 }, { opacity: 0.36, trigger: gate('2bar'), envelope: fade(0.6, 4, 6) }),
]);

const flora = scene('flora', 0xf101a, PRISM, [
  source('petals', 'butterfly', 'primary', { gain: 1.18, spread: 1.28 }, { trigger: gate('beat'), envelope: fade(0.12, 2, 4.5) }),
  source('plate', 'chladni', 'secondary', { contrast: 0.55 }, { opacity: 0.24, trigger: gate('2bar'), envelope: fade(0.8, 5, 7) }),
  effect('nectar', 'bloom', 'accent', { amount: 0.56, strength: 0.82, radius: 1.5 }, { opacity: 0.6, trigger: gate('bar'), envelope: fade(0.4, 3, 5), resolutionScale: 0.5 }),
  effect('petal-tone', 'grade', 'primary', { amount: 0.26, strength: 0.4, mix: 0.48 }, { opacity: 0.32, trigger: gate('4bar'), envelope: fade(1, 6, 8) }),
]);

const ghost = scene('ghost', 0x6a057, ABYSS, [
  source('map', 'clifford', 'primary', { brightBase: 0.08, brightLevel: 0.16, thickness: 0.002 }, { trigger: gate('beat'), envelope: fade(0.1, 1.7, 4) }),
  source('memory', 'waterfall', 'secondary', { gain: 0.68, speed: 0.32 }, { opacity: 0.4, trigger: gate('2bar'), envelope: fade(0.8, 5, 7) }),
  trail('residue', 'secondary', { tauBeats: 2.8, gain: 0.35, zoomPerBeat: 0.994, clipKnee: 0.66, clipCeiling: 1.03 }, { opacity: 0.38, trigger: gate('bar'), envelope: fade(0.5, 4, 8), resolutionScale: 0.5 }),
  effect('monitor', 'crt', 'secondary', { amount: 0.4, strength: 0.38, detail: 0.7, mix: 0.68 }, { opacity: 0.4, trigger: gate('4bar'), envelope: fade(1, 6, 8) }),
]);

const atlas = scene('atlas', 0xa71a5, GRID, [
  source('map', 'dejong', 'primary', { brightBase: 0.06, brightLevel: 0.14, thickness: 0.002 }, { trigger: gate('beat'), envelope: fade(0.12, 1.8, 4) }),
  source('longitude', 'wavegrid', 'secondary', { gain: 0.5, density: 0.65 }, { opacity: 0.45, trigger: gate('2bar'), envelope: fade(0.8, 5, 7) }),
  effect('folds', 'tile', 'accent', { amount: 0.26, mix: 0.3, detail: 0.8 }, { opacity: 0.3, trigger: gate('4bar'), envelope: fade(1, 6, 8) }),
  effect('map-ink', 'grade', 'primary', { amount: 0.38, strength: 0.55, mix: 0.35 }, { opacity: 0.4, trigger: gate('bar'), envelope: fade(0.4, 3, 5) }),
]);

const ember = scene('ember', 0xe8be2, SIGNAL, [
  source('cinder-flow', 'halvorsen', 'primary', { brightBase: 0.08, brightLevel: 0.18, thickness: 0.002 }, { trigger: gate('beat'), envelope: fade(0.08, 1.5, 3.5) }),
  source('sparks', 'particles', 'accent', { density: 1.45, scale: 0.82, spread: 0.75, speed: 1.0 }, { opacity: 0.48, trigger: gate('beat'), envelope: fade(0.04, 1, 2.4) }),
  effect('firelight', 'bloom', 'accent', { amount: 0.66, strength: 1.0, radius: 1.2 }, { opacity: 0.62, trigger: gate('bar'), envelope: fade(0.3, 3, 5), resolutionScale: 0.5 }),
  effect('scan', 'crt', 'secondary', { amount: 0.22, strength: 0.25, detail: 0.85, mix: 0.42 }, { opacity: 0.25, trigger: gate('4bar'), envelope: fade(1, 6, 8) }),
]);

const pulse = scene('pulse', 0x0f115e, RAVE, [
  source('meter', 'spectrum', 'accent', { bars: 64, gain: 1.0, gamma: 0.64, height: 0.42 }, { trigger: gate('beat'), envelope: fade(0.04, 1.1, 2.4) }),
  source('ring', 'radialbars', 'secondary', { bars: 36, gain: 0.82, gamma: 0.74, reach: 0.28 }, { opacity: 0.45, trigger: gate('bar'), envelope: fade(0.4, 3, 5) }),
  trail('echo', 'primary', { tauBeats: 1.3, gain: 0.58, zoomPerBeat: 1.022, clipKnee: 0.72, clipCeiling: 1.14 }, { opacity: 0.5, trigger: gate('beat'), envelope: fade(0.08, 2, 4), resolutionScale: 0.5 }),
  effect('dropout', 'glitch', 'secondary', { amount: 0.34, strength: 0.64, detail: 1.35, speed: 1.4, mix: 0.76 }, { opacity: 0.42, trigger: gate('bar'), envelope: fade(0.04, 1.2, 2) }),
]);

const veins = scene('veins', 0x0be1a5, LAB, [
  source('flow', 'lorenz', 'primary', { brightBase: 0.07, brightLevel: 0.15, thickness: 0.002 }, { trigger: gate('beat'), envelope: fade(0.1, 1.6, 4) }),
  source('filament', 'spiral', 'secondary', { turns: 5.5, thickness: 0.0025, spinBars: 28 }, { opacity: 0.35, trigger: gate('2bar'), envelope: fade(0.7, 5, 7) }),
  effect('reflection', 'mirror', 'secondary', { amount: 0.26, mix: 0.28, softenPx: 1.2 }, { opacity: 0.3, trigger: gate('4bar'), envelope: fade(1, 6, 8) }),
  effect('ink', 'grade', 'primary', { amount: 0.3, strength: 0.52, mix: 0.45 }, { opacity: 0.34, trigger: gate('bar'), envelope: fade(0.4, 3, 5) }),
]);

const kinetic = scene('kinetic', 0x6e71c, PRISM, [
  source('emitter', 'particles', 'primary', { density: 1.28, scale: 0.88, spread: 1.0, speed: 1.25 }, { trigger: gate('beat'), envelope: fade(0.04, 1.2, 2.8) }),
  source('trail-ribbon', 'ribbon', 'secondary', { gain: 0.82, thickness: 0.009, speed: 1.2 }, { opacity: 0.4, trigger: gate('bar'), envelope: fade(0.35, 3, 5) }),
  effect('lens', 'chromatic', 'secondary', { amount: 0.42, strength: 0.68, radius: 1.4, speed: 0.7 }, { opacity: 0.45, trigger: gate('2bar'), envelope: fade(0.7, 5, 7) }),
  effect('lift', 'bloom', 'accent', { amount: 0.54, strength: 0.95, radius: 1.35 }, { opacity: 0.6, trigger: gate('bar'), envelope: fade(0.3, 3, 5), resolutionScale: 0.5 }),
]);

const vector = scene('vector', 0x0ec70, LAB, [
  source('warp-cylinder', 'hypercylinder', 'primary', { density: 0.82, detail: 1.4, spread: 1.1, speed: 0.58 }, { trigger: gate('beat'), envelope: fade(0.06, 1.4, 3.2) }),
  source('carrier', 'lissajous', 'accent', { scale: 1.3, detail: 1.7, spread: 1.1, speed: 0.58 }, { opacity: 0.30, trigger: gate('beat'), envelope: fade(0.05, 1.1, 2.5) }),
  effect('vector-halo', 'neon', 'primary', { amount: 0.5, strength: 0.7, radius: 1.2, detail: 0.9, mix: 0.62 }, { opacity: 0.48, trigger: gate('bar'), envelope: fade(0.3, 3, 5), resolutionScale: 0.5 }),
  effect('tube', 'crt', 'secondary', { amount: 0.36, strength: 0.45, detail: 1.1, mix: 0.72 }, { opacity: 0.42, trigger: gate('2bar'), envelope: fade(0.7, 5, 7) }),
]);

const organism = scene('organism', 0x0a6a11, ABYSS, [
  source('skin', 'reaction', 'primary', { scale: 1.0, density: 0.9, detail: 1.45, speed: 0.48 }, { trigger: gate('beat'), envelope: fade(0.18, 2, 5), resolutionScale: 0.5 }),
  source('membrane', 'voronoi', 'secondary', { density: 0.72, scale: 1.25, spread: 0.75, speed: 0.36 }, { opacity: 0.4, trigger: gate('2bar'), envelope: fade(0.8, 5, 7) }),
  effect('membrane-warp', 'displace', 'secondary', { amount: 0.28, strength: 0.42, radius: 0.9, detail: 1.15, speed: 0.45 }, { opacity: 0.32, trigger: gate('bar'), envelope: fade(0.4, 3, 5) }),
  effect('biolume', 'bloom', 'accent', { amount: 0.54, strength: 0.75, radius: 1.65 }, { opacity: 0.56, trigger: gate('2bar'), envelope: fade(0.7, 5, 7), resolutionScale: 0.5 }),
]);

const fracture = scene('fracture', 0xf2ac7, RAVE, [
  source('shards', 'voronoi', 'primary', { density: 1.4, scale: 0.85, spread: 1.1, speed: 1.1 }, { trigger: gate('beat'), envelope: fade(0.06, 1.4, 3) }),
  source('pressure', 'reaction', 'secondary', { scale: 0.75, density: 1.55, detail: 1.6, speed: 1.3 }, { opacity: 0.32, trigger: gate('bar'), envelope: fade(0.35, 3, 5), resolutionScale: 0.5 }),
  effect('fracture-warp', 'displace', 'secondary', { amount: 0.42, strength: 0.74, radius: 1.15, detail: 1.6, speed: 1.2 }, { opacity: 0.5, trigger: gate('beat', 3, 4), envelope: fade(0.04, 0.8, 2) }),
  effect('loss', 'glitch', 'accent', { amount: 0.44, strength: 0.82, detail: 1.3, speed: 1.7, mix: 0.75 }, { opacity: 0.52, trigger: gate('bar', 1, 2), envelope: fade(0.04, 0.9, 1.8) }),
]);

/** Compatibility bank retained for old URLs and hand-authored timelines. */
export const LEGACY_PRESETS: readonly Preset[] = [
  lab, grid, rave, prism, abyss, signal, bloom, lattice, rotor, velocity,
  flora, ghost, atlas, ember, pulse, veins, kinetic, vector, organism, fracture,
];

/** Compatibility director bank. V2 is the interactive/default bank below. */
export const LEGACY_PRESET_BANK: readonly DirectorEntry[] = [
  { preset: lab, look: 'lab', weight: 0.8, maxEnergy: 0.52 },
  { preset: grid, look: 'grid', weight: 1 },
  { preset: rave, look: 'rave', weight: 1.1, minEnergy: 0.4 },
  { preset: prism, look: 'prism', weight: 0.9, minEnergy: 0.18 },
  { preset: abyss, look: 'abyss', weight: 0.8, maxEnergy: 0.68 },
  { preset: signal, look: 'signal', weight: 0.9, maxEnergy: 0.62 },
  { preset: bloom, look: 'bloom', weight: 0.75, maxEnergy: 0.58 },
  { preset: lattice, look: 'lattice', weight: 1 },
  { preset: rotor, look: 'rotor', weight: 1, minEnergy: 0.26 },
  { preset: velocity, look: 'velocity', weight: 1, minEnergy: 0.22 },
  { preset: flora, look: 'flora', weight: 0.8, maxEnergy: 0.65 },
  { preset: ghost, look: 'ghost', weight: 0.7, maxEnergy: 0.54 },
  { preset: atlas, look: 'atlas', weight: 0.85 },
  { preset: ember, look: 'ember', weight: 1, minEnergy: 0.22 },
  { preset: pulse, look: 'pulse', weight: 1.1, minEnergy: 0.32 },
  { preset: veins, look: 'veins', weight: 0.8, maxEnergy: 0.68 },
  { preset: kinetic, look: 'kinetic', weight: 1, minEnergy: 0.24 },
  { preset: vector, look: 'vector', weight: 0.85, maxEnergy: 0.66 },
  { preset: organism, look: 'organism', weight: 0.9, maxEnergy: 0.7 },
  { preset: fracture, look: 'fracture', weight: 1.1, minEnergy: 0.38 },
];

// Ground-zero V2 becomes the public/default bank. Legacy scenes remain named
// exports and can still be loaded explicitly, but the director and picker no
// longer default to the near-duplicate field/glow combinations.
export const PRESETS: readonly Preset[] = V2_PRESETS;
export const PRESET_BANK: readonly DirectorEntry[] = V2_PRESET_BANK;

export {
  V2_PRESETS, V2_PRESET_BANK,
  V2_LAB, V2_GRID, V2_INK, V2_RAVE,
  cathodeOrbit, fluxCartography, harmonicSpecimen, quasicrystalScan,
  cathedralDrive, eclipseTransit, moireTerminal, signalArchitecture,
  vortexManuscript, botanicalSignal, paperAttractor, blackWaterLoom,
  prismOverload, foldEngine, temporalArray, eclipseDrop,
} from './visual-v2.ts';

export {
  lab, grid, rave, prism, abyss, signal, bloom, lattice, rotor, velocity,
  flora, ghost, atlas, ember, pulse, veins, kinetic, vector, organism, fracture,
};
