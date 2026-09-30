// Synthetic HUD manifests for the CPU checks. Plain data with neutral wording: no game titles, no private paths, no media.
// Every function returns a fresh deep copy, so a check may mutate what it gets. The 21 kind names are listed here on purpose
// (a second copy that check-hud-manifest.mjs compares with HUD_KINDS, so a silent edit of the table fails a check).
// Status: proposed and CPU-checked. Nothing here has been drawn by an engine.
export const KIND_NAMES = ['panel', 'viewport', 'label', 'bar', 'pips', 'matrix', 'counter', 'timer', 'portrait', 'dial', 'radar', 'reticle', 'slots', 'spectrum', 'scope',
  'terminal', 'rain', 'warning', 'combo', 'banner', 'fx'];

const clone = value => structuredClone(value);
export const PALETTE = { ink: '#0a0c14', paper: '#f0e6c8', shade: '#151a2c', hi: '#ffffff', a1: '#f2b21c', a2: '#3d7bff', ok: '#4ade80', warn: '#f59e0b', bad: '#ef4444' };

/** Smallest valid manifest: one viewport. */
export function baseManifest(overrides = {}) {
  return {
    format: 'mpcaaavs-hud', version: 1, id: 'fixture-minimal-01', title: 'Fixture Minimal', pack: 'fixture-pack', family: 'misc', era: 'fui',
    canvas: { w: 960, h: 540, style: 'vector' },
    palette: { ink: PALETTE.ink, paper: PALETTE.paper, a1: PALETTE.a1, a2: PALETTE.a2, ok: PALETTE.ok, warn: PALETTE.warn, bad: PALETTE.bad },
    layers: [{ k: 'viewport', id: 'bed', r: [0, 0, 1, 1], bed: 'gradient' }],
    ...clone(overrides),
  };
}

const EVENTS = { hits: { on: 'beat', n: 6, seed: 7, bias: 0.1, gap: 1 } };
const INTERVALS = { boss: { from: 's+1b', to: 'e-1b' } };

/** Every kind twice: `min` sets only the required properties, `full` sets every optional property and a binding where the kind takes one. */
const LAYERS = {
  panel: {
    min: { k: 'panel', id: 'plate', r: [0, 0, 1, 0.2], style: 'flat' },
    full: { k: 'panel', id: 'plate', r: [0, 0, 1, 0.2], z: 1, c: 'shade', c2: 'ink', style: 'crt', title: 'STATUS', cut: 6, beh: ['pulse'] },
  },
  viewport: {
    min: { k: 'viewport', id: 'bed', r: [0, 0, 1, 1], bed: 'void' },
    full: { k: 'viewport', id: 'bed', r: [0, 0, 1, 1], z: 0, c: 'a2', c2: 'ink', bed: 'starfield', energy: 0.25, frame: true, v: { src: 'audio.rms', out: [0, 0.3], curve: 'smooth', atk: 20, rel: 300, gate: 0.05, fb: 0 }, beh: ['pulse'] },
  },
  label: {
    min: { k: 'label', id: 'name', r: [0.05, 0.05, 0.2, 0.05], text: 'SCORE' },
    full: { k: 'label', id: 'name', r: [0.05, 0.05, 0.2, 0.05], z: 2, c: 'paper', c2: 'shade', text: 'SCORE', size: 'm', align: 'center', font: 'pixel', blink: true, beh: ['blink'] },
  },
  bar: {
    min: { k: 'bar', id: 'gauge', r: [0.05, 0.1, 0.4, 0.05], dir: 'ltr' },
    full: {
      k: 'bar', id: 'gauge', r: [0.05, 0.1, 0.4, 0.05], z: 3, c: 'ok', c2: 'bad', dir: 'btt', segs: 28, style: 'ticks', trail: true, danger: 0.3, cap: true,
      v: 'ev.hits.remaining', beh: ['ghost', 'damageFlicker', 'dangerPulse', 'refill', 'capFlash'],
    },
  },
  pips: {
    min: { k: 'pips', id: 'lives', r: [0.05, 0.2, 0.2, 0.05], n: 3 },
    full: { k: 'pips', id: 'lives', r: [0.05, 0.2, 0.2, 0.05], z: 4, c: 'a1', c2: 'shade', n: 5, icon: 'heart', dir: 'rtl', v: { src: 'ev.hits.count', in: [0, 6], out: [5, 0], curve: 'steps:5' }, beh: ['refill', 'blink'] },
  },
  matrix: {
    min: { k: 'matrix', id: 'cells', r: [0.5, 0.2, 0.3, 0.15], cols: 4, rows: 2, mode: 'checker' },
    full: { k: 'matrix', id: 'cells', r: [0.5, 0.2, 0.3, 0.15], z: 5, c: 'a2', c2: 'shade', cols: 6, rows: 3, mode: 'levels', gap: 1, v: { src: 'audio.band.mid', steps: 6, gate: 0.1 }, beh: ['levels', 'chase'] },
  },
  counter: {
    min: { k: 'counter', id: 'digits', r: [0.05, 0.3, 0.3, 0.08], digits: 4, fmt: 'int', mode: 'static' },
    full: {
      k: 'counter', id: 'digits', r: [0.05, 0.3, 0.3, 0.08], z: 6, c: 'paper', c2: 'shade', digits: 6, fmt: 'score', mode: 'interval', font: 'seg', min: 0, max: 999999, ease: 'pow:2', tick: true, unit: 'PTS',
      v: 'interval.progress', beh: ['tick'],
    },
  },
  timer: {
    min: { k: 'timer', id: 'clock', r: [0.45, 0.05, 0.1, 0.09], unit: 'norm' },
    full: { k: 'timer', id: 'clock', r: [0.45, 0.05, 0.1, 0.09], z: 7, c: 'a1', c2: 'shade', unit: 'mmss', total: 99, dir: 'down', urgent: 10, font: 'seg', v: 'interval.remaining', beh: ['urgent', 'zeroHold'] },
  },
  portrait: {
    min: { k: 'portrait', id: 'face', r: [0.4, 0.4, 0.2, 0.3], style: 'emblem' },
    full: { k: 'portrait', id: 'face', r: [0.4, 0.4, 0.2, 0.3], z: 8, c: 'paper', c2: 'bad', style: 'face', v: 'audio.pan', beh: ['look', 'hurt', 'grin', 'dead', 'blink'] },
  },
  dial: {
    min: { k: 'dial', id: 'orb', r: [0.7, 0.4, 0.2, 0.3], style: 'ring' },
    full: { k: 'dial', id: 'orb', r: [0.7, 0.4, 0.2, 0.3], z: 9, c: 'bad', c2: 'ink', style: 'needle', sweep: 240, ticks: 12, v: { src: 'audio.rms', atk: 60, rel: 400 }, beh: ['sweep', 'peakHold'] },
  },
  radar: {
    min: { k: 'radar', id: 'scan', r: [0.05, 0.5, 0.25, 0.4], style: 'sonar' },
    full: { k: 'radar', id: 'scan', r: [0.05, 0.5, 0.25, 0.4], z: 10, c: 'ok', c2: 'shade', style: 'tracker', blips: 12, rings: 3, sweep: 'bar', period: 2, v: 'clock.barPhase', beh: ['sweep', 'blip'] },
  },
  reticle: {
    min: { k: 'reticle', id: 'aim', r: [0.4, 0.3, 0.2, 0.3], style: 'crosshair' },
    full: { k: 'reticle', id: 'aim', r: [0.4, 0.3, 0.2, 0.3], z: 11, c: 'warn', c2: 'shade', style: 'diamond', lockEvery: 2, lockHold: 1, drift: 0.3, ticks: 8, v: 'audio.pan', beh: ['drift', 'lock'] },
  },
  slots: {
    min: { k: 'slots', id: 'items', r: [0.05, 0.85, 0.3, 0.1], n: 4 },
    full: { k: 'slots', id: 'items', r: [0.05, 0.85, 0.3, 0.1], z: 12, c: 'a1', c2: 'shade', n: 6, cols: 3, icon: 'potion', sel: 'beat', v: 'clock.beatPos', beh: ['select', 'chase'] },
  },
  spectrum: {
    min: { k: 'spectrum', id: 'bands', r: [0.4, 0.75, 0.3, 0.2], bars: 8 },
    full: { k: 'spectrum', id: 'bands', r: [0.4, 0.75, 0.3, 0.2], z: 13, c: 'a2', c2: 'a1', bars: 16, dir: 'btt', scale: 'log', hold: true, mirror: true, seg: 8, v: 'audio.band.high', beh: ['peakHold', 'levels'] },
  },
  scope: {
    min: { k: 'scope', id: 'trace', r: [0.75, 0.75, 0.2, 0.2], mode: 'wave' },
    full: { k: 'scope', id: 'trace', r: [0.75, 0.75, 0.2, 0.2], z: 14, c: 'ok', c2: 'shade', mode: 'ecg', ch: 'mix', grid: true, status: ['FINE', 'CAUTION', 'DANGER'], v: 'audio.beat.latched', beh: ['trace', 'ecgBeat'] },
  },
  terminal: {
    min: { k: 'terminal', id: 'feed', r: [0.05, 0.4, 0.3, 0.3], lines: ['BOOT OK'] },
    full: { k: 'terminal', id: 'feed', r: [0.05, 0.4, 0.3, 0.3], z: 15, c: 'ok', c2: 'shade', lines: ['BOOT SEQUENCE', 'CHECKING LINKS', 'ALL CHANNELS READY'], reveal: 'interval', mode: 'log', cursor: true, v: 'interval.progress', beh: ['type', 'scroll'] },
  },
  rain: {
    min: { k: 'rain', id: 'glyphs', r: [0.7, 0.05, 0.25, 0.3], cols: 12 },
    full: { k: 'rain', id: 'glyphs', r: [0.7, 0.05, 0.25, 0.3], z: 16, c: 'ok', c2: 'ink', cols: 24, set: 'code', v: 'audio.rms', beh: ['fall', 'burst'] },
  },
  warning: {
    min: { k: 'warning', id: 'alert', r: [0.3, 0.9, 0.4, 0.06], text: 'CAUTION' },
    full: { k: 'warning', id: 'alert', r: [0.3, 0.9, 0.4, 0.06], z: 17, c: 'warn', c2: 'ink', text: 'LOW POWER', style: 'hazard', hz: 1.5, when: 'e-1b', until: 'e-0', v: 'interval.remaining01', beh: ['pulse', 'stripes'] },
  },
  combo: {
    min: { k: 'combo', id: 'chain', r: [0.6, 0.5, 0.2, 0.1], text: 'CHAIN' },
    full: { k: 'combo', id: 'chain', r: [0.6, 0.5, 0.2, 0.1], z: 18, c: 'a1', c2: 'shade', text: 'CHAIN', window: 0.75, rank: true, v: 'audio.onset.any.fired', beh: ['pop', 'window'] },
  },
  banner: {
    min: { k: 'banner', id: 'cues', r: [0.2, 0.35, 0.6, 0.2], cues: [{ at: 's+0', text: 'READY' }] },
    full: {
      k: 'banner', id: 'cues', r: [0.2, 0.35, 0.6, 0.2], z: 19, c: 'a1', c2: 'ink', size: 'l',
      cues: [{ at: 's+0', text: 'READY', hold: 1 }, { at: 's+2b', text: 'GO', style: 'pop', hold: 0.8 }, { at: 'f0.5', text: 'HALF', style: 'slide', hold: 0.5 }, { at: 'e-0', text: 'TIME UP', style: 'type', hold: 2 }],
      v: 'clock.beatPhase', beh: ['pop', 'slide'],
    },
  },
  fx: {
    min: { k: 'fx', id: 'grade', r: [0, 0, 1, 1], fx: 'grain', amount: 0.1 },
    full: { k: 'fx', id: 'grade', r: [0, 0, 1, 1], z: 20, c: 'hi', c2: 'shade', fx: 'vignette', amount: 0.3, v: { src: 'audio.band.low', out: [0, 0.3] }, beh: ['vignette', 'glow'] },
  },
};

/** One layer of `kind`; `variant` is `min` or `full`. */
export function kindLayer(kind, variant = 'full') {
  const layer = LAYERS[kind]?.[variant];
  if (!layer) throw new Error(`No fixture for ${kind}/${variant}`);
  return clone(layer);
}

/** A manifest holding exactly one layer of `kind`. Event sets and named intervals are declared when the layer binds them. */
export function kindManifest(kind, variant = 'full') {
  const layer = kindLayer(kind, variant);
  const text = JSON.stringify(layer);
  const m = baseManifest({ id: `fixture-${kind}-${variant}`, title: `Fixture ${kind} ${variant}`, layers: [layer] });
  if (text.includes('"ev.hits')) m.events = clone(EVENTS);
  if (text.includes('"iv.boss')) m.intervals = clone(INTERVALS);
  return m;
}

/** All 21 kinds in one vector scene, `full` variants. Reference tempo attention: at most 4 at any instant. */
export function allKindsManifest() {
  return baseManifest({
    id: 'fixture-all-kinds-01', title: 'Fixture All Kinds', pack: 'fixture-pack', family: 'scifi', era: 'fui',
    reference: { platform: 'synthetic', year: 2001, genre: 'test' }, tags: ['fixture', 'all-kinds'],
    timing: { freeBars: 8 }, events: EVENTS, intervals: INTERVALS, attention: { capacity: 4, refill: 2.5 },
    layers: KIND_NAMES.map(kind => kindLayer(kind, 'full')),
    meta: { tier: 'showcase', origin: 'template', rev: 1, gen: 'fixtures-hud@1', kit: '0123abcd' },
  });
}

/** The section 4.5 duel scene with neutral wording, pixel style: authoritative health from event schedules, decoration from bands. */
export function duelManifest() {
  return {
    format: 'mpcaaavs-hud', version: 1,
    id: 'fixture-duel-rails-03', title: 'Duel Rails · Amber 03', pack: 'fixture-pack', family: 'fighting', era: 'arcade',
    reference: { platform: 'arcade', year: 1991, genre: 'fighting' },
    canvas: { w: 384, h: 224, style: 'pixel', par: [1, 1] },
    palette: clone(PALETTE),
    timing: { freeBars: 8 },
    events: { p1hits: { on: 'beat', n: 9, seed: 11, bias: 0.2, gap: 1 }, p2hits: { on: 'beat', n: 6, seed: 23, bias: -0.1, gap: 1 } },
    layers: [
      { k: 'viewport', id: 'bed', r: [0, 0, 1, 1], bed: 'horizon', energy: 0.3 },
      { k: 'panel', id: 'dock', r: [0, 0, 1, 0.2], style: 'bevel' },
      { k: 'bar', id: 'p1', r: [0.07, 0.09, 0.37, 0.045], dir: 'rtl', c: 'a1', c2: 'bad', v: 'ev.p1hits.remaining', trail: true, danger: 0.25, beh: ['ghost', 'damageFlicker', 'dangerPulse'] },
      { k: 'bar', id: 'p2', r: [0.56, 0.09, 0.37, 0.045], dir: 'ltr', c: 'a1', c2: 'bad', v: 'ev.p2hits.remaining', trail: true, danger: 0.25, beh: ['ghost', 'damageFlicker', 'dangerPulse'] },
      { k: 'timer', id: 'clock', r: [0.45, 0.05, 0.1, 0.09], unit: 'norm', total: 99, urgent: 10, font: 'pixel', c: 'a1', beh: ['urgent', 'zeroHold'] },
      { k: 'label', id: 'n1', r: [0.07, 0.04, 0.2, 0.04], text: 'P1', size: 's' },
      { k: 'label', id: 'n2', r: [0.73, 0.04, 0.2, 0.04], text: 'P2', size: 's', align: 'right' },
      { k: 'bar', id: 'pow', r: [0.05, 0.92, 0.32, 0.03], dir: 'ltr', segs: 24, c: 'a2', v: { src: 'audio.band.low', atk: 30, rel: 400 }, beh: ['capFlash'] },
      { k: 'banner', id: 'cues', r: [0.2, 0.35, 0.6, 0.2], c: 'a1', size: 'xl',
        cues: [{ at: 's+0', text: 'READY', hold: 1 }, { at: 's+2b', text: 'FIGHT', style: 'pop', hold: 0.8 }, { at: 'e-0', text: 'TIME OVER', hold: 2 }] },
      { k: 'fx', id: 'crt', r: [0, 0, 1, 1], fx: 'scanlines', amount: 0.18 },
    ],
    meta: { tier: 'tuned', origin: 'kit', rev: 1, gen: 'fixtures-hud@1', kit: '9c41a07e' },
  };
}

/** A scene that declares two named intervals and binds them, with a cue-scheduled banner and an event set: exercises `iv.*`, `intervals`, `meta.origin`. */
export function intervalsManifest() {
  return baseManifest({
    id: 'fixture-intervals-01', title: 'Fixture Named Intervals', pack: 'fixture-pack', family: 'terminal', era: 'fui', tags: ['fixture', 'intervals'],
    timing: { freeBars: 16 },
    events: { volley: { on: 'bar', n: 4, seed: 99, from: 's+1b', to: 'e-1b' }, taps: { on: 'half-bar', n: 12, seed: 5, bias: -0.3, gap: 0 } },
    intervals: { boss: { from: 's+2b', to: 'e-2b' }, 'last-bar': { from: 'e-1b', to: 'e-0' } },
    layers: [
      { k: 'viewport', id: 'bed', r: [0, 0, 1, 1], bed: 'grid' },
      { k: 'timer', id: 'bosstime', r: [0.4, 0.05, 0.2, 0.1], unit: 'bars', v: { src: 'iv.boss.remainingBars', fb: 0 }, beh: ['urgent'] },
      { k: 'bar', id: 'bossbar', r: [0.1, 0.2, 0.8, 0.05], dir: 'rtl', v: { src: 'iv.boss.remaining01', fb: 1 } },
      { k: 'warning', id: 'final', r: [0.3, 0.85, 0.4, 0.08], text: 'FINAL BAR', when: 'e-1b', v: 'iv.last-bar.progress' },
      { k: 'counter', id: 'volleys', r: [0.1, 0.4, 0.2, 0.08], digits: 2, fmt: 'pad0', mode: 'interval', min: 0, max: 4, v: 'ev.volley.count' },
    ],
    meta: { tier: 'auto', origin: 'image', rev: 3, kit: 'a1b2c3d4' },
  });
}

/** A thin, image-derived layout as the generator writes for a source with only a picture. */
export function thinManifest() {
  return baseManifest({
    id: 'fixture-thin-image-01', title: 'Fixture Thin Layout', pack: 'fixture-pack', family: 'misc', era: '8bit',
    canvas: { w: 256, h: 224, style: 'pixel', par: [8, 7] },
    layers: [
      { k: 'viewport', id: 'bed', r: [0, 0.18, 1, 0.64], bed: 'noise', energy: 0.1 },
      { k: 'panel', id: 'top', r: [0, 0, 1, 0.18], style: 'notch' },
      { k: 'label', id: 'l1', r: [0.04, 0.03, 0.3, 0.05], text: 'SCORE' },
      { k: 'counter', id: 'c1', r: [0.04, 0.09, 0.3, 0.06], digits: 6, fmt: 'pad0', mode: 'interval', v: 'interval.progress' },
      { k: 'bar', id: 'b1', r: [0.55, 0.09, 0.4, 0.05], dir: 'ltr', segs: 16 },
    ],
    meta: { tier: 'auto', origin: 'image', rev: 1, gen: 'fixtures-hud@1', kit: '5e5e5e5e' },
  });
}

/** The seven layout archetypes of HUD-PACK-ENGINE 7.4 as synthetic scenes: what a generator emits for a source with no usable per-source geometry (`meta.origin` `template`).
 * They are the budget reference: each fits the soft draw-cost budget with headroom (check-hud-manifest.mjs pins at most 75 percent of the soft draw and segment budgets), so a generator adding a few instruments to one stays valid. Neutral wording. */
export const ARCHETYPES = ['dock-top-duel', 'dock-top-score', 'dock-bottom-status', 'dock-side-command', 'dock-twin', 'console3d-8', 'cinema-triptych'];
const ARCHETYPE_HEAD = {
  'dock-top-duel': { family: 'fighting', era: 'arcade', canvas: { w: 384, h: 224, style: 'pixel', par: [1, 1] } },
  'dock-top-score': { family: 'shmup', era: '8bit', canvas: { w: 256, h: 224, style: 'pixel', par: [8, 7] } },
  'dock-bottom-status': { family: 'fps', era: 'pc-classic', canvas: { w: 320, h: 200, style: 'pixel', par: [5, 6] } },
  'dock-side-command': { family: 'rts', era: 'pc-classic', canvas: { w: 640, h: 480, style: 'pixel', par: [1, 1] } },
  'dock-twin': { family: 'brawler', era: 'arcade', canvas: { w: 320, h: 224, style: 'pixel', par: [1, 1] } },
  'console3d-8': { family: 'racing', era: '32bit', canvas: { w: 960, h: 540, style: 'vector' } },
  'cinema-triptych': { family: 'scifi', era: 'cinema', canvas: { w: 960, h: 540, style: 'vector' } },
};
function archetypeLayers(name) {
  switch (name) {
    case 'dock-top-duel': return [
      { k: 'viewport', id: 'bed', r: [0, 0, 1, 1], bed: 'horizon', energy: 0.25 },
      { k: 'panel', id: 'dock', r: [0, 0, 1, 0.2], style: 'bevel' },
      { k: 'portrait', id: 'crest1', r: [0.02, 0.03, 0.05, 0.1], style: 'emblem', c: 'a1' },
      { k: 'portrait', id: 'crest2', r: [0.93, 0.03, 0.05, 0.1], style: 'emblem', c: 'a2' },
      { k: 'bar', id: 'p1', r: [0.09, 0.09, 0.35, 0.045], dir: 'rtl', c: 'a1', c2: 'bad', v: 'ev.p1hits.remaining', trail: true, danger: 0.25, beh: ['ghost', 'damageFlicker', 'dangerPulse'] },
      { k: 'bar', id: 'p2', r: [0.56, 0.09, 0.35, 0.045], dir: 'ltr', c: 'a1', c2: 'bad', v: 'ev.p2hits.remaining', trail: true, danger: 0.25, beh: ['ghost', 'damageFlicker', 'dangerPulse'] },
      { k: 'timer', id: 'clock', r: [0.45, 0.04, 0.1, 0.1], unit: 'norm', total: 99, urgent: 10, font: 'pixel', c: 'a1', beh: ['urgent', 'zeroHold'] },
      { k: 'pips', id: 'rounds1', r: [0.09, 0.15, 0.08, 0.03], n: 2, icon: 'round', v: { src: 'interval.progress', out: [0, 2], curve: 'steps:2' } },
      { k: 'pips', id: 'rounds2', r: [0.83, 0.15, 0.08, 0.03], n: 2, icon: 'round', dir: 'rtl', v: { src: 'interval.progress', out: [0, 2], curve: 'steps:2' } },
      { k: 'bar', id: 'super1', r: [0.05, 0.92, 0.32, 0.03], dir: 'ltr', segs: 24, c: 'a2', v: { src: 'audio.band.low', atk: 30, rel: 400 }, beh: ['capFlash'] },
      { k: 'bar', id: 'super2', r: [0.63, 0.92, 0.32, 0.03], dir: 'rtl', segs: 24, c: 'a2', v: { src: 'audio.band.mid', atk: 30, rel: 400 }, beh: ['capFlash'] },
      { k: 'label', id: 'n1', r: [0.09, 0.04, 0.2, 0.04], text: 'P1', size: 's' },
      { k: 'label', id: 'n2', r: [0.71, 0.04, 0.2, 0.04], text: 'P2', size: 's', align: 'right' },
      { k: 'banner', id: 'cues', r: [0.2, 0.35, 0.6, 0.2], c: 'a1', size: 'xl', cues: [{ at: 's+0', text: 'READY', hold: 1 }, { at: 's+2b', text: 'FIGHT', style: 'pop', hold: 0.8 }, { at: 'e-0', text: 'TIME OVER', hold: 2 }] },
      { k: 'fx', id: 'crt', r: [0, 0, 1, 1], fx: 'scanlines', amount: 0.18 },
    ];
    case 'dock-top-score': return [
      { k: 'viewport', id: 'bed', r: [0, 0.16, 1, 0.84], bed: 'starfield', energy: 0.2 },
      { k: 'panel', id: 'top', r: [0, 0, 1, 0.16], style: 'notch' },
      { k: 'label', id: 'l-score', r: [0.04, 0.02, 0.2, 0.05], text: 'SCORE' },
      { k: 'counter', id: 'score', r: [0.04, 0.08, 0.3, 0.06], digits: 6, fmt: 'pad0', mode: 'interval', min: 0, max: 999999, tick: true, v: 'interval.progress', beh: ['tick'] },
      { k: 'label', id: 'l-hi', r: [0.4, 0.02, 0.2, 0.05], text: 'HI' },
      { k: 'counter', id: 'hi', r: [0.4, 0.08, 0.3, 0.06], digits: 6, fmt: 'pad0', mode: 'static', min: 0, max: 999999 },
      { k: 'pips', id: 'lives', r: [0.04, 0.92, 0.2, 0.05], n: 3, icon: 'life', v: 'const.3' },
      { k: 'bar', id: 'power', r: [0.55, 0.92, 0.4, 0.04], dir: 'ltr', segs: 16, c: 'a2', v: { src: 'audio.band.low', atk: 40, rel: 300 } },
    ];
    case 'dock-bottom-status': return [
      { k: 'viewport', id: 'bed', r: [0, 0, 1, 0.82], bed: 'city', energy: 0.15 },
      { k: 'panel', id: 'bottom', r: [0, 0.82, 1, 0.18], style: 'steel' },
      { k: 'label', id: 'l-ammo', r: [0.03, 0.83, 0.12, 0.04], text: 'AMMO', size: 's' },
      { k: 'counter', id: 'ammo', r: [0.03, 0.88, 0.14, 0.09], digits: 3, fmt: 'pad0', mode: 'interval', min: 0, max: 200, font: 'seg', v: 'interval.remaining01', ease: 'lin' },
      { k: 'label', id: 'l-health', r: [0.2, 0.83, 0.14, 0.04], text: 'HEALTH', size: 's' },
      { k: 'counter', id: 'health', r: [0.2, 0.88, 0.16, 0.09], digits: 3, fmt: 'percent', mode: 'interval', min: 0, max: 100, font: 'seg', v: 'ev.hits.remaining' },
      { k: 'label', id: 'l-armor', r: [0.62, 0.83, 0.12, 0.04], text: 'ARMOR', size: 's' },
      { k: 'counter', id: 'armor', r: [0.62, 0.88, 0.16, 0.09], digits: 3, fmt: 'percent', mode: 'interval', min: 0, max: 100, font: 'seg', v: 'interval.progress' },
      { k: 'bar', id: 'energy', r: [0.4, 0.9, 0.18, 0.05], dir: 'ltr', segs: 20, c: 'a2', v: { src: 'audio.rms', atk: 40, rel: 300 } },
      { k: 'slots', id: 'items', r: [0.8, 0.86, 0.18, 0.1], n: 6, cols: 6, icon: 'key', sel: 'onset', v: 'audio.onset.any.fired' },
      { k: 'portrait', id: 'face', r: [0.44, 0.83, 0.12, 0.15], style: 'face', v: 'audio.pan', beh: ['look', 'hurt', 'grin'] },
    ];
    case 'dock-side-command': return [
      { k: 'viewport', id: 'bed', r: [0, 0, 0.78, 1], bed: 'grid', energy: 0.1 },
      { k: 'panel', id: 'side', r: [0.78, 0, 0.22, 1], style: 'steel' },
      { k: 'radar', id: 'minimap', r: [0.79, 0.02, 0.2, 0.26], style: 'minimap', blips: 12, rings: 0, sweep: 'bar', c: 'ok' },
      { k: 'label', id: 'l-credit', r: [0.8, 0.31, 0.18, 0.03], text: 'CREDITS', size: 's' },
      { k: 'counter', id: 'money', r: [0.8, 0.35, 0.18, 0.05], digits: 6, fmt: 'money', mode: 'interval', min: 0, max: 99999, v: 'interval.progress' },
      { k: 'dial', id: 'power', r: [0.8, 0.43, 0.18, 0.1], style: 'needle', ticks: 8, c: 'warn', v: { src: 'audio.rms', atk: 80, rel: 500 } },
      { k: 'slots', id: 'commands', r: [0.79, 0.56, 0.2, 0.3], n: 12, cols: 4, icon: 'box', sel: 'bar', v: 'clock.barIndex' },
      { k: 'bar', id: 'build', r: [0.8, 0.9, 0.18, 0.04], dir: 'ltr', segs: 10, v: 'interval.progress' },
    ];
    case 'dock-twin': return [
      { k: 'viewport', id: 'bed', r: [0, 0, 1, 1], bed: 'gradient', energy: 0.2 },
      { k: 'panel', id: 'top', r: [0, 0, 1, 0.13], style: 'flat' },
      { k: 'panel', id: 'bottom', r: [0, 0.9, 1, 0.1], style: 'flat' },
      { k: 'label', id: 'l-p1', r: [0.03, 0.01, 0.1, 0.04], text: 'P1', size: 's' },
      { k: 'counter', id: 'score1', r: [0.03, 0.06, 0.22, 0.05], digits: 7, fmt: 'pad0', mode: 'interval', min: 0, max: 9999999, v: 'interval.progress' },
      { k: 'bar', id: 'life1', r: [0.28, 0.04, 0.22, 0.04], dir: 'rtl', c: 'ok', c2: 'bad', v: 'ev.hits1.remaining', trail: true, beh: ['ghost'] },
      { k: 'label', id: 'l-p2', r: [0.87, 0.01, 0.1, 0.04], text: 'P2', size: 's', align: 'right' },
      { k: 'counter', id: 'score2', r: [0.75, 0.06, 0.22, 0.05], digits: 7, fmt: 'pad0', mode: 'interval', min: 0, max: 9999999, v: 'interval.progress' },
      { k: 'bar', id: 'life2', r: [0.5, 0.04, 0.22, 0.04], dir: 'ltr', c: 'ok', c2: 'bad', v: 'ev.hits2.remaining', trail: true, beh: ['ghost'] },
      { k: 'label', id: 'l-credit', r: [0.42, 0.92, 0.1, 0.04], text: 'CREDIT', size: 's' },
      { k: 'counter', id: 'credit', r: [0.54, 0.92, 0.06, 0.05], digits: 2, fmt: 'pad0', mode: 'static', min: 0, max: 99 },
      { k: 'bar', id: 'pow1', r: [0.03, 0.92, 0.3, 0.04], dir: 'ltr', segs: 20, c: 'a2', v: { src: 'audio.band.low', atk: 30, rel: 400 } },
      { k: 'bar', id: 'pow2', r: [0.67, 0.92, 0.3, 0.04], dir: 'rtl', segs: 20, c: 'a2', v: { src: 'audio.band.mid', atk: 30, rel: 400 } },
    ];
    case 'console3d-8': return [
      { k: 'viewport', id: 'bed', r: [0, 0, 1, 1], bed: 'tunnel', energy: 0.3 },
      { k: 'bar', id: 'hp', r: [0.04, 0.04, 0.26, 0.035], dir: 'ltr', c: 'ok', c2: 'bad', v: 'interval.remaining01', danger: 0.25, beh: ['dangerPulse'] },
      { k: 'bar', id: 'mp', r: [0.04, 0.09, 0.2, 0.025], dir: 'ltr', c: 'a2', v: { src: 'audio.band.mid', atk: 40, rel: 400 } },
      { k: 'pips', id: 'stock', r: [0.04, 0.13, 0.12, 0.03], n: 3, icon: 'heart', v: 'const.3' },
      { k: 'counter', id: 'rank', r: [0.72, 0.04, 0.12, 0.06], digits: 2, fmt: 'pad0', mode: 'interval', min: 1, max: 12, v: 'interval.progress' },
      { k: 'timer', id: 'clock', r: [0.42, 0.03, 0.16, 0.09], unit: 'mmss', urgent: 10, c: 'a1', beh: ['urgent'] },
      { k: 'dial', id: 'speed', r: [0.76, 0.66, 0.2, 0.3], style: 'speedo', ticks: 10, sweep: 240, v: { src: 'audio.rms', atk: 60, rel: 500 } },
      { k: 'radar', id: 'minimap', r: [0.03, 0.66, 0.2, 0.3], style: 'minimap', blips: 8, rings: 2, sweep: 'free' },
      { k: 'slots', id: 'palette', r: [0.3, 0.86, 0.4, 0.1], n: 8, cols: 8, icon: 'gem', sel: 'beat', v: 'clock.beatPos' },
      { k: 'warning', id: 'alert', r: [0.3, 0.8, 0.4, 0.05], text: 'CAUTION', style: 'ribbon', when: 'e-1b', until: 'e-0' },
      { k: 'banner', id: 'cues', r: [0.25, 0.35, 0.5, 0.15], c: 'a1', size: 'l', cues: [{ at: 's+0', text: 'START', hold: 1.2 }, { at: 'f0.5', text: 'HALFWAY', style: 'slide', hold: 1 }] },
      { k: 'fx', id: 'glow', r: [0, 0, 1, 1], fx: 'vignette', amount: 0.3 },
    ];
    case 'cinema-triptych': return [
      { k: 'viewport', id: 'bed', r: [0, 0, 1, 1], bed: 'circuit', energy: 0.2 },
      { k: 'spectrum', id: 'bars-l', r: [0.03, 0.15, 0.22, 0.7], bars: 10, dir: 'btt', scale: 'log', hold: true, seg: 10, c: 'a2', v: 'audio.band.low' },
      { k: 'reticle', id: 'aim', r: [0.36, 0.2, 0.28, 0.5], style: 'trench', lockEvery: 2, lockHold: 1, drift: 0.3, ticks: 8, c: 'warn', v: 'audio.pan', beh: ['drift', 'lock'] },
      { k: 'matrix', id: 'sonogram', r: [0.75, 0.15, 0.22, 0.7], cols: 16, rows: 12, mode: 'spectrum', gap: 1, c: 'a1', v: 'audio.band.high' },
      { k: 'scope', id: 'wave', r: [0.3, 0.75, 0.4, 0.15], mode: 'wave', ch: 'mix', grid: true, c: 'ok', v: 'audio.beat.latched' },
      { k: 'terminal', id: 'feed', r: [0.03, 0.02, 0.4, 0.1], lines: ['ACQUIRING TARGET', 'RANGE 0421'], reveal: 'interval', mode: 'log', cursor: true, c: 'ok', v: 'interval.progress', beh: ['type'] },
      { k: 'label', id: 'tag', r: [0.6, 0.02, 0.37, 0.05], text: 'TRACKING', size: 's', align: 'right', blink: true },
      { k: 'warning', id: 'lock', r: [0.3, 0.92, 0.4, 0.05], text: 'LOCKED', style: 'edge', when: 'e-1b', until: 'e-0' },
      { k: 'banner', id: 'cues', r: [0.3, 0.4, 0.4, 0.12], c: 'a1', size: 'm', cues: [{ at: 's+0', text: 'SYSTEM ONLINE', style: 'type', hold: 1.5 }, { at: 's+4b', text: 'TARGET ACQUIRED', hold: 1 }] },
      { k: 'fx', id: 'edges', r: [0, 0, 1, 1], fx: 'vignette', amount: 0.25 },
    ];
    default: throw new Error(`No archetype ${name}`);
  }
}
/** One archetype scene. The event sets it binds are declared, and the layout is marked `template` (a generator writes `origin` `image` or `kit` when it has more to go on). */
export function archetypeManifest(name) {
  const head = ARCHETYPE_HEAD[name], layers = archetypeLayers(name), text = JSON.stringify(layers);
  const events = {};
  if (text.includes('ev.p1hits')) Object.assign(events, { p1hits: { on: 'beat', n: 9, seed: 11, bias: 0.2, gap: 1 }, p2hits: { on: 'beat', n: 6, seed: 23, bias: -0.1, gap: 1 } });
  if (text.includes('ev.hits.')) events.hits = { on: 'beat', n: 10, seed: 41, gap: 1 };
  if (text.includes('ev.hits1')) Object.assign(events, { hits1: { on: 'bar', n: 5, seed: 3 }, hits2: { on: 'bar', n: 4, seed: 8 } });
  const label = name.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  return baseManifest({
    id: `fixture-arch-${name}-01`, title: `Fixture Arch ${label}`, pack: 'fixture-pack', ...head, tags: ['fixture', 'archetype'], timing: { freeBars: 8 },
    ...(Object.keys(events).length ? { events } : {}), layers, meta: { tier: 'auto', origin: 'template', rev: 1, gen: 'fixtures-hud@1', kit: '0a0b0c0d' },
  });
}

/** Every valid fixture as [name, manifest]. */
export function allFixtures() {
  const out = [['minimal', baseManifest()], ['duel', duelManifest()], ['all-kinds', allKindsManifest()], ['intervals', intervalsManifest()], ['thin', thinManifest()]];
  for (const kind of KIND_NAMES) for (const variant of ['min', 'full']) out.push([`${kind}/${variant}`, kindManifest(kind, variant)]);
  for (const name of ARCHETYPES) out.push([`archetype/${name}`, archetypeManifest(name)]);
  return out;
}
