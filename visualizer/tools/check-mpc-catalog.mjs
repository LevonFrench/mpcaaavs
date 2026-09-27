import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const result = await build({ entryPoints: ['src/avs/local-collection.ts'], bundle: true, format: 'esm', write: false });
const { parseLocalAvsCatalog } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const root = new URL('../avs presets/', import.meta.url);
const metadata = JSON.parse(await readFile(new URL('catalog/presets.json', root)));
const validation = JSON.parse(await readFile(new URL('catalog/parser-validation.json', root)));
const catalog = parseLocalAvsCatalog(metadata, validation, 'https://aaavs.invalid/mpc.html');
assert.equal(catalog.length, metadata.presets.length);
assert.equal(new Set(catalog.map(p => p.sha256)).size, catalog.length);
for (const entry of metadata.presets) {
  const bytes = await readFile(new URL(entry.canonical_path.split('/').map(encodeURIComponent).join('/'), root));
  assert.equal(bytes.length, entry.bytes, entry.display_name);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, entry.display_name);
}
const source = await readFile(new URL('../src/mpc-host.ts', import.meta.url), 'utf8');
assert.ok(source.includes('new PresetNavigation(catalog.length)'));
assert.ok(!source.includes('BUNDLED_AVS_PRESETS'));
console.log(`Full MPC catalog PASS: ${catalog.length} entries, all files/hash/size verified. ${catalog.filter(p => p.parserStatus === 'parse-error').length} recorded parser failures remain included.`);
