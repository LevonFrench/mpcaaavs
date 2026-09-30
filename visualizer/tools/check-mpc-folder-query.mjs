import assert from 'node:assert/strict';
import {mulberry32, syntheticCatalog, syntheticTaxa, loadBrowser} from './fixtures-folders.mjs';
// Search, sort and the virtual window of the Preset Browser (docs/design/PRESET-BROWSER-V2.md 6, 7, 9.3, 12). CPU only.
const B = await loadBrowser();
const {buildFolderTree, buildRecords, updateRecord, syncFailed, applyStats, parseQuery, runQuery, sortIndices, visibleWindow, foldText, naturalKey, denseRanks, FLAG,
  defaultDirection, SORT_FIELDS, SORT_LABELS, parseLocalAvsCatalog, parseLocalAvsSources, emptyStats} = B;
const BASE = 'https://aaavs.invalid/mpc.html';
const H = n => n.toString(16).padStart(64, '0');
const ids = a => [...a];
const asc = a => [...a].sort((x, y) => x - y);
function row(i, name, occ = [], extra = {}) {
  return {sha256: H(i), bytes: 100 + i, canonical_path: `presets/unique/${H(i).slice(0, 16)}---${name}.avs`, display_name: name,
    occurrences: occ.map(([pkg, path]) => ({package_id: pkg, path: `_staging/${pkg}/${path}`, original_path: path})), ...extra};
}
const parseRows = rows => parseLocalAvsCatalog({presets: rows}, {results: rows.map(r => ({sha256: r.sha256, status: r.parse ?? 'lossless'}))}, BASE);
function make(rows, inputs = {}) {
  const catalog = parseRows(rows), tree = buildFolderTree(catalog, inputs), rs = buildRecords(catalog, tree, inputs.taxa ?? null, inputs.stats ?? null);
  return {catalog, tree, rs};
}
const run = (rs, text, universe = null) => runQuery(rs, parseQuery(text), universe);
const q = (rs, text, universe = null) => ids(run(rs, text, universe).ids);

// ---------------------------------------------------------------------------------------------------- folding and ranks
assert.equal(foldText('Éclair Über Ångström'), 'eclair uber angstrom');
assert.equal(foldText('İ'.normalize()), foldText('İ'), 'folding is total');
assert.ok(naturalKey('Intro 2') < naturalKey('Intro 10')); assert.ok(naturalKey('Intro 10') < naturalKey('Intro 11')); assert.ok(naturalKey('a9') < naturalKey('a10'));
assert.doesNotThrow(() => naturalKey('x' + '9'.repeat(300)), 'very long digit runs do not throw');
assert.deepEqual([...denseRanks(['b', 'a', 'b', 'c'])], [1, 0, 1, 2], 'equal keys share a rank');
assert.deepEqual([...denseRanks([])], []);

// ---------------------------------------------------------------------------------------------------- parser
{
  const p = parseQuery('  acid   "two words"  -dull !bad pkg:github|local rating:>=3 name:"a b" re:mix rating:>> kind:foo size:1k..8k is:broken  ');
  assert.deepEqual(p.text, ['acid', 'two words', 're:mix'], 'plain terms, quoted phrase, unknown key as text');
  const by = f => p.clauses.filter(c => c.field === f);
  assert.deepEqual(p.clauses.filter(c => c.neg).map(c => c.alts[0]), ['dull', 'bad'], 'both - and ! negate');
  assert.deepEqual(by('pkg')[0].alts, ['github', 'local'], 'alternatives inside one value');
  assert.deepEqual(by('rating')[0].ranges, [{lo: 3, hi: Infinity}]);
  assert.deepEqual(by('name')[0].alts, ['a b'], 'a quoted field value keeps its space');
  assert.deepEqual(by('size')[0].ranges, [{lo: 1024, hi: 8192}]);
  assert.deepEqual(by('is')[0].alts, ['broken']);
  assert.deepEqual(p.notes, ['ignored: rating:>>', 'ignored: kind:foo'], 'a malformed clause is reported and dropped');
  assert.equal(p.raw.length <= 1000, true);
  // Range grammar.
  const range = (text, field = 'rating') => parseQuery(`${field}:${text}`).clauses[0]?.ranges;
  assert.deepEqual(range('4'), [{lo: 4, hi: 4}]); assert.deepEqual(range('=4'), [{lo: 4, hi: 4}]); assert.deepEqual(range('>3'), [{lo: 4, hi: Infinity}]);
  assert.deepEqual(range('<3'), [{lo: -Infinity, hi: 2}]); assert.deepEqual(range('<=3'), [{lo: -Infinity, hi: 3}]); assert.deepEqual(range('3..5'), [{lo: 3, hi: 5}]);
  assert.deepEqual(range('unrated'), [{lo: 0, hi: 0}]); assert.deepEqual(range('1|5'), [{lo: 1, hi: 1}, {lo: 5, hi: 5}], 'numeric alternatives');
  assert.equal(range('5..3'), undefined, 'a reversed range is malformed'); assert.equal(range('abc'), undefined); assert.equal(range('1k'), undefined, 'rating takes no unit');
  assert.deepEqual(range('20k', 'size'), [{lo: 20480, hi: 20480}]); assert.deepEqual(range('>2kb', 'size'), [{lo: 2049, hi: Infinity}]); assert.deepEqual(range('1m', 'size'), [{lo: 1048576, hi: 1048576}]);
  assert.equal(range('5x', 'size'), undefined); assert.deepEqual(range('<7d', 'played')[0].hi < 7, true);
  assert.equal(parseQuery('stars:2').clauses[0].field, 'rating', 'stars is an alias'); assert.equal(parseQuery('folder:x').clauses[0].field, 'path');
  assert.equal(parseQuery('package:x').clauses[0].field, 'pkg'); assert.equal(parseQuery('source:x').clauses[0].field, 'src'); assert.equal(parseQuery('artist:x').clauses[0].field, 'src');
  assert.equal(parseQuery('category:x').clauses[0].field, 'style'); assert.equal(parseQuery('busyness:>2').clauses[0].field, 'busy');
  // Case and quotes.
  assert.equal(parseQuery('RATING:4').clauses[0].field, 'rating', 'field names are case-insensitive'); assert.deepEqual(parseQuery('ÉCLAIR').text, ['eclair']);
  assert.deepEqual(parseQuery('"a:b"').text, ['a:b'], 'a colon inside quotes is text'); assert.deepEqual(parseQuery('"-x"').text, ['-x'], 'a dash inside quotes is not negation');
  assert.deepEqual(parseQuery('"a|b"').text, ['a|b']); assert.deepEqual(parseQuery('name:"a|b"').clauses[0].alts, ['a|b'], 'a bar inside quotes is not an alternative');
  assert.deepEqual(parseQuery('"unterminated phrase').text, ['unterminated phrase']); assert.deepEqual(parseQuery('""').text, []);
  // Empty, whitespace, lone dashes.
  for (const empty of ['', '   ', '-', '!', '--', ' - ! ']) { const e = parseQuery(empty); assert.deepEqual([e.text.length, e.clauses.length, e.notes.length], [0, 0, 0], JSON.stringify(empty)); }
  assert.deepEqual(parseQuery('rating:').notes, ['ignored: rating: (no value)']); assert.deepEqual(parseQuery('name:').notes, ['ignored: name: (no value)']);
  assert.deepEqual(parseQuery('kind:avs|nerv').clauses[0].alts, ['avs', 'nerv']); assert.deepEqual(parseQuery('kind:avs|zzz').notes, ['ignored: kind:avs|zzz'], 'one bad alternative rejects the clause');
  assert.deepEqual(parseQuery('is:favorite').clauses[0].alts, ['favorite']); assert.deepEqual(parseQuery('energy:Calm|driving').clauses[0].alts, ['calm', 'driving']);
  assert.deepEqual(parseQuery('tier:showcase').clauses[0].alts, ['showcase']); assert.deepEqual(parseQuery('tier:gold').notes, ['ignored: tier:gold']);
  // Totality: nothing throws, whatever the input, and long input is cut.
  const rand = mulberry32(5), alphabet = ['"', '-', '!', ':', '|', '.', '>', '<', '=', ' ', 'a', 'b', 'k', 'd', '1', '9', 'rating', 'name', 'size', 'kind', 'is', '\u0000', '', 'é', '\ud800'];
  for (let n = 0; n < 3000; n++) {
    let text = ''; const len = Math.floor(rand() * 30);
    for (let k = 0; k < len; k++) text += alphabet[Math.floor(rand() * alphabet.length)];
    assert.doesNotThrow(() => parseQuery(text), JSON.stringify(text));
  }
  for (const odd of [undefined, null, 5, {}, [], 'x'.repeat(100000)]) assert.doesNotThrow(() => parseQuery(odd));
  assert.equal(parseQuery('x'.repeat(100000)).raw.length, 1000);
  assert.equal(parseQuery('Object:1 constructor:1 __proto__:1 toString:2').clauses.length, 0, 'inherited names are never fields'); assert.equal(parseQuery('__proto__:x').text[0], '__proto__:x');
}

// ---------------------------------------------------------------------------------------------------- search on a small hand-built estate
const pkgA = 'visbot-legacy-alpha-aabbccddee', pkgG = 'github-gamma-1122334455', pkgL = 'local-existing-picks-0011223344';
const sources = parseLocalAvsSources({sources: [{id: pkgA, catalog: 'visbot-legacy', file_name: 'alpha-pack.7z', artist_slug: 'tuggummi'}, {id: pkgG, catalog: 'github', repository: 'org/gamma'}, {id: pkgL, catalog: 'local-existing'}]});
const rows = [
  row(1, 'Tuggummi - Breaking Myself', [[pkgA, 'Alpha/SINKKUJA/Breaking.avs']], {rating: 3, bytes: 12000}),
  row(2, 'Tuggummi - 01 - Intro', [[pkgA, 'Alpha/allatuggummi/Intro.avs']], {rating: 0, bytes: 2000}),
  row(3, 'Intro 2', [[pkgG, 'src/Intro2.avs']], {rating: 5, bytes: 30000}),
  row(4, 'Intro 10', [[pkgG, 'src/Intro10.avs']], {rating: 4, bytes: 500, notWorking: true}),
  row(5, 'Éclair Café', [[pkgL, 'eclair.avs'], [pkgA, 'Alpha/extra/eclair.avs']], {rating: 2, bytes: 4096}),
  row(6, 'zebra', [], {bytes: 900, parse: 'parse-error'}),
  row(7, 'Alpha Wave', [[pkgG, 'src/wave/Alpha Wave.avs']], {rating: 1, bytes: 7000}),
];
const nerv = {sha256: H(20), bytes: 900, canonical_path: 'presets/unique/NERV 01 - boot.nerv', display_name: 'NERV / 01 - boot', kind: 'nerv', scene: 'boot'};
const hudRow = {sha256: H(21), bytes: 1300, canonical_path: `presets/unique/${H(21).slice(0, 16)}---Duel.hud`, display_name: 'Duel Rails 001', kind: 'hud', folder: 'Rhythm/Kit A',
  hud: {id: 'rhythm-duel-1', pack: 'Rhythm', family: 'fighting', tags: [], tier: 'tuned', order: 1, canvas: {style: 'pixel', w: 320, h: 224}}};
const hudAuto = {...hudRow, sha256: H(22), canonical_path: `presets/unique/${H(22).slice(0, 16)}---Sky.hud`, display_name: 'Sky Dial 002', folder: 'Modern/Kit B', hud: {...hudRow.hud, id: 'modern-sky-2', pack: 'Modern', tier: 'auto', order: 2}};
const est = make([...rows, nerv, hudRow, hudAuto], {sources});
const {rs: R, catalog: C} = est;
const name = i => C[i].name;
const named = list => list.map(name);
{
  // Plain terms match the name and the location path (a whole artist by its name).
  assert.deepEqual(q(R, 'intro'), [1, 2, 3], 'name substring, case-insensitive');
  assert.deepEqual(q(R, 'tuggummi'), [0, 1, 4], 'the artist folder matches its whole subtree (and the extra location of a multi-package preset)');
  assert.deepEqual(q(R, 'ECLAIR cafe'), [4], 'diacritics fold; terms AND together');
  assert.deepEqual(q(R, '"breaking myself"'), [0]); assert.deepEqual(q(R, 'sinkkuja'), [0], 'a path term');
  assert.deepEqual(q(R, 'nomatch'), []); assert.deepEqual(q(R, ''), C.map((p, i) => i), 'empty query lists all');
  assert.deepEqual(q(R, '-intro'), C.map((p, i) => i).filter(i => ![1, 2, 3].includes(i)), 'exclusion');
  assert.deepEqual(q(R, 'intro -tuggummi'), [2, 3]); assert.deepEqual(q(R, '!zebra -alpha -nerv -duel -sky').length, 2);
  // Fields.
  assert.deepEqual(q(R, 'name:intro'), [1, 2, 3]); assert.deepEqual(q(R, 'name:sinkkuja'), [], 'name: ignores the path');
  assert.deepEqual(q(R, 'path:sinkkuja'), [0]); assert.deepEqual(q(R, 'folder:"alpha / allatuggummi"'), [1]); assert.deepEqual(q(R, 'path:alpha>allatuggummi'), [1], '> works like /');
  assert.deepEqual(q(R, 'pkg:alpha'), [0, 1, 4, 6].filter(i => i !== 6), 'package label (the wrapper directory)');
  assert.deepEqual(q(R, 'pkg:gamma|picks'), [4], 'a package label is its wrapper directory, else its archive stem, else its id: "gamma" is only the repository, "picks" the id of local picks');
  assert.deepEqual(q(R, 'pkg:src'), [2, 3, 6], 'the wrapper directory names the GitHub package');
  assert.deepEqual(q(R, 'artist:tuggummi'), [0, 1, 4]); assert.deepEqual(q(R, 'source:github'), [2, 3, 6], 'source group'); assert.deepEqual(q(R, 'artist:org/gamma'), [2, 3, 6], 'the artist label is searchable whole, slash included');
  assert.deepEqual(q(R, 'artist:org'), [2, 3, 6]);
  assert.deepEqual(q(R, 'rating:5'), [2]); assert.deepEqual(q(R, 'rating:>=4'), [2, 3]); assert.deepEqual(q(R, 'rating:3..5'), [0, 2, 3]); assert.deepEqual(q(R, 'rating:unrated').slice(0, 3), [1, 5, 7], 'unrated includes other kinds');
  assert.deepEqual(q(R, 'stars:1|5'), [2, 6]); assert.deepEqual(q(R, 'rating:<2 kind:avs'), [1, 5, 6]);
  assert.deepEqual(q(R, 'size:>20k'), [2]); assert.deepEqual(q(R, 'size:<1000 kind:avs'), [3, 5]); assert.deepEqual(q(R, 'size:1k..8k kind:avs'), [1, 4, 6], 'k is 1024 bytes');
  assert.deepEqual(q(R, 'kind:nerv'), [7]); assert.deepEqual(q(R, 'kind:hud'), [8, 9]); assert.deepEqual(q(R, 'kind:avs').length, 7); assert.deepEqual(q(R, 'kind:nerv|hud'), [7, 8, 9]);
  assert.deepEqual(q(R, 'tier:tuned'), [8]); assert.deepEqual(q(R, 'tier:auto'), [9]); assert.deepEqual(q(R, 'tier:showcase'), []);
  assert.deepEqual(q(R, 'is:broken'), [3]); assert.deepEqual(q(R, 'is:working kind:avs'), [0, 1, 2, 4, 5, 6]); assert.deepEqual(q(R, 'is:unavailable'), [5]); assert.deepEqual(q(R, 'is:available kind:nerv'), [7]);
  assert.deepEqual(q(R, 'is:favorite'), [2, 3]); assert.deepEqual(q(R, 'is:rated kind:avs'), [0, 2, 3, 4, 6]); assert.deepEqual(q(R, 'is:unrated kind:avs'), [1, 5]);
  assert.deepEqual(q(R, 'is:failed'), []); assert.deepEqual(q(R, 'is:played'), []);
  assert.deepEqual(q(R, '-is:broken kind:avs rating:>=4'), [2]); assert.deepEqual(q(R, '-kind:avs'), [7, 8, 9]);
  assert.deepEqual(q(R, 're:mix'), [], 'an unknown key is plain text'); assert.deepEqual(q(R, 'rating:>> intro'), [1, 2, 3], 'a malformed clause never blanks the list');
  assert.deepEqual(run(R, 'rating:>> intro').notes, ['ignored: rating:>>']);
  // Local HUD titles: search finds the neutral name and the overlay name (rows only).
  const titled = buildRecords(C, est.tree, null, null, undefined, new Map([['rhythm-duel-1', 'Sample Cabinet']]));
  assert.deepEqual(ids(runQuery(titled, parseQuery('cabinet'), null).ids), [8], 'the overlay title is searchable'); assert.deepEqual(ids(runQuery(titled, parseQuery('duel'), null).ids), [8], 'and the neutral name still is');
  assert.equal(titled.display[8], 'Sample Cabinet'); assert.equal(titled.display[0], C[0].name, 'AVS rows never take an overlay title');
  // Without a TaxonMap, style fields explain themselves and match nothing.
  for (const s of ['style:x', 'energy:calm', 'busy:>1', 'author:x', 'fidelity:partial']) { const r = run(R, s); assert.deepEqual(ids(r.ids), [], s); assert.ok(r.notes.some(n => /no style data/.test(n)), s); assert.equal(r.notes.filter(n => /no style data/.test(n)).length, 1); }
  assert.ok(run(R, 'plays:>3').notes.includes('no play history yet')); assert.ok(run(R, 'played:<7d').notes.includes('no play history yet'));
  // A universe restricts the search to a folder's members, whatever the ids are.
  const universe = Int32Array.from([4, 2, 1, 999, -3]);
  assert.deepEqual(q(R, 'intro', universe), [2, 1], 'universe order is kept and bad indices are skipped'); assert.deepEqual(q(R, '', Int32Array.from([3, 5])), [3, 5]);
  assert.deepEqual(ids(run(R, 'intro', new Int32Array(0)).ids), []);
}

// ---------------------------------------------------------------------------------------------------- taxonomy fields
{
  const t = new Map([[H(1), {c: 'scope-classic', t: ['rings-stars'], e: 'calm', b: 2, f: 'full', a: 'Aria'}], [H(2), {c: 'particles', t: [], e: 'driving', b: 5, f: 'partial', a: 'Bram Stoker'}],
    [H(3), B.UNCLASSIFIED_TAXON], [H(4), {c: 'mixed', t: [], e: 'calm', b: 3, f: 'full'}]]);
  const {rs, catalog} = make(rows.slice(0, 4), {taxa: t});
  assert.deepEqual(q(rs, 'energy:calm'), [0, 3]); assert.deepEqual(q(rs, 'energy:calm|driving'), [0, 1, 3]); assert.deepEqual(q(rs, 'busy:>=3'), [1, 3]); assert.deepEqual(q(rs, 'busy:2'), [0]);
  assert.deepEqual(q(rs, 'author:aria'), [0]); assert.deepEqual(q(rs, 'author:stoker'), [1]); assert.deepEqual(q(rs, 'style:oscilloscopes'), [0], 'a style label matches');
  assert.deepEqual(q(rs, 'style:rings'), [0], 'a secondary category matches too'); assert.deepEqual(q(rs, 'style:scopes'), [0], 'and so does the family'); assert.deepEqual(q(rs, 'category:particles'), [1]);
  assert.deepEqual(q(rs, 'fidelity:partial'), [1]); assert.deepEqual(q(rs, 'fidelity:full'), [0, 3], 'unclassified presets are neither full nor partial'); assert.deepEqual(q(rs, 'is:partial'), [1]);
  assert.deepEqual(q(rs, '-energy:calm'), [1, 2], 'negation includes unclassified'); assert.equal(run(rs, 'energy:calm').notes.length, 0);
  assert.equal(rs.taxon[2], -1, 'a placeholder taxon is not classified'); assert.equal(rs.energy[2], -1); assert.equal(rs.busy[2], 0);
}

// ---------------------------------------------------------------------------------------------------- relevance
{
  const {rs, catalog} = make(['alpha beta', 'beta alpha', 'gammalpha', 'delta', 'x-alpha'].map((n, i) => row(i + 1, n, [[pkgA, `Alpha/dir/${n}.avs`]])), {sources});
  const r = run(rs, 'alpha');
  const score = i => r.score[i];
  assert.equal(score(0), 3, 'name prefix'); assert.equal(score(1), 2, 'word start'); assert.equal(score(2), 1, 'substring'); assert.equal(score(4), 2, 'word start after a symbol');
  assert.equal(r.score.length, 5, 'score is indexed by catalog index');
  const path = run(rs, 'dir'); assert.equal(path.score[3], 0.5, 'path-only match'); assert.equal(run(rs, 'alpha beta').score[0], 3 + 2, 'terms add up');
  assert.equal(run(rs, '').score, null, 'no text term: no score');
  // A later word start still counts (first occurrence is a plain substring).
  const {rs: r2} = make([row(1, 'xa a', [[pkgA, 'Alpha/x.avs']])], {sources});
  assert.equal(run(r2, 'a').score[0], 2, 'any word-start occurrence counts');
  const sorted = sortIndices(rs, r.ids, [{key: 'relevance', dir: 'desc'}], {seed: 1, score: r.score});
  assert.deepEqual(ids(sorted), [0, 1, 4, 2, 3], 'relevance orders 3, 2, 2, 1, 0.5 (path only) with ties by name then index');
}

// ---------------------------------------------------------------------------------------------------- sorting
{
  const names = ['Intro 10', 'intro 2', 'Zebra', 'Éclair', 'eclair', 'apple', 'Intro 1', 'Apple'];
  const {rs} = make(names.map((n, i) => row(i + 1, n, [[pkgA, `Alpha/${n}.avs`]], i % 3 ? {rating: i % 5} : {})), {sources});
  const all = Int32Array.from(names.map((n, i) => i));
  const by = (spec, ctx = {seed: 1}) => ids(sortIndices(rs, all, spec, ctx)).map(i => names[i]);
  assert.deepEqual(by([{key: 'name', dir: 'asc'}]), ['apple', 'Apple', 'Éclair', 'eclair', 'Intro 1', 'intro 2', 'Intro 10', 'Zebra'], 'natural, accent- and case-insensitive; equal keys keep catalog order');
  const desc = by([{key: 'name', dir: 'desc'}]);
  assert.equal(desc[0], 'Zebra'); assert.equal(desc.at(-1), 'Apple', 'a tie under a reversed key still falls back to catalog order, so the later index comes last');
  assert.deepEqual(by([]), by([{key: 'name', dir: 'asc'}]), 'no keys: name order'); assert.deepEqual(by([{key: 'nonsense', dir: 'asc'}]), by([]), 'an unknown key is ignored');
  // rating desc, then name; a third key is honoured, a fourth is ignored.
  const ratings = i => rs.rating[names.indexOf(i)];
  const byRating = by([{key: 'rating', dir: 'desc'}, {key: 'name', dir: 'asc'}]);
  for (let k = 1; k < byRating.length; k++) assert.ok(ratings(byRating[k - 1]) >= ratings(byRating[k]), 'rating never increases');
  assert.deepEqual(ids(sortIndices(rs, all, [{key: 'rating', dir: 'asc'}, {key: 'size', dir: 'desc'}, {key: 'name', dir: 'asc'}, {key: 'random', dir: 'asc'}], {seed: 3})), ids(sortIndices(rs, all, [{key: 'rating', dir: 'asc'}, {key: 'size', dir: 'desc'}, {key: 'name', dir: 'asc'}], {seed: 3})), 'at most three keys');
  // Size and path.
  const bySize = ids(sortIndices(rs, all, [{key: 'size', dir: 'desc'}], {seed: 1})); for (let k = 1; k < bySize.length; k++) assert.ok(rs.bytes[bySize[k - 1]] >= rs.bytes[bySize[k]]);
  // The result is a permutation and does not mutate its input.
  const before = ids(all); const out = sortIndices(rs, all, [{key: 'rating', dir: 'desc'}], {seed: 1}); assert.deepEqual(ids(all), before); assert.deepEqual(asc(out), asc(all)); assert.notEqual(out, all);
  // Random: deterministic per seed, different across seeds, always a permutation, does not depend on the input order.
  const r1 = ids(sortIndices(rs, all, [{key: 'random', dir: 'asc'}], {seed: 4821})), r1b = ids(sortIndices(rs, all, [{key: 'random', dir: 'asc'}], {seed: 4821})), r2 = ids(sortIndices(rs, all, [{key: 'random', dir: 'asc'}], {seed: 4822}));
  assert.deepEqual(r1, r1b); assert.notDeepEqual(r1, r2); assert.deepEqual(asc(r1), asc(all)); assert.deepEqual(ids(sortIndices(rs, Int32Array.from([...all].reverse()), [{key: 'random', dir: 'asc'}], {seed: 4821})), r1, 'same permutation whatever the input order');
  // Manual order, and manual without a map is ignored; taxonomy keys without data are ignored.
  const manual = new Map([[5, 0], [2, 1], [0, 2]]);
  assert.deepEqual(ids(sortIndices(rs, all, [{key: 'manual', dir: 'asc'}], {seed: 1, manual})).slice(0, 3), [5, 2, 0], 'manual order first, the rest after by name');
  assert.deepEqual(by([{key: 'manual', dir: 'asc'}]), by([]), 'no manual map: name order'); assert.deepEqual(by([{key: 'style', dir: 'asc'}, {key: 'energy', dir: 'asc'}]), by([]), 'no taxonomy: ignored');
  // Plays and recency use statistics; unplayed sort last under the natural direction.
  const stats = emptyStats(); stats.plays.set(H(3), [4, 1000]); stats.plays.set(H(5), [9, 5000]); applyStats(rs, est.catalog, null);
  applyStats(rs, parseRows(names.map((n, i) => row(i + 1, n))), stats);
  assert.deepEqual(ids(sortIndices(rs, all, [{key: 'plays', dir: 'desc'}], {seed: 1})).slice(0, 2), [4, 2]); assert.deepEqual(ids(sortIndices(rs, all, [{key: 'recent', dir: 'desc'}], {seed: 1})).slice(0, 2), [4, 2]);
  assert.equal(rs.hasStats, true);
  // Defaults and labels cover every field.
  assert.equal(defaultDirection('rating'), 'desc'); assert.equal(defaultDirection('name'), 'asc'); assert.equal(defaultDirection('relevance'), 'desc');
  for (const f of SORT_FIELDS) assert.ok(SORT_LABELS[f], `label for ${f}`);
  assert.equal(SORT_FIELDS.length, 15);
}

// ---------------------------------------------------------------------------------------------------- taxonomy sorts
{
  const taxa = new Map([[H(1), {c: 'particles', t: [], e: 'intense', b: 4, f: 'full', a: 'Zed'}], [H(2), {c: 'scope-classic', t: [], e: 'calm', b: 1, f: 'partial', a: 'Amy'}], [H(3), {c: 'mixed', t: [], e: 'steady', b: 2, f: 'full'}]]);
  const {rs} = make(['C', 'A', 'B', 'D'].map((n, i) => row(i + 1, n, [[pkgA, `Alpha/${n}.avs`]])), {sources, taxa});
  const all = Int32Array.from([0, 1, 2, 3]);
  const s = (key, dir = 'asc') => ids(sortIndices(rs, all, [{key, dir}], {seed: 1}));
  assert.deepEqual(s('style'), [1, 0, 2, 3], 'taxonomy order; unclassified last'); assert.deepEqual(s('style', 'desc'), [2, 0, 1, 3], 'unclassified stays last when reversed');
  assert.deepEqual(s('energy'), [1, 2, 0, 3]); assert.deepEqual(s('busyness'), [1, 2, 0, 3]); assert.deepEqual(s('author'), [1, 0, 2, 3], 'authors A-Z; no author last');
  assert.deepEqual(s('fidelity'), [2, 0, 1, 3], 'full first (B before C by name), partial next, unclassified last');
}

// ---------------------------------------------------------------------------------------------------- record updates
{
  const {rs, catalog} = make(rows.slice(0, 3), {sources});
  const v0 = rs.version;
  updateRecord(rs, 0, {...catalog[0], rating: 5}); assert.equal(rs.rating[0], 5); assert.ok(rs.version > v0);
  updateRecord(rs, 0, {...catalog[0], rating: 5, notWorking: true}); assert.ok(rs.flags[0] & FLAG.notWorking); assert.deepEqual(q(rs, 'is:broken'), [0]);
  updateRecord(rs, 0, {...catalog[0], rating: 2, notWorking: false}); assert.equal(rs.flags[0] & FLAG.notWorking, 0); assert.equal(rs.rating[0], 2);
  const kept = rs.flags[0]; updateRecord(rs, -1, catalog[0]); updateRecord(rs, 99, catalog[0]); updateRecord(rs, 1.5, catalog[0]); assert.equal(rs.flags[0], kept, 'bad indices are ignored');
  updateRecord(rs, 1, {...catalog[1], rating: 99}); assert.equal(rs.rating[1], 5, 'rating is clamped'); updateRecord(rs, 1, {...catalog[1], rating: -3}); assert.equal(rs.rating[1], 0);
  // The kind flags survive an update (they are not part of a rating or mark change).
  const kinds = make([...rows.slice(0, 1), nerv, hudRow]); updateRecord(kinds.rs, 1, {...kinds.catalog[1], rating: 3}); assert.ok(kinds.rs.flags[1] & FLAG.nerv); assert.ok(kinds.rs.flags[2] & FLAG.hud);
  // Session failures mirror into the flags.
  assert.equal(syncFailed(rs, new Set([1])), true); assert.ok(rs.flags[1] & FLAG.failed); assert.deepEqual(q(rs, 'is:failed'), [1]); assert.equal(syncFailed(rs, new Set([1])), false, 'unchanged: no bump');
  assert.equal(syncFailed(rs, new Set()), true); assert.equal(rs.flags[1] & FLAG.failed, 0);
  const catalogFailed = make(rows.slice(0, 3)); const withFailed = buildRecords(catalogFailed.catalog, catalogFailed.tree, null, null, new Set([2])); assert.ok(withFailed.flags[2] & FLAG.failed);
}

// ---------------------------------------------------------------------------------------------------- oracle property test
{
  const fx = syntheticCatalog(900, 11, {hud: 60, hudNeo: 25});
  const catalog = parseLocalAvsCatalog(fx.catalogJson, fx.validationJson, BASE), sources = parseLocalAvsSources(fx.sourcesJson);
  const tree = buildFolderTree(catalog, {sources}), rs = buildRecords(catalog, tree);
  const fold = s => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const oraclePath = i => tree.locations[i].map(id => {
    const labels = [];
    for (let at = id; at >= 0; at = tree.nodes[at].parent) { const n = tree.nodes[at]; if (n.key === 'avs' || n.key === 'avs/src') continue; labels.unshift(fold(n.label)); }
    return labels.join(' / ');
  }).join(' | ');
  const oracleName = i => fold(catalog[i].name);
  const rand = mulberry32(2024);
  const pickOf = list => list[Math.floor(rand() * list.length)];
  const words = ['acid', 'aurora', 'binary', 'cascade', 'delta', 'ember', 'fractal', 'nebula', 'orbit', 'plasma', 'ripple', 'tunnel', 'vector', 'wave', 'intro', 'cafe', 'nuit', 'uber', 'zoe', 'wrapper', 'scopes', 'misc', 'artist', 'collections', 'showcase', 'neo', 'fixture', 'set'];
  const fragments = () => { const p = catalog[Math.floor(rand() * catalog.length)]; const n = fold(p.name); const at = Math.floor(rand() * Math.max(1, n.length - 3)); return n.slice(at, at + 3 + Math.floor(rand() * 3)).trim() || 'a'; };
  const termWord = () => (rand() < 0.5 ? pickOf(words) : fragments()).replace(/["\s]/g, '');
  const clauses = [];
  const gens = [
    () => { const t = termWord(); return {text: t, test: i => oracleName(i).includes(t) || oraclePath(i).includes(t)}; },
    () => { const t = termWord(); return {text: `-${t}`, test: i => !(oracleName(i).includes(t) || oraclePath(i).includes(t))}; },
    () => { const t = termWord(); return {text: `name:${t}`, test: i => oracleName(i).includes(t)}; },
    () => { const t = termWord(), u = termWord(); return {text: `name:${t}|${u}`, test: i => oracleName(i).includes(t) || oracleName(i).includes(u)}; },
    () => { const t = termWord(); return {text: `-name:${t}`, test: i => !oracleName(i).includes(t)}; },
    () => { const t = termWord(); return {text: `path:${t}`, test: i => oraclePath(i).includes(t)}; },
    () => { const v = Math.floor(rand() * 6); return {text: `rating:>=${v}`, test: i => (catalog[i].rating ?? 0) >= v}; },
    () => { const a = Math.floor(rand() * 5), b = a + Math.floor(rand() * (6 - a)); return {text: `rating:${a}..${b}`, test: i => (catalog[i].rating ?? 0) >= a && (catalog[i].rating ?? 0) <= b}; },
    () => ({text: 'rating:unrated', test: i => (catalog[i].rating ?? 0) === 0}),
    () => { const k = 1 + Math.floor(rand() * 150); return {text: `size:>${k}k`, test: i => catalog[i].bytes >= k * 1024 + 1}; },
    () => { const k = 1 + Math.floor(rand() * 150); return {text: `size:<=${k}k`, test: i => catalog[i].bytes <= k * 1024}; },
    () => { const k = pickOf(['avs', 'nerv', 'hud']); return {text: `kind:${k}`, test: i => catalog[i].kind === k}; },
    () => ({text: 'is:broken', test: i => !!catalog[i].notWorking}),
    () => ({text: '-is:broken', test: i => !catalog[i].notWorking}),
    () => ({text: 'is:unavailable', test: i => catalog[i].parserStatus === 'parse-error'}),
    () => ({text: 'is:favorite', test: i => (catalog[i].rating ?? 0) >= 4}),
  ];
  let nonEmpty = 0, checkedQueries = 0;
  for (let n = 0; n < 400; n++) {
    const parts = Array.from({length: 1 + Math.floor(rand() * 4)}, () => pickOf(gens)());
    const text = parts.map(p => p.text).join(' ');
    const universe = rand() < 0.3 ? Int32Array.from(catalog.map((p, i) => i).filter(() => rand() < 0.5)) : null;
    const expected = (universe ? ids(universe) : catalog.map((p, i) => i)).filter(i => parts.every(p => p.test(i)));
    const got = ids(runQuery(rs, parseQuery(text), universe).ids);
    assert.deepEqual(got, expected, `query ${JSON.stringify(text)}`);
    if (expected.length) nonEmpty++;
    checkedQueries++;
  }
  assert.ok(nonEmpty > 100, `the property test is not vacuous (${nonEmpty} non-empty of ${checkedQueries})`);

  // Sorting property: every key spec yields a total order (comparator consistent) and a permutation of the input.
  const all = runQuery(rs, parseQuery(''), null).ids;
  const spec = () => Array.from({length: 1 + Math.floor(rand() * 3)}, () => ({key: pickOf(['name', 'rating', 'path', 'package', 'size', 'random']), dir: pickOf(['asc', 'desc'])}));
  for (let n = 0; n < 60; n++) {
    const s = spec(), seed = Math.floor(rand() * 1e6);
    const out = sortIndices(rs, all, s, {seed});
    assert.equal(out.length, all.length); assert.deepEqual(asc(out), asc(all));
    assert.deepEqual(ids(sortIndices(rs, Int32Array.from([...all].reverse()), s, {seed})), ids(out), `order does not depend on input order: ${JSON.stringify(s)}`);
    for (let k = 1; k < out.length; k += 7) {
      const a = out[k - 1], b = out[k];
      for (const {key, dir} of s.slice(0, 1)) {
        const v = i => key === 'rating' ? rs.rating[i] : key === 'size' ? rs.bytes[i] : key === 'name' ? rs.nameRank[i] : key === 'path' ? rs.pathRank[i] : key === 'package' ? rs.pkgRank[i] : 0;
        if (key !== 'random') assert.ok(dir === 'asc' ? v(a) <= v(b) : v(a) >= v(b), `primary key ${key} ${dir} at ${k}`);
      }
    }
  }
  // Path and package ranks follow the primary location's natural order.
  const byPath = sortIndices(rs, all, [{key: 'path', dir: 'asc'}], {seed: 1});
  for (let k = 1; k < byPath.length; k++) assert.ok(rs.pathRank[byPath[k - 1]] <= rs.pathRank[byPath[k]]);
  // Natural order in a full catalog: "Intro 2" .. "Intro 12" ascend by number.
  const intro = ids(sortIndices(rs, Int32Array.from(catalog.map((p, i) => i).filter(i => /^Intro \d+$/.test(catalog[i].name))), [{key: 'name', dir: 'asc'}], {seed: 1})).map(i => Number(catalog[i].name.slice(6)));
  assert.ok(intro.length > 5); for (let k = 1; k < intro.length; k++) assert.ok(intro[k - 1] <= intro[k], 'Intro numbers ascend');
}

// ---------------------------------------------------------------------------------------------------- virtual window
{
  const w = visibleWindow;
  assert.deepEqual(w(0, 300, 36, 0), {start: 0, end: 0, offset: 0}, 'no rows');
  assert.deepEqual(w(0, 300, 36, 1000), {start: 0, end: 15, offset: 0}, 'top: ceil(300/36)=9 rows plus overscan 6');
  assert.deepEqual(w(3600, 300, 36, 1000), {start: 94, end: 115, offset: 94 * 36}, 'row 100 at the top, six rows of overscan above');
  assert.deepEqual(w(1e9, 300, 36, 1000), {start: 994, end: 1000, offset: 994 * 36}, 'scrolled past the end: the last rows (the overscan above stays)');
  assert.deepEqual(w(0, 5000, 36, 10), {start: 0, end: 10, offset: 0}, 'a viewport larger than the list');
  assert.deepEqual(w(-50, 300, 36, 1000).start, 0); assert.deepEqual(w(NaN, 300, 36, 1000), w(0, 300, 36, 1000), 'a NaN scroll offset reads as the top');
  for (const bad of [[0, 0, 36, 500], [0, 300, 0, 500], [0, NaN, 36, 500], [0, 300, NaN, 500], [0, Infinity, 36, 500], [0, -10, 36, 500]]) assert.deepEqual(w(...bad), {start: 0, end: 60, offset: 0}, `unmeasured ${bad}: first 60 rows`);
  assert.deepEqual(w(0, 0, 36, 20), {start: 0, end: 20, offset: 0}, 'unmeasured and short'); assert.deepEqual(w(0, 0, 36, 500, 6, 10), {start: 0, end: 10, offset: 0}, 'the fallback size is a parameter');
  assert.deepEqual(w(0, 300, 36, NaN), {start: 0, end: 0, offset: 0}); assert.deepEqual(w(0, 300, 36, -5), {start: 0, end: 0, offset: 0}); assert.deepEqual(w(0, 300, 36, 12.9).end, 12);
  assert.deepEqual(w(100, 300, 36, 1000, 0), {start: 2, end: 12, offset: 72}, 'overscan 0');
  // Sweeping every offset never yields an empty or inverted window, and always covers the viewport.
  for (let top = 0; top <= 36 * 1000; top += 17) {
    const win = w(top, 300, 36, 1000);
    assert.ok(win.start >= 0 && win.end <= 1000 && win.start < win.end, `window at ${top}`);
    const first = Math.floor(top / 36), last = Math.min(999, Math.ceil((top + 300) / 36) - 1);
    assert.ok(win.start <= first && win.end > last, `viewport covered at ${top}`);
    assert.ok(win.end - win.start <= 9 + 1 + 12 + 1, 'a bounded number of DOM rows');
    assert.equal(win.offset, win.start * 36);
  }
}

// ---------------------------------------------------------------------------------------------------- budget
{
  const fx = syntheticCatalog(6000, 5);
  const catalog = parseLocalAvsCatalog(fx.catalogJson, fx.validationJson, BASE), sources = parseLocalAvsSources(fx.sourcesJson);
  const tree = buildFolderTree(catalog, {sources}), rs = buildRecords(catalog, tree);
  let best = Infinity;
  for (let round = 0; round < 5; round++) {
    const t0 = performance.now();
    const r = runQuery(rs, parseQuery('a e -zz rating:>=0 kind:avs'), null);
    sortIndices(rs, r.ids, [{key: 'relevance', dir: 'desc'}, {key: 'rating', dir: 'desc'}, {key: 'name', dir: 'asc'}], {seed: 1, score: r.score});
    best = Math.min(best, performance.now() - t0);
  }
  // Design budget: search plus sort of 6,000 rows well under 40 ms. The bound here is loose because agents share this machine.
  assert.ok(best < 250, `search + sort over ${catalog.length} rows took ${best.toFixed(1)} ms`);
  console.log(`  (search + sort of ${catalog.length} rows: best of 5 = ${best.toFixed(1)} ms)`);
}

console.log('Folder query PASS: parser grammar and totality (3,000 fuzz strings), fields, alternatives, ranges, exclusion, universe, relevance, natural and multi-key sorting, random per seed, manual/taxonomy keys, record patching, 400 oracle queries, virtual window sweep, 6,000-row budget');
