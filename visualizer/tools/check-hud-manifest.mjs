import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as F from './fixtures-hud.mjs';
import { collectRefs, resolvePointer } from './print-hud-schema.mjs';
// CPU-only check of the `mpcaaavs-hud` v1 manifest (docs/design/HUD-PACK-ENGINE.md section 4, docs/design/CONTRACT.md 2.3.9): src/hud/hud-manifest.ts (strict
// data-only parser, 21 kinds, signal registry, time references, canonical serializer, IP-safety lint, JSON Schema), src/hud-preset.ts (bytes to manifest, the
// `.hud` identity) and tools/print-hud-schema.mjs. Every input is a synthetic fixture (tools/fixtures-hud.mjs). It also runs over a local generated tree
// (visualizer/hud-presets/**/*.hud) when one exists and skips that part cleanly when it does not (the tree is git-ignored, contract C-28).
// No browser, GPU, audio or engine: nothing here draws a pixel.
const root = fileURLToPath(new URL('..', import.meta.url));
async function load(entry) {
  const r = await build({ entryPoints: [path.join(root, entry)], bundle: true, format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);
}
const M = await load('src/hud/hud-manifest.ts');
const P = await load('src/hud-preset.ts');
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); checks++; };
const BS = String.fromCharCode(92), DOT = String.fromCharCode(0xb7);
const rng = seed => { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const clone = v => structuredClone(v);
const errorsOf = r => r.issues.filter(i => i.level === 'error');
const under = (issuePath, want) => issuePath === want || issuePath.startsWith(`${want}.`) || issuePath.startsWith(`${want}[`);
const run = (m, options) => M.checkHudManifest(clone(m), options);
/** Assert `m` is accepted; returns the result. */
function valid(m, note, options) {
  const r = run(m, options);
  assert.ok(r.manifest, `${note}: expected valid, got ${JSON.stringify(errorsOf(r).slice(0, 3))}`);
  assert.equal(errorsOf(r).length, 0, note);
  checks++;
  return r;
}
/** Assert `m` is rejected with an error at (or under) `where` (a path) and, when given, whose text matches `text`. */
function rejects(m, where, note, text, options) {
  const r = run(m, options);
  assert.equal(r.manifest, null, `${note}: expected a rejection`);
  const errs = errorsOf(r);
  assert.ok(errs.length > 0, `${note}: a rejection must carry an error issue`);
  if (where !== undefined) assert.ok(errs.some(i => under(i.path, where) && (!text || text.test(i.message))), `${note}: wanted an error at ${where || '(root)'}${text ? ` matching ${text}` : ''}, got ${JSON.stringify(errs.slice(0, 4))}`);
  checks++;
  return r;
}
const KINDS = F.KIND_NAMES;
const idx = kind => KINDS.indexOf(kind);
const allKinds = () => F.allKindsManifest();
const freeze = v => { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) freeze(x); } return v; };
const isDeepFrozen = v => !(v && typeof v === 'object') || (Object.isFrozen(v) && Object.values(v).every(isDeepFrozen));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
/** Strings that look like words, never like an encoded run: `n` characters. */
const words = n => 'AB CD '.repeat(Math.ceil(n / 6)).slice(0, n).trimEnd().padEnd(n, 'E').replace(/ E$/, ' F');

// ------------------------------------------------------------------------------------------------ constants and tables
{
  eq([M.HUD_FORMAT, M.HUD_VERSION], ['mpcaaavs-hud', 1], 'format and version');
  eq({ ...M.HUD_LIMITS }, { bytes: 32768, layers: 96, events: 8, intervals: 8, cues: 8, lines: 24, lineChars: 48, chars: 48, tags: 8, tagChars: 24, behaviours: 6, canvasMin: 64, canvasMax: 1920, freeBars: 32, issues: 64 }, 'limits (HUD section 4.1)');
  eq([{ ...M.HUD_BUDGET.soft }, { ...M.HUD_BUDGET.hard }], [{ draws: 400, segments: 2000, texts: 40, gradients: 8, overdraw: 4 }, { draws: 900, segments: 5000, texts: 96, gradients: 24, overdraw: 8 }], 'budgets (HUD section 5.5)');
  eq({ ...M.HUD_DEFAULTS }, { freeBars: 8, attentionCapacity: 4, attentionRefill: 2.5, cueHold: 1 }, 'defaults');
  eq({ ...M.HUD_ATTENTION_COST }, { banner: 3, warning: 2, lock: 1 }, 'attention costs (HUD section 5.4)');
  ok(Object.isFrozen(M.HUD_LIMITS) && Object.isFrozen(M.HUD_BUDGET) && Object.isFrozen(M.HUD_BUDGET.hard) && Object.isFrozen(M.HUD_DEFAULTS), 'tables are frozen');
  eq([...M.HUD_KINDS], KINDS, 'the fixture list and HUD_KINDS agree (a silent table edit fails here)');
  eq(M.HUD_KINDS.length, 21, 'twenty-one instrument kinds');
  eq(Object.keys(M.KIND_SPECS), [...M.HUD_KINDS], 'one spec per kind, in table order');
  eq([...M.HUD_PALETTE_KEYS], ['ink', 'paper', 'shade', 'hi', 'a1', 'a2', 'ok', 'warn', 'bad'], 'nine palette keys');
  eq([...M.HUD_PALETTE_REQUIRED], ['ink', 'paper', 'a1', 'a2', 'ok', 'warn', 'bad'], 'seven required palette keys');
  eq([...M.HUD_TIERS], ['showcase', 'tuned', 'auto'], 'tiers (owner directive A)');
  eq([...M.HUD_ORIGINS], ['kit', 'image', 'template'], 'layout origins (owner directive A)');
  eq([...M.HUD_CUE_STYLES], ['pop', 'slide', 'flash', 'type'], 'cue styles');
  eq([...M.HUD_EVENT_UNITS], ['beat', 'bar', 'half-bar'], 'event units');
  // the design's own enumerations are a subset of the shipped ones (extensions only add values)
  const design = {
    families: ['fighting', 'shmup', 'platformer', 'brawler', 'racing', 'sports', 'puzzle', 'rpg', 'rts', 'fps', 'adventure', 'flight', 'cockpit', 'terminal', 'scifi', 'misc'],
    eras: ['8bit', '16bit', 'arcade', '32bit', '128bit', 'pc-classic', 'pc-modern', 'cinema', 'anime', 'fui'],
    behaviours: ['ghost', 'damageFlicker', 'dangerPulse', 'refill', 'capFlash', 'tick', 'urgent', 'zeroHold', 'look', 'hurt', 'grin', 'dead', 'blink', 'sweep', 'blip', 'drift', 'lock', 'pulse', 'stripes', 'chase', 'levels', 'vote', 'select', 'peakHold', 'trace', 'ecgBeat', 'type', 'scroll', 'fall', 'burst', 'pop', 'slide', 'flash', 'window', 'scanlines', 'vignette', 'grain', 'shake', 'glow'],
  };
  ok(design.families.every(f => M.HUD_FAMILIES.includes(f)) && design.eras.every(e => M.HUD_ERAS.includes(e)), 'design families and eras are all accepted');
  eq([...M.HUD_BEHAVIOURS], design.behaviours, 'behaviour vocabulary is exactly the design list');
  ok(new Set(M.HUD_FAMILIES).size === M.HUD_FAMILIES.length && new Set(M.HUD_ERAS).size === M.HUD_ERAS.length && new Set(M.HUD_BEHAVIOURS).size === M.HUD_BEHAVIOURS.length, 'no duplicate table entries');
  // a table entry must be usable everywhere it is spelled: a slug-like word
  for (const w of [...M.HUD_FAMILIES, ...M.HUD_ERAS]) ok(/^[a-z0-9-]{2,24}$/.test(w), `table word ${w}`);
  for (const name of ['checkHudManifest', 'parseHudManifest', 'serializeHudManifest', 'hudManifestBytes', 'hudJsonSchema', 'parseTimeRef', 'parseHudSignal', 'resolvePalette', 'contrastRatio',
    'relativeLuminance', 'hexToRgb', 'isAuthoritative', 'estimateHudCost', 'peakAttention', 'referenceRefSeconds', 'hudWords', 'hudNgrams', 'hudScannedStrings', 'hudDenyHook', 'hudDenyEntry']) {
    ok(typeof M[name] === 'function', `export ${name}`);
  }
  for (const name of ['parseHudPreset', 'tryParseHudPreset', 'hudPresetBytes', 'hudCatalogMeta', 'isHudFileName', 'jsonHasDuplicateKeys', 'isCanonicalHudPreset', 'hudPresetSha256']) ok(typeof P[name] === 'function', `export ${name}`);
  eq([P.HUD_EXTENSION, P.HUD_MAX_BYTES], ['.hud', 32768], 'the .hud identity and size cap');
}

// ------------------------------------------------------------------------------------------------ minimal JSON Schema validator (the subset the generator emits)
const schema = M.hudJsonSchema();
const deepEqual = (a, b) => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return Object.is(a, b);
  try { assert.deepStrictEqual(a, b); return true; } catch { return false; }
};
const regexes = new Map();
const regex = source => { let re = regexes.get(source); if (!re) { re = new RegExp(source); regexes.set(source, re); } return re; };
function validateSchema(node, value, at = '#') {
  const errs = [];
  const fail = message => errs.push(`${at}: ${message}`);
  if (node.$ref !== undefined) {
    const target = resolvePointer(schema, node.$ref);
    return target === undefined ? [`${at}: unresolved ${node.$ref}`] : validateSchema(target, value, at);
  }
  if ('const' in node && !deepEqual(value, node.const)) fail('const');
  if (node.enum && !node.enum.some(x => deepEqual(x, value))) fail('enum');
  if (node.type) {
    const t = node.type;
    const good = t === 'integer' ? Number.isInteger(value) : t === 'number' ? typeof value === 'number' && Number.isFinite(value) : t === 'string' ? typeof value === 'string'
      : t === 'boolean' ? typeof value === 'boolean' : t === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : t === 'array' ? Array.isArray(value) : false;
    if (!good) { fail(`type ${t}`); return errs; }
  }
  if (typeof value === 'string') {
    if (node.minLength !== undefined && value.length < node.minLength) fail('minLength');
    if (node.maxLength !== undefined && value.length > node.maxLength) fail('maxLength');
    if (node.pattern !== undefined && !regex(node.pattern).test(value)) fail(`pattern ${node.pattern.slice(0, 40)}`);
  }
  if (typeof value === 'number') {
    if (node.minimum !== undefined && value < node.minimum) fail('minimum');
    if (node.maximum !== undefined && value > node.maximum) fail('maximum');
    if (node.exclusiveMinimum !== undefined && !(value > node.exclusiveMinimum)) fail('exclusiveMinimum');
    if (node.exclusiveMaximum !== undefined && !(value < node.exclusiveMaximum)) fail('exclusiveMaximum');
  }
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) fail('minItems');
    if (node.maxItems !== undefined && value.length > node.maxItems) fail('maxItems');
    if (node.uniqueItems && new Set(value.map(x => JSON.stringify(x))).size !== value.length) fail('uniqueItems');
    const prefix = node.prefixItems ?? [];
    value.forEach((x, i) => {
      if (i < prefix.length) errs.push(...validateSchema(prefix[i], x, `${at}[${i}]`));
      else if (node.items) errs.push(...validateSchema(node.items, x, `${at}[${i}]`));
    });
  } else if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value), props = node.properties ?? {};
    for (const k of node.required ?? []) if (!Object.hasOwn(value, k)) fail(`required ${k}`);
    if (node.maxProperties !== undefined && keys.length > node.maxProperties) fail('maxProperties');
    for (const k of keys) {
      if (node.propertyNames) errs.push(...validateSchema(node.propertyNames, k, `${at}.<${k}>`));
      if (Object.hasOwn(props, k)) errs.push(...validateSchema(props[k], value[k], `${at}.${k}`));
      else if (node.additionalProperties === false) fail(`additional property ${k}`);
      else if (node.additionalProperties && typeof node.additionalProperties === 'object') errs.push(...validateSchema(node.additionalProperties, value[k], `${at}.${k}`));
    }
  }
  if (node.oneOf) {
    const hits = node.oneOf.filter(branch => validateSchema(branch, value, at).length === 0).length;
    if (hits !== 1) fail(`oneOf matched ${hits} branches`);
  }
  return errs;
}
const schemaAccepts = m => validateSchema(schema, m).length === 0;
// the validator itself must be able to reject (a validator that accepts everything would make the parity checks below empty)
ok(!schemaAccepts({}) && !schemaAccepts(null) && !schemaAccepts({ ...F.baseManifest(), extra: 1 }) && !schemaAccepts({ ...F.baseManifest(), family: 'nope' }), 'the mini schema validator rejects');
ok(schemaAccepts(F.baseManifest()), 'the mini schema validator accepts the minimal manifest');

// ------------------------------------------------------------------------------------------------ the JSON Schema document
{
  eq(JSON.stringify(schema), JSON.stringify(M.hudJsonSchema()), 'the schema is deterministic');
  eq(JSON.parse(JSON.stringify(schema)), schema, 'the schema is plain JSON');
  eq([schema.$schema, schema.$id, schema.additionalProperties, schema.type], ['https://json-schema.org/draft/2020-12/schema', 'mpcaaavs-hud-1.schema.json', false, 'object'], 'schema header');
  eq(schema.required, ['format', 'version', 'id', 'title', 'pack', 'family', 'era', 'canvas', 'palette', 'layers'], 'schema required keys (HUD section 4.6)');
  eq(collectRefs(schema).filter(([, target]) => resolvePointer(schema, target) === undefined), [], 'every $ref resolves');
  for (const kind of M.HUD_KINDS) {
    const def = schema.$defs[`k-${kind}`], spec = M.KIND_SPECS[kind];
    ok(def && def.additionalProperties === false && def.properties.k.const === kind, `definition for ${kind}`);
    eq(def.required, ['k', 'id', 'r', ...Object.keys(spec.req)], `${kind} required keys`);
    for (const name of [...Object.keys(spec.req), ...Object.keys(spec.opt)]) ok(Object.hasOwn(def.properties, name), `${kind}.${name} is in the schema`);
    eq(Object.hasOwn(def.properties, 'v'), spec.v, `${kind} takes a binding only when its spec says so`);
    eq(Object.keys(def.properties).filter(k => !['k', 'id', 'r', 'z', 'c', 'c2', 'beh', 'v'].includes(k)).sort(), [...Object.keys(spec.req), ...Object.keys(spec.opt)].sort(), `${kind} has exactly its own properties`);
  }
  eq(schema.$defs.instrument.oneOf.map(x => x.$ref), M.HUD_KINDS.map(k => `#/$defs/k-${k}`), 'the instrument union lists all 21 kinds in order');
  // pin a few normative values of the design listing
  eq([schema.$defs.slug.pattern, schema.$defs.hex.pattern], [M.parseTimeRef ? '^[a-z0-9][a-z0-9-]{1,47}$' : '', '^#[0-9a-f]{6}$'], 'slug and hex patterns (48 characters is the IP-safety cap)');
  eq(schema.properties.layers.maxItems, 96, 'layers cap in the schema');
  eq(schema.properties.events.maxProperties, 8, 'events cap in the schema');
  eq(schema.properties.intervals.maxProperties, 8, 'named interval cap in the schema (owner directive A)');
  eq(schema.properties.meta.properties.origin.enum, ['kit', 'image', 'template'], 'origin in the schema');
  eq(schema.properties.meta.required, ['tier', 'rev'], 'meta requires tier and rev');
}

// ------------------------------------------------------------------------------------------------ every fixture is valid, schema-valid, canonical and stable
const fixtures = F.allFixtures();
const canonicalOf = m => M.serializeHudManifest(m);
{
  ok(fixtures.length === 5 + 42 + 7, 'five scenes, a min and a full fixture for each of the 21 kinds, and the seven layout archetypes');
  const names = new Set();
  for (const [name, m] of fixtures) {
    ok(!names.has(name), `fixture name ${name} is unique`); names.add(name);
    const r = valid(m, name);
    const text = canonicalOf(r.manifest);
    ok(schemaAccepts(m), `${name}: valid under the generated JSON Schema`);
    ok(isDeepFrozen(r.manifest), `${name}: the parsed manifest is deep-frozen`);
    // canonical text
    ok(text.endsWith('}\n') && !text.endsWith('\n\n') && !text.includes('\r') && !text.includes('\t'), `${name}: LF only, one trailing newline, no tabs`);
    ok(text.split('\n').every(l => l === l.trimEnd()), `${name}: no trailing spaces`);
    ok(text.split('\n').every(l => l.length <= 100 || !/^\s*"[^"]+": (?:\[|\{)/.test(l)), `${name}: containers are wrapped at 100 columns`);
    ok(text.split('\n').every(l => (/^ */.exec(l)[0].length % 2) === 0), `${name}: two-space indentation`);
    ok([...text].every(ch => ch === '\n' || (ch >= ' ' && ch <= '~') || ch === DOT), `${name}: printable ASCII and the middle dot only`);
    eq(M.hudManifestBytes(r.manifest), Buffer.byteLength(text, 'utf8'), `${name}: hudManifestBytes is the UTF-8 length`);
    eq(JSON.parse(text), JSON.parse(JSON.stringify(r.manifest)), `${name}: the canonical text parses back to the same data`);
    // round trip: canonical bytes are a fixed point
    const again = M.checkHudManifest(JSON.parse(text));
    ok(again.manifest, `${name}: canonical text re-parses`);
    eq(canonicalOf(again.manifest), text, `${name}: serialize(parse(serialize(parse(x)))) is byte-identical`);
    eq(again.manifest, r.manifest, `${name}: the second parse equals the first`);
    // the preset path agrees with the value path
    const bytes = P.hudPresetBytes(r.manifest);
    eq(bytes.byteLength, Buffer.byteLength(text), `${name}: hudPresetBytes length`);
    eq(P.parseHudPreset(bytes), r.manifest, `${name}: parseHudPreset(hudPresetBytes(m)) equals m`);
    ok(bytes.byteLength <= P.HUD_MAX_BYTES, `${name}: within the .hud size cap`);
  }
  // only the all-kinds scene is deliberately over the soft cost budget; nothing else warns
  for (const [name, m] of fixtures) {
    const warns = run(m).issues.filter(i => i.level === 'warn');
    if (name === 'all-kinds') ok(warns.length === 1 && /soft budget/.test(warns[0].message), 'the all-kinds fixture warns once, about the soft budget');
    else eq(warns, [], `${name} has no warnings`);
  }
  // frozen input is accepted and never mutated; results do not alias the input
  const frozen = freeze(F.allKindsManifest());
  ok(M.checkHudManifest(frozen).manifest, 'a frozen input is accepted');
  const source = F.duelManifest(), before = JSON.stringify(source);
  const parsed = M.checkHudManifest(source).manifest;
  eq(JSON.stringify(source), before, 'the input is not mutated');
  ok(parsed.layers !== source.layers && parsed.palette !== source.palette && parsed.layers[0] !== source.layers[0], 'the result does not alias the input');
  // key order of the input does not matter: the canonical text does
  const shuffle = (v, r) => Array.isArray(v) ? v.map(x => shuffle(x, r)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shuffle(x, r)]).sort(() => r() - 0.5)) : v;
  const rnd = rng(3);
  for (const [name, m] of fixtures.slice(0, 12)) eq(canonicalOf(M.checkHudManifest(shuffle(m, rnd)).manifest), canonicalOf(M.checkHudManifest(m).manifest), `${name}: key order does not change the canonical text`);
  // golden identity of the five scene fixtures: a deliberate format or fixture change moves the catalog SHA-256 of every scene, so it must be a conscious edit of this table
  const golden = { minimal: ['c89c2fdd6f0622e0c74897bab494bf46f0192dc23bcac0bd0c4054dc1ada695b', 483], duel: ['8debc00eee6688b5a6bc92430963090c98d9ce059202706285e6bc8fc9189049', 2720], 'all-kinds': ['a03cc5537c62e04ee82d5d68a867e13b15a0896579099660a0b652806bb7da33', 7513],
    intervals: ['6bb41566ab5774bd06af694746d460e4fa446d79023186dc985a3fd046ec63bb', 1687], thin: ['f360a7a8504bbd7bfc9bd1de794480dfa96675e51ad14e0b8cac18e38d676fd1', 1086] };
  for (const [name, [digest, size]] of Object.entries(golden)) {
    const bytes = P.hudPresetBytes(M.checkHudManifest(fixtures.find(([n]) => n === name)[1]).manifest);
    eq([sha(bytes), bytes.byteLength], [digest, size], `canonical identity of the ${name} fixture`);
  }
}

// ------------------------------------------------------------------------------------------------ per-kind property coverage and boundaries (generated from the kind tables)
const layerPath = kind => `layers[0]`;
function kindWith(kind, edit) {
  const m = F.kindManifest(kind, 'full');
  edit(m.layers[0], m);
  return m;
}
{
  const baseKeys = ['k', 'id', 'r', 'z', 'c', 'c2', 'beh'];
  const union = new Set();
  for (const spec of Object.values(M.KIND_SPECS)) for (const name of [...Object.keys(spec.req), ...Object.keys(spec.opt)]) union.add(name);
  let props = 0, enumValues = 0, bounds = 0;
  for (const kind of KINDS) {
    const spec = M.KIND_SPECS[kind], full = F.kindLayer(kind, 'full'), min = F.kindLayer(kind, 'min');
    // the fixtures exercise every property
    for (const name of [...Object.keys(spec.req), ...Object.keys(spec.opt)]) ok(Object.hasOwn(full, name), `full ${kind} fixture sets ${name}`);
    for (const name of Object.keys(spec.req)) ok(Object.hasOwn(min, name), `min ${kind} fixture sets required ${name}`);
    for (const name of Object.keys(spec.opt)) ok(!Object.hasOwn(min, name), `min ${kind} fixture leaves ${name} out`);
    for (const name of baseKeys) ok(Object.hasOwn(full, name), `full ${kind} fixture sets base key ${name}`);
    eq(Object.hasOwn(full, 'v'), spec.v, `full ${kind} fixture binds a value exactly when the kind takes one`);
    // required properties are required
    for (const name of Object.keys(spec.req)) rejects(kindWith(kind, l => { delete l[name]; }), `${layerPath(kind)}.${name}`, `${kind}: missing ${name}`, /required/);
    for (const name of ['id', 'r']) rejects(kindWith(kind, l => { delete l[name]; }), `${layerPath(kind)}.${name}`, `${kind}: missing ${name}`);
    // properties of other kinds are not allowed
    for (const name of union) if (!Object.hasOwn(spec.req, name) && !Object.hasOwn(spec.opt, name) && !baseKeys.includes(name) && name !== 'v') {
      rejects(kindWith(kind, l => { l[name] = 1; }), `${layerPath(kind)}.${name}`, `${kind} rejects foreign key ${name}`, /unknown key for kind/);
    }
    rejects(kindWith(kind, l => { l.extra = 1; }), `${layerPath(kind)}.extra`, `${kind}: unknown key`, /unknown key/);
    if (!spec.v) rejects(kindWith(kind, l => { l.v = 'audio.rms'; }), `${layerPath(kind)}.v`, `${kind} takes no value binding`, /no value binding/);
    // each property: enumerations, integers, numbers, booleans, text
    for (const [name, s] of [...Object.entries(spec.req), ...Object.entries(spec.opt)]) {
      props++;
      const set = value => kindWith(kind, l => {
        l[name] = value;
        if (kind === 'matrix') { if (name === 'cols') l.rows = 1; if (name === 'rows') l.cols = 1; }
        if (kind === 'fx' && name === 'fx') { l.amount = 0.2; delete l.v; }
      });
      const good = value => { valid(set(value), `${kind}.${name} = ${JSON.stringify(value)}`); bounds++; };
      const bad = (value, text) => rejects(set(value), `${layerPath(kind)}.${name}`, `${kind}.${name} = ${JSON.stringify(value)}`, text);
      switch (s.t) {
        case 'enum':
          for (const v of s.values) { good(v); enumValues++; }
          bad('nope'); bad(7); bad(null); bad(['x']); bad({}); bad('');
          break;
        case 'int':
          good(s.min); good(s.max); bad(s.min - 1); bad(s.max + 1); bad(s.max + 0.5); bad(String(s.max)); bad(null); bad(NaN); bad(Infinity); bad([s.max]);
          if (s.max - s.min > 1) bad(s.min + 0.5);
          break;
        case 'num':
          good(s.min); good(s.max); bad(s.min - 0.01); bad(s.max + 0.01); bad(NaN); bad(Infinity); bad(-Infinity); bad(String(s.max)); bad(null); bad([s.max]);
          break;
        case 'bool': good(true); good(false); bad('true'); bad(1); bad(0); bad(null); break;
        case 'text':
          good(words(s.min)); good(words(s.max)); bad(''); bad(words(s.max + 1)); bad(7); bad(null); bad('caf' + String.fromCharCode(0xe9)); bad('a\nb'); bad(`a${DOT}b`);
          break;
        case 'ref':
          good('s+1b'); good('e-0'); good('f0.5'); bad('soon'); bad(''); bad(5);
          break;
        case 'ease':
          for (const v of ['lin', 'smooth', 'exp:2', 'pow:0.5', 'pow:1.25']) good(v);
          bad('bogus'); bad('exp:'); bad('steps:4'); bad('pow:-1'); bad(2);
          break;
        case 'lines':
          good(Array.from({ length: s.maxItems }, () => words(s.max))); good([words(1)]); bad([]); bad(Array.from({ length: s.maxItems + 1 }, () => words(4))); bad([words(s.max + 1)]); bad('one line'); bad([1]); bad([null]);
          break;
        case 'cues': break; // covered below
        default: assert.fail(`unhandled spec type ${s.t}`);
      }
    }
    // the base keys
    const at = (name, value, expect, note) => (expect ? valid : (m, n) => rejects(m, `${layerPath(kind)}.${name}`, n))(kindWith(kind, l => { l[name] = value; }), `${kind}.${name} ${note}`);
    for (const z of [0, 50, 99]) at('z', z, true, `z=${z}`);
    for (const z of [-1, 100, 1.5, '3', null]) at('z', z, false, `z=${z}`);
    for (const key of M.HUD_PALETTE_KEYS) { at('c', key, true, `c=${key}`); at('c2', key, true, `c2=${key}`); }
    for (const key of ['nope', 'A1', '#fff', 3, null]) { at('c', key, false, `c=${key}`); at('c2', key, false, `c2=${key}`); }
    for (const id of ['a', 'a_b', 'a-b-1', '9', 'x'.repeat(24)]) at('id', id, true, `id=${id}`);
    for (const id of ['', 'A', 'a b', 'a.b', 'x'.repeat(25), 3, null, 'a/b', 'caf' + String.fromCharCode(0xe9)]) at('id', id, false, `id=${id}`);
    for (const r of [[0, 0, 1, 1], [0.5, 0.5, 0.5, 0.5], [0, 0, 0.000001, 0.000001], [0.25, 0.25, 0.75, 0.75]]) at('r', r, true, `r=${r}`);
    for (const r of [[-0.1, 0, 1, 1], [0, 0, 1.1, 1], [0, 0, 0, 1], [0, 0, 1, 0], [0.5, 0, 0.6, 1], [0, 0.5, 1, 0.6], [0, 0, 1], [0, 0, 1, 1, 1], [0, 0, 1, NaN], [0, 0, Infinity, 1], ['0', 0, 1, 1], null, {}, 'x', [0, 0, 0.0000001, 1]]) at('r', r, false, `r=${JSON.stringify(r)}`);
  }
  // the loop above walked every property of every kind: the totals must equal what the tables declare (not a guessed constant)
  const declared = Object.values(M.KIND_SPECS).flatMap(spec => [...Object.values(spec.req), ...Object.values(spec.opt)]);
  eq([props, enumValues], [declared.length, declared.filter(x => x.t === 'enum').reduce((n, x) => n + x.values.length, 0)], 'every property and enumeration value of the tables was exercised');
  ok(props === 84 && enumValues === 149 && bounds > 250, `covered ${props} properties, ${enumValues} enumeration values and ${bounds} accepted values`);

  // behaviours: any vocabulary word is accepted anywhere (irrelevant ones only warn); duplicates, unknowns and more than six are refused
  for (const b of M.HUD_BEHAVIOURS) valid(kindWith('panel', l => { l.beh = [b]; }), `behaviour ${b}`);
  const warned = run(kindWith('panel', l => { l.beh = ['ghost']; })).issues;
  ok(warned.length === 1 && warned[0].level === 'warn' && /no effect/.test(warned[0].message), 'a behaviour with no effect on its kind warns');
  eq(run(kindWith('panel', l => { l.beh = ['pulse', 'blink']; })).issues, [], 'pulse and blink are allowed anywhere without a warning');
  valid(kindWith('bar', l => { l.beh = ['ghost', 'damageFlicker', 'dangerPulse', 'refill', 'capFlash', 'peakHold']; }), 'six behaviours');
  rejects(kindWith('bar', l => { l.beh = ['ghost', 'damageFlicker', 'dangerPulse', 'refill', 'capFlash', 'peakHold', 'pulse']; }), 'layers[0].beh', 'seven behaviours');
  rejects(kindWith('bar', l => { l.beh = ['ghost', 'ghost']; }), 'layers[0].beh', 'duplicate behaviours');
  rejects(kindWith('bar', l => { l.beh = ['nope']; }), 'layers[0].beh[0]', 'unknown behaviour');
  rejects(kindWith('bar', l => { l.beh = 'ghost'; }), 'layers[0].beh', 'behaviours must be a list');
  valid(kindWith('bar', l => { l.beh = []; }), 'an empty behaviour list');

  // banner cues
  const cueManifest = cues => kindWith('banner', l => { l.cues = cues; delete l.v; });
  valid(cueManifest(Array.from({ length: 8 }, (_, i) => ({ at: `s+${i * 2}b`, text: `CUE ${i}`, hold: 0.5 }))), 'eight cues');
  rejects(cueManifest(Array.from({ length: 9 }, (_, i) => ({ at: `s+${i}b`, text: 'X', hold: 0.5 }))), 'layers[0].cues', 'nine cues');
  rejects(cueManifest([]), 'layers[0].cues', 'no cues');
  rejects(cueManifest('READY'), 'layers[0].cues', 'cues must be a list');
  rejects(cueManifest([{ at: 's+0' }]), 'layers[0].cues[0].text', 'a cue needs text');
  rejects(cueManifest([{ text: 'GO' }]), 'layers[0].cues[0].at', 'a cue needs a time');
  rejects(cueManifest([{ at: 'soon', text: 'GO' }]), 'layers[0].cues[0].at', 'a cue needs a valid time reference');
  rejects(cueManifest([{ at: 's+0', text: 'GO', extra: 1 }]), 'layers[0].cues[0].extra', 'a cue has no unknown keys');
  rejects(cueManifest([{ at: 's+0', text: 'GO', style: 'wobble' }]), 'layers[0].cues[0].style', 'cue style');
  for (const hold of [0.05, 8.5, '1', null]) rejects(cueManifest([{ at: 's+0', text: 'GO', hold }]), 'layers[0].cues[0].hold', `cue hold ${hold}`);
  for (const hold of [0.1, 8]) valid(cueManifest([{ at: 's+0', text: 'GO', hold }]), `cue hold ${hold}`);
  rejects(cueManifest([{ at: 's+0', text: words(25) }]), 'layers[0].cues[0].text', 'cue text over 24 characters');
  rejects(cueManifest([{ at: 's+0', text: 'GO' + String.fromCharCode(0xe9) }]), 'layers[0].cues[0].text', 'cue text is ASCII');
  rejects(cueManifest([{ at: 's+0', text: 'GO' + DOT }]), 'layers[0].cues[0].text', 'the middle dot is for titles only');
  rejects(cueManifest([null]), 'layers[0].cues[0]', 'a cue must be an object');
  for (const style of M.HUD_CUE_STYLES) valid(cueManifest([{ at: 's+0', text: 'GO', style }]), `cue style ${style}`);
}

// ------------------------------------------------------------------------------------------------ root-level rejections
{
  const cases = [
    ['format', m => { m.format = 'mpcaaavs-nerv'; }, 'format'], ['no format', m => { delete m.format; }, 'format'],
    ['version 2', m => { m.version = 2; }, 'version'], ['version as text', m => { m.version = '1'; }, 'version'], ['no version', m => { delete m.version; }, 'version'],
    ['unknown root key', m => { m.extra = 1; }, 'extra'], ['unknown root key: old field name', m => { m.name = 'x'; }, 'name'], ['constructor key', m => { m.constructor = 1; }, 'constructor'],
    ['id upper case', m => { m.id = 'Bad-Id'; }, 'id'], ['id too short', m => { m.id = 'a'; }, 'id'], ['id 49 characters', m => { m.id = `a${'b'.repeat(48)}`; }, 'id'], ['id underscore', m => { m.id = 'bad_id'; }, 'id'],
    ['id leading hyphen', m => { m.id = '-bad'; }, 'id'], ['no id', m => { delete m.id; }, 'id'], ['id number', m => { m.id = 5; }, 'id'],
    ['pack with a space', m => { m.pack = 'Bad Pack'; }, 'pack'], ['no pack', m => { delete m.pack; }, 'pack'],
    ['title empty', m => { m.title = ''; }, 'title'], ['title 49 characters', m => { m.title = words(49); }, 'title'], ['title accented', m => { m.title = 'Caf' + String.fromCharCode(0xe9); }, 'title'],
    ['title newline', m => { m.title = 'A\nB'; }, 'title'], ['title tab', m => { m.title = 'A\tB'; }, 'title'], ['title emoji', m => { m.title = 'Star ' + String.fromCodePoint(0x1f680); }, 'title'],
    ['title url', m => { m.title = 'see http://x.y/a'; }, 'title'], ['title backslash', m => { m.title = 'a' + BS + 'b'; }, 'title'], ['no title', m => { delete m.title; }, 'title'],
    ['family', m => { m.family = 'nope'; }, 'family'], ['era', m => { m.era = 'nope'; }, 'era'], ['no family', m => { delete m.family; }, 'family'], ['no era', m => { delete m.era; }, 'era'],
    ['canvas missing', m => { delete m.canvas; }, 'canvas'], ['canvas string', m => { m.canvas = '960x540'; }, 'canvas'], ['canvas.w 63', m => { m.canvas.w = 63; }, 'canvas.w'], ['canvas.w 1921', m => { m.canvas.w = 1921; }, 'canvas.w'],
    ['canvas.h 63', m => { m.canvas.h = 63; }, 'canvas.h'], ['canvas.w fraction', m => { m.canvas.w = 960.5; }, 'canvas.w'], ['canvas.w text', m => { m.canvas.w = '960'; }, 'canvas.w'], ['canvas.style', m => { m.canvas.style = 'raster'; }, 'canvas.style'],
    ['canvas.par zero', m => { m.canvas.par = [0, 1]; }, 'canvas.par'], ['canvas.par 17', m => { m.canvas.par = [1, 17]; }, 'canvas.par'], ['canvas.par one value', m => { m.canvas.par = [1]; }, 'canvas.par'],
    ['canvas.par three values', m => { m.canvas.par = [1, 1, 1]; }, 'canvas.par'], ['canvas.par fraction', m => { m.canvas.par = [1.5, 1]; }, 'canvas.par'], ['canvas key', m => { m.canvas.dpi = 96; }, 'canvas.dpi'],
    ['palette missing', m => { delete m.palette; }, 'palette'], ['palette ink missing', m => { delete m.palette.ink; }, 'palette.ink'], ['palette bad missing', m => { delete m.palette.bad; }, 'palette.bad'],
    ['palette upper case', m => { m.palette.a1 = '#F2B21C'; }, 'palette.a1'], ['palette short', m => { m.palette.a1 = '#fff'; }, 'palette.a1'], ['palette no hash', m => { m.palette.a1 = 'f2b21c'; }, 'palette.a1'],
    ['palette name', m => { m.palette.a1 = 'red'; }, 'palette.a1'], ['palette number', m => { m.palette.a1 = 255; }, 'palette.a1'], ['palette alpha', m => { m.palette.a1 = '#f2b21cff'; }, 'palette.a1'],
    ['palette key', m => { m.palette.accent = '#ffffff'; }, 'palette.accent'], ['palette hi upper', m => { m.palette.hi = '#FFFFFF'; }, 'palette.hi'],
    ['contrast', m => { m.palette.paper = '#0b0d15'; }, 'palette', /contrast/],
    ['timing freeBars 0', m => { m.timing.freeBars = 0; }, 'timing.freeBars'], ['timing freeBars 33', m => { m.timing.freeBars = 33; }, 'timing.freeBars'], ['timing freeBars fraction', m => { m.timing.freeBars = 2.5; }, 'timing.freeBars'],
    ['timing key', m => { m.timing.bpm = 120; }, 'timing.bpm'], ['timing type', m => { m.timing = 8; }, 'timing'],
    ['attention capacity low', m => { m.attention.capacity = 0.5; }, 'attention.capacity'], ['attention capacity high', m => { m.attention.capacity = 8.5; }, 'attention.capacity'],
    ['attention refill low', m => { m.attention.refill = 0.25; }, 'attention.refill'], ['attention refill high', m => { m.attention.refill = 6.5; }, 'attention.refill'], ['attention key', m => { m.attention.max = 1; }, 'attention.max'],
    ['reference year low', m => { m.reference.year = 1899; }, 'reference.year'], ['reference year high', m => { m.reference.year = 2101; }, 'reference.year'], ['reference platform', m => { m.reference.platform = 'Bad Platform'; }, 'reference.platform'],
    ['reference genre', m => { m.reference.genre = 'UPPER'; }, 'reference.genre'], ['reference key', m => { m.reference.title = 'x'; }, 'reference.title'], ['reference type', m => { m.reference = 'arcade'; }, 'reference'],
    ['tags nine', m => { m.tags = Array.from({ length: 9 }, (_, i) => `tag-${i}`); }, 'tags'], ['tags duplicate', m => { m.tags = ['a1', 'a1']; }, 'tags'], ['tags upper', m => { m.tags = ['Bad']; }, 'tags[0]'],
    ['tags long', m => { m.tags = ['x'.repeat(25)]; }, 'tags[0]'], ['tags type', m => { m.tags = 'fixture'; }, 'tags'], ['tags number', m => { m.tags = [3]; }, 'tags[0]'], ['tags leading hyphen', m => { m.tags = ['-a']; }, 'tags[0]'],
    ['meta tier', m => { m.meta.tier = 'gold'; }, 'meta.tier'], ['meta tier missing', m => { delete m.meta.tier; }, 'meta.tier'], ['meta rev 0', m => { m.meta.rev = 0; }, 'meta.rev'], ['meta rev fraction', m => { m.meta.rev = 1.5; }, 'meta.rev'],
    ['meta rev high', m => { m.meta.rev = 1000001; }, 'meta.rev'], ['meta rev missing', m => { delete m.meta.rev; }, 'meta.rev'], ['meta kit upper', m => { m.meta.kit = 'ABCDEF01'; }, 'meta.kit'], ['meta kit short', m => { m.meta.kit = 'abc'; }, 'meta.kit'],
    ['meta kit non-hex', m => { m.meta.kit = 'zzzzzzzz'; }, 'meta.kit'], ['meta gen long', m => { m.meta.gen = words(33); }, 'meta.gen'], ['meta gen empty', m => { m.meta.gen = ''; }, 'meta.gen'], ['meta origin', m => { m.meta.origin = 'scan'; }, 'meta.origin'],
    ['meta key', m => { m.meta.game = 'x'; }, 'meta.game'], ['meta type', m => { m.meta = 'showcase'; }, 'meta'],
    ['layers missing', m => { delete m.layers; }, 'layers'], ['layers empty', m => { m.layers = []; }, 'layers'], ['layers object', m => { m.layers = {}; }, 'layers'], ['layers 97', m => { m.layers = Array.from({ length: 97 }, (_, i) => ({ k: 'label', id: `l${i}`, r: [0, 0, 0.1, 0.1], text: 'X' })); }, 'layers'],
    ['layer null', m => { m.layers[3] = null; }, 'layers[3]'], ['layer array', m => { m.layers[3] = []; }, 'layers[3]'], ['layer number', m => { m.layers[3] = 4; }, 'layers[3]'], ['layer no kind', m => { delete m.layers[3].k; }, 'layers[3].k'],
    ['layer unknown kind', m => { m.layers[3].k = 'gauge'; }, 'layers[3].k'], ['layer kind case', m => { m.layers[3].k = 'Bar'; }, 'layers[3].k'], ['layer kind number', m => { m.layers[3].k = 3; }, 'layers[3].k'],
    ['duplicate layer id', m => { m.layers[4].id = m.layers[3].id; }, 'layers[4].id', /duplicate/],
    ['events nine', m => { m.events = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`ev-${i}`, { on: 'beat', n: 2, seed: i }])); }, 'events'],
    ['events key', m => { m.events['Bad Key'] = { on: 'beat', n: 2, seed: 1 }; }, 'events.Bad Key'], ['events type', m => { m.events = []; }, 'events'], ['event on', m => { m.events.hits.on = 'measure'; }, 'events.hits.on'],
    ['event n 0', m => { m.events.hits.n = 0; }, 'events.hits.n'], ['event n 65', m => { m.events.hits.n = 65; }, 'events.hits.n'], ['event n fraction', m => { m.events.hits.n = 2.5; }, 'events.hits.n'],
    ['event seed negative', m => { m.events.hits.seed = -1; }, 'events.hits.seed'], ['event seed high', m => { m.events.hits.seed = 4294967296; }, 'events.hits.seed'], ['event seed missing', m => { delete m.events.hits.seed; }, 'events.hits.seed'],
    ['event bias high', m => { m.events.hits.bias = 1.5; }, 'events.hits.bias'], ['event gap high', m => { m.events.hits.gap = 17; }, 'events.hits.gap'], ['event from', m => { m.events.hits.from = 'now'; }, 'events.hits.from'],
    ['event to', m => { m.events.hits.to = 5; }, 'events.hits.to'], ['event key unknown', m => { m.events.hits.every = 2; }, 'events.hits.every'], ['event empty window', m => { m.events.hits.from = 'e-0'; m.events.hits.to = 's+0'; }, 'events.hits', /empty/],
    ['intervals nine', m => { m.intervals = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`iv${i}`, { from: 's+0', to: 'e-0' }])); }, 'intervals'],
    ['interval key', m => { m.intervals['Bad Key'] = { from: 's+0', to: 'e-0' }; }, 'intervals.Bad Key'], ['interval key long', m => { m.intervals['x'.repeat(33)] = { from: 's+0', to: 'e-0' }; }, `intervals.${'x'.repeat(33)}`.slice(0, 50)],
    ['interval no to', m => { delete m.intervals.boss.to; }, 'intervals.boss.to'], ['interval no from', m => { delete m.intervals.boss.from; }, 'intervals.boss.from'], ['interval from', m => { m.intervals.boss.from = 'x'; }, 'intervals.boss.from'],
    ['interval key unknown', m => { m.intervals.boss.by = 1; }, 'intervals.boss.by'], ['interval empty', m => { m.intervals.boss = { from: 'e-0', to: 's+0' }; }, 'intervals.boss', /empty/], ['interval type', m => { m.intervals = 3; }, 'intervals'],
    ['unresolved event', m => { m.layers[idx('bar')].v = 'ev.nothing.cum'; }, `layers[${idx('bar')}].v`, /not declared/], 
    ['unresolved event after removing events', m => { delete m.events; }, `layers[${idx('bar')}].v`, /not declared/],
  ];
  for (const [name, mutate, where, text] of cases) {
    const m = allKinds();
    mutate(m);
    rejects(m, where, name, text);
  }
  // the exception above: the all-kinds timer binds interval.remaining (not an iv.* name), so removing `intervals` is fine unless a layer uses iv.*
  const withoutIntervals = allKinds(); delete withoutIntervals.intervals; valid(withoutIntervals, 'no intervals declared and none used');
  const usesIv = F.intervalsManifest(); delete usesIv.intervals;
  { const r = valid(usesIv, 'iv.* used without intervals is valid (the saved setup supplies them) but warned about'); ok(r.issues.filter(i => i.level === 'warn' && /not declared/.test(i.message)).length >= 3, 'one warning per undeclared binding'); }

  // root values that are not objects
  for (const bad of [null, undefined, 5, 'x', true, [], [F.baseManifest()], () => 1, Symbol('x'), 10n]) {
    const r = M.checkHudManifest(bad);
    ok(r.manifest === null && errorsOf(r).length === 1 && errorsOf(r)[0].path === '', `a ${typeof bad} root is refused at the root path`);
  }
  // inherited properties never count as data
  const inherited = Object.create(F.baseManifest());
  rejects(inherited, 'format', 'an object that only inherits its fields');
  const partial = F.baseManifest(); Object.setPrototypeOf(partial, { extra: 1, layers: 'nope' });
  valid(partial, 'inherited extras do not matter and own fields win');
  // prototype pollution attempts through keys
  for (const field of ['events', 'intervals']) {
    const m = allKinds();
    m[field] = JSON.parse('{"__proto__": {"on": "beat", "n": 3, "seed": 1, "from": "s+0", "to": "e-0"}}');
    rejects(m, field, `__proto__ as a ${field} key`, /key must be/);
    ok(({}).on === undefined && ({}).from === undefined, 'Object.prototype is untouched');
  }
  const proto = allKinds(); proto.layers[0] = JSON.parse('{"k": "panel", "id": "p", "r": [0, 0, 1, 1], "style": "flat", "__proto__": {"style": "crt"}}');
  rejects(proto, 'layers[0].__proto__', '__proto__ inside a layer', /unknown key/);
  const ctor = allKinds(); ctor.events.constructor = { on: 'beat', n: 2, seed: 1 };
  const ctorResult = valid(ctor, 'an event id that names an Object member is just a name');
  ok(Object.hasOwn(ctorResult.manifest.events, 'constructor') && typeof ctorResult.manifest.events.constructor === 'object', 'and is stored as an own property');
  ok(M.checkHudManifest(JSON.parse('{"__proto__": {"polluted": true}, "format": "mpcaaavs-hud"}')).manifest === null && ({}).polluted === undefined, 'a __proto__ key at the root is refused');
}

// ------------------------------------------------------------------------------------------------ signal bindings
{
  const dial = idx('dial'), where = `layers[${dial}].v`;
  const bind = value => { const m = allKinds(); m.layers[dial].v = value; return m; };
  // every registered name is accepted, and only those
  for (const name of M.HUD_STATIC_SIGNALS) { ok(M.parseHudSignal(name) !== null, `registered: ${name}`); }
  eq(M.HUD_STATIC_SIGNALS.length, 82, 'the fixed signal registry has 82 names');
  eq(new Set(M.HUD_STATIC_SIGNALS).size, M.HUD_STATIC_SIGNALS.length, 'no duplicate signal names');
  ok(Object.isFrozen(M.HUD_STATIC_SIGNALS), 'the registry list is frozen');
  const dynamic = ['ev.hits.cum', 'ev.hits.remaining', 'ev.hits.count', 'ev.hits.pulse', 'ev.hits.since', 'ev.hits.next', 'iv.boss.progress', 'iv.last-bar.remainingBars', 'iv.a_b.known', 'seed.0', 'seed.7', 'const.5', 'const.-3', 'const.0.25', 'const.-0.5', 'const.123456789'];
  for (const name of dynamic) ok(M.parseHudSignal(name) !== null, `registered: ${name}`);
  const info = M.parseHudSignal('iv.boss.progress');
  eq({ ...info }, { group: 'iv', id: 'boss', field: 'progress' }, 'iv signal info');
  eq({ ...M.parseHudSignal('ev.hits.cum') }, { group: 'ev', id: 'hits', field: 'cum' }, 'ev signal info');
  eq({ ...M.parseHudSignal('audio.onset.any.fired') }, { group: 'audio', field: 'onset.any.fired' }, 'audio signal info');
  eq({ ...M.parseHudSignal('const.-0.5') }, { group: 'const', field: '-0.5' }, 'const signal info');
  const refused = ['', 'audio', 'audio.', 'audio.band', 'audio.band.bogus', 'audio.bandL', 'audio.onset', 'audio.onset.any', 'audio.onset.bogus.env', 'audio.onset.any.bogus', 'audio.beat', 'audio.beat.other', 'audio.contour.slope', 'audio.legacy.bogus',
    'audio.nonsense', 'audio.rms.extra', 'interval', 'interval.', 'interval.bogus', 'interval.progress.x', 'clock.bogus', 'track.bogus', 'iv.boss.overrun', 'iv.boss', 'iv..progress', 'iv.Boss.progress', 'ev.hits', 'ev.Hits.cum', 'ev.hits.bogus', 'ev.hits.cum.x',
    'seed', 'seed.8', 'seed.-1', 'seed.00', 'const', 'const.', 'const.abc', 'const.1e9', 'const.1.2.3', 'const.0x10', 'const.1234567890', 'x.y', 'AUDIO.rms', 'audio.RMS', ' audio.rms', 'audio.rms ', 'a'.repeat(65), 'audio.band.mid.extra'];
  for (const name of refused) ok(M.parseHudSignal(name) === null, `not registered: ${name.slice(0, 20)}`);
  for (const bad of [null, undefined, 5, {}, [], true]) ok(M.parseHudSignal(bad) === null, `not a name: ${typeof bad}`);
  // bindings on a decoration slot
  valid(bind('audio.rms'), 'string binding'); valid(bind({ src: 'audio.rms' }), 'object binding with only src');
  valid(bind({ src: 'audio.band.low', in: [0, 1], out: [0, 100], curve: 'smooth', atk: 0, rel: 5000, gate: 0, steps: 1, fb: -5 }), 'every transform field at once');
  valid(bind({ src: 'audio.rms', in: [1, 0] }), 'a reversed input range is fine'); valid(bind({ src: 'audio.rms', out: [5, 5] }), 'a flat output range is fine');
  for (const curve of ['lin', 'smooth', 'exp:2', 'exp:16', 'pow:0.001', 'pow:12.5', 'steps:1', 'steps:256']) valid(bind({ src: 'audio.rms', curve }), `curve ${curve}`);
  for (const curve of ['', 'bogus', 'exp:', 'exp:0', 'exp:16.001', 'exp:17', 'pow:0', 'pow:1e2', 'steps:0', 'steps:257', 'steps:1.5', 'lin:2', 'LIN', 7, null]) rejects(bind({ src: 'audio.rms', curve }), `${where}.curve`, `curve ${curve}`);
  for (const [key, values] of [['atk', [-1, 5001, '5', null, NaN]], ['rel', [-1, 5001, '5', null, Infinity]], ['gate', [-0.1, 1.1, '0']], ['steps', [0, 257, 1.5, '3']], ['fb', ['x', null, NaN, 1e10]]]) {
    for (const value of values) rejects(bind({ src: 'audio.rms', [key]: value }), `${where}.${key}`, `${key} ${value}`);
  }
  for (const value of [[0], [0, 1, 2], ['a', 'b'], [NaN, 1], [0, Infinity], 5, [1e10, 0]]) rejects(bind({ src: 'audio.rms', out: value }), `${where}.out`, `out ${JSON.stringify(value)}`);
  for (const value of [[1, 1], [0], [0, 1, 2], [0, 'x']]) rejects(bind({ src: 'audio.rms', in: value }), `${where}.in`, `in ${JSON.stringify(value)}`);
  rejects(bind({}), `${where}.src`, 'an object binding needs src'); rejects(bind({ src: 'nope' }), `${where}.src`, 'src must be registered'); rejects(bind({ src: 'audio.rms', extra: 1 }), `${where}.extra`, 'no unknown keys in a binding');
  rejects(bind({ src: ['audio.rms'] }), `${where}.src`, 'src must be a string');
  for (const name of ['audio.nonsense', 'nope', '', 'ev.hits', 5, null, [], 'audio.rms ']) rejects(bind(name), where, `binding ${JSON.stringify(name)}`);
  // event and interval references must be declared, and the declaration must cover the id
  rejects(bind('ev.other.cum'), where, 'undeclared event set', /not declared/); { const r = valid(bind('iv.other.progress'), 'an undeclared interval is a warning, not an error (a saved setup may define it)'); ok(r.issues.some(i => i.level === 'warn' && i.path === where && /not declared/.test(i.message)), 'and the warning names the binding'); }
  valid(bind('ev.hits.pulse'), 'declared event set'); valid(bind('iv.boss.progress'), 'declared interval');
  // authority: a value that decides something must not follow the music
  const authority = (kind, edit, src) => { const m = allKinds(); const l = m.layers[idx(kind)]; edit(l); l.v = src; return m; };
  rejects(authority('timer', () => {}, 'audio.rms'), `layers[${idx('timer')}].v`, 'a timer cannot bind audio', /authoritative/);
  rejects(authority('timer', () => {}, { src: 'audio.band.low', out: [0, 1] }), `layers[${idx('timer')}].v`, 'a timer cannot bind audio through an object', /authoritative/);
  rejects(authority('counter', l => { l.mode = 'interval'; }, 'audio.band.high'), `layers[${idx('counter')}].v`, 'an interval counter cannot bind audio', /authoritative/);
  valid(authority('counter', l => { l.mode = 'live'; }, 'audio.band.high'), 'a live counter may follow audio'); valid(authority('counter', l => { l.mode = 'static'; }, 'audio.rms'), 'a static counter may bind audio (decoration)');
  for (const beh of ['ghost', 'damageFlicker', 'dangerPulse']) rejects(authority('bar', l => { l.beh = [beh]; }, 'audio.rms'), `layers[${idx('bar')}].v`, `a ${beh} bar is a health bar`, /authoritative/);
  valid(authority('bar', l => { l.beh = ['refill', 'capFlash']; }, 'audio.rms'), 'a level bar may follow audio'); valid(authority('bar', l => { delete l.beh; }, 'audio.band.low'), 'a bar with no behaviours may follow audio');
  valid(authority('timer', () => {}, 'ev.hits.remaining'), 'a timer may follow an event schedule'); valid(authority('timer', () => {}, 'clock.beatPos'), 'a timer may follow the clock');
  for (const src of ['interval.remaining', 'iv.boss.remaining', 'track.remaining', 'seed.3', 'const.10']) valid(authority('timer', () => {}, src), `a timer may bind ${src}`);
  for (const kind of ['dial', 'spectrum', 'scope', 'matrix', 'portrait', 'reticle', 'radar', 'rain', 'viewport', 'fx']) valid(authority(kind, () => {}, 'audio.rms'), `${kind} is a decoration slot`);
  ok(M.isAuthoritative({ k: 'timer' }) && M.isAuthoritative({ k: 'counter', mode: 'interval' }) && !M.isAuthoritative({ k: 'counter', mode: 'live' }) && M.isAuthoritative({ k: 'bar', beh: ['ghost'] }) && !M.isAuthoritative({ k: 'bar' }) && !M.isAuthoritative({ k: 'panel' }), 'isAuthoritative');
}

// ------------------------------------------------------------------------------------------------ the signal registry is served by the shared signal bus (when that module exists)
if (existsSync(path.join(root, 'src/hud/hud-signals.ts'))) {
  const S = await load('src/hud/hud-signals.ts');
  const data = S.emptyHudSignals(0);
  const lookup = name => {
    const p = name.split('.');
    let node = data;
    if (p[0] !== 'audio') return undefined;
    if (p[1] === 'tension' || p[1] === 'slope') node = data.contour[p[1]];
    else for (const part of p.slice(1)) { if (node === undefined || node === null || !Object.hasOwn(node, part)) return undefined; node = node[part]; }
    return node;
  };
  let served = 0;
  for (const name of M.HUD_STATIC_SIGNALS.filter(n => n.startsWith('audio.'))) {
    const v = lookup(name);
    ok(typeof v === 'number' || typeof v === 'boolean', `audio signal ${name} is a field of HudSignalsV2`); served++;
  }
  eq([...S.HUD_BANDS], ['sub', 'low', 'mid', 'high', 'air'], 'the bands are the manifest bands'); eq([...S.HUD_GROUPS], ['kick', 'snare', 'hat', 'tonal', 'any'], 'the onset groups are the manifest groups');
  eq([...M.HUD_BANDS], [...S.HUD_BANDS], 'bands agree'); eq([...M.HUD_GROUPS], [...S.HUD_GROUPS], 'groups agree');
  ok(served === 7 + 20 + 25 + 4 + 4, 'checked every audio name');
} else console.log('hud-signals.ts is not present: registry cross-check skipped');

// ------------------------------------------------------------------------------------------------ time references
{
  const good = { 's+0': ['s', 0, 's', 0], 's+2b': ['s', 2, 'b', 0], 'e-1b': ['e', -1, 'b', 0], 'e-0': ['e', -0, 's', 0], 's+1.5': ['s', 1.5, 's', 0], 's+1.5s': ['s', 1.5, 's', 0], 'e+3': ['e', 3, 's', 0],
    's-1b': ['s', -1, 'b', 0], 's+1234': ['s', 1234, 's', 0], 's+0.125b': ['s', 0.125, 'b', 0], 'f0': ['f', 0, 's', 0], 'f0.5': ['f', 0, 's', 0.5], 'f1': ['f', 0, 's', 1], 'f1.0': ['f', 0, 's', 1], 'f0.1234': ['f', 0, 's', 0.1234] };
  for (const [text, [anchor, offset, unit, frac]] of Object.entries(good)) {
    const p = M.parseTimeRef(text);
    ok(p !== null && p.anchor === anchor && Object.is(p.offset + 0, offset + 0) && p.unit === unit && p.frac === frac, `time reference ${text}`);
  }
  for (const text of ['', 's', 'e', 'f', 'x+1', 's+', 's+b', 's+1x', 's1', 's +1', ' s+1', 's+1 ', 'S+1', 'f2', 'f-0.1', 'f1.5', 'f1.1', 'f.5', 'f0.12345', 'f00.5', 's+1.5555', 's+12345', 's+1.', 's+1..5', 's++1', 's+1bb', 'e-1B', '+1', '1', 'now', 's+1e3', 's+0x10', 's+\u0661'])
    ok(M.parseTimeRef(text) === null, `not a time reference: ${JSON.stringify(text)}`);
  for (const bad of [null, undefined, 5, {}, [], true]) ok(M.parseTimeRef(bad) === null, `not a string: ${typeof bad}`);
  eq(M.referenceRefSeconds('s+2b', 8, 120), 4, 'two bars at 120 BPM'); eq(M.referenceRefSeconds('e-1b', 8, 120), 14, 'one bar before the end of eight'); eq(M.referenceRefSeconds('f0.5', 8, 120), 8, 'half of eight bars');
  eq(M.referenceRefSeconds('s+1.5', 8, 120), 1.5, 'seconds'); eq(M.referenceRefSeconds('e-0', 4, 60), 16, 'the end of four bars at 60 BPM');
}

// ------------------------------------------------------------------------------------------------ IP-safety lint on every free-text field
{
  const textFields = [];
  for (const [kind, spec] of Object.entries(M.KIND_SPECS)) for (const [name, s] of [...Object.entries(spec.req), ...Object.entries(spec.opt)]) {
    if (s.t === 'text') textFields.push([kind, name, value => value]);
    if (s.t === 'lines') textFields.push([kind, name, value => [value]]);
  }
  textFields.push(['banner', 'cues', value => [{ at: 's+0', text: value }]]);
  eq(textFields.length, 5 + 2 + 1, 'text-bearing properties: five text, two line lists (scope status, terminal lines) and the banner cues');
  const payloads = [['a URL', 'see http://a.b/c'], ['a URL without a scheme prefix', 'x://y'], ['a data URI', 'data:image/png'], ['a web address', 'go to www.x.y'], ['a drive path', 'C:' + BS + 'x'], ['a backslash', 'a' + BS + 'b'],
    ['a unix-style drive path', 'D:/x'], ['a unix path', 'see /home/user/x'], ['a home path', '~/x/y'], ['a relative path', '../x/y'], ['a leading path', '/usr/bin'], ['an e-mail address', 'me@example.org'], ['a base64 run', 'QUJDREVGR0hJSktMTU5PUFFS'], ['a hex run', 'AB 0123456789abcdef'], ['accents', 'caf' + String.fromCharCode(0xe9)],
    ['a control character', 'a' + String.fromCharCode(7) + 'b'], ['a newline', 'a\nb'], ['a tab', 'a\tb'], ['a null character', 'a' + String.fromCharCode(0)], ['an emoji', 'x' + String.fromCodePoint(0x1f680)], ['a right-to-left mark', 'a' + String.fromCharCode(0x200f)],
    ['a full-width letter', String.fromCharCode(0xff21)], ['a zero-width space', 'a' + String.fromCharCode(0x200b) + 'b'], ['the middle dot', 'a' + DOT + 'b']];
  for (const [kind, name, wrap] of textFields) for (const [what, payload] of payloads) {
    const m = kindWith(kind, l => { l[name] = wrap(payload); if (kind === 'banner') delete l.v; });
    rejects(m, `${layerPath(kind)}.${name}`, `${kind}.${name} must reject ${what}`);
  }
  // the same payloads in every name-like slot
  const slots = { title: m => m, id: m => m, pack: m => m, 'reference.platform': m => m, 'reference.genre': m => m, 'meta.gen': m => m };
  for (const [what, payload] of payloads) {
    if (what === 'the middle dot') { valid(Object.assign(allKinds(), { title: `Duel ${DOT} Amber` }), 'the middle dot is fine in a title'); continue; }
    for (const slot of Object.keys(slots)) {
      const m = allKinds();
      if (slot.includes('.')) { const [a, b] = slot.split('.'); m[a][b] = payload; } else m[slot] = payload;
      rejects(m, slot, `${slot} must reject ${what}`);
    }
    rejects(Object.assign(allKinds(), { tags: [payload] }), 'tags[0]', `a tag must reject ${what}`);
  }
  // length caps: 48 everywhere, and short caps stay short
  valid(Object.assign(allKinds(), { title: words(48) }), 'a 48-character title'); valid(Object.assign(allKinds(), { id: 'a'.repeat(48) }), 'a 48-character id');
  // a long string of ordinary words is fine; a long run without spaces is not
  valid(kindWith('terminal', l => { l.lines = ['THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG NOW']; }), 'a 46-character line of ordinary words');
  rejects(kindWith('terminal', l => { l.lines = ['A'.repeat(30)]; }), 'layers[0].lines[0]', 'a 30-letter run reads as an encoded run');
  valid(kindWith('terminal', l => { l.lines = ['0x0040 0x0080 0x00C0 0x0100 0x0140']; }), 'spaced hex is readable text');
  // ordinary text with slashes in it is not a path
  for (const text of ['AND/OR', 'CH1/CH2', 'N/A', '12/31/99', 'READY 1/2', 'LEFT/RIGHT/UP', 'A / B / C', '5/8 FULL']) valid(kindWith('terminal', l => { l.lines = [text]; }), `${JSON.stringify(text)} is text, not a path`);
  // the parsed strings are what was written (nothing is trimmed or rewritten)
  eq(M.checkHudManifest(Object.assign(allKinds(), { title: '  padded  ' })).manifest.title, '  padded  ', 'a title keeps its spaces');
}

// ------------------------------------------------------------------------------------------------ the deny-list hook
{
  const digest = text => sha(text), salt = 'fixture-salt';
  const bad = ['doom', 'street fighter', 'super mario world', 'capcom'];
  const hashes = new Set(bad.map(t => M.hudDenyEntry(digest, salt, t)));
  const deny = M.hudDenyHook(digest, salt, hashes);
  eq(M.hudDenyEntry(digest, salt, 'doom'), sha(`${salt}\0doom`), 'entry recipe: digest(salt, NUL, n-gram)');
  ok(deny('doom') && deny('street fighter') && deny('super mario world') && !deny('duel') && !deny('street') && !deny('doom '), 'the hook matches whole normalised n-grams only');
  ok(!M.hudDenyHook(digest, 'other-salt', hashes)('doom'), 'a different salt matches nothing');
  eq(M.hudWords('Duel-Rails: AMBER_03!'), ['duel', 'rails', 'amber', '03'], 'hudWords'); eq(M.hudWords('  '), [], 'hudWords of nothing');
  eq(M.hudNgrams('a b c d'), ['a', 'b', 'c', 'd', 'a b', 'b c', 'c d', 'a b c', 'b c d'], 'hudNgrams: 1 to 3 words'); eq(M.hudNgrams('one'), ['one'], 'a single word'); eq(M.hudNgrams(''), [], 'no words');
  const seen = [], recorder = g => { seen.push(g); return false; };
  valid(F.duelManifest(), 'duel with a recording hook', { deny: recorder });
  ok(seen.includes('duel rails amber 03') === false && seen.includes('duel rails amber') && seen.includes('fixture') && seen.includes('duel') && seen.includes('ghost') === false, 'the hook sees titles, ids, packs and layer text, not behaviour words');
  // where a blocked name can hide
  const spots = [
    ['title', m => { m.title = 'Street Fighter Duel'; }], ['title (case and punctuation)', m => { m.title = 'STREET-fighter'; }], ['id', m => { m.id = 'doom-like-01'; }], ['pack', m => { m.pack = 'capcom-pack'; }],
    ['tag', m => { m.tags = ['fixture', 'doom']; }], ['reference genre', m => { m.reference.genre = 'doom'; }], ['reference platform', m => { m.reference.platform = 'capcom'; }],
    ['layer id', m => { m.layers[0].id = 'doom'; }], ['event id', m => { m.events.doom = m.events.hits; m.layers[idx('bar')].v = 'ev.doom.remaining'; }],
    ['interval id', m => { m.intervals.doom = m.intervals.boss; }], ['generator tag', m => { m.meta.gen = 'doom'; }], ['bound interval id', m => { m.layers[idx('dial')].v = 'iv.doom.progress'; }],
    ['label text', m => { m.layers[idx('label')].text = 'DOOM'; }], ['panel title', m => { m.layers[idx('panel')].title = 'CAPCOM'; }], ['warning text', m => { m.layers[idx('warning')].text = 'DOOM ALERT'; }],
    ['combo text', m => { m.layers[idx('combo')].text = 'SUPER MARIO WORLD'; }], ['counter unit', m => { m.layers[idx('counter')].unit = 'DOOM'; }],
    ['banner cue', m => { m.layers[idx('banner')].cues[1].text = 'STREET FIGHTER'; }], ['terminal line', m => { m.layers[idx('terminal')].lines[2] = 'LOADING DOOM ENGINE'; }], ['scope status', m => { m.layers[idx('scope')].status[0] = 'DOOM'; }],
  ];
  for (const [name, edit] of spots) {
    const m = allKinds(); edit(m);
    const r = rejects(m, '', `deny-list hit in ${name}`, /blocked name/, { deny });
    ok(!JSON.stringify(r.issues).toLowerCase().includes('doom') && !JSON.stringify(r.issues).toLowerCase().includes('capcom') && !JSON.stringify(r.issues).toLowerCase().includes('street'), `${name}: the message never echoes the blocked term`);
    valid(m, `${name}: without a hook the same manifest is fine`);
  }
  // a name split across two strings is not a phrase
  valid(Object.assign(allKinds(), { title: 'Street Rails', pack: 'fighter-pack' }), 'two strings are scanned separately', { deny });
  valid(allKinds(), 'the fixture set passes a hook that knows other names', { deny });
  for (const [name, m] of fixtures) valid(m, `${name} against the hook`, { deny });
  // the hook runs after structural validation: a structurally broken manifest never reaches it
  let called = 0;
  const broken = allKinds(); broken.layers[0].r = [2, 2, 2, 2];
  rejects(broken, 'layers[0].r', 'structure first', undefined, { deny: () => { called++; return false; } });
  eq(called, 0, 'the deny hook is not called for a structurally invalid manifest');
  // through the preset path
  const bytes = P.hudPresetBytes(M.checkHudManifest(Object.assign(allKinds(), { title: 'Street Fighter Duel' })).manifest);
  assert.throws(() => P.parseHudPreset(bytes, { deny }), err => err instanceof P.HudManifestError && /blocked name/.test(err.message)); checks++;
  const soft = P.tryParseHudPreset(bytes, { deny });
  ok(!soft.ok && /blocked name/.test(soft.error) && soft.issues.length >= 1, 'tryParseHudPreset reports the deny-list hit');
  ok(P.tryParseHudPreset(bytes).ok, 'and accepts the same bytes without a hook');
}

// ------------------------------------------------------------------------------------------------ palette, cost, attention and structure lints
{
  eq(M.hexToRgb('#0a0c14'), [10, 12, 20], 'hexToRgb'); near(M.contrastRatio('#ffffff', '#000000'), 21, 'black on white'); near(M.contrastRatio('#000000', '#ffffff'), 21, 'contrast is symmetric'); near(M.contrastRatio('#777777', '#777777'), 1, 'identical colours');
  ok(M.relativeLuminance('#000000') === 0 && Math.abs(M.relativeLuminance('#ffffff') - 1) < 1e-12, 'luminance endpoints');
  function near(a, b, note, tol = 1e-9) { assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b)), `${note}: ${a} vs ${b}`); checks++; }
  const pal = m => { m.palette.ink = '#ffffff'; m.palette.paper = '#777777'; return m; };
  rejects(pal(allKinds()), 'palette', '4.48:1 fails the 4.5:1 rule', /contrast/);
  const pass = allKinds(); pass.palette.ink = '#ffffff'; pass.palette.paper = '#767676'; valid(pass, '4.54:1 passes');
  const dark = allKinds(); dark.palette.ink = '#000000'; dark.palette.paper = '#777777'; valid(dark, '#777777 on black is 4.69:1');
  const resolved = M.resolvePalette(M.checkHudManifest(F.baseManifest()).manifest.palette);
  eq(Object.keys(resolved), [...M.HUD_PALETTE_KEYS], 'resolvePalette returns all nine keys in order'); ok(Object.isFrozen(resolved), 'and freezes them');
  const mixHex = (a, b, t) => `#${[0, 1, 2].map(i => Math.round(M.hexToRgb(a)[i] + (M.hexToRgb(b)[i] - M.hexToRgb(a)[i]) * t).toString(16).padStart(2, '0')).join('')}`;
  eq(resolved.shade, mixHex(F.PALETTE.ink, F.PALETTE.paper, 0.08), 'shade defaults to ink lifted 8 percent toward paper'); eq(resolved.hi, mixHex(F.PALETTE.paper, '#ffffff', 0.6), 'hi defaults to paper lifted 60 percent toward white');
  const explicit = M.resolvePalette(M.checkHudManifest(F.duelManifest()).manifest.palette); eq([explicit.shade, explicit.hi], [F.PALETTE.shade, F.PALETTE.hi], 'explicit shade and hi win');
  for (const [name, m] of fixtures) { const p = M.resolvePalette(m.palette); ok(Object.values(p).every(v => /^#[0-9a-f]{6}$/.test(v)), `${name}: resolved palette is nine hex colours`); }

  // structural lints
  rejects(kindWith('matrix', l => { l.cols = 32; l.rows = 9; }), 'layers[0]', 'a matrix over 256 cells', /256 cells/); valid(kindWith('matrix', l => { l.cols = 16; l.rows = 16; }), '256 cells');
  rejects(kindWith('fx', l => { l.fx = 'flash'; l.amount = 0.3; delete l.v; }), 'layers[0].amount', 'a flash over 0.25', /flash safety/); valid(kindWith('fx', l => { l.fx = 'flash'; l.amount = 0.25; delete l.v; }), 'a flash at 0.25');
  for (const fx of ['flash', 'shake']) rejects(kindWith('fx', l => { l.fx = fx; l.amount = 0.2; l.v = 'audio.rms'; }), 'layers[0].v', `${fx} takes no binding`, /rate-limited/);
  valid(kindWith('fx', l => { l.fx = 'shake'; l.amount = 1; delete l.v; }), 'shake without a binding');
  rejects(kindWith('warning', l => { delete l.when; l.until = 'e-0'; }), 'layers[0].until', 'until without when', /needs when/);

  // cost model
  const cost = M.estimateHudCost(M.checkHudManifest(F.allKindsManifest()).manifest);
  ok(Object.keys(cost).join() === 'draws,segments,texts,gradients,overdraw' && Object.values(cost).every(v => Number.isFinite(v) && v >= 0), 'cost has five finite parts');
  ok(cost.segments > M.HUD_BUDGET.soft.segments && cost.segments < M.HUD_BUDGET.hard.segments && cost.draws < M.HUD_BUDGET.soft.draws, 'the all-kinds scene sits between the soft and hard segment budgets');
  let previous = -1;
  for (let n = 1; n <= 12; n++) { // monotone in the number of layers
    const m = F.baseManifest({ layers: Array.from({ length: n }, (_, i) => ({ k: 'portrait', id: `p${i}`, r: [0, 0, 0.5, 0.5], style: 'face' })) });
    const c = M.estimateHudCost(M.checkHudManifest(m).manifest || m);
    ok(c.segments > previous && c.draws >= 8 * n, `cost grows with layers (${n})`); previous = c.segments;
  }
  const heavy = F.baseManifest({ layers: Array.from({ length: 40 }, (_, i) => ({ k: 'portrait', id: `p${i}`, r: [0, 0, 0.1, 0.1], style: 'face' })) });
  rejects(heavy, 'layers', 'over the hard cost budget', /hard budget/);
  const soft = F.baseManifest({ layers: Array.from({ length: 14 }, (_, i) => ({ k: 'portrait', id: `p${i}`, r: [0, 0, 0.1, 0.1], style: 'face' })) });
  const softResult = valid(soft, 'over the soft budget only'); ok(softResult.issues.some(i => i.level === 'warn' && /soft budget/.test(i.message)), 'over the soft budget only warns');
  // text calls: 96 is exactly the hard budget (allowed, with a soft-budget warning); 120 (five vector terminals of 24 lines) is over it
  const texts = F.baseManifest({ layers: Array.from({ length: 96 }, (_, i) => ({ k: 'label', id: `t${i}`, r: [0, 0, 0.1, 0.1], text: 'X', font: 'display' })) });
  const textResult = valid(texts, '96 display texts sit exactly at the hard budget'); ok(textResult.issues.some(i => i.level === 'warn' && /texts/.test(i.message) && /soft budget/.test(i.message)), 'and warn about the soft text budget');
  const terminals = n => F.baseManifest({ layers: Array.from({ length: n }, (_, i) => ({ k: 'terminal', id: `t${i}`, r: [0, 0, 0.1, 0.1], lines: Array.from({ length: 24 }, () => 'LINE') })) });
  valid(terminals(4), 'four vector terminals are 96 text calls'); rejects(terminals(5), 'layers', 'five vector terminals are 120 text calls', /texts 120 exceed the hard budget/);
  eq(M.estimateHudCost(M.checkHudManifest(terminals(4)).manifest).texts, 96, 'the vector terminal costs one text call per line');
  const pixelTerminal = F.baseManifest({ canvas: { w: 320, h: 224, style: 'pixel' }, layers: [{ k: 'terminal', id: 't0', r: [0, 0, 0.5, 0.5], lines: Array.from({ length: 24 }, () => 'LINE') }] });
  eq(M.estimateHudCost(M.checkHudManifest(pixelTerminal).manifest).texts, 0, 'a pixel terminal is batched rectangles, not text calls');

  // attention: scheduled events reserve budget statically
  const banners = (a, b, cap) => F.baseManifest({ ...(cap ? { attention: { capacity: cap } } : {}), layers: [{ k: 'banner', id: 'one', r: [0, 0, 1, 0.2], cues: [{ at: a, text: 'ONE', hold: 2 }] }, { k: 'banner', id: 'two', r: [0, 0.3, 1, 0.2], cues: [{ at: b, text: 'TWO', hold: 2 }] }] });
  rejects(banners('s+0', 's+1', 0), 'layers', 'two overlapping banners exceed capacity 4', /attention/); valid(banners('s+0', 's+1', 8), 'capacity 8 covers them'); valid(banners('s+0', 's+2', 0), 'back-to-back banners do not overlap');
  valid(banners('s+0', 's+1b', 0), 'a bar apart is enough at the reference tempo (2 s)');
  const peak = M.peakAttention(M.checkHudManifest(banners('s+0', 's+1', 8)).manifest); eq(peak, { peak: 6, at: 1 }, 'peakAttention finds the overlap'); eq(M.peakAttention(M.checkHudManifest(F.baseManifest()).manifest), { peak: 0, at: 0 }, 'nothing scheduled, nothing reserved');
  const lockScene = lockEvery => F.baseManifest({ layers: [{ k: 'reticle', id: 'aim', r: [0, 0, 0.5, 0.5], style: 'crosshair', lockEvery, lockHold: 1, beh: ['lock'] }, { k: 'warning', id: 'w1', r: [0, 0.6, 1, 0.1], text: 'ONE', when: 's+0', until: 'e-0' }, { k: 'warning', id: 'w2', r: [0, 0.8, 1, 0.1], text: 'TWO', when: 's+0', until: 'e-0' }] });
  eq(M.peakAttention(M.checkHudManifest(Object.assign(lockScene(2), { attention: { capacity: 5 } })).manifest).peak, 5, 'lock (1) plus two warnings (2 each) reserve 5');
  rejects(lockScene(2), 'layers', 'lock plus two warnings exceed capacity 4', /attention/); valid(Object.assign(lockScene(2), { attention: { capacity: 5 } }), 'capacity 5 covers them');
  // the same scene can overlap at 180 BPM without overlapping at 120: that only warns
  // bar-based starts move with the tempo and second-based ends do not: this pair is clear at 120 BPM (banner ends at 1.5 s, the warning starts at 2 s) and collides at 180 BPM (it starts at 1.33 s)
  const tight = F.baseManifest({ layers: [{ k: 'banner', id: 'one', r: [0, 0, 1, 0.2], cues: [{ at: 's+0', text: 'ONE', hold: 1.5 }] }, { k: 'warning', id: 'w1', r: [0, 0.6, 1, 0.1], text: 'ONE', when: 's+1b', until: 's+3' }] });
  const tightResult = valid(tight, 'a tempo-dependent overlap is not an error');
  ok(tightResult.issues.some(i => i.level === 'warn' && /180 BPM/.test(i.message)), 'it warns that the scene overlaps beyond capacity at 180 BPM');
  eq([M.peakAttention(tightResult.manifest, 120).peak, M.peakAttention(tightResult.manifest, 180).peak], [3, 5], 'peak attention at 120 and 180 BPM');
}

// ------------------------------------------------------------------------------------------------ limits at their boundary
{
  const labels = n => Array.from({ length: n }, (_, i) => ({ k: 'label', id: `l${i}`, r: [0, 0, 0.1, 0.1], text: 'X' }));
  valid(F.baseManifest({ layers: labels(96) }), '96 layers'); rejects(F.baseManifest({ layers: labels(97) }), 'layers', '97 layers', /1 to 96/);
  const ev = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [`ev-${i}`, { on: 'beat', n: 2, seed: i }]));
  valid(F.baseManifest({ events: ev(8) }), '8 event sets'); rejects(F.baseManifest({ events: ev(9) }), 'events', '9 event sets', /at most 8/);
  const iv = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [`iv${i}`, { from: 's+0', to: 'e-0' }]));
  valid(F.baseManifest({ intervals: iv(8) }), '8 named intervals'); rejects(F.baseManifest({ intervals: iv(9) }), 'intervals', '9 named intervals', /at most 8/);
  valid(F.baseManifest({ tags: Array.from({ length: 8 }, (_, i) => `t${i}`) }), '8 tags'); valid(F.baseManifest({ tags: ['x'.repeat(24)] }), 'a 24-character tag');
  valid(F.baseManifest({ layers: [{ k: 'terminal', id: 't', r: [0, 0, 0.5, 0.5], lines: Array.from({ length: 24 }, () => words(48)) }] }), '24 terminal lines of 48 characters');
  // canonical size: the largest manifest that fits is accepted, one more layer is refused
  const bulky = n => F.baseManifest({ canvas: { w: 384, h: 224, style: 'pixel' }, layers: Array.from({ length: n }, (_, i) => ({ k: 'terminal', id: `t${i}`, r: [0, 0, 0.01, 0.01], lines: Array.from({ length: 24 }, () => words(46)) })) });
  let fit = 1;
  while (M.hudManifestBytes(M.checkHudManifest(bulky(fit + 1)).manifest ?? { ...F.baseManifest(), layers: [] }) > 0 && fit < 96) { const r = M.checkHudManifest(bulky(fit + 1)); if (!r.manifest) break; fit++; }
  ok(fit >= 20 && fit < 96, `about ${fit} bulky layers fit in 32 KiB`);
  const fits = M.checkHudManifest(bulky(fit)); ok(fits.manifest && M.hudManifestBytes(fits.manifest) <= 32768, 'the last manifest that fits is accepted');
  const over = rejects(bulky(fit + 1), '', 'one more bulky layer', /canonical text/); ok(errorsOf(over).length === 1, 'and only the size is wrong');
  eq(P.hudPresetBytes(fits.manifest).byteLength, M.hudManifestBytes(fits.manifest), 'and its bytes are exactly what hudManifestBytes says');
  assert.throws(() => P.hudPresetBytes(clone(fits.manifest) && { ...fits.manifest, layers: [...fits.manifest.layers, ...bulky(fit + 1).layers.slice(fit)] }), /too large/); checks++;
  // issue cap
  const many = allKinds(); many.layers = Array.from({ length: 96 }, () => ({ k: 'nope' }));
  const capped = run(many); ok(capped.manifest === null && capped.issues.length === M.HUD_LIMITS.issues, 'issues are capped at 64');
  // hostile keys are shortened in paths
  const hostile = allKinds(); hostile['x'.repeat(5000)] = 1;
  const hostileResult = run(hostile); ok(hostileResult.issues.every(i => i.path.length <= 60 && i.message.length < 200), 'an enormous key does not flood the issue list');
}

// ------------------------------------------------------------------------------------------------ owner directive A: tier, origin, named intervals; catalog metadata
{
  for (const tier of M.HUD_TIERS) for (const origin of [undefined, ...M.HUD_ORIGINS]) {
    const m = allKinds(); m.meta = { tier, rev: 2, ...(origin ? { origin } : {}) };
    const r = valid(m, `tier ${tier} origin ${origin}`);
    eq(P.hudCatalogMeta(r.manifest, 7).tier, tier, `catalog tier ${tier}`);
    eq(r.manifest.meta.origin, origin, `origin ${origin} survives`);
    eq(M.checkHudManifest(JSON.parse(canonicalOf(r.manifest))).manifest.meta, r.manifest.meta, `meta ${tier}/${origin} round-trips`);
  }
  const noMeta = allKinds(); delete noMeta.meta; const nm = valid(noMeta, 'meta is optional');
  eq(P.hudCatalogMeta(nm.manifest, 1).tier, 'auto', 'no meta means an unreviewed (auto) scene');
  const intervals = M.checkHudManifest(F.intervalsManifest()).manifest;
  eq(Object.keys(intervals.intervals), ['boss', 'last-bar'], 'named intervals are kept');
  ok(canonicalOf(intervals).indexOf('"boss"') < canonicalOf(intervals).indexOf('"last-bar"'), 'the canonical text lists intervals in sorted order');
  ok(canonicalOf(intervals).indexOf('"taps"') < canonicalOf(intervals).indexOf('"volley"'), 'and event sets in sorted order');
  eq(Object.keys(M.checkHudManifest(F.intervalsManifest()).manifest.events), ['taps', 'volley'].sort(), 'event sets are sorted');
  // catalog block (contract 2.2.5)
  const m = M.checkHudManifest(F.duelManifest()).manifest;
  const meta = P.hudCatalogMeta(m, 3);
  eq(JSON.parse(JSON.stringify(meta)), { id: 'fixture-duel-rails-03', pack: 'fixture-pack', family: 'fighting', tags: [], tier: 'tuned', order: 3, canvas: { style: 'pixel', w: 384, h: 224, par: [1, 1] } }, 'catalog block shape');
  eq(Object.keys(meta), ['id', 'pack', 'family', 'tags', 'tier', 'order', 'canvas'], 'catalog block key order'); ok(isDeepFrozen(meta), 'the catalog block is frozen');
  eq(P.hudCatalogMeta(m, 1, { pack: 'Arcade ' + DOT + ' Fighting' }).pack, 'Arcade ' + DOT + ' Fighting', 'the installer may replace the pack with a display label');
  eq(P.hudCatalogMeta(m, 1, { tags: Array.from({ length: 12 }, (_, i) => `t${i}`) }).tags.length, 8, 'at most eight tags');
  eq(P.hudCatalogMeta(M.checkHudManifest(F.allKindsManifest()).manifest, 1).tags, ['fixture', 'all-kinds'], 'manifest tags become catalog tags');
  ok(!('par' in P.hudCatalogMeta(M.checkHudManifest(F.baseManifest()).manifest, 1).canvas), 'no par when the manifest has none');
  for (const bad of [1.5, NaN, Infinity, '3', null, 2 ** 53]) assert.throws(() => P.hudCatalogMeta(m, bad), /whole number/); checks += 6;
  eq(P.hudCatalogMeta(m, -4).order, -4, 'a negative ordinal is still a whole number');
  // the sixteen pack labels of owner directive B: every one is a valid display label, and none can make the host catalog parser throw
  const LABELS = ['Showcase', `Arcade ${DOT} Fighting`, `Arcade ${DOT} Action`, 'Neo Geo', 'Vector & Early Arcade', '8/16-bit Consoles', '32/64-bit Consoles', '128-bit Consoles', 'Handheld & LCD', 'Home Computers', 'PC Classic',
    'Flight, Space & Racing', 'Modern', 'Rhythm', 'Cinema & TV', 'Anime & Mecha'];
  eq(LABELS.length, 16, 'sixteen pack labels');
  for (const label of LABELS) eq(P.hudCatalogMeta(m, 2, { pack: label }).pack, label, `pack label ${JSON.stringify(label)} is accepted verbatim`);
  for (const bad of ['', 'x'.repeat(81), 'Caf' + String.fromCharCode(0xe9), 'a\nb', 'a\tb', 'a' + String.fromCharCode(0x7f), 'a' + String.fromCharCode(0x2028), 'emoji ' + String.fromCodePoint(0x1f680), 5, null, ['Modern']]) {
    assert.throws(() => P.hudCatalogMeta(m, 1, { pack: bad }), /pack label/); checks++;
  }
  eq(P.hudCatalogMeta(m, 1, { pack: 'x'.repeat(80) }).pack.length, 80, 'an 80-character label is the longest');
  // tag overrides are kept exactly as the host parser keeps them: strings of 1 to 24 characters, no control characters, unique, at most eight
  eq(P.hudCatalogMeta(m, 1, { tags: ['pixel', '', 'x'.repeat(25), 'x'.repeat(24), 5, null, 'a\nb', 'pixel', 'amber', ['no']] }).tags, ['pixel', 'x'.repeat(24), 'amber'], 'tag overrides drop empty, long, non-string, control and repeated entries');
  eq(P.hudCatalogMeta(m, 1, { tags: [] }).tags, [], 'an explicit empty tag list wins over the manifest tags');
  ok(isDeepFrozen(P.hudCatalogMeta(M.checkHudManifest(F.allKindsManifest()).manifest, 1)), 'the catalog block and its tags are frozen');
  // the browser stream's built-in folder defaults are keyed by these very labels (best effort: skipped when that module cannot be bundled right now)
  try {
    const D = await load('src/mpc-folder-defaults.ts');
    if (Array.isArray(D.HUD_PACK_LABELS)) eq([...D.HUD_PACK_LABELS], LABELS, 'the labels of the folder-defaults table are the sixteen labels of owner directive B, exactly');
    else console.log('folder-defaults cross-check skipped: HUD_PACK_LABELS is not exported');
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    console.log(`folder-defaults cross-check skipped: ${String(error?.message ?? error).split(String.fromCharCode(10))[0]}`);
  }
  // the catalog parser of the host accepts what the manifest side produces (best effort: skipped when that module cannot be bundled right now)
  try {
    const L = await load('src/avs/local-collection.ts');
    const rows = fixtures.slice(0, 5).map(([name, fx], i) => {
      const parsed = M.checkHudManifest(fx).manifest, bytes = P.hudPresetBytes(parsed);
      return { sha256: sha(bytes), bytes: bytes.byteLength, kind: 'hud', canonical_path: `presets/unique/HUD ${name}.hud`, display_name: `HUD ${name}`, folder: `HUD packs/${parsed.pack}`, hud: JSON.parse(JSON.stringify(P.hudCatalogMeta(parsed, i + 1, { pack: `Pack ${DOT} ${i}` }))) };
    });
    const parsed = L.parseLocalAvsCatalog({ presets: rows }, { results: [] }, 'http://127.0.0.1/');
    eq(parsed.map(p => p.kind), rows.map(() => 'hud'), 'the host catalog parser reads the rows as hud'); eq(parsed.map(p => p.hud.id), fixtures.slice(0, 5).map(([, fx]) => fx.id), 'and keeps the scene ids');
    eq(parsed.map(p => p.hud.tier), fixtures.slice(0, 5).map(([, fx]) => fx.meta?.tier ?? 'auto'), 'and the tiers');
    ok(parsed.every(p => p.hud.canvas.w >= 64), 'and a valid canvas');
    const labelRows = LABELS.map((label, i) => {
      const bytes = P.hudPresetBytes(M.checkHudManifest(F.duelManifest()).manifest);
      return { sha256: sha(Buffer.concat([Buffer.from(bytes), Buffer.from(String(i))])), bytes: bytes.byteLength, kind: 'hud', canonical_path: `presets/unique/HUD label ${i}.hud`, display_name: `HUD label ${i}`, folder: `${label}/Duel`, hud: JSON.parse(JSON.stringify(P.hudCatalogMeta(M.checkHudManifest(F.duelManifest()).manifest, i + 1, { pack: label }))) };
    });
    const byLabel = L.parseLocalAvsCatalog({ presets: labelRows }, { results: [] }, 'http://127.0.0.1/');
    eq(byLabel.map(p => p.hud.pack), LABELS, 'the host catalog parser reads all sixteen pack labels verbatim');
    ok(byLabel.every(p => p.folder !== undefined), 'and keeps each folder hint');
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    console.log(`host catalog cross-check skipped: ${String(error?.message ?? error).split('\n')[0]}`);
  }
  ok(P.isHudFileName('scene.hud') && P.isHudFileName('presets/unique/HUD x.hud') && !P.isHudFileName('.hud') && !P.isHudFileName('scene.HUD') && !P.isHudFileName('scene.hud.txt') && !P.isHudFileName('scene.nerv') && !P.isHudFileName('scene.avs') && !P.isHudFileName(5) && !P.isHudFileName(''), 'isHudFileName');
}

// ------------------------------------------------------------------------------------------------ the seven layout archetypes: generator output stays inside the cost budget with headroom
{
  eq([...F.ARCHETYPES], ['dock-top-duel', 'dock-top-score', 'dock-bottom-status', 'dock-side-command', 'dock-twin', 'console3d-8', 'cinema-triptych'], 'the archetype names of HUD section 7.4');
  const kinds = new Set(), styles = new Set();
  for (const name of F.ARCHETYPES) {
    const r = valid(F.archetypeManifest(name), `archetype ${name}`), m = r.manifest, cost = M.estimateHudCost(m);
    eq(r.issues, [], `${name}: no warnings at all`);
    ok(schemaAccepts(F.archetypeManifest(name)), `${name}: valid under the generated JSON Schema`);
    eq([m.meta.tier, m.meta.origin], ['auto', 'template'], `${name}: an unreviewed template layout, labelled as such`);
    ok(cost.draws <= 0.75 * M.HUD_BUDGET.soft.draws && cost.segments <= 0.75 * M.HUD_BUDGET.soft.segments && cost.texts <= M.HUD_BUDGET.soft.texts && cost.gradients <= M.HUD_BUDGET.soft.gradients && cost.overdraw <= M.HUD_BUDGET.soft.overdraw, `${name}: ${JSON.stringify(cost)} leaves headroom under the soft budget`);
    ok(M.peakAttention(m, 120).peak <= (m.attention?.capacity ?? 4) && M.peakAttention(m, 180).peak <= (m.attention?.capacity ?? 4), `${name}: scheduled attention fits at 120 and 180 BPM`);
    ok(M.hudManifestBytes(m) < 8192, `${name}: ${M.hudManifestBytes(m)} bytes (a typical scene is 3 to 8 KiB)`);
    for (const layer of m.layers) kinds.add(layer.k);
    styles.add(m.canvas.style);
    // instruments a generator adds to an archetype (a bar, a counter and a slots strip) stay inside the hard budget
    const grown = clone(F.archetypeManifest(name));
    grown.layers.push({ k: 'bar', id: 'extra-bar', r: [0.1, 0.5, 0.2, 0.03], dir: 'ltr', segs: 12 }, { k: 'counter', id: 'extra-count', r: [0.1, 0.55, 0.2, 0.05], digits: 6, fmt: 'pad0', mode: 'static' }, { k: 'slots', id: 'extra-slots', r: [0.4, 0.5, 0.2, 0.06], n: 6 });
    const g = run(grown); ok(g.manifest && errorsOf(g).length === 0, `${name}: three more instruments still validate`);
    // pixel scenes sit on their native grid: every rectangle is at least one cell in each direction
    if (m.canvas.style === 'pixel') for (const layer of m.layers) ok(layer.r[2] * m.canvas.w >= 1 && layer.r[3] * m.canvas.h >= 1, `${name}/${layer.id}: at least one native cell`);
    ok(P.isCanonicalHudPreset(P.hudPresetBytes(m)), `${name}: its .hud bytes are canonical`);
  }
  ok(kinds.size >= 16, `the archetypes together use ${kinds.size} of the 21 kinds`);
  eq([...styles].sort(), ['pixel', 'vector'], 'both canvas styles are represented');
  // authority rule on the archetypes: health, timers and interval counters never bind audio; live strips do
  for (const name of F.ARCHETYPES) for (const layer of M.checkHudManifest(F.archetypeManifest(name)).manifest.layers) {
    if (!layer.v) continue;
    const src = typeof layer.v === 'string' ? layer.v : layer.v.src;
    if (M.isAuthoritative(layer)) ok(!src.startsWith('audio.'), `${name}/${layer.id}: an authoritative instrument does not bind ${src}`);
  }
  ok(F.ARCHETYPES.some(n => JSON.stringify(F.archetypeManifest(n)).includes('audio.band')), 'and live audio decorates some strips');
  const all = F.ARCHETYPES.map(F.archetypeManifest);
  eq(new Set(all.map(m => m.id)).size, 7, 'seven distinct scene ids'); eq(new Set(all.map(m => m.title)).size, 7, 'seven distinct titles');
  assert.throws(() => F.archetypeManifest('nope'), /No archetype/); checks++;
}

// ------------------------------------------------------------------------------------------------ canonical numbers
{
  const m = allKinds();
  m.layers[idx('bar')].r = [0.1234567891, 0.2, 0.3, 0.04]; m.layers[idx('dial')].v = { src: 'audio.rms', atk: 12.3456789, in: [-0.0000001, 1], out: [0, 0.35000004] };
  m.layers[idx('viewport')].energy = 0.3499999;
  const r = valid(m, 'numbers with more than six decimals');
  eq(r.manifest.layers[idx('bar')].r, [0.123457, 0.2, 0.3, 0.04], 'rects are rounded to six places'); eq(r.manifest.layers[idx('dial')].v.atk, 12.345679, 'atk is rounded');
  ok(Object.is(r.manifest.layers[idx('dial')].v.in[0], 0), 'minus zero is folded into zero'); eq(r.manifest.layers[idx('dial')].v.out[1], 0.35, 'and the range is judged after rounding'); eq(r.manifest.layers[idx('viewport')].energy, 0.35, 'a value just under the bound rounds onto it and is accepted');
  const text = canonicalOf(r.manifest);
  ok(!/\d\.\d{7}/.test(text) && !text.includes('-0,') && !text.includes('-0]') && !/[:\[,]\s*-?\d+(?:\.\d+)?[eE][+-]?\d/.test(text), 'the canonical text has no long fractions, minus zero or exponents');
  eq(M.checkHudManifest(JSON.parse(text)).manifest, r.manifest, 'the parsed canonical text equals the parsed original');
  // a rect that is only positive before rounding is refused, so the canonical text is always valid
  rejects(kindWith('panel', l => { l.r = [0, 0, 0.0000004, 1]; }), 'layers[0].r', 'a width that rounds to zero');
  valid(kindWith('panel', l => { l.r = [0, 0, 0.0000005, 1]; }), 'a width that rounds up to one micro-unit');
  // idempotence over many values
  const rnd = rng(19);
  for (let i = 0; i < 2000; i++) {
    const v = rnd() < 0.5 ? rnd() : (rnd() - 0.5) * 2e9 * rnd(), m2 = kindWith('counter', l => { l.min = v; });
    const p = M.checkHudManifest(m2).manifest; if (!p) continue;
    const q = M.checkHudManifest(JSON.parse(canonicalOf(p))).manifest;
    ok(q && q.layers[0].min === p.layers[0].min, `a number is stable after one canonicalisation (${v})`);
  }
}

// ------------------------------------------------------------------------------------------------ .hud files: framing, size, encoding, duplicate keys
{
  const good = P.hudPresetBytes(M.checkHudManifest(F.duelManifest()).manifest), text = Buffer.from(good).toString('utf8');
  const enc = s => new TextEncoder().encode(s);
  eq(P.parseHudPreset(good).id, 'fixture-duel-rails-03', 'canonical bytes parse'); eq(P.parseHudPreset(good.buffer.slice(good.byteOffset, good.byteOffset + good.byteLength)).id, 'fixture-duel-rails-03', 'an ArrayBuffer parses');
  const padded = new Uint8Array(good.byteLength + 20); padded.set(good, 10);
  eq(P.parseHudPreset(padded.subarray(10, 10 + good.byteLength)).id, 'fixture-duel-rails-03', 'a view into a larger buffer parses only its own window');
  eq(P.parseHudPreset(Buffer.from(good)).id, 'fixture-duel-rails-03', 'a Node Buffer parses');
  eq(P.parseHudPreset(enc(JSON.stringify(JSON.parse(text)))).id, 'fixture-duel-rails-03', 'compact JSON parses (the identity is the canonical form, but readers are tolerant of whitespace)');
  const failsWith = (bytes, re, note) => { assert.throws(() => P.parseHudPreset(bytes), err => err instanceof Error && re.test(err.message), note); checks++; const soft = P.tryParseHudPreset(bytes); ok(!soft.ok && re.test(soft.error), `${note} (soft)`); };
  failsWith(new Uint8Array(0), /empty/, 'empty file'); failsWith(new Uint8Array(P.HUD_MAX_BYTES + 1).fill(32), /too large/, 'one byte over the cap'); failsWith(new Uint8Array(1e6), /too large/, 'a megabyte');
  failsWith(new Uint8Array([0x7b, 0xff, 0x7d]), /UTF-8/, 'invalid UTF-8'); failsWith(new Uint8Array([0xc3, 0x28]), /UTF-8/, 'an overlong sequence');
  failsWith(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(good)]), /JSON/, 'a byte order mark (the identity is bytes without one)'); failsWith(enc(text.slice(0, -10)), /JSON/, 'truncated JSON');
  failsWith(enc('not json'), /JSON/, 'not JSON'); failsWith(enc(`${text}${text}`), /JSON/, 'two documents');
  failsWith(enc('{"a": 1, "a": 2}'), /repeats a key/, 'a repeated key at the root');
  failsWith(enc(text.replace('"format": "mpcaaavs-hud",', '"format": "mpcaaavs-hud", "format": "mpcaaavs-hud",')), /repeats a key/, 'a repeated key that would otherwise validate');
  failsWith(enc(text.replace('"ink": "#0a0c14",', '"ink": "#0a0c14", "ink": "#0a0c14",')), /repeats a key/, 'a repeated key in a nested object');
  failsWith(enc(text.replace('"k": "panel",', '"k": "panel", "k": "panel",')), /repeats a key/, 'a repeated key in a layer inside an array');
  failsWith(enc(text.replace('"format": "mpcaaavs-hud",', `"format": "mpcaaavs-hud", "${BS}u0066ormat": "mpcaaavs-hud",`)), /repeats a key/, 'a repeated key spelled with an escape');
  ok(!P.jsonHasDuplicateKeys(text), 'the canonical text has no repeated keys');
  // arrays and rejected values
  for (const doc of ['[]', 'null', '5', '"x"', 'true', '{}', '{"format": "mpcaaavs-hud"}']) { assert.throws(() => P.parseHudPreset(enc(doc)), err => err instanceof P.HudManifestError && err.issues.length >= 1 && /^Invalid HUD manifest: /.test(err.message)); checks++; }
  const soft = P.tryParseHudPreset(enc('{"format": "mpcaaavs-hud", "version": 1}'));
  ok(!soft.ok && soft.issues.length >= 5 && soft.issues.every(i => typeof i.path === 'string' && typeof i.message === 'string' && Object.keys(i).sort().join() === 'level,message,path' && i.level === 'error'), 'tryParseHudPreset lists the missing fields (errors only)');
  ok(soft.issues.some(i => i.path === 'id') && soft.issues.some(i => i.path === 'layers'), 'with their paths');
  // the size cap counts bytes, not characters
  const wide = M.checkHudManifest(Object.assign(allKinds(), { title: `${DOT.repeat(24)}` })).manifest;
  eq(M.hudManifestBytes(wide), Buffer.byteLength(canonicalOf(wide), 'utf8'), 'the middle dot is two bytes');
  // a manifest is written with hudPresetBytes only when it fits
  eq(P.hudPresetBytes(wide) instanceof Uint8Array, true, 'hudPresetBytes returns bytes');
  // duplicate-key detector against an independent generator (structure known by construction)
  const r = rng(29);
  const keyNames = ['a', 'b', 'c', 'key', 'k1', 'ab', 'a b', 'a"b', 'a' + BS + 'b', '{', '}', '[', ']', ':', ',', '\n'];
  const literal = k => JSON.stringify(k), escaped = k => (k === 'a' ? `"${BS}u0061"` : literal(k));
  function gen(depth) {
    const t = r();
    if (depth <= 0 || t < 0.3) return { text: JSON.stringify([1, 'x', null, true, 'a,b', '{"a":1,"a":2}', 2.5][Math.floor(r() * 7)]), dup: false };
    if (t < 0.55) { const items = Array.from({ length: Math.floor(r() * 4) }, () => gen(depth - 1)); return { text: `[${items.map(i => i.text).join(r() < 0.5 ? ',' : ' , ')}]`, dup: items.some(i => i.dup) }; }
    const n = Math.floor(r() * 5), used = [], pairs = [];
    let dup = false;
    for (let i = 0; i < n; i++) {
      const k = keyNames[Math.floor(r() * keyNames.length)];
      if (used.includes(k)) dup = true; used.push(k);
      const v = gen(depth - 1); dup = dup || v.dup;
      pairs.push(`${r() < 0.2 ? escaped(k) : literal(k)}${r() < 0.5 ? ':' : ' : '}${v.text}`);
    }
    return { text: `{${pairs.join(r() < 0.5 ? ',' : ', ')}}`, dup };
  }
  let dups = 0, clean = 0;
  for (let i = 0; i < 3000; i++) {
    const { text: t, dup } = gen(4);
    JSON.parse(t); // the generator only emits valid JSON
    eq(P.jsonHasDuplicateKeys(t), dup, `duplicate-key detector on ${t.slice(0, 80)}`);
    if (dup) dups++; else clean++;
  }
  ok(dups > 200 && clean > 200, `the generator produced ${dups} repeated and ${clean} clean documents`);
  // a string that only looks like a repeated key is not one
  ok(!P.jsonHasDuplicateKeys('{"a": "a", "b": "a"}') && !P.jsonHasDuplicateKeys('{"a": {"a": {"a": 1}}, "b": {"a": 1}}') && !P.jsonHasDuplicateKeys('[{"a":1},{"a":2}]') && !P.jsonHasDuplicateKeys('{"a": [{"a": 1}, {"a": 1}]}'), 'nesting resets the key set');
  ok(P.jsonHasDuplicateKeys('{"a": {"b": 1}, "a": 2}') && P.jsonHasDuplicateKeys('[{"a": 1, "a": 1}]'), 'and a repeat at the same level is caught');
}

// ------------------------------------------------------------------------------------------------ the .hud identity: canonical bytes and their SHA-256
{
  const canonical = P.hudPresetBytes(M.checkHudManifest(F.duelManifest()).manifest), text = Buffer.from(canonical).toString('utf8');
  const enc = s => new TextEncoder().encode(s);
  ok(P.isCanonicalHudPreset(canonical) && P.isCanonicalHudPreset(canonical.buffer.slice(canonical.byteOffset, canonical.byteOffset + canonical.byteLength)) && P.isCanonicalHudPreset(Buffer.from(canonical)), 'canonical bytes are canonical (Uint8Array, ArrayBuffer, Buffer)');
  const padded = new Uint8Array(canonical.byteLength + 8); padded.set(canonical, 4);
  ok(P.isCanonicalHudPreset(padded.subarray(4, 4 + canonical.byteLength)) && !P.isCanonicalHudPreset(padded), 'a view is judged by its own window only');
  ok(!P.isCanonicalHudPreset(enc(JSON.stringify(JSON.parse(text)))), 'compact JSON is valid but not canonical');
  ok(!P.isCanonicalHudPreset(enc(`${JSON.stringify(JSON.parse(text), null, 4)}\n`)), 'other indentation is not canonical');
  ok(!P.isCanonicalHudPreset(enc(text.replace(/\n/g, '\r\n'))), 'CRLF line endings are not canonical');
  ok(!P.isCanonicalHudPreset(enc(text.slice(0, -1))) && !P.isCanonicalHudPreset(enc(`${text}\n`)), 'a missing or a doubled trailing newline is not canonical');
  ok(!P.isCanonicalHudPreset(enc(text.replace('0.37', '0.370'))), 'another spelling of a number is not canonical');
  const { format, version, ...rest } = JSON.parse(text);
  ok(!P.isCanonicalHudPreset(enc(`${JSON.stringify({ ...rest, format, version }, null, 2)}\n`)), 'another key order is not canonical');
  for (const bad of [new Uint8Array(0), enc('not json'), enc('{}'), new Uint8Array(P.HUD_MAX_BYTES + 1).fill(32), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonical)]), enc(text.replace('"ink": "#0a0c14"', '"ink": "#0a0c14", "ink": "#0a0c14"'))]) {
    ok(P.isCanonicalHudPreset(bad) === false, 'a file that does not parse is not canonical (and nothing throws)');
  }
  ok(P.isCanonicalHudPreset(canonical, { deny: () => false }) && !P.isCanonicalHudPreset(canonical, { deny: g => g === 'duel' }), 'the deny hook applies');
  ok(!P.isCanonicalHudPreset(null) && !P.isCanonicalHudPreset(undefined) && !P.isCanonicalHudPreset('text') && !P.isCanonicalHudPreset(5), 'non-byte input is not canonical');
  for (const [name, m] of fixtures) { const b = P.hudPresetBytes(M.checkHudManifest(m).manifest); ok(P.isCanonicalHudPreset(b), `${name}: the bytes hudPresetBytes writes are canonical`); }
  // a mutant is canonical exactly when it parses and equals its own canonical bytes
  const rb = rng(307), seeds = fixtures.slice(0, 5).map(([, m]) => P.hudPresetBytes(M.checkHudManifest(m).manifest));
  let canonicalMutants = 0, looseMutants = 0;
  for (let i = 0; i < 1500; i++) {
    const bytes = Array.from(seeds[i % seeds.length]), pos = Math.floor(rb() * bytes.length), t = rb();
    if (t < 0.4) bytes.splice(pos, 0, 32); else if (t < 0.7) bytes[pos] = bytes[pos] === 32 ? 10 : bytes[pos]; else bytes.splice(pos, 1);
    const u8 = Uint8Array.from(bytes), soft = P.tryParseHudPreset(u8), same = soft.ok && Buffer.from(P.hudPresetBytes(soft.manifest)).equals(Buffer.from(u8));
    eq(P.isCanonicalHudPreset(u8), same, 'isCanonicalHudPreset equals "parses and equals its own canonical bytes"');
    if (same) canonicalMutants++; else if (soft.ok) looseMutants++;
  }
  ok(looseMutants > 100, `${looseMutants} valid but non-canonical mutants were told apart from ${canonicalMutants} canonical ones`);
  // the identity is the SHA-256 of the bytes, whichever API computes it
  eq(await P.hudPresetSha256(canonical), sha(canonical), 'hudPresetSha256 equals the node:crypto digest');
  eq(await P.hudPresetSha256(canonical.buffer.slice(canonical.byteOffset, canonical.byteOffset + canonical.byteLength)), sha(canonical), 'for an ArrayBuffer too');
  eq(await P.hudPresetSha256(padded.subarray(4, 4 + canonical.byteLength)), sha(canonical), 'and only the window of a view');
  eq(await P.hudPresetSha256(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'the empty digest');
  const digestOf = new Map();
  for (const [name, m] of fixtures) digestOf.set(name, await P.hudPresetSha256(P.hudPresetBytes(M.checkHudManifest(m).manifest)));
  eq(new Set(digestOf.values()).size, fixtures.length, 'every fixture has its own identity');
  ok([...digestOf.values()].every(d => /^[0-9a-f]{64}$/.test(d)), 'lower-case hexadecimal');
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    await assert.rejects(() => P.hudPresetSha256(canonical), /not available/); checks++;
  } finally { if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); else delete globalThis.crypto; }
  eq(await P.hudPresetSha256(canonical), sha(canonical), 'and it works again once Web Crypto is back');
}

// ------------------------------------------------------------------------------------------------ unusual inputs from API callers (files can only hold JSON; code can hand over anything)
{
  const direct = (m, options) => M.checkHudManifest(m, options);   // no structuredClone: sparse arrays and accessors must arrive as they are
  const hole = (list, i) => { const a = [...list]; delete a[i]; return a; };
  const refused = (m, where, note) => { const r = direct(m); assert.equal(r.manifest, null, `${note}: expected a rejection`); assert.ok(errorsOf(r).some(i => under(i.path, where)), `${note}: wanted an error at ${where}, got ${JSON.stringify(errorsOf(r).slice(0, 3))}`); checks++; };
  // a hole in a sparse array is a missing value, never a silently dropped one
  refused({ ...F.baseManifest(), layers: new Array(1) }, 'layers[0]', 'a sparse layers array');
  const gapped = F.allKindsManifest(); gapped.layers = hole(gapped.layers, 3);
  refused(gapped, 'layers[3]', 'a hole between layers');
  refused({ ...F.baseManifest(), tags: hole(['aa', 'bb', 'cc'], 1) }, 'tags[1]', 'a hole in tags');
  for (let i = 0; i < 4; i++) { const m = F.kindManifest('panel', 'min'); m.layers[0].r = hole([0, 0.5, 0.5, 0.5], i); refused(m, 'layers[0].r', `a hole at rect index ${i}`); }
  for (const i of [0, 1]) refused({ ...F.baseManifest(), canvas: { w: 960, h: 540, style: 'vector', par: hole([1, 1], i) } }, 'canvas.par', `a hole in par at ${i}`);
  { const m = F.kindManifest('bar', 'full'); m.layers[0].beh = hole(['ghost', 'damageFlicker'], 0); refused(m, 'layers[0].beh', 'a hole in behaviours'); }
  { const m = F.kindManifest('terminal', 'min'); m.layers[0].lines = hole(['ONE', 'TWO'], 1); refused(m, 'layers[0].lines[1]', 'a hole in terminal lines'); }
  { const m = F.kindManifest('scope', 'full'); m.layers[0].status = hole(['A', 'B'], 0); refused(m, 'layers[0].status[0]', 'a hole in scope status'); }
  { const m = F.kindManifest('banner', 'min'); m.layers[0].cues = new Array(1); refused(m, 'layers[0].cues[0]', 'a sparse cue list'); }
  { const m = F.kindManifest('banner', 'min'); m.layers[0].cues = hole([{ at: 's+0', text: 'A' }, { at: 's+1b', text: 'B' }], 0); refused(m, 'layers[0].cues[0]', 'a hole before a cue'); }
  for (const key of ['in', 'out']) for (const i of [0, 1]) { const m = F.kindManifest('dial', 'min'); m.layers[0].v = { src: 'audio.rms', [key]: hole([0, 1], i) }; refused(m, `layers[0].v.${key}`, `a hole in ${key}`); }
  // accessors and proxies that throw are refused, not propagated
  {
    const evil = F.baseManifest(); Object.defineProperty(evil, 'family', { enumerable: true, get() { throw new Error('boom'); } });
    const r = direct(evil); ok(r.manifest === null && errorsOf(r).some(i => i.path === '' && /could not be read/.test(i.message)), 'a throwing getter at the root is refused');
    const inner = F.baseManifest(); Object.defineProperty(inner.layers[0], 'bed', { enumerable: true, get() { throw new Error('boom'); } });
    ok(direct(inner).manifest === null, 'a throwing getter inside a layer is refused');
    ok(direct(new Proxy(F.baseManifest(), { ownKeys() { throw new Error('boom'); } })).manifest === null, 'a proxy whose keys throw is refused');
    ok(direct(new Proxy({}, { get() { throw new Error('boom'); }, getOwnPropertyDescriptor() { throw new Error('boom'); } })).manifest === null, 'a proxy that throws on every trap is refused');
    const hook = direct(F.duelManifest(), { deny: () => { throw new Error('boom'); } });
    ok(hook.manifest === null && errorsOf(hook).length === 1 && /could not be read/.test(errorsOf(hook)[0].message), 'a deny hook that throws fails closed');
  }
  // null-prototype objects are ordinary data; an own toString is an unknown key
  const bare = v => (Array.isArray(v) ? v.map(bare) : v && typeof v === 'object' ? Object.assign(Object.create(null), Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bare(x)]))) : v);
  for (const [name, m] of fixtures.slice(0, 10)) {
    const r = direct(bare(m));
    ok(r.manifest !== null, `${name}: an object without a prototype parses`);
    eq(canonicalOf(r.manifest), canonicalOf(M.checkHudManifest(m).manifest), `${name}: and gives the same canonical text`);
  }
  { const m = F.baseManifest(); m.toString = 5; refused(m, 'toString', 'a shadowing toString'); }
  // names that are members of Object.prototype are never kinds, and never count as declared events or intervals
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) { const m = allKinds(); m.layers[3].k = name; refused(m, 'layers[3].k', `kind ${name}`); }
  for (const name of ['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'constructor']) {
    const m = allKinds(); m.layers[idx('dial')].v = `ev.${name}.cum`; refused(m, `layers[${idx('dial')}].v`, `an undeclared event named ${name}`);
    const n = allKinds(); n.layers[idx('dial')].v = `iv.${name}.progress`;
    if (name === name.toLowerCase()) { const r = direct(n); ok(r.manifest !== null && r.issues.some(i => i.level === 'warn' && /not declared/.test(i.message)), `an interval named ${name} is only ever an undeclared one (a warning)`); ok(!Object.hasOwn(r.manifest.intervals ?? {}, name), `and ${name} never becomes a declared one`); }
    else refused(n, `layers[${idx('dial')}].v`, `an interval named ${name} is not a valid id`);
  }
  // warnings can never crowd an error out of the bounded issue list
  {
    const noisy = () => F.baseManifest({ layers: Array.from({ length: 96 }, (_, i) => ({ k: 'panel', id: `p${i}`, r: [0, 0, 0.1, 0.1], style: 'flat', beh: ['ghost', 'damageFlicker', 'dangerPulse'] })) });
    const quiet = direct(noisy());
    ok(quiet.manifest !== null && quiet.issues.length === M.HUD_LIMITS.issues - 8 && quiet.issues.every(i => i.level === 'warn'), '288 warnings are capped eight below the issue cap');
    const bad = noisy(); bad.palette.paper = bad.palette.ink;
    const r = direct(bad);
    ok(r.manifest === null && r.issues.length <= M.HUD_LIMITS.issues && errorsOf(r).some(i => i.path === 'palette'), 'an error found after hundreds of warnings is still listed');
  }
  // hostile bytes: nesting, size and pathological strings
  {
    const deepArray = new TextEncoder().encode('['.repeat(16000) + ']'.repeat(16000));
    const a = P.tryParseHudPreset(deepArray); ok(!a.ok && typeof a.error === 'string', 'sixteen thousand nested arrays are refused without a crash');
    const deepObject = new TextEncoder().encode('{"a":'.repeat(5000) + '1' + '}'.repeat(5000));
    ok(!P.tryParseHudPreset(deepObject).ok, 'five thousand nested objects are refused without a crash');
    const start = process.hrtime.bigint();
    const nasty = ['a'.repeat(1e6), '@'.repeat(1e5), 'a@'.repeat(5e4), 'a.'.repeat(5e4) + 'b', '0'.repeat(1e6), `s+${'1'.repeat(1e5)}`, `f0.${'0'.repeat(1e5)}`, `exp:${'1'.repeat(1e5)}`, `audio.${'x'.repeat(1e5)}`, `#${'f'.repeat(1e5)}`, ' '.repeat(1e6)];
    for (const text of nasty) {
      const m = allKinds();
      Object.assign(m, { title: text, id: text, pack: text, tags: [text] });
      m.layers[idx('label')].text = text; m.layers[idx('terminal')].lines = [text]; m.layers[idx('banner')].cues = [{ at: text, text }];
      m.layers[idx('dial')].v = { src: text, curve: text }; m.layers[idx('counter')].ease = text; m.palette.a1 = text; m.events.hits.from = text;
      const r = direct(m);
      ok(r.manifest === null && r.issues.length <= M.HUD_LIMITS.issues && r.issues.every(i => i.message.length < 300 && i.path.length < 80), `a ${text.length}-character pathological string is refused with bounded issues`);
    }
    ok(Number(process.hrtime.bigint() - start) / 1e9 < 20, 'and none of them costs seconds (no catastrophic pattern)');
  }
}

// ------------------------------------------------------------------------------------------------ fuzz: value mutations
{
  const junk = [null, true, false, 0, -1, 1, 2, 1.5, 0.5, 1e21, -1e21, NaN, Infinity, -Infinity, -0, 'x', '', 'x'.repeat(60), 'http://a.b', '#zzzzzz', '#ffffff', 'ltr', 'audio.rms', 'interval.progress', 'a1', 'ink', 's+1b', 'caf' + String.fromCharCode(0xe9),
    'A'.repeat(30), '__proto__', [], {}, [0, 0, 1, 1], [1, 2, 3, 4], [NaN], ['x'], { src: 'audio.rms' }, { a: 1 }];
  const pathsOf = (node, base = [], out = []) => { out.push(base); if (Array.isArray(node)) node.forEach((x, i) => pathsOf(x, [...base, i], out)); else if (node && typeof node === 'object') for (const k of Object.keys(node)) pathsOf(node[k], [...base, k], out); return out; };
  const at = (root, p) => p.reduce((n, k) => n[k], root);
  function mutate(root, r) {
    const ops = 1 + Math.floor(r() * 3);
    for (let n = 0; n < ops; n++) {
      const ps = pathsOf(root).filter(p => p.length), p = ps[Math.floor(r() * ps.length)], parent = at(root, p.slice(0, -1)), key = p[p.length - 1], t = r();
      if (t < 0.4) parent[key] = clone(junk[Math.floor(r() * junk.length)]);
      else if (t < 0.55) { if (Array.isArray(parent)) parent.splice(key, 1); else delete parent[key]; }
      else if (t < 0.65) { const target = at(root, p); if (target && typeof target === 'object' && !Array.isArray(target)) target[['zz', 'constructor', 'k', 'v', 'id', 'r'][Math.floor(r() * 6)]] = junk[Math.floor(r() * junk.length)]; else if (Array.isArray(target)) target.push(clone(target[0] ?? junk[3])); }
      else if (t < 0.75) { if (Array.isArray(parent)) parent.splice(key, 0, clone(parent[key])); }
      else if (t < 0.9) { if (typeof parent[key] === 'number') { const d = [1, -1, 0.5, 1e-7, 1e-6, 2, 0.001][Math.floor(r() * 7)]; parent[key] = r() < 0.15 ? -parent[key] : parent[key] + (r() < 0.5 ? d : -d); } else if (typeof parent[key] === 'string') parent[key] = parent[key].slice(0, Math.floor(r() * parent[key].length)) + (r() < 0.5 ? '' : 'q'); }
      else if (t < 0.95) { const other = at(root, ps[Math.floor(r() * ps.length)]); parent[key] = clone(other); }
      else { const tmp = parent[key]; const q = ps[Math.floor(r() * ps.length)]; const par2 = at(root, q.slice(0, -1)); parent[key] = par2[q[q.length - 1]]; par2[q[q.length - 1]] = tmp; }
    }
    return root;
  }
  const sources = [F.baseManifest(), F.duelManifest(), F.allKindsManifest(), F.intervalsManifest(), F.thinManifest(), F.kindManifest('banner', 'full'), F.kindManifest('terminal', 'full'), F.kindManifest('counter', 'full')];
  const r = rng(101);
  let accepted = 0, rejected = 0, acceptedChanged = 0;
  const outcomes = new Map();
  const ITER = 9000;
  for (let i = 0; i < ITER; i++) {
    const source = sources[i % sources.length], input = mutate(clone(source), r), snapshot = (() => { try { return JSON.stringify(input); } catch { return null; } })();
    let result;
    try { result = M.checkHudManifest(input); } catch (error) { assert.fail(`checkHudManifest threw on mutant ${i}: ${error?.stack ?? error}`); }
    if (snapshot !== null) eq(JSON.stringify(input), snapshot, 'the input is never mutated');
    ok(Array.isArray(result.issues) && result.issues.length <= M.HUD_LIMITS.issues, 'issues are a bounded list');
    ok(result.issues.every(x => (x.level === 'error' || x.level === 'warn') && typeof x.path === 'string' && typeof x.message === 'string' && x.message.length < 300), 'issues are well-formed');
    ok((result.manifest === null) === (errorsOf(result).length > 0), 'a manifest exists exactly when there is no error');
    if (result.manifest === null) { rejected++; for (const x of errorsOf(result).slice(0, 1)) outcomes.set(x.message.replace(/[0-9.]+/g, 'N').slice(0, 40), (outcomes.get(x.message.replace(/[0-9.]+/g, 'N').slice(0, 40)) ?? 0) + 1); continue; }
    accepted++;
    if (JSON.stringify(input) !== JSON.stringify(source)) acceptedChanged++;
    const m = result.manifest;
    ok(isDeepFrozen(m), 'an accepted manifest is deep-frozen');
    ok(schemaAccepts(JSON.parse(JSON.stringify(m))), `an accepted manifest satisfies the JSON Schema (mutant ${i}: ${validateSchema(schema, JSON.parse(JSON.stringify(m))).slice(0, 2)})`);
    const t = canonicalOf(m);
    ok(M.hudManifestBytes(m) <= P.HUD_MAX_BYTES, 'an accepted manifest fits the cap');
    const again = M.checkHudManifest(JSON.parse(t));
    ok(again.manifest !== null, `the canonical text of an accepted mutant re-parses (mutant ${i}: ${JSON.stringify(errorsOf(again).slice(0, 2))})`);
    eq(canonicalOf(again.manifest), t, 'and is a fixed point');
    eq(again.manifest, m, 'and parses to the same data');
    eq(JSON.stringify(M.checkHudManifest(input).manifest), JSON.stringify(m), 'and the same input gives the same output');
  }
  ok(accepted > 400 && rejected > 4000, `fuzz balance: ${accepted} accepted, ${rejected} rejected of ${ITER}`);
  ok(acceptedChanged > 100, `${acceptedChanged} accepted mutants actually differ from their source (the fuzz explores valid neighbours)`);
  ok(outcomes.size >= 25, `${outcomes.size} distinct first-error messages seen`);

  // byte-level mutations of .hud files: never anything but an Error, and an accepted mutant is a fixed point
  const seeds = sources.slice(1, 5).map(m => P.hudPresetBytes(M.checkHudManifest(m).manifest));
  const rb = rng(211);
  let byteAccepted = 0;
  for (let i = 0; i < 4000; i++) {
    const bytes = Array.from(seeds[i % seeds.length]);
    for (let n = 0, ops = 1 + Math.floor(rb() * 3); n < ops; n++) {
      const t = rb(), pos = Math.floor(rb() * bytes.length);
      if (t < 0.3) bytes[pos] = Math.floor(rb() * 256); else if (t < 0.5) bytes.splice(pos, 1); else if (t < 0.7) bytes.splice(pos, 0, Math.floor(rb() * 256));
      else if (t < 0.8) bytes.length = pos; else if (t < 0.9) bytes.splice(pos, 0, ...bytes.slice(pos, pos + Math.floor(rb() * 40))); else { const q = Math.floor(rb() * bytes.length); [bytes[pos], bytes[q]] = [bytes[q], bytes[pos]]; }
    }
    const u8 = Uint8Array.from(bytes);
    const soft = P.tryParseHudPreset(u8);
    if (soft.ok) {
      byteAccepted++;
      const canonical = P.hudPresetBytes(soft.manifest);
      eq(P.parseHudPreset(canonical), soft.manifest, 'a byte mutant that is accepted re-parses from its canonical bytes');
      eq(sha(P.hudPresetBytes(P.parseHudPreset(canonical))), sha(canonical), 'and its canonical bytes are a fixed point');
    } else { ok(typeof soft.error === 'string' && soft.error.length > 0 && Array.isArray(soft.issues), 'a rejected byte mutant carries a reason'); }
    try { P.parseHudPreset(u8); } catch (error) { ok(error instanceof Error, 'only Error objects are thrown'); }
  }
  ok(byteAccepted > 20, `${byteAccepted} of 4000 byte mutants are still valid manifests`);
}

// ------------------------------------------------------------------------------------------------ the schema tool
{
  const tool = path.join(root, 'tools/print-hud-schema.mjs');
  const node = args => execFileSync(process.execPath, [tool, ...args], { encoding: 'utf8', cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const fail = args => { try { execFileSync(process.execPath, [tool, ...args], { cwd: root, stdio: 'pipe' }); return 0; } catch (error) { return error.status; } };
  const printed = node([]);
  eq(printed, `${JSON.stringify(schema, null, 2)}\n`, 'the tool prints exactly hudJsonSchema() as two-space JSON with a trailing newline');
  ok(/21 instrument kinds/.test(node(['--summary'])), 'summary');
  const scratch = mkdtempSync(path.join(tmpdir(), 'hud-schema-'));
  try {
    const file = path.join(scratch, 'schema.json');
    ok(/Wrote/.test(node(['--out', file])) && readFileSync(file, 'utf8') === printed, '--out writes the schema');
    ok(/matches/.test(node(['--check', file])), '--check accepts a current copy');
    writeFileSync(file, printed.replace('"mpcaaavs-hud-1.schema.json"', '"other.schema.json"'));
    eq(fail(['--check', file]), 1, '--check fails on a stale copy');
    writeFileSync(file, printed.replace(/\n/g, '\r\n')); ok(/matches/.test(node(['--check', file])), '--check ignores line-ending differences');
    eq(fail(['--check', path.join(scratch, 'missing.json')]), 1, '--check fails on a missing file');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  eq(fail(['--bogus']), 2, 'an unknown option is refused'); eq(fail(['--out']), 2, '--out needs a path'); eq(fail(['--check']), 2, '--check needs a path');
}

// ------------------------------------------------------------------------------------------------ a generated tree of .hud files (validator tested on a synthetic tree; the real tree is git-ignored, contract C-28)
/** Validate every `.hud` file under `dir`: it parses, its bytes are the canonical bytes, its scene id is unique. Never throws; problems are listed in path order. */
function validateTree(dir) {
  const files = [], problems = [], ids = new Map(), tiers = { showcase: 0, tuned: 0, auto: 0 };
  const walk = current => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { problems.push(`${path.relative(dir, current) || '.'}: cannot be read`); return; }
    for (const entry of entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full); else if (entry.isFile() && entry.name.endsWith('.hud')) files.push(full);
    }
  };
  walk(dir);
  for (const file of files) {
    const rel = path.relative(dir, file).split(path.sep).join('/');
    const bytes = readFileSync(file), result = P.tryParseHudPreset(bytes);
    if (!result.ok) { problems.push(`${rel}: ${result.error}`); continue; }
    if (!Buffer.from(P.hudPresetBytes(result.manifest)).equals(bytes)) problems.push(`${rel}: is not the canonical form`);
    const id = result.manifest.id;
    if (ids.has(id)) problems.push(`${rel}: scene id ${id} repeats ${ids.get(id)}`); else ids.set(id, rel);
    tiers[result.manifest.meta?.tier ?? 'auto']++;
  }
  return { files: files.length, problems, tiers };
}
{
  const scratch = mkdtempSync(path.join(tmpdir(), 'hud-tree-'));
  try {
    const put = (rel, bytes) => { const file = path.join(scratch, ...rel.split('/')); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes); };
    const canonical = fx => P.hudPresetBytes(M.checkHudManifest(fx).manifest);
    put('packs/one/duel.hud', canonical(F.duelManifest())); put('packs/one/deep/er/thin.hud', canonical(F.thinManifest())); put('top.hud', canonical(F.intervalsManifest()));
    put('packs/one/readme.txt', 'not a scene'); put('packs/one/notes.HUD', 'wrong case is not a scene');
    const clean = validateTree(scratch);
    eq([clean.files, clean.problems, clean.tiers], [3, [], { showcase: 0, tuned: 1, auto: 2 }], 'a clean synthetic tree validates and counts tiers');
    eq(validateTree(path.join(scratch, 'missing')), { files: 0, problems: ['.: cannot be read'], tiers: { showcase: 0, tuned: 0, auto: 0 } }, 'a missing tree is reported, not thrown');
    put('packs/two/copy.hud', canonical(F.duelManifest()));                         // repeated scene id
    put('packs/two/loose.hud', new TextEncoder().encode(JSON.stringify(F.baseManifest())));  // valid but not canonical
    put('packs/two/broken.hud', 'not json'); put('packs/two/empty.hud', new Uint8Array(0)); put('packs/two/wrong.hud', canonical(F.duelManifest()).slice(0, 40)); // not JSON, empty, truncated
    const dirty = validateTree(scratch);
    eq(dirty.files, 8, 'every .hud file is visited (nested folders included)');
    eq(dirty.problems.map(x => x.split(':')[0]), ['packs/two/broken.hud', 'packs/two/copy.hud', 'packs/two/empty.hud', 'packs/two/loose.hud', 'packs/two/wrong.hud'], 'the five bad files are reported, in path order, and the clean ones are not');
    ok(dirty.problems.some(x => /repeats packs\/one\/duel\.hud/.test(x)) && dirty.problems.some(x => /canonical form/.test(x)) && dirty.problems.some(x => /empty/.test(x)) && dirty.problems.some(x => /JSON/.test(x)), 'each kind of problem is named');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  const local = validateTree(path.join(root, 'hud-presets'));
  if (!local.files && local.problems.length) console.log('no local hud-presets tree: generated-pack validation skipped (public checks use synthetic fixtures)');
  else {
    eq(local.problems, [], `the local generated tree (${local.files} scenes) is valid, canonical and unique`);
    console.log(`validated ${local.files} generated scenes (${JSON.stringify(local.tiers)})`);
  }
}

// ------------------------------------------------------------------------------------------------ hygiene: neutral wording, no private data, no clocks or randomness
{
  const strip = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
  const files = ['src/hud/hud-manifest.ts', 'src/hud-preset.ts', 'src/hud/hud-clock.ts'];
  for (const file of files) {
    const code = strip(readFileSync(path.join(root, file), 'utf8'));
    for (const banned of ['Math.random', 'Date.now', 'performance.now', 'new Date', 'localStorage', 'sessionStorage', 'document.', 'window.', 'fetch(', 'XMLHttpRequest', 'eval(', 'new Function']) ok(!code.includes(banned), `${file} must not use ${banned}`);
    const source = readFileSync(path.join(root, file), 'utf8');
    ok(!source.includes('\r'), `${file} uses LF line endings`); ok(![...source].some(ch => ch.charCodeAt(0) > 127), `${file} is ASCII`);
  }
  const private_ = [['C:', BS + 'Users'].join(''), ['hot', 'gh'].join(''), ['@', 'gmail'].join(''), ['Levon', 'French'].join(''), ['J:', BS + 'projects'].join(''), ['J:', '/projects'].join('')];
  for (const file of [...files, 'tools/fixtures-hud.mjs', 'tools/check-hud-manifest.mjs', 'tools/print-hud-schema.mjs', 'tools/check-hud-clock.mjs']) {
    const text = readFileSync(path.join(root, file), 'utf8');
    for (const word of private_) ok(!text.includes(word), `${file} must not contain a private path or name`);
  }
  // the fixtures name no real title, developer or publisher
  const franchises = ['doom', 'mario', 'sonic', 'zelda', 'capcom', 'sega', 'nintendo', 'konami', 'atari', 'namco', 'snk', 'tekken', 'quake', 'wolfenstein', 'castlevania', 'megaman', 'gradius', 'diablo', 'predator', 'terminator', 'evangelion', 'robocop', 'pacman', 'tetris', 'nerv', 'magi'];
  for (const [name, m] of fixtures) for (const s of M.hudScannedStrings(m)) for (const w of M.hudWords(s)) ok(!franchises.includes(w), `${name}: fixture text ${JSON.stringify(s)} names a real title`);
  ok(fixtures.every(([, m]) => !JSON.stringify(m).includes('://') && !/data:/i.test(JSON.stringify(m))), 'fixtures carry no URLs or data URIs');
  for (const s of fixtures.flatMap(([, m]) => M.hudScannedStrings(m))) ok(s.length <= 48, 'fixture strings are at most 48 characters');
}

console.log(`HUD manifest: ${checks} checks. 21 kinds, strict parser, IP-safety lint, deny-list hook, canonical round trip, JSON Schema parity, .hud framing and identity, layout archetypes and fuzz PASS (CPU-only)`);
