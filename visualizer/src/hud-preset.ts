import { HUD_LIMITS, HudManifestError, hudManifestBytes, parseHudManifest, serializeHudManifest, type HudLintOptions, type HudManifest, type HudTier } from './hud/hud-manifest.ts';
export { HudManifestError } from './hud/hud-manifest.ts';

/** `.hud` files: the `nerv-preset.ts` analogue. A `.hud` file is one `mpcaaavs-hud` v1 manifest in canonical UTF-8 text; its catalog SHA-256 is the scene identity.
 * Deliberately small and data-only: the bytes are decoded, JSON-parsed and validated, never evaluated. */
export const HUD_EXTENSION = '.hud';
/** A preset larger than this is refused before it is decoded (32 KiB; typical files are 3 to 8 KiB). */
export const HUD_MAX_BYTES = HUD_LIMITS.bytes;

/** True when a file or catalog path names a HUD preset (case-sensitive, like the `.avs` and `.nerv` checks). */
export function isHudFileName(name: string): boolean {
  return typeof name === 'string' && name.length > HUD_EXTENSION.length && name.endsWith(HUD_EXTENSION);
}

const viewOf = (bytes: ArrayBuffer | ArrayBufferView): Uint8Array => (ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes));

/** True when the JSON text repeats a key inside one object. Assumes `text` is already valid JSON. `JSON.parse` keeps the last duplicate silently, which would let two readers see two scenes. */
export function jsonHasDuplicateKeys(text: string): boolean {
  const stack: (Set<string> | null)[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      let k = j + 1;
      while (k < n && (text[k] === ' ' || text[k] === '\n' || text[k] === '\r' || text[k] === '\t')) k++;
      const top = stack[stack.length - 1];
      if (top && text[k] === ':') {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.has(key)) return true;
        top.add(key);
      }
      i = j + 1;
      continue;
    }
    if (ch === '{') stack.push(new Set());
    else if (ch === '[') stack.push(null);
    else if (ch === '}' || ch === ']') stack.pop();
    i++;
  }
  return false;
}

/** Parse and validate a `.hud` file. Throws `Error` for framing problems (size, encoding, JSON, repeated keys) and `HudManifestError` (all issues attached) for an invalid manifest.
 * `options.deny` is the deny-list hook of `checkHudManifest`. */
export function parseHudPreset(bytes: ArrayBuffer | ArrayBufferView, options: HudLintOptions = {}): HudManifest {
  const size = bytes.byteLength;
  if (size > HUD_MAX_BYTES) throw new Error('HUD preset is too large');
  if (size === 0) throw new Error('HUD preset is empty');
  const view = viewOf(bytes);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(view); } catch { throw new Error('HUD preset is not valid UTF-8'); }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('HUD preset is not valid JSON'); }
  if (jsonHasDuplicateKeys(text)) throw new Error('HUD preset repeats a key');
  return parseHudManifest(value, options);
}

export type HudPresetResult = { readonly ok: true; readonly manifest: HudManifest } | { readonly ok: false; readonly error: string; readonly issues: readonly { readonly path: string; readonly message: string }[] };
/** Like `parseHudPreset` but never throws; the error carries the first issue and `issues` lists them all. */
export function tryParseHudPreset(bytes: ArrayBuffer | ArrayBufferView, options: HudLintOptions = {}): HudPresetResult {
  try { return { ok: true, manifest: parseHudPreset(bytes, options) }; } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), issues: e instanceof HudManifestError ? e.issues.filter(i => i.level === 'error') : [] };
  }
}

/** Canonical UTF-8 bytes of a valid manifest: what the installer hashes and stores. Refuses a manifest whose canonical text exceeds `HUD_MAX_BYTES`. */
export function hudPresetBytes(manifest: HudManifest): Uint8Array {
  if (hudManifestBytes(manifest) > HUD_MAX_BYTES) throw new Error('HUD preset is too large');
  return new TextEncoder().encode(serializeHudManifest(manifest));
}

/** True when `bytes` are exactly the canonical text of the manifest they hold, so the file's SHA-256 is the scene identity and re-saving it changes nothing.
 * False for anything that does not parse (framing or manifest), and for a valid manifest written with other whitespace, key order, number spelling or line endings.
 * Never throws. A worker accepts non-canonical files (readers are tolerant); an installer and `--check` use this to refuse them. */
export function isCanonicalHudPreset(bytes: ArrayBuffer | ArrayBufferView, options: HudLintOptions = {}): boolean {
  try {
    const canonical = hudPresetBytes(parseHudPreset(bytes, options)), given = viewOf(bytes);
    if (canonical.byteLength !== given.byteLength) return false;
    for (let i = 0; i < canonical.byteLength; i++) if (canonical[i] !== given[i]) return false;
    return true;
  } catch { return false; }
}

/** The `.hud` identity: lower-case hexadecimal SHA-256 of the file bytes (of the canonical bytes for a canonical file). Uses Web Crypto, which browsers, workers and
 * Node 20+ provide; the promise rejects where it is missing. The installer's `node:crypto` digest of the same bytes is identical. */
export async function hudPresetSha256(bytes: ArrayBuffer | ArrayBufferView): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } } }).crypto?.subtle;
  if (!subtle) throw new Error('SHA-256 is not available here');
  const view = viewOf(bytes), copy = new Uint8Array(view.byteLength); // a private copy: a view into a shared or larger buffer digests only its own window
  copy.set(view);
  return Array.from(new Uint8Array(await subtle.digest('SHA-256', copy)), b => b.toString(16).padStart(2, '0')).join('');
}

/** The `hud` block of a `kind: 'hud'` catalog row (docs/design/CONTRACT.md 2.2.5), derived from the manifest so installer and parser cannot disagree.
 * `pack` may be replaced by a display label and `tags` extended by the installer; `order` is the installer's ordinal. */
export interface HudCatalogMeta {
  readonly id: string; readonly pack: string; readonly family: string; readonly tags: readonly string[]; readonly tier: HudTier; readonly order: number;
  readonly canvas: { readonly style: 'pixel' | 'vector'; readonly w: number; readonly h: number; readonly par?: readonly [number, number] };
}
/** Pack labels are shown in the browser: printable ASCII and the middle dot (U+00B7), 1 to 80 characters. The catalog parser throws on a bad `hud.pack`, and a throw
 * makes the whole catalog unloadable, so an installer must not be able to write one. */
const PACK_LABEL = /^[\x20-\x7e\u00b7]{1,80}$/;
/** Catalog tags exactly as the host parser keeps them: strings of 1 to 24 characters without control characters, at most eight, first occurrence wins. */
const CATALOG_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
function catalogTags(list: readonly unknown[]): readonly string[] {
  const out: string[] = [];
  for (const t of list) if (typeof t === 'string' && t.length >= 1 && t.length <= HUD_LIMITS.tagChars && !CATALOG_CONTROL.test(t) && !out.includes(t)) out.push(t);
  return Object.freeze(out.slice(0, HUD_LIMITS.tags));
}
export function hudCatalogMeta(manifest: HudManifest, order: number, overrides: { readonly pack?: string; readonly tags?: readonly string[] } = {}): HudCatalogMeta {
  if (!Number.isSafeInteger(order)) throw new Error('HUD catalog order must be a whole number');
  if (overrides.pack !== undefined && (typeof overrides.pack !== 'string' || !PACK_LABEL.test(overrides.pack))) throw new Error('HUD pack label must be 1 to 80 printable ASCII characters (the middle dot is also allowed)');
  const { canvas } = manifest;
  return Object.freeze({
    id: manifest.id, pack: overrides.pack ?? manifest.pack, family: manifest.family, tags: catalogTags(overrides.tags ?? manifest.tags ?? []),
    tier: manifest.meta?.tier ?? 'auto', order,
    canvas: Object.freeze({ style: canvas.style, w: canvas.w, h: canvas.h, ...(canvas.par ? { par: canvas.par } : {}) }),
  });
}
