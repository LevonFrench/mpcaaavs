import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Role and driver screening for HUD kit manifests (docs/design/PRESET-TAXONOMY-AND-JEV.md 7, docs/design/HUD-PACK-ENGINE.md Appendix A).
// CPU only and read-only: it never rewrites a manifest, never calls Jev and prints counts. Three layers:
//   1. always: the pure screening functions on synthetic elements (role family versus driver vocabulary, geometry sanity, vocabulary drift);
//   2. Half 2, only when src/hud/hud-manifest.ts exists: (a) the Appendix A prototype kinds all map onto real HUD_KINDS of that module, and (b) the
//      role/driver mapping vectors against tools/hud-taxonomy.mjs (HGEN), which must export `classify(role, driver, observedState)` returning a
//      kind string or { kind }; (b) is skipped cleanly when that module or export is absent;
//   3. only when assets/hud-kits exists (private research kits, read-only): the screening report over every manifest, plus zero unmapped elements
//      when layer 2 ran. Exact counts are never asserted, only bands, so kit growth does not break the check.
// Print the ranked anomaly list with:  node tools/check-hud-manifest-roles.mjs --report
const here = fileURLToPath(new URL('.', import.meta.url));
const visualizer = path.resolve(here, '..');
const REPORT = process.argv.includes('--report');

// ---- pure screening functions -----------------------------------------------------------------------------------------
export const ROLE_KEYS = ['viewport', 'meter', 'gauge', 'health', 'vitality', 'counter', 'score', 'timer', 'countdown', 'radar', 'minimap', 'map', 'crosshair', 'reticle', 'pipper',
  'spectr', 'graph', 'header', 'dock', 'panel', 'bar', 'group', 'banner', 'label', 'glyph', 'grid', 'sidebar', 'selector'];
/** First key contained in the role, else "other" (the family table of JEV 7). */
export const roleFamily = role => { const r = String(role ?? '').toLowerCase(); return ROLE_KEYS.find(k => r.includes(k)) ?? 'other'; };
const STRUCTURAL_FAMILIES = new Set(['header', 'dock', 'panel', 'group', 'banner', 'sidebar']);
const INSTRUMENT_FAMILIES = new Set(['meter', 'gauge', 'counter', 'score', 'timer', 'countdown']);
const SEVERITY = { 'oversize-instrument': 3, 'undersize-viewport': 3, 'viewport-driver': 2, 'panel-driver': 1, 'health-audio-rms': 0.5 };
const area = e => { const r = e?.normalizedRect; return r && Number.isFinite(r.width) && Number.isFinite(r.height) ? r.width * r.height : null; };

/** Screens one kit's elements. Returns anomaly rows; nothing is modified. */
export function screenElements(kit, elements) {
  const rows = [];
  for (const e of Array.isArray(elements) ? elements : []) {
    const role = String(e?.role ?? ''), driver = String(e?.aaavsProposal?.driver ?? ''), family = roleFamily(role), a = area(e);
    const add = type => rows.push({ kit, id: String(e?.id ?? role), role, driver, family, type, weight: SEVERITY[type] });
    if (family === 'viewport') {
      if (!/^background-/.test(driver)) add('viewport-driver');
      if (a !== null && a < 0.2) add('undersize-viewport');
    } else if (STRUCTURAL_FAMILIES.has(family) && !/(dock|anchor)/.test(driver)) add('panel-driver');
    if (INSTRUMENT_FAMILIES.has(family) && a !== null && a > 0.5) add('oversize-instrument');
    if ((family === 'health' || family === 'vitality') && /rms|volume/.test(driver)) add('health-audio-rms');
  }
  return rows;
}
export const rank = rows => [...rows].sort((a, b) => b.weight - a.weight || (a.kit < b.kit ? -1 : a.kit > b.kit ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
/** Role strings that occur once across the library (vocabulary drift). */
export function singletons(allRoles) {
  const counts = new Map(); for (const r of allRoles) counts.set(r, (counts.get(r) ?? 0) + 1);
  return { distinct: counts.size, single: [...counts].filter(([, n]) => n === 1).map(([r]) => r).sort() };
}
/** Reads every kit manifest under `kitsDir`, read-only. Unreadable manifests are counted, not thrown. */
export function readKits(kitsDir) {
  const kits = []; let unreadable = 0;
  for (const name of readdirSync(kitsDir).sort()) {
    const file = path.join(kitsDir, name, 'manifest.json');
    if (!existsSync(file)) continue;
    try { const json = JSON.parse(readFileSync(file, 'utf8')); if (Array.isArray(json?.elements)) kits.push({ name, elements: json.elements }); else unreadable++; } catch { unreadable++; }
  }
  return { kits, unreadable };
}

// ---- 1. pure screening on synthetic data ------------------------------------------------------------------------------------
{
  assert.equal(roleFamily('stage-viewport'), 'viewport'); assert.equal(roleFamily('Player-Vitality-Meter'), 'meter', 'first key in table order wins');
  assert.equal(roleFamily('score-header-panel'), 'score'); assert.equal(roleFamily('mystery-thing'), 'other');
  assert.equal(roleFamily(undefined), 'other'); assert.equal(roleFamily(42), 'other');
  const el = (role, driver, width, height, id = role) => ({ id, role, aaavsProposal: { driver }, normalizedRect: { x: 0, y: 0, width, height } });
  const rows = screenElements('k', [
    el('stage-viewport', 'background-stage', 1, 1),            // fine
    el('arena-viewport', 'bottom-status-dock', 1, 0.9),         // viewport with a dock driver
    el('tiny-viewport', 'background-artwork', 0.3, 0.3),        // undersize (0.09)
    el('top-header-dock', 'top-telemetry-dock', 1, 0.1),        // fine
    el('side-panel-frame', 'tactical-telemetry-driver', 0.2, 1), // panel with a non-dock driver
    el('round-timer', 'track-elapsed-time-clock', 0.9, 0.9),    // oversize instrument
    el('vitality-column', 'audio-rms-volume', 0.1, 0.5),        // health family on an RMS driver (information only)
    { role: 'weird', aaavsProposal: null },                       // tolerated
    null,
  ]);
  assert.deepEqual(rows.map(r => r.type).sort(), ['health-audio-rms', 'oversize-instrument', 'panel-driver', 'undersize-viewport', 'viewport-driver']);
  const ranked = rank([...rows].reverse());
  assert.deepEqual(ranked.map(r => r.weight), [...ranked.map(r => r.weight)].sort((a, b) => b - a), 'ranked worst first');
  assert.deepEqual(rank(rows).map(r => r.id), rank([...rows].reverse()).map(r => r.id), 'ranking is order independent');
  assert.deepEqual(screenElements('k', 'not an array'), []); assert.deepEqual(screenElements('k', []), []);
  const s = singletons(['a', 'b', 'b', 'c']); assert.deepEqual([s.distinct, s.single], [3, ['a', 'c']]);

  // read-only: screening a temporary kit tree leaves every byte and mtime alone, and unreadable manifests are counted
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'aaavs-kits-'));
  try {
    mkdirSync(path.join(tmp, 'good')); mkdirSync(path.join(tmp, 'bad')); mkdirSync(path.join(tmp, 'empty'));
    const good = path.join(tmp, 'good', 'manifest.json'), bad = path.join(tmp, 'bad', 'manifest.json');
    writeFileSync(good, JSON.stringify({ elements: [el('stage-viewport', 'background-stage', 1, 1)] })); writeFileSync(bad, '{ not json');
    const before = [statSync(good).mtimeMs, statSync(bad).mtimeMs, readFileSync(good, 'utf8')];
    const { kits, unreadable } = readKits(tmp);
    assert.deepEqual([kits.length, unreadable], [1, 1]);
    assert.deepEqual([statSync(good).mtimeMs, statSync(bad).mtimeMs, readFileSync(good, 'utf8')], before, 'manifests are not rewritten');
  } finally { rmSync(tmp, { recursive: true, force: true }); }

  // the file itself has no write path outside the temporary self-test tree above
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.equal((self.match(/writeFileSync\(/g) ?? []).length, 2, 'only the temporary self-test writes files');
}

// ---- 2. Appendix A mapping vectors against tools/hud-taxonomy.mjs (Half 2) --------------------------------------------------
/** [role, driver, expected kind]; each row is one cell of the Appendix A table and was checked against the design-run prototype. */
export const APPENDIX_A_VECTORS = [
  ['player-status-gauge', '', 'bar'], ['radar-or-counter', '', 'counter'], ['countdown-timer-boss', '', 'timer'], ['command-selector', '', 'slots'], ['minimap-subweapon', '', 'radar'],
  ['hud-panel-frame', '', 'panel'], ['score-header-panel', '', 'panel'], ['bottom-hud-group', '', 'panel'], ['top-status-header-dock', '', 'panel'], ['ammo-banner', '', 'panel'],
  ['left-sidebar', '', 'panel'], ['ops-console', '', 'panel'], ['vitality-cluster', '', 'panel'],
  ['stage-viewport', 'background-scroll', 'viewport'], ['arena-view', '', 'viewport'], ['main-viewport', 'background-static', 'viewport'],
  ['aiming-reticle', '', 'reticle'], ['crosshair-center', '', 'reticle'], ['pipper-ring', '', 'reticle'], ['lock-on-box', '', 'reticle'],
  ['radar-scope-sweep', '', 'radar'], ['minimap-frame', '', 'radar'], ['motion-tracker', '', 'radar'], ['compass-strip', '', 'radar'],
  ['character-portrait', '', 'portrait'], ['face-status', '', 'portrait'], ['damage-doll', '', 'portrait'],
  ['fluid-globe', '', 'orb'], ['radial-vitality', '', 'orb'], ['speedometer-dial', '', 'dial'], ['rotary-gauge', '', 'dial'],
  ['round-timer', '', 'timer'], ['countdown-clock', '', 'timer'], ['lap-timer', '', 'timer'],
  ['score-counter', '', 'counter'], ['ammo-readout', '', 'counter'], ['credit-digits', '', 'counter'],
  ['equalizer-bars', '', 'spectrum'], ['spectrogram-strip', '', 'spectrum'],
  ['oscilloscope-trace', '', 'scope'], ['ecg-line', '', 'scope'],
  ['glyph-rain-column', '', 'rain'], ['terminal-feed', '', 'terminal'], ['typewriter-log', '', 'terminal'],
  ['weapon-matrix', '', 'matrix'], ['inventory-slots', '', 'slots'], ['lives-hearts', '', 'pips'],
  ['warning-banner-flash', '', 'warning'], ['danger-alert', '', 'warning'], ['blink-cursor', '', 'cursor'],
  ['player-health-bar', '', 'bar'], ['stamina-rail', '', 'vmeter'], ['energy-meter', '', 'bar'], ['shield-gauge', '', 'bar'],
];
const kindOf = result => (typeof result === 'string' ? result : result && typeof result === 'object' ? result.kind : undefined);
/**
 * Appendix A names 22 prototype kinds; the manifest schema (src/hud/hud-manifest.ts HUD_KINDS) folds a few of them: orb is a dial, a vertical meter is a
 * bar with dir btt, a rank readout is a combo, a blink cursor is an fx/label/terminal element. A classifier may answer with the prototype name or
 * with any of the schema kinds listed for it; anything else fails.
 */
export const PROTOTYPE_TO_HUD = Object.freeze({
  panel: ['panel'], viewport: ['viewport'], label: ['label'], bar: ['bar'], vmeter: ['bar'], counter: ['counter'], timer: ['timer'], portrait: ['portrait'],
  reticle: ['reticle'], radar: ['radar'], spectrum: ['spectrum'], scope: ['scope'], rain: ['rain'], terminal: ['terminal'], matrix: ['matrix'], slots: ['slots'],
  pips: ['pips'], warning: ['warning'], dial: ['dial'], orb: ['dial'], rank: ['combo'], cursor: ['fx', 'label', 'terminal'],
});
export const acceptableKinds = expected => new Set([expected, ...(PROTOTYPE_TO_HUD[expected] ?? [])]);
assert.ok(acceptableKinds('orb').has('orb') && acceptableKinds('orb').has('dial') && !acceptableKinds('orb').has('bar'), 'a prototype kind accepts its own name and its schema kind only');
assert.ok(acceptableKinds('vmeter').has('bar') && acceptableKinds('nonsense').size === 1, 'unknown expected kinds accept only themselves');
let classifier = null; let layer2 ='skipped (src/hud/hud-manifest.ts not present: Half 2 has not landed)'; let layer2a = '';
if (existsSync(path.join(visualizer, 'src', 'hud', 'hud-manifest.ts'))) {
  // (a) every prototype kind used by a vector has a mapping, and every mapped target is a real schema kind
  const bundled = await build({ entryPoints: [path.join(visualizer, 'src', 'hud', 'hud-manifest.ts')], bundle: true, format: 'esm', write: false, platform: 'node' });
  const manifest = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
  const hudKinds = new Set(manifest.HUD_KINDS);
  assert.ok(hudKinds.size >= 15, 'HUD_KINDS is exported by hud-manifest.ts');
  for (const [proto, targets] of Object.entries(PROTOTYPE_TO_HUD)) for (const t of targets) assert.ok(hudKinds.has(t), `prototype kind ${proto} maps to a real HUD kind (${t})`);
  for (const [role, , expected] of APPENDIX_A_VECTORS) assert.ok(Object.hasOwn(PROTOTYPE_TO_HUD, expected), `vector ${role} uses a mapped prototype kind (${expected})`);
  const covered = new Set(Object.values(PROTOTYPE_TO_HUD).flat());
  layer2a = `${hudKinds.size} schema kinds, ${[...hudKinds].filter(k => !covered.has(k)).join('/') || 'none'} have no Appendix A pattern`;
  const module = path.join(here, 'hud-taxonomy.mjs');
  if (!existsSync(module)) layer2 = 'skipped (tools/hud-taxonomy.mjs not present)';
  else {
    const exported = await import(pathToFileURL(module).href);
    if (typeof exported.classify !== 'function') layer2 = 'skipped (tools/hud-taxonomy.mjs exports no classify(role, driver, observedState))';
    else {
      classifier = (role, driver = '', observed = '') => kindOf(exported.classify(role, driver, observed));
      for (const [role, driver, expected] of APPENDIX_A_VECTORS) {
        const got = classifier(role, driver);
        assert.ok(acceptableKinds(expected).has(got), `Appendix A: ${role} -> expected ${expected} (or ${(PROTOTYPE_TO_HUD[expected] ?? []).join('/')}), got ${got}`);
      }
      // roles that match nothing are reported as unmapped rather than guessed
      const nothing = classifier('zzqx-widget', 'zzqx-driver', 'zzqx');
      assert.ok(nothing === undefined || nothing === null || ['unknown', 'other', 'unmapped'].includes(nothing), `an unmatched role is unmapped (${nothing})`);
      layer2 = `PASS (${APPENDIX_A_VECTORS.length} vectors)`;
    }
  }
}

// ---- 3. the kit library, read-only ------------------------------------------------------------------------------------------
let layer3 = 'skipped (assets/hud-kits not present)';
const kitsDir = path.join(visualizer, 'assets', 'hud-kits');
if (existsSync(kitsDir)) {
  const { kits, unreadable } = readKits(kitsDir);
  if (kits.length === 0) layer3 = 'skipped (no readable kit manifests)';
  else {
    const all = kits.flatMap(k => k.elements.map(e => ({ kit: k.name, e })));
    const rows = rank(kits.flatMap(k => screenElements(k.name, k.elements)));
    const { distinct, single } = singletons(all.map(x => String(x.e?.role ?? '')));
    const viewports = all.filter(x => roleFamily(x.e?.role) === 'viewport');
    const background = viewports.filter(x => /^background-/.test(String(x.e?.aaavsProposal?.driver ?? '')));
    assert.ok(all.length >= 100, 'enough elements to judge bands');
    if (viewports.length >= 20) assert.ok(background.length / viewports.length >= 0.9, `viewport roles map to background drivers (${background.length}/${viewports.length})`);
    assert.ok(rows.filter(r => r.weight >= 3).length <= Math.max(25, all.length * 0.02), 'geometry anomalies stay a small tail');
    if (classifier) {
      const unmapped = all.filter(x => { const k = classifier(x.e?.role ?? '', x.e?.aaavsProposal?.driver ?? '', x.e?.observedState ?? ''); return !k || ['unknown', 'other', 'unmapped'].includes(k); });
      assert.equal(unmapped.length, 0, `unmapped roles must be added to the rules or the decisions file: ${[...new Set(unmapped.map(x => x.e?.role))].slice(0, 10).join(', ')}`);
    }
    const byType = {}; for (const r of rows) byType[r.type] = (byType[r.type] ?? 0) + 1;
    layer3 = `${kits.length} kits, ${all.length} elements, ${distinct} distinct roles (${single.length} singletons), anomalies ${JSON.stringify(byType)}, ${unreadable} unreadable`;
    if (REPORT) {
      console.log(`Top anomalies (${rows.length} total, information only):`);
      for (const r of rows.slice(0, 40)) console.log(`  ${r.weight.toFixed(1)} ${r.type.padEnd(20)} ${r.kit} :: ${r.role} -> ${r.driver}`);
      const drift = single.filter(r => roleFamily(r) === 'other');
      console.log(`Vocabulary drift: ${single.length} singleton roles, ${drift.length} with no role family (first 40):`);
      for (const r of drift.slice(0, 40)) console.log(`  ${r}`);
    }
  }
}
console.log(`HUD manifest roles: pure screening PASS; kind mapping ${layer2a || 'skipped'}; Appendix A vectors ${layer2}; kit screening ${layer3}.`);
