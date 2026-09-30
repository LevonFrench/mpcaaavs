import type { HudTitleMap, LocalAvsPreset } from './avs/local-collection.ts';
import { TAXONOMY, isClassified, type TaxonMap } from './avs/preset-categories.ts';
import type { FolderTree } from './mpc-folders.ts';
import type { PlayStats } from './mpc-folder-stats.ts';
/**
 * Search, sort and virtual-window logic of the Preset Browser (docs/design/PRESET-BROWSER-V2.md 6 and 7). Pure and DOM-free.
 * `buildRecords` turns the catalog into struct-of-arrays once per catalog revision; a linear scan of those arrays is fast
 * enough (about 1.5 ms for 12,000 rows), so there is no inverted index. Names and paths are folded once (accent- and
 * case-insensitive) and compared by integer rank, so sorting never calls a collator per comparison.
 */

export const FLAG = { notWorking: 1, unavailable: 2, nerv: 4, hud: 8, failed: 16, partial: 32 } as const;
export const TIER = { none: 0, showcase: 1, tuned: 2, auto: 3 } as const;

export interface RecordSet {
  count: number;
  /** Bumped by every in-place patch; dynamic folder counts are memoised against it. */
  version: number;
  /** The shown name: the catalog name, or the local title overlay for HUD rows only. */
  display: string[];
  nameKey: string[]; pathKey: string[]; pkgKey: string[]; srcKey: string[];
  rating: Uint8Array; bytes: Uint32Array; flags: Uint8Array; tier: Uint8Array;
  nameRank: Int32Array; pathRank: Int32Array; pkgRank: Int32Array;
  plays: Uint16Array; lastPlayed: Float64Array; hasStats: boolean;
  /** Taxonomy columns; all null when no `TaxonMap` exists. `taxon` is the index into TAXONOMY (-1 unknown). */
  taxon: Int8Array | null; energy: Int8Array | null; busy: Uint8Array | null;
  authorKey: string[] | null; authorRank: Int32Array | null; styleKey: string[] | null;
}

export function foldText(text: string): string {
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
/** Digits are zero-padded so `Intro 2` sorts before `Intro 10` under a plain string comparison. */
export function naturalKey(text: string): string {
  return foldText(text).replace(/\d+/g, digits => digits.length >= 12 ? digits : digits.padStart(12, '0'));
}
/** Dense ranks: equal keys share a rank, so a later tie-break decides their order. */
export function denseRanks(keys: readonly string[]): Int32Array {
  const order = Array.from(keys.keys()).sort((a, b) => keys[a]! < keys[b]! ? -1 : keys[a]! > keys[b]! ? 1 : a - b);
  const ranks = new Int32Array(keys.length);
  let rank = -1, previous: string | undefined;
  for (const index of order) {
    if (keys[index] !== previous) { rank++; previous = keys[index]; }
    ranks[index] = rank;
  }
  return ranks;
}

const ENERGY = ['calm', 'steady', 'driving', 'intense'] as const;
const CATEGORY_INDEX = new Map(TAXONOMY.map((c, i) => [c.id, i] as const));
const AUTHOR_LIMIT = 80;

/** Path text is every label below the AVS source section, so a search for an artist matches their whole subtree. */
function nodeTexts(tree: FolderTree) {
  const cache = new Map<number, { path: string; pkg: string; src: string }>();
  const visit = (id: number): { path: string; pkg: string; src: string } => {
    const known = cache.get(id);
    if (known) return known;
    const node = tree.nodes[id]!;
    const parent = node.parent >= 0 ? visit(node.parent) : { path: '', pkg: '', src: '' };
    const skip = node.key === 'avs' || node.key === 'avs/src';
    const label = foldText(node.label);
    const path = skip ? parent.path : parent.path ? `${parent.path} / ${label}` : label;
    const pkg = node.kind === 'package' || node.kind === 'platform' ? (parent.pkg ? `${parent.pkg} ${label}` : label) : parent.pkg;
    const src = node.kind === 'group' || node.kind === 'artist' ? (parent.src ? `${parent.src} ${label}` : label) : parent.src;
    const value = { path, pkg, src };
    cache.set(id, value);
    return value;
  };
  return visit;
}

export function buildRecords(catalog: readonly LocalAvsPreset[], tree: FolderTree, taxa?: TaxonMap | null, stats?: PlayStats | null,
  failed?: ReadonlySet<number>, titles?: HudTitleMap | null): RecordSet {
  const n = catalog.length;
  const texts = nodeTexts(tree);
  const display: string[] = new Array(n), nameKey: string[] = new Array(n), pathKey: string[] = new Array(n);
  const pkgKey: string[] = new Array(n), srcKey: string[] = new Array(n), pathNatural: string[] = new Array(n), pkgNatural: string[] = new Array(n);
  const rating = new Uint8Array(n), bytes = new Uint32Array(n), flags = new Uint8Array(n), tier = new Uint8Array(n);
  const plays = new Uint16Array(n), lastPlayed = new Float64Array(n);
  const taxon = taxa ? new Int8Array(n).fill(-1) : null, energy = taxa ? new Int8Array(n).fill(-1) : null, busy = taxa ? new Uint8Array(n) : null;
  const authorKey: string[] | null = taxa ? new Array(n).fill('') : null, styleKey: string[] | null = taxa ? new Array(n).fill('') : null;
  // Scenes that share one overlay title stay distinguishable: their rows read `Title / neutral name`, and inside a folder that carries
  // the title the list hides the repeated prefix (the convention NERV rows already use).
  const shared = new Map<string, number>();
  if (titles) for (const p of catalog) { const t = p.kind === 'hud' && p.hud ? titles.get(p.hud.id) : undefined; if (t !== undefined) shared.set(t, (shared.get(t) ?? 0) + 1); }
  for (let i = 0; i < n; i++) {
    const p = catalog[i]!;
    const title = p.kind === 'hud' && p.hud ? titles?.get(p.hud.id) : undefined;
    display[i] = title === undefined ? p.name : (shared.get(title) ?? 0) > 1 ? `${title} / ${p.name}` : title;
    nameKey[i] = foldText(display[i]!);
    rating[i] = Math.max(0, Math.min(5, p.rating ?? 0));
    bytes[i] = Math.max(0, Math.min(0xffffffff, p.bytes));
    flags[i] = (p.notWorking ? FLAG.notWorking : 0) | (p.parserStatus === 'parse-error' || !p.autoEligible ? FLAG.unavailable : 0)
      | (p.kind === 'nerv' ? FLAG.nerv : 0) | (p.kind === 'hud' ? FLAG.hud : 0) | (failed?.has(i) ? FLAG.failed : 0);
    if (p.kind === 'hud' && p.hud) tier[i] = TIER[p.hud.tier];
    const places = tree.locations[i] ?? [];
    const primary = tree.primary[i] ?? -1;
    const parts: string[] = [], pkgs: string[] = [], srcs: string[] = [];
    for (const id of places) { const t = texts(id); parts.push(t.path); if (t.pkg) pkgs.push(t.pkg); if (t.src) srcs.push(t.src); }
    // The neutral public name stays searchable when the local overlay replaces the shown one.
    if (title !== undefined) parts.push(foldText(p.name));
    pathKey[i] = parts.join(' | ');
    pkgKey[i] = pkgs.join(' | ');
    srcKey[i] = srcs.join(' | ');
    const lead = primary >= 0 ? texts(primary) : { path: '', pkg: '', src: '' };
    pathNatural[i] = naturalKey(lead.path);
    pkgNatural[i] = naturalKey(lead.pkg || lead.path);
    const played = stats?.plays.get(p.sha256);
    if (played) { plays[i] = Math.min(65535, played[0]); lastPlayed[i] = played[1]; }
    const t = taxa?.get(p.sha256);
    if (t && isClassified(t) && taxon && energy && busy && authorKey && styleKey) {
      const category = CATEGORY_INDEX.get(t.c) ?? -1;
      taxon[i] = category;
      energy[i] = ENERGY.indexOf(t.e);
      busy[i] = t.b;
      if (t.f === 'partial') flags[i] = flags[i]! | FLAG.partial;
      if (t.a) authorKey[i] = foldText(t.a).slice(0, AUTHOR_LIMIT);
      const cats = [t.c, ...t.t].map(id => TAXONOMY[CATEGORY_INDEX.get(id) ?? -1]).filter((c): c is NonNullable<typeof c> => !!c);
      styleKey[i] = foldText(cats.map(c => `${c.label} ${c.id} ${c.family}`).join(' '));
    }
  }
  return {
    count: n, version: 0, display, nameKey, pathKey, pkgKey, srcKey, rating, bytes, flags, tier,
    nameRank: denseRanks(nameKey.map(naturalKey)), pathRank: denseRanks(pathNatural), pkgRank: denseRanks(pkgNatural),
    plays, lastPlayed, hasStats: !!stats, taxon, energy, busy, authorKey,
    authorRank: authorKey ? denseRanks(authorKey.map(naturalKey)) : null, styleKey,
  };
}

/** Patch one row after a rating or mark change. The display name never changes with a rating, so the ranks stay valid. */
export function updateRecord(rs: RecordSet, index: number, preset: LocalAvsPreset): void {
  if (!Number.isInteger(index) || index < 0 || index >= rs.count) return;
  rs.rating[index] = Math.max(0, Math.min(5, preset.rating ?? 0));
  rs.bytes[index] = Math.max(0, Math.min(0xffffffff, preset.bytes));
  const keep = rs.flags[index]! & ~(FLAG.notWorking | FLAG.unavailable);
  rs.flags[index] = keep | (preset.notWorking ? FLAG.notWorking : 0) | (preset.parserStatus === 'parse-error' || !preset.autoEligible ? FLAG.unavailable : 0);
  rs.version++;
}
/** Mirror the session's failed set into the flags; returns whether anything changed. */
export function syncFailed(rs: RecordSet, failed: ReadonlySet<number>): boolean {
  let changed = false;
  for (let i = 0; i < rs.count; i++) {
    const has = failed.has(i), was = (rs.flags[i]! & FLAG.failed) !== 0;
    if (has !== was) { rs.flags[i] = has ? rs.flags[i]! | FLAG.failed : rs.flags[i]! & ~FLAG.failed; changed = true; }
  }
  if (changed) rs.version++;
  return changed;
}
/** Load play statistics into the play columns. */
export function applyStats(rs: RecordSet, catalog: readonly LocalAvsPreset[], stats: PlayStats | null): void {
  rs.plays.fill(0); rs.lastPlayed.fill(0); rs.hasStats = !!stats;
  if (stats) for (let i = 0; i < rs.count; i++) {
    const played = stats.plays.get(catalog[i]!.sha256);
    if (played) { rs.plays[i] = Math.min(65535, played[0]); rs.lastPlayed[i] = played[1]; }
  }
  rs.version++;
}

// ---------------------------------------------------------------------------------------------------------------- search

export type Field = 'name' | 'path' | 'pkg' | 'src' | 'author' | 'style' | 'energy' | 'busy' | 'fidelity' | 'kind' | 'is' | 'tier' | 'rating' | 'size' | 'plays' | 'played' | 'text';
export interface Range { readonly lo: number; readonly hi: number }
export interface Clause { readonly neg: boolean; readonly field: Field; readonly alts: readonly string[]; readonly ranges: readonly Range[] | null; readonly raw: string }
export interface Query { readonly raw: string; readonly text: readonly string[]; readonly clauses: readonly Clause[]; readonly notes: readonly string[] }

const FIELDS: Readonly<Record<string, Field>> = {
  name: 'name', path: 'path', folder: 'path', pkg: 'pkg', package: 'pkg', artist: 'src', source: 'src', author: 'author', style: 'style', category: 'style',
  energy: 'energy', busy: 'busy', busyness: 'busy', fidelity: 'fidelity', kind: 'kind', is: 'is', tier: 'tier', rating: 'rating', stars: 'rating',
  size: 'size', plays: 'plays', played: 'played',
};
const NUMERIC: ReadonlySet<Field> = new Set<Field>(['rating', 'size', 'plays', 'played', 'busy']);
const IS_VALUES = new Set(['working', 'broken', 'rated', 'unrated', 'favorite', 'available', 'unavailable', 'failed', 'played', 'partial']);
const KIND_VALUES = new Set(['avs', 'nerv', 'hud']);
const TIER_VALUES = new Set(['showcase', 'tuned', 'auto']);
const ENERGY_VALUES = new Set<string>(ENERGY);
const FIDELITY_VALUES = new Set(['full', 'partial']);
const MAX_QUERY = 1000;
// Characters inside quotes are hidden from the syntax scan by these private-use stand-ins and restored afterwards.
const HIDE: Readonly<Record<string, string>> = { '|': '\ue001', ':': '\ue002', '-': '\ue003', '!': '\ue004', '.': '\ue005' };
const SHOW: Readonly<Record<string, string>> = { '\ue001': '|', '\ue002': ':', '\ue003': '-', '\ue004': '!', '\ue005': '.' };
const restore = (s: string): string => s.replace(/[\ue001-\ue005]/g, c => SHOW[c]!);

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = '', quoted = false, started = false;
  for (const ch of text) {
    if (ch === '"') { quoted = !quoted; started = true; continue; }
    if (!quoted && /\s/.test(ch)) { if (started) tokens.push(current); current = ''; started = false; continue; }
    current += quoted ? HIDE[ch] ?? ch : ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

const UNIT: Readonly<Record<string, number>> = { k: 1024, kb: 1024, m: 1048576, mb: 1048576 };
const AGE: Readonly<Record<string, number>> = { d: 1, h: 1 / 24, w: 7, m: 30 };
/** One numeric comparison: `4`, `>=3`, `<2k`, `3..5`, `unrated`. Returns null when malformed. */
function parseRange(value: string, field: Field): Range | null {
  const text = value.trim();
  if (!text) return null;
  if (field === 'rating' && text === 'unrated') return { lo: 0, hi: 0 };
  const number = (s: string): number | null => {
    const m = /^(\d+(?:\.\d+)?)(kb|mb|k|m|d|h|w)?$/.exec(s);
    if (!m) return null;
    const unit = m[2];
    if (field === 'size') { if (unit && !(unit in UNIT)) return null; return Math.round(Number(m[1]) * (unit ? UNIT[unit]! : 1)); }
    if (field === 'played') { if (unit && !(unit in AGE)) return null; return Number(m[1]) * (unit ? AGE[unit]! : 1); }
    if (unit) return null;
    return Number(m[1]);
  };
  const dots = /^(.+?)\.\.(.+)$/.exec(text);
  if (dots) { const a = number(dots[1]!), b = number(dots[2]!); return a === null || b === null || a > b ? null : { lo: a, hi: b }; }
  const cmp = /^(>=|<=|>|<|=)?(.+)$/.exec(text);
  if (!cmp) return null;
  const x = number(cmp[2]!);
  if (x === null) return null;
  const step = field === 'played' ? 1e-9 : 1;
  switch (cmp[1]) {
    case '>': return { lo: x + step, hi: Infinity };
    case '>=': return { lo: x, hi: Infinity };
    case '<': return { lo: -Infinity, hi: x - step };
    case '<=': return { lo: -Infinity, hi: x };
    default: return { lo: x, hi: x };
  }
}

/** Total: never throws, whatever the input. Unknown `key:` prefixes are plain text; a malformed clause is noted and ignored. */
export function parseQuery(input: string): Query {
  const raw = typeof input === 'string' ? input.slice(0, MAX_QUERY) : '';
  const text: string[] = [], clauses: Clause[] = [], notes: string[] = [];
  for (const token of tokenize(raw)) {
    // A lone "-" or "!" is a half-typed exclusion, not a search for a dash: ignore it so the list never blanks mid-word.
    if (/^[-!]+$/.test(token)) continue;
    let body = token, neg = false;
    if (body.length > 1 && (body[0] === '-' || body[0] === '!')) { neg = true; body = body.slice(1); }
    const m = /^([A-Za-z]+):(.*)$/s.exec(body);
    const name = m ? m[1]!.toLowerCase() : '';
    const field = m && Object.hasOwn(FIELDS, name) ? FIELDS[name] : undefined;
    if (!m || !field) {
      const word = foldText(restore(body)).trim();
      if (!word) continue;
      if (neg) clauses.push({ neg: true, field: 'text', alts: [word], ranges: null, raw: restore(token) });
      else text.push(word);
      continue;
    }
    const shown = restore(token), value = m[2]!;
    if (!value) { notes.push(`ignored: ${shown} (no value)`); continue; }
    const parts = value.split('|').map(restore);
    if (NUMERIC.has(field)) {
      const ranges = parts.map(part => parseRange(part, field));
      if (ranges.some(r => r === null)) { notes.push(`ignored: ${shown}`); continue; }
      clauses.push({ neg, field, alts: [], ranges: ranges as Range[], raw: shown });
      continue;
    }
    const alts = parts.map(p => foldText(p).trim()).filter(Boolean);
    if (!alts.length) { notes.push(`ignored: ${shown} (no value)`); continue; }
    const allowed = field === 'is' ? IS_VALUES : field === 'kind' ? KIND_VALUES : field === 'tier' ? TIER_VALUES : field === 'energy' ? ENERGY_VALUES : field === 'fidelity' ? FIDELITY_VALUES : null;
    if (allowed && alts.some(a => !allowed.has(a))) { notes.push(`ignored: ${shown}`); continue; }
    clauses.push({ neg, field, alts, ranges: null, raw: shown });
  }
  return { raw, text, clauses, notes };
}

export interface QueryOptions { now?: number }
export interface QueryResult { ids: Int32Array; /** Indexed by catalog index (not by result position); null when the query has no plain text. */ score: Float32Array | null; notes: string[] }

function inRanges(value: number, ranges: readonly Range[]): boolean {
  for (const r of ranges) if (value >= r.lo && value <= r.hi) return true;
  return false;
}
/** 3 for a name prefix, 2 for a word start anywhere in the name, 1 for any other substring, 0.5 for a path-only match. */
function relevance(name: string, path: string, term: string): number {
  let at = name.indexOf(term);
  if (at < 0) return path.includes(term) ? 0.5 : 0;
  if (at === 0) return 3;
  for (; at >= 0; at = name.indexOf(term, at + 1)) if (/[^a-z0-9]/.test(name[at - 1]!)) return 2;
  return 1;
}

export function runQuery(rs: RecordSet, q: Query, universe: Int32Array | null, options: QueryOptions = {}): QueryResult {
  const notes = [...q.notes];
  const now = options.now ?? Date.now();
  const testers: ((i: number) => boolean)[] = [];
  const noStyle = !rs.taxon;
  const warned = new Set<string>();
  for (const c of q.clauses) {
    let test: (i: number) => boolean;
    switch (c.field) {
      case 'text': test = i => rs.nameKey[i]!.includes(c.alts[0]!) || rs.pathKey[i]!.includes(c.alts[0]!); break;
      case 'name': test = i => c.alts.some(a => rs.nameKey[i]!.includes(a)); break;
      case 'path': test = i => c.alts.some(a => rs.pathKey[i]!.includes(a.replace(/>/g, '/').replace(/\s*\/\s*/g, ' / '))); break;
      case 'pkg': test = i => c.alts.some(a => rs.pkgKey[i]!.includes(a)); break;
      case 'src': test = i => c.alts.some(a => rs.srcKey[i]!.includes(a)); break;
      case 'kind': test = i => c.alts.some(a => a === 'nerv' ? (rs.flags[i]! & FLAG.nerv) !== 0 : a === 'hud' ? (rs.flags[i]! & FLAG.hud) !== 0 : (rs.flags[i]! & (FLAG.nerv | FLAG.hud)) === 0); break;
      case 'tier': test = i => c.alts.some(a => rs.tier[i] === TIER[a as keyof typeof TIER]); break;
      case 'is': test = i => c.alts.some(a => {
        const f = rs.flags[i]!, r = rs.rating[i]!;
        switch (a) {
          case 'working': return (f & FLAG.notWorking) === 0;
          case 'broken': return (f & FLAG.notWorking) !== 0;
          case 'rated': return r >= 1;
          case 'unrated': return r === 0;
          case 'favorite': return r >= 4;
          case 'available': return (f & FLAG.unavailable) === 0;
          case 'unavailable': return (f & FLAG.unavailable) !== 0;
          case 'failed': return (f & FLAG.failed) !== 0;
          case 'played': return rs.plays[i]! > 0;
          default: return (f & FLAG.partial) !== 0;
        }
      }); break;
      case 'rating': test = i => inRanges(rs.rating[i]!, c.ranges!); break;
      case 'size': test = i => inRanges(rs.bytes[i]!, c.ranges!); break;
      case 'plays':
        if (!rs.hasStats && !warned.has('plays')) { warned.add('plays'); notes.push('no play history yet'); }
        test = i => inRanges(rs.plays[i]!, c.ranges!); break;
      case 'played':
        if (!rs.hasStats && !warned.has('plays')) { warned.add('plays'); notes.push('no play history yet'); }
        test = i => rs.plays[i]! > 0 && inRanges(Math.max(0, now - rs.lastPlayed[i]!) / 86400000, c.ranges!); break;
      case 'busy':
        if (noStyle && !warned.has('style')) { warned.add('style'); notes.push('no style data: style, energy, busy, author and fidelity match nothing'); }
        test = i => rs.busy !== null && rs.busy[i]! > 0 && inRanges(rs.busy[i]!, c.ranges!); break;
      case 'author':
        if (noStyle && !warned.has('style')) { warned.add('style'); notes.push('no style data: style, energy, busy, author and fidelity match nothing'); }
        test = i => rs.authorKey !== null && c.alts.some(a => rs.authorKey![i]!.includes(a)); break;
      case 'style':
        if (noStyle && !warned.has('style')) { warned.add('style'); notes.push('no style data: style, energy, busy, author and fidelity match nothing'); }
        test = i => rs.styleKey !== null && c.alts.some(a => rs.styleKey![i]!.includes(a)); break;
      case 'energy':
        if (noStyle && !warned.has('style')) { warned.add('style'); notes.push('no style data: style, energy, busy, author and fidelity match nothing'); }
        test = i => rs.energy !== null && c.alts.some(a => rs.energy![i] === ENERGY.indexOf(a as (typeof ENERGY)[number])); break;
      default: // fidelity
        if (noStyle && !warned.has('style')) { warned.add('style'); notes.push('no style data: style, energy, busy, author and fidelity match nothing'); }
        test = i => rs.taxon !== null && rs.taxon[i]! >= 0 && c.alts.some(a => a === 'partial' ? (rs.flags[i]! & FLAG.partial) !== 0 : (rs.flags[i]! & FLAG.partial) === 0);
    }
    testers.push(c.neg ? i => !test(i) : test);
  }
  const terms = q.text;
  const score = terms.length ? new Float32Array(rs.count) : null;
  const out: number[] = [];
  const total = universe ? universe.length : rs.count;
  for (let k = 0; k < total; k++) {
    const i = universe ? universe[k]! : k;
    if (i < 0 || i >= rs.count) continue;
    let s = 0, ok = true;
    for (let t = 0; t < terms.length; t++) {
      const term = terms[t]!, name = rs.nameKey[i]!, path = rs.pathKey[i]!;
      if (!name.includes(term) && !path.includes(term)) { ok = false; break; }
      s += relevance(name, path, term);
    }
    if (!ok) continue;
    for (let t = 0; t < testers.length; t++) if (!testers[t]!(i)) { ok = false; break; }
    if (!ok) continue;
    out.push(i);
    if (score) score[i] = s;
  }
  return { ids: Int32Array.from(out), score, notes };
}

// ---------------------------------------------------------------------------------------------------------------- sort

export type SortField = 'relevance' | 'name' | 'rating' | 'path' | 'package' | 'size' | 'recent' | 'plays' | 'random' | 'manual' | 'style' | 'energy' | 'busyness' | 'author' | 'fidelity';
export interface SortKey { key: SortField; dir: 'asc' | 'desc' }
export const SORT_FIELDS: readonly SortField[] = ['relevance', 'name', 'rating', 'path', 'package', 'size', 'recent', 'plays', 'random', 'manual', 'style', 'energy', 'busyness', 'author', 'fidelity'];
export const SORT_LABELS: Readonly<Record<SortField, string>> = {
  relevance: 'Relevance', name: 'Name', rating: 'Highest rating', path: 'Path', package: 'Package', size: 'File size', recent: 'Recently played',
  plays: 'Most played', random: 'Random', manual: 'Manual order', style: 'Style', energy: 'Energy', busyness: 'Busyness', author: 'Author', fidelity: 'Fidelity (partial last)',
};
/** The direction that reads naturally for a key: best or newest first for the "more is better" keys. */
export function defaultDirection(key: SortField): 'asc' | 'desc' { return key === 'relevance' || key === 'rating' || key === 'plays' || key === 'recent' ? 'desc' : 'asc'; }

function mix(seed: number, index: number): number {
  let h = Math.imul((seed ^ 0x9e3779b9) >>> 0, 0x85ebca6b) ^ Math.imul(index + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
const MISSING = 0x7fffffff;

/**
 * Total, stable order: up to three keys, then name, then catalog index. Keys whose data is missing (style without a
 * classification, manual order outside a manual folder) sort last in either direction. `score` is indexed by catalog index.
 */
export function sortIndices(rs: RecordSet, ids: Int32Array, spec: readonly SortKey[],
  ctx: { seed: number; score?: Float32Array | null; manual?: ReadonlyMap<number, number> }): Int32Array {
  const cmps: ((a: number, b: number) => number)[] = [];
  for (const { key, dir } of spec.slice(0, 3)) {
    const sign = dir === 'desc' ? -1 : 1;
    const value = ((): ((i: number) => number) | null => {
      switch (key) {
        case 'relevance': { const s = ctx.score; return s ? i => s[i]! : null; }
        case 'name': return i => rs.nameRank[i]!;
        case 'rating': return i => rs.rating[i]!;
        case 'path': return i => rs.pathRank[i]!;
        case 'package': return i => rs.pkgRank[i]!;
        case 'size': return i => rs.bytes[i]!;
        case 'recent': return i => rs.lastPlayed[i]!;
        case 'plays': return i => rs.plays[i]!;
        case 'random': { const seed = ctx.seed >>> 0; return i => mix(seed, i); }
        case 'manual': { const m = ctx.manual; return m ? i => m.get(i) ?? MISSING : null; }
        case 'style': return rs.taxon ? i => rs.taxon![i]! >= 0 ? rs.taxon![i]! : MISSING : null;
        case 'energy': return rs.energy ? i => rs.energy![i]! >= 0 ? rs.energy![i]! : MISSING : null;
        case 'busyness': return rs.busy ? i => rs.busy![i]! > 0 ? rs.busy![i]! : MISSING : null;
        case 'author': return rs.authorRank && rs.authorKey ? i => rs.authorKey![i] ? rs.authorRank![i]! : MISSING : null;
        default: return rs.taxon ? i => rs.taxon![i]! < 0 ? MISSING : (rs.flags[i]! & FLAG.partial) ? 1 : 0 : null;
      }
    })();
    if (!value) continue;
    const missingLast = key === 'style' || key === 'energy' || key === 'busyness' || key === 'author' || key === 'manual' || key === 'fidelity';
    cmps.push((a, b) => {
      const x = value(a), y = value(b);
      if (x === y) return 0;
      if (missingLast) { if (x === MISSING) return 1; if (y === MISSING) return -1; }
      return x < y ? -sign : sign;
    });
  }
  const result = Int32Array.from(ids);
  result.sort((a, b) => {
    for (let k = 0; k < cmps.length; k++) { const r = cmps[k]!(a, b); if (r) return r; }
    return rs.nameRank[a]! - rs.nameRank[b]! || a - b;
  });
  return result;
}

// ---------------------------------------------------------------------------------------------------------------- window

/**
 * The DOM slice of a fixed-row-height virtual list. When nothing is measurable (a hidden panel, a fake DOM) the first
 * `fallbackRows` rows are rendered so the list is never empty.
 */
export function visibleWindow(scrollTop: number, viewport: number, rowHeight: number, count: number, overscan = 6, fallbackRows = 60): { start: number; end: number; offset: number } {
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (!(viewport > 0) || !(rowHeight > 0) || !Number.isFinite(viewport) || !Number.isFinite(rowHeight)) return { start: 0, end: Math.min(total, fallbackRows), offset: 0 };
  const top = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const first = Math.min(total, Math.floor(top / rowHeight));
  const start = Math.max(0, Math.min(first - overscan, Math.max(0, total - 1)));
  const end = Math.min(total, Math.ceil((top + viewport) / rowHeight) + overscan);
  return { start, end: Math.max(start, end), offset: start * rowHeight };
}
