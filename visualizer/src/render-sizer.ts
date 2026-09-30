/** The small stateful adapter the host owns around the pure render-resolution policy: display preferences, the observed device-pixel box,
 * the Auto quality governor and the size debouncers. Time comes only from the injected host, so every path replays under a fake clock.
 *
 * Debounce (RES 5.5): an AVS size change resets feedback state and rebuilds GPU resources, so it must settle for 250 ms; vector kinds
 * pay allocation churn instead and settle for 120 ms. While a change is pending `resolve` keeps returning the last committed
 * value, which the compositor keeps stretching. A change of preference, tier, scene traits or kind commits at once, and so does the
 * first resolve for a scene and the first after a scene went unresolved for its whole settle time (an AVS preset preloaded while a
 * NERV scene plays), so a preset always loads at its settled size and never at one remembered from earlier.
 *
 * The last section holds the duck-typed host glue (device-box observer, canvas sizing, surface presenter) so the host edit stays a set of
 * call sites: the presenter draws a source into `ResolvedRender.box` with the smoothing, bars and sharp-bilinear prescale that RES 5.3-5.4 define.
 *
 * Proposed in docs/design/RESOLUTION-PIPELINE.md 5.5-5.9; CPU-checked by tools/check-render-sizer.mjs; not wired into the host until
 * the Wave 3 integration (docs/design/CONTRACT.md Appendix A). */
import { AvsFrameGovernor, avsGovernorOptions } from './avs-presentation.ts';
import { DEFAULT_PREFS, parseDisplayPrefs, type DisplayPrefs } from './mpc-display.ts';
import { QualityGovernor, resolveRender, type RenderKind, type ResolvedRender, type SceneTraits, type Size } from './render-resolution.ts';

export interface SizerHost { cssSize(): Size; dpr(): number; now(): number }

/** Settle time before a changed size is adopted. */
export const AVS_SETTLE_MS = 250, VECTOR_SETTLE_MS = 120;
/** An observed device-pixel box more than this factor away from css * dpr is treated as stale and ignored. */
const DEVICE_TRUST = 2;
const MAX_ENTRIES = 64;

/** `seen` is the host time of the last resolve for this scene: an entry nobody consumed for its whole settle time protects no live surface. */
interface Entry { sig: string; committed: ResolvedRender; pendingKey: string | null; since: number; seen: number }

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

export class RenderSizer {
  private current: DisplayPrefs;
  private readonly governor = new QualityGovernor();
  private avsGovernor: AvsFrameGovernor | null = null;
  private device: Size | null = null;
  private readonly entries = new Map<string, Entry>();
  private readonly tierDriven = new Map<RenderKind, boolean>();

  constructor(private readonly host: SizerHost, prefs: DisplayPrefs = DEFAULT_PREFS) {
    this.current = parseDisplayPrefs(prefs, DEFAULT_PREFS);
  }

  get prefs(): DisplayPrefs { return this.current; }

  /** Adopt new preferences (invalid keys keep their current value). Changing the quality restarts Auto at its ceiling; changing the AVS resolution restarts its governor. */
  setPrefs(next: DisplayPrefs): void {
    const previous = this.current;
    this.current = parseDisplayPrefs(next, previous);
    if (this.current.quality !== previous.quality) this.governor.reset();
    if (this.current.avsResolution !== previous.avsResolution) this.avsGovernor = null;
  }

  /** The device-pixel content box the browser reports for the canvas (ResizeObserver `devicePixelContentBoxSize`); anything else clears it. */
  observeDevice(width: number, height: number): void {
    this.device = positive(width) && positive(height) ? { width: Math.round(width), height: Math.round(height) } : null;
  }

  /**
   * Surfaces for one scene of `kind` in the current view. Debounced: the first call for a scene, and any change of preferences, tier or
   * traits, returns the fresh value; a size-only change is adopted after the kind's settle time and until then the last committed value
   * is returned. A view with a zero dimension (minimised, not laid out) never replaces a committed value.
   */
  resolve(kind: RenderKind, traits?: SceneTraits): ResolvedRender {
    const css = this.host.cssSize(), dpr = this.host.dpr(), now = this.host.now();
    const sig = this.signature(kind, traits), id = `${kind}|${traitsKey(traits)}`;
    const held = this.entries.get(id), laidOut = css.width > 0 && css.height > 0;
    // No layout yet (or minimised): keep what was committed, and never commit a size derived from nothing.
    if (!laidOut) return held && held.sig === sig ? held.committed : this.compute(kind, traits, css, dpr);
    const raw = this.compute(kind, traits, css, dpr);
    this.tierDriven.set(kind, kind === 'nerv' || (kind === 'hud' && raw.cssImageRendering !== 'pixelated'));
    const settle = kind === 'avs' ? AVS_SETTLE_MS : VECTOR_SETTLE_MS, idle = held !== undefined && now - held.seen >= settle;
    // A new scene, a changed preference and a scene that went unresolved for its settle time (an AVS preset preloaded while a NERV scene
    // plays, a backgrounded tab) commit at once: nothing was showing the old size, so there is nothing to protect from a reset.
    if (!held || held.sig !== sig || idle) return this.commit(id, { sig, committed: raw, pendingKey: null, since: now, seen: now });
    held.seen = now;
    if (raw.key === held.committed.key) { held.committed = raw; held.pendingKey = null; return raw; }
    if (held.pendingKey !== raw.key) { held.pendingKey = raw.key; held.since = now; return held.committed; }
    if (now - held.since >= settle) { held.committed = raw; held.pendingKey = null; return raw; }
    return held.committed;
  }

  /**
   * Feed one measured frame cost (ms). Vector kinds feed the Auto governor while `quality` is auto and the scene is tier driven (a pixel-art
   * scene has no tier); true when the tier changed. Extension for the AVS `high` opt-in: AVS frames feed the Studio governor (2x, 1.5x,
   * 1x, 2 s dwell, never stepping back up) and return true when the raster scale changed; classic and crisp never change.
   */
  recordFrame(kind: RenderKind, frameMs: number): boolean {
    if (kind === 'avs') {
      if (this.current.avsResolution !== 'high') return false;
      const governor = this.avsHighGovernor(), before = governor.tier.scale;
      governor.recordRender(frameMs, this.host.now());
      return governor.tier.scale !== before;
    }
    if (this.current.quality !== 'auto' || this.tierDriven.get(kind) === false) return false;
    return this.governor.record(frameMs, this.host.now());
  }

  /** Forget everything learned about the view (governors, committed sizes, the device box); preferences stay. */
  reset(): void {
    this.governor.reset();
    this.avsGovernor = null;
    this.device = null;
    this.entries.clear();
    this.tierDriven.clear();
  }

  private avsHighGovernor(): AvsFrameGovernor {
    return this.avsGovernor ??= new AvsFrameGovernor(avsGovernorOptions({ upscale: 'pixelated', resolution: 'high', frameRate: '60' }, 'worker'));
  }

  private compute(kind: RenderKind, traits: SceneTraits | undefined, css: Size, dpr: number): ResolvedRender {
    const device = this.trustedDevice(css, dpr);
    return resolveRender({
      kind, cssWidth: css.width, cssHeight: css.height, dpr,
      ...(device ? { deviceWidth: device.width, deviceHeight: device.height } : {}),
      tier: this.current.quality, autoTier: this.governor.tier, pixelArt: this.current.pixelArt,
      avs: { mode: this.current.avsResolution, scale: this.avsGovernor?.tier.scale ?? 2 },
      ...(traits ? { traits } : {}),
    });
  }

  /** The observed box, unless it disagrees wildly with css * dpr (a stale observation from before a zoom or a monitor change). */
  private trustedDevice(css: Size, dpr: number): Size | null {
    const device = this.device;
    if (!device || !(css.width > 0 && css.height > 0 && positive(dpr))) return null;
    const rx = device.width / (css.width * dpr), ry = device.height / (css.height * dpr);
    return rx <= DEVICE_TRUST && rx >= 1 / DEVICE_TRUST && ry <= DEVICE_TRUST && ry >= 1 / DEVICE_TRUST ? device : null;
  }

  /** Everything that forces an immediate commit: a size-only change is the one thing that does not appear here. */
  private signature(kind: RenderKind, traits: SceneTraits | undefined): string {
    const p = this.current;
    return `${kind}|${p.quality}|${p.avsResolution}|${p.pixelArt}|${p.quality === 'auto' ? this.governor.tier : '-'}|${p.avsResolution === 'high' ? this.avsGovernor?.tier.scale ?? 2 : '-'}|${traitsKey(traits)}`;
  }

  private commit(id: string, entry: Entry): ResolvedRender {
    if (this.entries.size >= MAX_ENTRIES && !this.entries.has(id)) this.entries.delete(this.entries.keys().next().value as string);
    this.entries.set(id, entry);
    return entry.committed;
  }
}

/** Identity of the traits that change what a scene needs (design canvas and pixel grid). */
function traitsKey(traits: SceneTraits | undefined): string {
  const l = traits?.logical, g = traits?.pixelGrid;
  return `${l ? `${l.width}x${l.height}` : '-'}|${g ? `${g.width}x${g.height}@${g.par ?? 1}` : '-'}`;
}

// ---------------------------------------------------------------- host glue: device box and presentation
// Small, duck-typed and DOM-free in code (no globals are read except the optional ResizeObserver): the host passes its canvas and
// contexts, and the CPU check drives them with fakes. They keep the host edit of docs/design/CONTRACT.md Appendix A mechanical.

/** The part of a ResizeObserverEntry the sizer reads. */
export interface DeviceBoxEntry { readonly devicePixelContentBoxSize?: ArrayLike<{ readonly inlineSize: number; readonly blockSize: number }> | { readonly inlineSize: number; readonly blockSize: number } }
export interface DeviceBoxObserver { observe(target: unknown, options?: { box?: string }): void; disconnect(): void }
export type DeviceBoxObserverConstructor = new (callback: (entries: readonly DeviceBoxEntry[]) => void) => DeviceBoxObserver;

/**
 * Feed `sizer.observeDevice` from a ResizeObserver on `target` using the `device-pixel-content-box`, so the backing store equals the
 * snapped device box on fractional DPR and browser zoom (RES 5.5). Feature detected and fully guarded: without a ResizeObserver, or when
 * the browser rejects that box, this returns null and the sizer keeps using css * dpr. An entry without the device box clears the
 * observation. The returned function disconnects the observer.
 */
export function watchDeviceBox(target: unknown, sizer: Pick<RenderSizer, 'observeDevice'>, Observer?: DeviceBoxObserverConstructor): (() => void) | null {
  const Constructor = Observer ?? (typeof ResizeObserver === 'undefined' ? undefined : ResizeObserver as unknown as DeviceBoxObserverConstructor);
  if (!Constructor) return null;
  try {
    const observer = new Constructor(entries => {
      const entry = entries[entries.length - 1], box = entry?.devicePixelContentBoxSize;
      const first = box && 'inlineSize' in box ? box : box?.[0];
      if (first) sizer.observeDevice(first.inlineSize, first.blockSize); else sizer.observeDevice(0, 0);
    });
    observer.observe(target, { box: 'device-pixel-content-box' });
    return () => { try { observer.disconnect(); } catch { /* already gone */ } };
  } catch { return null; }
}

/** The parts of the display canvas the presenter touches; `style` may be absent (fixtures, old embeddings). */
export interface PresentCanvas { width: number; height: number; style?: { imageRendering: string } }
export interface PresentContext {
  imageSmoothingEnabled: boolean; imageSmoothingQuality?: ImageSmoothingQuality; fillStyle: unknown;
  drawImage(source: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
}
export interface ScratchCanvas { width: number; height: number; getContext(kind: '2d'): PresentContext | null }

/**
 * The canvas-level part of a resolved render: the backing-store size and the inline `image-rendering` (an inline value overrides the
 * static stylesheet rule, so the two HTML pages need no CSS edit). Returns true when the size changed; that clears the canvas and
 * voids the flash gate's prediction, so the caller resets the gate.
 */
export function sizeCanvas(canvas: PresentCanvas, r: ResolvedRender): boolean {
  const changed = canvas.width !== r.canvas.width || canvas.height !== r.canvas.height;
  if (changed) { canvas.width = r.canvas.width; canvas.height = r.canvas.height; }
  const style = canvas.style;
  if (style && style.imageRendering !== r.cssImageRendering) style.imageRendering = r.cssImageRendering;
  return changed;
}

/** Largest scratch surface the sharp-bilinear prescale will allocate (matches the hard render cap). */
const MAX_SCRATCH_PIXELS = 3840 * 2160;

/**
 * Draws a source surface into the display canvas the way a ResolvedRender says: bars cleared when the box does not cover the canvas,
 * nearest or smooth (`high` quality) sampling, and for `sharp-bilinear` a nearest enlargement by `prescale` into a reused scratch
 * surface before the final smooth draw. Call it inside the flash gate's draw callback. Never throws for a bad source size.
 */
export class SurfacePresenter {
  private scratch: ScratchCanvas | null = null;
  private scratchContext: PresentContext | null = null;

  constructor(private readonly createScratch: (width: number, height: number) => ScratchCanvas | null) {}

  draw(context: PresentContext, source: CanvasImageSource, sourceSize: Size, r: ResolvedRender): void {
    const { box, canvas } = r;
    if (!(box.x <= 0 && box.y <= 0 && box.x + box.width >= canvas.width && box.y + box.height >= canvas.height)) {
      context.fillStyle = '#000';
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    let from: CanvasImageSource = source;
    if (r.smoothing === 'sharp-bilinear' && r.prescale > 1) from = this.enlarge(source, sourceSize, r.prescale) ?? source;
    const smooth = r.smoothing !== 'nearest';
    context.imageSmoothingEnabled = smooth;
    if (smooth) context.imageSmoothingQuality = 'high';
    context.drawImage(from, box.x, box.y, box.width, box.height);
  }

  /** Release the scratch surface (a scene change, a teardown). */
  dispose(): void { this.scratch = null; this.scratchContext = null; }

  private enlarge(source: CanvasImageSource, size: Size, factor: number): CanvasImageSource | null {
    const w = Math.round(size.width * factor), h = Math.round(size.height * factor);
    if (!(w >= 1 && h >= 1) || w * h > MAX_SCRATCH_PIXELS) return null;
    if (!this.scratch) {
      this.scratch = this.createScratch(w, h);
      this.scratchContext = this.scratch?.getContext('2d') ?? null;
      if (!this.scratch || !this.scratchContext) { this.scratch = null; this.scratchContext = null; return null; }
    }
    if (this.scratch.width !== w) this.scratch.width = w;
    if (this.scratch.height !== h) this.scratch.height = h;
    const ctx = this.scratchContext!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source, 0, 0, w, h);
    return this.scratch as unknown as CanvasImageSource;
  }
}
