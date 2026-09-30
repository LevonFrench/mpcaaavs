// Song-map cache: track identity keys, a compact record format and persistence adapters.
//
// A record holds a COMPLETE map only (never a partial scan) and never the waveform: the waveform is
// decoded-PCM-sized (about 5 MB per 4 minutes even at 8 bits) and is cheap to regenerate, so a cache hit
// returns a map without `wave`. Records are invalidated by SONG_MAP_VERSION and the analyzer id in the key
// and in the payload; anything that fails validation is treated as a miss, never as data.
import { SONG_MAP_ANALYZER } from './analyzer.ts';
import { CHROMA_BINS, FPS, MEL_BANDS } from './frames.ts';
import { FEATURE_NAMES } from './features.ts';
import { SONG_MAP_VERSION, type SongMapBinary, type SongMapJSON } from './types.ts';

export const SONG_MAP_CACHE_LIMIT_BYTES = 3 * 1024 * 1024; // base64 payload; the library request limit is 4 MiB
const ID = /^[0-9a-f]{64}$/;
const SPEC_STRIDE = MEL_BANDS + CHROMA_BINS;

/** Opaque track identity: a lowercase 64-hex content hash of the selected audio stream's source bytes. */
export function isTrackId(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }

export function cacheKey(trackId: string): string {
  if (!isTrackId(trackId)) throw new RangeError('Track identity must be a 64-character lowercase hex hash');
  return `${trackId}-v${SONG_MAP_VERSION}`;
}

export interface SongMapRecord {
  readonly version: number;
  readonly analyzer: string;
  readonly trackId: string;
  readonly encoding: 'gzip' | 'identity';
  /** base64 of the (optionally gzipped) container. */
  readonly payload: string;
}

export interface CachedSongMap { readonly map: SongMapJSON; readonly binary: SongMapBinary }

export interface SongMapStore {
  load(trackId: string): Promise<SongMapRecord | null>;
  save(trackId: string, record: SongMapRecord): Promise<void>;
}

export class MemorySongMapStore implements SongMapStore {
  readonly records = new Map<string, SongMapRecord>();
  async load(trackId: string): Promise<SongMapRecord | null> { return this.records.get(cacheKey(trackId)) ?? null; }
  async save(trackId: string, record: SongMapRecord): Promise<void> { this.records.set(cacheKey(trackId), record); }
}

/** One request/response call to the host library channel (HTTP in the standalone Player, the native bridge in MPC). */
export type LibraryCall = (request: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Adapter over the existing library channel: ops `load-song-map` and `save-song-map`. */
export class LibrarySongMapStore implements SongMapStore {
  constructor(private readonly call: LibraryCall) {}
  async load(trackId: string): Promise<SongMapRecord | null> {
    const key = cacheKey(trackId);
    const response = await this.call({ op: 'load-song-map', key });
    if (response.type !== 'song-map-loaded' || response.key !== key) throw new Error(`Unexpected library response ${String(response.type)}`);
    return response.data === null || response.data === undefined ? null : parseRecord(response.data, trackId);
  }
  async save(trackId: string, record: SongMapRecord): Promise<void> {
    const key = cacheKey(trackId);
    const response = await this.call({ op: 'save-song-map', key, data: record });
    if (response.type !== 'song-map-saved') throw new Error(`Unexpected library response ${String(response.type)}`);
  }
}

function parseRecord(value: unknown, trackId: string): SongMapRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.version !== SONG_MAP_VERSION || r.analyzer !== SONG_MAP_ANALYZER || r.trackId !== trackId) return null;
  if ((r.encoding !== 'gzip' && r.encoding !== 'identity') || typeof r.payload !== 'string') return null;
  return { version: r.version, analyzer: r.analyzer, trackId, encoding: r.encoding, payload: r.payload };
}

function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
function fromBase64(text: string): Uint8Array {
  const raw = atob(text), out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type Streams = { CompressionStream?: new (format: string) => GenericTransformStream; DecompressionStream?: new (format: string) => GenericTransformStream };
async function pipe(bytes: Uint8Array, stream: GenericTransformStream): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(bytes as unknown as BufferSource).then(() => writer.close()).catch(() => undefined);
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value as Uint8Array); }
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let at = 0; for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** Serialise a complete map. Returns null when the record would exceed the library request budget. */
export async function encodeRecord(trackId: string, map: SongMapJSON, binary: SongMapBinary): Promise<SongMapRecord | null> {
  cacheKey(trackId);
  const { wave: _wave, ...rest } = map; void _wave;
  const json = new TextEncoder().encode(JSON.stringify(rest));
  const container = new Uint8Array(4 + json.length + binary.spec.length);
  new DataView(container.buffer).setUint32(0, json.length, true);
  container.set(json, 4); container.set(binary.spec, 4 + json.length);
  const streams = globalThis as unknown as Streams;
  let encoding: 'gzip' | 'identity' = 'identity', body: Uint8Array = container;
  if (streams.CompressionStream) { body = await pipe(container, new streams.CompressionStream('gzip')); encoding = 'gzip'; }
  const payload = toBase64(body);
  if (payload.length > SONG_MAP_CACHE_LIMIT_BYTES) return null;
  return { version: SONG_MAP_VERSION, analyzer: SONG_MAP_ANALYZER, trackId, encoding, payload };
}

/** Decode and strictly validate a record. Any inconsistency returns null (a cache miss). */
export async function decodeRecord(record: SongMapRecord): Promise<CachedSongMap | null> {
  try {
    if (record.version !== SONG_MAP_VERSION || record.analyzer !== SONG_MAP_ANALYZER) return null;
    let body = fromBase64(record.payload);
    if (record.encoding === 'gzip') {
      const streams = globalThis as unknown as Streams;
      if (!streams.DecompressionStream) return null;
      body = await pipe(body, new streams.DecompressionStream('gzip'));
    }
    if (body.length < 4) return null;
    const jsonLength = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, true);
    if (jsonLength > body.length - 4) return null;
    const map = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + jsonLength))) as SongMapJSON;
    const spec = new Uint8Array(body.subarray(4 + jsonLength));
    if (!validateMap(map, spec)) return null;
    return { map: { ...map, approximations: [...map.approximations, 'wave.not-cached'] }, binary: { spec, wave: new Float32Array(0) } };
  } catch { return null; }
}

function validateMap(map: SongMapJSON, spec: Uint8Array): boolean {
  if (!map || typeof map !== 'object' || map.version !== SONG_MAP_VERSION || map.fps !== FPS) return false;
  if (!Number.isFinite(map.duration) || map.duration <= 0 || !Number.isFinite(map.bpm)) return false;
  const frames = map.spectrum?.frames;
  if (!Number.isInteger(frames) || frames! < 1 || map.spectrum!.mel !== MEL_BANDS || map.spectrum!.chroma !== CHROMA_BINS) return false;
  if (spec.length !== frames! * SPEC_STRIDE) return false;
  for (const name of FEATURE_NAMES) if (!Array.isArray(map.features?.[name]) || map.features[name].length !== frames) return false;
  if (!Array.isArray(map.beats) || !Array.isArray(map.downbeats) || !Array.isArray(map.sections)) return false;
  for (const kind of ['kick', 'snare', 'hat', 'vocal'] as const) if (!Array.isArray(map.onsets?.[kind])) return false;
  if (!map.confidence || !Array.isArray(map.approximations)) return false;
  let previous = -Infinity;
  for (const section of map.sections) {
    if (!(section.start >= previous) || !(section.end >= section.start)) return false;
    previous = section.start;
  }
  return true;
}
