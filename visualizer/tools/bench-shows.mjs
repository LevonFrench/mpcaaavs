// Per-stage benchmark of the NERV show engine and Multiview (AAAVS). See docs/PERFORMANCE.md.
//
// Drives the REAL workers in headless (or headed) Chromium the way the MPC host and the Player do: the NERV preset dialect
// ('load' a .nerv preset, then 'render' with a NervPlaybackFrame and an AvsAudioFrame on every display tick), with synthetic AVS
// audio frames from the real AvsAudioAnalyser at the display rate and a media clock that follows the wall clock. Reports
// per-stage p50/p95/max, dropped frames against a 60 fps budget, the effective fps and a frame-time histogram, and writes JSON.
//
//   node tools/bench-shows.mjs --chromium /opt/pw-browsers/chromium --seconds 10 --out bench.json
//   node tools/bench-shows.mjs --plates magi,berserk --sizes 1920x1080,3840x2160 --seconds 5
//   node tools/bench-shows.mjs --gpu --chromium "C:\Program Files\Google\Chrome\Application\chrome.exe" --seconds 20 --out bench.json   (real GPU)
//   node tools/bench-shows.mjs --compare ../baseline-checkout/visualizer --plates magi --sizes 1920x1080     (A/B, interleaved)
//
// Options
//   --seconds N          measured seconds per plate and size (default 10); the run continues (up to 3x) until --min-frames are in
//   --warmup N           unmeasured seconds before it (default 1.5): scene build, shader compile, first-use uploads
//   --min-frames N       frames each slot must deliver (default 20) so a slow 4K run still has a distribution
//   --sizes WxH,...      render sizes (default 1920x1080,3840x2160). The show engine renders 1920x1080 x scale: 4K = the worker at ?scale=2
//   --plates a,b,...     NERV plates (or none; default all 16: boot magi psycho radar harmonics seele battery atfield alert plug target city sync berserk impact end)
//   --multiview 2,4      Multiview lane counts (default 2,4; --multiview none to skip)
//   --multiview-modes    real (the real MultiViewSession with its Canvas2D NERV workers, what the product runs) and/or show (N concurrent show-engine
//                        preset workers at pane size: not a product path, it measures what the show engine would cost in panes). Default real,show
//   --mv-plates a,b,c,d  plates shown by Multiview (default magi,radar,seele,berserk)
//   --avs-dir <dir>      benchmark the heaviest .avs presets of a local catalogue (private data stays on the owner's machine); --avs-max N (default 6), --avs-size WxH
//   --avs-synth          also benchmark three synthetic heavy AVS presets built in code (SuperScope point clouds, line scopes, scopes + heavy blur): the repository has no
//                        public AVS bank, so these are the only AVS presets it can bench without the owner's catalogue
//   --sync               GL-synchronised stage timing (a GPU wait around GL stages): attributes GPU time to stages but distorts pipelining
//   --identity           instead of timing: prove the instrumentation does not change a frame. Each plate's frames go through a fresh worker with stage timing off, on, synchronised
//                        and off again (noise floor) in the NERV preset dialect, and the last frames are compared pixel by pixel. Exit status 1 on any difference above the noise
//   --no-stages          instrumentation off in the worker (pure frame timing; use for the cleanest A/B)
//   --pacing raf|timer   how display ticks are generated (default: raf with --gpu or --headed, a 60 Hz timer in headless software-GL runs)
//   --complete / --no-complete  force each frame's pixels to exist before it counts (a 1-pixel readback of the presented canvas). Default on for software GL,
//                        where the worker answers before the GPU-process CPU has shaded the frame; off with --gpu (the host does not wait for the GPU)
//   --compare <dir>      another checkout's visualizer/ directory: candidate (this checkout) and baseline run interleaved, plate by plate, in one browser session
//   --repeat N           rounds (default 1); with --compare the order alternates each round and the frames of all rounds are pooled
//   --chromium <path>    browser executable (or env SHOW_CHROMIUM); default: playwright's own
//   --gpu                use the real GPU: no SwiftShader flags (the default flags force software GL, relative numbers only)
//   --browser-arg <a>    extra Chromium flag, repeatable
//   --headed             a visible browser window (real vsync on most systems)
//   --out <file>         write the JSON report;  --raw  add per-frame round-trip times;  --merge a.json,b.json  combine reports (with --out)
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, extname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const VIS = resolve(here, '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const opts = (k) => argv.flatMap((a, i) => (a === `--${k}` && i + 1 < argv.length ? [argv[i + 1]] : []));
const flag = (k) => argv.includes(`--${k}`);
const num = (k, d) => { const v = Number(opt(k, d)); if (!Number.isFinite(v) || v < 0) throw new Error(`--${k} must be a number`); return v; };
if (flag('help') || flag('h')) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); process.exit(0); }

const NERV_PLATES = ['boot', 'magi', 'psycho', 'radar', 'harmonics', 'seele', 'battery', 'atfield', 'alert', 'plug', 'target', 'city', 'sync', 'berserk', 'impact', 'end'];
const SECONDS = num('seconds', 10), WARMUP = num('warmup', 1.5), MIN_FRAMES = num('min-frames', 20), REPEAT = Math.max(1, Math.round(num('repeat', 1)));
const SIZES = opt('sizes', '1920x1080,3840x2160').split(',').map((s) => { const m = /^(\d+)x(\d+)$/.exec(s.trim()); if (!m) throw new Error(`bad size ${s}`); return { label: `${m[1]}x${m[2]}`, width: +m[1], height: +m[2], scale: Math.min(4, Math.max(1, Math.round(+m[1] / 1920))) }; });
const PLATES = opt('plates') === 'none' ? [] : opt('plates') ? opt('plates').split(',').map((s) => s.trim()).filter(Boolean) : NERV_PLATES;
for (const p of PLATES) if (!NERV_PLATES.includes(p)) throw new Error(`unknown plate ${p} (have ${NERV_PLATES.join(' ')})`);
const MV_COUNTS = opt('multiview', '2,4') === 'none' ? [] : opt('multiview', '2,4').split(',').map(Number);
const MV_MODES = opt('multiview-modes', 'real,show').split(',');
const MV_PLATES = opt('mv-plates', 'magi,radar,seele,berserk').split(',');
const PERF_MODE = flag('no-stages') ? 0 : flag('sync') ? 2 : 1;
const OUT = opt('out') ? resolve(opt('out')) : null;
const COMPARE = opt('compare') ? resolve(opt('compare')) : null;
const AVS_DIR = opt('avs-dir') ? resolve(opt('avs-dir')) : null;
const AVS_SYNTH = flag('avs-synth');
const EXE = opt('chromium', process.env.SHOW_CHROMIUM) || undefined;
const FRAME_BUDGET_MS = 1000 / 60;
const PACING = opt('pacing', flag('gpu') || flag('headed') ? 'raf' : 'timer');
const COMPLETE = flag('no-complete') ? false : flag('complete') ? true : !flag('gpu');
const HOT = ['scene.render', 'engine.hud', 'post.bloom', 'post.final', 'engine.blit', 'engine.xfade', 'engine.spectrum', 'frame.fit', 'frame.transition', 'frame.bitmap', 'frame.window', 'live.push', 'frame.reply'];
const log = (...a) => console.log(...a);

// ------------------------------------------------------------------ shared statistics (src/perf-trace.ts, bundled so the bench and the page trace agree)
const traceLib = await (async () => {
  const r = await build({ entryPoints: [join(VIS, 'src/perf-trace.ts')], bundle: true, format: 'esm', write: false, logLevel: 'warning' });
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);
})();
const { summarize, histogram, roundSummary, validateTrace, FRAME_HISTOGRAM_EDGES, PERF_TRACE_FORMAT, PERF_TRACE_VERSION, isKnownStage } = traceLib;

if (opt('merge')) {
  const parts = opt('merge').split(',').map((f) => JSON.parse(readFileSync(resolve(f), 'utf8')));
  const merged = { ...parts[0], created: new Date().toISOString(), notes: [...new Set(parts.flatMap((p) => p.notes ?? []))], sourceOptions: parts.map((p) => p.options), merged: opt('merge').split(',').map((f) => f.split(/[\\/]/).pop()), results: parts.flatMap((p) => p.results) };
  if (OUT) { writeFileSync(OUT, formatJson(merged)); log(`merged ${merged.results.length} results -> ${OUT}`); }
  report(merged.results);
  process.exit(0);
}

// ------------------------------------------------------------------ build + serve (one set of builds per checkout)
const BUILD_ROOT = join(VIS, '.tmp', 'bench');
const localBitmaps = { name: 'local-preset-assets', setup(b) {
  b.onResolve({ filter: /(^|\/)bundled-bitmaps\.ts$/ }, () => ({ path: 'local-bitmap-resolver', namespace: 'mpc-local' }));
  b.onLoad({ filter: /.*/, namespace: 'mpc-local' }, () => ({ contents: 'export async function loadBundledAvsBitmapResolver() { return () => null; }', loader: 'js' }));
} };
async function prepare(key, dir) {
  const out = join(BUILD_ROOT, key);
  mkdirSync(out, { recursive: true });
  for (const w of ['show-render', 'nerv-render'].concat(AVS_DIR || AVS_SYNTH ? ['avs-render'] : [])) {
    await build({ entryPoints: [join(dir, `src/${w}.worker.ts`)], bundle: true, format: 'esm', target: 'es2022', outdir: out, entryNames: '[name]', loader: { '.wgsl': 'text' }, plugins: [localBitmaps], logLevel: 'warning' });
  }
  await build({ entryPoints: [join(VIS, 'tools/bench-shows-page.ts')], bundle: true, format: 'esm', target: 'es2022', outfile: join(out, 'page.js'), alias: { '@viz': join(dir, 'src') }, loader: { '.wgsl': 'text' }, plugins: [localBitmaps], logLevel: 'warning' });
  writeFileSync(join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><title>bench</title><body style="margin:0;background:#000"><script type="module" src="./page.js"></script>');
  return { key, dir, out };
}
const sides = [await prepare('cand', VIS)];
if (COMPARE) {
  if (!existsSync(join(COMPARE, 'src/show-render.worker.ts'))) throw new Error(`--compare ${COMPARE} is not a visualizer directory`);
  sides.push(await prepare('base', COMPARE));
}
sides[0].name = 'candidate'; if (sides[1]) sides[1].name = 'baseline';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.nerv': 'application/json', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.avs': 'application/octet-stream' };
const avsFiles = [];
const server = createServer((req, rsp) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const m = /^\/(cand|base)\/(.*)$/.exec(p);
  let f = null;
  if (m) {
    const side = sides.find((s) => s.key === m[1]);
    const rest = m[2];
    f = rest.startsWith('show-assets/') || rest.startsWith('nerv-presets/') ? join(side.dir, rest) : join(side.out, rest);
    if (!f.startsWith(side.dir) && !f.startsWith(side.out)) f = null;
  } else if (p.startsWith('/avsfile/')) f = avsFiles[+p.slice(9)] ?? null;
  if (!f || !existsSync(f) || statSync(f).isDirectory()) { rsp.writeHead(404); rsp.end('not found'); return; }
  rsp.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  rsp.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------------------------ browser
const SOFTWARE_GL = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const ARGS = [...(flag('gpu') ? ['--ignore-gpu-blocklist'] : SOFTWARE_GL), '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', ...opts('browser-arg')];
const browser = await chromium.launch({ headless: !flag('headed'), executablePath: EXE, args: ARGS });
const pages = new Map();
const pageLogs = [];
for (const s of sides) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(0);
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !/willReadFrequently|Failed to load resource: the server responded with a status of 404/.test(m.text())) pageLogs.push(`[${s.name} ${m.type()}] ${m.text()}`); });
  page.on('response', (r) => { if (r.status() === 404 && !/favicon/.test(r.url())) pageLogs.push(`[${s.name}] 404 ${r.url()}`); });
  page.on('pageerror', (e) => pageLogs.push(`[${s.name} pageerror] ${e.message}`));
  await page.goto(`${ORIGIN}/${s.key}/index.html`);
  await page.waitForFunction(() => window.benchReady);
  pages.set(s.key, page);
}
const browserVersion = browser.version();
const gpu = await pages.get('cand').evaluate(() => window.bench.gpuInfo());
log(`bench: ${browserVersion}${EXE ? ` (${EXE})` : ''}, ${flag('gpu') ? 'real GPU flags' : 'software GL (SwiftShader): numbers are relative only'}, GL ${gpu ? `${gpu.vendor} / ${gpu.renderer}` : 'unavailable'}`);
log(`       ${SECONDS} s + ${WARMUP} s warmup per run, >= ${MIN_FRAMES} frames, stages ${PERF_MODE === 0 ? 'off' : PERF_MODE === 2 ? 'GL-synchronised' : 'on'}${COMPARE ? `, A/B against ${COMPARE}` : ''}`);

// ------------------------------------------------------------------ result assembly
const r2 = (x) => Math.round(x * 100) / 100;
function summary(values) { return roundSummary(summarize(values)); }

/** Merge the raw slot output of several rounds of the same task. */
function pool(runs) {
  const first = runs[0];
  const workers = first.workers.map((w, i) => ({ ...w, ticks: 0, missed: 0, requests: 0, bytes: 0, frames: [], loadMs: [], firstMs: [], lit: [] }));
  const raf = [];
  let seconds = 0;
  for (const run of runs) {
    run.workers.forEach((w, i) => {
      const t = workers[i];
      t.ticks += w.ticks; t.missed += w.missed; t.requests += w.requests; t.bytes += w.bytes; t.frames.push(...w.frames);
      t.loadMs.push(w.loadMs); t.firstMs.push(w.firstMs); t.lit.push(w.lit); t.error ??= w.error;
    });
    raf.push(...run.raf); seconds += run.seconds;
  }
  return { workers, raf, seconds, gpu: first.gpu };
}

const HEADLINE_STAGES = ['frame.total'];
function frameStats(frames) {
  const n = frames.length;
  const rtt = frames.map((f) => f.done ?? f.rtt);
  const replied = frames.map((f) => f.rtt);
  const stageNames = new Set();
  for (const f of frames) if (f.stages) for (const k of Object.keys(f.stages)) stageNames.add(k);
  const stages = {};
  for (const name of stageNames) stages[name] = summary(frames.map((f) => f.stages?.[name] ?? 0));
  const workerTotal = frames.some((f) => f.stages?.['frame.total'] !== undefined) ? frames.map((f) => f.stages?.['frame.total'] ?? 0) : frames.map((f) => f.renderMs ?? 0);
  return { n, rtt, replied, stages, workerTotal };
}

function slotResult(side, task, w, rafMs, measuredSeconds) {
  const fs = frameStats(w.frames);
  const n = fs.n;
  const span = n >= 2 ? (w.frames[n - 1].at - w.frames[0].at) / 1000 : 0;
  const effectiveFps = span > 0 ? (n - 1) / span : 0;
  const over = fs.rtt.filter((v) => v > FRAME_BUDGET_MS).length;
  const stages = fs.stages;
  const hostStages = { 'host.rtt': summary(fs.replied), 'host.present': summary(w.frames.map((f) => f.present)) };
  const completes = w.frames.map((f) => f.done === null || f.done === undefined ? null : Math.max(0, f.done - f.rtt)).filter((v) => v !== null);
  if (completes.length) hostStages['host.complete'] = summary(completes);
  const replies = w.frames.map((f) => f.reply).filter((v) => typeof v === 'number');
  if (replies.length) hostStages['host.reply'] = summary(replies);
  if (rafMs.length) hostStages['host.raf.interval'] = summary(rafMs);
  const all = { ...stages, ...hostStages };
  for (const k of Object.keys(all)) if (!isKnownStage(k)) delete all[k];
  // a stage that never reached 0.02 ms is noise: dropped to keep reports small
  for (const k of Object.keys(all)) if (all[k].max < 0.02) delete all[k];
  const counters = { 'host.render.messages': { total: w.requests, perSecond: r2(w.requests / Math.max(0.001, measuredSeconds)) }, 'host.render.bytes': { total: w.bytes, perSecond: Math.round(w.bytes / Math.max(0.001, measuredSeconds)) } };
  const trace = { format: PERF_TRACE_FORMAT, version: PERF_TRACE_VERSION, source: 'bench', mode: PERF_MODE, frames: n, seconds: r2(measuredSeconds), stages: all, counters };
  validateTrace(trace);
  const extras = {};
  for (const [k, key] of [['effectMs', 'fx'], ['uploadMs', 'up'], ['encodeSubmitMs', 'enc'], ['gpuMs', 'gpu'], ['gpuLatencyMs', 'gpuLat']]) {
    const v = w.frames.map((f) => f[key]).filter((x) => typeof x === 'number');
    if (v.length) extras[k] = summary(v);
  }
  return {
    kind: task.kind, side: side.name, stagesMode: PERF_MODE === 2 ? 'sync' : PERF_MODE === 1 ? 'cpu' : 'off', name: task.name, size: task.size, scale: task.scale, renderer: w.renderer ?? null, replySize: w.replySize ? `${w.replySize[0]}x${w.replySize[1]}` : null,
    frames: n, seconds: r2(measuredSeconds), effectiveFps: r2(effectiveFps), ticks: w.ticks, missedTicks: w.missed, missedPct: r2(100 * w.missed / Math.max(1, w.ticks)),
    overBudget: over, overBudgetPct: r2(100 * over / Math.max(1, n)),
    loadMs: r2(median(w.loadMs)), firstFrameMs: r2(median(w.firstMs)), lit: r2(median(w.lit)),
    total: summary(fs.rtt), worker: summary(fs.workerTotal),
    histogram: { edges: [...FRAME_HISTOGRAM_EDGES], counts: histogram(fs.rtt, FRAME_HISTOGRAM_EDGES) },
    ...(Object.keys(extras).length ? { extras } : {}),
    trace,
    ...(flag('raw') ? { raw: { rtt: fs.rtt.map(r2) } } : {}),
  };
}
const median = (a) => { const s = [...a].filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

// ------------------------------------------------------------------ tasks
const results = [];
const order = (round, i) => (sides.length === 2 && (round + i) % 2 === 1 ? [sides[1], sides[0]] : sides);
async function runSide(side, fn) { return fn(pages.get(side.key), `/${side.key}`); }

async function plateTask(plate, size, round, i) {
  const task = { kind: 'plate', name: plate, size: size.label, scale: size.scale };
  const out = new Map();
  for (const side of order(round, i)) {
    const run = await runSide(side, (page, root) => page.evaluate((o) => window.bench.runSlots(o), {
      seconds: SECONDS, warmup: WARMUP, minFrames: MIN_FRAMES, perfMode: PERF_MODE, pacing: PACING, complete: COMPLETE,
      slots: [{ root, file: 'show-render.worker.js', plate, kind: 'nerv', width: size.width, height: size.height, scale: size.scale, rect: { x: 0, y: 0, w: 1920, h: 1080 } }] }));
    if (run.workers[0].error) throw new Error(`${side.name} ${plate} ${size.label}: ${run.workers[0].error}\n${pageLogs.slice(-10).join('\n')}`);
    out.set(side.name, { task, run });
  }
  return out;
}

async function multiviewTask(count, mode, round, i) {
  const layout = count === 2 ? 'columns' : 'grid';
  const plates = MV_PLATES.slice(0, count);
  const task = { kind: `multiview-${mode}`, name: `${count} lanes (${layout}: ${plates.join('+')})`, size: '1920x1080', scale: 1, count };
  const out = new Map();
  for (const side of order(round, i)) {
    if (mode === 'real') {
      const run = await runSide(side, (page, root) => page.evaluate((o) => window.bench.runMultiview(o), { root, plates, count, layout, seconds: SECONDS, warmup: Math.max(WARMUP, 3), pacing: PACING, complete: COMPLETE }));
      out.set(side.name, { task, run });
    } else {
      const cols = count === 2 ? 2 : 2, rows = count === 2 ? 1 : 2, gut = 4;
      const pw = Math.floor((1920 - gut * (cols - 1)) / cols), ph = Math.floor((1080 - gut * (rows - 1)) / rows);
      const slots = plates.map((plate, k) => ({ root: `/${side.key}`, file: 'show-render.worker.js', plate, kind: 'nerv', width: pw, height: ph, scale: 1, rect: { x: (k % cols) * (pw + gut), y: Math.floor(k / cols) * (ph + gut), w: pw, h: ph } }));
      const run = await runSide(side, (page) => page.evaluate((o) => window.bench.runSlots(o), { seconds: SECONDS, warmup: WARMUP, minFrames: MIN_FRAMES, perfMode: PERF_MODE, pacing: PACING, complete: COMPLETE, slots }));
      out.set(side.name, { task: { ...task, size: `${pw}x${ph} x${count}` }, run });
    }
  }
  return out;
}

function assemble(taskRuns) {
  // taskRuns: array (rounds) of Map(side -> {task, run}); pooled per side
  const produced = [];
  for (const side of sides) {
    const runs = taskRuns.map((m) => m.get(side.name)).filter(Boolean);
    if (!runs.length) continue;
    const task = runs[0].task;
    if (task.kind === 'multiview-real') { produced.push(multiviewReal(side, task, runs.map((r) => r.run))); continue; }
    const pooled = pool(runs.map((r) => r.run));
    if (task.kind === 'multiview-show') {
      const per = pooled.workers.map((w) => slotResult(side, { ...task, name: `${task.name} pane ${w.plate}` }, w, pooled.raf, pooled.seconds));
      const all = pooled.workers.flatMap((w) => w.frames);
      const agg = slotResult(side, task, { ...pooled.workers[0], frames: all, ticks: pooled.workers.reduce((a, w) => a + w.ticks, 0), missed: pooled.workers.reduce((a, w) => a + w.missed, 0), requests: pooled.workers.reduce((a, w) => a + w.requests, 0), bytes: pooled.workers.reduce((a, w) => a + w.bytes, 0) }, pooled.raf, pooled.seconds);
      produced.push({ ...agg, effectiveFps: r2(per.reduce((x, p) => x + p.effectiveFps, 0)), panes: per.map((p) => ({ plate: p.name.split(' pane ')[1], frames: p.frames, fps: p.effectiveFps, rttP50: p.total.p50, rttP95: p.total.p95, workerP50: p.worker.p50, missedPct: p.missedPct })) });
    } else produced.push(slotResult(side, task, pooled.workers[0], pooled.raf, pooled.seconds));
  }
  return produced;
}

function multiviewReal(side, task, runs) {
  const seconds = runs.reduce((a, r) => a + r.wall, 0);
  const wk = new Map();
  for (const r of runs) for (const w of r.workers) { if (!wk.has(w.plate)) wk.set(w.plate, []); wk.get(w.plate).push(...w.frames); }
  const panes = [...wk].map(([plate, frames]) => ({ plate, frames: frames.length, fps: r2(frames.length / Math.max(0.001, seconds)), rtt: summary(frames.map((f) => f.rtt)), renderMs: summary(frames.map((f) => f.renderMs)) }));
  const allRtt = [...wk.values()].flat().map((f) => f.rtt);
  const frameMs = runs.flatMap((r) => r.frameMs), presents = runs.flatMap((r) => r.presents), completes = runs.flatMap((r) => r.completes), raf = runs.flatMap((r) => r.raf), ages = runs.flatMap((r) => r.ages);
  const presentCount = runs.reduce((a, r) => a + r.presents.length, 0);
  const over = frameMs.filter((v) => v > FRAME_BUDGET_MS).length;
  const trace = { format: PERF_TRACE_FORMAT, version: PERF_TRACE_VERSION, source: 'bench', mode: 0, frames: presentCount, seconds: r2(seconds),
    stages: { 'host.rtt': summary(allRtt), 'host.present': summary(presents), ...(raf.length ? { 'host.raf.interval': summary(raf) } : {}), 'host.raf.busy': summary(frameMs), ...(completes.length ? { 'host.complete': summary(completes) } : {}) }, counters: {} };
  validateTrace(trace);
  return {
    kind: 'multiview-real', side: side.name, stagesMode: 'off', name: task.name, size: task.size, scale: 1, count: task.count, panes, info: runs[0].info, surface: runs[0].surface ? runs[0].surface.join('x') : null,
    frames: presentCount, seconds: r2(seconds), effectiveFps: r2(presentCount / Math.max(0.001, seconds)), paneFps: r2(panes.reduce((a, p) => a + p.fps, 0)),
    overBudget: over, overBudgetPct: r2(100 * over / Math.max(1, frameMs.length)),
    total: summary(allRtt), main: summary(frameMs), mainSplit: { runtimeTick: summary(runs.flatMap((r) => r.split.tick)), images: summary(runs.flatMap((r) => r.split.images)), composite: summary(runs.flatMap((r) => r.split.compose)) }, present: summary(presents), frameAge: summary(ages), raf: summary(raf),
    histogram: { edges: [...FRAME_HISTOGRAM_EDGES], counts: histogram(frameMs, FRAME_HISTOGRAM_EDGES) }, trace,
    note: 'Real MultiViewSession with its Canvas2D NERV workers (the show engine is not used by Multiview). total = pane request to bitmap; main = tick + composite on the main thread per display tick; paneFps = sum over panes.',
  };
}

// ------------------------------------------------------------------ AVS (optional, local catalogue)
const avsName = (f) => (AVS_DIR && f.startsWith(AVS_DIR) ? relative(AVS_DIR, f) : f.split(/[\\/]/).pop());
function walkAvs(dir, out = []) {
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walkAvs(p, out); else if (n.toLowerCase().endsWith('.avs')) out.push(p); }
  return out;
}

/** Synthetic heavy AVS presets (SuperScope script, heavy Trans/Blur) written with the repository's own AVS writer. */
async function synthAvs() {
  const r = await build({ stdin: { contents: "export { serializeAvsPreset } from './src/avs/preset.ts';", resolveDir: VIS, loader: 'ts' }, bundle: true, format: 'esm', write: false, logLevel: 'silent' });
  const { serializeAvsPreset } = await import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);
  const enc = (v) => { const b = new Uint8Array(v.length + 1); for (let i = 0; i < v.length; i++) b[i] = v.charCodeAt(i) & 255; return b; };
  const scope = (point, frame, beat, init, colors, lines) => {
    const strings = [point, frame, beat, init].map(enc);
    const bytes = new Uint8Array(1 + strings.reduce((a, v) => a + 4 + v.length, 0) + 12 + colors.length * 4), view = new DataView(bytes.buffer);
    let o = 0; bytes[o++] = 1;
    for (const v of strings) { view.setUint32(o, v.length, true); o += 4; bytes.set(v, o); o += v.length; }
    view.setInt32(o, 0, true); o += 4; view.setInt32(o, colors.length, true); o += 4;
    for (const c of colors) { view.setInt32(o, c, true); o += 4; }
    view.setInt32(o, lines ? 1 : 0, true);
    return bytes;
  };
  const blur = (mode) => { const b = new Uint8Array(8); new DataView(b.buffer).setInt32(0, mode, true); return b; };
  const comp = (effectId, payload, k) => ({ effectId, apeId: null, payload, fileOffset: 0, path: String(k + 1), children: [], list: null, listCode: null });
  const ast = (components) => ({ version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: false, components: components.map(([id, p], k) => comp(id, p, k)), byteLength: 0 });
  const dots = scope('v=getosc(i,.05,0);a=i*6.2831853*(3+sin(t*.5));r=.25+.35*abs(v)+.1*sin(i*40+t);x=cos(a)*r*.75+sin(t+i*9)*.02;y=sin(a)*r;red=abs(sin(a+t));green=abs(cos(i*7+t));blue=v+.5', 't=t+.04', 'b=1', 'n=8192;t=0', [0xffffff], false);
  const lines = (k) => scope(`v=getosc(i*.5,.1,${k % 2});x=i*2-1;y=v*.${k + 4}+sin(i*${k + 3}+t)*.15*${k + 1}`, 't=t+.05', 'n=4096', 'n=4096;t=0', [0xff0000 >> (8 * (k % 3)), 0xffffff], true);
  const dir = join(BUILD_ROOT, 'avs-synth');
  mkdirSync(dir, { recursive: true });
  const out = [];
  const write = (name, components) => { const f = join(dir, `${name}.avs`); writeFileSync(f, serializeAvsPreset(ast(components))); out.push(f); };
  write('synth-dots-8k', [[36, dots]]);
  write('synth-lines-4x4k', [0, 1, 2, 3].map((k) => [36, lines(k)]));
  write('synth-dots-blur-heavy', [[36, dots], [6, blur(3)], [36, lines(2)], [6, blur(3)], [6, blur(3)]]);
  return out;
}

// ------------------------------------------------------------------ instrumentation identity (--identity)
if (flag('identity')) {
  const rows = [];
  try {
    for (const plate of PLATES) {
      const size = SIZES[0];
      const r = await pages.get('cand').evaluate((o) => window.bench.identity(o), { root: '/cand', plate, width: size.width, height: size.height, scale: size.scale });
      rows.push(r);
      log(`identity ${plate.padEnd(10)} ${r.size}  plain rerender: max ${r.noise.max} (${r.noise.offPct.toFixed(3)}% px)  stage timing on: max ${r.cpu.max} (${r.cpu.offPct.toFixed(3)}% px, ${r.stages[0]} stages)  synchronised: max ${r.sync.max} (${r.sync.offPct.toFixed(3)}% px, ${r.stages[1]} stages)  stages when off: ${r.plainStages}`);
    }
  } finally { await browser.close(); server.close(); }
  const worst = Math.max(...rows.map((r) => Math.max(r.cpu.max, r.sync.max))), floor = Math.max(...rows.map((r) => r.noise.max));
  log(`identity: ${rows.length} plates, worst difference with instrumentation on = ${worst} levels, plain-rerender noise floor = ${floor} levels, frames with instrumentation off carried ${rows.reduce((a, r) => a + r.plainStages, 0)} stages`);
  if (OUT) writeFileSync(OUT, JSON.stringify({ format: 'aaavs-bench-identity', version: 1, created: new Date().toISOString(), rows }, null, 1) + '\n');
  process.exit(worst > floor || rows.some((r) => r.plainStages !== 0 || r.stages[0] === 0 || r.stages[1] === 0) ? 1 : 0);
}

// ------------------------------------------------------------------ run
const tasks = [];
for (const size of SIZES) for (const plate of PLATES) tasks.push(() => ({ kind: 'plate', plate, size }));
for (const count of MV_COUNTS) for (const mode of MV_MODES) tasks.push(() => ({ kind: 'mv', count, mode }));
let done = 0;
const started = Date.now();
try {
  for (const make of tasks) {
    const t = make();
    const rounds = [];
    for (let round = 0; round < REPEAT; round++) rounds.push(t.kind === 'plate' ? await plateTask(t.plate, t.size, round, done) : await multiviewTask(t.count, t.mode, round, done));
    const produced = assemble(rounds);
    results.push(...produced);
    done++;
    for (const r of produced) log(oneLine(r));
  }
  if (AVS_DIR || AVS_SYNTH) {
    const files = [...(AVS_DIR ? walkAvs(AVS_DIR) : []), ...(AVS_SYNTH ? await synthAvs() : [])];
    if (!files.length) log(`--avs-dir ${AVS_DIR}: no .avs files found`);
    else {
      avsFiles.push(...files);
      const m = /^(\d+)x(\d+)$/.exec(opt('avs-size', '1280x720'));
      const w = +m[1], h = +m[2];
      const probed = [];
      log(`AVS: probing ${files.length} presets at ${w}x${h} (1.5 s each) to find the heaviest...`);
      for (let k = 0; k < files.length; k++) {
        try {
          const run = await pages.get('cand').evaluate((o) => window.bench.runSlots(o), { seconds: 1.5, warmup: 0.5, minFrames: 5, perfMode: 0, pacing: PACING, complete: COMPLETE,
            slots: [{ root: '/cand', file: 'avs-render.worker.js', plate: files[k], presetUrl: `/avsfile/${k}`, kind: 'avs', width: w, height: h, scale: 1, rect: { x: 0, y: 0, w: 1920, h: 1080 } }] });
          const f = run.workers[0].frames; probed.push({ k, ms: median(f.map((x) => x.rtt)), n: f.length });
        } catch (e) { log(`  skipped ${avsName(files[k])}: ${String(e.message).split('\n')[0]}`); }
      }
      probed.sort((a, b) => b.ms - a.ms);
      for (const pr of probed.slice(0, Math.round(num('avs-max', 6)))) {
        const rounds = [];
        for (let round = 0; round < REPEAT; round++) {
          const out = new Map();
          for (const side of order(round, done)) {
            const run = await runSide(side, (page, root) => page.evaluate((o) => window.bench.runSlots(o), { seconds: SECONDS, warmup: WARMUP, minFrames: MIN_FRAMES, perfMode: 0, pacing: PACING, complete: COMPLETE,
              slots: [{ root, file: 'avs-render.worker.js', plate: avsName(files[pr.k]), presetUrl: `/avsfile/${pr.k}`, kind: 'avs', width: w, height: h, scale: 1, rect: { x: 0, y: 0, w: 1920, h: 1080 } }] }));
            out.set(side.name, { task: { kind: 'avs', name: avsName(files[pr.k]), size: `${w}x${h}`, scale: 1 }, run });
          }
          rounds.push(out);
        }
        const produced = assemble(rounds); results.push(...produced); done++;
        for (const r of produced) log(oneLine(r));
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}
if (pageLogs.length) console.error(`BROWSER LOGS (${pageLogs.length}):\n${pageLogs.slice(0, 20).join('\n')}`);

const reportObj = {
  format: 'aaavs-bench', version: 1, created: new Date().toISOString(),
  machine: { cpu: os.cpus()[0]?.model ?? null, cores: os.cpus().length, platform: `${os.platform()} ${os.release()}`, node: process.version },
  browser: { version: browserVersion, executable: EXE ?? 'playwright default', args: ARGS, headed: flag('headed'), gl: gpu, realGpuFlags: flag('gpu') },
  options: { pacing: PACING, complete: COMPLETE, seconds: SECONDS, warmup: WARMUP, minFrames: MIN_FRAMES, sizes: SIZES.map((s) => s.label), plates: PLATES, multiview: MV_COUNTS, multiviewModes: MV_MODES, mvPlates: MV_PLATES, stages: PERF_MODE === 0 ? 'off' : PERF_MODE === 2 ? 'sync' : 'cpu', repeat: REPEAT, compare: COMPARE, avsDir: AVS_DIR ? '(local)' : null },
  notes: [
    flag('gpu') ? 'Real GPU flags: numbers describe this machine.' : 'Software GL (SwiftShader) on a shared CPU: numbers are RELATIVE only (ratios between stages and plates, before/after comparisons).',
    COMPLETE ? 'total = request to the frame\'s pixels existing (reply plus a 1-pixel readback: includes the GPU-process work software GL does on the CPU); worker = frame.total from the worker (renderMs when stages are off), which excludes that GPU work.' : 'total = request to reply measured on the page (what the host sees); worker = frame.total from the worker (renderMs when stages are off).',
    'Frames are paced like the host: one request per display tick, a tick with a request outstanding is a missed frame. overBudget = frames whose total exceeds 16.7 ms.',
    PERF_MODE === 2 ? 'Stage times are GL-synchronised (a GPU wait, a 1x1 readPixels, around GL stages): they attribute GPU time to stages but serialise CPU and GPU, so the frame total is larger than a pipelined frame.' : 'Stage times are CPU timestamps: GL work queued in one stage is waited for in a later one (frame.fit, engine.blit, gl.upload.canvas). Use --sync to attribute it.',
  ],
  results: results.map(({ raw, ...r }) => r),
};
if (OUT) { writeFileSync(OUT, formatJson(reportObj)); log(`\nreport -> ${OUT}`); }
report(results);
log(`\nbench finished in ${((Date.now() - started) / 1000).toFixed(0)} s`);

// ------------------------------------------------------------------ output
/** JSON with one line per stage summary, so a report stays readable and small. */
function formatJson(o) {
  return JSON.stringify(o, null, 1).replace(/\{\s+("n":[^{}]*?)\s*\}/g, (_, body) => `{${body.replace(/\s*\n\s*/g, ' ')}}`).replace(/\[\s+([-\d.,\s]+?)\s+\]/g, (_, body) => `[${body.replace(/\s*\n\s*/g, ' ')}]`) + '\n';
}
function oneLine(r) {
  const f = (x) => (x ?? 0).toFixed(1).padStart(6);
  if (r.kind === 'multiview-real') return `${r.side.padEnd(9)} ${r.kind.padEnd(15)} ${r.name.padEnd(44)} ${r.effectiveFps.toFixed(1).padStart(5)} fps composited, panes ${r.paneFps.toFixed(1)} fps, main p50 ${f(r.main.p50)} p95 ${f(r.main.p95)} max ${f(r.main.max)}, pane rtt p50 ${f(r.total.p50)} p95 ${f(r.total.p95)}, over budget ${r.overBudgetPct}%`;
  return `${r.side.padEnd(9)} ${r.kind.padEnd(15)} ${String(r.name).slice(0, 24).padEnd(24)} ${String(r.size).padEnd(11)} ${String(r.effectiveFps.toFixed(1)).padStart(5)} fps  total p50 ${f(r.total.p50)} p95 ${f(r.total.p95)} max ${f(r.total.max)}  worker p50 ${f(r.worker.p50)}  missed ${r.missedPct}%  over ${r.overBudgetPct}%  (${r.frames} frames)`;
}
function report(rs) {
  const plates = rs.filter((r) => r.kind === 'plate');
  const groups = new Map();
  for (const r of plates) { const k = `${r.size}|${r.side}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  for (const [k, g] of groups) {
    const [size, side] = k.split('|');
    log(`\n${side} @ ${size}: per-plate frame cost (ms), effective fps, dropped against 60 fps, and the hottest stages (mean ms)`);
    log('plate       fps  total p50   p95   max  worker p50  missed%  over%   hottest stages');
    for (const r of g) {
      const st = r.trace.stages;
      const top = HOT.filter((n) => st[n]).sort((a, b) => st[b].mean - st[a].mean).slice(0, 4).map((n) => `${n} ${st[n].mean.toFixed(1)}`).join(' · ');
      log(`${r.name.padEnd(10)} ${r.effectiveFps.toFixed(1).padStart(5)}  ${r.total.p50.toFixed(1).padStart(8)} ${r.total.p95.toFixed(1).padStart(6)} ${r.total.max.toFixed(1).padStart(6)}  ${r.worker.p50.toFixed(1).padStart(9)}  ${String(r.missedPct).padStart(6)}  ${String(r.overBudgetPct).padStart(5)}   ${top}`);
    }
  }
  const sides2 = [...new Set(rs.map((r) => r.side))];
  if (sides2.length === 2) {
    log('\nA/B (candidate vs baseline, interleaved): total p50 / p95 and effective fps; negative = candidate faster');
    log('task                                    size         p50 base -> cand (delta)    p95 base -> cand (delta)    fps base -> cand');
    const key = (r) => `${r.kind}|${r.name}|${r.size}`;
    const cand = new Map(rs.filter((r) => r.side === 'candidate').map((r) => [key(r), r]));
    for (const b of rs.filter((r) => r.side === 'baseline')) {
      const c = cand.get(key(b)); if (!c) continue;
      const d = (x, y) => `${((y - x) / Math.max(1e-9, x) * 100).toFixed(1).padStart(6)}%`;
      const pick = (r) => r.kind === 'multiview-real' ? r.main : r.total;
      log(`${String(b.name).slice(0, 38).padEnd(39)} ${String(b.size).padEnd(11)}  ${pick(b).p50.toFixed(1).padStart(7)} -> ${pick(c).p50.toFixed(1).padStart(7)} (${d(pick(b).p50, pick(c).p50)})   ${pick(b).p95.toFixed(1).padStart(7)} -> ${pick(c).p95.toFixed(1).padStart(7)} (${d(pick(b).p95, pick(c).p95)})   ${b.effectiveFps.toFixed(1).padStart(5)} -> ${c.effectiveFps.toFixed(1).padStart(5)}`);
    }
  }
  for (const r of rs.filter((x) => x.kind.startsWith('multiview') && x.side !== 'baseline')) {
    log(`\n${r.kind} ${r.name}: ${r.effectiveFps.toFixed(1)} fps ${r.kind === 'multiview-real' ? 'composited' : 'frames/s (all panes)'}`);
    for (const p of r.panes ?? []) log(`   pane ${String(p.plate).padEnd(10)} ${String(p.fps?.toFixed?.(1) ?? '').padStart(5)} fps  rtt p50 ${(p.rttP50 ?? p.rtt?.p50 ?? 0).toFixed(1)} p95 ${(p.rttP95 ?? p.rtt?.p95 ?? 0).toFixed(1)}`);
  }
  for (const r of rs.filter((x) => x.kind === 'avs' && x.side !== 'baseline')) log(oneLine(r));
}
