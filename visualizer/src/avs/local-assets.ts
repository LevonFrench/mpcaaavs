/** Resource limits for local collection data; no renderer or network service required. */
export const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
export const MAX_ASSET_BYTES = 64 * 1024 * 1024;
export const MAX_CATALOG_ENTRIES = 50_000;
export function localAssetUrl(path: string, subtree: 'presets' | 'dependencies', base: string): string {
  if (typeof path !== 'string' || path.length > 2048 || /[\\%:\x00-\x1f]/.test(path)
    || !path.startsWith(`${subtree}/unique/`) || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid local asset path');
  }
  const root = new URL('./avs presets/', base);
  const url = new URL(path.split('/').map(encodeURIComponent).join('/'), root);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) throw new Error('Local asset escaped collection');
  return url.href;
}
export async function boundedBytes(url: string | URL, limit: number): Promise<Uint8Array> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Local asset unavailable (HTTP ${response.status})`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) { await response.body?.cancel(); throw new Error('Local asset exceeds byte budget'); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('Local asset exceeds byte budget'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
export async function boundedJson(url: string | URL): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await boundedBytes(url, MAX_CATALOG_BYTES)));
}
export async function verifyDigest(bytes: Uint8Array, expected: string): Promise<void> {
  const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)), x => x.toString(16).padStart(2, '0')).join('');
  if (actual !== expected.toLowerCase()) throw new Error('Local asset SHA-256 mismatch');
}
