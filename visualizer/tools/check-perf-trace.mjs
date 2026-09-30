// CPU contract checks of the stage-timing instrumentation (src/perf-trace.ts, src/perf-worker.ts; docs/PERFORMANCE.md):
//  1. the stage catalog and the trace format (names, parents, statistics, validation, bounded recorder);
//  2. every stage name the sources emit is in the catalog, and every catalog stage is emitted by the source that owns it;
//  3. the instrumentation is OFF by default: nothing measured, nothing patched, no field added to a message, every hot-path call site guarded by
//     one boolean; turning it on patches the GL upload entry points on the instance only and turning it off restores them;
//  4. the worker's frame reply carries a valid report only when asked for.
// A rendered-frame identity check needs a GL context: see `node tools/render-show-stills.mjs --perf-identity` (browser, not part of npm run check).
//
//   node tools/check-perf-trace.mjs
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const VIS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = async (entry) => {
  const r = await build({ entryPoints: [join(VIS, entry)], bundle: true, format: 'esm', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);
};
let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };

const T = await bundle('src/perf-trace.ts');
const { PERF_STAGES, PERF_COUNTERS, isKnownStage, isKnownCounter, summarize, percentile, histogram, validateTrace, validateWorkerPerf, parsePerfMode, PerfRecorder, PERF_TRACE_FORMAT, PERF_TRACE_VERSION, FRAME_BUDGET_MS } = T;

// ------------------------------------------------------------------ 1. catalog and format
{
  const names = PERF_STAGES.map((s) => s.name);
  ok(new Set(names).size === names.length, 'stage names are unique');
  for (const s of PERF_STAGES) {
    ok(/^[a-z0-9]+(\.[a-z0-9_]+)+$/.test(s.name), `stage name shape: ${s.name}`);
    ok(s.where === 'worker' || s.where === 'host', `${s.name} has an owner`);
    ok(typeof s.desc === 'string' && s.desc.length > 20, `${s.name} is described`);
    if (s.parent) { const p = PERF_STAGES.find((x) => x.name === s.parent); ok(p, `${s.name}: parent ${s.parent} exists`); ok(p.where === s.where, `${s.name} and its parent live in the same place`); }
  }
  for (const s of PERF_STAGES) { const seen = new Set(); for (let c = s; c; c = PERF_STAGES.find((x) => x.name === c.parent)) { ok(!seen.has(c.name), `${s.name}: parent chain is acyclic`); seen.add(c.name); } }
  // the headline stages the bench and the docs name
  for (const must of ['frame.total', 'frame.window', 'live.push', 'frame.plates', 'engine.render', 'engine.composite', 'scene.render', 'engine.hud', 'engine.post', 'post.bloom', 'post.final', 'frame.fit', 'frame.bitmap', 'comp.draw', 'canvas2d.draw', 'gl.upload.canvas', 'host.rtt', 'host.present', 'host.raf.interval', 'host.audio.msg']) ok(isKnownStage(must), `${must} is a stage`);
  ok(isKnownStage('layer.magi.L.draw') && isKnownStage('layer.sync.hud.upload') && isKnownStage('layer.hud.draw') && isKnownStage('layer.magi#0.upload'), 'layer stages are open-ended');
  ok(!isKnownStage('layer.draw') && !isKnownStage('layer.x.y.z') && !isKnownStage('frame.nothing') && !isKnownStage('') && !isKnownStage('layer.a b.draw'), 'unknown names are rejected');
  for (const c of ['host.audio.messages', 'host.audio.frames', 'host.audio.floats', 'host.render.messages', 'host.render.bytes', 'host.frame.messages']) ok(isKnownCounter(c), `${c} is a counter`);
  ok(PERF_COUNTERS.length >= 6 && !isKnownCounter('frame.total'), 'counters and stages are separate namespaces');

  // statistics
  ok(percentile([1, 2, 3, 4], 0.5) === 2 && percentile([1, 2, 3, 4], 0.95) === 4 && percentile([], 0.5) === 0 && percentile([7], 0.99) === 7, 'nearest-rank percentiles');
  const sm = summarize([5, 1, 9, 3, 7]);
  ok(sm.n === 5 && sm.p50 === 5 && sm.max === 9 && Math.abs(sm.mean - 5) < 1e-12 && sm.p95 === 9, 'summary of five values');
  ok(summarize([]).n === 0 && summarize([]).max === 0, 'summary of nothing');
  const h = histogram([1, 5, 10, 16.6, 16.7, 17, 40, 5000]);
  ok(h.reduce((a, b) => a + b, 0) === 8 && h[0] === 1 && h[h.length - 1] === 1, 'histogram keeps every value and overflows the last');
  ok(Math.abs(FRAME_BUDGET_MS - 16.6667) < 1e-3, '60 fps budget');
  ok(parsePerfMode('sync') === 2 && parsePerfMode('1') === 1 && parsePerfMode('on') === 1 && parsePerfMode(null) === 0 && parsePerfMode('nope') === 0 && parsePerfMode('0') === 0 && parsePerfMode(undefined) === 0, 'perf mode parsing: anything unknown is off');

  // recorder: off by default, bounded, produces a valid trace
  let t = 0;
  const rec = new PerfRecorder(() => t);
  ok(rec.enabled === false && rec.level === 0 && rec.sync === false, 'the recorder is off by default');
  rec.record('host.rtt', 12); rec.add('host.audio.messages'); rec.recordWorker({ stages: { 'frame.total': 3 }, mode: 1 });
  ok(Object.keys(rec.summary()).length === 0 && rec.line() === null && rec.trace(false).frames === 0, 'a disabled recorder ignores every call');
  t = 1000; rec.enable(1);
  for (let i = 0; i < 6000; i++) rec.record('host.rtt', i % 50);
  rec.recordWorker({ stages: { 'frame.total': 9, 'scene.render': 6.5, 'layer.magi.L.draw': 4 }, counts: { 'scene.render': 1 }, mode: 1, epoch: 1e12 }, 1e12 + 2);
  rec.record('host.present', Number.NaN);
  rec.add('host.audio.messages', 120); rec.add('host.audio.frames', 240);
  t = 3000;
  const tr = rec.trace(true, { test: 1 });
  validateTrace(tr);
  ok(tr.format === PERF_TRACE_FORMAT && tr.version === PERF_TRACE_VERSION && tr.source === 'host' && tr.mode === 1, 'trace header');
  ok(tr.series['host.rtt'].length === 4096, 'series are bounded (ring of 4096)');
  ok(tr.stages['host.rtt'].n === 4096 && tr.stages['frame.total'].p50 === 9 && tr.stages['host.reply'].p50 === 2, 'worker stages and the reply latency are recorded');
  ok(!('host.present' in tr.stages), 'a non-finite sample is dropped');
  ok(tr.counters['host.audio.messages'].total === 120 && Math.abs(tr.counters['host.audio.messages'].perSecond - 60) < 1e-9 && tr.seconds === 2, 'counters are per second of the enabled window');
  ok(typeof rec.line() === 'string' && rec.line().startsWith('perf'), 'overlay line');
  rec.enable(2); ok(rec.sync, 'mode 2 is the synchronised mode');
  rec.disable(); ok(!rec.enabled && rec.line() === null, 'disable turns everything off');
  const copy = JSON.parse(JSON.stringify(tr)); validateTrace(copy);
  const bad = (mut, re) => { const c = JSON.parse(JSON.stringify(tr)); mut(c); assert.throws(() => validateTrace(c), re); n++; };
  bad((c) => { c.format = 'x'; }, /format/); bad((c) => { c.version = 2; }, /version/); bad((c) => { c.mode = 3; }, /mode/);
  bad((c) => { c.stages['not.a.stage'] = c.stages['host.rtt']; }, /unknown stage/); bad((c) => { c.stages['host.rtt'].p50 = NaN; }, /summary/);
  bad((c) => { c.stages['host.rtt'].p95 = 0; c.stages['host.rtt'].p50 = 5; }, /ordered/); bad((c) => { c.counters['nope'] = { total: 1, perSecond: 1 }; }, /unknown counter/);
  bad((c) => { c.series['host.rtt'] = ['a']; }, /series/); bad((c) => { c.frames = -1; }, /frames/); bad((c) => { delete c.stages; }, /stages/);
  assert.throws(() => validateTrace(null), /object/); n++;
  validateWorkerPerf({ stages: { 'frame.total': 1, 'layer.x.y.draw': 2 }, counts: { 'comp.draw': 3 }, mode: 2, epoch: 5 }); n++;
  for (const badFrame of [{ stages: { 'frame.total': -1 }, mode: 1 }, { stages: { 'nope': 1 }, mode: 1 }, { stages: {}, mode: 0 }, { stages: { 'frame.total': NaN }, mode: 1 }, { mode: 1 }, { stages: {}, mode: 1, epoch: 'x' }]) { assert.throws(() => validateWorkerPerf(badFrame)); n++; }
}

// ------------------------------------------------------------------ 2. source <-> catalog
const files = [];
const walk = (d) => { for (const nm of readdirSync(d)) { const p = join(d, nm); if (statSync(p).isDirectory()) { if (nm !== 'node_modules') walk(p); } else if (p.endsWith('.ts')) files.push(p); } };
walk(join(VIS, 'src'));
const emitted = { worker: new Map(), host: new Map(), counter: new Map() };
const add = (m, k, f) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(relative(VIS, f)); };
for (const f of files) {
  if (f.endsWith('perf-trace.ts')) continue;
  const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  for (const m of src.matchAll(/\bperf(?:End|Add)\(\s*'([^']+)'/g)) add(emitted.worker, m[1], f);
  for (const m of src.matchAll(/\bperf(?:End|Add)\(\s*`([^`]+)`/g)) add(emitted.worker, m[1], f);
  for (const m of src.matchAll(/\bperf\.record\(\s*'([^']+)'/g)) add(emitted.host, m[1], f);
  for (const m of src.matchAll(/\bperf\.add\(\s*'([^']+)'/g)) add(emitted.counter, m[1], f);
}
for (const [k, where] of emitted.worker) ok(isKnownStage(k.replace(/\$\{[^}]+\}/g, 'x')) || /^layer\.\$\{.+\}\.(draw|upload)$/.test(k), `worker stage ${k} (${[...where]}) is in the catalog`);
for (const [k, where] of emitted.host) ok(isKnownStage(k), `host stage ${k} (${[...where]}) is in the catalog`);
for (const [k, where] of emitted.counter) ok(isKnownCounter(k), `host counter ${k} (${[...where]}) is in the catalog`);
const BENCH_ONLY = new Set(['host.complete']); // emitted by tools/bench-shows.mjs, not by a page
for (const s of PERF_STAGES) {
  if (s.name === 'msg.request') { ok([...(emitted.worker.get('msg.request') ?? [])].some((f) => f.endsWith('show-render.worker.ts')), 'msg.request is emitted by the show worker'); continue; }
  if (s.where === 'worker') ok(emitted.worker.has(s.name) || (s.name.startsWith('layer.')), `catalog stage ${s.name} is emitted by the worker side`);
  else if (!BENCH_ONLY.has(s.name) && !s.name.startsWith('host.reply')) ok(emitted.host.has(s.name) || s.name === 'host.reply', `catalog stage ${s.name} is emitted by the host`);
}
ok(emitted.worker.has('layer.${this.id}.draw') && emitted.worker.has("layer.${layer?.id ?? 'unnamed'}.upload"), 'Layer2D draw and upload stages are emitted');
for (const c of PERF_COUNTERS) ok(emitted.counter.has(c.name), `counter ${c.name} is emitted`);

// ------------------------------------------------------------------ 3. off by default, guarded, reversible
{
  const guarded = [join(VIS, 'src/show-render.worker.ts'), ...files.filter((f) => f.includes('/src/show/'))];
  let lines = 0;
  for (const f of guarded) {
    const src = readFileSync(f, 'utf8').split('\n');
    src.forEach((line, i) => {
      if (/^\s*import /.test(line) || /^\s*\/\//.test(line) || /^\s*(\/?\*|\*\/)/.test(line)) return;
      if (!/\bperf(?:Begin|End|Add|Now)\(/.test(line)) return;
      if (/^function perfFrameStart|^export (const|function) perf/.test(line)) return;
      lines++;
      // the guard is on the line, or opens the block a couple of lines above
      const near = src.slice(Math.max(0, i - 3), i + 1).join('\n');
      ok(/PERF\.on|\bperf \?|if \(perf\)|\bperf\b.*\? perfNow/.test(near), `${relative(VIS, f)}:${i + 1} calls the profiler without a PERF.on guard: ${line.trim().slice(0, 100)}`);
    });
  }
  ok(lines > 25, `found the instrumented call sites (${lines})`);
  // the host: every recorder call is guarded by perf.enabled, and messages only gain a field while enabled
  const host = readFileSync(join(VIS, 'src/mpc-host.ts'), 'utf8').split('\n');
  let hostCalls = 0;
  host.forEach((line, i) => {
    if (!/\bperf\.(record|add|recordWorker)\(/.test(line)) return;
    hostCalls++;
    // guarded on the same line, inside an `if (perf.enabled)` block opened a few lines above, or after the frame wrapper's early return
    const near = host.slice(Math.max(0, i - 8), i + 1).join('\n');
    ok(/perf\.enabled/.test(near), `mpc-host.ts:${i + 1} records without a perf.enabled guard: ${line.trim().slice(0, 100)}`);
  });
  ok(hostCalls >= 10, `found the host's recorder calls (${hostCalls})`);
  const hostSrc = host.join('\n');
  ok(/const perf = new PerfRecorder/.test(hostSrc) && /isNerv&&perf\.enabled\?\{perf:perfRequest\(\)\}:\{\}/.test(hostSrc), 'the host adds a perf field to a render request only while enabled, and only for the show worker presets');
  ok(/if \(!perf\.enabled\) \{ frameBody\(now\); return; \}/.test(hostSrc), 'the frame loop takes no measurements while disabled');
  const workerSrc = readFileSync(join(VIS, 'src/show-render.worker.ts'), 'utf8');
  ok(/const urlPerf: PerfMode = parsePerfMode\(/.test(workerSrc) && /perfConfigure\(perf \? perf\.mode : urlPerf\)/.test(workerSrc), 'the worker is off unless its URL or the message asks');
  ok(/\.\.\.\(perf \? \{ perf \} : \{\}\)/.test(workerSrc) && (workerSrc.match(/\.\.\.\(perf \? \{ perf \} : \{\}\)/g) ?? []).length === 2, 'both frame replies carry a report only when one was taken');
}
{
  // behaviour of the profiler module with a fake GL context and fake canvases
  class FakeCanvas { constructor() { this.width = 4; } }
  globalThis.OffscreenCanvas = FakeCanvas;
  const calls = [];
  class FakeGL {
    constructor() { this.reads = 0; this.finishes = 0; this.readBinding = 'original'; this.log = []; }
    finish() { this.finishes++; }
    isContextLost() { return false; } createTexture() { return {}; } createFramebuffer() { return { private: true }; }
    getParameter() { return this.readBinding; } bindTexture() {} framebufferTexture2D() {}
    bindFramebuffer(target, fb) { this.readBinding = fb; this.log.push(fb); }
    readPixels() { this.reads++; }
    texImage2D(...a) { calls.push(['texImage2D', a.length]); }
    texSubImage2D(...a) { calls.push(['texSubImage2D', a.length]); }
    bufferData() { calls.push(['bufferData']); }
    bufferSubData() { calls.push(['bufferSubData']); }
  }
  const P = await bundle('src/perf-worker.ts');
  const { PERF, perfConfigure, perfSetContext, perfTake, perfBegin, perfEnd, perfAdd, perfRegisterLayer } = P;
  ok(PERF.on === false && PERF.sync === false && PERF.gl === null, 'the profiler is off on import');
  ok(perfTake() === undefined, 'a disabled profiler reports nothing');
  const gl = new FakeGL();
  perfSetContext(gl);
  ok(PERF.gl === gl && !Object.hasOwn(gl, 'texImage2D') && !Object.hasOwn(gl, 'bufferSubData'), 'registering the context patches nothing while off');
  const cv = new FakeCanvas(), layer = { id: 'magi.L' };
  perfRegisterLayer(cv, layer);
  gl.texImage2D(1, 2, 3, 4, 5, cv); gl.bufferSubData();
  ok(perfTake() === undefined, 'uploads are not measured while off');
  perfConfigure(1);
  ok(PERF.on && !PERF.sync && Object.hasOwn(gl, 'texImage2D') && Object.hasOwn(gl, 'texSubImage2D') && Object.hasOwn(gl, 'bufferData') && Object.hasOwn(gl, 'bufferSubData'), 'mode 1 patches the four upload entry points on the instance');
  ok(!Object.hasOwn(FakeGL.prototype, 'texImage2D') || FakeGL.prototype.texImage2D !== gl.texImage2D, 'the prototype is left alone');
  gl.texImage2D(1, 2, 3, 4, 5, cv); gl.texSubImage2D(1, 0, 0, 0, 4, 4, 6, 7, cv); gl.texImage2D(1, 2, 3, 4, 5, new Uint8Array(4)); gl.bufferSubData(); gl.bufferData();
  ok(calls.filter((c) => c[0] === 'texImage2D').length >= 2 && calls.some((c) => c[0] === 'texSubImage2D') && calls.some((c) => c[0] === 'bufferData'), 'the originals are still called with the same arguments');
  const t0 = perfBegin(); perfEnd('scene.render', t0); perfAdd('comp.draw', 1.5);
  ok(gl.reads === 0 && gl.finishes === 0, 'mode 1 never waits for the GPU');
  const rep = perfTake();
  validateWorkerPerf(rep);
  ok(rep.mode === 1 && rep.stages['gl.upload.canvas'] >= 0 && 'layer.magi.L.upload' in rep.stages && 'gl.upload.data' in rep.stages && 'gl.upload.buffer' in rep.stages && rep.stages['comp.draw'] >= 1.5 && rep.counts['gl.upload.canvas'] === 2 && typeof rep.epoch === 'number' || rep.epoch === undefined, 'uploads are attributed to their layer, to typed data and to buffers');
  ok(Object.keys(perfTake().stages).length === 0, 'a report resets the accumulators');
  perfConfigure(2);
  ok(PERF.sync, 'mode 2 is synchronised');
  const b = perfBegin(); ok(gl.reads === 1, 'sync mode waits for the GPU (a 1x1 readPixels, since Chromium\'s finish() only flushes) before a stage'); perfEnd('post.final', b); ok(gl.reads === 2, 'and after it');
  ok(gl.readBinding === 'original' && gl.log.some((x) => x && x.private), 'the read framebuffer binding is restored after the wait, so three.js\' state cache stays valid');
  ok(perfTake().mode === 2, 'the report names its mode');
  perfConfigure(0);
  ok(!PERF.on && !PERF.sync && !Object.hasOwn(gl, 'texImage2D') && !Object.hasOwn(gl, 'bufferData') && perfTake() === undefined, 'turning it off removes the patches and the report');
  const before = calls.length; gl.texImage2D(1, 2, 3, 4, 5, cv); ok(calls.length === before + 1 && perfTake() === undefined, 'after off, uploads call straight through unmeasured');
}

// ------------------------------------------------------------------ 5. the documentation stays in step
{
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [join(VIS, 'tools/perf-docs.mjs'), '--check'], { stdio: 'pipe' }); n++;
  const doc = readFileSync(join(VIS, '..', 'docs/PERFORMANCE.md'), 'utf8');
  for (const s of PERF_STAGES) ok(doc.includes(`\`${s.name}\``), `docs/PERFORMANCE.md names ${s.name}`);
  for (const c of PERF_COUNTERS) ok(doc.includes(c.name), `docs/PERFORMANCE.md names ${c.name}`);
  ok(doc.includes('node tools/bench-shows.mjs --gpu --chromium "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --sizes 1920x1080,3840x2160 --seconds 20 --out bench.json'), 'the Windows command for the owner is documented');
  const benchSrc = readFileSync(join(VIS, 'tools/bench-shows.mjs'), 'utf8');
  for (const o of ['--seconds', '--sizes', '--plates', '--chromium', '--gpu', '--browser-arg', '--headed', '--sync', '--compare', '--out', '--avs-dir', '--multiview']) { ok(benchSrc.includes(o) && doc.includes(o), `bench option ${o} exists and is documented`); }
}

console.log(`Performance instrumentation contract PASS (${n} assertions): stage catalog and trace format, source/catalog agreement, off by default and reversible, guarded call sites.`);
