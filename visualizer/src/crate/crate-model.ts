// The preset crate's model: search, filter chips, favourites, recents, random
// and the CUE slot (ux-architect review §3.2/§3.3, wireframe §7b).
//
// Pure and DOM-free on purpose, so `tools/crate-check.ts` can drive it in Node.
// `crate.ts` is only a view over this.
//
// The one rule everything here serves: BROWSING NEVER TOUCHES THE LIVE OUTPUT.
// Searching, filtering, starring, cueing and "random in filter" only move
// state inside this object. The single path that reaches the renderer is
// `go()` / `commitCue()`, which call the host's `onGo` — and `ui.ts` wires that
// to the exact `onPick…` handlers the old `<select>`s call, so a crate commit
// and a select commit are the same live action.

import { flashFlagFor, type FlashFlag } from './flash-flags.ts';

export type CrateBank = 'bundled' | 'local' | 'personal';

export interface CrateSourceEntry {
  readonly id: string;
  readonly name: string;
  readonly collection?: string;
}

export interface CrateEntry {
  /** `${bank}:${id}` — unique across banks, and what favourites/recents store. */
  readonly key: string;
  readonly bank: CrateBank;
  readonly id: string;
  readonly name: string;
  readonly collection: string;
  readonly flash: FlashFlag | null;
  /** Lowercased `name collection`, precomputed so a keystroke over 3,400 rows is one pass of `includes`. */
  readonly haystack: string;
}

/** 'all' | 'favourites' | 'recent' | `collection:<label>`. */
export type CrateFilter = string;

export const CRATE_FILTER_ALL = 'all';
export const CRATE_FILTER_FAVOURITES = 'favourites';
export const CRATE_FILTER_RECENT = 'recent';

/** How many rows the view renders at once. Matches beyond this are counted, not drawn. */
export const CRATE_ROW_CAP = 200;
export const CRATE_RECENT_LIMIT = 24;

const BANK_LABEL: Record<CrateBank, string> = {
  bundled: 'bundled',
  local: 'Full local',
  personal: 'My AVS',
};

export function crateKey(bank: CrateBank, id: string): string {
  return `${bank}:${id}`;
}

export function crateBankLabel(bank: CrateBank): string {
  return BANK_LABEL[bank];
}

/**
 * Local catalog entries arrive without a collection. If the id is path-shaped
 * (`pack/sub/file`), the first segment is the pack, which is the most useful
 * chip a 3,400-entry list can offer; otherwise the bank label stands in.
 */
export function inferCollection(bank: CrateBank, entry: CrateSourceEntry): string {
  if (entry.collection) return entry.collection;
  if (bank === 'personal') return 'My AVS';
  if (bank === 'local') {
    const slash = entry.id.replace(/\\/g, '/').indexOf('/');
    return slash > 0 ? entry.id.slice(0, slash) : 'Full local';
  }
  return 'bundled';
}

export function makeCrateEntry(bank: CrateBank, source: CrateSourceEntry): CrateEntry {
  const collection = inferCollection(bank, source);
  return {
    key: crateKey(bank, source.id),
    bank,
    id: source.id,
    name: source.name,
    collection,
    flash: flashFlagFor({ bank, id: source.id, name: source.name, collection }),
    haystack: `${source.name} ${collection}`.toLowerCase(),
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface CrateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Favourites and recents, in `localStorage`.
 *
 * Every access is wrapped: storage throws in private windows, with blocked site
 * data, and when the quota is full. A crate that loses its stars on reload is
 * a nuisance; a crate that throws on construction is a panel that never draws.
 */
export class CratePrefs {
  readonly favourites: Set<string>;
  private recentKeys: string[];

  constructor(
    private readonly storage: CrateStorage | null,
    private readonly prefix = 'aaavs.crate.v1',
  ) {
    this.favourites = new Set(this.readList('favourites'));
    this.recentKeys = this.readList('recents').slice(0, CRATE_RECENT_LIMIT);
  }

  get recents(): readonly string[] { return this.recentKeys; }

  isFavourite(key: string): boolean { return this.favourites.has(key); }

  /** Returns the new state. */
  toggleFavourite(key: string): boolean {
    const next = !this.favourites.has(key);
    if (next) this.favourites.add(key);
    else this.favourites.delete(key);
    this.writeList('favourites', [...this.favourites]);
    return next;
  }

  /** Most recent first, deduplicated, bounded. */
  noteRecent(key: string): void {
    this.recentKeys = [key, ...this.recentKeys.filter((entry) => entry !== key)].slice(0, CRATE_RECENT_LIMIT);
    this.writeList('recents', this.recentKeys);
  }

  private readList(name: string): string[] {
    try {
      const raw = this.storage?.getItem(`${this.prefix}.${name}`);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
    } catch {
      return [];
    }
  }

  private writeList(name: string, values: readonly string[]): void {
    try { this.storage?.setItem(`${this.prefix}.${name}`, JSON.stringify(values)); }
    catch { /* private mode / quota: the in-memory state still works this session */ }
  }
}

/** `window.localStorage`, or null where touching it throws. */
export function browserCrateStorage(): CrateStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export interface CrateChip {
  readonly filter: CrateFilter;
  readonly label: string;
  readonly count: number;
}

/**
 * Every whitespace-separated token must appear somewhere in name + collection.
 * AND rather than OR because the performer types to NARROW: "unconed grid"
 * should find one preset, not every UnConeD preset plus every grid.
 */
export function matchesQuery(entry: CrateEntry, tokens: readonly string[]): boolean {
  for (const token of tokens) if (!entry.haystack.includes(token)) return false;
  return true;
}

export function queryTokens(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

export function filterCrate(
  entries: readonly CrateEntry[],
  text: string,
  filter: CrateFilter,
  prefs: { readonly favourites: ReadonlySet<string>; readonly recents: readonly string[] },
): CrateEntry[] {
  const tokens = queryTokens(text);
  if (filter === CRATE_FILTER_RECENT) {
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));
    const out: CrateEntry[] = [];
    for (const key of prefs.recents) {
      const entry = byKey.get(key);
      if (entry && matchesQuery(entry, tokens)) out.push(entry);
    }
    return out;
  }
  const collection = filter.startsWith('collection:') ? filter.slice('collection:'.length) : null;
  const out: CrateEntry[] = [];
  for (const entry of entries) {
    if (filter === CRATE_FILTER_FAVOURITES && !prefs.favourites.has(entry.key)) continue;
    if (collection !== null && entry.collection !== collection) continue;
    if (matchesQuery(entry, tokens)) out.push(entry);
  }
  return out;
}

/** Chips in a stable order: All, Favourites, Recent, then collections by first appearance. */
export function crateChips(
  entries: readonly CrateEntry[],
  prefs: { readonly favourites: ReadonlySet<string>; readonly recents: readonly string[] },
): CrateChip[] {
  const counts = new Map<string, number>();
  let favourites = 0;
  const keys = new Set<string>();
  for (const entry of entries) {
    counts.set(entry.collection, (counts.get(entry.collection) ?? 0) + 1);
    if (prefs.favourites.has(entry.key)) favourites++;
    keys.add(entry.key);
  }
  const recent = prefs.recents.filter((key) => keys.has(key)).length;
  return [
    { filter: CRATE_FILTER_ALL, label: 'All', count: entries.length },
    { filter: CRATE_FILTER_FAVOURITES, label: '★', count: favourites },
    { filter: CRATE_FILTER_RECENT, label: 'Recent', count: recent },
    ...[...counts].map(([label, count]) => ({ filter: `collection:${label}`, label, count })),
  ];
}

/**
 * Uniform pick from `pool`, avoiding `excludeKey` when there is any
 * alternative. `random` returns [0, 1); the view passes a crypto-backed one.
 */
export function pickRandomEntry(
  pool: readonly CrateEntry[],
  excludeKey: string | null,
  random: () => number,
): CrateEntry | null {
  if (pool.length === 0) return null;
  const candidates = pool.length > 1 && excludeKey !== null
    ? pool.filter((entry) => entry.key !== excludeKey)
    : pool;
  const list = candidates.length ? candidates : pool;
  const index = Math.min(list.length - 1, Math.floor(random() * list.length));
  return list[index] ?? null;
}

export function cryptoRandom(): number {
  const entropy = new Uint32Array(1);
  crypto.getRandomValues(entropy);
  return entropy[0]! / 0x1_0000_0000;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface CrateControllerOptions {
  readonly storage?: CrateStorage | null;
  /** The ONLY path to the live output. Must be the same handler the old selects call. */
  readonly onGo: (entry: CrateEntry) => void | Promise<void>;
  readonly random?: () => number;
}

export interface CrateView {
  readonly rows: readonly CrateEntry[];
  /** Matches before the render cap. */
  readonly matched: number;
  /** Every entry across every loaded bank. */
  readonly total: number;
  readonly chips: readonly CrateChip[];
}

export class CrateController {
  readonly prefs: CratePrefs;
  private readonly banks = new Map<CrateBank, readonly CrateEntry[]>();
  private all: readonly CrateEntry[] = [];
  private byKey = new Map<string, CrateEntry>();
  private text = '';
  private filterValue: CrateFilter = CRATE_FILTER_ALL;
  private cueKey: string | null = null;
  private liveKey: string | null = null;
  private readonly random: () => number;

  constructor(private readonly options: CrateControllerOptions) {
    this.prefs = new CratePrefs(options.storage ?? null);
    this.random = options.random ?? cryptoRandom;
  }

  /** Replace one bank's entries. Bank order in the combined list is bundled, personal, local. */
  setBank(bank: CrateBank, entries: readonly CrateSourceEntry[]): void {
    this.banks.set(bank, entries.map((entry) => makeCrateEntry(bank, entry)));
    const order: CrateBank[] = ['bundled', 'personal', 'local'];
    this.all = order.flatMap((name) => this.banks.get(name) ?? []);
    this.byKey = new Map(this.all.map((entry) => [entry.key, entry]));
    if (this.cueKey && !this.byKey.has(this.cueKey)) this.cueKey = null;
    if (this.filterValue.startsWith('collection:')
      && !this.all.some((entry) => `collection:${entry.collection}` === this.filterValue)) {
      this.filterValue = CRATE_FILTER_ALL;
    }
  }

  hasBank(bank: CrateBank): boolean { return this.banks.has(bank); }

  get query(): string { return this.text; }
  setQuery(text: string): void { this.text = text; }

  get filter(): CrateFilter { return this.filterValue; }
  setFilter(filter: CrateFilter): void { this.filterValue = filter; }

  entry(key: string): CrateEntry | null { return this.byKey.get(key) ?? null; }

  /** Everything the current search + chip matches, uncapped. */
  matches(): CrateEntry[] {
    return filterCrate(this.all, this.text, this.filterValue, this.prefs);
  }

  view(cap = CRATE_ROW_CAP): CrateView {
    const matched = this.matches();
    return {
      rows: matched.length > cap ? matched.slice(0, cap) : matched,
      matched: matched.length,
      total: this.all.length,
      chips: crateChips(this.all, this.prefs),
    };
  }

  get cued(): CrateEntry | null { return this.cueKey ? this.byKey.get(this.cueKey) ?? null : null; }
  get live(): CrateEntry | null { return this.liveKey ? this.byKey.get(this.liveKey) ?? null : null; }

  /** Stage without touching the output. Returns the cued entry, or null for an unknown key. */
  cue(key: string): CrateEntry | null {
    const entry = this.byKey.get(key) ?? null;
    if (entry) this.cueKey = entry.key;
    return entry;
  }

  clearCue(): void { this.cueKey = null; }

  /** Commit one entry live. Clears the cue only when it is the entry that went live. */
  async go(key: string): Promise<CrateEntry | null> {
    const entry = this.byKey.get(key);
    if (!entry) return null;
    await this.options.onGo(entry);
    this.liveKey = entry.key;
    if (this.cueKey === entry.key) this.cueKey = null;
    this.prefs.noteRecent(entry.key);
    return entry;
  }

  /** Commit the cue slot. A no-op returning null when nothing is cued. */
  async commitCue(): Promise<CrateEntry | null> {
    return this.cueKey ? this.go(this.cueKey) : null;
  }

  /** Cue (never go) a random entry from the current filter, avoiding what is live. */
  cueRandom(): CrateEntry | null {
    const entry = pickRandomEntry(this.matches(), this.liveKey, this.random);
    if (entry) this.cueKey = entry.key;
    return entry;
  }

  /** The host rendered something (from any path — crate, select, director, MIDI). */
  setLive(bank: CrateBank | null, id: string): void {
    this.liveKey = bank ? crateKey(bank, id) : null;
  }

  toggleFavourite(key: string): boolean { return this.prefs.toggleFavourite(key); }
}
