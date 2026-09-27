interface Occurrence { package_id: string; original_path: string }
interface RecordEntry { sha256: string; canonical_path: string; occurrences: Occurrence[]; type?: string }
let metadata: Promise<{ presets: RecordEntry[]; dependencies: RecordEntry[] }> | undefined;
export async function loadPresetBitmaps(hash: string): Promise<{ name: string; bytes: ArrayBuffer }[]> {
  metadata ??= Promise.all(['presets', 'dependencies'].map(async name => {
    const response = await fetch(`./avs presets/catalog/${name}.json`);
    if (!response.ok) throw new Error(`Missing ${name} dependency catalog`);
    return response.json();
  })).then(([presets, dependencies]) => ({ presets: presets.presets, dependencies: dependencies.dependencies }));
  const data = await metadata;
  const preset = data.presets.find(entry => entry.sha256 === hash);
  const packages = new Set(preset?.occurrences.map(entry => entry.package_id));
  const images = data.dependencies.filter(entry => entry.type === 'bmp' && entry.occurrences.some(origin => packages.has(origin.package_id)));
  const result: { name: string; bytes: ArrayBuffer }[] = [];
  for (const entry of images) {
    const url = './avs presets/' + entry.canonical_path.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Missing bitmap: ${entry.canonical_path}`);
    const bytes = await response.arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');
    if (digest !== entry.sha256) throw new Error(`Bitmap hash mismatch: ${entry.canonical_path}`);
    for (const origin of entry.occurrences.filter(origin => packages.has(origin.package_id))) {
      result.push({ name: origin.original_path, bytes });
    }
  }
  return result;
}
