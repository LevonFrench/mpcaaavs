// CPU checks for host wiring of the private show asset packs (docs/design/ASSET-PACK-MANIFEST.md, "Host wiring"):
//  - the device-local setting (src/show/pack-setting.ts): parse, defaults, URL override, blocked storage;
//  - the host provider (src/show/pack-host.ts) with fake sources: loaded / absent / invalid / off, the exact bytes it posts, attach timing;
//  - the `show-pack` protocol message validation (src/show/protocol.ts) and the worker registry (src/show/pack-registry.ts);
//  - the Player transport: the library server's read-only show-pack operations (tools/show-pack-server.mjs) over real HTTP, through
//    `httpPackSource` and the real loader: unconfigured refusal, traversal, symlinks, file kinds, size caps, listings, request hygiene;
//  - the server's path rules against the shared TypeScript allowlist, and the hook lines in the hosts and the worker.
// Every pack is a tiny synthetic fixture (tools/fixtures-asset-pack.mjs). Nothing reads or writes show-assets-private/, and no browser, GPU
// or audio runs: this proves the plumbing, not a pixel.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { request as httpRequest, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as F from './fixtures-asset-pack.mjs';
import { createLibraryHandler } from './standalone-library.mjs';
import { createShowPackReader, packPathProblem as serverPathProblem, isPackId as serverIsPackId, servableLimit, SHOW_PACK_LIMITS } from './show-pack-server.mjs';

const visualizer = fileURLToPath(new URL('..', import.meta.url));
const bundle = await build({
  stdin: {
    contents: `export * from './src/show/pack-setting.ts';
      export * from './src/show/pack-host.ts';
      export * from './src/show/pack-registry.ts';
      export { validateShowRequest } from './src/show/protocol.ts';
      export { memoryPackSource, packPathProblem, isPackId, ASSET_PACK_LIMITS, ASSET_PACK_TOTAL_BYTES, AssetPackMissingError } from './src/asset-packs/index.ts';
      export { ASSET_PACK_TOTAL_BYTES as TOTAL } from './src/asset-packs/loader.ts';`,
    resolveDir: visualizer, loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
});
const H = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); checks++; };
const rejects = async (p, re, m) => { await assert.rejects(p, re, m); checks++; };
const fakeDecode = async (_bytes, atlas) => ({ width: atlas.width, height: atlas.height });
const goodFiles = () => F.fixtureFiles();
const goodSource = (id = 'fixture-pack') => H.memoryPackSource(id, goodFiles());
const silent = [];
const log = (level, text) => silent.push([level, text]);
const tick = () => new Promise(resolve => setImmediate(resolve));

// ------------------------------------------------------------------------------------------------------------------------ setting
{
  eq(H.SHOW_PACK_KEY, 'mpcaaavs.showPack', 'setting key');
  eq(H.readShowPackSetting({}), { id: null, source: 'default' }, 'default is no pack');
  eq(H.readShowPackSetting({ search: '', stored: () => null }), { id: null, source: 'default' }, 'empty environment');
  eq(H.readShowPackSetting({ stored: () => 'fixture-pack' }), { id: 'fixture-pack', source: 'storage' }, 'stored id');
  eq(H.readShowPackSetting({ search: '?pack=other-pack', stored: () => 'fixture-pack' }), { id: 'other-pack', source: 'url' }, 'URL beats storage');
  eq(H.readShowPackSetting({ search: '?x=1&pack=a1', stored: () => null }), { id: 'a1', source: 'url' }, 'URL among other parameters');
  eq(H.readShowPackSetting({ search: '?pack=off', stored: () => 'fixture-pack' }), { id: null, source: 'url' }, '?pack=off selects none even with a stored id');
  eq(H.readShowPackSetting({ search: '?pack=', stored: () => 'fixture-pack' }), { id: null, source: 'url' }, '?pack= selects none');
  eq(H.readShowPackSetting({ search: '?pack=none', stored: () => 'fixture-pack' }), { id: null, source: 'url' }, '?pack=none selects none');
  eq(H.readShowPackSetting({ search: '?pack=../../etc', stored: () => 'fixture-pack' }), { id: null, source: 'url' }, 'an invalid URL id fails closed, it does not fall back');
  eq(H.readShowPackSetting({ stored: () => { throw new Error('blocked'); } }), { id: null, source: 'default' }, 'blocked storage is the default');
  eq(H.readShowPackSetting({ stored: () => 'C:\\packs\\x' }), { id: null, source: 'default' }, 'an invalid stored id is ignored');
  for (const bad of [undefined, null, 5, {}, [], '', ' ', 'A', 'Up', '-x', 'x_y', '.', '..', '../x', 'a/b', 'a\\b', 'C:x', 'http://x', 'a%20b', 'x'.repeat(49), 'con', 'nul', 'off', 'none', 'ünï', 'a b', 'a\u0000b', '\u202eabc'])
    eq(H.parseShowPackSetting(bad), null, `parse rejects ${JSON.stringify(bad)}`);
  for (const good of ['a', '0', 'fixture-pack', 'x'.repeat(48), ' padded-ok '])
    eq(H.parseShowPackSetting(good), good.trim(), `parse accepts ${JSON.stringify(good)}`);
  const store = new Map(), storage = { setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
  ok(H.writeShowPackSetting('fixture-pack', storage) && store.get('mpcaaavs.showPack') === 'fixture-pack', 'write stores the id');
  ok(H.writeShowPackSetting(null, storage) && !store.has('mpcaaavs.showPack'), 'write null clears');
  ok(!H.writeShowPackSetting('../x', storage) && !store.has('mpcaaavs.showPack'), 'write refuses an invalid id');
  ok(!H.writeShowPackSetting('ok', { setItem() { throw new Error('quota'); }, removeItem() {} }), 'write reports blocked storage');
  ok(!H.writeShowPackSetting('ok', null), 'write reports missing storage');
}

// ---------------------------------------------------------------------------------------------------------------------- provider
{
  const off = new H.ShowPackProvider({ id: null, source: () => { throw new Error('no source is opened for no pack'); }, log });
  eq(await off.ready, { state: 'off' }, 'no pack: off');
  ok(off.message() === null, 'no pack: no message');
  const posted = [];
  off.attach({ postMessage: (m) => posted.push(m) }); await tick();
  eq(posted, [], 'no pack: attach posts nothing');
  const badId = new H.ShowPackProvider({ id: '../x', source: () => { throw new Error('never'); }, log });
  eq(await badId.ready, { state: 'off' }, 'an invalid id is treated as none');

  silent.length = 0;
  const reads = [];
  const recording = id => { const inner = goodSource(id); return { packId: inner.packId, read: async (p, l) => { reads.push(p); return inner.read(p, l); } }; };
  const provider = new H.ShowPackProvider({ id: 'fixture-pack', source: recording, decode: fakeDecode, log });
  eq(provider.state, { state: 'loading', id: 'fixture-pack' }, 'loading state before the first tick');
  ok(provider.message() === null, 'no message while loading');
  const late = []; provider.attach({ postMessage: (m, t) => late.push([m, t]) });
  eq(await provider.ready, { state: 'loaded', id: 'fixture-pack', name: 'Fixture Pack (synthetic)' }, 'loaded state');
  await tick();
  eq(reads.sort(), ['atlas/sprites.png', 'atlas/ui.png', 'pack.json'], 'the provider reads the manifest and the atlases, nothing else');
  eq(silent, [['info', 'fixture-pack loaded']], 'one log line on load');
  eq(late.length, 1, 'an attach before readiness posts once it is loaded');
  const [message, transfer] = late[0];
  const files = goodFiles();
  eq([message.type, message.generation, message.packId], ['show-pack', 0, 'fixture-pack'], 'message identity');
  eq(Buffer.from(message.manifest).toString(), files['pack.json'], 'manifest bytes are pack.json exactly');
  eq(Object.keys(message.atlases).sort(), ['sprites', 'ui'], 'atlases by atlas id');
  eq(Buffer.from(message.atlases.sprites), Buffer.from(files['atlas/sprites.png']), 'atlas bytes are the PNG exactly');
  eq(transfer.length, 3, 'all three buffers are transferred');
  ok(transfer.includes(message.manifest) && transfer.includes(message.atlases.ui), 'the transfer list names the message buffers');
  ok(message.atlases.sprites instanceof ArrayBuffer && message.manifest instanceof ArrayBuffer, 'plain ArrayBuffers, not views');
  const again = provider.message();
  ok(again.manifest !== message.manifest && again.atlases.sprites !== message.atlases.sprites, 'each message carries fresh copies');
  ok(H.validateShowRequest(again).type === 'show-pack', 'the provider message passes protocol validation');
  const now = []; provider.attach({ postMessage: m => now.push(m) }); await tick();
  eq(now.length, 1, 'an attach after readiness posts too');
  provider.attach({ postMessage() { throw new Error('terminated'); } }); await tick(); ok(true, 'a dead worker is ignored'); checks++;

  // absent, invalid, throwing sources
  silent.length = 0;
  const absent = new H.ShowPackProvider({ id: 'fixture-pack', source: id => H.memoryPackSource(id, {}), decode: fakeDecode, log });
  const absentState = await absent.ready;
  ok(absentState.state === 'absent' && /not installed/.test(absentState.issues[0].message), 'absent pack');
  ok(absent.message() === null && silent[0][0] === 'warn' && /absent/.test(silent[0][1]), 'absent: no message, a warning');
  const badManifest = { ...goodFiles(), 'pack.json': '{"format": "nope"}' };
  const invalid = new H.ShowPackProvider({ id: 'fixture-pack', source: id => H.memoryPackSource(id, badManifest), decode: fakeDecode, log });
  ok((await invalid.ready).state === 'invalid' && invalid.message() === null, 'invalid manifest: no message');
  const wrongSize = { ...goodFiles(), 'atlas/ui.png': F.paintAtlas(32, 32, []) };
  const mis = new H.ShowPackProvider({ id: 'fixture-pack', source: id => H.memoryPackSource(id, wrongSize), decode: fakeDecode, log });
  ok((await mis.ready).state === 'invalid' && mis.message() === null, 'mis-sized atlas: invalid, no message');
  const undecodable = new H.ShowPackProvider({ id: 'fixture-pack', source: goodSource, decode: async () => { throw new Error('bad'); }, log });
  ok((await undecodable.ready).state === 'invalid' && undecodable.message() === null, 'undecodable atlas: invalid, no message');
  const throwing = new H.ShowPackProvider({ id: 'fixture-pack', source: () => { throw new Error('transport down'); }, log });
  const thrown = await throwing.ready;
  ok(thrown.state === 'absent' && /transport down/.test(thrown.issues[0].message) && throwing.message() === null, 'a throwing source is absent, never an unhandled rejection');
  const hostile = new H.ShowPackProvider({ id: 'fixture-pack', source: () => ({ packId: 'fixture-pack', read: async () => { throw new Error('disk on fire'); } }), log });
  ok((await hostile.ready).state === 'absent', 'an unreadable source is absent');
  const other = new H.ShowPackProvider({ id: 'other-pack', source: goodSource, decode: fakeDecode, log });
  ok((await other.ready).state === 'invalid', 'a manifest whose id differs from its directory is invalid');

  // host factory and worker detection
  const hostOff = H.createHostShowPacks({ source: () => { throw new Error('never'); }, setting: { id: null, source: 'default' }, log });
  eq(await hostOff.ready, { state: 'off' }, 'createHostShowPacks without a setting is off');
  const hostOn = H.createHostShowPacks({ source: goodSource, setting: { id: 'fixture-pack', source: 'url' }, decode: fakeDecode, log });
  eq((await hostOn.ready).state, 'loaded', 'createHostShowPacks loads the pack the setting names');
  eq((await H.createHostShowPacks({ source: goodSource, decode: fakeDecode, log }).ready).state, 'off', 'the default environment selects no pack');
  ok(H.isShowWorkerLocation(new URL('https://aaavs.invalid/show-render.worker.js?assets=x')) && H.isShowWorkerLocation('http://127.0.0.1:1/show-render.worker.js'), 'the show worker is recognised');
  ok(!H.isShowWorkerLocation(new URL('https://aaavs.invalid/nerv-render.worker.js')) && !H.isShowWorkerLocation('https://aaavs.invalid/avs-render.worker.js') && !H.isShowWorkerLocation('not a url at all'), 'other workers never get a pack');
}

// ------------------------------------------------------------------------------------------------------------ protocol and registry
{
  const files = goodFiles();
  const buf = (x) => Uint8Array.from(typeof x === 'string' ? Buffer.from(x) : x).buffer;
  const good = () => ({ type: 'show-pack', generation: 3, packId: 'fixture-pack', manifest: buf(files['pack.json']), atlases: { sprites: buf(files['atlas/sprites.png']), ui: buf(files['atlas/ui.png']) } });
  ok(H.validateShowRequest(good()).type === 'show-pack', 'a good pack message validates');
  ok(H.validateShowRequest({ type: 'show-pack', generation: 0, packId: null }).packId === null, 'a clear message validates');
  const bad = (mutate, note) => { const m = good(); mutate(m); assert.throws(() => H.validateShowRequest(m), /Invalid show/, note); checks++; };
  bad(m => { m.generation = -1; }, 'negative generation');
  bad(m => { m.generation = 1.5; }, 'fractional generation');
  bad(m => { delete m.generation; }, 'missing generation');
  bad(m => { m.packId = '../x'; }, 'traversal id');
  bad(m => { m.packId = 5; }, 'numeric id');
  bad(m => { m.packId = undefined; }, 'missing id');
  bad(m => { m.manifest = 'pack.json'; }, 'string manifest');
  bad(m => { m.manifest = new Uint8Array(4); }, 'a view is not a transferable buffer');
  bad(m => { m.manifest = new ArrayBuffer(0); }, 'empty manifest');
  bad(m => { m.manifest = new ArrayBuffer(H.ASSET_PACK_LIMITS.manifestBytes + 1); }, 'oversize manifest');
  bad(m => { delete m.manifest; }, 'missing manifest');
  bad(m => { delete m.atlases; }, 'missing atlases');
  bad(m => { m.atlases = []; }, 'atlases as array');
  bad(m => { m.atlases = null; }, 'atlases null');
  bad(m => { m.atlases = Object.create({ inherited: new ArrayBuffer(1) }); }, 'atlases with a foreign prototype');
  bad(m => { m.atlases['Bad Id'] = new ArrayBuffer(1); }, 'bad atlas id');
  bad(m => { m.atlases['../x'] = new ArrayBuffer(1); }, 'traversal atlas id');
  bad(m => { m.atlases.sprites = 'bytes'; }, 'string atlas');
  bad(m => { m.atlases.sprites = new ArrayBuffer(0); }, 'empty atlas');
  bad(m => { m.atlases.sprites = new ArrayBuffer(H.ASSET_PACK_LIMITS.atlasBytes + 1); }, 'oversize atlas');
  bad(m => { for (let i = 0; i < 17; i++) m.atlases[`a${i}`] = new ArrayBuffer(1); }, 'too many atlases');
  bad(m => { m.atlases = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`big${i}`, new ArrayBuffer(H.ASSET_PACK_LIMITS.atlasBytes)])); }, 'atlases over the pack budget');
  bad(m => { m.packId = null; }, 'a clear message must not carry data');
  assert.throws(() => H.validateShowRequest({ type: 'show-pack', generation: 0, packId: null, atlases: {} }), /Invalid show pack/); checks++;
  assert.throws(() => H.validateShowRequest({ type: 'show-packs', generation: 0 }), /Invalid show message type/); checks++;

  // registry: what the worker does with a validated message
  H.clearShowPack();
  ok(H.getShowPack() === null && H.showPackRevision() === -1, 'the registry starts empty');
  const loaded = await H.receiveShowPack(good(), { decode: fakeDecode });
  eq([loaded.status, loaded.id], ['loaded', 'fixture-pack'], 'a good message loads');
  const pack = H.getShowPack();
  ok(pack && pack.id === 'fixture-pack' && pack.region('hero') && pack.hasImage('sprites') && pack.hasImage('ui'), 'the registry holds the decoded pack');
  eq(H.showPackRevision(), 3, 'the revision is the message generation');
  const invalid = good(); invalid.manifest = buf('{"format":"x"}');
  const invalidResult = await H.receiveShowPack(invalid, { decode: fakeDecode });
  ok(invalidResult.status === 'invalid' && H.getShowPack() === null, 'an invalid pack empties the registry (no half pack survives)');
  await H.receiveShowPack(good(), { decode: fakeDecode });
  const noAtlas = good(); delete noAtlas.atlases.ui;
  ok((await H.receiveShowPack(noAtlas, { decode: fakeDecode })).status === 'invalid' && H.getShowPack() === null, 'a missing atlas is invalid');
  const liar = good(); liar.atlases.ui = buf(F.paintAtlas(32, 32, []));
  ok((await H.receiveShowPack(liar, { decode: fakeDecode })).status === 'invalid' && H.getShowPack() === null, 'an atlas that contradicts the manifest is invalid');
  const notPng = good(); notPng.atlases.ui = buf('GIF89a'.repeat(10));
  ok((await H.receiveShowPack(notPng, { decode: fakeDecode })).status === 'invalid', 'an atlas that is not a PNG is invalid');
  const wrongId = good(); wrongId.packId = 'other-pack';
  ok((await H.receiveShowPack(wrongId, { decode: fakeDecode })).status === 'invalid', 'the manifest id must match the message pack id');
  const traversal = JSON.parse(files['pack.json']); traversal.atlases.ui.file = '../../ui.png';
  const hostile = good(); hostile.manifest = buf(JSON.stringify(traversal));
  ok((await H.receiveShowPack(hostile, { decode: fakeDecode })).status === 'invalid' && H.getShowPack() === null, 'a hostile atlas path in the manifest is invalid');
  await H.receiveShowPack(good(), { decode: fakeDecode });
  eq((await H.receiveShowPack({ type: 'show-pack', generation: 4, packId: null }, { decode: fakeDecode })).status, 'cleared', 'a clear message clears');
  ok(H.getShowPack() === null, 'cleared registry is empty');
  // the last message wins even when an earlier decode finishes later
  let release; const gate = new Promise(resolve => { release = resolve; });
  const slow = H.receiveShowPack(good(), { decode: async (b, a) => { await gate; return fakeDecode(b, a); } });
  await tick();
  await H.receiveShowPack({ type: 'show-pack', generation: 5, packId: null });
  release(); await slow;
  ok(H.getShowPack() === null, 'an older, slower load never overwrites a newer message');
  H.clearShowPack();
}

// -------------------------------------------------------------------------------------------------------- path rules: server mirror
{
  const corpus = ['pack.json', 'atlas/sprites.png', 'a.png', 'atlas/a/b/c/d/e.png', 'a/b/c/d/e/f/g.png', '', '.', '..', '../pack.json', 'a/../pack.json', './pack.json', '/pack.json', '/etc/passwd', 'C:/x.png', 'C:x.png', 'a\\b.png', 'a%2e%2e/b.png',
    'a//b.png', 'a/', '/a', '.hidden.png', 'a/.hidden', 'trail.', 'trail .png', 'a b.png', 'con.png', 'CON', 'nul.json', 'com1.png', 'lpt9', 'aux.x.png', 'a~1.png', 'a.png:stream', 'x'.repeat(65) + '.png', 'x'.repeat(129), 'é.png', '\u0000.png', 'a\u202e.png', 'a\u2028b', 'a\tb.png',
    'atlas/UPPER.PNG', 'atlas/x.PnG', 'x.png.', 'a'.repeat(64), 'under_score/ok-dash.v2.png', 'http://x/y.png', 'a?b.png', 'a#b.png', 'a*b', 'con.', 'pack.json.png', 'PACK.JSON', 'pack.json/', ' pack.json', 'pack.json ', 5, null, undefined, {}];
  for (const p of corpus) {
    eq(serverPathProblem(p) === null, H.packPathProblem(p) === null, `server path rule agrees with asset-packs/paths.ts on ${JSON.stringify(p)}`);
    eq(serverPathProblem(p, ['.png']) === null, H.packPathProblem(p, ['.png']) === null, `server .png rule agrees on ${JSON.stringify(p)}`);
  }
  for (const id of ['a', 'fixture-pack', 'x'.repeat(48), 'x'.repeat(49), '', 'A', '-a', 'a_b', 'con', 'nul', 'com1', '../a', 'a/b', 'a.b', 5, null])
    eq(serverIsPackId(id), H.isPackId(id), `server pack id rule agrees on ${JSON.stringify(id)}`);
  eq(SHOW_PACK_LIMITS.manifestBytes, H.ASSET_PACK_LIMITS.manifestBytes, 'server manifest cap equals the manifest limit');
  eq(SHOW_PACK_LIMITS.atlasBytes, H.ASSET_PACK_LIMITS.atlasBytes, 'server atlas cap equals the manifest limit');
  eq([servableLimit('pack.json'), servableLimit('atlas/x.png'), servableLimit('atlas/x.PNG'), servableLimit('notes.txt'), servableLimit('../pack.json'), servableLimit('atlas/x.png.json'), servableLimit('pack.json.png')], [524288, 8388608, 8388608, 0, 0, 0, 8388608], 'only pack.json and PNGs are servable');
}

// ------------------------------------------------------------------------------------------------ the library server, over HTTP
const scratch = mkdtempSync(path.join(tmpdir(), 'show-pack-host-'));
const servers = [];
try {
  const packs = path.join(scratch, 'packs'), app = path.join(scratch, 'app'); // the app directory has no `avs presets` collection: pack ops never need one
  mkdirSync(path.join(packs, 'fixture-pack', 'atlas'), { recursive: true }); mkdirSync(app, { recursive: true });
  const files = goodFiles();
  for (const [name, value] of Object.entries(files)) writeFileSync(path.join(packs, 'fixture-pack', name), value);
  writeFileSync(path.join(packs, 'fixture-pack', 'notes.txt'), 'not a servable kind');
  writeFileSync(path.join(packs, 'fixture-pack', 'atlas', 'readme.md'), 'nor this');
  writeFileSync(path.join(scratch, 'secret.txt'), 'outside the packs directory');
  writeFileSync(path.join(scratch, 'secret.png'), 'outside png');
  // a second, broken pack and some decoys
  mkdirSync(path.join(packs, 'empty-pack')); mkdirSync(path.join(packs, 'Not-A-Pack')); writeFileSync(path.join(packs, 'Not-A-Pack', 'pack.json'), '{}'); writeFileSync(path.join(packs, 'loose.json'), '{}');
  mkdirSync(path.join(packs, 'big-pack', 'atlas'), { recursive: true });
  writeFileSync(path.join(packs, 'big-pack', 'pack.json'), ''); truncateSync(path.join(packs, 'big-pack', 'pack.json'), 512 * 1024 + 1);
  writeFileSync(path.join(packs, 'big-pack', 'atlas', 'exact.png'), ''); truncateSync(path.join(packs, 'big-pack', 'atlas', 'exact.png'), 8 * 1024 * 1024);
  writeFileSync(path.join(packs, 'big-pack', 'atlas', 'over.png'), ''); truncateSync(path.join(packs, 'big-pack', 'atlas', 'over.png'), 8 * 1024 * 1024 + 1);
  let links = true;
  try {
    symlinkSync(path.join(scratch, 'secret.png'), path.join(packs, 'fixture-pack', 'atlas', 'link.png'));
    symlinkSync(path.join(packs, 'fixture-pack', 'atlas', 'sprites.png'), path.join(packs, 'fixture-pack', 'inner-link.png'));
    symlinkSync(scratch, path.join(packs, 'fixture-pack', 'linkdir'));
    symlinkSync(path.join(packs, 'fixture-pack'), path.join(packs, 'linked-pack'));
    symlinkSync(path.join(scratch, 'secret.txt'), path.join(packs, 'fixture-pack', 'pack-link.json'));
  } catch { links = false; }

  const start = async (options) => {
    const handler = createLibraryHandler(app, options);
    const server = createServer(async (req, res) => { if (await handler(req, res)) return; res.writeHead(418); res.end('static fallback'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const port = server.address().port;
    const call = (value, { headers = {}, method = 'POST', url = '/api/aaavs/library' } = {}) => new Promise((resolve, reject) => {
      const payload = typeof value === 'string' ? value : JSON.stringify(value);
      const req = httpRequest({ hostname: '127.0.0.1', port, path: url, method, headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers } }, res => {
        const chunks = []; res.on('data', c => chunks.push(c));
        res.on('end', () => { const raw = Buffer.concat(chunks); let json = null; if (/json/.test(res.headers['content-type'] ?? '')) { try { json = JSON.parse(raw.toString()); } catch { /* */ } } resolve({ status: res.statusCode, headers: res.headers, raw, json }); });
      });
      req.on('error', reject); req.end(payload);
    });
    return { call, port, fetchImpl: (url, init) => fetch(`http://127.0.0.1:${port}${url}`, { ...init, headers: { ...init.headers, Origin: `http://127.0.0.1:${port}` } }) };
  };

  // unconfigured: every operation is refused, and nothing on disk is reachable
  {
    const { call, fetchImpl: unconfiguredFetch } = await start({});
    for (const request of [{ op: 'list-show-packs' }, { op: 'list-show-pack-files', pack: 'fixture-pack' }, { op: 'read-show-pack-file', pack: 'fixture-pack', path: 'pack.json' }]) {
      const r = await call(request);
      ok(r.status === 400 && r.json.type === 'library-error' && /not configured/.test(r.json.message) && r.raw.length < 300, `unconfigured server refuses ${request.op}`);
    }
    const none = await start({ showPacks: '' }); ok((await none.call({ op: 'list-show-packs' })).status === 400, 'an empty directory setting is unconfigured');
    const missingDir = await start({ showPacks: path.join(scratch, 'does-not-exist') });
    ok((await missingDir.call({ op: 'list-show-packs' })).status === 404, 'a configured directory that does not exist is "missing", not an error page');
    const viaHttp = new H.ShowPackProvider({ id: 'fixture-pack', source: id => H.httpPackSource(id, '/api/aaavs/library', unconfiguredFetch), log });
    const state = await viaHttp.ready;
    ok(state.state === 'absent' && /not configured/.test(state.issues[0].message), 'a Player without a configured directory ends as absent with the reason');
  }

  const { call, fetchImpl } = await start({ showPacks: packs });
  const read = (pack, p) => call({ op: 'read-show-pack-file', pack, path: p });

  // listing
  eq((await call({ op: 'list-show-packs' })).json, { type: 'show-packs', packs: [{ id: 'big-pack' }, { id: 'fixture-pack' }] }, 'list: only real pack directories holding a regular pack.json (no links, no bad ids, no loose files)');
  eq((await H.listShowPacks('/api/aaavs/library', fetchImpl)).map(p => p.id), ['big-pack', 'fixture-pack'], 'listShowPacks client');
  const listed = (await call({ op: 'list-show-pack-files', pack: 'fixture-pack' })).json;
  eq(listed.files.map(f => f.path), ['atlas/sprites.png', 'atlas/ui.png', 'pack.json'], 'list-files: pack.json and PNGs only, sorted, no links');
  eq(listed.files.find(f => f.path === 'pack.json').bytes, Buffer.byteLength(files['pack.json']), 'list-files reports sizes');
  ok((await call({ op: 'list-show-pack-files', pack: 'nope-pack' })).status === 404, 'list-files of a missing pack');
  ok((await call({ op: 'list-show-pack-files', pack: '../fixture-pack' })).status === 400, 'list-files refuses a traversal id');

  // reads: exact bytes, binary, headers
  const manifest = await read('fixture-pack', 'pack.json');
  ok(manifest.status === 200 && /^application\/octet-stream/.test(manifest.headers['content-type']) && manifest.headers['x-content-type-options'] === 'nosniff' && manifest.headers['cache-control'] === 'no-store', 'read: binary response with hardening headers');
  eq(manifest.raw.toString(), files['pack.json'], 'read: manifest bytes');
  eq(Buffer.compare((await read('fixture-pack', 'atlas/sprites.png')).raw, Buffer.from(files['atlas/sprites.png'])), 0, 'read: atlas bytes are exact');
  ok(Number(manifest.headers['content-length']) === manifest.raw.length, 'read: content-length');

  // refusals: traversal, kinds, links, sizes, hygiene
  const refusals = [['fixture-pack', '../secret.png'], ['fixture-pack', '../../secret.png'], ['fixture-pack', 'atlas/../../secret.png'], ['fixture-pack', '/etc/passwd'], ['fixture-pack', 'C:/secret.png'], ['fixture-pack', 'atlas\\..\\..\\secret.png'],
    ['fixture-pack', '%2e%2e/secret.png'], ['fixture-pack', 'atlas/%2e%2e/%2e%2e/secret.png'], ['fixture-pack', 'atlas//sprites.png'], ['fixture-pack', './pack.json'], ['fixture-pack', 'PACK.JSON.'], ['fixture-pack', 'pack.json '], ['fixture-pack', ''], ['fixture-pack', 'notes.txt'],
    ['fixture-pack', 'atlas/readme.md'], ['fixture-pack', 'atlas'], ['fixture-pack', 'atlas/'], ['fixture-pack', 'nul.png'], ['fixture-pack', 'atlas/sprites.png\u0000.txt'], ['fixture-pack', 'atlas/sprites.png:stream'],
    ['../fixture-pack', 'pack.json'], ['fixture-pack/atlas', 'sprites.png'], ['Fixture-Pack', 'pack.json'], ['', 'pack.json'], ['a'.repeat(49), 'pack.json'], [5, 'pack.json'], ['fixture-pack', 5], [null, null], ['Not-A-Pack', 'pack.json'], ['..', 'pack.json'], ['.', 'pack.json']];
  for (const [pack, p] of refusals) { const r = await read(pack, p); ok(r.status >= 400 && r.json?.type === 'library-error' && !r.raw.toString().includes('outside'), `refused: ${JSON.stringify([pack, p])}`); }
  ok((await read('fixture-pack', 'nope.png')).status === 404 && (await read('fixture-pack', 'nope.png')).json.missing === true, 'a missing file is 404 with missing: true');
  ok((await read('fixture-pack', 'nodir/x.png')).json.missing === true && (await read('nope-pack', 'pack.json')).json.missing === true, 'a missing directory or pack is missing');
  ok((await read('empty-pack', 'pack.json')).status === 404, 'a pack without a manifest is missing');
  if (links) {
    for (const [pack, p] of [['fixture-pack', 'atlas/link.png'], ['fixture-pack', 'inner-link.png'], ['fixture-pack', 'linkdir/secret.png'], ['fixture-pack', 'linkdir/secret.txt'], ['fixture-pack', 'pack-link.json'], ['linked-pack', 'pack.json'], ['linked-pack', 'atlas/sprites.png']]) {
      const r = await read(pack, p); ok(r.status >= 400 && r.json?.type === 'library-error' && !r.raw.toString().includes('outside'), `symlink refused: ${JSON.stringify([pack, p])}`);
    }
    ok(!(await call({ op: 'list-show-packs' })).json.packs.some(p => p.id === 'linked-pack'), 'a symlinked pack directory is not listed');
    ok(!(await call({ op: 'list-show-pack-files', pack: 'fixture-pack' })).json.files.some(f => /link/.test(f.path)), 'symlinks are not listed');
    ok((await call({ op: 'list-show-pack-files', pack: 'linked-pack' })).status === 400, 'a symlinked pack directory cannot be listed');
  } else console.log('note: symlinks could not be created here; the symlink cases were skipped');
  // size caps, on the server before reading
  ok((await read('big-pack', 'pack.json')).status === 400 && /size limit/.test((await read('big-pack', 'pack.json')).json.message), 'a manifest over 512 KiB is refused');
  ok((await read('big-pack', 'atlas/over.png')).status === 400 && /size limit/.test((await read('big-pack', 'atlas/over.png')).json.message), 'an atlas over 8 MiB is refused');
  const exact = await read('big-pack', 'atlas/exact.png'); ok(exact.status === 200 && exact.raw.length === 8 * 1024 * 1024, 'an atlas of exactly 8 MiB is served');
  // request hygiene
  ok((await call({ op: 'read-show-pack-file', pack: 'fixture-pack', path: 'pack.json', extra: 1 })).status === 400, 'unknown request keys are refused');
  ok((await call({ op: 'list-show-packs', pack: 'x' })).status === 400, 'list takes no arguments');
  ok((await call({ op: 'read-show-pack-file', pack: 'fixture-pack', path: 'pack.json' }, { headers: { Origin: 'http://evil.example' } })).status === 403, 'a foreign Origin is refused');
  ok((await call({ op: 'read-show-pack-file', pack: 'fixture-pack', path: 'pack.json' }, { headers: { Host: 'evil.example' } })).status === 403, 'a foreign Host is refused');
  ok((await call('', { method: 'GET' })).status === 405, 'GET is refused');
  ok((await call({ op: 'read-show-pack-file', pack: 'fixture-pack', path: 'pack.json' }, { headers: { 'Content-Type': 'text/plain' } })).status === 400, 'a non-JSON request is refused');
  ok((await call({ op: 'load-settings' })).status === 400, 'the ordinary library still requires its own collection (pack ops are independent)');
  ok((await call('/static-asset.png', { method: 'GET', url: '/show-assets-private/fixture-pack/pack.json' })).status === 418, 'the library handler leaves static routes to the caller');
  // the collection locks are never taken: a concurrent burst of pack reads while the collection is absent still works
  const burst = await Promise.all(Array.from({ length: 12 }, () => read('fixture-pack', 'pack.json')));
  ok(burst.every(r => r.status === 200), 'pack reads do not depend on the library write queue');

  // the client transport and the real loader over HTTP
  const source = H.httpPackSource('fixture-pack', '/api/aaavs/library', fetchImpl);
  eq(source.packId, 'fixture-pack', 'http source pack id');
  eq(Buffer.from(await source.read('pack.json', 1 << 20)).toString(), files['pack.json'], 'http source reads the manifest');
  await rejects(source.read('pack.json', 10), /budget/, 'http source honours the caller byte limit');
  await rejects(source.read('../secret.png', 99), /Invalid asset pack path/, 'http source never sends a bad path');
  await rejects(source.read('notes.txt', 99), /not served/, 'http source never asks for a file kind the server does not serve');
  await rejects(source.read('nope.png', 1 << 20), H.AssetPackMissingError, 'http source maps 404 to AssetPackMissingError');
  assert.throws(() => H.httpPackSource('../x'), /pack id/); checks++;
  let requested = 0;
  const counting = H.httpPackSource('fixture-pack', '/api/aaavs/library', async () => { requested++; throw new Error('never'); });
  await rejects(counting.read('a/../b.png', 9), /Invalid asset pack path/, 'no request for a dotted path'); eq(requested, 0, 'no request was made');
  const lying = H.httpPackSource('fixture-pack', '/x', async () => new Response(new Uint8Array(200), { status: 200, headers: { 'content-type': 'application/octet-stream' } }));
  await rejects(lying.read('pack.json', 100), /budget/, 'http source bounds a body that exceeds the limit');
  const html = H.httpPackSource('fixture-pack', '/x', async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  await rejects(html.read('pack.json', 100), /Library request failed/, 'http source refuses a 200 that is not octet-stream');
  const player = new H.ShowPackProvider({ id: 'fixture-pack', source: id => H.httpPackSource(id, '/api/aaavs/library', fetchImpl), decode: fakeDecode, log });
  eq((await player.ready).state, 'loaded', 'the Player path: provider + http source + library server loads the fixture pack');
  const sent = player.message();
  eq(Buffer.from(sent.manifest).toString(), files['pack.json'], 'the Player path posts the exact manifest bytes');
  eq(Buffer.compare(Buffer.from(sent.atlases.ui), Buffer.from(files['atlas/ui.png'])), 0, 'the Player path posts the exact atlas bytes');
  H.clearShowPack();
  eq((await H.receiveShowPack(H.validateShowRequest(sent), { decode: fakeDecode })).status, 'loaded', 'the worker accepts the Player path message');
  H.clearShowPack();
  const absentPlayer = new H.ShowPackProvider({ id: 'nope-pack', source: id => H.httpPackSource(id, '/api/aaavs/library', fetchImpl), decode: fakeDecode, log });
  eq((await absentPlayer.ready).state, 'absent', 'the Player path: an uninstalled pack is absent');
  const badPlayer = new H.ShowPackProvider({ id: 'big-pack', source: id => H.httpPackSource(id, '/api/aaavs/library', fetchImpl), decode: fakeDecode, log });
  ok(['absent', 'invalid'].includes((await badPlayer.ready).state) && badPlayer.message() === null, 'the Player path: an oversize manifest never loads');
} finally {
  for (const server of servers) await new Promise(resolve => server.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------- reader used directly (no HTTP)
{
  const r = createShowPackReader(undefined);
  ok(!r.configured, 'reader: unconfigured'); await rejects(r.list(), /not configured/, 'reader: list refused'); await rejects(r.read('fixture-pack', 'pack.json'), /not configured/, 'reader: read refused');
}

// -------------------------------------------------------------------------------------------------------------- hooks and build rules
{
  const read = f => readFileSync(path.join(visualizer, f), 'utf8');
  const host = read('src/mpc-host.ts'), player = read('src/standalone-player.ts'), worker = read('src/show-render.worker.ts');
  ok(/isShowWorkerLocation\(workerUrl\)\) showPacks\.attach\(worker\)/.test(host), 'mpc-host attaches the pack to show workers only');
  ok(/createHostShowPacks\(\{ source: id => fetchPackSource\(id\) \}\)/.test(host), 'the MPC host reads the pack beside the page');
  ok(/aaavsShowPacks=createHostShowPacks\(\{source:id=>httpPackSource\(id\)\}\)/.test(player), 'the Player reads the pack through its library server');
  ok(/m\.type === 'show-pack'[\s\S]{0,400}?receiveShowPack\(m\)/.test(worker) && worker.indexOf("m.type === 'show-pack'") < worker.indexOf("m.generation !== generation"), 'the show worker stores the pack before its generation gate');
  ok(/m\.type === 'show-pack'[\s\S]{0,300}?sendPack\(i\.worker, m\)/.test(worker) && /if \(lastPack\) sendPack\(w, lastPack\);\s*const preset = lastLoad\.preset/.test(worker), 'copies at another scale get the pack, before their preset load');
  ok(/sceneWorker:\(kind,size\)=>\{[^\n]*isShowWorkerLocation\(url\)\)showPacks\.attach\(worker\)/.test(host), 'Multiview lanes on the show engine get the pack');
  for (const f of ['tools/build-mpc.mjs', 'tools/build-standalone.mjs']) ok(!/show-assets-private|copy|cp\(/.test(read(f)), `${f} never copies or names private packs`);
  for (const f of ['src/show/pack-setting.ts', 'src/show/pack-host.ts', 'src/show/pack-registry.ts', 'tools/show-pack-server.mjs']) ok(!/Math\.random|Date\.now|new Date\(/.test(read(f)), `${f} has no clock or randomness`);
}

console.log(`show pack host checks passed (${checks} assertions)`);
