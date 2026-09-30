import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
// NERV plates under the repeatable scene clock (docs/design/CONTRACT.md 2.6.2, TIMING-SYSTEM-V2.md 5.5). RES applies TIM's edit list to nerv-scenes.ts; this check pins what
// the plates must then show: the offset-aware bar, `beatsPerBar` pips, and the battery counting down to its scene's own end. It reads the plates through the
// operations a recording context sees (text and seven-segment rectangles), so it needs no canvas, browser or GPU.
// AAAVS_NERV_ENTRY may point at a scratch copy of nerv-scenes.ts for a rehearsal of the edit list (CPU only).
const entry = process.env.AAAVS_NERV_ENTRY || 'src/nerv-scenes.ts';
async function load(path) { const r = await build({ entryPoints: [path], bundle: true, format: 'esm', write: false }); return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`); }
const { NERV_SCENES, renderNervScene } = await load(entry);
const { timingSignals } = await load('src/mpc-beat-grid.ts');

function recordingContext() {
  const operations = [], stack = [];
  let state = { globalAlpha: .45, globalCompositeOperation: 'multiply', font: '11px serif', fillStyle: '#abc', strokeStyle: '#def', lineWidth: 3, shadowBlur: 7 };
  const initial = { ...state };
  const context = new Proxy({}, {
    set(_target, key, value) {
      if (typeof value === 'number') assert.ok(Number.isFinite(value), `nonfinite ${String(key)}`);
      state[key] = value; operations.push(['set', key, value]); return true;
    },
    get(_target, key) {
      if (key === 'save') return () => { stack.push({ ...state }); operations.push(['save']); };
      if (key === 'restore') return () => { assert.ok(stack.length, 'unbalanced restore'); state = stack.pop(); operations.push(['restore']); };
      if (key in state) return state[key];
      return (...args) => {
        for (const value of args.flat()) if (typeof value === 'number') assert.ok(Number.isFinite(value), `nonfinite ${String(key)} argument`);
        operations.push([key, ...args]);
      };
    },
  });
  // The design-canvas entry (RES, CONTRACT 3.6) may set image smoothing and text rendering once per frame: those settings are allowed to outlive the call,
  // exactly as in check-nerv-scenes.mjs. Every other property must be restored.
  const allowed = new Set(['imageSmoothingEnabled', 'imageSmoothingQuality', 'textRendering']);
  const settled = value => Object.fromEntries(Object.entries(value).filter(([key]) => !allowed.has(key)));
  return { context, operations, verify: () => { assert.equal(stack.length, 0, 'drawing state stack leak'); assert.deepEqual(settled(state), settled(initial), 'caller context must be restored'); } };
}
function audio() { return { waveform: [new Uint8Array(576), new Uint8Array(576)], spectrum: [new Uint8Array(576), new Uint8Array(576)], beat: false, beatLevel: 0 }; }
const fixture = audio();
for (let i = 0; i < 576; i++) {
  fixture.waveform[0][i] = Math.round(Math.sin(i * .059) * 110) & 255;
  fixture.waveform[1][i] = Math.round(Math.cos(i * .043) * 89) & 255;
  fixture.spectrum[0][i] = (i * 19 + 61) % 256;
  fixture.spectrum[1][i] = (i * 11 + 29) % 256;
}
const base = { time: 0, localTime: 0, progress: .3, bpm: 120, seed: 5, audio: fixture };
function draw(scene, changes = {}) {
  const r = recordingContext();
  renderNervScene(r.context, 640, 360, { ...base, scene, ...changes });
  r.verify();
  return r.operations;
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The chrome's tempo and bar label: "120.0 BPM  /  BAR 0017". */
function barLabel(ops) {
  for (const op of ops) if (op[0] === 'fillText') { const m = /^(\d+\.\d) BPM\s+\/\s+BAR\s+(\d+)$/.exec(String(op[1])); if (m) return { bpm: Number(m[1]), bar: Number(m[2]) }; }
  throw new Error('no BPM / BAR label');
}
const SEGMENTS = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };
/** Decode the battery's MM:SS seven-segment clock: the rectangles drawn between the ACTIVITY LIMIT label and the next text. Lit segments carry the plate's amber. */
function batteryClock(ops) {
  const start = ops.findIndex(op => op[0] === 'fillText' && op[1] === 'ACTIVITY LIMIT');
  assert.ok(start >= 0, 'battery plate has its ACTIVITY LIMIT label');
  let end = ops.findIndex((op, i) => i > start && op[0] === 'fillText');
  if (end < 0) end = ops.length;
  const rects = []; let fill = null;
  for (let i = start; i < end; i++) { const op = ops[i]; if (op[0] === 'set' && op[1] === 'fillStyle') fill = op[2]; else if (op[0] === 'fillRect') rects.push(fill); }
  assert.equal(rects.length, 30, 'four digits of seven segments and a colon of two rectangles');
  const lit = rects.filter(c => c !== '#221e18'), amber = lit.length ? lit[0] : null;
  const digitAt = offset => { const on = 'abcdefg'.split('').filter((_, i) => rects[offset + i] === amber).join(''); const found = Object.entries(SEGMENTS).find(([, s]) => s === on); assert.ok(found, `readable digit at ${offset}: ${on}`); return found[0]; };
  return `${digitAt(0)}${digitAt(7)}:${digitAt(16)}${digitAt(23)}`;
}
const mmss = seconds => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
const legacyBar = (time, bpm) => Math.floor(time * bpm / 240) + 1;
const legacyClock = (localTime, bpm) => mmss(Math.max(0, Math.ceil((1 - ((localTime * bpm / 60 / 16) % 1)) * 16 * 60 / bpm)));
const fract = v => v - Math.floor(v);

// ---- 1. No grid: today's derivation, exactly (the label and the 16-beat battery) ----
for (const bpm of [90, 109, 120, 133.3, 400])for (const time of [0, 3.7, 34.4, 147.125, 1000.5]) {
  const localTime = time * .75, label = barLabel(draw('boot', { time, localTime, bpm }));
  assert.equal(label.bar, legacyBar(time, bpm), `legacy bar ${time} s at ${bpm} BPM`);
  assert.equal(batteryClock(draw('battery', { time, localTime, bpm })), legacyClock(localTime, bpm), `legacy battery ${localTime} s at ${bpm} BPM`);
}

// ---- 2. A grid makes the bar offset-aware, meter-aware and tempo-map-aware ----
{
  const grid = { offset: 1.5, beatsPerBar: 4, bpm: 120 };
  const expectBar = (frame, bar, message) => assert.equal(barLabel(draw('boot', frame)).bar, bar, message);
  expectBar({ time: .5, localTime: 0, grid }, 1, 'before the offset the counter reads bar 1');
  expectBar({ time: 1.5, localTime: 0, grid }, 1, 'the offset is the first bar line');
  expectBar({ time: 3.4999, localTime: 1.9999, grid }, 1);
  expectBar({ time: 3.5, localTime: 2, grid }, 2, 'the second bar starts one bar (2 s) after the offset');
  expectBar({ time: 33.4, localTime: 31.9, grid }, 16, 'offset 1.5 s: 33.4 s is still bar 16');
  assert.equal(legacyBar(33.4, 120), 17, 'the offset-blind counter would already say 17');
  expectBar({ time: 33.5, localTime: 32, grid }, 17);
  // Meter: bars of three or seven beats.
  expectBar({ time: 7.49, localTime: 7.49, grid: { offset: 0, beatsPerBar: 3, bpm: 120 } }, 5);
  expectBar({ time: 7.5, localTime: 7.5, grid: { offset: 0, beatsPerBar: 3, bpm: 120 } }, 6, '3/4 at 120 BPM: a 1.5 s bar');
  expectBar({ time: 28, localTime: 28, bpm: 90, grid: { offset: 0, beatsPerBar: 7, bpm: 90 } }, 7, '7/4 at 90 BPM: 4.667 s bars; 28 s is 42 beats');
  // A tempo change: 40 beats at 120 BPM up to 20 s, then 1 beat per second.
  const mapped = { offset: 0, beatsPerBar: 4, bpm: 120, changes: [[20, 60]] };
  expectBar({ time: 19.9999, localTime: 19.9999, grid: mapped }, 10);
  expectBar({ time: 20.5, localTime: 20.5, bpm: 60, grid: mapped }, 11);
  expectBar({ time: 60, localTime: 60, bpm: 60, grid: mapped }, 21, '80 beats in: bar 21');
  // The bar is the signal the shared function derives, for a spread of grids and times.
  let seed = 41; const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 300; i++) {
    const g = { offset: Math.round((rnd() - .3) * 2000) / 100, beatsPerBar: 1 + Math.floor(rnd() * 16), bpm: 20 + Math.round(rnd() * 38000) / 100, ...(rnd() < .4 ? { changes: [[30 + Math.round(rnd() * 5000) / 100, 20 + Math.round(rnd() * 38000) / 100]] } : {}) };
    const time = Math.round(rnd() * 20000) / 100, localTime = Math.round(rnd() * 5000) / 100;
    assert.equal(barLabel(draw('boot', { time, localTime, grid: g })).bar, timingSignals(time, g, null, null, { bpm: 120, localTime }).bar + 1, JSON.stringify([g, time]));
  }
}

// ---- 3. The battery counts down to its scene's own end; without an end it keeps its 16-beat cycle (on the scene beats) ----
{
  const grid = { offset: 10, beatsPerBar: 4, bpm: 120 };
  const clock = (time, start, end, extra = {}) => batteryClock(draw('battery', { time, localTime: Math.max(0, time - start), sceneStart: start, sceneEnd: end, ...extra }));
  for (const [time, start, end, seconds] of [[25, 10, 70, 45], [10, 10, 70, 60], [69.001, 10, 70, 1], [70, 10, 70, 0], [100, 10, 70, 0], [9, 10, 70, 61], [10.25, 10, 70, 60], [69.5, 10, 70, 1], [0, 0, 1536, 1536], [0, 0, 59.999, 60], [12.001, 0, 12.002, 1]]) {
    assert.equal(clock(time, start, end, { grid }), mmss(seconds), `with a grid: ${time} s in ${start}..${end}`);
    assert.equal(clock(time, start, end), mmss(seconds), `without a grid: the interval alone drives the countdown (${time} s in ${start}..${end})`);
  }
  // The count reaches zero exactly at the end and stays there: an outgoing plate is held at its end value, never rolling over.
  assert.equal(clock(70, 10, 70, { grid }), '00:00');for (const late of [70.0001, 71, 500]) assert.equal(clock(late, 10, 70, { grid }), '00:00');
  // Counting down whole seconds, monotonically, once per second at any frame rate.
  {
    let last = Infinity, changes = 0;
    for (let t = 10; t <= 70.0001; t += 1 / 60) { const c = clock(t, 10, 70, { grid }), s = Number(c.slice(0, 2)) * 60 + Number(c.slice(3)); assert.ok(s <= last, `never counts up (${c} after ${last})`); if (s !== last) changes++; last = s; }
    assert.equal(last, 0);assert.equal(changes, 61, 'sixty-one distinct values, 60 down to 0');
  }
  // No end, a missing bound, an empty or reversed span, or non-finite bounds: the legacy cycle.
  for (const bounds of [{}, { sceneStart: 10 }, { sceneEnd: 70 }, { sceneStart: 70, sceneEnd: 70 }, { sceneStart: 80, sceneEnd: 70 }, { sceneStart: NaN, sceneEnd: 70 }, { sceneStart: 10, sceneEnd: Infinity }, { sceneStart: 10, sceneEnd: NaN }, { sceneStart: null, sceneEnd: null }, { sceneStart: '10', sceneEnd: '70' }]) {
    const frame = { time: 25, localTime: 15, bpm: 109, grid, ...bounds };
    // The cycle runs on the scene beats the grid gives (from the scene start when there is one, else from the offset).
    const t = timingSignals(frame.time, grid, frame.sceneStart ?? null, frame.sceneEnd ?? null, { bpm: 109, localTime: 15 });
    assert.equal(t.interval, null, `${JSON.stringify(bounds)} is not an interval`);
    assert.equal(batteryClock(draw('battery', frame)), mmss(Math.max(0, Math.ceil((1 - fract(t.sceneBeat / 16)) * 16 * 60 / 109))), JSON.stringify(bounds));
    assert.equal(batteryClock(draw('battery', { ...frame, grid: undefined })), legacyClock(15, 109), `${JSON.stringify(bounds)} without a grid`);
  }
  // The meter beside the clock follows the interval too: it drains with progress. (Whatever the plate draws, the interval changes the picture.)
  assert.notEqual(digest(draw('battery', { time: 40, localTime: 30, sceneStart: 10, sceneEnd: 70, grid })), digest(draw('battery', { time: 40, localTime: 30, grid })));
}

// ---- 4. Pips: one per beat of the bar, drawn with a saved grid (which pip is lit is drawing detail, checked by eye in the acceptance list) ----
{
  const count = beatsPerBar => draw('boot', { time: 8, localTime: 8, grid: { offset: 8, beatsPerBar, bpm: 120 } }).length;
  const counts = [1, 4, 7, 16].map(count);
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i] > counts[i - 1], `more beats per bar, more pips (${counts})`);
}

// ---- 5. Grid and bounds never break a plate; a malformed grid reads as no grid; replay is exact ----
{
  const grid = { offset: 2, beatsPerBar: 5, bpm: 133.5, changes: [[40, 90], [100, 140]] };
  const frame = scene => ({ time: 61.25, localTime: 21.25, grid, sceneStart: 40, sceneEnd: 100, scene });
  const first = new Map(NERV_SCENES.map(scene => [scene, digest(draw(scene, frame(scene)))]));
  assert.equal(first.size, 16);
  for (const scene of [...NERV_SCENES].reverse()) {
    draw(scene, { time: 4000, localTime: 290, grid: { offset: -3, beatsPerBar: 3, bpm: 200 }, sceneStart: 3990, sceneEnd: 4010 }); draw(scene, { time: 0, localTime: 0 });
    assert.equal(digest(draw(scene, frame(scene))), first.get(scene), `${scene}: a grid frame renders the same after other frames`);
  }
  const bad = [{ offset: NaN, beatsPerBar: 4, bpm: 120 }, { offset: 0, beatsPerBar: 0, bpm: 120 }, { offset: 0, beatsPerBar: 17, bpm: 120 }, { offset: 0, beatsPerBar: 2.5, bpm: 120 }, { offset: 0, beatsPerBar: 4, bpm: 5 },
    { offset: 0, beatsPerBar: 4, bpm: 120, changes: 'x' }, { offset: 0, beatsPerBar: 4, bpm: 120, changes: [[0, 100]] }, { offset: 0, beatsPerBar: 4, bpm: 120, changes: [[5, 100], [4, 100]] },
    { offset: 0, beatsPerBar: 4, bpm: 120, changes: Array.from({ length: 257 }, (_, i) => [1 + i, 100]) }, null, 'grid', 7, {}];
  for (const grid of bad) {
    const ops = draw('boot', { time: 147.125, localTime: 7.125, bpm: 109, grid });
    assert.equal(barLabel(ops).bar, legacyBar(147.125, 109), `malformed grid ${JSON.stringify(grid)} reads as no grid`);
    assert.equal(batteryClock(draw('battery', { time: 147.125, localTime: 7.125, bpm: 109, grid })), legacyClock(7.125, 109));
    // The whole plate, pips included, is drawn exactly as with no grid at all.
    for (const scene of NERV_SCENES) {
      const frame = { time: 147.125, localTime: 7.125, bpm: 109 };
      assert.equal(digest(draw(scene, { ...frame, grid })), digest(draw(scene, frame)), `${scene}: malformed grid ${JSON.stringify(grid)} draws exactly like no grid`);
    }
  }
}
console.log('NERV timing signals CPU: legacy bar and 16-beat battery without a grid, offset-, meter- and tempo-map-aware bar, battery countdown to the scene end (exact at the end, held after it, monotone at 60 Hz), beats-per-bar pips, malformed grids, replay determinism across all 16 plates PASS');
