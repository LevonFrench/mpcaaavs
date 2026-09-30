import { readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { loadBrowser } from './fixtures-folders.mjs';
// The local collection is private and optional (a public checkout or a stock install has none), so this check skips cleanly without it.
// It only ever reads: the catalog, the parser metadata, the optional sources file, and each preset file for its size and digest.
const root = new URL('../avs presets/', import.meta.url);
const exists = async url => { try { await access(url); return true; } catch { return false; } };
if (!await exists(new URL('catalog/presets.json', root)) || !await exists(new URL('catalog/parser-validation.json', root))) {
  console.log('Full MPC catalog SKIPPED: the local preset collection is not present in this checkout.');
  process.exit(0);
}
const B = await loadBrowser();
const { parseLocalAvsCatalog, parseLocalAvsSources, buildFolderTree, buildRecords, folderMembers, treeRows, parseQuery, runQuery } = B;
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

// ---------------------------------------------------------------------------------------------------- provenance and the folder tree
// Browsing data only: origins come from `occurrences[].original_path`; the private staging `path` is never kept or shown.
const ABSOLUTE = /^[A-Za-z]:[\\/]|^[\\/]/;
const hasControl = text => { for (const ch of text) { const c = ch.codePointAt(0); if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true; } return false; };
const wellFormed = o => o && typeof o.package_id === 'string' && o.package_id.length > 0 && o.package_id.length <= 200
  && typeof o.original_path === 'string' && o.original_path.length > 0 && o.original_path.length <= 1024 && !hasControl(o.package_id + o.original_path);
let withOrigins = 0;
metadata.presets.forEach((entry, i) => {
  const occ = Array.isArray(entry.occurrences) ? entry.occurrences : [];
  const good = occ.filter(wellFormed);
  const origins = catalog[i].origins;
  if (occ.length > 32 || good.length === 0) { assert.equal(origins, undefined, `${entry.display_name}: oversize or empty provenance is dropped`); return; }
  assert.ok(origins, `${entry.display_name}: origins parsed`);
  assert.deepEqual(origins.map(o => [o.pkg, o.path]), good.map(o => [o.package_id, o.original_path]), entry.display_name);
  for (const o of origins) {
    assert.ok(!ABSOLUTE.test(o.path), `${entry.display_name}: an origin path is archive-relative, not absolute`);
    assert.ok(!o.path.includes('_staging'), `${entry.display_name}: no staging segment in an origin`);
  }
  withOrigins++;
});
assert.ok(withOrigins > 0, 'the collection carries provenance');
assert.ok(!JSON.stringify(catalog.map(p => p.origins ?? null)).includes('_staging'), 'the private staging path is not kept anywhere');

let sources = new Map();
if (await exists(new URL('catalog/sources.json', root))) {
  const sourcesJson = JSON.parse(await readFile(new URL('catalog/sources.json', root)));
  sources = parseLocalAvsSources(sourcesJson);
  const rows = Array.isArray(sourcesJson) ? sourcesJson : sourcesJson.sources;
  assert.equal(sources.size, Math.min(5000, new Set(rows.filter(r => r && typeof r.id === 'string' && r.id.length > 0 && r.id.length <= 200 && r.id !== '__proto__').map(r => r.id)).size), 'every well-formed package id is read');
  for (const info of sources.values()) for (const value of Object.values(info)) assert.ok(!/^https?:/i.test(value), 'sources.json addresses are not kept');
}

const started = performance.now();
const tree = buildFolderTree(catalog, { sources });
const rs = buildRecords(catalog, tree, null);
const built = performance.now() - started;
assert.ok(built < 3000, `tree and records build in ${built.toFixed(0)} ms (generous budget)`);
const avs = catalog.map((p, i) => i).filter(i => catalog[i].kind !== 'nerv' && catalog[i].kind !== 'hud');
const avsRoot = tree.byKey.get('avs');
assert.notEqual(avsRoot, undefined, 'an AVS root exists');
assert.equal(folderMembers(tree, avsRoot, rs).length, avs.length, 'the AVS root counts every unique AVS preset once');
assert.equal(tree.nodes[avsRoot].members.length, avs.length);
for (const i of avs) {
  assert.ok(tree.locations[i].length >= 1, `${catalog[i].name}: at least one source folder`);
  assert.ok(tree.locations[i].includes(tree.primary[i]), `${catalog[i].name}: the primary location is one of its locations`);
  for (const id of tree.locations[i]) assert.ok(tree.nodes[id].direct.includes(i));
}
const source_ = tree.byKey.get('avs/src');
assert.notEqual(source_, undefined, 'By source exists');
const groups = tree.nodes[source_].children.map(id => folderMembers(tree, id, rs));
assert.equal(new Set(groups.flatMap(g => [...g])).size, avs.length, 'the source groups together cover every AVS preset');
for (const key of tree.byKey.keys()) assert.ok(key.length <= 400 && !key.includes('_staging'), `folder key without a staging path: ${key}`);
for (const node of tree.nodes) assert.ok(!node.label.includes('_staging'), 'no label shows a staging path');
// Rows are stable and the whole thing is deterministic: a second build over the same data gives the same keys in the same order.
const again = buildFolderTree(catalog, { sources });
assert.deepEqual([...again.byKey.keys()], [...tree.byKey.keys()], 'keys are identical across builds');
// A real search inside the real tree: an artist's whole subtree answers to the artist's name.
const artist = tree.nodes.find(n => n.kind === 'artist');
if (artist) {
  const members = folderMembers(tree, artist.id, rs);
  const found = runQuery(rs, parseQuery(`artist:${artist.label}`), null).ids;
  const inside = new Set(members);
  assert.ok(found.length >= members.length, 'an artist search finds the artist folder');
  for (const i of members) assert.ok(found.includes(i), 'every member of the artist folder is found by the artist search');
  assert.ok(inside.size > 0);
}
assert.ok(treeRows(tree, new Set(['avs', 'avs/src']), null, rs).length > 5, 'the tree lists rows');

console.log(`Full MPC catalog PASS: ${catalog.length} entries, all files/hash/size verified. ${catalog.filter(p => p.parserStatus === 'parse-error').length} recorded parser failures remain included. Provenance: ${withOrigins} entries with origins, ${sources.size} sources, ${tree.nodes.length} folder nodes, AVS root ${avs.length}, no staging path kept.`);
