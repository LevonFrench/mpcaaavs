// Still renderer for the show engine (AAAVS). Builds src/show-render.worker.ts, serves visualizer/, and drives
// headless Chromium with software WebGL (SwiftShader) through Playwright to render PNG stills of the NERV show
// from the reference fixture (tools/fixtures/nerv-reference). Optionally renders bizarro/evangelion itself
// (its Vite app with the same fixture data and the same synthesized waveform) at the same times and writes
// side-by-side contact sheets (upstream left, ours right).
//
//   node tools/render-show-stills.mjs --t 3.5,12.2 [--only boot,magi] [--scale 2] [--out <dir>]
//   node tools/render-show-stills.mjs --plates [--per 3] [--only ...]          times inside every plate window
//   node tools/render-show-stills.mjs --plates --compare <evangelion checkout>  + upstream + contact sheets
//   --sheet-dir <dir>  where contact sheets go (default <out>/sheets); --jpg-quality 0.82; --cell 640
//   --timing           report render cost per plate (GPU-synchronised, software rendering: relative only)
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const VIS = resolve(here, '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(`--${k}`);
const SCALE = Math.max(1, Math.round(+opt('scale', '1')));
const OUT = resolve(opt('out', join(VIS, '..', '.show-stills', 'wip')));
const SHEETS = resolve(opt('sheet-dir', join(OUT, 'sheets')));
const ONLY = opt('only') ? opt('only').split(',') : null;
const COMPARE = opt('compare') ? resolve(opt('compare')) : null;
const PER = +opt('per', '3');
const CELL = +opt('cell', '640');
const QUALITY = +opt('jpg-quality', '0.82');
const PARAMS = { title: 'NEON OVERDRIVE', artist: 'mroneilovealot', titleJp: 'ネオン・オーバードライブ', unit: opt('unit', ''), unitJp: opt('unit-jp', '') };
const BROWSER_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];

// ------------------------------------------------------------------ build + serve ours
const buildDir = join(VIS, '.tmp', 'show-stills');
mkdirSync(buildDir, { recursive: true });
await build({ entryPoints: [join(VIS, 'src/show-render.worker.ts')], bundle: true, format: 'esm', target: 'es2022', outdir: buildDir, entryNames: '[name]', logLevel: 'warning' });
writeFileSync(join(buildDir, 'index.html'), `<!doctype html><meta charset="utf-8"><title>show stills</title><body style="margin:0;background:#000">
<canvas id="c"></canvas>
<script type="module">
let worker, gen = 0, seq = 0, pending = new Map(), ready = null;
const cv = document.getElementById('c');
window.__show = {
  async init(o) {
    worker = new Worker('/.tmp/show-stills/show-render.worker.js?scale=' + o.scale, { type: 'module' });
    worker.onerror = (e) => console.error('worker error', e.message);
    const [songMap, spec] = await Promise.all([fetch('/tools/fixtures/nerv-reference/song-map.json').then(r => r.json()), fetch('/tools/fixtures/nerv-reference/spectrum.bin').then(r => r.arrayBuffer())]);
    const r = new Promise((res, rej) => { ready = { res, rej }; });
    worker.onmessage = ({ data }) => {
      if (data.type === 'show-ready') ready.res(data);
      else if (data.type === 'show-error') { if (pending.size) { for (const p of pending.values()) p.rej(new Error(data.message)); pending.clear(); } else ready.rej(new Error(data.message)); }
      else if (data.type === 'show-frame') { const p = pending.get(data.sequence); pending.delete(data.sequence); p?.res(data); }
    };
    worker.postMessage({ type: 'show-init', generation: gen, assetBase: '/show-assets/', songMap, spec, params: o.params, only: o.only ?? undefined, verbose: !!o.verbose }, [spec]);
    return r;
  },
  async still(t, sync) {
    const s = ++seq;
    const f = await new Promise((res, rej) => { pending.set(s, { res, rej }); worker.postMessage({ type: 'show-render', generation: gen, sequence: s, time: t, sync: !!sync }); });
    cv.width = f.width; cv.height = f.height;
    cv.getContext('2d').drawImage(f.bitmap, 0, 0);
    f.bitmap.close();
    const b = await new Promise((res) => cv.toBlob(res, 'image/png'));
    const u8 = new Uint8Array(await b.arrayBuffer());
    let bin = ''; for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return { png: btoa(bin), renderMs: f.renderMs, plate: f.plate };
  },
};
window.__ready = true;
</script>`);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.bin': 'application/octet-stream', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
function serve(root) {
  return new Promise((res) => {
    const srv = createServer((req, rsp) => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const f = join(root, p === '/' ? '/.tmp/show-stills/index.html' : p);
      if (!f.startsWith(root) || !existsSync(f) || statSync(f).isDirectory()) { rsp.writeHead(404); rsp.end('not found'); return; }
      rsp.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      rsp.end(readFileSync(f));
    });
    srv.listen(0, '127.0.0.1', () => res({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }));
  });
}

async function openBrowser() {
  return chromium.launch({ headless: true, args: BROWSER_ARGS });
}
async function newPage(browser, logs) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (flag('verbose')) console.log(`[browser ${m.type()}] ${m.text()}`); if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  return page;
}

// ------------------------------------------------------------------ plan + times
const fixture = JSON.parse(readFileSync(join(VIS, 'tools/fixtures/nerv-reference/song-map.json'), 'utf8'));
const planMod = await build({ stdin: { contents: `export { planShow } from './src/show/plan.ts'; export { NERV_SHOW } from './src/shows/nerv/show-def.ts';`, resolveDir: VIS, loader: 'ts' }, bundle: true, format: 'esm', write: false });
const { planShow, NERV_SHOW } = await import(`data:text/javascript;base64,${Buffer.from(planMod.outputFiles[0].text).toString('base64')}`);
const plan = planShow(fixture, NERV_SHOW, PARAMS);

let times = [];
if (opt('t')) times = opt('t').split(',').map(Number);
if (flag('plates') || !times.length) {
  for (const p of plan) {
    if (ONLY && !ONLY.includes(p.id)) continue;
    const pts = opt('fracs') ? opt('fracs').split(',').map(Number) : PER === 1 ? [0.55] : Array.from({ length: PER }, (_, i) => 0.18 + (0.72 * i) / (PER - 1));
    for (const u of pts) times.push(+(p.start + (p.end - p.start) * u).toFixed(3));
  }
}
const plateAt = (t) => plan.find((p) => t >= p.start && t < p.end)?.id ?? 'none';

// ------------------------------------------------------------------ render ours
mkdirSync(OUT, { recursive: true });
const ours = new Map();
const logs = [];
const browser = await openBrowser();
const srv = await serve(VIS);
const timing = new Map();
try {
  const page = await newPage(browser, logs);
  await page.goto(srv.url + '/');
  await page.waitForFunction(() => window.__ready);
  const only = ONLY ?? [...new Set(times.map(plateAt))];
  const ready = await page.evaluate(([params, only, scale, verbose]) => window.__show.init({ params, only, scale, verbose }), [PARAMS, only, SCALE, flag('verbose')]);
  console.log(`ours: ${ready.width}x${ready.height}, init ${ready.initMs.toFixed(0)} ms, synthesized wave ${ready.synthesizedWave}`);
  if (ready.errors.length) console.error('SCENE ERRORS:\n' + ready.errors.join('\n'));
  for (const t of times) {
    const r = await page.evaluate(([t]) => window.__show.still(t, true), [t]);
    const f = join(OUT, `ours_${r.plate ?? 'none'}_${t.toFixed(2).padStart(7, '0')}.png`);
    writeFileSync(f, Buffer.from(r.png, 'base64'));
    ours.set(t, f);
    console.log(`ours t=${t.toFixed(2)} ${r.plate} ${r.renderMs.toFixed(1)} ms -> ${f}`);
  }
  if (flag('timing')) {
    // warm frames then 6 timed frames per plate at spread times (GPU-synchronised)
    for (const p of plan) {
      if (ONLY && !ONLY.includes(p.id)) continue;
      const ms = [];
      for (let i = 0; i < 8; i++) {
        const t = p.start + (p.end - p.start) * (0.1 + 0.8 * (i / 7));
        const r = await page.evaluate(([t]) => window.__show.still(t, true), [t]);
        if (i >= 2) ms.push(r.renderMs);
      }
      ms.sort((a, b) => a - b);
      timing.set(p.id, { median: ms[Math.floor(ms.length / 2)], max: ms[ms.length - 1] });
    }
  }
  await page.close();
} finally {
  if (logs.length) console.error('BROWSER LOGS:\n' + logs.slice(0, 40).join('\n'));
}

if (timing.size) {
  console.log(`\nrender cost per plate at ${1920 * SCALE}x${1080 * SCALE} (SwiftShader software GL, GPU-synchronised, relative only):`);
  for (const [id, v] of timing) console.log(`  ${id.padEnd(10)} median ${v.median.toFixed(1).padStart(7)} ms   max ${v.max.toFixed(1).padStart(7)} ms`);
  writeFileSync(join(OUT, 'timing.json'), JSON.stringify(Object.fromEntries(timing), null, 1));
}

// ------------------------------------------------------------------ upstream + contact sheets
if (COMPARE) {
  const app = join(COMPARE, 'app');
  const port = 5400 + Math.floor(Math.random() * 400);
  const vite = spawn(process.execPath, [join(app, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort'], { cwd: app, env: { ...process.env, VIZ_NO_HMR: '1' }, stdio: 'ignore' });
  const url = `http://localhost:${port}`;
  const up = new Map();
  try {
    for (let i = 0; i < 200; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }
    const byPlate = new Map();
    for (const t of times) { const id = plateAt(t); if (!byPlate.has(id)) byPlate.set(id, []); byPlate.get(id).push(t); }
    const page = await newPage(browser, logs);
    const ids = [...byPlate.keys()].filter((x) => x !== 'none');
    await page.goto(`${url}/?export=1&only=${ids.join(',')}${SCALE !== 1 ? `&scale=${SCALE}` : ''}`);
    await page.waitForFunction(() => window.__viz?.ready || window.__viz?.error, null, { timeout: 180000 });
    const err = await page.evaluate(() => window.__viz.error);
    if (err) throw new Error('upstream failed: ' + err);
    for (const t of times) {
      await page.evaluate(([t]) => window.__viz.still(t), [t]);
      const png = await page.evaluate(() => window.__viz.png());
      const f = join(OUT, `upstream_${plateAt(t)}_${t.toFixed(2).padStart(7, '0')}.png`);
      writeFileSync(f, Buffer.from(png, 'base64'));
      up.set(t, f);
      console.log(`upstream t=${t.toFixed(2)} -> ${f}`);
    }
    await page.close();
    // contact sheets: one per plate, rows = times, upstream left / ours right
    mkdirSync(SHEETS, { recursive: true });
    const sheetPage = await newPage(browser, logs);
    await sheetPage.goto(srv.url + '/');
    for (const [id, ts] of byPlate) {
      if (id === 'none') continue;
      const rows = ts.map((t) => ({ t, a: 'data:image/png;base64,' + readFileSync(up.get(t)).toString('base64'), b: 'data:image/png;base64,' + readFileSync(ours.get(t)).toString('base64') }));
      const jpg = await sheetPage.evaluate(async ([rows, id, cell, q]) => {
        const cw = cell, ch = Math.round(cell * 9 / 16), pad = 6, lab = 22, head = 30;
        const cv = document.createElement('canvas');
        cv.width = pad * 3 + cw * 2; cv.height = head + rows.length * (ch + lab + pad) + pad;
        const c = cv.getContext('2d');
        c.fillStyle = '#1b1b1b'; c.fillRect(0, 0, cv.width, cv.height);
        c.fillStyle = '#eee'; c.font = 'bold 15px monospace';
        c.fillText(`${id}: upstream bizarro/evangelion (left)  |  AAAVS show engine port (right)`, pad, 20);
        const load = (src) => new Promise((r) => { const im = new Image(); im.onload = () => r(im); im.src = src; });
        let y = head;
        for (const row of rows) {
          const [A, B] = await Promise.all([load(row.a), load(row.b)]);
          c.fillStyle = '#bbb'; c.font = '13px monospace';
          c.fillText(`t = ${row.t.toFixed(2)} s`, pad, y + 15);
          c.drawImage(A, pad, y + lab, cw, ch); c.drawImage(B, pad * 2 + cw, y + lab, cw, ch);
          y += ch + lab + pad;
        }
        return cv.toDataURL('image/jpeg', q).split(',')[1];
      }, [rows, id, CELL, QUALITY]);
      const f = join(SHEETS, `${String(plan.findIndex((p) => p.id === id) + 1).padStart(2, '0')}-${id}.jpg`);
      writeFileSync(f, Buffer.from(jpg, 'base64'));
      console.log(`sheet ${f}`);
    }
    await sheetPage.close();
  } finally {
    vite.kill();
  }
}
await browser.close();
srv.close();
if (logs.length) console.error('BROWSER LOGS:\n' + logs.slice(0, 60).join('\n'));
