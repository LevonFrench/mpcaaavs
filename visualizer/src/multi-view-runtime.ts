/** Bounded lane lifecycle. Host injects workers and its one shared audio/clock; this creates no audio decoder. */
import type { AvsAudioFrame } from './avs/types.ts';
import { pickFade, planFade } from './mpc-transition-timing.ts';
import { MultiViewClock, type MultiViewLaneFrame } from './multi-view-clock.ts';
import { multiViewTransitionSeed, type MultiViewPaneImage } from './multi-view-compositor.ts';
import type { MultiViewPlan } from './multi-view-model.ts';
export interface MultiViewBitmap { readonly width: number; readonly height: number; close(): void }
export interface MultiViewRenderFrame {
  readonly lane: MultiViewLaneFrame;
  readonly time: number;
  readonly playing: boolean;
  readonly future: boolean;
  readonly revision: number;
}
export interface MultiViewRenderer {
  /** Exactly one render promise at a time. Caller owns every returned bitmap. */
  render(frame: MultiViewRenderFrame): Promise<MultiViewBitmap>;
  pushAudio?(audio: AvsAudioFrame): void;
  resetAudio?(): void;
  /** Stop the worker only; the runtime owns the last transferred bitmap. */
  dispose(): void;
}
export interface MultiViewRuntimeHost {
  create(index: number, pane: number, signal: AbortSignal): Promise<MultiViewRenderer>;
  changed(): void;
  failed(index: number, pane: number, message: string): void;
  smooth?(index: number): boolean;
  /** Resolution/policy identity: a paused pane still rerenders when its viewport settles after a layout or DPR change. */
  renderKey?(index: number, pane: number): string;
  /** Monotonic milliseconds for frame measurements (defaults to the last tick time). */
  now?(): number;
  /** One ACCEPTED, visible, playing pane frame and its request-to-bitmap cost. Stale, preload and paused frames are never reported. */
  measured?(index: number, pane: number, frameMs: number): void;
}
interface Slot { renderer: MultiViewRenderer; index: number; bitmap: MultiViewBitmap | null; busy: boolean; revision: number; sent: number; dead: boolean; key: string; accepted: number }
interface Pending { abort: AbortController; index: number; frame: MultiViewLaneFrame; slot: Slot | null; started: number; dead: boolean }
interface Lane { current: Slot | null; pending: Pending | null; old: MultiViewBitmap | null; oldIndex: number; start: number; duration: number; seed: number; retryAt: number; errorKey: string }
const lane = (): Lane => ({ current: null, pending: null, old: null, oldIndex: -1, start: 0, duration: 0, seed: 1, retryAt: 0, errorKey: '' });
/** Four live panes plus ONE incoming renderer, serialized fairly. Outgoing faces freeze as bitmaps (no outgoing workers). */
export class MultiViewRuntime {
  private lanes: Lane[] = [];
  private inFlight = false;
  private cursor = 0;
  private revision = 0;
  private closed = false;
  private lastTime = NaN;
  private now = 0;
  private visible = true;
  private playing = false;
  /** Presentation policy (pane transitions, fade lengths). Updated in place: it never discards cues, selections or loaded panes. */
  private policy: MultiViewPlan;
  constructor(private clock: MultiViewClock, private readonly host: MultiViewRuntimeHost) { this.lanes = Array.from({ length: clock.plan.count }, lane); this.policy = clock.plan; }
  get plan() { return this.clock.plan; }
  private stamp() { const now = this.host.now?.(); return typeof now === 'number' && Number.isFinite(now) ? now : this.now; }
  /** Adopt a new presentation policy without reconfiguring lanes. A fade already running keeps its planned span; Cut applies at once. */
  present(plan: MultiViewPlan) {
    if (this.closed) return;
    this.policy = plan;
    for (let i = 0; i < this.lanes.length; i++) { const l = this.lanes[i]!; if (l.old && plan.panes[i]?.transition === 'cut') { l.old.close(); l.old = null; } }
    this.host.changed();
  }
  /** Age in ms of the oldest displayed pane frame (the frame-age channel, separate from composite submission FPS); null before any frame. */
  frameAge(): number | null {
    const now = this.stamp(); let age: number | null = null;
    for (const l of this.lanes) if (l.current?.bitmap && l.current.accepted > 0) age = Math.max(age ?? 0, now - l.current.accepted);
    return age;
  }
  currentIndex(pane: number): number | null { return this.lanes[pane]?.current?.bitmap ? this.lanes[pane]!.current!.index : null; }
  get workerCount() { return this.lanes.reduce((n, l) => n + (l.current ? 1 : 0) + (l.pending?.slot ? 1 : 0), 0); }
  configure(clock: MultiViewClock) {
    if (this.closed) return;
    this.revision++; this.clock = clock; this.policy = clock.plan;
    for (const l of this.lanes) { this.cancel(l); l.old?.close(); l.old = null; l.retryAt = 0; l.errorKey = ''; }
    while (this.lanes.length > clock.plan.count) this.release(this.lanes.pop()!);
    while (this.lanes.length < clock.plan.count) this.lanes.push(lane());
    this.host.changed();
  }
  private stop(slot: Slot | null, close = true) { if (!slot || slot.dead) return; slot.dead = true; slot.renderer.dispose(); if (close) slot.bitmap?.close(); slot.bitmap = null; }
  private cancel(l: Lane) { const p = l.pending; if (!p) return; p.dead = true; p.abort.abort(); this.stop(p.slot); l.pending = null; }
  private release(l: Lane) { this.cancel(l); this.stop(l.current); l.current = null; l.old?.close(); l.old = null; }
  feed(audio: AvsAudioFrame) { for (const l of this.lanes) { l.current?.renderer.pushAudio?.(audio); l.pending?.slot?.renderer.pushAudio?.(audio); } }
  seek() {
    if (this.closed) return;
    this.revision++;
    for (const l of this.lanes) { this.cancel(l); l.old?.close(); l.old = null; l.current?.renderer.resetAudio?.(); l.retryAt = 0; l.errorKey = ''; }
    this.host.changed();
  }
  private render(slot: Slot, frame: MultiViewLaneFrame, time: number, future: boolean) {
    // Hidden views dispatch nothing, preloads included: a pane whose worker finishes loading while hidden renders on the next visible tick.
    if (slot.dead || slot.busy || !this.visible) return;
    const key = `${this.revision}:${time}:${this.playing}:${future}:${this.host.renderKey?.(slot.index, frame.pane) ?? ''}`;
    if (slot.key === key) return;
    slot.busy = true; slot.sent = this.now; const revision = this.revision, sent = this.stamp(), measured = this.playing && !future;
    Promise.resolve().then(() => slot.renderer.render({ lane: frame, time, playing: this.playing && !future, future, revision })).then(bitmap => {
      slot.busy = false;
      if (this.closed || slot.dead || revision !== this.revision) { bitmap.close(); return; }
      const done = this.stamp();
      slot.bitmap?.close(); slot.bitmap = bitmap; slot.revision = revision; slot.key = key; slot.accepted = done;
      if (measured && this.visible) this.host.measured?.(slot.index, frame.pane, Math.max(0, done - sent));
      this.host.changed();
    }).catch(error => { slot.busy = false; if (!slot.dead && !this.closed) this.failure(slot.index, frame.pane, String(error)); });
  }
  private failure(index: number, pane: number, message: string) {
    const l = this.lanes[pane]; if (!l || this.closed) return;
    if (l.pending?.index === index) this.cancel(l);
    else if (l.current?.index === index) { this.stop(l.current); l.current = null; }
    l.retryAt = this.now + 5000;
    // One warning per failed target, rather than announcing the same dead pane every frame.
    const key = `${this.revision}:${index}`; if (l.errorKey !== key) { l.errorKey = key; this.host.failed(index, pane, message); }
    this.host.changed();
  }
  private load(pane: number, target: MultiViewLaneFrame) {
    const l = this.lanes[pane]!, p: Pending = { abort: new AbortController(), index: target.phase.index, frame: target, slot: null, started: this.now, dead: false };
    l.pending = p; this.inFlight = true;
    Promise.resolve().then(() => this.host.create(p.index, pane, p.abort.signal)).then(renderer => {
      if (this.closed || p.dead || p.abort.signal.aborted) { renderer.dispose(); return; }
      const slot: Slot = { renderer, index: p.index, bitmap: null, busy: false, revision: this.revision, sent: this.now, dead: false, key: '', accepted: 0 }; p.slot = slot;
      this.render(slot, p.frame, Math.max(this.lastTime, p.frame.phase.start), p.frame.phase.start > this.lastTime);
    }).catch(error => { if (!p.dead && !this.closed) this.failure(p.index, pane, String(error)); }).finally(() => { this.inFlight = false; });
  }
  private commit(l: Lane, frame: MultiViewLaneFrame, time: number) {
    const p = l.pending;
    if (!p?.slot?.bitmap || p.slot.revision !== this.revision || p.index !== frame.phase.index) return;
    l.old?.close(); l.old = l.current?.bitmap ?? null; l.oldIndex = l.current?.index ?? -1;
    this.stop(l.current, false); l.current = p.slot; l.pending = null;
    const phase = frame.phase, plan = this.policy;
    const fade = planFade(plan.fade, pickFade(plan.fade, phase.ordinal, frame.clock.timing.seed), { bpm: phase.bpm, beatsPerBar: phase.beatsPerBar, grid: frame.clock.grid, boundaryBeat: frame.clock.grid.beatAt(phase.start), capSeconds: phase.duration });
    l.start = phase.start; l.duration = fade.seconds; l.seed = multiViewTransitionSeed(plan.timing.seed, frame.pane, phase.ordinal);
    if (time >= l.start + l.duration || plan.panes[frame.pane]?.transition === 'cut') { l.old?.close(); l.old = null; }
    this.host.changed();
  }
  /** Call from the existing rAF with authoritative media time. Hidden views start no new work and dispatch no render requests. */
  tick(time: number, nowMs: number, playing: boolean, visible = true, selectionTime = time, rotate = true) {
    if (this.closed || !Number.isFinite(time) || !Number.isFinite(nowMs)) return;
    if (Number.isFinite(this.lastTime) && (time < this.lastTime || time - this.lastTime > .75)) this.seek();
    this.lastTime = time; this.now = nowMs; this.visible = visible; this.playing = playing;
    const frames = this.clock.at(selectionTime);
    for (let i = 0; i < this.lanes.length; i++) {
      const l = this.lanes[i]!, frame = frames[i];
      if (!frame) { this.release(l); continue; }
      if (l.old && time >= l.start + l.duration) { l.old.close(); l.old = null; this.host.changed(); }
      if (l.pending && nowMs - l.pending.started > 15000) this.failure(l.pending.index, i, 'Pane initialization timed out');
      if (l.current?.busy && nowMs - l.current.sent > 5000) this.failure(l.current.index, i, 'Pane render timed out');
      if (!visible) continue;
      if (l.pending && l.pending.index !== frame.phase.index && l.pending.index !== frame.next.index) this.cancel(l);
      if (l.pending?.index === frame.phase.index) this.commit(l, frame, time);
      if (l.current?.index === frame.phase.index) this.render(l.current, frame, time, false);
      if (l.pending?.slot && !l.pending.slot.bitmap) this.render(l.pending.slot, l.pending.frame, Math.max(time, l.pending.frame.phase.start), l.pending.frame.phase.start > time);
    }
    if (!visible || this.inFlight || this.lanes.some(l => l.pending)) return;
    // Scan from a rotating cursor so an expensive or empty first lane cannot starve other panes.
    for (let step = 0; step < this.lanes.length; step++) {
      const i = (this.cursor + step) % this.lanes.length, l = this.lanes[i]!, frame = frames[i];
      if (!frame || nowMs < l.retryAt) continue;
      let target = frame;
      if (l.current?.index === frame.phase.index) {
        const lookahead = Math.min(2, frame.phase.duration / 4, frame.phase.beatsPerBar * 60 / frame.phase.bpm);
        if (!rotate || !playing || frame.next.index === frame.phase.index || frame.phase.end - time > lookahead) continue;
        target = { ...frame, phase: frame.next };
      }
      this.cursor = (i + 1) % this.lanes.length; this.load(i, target); break;
    }
  }
  images(time: number): readonly MultiViewPaneImage[] {
    return this.lanes.map((l, pane) => {
      const plate = (bitmap: MultiViewBitmap | null | undefined, index: number) => bitmap ? { image: bitmap as CanvasImageSource, width: bitmap.width, height: bitmap.height, smooth: this.host.smooth?.(index) ?? true } : null;
      return { current: plate(l.current?.bitmap, l.current?.index ?? -1), outgoing: plate(l.old, l.oldIndex),
        progress: l.duration > 0 ? Math.max(0, Math.min(1, (time - l.start) / l.duration)) : 1, seed: l.seed, transition: this.policy.panes[pane]?.transition ?? 'cut' };
    });
  }
  close() { if (this.closed) return; this.closed = true; this.revision++; for (const l of this.lanes) this.release(l); }
}
