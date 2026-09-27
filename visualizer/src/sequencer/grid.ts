// The step grid (S).
//
// A sibling panel, built the way `src/input/panel.ts` is: its own DOM, its own
// injected stylesheet, no markup in index.html. It sits bottom-centre so it
// clears the layer panel (top-right), the HUD (top-left), the live-input panel
// (bottom-left) and the offline launcher (bottom-right).
//
// Two different update rates share one component and they are deliberately NOT
// the same call. `refresh()` rebuilds the rows and runs only on an edit, which
// is a human-rate event. `setStep()` moves the playhead and runs on every 1/16
// boundary — at 174 BPM that is about eleven times a second, so it touches one
// class on sixteen cells rather than replacing any DOM. Rebuilding the grid on
// the playhead would also destroy the <select> the performer is mid-drag on.
//
// For the same reason `notify()` rebuilds only on a `'layout'` change. A
// `'value'` change comes from a control the performer is currently holding —
// the amount slider, the target select, a step cell — and that control already
// shows the new value. Rebuilding there replaced the live <input type=range>
// on every `input` event, which dropped its pointer capture and made the
// slider impossible to drag.

import { STEPS_PER_BAR, type SequencerChangeReason, type SequencerLanes } from './lane.ts';
import { targetInert } from '../input/mappings.ts';
import { installKeyboardGuard } from '../keyboard-guard.ts';

const DEFAULT_STYLE_HREF = new URL('./sequencer.css', import.meta.url).href;

export interface SequencerGridOptions {
  readonly lanes: SequencerLanes;
  readonly host?: HTMLElement;
  readonly styleHref?: string;
  /**
   * Is the AVS lane rendering right now? Injected by main.ts, the only place
   * that knows. While it answers true, native-lane-only targets are greyed and
   * disabled in the dropdown. Omitted means "never", which disables nothing.
   */
  readonly isAvsLaneActive?: () => boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(label: string, className: string, title: string): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  node.title = title;
  return node;
}

function ensureStylesheet(href: string): void {
  if (document.querySelector('link[data-aaavs-sequencer]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset['aaavsSequencer'] = '';
  link.addEventListener('error', () => {
    console.warn(`aaavs: sequencer stylesheet not found at ${href}. Pass styleHref to SequencerGrid.`);
  });
  document.head.append(link);
}

export class SequencerGrid {
  private readonly root: HTMLElement;
  private readonly body: HTMLDivElement;
  private readonly enableBtn: HTMLButtonElement;
  private readonly lanes: SequencerLanes;
  private readonly isAvsLaneActive: () => boolean;
  private readonly removeKeyboardGuard: () => void;
  /** One per lane row, in lane order. Rebuilt by `refresh`. */
  private selects: HTMLSelectElement[] = [];
  /** Row-major, `lane * STEPS_PER_BAR + step`. Rebuilt by `refresh`. */
  private cells: HTMLButtonElement[] = [];
  private opened = false;
  private step = -1;

  constructor(options: SequencerGridOptions) {
    this.lanes = options.lanes;
    this.isAvsLaneActive = options.isAvsLaneActive ?? ((): boolean => false);
    ensureStylesheet(options.styleHref ?? DEFAULT_STYLE_HREF);

    this.root = el('section', 'aaavs-seq');
    this.root.id = 'aaavs-seq';
    this.root.setAttribute('aria-label', 'Step sequencer');
    this.root.hidden = true;

    const head = el('div', 'sq-head');
    head.append(el('h2', 'sq-title', 'STEP GRID'));

    this.enableBtn = button('RUNNING', 'sq-btn is-primary', 'Stop or start the grid');
    this.enableBtn.addEventListener('click', () => {
      this.lanes.enabled = !this.lanes.enabled;
      this.paintEnabled();
    });
    head.append(this.enableBtn);

    const clearAll = button('CLEAR', 'sq-btn', 'Clear every step in every lane');
    clearAll.addEventListener('click', () => this.lanes.clearAll());
    head.append(clearAll);

    const close = button('×', 'sq-x', 'Close (S)');
    close.setAttribute('aria-label', 'Close step grid');
    close.addEventListener('click', () => this.close());
    head.append(close);

    this.body = el('div', 'sq-body');
    this.root.append(head, this.body);
    (options.host ?? document.body).append(this.root);
    // Arrow keys on a focused amount slider, or letters typed into the target
    // select's type-ahead, belong to the control and not to main.ts's bar-skip
    // and preset shortcuts.
    this.removeKeyboardGuard = installKeyboardGuard(this.root);
  }

  isOpen(): boolean {
    return this.opened;
  }

  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.root.hidden = false;
    this.refresh();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.root.hidden = true;
  }

  toggle(): void {
    if (this.opened) this.close();
    else this.open();
  }

  /**
   * Move the playhead. Driven from the lane's own step callback, which is
   * driven from the audio-clock scheduler — the grid never reads a clock.
   */
  setStep(step: number): void {
    if (step === this.step) return;
    this.step = step;
    if (!this.opened) return;
    this.paintPlayhead();
  }

  /**
   * Route an engine edit. Only a structural change rebuilds rows; a value
   * change leaves the performer's control alone.
   */
  notify(reason: SequencerChangeReason): void {
    if (reason === 'layout') this.refresh();
    else this.paintEnabled();
  }

  refresh(): void {
    if (!this.opened) return;
    this.paintEnabled();

    this.cells = [];
    this.selects = [];
    const rows = this.lanes.lanes.map((_lane, index) => this.buildRow(index));
    this.body.replaceChildren(this.buildRuler(), ...rows);
    this.paintPlayhead();
  }

  /**
   * Re-apply the native/AVS lane split to the open dropdowns in place.
   *
   * main.ts calls this whenever the rendering lane may have changed (a preset
   * load or unload). It toggles `disabled` on existing options rather than
   * rebuilding rows, for the same reason `notify` does not rebuild on a value
   * change: the performer may be holding one of these controls.
   */
  refreshLaneAvailability(): void {
    if (!this.opened) return;
    const avs = this.isAvsLaneActive();
    const targets = this.lanes.targets;
    for (const select of this.selects) {
      for (const option of select.options) {
        const target = targets.find((t) => t.id === option.value);
        option.disabled = target ? targetInert(target, avs) : false;
      }
      this.paintInert(select, avs);
    }
  }

  dispose(): void {
    this.removeKeyboardGuard();
    this.root.remove();
    // Drop the injected <link> too: ensureStylesheet guards on this exact
    // selector, so leaving it behind means a recreated grid reuses a stale href.
    document.querySelector('link[data-aaavs-sequencer]')?.remove();
  }

  private paintEnabled(): void {
    if (!this.opened) return;
    this.enableBtn.textContent = this.lanes.enabled ? 'RUNNING' : 'STOPPED';
    this.enableBtn.classList.toggle('is-primary', this.lanes.enabled);
  }

  /** 1 · · · 5 · · · 9 · · · 13 · · · — the usual quarter-note landmarks. */
  private buildRuler(): HTMLDivElement {
    const row = el('div', 'sq-row is-ruler');
    row.append(el('div', 'sq-row-head'));
    const grid = el('div', 'sq-grid');
    for (let step = 0; step < STEPS_PER_BAR; step++) {
      grid.append(el('span', step % 4 === 0 ? 'sq-tick is-beat' : 'sq-tick', step % 4 === 0 ? String(step + 1) : '·'));
    }
    row.append(grid);
    row.append(el('div', 'sq-row-tail'));
    return row;
  }

  private buildRow(index: number): HTMLDivElement {
    const lane = this.lanes.lanes[index]!;
    const row = el('div', 'sq-row');

    const head = el('div', 'sq-row-head');
    const select = el('select', 'sq-select');
    select.setAttribute('aria-label', `Target for ${lane.channel}`);
    // Built from the live-target registry, never a hard-coded list: a target
    // added to main.ts appears here without touching this file.
    const none = el('option', '', '— unassigned —');
    none.value = '';
    select.append(none);
    const avs = this.isAvsLaneActive();
    for (const target of this.lanes.targets) {
      const option = el('option', '', target.label);
      option.value = target.id;
      // A native-only target cannot be CHOSEN while the AVS lane renders. A lane
      // that already points at one keeps showing it — a disabled option can
      // still be the selected value — so the assignment is not silently lost.
      option.disabled = targetInert(target, avs);
      select.append(option);
    }
    // A lane persisted against a target that no longer exists must not silently
    // adopt the first entry in the list; show it as unassigned instead.
    select.value = this.lanes.targets.some((t) => t.id === lane.target) ? lane.target : '';
    this.paintInert(select, avs);
    select.addEventListener('change', () => {
      this.lanes.setTarget(index, select.value);
      this.paintInert(select, this.isAvsLaneActive());
    });
    this.selects.push(select);
    head.append(select);
    row.append(head);

    const grid = el('div', 'sq-grid');
    for (let step = 0; step < STEPS_PER_BAR; step++) {
      const cell = button('', lane.steps[step] ? 'sq-cell is-on' : 'sq-cell', `${lane.channel} step ${step + 1}`);
      cell.setAttribute('aria-pressed', lane.steps[step] ? 'true' : 'false');
      if (step % 4 === 0) cell.classList.add('is-beat');
      // Patch this one cell rather than waiting for a rebuild, so painting a
      // run of steps by click-dragging stays possible.
      cell.addEventListener('click', () => {
        this.lanes.toggleStep(index, step);
        const on = this.lanes.lanes[index]?.steps[step] ?? false;
        cell.classList.toggle('is-on', on);
        cell.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      grid.append(cell);
      this.cells.push(cell);
    }
    row.append(grid);

    const tail = el('div', 'sq-row-tail');
    const amount = el('input', 'sq-amount');
    amount.type = 'range';
    amount.min = '0';
    amount.max = '1';
    amount.step = '0.01';
    amount.value = String(lane.amount);
    amount.title = 'Value handed to the target when a step fires';
    amount.setAttribute('aria-label', `Amount for ${lane.channel}`);
    // `input`, not `change`: a continuous target should follow the drag, which
    // is the same thing a bound CC does.
    amount.addEventListener('input', () => this.lanes.setAmount(index, Number(amount.value)));
    tail.append(amount);

    const clear = button('×', 'sq-btn is-icon', `Clear ${lane.channel}`);
    clear.addEventListener('click', () => this.lanes.clearLane(index));
    tail.append(clear);
    row.append(tail);
    return row;
  }

  /** Mark a select whose CURRENT target is dead on the rendering lane. */
  private paintInert(select: HTMLSelectElement, avs: boolean): void {
    const target = this.lanes.targets.find((t) => t.id === select.value);
    const inert = target ? targetInert(target, avs) : false;
    select.classList.toggle('is-inert', inert);
    select.title = inert ? 'native lane only — inert while a .avs preset plays' : '';
  }

  private paintPlayhead(): void {
    for (let i = 0; i < this.cells.length; i++) {
      this.cells[i]!.classList.toggle('is-now', i % STEPS_PER_BAR === this.step);
    }
  }
}
