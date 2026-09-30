/**
 * Deterministic, structure-based style classifier for historical AVS presets
 * (docs/design/PRESET-TAXONOMY-AND-JEV.md 4 and docs/design/CONTRACT.md 2.3.10, C-35, C-38).
 *
 * Pure: no DOM, no fetch, no clock, no randomness. `compositionOf` reduces a parsed preset to plain JSON counters (the only thing
 * that may ever leave the machine, and only through the owner-run Jev path of tools/classify-presets.mjs); `classifyComposition`
 * scores those counters against the 18-category TAXONOMY imported from preset-categories.ts. Same composition, same answer on any
 * platform and in any component order: scores are summed in sorted-key order, use a literal count-factor table, and are rounded
 * to 1e-6 before any comparison, and ties resolve by TAXONOMY order.
 *
 * Status: CPU-checked by tools/check-preset-taxonomy.mjs on synthetic presets. Category quality against real presets is unvalidated
 * until an owner-labelled gold set exists (JEV 9); ratings remain the owner's quality signal.
 */
import { TAXONOMY, TAXONOMY_VERSION } from './preset-categories.ts';
import { AVS_COLOR_MAP_APE_ID } from './effects/color-map.ts';
import { AVS_CONVOLUTION_APE_ID } from './effects/convolution.ts';
import { AVS_MULTIFILTER_APE_ID } from './effects/multifilter.ts';
import { AVS_CHANNEL_SHIFT_APE_ID, AVS_COLOR_REDUCTION_APE_ID, AVS_MULTIPLIER_APE_ID } from './effects/named-apes.ts';
import { AVS_TEXER_APE_ID, AVS_TEXER_II_APE_ID } from './effects/texer.ts';
import { decodeAvsMovement } from './effects/movement.ts';
import { decodeAvsSuperScope } from './effects/superscope.ts';
import type { AvsComponent, AvsPresetAst } from './types.ts';

export { TAXONOMY, TAXONOMY_VERSION };

/** The 18 ids of the TAXONOMY table (order and membership are pinned by the check against preset-categories.ts). */
export type CategoryId =
  | 'scope-classic' | 'scope-geometry' | 'rings-stars'
  | 'particles' | 'starfield' | 'perspective-3d'
  | 'tunnel-zoom' | 'spin-rotate' | 'kaleido-mirror'
  | 'water-ripple' | 'bump-relief' | 'color-grade' | 'glitch-digital'
  | 'beat-flash' | 'text-image'
  | 'multi-scene' | 'minimal' | 'mixed';

/** What belongs in each category (JEV 4.2); also the `what` text of the optional Jev Choice question. */
export const TAXONOMY_DEFINITIONS: Readonly<Record<CategoryId, string>> = Object.freeze({
  'scope-classic': 'Audio line or spectrum drawn as a scope: Simple, Timescope, line-mode SuperScope with little else.',
  'scope-geometry': 'Three or more SuperScopes, or scripted shapes, forming figures rather than a plain wave.',
  'rings-stars': 'Ring, Oscilloscope Star, Rotating Stars, Bass Spin.',
  'particles': 'Moving Particle, Dot Grid, Dot Fountain, dot-mode SuperScope, Texer sprites.',
  'starfield': 'Starfield (built-in or APE) as the identity.',
  'perspective-3d': 'Dot Plane, a SuperScope that assigns z, Texer II with depth, 3D or triangle APEs.',
  'tunnel-zoom': 'Movement or Dynamic Movement engines with decay (Fade Out, Blur), Blitter Feedback, delay and buffer echo.',
  'spin-rotate': 'Roto Blitter, Bass Spin dominated.',
  'kaleido-mirror': 'Mirror, or movement built-in 23 or kaleidoscope-shaped scripts.',
  'water-ripple': 'Water, Water Bump.',
  'bump-relief': 'Bump, Convolution filters.',
  'color-grade': 'Color Map, Dynamic Color Modifier, Unique Tone, Color Fade, Channel Shift.',
  'glitch-digital': 'Interferences, Grain, Mosaic, Scatter, Interleave, Color Reduction, MULTIFILTER.',
  'beat-flash': 'OnBeat Clear, Custom BPM, beat-render lists, Invert flashes.',
  'text-image': 'Text, Picture (I/II), AVI, SVP.',
  'multi-scene': '45 or more components or 8 or more lists and no decisive style.',
  'minimal': 'Three or fewer components: test, demo and component samples.',
  'mixed': 'Nothing scored clearly.',
});

/**
 * The 46 built-in renderer names by id. This is a deliberate copy of `BUILTIN_RENDERER_NAMES` in editor-model.ts (a private,
 * frozen file); tools/check-preset-taxonomy.mjs reads that file as text and fails when the two differ.
 */
export const BUILTIN_NAMES: readonly string[] = Object.freeze([
  'Simple', 'Dot Plane', 'Oscilloscope Star', 'Fade Out', 'Blitter Feedback',
  'OnBeat Clear', 'Blur', 'Bass Spin', 'Moving Particle', 'Roto Blitter',
  'SVP Loader', 'Color Fade', 'Color Clip', 'Rotating Stars', 'Ring',
  'Movement', 'Scatter', 'Dot Grid', 'Buffer Save', 'Dot Fountain', 'Water',
  'Comment', 'Brightness', 'Interleave', 'Grain', 'Clear Screen', 'Mirror',
  'Starfield', 'Text', 'Bump', 'Mosaic', 'Water Bump', 'AVI', 'Custom BPM',
  'Picture', 'Dynamic Distance Modifier', 'SuperScope', 'Invert', 'Unique Tone',
  'Timescope', 'Set Render Mode', 'Interferences', 'Dynamic Shift',
  'Dynamic Movement', 'Fast Brightness', 'Dynamic Color Modifier',
]);

/** APE identities the weight table and the check know about. Nine come from exported constants, the rest are corpus-observed strings. */
export const KNOWN_APES: readonly string[] = Object.freeze([
  AVS_COLOR_MAP_APE_ID, AVS_CONVOLUTION_APE_ID, AVS_MULTIFILTER_APE_ID,
  AVS_CHANNEL_SHIFT_APE_ID, AVS_COLOR_REDUCTION_APE_ID, AVS_MULTIPLIER_APE_ID,
  AVS_TEXER_APE_ID, AVS_TEXER_II_APE_ID,
  'Winamp Starfield v1', 'Winamp 3DAPE v1', 'Render: Triangle', 'Holden04: Video Delay', 'Holden05: Multi Delay',
  'Misc: Buffer blend', 'FunkyFX FyrewurX v1', 'Picture II',
]);

/** Effect key of a built-in id ("b36") or an APE ("ape:Texer"). */
export const builtinKey = (id: number): string => `b${id}`;
export const apeKey = (name: string): string => `ape:${name}`;

const nameKey = new Map(BUILTIN_NAMES.map((name, id) => [name, builtinKey(id)] as const));
const K = (name: string): string => {
  const key = name.startsWith('ape:') ? name : nameKey.get(name);
  if (!key) throw new Error(`Unknown effect name in taxonomy table: ${name}`);
  return key;
};

type Weights = Readonly<Partial<Record<CategoryId, number>>>;
const W = (rows: Readonly<Record<string, Weights>>): ReadonlyMap<string, Weights> =>
  new Map(Object.entries(rows).map(([name, weights]) => [K(name), Object.freeze({ ...weights })] as const));

/**
 * Evidence weights per effect (JEV 4.3 rule 1), added once per effect scaled by `COUNT_FACTOR`. Movement, Dynamic Movement, Blur,
 * Fade Out, Comment, Set Render Mode and Fast Brightness are deliberately absent: they are in 42-62 percent of all presets and would
 * flood every category. They act only through the composite rules in `scoreComposition`. Starting values, to be tuned on the gold set.
 */
export const TAXONOMY_WEIGHTS: ReadonlyMap<string, Weights> = W({
  'Simple': { 'scope-classic': 3 }, 'Timescope': { 'scope-classic': 2 },
  'Ring': { 'rings-stars': 3 }, 'Oscilloscope Star': { 'rings-stars': 3 }, 'Rotating Stars': { 'rings-stars': 3 },
  'Bass Spin': { 'rings-stars': 2.5, 'spin-rotate': 1 },
  'Moving Particle': { 'particles': 2 }, 'Dot Grid': { 'particles': 3 }, 'Dot Fountain': { 'particles': 3 }, 'ape:Texer': { 'particles': 2 },
  'Starfield': { 'starfield': 3.5 }, 'ape:Winamp Starfield v1': { 'starfield': 3.5 },
  'Dot Plane': { 'perspective-3d': 3 }, 'ape:Acko.net: Texer II': { 'perspective-3d': 1.5, 'particles': 1.5 },
  'ape:Winamp 3DAPE v1': { 'perspective-3d': 3 }, 'ape:Render: Triangle': { 'perspective-3d': 2 },
  'Roto Blitter': { 'spin-rotate': 3 }, 'Blitter Feedback': { 'tunnel-zoom': 2.5 },
  'Mirror': { 'kaleido-mirror': 3 },
  'Buffer Save': { 'tunnel-zoom': 0.5 }, 'ape:Holden04: Video Delay': { 'tunnel-zoom': 2.5 },
  'ape:Holden05: Multi Delay': { 'tunnel-zoom': 2.5 }, 'ape:Misc: Buffer blend': { 'tunnel-zoom': 2 },
  'Dynamic Distance Modifier': { 'tunnel-zoom': 1 }, 'Dynamic Shift': { 'tunnel-zoom': 1 },
  'Water': { 'water-ripple': 3 }, 'Water Bump': { 'water-ripple': 3.5, 'bump-relief': 1 },
  'Bump': { 'bump-relief': 3 }, 'ape:Holden03: Convolution Filter': { 'bump-relief': 2 },
  'ape:Color Map': { 'color-grade': 2.5 }, 'Unique Tone': { 'color-grade': 1.5 }, 'Color Fade': { 'color-grade': 1.5 },
  'Dynamic Color Modifier': { 'color-grade': 3 },
  'ape:Channel Shift': { 'color-grade': 1.5, 'glitch-digital': 1 }, 'ape:Color Reduction': { 'glitch-digital': 2 },
  'ape:Multiplier': { 'color-grade': 1 },
  'Interferences': { 'glitch-digital': 3 }, 'Grain': { 'glitch-digital': 3 }, 'Mosaic': { 'glitch-digital': 2 },
  'Scatter': { 'glitch-digital': 2.5 }, 'Interleave': { 'glitch-digital': 1.5 },
  'ape:FunkyFX FyrewurX v1': { 'glitch-digital': 2 }, 'ape:Jheriko : MULTIFILTER': { 'glitch-digital': 1.5 },
  'OnBeat Clear': { 'beat-flash': 3 }, 'Custom BPM': { 'beat-flash': 1.5 }, 'Clear Screen': { 'beat-flash': 0.7 }, 'Invert': { 'beat-flash': 1 },
  'Text': { 'text-image': 3.5 }, 'Picture': { 'text-image': 3 }, 'ape:Picture II': { 'text-image': 3 }, 'AVI': { 'text-image': 3 },
  'SVP Loader': { 'text-image': 2 },
});

/** Every threshold and composite bonus in one table, so a retune is a data change plus a TAXONOMY_VERSION bump. */
export const TAXONOMY_RULES = Object.freeze({
  minimalMaxComponents: 3,
  multiSceneMinComponents: 45,
  multiSceneMinLists: 8,
  /** A style keeps the primary on a large preset only from this score upward. */
  multiSceneStyleScore: 6,
  mixedBelow: 2.0,
  tagMinScore: 2.0,
  tagMinFraction: 0.6,
  maxTags: 2,
  confidenceFull: 6,
  minimalConfidence: 0.9,
  tunnelEngineDecay: 1.6, tunnelBuiltinMovement: 1.2, tunnelMultiDynamic: 0.6,
  kaleidoscope: 3,
  ssLine: 1, ssLineCap: 2, ssDot: 0.8, ssDotCap: 3,
  ssGeometryMin: 3, ssGeometryBase: 1.5, ssGeometryPer: 0.25, ssGeometryCap: 12, ssPolar: 0.8,
  ssZBase: 2, ssZPer: 0.4, ssZCap: 4,
  beatListPer: 0.9, beatListCap: 3,
  busyBounds: [5, 12, 22, 40] as readonly number[],
});

/** `1 + 0.35 * log2(min(count, 8))` as literals, so scores do not depend on the engine's Math.log2. Index = count (1..8). */
export const COUNT_FACTOR: readonly number[] = Object.freeze([0, 1, 1.35, 1.554737, 1.7, 1.812675, 1.904737, 1.982574, 2.05]);

/** Effects that carry no direct weight but drive the composite rules. */
const MOVE = [builtinKey(15), builtinKey(43)] as const;
const DECAY = [builtinKey(3), builtinKey(6)] as const;
const K_DM = builtinKey(43), K_ONBEAT = builtinKey(5), K_BPM = builtinKey(33), K_INVERT = builtinKey(37);

/** Plain-JSON reduction of a parsed preset. This is the only structure ever sent to Jev. */
export interface PresetComposition {
  readonly components: number;
  readonly lists: number;
  readonly maxDepth: number;
  readonly beatLists: number;
  /** Built-in id as "b36", APE as "ape:Texer"; at most 256 distinct keys (overflow is counted under "other"). */
  readonly effects: Readonly<Record<string, number>>;
  readonly detail: {
    readonly ssLines: number; readonly ssDots: number; readonly ssZ: number; readonly ssPolar: number;
    readonly mvBuiltin: number; readonly mvScript: number; readonly mvKaleido: number;
    readonly unsupported: number; readonly decoded: boolean;
  };
  /** Sorted distinct keys of the components the registry cannot run (at most 8). */
  readonly unrunnable: readonly string[];
}

export interface Facets {
  /** Busyness 1-5 from the component count. */
  readonly b: 1 | 2 | 3 | 4 | 5;
  readonly e: 'calm' | 'steady' | 'driving' | 'intense';
  readonly f: 'full' | 'partial';
  readonly beat: 'reactive' | 'flowing';
}

export interface Classification {
  readonly primary: CategoryId;
  readonly tags: readonly CategoryId[];
  /** Confidence 0-1 (JEV 4.3 rule 6). Not accuracy. */
  readonly k: number;
  /** The winning style score before overrides (0 for `minimal` presets with no style evidence). */
  readonly score: number;
  readonly facets: Facets;
}

const MAX_KEYS = 256, MAX_NODES = 2_000_000, MAX_UNRUNNABLE = 8, MAX_CODE = 16_384;
const Z_ASSIGN = /(^|[^a-z_0-9.])z\d*\s*=(?!=)|persp|fov|zoom/;
const POLAR = /atan|sqrt/;
const SCRIPT_POLAR_DIVISION = /\/\s*\$pi|atan/;
const SCRIPT_ANGULAR_MULTIPLIER = /\*\s*[3-9]|\*\s*1\d/;

/**
 * Reduce a parsed preset to counters. `has` is `registry.handler(component) !== undefined`, injected so this module never imports
 * the executor's registry; a throwing `has` counts as unsupported. Traversal is iterative and bounded, so a hostile tree cannot
 * overflow the stack, and the result does not depend on component order.
 */
export function compositionOf(ast: Pick<AvsPresetAst, 'components'>, has: (component: AvsComponent) => boolean): PresetComposition {
  const effects = new Map<string, number>();
  const unrunnable = new Set<string>();
  const d = { ssLines: 0, ssDots: 0, ssZ: 0, ssPolar: 0, mvBuiltin: 0, mvScript: 0, mvKaleido: 0, unsupported: 0, decoded: true };
  let components = 0, lists = 0, maxDepth = 0, beatLists = 0, visited = 0;
  const stack: { c: AvsComponent; depth: number }[] = [];
  for (let i = ast.components.length - 1; i >= 0; i--) stack.push({ c: ast.components[i]!, depth: 0 });
  while (stack.length > 0) {
    const { c, depth } = stack.pop()!;
    if (++visited > MAX_NODES) { d.decoded = false; break; }
    components++;
    if (depth > maxDepth) maxDepth = depth;
    if (c.effectId === -2) {
      lists++;
      if (c.list?.beatRender) beatLists++;
      for (let i = c.children.length - 1; i >= 0; i--) stack.push({ c: c.children[i]!, depth: depth + 1 });
      continue;
    }
    const key = c.apeId !== null ? apeKey(c.apeId) : builtinKey(c.effectId);
    const slot = effects.has(key) || effects.size < MAX_KEYS ? key : 'other';
    effects.set(slot, (effects.get(slot) ?? 0) + 1);
    let runnable = false;
    try { runnable = has(c); } catch { runnable = false; }
    if (!runnable) { d.unsupported++; if (unrunnable.size < MAX_UNRUNNABLE) unrunnable.add(key); }
    if (c.apeId !== null) continue;
    try {
      if (c.effectId === 36) {
        const s = decodeAvsSuperScope(c.payload);
        if (s.lines) d.ssLines++; else d.ssDots++;
        const code = `${s.point}\n${s.frame}\n${s.init}`.slice(0, MAX_CODE).toLowerCase();
        if (Z_ASSIGN.test(code)) d.ssZ++;
        if (POLAR.test(code)) d.ssPolar++;
      } else if (c.effectId === 15) {
        const m = decodeAvsMovement(c.payload);
        if (m.effect === 32_767) {
          d.mvScript++;
          const code = m.expression.slice(0, MAX_CODE).toLowerCase();
          if (SCRIPT_POLAR_DIVISION.test(code) && SCRIPT_ANGULAR_MULTIPLIER.test(code)) d.mvKaleido++;
        } else {
          d.mvBuiltin++;
          if (m.effect === 23) d.mvKaleido++;
        }
      }
    } catch { d.decoded = false; }
  }
  return {
    components, lists, maxDepth, beatLists,
    effects: Object.fromEntries([...effects].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    detail: d,
    unrunnable: [...unrunnable].sort(),
  };
}

const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);

/**
 * A safe copy of any composition-shaped value (for example parsed from JSON): counters become non-negative integers, effect keys
 * must look like "b<int>" or "ape:<name up to 64 chars>" and at most 256 are kept, everything else is dropped. Total for any input.
 */
export function normalizeComposition(input: unknown): PresetComposition {
  const c = (input && typeof input === 'object' ? input : {}) as Partial<Record<keyof PresetComposition, unknown>>;
  const rawEffects = c.effects && typeof c.effects === 'object' ? c.effects as Record<string, unknown> : {};
  const effects: Record<string, number> = {};
  let kept = 0;
  for (const key of Object.keys(rawEffects).sort()) {
    const n = num(rawEffects[key]);
    if (n < 1 || !(/^b-?\d{1,10}$/.test(key) || (key.startsWith('ape:') && key.length <= 68) || key === 'other')) continue;
    if (++kept > MAX_KEYS) break;
    effects[key] = n;
  }
  const d = (c.detail && typeof c.detail === 'object' ? c.detail : {}) as Record<string, unknown>;
  const unrunnable = Array.isArray(c.unrunnable) ? c.unrunnable.filter((x): x is string => typeof x === 'string' && x.length <= 68).slice(0, MAX_UNRUNNABLE) : [];
  return {
    components: num(c.components), lists: num(c.lists), maxDepth: num(c.maxDepth), beatLists: num(c.beatLists), effects,
    detail: {
      ssLines: num(d.ssLines), ssDots: num(d.ssDots), ssZ: num(d.ssZ), ssPolar: num(d.ssPolar),
      mvBuiltin: num(d.mvBuiltin), mvScript: num(d.mvScript), mvKaleido: num(d.mvKaleido),
      unsupported: num(d.unsupported), decoded: d.decoded !== false,
    },
    unrunnable,
  };
}
const count = (c: PresetComposition, key: string): number => {
  const v = Object.prototype.hasOwnProperty.call(c.effects, key) ? c.effects[key] : 0;
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : 0;
};

/** Style score per category (multi-scene, minimal and mixed are never scored: they come from structure). */
export function scoreComposition(input: PresetComposition): Record<CategoryId, number> {
  const c = normalizeComposition(input);
  const s = Object.fromEntries(TAXONOMY.map(t => [t.id, 0])) as Record<CategoryId, number>;
  const R = TAXONOMY_RULES;
  const keys = Object.keys(c.effects).sort();
  for (const key of keys) {
    const n = count(c, key);
    const weights = n > 0 ? TAXONOMY_WEIGHTS.get(key) : undefined;
    if (!weights) continue;
    const factor = COUNT_FACTOR[Math.min(n, 8)]!;
    for (const id of Object.keys(weights) as CategoryId[]) s[id] += weights[id]! * factor;
  }
  const d = c.detail;
  const lines = num(d.ssLines), dots = num(d.ssDots), z = num(d.ssZ), scopes = lines + dots;
  const move = MOVE.reduce((a, k) => a + count(c, k), 0), decay = DECAY.reduce((a, k) => a + count(c, k), 0);
  if (num(d.mvBuiltin) > 0 && num(d.mvScript) === 0) s['tunnel-zoom'] += R.tunnelBuiltinMovement;
  if (move >= 1 && decay >= 1) s['tunnel-zoom'] += R.tunnelEngineDecay;
  if (count(c, K_DM) >= 2) s['tunnel-zoom'] += R.tunnelMultiDynamic;
  if (num(d.mvKaleido) > 0) s['kaleido-mirror'] += R.kaleidoscope;
  if (lines > 0) s['scope-classic'] += Math.min(lines, R.ssLineCap) * R.ssLine;
  if (dots > 0) s['particles'] += Math.min(dots, R.ssDotCap) * R.ssDot;
  if (scopes >= R.ssGeometryMin) s['scope-geometry'] += R.ssGeometryBase + Math.min(scopes, R.ssGeometryCap) * R.ssGeometryPer;
  if (z > 0) s['perspective-3d'] += R.ssZBase + Math.min(z, R.ssZCap) * R.ssZPer;
  if (num(d.ssPolar) >= 1) s['scope-geometry'] += R.ssPolar;
  const beatLists = num(c.beatLists);
  if (beatLists >= 1) s['beat-flash'] += Math.min(beatLists, R.beatListCap) * R.beatListPer;
  for (const id of Object.keys(s) as CategoryId[]) s[id] = r6(s[id]);
  return s;
}

/** Facets that ride along with the category (JEV 4.4). */
export function facetsOf(input: PresetComposition): Facets {
  const c = normalizeComposition(input);
  const n = num(c.components);
  const bounds = TAXONOMY_RULES.busyBounds;
  const b = (n <= bounds[0]! ? 1 : n <= bounds[1]! ? 2 : n <= bounds[2]! ? 3 : n <= bounds[3]! ? 4 : 5) as Facets['b'];
  const onBeat = count(c, K_ONBEAT);
  const beat = num(c.beatLists) + onBeat + count(c, K_BPM) >= 1;
  const e: Facets['e'] = (beat && b >= 4) || (onBeat > 0 && count(c, K_INVERT) > 0) ? 'intense' : beat ? 'driving' : b >= 3 ? 'steady' : 'calm';
  return { b, e, f: num(c.detail.unsupported) > 0 ? 'partial' : 'full', beat: beat ? 'reactive' : 'flowing' };
}

const STRUCTURAL: ReadonlySet<string> = new Set<CategoryId>(['multi-scene', 'minimal', 'mixed']);

/** Classify one composition. Total: never throws for any object-shaped input; malformed counters are treated as zero. */
export function classifyComposition(input: PresetComposition): Classification {
  const c = normalizeComposition(input);
  const R = TAXONOMY_RULES;
  const scores = scoreComposition(c);
  const ranked = TAXONOMY.filter(t => !STRUCTURAL.has(t.id)).map(t => [t.id as CategoryId, scores[t.id as CategoryId]] as const)
    .sort((a, b) => b[1] - a[1]); // stable: equal scores keep TAXONOMY order
  const [topId, top] = ranked[0]!;
  const second = ranked[1]![1];
  const n = num(c.components), lists = num(c.lists);
  const large = n >= R.multiSceneMinComponents || lists >= R.multiSceneMinLists;
  let primary: CategoryId;
  if (n <= R.minimalMaxComponents) primary = 'minimal';
  else if (large) primary = top >= R.multiSceneStyleScore ? topId : 'multi-scene';
  else if (top < R.mixedBelow) primary = 'mixed';
  else primary = topId;
  const tags: CategoryId[] = ranked
    .filter(([id, v]) => id !== primary && v >= Math.max(R.tagMinScore, top * R.tagMinFraction))
    .slice(0, R.maxTags).map(([id]) => id);
  if (large && primary !== 'multi-scene') tags.unshift('multi-scene');
  const margin = top > 0 ? (top - second) / top : 0;
  const k = primary === 'minimal' ? R.minimalConfidence : Math.min(1, top / R.confidenceFull) * (0.5 + 0.5 * margin);
  return { primary, tags: tags.slice(0, R.maxTags), k: r6(Math.min(1, Math.max(0, k))), score: top, facets: facetsOf(c) };
}

/** C0/C1 controls, line/paragraph separators, zero-width and bidi controls; built from code points so the source stays plain ASCII. */
const CONTROL = new RegExp('[\x00-\x1f\x7f-\x9f' + [0x2028, 0x2029, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0xfeff, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map(cp => String.fromCodePoint(cp)).join('') + ']', 'g');
const RATING_SUFFIX = /\s*\[\s*\d+(?:\.\d+)?\s*stars?\s*\]\s*$/i;

/** Clean a catalog display name for display in a payload: rating suffix, control and bidi characters, slashes, hash-like runs, length. */
export function sanitizeTitle(displayName: string): string {
  let t = typeof displayName === 'string' ? displayName : '';
  t = t.slice(0, 2048);
  for (let i = 0; i < 4 && RATING_SUFFIX.test(t); i++) t = t.replace(RATING_SUFFIX, '');
  t = t.replace(CONTROL, '').replace(/[\\/]+/g, ' ').replace(/[0-9a-f]{32,}/gi, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > 80) {
    let cut = '';
    for (const ch of t) { if (cut.length + ch.length > 80) break; cut += ch; }
    t = cut.trim();
  }
  return t;
}

/** " - ", " en-dash " or " em-dash " between author and title. */
const SEPARATOR = new RegExp('\\s[-' + String.fromCodePoint(0x2013, 0x2014) + ']\\s');

const STYLE_WORDS: ReadonlySet<string> = new Set([
  ...BUILTIN_NAMES.flatMap(name => [name.toLowerCase(), ...name.toLowerCase().split(' ')]),
  ...TAXONOMY.flatMap(t => t.label.toLowerCase().split(/[^a-z0-9]+/)),
  'preset', 'presets', 'avs', 'new', 'old', 'untitled', 'test', 'tests', 'demo', 'default', 'misc', 'remix', 'mix', 'effect', 'effects',
  'tunnel', 'kaleidoscope', 'ripple', 'ripples', 'particle', 'particles', 'plasma', 'spiral', 'flower', 'fire', 'rain', 'snow', 'space',
  'star', 'stars', 'wave', 'waves', 'zoom', 'spin', 'flash', 'strobe', 'bump', 'blur', 'nova', 'the', 'a', 'an', 'and', 'of',
].filter(w => w.length > 0));

/**
 * Author heuristic: the prefix of "Author - Title". Sort key only, never a security or grouping guarantee. Returns null when
 * there is no separator, or the prefix is numeric, an effect or style word, empty, without letters, or longer than 40 characters.
 */
export function authorOf(displayName: string): string | null {
  const t = sanitizeTitle(displayName);
  const at = t.search(SEPARATOR);
  if (at <= 0) return null;
  const author = t.slice(0, at).replace(/^[\s._\-#]+|[\s._\-#]+$/g, '');
  if (author.length === 0 || author.length > 40) return null;
  if (!/\p{L}/u.test(author)) return null;
  if (/^v?\d+(?:[._]\d+)*$/i.test(author)) return null;
  const words = author.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0 || words.every(w => STYLE_WORDS.has(w)) || STYLE_WORDS.has(words.join(' '))) return null;
  return author;
}

/** Display name of an effect key, sanitised for use in a payload. */
export function effectName(key: string): string {
  if (key.startsWith('ape:')) return sanitizeTitle(key.slice(4)).slice(0, 40) || 'APE';
  const id = /^b(-?\d+)$/.exec(key);
  if (!id) return 'Other';
  return BUILTIN_NAMES[Number(id[1])] ?? `Unknown renderer ${Number(id[1])}`;
}

/**
 * The Jev `state` object (JEV 5.2), built from a fixed field list: title (optional), effects with counts and details,
 * structure counters, and unrunnable effect names. It never carries a hash, path, file name, size, rating, mark, EEL source or
 * any identifier. `names: false` drops the title (`--no-names`).
 */
export function jevState(input: PresetComposition, title: string | null, names = true): Record<string, unknown> {
  const c = normalizeComposition(input);
  const detail = c.detail;
  const notes = (key: string): string | undefined => {
    if (key === builtinKey(36)) {
      const parts = [num(detail.ssLines) ? `${num(detail.ssLines)} line-mode` : '', num(detail.ssDots) ? `${num(detail.ssDots)} dot-mode` : ''].filter(Boolean);
      return parts.length ? parts.join(', ') : undefined;
    }
    if (key === builtinKey(15)) {
      const parts = [num(detail.mvBuiltin) ? `${num(detail.mvBuiltin)} built-in` : '', num(detail.mvScript) ? `${num(detail.mvScript)} scripted` : ''].filter(Boolean);
      return parts.length ? parts.join(', ') : undefined;
    }
    return undefined;
  };
  const effects = Object.keys(c.effects).filter(k => count(c, k) > 0)
    .sort((a, b) => count(c, b) - count(c, a) || (a < b ? -1 : 1)).slice(0, 24)
    .map(key => {
      const detailText = notes(key);
      return { name: effectName(key), count: count(c, key), ...(detailText ? { detail: detailText } : {}) };
    });
  const clean = names && title ? sanitizeTitle(title) : '';
  return {
    ...(clean ? { title: clean } : {}),
    effects,
    structure: { components: num(c.components), effect_lists: num(c.lists), max_depth: num(c.maxDepth), beat_render_lists: num(c.beatLists) },
    unrunnable_effects: c.unrunnable.slice(0, MAX_UNRUNNABLE).map(k => effectName(k)),
  };
}
