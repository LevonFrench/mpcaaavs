// Deterministic synthetic catalogs for the Preset Browser checks (docs/design/PRESET-BROWSER-V2.md 12).
// Everything here is invented: no real preset, package, artist, game or title, no private path and no media.
// The output has the exact JSON shapes of the local collection (`presets.json`, `parser-validation.json`, `sources.json`,
// `hud-titles.json`), so checks feed it through the real parsers.
import {createHash} from 'node:crypto';
import {build} from 'esbuild';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const sha = text => createHash('sha256').update(text).digest('hex');
const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const NERV_SCENES = ['boot', 'magi', 'psycho', 'radar', 'harmonics', 'seele', 'battery', 'atfield', 'alert', 'plug', 'target', 'city', 'sync', 'berserk', 'impact', 'end'];
export const PACK_LABELS = ['Showcase', 'Arcade · Fighting', 'Arcade · Action', 'Neo Geo', 'Vector & Early Arcade', '8/16-bit Consoles', '32/64-bit Consoles',
  '128-bit Consoles', 'Handheld & LCD', 'Home Computers', 'PC Classic', 'Flight, Space & Racing', 'Modern', 'Rhythm', 'Cinema & TV', 'Anime & Mecha'];

const WORDS = ['acid', 'aurora', 'binary', 'blossom', 'cascade', 'cobalt', 'crystal', 'delta', 'ember', 'fractal', 'glacier', 'harmonic', 'iris', 'jungle', 'kernel',
  'lattice', 'meteor', 'nebula', 'orbit', 'plasma', 'quartz', 'ripple', 'signal', 'tunnel', 'vector', 'vortex', 'wave', 'xenon', 'zenith', 'pulse'];
const ACCENTED = ['Café Nuit', 'Ångström Drift', 'Über Beat', 'naïve wave', 'Zoë Glow', 'Señor Static', 'crème spiral', 'Ærø Lines'];
const DIRS = ['scopes', 'feedback', 'particles', 'misc', 'old', 'new', 'live', 'fx', 'text', 'beat', 'water', 'stars', '3d', 'mirror'];
const ARCHETYPES = ['Duel Rails', 'Score Strip', 'Round Timer', 'Combo Burst', 'Radar Ring', 'Speed Dial', 'Lane Gauge', 'Shield Bars'];
const FAMILIES = ['fighting', 'shooter', 'racing', 'platform', 'rhythm', 'sports', 'flight', 'puzzle'];

/** A fixed set of synthetic packages across six source groups. */
function makePackages(rand) {
  const list = [];
  const add = (catalog, count, layoutOf, extra) => {
    for (let k = 0; k < count; k++) {
      const slug = `${pick(rand, WORDS)}${k}`;
      const id = `${catalog}-${slug}-${sha(`${catalog}${k}${slug}`).slice(0, 10)}`;
      list.push({id, catalog, slug, layout: layoutOf(k), wrapper: `${slug}-main`, ...extra(k, slug)});
    }
  };
  add('visbot-legacy', 50, k => ['wrapper', 'flat', 'nested', 'mixed'][k % 4], (k, s) => ({artist: `artist-${s}`, file: `${s}-pack${k % 3 ? '-unofficial' : ''}.7z`}));
  add('visbot-current', 10, k => (k % 2 ? 'wrapper' : 'flat'), (k, s) => ({release: `rel-${1000 + k}`, file: `${s}-release.zip`}));
  add('github', 12, k => 'wrapper', (k, s) => ({repository: `fixture-org/repo-${s}`, file: null}));
  add('local-existing', 6, k => (k % 2 ? 'flat' : 'wrapper'), () => ({file: null}));
  add('author-pack', 8, () => 'wrapper', (k, s) => ({file: `${s}.exe`}));
  add('internet-archive', 4, () => 'flat', (k, s) => ({file: `${s}-archive.zip`}));
  return list;
}

function originalPath(rand, pkg, file, index) {
  const subs = Array.from({length: Math.floor(rand() * 3)}, () => pick(rand, DIRS));
  switch (pkg.layout) {
    case 'flat': return [...(rand() < 0.5 ? [] : subs.slice(0, 1)), file].join('/');
    case 'nested': return index % 3 === 0 ? ['_nested', sha(`${pkg.id}${index}`).slice(0, 12), pkg.wrapper, ...subs, file].join('/') : [pkg.wrapper, ...subs, file].join('/');
    case 'mixed': return index % 2 ? [pkg.wrapper, ...subs, file].join('/') : file;
    default: return [pkg.wrapper, ...subs, file].join('/');
  }
}

/**
 * @param {number} count  number of AVS entries (default 4,000)
 * @param {number} seed
 * @param {{hud?: number, hudNeo?: number, nerv?: boolean, noOrigin?: number, curated?: number}} options
 */
export function syntheticCatalog(count = 4000, seed = 1, options = {}) {
  const rand = mulberry32(seed);
  const packages = makePackages(rand);
  const weights = packages.map(p => (p.catalog === 'visbot-legacy' ? 6 : p.catalog === 'github' ? 3 : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const pickPackage = () => { let r = rand() * total; for (let i = 0; i < packages.length; i++) { r -= weights[i]; if (r <= 0) return packages[i]; } return packages[0]; };
  const presets = [], validation = [];
  const names = new Map();
  for (let i = 0; i < count; i++) {
    let name;
    const roll = rand();
    if (roll < 0.03) name = `Intro ${2 + (i % 11)}`;                      // Intro 2 .. Intro 12
    else if (roll < 0.06) name = pick(rand, ACCENTED) + (rand() < 0.5 ? '' : ` ${i % 7}`);
    else if (roll < 0.09 && presets.length) name = presets[Math.floor(rand() * presets.length)].display_name;   // duplicate names
    else name = `${pick(rand, WORDS)} ${pick(rand, WORDS)} ${i}`;
    names.set(name, (names.get(name) ?? 0) + 1);
    const digest = sha(`avs:${seed}:${i}`);
    const file = `${name}.avs`;
    const entry = {
      sha256: digest, version: 2, bytes: 100 + Math.floor(rand() * 200000),
      canonical_path: `presets/unique/${digest.slice(0, 16)}---${file}`, display_name: name, occurrences: [],
    };
    const noOrigin = i < (options.noOrigin ?? Math.round(count * 0.05));
    if (!noOrigin) {
      const first = pickPackage();
      const used = [first];
      if (rand() < 0.08) { const extra = 1 + Math.floor(rand() * 2); for (let k = 0; k < extra; k++) { const p = pickPackage(); if (!used.includes(p)) used.push(p); } }
      used.forEach(pkg => {
        const rel = originalPath(rand, pkg, file, i);
        entry.occurrences.push({package_id: pkg.id, path: `_staging/packages/${pkg.id}/${rel}`, original_path: rel});
      });
    }
    if (i >= count - (options.curated ?? 12)) { entry.folder = `Collections/Fixture set ${i % 3}`; entry.occurrences = []; }
    if (rand() < 0.12) entry.rating = 1 + Math.floor(rand() * 5);
    if (rand() < 0.02) entry.notWorking = true;
    presets.push(entry);
    const bad = rand() < 0.01;
    validation.push({sha256: digest, status: bad ? 'parse-error' : 'lossless', ...(bad ? {error: 'synthetic parse failure'} : {})});
  }
  if (options.nerv !== false) {
    NERV_SCENES.forEach((scene, k) => {
      const nn = String(k + 1).padStart(2, '0'), digest = sha(`nerv:${seed}:${scene}`);
      presets.push({sha256: digest, bytes: 900 + k, canonical_path: `presets/unique/NERV ${nn} - ${scene}.nerv`, display_name: `NERV / ${nn} - ${scene}`, kind: 'nerv', scene});
      validation.push({sha256: digest, status: 'lossless'});
    });
  }
  // HUD scenes: the pack label leads the folder hint. The Neo Geo pack is wide on purpose, to exercise letter buckets.
  const hudCount = options.hud ?? 400, neo = options.hudNeo ?? 150;
  const titles = {};
  let hudIndex = 0;
  const hudPlan = [];
  PACK_LABELS.forEach(label => {
    const n = label === 'Neo Geo' ? neo : Math.max(1, Math.floor((hudCount - neo) / (PACK_LABELS.length - 1)));
    for (let k = 0; k < n && hudPlan.length < hudCount; k++) hudPlan.push({label, k});
  });
  while (hudPlan.length < hudCount) hudPlan.push({label: 'Modern', k: 1000 + hudPlan.length});
  for (const {label, k} of hudPlan) {
    const nn = String(hudIndex).padStart(3, '0'), digest = sha(`hud:${seed}:${hudIndex}`);
    const archetype = ARCHETYPES[hudIndex % ARCHETYPES.length];
    const word = WORDS[(Math.floor(k / 2) * 7 + PACK_LABELS.indexOf(label) * 3) % WORDS.length];
    const kit = `${word[0].toUpperCase()}${word.slice(1)} ${String(Math.floor(k / 2)).padStart(3, '0')}`;      // two scenes per kit
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const id = `${slug}-${archetype.toLowerCase().replace(/ /g, '-')}-${nn}`;
    const entry = {
      sha256: digest, bytes: 1200 + hudIndex, canonical_path: `presets/unique/${digest.slice(0, 16)}---${archetype} ${nn}.hud`,
      display_name: `${archetype} ${nn}`, kind: 'hud', folder: `${label}/${kit}`,
      hud: {id, pack: hudIndex % 2 ? label : slug, family: FAMILIES[hudIndex % FAMILIES.length], tags: ['fixture', archetype.toLowerCase().split(' ')[0]], tier: ['showcase', 'tuned', 'auto'][hudIndex % 3], order: hudIndex, canvas: {style: hudIndex % 2 ? 'pixel' : 'vector', w: 320 + (hudIndex % 4) * 64, h: 224}},
    };
    if (hudIndex % 97 === 96) delete entry.folder;                       // fallback path: pack label from `hud.pack`
    presets.push(entry);
    validation.push({sha256: digest, status: 'lossless'});
    titles[id] = `Fixture Title ${nn}`;
    hudIndex++;
  }
  const sources = packages.map(p => ({
    id: p.id, catalog: p.catalog, ...(p.file ? {file_name: p.file} : {}),
    ...(p.artist ? {artist_slug: p.artist} : {}), ...(p.repository ? {repository: p.repository, branch: 'main'} : {}), ...(p.release ? {release_id: p.release} : {}),
    url: `https://example.invalid/${p.slug}`, source_page: `https://example.invalid/page/${p.slug}`, packaging: 'archive',
  }));
  return {
    catalogJson: {summary: {fixture: true}, presets},
    validationJson: {results: validation},
    sourcesJson: {generated_at: '2026-01-01T00:00:00Z', sources},
    titlesJson: {format: 'aaavs-hud-titles', version: 1, titles},
    packages, hudPlan,
  };
}

/** Deterministic synthetic classification for the AVS entries of a fixture catalog: `[sha256, taxon]` pairs. */
export function syntheticTaxa(catalogJson, seed = 7, categories = ['scope-classic', 'scope-geometry', 'rings-stars', 'particles', 'starfield', 'perspective-3d', 'tunnel-zoom',
  'spin-rotate', 'kaleido-mirror', 'water-ripple', 'bump-relief', 'color-grade', 'glitch-digital', 'beat-flash', 'text-image', 'multi-scene', 'minimal', 'mixed']) {
  const rand = mulberry32(seed);
  const energy = ['calm', 'steady', 'driving', 'intense'];
  const authors = ['Aria', 'Bram', 'Cleo', 'Dune', 'Elka', 'Finn'];
  const pairs = [];
  for (const p of catalogJson.presets) {
    if (p.kind === 'nerv' || p.kind === 'hud' || rand() < 0.15) continue;
    const c = pick(rand, categories);
    const taxon = {c, t: rand() < 0.4 ? [pick(rand, categories)].filter(x => x !== c) : [], e: pick(rand, energy), b: 1 + Math.floor(rand() * 5), f: rand() < 0.1 ? 'partial' : 'full'};
    if (rand() < 0.5) taxon.a = pick(rand, authors);
    pairs.push([p.sha256, taxon]);
  }
  return pairs;
}

/**
 * Bundles the browser modules once into a single instance (so shared module state is shared) and returns their exports.
 * Extra module paths (for example the view) can be added.
 */
export async function loadBrowser(extra = []) {
  const modules = ['avs/local-collection', 'avs/preset-categories', 'mpc-folders', 'mpc-folder-query', 'mpc-folder-store', 'mpc-folder-play', 'mpc-folder-stats',
    'mpc-folder-defaults', 'mpc-setups', 'mpc-scene-clock', 'mpc-contract', 'mpc-preset-eligibility', ...extra];
  const imports = modules.map((m, i) => `import * as m${i} from './src/${m}.ts';`).join(String.fromCharCode(10));
  const contents = `${imports}${String.fromCharCode(10)}export default {${modules.map((m, i) => `...m${i}`).join(',')}};`;
  const result = await build({stdin: {contents, resolveDir: process.cwd(), loader: 'ts'}, bundle: true, format: 'esm', write: false});
  const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  return module.default;
}

// ---------------------------------------------------------------------------------------------------- a small fake DOM
// Enough of the DOM for the Preset Browser view: element trees with text, attributes, properties, handler properties, a style
// object, scroll and client sizes (set by the test), focus tracking, and the head of the document. Handlers are properties
// (`onclick`, `onkeydown`, ...) exactly as the view assigns them; `fire` calls one with a fake event.
export function installFakeDom({narrow = false, matchMedia = true, raf = false} = {}) {
  class Element {
    constructor(tag) {
      this.tagName = tag; this.children = []; this.attributes = {}; this._text = ''; this.className = ''; this.value = ''; this.parent = null;
      this.hidden = false; this.disabled = false; this.checked = false; this.id = ''; this.scrollTop = 0; this.clientHeight = 0; this.tabIndex = 0;
      this.style = {setProperty(k, v) { this[k] = v; }};
    }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); for (const c of this.children) c.parent = null; this.children = []; }
    append(...items) { for (const x of items) { if (x.parent) x.parent.children = x.parent.children.filter(c => c !== x); x.parent = this; this.children.push(x); } }
    prepend(...items) { for (const x of items) { if (x.parent) x.parent.children = x.parent.children.filter(c => c !== x); x.parent = this; } this.children.unshift(...items); }
    replaceChildren(...items) { for (const c of this.children) c.parent = null; this.children = []; this.append(...items); }
    setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') this.id = String(v); }
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
    removeAttribute(k) { delete this.attributes[k]; }
    focus() { document.activeElement = this; }
    select() { this.selected = true; }
    all() { return [this, ...this.children.flatMap(c => c.all())]; }
    contains(other) { return this.all().includes(other); }
    querySelectorAll(selector) { const tags = String(selector).split(',').map(t => t.trim()); return this.children.flatMap(c => c.all()).filter(e => tags.includes(e.tagName)); }
    query(pred) { return this.all().find(pred); }
    queryAll(pred) { return this.all().filter(pred); }
  }
  const head = new Element('head');
  const document = {
    createElement: tag => new Element(tag), head, documentElement: new Element('html'), activeElement: null,
    getElementById: id => head.all().find(e => e.id === id) ?? null,
  };
  globalThis.document = document;
  globalThis.window = {confirm: () => true};
  const listeners = {};
  globalThis.addEventListener = (type, fn) => { (listeners[type] ??= []).push(fn); };
  globalThis.removeEventListener = (type, fn) => { listeners[type] = (listeners[type] ?? []).filter(f => f !== fn); };
  if (matchMedia) globalThis.matchMedia = query => ({matches: /480/.test(query) ? dom.narrow : false});
  else delete globalThis.matchMedia;
  const frames = [];
  if (raf) globalThis.requestAnimationFrame = cb => { frames.push(cb); return frames.length; }; else delete globalThis.requestAnimationFrame;
  const dom = {
    Element, document, head, narrow, listeners, frames,
    flushFrames() { const run = frames.splice(0); for (const f of run) f(); return run.length; },
    resize() { for (const f of listeners.resize ?? []) f(); },
    /** Runs a handler property with a fake event; returns the event so a test can inspect `defaultPrevented` and `stopped`. */
    fire(el, type, init = {}) {
      const ev = {type, key: '', target: el, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...init};
      const handler = el['on' + type];
      if (typeof handler === 'function') handler.call(el, ev);
      return ev;
    },
    key(el, key, init = {}) { return dom.fire(el, 'keydown', {key, ...init}); },
    uninstall() { delete globalThis.document; delete globalThis.window; delete globalThis.addEventListener; delete globalThis.removeEventListener; delete globalThis.matchMedia; delete globalThis.requestAnimationFrame; },
  };
  return dom;
}

/** Deterministic manual timers for a `Timers` interface (`set`, `clear`), with `fire` to run everything scheduled. */
export class FakeTimers {
  constructor() { this.next = 0; this.pending = new Map(); }
  set(fn, ms) { this.pending.set(++this.next, {fn, ms}); return this.next; }
  clear(id) { this.pending.delete(id); }
  get delays() { return [...this.pending.values()].map(t => t.ms); }
  fire() { const all = [...this.pending.entries()]; this.pending.clear(); for (const [, t] of all) t.fn(); return all.length; }
}
