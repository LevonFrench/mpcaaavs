/** Sliding-window event-rate meter for the timing overlay (docs/design/TIMING-SYSTEM-V2.md 3.2).
 * Injected time only (a rAF timestamp or performance.now()); no globals, no DOM, no allocation after construction.
 * A stall (hidden tab, suspended WebView, long pause), a clock that does not advance and a clock that runs backwards all reset the window,
 * so no giant average is ever produced from a gap.
 */
export interface FpsReading { readonly fps: number; readonly worstMs: number; readonly samples: number }
export interface FpsMeterOptions { windowMs?: number; gapMs?: number; staleMs?: number; capacity?: number }

const positive = (value: number | undefined, fallback: number): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

export class FpsMeter {
  private readonly windowMs: number;
  private readonly gapMs: number;
  private readonly staleMs: number;
  private readonly ring: Float64Array;
  private head = 0;
  private count = 0;
  private last = NaN;
  /** `windowMs` 1000, `gapMs` 500, `staleMs` 750, `capacity` 512 (a full second at 240 Hz with room to spare). */
  constructor(options: FpsMeterOptions = {}) {
    this.windowMs = positive(options.windowMs, 1000);
    this.gapMs = positive(options.gapMs, 500);
    this.staleMs = positive(options.staleMs, 750);
    this.ring = new Float64Array(Math.max(4, Math.floor(positive(options.capacity, 512))));
  }
  reset(): void { this.head = 0; this.count = 0; this.last = NaN; }
  /** Record one event. Non-finite input is ignored; a timestamp that does not advance, or a gap over `gapMs`, restarts the window at this event. */
  mark(now: number): void {
    if (!Number.isFinite(now)) return;
    if (this.count && (now <= this.last || now - this.last > this.gapMs)) this.reset();
    const size = this.ring.length;
    this.ring[(this.head + this.count) % size] = now;
    if (this.count < size) this.count++; else this.head = (this.head + 1) % size;
    this.last = now;
  }
  /** Events per second over the last `windowMs`; null with fewer than three samples or when the last event is older than `staleMs`. */
  read(now: number): FpsReading | null {
    if (!this.count || !Number.isFinite(now) || !(now - this.last <= this.staleMs)) return null;
    const size = this.ring.length;
    while (this.count > 2 && this.ring[this.head]! < now - this.windowMs) { this.head = (this.head + 1) % size; this.count--; }
    if (this.count < 3) return null;
    const span = this.last - this.ring[this.head]!;
    if (!(span > 0)) return null;
    let worst = 0;
    for (let i = 1; i < this.count; i++) worst = Math.max(worst, this.ring[(this.head + i) % size]! - this.ring[(this.head + i - 1) % size]!);
    return { fps: (this.count - 1) * 1000 / span, worstMs: worst, samples: this.count };
  }
}
