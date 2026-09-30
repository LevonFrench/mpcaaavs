import type { HudTitleMap, LocalAvsPreset, SourceInfo, SourceMap } from './avs/local-collection.ts';
import { TAXONOMY, isClassified, type TaxonMap } from './avs/preset-categories.ts';
import { HUD_PACK_LABELS, HUD_ROOT_LABEL, NERV_FOLDER_LABEL, canonicalPackLabel, packOrder } from './mpc-folder-defaults.ts';
import { FLAG, foldText, naturalKey, parseQuery, runQuery, type RecordSet } from './mpc-folder-query.ts';
import type { UserFolder } from './mpc-folder-store.ts';
/**
 * The virtual folder tree of the Preset Browser (docs/design/PRESET-BROWSER-V2.md 4). Pure and DOM-free.
 *
 *   AVS            By source (from the catalog's `occurrences` and the optional `sources.json`), then facets when data exists
 *   NERV           the scene set
 *   HUD packs      pack label > title folder (from the catalog `folder` hint `<pack label>/<title>`)
 *   Smart folders  dynamic queries over every kind
 *   My folders     the owner's folders (`withUserFolders`)
 *
 * A preset that occurs in several packages belongs to every folder of its occurrences and is counted once above them. Keys
 * are derived from data only (never from counts or from the display collapse), because they are persisted. The private
 * staging path is never read here or kept anywhere.
 */

export type NodeKind = 'root' | 'section' | 'group' | 'artist' | 'package' | 'dir' | 'bucket' | 'platform' | 'facet' | 'smart' | 'user';
export type SmartName = 'favorites' | 'rated' | 'unrated' | 'broken' | 'unavailable' | 'recent' | 'most-played';
/** Membership that depends on live ratings and marks, so it is evaluated against a `RecordSet` instead of stored. */
export type DynamicDef =
  | { readonly type: 'rating'; readonly value: number }
  | { readonly type: 'smart'; readonly name: SmartName }
  | { readonly type: 'query'; readonly query: string; readonly scope: string | null };

export interface FolderNode {
  readonly id: number;
  readonly key: string;
  label: string;
  readonly kind: NodeKind;
  parent: number;
  children: number[];
  /** Direct members, ascending catalog indices. */
  direct: Int32Array;
  /** Recursive unique members (memo); null until first asked, always null for a dynamic subtree. */
  members: Int32Array | null;
  /** Child ordering hint; equal hints fall back to natural label order. */
  hint: number;
  readonly def?: DynamicDef;
  /** True when this node or a descendant has a `def`, so its membership is never memoised on the node. */
  dynamic: boolean;
  /** Hide the row while it has no members (rating facets, rarely used smart folders). */
  hideEmpty?: boolean;
  /** Manual user folder: members in the owner's order (unresolvable hashes skipped) and how many hashes no longer resolve. */
  order?: Int32Array;
  missing?: number;
  /** The user folder's id, for `kind: 'user'`. */
  userId?: string;
}
export interface FolderTree {
  nodes: FolderNode[];
  roots: number[];
  byKey: Map<string, number>;
  /** Primary location node per catalog index (-1: none, for example an entry that is not in any source folder). */
  primary: Int32Array;
  /** Every source-folder node a preset is a direct member of. */
  locations: readonly (readonly number[])[];
  revision: number;
  /** Nodes below this id are static (built from the catalog); user folders are appended above it. */
  staticCount: number;
}
export const BUCKET_ABOVE = 60, FAVORITE_MINIMUM = 4;
export interface TreeInputs { sources?: SourceMap; taxa?: TaxonMap | null; user?: readonly UserFolder[]; titles?: HudTitleMap | null }

const EMPTY = new Int32Array(0);
let revisionCounter = 0;
const DAY_MS = 86400000;

const GROUPS: readonly (readonly [key: string, label: string])[] = [
  ['visbot-legacy', 'Visbot archive'], ['visbot-current', 'Visbot releases'], ['github', 'GitHub'], ['local-existing', 'Local picks'],
  ['author-pack', 'Author packs'], ['internet-archive', 'Internet Archive'],
];
const GROUP_LABEL = new Map(GROUPS);
const groupRank = (catalog: string): number => { const at = GROUPS.findIndex(g => g[0] === catalog); return at < 0 ? GROUPS.length : at; };

const KIT_PLATFORMS: Readonly<Record<string, string>> = { arcade: 'Arcade', neogeo: 'Neo Geo', nes: 'NES', genesis: 'Genesis', saturn: 'Saturn', ps1: 'PlayStation', pc: 'PC' };
/** Platform of a kit id from its trailing token, for HUD entries that carry no folder hint. Everything else is "Other". */
export function hudPlatform(kitId: string): string {
  const tokens = String(kitId).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) { const hit = Object.hasOwn(KIT_PLATFORMS, tokens[i]!) ? KIT_PLATFORMS[tokens[i]!] : undefined; if (hit) return hit; }
  return 'Other';
}

/** A key segment may contain any character but the separator. */
const kp = (segment: string): string => segment.replace(/\//g, '|');
const splitPath = (path: string): string[] => path.split(/[\\/]+/).filter(s => s && s !== '.');
const HEX12 = /^[0-9a-f]{12}$/i;
/** Drops a leading `_nested/<12 hex>` wrapper, which is an artefact of unpacking nested archives. */
function stripNested(parts: string[]): { parts: string[]; nested: boolean } {
  return parts.length > 2 && parts[0] === '_nested' && HEX12.test(parts[1]!) ? { parts: parts.slice(2), nested: true } : { parts, nested: false };
}
const stem = (fileName: string): string => fileName.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[-_ ]?unofficial$/i, '').trim();
function idLabel(id: string, catalog: string): string {
  const withoutGroup = id.startsWith(`${catalog}-`) ? id.slice(catalog.length + 1) : id;
  return withoutGroup.replace(/-[0-9a-f]{10}$/, '') || id;
}
function catalogOf(id: string, source: SourceInfo | undefined): string {
  if (source?.catalog) return source.catalog;
  for (const [key] of GROUPS) if (id.startsWith(`${key}-`)) return key;
  return 'other';
}

/** Splits a folder hint, keeping pack labels that themselves contain a slash (`8/16-bit Consoles`) as one segment. */
export function splitHudHint(folder: string): string[] {
  for (const label of HUD_PACK_LABELS) {
    if (label.includes('/') && (folder === label || folder.startsWith(`${label}/`))) return [label, ...folder.slice(label.length + 1).split('/').filter(Boolean)];
  }
  const segments = folder.split('/');
  const pack = canonicalPackLabel(segments[0] ?? '');
  if (pack) segments[0] = pack;
  return segments;
}
function hudSegments(p: LocalAvsPreset): string[] {
  if (p.folder) return splitHudHint(p.folder);
  const pack = p.hud?.pack ?? '';
  return [canonicalPackLabel(pack) ?? (pack || hudPlatform(p.hud?.id ?? ''))];
}

const TITLE_SEPARATORS: readonly string[] = [' \u00b7 ', ' / ', ' - ', ' \u2013 ', ' \u2014 ', ': '];
/**
 * The title that names a folder of scenes: the one title they all share, or else the longest leading part they share up to a
 * separator (`Game / Health`, `Game / Timer` name the folder `Game`). Null when they share nothing usable.
 */
export function sharedTitle(titles: readonly string[]): string | null {
  if (!titles.length) return null;
  const first = titles[0]!;
  if (titles.every(t => t === first)) return first || null;
  let best: string | null = null;
  for (const sep of TITLE_SEPARATORS) {
    for (let at = first.indexOf(sep); at >= 0; at = first.indexOf(sep, at + 1)) {
      if (at < 2) continue;
      const lead = first.slice(0, at);
      if (titles.every(t => t.startsWith(lead + sep)) && (best === null || lead.length > best.length)) best = lead;
    }
  }
  return best;
}

/** A bucket letter: `0-9`, `A`-`Z`, or `#` for anything else. */
export function letterOf(label: string): string {
  const c = foldText(label).trim().charAt(0).toUpperCase();
  return c >= 'A' && c <= 'Z' ? c : c >= '0' && c <= '9' ? '0-9' : '#';
}
const letterHint = (letter: string): number => letter === '0-9' ? 0 : letter === '#' ? 27 : letter.charCodeAt(0) - 64;

class Builder {
  nodes: FolderNode[] = [];
  lists: number[][] = [];
  byKey = new Map<string, number>();
  node(parent: number, key: string, label: string, kind: NodeKind, hint = 0, extra: { def?: DynamicDef; hideEmpty?: boolean; order?: Int32Array; missing?: number; userId?: string } = {}): number {
    const known = this.byKey.get(key);
    if (known !== undefined) return known;
    const id = this.nodes.length;
    this.nodes.push({ id, key, label, kind, parent, children: [], direct: EMPTY, members: null, hint, dynamic: !!extra.def, ...extra });
    this.lists.push([]);
    this.byKey.set(key, id);
    if (parent >= 0) this.nodes[parent]!.children.push(id);
    return id;
  }
  put(id: number, index: number): void { this.lists[id]!.push(index); }
}

const compareNodes = (nodes: readonly FolderNode[]) => (a: number, b: number): number => {
  const x = nodes[a]!, y = nodes[b]!;
  if (x.hint !== y.hint) return x.hint - y.hint;
  const nx = naturalKey(x.label), ny = naturalKey(y.label);
  return nx < ny ? -1 : nx > ny ? 1 : x.key < y.key ? -1 : x.key > y.key ? 1 : 0;
};

interface PackageInfo { id: string; catalog: string; group: string; artist: string | null; label: string; wrapper: string | null; fileName?: string }

/**
 * Builds the whole tree from the catalog. Malformed provenance is already dropped by the catalog parser; an entry with no
 * usable origin and no folder hint lands in "By source / Unsorted", so every AVS preset is in at least one leaf.
 */
export function buildFolderTree(catalog: readonly LocalAvsPreset[], inputs: TreeInputs = {}): FolderTree {
  const n = catalog.length;
  const b = new Builder();
  const primary = new Int32Array(n).fill(-1);
  const locations: number[][] = new Array(n);
  const sources = inputs.sources ?? new Map<string, SourceInfo>();
  const allAvs: number[] = [], allNerv: number[] = [], allHud: number[] = [];
  catalog.forEach((p, i) => { (p.kind === 'nerv' ? allNerv : p.kind === 'hud' ? allHud : allAvs).push(i); locations[i] = []; });

  const roots: number[] = [];
  const avsRoot = allAvs.length ? b.node(-1, 'avs', 'AVS', 'root', 0) : -1;
  const nervRoot = allNerv.length ? b.node(-1, 'nerv', NERV_FOLDER_LABEL, 'root', 1) : -1;
  const hudRoot = allHud.length ? b.node(-1, 'hud', HUD_ROOT_LABEL, 'root', 2) : -1;
  for (const r of [avsRoot, nervRoot, hudRoot]) if (r >= 0) roots.push(r);

  // --- AVS by source. Pass 1: which packages wrap everything in one directory, and what to call each package.
  const wrappers = new Map<string, { flat: boolean; first: Set<string> }>();
  for (const i of allAvs) {
    const p = catalog[i]!;
    if (p.folder || !p.origins) continue;
    for (const o of p.origins) {
      const { parts } = stripNested(splitPath(o.path));
      const w = wrappers.get(o.pkg) ?? { flat: false, first: new Set<string>() };
      if (parts.length < 2) w.flat = true; else w.first.add(parts[0]!);
      wrappers.set(o.pkg, w);
    }
  }
  const packages = new Map<string, PackageInfo>();
  const packageOf = (id: string): PackageInfo => {
    const known = packages.get(id);
    if (known) return known;
    const source = sources.get(id), w = wrappers.get(id);
    const catalogKey = catalogOf(id, source);
    const wrapper = w && !w.flat && w.first.size === 1 ? [...w.first][0]! : null;
    const fromFile = source?.fileName ? stem(source.fileName) : '';
    const info: PackageInfo = {
      id, catalog: catalogKey, group: GROUP_LABEL.has(catalogKey) ? catalogKey : 'other',
      artist: source?.artist ?? source?.repository ?? source?.release ?? null,
      label: wrapper ?? (fromFile || idLabel(id, catalogKey)), wrapper, ...(source?.fileName ? { fileName: source.fileName } : {}),
    };
    packages.set(id, info);
    return info;
  };
  if (allAvs.length) {
    const seen = new Set<string>();
    for (const i of allAvs) for (const o of catalog[i]!.origins ?? []) if (!catalog[i]!.folder && !seen.has(o.pkg)) { seen.add(o.pkg); packageOf(o.pkg); }
    // Sibling packages that would show the same label get a short id suffix.
    const byLabel = new Map<string, PackageInfo[]>();
    for (const info of packages.values()) {
      const at = `${info.group}\u0000${info.artist ?? ''}\u0000${info.label}`;
      const list = byLabel.get(at) ?? [];
      list.push(info); byLabel.set(at, list);
    }
    for (const list of byLabel.values()) if (list.length > 1) for (const info of list) info.label = `${info.label} · ${info.id.slice(-4)}`;
  }
  let srcRoot = -1;
  const src = (): number => srcRoot >= 0 ? srcRoot : (srcRoot = b.node(avsRoot, 'avs/src', 'By source', 'section', 0));
  for (const i of allAvs) {
    const p = catalog[i]!;
    const nodesFor: number[] = [];
    let best: { node: number; rank: readonly number[] } | null = null;
    if (p.folder) {
      const segments = p.folder.split('/');
      let at = src(), key = 'avs/src';
      segments.forEach((seg, depth) => { key += `/${depth === 0 ? 'h:' : ''}${kp(seg)}`; at = b.node(at, key, seg, depth === 0 ? 'group' : 'dir', depth === 0 ? GROUPS.length + 1 : 0); });
      nodesFor.push(at); best = { node: at, rank: [0] };
    } else if (p.origins?.length) {
      for (let order = 0; order < p.origins.length; order++) {
        const o = p.origins[order]!;
        const info = packageOf(o.pkg);
        const { parts, nested } = stripNested(splitPath(o.path));
        const dirs = parts.slice(0, -1);
        let at = b.node(src(), `avs/src/c:${info.group}`, GROUP_LABEL.get(info.group) ?? 'Other sources', 'group', groupRank(info.group));
        if (info.artist) at = b.node(at, `avs/src/c:${info.group}/a:${kp(info.artist)}`, info.artist, 'artist');
        let key = `${b.nodes[at]!.key}/p:${kp(o.pkg)}`;
        at = b.node(at, key, info.label, 'package');
        for (const d of info.wrapper ? dirs.slice(1) : dirs) { key += `/${kp(d)}`; at = b.node(at, key, d, 'dir'); }
        if (!nodesFor.includes(at)) nodesFor.push(at);
        const rank = [groupRank(info.group), nested ? 1 : 0, parts.length, order];
        if (!best || compareRank(rank, best.rank) < 0) best = { node: at, rank };
      }
    } else {
      const at = b.node(src(), 'avs/src/unsorted', 'Unsorted', 'group', 99);
      nodesFor.push(at); best = { node: at, rank: [99] };
    }
    for (const id of nodesFor) b.put(id, i);
    locations[i] = nodesFor;
    primary[i] = best!.node;
  }

  // --- NERV: flat, or under the entry's folder hint.
  for (const i of allNerv) {
    const p = catalog[i]!;
    let at = nervRoot, key = 'nerv';
    if (p.folder) for (const seg of p.folder.split('/')) { key += `/${kp(seg)}`; at = b.node(at, key, seg, 'dir'); }
    b.put(at, i); locations[i] = [at]; primary[i] = at;
  }
  // --- HUD packs: pack label, then the hint's further segments.
  for (const i of allHud) {
    const p = catalog[i]!;
    let at = hudRoot, key = 'hud';
    hudSegments(p).forEach((seg, depth) => {
      key += `/${kp(seg)}`;
      at = b.node(at, key, seg, depth === 0 ? 'platform' : 'dir', depth === 0 ? packOrder(seg) : 0);
    });
    b.put(at, i); locations[i] = [at]; primary[i] = at;
  }
  // Optional local title overlay: a folder holding one scene (or scenes sharing one title) is named by the owner's title.
  // Keys keep coming from the neutral hint, so persisted options never depend on the overlay.
  if (inputs.titles && hudRoot >= 0) {
    for (const node of b.nodes) {
      if (node.kind !== 'dir' || !node.key.startsWith('hud/')) continue;
      const list = b.lists[node.id]!;
      if (!list.length) continue;
      const names: string[] = [];
      let all = true;
      for (const i of list) { const t = inputs.titles.get(catalog[i]!.hud?.id ?? ''); if (t === undefined) { all = false; break; } names.push(t); }
      const named = all ? sharedTitle(names) : null;
      if (named) node.label = named;
    }
  }

  // --- Facets (only where data exists).
  if (avsRoot >= 0) {
    const taxa = inputs.taxa;
    if (taxa) {
      const style = new Map<string, number[]>(), energy = new Map<string, number[]>(), busy = new Map<number, number[]>(), author = new Map<string, number[]>();
      const push = <K>(map: Map<K, number[]>, key: K, i: number) => { const l = map.get(key); if (l) l.push(i); else map.set(key, [i]); };
      const unclassified: number[] = [];
      for (const i of allAvs) {
        const t = taxa.get(catalog[i]!.sha256);
        // The joined map can hold neutral placeholders for presets the file does not cover; those carry no energy, busyness or author.
        if (!t || !isClassified(t)) { unclassified.push(i); continue; }
        if (TAXONOMY.some(c => c.id === t.c)) push(style, t.c, i);
        push(energy, t.e, i); push(busy, t.b, i);
        if (t.a) push(author, t.a.slice(0, 80), i);
      }
      if (style.size) {
        const section = b.node(avsRoot, 'avs/style', 'By style', 'section', 1);
        if (unclassified.length) { const id = b.node(section, 'avs/style/unclassified', 'Unclassified', 'facet', 99); for (const i of unclassified) b.put(id, i); }
        TAXONOMY.forEach((c, at) => {
          const list = style.get(c.id);
          if (!list) return;
          const family = b.node(section, `avs/style/${kp(c.family.toLowerCase())}`, c.family, 'facet', TAXONOMY.findIndex(x => x.family === c.family));
          const id = b.node(family, `avs/style/${kp(c.family.toLowerCase())}/${c.id}`, c.label, 'facet', at);
          for (const i of list) b.put(id, i);
        });
      }
      const fixed = (title: string, key: string, hint: number, labels: readonly (readonly [string, string, number[] | undefined])[]) => {
        if (!labels.some(l => l[2]?.length)) return;
        const section = b.node(avsRoot, key, title, 'section', hint);
        labels.forEach(([slug, label, list], at) => { if (!list?.length) return; const id = b.node(section, `${key}/${slug}`, label, 'facet', at); for (const i of list) b.put(id, i); });
      };
      fixed('By energy', 'avs/energy', 2, (['calm', 'steady', 'driving', 'intense'] as const).map(e => [e, e[0]!.toUpperCase() + e.slice(1), energy.get(e)] as const));
      fixed('By busyness', 'avs/busy', 3, ([1, 2, 3, 4, 5] as const).map(v => [String(v), `Busyness ${v}`, busy.get(v)] as const));
      if (author.size) {
        const section = b.node(avsRoot, 'avs/author', 'By author', 'section', 4);
        for (const [name, list] of author) { const id = b.node(section, `avs/author/${kp(name)}`, name, 'facet'); for (const i of list) b.put(id, i); }
      }
    }
    const rating = b.node(avsRoot, 'avs/rating', 'By rating', 'section', 5, { hideEmpty: true });
    for (let v = 5; v >= 0; v--) b.node(rating, `avs/rating/${v}`, v ? `${v} star${v > 1 ? 's' : ''}` : 'Unrated', 'facet', 5 - v, { def: { type: 'rating', value: v }, hideEmpty: true });
  }
  // --- Smart folders (always present) and the empty "My folders" root.
  const smart = b.node(-1, 'smart', 'Smart folders', 'section', 3);
  const smarts: readonly (readonly [SmartName, string, boolean])[] = [
    ['favorites', 'Favorites', false], ['rated', 'Rated', false], ['unrated', 'Unrated', false], ['broken', 'Marked not working', true],
    ['unavailable', 'Unavailable', true], ['recent', 'Recently played', true], ['most-played', 'Most played', true],
  ];
  smarts.forEach(([name, label, hide], at) => b.node(smart, `smart:${name}`, label, 'smart', at, { def: { type: 'smart', name }, hideEmpty: hide }));
  const userRoot = b.node(-1, 'user', 'My folders', 'section', 4);
  roots.push(smart, userRoot);

  // --- Buckets, ordering and final arrays.
  const wide = b.nodes.length;
  for (let id = 0; id < wide; id++) bucketize(b, catalog, id);
  const order = compareNodes(b.nodes);
  for (const node of b.nodes) node.children.sort(order);
  for (const node of b.nodes) node.direct = uniqueSorted(b.lists[node.id]!);
  markDynamic(b.nodes);
  const avsNode = avsRoot >= 0 ? b.nodes[avsRoot]! : null;
  if (avsNode) avsNode.members = Int32Array.from(allAvs);
  const tree: FolderTree = { nodes: b.nodes, roots, byKey: b.byKey, primary, locations, revision: ++revisionCounter, staticCount: b.nodes.length };
  return inputs.user?.length ? withUserFolders(tree, inputs.user, new Map(catalog.map((p, i) => [p.sha256, i] as const))) : tree;
}

function compareRank(a: readonly number[], b: readonly number[]): number {
  for (let k = 0; k < Math.max(a.length, b.length); k++) { const d = (a[k] ?? 0) - (b[k] ?? 0); if (d) return d; }
  return 0;
}
function uniqueSorted(list: readonly number[]): Int32Array {
  if (!list.length) return EMPTY;
  return Int32Array.from(new Set(list)).sort();
}
function markDynamic(nodes: readonly FolderNode[]): void {
  const done = new Set<number>();
  const visit = (id: number): boolean => {
    const node = nodes[id]!;
    if (done.has(id)) return node.dynamic;
    done.add(id);
    let dynamic = !!node.def;
    for (const c of node.children) if (visit(c)) dynamic = true;
    node.dynamic = dynamic;
    return dynamic;
  };
  for (const node of nodes) visit(node.id);
}

/**
 * Wide nodes get letter buckets between them and their children: more than 60 child nodes, or (inside HUD packs) more than 60
 * direct scenes, in at least three distinct first-letter groups. Keys of the moved children do not change.
 */
function bucketize(b: Builder, catalog: readonly LocalAvsPreset[], id: number): void {
  const node = b.nodes[id]!;
  if (node.kind === 'bucket') return;
  const hudInside = node.key === 'hud' || node.key.startsWith('hud/');
  const childrenWide = node.children.length > BUCKET_ABOVE;
  const directList = b.lists[id]!;
  const directsWide = hudInside && node.kind !== 'root' && new Set(directList).size > BUCKET_ABOVE;
  if (!childrenWide && !directsWide) return;
  const letters = new Set<string>();
  if (childrenWide) for (const c of node.children) letters.add(letterOf(b.nodes[c]!.label));
  if (directsWide) for (const i of directList) letters.add(letterOf(catalog[i]!.name));
  if (letters.size < 3) return;
  const buckets = new Map<string, number>();
  const bucket = (letter: string): number => {
    let at = buckets.get(letter);
    if (at === undefined) { at = b.node(id, `${node.key}/#${letter}`, letter, 'bucket', letterHint(letter)); buckets.set(letter, at); }
    return at;
  };
  if (childrenWide) {
    const kids = node.children.filter(c => b.nodes[c]!.kind !== 'bucket');
    node.children = node.children.filter(c => b.nodes[c]!.kind === 'bucket');
    for (const c of kids) { const target = bucket(letterOf(b.nodes[c]!.label)); b.nodes[c]!.parent = target; b.nodes[target]!.children.push(c); }
  }
  if (directsWide) {
    for (const i of new Set(directList)) b.put(bucket(letterOf(catalog[i]!.name)), i);
    b.lists[id] = [];
  }
}

// ---------------------------------------------------------------------------------------------------- user folders

/**
 * Returns a tree with the owner's folders appended under "My folders". The static part is shared, not rebuilt. A manual
 * folder keeps its own order (hashes that no longer resolve are counted as missing, never dropped from the file); a smart
 * folder is a saved search evaluated against the live records.
 */
export function withUserFolders(tree: FolderTree, user: readonly UserFolder[], hashIndex: ReadonlyMap<string, number>): FolderTree {
  const nodes = tree.nodes.slice(0, tree.staticCount);
  const rootId = tree.byKey.get('user');
  if (rootId === undefined) return tree;
  const byKey = new Map<string, number>();
  for (const [key, id] of tree.byKey) if (id < tree.staticCount) byKey.set(key, id);
  const root = { ...nodes[rootId]!, children: [] as number[], dynamic: false };
  nodes[rootId] = root;
  const created = new Map<string, number>();
  const add = (f: UserFolder, parent: number): number => {
    const id = nodes.length, key = `user:${f.id}`;
    const base: FolderNode = { id, key, label: f.name, kind: 'user', parent, children: [], direct: EMPTY, members: null, hint: 0, dynamic: false, userId: f.id };
    if (f.kind === 'manual') {
      const order: number[] = [];
      let missing = 0;
      for (const hash of f.presets ?? []) { const at = hashIndex.get(hash); if (at === undefined) missing++; else order.push(at); }
      base.order = Int32Array.from(order); base.missing = missing;
      base.direct = uniqueSorted(order);
    } else {
      (base as { def?: DynamicDef }).def = { type: 'query', query: f.query ?? '', scope: f.scope ?? null };
      base.dynamic = true;
    }
    nodes.push(base); byKey.set(key, id); created.set(f.id, id);
    nodes[parent]!.children.push(id);
    return id;
  };
  // Parents first: a folder is added after its parent, whatever order the file lists them in.
  const pending = [...user];
  for (let guard = 0; pending.length && guard <= user.length; guard++) {
    for (let k = 0; k < pending.length;) {
      const f = pending[k]!;
      const parent = f.parent === null ? rootId : created.get(f.parent);
      if (parent === undefined) { k++; continue; }
      add(f, parent); pending.splice(k, 1);
    }
  }
  const order = compareNodes(nodes);
  for (const node of nodes) if (node.kind === 'user' || node.id === rootId) node.children.sort(order);
  markDynamic(nodes);
  return { ...tree, nodes, byKey, revision: ++revisionCounter };
}

// ---------------------------------------------------------------------------------------------------- membership

let stamp = new Uint32Array(0), generation = 0;
/** Ascending unique union of several ascending arrays. */
function union(parts: readonly Int32Array[], count: number): Int32Array {
  const live = parts.filter(p => p.length);
  if (live.length === 0) return EMPTY;
  if (live.length === 1) return live[0]!;
  if (stamp.length < count) { stamp = new Uint32Array(count); generation = 0; }
  if (++generation >= 0xfffffff0) { stamp.fill(0); generation = 1; }
  const out: number[] = [];
  for (const part of live) for (let k = 0; k < part.length; k++) { const i = part[k]!; if (i < count && stamp[i] !== generation) { stamp[i] = generation; out.push(i); } }
  return Int32Array.from(out).sort();
}

function ownDynamic(tree: FolderTree, node: FolderNode, rs: RecordSet, depth: number): Int32Array {
  const def = node.def!;
  const out: number[] = [];
  if (def.type === 'rating') {
    for (let i = 0; i < rs.count; i++) if ((rs.flags[i]! & (FLAG.nerv | FLAG.hud)) === 0 && rs.rating[i] === def.value) out.push(i);
  } else if (def.type === 'smart') {
    const now = Date.now();
    for (let i = 0; i < rs.count; i++) {
      const r = rs.rating[i]!, f = rs.flags[i]!;
      const hit = def.name === 'favorites' ? r >= FAVORITE_MINIMUM : def.name === 'rated' ? r >= 1 : def.name === 'unrated' ? r === 0 : def.name === 'broken' ? (f & FLAG.notWorking) !== 0
        : def.name === 'unavailable' ? (f & (FLAG.unavailable | FLAG.failed)) !== 0
        : def.name === 'recent' ? rs.plays[i]! > 0 && now - rs.lastPlayed[i]! <= 30 * DAY_MS : rs.plays[i]! > 0;
      if (hit) out.push(i);
    }
  } else {
    let universe: Int32Array | null = null;
    if (def.scope) {
      const scope = tree.byKey.get(def.scope);
      if (scope === undefined || depth > 6) return EMPTY;
      universe = membersOf(tree, tree.nodes[scope]!, rs, depth + 1);
    }
    return runQuery(rs, parseQuery(def.query), universe).ids.slice().sort();
  }
  return Int32Array.from(out);
}

const memos = new WeakMap<FolderNode, { rs: RecordSet; version: number; ids: Int32Array }>();
function membersOf(tree: FolderTree, node: FolderNode, rs: RecordSet, depth: number): Int32Array {
  if (depth > 8) return EMPTY;
  if (node.members) return node.members;
  if (node.dynamic) {
    const memo = memos.get(node);
    if (memo && memo.rs === rs && memo.version === rs.version) return memo.ids;
  }
  const parts: Int32Array[] = [node.def ? ownDynamic(tree, node, rs, depth) : node.direct];
  for (const c of node.children) parts.push(membersOf(tree, tree.nodes[c]!, rs, depth + 1));
  const ids = union(parts, rs.count);
  if (node.dynamic) memos.set(node, { rs, version: rs.version, ids }); else node.members = ids;
  return ids;
}

/** Recursive, unique, ascending catalog indices. */
export function folderMembers(tree: FolderTree, id: number, rs: RecordSet): Int32Array {
  const node = tree.nodes[id];
  return node ? membersOf(tree, node, rs, 0) : EMPTY;
}
/** Members that sit directly in this folder (a smart folder's matches, a manual folder's own list), ascending. */
export function directMembers(tree: FolderTree, id: number, rs: RecordSet): Int32Array {
  const node = tree.nodes[id];
  if (!node) return EMPTY;
  return node.def ? ownDynamic(tree, node, rs, 0) : node.direct;
}
/** A manual folder's own order as `catalog index -> position`, for the Manual sort. */
export function manualOrder(tree: FolderTree, id: number): Map<number, number> {
  const map = new Map<number, number>();
  const order = tree.nodes[id]?.order;
  if (order) order.forEach((index, at) => { if (!map.has(index)) map.set(index, at); });
  return map;
}

// ---------------------------------------------------------------------------------------------------- rows

export interface TreeRow {
  id: number; key: string; depth: number; label: string; count: number; expanded: boolean | null; playing: boolean;
  /** Keys of the merged chain, top to bottom (`key` is the last), so a view can highlight a folder that is drawn inside a merged row. */
  chain: string[];
}
const MERGEABLE: ReadonlySet<NodeKind> = new Set<NodeKind>(['group', 'artist', 'package', 'dir', 'platform']);

/**
 * The visible rows. A node with exactly one child and no direct members is drawn merged with that child ("a > b"); the row's
 * key is the bottom node's, so selection, expansion and saved options follow the bottom node, whose membership is identical.
 */
export function treeRows(tree: FolderTree, expanded: ReadonlySet<string>, playingKey: string | null, rs: RecordSet): TreeRow[] {
  const rows: TreeRow[] = [];
  const hidden = (node: FolderNode): boolean => {
    if (node.hideEmpty && membersOf(tree, node, rs, 0).length === 0) return true;
    return false;
  };
  const visibleKids = (node: FolderNode): FolderNode[] => node.children.map(c => tree.nodes[c]!).filter(c => !hidden(c));
  const visit = (id: number, depth: number): void => {
    let node = tree.nodes[id]!;
    if (hidden(node)) return;
    const labels = [node.label], keys = [node.key];
    for (;;) {
      const kids = visibleKids(node);
      if (MERGEABLE.has(node.kind) && kids.length === 1 && node.direct.length === 0 && !node.def) { node = kids[0]!; labels.push(node.label); keys.push(node.key); } else break;
    }
    const kids = visibleKids(node);
    const open = kids.length ? expanded.has(node.key) : null;
    rows.push({ id: node.id, key: node.key, depth, label: labels.join(' > '), count: membersOf(tree, node, rs, 0).length, expanded: open, playing: playingKey !== null && keys.includes(playingKey), chain: keys });
    if (open) for (const k of kids) visit(k.id, depth + 1);
  };
  for (const r of tree.roots) visit(r, 0);
  return rows;
}

export function locate(tree: FolderTree, index: number): { primary: number; others: number[] } {
  const primary = tree.primary[index] ?? -1;
  return { primary, others: (tree.locations[index] ?? []).filter(id => id !== primary) };
}
export function pathLabels(tree: FolderTree, id: number): string[] {
  const labels: string[] = [];
  for (let at = id, guard = 0; at >= 0 && guard < 64; at = tree.nodes[at]?.parent ?? -1, guard++) labels.unshift(tree.nodes[at]!.label);
  return labels;
}
/** Keys of every ancestor of a folder, root first, so a view can expand the path to it. */
export function ancestorKeys(tree: FolderTree, key: string): string[] {
  const keys: string[] = [];
  let at = tree.byKey.get(key);
  for (let guard = 0; at !== undefined && guard < 64; guard++) { const parent = tree.nodes[at]!.parent; if (parent < 0) break; keys.unshift(tree.nodes[parent]!.key); at = parent; }
  return keys;
}
/**
 * The label that selects a folder's built-in playback default: the HUD pack an ancestor names, the HUD root, or NERV.
 * Anything else has no built-in default and keeps the live settings.
 */
export function defaultLabelFor(tree: FolderTree, id: number): string | null {
  for (let at = id, guard = 0; at >= 0 && guard < 64; at = tree.nodes[at]?.parent ?? -1, guard++) {
    const node = tree.nodes[at]!;
    if (node.kind === 'platform' && node.key.startsWith('hud/')) return canonicalPackLabel(node.label) ?? HUD_ROOT_LABEL;
    if (node.key === 'hud') return HUD_ROOT_LABEL;
    if (node.key === 'nerv') return NERV_FOLDER_LABEL;
  }
  return null;
}
