import assert from 'node:assert/strict';
import {mulberry32, syntheticCatalog, syntheticTaxa, loadBrowser, PACK_LABELS} from './fixtures-folders.mjs';
// The virtual folder tree of the Preset Browser (docs/design/PRESET-BROWSER-V2.md 4, 12). CPU only: pure modules bundled with esbuild,
// fed by a deterministic synthetic catalog. Nothing here reads the private collection, a browser or a network.
const B = await loadBrowser();
const {buildFolderTree, withUserFolders, folderMembers, directMembers, treeRows, locate, pathLabels, ancestorKeys, defaultLabelFor, hudPlatform, splitHudHint, letterOf,
  manualOrder, sharedTitle, buildRecords, updateRecord, parseLocalAvsCatalog, parseLocalAvsSources, BUCKET_ABOVE, FAVORITE_MINIMUM, UNCLASSIFIED_TAXON, emptyStats, HUD_PACK_LABELS} = B;
const BASE = 'https://aaavs.invalid/mpc.html';
const H = n => n.toString(16).padStart(64, '0');
const sortNum = a => [...a].sort((x, y) => x - y);
const same = (a, b, message) => assert.deepEqual(sortNum(a), sortNum(b), message);

/** One catalog row with the exact JSON shape of presets.json. `occ` is a list of [package id, archive-relative path]. */
function row(i, name, occ = [], extra = {}) {
  return {sha256: H(i), bytes: 100 + i, canonical_path: `presets/unique/${H(i).slice(0, 16)}---${name}.avs`, display_name: name,
    occurrences: occ.map(([pkg, path]) => ({package_id: pkg, path: `_staging/packages/${pkg}/${path}`, original_path: path})), ...extra};
}
const parse = rows => parseLocalAvsCatalog({presets: rows}, {results: rows.map(r => ({sha256: r.sha256, status: r.parse ?? 'lossless'}))}, BASE);
const build = (rows, inputs = {}) => { const catalog = parse(rows); const tree = buildFolderTree(catalog, inputs); return {catalog, tree, rs: buildRecords(catalog, tree, inputs.taxa ?? null)}; };
const node = (tree, key) => { const id = tree.byKey.get(key); assert.notEqual(id, undefined, `node ${key}`); return tree.nodes[id]; };
const has = (tree, key) => tree.byKey.has(key);
const labelsUnder = (tree, key) => node(tree, key).children.map(c => tree.nodes[c].label);
function brute(tree, id) {
  const out = new Set();
  const walk = n => { const x = tree.nodes[n]; if (x.def) return; for (const i of x.direct) out.add(i); x.children.forEach(walk); };
  walk(id);
  return [...out];
}

// ---------------------------------------------------------------------------------------------------- synthetic estate
const fx = syntheticCatalog(4000, 1);
const catalog = parseLocalAvsCatalog(fx.catalogJson, fx.validationJson, BASE);
const sources = parseLocalAvsSources(fx.sourcesJson);
const taxa = new Map(syntheticTaxa(fx.catalogJson));
const avs = catalog.map((p, i) => i).filter(i => catalog[i].kind === 'avs');
const nerv = catalog.map((p, i) => i).filter(i => catalog[i].kind === 'nerv');
const hud = catalog.map((p, i) => i).filter(i => catalog[i].kind === 'hud');
assert.equal(avs.length, 4000); assert.equal(nerv.length, 16); assert.equal(hud.length, 400);
const tree = buildFolderTree(catalog, {sources, taxa});
const rs = buildRecords(catalog, tree, taxa);

// The AVS root counts unique AVS entries, computed from the catalog and not by summing facets.
assert.deepEqual(tree.roots.map(r => tree.nodes[r].key), ['avs', 'nerv', 'hud', 'smart', 'user']);
same(folderMembers(tree, tree.byKey.get('avs'), rs), avs, 'AVS root is exactly the AVS entries');
same(folderMembers(tree, tree.byKey.get('nerv'), rs), nerv, 'NERV root');
same(folderMembers(tree, tree.byKey.get('hud'), rs), hud, 'HUD root');
// Every AVS preset sits directly in at least one source folder, and every one of those folders lists it.
for (const i of avs) {
  assert.ok(tree.locations[i].length >= 1, `preset ${i} has a location`);
  for (const id of tree.locations[i]) assert.ok(tree.nodes[id].direct.includes(i), 'the location lists the preset');
  assert.ok(tree.primary[i] >= 0 && tree.locations[i].includes(tree.primary[i]), 'the primary location is one of the locations');
  assert.equal(tree.nodes[tree.primary[i]].direct.includes(i), true);
}
// A preset in several packages is a direct member of each folder and counted once at every ancestor: union == brute force, everywhere.
let multi = 0;
for (const i of avs) if (tree.locations[i].length > 1) multi++;
assert.ok(multi > 100, `the fixture has multi-package presets (${multi})`);
let checked = 0;
for (const n of tree.nodes) {
  if (n.dynamic) continue;
  const got = folderMembers(tree, n.id, rs);
  same(got, brute(tree, n.id), `union of ${n.key}`);
  assert.equal(new Set(got).size, got.length, `${n.key} lists each preset once`);
  for (let k = 1; k < got.length; k++) assert.ok(got[k - 1] < got[k], `${n.key} is ascending`);
  checked++;
}
assert.ok(checked > 1000);
// The largest direct folder stays modest and the deepest chain is bounded (the local estate: depth 8, 40 children).
const depth = id => { let d = 0; for (let at = id; tree.nodes[at].parent >= 0; at = tree.nodes[at].parent) d++; return d; };
assert.ok(Math.max(...tree.nodes.map(n => depth(n.id))) <= 10);

// ---------------------------------------------------------------------------------------------------- keys
const keys = tree.nodes.map(n => n.key);
assert.equal(new Set(keys).size, keys.length, 'keys are unique');
assert.equal(tree.byKey.size, keys.length);
for (const k of keys) {
  assert.ok(k.length <= 400, 'key length');
  assert.ok(!/staging|packages\//i.test(k), `no staging path in key ${k}`);
  assert.ok(/^(avs|nerv|hud|smart|user)(\/|:|$)/.test(k), `key starts with a known root: ${k}`);
}
for (const n of tree.nodes) assert.ok(!/staging/i.test(n.label), 'no staging path in a label');
for (const p of catalog) for (const o of p.origins ?? []) assert.ok(!('path' in o && /_staging/.test(o.path)), 'origins never keep the staging path');
// Keys derive from data only: same across two builds, and across a shuffled catalog order (membership by hash too).
{
  const again = buildFolderTree(catalog, {sources, taxa});
  assert.deepEqual(again.nodes.map(n => n.key), keys, 'identical across builds');
  const rand = mulberry32(99), shuffled = [...catalog];
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  const t2 = buildFolderTree(shuffled, {sources, taxa}), r2 = buildRecords(shuffled, t2, taxa);
  assert.deepEqual([...t2.byKey.keys()].sort(), [...tree.byKey.keys()].sort(), 'same key set for a shuffled catalog');
  for (const key of ['avs/src', 'avs', 'hud', 'nerv', 'avs/energy/calm', 'avs/rating/0']) {
    const a = [...folderMembers(tree, tree.byKey.get(key), rs)].map(i => catalog[i].sha256).sort();
    const b = [...folderMembers(t2, t2.byKey.get(key), r2)].map(i => shuffled[i].sha256).sort();
    assert.deepEqual(b, a, `same members of ${key} for a shuffled catalog`);
  }
  for (const n of t2.nodes) if (!n.def && n.kind !== 'user') {
    const other = node(tree, n.key);
    assert.deepEqual([...n.direct].map(i => shuffled[i].sha256).sort(), [...other.direct].map(i => catalog[i].sha256).sort(), `direct members of ${n.key}`);
    assert.equal(n.label, other.label, `label of ${n.key}`);
  }
}

// ---------------------------------------------------------------------------------------------------- primary location
{
  const S = (id, catalogName) => ({id, catalog: catalogName});
  const pk = (group, name) => `${group}-${name}-0123456789`;
  const srcMap = parseLocalAvsSources({sources: [S(pk('github', 'g'), 'github'), S(pk('visbot-legacy', 'v'), 'visbot-legacy'), S(pk('visbot-current', 'c'), 'visbot-current'), S(pk('local-existing', 'l'), 'local-existing')]});
  const P = (group, name) => pk(group, name);
  // a) group rank: the Visbot archive beats GitHub even when GitHub is listed first.
  const a = build([row(1, 'A', [[P('github', 'g'), 'main/x/A.avs'], [P('visbot-legacy', 'v'), 'main/x/A.avs']])], {sources: srcMap});
  assert.equal(a.tree.nodes[a.tree.primary[0]].key.includes('c:visbot-legacy'), true, 'group rank beats occurrence order');
  const where = locate(a.tree, 0);
  assert.equal(where.others.length, 1, 'one other location'); assert.ok(a.tree.nodes[where.others[0]].key.includes('c:github'));
  // b) unwrapped beats `_nested` inside one group.
  const b = build([row(1, 'B', [[P('visbot-legacy', 'v'), '_nested/0123456789ab/Pack/B.avs'], [P('visbot-current', 'c'), 'z.avs']])], {sources: srcMap});
  assert.ok(b.tree.nodes[b.tree.primary[0]].key.includes('c:visbot-legacy'), 'a lower group rank wins first');
  const b2 = build([row(1, 'B2', [[P('visbot-legacy', 'v'), '_nested/0123456789ab/Pack/B2.avs'], [P('visbot-legacy', 'w'), 'Pack/B2.avs']]),
    row(2, 'Other', [[P('visbot-legacy', 'w'), 'Pack/Other.avs']])]);
  assert.ok(b2.tree.nodes[b2.tree.primary[0]].key.includes(`p:${P('visbot-legacy', 'w')}`), 'not nested beats nested in the same group');
  // c) shallower beats deeper, then occurrence order.
  const c = build([row(1, 'C', [[P('visbot-legacy', 'v'), 'Pack/a/b/C.avs'], [P('visbot-legacy', 'w'), 'Pack/C.avs']]), row(2, 'Q', [[P('visbot-legacy', 'w'), 'Pack/Q.avs']])]);
  assert.ok(c.tree.nodes[c.tree.primary[0]].key.includes(`p:${P('visbot-legacy', 'w')}`), 'depth breaks the tie');
  const d = build([row(1, 'D', [[P('visbot-legacy', 'v'), 'Pack/D.avs'], [P('visbot-legacy', 'w'), 'Pack/D.avs']]), row(2, 'Q', [[P('visbot-legacy', 'w'), 'Pack/Q.avs']])]);
  assert.ok(d.tree.nodes[d.tree.primary[0]].key.includes(`p:${P('visbot-legacy', 'v')}`), 'occurrence order is the last tie-break');
  assert.equal(pathLabels(d.tree, d.tree.primary[0]).at(0), 'AVS', 'path labels lead with the root');
  // e) local picks rank after GitHub.
  const e = build([row(1, 'E', [[P('local-existing', 'l'), 'E.avs'], [P('github', 'g'), 'r/E.avs']])], {sources: srcMap});
  assert.ok(e.tree.nodes[e.tree.primary[0]].key.includes('c:github'));
}

// ---------------------------------------------------------------------------------------------------- source tree: nested, wrappers, labels, artists
{
  const pkg = name => `visbot-legacy-${name}-aabbccddee`;
  const sourcesMap = parseLocalAvsSources({sources: [
    {id: pkg('wrap'), catalog: 'visbot-legacy', file_name: 'wrapped-pack-unofficial.7z', artist_slug: 'ann'},
    {id: pkg('flat'), catalog: 'visbot-legacy', file_name: 'flatpack.zip', artist_slug: 'ann'},
    {id: 'github-org-repo-1122334455', catalog: 'github', repository: 'org/repo'},
    {id: 'visbot-current-r1-1122334455', catalog: 'visbot-current', release_id: 'rel-7'},
  ]});
  const rows = [
    row(1, 'W1', [[pkg('wrap'), 'Wrapped/one/W1.avs']]), row(2, 'W2', [[pkg('wrap'), 'Wrapped/W2.avs']]),
    row(3, 'F1', [[pkg('flat'), 'F1.avs']]), row(4, 'F2', [[pkg('flat'), 'sub/F2.avs']]),
    row(5, 'N1', [[pkg('wrap'), '_nested/0123456789ab/Wrapped/n/N1.avs']]),
    row(6, 'G1', [['github-org-repo-1122334455', 'deep/er/G1.avs']]), row(7, 'R1', [['visbot-current-r1-1122334455', 'Rel/R1.avs']]),
    row(8, 'NoOrigin', []), row(9, 'Curated', [], {folder: 'Collections/Set A'}), row(10, 'Unknown', [['weird-package-id-0000000000', 'x/U.avs']]),
  ];
  const {tree: t, rs: r} = build(rows, {sources: sourcesMap});
  // The wrapper directory is the package node; the sub-path follows it. `_nested/<hex>` never shows.
  const wrapped = node(t, `avs/src/c:visbot-legacy/a:ann/p:${pkg('wrap')}`);
  assert.equal(wrapped.label, 'Wrapped', 'a package that wraps everything in one directory is named by it');
  assert.deepEqual(sortNum([...wrapped.direct]), [1], 'W2 sits directly in the wrapper (index 1)');
  assert.deepEqual(labelsUnder(t, wrapped.key).sort(), ['n', 'one']);
  const flat = node(t, `avs/src/c:visbot-legacy/a:ann/p:${pkg('flat')}`);
  assert.equal(flat.label, 'flatpack', 'a package with root files is named by its archive file stem');
  assert.deepEqual(labelsUnder(t, flat.key), ['sub']);
  assert.ok(![...t.byKey.keys()].some(k => k.includes('_nested')), 'no _nested segment in any key');
  same(directMembers(t, t.byKey.get(`${wrapped.key}/n`), r), [4], 'nested file lands in the plain sub-folder');
  // Artist level: artist_slug, else repository, else release id; omitted when unknown.
  assert.equal(node(t, 'avs/src/c:github/a:org|repo').label, 'org/repo');
  assert.equal(node(t, 'avs/src/c:visbot-current/a:rel-7').label, 'rel-7');
  assert.ok(has(t, 'avs/src/c:other'), 'an unknown package prefix goes to Other sources');
  assert.equal(node(t, 'avs/src/c:other').label, 'Other sources');
  assert.equal(node(t, 'avs/src').children.map(c => t.nodes[c].label).join(','), 'Visbot archive,Visbot releases,GitHub,Other sources,Collections,Unsorted');
  same(directMembers(t, t.byKey.get('avs/src/unsorted'), r), [7], 'no origin and no hint: Unsorted');
  same(folderMembers(t, t.byKey.get('avs/src/h:Collections'), r), [8], 'an explicit folder hint wins');
  assert.equal(node(t, 'avs/src/h:Collections/Set A').label, 'Set A');
  // Sibling label collisions get a short id suffix.
  const twin = build([row(1, 'T1', [['visbot-legacy-same-00000000aa', 'Same/T1.avs']]), row(2, 'T2', [['visbot-legacy-same-00000000bb', 'Same/T2.avs']])]);
  const groupKids = labelsUnder(twin.tree, 'avs/src/c:visbot-legacy');
  assert.equal(groupKids.length, 2); assert.equal(new Set(groupKids).size, 2, 'colliding package labels are made distinct');
  assert.ok(groupKids.every(l => / · [0-9a-f]{4}$/.test(l)), groupKids.join());
  // Without any sources file the tree still forms (public and stock builds): no artist level, group from the id prefix.
  const noSources = build(rows.slice(0, 5));
  assert.ok(has(noSources.tree, `avs/src/c:visbot-legacy/p:${pkg('wrap')}`), 'no sources: package directly under the group');
}

// ---------------------------------------------------------------------------------------------------- display collapse
{
  const pkg = 'github-solo-1122334455';
  const {tree: t, rs: r} = build([row(1, 'S1', [[pkg, 'Wrap/deeper/S1.avs']]), row(2, 'S2', [['visbot-legacy-x-0000000001', 'a.avs']]), row(3, 'S3', [['visbot-legacy-x-0000000001', 'b/c.avs']])],
    {sources: parseLocalAvsSources([{id: pkg, catalog: 'github', repository: 'org/solo'}])});
  const expanded = new Set(['avs', 'avs/src']);
  const rows = treeRows(t, expanded, null, r);
  const gh = rows.find(x => x.label.startsWith('GitHub'));
  assert.equal(gh.label, 'GitHub > org/solo > Wrap > deeper', 'a chain of single children is drawn merged');
  assert.equal(gh.key, `avs/src/c:github/a:org|solo/p:${pkg}/deeper`, 'the merged row carries the bottom node key');
  assert.equal(gh.count, 1); assert.equal(gh.expanded, null, 'a leaf row has no expander');
  assert.equal(gh.depth, 2);
  const legacy = rows.find(x => x.label === 'Visbot archive > x'); assert.equal(legacy.expanded, false, 'a merged row with a sub-folder is collapsible');
  assert.equal(legacy.key, 'avs/src/c:visbot-legacy/p:visbot-legacy-x-0000000001', 'a single-child group merges with its package');
  // Expansion attaches to the bottom key: expanding the merged row's key opens exactly its subtree.
  const wide = treeRows(t, new Set([...expanded, `avs/src/c:visbot-legacy/p:visbot-legacy-x-0000000001`]), null, r);
  assert.ok(wide.some(x => x.key.endsWith('/b') || x.label === 'b'));
  // The playing marker follows any key of the merged chain (top, middle or bottom).
  for (const key of ['avs/src/c:github', `avs/src/c:github/a:org|solo/p:${pkg}`, gh.key]) assert.equal(treeRows(t, expanded, key, r).find(x => x.label.startsWith('GitHub')).playing, true, key);
  assert.equal(treeRows(t, expanded, null, r).some(x => x.playing), false);
  assert.equal(treeRows(t, expanded, 'avs/src/c:github', r).filter(x => x.playing).length, 1);
  // Collapsed parents hide children.
  assert.ok(treeRows(t, new Set(), null, r).every(x => x.depth === 0), 'nothing expanded: only roots');
  assert.deepEqual(ancestorKeys(t, gh.key).slice(0, 2), ['avs', 'avs/src']);
  assert.ok(ancestorKeys(t, gh.key).includes('avs/src/c:github/a:org|solo'));
}

// ---------------------------------------------------------------------------------------------------- letter buckets
{
  const many = (n, letters) => Array.from({length: n}, (_, k) => row(k + 1, `P${k}`, [['visbot-legacy-big-0123456789', `${letters[k % letters.length]}${String(k).padStart(3, '0')}/file${k}.avs`]]));
  const at = n => build(many(n, 'abcdefghijklmnopqrstuvwxyz'.split('')));
  const packageKey = 'avs/src/c:visbot-legacy/p:visbot-legacy-big-0123456789';
  const flat = at(BUCKET_ABOVE);
  assert.ok(node(flat.tree, packageKey).children.every(c => flat.tree.nodes[c].kind === 'dir'), `${BUCKET_ABOVE} children: no buckets`);
  const wide = at(BUCKET_ABOVE + 1);
  const pk = node(wide.tree, packageKey);
  assert.ok(pk.children.every(c => wide.tree.nodes[c].kind === 'bucket'), 'above 60 children they sit in letter buckets');
  assert.ok(pk.children.length >= 3);
  const bucket = wide.tree.nodes[pk.children[0]];
  assert.equal(bucket.key, `${packageKey}/#${bucket.label}`);
  const moved = wide.tree.nodes[bucket.children[0]];
  assert.equal(moved.key, `${packageKey}/${moved.label}`, 'the key of a moved child does not change');
  assert.equal(moved.parent, bucket.id);
  assert.equal(folderMembers(wide.tree, pk.id, wide.rs).length, BUCKET_ABOVE + 1, 'buckets lose nothing');
  // Fewer than three distinct first-letter groups: no buckets, however wide.
  const narrow = build(many(BUCKET_ABOVE + 5, ['a', 'b']));
  assert.ok(node(narrow.tree, packageKey).children.every(c => narrow.tree.nodes[c].kind === 'dir'), 'two letter groups never make buckets');
  // Digits share one bucket, and letterOf folds accents.
  assert.equal(letterOf('9 lives'), '0-9'); assert.equal(letterOf('Éclair'), 'E'); assert.equal(letterOf('!!'), '#'); assert.equal(letterOf(''), '#');
  const mixed = build(many(BUCKET_ABOVE + 1, '0123456789abc'.split('')));
  assert.ok(node(mixed.tree, packageKey).children.some(c => mixed.tree.nodes[c].label === '0-9'));
}

// ---------------------------------------------------------------------------------------------------- HUD packs (owner directive B)
{
  const hudRoot = node(tree, 'hud');
  assert.equal(hudRoot.label, 'HUD packs');
  assert.deepEqual(hudRoot.children.map(c => tree.nodes[c].label), [...HUD_PACK_LABELS], 'the 16 packs in browser order');
  assert.deepEqual([...HUD_PACK_LABELS], PACK_LABELS, 'the fixture uses the same 16 labels');
  assert.equal(HUD_PACK_LABELS.length, 16);
  for (const label of HUD_PACK_LABELS) if (/[^\x20-\x7e]/.test(label)) assert.equal(label.replace(/[^\x20-\x7e]/g, ''), label.replace('·', ''), 'U+00B7 is the only non-ASCII character');
  // Pack labels containing "/" stay one segment; the key escapes the slash.
  const slashPack = node(tree, 'hud/8|16-bit Consoles');
  assert.equal(slashPack.label, '8/16-bit Consoles'); assert.equal(slashPack.kind, 'platform');
  assert.equal(splitHudHint('8/16-bit Consoles/Some Title').join('>'), '8/16-bit Consoles>Some Title');
  assert.equal(splitHudHint('Neo Geo/Kit').join('>'), 'Neo Geo>Kit');
  assert.equal(splitHudHint('neogeo/Kit').join('>'), 'Neo Geo>Kit', 'a slug form maps to the canonical label');
  assert.equal(splitHudHint('Unknown Pack/Kit').join('>'), 'Unknown Pack>Kit');
  // Every HUD scene is under exactly one pack; each pack holds its scenes; the folder hint '<pack label>/<title>' is honoured.
  const neo = node(tree, 'hud/Neo Geo');
  assert.equal(folderMembers(tree, neo.id, rs).length, 150);
  const titleDirs = neo.children.map(c => tree.nodes[c]);
  assert.ok(titleDirs.every(c => c.kind === 'bucket'), '75 title folders (> 60) get alphabetic sub-buckets');
  const bucketed = tree.nodes[titleDirs[0].children[0]];
  assert.equal(bucketed.kind, 'dir'); assert.ok(bucketed.key.startsWith('hud/Neo Geo/'), bucketed.key);
  assert.equal(bucketed.key, `hud/Neo Geo/${bucketed.label}`, 'moved title folders keep their key');
  assert.ok(bucketed.direct.length >= 1);
  const small = node(tree, 'hud/Rhythm');
  assert.ok(small.children.every(c => tree.nodes[c].kind === 'dir'), 'a pack under 60 has no buckets');
  for (const i of hud) {
    assert.equal(tree.locations[i].length, 1, 'a HUD scene has one location'); assert.equal(tree.primary[i], tree.locations[i][0]);
    const path = pathLabels(tree, tree.primary[i]);
    assert.equal(path[0], 'HUD packs'); assert.ok(HUD_PACK_LABELS.includes(path[1]) || path[1] === 'Modern', path[1]);
  }
  // The fallback (no folder hint) derives the pack from `hud.pack`, in label or slug form.
  const noHint = hud.filter(i => !catalog[i].folder);
  assert.ok(noHint.length >= 1);
  for (const i of noHint) assert.ok(HUD_PACK_LABELS.includes(pathLabels(tree, tree.primary[i])[1]));
  // More than 60 direct scenes in one pack: bucketed by leaf name. Unknown packs sort after the 16 known ones.
  const leaves = Array.from({length: 130}, (_, k) => ({...fx.catalogJson.presets.find(p => p.kind === 'hud'), sha256: H(5000 + k), display_name: `${'ABCDEFGHIJ'[k % 10]} scene ${k}`,
    canonical_path: `presets/unique/${H(5000 + k).slice(0, 16)}---s${k}.hud`, folder: k < 120 ? 'Modern' : 'Brand New Pack/Title', hud: {...fx.catalogJson.presets.find(p => p.kind === 'hud').hud, id: `direct-${k}`}}));
  const lt = build(leaves);
  const modern = node(lt.tree, 'hud/Modern');
  assert.ok(modern.children.length >= 3 && modern.children.every(c => lt.tree.nodes[c].kind === 'bucket'), 'more than 60 direct leaves: alphabetic buckets');
  assert.equal(modern.direct.length, 0, 'the leaves moved into their buckets');
  assert.equal(folderMembers(lt.tree, modern.id, lt.rs).length, 120);
  assert.equal(labelsUnder(lt.tree, 'hud').at(-1), 'Brand New Pack', 'an unknown pack label sorts after the known ones');
  // Local title overlay: a folder holding one scene (or scenes sharing one title) is named by the owner's title; keys stay neutral.
  const one = leaves[0];
  const withTitles = buildFolderTree(parse([{...one, folder: 'Rhythm/Neutral Kit', hud: {...one.hud, id: 'zz-1'}}, {...leaves[1], folder: 'Rhythm/Shared Kit', hud: {...leaves[1].hud, id: 'zz-2'}},
    {...leaves[2], folder: 'Rhythm/Shared Kit', hud: {...leaves[2].hud, id: 'zz-3'}}, {...leaves[3], folder: 'Rhythm/Mixed Kit', hud: {...leaves[3].hud, id: 'zz-4'}}, {...leaves[4], folder: 'Rhythm/Mixed Kit', hud: {...leaves[4].hud, id: 'zz-5'}}]),
    {titles: new Map([['zz-1', 'Local Title One'], ['zz-2', 'Local Shared'], ['zz-3', 'Local Shared'], ['zz-4', 'Only Four']])});
  assert.equal(node(withTitles, 'hud/Rhythm/Neutral Kit').label, 'Local Title One'); assert.ok(has(withTitles, 'hud/Rhythm/Neutral Kit'), 'the key keeps the neutral name');
  assert.equal(node(withTitles, 'hud/Rhythm/Shared Kit').label, 'Local Shared');
  assert.equal(node(withTitles, 'hud/Rhythm/Mixed Kit').label, 'Mixed Kit', 'a folder with an untitled scene keeps its neutral name');
  const plain = buildFolderTree(parse([one]), {});
  assert.ok(!JSON.stringify([...plain.byKey.keys()]).includes('Local'));
  // The overlay reaches rows through the records, for HUD rows only.
  const titled = parse([{...one, hud: {...one.hud, id: 'zz-9'}}, row(9000, 'Zz Plain', [['visbot-legacy-a-0000000000', 'a.avs']])]);
  const tt = buildFolderTree(titled, {}), trs = buildRecords(titled, tt, null, null, undefined, new Map([['zz-9', 'Overlay Name'], ['x', 'never used']]));
  assert.equal(trs.display[0], 'Overlay Name'); assert.equal(trs.display[1], 'Zz Plain');
  assert.ok(trs.nameKey[0].includes('overlay'));
  assert.ok(trs.pathKey[0].includes(titled[0].name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')), 'the neutral public name stays searchable');
  const noTitles = buildRecords(titled, tt, null); assert.equal(noTitles.display[0], titled[0].name, 'no overlay: the neutral public name');
  // Composite titles name their folder by the shared leading part; scenes that share a title read `Title / name` in the list.
  assert.equal(sharedTitle(['Game']), 'Game'); assert.equal(sharedTitle(['Game', 'Game']), 'Game'); assert.equal(sharedTitle([]), null); assert.equal(sharedTitle(['']), null);
  assert.equal(sharedTitle(['Game / Health', 'Game / Timer']), 'Game'); assert.equal(sharedTitle(['Game - Health', 'Game - Timer']), 'Game'); assert.equal(sharedTitle(['Game: One', 'Game: Two']), 'Game');
  assert.equal(sharedTitle(['Game · One', 'Game · Two']), 'Game'); assert.equal(sharedTitle(['Game – One', 'Game — Two']), null, 'different separators share nothing');
  assert.equal(sharedTitle(['Alpha', 'Beta']), null); assert.equal(sharedTitle(['A / One', 'A / Two']), null, 'a one-character lead is not a title');
  assert.equal(sharedTitle(['Game / Health', 'Game2 / Timer']), null); assert.equal(sharedTitle(['Game / Health', 'Game']), null);
  assert.equal(sharedTitle(['Game - Part - One', 'Game - Part - Two']), 'Game - Part', 'the longest shared lead');
  const composite = buildFolderTree(parse([{...leaves[0], folder: 'Rhythm/Composite Kit', hud: {...leaves[0].hud, id: 'cc-1'}}, {...leaves[1], folder: 'Rhythm/Composite Kit', hud: {...leaves[1].hud, id: 'cc-2'}}]),
    {titles: new Map([['cc-1', 'Some Game / Health'], ['cc-2', 'Some Game / Timer']])});
  assert.equal(node(composite, 'hud/Rhythm/Composite Kit').label, 'Some Game', 'a composite title names the folder by its lead');
  const dupRows = parse([{...leaves[0], folder: 'Rhythm/Dup Kit', hud: {...leaves[0].hud, id: 'dd-1'}}, {...leaves[1], folder: 'Rhythm/Dup Kit', hud: {...leaves[1].hud, id: 'dd-2'}}, {...leaves[2], folder: 'Rhythm/Solo Kit', hud: {...leaves[2].hud, id: 'dd-3'}}]);
  const dupTree = buildFolderTree(dupRows, {}), dupRs = buildRecords(dupRows, dupTree, null, null, undefined, new Map([['dd-1', 'Twin Title'], ['dd-2', 'Twin Title'], ['dd-3', 'Solo Title']]));
  assert.deepEqual([dupRs.display[0], dupRs.display[1], dupRs.display[2]], [`Twin Title / ${dupRows[0].name}`, `Twin Title / ${dupRows[1].name}`, 'Solo Title'], 'shared titles stay distinguishable; a unique title stands alone');
  assert.ok(dupRs.nameKey[0] !== dupRs.nameKey[1], 'and sort apart');
  // hudPlatform: the trailing kit-id token, else Other.
  assert.equal(hudPlatform('some-game-neogeo'), 'Neo Geo'); assert.equal(hudPlatform('kit-arcade'), 'Arcade'); assert.equal(hudPlatform('kit-ps1'), 'PlayStation');
  assert.equal(hudPlatform('mystery'), 'Other'); assert.equal(hudPlatform(''), 'Other');
  // Defaults follow the folder: a node under a HUD pack maps to the pack's label; the root to "HUD packs"; NERV to "NERV".
  assert.equal(defaultLabelFor(tree, neo.id), 'Neo Geo'); assert.equal(defaultLabelFor(tree, bucketed.id), 'Neo Geo'); assert.equal(defaultLabelFor(tree, slashPack.id), '8/16-bit Consoles');
  assert.equal(defaultLabelFor(tree, hudRoot.id), 'HUD packs'); assert.equal(defaultLabelFor(tree, tree.byKey.get('nerv')), 'NERV'); assert.equal(defaultLabelFor(tree, tree.byKey.get('avs')), null);
}

// ---------------------------------------------------------------------------------------------------- NERV and roots
{
  same(directMembers(tree, tree.byKey.get('nerv'), rs), nerv, 'NERV is flat');
  const only = build([fx.catalogJson.presets.find(p => p.kind === 'nerv')]);
  assert.deepEqual(only.tree.roots.map(r => only.tree.nodes[r].key), ['nerv', 'smart', 'user'], 'AVS and HUD roots are hidden when empty');
  const avsOnly = build([row(1, 'Only', [['visbot-legacy-a-0000000000', 'a.avs']])]);
  assert.deepEqual(avsOnly.tree.roots.map(r => avsOnly.tree.nodes[r].key), ['avs', 'smart', 'user']);
  const empty = buildFolderTree([], {});
  assert.deepEqual(empty.roots.map(r => empty.nodes[r].key), ['smart', 'user'], 'an empty catalog still has the smart and user roots');
  // A NERV entry with a folder hint sits under it.
  const hinted = build([{...fx.catalogJson.presets.find(p => p.kind === 'nerv'), folder: 'Scenes/Set A'}]);
  same(directMembers(hinted.tree, hinted.tree.byKey.get('nerv/Scenes/Set A'), hinted.rs), [0]);
}

// ---------------------------------------------------------------------------------------------------- smart folders
{
  const rows = Array.from({length: 40}, (_, k) => row(k + 1, `Preset ${k}`, [['visbot-legacy-a-0000000000', `d${k % 3}/p${k}.avs`]], {
    ...(k % 3 === 0 ? {} : {rating: (k % 5) + 1}), ...(k % 7 === 0 ? {notWorking: true} : {}), ...(k % 11 === 0 ? {parse: 'parse-error'} : {})}));
  const {catalog: c, tree: t, rs: r} = build(rows);
  const failed = new Set([5, 6]);
  const r2 = buildRecords(c, t, null, null, failed);
  const smart = (name, records = r2) => sortNum(folderMembers(t, t.byKey.get(`smart:${name}`), records));
  const pick = predicate => c.map((p, i) => i).filter(i => predicate(c[i], i));
  assert.deepEqual(smart('favorites'), pick(p => (p.rating ?? 0) >= FAVORITE_MINIMUM), 'favorites: 4+ stars');
  assert.equal(FAVORITE_MINIMUM, 4);
  assert.deepEqual(smart('rated'), pick(p => (p.rating ?? 0) >= 1));
  assert.deepEqual(smart('unrated'), pick(p => (p.rating ?? 0) === 0));
  assert.deepEqual(smart('broken'), pick(p => p.notWorking));
  assert.deepEqual(smart('unavailable'), pick((p, i) => p.parserStatus === 'parse-error' || failed.has(i)), 'unavailable: parse errors and session failures');
  assert.deepEqual(smart('recent'), []); assert.deepEqual(smart('most-played'), []);
  // Rating facets are live: a rating change patches the record and the memoised members follow.
  const before = sortNum(folderMembers(t, t.byKey.get('avs/rating/5'), r2));
  const target = c.findIndex(p => (p.rating ?? 0) === 0);
  updateRecord(r2, target, {...c[target], rating: 5});
  const after = sortNum(folderMembers(t, t.byKey.get('avs/rating/5'), r2));
  assert.deepEqual(after, sortNum([...before, target]), 'a rating change moves the preset between rating folders');
  assert.ok(!folderMembers(t, t.byKey.get('avs/rating/0'), r2).includes(target));
  assert.ok(folderMembers(t, t.byKey.get('smart:favorites'), r2).includes(target), 'and into Favorites');
  updateRecord(r2, target, {...c[target], rating: 0, notWorking: true});
  assert.ok(folderMembers(t, t.byKey.get('smart:broken'), r2).includes(target));
  // Rows hide empty rating facets and the rarely used smart folders while they hold nothing.
  const rows2 = treeRows(t, new Set(['avs', 'smart']), null, r2);
  assert.ok(rows2.some(x => x.label === 'By rating'));
  assert.ok(!rows2.some(x => x.label === 'Recently played'), 'an empty recent folder is hidden');
  assert.ok(rows2.some(x => x.label === 'Favorites'), 'Favorites is always listed');
  // Play statistics feed recent and most played. Recent = played within 30 days.
  const stats = emptyStats(), now = Date.now();
  stats.plays.set(c[1].sha256, [3, now - 5 * 86400000]); stats.plays.set(c[2].sha256, [9, now - 40 * 86400000]);
  const r3 = buildRecords(c, t, null, stats);
  assert.deepEqual(smart('recent', r3), [1]); assert.deepEqual(smart('most-played', r3), [1, 2]);
  assert.ok(treeRows(t, new Set(['smart']), null, r3).some(x => x.label === 'Recently played'));
  // Smart folders span every kind: a NERV entry with a rating is Rated.
  const both = build([row(1, 'A', [['visbot-legacy-a-0000000000', 'a.avs']], {rating: 4}), {...fx.catalogJson.presets.find(p => p.kind === 'nerv'), rating: 5}]);
  assert.deepEqual(sortNum(folderMembers(both.tree, both.tree.byKey.get('smart:rated'), both.rs)), [0, 1]);
  assert.deepEqual(sortNum(folderMembers(both.tree, both.tree.byKey.get('avs/rating/5'), both.rs)), [], 'rating facets are AVS only');
}

// ---------------------------------------------------------------------------------------------------- facets from the taxonomy
{
  assert.ok(has(tree, 'avs/style') && has(tree, 'avs/energy') && has(tree, 'avs/busy') && has(tree, 'avs/author'));
  const classified = avs.filter(i => taxa.has(catalog[i].sha256));
  for (const e of ['calm', 'steady', 'driving', 'intense']) {
    same(folderMembers(tree, tree.byKey.get(`avs/energy/${e}`), rs), classified.filter(i => taxa.get(catalog[i].sha256).e === e), `energy ${e}`);
  }
  for (let v = 1; v <= 5; v++) same(folderMembers(tree, tree.byKey.get(`avs/busy/${v}`), rs), classified.filter(i => taxa.get(catalog[i].sha256).b === v), `busyness ${v}`);
  const style = node(tree, 'avs/style');
  const families = style.children.map(c => tree.nodes[c]).filter(x => x.key !== 'avs/style/unclassified');
  assert.ok(families.length >= 3 && families.every(x => x.kind === 'facet'));
  same(folderMembers(tree, style.id, rs), avs, 'By style lists every AVS preset once (classified plus unclassified)');
  same(folderMembers(tree, tree.byKey.get('avs/style/unclassified'), rs), avs.filter(i => !taxa.has(catalog[i].sha256)));
  const cat = node(tree, 'avs/style/scopes/scope-classic');
  assert.equal(cat.label, 'Waveforms & Oscilloscopes'); assert.equal(tree.nodes[cat.parent].label, 'Scopes');
  // A neutral placeholder taxon (the joined map's filler for unclassified presets) adds no energy, busyness or author entry.
  const joined = new Map(catalog.map(p => [p.sha256, taxa.get(p.sha256) ?? UNCLASSIFIED_TAXON]));
  const jt = buildFolderTree(catalog, {sources, taxa: joined}), jr = buildRecords(catalog, jt, joined);
  for (const e of ['calm', 'steady']) same(folderMembers(jt, jt.byKey.get(`avs/energy/${e}`), jr), classified.filter(i => taxa.get(catalog[i].sha256).e === e), `placeholders never join energy ${e}`);
  same(folderMembers(jt, jt.byKey.get('avs/style/unclassified'), jr), avs.filter(i => !taxa.has(catalog[i].sha256)));
  // Absent data: no facet branches at all, and an AVS-only source tree remains.
  const bare = buildFolderTree(catalog, {sources});
  for (const key of ['avs/style', 'avs/energy', 'avs/busy', 'avs/author']) assert.equal(bare.byKey.has(key), false, `${key} needs data`);
  assert.ok(bare.byKey.has('avs/src') && bare.byKey.has('avs/rating'));
  const empty = buildFolderTree(catalog, {sources, taxa: new Map()});
  assert.equal(empty.byKey.has('avs/style'), false, 'an empty taxonomy creates no branch');
  // Author facet keys are slugged and bounded.
  const longAuthor = build([row(1, 'X', [['visbot-legacy-a-0000000000', 'x.avs']])], {taxa: new Map([[H(1), {c: 'mixed', t: [], e: 'calm', b: 1, f: 'full', a: 'A/B '.repeat(30)}]])});
  assert.ok([...longAuthor.tree.byKey.keys()].filter(k => k.startsWith('avs/author/')).every(k => k.split('/').length === 3), 'a slash in an author name never adds a level');
}

// ---------------------------------------------------------------------------------------------------- user folders
{
  const {catalog: c, tree: t, rs: r} = build(Array.from({length: 30}, (_, k) => row(k + 1, `Song ${k}`, [['visbot-legacy-a-0000000000', `p/s${k}.avs`]], k % 4 ? {rating: 4} : {})));
  const hashIndex = new Map(c.map((p, i) => [p.sha256, i]));
  const user = [
    {id: 'child', name: 'Child', parent: 'root', kind: 'manual', presets: [H(3), H(2)], created: 3},
    {id: 'root', name: 'Late night', parent: null, kind: 'manual', presets: [H(10), H(999), H(4), H(1)], created: 1},
    {id: 'grand', name: 'Grand', parent: 'child', kind: 'smart', query: 'rating:>=4', scope: null, created: 4},
    {id: 'scoped', name: 'Scoped', parent: null, kind: 'smart', query: 'song', scope: 'avs/src/c:visbot-legacy', created: 5},
    {id: 'lost', name: 'Lost scope', parent: null, kind: 'smart', query: 'song', scope: 'avs/src/nowhere', created: 6},
  ];
  const ut = withUserFolders(t, user, hashIndex);
  assert.notEqual(ut, t); assert.ok(ut.revision > t.revision);
  assert.equal(ut.staticCount, t.staticCount, 'static nodes are shared, user nodes appended');
  const mine = node(ut, 'user:root');
  assert.equal(mine.kind, 'user'); assert.equal(mine.label, 'Late night'); assert.equal(mine.parent, ut.byKey.get('user'));
  assert.deepEqual([...mine.order], [9, 3, 0], 'a manual folder keeps its own order');
  assert.equal(mine.missing, 1, 'unresolvable hashes are counted, not dropped from the file');
  assert.deepEqual(sortNum(mine.direct), [0, 3, 9]);
  // Parents first regardless of file order; nesting resolves; the manual order map drives the Manual sort.
  assert.equal(node(ut, 'user:child').parent, mine.id); assert.equal(node(ut, 'user:grand').parent, node(ut, 'user:child').id);
  assert.deepEqual([...manualOrder(ut, mine.id)], [[9, 0], [3, 1], [0, 2]]);
  same(folderMembers(ut, mine.id, r), [...new Set([0, 1, 2, 3, 9, ...c.map((p, i) => i).filter(i => (c[i].rating ?? 0) >= 4)])], 'recursive: own, child, and the smart grandchild, counted once');
  same(directMembers(ut, mine.id, r), [0, 3, 9]);
  same(directMembers(ut, node(ut, 'user:grand').id, r), c.map((p, i) => i).filter(i => (c[i].rating ?? 0) >= 4), 'a smart folder evaluates its saved query');
  same(folderMembers(ut, node(ut, 'user:scoped').id, r), c.map((p, i) => i), 'a scoped smart folder searches inside its scope');
  same(folderMembers(ut, node(ut, 'user:lost').id, r), [], 'a scope that no longer exists yields nothing');
  // Two smart folders that scope each other cannot loop.
  const loopy = withUserFolders(t, [{id: 'a', name: 'A', parent: null, kind: 'smart', query: '', scope: 'user:b', created: 1}, {id: 'b', name: 'B', parent: null, kind: 'smart', query: '', scope: 'user:a', created: 2}], hashIndex);
  assert.doesNotThrow(() => folderMembers(loopy, node(loopy, 'user:a').id, r));
  // Idempotent: building on an already extended tree replaces the user part.
  const again = withUserFolders(ut, [user[1]], hashIndex);
  assert.equal(again.nodes.length, again.staticCount + 1); assert.ok(!again.byKey.has('user:child'));
  // buildFolderTree with `user` input is the same as extending afterwards.
  const direct = buildFolderTree(c, {user});
  assert.deepEqual([...direct.byKey.keys()].sort(), [...ut.byKey.keys()].sort());
  // Rows: the My folders section lists user folders; playing marker works on them.
  const rows = treeRows(ut, new Set(['user', 'user:root']), 'user:root', r);
  const late = rows.find(x => x.label === 'Late night'); assert.equal(late.playing, true); assert.equal(late.depth, 1);
  assert.ok(rows.some(x => x.label === 'Child' && x.depth === 2));
  assert.equal(withUserFolders(t, [], hashIndex).nodes[t.byKey.get('user')].children.length, 0);
  // Orphans (a parent that does not exist) are simply not shown; the file parser rejects them before this point.
  assert.doesNotThrow(() => withUserFolders(t, [{id: 'o', name: 'O', parent: 'ghost', kind: 'manual', presets: [], created: 1}], hashIndex));
}

// ---------------------------------------------------------------------------------------------------- guards
{
  assert.equal(folderMembers(tree, 99999, rs).length, 0); assert.equal(directMembers(tree, -1, rs).length, 0);
  assert.deepEqual(locate(tree, 99999), {primary: -1, others: []});
  assert.deepEqual(pathLabels(tree, -1), []);
  assert.deepEqual(ancestorKeys(tree, 'no/such/key'), []);
  // Builds fast enough: a 6,000-entry catalog (the local estate is 3,409) well inside a generous budget.
  const big = syntheticCatalog(6000, 3), bigCatalog = parseLocalAvsCatalog(big.catalogJson, big.validationJson, BASE), bigSources = parseLocalAvsSources(big.sourcesJson);
  const t0 = performance.now();
  const bt = buildFolderTree(bigCatalog, {sources: bigSources}), brs = buildRecords(bigCatalog, bt);
  treeRows(bt, new Set(['avs', 'avs/src', 'hud']), null, brs);
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `tree + records for ${bigCatalog.length} entries took ${ms.toFixed(0)} ms`);
  // Malformed provenance never breaks the tree: bad occurrences were dropped by the parser and the entry lands in Unsorted.
  const messy = build([row(1, 'M', [], {occurrences: [{package_id: 5, original_path: 'x'}, {package_id: 'p', original_path: ''}, null, 'x', {package_id: 'p'.repeat(201), original_path: 'x.avs'}]}),
    row(2, 'M2', [], {occurrences: Array.from({length: 33}, (_, k) => ({package_id: `visbot-legacy-a-${k}`, original_path: 'a.avs'}))}), row(3, 'M3', [], {folder: '/bad//hint'}), row(4, 'M4', [], {folder: 'a/b/c/d/e/f/g'})]);
  assert.deepEqual(messy.catalog.map(p => p.origins), [undefined, undefined, undefined, undefined]);
  assert.deepEqual(messy.catalog.map(p => p.folder), [undefined, undefined, undefined, undefined]);
  same(directMembers(messy.tree, messy.tree.byKey.get('avs/src/unsorted'), messy.rs), [0, 1, 2, 3], 'every entry is still in a leaf');
}

// ---------------------------------------------------------------------------------------------------- catalog parser additions (origins, folder hints, HUD rows)
{
  const P = extra => parse([row(1, 'X', [['visbot-legacy-a-0000000000', 'a/x.avs']], extra)])[0];
  // Origins: the archive-relative path only; the private staging path is never read, even when it is the only thing present.
  const staged = parse([{...row(1, 'S', []), occurrences: [{package_id: 'p', path: '_staging/secret/only-a-staging-path.avs'}]}])[0];
  assert.equal(staged.origins, undefined, 'no original_path: nothing is kept');
  const kept = P();
  assert.deepEqual(kept.origins, [{pkg: 'visbot-legacy-a-0000000000', path: 'a/x.avs'}]); assert.ok(Object.isFrozen(kept.origins) && Object.isFrozen(kept.origins[0]));
  assert.ok(!JSON.stringify(kept).includes('_staging'), 'the staging path never reaches a catalog row');
  const occ = n => Array.from({length: n}, (_, k) => ({package_id: `visbot-legacy-a-${k}`, original_path: 'a.avs'}));
  assert.equal(P({occurrences: occ(32)}).origins.length, 32, '32 occurrences are kept'); assert.equal(P({occurrences: occ(33)}).origins, undefined, 'an oversize list is dropped whole');
  assert.equal(P({occurrences: 'nope'}).origins, undefined); assert.equal(P({occurrences: {}}).origins, undefined);
  assert.equal(P({occurrences: [{package_id: 'p'.repeat(200), original_path: 'a.avs'}]}).origins.length, 1); assert.equal(P({occurrences: [{package_id: 'p'.repeat(201), original_path: 'a.avs'}]}).origins, undefined);
  assert.equal(P({occurrences: [{package_id: 'p', original_path: 'a'.repeat(1024)}]}).origins.length, 1); assert.equal(P({occurrences: [{package_id: 'p', original_path: 'a'.repeat(1025)}]}).origins, undefined);
  assert.equal(P({occurrences: [{package_id: 'p\u0000', original_path: 'a.avs'}, {package_id: 'q', original_path: 'b\u001f.avs'}, {package_id: 'ok', original_path: 'c.avs'}]}).origins.length, 1, 'control characters skip the entry');
  // Folder hints: at most six segments of at most 80 characters, no empty segment, no control character; a non-ASCII middle dot is fine.
  assert.equal(P({folder: 'a/b/c/d/e/f'}).folder, 'a/b/c/d/e/f'); assert.equal(P({folder: 'a/b/c/d/e/f/g'}).folder, undefined);
  assert.equal(P({folder: 'x'.repeat(80)}).folder, 'x'.repeat(80)); assert.equal(P({folder: 'x'.repeat(81)}).folder, undefined);
  for (const bad of ['', '/a', 'a/', 'a//b', 'a\u0000b', 'a\u0085b', 'a b', 5, null, {}, ['a']]) assert.equal(P({folder: bad}).folder, undefined, JSON.stringify(bad));
  assert.equal(P({folder: 'Arcade · Fighting/Some Title'}).folder, 'Arcade · Fighting/Some Title'); assert.equal(P({folder: ' padded /kept verbatim '}).folder, ' padded /kept verbatim ');
  // Kinds: `hud` and `nerv` exactly; anything else is an AVS preset.
  assert.equal(P({kind: 'future'}).kind, 'avs'); assert.equal(P({kind: 5}).kind, 'avs'); assert.equal(P({kind: 'NERV'}).kind, 'avs');
  // HUD rows are installer-written: a malformed row throws like a NERV row; tags are sanitised instead.
  const hudRow = (extra = {}, hudExtra = {}) => ({...row(9, 'Scene', []), canonical_path: `presets/unique/${H(9).slice(0, 16)}---scene.hud`, kind: 'hud', folder: 'Modern/Kit',
    hud: {id: 'scene-1', pack: 'Modern', family: 'shooter', tags: ['a', 'b'], tier: 'auto', order: 3, canvas: {style: 'vector', w: 320, h: 224}, ...hudExtra}, ...extra});
  const good = parse([hudRow()])[0];
  assert.equal(good.kind, 'hud'); assert.equal(good.hud.tier, 'auto'); assert.ok(Object.isFrozen(good.hud) && Object.isFrozen(good.hud.canvas) && Object.isFrozen(good.hud.tags));
  assert.throws(() => parse([hudRow({canonical_path: `presets/unique/${H(9).slice(0, 16)}---scene.avs`})]), /HUD preset extension/);
  for (const bad of [{tier: 'gold'}, {order: 1.5}, {order: '3'}, {id: ''}, {id: 'x'.repeat(81)}, {pack: 5}, {family: 'a\u0000b'}, {canvas: null}, {canvas: {style: 'crt', w: 320, h: 224}}, {canvas: {style: 'pixel', w: 63, h: 224}},
    {canvas: {style: 'pixel', w: 320, h: 1921}}, {canvas: {style: 'pixel', w: 320.5, h: 224}}, {canvas: {style: 'pixel', w: 320, h: 224, par: [0, 1]}}, {canvas: {style: 'pixel', w: 320, h: 224, par: [1, 17]}}, {canvas: {style: 'pixel', w: 320, h: 224, par: [1]}}]) {
    assert.throws(() => parse([hudRow({}, bad)]), /Invalid HUD/, JSON.stringify(bad));
  }
  assert.throws(() => parse([hudRow({hud: undefined})]), /Invalid HUD/); assert.throws(() => parse([hudRow({hud: 'x'})]), /Invalid HUD/); assert.throws(() => parse([hudRow({hud: []})]), /Invalid HUD/);
  assert.deepEqual(parse([hudRow({}, {canvas: {style: 'pixel', w: 64, h: 1920, par: [8, 7]}})])[0].hud.canvas.par, [8, 7]);
  assert.deepEqual(parse([hudRow({}, {tags: ['ok', '', 'x'.repeat(25), 5, 'a\u0000', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']})])[0].hud.tags, ['ok', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 'tags: bad entries dropped, at most eight kept');
  assert.deepEqual(parse([hudRow({}, {tags: 'not a list'})])[0].hud.tags, []);
  assert.equal(parse([row(1, 'Legacy', [])])[0].hud, undefined, 'a legacy row gains no hud key'); assert.ok(!('folder' in parse([row(1, 'Legacy', [])])[0]) && !('origins' in parse([row(1, 'Legacy', [])])[0]), 'and no empty keys');
}

// ---------------------------------------------------------------------------------------------------- hostile catalog data never breaks the catalog or the tree
{
  let seed = 424242;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const junk = () => [null, undefined, true, 0, -1, 1.5, NaN, 'x', '', 'a'.repeat(2000), [], {}, [null], [{}], {package_id: 1, original_path: 2}, {package_id: 'p', original_path: '../../etc'}, '__proto__', 'a/'.repeat(9),
    {__proto__: null}, JSON.parse('{"__proto__":{"polluted":1}}'), ' ', 'a b'][Math.floor(rand() * 21)];
  const base = syntheticCatalog(300, 9, {hud: 40, hudNeo: 10});
  let thrown = 0, survived = 0;
  for (let round = 0; round < 400; round++) {
    const catalogJson = JSON.parse(JSON.stringify(base.catalogJson));
    for (let m = 0; m < 1 + Math.floor(rand() * 6); m++) {
      const entry = catalogJson.presets[Math.floor(rand() * catalogJson.presets.length)];
      const roll = rand();
      if (roll < 0.35) entry.occurrences = junk();
      else if (roll < 0.6) entry.folder = junk();
      else if (roll < 0.75 && Array.isArray(entry.occurrences) && entry.occurrences.length) entry.occurrences[0] = junk();
      else if (roll < 0.9 && entry.hud) entry.hud[['tags', 'tier', 'canvas', 'pack', 'family', 'id', 'order'][Math.floor(rand() * 7)]] = junk();
      else entry.kind = junk();
    }
    let catalog;
    try { catalog = parseLocalAvsCatalog(catalogJson, base.validationJson, BASE); }
    catch (error) {
      // Only installer-written data may throw: a bad NERV/HUD row. Provenance and folder hints never do.
      assert.ok(error instanceof Error && /NERV|HUD/.test(error.message), `unexpected failure: ${error?.message}`); thrown++; continue;
    }
    survived++;
    for (const p of catalog) {
      if (p.origins) { assert.ok(p.origins.length >= 1 && p.origins.length <= 32); for (const o of p.origins) assert.ok(typeof o.pkg === 'string' && o.pkg.length <= 200 && typeof o.path === 'string' && o.path.length <= 1024); }
      if (p.folder) assert.ok(p.folder.split('/').length <= 6 && p.folder.split('/').every(seg => seg.length >= 1 && seg.length <= 80));
      assert.equal(({}).polluted, undefined, 'no prototype pollution');
    }
    const tree = buildFolderTree(catalog, {sources: parseLocalAvsSources(base.sourcesJson)});
    const rs = buildRecords(catalog, tree, null);
    for (let i = 0; i < catalog.length; i++) if (catalog[i].kind !== 'nerv' && catalog[i].kind !== 'hud') assert.ok(tree.locations[i].length >= 1, 'every AVS preset stays in a leaf whatever the provenance data was');
    assert.equal(folderMembers(tree, tree.byKey.get('avs'), rs).length, catalog.filter(p => p.kind !== 'nerv' && p.kind !== 'hud').length);
    for (const key of tree.byKey.keys()) assert.ok(key.length > 0);
  }
  assert.ok(survived > 200, `most mutated catalogs load (${survived}, ${thrown} refused as malformed installer rows)`);
  // The sources file is total for any input.
  for (let round = 0; round < 500; round++) assert.doesNotThrow(() => parseLocalAvsSources(junk()));
  assert.doesNotThrow(() => parseLocalAvsSources({sources: [junk(), junk(), {id: junk(), catalog: junk()}]}));
}

// ---------------------------------------------------------------------------------------------------- sources: parser limits and the lazy loader
{
  const {fetchLocalAvsSources, fetchLocalAvsBrowserData, fetchLocalHudTitles, parseLocalHudTitles, isSceneKind, UNCLASSIFIED_TAXON} = B;
  assert.equal(isSceneKind({kind: 'nerv'}) && isSceneKind({kind: 'hud'}), true); assert.equal(isSceneKind({kind: 'avs'}) || isSceneKind({}) || isSceneKind(null) || isSceneKind(undefined), false);
  // Parser: total, bounded, descriptive strings only.
  for (const junk of [null, undefined, 5, 'x', [], {}, {sources: 5}, {sources: null}, [null, 5, 'x', []]]) assert.equal(parseLocalAvsSources(junk).size, 0, JSON.stringify(junk));
  const one = parseLocalAvsSources({sources: [{id: 'pkg', catalog: 'github', file_name: 'a.zip', artist_slug: 'ann', repository: 'org/repo', release_id: 'r1', url: 'https://example.invalid/x', branch: 'main', source_page: 'p'}]});
  assert.deepEqual({...one.get('pkg')}, {catalog: 'github', fileName: 'a.zip', artist: 'ann', repository: 'org/repo', release: 'r1'}, 'only descriptive strings; no URL is ever kept');
  assert.ok(!JSON.stringify([...one]).includes('example.invalid') && Object.isFrozen(one.get('pkg')));
  const bad = parseLocalAvsSources([{id: '__proto__', catalog: 'x'}, {id: 'x'.repeat(201)}, {id: ''}, {id: 5}, {id: 'ctl\u0000'}, {id: 'ok', catalog: 'c'.repeat(201), artist_slug: 5, file_name: 'f\u0001'}, null]);
  assert.deepEqual([...bad.keys()], ['ok']); assert.deepEqual({...bad.get('ok')}, {}, 'bad fields are dropped, the id stays');
  assert.equal(bad.has('__proto__'), false); assert.equal(({}).catalog, undefined);
  assert.equal(parseLocalAvsSources({sources: Array.from({length: 5100}, (_, k) => ({id: `p${k}`}))}).size, 5000, 'at most 5,000 entries');
  assert.equal(parseLocalAvsSources(Array.from({length: 3}, (_, k) => ({id: `p${k}`}))).size, 3, 'a bare array is accepted too');
  // Loader: lazy, soft, never throws. `Response` is Node's; the URLs requested are the collection's catalog files.
  const BASEURI = 'https://aaavs.invalid/mpc.html';
  const requested = [];
  const serve = files => async url => {
    requested.push(String(url));
    const name = decodeURIComponent(String(url).split('/').at(-1));
    if (!(name in files)) return new Response('', {status: 404});
    const body = files[name];
    return body instanceof Response ? body : new Response(typeof body === 'string' ? body : JSON.stringify(body), {status: 200});
  };
  const fx2 = syntheticCatalog(60, 5, {hud: 3, hudNeo: 1});
  globalThis.fetch = serve({'sources.json': fx2.sourcesJson});
  const map = await fetchLocalAvsSources(BASEURI); assert.ok(map.size > 10); assert.equal(requested.at(-1), 'https://aaavs.invalid/avs%20presets/catalog/sources.json');
  globalThis.fetch = serve({}); assert.equal((await fetchLocalAvsSources(BASEURI)).size, 0, 'a missing file (public and stock installs) is an empty map');
  globalThis.fetch = serve({'sources.json': '{not json'}); assert.equal((await fetchLocalAvsSources(BASEURI)).size, 0, 'unreadable: empty');
  globalThis.fetch = async () => { throw new TypeError('network down'); }; assert.equal((await fetchLocalAvsSources(BASEURI)).size, 0, 'a rejected fetch: empty');
  globalThis.fetch = serve({'sources.json': new Response('[]', {status: 200, headers: {'content-length': String(33 * 1024 * 1024)}})}); assert.equal((await fetchLocalAvsSources(BASEURI)).size, 0, 'over the byte budget: empty');
  // The soft timeout: a request that never answers gives up after two seconds and the browser opens without artists.
  globalThis.fetch = () => new Promise(() => {});
  const t0 = performance.now(); assert.equal((await fetchLocalAvsSources(BASEURI)).size, 0); const waited = performance.now() - t0;
  assert.ok(waited >= 1800 && waited < 4000, `the soft timeout is about two seconds (${waited.toFixed(0)} ms)`);
  // The categories hook: three optional private files, loaded together; one failing never affects the others.
  const catalogRows = parseLocalAvsCatalog(fx2.catalogJson, fx2.validationJson, BASE);
  const cats = {format: 'aaavs-categories', version: 1, taxonomy: {id: 'aaavs-style', version: 1}, generated: 'x', generator: 'y', catalogSha: 'z', entries: {[catalogRows[0].sha256]: {c: 'mixed', t: [], e: 'calm', b: 2, f: 'full', s: 's', k: 1}}};
  const titles = {format: 'aaavs-hud-titles', version: 1, titles: {[catalogRows.find(p => p.kind === 'hud').hud.id]: 'Local Display Title'}};
  requested.length = 0;
  globalThis.fetch = serve({'sources.json': fx2.sourcesJson, 'categories.json': cats, 'hud-titles.json': titles});
  const all = await fetchLocalAvsBrowserData(BASEURI, catalogRows);
  assert.ok(all.sources.size > 10); assert.equal(all.titles.size, 1); assert.equal(all.titles.get(catalogRows.find(p => p.kind === 'hud').hud.id), 'Local Display Title');
  assert.equal(all.taxa.get(catalogRows[0].sha256).c, 'mixed'); assert.equal(all.taxa.get(catalogRows[1].sha256), UNCLASSIFIED_TAXON, 'with the catalog the map is joined; the rest are neutral placeholders');
  assert.deepEqual(requested.map(u => decodeURIComponent(u.split('/').slice(3).join('/'))).sort(), ['avs presets/catalog/categories.json', 'avs presets/catalog/hud-titles.json', 'avs presets/catalog/sources.json']);
  assert.ok(requested.every(u => u.startsWith('https://aaavs.invalid/avs%20presets/catalog/')), 'nothing outside the collection is requested');
  const noCatalog = await fetchLocalAvsBrowserData(BASEURI); assert.equal(noCatalog.taxa.size, 1, 'without the catalog only the file’s own entries');
  globalThis.fetch = serve({'categories.json': cats}); const only = await fetchLocalAvsBrowserData(BASEURI, catalogRows);
  assert.equal(only.sources.size, 0); assert.equal(only.titles, null); assert.ok(only.taxa instanceof Map, 'each file is optional on its own');
  globalThis.fetch = serve({'sources.json': fx2.sourcesJson, 'categories.json': '{bad', 'hud-titles.json': {format: 'other'}});
  const partial = await fetchLocalAvsBrowserData(BASEURI, catalogRows); assert.ok(partial.sources.size > 10); assert.equal(partial.taxa, null); assert.equal(partial.titles, null, 'a bad file is null, never an error');
  globalThis.fetch = serve({}); const none = await fetchLocalAvsBrowserData(BASEURI);
  assert.deepEqual([none.sources.size, none.taxa, none.titles], [0, null, null], 'public and stock installs: all three absent');
  assert.equal((await fetchLocalHudTitles(BASEURI)), null); assert.equal(typeof parseLocalHudTitles, 'function');
  assert.equal(parseLocalHudTitles({format: 'aaavs-hud-titles', version: 1, titles: {'a-1': ' Spaced Title '}}).get('a-1'), 'Spaced Title');
  delete globalThis.fetch;
}

// ---------------------------------------------------------------------------------------------------- rows carry their merged chain
{
  const rows = treeRows(tree, new Set(tree.nodes.map(n => n.key)), null, rs);
  for (const r of rows) { assert.ok(r.chain.length >= 1 && r.chain.at(-1) === r.key, 'the row key is the bottom of its chain'); assert.equal(new Set(r.chain).size, r.chain.length); }
  assert.ok(rows.some(r => r.chain.length > 1), 'the fixture has merged rows');
  const merged = rows.find(r => r.chain.length > 1);
  assert.equal(merged.label.split(' > ').length, merged.chain.length, 'one label segment per chained node');
  assert.deepEqual(merged.chain.map(k => tree.nodes[tree.byKey.get(k)].label), merged.label.split(' > '));
}

console.log(`Folder tree PASS: ${tree.nodes.length} nodes over ${catalog.length} synthetic entries (${avs.length} AVS, ${nerv.length} NERV, ${hud.length} HUD); unions, keys, primary location, nesting/wrappers, chain collapse, buckets, 16 HUD packs, title overlay, smart folders, facets, user folders, parser additions, hostile catalog fuzz`);
