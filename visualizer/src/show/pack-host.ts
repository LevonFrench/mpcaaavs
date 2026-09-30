/** Host side of the private show asset packs (docs/design/ASSET-PACK-MANIFEST.md, "Host wiring").
 *
 * Both hosts (the MPC-HC WebView2 host and the standalone Player) run src/mpc-host.ts and differ only in the `AssetPackSource` they
 * hand to `createHostShowPacks`: the MPC host reads `show-assets-private/<id>/` beside the page (`fetchPackSource`), the Player asks its
 * loopback library server (`httpPackSource`, which reads the directory the server was started with). The provider resolves the device-local
 * setting (pack-setting.ts), loads the pack once with `loadAssetPack`, keeps the exact bytes it validated, and posts them to every show
 * worker it is attached to as a `show-pack` message (protocol.ts). A pack that is off, absent or invalid posts nothing: the worker's
 * registry stays empty and plates draw procedural stand-ins. Nothing here touches the network or any path but the pack's own files. */
import { ASSET_PACK_LIMITS, ASSET_PACK_MANIFEST_FILE, AssetPackMissingError, isPackId, loadAssetPack, packPathProblem, type AssetPackSource, type AtlasDecoder, type ManifestIssue } from '../asset-packs/index.ts';
import type { ShowPackMessage } from './protocol.ts';
import { readShowPackSetting, type ShowPackSetting } from './pack-setting.ts';

export type ShowPackState =
  | { readonly state: 'off' }
  | { readonly state: 'loading'; readonly id: string }
  | { readonly state: 'loaded'; readonly id: string; readonly name: string }
  | { readonly state: 'absent' | 'invalid'; readonly id: string; readonly issues: readonly ManifestIssue[] };

/** Anything with `postMessage` (a Worker). */
export interface ShowPackTarget { postMessage(message: unknown, transfer?: Transferable[]): void }

export interface ShowPackProviderOptions {
  /** The chosen pack id, or null for none (see pack-setting.ts). An invalid id is treated as none. */
  readonly id: string | null;
  readonly source: (packId: string) => AssetPackSource;
  /** Atlas decoder of the load check. Default: createImageBitmap where it exists, else metadata-only. */
  readonly decode?: AtlasDecoder | null;
  /** Diagnostics (console by default): one line per outcome. */
  readonly log?: (level: 'info' | 'warn', text: string) => void;
}

const FILE_SOURCE_ERROR = 'The pack source failed';

export class ShowPackProvider {
  private current: ShowPackState = { state: 'off' };
  private files: { manifest: Uint8Array; atlases: Map<string, Uint8Array> } | null = null;
  private revision = 0;
  /** Settles (never rejects) once the pack has been loaded or has failed; immediately when no pack is chosen. */
  readonly ready: Promise<ShowPackState>;

  constructor(private readonly options: ShowPackProviderOptions) {
    const log = options.log ?? ((level, text) => console[level](`[show pack] ${text}`));
    const id = options.id !== null && isPackId(options.id) ? options.id : null;
    if (id === null) { this.ready = Promise.resolve(this.current); return; }
    this.current = { state: 'loading', id };
    this.ready = this.load(id).then(state => {
      this.current = state;
      if (state.state === 'loaded') log('info', `${state.id} loaded`);
      else if (state.state !== 'off' && state.state !== 'loading') log('warn', `${state.id} ${state.state}: ${state.issues[0]?.path ?? ''} ${state.issues[0]?.message ?? ''}`.trim());
      return state;
    });
  }

  get state(): ShowPackState { return this.current; }

  private async load(id: string): Promise<ShowPackState> {
    try {
      const inner = this.options.source(id);
      const manifest: { bytes: Uint8Array | null } = { bytes: null };
      const atlases = new Map<string, Uint8Array>();
      // Record the exact bytes the loader validated, so workers get what passed and nothing else.
      const recording: AssetPackSource = {
        packId: inner.packId,
        read: async (path, limit) => {
          const bytes = await inner.read(path, limit);
          if (path === ASSET_PACK_MANIFEST_FILE) manifest.bytes = bytes; else atlases.set(path, bytes);
          return bytes;
        },
      };
      const result = await loadAssetPack(recording, this.options.decode === undefined ? {} : { decode: this.options.decode });
      if (result.status !== 'loaded') return { state: result.status, id, issues: result.issues };
      const byId = new Map<string, Uint8Array>();
      for (const [atlasId, atlas] of Object.entries(result.pack.manifest.atlases)) {
        const bytes = atlases.get(atlas.file);
        if (bytes) byId.set(atlasId, bytes);
      }
      if (!manifest.bytes || byId.size !== Object.keys(result.pack.manifest.atlases).length) return { state: 'invalid', id, issues: [{ level: 'error', path: '', message: 'pack bytes were not retained' }] };
      this.files = { manifest: manifest.bytes, atlases: byId };
      return { state: 'loaded', id, name: result.pack.name };
    } catch (error) {
      return { state: 'absent', id, issues: [{ level: 'error', path: '', message: error instanceof Error ? error.message : FILE_SOURCE_ERROR }] };
    }
  }

  /** The `show-pack` message for a worker (fresh transferable copies each call), or null unless a pack is loaded. */
  message(): ShowPackMessage | null {
    if (this.current.state !== 'loaded' || !this.files) return null;
    const copy = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;
    const atlases: Record<string, ArrayBuffer> = {};
    for (const [id, bytes] of this.files.atlases) atlases[id] = copy(bytes);
    return { type: 'show-pack', generation: this.revision, packId: this.current.id, manifest: copy(this.files.manifest), atlases };
  }

  /** Sends the pack to a worker once it is loaded (immediately if it already is). Does nothing when no pack is chosen or it failed. */
  attach(target: ShowPackTarget): void {
    void this.ready.then(() => {
      const message = this.message();
      if (!message) return;
      try { target.postMessage(message, [message.manifest!, ...Object.values(message.atlases!)]); } catch { /* the worker is gone */ }
    });
  }
}

/** Whether a scene worker location is the show engine (the only worker that understands `show-pack`). */
export function isShowWorkerLocation(url: URL | string): boolean {
  try { return new URL(String(url), 'http://localhost/').pathname.endsWith('/show-render.worker.js'); } catch { return false; }
}

export interface HostShowPacksOptions {
  readonly source: (packId: string) => AssetPackSource;
  /** Overrides the device-local setting (checks). */
  readonly setting?: ShowPackSetting;
  readonly decode?: AtlasDecoder | null;
  readonly log?: ShowPackProviderOptions['log'];
}

/** One provider for a host page, for the pack the device-local setting names. */
export function createHostShowPacks(options: HostShowPacksOptions): ShowPackProvider {
  const setting = options.setting ?? readShowPackSetting();
  return new ShowPackProvider({ id: setting.id, source: options.source, ...(options.decode !== undefined ? { decode: options.decode } : {}), ...(options.log ? { log: options.log } : {}) });
}

// ------------------------------------------------------------------------------------------------ Player transport

export const SHOW_PACK_LIBRARY_URL = '/api/aaavs/library';

/** Only `pack.json` and PNG atlases are ever requested: the same two kinds the library server is willing to serve. */
function servable(path: string): number {
  if (path === ASSET_PACK_MANIFEST_FILE) return ASSET_PACK_LIMITS.manifestBytes;
  return packPathProblem(path, ['.png']) === null ? ASSET_PACK_LIMITS.atlasBytes : 0;
}

/** Pack source over the Player's library server: POST `{op: 'read-show-pack-file', pack, path}`; the file comes back as raw bytes
 * (`application/octet-stream`), anything else as a JSON `library-error` (`missing: true` when the file is not there). */
export function httpPackSource(packId: string, url = SHOW_PACK_LIBRARY_URL, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): AssetPackSource {
  if (!isPackId(packId)) throw new Error('Invalid asset pack id');
  return {
    packId,
    async read(path, byteLimit) {
      const problem = packPathProblem(path);
      if (problem) throw new Error(`Invalid asset pack path: ${problem}`);
      const cap = Math.min(servable(path), byteLimit);
      if (cap <= 0) throw new Error('This pack file is not served');
      const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'read-show-pack-file', pack: packId, path }), signal: AbortSignal.timeout(15000) });
      if (!response.ok || !/^application\/octet-stream\b/i.test(response.headers.get('content-type') ?? '')) {
        let body: { message?: unknown; missing?: unknown } = {};
        try { body = await response.json() as typeof body; } catch { /* not JSON */ }
        if (response.status === 404 || body.missing === true) throw new AssetPackMissingError();
        throw new Error(typeof body.message === 'string' ? body.message.slice(0, 200) : `Library request failed (${response.status})`);
      }
      const declared = Number(response.headers.get('content-length'));
      if (declared > cap || !response.body) { await response.body?.cancel(); if (!response.body) return new Uint8Array(); throw new Error('Local asset exceeds byte budget'); }
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > cap) { await reader.cancel(); throw new Error('Local asset exceeds byte budget'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes;
    },
  };
}

export interface ListedShowPack { readonly id: string }
/** The pack ids the Player's library server can serve (diagnostics: `list-show-packs`). Rejects when the server has no pack directory. */
export async function listShowPacks(url = SHOW_PACK_LIBRARY_URL, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<readonly ListedShowPack[]> {
  const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'list-show-packs' }), signal: AbortSignal.timeout(15000) });
  const body = await response.json() as { type?: unknown; packs?: unknown; message?: unknown };
  if (body.type === 'library-error') throw new Error(String(body.message));
  if (body.type !== 'show-packs' || !Array.isArray(body.packs)) throw new Error('Library server returned an invalid pack list');
  return body.packs.filter((p): p is ListedShowPack => !!p && typeof p === 'object' && isPackId((p as { id?: unknown }).id)).map(p => ({ id: p.id }));
}
