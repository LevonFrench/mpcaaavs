// Per-pass GPU timing via WebGPU `timestamp-query` (plan §4.11).
//
// The target is 2560x1440 at 120 fps — an 8.33 ms frame — and a budget nobody
// measures is a budget nobody keeps. Per PASS, not per frame: a single number
// tells you the frame was blown but not by what, and the whole point of §4.11's
// per-layer resolution scaling is knowing which layer to scale.
//
// The one rule this file exists to obey: NEVER STALL THE FRAME. Timestamps are
// resolved into a buffer on the GPU, copied into a staging buffer, and mapped
// asynchronously. The result arrives a frame or two late and that is correct —
// waiting for it would cost more than the passes being measured.
//
// What it deliberately does NOT do: it does not own passes, pipelines or bind
// groups, it does not decide what to measure, and it does not fall back to CPU
// timing when the feature is missing. `performance.now()` around a submit
// measures the encoder, not the GPU, and a plausible wrong number is worse than
// no number.

import type { GpuTiming } from './contracts.ts';

/**
 * Timestamps are written in pairs (begin, end), so this is the pass budget.
 * Query sets are cheap; the resolve buffer is 8 bytes per query. Overrunning it
 * is not an error — the extra passes are simply untimed, because dropping a
 * measurement is always preferable to dropping a frame.
 */
const MAX_PASSES = 48;

/**
 * How many staging buffers rotate. Two is enough in principle (the GPU is at
 * most a frame or so behind), but three means a hitch never costs a sample and
 * the pool never has to grow.
 */
const STAGING_SLOTS = 3;

/** Samples in the rolling average. ~0.3 s at 120 fps — long enough to be stable, short enough to react. */
const WINDOW = 32;

/**
 * Buffer sizes are rounded up to this. Nothing in the spec demands it for a
 * resolve at offset 0 — it is here so that a future partial resolve (per-layer
 * scaling wants to time a subset) can pick any 256-aligned destination offset
 * without the buffer having to be resized first.
 */
const ALIGN = 256;

/** Fixed-size rolling mean. A single spiky frame is not a signal; a moving average is. */
class Rolling {
  private readonly buf = new Float64Array(WINDOW);
  private i = 0;
  private n = 0;
  private sum = 0;

  push(v: number): void {
    this.sum += v - (this.buf[this.i] ?? 0);
    this.buf[this.i] = v;
    this.i = (this.i + 1) % WINDOW;
    if (this.n < WINDOW) this.n++;
  }

  get avg(): number { return this.n ? this.sum / this.n : 0; }
}

/**
 * A staging buffer plus the state machine that keeps it from being mapped
 * twice.
 *
 * This is the classic bug in this file. `mapAsync` on a buffer that is already
 * mapped, or already has a map pending, is a validation error; so is submitting
 * work that touches a mapped buffer. Both are easy to hit because the copy
 * (frame N) and the map resolution (frame N+2) are separated by an await, and
 * the frame loop keeps running in between. A boolean per buffer is all it
 * takes, but it has to actually be checked on both sides.
 */
type SlotState = 'free' | 'busy' | 'dead';

interface Slot {
  buffer: GPUBuffer;
  state: SlotState;
  /** Labels captured at copy time, in query-pair order. The label list changes when the layer stack does. */
  labels: string[];
  /** Number of timestamps (not pairs) copied. */
  count: number;
  /** True between `endFrame` and the `poll` that starts the map. */
  awaitingMap: boolean;
}

export class GpuTimer {
  /** False when the adapter lacks `timestamp-query`. Every method is then a no-op. */
  readonly enabled: boolean;

  private readonly device: GPUDevice;
  private querySet: GPUQuerySet | null = null;
  private resolveBuf: GPUBuffer | null = null;
  private readonly slots: Slot[] = [];

  /**
   * Insertion-ordered so the overlay lists passes in the order they run.
   * Rebuilt (not merely appended to) whenever the pass list changes, because a
   * Map that only ever grows keeps reporting a layer that was deleted three
   * presets ago, and it reports it in the order it was FIRST seen rather than
   * the order the passes now run in.
   */
  private averages = new Map<string, Rolling>();
  /** Rebuilt only when a readback lands, so the per-frame read allocates nothing. */
  private cached: GpuTiming[] = [];
  /** Label list `averages` was last built from, for the change check above. */
  private averagesFor: readonly string[] = [];
  /** Set by `destroy`. A map in flight resolves against a buffer that is gone. */
  private disposed = false;

  /** Pairs claimed this frame. Reset by `beginFrame`. */
  private used = 0;
  private frameLabels: string[] = [];

  constructor(device: GPUDevice, hasTimestamp: boolean) {
    this.device = device;
    this.enabled = hasTimestamp;
    if (!hasTimestamp) return;

    this.querySet = device.createQuerySet({
      label: 'gputimer-queries',
      type: 'timestamp',
      count: MAX_PASSES * 2,
    });

    const bytes = align(MAX_PASSES * 2 * 8);
    this.resolveBuf = device.createBuffer({
      label: 'gputimer-resolve',
      size: bytes,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });

    for (let i = 0; i < STAGING_SLOTS; i++) {
      this.slots.push({
        buffer: device.createBuffer({
          label: `gputimer-staging-${i}`,
          size: bytes,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
        state: 'free',
        labels: [],
        count: 0,
        awaitingMap: false,
      });
    }
  }

  /** Call once per frame before encoding anything. Cheap; safe when disabled. */
  beginFrame(): void {
    this.used = 0;
    if (this.frameLabels.length) this.frameLabels = [];
  }

  /**
   * Timed replacement for `beginPass` in `gpu.ts` — same signature deliberately,
   * so instrumenting a pass is a one-word edit and un-instrumenting it is too.
   */
  beginPass(
    encoder: GPUCommandEncoder,
    view: GPUTextureView,
    label: string,
    load: GPULoadOp = 'clear',
  ): GPURenderPassEncoder {
    const pair = this.claim(label);
    return encoder.beginRenderPass({
      label,
      colorAttachments: [{
        view,
        loadOp: load,
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
      ...(pair === null || this.querySet === null ? {} : {
        timestampWrites: {
          querySet: this.querySet,
          beginningOfPassWriteIndex: pair * 2,
          endOfPassWriteIndex: pair * 2 + 1,
        },
      }),
    });
  }

  beginComputePass(encoder: GPUCommandEncoder, label: string): GPUComputePassEncoder {
    const pair = this.claim(label);
    return encoder.beginComputePass({
      label,
      ...(pair === null || this.querySet === null ? {} : {
        timestampWrites: {
          querySet: this.querySet,
          beginningOfPassWriteIndex: pair * 2,
          endOfPassWriteIndex: pair * 2 + 1,
        },
      }),
    });
  }

  /**
   * Opens a span that brackets work this timer does not own — a pass that
   * records its own compute passes and cannot take `timestampWrites`. The begin
   * timestamp is written by an empty compute pass; `closeSpan` writes the end the
   * same way. The span measures the GPU time between the two markers, so it
   * includes any inter-pass barrier the driver inserts. Returns null (and encodes
   * nothing) when disabled or out of query pairs.
   */
  openSpan(encoder: GPUCommandEncoder, label: string): number | null {
    const pair = this.claim(label);
    if (pair === null || this.querySet === null) return null;
    encoder.beginComputePass({
      label: `${label} (timer begin)`,
      timestampWrites: { querySet: this.querySet, beginningOfPassWriteIndex: pair * 2 },
    }).end();
    return pair;
  }

  /** Closes a span from `openSpan`. A null pair is a no-op, so call sites need no branch. */
  closeSpan(encoder: GPUCommandEncoder, pair: number | null): void {
    if (pair === null || this.querySet === null) return;
    encoder.beginComputePass({
      label: 'gputimer span end',
      timestampWrites: { querySet: this.querySet, endOfPassWriteIndex: pair * 2 + 1 },
    }).end();
  }

  /**
   * Symmetry with `beginPass`. It only calls `end()` today, but every call site
   * going through here means a future change (nested timers, pass merging per
   * §4.11) needs no edits at the call sites.
   */
  endPass(pass: GPURenderPassEncoder | GPUComputePassEncoder): void {
    pass.end();
  }

  /**
   * Encode the resolve and the copy. Must be the last thing on the encoder,
   * before `finish()`.
   */
  endFrame(encoder: GPUCommandEncoder): void {
    if (!this.enabled || this.used === 0) return;
    const querySet = this.querySet;
    const resolve = this.resolveBuf;
    if (!querySet || !resolve) return;

    const count = this.used * 2;
    encoder.resolveQuerySet(querySet, 0, count, resolve, 0);

    // No free slot means the readbacks are behind — the GPU is more than
    // STAGING_SLOTS frames back, or a map is taking its time. Skip the copy.
    // Losing a sample is invisible; blocking to wait for one is not.
    const slot = this.slots.find((s) => s.state === 'free');
    if (!slot) return;

    encoder.copyBufferToBuffer(resolve, 0, slot.buffer, 0, count * 8);
    slot.state = 'busy';
    slot.count = count;
    // Hand the array over rather than copying it. The readback lands a frame or
    // two from now and must see the labels as they were at copy time; sharing
    // the live array would let the next frame's `claim` calls rewrite them.
    slot.labels = this.frameLabels;
    this.frameLabels = [];
    slot.awaitingMap = true;
  }

  /**
   * Call AFTER `queue.submit()`. This is not stylistic: `mapAsync` marks the
   * buffer pending immediately, and submitting a command buffer that writes to
   * a pending-map buffer is a validation error. Mapping before the submit
   * therefore breaks the very copy it is trying to read.
   */
  poll(): void {
    if (!this.enabled) return;
    for (const slot of this.slots) {
      if (!slot.awaitingMap || slot.state !== 'busy') continue;
      slot.awaitingMap = false;
      const bytes = slot.count * 8;
      slot.buffer.mapAsync(GPUMapMode.READ, 0, bytes).then(
        () => {
          // `destroy()` can land while the map is in flight. `getMappedRange`
          // on a destroyed buffer throws, and a throw in here becomes an
          // unhandled rejection during teardown rather than an error anyone
          // sees. Check rather than catch, so a real bug still throws.
          if (this.disposed || slot.state !== 'busy') return;
          try {
            this.consume(slot, bytes);
          } finally {
            slot.buffer.unmap();
            slot.state = 'free';
          }
        },
        () => {
          // Rejects on device loss or destroy. The buffer is gone; do not try
          // to unmap it and do not put it back in rotation.
          slot.state = 'dead';
        },
      );
    }
  }

  /** Rolling averages, one per pass label, in the order the passes were encoded. */
  get timings(): readonly GpuTiming[] {
    return this.cached;
  }

  /** Sum of the averages. What to compare against the 8.33 ms budget. */
  get totalMs(): number {
    let ms = 0;
    for (const t of this.cached) ms += t.ms;
    return ms;
  }

  destroy(): void {
    // `destroy()` on a mapped or map-pending buffer is legal — it unmaps and
    // rejects the pending promise for us. The flag is what matters: a map that
    // has ALREADY resolved has its callback sitting in the microtask queue, and
    // that callback must not touch the range once we get here.
    this.disposed = true;
    for (const slot of this.slots) {
      if (slot.state !== 'dead') slot.buffer.destroy();
      slot.state = 'dead';
    }
    this.slots.length = 0;
    this.resolveBuf?.destroy();
    this.querySet?.destroy();
    this.resolveBuf = null;
    this.querySet = null;
    this.averages.clear();
    this.averagesFor = [];
    this.cached = [];
  }

  // -- internals ----------------------------------------------------------

  /** Returns the query-pair index for a pass, or null when untimed. */
  private claim(label: string): number | null {
    if (!this.enabled || this.used >= MAX_PASSES) return null;
    const pair = this.used++;
    // Two passes in one frame can legitimately share a label — two instances of
    // the same layer type is the normal case, not the exotic one. Left alone
    // they collapse into a single averages entry that is fed twice per frame,
    // and the overlay then shows one row for two passes: a wrong number that
    // looks entirely plausible. Suffix the repeats instead. Only the TIMING
    // label is disambiguated; the pass keeps the label the caller asked for.
    let key = label;
    for (let n = 2; this.frameLabels.includes(key); n++) key = `${label}#${n}`;
    this.frameLabels.push(key);
    return pair;
  }

  private consume(slot: Slot, bytes: number): void {
    const raw = new BigUint64Array(slot.buffer.getMappedRange(0, bytes));
    if (!sameLabels(this.averagesFor, slot.labels)) {
      // The pass list changed. Carry over the rolling means for labels that
      // survived, drop the ones that did not, and adopt the new order — a
      // deleted layer whose row lingers for ever is worse than no row at all.
      const next = new Map<string, Rolling>();
      for (const label of slot.labels) next.set(label, this.averages.get(label) ?? new Rolling());
      this.averages = next;
      this.averagesFor = slot.labels;
    }
    for (let i = 0; i < slot.labels.length; i++) {
      const a = raw[i * 2];
      const b = raw[i * 2 + 1];
      const label = slot.labels[i];
      if (a === undefined || b === undefined || label === undefined) continue;
      // Timestamps are nanoseconds. Browsers quantise them (Chrome to ~100 us
      // unless the precise-timing flag is set), so a short pass legitimately
      // reads 0.000 — that is coarse resolution, not a broken timer. A
      // backwards delta means the query never got written; drop it rather than
      // poisoning the average with a huge unsigned wraparound.
      if (b < a) continue;
      const ms = Number(b - a) / 1e6;
      if (!Number.isFinite(ms) || ms > 1000) continue;
      this.averages.get(label)?.push(ms);
    }

    // Rebuilt on the readback, not in the getter: readbacks happen at most once
    // a frame and often less, whereas the getter is read by the overlay and by
    // anything checking the budget, and neither should allocate to do it.
    this.cached = [];
    for (const [label, roll] of this.averages) this.cached.push({ label, ms: roll.avg });
  }
}

function align(bytes: number): number {
  return Math.ceil(bytes / ALIGN) * ALIGN;
}

/** Element-wise, because the comparison runs per readback and joining allocates. */
function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
