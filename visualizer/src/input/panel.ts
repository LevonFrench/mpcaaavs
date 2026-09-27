// The live-input panel (I).
//
// Deliberately a sibling of the layer panel rather than a tab inside it: this
// is setup, not performance. It is opened once to bind a controller and then
// closed, and it must stay reachable when an AVS preset owns the whole layer
// panel body.
//
// It re-renders wholesale on change. The row count is the number of targets
// (single digits), the panel is only redrawn when it is open, and nothing here
// runs per MIDI message except the one-line "last event" readout — so the
// simplest correct thing is also the right one.

import { describeInputEvent, type InputEvent } from './events.ts';
import type { MidiInputs } from './midi.ts';
import type { OscBridge } from './osc.ts';
import { targetInert, type InputMappings, type InputTarget } from './mappings.ts';
import { installKeyboardGuard } from '../keyboard-guard.ts';

// Source and bundle each sit beside their stylesheet, the same arrangement
// `ui.ts` and `avs-editor.ts` use.
const DEFAULT_STYLE_HREF = new URL('./input.css', import.meta.url).href;

export interface InputPanelOptions {
  readonly mappings: InputMappings;
  readonly midi: MidiInputs;
  readonly osc: OscBridge;
  /** Called when the performer asks for MIDI access, which needs a gesture. */
  readonly onEnableMidi: () => void;
  readonly host?: HTMLElement;
  readonly styleHref?: string;
  /**
   * Is the AVS lane rendering right now? Injected by main.ts. While true, a
   * native-lane-only row is greyed and cannot be LEARNed. Omitted means never.
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
  if (document.querySelector('link[data-aaavs-input]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset['aaavsInput'] = '';
  link.addEventListener('error', () => {
    console.warn(`aaavs: input panel stylesheet not found at ${href}. Pass styleHref to InputPanel.`);
  });
  document.head.append(link);
}

const MIDI_STATUS_TEXT: Readonly<Record<string, string>> = {
  idle: 'not requested',
  unsupported: 'unsupported in this browser',
  insecure: 'needs https or localhost',
  requesting: 'waiting for permission…',
  denied: 'permission denied',
  ready: 'ready',
};

const OSC_STATUS_TEXT: Readonly<Record<string, string>> = {
  idle: 'not started',
  connecting: 'connecting…',
  open: 'connected',
  closed: 'bridge offline',
  disabled: 'unavailable on this origin',
};

export class InputPanel {
  private readonly root: HTMLElement;
  private readonly body: HTMLDivElement;
  private readonly lastLine: HTMLParagraphElement;
  private readonly mappings: InputMappings;
  private readonly midi: MidiInputs;
  private readonly osc: OscBridge;
  private readonly onEnableMidi: () => void;
  private readonly isAvsLaneActive: () => boolean;
  private readonly removeKeyboardGuard: () => void;
  private opened = false;

  constructor(options: InputPanelOptions) {
    this.mappings = options.mappings;
    this.midi = options.midi;
    this.osc = options.osc;
    this.onEnableMidi = options.onEnableMidi;
    this.isAvsLaneActive = options.isAvsLaneActive ?? ((): boolean => false);
    ensureStylesheet(options.styleHref ?? DEFAULT_STYLE_HREF);

    this.root = el('section', 'aaavs-input');
    this.root.id = 'aaavs-input';
    this.root.setAttribute('aria-label', 'Live input');
    this.root.hidden = true;

    const head = el('div', 'in-head');
    head.append(el('h2', 'in-title', 'LIVE INPUT'));
    const close = button('×', 'in-x', 'Close (I)');
    close.setAttribute('aria-label', 'Close live input panel');
    close.addEventListener('click', () => this.close());
    head.append(close);

    this.body = el('div', 'in-body');
    this.lastLine = el('p', 'in-last', 'no input yet');

    this.root.append(head, this.body, this.lastLine);
    (options.host ?? document.body).append(this.root);
    // Letters typed into the device select's type-ahead belong to the select,
    // not to main.ts's single-letter shortcuts.
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

  /** One-line readout of the most recent event, so a dead cable is obvious. */
  noteEvent(event: InputEvent): void {
    if (!this.opened) return;
    this.lastLine.textContent = `${describeInputEvent(event)} · ${event.value.toFixed(3)}`;
  }

  refresh(): void {
    if (!this.opened) return;
    this.body.replaceChildren(this.buildMidi(), this.buildOsc(), this.buildMappings());
  }

  /**
   * Re-apply the native/AVS lane split after the rendering lane changed. The
   * panel re-renders wholesale anyway (see the top of this file), so this is
   * `refresh` under a name main.ts can call without knowing that.
   */
  refreshLaneAvailability(): void {
    this.refresh();
  }

  dispose(): void {
    this.removeKeyboardGuard();
    this.root.remove();
    // Drop the injected <link> too, as `SequencerGrid.dispose` does:
    // ensureStylesheet guards on this exact selector, so leaving it behind means
    // a recreated panel reuses a stale href.
    document.querySelector('link[data-aaavs-input]')?.remove();
  }

  private section(title: string, status: string, ok: boolean): HTMLDivElement {
    const wrap = el('div', 'in-section');
    const row = el('div', 'in-section-head');
    row.append(el('h3', 'in-section-title', title));
    const dot = el('span', ok ? 'in-dot is-ok' : 'in-dot');
    const value = el('span', 'in-status', status);
    row.append(dot, value);
    wrap.append(row);
    return wrap;
  }

  private buildMidi(): HTMLDivElement {
    const status = MIDI_STATUS_TEXT[this.midi.status] ?? this.midi.status;
    const wrap = this.section('MIDI', status, this.midi.status === 'ready');
    if (this.midi.message) wrap.append(el('p', 'in-note', this.midi.message));

    if (this.midi.status === 'idle' || this.midi.status === 'denied') {
      const enable = button('ENABLE MIDI', 'in-btn is-primary', 'Request Web MIDI access');
      enable.addEventListener('click', () => this.onEnableMidi());
      wrap.append(enable);
      return wrap;
    }

    const devices = this.midi.devices;
    if (!devices.length) {
      wrap.append(el('p', 'in-note', 'no MIDI inputs detected — plug one in, it appears here'));
      return wrap;
    }

    const label = el('label', 'in-field');
    label.append(el('span', 'in-field-label', 'device'));
    const select = el('select', 'in-select');
    const all = el('option', '', 'All inputs');
    all.value = '';
    select.append(all);
    for (const device of devices) {
      const option = el('option', '', device.connected ? device.name : `${device.name} (offline)`);
      option.value = device.id;
      select.append(option);
    }
    select.value = this.midi.selectedId;
    select.addEventListener('change', () => this.midi.select(select.value));
    label.append(select);
    wrap.append(label);
    return wrap;
  }

  private buildOsc(): HTMLDivElement {
    const status = OSC_STATUS_TEXT[this.osc.status] ?? this.osc.status;
    const wrap = this.section('OSC', status, this.osc.status === 'open');
    wrap.append(el(
      'p',
      'in-note',
      this.osc.status === 'open'
        ? `${this.osc.received} packets forwarded`
        : 'run npm run serve — the dev server bridges UDP 9000 to this page',
    ));
    return wrap;
  }

  private buildMappings(): HTMLDivElement {
    const wrap = this.section('MAPPINGS', `${this.mappings.bindings.length} bound`, this.mappings.bindings.length > 0);
    const list = el('ul', 'in-list');
    const avs = this.isAvsLaneActive();
    for (const target of this.mappings.targets) list.append(this.buildRow(target, avs));
    wrap.append(list);

    const clearAll = button('CLEAR ALL', 'in-btn', 'Remove every binding');
    clearAll.addEventListener('click', () => this.mappings.clearAll());
    wrap.append(clearAll);
    return wrap;
  }

  private buildRow(target: InputTarget, avs: boolean): HTMLLIElement {
    const row = el('li', 'in-row');
    const learning = this.mappings.learning === target.id;
    const inert = targetInert(target, avs);
    if (learning) row.classList.add('is-learning');
    if (inert) row.classList.add('is-inert');

    const text = el('div', 'in-row-text');
    text.append(el('span', 'in-row-label', target.label));
    if (target.hint) text.append(el('span', 'in-row-hint', target.hint));
    row.append(text);

    const binding = this.mappings.bindingFor(target.id);
    row.append(el('span', binding ? 'in-bind is-set' : 'in-bind', learning
      ? 'move a control…'
      : binding?.label ?? 'unbound'));

    const learn = button(learning ? 'CANCEL' : 'LEARN', 'in-btn is-small', `Bind a control to ${target.label}`);
    // A dead target cannot be armed. An arm already in flight can still be
    // cancelled, and an existing binding can still be cleared below.
    learn.disabled = inert && !learning;
    learn.addEventListener('click', () => this.mappings.arm(target.id));
    row.append(learn);

    const clear = button('×', 'in-btn is-small is-icon', `Unbind ${target.label}`);
    clear.disabled = !binding;
    clear.addEventListener('click', () => this.mappings.clear(target.id));
    row.append(clear);
    return row;
  }
}
