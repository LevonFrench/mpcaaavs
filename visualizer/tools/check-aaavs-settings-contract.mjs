import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
// Static contract test for the settings vocabulary that the page, the Player and the native player must share (docs/design/CONTRACT.md 2.5 and 2.6.1).
// It reads source text only: nothing is compiled, launched or bundled except small pure modules. Sections skip cleanly when their files are absent, so the same
// file runs in a stock AAAVS checkout (no native sources, no MPC-HC page) and in the MPC-HC-AAAVS fork.
async function load(path) { const r = await build({ entryPoints: [path], bundle: true, format: 'esm', write: false }); return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`); }
const read = path => existsSync(path) ? readFileSync(path, 'utf8') : null;
const C = await load('src/mpc-contract.ts');
const { configureSettings, defaultSettings } = await load('src/mpc-setups.ts');
const cpp = read('../src/mpc-hc/AAAVSView.cpp'), names = read('../src/mpc-hc/AAAVSTransitionNames.h');
const library = read('tools/standalone-library.mjs'), player = read('src/standalone-player.ts'), host = read(process.env.AAAVS_HOST_ENTRY || 'src/mpc-host.ts');   // AAAVS_HOST_ENTRY: a scratch copy of the host, for a wiring rehearsal
const pages = { 'standalone.html': read('standalone.html'), 'mpc.html': read('mpc.html') };
const ran = [];
const section = (name, text, body) => { if (text === null || text === undefined) return; body(text); ran.push(name); };

// The contract's ranges, spelled once from mpc-contract.ts.
const RANGES = { fadeTiming: [0, C.FADE_TIMING_COUNT - 1], fadeRandomSet: [C.FADE_RANDOM_SET_MIN, C.FADE_RANDOM_SET_ALL], fadeAnchor: [0, C.FADE_ANCHOR_COUNT - 1], queueQuantize: [0, C.QUEUE_QUANTIZE_COUNT - 1],
  showFps: [0, C.SHOW_FPS_COUNT - 1], timingOverlay: [0, C.TIMING_OVERLAY_COUNT - 1], quality: [0, C.QUALITY_COUNT - 1], avsResolution: [0, C.AVS_RESOLUTION_COUNT - 1], pixelArt: [0, C.PIXEL_ART_COUNT - 1] };
const FADE_KEYS = ['fadeTiming', 'fadeRandomSet', 'fadeAnchor', 'queueQuantize'], DISPLAY_KEYS = ['quality', 'avsResolution', 'pixelArt', 'showFps', 'timingOverlay'];
const SETTINGS_KEY_ORDER = ['type', 'enabled', 'bars', 'transition', 'beats', 'shuffle', 'minimumRating', 'manualFade', 'autoFade', 'durationMs', 'keepOld', ...FADE_KEYS, 'showFps', 'timingOverlay', 'quality', 'avsResolution', 'pixelArt'];
const pascal = key => key[0].toUpperCase() + key.slice(1);
const between = (text, from, to, label) => { const a = text.indexOf(from); assert.ok(a >= 0, `${label}: start marker ${from}`); const b = text.indexOf(to, a + from.length); assert.ok(b > a, `${label}: end marker ${to}`); return text.slice(a, b); };
const sameSet = (a, b, message) => assert.deepEqual([...new Set(a)].sort(), [...new Set(b)].sort(), message);

// ---- The contract module's own projection tables ----
{
  assert.deepEqual([...C.LEGACY_BEATS], [0, 1, 2, 4]);
  assert.deepEqual(C.BEATS_FROM_FADE, [0, 0, 1, 2, 4, 0, 0]);
  assert.deepEqual(C.FADE_FROM_BEATS, { 0: 0, 1: 2, 2: 3, 4: 4 });
  for (const beats of C.LEGACY_BEATS) assert.equal(C.BEATS_FROM_FADE[C.FADE_FROM_BEATS[beats]], beats, `beats ${beats} survives the round trip`);
  assert.equal(C.BEATS_FROM_FADE.length, C.FADE_TIMING_COUNT);
  ran.push('contract tables');
}

// ---- Native player: projection, settings message, registry, configure, display string, menu identifiers ----
section('native', cpp, source => {
  // The two projection functions are ternary chains that are also valid JavaScript expressions: evaluate them and compare with the tables.
  const expression = (name, argument) => { const m = new RegExp(`static int ${name}\\(int ${argument}\\)\\s*\\{\\s*return ([^;]+);\\s*\\}`).exec(source); assert.ok(m, `${name} exists`); assert.match(m[1], /^[\s\w?:=<>!&|()+-]+$/, `${name} is a plain expression`); return new Function(argument, `return ${m[1]};`); };
  const fadeFromBeats = expression('FadeFromBeats', 'b'), beatsFromFade = expression('BeatsFromFade', 'f');
  for (const b of [-1, 0, 1, 2, 3, 4, 5, 8, 64]) assert.equal(fadeFromBeats(b), C.LEGACY_BEATS.includes(b) ? C.FADE_FROM_BEATS[b] : 0, `FadeFromBeats(${b})`);
  for (let f = -1; f <= 8; f++) assert.equal(beatsFromFade(f), f >= 0 && f < C.FADE_TIMING_COUNT ? C.BEATS_FROM_FADE[f] : 0, `BeatsFromFade(${f})`);

  // Settings(): the flat JSON keys in the documented order.
  const settings = between(source, 'void Settings() {', 'PostWebMessageAsJson', 'Settings()');
  const keys = [...settings.matchAll(/\\"(\w+)\\":/g)].map(m => m[1]);
  assert.deepEqual(keys, SETTINGS_KEY_ORDER, 'Settings() key order (contract 2.5.2)');

  // Preferences(): registry names, clamps and the write-back projection.
  const preferences = between(source, 'void Preferences(bool save) {', 'preferencesLoaded = true;', 'Preferences()');
  const registry = [...preferences.matchAll(/value\(L"(\w+)"/g)].map(m => m[1]);
  sameSet(registry, ['Auto', 'Shuffle', 'MinimumRating', 'KeepOld', 'ManualFade', 'AutoFade', 'Bars', 'Transition', 'Beats', 'DurationMs', ...FADE_KEYS.map(pascal), ...DISPLAY_KEYS.map(pascal)], 'registry values (contract 2.5.1)');
  for (const key of [...FADE_KEYS, ...DISPLAY_KEYS]) assert.ok(registry.includes(pascal(key)), `${key} persists as ${pascal(key)}`);
  const clamps = new Map([...preferences.matchAll(/std::clamp\(value\(L"(\w+)", \w+\), (\d+), (\d+)\)/g)].map(m => [m[1], [Number(m[2]), Number(m[3])]]));
  for (const key of ['fadeRandomSet', 'fadeAnchor', 'queueQuantize', ...DISPLAY_KEYS]) assert.deepEqual(clamps.get(pascal(key)), RANGES[key], `${pascal(key)} clamp`);
  assert.deepEqual(clamps.get('MinimumRating'), [0, 5]);
  assert.match(preferences, new RegExp(`fadeTiming > ${C.FADE_TIMING_COUNT - 1}`), 'FadeTiming range 0..6');
  assert.match(preferences, /beats = BeatsFromFade\(fadeTiming\);[^\n]*\n\s*$/, '`beats` is always the projection of fadeTiming on the way out');
  assert.match(preferences, /if \(!save && \(fadeTiming < 0 \|\| fadeTiming > \d+\)\) fadeTiming = FadeFromBeats\(beats\)/, 'a first run after upgrade derives fadeTiming from Beats');
  assert.match(source, /int fadeTiming = -1, fadeRandomSet = 31, fadeAnchor = 0, queueQuantize = 0;/, 'defaults (contract 2.5.1)');
  assert.match(source, /int showFps = 1, timingOverlay = 0, quality = 0, avsResolution = 0, pixelArt = 0;/, 'display defaults');
  assert.match(preferences, /durationMs < 250 \|\| durationMs > 8000/, 'DurationMs 250..8000 (C-05)');

  // configure: which keys it reads, their ranges, and that display preferences never travel through it (C-13, C-14).
  const configure = between(source, 'op == "configure"', 'Settings(); return;', 'configure');
  const configureKeys = [...configure.matchAll(/(?:integer|boolean|member)\("(\w+)"/g), ...configure.matchAll(/HasMember\("(\w+)"\)/g)].map(m => m[1]).filter(key => key !== 'settings');   // `settings` is the request envelope, not a field
  sameSet(configureKeys, Object.keys(configureSettings(defaultSettings)), 'configure reads exactly the keys the page sends');
  for (const key of DISPLAY_KEYS) assert.ok(!new RegExp(`"${key}"`).test(configure), `configure never reads ${key}`);
  const members = new Map([...configure.matchAll(/member\("(\w+)", (\d+), (\d+),/g)].map(m => [m[1], [Number(m[2]), Number(m[3])]]));
  for (const key of ['fadeRandomSet', 'fadeAnchor', 'queueQuantize']) assert.deepEqual(members.get(key), RANGES[key], `configure ${key}`);
  assert.match(configure, new RegExp(`v\\["fadeTiming"\\]\\.GetInt\\(\\) >= 0 && v\\["fadeTiming"\\]\\.GetInt\\(\\) <= ${C.FADE_TIMING_COUNT - 1}`), 'configure fadeTiming range');
  assert.match(configure, /else if \(v\.HasMember\("beats"\)[^)]*\)[^\n]*fadeTiming = FadeFromBeats/, 'a request with beats and no fadeTiming derives it');
  assert.match(configure, /beats = BeatsFromFade\(fadeTiming\)/, 'beats is re-derived from fadeTiming');
  assert.match(configure, /durationMs = std::clamp\(integer\("durationMs",2000\),250,8000\)/, 'configure durationMs 250..8000');
  assert.match(configure, /transition = std::clamp\(integer\("transition",1\),0,(kTransitionCount - 1|32)\)/, 'configure transition range');

  // The page-to-native display string: each key clamped to its own range.
  const display = between(source, 'void Display(', 'ULONGLONG sent', 'Display()');
  const applied = new Map([...display.matchAll(/apply\("(\w+)", \w+, (\d+)\)/g)].map(m => [m[1], [0, Number(m[2])]]));
  sameSet([...applied.keys()], DISPLAY_KEYS, 'display: keys');
  for (const key of DISPLAY_KEYS) assert.deepEqual(applied.get(key), RANGES[key], `display: ${key}`);

  // Menu identifiers (CONTRACT 2.5.4): one allocation, no overlap, every item handled, retired and reserved ranges unused.
  const menu = between(source, 'void AAAVSView::Options() {', 'if (choice) st.Settings();', 'Options()');
  const count = names ? Number(/constexpr int kTransitionCount = (\d+);/.exec(names)?.[1]) : C.TRANSITION_COUNT;
  assert.ok(Number.isInteger(count) && count <= 100, 'kTransitionCount fits the 100..199 block');
  const constants = { kTransitionMenuBase: 100, kTransitionCount: count };
  const value = text => { const parts = text.split('+').map(p => p.trim()); return parts.reduce((sum, p) => sum + (p in constants ? constants[p] : Number(p)), 0); };
  const ids = [];
  let bound = null;   // the bound of the most recent `for (int i = 0; i < N; ++i)`, which governs the `base + i` item that follows it
  for (const line of menu.split('\n')) {
    const loop = /for \(int i = 0; i < ([\w ]+); \+\+i\)/.exec(line);
    if (loop) bound = loop[1].trim();
    const m = /AppendMenuW\(\w+, ([^,]+), ([^,]+),/.exec(line);
    if (!m || !/MF_STRING/.test(m[1])) continue;
    if (/\+\s*i\s*$/.test(m[2])) { assert.ok(bound, `an indexed item needs a loop: ${m[2]}`); const base = value(m[2].replace(/\s*\+\s*i\s*$/, '')), n = value(bound); for (let i = 0; i < n; i++) ids.push(base + i); }
    else { assert.match(m[2].trim(), /^\d+$/, `a single item has a numeric identifier: ${m[2]}`); ids.push(Number(m[2])); }
  }
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const allocation = [...range(1, 5), ...range(50, 55), ...range(56, 59), ...range(60, 65), ...range(70, 75), ...range(80, 86), ...range(90, 94), ...range(95, 97), ...range(100, 100 + count - 1), ...range(200, 204), ...range(210, 212), ...range(220, 222)];
  assert.equal(new Set(ids).size, ids.length, `menu identifiers overlap: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`);
  assert.deepEqual([...ids].sort((a, b) => a - b), allocation, 'the menu matches the 2.5.4 allocation exactly');
  assert.ok(ids.every(id => !(id >= 20 && id <= 35) && !(id >= 40 && id <= 43) && !(id >= 300 && id <= 399)), 'retired (20-35, 40-43) and reserved (300-399) identifiers stay unused');
  const handled = new Set();
  for (const m of menu.matchAll(/choice >= (\d+) && choice (<=|<) ([\w +]+?)\)/g)) { const high = value(m[3]) - (m[2] === '<' ? 1 : 0); for (const id of range(Number(m[1]), high)) handled.add(id); }
  for (const m of menu.matchAll(/choice == (\d+)/g)) handled.add(Number(m[1]));
  sameSet([...handled], ids, 'every menu item has a handler and every handler has an item');
  // The specific meanings the contract fixes.
  assert.match(menu, /choice >= 80 && choice <= 86\) \{ st\.fadeTiming = int\(choice\) - 80; st\.beats = BeatsFromFade\(st\.fadeTiming\); \}/, '80-86 select the timing and its beats projection');
  assert.match(menu, /choice >= 60 && choice <= 65\) \{ st\.fadeTiming = 0; st\.beats = 0; st\.durationMs = /, '60-65 are fixed seconds and select the Seconds timing');
  assert.match(menu, /choice >= 90 && choice <= 94\)[^\n]*never clear the last bit|choice >= 90 && choice <= 94\)[^\n]*& 31/, '90-94 never clear the last Random member');
  assert.match(menu, /choice >= 95 && choice <= 97\) st\.fadeAnchor = int\(choice\) - 95/);
  assert.match(menu, /choice >= 56 && choice <= 59\) st\.queueQuantize = int\(choice\) - 56/);
  // Stored ranges and menu IDs remain available for round trips, but unsupported scheduling must not be selectable.
  for (const [submenu, key, length] of [['anchors', 'fadeAnchor', C.FADE_ANCHOR_COUNT], ['queues', 'queueQuantize', C.QUEUE_QUANTIZE_COUNT]]) {
    const flags = new RegExp(`AppendMenuW\\(${submenu}, ([^,]+),`).exec(menu)?.[1];
    assert.ok(flags, `${submenu}: menu flags exist`);
    assert.match(flags, /^[\s\w.?:=<>!&|()+-]+$/, `${submenu}: flags are a plain expression`);
    const evaluate = new Function('i', 'st', 'MF_STRING', 'MF_CHECKED', 'MF_GRAYED', `return ${flags};`);
    for (let stored = 0; stored < length; stored++) for (let i = 0; i < length; i++) {
      const actual = evaluate(i, { [key]: stored }, 0, 8, 1);
      assert.equal(Boolean(actual & 1), i > 0, `${submenu}: only option 0 enabled, including stored ${stored}`);
      assert.equal(Boolean(actual & 8), i === stored, `${submenu}: stored ${stored} stays checked without normalization`);
    }
  }
  assert.match(menu, /choice == 54\) st\.showFps = \(st\.showFps \+ 1\) % 3/, '54 cycles off, fps, detail');
  assert.match(menu, /choice == 55\) st\.timingOverlay = st\.timingOverlay \? 0 : 1/);
  assert.match(menu, /choice >= 200 && choice <= 204\) st\.quality/);assert.match(menu, /choice >= 210 && choice <= 212\) st\.avsResolution/);assert.match(menu, /choice >= 220 && choice <= 222\) st\.pixelArt/);
});

// ---- Player server: the optional fade fields and their ranges ----
section('player server', library, source => {
  const list = /const FADE_FIELDS = (\[[^;]*\]);/.exec(source);
  assert.ok(list, 'FADE_FIELDS');
  const fields = new Map(JSON.parse(list[1].replace(/'/g, '"')).map(([key, low, high]) => [key, [low, high]]));
  sameSet([...fields.keys()], FADE_KEYS);
  for (const key of FADE_KEYS) assert.deepEqual(fields.get(key), RANGES[key], `server ${key}`);
  assert.match(source, /value\.transition <= 32/, 'the server accepts transition 0..32');
  assert.match(source, /value\.durationMs >= 250 && value\.durationMs <= 8000/, 'the server clamps durationMs to 250..8000');
  assert.match(source, /const defaults = \{ enabled:true, bars:0, shuffle:false, minimumRating:0, transition:1, beats:0, durationMs:2000, keepOld:true, manualFade:true, autoFade:true \};/, 'defaults are unchanged, so an old settings.json loads identically');
});

// ---- Player page: fields, elements and their option values ----
section('player page', player, source => {
  const fields = /const settingsFields=\[([^\]]*)\]/.exec(source);
  assert.ok(fields, 'settingsFields');
  const list = [...fields[1].matchAll(/'(\w+)'/g)].map(m => m[1]);
  for (const key of ['fadeTiming', 'fadeAnchor', 'queueQuantize', 'durationMs']) assert.ok(list.includes(key), `settingsFields carries ${key}`);
  assert.ok(!list.includes('beats'), 'beats is not bound any more: fadeTiming replaces it');
  for (const key of DISPLAY_KEYS) assert.ok(!list.includes(key), `${key} is a display preference, never a configure field`);
  const displayKeys = /const DISPLAY_KEYS=\[([^\]]*)\]/.exec(source);
  assert.ok(displayKeys, 'DISPLAY_KEYS');
  assert.deepEqual([...displayKeys[1].matchAll(/'(\w+)'/g)].map(m => m[1]), DISPLAY_KEYS);
  assert.match(source, /for\(let bit=0;bit<5;bit\+\+\)[^\n]*setting-fadeSet\$\{bit\}/, 'the Random mask binds bits 0-4');
});
section('player elements', pages['standalone.html'], html => {
  const options = id => { const m = new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`).exec(html); assert.ok(m, `select ${id}`); return [...m[1].matchAll(/<option value="(-?\d+)"/g)].map(o => Number(o[1])); };
  const range = ([low, high]) => Array.from({ length: high - low + 1 }, (_, i) => low + i);
  for (const key of ['fadeTiming', 'fadeAnchor', 'queueQuantize', ...DISPLAY_KEYS]) assert.deepEqual(options(`setting-${key}`), range(RANGES[key]), `setting-${key} offers exactly the stored range`);
  for (let bit = 0; bit < 5; bit++) assert.match(html, new RegExp(`<input id="setting-fadeSet${bit}" type="checkbox"`), `setting-fadeSet${bit}`);
  assert.match(html, /<input id="setting-durationMs" type="number" min="250" max="8000"/, 'the Seconds length is limited to 250..8000');
});

// ---- The timing overlay style (TIMING-SYSTEM-V2.md 3.2, 3.4) in both pages ----
for (const [name, html] of Object.entries(pages)) section(`${name} #timing`, html, source => {
  const rules = [...source.matchAll(/#timing\s*\{([^}]*)\}/g)].map(m => m[1].replace(/\s+/g, ''));
  assert.ok(rules.length, `${name} styles #timing`);
  assert.ok(rules.some(r => r.includes('font-variant-numeric:tabular-nums')), `${name}: #timing uses tabular numerals so the FPS text does not jitter`);
  assert.ok(rules.some(r => r.includes('white-space:nowrap')), `${name}: #timing does not wrap`);
  assert.match(source.replace(/\s+/g, ''), /body\.timing-always#timing\{opacity:1\}/, `${name}: body.timing-always shows the overlay`);
});

// ---- What the page must accept from the native message, checked by behaviour ----
{
  const { parseFadeFields } = await load('src/mpc-transition-timing.ts');
  const message = { type: 'settings', enabled: true, bars: 0, transition: 1, beats: 0, shuffle: false, minimumRating: 0, manualFade: true, autoFade: true, durationMs: 1500, keepOld: true, fadeTiming: 6, fadeRandomSet: 22, fadeAnchor: 2, queueQuantize: 3 };
  assert.deepEqual(parseFadeFields(message), { timing: 6, randomSet: 22, anchor: 2, fixedMs: 1500 }, 'the fade fields of a native settings message');
  assert.deepEqual(parseFadeFields({ ...message, fadeTiming: undefined, beats: 4 }), { timing: 4, randomSet: 22, anchor: 2, fixedMs: 1500 }, 'an old native message (beats only) still maps');
  const display = existsSync('src/mpc-display.ts') ? await load('src/mpc-display.ts') : null;
  if (display) {
    const prefs = display.parseDisplayPrefs({ quality: 3, avsResolution: 1, pixelArt: 2, showFps: 2, timingOverlay: 1 });
    assert.deepEqual([prefs.quality, prefs.avsResolution, prefs.pixelArt, prefs.showFps, prefs.timingOverlay], ['high', 'crisp', 'smooth', 2, 1], 'the five display keys of a native settings message');
    assert.deepEqual(display.prefsToWire(prefs), { quality: 3, avsResolution: 1, pixelArt: 2, showFps: 2, timingOverlay: 1 }, 'and they go back out as wire integers');
    const kept = display.parseDisplayPrefs({ quality: 99, showFps: -1 }, prefs);assert.deepEqual([kept.quality, kept.showFps], ['high', 2], 'an invalid key keeps the current value');
    assert.deepEqual(display.parseDisplayPrefs({}, prefs), prefs, 'an old native message changes nothing');
  }
  ran.push('behaviour');
}

// ---- Host wiring (INT1 applies the TIM column of CONTRACT Appendix A; this fails until it has) ----
section('host wiring', host, source => {
  assert.match(source, /parseFadeFields\(/, 'mpc-host.ts reads the fade fields of a settings message through parseFadeFields');
  assert.match(source, /queueQuantize/, 'mpc-host.ts accepts queueQuantize');
  assert.match(source, /showFps/, 'mpc-host.ts reads showFps');
  assert.match(source, /timingLabel\(/, 'mpc-host.ts writes the overlay text through timingLabel');
  assert.match(source, /configureSettings\(/, 'activation always sends a complete configure (C-13)');
  assert.ok(!/durationBeats/.test(source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), 'durationBeats is gone from the code: fadeSpec replaces it');
});

assert.ok(ran.includes('contract tables') && ran.includes('behaviour'));
console.log(`Settings contract: ${ran.join(', ')} PASS${cpp === null ? ' (native sources absent: native sections skipped)' : ''}`);
