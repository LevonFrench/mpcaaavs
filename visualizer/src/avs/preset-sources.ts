import { BUNDLED_AVS_PRESETS, fetchBundledAvsPreset } from './bundled-presets.ts';
import { fetchLocalAvsCatalog, fetchLocalAvsPreset } from './local-collection.ts';
import { AvsPersonalBank } from './personal-bank.ts';

export type AvsPresetSourceId = 'bundled' | 'local' | 'personal';

export interface AvsPresetSourceMetadata {
  readonly id: string;
  readonly name: string;
  readonly fileName: string;
  readonly collection: string;
  readonly sha256?: string;
  readonly byteLength?: number;
  readonly autoEligible?: boolean;
  readonly unavailableReason?: string;
}

export interface AvsPresetEntry extends AvsPresetSourceMetadata {
  readonly sourceId: AvsPresetSourceId;
  /** Collision-free ID for deterministic cross-source cue ledgers. */
  readonly ledgerId: string;
  /** Lazy, integrity-checked access to the exact source bytes. */
  load(): Promise<Uint8Array>;
}

export interface AvsPresetSourceSnapshot {
  readonly sourceId: AvsPresetSourceId;
  readonly label: string;
  readonly entries: readonly AvsPresetEntry[];
  readonly error?: string;
}

export interface AvsPresetSourceAdapter {
  readonly id: AvsPresetSourceId;
  readonly label: string;
  list(): Promise<readonly AvsPresetSourceMetadata[]>;
  load(id: string): Promise<Uint8Array>;
  invalidate?(): void;
}

/**
 * Single metadata/byte authority shared by live playback and offline export.
 * Catalogs are cached, but preset bytes are never fetched until `entry.load()`.
 */
export class AvsPresetSourceRegistry {
  private readonly sources = new Map<AvsPresetSourceId, AvsPresetSourceAdapter>();
  private readonly catalogs = new Map<AvsPresetSourceId, Promise<readonly AvsPresetEntry[]>>();
  private readonly autoBanks = new Map<AvsPresetSourceId, Promise<readonly AvsPresetEntry[]>>();
  private readonly listeners = new Set<(sourceId?: AvsPresetSourceId) => void>();

  constructor(sources: readonly AvsPresetSourceAdapter[]) {
    for (const source of sources) {
      if (this.sources.has(source.id)) throw new Error(`Duplicate AVS preset source ${source.id}`);
      this.sources.set(source.id, source);
    }
  }

  async list(sourceId: AvsPresetSourceId, refresh = false): Promise<readonly AvsPresetEntry[]> {
    const source = this.requireSource(sourceId);
    if (refresh) { this.catalogs.delete(sourceId); this.autoBanks.delete(sourceId); source.invalidate?.(); }
    let pending = this.catalogs.get(sourceId);
    if (!pending) {
      pending = source.list().then((metadata) => Object.freeze(metadata.map((entry) => this.wrap(source, entry))));
      this.catalogs.set(sourceId, pending);
      // A transient network/IndexedDB failure must not poison future refreshes.
      pending.catch(() => { if (this.catalogs.get(sourceId) === pending) this.catalogs.delete(sourceId); });
    }
    return pending;
  }

  async snapshot(sourceId: AvsPresetSourceId, refresh = false): Promise<AvsPresetSourceSnapshot> {
    const source = this.requireSource(sourceId);
    try {
      return Object.freeze({ sourceId, label: source.label, entries: await this.list(sourceId, refresh) });
    } catch (error) {
      return Object.freeze({
        sourceId, label: source.label, entries: Object.freeze([]),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async snapshots(refresh = false): Promise<readonly AvsPresetSourceSnapshot[]> {
    return Object.freeze(await Promise.all(
      [...this.sources.keys()].map((sourceId) => this.snapshot(sourceId, refresh)),
    ));
  }

  async find(sourceId: AvsPresetSourceId, id: string): Promise<AvsPresetEntry | undefined> {
    return (await this.list(sourceId)).find((entry) => entry.id === id || entry.ledgerId === id);
  }

  async require(sourceId: AvsPresetSourceId, id: string): Promise<AvsPresetEntry> {
    const entry = await this.find(sourceId, id);
    if (!entry) throw new Error(`Unknown ${sourceId} AVS preset: ${id}`);
    return entry;
  }

  async autoBank(sourceId: AvsPresetSourceId): Promise<readonly AvsPresetEntry[]> {
    let pending = this.autoBanks.get(sourceId);
    if (!pending) {
      pending = this.list(sourceId).then((entries) => {
        const eligible = entries.filter((entry) => entry.autoEligible !== false);
        return eligible.length === entries.length ? entries : Object.freeze(eligible);
      });
      this.autoBanks.set(sourceId, pending);
      pending.catch(() => { if (this.autoBanks.get(sourceId) === pending) this.autoBanks.delete(sourceId); });
    }
    return pending;
  }

  invalidate(sourceId?: AvsPresetSourceId): void {
    if (sourceId) {
      this.catalogs.delete(sourceId);
      this.autoBanks.delete(sourceId);
      this.sources.get(sourceId)?.invalidate?.();
    } else {
      this.catalogs.clear();
      this.autoBanks.clear();
      for (const source of this.sources.values()) source.invalidate?.();
    }
    for (const listener of this.listeners) listener(sourceId);
  }

  subscribe(listener: (sourceId?: AvsPresetSourceId) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private wrap(source: AvsPresetSourceAdapter, metadata: AvsPresetSourceMetadata): AvsPresetEntry {
    if (!metadata.id || !metadata.name || !metadata.fileName) {
      throw new Error(`Invalid ${source.id} AVS preset metadata`);
    }
    const ledgerId = `${source.id}:${metadata.id}`;
    return Object.freeze({
      ...metadata,
      sourceId: source.id,
      ledgerId,
      autoEligible: metadata.autoEligible !== false,
      load: async () => {
        if (metadata.autoEligible === false && metadata.unavailableReason) {
          throw new Error(`${metadata.name} is unavailable: ${metadata.unavailableReason}`);
        }
        const bytes = await source.load(metadata.id);
        if (metadata.byteLength !== undefined && bytes.byteLength !== metadata.byteLength) {
          throw new Error(`${metadata.name} byte length changed (${bytes.byteLength}, expected ${metadata.byteLength})`);
        }
        if (metadata.sha256) {
          const actual = await sha256Hex(bytes);
          if (actual !== metadata.sha256.toLowerCase()) throw new Error(`${metadata.name} SHA-256 mismatch`);
        }
        return bytes;
      },
    });
  }

  private requireSource(sourceId: AvsPresetSourceId): AvsPresetSourceAdapter {
    const source = this.sources.get(sourceId);
    if (!source) throw new Error(`AVS preset source is not registered: ${sourceId}`);
    return source;
  }
}

export const PERSONAL_AVS_BANK = new AvsPersonalBank();

let localCatalogCache: Awaited<ReturnType<typeof fetchLocalAvsCatalog>> | null = null;

export const AVS_PRESET_SOURCES = new AvsPresetSourceRegistry([
  {
    id: 'bundled', label: 'Community + Winamp 5 Picks',
    async list() {
      return BUNDLED_AVS_PRESETS.map((preset) => ({
        id: preset.id, name: preset.name, fileName: preset.fileName,
        collection: preset.collection, autoEligible: true,
      }));
    },
    async load(id) {
      const preset = BUNDLED_AVS_PRESETS.find((candidate) => candidate.id === id);
      if (!preset) throw new Error(`Unknown bundled AVS preset: ${id}`);
      return fetchBundledAvsPreset(preset);
    },
  },
  {
    id: 'local', label: 'Full local collection',
    async list() {
      localCatalogCache = await fetchLocalAvsCatalog();
      // This registry feeds the legacy AVS editor/projector/offline executor.
      // Mixed collections also contain NERV manifests, which use their own worker.
      return localCatalogCache.filter((preset) => preset.kind !== 'nerv').map((preset) => ({
        id: preset.id, name: preset.name, fileName: preset.fileName,
        collection: 'Full local collection', sha256: preset.sha256,
        byteLength: preset.bytes, autoEligible: preset.autoEligible && !preset.notWorking,
        ...(preset.unavailableReason ? { unavailableReason: preset.unavailableReason } : {}),
      }));
    },
    async load(id) {
      const catalog = localCatalogCache ??= await fetchLocalAvsCatalog();
      const preset = catalog.find((candidate) => candidate.id === id);
      if (!preset || preset.kind === 'nerv') throw new Error(`Unknown local AVS preset: ${id}`);
      return fetchLocalAvsPreset(preset);
    },
    invalidate() { localCatalogCache = null; },
  },
  {
    id: 'personal', label: 'My AVS',
    async list() {
      return (await PERSONAL_AVS_BANK.list()).map((preset) => ({
        id: preset.id, name: preset.name, fileName: preset.fileName,
        collection: 'My AVS', sha256: preset.sha256,
        byteLength: preset.bytes, autoEligible: true,
      }));
    },
    async load(id) { return (await PERSONAL_AVS_BANK.get(id)).bytes; },
  },
]);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', source));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}
