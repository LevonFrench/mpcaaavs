// Validate a local asset pack directory: node tools/validate-asset-pack.mjs show-assets-private/<pack-id>
// Checks the manifest strictly and every atlas PNG header against its declared size. Reads only; prints issues and exits 1 on any.
import { loadAssetPackModule, fsPackSource } from './asset-pack-fs-source.mjs';
const directory = process.argv[2];
if (!directory) { console.error('usage: node tools/validate-asset-pack.mjs <pack directory>'); process.exit(2); }
const A = await loadAssetPackModule();
let source;
try { source = fsPackSource(A, directory); } catch (error) { console.error(`error: ${error.message}`); process.exit(1); }
const result = await A.loadAssetPack(source, { decode: null });
if (result.status === 'loaded') {
  const m = result.pack.manifest;
  console.log(`${m.id} (${m.name}): OK, ${Object.keys(m.atlases).length} atlases, ${Object.keys(m.regions).length} regions, ${Object.keys(m.clips).length} clips, ${Object.keys(m.fonts).length} fonts`);
} else {
  for (const issue of result.issues) console.error(`${result.status}: ${issue.path}: ${issue.message}`);
  process.exit(1);
}
