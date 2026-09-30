import { boundedBytes, boundedJson, localAssetUrl, MAX_ASSET_BYTES, MAX_CATALOG_ENTRIES, verifyDigest } from './local-assets.ts';
import { NERV_SCENES, type NervSceneId } from '../nerv-scenes.ts';
import { fetchLocalCategories, fetchLocalHudTitles, type HudTitleMap, type TaxonMap } from './preset-categories.ts';
/** Where a preset came from: the source package and the file's path inside that package. The private staging path is never kept. */
export interface PresetOrigin { readonly pkg: string; readonly path: string }
/** HUD scene metadata of a `kind: 'hud'` catalog row. Installer-written and validated at parse (docs/design/CONTRACT.md 2.2.5). */
export interface LocalHudMeta {
  readonly id: string;
  readonly pack: string;
  readonly family: string;
  readonly tags: readonly string[];
  readonly tier: 'showcase' | 'tuned' | 'auto';
  readonly order: number;
  readonly canvas: { readonly style: 'pixel' | 'vector'; readonly w: number; readonly h: number; readonly par?: readonly [number, number] };
}
export interface LocalAvsPreset {
  readonly id: string;
  readonly name: string;
  readonly fileName: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly url: string;
  readonly parserStatus: 'lossless' | 'roundtrip-mismatch' | 'parse-error' | 'unknown';
  readonly autoEligible: boolean;
  readonly rating?: number;
  readonly notWorking?: boolean;
  readonly kind?: 'avs' | 'nerv' | 'hud';
  readonly scene?: NervSceneId;
  /** Optional `/`-separated sub-path inside the kind's browser root; an invalid hint is ignored. */
  readonly folder?: string;
  /** Present exactly when `kind === 'hud'`. */
  readonly hud?: LocalHudMeta;
  /** Provenance from the catalog's `occurrences` (1..32 entries). Malformed or oversize data is dropped, never thrown. */
  readonly origins?: readonly PresetOrigin[];
  readonly unavailableReason?: string;
}
/** Scene kinds render through their own workers and never enter the AVS executor, Studio registry or bitmap loader. */
export function isSceneKind(preset: { readonly kind?: string } | null | undefined): boolean {
  return preset?.kind === 'nerv' || preset?.kind === 'hud';
}

interface LocalCatalogJson {
  readonly presets?: readonly {
    readonly sha256?: unknown;
    readonly bytes?: unknown;
    readonly canonical_path?: unknown;
    readonly display_name?: unknown;
    readonly rating?: unknown;
    readonly notWorking?: unknown;
    /** Installer-retained history; only HUD rows interpret this flag. */
    readonly superseded?: unknown;
    readonly kind?: unknown;
    readonly scene?: unknown;
    readonly folder?: unknown;
    readonly hud?: unknown;
    readonly occurrences?: unknown;
  }[];
}

interface ParserValidationJson {
  readonly results?: readonly {
    readonly sha256?: unknown;
    readonly status?: unknown;
    readonly error?: unknown;
  }[];
}

const COLLECTION_ROOT = './avs presets/';
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** A folder hint is dropped, never thrown: folder data must not make the catalog unloadable. */
function folderHint(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parts = value.split('/');
  return parts.length <= 6 && parts.every(part => part.length > 0 && part.length <= 80 && !CONTROL.test(part)) ? value : undefined;
}

/**
 * Provenance is browsing data only: a malformed entry is skipped and an oversize list is dropped whole. Only the package id
 * and the archive-relative `original_path` are read; the catalog's private staging `path` is never looked at.
 */
function parseOrigins(value: unknown): readonly PresetOrigin[] | undefined {
  if (!Array.isArray(value) || value.length > 32) return undefined;
  const origins: PresetOrigin[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { package_id: pkg, original_path: path } = item as { package_id?: unknown; original_path?: unknown };
    if (typeof pkg !== 'string' || !pkg || pkg.length > 200 || CONTROL.test(pkg)) continue;
    if (typeof path !== 'string' || !path || path.length > 1024 || CONTROL.test(path)) continue;
    origins.push(Object.freeze({ pkg, path }));
  }
  return origins.length ? Object.freeze(origins) : undefined;
}

/** A `hud` row is installer-written, so a malformed block throws like a malformed NERV row. Tags are descriptive and sanitized instead. */
function parseHudMeta(value: unknown): LocalHudMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid HUD preset metadata');
  const v = value as Record<string, unknown>;
  const text = (x: unknown): string => {
    if (typeof x !== 'string' || x.length < 1 || x.length > 80 || CONTROL.test(x)) throw new Error('Invalid HUD preset metadata');
    return x;
  };
  if (v.tier !== 'showcase' && v.tier !== 'tuned' && v.tier !== 'auto') throw new Error('Invalid HUD preset metadata');
  if (typeof v.order !== 'number' || !Number.isSafeInteger(v.order)) throw new Error('Invalid HUD preset metadata');
  const c = v.canvas as Record<string, unknown> | null | undefined;
  const size = (x: unknown): number => {
    if (typeof x !== 'number' || !Number.isInteger(x) || x < 64 || x > 1920) throw new Error('Invalid HUD canvas');
    return x;
  };
  if (!c || typeof c !== 'object' || Array.isArray(c) || (c.style !== 'pixel' && c.style !== 'vector')) throw new Error('Invalid HUD canvas');
  const ratio = (x: unknown): number => {
    if (typeof x !== 'number' || !Number.isInteger(x) || x < 1 || x > 16) throw new Error('Invalid HUD canvas');
    return x;
  };
  let par: readonly [number, number] | undefined;
  if (c.par !== undefined) {
    if (!Array.isArray(c.par) || c.par.length !== 2) throw new Error('Invalid HUD canvas');
    par = Object.freeze([ratio(c.par[0]), ratio(c.par[1])] as [number, number]);
  }
  const tags = Array.isArray(v.tags)
    ? v.tags.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0 && tag.length <= 24 && !CONTROL.test(tag)).slice(0, 8)
    : [];
  return Object.freeze({
    id: text(v.id), pack: text(v.pack), family: text(v.family), tags: Object.freeze(tags),
    tier: v.tier, order: v.order,
    canvas: Object.freeze({ style: c.style, w: size(c.w), h: size(c.h), ...(par ? { par } : {}) }),
  });
}

/** Load the private/local 3,409-preset catalog without adding it to the public bundle. */
export async function fetchLocalAvsCatalog(): Promise<readonly LocalAvsPreset[]> {
  const base = typeof document === 'undefined' ? 'http://127.0.0.1/' : document.baseURI;
  const catalogUrl = new URL(`${COLLECTION_ROOT}catalog/presets.json`, base);
  const validationUrl = new URL(`${COLLECTION_ROOT}catalog/parser-validation.json`, base);
  const [catalog, validation] = await Promise.all([boundedJson(catalogUrl), boundedJson(validationUrl)]);
  return parseLocalAvsCatalog(catalog as LocalCatalogJson, validation as ParserValidationJson, base);
}

/** Pure parser used by browser loading and the deterministic catalog check. */
export function parseLocalAvsCatalog(
  json: LocalCatalogJson,
  validation: ParserValidationJson,
  baseUrl: string,
): readonly LocalAvsPreset[] {
  if (!json || !Array.isArray(json.presets) || json.presets.length > MAX_CATALOG_ENTRIES) throw new Error('Local AVS catalog has no preset list');
  if (!validation || !Array.isArray(validation.results) || validation.results.length > MAX_CATALOG_ENTRIES) throw new Error('Local AVS parser metadata has no result list');
  const parserByHash = new Map(validation.results.map((entry, index) => {
    if (!entry || typeof entry.sha256 !== 'string' || typeof entry.status !== 'string') {
      throw new Error(`Invalid local AVS parser metadata entry ${index}`);
    }
    return [entry.sha256.toLowerCase(), entry] as const;
  }));
  return Object.freeze(json.presets.map((entry, index): LocalAvsPreset | null => {
    if (!entry || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.sha256)
      || typeof entry.display_name !== 'string' || entry.display_name.length > 2048 || typeof entry.canonical_path !== 'string'
      || typeof entry.bytes !== 'number' || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > MAX_ASSET_BYTES
      || entry.notWorking !== undefined && typeof entry.notWorking !== 'boolean') {
      throw new Error(`Invalid local AVS catalog entry ${index}`);
    }
    const parser = parserByHash.get(entry.sha256.toLowerCase());
    const parserStatus = parser?.status === 'lossless' || parser?.status === 'roundtrip-mismatch' || parser?.status === 'parse-error'
      ? parser.status
      : 'unknown';
    const unavailableReason = parserStatus === 'parse-error'
      ? typeof parser?.error === 'string' ? parser.error : 'The AVS parser rejected this historical preset'
      : undefined;
    const url = localAssetUrl(entry.canonical_path, 'presets', baseUrl);
    const kind = entry.kind === 'nerv' ? 'nerv' : entry.kind === 'hud' ? 'hud' : 'avs';
    if (kind === 'hud' && entry.superseded !== undefined && typeof entry.superseded !== 'boolean') throw new Error('Invalid HUD superseded marker');
    if (kind === 'nerv' && !entry.canonical_path.endsWith('.nerv')) throw new Error('Invalid NERV preset extension');
    if (kind === 'nerv' && !NERV_SCENES.includes(entry.scene as NervSceneId)) throw new Error('Invalid NERV scene ID');
    if (kind === 'hud' && !entry.canonical_path.endsWith('.hud')) throw new Error('Invalid HUD preset extension');
    const hud = kind === 'hud' ? parseHudMeta(entry.hud) : undefined;
    const folder = folderHint(entry.folder);
    const origins = parseOrigins(entry.occurrences);
    // Keep every historical byte and personal field on disk, but an obsolete HUD
    // version must never enter browser selection or Auto alongside its successor.
    if (kind === 'hud' && entry.superseded === true) return null;
    return Object.freeze({
      id: `local:${entry.sha256}`,
      name: entry.display_name,
      fileName: entry.canonical_path.split('/').at(-1)!,
      sha256: entry.sha256,
      bytes: entry.bytes,
      url,
      kind,
      ...(kind === 'nerv' ? {scene:entry.scene as NervSceneId} : {}),
      ...(hud ? { hud } : {}),
      ...(folder ? { folder } : {}),
      ...(origins ? { origins } : {}),
      parserStatus,
      autoEligible: parserStatus !== 'parse-error',
      rating: typeof entry.rating === 'number' && Number.isInteger(entry.rating) && entry.rating >= 1 && entry.rating <= 5 ? entry.rating : 0,
      notWorking: entry.notWorking === true,
      ...(unavailableReason ? { unavailableReason } : {}),
    });
  }).filter((entry): entry is LocalAvsPreset => entry !== null));
}

export async function fetchLocalAvsPreset(preset: LocalAvsPreset): Promise<Uint8Array> {
  if (!Number.isSafeInteger(preset.bytes) || preset.bytes <= 0 || preset.bytes > MAX_ASSET_BYTES) throw new Error('Invalid local preset byte size');
  const bytes = await boundedBytes(preset.url, preset.bytes);
  if (bytes.byteLength !== preset.bytes) throw new Error(`Local AVS size mismatch for ${preset.name}`);
  await verifyDigest(bytes, preset.sha256);
  return bytes;
}

/** Provenance of one source package from the optional `catalog/sources.json`. Only descriptive strings are kept (never URLs). */
export interface SourceInfo {
  readonly catalog?: string;
  readonly fileName?: string;
  readonly artist?: string;
  readonly repository?: string;
  readonly release?: string;
}
/** Keyed by package id. Empty when the file is missing (public and stock installs). */
export type SourceMap = ReadonlyMap<string, SourceInfo>;
const SOURCE_LIMIT = 5000;
const SOFT_TIMEOUT_MS = 2000;

const shortText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && !CONTROL.test(value) ? value : undefined;

/** Pure and total: any input yields a map (possibly empty). At most 5000 entries; ids of at most 200 characters. */
export function parseLocalAvsSources(json: unknown): SourceMap {
  const map = new Map<string, SourceInfo>();
  const rows = Array.isArray(json) ? json : json && typeof json === 'object' ? (json as { sources?: unknown }).sources : undefined;
  if (!Array.isArray(rows)) return map;
  for (const row of rows) {
    if (map.size >= SOURCE_LIMIT) break;
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = shortText(r.id);
    if (!id || id === '__proto__') continue;
    const catalog = shortText(r.catalog), fileName = shortText(r.file_name), artist = shortText(r.artist_slug);
    const repository = shortText(r.repository), release = shortText(r.release_id);
    map.set(id, Object.freeze({
      ...(catalog ? { catalog } : {}), ...(fileName ? { fileName } : {}), ...(artist ? { artist } : {}),
      ...(repository ? { repository } : {}), ...(release ? { release } : {}),
    }));
  }
  return map;
}

/** Bounded soft timeout: the result of `work` or `fallback`, never a rejection. */
async function softly<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), SOFT_TIMEOUT_MS); })]);
  } catch { return fallback; } finally { if (timer !== undefined) clearTimeout(timer); }
}
const collectionBase = (baseUri?: string): string => baseUri ?? (typeof document === 'undefined' ? 'http://127.0.0.1/' : document.baseURI);

/** Lazy and optional: fetched when the browser first opens. A missing or unreadable file yields an empty map; never throws. */
export async function fetchLocalAvsSources(baseUri?: string): Promise<SourceMap> {
  return softly(async () => parseLocalAvsSources(await boundedJson(new URL(`${COLLECTION_ROOT}catalog/sources.json`, collectionBase(baseUri)))), new Map());
}

// The private optional overlay `catalog/hud-titles.json` `{format:'aaavs-hud-titles', version:1, titles:{<scene id>: title}}` is written
// by the local installer. Public manifests and catalog names stay neutral; this overlay is the only place a real title appears. The
// strict parser and the loader are the SIG stream's (`preset-categories.ts`, which the host fixtures do not stub); they are re-exported
// here so catalog code and the browser have one home for it. Every failure returns `null`, and the browser then shows the neutral names.
export { fetchLocalHudTitles, parseHudTitles as parseLocalHudTitles, type HudTitleMap } from './preset-categories.ts';

/** Optional browser data, each part independently optional. */
export interface LocalBrowserData { readonly sources: SourceMap; readonly taxa: TaxonMap | null; readonly titles: HudTitleMap | null }
/**
 * The categories hook: loads the three optional private files the Preset Browser can use (source provenance, style taxonomy,
 * HUD title overlay) in parallel. A failure of one never affects the others or the catalog; the result is always usable.
 */
export async function fetchLocalAvsBrowserData(baseUri?: string, catalog?: readonly { readonly sha256: string }[]): Promise<LocalBrowserData> {
  const [sources, taxa, titles] = await Promise.all([
    fetchLocalAvsSources(baseUri).catch(() => new Map<string, SourceInfo>() as SourceMap),
    fetchLocalCategories(baseUri, catalog).catch(() => null),
    fetchLocalHudTitles(baseUri).catch(() => null),
  ]);
  return { sources, taxa, titles };
}
