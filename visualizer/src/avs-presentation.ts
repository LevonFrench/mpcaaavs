/** CPU AVS presentation policy, kept independent of the DOM for deterministic tests. */

export interface AvsQualityTier {
  readonly scale: number;
  readonly fps: number;
}

export const AVS_QUALITY_TIERS: readonly AvsQualityTier[] = [
  { scale: 1, fps: 165 },
  { scale: 0.8, fps: 120 },
  { scale: 0.67, fps: 60 },
  { scale: 0.5, fps: 30 },
];

/**
 * How the AVS raster is derived from the display.
 * - `fit` (default, today's behaviour): scale the display down to the caps and
 *   round each axis. The upscale factor is usually fractional.
 * - `integer`: pick an integer device-pixel factor k and render
 *   ceil(W/k) x ceil(H/k), so every AVS pixel is an exact k x k block. Both caps
 *   are relaxed by `INTEGER_CAP_SLACK` (about 11%) so 16:10 panels reach 640x400
 *   at k=3/4 instead of 480x300. The raster differs from `fit`, so pixel-unit
 *   effects render differently: this is opt-in, never a default.
 */
export type AvsDimensionsPolicy = 'fit' | 'integer';

/** 10/9: exactly what 640x400 (256 000 px) needs against the 230 400 px cap. */
export const INTEGER_CAP_SLACK = 10 / 9;

export interface AvsFrameGovernorOptions {
  readonly tiers?: readonly AvsQualityTier[];
  readonly initialTier?: number;
  readonly downgradeSamples?: number;
  readonly upgradeSamples?: number;
  readonly overloadRatio?: number;
  readonly headroomRatio?: number;
  readonly maxPixels?: number;
  readonly maxEdge?: number;
  /** Default `fit`. */
  readonly dimensionsPolicy?: AvsDimensionsPolicy;
  /**
   * recordRender never selects a tier whose scale is below this. Unset keeps
   * today's unbounded fallback tiers. Classic worker rendering passes 1, so an
   * overloaded preset can never be auto-downscaled away from classic pixels.
   */
  readonly minScale?: number;
  /** Minimum time between two scale changes, when recordRender is given a clock. Default 0. */
  readonly scaleDwellMs?: number;
  /** Samples ignored after every reset/tier change (device and JIT warm-up). Default 0. */
  readonly warmupSamples?: number;
}

/**
 * Caps AVS work independently from display DPR, then uses hysteresis to keep a
 * slow preset within its frame budget. Audio polling is intentionally outside
 * this class: only expensive legacy rendering is cadence-limited.
 */
export class AvsFrameGovernor {
  private readonly tiers: readonly AvsQualityTier[];
  private readonly downgradeSamples: number;
  private readonly upgradeSamples: number;
  private readonly overloadRatio: number;
  private readonly headroomRatio: number;
  private readonly maxPixels: number;
  private readonly maxEdge: number;
  private readonly initialTier: number;
  private readonly dimensionsPolicy: AvsDimensionsPolicy;
  private readonly minScale: number;
  private readonly scaleDwellMs: number;
  private readonly warmupSamples: number;
  private displayHz: number | null = null;
  private lastScaleChangeMs: number | null = null;
  private warmupLeft: number;
  private nextRenderMs: number | null = null;
  private overloadCount = 0;
  private headroomCount = 0;
  private emaMs = 0;
  private samples = 0;
  private tierIndex: number;

  constructor(options: AvsFrameGovernorOptions = {}) {
    this.tiers = options.tiers ?? AVS_QUALITY_TIERS;
    if (this.tiers.length === 0) throw new RangeError('AVS quality tiers cannot be empty');
    for (const tier of this.tiers) {
      if (!(tier.scale > 0) || !(tier.fps > 0)) throw new RangeError('Invalid AVS quality tier');
    }
    // Begin near classic AVS-era dimensions. Fast presets earn more resolution;
    // pathological ones reach the 320-ish tier after their first measured frame.
    this.initialTier = clampIndex(options.initialTier ?? 2, this.tiers.length);
    this.tierIndex = this.initialTier;
    this.downgradeSamples = positiveInteger(options.downgradeSamples ?? 8, 'downgradeSamples');
    this.upgradeSamples = positiveInteger(options.upgradeSamples ?? 180, 'upgradeSamples');
    this.overloadRatio = positive(options.overloadRatio ?? 0.7, 'overloadRatio');
    this.headroomRatio = positive(options.headroomRatio ?? 0.3, 'headroomRatio');
    this.maxPixels = positive(options.maxPixels ?? 640 * 360, 'maxPixels');
    this.maxEdge = positive(options.maxEdge ?? 640, 'maxEdge');
    this.dimensionsPolicy = options.dimensionsPolicy ?? 'fit';
    this.minScale = options.minScale ?? 0;
    this.scaleDwellMs = Math.max(0, options.scaleDwellMs ?? 0);
    this.warmupSamples = Math.max(0, Math.trunc(options.warmupSamples ?? 0));
    this.warmupLeft = this.warmupSamples;
    if (this.tiers[this.initialTier]!.scale < this.minScale) {
      throw new RangeError('The initial AVS tier is below the minimum scale');
    }
  }

  get tier(): AvsQualityTier { return this.tiers[this.tierIndex]!; }
  get qualityIndex(): number { return this.tierIndex; }
  get averageRenderMs(): number { return this.emaMs; }
  get measuredDisplayHz(): number | null { return this.displayHz; }
  get policy(): AvsDimensionsPolicy { return this.dimensionsPolicy; }

  reset(): void {
    this.tierIndex = this.initialTier;
    this.nextRenderMs = null;
    this.lastScaleChangeMs = null;
    this.resetSamples();
  }

  /**
   * Opt-in display awareness. Until this is called the governor behaves exactly
   * as before. Afterwards (a) the frame budget is 1000 / min(tier fps, display
   * Hz), so a 165 fps tier is not an unreachable 6 ms budget on a 60 Hz panel,
   * and (b) cadence is a whole number of vsyncs with half a vsync of tolerance,
   * so rAF jitter cannot produce 1-3-1 gaps.
   */
  setDisplayHz(hz: number | null): void {
    this.displayHz = hz !== null && Number.isFinite(hz) && hz > 0 ? hz : null;
  }

  /** The target interval in ms: the tier fps, rounded to a vsync divisor once display Hz is known. */
  get renderIntervalMs(): number {
    if (this.displayHz === null) return 1000 / this.tier.fps;
    const vsyncs = Math.max(1, Math.round(this.displayHz / this.tier.fps));
    return vsyncs * 1000 / this.displayHz;
  }

  /** True at most once per target interval; late callbacks never cause catch-up bursts. */
  shouldRender(nowMs: number): boolean {
    if (!Number.isFinite(nowMs)) return false;
    const interval = this.renderIntervalMs;
    const tolerance = this.displayHz === null ? 0.25 : 500 / this.displayHz;
    if (this.nextRenderMs === null || nowMs - this.nextRenderMs > interval * 2) {
      this.nextRenderMs = nowMs + interval;
      return true;
    }
    if (nowMs + tolerance < this.nextRenderMs) return false;
    const intervalsLate = Math.max(0, Math.floor((nowMs - this.nextRenderMs) / interval));
    this.nextRenderMs += (intervalsLate + 1) * interval;
    return true;
  }

  /**
   * Records runtime + pixel conversion + canvas upload time. Returns true on a
   * tier change. `nowMs` is only needed for `scaleDwellMs`; without it the
   * dwell is not enforced, exactly as before.
   */
  recordRender(renderMs: number, nowMs?: number): boolean {
    if (!Number.isFinite(renderMs) || renderMs < 0) return false;
    if (this.warmupLeft > 0) {
      this.warmupLeft--;
      return false;
    }
    this.emaMs = this.samples === 0 ? renderMs : this.emaMs * 0.85 + renderMs * 0.15;
    this.samples++;
    const budget = this.displayHz === null
      ? 1000 / this.tier.fps
      : 1000 / Math.min(this.tier.fps, this.displayHz);
    const canStepDown = this.canMoveTo(this.tierIndex + 1, nowMs);
    // Hundreds-of-ms legacy frames must step down on the very next frame; an
    // eight-sample confirmation at that cost would freeze the page for seconds.
    if (renderMs > budget * 2 && canStepDown) return this.moveTo(this.tierIndex + 1, nowMs);
    const overloaded = renderMs > budget || this.emaMs > budget * this.overloadRatio;
    const hasHeadroom = renderMs < budget * 0.5 && this.emaMs < budget * this.headroomRatio;

    this.overloadCount = overloaded ? this.overloadCount + 1 : Math.max(0, this.overloadCount - 1);
    this.headroomCount = hasHeadroom ? this.headroomCount + 1 : 0;
    if (this.overloadCount >= this.downgradeSamples && canStepDown) return this.moveTo(this.tierIndex + 1, nowMs);
    if (this.headroomCount >= this.upgradeSamples && this.canMoveTo(this.tierIndex - 1, nowMs)) {
      return this.moveTo(this.tierIndex - 1, nowMs);
    }
    return false;
  }

  dimensions(displayWidth: number, displayHeight: number): { width: number; height: number } {
    const sourceWidth = Math.max(1, Math.trunc(displayWidth));
    const sourceHeight = Math.max(1, Math.trunc(displayHeight));
    if (this.dimensionsPolicy === 'integer') {
      const k = this.integerFactor(sourceWidth, sourceHeight);
      return { width: Math.ceil(sourceWidth / k), height: Math.ceil(sourceHeight / k) };
    }
    const fit = Math.min(
      1,
      this.maxEdge / Math.max(sourceWidth, sourceHeight),
      Math.sqrt(this.maxPixels / (sourceWidth * sourceHeight)),
    );
    // Tiers above 1 (opt-in High) raise the caps but never render above the
    // display itself. At scale <= 1 the clamp is a no-op, so fit rasters are
    // bit-identical to before.
    const scale = Math.min(1, fit * this.tier.scale);
    return {
      width: Math.max(1, Math.round(sourceWidth * scale)),
      height: Math.max(1, Math.round(sourceHeight * scale)),
    };
  }

  /**
   * Smallest integer k whose ceil(W/k) x ceil(H/k) raster fits the tier-scaled
   * caps relaxed by INTEGER_CAP_SLACK. Lower tiers therefore step k up by whole
   * numbers rather than by 0.8/0.67/0.5. Expects device pixels: an integer k in
   * CSS pixels is still fractional on a 125% or 150% display.
   */
  integerFactor(displayWidth: number, displayHeight: number): number {
    const width = Math.max(1, Math.trunc(displayWidth));
    const height = Math.max(1, Math.trunc(displayHeight));
    const scale = this.tier.scale;
    const maxEdge = this.maxEdge * scale * INTEGER_CAP_SLACK;
    const maxPixels = this.maxPixels * scale * scale * INTEGER_CAP_SLACK;
    for (let k = 1; ; k++) {
      const w = Math.ceil(width / k);
      const h = Math.ceil(height / k);
      if ((Math.max(w, h) <= maxEdge && w * h <= maxPixels) || (w === 1 && h === 1)) return k;
    }
  }

  private canMoveTo(index: number, nowMs: number | undefined): boolean {
    if (index < 0 || index >= this.tiers.length) return false;
    const next = this.tiers[index]!;
    if (next.scale < this.minScale) return false;
    if (next.scale === this.tier.scale || this.scaleDwellMs === 0) return true;
    if (nowMs === undefined || this.lastScaleChangeMs === null) return true;
    return nowMs - this.lastScaleChangeMs >= this.scaleDwellMs;
  }

  private moveTo(index: number, nowMs: number | undefined): boolean {
    if (this.tiers[index]!.scale !== this.tier.scale && nowMs !== undefined) this.lastScaleChangeMs = nowMs;
    this.tierIndex = index;
    this.nextRenderMs = null;
    this.resetSamples();
    return true;
  }

  private resetSamples(): void {
    this.overloadCount = 0;
    this.headroomCount = 0;
    this.emaMs = 0;
    this.samples = 0;
    this.warmupLeft = this.warmupSamples;
  }
}

// ---------------------------------------------------------------- settings

/** How the AVS raster reaches the display. Presentation only: AVS pixels are never touched. */
export type AvsUpscaleMode = 'pixelated' | 'sharp-bilinear' | 'integer-letterbox';
/** Classic = today's 640-class raster; crisp = integer-fit raster; high = opt-in 2x caps, floored at classic. */
export type AvsResolutionMode = 'classic' | 'crisp' | 'high';
/** Display = one AVS frame per vsync at most (today). 60/30 lock the per-frame animation rate. */
export type AvsFrameRateLock = 'display' | '60' | '30';

export interface AvsDisplaySettings {
  readonly upscale: AvsUpscaleMode;
  readonly resolution: AvsResolutionMode;
  readonly frameRate: AvsFrameRateLock;
}

export const AVS_UPSCALE_MODES: readonly AvsUpscaleMode[] = ['pixelated', 'sharp-bilinear', 'integer-letterbox'];
export const AVS_RESOLUTION_MODES: readonly AvsResolutionMode[] = ['classic', 'crisp', 'high'];
export const AVS_FRAME_RATE_LOCKS: readonly AvsFrameRateLock[] = ['display', '60', '30'];

/**
 * Today's look: pixelated stretch, classic raster, display cadence. Every
 * other value is opt-in. Sharp-bilinear is pixel-identical to pixelated
 * wherever the display is an integer multiple of the raster (and within one
 * device pixel of one): measured with headless Chrome screenshots at 1280x720,
 * 1920x1080 (DPR 1 and 1.25), 2560x1440 and a 1920x970 window, 0 differing
 * pixels. It differs on fractional panels (16:10, 1366x768, projectors,
 * ultrawide), where it replaces uneven nearest-neighbour columns with a
 * bilinear remainder of up to ~1.85x, so it stays one keypress (U) away
 * rather than the default. Making it the default is the owner's call.
 */
export const DEFAULT_AVS_DISPLAY_SETTINGS: AvsDisplaySettings = {
  upscale: 'pixelated',
  resolution: 'classic',
  frameRate: 'display',
};

/** localStorage key shared by the control and projector windows (same origin). */
export const AVS_DISPLAY_SETTINGS_KEY = 'aaavs.avsDisplay.v1';

/** Tolerant parse of a stored settings blob: unknown or missing fields fall back to the default. */
export function parseAvsDisplaySettings(raw: string | null | undefined): AvsDisplaySettings {
  let value: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object') value = parsed as Record<string, unknown>;
  } catch { /* corrupt blob: defaults */ }
  const pick = <T extends string>(field: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(field as T) ? field as T : fallback;
  return {
    upscale: pick(value.upscale, AVS_UPSCALE_MODES, DEFAULT_AVS_DISPLAY_SETTINGS.upscale),
    resolution: pick(value.resolution, AVS_RESOLUTION_MODES, DEFAULT_AVS_DISPLAY_SETTINGS.resolution),
    frameRate: pick(value.frameRate, AVS_FRAME_RATE_LOCKS, DEFAULT_AVS_DISPLAY_SETTINGS.frameRate),
  };
}

export function nextInCycle<T>(values: readonly T[], current: T): T {
  return values[(values.indexOf(current) + 1) % values.length]!;
}

/** The fps cap a lock implies. `display` keeps today's 165 fps ceiling (rAF provides the real cap). */
export function frameRateLockFps(lock: AvsFrameRateLock): number {
  return lock === '60' ? 60 : lock === '30' ? 30 : AVS_QUALITY_TIERS[0]!.fps;
}

/**
 * Governor options for one host and one settings value.
 *
 * `worker` (the shipped path) never auto-downscales in classic or crisp: one
 * tier, so recordRender can only update its average. That is the floor that
 * keeps the default raster identical to today once recordRender is wired.
 * High starts at 2x caps and may step down to 1.5x and then to classic, with
 * a 2 s dwell and a warm-up, never below classic and never back up mid-preset
 * (a scale change resets AVS feedback state).
 *
 * `fallback` (main-thread CPU renderer) keeps today's four tiers, because a
 * hundreds-of-ms frame there freezes the page. With the default settings it
 * returns today's exact options.
 */
export function avsGovernorOptions(
  settings: AvsDisplaySettings,
  host: 'worker' | 'fallback',
): AvsFrameGovernorOptions {
  const lockFps = frameRateLockFps(settings.frameRate);
  const capFps = (tier: AvsQualityTier): AvsQualityTier => ({ scale: tier.scale, fps: Math.min(tier.fps, lockFps) });
  const dimensionsPolicy: AvsDimensionsPolicy = settings.resolution === 'crisp' ? 'integer' : 'fit';
  if (host === 'fallback') {
    return {
      initialTier: 0,
      dimensionsPolicy,
      ...(settings.frameRate === 'display' ? {} : { tiers: AVS_QUALITY_TIERS.map(capFps) }),
    };
  }
  if (settings.resolution === 'high') {
    return {
      tiers: [{ scale: 2, fps: lockFps }, { scale: 1.5, fps: lockFps }, { scale: 1, fps: lockFps }],
      initialTier: 0,
      minScale: 1,
      scaleDwellMs: 2000,
      warmupSamples: 3,
      upgradeSamples: Number.MAX_SAFE_INTEGER,
    };
  }
  return { tiers: [capFps(AVS_QUALITY_TIERS[0]!)], initialTier: 0, minScale: 1, dimensionsPolicy };
}

// ---------------------------------------------------------------- display

/**
 * Integer prescale for sharp-bilinear presentation: k = max(1, floor(min(W/w,
 * H/h))) in DEVICE pixels, plus the fractional remainder the compositor still
 * has to stretch. At integer factors (1080p/1440p/4K over 640x360) both
 * remainders are exactly 1.
 */
export function presentationScale(
  avsWidth: number, avsHeight: number, deviceWidth: number, deviceHeight: number,
): { scale: number; remainder: number; remainderX: number; remainderY: number } {
  const w = Math.max(1, Math.trunc(avsWidth));
  const h = Math.max(1, Math.trunc(avsHeight));
  const dw = Math.max(1, Math.trunc(deviceWidth));
  const dh = Math.max(1, Math.trunc(deviceHeight));
  const scale = Math.max(1, Math.floor(Math.min(dw / w, dh / h)));
  const remainderX = dw / (scale * w);
  const remainderY = dh / (scale * h);
  return { scale, remainder: Math.min(remainderX, remainderY), remainderX, remainderY };
}

export interface AvsPresentationLayout {
  /** Backing-store size of the visible canvas. */
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  /** Integer nearest-neighbour factor applied by drawImage (1 = draw 1:1). */
  readonly prescale: number;
  /** CSS box in DEVICE pixels, or null to fill the viewport (100vw x 100vh). */
  readonly box: { readonly left: number; readonly top: number; readonly width: number; readonly height: number } | null;
  readonly imageRendering: 'pixelated' | 'auto';
}

/**
 * Pure presentation policy for one AVS raster on one device-pixel viewport.
 * - `pixelated` (default): canvas = raster, CSS stretch with nearest. Today.
 * - `sharp-bilinear`: nearest-prescale to k*w x k*h, then the compositor does
 *   the bilinear remainder. If the remainder stretches by at most one device
 *   pixel on both axes, keep nearest: a one-row bilinear ramp across the whole
 *   image would soften every block edge for no benefit.
 * - `integer-letterbox`: exact k x k blocks centred on black; the viewport is
 *   not filled when the factor is fractional.
 * `integerCover` (crisp rasters, ceil(W/k) x ceil(H/k)) always wins: exact k x k
 * blocks, centred, overscan of at most k-1 px cropped by the viewport.
 */
export function avsPresentationLayout(
  mode: AvsUpscaleMode,
  avsWidth: number, avsHeight: number,
  deviceWidth: number, deviceHeight: number,
  integerCover = false,
): AvsPresentationLayout {
  const w = Math.max(1, Math.trunc(avsWidth));
  const h = Math.max(1, Math.trunc(avsHeight));
  const dw = Math.max(1, Math.trunc(deviceWidth));
  const dh = Math.max(1, Math.trunc(deviceHeight));
  if (integerCover) {
    const k = Math.max(1, Math.ceil(dw / w), Math.ceil(dh / h));
    return {
      canvasWidth: w, canvasHeight: h, prescale: 1, imageRendering: 'pixelated',
      box: { left: Math.floor((dw - k * w) / 2), top: Math.floor((dh - k * h) / 2), width: k * w, height: k * h },
    };
  }
  if (mode === 'pixelated') {
    return { canvasWidth: w, canvasHeight: h, prescale: 1, box: null, imageRendering: 'pixelated' };
  }
  const { scale } = presentationScale(w, h, dw, dh);
  if (mode === 'integer-letterbox') {
    return {
      canvasWidth: w, canvasHeight: h, prescale: 1, imageRendering: 'pixelated',
      box: { left: Math.floor((dw - scale * w) / 2), top: Math.floor((dh - scale * h) / 2), width: scale * w, height: scale * h },
    };
  }
  const nearEnough = Math.abs(dw - scale * w) <= 1 && Math.abs(dh - scale * h) <= 1;
  return {
    canvasWidth: scale * w, canvasHeight: scale * h, prescale: scale, box: null,
    imageRendering: nearEnough ? 'pixelated' : 'auto',
  };
}

// ---------------------------------------------------------------- pacing

/**
 * Display refresh from rAF deltas: the median of the last `window` deltas, so
 * a dropped frame or a background-tab stall cannot move it. Null until half
 * the window has been seen.
 */
export class DisplayRateEstimator {
  private readonly deltas: number[] = [];
  private lastMs: number | null = null;
  private cached: number | null = null;

  constructor(private readonly window = 61) {}

  get hz(): number | null { return this.cached; }

  /** Feed every rAF timestamp. Returns the current estimate. */
  tick(nowMs: number): number | null {
    if (this.lastMs !== null) {
      const delta = nowMs - this.lastMs;
      // Ignore stalls (hidden tab, debugger) and duplicate timestamps.
      if (delta > 2 && delta < 100) {
        this.deltas.push(delta);
        if (this.deltas.length > this.window) this.deltas.shift();
        if (this.deltas.length >= Math.ceil(this.window / 2)) {
          const sorted = [...this.deltas].sort((a, b) => a - b);
          this.cached = 1000 / sorted[sorted.length >> 1]!;
        }
      }
    }
    this.lastMs = nowMs;
    return this.cached;
  }
}

/**
 * AVS dims only change after `settleMs` of stability. Every AVS size change
 * resets executor state and rebuilds the worker's GPU surface, so a window
 * drag must cost one reset at the settled size, not one per completed frame.
 * The previous raster keeps presenting (stretched) in the meantime.
 */
export class AvsDimensionsDebouncer {
  private settled: { width: number; height: number } | null = null;
  private pending: { width: number; height: number } | null = null;
  private pendingSinceMs = 0;

  constructor(private readonly settleMs = 250) {}

  /** Adopt dims immediately, e.g. at preset load where a reset happens anyway. */
  settle(dims: { width: number; height: number }): void {
    this.settled = { width: dims.width, height: dims.height };
    this.pending = null;
  }

  current(target: { width: number; height: number }, nowMs: number): { width: number; height: number } {
    if (!this.settled) {
      this.settle(target);
      return this.settled!;
    }
    if (target.width === this.settled.width && target.height === this.settled.height) {
      this.pending = null;
      return this.settled;
    }
    if (!this.pending || this.pending.width !== target.width || this.pending.height !== target.height) {
      this.pending = { width: target.width, height: target.height };
      this.pendingSinceMs = nowMs;
    } else if (nowMs - this.pendingSinceMs >= this.settleMs) {
      this.settle(target);
    }
    return this.settled;
  }
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Convert packed 0x00RRGGBB AVS pixels into a reusable ImageData backing store. */
export function copyAvsPixelsToRgba(
  source: Uint32Array,
  rgba: Uint8ClampedArray,
  rgbaWords?: Uint32Array,
): void {
  if (rgba.length !== source.length * 4) {
    throw new RangeError(`RGBA buffer has ${rgba.length} bytes, expected ${source.length * 4}`);
  }
  if (LITTLE_ENDIAN) {
    const words = rgbaWords ?? new Uint32Array(rgba.buffer, rgba.byteOffset, source.length);
    if (words.length !== source.length) throw new RangeError('RGBA word view has the wrong length');
    for (let i = 0; i < source.length; i++) {
      const pixel = source[i]!;
      words[i] = 0xff000000 | ((pixel & 0xff) << 16) | (pixel & 0xff00) | ((pixel >>> 16) & 0xff);
    }
    return;
  }
  for (let i = 0; i < source.length; i++) {
    const pixel = source[i]!;
    const offset = i * 4;
    rgba[offset] = (pixel >>> 16) & 0xff;
    rgba[offset + 1] = (pixel >>> 8) & 0xff;
    rgba[offset + 2] = pixel & 0xff;
    rgba[offset + 3] = 0xff;
  }
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  return Math.trunc(positive(value, name));
}

function clampIndex(value: number, length: number): number {
  return Math.max(0, Math.min(length - 1, Math.trunc(value)));
}
