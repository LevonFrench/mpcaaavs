/** Device-local choice of the private show asset pack (docs/design/ASSET-PACK-MANIFEST.md, "Host wiring").
 *
 * The setting names one pack by id, never a path: a pack id is 1-48 characters of `a-z0-9-` (asset-packs/paths.ts `isPackId`), which
 * cannot express a directory, a URL or an escape. Each host maps the id to its own pack folder (the MPC host reads
 * `show-assets-private/<id>/` beside the page; the standalone Player asks its library server, which reads the directory the server was
 * started with). Nothing is persisted by the page except the id, in the same device-local place as `mpcaaavs.nervEngine`: localStorage
 * `mpcaaavs.showPack`. The page URL overrides it for testing: `?pack=<id>` selects a pack, `?pack=off` (or empty) selects none.
 * The default is no pack: plates draw procedural stand-ins. Pure apart from the optional environment reads; never throws. */
import { isPackId } from '../asset-packs/paths.ts';

export const SHOW_PACK_KEY = 'mpcaaavs.showPack';
export const SHOW_PACK_PARAM = 'pack';

export type ShowPackSettingSource = 'url' | 'storage' | 'default';
export interface ShowPackSetting { readonly id: string | null; readonly source: ShowPackSettingSource }

/** A valid pack id, or null for anything else ("off", "none", empty, non-strings and every invalid id: the setting fails closed). */
export function parseShowPackSetting(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return isPackId(id) && id !== 'off' && id !== 'none' ? id : null;
}

export interface ShowPackEnvironment {
  /** The page's query string (`location.search`). */
  readonly search?: string | null;
  /** Reads the stored value; may throw (storage can be blocked). */
  readonly stored?: () => string | null;
}

/** The effective setting: the URL parameter if present (even when it selects none), else the stored value, else no pack. */
export function readShowPackSetting(env: ShowPackEnvironment = defaultEnvironment()): ShowPackSetting {
  try {
    const query = env.search ? new URLSearchParams(env.search) : null;
    if (query?.has(SHOW_PACK_PARAM)) return { id: parseShowPackSetting(query.get(SHOW_PACK_PARAM)), source: 'url' };
  } catch { /* an unreadable URL selects nothing */ }
  try {
    const id = parseShowPackSetting(env.stored?.() ?? null);
    if (id) return { id, source: 'storage' };
  } catch { /* storage may be blocked */ }
  return { id: null, source: 'default' };
}

/** Stores (or, with null, clears) the device-local choice. Returns false when storage is unavailable or the id is invalid. */
export function writeShowPackSetting(id: string | null, storage: Pick<Storage, 'setItem' | 'removeItem'> | null = defaultStorage()): boolean {
  try {
    if (!storage) return false;
    if (id === null) { storage.removeItem(SHOW_PACK_KEY); return true; }
    if (parseShowPackSetting(id) !== id) return false;
    storage.setItem(SHOW_PACK_KEY, id);
    return true;
  } catch { return false; }
}

function defaultStorage(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}
function defaultEnvironment(): ShowPackEnvironment {
  return {
    search: typeof location !== 'undefined' ? location.search : null,
    stored: () => defaultStorage()?.getItem(SHOW_PACK_KEY) ?? null,
  };
}
