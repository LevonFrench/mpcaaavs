// Scan client: drives a song-map worker over a random-access PCM source with bounded memory and queues.
//
// - Regions are scheduled playhead-first (then forward, then earlier material); `seek()` reprioritises.
// - At most `maxInFlight` PCM blocks are outstanding, so memory is bounded by a handful of blocks however long the track is.
// - Every published snapshot carries a strictly increasing revision and a ready-made SongMapClock.
// - `cancel()` ends the job; messages that arrive afterwards (or belong to another job) are ignored.
import { orderRegions, planRegions, REGION_CORE_SECONDS, type RegionPlan } from './analyzer.ts';
import { SongMapClock } from './clock.ts';
import type { SongMapRequest, SongMapResponse, SongMapSnapshotMessage, WorkerLike } from './protocol.ts';
import type { SongMapBinary, SongMapJSON } from './types.ts';

export interface PcmSource {
  readonly sampleRate: number;
  readonly totalSamples: number;
  /** Random access. May return views of shared storage: the scan copies what it sends. */
  read(start: number, length: number): { left: Float32Array; right: Float32Array } | Promise<{ left: Float32Array; right: Float32Array }>;
}

export interface SongMapUpdate {
  readonly revision: number;
  readonly map: SongMapJSON;
  readonly binary: SongMapBinary;
  readonly coverage: [number, number][];
  readonly complete: boolean;
  readonly clock: SongMapClock;
  /** Milliseconds from start() to this snapshot, from `now()`. Informational only; never part of a map. */
  readonly elapsedMs: number;
  readonly heapBytes: number;
}

export interface ScanOptions {
  readonly worker: WorkerLike;
  readonly source: PcmSource;
  readonly onUpdate: (update: SongMapUpdate) => void;
  /** Playhead in seconds; regions near it are analysed first. */
  readonly playhead?: () => number;
  readonly job?: number;
  readonly now?: () => number;
  readonly blockSeconds?: number;
  readonly maxInFlight?: number;
  readonly coreSeconds?: number;
  /** Length of the first region; a short one delivers the first useful map early. */
  readonly firstCoreSeconds?: number;
  readonly maxWaveSeconds?: number;
  /** Publish a snapshot every N regions (the last region always publishes). */
  readonly publishEvery?: number;
  /** First revision number; lets a resumed session continue a sequence. */
  readonly startRevision?: number;
}

export type ScanResult = 'complete' | 'cancelled';

export class SongMapScan {
  private readonly o: Required<Omit<ScanOptions, 'playhead' | 'maxWaveSeconds' | 'worker' | 'source' | 'onUpdate'>>
    & Pick<ScanOptions, 'playhead' | 'maxWaveSeconds'>;
  private readonly worker: WorkerLike;
  private readonly source: PcmSource;
  private readonly onUpdate: (update: SongMapUpdate) => void;
  private cancelled = false;
  private started = 0;
  private revision: number;
  private inFlight = 0;
  private waiter: (() => void) | null = null;
  private pendingSnapshots = 0;
  private snapshotWaiter: (() => void) | null = null;
  private failure: Error | null = null;
  /** Latest snapshot, for consumers that poll. */
  latest: SongMapUpdate | null = null;
  seekSeconds = 0;

  constructor(options: ScanOptions) {
    this.worker = options.worker; this.source = options.source; this.onUpdate = options.onUpdate;
    this.o = {
      job: options.job ?? 1, now: options.now ?? (() => 0), blockSeconds: options.blockSeconds ?? 2, maxInFlight: options.maxInFlight ?? 4,
      coreSeconds: options.coreSeconds ?? REGION_CORE_SECONDS, firstCoreSeconds: options.firstCoreSeconds ?? 30,
      publishEvery: Math.max(1, options.publishEvery ?? 1), startRevision: options.startRevision ?? 1,
      ...(options.playhead ? { playhead: options.playhead } : {}), ...(options.maxWaveSeconds !== undefined ? { maxWaveSeconds: options.maxWaveSeconds } : {}),
    };
    this.revision = this.o.startRevision - 1;
  }

  get job(): number { return this.o.job; }
  get isCancelled(): boolean { return this.cancelled; }

  /** Move the playhead: the next region chosen is the one under it. */
  seek(seconds: number): void { this.seekSeconds = seconds; }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.send({ type: 'cancel', job: this.o.job });
    this.wake();
  }

  private send(message: SongMapRequest, transfer?: Transferable[]): void { this.worker.postMessage(message, transfer); }
  private wake(): void { const w = this.waiter; this.waiter = null; w?.(); const s = this.snapshotWaiter; this.snapshotWaiter = null; s?.(); }

  private receive = (event: { data: SongMapResponse }): void => {
    const m = event.data;
    if (this.cancelled || !m || m.job !== this.o.job) return; // late message from a cancelled or previous job
    switch (m.type) {
      case 'ack': this.inFlight = Math.max(0, this.inFlight - 1); this.wake(); return;
      case 'region-done': return;
      case 'error': this.failure = new Error(m.message); this.wake(); return;
      case 'snapshot': this.publish(m); return;
    }
  };

  private publish(m: SongMapSnapshotMessage): void {
    this.pendingSnapshots = Math.max(0, this.pendingSnapshots - 1);
    this.revision++;
    const binary: SongMapBinary = { spec: m.spec, wave: m.wave };
    const update: SongMapUpdate = {
      revision: this.revision, map: m.map, binary, coverage: m.coverage, complete: m.complete,
      clock: new SongMapClock(m.map, this.revision, m.complete ? undefined : m.coverage),
      elapsedMs: this.o.now() - this.started, heapBytes: m.heapBytes,
    };
    this.latest = update;
    this.onUpdate(update);
    this.wake();
  }

  private async backpressure(): Promise<void> {
    while (this.inFlight >= this.o.maxInFlight && !this.cancelled && !this.failure) await new Promise<void>(resolve => { this.waiter = resolve; });
  }

  async start(): Promise<ScanResult> {
    const { sampleRate, totalSamples } = this.source;
    this.started = this.o.now();
    this.worker.onmessage = this.receive;
    this.send({ type: 'begin', job: this.o.job, sampleRate, totalSamples, ...(this.o.maxWaveSeconds !== undefined ? { maxWaveSeconds: this.o.maxWaveSeconds } : {}) });
    const plans = planRegions(totalSamples, sampleRate, this.o.coreSeconds, this.o.firstCoreSeconds);
    const done = new Set<number>();
    const block = Math.max(1024, Math.round(this.o.blockSeconds * sampleRate));
    let sincePublish = 0;
    while (done.size < plans.length) {
      if (this.cancelled) return 'cancelled';
      const playhead = Math.round(((this.o.playhead?.() ?? this.seekSeconds)) * sampleRate);
      const plan: RegionPlan = orderRegions(plans, playhead, done)[0]!;
      await this.runRegion(plan, block, totalSamples);
      done.add(plan.index);
      if (this.failure) throw this.failure;
      if (this.cancelled) return 'cancelled';
      sincePublish++;
      const last = done.size === plans.length;
      if (last || sincePublish >= this.o.publishEvery) {
        sincePublish = 0;
        this.pendingSnapshots++;
        this.send({ type: 'snapshot', job: this.o.job });
      }
    }
    // Wait for the final snapshot so the caller observes a complete map before `start()` resolves.
    while (this.pendingSnapshots > 0 && !this.cancelled && !this.failure) await new Promise<void>(resolve => { this.snapshotWaiter = resolve; });
    if (this.failure) throw this.failure;
    return this.cancelled ? 'cancelled' : 'complete';
  }

  private async runRegion(plan: RegionPlan, block: number, totalSamples: number): Promise<void> {
    this.send({ type: 'region', job: this.o.job, feedStart: plan.feedStart, coreStart: plan.coreStart, coreEnd: plan.coreEnd });
    for (let at = plan.feedStart; at < plan.feedEnd; at += block) {
      if (this.cancelled || this.failure) return;
      await this.backpressure();
      if (this.cancelled || this.failure) return;
      const length = Math.min(block, plan.feedEnd - at);
      const { left, right } = await this.source.read(at, length);
      if (this.cancelled) return;
      const l = left.slice(0, length), r = right.slice(0, length);
      this.inFlight++;
      this.send({ type: 'pcm', job: this.o.job, left: l, right: r }, [l.buffer, r.buffer]);
    }
    this.send({ type: 'end-region', job: this.o.job, atTrackEnd: plan.feedEnd >= totalSamples, publish: false });
  }
}

/** A PcmSource over decoded channel arrays (mono sources pass the same array twice). */
export function arraySource(sampleRate: number, left: Float32Array, right: Float32Array = left): PcmSource {
  return { sampleRate, totalSamples: left.length, read: (start, length) => ({ left: left.subarray(start, start + length), right: right.subarray(start, start + length) }) };
}
