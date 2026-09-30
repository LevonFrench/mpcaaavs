/** Reusable controls mounted by either shared Player host; no native or browser transport assumptions. */
import { TRANSITIONS } from './mpc-transition.ts';
import { FADE_TIMING_LABELS } from './mpc-transition-timing.ts';
import { MULTI_VIEW_LAYOUTS, MULTI_VIEW_MOTIONS, parseMultiViewPlan, type MultiViewPlan, type MultiViewSource } from './multi-view-model.ts';
export interface MultiViewChoice { readonly id: string; readonly name: string }
export interface MultiViewControlsHost {
  plan(): MultiViewPlan;
  apply(plan: MultiViewPlan): void;
  /** These are read-only set/folder descriptors, never private filesystem paths. */
  sets(): readonly MultiViewChoice[];
  enable(enabled: boolean): void;
  enabled(): boolean;
  /** Use the selected panel to route an explicit preset selection from the existing browser. */
  selectPane(pane: number): void;
  /** The persistently selected panel, exposed to assistive technology as the pressed "Select panel" button. */
  selected?(): number;
  /** True while the Player's global Auto is paused (every panel holds). */
  autoPaused?(): boolean;
}
/** Teardown function plus in-place updates. `refresh` redraws for external changes and keeps focus on the equivalent control. */
export type MultiViewControlsHandle = (() => void) & { refresh(): void; select(pane: number): void };
const layoutNames = ['Single', 'Vertical halves / columns', 'Horizontal halves / rows', 'Grid', 'Large left + right panels', 'Large top + bottom panels', 'Upper third', 'Lower third', 'Side rail', 'Picture in picture', 'Cards'];
const motionNames = ['Cut', 'Dissolve', 'Slide horizontally', 'Slide vertically', 'Wipe horizontally', 'Wipe vertically', 'Flip on vertical axis', 'Flip on horizontal axis', 'Morph'];
let instances = 0;
/** Accessible name of a control, through the real DOM or the duck-typed fixtures. */
const labelOf = (node: unknown): string | null => {
  const n = node as { getAttribute?(name: string): string | null; ['aria-label']?: unknown } | null;
  const value = n?.getAttribute?.('aria-label') ?? n?.['aria-label'];
  return typeof value === 'string' ? value : null;
};
/** Caller owns the container. Rebuild only for structural changes; typing a numeric value never loses focus, and a rebuild restores it. */
export function renderMultiViewControls(container: HTMLElement, host: MultiViewControlsHost): MultiViewControlsHandle {
  let closed = false, nodes: HTMLElement[] = [], paneButtons: HTMLElement[] = [];
  const prefix = `aaavs-multiview-${++instances}`;
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
    const node = document.createElement(tag); node.textContent = text; nodes.push(node);
    if (node.style) {
      if (tag === 'label') node.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin:9px 0;';
      else if (tag === 'input' || tag === 'select' || tag === 'button') node.style.cssText = 'font:inherit;color:inherit;background:#303030;border:1px solid #606060;border-radius:2px;padding:5px 8px;min-height:30px;max-width:100%;';
      else if (tag === 'fieldset') node.style.cssText = 'border:1px solid #555;padding:10px;margin:14px 0;';
    }
    return node;
  };
  const apply = (update: Partial<MultiViewPlan>) => { host.apply(parseMultiViewPlan({ ...host.plan(), ...update })); };
  const select = (pane: number) => { paneButtons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === pane))); };
  /** A control whose change is refused because its timing is held; it stays focusable and names its reason (aria-disabled, not disabled). */
  const held = (input: HTMLElement, reason: string | null) => { if (!reason) return false; input.setAttribute('aria-disabled', 'true'); input.setAttribute('aria-describedby', reason); return true; };
  /** Structural redraw. Focus returns to the control with the same accessible name, else to `fallback` (the control that caused it). */
  const redraw = (fallback?: string) => {
    if (closed) return;
    const active = (globalThis as { document?: { activeElement?: unknown } }).document?.activeElement;
    const inside = nodes.includes(active as HTMLElement), focused = inside ? labelOf(active) : null;
    draw();
    const wanted = focused ?? (fallback && inside ? fallback : null);
    if (!wanted) return;
    const target = nodes.find(n => labelOf(n) === wanted) ?? (fallback ? nodes.find(n => labelOf(n) === fallback) : undefined);
    target?.focus?.();
  };
  const draw = () => {
    if (closed) return; container.replaceChildren(); nodes = []; paneButtons = [];
    container.append(element('h2', 'Multiview'));
    const checkbox = (parent: HTMLElement, title: string, value: boolean, changed: (value: boolean) => void, reason: string | null = null) => { const label = element('label', title), input = element('input'); input.type = 'checkbox'; input.checked = value; input.setAttribute('aria-label', title); const locked = held(input, reason); input.onchange = () => { if (locked) { input.checked = value; return; } changed(input.checked); }; label.prepend(input); parent.append(label); };
    const select = (parent: HTMLElement, title: string, choices: readonly (readonly [string, string])[], value: string, changed: (value: string) => void) => {
      const label = element('label', title), input = element('select'); input.setAttribute('aria-label', title);
      for (const [key, name] of choices) { const option = element('option', name); option.value = key; input.append(option); }
      input.value = value; input.onchange = () => changed(input.value); label.append(input); parent.append(label); return input;
    };
    const number = (parent: HTMLElement, title: string, value: number, min: number, max: number, changed: (value: number) => void, step = '1', reason: string | null = null) => {
      const label = element('label', title), input = element('input'); input.type = 'number'; input.value = String(value); input.min = String(min); input.max = String(max); input.step = step; input.setAttribute('aria-label', title);
      const locked = held(input, reason); if (locked) input.readOnly = true;
      input.onchange = () => { if (locked) { input.value = String(value); return; } if (input.value.trim() && Number.isFinite(Number(input.value))) changed(Number(input.value)); }; label.append(input); parent.append(label);
    };
    const sourceValue = (s: MultiViewSource | null) => s?.kind === 'set' ? `set:${s.id}` : s?.kind === 'all-sets' ? `all-sets:${s.traversal}` : s?.kind ?? 'inherit';
    const source = (parent: HTMLElement, title: string, current: MultiViewSource | null, inherited: boolean, changed: (value: MultiViewSource | null) => void) => {
      const choices: [string, string][] = [...(inherited ? [['inherit', 'Use multiview source'] as [string, string]] : []), ['all-presets', 'All presets'], ['all-sets:sets', 'All sets · cycle sets'], ['all-sets:mixed', 'All sets · mix presets'], ...host.sets().map(s => [`set:${s.id}`, s.name] as [string, string])];
      if (current?.kind === 'presets') choices.push(['presets', `${current.hashes.length} selected presets`]);
      if (current?.kind === 'set' && !host.sets().some(s => s.id === current.id)) choices.push([`set:${current.id}`, 'Missing set']);
      select(parent, title, choices, sourceValue(current), key => changed(key === 'inherit' ? null : key === 'presets' ? current : key.startsWith('set:') ? { kind: 'set', id: key.slice(4) } : key.startsWith('all-sets:') ? { kind: 'all-sets', traversal: key.endsWith('mixed') ? 'mixed' : 'sets', barsPerSet: current?.kind === 'all-sets' ? current.barsPerSet : 32 } : { kind: 'all-presets' }));
    };
    const plan = host.plan();
    checkbox(container, 'Enable multiview', host.enabled(), enabled => { host.enable(enabled); });
    if (host.autoPaused?.()) { const note = element('p', 'Player Auto is paused: every panel holds its current preset until Auto resumes.'); note.setAttribute('role', 'status'); container.append(note); }
    select(container, 'Panels', [["2", '2'], ["3", '3'], ["4", '4']], String(plan.count), value => { apply({ count: Number(value) }); redraw('Panels'); });
    select(container, 'Multiview layout', MULTI_VIEW_LAYOUTS.filter(name => name !== 'single').map(name => [name, layoutNames[MULTI_VIEW_LAYOUTS.indexOf(name)]!] as const), plan.layout, value => apply({ layout: value as MultiViewPlan['layout'] }));
    source(container, 'Multiview source', plan.source, false, value => { if (value) apply({ source: value }); redraw('Multiview source'); });
    if (plan.source.kind === 'all-sets') number(container, 'Bars per set', plan.source.barsPerSet, 1, 128, barsPerSet => { if (host.plan().source.kind === 'all-sets') apply({ source: { ...host.plan().source as Extract<MultiViewSource, { kind: 'all-sets' }>, barsPerSet } }); });
    select(container, 'Layout transition', MULTI_VIEW_MOTIONS.map((motion, i) => [motion, motionNames[i]!] as const), plan.layoutMotion, value => apply({ layoutMotion: value as MultiViewPlan['layoutMotion'] }));
    number(container, 'Layout transition beats', plan.layoutBeats, 0, 16, layoutBeats => apply({ layoutBeats }), '.25');
    select(container, 'Panel fade length', FADE_TIMING_LABELS.map((name, i) => [String(i), name] as const), String(plan.fade.timing), value => apply({ fade: { ...host.plan().fade, timing: Number(value) as MultiViewPlan['fade']['timing'] } }));
    number(container, 'Fade seconds fallback', plan.fade.fixedMs / 1000, .25, 8, seconds => apply({ fade: { ...host.plan().fade, fixedMs: seconds * 1000 } }), '.25');
    number(container, 'Song BPM', plan.timing.bpm, 20, 400, bpm => apply({ timing: { ...host.plan().timing, bpm } }), '.01');
    number(container, 'First boundary offset (seconds)', plan.timing.offsetSeconds, -3600, 3600, offsetSeconds => apply({ timing: { ...host.plan().timing, offsetSeconds } }), '.01');
    number(container, 'Shuffle seed', plan.timing.seed, 0, 0xffffffff, seed => apply({ timing: { ...host.plan().timing, seed } }));
    number(container, 'Shuffle minimum rating', plan.minimumRating, 0, 5, minimumRating => apply({ minimumRating }));
    checkbox(container, 'Avoid duplicate presets when possible', plan.avoidDuplicates, avoidDuplicates => apply({ avoidDuplicates }));
    select(container, 'Panel border', ['none', 'solid', 'pulse', 'chase'].map(name => [name, name] as const), plan.border.style, value => apply({ border: { ...host.plan().border, style: value as MultiViewPlan['border']['style'] } }));
    number(container, 'Border width (display pixels)', plan.border.width, 0, 12, width => apply({ border: { ...host.plan().border, width } }));
    const color = element('input'), colorLabel = element('label', 'Border color'); color.type = 'color'; color.value = plan.border.color; color.setAttribute('aria-label', 'Border color'); color.onchange = () => apply({ border: { ...host.plan().border, color: color.value } }); colorLabel.append(color); container.append(colorLabel);
    number(container, 'Panel gap (display pixels)', plan.gutter, 0, 64, gutter => apply({ gutter }));
    const selected = host.selected?.() ?? -1;
    for (let i = 0; i < plan.count; i++) {
      const pane = plan.panes[i]!, group = element('fieldset'), legend = element('legend', `Panel ${i + 1}`); group.append(legend); container.append(group);
      const edit = (update: Partial<typeof pane>) => { const panes = host.plan().panes.map((p, n) => n === i ? { ...p, ...update } : p); apply({ panes }); };
      const button = element('button', `Select panel ${i + 1}`); button.type = 'button'; button.setAttribute('aria-label', `Select panel ${i + 1}`); button.setAttribute('aria-pressed', String(i === selected));
      button.onclick = () => host.selectPane(i); group.append(button); paneButtons.push(button);
      // Timing edits while a pane holds would silently restart its lane history; they stay readable and explain why they are held.
      let reason: string | null = null;
      if (!pane.auto) { const note = element('p', `Panel ${i + 1} Auto is off, so the panel holds its current preset. Turn on Panel ${i + 1} Auto to change its shuffle, bars or stagger.`); note.id = reason = `${prefix}-pane-${i + 1}-held`; group.append(note); }
      source(group, `Panel ${i + 1} source`, pane.source, true, value => { edit({ source: value }); redraw(`Panel ${i + 1} source`); });
      if (pane.source?.kind === 'all-sets') number(group, `Panel ${i + 1} bars per set`, pane.source.barsPerSet, 1, 128, barsPerSet => { const source = host.plan().panes[i]!.source; if (source?.kind === 'all-sets') edit({ source: { ...source, barsPerSet } }); }, '1', reason);
      checkbox(group, `Panel ${i + 1} Auto`, pane.auto, auto => { edit({ auto }); redraw(`Panel ${i + 1} Auto`); }); checkbox(group, `Panel ${i + 1} shuffle`, pane.shuffle, shuffle => edit({ shuffle }), reason);
      number(group, `Panel ${i + 1} bars per preset`, pane.bars, 1, 128, bars => edit({ bars }), '1', reason); number(group, `Panel ${i + 1} stagger (bars)`, pane.phaseBars, 0, 128, phaseBars => edit({ phaseBars }), '.25', reason);
      select(group, `Panel ${i + 1} transition`, [...MULTI_VIEW_MOTIONS.filter(m => m !== 'morph').map((m) => [m, motionNames[MULTI_VIEW_MOTIONS.indexOf(m)]!] as const), ...TRANSITIONS.map((name, n) => [String(n), name] as const)], String(pane.transition), value => edit({ transition: /^\d+$/.test(value) ? Number(value) : value as typeof pane.transition }));
      select(group, `Panel ${i + 1} image fit`, [['contain', 'Show whole preset'], ['cover', 'Fill panel (crop)'], ['stretch', 'Stretch']], pane.fit, value => edit({ fit: value as typeof pane.fit }));
    }
    container.append(element('p', 'Each panel has independent Auto. All sets can cycle a different set in each panel or mix their presets. Rendering stays limited to the visible panels.'));
  };
  draw();
  return Object.assign(() => { closed = true; nodes = []; paneButtons = []; container.replaceChildren(); }, { refresh: () => redraw(), select });
}
export const MULTI_VIEW_STORAGE_KEY = 'aaavs.multiView.v1';
/** Device-local persistence, optional and failure-safe. Set IDs and preset hashes only; never use the private library service. */
export function readMultiViewPlan(storage?: Pick<Storage, 'getItem'>): MultiViewPlan {
  try { return parseMultiViewPlan(JSON.parse(storage?.getItem(MULTI_VIEW_STORAGE_KEY) ?? 'null')); } catch { return parseMultiViewPlan(null); }
}
export function saveMultiViewPlan(plan: MultiViewPlan, storage?: Pick<Storage, 'setItem'>): boolean {
  try { if (!storage) return false; storage.setItem(MULTI_VIEW_STORAGE_KEY, JSON.stringify(parseMultiViewPlan(plan))); return true; } catch { return false; }
}
/** A played folder: hashed id, its display name and member hashes. No paths; resolved against the catalog on every read. */
export interface MultiViewFolderSource { readonly id: string; readonly name: string; readonly hashes: readonly string[] }
export const MULTI_VIEW_FOLDERS_KEY = 'aaavs.multiView.folders.v1';
export const MULTI_VIEW_FOLDER_LIMIT = 9, MULTI_VIEW_FOLDER_MEMBERS = 10000;
const FOLDER_ID = /^folder:[0-9a-f]{1,8}$/, FOLDER_HASH = /^[a-f0-9]{64}$/;
/** Strict and bounded: unknown fields dropped, invalid entries skipped, members deduplicated. */
export function parseMultiViewFolders(value: unknown): MultiViewFolderSource[] {
  const list = value && typeof value === 'object' && !Array.isArray(value) ? (value as { folders?: unknown }).folders : undefined;
  if (!Array.isArray(list)) return [];
  const out: MultiViewFolderSource[] = [], seen = new Set<string>();
  for (const entry of list.slice(0, MULTI_VIEW_FOLDER_LIMIT)) {
    const e = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    if (typeof e.id !== 'string' || !FOLDER_ID.test(e.id) || seen.has(e.id) || typeof e.name !== 'string' || !e.name || e.name.length > 240 || /[\x00-\x1f\x7f]/.test(e.name) || !Array.isArray(e.hashes)) continue;
    seen.add(e.id);
    out.push({ id: e.id, name: e.name, hashes: [...new Set(e.hashes.slice(0, MULTI_VIEW_FOLDER_MEMBERS).filter((h): h is string => typeof h === 'string' && FOLDER_HASH.test(h)))] });
  }
  return out;
}
export function readMultiViewFolders(storage?: Pick<Storage, 'getItem'>): MultiViewFolderSource[] {
  try { return parseMultiViewFolders(JSON.parse(storage?.getItem(MULTI_VIEW_FOLDERS_KEY) ?? 'null')); } catch { return []; }
}
export function saveMultiViewFolders(folders: readonly MultiViewFolderSource[], storage?: Pick<Storage, 'setItem'>): boolean {
  try { if (!storage) return false; storage.setItem(MULTI_VIEW_FOLDERS_KEY, JSON.stringify({ version: 1, folders: parseMultiViewFolders({ folders }) })); return true; } catch { return false; }
}
