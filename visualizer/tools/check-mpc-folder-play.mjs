import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mulberry32, syntheticCatalog, syntheticTaxa, loadBrowser, PACK_LABELS} from './fixtures-folders.mjs';
// Play folder (docs/design/PRESET-BROWSER-V2.md 8, 12), the built-in folder defaults (owner directive B) and the pool cache. CPU only:
// pure modules bundled with esbuild, fed by a deterministic synthetic catalog. No browser, no host, no private data.
const B = await loadBrowser();
const {buildFolderTree, withUserFolders, folderMembers, defaultLabelFor, buildRecords, updateRecord, parseLocalAvsCatalog, parseLocalAvsSources, planFolderPlay, defaultSort, PoolCache,
  setupHashes, playMessage, sanitizeOrder, overlayText, SETUP_LIMIT, builtinDefault, builtinLabels, canonicalPackLabel, packOrder, HUD_PACK_LABELS, NERV_FOLDER_LABEL, HUD_ROOT_LABEL, CLASSIC_STYLES,
  parseSettings, parseSetups, stepSetup, setupIndices, effectiveFadeTiming, canonicalSettings, sceneAt, parseSceneTiming, defaultSceneTiming, defaultSettings, eligiblePresets,
  createFolder, addMembers, emptyFolderState, TRANSITION_COUNT, TRANSITION_CUT} = B;
const BASE = 'https://aaavs.invalid/mpc.html';
const H = n => n.toString(16).padStart(64, '0');
const asc = a => [...a].sort((x, y) => x - y);
function row(i, name, occ = [], extra = {}) {
  return {sha256: H(i), bytes: 100 + i, canonical_path: `presets/unique/${H(i).slice(0, 16)}---${name}.avs`, display_name: name,
    occurrences: occ.map(([pkg, path]) => ({package_id: pkg, path: `_staging/${pkg}/${path}`, original_path: path})), ...extra};
}
const parse = rows => parseLocalAvsCatalog({presets: rows}, {results: rows.map(r => ({sha256: r.sha256, status: r.parse ?? 'lossless'}))}, BASE);
function make(rows, inputs = {}) { const catalog = parse(rows); const tree = buildFolderTree(catalog, inputs); return {catalog, tree, rs: buildRecords(catalog, tree, inputs.taxa ?? null)}; }
const id = (tree, key) => { const n = tree.byKey.get(key); assert.notEqual(n, undefined, `node ${key}`); return n; };
const request = (key, extra = {}) => ({key, label: key, recursive: true, sort: [], useSaved: true, seed: 7, ...extra});
const LIVE = {enabled: true, bars: 8, shuffle: false, minimumRating: 0, transition: 1, beats: 2, durationMs: 1000, keepOld: true, manualFade: true, autoFade: true};

// ---------------------------------------------------------------------------------------------------- the estate
const fx = syntheticCatalog(4000, 1);
const catalog = parseLocalAvsCatalog(fx.catalogJson, fx.validationJson, BASE);
const sources = parseLocalAvsSources(fx.sourcesJson);
const taxa = new Map(syntheticTaxa(fx.catalogJson));
const tree = buildFolderTree(catalog, {sources, taxa});
const rs = buildRecords(catalog, tree, taxa);
const avs = catalog.map((p, i) => i).filter(i => catalog[i].kind === 'avs');
const playable = avs.filter(i => catalog[i].autoEligible);
assert.ok(playable.length > 3900 && playable.length < 4000, 'the fixture has a few unparseable presets');

// ---------------------------------------------------------------------------------------------------- recursion, sorting, filtering
{
  const rows = [row(1, 'Beta', [['visbot-legacy-a-0000000000', 'Pack/b/Beta.avs']]), row(2, 'Alpha', [['visbot-legacy-a-0000000000', 'Pack/Alpha.avs']]), row(3, 'Gamma', [['visbot-legacy-a-0000000000', 'Pack/b/Gamma.avs']]),
    row(4, 'Broken', [['visbot-legacy-a-0000000000', 'Pack/b/Broken.avs']], {parse: 'parse-error'}), row(5, 'Delta', [['visbot-legacy-a-0000000000', 'Pack/Delta.avs']], {notWorking: true})];
  const {catalog: c, tree: t, rs: r} = make(rows);
  const pack = 'avs/src/c:visbot-legacy/p:visbot-legacy-a-0000000000';
  const names = plan => plan.order.map(i => c[i].name);
  const recursive = planFolderPlay(t, r, c, request(pack, {recursive: true}));
  assert.equal(recursive.ok, true);
  assert.deepEqual(names(recursive), ['Alpha', 'Delta', 'Beta', 'Gamma'], 'default order is path, then name (the wrapper folder before its sub-folder); the unparseable preset is removed');
  assert.equal(recursive.total, 5, 'total counts every member before filtering'); assert.deepEqual(recursive.skipped, {unavailable: 1, missing: 0, partial: 0});
  assert.ok(recursive.order.includes(4), 'a preset marked not working stays in the order: the live selection skips it, so clearing the mark works at once');
  const direct = planFolderPlay(t, r, c, request(pack, {recursive: false}));
  assert.deepEqual(names(direct), ['Alpha', 'Delta'], 'direct members only'); assert.equal(direct.total, 2);
  const byName = planFolderPlay(t, r, c, request(pack, {sort: [{key: 'name', dir: 'desc'}]}));
  assert.deepEqual(names(byName), ['Gamma', 'Delta', 'Beta', 'Alpha'], 'the playback sort is honoured');
  const bySize = planFolderPlay(t, r, c, request(pack, {sort: [{key: 'size', dir: 'desc'}]}));
  assert.deepEqual(names(bySize), ['Delta', 'Gamma', 'Alpha', 'Beta'], 'file size, largest first');
  // Random is deterministic per seed and differs across seeds.
  const rand = (seed, extra = {}) => planFolderPlay(t, r, c, request(pack, {sort: [{key: 'random', dir: 'asc'}], seed, ...extra})).order.join();
  assert.equal(rand(5), rand(5)); assert.notEqual(rand(5), rand(6));
  assert.deepEqual(defaultSort(t, id(t, pack)), [{key: 'path', dir: 'asc'}, {key: 'name', dir: 'asc'}]);
  // startAt: kept when it is in the order, dropped when it is not (unavailable) or unknown.
  assert.equal(planFolderPlay(t, r, c, request(pack, {startAt: 2})).startAt, 2);
  assert.equal(planFolderPlay(t, r, c, request(pack, {startAt: 3})).startAt, null, 'the unparseable member cannot start');
  assert.equal(planFolderPlay(t, r, c, request(pack, {startAt: 99})).startAt, null);
  assert.equal(planFolderPlay(t, r, c, request(pack)).startAt, null);
  // Refusals leave playback untouched and say why.
  assert.deepEqual(planFolderPlay(t, r, c, request('avs/src/nope')), {ok: false, reason: 'That folder no longer exists.'});
  assert.deepEqual(planFolderPlay(t, r, c, request('smart:favorites')), {ok: false, reason: 'This folder has no presets.'});
  const dead = make([row(1, 'Dead', [['visbot-legacy-a-0000000000', 'x.avs']], {parse: 'parse-error'})]);
  const none = planFolderPlay(dead.tree, dead.rs, dead.catalog, request('avs'));
  assert.equal(none.ok, false); assert.match(none.reason, /No playable presets: 1 unavailable/);
  // The snapshot is a copy: editing the folder later does not reach a plan already made.
  const before = planFolderPlay(t, r, c, request('smart:rated'));
  assert.equal(before.ok, false, 'nothing is rated yet');
  updateRecord(r, 0, {...c[0], rating: 4});
  const favorites = planFolderPlay(t, r, c, request('smart:favorites'));
  assert.deepEqual(favorites.order, [0], 'a smart folder is evaluated at play time');
  updateRecord(r, 1, {...c[1], rating: 5});
  assert.deepEqual(favorites.order, [0], 'a plan is a snapshot');
  assert.deepEqual(planFolderPlay(t, r, c, request('smart:favorites')).order, [1, 0], 'a smart folder sorts by name: Alpha before Beta');
  assert.deepEqual(defaultSort(t, id(t, 'smart:favorites')), [{key: 'name', dir: 'asc'}], 'smart folders sort by name');
}

// ---------------------------------------------------------------------------------------------------- results mode, manual folders, ghosts
{
  const rows = Array.from({length: 12}, (_, k) => row(k + 1, `Song ${k}`, [['visbot-legacy-a-0000000000', `p/s${k}.avs`]], k === 3 ? {parse: 'parse-error'} : {}));
  const {catalog: c, tree: t0, rs: r0} = make(rows);
  const hashIndex = new Map(c.map((p, i) => [p.sha256, i]));
  // Results mode: exactly the list, in list order, deduplicated; indices that are not in the catalog are ignored; no folder is needed.
  const listed = Int32Array.from([9, 2, 2, 7, 99, -1, 3, 12]);
  const results = planFolderPlay(t0, r0, c, request('avs', {results: listed, label: 'avs (results)'}));
  assert.equal(results.ok, true); assert.deepEqual(results.order, [9, 2, 7], 'displayed order, duplicates and bad indices dropped, the unparseable one removed');
  assert.equal(results.total, 4); assert.equal(results.skipped.unavailable, 1);
  assert.equal(planFolderPlay(t0, r0, c, request('gone', {results: Int32Array.from([1, 2])})).ok, true, 'results do not depend on the folder still existing');
  assert.deepEqual(planFolderPlay(t0, r0, c, request('avs', {results: new Int32Array(0)})), {ok: false, reason: 'This folder has no presets.'});
  // A manual user folder plays in its own order; hashes that no longer resolve are counted as missing.
  const user = [{id: 'm', name: 'Mine', parent: null, kind: 'manual', presets: [H(5), H(999), H(2), H(4), H(1000)], created: 1}];
  const t = withUserFolders(t0, user, hashIndex);
  const mine = planFolderPlay(t, r0, c, request('user:m'));
  assert.deepEqual(mine.order, [4, 1], 'own order; hash 4 (index 3) is unparseable');
  assert.equal(mine.total, 3, 'resolved members only; the ghosts are reported separately'); assert.deepEqual(mine.skipped, {unavailable: 1, missing: 2, partial: 0});
  assert.deepEqual(defaultSort(t, id(t, 'user:m')), [{key: 'manual', dir: 'asc'}]);
  const sorted = planFolderPlay(t, r0, c, request('user:m', {sort: [{key: 'name', dir: 'asc'}]}));
  assert.deepEqual(sorted.order, [1, 4], 'an explicit sort overrides the manual order');
  const onlyGhosts = withUserFolders(t0, [{id: 'g', name: 'Ghosts', parent: null, kind: 'manual', presets: [H(900), H(901)], created: 1}], hashIndex);
  const ghost = planFolderPlay(onlyGhosts, r0, c, request('user:g'));
  assert.equal(ghost.ok, false); assert.equal(ghost.reason, 'This folder has no presets.', 'a folder that resolves to nothing has nothing to play');
  // A nested folder plays with or without its children.
  const nested = withUserFolders(t0, [{id: 'p', name: 'Parent', parent: null, kind: 'manual', presets: [H(1)], created: 1}, {id: 'k', name: 'Kid', parent: 'p', kind: 'manual', presets: [H(2)], created: 2}], hashIndex);
  assert.deepEqual(planFolderPlay(nested, r0, c, request('user:p', {recursive: true})).order.slice().sort(), [0, 1]);
  assert.deepEqual(planFolderPlay(nested, r0, c, request('user:p', {recursive: false})).order, [0]);
}

// ---------------------------------------------------------------------------------------------------- no 500-preset cap
{
  const all = planFolderPlay(tree, rs, catalog, request('avs'));
  assert.equal(all.ok, true); assert.equal(all.order.length, playable.length, 'every playable AVS preset, thousands of them');
  assert.ok(all.order.length > SETUP_LIMIT * 7);
  assert.equal(new Set(all.order).size, all.order.length);
  // The cap lives in parseSetups only: the same members as a saved setup are refused, and the plan never passes through it.
  const asSetup = [{id: 's', name: 'Too big', presets: all.order.slice(0, 501).map(i => catalog[i].sha256), settings: {...defaultSettings}}];
  assert.throws(() => parseSetups(asSetup), /Invalid setup or duplicate preset/, 'a saved setup holds at most 500');
  assert.doesNotThrow(() => parseSetups([{...asSetup[0], presets: asSetup[0].presets.slice(0, 500)}]));
  // The order steps through the same machinery a setup uses (`stepSetup` over the eligible pool), forwards and backwards, all the way round.
  const pool = eligiblePresets(catalog, all.order, false, 0);
  assert.equal(pool.length, all.order.length - all.order.filter(i => catalog[i].notWorking).length);
  let at = pool[0], seen = 1;
  for (; seen < pool.length + 5; seen++) { const next = stepSetup(pool, at, 1, false); if (next === pool[0]) break; at = next; }
  assert.equal(seen, pool.length, 'forward stepping visits every member exactly once before wrapping');
  assert.equal(stepSetup(pool, pool[0], -1, false), pool.at(-1), 'previous wraps to the end');
  assert.ok(stepSetup(pool, pool[10], 1, true, () => 0.5) !== pool[10], 'shuffle picks another member');
  // A folder holding thousands stays cheap to plan.
  const t0 = performance.now();
  for (let k = 0; k < 20; k++) planFolderPlay(tree, rs, catalog, request('avs', {seed: k}));
  assert.ok((performance.now() - t0) / 20 < 60, 'planning 4,000 members is quick');
  // Only the first 500 fit a saved setup, and the tool says how many did not.
  const setup = setupHashes(all.order, catalog);
  assert.equal(setup.presets.length, SETUP_LIMIT); assert.equal(setup.omitted, all.order.length - SETUP_LIMIT); assert.equal(SETUP_LIMIT, 500);
  assert.deepEqual(setup.presets, all.order.slice(0, 500).map(i => catalog[i].sha256), 'in play order');
  assert.doesNotThrow(() => parseSetups([{id: 's', name: 'Saved folder', presets: setup.presets, settings: {...defaultSettings}}]));
  assert.deepEqual(setupHashes([1, 2, 2, 3], catalog, 2), {presets: [catalog[1].sha256, catalog[2].sha256], omitted: 1}, 'duplicates are ignored, the overflow is counted');
  assert.deepEqual(setupHashes([], catalog), {presets: [], omitted: 0}); assert.deepEqual(setupHashes([99999], catalog), {presets: [], omitted: 0});
  const unparseable = catalog.findIndex(p => !p.autoEligible); assert.ok(unparseable >= 0);
  assert.deepEqual(setupHashes([unparseable], catalog), {presets: [], omitted: 0}, 'an unavailable preset would make activateSetup throw, so it is never offered');
  // "Folder from setup": an unbounded manual folder (the folder limit is 5,000 per folder).
  const state = emptyFolderState();
  createFolder(state, {id: 'from', name: 'From setup', kind: 'manual', created: 1});
  const added = addMembers(state, 'from', setup.presets); assert.deepEqual(added, {added: 500, skipped: 0}); assert.equal(state.folders[0].presets.length, 500);
}

// ---------------------------------------------------------------------------------------------------- partial presets
{
  const partial = avs.filter(i => rs.flags[i] & 32);
  assert.ok(partial.length > 100, 'the fixture marks some presets partial');
  const keep = planFolderPlay(tree, rs, catalog, request('avs'));
  const skip = planFolderPlay(tree, rs, catalog, request('avs', {skipPartial: true}));
  const skippable = partial.filter(i => catalog[i].autoEligible);
  assert.equal(skip.skipped.partial, skippable.length); assert.equal(skip.order.length, keep.order.length - skippable.length);
  assert.ok(skip.order.every(i => !(rs.flags[i] & 32)));
  const viaSaved = planFolderPlay(tree, rs, catalog, request('avs', {saved: {recursive: true, sort: [], skipPartial: true}}));
  assert.equal(viaSaved.skipped.partial, skippable.length, 'the saved option is honoured');
  assert.equal(planFolderPlay(tree, rs, catalog, request('avs', {skipPartial: false, saved: {recursive: true, sort: [], skipPartial: true}})).skipped.partial, 0, 'the request overrides the saved option');
  const noTaxa = make([row(1, 'A', [['visbot-legacy-a-0000000000', 'a.avs']])]);
  assert.equal(planFolderPlay(noTaxa.tree, noTaxa.rs, noTaxa.catalog, request('avs', {skipPartial: true})).skipped.partial, 0, 'without taxonomy nothing is partial');
}

// ---------------------------------------------------------------------------------------------------- settings: saved bundle, live, built-in
{
  const key = 'avs';
  const bundle = {recursive: true, sort: [], settings: {...LIVE, shuffle: true, transition: 6}, timing: {enabled: true, bpm: 128, offsetSeconds: 1.5, barsPerScene: 4, seed: 9}};
  const saved = planFolderPlay(tree, rs, catalog, request(key, {saved: bundle}));
  assert.equal(saved.options, 'saved'); assert.deepEqual(saved.settings, parseSettings(bundle.settings)); assert.deepEqual(saved.timing, parseSceneTiming(bundle.timing));
  assert.equal(saved.note, '');
  // "Use folder options" off: the live settings stay and the clock stays off, saved or not.
  const off = planFolderPlay(tree, rs, catalog, request(key, {saved: bundle, useSaved: false}));
  assert.equal(off.settings, null); assert.equal(off.timing, null); assert.equal(off.options, 'live');
  // An AVS folder with no saved bundle keeps the live settings and the clock stays off (scene switches pay the fetch and worker start).
  const plain = planFolderPlay(tree, rs, catalog, request(key));
  assert.equal(plain.settings, null); assert.equal(plain.timing, null); assert.equal(plain.options, 'live');
  assert.equal(planFolderPlay(tree, rs, catalog, request('avs/src', {saved: {recursive: true, sort: []}})).options, 'live', 'a saved entry with no settings and no timing is not a bundle');
  // A bundle with only timing keeps the live settings but applies the clock; only settings leaves the clock off.
  const onlyTiming = planFolderPlay(tree, rs, catalog, request(key, {saved: {recursive: true, sort: [], timing: bundle.timing}}));
  assert.equal(onlyTiming.settings, null); assert.equal(onlyTiming.timing.bpm, 128); assert.equal(onlyTiming.options, 'saved');
  const onlySettings = planFolderPlay(tree, rs, catalog, request(key, {saved: {recursive: true, sort: [], settings: bundle.settings}}));
  assert.equal(onlySettings.timing, null); assert.equal(onlySettings.settings.transition, 6);
  // Newer-style fields pass through the same validator a setup uses.
  const v2 = planFolderPlay(tree, rs, catalog, request(key, {saved: {recursive: true, sort: [], settings: {...LIVE, fadeTiming: 6, fadeRandomSet: 28, fadeAnchor: 1, queueQuantize: 2, transition: 31}}}));
  assert.deepEqual([v2.settings.fadeTiming, v2.settings.fadeRandomSet, v2.settings.fadeAnchor, v2.settings.queueQuantize, v2.settings.transition], [6, 28, 1, 2, 31]);
  // A bundle that no longer validates behaves like none instead of failing the play.
  const rotten = planFolderPlay(tree, rs, catalog, request(key, {saved: {recursive: true, sort: [], settings: {...LIVE, bars: 3}}}));
  assert.equal(rotten.ok, true); assert.equal(rotten.settings, null); assert.equal(rotten.options, 'live');
  assert.equal(planFolderPlay(tree, rs, catalog, request(key, {saved: {recursive: true, sort: [], timing: {enabled: true, bpm: -3}}})).options, 'live');
}

// ---------------------------------------------------------------------------------------------------- built-in defaults (directive B)
{
  assert.deepEqual([...HUD_PACK_LABELS], PACK_LABELS); assert.equal(HUD_PACK_LABELS.length, 16);
  assert.deepEqual([...HUD_PACK_LABELS], ['Showcase', 'Arcade \u00b7 Fighting', 'Arcade \u00b7 Action', 'Neo Geo', 'Vector & Early Arcade', '8/16-bit Consoles', '32/64-bit Consoles', '128-bit Consoles',
    'Handheld & LCD', 'Home Computers', 'PC Classic', 'Flight, Space & Racing', 'Modern', 'Rhythm', 'Cinema & TV', 'Anime & Mecha'], 'the 16 exact strings');
  for (const label of HUD_PACK_LABELS) assert.ok(/^[\x20-\x7e\u00b7]+$/.test(label), `ASCII plus U+00B7 only: ${label}`);
  assert.equal(HUD_PACK_LABELS.filter(l => l.includes('\u00b7')).length, 2);
  assert.deepEqual([...builtinLabels()], [...HUD_PACK_LABELS, 'HUD packs', 'NERV']); assert.equal(HUD_ROOT_LABEL, 'HUD packs'); assert.equal(NERV_FOLDER_LABEL, 'NERV'); assert.equal(CLASSIC_STYLES, 16);
  const effective = {};
  for (const label of builtinLabels()) {
    const d = builtinDefault(label);
    assert.ok(d, label); assert.equal(d.label, label);
    assert.deepEqual(parseSettings(d.settings), d.settings, `${label}: the bundle is accepted by the setup validator unchanged`);
    assert.deepEqual(canonicalSettings(d.settings), d.settings, `${label}: the bundle is canonical (v2 fields only when non-default)`);
    assert.ok(d.settings.enabled && d.settings.manualFade && d.settings.autoFade && d.settings.keepOld && d.settings.minimumRating === 0);
    assert.ok(Number.isInteger(d.barsPerScene) && d.barsPerScene >= 1 && d.barsPerScene <= 128);
    assert.doesNotThrow(() => parseSceneTiming({...defaultSceneTiming, enabled: true, barsPerScene: d.barsPerScene}));
    assert.ok(d.character.length > 20 && d.character.length < 140 && /^[ -~]+$/.test(d.character), `${label}: a short ASCII description`);
    assert.ok(d.settings.transition >= 0 && d.settings.transition < CLASSIC_STYLES, `${label}: with the classic list only a named style is chosen`);
    assert.ok(Object.isFrozen(d) && Object.isFrozen(d.settings), 'the defaults are immutable');
    effective[label] = effectiveFadeTiming(d.settings);
  }
  // With the full transition list the preferred (newer) style is chosen; the count is the contract's.
  assert.equal(TRANSITION_COUNT, 33);
  const full = label => builtinDefault(label, TRANSITION_COUNT);
  assert.equal(full('Arcade \u00b7 Fighting').settings.transition, 16, 'Beat Step Wipe when it exists'); assert.equal(builtinDefault('Arcade \u00b7 Fighting').settings.transition, 6, 'a classic style otherwise');
  assert.equal(full('Modern').settings.transition, 31, 'Random, all styles'); assert.equal(builtinDefault('Modern').settings.transition, 0);
  for (const label of builtinLabels()) assert.ok(full(label).settings.transition < TRANSITION_COUNT);
  for (const bad of [0, -1, 1.5, NaN, 'x', undefined]) assert.equal(builtinDefault('Neo Geo', bad).settings.transition, builtinDefault('Neo Geo').settings.transition, 'an unusable style count means the classic list');
  // Character per pack: pixel-era packs prefer instant or one-beat cuts; cinematic and anime packs one to two bars; rhythm is tight and beat-locked.
  for (const label of ['Arcade \u00b7 Fighting', 'Arcade \u00b7 Action', 'Neo Geo', 'Vector & Early Arcade', '8/16-bit Consoles', 'Handheld & LCD', 'Home Computers', 'PC Classic']) {
    assert.ok(effective[label] === 1 || effective[label] === 2, `${label}: instant or one beat`);
    assert.ok(builtinDefault(label).barsPerScene <= 4, `${label}: short scenes`);
  }
  assert.equal(effective['Handheld & LCD'], 1, 'the low-fidelity LCD pack cuts instantly'); assert.equal(builtinDefault('Handheld & LCD').settings.transition, TRANSITION_CUT);
  for (const label of ['Cinema & TV', 'Anime & Mecha', '128-bit Consoles', 'Showcase']) assert.ok(effective[label] === 4 || effective[label] === 5, `${label}: one or two bars`);
  assert.equal(effective['Cinema & TV'], 5); assert.ok(builtinDefault('Cinema & TV').barsPerScene >= 8);
  const rhythm = builtinDefault('Rhythm');
  assert.equal(effective.Rhythm, 2); assert.ok(rhythm.barsPerScene <= 2); assert.equal(rhythm.settings.queueQuantize, 1, 'manual changes wait for the next beat');
  assert.equal(builtinDefault('Modern').settings.fadeTiming, 6); assert.equal(builtinDefault('Modern').settings.fadeRandomSet, 28);
  assert.equal(builtinDefault('Showcase').settings.shuffle, false, 'the showcase plays in order'); assert.equal(builtinDefault('NERV').settings.shuffle, false, 'the NERV scene set plays in order');
  assert.ok(new Set(HUD_PACK_LABELS.map(l => JSON.stringify(builtinDefault(l).settings))).size >= 6, 'packs differ from one another');
  assert.ok(new Set(HUD_PACK_LABELS.map(l => builtinDefault(l).character)).size === 16, 'every pack has its own description');
  // Cross-check with the transition table (owned by another stream): every default names a real, non-selector style (or the Random
  // selector deliberately), instant fades pair with Cut, and a style's minimum length fits the default fade.
  let T = null;
  try { T = await loadBrowser(['mpc-transition']); } catch { T = null; }
  if (!T || !T.TRANSITION_META) console.log('note: defaults cross-check with TRANSITION_META skipped (the transition module is not loadable here)');
  else {
    const meta = T.TRANSITION_META;
    assert.equal(meta.length, TRANSITION_COUNT); assert.equal(meta.length, T.TRANSITIONS.length);
    for (const label of builtinLabels()) {
      const d = builtinDefault(label, meta.length), m = meta[d.settings.transition];
      assert.ok(m, `${label}: a named style`);
      const fade = effectiveFadeTiming(d.settings), beats = [null, 0, 1, 2, 4, 8, null][fade];
      if (fade === 1) assert.equal(d.settings.transition, TRANSITION_CUT, `${label}: an instant fade pairs with Cut`);
      else if (m.kind === 'selector') assert.equal(d.settings.transition, 31, `${label}: only Random, all styles is a deliberate selector`);
      else if (beats !== null) assert.ok(m.minBeats <= beats && beats <= m.maxBeats, `${label}: ${m.name} fits ${beats} beat(s)`);
      const classic = builtinDefault(label), c = meta[classic.settings.transition];
      assert.ok(c && (c.kind === 'classic' || classic.settings.transition === 0), `${label}: the fallback is a classic style or classic Random (${c?.name})`);
    }
    assert.deepEqual(['Arcade · Fighting', 'Arcade · Action', 'Vector & Early Arcade', 'Flight, Space & Racing', 'Anime & Mecha', 'Rhythm'].map(l => meta[builtinDefault(l, meta.length).settings.transition].name),
      ['Beat Step Wipe', 'Tile Flip', 'CRT Off', 'Radar Sweep', 'AT Field Iris', 'Beat Step Wipe'], 'the descriptions name the styles the table has');
  }
  // Unknown labels have no default; a slug form maps to the canonical label.
  for (const bad of ['', 'Unknown Pack', 'avs', 'user', null, undefined, 5]) assert.equal(builtinDefault(bad), null, String(bad));
  assert.equal(builtinDefault('neogeo').label, 'Neo Geo'); assert.equal(canonicalPackLabel('arcade-fighting'), 'Arcade \u00b7 Fighting'); assert.equal(canonicalPackLabel('8-16-bit-consoles'), '8/16-bit Consoles');
  assert.equal(canonicalPackLabel('Flight, Space & Racing'), 'Flight, Space & Racing'); assert.equal(canonicalPackLabel('flight-space-racing'), 'Flight, Space & Racing');
  assert.equal(canonicalPackLabel('nonsense'), null); assert.equal(canonicalPackLabel(''), null); assert.equal(canonicalPackLabel(3), null);
  assert.equal(packOrder('Showcase'), 0); assert.equal(packOrder('Anime & Mecha'), 15); assert.equal(packOrder('somewhere else'), 16); assert.equal(packOrder('neogeo'), 3);
  // Static public data: no titles, no private paths, no non-ASCII beyond the middle dot.
  const source = readFileSync(new URL('../src/mpc-folder-defaults.ts', import.meta.url), 'utf8');
  assert.ok(!/hud-titles|C:\\|Users|\.wiki|localStorage|fetch\(/.test(source), 'the table is inert public data');
  assert.equal([...source].filter(c => c.charCodeAt(0) > 126 && c !== '\u00b7').length, 0, 'ASCII source, apart from U+00B7');
}

// ---------------------------------------------------------------------------------------------------- Play folder on the HUD packs uses the built-in default
{
  const hudRoot = id(tree, 'hud');
  const hudIds = catalog.map((p, i) => i).filter(i => catalog[i].kind === 'hud');
  for (const label of HUD_PACK_LABELS) {
    const key = `hud/${label.replace(/\//g, '|')}`;
    const plan = planFolderPlay(tree, rs, catalog, request(key, {label}));
    assert.equal(plan.ok, true, label); assert.equal(plan.options, 'builtin', `${label}: Play folder works at once, with no saved bundle`);
    const def = builtinDefault(label);
    assert.deepEqual(plan.settings, def.settings); assert.equal(plan.timing.enabled, true); assert.equal(plan.timing.barsPerScene, def.barsPerScene);
    assert.equal(plan.timing.bpm, 120, 'no trusted tempo: 120'); assert.equal(plan.note, def.character);
    assert.equal(defaultLabelFor(tree, id(tree, key)), label);
  }
  const bpm = planFolderPlay(tree, rs, catalog, request('hud/Rhythm', {bpm: 133.456}));
  assert.equal(bpm.timing.bpm, 133.46, 'the trusted live tempo is used, rounded');
  for (const bad of [0, 5, 401, NaN, Infinity, null]) assert.equal(planFolderPlay(tree, rs, catalog, request('hud/Rhythm', {bpm: bad})).timing.bpm, 120, `bad tempo ${bad}`);
  // The seed of the scene clock is a pure function of the folder key: replay after a seek or a restart is the same.
  const seeds = HUD_PACK_LABELS.map(l => planFolderPlay(tree, rs, catalog, request(`hud/${l.replace(/\//g, '|')}`)).timing.seed);
  assert.deepEqual(seeds, HUD_PACK_LABELS.map(l => planFolderPlay(tree, rs, catalog, request(`hud/${l.replace(/\//g, '|')}`, {seed: 99})).timing.seed), 'independent of the shuffle seed');
  assert.ok(new Set(seeds).size >= 14, 'different packs, different clock seeds');
  // A bucket and a title folder inside a pack map to the pack's default; the HUD root and a mixed HUD selection to the root default.
  const neo = id(tree, 'hud/Neo Geo');
  const bucket = tree.nodes[neo].children[0], title = tree.nodes[bucket].children[0];
  for (const n of [bucket, title]) assert.equal(planFolderPlay(tree, rs, catalog, request(tree.nodes[n].key)).settings.transition, builtinDefault('Neo Geo').settings.transition);
  const root = planFolderPlay(tree, rs, catalog, request('hud'));
  assert.equal(root.options, 'builtin'); assert.deepEqual(root.settings, builtinDefault('HUD packs').settings);
  assert.equal(root.order.length, hudIds.length, 'every HUD scene of the estate is playable (auto and tuned tiers included)');
  const nerv = planFolderPlay(tree, rs, catalog, request('nerv'));
  assert.equal(nerv.options, 'builtin'); assert.equal(nerv.settings.shuffle, false); assert.equal(nerv.timing.barsPerScene, 8); assert.equal(nerv.order.length, 16);
  // Results of only scene presets get the HUD or NERV default; a mixed selection keeps the live settings.
  const hudResults = planFolderPlay(tree, rs, catalog, request('avs', {results: Int32Array.from(hudIds.slice(0, 5))}));
  assert.equal(hudResults.options, 'builtin'); assert.deepEqual(hudResults.settings, builtinDefault('HUD packs').settings);
  const nervResults = planFolderPlay(tree, rs, catalog, request('avs', {results: Int32Array.from(catalog.map((p, i) => i).filter(i => catalog[i].kind === 'nerv'))}));
  assert.deepEqual(nervResults.settings, builtinDefault('NERV').settings);
  const mixed = planFolderPlay(tree, rs, catalog, request('avs', {results: Int32Array.from([hudIds[0], playable[0]])}));
  assert.equal(mixed.options, 'live'); assert.equal(mixed.settings, null);
  // A saved bundle always beats the built-in default; turning the option off keeps the live settings.
  const own = planFolderPlay(tree, rs, catalog, request('hud/Neo Geo', {saved: {recursive: true, sort: [], settings: {...LIVE, transition: 3}}}));
  assert.equal(own.options, 'saved'); assert.equal(own.settings.transition, 3);
  const off = planFolderPlay(tree, rs, catalog, request('hud/Neo Geo', {useSaved: false}));
  assert.equal(off.options, 'live'); assert.equal(off.settings, null); assert.equal(off.timing, null);
  // The styles argument reaches the default: a build with 33 styles gets the preferred one.
  assert.equal(planFolderPlay(tree, rs, catalog, request('hud/Arcade \u00b7 Fighting', {styles: 33})).settings.transition, 16);
  assert.equal(planFolderPlay(tree, rs, catalog, request('hud/Arcade \u00b7 Fighting')).settings.transition, 6);
  // Determinism: the same request gives the same plan.
  assert.deepEqual(planFolderPlay(tree, rs, catalog, request('hud/Modern', {sort: [{key: 'random', dir: 'asc'}]})), planFolderPlay(tree, rs, catalog, request('hud/Modern', {sort: [{key: 'random', dir: 'asc'}]})));
}

// ---------------------------------------------------------------------------------------------------- the status message
{
  const plan = (extra = {}) => ({ok: true, key: 'k', label: 'tuggummi', order: [1, 2, 3], total: 3, skipped: {unavailable: 0, missing: 0, partial: 0}, startAt: null, settings: null, timing: null, options: 'live', note: '', ...extra});
  assert.equal(playMessage(plan(), 3, true), 'Playing 3 presets from tuggummi. Live settings kept.');
  assert.equal(playMessage(plan(), 1, true), 'Playing 1 preset from tuggummi. Live settings kept.');
  assert.equal(playMessage(plan(), 3, false), 'Playing 3 presets from tuggummi. Auto is off: use Next/Previous.');
  assert.equal(playMessage(plan({options: 'saved'}), 1234, false), 'Playing 1,234 presets from tuggummi. Folder options applied.');
  assert.equal(playMessage(plan({options: 'builtin', note: 'Punchy.'}), 3, true), 'Playing 3 presets from tuggummi. Built-in defaults applied: Punchy.');
  assert.equal(playMessage(plan({skipped: {unavailable: 2, missing: 1, partial: 4}}), 3, true), 'Playing 3 presets from tuggummi. Left out: 2 unavailable, 1 missing, 4 partial. Live settings kept.');
}

// ---------------------------------------------------------------------------------------------------- the host's entry: order sanitising and the overlay line
{
  const c = parse([row(1, 'A', [['visbot-legacy-a-0000000000', 'a.avs']]), row(2, 'B', [['visbot-legacy-a-0000000000', 'b.avs']], {parse: 'parse-error'}), row(3, 'C', [['visbot-legacy-a-0000000000', 'c.avs']])]);
  assert.deepEqual(sanitizeOrder([2, 1, 0, 2, 0, 9, -1, 1.5, NaN, 3], c), {order: [2, 0], dropped: 8}, 'integers in range, unique, parseable; the rest counted, nothing thrown');
  assert.equal(sanitizeOrder([1], c), null, 'only an unparseable member: refused'); assert.equal(sanitizeOrder([], c), null, 'empty: refused'); assert.equal(sanitizeOrder(null, c), null);
  assert.equal(sanitizeOrder(['0', 5], c), null, 'wrong types never pass');
  const big = Array.from({length: 4000}, (_, k) => k % 3), got = sanitizeOrder(big, c);
  assert.deepEqual(got.order, [0, 2]); assert.equal(got.dropped, 4000 - 2, 'thousands of entries: no cap, no throw');
  const plan = planFolderPlay(tree, rs, catalog, request('avs'));
  assert.deepEqual(sanitizeOrder(plan.order, catalog), {order: plan.order, dropped: 0}, 'a plan from planFolderPlay passes through unchanged');
  // The overlay line: the tail is the text the line has always carried; a prefix names the source.
  const base = {index: 11, catalogLength: 3409, name: 'Tuggummi - Intro', rating: 3, notWorking: false, shuffle: false};
  assert.equal(overlayText({...base, source: {kind: 'library'}}), 'Library · 12 / 3409 · Tuggummi - Intro ★★★');
  assert.equal(overlayText({...base, source: {kind: 'library'}, rating: 0, notWorking: true}), 'Library · 12 / 3409 · Tuggummi - Intro  · NOT WORKING', 'unrated keeps the legacy spacing');
  assert.equal(overlayText({...base, source: {kind: 'folder', key: 'k', label: 'tuggummi', total: 756}, position: 12, poolSize: 756}), 'Folder: tuggummi (756) · 12 / 756 · Tuggummi - Intro ★★★');
  assert.equal(overlayText({...base, source: {kind: 'folder', key: 'k', label: 'tuggummi', total: 756}, position: 12, poolSize: 756, shuffle: true}), 'Folder: tuggummi (756) · random · Tuggummi - Intro ★★★', 'no position while shuffling');
  assert.equal(overlayText({...base, source: {kind: 'setup', label: 'Late night'}, position: 3, poolSize: 12}), 'Setup: Late night · 3 / 12 · Tuggummi - Intro ★★★');
  assert.equal(overlayText({...base, source: {kind: 'setup', label: 'Late night'}}), 'Setup: Late night · ? / 0 · Tuggummi - Intro ★★★', 'a preset outside the pool has no place yet');
  assert.equal(overlayText({...base, source: {kind: 'library'}, rating: 99}), 'Library · 12 / 3409 · Tuggummi - Intro ★★★★★', 'the rating is clamped');
  assert.equal(overlayText({...base, source: {kind: 'library'}, rating: NaN, index: -5, catalogLength: NaN}), 'Library · 0 / 0 · Tuggummi - Intro ', 'garbage numbers never print NaN');
}

// ---------------------------------------------------------------------------------------------------- PoolCache
{
  const rows = Array.from({length: 30}, (_, k) => row(k + 1, `P${k}`, [['visbot-legacy-a-0000000000', `p${k}.avs`]], {...(k % 5 === 0 ? {rating: 4} : {}), ...(k === 7 ? {notWorking: true} : {}), ...(k === 9 ? {parse: 'parse-error'} : {})}));
  const c = parse(rows), order = Array.from({length: 30}, (_, k) => k), failed = new Set([2]);
  const cache = new PoolCache();
  const first = cache.get(order, c, false, 0, failed, 0);
  assert.deepEqual(first, eligiblePresets(c, order, false, 0, failed), 'the pool equals the eligibility rule');
  assert.ok(!first.includes(7) && !first.includes(9) && !first.includes(2));
  assert.equal(cache.get(order, c, false, 0, failed, 0), first, 'same arguments: the same array');
  const rev = cache.poolRevision;
  // Every component of the key is a miss when it changes.
  const other = [...order];
  let pool = cache.get(other, c, false, 0, failed, 0); assert.notEqual(pool, first, 'a new order array is a miss'); assert.deepEqual(pool, first);
  const c2 = [...c]; const before = pool; pool = cache.get(other, c2, false, 0, failed, 0); assert.notEqual(pool, before, 'a new catalog array is a miss');
  const shuffled = cache.get(other, c2, true, 4, failed, 0); assert.notEqual(shuffled, pool, 'shuffle and minimum rating are part of the key');
  assert.deepEqual(shuffled, eligiblePresets(c2, other, true, 4, failed)); assert.deepEqual(shuffled.slice().sort((a, b) => a - b), [0, 5, 10, 15, 20, 25]);
  const again = cache.get(other, c2, true, 4, failed, 0); assert.equal(again, shuffled);
  assert.notEqual(cache.get(other, c2, true, 3, failed, 0), shuffled, 'a different minimum rating');
  const withRating = cache.get(other, c2, true, 3, failed, 0);
  assert.notEqual(cache.get(other, c2, true, 3, failed, 1), withRating, 'a new revision is a miss (the session failed set changed)');
  assert.ok(cache.poolRevision > rev);
  // `failed` itself is not compared: the caller bumps the revision when it changes, and the recomputed pool reflects it.
  const f2 = new Set([2, 5]);
  const stale = cache.get(other, c2, true, 3, f2, 1); assert.equal(stale, cache.get(other, c2, true, 3, f2, 1));
  const fresh = cache.get(other, c2, true, 3, f2, 2); assert.ok(!fresh.includes(5), 'the bumped revision recomputes with the new failed set'); assert.ok(stale.includes(5), 'and the stale pool was the old answer');
  // Memoised phases are cleared with the pool and bounded.
  let computed = 0;
  const memo = () => cache.memoPhase('a', () => { computed++; return {value: computed}; });
  const m1 = memo(); assert.equal(memo(), m1); assert.equal(computed, 1, 'computed once while the pool is stable');
  cache.get(other, c2, true, 3, f2, 2); assert.equal(memo(), m1, 'a hit keeps the memo');
  cache.get(other, c2, true, 3, f2, 3); assert.notEqual(memo(), m1); assert.equal(computed, 2, 'a recomputed pool clears the memo');
  for (let k = 0; k < 20; k++) cache.memoPhase(`k${k}`, () => k);
  let recomputed = 0; cache.memoPhase('k0', () => { recomputed++; return 0; }); assert.equal(recomputed, 1, 'the memo keeps only its newest entries');
  cache.memoPhase('k19', () => { recomputed += 10; return 0; }); assert.equal(recomputed, 1, 'and the newest is still there');
  const rv = cache.poolRevision; cache.clear(); assert.ok(cache.poolRevision > rv); assert.notEqual(cache.get(other, c2, true, 3, f2, 3), fresh);
  assert.equal(new PoolCache().memoPhase('x', () => 5), 5);
}

// ---------------------------------------------------------------------------------------------------- the song clock over a large pool: replay is a pure function of position
{
  const all = planFolderPlay(tree, rs, catalog, request('avs'));
  const timing = parseSceneTiming({enabled: true, bpm: 128, offsetSeconds: 0.75, barsPerScene: 4, seed: 4242});
  const cache = new PoolCache();
  const pool = cache.get(all.order, catalog, true, 0, new Set(), 0);
  assert.ok(pool.length > 3000);
  const rand = mulberry32(5), positions = Array.from({length: 40}, () => rand() * 4000);
  const direct = positions.map(p => sceneAt(p, pool, timing, true));
  assert.ok(direct.every(x => x && Number.isInteger(x.index) && pool.includes(x.index)), 'every position lands on a pooled preset');
  // Any order of evaluation (forwards, backwards, a fresh cache, memoised phases) gives the same answers: a seek changes nothing.
  const memoed = positions.map(p => cache.memoPhase(`${p}`, () => sceneAt(p, cache.get(all.order, catalog, true, 0, new Set(), 0), timing, true)));
  assert.deepEqual(memoed, direct);
  assert.deepEqual([...positions].reverse().map(p => sceneAt(p, pool, timing, true)).reverse(), direct, 'backwards evaluation');
  const fresh = new PoolCache().get(all.order, catalog, true, 0, new Set(), 0);
  assert.deepEqual(fresh, pool, 'a fresh cache computes the identical pool');
  assert.deepEqual(positions.map(p => sceneAt(p, fresh, timing, true)), direct);
  assert.deepEqual(sceneAt(10, pool, timing, true), sceneAt(10, pool, timing, true), 'repeat');
  const reseeded = positions.map(p => sceneAt(p, pool, {...timing, seed: 4243}, true).index);
  assert.notDeepEqual(reseeded, direct.map(x => x.index), 'another seed reshuffles');
  // A marked preset leaves the shuffled pool live once the caller bumps the revision; the cache never serves the old pool.
  const victim = pool[5];
  const marked = catalog.map((p, i) => i === victim ? {...p, notWorking: true} : p);
  const stillOld = cache.get(all.order, catalog, true, 0, new Set(), 0);
  assert.equal(stillOld, pool);
  const updated = cache.get(all.order, marked, true, 0, new Set(), 0);
  assert.ok(!updated.includes(victim) && updated.length === pool.length - 1, 'a new catalog array (the host replaces elements on a mark) is a miss');
  // Cost: the cached pool is essentially free to ask for, while recomputing 3,400+ entries is not.
  const t0 = performance.now();
  for (let k = 0; k < 5000; k++) cache.get(all.order, marked, true, 0, new Set(), 0);
  assert.ok(performance.now() - t0 < 100, 'five thousand cached lookups');
}

console.log('Folder play PASS: recursion, sorting, results mode, manual folders and ghosts, 4,000-member order with no 500 cap (setups still refuse 501), partial skipping, saved/live/built-in settings, the 16 pack defaults (exact labels, pixel-era vs cinematic vs rhythm character, style fallback), the status message, order sanitising and the overlay line, PoolCache keys/phases, seek-replay determinism over a large pool');
