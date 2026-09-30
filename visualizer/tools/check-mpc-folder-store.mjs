import assert from 'node:assert/strict';
import {loadBrowser} from './fixtures-folders.mjs';
// folders.json v1: parsing, limits, forward compatibility, edit helpers and the save queue (docs/design/PRESET-BROWSER-V2.md 5, 12). CPU only.
const B = await loadBrowser();
const {FOLDER_LIMITS, parseFolderState, serializeFolderState, emptyFolderState, FolderStateError, FolderStore, StateChannel, isFolderKey, utf8Length, createFolder, renameFolder,
  deleteFolder, addMembers, removeMembers, moveMember, setPlayback, clearPlayback, setLast, setUi, folderDepth, totalMembers, parseSetups, defaultSettings, STATE_MAX_BYTES,
  updateSearch, stateErrorFor, isUnsupportedState, systemTimers} = B;
const H = n => n.toString(16).padStart(64, '0');
const ok = value => parseFolderState(value);
const bad = (value, message) => assert.throws(() => parseFolderState(value), e => e instanceof FolderStateError && !e.newer, message);
const folder = (id, extra = {}) => ({id, name: `Folder ${id}`, parent: null, kind: 'manual', presets: [], created: 1790000000000, ...extra});
const doc = (extra = {}) => ({version: 1, ...extra});
const settings = {enabled: true, bars: 8, shuffle: true, minimumRating: 0, transition: 0, beats: 2, durationMs: 1000, keepOld: true, manualFade: true, autoFade: true};

// ---------------------------------------------------------------------------------------------------- limits pinned
assert.deepEqual({...FOLDER_LIMITS}, {folders: 200, depth: 4, members: 5000, totalMembers: 30000, name: 120, id: 100, query: 400, key: 400, playback: 300, expanded: 300, sort: 3, bytes: 3670016});
assert.equal(FOLDER_LIMITS.bytes, STATE_MAX_BYTES);

// ---------------------------------------------------------------------------------------------------- the empty and the rich state
{
  const empty = ok(doc());
  assert.deepEqual(empty, emptyFolderState()); assert.equal(empty.rev, 0);
  assert.deepEqual(ok(doc({folders: [], playback: {}, last: null, ui: {}})), empty);
  const rich = doc({rev: 12, folders: [
    folder('a', {name: 'Late night', presets: [H(1), H(2)], sort: [{key: 'manual', dir: 'asc'}]}),
    {id: 'b', name: 'Fast + rated', parent: 'a', kind: 'smart', query: 'rating:>=3 -is:broken', scope: 'avs', sort: [{key: 'rating', dir: 'desc'}, {key: 'name', dir: 'asc'}], created: 5},
    {id: 'c', name: 'Loose', parent: null, kind: 'smart', query: '', created: 6},
  ], playback: {
    'avs/src/c:visbot-legacy/a:someone': {recursive: false, sort: [{key: 'path', dir: 'asc'}], skipPartial: true, settings, timing: {enabled: false, bpm: 120, offsetSeconds: 0, barsPerScene: 8, seed: 1}},
    'hud/Neo Geo': {recursive: true, sort: [], settings: {...settings, fadeTiming: 6, fadeRandomSet: 28, fadeAnchor: 1, queueQuantize: 1, transition: 31}},
    'user:a': {sort: [{key: 'manual', dir: 'asc'}]},
  }, last: {key: 'avs/src/c:visbot-legacy/a:someone', recursive: true}, ui: {expanded: ['avs', 'avs/src', 'user:a', 'smart:favorites'], selected: 'avs', sort: [{key: 'name', dir: 'asc'}], scopeAll: true}});
  const state = ok(rich);
  assert.equal(state.rev, 12); assert.equal(state.folders.length, 3);
  assert.equal(state.folders[2].scope, null, 'a smart folder without a scope has none'); assert.equal(state.folders[1].scope, 'avs');
  assert.equal(state.playback['user:a'].recursive, true, 'recursive defaults to on'); assert.deepEqual(state.playback['user:a'].sort, [{key: 'manual', dir: 'asc'}]);
  assert.equal(state.playback['hud/Neo Geo'].settings.fadeRandomSet, 28, 'the v2 fade fields are accepted');
  assert.deepEqual(state.opaquePlayback, {});
  assert.deepEqual(state.last, {key: 'avs/src/c:visbot-legacy/a:someone', recursive: true}); assert.equal(state.ui.scopeAll, true); assert.equal(state.ui.selected, 'avs');
  // Round trip: serialise, JSON, parse; then idempotent.
  const wire = JSON.parse(JSON.stringify(serializeFolderState(state)));
  assert.equal(wire.version, 1);
  const again = ok(wire);
  assert.deepEqual(again, state, 'parse(serialize(state)) equals the state');
  assert.deepEqual(JSON.parse(JSON.stringify(serializeFolderState(again))), wire, 'serialisation is idempotent');
  assert.deepEqual(Object.keys(wire).sort(), ['folders', 'last', 'playback', 'rev', 'ui', 'version']);
  assert.deepEqual(wire.folders[0], {id: 'a', name: 'Late night', parent: null, kind: 'manual', presets: [H(1), H(2)], sort: [{key: 'manual', dir: 'asc'}], created: 1790000000000});
  assert.deepEqual(wire.folders[1].query, 'rating:>=3 -is:broken'); assert.equal(wire.folders[1].presets, undefined, 'a smart folder stores no members');
  assert.equal(wire.playback['avs/src/c:visbot-legacy/a:someone'].skipPartial, true); assert.equal(wire.playback['user:a'].skipPartial, undefined, 'default-valued flags are omitted');
  // Unknown top-level and folder fields are ignored, never kept.
  const noisy = ok({...rich, futureThing: {x: 1}, folders: rich.folders.map(f => ({...f, colour: 'red'}))});
  assert.equal(JSON.stringify(serializeFolderState(noisy)).includes('futureThing'), false); assert.equal(JSON.stringify(serializeFolderState(noisy)).includes('colour'), false);
  // The state is independent of the input object.
  const input = doc({folders: [folder('z', {presets: [H(9)]})]}); const parsed = ok(input); input.folders[0].presets.push(H(8)); assert.deepEqual(parsed.folders[0].presets, [H(9)]);
}

// ---------------------------------------------------------------------------------------------------- structure errors
for (const [name, value] of [['null', null], ['array', []], ['string', '{}'], ['number', 1], ['no version', {}], ['version 0', {version: 0}], ['version string', {version: '1'}], ['version 1.5', {version: 1.5}], ['version -1', {version: -1}]]) bad(value, name);
bad(doc({rev: -1})); bad(doc({rev: 1.5})); bad(doc({rev: '1'})); bad(doc({folders: {}})); bad(doc({folders: 'x'})); bad(doc({folders: [null]})); bad(doc({folders: ['x']}));
bad(doc({folders: [folder('a', {id: ''})]}), 'empty id'); bad(doc({folders: [folder('a', {id: 5})]})); bad(doc({folders: [folder('a', {id: 'x\u0000y'})]}), 'control character in id');
bad(doc({folders: [folder('a'), folder('a')]}), 'duplicate id'); bad(doc({folders: [folder('a', {name: ''})]})); bad(doc({folders: [folder('a', {name: '   '})]}), 'blank name'); bad(doc({folders: [folder('a', {name: 'x\ny'})]}));
bad(doc({folders: [folder('a', {name: 5})]})); bad(doc({folders: [folder('a', {kind: 'other'})]})); bad(doc({folders: [folder('a', {created: 'x'})]})); bad(doc({folders: [folder('a', {created: -1})]})); bad(doc({folders: [folder('a', {created: Infinity})]}));
bad(doc({folders: [folder('a', {parent: 5})]}), 'parent type'); bad(doc({folders: [folder('a', {parent: 'ghost'})]}), 'parent that does not exist');
bad(doc({folders: [folder('a', {presets: [H(1), H(1)]})]}), 'duplicate members'); bad(doc({folders: [folder('a', {presets: ['nothex']})]})); bad(doc({folders: [folder('a', {presets: [H(255).toUpperCase()]})]}), 'upper-case hash');
bad(doc({folders: [folder('a', {presets: [`${H(1)}0`]})]}), 'too long hash'); bad(doc({folders: [folder('a', {presets: 'x'})]})); bad(doc({folders: [folder('a', {presets: [5]})]}));
bad(doc({folders: [{...folder('s'), kind: 'smart', presets: undefined}]}), 'a smart folder needs a query'); bad(doc({folders: [{id: 's', name: 'S', parent: null, kind: 'smart', query: 5, created: 1}]}));
bad(doc({folders: [{id: 's', name: 'S', parent: null, kind: 'smart', query: 'x', scope: 'nowhere', created: 1}]}), 'a scope must be a folder key'); bad(doc({folders: [{id: 's', name: 'S', parent: null, kind: 'smart', query: 'x', scope: 5, created: 1}]}));
bad(doc({folders: [folder('a', {sort: 'name'})]})); bad(doc({folders: [folder('a', {sort: [{key: 'colour', dir: 'asc'}]})]}), 'unknown sort key'); bad(doc({folders: [folder('a', {sort: [{key: 'name', dir: 'up'}]})]}));
bad(doc({playback: []})); bad(doc({playback: 'x'})); bad(doc({playback: {'not a key': {}}}), 'a playback key must be a folder key'); bad(doc({playback: JSON.parse('{"__proto__":{"recursive":true}}')}), '__proto__ is not a folder key');
bad(doc({playback: {constructor: {}}}), 'constructor is not a folder key');
// A single-name folder with a valid id and a smart scope, exactly at the maximum lengths, is fine.
ok(doc({folders: [folder('x'.repeat(100), {name: 'n'.repeat(120)})]}));
ok(doc({folders: [{id: 's', name: 'S', parent: null, kind: 'smart', query: 'q'.repeat(400), scope: `avs/${'k'.repeat(396)}`, created: 1}]}));

// ---------------------------------------------------------------------------------------------------- every cap: accepted at N, rejected at N+1
{
  const many = n => Array.from({length: n}, (_, k) => folder(`f${k}`));
  ok(doc({folders: many(200)})); bad(doc({folders: many(201)}), 'folders 201');
  ok(doc({folders: [folder('x'.repeat(100))]})); bad(doc({folders: [folder('x'.repeat(101))]}), 'id 101');
  ok(doc({folders: [folder('n', {name: 'n'.repeat(120)})]})); bad(doc({folders: [folder('n', {name: 'n'.repeat(121)})]}), 'name 121');
  const members = n => Array.from({length: n}, (_, k) => H(k + 1));
  ok(doc({folders: [folder('m', {presets: members(5000)})]})); bad(doc({folders: [folder('m', {presets: members(5001)})]}), 'members 5001');
  const six = Array.from({length: 6}, (_, k) => folder(`t${k}`, {presets: members(5000)}));
  ok(doc({folders: six})); bad(doc({folders: [...six, folder('t6', {presets: [H(1)]})]}), 'total members 30001');
  ok(doc({folders: [{id: 'q', name: 'Q', parent: null, kind: 'smart', query: 'q'.repeat(400), created: 1}]})); bad(doc({folders: [{id: 'q', name: 'Q', parent: null, kind: 'smart', query: 'q'.repeat(401), created: 1}]}), 'query 401');
  // Depth: four levels of nesting are fine, a fifth is not.
  const chain = n => Array.from({length: n}, (_, k) => folder(`d${k}`, {parent: k ? `d${k - 1}` : null}));
  ok(doc({folders: chain(4)})); bad(doc({folders: chain(5)}), 'depth 5');
  ok(doc({folders: chain(4).reverse()})); // child listed before its parent
  bad(doc({folders: [folder('a', {parent: 'b'}), folder('b', {parent: 'a'})]}), 'cycle'); bad(doc({folders: [folder('a', {parent: 'a'})]}), 'self parent');
  // Playback entries and keys.
  const keys = n => Object.fromEntries(Array.from({length: n}, (_, k) => [`avs/k${k}`, {}]));
  ok(doc({playback: keys(300)})); bad(doc({playback: keys(301)}), 'playback 301');
  ok(doc({playback: {[`avs/${'k'.repeat(396)}`]: {}}})); bad(doc({playback: {[`avs/${'k'.repeat(397)}`]: {}}}), 'key 401');
  // Sort specs: three keys, not four (playback sort falls back to opaque; folder sort is an error).
  const sort = n => Array.from({length: n}, () => ({key: 'name', dir: 'asc'}));
  ok(doc({folders: [folder('s', {sort: sort(3)})]})); bad(doc({folders: [folder('s', {sort: sort(4)})]}), 'folder sort 4');
  assert.equal(Object.keys(ok(doc({playback: {'avs/x': {sort: sort(3)}}})).playback).length, 1);
  assert.deepEqual(Object.keys(ok(doc({playback: {'avs/x': {sort: sort(4)}}})).opaquePlayback), ['avs/x'], 'playback sort 4 is kept opaque');
  // Expanded entries beyond 300 are cut, not rejected (a convenience field); unknown keys are dropped.
  const expanded = Array.from({length: 320}, (_, k) => `avs/e${k}`);
  assert.equal(ok(doc({ui: {expanded}})).ui.expanded.length, 300); assert.equal(ok(doc({ui: {expanded: ['avs', 'zzz', 5, 'user:a']}})).ui.expanded.length, 2);
  assert.equal(ok(doc({ui: {sort: sort(4)}})).ui.sort.length, 0, 'a bad ui sort resets to none'); assert.equal(ok(doc({ui: {selected: 'nope'}})).ui.selected, null); assert.equal(ok(doc({ui: 5})).ui.scopeAll, false);
  assert.equal(ok(doc({last: {key: 'zzz', recursive: true}})).last, null); assert.equal(ok(doc({last: {key: 'avs', recursive: 'yes'}})).last, null); assert.deepEqual(ok(doc({last: {key: 'avs', recursive: false}})).last, {key: 'avs', recursive: false});
}

// ---------------------------------------------------------------------------------------------------- forward compatibility
{
  for (const version of [2, 3, 99]) {
    let caught;
    try { parseFolderState({version, folders: 'anything'}); } catch (e) { caught = e; }
    assert.ok(caught instanceof FolderStateError && caught.newer === true, `version ${version} is newer`);
  }
  // A playback entry that fails validation is kept verbatim, listed as opaque, and written back unchanged.
  const future = {recursive: true, sort: [], settings: {...settings, transition: 99}, extraFuture: {a: [1, 2]}};
  const badTiming = {recursive: true, sort: [], timing: {enabled: 'yes'}};
  const notObject = 'from the future';
  const state = ok(doc({playback: {'avs/a': future, 'avs/b': {recursive: true, sort: [], settings}, 'avs/c': badTiming, 'avs/d': notObject, 'avs/e': {recursive: 'maybe'}, 'avs/f': {settings: {...settings, bars: 3}}}}));
  assert.deepEqual(Object.keys(state.playback), ['avs/b']); assert.deepEqual(Object.keys(state.opaquePlayback).sort(), ['avs/a', 'avs/c', 'avs/d', 'avs/e', 'avs/f']);
  const wire = JSON.parse(JSON.stringify(serializeFolderState(state)));
  assert.deepEqual(wire.playback['avs/a'], future, 'opaque entries are re-emitted unchanged'); assert.equal(wire.playback['avs/d'], notObject);
  assert.deepEqual(ok(wire).opaquePlayback, state.opaquePlayback);
  // Editing the valid entry never disturbs the opaque ones; replacing an opaque key supersedes it.
  const editable = ok(wire); setPlayback(editable, 'avs/a', {recursive: false, sort: []});
  assert.equal(editable.opaquePlayback['avs/a'], undefined); assert.equal(editable.playback['avs/a'].recursive, false); assert.deepEqual(JSON.parse(JSON.stringify(serializeFolderState(editable))).playback['avs/c'], badTiming);
  // Parity: a bundle is accepted here exactly when parseSetups accepts the same settings and timing.
  const timings = [undefined, {enabled: true, bpm: 128, offsetSeconds: 1.5, barsPerScene: 4, seed: 7}, {enabled: true, bpm: 5, offsetSeconds: 0, barsPerScene: 4, seed: 7}, {enabled: 'x'}, null, {...{enabled: false, bpm: 120, offsetSeconds: 0, barsPerScene: 8, seed: 1}, version: 2, beatsPerBar: 3},
    {enabled: false, bpm: 120, offsetSeconds: 0, barsPerScene: 8, seed: 1, version: 2, beatsPerBar: 99}];
  const variants = [];
  for (const transition of [-1, 0, 1, 15, 16, 31, 32, 33, 1.5, '1', null]) variants.push({...settings, transition});
  for (const bars of [0, 2, 3, 4, 8, 12, 16]) variants.push({...settings, bars});
  for (const beats of [0, 1, 2, 3, 4, 8]) variants.push({...settings, beats});
  for (const durationMs of [249, 250, 8000, 8001, 1000.5]) variants.push({...settings, durationMs});
  for (const minimumRating of [-1, 0, 5, 6, 1.5, '3', null, undefined]) variants.push({...settings, minimumRating});
  for (const fadeTiming of [-1, 0, 6, 7, 1.5, null]) variants.push({...settings, fadeTiming});
  for (const fadeRandomSet of [0, 1, 31, 32]) variants.push({...settings, fadeRandomSet});
  for (const fadeAnchor of [-1, 0, 2, 3]) variants.push({...settings, fadeAnchor});
  for (const queueQuantize of [-1, 0, 3, 4]) variants.push({...settings, queueQuantize});
  variants.push({...settings, enabled: 'yes'}, null, [], {}, 'x', {...settings, keepOld: 1});
  let accepted = 0, refused = 0;
  for (const s of variants) for (const timing of timings) {
    let setupsOk = true;
    try { parseSetups([{id: 'p', name: 'P', presets: [], settings: s, ...(timing !== undefined ? {timing} : {})}]); } catch { setupsOk = false; }
    const entry = {recursive: true, sort: [], settings: s, ...(timing !== undefined ? {timing} : {})};
    const parsed = ok(doc({playback: {'avs/p': entry}}));
    assert.equal('avs/p' in parsed.playback, setupsOk, `parity for ${JSON.stringify(s)} ${JSON.stringify(timing)}`);
    assert.equal('avs/p' in parsed.opaquePlayback, !setupsOk);
    setupsOk ? accepted++ : refused++;
  }
  assert.ok(accepted > 40 && refused > 100, `the parity matrix is not vacuous (${accepted} accepted, ${refused} refused)`);
}

// ---------------------------------------------------------------------------------------------------- folder keys
{
  for (const key of ['avs', 'avs/src/c:visbot-legacy/a:x', 'nerv', 'hud/Neo Geo', 'smart:favorites', 'user:3f0c', 'smart', 'user', `avs/${'k'.repeat(396)}`, 'hud/8|16-bit Consoles', 'avs/é']) assert.ok(isFolderKey(key), key);
  for (const key of ['', '__proto__', 'constructor', 'toString', 'avsx', 'foo/bar', 'smart:', 'user:', 5, null, undefined, `avs/${'k'.repeat(397)}`, ' avs']) assert.equal(isFolderKey(key), false, String(key));
}

// ---------------------------------------------------------------------------------------------------- edit helpers
{
  const s = emptyFolderState();
  const a = createFolder(s, {id: 'a', name: '  Night  ', kind: 'manual', created: 1});
  assert.equal(a.name, 'Night', 'names are trimmed'); assert.deepEqual(a.presets, []);
  assert.throws(() => createFolder(s, {id: 'a', name: 'Dup', kind: 'manual', created: 1}), /Invalid folder id/); assert.throws(() => createFolder(s, {id: 'x', name: '  ', kind: 'manual', created: 1}), /name/);
  assert.throws(() => createFolder(s, {id: 'x', name: 'n'.repeat(121), kind: 'manual', created: 1}), /name/); assert.throws(() => createFolder(s, {id: 'x', name: 'ok', kind: 'manual', parent: 'ghost', created: 1}), /parent/);
  assert.throws(() => createFolder(s, {id: 'x', name: 'ok', kind: 'smart', query: 'q'.repeat(401), created: 1}), /saved search/); assert.throws(() => createFolder(s, {id: 'x', name: 'ok', kind: 'smart', query: 'q', scope: 'bogus', created: 1}), /scope/);
  assert.equal(s.folders.length, 1, 'a refused create changes nothing');
  const smart = createFolder(s, {id: 'q', name: 'Search', kind: 'smart', query: 'rating:5', scope: 'avs', created: 2}); assert.equal(smart.presets, undefined); assert.equal(smart.query, 'rating:5');
  // Depth: 4 levels allowed.
  let parent = 'a'; for (const id of ['b', 'c', 'd']) { createFolder(s, {id, name: id, kind: 'manual', parent, created: 3}); parent = id; }
  assert.equal(folderDepth(s, 'd'), 4); assert.throws(() => createFolder(s, {id: 'e', name: 'e', kind: 'manual', parent: 'd', created: 3}), /nested 4 levels/);
  ok(serializeFolderState(s)); // what the helpers produce is always valid
  for (let k = 0; s.folders.length < 200; k++) createFolder(s, {id: `n${k}`, name: `n${k}`, kind: 'manual', created: 4});
  assert.throws(() => createFolder(s, {id: 'over', name: 'over', kind: 'manual', created: 4}), /At most 200/); ok(JSON.parse(JSON.stringify(serializeFolderState(s))));
  // rename
  renameFolder(s, 'a', 'Renamed'); assert.equal(s.folders.find(f => f.id === 'a').name, 'Renamed'); assert.throws(() => renameFolder(s, 'a', ''), /name/); assert.throws(() => renameFolder(s, 'ghost', 'x'), /no longer exists/);
  assert.equal(s.folders.find(f => f.id === 'a').name, 'Renamed', 'a refused rename changes nothing');
  // members
  const m = emptyFolderState(); createFolder(m, {id: 'm', name: 'M', kind: 'manual', created: 1}); createFolder(m, {id: 's', name: 'S', kind: 'smart', query: '', created: 1});
  assert.deepEqual(addMembers(m, 'm', [H(1), H(2), H(1), H(3)]), {added: 3, skipped: 1}); assert.deepEqual(m.folders[0].presets, [H(1), H(2), H(3)], 'order kept, duplicates skipped');
  assert.deepEqual(addMembers(m, 'm', [H(2), H(4)]), {added: 1, skipped: 1}); assert.throws(() => addMembers(m, 'm', ['nothex']), /Invalid preset/); assert.throws(() => addMembers(m, 's', [H(1)]), /manual folder/); assert.throws(() => addMembers(m, 'ghost', [H(1)]), /manual folder/);
  assert.throws(() => addMembers(m, 'm', [H(7), 'nothex']), /Invalid preset/); assert.equal(m.folders[0].presets.includes(H(7)), false, 'a refused add changes nothing, not even the valid hashes before the bad one');
  assert.equal(m.folders[0].presets.length, 4);
  assert.equal(removeMembers(m, 'm', [H(2), H(9)]), 1); assert.deepEqual(m.folders[0].presets, [H(1), H(3), H(4)]); assert.throws(() => removeMembers(m, 's', []), /manual folder/);
  assert.equal(moveMember(m, 'm', H(3), -1), true); assert.deepEqual(m.folders[0].presets, [H(3), H(1), H(4)]); assert.equal(moveMember(m, 'm', H(3), -1), false, 'cannot move above the first'); assert.equal(moveMember(m, 'm', H(4), 1), false);
  assert.equal(moveMember(m, 'm', H(99), 1), false); assert.equal(moveMember(m, 'm', H(1), 1), true); assert.deepEqual(m.folders[0].presets, [H(3), H(4), H(1)]); assert.throws(() => moveMember(m, 's', H(1), 1), /order/);
  // Member caps through the helper: 5000 per folder, 30000 in all, skipped counted.
  const big = emptyFolderState(); for (let k = 0; k < 7; k++) createFolder(big, {id: `f${k}`, name: `f${k}`, kind: 'manual', created: 1});
  const hashes = n => Array.from({length: n}, (_, k) => H(k + 1));
  assert.deepEqual(addMembers(big, 'f0', hashes(5100)), {added: 5000, skipped: 100}); for (let k = 1; k < 6; k++) addMembers(big, `f${k}`, hashes(5000));
  assert.equal(totalMembers(big), 30000); assert.deepEqual(addMembers(big, 'f6', hashes(10)), {added: 0, skipped: 10}, 'the total cap holds'); ok(JSON.parse(JSON.stringify(serializeFolderState(big))));
  // delete cascades: children, their options, last, selection and expansion; presets are never touched.
  const d = emptyFolderState(); createFolder(d, {id: 'p', name: 'P', kind: 'manual', created: 1}); createFolder(d, {id: 'c', name: 'C', kind: 'manual', parent: 'p', created: 1}); createFolder(d, {id: 'k', name: 'K', kind: 'manual', created: 1});
  setPlayback(d, 'user:p', {recursive: true, sort: []}); setPlayback(d, 'user:c', {recursive: true, sort: []}); setPlayback(d, 'user:k', {recursive: true, sort: []}); setLast(d, 'user:c', true); setUi(d, {selected: 'user:c', expanded: ['user:p', 'user:c', 'avs']});
  d.opaquePlayback['user:c'] = 'x';
  assert.deepEqual(deleteFolder(d, 'p').sort(), ['c', 'p']); assert.deepEqual(d.folders.map(f => f.id), ['k']); assert.deepEqual(Object.keys(d.playback), ['user:k']); assert.deepEqual(d.opaquePlayback, {});
  assert.equal(d.last, null); assert.equal(d.ui.selected, null); assert.deepEqual(d.ui.expanded, ['avs']); assert.throws(() => deleteFolder(d, 'p'), /no longer exists/);
  // playback / last / ui helpers validate first and leave the state alone on failure.
  assert.throws(() => setPlayback(d, 'bogus', {recursive: true, sort: []}), /Invalid folder/); assert.throws(() => setPlayback(d, 'avs/x', {recursive: true, sort: [], settings: {...settings, transition: 99}}));
  assert.equal('avs/x' in d.playback, false); setPlayback(d, 'avs/x', {recursive: false, sort: [{key: 'name', dir: 'desc'}], skipPartial: true, settings, timing: {enabled: true, bpm: 100, offsetSeconds: 0, barsPerScene: 2, seed: 3}});
  assert.equal(d.playback['avs/x'].skipPartial, true); clearPlayback(d, 'avs/x'); assert.equal('avs/x' in d.playback, false);
  assert.throws(() => setLast(d, 'zzz', true), /Invalid folder/); setUi(d, {sort: [1, 2, 3, 4].map(() => ({key: 'name', dir: 'asc'}))}); assert.equal(d.ui.sort.length, 3, 'ui sort is cut to three keys');
  setUi(d, {expanded: ['avs', 'junk']}); assert.deepEqual(d.ui.expanded, ['avs']); setUi(d, {scopeAll: 1}); assert.equal(d.ui.scopeAll, false, 'only true sets it'); setUi(d, {selected: 'junk'}); assert.equal(d.ui.selected, null);
  // 300 playback entries at most, counting opaque ones.
  const cap = emptyFolderState(); for (let k = 0; k < 299; k++) setPlayback(cap, `avs/p${k}`, {recursive: true, sort: []}); cap.opaquePlayback['avs/o'] = 1;
  assert.throws(() => setPlayback(cap, 'avs/last', {recursive: true, sort: []}), /At most 300/); setPlayback(cap, 'avs/p0', {recursive: false, sort: []}); assert.equal(cap.playback['avs/p0'].recursive, false, 'an existing key can always be replaced');
}

// ---------------------------------------------------------------------------------------------------- the save queue
class Timers {
  constructor() { this.next = 0; this.pending = new Map(); }
  set(fn, ms) { this.pending.set(++this.next, {fn, ms}); return this.next; }
  clear(id) { this.pending.delete(id); }
  get delays() { return [...this.pending.values()].map(t => t.ms); }
  fire() { const all = [...this.pending.entries()]; this.pending.clear(); for (const [, t] of all) t.fn(); return all.length; }
}
const loaded = (store, data, name = 'folders') => store.receive('state-loaded', {type: 'state-loaded', name, data});
function harness() {
  const sent = [], timers = new Timers(), store = new FolderStore(request => sent.push(request), timers);
  let changes = 0; store.onChange = () => { changes++; };
  return {sent, timers, store, get changes() { return changes; }, saves: () => sent.filter(r => r.op === 'save-state')};
}
{
  const h = harness();
  assert.equal(h.store.status, 'idle'); assert.equal(h.store.canEdit, false, 'nothing can be edited before the file has loaded');
  h.store.load(); assert.deepEqual(h.sent, [{op: 'load-state', name: 'folders'}]); assert.equal(h.store.status, 'loading');
  assert.equal(loaded(h.store, null), true); assert.equal(h.store.status, 'ready'); assert.deepEqual(h.store.state, emptyFolderState());
  // A host message for the other state file is not ours.
  assert.equal(loaded(h.store, {version: 1}, 'stats'), false); assert.equal(h.store.receive('state-saved', {name: 'stats'}), false); assert.equal(h.store.receive('nonsense', {}), false);
  assert.equal(h.store.receive('library-error', 'x', 'rate'), false, 'errors of other operations are not ours'); assert.equal(h.store.receive('library-error', 'x', 'save-state'), false, 'a save error with no save in flight is not ours');
  // An explicit edit flushes after 400 ms; three edits in the window make one save.
  assert.equal(h.store.mutate(s => { createFolder(s, {id: 'a', name: 'A', kind: 'manual', created: 1}); }), true);
  assert.deepEqual(h.timers.delays, [400]); assert.equal(h.saves().length, 0);
  h.store.mutate(s => addMembers(s, 'a', [H(1)])); h.store.mutate(s => renameFolder(s, 'a', 'Alpha')); assert.deepEqual(h.timers.delays, [400], 'edits restart one timer');
  assert.equal(h.timers.fire(), 1); assert.equal(h.saves().length, 1); const first = h.saves()[0];
  assert.equal(first.op, 'save-state'); assert.equal(first.name, 'folders'); assert.equal(first.data.folders[0].name, 'Alpha'); assert.deepEqual(first.data.folders[0].presets, [H(1)]); assert.equal(first.data.rev, 1, 'rev counts saves');
  assert.equal(h.store.saving, true); assert.equal(h.store.dirty, false);
  // While a save is in flight further edits coalesce into exactly one follow-up save.
  h.store.mutate(s => renameFolder(s, 'a', 'Beta'), true); h.store.mutate(s => renameFolder(s, 'a', 'Gamma'), true); h.store.mutate(s => addMembers(s, 'a', [H(2)]));
  assert.equal(h.saves().length, 1, 'one in flight'); h.timers.fire(); assert.equal(h.saves().length, 1, 'the timer cannot start a second save either');
  h.store.receive('state-saved', {name: 'folders'}); assert.equal(h.saves().length, 2, 'the pending save starts when the first completes');
  assert.equal(h.saves()[1].data.folders[0].name, 'Gamma'); assert.deepEqual(h.saves()[1].data.folders[0].presets, [H(1), H(2)]); assert.equal(h.saves()[1].data.rev, 2);
  h.store.receive('state-saved', {name: 'folders'}); assert.equal(h.saves().length, 2); assert.equal(h.store.saving, false); assert.equal(h.store.dirty, false);
  // A failed save keeps the data dirty and does not retry by itself.
  h.store.mutate(s => renameFolder(s, 'a', 'Delta'), true); assert.equal(h.saves().length, 3);
  h.store.receive('library-error', 'Disk is read-only', 'save-state'); assert.equal(h.store.saveError, 'Disk is read-only'); assert.equal(h.store.dirty, true); assert.equal(h.store.saving, false);
  assert.equal(h.timers.pending.size, 0, 'no automatic retry'); assert.equal(h.saves().length, 3);
  h.store.retry(); assert.equal(h.saves().length, 4, 'retry re-sends'); assert.equal(h.store.saveError, ''); assert.equal(h.saves()[3].data.folders[0].name, 'Delta');
  h.store.receive('library-error', 'again', 'save-state'); h.store.mutate(s => renameFolder(s, 'a', 'Echo')); h.timers.fire(); assert.equal(h.saves().length, 5, 'the next mutation retries'); assert.equal(h.saves()[4].data.folders[0].name, 'Echo');
  h.store.receive('state-saved', {name: 'folders'});
  // UI-only changes wait three seconds; an explicit edit shortens the wait; an explicit edit is never postponed by a UI change.
  const n0 = h.saves().length;
  h.store.mutateUi(s => setUi(s, {selected: 'avs'})); assert.deepEqual(h.timers.delays, [3000]); h.store.mutateUi(s => setUi(s, {expanded: ['avs']})); assert.deepEqual(h.timers.delays, [3000]);
  h.store.mutate(s => renameFolder(s, 'a', 'Foxtrot')); assert.deepEqual(h.timers.delays, [400]); h.store.mutateUi(s => setUi(s, {selected: 'nerv'})); assert.deepEqual(h.timers.delays, [400], 'a UI change never postpones an edit');
  h.timers.fire(); assert.equal(h.saves().length, n0 + 1); assert.equal(h.saves().at(-1).data.ui.selected, 'nerv'); assert.equal(h.saves().at(-1).data.folders[0].name, 'Foxtrot'); h.store.receive('state-saved', {name: 'folders'});
  h.store.mutateUi(s => setUi(s, {selected: 'hud'})); assert.equal(h.timers.fire(), 1); assert.equal(h.saves().at(-1).data.ui.selected, 'hud'); h.store.receive('state-saved', {name: 'folders'});
  h.store.mutateUi(s => setUi(s, {selected: 'smart'})); h.store.flush(); assert.equal(h.saves().at(-1).data.ui.selected, 'smart', 'flush saves at once (panel close)'); assert.equal(h.timers.pending.size, 0); h.store.receive('state-saved', {name: 'folders'});
  h.store.flush(); assert.equal(h.saves().length, n0 + 3, 'flush with nothing dirty sends nothing');
  // A refused edit changes nothing, sends nothing and explains itself.
  const before = JSON.stringify(h.store.state); const sentBefore = h.sent.length;
  assert.equal(h.store.mutate(s => renameFolder(s, 'a', '')), false); assert.match(h.store.notice, /name/); assert.equal(JSON.stringify(h.store.state), before); assert.equal(h.timers.pending.size, 0); assert.equal(h.sent.length, sentBefore);
  assert.equal(h.store.mutate(s => { throw 'plain string'; }), false); assert.equal(h.store.notice, 'plain string');
  // A reload never discards unsaved edits, and a late state-loaded never clobbers them.
  h.store.mutate(s => renameFolder(s, 'a', 'Golf')); const requests = h.sent.length; h.store.load(); assert.equal(h.sent.length, requests, 'load is skipped while edits are unsaved');
  loaded(h.store, {version: 1, rev: 9, folders: []}); assert.equal(h.store.state.folders.length, 1, 'a load result arriving over unsaved edits is ignored');
  h.timers.fire(); h.store.receive('state-saved', {name: 'folders'});
  h.store.load(); assert.equal(h.sent.at(-1).op, 'load-state', 'a clean store reloads on every open');
  loaded(h.store, {version: 1, rev: 40, folders: [folder('z', {name: 'From disk'})]}); assert.equal(h.store.state.folders[0].name, 'From disk'); assert.equal(h.store.state.rev, 40);
  h.store.mutate(s => renameFolder(s, 'z', 'Edited')); h.timers.fire(); assert.equal(h.saves().at(-1).data.rev, 41, 'rev continues from the loaded file');
  assert.ok(h.changes > 10, 'views are told about every change');
  // A throwing view never breaks persistence.
  h.store.onChange = () => { throw new Error('view broke'); }; assert.doesNotThrow(() => h.store.mutate(s => renameFolder(s, 'z', 'Again'))); assert.equal(h.store.state.folders[0].name, 'Again');
}
// ---- an older host: the file operations are unknown, so the store works for the session only
{
  const h = harness(); h.store.load();
  assert.equal(h.store.receive('library-error', 'Unknown library request', 'load-state'), true);
  assert.equal(h.store.status, 'unavailable'); assert.match(h.store.notice, /session only/); assert.equal(h.store.canEdit, true);
  assert.equal(h.store.mutate(s => createFolder(s, {id: 'a', name: 'Session', kind: 'manual', created: 1})), true); assert.equal(h.store.state.folders.length, 1);
  h.store.mutateUi(s => setUi(s, {selected: 'avs'})); h.timers.fire(); h.store.flush();
  assert.deepEqual(h.sent, [{op: 'load-state', name: 'folders'}], 'nothing is ever sent to a host that does not know the operation');
  h.store.load(); assert.equal(h.sent.length, 1, 'and it is not asked again'); assert.equal(h.store.state.folders.length, 1, 'session edits survive');
  h.store.reset(); assert.equal(h.store.state.folders.length, 0); assert.equal(h.sent.length, 1);
  // The same message shape from the native host.
  const native = harness(); native.store.load(); native.store.receive('library-error', 'Unknown state file', 'load-state'); assert.equal(native.store.status, 'unavailable');
}
// ---- an unreadable or newer file is never overwritten without an explicit Reset
{
  const h = harness(); h.store.load();
  loaded(h.store, {version: 2, folders: 'the future'});
  assert.equal(h.store.status, 'readonly'); assert.match(h.store.notice, /newer version.*editing is disabled/); assert.equal(h.store.canEdit, false);
  assert.equal(h.store.mutate(s => createFolder(s, {id: 'a', name: 'A', kind: 'manual', created: 1})), false); assert.equal(h.store.mutateUi(s => setUi(s, {selected: 'avs'})), false);
  h.store.flush(); h.timers.fire(); assert.equal(h.saves().length, 0, 'a read-only store never writes');
  h.store.load(); loaded(h.store, {version: 1, folders: [folder('a'), folder('a')]});
  assert.equal(h.store.status, 'readonly'); assert.match(h.store.notice, /could not be read.*Reset folders/);
  h.store.load(); h.store.receive('library-error', 'Saved state is corrupt', 'load-state'); assert.equal(h.store.status, 'readonly'); assert.match(h.store.notice, /corrupt/);
  h.store.reset(); assert.equal(h.store.status, 'ready'); assert.equal(h.store.notice, ''); assert.equal(h.saves().length, 1, 'Reset writes the empty state at once');
  assert.deepEqual(h.saves()[0].data.folders, []); assert.equal(h.saves()[0].data.rev, 1); h.store.receive('state-saved', {name: 'folders'});
  assert.equal(h.store.mutate(s => createFolder(s, {id: 'a', name: 'A', kind: 'manual', created: 1})), true, 'editing resumes after Reset');
}
// ---- payload size: the page refuses to send more than the state limit
{
  const sent = [], timers = new Timers();
  const channel = new StateChannel('folders', r => sent.push(r), timers, () => ({big: 'x'.repeat(STATE_MAX_BYTES)}));
  channel.markDirty('now'); assert.equal(sent.length, 0); assert.match(channel.error, /too large/); assert.equal(channel.dirty, true);
  const under = new StateChannel('stats', r => sent.push(r), timers, () => ({big: 'x'.repeat(STATE_MAX_BYTES - 12)}));
  under.markDirty('now'); assert.equal(sent.length, 1); assert.equal(sent[0].name, 'stats');
  assert.equal(utf8Length('abc'), 3); assert.equal(utf8Length('é'), 2); assert.equal(utf8Length('€'), 3); assert.equal(utf8Length('😀'), 4);
  const wide = new StateChannel('folders', r => sent.push(r), timers, () => ({s: '€'.repeat(Math.ceil(STATE_MAX_BYTES / 3))}));
  wide.markDirty('now'); assert.equal(sent.length, 1, 'the limit counts UTF-8 bytes, not characters');
  // Channel odds and ends.
  const c = new StateChannel('folders', r => sent.push(r), timers, () => ({ok: 1}));
  c.saved(); c.failed('x'); assert.equal(c.dirty, false, 'stray completions are ignored');
  c.enabled = false; c.markDirty('now'); assert.equal(sent.length, 1, 'a disabled channel sends nothing'); c.dispose();
}
// ---- the empty-state file a host returns for a missing file, and hostile data
{
  const h = harness(); h.store.load(); loaded(h.store, undefined); assert.equal(h.store.status, 'ready');
  const h2 = harness(); h2.store.load(); h2.store.receive('state-loaded', null); assert.equal(h2.store.status, 'ready', 'a bare message without a payload counts as an empty file');
  const h3 = harness(); h3.store.load(); loaded(h3.store, 'a string'); assert.equal(h3.store.status, 'readonly');
  const h4 = harness(); h4.store.load(); loaded(h4.store, JSON.parse('{"version":1,"folders":[{"id":"__proto__","name":"x","parent":null,"kind":"manual","presets":[],"created":1}]}'));
  assert.equal(h4.store.status, 'ready'); assert.equal(({}).polluted, undefined);
}

// ---- mutation fuzz: hostile variations of a valid file never throw anything but FolderStateError, and what parses is stable
{
  let seed = 20260929;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const junk = () => { const k = Math.floor(rand() * 14); return [null, undefined, true, false, 0, -1, 1.5, NaN, 1e999, 'x', '', 'a'.repeat(500), [], {}][k] ?? {a: [1, {b: null}]}; };
  const base = doc({rev: 3, folders: [folder('a', {presets: [H(1), H(2)], sort: [{key: 'manual', dir: 'asc'}]}), {id: 'b', name: 'Q', parent: 'a', kind: 'smart', query: 'rating:3', scope: 'avs', created: 5}],
    playback: {'hud/Neo Geo': {recursive: true, sort: [], settings: {...settings, fadeTiming: 6}, timing: {enabled: false, bpm: 120, offsetSeconds: 0, barsPerScene: 8, seed: 1}}},
    last: {key: 'avs', recursive: true}, ui: {expanded: ['avs'], selected: 'avs', sort: [{key: 'name', dir: 'asc'}], scopeAll: false}});
  // Every reachable path of the base document, so a mutation can hit any nested value.
  const paths = [];
  (function walk(value, path) { paths.push(path); if (value && typeof value === 'object') for (const k of Object.keys(value)) walk(value[k], [...path, k]); })(base, []);
  const at = (root, path) => path.reduce((o, k) => o?.[k], root);
  let parsed = 0, refused = 0;
  for (let round = 0; round < 3000; round++) {
    const doc2 = JSON.parse(JSON.stringify(base));
    for (let m = 0; m < 1 + Math.floor(rand() * 3); m++) {
      const path = paths[Math.floor(rand() * paths.length)];
      if (!path.length) continue;
      const parent = at(doc2, path.slice(0, -1));
      if (!parent || typeof parent !== 'object') continue;
      const key = path.at(-1), roll = rand();
      if (roll < 0.25) delete parent[key]; else parent[key] = junk();
    }
    let state;
    try { state = parseFolderState(doc2); } catch (error) { assert.ok(error instanceof FolderStateError, `only FolderStateError may escape, got ${error?.constructor?.name}: ${error?.message}`); refused++; continue; }
    parsed++;
    const wire = JSON.parse(JSON.stringify(serializeFolderState(state)));
    assert.deepEqual(JSON.parse(JSON.stringify(serializeFolderState(parseFolderState(wire)))), wire, 'what parses serialises stably');
    assert.ok(utf8Length(JSON.stringify(wire)) <= FOLDER_LIMITS.bytes);
  }
  assert.ok(parsed > 300 && refused > 300, `the fuzz exercises both outcomes (${parsed} parsed, ${refused} refused)`);
  // The store never throws on a hostile message either, and never ends up half-loaded.
  for (let round = 0; round < 500; round++) {
    const h = harness(); h.store.load();
    const message = [['state-loaded', {name: 'folders', data: junk()}], ['state-loaded', junk()], ['state-saved', junk()], ['library-error', junk(), 'load-state'], ['library-error', junk(), 'save-state'], [String(junk()), junk()]][Math.floor(rand() * 6)];
    assert.doesNotThrow(() => h.store.receive(...message));
    assert.ok(['loading', 'ready', 'readonly', 'unavailable'].includes(h.store.status));
    assert.doesNotThrow(() => h.store.mutate(state => { state.ui.scopeAll = true; }));
  }
}

// ---- error routing: a host names only the operation, so a store acts on an error only while its own request is pending
{
  const h = harness();
  assert.equal(h.store.receive('library-error', 'Unknown library request', 'load-state'), false, 'a load error with no load pending is not ours');
  assert.equal(h.store.status, 'idle');
  h.store.load(); loaded(h.store, null);
  assert.equal(h.store.receive('library-error', 'Saved state is corrupt', 'load-state'), false, 'nor is one that arrives after the load finished'); assert.equal(h.store.status, 'ready');
  const g = harness(); g.store.load();
  assert.equal(g.store.receive('library-error', {message: 'Saved state is corrupt', name: 'stats'}, 'load-state'), false, 'a host that names the file: the error for the other file is not ours');
  assert.equal(g.store.status, 'loading');
  assert.equal(g.store.receive('library-error', {message: 'Saved state is corrupt', name: 'folders'}, 'load-state'), true); assert.equal(g.store.status, 'readonly'); assert.match(g.store.notice, /corrupt/);
  const s = harness(); s.store.load(); loaded(s.store, null); s.store.mutate(x => createFolder(x, {id: 'a', name: 'A', kind: 'manual', created: 1})); s.timers.fire();
  assert.equal(s.store.receive('library-error', {message: 'nope', name: 'stats'}, 'save-state'), false); assert.equal(s.store.saving, true);
  assert.equal(s.store.receive('library-error', {message: 'Disk is full', name: 'folders'}, 'save-state'), true); assert.equal(s.store.saveError, 'Disk is full');
  assert.deepEqual(stateErrorFor('folders', 'plain'), {mine: true, text: 'plain'}); assert.deepEqual(stateErrorFor('stats', {message: 'm'}), {mine: true, text: 'm'});
  assert.deepEqual(stateErrorFor('stats', {message: 'm', name: 'folders'}), {mine: false, text: 'm'});
  assert.equal(isUnsupportedState('Unknown library request'), true); assert.equal(isUnsupportedState('Unknown state file'), true); assert.equal(isUnsupportedState('Saved state is corrupt'), false);
  assert.equal(typeof systemTimers().set, 'function');
}
// ---- a saved search can be edited
{
  const s = emptyFolderState();
  createFolder(s, {id: 'q', name: 'Q', kind: 'smart', query: 'a', scope: null, created: 1}); createFolder(s, {id: 'm', name: 'M', kind: 'manual', created: 2});
  updateSearch(s, 'q', 'rating:>=4', 'avs'); assert.deepEqual([s.folders[0].query, s.folders[0].scope], ['rating:>=4', 'avs']);
  assert.throws(() => updateSearch(s, 'm', 'x', null), /Only a search folder/); assert.throws(() => updateSearch(s, 'gone', 'x', null), /Only a search folder/);
  assert.throws(() => updateSearch(s, 'q', 'x'.repeat(401), null), /400 characters/); assert.throws(() => updateSearch(s, 'q', 'x', 'bogus'), /Invalid search scope/);
  assert.deepEqual([s.folders[0].query, s.folders[0].scope], ['rating:>=4', 'avs'], 'a refused edit changes nothing');
}
// ---- the channel throttle used by statistics: an already scheduled flush is kept, not restarted
{
  const timers = new Timers(), sent = [];
  const c = new StateChannel('stats', r => sent.push(r), timers, () => ({version: 1, plays: {}}), 60000, 60000);
  c.markDirty('edit', true); const first = [...timers.pending.keys()]; assert.deepEqual(timers.delays, [60000]); assert.equal(c.scheduled, true);
  c.markDirty('edit', true); assert.deepEqual([...timers.pending.keys()], first, 'the second call keeps the first timer');
  c.markDirty('edit'); assert.notDeepEqual([...timers.pending.keys()], first, 'without the flag it is a debounce and restarts');
  timers.fire(); assert.equal(sent.length, 1); assert.equal(c.scheduled, false);
}

// ---------------------------------------------------------------------------------------------------- play statistics
{
  const {parseStats, serializeStats, emptyStats, PlayTracker, STATS_LIMITS, StatsStore, STATS_SAVE_MS, applyStats, buildRecords, buildFolderTree, parseLocalAvsCatalog} = B;
  assert.deepEqual({...STATS_LIMITS}, {entries: 20000, count: 65535, minPlayMs: 8000}); assert.equal(STATS_SAVE_MS, 60000);
  const HASH = n => n.toString(16).padStart(64, '0');
  // Parsing: strict envelope, tolerant entries.
  for (const v of [null, 5, 'x', [], undefined]) assert.throws(() => parseStats(v), /not an object/);
  assert.throws(() => parseStats({}), /Invalid play statistics/); assert.throws(() => parseStats({version: 1}), /Invalid play statistics/); assert.throws(() => parseStats({version: 1, plays: []}), /Invalid play statistics/);
  assert.throws(() => parseStats({version: 2, plays: {}}), /newer version/); assert.throws(() => parseStats({version: 'x', plays: {}}), /Invalid play statistics/);
  const messy = parseStats({version: 1, plays: {[HASH(1)]: [3, 1000], [HASH(2)]: [0, 5], [HASH(3)]: [1.5, 5], [HASH(4)]: [2, -1], [HASH(5)]: [2, NaN], [HASH(6)]: 'x', [HASH(7)]: [1], 'not-a-hash': [1, 1], [HASH(8)]: [999999, 7], [HASH(9)]: [1, 1, 1]}});
  assert.deepEqual([...messy.plays.keys()], [HASH(1), HASH(8)], 'bad entries are skipped, good ones kept'); assert.deepEqual(messy.plays.get(HASH(8)), [65535, 7], 'counts are clamped');
  const many = {version: 1, plays: {}};
  for (let k = 0; k < 20050; k++) many.plays[HASH(k)] = [1, k];
  const pruned = parseStats(many);
  assert.equal(pruned.plays.size, 20000); assert.ok(!pruned.plays.has(HASH(0)) && !pruned.plays.has(HASH(49)) && pruned.plays.has(HASH(50)), 'the least recently played are dropped');
  const round = parseStats(serializeStats(messy)); assert.deepEqual([...round.plays], [...messy.plays]);
  assert.deepEqual(serializeStats(emptyStats()), {version: 1, plays: {}}); assert.ok(JSON.stringify(serializeStats(messy)).length < 400);
  // The tracker: a play counts after eight seconds spent playing, pauses excluded.
  {
    const st = emptyStats(), t = new PlayTracker(st);
    t.commit(HASH(1), true, 1000); t.commit(HASH(2), true, 5000);                   // 4 s: not a play
    assert.equal(st.plays.size, 0); assert.equal(t.dirty, false);
    t.commit(HASH(3), true, 14000);                                                   // preset 2 played 9 s
    assert.deepEqual(st.plays.get(HASH(2)), [1, 14000]); assert.equal(t.dirty, true); assert.equal(t.takeDirty(), true); assert.equal(t.takeDirty(), false);
    t.setPlaying(false, 18000); t.setPlaying(false, 20000);                           // 4 s played, then paused
    t.commit(HASH(4), true, 90000);                                                   // paused time does not count: preset 3 had only 4 s
    assert.equal(st.plays.has(HASH(3)), false, 'a long pause is not a play');
    t.setPlaying(true, 91000); t.setPlaying(false, 97000); t.setPlaying(true, 100000); t.commit(HASH(5), true, 103000);   // 6 s + 3 s = 9 s of 13 s
    assert.deepEqual(st.plays.get(HASH(4)), [1, 103000]);
    t.commit(HASH(5), true, 105000); t.commit(HASH(5), false, 106000);                // the same preset again is not a new commit
    t.setPlaying(true, 200000); t.commit(HASH(2), true, 210000);                      // preset 5: 3 + 1 + 10 s
    assert.equal(st.plays.get(HASH(5))[0], 1);
    t.flush(230000); assert.deepEqual(st.plays.get(HASH(2)), [2, 230000], 'replaying a preset adds one to its count'); assert.equal(t.flush(231000), true);
    // Not playing at commit time: nothing accrues until playback resumes. An invalid hash is never recorded.
    const s2 = emptyStats(), t2 = new PlayTracker(s2, 1000);
    t2.commit(HASH(1), false, 0); t2.commit(HASH(2), true, 60000); assert.equal(s2.plays.size, 0, 'paused presets do not count');
    t2.commit('bad', true, 60500); t2.commit(HASH(3), true, 99000); assert.equal(s2.plays.size, 0, 'a bad hash is ignored');
    const idle = new PlayTracker(emptyStats()); idle.setPlaying(true, 5); assert.equal(idle.flush(9e9), false, 'nothing current, nothing to finish');
    // Limits: the count saturates and the map stays bounded.
    const s3 = emptyStats(); s3.plays.set(HASH(1), [65535, 1]); const t3 = new PlayTracker(s3, 0); t3.commit(HASH(1), true, 5); t3.commit(HASH(2), true, 6);
    assert.equal(s3.plays.get(HASH(1))[0], 65535, 'the count never overflows');
    const s4 = emptyStats(); for (let k = 0; k < 20000; k++) s4.plays.set(HASH(k), [1, k + 10]);
    const t4 = new PlayTracker(s4, 0); t4.commit(HASH(99999), true, 1); t4.commit(HASH(100000), true, 5000000); assert.equal(s4.plays.size, 20000, 'a new play evicts the least recently played');
    assert.ok(!s4.plays.has(HASH(0)) && s4.plays.has(HASH(99999)));
  }
  // The store: read first, merge, throttle, and never overwrite what it could not read.
  const storeHarness = (saveMs = 60000) => {
    const sent = [], timers = new Timers(), store = new StatsStore(r => sent.push(r), timers, saveMs, 1000);
    let changes = 0; store.onChange = () => { changes++; };
    return {sent, timers, store, get changes() { return changes; }, saves: () => sent.filter(r => r.op === 'save-state')};
  };
  const loadedStats = (store, data) => store.receive('state-loaded', {type: 'state-loaded', name: 'stats', data});
  {
    const h = storeHarness();
    assert.equal(h.store.status, 'idle'); h.store.load(); h.store.load(); assert.deepEqual(h.sent, [{op: 'load-state', name: 'stats'}], 'one request per session'); assert.equal(h.store.status, 'loading');
    // Plays recorded before the file arrives are kept in memory and never written before the merge.
    h.store.commit(HASH(1), true, 0); h.store.commit(HASH(2), true, 5000); assert.equal(h.store.stats.plays.get(HASH(1))[0], 1); assert.equal(h.store.dirty, true);
    assert.equal(h.timers.pending.size, 0, 'no save is scheduled before the file has been read'); assert.equal(h.store.flush(5000), false); assert.equal(h.saves().length, 0);
    assert.equal(loadedStats(h.store, {version: 1, plays: {[HASH(1)]: [4, 999], [HASH(3)]: [2, 50]}}), true);
    assert.equal(h.store.status, 'ready'); assert.deepEqual(h.store.stats.plays.get(HASH(1)), [5, 5000], 'the file and the session are merged: counts add, the later time wins');
    assert.deepEqual(h.store.stats.plays.get(HASH(3)), [2, 50]); assert.deepEqual(h.timers.delays, [60000], 'the merged data is scheduled for saving');
    h.timers.fire(); assert.equal(h.saves().length, 1); assert.deepEqual(h.saves()[0].data, serializeStats(h.store.stats)); assert.equal(h.saves()[0].name, 'stats');
    assert.equal(h.store.receive('state-saved', {name: 'stats'}), true); assert.equal(h.store.saving, false);
    // Throttle: plays keep arriving every 20 s; the first schedules one save and later ones do not push it back.
    h.store.commit(HASH(4), true, 100000); h.store.commit(HASH(5), true, 120000); assert.equal(h.store.stats.plays.has(HASH(4)), true);
    assert.deepEqual(h.timers.delays, [60000]); const id = [...h.timers.pending.keys()][0];
    h.store.commit(HASH(6), true, 140000); h.store.commit(HASH(7), true, 160000); assert.deepEqual([...h.timers.pending.keys()], [id], 'a steady stream of plays still saves once a minute');
    assert.equal(h.store.stats.plays.has(HASH(6)), true);
    // Panel close: finalise the current preset and save at once.
    h.store.commit(HASH(8), true, 200000);
    assert.equal(h.store.flush(230000), true, 'flush sends immediately'); assert.equal(h.timers.pending.size, 0);
    assert.ok(h.store.stats.plays.has(HASH(8))); assert.equal(h.saves().length, 2);
    // A failed save keeps the data dirty and retries only on request or the next play; a name for the other file is ignored.
    assert.equal(h.store.receive('library-error', {message: 'x', name: 'folders'}, 'save-state'), false);
    assert.equal(h.store.receive('library-error', 'Disk is read-only', 'save-state'), true); assert.equal(h.store.saveError, 'Disk is read-only'); assert.equal(h.store.dirty, true);
    h.store.retry(); assert.equal(h.saves().length, 3); assert.equal(h.store.saveError, '');
    assert.equal(h.store.receive('state-loaded', {name: 'folders', data: null}), false); assert.equal(h.store.receive('state-saved', {name: 'folders'}), false); assert.equal(h.store.receive('nonsense', {}), false);
    assert.ok(h.changes > 5); h.store.onChange = () => { throw new Error('view broke'); }; assert.doesNotThrow(() => h.store.commit(HASH(9), true, 300000)); h.store.dispose();
  }
  {
    // A missing file is an empty history; an old host counts for the session only and is never sent anything else.
    const empty = storeHarness(); empty.store.load(); loadedStats(empty.store, null); assert.equal(empty.store.status, 'ready'); assert.equal(empty.store.stats.plays.size, 0);
    const bare = storeHarness(); bare.store.load(); assert.equal(bare.store.receive('state-loaded', {name: 'stats'}), true, 'a message with no data field is an empty file'); assert.equal(bare.store.status, 'ready');
    const old = storeHarness(); old.store.load();
    assert.equal(old.store.receive('library-error', 'Unknown library request', 'load-state'), true); assert.equal(old.store.status, 'unavailable'); assert.match(old.store.notice, /session only/);
    old.store.commit(HASH(1), true, 0); old.store.commit(HASH(2), true, 9000); assert.equal(old.store.stats.plays.get(HASH(1))[0], 1, 'session counters still work');
    old.store.flush(20000); assert.deepEqual(old.sent, [{op: 'load-state', name: 'stats'}], 'nothing is ever written to a host that cannot store it'); old.store.load(); assert.equal(old.sent.length, 1);
    const other = storeHarness(); other.store.load(); assert.equal(other.store.receive('library-error', {message: 'Saved state is corrupt', name: 'folders'}, 'load-state'), false, 'the folders error is not ours');
    assert.equal(other.store.status, 'loading');
    // An unreadable or newer file is left alone: no write, ever, in this session.
    for (const bad of [{version: 2, plays: {}}, {version: 1, plays: 'x'}, 'text']) {
      const h = storeHarness(); h.store.load(); h.store.commit(HASH(1), true, 0); h.store.commit(HASH(2), true, 9000);
      assert.equal(loadedStats(h.store, bad), true); assert.equal(h.store.status, 'unavailable'); assert.match(h.store.notice, /could not be read/);
      h.store.commit(HASH(3), true, 30000); h.store.flush(60000); h.timers.fire(); assert.equal(h.saves().length, 0, 'the unreadable file is never overwritten');
      assert.ok(h.store.stats.plays.has(HASH(2)), 'the session keeps counting');
    }
    const orphan = storeHarness(); assert.equal(orphan.store.receive('state-loaded', {name: 'stats', data: {version: 1, plays: {}}}), false, 'an unsolicited load result is ignored');
  }
  {
    // The records pick statistics up: `applyStats` fills plays and last-played by hash.
    const rows = Array.from({length: 4}, (_, k) => ({sha256: HASH(k + 1), bytes: 100, canonical_path: `presets/unique/${HASH(k + 1).slice(0, 16)}---p${k}.avs`, display_name: `P${k}`, occurrences: []}));
    const c = parseLocalAvsCatalog({presets: rows}, {results: rows.map(r => ({sha256: r.sha256, status: 'lossless'}))}, 'https://aaavs.invalid/mpc.html');
    const t = buildFolderTree(c), rs = buildRecords(c, t);
    const st = emptyStats(); st.plays.set(HASH(2), [7, 12345]); applyStats(rs, c, st);
    assert.deepEqual([rs.plays[1], rs.lastPlayed[1], rs.plays[0], rs.hasStats], [7, 12345, 0, true]); applyStats(rs, c, null); assert.deepEqual([rs.plays[1], rs.hasStats], [0, false]);
  }
}

console.log('Folder store PASS: folders.json v1 parse/serialise round trip, every cap at N and N+1, cycles/depth/parents, newer-version read-only, opaque playback entries kept verbatim, settings parity with parseSetups, edit helpers, coalesced save queue, failure/retry/reset, old-host session-only mode, mutation fuzz (3,000 files, 500 hostile messages)');
