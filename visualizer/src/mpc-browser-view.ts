import type { HudTitleMap, LocalAvsPreset, SourceMap } from './avs/local-collection.ts';
import type { TaxonMap } from './avs/preset-categories.ts';
import { buildFolderTree, defaultLabelFor, folderMembers, manualOrder, pathLabels, treeRows, withUserFolders, ancestorKeys, locate, type FolderNode, type FolderTree, type TreeRow } from './mpc-folders.ts';
import {
  FLAG, SORT_FIELDS, SORT_LABELS, applyStats, buildRecords, defaultDirection, parseQuery, runQuery, sortIndices, syncFailed, updateRecord, visibleWindow,
  type Query, type RecordSet, type SortField, type SortKey,
} from './mpc-folder-query.ts';
import {
  FOLDER_LIMITS, addMembers, clearPlayback, createFolder, deleteFolder, folderDepth, moveMember, removeMembers, renameFolder, setLast, setPlayback, setUi, systemTimers, updateSearch,
  type FolderPlayOptions, type FolderState, type FolderStore, type Timers,
} from './mpc-folder-store.ts';
import { planFolderPlay, playMessage, setupHashes, type FolderPlayPlan, type PlaySource } from './mpc-folder-play.ts';
import { builtinDefault } from './mpc-folder-defaults.ts';
import { defaultSceneTiming, type SceneTiming } from './mpc-scene-clock.ts';
import type { PlayStats } from './mpc-folder-stats.ts';
import type { SetupSettings } from './mpc-setups.ts';
/**
 * The Preset Browser view (docs/design/PRESET-BROWSER-V2.md 9): folder tree, search and sort toolbar, a windowed preset list and a
 * detail column. It owns no playback: every effect goes out through `BrowserOptions`, and the manager (`PresetManagement`) fills
 * `itemSlot` with the focused preset's own controls. The skeleton is created once and only patched afterwards, so the search box
 * keeps its identity and caret; the list renders about thirty rows however long it is.
 *
 * Constraints kept on purpose:
 *  - The page CSP of `mpc.html` blocks external stylesheets, so this module injects its own `<style>` (`browserCss`).
 *  - Handlers are assigned as element properties (`onclick`, `onkeydown`, ...) and tolerate a missing event, and every browser API
 *    (`matchMedia`, `ResizeObserver`, `requestAnimationFrame`, `style`, `clientHeight`) is feature-detected, so the fake DOM of the
 *    CPU checks drives the same code. When nothing is measurable the list renders its first 60 rows.
 *  - No colour-only state: rating, playing, unavailable and not-working are text. One tab stop per composite widget: the tree and
 *    the list take focus themselves and name their active row with `aria-activedescendant`.
 *  - Nothing here reads a private path. Titles from the local overlay reach the rows through the records, for HUD rows only.
 */

export const ROW_WIDE = 36, ROW_NARROW = 52, TREE_ROW = 30, SEARCH_DEBOUNCE_MS = 80, NARROW_QUERY = '(max-width:480px)';
export const STYLE_ID = 'aaavs-browser-style';

/** Plain-text help the manager appends to its keyboard section. */
export const BROWSER_HELP = 'Preset Browser: / or Ctrl+F search · Esc clears the search, then leaves it · arrows move, Right/Left open and close folders, Enter opens a folder or loads a preset · '
  + 'Ctrl+Enter plays the folder or the results · Shift+Enter plays the folder from the focused preset · Space toggles selection · Shift+arrows extend it · Ctrl+A selects all shown · '
  + '1–5 rate the focused preset · M toggles not working · . shows the playing preset · F2 renames and Delete removes a user folder.';

/** Every rule starts at `#management`, whose own `button`, `input` and `select` rules would otherwise win on specificity. */
export const browserCss = `
#management .aaavs-browser{--ab-row:${ROW_WIDE}px;--ab-tree-row:${TREE_ROW}px;display:flex;flex-direction:column;flex:1 1 auto;min-height:0;gap:6px;margin-top:6px}
#management .aaavs-browser[data-narrow="1"]{--ab-row:${ROW_NARROW}px}
#management .aaavs-browser [hidden]{display:none}
#management .ab-top{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
#management .ab-playing{flex:1 1 220px;margin:0;overflow-wrap:anywhere}
#management .ab-toolbar{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
#management .ab-toolbar input[type=search]{flex:1 1 180px;min-width:120px}
#management .ab-filters{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
#management .ab-filters-toggle,#management .ab-back,#management .ab-details-toggle{display:none}
#management .ab-status,#management .ab-notice{margin:0;font-size:13px;overflow-wrap:anywhere}
#management .ab-notice button{margin-left:8px}
#management .ab-panes{display:grid;grid-template-columns:minmax(170px,260px) minmax(240px,1fr) minmax(220px,340px);grid-template-rows:minmax(0,1fr);gap:10px;flex:1 1 auto;min-height:240px}
#management .ab-tree,#management .ab-list,#management .ab-detail{min-width:0;min-height:0;overflow:auto;border:1px solid #404040;background:#1a1a1a}
#management .ab-listcol{display:flex;flex-direction:column;min-width:0;min-height:0;gap:6px}
#management .ab-list{flex:1 1 auto}
#management .ab-tree:focus-visible,#management .ab-list:focus-visible{outline:2px solid #36b4dc;outline-offset:-2px}
#management .ab-spacer{position:relative}
#management .ab-rows{position:absolute;left:0;right:0;top:0}
#management .ab-pinned{position:absolute;left:0;right:0}
#management .ab-listhead{display:flex;align-items:center;gap:8px;margin:0;font-size:14px;overflow-wrap:anywhere}
#management .ab-node{display:flex;align-items:center;gap:6px;height:var(--ab-tree-row);box-sizing:border-box;padding-right:8px;cursor:pointer;white-space:nowrap;overflow:hidden}
#management .ab-node:hover{background:#2a2a2a}
#management .ab-node.selected{background:#26363c;box-shadow:inset 3px 0 0 #36b4dc}
#management .ab-node.active{outline:2px solid #36b4dc;outline-offset:-2px}
#management .ab-twisty{width:14px;text-align:center;flex:none}
#management .ab-label{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis}
#management .ab-count{flex:none;opacity:.75;font-variant-numeric:tabular-nums}
#management .ab-badge{flex:none;font-size:12px;border:1px solid #606060;border-radius:2px;padding:0 4px}
#management .ab-row{display:flex;align-items:center;gap:8px;width:100%;height:var(--ab-row);box-sizing:border-box;margin:0;padding:0 8px;text-align:left;border-width:0 0 1px;overflow:hidden;white-space:nowrap;background:transparent}
#management .ab-row.selected{background:#26363c}
#management .ab-row.active{outline:2px solid #36b4dc;outline-offset:-2px}
#management .ab-row.playing{box-shadow:inset 3px 0 0 #36b4dc}
#management .ab-path{flex:1 1 30%;min-width:0;overflow:hidden;text-overflow:ellipsis;opacity:.7;font-size:12px}
#management .ab-size{flex:none;opacity:.7;font-size:12px;font-variant-numeric:tabular-nums}
#management .ab-empty{padding:12px;margin:0}
#management .ab-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
#management .ab-reason{font-size:12px;opacity:.8}
#management .ab-detail{padding:8px}
#management .ab-detail h2{margin:4px 0}#management .ab-detail h3{font-size:13px;margin:12px 0 4px}
#management .ab-detail label{display:flex;align-items:center;gap:8px;margin:6px 0}
#management .ab-detail p{margin:4px 0;font-size:13px}
#management .ab-others{display:flex;flex-direction:column;gap:4px;align-items:flex-start}
#management .ab-slot label{justify-content:space-between}
#management .ab-slot input:not([type=checkbox]),#management .ab-slot textarea,#management .ab-slot>select{width:100%;box-sizing:border-box}
#management .ab-slot ol{padding-left:22px}#management .ab-slot li{margin:8px 0;overflow-wrap:anywhere}#management .ab-slot li button{margin:3px}
#management .ab-slot fieldset{margin:8px 0;border:1px solid #404040}
#management .display-tools label{display:flex;align-items:center;gap:6px}#management .display-tools .ab-reason{align-self:center}
@media(max-width:899px){#management .ab-panes{grid-template-columns:minmax(150px,240px) minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto}#management .ab-detail{grid-column:1/-1;max-height:45vh}}
@media(max-width:480px){
#management>.aaavs-browser,#management>footer{flex:none}
#management .ab-panes{display:block;flex:none;min-height:0}
#management .ab-list{flex:none}
#management .ab-tree,#management .ab-list{height:min(52vh,420px)}
#management .aaavs-browser[data-pane="tree"] .ab-listcol{display:none}
#management .aaavs-browser[data-pane="list"] .ab-tree{display:none}
#management .ab-back,#management .ab-filters-toggle,#management .ab-details-toggle{display:inline-block}
#management .ab-filters{display:none;width:100%}
#management .aaavs-browser[data-filters="open"] .ab-filters{display:flex}
#management .ab-row{display:block;padding:4px 8px}
#management .ab-row .ab-path{display:block;font-size:12px;overflow:hidden;text-overflow:ellipsis}
#management .ab-row .ab-size{display:none}
#management .ab-detail{display:none}
#management .aaavs-browser[data-details="open"] .ab-detail{display:block;position:fixed;left:0;right:0;bottom:0;max-height:60vh;z-index:6;background:#202020;border-top:2px solid #36b4dc}
}
`;

// ---------------------------------------------------------------------------------------------------------------- pure helpers

export interface KeyMods { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }
export type TreeKeyAction =
  | { type: 'none' } | { type: 'focus'; to: number } | { type: 'expand' } | { type: 'collapse' } | { type: 'open' } | { type: 'play' }
  | { type: 'rename' } | { type: 'delete' } | { type: 'siblings' };
const NONE = { type: 'none' } as const;

/**
 * The tree's keyboard model: pure, so it is tested without a DOM. `focus` is the active row's position in `rows`.
 * Right expands a closed folder and then enters it; Left closes an open one and then goes to its parent.
 */
export function treeKeyAction(key: string, mods: KeyMods, rows: readonly TreeRow[], focus: number): TreeKeyAction {
  const n = rows.length;
  if (!n || mods.alt) return NONE;
  const at = Math.max(0, Math.min(n - 1, Number.isInteger(focus) ? focus : 0));
  const row = rows[at]!;
  const go = (to: number): TreeKeyAction => ({ type: 'focus', to: Math.max(0, Math.min(n - 1, to)) });
  switch (key) {
    case 'ArrowDown': return go(at + 1);
    case 'ArrowUp': return go(at - 1);
    case 'PageDown': return go(at + 10);
    case 'PageUp': return go(at - 10);
    case 'Home': return go(0);
    case 'End': return go(n - 1);
    case 'ArrowRight': {
      if (row.expanded === false) return { type: 'expand' };
      const next = rows[at + 1];
      return row.expanded === true && next && next.depth > row.depth ? go(at + 1) : NONE;
    }
    case 'ArrowLeft': {
      if (row.expanded === true) return { type: 'collapse' };
      for (let k = at - 1; k >= 0; k--) if (rows[k]!.depth < row.depth) return go(k);
      return NONE;
    }
    case '*': return { type: 'siblings' };
    case 'Enter': return mods.ctrl || mods.meta ? { type: 'play' } : { type: 'open' };
    case 'F2': return { type: 'rename' };
    case 'Delete': return { type: 'delete' };
    default: return NONE;
  }
}

export type ListKeyAction =
  | { type: 'none' } | { type: 'focus'; to: number; extend: boolean } | { type: 'load' } | { type: 'playFrom' } | { type: 'playAll' } | { type: 'toggle' }
  | { type: 'selectAll' } | { type: 'rate'; value: number } | { type: 'broken' } | { type: 'reveal' } | { type: 'clear' };

/** The list's keyboard model. `focus` is the active row's position (-1 for none); `page` is the number of rows a page key moves. */
export function listKeyAction(key: string, mods: KeyMods, count: number, focus: number, page = 10): ListKeyAction {
  if (mods.alt) return NONE;
  const extend = !!mods.shift;
  const go = (to: number): ListKeyAction => (count ? { type: 'focus', to: Math.max(0, Math.min(count - 1, to)), extend } : NONE);
  const at = Number.isInteger(focus) ? focus : -1;
  if (mods.ctrl || mods.meta) {
    if (key === 'Enter') return { type: 'playAll' };
    if (key === 'a' || key === 'A') return count ? { type: 'selectAll' } : NONE;
    return NONE;
  }
  switch (key) {
    case 'ArrowDown': return go(at < 0 ? 0 : at + 1);
    case 'ArrowUp': return go(at < 0 ? 0 : at - 1);
    case 'PageDown': return go(at < 0 ? 0 : at + page);
    case 'PageUp': return go(at < 0 ? 0 : at - page);
    case 'Home': return go(0);
    case 'End': return go(count - 1);
    case 'Enter': return at < 0 ? NONE : mods.shift ? { type: 'playFrom' } : { type: 'load' };
    case ' ': return at < 0 ? NONE : { type: 'toggle' };
    case 'Escape': return { type: 'clear' };
    case 'm': case 'M': return at < 0 ? NONE : { type: 'broken' };
    case '.': return { type: 'reveal' };
    default: return at >= 0 && /^[1-5]$/.test(key) && !mods.shift ? { type: 'rate', value: Number(key) } : NONE;
  }
}

/**
 * `aria-posinset` and `aria-setsize` of a flat tree's items count siblings, not every visible row: the position among the rows that
 * share a parent and their number. Rows are in tree order with a `depth`, so a parent is the nearest earlier row one level up.
 */
export function siblingPositions(rows: readonly { readonly depth: number }[]): { pos: number[]; size: number[] } {
  const pos: number[] = [], group: number[] = [], counts = new Map<number, number>(), lastAt: number[] = [];
  rows.forEach((row, i) => {
    const d = Math.max(0, Math.trunc(row.depth) || 0);
    const parent = d === 0 ? -1 : lastAt[d - 1] ?? -1;
    lastAt[d] = i; lastAt.length = d + 1;
    const n = (counts.get(parent) ?? 0) + 1;
    counts.set(parent, n); pos[i] = n; group[i] = parent;
  });
  return { pos, size: group.map(g => counts.get(g) ?? 0) };
}

export interface SortContext { hasText: boolean; taxa: boolean; stats: boolean; manual: boolean }
/** The sort keys worth offering: relevance only with a text term, manual order only inside a manual folder, taxonomy and history keys only with data. */
export function sortChoices(c: SortContext): SortField[] {
  return SORT_FIELDS.filter(f => f === 'relevance' ? c.hasText : f === 'manual' ? c.manual
    : f === 'style' || f === 'energy' || f === 'busyness' || f === 'author' || f === 'fidelity' ? c.taxa : f === 'recent' || f === 'plays' ? c.stats : true);
}
/**
 * The order the list uses. An explicit choice wins; otherwise relevance while a text term exists, then the folder's saved play order,
 * then the folder's default (manual, name, or path then name). Keys whose data is missing are dropped; the result is never empty.
 */
export function effectiveSort(input: { choice: readonly SortKey[] | null; hasText: boolean; saved: readonly SortKey[] | null; fallback: readonly SortKey[]; available: readonly SortField[] }): SortKey[] {
  const ok = (k: SortKey): boolean => input.available.includes(k.key);
  let spec: SortKey[];
  if (input.choice?.length) spec = input.choice.filter(ok);
  else if (input.hasText) spec = [{ key: 'relevance', dir: 'desc' }, { key: 'name', dir: 'asc' }];
  else if (input.saved?.length) spec = input.saved.filter(ok);
  else spec = input.fallback.filter(ok);
  if (!spec.length) spec = [{ key: 'name', dir: 'asc' }];
  return spec.slice(0, 3).map(k => ({ key: k.key, dir: k.dir }));
}
export function sortText(spec: readonly SortKey[]): string {
  return spec.map(k => `${SORT_LABELS[k.key].toLowerCase()}${k.dir === defaultDirection(k.key) ? '' : k.dir === 'asc' ? ', ascending' : ', descending'}`).join(', then ');
}

export interface ListInput {
  folder: number; scopeAll: boolean; query: Query; minimum: number; status: 'all' | 'working' | 'broken'; sort: readonly SortKey[]; seed: number; now?: number;
}
export interface ListResult { ids: Int32Array; notes: string[]; scope: number }
/** The displayed list: search inside the folder (or everywhere), the rating and status filters, then the sort. */
export function computeList(tree: FolderTree, rs: RecordSet, input: ListInput): ListResult {
  const universe = input.scopeAll || input.folder < 0 ? null : folderMembers(tree, input.folder, rs);
  const found = runQuery(rs, input.query, universe, input.now === undefined ? {} : { now: input.now });
  let ids = found.ids;
  if (input.minimum > 0 || input.status !== 'all') {
    const kept: number[] = [];
    for (const i of ids) {
      if (rs.rating[i]! < input.minimum) continue;
      const broken = (rs.flags[i]! & FLAG.notWorking) !== 0;
      if ((input.status === 'working' && broken) || (input.status === 'broken' && !broken)) continue;
      kept.push(i);
    }
    ids = Int32Array.from(kept);
  }
  ids = sortIndices(rs, ids, input.sort, { seed: input.seed, score: found.score, manual: manualOrder(tree, input.folder) });
  return { ids, notes: found.notes, scope: universe ? universe.length : rs.count };
}

/** The row text the manager's list has always used: rating, name, then plain-text state. */
export function rowText(name: string, rating: number, state: { notWorking?: boolean; playing?: boolean; unavailable?: boolean; failed?: boolean }): string {
  return `${rating ? '★'.repeat(rating) : '—'}  ${name}${state.notWorking ? ' · not working' : ''}${state.unavailable ? ' · unavailable' : ''}${state.failed ? ' · failed' : ''}${state.playing ? ' · playing' : ''}`;
}
/** Inside a folder whose label starts the name (`NERV` and `NERV / 01 - Boot`), the repeated prefix is hidden; the detail pane keeps the full name. */
export function listName(name: string, folderLabel: string): string {
  const prefix = `${folderLabel} / `;
  return folderLabel && name.length > prefix.length && name.startsWith(prefix) ? name.slice(prefix.length) : name;
}
export function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}
/** The status line: `312 presets in tuggummi, sorted by name`; a filtered list says `12 of 312`. */
export function summaryText(input: { count: number; total: number; label: string; scopeAll: boolean; sort: readonly SortKey[] }): string {
  const n = input.count.toLocaleString('en-US');
  const of = input.total !== input.count ? ` of ${input.total.toLocaleString('en-US')}` : '';
  return `${n}${of} preset${input.count === 1 && !of ? '' : 's'} ${input.scopeAll ? 'everywhere' : `in ${input.label}`}, sorted by ${sortText(input.sort)}`;
}
/** A short plain-text description of a settings bundle, for the folder detail. */
export function settingsSummary(s: SetupSettings, timing?: SceneTiming): string {
  const bits = [`Auto ${s.enabled ? 'on' : 'off'}`, `shuffle ${s.shuffle ? 'on' : 'off'}`, s.bars ? `${s.bars}-bar phrases` : 'adaptive phrases'];
  if (timing?.enabled) bits.push(`song clock on (${timing.barsPerScene} bars per scene)`);
  return bits.join(', ');
}

// ---------------------------------------------------------------------------------------------------------------- DOM helpers

type El = HTMLElement;
function make<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (className) e.className = className;
  return e;
}
function css(e: El, prop: string, value: string): void {
  const s = (e as { style?: CSSStyleDeclaration }).style;
  if (!s) return;
  if (prop.startsWith('--')) s.setProperty?.(prop, value); else (s as unknown as Record<string, string>)[prop] = value;
}
const attr = (e: El, name: string, value: string | number | boolean): void => e.setAttribute(name, String(value));
const modsOf = (ev: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean } | undefined): KeyMods => ({ ctrl: !!ev?.ctrlKey, shift: !!ev?.shiftKey, alt: !!ev?.altKey, meta: !!ev?.metaKey });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Re-renders a container whose controls may hold the keyboard focus (the button that was just pressed is replaced by the redraw). When
 * the focus was inside and the redraw dropped it, it returns to the equivalent control (same kind, label and text), else to `fallback`.
 * Feature-detected: a DOM without `contains` (the CPU checks' minimal fake) simply redraws. The manager uses it for its own panes too.
 */
export function keepFocusWithin(container: HTMLElement, render: () => void, fallback: HTMLElement): void {
  const doc = document as { activeElement?: El | null; body?: El | null };
  const active = doc.activeElement ?? null;
  const inside = !!active && active !== container && typeof container.contains === 'function' && container.contains(active);
  const signature = (e: El): string => `${e.tagName}|${e.getAttribute?.('aria-label') ?? ''}|${e.textContent ?? ''}`;
  const wanted = inside ? signature(active!) : null;
  render();
  if (wanted === null) return;
  const now = doc.activeElement ?? null;
  if (now !== null && now !== active && now !== doc.body) return;      // the redraw moved the focus on purpose
  if (active && typeof container.contains === 'function' && container.contains(active)) return;   // still there
  const pool = typeof container.querySelectorAll === 'function' ? Array.from(container.querySelectorAll('button,input,select,textarea')) as El[] : [];
  (pool.find(e => signature(e) === wanted && !(e as { disabled?: boolean }).disabled) ?? fallback).focus?.();
}

/** A fixed-row-height windowed list inside a scroll container. */
class Windowed {
  readonly spacer = make('div', '', 'ab-spacer');
  readonly rows = make('div', '', 'ab-rows');
  readonly pinned = make('div', '', 'ab-pinned');
  constructor(readonly host: El) { this.spacer.append(this.rows, this.pinned); host.append(this.spacer); }
  /** Renders the slice for the current scroll position. `focus` keeps the active row in the DOM when nothing is measurable. */
  render(count: number, rowHeight: number, build: (i: number) => El, focus = -1): { start: number; end: number } {
    const viewport = this.host.clientHeight || 0;
    let w = visibleWindow(this.host.scrollTop || 0, viewport, rowHeight, count);
    if (!(viewport > 0) && focus >= w.end) {
      const start = Math.max(0, Math.min(focus - 30, count - 60));
      w = { start, end: Math.min(count, start + 60), offset: start * rowHeight };
    }
    css(this.spacer, 'height', `${count * rowHeight}px`);
    css(this.rows, 'top', `${w.offset}px`);
    const out: El[] = [];
    for (let i = w.start; i < w.end; i++) out.push(build(i));
    this.rows.replaceChildren(...out);
    // Wheel scrolling may leave the active row outside the visible slice. Keep exactly one extra row mounted at its real
    // position so aria-activedescendant always names a descendant, without changing the user's scroll position.
    const pin = focus >= 0 && focus < count && (focus < w.start || focus >= w.end);
    this.pinned.hidden = !pin;
    this.pinned.replaceChildren(...(pin ? [build(focus)] : []));
    if (pin) css(this.pinned, 'top', `${focus * rowHeight}px`);
    this.spacer.replaceChildren(...(pin && focus < w.start ? [this.pinned, this.rows] : [this.rows, this.pinned]));
    return { start: w.start, end: w.end };
  }
  /** Scrolls so the row is visible; true when the scroll position changed. */
  reveal(position: number, rowHeight: number): boolean {
    const viewport = this.host.clientHeight || 0;
    if (!(viewport > 0) || position < 0) return false;
    const top = position * rowHeight, bottom = top + rowHeight, at = this.host.scrollTop || 0;
    if (top < at) { this.host.scrollTop = top; return true; }
    if (bottom > at + viewport) { this.host.scrollTop = bottom - viewport; return true; }
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------- the view

export interface BrowserData { sources?: SourceMap | null; taxa?: TaxonMap | null; titles?: HudTitleMap | null; stats?: PlayStats | null }
export type PlayResult = { ok: true; eligible: number } | { ok: false; reason: string };
export interface BrowserOptions {
  catalog(): readonly LocalAvsPreset[];
  /** The playing catalog index, or -1. */
  current(): number;
  store: FolderStore;
  load(index: number): void;
  rate(index: number, value: number): void;
  markNotWorking(index: number, notWorking: boolean): void;
  /** The live settings (Save current settings, and the status note when Auto is off). */
  settings(): SetupSettings;
  timing?(): SceneTiming | null;
  /** The trusted live tempo for a built-in default's song clock. */
  tempo?(): number | null;
  /** Number of named transition styles in this build (`TRANSITIONS.length`). */
  styles?: number;
  playFolder?(plan: FolderPlayPlan): PlayResult;
  stopFolder?(): void;
  source?(): PlaySource;
  failed?(): ReadonlySet<number>;
  /** The Setup Builder's playback controls with the `Folder` prefix; without them the options pane only summarises. */
  controls?(host: HTMLElement, settings: SetupSettings, timing: SceneTiming, onDirty: (redraw?: boolean) => void): void;
  /** The focused preset changed (-1 for none) or its data was refreshed: the manager redraws its item controls. */
  onFocus?(index: number, reason: 'focus' | 'refresh'): void;
  onOpen?(key: string): void;
  /** The set of rows the detail column acts on changed (Ctrl+A, Space, Shift+arrows); the manager labels its bulk buttons from it. */
  onSelect?(count: number): void;
  /** Bridge to the setup list: returns the message to show. */
  saveAsSetup?(name: string, hashes: string[], omitted: number): string;
  confirm?(text: string): boolean;
  newId?(): string;
  timers?: Timers;
  now?(): number;
  data?: BrowserData;
}

let idCounter = 0;
const defaultId = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return typeof c?.randomUUID === 'function' ? c.randomUUID() : `f${(++idCounter).toString(36)}${Date.now().toString(36)}`;
};

export class BrowserView {
  readonly root: El;
  /** The manager fills this with the focused preset's controls (rating, load, mark, add to setup). */
  readonly itemSlot: El;
  private opts: BrowserOptions;
  private data: BrowserData;
  private timers: Timers;
  private catalog: readonly LocalAvsPreset[] = [];
  private snapshot: LocalAvsPreset[] = [];
  private base!: FolderTree;
  private tree!: FolderTree;
  private rs!: RecordSet;
  private hashIndex = new Map<string, number>();
  private selectedKey = 'avs';
  private treeFocus = '';
  private expanded = new Set<string>(['avs']);
  private rows: TreeRow[] = [];
  private query = '';
  private parsed: Query = parseQuery('');
  private scopeAll = false;
  private minimum = 0;
  private status: 'all' | 'working' | 'broken' = 'all';
  private sortChoice: SortKey[] | null = null;
  private seed = 1;
  private results: Int32Array = new Int32Array(0);
  private notes: string[] = [];
  private scopeTotal = 0;
  private sort: SortKey[] = [{ key: 'name', dir: 'asc' }];
  private focus = -1;
  private selection = new Set<number>();
  private anchor = -1;
  private recursive = true;
  private useOptions = true;
  private draft: { key: string; options: FolderPlayOptions } | null = null;
  private message = '';
  private restored = false;
  /** The saved selected folder while the data that creates it (sources, taxonomy, titles) has not arrived yet. */
  private wanted: string | null = null;
  private touched = false;
  private searchTimer: number | null = null;
  private queued = false;
  private pending: 'tree' | 'list' | 'both' | null = null;
  private controlsSig = '';
  private narrow = false;
  private playedSig = '';
  private stale = false;
  private disposed = false;
  private resizeHandler: (() => void) | null = null;
  private hook: (() => void) | null = null;
  private previousHook: (() => void) | null = null;

  private playingEl = make('p', '', 'ab-playing');
  private stopBtn = make('button', 'Stop folder');
  private search = make('input');
  private scopeSel = make('select');
  private sortSel = make('select');
  private dirBtn = make('button');
  private thenSel = make('select');
  private minSel = make('select');
  private statusSel = make('select');
  private reshuffle = make('button', 'Reshuffle');
  private statusEl = make('p', '', 'ab-status');
  private noticeEl = make('p', '', 'ab-notice');
  private treeEl = make('nav', '', 'ab-tree');
  private listEl = make('section', '', 'ab-list');
  private emptyEl = make('p', 'No presets match.', 'ab-empty');
  private headEl = make('h2', '', 'ab-listhead');
  private headText = make('span');
  private playBtn = make('button', 'Play folder');
  private resultsBtn = make('button');
  private subBox = make('input');
  private reasonEl = make('span', '', 'ab-reason');
  private detailEl = make('aside', '', 'ab-detail');
  private detailsToggle: HTMLButtonElement | null = null;
  private locationEl = make('div', '', 'ab-location');
  private selectionEl = make('div', '', 'ab-selection');
  private folderEl = make('div', '', 'ab-folder');
  private treeWin: Windowed;
  private listWin: Windowed;

  constructor(options: BrowserOptions) {
    this.opts = options;
    this.data = { ...(options.data ?? {}) };
    this.timers = options.timers ?? systemTimers();
    this.itemSlot = make('div', '', 'ab-slot');
    this.root = make('div', '', 'aaavs-browser');
    this.treeWin = new Windowed(this.treeEl);
    this.listWin = new Windowed(this.listEl);
    this.seed = Math.max(1, (this.opts.now?.() ?? Date.now()) >>> 0);
    this.injectStyle();
    this.measure();
    this.build();
    this.rebuild();
    const store = options.store;
    this.previousHook = store.onChange;
    this.hook = () => { try { this.previousHook?.(); } finally { this.storeChanged(); } };
    store.onChange = this.hook;
    const win = globalThis as { addEventListener?: (type: string, fn: () => void) => void };
    if (typeof win.addEventListener === 'function') { this.resizeHandler = () => this.resized(); win.addEventListener('resize', this.resizeHandler); }
    this.storeChanged();
  }

  // ------------------------------------------------------------------------------------------------------------ setup

  private injectStyle(): void {
    try {
      const d = document;
      if (d.getElementById?.(STYLE_ID)) return;
      const style = d.createElement('style');
      style.id = STYLE_ID;
      style.textContent = browserCss;
      (d.head ?? d.documentElement)?.append(style);
    } catch { /* an environment without a head simply keeps the default look */ }
  }
  /** The narrow (embedded artwork window) layout uses the same 480 px breakpoint as the stylesheet. */
  private measure(): boolean {
    const g = globalThis as { matchMedia?: (q: string) => { matches: boolean }; innerWidth?: number };
    let narrow = false;
    try { narrow = typeof g.matchMedia === 'function' ? g.matchMedia(NARROW_QUERY).matches : (g.innerWidth ?? 9999) <= 480; } catch { narrow = false; }
    const changed = narrow !== this.narrow;
    this.narrow = narrow;
    attr(this.root, 'data-narrow', narrow ? 1 : 0);
    return changed;
  }
  private get rowHeight(): number { return this.narrow ? ROW_NARROW : ROW_WIDE; }
  private resized(): void { if (this.disposed) return; this.measure(); this.later('both'); }
  /** Stops listening (resize, the store) and cancels the pending search. The DOM is left as it is. */
  dispose(): void {
    this.disposed = true;
    if (this.opts.store.onChange === this.hook) this.opts.store.onChange = this.previousHook;
    if (this.searchTimer !== null) this.timers.clear(this.searchTimer);
    const win = globalThis as { removeEventListener?: (type: string, fn: () => void) => void };
    if (this.resizeHandler && typeof win.removeEventListener === 'function') win.removeEventListener('resize', this.resizeHandler);
  }

  /** See `keepFocusWithin`. */
  private keepFocus(container: El, render: () => void, fallback: El): void { keepFocusWithin(container, render, fallback); }

  private option(select: HTMLSelectElement, value: string, text: string): void {
    const o = make('option', text);
    o.value = value;
    select.append(o);
  }
  private button(text: string, action: () => void, disabled = false, label?: string): HTMLButtonElement {
    const b = make('button', text);
    b.type = 'button'; b.disabled = disabled; b.onclick = () => action();
    if (label) attr(b, 'aria-label', label);
    return b;
  }

  private build(): void {
    const root = this.root;
    attr(root, 'data-pane', 'tree'); attr(root, 'data-details', 'closed'); attr(root, 'data-filters', 'closed');
    // Header line: what is playing, with Stop folder.
    const top = make('div', '', 'ab-top');
    this.stopBtn.type = 'button'; this.stopBtn.hidden = true;
    this.stopBtn.onclick = () => this.stop();
    top.append(this.playingEl, this.stopBtn);
    // Toolbar: search plus filters.
    const bar = make('div', '', 'ab-toolbar');
    const input = this.search;
    input.type = 'search'; input.placeholder = 'Search presets (/)'; attr(input, 'aria-label', 'Search presets'); attr(input, 'autocomplete', 'off');
    input.oninput = () => this.typed();
    input.onkeydown = ev => this.searchKey(ev);
    const filtersToggle = this.button('Filters', () => { const open = root.getAttribute('data-filters') !== 'open'; attr(root, 'data-filters', open ? 'open' : 'closed'); attr(filtersToggle, 'aria-expanded', open); }, false);
    filtersToggle.className = 'ab-filters-toggle'; attr(filtersToggle, 'aria-expanded', false);
    bar.append(input, filtersToggle);
    const filters = make('div', '', 'ab-filters');
    attr(this.scopeSel, 'aria-label', 'Search scope');
    this.option(this.scopeSel, 'folder', 'In this folder'); this.option(this.scopeSel, 'all', 'Everywhere');
    this.scopeSel.onchange = () => { this.touched = true; this.scopeAll = this.scopeSel.value === 'all'; this.persistUi(); this.recompute(); };
    attr(this.sortSel, 'aria-label', 'Sort presets');
    this.sortSel.onchange = () => this.sortChanged('first');
    attr(this.dirBtn, 'aria-label', 'Sort direction'); this.dirBtn.type = 'button';
    this.dirBtn.onclick = () => this.flipDirection();
    attr(this.thenSel, 'aria-label', 'Then sort by');
    this.thenSel.onchange = () => this.sortChanged('then');
    this.reshuffle.type = 'button'; this.reshuffle.hidden = true;
    this.reshuffle.onclick = () => { this.seed = Math.max(1, ((this.opts.now?.() ?? Date.now()) ^ Math.imul(this.seed, 0x9e3779b1)) >>> 0); this.recompute(); };
    attr(this.minSel, 'aria-label', 'List minimum star rating');
    for (let n = 0; n <= 5; n++) this.option(this.minSel, String(n), n ? `Show ${n}+ stars` : 'Show all ratings');
    this.minSel.onchange = () => { this.touched = true; this.minimum = Number(this.minSel.value) || 0; this.recompute(); };
    attr(this.statusSel, 'aria-label', 'Preset status');
    for (const [value, text] of [['all', 'All statuses'], ['working', 'Not marked broken'], ['broken', 'Marked not working']] as const) this.option(this.statusSel, value, text);
    this.statusSel.onchange = () => { this.touched = true; this.status = this.statusSel.value === 'working' || this.statusSel.value === 'broken' ? this.statusSel.value : 'all'; this.recompute(); };
    filters.append(this.scopeSel, this.sortSel, this.dirBtn, this.thenSel, this.reshuffle, this.minSel, this.statusSel);
    bar.append(filters);
    this.statusEl.setAttribute('role', 'status');
    this.noticeEl.setAttribute('role', 'status');
    // Panes.
    const panes = make('div', '', 'ab-panes');
    this.treeEl.setAttribute('role', 'tree'); attr(this.treeEl, 'aria-label', 'Folders'); this.treeEl.tabIndex = 0;
    this.treeEl.onkeydown = ev => this.treeKey(ev);
    this.treeEl.onscroll = () => this.later('tree');
    this.listEl.setAttribute('role', 'listbox'); attr(this.listEl, 'aria-label', 'Presets'); attr(this.listEl, 'aria-multiselectable', true); this.listEl.tabIndex = 0;
    this.listEl.onkeydown = ev => this.listKey(ev);
    this.listEl.onscroll = () => this.later('list');
    this.emptyEl.hidden = true;
    this.listEl.prepend(this.emptyEl);
    const col = make('div', '', 'ab-listcol');
    const back = this.button('‹ Folders', () => { attr(root, 'data-pane', 'tree'); this.treeEl.focus?.(); });
    back.className = 'ab-back';
    const detailsToggle = this.button('Details', () => { const open = root.getAttribute('data-details') !== 'open'; attr(root, 'data-details', open ? 'open' : 'closed'); attr(detailsToggle, 'aria-expanded', open); });
    detailsToggle.className = 'ab-details-toggle'; attr(detailsToggle, 'aria-expanded', false);
    this.detailsToggle = detailsToggle;
    this.headEl.append(back, this.headText);
    this.playBtn.type = 'button'; this.playBtn.onclick = () => this.playFolder({ results: false });
    this.resultsBtn.type = 'button'; this.resultsBtn.hidden = true; this.resultsBtn.onclick = () => this.playFolder({ results: true });
    const subLabel = make('label', 'Subfolders');
    this.subBox.type = 'checkbox'; this.subBox.checked = true; attr(this.subBox, 'aria-label', 'Include subfolders');
    this.subBox.onchange = () => { this.recursive = this.subBox.checked; };
    subLabel.prepend(this.subBox);
    const actions = make('div', '', 'ab-actions');
    actions.append(this.playBtn, subLabel, this.resultsBtn, detailsToggle, this.reasonEl);
    col.append(this.headEl, this.listEl, actions);
    this.detailEl.tabIndex = -1;
    this.detailEl.append(this.locationEl, this.selectionEl, this.itemSlot, this.folderEl);
    panes.append(this.treeEl, col, this.detailEl);
    root.onkeydown = ev => this.rootKey(ev);
    root.append(top, bar, this.statusEl, this.noticeEl, panes);
  }

  // ------------------------------------------------------------------------------------------------------------ data

  /** Replaces the optional data (sources, taxonomy, title overlay, statistics) and rebuilds the folders. */
  setData(patch: BrowserData): void {
    this.data = { ...this.data, ...patch };
    if (patch.stats !== undefined && Object.keys(patch).length === 1 && this.rs) {
      applyStats(this.rs, this.catalog, patch.stats ?? null);
      this.recompute();
      return;
    }
    this.rebuild();
  }
  /** Rebuilds the tree and the records from the catalog: after the catalog or the optional data changes. */
  reload(): void { this.rebuild(); }

  private rebuild(): void {
    const catalog = this.opts.catalog();
    this.catalog = catalog;
    this.snapshot = Array.from(catalog);
    this.hashIndex = new Map(catalog.map((p, i) => [p.sha256, i] as const));
    const failed = this.opts.failed?.();
    this.base = buildFolderTree(catalog, {
      ...(this.data.sources ? { sources: this.data.sources } : {}), ...(this.data.taxa ? { taxa: this.data.taxa } : {}), ...(this.data.titles ? { titles: this.data.titles } : {}),
    });
    this.tree = this.opts.store.state.folders.length ? withUserFolders(this.base, this.opts.store.state.folders, this.hashIndex) : this.base;
    this.rs = buildRecords(catalog, this.tree, this.data.taxa ?? null, this.data.stats ?? null, failed, this.data.titles ?? null);
    // Data that arrives after the panel opened rebuilds the tree: a folder the owner had saved only now exists, and nothing was touched yet.
    if (this.wanted && !this.touched && this.tree.byKey.has(this.wanted)) { this.selectedKey = this.wanted; this.wanted = null; }
    if (this.touched) this.wanted = null;
    if (!this.tree.byKey.has(this.selectedKey)) this.selectedKey = this.firstFolder();
    this.expandTo(this.selectedKey);
    this.recompute();
    this.renderFolder();
  }
  private firstFolder(): string {
    for (const r of this.tree.roots) { const n = this.tree.nodes[r]!; if (n.key !== 'smart' && n.key !== 'user' && (n.members?.length ?? n.direct.length + n.children.length) > 0) return n.key; }
    return this.tree.roots.length ? this.tree.nodes[this.tree.roots[0]!]!.key : 'avs';
  }
  private expandTo(key: string): void { for (const k of ancestorKeys(this.tree, key)) this.expanded.add(k); }

  /** Cheap patch after a rating, mark, failure or play: the manager calls this on every change. */
  refresh(): void {
    if (this.disposed) return;
    const c = this.opts.catalog();
    if (c.length !== this.snapshot.length) { this.rebuild(); return; }
    let changed = false, focusedChanged = false;
    const focused = this.focusedIndex();
    for (let i = 0; i < c.length; i++) {
      const now = c[i]!, was = this.snapshot[i]!;
      if (now === was) continue;
      if (now.sha256 !== was.sha256) { this.rebuild(); return; }
      updateRecord(this.rs, i, now);
      this.snapshot[i] = now; changed = true;
      if (i === focused) focusedChanged = true;
    }
    this.catalog = c;
    const failed = this.opts.failed?.();
    if (failed && syncFailed(this.rs, failed)) changed = true;
    if (changed) this.recompute();
    else { this.renderWindows(); this.renderPlaying(); this.renderStatus(); }
    if (focusedChanged) this.opts.onFocus?.(this.focusedIndex(), 'refresh');
  }

  // ------------------------------------------------------------------------------------------------------------ store

  private storeChanged(): void {
    if (this.disposed) return;
    const store = this.opts.store;
    this.restore();
    const folders = store.state.folders;
    if (folders.length || this.tree !== this.base) this.tree = withUserFolders(this.base, folders, this.hashIndex);
    if (!this.tree.byKey.has(this.selectedKey)) this.selectedKey = this.firstFolder();
    this.checkStale();
    this.recompute();
    // A save acknowledgement changes nothing the folder pane shows, and redrawing it would replace a field the owner is typing in.
    const sig = this.folderSig();
    if (sig !== this.folderSigLast) { this.folderSigLast = sig; this.renderFolder(); }
    this.renderNotice();
  }
  private folderSigLast = '';
  /** What the folder pane draws from the store: the selected folder's own record and options, and the store's health. */
  private folderSig(): string {
    const store = this.opts.store, state = store.state, node = this.node();
    const f = node?.userId ? state.folders.find(x => x.id === node.userId) : undefined;
    return JSON.stringify([this.selectedKey, store.status, store.notice, node?.label ?? '', node?.missing ?? 0, f ? [f.name, f.kind, f.parent, f.presets?.length ?? 0, f.query ?? '', f.scope ?? ''] : null,
      state.playback[this.selectedKey] ?? null, this.selectedKey in state.opaquePlayback, state.folders.length]);
  }
  private restore(): void {
    if (this.restored) return;
    const store = this.opts.store;
    if (store.status === 'ready') {
      this.restored = true;
      if (this.touched) return;
      const ui = store.state.ui;
      if (ui.selected && this.tree.byKey.has(ui.selected)) this.selectedKey = ui.selected; else if (ui.selected) this.wanted = ui.selected;
      if (ui.expanded.length) this.expanded = new Set(ui.expanded);
      this.sortChoice = ui.sort.length ? ui.sort.map(k => ({ ...k })) : null;
      this.scopeAll = ui.scopeAll;
      this.scopeSel.value = this.scopeAll ? 'all' : 'folder';
      this.expandTo(this.selectedKey);
    } else if (store.status === 'unavailable' || store.status === 'readonly') this.restored = true;
  }
  private persistUi(): void {
    this.opts.store.mutateUi(s => setUi(s, { expanded: [...this.expanded], selected: this.selectedKey, sort: this.sortChoice ?? [], scopeAll: this.scopeAll }));
  }
  /** Runs a store edit; a refused edit explains itself in the status line. */
  private edit(change: (state: FolderState) => void): boolean {
    const store = this.opts.store;
    if (store.mutate(change)) return true;
    this.say(store.notice || (store.status === 'idle' || store.status === 'loading' ? 'Saved folders are still loading.' : 'Folders cannot be edited right now.'));
    return false;
  }

  // ------------------------------------------------------------------------------------------------------------ list state

  private node(key = this.selectedKey): FolderNode | undefined {
    const id = this.tree.byKey.get(key);
    return id === undefined ? undefined : this.tree.nodes[id];
  }
  private manualFolder(): boolean { return this.node()?.order !== undefined; }
  private hasText(): boolean { return this.parsed.text.length > 0; }
  private filterActive(): boolean { return this.parsed.text.length > 0 || this.parsed.clauses.length > 0 || this.minimum > 0 || this.status !== 'all'; }
  private available(): SortField[] {
    return sortChoices({ hasText: this.hasText(), taxa: this.rs.taxon !== null, stats: this.rs.hasStats, manual: this.manualFolder() });
  }

  private recompute(): void {
    if (this.disposed) return;
    const node = this.node();
    const id = node ? node.id : -1;
    const saved = this.opts.store.state.playback[this.selectedKey];
    const fallback: SortKey[] = node?.order ? [{ key: 'manual', dir: 'asc' }] : node?.def ? [{ key: 'name', dir: 'asc' }] : [{ key: 'path', dir: 'asc' }, { key: 'name', dir: 'asc' }];
    this.sort = effectiveSort({ choice: this.sortChoice, hasText: this.hasText(), saved: saved?.sort ?? null, fallback, available: this.available() });
    const keep = this.focus >= 0 ? this.results[this.focus] ?? -1 : -1;
    const list = computeList(this.tree, this.rs, { folder: id, scopeAll: this.scopeAll, query: this.parsed, minimum: this.minimum, status: this.status, sort: this.sort, seed: this.seed });
    this.results = list.ids; this.notes = list.notes; this.scopeTotal = list.scope;
    // Focus follows the same preset when it is still listed; a selection keeps only what is still listed.
    const at = keep >= 0 ? this.results.indexOf(keep) : -1;
    const previous = keep;
    this.focus = at;
    if (this.selection.size) { const listed = new Set(this.results); for (const i of [...this.selection]) if (!listed.has(i)) this.selection.delete(i); }
    this.renderLists();
    if (previous >= 0 && at < 0) this.opts.onFocus?.(-1, 'focus');
  }

  // ------------------------------------------------------------------------------------------------------------ rendering

  /** Scrolling and resizing re-render only the affected window, coalesced to one animation frame when the browser has one. */
  private later(which: 'tree' | 'list' | 'both'): void {
    if (this.disposed) return;
    this.pending = this.pending === which || this.pending === null ? which : 'both';
    const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
    const run = (): void => {
      const which = this.pending; this.pending = null; this.queued = false;
      if (this.disposed || !which) return;
      if (which !== 'list') this.renderTree();
      if (which !== 'tree') this.renderList();
    };
    if (typeof raf !== 'function') { run(); return; }
    if (this.queued) return;
    this.queued = true;
    raf(run);
  }
  /** Everything that follows the list: controls, header, windows, status and the two detail blocks. The folder pane is separate. */
  private renderLists(): void {
    this.renderControls();
    this.renderHead();
    this.renderPlaying();
    this.renderWindows();
    this.renderStatus();
    this.renderActions();
    this.renderLocation();
    this.renderSelection();
  }
  private renderWindows(): void { this.renderTree(); this.renderList(); }

  private playingKey(): string | null {
    const src = this.opts.source?.();
    return src && src.kind === 'folder' ? src.key : null;
  }
  private renderTree(): void {
    this.rows = treeRows(this.tree, this.expanded, this.playingKey(), this.rs);
    this.siblings = siblingPositions(this.rows);
    let at = this.rows.findIndex(r => r.key === this.treeFocus || r.chain.includes(this.treeFocus));
    if (at < 0) at = Math.max(0, this.rows.findIndex(r => r.chain.includes(this.selectedKey)));
    if (this.rows.length) this.treeFocus = this.rows[at]!.key;
    this.treeWin.render(this.rows.length, TREE_ROW, i => this.treeRow(i, at), at);
    if (this.rows.length) attr(this.treeEl, 'aria-activedescendant', `ab-node-${this.rows[at]!.id}`);
    else this.treeEl.removeAttribute?.('aria-activedescendant');
  }
  private siblings: { pos: number[]; size: number[] } = { pos: [], size: [] };
  private treeRow(i: number, active: number): El {
    const row = this.rows[i]!;
    const selected = row.chain.includes(this.selectedKey);
    const e = make('div', '', `ab-node${selected ? ' selected' : ''}${i === active ? ' active' : ''}`);
    e.id = `ab-node-${row.id}`;
    e.setAttribute('role', 'treeitem');
    attr(e, 'aria-level', row.depth + 1); attr(e, 'aria-selected', selected); attr(e, 'aria-posinset', this.siblings.pos[i] ?? 1); attr(e, 'aria-setsize', this.siblings.size[i] ?? 1);
    if (row.expanded !== null) attr(e, 'aria-expanded', row.expanded);
    css(e, 'paddingLeft', `${8 + row.depth * 14}px`);
    const twisty = make('span', row.expanded === null ? '' : row.expanded ? '▾' : '▸', 'ab-twisty');
    attr(twisty, 'aria-hidden', true);
    twisty.onclick = ev => { (ev as Event | undefined)?.stopPropagation?.(); if (row.expanded !== null) this.toggle(row.key); };
    e.append(twisty, make('span', row.label, 'ab-label'), make('span', row.count.toLocaleString('en-US'), 'ab-count'));
    if (row.playing) e.append(make('span', 'playing', 'ab-badge'));
    e.onclick = () => { this.treeFocus = row.key; this.openFolder(row.key, { focusList: this.narrow, expand: true }); };
    return e;
  }
  private toggle(key: string): void {
    if (this.expanded.has(key)) this.expanded.delete(key); else this.expanded.add(key);
    this.touched = true; this.persistUi(); this.renderTree();
  }

  private rowPath(i: number): string {
    const primary = this.tree.primary[i] ?? -1;
    if (primary < 0) return '';
    const labels = pathLabels(this.tree, primary);
    const nodes: string[] = [];
    for (let at = primary, guard = 0; at >= 0 && guard < 64; at = this.tree.nodes[at]?.parent ?? -1, guard++) nodes.unshift(this.tree.nodes[at]!.key);
    return labels.filter((_, k) => nodes[k] !== 'avs' && nodes[k] !== 'avs/src').join(' > ');
  }
  private listRow(p: number, folderLabel: string): El {
    const i = this.results[p]!;
    const preset = this.catalog[i]!;
    const name = listName(this.rs.display[i] ?? preset.name, folderLabel);
    const failed = (this.rs.flags[i]! & FLAG.failed) !== 0;
    const selected = this.selection.has(i) || (this.selection.size === 0 && p === this.focus);
    const playing = i === this.opts.current();
    const b = make('button', rowText(name, this.rs.rating[i] ?? 0, { notWorking: !!preset.notWorking, playing, unavailable: !preset.autoEligible, failed }),
      `preset-row ab-row${selected ? ' selected' : ''}${p === this.focus ? ' active' : ''}${playing ? ' playing' : ''}`);
    b.type = 'button'; b.id = `ab-opt-${i}`; b.tabIndex = -1;
    b.setAttribute('role', 'option');
    attr(b, 'aria-selected', selected); attr(b, 'aria-posinset', p + 1); attr(b, 'aria-setsize', this.results.length);
    const path = this.rowPath(i);
    if (path) b.append(make('span', path, 'ab-path'));
    b.append(make('span', sizeText(preset.bytes), 'ab-size'));
    // The list keeps the keyboard focus (`aria-activedescendant`): a row never takes it, so the redraw after a click cannot lose it.
    b.onmousedown = ev => { (ev as Event | undefined)?.preventDefault?.(); this.listEl.focus?.(); };
    b.onclick = ev => this.rowClick(p, ev as MouseEvent | undefined);
    b.ondblclick = () => this.opts.load(i);
    return b;
  }
  private renderList(): void {
    const n = this.results.length;
    this.emptyEl.hidden = n > 0;
    this.listWin.spacer.hidden = n === 0;
    if (!n) { this.listWin.rows.replaceChildren(); this.listWin.pinned.replaceChildren(); this.listEl.removeAttribute?.('aria-activedescendant'); return; }
    const folderLabel = this.node()?.label ?? '';
    this.listWin.render(n, this.rowHeight, p => this.listRow(p, folderLabel), this.focus);
    const active = this.focus >= 0 ? this.results[this.focus] : undefined;
    if (active !== undefined) attr(this.listEl, 'aria-activedescendant', `ab-opt-${active}`); else this.listEl.removeAttribute?.('aria-activedescendant');
  }
  private renderControls(): void {
    const choices = this.available();
    const first = this.sort[0], second = this.sort[1];
    const sig = `${choices.join()}|${first?.key}`;
    if (sig !== this.controlsSig) {
      this.controlsSig = sig;
      this.sortSel.replaceChildren();
      for (const f of choices) this.option(this.sortSel, f, SORT_LABELS[f]);
      this.thenSel.replaceChildren();
      this.option(this.thenSel, '', '—');
      for (const f of choices) if (f !== first?.key) this.option(this.thenSel, f, SORT_LABELS[f]);
    }
    this.sortSel.value = first?.key ?? 'name';
    this.thenSel.value = second && second.key !== first?.key ? second.key : '';
    const dir = first?.dir ?? 'asc';
    this.dirBtn.textContent = dir === 'asc' ? '↑ Ascending' : '↓ Descending';
    attr(this.dirBtn, 'aria-pressed', dir === 'desc');
    this.reshuffle.hidden = !this.sort.some(k => k.key === 'random');
    if (!this.reshuffle.hidden) this.reshuffle.textContent = `Reshuffle (${this.seed % 10000})`;
    this.scopeSel.value = this.scopeAll ? 'all' : 'folder';
    this.minSel.value = String(this.minimum);
    this.statusSel.value = this.status;
    this.subBox.checked = this.recursive;
  }
  private renderHead(): void {
    const node = this.node();
    const count = this.results.length.toLocaleString('en-US');
    this.headText.textContent = node ? `${pathLabels(this.tree, node.id).join(' > ')}  ${count}` : count;
  }
  private renderStatus(): void {
    const node = this.node();
    let text = summaryText({ count: this.results.length, total: this.scopeTotal, label: node?.label ?? 'the library', scopeAll: this.scopeAll, sort: this.sort });
    if (this.notes.length) text += ` · ${this.notes.join(' · ')}`;
    if (this.message) text += ` · ${this.message}`;
    this.statusEl.textContent = text;
  }
  private say(text: string): void { this.message = text; this.renderStatus(); }
  private renderNotice(): void { this.keepFocus(this.noticeEl, () => this.paintNotice(), this.treeEl); }
  private paintNotice(): void {
    const store = this.opts.store;
    const el = this.noticeEl;
    el.replaceChildren();
    const text = store.saveError ? `Folders could not be saved (${store.saveError}). Changes stay in this session.` : store.notice;
    el.hidden = !text;
    if (!text) { el.textContent = ''; return; }
    el.textContent = text;
    if (store.saveError) el.append(this.button('Retry save', () => store.retry()));
    if (store.status === 'readonly') el.append(this.button('Reset folders', () => { if ((this.opts.confirm ?? confirmDefault)('Replace all saved folders and folder options with an empty set?')) store.reset(); }));
  }
  private renderPlaying(): void {
    const src = this.opts.source?.();
    const shuffle = this.opts.settings().shuffle ? 'shuffle on' : 'shuffle off';
    let text = '';
    if (src?.kind === 'folder') text = `Playing: Folder "${src.label}" · ${src.total.toLocaleString('en-US')} presets · ${shuffle}`;
    else if (src?.kind === 'setup') text = `Playing: Setup "${src.label}" · ${shuffle}`;
    if (text && this.stale) text += ' · Folder changed. Play again to apply.';
    this.playingEl.textContent = text;
    this.playingEl.hidden = !text;
    this.stopBtn.hidden = src?.kind !== 'folder' || !this.opts.stopFolder;
  }
  private renderActions(): void {
    const n = this.results.length;
    const filtered = this.filterActive();
    const can = !!this.opts.playFolder;
    this.playBtn.disabled = !can || !this.node();
    this.resultsBtn.hidden = !filtered;
    this.resultsBtn.textContent = `Play ${n.toLocaleString('en-US')} result${n === 1 ? '' : 's'}`;
    this.resultsBtn.disabled = !can || n === 0;
    this.reasonEl.textContent = can ? '' : 'Playing a folder is not available in this host.';
  }

  // ------------------------------------------------------------------------------------------------------------ detail column

  private targets(): number[] {
    if (this.selection.size) { const out: number[] = []; for (const i of this.results) if (this.selection.has(i)) out.push(i); return out; }
    const f = this.focus >= 0 ? this.results[this.focus] : undefined;
    return f === undefined ? [] : [f];
  }
  /** Where a preset lives: its primary path and the other folders it is also in. */
  describeLocation(index: number): { path: string[]; others: { key: string; path: string[] }[] } {
    const where = locate(this.tree, index);
    return { path: where.primary >= 0 ? pathLabels(this.tree, where.primary) : [], others: where.others.map(id => ({ key: this.tree.nodes[id]!.key, path: pathLabels(this.tree, id) })) };
  }
  private renderLocation(): void { this.keepFocus(this.locationEl, () => this.paintLocation(), this.detailEl); }
  private paintLocation(): void {
    const el = this.locationEl;
    el.replaceChildren();
    const i = this.focus >= 0 ? this.results[this.focus] : undefined;
    if (i === undefined) return;
    const p = this.catalog[i]!;
    const where = this.describeLocation(i);
    if (where.path.length) el.append(make('p', `Location: ${where.path.join(' > ')}`));
    if (where.others.length) {
      el.append(make('p', `Also in ${where.others.length} other folder${where.others.length === 1 ? '' : 's'}`));
      const list = make('div', '', 'ab-others');
      for (const other of where.others.slice(0, 12)) list.append(this.button(other.path.join(' > '), () => this.openFolder(other.key, { focusList: true })));
      el.append(list);
    }
    if (p.kind === 'hud' && p.hud) el.append(make('p', `HUD scene · ${p.hud.tier === 'auto' ? 'auto · unreviewed' : p.hud.tier}`));
    else if (p.kind === 'nerv') el.append(make('p', 'NERV scene'));
  }
  private renderSelection(): void { this.keepFocus(this.selectionEl, () => this.paintSelection(), this.detailEl); this.opts.onSelect?.(this.targets().length); }
  private paintSelection(): void {
    const el = this.selectionEl;
    el.replaceChildren();
    const targets = this.targets();
    if (!targets.length) return;
    if (targets.length > 1) el.append(make('p', `${targets.length} presets selected`));
    const pick = make('select');
    attr(pick, 'aria-label', 'Add to folder');
    this.option(pick, '', 'Add to folder…');
    for (const f of this.opts.store.state.folders) if (f.kind === 'manual') this.option(pick, f.id, f.name);
    this.option(pick, '\u0000new', 'New folder…');
    pick.onchange = () => { const v = pick.value; pick.value = ''; if (v) this.addTo(v === '\u0000new' ? null : v); };
    el.append(pick);
    const folder = this.node();
    if (folder?.userId && folder.order) {
      const id = folder.userId;
      el.append(this.button('Remove from folder', () => this.removeFrom(id)));
      if (this.sort[0]?.key === 'manual' && targets.length === 1) {
        const hash = this.catalog[targets[0]!]!.sha256;
        el.append(this.button('Move up', () => this.edit(s => { moveMember(s, id, hash, -1); })), this.button('Move down', () => this.edit(s => { moveMember(s, id, hash, 1); })));
      }
    }
  }
  private addTo(id: string | null): void {
    const hashes = this.targets().map(i => this.catalog[i]!.sha256);
    if (!hashes.length) return;
    let target = id;
    if (target === null) {
      const fresh = (this.opts.newId ?? defaultId)();
      if (!this.edit(s => { createFolder(s, { id: fresh, name: 'New folder', kind: 'manual', created: this.opts.now?.() ?? Date.now() }); })) return;
      target = fresh;
    }
    const folderId = target;
    let result = { added: 0, skipped: 0 };
    if (!this.edit(s => { result = addMembers(s, folderId, hashes); })) return;
    const name = this.opts.store.state.folders.find(f => f.id === folderId)?.name ?? 'the folder';
    if (id === null) this.openFolder(`user:${folderId}`, { focusList: false });
    this.say(`Added ${result.added} to ${name}${result.skipped ? `; ${result.skipped} skipped (already there or over a limit)` : ''}.`);
  }
  private removeFrom(id: string): void {
    const hashes = this.targets().map(i => this.catalog[i]!.sha256);
    let removed = 0;
    if (this.edit(s => { removed = removeMembers(s, id, hashes); })) this.say(`Removed ${removed} from the folder.`);
  }
  /** "Folder from setup": an unbounded manual folder holding a setup's presets. Returns null when the store refused. */
  createFolderFromSetup(name: string, hashes: readonly string[]): { id: string; added: number; skipped: number } | null {
    const id = (this.opts.newId ?? defaultId)();
    let result = { added: 0, skipped: 0 };
    const ok = this.edit(s => { createFolder(s, { id, name, kind: 'manual', created: this.opts.now?.() ?? Date.now() }); result = addMembers(s, id, hashes); });
    if (!ok) return null;
    this.say(`Created folder "${name}" with ${result.added} presets${result.skipped ? `; ${result.skipped} skipped` : ''}.`);
    return { id, ...result };
  }

  private optionSummary(key: string, node: FolderNode): string {
    const state = this.opts.store.state;
    if (key in state.opaquePlayback) return 'Options from a newer version are kept unchanged and are not applied.';
    const saved = state.playback[key];
    if (saved && (saved.settings || saved.timing)) return `Saved options: ${saved.settings ? settingsSummary(saved.settings, saved.timing) : 'song clock only'}.`;
    const label = defaultLabelFor(this.tree, node.id);
    const def = label ? builtinDefault(label, this.opts.styles) : null;
    if (def) return `Built-in default for ${def.label}: ${def.character}`;
    return 'No saved options: the live settings stay in effect.';
  }
  private startDraft(key: string, node: FolderNode): void {
    const saved = this.opts.store.state.playback[key];
    const label = defaultLabelFor(this.tree, node.id);
    const def = !(saved?.settings || saved?.timing) && label ? builtinDefault(label, this.opts.styles) : null;
    const settings = saved?.settings ? clone(saved.settings) : def ? clone(def.settings) : clone(this.opts.settings());
    const bpm = this.opts.tempo?.();
    const timing = saved?.timing ? clone(saved.timing)
      : def ? { ...defaultSceneTiming, enabled: true, bpm: bpm && bpm >= 20 && bpm <= 400 ? Math.round(bpm * 100) / 100 : 120, barsPerScene: def.barsPerScene }
        : clone(this.opts.timing?.() ?? defaultSceneTiming);
    this.draft = { key, options: { recursive: this.recursive, sort: saved ? clone(saved.sort) : [], ...(saved?.skipPartial ? { skipPartial: true } : {}), settings, timing } };
    this.renderFolder();
  }
  private saveCurrent(key: string): void {
    const settings = clone(this.opts.settings());
    const timing = clone(this.opts.timing?.() ?? defaultSceneTiming);
    const sort = this.opts.store.state.playback[key]?.sort ?? [];
    if (this.edit(s => setPlayback(s, key, { recursive: this.recursive, sort: clone(sort), settings, timing }))) this.say('Saved the current settings as this folder’s options.');
  }

  private renderFolder(): void { this.folderSigLast = this.folderSig(); this.keepFocus(this.folderEl, () => this.paintFolder(), this.detailEl); }
  private paintFolder(): void {
    const host = this.folderEl;
    host.replaceChildren();
    const node = this.node();
    if (!node) return;
    const key = node.key;
    host.append(make('h2', pathLabels(this.tree, node.id).join(' > ')));
    const members = folderMembers(this.tree, node.id, this.rs).length;
    let counts = `${members.toLocaleString('en-US')} preset${members === 1 ? '' : 's'}`;
    if (node.direct.length && node.direct.length !== members) counts += ` · ${node.direct.length.toLocaleString('en-US')} directly here`;
    if (node.missing) counts += ` · ${node.missing} missing from the library`;
    host.append(make('p', counts));
    if (node.dynamic || node.def) host.append(make('p', 'Updates as ratings, marks and searches change.'));
    // Folder options.
    host.append(make('h3', 'Folder options'));
    const useLabel = make('label', 'Use folder options'), use = make('input');
    use.type = 'checkbox'; use.checked = this.useOptions; attr(use, 'aria-label', 'Use folder options');
    use.onchange = () => { this.useOptions = use.checked; };
    useLabel.prepend(use);
    host.append(useLabel, make('p', this.optionSummary(key, node)));
    const state = this.opts.store.state;
    const hasSaved = key in state.playback || key in state.opaquePlayback;
    if (!this.draft || this.draft.key !== key) {
      const row = make('div', '', 'ab-actions');
      row.append(this.button('Edit options', () => this.startDraft(key, node)), this.button('Save current settings', () => this.saveCurrent(key)),
        this.button('Clear saved options', () => { if (this.edit(s => clearPlayback(s, key))) this.say('Cleared this folder’s saved options.'); }, !hasSaved));
      host.append(row);
    } else this.renderDraft(host, this.draft);
    if (this.opts.saveAsSetup) host.append(this.button('Save folder as setup', () => this.saveAsSetup(node)));
    // User folders.
    if (key === 'user' || node.kind === 'user') this.renderUserTools(host, node);
  }
  private renderDraft(host: El, draft: { key: string; options: FolderPlayOptions }): void {
    const o = draft.options;
    const order = make('label', 'Play order'), pick = make('select');
    attr(pick, 'aria-label', 'Folder play order');
    const choices = sortChoices({ hasText: false, taxa: this.rs.taxon !== null, stats: this.rs.hasStats, manual: this.manualFolder() });
    this.option(pick, '', 'Folder default');
    for (const f of choices) this.option(pick, f, SORT_LABELS[f]);
    pick.value = o.sort[0]?.key ?? '';
    pick.onchange = () => { o.sort = pick.value ? [{ key: pick.value as SortField, dir: defaultDirection(pick.value as SortField) }, { key: 'name', dir: 'asc' }] : []; };
    order.append(pick);
    host.append(order);
    const sub = make('label', 'Include subfolders'), subInput = make('input');
    subInput.type = 'checkbox'; subInput.checked = o.recursive; attr(subInput, 'aria-label', 'Draft include subfolders');
    subInput.onchange = () => { o.recursive = subInput.checked; };
    sub.prepend(subInput); host.append(sub);
    if (this.rs.taxon) {
      const skip = make('label', 'Skip partial presets'), skipInput = make('input');
      skipInput.type = 'checkbox'; skipInput.checked = !!o.skipPartial;
      skipInput.onchange = () => { if (skipInput.checked) o.skipPartial = true; else delete o.skipPartial; };
      skip.prepend(skipInput); host.append(skip);
    }
    if (this.opts.controls && o.settings && o.timing) this.opts.controls(host, o.settings, o.timing, redraw => { if (redraw) this.renderFolder(); });
    else host.append(make('p', 'Playback controls are not available here.'));
    const row = make('div', '', 'ab-actions');
    row.append(this.button('Save options', () => {
      if (this.edit(s => setPlayback(s, draft.key, o))) { this.recursive = o.recursive; this.draft = null; this.say('Saved this folder’s options.'); this.recompute(); }
    }), this.button('Cancel', () => { this.draft = null; this.renderFolder(); }));
    host.append(row);
  }
  private renderUserTools(host: El, node: FolderNode): void {
    host.append(make('h3', node.kind === 'user' ? 'This folder' : 'My folders'));
    const row = make('div', '', 'ab-actions');
    const depth = node.userId ? folderDepth(this.opts.store.state, node.userId) : 0;
    const canNest = depth < FOLDER_LIMITS.depth;
    const parent = node.userId ?? null;
    const create = (kind: 'manual' | 'smart'): void => {
      const id = (this.opts.newId ?? defaultId)();
      const query = this.query.trim();
      const scope = this.scopeAll ? null : this.selectedKey;
      if (this.edit(s => { createFolder(s, { id, name: kind === 'smart' ? 'Saved search' : 'New folder', kind, parent, created: this.opts.now?.() ?? Date.now(), ...(kind === 'smart' ? { query, scope } : {}) }); })) {
        this.expanded.add(node.key); this.openFolder(`user:${id}`, { focusList: false });
      }
    };
    row.append(this.button(node.kind === 'user' ? 'New subfolder' : 'New folder', () => create('manual'), !canNest));
    row.append(this.button('New search folder', () => create('smart'), !canNest || !this.query.trim()));
    if (!canNest) row.append(make('span', `Folders can be nested ${FOLDER_LIMITS.depth} levels deep.`, 'ab-reason'));
    host.append(row);
    if (!node.userId) return;
    const id = node.userId, folder = this.opts.store.state.folders.find(f => f.id === id);
    if (!folder) return;
    const name = make('input');
    name.value = folder.name; name.maxLength = FOLDER_LIMITS.name; attr(name, 'aria-label', 'Folder name');
    this.nameInput = name;
    const rename = (): void => { if (name.value.trim() && name.value.trim() !== folder.name) this.edit(s => renameFolder(s, id, name.value)); };
    name.onkeydown = ev => { if (ev?.key === 'Enter') { ev.preventDefault?.(); rename(); } ev?.stopPropagation?.(); };
    host.append(name, this.button('Rename folder', rename), this.button('Delete folder', () => this.deleteUser(node)));
    if (folder.kind === 'smart') {
      const saved = make('input');
      saved.value = folder.query ?? ''; saved.maxLength = FOLDER_LIMITS.query; attr(saved, 'aria-label', 'Saved search');
      saved.onkeydown = ev => ev?.stopPropagation?.();
      host.append(saved, this.button('Save search', () => this.edit(s => updateSearch(s, id, saved.value, folder.scope ?? null))));
      const scope = folder.scope ? this.node(folder.scope)?.label ?? 'a folder that no longer exists' : 'the whole library';
      host.append(make('p', `The saved search runs in ${scope} each time the folder opens.`));
    } else host.append(make('p', 'Select presets in any list, then use Add to folder. Sort by Manual order to move them.'));
  }
  private nameInput: HTMLInputElement | null = null;
  private deleteUser(node: FolderNode): void {
    if (!node.userId) return;
    const id = node.userId;
    if (!(this.opts.confirm ?? confirmDefault)(`Delete folder “${node.label}” and its subfolders? Presets are kept.`)) return;
    const parent = node.parent >= 0 ? this.tree.nodes[node.parent]!.key : 'user';
    if (this.edit(s => { deleteFolder(s, id); })) { this.selectedKey = parent; this.touched = true; this.persistUi(); this.recompute(); this.renderFolder(); this.say('Folder deleted.'); }
  }
  private saveAsSetup(node: FolderNode): void {
    const saved = this.opts.store.state.playback[node.key] ?? null;
    const plan = planFolderPlay(this.tree, this.rs, this.catalog, { key: node.key, label: node.label, recursive: this.recursive, sort: saved?.sort ?? [], saved: null, useSaved: false, seed: this.seed });
    if (!plan.ok) { this.say(plan.reason); return; }
    const { presets, omitted } = setupHashes(plan.order, this.catalog);
    this.say(this.opts.saveAsSetup!(node.label, presets, omitted));
  }

  // ------------------------------------------------------------------------------------------------------------ interaction

  private typed(): void {
    if (this.searchTimer !== null) this.timers.clear(this.searchTimer);
    this.searchTimer = this.timers.set(() => { this.searchTimer = null; this.applyQuery(); }, SEARCH_DEBOUNCE_MS);
  }
  private applyQuery(): void {
    this.query = this.search.value;
    this.parsed = parseQuery(this.query);
    this.touched = true;
    this.message = '';
    this.recompute();
    const k = this.selectedKey;
    if (k === 'user' || k.startsWith('user:')) this.renderFolder();
  }
  /** Applies a pending search now instead of after the debounce. */
  flushSearch(): void {
    if (this.searchTimer === null) return;
    this.timers.clear(this.searchTimer); this.searchTimer = null;
    this.applyQuery();
  }
  /** Sets the search text as if it had been typed. */
  setQuery(text: string): void { this.search.value = text; this.flushSearchNow(); }
  private flushSearchNow(): void { if (this.searchTimer !== null) { this.timers.clear(this.searchTimer); this.searchTimer = null; } this.applyQuery(); }
  get queryText(): string { return this.query; }

  private sortChanged(which: 'first' | 'then'): void {
    this.touched = true;
    const current = this.sort;
    const first = which === 'first' ? { key: this.sortSel.value as SortField, dir: defaultDirection(this.sortSel.value as SortField) } : current[0]!;
    const then: SortKey[] = [];
    if (which === 'then') { if (this.thenSel.value) then.push({ key: this.thenSel.value as SortField, dir: 'asc' }); } else if (current[1] && current[1].key !== first.key) then.push(current[1]);
    this.sortChoice = [first, ...then];
    this.persistUi(); this.recompute();
  }
  private flipDirection(): void {
    const first = this.sort[0];
    if (!first) return;
    this.touched = true;
    this.sortChoice = [{ key: first.key, dir: first.dir === 'asc' ? 'desc' : 'asc' }, ...this.sort.slice(1)];
    this.persistUi(); this.recompute();
  }

  /** Opens a folder: selects it, expands the way to it and lists it. `expand` also opens the folder itself (a click; the keyboard uses Right). */
  openFolder(key: string, options: { focusList?: boolean; expand?: boolean } = {}): boolean {
    if (!this.tree.byKey.has(key)) return false;
    this.touched = true;
    this.selectedKey = key; this.treeFocus = key;
    this.expandTo(key);
    const node = this.node()!;
    if (options.expand && node.children.length) this.expanded.add(key);
    const saved = this.opts.store.state.playback[key];
    this.recursive = saved ? saved.recursive : true;
    this.draft = null; this.focus = -1; this.selection.clear(); this.anchor = -1; this.message = '';
    attr(this.root, 'data-pane', 'list');
    this.persistUi();
    this.recompute();
    this.renderFolder();
    this.opts.onFocus?.(-1, 'focus');
    this.opts.onOpen?.(key);
    if (options.focusList) this.listEl.focus?.();
    return true;
  }

  private setFocus(position: number, extend = false, additive = false): void {
    const n = this.results.length;
    if (position < 0 || position >= n) return;
    const index = this.results[position]!;
    if (extend && this.anchor >= 0) {
      this.selection.clear();
      for (let p = Math.min(this.anchor, position); p <= Math.max(this.anchor, position); p++) this.selection.add(this.results[p]!);
    } else if (!additive) { this.selection.clear(); this.selection.add(index); this.anchor = position; }
    const changed = this.focus !== position;
    this.focus = position;
    this.touched = true;
    this.listWin.reveal(position, this.rowHeight);
    this.renderList(); this.renderLocation(); this.renderSelection();
    if (changed) this.opts.onFocus?.(index, 'focus');
  }
  private rowClick(position: number, ev: MouseEvent | undefined): void {
    if (ev?.ctrlKey || ev?.metaKey) {
      const i = this.results[position]!;
      if (this.selection.has(i)) this.selection.delete(i); else this.selection.add(i);
      this.anchor = position;
      this.setFocus(position, false, true);
    } else this.setFocus(position, !!ev?.shiftKey);
  }

  private treeKey(ev: KeyboardEvent | undefined): void {
    if (!ev) return;
    const at = Math.max(0, this.rows.findIndex(r => r.key === this.treeFocus || r.chain.includes(this.treeFocus)));
    const a = treeKeyAction(ev.key, modsOf(ev), this.rows, at);
    if (a.type === 'none') return;
    ev.preventDefault?.(); ev.stopPropagation?.();
    const row = this.rows[at];
    if (!row) return;
    switch (a.type) {
      case 'focus': this.treeFocus = this.rows[a.to]!.key; this.treeWin.reveal(a.to, TREE_ROW); this.renderTree(); break;
      case 'expand': this.toggle(row.key); break;
      case 'collapse': this.toggle(row.key); break;
      case 'open': this.openFolder(row.key, { focusList: this.narrow }); break;
      case 'play': this.openFolder(row.key, { focusList: false }); this.playFolder({ results: false }); break;
      case 'rename': if (this.node(row.key)?.userId) {
        this.openFolder(row.key, { focusList: false });
        if (this.narrow) { attr(this.root, 'data-details', 'open'); if (this.detailsToggle) attr(this.detailsToggle, 'aria-expanded', true); }
        this.nameInput?.focus?.();
      } break;
      case 'delete': { const n = this.node(row.key); if (n?.userId) this.deleteUser(n); break; }
      case 'siblings': {
        for (let k = at; k >= 0 && this.rows[k]!.depth >= row.depth; k--) if (this.rows[k]!.depth === row.depth && this.rows[k]!.expanded === false) this.expanded.add(this.rows[k]!.key);
        for (let k = at + 1; k < this.rows.length && this.rows[k]!.depth >= row.depth; k++) if (this.rows[k]!.depth === row.depth && this.rows[k]!.expanded === false) this.expanded.add(this.rows[k]!.key);
        this.touched = true; this.persistUi(); this.renderTree();
        break;
      }
    }
  }
  private listKey(ev: KeyboardEvent | undefined): void {
    if (!ev) return;
    const viewport = this.listEl.clientHeight || 0;
    const page = viewport > 0 ? Math.max(1, Math.floor(viewport / this.rowHeight) - 1) : 10;
    const a = listKeyAction(ev.key, modsOf(ev), this.results.length, this.focus, page);
    if (a.type === 'none') return;
    if (a.type === 'clear') {
      if (this.selection.size > 1) { ev.stopPropagation?.(); ev.preventDefault?.(); const keep = this.focus >= 0 ? this.results[this.focus] : undefined; this.selection.clear(); if (keep !== undefined) this.selection.add(keep); this.renderList(); this.renderSelection(); }
      return;
    }
    ev.preventDefault?.(); ev.stopPropagation?.();
    const index = this.focus >= 0 ? this.results[this.focus] : undefined;
    switch (a.type) {
      case 'focus': this.setFocus(a.to, a.extend); break;
      case 'load': if (index !== undefined) this.opts.load(index); break;
      case 'playFrom': if (index !== undefined) this.playFolder({ startAt: index }); break;
      case 'playAll': this.playFolder(); break;
      case 'toggle': if (index !== undefined) { if (this.selection.has(index)) this.selection.delete(index); else this.selection.add(index); this.anchor = this.focus; this.renderList(); this.renderSelection(); } break;
      case 'selectAll': this.selection = new Set(this.results); this.renderList(); this.renderSelection(); break;
      case 'rate': if (index !== undefined) this.opts.rate(index, a.value); break;
      case 'broken': if (index !== undefined) { const p = this.catalog[index]!; this.opts.markNotWorking(index, !p.notWorking); } break;
      case 'reveal': this.revealCurrent(); break;
    }
  }
  private searchKey(ev: KeyboardEvent | undefined): void {
    if (!ev) return;
    if (ev.key === 'Escape') {
      ev.stopPropagation?.(); ev.preventDefault?.();
      if (this.search.value) { this.search.value = ''; this.flushSearchNow(); } else this.listEl.focus?.();
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault?.(); ev.stopPropagation?.();
      this.flushSearch();
      if (this.results.length) this.setFocus(Math.max(0, this.focus));
      this.listEl.focus?.();
    } else if (ev.key === 'Enter') { ev.preventDefault?.(); this.flushSearch(); }
    else ev.stopPropagation?.();     // typing never triggers a playback shortcut
  }
  private rootKey(ev: KeyboardEvent | undefined): void {
    if (!ev) return;
    const target = ev.target as { tagName?: string } | null;
    const tag = String(target?.tagName ?? '').toLowerCase();
    const typing = tag === 'input' || tag === 'select' || tag === 'textarea';
    if ((ev.key === '/' && !typing && !ev.ctrlKey && !ev.metaKey && !ev.altKey) || ((ev.key === 'f' || ev.key === 'F') && (ev.ctrlKey || ev.metaKey) && !ev.altKey)) {
      ev.preventDefault?.(); ev.stopPropagation?.();
      this.search.focus?.();
      (this.search as { select?: () => void }).select?.();
    }
  }
  /** Focus the search box, as the `/` key does. */
  focusSearch(): void { this.search.focus?.(); }
  /** Focus the tree's active row (the manager calls this when the panel opens). */
  focusTree(): void { this.treeEl.focus?.({ preventScroll: true }); }
  focusList(): void { this.listEl.focus?.(); }

  /** Shows the playing preset: opens a folder that lists it, scrolls to it and focuses it. */
  revealCurrent(): boolean {
    const current = this.opts.current();
    if (current < 0 || current >= this.catalog.length) return false;
    let at = this.results.indexOf(current);
    if (at < 0) {
      const target = this.tree.primary[current] ?? -1;
      if (target < 0) return false;
      this.query = ''; this.search.value = ''; this.parsed = parseQuery(''); this.minimum = 0; this.status = 'all'; this.scopeAll = false;
      this.openFolder(this.tree.nodes[target]!.key, { focusList: false });
      at = this.results.indexOf(current);
      if (at < 0) return false;
    }
    this.setFocus(at);
    this.treeWin.reveal(Math.max(0, this.rows.findIndex(r => r.chain.includes(this.selectedKey))), TREE_ROW);
    this.renderTree();
    return true;
  }

  // ------------------------------------------------------------------------------------------------------------ play

  /**
   * Plays the selected folder, or the displayed results when a search or filter is active (`results` overrides that). Returns the
   * host's answer, or null when nothing could be asked (no host support, no folder). The outcome is also written to the status line.
   */
  playFolder(options: { results?: boolean; startAt?: number | null } = {}): PlayResult | null {
    this.flushSearch();
    const node = this.node();
    if (!this.opts.playFolder) { this.say('Playing a folder is not available in this host.'); return null; }
    if (!node) { this.say('Choose a folder first.'); return null; }
    const useResults = options.results ?? this.filterActive();
    const saved = this.opts.store.state.playback[node.key] ?? null;
    const plan = planFolderPlay(this.tree, this.rs, this.catalog, {
      key: node.key, label: useResults ? `${node.label} (results)` : node.label, recursive: this.recursive, sort: saved?.sort ?? [], results: useResults ? this.results : null,
      startAt: options.startAt ?? null, saved, useSaved: this.useOptions, seed: this.seed, bpm: this.opts.tempo?.() ?? null, ...(this.opts.styles ? { styles: this.opts.styles } : {}),
    });
    if (!plan.ok) { this.say(plan.reason); return { ok: false, reason: plan.reason }; }
    const result = this.opts.playFolder(plan);
    if (!result.ok) { this.say(result.reason); return result; }
    this.playedSig = this.signature(node);
    this.stale = false;
    this.opts.store.mutate(s => setLast(s, node.key, this.recursive));
    this.message = playMessage(plan, result.eligible, this.opts.settings().enabled);
    this.renderLists();
    return result;
  }
  /** Ctrl+F8: replays the last folder. False when there is none (the manager then opens the browser on the tree). */
  playLast(): boolean {
    const last = this.opts.store.state.last;
    if (!last || !this.tree.byKey.has(last.key) || !this.opts.playFolder) return false;
    this.query = ''; this.search.value = ''; this.parsed = parseQuery(''); this.minimum = 0; this.status = 'all';
    this.openFolder(last.key, { focusList: false });
    this.recursive = last.recursive;
    const result = this.playFolder({ results: false });
    return !!result && result.ok;
  }
  stop(): void {
    this.opts.stopFolder?.();
    this.stale = false;
    this.message = 'Stopped folder play.';
    this.renderLists();
  }

  private signature(node: FolderNode): string {
    if (!node.userId && !node.key.startsWith('user:')) return '';
    let h = 0x811c9dc5;
    const m = folderMembers(this.tree, node.id, this.rs);
    for (let k = 0; k < m.length; k++) { h ^= m[k]!; h = Math.imul(h, 0x01000193); }
    return `${node.key}:${m.length}:${h >>> 0}`;
  }
  /** A user folder edited while it plays: the plan is a snapshot, so the header says "Play again to apply". */
  private checkStale(): void {
    const src = this.opts.source?.();
    if (!this.playedSig || src?.kind !== 'folder') { this.stale = false; return; }
    const node = this.node(src.key);
    this.stale = !!node && this.signature(node) !== this.playedSig;
  }

  // ------------------------------------------------------------------------------------------------------------ introspection

  focusedIndex(): number { return this.focus >= 0 ? this.results[this.focus] ?? -1 : -1; }
  /** The name a row shows for a preset: the local title overlay for a HUD scene (`Title / neutral name`), else the catalog name. */
  displayName(index: number): string { return this.rs?.display[index] ?? this.catalog[index]?.name ?? ''; }
  /** The presets an action applies to: the selected rows in list order, or the focused row when nothing is selected. */
  selectedIndices(): number[] { return this.targets(); }
  /** How many rows are selected (0 after Space toggled the last one off, although the focused row is still an action target). */
  get selectedCount(): number { return this.selection.size; }
  get folderKey(): string { return this.selectedKey; }
  get resultIndices(): Int32Array { return this.results; }
  get sortSpec(): readonly SortKey[] { return this.sort; }
  get treeRowsShown(): readonly TreeRow[] { return this.rows; }
}

function confirmDefault(text: string): boolean {
  const w = globalThis as { confirm?: (t: string) => boolean };
  return typeof w.confirm === 'function' ? w.confirm(text) : false;
}
