// Live song-map feed: builds a partial map from the PCM a host already receives during playback.
//
// Only audio that was actually played is analysed, and only once: a seek starts a new contiguous run,
// material that an earlier run already stored is skipped, and every published snapshot states its
// coverage. Nothing here can see ahead of the playhead, so a live map is a provisional, growing
// record; a full-file scan (scan.ts) or a cached map replaces it as soon as one exists.
import { REGION_CONTEXT_SECONDS } from './frames.ts';
import { SongMapClock } from './clock.ts';
import type { SongMapRequest, SongMapResponse, WorkerLike } from './protocol.ts';
import type { SongMapUpdate } from './scan.ts';
import type { SongMapBinary } from './types.ts';

export interface LiveOptions {
  readonly worker: WorkerLike;
  readonly onUpdate: (update: SongMapUpdate) => void;
  readonly job?: number;
  readonly startRevision?: number;
  /** Publish a snapshot after this many seconds of newly analysed audio. */
  readonly publishEverySeconds?: number;
  /** Samples batched into one worker message. */
  readonly batchSamples?: number;
  readonly now?: () => number;
}

const NEVER = Number.MAX_SAFE_INTEGER;

/** Sorted, merged sample intervals [start, end). */
class Covered {
  private list: [number, number][] = [];
  add(a: number, b: number): void {
    if (!(b > a)) return;
    const out: [number, number][] = [];
    let placed = false;
    for (const [x, y] of this.list) {
      if (y < a) out.push([x, y]);
      else if (x > b) { if (!placed) { out.push([a, b]); placed = true; } out.push([x, y]); }
      else { a = Math.min(a, x); b = Math.max(b, y); }
    }
    if (!placed) out.push([a, b]);
    this.list = out;
  }
  contains(t: number): boolean { return this.list.some(([x, y]) => t >= x && t < y); }
  /** Start of the first interval after t, or NEVER. */
  nextStart(t: number): number { for (const [x] of this.list) if (x > t) return x; return NEVER; }
  get spans(): readonly (readonly [number, number])[] { return this.list; }
}

export class SongMapLive {
  private readonly worker: WorkerLike;
  private readonly onUpdate: (update: SongMapUpdate) => void;
  private readonly job: number;
  private readonly every: number;
  private readonly batch: number;
  private readonly now: () => number;
  private readonly covered = new Covered();
  private rate = 0;
  private revision: number;
  private begun = false;
  private open = false;
  private runStart = 0;
  private runCoreStart = 0;
  private runCoreEnd = NEVER;
  private pos = 0;
  private sinceSnapshot = 0;
  private pending: { l: Float32Array; r: Float32Array } | null = null;
  private pendingLength = 0;
  private started = 0;
  private closed = false;
  latest: SongMapUpdate | null = null;

  constructor(options: LiveOptions) {
    this.worker = options.worker; this.onUpdate = options.onUpdate; this.job = options.job ?? 1;
    this.every = options.publishEverySeconds ?? 10; this.batch = options.batchSamples ?? 8192;
    this.now = options.now ?? (() => 0); this.revision = (options.startRevision ?? 1) - 1;
    this.worker.onmessage = this.receive;
  }

  private send(message: SongMapRequest, transfer?: Transferable[]): void { this.worker.postMessage(message, transfer); }

  private receive = (event: { data: SongMapResponse }): void => {
    const m = event.data;
    if (this.closed || !m || m.job !== this.job || m.type !== 'snapshot') return;
    this.revision++;
    const binary: SongMapBinary = { spec: m.spec, wave: m.wave };
    // A live map is never "complete": the track length is unknown.
    const update: SongMapUpdate = {
      revision: this.revision, map: m.map, binary, coverage: m.coverage, complete: false,
      clock: new SongMapClock(m.map, this.revision, m.coverage), elapsedMs: this.now() - this.started, heapBytes: m.heapBytes,
    };
    this.latest = update; this.onUpdate(update);
  };

  /** Analysed spans, in seconds, that this feed has stored so far (excluding the unflushed tail of an open run). */
  get coverageSeconds(): [number, number][] { return this.covered.spans.map(([a, b]) => [a / (this.rate || 1), b / (this.rate || 1)]); }

  /**
   * One contiguous stereo hop that starts at media time `time`. `discontinuity` (a seek, a pause gap,
   * a decoder restart) always starts a new run.
   */
  push(time: number, left: Float32Array, right: Float32Array, sampleRate: number, discontinuity = false): void {
    if (this.closed || !Number.isFinite(time) || time < 0 || left.length !== right.length || !left.length) return;
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 384000) return;
    if (!this.begun || sampleRate !== this.rate) {
      if (this.begun) this.endRun(true);
      this.rate = sampleRate; this.begun = true; this.started = this.now();
      this.send({ type: 'begin', job: this.job, sampleRate, totalSamples: null });
    }
    const index = Math.round(time * this.rate), tolerance = Math.round(.002 * this.rate);
    if (this.open && !discontinuity && Math.abs(index - this.pos) <= tolerance && index < this.runCoreEnd + this.contextSamples()) {
      this.append(left, right); return;
    }
    if (this.open) this.endRun(true);
    // Material an earlier run already stored is not analysed again: wait until the core would start beyond it.
    const coreStart = index === 0 ? 0 : index + this.contextSamples();
    if (this.covered.contains(coreStart)) return;
    this.startRun(index, coreStart);
    this.append(left, right);
  }

  private contextSamples(): number { return Math.round(REGION_CONTEXT_SECONDS * this.rate); }

  private startRun(index: number, coreStart: number): void {
    this.runStart = index; this.pos = index;
    this.runCoreStart = coreStart;
    // Never re-store a span an earlier run already covers.
    this.runCoreEnd = this.covered.nextStart(coreStart);
    this.open = true;
    this.send({ type: 'region', job: this.job, feedStart: this.runStart, coreStart: this.runCoreStart, coreEnd: this.runCoreEnd });
  }

  private append(left: Float32Array, right: Float32Array): void {
    let at = 0;
    while (at < left.length) {
      if (!this.pending) { this.pending = { l: new Float32Array(this.batch), r: new Float32Array(this.batch) }; this.pendingLength = 0; }
      const room = this.batch - this.pendingLength, take = Math.min(room, left.length - at);
      this.pending.l.set(left.subarray(at, at + take), this.pendingLength);
      this.pending.r.set(right.subarray(at, at + take), this.pendingLength);
      this.pendingLength += take; at += take; this.pos += take;
      if (this.pendingLength === this.batch) this.flush();
    }
    this.sinceSnapshot += left.length;
    if (this.sinceSnapshot >= this.every * this.rate) { this.flush(); this.send({ type: 'snapshot', job: this.job }); this.sinceSnapshot = 0; }
  }

  private flush(): void {
    if (!this.pending || !this.pendingLength) return;
    const l = this.pending.l.slice(0, this.pendingLength), r = this.pending.r.slice(0, this.pendingLength);
    this.pending = null; this.pendingLength = 0;
    this.send({ type: 'pcm', job: this.job, left: l, right: r }, [l.buffer, r.buffer]);
  }

  private endRun(publish: boolean): void {
    if (!this.open) return;
    this.flush();
    this.open = false;
    // The last ~1 s of a run that stops early is still waiting for its look-ahead; claim only what was stored.
    const settled = Math.min(this.runCoreEnd, this.pos - this.rate);
    this.covered.add(this.runCoreStart, settled);
    this.send({ type: 'end-region', job: this.job, atTrackEnd: false, publish });
    this.sinceSnapshot = 0;
  }

  /** Playback paused/stopped: finish the run and publish. */
  pause(): void { this.endRun(true); }

  close(): void {
    if (this.closed) return;
    this.endRun(false);
    this.closed = true;
    this.send({ type: 'cancel', job: this.job });
  }
}
