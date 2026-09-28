import { boundedBytes, boundedJson, localAssetUrl, MAX_ASSET_BYTES, MAX_CATALOG_ENTRIES, verifyDigest } from './avs/local-assets.ts';
import { NERV_SCENES } from './nerv-scenes.ts';
interface Occurrence { package_id: string; original_path: string }
interface RecordEntry { sha256: string; canonical_path: string; occurrences: Occurrence[]; type?: string; kind?: string; scene?: string }
function records(value: unknown, key: 'presets' | 'dependencies'): RecordEntry[] {
  const rows = (value as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(rows) || rows.length > MAX_CATALOG_ENTRIES) throw new Error('Invalid dependency catalog');
  return rows.flatMap((row: RecordEntry) => {
    if (!row || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(row.sha256)
      || typeof row.canonical_path !== 'string') throw new Error('Invalid dependency record');
    localAssetUrl(row.canonical_path, key, base());
    // Public NERV manifests share the preset catalog but have no legacy package
    // origins or bitmap dependencies. Do not apply AVS origin rules to them.
    if (key === 'presets' && row.kind === 'nerv') {
      if (!row.canonical_path.endsWith('.nerv') || !NERV_SCENES.some(scene => scene === row.scene)) throw new Error('Invalid NERV dependency record');
      return [];
    }
    if (!Array.isArray(row.occurrences) || row.occurrences.length > 1024
      || row.occurrences.some(o => !o || typeof o.package_id !== 'string' || o.package_id.length > 2048
        || typeof o.original_path !== 'string' || o.original_path.length > 2048)) throw new Error('Invalid dependency record');
    return [row];
  });
}
function base() { return typeof document === 'undefined' ? 'http://127.0.0.1/' : document.baseURI; }
let metadata: Promise<{ presets: RecordEntry[]; dependencies: RecordEntry[] }> | undefined;
export async function loadPresetBitmaps(hash: string): Promise<{ name: string; bytes: ArrayBuffer }[]> {
  metadata ??= Promise.all(['presets', 'dependencies'].map(name => boundedJson(new URL(`./avs presets/catalog/${name}.json`, base()))))
    .then(([presets, dependencies]) => ({ presets: records(presets, 'presets'), dependencies: records(dependencies, 'dependencies') }))
    .catch(error => { metadata = undefined; throw error; });
  const data = await metadata;
  const preset = data.presets.find(entry => entry.sha256.toLowerCase() === hash.toLowerCase());
  const packages = new Set(preset?.occurrences.map(entry => entry.package_id));
  const images = data.dependencies.filter(entry => entry.type === 'bmp' && entry.occurrences.some(origin => packages.has(origin.package_id)));
  const result: { name: string; bytes: ArrayBuffer }[] = [];
  const loaded = new Map<string, ArrayBuffer>();
  let total = 0, pixels = 0;
  for (const entry of images) {
    const digest = entry.sha256.toLowerCase();
    let bytes = loaded.get(digest);
    if (!bytes) {
      const data = await boundedBytes(localAssetUrl(entry.canonical_path, 'dependencies', base()), Math.min(MAX_ASSET_BYTES, 128 * 1024 * 1024 - total));
      total += data.byteLength;
      await verifyDigest(data, digest);
      if (data.length < 54 || data[0] !== 66 || data[1] !== 77) throw new Error('Invalid BMP header');
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const width = view.getInt32(18, true), height = Math.abs(view.getInt32(22, true));
      const count = width * height;
      if (width <= 0 || height <= 0 || !Number.isSafeInteger(count) || count > 16_777_216 || pixels + count > 33_554_432) throw new Error('Package exceeds bitmap pixel budget');
      pixels += count;
      bytes = data.buffer as ArrayBuffer; loaded.set(digest, bytes);
    }
    for (const origin of entry.occurrences.filter(origin => packages.has(origin.package_id))) {
      if (result.length >= 8192) throw new Error('Package exceeds bitmap alias budget');
      result.push({ name: origin.original_path, bytes });
    }
  }
  return result;
}
