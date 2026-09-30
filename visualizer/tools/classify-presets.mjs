#!/usr/bin/env node
// Offline style classifier for the local AVS collection (docs/design/PRESET-TAXONOMY-AND-JEV.md 5 and 6, docs/design/CONTRACT.md
// C-26, C-38, 2.3.10). Dev-time only; nothing in the player, the checks or any default command reaches it or the network.
//
//   node tools/classify-presets.mjs --collection "<abs>/avs presets" [--out-dir <dir>]      offline and deterministic (default)
//   node tools/classify-presets.mjs --collection ... --jev-dry-run                          print exact payloads + cost estimate, send nothing
//   node tools/classify-presets.mjs --collection ... --jev --send                           owner-run only: needs TYPESAFE_API_KEY in the environment
//        [--no-names] [--all] [--limit N] [--concurrency 4] [--jev-apply] [--intensity] [--review-csv <path>] [--gold-sample <csv>]
//   node tools/classify-presets.mjs --collection ... --import-review <csv>                  writes categories.overrides.json from an edited review CSV
//
// Writes only new files next to the catalog (or into --out-dir): categories.json, categories.review.csv and, only on the Jev path,
// categories.jev-cache.jsonl. categories.overrides.json is written by --import-review alone and never rewritten otherwise.
// It never opens presets.json, parser-validation.json, ratings, setups or settings for writing.
//
// The Jev path is OFF by default and key-gated: --jev selects it and --send performs it. The key comes only from the environment
// (TYPESAFE_API_KEY, or the output of the command named in TYPESAFE_API_KEY_COMMAND, argv-split without a shell), is never accepted
// as a flag, never written anywhere, and is scrubbed from every message. Status: the request and answer wire shapes below follow
// the design doc (JEV 3.1, 5.3) and are UNVERIFIED against the live API; the first owner-run --jev-dry-run must be read and one
// keyed call inspected before anyone relies on them. Jev never overrides a category unless --jev-apply is passed (JEV 9: unvalidated).
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VISUALIZER = fileURLToPath(new URL('../', import.meta.url));
export const JEV_MODEL = 'jev-1.13.0';
export const JEV_PROMPT_VERSION = 1;
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const REVIEW_K = 0.28;
export const MAX_COLLECTION_FILE = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const PRICE_PER_MILLION_INPUT_TOKENS = 0.042;
const OVERHEAD_TOKENS = 300;
const PROTECTED_NAMES = new Set(['presets.json', 'parser-validation.json', 'sources.json', 'setups.json', 'settings.json', 'folders.json', 'stats.json', 'categories.overrides.json']);
const FORMAT = 'aaavs-categories';
const OVERRIDES_FORMAT = 'aaavs-category-overrides';

// ---------------------------------------------------------------------------------------------------------------- engine
let engineCache;
/** Bundles the shared TypeScript once (the same idiom as the tools/check-*.mjs files). */
export function loadEngine() {
  engineCache ??= (async () => {
    const entry = `
export { parseAvsPreset } from './src/avs/preset.ts';
export { createAvsCompatibilityRegistry } from './src/avs/effects/registry.ts';
export { TAXONOMY, TAXONOMY_VERSION } from './src/avs/preset-categories.ts';
export { compositionOf, classifyComposition, sanitizeTitle, authorOf, jevState, effectName, normalizeComposition, TAXONOMY_DEFINITIONS } from './src/avs/preset-taxonomy.ts';
`;
    const result = await build({ stdin: { contents: entry, resolveDir: VISUALIZER, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'node' });
    return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  })();
  return engineCache;
}

// ------------------------------------------------------------------------------------------------------------- arguments
const VALUE_FLAGS = new Set(['--collection', '--out-dir', '--limit', '--concurrency', '--review-csv', '--import-review', '--gold-sample', '--jev-url']);
const BOOL_FLAGS = new Set(['--jev', '--send', '--jev-dry-run', '--no-names', '--all', '--jev-apply', '--intensity', '--help']);

export class UsageError extends Error {}

export function parseArgs(argv) {
  const o = { collection: null, outDir: null, jev: false, send: false, dryRun: false, noNames: false, all: false, apply: false, intensity: false,
    limit: null, concurrency: 4, reviewCsv: null, importReview: null, goldSample: null, jevUrl: JEV_URL, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!VALUE_FLAGS.has(arg) && !BOOL_FLAGS.has(arg)) throw new UsageError(`Unknown argument ${JSON.stringify(String(arg).slice(0, 40))}. There is no key flag: the key comes from the environment only.`);
    if (BOOL_FLAGS.has(arg)) {
      if (arg === '--jev') o.jev = true; else if (arg === '--send') o.send = true; else if (arg === '--jev-dry-run') o.dryRun = true;
      else if (arg === '--no-names') o.noNames = true; else if (arg === '--all') o.all = true; else if (arg === '--jev-apply') o.apply = true;
      else if (arg === '--intensity') o.intensity = true; else o.help = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
    if (arg === '--collection') o.collection = value; else if (arg === '--out-dir') o.outDir = value; else if (arg === '--review-csv') o.reviewCsv = value;
    else if (arg === '--import-review') o.importReview = value; else if (arg === '--gold-sample') o.goldSample = value; else if (arg === '--jev-url') o.jevUrl = value;
    else if (arg === '--limit') { const n = Number(value); if (!Number.isInteger(n) || n < 1) throw new UsageError('--limit must be a positive integer'); o.limit = n; }
    else if (arg === '--concurrency') { const n = Number(value); if (!Number.isInteger(n) || n < 1 || n > 8) throw new UsageError('--concurrency must be 1..8'); o.concurrency = n; }
  }
  if (!o.help && !o.collection) throw new UsageError('--collection <absolute avs presets directory> is required');
  if (o.send && !o.jev) throw new UsageError('--send needs --jev');
  if (o.apply && !o.jev) throw new UsageError('--jev-apply needs --jev');
  if (o.collection && !path.isAbsolute(o.collection)) throw new UsageError('--collection must be an absolute path');
  if (o.outDir && !path.isAbsolute(o.outDir)) throw new UsageError('--out-dir must be an absolute path');
  for (const p of [o.reviewCsv, o.goldSample, o.importReview]) if (p && !path.isAbsolute(p)) throw new UsageError('file arguments must be absolute paths');
  for (const p of [o.reviewCsv, o.goldSample]) if (p && !p.toLowerCase().endsWith('.csv')) throw new UsageError('review and gold-sample outputs must end in .csv');
  try {
    const u = new URL(o.jevUrl);
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) throw new Error('scheme');
  } catch { throw new UsageError('--jev-url must be https, or http on a loopback host (tests only)'); }
  return o;
}

// -------------------------------------------------------------------------------------------------------------------- IO
const sha256 = data => createHash('sha256').update(data).digest('hex');
let tmpCounter = 0;
/** Temp file in the same directory, then rename: a crash never leaves a half-written categories file. */
export async function writeAtomic(file, text, { allowOverrides = false } = {}) {
  const base = path.basename(file).toLowerCase();
  if (PROTECTED_NAMES.has(base) && !(allowOverrides && base === 'categories.overrides.json')) throw new Error(`Refusing to write the protected file ${base}.`);
  const tmp = `${file}.tmp-${process.pid}-${++tmpCounter}`;
  try { await writeFile(tmp, text, { flag: 'wx' }); await rename(tmp, file); }
  catch (error) { await rm(tmp, { force: true }).catch(() => {}); throw error; }
}
const inside = (root, candidate) => { const r = path.relative(root, candidate); return r !== '' && !r.startsWith('..') && !path.isAbsolute(r); };

// ----------------------------------------------------------------------------------------------------------------- CSV
export function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection from hostile titles
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
export const csvLine = cells => cells.map(csvCell).join(',');
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const unapostrophe = s => (s.startsWith("'") ? s.slice(1) : s);

// --------------------------------------------------------------------------------------------------------------- questions
/** What each Jev choice is not for (JEV 5.3). Keys are TAXONOMY ids with the last `mixed` renamed to the no-match `general_mix`. */
export const JEV_NOT_FOR = {
  'scope-classic': 'Many-shape figures (scope_geometry); particles.',
  'scope-geometry': 'A single wave line.',
  'rings-stars': 'Starfield flying-through-space (starfield).',
  'particles': 'Perspective or z-depth (perspective_3d).',
  'starfield': 'Dots on a grid.',
  'perspective-3d': 'Flat zoom tunnels.',
  'tunnel-zoom': 'A preset with a distinctive render effect.',
  'spin-rotate': 'Kaleidoscopes.',
  'kaleido-mirror': 'Plain symmetry from a SuperScope.',
  'water-ripple': 'Bump lighting alone.',
  'bump-relief': 'Water ripples.',
  'color-grade': 'Presets where colour effects merely accompany a renderer.',
  'glitch-digital': 'Beat strobes.',
  'beat-flash': 'Smooth motion.',
  'text-image': '-', 'multi-scene': 'A large preset with an obvious identity.', 'minimal': '-', 'mixed': '-',
};
export const optionKey = id => (id === 'mixed' ? 'general_mix' : id.replaceAll('-', '_'));
export const categoryOfOption = (engine, key) => engine.TAXONOMY.find(t => optionKey(t.id) === key)?.id ?? null;

export function styleQuestion(engine) {
  const criteria = {};
  for (const t of engine.TAXONOMY) {
    criteria[optionKey(t.id)] = { what: t.id === 'mixed' ? 'Nothing clearly fits.' : engine.TAXONOMY_DEFINITIONS[t.id], not_for: JEV_NOT_FOR[t.id] ?? '-' };
  }
  return {
    type: 'choice',
    instructions: 'Which visual style family best describes this Winamp AVS preset? You can only see its effect list, its structure and its title, not its rendered output. '
      + 'The effect list is the main evidence; the title breaks ties and is often only a poetic name. Prefer the family of the most distinctive effect. '
      + 'Movement, Dynamic Movement, Blur, Fade Out and Comment appear in most presets and are not evidence of style by themselves. Choose `general_mix` when no family clearly fits.',
    criteria,
  };
}
export function intensityQuestion() {
  return {
    type: 'score',
    instructions: 'How intense is this preset likely to look when playing music? Judge only from the effect list and structure.',
    criteria: [
      'Calm: slow drifting motion, no beat-triggered effects',
      'Gentle: smooth motion with at most subtle beat pulses',
      'Moderate: clearly audio-reactive with steady motion',
      'Energetic: strong beat-driven movement or frequent flashes',
      'Aggressive: strobing, hard flashes or rapid distortion',
    ],
  };
}
export function questionsFor(engine, opts) {
  return { style: styleQuestion(engine), ...(opts.intensity ? { intensity: intensityQuestion() } : {}) };
}
/** The single place that shapes a request body (wire shape UNVERIFIED, see the header). */
export function requestBody(state, questions) { return { model: JEV_MODEL, state, questions }; }
export const cacheKey = (engine, state, opts = {}) =>
  sha256(`${JEV_MODEL}\n${JEV_PROMPT_VERSION}\n${engine.TAXONOMY_VERSION}\n${opts.intensity ? 'i' : ''}\n${JSON.stringify(state)}`);

/**
 * Validates one response for the style question. Returns { choice: <taxonomy id>, p, q } or null. Malformed answers (wrong type,
 * choice not among the options, probabilities not near a distribution, choice not the argmax) are discarded, never repaired.
 */
export function parseStyleAnswer(engine, response) {
  try {
    if (!response || typeof response !== 'object') return null;
    const answers = response.answers;
    const a = answers && typeof answers === 'object' ? answers.style : null;
    if (!a || typeof a !== 'object' || typeof a.choice !== 'string') return null;
    const options = engine.TAXONOMY.map(t => optionKey(t.id));
    if (!options.includes(a.choice)) return null;
    const probs = a.probabilities ?? a.probs;
    if (!probs || typeof probs !== 'object' || Array.isArray(probs)) return null;
    let sum = 0, best = -1, bestKeys = [];
    const values = [];
    for (const key of options) {
      const v = probs[key];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return null;
      sum += v; values.push(v);
      if (v > best + 1e-9) { best = v; bestKeys = [key]; } else if (Math.abs(v - best) <= 1e-9) bestKeys.push(key);
    }
    if (Object.keys(probs).some(k => !options.includes(k))) return null;
    if (Math.abs(sum - 1) > 0.1) return null;
    if (!bestKeys.includes(a.choice)) return null;
    const p = probs[a.choice];
    const q = Math.max(0, ...options.filter(k => k !== a.choice).map(k => probs[k]));
    return { choice: categoryOfOption(engine, a.choice), p, q };
  } catch { return null; }
}
export function parseIntensityAnswer(response) {
  const a = response?.answers?.intensity;
  const s = a && typeof a === 'object' ? a.score : undefined;
  return typeof s === 'number' && Number.isFinite(s) && s >= 0 && s <= 4 ? s : null;
}

// ------------------------------------------------------------------------------------------------------------- decisions
export const ACCEPT_P = 0.55, ACCEPT_MARGIN = 0.20, CONFIDENT_K = 0.6;
/**
 * Acceptance policy (JEV 5.4). `det` is the deterministic classification { primary, tags, k, facets, score }; `jev` is a validated
 * answer { choice, p, q } or null; `apply` says whether Jev may change the category (off until the owner gates it on a gold set).
 * Returns { c, t, s, k, disagree }.
 */
export function decide(det, jev, apply) {
  const base = { c: det.primary, t: [...det.tags], s: 's', k: det.k, disagree: false };
  if (!jev || jev.choice === 'mixed') return base;
  if (jev.choice === det.primary) return apply ? { ...base, s: 'sj', k: Math.min(1, det.k + (1 - det.k) * jev.p * 0.5) } : base;
  const out = { ...base, disagree: true };
  if (!apply) return out;
  if (det.k >= CONFIDENT_K) return out; // Jev never overrides a confident structural decision
  if (jev.p >= ACCEPT_P && jev.p - jev.q >= ACCEPT_MARGIN) {
    const t = [det.primary, ...det.tags].filter(id => id !== jev.choice && id !== 'mixed' && id !== 'minimal').slice(0, 2);
    return { ...out, c: jev.choice, t, s: 'j', k: jev.p };
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------ transport
const scrubber = key => text => {
  let s = String(text ?? '');
  if (key) s = s.split(key).join('[key]');
  return s.replace(/Bearer\s+\S+/gi, 'Bearer [key]');
};
async function readCapped(response, cap) {
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > cap) throw new Error('response too large');
  if (response.body?.getReader) {
    const reader = response.body.getReader(); const chunks = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength; if (total > cap) { await reader.cancel().catch(() => {}); throw new Error('response too large'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > cap) throw new Error('response too large');
  return text;
}
/** One request with a 10 s timeout, no redirects, a 1 MiB cap, a required JSON content type and one jittered retry on 429/5xx. */
export async function callJev(deps, url, key, body) {
  const scrub = scrubber(key);
  let lastError = 'backend unavailable';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await deps.fetch(url, {
        method: 'POST', redirect: 'error', signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(10_000) : undefined,
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      if (response.status === 429 || response.status >= 500) { lastError = `HTTP ${response.status}`; if (attempt === 0) { await deps.sleep(250 + Math.floor(deps.random() * 250)); continue; } break; }
      if (response.status < 200 || response.status >= 300) { lastError = `HTTP ${response.status}`; break; }
      const type = String(response.headers?.get?.('content-type') ?? '');
      if (!/json/i.test(type)) { lastError = 'backend unavailable (not JSON)'; break; }
      const text = await readCapped(response, MAX_RESPONSE_BYTES);
      return { ok: true, json: JSON.parse(text) };
    } catch (error) {
      lastError = scrub(error && error.message ? error.message : 'request failed');
      if (attempt === 0) { await deps.sleep(250 + Math.floor(deps.random() * 250)); continue; }
    }
  }
  return { ok: false, error: scrub(lastError) };
}

function splitCommand(text) {
  const args = []; let cur = '', quote = null, any = false;
  for (const ch of text) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; }
    else if (ch === '"' || ch === "'") { quote = ch; any = true; }
    else if (/\s/.test(ch)) { if (cur || any) args.push(cur); cur = ''; any = false; }
    else cur += ch;
  }
  if (cur || any) args.push(cur);
  return args;
}
/** Key from the environment only. A key command is argv-split and run without a shell. */
export function resolveKey(deps) {
  const direct = deps.env.TYPESAFE_API_KEY;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const command = deps.env.TYPESAFE_API_KEY_COMMAND;
  if (typeof command === 'string' && command.trim()) {
    const argv = splitCommand(command);
    if (argv.length) { const out = deps.runKeyCommand(argv); if (typeof out === 'string' && out.trim()) return out.trim().split(/\r?\n/)[0].trim(); }
  }
  return null;
}
const defaultRunKeyCommand = argv => {
  const r = spawnSync(argv[0], argv.slice(1), { shell: false, encoding: 'utf8', timeout: 10_000, windowsHide: true });
  return r.status === 0 ? r.stdout : '';
};

// ----------------------------------------------------------------------------------------------------------------- core
async function readJsonFile(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function exists(file) { try { await stat(file); return true; } catch { return false; } }

/** Loads the collection catalog read-only and classifies every avs entry. Never throws for a single bad preset. */
export async function classifyCollection(engine, root, options = {}) {
  const catalog = await readJsonFile(path.join(root, 'catalog', 'presets.json'));
  if (!catalog || !Array.isArray(catalog.presets)) throw new Error('catalog/presets.json has no preset list');
  const registry = engine.createAvsCompatibilityRegistry({ randomInt: () => 0 });
  const has = c => registry.handler(c) !== undefined;
  const results = []; const stats = { entries: catalog.presets.length, skippedKind: 0, integrity: 0, parseErrors: 0, classified: 0 };
  for (let row = 0; row < catalog.presets.length; row++) {
    const entry = catalog.presets[row];
    if (!entry || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256) || typeof entry.canonical_path !== 'string') { stats.integrity++; continue; }
    if (entry.kind === 'nerv' || entry.kind === 'hud') { stats.skippedKind++; continue; }
    const file = path.resolve(root, ...entry.canonical_path.split('/'));
    if (!inside(root, file)) { stats.integrity++; continue; }
    let bytes;
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_COLLECTION_FILE || (Number.isInteger(entry.bytes) && info.size !== entry.bytes)) { stats.integrity++; continue; }
      bytes = await readFile(file);
    } catch { stats.integrity++; continue; }
    if (sha256(bytes) !== entry.sha256) { stats.integrity++; continue; }
    let composition;
    try { composition = engine.compositionOf(engine.parseAvsPreset(new Uint8Array(bytes)), has); }
    catch { stats.parseErrors++; continue; }
    const name = typeof entry.display_name === 'string' ? entry.display_name : '';
    const det = engine.classifyComposition(composition);
    results.push({ row, sha256: entry.sha256, name, title: engine.sanitizeTitle(name), author: engine.authorOf(name), composition, det });
    stats.classified++;
    options.onProgress?.(row);
  }
  return { results, stats };
}

export function needsReview(det) { return det.primary === 'mixed' || det.k < REVIEW_K; }
const round2 = x => Math.round(x * 100) / 100;

async function readOverrides(engine, dirs) {
  for (const dir of dirs) {
    const file = path.join(dir, 'categories.overrides.json');
    if (!(await exists(file))) continue;
    try {
      const json = await readJsonFile(file);
      const ids = new Set(engine.TAXONOMY.map(t => t.id));
      const out = new Map();
      if (json && json.format === OVERRIDES_FORMAT && json.entries && typeof json.entries === 'object') {
        for (const [hash, v] of Object.entries(json.entries)) {
          if (/^[0-9a-f]{64}$/.test(hash) && v && typeof v.c === 'string' && ids.has(v.c)) out.set(hash, { c: v.c, t: Array.isArray(v.t) ? v.t.filter(x => ids.has(x) && x !== v.c).slice(0, 2) : [] });
        }
      }
      return out;
    } catch { return new Map(); }
  }
  return new Map();
}

function buildCategories(engine, results, decisions, overrides, meta) {
  const entries = {};
  for (const r of results.slice().sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0))) {
    const d = decisions.get(r.row) ?? decide(r.det, null, false);
    const o = overrides.get(r.sha256);
    const taxon = o
      ? { c: o.c, t: o.t, e: r.det.facets.e, b: r.det.facets.b, f: r.det.facets.f, ...(r.author ? { a: r.author } : {}), s: 'o', k: 1 }
      : { c: d.c, t: d.t.slice(0, 2), e: r.det.facets.e, b: r.det.facets.b, f: r.det.facets.f, ...(r.author ? { a: r.author } : {}), s: d.s, k: round2(d.k) };
    entries[r.sha256] = taxon;
  }
  const hashes = Object.keys(entries);
  return {
    format: FORMAT, version: 1,
    taxonomy: { id: 'aaavs-style', version: engine.TAXONOMY_VERSION },
    generated: meta.generated,
    generator: { tool: 'classify-presets', method: 'structure-v1', jev: meta.jev },
    catalogSha: sha256(hashes.join('\n')),
    entries,
  };
}

function reviewCsv(engine, results, decisions, jevAnswers) {
  const rows = [];
  for (const r of results) {
    const d = decisions.get(r.row); const j = jevAnswers.get(r.row);
    const conflict = !!(d && d.disagree);
    if (!(needsReview(r.det) || conflict)) continue;
    rows.push({ conflict, k: r.det.k, cells: [r.row, r.title, r.det.primary, round2(r.det.k), j ? j.choice : '', j ? round2(j.p) : '', conflict ? 'yes' : '', ''] });
  }
  rows.sort((a, b) => Number(b.conflict) - Number(a.conflict) || a.k - b.k || a.cells[0] - b.cells[0]);
  return [csvLine(['row', 'title', 'deterministic', 'k', 'jev', 'p', 'conflict', 'category']), ...rows.map(r => csvLine(r.cells))].join('\r\n') + '\r\n';
}

/** Deterministic stratified sample for the owner's gold set: about 8 per category, weighted to low k, no randomness. */
export function goldSample(engine, results, size = 150, perCategory = 8) {
  const by = new Map(engine.TAXONOMY.map(t => [t.id, []]));
  for (const r of results) by.get(r.det.primary)?.push(r);
  const chosen = new Map();
  for (const list of by.values()) {
    list.sort((a, b) => a.det.k - b.det.k || a.row - b.row);
    const low = list.slice(0, Math.ceil(perCategory / 2));
    const rest = list.slice(low.length);
    const spread = [];
    const want = Math.min(rest.length, perCategory - low.length);
    for (let i = 0; i < want; i++) spread.push(rest[Math.floor((i * rest.length) / want)]);
    for (const r of [...low, ...spread]) chosen.set(r.row, r);
  }
  const all = [...results].sort((a, b) => a.det.k - b.det.k || a.row - b.row);
  for (const r of all) { if (chosen.size >= size) break; chosen.set(r.row, r); }
  return [...chosen.values()].sort((a, b) => a.row - b.row).slice(0, size);
}
function goldCsv(engine, sample) {
  const lines = sample.map(r => {
    const effects = engine.jevState(r.composition, null, false).effects.map(e => `${e.name} x${e.count}`).join('; ');
    return csvLine([r.row, r.title, effects, '']);
  });
  return [csvLine(['row', 'title', 'effects', 'category']), ...lines].join('\r\n') + '\r\n';
}

async function loadCache(file) {
  const cache = new Map();
  try {
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      try { const v = JSON.parse(line); if (v && /^[0-9a-f]{64}$/.test(v.key) && v.answer && typeof v.answer === 'object') cache.set(v.key, v); } catch { /* skip a corrupt line */ }
    }
  } catch { /* no cache yet */ }
  return cache;
}

async function runPool(items, limit, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { for (;;) { const i = next++; if (i >= items.length) return; await worker(items[i], i); } }));
}

// -------------------------------------------------------------------------------------------------------------------- run
export function defaultDeps() {
  return {
    env: process.env, fetch: globalThis.fetch, stdout: s => process.stdout.write(s), stderr: s => process.stderr.write(s),
    now: () => new Date(), sleep: ms => new Promise(r => setTimeout(r, ms)), random: Math.random, runKeyCommand: defaultRunKeyCommand,
  };
}

/** Runs the tool. `deps` are injected so the check drives it with a fake fetch and a sentinel environment; returns the exit code. */
export async function run(argv, depsIn = {}) {
  const deps = { ...defaultDeps(), ...depsIn };
  const say = s => deps.stdout(`${s}\n`), warn = s => deps.stderr(`${s}\n`);
  let opts;
  try { opts = parseArgs(argv); } catch (error) { warn(error instanceof UsageError ? error.message : 'Invalid arguments'); return 2; }
  if (opts.help) { say('Usage: node tools/classify-presets.mjs --collection <abs dir> [--out-dir <dir>] [--jev-dry-run | --jev --send] [--no-names] [--all] [--limit N] [--concurrency N] [--jev-apply] [--review-csv <csv>] [--gold-sample <csv>] [--import-review <csv>]'); return 0; }
  const engine = await loadEngine();
  const root = path.resolve(opts.collection);
  if (!(await exists(path.join(root, 'catalog', 'presets.json')))) { warn('The collection has no catalog/presets.json; nothing was written.'); return 2; }
  const catalogDir = path.join(root, 'catalog');
  const outDir = path.resolve(opts.outDir ?? catalogDir);
  const insideCollection = p => p === root || inside(root, p);
  const insideCatalog = p => p === catalogDir || inside(catalogDir, p);
  if (insideCollection(outDir) && !insideCatalog(outDir)) { warn('--out-dir may not be the collection or inside it outside catalog/.'); return 2; }
  // file outputs (review CSV, gold sample) follow the same confinement so a stray path cannot overwrite a preset or a catalog file
  for (const p of [opts.reviewCsv, opts.goldSample]) {
    if (p && insideCollection(path.resolve(p)) && !insideCatalog(path.resolve(p))) { warn('CSV outputs may not be inside the collection outside catalog/.'); return 2; }
  }
  await mkdir(outDir, { recursive: true });

  // ---- review import: the only writer of categories.overrides.json
  if (opts.importReview) {
    const catalog = await readJsonFile(path.join(root, 'catalog', 'presets.json'));
    const ids = new Set(engine.TAXONOMY.map(t => t.id));
    const rows = parseCsv(await readFile(opts.importReview, 'utf8'));
    const head = rows.shift() ?? [];
    const col = name => head.indexOf(name);
    const [cRow, cTitle, cCat] = [col('row'), col('title'), col('category')];
    if (cRow < 0 || cTitle < 0 || cCat < 0) { warn('The review CSV needs row, title and category columns.'); return 2; }
    const file = path.join(outDir, 'categories.overrides.json');
    const existing = (await exists(file)) ? await readOverrides(engine, [outDir]) : new Map();
    const merged = new Map(existing); let applied = 0, stale = 0, invalid = 0;
    for (const r of rows) {
      const category = (r[cCat] ?? '').trim();
      if (!category) continue;
      const entry = catalog.presets[Number(r[cRow])];
      if (!ids.has(category)) { invalid++; continue; }
      if (!entry || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256) || unapostrophe(engine.sanitizeTitle(entry.display_name ?? '')) !== unapostrophe(r[cTitle] ?? '')) { stale++; continue; }
      merged.set(entry.sha256, { c: category, t: [] }); applied++;
    }
    const sorted = Object.fromEntries([...merged].sort(([a], [b]) => (a < b ? -1 : 1)));
    await writeAtomic(file, JSON.stringify({ format: OVERRIDES_FORMAT, version: 1, taxonomy: { id: 'aaavs-style', version: engine.TAXONOMY_VERSION }, entries: sorted }, null, 1) + '\n', { allowOverrides: true });
    say(`Overrides: ${applied} applied, ${stale} stale rows ignored, ${invalid} unknown categories ignored. Rerun the classifier to fold them into categories.json.`);
    return 0;
  }

  // ---- offline classification (always)
  const { results, stats } = await classifyCollection(engine, root);
  const overrides = await readOverrides(engine, outDir === catalogDir ? [catalogDir] : [outDir, catalogDir]);
  const decisions = new Map(); const jevAnswers = new Map();
  let jevMeta = null, keyMissing = false;

  // ---- Jev path: off by default, dry-run first, key-gated
  if (opts.jev || opts.dryRun) {
    const candidates = results.filter(r => opts.all || needsReview(r.det));
    const chosen = opts.limit ? candidates.slice(0, opts.limit) : candidates;
    const questions = questionsFor(engine, opts);
    const payloads = chosen.map(r => ({ r, state: engine.jevState(r.composition, r.title, !opts.noNames) }));
    const tokens = payloads.reduce((n, p) => n + Math.ceil(JSON.stringify(requestBody(p.state, questions)).length / 4) + OVERHEAD_TOKENS, 0);
    const cost = (tokens * PRICE_PER_MILLION_INPUT_TOKENS) / 1e6;
    const willSend = opts.jev && opts.send && !opts.dryRun;
    if (!willSend) {
      say(`Jev DRY RUN (nothing is sent). Model ${JEV_MODEL}, prompt version ${JEV_PROMPT_VERSION}, ${payloads.length} requests${opts.noNames ? ', titles omitted' : ''}.`);
      say(`Estimated input tokens ${tokens}, about $${cost.toFixed(4)} at $${PRICE_PER_MILLION_INPUT_TOKENS}/M. Questions (identical in every request):`);
      say(JSON.stringify(questions));
      for (const p of payloads) say(JSON.stringify({ state: p.state }));
      say('To send, read the payloads above, then run again with --jev --send in your own shell with TYPESAFE_API_KEY set.');
    } else {
      const key = resolveKey(deps);
      if (!key) { keyMissing = true; warn('--send needs TYPESAFE_API_KEY (or TYPESAFE_API_KEY_COMMAND) in the environment. The offline result is still written.'); }
      else {
        const scrub = scrubber(key);
        const cachePath = path.join(outDir, 'categories.jev-cache.jsonl');
        const cache = await loadCache(cachePath);
        jevMeta = { model: JEV_MODEL, promptVersion: JEV_PROMPT_VERSION, validated: false };
        let hits = 0, calls = 0, failed = 0;
        await runPool(payloads, opts.concurrency, async ({ r, state }) => {
          const k = cacheKey(engine, state, opts);
          let answer = cache.get(k)?.answer ?? null;
          if (answer) hits++;
          else {
            calls++;
            const response = await callJev(deps, opts.jevUrl, key, requestBody(state, questions));
            const parsed = response.ok ? parseStyleAnswer(engine, response.json) : null;
            if (!parsed) { failed++; return; }
            answer = { choice: parsed.choice, p: parsed.p, q: parsed.q, ...(opts.intensity ? { intensity: parseIntensityAnswer(response.json) } : {}) };
            const line = { key: k, model: JEV_MODEL, promptVersion: JEV_PROMPT_VERSION, taxonomyVersion: engine.TAXONOMY_VERSION, answer };
            cache.set(k, line);
            await appendFile(cachePath, JSON.stringify(line) + '\n');
          }
          jevAnswers.set(r.row, answer);
          decisions.set(r.row, decide(r.det, answer, opts.apply));
        });
        say(scrub(`Jev: ${payloads.length} candidates, ${hits} cached, ${calls} calls, ${failed} kept deterministic after failure.${opts.apply ? '' : ' Results are recorded but not applied (pass --jev-apply after a gold-set check).'}`));
      }
    }
  }

  const doc = buildCategories(engine, results, decisions, overrides, { generated: deps.now().toISOString().replace(/\.\d{3}Z$/, 'Z'), jev: jevMeta });
  await writeAtomic(path.join(outDir, 'categories.json'), JSON.stringify(doc) + '\n');
  await writeAtomic(opts.reviewCsv ?? path.join(outDir, 'categories.review.csv'), reviewCsv(engine, results, decisions, jevAnswers));
  if (opts.goldSample) await writeAtomic(opts.goldSample, goldCsv(engine, goldSample(engine, results)));
  const dist = {};
  for (const e of Object.values(doc.entries)) dist[e.c] = (dist[e.c] ?? 0) + 1;
  say(`Classified ${stats.classified} of ${stats.entries} catalog entries (${stats.parseErrors} parse errors, ${stats.integrity} failed file or hash checks, ${stats.skippedKind} scene-kind rows skipped).`);
  say(`Distribution: ${Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(', ')}`);
  return keyMissing ? 3 : 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { process.stderr.write(`classify-presets failed: ${error && error.message ? error.message : 'unknown error'}\n`); process.exitCode = 1; });
}
