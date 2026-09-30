import { STATE_MAX_BYTES } from './mpc-contract.ts';
import { parseSettings, type SetupSettings } from './mpc-setups.ts';
import { parseSceneTiming, type SceneTiming } from './mpc-scene-clock.ts';
import { SORT_FIELDS, type SortKey } from './mpc-folder-query.ts';
/**
 * User folders, folder playback bundles and small UI state (docs/design/PRESET-BROWSER-V2.md 5). The page parser is the
 * authority; the hosts run only a shallow check. `folders.json` lives beside `setups.json`, which is unchanged, and an older
 * build that never heard of it simply ignores the file.
 */

export const FOLDER_LIMITS = {
  folders: 200, depth: 4, members: 5000, totalMembers: 30000, name: 120, id: 100, query: 400, key: 400, playback: 300, expanded: 300, sort: 3,
  bytes: STATE_MAX_BYTES,
} as const;

export interface UserFolder {
  id: string; name: string; parent: string | null; kind: 'manual' | 'smart';
  presets?: string[]; query?: string; scope?: string | null; sort?: SortKey[]; created: number;
}
export interface FolderPlayOptions { recursive: boolean; sort: SortKey[]; skipPartial?: boolean; settings?: SetupSettings; timing?: SceneTiming }
export interface FolderUi { expanded: string[]; selected: string | null; sort: SortKey[]; scopeAll: boolean }
export interface FolderState {
  version: 1; rev: number; folders: UserFolder[];
  playback: Record<string, FolderPlayOptions>;
  /** Entries that failed validation (for example options from a newer build), kept verbatim and written back unchanged. */
  opaquePlayback: Record<string, unknown>;
  last: { key: string; recursive: boolean } | null;
  ui: FolderUi;
}

export function emptyFolderState(): FolderState {
  return { version: 1, rev: 0, folders: [], playback: {}, opaquePlayback: {}, last: null, ui: { expanded: [], selected: null, sort: [], scopeAll: false } };
}

/** Thrown by `parseFolderState`; `newer` marks a file written by a later version, which is opened read-only. */
export class FolderStateError extends Error {
  constructor(message: string, readonly newer = false) { super(message); this.name = 'FolderStateError'; }
}

const HASH = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// A folder key starts with a known root, so `__proto__` and friends can never be a property name.
const KEY = /^(?:(?:avs|nerv|hud|smart|user)(?:\/[\s\S]*)?|(?:smart|user):[\s\S]+)$/;
export const isFolderKey = (v: unknown): v is string => typeof v === 'string' && v.length <= FOLDER_LIMITS.key && KEY.test(v);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const bad = (what: string): never => { throw new FolderStateError(`Invalid ${what}`); };

function sortSpec(v: unknown, what: string): SortKey[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > FOLDER_LIMITS.sort) return bad(what);
  return Array.from(v, item => {      // Array.from, not map: a sparse array must not slip a hole through
    if (!isObject(item) || typeof item.key !== 'string' || !(SORT_FIELDS as readonly string[]).includes(item.key) || (item.dir !== 'asc' && item.dir !== 'desc')) return bad(what);
    return { key: item.key as SortKey['key'], dir: item.dir };
  });
}

/** One playback bundle. Settings and timing use the setup validators, so anything a setup accepts is accepted here. */
function playbackEntry(v: unknown): FolderPlayOptions {
  if (!isObject(v)) return bad('folder options');
  if (v.recursive !== undefined && typeof v.recursive !== 'boolean') return bad('folder options');
  if (v.skipPartial !== undefined && typeof v.skipPartial !== 'boolean') return bad('folder options');
  const entry: FolderPlayOptions = { recursive: v.recursive !== false, sort: sortSpec(v.sort, 'folder options') };
  if (v.skipPartial === true) entry.skipPartial = true;
  try {
    if (v.settings !== undefined) entry.settings = parseSettings(v.settings);
    if (v.timing !== undefined) entry.timing = parseSceneTiming(v.timing);
  } catch { return bad('folder options'); }
  return entry;
}

/** Strict on structure and caps; throws `FolderStateError`. Unknown top-level fields are ignored. */
export function parseFolderState(value: unknown): FolderState {
  if (!isObject(value)) return bad('data');
  if (typeof value.version === 'number' && Number.isInteger(value.version) && value.version > 1) throw new FolderStateError('Saved folders come from a newer version', true);
  if (value.version !== 1) return bad('version');
  const state = emptyFolderState();
  if (value.rev !== undefined) { if (typeof value.rev !== 'number' || !Number.isSafeInteger(value.rev) || value.rev < 0) return bad('revision'); state.rev = value.rev; }
  const rows = value.folders === undefined ? [] : value.folders;
  if (!Array.isArray(rows) || rows.length > FOLDER_LIMITS.folders) return bad('folder list');
  const ids = new Set<string>();
  let total = 0;
  for (const row of rows) {
    if (!isObject(row)) return bad('folder');
    const id = row.id;
    if (typeof id !== 'string' || id.length < 1 || id.length > FOLDER_LIMITS.id || CONTROL.test(id) || ids.has(id)) return bad('folder id');
    ids.add(id);
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!name || (row.name as string).length > FOLDER_LIMITS.name || CONTROL.test(name)) return bad('folder name');
    if (row.parent !== null && row.parent !== undefined && typeof row.parent !== 'string') return bad('folder parent');
    if (row.kind !== 'manual' && row.kind !== 'smart') return bad('folder kind');
    if (typeof row.created !== 'number' || !Number.isFinite(row.created) || row.created < 0) return bad('folder date');
    const folder: UserFolder = { id, name, parent: (row.parent as string | null | undefined) ?? null, kind: row.kind, created: row.created };
    if (row.sort !== undefined) folder.sort = sortSpec(row.sort, 'folder sort');
    if (row.kind === 'manual') {
      const listed = row.presets === undefined ? [] : row.presets;
      if (!Array.isArray(listed) || listed.length > FOLDER_LIMITS.members) return bad('folder members');
      const presets: unknown[] = Array.from(listed);      // dense: a hole reads as undefined and is refused below
      if (presets.some(h => typeof h !== 'string' || !HASH.test(h)) || new Set(presets).size !== presets.length) return bad('folder members');
      total += presets.length;
      if (total > FOLDER_LIMITS.totalMembers) return bad('folder members');
      folder.presets = [...presets] as string[];
    } else {
      if (typeof row.query !== 'string' || row.query.length > FOLDER_LIMITS.query) return bad('folder query');
      folder.query = row.query;
      if (row.scope !== undefined && row.scope !== null && !isFolderKey(row.scope)) return bad('folder scope');
      folder.scope = (row.scope as string | null | undefined) ?? null;
    }
    state.folders.push(folder);
  }
  const byId = new Map(state.folders.map(f => [f.id, f] as const));
  for (const f of state.folders) {
    let depth = 1, at: UserFolder | undefined = f;
    while (at.parent !== null) {
      at = byId.get(at.parent);
      if (!at) return bad('folder parent');
      if (++depth > FOLDER_LIMITS.depth + 1 || at === f) return bad('folder nesting');
    }
    if (depth > FOLDER_LIMITS.depth) return bad('folder nesting');
  }
  const playback = value.playback === undefined ? {} : value.playback;
  if (!isObject(playback)) return bad('folder options');
  const keys = Object.keys(playback);
  if (keys.length > FOLDER_LIMITS.playback) return bad('folder options');
  for (const key of keys) {
    if (!isFolderKey(key)) return bad('folder options');
    try { state.playback[key] = playbackEntry(playback[key]); } catch { state.opaquePlayback[key] = playback[key]; }
  }
  // The last folder and the panel state are conveniences: a bad value resets them and never locks the file.
  const last = value.last;
  if (isObject(last) && isFolderKey(last.key) && typeof last.recursive === 'boolean') state.last = { key: last.key, recursive: last.recursive };
  if (isObject(value.ui)) {
    const ui = value.ui;
    state.ui.expanded = Array.isArray(ui.expanded) ? ui.expanded.filter(isFolderKey).slice(0, FOLDER_LIMITS.expanded) : [];
    state.ui.selected = isFolderKey(ui.selected) ? ui.selected : null;
    try { state.ui.sort = sortSpec(ui.sort, 'sort'); } catch { state.ui.sort = []; }
    state.ui.scopeAll = ui.scopeAll === true;
  }
  return state;
}

/** The exact JSON written to disk. Opaque entries are re-emitted unchanged. */
export function serializeFolderState(state: FolderState): Record<string, unknown> {
  const playback: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state.opaquePlayback)) playback[key] = value;
  for (const [key, o] of Object.entries(state.playback)) {
    playback[key] = { recursive: o.recursive, sort: o.sort, ...(o.skipPartial ? { skipPartial: true } : {}), ...(o.settings ? { settings: o.settings } : {}), ...(o.timing ? { timing: o.timing } : {}) };
  }
  return {
    version: 1, rev: state.rev,
    folders: state.folders.map(f => ({
      id: f.id, name: f.name, parent: f.parent, kind: f.kind,
      ...(f.kind === 'manual' ? { presets: f.presets ?? [] } : { query: f.query ?? '', scope: f.scope ?? null }),
      ...(f.sort ? { sort: f.sort } : {}), created: f.created,
    })),
    playback, last: state.last,
    ui: { expanded: state.ui.expanded, selected: state.ui.selected, sort: state.ui.sort, scopeAll: state.ui.scopeAll },
  };
}

export function utf8Length(text: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
  let n = 0;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3; }
  return n;
}

// -------------------------------------------------------------------------------------------------- edit helpers
// Each helper validates before it changes anything, so a failed edit leaves the state untouched, and throws an Error whose
// message is fit to show in the status line.

const okName = (name: unknown): string => {
  const text = typeof name === 'string' ? name.trim() : '';
  if (!text || (name as string).length > FOLDER_LIMITS.name || CONTROL.test(text)) throw new Error('A folder name needs 1 to 120 characters.');
  return text;
};
export const folderDepth = (state: FolderState, id: string): number => {
  let depth = 0, at = state.folders.find(f => f.id === id);
  while (at && depth <= FOLDER_LIMITS.depth + 1) { depth++; at = at.parent === null ? undefined : state.folders.find(f => f.id === at!.parent); }
  return depth;
};
export const totalMembers = (state: FolderState): number => state.folders.reduce((n, f) => n + (f.presets?.length ?? 0), 0);

export function createFolder(state: FolderState, input: { id: string; name: string; kind: 'manual' | 'smart'; parent?: string | null; query?: string; scope?: string | null; created: number }): UserFolder {
  if (state.folders.length >= FOLDER_LIMITS.folders) throw new Error(`At most ${FOLDER_LIMITS.folders} folders are supported.`);
  const name = okName(input.name);
  if (typeof input.id !== 'string' || !input.id || input.id.length > FOLDER_LIMITS.id || CONTROL.test(input.id) || state.folders.some(f => f.id === input.id)) throw new Error('Invalid folder id.');
  const parent = input.parent ?? null;
  if (parent !== null) {
    if (!state.folders.some(f => f.id === parent)) throw new Error('The parent folder no longer exists.');
    if (folderDepth(state, parent) >= FOLDER_LIMITS.depth) throw new Error(`Folders can be nested ${FOLDER_LIMITS.depth} levels deep.`);
  }
  const folder: UserFolder = { id: input.id, name, parent, kind: input.kind, created: input.created };
  if (input.kind === 'manual') folder.presets = [];
  else {
    const query = input.query ?? '';
    if (typeof query !== 'string' || query.length > FOLDER_LIMITS.query) throw new Error(`A saved search can hold ${FOLDER_LIMITS.query} characters.`);
    if (input.scope !== undefined && input.scope !== null && !isFolderKey(input.scope)) throw new Error('Invalid search scope.');
    folder.query = query; folder.scope = input.scope ?? null;
  }
  state.folders.push(folder);
  return folder;
}
export function renameFolder(state: FolderState, id: string, name: string): void {
  const folder = state.folders.find(f => f.id === id);
  if (!folder) throw new Error('That folder no longer exists.');
  folder.name = okName(name);
}
/** Deletes the folder, its subfolders and their options. Presets are never touched. Returns the ids removed. */
export function deleteFolder(state: FolderState, id: string): string[] {
  if (!state.folders.some(f => f.id === id)) throw new Error('That folder no longer exists.');
  const doomed = new Set([id]);
  for (let grew = true; grew;) { grew = false; for (const f of state.folders) if (f.parent !== null && doomed.has(f.parent) && !doomed.has(f.id)) { doomed.add(f.id); grew = true; } }
  state.folders = state.folders.filter(f => !doomed.has(f.id));
  for (const gone of doomed) {
    const key = `user:${gone}`;
    delete state.playback[key]; delete state.opaquePlayback[key];
    if (state.last?.key === key) state.last = null;
    if (state.ui.selected === key) state.ui.selected = null;
    state.ui.expanded = state.ui.expanded.filter(k => k !== key);
  }
  return [...doomed];
}
/** Appends unique hashes in order. Reports how many were added and how many were skipped (duplicates or over a limit). */
export function addMembers(state: FolderState, id: string, hashes: readonly string[]): { added: number; skipped: number } {
  const folder = state.folders.find(f => f.id === id);
  if (!folder || folder.kind !== 'manual') throw new Error('Presets can only be added to a manual folder.');
  const have = new Set(folder.presets), fresh: string[] = [];
  let skipped = 0, total = totalMembers(state);
  for (const hash of hashes) {
    if (typeof hash !== 'string' || !HASH.test(hash)) throw new Error('Invalid preset.');
    if (have.has(hash)) { skipped++; continue; }
    if (have.size >= FOLDER_LIMITS.members || total >= FOLDER_LIMITS.totalMembers) { skipped++; continue; }
    have.add(hash); fresh.push(hash); total++;
  }
  folder.presets = [...(folder.presets ?? []), ...fresh];
  return { added: fresh.length, skipped };
}
export function removeMembers(state: FolderState, id: string, hashes: readonly string[]): number {
  const folder = state.folders.find(f => f.id === id);
  if (!folder || folder.kind !== 'manual') throw new Error('Presets can only be removed from a manual folder.');
  const drop = new Set(hashes), before = folder.presets?.length ?? 0;
  folder.presets = (folder.presets ?? []).filter(h => !drop.has(h));
  return before - folder.presets.length;
}
/** Moves one member up or down in a manual folder's own order. */
export function moveMember(state: FolderState, id: string, hash: string, delta: -1 | 1): boolean {
  const folder = state.folders.find(f => f.id === id);
  if (!folder || folder.kind !== 'manual' || !folder.presets) throw new Error('Only a manual folder has an order.');
  const at = folder.presets.indexOf(hash), to = at + delta;
  if (at < 0 || to < 0 || to >= folder.presets.length) return false;
  [folder.presets[at], folder.presets[to]] = [folder.presets[to]!, folder.presets[at]!];
  return true;
}
/** Replaces a smart folder's saved search and scope. */
export function updateSearch(state: FolderState, id: string, query: string, scope: string | null): void {
  const folder = state.folders.find(f => f.id === id);
  if (!folder || folder.kind !== 'smart') throw new Error('Only a search folder has a saved search.');
  if (typeof query !== 'string' || query.length > FOLDER_LIMITS.query) throw new Error(`A saved search can hold ${FOLDER_LIMITS.query} characters.`);
  if (scope !== null && !isFolderKey(scope)) throw new Error('Invalid search scope.');
  folder.query = query; folder.scope = scope;
}
export function setPlayback(state: FolderState, key: string, options: FolderPlayOptions): void {
  if (!isFolderKey(key)) throw new Error('Invalid folder.');
  const validated = playbackEntry(options);
  if (!(key in state.playback) && !(key in state.opaquePlayback) && Object.keys(state.playback).length + Object.keys(state.opaquePlayback).length >= FOLDER_LIMITS.playback) throw new Error(`At most ${FOLDER_LIMITS.playback} folders can keep their own options.`);
  state.playback[key] = validated;
  delete state.opaquePlayback[key];
}
export function clearPlayback(state: FolderState, key: string): void { delete state.playback[key]; delete state.opaquePlayback[key]; }
export function setLast(state: FolderState, key: string, recursive: boolean): void {
  if (!isFolderKey(key)) throw new Error('Invalid folder.');
  state.last = { key, recursive };
}
export function setUi(state: FolderState, patch: Partial<FolderUi>): void {
  if (patch.expanded) state.ui.expanded = patch.expanded.filter(isFolderKey).slice(-FOLDER_LIMITS.expanded);
  if (patch.selected !== undefined) state.ui.selected = patch.selected !== null && isFolderKey(patch.selected) ? patch.selected : null;
  if (patch.sort) state.ui.sort = patch.sort.slice(0, FOLDER_LIMITS.sort);
  if (patch.scopeAll !== undefined) state.ui.scopeAll = patch.scopeAll === true;
}

// -------------------------------------------------------------------------------------------------- persistence

export interface Timers { set(fn: () => void, ms: number): number; clear(id: number): void }
/** The real timers, for callers that pass none. */
export const systemTimers = (): Timers => ({
  set: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clear: id => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
});

/**
 * One save in flight plus one coalesced pending save, for one state file. Explicit edits flush after 400 ms, UI-only changes
 * after 3 s of quiet (a longer delay can be passed, as statistics do). A failure keeps the data dirty and retries only on the
 * next mutation or an explicit `retry`. Requests reach the host as `{op, name}` objects, which the host prefixes with `library:`.
 */
export class StateChannel {
  dirty = false;
  inFlight = false;
  error = '';
  /** False while the file is read-only or the host does not support state files: edits then stay in memory. */
  enabled = true;
  private again = false;
  private timer: number | null = null;
  private timerKind: 'edit' | 'ui' | 'now' | null = null;
  constructor(readonly name: 'folders' | 'stats', private readonly send: (request: unknown) => void, private readonly timers: Timers,
    private readonly build: () => unknown, private readonly editDelay = 400, private readonly uiDelay = 3000) {}

  requestLoad(): void { this.send({ op: 'load-state', name: this.name }); }
  private clearTimer(): void { if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null; this.timerKind = null; } }
  /** True while a delayed flush is scheduled. */
  get scheduled(): boolean { return this.timer !== null; }
  /** `keepTimer` leaves an already scheduled flush in place (a throttle, for statistics) instead of restarting it (a debounce). */
  markDirty(kind: 'edit' | 'ui' | 'now', keepTimer = false): void {
    this.dirty = true;
    this.error = '';
    if (kind === 'now') { this.clearTimer(); this.flush(); return; }
    if (keepTimer && this.timer !== null) return;
    if (kind === 'ui' && this.timerKind === 'edit') return;
    this.clearTimer();
    this.timerKind = kind;
    this.timer = this.timers.set(() => { this.timer = null; this.timerKind = null; this.flush(); }, kind === 'edit' ? this.editDelay : this.uiDelay);
  }
  flush(): boolean {
    this.clearTimer();
    if (!this.enabled || !this.dirty) return false;
    if (this.inFlight) { this.again = true; return false; }
    const data = this.build();
    const bytes = utf8Length(JSON.stringify(data));
    if (bytes > FOLDER_LIMITS.bytes) { this.error = 'Saved data is too large to store.'; return false; }
    this.dirty = false; this.inFlight = true; this.again = false;
    this.send({ op: 'save-state', name: this.name, data });
    return true;
  }
  saved(): void {
    if (!this.inFlight) return;
    this.inFlight = false;
    if (this.again || this.dirty) { this.again = false; this.flush(); }
  }
  failed(message: string): void {
    if (!this.inFlight) return;
    this.inFlight = false; this.dirty = true; this.again = false; this.error = message;
  }
  retry(): void { this.error = ''; if (this.dirty) this.flush(); }
  dispose(): void { this.clearTimer(); }
}

export type StoreStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'readonly';
const UNSUPPORTED = /unknown (?:library request|state file)/i;
/**
 * A host's `library-error` names only the operation, so a store acts on a load error only while its own load is pending and on a
 * save error only while its own save is in flight. A host that also reports the state `name` (object payload `{message, name}`)
 * is honoured: an error for the other file is not ours. `text` is the message to show.
 */
export function stateErrorFor(name: 'folders' | 'stats', payload: unknown): { mine: boolean; text: string } {
  if (isObject(payload)) return { mine: typeof payload.name !== 'string' || payload.name === name, text: String(payload.message ?? '') };
  return { mine: true, text: String(payload) };
}
export const isUnsupportedState = (text: string): boolean => UNSUPPORTED.test(text);

/**
 * Holds the parsed state and talks to the host. Mutations go through `mutate`; views re-read `state` after each change
 * (`onChange` fires). On an old host the store reports `unavailable` and works session-only; on an unreadable or newer
 * file it reports `readonly` and never overwrites anything until the owner chooses Reset.
 */
export class FolderStore {
  status: StoreStatus = 'idle';
  /** Why the store is read-only or unavailable, or the last save error; empty when healthy. */
  notice = '';
  onChange: (() => void) | null = null;
  private current: FolderState = emptyFolderState();
  private readonly channel: StateChannel;
  constructor(send: (request: unknown) => void, timers: Timers = systemTimers()) {
    this.channel = new StateChannel('folders', send, timers, () => { this.current.rev++; return serializeFolderState(this.current); });
  }
  get state(): FolderState { return this.current; }
  get canEdit(): boolean { return this.status === 'ready' || this.status === 'unavailable'; }
  get dirty(): boolean { return this.channel.dirty; }
  get saving(): boolean { return this.channel.inFlight; }
  get saveError(): string { return this.channel.error; }
  private changed(): void { try { this.onChange?.(); } catch { /* a view error must not break persistence */ } }

  /** Ask the host for the file. Skipped while unsaved edits or a save exist, so a reload never discards them. */
  load(): void {
    if (this.channel.dirty || this.channel.inFlight) return;
    if (this.status === 'unavailable') return;
    this.status = 'loading';
    this.channel.requestLoad();
    this.changed();
  }
  /** Returns true when the message was for this store. `payload` is the host message (state-loaded, state-saved) or the error text. */
  receive(type: string, payload: unknown, operation?: string): boolean {
    if (type === 'state-loaded' || type === 'state-saved') {
      const name = isObject(payload) && typeof payload.name === 'string' ? payload.name : 'folders';
      if (name !== 'folders') return false;
    }
    if (type === 'state-loaded') {
      if (this.channel.dirty || this.channel.inFlight) { this.status = this.status === 'loading' ? 'ready' : this.status; this.changed(); return true; }
      const data = isObject(payload) ? payload.data : undefined;
      if (data === null || data === undefined) { this.current = emptyFolderState(); this.status = 'ready'; this.notice = ''; this.channel.enabled = true; this.changed(); return true; }
      try {
        this.current = parseFolderState(data); this.status = 'ready'; this.notice = ''; this.channel.enabled = true;
      } catch (error) {
        this.current = emptyFolderState(); this.status = 'readonly'; this.channel.enabled = false;
        this.notice = error instanceof FolderStateError && error.newer
          ? 'Saved folders come from a newer version; editing is disabled to protect them.'
          : `Saved folders could not be read (${error instanceof Error ? error.message : 'invalid data'}). Editing is disabled; Reset folders replaces them with an empty set.`;
      }
      this.changed();
      return true;
    }
    if (type === 'state-saved') { this.channel.saved(); this.changed(); return true; }
    if (type === 'library-error' && operation === 'load-state') {
      const { mine, text } = stateErrorFor('folders', payload);
      if (!mine || this.status !== 'loading') return false;
      if (UNSUPPORTED.test(text)) { this.status = 'unavailable'; this.channel.enabled = false; this.notice = 'Folder persistence unavailable (session only).'; }
      else { this.status = 'readonly'; this.channel.enabled = false; this.notice = `Saved folders could not be loaded (${text}). Editing is disabled until they load; Reset folders replaces them.`; }
      this.changed();
      return true;
    }
    if (type === 'library-error' && operation === 'save-state') {
      const { mine, text } = stateErrorFor('folders', payload);
      if (!mine || !this.channel.inFlight) return false;
      this.channel.failed(text);
      this.changed();
      return true;
    }
    return false;
  }
  /** Apply an explicit edit. Returns false (and sets `notice`) when the store is read-only or the change is refused. */
  mutate(change: (state: FolderState) => void, immediate = false): boolean {
    if (!this.canEdit) return false;
    try { change(this.current); } catch (error) { this.notice = error instanceof Error ? error.message : String(error); this.changed(); return false; }
    if (this.status === 'unavailable') { this.changed(); return true; }
    this.notice = '';
    this.channel.markDirty(immediate ? 'now' : 'edit');
    this.changed();
    return true;
  }
  /** A UI-only change (expansion, selection, sort): flushed after three quiet seconds or on the next explicit edit. */
  mutateUi(change: (state: FolderState) => void): boolean {
    if (!this.canEdit) return false;
    try { change(this.current); } catch { return false; }
    if (this.status !== 'unavailable') this.channel.markDirty('ui');
    return true;
  }
  flush(): void { this.channel.flush(); this.changed(); }
  retry(): void { this.channel.retry(); this.changed(); }
  /** Replace everything with an empty set and save it. This is the only way out of read-only mode. */
  reset(): void {
    // The channel counts the save itself (`rev` is bumped when the data is built), so the counter is only carried over here.
    this.current = { ...emptyFolderState(), rev: this.current.rev };
    if (this.status === 'readonly') { this.status = 'ready'; this.notice = ''; this.channel.enabled = true; }
    if (this.status !== 'unavailable') this.channel.markDirty('now');
    this.changed();
  }
  dispose(): void { this.channel.dispose(); }
}
