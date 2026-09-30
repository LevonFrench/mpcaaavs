/** `mpcaaavs-hud` v1 manifest: types, limits, kind tables, strict data-only parser, IP-safety lint, canonical serializer
 * and JSON Schema generator (docs/design/HUD-PACK-ENGINE.md section 4; docs/design/CONTRACT.md 2.3.9).
 *
 * Pure module: no imports, no DOM, no clock, no randomness. The kind tables below drive the validator, the TypeScript types and
 * `hudJsonSchema()` (tools/print-hud-schema.mjs prints it), so the three cannot drift. A manifest carries geometry, palette keys,
 * roles, signal bindings and timing only: no pixels, sprites, fonts, URLs, expressions, code or game titles.
 * Status: proposed and CPU-checked (tools/check-hud-manifest.mjs). The engine that draws manifests is a separate module. */

// ---------------------------------------------------------------------------------------------------------------- constants
export const HUD_FORMAT = 'mpcaaavs-hud';
export const HUD_VERSION = 1;
/** Hard limits. `chars` is the longest string of any kind (slugs, titles, labels, terminal lines) and also the IP-safety cap. */
export const HUD_LIMITS = Object.freeze({
  bytes: 32768, layers: 96, events: 8, intervals: 8, cues: 8, lines: 24, lineChars: 48, chars: 48, tags: 8, tagChars: 24,
  behaviours: 6, canvasMin: 64, canvasMax: 1920, freeBars: 32, issues: 64,
});
export const HUD_DEFAULTS = Object.freeze({ freeBars: 8, attentionCapacity: 4, attentionRefill: 2.5, cueHold: 1 });
/** Estimated draw-cost budgets (section 5.5). `segments` counts batched pixel rectangles and path segments. */
export const HUD_BUDGET = Object.freeze({
  soft: Object.freeze({ draws: 400, segments: 2000, texts: 40, gradients: 8, overdraw: 4 }),
  hard: Object.freeze({ draws: 900, segments: 5000, texts: 96, gradients: 24, overdraw: 8 }),
});
/** The design's sixteen families, then rhythm, mecha, online (mmo, moba), horror and the generic action, shooter, sim, strategy and survival, so that every source
 * on disk (games, films, television, anime) has a family. Film and television interfaces are usually `scifi`, `cockpit` or `terminal`. Additions only widen the accepted set. */
export const HUD_FAMILIES = ['fighting', 'shmup', 'platformer', 'brawler', 'racing', 'sports', 'puzzle', 'rpg', 'rts', 'fps', 'adventure', 'flight', 'cockpit', 'terminal', 'scifi', 'misc',
  'rhythm', 'mecha', 'mmo', 'moba', 'horror', 'action', 'shooter', 'sim', 'strategy', 'survival'] as const;
/** The design's ten eras, then `handheld`, `home` (home computers), `vector` (vector and early arcade) and `modern`, matching the owner's pack folders. */
export const HUD_ERAS = ['8bit', '16bit', 'arcade', '32bit', '128bit', 'pc-classic', 'pc-modern', 'cinema', 'anime', 'fui', 'handheld', 'home', 'vector', 'modern'] as const;
export const HUD_TIERS = ['showcase', 'tuned', 'auto'] as const;
/** Where a scene's layout came from: measured kit geometry, local image analysis at generation time, or a pure archetype template. */
export const HUD_ORIGINS = ['kit', 'image', 'template'] as const;
export const HUD_PALETTE_KEYS = ['ink', 'paper', 'shade', 'hi', 'a1', 'a2', 'ok', 'warn', 'bad'] as const;
export const HUD_PALETTE_REQUIRED = ['ink', 'paper', 'a1', 'a2', 'ok', 'warn', 'bad'] as const;
export const HUD_KINDS = ['panel', 'viewport', 'label', 'bar', 'pips', 'matrix', 'counter', 'timer', 'portrait', 'dial', 'radar', 'reticle', 'slots', 'spectrum', 'scope',
  'terminal', 'rain', 'warning', 'combo', 'banner', 'fx'] as const;
export const HUD_BEHAVIOURS = ['ghost', 'damageFlicker', 'dangerPulse', 'refill', 'capFlash', 'tick', 'urgent', 'zeroHold', 'look', 'hurt', 'grin', 'dead', 'blink', 'sweep', 'blip',
  'drift', 'lock', 'pulse', 'stripes', 'chase', 'levels', 'vote', 'select', 'peakHold', 'trace', 'ecgBeat', 'type', 'scroll', 'fall', 'burst', 'pop', 'slide', 'flash', 'window',
  'scanlines', 'vignette', 'grain', 'shake', 'glow'] as const;
export const HUD_CUE_STYLES = ['pop', 'slide', 'flash', 'type'] as const;
export const HUD_EVENT_UNITS = ['beat', 'bar', 'half-bar'] as const;
/** Attention cost of a cue-scheduled event (section 5.4). Static lint reserves these; the runtime arbitrates live accents. */
export const HUD_ATTENTION_COST = Object.freeze({ banner: 3, warning: 2, lock: 1 });

export type HudKind = typeof HUD_KINDS[number];
export type HudFamily = typeof HUD_FAMILIES[number];
export type HudEra = typeof HUD_ERAS[number];
export type HudTier = typeof HUD_TIERS[number];
export type HudOrigin = typeof HUD_ORIGINS[number];
export type HudPaletteKey = typeof HUD_PALETTE_KEYS[number];
export type HudBehaviour = typeof HUD_BEHAVIOURS[number];
export type HudRect = readonly [x: number, y: number, w: number, h: number];

// ---------------------------------------------------------------------------------------------------------------- property specs
export interface IntSpec { readonly t: 'int'; readonly min: number; readonly max: number }
export interface NumSpec { readonly t: 'num'; readonly min: number; readonly max: number }
export interface BoolSpec { readonly t: 'bool' }
export interface EnumSpec<V extends readonly string[] = readonly string[]> { readonly t: 'enum'; readonly values: V }
export interface TextSpec { readonly t: 'text'; readonly min: number; readonly max: number }
export interface RefSpec { readonly t: 'ref' }
export interface EaseSpec { readonly t: 'ease' }
export interface LinesSpec { readonly t: 'lines'; readonly maxItems: number; readonly max: number }
export interface CuesSpec { readonly t: 'cues' }
export type Spec = IntSpec | NumSpec | BoolSpec | EnumSpec | TextSpec | RefSpec | EaseSpec | LinesSpec | CuesSpec;
export interface KindSpec {
  readonly req: Readonly<Record<string, Spec>>; readonly opt: Readonly<Record<string, Spec>>;
  /** Whether the kind accepts a value binding `v`. `panel` (static, cached) and `label` (static text) do not. */
  readonly v: boolean;
  /** Documentation of the default binding when `v` is omitted (section 4.3). The engine owns the behaviour. */
  readonly bind: string | null;
}
const I = (min: number, max: number): IntSpec => ({ t: 'int', min, max });
const N = (min: number, max: number): NumSpec => ({ t: 'num', min, max });
const B: BoolSpec = { t: 'bool' };
const E = <const V extends readonly string[]>(...values: V): EnumSpec<V> => ({ t: 'enum', values });
const T = (min: number, max: number): TextSpec => ({ t: 'text', min, max });
const REF: RefSpec = { t: 'ref' };
const EASE: EaseSpec = { t: 'ease' };
const LINES = (maxItems: number, max: number): LinesSpec => ({ t: 'lines', maxItems, max });
const CUES: CuesSpec = { t: 'cues' };
const DIRS = ['ltr', 'rtl', 'ttb', 'btt'] as const;

/** The 21 instrument kinds. Order inside `req` then `opt` is the canonical property order. */
export const KIND_SPECS = {
  panel: { req: { style: E('bevel', 'notch', 'rail', 'brick', 'steel', 'crt', 'flat', 'bracket') }, opt: { title: T(1, 24), cut: I(0, 32) }, v: false, bind: null },
  viewport: { req: { bed: E('void', 'gradient', 'starfield', 'grid', 'horizon', 'city', 'waves', 'noise', 'circuit', 'tunnel') }, opt: { energy: N(0, 0.35), frame: B }, v: true, bind: 'audio.rms' },
  label: { req: { text: T(1, 32) }, opt: { size: E('s', 'm', 'l', 'xl'), align: E('left', 'center', 'right'), font: E('pixel', 'seg', 'mono', 'display'), blink: B }, v: false, bind: null },
  bar: { req: { dir: E(...DIRS) }, opt: { segs: I(0, 64), style: E('solid', 'gradient', 'ticks'), trail: B, danger: N(0, 1), cap: B }, v: true, bind: 'interval.remaining01' },
  pips: { req: { n: I(1, 32) }, opt: { icon: E('heart', 'life', 'ring', 'round', 'block', 'star', 'medal', 'dot'), dir: E(...DIRS) }, v: true, bind: null },
  matrix: { req: { cols: I(1, 32), rows: I(1, 16), mode: E('levels', 'spectrum', 'chase', 'checker', 'vote', 'sparse') }, opt: { gap: I(0, 4) }, v: true, bind: null },
  counter: {
    req: { digits: I(1, 12), fmt: E('int', 'pad0', 'time', 'percent', 'money', 'score'), mode: E('interval', 'live', 'static') },
    opt: { font: E('pixel', 'seg', 'display'), min: N(-1e9, 1e9), max: N(-1e9, 1e9), ease: EASE, tick: B, unit: T(1, 4) }, v: true, bind: 'interval.progress',
  },
  timer: { req: { unit: E('norm', 'sec', 'bars', 'beats', 'mmss') }, opt: { total: N(1, 9999), dir: E('down', 'up'), urgent: N(0, 9999), font: E('pixel', 'seg', 'display') }, v: true, bind: 'interval.remaining' },
  portrait: { req: { style: E('face', 'visor', 'eye', 'skull', 'mask', 'emblem', 'cameo') }, opt: {}, v: true, bind: null },
  dial: { req: { style: E('arc', 'ring', 'orb', 'needle', 'speedo') }, opt: { sweep: N(30, 360), ticks: I(0, 60) }, v: true, bind: 'audio.rms' },
  radar: { req: { style: E('radar', 'tracker', 'minimap', 'compass', 'sonar') }, opt: { blips: I(0, 32), rings: I(0, 6), sweep: E('beat', 'bar', 'free'), period: N(0.25, 64) }, v: true, bind: 'clock.barPhase' },
  reticle: { req: { style: E('crosshair', 'pipper', 'brackets', 'diamond', 'trench') }, opt: { lockEvery: I(1, 16), lockHold: N(0.2, 4), drift: N(0, 1), ticks: I(0, 16) }, v: true, bind: 'seed.0' },
  slots: { req: { n: I(1, 32) }, opt: { cols: I(1, 16), icon: E('box', 'dot', 'gem', 'key', 'potion', 'shield', 'sword'), sel: E('beat', 'bar', 'onset', 'static') }, v: true, bind: null },
  spectrum: { req: { bars: I(2, 64) }, opt: { dir: E(...DIRS), scale: E('lin', 'log', 'sqrt'), hold: B, mirror: B, seg: I(0, 32) }, v: true, bind: null },
  scope: { req: { mode: E('wave', 'lissajous', 'ecg', 'scope') }, opt: { ch: E('l', 'r', 'mix', 'both'), grid: B, status: LINES(4, 16) }, v: true, bind: null },
  terminal: { req: { lines: LINES(24, 48) }, opt: { reveal: E('interval', 'beat', 'static'), mode: E('text', 'hex', 'log'), cursor: B }, v: true, bind: 'interval.progress' },
  rain: { req: { cols: I(1, 64) }, opt: { set: E('bin', 'hex', 'code', 'dots') }, v: true, bind: 'audio.rms' },
  warning: { req: { text: T(1, 24) }, opt: { style: E('ribbon', 'hazard', 'edge'), hz: N(0.1, 2.5), when: REF, until: REF }, v: true, bind: null },
  combo: { req: { text: T(1, 24) }, opt: { window: N(0.1, 4), rank: B }, v: true, bind: null },
  banner: { req: { cues: CUES }, opt: { size: E('m', 'l', 'xl') }, v: true, bind: null },
  fx: { req: { fx: E('scanlines', 'vignette', 'grain', 'flash', 'shake', 'glow'), amount: N(0, 1) }, opt: {}, v: true, bind: null },
} as const satisfies Record<HudKind, KindSpec>;

export interface HudCue { readonly at: string; readonly text: string; readonly style?: typeof HUD_CUE_STYLES[number]; readonly hold?: number }
type Val<S> = S extends EnumSpec<infer V> ? V[number] : S extends IntSpec | NumSpec ? number : S extends BoolSpec ? boolean : S extends LinesSpec ? readonly string[] : S extends CuesSpec ? readonly HudCue[] : string;
type Table = typeof KIND_SPECS;
type Props<K extends HudKind> = { readonly [P in keyof Table[K]['req']]: Val<Table[K]['req'][P]> } & { readonly [P in keyof Table[K]['opt']]?: Val<Table[K]['opt'][P]> };
export interface HudSignalObject {
  readonly src: string; readonly in?: readonly [number, number]; readonly out?: readonly [number, number]; readonly curve?: string;
  readonly atk?: number; readonly rel?: number; readonly gate?: number; readonly steps?: number; readonly fb?: number;
}
export type HudSignalRef = string | HudSignalObject;
interface HudBase<K extends HudKind> {
  readonly k: K; readonly id: string; readonly r: HudRect; readonly z?: number; readonly c?: HudPaletteKey; readonly c2?: HudPaletteKey;
  readonly v?: HudSignalRef; readonly beh?: readonly HudBehaviour[];
}
export type HudInstrumentOf<K extends HudKind> = HudBase<K> & Props<K>;
export type HudInstrument = { [K in HudKind]: HudInstrumentOf<K> }[HudKind];
export interface HudCanvas { readonly w: number; readonly h: number; readonly style: 'pixel' | 'vector'; readonly par?: readonly [number, number] }
export type HudPalette = { readonly [K in typeof HUD_PALETTE_REQUIRED[number]]: string } & { readonly shade?: string; readonly hi?: string };
export interface HudEventSpec { readonly on: typeof HUD_EVENT_UNITS[number]; readonly n: number; readonly seed: number; readonly bias?: number; readonly gap?: number; readonly from?: string; readonly to?: string }
/** A named interval the scene binds as `iv.<id>.*`. The active setup's saved interval of that id wins; this span (scene-relative time references) is the authored default.
 * A scene may also bind an id it does not declare: that reads only from a saved setup, and the binding's `fb` (or the instrument's fallback) applies otherwise (a lint warning). */
export interface HudIntervalDecl { readonly from: string; readonly to: string }
export interface HudMeta { readonly tier: HudTier; readonly origin?: HudOrigin; readonly rev: number; readonly gen?: string; readonly kit?: string }
export interface HudManifest {
  readonly format: typeof HUD_FORMAT; readonly version: typeof HUD_VERSION;
  readonly id: string; readonly title: string; readonly pack: string; readonly family: HudFamily; readonly era: HudEra;
  readonly reference?: { readonly platform?: string; readonly year?: number; readonly genre?: string };
  readonly tags?: readonly string[];
  readonly canvas: HudCanvas; readonly palette: HudPalette;
  readonly timing?: { readonly freeBars?: number };
  /** Own-property maps: read them with `Object.hasOwn`, never with `in` or a bare index of an untrusted id. */
  readonly events?: Readonly<Record<string, HudEventSpec>>;
  readonly intervals?: Readonly<Record<string, HudIntervalDecl>>;
  readonly attention?: { readonly capacity?: number; readonly refill?: number };
  readonly layers: readonly HudInstrument[];
  readonly meta?: HudMeta;
}

// ---------------------------------------------------------------------------------------------------------------- patterns
const SLUG = /^[a-z0-9][a-z0-9-]{1,47}$/;
const LAYER_ID = /^[a-z0-9_-]{1,24}$/;
const INTERVAL_ID = /^[a-z0-9_-]{1,32}$/;
const TAG = /^[a-z0-9][a-z0-9-]{0,23}$/;
const KIT = /^[0-9a-f]{8}$/;
const HEX = /^#[0-9a-f]{6}$/;
const ASCII = /^[\x20-\x7e]*$/;
const ASCII_DOT = /^[\x20-\x7e\u00b7]*$/;
const CURVE = /^(?:lin|smooth|(?:exp|pow):\d{1,2}(?:\.\d{1,3})?|steps:\d{1,3})$/;
const EASE_RE = /^(?:lin|smooth|(?:exp|pow):\d{1,2}(?:\.\d{1,3})?)$/;
const TIME_REF = /^(?:([se])([+-])(\d{1,4}(?:\.\d{1,3})?)([bs])?|f(0(?:\.\d{1,4})?|1(?:\.0{1,4})?))$/;
const CONST_NUMBER = /^-?\d{1,9}(?:\.\d{1,6})?$/;
const MEDIA_HITS: readonly [RegExp, string][] = [
  [/:\/\//, 'must not contain a URL'], [/\bdata:/i, 'must not contain a data URI'], [/\bwww\./i, 'must not contain a web address'],
  [/[\\]|[A-Za-z]:[\\/]/, 'must not contain a file path'], [/(?:^|[\s(])(?:~|\.{1,2})?\/[\w.-]+\/[\w.-]+/, 'must not contain a file path'], [/[\w.+-]+@[\w-]+\.[a-z]{2,}/i, 'must not contain an e-mail address'],
  [/[A-Za-z0-9+/=]{24,}/, 'must not contain an encoded run'], [/[0-9a-fA-F]{16,}/, 'must not contain a long hexadecimal run'],
];
const BASE_KEYS = ['k', 'id', 'r', 'z', 'c', 'c2', 'beh'] as const;
const ROOT_KEYS = ['format', 'version', 'id', 'title', 'pack', 'family', 'era', 'reference', 'tags', 'canvas', 'palette', 'timing', 'events', 'intervals', 'attention', 'layers', 'meta'] as const;
const SIGNAL_KEYS = ['src', 'in', 'out', 'curve', 'atk', 'rel', 'gate', 'steps', 'fb'] as const;

// ---------------------------------------------------------------------------------------------------------------- time references
export interface HudTimeRef {
  /** `s` scene start, `e` scene end, `f` fraction of the scene. */
  readonly anchor: 's' | 'e' | 'f';
  /** Signed offset from the anchor in `unit`. Zero for `f`. */
  readonly offset: number;
  /** `b` bars, `s` seconds (also the default when no unit is written). */
  readonly unit: 'b' | 's';
  /** Fraction 0..1 for `f`, else 0. */
  readonly frac: number;
}
/** Grammar: `s+2b` (two bars after the start), `e-1b`, `e-0`, `s+1.5` (seconds), `f0.5`. Null when malformed. */
export function parseTimeRef(text: string): HudTimeRef | null {
  if (typeof text !== 'string') return null;
  const m = TIME_REF.exec(text);
  if (!m) return null;
  if (m[5] !== undefined) return { anchor: 'f', offset: 0, unit: 's', frac: Number(m[5]) };
  const size = Number(m[3]);
  return { anchor: m[1] as 's' | 'e', offset: m[2] === '-' ? -size : size, unit: m[4] === 'b' ? 'b' : 's', frac: 0 };
}

// ---------------------------------------------------------------------------------------------------------------- signals
export const HUD_BANDS = ['sub', 'low', 'mid', 'high', 'air'] as const;
export const HUD_GROUPS = ['kick', 'snare', 'hat', 'tonal', 'any'] as const;
/** Fields of every signal family. `iv` has no `overrun`; `seed.<0..7>` and `const.<number>` have no fields table.
 * Value ranges are the engine's business, not the manifest's: `audio.beat.level` is the raw AVS beat level (up to 73728) and `audio.contour.fast`/`slow` are
 * unnormalised, so a binding to either maps them with `in`/`out`. Every `audio.*` name is served by `HudSignalsV2` in hud-signals.ts (tools/check-hud-manifest.mjs pins this). */
export const HUD_SIGNAL_FIELDS = Object.freeze({
  interval: ['progress', 'remaining', 'remaining01', 'elapsed', 'remainingBars', 'elapsedBars', 'totalBars', 'known', 'freePhase', 'overrun'],
  iv: ['progress', 'remaining', 'remaining01', 'elapsed', 'remainingBars', 'elapsedBars', 'totalBars', 'known', 'freePhase'],
  clock: ['beatPhase', 'beatInBar', 'barPhase', 'barIndex', 'beatPos', 'bpm', 'sweep'],
  track: ['position', 'duration', 'progress', 'remaining', 'known'],
  ev: ['cum', 'remaining', 'count', 'pulse', 'since', 'next'],
  audio: ['rms', 'pan', 'width', 'flux', 'centroid', 'tension', 'slope'],
  audioOnset: ['env', 'fired', 'count', 'ageSec', 'strength'],
} as const);
export interface HudSignalInfo {
  readonly group: 'audio' | 'clock' | 'interval' | 'iv' | 'track' | 'ev' | 'seed' | 'const';
  /** Event or interval id for `ev` and `iv`. */
  readonly id?: string;
  readonly field: string;
}
/** Resolve a dotted signal name against the registry (section 4.4). Null when the name is not a registered signal. */
export function parseHudSignal(name: string): HudSignalInfo | null {
  if (typeof name !== 'string' || name.length > 64) return null;
  const p = name.split('.');
  const has = (list: readonly string[], x: string | undefined) => x !== undefined && list.includes(x);
  switch (p[0]) {
    case 'interval': return p.length === 2 && has(HUD_SIGNAL_FIELDS.interval, p[1]) ? { group: 'interval', field: p[1]! } : null;
    case 'clock': return p.length === 2 && has(HUD_SIGNAL_FIELDS.clock, p[1]) ? { group: 'clock', field: p[1]! } : null;
    case 'track': return p.length === 2 && has(HUD_SIGNAL_FIELDS.track, p[1]) ? { group: 'track', field: p[1]! } : null;
    case 'iv': return p.length === 3 && INTERVAL_ID.test(p[1]!) && has(HUD_SIGNAL_FIELDS.iv, p[2]) ? { group: 'iv', id: p[1]!, field: p[2]! } : null;
    case 'ev': return p.length === 3 && SLUG.test(p[1]!) && has(HUD_SIGNAL_FIELDS.ev, p[2]) ? { group: 'ev', id: p[1]!, field: p[2]! } : null;
    case 'seed': return p.length === 2 && /^[0-7]$/.test(p[1]!) ? { group: 'seed', field: p[1]! } : null;
    case 'const': {
      const rest = p.slice(1).join('.');
      return p.length >= 2 && p.length <= 3 && CONST_NUMBER.test(rest) ? { group: 'const', field: rest } : null;
    }
    case 'audio': {
      const f = p[1];
      if (p.length === 2 && has(HUD_SIGNAL_FIELDS.audio, f)) return { group: 'audio', field: f! };
      if (p.length === 3 && (f === 'band' || f === 'bandL' || f === 'bandR' || f === 'panBand') && has(HUD_BANDS, p[2])) return { group: 'audio', field: name.slice(6) };
      if (p.length === 4 && f === 'onset' && has(HUD_GROUPS, p[2]) && has(HUD_SIGNAL_FIELDS.audioOnset, p[3])) return { group: 'audio', field: name.slice(6) };
      if (p.length === 3 && f === 'beat' && (p[2] === 'latched' || p[2] === 'level')) return { group: 'audio', field: name.slice(6) };
      if (p.length === 3 && f === 'contour' && (p[2] === 'fast' || p[2] === 'slow')) return { group: 'audio', field: name.slice(6) };
      if (p.length === 3 && f === 'legacy' && has(['low', 'mid', 'high', 'level'], p[2])) return { group: 'audio', field: name.slice(6) };
      return null;
    }
    default: return null;
  }
}
/** Every fixed signal name (no per-scene `ev.*`/`iv.*`, `seed.*` or `const.*`), for engines that index a sample space. */
export const HUD_STATIC_SIGNALS: readonly string[] = (() => {
  const out: string[] = [];
  for (const g of ['interval', 'clock', 'track'] as const) for (const f of HUD_SIGNAL_FIELDS[g]) out.push(`${g}.${f}`);
  for (const f of HUD_SIGNAL_FIELDS.audio) out.push(`audio.${f}`);
  for (const g of ['band', 'bandL', 'bandR', 'panBand'] as const) for (const b of HUD_BANDS) out.push(`audio.${g}.${b}`);
  for (const g of HUD_GROUPS) for (const f of HUD_SIGNAL_FIELDS.audioOnset) out.push(`audio.onset.${g}.${f}`);
  out.push('audio.beat.latched', 'audio.beat.level', 'audio.contour.fast', 'audio.contour.slow');
  for (const f of ['low', 'mid', 'high', 'level']) out.push(`audio.legacy.${f}`);
  return Object.freeze(out);
})();

// ---------------------------------------------------------------------------------------------------------------- issues
export interface HudIssue { readonly level: 'error' | 'warn'; readonly path: string; readonly message: string }
export class HudManifestError extends Error {
  readonly issues: readonly HudIssue[];
  constructor(issues: readonly HudIssue[]) {
    const first = issues.find(i => i.level === 'error') ?? issues[0];
    super(`Invalid HUD manifest: ${first ? `${first.path || '(root)'}: ${first.message}` : 'unknown error'}`);
    this.name = 'HudManifestError';
    this.issues = issues;
  }
}
export interface HudLintOptions {
  /** Deny-list hook: called with each normalised 1..3 word n-gram of every name-like string; return true to reject the manifest.
   * Callers hash the n-gram against a salted digest list; the module never echoes a matched term. */
  readonly deny?: (ngram: string) => boolean;
}
export interface HudCheckResult { readonly manifest: HudManifest | null; readonly issues: readonly HudIssue[] }

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Rec, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);
/** Issue path. An untrusted key is shortened so a hostile file cannot flood logs. */
const at = (path: string, key: string | number): string => {
  if (typeof key === 'number') return `${path}[${key}]`;
  const k = key.length > 40 ? `${key.slice(0, 37)}...` : key;
  return path ? `${path}.${k}` : k;
};

class Ctx {
  readonly issues: HudIssue[] = [];
  errors = 0;
  err(path: string, message: string): void {
    this.errors++;
    if (this.issues.length < HUD_LIMITS.issues) this.issues.push({ level: 'error', path, message });
  }
  /** Warnings stop eight slots short of the cap, so an error found after many warnings still has a place in the list. */
  warn(path: string, message: string): void {
    if (this.issues.length < HUD_LIMITS.issues - 8) this.issues.push({ level: 'warn', path, message });
  }
}

// ---------------------------------------------------------------------------------------------------------------- primitive readers
function unknownKeys(c: Ctx, o: Rec, path: string, allowed: readonly string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) c.err(at(path, k), 'unknown key');
}
function readObject(c: Ctx, v: unknown, path: string, allowed: readonly string[]): Rec | undefined {
  if (!isRec(v)) { c.err(path, 'must be an object'); return undefined; }
  unknownKeys(c, v, path, allowed);
  return v;
}
function readInt(c: Ctx, v: unknown, path: string, min: number, max: number): number | undefined {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) { c.err(path, `must be a whole number from ${min} to ${max}`); return undefined; }
  return v + 0; // folds -0 into 0, exactly as the canonical text writes it
}
/** Canonical number: rounded to 6 places (exactly what the serializer writes) with -0 folded into 0. Readers store the canonical value, so a parsed
 * manifest already equals its own canonical form and `parse(serialize(parse(x)))` is `parse(x)`. Idempotent. */
const canon = (n: number): number => Math.round(n * 1e6) / 1e6 + 0;
function readNum(c: Ctx, v: unknown, path: string, min: number, max: number): number | undefined {
  const n = typeof v === 'number' && Number.isFinite(v) ? canon(v) : NaN;
  if (!(n >= min && n <= max)) { c.err(path, `must be a number from ${min} to ${max}`); return undefined; }
  return n;
}
function readBool(c: Ctx, v: unknown, path: string): boolean | undefined {
  if (typeof v !== 'boolean') { c.err(path, 'must be true or false'); return undefined; }
  return v;
}
/** Issue text for an enumeration: the whole list when short, else the first few values and the count, so one bad word never floods the issue list. */
const enumText = (values: readonly string[]): string => (values.length > 12 ? `${values.slice(0, 8).join(', ')}, ... (${values.length} values)` : values.join(', '));
function readEnum<V extends string>(c: Ctx, v: unknown, path: string, values: readonly V[]): V | undefined {
  if (typeof v !== 'string' || !values.includes(v as V)) { c.err(path, `must be one of ${enumText(values)}`); return undefined; }
  return v as V;
}
/** Free text: bounded, printable ASCII (the middle dot U+00B7 only where `dot`), and free of anything that could carry embedded media or a location.
 * `media` is false for identifiers, whose pattern already excludes every location character: an id such as 24 plain letters is a name, not an encoded run. */
function readText(c: Ctx, v: unknown, path: string, min: number, max: number, dot = false, media = true): string | undefined {
  if (typeof v !== 'string') { c.err(path, 'must be a string'); return undefined; }
  if (v.length < min || v.length > Math.min(max, HUD_LIMITS.chars)) { c.err(path, `must be ${min} to ${Math.min(max, HUD_LIMITS.chars)} characters`); return undefined; }
  if (!(dot ? ASCII_DOT : ASCII).test(v)) { c.err(path, dot ? 'must be printable ASCII (the middle dot is also allowed)' : 'must be printable ASCII'); return undefined; }
  if (media) for (const [re, message] of MEDIA_HITS) if (re.test(v)) { c.err(path, message); return undefined; }
  return v;
}
function readPattern(c: Ctx, v: unknown, path: string, re: RegExp, what: string): string | undefined {
  const s = readText(c, v, path, 1, HUD_LIMITS.chars, false, false);
  if (s === undefined) return undefined;
  if (!re.test(s)) { c.err(path, `must be ${what}`); return undefined; }
  return s;
}
const readSlug = (c: Ctx, v: unknown, path: string) => readPattern(c, v, path, SLUG, 'a lower-case slug of 2 to 48 letters, digits and hyphens');
function readTimeRef(c: Ctx, v: unknown, path: string): string | undefined {
  if (typeof v !== 'string' || !parseTimeRef(v)) { c.err(path, 'must be a time reference such as s+2b, e-1b, e-0, s+1.5 or f0.5'); return undefined; }
  return v;
}
function readRect(c: Ctx, v: unknown, path: string): HudRect | undefined {
  if (!Array.isArray(v) || v.length !== 4) { c.err(path, 'must be [x, y, w, h]'); return undefined; }
  const r = Array.from(v, n => (typeof n === 'number' && Number.isFinite(n) && canon(n) >= 0 && canon(n) <= 1 ? canon(n) : NaN)); // Array.from visits holes of a sparse array
  if (r.some(Number.isNaN)) { c.err(path, 'each value must be a number from 0 to 1'); return undefined; }
  const [x, y, w, h] = r as [number, number, number, number];
  if (!(w > 0) || !(h > 0)) { c.err(path, 'width and height must be greater than 0'); return undefined; }
  if (x + w > 1 + 1e-9 || y + h > 1 + 1e-9) { c.err(path, 'must lie inside the canvas'); return undefined; }
  return Object.freeze([x, y, w, h]) as HudRect;
}
function readPair(c: Ctx, v: unknown, path: string, min: number, max: number, distinct = false): readonly [number, number] | undefined {
  if (!Array.isArray(v) || v.length !== 2) { c.err(path, 'must be a pair of numbers'); return undefined; }
  const a = readNum(c, v[0], at(path, 0), min, max), b = readNum(c, v[1], at(path, 1), min, max);
  if (a === undefined || b === undefined) return undefined;
  if (distinct && a === b) { c.err(path, 'the two values must differ'); return undefined; }
  return Object.freeze([a, b]) as readonly [number, number];
}

// ---------------------------------------------------------------------------------------------------------------- signal bindings
function readSignal(c: Ctx, v: unknown, path: string): HudSignalRef | undefined {
  if (typeof v === 'string') {
    if (!parseHudSignal(v)) { c.err(path, 'is not a registered signal'); return undefined; }
    return v;
  }
  const o = readObject(c, v, path, SIGNAL_KEYS);
  if (!o) return undefined;
  const out: Record<string, unknown> = {};
  const src = own(o, 'src');
  if (typeof src !== 'string' || !parseHudSignal(src)) c.err(at(path, 'src'), 'is not a registered signal'); else out.src = src;
  for (const key of ['in', 'out'] as const) if (own(o, key) !== undefined) { const p = readPair(c, own(o, key), at(path, key), -1e9, 1e9, key === 'in'); if (p) out[key] = p; }
  const curve = own(o, 'curve');
  if (curve !== undefined) {
    const p = at(path, 'curve');
    if (typeof curve !== 'string' || !CURVE.test(curve)) c.err(p, 'must be lin, smooth, exp:<g>, pow:<g> or steps:<n>');
    else {
      const [kind, arg] = curve.split(':');
      const g = Number(arg);
      if ((kind === 'exp' || kind === 'pow') && !(g > 0 && g <= 16)) c.err(p, 'exponent must be greater than 0 and at most 16');
      else if (kind === 'steps' && !(g >= 1 && g <= 256)) c.err(p, 'steps must be 1 to 256');
      else out.curve = curve;
    }
  }
  for (const [key, lo, hi] of [['atk', 0, 5000], ['rel', 0, 5000], ['gate', 0, 1], ['fb', -1e9, 1e9]] as const) {
    if (own(o, key) !== undefined) { const n = readNum(c, own(o, key), at(path, key), lo, hi); if (n !== undefined) out[key] = n; }
  }
  if (own(o, 'steps') !== undefined) { const n = readInt(c, own(o, 'steps'), at(path, 'steps'), 1, 256); if (n !== undefined) out.steps = n; }
  return out as unknown as HudSignalRef;
}
const signalSource = (v: HudSignalRef): string => (typeof v === 'string' ? v : v.src);

// ---------------------------------------------------------------------------------------------------------------- instruments
function readCues(c: Ctx, v: unknown, path: string): readonly HudCue[] | undefined {
  if (!Array.isArray(v) || v.length < 1 || v.length > HUD_LIMITS.cues) { c.err(path, `must be 1 to ${HUD_LIMITS.cues} cues`); return undefined; }
  const cues: HudCue[] = [];
  Array.from(v).forEach((raw, i) => { // a hole of a sparse array reads as undefined and is refused like any non-object
    const p = at(path, i);
    const o = readObject(c, raw, p, ['at', 'text', 'style', 'hold']);
    if (!o) return;
    const cueAt = readTimeRef(c, own(o, 'at'), at(p, 'at')), text = readText(c, own(o, 'text'), at(p, 'text'), 1, 24);
    const cue: Record<string, unknown> = {};
    if (cueAt !== undefined) cue.at = cueAt;
    if (text !== undefined) cue.text = text;
    if (own(o, 'style') !== undefined) { const s = readEnum(c, own(o, 'style'), at(p, 'style'), HUD_CUE_STYLES); if (s) cue.style = s; }
    if (own(o, 'hold') !== undefined) { const h = readNum(c, own(o, 'hold'), at(p, 'hold'), 0.1, 8); if (h !== undefined) cue.hold = h; }
    if (cueAt !== undefined && text !== undefined) cues.push(cue as unknown as HudCue);
  });
  return cues.length === v.length ? Object.freeze(cues) : undefined;
}
function readSpec(c: Ctx, s: Spec, v: unknown, path: string): unknown {
  switch (s.t) {
    case 'int': return readInt(c, v, path, s.min, s.max);
    case 'num': return readNum(c, v, path, s.min, s.max);
    case 'bool': return readBool(c, v, path);
    case 'enum': return readEnum(c, v, path, s.values);
    case 'text': return readText(c, v, path, s.min, s.max);
    case 'ref': return readTimeRef(c, v, path);
    case 'ease':
      if (typeof v !== 'string' || !EASE_RE.test(v)) { c.err(path, 'must be lin, smooth, exp:<g> or pow:<g>'); return undefined; }
      return v;
    case 'lines': {
      if (!Array.isArray(v) || v.length < 1 || v.length > s.maxItems) { c.err(path, `must be 1 to ${s.maxItems} strings`); return undefined; }
      const lines = Array.from(v, (x, i) => readText(c, x, at(path, i), 1, s.max));
      return lines.every(x => x !== undefined) ? Object.freeze(lines) : undefined;
    }
    case 'cues': return readCues(c, v, path);
  }
}
const isKind = (x: string): x is HudKind => Object.hasOwn(KIND_SPECS, x);
function readLayer(c: Ctx, raw: unknown, path: string): HudInstrument | undefined {
  if (!isRec(raw)) { c.err(path, 'must be an object'); return undefined; }
  const kind = own(raw, 'k');
  if (typeof kind !== 'string' || !isKind(kind)) { c.err(at(path, 'k'), `must be one of ${enumText(HUD_KINDS)}`); return undefined; }
  const spec: KindSpec = KIND_SPECS[kind];
  const props = [...Object.keys(spec.req), ...Object.keys(spec.opt)];
  for (const key of Object.keys(raw)) {
    if (key === 'v' && !spec.v) c.err(at(path, key), `kind ${kind} takes no value binding`);
    else if (![...BASE_KEYS, ...(spec.v ? ['v'] : []), ...props].includes(key)) c.err(at(path, key), `unknown key for kind ${kind}`);
  }
  const out: Record<string, unknown> = { k: kind };
  const id = readPattern(c, own(raw, 'id'), at(path, 'id'), LAYER_ID, 'up to 24 lower-case letters, digits, hyphens or underscores');
  if (id !== undefined) out.id = id;
  const rect = readRect(c, own(raw, 'r'), at(path, 'r'));
  if (rect) out.r = rect;
  if (own(raw, 'z') !== undefined) { const z = readInt(c, own(raw, 'z'), at(path, 'z'), 0, 99); if (z !== undefined) out.z = z; }
  for (const key of ['c', 'c2'] as const) if (own(raw, key) !== undefined) { const p = readEnum(c, own(raw, key), at(path, key), HUD_PALETTE_KEYS); if (p) out[key] = p; }
  for (const [group, required] of [[spec.req, true], [spec.opt, false]] as const) {
    for (const [name, s] of Object.entries(group)) {
      const value = own(raw, name);
      if (value === undefined) { if (required) c.err(at(path, name), 'is required'); continue; }
      const read = readSpec(c, s, value, at(path, name));
      if (read !== undefined) out[name] = read;
    }
  }
  if (spec.v && own(raw, 'v') !== undefined) { const v = readSignal(c, own(raw, 'v'), at(path, 'v')); if (v !== undefined) out.v = v; }
  const beh = own(raw, 'beh');
  if (beh !== undefined) {
    if (!Array.isArray(beh) || beh.length > HUD_LIMITS.behaviours || new Set(Array.from(beh)).size !== beh.length) c.err(at(path, 'beh'), `must be at most ${HUD_LIMITS.behaviours} distinct behaviours`);
    else {
      const list = Array.from(beh, (b, i) => readEnum(c, b, at(at(path, 'beh'), i), HUD_BEHAVIOURS));
      if (list.every(b => b !== undefined)) out.beh = Object.freeze(list);
    }
  }
  return out as unknown as HudInstrument;
}

// ---------------------------------------------------------------------------------------------------------------- root reader
function readMap<T>(c: Ctx, v: unknown, path: string, max: number, keyRe: RegExp, keyWhat: string, item: (raw: unknown, p: string) => T | undefined): Record<string, T> | undefined {
  if (!isRec(v)) { c.err(path, 'must be an object'); return undefined; }
  const keys = Object.keys(v).sort(); // sorted, like the canonical text, so the parsed map does not depend on the order the file wrote its keys
  if (keys.length > max) c.err(path, `must have at most ${max} entries`);
  const out: Record<string, T> = {};
  for (const key of keys.slice(0, max)) {
    if (key === '__proto__' || !keyRe.test(key)) { c.err(at(path, key), `key must be ${keyWhat}`); continue; }
    const read = item(v[key], at(path, key));
    if (read !== undefined) out[key] = read;
  }
  return out;
}
function readEvent(c: Ctx, raw: unknown, p: string): HudEventSpec | undefined {
  const o = readObject(c, raw, p, ['on', 'n', 'seed', 'bias', 'gap', 'from', 'to']);
  if (!o) return undefined;
  const out: Record<string, unknown> = {};
  const on = readEnum(c, own(o, 'on'), at(p, 'on'), HUD_EVENT_UNITS), n = readInt(c, own(o, 'n'), at(p, 'n'), 1, 64), seed = readInt(c, own(o, 'seed'), at(p, 'seed'), 0, 4294967295);
  if (on) out.on = on;
  if (n !== undefined) out.n = n;
  if (seed !== undefined) out.seed = seed;
  if (own(o, 'bias') !== undefined) { const b = readNum(c, own(o, 'bias'), at(p, 'bias'), -1, 1); if (b !== undefined) out.bias = b; }
  if (own(o, 'gap') !== undefined) { const g = readInt(c, own(o, 'gap'), at(p, 'gap'), 0, 16); if (g !== undefined) out.gap = g; }
  for (const key of ['from', 'to'] as const) if (own(o, key) !== undefined) { const r = readTimeRef(c, own(o, key), at(p, key)); if (r) out[key] = r; }
  return on && n !== undefined && seed !== undefined ? Object.freeze(out) as unknown as HudEventSpec : undefined;
}
function readInterval(c: Ctx, raw: unknown, p: string): HudIntervalDecl | undefined {
  const o = readObject(c, raw, p, ['from', 'to']);
  if (!o) return undefined;
  const from = readTimeRef(c, own(o, 'from'), at(p, 'from')), to = readTimeRef(c, own(o, 'to'), at(p, 'to'));
  return from && to ? Object.freeze({ from, to }) : undefined;
}
function readRoot(c: Ctx, value: unknown): HudManifest | undefined {
  const o = readObject(c, value, '', ROOT_KEYS);
  if (!o) return undefined;
  const out: Record<string, unknown> = {};
  if (own(o, 'format') !== HUD_FORMAT) c.err('format', `must be ${HUD_FORMAT}`); else out.format = HUD_FORMAT;
  if (own(o, 'version') !== HUD_VERSION) c.err('version', `must be ${HUD_VERSION}`); else out.version = HUD_VERSION;
  const put = (key: string, v: unknown) => { if (v !== undefined) out[key] = v; };
  put('id', readSlug(c, own(o, 'id'), 'id'));
  put('title', readText(c, own(o, 'title'), 'title', 1, HUD_LIMITS.chars, true));
  put('pack', readSlug(c, own(o, 'pack'), 'pack'));
  put('family', readEnum(c, own(o, 'family'), 'family', HUD_FAMILIES));
  put('era', readEnum(c, own(o, 'era'), 'era', HUD_ERAS));
  if (own(o, 'reference') !== undefined) {
    const r = readObject(c, own(o, 'reference'), 'reference', ['platform', 'year', 'genre']);
    if (r) {
      const ref: Record<string, unknown> = {};
      if (own(r, 'platform') !== undefined) { const v = readSlug(c, own(r, 'platform'), 'reference.platform'); if (v) ref.platform = v; }
      if (own(r, 'year') !== undefined) { const v = readInt(c, own(r, 'year'), 'reference.year', 1900, 2100); if (v !== undefined) ref.year = v; }
      if (own(r, 'genre') !== undefined) { const v = readSlug(c, own(r, 'genre'), 'reference.genre'); if (v) ref.genre = v; }
      out.reference = Object.freeze(ref);
    }
  }
  if (own(o, 'tags') !== undefined) {
    const t = own(o, 'tags');
    if (!Array.isArray(t) || t.length > HUD_LIMITS.tags || new Set(Array.from(t)).size !== t.length) c.err('tags', `must be at most ${HUD_LIMITS.tags} distinct tags`);
    else {
      const tags = Array.from(t, (x, i) => readPattern(c, x, at('tags', i), TAG, 'a lower-case tag of up to 24 letters, digits and hyphens'));
      if (tags.every(x => x !== undefined)) out.tags = Object.freeze(tags);
    }
  }
  const cv = readObject(c, own(o, 'canvas'), 'canvas', ['w', 'h', 'style', 'par']);
  if (cv) {
    const canvas: Record<string, unknown> = {};
    const w = readInt(c, own(cv, 'w'), 'canvas.w', HUD_LIMITS.canvasMin, HUD_LIMITS.canvasMax), h = readInt(c, own(cv, 'h'), 'canvas.h', HUD_LIMITS.canvasMin, HUD_LIMITS.canvasMax);
    const style = readEnum(c, own(cv, 'style'), 'canvas.style', ['pixel', 'vector'] as const);
    if (w !== undefined) canvas.w = w;
    if (h !== undefined) canvas.h = h;
    if (style) canvas.style = style;
    if (own(cv, 'par') !== undefined) {
      const par = own(cv, 'par');
      if (!Array.isArray(par) || par.length !== 2) c.err('canvas.par', 'must be [numerator, denominator]');
      else {
        const n = readInt(c, par[0], 'canvas.par[0]', 1, 16), d = readInt(c, par[1], 'canvas.par[1]', 1, 16);
        if (n !== undefined && d !== undefined) canvas.par = Object.freeze([n, d]);
      }
    }
    put('canvas', Object.freeze(canvas));
  }
  const pal = readObject(c, own(o, 'palette'), 'palette', HUD_PALETTE_KEYS);
  if (pal) {
    const palette: Record<string, unknown> = {};
    for (const key of HUD_PALETTE_KEYS) {
      const v = own(pal, key);
      if (v === undefined) { if ((HUD_PALETTE_REQUIRED as readonly string[]).includes(key)) c.err(at('palette', key), 'is required'); continue; }
      if (typeof v !== 'string' || !HEX.test(v)) c.err(at('palette', key), 'must be a lower-case #rrggbb colour'); else palette[key] = v;
    }
    put('palette', Object.freeze(palette));
  }
  if (own(o, 'timing') !== undefined) {
    const t = readObject(c, own(o, 'timing'), 'timing', ['freeBars']);
    if (t) {
      const timing: Record<string, unknown> = {};
      if (own(t, 'freeBars') !== undefined) { const f = readInt(c, own(t, 'freeBars'), 'timing.freeBars', 1, HUD_LIMITS.freeBars); if (f !== undefined) timing.freeBars = f; }
      out.timing = Object.freeze(timing);
    }
  }
  if (own(o, 'events') !== undefined) { const m = readMap(c, own(o, 'events'), 'events', HUD_LIMITS.events, SLUG, 'a lower-case slug', (raw, p) => readEvent(c, raw, p)); if (m) out.events = Object.freeze(m); }
  if (own(o, 'intervals') !== undefined) { const m = readMap(c, own(o, 'intervals'), 'intervals', HUD_LIMITS.intervals, INTERVAL_ID, 'up to 32 lower-case letters, digits, hyphens or underscores', (raw, p) => readInterval(c, raw, p)); if (m) out.intervals = Object.freeze(m); }
  if (own(o, 'attention') !== undefined) {
    const a = readObject(c, own(o, 'attention'), 'attention', ['capacity', 'refill']);
    if (a) {
      const att: Record<string, unknown> = {};
      if (own(a, 'capacity') !== undefined) { const v = readNum(c, own(a, 'capacity'), 'attention.capacity', 1, 8); if (v !== undefined) att.capacity = v; }
      if (own(a, 'refill') !== undefined) { const v = readNum(c, own(a, 'refill'), 'attention.refill', 0.5, 6); if (v !== undefined) att.refill = v; }
      out.attention = Object.freeze(att);
    }
  }
  const layers = own(o, 'layers');
  if (!Array.isArray(layers) || layers.length < 1 || layers.length > HUD_LIMITS.layers) c.err('layers', `must be 1 to ${HUD_LIMITS.layers} instruments`);
  else {
    const read = Array.from(layers, (raw, i) => readLayer(c, raw, at('layers', i)));
    out.layers = Object.freeze(read.filter((x): x is HudInstrument => x !== undefined).map(x => Object.freeze(x)));
  }
  if (own(o, 'meta') !== undefined) {
    const m = readObject(c, own(o, 'meta'), 'meta', ['tier', 'origin', 'rev', 'gen', 'kit']);
    if (m) {
      const meta: Record<string, unknown> = {};
      const tier = readEnum(c, own(m, 'tier'), 'meta.tier', HUD_TIERS), rev = readInt(c, own(m, 'rev'), 'meta.rev', 1, 1000000);
      if (tier) meta.tier = tier;
      if (own(m, 'origin') !== undefined) { const v = readEnum(c, own(m, 'origin'), 'meta.origin', HUD_ORIGINS); if (v) meta.origin = v; }
      if (rev !== undefined) meta.rev = rev;
      if (own(m, 'gen') !== undefined) { const v = readText(c, own(m, 'gen'), 'meta.gen', 1, 32); if (v !== undefined) meta.gen = v; }
      if (own(m, 'kit') !== undefined) {
        const v = own(m, 'kit');
        if (typeof v !== 'string' || !KIT.test(v)) c.err('meta.kit', 'must be 8 lower-case hexadecimal digits'); else meta.kit = v;
      }
      put('meta', Object.freeze(meta));
    }
  }
  return out as unknown as HudManifest;
}

// ---------------------------------------------------------------------------------------------------------------- derived helpers
const lin = (x: number) => { const s = x / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export function hexToRgb(hex: string): readonly [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
/** WCAG contrast ratio of two `#rrggbb` colours, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const x = relativeLuminance(a), y = relativeLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const mix = (a: string, b: string, t: number): string => {
  const p = hexToRgb(a), q = hexToRgb(b);
  return `#${[0, 1, 2].map(i => Math.round(p[i]! + (q[i]! - p[i]!) * t).toString(16).padStart(2, '0')).join('')}`;
};
/** All nine palette keys: `shade` (ink lifted 8 percent toward paper) and `hi` (paper lifted 60 percent toward white) when the manifest omits them. */
export function resolvePalette(p: HudPalette): Readonly<Record<HudPaletteKey, string>> {
  return Object.freeze({ ink: p.ink, paper: p.paper, shade: p.shade ?? mix(p.ink, p.paper, 0.08), hi: p.hi ?? mix(p.paper, '#ffffff', 0.6), a1: p.a1, a2: p.a2, ok: p.ok, warn: p.warn, bad: p.bad });
}
export function isAuthoritative(layer: HudInstrument): boolean {
  const p = layer as unknown as Rec;
  if (layer.k === 'timer') return true;
  if (layer.k === 'counter') return p.mode === 'interval';
  if (layer.k === 'bar') return (layer.beh ?? []).some(b => b === 'ghost' || b === 'damageFlicker' || b === 'dangerPulse');
  return false;
}
/** Lower-case words of a string (letters and digits), the normal form for deny-list n-grams. */
export function hudWords(text: string): string[] { return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }
/** Every 1..3 word n-gram of a string in normal form (`word word word`). */
export function hudNgrams(text: string): string[] {
  const w = hudWords(text), out: string[] = [];
  for (let n = 1; n <= 3; n++) for (let i = 0; i + n <= w.length; i++) out.push(w.slice(i, i + n).join(' '));
  return out;
}
/** Name-like strings of a valid manifest: what the deny-list hook and the generator's audit scan. */
export function hudScannedStrings(m: HudManifest): string[] {
  const out: string[] = [m.id, m.title, m.pack, ...(m.tags ?? [])];
  if (m.reference?.platform) out.push(m.reference.platform);
  if (m.reference?.genre) out.push(m.reference.genre);
  out.push(...Object.keys(m.events ?? {}), ...Object.keys(m.intervals ?? {}));
  if (m.meta?.gen) out.push(m.meta.gen);
  for (const layer of m.layers) {
    const p = layer as unknown as Rec;
    out.push(layer.id);
    const info = layer.v !== undefined ? parseHudSignal(signalSource(layer.v)) : null;
    if (info?.group === 'iv' && !Object.hasOwn(m.intervals ?? {}, info.id!)) out.push(info.id!);  // a bound but undeclared interval id is a name too
    for (const [name, s] of Object.entries((KIND_SPECS[layer.k] as KindSpec).req).concat(Object.entries((KIND_SPECS[layer.k] as KindSpec).opt))) {
      const v = p[name];
      if (v === undefined) continue;
      if (s.t === 'text') out.push(v as string);
      else if (s.t === 'lines') out.push(...(v as readonly string[]));
      else if (s.t === 'cues') for (const cue of v as readonly HudCue[]) out.push(cue.text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- cost model
export interface HudCost { readonly draws: number; readonly segments: number; readonly texts: number; readonly gradients: number; readonly overdraw: number }
const GLYPH = 12;
const PANEL_SEGMENTS: Readonly<Record<string, number>> = { bevel: 12, notch: 16, rail: 12, brick: 60, steel: 30, crt: 20, flat: 4, bracket: 16 };
const BED_SEGMENTS: Readonly<Record<string, number>> = { void: 2, gradient: 4, starfield: 96, grid: 60, horizon: 60, city: 80, waves: 60, noise: 120, circuit: 80, tunnel: 60 };
/** Upper-bound op-count model, version 1: an estimate for the lint, not a measurement. Pixel text is batched rectangles; display text is a text call. */
export function estimateHudCost(m: HudManifest): HudCost {
  let draws = 0, segments = 0, texts = 0, gradients = 0, overdraw = 0;
  const { w: W, h: H } = m.canvas, pixel = m.canvas.style === 'pixel';
  for (const layer of m.layers) {
    const p = layer as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const area = layer.r[2] * layer.r[3];
    let d = 4, s = 0, t = 0, g = 0, over = 1.5;
    const glyphs = (chars: number, font: string | undefined) => { if (font === 'display' || font === 'mono') t += 1; else s += chars * GLYPH; };
    switch (layer.k) {
      case 'panel': s = (PANEL_SEGMENTS[p.style] ?? 30) + (p.cut ?? 0) * 2; d = 4 + (p.cut ? 2 : 0); over = 1; break;
      case 'viewport': s = BED_SEGMENTS[p.bed] ?? 60; d = 6; g = p.bed === 'gradient' || p.bed === 'horizon' || p.bed === 'tunnel' ? 1 : 0; over = 1.5; break;
      case 'label': glyphs(p.text.length, p.font); d = 1; over = 1; break;
      case 'bar': s = (p.segs ? p.segs * 2 : 4) + 8; d = 4 + (p.trail ? 2 : 0); break;
      case 'pips': s = p.n * 10; d = 3; break;
      case 'matrix': s = Math.ceil(p.cols * p.rows * 1.5) + 8; d = 3; break;
      case 'counter': glyphs(p.digits, p.font); s += 8; d = 3; break;
      case 'timer': glyphs(8, p.font); s += 8; d = 3; break;
      case 'portrait': s = 160; d = 8; break;
      case 'dial': s = 60 + (p.ticks ?? 0) * 2; d = 8; g = p.style === 'orb' ? 1 : 0; break;
      case 'radar': s = 60 + (p.rings ?? 0) * 8 + (p.blips ?? 8) * 3; d = 8; break;
      case 'reticle': s = 48 + (p.ticks ?? 0) * 4; d = 6; break;
      case 'slots': s = p.n * 12; d = 4; break;
      case 'spectrum': s = p.bars * Math.max(1, p.seg ?? 1) * (p.hold ? 2 : 1) + 8; d = 4; break;
      case 'scope': s = 140 + (p.status ? p.status.length * GLYPH * 8 : 0); d = 4; break;
      case 'terminal': {
        const chars = (p.lines as string[]).reduce((n, line) => n + line.length, 0);
        if (pixel) s = Math.min(chars, Math.max(1, Math.floor((layer.r[2] * W) / 6)) * Math.max(1, Math.floor((layer.r[3] * H) / 8))) * GLYPH + 12;
        else t = (p.lines as string[]).length;
        d = 3; break;
      }
      case 'rain': s = p.cols * 10; d = 3; break;
      case 'warning': glyphs(p.text.length, 'pixel'); s += 40; d = 5; break;
      case 'combo': glyphs(p.text.length, 'pixel'); s += 24; d = 4; break;
      case 'banner': {
        const longest = Math.max(...(p.cues as HudCue[]).map(cue => cue.text.length));
        s = Math.ceil(longest * GLYPH * 1.5) + 24; d = 4; break;
      }
      case 'fx':
        s = p.fx === 'scanlines' ? Math.ceil(H / 2) : p.fx === 'grain' ? 200 : 0;
        d = p.fx === 'shake' ? 0 : 2; g = p.fx === 'vignette' || p.fx === 'glow' ? 1 : 0; over = p.fx === 'scanlines' ? 0.5 : 1; break;
    }
    draws += d; segments += s; texts += t; gradients += g; overdraw += Math.min(1, area) * over;
  }
  return Object.freeze({ draws, segments, texts, gradients, overdraw });
}

// ---------------------------------------------------------------------------------------------------------------- attention lint
interface Reserve { readonly start: number; readonly end: number; readonly cost: number }
/** Seconds of a time reference on a reference clock: 4/4 at `bpm`, scene length `freeBars` bars. Static lint only; the runtime resolves references through the real clock. */
export function referenceRefSeconds(ref: string, freeBars: number, bpm = 120): number {
  const bar = 240 / bpm, length = freeBars * bar, p = parseTimeRef(ref)!;
  const base = p.anchor === 's' ? 0 : p.anchor === 'e' ? length : p.frac * length;
  return base + (p.unit === 'b' ? p.offset * bar : p.offset);
}
/** Cue-scheduled events reserve attention for their window (section 5.4). */
function reservations(m: HudManifest, bpm: number): { reserves: Reserve[]; length: number } {
  const bar = 240 / bpm, freeBars = m.timing?.freeBars ?? HUD_DEFAULTS.freeBars, length = freeBars * bar;
  const when = (ref: string): number => referenceRefSeconds(ref, freeBars, bpm);
  const reserves: Reserve[] = [];
  for (const layer of m.layers) {
    const p = layer as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (layer.k === 'banner') for (const cue of p.cues as HudCue[]) { const start = when(cue.at); reserves.push({ start, end: start + (cue.hold ?? HUD_DEFAULTS.cueHold), cost: HUD_ATTENTION_COST.banner }); }
    else if (layer.k === 'warning' && p.when) reserves.push({ start: when(p.when), end: p.until ? when(p.until) : length, cost: HUD_ATTENTION_COST.warning });
    else if (layer.k === 'reticle' && (layer.beh ?? []).includes('lock')) {
      const every = (p.lockEvery ?? 2) * bar, hold = p.lockHold ?? 1;
      for (let t = 0; t < length - 1e-9; t += every) reserves.push({ start: t, end: t + hold, cost: HUD_ATTENTION_COST.lock });
    }
  }
  return { reserves, length };
}
/** Peak simultaneous attention reserved by scheduled events at a reference tempo, and when it occurs (seconds). */
export function peakAttention(m: HudManifest, bpm = 120): { peak: number; at: number } {
  const edges: [number, number][] = [];
  for (const r of reservations(m, bpm).reserves) if (r.end > r.start) edges.push([r.start, r.cost], [r.end, -r.cost]);
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let sum = 0, peak = 0, when = 0;
  for (const [t, d] of edges) { sum += d; if (sum > peak + 1e-12) { peak = sum; when = t; } }
  return { peak, at: when };
}

// ---------------------------------------------------------------------------------------------------------------- lint
function lint(c: Ctx, m: HudManifest, options: HudLintOptions): void {
  const seen = new Set<string>();
  m.layers.forEach((layer, i) => {
    const path = at('layers', i);
    if (seen.has(layer.id)) c.err(at(path, 'id'), 'duplicate instrument id'); else seen.add(layer.id);
    const p = layer as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (layer.v !== undefined) {
      const src = signalSource(layer.v), info = parseHudSignal(src)!;
      if (info.group === 'ev' && !Object.hasOwn(m.events ?? {}, info.id!)) c.err(at(path, 'v'), `event set ${info.id} is not declared in events`);
      if (info.group === 'iv' && !Object.hasOwn(m.intervals ?? {}, info.id!)) c.warn(at(path, 'v'), 'the interval this binding names is not declared in intervals: it reads only from a saved setup, and its fallback applies otherwise');
      if (info.group === 'audio' && isAuthoritative(layer)) c.err(at(path, 'v'), 'an authoritative value (timer, interval counter, health bar) must not bind an audio signal; audio only decorates');
    }
    switch (layer.k) {
      case 'matrix': if (p.cols * p.rows > 256) c.err(path, 'a matrix may have at most 256 cells'); break;
      case 'fx':
        if (p.fx === 'flash' && p.amount > 0.25) c.err(at(path, 'amount'), 'a flash effect is limited to an amount of 0.25 (flash safety)');
        if ((p.fx === 'flash' || p.fx === 'shake') && layer.v !== undefined) c.err(at(path, 'v'), 'flash and shake are rate-limited by the engine and take no binding');
        break;
      case 'warning': if (p.until && !p.when) c.err(at(path, 'until'), 'until needs when'); break;
    }
    const relevant = BEHAVIOURS_FOR[layer.k];
    for (const b of layer.beh ?? []) if (!relevant.includes(b) && b !== 'pulse' && b !== 'blink') c.warn(at(path, 'beh'), `behaviour ${b} has no effect on kind ${layer.k}`);
  });
  const freeBars = m.timing?.freeBars ?? HUD_DEFAULTS.freeBars, length = freeBars * 2, clampLength = (x: number) => Math.min(length, Math.max(0, x));
  for (const [id, e] of Object.entries(m.events ?? {})) {
    if (!(clampLength(e.to ? referenceRefSeconds(e.to, freeBars) : length) > clampLength(e.from ? referenceRefSeconds(e.from, freeBars) : 0))) c.err(at('events', id), 'the event window is empty at the reference tempo');
  }
  for (const [id, d] of Object.entries(m.intervals ?? {})) {
    if (!(clampLength(referenceRefSeconds(d.to, freeBars)) > clampLength(referenceRefSeconds(d.from, freeBars)))) c.err(at('intervals', id), 'the interval is empty at the reference tempo');
  }
  if (contrastRatio(m.palette.paper, m.palette.ink) < 4.5) c.err('palette', 'paper on ink needs a contrast ratio of at least 4.5');
  const cost = estimateHudCost(m);
  for (const [key, hard] of Object.entries(HUD_BUDGET.hard) as [keyof HudCost, number][]) {
    if (cost[key] > hard) c.err('layers', `estimated ${key} ${Math.round(cost[key])} exceed the hard budget of ${hard}`);
    else if (cost[key] > HUD_BUDGET.soft[key]) c.warn('layers', `estimated ${key} ${Math.round(cost[key])} exceed the soft budget of ${HUD_BUDGET.soft[key]}`);
  }
  const capacity = m.attention?.capacity ?? HUD_DEFAULTS.attentionCapacity, nominal = peakAttention(m, 120);
  if (nominal.peak > capacity + 1e-9) c.err('layers', `scheduled events reserve ${nominal.peak} attention at ${nominal.at.toFixed(1)} s but capacity is ${capacity}`);
  else if (peakAttention(m, 180).peak > capacity + 1e-9) c.warn('layers', `scheduled events overlap beyond attention capacity ${capacity} at 180 BPM`);
  const bytes = hudManifestBytes(m);
  if (bytes > HUD_LIMITS.bytes) c.err('', `canonical text is ${bytes} bytes; the limit is ${HUD_LIMITS.bytes}`);
  if (options.deny) {
    const denied = options.deny;
    outer: for (const s of hudScannedStrings(m)) for (const g of hudNgrams(s)) if (denied(g)) { c.err('', 'contains a blocked name; use neutral wording'); break outer; }
  }
}
const ANY: readonly HudBehaviour[] = [];
const BEHAVIOURS_FOR: Readonly<Record<HudKind, readonly HudBehaviour[]>> = {
  panel: ANY, viewport: ANY, label: ANY, bar: ['ghost', 'damageFlicker', 'dangerPulse', 'refill', 'capFlash', 'peakHold'], pips: ['refill', 'select'], matrix: ['chase', 'levels', 'vote', 'select', 'peakHold'],
  counter: ['tick'], timer: ['urgent', 'zeroHold'], portrait: ['look', 'hurt', 'grin', 'dead'], dial: ['sweep', 'peakHold'], radar: ['sweep', 'blip'], reticle: ['drift', 'lock'],
  slots: ['select', 'chase'], spectrum: ['peakHold', 'levels'], scope: ['trace', 'ecgBeat'], terminal: ['type', 'scroll', 'burst'], rain: ['fall', 'burst', 'scroll'],
  warning: ['stripes'], combo: ['pop', 'slide', 'window'], banner: ['pop', 'slide', 'flash', 'type', 'window'], fx: ['scanlines', 'vignette', 'grain', 'flash', 'shake', 'glow'],
};

// ---------------------------------------------------------------------------------------------------------------- public parse
/** Validate `value` (already JSON-parsed, untrusted). Never throws. `manifest` is a deep-frozen canonical-order, canonical-number copy when there is no error. */
export function checkHudManifest(value: unknown, options: HudLintOptions = {}): HudCheckResult {
  const c = new Ctx();
  try {
    const read = readRoot(c, value);
    if (read && c.errors === 0) lint(c, read, options);
    return { manifest: read && c.errors === 0 ? deepFreeze(read) : null, issues: c.issues };
  } catch {
    // Only a hostile object (a throwing getter or proxy trap) or a throwing deny hook lands here: refused, never thrown, and never accepted.
    c.err('', 'could not be read');
    return { manifest: null, issues: c.issues };
  }
}
/** Freezes every level. It descends even into an object that is already frozen (the readers freeze layers early, before their signal objects and cues exist). */
function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null) { for (const x of Object.values(v)) deepFreeze(x); Object.freeze(v); }
  return v;
}
/** Strict parse: throws `HudManifestError` (with every issue) unless the manifest is valid. */
export function parseHudManifest(value: unknown, options: HudLintOptions = {}): HudManifest {
  const r = checkHudManifest(value, options);
  if (!r.manifest) throw new HudManifestError(r.issues);
  return r.manifest;
}

// ---------------------------------------------------------------------------------------------------------------- canonical serializer
class O { constructor(readonly e: [string, unknown][]) {} }
const numText = (n: number): string => String(canon(n));
function flat(n: unknown): string {
  if (typeof n === 'number') return numText(n);
  if (typeof n === 'string' || typeof n === 'boolean') return JSON.stringify(n);
  if (Array.isArray(n)) return `[${n.map(flat).join(', ')}]`;
  if (n instanceof O) return n.e.length ? `{ ${n.e.map(([k, v]) => `${JSON.stringify(k)}: ${flat(v)}`).join(', ')} }` : '{}';
  throw new Error('Unserialisable HUD value');
}
const WIDTH = 100;
function emit(n: unknown, indent: number, prefix: number, forceBreak = false): string {
  const one = flat(n);
  if (!forceBreak && (!(n instanceof O || Array.isArray(n)) || indent + prefix + one.length + 1 <= WIDTH)) return one;
  const pad = ' '.repeat(indent + 2), close = ' '.repeat(indent);
  if (Array.isArray(n)) return n.length ? `[\n${n.map(x => pad + emit(x, indent + 2, 0)).join(',\n')}\n${close}]` : '[]';
  const o = n as O;
  return o.e.length ? `{\n${o.e.map(([k, v]) => `${pad}${JSON.stringify(k)}: ${emit(v, indent + 2, JSON.stringify(k).length + 2)}`).join(',\n')}\n${close}}` : '{}';
}
const obj = (pairs: [string, unknown][]): O => new O(pairs.filter(([, v]) => v !== undefined));
const pick = (src: object | undefined, keys: readonly string[]): O => obj(keys.map(k => [k, src ? (src as Rec)[k] : undefined]));
const signalNode = (s: HudSignalObject): O => obj(SIGNAL_KEYS.map(k => { const x = (s as unknown as Rec)[k]; return [k, Array.isArray(x) ? [...x] : x] as [string, unknown]; }));
function layerNode(layer: HudInstrument): O {
  const p = layer as unknown as Rec, spec: KindSpec = KIND_SPECS[layer.k];
  const pairs: [string, unknown][] = [['k', layer.k], ['id', layer.id], ['r', [...layer.r]], ['z', layer.z], ['c', layer.c], ['c2', layer.c2]];
  for (const name of [...Object.keys(spec.req), ...Object.keys(spec.opt)]) {
    let v = p[name];
    if (v === undefined) continue;
    if (name === 'cues') v = (v as HudCue[]).map(cue => pick(cue, ['at', 'text', 'style', 'hold']));
    else if (Array.isArray(v)) v = [...v];
    pairs.push([name, v]);
  }
  if (layer.v !== undefined) pairs.push(['v', typeof layer.v === 'string' ? layer.v : signalNode(layer.v)]);
  if (layer.beh !== undefined) pairs.push(['beh', [...layer.beh]]);
  return obj(pairs);
}
/** Canonical text: fixed key order, 2-space indent, objects and arrays on one line when they fit in 100 columns, numbers rounded to 6 places,
 * LF, trailing newline. The catalog SHA-256 of these bytes is the scene identity. The input must already be a valid manifest. */
export function serializeHudManifest(m: HudManifest): string {
  const sortedMap = <T>(map: Readonly<Record<string, T>> | undefined, make: (v: T) => unknown): O | undefined =>
    map ? new O(Object.keys(map).sort().map(k => [k, make(map[k] as T)] as [string, unknown])) : undefined;
  const root = obj([
    ['format', m.format], ['version', m.version], ['id', m.id], ['title', m.title], ['pack', m.pack], ['family', m.family], ['era', m.era],
    ['reference', m.reference ? pick(m.reference, ['platform', 'year', 'genre']) : undefined],
    ['tags', m.tags ? [...m.tags] : undefined],
    ['canvas', obj([['w', m.canvas.w], ['h', m.canvas.h], ['style', m.canvas.style], ['par', m.canvas.par ? [...m.canvas.par] : undefined]])],
    ['palette', pick(m.palette, HUD_PALETTE_KEYS)],
    ['timing', m.timing ? pick(m.timing, ['freeBars']) : undefined],
    ['events', sortedMap(m.events, e => pick(e, ['on', 'n', 'seed', 'bias', 'gap', 'from', 'to']))],
    ['intervals', sortedMap(m.intervals, i => pick(i, ['from', 'to']))],
    ['attention', m.attention ? pick(m.attention, ['capacity', 'refill']) : undefined],
    ['layers', m.layers.map(layerNode)],
    ['meta', m.meta ? pick(m.meta, ['tier', 'origin', 'rev', 'gen', 'kit']) : undefined],
  ]);
  return `${emit(root, 0, 0, true)}\n`;
}
/** Byte length of the canonical text (ASCII plus the two-byte middle dot). */
export function hudManifestBytes(m: HudManifest): number {
  const text = serializeHudManifest(m);
  let bytes = text.length;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) bytes++;
  return bytes;
}

// ---------------------------------------------------------------------------------------------------------------- JSON Schema
const PAT_ASCII = '^[\\x20-\\x7e]+$';
function specSchema(s: Spec): object {
  switch (s.t) {
    case 'int': return { type: 'integer', minimum: s.min, maximum: s.max };
    case 'num': return { type: 'number', minimum: s.min, maximum: s.max };
    case 'bool': return { type: 'boolean' };
    case 'enum': return { enum: [...s.values] };
    case 'text': return { type: 'string', minLength: s.min, maxLength: s.max, pattern: PAT_ASCII };
    case 'ref': return { $ref: '#/$defs/timeRef' };
    case 'ease': return { type: 'string', pattern: EASE_RE.source };
    case 'lines': return { type: 'array', minItems: 1, maxItems: s.maxItems, items: { type: 'string', minLength: 1, maxLength: s.max, pattern: PAT_ASCII } };
    case 'cues': return { type: 'array', minItems: 1, maxItems: HUD_LIMITS.cues, items: { $ref: '#/$defs/cue' } };
  }
}
/** JSON Schema (draft 2020-12) generated from the same tables as the validator. Cross-field lint (unique ids, signal resolution, contrast,
 * cost, attention, authority) is beyond JSON Schema; anything the schema rejects the parser rejects too. */
export function hudJsonSchema(): object {
  const unit = { type: 'number', minimum: 0, maximum: 1 };
  const signalNames = [
    ...HUD_SIGNAL_FIELDS.interval.map(f => `interval\\.${f}`), ...HUD_SIGNAL_FIELDS.clock.map(f => `clock\\.${f}`), ...HUD_SIGNAL_FIELDS.track.map(f => `track\\.${f}`),
    `iv\\.[a-z0-9_-]{1,32}\\.(?:${HUD_SIGNAL_FIELDS.iv.join('|')})`, `ev\\.[a-z0-9][a-z0-9-]{1,47}\\.(?:${HUD_SIGNAL_FIELDS.ev.join('|')})`,
    'seed\\.[0-7]', 'const\\.-?[0-9]{1,9}(?:\\.[0-9]{1,6})?',
    ...HUD_SIGNAL_FIELDS.audio.map(f => `audio\\.${f}`),
    `audio\\.(?:band|bandL|bandR|panBand)\\.(?:${HUD_BANDS.join('|')})`,
    `audio\\.onset\\.(?:${HUD_GROUPS.join('|')})\\.(?:${HUD_SIGNAL_FIELDS.audioOnset.join('|')})`,
    'audio\\.beat\\.(?:latched|level)', 'audio\\.contour\\.(?:fast|slow)', 'audio\\.legacy\\.(?:low|mid|high|level)',
  ];
  const pair = (min: number, max: number) => ({ type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: min, maximum: max } });
  const baseProps = { id: { $ref: '#/$defs/layerId' }, r: { $ref: '#/$defs/rect' }, z: { $ref: '#/$defs/zIndex' }, c: { $ref: '#/$defs/pal' }, c2: { $ref: '#/$defs/pal' }, beh: { $ref: '#/$defs/behaviours' } };
  const defs: Record<string, object> = {
    slug: { type: 'string', pattern: SLUG.source },
    layerId: { type: 'string', pattern: LAYER_ID.source },
    zIndex: { type: 'integer', minimum: 0, maximum: 99 },
    behaviours: { type: 'array', maxItems: HUD_LIMITS.behaviours, uniqueItems: true, items: { enum: [...HUD_BEHAVIOURS] } },
    hex: { type: 'string', pattern: HEX.source },
    pal: { enum: [...HUD_PALETTE_KEYS] },
    unit,
    rect: { type: 'array', minItems: 4, maxItems: 4, prefixItems: [unit, unit, { type: 'number', exclusiveMinimum: 0, maximum: 1 }, { type: 'number', exclusiveMinimum: 0, maximum: 1 }] },
    timeRef: { type: 'string', pattern: TIME_REF.source },
    signalName: { type: 'string', pattern: `^(?:${signalNames.join('|')})$` },
    signalRef: {
      oneOf: [{ $ref: '#/$defs/signalName' }, {
        type: 'object', additionalProperties: false, required: ['src'],
        properties: { src: { $ref: '#/$defs/signalName' }, in: pair(-1e9, 1e9), out: pair(-1e9, 1e9), curve: { type: 'string', pattern: CURVE.source },
          atk: { type: 'number', minimum: 0, maximum: 5000 }, rel: { type: 'number', minimum: 0, maximum: 5000 }, gate: unit, steps: { type: 'integer', minimum: 1, maximum: 256 }, fb: { type: 'number', minimum: -1e9, maximum: 1e9 } },
      }],
    },
    event: {
      type: 'object', additionalProperties: false, required: ['on', 'n', 'seed'],
      properties: { on: { enum: [...HUD_EVENT_UNITS] }, n: { type: 'integer', minimum: 1, maximum: 64 }, seed: { type: 'integer', minimum: 0, maximum: 4294967295 },
        bias: { type: 'number', minimum: -1, maximum: 1 }, gap: { type: 'integer', minimum: 0, maximum: 16 }, from: { $ref: '#/$defs/timeRef' }, to: { $ref: '#/$defs/timeRef' } },
    },
    interval: { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: { from: { $ref: '#/$defs/timeRef' }, to: { $ref: '#/$defs/timeRef' } } },
    cue: {
      type: 'object', additionalProperties: false, required: ['at', 'text'],
      properties: { at: { $ref: '#/$defs/timeRef' }, text: { type: 'string', minLength: 1, maxLength: 24, pattern: PAT_ASCII }, style: { enum: [...HUD_CUE_STYLES] }, hold: { type: 'number', minimum: 0.1, maximum: 8 } },
    },
    instrument: { oneOf: HUD_KINDS.map(k => ({ $ref: `#/$defs/k-${k}` })) },
  };
  for (const kind of HUD_KINDS) {
    const spec: KindSpec = KIND_SPECS[kind];
    const properties: Record<string, object> = { k: { const: kind }, ...baseProps };
    if (spec.v) properties.v = { $ref: '#/$defs/signalRef' };
    for (const [name, s] of [...Object.entries(spec.req), ...Object.entries(spec.opt)]) properties[name] = specSchema(s);
    defs[`k-${kind}`] = { type: 'object', additionalProperties: false, required: ['k', 'id', 'r', ...Object.keys(spec.req)], properties };
  }
  const palProps: Record<string, object> = {};
  for (const key of HUD_PALETTE_KEYS) palProps[key] = { $ref: '#/$defs/hex' };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'mpcaaavs-hud-1.schema.json',
    title: 'mpcaaavs-hud manifest v1', type: 'object', additionalProperties: false,
    required: ['format', 'version', 'id', 'title', 'pack', 'family', 'era', 'canvas', 'palette', 'layers'],
    properties: {
      format: { const: HUD_FORMAT }, version: { const: HUD_VERSION }, id: { $ref: '#/$defs/slug' },
      title: { type: 'string', minLength: 1, maxLength: HUD_LIMITS.chars, pattern: '^[\\x20-\\x7e\\u00b7]+$' },
      pack: { $ref: '#/$defs/slug' }, family: { enum: [...HUD_FAMILIES] }, era: { enum: [...HUD_ERAS] },
      reference: { type: 'object', additionalProperties: false, properties: { platform: { $ref: '#/$defs/slug' }, year: { type: 'integer', minimum: 1900, maximum: 2100 }, genre: { $ref: '#/$defs/slug' } } },
      tags: { type: 'array', maxItems: HUD_LIMITS.tags, uniqueItems: true, items: { type: 'string', pattern: TAG.source } },
      canvas: {
        type: 'object', additionalProperties: false, required: ['w', 'h', 'style'],
        properties: { w: { type: 'integer', minimum: HUD_LIMITS.canvasMin, maximum: HUD_LIMITS.canvasMax }, h: { type: 'integer', minimum: HUD_LIMITS.canvasMin, maximum: HUD_LIMITS.canvasMax },
          style: { enum: ['pixel', 'vector'] }, par: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'integer', minimum: 1, maximum: 16 } } },
      },
      palette: { type: 'object', additionalProperties: false, required: [...HUD_PALETTE_REQUIRED], properties: palProps },
      timing: { type: 'object', additionalProperties: false, properties: { freeBars: { type: 'integer', minimum: 1, maximum: HUD_LIMITS.freeBars } } },
      events: { type: 'object', maxProperties: HUD_LIMITS.events, propertyNames: { $ref: '#/$defs/slug' }, additionalProperties: { $ref: '#/$defs/event' } },
      intervals: { type: 'object', maxProperties: HUD_LIMITS.intervals, propertyNames: { type: 'string', pattern: INTERVAL_ID.source }, additionalProperties: { $ref: '#/$defs/interval' } },
      attention: { type: 'object', additionalProperties: false, properties: { capacity: { type: 'number', minimum: 1, maximum: 8 }, refill: { type: 'number', minimum: 0.5, maximum: 6 } } },
      layers: { type: 'array', minItems: 1, maxItems: HUD_LIMITS.layers, items: { $ref: '#/$defs/instrument' } },
      meta: {
        type: 'object', additionalProperties: false, required: ['tier', 'rev'],
        properties: { tier: { enum: [...HUD_TIERS] }, origin: { enum: [...HUD_ORIGINS] }, rev: { type: 'integer', minimum: 1, maximum: 1000000 }, gen: { type: 'string', minLength: 1, maxLength: 32, pattern: PAT_ASCII }, kit: { type: 'string', pattern: KIT.source } },
      },
    },
    $defs: defs,
  };
}

// ---------------------------------------------------------------------------------------------------------------- deny-list recipe
/** Shared recipe for the salted deny-list so the generator and CI compute identical digests: `digest(salt + '\0' + ngram)` in lower-case hexadecimal.
 * `digest` is any SHA-256 (node:crypto in tools). Returns the deny hook for `HudLintOptions`. */
export function hudDenyHook(digest: (input: string) => string, salt: string, hashes: ReadonlySet<string>): (ngram: string) => boolean {
  return ngram => hashes.has(digest(`${salt}\0${ngram}`));
}
export function hudDenyEntry(digest: (input: string) => string, salt: string, ngram: string): string {
  return digest(`${salt}\0${ngram}`);
}
