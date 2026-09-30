// Host adapters for the song map: worker factory and library channel transports. The song map itself
// (session, scan, cache) is host-independent; a host supplies only these.
import { LibrarySongMapStore, type LibraryCall } from './cache.ts';
import type { WorkerLike } from './protocol.ts';
import { SongMapSession, type SongMapSessionOptions } from './session.ts';

export interface HostBridge {
  postMessage(message: string): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/** The scan worker, bundled next to the host script. Null where Workers do not exist. */
export function createSongMapWorker(): WorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  try { return new Worker(new URL('./song-map.worker.js', import.meta.url), { type: 'module', name: 'aaavs-song-map' }) as unknown as WorkerLike; }
  catch { return null; }
}

/** Library channel over HTTP (standalone Player): POST /api/aaavs/library. */
export function httpLibraryCall(url = '/api/aaavs/library', fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): LibraryCall {
  return async request => {
    const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(15000) });
    const result: unknown = await response.json();
    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof (result as { type?: unknown }).type !== 'string') throw new Error(`Library server returned an invalid response (${response.status}).`);
    const record = result as Record<string, unknown>;
    if (record.type === 'library-error') throw new Error(String(record.message));
    return record;
  };
}

/**
 * Library channel over the native bridge: `library:<json>` out, `song-map-loaded` / `song-map-saved` or a
 * `library-error` with the same `operation` back. An unknown op, a missing reply or an error all reject, and
 * the session then scans without a cache.
 */
export function bridgeLibraryCall(bridge: HostBridge, timeoutMs = 15000): LibraryCall {
  const pending: { op: string; key: string; resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  let listening = false;
  const settle = (index: number, run: (entry: (typeof pending)[number]) => void) => {
    if (index < 0) return;
    const [entry] = pending.splice(index, 1);
    if (entry) { clearTimeout(entry.timer); run(entry); }
  };
  const listen = () => {
    if (listening) return; listening = true;
    bridge.addEventListener('message', event => {
      const data = event.data as Record<string, unknown> | null;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'song-map-loaded' || data.type === 'song-map-saved') {
        const op = data.type === 'song-map-loaded' ? 'load-song-map' : 'save-song-map';
        settle(pending.findIndex(p => p.op === op && p.key === data.key), entry => entry.resolve(data));
      } else if (data.type === 'library-error' && (data.operation === 'load-song-map' || data.operation === 'save-song-map')) {
        settle(pending.findIndex(p => p.op === data.operation), entry => entry.reject(new Error(String(data.message))));
      }
    });
  };
  return request => new Promise((resolve, reject) => {
    listen();
    const op = String(request.op), key = String(request.key);
    const timer = setTimeout(() => settle(pending.findIndex(p => p.timer === timer), entry => entry.reject(new Error('Library did not answer'))), timeoutMs);
    pending.push({ op, key, resolve, reject, timer });
    try { bridge.postMessage(`library:${JSON.stringify(request)}`); }
    catch (error) { settle(pending.findIndex(p => p.timer === timer), entry => entry.reject(error instanceof Error ? error : new Error(String(error)))); }
  });
}

export interface HostSongMapOptions extends Omit<SongMapSessionOptions, 'createWorker' | 'store'> {
  readonly call: LibraryCall | null;
  readonly createWorker?: () => WorkerLike | null;
}

/** One session for a host page, or null when Workers are unavailable (the host then runs without a song map). */
export function createHostSongMap(options: HostSongMapOptions): SongMapSession | null {
  const { call, createWorker = createSongMapWorker, ...rest } = options;
  if (createWorker === createSongMapWorker && typeof Worker === 'undefined') return null;
  return new SongMapSession({
    ...rest, store: call ? new LibrarySongMapStore(call) : null,
    createWorker: () => { const worker = createWorker(); if (!worker) throw new Error('Song map worker unavailable'); return worker; },
  });
}
