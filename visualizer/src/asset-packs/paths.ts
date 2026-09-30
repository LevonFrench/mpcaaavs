/** Pack-relative path rules and URL building for local asset packs (docs/design/ASSET-PACK-MANIFEST.md, "Paths").
 *
 * A pack lives in `show-assets-private/<pack-id>/` beside the page that runs the host (`visualizer/` in both the MPC host and
 * the standalone Player). Every file name inside a manifest is a pack-relative path validated by an allowlist, not a blocklist:
 * segments are ASCII letters, digits, `_`, `-` and `.`, never start with a dot and never end with one. That rejects `..`,
 * absolute paths, backslashes, drive letters and URL schemes (`:`), percent-encoding, control characters, Windows device names,
 * 8.3 short names (`~`), trailing-dot/space aliases and hidden files in one rule. No imports: usable from workers and checks. */

export const ASSET_PACK_ROOT = 'show-assets-private';
export const PACK_PATH_LIMITS = Object.freeze({ chars: 128, segments: 6, segmentChars: 64 });
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)$/i;
const PACK_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function isPackId(value: unknown): value is string {
  return typeof value === 'string' && PACK_ID.test(value) && !DEVICE.test(value);
}

/** Why a pack-relative path is unacceptable, or `null` when it is fine. `extensions` are lower-case, with the dot. */
export function packPathProblem(path: unknown, extensions?: readonly string[]): string | null {
  if (typeof path !== 'string') return 'must be a string';
  if (path.length === 0) return 'must not be empty';
  if (path.length > PACK_PATH_LIMITS.chars) return `must be at most ${PACK_PATH_LIMITS.chars} characters`;
  if (path.includes('\\')) return 'must not contain backslashes';
  if (path.startsWith('/')) return 'must be relative, not absolute';
  if (path.includes(':')) return 'must not contain a drive letter or URL scheme';
  if (path.includes('%')) return 'must not contain percent-encoding';
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(path)) return 'must not contain control characters';
  const parts = path.split('/');
  if (parts.length > PACK_PATH_LIMITS.segments) return `must have at most ${PACK_PATH_LIMITS.segments} segments`;
  for (const part of parts) {
    if (part === '') return 'must not contain empty segments';
    if (part === '.' || part === '..') return 'must not contain dot segments';
    if (part.length > PACK_PATH_LIMITS.segmentChars) return `segments must be at most ${PACK_PATH_LIMITS.segmentChars} characters`;
    if (!SEGMENT.test(part) || part.endsWith('.')) return 'segments may only use letters, digits, underscore, hyphen and inner dots';
    if (DEVICE.test(part.split('.')[0]!)) return 'must not use a reserved device name';
  }
  if (extensions) {
    const name = parts.at(-1)!.toLowerCase();
    if (!extensions.some(extension => name.endsWith(extension) && name.length > extension.length)) return `must end in ${extensions.join(' or ')}`;
  }
  return null;
}

export function isPackPath(path: unknown, extensions?: readonly string[]): path is string {
  return packPathProblem(path, extensions) === null;
}

/** URL of a file in a pack, relative to the host page `base` (`https://aaavs.invalid/mpc.html` in MPC, the page origin in the Player).
 * Throws on any path or pack id the allowlist rejects, and if URL resolution would leave the pack directory. */
export function assetPackUrl(packId: string, path: string, base: string): string {
  if (!isPackId(packId)) throw new Error('Invalid asset pack id');
  const problem = packPathProblem(path);
  if (problem) throw new Error(`Invalid asset pack path: ${problem}`);
  const root = new URL(`./${ASSET_PACK_ROOT}/${packId}/`, base);
  const url = new URL(path.split('/').map(encodeURIComponent).join('/'), root);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname) || url.search || url.hash) throw new Error('Asset pack path escaped the pack directory');
  return url.href;
}
