// The preset crate panel: the DOM half of `crate-model.ts`.
//
// Replaces browsing three native `<select>`s (124 bundled picks, ~3,400 local
// presets, My AVS) with one searchable list and a CUE slot, per the
// ux-architect review wireframe §7b. `LayerUI` constructs it and owns the
// wiring; this file never calls a host handler directly — `go` goes through
// the controller's `onGo`, which `ui.ts` routes to the SAME `onPick…`
// handlers the selects use.
//
// Keyboard (all scoped: nothing here fires while focus is in another panel):
//   /            focus the search box (global, handled by LayerUI)
//   g            commit the cued preset — "go" (global, handled by LayerUI)
//   in search    ↓ first row · Enter cue top match · Esc clear
//   on a row     ↑/↓/Home/End move · Enter go · Shift+Enter cue · * star · Esc back to search
// `g` and `/` were chosen because main.ts's keydown handler binds neither.
//
// Rendering is capped at CRATE_ROW_CAP rows. Filtering all ~3,400 entries per
// keystroke is one `includes` per entry and is cheap; creating 3,400 `<li>`s
// per keystroke is not, and nobody scrolls past the first two hundred matches
// of a search they could narrow instead.

import {
  CRATE_ROW_CAP,
  CrateController,
  crateBankLabel,
  type CrateEntry,
  type CrateControllerOptions,
} from './crate-model.ts';

export const CRATE_GO_KEY = 'g';
export const CRATE_SEARCH_KEY = '/';

export interface CratePanelOptions extends CrateControllerOptions {
  /** Lazy local catalog. Called at most once per success; failures may retry. */
  readonly requestLocal?: () => Promise<void>;
}

export class CratePanel {
  readonly root: HTMLElement;
  readonly controller: CrateController;
  private readonly search: HTMLInputElement;
  private readonly chipRow: HTMLElement;
  private readonly list: HTMLUListElement;
  private readonly countLine: HTMLElement;
  private readonly statusLine: HTMLElement;
  private readonly liveName: HTMLElement;
  private readonly cueName: HTMLElement;
  private readonly cueGo: HTMLButtonElement;
  private readonly cueClear: HTMLButtonElement;
  private readonly localButton: HTMLButtonElement | null;
  private localPending: Promise<void> | null = null;
  private focusKey: string | null = null;
  private busy = false;

  constructor(private readonly options: CratePanelOptions) {
    this.controller = new CrateController(options);
    this.root = el('div', 'ui-crate');
    this.root.setAttribute('aria-label', 'Preset crate');

    // --- live / cue slots ---------------------------------------------------
    const slots = el('div', 'ui-crate-slots');
    const live = el('div', 'ui-crate-slot is-live');
    this.liveName = el('span', 'ui-crate-slot-name', '—');
    live.append(el('span', 'ui-crate-slot-label', 'live'), this.liveName);
    const cue = el('div', 'ui-crate-slot is-cue');
    this.cueName = el('span', 'ui-crate-slot-name', 'nothing cued');
    this.cueGo = button('ui-crate-go', `go ▶`, `Put the cued preset live (${CRATE_GO_KEY.toUpperCase()})`);
    this.cueGo.addEventListener('click', () => { void this.commitCue(); });
    this.cueClear = button('ui-crate-clear', '×', 'Clear the cue slot');
    this.cueClear.addEventListener('click', () => { this.controller.clearCue(); this.renderSlots(); });
    cue.append(el('span', 'ui-crate-slot-label', 'cue'), this.cueName, this.cueGo, this.cueClear);
    cue.setAttribute('aria-live', 'polite');
    slots.append(live, cue);

    // --- search + chips -----------------------------------------------------
    this.search = el('input', 'ui-crate-search');
    this.search.type = 'search';
    this.search.placeholder = `search name or collection  ( ${CRATE_SEARCH_KEY} )`;
    this.search.setAttribute('aria-label', 'Search presets by name or collection');
    this.search.autocomplete = 'off';
    this.search.spellcheck = false;
    this.search.addEventListener('input', () => {
      this.controller.setQuery(this.search.value);
      this.renderList();
    });
    this.search.addEventListener('focus', () => { void this.loadLocal(); }, { once: true });

    this.chipRow = el('div', 'ui-crate-chips');
    this.chipRow.setAttribute('role', 'toolbar');
    this.chipRow.setAttribute('aria-label', 'Filter presets');

    // --- list ---------------------------------------------------------------
    this.list = el('ul', 'ui-crate-list');
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', 'Presets');
    this.list.addEventListener('click', (event) => this.onListClick(event));
    this.list.addEventListener('dblclick', (event) => {
      const key = rowKey(event.target);
      if (key && !(event.target instanceof HTMLButtonElement)) void this.go(key);
    });

    // --- footer -------------------------------------------------------------
    const foot = el('div', 'ui-crate-foot');
    const random = button('ui-crate-random', '⚄ random in filter', 'Cue a random preset from the current filter');
    random.addEventListener('click', () => {
      const entry = this.controller.cueRandom();
      if (!entry) { this.status('nothing in this filter to pick from'); return; }
      this.renderSlots();
      this.renderList();
    });
    this.countLine = el('span', 'ui-crate-count');
    this.countLine.setAttribute('aria-live', 'polite');
    foot.append(random, this.countLine);
    if (options.requestLocal) {
      this.localButton = button('ui-crate-local', 'load full local catalog', 'Load the full local AVS catalog into the crate');
      this.localButton.addEventListener('click', () => { void this.loadLocal(); });
      foot.append(this.localButton);
    } else {
      this.localButton = null;
    }

    // Its own status line: the host panel's lives in `preset tools`, which is
    // hidden while the AVS editor is showing, i.e. exactly when the crate is used.
    this.statusLine = el('p', 'ui-crate-status');
    this.statusLine.setAttribute('role', 'status');
    this.statusLine.setAttribute('aria-live', 'polite');

    this.root.append(slots, this.search, this.chipRow, this.list, foot, this.statusLine);
    this.render();
  }

  // -------------------------------------------------------------------------
  // Host surface
  // -------------------------------------------------------------------------

  setBank(bank: Parameters<CrateController['setBank']>[0], entries: Parameters<CrateController['setBank']>[1]): void {
    this.controller.setBank(bank, entries);
    if (bank === 'local' && this.localButton) this.localButton.hidden = true;
    this.render();
  }

  setLive(bank: Parameters<CrateController['setLive']>[0], id: string): void {
    this.controller.setLive(bank, id);
    this.renderSlots();
    this.markLive();
  }

  focusSearch(): void {
    this.search.focus();
    this.search.select();
  }

  async commitCue(): Promise<void> {
    const cued = this.controller.cued;
    if (!cued) { this.status('cue is empty — Shift+Enter or [cue] a preset first'); return; }
    await this.go(cued.key);
  }

  /**
   * Keyboard entry point, called by `LayerUI`'s capture-phase listener for
   * events whose target is inside this panel. Returns true when handled (the
   * event is then stopped so main.ts never sees it).
   */
  handleKey(event: KeyboardEvent): boolean {
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    const target = event.target;
    if (target === this.search) return this.handleSearchKey(event);
    const key = rowKey(target);
    if (!key || !(target instanceof HTMLElement) || !target.classList.contains('ui-crate-row')) return false;
    switch (event.key) {
      case 'ArrowDown': this.moveFocus(key, 1); break;
      case 'ArrowUp': this.moveFocus(key, -1); break;
      case 'Home': this.focusRowAt(0); break;
      case 'End': this.focusRowAt(this.list.children.length - 1); break;
      case 'Enter':
        if (event.shiftKey) this.cue(key);
        else void this.go(key);
        break;
      case '*': this.toggleStar(key); break;
      case 'Escape': this.search.focus(); break;
      default: return false;
    }
    stop(event);
    return true;
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private cue(key: string): void {
    const entry = this.controller.cue(key);
    if (!entry) return;
    this.renderSlots();
    this.status(`cued ${entry.name} — press ${CRATE_GO_KEY.toUpperCase()} or go ▶`);
  }

  private async go(key: string): Promise<void> {
    if (this.busy) return;
    const entry = this.controller.entry(key);
    if (!entry) return;
    this.busy = true;
    this.root.setAttribute('aria-busy', 'true');
    this.status(`loading ${entry.name}…`);
    try {
      await this.controller.go(key);
      this.status(`live: ${entry.name}`);
    } catch (error) {
      this.status(error instanceof Error ? error.message : String(error), true);
    } finally {
      this.busy = false;
      this.root.removeAttribute('aria-busy');
      this.renderSlots();
      this.markLive();
      // Recents changed; only redraw the list if it is showing them.
      if (this.controller.filter === 'recent') this.renderList();
      this.renderChips();
    }
  }

  private toggleStar(key: string): void {
    const on = this.controller.toggleFavourite(key);
    const star = this.rowFor(key)?.querySelector<HTMLButtonElement>('.ui-crate-star');
    if (star) paintStar(star, on);
    this.renderChips();
    if (this.controller.filter === 'favourites') this.renderList();
  }

  private loadLocal(): Promise<void> {
    const request = this.options.requestLocal;
    if (!request || this.controller.hasBank('local')) return Promise.resolve();
    if (this.localButton) { this.localButton.disabled = true; this.localButton.textContent = 'loading local catalog…'; }
    return this.localPending ??= request().catch((error: unknown) => {
      this.localPending = null;
      if (this.localButton) { this.localButton.disabled = false; this.localButton.textContent = 'load full local catalog'; }
      this.status(error instanceof Error ? error.message : String(error), true);
    });
  }

  private onListClick(event: MouseEvent): void {
    const target = event.target;
    const key = rowKey(target);
    if (!key) return;
    if (target instanceof HTMLElement) {
      if (target.closest('.ui-crate-star')) { this.toggleStar(key); return; }
      if (target.closest('.ui-crate-row-go')) { void this.go(key); return; }
      if (target.closest('.ui-crate-row-cue')) { this.cue(key); return; }
    }
    // A plain click on the row only focuses and cues it. Highlighting is never
    // a commit (review §3.3): the old select committed on `change`.
    this.focusKey = key;
    this.rowFor(key)?.focus();
    this.cue(key);
  }

  private handleSearchKey(event: KeyboardEvent): boolean {
    if (event.key === 'ArrowDown') {
      this.focusRowAt(0);
    } else if (event.key === 'Enter') {
      const first = this.controller.matches()[0];
      if (!first) return false;
      this.cue(first.key);
    } else if (event.key === 'Escape') {
      if (this.search.value) {
        this.search.value = '';
        this.controller.setQuery('');
        this.renderList();
      } else {
        this.search.blur();
      }
    } else {
      return false;
    }
    stop(event);
    return true;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private render(): void {
    this.renderSlots();
    this.renderChips();
    this.renderList();
  }

  private renderSlots(): void {
    const live = this.controller.live;
    this.liveName.textContent = live ? live.name : '—';
    this.liveName.title = live ? `${live.name} · ${live.collection}` : '';
    const cued = this.controller.cued;
    this.cueName.replaceChildren(cued ? cued.name : 'nothing cued');
    if (cued?.flash?.flashing) this.cueName.append(' ', flagBadge(cued));
    this.cueName.title = cued ? `${cued.name} · ${cued.collection} · ${crateBankLabel(cued.bank)}` : '';
    this.cueName.classList.toggle('is-empty', !cued);
    this.cueGo.disabled = !cued;
    this.cueClear.disabled = !cued;
  }

  private renderChips(): void {
    const view = this.controller.view(0);
    const current = this.controller.filter;
    this.chipRow.replaceChildren(...view.chips.map((chip) => {
      const node = button('ui-crate-chip', `${chip.label} ${chip.count.toLocaleString()}`, `Show ${chip.label} (${chip.count})`);
      node.setAttribute('aria-pressed', String(chip.filter === current));
      node.addEventListener('click', () => {
        this.controller.setFilter(chip.filter);
        this.renderChips();
        this.renderList();
      });
      return node;
    }));
  }

  private renderList(): void {
    const view = this.controller.view(CRATE_ROW_CAP);
    const liveKey = this.controller.live?.key ?? null;
    const fragment = document.createDocumentFragment();
    let focusable = view.rows.findIndex((entry) => entry.key === this.focusKey);
    if (focusable < 0) focusable = 0;
    view.rows.forEach((entry, index) => fragment.append(this.buildRow(entry, index === focusable, entry.key === liveKey)));
    this.list.replaceChildren(fragment);
    if (view.rows.length === 0) {
      this.list.append(el('li', 'ui-crate-empty', view.total === 0 ? 'no presets loaded' : 'no match — try fewer words'));
    }
    const shown = view.rows.length.toLocaleString();
    this.countLine.textContent = view.matched > view.rows.length
      ? `${shown} shown of ${view.matched.toLocaleString()} matches · type to narrow`
      : `${shown} shown of ${view.total.toLocaleString()}`;
  }

  private buildRow(entry: CrateEntry, tabbable: boolean, live: boolean): HTMLLIElement {
    const row = el('li', 'ui-crate-row');
    row.dataset['key'] = entry.key;
    row.tabIndex = tabbable ? 0 : -1;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(live));
    row.setAttribute('aria-label', `${entry.name}, ${entry.collection}${entry.flash?.flashing ? ', may flash' : ''}`);
    if (live) row.classList.add('is-live');
    // Roving tabindex follows focus however it arrived (arrow key, click, Esc
    // back), so Tab out and back returns to this row rather than a stale one.
    row.addEventListener('focus', () => {
      this.focusKey = entry.key;
      for (const other of this.list.querySelectorAll<HTMLElement>('.ui-crate-row')) other.tabIndex = other === row ? 0 : -1;
    });

    const star = button('ui-crate-star', '☆', `Favourite ${entry.name}`);
    star.tabIndex = -1;
    paintStar(star, this.controller.prefs.isFavourite(entry.key));
    const name = el('span', 'ui-crate-name', entry.name);
    name.title = entry.name;
    const collection = el('span', 'ui-crate-collection', entry.collection);
    collection.title = `${entry.collection} · ${crateBankLabel(entry.bank)}`;
    const flag = entry.flash?.flashing ? flagBadge(entry) : el('span', 'ui-crate-flag is-none');
    const cue = button('ui-crate-row-cue', 'cue', `Cue ${entry.name} without putting it live`);
    cue.tabIndex = -1;
    const go = button('ui-crate-row-go', 'go', `Put ${entry.name} live now`);
    go.tabIndex = -1;
    row.append(star, name, collection, flag, cue, go);
    return row;
  }

  private status(message: string, isError = false): void {
    this.statusLine.textContent = message;
    this.statusLine.classList.toggle('is-error', isError);
  }

  private markLive(): void {
    const liveKey = this.controller.live?.key ?? null;
    for (const row of this.list.querySelectorAll<HTMLElement>('.ui-crate-row')) {
      const isLive = row.dataset['key'] === liveKey;
      row.classList.toggle('is-live', isLive);
      row.setAttribute('aria-selected', String(isLive));
    }
  }

  private rowFor(key: string): HTMLElement | null {
    for (const row of this.list.querySelectorAll<HTMLElement>('.ui-crate-row')) {
      if (row.dataset['key'] === key) return row;
    }
    return null;
  }

  private moveFocus(key: string, direction: 1 | -1): void {
    const rows = [...this.list.querySelectorAll<HTMLElement>('.ui-crate-row')];
    const at = rows.findIndex((row) => row.dataset['key'] === key);
    if (at + direction < 0) { this.search.focus(); return; }
    this.focusRowAt(Math.min(rows.length - 1, at + direction));
  }

  private focusRowAt(index: number): void {
    const rows = this.list.querySelectorAll<HTMLElement>('.ui-crate-row');
    const row = rows[index];
    if (!row) return;
    row.focus();
    row.scrollIntoView({ block: 'nearest' });
  }
}

// ---------------------------------------------------------------------------

function rowKey(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>('.ui-crate-row')?.dataset['key'] ?? null;
}

function stop(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

function paintStar(star: HTMLButtonElement, on: boolean): void {
  star.textContent = on ? '★' : '☆';
  star.setAttribute('aria-pressed', String(on));
}

function flagBadge(entry: CrateEntry): HTMLElement {
  const flag = entry.flash!;
  const badge = el('span', `ui-crate-flag is-${flag.kind}`, '⚠');
  badge.title = flag.kind === 'heuristic'
    ? `May flash — ${flag.reason}`
    : `Flashing measured — ${flag.reason}`;
  badge.setAttribute('aria-label', badge.title);
  return badge;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text: string, label: string): HTMLButtonElement {
  const node = el('button', className, text);
  node.type = 'button';
  node.title = label;
  node.setAttribute('aria-label', label);
  return node;
}
