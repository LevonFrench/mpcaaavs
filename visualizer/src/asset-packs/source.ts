/** Where pack bytes come from. Hosts differ only in this adapter, never in pack logic.
 *
 * Both hosts already read local files the same way: the page fetches URLs under its own origin, which the MPC host maps to the
 * `visualizer/` folder (`https://aaavs.invalid/`, WebView2 virtual host) and the standalone Player serves from the same folder.
 * `fetchPackSource` is therefore the one production adapter, built on the bounded reader the preset collection uses
 * (`avs/local-assets.ts`). `memoryPackSource` serves tests and generated packs. A Node file adapter for tools lives in
 * tools/asset-pack-fs-source.mjs. Every adapter validates the path itself (defence in depth), whatever the caller checked. */
import { boundedBytes } from '../avs/local-assets.ts';
import { assetPackUrl, isPackId, packPathProblem } from './paths.ts';

/** The file does not exist (or is not served): a pack that is simply not installed. */
export class AssetPackMissingError extends Error {
  constructor(message = 'Asset pack file not found') { super(message); this.name = 'AssetPackMissingError'; }
}

export interface AssetPackSource {
  /** The pack id (its directory name). */
  readonly packId: string;
  /** Reads one pack-relative file of at most `byteLimit` bytes. Throws AssetPackMissingError when absent, Error for anything else. */
  read(path: string, byteLimit: number): Promise<Uint8Array>;
}

/** Reads `show-assets-private/<packId>/` next to the page at `base` (defaults to the current page). `fetchBytes` is injectable for checks. */
export function fetchPackSource(packId: string, base: string = (globalThis as { location?: { href: string } }).location?.href ?? '', fetchBytes: typeof boundedBytes = boundedBytes): AssetPackSource {
  if (!isPackId(packId)) throw new Error('Invalid asset pack id');
  return {
    packId,
    async read(path, byteLimit) {
      const url = assetPackUrl(packId, path, base);
      try { return await fetchBytes(url, byteLimit); }
      catch (error) {
        if (error instanceof Error && /\(HTTP (?:404|410)\)/.test(error.message)) throw new AssetPackMissingError();
        throw error;
      }
    },
  };
}

/** A pack held in memory: pack-relative path to bytes or UTF-8 text. */
export function memoryPackSource(packId: string, files: Readonly<Record<string, Uint8Array | string>>): AssetPackSource {
  if (!isPackId(packId)) throw new Error('Invalid asset pack id');
  return {
    packId,
    async read(path, byteLimit) {
      const problem = packPathProblem(path);
      if (problem) throw new Error(`Invalid asset pack path: ${problem}`);
      if (!Object.hasOwn(files, path)) throw new AssetPackMissingError();
      const value = files[path]!;
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
      if (bytes.byteLength > byteLimit) throw new Error('Local asset exceeds byte budget');
      return bytes;
    },
  };
}
