import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = fileURLToPath(new URL('../nerv-presets/', import.meta.url));
export const NERV_SCENES = Object.freeze([
  ['boot', 'Boot'], ['magi', 'Magi'], ['psycho', 'Psycho'], ['radar', 'Radar'],
  ['harmonics', 'Harmonics'], ['seele', 'Seele'], ['battery', 'Battery'], ['atfield', 'AT Field'],
  ['alert', 'Alert'], ['plug', 'Entry Plug'], ['target', 'Target'], ['city', 'Tokyo-3'],
  ['sync', 'Sync'], ['berserk', 'Berserk'], ['impact', 'Impact'], ['end', 'End'],
]);
const digest = data => createHash('sha256').update(data).digest('hex');

function noWindowsReparsePoints(target) {
  if (process.platform !== 'win32') return;
  // Node exposes symlink/junction tags but not every Windows reparse tag (for
  // example storage filter tags). Inspect the Windows attribute as well.
  const script = `$ErrorActionPreference = 'Stop'
$target = $env:MPC_AAAVS_NERV_TARGET
$current = $target
while ($current) {
  if (Test-Path -LiteralPath $current) {
    if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 42 }
  }
  $current = [IO.Path]::GetDirectoryName($current)
}
if (Test-Path -LiteralPath $target) {
  $linked = Get-ChildItem -LiteralPath $target -Recurse -Force -Attributes ReparsePoint | Select-Object -First 1
  if ($linked) { exit 42 }
}`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      env: { ...process.env, MPC_AAAVS_NERV_TARGET: target }, stdio: 'pipe', windowsHide: true,
    });
  } catch (error) {
    if (error.status === 42) throw new Error('Linked collection paths and Windows reparse points are not writable');
    throw new Error('Cannot verify Windows collection path attributes');
  }
}

// Check every existing ancestor, including junctions on Windows. Comparing the
// resolved name also rejects redirected paths that are not exposed as symlinks.
function noLinks(value) {
  const absolute = path.resolve(value);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stats;
    try { stats = lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (stats.isSymbolicLink()) throw new Error(`Linked collection paths are not writable: ${current}`);
    const normalize = process.platform === 'win32' ? text => text.toLowerCase() : text => text;
    if (normalize(realpathSync.native(current)) !== normalize(current)) {
      throw new Error(`Redirected collection paths are not writable: ${current}`);
    }
  }
}

function directory(value) {
  noLinks(value);
  mkdirSync(value, { recursive: true });
  noLinks(value);
}

function jsonFile(file, field) {
  noLinks(file);
  if (!existsSync(file)) return { [field]: [] };
  if (lstatSync(file).size > 32 * 1024 * 1024) throw new Error(`Oversized catalog: ${file}`);
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value[field])) {
    throw new Error(`Invalid ${field} catalog: ${file}`);
  }
  return value;
}

function presetPath(root, relative) {
  if (typeof relative !== 'string' || !relative.startsWith('presets/unique/')
      || /[\\:%\0]/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')
      || !relative.endsWith('.nerv')) throw new Error('Invalid NERV preset path');
  const result = path.join(root, ...relative.split('/'));
  noLinks(result);
  return result;
}

function atomicJson(file, value) {
  const data = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(file) && readFileSync(file, 'utf8') === data) return false;
  noLinks(file);
  const temp = `${file}.${randomUUID()}.writing`;
  noLinks(temp);
  const handle = openSync(temp, 'wx');
  try {
    try {
      writeFileSync(handle, data, 'utf8');
      fsyncSync(handle);
    } finally { closeSync(handle); }
    renameSync(temp, file);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
  return true;
}

/** Merge the public pack without replacing any private preset or rated filename. */
export function installNervPresets(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('Supply an absolute collection directory');
  const root = path.resolve(target);
  noLinks(root);
  noWindowsReparsePoints(root);
  directory(path.join(root, 'catalog'));
  directory(path.join(root, 'presets', 'unique'));
  const lock = path.join(root, 'catalog', 'nerv-install.lock');
  noLinks(lock);
  const installLock = openSync(lock, 'wx');
  let ratingLock;
  try {
    // Native ratings open this file with no sharing. Holding it open prevents
    // their catalog write during installation (and fails if one is in flight).
    const ratingLockPath = path.join(root, 'catalog', 'ratings.lock');
    noLinks(ratingLockPath);
    ratingLock = openSync(ratingLockPath, 'a+');
    const catalogPath = path.join(root, 'catalog', 'presets.json');
    const validationPath = path.join(root, 'catalog', 'parser-validation.json');
    const catalog = jsonFile(catalogPath, 'presets');
    const validation = jsonFile(validationPath, 'results');
    const byHash = new Map();
    for (const entry of catalog.presets) {
      if (!entry || typeof entry.sha256 !== 'string') throw new Error('Invalid existing catalog entry');
      const hash = entry.sha256.toLowerCase();
      if (byHash.has(hash)) throw new Error(`Duplicate catalog identity: ${hash}`);
      byHash.set(hash, entry);
    }
    let added = 0;
    for (const [index, [scene, title]] of NERV_SCENES.entries()) {
      const source = path.join(sourceDirectory, `${scene}.nerv`);
      noLinks(source);
      const bytes = readFileSync(source);
      const manifest = JSON.parse(bytes.toString('utf8'));
      if (manifest.format !== 'mpcaaavs-nerv' || manifest.version !== 1 || manifest.scene !== scene
          || Object.keys(manifest).length !== 3) throw new Error(`Invalid source manifest: ${scene}`);
      const sha256 = digest(bytes);
      let entry = byHash.get(sha256);
      if (!entry) {
        entry = {
          sha256, bytes: bytes.length, kind: 'nerv', scene,
          canonical_path: `presets/unique/NERV ${String(index + 1).padStart(2, '0')} - ${title}.nerv`,
          display_name: `NERV / ${String(index + 1).padStart(2, '0')} — ${title}`,
        };
        catalog.presets.push(entry);
        byHash.set(sha256, entry);
        added++;
      } else if (entry.bytes !== bytes.length || (entry.kind !== undefined && entry.kind !== 'nerv')) {
        throw new Error(`Conflicting manifest metadata: ${scene}`);
      }
      const destination = presetPath(root, entry.canonical_path);
      directory(path.dirname(destination));
      if (existsSync(destination)) {
        if (!lstatSync(destination).isFile() || lstatSync(destination).size !== bytes.length || digest(readFileSync(destination)) !== sha256) {
          throw new Error(`Preset path is occupied by different content: ${destination}`);
        }
      } else writeFileSync(destination, bytes, { flag: 'wx' });
      entry.kind = 'nerv';
      entry.scene = scene;
      const existing = validation.results.filter(result => result?.sha256?.toLowerCase() === sha256);
      if (existing.length > 1) throw new Error(`Duplicate parser identity: ${sha256}`);
      if (!existing.length) validation.results.push({ sha256, canonical_path: entry.canonical_path, status: 'unknown', kind: 'nerv' });
      else {
        existing[0].canonical_path = entry.canonical_path;
        existing[0].status = 'unknown';
        existing[0].kind = 'nerv';
      }
    }
    // Parser metadata first: interrupted installation still leaves every old
    // catalog entry usable. The next invocation completes any missing merge.
    atomicJson(validationPath, validation);
    atomicJson(catalogPath, catalog);
    return { added, scenes: NERV_SCENES.length, total: catalog.presets.length };
  } finally {
    if (ratingLock !== undefined) closeSync(ratingLock);
    closeSync(installLock);
    unlinkSync(lock);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = installNervPresets(process.argv[2]);
    console.log(`NERV pack: ${result.added} added, ${result.scenes} available, ${result.total} total presets.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
