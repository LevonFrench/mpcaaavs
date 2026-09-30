/** Opt-in shared Player integration. Both native MPC and browser Player supply the SAME host callbacks. */
import type { LocalAvsPreset } from './avs/local-collection.ts';
import type { AvsAudioFrame } from './avs/types.ts';
import { parseSetups, type PresetSetup } from './mpc-setups.ts';
import type { DisplayPrefs } from './mpc-display.ts';
import { RenderSizer } from './render-sizer.ts';
import { resolveRender } from './render-resolution.ts';
import { buildHudFrame, hudTraits, type HudFeed } from './hud/hud-host.ts';
import { hash32, transitionLevel } from './mpc-transition.ts';
import { MultiViewClock, multiViewSetsFromSetups, type MultiViewSet } from './multi-view-clock.ts';
import { MultiViewCompositor } from './multi-view-compositor.ts';
import { multiViewHitTest, multiViewPixelRects, parseMultiViewPlan, type MultiViewPlan, type MultiViewRect } from './multi-view-model.ts';
import { readMultiViewPlan, renderMultiViewControls, saveMultiViewPlan } from './multi-view-controls.ts';
import { MultiViewRuntime } from './multi-view-runtime.ts';
import { createMultiViewWorker } from './multi-view-worker.ts';
export interface MultiViewSessionHost {
  catalog(): readonly LocalAvsPreset[];
  presets(preset: LocalAvsPreset): Promise<Uint8Array>;
  bitmaps(hash: string): Promise<readonly { name: string; bytes: ArrayBuffer }[]>;
  worker(url: string): Worker;
  view(): { width: number; height: number; dpr: number };
  display(): DisplayPrefs;
  audio(): AvsAudioFrame;
  pcm(): Float32Array;
  hudFeed: HudFeed;
  position(): number;
  duration(): number | null;
  playing(): boolean;
  visible(): boolean;
  reducedMotion(): boolean;
  /** Only mode changes. Stop single-view workers on true and restore the single-view selection on false. */
  mode(enabled: boolean): void;
  announce(text: string): void;
  failed(index: number): void;
  failures(): ReadonlySet<number>;
  /** Present a final composite through the EXISTING FlashGate. Returns no acceptance claim. */
  present(source: HTMLCanvasElement, nowMs: number): void;
  /** Optional sources from the user's manual folders; built-in catalog folders and saved setups are included already. */
  folders?(): readonly MultiViewSet[];
  storage?(): Pick<Storage, 'getItem' | 'setItem'> | undefined;
  requestSets?(): void;
}
const hashText = (text: string) => { let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return hash32(h).toString(16); };
/** Catalog folders and HUD packs can be selected before any personal setup file has loaded. */
export function multiViewCatalogSets(catalog: readonly LocalAvsPreset[]): MultiViewSet[] {
  const groups = new Map<string, number[]>();
  catalog.forEach((preset, index) => { const name = preset.hud?.pack ?? preset.folder ?? (preset.kind === 'nerv' ? 'NERV scenes' : null); if (!name) return; const order = groups.get(name) ?? []; order.push(index); groups.set(name, order); });
  return [...groups].map(([name, order]) => ({ id: `catalog:${hashText(name)}`, name, order }));
}
function directorSignature(plan: MultiViewPlan) {
  return JSON.stringify({ count: plan.count, source: plan.source, timing: plan.timing, fade: plan.fade, minimumRating: plan.minimumRating, avoidDuplicates: plan.avoidDuplicates,
    panes: plan.panes.map(({ source, auto, shuffle, bars, phaseBars }) => ({ source, auto, shuffle, bars, phaseBars })) });
}
export class MultiViewSession {
  private plan: MultiViewPlan;
  private runtime: MultiViewRuntime | null = null;
  private clock: MultiViewClock | null = null;
  private savedSets: PresetSetup[] = [];
  private extraSets: MultiViewSet[] = [];
  private readonly surface = document.createElement('canvas');
  private readonly context = this.surface.getContext('2d', { alpha: false })!;
  private readonly compositor = new MultiViewCompositor((w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; });
  private sizers: RenderSizer[] = [];
  private boxes: readonly MultiViewRect[] = [];
  private dirty = true;
  private now = 0;
  private selected = 0;
  private previousLayout: MultiViewPlan['layout'] | undefined;
  private previousCount = 0;
  private layoutStart = 0;
  private layoutEnd = 0;
  private lastPosition = NaN;
  private panel: HTMLElement | null = null;
  private controls: (() => void) | null = null;
  private button: HTMLButtonElement | null = null;
  private closed = false;
  private requestedSets = false;
  private masterAuto = true;
  private heldPosition = 0;
  constructor(private readonly host: MultiViewSessionHost) { this.plan = readMultiViewPlan(this.storage()); }
  get enabled() { return !!this.runtime; }
  get currentPane() { return this.selected; }
  get currentIndex() { return this.runtime?.currentIndex(this.selected) ?? null; }
  get controlsOpen() { return !!this.panel && !this.panel.hidden; }
  get summary() { return `Multiview · ${this.plan.count} panels · selected ${this.selected + 1}: ${this.currentIndex === null ? 'loading' : this.host.catalog()[this.currentIndex]?.name ?? 'unavailable'}`; }
  get bpm() { return this.clock?.at(this.host.position())[0]?.phase.bpm ?? this.plan.timing.bpm; }
  setAuto(enabled: boolean) {
    if (enabled === this.masterAuto) return;
    this.masterAuto = enabled; if (!enabled) this.heldPosition = this.host.position();
    if (this.runtime) this.host.announce(enabled ? 'Multiview Auto resumed' : 'Multiview Auto paused · panel animation continues');
    this.dirty = true;
  }
  private storage() { try { return this.host.storage?.(); } catch { return undefined; } }
  private sets() { return [...multiViewSetsFromSetups(this.savedSets, this.host.catalog()), ...multiViewCatalogSets(this.host.catalog()), ...this.extraSets, ...(this.host.folders?.() ?? [])]; }
  receiveSets(value: unknown) {
    try { this.savedSets = parseSetups(value); if (this.runtime) this.rebuild(); if (this.panel && !this.panel.hidden) this.showControls(); }
    catch (error) { this.host.announce(`Multiview sets unavailable: ${String(error)}`); }
  }
  private rebuild() {
    this.clock = new MultiViewClock(this.plan, this.host.catalog(), this.sets(), this.host.failures());
    if (this.runtime) this.runtime.configure(this.clock);
    this.dirty = true;
  }
  refreshSources() { if (this.runtime) this.rebuild(); }
  useSet(setup: PresetSetup | null): boolean {
    if (!this.runtime) return false;
    if (setup) { this.savedSets = [...this.savedSets.filter(s => s.id !== setup.id), setup]; this.apply({ ...this.plan, source: { kind: 'set', id: setup.id }, panes: this.plan.panes.map(p => ({ ...p, source: null })) }); }
    else this.apply({ ...this.plan, source: { kind: 'all-presets' }, panes: this.plan.panes.map(p => ({ ...p, source: null })) });
    return true;
  }
  useFolder(set: MultiViewSet): boolean {
    if (!this.runtime) return false;
    const id = `folder:${hashText(set.id)}`, descriptor = { ...set, id };
    this.extraSets = [...this.extraSets.filter(s => s.id !== id), descriptor];
    this.apply({ ...this.plan, source: { kind: 'set', id }, panes: this.plan.panes.map(p => ({ ...p, source: null })) }); return true;
  }
  private size(index: number, pane: number) {
    const preset = this.host.catalog()[index], kind = preset?.kind === 'hud' ? 'hud' : preset?.kind === 'nerv' ? 'nerv' : 'avs';
    const prefs = this.host.display();
    let sizer = this.sizers[pane];
    if (!sizer) { sizer = new RenderSizer({ cssSize: () => { const view = this.host.view(), box = multiViewPixelRects(this.plan.layout, this.plan.count, this.surface.width, this.surface.height, this.plan.gutter)[pane]; return { width: box ? box.width / Math.max(1, view.dpr) : 64, height: box ? box.height / Math.max(1, view.dpr) : 64 }; }, dpr: () => this.host.view().dpr, now: () => this.now }, prefs); this.sizers[pane] = sizer; }
    sizer.setPrefs(prefs); return sizer.resolve(kind, preset?.kind === 'hud' ? hudTraits(preset.hud) : undefined);
  }
  private resize() {
    const view = this.host.view(), prefs = this.host.display();
    const output = resolveRender({ kind: 'nerv', cssWidth: view.width, cssHeight: view.height, dpr: view.dpr, tier: prefs.quality });
    const { width, height } = output.canvas;
    if (this.surface.width !== width || this.surface.height !== height) { this.surface.width = width; this.surface.height = height; this.dirty = true; }
  }
  enable(enabled: boolean) {
    if (this.closed || enabled === this.enabled) return;
    if (!enabled) { this.runtime?.close(); this.runtime = null; this.clock = null; this.compositor.clear(); this.sizers = []; this.host.mode(false); this.host.announce('Single preset view'); return; }
    this.host.mode(true); if (!this.masterAuto) this.heldPosition = this.host.position(); this.resize(); this.rebuild();
    this.runtime = new MultiViewRuntime(this.clock!, {
      create: (index, pane, signal) => createMultiViewWorker({ catalog: this.host.catalog(), fetchPreset: p => this.host.presets(p), bitmaps: hash => this.host.bitmaps(hash), size: (index, pane) => this.size(index, pane).render,
        worker: url => this.host.worker(url), initialAudio: () => this.host.audio(),
        frame: (input, index, audio) => {
          const phase = input.lane.phase, clock = input.lane.clock, t = input.time, p = this.host.catalog()[index]!, bpm = clock.grid.bpmAt(t), seed = hash32(this.plan.timing.seed ^ Math.imul(input.lane.pane + 1, 0x9e3779b1)), localTime = Math.max(0, t - phase.start), beat = Math.max(0, clock.grid.beatAt(t));
          return { pcm: this.host.pcm().slice().buffer as ArrayBuffer, audio,
            ...(p.kind === 'nerv' ? { nerv: { time: t, localTime, progress: Math.min(1, localTime / phase.duration), bpm, seed, grid: clock.clockGrid, sceneStart: phase.start, sceneEnd: phase.end } } : {}),
            ...(p.kind === 'hud' ? { hud: buildHudFrame({ time: t, seed, revision: input.revision, grid: clock.clockGrid, sceneStart: phase.start, sceneEnd: phase.end, tempo: { bpm, beatIndex: Math.floor(beat), beatPhase: beat - Math.floor(beat), locked: true }, named: clock.intervals,
              track: { position: t, duration: this.host.duration() }, signals: this.host.hudFeed.snapshot(t, audio, input.playing), motion: this.host.reducedMotion() ? 'reduced' : 'full', flash: 'limit' }) } : {}) };
        } }, index, pane, signal),
      changed: () => { this.dirty = true; },
      failed: (index, pane, message) => { this.host.failed(index); this.host.announce(`Panel ${pane + 1}: ${message}`); this.rebuild(); },
      smooth: index => { const p = this.host.catalog()[index]; return p?.kind === 'nerv' || p?.kind === 'hud' && p.hud?.canvas.style !== 'pixel'; },
      renderKey: (index, pane) => this.size(index, pane).key,
    });
    this.host.announce(`Multiview · ${this.plan.count} panels · independent Auto`);
  }
  apply(value: MultiViewPlan) {
    const old = this.plan, plan = parseMultiViewPlan(value); this.plan = plan; this.selected = Math.min(this.selected, plan.count - 1);
    saveMultiViewPlan(plan, this.storage());
    if (old.layout !== plan.layout || old.count !== plan.count) {
      this.previousLayout = old.layout; this.previousCount = old.count; this.layoutStart = this.host.position();
      const grid = this.clock?.at(this.layoutStart)[0]?.clock.grid;
      this.layoutEnd = grid ? grid.timeAt(grid.beatAt(this.layoutStart) + plan.layoutBeats) : this.layoutStart + plan.layoutBeats * 60 / plan.timing.bpm;
      if (!this.host.playing()) this.layoutEnd = this.layoutStart;
    }
    if (this.runtime && directorSignature(old) !== directorSignature(plan)) this.rebuild();
    if (this.runtime && old.count !== plan.count) this.host.announce(`Multiview · ${plan.count} panels · independent Auto`);
    this.dirty = true;
  }
  feed(audio: AvsAudioFrame) { this.runtime?.feed(audio); }
  seek() { this.runtime?.seek(); this.dirty = true; this.previousLayout = undefined; }
  /** A selection outside the source becomes a held pane; inside its Auto pool it queues at the next boundary. */
  selectPreset(index: number): boolean {
    if (!this.runtime || !this.host.catalog()[index]) return false;
    if (this.masterAuto && this.plan.panes[this.selected]?.auto && this.clock?.queue(this.selected, index, this.host.position())) { this.host.announce(`Queued for panel ${this.selected + 1}`); return true; }
    const panes = this.plan.panes.map((p, i) => i === this.selected ? { ...p, source: { kind: 'presets' as const, hashes: [this.host.catalog()[index]!.sha256] }, auto: false } : p);
    this.apply({ ...this.plan, panes }); this.host.announce(`Holding selected preset in panel ${this.selected + 1}`); return true;
  }
  step(direction: 1 | -1): boolean {
    if (!this.runtime) return false;
    const frame = this.clock?.at(this.masterAuto ? this.host.position() : this.heldPosition)[this.selected];
    if (!frame?.order.length) { this.host.announce('Selected panel has no eligible presets'); return true; }
    const at = frame.order.indexOf(frame.phase.index), index = frame.order[(at + direction + frame.order.length) % frame.order.length]!;
    this.selectPreset(index); return true;
  }
  selectPane(pane: number) { if (Number.isInteger(pane) && pane >= 0 && pane < this.plan.count) { this.selected = pane; this.host.announce(`Panel ${pane + 1} selected`); } }
  pick(x: number, y: number) { const pane = multiViewHitTest(this.boxes, x, y); if (pane !== null) this.selectPane(pane); }
  /** Returns true when this session owns presentation. The single-view frame loop should then skip its worker/present branches. */
  frame(nowMs: number): boolean {
    if (!this.runtime || this.closed) return false;
    this.now = nowMs; this.resize(); const time = this.host.position(), visible = this.host.visible(), playing = this.host.playing();
    this.runtime.tick(time, nowMs, playing, visible, this.masterAuto ? time : this.heldPosition, this.masterAuto);
    const moving = time !== this.lastPosition; this.lastPosition = time;
    if (visible && (this.dirty || moving)) {
      const phase = this.clock!.at(time)[0]?.phase;
      const layoutProgress = this.layoutEnd > this.layoutStart ? Math.max(0, Math.min(1, (time - this.layoutStart) / (this.layoutEnd - this.layoutStart))) : 1;
      this.boxes = this.compositor.draw(this.context, { ...this.plan, width: this.surface.width, height: this.surface.height, images: this.runtime.images(time).map((image, i) => ({ ...image, transition: this.plan.panes[i]!.transition,
        env: { bpm: phase?.bpm ?? this.plan.timing.bpm, beatPhase: phase?.beatPhase ?? 0, barPhase: phase?.barPhase ?? 0, level: transitionLevel(this.host.audio()), reducedMotion: this.host.reducedMotion() } })),
        beat: phase ? phase.beat + phase.beatPhase : 0, level: transitionLevel(this.host.audio()), reducedMotion: this.host.reducedMotion(), previousLayout: this.previousLayout, previousCount: this.previousCount, layoutProgress, layoutMotion: this.plan.layoutMotion });
      this.host.present(this.surface, nowMs); this.dirty = false; if (layoutProgress >= 1) this.previousLayout = undefined;
    }
    return true;
  }
  /** No HTML edits needed: existing host can mount a small launcher on its artwork/stage element. */
  mount(parent: HTMLElement) {
    if (this.button || this.closed) return;
    const button = document.createElement('button'); if (!button.style || typeof button.setAttribute !== 'function') return;
    button.type = 'button'; button.textContent = 'Multiview'; button.setAttribute('aria-label', 'Multiview layouts and panel sources');
    button.onclick = () => this.showControls(parent); button.style.cssText = 'position:absolute;top:10px;left:12px;z-index:4;color:#e5e5e5;background:#202020d9;border:1px solid #606060;padding:5px 9px;cursor:pointer;font:13px Segoe UI,sans-serif;'; parent.append(button); this.button = button;
  }
  showControls(parent?: HTMLElement) {
    if (this.closed) return;
    if (!this.requestedSets) { this.requestedSets = true; this.host.requestSets?.(); }
    if (!this.panel) {
      const panel = document.createElement('section'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Multiview'); panel.tabIndex = -1;
      panel.style.cssText = 'position:absolute;inset:0;z-index:7;overflow:auto;background:#202020;color:#e5e5e5;padding:14px;font:13px Segoe UI,sans-serif;';
      (parent ?? this.button?.parentElement ?? document.body).append(panel); this.panel = panel;
    }
    this.controls?.(); this.panel.hidden = false;
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close multiview controls · Esc'; close.onclick = () => { this.panel!.hidden = true; this.button?.focus(); };
    const content = document.createElement('div'); this.panel.replaceChildren(close, content);
    this.panel.onkeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); close.click(); }
      else if (event.key === 'Tab' && this.panel?.querySelectorAll) {
        const items = [...this.panel.querySelectorAll<HTMLElement>('button,input,select,[tabindex="0"]')].filter(e => !(e as HTMLInputElement).disabled);
        const first = items[0], last = items.at(-1);
        if (first && (document.activeElement === this.panel || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
      }
    };
    this.controls = renderMultiViewControls(content, { plan: () => this.plan, apply: p => this.apply(p), sets: () => this.sets().map(s => ({ id: s.id, name: s.name })), enabled: () => this.enabled, enable: enabled => this.enable(enabled), selectPane: pane => this.selectPane(pane) });
    this.panel.focus();
  }
  close() { if (this.closed) return; this.closed = true; this.runtime?.close(); this.runtime = null; this.compositor.clear(); this.controls?.(); this.controls = null; this.panel?.remove(); this.button?.remove(); }
}
