import type { LocalAvsPreset } from './avs/local-collection.ts';
import { HUD_ROOT_LABEL, NERV_FOLDER_LABEL, builtinDefault, CLASSIC_STYLES } from './mpc-folder-defaults.ts';
import { defaultLabelFor, directMembers, folderMembers, manualOrder, type FolderTree } from './mpc-folders.ts';
import { FLAG, sortIndices, type RecordSet, type SortKey } from './mpc-folder-query.ts';
import type { FolderPlayOptions } from './mpc-folder-store.ts';
import { defaultSceneTiming, parseSceneTiming, type SceneTiming } from './mpc-scene-clock.ts';
import { parseSettings, type SetupSettings } from './mpc-setups.ts';
import { eligiblePresets } from './mpc-preset-eligibility.ts';
/**
 * Play folder (docs/design/PRESET-BROWSER-V2.md 8). `planFolderPlay` turns a folder, or a list of search results, into an
 * ordered plan the host activates as a transient in-memory setup. That setup is not subject to the 500-preset cap of saved
 * setups (the cap lives only in `parseSetups`, which this path never calls); the bound is the catalog size. The song clock
 * stays off for AVS folders because an AVS scene switch pays the preset fetch and worker start-up at the boundary; folders of
 * scene presets (NERV, HUD) may use it. Everything here is pure, so the host tests need no DOM.
 */

export type PlaySource = { kind: 'library' } | { kind: 'setup'; label: string } | { kind: 'folder'; key: string; label: string; total: number };

export interface FolderPlayPlan {
  ok: true;
  key: string;
  label: string;
  /** Catalog indices in play order. Members marked not working stay in the order; the live selection skips them. */
  order: number[];
  /** Members before filtering (for "756 presets"). */
  total: number;
  skipped: { unavailable: number; missing: number; partial: number };
  /** Catalog index to start with, when it is part of the order. */
  startAt: number | null;
  /** The playback bundle to apply, or null to keep the live settings. */
  settings: SetupSettings | null;
  /** The scene clock to apply, or null to leave it off. */
  timing: SceneTiming | null;
  /** Where the settings came from: the folder's saved bundle, the pack's built-in default, or the live settings. */
  options: 'saved' | 'builtin' | 'live';
  /** A short neutral description of the built-in default, empty otherwise. */
  note: string;
}
export type FolderPlayFailure = { ok: false; reason: string };

export interface FolderPlayRequest {
  key: string;
  label: string;
  recursive: boolean;
  sort: readonly SortKey[];
  /** Play exactly these catalog indices in this order (a search or filter result) instead of the folder. */
  results?: Int32Array | null;
  startAt?: number | null;
  saved?: FolderPlayOptions | null;
  /** The "Use folder options" switch. Off keeps the live settings and leaves the clock off. */
  useSaved: boolean;
  seed: number;
  skipPartial?: boolean;
  /** The trusted live tempo, used as the scene clock's tempo for a built-in default; 120 when unknown. */
  bpm?: number | null;
  /** Number of named transition styles this build has (`TRANSITIONS.length`); a default never picks an unnamed style. */
  styles?: number;
}

const fail = (reason: string): FolderPlayFailure => ({ ok: false, reason });
function keyHash(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function ghostCount(tree: FolderTree, id: number, recursive: boolean): number {
  const node = tree.nodes[id];
  if (!node) return 0;
  let n = node.missing ?? 0;
  if (recursive) for (const c of node.children) n += ghostCount(tree, c, true);
  return n;
}

/** The order a folder plays in when the owner chose none: its own order for a manual folder, else path, then name. */
export function defaultSort(tree: FolderTree, id: number): SortKey[] {
  const node = tree.nodes[id];
  if (node?.order) return [{ key: 'manual', dir: 'asc' }];
  if (node?.kind === 'smart' || node?.def) return [{ key: 'name', dir: 'asc' }];
  return [{ key: 'path', dir: 'asc' }, { key: 'name', dir: 'asc' }];
}

export function planFolderPlay(tree: FolderTree, rs: RecordSet, catalog: readonly LocalAvsPreset[], request: FolderPlayRequest): FolderPlayPlan | FolderPlayFailure {
  const id = tree.byKey.get(request.key);
  let ids: Int32Array, total: number, missing = 0;
  if (request.results) {
    const seen = new Set<number>(), kept: number[] = [];
    for (const i of request.results) if (Number.isInteger(i) && i >= 0 && i < catalog.length && !seen.has(i)) { seen.add(i); kept.push(i); }
    ids = Int32Array.from(kept); total = ids.length;
  } else {
    if (id === undefined) return fail('That folder no longer exists.');
    const members = request.recursive ? folderMembers(tree, id, rs) : directMembers(tree, id, rs);
    total = members.length;
    missing = ghostCount(tree, id, request.recursive);
    const sort = request.sort.length ? request.sort : defaultSort(tree, id);
    ids = sortIndices(rs, members, sort, { seed: request.seed, manual: manualOrder(tree, id) });
  }
  const skipPartial = request.skipPartial ?? request.saved?.skipPartial ?? false;
  const order: number[] = [];
  let unavailable = 0, partial = 0, scenes = 0, nerv = 0, hud = 0;
  for (const i of ids) {
    const p = catalog[i];
    if (!p) continue;
    if (!p.autoEligible) { unavailable++; continue; }
    if (skipPartial && (rs.flags[i]! & FLAG.partial)) { partial++; continue; }
    order.push(i);
    if (p.kind === 'nerv') { scenes++; nerv++; } else if (p.kind === 'hud') { scenes++; hud++; }
  }
  if (!order.length) {
    return fail(total === 0 ? 'This folder has no presets.' : `No playable presets: ${unavailable} unavailable${missing ? `, ${missing} missing` : ''}${partial ? `, ${partial} partial` : ''}.`);
  }
  const startAt = request.startAt !== null && request.startAt !== undefined && order.includes(request.startAt) ? request.startAt : null;
  let settings: SetupSettings | null = null, timing: SceneTiming | null = null, options: FolderPlayPlan['options'] = 'live', note = '';
  const saved = request.useSaved ? request.saved ?? null : null;
  let usedSaved = false;
  if (saved && (saved.settings || saved.timing)) {
    // A saved bundle is applied exactly as a setup's would be; what it does not define keeps the live value. A bundle that no longer
    // validates (the store only holds validated ones, but a caller may pass anything) behaves like none instead of failing the play.
    try {
      const s = saved.settings ? { ...parseSettings(saved.settings) } : null, t = saved.timing ? parseSceneTiming(saved.timing) : null;
      settings = s; timing = t; options = 'saved'; usedSaved = true;
    } catch { settings = null; timing = null; }
  }
  if (!usedSaved && request.useSaved) {
    // No saved bundle: a folder of scene presets gets its pack's built-in default; an AVS folder keeps the live settings.
    const byNode = id !== undefined && !request.results ? defaultLabelFor(tree, id) : null;
    const label = byNode ?? (scenes === order.length ? (hud === order.length ? HUD_ROOT_LABEL : nerv === order.length ? NERV_FOLDER_LABEL : HUD_ROOT_LABEL) : null);
    const def = label && scenes === order.length ? builtinDefault(label, request.styles ?? CLASSIC_STYLES) : null;
    if (def) {
      const bpm = request.bpm !== null && request.bpm !== undefined && Number.isFinite(request.bpm) && request.bpm >= 20 && request.bpm <= 400 ? Math.round(request.bpm * 100) / 100 : 120;
      settings = { ...def.settings };
      timing = { ...defaultSceneTiming, enabled: true, bpm, barsPerScene: def.barsPerScene, seed: keyHash(request.key) };
      options = 'builtin'; note = def.character;
    }
  }
  return { ok: true, key: request.key, label: request.label, order, total, skipped: { unavailable, missing, partial }, startAt, settings, timing, options, note };
}

/**
 * What the host does with a plan's order before it becomes the transient setup (design 8.3): keep the members that are integers in
 * range, drop duplicates and unparseable presets (no throw, unlike `activateSetup`), and refuse when nothing is left. O(n). The
 * host passes the plan's order through this, because a caller of `Actions.playFolder` may hand it anything.
 */
export function sanitizeOrder(order: readonly number[], catalog: readonly LocalAvsPreset[]): { order: number[]; dropped: number } | null {
  if (!Array.isArray(order)) return null;
  const seen = new Set<number>(), kept: number[] = [];
  let dropped = 0;
  for (const i of order) {
    if (!Number.isInteger(i) || i < 0 || i >= catalog.length || seen.has(i) || !catalog[i]!.autoEligible) { dropped++; continue; }
    seen.add(i); kept.push(i);
  }
  return kept.length ? { order: kept, dropped } : null;
}

export interface OverlayInput {
  source: PlaySource;
  /** Catalog index of the active preset. */
  index: number;
  catalogLength: number;
  name: string;
  rating: number;
  notWorking: boolean;
  /** 1-based place of the preset in the eligible pool of a folder or setup; 0 or absent when it is not in the pool. */
  position?: number;
  /** Size of that pool. */
  poolSize?: number;
  shuffle: boolean;
}
/**
 * The bottom-left line (design 8.2). Library: `Library · 12 / 3409 · name ★★★`. Setup: `Setup: name · 3 / 12 · ...`. Folder:
 * `Folder: tuggummi (756) · 12 / 756 · ...`, with `random` in place of the position while shuffling. The tail (name, stars and the
 * not-working note) is exactly the text the line has always carried. Plain text, deterministic, no clock.
 */
export function overlayText(i: OverlayInput): string {
  const tail = `${i.name} ${'★'.repeat(Math.max(0, Math.min(5, Math.trunc(i.rating) || 0)))}${i.notWorking ? ' · NOT WORKING' : ''}`;
  const n = (v: number): string => String(Math.max(0, Math.trunc(v) || 0));
  if (i.source.kind === 'library') return `Library · ${n(i.index + 1)} / ${n(i.catalogLength)} · ${tail}`;
  const place = i.shuffle ? 'random' : `${i.position && i.position > 0 ? n(i.position) : '?'} / ${n(i.poolSize ?? 0)}`;
  return i.source.kind === 'setup' ? `Setup: ${i.source.label} · ${place} · ${tail}` : `Folder: ${i.source.label} (${n(i.source.total)}) · ${place} · ${tail}`;
}

/** The largest number of presets a saved setup can hold (`parseSetups`). Folder play itself has no such limit. */
export const SETUP_LIMIT = 500;
/**
 * "Save folder as setup": the first `limit` members of a plan, in play order, as the hashes a setup stores, and how many did not fit.
 * The plan already dropped unavailable presets, which `activateSetup` would refuse.
 */
export function setupHashes(order: readonly number[], catalog: readonly LocalAvsPreset[], limit: number = SETUP_LIMIT): { presets: string[]; omitted: number } {
  const presets: string[] = [], seen = new Set<string>();
  let omitted = 0;
  for (const i of order) {
    const p = catalog[i];
    if (!p || !p.autoEligible || seen.has(p.sha256)) continue;
    if (presets.length >= limit) { omitted++; continue; }
    seen.add(p.sha256); presets.push(p.sha256);
  }
  return { presets, omitted };
}

/**
 * The one-line status after a Play folder press. Names what was played, what was left out, which settings apply and, when the live
 * settings keep control with Auto off, how to move on. Plain text, no colour: it is announced through a status region.
 */
export function playMessage(plan: FolderPlayPlan, eligible: number, liveAutoEnabled: boolean): string {
  const parts = [`Playing ${eligible.toLocaleString('en-US')} preset${eligible === 1 ? '' : 's'} from ${plan.label}.`];
  const left: string[] = [];
  if (plan.skipped.unavailable) left.push(`${plan.skipped.unavailable} unavailable`);
  if (plan.skipped.missing) left.push(`${plan.skipped.missing} missing`);
  if (plan.skipped.partial) left.push(`${plan.skipped.partial} partial`);
  if (left.length) parts.push(`Left out: ${left.join(', ')}.`);
  if (plan.options === 'saved') parts.push('Folder options applied.');
  else if (plan.options === 'builtin') parts.push(`Built-in defaults applied: ${plan.note}`);
  else parts.push(liveAutoEnabled ? 'Live settings kept.' : 'Auto is off: use Next/Previous.');
  return parts.join(' ');
}

/**
 * Memoises the eligible pool and the scene-clock phases derived from it. `sceneAt` is O(n) and the host asks for it about five
 * times a frame; with 3,400 shuffled presets that is roughly 2 ms of every 16, so the host routes `selectionPool` and
 * `clockPhase` through this cache.
 *
 * The returned pool is shared and must be treated as read-only. `revision` must change whenever anything that `eligiblePresets`
 * reads changes and is not one of the other arguments: the session's failed set, or the choice to ignore it. `failed` itself is
 * not compared, only used when the pool is recomputed.
 */
export class PoolCache {
  /** Bumped each time the pool is recomputed; fold it into `memoPhase` keys. */
  poolRevision = 0;
  private order: readonly number[] | null = null;
  private catalog: readonly LocalAvsPreset[] | null = null;
  private shuffle = false;
  private minimum = -1;
  private revision = Number.NaN;
  private pool: number[] = [];
  private phases = new Map<string, unknown>();
  get(order: readonly number[], catalog: readonly LocalAvsPreset[], shuffle: boolean, minimumRating: number, failed: ReadonlySet<number>, revision: number): number[] {
    if (order === this.order && catalog === this.catalog && shuffle === this.shuffle && minimumRating === this.minimum && revision === this.revision) return this.pool;
    this.pool = eligiblePresets(catalog, order, shuffle, minimumRating, failed);
    this.order = order; this.catalog = catalog; this.shuffle = shuffle; this.minimum = minimumRating; this.revision = revision;
    this.phases.clear();
    this.poolRevision++;
    return this.pool;
  }
  /** Returns the value computed for `key` while the pool has not changed. A small bounded memo keeps the newest entries. */
  memoPhase<T>(key: string, compute: () => T): T {
    if (this.phases.has(key)) return this.phases.get(key) as T;
    const value = compute();
    this.phases.set(key, value);
    if (this.phases.size > 8) this.phases.delete(this.phases.keys().next().value as string);
    return value;
  }
  clear(): void { this.order = null; this.catalog = null; this.phases.clear(); this.poolRevision++; }
}
