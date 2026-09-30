// Preset crate contract (src/crate/): browsing is inert, go is the only live
// path, search/filter/favourites/recents behave, 3,400 entries stay capped and
// fast, flash flags are heuristic-labelled and overridable, and ui.ts routes a
// crate commit through the same onPick handlers as the old selects.
//
// Run: node tools/run-crate-check.mjs. Exits non-zero on any regression.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CRATE_FILTER_FAVOURITES,
  CRATE_FILTER_RECENT,
  CRATE_ROW_CAP,
  CrateController,
  CratePrefs,
  crateChips,
  filterCrate,
  makeCrateEntry,
  pickRandomEntry,
  type CrateEntry,
  type CrateStorage,
} from '../src/crate/crate-model.ts';
import {
  FLASH_NAME_HEURISTIC,
  flashFlagFor,
  heuristicFlashFlag,
  registerFlashFlagSource,
} from '../src/crate/flash-flags.ts';

let assertions = 0;
function assert(condition: unknown, label: string): void {
  assertions++;
  if (!condition) throw new Error(`crate-check: ${label}`);
}

class MemoryStorage implements CrateStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
}

const throwingStorage: CrateStorage = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
};

const BUNDLED = [
  { id: 'community-picks/UnConeD - Seismogrid', name: 'UnConeD - Seismogrid', collection: 'Community Picks' },
  { id: 'community-picks/UnConeD - Goldie', name: 'UnConeD - Goldie', collection: 'Community Picks' },
  { id: 'winamp/strobe-o-scope', name: 'strobe-o-scope', collection: 'Winamp 5 Picks' },
  { id: 'winamp/Grid Dance', name: 'Grid Dance', collection: 'Winamp 5 Picks' },
];
const PERSONAL = [{ id: 'p1', name: 'my flicker edit' }];

// --- flash flags ------------------------------------------------------------
{
  const strobe = heuristicFlashFlag({ name: 'strobe-o-scope', collection: 'Winamp 5 Picks' });
  assert(strobe?.flashing === true && strobe.kind === 'heuristic', 'strobe name is heuristically flagged');
  assert(/heuristic/i.test(strobe!.reason) && /not measured/i.test(strobe!.reason), 'heuristic flag says it is a guess');
  assert(heuristicFlashFlag({ name: 'Goldie', collection: 'Community Picks' }) === null, 'calm name is not flagged');
  assert(heuristicFlashFlag({ name: 'x', collection: 'Epilepsy warning pack' }) !== null, 'collection text also counts');
  for (const word of ['STROBE', 'flash', 'Seizure', 'epileptic']) assert(FLASH_NAME_HEURISTIC.test(word), `heuristic matches ${word}`);

  const subject = { bank: 'bundled', id: 'winamp/strobe-o-scope', name: 'strobe-o-scope', collection: 'Winamp 5 Picks' };
  const release = registerFlashFlagSource((s) => s.id === subject.id
    ? { kind: 'measured', flashing: false, reason: '0 flashes/s measured' } : null);
  const measured = flashFlagFor(subject);
  assert(measured?.kind === 'measured' && measured.flashing === false, 'measured opinion overrides the heuristic');
  assert(flashFlagFor({ ...subject, id: 'other', name: 'flash' })?.kind === 'heuristic', 'measured source with no opinion falls back');
  release();
  assert(flashFlagFor(subject)?.kind === 'heuristic', 'unregistering a measured source restores the heuristic');
}

// --- entries, filtering, chips ----------------------------------------------
const entries: CrateEntry[] = [
  ...BUNDLED.map((entry) => makeCrateEntry('bundled', entry)),
  ...PERSONAL.map((entry) => makeCrateEntry('personal', entry)),
];
{
  const none = { favourites: new Set<string>(), recents: [] as string[] };
  assert(entries[4]!.collection === 'My AVS', 'personal entries default to the My AVS collection');
  assert(makeCrateEntry('local', { id: 'Pack A/sub/x.avs', name: 'x' }).collection === 'Pack A', 'local path-shaped ids infer a pack collection');
  assert(entries[2]!.flash?.flashing === true && entries[4]!.flash?.flashing === true, 'flash flags are attached to entries');
  assert(filterCrate(entries, 'unconed grid', 'all', none).map((e) => e.name).join() === 'UnConeD - Seismogrid', 'search tokens are ANDed');
  assert(filterCrate(entries, 'GRID', 'all', none).length === 2, 'search is case-insensitive');
  assert(filterCrate(entries, 'winamp', 'all', none).length === 2, 'search covers the collection');
  assert(filterCrate(entries, '', 'collection:Community Picks', none).length === 2, 'collection chip filters');
  const prefs = { favourites: new Set([entries[3]!.key]), recents: [entries[1]!.key, entries[0]!.key, 'bundled:gone'] };
  assert(filterCrate(entries, '', CRATE_FILTER_FAVOURITES, prefs).map((e) => e.key).join() === entries[3]!.key, 'favourites chip');
  assert(filterCrate(entries, '', CRATE_FILTER_RECENT, prefs).map((e) => e.key).join() === `${entries[1]!.key},${entries[0]!.key}`,
    'recent chip is most-recent-first and skips missing entries');
  const chips = crateChips(entries, prefs);
  assert(chips[0]!.count === 5 && chips[1]!.count === 1 && chips[2]!.count === 2, 'chip counts');
  assert(chips.some((chip) => chip.filter === 'collection:Winamp 5 Picks' && chip.count === 2), 'per-collection chips exist');
  assert(pickRandomEntry(entries.slice(0, 2), entries[0]!.key, () => 0)?.key === entries[1]!.key, 'random avoids the live entry');
  assert(pickRandomEntry(entries.slice(0, 1), entries[0]!.key, () => 0.99)?.key === entries[0]!.key, 'random with one entry still picks it');
  assert(pickRandomEntry([], null, () => 0) === null, 'random on an empty filter is null');
}

// --- persistence ------------------------------------------------------------
{
  const storage = new MemoryStorage();
  const prefs = new CratePrefs(storage);
  prefs.toggleFavourite('bundled:a');
  for (let i = 0; i < 40; i++) prefs.noteRecent(`bundled:${i}`);
  prefs.noteRecent('bundled:3');
  const reloaded = new CratePrefs(storage);
  assert(reloaded.isFavourite('bundled:a'), 'favourites persist');
  assert(reloaded.recents[0] === 'bundled:3' && reloaded.recents.length === 24, 'recents persist, deduplicated and bounded');
  assert(new Set(reloaded.recents).size === reloaded.recents.length, 'recents have no duplicates');
  const hostile = new CratePrefs(throwingStorage);
  hostile.toggleFavourite('bundled:x');
  hostile.noteRecent('bundled:x');
  assert(hostile.isFavourite('bundled:x'), 'throwing storage degrades to in-memory state');
  storage.map.set('aaavs.crate.v1.favourites', '{not json');
  assert(new CratePrefs(storage).favourites.size === 0, 'corrupt stored JSON is ignored');
}

// --- the live-path invariant ------------------------------------------------
/**
 * Everything except go/commitCue must leave the live output alone. Returns the
 * list of violations so the negative assertion below can prove it can fail.
 */
async function liveInvariantViolations(make: (onGo: (entry: CrateEntry) => void) => CrateController): Promise<string[]> {
  const problems: string[] = [];
  const gone: string[] = [];
  const crate = make((entry) => { gone.push(entry.key); });
  crate.setBank('bundled', BUNDLED);
  crate.setBank('personal', PERSONAL);
  crate.setQuery('unconed');
  crate.setFilter('collection:Community Picks');
  crate.view();
  crate.toggleFavourite(`bundled:${BUNDLED[0]!.id}`);
  crate.cue(`bundled:${BUNDLED[1]!.id}`);
  crate.cueRandom();
  crate.clearCue();
  crate.cue(`bundled:${BUNDLED[1]!.id}`);
  if (gone.length) problems.push(`browsing called onGo ${gone.length} time(s)`);
  if (crate.cued?.id !== BUNDLED[1]!.id) problems.push('cue slot did not hold the cued entry');
  await crate.commitCue();
  if (gone.join() !== `bundled:${BUNDLED[1]!.id}`) problems.push(`commitCue went live with [${gone.join()}]`);
  if (crate.cued !== null) problems.push('cue slot not cleared after it went live');
  if (crate.live?.id !== BUNDLED[1]!.id) problems.push('live marker not updated after go');
  if ((await crate.commitCue()) !== null || gone.length !== 1) problems.push('empty cue commit went live');
  await crate.go(`personal:${PERSONAL[0]!.id}`);
  if (gone.at(-1) !== `personal:${PERSONAL[0]!.id}`) problems.push('go did not route a personal entry');
  if (crate.prefs.recents[0] !== `personal:${PERSONAL[0]!.id}`) problems.push('go did not record a recent');
  return problems;
}

{
  const real = await liveInvariantViolations((onGo) => new CrateController({ storage: new MemoryStorage(), onGo, random: () => 0.5 }));
  assert(real.length === 0, `crate live-path invariant: ${real.join('; ')}`);

  // NEGATIVE: a controller whose cue commits immediately (the old <select>
  // behaviour) must be caught, or this check proves nothing.
  class CommitsOnCue extends CrateController {
    override cue(key: string): CrateEntry | null {
      const entry = super.cue(key);
      if (entry) void this.go(key);
      return entry;
    }
  }
  const sabotaged = await liveInvariantViolations((onGo) => new CommitsOnCue({ storage: new MemoryStorage(), onGo, random: () => 0.5 }));
  assert(sabotaged.some((problem) => problem.startsWith('browsing called onGo')), 'negative: cue-that-commits is detected');

  // A failing host load must not mark the entry live or consume the cue.
  const failing = new CrateController({ storage: new MemoryStorage(), onGo: () => { throw new Error('load failed'); } });
  failing.setBank('bundled', BUNDLED);
  failing.cue(`bundled:${BUNDLED[0]!.id}`);
  let threw = false;
  try { await failing.commitCue(); } catch { threw = true; }
  assert(threw && failing.cued?.id === BUNDLED[0]!.id && failing.live === null, 'a failed go keeps the cue and does not claim live');
}

// --- scale ------------------------------------------------------------------
{
  const local = Array.from({ length: 3_409 }, (_, i) => ({ id: `pack${i % 17}/preset ${i}.avs`, name: `preset ${i} ${i % 5 === 0 ? 'strobe' : 'wave'}` }));
  const crate = new CrateController({ storage: new MemoryStorage(), onGo: () => {} });
  crate.setBank('bundled', BUNDLED);
  crate.setBank('local', local);
  const all = crate.view();
  assert(all.total === 3_413 && all.matched === 3_413, 'all banks are searchable together');
  assert(all.rows.length === CRATE_ROW_CAP, `render is capped at ${CRATE_ROW_CAP} rows`);
  const started = performance.now();
  for (const text of ['p', 'pr', 'pre', 'pres', 'prese', 'preset 1', 'preset 12', 'preset 123', 'wave', 'pack3 strobe']) {
    crate.setQuery(text);
    crate.view();
  }
  const perKeystroke = (performance.now() - started) / 10;
  assert(perKeystroke < 25, `search stays interactive at 3,400 entries (${perKeystroke.toFixed(2)} ms per keystroke)`);
  crate.setQuery('preset 1234');
  assert(crate.view().rows.some((row) => row.name.startsWith('preset 1234 ')), 'search finds a deep local entry');
}

// --- ui.ts wiring (static) --------------------------------------------------
{
  const ui = readFileSync(resolve(import.meta.dirname, '../src/ui.ts'), 'utf8');
  const goStart = ui.indexOf('private async goCrateEntry(');
  const goBody = ui.slice(goStart, ui.indexOf('private ensureLocalCatalog(', goStart));
  assert(goStart >= 0, 'LayerUI has a crate go handler');
  for (const handler of ['opts.onPickAvsPreset(entry.id)', 'opts.onPickLocalAvsPreset(entry.id)', 'opts.onPickPersonalAvsPreset(entry.id)']) {
    assert(goBody.includes(handler), `crate go routes through ${handler}`);
  }
  assert(ui.includes('onGo: (entry) => this.goCrateEntry(entry)'), 'crate go is the only onGo');
  assert(!/rangeField\('[^']+',\s*[^,]+,\s*[\d.]+,\s*[\d.]+/.test(ui), 'no rangeField call hardcodes min/max literals');
  assert(ui.includes('const min = paramMin(descriptor)') && ui.includes('const max = paramMax(descriptor)'), 'rangeField reads bounds from the descriptor');
  const owns = ui.slice(ui.indexOf('private ownsGlobalKey('), ui.indexOf('private ownsGlobalKey(') + 600);
  assert(owns.includes('if (visibleModalOpen()) return false;'), 'global crate keys are refused while a modal dialog is open');
  const main = readFileSync(resolve(import.meta.dirname, '../src/main.ts'), 'utf8');
  const handler = main.slice(main.indexOf("window.addEventListener('keydown'"));
  assert(!/e\.key === 'g'/.test(handler) && !/e\.key === '\/'/.test(handler), 'crate keys g and / are not bound by main.ts');
}

console.log(`crate-check: PASS (${assertions} assertions)`);
