// Browser smoke test of NERV presets on the show engine (src/show-render.worker.ts, NERV preset dialect), AAAVS.
// Not part of npm run check (it needs Chromium): headless Chromium with SwiftShader drives the worker the way
// src/mpc-host.ts does ('load' a .nerv preset, then 'render' with a NervPlaybackFrame and an AvsAudioFrame at 60 fps)
// and saves the frames it returns:
//   1. a scene playing on the saved grid (magi), with live AVS frames from a synthetic kick/bass/hat PCM;
//   2. a crossfade into psycho from magi through the host's transition (blend 0.5);
//   3. a square render size (letterboxed);
//   4. the in-worker fallback to the Canvas2D NERV scenes (forced with ?renderer=canvas2d), and a browser started without
//      GPU or software GL, which reports which renderer it could use.
//
//   SHOW_CHROMIUM=<chromium> node tools/smoke-show-preset.mjs [--out <dir>]
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const VIS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const OUT = resolve(opt('out', join(VIS, '.tmp', 'show-preset-smoke')));
const dir = join(VIS, '.tmp', 'show-preset-smoke-build');
mkdirSync(OUT, { recursive: true }); mkdirSync(dir, { recursive: true });
await build({ entryPoints: [join(VIS, 'src/show-render.worker.ts')], bundle: true, format: 'esm', target: 'es2022', outdir: dir, entryNames: '[name]', logLevel: 'warning' });
await build({ stdin: { contents: `export { AvsAudioAnalyser } from './src/avs/audio.ts';`, resolveDir: VIS, loader: 'ts' }, bundle: true, format: 'esm', outfile: join(dir, 'avs-audio.js'), logLevel: 'warning' });
writeFileSync(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><body><script type="module">
import { AvsAudioAnalyser } from './avs-audio.js';
const SR = 44100, BPM = 128, beat = 60 / BPM;
const pcmAt = (t) => { // kick on the beat, 55 Hz bass, hat on the off-beat
  const kb = ((t - 0.37) % beat + beat) % beat, hb = (kb + beat / 2) % beat;
  const kick = kb < 0.12 ? Math.sin(2 * Math.PI * (50 + 60 * Math.exp(-kb * 30)) * kb) * Math.exp(-kb * 22) * 0.9 : 0;
  const hat = hb < 0.03 ? Math.sin(t * 91234.5) * Math.exp(-hb * 120) * 0.3 : 0;
  return kick + hat + Math.sin(2 * Math.PI * 55 * t) * 0.08;
};
const an = new AvsAudioAnalyser(), L = new Float32Array(576);
const audioAt = (t) => { for (let i = 0; i < 576; i++) L[i] = pcmAt(t - (576 - i) / SR); return an.analyse({ left: L, right: L }); };
window.run = async ({ plate, frames, clockFor, width, height, query = '', sizeFor = null }) => {
  const w = new Worker('./show-render.worker.js?assets=' + encodeURIComponent(new URL('/show-assets/', location.href).href) + query, { type: 'module' });
  const replies = [];
  let wake = null;
  w.onmessage = ({ data }) => { replies.push(data); wake?.(); };
  w.onerror = (e) => { replies.push({ type: 'error', message: e.message }); wake?.(); };
  const next = (pred) => new Promise((res) => { const f = () => { const r = replies.find(pred); if (r) { replies.splice(replies.indexOf(r), 1); res(r); } else wake = f; }; f(); });
  const preset = await (await fetch('/nerv-presets/' + plate + '.nerv')).arrayBuffer();
  w.postMessage({ type: 'load', generation: 1, preset, bitmaps: [], width, height, gpuLane: 'exact' }, [preset]);
  const ready = await next((r) => r.type === 'ready' || r.type === 'error');
  if (ready.type !== 'ready') return { error: ready.message };
  let last = null, ms = [], scales = [];
  // sizeFor(k, seen): seen[s] = first frame answered by engine scale s (the governor script can follow the switch)
  const seen = {}, sizeAt = sizeFor ? new Function('k', 'seen', 'return (' + sizeFor + ')(k, seen)') : () => [width, height];
  for (let k = 0; k < frames; k++) {
    if (sizeFor && seen.done !== undefined && k > seen.done) break;
    const clock = new Function('k', 'return (' + clockFor + ')(k)')(k);
    const pcm = new ArrayBuffer(4608), [rw, rh] = sizeAt(k, seen);
    w.postMessage({ type: 'render', generation: 1, sequence: k, pcm, audio: audioAt(clock.time), nerv: clock, width: rw, height: rh }, [pcm]);
    const r = await next((x) => x.type === 'frame' || x.type === 'error');
    if (r.type === 'error') return { error: r.message };
    if (r.sequence !== k) return { error: 'frame for sequence ' + r.sequence + ' answered request ' + k };
    scales.push([k, rw, r.width, r.engineScale ?? 0]);
    const es = r.engineScale ?? 0; if (seen[es] === undefined || (seen.back === undefined && es === 1 && seen[2] !== undefined)) { if (es === 1 && seen[2] !== undefined) seen.back = k; else seen[es] = k; }
    ms.push(r.renderMs);
    last?.bitmap.close(); last = r;
  }
  const cv = new OffscreenCanvas(last.width, last.height), g = cv.getContext('2d');
  g.drawImage(last.bitmap, 0, 0);
  const px = g.getImageData(0, 0, last.width, last.height).data;
  let lit = 0; for (let i = 0; i < px.length; i += 16) if (px[i] + px[i + 1] + px[i + 2] > 60) lit++;
  const blob = await cv.convertToBlob({ type: 'image/png' });
  const u8 = new Uint8Array(await blob.arrayBuffer());
  let bin = ''; for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  w.terminate();
  return { png: btoa(bin), width: last.width, height: last.height, lit: lit / (px.length / 16), medianMs: ms.sort((a, b) => a - b)[ms.length >> 1], renderer: ready.renderer, scales };
};
window.ready = true;
</script>`);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.nerv': 'application/json', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const srv = createServer((req, rsp) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = p.startsWith('/show-assets/') || p.startsWith('/nerv-presets/') ? join(VIS, p) : join(dir, p === '/' ? 'index.html' : p);
  if (!existsSync(f) || statSync(f).isDirectory()) { rsp.writeHead(404); rsp.end(); return; }
  rsp.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' }); rsp.end(readFileSync(f));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}/`;
const exe = process.env.SHOW_CHROMIUM || undefined;
const BPM = 128, BAR = 240 / BPM, S0 = 0.37 + 16 * BAR, S1 = S0 + 8 * BAR;
const grid = { offset: 0.37, beatsPerBar: 4, bpm: BPM };
const scene = `(k) => { const t = ${S0} + k / 60 + ${4 * BAR}; return { time: t, localTime: t - ${S0}, progress: (t - ${S0}) / ${8 * BAR}, bpm: ${BPM}, seed: 7, grid: ${JSON.stringify(grid)}, sceneStart: ${S0}, sceneEnd: ${S1} }; }`;
const fade = `(k) => { const t = ${S1} + 0.2 + k / 60; return { time: t, localTime: t - ${S1}, progress: (t - ${S1}) / ${8 * BAR}, bpm: ${BPM}, seed: 7, grid: ${JSON.stringify(grid)}, sceneStart: ${S1}, sceneEnd: ${S1 + 8 * BAR}, previousScene: 'magi', previousSceneStart: ${S0}, previousSceneEnd: ${S1}, previousTime: t, previousLocalTime: t - ${S0}, blend: 0.5, transitionMode: 1, transitionBeats: 4, fadeSeconds: 2 }; }`;
const results = [];
async function session(args, cases) {
  const browser = await chromium.launch({ headless: true, executablePath: exe, args });
  try {
    const page = await browser.newPage();
    const logs = [];
    page.on('console', (m) => logs.push(m.text()));
    await page.goto(url); await page.waitForFunction(() => window.ready);
    for (const c of cases) {
      const r = await page.evaluate((o) => window.run(o), c.run);
      if (r.error) throw new Error(`${c.name}: ${r.error}\n${logs.join('\n')}`);
      const f = join(OUT, `${c.name}.png`);
      writeFileSync(f, Buffer.from(r.png, 'base64'));
      results.push({ name: c.name, ...r, png: f, logs: logs.splice(0) });
      c.check(r, logs);
      console.log(`${c.name}: ${r.renderer} renderer, ${r.width}x${r.height}, ${(100 * r.lit).toFixed(1)}% lit, median ${r.medianMs.toFixed(1)} ms/frame -> ${f}`);
    }
  } finally { await browser.close(); }
}
await session(['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], [
  { name: 'magi-scene', run: { plate: 'magi', frames: 90, clockFor: scene, width: 1280, height: 720 }, check: (r) => { assert.equal(r.renderer, 'show'); assert.equal(r.width, 1280); assert.ok(r.lit > 0.05, 'the plate draws'); } },
  { name: 'magi-forced-canvas2d', run: { plate: 'magi', frames: 10, clockFor: scene, width: 1280, height: 720, query: '&renderer=canvas2d' }, check: (r) => { assert.equal(r.renderer, 'canvas2d', 'forced fallback'); assert.ok(r.lit > 0.05, 'the Canvas2D fallback draws'); } },
  { name: 'psycho-fade-from-magi', run: { plate: 'psycho', frames: 30, clockFor: fade, width: 1280, height: 720 }, check: (r) => assert.ok(r.lit > 0.05, 'the crossfade draws') },
  // the resolution governor moves to native 4K, then back to 1080p: the worker follows with its engine scale
  // (the copy at the new scale loads fonts and builds its scenes in the background while the old renderer answers; this
  // loop is unpaced, so the governor script follows the switch: 4K until scale 2 answers (+40 frames), then 1080p
  // until scale 1 answers again (+20 frames))
  { name: 'magi-governor-4k', run: { plate: 'magi', frames: 4000, clockFor: scene, width: 1280, height: 720,
    sizeFor: '(k, seen) => { if (k < 20) return [1280, 720]; if (seen[2] === undefined || k < seen[2] + 40) return [3840, 2160]; if (seen.back !== undefined && seen.done === undefined) seen.done = seen.back + 20; return [1920, 1080]; }' }, check: (r) => {
    const at = (k) => r.scales.find((x) => x[0] === k);
    assert.equal(at(10)[3], 1, 'starts at scale 1');
    const up = r.scales.find((x) => x[3] === 2), back = r.scales.find((x) => up && x[0] > up[0] && x[3] === 1), last = r.scales.at(-1);
    assert.ok(up && up[0] >= 20 + 19, `switches to scale 2 after the debounce (frame ${up?.[0]})`);
    assert.ok(r.scales.filter((x) => x[0] >= up[0] && x[0] < up[0] + 40).every((x) => x[2] === 3840 && x[3] === 2), 'native 4K frames from the scale-2 engine');
    assert.ok(back && back[0] >= up[0] + 40 + 19, `back to scale 1 after the debounce (frame ${back?.[0]})`);
    assert.equal(last[3], 1, 'ends at scale 1 at 1080p');
    assert.ok(r.scales.every((x) => x[1] === x[2]), 'every frame at the requested width');
    console.log('  scale trace:', JSON.stringify(r.scales.filter((x, i, a) => i === 0 || x[3] !== a[i - 1][3])));
  } },
  { name: 'radar-square', run: { plate: 'radar', frames: 20, clockFor: scene, width: 900, height: 900 }, check: (r) => { assert.equal(r.width, 900); assert.equal(r.height, 900); assert.ok(r.lit > 0.03); } },
]);
await session(['--disable-gpu', '--disable-software-rasterizer', '--disable-webgl', '--disable-webgl2', '--disable-3d-apis'], [
  { name: 'magi-no-gpu', run: { plate: 'magi', frames: 10, clockFor: scene, width: 1280, height: 720 }, check: (r) => assert.ok(r.lit > 0.05, 'a renderer draws without a GPU') },
]);
srv.close();
console.log('NERV preset show-engine browser smoke PASS');
