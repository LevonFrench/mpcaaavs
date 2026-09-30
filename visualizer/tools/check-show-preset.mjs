// CPU checks for NERV presets on the show engine (src/show/preset-window.ts, src/hud/hud-host.ts, AAAVS): the analysis
// window and timeline built from the host's NERV playback clock, key stability across the frames of one scene, the
// crossfade entry, held scenes, the saved grid vs the legacy tempo, and the device-local engine choice.
//
//   node tools/check-show-preset.mjs
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const VIS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  stdin: {
    contents: `export { presetWindow } from './src/show/preset-window.ts';
      export { liveSongMap } from './src/show/live.ts';
      export { songToHome } from './src/show/bar-map.ts';
      export { NERV_SHOW, NERV_PLATE_IDS } from './src/shows/nerv/show-def.ts';
      export { nervEngine, sceneWorkerLocation, NERV_ENGINE_KEY } from './src/hud/hud-host.ts';
      export { showScaleFor, ShowScaleSwitch, SWITCH_FRAMES } from './src/show/scale-switch.ts';`,
    resolveDir: VIS, loader: 'ts',
  },
  bundle: true, format: 'esm', write: false, logLevel: 'error', platform: 'neutral',
});
const { presetWindow, liveSongMap, songToHome, NERV_SHOW, NERV_PLATE_IDS, nervEngine, sceneWorkerLocation, NERV_ENGINE_KEY, showScaleFor, ShowScaleSwitch, SWITCH_FRAMES } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };
const eq = (a, b, m) => { n++; assert.deepEqual(a, b, m); };
const near = (a, b, e, m) => { n++; assert.ok(Math.abs(a - b) <= e, `${m}: ${a} vs ${b}`); };

const BPM = 128, BAR = 240 / BPM;
const grid = { offset: 0.37, beatsPerBar: 4, bpm: BPM };
const clock = (o) => ({ time: 100, localTime: 4, progress: 0.25, bpm: BPM, seed: 7, grid, sceneStart: 96, sceneEnd: 96 + 8 * BAR, ...o });

// one scene: window, analysis window, bar map
for (const plate of NERV_PLATE_IDS) {
  const c = clock({});
  const w = presetWindow(c, plate);
  eq(w.current.id, plate, `${plate}: current plate`);
  eq([w.current.start, w.current.end], [96, 96 + 8 * BAR], `${plate}: scene window`);
  eq(w.previous, null, `${plate}: no previous plate outside a fade`);
  near(w.bpm, BPM, 1e-9, `${plate}: grid tempo`);
  ok(w.live.origin <= 96 - BAR && w.live.origin >= 0, `${plate}: analysis starts before the scene`);
  ok(w.live.origin + w.live.maxSeconds >= w.current.end, `${plate}: analysis covers the scene`);
  near(w.live.firstBeat, 0.37, 1e-12, `${plate}: saved grid phase`);
  const d = liveSongMap(w.live).downbeats;
  const bm = w.current.barMap, home = NERV_SHOW.plates[plate].home;
  eq([bm.homeStart, bm.homeEnd], [home[0], home[1]], `${plate}: home window`);
  near(d[bm.songStart], 96, BAR / 2 + 1e-9, `${plate}: bar map starts at the scene's downbeat`);
  eq(bm.songEnd - bm.songStart, 8, `${plate}: 8-bar scene`);
  eq(songToHome(bm, 0), 0, `${plate}: scene opens on its first home bar`);
  eq(songToHome(bm, 8), home[1] - home[0], `${plate}: scene ends where its home window ends`);
  // key stability: every frame inside the scene gives the same key
  const keys = new Set();
  for (let t = 96; t < 96 + 8 * BAR; t += 0.37) keys.add(presetWindow(clock({ time: t, localTime: t - 96, progress: (t - 96) / (8 * BAR) }), plate).key);
  eq(keys.size, 1, `${plate}: one analysis window per scene`);
}

// legacy tempo (no saved grid): beats counted from the scene start; end from progress
{
  const w = presetWindow({ time: 50, localTime: 10, progress: 0.5, bpm: 90, seed: 1 }, 'magi');
  eq([w.current.start, w.current.end], [40, 60], 'legacy: window from localTime and progress');
  near(w.live.firstBeat, 40, 1e-12, 'legacy: beats counted from the scene start');
  near(w.bpm, 90, 1e-12, 'legacy: clock tempo');
  const w0 = presetWindow({ time: 50, localTime: 10, progress: 0, bpm: 90, seed: 1 }, 'magi');
  const home = NERV_SHOW.plates.magi.home;
  near(w0.current.end - w0.current.start, (home[1] - home[0]) * (240 / 90), 1e-9, 'legacy: no progress: the home length');
  near(presetWindow({ time: 5, localTime: 5, progress: 0.1, bpm: 5000, seed: 1 }, 'boot').bpm, 400, 0, 'tempo is clamped');
}

// held scene: playing past the end extends by whole bars, the key changes at most once a bar
{
  const end = 96 + 8 * BAR, keys = [];
  for (let t = end; t < end + 4 * BAR; t += BAR / 8) keys.push(presetWindow(clock({ time: t, localTime: t - 96, progress: 1 }), 'radar').key);
  const changes = keys.filter((k, i) => i && k !== keys[i - 1]).length;
  ok(changes <= 4, `held scene: ${changes} rebuilds over 4 bars`);
  const w = presetWindow(clock({ time: end + 2.5 * BAR, localTime: end + 2.5 * BAR - 96, progress: 1 }), 'radar');
  ok(w.current.end > end + 2.5 * BAR, 'held scene: the window covers the playing time');
}

// crossfade: the previous plate gets its own window and stays on screen through the fade
{
  const c = clock({ time: 96.5, localTime: 0.5, progress: 0.5 / (8 * BAR), previousScene: 'magi', previousSceneStart: 96 - 8 * BAR, previousSceneEnd: 96, previousTime: 96.5, previousLocalTime: 8 * BAR + 0.5, blend: 0.3, fadeSeconds: 2 });
  const w = presetWindow(c, 'psycho');
  eq(w.previous.id, 'magi', 'fade: previous plate');
  near(w.previous.start, 96 - 8 * BAR, 1e-9, 'fade: previous window start');
  ok(w.previous.end >= 96 + 2, 'fade: previous entry lasts through the fade');
  eq(w.previous.barMap.songEnd - w.previous.barMap.songStart, 8, 'fade: previous bar map spans its own scene');
  ok(w.live.origin <= w.previous.start, 'fade: analysis window covers the previous scene');
  ok(w.key !== presetWindow(clock({ time: 96.5, localTime: 0.5, progress: 0.01 }), 'psycho').key, 'fade: the key changes when the fade ends');
  const keys = new Set();
  for (let b = 0.05; b < 1; b += 0.1) keys.add(presetWindow({ ...c, blend: b }, 'psycho').key);
  eq(keys.size, 1, 'fade: one window for the whole fade');
  eq(presetWindow({ ...c, blend: 1 }, 'psycho').previous, null, 'fade: blend 1 has no previous plate');
  const guess = presetWindow({ ...c, previousSceneStart: undefined, previousSceneEnd: undefined }, 'psycho');
  near(guess.previous.end - 0, Math.max(96, 96) + 2 + BAR, 1e-9, 'fade: unknown previous bounds end at the scene start (+ fade)');
}

// the device-local engine choice and the worker URL
{
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  globalThis.location = { search: '' };
  eq(nervEngine(), 'show', 'engine: show engine by default');
  store.set(NERV_ENGINE_KEY, 'legacy');
  eq(nervEngine(), 'legacy', 'engine: localStorage opt-out');
  store.set(NERV_ENGINE_KEY, 'show');
  globalThis.location = { search: '?nerv=legacy' };
  eq(nervEngine(), 'legacy', 'engine: ?nerv=legacy wins');
  globalThis.location = { search: '' };
  globalThis.localStorage = { getItem() { throw new Error('blocked'); } };
  eq(nervEngine(), 'show', 'engine: storage errors keep the default');
  globalThis.document = { baseURI: 'https://aaavs.invalid/visualizer/mpc.html' };
  const u = sceneWorkerLocation('nerv', 'https://aaavs.invalid/visualizer/dist/mpc-host.js');
  eq(u.pathname, '/visualizer/dist/show-render.worker.js', 'worker URL: show worker for NERV');
  eq(u.searchParams.get('assets'), 'https://aaavs.invalid/visualizer/show-assets/', 'worker URL: fonts next to the page');
  eq(sceneWorkerLocation('hud', 'https://aaavs.invalid/visualizer/dist/mpc-host.js').pathname, '/visualizer/dist/hud-render.worker.js', 'worker URL: HUD unchanged');
  eq(sceneWorkerLocation(undefined, 'https://aaavs.invalid/visualizer/dist/mpc-host.js').pathname, '/visualizer/dist/avs-render.worker.js', 'worker URL: AVS unchanged');
  globalThis.localStorage = { getItem: () => 'legacy' };
  eq(sceneWorkerLocation('nerv', 'https://aaavs.invalid/visualizer/dist/mpc-host.js').pathname, '/visualizer/dist/nerv-render.worker.js', 'worker URL: legacy NERV when opted out');
}

// output scale: the governor's render size picks the engine scale; changes are debounced
{
  eq([showScaleFor(1920, 1080), showScaleFor(1280, 720), showScaleFor(2400, 1350), showScaleFor(2560, 1440), showScaleFor(3840, 2160), showScaleFor(1080, 1920), showScaleFor(0, 0)], [1, 1, 1, 2, 2, 2, 1], 'scale per render size');
  const sw = new ShowScaleSwitch(1);
  for (let i = 1; i < SWITCH_FRAMES; i++) eq(sw.observe(3840, 2160), null, `switch waits (${i})`);
  eq(sw.observe(3840, 2160), 2, 'switch after SWITCH_FRAMES requests');
  sw.settle(2);
  eq(sw.observe(3840, 2160), null, 'no switch at the current scale');
  // a governor probing another tier for a few frames never restarts the renderer
  for (let k = 0; k < 5; k++) { for (let i = 0; i < SWITCH_FRAMES - 1; i++) eq(sw.observe(1920, 1080), null, 'probe'); eq(sw.observe(3840, 2160), null, 'back before the switch'); }
  for (let i = 1; i < SWITCH_FRAMES; i++) sw.observe(1920, 1080);
  eq(sw.observe(1920, 1080), 1, 'a settled step down switches back');
  sw.settle(2);
  eq(sw.observe(1920, 1080), null, 'an abandoned switch restarts the count');
  globalThis.localStorage = { getItem: () => null };
  globalThis.document = { baseURI: 'https://aaavs.invalid/visualizer/mpc.html' };
  const base = 'https://aaavs.invalid/visualizer/dist/mpc-host.js';
  eq(sceneWorkerLocation('nerv', base, { width: 3840, height: 2160 }).searchParams.get('scale'), '2', 'worker URL: native 4K starts at scale 2');
  eq(sceneWorkerLocation('nerv', base, { width: 1920, height: 1080 }).searchParams.get('scale'), '1', 'worker URL: 1080p starts at scale 1');
  eq(sceneWorkerLocation('nerv', base).searchParams.get('scale'), null, 'worker URL: no size, the worker default');
  eq(sceneWorkerLocation('hud', base, { width: 3840, height: 2160 }).search, '', 'worker URL: other kinds carry no scale');
}

console.log(`Show preset CPU checks PASS (${n} assertions): scene windows and bar maps for all 16 plates, one analysis window per scene, legacy tempo, held scenes, crossfade entries, engine choice and worker URLs.`);
