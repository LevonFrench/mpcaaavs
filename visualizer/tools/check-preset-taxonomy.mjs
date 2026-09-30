import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// CPU checks for the style classifier (docs/design/PRESET-TAXONOMY-AND-JEV.md 9, docs/design/CONTRACT.md 2.3.10): table integrity,
// synthetic presets (built directly and through the real parser and compatibility registry), boundaries, determinism, robustness,
// confidence, titles and authors, the payload allowlist of jevState, and the guard against the private effect-name table in
// editor-model.ts. Synthetic data only. The optional corpus bands read the local collection read-only and are skipped when it is absent.
const src = rel => fileURLToPath(new URL(`../src/${rel}`, import.meta.url));
const entry = `
export { parseAvsPreset } from ${JSON.stringify(src('avs/preset.ts'))};
export { createAvsCompatibilityRegistry } from ${JSON.stringify(src('avs/effects/registry.ts'))};
export * from ${JSON.stringify(src('avs/preset-taxonomy.ts'))};
export { TAXONOMY as CATEGORY_TABLE, TAXONOMY_VERSION as CATEGORY_VERSION } from ${JSON.stringify(src('avs/preset-categories.ts'))};
export { AVS_COLOR_MAP_APE_ID, AVS_TEXER_APE_ID, AVS_TEXER_II_APE_ID } from ${JSON.stringify(src('avs/effects/index.ts'))};
export * as constants from ${JSON.stringify(src('avs/effects/index.ts'))};
`;
const bundled = await build({ stdin: { contents: entry, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'node' });
const T = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const registry = T.createAvsCompatibilityRegistry({ randomInt: () => 0 });
const has = c => registry.handler(c) !== undefined;
const ID = Object.fromEntries(T.BUILTIN_NAMES.map((n, i) => [n, i]));
const IDS = ['scope-classic', 'scope-geometry', 'rings-stars', 'particles', 'starfield', 'perspective-3d', 'tunnel-zoom', 'spin-rotate', 'kaleido-mirror',
  'water-ripple', 'bump-relief', 'color-grade', 'glitch-digital', 'beat-flash', 'text-image', 'multi-scene', 'minimal', 'mixed'];
const STRUCTURAL = ['multi-scene', 'minimal', 'mixed'];

// ---- 1. integrity -------------------------------------------------------------------------------------------------------
{
  assert.equal(T.TAXONOMY, T.CATEGORY_TABLE, 'the classifier re-exports the table of preset-categories.ts, it does not copy it');
  assert.equal(T.TAXONOMY_VERSION, T.CATEGORY_VERSION);
  assert.deepEqual(T.TAXONOMY.map(t => t.id), IDS, 'table order is the tie-break order of the contract');
  assert.equal(new Set(T.TAXONOMY.map(t => t.id)).size, 18);
  const families = {};
  for (const t of T.TAXONOMY) { assert.ok(t.label && t.family, t.id); (families[t.family] ??= []).push(t.id); }
  assert.deepEqual(T.TAXONOMY.map(t => t.label), ['Waveforms & Oscilloscopes', 'Superscope Geometry', 'Rings, Stars & Radial', 'Particles & Dot Fields', 'Starfields & Flight', '3D & Perspective',
    'Tunnels, Zoom & Echo Feedback', 'Spin & Rotate', 'Kaleidoscope & Mirror', 'Water & Ripples', 'Bump, Relief & Convolution', 'Colour Maps & Grading', 'Glitch & Digital Decay',
    'Beat Flash & Strobe', 'Text, Pictures & Video', 'Layered Multi-scene', 'Minimal & Fragments', 'General Mix'], 'labels equal the contract table');
  assert.deepEqual(Object.keys(families), ['Scopes', 'Particles & Space', 'Feedback & Motion', 'Surface & Colour', 'Beat & Frame', 'Structure']);
  assert.deepEqual(Object.keys(T.TAXONOMY_DEFINITIONS).sort(), IDS.slice().sort(), 'a definition for every category and no extra');
  for (const text of Object.values(T.TAXONOMY_DEFINITIONS)) assert.ok(typeof text === 'string' && text.length > 8);

  assert.equal(T.BUILTIN_NAMES.length, 46);
  assert.equal(new Set(T.BUILTIN_NAMES).size, 46);
  const known = new Set(T.KNOWN_APES);
  assert.equal(known.size, T.KNOWN_APES.length, 'KNOWN_APES has no duplicates');
  for (const constant of ['AVS_COLOR_MAP_APE_ID', 'AVS_CONVOLUTION_APE_ID', 'AVS_MULTIFILTER_APE_ID', 'AVS_CHANNEL_SHIFT_APE_ID', 'AVS_COLOR_REDUCTION_APE_ID', 'AVS_MULTIPLIER_APE_ID', 'AVS_TEXER_APE_ID', 'AVS_TEXER_II_APE_ID']) {
    assert.equal(typeof T.constants[constant], 'string', constant);
    assert.ok(known.has(T.constants[constant]), `${constant} is a known APE`);
  }
  for (const [key, weights] of T.TAXONOMY_WEIGHTS) {
    const builtin = /^b(\d+)$/.exec(key);
    assert.ok(builtin ? Number(builtin[1]) < 46 : key.startsWith('ape:') && known.has(key.slice(4)), `weight key ${key} is a known built-in id or APE`);
    for (const [category, weight] of Object.entries(weights)) {
      assert.ok(IDS.includes(category) && !STRUCTURAL.includes(category), `${key} feeds a style category, not ${category}`);
      assert.ok(weight > 0 && weight <= 5, `${key} ${category}`);
    }
  }
  for (const engine of ['Movement', 'Dynamic Movement', 'Blur', 'Fade Out', 'Comment', 'Set Render Mode', 'Fast Brightness']) {
    assert.ok(!T.TAXONOMY_WEIGHTS.has(`b${ID[engine]}`), `${engine} carries no direct weight`);
  }
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) assert.ok(Math.abs(T.COUNT_FACTOR[n] - (1 + 0.35 * Math.log2(n))) < 1e-6, `count factor ${n}`);
  assert.equal(T.COUNT_FACTOR.length, 9);

  // guard: no fourth silent copy of the effect names. editor-model.ts is read as text and never edited.
  const editor = readFileSync(src('avs/editor-model.ts'), 'utf8');
  const block = /const BUILTIN_RENDERER_NAMES = \[([\s\S]*?)\] as const;/.exec(editor);
  assert.ok(block, 'BUILTIN_RENDERER_NAMES is still declared in editor-model.ts');
  const editorNames = [...block[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(editorNames, [...T.BUILTIN_NAMES], 'BUILTIN_NAMES equals BUILTIN_RENDERER_NAMES of editor-model.ts');

  // the module is pure: no clock, randomness, network or DOM
  const source = readFileSync(src('avs/preset-taxonomy.ts'), 'utf8');
  for (const banned of ['Math.random', 'Date.now', 'performance.now', 'fetch(', 'document.', 'window.', 'localStorage', 'process.']) assert.ok(!source.includes(banned), `no ${banned}`);
  assert.ok(!/[^\x00-\x7f]/.test(source), 'the source is plain ASCII');
}

// ---- helpers to build synthetic compositions -----------------------------------------------------------------------------
const zero = { ssLines: 0, ssDots: 0, ssZ: 0, ssPolar: 0, mvBuiltin: 0, mvScript: 0, mvKaleido: 0, unsupported: 0, decoded: true };
const comp = (effects = {}, extra = {}) => {
  const fx = {};
  for (const [name, n] of Object.entries(effects)) fx[name.startsWith('ape:') ? name : `b${ID[name]}`] = n;
  const total = extra.components ?? Object.values(fx).reduce((a, b) => a + b, 0) + (extra.lists ?? 0);
  return { components: total, lists: extra.lists ?? 0, maxDepth: extra.maxDepth ?? 0, beatLists: extra.beatLists ?? 0, effects: fx, detail: { ...zero, ...(extra.detail ?? {}) }, unrunnable: extra.unrunnable ?? [] };
};
const filler = n => ({ Comment: n }); // components with no weight and no rule
const classify = (effects, extra) => T.classifyComposition(comp(effects, extra));
const primary = (effects, extra) => classify(effects, extra).primary;

// ---- 2. table-driven synthetic compositions -------------------------------------------------------------------------------
{
  const cases = [
    ['Starfield + Blur + Movement -> starfield', { Starfield: 1, Blur: 1, Movement: 1, Comment: 1 }, {}, 'starfield'],
    ['Water + Movement -> water-ripple', { Water: 1, Movement: 1, Comment: 1, 'Set Render Mode': 1 }, {}, 'water-ripple'],
    ['Mirror -> kaleido-mirror', { Mirror: 1, Comment: 3 }, {}, 'kaleido-mirror'],
    ['Oscilloscope Star -> rings-stars', { 'Oscilloscope Star': 1, Comment: 3 }, {}, 'rings-stars'],
    ['five line SuperScopes -> scope-geometry', { SuperScope: 5 }, { detail: { ssLines: 5 } }, 'scope-geometry'],
    ['one z-assigning SuperScope -> perspective-3d', { SuperScope: 1, Comment: 4 }, { detail: { ssDots: 1, ssZ: 1 } }, 'perspective-3d'],
    ['OnBeat Clear + beat-render list -> beat-flash', { 'OnBeat Clear': 1, Comment: 3 }, { lists: 1, beatLists: 1 }, 'beat-flash'],
    ['Text -> text-image', { Text: 1, Comment: 3 }, {}, 'text-image'],
    ['one component -> minimal', { Comment: 1 }, {}, 'minimal'],
    ['nothing distinctive -> mixed', { Movement: 1, 'Fade Out': 1, Comment: 3 }, { detail: { mvScript: 1 } }, 'mixed'],
    ['Ring -> rings-stars', { Ring: 1, Comment: 3 }, {}, 'rings-stars'],
    ['Dot Grid -> particles', { 'Dot Grid': 1, Comment: 3 }, {}, 'particles'],
    ['Simple -> scope-classic', { Simple: 1, Comment: 3 }, {}, 'scope-classic'],
    ['Dot Plane -> perspective-3d', { 'Dot Plane': 1, Comment: 3 }, {}, 'perspective-3d'],
    ['Blitter Feedback + engine -> tunnel-zoom', { 'Blitter Feedback': 1, Movement: 1, Blur: 1, Comment: 2 }, { detail: { mvScript: 1 } }, 'tunnel-zoom'],
    ['Roto Blitter -> spin-rotate', { 'Roto Blitter': 1, Comment: 3 }, {}, 'spin-rotate'],
    ['Bump -> bump-relief', { Bump: 1, Comment: 3 }, {}, 'bump-relief'],
    ['Color Map -> color-grade', { 'ape:Color Map': 1, Comment: 3 }, {}, 'color-grade'],
    ['Interferences -> glitch-digital', { Interferences: 1, Comment: 3 }, {}, 'glitch-digital'],
    ['kaleidoscope movement -> kaleido-mirror', { Movement: 1, Comment: 3 }, { detail: { mvBuiltin: 1, mvKaleido: 1 } }, 'kaleido-mirror'],
    ['dot-mode SuperScopes -> particles', { SuperScope: 3, Comment: 2 }, { detail: { ssDots: 3 } }, 'particles'],
    ['Texer sprites -> particles', { 'ape:Texer': 1, Comment: 3 }, {}, 'particles'],
    ['50 unremarkable components -> multi-scene', filler(50), {}, 'multi-scene'],
    ['8 lists and nothing else -> multi-scene', { Comment: 4 }, { lists: 8 }, 'multi-scene'],
  ];
  for (const [label, effects, extra, expected] of cases) assert.equal(primary(effects, extra), expected, label);
  for (const id of IDS.filter(id => !STRUCTURAL.includes(id))) assert.ok(cases.some(c => c[3] === id), `${id} is reachable in the table`);

  // partial fidelity and tags
  const star = classify({ 'Oscilloscope Star': 1, Comment: 3 }, { detail: { unsupported: 1 }, unrunnable: ['b2'] });
  assert.equal(star.primary, 'rings-stars'); assert.equal(star.facets.f, 'partial');
  assert.equal(classify({ Ring: 1, Comment: 3 }).facets.f, 'full');
  const mixedTag = classify({ Ring: 1, Water: 1, Comment: 3 });
  assert.equal(mixedTag.primary, 'rings-stars', 'ties resolve by table order: rings-stars before water-ripple');
  assert.deepEqual(mixedTag.tags, ['water-ripple']);
  const three = classify({ Ring: 1, Water: 1, Bump: 1, Grain: 1, Comment: 3 });
  assert.equal(three.tags.length, 2, 'at most two tags');
  assert.ok(!three.tags.includes(three.primary));
  const large = classify({ Ring: 1, ...filler(50) });
  assert.deepEqual([large.primary, large.tags[0]], ['multi-scene', 'rings-stars'], 'a weak style on a large preset is kept as a tag');
  const bigStyle = classify({ Simple: 1, Timescope: 1, ...filler(50) }, { detail: { ssLines: 1 } });
  assert.equal(bigStyle.primary, 'scope-classic', 'a style at 6.0 or more keeps a large preset');
  assert.equal(bigStyle.tags[0], 'multi-scene');

  // facets
  const b = n => T.facetsOf(comp(filler(n))).b;
  assert.deepEqual([1, 5, 6, 12, 13, 22, 23, 40, 41, 300].map(b), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5], 'busyness bounds');
  const e = (effects, extra) => T.facetsOf(comp(effects, extra)).e;
  assert.equal(e(filler(4)), 'calm'); assert.equal(e(filler(15)), 'steady');
  assert.equal(e({ 'Custom BPM': 1, ...filler(3) }), 'driving');
  assert.equal(e({ 'Custom BPM': 1, ...filler(30) }), 'intense');
  assert.equal(e({ 'OnBeat Clear': 1, Invert: 1, ...filler(2) }), 'intense');
  assert.equal(e(filler(4), { lists: 1, beatLists: 1 }), 'driving');
  assert.equal(T.facetsOf(comp(filler(4))).beat, 'flowing'); assert.equal(T.facetsOf(comp({ 'OnBeat Clear': 1, ...filler(4) })).beat, 'reactive');
}

// ---- 3. ubiquitous engines never flood a category --------------------------------------------------------------------------
let seed = 0x1234abcd;
const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
const pick = list => list[Math.floor(rand() * list.length)];
const styleNames = [...T.TAXONOMY_WEIGHTS.keys()];
const randomComposition = () => {
  const effects = {};
  for (let i = 0, n = 1 + Math.floor(rand() * 5); i < n; i++) { const key = pick(styleNames); effects[key] = (effects[key] ?? 0) + 1 + Math.floor(rand() * 3); }
  const detail = { ...zero, ssLines: Math.floor(rand() * 3), ssDots: Math.floor(rand() * 3), ssZ: rand() < 0.15 ? 1 : 0, ssPolar: rand() < 0.3 ? 1 : 0, mvBuiltin: Math.floor(rand() * 2), mvScript: Math.floor(rand() * 2), mvKaleido: rand() < 0.1 ? 1 : 0 };
  const total = Object.values(effects).reduce((a, x) => a + x, 0) + Math.floor(rand() * 8);
  return { components: Math.min(total, 30), lists: Math.floor(rand() * 4), maxDepth: 1, beatLists: Math.floor(rand() * 2), effects, detail, unrunnable: [] };
};
const withMore = (c, extra, extraComponents = null) => {
  const effects = { ...c.effects };
  let added = 0;
  for (const [name, n] of Object.entries(extra)) { const key = `b${ID[name]}`; effects[key] = (effects[key] ?? 0) + n; added += n; }
  return { ...c, components: c.components + (extraComponents ?? added), effects };
};
{
  let checked = 0;
  for (let i = 0; i < 200; i++) {
    const c = randomComposition();
    const base = T.scoreComposition(c);
    // 1. components that carry no weight and feed no rule never change a score
    const noise = withMore(c, { Comment: 1 + Math.floor(rand() * 9), 'Set Render Mode': 1 + Math.floor(rand() * 4), 'Fast Brightness': 1 + Math.floor(rand() * 3) });
    assert.deepEqual(T.scoreComposition(noise), base, 'Comment, Set Render Mode and Fast Brightness never move a score');
    // 2. the whole engine set moves only tunnel-zoom, by at most the two count-driven bonuses
    const engines = withMore(c, { Movement: 2, 'Dynamic Movement': 3, Blur: 2, 'Fade Out': 2 });
    const after = T.scoreComposition(engines);
    for (const id of IDS) if (id !== 'tunnel-zoom') assert.equal(after[id], base[id], `${id} unchanged by engines`);
    assert.ok(after['tunnel-zoom'] - base['tunnel-zoom'] <= 1.6 + 0.6 + 1e-9);
    // 3. once an engine and a decay effect and two dynamic movements are present, more of them change nothing
    const saturated = withMore(c, { Movement: 1, 'Dynamic Movement': 2, Blur: 1, 'Fade Out': 1 });
    const more = withMore(saturated, { Movement: 3, 'Dynamic Movement': 4, Blur: 2, 'Fade Out': 5 });
    assert.deepEqual(T.scoreComposition(more), T.scoreComposition(saturated), 'engine bonuses saturate');
    assert.equal(T.classifyComposition(more).primary, T.classifyComposition(saturated).primary);
    checked++;
  }
  assert.equal(checked, 200);
  // a decisive non-tunnel primary survives the whole engine set when its lead exceeds the bounded bonus
  const decisive = comp({ Starfield: 3, Water: 1, Comment: 4 }); // starfield well ahead
  const decisiveAfter = withMore(decisive, { Movement: 2, 'Dynamic Movement': 3, Blur: 2, 'Fade Out': 2 });
  assert.ok(T.classifyComposition(decisive).k >= 0.6);
  assert.equal(T.classifyComposition(decisiveAfter).primary, 'starfield');
}

// ---- 4. boundaries -----------------------------------------------------------------------------------------------------------
{
  // components 3 / 4
  assert.equal(primary({ Ring: 1, Comment: 2 }), 'minimal'); assert.equal(primary({ Ring: 1, Comment: 3 }), 'rings-stars');
  assert.equal(primary({}, { components: 0 }), 'minimal', 'an empty preset is minimal');
  // components 44 / 45 (weak style, so the override decides)
  assert.equal(primary({ Ring: 1, ...filler(43) }), 'rings-stars');
  assert.equal(primary({ Ring: 1, ...filler(44) }), 'multi-scene');
  assert.equal(primary({ Mosaic: 1, ...filler(43) }, {}), 'glitch-digital');
  // lists 7 / 8
  assert.equal(primary({ Ring: 1, Comment: 5 }, { lists: 7 }), 'rings-stars'); assert.equal(primary({ Ring: 1, Comment: 5 }, { lists: 8 }), 'multi-scene');
  // top score just below and at 2.0 (mixed threshold): Custom BPM is 1.5, Mosaic is exactly 2.0
  assert.equal(primary({ 'Custom BPM': 1, Comment: 4 }), 'mixed'); assert.equal(primary({ Mosaic: 1, Comment: 4 }), 'glitch-digital');
  // top score just below and at 6.0 (a large preset keeps its style): Simple + Timescope = 5.0, plus one line SuperScope = 6.0 exactly
  const below = classify({ Simple: 1, Timescope: 1, ...filler(50) }); const at = classify({ Simple: 1, Timescope: 1, ...filler(50) }, { detail: { ssLines: 1 } });
  assert.equal(below.score, 5); assert.equal(below.primary, 'multi-scene');
  assert.equal(at.score, 6); assert.equal(at.primary, 'scope-classic');
  // tag threshold: a tag needs max(2.0, 0.6 * top)
  assert.deepEqual(classify({ Text: 2, Mosaic: 1, Comment: 3 }).tags, [], 'Mosaic 2.0 is under 0.6 * 4.725');
  assert.deepEqual(classify({ Text: 1, Mosaic: 1, Comment: 3 }).tags, [], '2.0 < max(2.0, 0.6 * 3.5 = 2.1)');
  assert.deepEqual(classify({ Text: 1, Scatter: 1, Comment: 3 }).tags, ['glitch-digital'], '2.5 >= 2.1');
  assert.deepEqual(classify({ Simple: 1, Mosaic: 1, Comment: 3 }).tags, ['glitch-digital'], '2.0 >= max(2.0, 0.6 * 3.0 = 1.8)');
  assert.deepEqual(classify({ Text: 1, Simple: 1, Water: 1, Bump: 1, Comment: 3 }).tags, ['scope-classic', 'water-ripple'], 'at most two tags, in table order');
  // tie-break by table order, independent of key order
  const tieA = { ...comp({ Ring: 1, Simple: 1, Comment: 3 }) };
  const tieB = { ...tieA, effects: Object.fromEntries(Object.entries(tieA.effects).reverse()) };
  assert.equal(T.classifyComposition(tieA).primary, 'scope-classic'); assert.equal(T.classifyComposition(tieB).primary, 'scope-classic');
  assert.deepEqual(T.classifyComposition(tieA), T.classifyComposition(tieB));
}

// ---- 5. determinism and order independence (through the real parser and registry) --------------------------------------------
const le32 = n => { const b = Buffer.alloc(4); b.writeInt32LE(n | 0); return b; };
const cstr = s => Buffer.from(`${s}\0`, 'latin1');
const lp = s => Buffer.concat([le32(Buffer.byteLength(s) + 1), cstr(s)]);
const rec = (id, payload = Buffer.alloc(0), ape = null) => Buffer.concat([le32(id), ...(ape ? [Buffer.from(ape.padEnd(32, '\0'), 'latin1')] : []), le32(payload.length), payload]);
const builtin = (name, payload) => rec(ID[name], payload);
const ape = (name, payload) => rec(16384, payload, name);
const listBytes = (children, beat = false) => {
  const head = Buffer.alloc(37); head[0] = 0x80; head[4] = 0x24; if (beat) head.writeInt32LE(1, 29);
  return rec(-2, Buffer.concat([head, ...children]));
};
const superscope = (code, lines = true) => builtin('SuperScope', Buffer.concat([Buffer.from([1]), lp(code.point ?? ''), lp(code.frame ?? ''), lp(code.beat ?? ''), lp(code.init ?? ''), le32(2), le32(1), le32(0xffffff), le32(lines ? 1 : 0)]));
const movement = (effect, expression = '') => builtin('Movement', Buffer.concat([le32(effect), ...(effect === 32767 ? [Buffer.from([1]), le32(Buffer.byteLength(expression) + 1), cstr(expression)] : []), le32(0), le32(0), le32(0), le32(0), le32(0)]));
const preset = (...records) => Buffer.concat([Buffer.from('Nullsoft AVS Preset 0.2\x1a', 'latin1'), Buffer.from([0]), ...records]);
const composed = (...records) => T.compositionOf(T.parseAvsPreset(new Uint8Array(preset(...records))), has);
{
  const records = [
    superscope({ point: 'x=i;y=v;z=1+v' }, false), movement(32767, 'r=r*0.9;d=d+0.1'), builtin('Blur'), builtin('Fade Out'), builtin('Comment'),
    builtin('Water'), ape('Color Map'), ape('Holden04: Video Delay'), builtin('Oscilloscope Star'), listBytes([builtin('Ring'), superscope({ point: 'x=i;y=v' }, true), listBytes([builtin('Mosaic')])], true),
  ];
  const base = composed(...records);
  assert.equal(base.components, 14); assert.equal(base.lists, 2); assert.equal(base.maxDepth, 2); assert.equal(base.beatLists, 1);
  assert.equal(base.effects.b36, 2); assert.equal(base.effects['ape:Color Map'], 1);
  assert.deepEqual({ ssLines: base.detail.ssLines, ssDots: base.detail.ssDots, ssZ: base.detail.ssZ, mvScript: base.detail.mvScript, mvBuiltin: base.detail.mvBuiltin }, { ssLines: 1, ssDots: 1, ssZ: 1, mvScript: 1, mvBuiltin: 0 });
  assert.equal(base.detail.decoded, true);
  assert.deepEqual([...base.unrunnable].sort(), ['ape:Holden04: Video Delay', 'b2'], 'the real registry cannot run Oscilloscope Star or Video Delay');
  assert.equal(base.detail.unsupported, 2);
  assert.deepEqual(Object.keys(base.effects), Object.keys(base.effects).sort(), 'effect keys are sorted');
  const cls = T.classifyComposition(base);
  assert.equal(cls.facets.f, 'partial');
  assert.deepEqual(T.classifyComposition(composed(...records)), cls, 'running twice gives the same answer');
  assert.equal(JSON.stringify(T.classifyComposition(JSON.parse(JSON.stringify(base)))), JSON.stringify(cls), 'a JSON round trip of the composition classifies the same');

  // permuting top-level order changes nothing; flattening or nesting changes only the structure counters
  const top = records.slice(0, 9);
  for (let i = 0; i < 25; i++) {
    const shuffled = top.map(r => [rand(), r]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
    const c = composed(...shuffled, records[9]);
    assert.deepEqual([c.effects, c.detail, c.unrunnable, c.components, c.lists], [base.effects, base.detail, base.unrunnable, base.components, base.lists]);
    assert.deepEqual(T.classifyComposition(c), cls);
  }
  const nested = composed(listBytes(top.slice(0, 4)), listBytes(top.slice(4)), records[9]);
  assert.deepEqual([nested.effects, nested.detail, nested.unrunnable], [base.effects, base.detail, base.unrunnable]);
  assert.equal(nested.lists, base.lists + 2); assert.equal(nested.components, base.components + 2);
  const deepStyle = composed(listBytes([builtin('Water'), listBytes([builtin('Comment')])]), builtin('Comment'), builtin('Comment'));
  assert.equal(deepStyle.maxDepth, 2);

  // SuperScope z detection: assignment, not comparison or member access
  const z = code => composed(superscope({ point: code })).detail.ssZ;
  assert.equal(z('z=1'), 1); assert.equal(z('x=1;z2 = 4'), 1); assert.equal(z('persp=2'), 1);
  assert.equal(z('x=z==1'), 0); assert.equal(z('x=1;y=2'), 0);
  // kaleidoscope movement: built-in 23 and an angular script; others are not
  const mv = (effect, expr) => composed(movement(effect, expr)).detail;
  assert.equal(mv(23).mvKaleido, 1); assert.equal(mv(23).mvBuiltin, 1); assert.equal(mv(3).mvKaleido, 0);
  assert.deepEqual([mv(32767, 'y=(atan2(y,x)*6)/$pi').mvKaleido, mv(32767, 'x=x+0.1').mvKaleido, mv(32767, 'x=x+0.1').mvScript], [1, 0, 1]);
}

// ---- 6. robustness -----------------------------------------------------------------------------------------------------------
{
  // empty and garbage presets never throw
  const empty = composed();
  assert.deepEqual([empty.components, empty.lists, empty.maxDepth], [0, 0, 0]);
  assert.equal(T.classifyComposition(empty).primary, 'minimal'); assert.equal(T.classifyComposition(empty).k, 0.9);
  // unknown APE id and unusual ids
  const odd = composed(ape('Totally Unknown APE'), rec(60), builtin('Comment'), builtin('Comment'), builtin('Comment'));
  assert.equal(odd.effects['ape:Totally Unknown APE'], 1); assert.equal(odd.effects.b60, 1);
  assert.equal(odd.detail.unsupported, 2);
  const bare = (effectId, apeId = null) => ({ effectId, apeId, payload: new Uint8Array(0), fileOffset: 0, path: '1', children: [], list: null, listCode: null });
  const weird = T.compositionOf({ components: [bare(-5), bare(2147483647), bare(-2147483648), bare(7)] }, () => false);
  assert.deepEqual([weird.effects['b-5'], weird.effects.b2147483647, weird.effects['b-2147483648'], weird.effects.b7], [1, 1, 1, 1]);
  assert.equal(T.classifyComposition(weird).facets.f, 'partial');
  const plain = classify({ Comment: 6 }), withUnknown = T.classifyComposition(odd);
  assert.equal(withUnknown.primary, 'mixed'); assert.equal(plain.primary, 'mixed');
  assert.equal(withUnknown.facets.f, 'partial'); assert.equal(plain.facets.f, 'full');
  const base = comp({ Ring: 1, Comment: 3 }), extra = comp({ Ring: 1, Comment: 3, 'ape:Totally Unknown APE': 1 }, { components: 5, detail: { unsupported: 1 } });
  const cb = T.classifyComposition(base), ce = T.classifyComposition(extra);
  assert.deepEqual([ce.primary, ce.tags, ce.k, ce.score], [cb.primary, cb.tags, cb.k, cb.score], 'an unknown effect changes only fidelity and structure');
  assert.equal(ce.facets.f, 'partial');
  // corrupt payloads: decoders may fail, the classifier records decoded:false and continues
  const bad = composed(builtin('SuperScope', Buffer.from([1, 255, 255, 255, 255])), builtin('Movement', Buffer.from([0xff])), builtin('Comment'), builtin('Comment'));
  assert.equal(typeof bad.detail.decoded, 'boolean'); assert.ok(T.classifyComposition(bad).primary);
  // a throwing registry probe counts as unsupported
  const thrown = T.compositionOf(T.parseAvsPreset(new Uint8Array(preset(builtin('Ring')))), () => { throw new Error('boom'); });
  assert.equal(thrown.detail.unsupported, 1);
  // hostile depth does not overflow the stack
  let deep = { effectId: 5, apeId: null, payload: new Uint8Array(0), fileOffset: 0, path: '1', children: [], list: null, listCode: null };
  for (let i = 0; i < 200000; i++) deep = { effectId: -2, apeId: null, payload: new Uint8Array(0), fileOffset: 0, path: '1', children: [deep], list: null, listCode: null };
  const deepComposition = T.compositionOf({ components: [deep] }, () => true);
  assert.equal(deepComposition.lists, 200000); assert.equal(deepComposition.maxDepth, 200000); assert.equal(deepComposition.effects.b5, 1);
  // key explosion is capped
  const many = { components: Array.from({ length: 400 }, (_, i) => ({ effectId: 16384, apeId: `Ape ${i}`, payload: new Uint8Array(0), fileOffset: 0, path: String(i), children: [], list: null, listCode: null })) };
  const capped = T.compositionOf(many, () => true);
  assert.equal(Object.keys(capped.effects).length, 257); assert.equal(capped.effects.other, 144); assert.equal(capped.components, 400);
  // malformed compositions from JSON never throw and never use inherited keys
  for (const junk of [null, undefined, 0, 'x', [], {}, { effects: null }, { components: -5, effects: { b3: -1, b4: 'x', b5: NaN, b6: Infinity } }, JSON.parse('{"effects":{"__proto__":9,"constructor":3,"b1":2,"ape:__proto__":1},"components":9,"detail":{"ssZ":"1"}}')]) {
    const c = T.classifyComposition(junk);
    assert.ok(IDS.includes(c.primary) && c.k >= 0 && c.k <= 1 && Array.isArray(c.tags), JSON.stringify(junk));
    assert.ok(!Object.prototype.hasOwnProperty.call(T.normalizeComposition(junk).effects, '__proto__'));
  }
  const inherited = T.normalizeComposition(JSON.parse('{"effects":{"__proto__":9,"b1":2}}'));
  assert.deepEqual(inherited.effects, { b1: 2 });
  assert.equal(T.classifyComposition(JSON.parse('{"components":9,"effects":{"__proto__":9,"constructor":3}}')).primary, 'mixed');
  // replay safety: a deep-frozen input classifies without mutation, and huge or fractional counters clamp instead of overflowing
  const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
  const frozen = freeze(comp({ Starfield: 2, Water: 1, Comment: 4 }, { unrunnable: ['b2'], detail: { ssLines: 1 } }));
  const frozenText = JSON.stringify(frozen);
  const once = T.classifyComposition(frozen);
  assert.equal(JSON.stringify(frozen), frozenText, 'the input is not mutated');
  assert.deepEqual(T.classifyComposition(frozen), once, 'the same frozen input classifies identically on every call');
  assert.equal(T.jevState(frozen, 'x')?.effects?.length, 3);
  const huge = T.classifyComposition({ components: 1e300, lists: 1e300, effects: { b27: 1e300, b20: 2.9 }, detail: { ssLines: 1e300 } });
  assert.ok(IDS.includes(huge.primary) && Number.isFinite(huge.k) && huge.k >= 0 && huge.k <= 1 && Number.isFinite(huge.score), 'huge counters stay finite');
  assert.equal(T.normalizeComposition({ effects: { b20: 2.9 } }).effects.b20, 2, 'fractional counts floor');
  // limits
  assert.equal(T.jevState(comp({ Ring: 30 }, { unrunnable: Array.from({ length: 30 }, (_, i) => `ape:U${i}`) }), null).unrunnable_effects.length, 8);
}

// ---- 7. confidence -----------------------------------------------------------------------------------------------------------
{
  for (let i = 0; i < 300; i++) {
    const c = randomComposition(); const r = T.classifyComposition(c);
    assert.ok(r.k >= 0 && r.k <= 1 && Number.isFinite(r.k), 'k in [0,1]');
    // adding decisive evidence never lowers any category score
    const key = pick(styleNames); const grown = { ...c, components: c.components + 1, effects: { ...c.effects, [key]: (c.effects[key] ?? 0) + 1 } };
    const a = T.scoreComposition(c), b = T.scoreComposition(grown);
    for (const id of IDS) assert.ok(b[id] >= a[id] - 1e-12, `${key} lowered ${id}`);
    if (r.primary === 'minimal') assert.equal(r.k, 0.9);
  }
  assert.equal(classify({ Comment: 2 }).k, 0.9); assert.equal(classify({}, { components: 0 }).k, 0.9);
  assert.equal(classify({ Ring: 1, Comment: 3 }).k, 0.5, 'top 3.0 and nothing else: min(1, 3/6) * (0.5 + 0.5 * 1)');
  assert.equal(classify({ Ring: 1, Simple: 1, Comment: 3 }).k, 0.25, 'a tie zeroes the margin term: 0.5 * 0.5');
  assert.equal(classify({ Grain: 2, Comment: 3 }).k, Math.round(Math.min(1, 4.05 / 6) * 1e6) / 1e6, 'top 4.05, margin 1');
}

// ---- 8. titles and authors -----------------------------------------------------------------------------------------------------
{
  const cp = (...codes) => String.fromCodePoint(...codes);
  assert.equal(T.sanitizeTitle('Some Title [4 stars]'), 'Some Title'); assert.equal(T.sanitizeTitle('One [1 star]'), 'One'); assert.equal(T.sanitizeTitle('Two [5 Stars] [3 stars]'), 'Two');
  assert.equal(T.sanitizeTitle(`Tab${cp(9)}and${cp(10)}new${cp(7)}line${cp(0x85)}x`), 'Tabandnewlinex');
  assert.equal(T.sanitizeTitle('  spaced   out  '), 'spaced out');
  const BS = cp(92);
  assert.equal(T.sanitizeTitle(`C:${BS}Users${BS}someone${BS}secret${BS}file.avs`), 'C: Users someone secret file.avs');
  assert.ok(!/[\\/]/.test(T.sanitizeTitle(`a/b${BS}c/d`)));
  assert.equal(T.sanitizeTitle(`x ${'a'.repeat(64)} y`), 'x y', 'a hash-like run is dropped');
  assert.equal(T.sanitizeTitle(undefined), ''); assert.equal(T.sanitizeTitle(42), '');
  assert.equal(T.sanitizeTitle('w'.repeat(500)).length, 80);
  const emoji = T.sanitizeTitle('a'.repeat(79) + cp(0x1f600) + 'tail');
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  assert.ok(emoji.length <= 80 && !lone.test(emoji), 'the clamp never splits a surrogate pair');
  assert.equal(T.sanitizeTitle(`bidi${cp(0x202e)}${cp(0x200b)}ok`), 'bidiok');

  assert.equal(T.authorOf('Zevensoft - Ocean [3 stars]'), 'Zevensoft');
  assert.equal(T.authorOf('Bob - Water - Ripple'), 'Bob', 'the first separator wins');
  assert.equal(T.authorOf(`Dash ${cp(0x2013)} Title`), 'Dash');
  for (const rejected of ['01 - Foo', '12.5 - Foo', 'v1.2 - Foo', 'Water - Ripple', 'Dot Grid - Foo', 'Superscope - x', 'No separator here', 'Hyphen-only-no-spaces', ' - Title', '... - Title', `${'n'.repeat(41)} - Title`, 'Test - x', 'Kaleidoscope - x', '']) {
    assert.equal(T.authorOf(rejected), null, rejected);
  }
  assert.equal(T.authorOf(`${'n'.repeat(40)} - Title`), 'n'.repeat(40));
  assert.equal(T.authorOf(42), null);
}

// ---- 9. the Jev state is an allowlisted, sanitised projection -------------------------------------------------------------------
{
  const BS = String.fromCodePoint(92);
  const hostile = comp({ SuperScope: 3, Movement: 2, Ring: 1, [`ape:C:${BS}Users${BS}x${BS}evil/path`]: 1, 'ape:Holden04: Video Delay': 1 },
    { detail: { ssLines: 2, ssDots: 1, mvBuiltin: 1, mvScript: 1, unsupported: 2 }, unrunnable: ['ape:Holden04: Video Delay', 'b2'], lists: 2, beatLists: 1, maxDepth: 1 });
  const title = `Evil C:${BS}Users${BS}someone${BS}x.avs /etc/passwd ${'f'.repeat(64)} [4 stars]`;
  const state = T.jevState(hostile, title, true);
  assert.deepEqual(Object.keys(state).sort(), ['effects', 'structure', 'title', 'unrunnable_effects']);
  assert.deepEqual(Object.keys(state.structure), ['components', 'effect_lists', 'max_depth', 'beat_render_lists']);
  const body = JSON.stringify(state);
  assert.ok(!body.includes(BS) && !body.includes('/'), 'no path separators');
  for (const banned of ['sha256', 'canonical_path', 'rating', 'notWorking', 'package', 'presets/unique', 'stars]']) assert.ok(!body.includes(banned), `no ${banned}`);
  assert.ok(!/[A-Za-z]:[\\/]/.test(body) && !/[0-9a-f]{32}/i.test(body), 'no drive path, no hash');
  assert.ok(state.effects.some(e => e.name === 'SuperScope' && e.detail === '2 line-mode, 1 dot-mode'));
  assert.ok(state.effects.some(e => e.name === 'Movement' && e.detail === '1 built-in, 1 scripted'));
  assert.deepEqual(state.unrunnable_effects, ['Holden04: Video Delay', 'Oscilloscope Star']);
  assert.ok(state.effects.length <= 24);
  assert.ok(!('title' in T.jevState(hostile, title, false)), '--no-names drops the title'); assert.ok(!('title' in T.jevState(hostile, null)));
  // no field of the composition other than the fixed list can reach the state
  const smuggled = { ...hostile, sha256: 'a'.repeat(64), canonical_path: 'x', extra: { rating: 5 } };
  assert.equal(JSON.stringify(T.jevState(smuggled, null)), JSON.stringify(T.jevState(hostile, null)));
}

// ---- 10. optional corpus bands (read-only, skipped when the local collection is absent) --------------------------------------------
let corpusNote = 'corpus bands skipped (no local collection)';
{
  const catalog = fileURLToPath(new URL('../avs presets/catalog/presets.json', import.meta.url));
  let present = false; try { present = readFileSync(catalog, 'utf8').length > 0; } catch { present = false; }
  if (present && process.env.AAAVS_TAX_CORPUS !== '0') {
    const { loadEngine, classifyCollection } = await import('./classify-presets.mjs');
    const engine = await loadEngine();
    const { results, stats } = await classifyCollection(engine, fileURLToPath(new URL('../avs presets/', import.meta.url)));
    const n = results.length;
    if (n < 1000) corpusNote = `corpus bands skipped (${n} presets classified; the bands describe the full historical collection)`;
    else {
      const share = {}; let partial = 0;
      for (const r of results) { share[r.det.primary] = (share[r.det.primary] ?? 0) + 1; if (r.det.facets.f === 'partial') partial++; }
      for (const [id, count] of Object.entries(share)) assert.ok(count / n <= 0.20 && count / n >= 0.01, `${id} share ${(100 * count / n).toFixed(1)}% is inside 1-20%`);
      assert.ok((share.mixed ?? 0) / n < 0.04, 'mixed under 4%'); assert.ok(stats.parseErrors <= 5, 'parse errors at most 5');
      assert.ok(partial / n >= 0.10 && partial / n <= 0.25, 'partial fidelity between 10% and 25%');
      corpusNote = `corpus bands PASS over ${n} presets (${stats.parseErrors} parse errors)`;
    }
  } else if (present) corpusNote = 'corpus bands skipped (AAAVS_TAX_CORPUS=0)';
}
console.log(`Preset taxonomy PASS: 18-category table, synthetic and parsed presets, boundaries, ordering, robustness, confidence, titles, payload allowlist; ${corpusNote}.`);
