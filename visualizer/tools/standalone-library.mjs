// Loopback-only persistence adapter for the shared AAAVS playback host.
// Keep this handler ahead of static serving: private state is never a web asset.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink, link, utimes } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { createShowPackReader } from './show-pack-server.mjs';

const REQUEST_LIMIT = 4 * 1024 * 1024;
const DATA_LIMIT = 32 * 1024 * 1024;
const ASSET_LIMIT = 64 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const defaults = { enabled:true, bars:0, shuffle:false, minimumRating:0, transition:1, beats:0, durationMs:2000, keepOld:true, manualFade:true, autoFade:true };
const defaultTiming = { enabled:false, bpm:120, offsetSeconds:0, barsPerScene:8, seed:1 };
// Optional v2 fade fields (contract 2.2.1): copied only when present; a present invalid value is rejected.
const FADE_FIELDS = [['fadeTiming',0,6],['fadeRandomSet',1,31],['fadeAnchor',0,2],['queueQuantize',0,3]];
const STATE_NAMES = ['folders','stats'];
const STATE_MAX_BYTES = 3670016;
// Song-map cache (src/song-map/cache.ts): one record per track identity and map version, at most SONG_MAP_KEEP files.
const SONG_MAP_KEY = /^[0-9a-f]{64}-v[1-9][0-9]{0,3}$/;
const SONG_MAP_PAYLOAD_LIMIT = 3 * 1024 * 1024;
const SONG_MAP_KEEP = 200;

function requireValue(condition, message) { if (!condition) throw Error(message); }
function settings(value) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Invalid settings');
  requireValue([0,2,4,8,12].includes(value.bars) && [0,1,2,4].includes(value.beats)
    && Number.isInteger(value.transition) && value.transition >= 0 && value.transition <= 32
    && Number.isInteger(value.durationMs) && value.durationMs >= 250 && value.durationMs <= 8000
    && ['enabled','shuffle','keepOld','manualFade','autoFade'].every(key => typeof value[key] === 'boolean'), 'Invalid settings');
  const minimumRating = value.minimumRating === undefined ? 0 : value.minimumRating;
  requireValue(Number.isInteger(minimumRating) && minimumRating >= 0 && minimumRating <= 5, 'Invalid minimum rating');
  const result = Object.fromEntries(Object.keys(defaults).map(key => [key, key === 'minimumRating' ? minimumRating : value[key]]));
  for (const [key, low, high] of FADE_FIELDS) {
    if (value[key] === undefined) continue;
    requireValue(Number.isInteger(value[key]) && value[key] >= low && value[key] <= high, 'Invalid settings');
    result[key] = value[key];
  }
  return result;
}
function timing(value) {
  if (value === undefined) return { ...defaultTiming };
  requireValue(value && typeof value === 'object' && typeof value.enabled === 'boolean'
    && Number.isFinite(value.bpm) && value.bpm >= 20 && value.bpm <= 400
    && Number.isFinite(value.offsetSeconds) && Math.abs(value.offsetSeconds) <= 3600
    && Number.isInteger(value.barsPerScene) && value.barsPerScene >= 1 && value.barsPerScene <= 128
    && Number.isInteger(value.seed) && value.seed >= 0 && value.seed <= 0xffffffff, 'Invalid scene timing');
  const result = Object.fromEntries(Object.keys(defaultTiming).map(key => [key,value[key]]));
  return { ...result, ...timingV2(value) };
}
// Scene timing v2 (contract 2.2.2). Default-valued fields are omitted and `version: 2` is written only when a v2
// field survives, so a v1 timing serialises as exactly its five keys. Unknown keys are dropped; version > 2 is tolerated.
function timingV2(value) {
  const finite = x => typeof x === 'number' && Number.isFinite(x);
  const integerIn = (x, low, high) => Number.isInteger(x) && x >= low && x <= high;
  const fail = name => requireValue(false, `Scene timing ${name} is invalid`);
  const out = {};
  // No upper bound, exactly like the shared parser: any whole number from 1 is a tolerated future version.
  if (value.version !== undefined) requireValue(Number.isInteger(value.version) && value.version >= 1, 'Scene timing version is invalid');
  if (value.beatsPerBar !== undefined) { requireValue(integerIn(value.beatsPerBar, 1, 16), 'Scene timing beatsPerBar is invalid'); if (value.beatsPerBar !== 4) out.beatsPerBar = value.beatsPerBar; }
  if (value.barsPattern !== undefined) {
    requireValue(Array.isArray(value.barsPattern) && value.barsPattern.length >= 1 && value.barsPattern.length <= 64 && value.barsPattern.every(x => integerIn(x, 1, 128)), 'Scene timing barsPattern is invalid');
    out.barsPattern = [...value.barsPattern];
  }
  if (value.patternHold !== undefined) { requireValue(typeof value.patternHold === 'boolean', 'Scene timing patternHold is invalid'); if (value.patternHold) out.patternHold = true; }
  if (value.tempoMap !== undefined) {
    const map = value.tempoMap;
    requireValue(Array.isArray(map) && map.length >= 1 && map.length <= 256, 'Scene timing tempoMap is invalid');
    let previous = value.offsetSeconds;
    out.tempoMap = map.map(entry => {
      if (!entry || typeof entry !== 'object' || !finite(entry.at) || !finite(entry.bpm) || entry.bpm < 20 || entry.bpm > 400 || entry.at <= previous || entry.at > 1e6) fail('tempoMap');
      previous = entry.at;
      return { at:entry.at, bpm:entry.bpm };
    });
  }
  if (value.script !== undefined) {
    requireValue(Array.isArray(value.script) && value.script.length <= 1024, 'Scene timing script is invalid');
    let previous = -1;
    const script = value.script.map(entry => {
      if (!entry || typeof entry !== 'object' || !Number.isSafeInteger(entry.ordinal) || entry.ordinal <= previous || typeof entry.preset !== 'string' || !HASH.test(entry.preset)) fail('script');
      previous = entry.ordinal;
      return { ordinal:entry.ordinal, preset:entry.preset };
    });
    if (script.length) out.script = script;
  }
  if (value.intervals !== undefined) {
    requireValue(Array.isArray(value.intervals) && value.intervals.length <= 64, 'Scene timing intervals are invalid');
    const ids = new Set();
    const intervals = value.intervals.map(entry => {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(entry.id) || ids.has(entry.id)
        || !finite(entry.startBeat) || !finite(entry.endBeat) || entry.startBeat < 0 || entry.startBeat >= entry.endBeat || entry.endBeat > 1e7) fail('intervals');
      ids.add(entry.id);
      return { id:entry.id, startBeat:entry.startBeat, endBeat:entry.endBeat };
    });
    if (intervals.length) out.intervals = intervals;
  }
  return Object.keys(out).length ? { version:2, ...out } : {};
}
function setups(value) {
  requireValue(Array.isArray(value) && value.length <= 100, 'At most 100 setups are allowed');
  const ids = new Set();
  return value.map(item => {
    requireValue(item && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 100 && !ids.has(item.id)
      && typeof item.name === 'string' && item.name.trim().length > 0 && item.name.length <= 120
      && Array.isArray(item.presets) && item.presets.length <= 500
      && item.presets.every(hash => typeof hash === 'string' && HASH.test(hash))
      && new Set(item.presets).size === item.presets.length, 'Invalid setup or duplicate preset');
    ids.add(item.id);
    return { id:item.id, name:item.name.trim(), presets:[...item.presets], settings:settings(item.settings), timing:timing(item.timing) };
  });
}

// Shallow validation of the page's private state files (BRW 5.3/5.4). The page parser is the authority; this only bounds
// shape and size so the server never stores something the page could not have written.
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const shortText = (x, max) => typeof x === 'string' && x.length <= max;
function stateName(name) { requireValue(typeof name === 'string' && STATE_NAMES.includes(name), 'Unknown state file'); return name; }
function stateBody(name, value) {
  requireValue(plain(value) && Number.isInteger(value.version) && value.version >= 1, 'Invalid state file');
  if (name === 'folders') {
    if (value.folders !== undefined) {
      requireValue(Array.isArray(value.folders) && value.folders.length <= 200, 'Invalid state file');
      let members = 0;
      for (const folder of value.folders) {
        requireValue(plain(folder) && shortText(folder.id, 100) && folder.id.length > 0 && shortText(folder.name, 120)
          && (folder.parent === undefined || folder.parent === null || shortText(folder.parent, 100))
          && (folder.kind === undefined || shortText(folder.kind, 16))
          && (folder.query === undefined || shortText(folder.query, 400))
          && (folder.scope === undefined || folder.scope === null || shortText(folder.scope, 400)), 'Invalid state file');
        if (folder.presets !== undefined) {
          requireValue(Array.isArray(folder.presets) && folder.presets.length <= 5000 && folder.presets.every(hash => typeof hash === 'string' && HASH.test(hash)), 'Invalid state file');
          members += folder.presets.length;
        }
      }
      requireValue(members <= 30000, 'Invalid state file');
    }
    if (value.playback !== undefined) {
      requireValue(plain(value.playback) && Object.keys(value.playback).length <= 300 && Object.keys(value.playback).every(key => key.length <= 400), 'Invalid state file');
    }
    requireValue(value.last === undefined || value.last === null || (plain(value.last) && shortText(value.last.key, 400)), 'Invalid state file');
    if (value.ui !== undefined) {
      requireValue(plain(value.ui) && (value.ui.expanded === undefined || (Array.isArray(value.ui.expanded) && value.ui.expanded.length <= 300 && value.ui.expanded.every(key => shortText(key, 400))))
        && (value.ui.selected === undefined || value.ui.selected === null || shortText(value.ui.selected, 400)), 'Invalid state file');
    }
  } else {
    if (value.plays !== undefined) {
      requireValue(plain(value.plays), 'Invalid state file');
      const keys = Object.keys(value.plays);
      requireValue(keys.length <= 20000 && keys.every(key => HASH.test(key) && Array.isArray(value.plays[key]) && value.plays[key].length === 2
        && value.plays[key].every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0)), 'Invalid state file');
    }
  }
  requireValue(Buffer.byteLength(JSON.stringify(value)) <= STATE_MAX_BYTES, 'State is too large');
  return value;
}

function songMapKey(key) { requireValue(typeof key === 'string' && SONG_MAP_KEY.test(key), 'Invalid song map key'); return key; }
/** Shape and size only; the page decodes and validates the content and treats anything wrong as a cache miss. */
function songMapRecord(key, value) {
  requireValue(plain(value) && Number.isInteger(value.version) && value.version >= 1 && value.version <= 9999
    && typeof value.analyzer === 'string' && /^[a-z0-9._-]{1,64}$/i.test(value.analyzer)
    && typeof value.trackId === 'string' && HASH.test(value.trackId) && `${value.trackId}-v${value.version}` === key
    && (value.encoding === 'gzip' || value.encoding === 'identity')
    && typeof value.payload === 'string' && value.payload.length <= SONG_MAP_PAYLOAD_LIMIT && /^[A-Za-z0-9+/]*={0,2}$/.test(value.payload), 'Invalid song map record');
  return { version:value.version, analyzer:value.analyzer, trackId:value.trackId, encoding:value.encoding, payload:value.payload };
}
async function pruneSongMaps(directory) {
  const names = (await readdir(directory)).filter(name => /^[0-9a-f]{64}-v[1-9][0-9]{0,3}\.json$/.test(name));
  if (names.length <= SONG_MAP_KEEP) return;
  const dated = await Promise.all(names.map(async name => ({ name, time:(await lstat(join(directory, name))).mtimeMs })));
  dated.sort((a, b) => a.time - b.time || (a.name < b.name ? -1 : 1));
  for (const old of dated.slice(0, dated.length - SONG_MAP_KEEP)) await unlink(join(directory, old.name)).catch(() => {});
}

async function noLinks(path, allowMissing = false) {
  const absolute = resolve(path), anchor = parse(absolute).root;
  let current = anchor;
  const parts = relative(anchor, absolute).split(sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    let info;
    try { info = await lstat(current); }
    catch (error) { if (allowMissing && error.code === 'ENOENT') return; throw error; }
    requireValue(!info.isSymbolicLink(), 'Linked library paths are not writable');
    if (index < parts.length - 1) requireValue(info.isDirectory(), 'Invalid library directory');
    else if (info.isFile()) requireValue(info.nlink === 1, 'Linked library files are not writable');
  }
}
async function jsonFile(path, fallback) {
  await noLinks(path, fallback !== undefined);
  let handle;
  try { handle = await open(path, 'r'); }
  catch(error) { if(error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
  try {
    const info = await handle.stat();
    requireValue(info.isFile() && info.size <= DATA_LIMIT, 'Library data exceeds size limit');
    const data = await handle.readFile();
    requireValue(data.length <= DATA_LIMIT, 'Library data exceeds size limit');
    return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(data));
  } finally { await handle.close(); }
}
async function atomicJson(path, value) {
  const data = JSON.stringify(value);
  requireValue(Buffer.byteLength(data) <= DATA_LIMIT, 'Library data exceeds size limit');
  await noLinks(path, true);
  const temporary = `${path}.writing`;
  await noLinks(temporary, true);
  const file = await open(temporary, 'wx', 0o600);
  let closed = false;
  try {
    await file.writeFile(data, 'utf8'); await file.sync(); await file.close(); closed = true;
    await noLinks(path, true); await rename(temporary, path);
  } catch(error) {
    if (!closed) await file.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
function presetPath(root, value) {
  requireValue(typeof value === 'string' && value.length <= 2048 && value.startsWith('presets/unique/')
    && !/[\\%:\x00-\x1f]/.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..')
    && ['.avs','.nerv','.hud'].includes(extname(value)), 'Invalid preset path');
  const result = resolve(root, value), rel = relative(root, result);
  requireValue(!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`), 'Preset escaped collection');
  return result;
}
async function digest(path) {
  const hash = createHash('sha256'); let size = 0;
  for await (const block of createReadStream(path)) { size += block.length; requireValue(size <= ASSET_LIMIT, 'Preset exceeds size limit'); hash.update(block); }
  return { hash:hash.digest('hex'), size };
}
async function catalogEntry(root, hash) {
  requireValue(typeof hash === 'string' && HASH.test(hash), 'Invalid preset identity');
  const path = join(root, 'catalog', 'presets.json'), catalog = await jsonFile(path);
  requireValue(catalog && Array.isArray(catalog.presets) && catalog.presets.length <= 50000, 'Invalid preset catalog');
  const entries = catalog.presets.filter(entry => entry && entry.sha256 === hash);
  requireValue(entries.length === 1, entries.length ? 'Duplicate preset identity in catalog' : 'Unknown preset');
  const entry = entries[0], source = presetPath(root, entry.canonical_path);
  await noLinks(source, true);
  return { path, catalog, entry, source };
}

async function rate(root, request) {
  requireValue(Number.isInteger(request.rating) && request.rating >= 1 && request.rating <= 5, 'Invalid rating');
  const { path, catalog, entry, source } = await catalogEntry(root, request.hash);
  const info = await lstat(source);
  requireValue(info.isFile() && info.size <= ASSET_LIMIT && info.nlink === 1, 'Invalid preset file');
  const identity = await digest(source);
  requireValue(identity.hash === request.hash && identity.size === entry.bytes, 'Preset content does not match catalog');
  const extension = extname(source), stem = basename(source, extension).replace(/ \[[1-5] stars\]$/, '');
  const target = join(dirname(source), `${stem} [${request.rating} stars]${extension}`);
  const nextRelative = relative(root, target).split(sep).join('/');
  requireValue(!catalog.presets.some(other => other !== entry && typeof other?.canonical_path === 'string'
    && other.canonical_path.toLowerCase() === nextRelative.toLowerCase()), 'Rated filename already belongs to another preset');
  await noLinks(target, true);
  let moved = false;
  if (source !== target) {
    // link() reserves the destination without overwriting an existing file.
    // Both names refer to the exact original bytes; unlink completes the move.
    await link(source, target);
    try { await unlink(source); moved = true; }
    catch(error) { await unlink(target); throw error; }
  }
  try {
    await utimes(target, info.atime, new Date());
    entry.canonical_path = nextRelative; entry.rating = request.rating;
    await atomicJson(path, catalog);
  } catch(error) {
    try {
      await utimes(target, info.atime, info.mtime);
      if (moved) { await link(target, source); await unlink(target); }
    } catch { throw Error('Save failed and rollback needs attention; preset remains on disk'); }
    throw error;
  }
  return { type:'rating-saved', entry };
}

const SHOW_PACK_OPS = ['list-show-packs','list-show-pack-files','read-show-pack-file'];
async function showPackOp(packs, request) {
  const exact = keys => requireValue(Object.keys(request).every(key => key === 'op' || keys.includes(key)), 'Invalid library request');
  switch(request.op) {
    case 'list-show-packs': exact([]); return {type:'show-packs',packs:await packs.list()};
    case 'list-show-pack-files': exact(['pack']); return {type:'show-pack-files',pack:request.pack,files:await packs.files(request.pack)};
    default: exact(['pack','path']); return await packs.read(request.pack,request.path);
  }
}
function send(res, status, value) {
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Cross-Origin-Resource-Policy':'same-origin' });
  res.end(JSON.stringify(value));
}
function allowed(req) {
  const remote = req.socket?.remoteAddress;
  if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)) return false;
  const port = req.socket.localPort;
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  return typeof req.headers.host === 'string' && hosts.includes(req.headers.host)
    && req.headers.origin === `http://${req.headers.host}`
    && (!req.headers['sec-fetch-site'] || ['same-origin','none'].includes(req.headers['sec-fetch-site']));
}
async function body(req) {
  requireValue(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''), 'Expected application/json');
  requireValue(!req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity', 'Encoded bodies are not supported');
  const declared = req.headers['content-length'];
  requireValue(declared === undefined || (/^\d+$/.test(declared) && Number(declared) <= REQUEST_LIMIT), 'Request exceeds size limit');
  const blocks = []; let bytes = 0;
  // Do not destroy the HTTP socket before returning the bounded-body error.
  for await (const block of req.iterator({destroyOnReturn:false})) {
    bytes += block.length;
    if(bytes > REQUEST_LIMIT) { req.resume(); throw Error('Request exceeds size limit'); }
    blocks.push(block);
  }
  return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(blocks)));
}

/** root is the AAAVS application directory, not the collection directory. `options.showPacks` is the directory holding private show asset packs
 * (`<dir>/<pack-id>/pack.json`, tools/show-pack-server.mjs); without it the read-only show-pack operations are refused. */
export function createLibraryHandler(root, options = {}) {
  const showPacks = createShowPackReader(options.showPacks);
  const collection = resolve(root, 'avs presets'), privateRoot = join(collection, '.aaavs-private');
  let queue = Promise.resolve(), pending = 0;
  async function execute(request) {
    await noLinks(collection);
    requireValue((await lstat(collection)).isDirectory(), 'Local preset collection is unavailable');
    await noLinks(privateRoot, true); await mkdir(privateRoot, {recursive:true, mode:0o700}); await noLinks(privateRoot);
    // The NERV installer uses the same exclusive-create catalog lock. Ratings
    // and preset installation must never independently replace a stale catalog.
    const locks = [];
    try {
      for (const lockPath of [join(collection,'catalog','nerv-install.lock'),join(privateRoot,'library.lock')]) {
        await noLinks(lockPath, true);
        locks.push({path:lockPath,handle:await open(lockPath,'wx',0o600)});
      }
      switch(request.op) {
        case 'rate': return await rate(collection, request);
        case 'set-not-working': {
          requireValue(typeof request.notWorking === 'boolean', 'Invalid preset status');
          const {path,catalog,entry} = await catalogEntry(collection, request.hash);
          entry.notWorking = request.notWorking; await atomicJson(path,catalog);
          return { type:'not-working-saved',entry };
        }
        case 'load-setups': return {type:'setups-loaded',setups:setups(await jsonFile(join(privateRoot,'setups.json'),[]))};
        case 'save-setups': await atomicJson(join(privateRoot,'setups.json'),setups(request.setups)); return {type:'setups-saved'};
        case 'load-settings': return {type:'settings',...settings(await jsonFile(join(privateRoot,'settings.json'),defaults))};
        case 'configure': {
          const value = settings(request.settings); await atomicJson(join(privateRoot,'settings.json'),value);
          return {type:'settings',...value};
        }
        case 'load-state': {
          const name = stateName(request.name), data = await jsonFile(join(privateRoot,`${name}.json`),null);
          if (data !== null) { try { stateBody(name,data); } catch { throw Error('Saved state is corrupt or too large'); } }
          return {type:'state-loaded',name,data};
        }
        case 'save-state': {
          const name = stateName(request.name), data = stateBody(name,request.data);
          await atomicJson(join(privateRoot,`${name}.json`),data);
          return {type:'state-saved',name};
        }
        case 'load-song-map': {
          const key = songMapKey(request.key);
          let data = null;
          try { data = songMapRecord(key, await jsonFile(join(privateRoot,'song-maps',`${key}.json`),null)); } catch { data = null; }
          return {type:'song-map-loaded',key,data};
        }
        case 'save-song-map': {
          const key = songMapKey(request.key), data = songMapRecord(key,request.data), directory = join(privateRoot,'song-maps');
          await noLinks(directory, true); await mkdir(directory, {recursive:true, mode:0o700}); await noLinks(directory);
          await atomicJson(join(directory,`${key}.json`),data);
          await pruneSongMaps(directory);
          return {type:'song-map-saved',key};
        }
        default: throw Error('Unknown library request');
      }
    } finally {
      // Release every lock acquired by this request even if a later acquisition
      // or release fails. Existing lock files are never removed by this request.
      const released = await Promise.allSettled(locks.reverse().map(async lock => {
        try { await lock.handle.close(); } finally { await unlink(lock.path); }
      }));
      const failed = released.find(result => result.status === 'rejected');
      if(failed) throw failed.reason;
    }
  }
  return async function handleLibrary(req,res) {
    let path;
    try { path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname).replaceAll('\\','/'); }
    catch { send(res,400,{type:'library-error',operation:'',message:'Invalid request path'}); return true; }
    // Deny hidden state and transaction artifacts before the static file server.
    if (path.split('/').some(part => part.replace(/[. ]+$/, '').toLowerCase() === '.aaavs-private' || /\.(?:writing|lock)[. ]*$/i.test(part))
      || /^\/avs presets\/(?:setups|settings|folders|stats)\.json$/i.test(path)) {
      send(res,404,{type:'library-error',operation:'',message:'Not found'}); return true;
    }
    if(path !== '/api/aaavs/library') {
      // Windows short names and linked aliases must not expose the private folder.
      try {
        const actual = (await realpath(resolve(root, `.${path}`))).toLowerCase();
        if(actual === privateRoot.toLowerCase() || actual.startsWith(privateRoot.toLowerCase()+sep)) {
          send(res,404,{type:'library-error',operation:'',message:'Not found'}); return true;
        }
      } catch { /* Missing static assets are handled by the caller. */ }
      return false;
    }
    if(req.method !== 'POST') { req.resume(); send(res,405,{type:'library-error',operation:'',message:'Use POST'}); return true; }
    if(!allowed(req)) { req.resume(); send(res,403,{type:'library-error',operation:'',message:'A same-origin loopback request is required'}); return true; }
    let operation = '', reserved = false;
    try {
      requireValue(pending < 64, 'Too many pending library requests');
      pending++; reserved = true;
      req.setTimeout(15000, () => req.destroy(Error('Library request timed out')));
      const request = await body(req);
      req.setTimeout(0);
      requireValue(request && typeof request === 'object' && !Array.isArray(request) && typeof request.op === 'string' && request.op.length <= 40, 'Invalid library request');
      operation = request.op;
      // Read-only show-pack operations never touch the collection, its locks or the write queue.
      if(SHOW_PACK_OPS.includes(request.op)) {
        const result = await showPackOp(showPacks,request);
        if(Buffer.isBuffer(result)) { res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':result.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'}); res.end(result); }
        else send(res,200,result);
        return true;
      }
      const task = queue.then(() => execute(request)); queue = task.catch(() => {});
      send(res,200,await task);
    } catch(error) {
      if(error.showPack) { req.setTimeout(0); req.resume(); send(res,error.missing?404:400,{type:'library-error',operation,message:error.message,...(error.missing?{missing:true}:{})}); return true; }
      req.setTimeout(0); req.resume();
      // Do not leak local filesystem paths through Node system error messages.
      const message = error.code ? ({EEXIST:'Library transaction or rated filename already exists',ENOENT:'Library file is missing',EACCES:'Library file is not writable',EPERM:'Library operation is not permitted'}[error.code] ?? 'Library filesystem operation failed') : error.message;
      send(res,400,{type:'library-error',operation,message});
    } finally { if(reserved) pending--; }
    return true;
  };
}
