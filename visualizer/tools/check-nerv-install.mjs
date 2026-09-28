import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installNervPresets, NERV_SCENES } from './install-nerv-presets.mjs';

const temporary = fileURLToPath(new URL('../.tmp/', import.meta.url));
mkdirSync(temporary, { recursive: true });
const fixture = mkdtempSync(path.join(temporary, 'nerv-install-'));
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) => writeFileSync(file, `${JSON.stringify(value)}\n`);
try {
  const clean = path.join(fixture, 'public-only');
  assert.deepEqual(installNervPresets(clean), { added: 16, scenes: 16, total: 16 });
  const catalogPath = path.join(clean, 'catalog/presets.json');
  const validationPath = path.join(clean, 'catalog/parser-validation.json');
  const initialCatalog = readFileSync(catalogPath);
  const initialValidation = readFileSync(validationPath);
  const firstTime = statSync(catalogPath).mtimeMs;
  const catalog = json(catalogPath);
  assert.equal(catalog.presets.length, NERV_SCENES.length);
  for (const [index, entry] of catalog.presets.entries()) {
    const bytes = readFileSync(path.join(clean, entry.canonical_path));
    assert(!bytes.includes(13), 'Preset identities must stay stable across Git LF/CRLF checkouts');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    assert.equal(entry.bytes, bytes.length);
    assert.equal(entry.kind, 'nerv');
    assert.equal(entry.scene, NERV_SCENES[index][0]);
    assert.deepEqual(JSON.parse(bytes.toString('utf8')), { format: 'mpcaaavs-nerv', version: 1, scene: entry.scene });
  }
  assert(json(validationPath).results.every(result => result.status === 'unknown'));
  assert.deepEqual(installNervPresets(clean), { added: 0, scenes: 16, total: 16 });
  assert.deepEqual(readFileSync(catalogPath), initialCatalog);
  assert.deepEqual(readFileSync(validationPath), initialValidation);
  assert.equal(statSync(catalogPath).mtimeMs, firstTime);

  // A native rating changed the filename and modification date. Neither is
  // reset when the same source pack is staged again.
  const entry = catalog.presets[0];
  const old = path.join(clean, entry.canonical_path);
  entry.canonical_path = entry.canonical_path.replace('.nerv', ' [5 stars].nerv');
  entry.rating = 5;
  const rated = path.join(clean, entry.canonical_path);
  renameSync(old, rated);
  const ratingTime = new Date('2026-09-20T12:00:00Z');
  utimesSync(rated, ratingTime, ratingTime);
  const privatePreset = { sha256: 'f'.repeat(64), bytes: 5, display_name: 'Private preset', canonical_path: 'presets/unique/private [3 stars].avs', rating: 3, ownerMetadata: 'preserved' };
  catalog.presets.unshift(privatePreset);
  catalog.summary = { privateBankMetadata: 123 };
  writeFileSync(path.join(clean, privatePreset.canonical_path), 'hello');
  save(catalogPath, catalog);
  const validation = json(validationPath);
  validation.results.unshift({ sha256: privatePreset.sha256, status: 'lossless', arbitraryMetadata: 42 });
  save(validationPath, validation);
  const setupsFile = path.join(clean, 'setups.json');
  const setups = '[{"id":"mine","presets":["unchanged"]}]';
  writeFileSync(setupsFile, setups);
  assert.deepEqual(installNervPresets(clean), { added: 0, scenes: 16, total: 17 });
  const merged = json(catalogPath);
  assert.deepEqual(merged.presets[0], privatePreset);
  assert.deepEqual(merged.presets[1], entry);
  assert.deepEqual(merged.summary, catalog.summary);
  assert.equal(readFileSync(setupsFile, 'utf8'), setups);
  assert(!existsSync(old));
  assert.equal(statSync(rated).mtimeMs, ratingTime.getTime());
  assert.deepEqual(json(validationPath).results[0], validation.results[0]);
  assert.equal(json(validationPath).results[1].canonical_path, entry.canonical_path);

  // Never overwrite a colliding file, accept traversal, or write through a
  // directory junction. The catalog stays unchanged on rejected input.
  const protectedCatalog = readFileSync(catalogPath);
  writeFileSync(rated, 'unrelated file');
  assert.throws(() => installNervPresets(clean), /occupied by different content/);
  assert.deepEqual(readFileSync(catalogPath), protectedCatalog);
  entry.canonical_path = 'presets/unique/../../escape.nerv';
  save(catalogPath, catalog);
  assert.throws(() => installNervPresets(clean), /Invalid NERV preset path/);
  const external = path.join(fixture, 'external');
  mkdirSync(external);
  const linked = path.join(fixture, 'linked');
  symlinkSync(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => installNervPresets(path.join(linked, 'bank')), /Linked collection paths/);
  assert(!existsSync(path.join(external, 'bank')));
  assert.throws(() => installNervPresets('relative'), /absolute collection directory/);
  const busy = path.join(fixture, 'busy');
  mkdirSync(path.join(busy, 'catalog'), { recursive: true });
  writeFileSync(path.join(busy, 'catalog/nerv-install.lock'), 'occupied');
  assert.throws(() => installNervPresets(busy), /EEXIST/);
  assert.equal(readFileSync(path.join(busy, 'catalog/nerv-install.lock'), 'utf8'), 'occupied');
  console.log('NERV installer: public-only bank, 16 manifests, idempotence, mixed bank, ratings/time/setup preservation, collisions, traversal, junction and lock rejection PASS');
} finally {
  assert(path.resolve(fixture).startsWith(path.resolve(temporary) + path.sep));
  rmSync(fixture, { recursive: true, force: true });
}
