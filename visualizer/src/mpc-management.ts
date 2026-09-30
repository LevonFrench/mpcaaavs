import type { HudTitleMap, LocalAvsPreset, SourceMap } from './avs/local-collection.ts';
import { fetchLocalHudTitles, type TaxonMap } from './avs/preset-categories.ts';
import { parseSetups, type PresetSetup, type SetupSettings } from './mpc-setups.ts';
import { defaultSceneTiming, type SceneTiming } from './mpc-scene-clock.ts';
import { renderPlaybackControls, type PlaybackControlsContext } from './mpc-playback-controls.ts';
import { BROWSER_HELP, BrowserView, keepFocusWithin, type BrowserData, type BrowserOptions } from './mpc-browser-view.ts';
import { FolderStore, systemTimers, type Timers } from './mpc-folder-store.ts';
import { StatsStore } from './mpc-folder-stats.ts';
import { SETUP_LIMIT, type FolderPlayPlan, type PlaySource } from './mpc-folder-play.ts';
import { DISPLAY_FIELDS, type DisplayField, type DisplayPrefs } from './mpc-display.ts';
import { TRANSITIONS } from './mpc-transition.ts';

/**
 * The host contract of the Preset Manager (docs/design/CONTRACT.md 2.3.7). Every member after `close` is optional: with one absent the
 * control that needs it is disabled and says why, and nothing throws. `titles` and `timing` are two more optional members with a working
 * default (the manager loads the local title overlay itself; the folder options save the clock as off), recorded as amendments.
 */
export interface Actions {
  catalog(): readonly LocalAvsPreset[]; current(): number; settings(): SetupSettings;
  load(index: number): void; rate(index: number, value: number): void; markNotWorking(index: number, notWorking: boolean): void;
  setMinimumRating(value: number): void; send(value: unknown): void; activate(setup: PresetSetup | null): void; panel(mode: number): void; close(): void;
  /** Template buttons of the Setup Builder; `hudSetup` is supplied with the HUD packs and returns null when none are installed. */
  nervSetup?(): PresetSetup; hudSetup?(): PresetSetup | null;
  sources?(): Promise<SourceMap>; taxa?(): TaxonMap | null; failedIndices?(): ReadonlySet<number>;
  /** Local overlay of real HUD titles (owner directive C). Absent: the manager loads it itself when the catalog holds HUD scenes. */
  titles?(): HudTitleMap | null | Promise<HudTitleMap | null>;
  playFolder?(plan: FolderPlayPlan): { ok: true; eligible: number } | { ok: false; reason: string };
  stopFolder?(): void; source?(): PlaySource;
  /** The live scene clock, so Save current settings keeps it. Absent: the clock is saved as off. */
  timing?(): SceneTiming | null;
  position?(): number; playing?(): boolean; tempo?(): { locked: boolean; bpm: number; phase: number };
  display?(): DisplayPrefs; setDisplay?(patch: Partial<DisplayPrefs>): void;
}
/** Injectable time, timers, ids and confirmation, so the CPU checks need no clock and the host needs no extra wiring. */
export interface ManagementEnv { now?(): number; timers?: Timers; newId?(): string; confirm?(text: string): boolean }

/** How long the first open waits for the optional local data (sources, title overlay) before building the browser without it. */
export const DATA_WAIT_MS = 2000;
/** How long Ctrl+F8 waits for the saved folder state before it opens the browser instead. */
export const LAST_WAIT_MS = 1500;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag); e.textContent = text; e.className = className; return e;
};
const thenable = (v: unknown): v is PromiseLike<unknown> => !!v && typeof (v as { then?: unknown }).then === 'function';
function defaultId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return typeof c?.randomUUID === 'function' ? c.randomUUID() : `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/**
 * Lazy management view: opening it does not create a renderer or audio context. Mode 1 is the Preset Browser (folders, search, sort,
 * Play folder) with the focused preset's controls; mode 2 is the Setup Builder, the same browser with the builder and its timing controls
 * below the preset controls. The skeleton is built once and patched afterwards, so the search box and every field keep their identity.
 */
export class PresetManagement {
  private root: HTMLElement | null = null;
  private mode = 0;
  private selected = -1;
  private sets: PresetSetup[] = [];
  private loaded = false;
  private pending: PresetSetup[] | null = null;
  private draft: PresetSetup | null = null;
  private dirty = false;
  private feedback = '';
  private readonly timers: Timers;
  private readonly store: FolderStore;
  private readonly stats: StatsStore;
  private view: BrowserView | null = null;
  private data: BrowserData;
  private waiting = false;
  private titlesRequested = false;
  private statsDirty = false;
  private wantFolders = false;
  private wantStats = false;
  private wantLast = false;
  private lastTimer: number | null = null;
  private laid: HTMLElement | null = null;
  private itemSig = '';
  private names = new Map<string, string>();
  private namesFor: readonly LocalAvsPreset[] | null = null;
  // skeleton
  private framed = false;
  private readonly title = el('h1');
  private readonly switchBtn = el('button');
  private readonly closeBtn = el('button', 'Close · Esc');
  private readonly displayRow = el('div', '', 'library-tools display-tools');
  private readonly displayReason = el('span', '', 'ab-reason');
  private readonly displaySelects = new Map<string, HTMLSelectElement>();
  private readonly shuffleRow = el('div', '', 'library-tools');
  private readonly shuffleSel = el('select');
  private readonly placeholder = el('p', 'Loading presets…');
  private readonly feedbackEl = el('p');
  private readonly foot = el('footer');
  private readonly header = el('header');

  constructor(private a: Actions, private env: ManagementEnv = {}) {
    this.timers = env.timers ?? systemTimers();
    const send = (request: unknown): void => this.a.send(request);
    this.store = new FolderStore(send, this.timers);
    this.stats = new StatsStore(send, this.timers);
    this.data = { stats: this.stats.stats };
    this.store.onChange = () => this.stateChanged();
    this.stats.onChange = () => this.stateChanged();
  }

  get open(): boolean { return this.mode !== 0; }
  private now(): number { return this.env.now ? this.env.now() : Date.now(); }
  private newId(): string { return (this.env.newId ?? defaultId)(); }
  private confirm(text: string): boolean {
    if (this.env.confirm) return this.env.confirm(text);
    const g = globalThis as { window?: { confirm?: (t: string) => boolean }; confirm?: (t: string) => boolean };
    const fn = g.window?.confirm ?? g.confirm;
    return typeof fn === 'function' ? fn.call(g.window ?? g, text) : false;
  }
  private say(text: string): void { this.feedback = text; this.feedbackEl.textContent = text; }
  private button(text: string, action: () => void, disabled = false, label?: string): HTMLButtonElement {
    const b = el('button', text); b.type = 'button'; b.disabled = disabled; b.onclick = () => action();
    if (label) b.setAttribute('aria-label', label);
    return b;
  }

  // ------------------------------------------------------------------------------------------------------------ opening and closing

  show(mode: number): void {
    if (!this.root) this.root = document.querySelector<HTMLElement>('#management');
    if (!this.root) return;
    const opening = mode !== 0 && this.mode === 0;
    this.mode = mode; this.root.hidden = !mode; this.a.panel(mode);
    if (!mode) { this.store.flush(); this.stats.save(); return; }
    if (opening) this.selected = this.a.current();
    this.frame();
    this.title.textContent = mode === 1 ? 'Preset Manager' : 'Setup Builder';
    this.switchBtn.textContent = mode === 1 ? 'Setup Builder · Ctrl+F7' : 'Preset Manager · Ctrl+F6';
    this.startView();
    this.layout();
    this.syncTop();
    this.view?.refresh();
    this.applyStats();
    this.drawItem();
    this.wantFolders = true; this.pump();
    // The library request comes last: it is the one the host answers for the Setup Builder.
    if (!this.loaded) this.a.send({ op: 'load-setups' });
    if (this.view) this.view.focusTree(); else this.switchBtn.focus?.();
    if (opening) this.root.scrollTop = 0;
  }

  /** Builds the fixed parts once: header, Display row, shuffle threshold, footer. */
  private frame(): void {
    if (this.framed) return;
    this.framed = true;
    this.switchBtn.type = 'button'; this.switchBtn.onclick = () => this.show(this.mode === 1 ? 2 : 1);
    this.closeBtn.type = 'button'; this.closeBtn.onclick = () => { this.show(0); this.a.close(); };
    this.header.append(this.title, this.switchBtn, this.closeBtn);
    // Display: the five device-local preferences (render quality, AVS resolution, pixel-art scaling, FPS text, timing overlay).
    this.displayRow.setAttribute('role', 'group'); this.displayRow.setAttribute('aria-label', 'Display');
    this.displayRow.append(el('strong', 'Display'));
    for (const f of DISPLAY_FIELDS) {
      const label = el('label', `${f.label} `), select = el('select');
      select.setAttribute('aria-label', f.label);
      f.labels.forEach((text, i) => { const o = el('option', text); o.value = String(i); select.append(o); });
      select.onchange = () => this.chooseDisplay(f, Number(select.value));
      label.append(select); this.displayRow.append(label); this.displaySelects.set(f.key, select);
    }
    this.displayRow.append(this.displayReason);
    // Shuffle minimum rating: the live setting (independent of the list filter inside the browser).
    const shuffleLabel = el('label', 'Shuffle minimum rating ');
    this.shuffleSel.setAttribute('aria-label', 'Shuffle minimum rating');
    for (let n = 0; n <= 5; n++) { const option = el('option', n ? `${n}+ stars` : 'All ratings, including unrated'); option.value = String(n); this.shuffleSel.append(option); }
    this.shuffleSel.onchange = () => this.a.setMinimumRating(Number(this.shuffleSel.value));
    shuffleLabel.append(this.shuffleSel);
    this.shuffleRow.append(shuffleLabel, el('span', 'Applies to random selection. Marked presets are skipped automatically.'));
    this.feedbackEl.setAttribute('role', 'status'); this.feedbackEl.textContent = this.feedback;
    this.foot.append(this.feedbackEl, el('p', 'Current preset: F6 lower rating · F7 raise rating · F8 mark not working. Ratings rename the file and update Date modified. Clear a not-working mark in the preset details.'));
    const help = el('details');
    help.append(el('summary', 'Keyboard shortcuts'), el('p', 'Ctrl+F6 Preset Manager · Ctrl+F7 Setup Builder · Ctrl+F8 play the last folder · F6 / F7 rating · F8 mark not working · Escape close · Space play/pause · Alt+Enter fullscreen. mpc-hc-aaavs views use Ctrl+0–9. Options → Player → Keys lists and customizes every player command. Text fields keep their normal typing keys.'), el('p', BROWSER_HELP));
    this.foot.append(help);
  }
  /** Places the skeleton and the browser (or the loading note) in the panel when the body changed. */
  private layout(): void {
    if (!this.root) return;
    const body = this.view ? this.view.root : this.placeholder;
    if (this.laid === body) return;
    this.laid = body;
    this.root.replaceChildren(this.header, this.displayRow, this.shuffleRow, body, this.foot);
  }
  /** The parts that follow the live settings: the shuffle threshold and the Display row. */
  private syncTop(): void {
    this.shuffleSel.value = String(this.a.settings().minimumRating);
    this.syncDisplay();
  }
  private syncDisplay(): void {
    const prefs = this.a.display?.(), usable = !!prefs && !!this.a.setDisplay;
    for (const f of DISPLAY_FIELDS) {
      const select = this.displaySelects.get(f.key);
      if (!select) continue;
      const current: unknown = prefs ? prefs[f.key] : undefined;
      const index = typeof current === 'number' ? current : f.values.indexOf(String(current));
      select.value = String(index >= 0 && index < f.labels.length ? index : 0);
      select.disabled = !usable;
    }
    this.displayReason.textContent = !this.a.display ? 'Display settings are not available in this host.' : !this.a.setDisplay ? 'Display settings can be read here but not changed.' : '';
  }
  private chooseDisplay(field: DisplayField, index: number): void {
    const value = field.key === 'showFps' || field.key === 'timingOverlay' ? index : field.values[index];
    if (value === undefined || !this.a.setDisplay) return;
    this.a.setDisplay({ [field.key]: value } as Partial<DisplayPrefs>);
    this.say(`${field.label}: ${field.labels[index] ?? value}.`);
    this.syncDisplay();
  }

  // ------------------------------------------------------------------------------------------------------------ refresh

  /** Cheap patch: the host calls this on every rating, mark, shuffle change and preset change. */
  refresh(): void {
    if (this.view) { this.syncTaxa(); this.requestTitles(); }
    if (!this.open) return;
    this.syncTop();
    this.view?.refresh();
    this.applyStats();
    if (this.itemSignature() !== this.itemSig) this.drawItem();
  }

  // ------------------------------------------------------------------------------------------------------------ optional local data

  private syncTaxa(): void {
    if (!this.a.taxa) return;
    const taxa = this.a.taxa() ?? null;
    if (taxa !== (this.data.taxa ?? null)) this.applyData({ taxa });
  }
  private applyData(patch: BrowserData): void {
    this.data = { ...this.data, ...patch };
    this.view?.setData(patch);
  }
  /** The title overlay: from the host, else loaded here, and only when the catalog holds HUD scenes. Returns a promise while it is pending. */
  private requestTitles(): Promise<unknown> | null {
    if (this.titlesRequested) return null;
    const custom = this.a.titles;
    if (!custom && !this.a.catalog().some(p => p.kind === 'hud')) return null;
    this.titlesRequested = true;
    let result: HudTitleMap | null | Promise<HudTitleMap | null>;
    try { result = custom ? custom.call(this.a) : fetchLocalHudTitles(); } catch { result = null; }
    if (!thenable(result)) { this.applyData({ titles: result ?? null }); return null; }
    return Promise.resolve(result).then(map => { this.applyData({ titles: (map as HudTitleMap | null) ?? null }); }, () => { this.applyData({ titles: null }); });
  }
  private requestData(): Promise<unknown> | null {
    const list: Promise<unknown>[] = [];
    try {
      const sources = this.a.sources?.();
      if (sources) list.push(Promise.resolve(sources).then(map => { this.applyData({ sources: map }); }, () => { /* no artist level */ }));
    } catch { /* the folders simply have no artist level */ }
    const titles = this.requestTitles();
    if (titles) list.push(titles);
    return list.length ? Promise.all(list) : null;
  }

  // ------------------------------------------------------------------------------------------------------------ the browser

  /** Builds the browser at the first open, after the optional data arrived or a short wait ran out; opens at once when none is asynchronous. */
  private startView(): void {
    if (this.view || this.waiting) return;
    this.syncTaxa();
    const pending = this.requestData();
    if (!pending) { this.buildView(); return; }
    this.waiting = true;
    let done = false, timer = 0;
    const finish = (): void => {
      if (done) return;
      done = true; this.timers.clear(timer); this.waiting = false;
      if (!this.view) this.buildView();
      if (this.open) { this.layout(); this.view?.refresh(); this.drawItem(); if (this.mode) this.view?.focusTree(); }
      this.tryLast(false);
    };
    timer = this.timers.set(finish, DATA_WAIT_MS);
    pending.then(finish, finish);
  }

  private tempoNow(): number | null {
    const t = this.a.tempo?.();
    return t && t.locked && Number.isFinite(t.bpm) ? t.bpm : null;
  }
  private controlsContext(): PlaybackControlsContext {
    const a = this.a;
    // The end and peak anchors and the quantized manual queue need host behaviour that lands later; the controls say so until then.
    const ctx: PlaybackControlsContext = { knows: hash => this.known().has(hash), anchors: false, quantizedQueue: false };
    if (a.position) ctx.position = () => a.position!();
    if (a.playing) ctx.playing = () => a.playing!();
    if (a.tempo) ctx.tempo = () => a.tempo!();
    return ctx;
  }
  private buildView(): BrowserView {
    const a = this.a;
    const options: BrowserOptions = {
      catalog: () => a.catalog(), current: () => a.current(), store: this.store,
      load: i => a.load(i), rate: (i, n) => a.rate(i, n), markNotWorking: (i, v) => a.markNotWorking(i, v),
      settings: () => a.settings(), timing: () => a.timing?.() ?? null, tempo: () => this.tempoNow(), styles: TRANSITIONS.length,
      controls: (host, settings, timing, onDirty) => renderPlaybackControls(host, settings, timing, onDirty, 'Folder', this.controlsContext()),
      onFocus: (index, reason) => this.focused(index, reason), onSelect: () => this.selectionChanged(),
      saveAsSetup: (name, hashes, omitted) => this.saveFolderAsSetup(name, hashes, omitted),
      confirm: text => this.confirm(text), timers: this.timers, now: () => this.now(), newId: () => this.newId(), data: { ...this.data },
    };
    if (a.playFolder) options.playFolder = plan => a.playFolder!(plan);
    if (a.stopFolder) options.stopFolder = () => a.stopFolder!();
    if (a.source) options.source = () => a.source!();
    if (a.failedIndices) options.failed = () => a.failedIndices!();
    this.view = new BrowserView(options);
    return this.view;
  }
  /** The focused row of the list became the preset the item controls act on. Losing the focus (a filter, another folder) keeps the last preset. */
  private focused(index: number, _reason: 'focus' | 'refresh'): void {
    if (index >= 0) this.selected = index;
    if (this.open) this.drawItem();
  }
  private selectionChanged(): void { if (this.open && this.itemSignature() !== this.itemSig) this.drawItem(); }

  // ------------------------------------------------------------------------------------------------------------ saved state (folders, statistics)

  /** Loads one state file at a time, so an error that names only its operation can only belong to the load in flight. */
  private pump(): void {
    for (let guard = 0; guard < 3; guard++) {
      if (this.store.status === 'loading' || this.stats.status === 'loading') return;
      if (this.wantFolders) { this.wantFolders = false; this.store.load(); continue; }
      if (this.wantStats) { this.wantStats = false; this.stats.load(); continue; }
      return;
    }
  }
  private stateChanged(): void {
    this.statsDirty = true;
    this.pump();
    this.tryLast(false);
  }
  private applyStats(): void {
    if (!this.statsDirty || !this.view) return;
    this.statsDirty = false;
    this.view.setData({ stats: this.stats.stats });
  }
  /** A preset became current (the host calls this from `commit`). Counts a play once it has run long enough; the file loads on the first call. */
  noteCommit(index: number, playing: boolean): void {
    const p = this.a.catalog()[index];
    if (!p) return;
    this.wantStats = true; this.pump();
    this.stats.commit(p.sha256, playing, this.now());
  }
  /** Pause and resume, so paused time does not count as play time. */
  notePlaying(playing: boolean): void { this.stats.setPlaying(playing, this.now()); }

  /**
   * Ctrl+F8: replays the last folder, or opens the browser on the folder tree when there is none. Returns true when a play was started or is
   * waiting for the saved state to arrive; false when it opened the browser instead.
   */
  playLastFolder(): boolean {
    this.wantLast = true;
    if (this.store.status === 'idle') { this.wantFolders = true; this.pump(); }
    this.startView();
    if (this.lastTimer === null && this.wantLast) this.lastTimer = this.timers.set(() => { this.lastTimer = null; this.tryLast(true); }, LAST_WAIT_MS);
    return this.tryLast(false);
  }
  private tryLast(force: boolean): boolean {
    if (!this.wantLast) return false;
    const status = this.store.status;
    if (!force && (status === 'idle' || status === 'loading' || !this.view)) return true;
    this.wantLast = false;
    if (this.lastTimer !== null) { this.timers.clear(this.lastTimer); this.lastTimer = null; }
    const view = this.view ?? this.buildView();
    if (view.playLast()) return true;
    this.show(1);
    return false;
  }

  // ------------------------------------------------------------------------------------------------------------ messages from the host

  receive(type: string, payload: unknown, operation?: string): void {
    // The folder and statistics files: routed to their stores, never announced (an old host answers `Unknown library request`).
    if (type === 'state-loaded' || type === 'state-saved' || (type === 'library-error' && (operation === 'load-state' || operation === 'save-state'))) {
      this.store.receive(type, payload, operation);
      this.stats.receive(type, payload, operation);
      this.pump();
      if (this.open) this.applyStats();
      return;
    }
    try {
      if (type === 'setups-loaded') { this.sets = parseSetups(payload); this.loaded = true; }
      if (type === 'setups-saved' && this.pending) {
        this.sets = this.pending; this.pending = null;
        this.dirty = JSON.stringify(this.draft) !== JSON.stringify(this.sets.find(s => s.id === this.draft?.id));
        this.say('Setup saved to disk.');
      }
      if (type === 'library-error') { if (operation === 'save-setups') this.pending = null; this.say(String(payload)); }
    } catch (error) { this.say(String(error)); }
    if (this.open) { this.syncTop(); this.view?.refresh(); this.drawItem(); }
  }

  /** Stops listening and cancels timers. The panel is left as it is. */
  dispose(): void {
    if (this.lastTimer !== null) this.timers.clear(this.lastTimer);
    this.lastTimer = null; this.wantLast = false;
    this.view?.dispose();
    this.store.dispose(); this.stats.dispose();
  }

  // ------------------------------------------------------------------------------------------------------------ the focused preset and the Setup Builder

  private known(): Map<string, string> {
    const catalog = this.a.catalog();
    if (this.namesFor !== catalog) { this.names = new Map(catalog.map(p => [p.sha256, p.name] as const)); this.namesFor = catalog; }
    return this.names;
  }
  private multi(): number {
    const view = this.view;
    return view && view.selectedCount > 1 ? view.selectedIndices().length : 0;
  }
  private itemSignature(): string {
    const p = this.a.catalog()[this.selected];
    return [this.mode, this.selected, this.multi(), this.view ? 1 : 0, p ? [p.sha256, p.name, p.rating ?? 0, p.notWorking ? 1 : 0, p.autoEligible ? 1 : 0, p.unavailableReason ?? ''].join('|') : '-'].join('#');
  }
  private drawItem(): void {
    const view = this.view;
    if (!view) return;
    keepFocusWithin(view.itemSlot, () => this.paintItem(view.itemSlot), view.itemSlot);
  }
  private paintItem(slot: HTMLElement): void {
    slot.replaceChildren();
    const catalog = this.a.catalog();
    const index = this.selected, selected = catalog[index];
    const bulk = this.multi();
    if (this.mode === 2 && bulk > 1) slot.append(this.button(`Add ${bulk} to setup`, () => this.addToSetup(this.view!.selectedIndices()), false, 'Add to setup'));
    if (selected) {
      slot.append(el('h2', this.view?.displayName(index) || selected.name), el('p', selected.fileName ?? ''));
      const stars = el('div', '', 'library-tools');
      for (let n = 1; n <= 5; n++) {
        const b = this.button(`${n} ★`, () => this.a.rate(index, n));
        b.setAttribute('aria-label', `Rate ${n} stars`); b.setAttribute('aria-pressed', String(selected.rating === n)); stars.append(b);
      }
      slot.append(stars, this.button('Load preset', () => this.a.load(index), !selected.autoEligible));
      slot.append(this.button(selected.notWorking ? 'Clear not-working mark' : 'Mark not working', () => this.a.markNotWorking(index, !selected.notWorking)));
      if (selected.notWorking) slot.append(el('p', 'Marked not working. Skipped by automatic and random selection; Load preset lets you retest it.'));
      if (!selected.autoEligible) slot.append(el('p', selected.unavailableReason ?? 'This preset cannot be parsed.'));
      if (this.mode === 2 && bulk <= 1) slot.append(this.button('Add to setup', () => this.addToSetup([index])));
    }
    if (this.mode === 2) this.builder(slot);
    this.itemSig = this.itemSignature();
  }

  private newDraft(): void {
    this.draft = { id: this.newId(), name: 'New setup', presets: [], settings: { ...this.a.settings() }, timing: { ...defaultSceneTiming } };
    this.dirty = true; this.drawItem();
  }
  private abandon(): boolean { return !this.dirty || this.confirm('Discard unsaved setup changes?'); }
  /** Adds presets to the draft in the order given, up to the 500 a saved setup holds. */
  private addToSetup(indices: readonly number[]): void {
    if (!this.draft) this.newDraft();
    const draft = this.draft!, catalog = this.a.catalog();
    if (draft.presets.length >= SETUP_LIMIT) { this.say(`A setup can hold up to ${SETUP_LIMIT} presets.`); this.drawItem(); return; }
    const have = new Set(draft.presets);
    let added = 0, duplicates = 0, capped = 0;
    for (const i of indices) {
      const p = catalog[i];
      if (!p) continue;
      if (have.has(p.sha256)) { duplicates++; continue; }
      if (draft.presets.length >= SETUP_LIMIT) { capped++; continue; }
      draft.presets.push(p.sha256); have.add(p.sha256); added++;
    }
    if (added) this.dirty = true;
    if (indices.length > 1 || capped) this.say(`Added ${added} of ${indices.length}${duplicates ? `; ${duplicates} already in the setup` : ''}${capped ? `; a setup holds up to ${SETUP_LIMIT} presets` : ''}.`);
    this.drawItem();
  }
  /** "Save folder as setup": the first 500 playable members of the folder become a saved setup. Returns the message the browser shows. */
  private saveFolderAsSetup(name: string, hashes: string[], omitted: number): string {
    if (!this.loaded) return 'Saved setups are still loading. Try again in a moment.';
    if (this.pending) return 'Another setup is being saved. Try again in a moment.';
    const setup: PresetSetup = { id: this.newId(), name: name.slice(0, 120) || 'Folder', presets: hashes, settings: { ...this.a.settings() }, timing: { ...defaultSceneTiming } };
    try {
      const next = parseSetups([...structuredClone(this.sets), setup]);
      this.pending = next;
      this.a.send({ op: 'save-setups', setups: next });
    } catch (error) { this.pending = null; return String(error instanceof Error ? error.message : error); }
    return `Saving setup "${setup.name}" with ${hashes.length.toLocaleString('en-US')} presets${omitted ? `; ${omitted.toLocaleString('en-US')} more do not fit (a setup holds up to ${SETUP_LIMIT})` : ''}.`;
  }
  /** Loads a template into the draft, after the owner confirms discarding unsaved changes. */
  private useTemplate(make: () => PresetSetup | null, ready: string, missing: string): void {
    if (!this.abandon()) return;
    let setup = make();
    if (!setup) { this.say(missing); return; }
    let note = '';
    if (setup.presets.length > SETUP_LIMIT) { setup = { ...setup, presets: setup.presets.slice(0, SETUP_LIMIT) }; note = ` Only the first ${SETUP_LIMIT} scenes fit in a setup.`; }
    this.draft = structuredClone(setup); this.dirty = true;
    this.say(ready + note);
    this.drawItem();
  }

  private builder(detail: HTMLElement): void {
    detail.append(el('h2', 'Saved setups'));
    const pick = el('select');
    pick.setAttribute('aria-label', 'Saved setups');
    pick.append(el('option', 'Choose a setup…'));
    for (const s of this.sets) { const o = el('option', s.name); o.value = s.id; pick.append(o); }
    pick.value = this.draft?.id ?? '';
    pick.onchange = () => {
      const s = this.sets.find(x => x.id === pick.value);
      if (s && this.abandon()) { this.draft = structuredClone(s); this.dirty = false; }
      this.drawItem();
    };
    detail.append(pick, this.button('New setup', () => { if (this.abandon()) this.newDraft(); }, !this.loaded));
    if (this.a.nervSetup) detail.append(this.button('NERV scene set', () => this.useTemplate(() => this.a.nervSetup!(), 'NERV scene set ready. Set the song BPM and offset, then activate or save.', 'The NERV scenes are not installed.'), !this.loaded));
    if (this.a.hudSetup) detail.append(this.button('HUD scene set', () => this.useTemplate(() => this.a.hudSetup!(), 'HUD scene set ready. Set the song BPM and offset, then activate or save.', 'No HUD scenes are installed.'), !this.loaded));
    if (!this.loaded) detail.append(el('p', 'Loading saved setups…'));
    if (!this.draft) return;
    const draft = this.draft;
    const name = el('input');
    name.value = draft.name; name.maxLength = 120; name.setAttribute('aria-label', 'Setup name');
    name.oninput = () => { draft.name = name.value; this.dirty = true; };
    detail.append(name);
    this.known();
    const ordered = el('ol');
    draft.presets.forEach((hash, i) => {
      const row = el('li');
      row.append(el('span', this.names.get(hash) ?? 'Missing preset'),
        this.button('↑', () => { [draft.presets[i - 1], draft.presets[i]] = [draft.presets[i]!, draft.presets[i - 1]!]; this.dirty = true; this.drawItem(); }, i === 0),
        this.button('↓', () => { [draft.presets[i + 1], draft.presets[i]] = [draft.presets[i]!, draft.presets[i + 1]!]; this.dirty = true; this.drawItem(); }, i === draft.presets.length - 1),
        this.button('Remove', () => { draft.presets.splice(i, 1); this.dirty = true; this.drawItem(); }));
      ordered.append(row);
    });
    detail.append(ordered);
    if (!draft.presets.length) detail.append(el('p', 'Select presets on the left, then Add to setup.'));
    renderPlaybackControls(detail, draft.settings, draft.timing ??= { ...defaultSceneTiming }, redraw => { this.dirty = true; if (redraw) this.drawItem(); }, 'Setup', this.controlsContext());
    detail.append(
      this.button('Save setup', () => {
        try {
          if (!draft.presets.length) throw Error('Add at least one preset.');
          const next = this.sets.filter(s => s.id !== draft.id); next.push(structuredClone(draft));
          this.pending = parseSetups(next); this.a.send({ op: 'save-setups', setups: this.pending }); this.say('Saving…'); this.drawItem();
        } catch (e) { this.say(String(e)); }
      }, !!this.pending || !this.loaded),
      this.button('Activate setup', () => {
        try {
          if (!draft.presets.length) throw Error('Add at least one preset.');
          this.a.activate(parseSetups([draft])[0]!); this.say(`Active setup: ${draft.name}`);
        } catch (e) { this.say(String(e)); }
      }),
      this.button('Use entire library', () => { this.a.activate(null); this.say('Using the entire preset library.'); }),
      this.button('Delete saved setup', () => {
        if (this.confirm(`Delete saved setup “${draft.name}”? Preset files are kept.`)) {
          this.pending = this.sets.filter(s => s.id !== draft.id); this.a.send({ op: 'save-setups', setups: this.pending }); this.say('Deleting saved setup…'); this.drawItem();
        }
      }, !!this.pending || !this.sets.some(s => s.id === draft.id)),
      this.button('Folder from setup', () => {
        const created = this.view?.createFolderFromSetup(draft.name, draft.presets);
        if (created) this.say(`Folder "${draft.name}" created with ${created.added} presets${created.skipped ? `; ${created.skipped} skipped` : ''}.`);
      }, !draft.presets.length || !this.view),
    );
  }
}
