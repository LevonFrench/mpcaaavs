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
}
const layoutNames = ['Single', 'Vertical halves / columns', 'Horizontal halves / rows', 'Grid', 'Large left + right panels', 'Large top + bottom panels', 'Upper third', 'Lower third', 'Side rail', 'Picture in picture', 'Cards'];
const motionNames = ['Cut', 'Dissolve', 'Slide horizontally', 'Slide vertically', 'Wipe horizontally', 'Wipe vertically', 'Flip on vertical axis', 'Flip on horizontal axis', 'Morph'];
/** Caller owns the container. Rebuild only for structural changes; typing a numeric value never loses focus. */
export function renderMultiViewControls(container: HTMLElement, host: MultiViewControlsHost): () => void {
  let closed = false;
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
    const node = document.createElement(tag); node.textContent = text;
    if (node.style) {
      if (tag === 'label') node.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin:9px 0;';
      else if (tag === 'input' || tag === 'select' || tag === 'button') node.style.cssText = 'font:inherit;color:inherit;background:#303030;border:1px solid #606060;border-radius:2px;padding:5px 8px;min-height:30px;max-width:100%;';
      else if (tag === 'fieldset') node.style.cssText = 'border:1px solid #555;padding:10px;margin:14px 0;';
    }
    return node;
  };
  const apply = (update: Partial<MultiViewPlan>) => { host.apply(parseMultiViewPlan({ ...host.plan(), ...update })); };
  const draw = () => {
    if (closed) return; container.replaceChildren();
    container.append(element('h2', 'Multiview'));
    const checkbox = (parent: HTMLElement, title: string, value: boolean, changed: (value: boolean) => void) => { const label = element('label', title), input = element('input'); input.type = 'checkbox'; input.checked = value; input.setAttribute('aria-label', title); input.onchange = () => changed(input.checked); label.prepend(input); parent.append(label); };
    const select = (parent: HTMLElement, title: string, choices: readonly (readonly [string, string])[], value: string, changed: (value: string) => void) => {
      const label = element('label', title), input = element('select'); input.setAttribute('aria-label', title);
      for (const [key, name] of choices) { const option = element('option', name); option.value = key; input.append(option); }
      input.value = value; input.onchange = () => changed(input.value); label.append(input); parent.append(label); return input;
    };
    const number = (parent: HTMLElement, title: string, value: number, min: number, max: number, changed: (value: number) => void, step = '1') => {
      const label = element('label', title), input = element('input'); input.type = 'number'; input.value = String(value); input.min = String(min); input.max = String(max); input.step = step; input.setAttribute('aria-label', title);
      input.onchange = () => { if (input.value.trim() && Number.isFinite(Number(input.value))) changed(Number(input.value)); }; label.append(input); parent.append(label);
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
    select(container, 'Panels', [["2", '2'], ["3", '3'], ["4", '4']], String(plan.count), value => { apply({ count: Number(value) }); draw(); });
    select(container, 'Multiview layout', MULTI_VIEW_LAYOUTS.filter(name => name !== 'single').map(name => [name, layoutNames[MULTI_VIEW_LAYOUTS.indexOf(name)]!] as const), plan.layout, value => apply({ layout: value as MultiViewPlan['layout'] }));
    source(container, 'Multiview source', plan.source, false, value => { if (value) apply({ source: value }); draw(); });
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
    for (let i = 0; i < plan.count; i++) {
      const pane = plan.panes[i]!, group = element('fieldset'), legend = element('legend', `Panel ${i + 1}`); group.append(legend); container.append(group);
      const edit = (update: Partial<typeof pane>) => { const panes = host.plan().panes.map((p, n) => n === i ? { ...p, ...update } : p); apply({ panes }); };
      const button = element('button', `Select panel ${i + 1}`); button.type = 'button'; button.onclick = () => host.selectPane(i); group.append(button);
      source(group, `Panel ${i + 1} source`, pane.source, true, value => { edit({ source: value }); draw(); });
      if (pane.source?.kind === 'all-sets') number(group, `Panel ${i + 1} bars per set`, pane.source.barsPerSet, 1, 128, barsPerSet => { const source = host.plan().panes[i]!.source; if (source?.kind === 'all-sets') edit({ source: { ...source, barsPerSet } }); });
      checkbox(group, `Panel ${i + 1} Auto`, pane.auto, auto => edit({ auto })); checkbox(group, `Panel ${i + 1} shuffle`, pane.shuffle, shuffle => edit({ shuffle }));
      number(group, `Panel ${i + 1} bars per preset`, pane.bars, 1, 128, bars => edit({ bars })); number(group, `Panel ${i + 1} stagger (bars)`, pane.phaseBars, 0, 128, phaseBars => edit({ phaseBars }), '.25');
      select(group, `Panel ${i + 1} transition`, [...MULTI_VIEW_MOTIONS.filter(m => m !== 'morph').map((m) => [m, motionNames[MULTI_VIEW_MOTIONS.indexOf(m)]!] as const), ...TRANSITIONS.map((name, n) => [String(n), name] as const)], String(pane.transition), value => edit({ transition: /^\d+$/.test(value) ? Number(value) : value as typeof pane.transition }));
      select(group, `Panel ${i + 1} image fit`, [['contain', 'Show whole preset'], ['cover', 'Fill panel (crop)'], ['stretch', 'Stretch']], pane.fit, value => edit({ fit: value as typeof pane.fit }));
    }
    container.append(element('p', 'Each panel has independent Auto. All sets can cycle a different set in each panel or mix their presets. Rendering stays limited to the visible panels.'));
  };
  draw(); return () => { closed = true; container.replaceChildren(); };
}
export const MULTI_VIEW_STORAGE_KEY = 'aaavs.multiView.v1';
/** Device-local persistence, optional and failure-safe. Set IDs and preset hashes only; never use the private library service. */
export function readMultiViewPlan(storage?: Pick<Storage, 'getItem'>): MultiViewPlan {
  try { return parseMultiViewPlan(JSON.parse(storage?.getItem(MULTI_VIEW_STORAGE_KEY) ?? 'null')); } catch { return parseMultiViewPlan(null); }
}
export function saveMultiViewPlan(plan: MultiViewPlan, storage?: Pick<Storage, 'setItem'>): boolean {
  try { if (!storage) return false; storage.setItem(MULTI_VIEW_STORAGE_KEY, JSON.stringify(parseMultiViewPlan(plan))); return true; } catch { return false; }
}
