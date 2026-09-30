/**
 * Play statistics (docs/design/PRESET-BROWSER-V2.md 5.6, contract "SHOULD"). A heuristic for "recently played" and "most played",
 * not an audit log: a play counts when a committed preset is replaced after at least eight seconds of wall time spent playing.
 * `stats.json` is `{version: 1, plays: {<sha256>: [count, lastPlayedMs]}}`, at most 20,000 entries. Persistence failures are
 * never fatal; the counters simply stay session-only.
 */
import { StateChannel, isUnsupportedState, stateErrorFor, systemTimers, type Timers } from './mpc-folder-store.ts';
export const STATS_LIMITS = { entries: 20000, count: 65535, minPlayMs: 8000 } as const;
const HASH = /^[0-9a-f]{64}$/;

export interface PlayStats {
  readonly version: 1;
  /** sha256 to `[count, last played (epoch ms)]`. Mutated in place by `PlayTracker`. */
  readonly plays: Map<string, [number, number]>;
}
export function emptyStats(): PlayStats { return { version: 1, plays: new Map() }; }

function prune(stats: PlayStats): void {
  if (stats.plays.size <= STATS_LIMITS.entries) return;
  const oldest = [...stats.plays.entries()].sort((a, b) => a[1][1] - b[1][1] || (a[0] < b[0] ? -1 : 1));
  for (const [hash] of oldest.slice(0, stats.plays.size - STATS_LIMITS.entries)) stats.plays.delete(hash);
}

/** Tolerant of bad entries (skipped), strict about the envelope. Excess entries drop the least recently played. */
export function parseStats(value: unknown): PlayStats {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Play statistics are not an object');
  const v = value as { version?: unknown; plays?: unknown };
  if (v.version !== 1) throw new Error(typeof v.version === 'number' && v.version > 1 ? 'Play statistics come from a newer version' : 'Invalid play statistics');
  const stats = emptyStats();
  if (!v.plays || typeof v.plays !== 'object' || Array.isArray(v.plays)) throw new Error('Invalid play statistics');
  for (const [hash, entry] of Object.entries(v.plays)) {
    if (!HASH.test(hash) || !Array.isArray(entry) || entry.length !== 2) continue;
    const [count, last] = entry as [unknown, unknown];
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || typeof last !== 'number' || !Number.isFinite(last) || last < 0) continue;
    stats.plays.set(hash, [Math.min(STATS_LIMITS.count, count), last]);
  }
  prune(stats);
  return stats;
}
export function serializeStats(stats: PlayStats): { version: 1; plays: Record<string, [number, number]> } {
  const plays: Record<string, [number, number]> = {};
  for (const [hash, [count, last]] of stats.plays) plays[hash] = [count, last];
  return { version: 1, plays };
}

/**
 * Counts plays from the host's commit stream. `commit(hash, playing, now)` runs whenever a preset becomes current;
 * `setPlaying` tracks pause and resume; `flush` finalises the current preset (panel close, shutdown). Time comes from the
 * caller, so tests need no clock.
 */
export class PlayTracker {
  private hash: string | null = null;
  private accumulated = 0;
  private since: number | null = null;
  /** True once a play has been recorded since the last `takeDirty`. */
  dirty = false;
  constructor(readonly stats: PlayStats, private readonly minMs: number = STATS_LIMITS.minPlayMs) {}

  private finish(now: number): void {
    if (this.hash === null) return;
    const total = this.accumulated + (this.since === null ? 0 : Math.max(0, now - this.since));
    if (total >= this.minMs && HASH.test(this.hash)) {
      const known = this.stats.plays.get(this.hash);
      this.stats.plays.set(this.hash, [Math.min(STATS_LIMITS.count, (known?.[0] ?? 0) + 1), now]);
      prune(this.stats);
      this.dirty = true;
    }
    this.hash = null; this.accumulated = 0; this.since = null;
  }
  commit(hash: string, playing: boolean, now: number): void {
    if (hash === this.hash) { this.setPlaying(playing, now); return; }
    this.finish(now);
    this.hash = hash; this.accumulated = 0; this.since = playing ? now : null;
  }
  setPlaying(playing: boolean, now: number): void {
    if (this.hash === null) return;
    if (playing && this.since === null) this.since = now;
    else if (!playing && this.since !== null) { this.accumulated += Math.max(0, now - this.since); this.since = null; }
  }
  flush(now: number): boolean {
    this.finish(now);
    return this.dirty;
  }
  takeDirty(): boolean { const was = this.dirty; this.dirty = false; return was; }
}

// ---------------------------------------------------------------------------------------------------- persistence

export type StatsStatus = 'idle' | 'loading' | 'ready' | 'unavailable';
/** Seconds between saves while plays keep arriving: a throttle, so a long session still saves (a debounce would starve). */
export const STATS_SAVE_MS = 60000;

/**
 * `stats.json` through the generic state operations, session-only when the host cannot store it. Nothing is written before the file
 * has been read successfully (or is known to be absent), so a session's plays can never replace a file that was not merged in; an
 * unreadable or newer file keeps the counters in memory and is left untouched. Plays recorded before the file arrives are merged into it.
 */
export class StatsStore {
  status: StatsStatus = 'idle';
  notice = '';
  onChange: (() => void) | null = null;
  readonly stats: PlayStats = emptyStats();
  readonly tracker: PlayTracker;
  private readonly channel: StateChannel;
  constructor(send: (request: unknown) => void, timers: Timers = systemTimers(), saveMs: number = STATS_SAVE_MS, minPlayMs: number = STATS_LIMITS.minPlayMs) {
    this.tracker = new PlayTracker(this.stats, minPlayMs);
    this.channel = new StateChannel('stats', send, timers, () => serializeStats(this.stats), saveMs, saveMs);
    this.channel.enabled = false;
  }
  get dirty(): boolean { return this.channel.dirty; }
  get saving(): boolean { return this.channel.inFlight; }
  get saveError(): string { return this.channel.error; }
  private changed(): void { try { this.onChange?.(); } catch { /* a view error must not break persistence */ } }

  /** Ask the host for the file once per session. */
  load(): void {
    if (this.status !== 'idle') return;
    this.status = 'loading';
    this.channel.requestLoad();
    this.changed();
  }
  /** Returns true when the message was for this store (see `FolderStore.receive`). */
  receive(type: string, payload: unknown, operation?: string): boolean {
    const named = payload && typeof payload === 'object' && typeof (payload as { name?: unknown }).name === 'string' ? (payload as { name: string }).name : 'stats';
    if (type === 'state-loaded') {
      if (named !== 'stats' || this.status !== 'loading') return false;
      const data = (payload as { data?: unknown } | null)?.data;
      if (data === null || data === undefined) { this.ready(); return true; }
      try {
        const loaded = parseStats(data);
        for (const [hash, [count, last]] of loaded.plays) {
          const own = this.stats.plays.get(hash);
          this.stats.plays.set(hash, own ? [Math.min(STATS_LIMITS.count, count + own[0]), Math.max(last, own[1])] : [count, last]);
        }
        prune(this.stats);
        this.ready();
      } catch (error) {
        this.status = 'unavailable'; this.channel.enabled = false;
        this.notice = `Play history could not be read (${error instanceof Error ? error.message : 'invalid data'}); counting for this session only.`;
        this.changed();
      }
      return true;
    }
    if (type === 'state-saved') {
      if (named !== 'stats') return false;
      this.channel.saved(); this.changed(); return true;
    }
    if (type === 'library-error' && operation === 'load-state') {
      const { mine, text } = stateErrorFor('stats', payload);
      if (!mine || this.status !== 'loading') return false;
      this.status = 'unavailable'; this.channel.enabled = false;
      this.notice = isUnsupportedState(text) ? 'Play history unavailable (session only).' : `Play history could not be loaded (${text}); counting for this session only.`;
      this.changed();
      return true;
    }
    if (type === 'library-error' && operation === 'save-state') {
      const { mine, text } = stateErrorFor('stats', payload);
      if (!mine || !this.channel.inFlight) return false;
      this.channel.failed(text); this.changed();
      return true;
    }
    return false;
  }
  private ready(): void {
    this.status = 'ready'; this.notice = ''; this.channel.enabled = true;
    if (this.channel.dirty) this.channel.markDirty('edit', true);
    this.changed();
  }
  private afterTrack(): void {
    if (!this.tracker.takeDirty()) return;
    if (this.status === 'ready') this.channel.markDirty('edit', true); else this.channel.dirty = true;
    this.changed();
  }
  /** A preset became current. `now` is epoch milliseconds from the caller. */
  commit(hash: string, playing: boolean, now: number): void { this.tracker.commit(hash, playing, now); this.afterTrack(); }
  setPlaying(playing: boolean, now: number): void { this.tracker.setPlaying(playing, now); this.afterTrack(); }
  /** Finalise the current preset and save at once (panel close, shutdown). Returns whether a save was sent. */
  flush(now: number): boolean {
    this.tracker.flush(now); this.afterTrack();
    const sent = this.status === 'ready' && this.channel.flush();
    this.changed();
    return sent;
  }
  /** Saves what is recorded now without ending the current play (the Preset Manager closing): the play in progress keeps counting. Returns whether a save was sent. */
  save(): boolean {
    const sent = this.status === 'ready' && this.channel.flush();
    if (sent) this.changed();
    return sent;
  }
  retry(): void { this.channel.retry(); this.changed(); }
  dispose(): void { this.channel.dispose(); }
}
