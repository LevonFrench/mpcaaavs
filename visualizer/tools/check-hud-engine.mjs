/** CPU-only recording check. Exported recorder is reusable by generator/showcase gates; importing it does not run checks. */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as F from './fixtures-hud.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function loadHudEngine() {
  const result = await build({ entryPoints: [path.join(root, 'src/hud/hud-engine.ts')], bundle: true, format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
/** Records context geometry after transforms. Effective painted bounds account for clipping, including strokes.
 * Rejects NaN, negative dimensions, invalid alpha, unbalanced saves and painting beyond the surface. No raster/GPU is used. */
export function recordingContext(width, height) {
  const calls = [], bounds = [], stack = [], initial = { sx: 1, sy: 1, tx: 0, ty: 0, clip: [0, 0, width, height] };
  let state = structuredClone(initial), shape = null;
  const styleKeys = ['fillStyle', 'strokeStyle', 'lineWidth', 'globalAlpha', 'font', 'textAlign', 'textBaseline', 'lineJoin', 'lineCap'];
  const target = { fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '10px mono', textAlign: 'left', textBaseline: 'alphabetic', lineJoin: 'round', lineCap: 'butt' };
  const finite = args => { for (const a of args) if (typeof a === 'number') assert.ok(Number.isFinite(a), `nonfinite geometry: ${args}`); };
  const record = (name, ...args) => { finite(args); calls.push([name, ...args]); };
  const transformed = (x, y, w, h) => [x * state.sx + state.tx, y * state.sy + state.ty, w * state.sx, h * state.sy];
  const union = b => { shape = shape ? [Math.min(shape[0], b[0]), Math.min(shape[1], b[1]), Math.max(shape[2], b[0] + b[2]), Math.max(shape[3], b[1] + b[3])] : [b[0], b[1], b[0] + b[2], b[1] + b[3]]; };
  const paint = (b, stroke = false) => {
    if (!b || !(target.globalAlpha > 0)) return;
    const pad = stroke ? target.lineWidth * Math.max(state.sx, state.sy) / 2 : 0, [cx, cy, cw, ch] = state.clip;
    const x0 = Math.max(cx, b[0] - pad), y0 = Math.max(cy, b[1] - pad), x1 = Math.min(cx + cw, b[2] + pad), y1 = Math.min(cy + ch, b[3] + pad);
    if (x1 <= x0 || y1 <= y0) return;
    assert.ok(x0 >= -1e-6 && y0 >= -1e-6 && x1 <= width + 1e-6 && y1 <= height + 1e-6, `out of canvas ${[x0, y0, x1, y1]}`);
    bounds.push([x0, y0, x1, y1, target.globalAlpha]);
  };
  Object.assign(target, {
    save() { record('save'); stack.push({ state: structuredClone(state), styles: Object.fromEntries(styleKeys.map(k => [k, target[k]])) }); },
    restore() { record('restore'); const old = stack.pop(); assert.ok(old, 'restore underflow'); state = old.state; Object.assign(target, old.styles); },
    translate(x, y) { record('translate', x, y); state.tx += state.sx * x; state.ty += state.sy * y; },
    scale(x, y) { record('scale', x, y); state.sx *= x; state.sy *= y; },
    beginPath() { record('beginPath'); shape = null; }, closePath() { record('closePath'); },
    moveTo(x, y) { record('moveTo', x, y); union(transformed(x, y, 0, 0)); },
    lineTo(x, y) { record('lineTo', x, y); union(transformed(x, y, 0, 0)); },
    rect(x, y, w, h) { record('rect', x, y, w, h); assert.ok(w >= 0 && h >= 0, 'negative rect'); union(transformed(x, y, w, h)); },
    arc(x, y, r, a, b, ccw) { record('arc', x, y, r, a, b, ccw); assert.ok(r >= 0, 'negative arc'); union(transformed(x - r, y - r, r * 2, r * 2)); },
    clip() { record('clip'); if (!shape) return; const c = state.clip, xx = Math.max(c[0], shape[0]), yy = Math.max(c[1], shape[1]); state.clip = [xx, yy, Math.max(0, Math.min(c[0] + c[2], shape[2]) - xx), Math.max(0, Math.min(c[1] + c[3], shape[3]) - yy)]; },
    fill() { record('fill'); paint(shape); }, stroke() { record('stroke'); paint(shape, true); },
    fillRect(x, y, w, h) { record('fillRect', x, y, w, h); assert.ok(w >= 0 && h >= 0, 'negative fillRect'); const b = transformed(x, y, w, h); paint([b[0], b[1], b[0] + b[2], b[1] + b[3]]); },
    fillText(text, x, y) { record('fillText', text, x, y); const size = parseFloat(target.font) || 10, bw = text.length * size, offset = target.textAlign === 'center' ? bw / 2 : target.textAlign === 'right' ? bw : 0; const b = transformed(x - offset, y - size, bw, size); paint([b[0], b[1], b[0] + b[2], b[1] + b[3]]); },
    createLinearGradient(...args) { record('linearGradient', ...args); return { addColorStop(at, color) { record('colorStop', at, color); } }; },
    createRadialGradient(...args) { record('radialGradient', ...args); return { addColorStop(at, color) { record('colorStop', at, color); } }; },
  });
  const ctx = new Proxy(target, { set(obj, key, value) { if (typeof value === 'number') assert.ok(Number.isFinite(value), `bad style ${String(key)}`); if (key === 'globalAlpha') assert.ok(value >= 0 && value <= 1, 'alpha'); record('set', String(key), typeof value === 'object' ? 'gradient' : value); obj[key] = value; return true; } });
  return { ctx, calls, bounds, finish() { assert.equal(stack.length, 0, 'unbalanced context'); assert.deepEqual(state, initial, 'transform restored'); return { calls, bounds }; } };
}

export const hudFixtureFrame = (time = 4, extra = {}) => ({ time, grid: { offset: 0, beatsPerBar: 4, bpm: 120 }, sceneStart: 0, sceneEnd: 16, tempo: null, track: { position: time, duration: 180 }, ...extra });
function storm(time) {
  const onset = Object.fromEntries(['kick', 'snare', 'hat', 'tonal', 'any'].map(k => [k, { env: 1, fired: true, count: Math.floor(time * 60), ageSec: 0, strength: 1 }]));
  const band = { sub: 1, low: 0.8, mid: 0.6, high: 0.4, air: 0.2 };
  return { version: 2, live: true, t: time, dt: 1 / 60, rms: 1, band, bandL: band, bandR: band, pan: 0.8, panBand: band, width: 1, flux: 1, centroid: 1, contour: { fast: 1, slow: 0.6, slope: 1, tension: 1 }, onset, beat: { latched: true, level: 73728 }, legacy: { low: 0.8, mid: 0.6, high: 0.4, level: 0.7 } };
}
export async function checkHudEngine() {
  const E = await loadHudEngine(), sizes = [[320, 180], [960, 540], [1920, 1080]];
  let checks = 0, maxDraws = 0, maxPaths = 0, maxPropertySets = 0, maxArea = 0, maxSaves = 0, maxGradients = 0;
  const render = (scene, frame, size, runtime = new E.HudRuntime(scene), policy) => {
    const rec = recordingContext(...size), traces = [];
    const stats = E.renderHudScene(scene, runtime, rec.ctx, ...size, frame, policy, (...v) => traces.push(v));
    rec.finish(); checks++;
    assert.ok(stats.draws <= 900 && stats.paths <= 5000 && stats.saves <= 96 && stats.texts <= 96 && stats.gradients <= 24 && stats.area <= 8, `budget ${JSON.stringify(stats)}`);
    maxDraws = Math.max(maxDraws, stats.draws); maxPaths = Math.max(maxPaths, stats.paths);
    maxPropertySets = Math.max(maxPropertySets, rec.calls.filter(c => c[0] === 'set').length); maxArea = Math.max(maxArea, stats.area);
    maxSaves = Math.max(maxSaves, stats.saves); maxGradients = Math.max(maxGradients, stats.gradients);
    return { calls: rec.calls, stats, traces };
  };
  assert.deepEqual(Object.keys(E.HUD_RENDERERS), F.KIND_NAMES); checks++;
  const reached = new Set();
  for (const kind of F.KIND_NAMES) for (const variant of ['min', 'full']) for (const style of ['pixel', 'vector']) {
    const manifest = F.kindManifest(kind, variant); manifest.canvas = { w: 320, h: 180, style };
    if (kind === 'combo') manifest.layers[0].v = 'audio.onset.any.fired';
    const scene = E.HudScene.compile(manifest), runtime = new E.HudRuntime(scene);
    for (const size of sizes) for (const time of [0, 0.01, 4, 15.5, 16, 20]) {
      const frame = hudFixtureFrame(time, { signals: storm(time), revision: 1 });
      const a = render(scene, frame, size, runtime), b = render(scene, frame, size, runtime);
      if (a.stats.instruments > 0) reached.add(kind);
      assert.deepEqual(b, a, `${kind}/${variant}/${style} duplicate frame`); checks++;
      render(scene, hudFixtureFrame(time + 4, { signals: storm(time + 4), revision: 1 }), size, runtime);
      assert.deepEqual(render(scene, frame, size, runtime), a, `${kind} seek reconstruction`); checks++;
    }
  }
  assert.deepEqual([...reached].sort(), [...F.KIND_NAMES].sort(), 'every kind actually draws, including thin manifests'); checks++;
  // Every allowed style/mode and boundary geometry uses the same bounded path.
  const M = await (async () => { const b = await build({ entryPoints: [path.join(root, 'src/hud/hud-manifest.ts')], bundle: true, write: false, format: 'esm' }); return import(`data:text/javascript;base64,${Buffer.from(b.outputFiles[0].text).toString('base64')}`); })();
  for (const kind of F.KIND_NAMES) for (const [key, spec] of Object.entries({ ...M.KIND_SPECS[kind].req, ...M.KIND_SPECS[kind].opt })) {
    const values = spec.t === 'enum' ? spec.values : spec.t === 'int' ? [spec.min, spec.max] : [];
    for (const value of values) {
      const manifest = F.kindManifest(kind, 'min'); Object.assign(manifest.layers[0], { [key]: value, r: [0, 0, 1, 1] });
      if (kind === 'warning') manifest.layers[0].when = 's+0';
      const scene = E.HudScene.compile(manifest);
      for (const style of ['vector', 'pixel']) { const mutated = structuredClone(manifest); mutated.canvas = { w: 320, h: 180, style }; render(E.HudScene.compile(mutated), hudFixtureFrame(0.05, { signals: storm(0.05) }), [320, 180]); }
      render(scene, hudFixtureFrame(0.05, { signals: storm(0.05) }), [1920, 1080]);
    }
  }
  // Clock counters and delayed authoritative trails reach exact endpoints, independent of live audio.
  const manifest = F.baseManifest({ layers: [
    { k: 'timer', id: 'time', r: [0.1, 0.1, 0.3, 0.1], unit: 'sec', dir: 'down' },
    { k: 'counter', id: 'score', r: [0.1, 0.3, 0.3, 0.1], digits: 6, fmt: 'score', mode: 'interval', min: 0, max: 1000 },
    { k: 'bar', id: 'life', r: [0.1, 0.5, 0.7, 0.1], dir: 'rtl', v: 'interval.remaining01', trail: true, beh: ['ghost'] },
  ] });
  const scene = E.HudScene.compile(manifest);
  for (const fps of [24, 30, 60, 144]) for (const time of [0, 8, 16 - 1 / fps, 16, 17]) {
    const a = E.evaluateHudScene(scene, hudFixtureFrame(time)), b = E.evaluateHudScene(scene, hudFixtureFrame(time, { signals: storm(time) }));
    assert.deepEqual(a.states.map(s => [s.number, s.value, s.trail]), b.states.map(s => [s.number, s.value, s.trail]));
    assert.equal(a.states[0].number, Math.max(0, Math.ceil(16 - time - 1e-9)));
    assert.equal(a.states[1].number, Math.min(1, time / 16) * 1000);
    assert.ok(a.states[2].trail >= a.states[2].value); checks += 4;
  }
  const unknown = E.evaluateHudScene(scene, hudFixtureFrame(100, { sceneEnd: null })); assert.equal(unknown.timing.scene.known, false); checks++;
  // Named intervals win over declarations and audio cannot drive authoritative instruments.
  const named = F.baseManifest({ intervals: { status: { from: 's+0', to: 'e-0' } }, layers: [{ k: 'counter', id: 'named', r: [0, 0, 1, 0.1], mode: 'interval', digits: 4, fmt: 'int', max: 100, v: 'iv.status.progress' }] });
  assert.equal(E.evaluateHudScene(E.HudScene.compile(named), hudFixtureFrame(8, { named: [{ id: 'status', start: 4, end: 12 }] })).states[0].number, 50); checks++;
  // Storms cannot produce >1 qualifying full-frame flash per second; reduced motion suppresses them completely.
  const flashManifest = F.baseManifest({ layers: [{ k: 'fx', id: 'flash', r: [0, 0, 1, 1], fx: 'flash', amount: 0.25 }] }), flashScene = E.HudScene.compile(flashManifest);
  let flashes = 0, previous = false;
  for (let i = 0; i < 600; i++) { const time = i / 60, frame = hudFixtureFrame(time, { signals: storm(time) }), e = E.evaluateHudScene(flashScene, frame); if (e.flashes && !previous) flashes++; previous = !!e.flashes;
    assert.equal(E.evaluateHudScene(flashScene, frame, { motion: 'reduced', flash: 'strict' }).flashes, 0); checks++; }
  assert.ok(flashes <= 10); checks++;
  for (const size of sizes) { render(flashScene, hudFixtureFrame(0.01, { signals: storm(0.01) }), size); render(E.HudScene.compile(F.allKindsManifest()), hudFixtureFrame(15.5, { signals: storm(15.5) }), size); }
  const runtime = new E.HudRuntime(scene); runtime.decoration.fill(1); runtime.reset(); assert.ok(runtime.decoration.every(x => x === 0)); checks++;
  // HudFeed's dt and revision may change on seek/paused snapshots. Neither changes this engine's picture at equal media time.
  for (const kind of F.KIND_NAMES) {
    const replayScene = E.HudScene.compile(F.kindManifest(kind, 'full')), baselineFrame = hudFixtureFrame(0.01, { signals: storm(0.01), revision: 1 });
    const baseline = render(replayScene, baselineFrame, [960, 540]);
    assert.deepEqual(render(replayScene, { ...baselineFrame, revision: 15, signals: { ...baselineFrame.signals, dt: 0.25 } }, [960, 540]), baseline); checks++;
  }
  // Inertia reconstructs source-time samples analytically and ignores render dt/revision. Authoritative deadlines retain exact endpoints.
  const smoothLayer = { k: 'dial', id: 'smooth', r: [0.2, 0.2, 0.4, 0.4], style: 'arc', v: { src: 'interval.progress', atk: 500, rel: 900 } };
  const smoothScene = E.HudScene.compile(F.baseManifest({ layers: [smoothLayer] }));
  const smooth = E.evaluateHudScene(smoothScene, hudFixtureFrame(8)).states[0].value;
  assert.ok(smooth > 0.4 && smooth < 0.5, 'clock inertia visibly lags a rising decorative source'); checks++;
  const smoothPicture = render(smoothScene, hudFixtureFrame(8, { revision: 1 }), [960, 540]);
  assert.deepEqual(render(smoothScene, hudFixtureFrame(8, { revision: 99 }), [960, 540]), smoothPicture); checks++;
  const inertiaEvents = F.baseManifest({ events: { hits: { on: 'beat', n: 4, seed: 7 } }, layers: [{ ...smoothLayer, v: { src: 'ev.hits.cum', atk: 500, rel: 500 } }] });
  const eventScene = E.HudScene.compile(inertiaEvents), eventPlain = E.HudScene.compile({ ...inertiaEvents, layers: [{ ...smoothLayer, v: 'ev.hits.cum' }] });
  let changed = false;
  for (let time = 0; time < 16; time += 0.1) if (Math.abs(E.evaluateHudScene(eventScene, hudFixtureFrame(time)).states[0].value - E.evaluateHudScene(eventPlain, hudFixtureFrame(time)).states[0].value) > 0.01) { changed = true; break; }
  assert.ok(changed, 'event inertia affects reconstructable scheduled steps'); checks++;
  const onsetScene = E.HudScene.compile(F.baseManifest({ layers: [{ ...smoothLayer, v: { src: 'audio.onset.any.env', atk: 120, rel: 400 } }] }));
  const onsetSignals = storm(4); onsetSignals.onset.any.ageSec = 0.15;
  const onsetValue = E.evaluateHudScene(onsetScene, hudFixtureFrame(4, { signals: onsetSignals })).states[0].value;
  assert.ok(Math.abs(onsetValue - (1 - Math.exp(-0.15 / 0.12)) * Math.exp(-0.15 / 0.4)) < 1e-9); checks++;
  const authorityInertia = structuredClone(manifest); for (const layer of authorityInertia.layers) layer.v = { src: layer.k === 'timer' ? 'interval.remaining' : layer.k === 'counter' ? 'interval.progress' : 'interval.remaining01', atk: 5000, rel: 5000 };
  const authoritativeScene = E.HudScene.compile(authorityInertia);
  const endpoint = E.evaluateHudScene(authoritativeScene, hudFixtureFrame(16)).states;
  assert.equal(endpoint[0].number, 0); assert.equal(endpoint[1].number, 1000); checks += 2;
  // Large native pixel grids do not silently lose circles/polygons at the bounded dense-mask limit.
  for (const kind of ['dial', 'radar', 'portrait', 'scope']) {
    const big = F.kindManifest(kind, 'min'); big.canvas = { w: 1920, h: 1080, style: 'pixel' }; big.layers[0].r = [0, 0, 1, 1];
    if (kind === 'dial') { big.layers[0].style = 'orb'; big.layers[0].v = 'const.1'; }
    const out = render(E.HudScene.compile(big), hudFixtureFrame(4), [1920, 1080]);
    assert.ok(out.stats.draws > 1, `${kind}: native pixel foreground missing`); checks++;
  }
  for (const time of [NaN, Infinity, -Infinity, -10, 1e20]) render(scene, hudFixtureFrame(time), [320, 180]);
  // A maximum-layer input degrades secondary labels and retains the final timer, within the 96-save frame cap.
  const many = F.baseManifest({ layers: [...Array.from({ length: 95 }, (_, i) => ({ k: 'label', id: `label_${i}`, r: [(i % 10) / 10, Math.floor(i / 10) / 10, 0.09, 0.04], text: 'X' })), { k: 'timer', id: 'final_timer', r: [0, 0.96, 0.3, 0.04], unit: 'sec' }] });
  const manyOut = render(E.HudScene.compile(many), hudFixtureFrame(4), [320, 180]);
  assert.ok(manyOut.traces.some(t => t[0] === 'final_timer')); assert.equal(manyOut.stats.degraded, 1); checks += 2;
  // The independently authored glyph/icon rectangles are bounded and present for the whole public ASCII surface.
  const fontBuild = await build({ entryPoints: [path.join(root, 'src/hud/hud-font.ts')], bundle: true, format: 'esm', write: false });
  const font = await import(`data:text/javascript;base64,${Buffer.from(fontBuild.outputFiles[0].text).toString('base64')}`);
  for (let code = 32; code <= 126; code++) { const rects = font.glyphRects(String.fromCharCode(code)); for (let i = 0; i < rects.length; i += 4) { assert.ok(rects[i] >= 0 && rects[i + 1] >= 0 && rects[i] + rects[i + 2] <= 5 && rects[i + 1] + rects[i + 3] <= 7); checks++; } }
  console.log(`hud-engine: ${checks} CPU assertions; all 21 kinds, three sizes, seek/determinism and bounds; maximum ${maxDraws} draws / ${maxPaths} segments`);
  console.log(`hud-engine budgets: ${maxPropertySets} property sets / ${maxSaves} saves / ${maxGradients} gradients / ${maxArea.toFixed(3)} estimated overdraw`);
  return { checks, maxDraws, maxPaths, maxPropertySets, maxArea, maxSaves, maxGradients };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await checkHudEngine(); } catch (error) { console.error(error.name, error.message, error.issues ?? ''); process.exitCode = 1; }
}
