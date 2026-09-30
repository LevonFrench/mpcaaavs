// One song-map session per host page: the single owner of the current track's map.
//
// - `openTrack` starts a full-file scan (or serves a cached map) for a track whose PCM a host can read.
// - `feedLive` accepts the PCM a host already receives during playback and builds a provisional map when
//   no full scan exists (the MPC host until its native bridge can supply the whole file).
// - Every published state carries a strictly increasing revision and an immutable SongMapClock.
//
// Hosts differ only through the adapters passed in: how to make a worker, where records persist and where
// PCM comes from. Nothing here knows about a host.
import { SongMapClock } from './clock.ts';
import { decodeRecord, encodeRecord, isTrackId, type SongMapStore } from './cache.ts';
import { SongMapLive } from './live.ts';
import type { WorkerLike } from './protocol.ts';
import { SongMapScan, type PcmSource, type SongMapUpdate } from './scan.ts';

export type SongMapStatus = 'idle' | 'cache-lookup' | 'scanning' | 'live' | 'complete' | 'error';
export type SongMapOrigin = 'cache' | 'scan' | 'live';
export type CacheOutcome = 'none' | 'hit' | 'miss' | 'saved' | 'too-large' | 'error';

export interface SongMapState {
  /** Increases on every track change; a consumer holding an older generation must discard its data. */
  readonly generation: number;
  readonly trackId: string | null;
  readonly status: SongMapStatus;
  readonly origin: SongMapOrigin | null;
  readonly revision: number;
  readonly update: SongMapUpdate | null;
  readonly clock: SongMapClock | null;
  readonly cache: CacheOutcome;
  readonly message: string;
}

export interface SongMapSessionOptions {
  readonly createWorker: () => WorkerLike;
  readonly store?: SongMapStore | null;
  readonly onChange?: (state: SongMapState) => void;
  readonly now?: () => number;
  readonly firstCoreSeconds?: number;
  readonly coreSeconds?: number;
  readonly blockSeconds?: number;
  readonly maxInFlight?: number;
  readonly liveEverySeconds?: number;
  readonly maxWaveSeconds?: number;
}

export interface OpenTrack {
  /** 64-hex content identity, or null when the host cannot name the track (no caching then). */
  readonly id: string | null;
  /** Readable PCM, a loader that decodes it (called only on a cache miss), or null when only live PCM will be available. */
  readonly source: PcmSource | (() => Promise<PcmSource>) | null;
  readonly playhead?: () => number;
}

/** Contiguous played audio required before a live map starts. */
export const LIVE_WARMUP_SECONDS = 1;
const IDLE: SongMapState = { generation: 0, trackId: null, status: 'idle', origin: null, revision: 0, update: null, clock: null, cache: 'none', message: '' };

export class SongMapSession {
  private worker: WorkerLike | null = null;
  private scan: SongMapScan | null = null;
  private live: SongMapLive | null = null;
  private job = 0;
  private current: SongMapState = IDLE;
  private closed = false;
  private scanning = false;
  private holding = false;
  private warmup: { time: number; left: Float32Array; right: Float32Array; rate: number; discontinuity: boolean }[] = [];
  private warmSamples = 0;

  constructor(private readonly o: SongMapSessionOptions) {}

  get state(): SongMapState { return this.current; }
  get clock(): SongMapClock | null { return this.current.clock; }
  /** True while a full-file scan is running or a complete map (cache or scan) is held: live PCM is then ignored. */
  get authoritative(): boolean { return this.holding || this.scanning || this.current.status === 'complete'; }

  private set(patch: Partial<SongMapState>): void {
    this.current = { ...this.current, ...patch };
    try { this.o.onChange?.(this.current); } catch { /* a listener error must not stop the scan */ }
  }

  private ensureWorker(): WorkerLike { return this.worker ??= this.o.createWorker(); }

  private stop(): void {
    this.warmup.length = 0; this.warmSamples = 0;
    this.scan?.cancel(); this.scan = null;
    this.live?.close(); this.live = null;
    this.scanning = false;
  }

  /**
   * A host that is about to decode a file calls this first: live PCM is ignored until `openTrack` or `release`,
   * so a slow decode cannot start a competing live map for the same track.
   */
  hold(): number { const generation = this.reset(null); this.holding = true; return generation; }

  /** The awaited full scan cannot happen (decode failed, file too long): fall back to live PCM. */
  release(generation: number, message: string): void {
    if (generation !== this.current.generation) return;
    this.holding = false;
    this.set({ status: 'live', message });
  }

  /** Track change or unload. Cancels running work; late messages of the old track are rejected by job id. */
  reset(trackId: string | null = null): number {
    this.stop(); this.holding = false;
    this.current = { ...IDLE, generation: this.current.generation + 1, trackId };
    this.o.onChange?.(this.current);
    return this.current.generation;
  }

  /** Open a track. Cache first (when the id is known), then a full scan when PCM is readable, else wait for live PCM. */
  async openTrack(track: OpenTrack): Promise<void> {
    if (this.closed) return;
    const id = track.id !== null && isTrackId(track.id) ? track.id : null;
    const generation = this.reset(id);
    this.holding = false;
    if (id && this.o.store) {
      this.set({ status: 'cache-lookup', message: 'Looking for a saved song map' });
      try {
        const record = await this.o.store.load(id);
        const cached = record ? await decodeRecord(record) : null;
        if (generation !== this.current.generation) return;
        if (cached) {
          const revision = 1;
          const clock = new SongMapClock(cached.map, revision);
          const update: SongMapUpdate = { revision, map: cached.map, binary: cached.binary, coverage: [[0, cached.map.duration]], complete: true, clock, elapsedMs: 0, heapBytes: 0 };
          this.set({ status: 'complete', origin: 'cache', revision, update, clock, cache: 'hit', message: 'Song map loaded from cache' });
          return;
        }
        this.set({ cache: 'miss' });
      } catch (error) {
        if (generation !== this.current.generation) return;
        this.set({ cache: 'error', message: `Song map cache unavailable: ${describe(error)}` });
      }
    }
    if (!track.source) { this.set({ status: 'live', message: 'Waiting for live audio' }); return; }
    let source: PcmSource;
    if (typeof track.source === 'function') {
      this.holding = true; // decoding: live PCM must not start a competing map
      this.set({ status: 'scanning', origin: 'scan', message: 'Decoding audio' });
      try { source = await track.source(); }
      catch (error) { this.release(generation, `Song map needs decoded audio: ${describe(error)}`); return; }
      if (generation !== this.current.generation) return;
      this.holding = false;
    } else source = track.source;
    await this.runScan(generation, id, source, track.playhead);
  }

  private async runScan(generation: number, id: string | null, source: PcmSource, playhead?: () => number): Promise<void> {
    const job = ++this.job;
    const scan = new SongMapScan({
      worker: this.ensureWorker(), source, job, startRevision: this.current.revision + 1,
      ...(playhead ? { playhead } : {}), ...(this.o.now ? { now: this.o.now } : {}),
      ...(this.o.firstCoreSeconds !== undefined ? { firstCoreSeconds: this.o.firstCoreSeconds } : {}),
      ...(this.o.coreSeconds !== undefined ? { coreSeconds: this.o.coreSeconds } : {}),
      ...(this.o.blockSeconds !== undefined ? { blockSeconds: this.o.blockSeconds } : {}),
      ...(this.o.maxInFlight !== undefined ? { maxInFlight: this.o.maxInFlight } : {}),
      ...(this.o.maxWaveSeconds !== undefined ? { maxWaveSeconds: this.o.maxWaveSeconds } : {}),
      onUpdate: update => {
        if (generation !== this.current.generation) return;
        this.set({ status: update.complete ? 'complete' : 'scanning', origin: 'scan', revision: update.revision, update, clock: update.clock,
          message: update.complete ? 'Song map complete' : 'Scanning' });
      },
    });
    this.scan = scan; this.scanning = true;
    this.set({ status: 'scanning', origin: 'scan', message: 'Scanning' });
    try {
      const result = await scan.start();
      if (generation !== this.current.generation || result === 'cancelled') return;
      this.scanning = false;
      const latest = scan.latest;
      if (id && this.o.store && latest?.complete) await this.save(generation, id, latest);
    } catch (error) {
      if (generation !== this.current.generation) return;
      this.scanning = false;
      this.set({ status: 'error', message: `Song map scan failed: ${describe(error)}` });
    }
  }

  private async save(generation: number, id: string, update: SongMapUpdate): Promise<void> {
    try {
      const record = await encodeRecord(id, update.map, update.binary);
      if (generation !== this.current.generation) return;
      if (!record) { this.set({ cache: 'too-large' }); return; }
      await this.o.store!.save(id, record);
      if (generation === this.current.generation) this.set({ cache: 'saved' });
    } catch (error) {
      if (generation === this.current.generation) this.set({ cache: 'error', message: `Song map could not be saved: ${describe(error)}` });
    }
  }

  /** Seek: regions near the new playhead are analysed next. */
  seek(seconds: number): void { this.scan?.seek(seconds); }

  /**
   * One contiguous stereo hop of the PCM the host already receives. Ignored while a full scan runs or a
   * complete map is held. `time` is media time in seconds.
   */
  feedLive(time: number, left: Float32Array, right: Float32Array, sampleRate: number, discontinuity = false): void {
    if (this.closed || this.authoritative || this.current.status === 'error') return;
    if (this.live) { this.live.push(time, left, right, sampleRate, discontinuity); return; }
    if (!this.warm(time, left, right, sampleRate, discontinuity)) return;
    {
      const job = ++this.job;
      this.live = new SongMapLive({
        worker: this.ensureWorker(), job, startRevision: this.current.revision + 1,
        ...(this.o.now ? { now: this.o.now } : {}), ...(this.o.liveEverySeconds !== undefined ? { publishEverySeconds: this.o.liveEverySeconds } : {}),
        onUpdate: update => {
          if (this.closed || this.authoritative) return;
          this.set({ status: 'live', origin: 'live', revision: update.revision, update, clock: update.clock, message: 'Live map from played audio' });
        },
      });
      this.set({ status: 'live', origin: 'live', message: 'Live map from played audio' });
    }
    // The warm-up buffer already holds this hop, in order.
    for (const hop of this.warmup.splice(0)) this.live!.push(hop.time, hop.left, hop.right, hop.rate, hop.discontinuity);
    this.warmSamples = 0;
  }

  /**
   * A live map (and its worker) starts only after one second of contiguous playback: skimming and seeking
   * never cost a worker. The buffered second is analysed once the map starts, so nothing is lost.
   */
  private warm(time: number, left: Float32Array, right: Float32Array, rate: number, discontinuity: boolean): boolean {
    const last = this.warmup[this.warmup.length - 1];
    if (discontinuity || (last && Math.abs(time - (last.time + last.left.length / last.rate)) > .002)) { this.warmup.length = 0; this.warmSamples = 0; }
    this.warmup.push({ time, left: left.slice(), right: right.slice(), rate, discontinuity: this.warmup.length === 0 && discontinuity });
    this.warmSamples += left.length;
    return this.warmSamples >= rate * LIVE_WARMUP_SECONDS;
  }

  /** Playback paused or stopped: publish what the live feed has so far. */
  pauseLive(): void { this.live?.pause(); }

  close(): void {
    this.closed = true; this.stop();
    this.worker?.terminate(); this.worker = null;
  }
}

function describe(error: unknown): string { return error instanceof Error ? error.message : String(error); }
