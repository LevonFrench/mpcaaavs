import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// CPU checks for tools/classify-presets.mjs (docs/design/PRESET-TAXONOMY-AND-JEV.md 5 and 9, docs/design/CONTRACT.md C-26 and C-38).
// Everything runs against a synthetic collection in a temporary directory with an injected fetch and a sentinel environment. No
// network, no real key and no real collection are touched: the Jev path is exercised only through a fake fetch.
const tool = await import('./classify-presets.mjs');
const engine = await tool.loadEngine();
const SENTINEL = 'SENTINEL-KEY-0000-not-a-real-credential';
const sha = data => createHash('sha256').update(data).digest('hex');

// ---- synthetic preset bytes -------------------------------------------------------------------------------------------------
const le32 = n => { const b = Buffer.alloc(4); b.writeInt32LE(n | 0); return b; };
const cstr = s => Buffer.from(`${s}\0`, 'latin1');
const lp = s => Buffer.concat([le32(Buffer.byteLength(s) + 1), cstr(s)]);
const rec = (id, payload = Buffer.alloc(0), ape = null) => Buffer.concat([le32(id), ...(ape ? [Buffer.from(ape.padEnd(32, '\0'), 'latin1')] : []), le32(payload.length), payload]);
const B = { Simple: 0, 'Fade Out': 3, 'OnBeat Clear': 5, Blur: 6, Ring: 14, Movement: 15, 'Dot Grid': 17, Water: 20, Comment: 21, Mirror: 26, Starfield: 27, Text: 28, Bump: 29, SuperScope: 36, Interferences: 41 };
const b = (name, payload) => rec(B[name], payload);
const scriptMove = () => b('Movement', Buffer.concat([le32(32767), Buffer.from([1]), le32(8), cstr('x=x+0.1'), le32(0), le32(0), le32(0), le32(0), le32(0)]));
const superscope = (point, lines = true) => b('SuperScope', Buffer.concat([Buffer.from([1]), lp(point), lp(''), lp(''), lp(''), le32(2), le32(1), le32(0xffffff), le32(lines ? 1 : 0)]));
const list = (children, beat = false) => { const head = Buffer.alloc(37); head[0] = 0x80; head[4] = 0x24; if (beat) head.writeInt32LE(1, 29); return rec(-2, Buffer.concat([head, ...children])); };
const preset = (...records) => Buffer.concat([Buffer.from('Nullsoft AVS Preset 0.2\x1a', 'latin1'), Buffer.from([0]), ...records]);
const fill = (n, salt = 0) => Array.from({ length: n }, (_, i) => b('Comment', Buffer.from(`c${salt}-${i}`)));
const SECRET_EEL = 'SECRET_EEL_MARKER_9931';

const RECIPES = [
  ['Alpha - Starfield Run', () => preset(b('Starfield'), b('Blur'), ...fill(3, 1))],
  ['Alpha - Ripple Pond', () => preset(b('Water'), b('Movement'), ...fill(3, 2))],
  ['Bravo - Mirror Room', () => preset(b('Mirror'), ...fill(4, 3))],
  ['Bravo - Ring Song', () => preset(b('Ring'), ...fill(5, 4))],
  ['Charlie - Words', () => preset(b('Text'), ...fill(4, 5))],
  ['Charlie - Dots', () => preset(b('Dot Grid'), ...fill(6, 6))],
  ['Delta - Beat Room', () => preset(b('OnBeat Clear'), list([b('Ring')], true), ...fill(3, 7))],
  ['Delta - Bumpy', () => preset(b('Bump'), ...fill(3, 8))],
  ['Echo - Static', () => preset(b('Interferences'), ...fill(3, 9))],
  ['Echo - Lines', () => preset(b('Simple'), ...fill(3, 10))],
  ['Foxtrot - Secret Code', () => preset(superscope(`x=i; y=v; ${SECRET_EEL}=1`, true), b('Simple'), ...fill(3, 11))],
  // nothing distinctive: mixed, k = 0, so these are Jev candidates
  ['Golf - Plain One', () => preset(scriptMove(), b('Fade Out'), ...fill(3, 12))],
  ['Golf - Plain Two', () => preset(scriptMove(), b('Blur'), ...fill(4, 13))],
  [`Hotel - Evil C:\\Users\\bob\\stash\\x.avs =HYPERLINK("http://x.invalid") [4 stars]`, () => preset(scriptMove(), ...fill(5, 14))],
  ['India - Quoted, "Comma"\nNewline', () => preset(b('Blur'), ...fill(5, 15))],
  ['Just a fragment', () => preset(b('Comment'))],
  // a tie: low confidence, so also a candidate
  ['Kilo - Tie', () => preset(b('Ring'), b('Simple'), ...fill(3, 16))],
];
for (let i = 0; i < 12; i++) RECIPES.push([`Lima - Filler ${i}`, () => preset(i % 2 ? b('Water') : b('Mirror'), ...fill(3 + (i % 5), 100 + i))]);

const state = { fetchCalls: 0 };
async function makeCollection(root, { extra = true } = {}) {
  await mkdir(path.join(root, 'catalog'), { recursive: true });
  await mkdir(path.join(root, 'presets', 'unique'), { recursive: true });
  const presets = []; const files = new Map();
  let n = 0;
  for (const [name, make] of RECIPES) {
    const bytes = make(); const hash = sha(bytes);
    const rel = `presets/unique/p${String(n++).padStart(3, '0')}-${hash.slice(0, 8)}.avs`;
    await writeFile(path.join(root, rel), bytes);
    presets.push({ sha256: hash, canonical_path: rel, bytes: bytes.length, display_name: name, rating: 4, notWorking: false, occurrences: [{ package_id: 'pkg-secret', path: 'C:\\stage\\x.avs' }] });
    files.set(hash, name);
  }
  if (extra) {
    const garbage = Buffer.from('not an avs file at all, but the hash matches');
    const relBad = 'presets/unique/garbage.avs'; await writeFile(path.join(root, relBad), garbage);
    presets.push({ sha256: sha(garbage), canonical_path: relBad, bytes: garbage.length, display_name: 'Broken parse' });
    const drifted = preset(b('Text'), ...fill(3, 99)); const relDrift = 'presets/unique/drift.avs'; await writeFile(path.join(root, relDrift), drifted);
    presets.push({ sha256: 'f'.repeat(64), canonical_path: relDrift, bytes: drifted.length, display_name: 'Hash mismatch' });
    presets.push({ sha256: 'e'.repeat(64), canonical_path: '../outside.avs', bytes: 10, display_name: 'Traversal' });
    presets.push({ sha256: 'd'.repeat(64), canonical_path: 'presets/unique/none.nerv', bytes: 10, display_name: 'Scene', kind: 'nerv', scene: 'x' });
  }
  await writeFile(path.join(root, 'catalog', 'presets.json'), JSON.stringify({ presets }, null, 1));
  await writeFile(path.join(root, 'catalog', 'parser-validation.json'), JSON.stringify({ results: [] }));
  await writeFile(path.join(root, 'setups.json'), '{"setups":[]}');
  await writeFile(path.join(root, 'settings.json'), '{"enabled":false}');
  return { presets, files };
}
async function snapshot(dir) {
  const out = new Map();
  const walk = async d => { for (const e of await readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else out.set(path.relative(dir, p).replaceAll('\\', '/'), `${sha(await readFile(p))}:${(await stat(p)).mtimeMs}`); } };
  await walk(dir); return out;
}
const added = (before, after) => [...after.keys()].filter(k => !before.has(k)).sort();
const changed = (before, after) => [...before.keys()].filter(k => after.get(k) !== before.get(k));

// ---- harness -------------------------------------------------------------------------------------------------------------
const FIXED_NOW = new Date('2026-09-30T12:00:00.000Z');
function harness({ env = {}, handler = null, runKeyCommand = () => '' } = {}) {
  const out = [], err = [], calls = [];
  const deps = {
    env, stdout: s => out.push(s), stderr: s => err.push(s), now: () => FIXED_NOW, sleep: async () => {}, random: () => 0.5, runKeyCommand,
    fetch: async (url, init) => {
      state.fetchCalls++; calls.push({ url: String(url), init });
      if (!handler) throw new Error('fetch must not be called in this test');
      return handler(url, init, calls.length);
    },
  };
  return { deps, out, err, calls, text: () => out.join('') + err.join('') };
}
const json = (obj, status = 200, type = 'application/json') => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status, headers: { 'content-type': type } });
/** A valid System One style answer picking `choice` (an option key) with probability p and the rest spread evenly. */
function styleAnswer(choice, p = 0.8) {
  const options = engine.TAXONOMY.map(t => tool.optionKey(t.id));
  const rest = (1 - p) / (options.length - 1);
  return { model: tool.JEV_MODEL, answers: { style: { choice, probabilities: Object.fromEntries(options.map(k => [k, k === choice ? p : rest])), confidence: 0.7 } }, usage: { input_tokens: 100 } };
}
const bodyOf = init => JSON.parse(init.body);
const CSV_HEAD = 'row,title,deterministic,k,jev,p,conflict,category';
const readCategories = async dir => JSON.parse(await readFile(path.join(dir, 'categories.json'), 'utf8'));
const args = (root, ...more) => ['--collection', root, ...more];

const base = await mkdtemp(path.join(os.tmpdir(), 'aaavs-classify-'));
try {
  // ---- 1. arguments and refusals ---------------------------------------------------------------------------------------
  {
    for (const bad of [[], ['--collection', 'relative/dir'], ['--collection', base, '--api-key', SENTINEL], ['--collection', base, '--send'], ['--collection', base, '--jev-apply'],
      ['--collection', base, '--limit', '0'], ['--collection', base, '--concurrency', '99'], ['--collection', base, '--jev', '--jev-url', 'http://example.com/x'],
      ['--collection', base, '--jev', '--jev-url', 'ftp://127.0.0.1/x'], ['--collection', base, '--out-dir', 'rel'], ['--collection', base, '--review-csv', path.join(base, 'x.txt')], ['--collection', base, '--bogus']]) {
      const h = harness({ env: { TYPESAFE_API_KEY: SENTINEL } });
      assert.equal(await tool.run(bad, h.deps), 2, JSON.stringify(bad));
      assert.ok(!h.text().includes(SENTINEL));
    }
    const h = harness();
    assert.equal(await tool.run(['--collection', base, '--api-key', SENTINEL], h.deps), 2);
    assert.ok(!h.text().includes(SENTINEL), 'a key given as a flag is never echoed');
    assert.ok(/no key flag|environment/i.test(h.text()));
    assert.equal(tool.parseArgs(['--collection', base, '--jev', '--jev-url', 'http://127.0.0.1:9/x']).jevUrl, 'http://127.0.0.1:9/x');
    assert.equal(tool.parseArgs(['--collection', base, '--jev', '--jev-url', 'http://localhost:9/x']).jev, true);
    // a directory without catalog/presets.json is refused and nothing is written
    const empty = path.join(base, 'empty'); await mkdir(empty);
    const before = await snapshot(empty);
    const e = harness(); assert.equal(await tool.run(args(empty), e.deps), 2);
    assert.deepEqual(added(before, await snapshot(empty)), []);
    assert.equal(state.fetchCalls, 0);
  }

  // ---- 2. offline default ----------------------------------------------------------------------------------------------
  const root = path.join(base, 'avs presets');
  const fixture = await makeCollection(root);
  const catalogDir = path.join(root, 'catalog');
  {
    const before = await snapshot(root);
    const h = harness();      // no key, no handler: any fetch attempt throws
    assert.equal(await tool.run(args(root), h.deps), 0, h.text());
    const after = await snapshot(root);
    assert.equal(h.calls.length, 0, 'no key and no --jev: fetch is never called');
    assert.deepEqual(added(before, after), ['catalog/categories.json', 'catalog/categories.review.csv'], 'only the new files are created');
    assert.deepEqual(changed(before, after), [], 'no existing file changed in content or mtime (presets.json byte-identical)');
    const doc = await readCategories(catalogDir);
    assert.equal(doc.format, 'aaavs-categories'); assert.equal(doc.version, 1);
    assert.deepEqual(doc.taxonomy, { id: 'aaavs-style', version: engine.TAXONOMY_VERSION });
    assert.equal(doc.generated, '2026-09-30T12:00:00Z');
    assert.deepEqual(doc.generator, { tool: 'classify-presets', method: 'structure-v1', jev: null });
    const hashes = Object.keys(doc.entries);
    assert.deepEqual(hashes, [...hashes].sort(), 'entries are sorted for stable output');
    assert.equal(doc.catalogSha, sha(hashes.join('\n')));
    assert.equal(hashes.length, RECIPES.length, 'garbage, hash mismatch, traversal and scene rows produce no entry');
    for (const [hash, t] of Object.entries(doc.entries)) {
      assert.match(hash, /^[0-9a-f]{64}$/); assert.ok(fixture.files.has(hash));
      assert.deepEqual(Object.keys(t).filter(k => !['a', 'c', 't', 'e', 'b', 'f', 's', 'k'].includes(k)), []);
      assert.ok(engine.TAXONOMY.some(x => x.id === t.c) && t.t.length <= 2 && t.t.every(id => engine.TAXONOMY.some(x => x.id === id) && id !== t.c));
      assert.equal(t.s, 's'); assert.ok(t.k >= 0 && t.k <= 1 && ['calm', 'steady', 'driving', 'intense'].includes(t.e) && [1, 2, 3, 4, 5].includes(t.b) && ['full', 'partial'].includes(t.f));
    }
    const byName = name => doc.entries[[...fixture.files].find(([, n]) => n === name)[0]];
    assert.equal(byName('Alpha - Starfield Run').c, 'starfield'); assert.equal(byName('Alpha - Starfield Run').a, 'Alpha');
    assert.equal(byName('Just a fragment').c, 'minimal'); assert.equal(byName('Just a fragment').k, 0.9);
    assert.equal(byName('Golf - Plain One').c, 'mixed');
    assert.equal(byName('Bravo - Mirror Room').c, 'kaleido-mirror'); assert.equal(byName('Delta - Beat Room').c, 'beat-flash');
    // a second run with the same clock is byte-identical, and leaves no temp files
    const first = await readFile(path.join(catalogDir, 'categories.json'), 'utf8');
    assert.equal(await tool.run(args(root), harness().deps), 0);
    assert.equal(await readFile(path.join(catalogDir, 'categories.json'), 'utf8'), first);
    assert.ok(![...(await snapshot(root)).keys()].some(k => k.includes('.tmp-')), 'atomic writes leave no temp file');
    // the writer itself refuses every protected collection file name; only the review import may write the overrides file
    for (const name of ['presets.json', 'parser-validation.json', 'sources.json', 'setups.json', 'settings.json', 'folders.json', 'stats.json', 'categories.overrides.json', 'Presets.JSON']) {
      await assert.rejects(() => tool.writeAtomic(path.join(base, name), '{}'), /protected file/, `writeAtomic refuses ${name}`);
    }
    await assert.rejects(() => tool.writeAtomic(path.join(base, 'presets.json'), '{}', { allowOverrides: true }), /protected file/, 'the overrides allowance covers only the overrides file');
    // review CSV: header, sorted worst first, no hashes, hostile cells neutralised
    const csv = await readFile(path.join(catalogDir, 'categories.review.csv'), 'utf8');
    assert.ok(csv.startsWith(CSV_HEAD + '\r\n'));
    assert.ok(!csv.includes(fixture.presets[0].sha256) && !/[0-9a-f]{64}/.test(csv), 'review rows carry no hash');
    assert.ok(!csv.includes('C:\\') && !csv.includes('stash\\'), 'no backslash paths in titles');
    const rows = tool.parseCsv(csv); const head = rows.shift();
    assert.deepEqual(head, CSV_HEAD.split(','));
    assert.ok(rows.length >= 5, 'mixed and low-k presets are listed');
    const ks = rows.map(r => Number(r[3])); assert.deepEqual(ks, [...ks].sort((x, y) => x - y), 'lowest confidence first (no conflicts offline)');
    assert.ok(rows.some(r => r[1].includes('HYPERLINK') && r[1].startsWith("'") === false), 'the title survives; only a leading = would be escaped');
    assert.ok(rows.every(r => !/^[=+\-@]/.test(r[1])), 'no cell starts with a formula character');
    assert.equal(tool.csvCell('=1+1'), "'=1+1"); assert.equal(tool.csvCell('a,b'), '"a,b"'); assert.equal(tool.csvCell('q"q'), '"q""q"'); assert.equal(tool.csvCell('-x'), "'-x");
  }

  // ---- 3. --out-dir keeps the collection untouched --------------------------------------------------------------------
  {
    const out = path.join(base, 'scratch-out');
    const before = await snapshot(root);
    const h = harness(); assert.equal(await tool.run(args(root, '--out-dir', out), h.deps), 0);
    assert.deepEqual([...(await snapshot(root)).entries()].filter(([k, v]) => before.get(k) !== v), [], 'the collection is byte- and mtime-identical');
    assert.deepEqual((await readdir(out)).sort(), ['categories.json', 'categories.review.csv']);
    assert.deepEqual(await readCategories(out), await readCategories(catalogDir));
    const inside = harness(); assert.equal(await tool.run(args(root, '--out-dir', path.join(root, 'presets')), inside.deps), 2, 'not inside the collection outside catalog/');
    const rootOut = harness(); assert.equal(await tool.run(args(root, '--out-dir', root), rootOut.deps), 2, 'the collection root itself is not an output directory');
    const guarded = await snapshot(root);
    for (const flag of ['--review-csv', '--gold-sample']) {
      const bad = harness();
      assert.equal(await tool.run(args(root, '--out-dir', out, flag, path.join(root, 'presets', 'unique', 'x.csv')), bad.deps), 2, `${flag} may not point into the preset tree`);
      assert.equal(await tool.run(args(root, '--out-dir', out, flag, path.join(root, 'x.csv')), harness().deps), 2, `${flag} may not point at the collection root`);
    }
    assert.deepEqual([...(await snapshot(root)).keys()].filter(k => !guarded.has(k)), [], 'a refused run writes nothing into the collection');
    assert.equal(await tool.run(args(root, '--out-dir', path.join(catalogDir, 'sub')), harness().deps), 0, 'a subfolder of catalog/ is fine');
    // write failure leaves no half-written file
    const blocked = path.join(base, 'blocked'); await mkdir(path.join(blocked, 'categories.json'), { recursive: true });
    await assert.rejects(tool.run(args(root, '--out-dir', blocked), harness().deps));
    assert.ok(!(await readdir(blocked)).some(n => n.includes('.tmp-')), 'a failed rename removes its temp file');
  }

  // ---- 4. Jev is off unless asked, dry-run first ----------------------------------------------------------------------------
  {
    const before = await snapshot(root);
    for (const flags of [['--jev'], ['--jev-dry-run'], ['--jev', '--jev-dry-run', '--send'], ['--jev', '--all', '--intensity']]) {
      const h = harness({ env: { TYPESAFE_API_KEY: SENTINEL } });
      assert.equal(await tool.run(args(root, '--out-dir', path.join(base, 'dry'), ...flags), h.deps), 0, flags.join(' '));
      assert.equal(h.calls.length, 0, `${flags.join(' ')} never sends`);
      assert.ok(h.out.join('').includes('DRY RUN (nothing is sent)'));
      assert.ok(!h.text().includes(SENTINEL));
    }
    const key = harness();       // no key at all
    assert.equal(await tool.run(args(root, '--out-dir', path.join(base, 'dry'), '--jev-dry-run'), key.deps), 0);
    const h = harness({ env: { TYPESAFE_API_KEY: SENTINEL } });
    await tool.run(args(root, '--out-dir', path.join(base, 'dry'), '--jev-dry-run', '--all'), h.deps);
    const text = h.out.join('');
    assert.ok(/Estimated input tokens \d+, about \$0\.\d+/.test(text));
    const payloadLines = text.split('\n').filter(l => l.startsWith('{"state"'));
    assert.equal(payloadLines.length, RECIPES.length, '--all lists every classified preset');
    assert.ok(text.includes('Golf - Plain One') || text.includes('Plain One'));
    const noNames = harness(); await tool.run(args(root, '--out-dir', path.join(base, 'dry'), '--jev-dry-run', '--all', '--no-names'), noNames.deps);
    assert.ok(!noNames.out.join('').includes('Plain One') && !noNames.out.join('').includes('Starfield Run'), '--no-names drops every title from the dry run');
    const limited = harness(); await tool.run(args(root, '--out-dir', path.join(base, 'dry'), '--jev-dry-run', '--all', '--limit', '3'), limited.deps);
    assert.equal(limited.out.join('').split('\n').filter(l => l.startsWith('{"state"')).length, 3);
    assert.deepEqual(changed(before, await snapshot(root)), [], 'the collection is never touched');
    // --send without any key: exit 3, message, offline result still written
    const nokey = harness({ handler: () => { throw new Error('unreachable'); } });
    const out = path.join(base, 'nokey');
    assert.equal(await tool.run(args(root, '--out-dir', out, '--jev', '--send'), nokey.deps), 3);
    assert.equal(nokey.calls.length, 0); assert.ok(/TYPESAFE_API_KEY/.test(nokey.text()));
    assert.deepEqual((await readdir(out)).sort(), ['categories.json', 'categories.review.csv'], 'the offline result is still written');
    assert.equal((await readCategories(out)).generator.jev, null);
  }

  // ---- 5. the payload allowlist, the key, and the wire behaviour -----------------------------------------------------------
  const sensitive = [...fixture.presets.flatMap(p => [p.sha256, p.canonical_path, path.basename(p.canonical_path)]), 'pkg-secret', 'C:\\stage', SECRET_EEL, base, root];
  const bannedKeys = new Set(['sha256', 'canonical_path', 'rating', 'notWorking', 'occurrences', 'package_id', 'path', 'bytes', 'fileName', 'display_name', 'source', 'setups', 'settings', 'point', 'frame', 'init', 'code']);
  const scanKeys = (value, found = new Set()) => { if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { found.add(k); scanKeys(v, found); } return found; };
  const sendOut = path.join(base, 'send');
  const goodHandler = (choice = 'text_image', p = 0.8) => (url, init) => json(styleAnswer(choice, p));
  {
    const h = harness({ env: { TYPESAFE_API_KEY: SENTINEL }, handler: goodHandler() });
    assert.equal(await tool.run(args(root, '--out-dir', sendOut, '--jev', '--send', '--all', '--concurrency', '3'), h.deps), 0, h.text());
    assert.equal(h.calls.length, RECIPES.length, 'one request per candidate');
    for (const c of h.calls) {
      assert.equal(c.url, tool.JEV_URL); assert.equal(c.init.method, 'POST'); assert.equal(c.init.redirect, 'error');
      assert.equal(c.init.headers.authorization, `Bearer ${SENTINEL}`); assert.equal(c.init.headers['content-type'], 'application/json');
      assert.ok(!('x-api-key' in c.init.headers));
      const body = bodyOf(c.init); const text = JSON.stringify(body);
      assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state']); assert.equal(body.model, 'jev-1.13.0');
      assert.deepEqual(Object.keys(body.questions), ['style']);
      assert.equal(Object.keys(body.questions.style.criteria).length, 18); assert.ok('general_mix' in body.questions.style.criteria);
      assert.ok(Object.keys(body.state).every(k => ['title', 'effects', 'structure', 'unrunnable_effects'].includes(k)));
      for (const s of sensitive) assert.ok(!text.includes(s), `a request carries none of the private values (${s.slice(0, 12)})`);
      const strings = []; const collect = v => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(collect); }; collect(body.state);
      assert.ok(strings.every(x => !/[\/]/.test(x) && !/[A-Za-z]:[\/]/.test(x)), 'no path separator or drive path in any state string');
      assert.ok(!text.includes('presets/unique') && !/[0-9a-f]{40}/.test(text) && !text.includes(SENTINEL), 'no path, no hash, and the key is only in the header');
      const keys = scanKeys(body.state); for (const k of bannedKeys) assert.ok(!keys.has(k), `state has no ${k} key`);
    }
    // the hostile title reached the state only in sanitised form
    const titles = h.calls.map(c => bodyOf(c.init).state.title);
    assert.ok(titles.some(t => t.startsWith('Hotel - Evil C: Users bob stash x.avs')), 'slashes removed from a hostile title');
    assert.ok(titles.every(t => !/[\r\n]/.test(t)));
    // the sentinel is nowhere on the machine output: stdout, stderr, categories, cache, review
    assert.ok(!h.text().includes(SENTINEL));
    for (const name of await readdir(sendOut)) assert.ok(!(await readFile(path.join(sendOut, name), 'utf8')).includes(SENTINEL), `${name} does not contain the key`);
    const doc = await readCategories(sendOut);
    assert.deepEqual(doc.generator.jev, { model: 'jev-1.13.0', promptVersion: 1, validated: false });
    // without --jev-apply a Jev answer changes nothing in the categories
    const offline = await readCategories(catalogDir);
    assert.deepEqual(doc.entries, offline.entries, 'Jev results are recorded but never applied without --jev-apply');
    // cache: fingerprints and answers only, and a rerun makes no calls
    const cache = (await readFile(path.join(sendOut, 'categories.jev-cache.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(cache.length, RECIPES.length);
    for (const line of cache) {
      assert.deepEqual(Object.keys(line).sort(), ['answer', 'key', 'model', 'promptVersion', 'taxonomyVersion']);
      assert.match(line.key, /^[0-9a-f]{64}$/);
    }
    const cacheText = JSON.stringify(cache);
    for (const [, name] of fixture.files) assert.ok(!cacheText.includes(name.slice(0, 12)), 'the cache holds no titles');
    const again = harness({ env: { TYPESAFE_API_KEY: SENTINEL }, handler: goodHandler() });
    assert.equal(await tool.run(args(root, '--out-dir', sendOut, '--jev', '--send', '--all'), again.deps), 0);
    assert.equal(again.calls.length, 0, 'a rerun is served from the cache');
    assert.ok(/cached/.test(again.out.join('')));
    // a model or prompt bump changes the key, so old answers are ignored rather than mixed
    const someState = engine.jevState(engine.normalizeComposition({ components: 5, effects: { b1: 1 } }), 'x');
    const k1 = tool.cacheKey(engine, someState, {});
    assert.notEqual(k1, tool.cacheKey({ ...engine, TAXONOMY_VERSION: engine.TAXONOMY_VERSION + 1 }, someState, {}), 'taxonomy bump invalidates');
    assert.notEqual(k1, tool.cacheKey(engine, someState, { intensity: true }));
    const stale = path.join(base, 'stale'); await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, 'categories.jev-cache.jsonl'), cache.map(l => JSON.stringify({ ...l, key: sha(l.key + 'old-prompt-version') })).join('\n') + '\n');
    const s = harness({ env: { TYPESAFE_API_KEY: SENTINEL }, handler: goodHandler() });
    await tool.run(args(root, '--out-dir', stale, '--jev', '--send', '--all'), s.deps);
    assert.equal(s.calls.length, RECIPES.length, 'cache lines from another prompt version are not used');
  }

  // ---- 6. --no-names, --intensity, --limit, --concurrency ---------------------------------------------------------------------
  {
    const h = harness({ env: { TYPESAFE_API_KEY: SENTINEL }, handler: goodHandler() });
    await tool.run(args(root, '--out-dir', path.join(base, 'nn'), '--jev', '--send', '--all', '--no-names', '--limit', '7'), h.deps);
    assert.equal(h.calls.length, 7);
    for (const c of h.calls) assert.ok(!('title' in bodyOf(c.init).state), '--no-names sends composition only');
    const i = harness({ env: { TYPESAFE_API_KEY: SENTINEL }, handler: (u, init) => json({ ...styleAnswer('text_image'), answers: { ...styleAnswer('text_image').answers, intensity: { score: 2.5 } } }) });
    await tool.run(args(root, '--out-dir', path.join(base, 'int'), '--jev', '--send', '--limit', '2', '--all', '--intensity'), i.deps);
    for (const c of i.calls) { const q = bodyOf(c.init).questions; assert.deepEqual(Object.keys(q), ['style', 'intensity']); assert.equal(q.intensity.criteria.length, 5); }
    const line = JSON.parse((await readFile(path.join(base, 'int', 'categories.jev-cache.jsonl'), 'utf8')).split('\n')[0]);
    assert.equal(line.answer.intensity, 2.5, 'the intensity answer is cached but never used for a category');
    let inflight = 0, peak = 0;
    const slow = harness({ env: { TYPESAFE_API_KEY: SENTINEL }, handler: async () => { inflight++; peak = Math.max(peak, inflight); await new Promise(r => setTimeout(r, 5)); inflight--; return json(styleAnswer('text_image')); } });
    await tool.run(args(root, '--out-dir', path.join(base, 'conc'), '--jev', '--send', '--all', '--concurrency', '2'), slow.deps);
    assert.ok(peak >= 1 && peak <= 2, `at most 2 requests in flight (saw ${peak})`);
  }

  // ---- 7. failure modes all fall back per preset with a normal exit ---------------------------------------------------------
  {
    const reference = await readCategories(catalogDir);
    const styleDoc = (mutate) => { const a = styleAnswer('text_image'); mutate(a.answers.style, a); return a; };
    const modes = {
      'HTTP 429 twice': () => json({ error: 'rate' }, 429),
      'HTTP 500 twice': () => json({ error: 'boom' }, 500),
      'HTML body': () => json('<html>maintenance</html>', 200, 'text/html'),
      'JSON with wrong type': () => json({ answers: { style: 'text_image' } }),
      'non-JSON 200': () => json('nope', 200, 'application/json'),
      'choice not among the options': () => json(styleDoc(s => { s.choice = 'totally_new'; })),
      'probabilities not summing': () => json(styleDoc(s => { for (const k of Object.keys(s.probabilities)) s.probabilities[k] = 0.5; })),
      'choice not the argmax': () => json(styleDoc(s => { s.choice = 'particles'; })),
      'probability out of range': () => json(styleDoc(s => { s.probabilities.particles = -0.2; })),
      'extra option key': () => json(styleDoc(s => { s.probabilities.extra = 0; })),
      'missing answers': () => json({ model: 'x' }),
      'fetch throws with the key in the message': () => { throw new Error(`socket closed Bearer ${SENTINEL} ${SENTINEL}`); },
      'redirect refused': () => { throw new TypeError('redirect mode is set to error'); },
      'declared oversize': () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024) } }),
      'streamed oversize': () => new Response('{"pad":"' + 'x'.repeat(1.2 * 1024 * 1024) + '"}', { status: 200, headers: { 'content-type': 'application/json' } }),
    };
    for (const [label, handler] of Object.entries(modes)) {
      const out = path.join(base, `fail-${label.replace(/\W+/g, '-')}`);
      const h = harness({ env: { TYPESAFE_API_KEY: SENTINEL }, handler });
      assert.equal(await tool.run(args(root, '--out-dir', out, '--jev', '--send', '--limit', '3', '--all', '--jev-apply'), h.deps), 0, label);
      assert.ok(h.calls.length >= 3, `${label}: it tried`);
      assert.ok(!h.text().includes(SENTINEL), `${label}: the key never appears in output`);
      assert.deepEqual((await readCategories(out)).entries, reference.entries, `${label}: the deterministic result is kept`);
      assert.ok(!(await readdir(out)).includes('categories.jev-cache.jsonl') || (await readFile(path.join(out, 'categories.jev-cache.jsonl'), 'utf8')).trim() === '', `${label}: nothing invalid is cached`);
      for (const name of await readdir(out)) assert.ok(!(await readFile(path.join(out, name), 'utf8')).includes(SENTINEL), `${label}: ${name} has no key`);
    }
    // the transport itself scrubs the key from any error it reports
    const leaky = await tool.callJev({ fetch: async () => { throw new Error(`down Bearer ${SENTINEL} and ${SENTINEL}`); }, sleep: async () => {}, random: () => 0 }, tool.JEV_URL, SENTINEL, {});
    assert.equal(leaky.ok, false); assert.ok(!JSON.stringify(leaky).includes(SENTINEL), 'callJev never returns the key');
    const okCall = await tool.callJev({ fetch: async () => json({ a: 1 }), sleep: async () => {}, random: () => 0 }, tool.JEV_URL, SENTINEL, {});
    assert.deepEqual([okCall.ok, okCall.json], [true, { a: 1 }]);
    // a transient 429 then success is retried once
    let n = 0;
    const retry = harness({ env: { TYPESAFE_API_KEY: SENTINEL }, handler: () => (n++ === 0 ? json({}, 429) : json(styleAnswer('text_image'))) });
    await tool.run(args(root, '--out-dir', path.join(base, 'retry'), '--jev', '--send', '--all', '--limit', '1'), retry.deps);
    assert.equal(retry.calls.length, 2); assert.equal((await readFile(path.join(base, 'retry', 'categories.jev-cache.jsonl'), 'utf8')).trim().split('\n').length, 1);
  }

  // ---- 8. acceptance policy -------------------------------------------------------------------------------------------------
  {
    const det = (primary, k, tags = []) => ({ primary, tags, k, facets: {}, score: 4 });
    const ans = (choice, p, q) => ({ choice, p, q });
    // agree
    let d = tool.decide(det('particles', 0.4), ans('particles', 0.8, 0.05), true);
    assert.deepEqual([d.c, d.s, d.disagree], ['particles', 'sj', false]); assert.ok(d.k > 0.4 && d.k <= 1);
    d = tool.decide(det('particles', 0.4), ans('particles', 0.8, 0.05), false);
    assert.deepEqual([d.c, d.s, d.k], ['particles', 's', 0.4]);
    // disagree with a confident structural decision: keep, flag
    d = tool.decide(det('particles', 0.6), ans('starfield', 0.95, 0.01), true);
    assert.deepEqual([d.c, d.s, d.disagree], ['particles', 's', true]);
    // disagree, weak structure, strong Jev: accept, keep the structural pick as a tag
    d = tool.decide(det('mixed', 0, []), ans('starfield', 0.6, 0.3), true);
    assert.deepEqual([d.c, d.s, d.k, d.disagree], ['starfield', 'j', 0.6, true]);
    assert.ok(!d.t.includes('mixed'), 'mixed is never a tag');
    d = tool.decide(det('particles', 0.3, ['color-grade']), ans('starfield', 0.7, 0.2), true);
    assert.deepEqual([d.c, d.t], ['starfield', ['particles', 'color-grade']]);
    // low p, small margin, general_mix, missing answer
    assert.equal(tool.decide(det('particles', 0.3), ans('starfield', 0.54, 0.1), true).c, 'particles');
    assert.equal(tool.decide(det('particles', 0.3), ans('starfield', 0.6, 0.45), true).c, 'particles');
    d = tool.decide(det('particles', 0.3), ans('mixed', 0.9, 0.02), true); assert.deepEqual([d.c, d.disagree], ['particles', false]);
    assert.equal(tool.decide(det('particles', 0.3), null, true).s, 's');
    // never applied without --jev-apply, but the disagreement is still flagged for the review file
    d = tool.decide(det('mixed', 0), ans('starfield', 0.9, 0.02), false); assert.deepEqual([d.c, d.disagree], ['mixed', true]);

    // end to end: with --jev-apply candidates change; conflicts and Jev columns reach the review CSV; owner overrides win
    const out = path.join(base, 'apply');
    const h = harness({ env: { TYPESAFE_API_KEY: SENTINEL }, handler: (u, init) => {
      const state = bodyOf(init).state; const names = state.effects.map(e => e.name);
      return json(names.includes('Movement') ? styleAnswer('starfield', 0.7) : styleAnswer('water_ripple', 0.9));
    } });
    assert.equal(await tool.run(args(root, '--out-dir', out, '--jev', '--send', '--all', '--jev-apply'), h.deps), 0, h.text());
    const doc = await readCategories(out); const offline = await readCategories(catalogDir);
    let sources = { s: 0, j: 0, sj: 0 };
    for (const [hash, t] of Object.entries(doc.entries)) sources[t.s]++;
    assert.ok(sources.j > 0 && sources.sj > 0 && sources.s > 0, JSON.stringify(sources));
    for (const [hash, t] of Object.entries(doc.entries)) if (t.s === 'j') assert.ok(offline.entries[hash].k < 0.6, 'Jev only replaces low-confidence structure');
    const csv = tool.parseCsv(await readFile(path.join(out, 'categories.review.csv'), 'utf8')); csv.shift();
    assert.ok(csv.some(r => r[6] === 'yes'), 'disagreements are listed'); assert.equal(csv[0][6], 'yes', 'conflicts sort first');
    assert.ok(csv.some(r => r[4] === 'starfield' && Number(r[5]) === 0.7));
    assert.deepEqual(Object.keys(doc.entries), Object.keys(offline.entries));
    // owner overrides always win and are never rewritten
    const [victim] = Object.keys(doc.entries);
    const overridesPath = path.join(out, 'categories.overrides.json');
    const overridesText = `{"format":"aaavs-category-overrides","version":1,"entries":{"${victim}":{"c":"glitch-digital","t":["text-image"]},"${'0'.repeat(64)}":{"c":"nope"},"__proto__":{"c":"mixed"},"bad-hash":{"c":"mixed"}}}
`;
    await writeFile(overridesPath, overridesText);
    const h2 = harness({ env: { TYPESAFE_API_KEY: SENTINEL }, handler: goodHandler('water_ripple', 0.9) });
    assert.equal(await tool.run(args(root, '--out-dir', out, '--jev', '--send', '--all', '--jev-apply'), h2.deps), 0);
    const after = await readCategories(out);
    assert.deepEqual([after.entries[victim].c, after.entries[victim].s, after.entries[victim].k], ['glitch-digital', 'o', 1], 'the override wins over Jev and structure');
    assert.equal(await readFile(overridesPath, 'utf8'), overridesText, 'categories.overrides.json is never rewritten by a normal run');
    assert.equal(Object.keys(after.entries).length, Object.keys(doc.entries).length, 'an unknown or malformed override adds no entry');
  }

  // ---- 9. review import writes overrides, and only it does ----------------------------------------------------------------------
  {
    const rev = path.join(base, 'review'); await mkdir(rev);
    assert.equal(await tool.run(args(root, '--out-dir', rev), harness().deps), 0);
    const csvPath = path.join(rev, 'categories.review.csv');
    const rows = tool.parseCsv(await readFile(csvPath, 'utf8')); const head = rows.shift();
    const cat = head.indexOf('category');
    const hotel = rows.find(r => r[1].includes('Hotel')), quoted = rows.find(r => r[1].includes('Quoted'));
    assert.ok(hotel && quoted, 'hostile titles are listed');
    hotel[cat] = 'text-image'; quoted[cat] = 'not-a-category';
    const stale = rows.find(r => r !== hotel && r !== quoted); stale[1] = 'A different title'; stale[cat] = 'water-ripple';
    const edited = path.join(rev, 'edited.csv');
    await writeFile(edited, [head, ...rows].map(tool.csvLine).join('\r\n') + '\r\n');
    const before = await snapshot(rev);
    const h = harness(); assert.equal(await tool.run(args(root, '--out-dir', rev, '--import-review', edited), h.deps), 0, h.text());
    assert.deepEqual(added(before, await snapshot(rev)), ['categories.overrides.json']);
    const overrides = JSON.parse(await readFile(path.join(rev, 'categories.overrides.json'), 'utf8'));
    assert.equal(overrides.format, 'aaavs-category-overrides'); assert.equal(Object.keys(overrides.entries).length, 1, 'stale and unknown rows are ignored');
    const [hash, entry] = Object.entries(overrides.entries)[0];
    assert.equal(fixture.files.get(hash).startsWith('Hotel'), true); assert.equal(entry.c, 'text-image');
    assert.match(h.out.join(''), /1 applied, 1 stale rows ignored, 1 unknown categories ignored/);
    // folded into categories.json on the next run
    assert.equal(await tool.run(args(root, '--out-dir', rev), harness().deps), 0);
    const folded = (await readCategories(rev)).entries[hash];
    assert.deepEqual([folded.c, folded.s, folded.k], ['text-image', 'o', 1]);
    await assert.rejects(tool.run(args(root, '--out-dir', rev, '--import-review', path.join(rev, 'missing.csv')), harness().deps), 'a missing CSV is an error, not a partial write');
    // a CSV without the needed columns is refused
    await writeFile(path.join(rev, 'bad.csv'), 'a,b\r\n1,2\r\n');
    assert.equal(await tool.run(args(root, '--out-dir', rev, '--import-review', path.join(rev, 'bad.csv')), harness().deps), 2);
  }

  // ---- 10. gold sample --------------------------------------------------------------------------------------------------------
  {
    const results = Array.from({ length: 900 }, (_, i) => ({ row: i, title: `t${i}`, composition: engine.normalizeComposition({ components: 5, effects: { b1: 1 } }),
      det: { primary: engine.TAXONOMY[i % 18].id, k: ((i * 37) % 100) / 100, tags: [], facets: {} } }));
    const sample = tool.goldSample(engine, results);
    assert.ok(sample.length <= 150 && sample.length >= 120, `size ${sample.length}`);
    assert.equal(new Set(sample.map(r => r.row)).size, sample.length);
    const perCategory = {}; for (const r of sample) perCategory[r.det.primary] = (perCategory[r.det.primary] ?? 0) + 1;
    assert.equal(Object.keys(perCategory).length, 18, 'every category is represented');
    assert.ok(Math.min(...Object.values(perCategory)) >= 8, 'about 8 per category');
    const lowK = sample.filter(r => r.det.k < 0.3).length; assert.ok(lowK / sample.length > 0.3, 'weighted to low confidence');
    assert.deepEqual(tool.goldSample(engine, results).map(r => r.row), sample.map(r => r.row), 'deterministic');
    const goldPath = path.join(base, 'gold.csv');
    assert.equal(await tool.run(args(root, '--out-dir', path.join(base, 'gold'), '--gold-sample', goldPath), harness().deps), 0);
    const rows = tool.parseCsv(await readFile(goldPath, 'utf8')); assert.deepEqual(rows.shift(), ['row', 'title', 'effects', 'category']);
    assert.equal(rows.length, RECIPES.length); assert.ok(rows.every(r => r[3] === '' && !/[0-9a-f]{64}/.test(r.join(''))));
  }

  // ---- 11. key command: argv split, no shell ---------------------------------------------------------------------------------------
  {
    const seen = [];
    const h = harness({ env: { TYPESAFE_API_KEY_COMMAND: `pass show "my folder/aaavs key" --flag` }, handler: goodHandler(), runKeyCommand: argv => { seen.push(argv); return `${SENTINEL}\n`; } });
    assert.equal(await tool.run(args(root, '--out-dir', path.join(base, 'cmd'), '--jev', '--send', '--all', '--limit', '1'), h.deps), 0);
    assert.deepEqual(seen, [['pass', 'show', 'my folder/aaavs key', '--flag']]);
    assert.equal(h.calls[0].init.headers.authorization, `Bearer ${SENTINEL}`);
    assert.ok(!h.text().includes(SENTINEL));
    const failing = harness({ env: { TYPESAFE_API_KEY_COMMAND: 'nope' }, handler: goodHandler(), runKeyCommand: () => '' });
    assert.equal(await tool.run(args(root, '--out-dir', path.join(base, 'cmd2'), '--jev', '--send'), failing.deps), 3);
    assert.equal(failing.calls.length, 0);
    assert.equal(tool.resolveKey({ env: { TYPESAFE_API_KEY: '  ' }, runKeyCommand: () => '' }), null);
    assert.equal(tool.resolveKey({ env: { TYPESAFE_API_KEY: ` ${SENTINEL} ` }, runKeyCommand: () => 'other' }), SENTINEL, 'the direct variable wins over the command');
  }

  // ---- 12. the source never reads a key from anywhere else -------------------------------------------------------------------------
  {
    const source = await readFile(new URL('./classify-presets.mjs', import.meta.url), 'utf8');
    assert.ok(!/process\.argv[^;]*(key|token)/i.test(source));
    assert.equal((source.match(/process\.env/g) ?? []).length, 1, 'process.env is read once, by defaultDeps');
    assert.ok(!/(writeFile|writeAtomic|appendFile|rename|rm)\([^;\r\n]*(presets\.json|parser-validation)/.test(source), 'the catalog files are only read');
    assert.equal(state.fetchCalls > 0, true, 'the fake fetch was exercised');
    // fetch is only ever the injected one in this check: the real global fetch is never referenced by the test file
    const self = await readFile(new URL('./check-classify-presets.mjs', import.meta.url), 'utf8');
    assert.ok(!/globalThis\.fetch|await fetch\(|https?:\/\/api\./.test(self.replace(/[^\n]*JEV_URL[^\n]*/g, '')), 'no real network call in this check');
  }
  console.log('Classify presets PASS: offline default, out-dir, dry run, key gate, payload allowlist, cache, failure fallbacks, acceptance policy, overrides, review import, gold sample.');
} finally {
  await rm(base, { recursive: true, force: true });
}
