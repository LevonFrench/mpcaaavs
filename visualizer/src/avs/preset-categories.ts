/**
 * AVS style taxonomy data, the optional private categories file and the optional local HUD title overlay
 * (docs/design/PRESET-TAXONOMY-AND-JEV.md 4.2 and 6, docs/design/CONTRACT.md 2.3.8 and C-35, owner directive C).
 * The TAXONOMY table was seeded by INT1; the strict parser and both loaders are the SIG stream's.
 * `preset-taxonomy.ts` imports the table from this file.
 *
 * `catalog/categories.json` and `catalog/hud-titles.json` are private and optional. Every failure of a loader returns `null`
 * (never throws, never logs a path, never retries), and the browser then shows the flat catalog plus the non-AI folders, or the
 * neutral public HUD names. The parsers are pure and total; the loaders touch only `fetch` and a timer.
 */
import { boundedBytes, boundedJson, MAX_CATALOG_ENTRIES } from './local-assets.ts';

/** Bumped when the category set changes; a `categories.json` with another taxonomy version is ignored. */
export const TAXONOMY_VERSION = 1;

export interface TaxonomyCategory { readonly id: string; readonly label: string; readonly family: string }

const table = (family: string, ...rows: readonly (readonly [id: string, label: string])[]): readonly TaxonomyCategory[] =>
  rows.map(([id, label]) => Object.freeze({ id, label, family }));

/** The 18 categories in 6 families. Array order is the tie-break order of the classifier. */
export const TAXONOMY: readonly TaxonomyCategory[] = Object.freeze([
  ...table('Scopes', ['scope-classic', 'Waveforms & Oscilloscopes'], ['scope-geometry', 'Superscope Geometry'], ['rings-stars', 'Rings, Stars & Radial']),
  ...table('Particles & Space', ['particles', 'Particles & Dot Fields'], ['starfield', 'Starfields & Flight'], ['perspective-3d', '3D & Perspective']),
  ...table('Feedback & Motion', ['tunnel-zoom', 'Tunnels, Zoom & Echo Feedback'], ['spin-rotate', 'Spin & Rotate'], ['kaleido-mirror', 'Kaleidoscope & Mirror']),
  ...table('Surface & Colour', ['water-ripple', 'Water & Ripples'], ['bump-relief', 'Bump, Relief & Convolution'], ['color-grade', 'Colour Maps & Grading'], ['glitch-digital', 'Glitch & Digital Decay']),
  ...table('Beat & Frame', ['beat-flash', 'Beat Flash & Strobe'], ['text-image', 'Text, Pictures & Video']),
  ...table('Structure', ['multi-scene', 'Layered Multi-scene'], ['minimal', 'Minimal & Fragments'], ['mixed', 'General Mix']),
]);

/**
 * One preset's classification. `c` primary category id, `t` up to two secondary category ids, `e` energy, `b` busyness 1-5,
 * `f` fidelity of the classifier's input, `a` optional author, `s` source (structure, Jev, both, owner), `k` confidence 0-1.
 */
export interface PresetTaxon {
  readonly c: string;
  readonly t: readonly string[];
  readonly e: 'calm' | 'steady' | 'driving' | 'intense';
  readonly b: 1 | 2 | 3 | 4 | 5;
  readonly f: 'full' | 'partial';
  readonly a?: string;
  readonly s?: 's' | 'j' | 'sj' | 'o';
  readonly k?: number;
}

/** Read-only join of the classification to the catalog; the key is the preset's sha256. */
export type TaxonMap = ReadonlyMap<string, PresetTaxon>;

const CATALOG_DIR = './avs presets/catalog/';
const HEX64 = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const ENERGIES: ReadonlySet<string> = new Set(['calm', 'steady', 'driving', 'intense']);
const SOURCES: ReadonlySet<string> = new Set(['s', 'j', 'sj', 'o']);
const CATEGORY_IDS: ReadonlySet<string> = new Set(TAXONOMY.map(c => c.id));
const MAX_AUTHOR = 80;
const MAX_TAGS = 2;
const MAX_TAG_SCAN = 16;
/** Soft time limit for a categories or titles read; the file is local, so a stall means something is wrong. */
export const CATALOG_FETCH_TIMEOUT_MS = 4000;

/** Category id of a catalog preset that the file does not classify (a stale file, or none): it lands in "Unsorted". */
export const UNCLASSIFIED_ID = 'unclassified';
/**
 * Placeholder joined to every catalog preset the file does not cover. `e`, `b` and `f` are neutral fillers required by the type and
 * carry NO information: consumers must not facet by energy, busyness or fidelity for it (`isClassified` is false, `k` is 0).
 */
export const UNCLASSIFIED_TAXON: PresetTaxon = Object.freeze({ c: UNCLASSIFIED_ID, t: Object.freeze([]) as readonly string[], e: 'steady', b: 3, f: 'partial', k: 0 } as const);
export const isClassified = (taxon: PresetTaxon | undefined | null): taxon is PresetTaxon => !!taxon && taxon.c !== UNCLASSIFIED_ID;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined);

/** One entry, or `null` when a required field is missing or wrong (the entry is then dropped). Optional fields are sanitised individually. */
function parseTaxon(value: unknown): PresetTaxon | null {
  if (!isRecord(value)) return null;
  const c = own(value, 'c'), e = own(value, 'e'), b = own(value, 'b'), f = own(value, 'f');
  if (typeof c !== 'string' || !CATEGORY_IDS.has(c)) return null;
  if (typeof e !== 'string' || !ENERGIES.has(e)) return null;
  if (typeof b !== 'number' || !Number.isInteger(b) || b < 1 || b > 5) return null;
  if (f !== 'full' && f !== 'partial') return null;
  const rawTags = own(value, 't');
  if (rawTags !== undefined && !Array.isArray(rawTags)) return null;
  const tags: string[] = [];
  for (const tag of ((rawTags ?? []) as unknown[]).slice(0, MAX_TAG_SCAN)) {
    if (typeof tag === 'string' && CATEGORY_IDS.has(tag) && tag !== c && !tags.includes(tag) && tags.length < MAX_TAGS) tags.push(tag);
  }
  const author = own(value, 'a'), source = own(value, 's'), confidence = own(value, 'k');
  return Object.freeze({
    c, t: Object.freeze(tags), e: e as PresetTaxon['e'], b: b as PresetTaxon['b'], f,
    ...(typeof author === 'string' && author.length > 0 && author.length <= MAX_AUTHOR && !CONTROL.test(author) ? { a: author } : {}),
    ...(typeof source === 'string' && SOURCES.has(source) ? { s: source as NonNullable<PresetTaxon['s']> } : {}),
    ...(typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? { k: confidence } : {}),
  });
}

/**
 * Pure, strict parser (JEV 6.2); total: it never throws. Returns `null` (the file is ignored) unless `format`, `version` and the
 * taxonomy id and version all match and `entries` is a plain object of at most `MAX_CATALOG_ENTRIES`. Entry keys must be lowercase
 * 64-hex sha256 (this rejects `__proto__` and friends); an entry with an unknown category, energy, busyness or fidelity is dropped;
 * tags keep only known, distinct secondary categories (at most 2); an invalid author, source or confidence is omitted.
 *
 * With a `catalog` array the result is joined to it: entries whose hash is not in the catalog are ignored, and every catalog preset
 * the file does not cover receives `UNCLASSIFIED_TAXON`, so a stale file degrades to "Unsorted", never an error. Without an array
 * (the loader before the catalog is known) every valid entry is kept and no filler is added: an absent key means unclassified.
 * Only the taxon objects are frozen; a Map cannot be, so treat the result as read-only.
 */
export function parseCategories(json: unknown, catalog: readonly { sha256: string }[]): TaxonMap | null {
  try {
    if (!isRecord(json) || own(json, 'format') !== 'aaavs-categories' || own(json, 'version') !== 1) return null;
    const taxonomy = own(json, 'taxonomy');
    if (!isRecord(taxonomy) || own(taxonomy, 'id') !== 'aaavs-style' || own(taxonomy, 'version') !== TAXONOMY_VERSION) return null;
    const entries = own(json, 'entries');
    if (!isRecord(entries)) return null;
    const keys = Object.keys(entries);
    if (keys.length > MAX_CATALOG_ENTRIES) return null;
    const valid = new Map<string, PresetTaxon>();
    for (const key of keys) {
      if (!HEX64.test(key)) continue;
      const taxon = parseTaxon(entries[key]);
      if (taxon) valid.set(key, taxon);
    }
    if (!Array.isArray(catalog)) return valid;
    const joined = new Map<string, PresetTaxon>();
    for (const row of catalog) {
      const sha = row && typeof row.sha256 === 'string' ? row.sha256.toLowerCase() : '';
      if (!HEX64.test(sha) || joined.has(sha)) continue;
      joined.set(sha, valid.get(sha) ?? UNCLASSIFIED_TAXON);
    }
    return joined;
  } catch {
    return null;
  }
}

/** Rejects after `ms` (no timer facility means no limit); the loser of the race is left to finish and its result is ignored. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  if (typeof setTimeout !== 'function' || !(ms > 0)) return work;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    work.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}
const baseOf = (baseUri?: string): string => baseUri ?? (typeof document === 'undefined' ? 'http://127.0.0.1/' : document.baseURI);

/**
 * Loads `avs presets/catalog/categories.json` relative to `baseUri` (default: the page base). Every failure (404, timeout, oversize,
 * parse, mismatch) returns `null`; it never throws, never logs a path and never retries. Pass the loaded catalog as `catalog` to get
 * the joined map with `UNCLASSIFIED_TAXON` fillers; without it the map holds exactly the valid entries of the file.
 */
export async function fetchLocalCategories(baseUri?: string, catalog?: readonly { sha256: string }[], options?: { readonly timeoutMs?: number }): Promise<TaxonMap | null> {
  try {
    const url = new URL(`${CATALOG_DIR}categories.json`, baseOf(baseUri));
    const json = await withTimeout(boundedJson(url), options?.timeoutMs ?? CATALOG_FETCH_TIMEOUT_MS);
    return parseCategories(json, catalog as readonly { sha256: string }[]);
  } catch {
    return null;
  }
}

// ---- local HUD title overlay (owner directive C, contract Q22): real game and film titles exist only in this private file ----

export const HUD_TITLES_FORMAT = 'aaavs-hud-titles';
export const HUD_TITLES_MAX_ENTRIES = 20000;
export const HUD_TITLES_MAX_BYTES = 4 * 1024 * 1024;
export const HUD_TITLE_MAX_LENGTH = 120;
export const HUD_TITLE_ID_MAX_LENGTH = 96;
const TITLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** C0/C1 controls, line/paragraph separators, zero-width and bidirectional formatting characters and angle brackets: none may appear in a display title. */
const TITLE_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff<>]/;

/** Scene id -> display title. Absent id means the browser keeps the neutral public name. */
export type HudTitleMap = ReadonlyMap<string, string>;

/**
 * Pure, total parser for `{format:'aaavs-hud-titles', version:1, titles:{<scene id>: '<display title>'}}`. `null` when the format or
 * version differs, `titles` is not a plain object, or it holds more than `HUD_TITLES_MAX_ENTRIES`. Individual bad entries are dropped
 * (the scene keeps its neutral name): an id that is not `[A-Za-z0-9][A-Za-z0-9._-]*` of at most 96 characters, or a title that is not a
 * string, is empty after trimming, exceeds 120 characters or contains a forbidden character (controls, bidi/zero-width, angle brackets). Titles are stored trimmed.
 */
export function parseHudTitles(json: unknown): HudTitleMap | null {
  try {
    if (!isRecord(json) || own(json, 'format') !== HUD_TITLES_FORMAT || own(json, 'version') !== 1) return null;
    const titles = own(json, 'titles');
    if (!isRecord(titles)) return null;
    const keys = Object.keys(titles);
    if (keys.length > HUD_TITLES_MAX_ENTRIES) return null;
    const map = new Map<string, string>();
    for (const id of keys) {
      const raw = titles[id];
      if (id.length > HUD_TITLE_ID_MAX_LENGTH || !TITLE_ID.test(id) || typeof raw !== 'string' || raw.length > HUD_TITLE_MAX_LENGTH * 2) continue;
      const title = raw.trim();
      if (title.length === 0 || title.length > HUD_TITLE_MAX_LENGTH || TITLE_FORBIDDEN.test(title)) continue;
      map.set(id, title);
    }
    return map;
  } catch {
    return null;
  }
}

/**
 * Loads `avs presets/catalog/hud-titles.json` (at most 4 MiB) relative to `baseUri`. Every failure returns `null`; the caller (the
 * catalog code in `local-collection.ts`) then shows the neutral public names. Never throws and never logs a path.
 */
export async function fetchLocalHudTitles(baseUri?: string, options?: { readonly timeoutMs?: number }): Promise<HudTitleMap | null> {
  try {
    const url = new URL(`${CATALOG_DIR}hud-titles.json`, baseOf(baseUri));
    const bytes = await withTimeout(boundedBytes(url, HUD_TITLES_MAX_BYTES), options?.timeoutMs ?? CATALOG_FETCH_TIMEOUT_MS);
    return parseHudTitles(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch {
    return null;
  }
}
