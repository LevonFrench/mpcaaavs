// Source rules for the show engine and its plates (AAAVS, AGENTS.md "every frame is a deterministic function of media
// time, seed and audio"): no wall clock and no unseeded randomness in src/show/ and src/shows/, no stateful scene
// without a bounded preroll, and the worker's timing reads (performance.now) only measure renderMs / init time.
// The browser half of the proof (seek-replay pixel comparison) is `node tools/render-show-stills.mjs --determinism`.
//
//   node tools/check-show-determinism.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const VIS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
walk(join(VIS, 'src/show')); walk(join(VIS, 'src/shows'));
assert.ok(files.length > 40, `found the show sources (${files.length})`);
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
let n = 0;
const FORBIDDEN = [[/\bMath\.random\s*\(/, 'Math.random'], [/\bDate\.now\s*\(/, 'Date.now'], [/\bnew Date\s*\(/, 'new Date'], [/\bperformance\.now\s*\(/, 'performance.now'],
  [/\bcrypto\.getRandomValues\s*\(/, 'crypto.getRandomValues'], [/\brequestAnimationFrame\s*\(/, 'requestAnimationFrame'], [/\bsetTimeout\s*\(|\bsetInterval\s*\(/, 'timers']];
for (const f of files) {
  const src = strip(readFileSync(f, 'utf8'));
  for (const [re, what] of FORBIDDEN) { n++; assert.ok(!re.test(src), `${relative(VIS, f)} uses ${what}: frames must be functions of media time, seed and audio`); }
  if (/stateful\s*=\s*true/.test(src)) { n++; assert.ok(/prerollMax\s*=/.test(src), `${relative(VIS, f)} is stateful without a bounded prerollMax`); }
}
// the worker may read performance.now only for renderMs and init timings
const worker = strip(readFileSync(join(VIS, 'src/show-render.worker.ts'), 'utf8'));
for (const line of worker.split('\n').filter((l) => /performance\.now/.test(l))) {
  n++; assert.ok(/(started|t0|renderMs|elapsed|initMs)/.test(line), `show worker reads the clock outside timing: ${line.trim()}`);
}
n++; assert.ok(!/Math\.random|Date\.now|new Date/.test(worker), 'show worker: no randomness or wall clock');
console.log(`Show determinism source rules PASS (${n} assertions over ${files.length} files): no wall clock, timers or unseeded randomness in the engine and plates; the worker times only renderMs and init.`);
