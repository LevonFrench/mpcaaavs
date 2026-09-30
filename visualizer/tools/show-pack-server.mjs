// Read-only access to private show asset packs for the standalone Player's library server (docs/design/ASSET-PACK-MANIFEST.md).
//
// The directory is chosen by whoever starts the server (`node tools/serve.mjs --show-packs <dir>`, env AAAVS_SHOW_PACKS, or the conventional
// `show-assets-private/` next to the page when it exists); it holds one sub-directory per pack: `<dir>/<pack-id>/pack.json` and
// `<dir>/<pack-id>/atlas/<name>.png`. A page can only ever name a pack id (`a-z0-9-`, at most 48 characters) and a pack-relative path; it can never
// name a directory, so it cannot read anything else. Without a configured directory every operation is refused.
//
// What is served, and nothing else: `pack.json` (at most 512 KiB) and `.png` files (at most 8 MiB each). Every path passes the same allowlist as
// src/asset-packs/paths.ts (mirrored here so the plain-node server needs no build step; tools/check-standalone-library.mjs proves the two agree on
// a hostile corpus). Symbolic links are refused at every level below the pack directory (and the pack directory itself must not be one), as are
// non-regular files and any path whose real location differs from its spelling. Reads open with O_NOFOLLOW where the platform has it and re-check
// the size on the open handle. Listings are bounded (64 packs, 256 files).
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const SHOW_PACK_LIMITS = Object.freeze({ manifestBytes: 512 * 1024, atlasBytes: 8 * 1024 * 1024, packs: 64, files: 256, depth: 6 });

// ---- path rules (mirror of src/asset-packs/paths.ts; keep in step, the check compares them)
const PATH_LIMITS = { chars: 128, segments: 6, segmentChars: 64 };
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)$/i;
const PACK_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const isPackId = value => typeof value === 'string' && PACK_ID.test(value) && !DEVICE.test(value);
export function packPathProblem(path, extensions) {
  if (typeof path !== 'string') return 'must be a string';
  if (path.length === 0) return 'must not be empty';
  if (path.length > PATH_LIMITS.chars) return 'too long';
  if (path.includes('\\')) return 'must not contain backslashes';
  if (path.startsWith('/')) return 'must be relative, not absolute';
  if (path.includes(':')) return 'must not contain a drive letter or URL scheme';
  if (path.includes('%')) return 'must not contain percent-encoding';
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(path)) return 'must not contain control characters';
  const parts = path.split('/');
  if (parts.length > PATH_LIMITS.segments) return 'too many segments';
  for (const part of parts) {
    if (part === '') return 'must not contain empty segments';
    if (part === '.' || part === '..') return 'must not contain dot segments';
    if (part.length > PATH_LIMITS.segmentChars) return 'segment too long';
    if (!SEGMENT.test(part) || part.endsWith('.')) return 'segments may only use letters, digits, underscore, hyphen and inner dots';
    if (DEVICE.test(part.split('.')[0])) return 'must not use a reserved device name';
  }
  if (extensions) {
    const name = parts.at(-1).toLowerCase();
    if (!extensions.some(extension => name.endsWith(extension) && name.length > extension.length)) return `must end in ${extensions.join(' or ')}`;
  }
  return null;
}

const refuse = message => Object.assign(Error(message), { showPack: true });
const missing = () => Object.assign(Error('Show pack file not found'), { showPack: true, missing: true });
const isMissing = error => error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');

/** The byte budget of a servable pack file, or 0 when the path is not one the server serves. */
export function servableLimit(path) {
  if (packPathProblem(path) !== null) return 0;
  if (path === 'pack.json') return SHOW_PACK_LIMITS.manifestBytes;
  return packPathProblem(path, ['.png']) === null ? SHOW_PACK_LIMITS.atlasBytes : 0;
}

/** `directory` is the configured directory of packs, or undefined/empty when unconfigured (every call then refuses). */
export function createShowPackReader(directory) {
  const configured = typeof directory === 'string' && directory.length > 0 ? resolve(directory) : null;
  async function root() {
    if (!configured) throw refuse('Show packs are not configured on this server (start it with --show-packs <directory>)');
    try { const real = await realpath(configured); if (!(await lstat(real)).isDirectory()) throw refuse('The show pack directory is not a directory'); return real; }
    catch (error) { if (isMissing(error)) throw missing(); throw error; }
  }
  async function packDirectory(id) {
    if (!isPackId(id)) throw refuse('Invalid show pack id');
    const base = await root(), dir = join(base, id);
    let info;
    try { info = await lstat(dir); } catch (error) { if (isMissing(error)) throw missing(); throw error; }
    if (info.isSymbolicLink() || !info.isDirectory()) throw refuse('Show pack directories must be regular directories');
    return dir;
  }
  async function regularFile(dir, path) {
    let current = dir, info;
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]);
      try { info = await lstat(current); } catch (error) { if (isMissing(error)) throw missing(); throw error; }
      if (info.isSymbolicLink()) throw refuse('Linked show pack paths are not served');
      if (index < parts.length - 1 && !info.isDirectory()) throw missing();
    }
    if (!info.isFile()) throw refuse('Show pack files must be regular files');
    if ((await realpath(current)) !== join(await realpath(dir), ...parts)) throw refuse('Show pack path escaped the pack directory');
    return { full: current, info };
  }
  return {
    get configured() { return configured !== null; },
    /** Ids of the packs that hold a regular `pack.json`, sorted, at most 64. */
    async list() {
      const base = await root();
      const names = (await readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory() && isPackId(entry.name)).map(entry => entry.name).sort();
      const packs = [];
      for (const id of names) {
        if (packs.length >= SHOW_PACK_LIMITS.packs) break;
        try { await regularFile(join(base, id), 'pack.json'); packs.push({ id }); } catch { /* not a pack */ }
      }
      return packs;
    },
    /** Servable files of one pack: `pack.json` and PNGs, at most 256, depth-limited, no links. */
    async files(id) {
      const dir = await packDirectory(id), out = [];
      async function walk(relative, depth) {
        if (out.length >= SHOW_PACK_LIMITS.files || depth > SHOW_PACK_LIMITS.depth) return;
        const entries = (await readdir(relative ? join(dir, ...relative.split('/')) : dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
        for (const entry of entries) {
          if (out.length >= SHOW_PACK_LIMITS.files) return;
          const path = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) { if (packPathProblem(path) === null) await walk(path, depth + 1); continue; }
          if (!entry.isFile() || servableLimit(path) === 0) continue;
          const { info } = await regularFile(dir, path);
          out.push({ path, bytes: info.size });
        }
      }
      await walk('', 1);
      return out;
    },
    /** The bytes of one servable file (a Buffer). Refuses everything else; missing files throw an error with `missing: true`. */
    async read(id, path) {
      const limit = servableLimit(path);
      if (limit === 0) throw refuse('This show pack file is not served');
      const dir = await packDirectory(id), { full, info } = await regularFile(dir, path);
      if (info.size > limit) throw refuse('Show pack file exceeds its size limit');
      let handle;
      try { handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch (error) { if (isMissing(error)) throw missing(); if (error.code === 'ELOOP') throw refuse('Linked show pack paths are not served'); throw error; }
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size > limit || opened.size !== info.size) throw refuse('Show pack file changed while it was read');
        const bytes = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (bytesRead === 0) break; offset += bytesRead; }
        if (offset !== bytes.length) throw refuse('Show pack file changed while it was read');
        return bytes;
      } finally { await handle.close(); }
    },
  };
}
