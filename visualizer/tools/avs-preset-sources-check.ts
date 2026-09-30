import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BUNDLED_AVS_PRESETS } from '../src/avs/bundled-presets.ts';
import { parseLocalAvsCatalog } from '../src/avs/local-collection.ts';
import {
  AvsPresetSourceRegistry,
  type AvsPresetSourceAdapter,
  type AvsPresetSourceId,
} from '../src/avs/preset-sources.ts';
import { resolvePresetSchedule } from '../src/offline/schedule.ts';
import { canonicalTimebase } from '../src/offline/timebase.ts';

const catalogJson = JSON.parse(await readFile('avs presets/catalog/presets.json', 'utf8'));
const parserJson = JSON.parse(await readFile('avs presets/catalog/parser-validation.json', 'utf8'));
const local = parseLocalAvsCatalog(catalogJson, parserJson, 'http://127.0.0.1:4300/');
assert.equal(local.length, 3_409, 'full local metadata count');
assert.equal(local.filter((entry) => entry.autoEligible).length, 3_406, 'compatible local auto bank count');
assert.equal(local.filter((entry) => !entry.autoEligible).length, 3, 'known parser exclusions');
assert.equal(BUNDLED_AVS_PRESETS.length, 124, 'bundled source count');

const loadCounts = new Map<AvsPresetSourceId, number>();
const revisions = new Map<AvsPresetSourceId, number>();
const bytesBySource = new Map<AvsPresetSourceId, Uint8Array>([
  ['bundled', new Uint8Array([1, 2, 3])],
  ['local', new Uint8Array([4, 5, 6, 7])],
  ['personal', new Uint8Array([8, 9])],
]);
const adapters: AvsPresetSourceAdapter[] = (['bundled', 'local', 'personal'] as const).map((sourceId) => ({
  id: sourceId,
  label: sourceId,
  async list() {
    const revision = revisions.get(sourceId) ?? 0;
    const bytes = bytesBySource.get(sourceId)!;
    return [
      { id: `${sourceId}-a-${revision}`, name: `${sourceId} A`, fileName: 'a.avs', collection: sourceId, byteLength: bytes.length },
      { id: `${sourceId}-excluded`, name: `${sourceId} excluded`, fileName: 'x.avs', collection: sourceId, autoEligible: false, unavailableReason: 'fixture parser exclusion' },
    ];
  },
  async load() {
    loadCounts.set(sourceId, (loadCounts.get(sourceId) ?? 0) + 1);
    return bytesBySource.get(sourceId)!.slice();
  },
}));
const registry = new AvsPresetSourceRegistry(adapters);

for (const sourceId of ['bundled', 'local', 'personal'] as const) {
  const liveSnapshot = await registry.list(sourceId);
  const offlineSnapshot = await registry.list(sourceId);
  assert.strictEqual(liveSnapshot, offlineSnapshot, `${sourceId} live/offline consumers share one snapshot object`);
  assert.equal(loadCounts.get(sourceId) ?? 0, 0, `${sourceId} listing is metadata-only`);
  const auto = await registry.autoBank(sourceId);
  assert.equal(auto.length, 1, `${sourceId} auto bank excludes unavailable presets`);
  const fixed = await registry.require(sourceId, liveSnapshot[0]!.id);
  assert.strictEqual(fixed, liveSnapshot[0], `${sourceId} fixed selection resolves the shared entry`);
  const schedule = resolvePresetSchedule({
    mode: 'auto', availablePresetIds: auto.map((entry) => entry.ledgerId), seed: 7,
    totalSamples: 384_000, bpm: 120, beatsPerBar: 4, downbeatSample: 0,
  }, canonicalTimebase());
  assert.ok(schedule.entries.every((cue) => cue.presetId === auto[0]!.ledgerId), `${sourceId} auto cue ledger uses source-qualified IDs`);
  assert.deepEqual([...await fixed.load()], [...bytesBySource.get(sourceId)!], `${sourceId} lazy bytes resolve exactly`);
  assert.equal(loadCounts.get(sourceId), 1, `${sourceId} bytes load only on selection`);
}

const beforeRefresh = await registry.list('personal');
revisions.set('personal', 1);
registry.invalidate('personal');
const afterRefresh = await registry.list('personal');
assert.notStrictEqual(afterRefresh, beforeRefresh, 'personal invalidation refreshes shared metadata');
assert.match(afterRefresh[0]!.id, /-1$/, 'personal refresh exposes current bank contents');

const unavailable = new AvsPresetSourceRegistry([{
  id: 'local', label: 'local',
  async list() { throw new Error('loopback collection is offline'); },
  async load() { throw new Error('unreachable'); },
}]);
const unavailableSnapshot = await unavailable.snapshot('local');
assert.equal(unavailableSnapshot.entries.length, 0);
assert.match(unavailableSnapshot.error ?? '', /loopback collection is offline/);

console.log('avs preset sources: 124 bundled, 3,409 local (3,406 eligible + 3 excluded), shared lazy live/offline snapshots and personal refresh passed');
