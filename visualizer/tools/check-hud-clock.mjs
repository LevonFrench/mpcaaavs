import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// CPU-only check of src/hud/hud-clock.ts (docs/design/HUD-PACK-ENGINE.md 3.5 and 3.6; docs/design/CONTRACT.md 2.3.9): timing derivation against the
// shared scene clock and beat grid, exact endpoints at any frame rate, free cycle and fallbacks, named intervals, time references, robustness against
// garbage input, and the beat-grid event schedules (determinism, monotone cumulative weights, seek and tempo independence). No browser, GPU or audio.
async function load(path) {
  const r = await build({ entryPoints: [path], bundle: true, format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);
}
const C = await load('src/hud/hud-clock.ts');
const G = await load('src/mpc-beat-grid.ts');
const S = await load('src/mpc-scene-clock.ts');
const M = await load('src/hud/hud-manifest.ts');
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); checks++; };
const near = (a, b, m, tol = 1e-9) => { assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b)), `${m}: ${a} vs ${b}`); checks++; };
const rng = seed => { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const noTrack = { position: 0, duration: null };
const input = (o = {}) => ({ time: 0, grid: null, sceneStart: 0, sceneEnd: null, tempo: null, track: noTrack, ...o });
const derive = (o, freeBars = 8, options) => C.deriveHudTiming(input(o), freeBars, options);
const plain = t => JSON.parse(JSON.stringify(t)); // drops the clock's functions: numbers only
const deepFreeze = v => { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x); } return v; };
const grid120 = { offset: 0, beatsPerBar: 4, bpm: 120 };

// ---- constants and API surface
eq([C.HUD_FREE_BARS, C.HUD_FALLBACK_BPM, C.HUD_LIVE_BEATS_PER_BAR, C.HUD_EVENT_TAU, C.HUD_EVENT_FAR, C.HUD_SWEEP_SECONDS, C.HUD_BEAT_EPS], [8, 120, 4, 0.25, 60, 8, 1e-9], 'constants');
for (const name of ['deriveHudTiming', 'resolveHudTimeRef', 'hudCountdown', 'hudTimingValue', 'planHudEvent', 'evalHudEvent', 'evalHudEvents', 'hudEventWindow', 'hudEventField', 'hudHash', 'validHudGrid', 'hudGridClock', 'hudLinearClock']) {
  ok(typeof C[name] === 'function', `export ${name}`);
}

// ---- grid validation
ok(C.validHudGrid(grid120) && C.validHudGrid({ ...grid120, changes: [[10, 90], [20, 130]] }), 'valid grids');
for (const bad of [null, undefined, 5, 'x', [], {}, { ...grid120, bpm: 19.9 }, { ...grid120, bpm: 400.1 }, { ...grid120, bpm: NaN }, { ...grid120, offset: Infinity }, { ...grid120, offset: 2e7 },
  { ...grid120, beatsPerBar: 0 }, { ...grid120, beatsPerBar: 17 }, { ...grid120, beatsPerBar: 4.5 }, { ...grid120, changes: 5 }, { ...grid120, changes: [[0, 100]] }, { ...grid120, changes: [[10, 100], [10, 110]] },
  { ...grid120, changes: [[10, 100], [5, 110]] }, { ...grid120, changes: [[10, 500]] }, { ...grid120, changes: [[10]] }, { ...grid120, changes: [['a', 100]] },
  { ...grid120, changes: Array.from({ length: 257 }, (_, i) => [i + 1, 100]) }]) ok(!C.validHudGrid(bad), `invalid grid ${JSON.stringify(bad)}`);
ok(C.validHudGrid({ ...grid120, changes: Array.from({ length: 256 }, (_, i) => [i + 1, 100]) }), '256 changes are allowed');

// ---- the clock adapter agrees with an independent integration of random tempo maps
{
  const r = rng(7);
  for (let i = 0; i < 120; i++) {
    const offset = r() * 30 - 10, changes = [];
    let at = offset;
    for (let k = 0, n = Math.floor(r() * 8); k < n; k++) { at += 1 + r() * 40; changes.push([at, 20 + r() * 380]); }
    const g = { offset, beatsPerBar: 1 + Math.floor(r() * 12), bpm: 20 + r() * 380, ...(changes.length ? { changes } : {}) };
    const clock = C.hudGridClock(g);
    ok(clock && clock.source === 'scene-clock' && clock.beatsPerBar === g.beatsPerBar && clock.constant === !changes.length, 'grid clock shape');
    const naive = t => { let beats = 0, from = offset, rate = g.bpm; for (const [c, next] of changes) { if (t <= c) break; beats += (c - from) * rate / 60; from = c; rate = next; } return t <= offset ? 0 : beats + (t - from) * rate / 60; };
    let previous = -1;
    const times = Array.from({ length: 40 }, () => offset - 5 + r() * 300).sort((a, b) => a - b);
    for (const t of times) {
      const b = clock.beatAt(t);
      near(b, naive(t), 'beatAt vs independent integration', 1e-9);
      ok(b >= previous, 'beatAt never decreases');
      if (b > 0) near(clock.timeAt(b), t, 'timeAt inverts beatAt', 1e-9);
      previous = b;
    }
    ok(clock.beatAt(offset - 1) === 0 && clock.timeAt(0) === offset && clock.timeAt(-3) === offset, 'clamped before the offset');
  }
  ok(C.hudGridClock({ ...grid120, bpm: 5 }) === null && C.hudGridClock(null) === null, 'a malformed wire grid gives no clock');
  const same = C.hudGridClock({ ...grid120 });
  ok(same === C.hudGridClock({ ...grid120 }), 'equal grids reuse the compiled clock');
  const lin = C.hudLinearClock('fallback', 3, 120);
  ok(lin.beatAt(3) === 0 && lin.beatAt(5) === 4 && lin.beatsPerBar === 4 && lin.source === 'fallback' && lin === C.hudLinearClock('fallback', 3, 120), 'linear clock anchors beat 0 at the scene start');
}

// ---- deriveHudTiming agrees with the saved scene clock (v1 sceneAt and the v2 SceneClock), including tempo maps and bar patterns
{
  const r = rng(11);
  const v1 = { enabled: true, seed: 1 };
  for (let i = 0; i < 400; i++) {
    const timing = { ...v1, bpm: 20 + Math.floor(r() * 380), offsetSeconds: Math.round((r() * 12 - 4) * 1000) / 1000, barsPerScene: 1 + Math.floor(r() * 16) };
    const pos = r() * 400 - 3, phase = S.sceneAt(pos, [0, 1, 2, 3], timing, false);
    const t = derive({ time: pos, grid: { offset: timing.offsetSeconds, beatsPerBar: 4, bpm: timing.bpm }, sceneStart: phase.start, sceneEnd: phase.start + phase.duration });
    near(t.scene.progress, phase.progress, 'progress vs sceneAt');
    near(t.localTime, phase.localTime, 'local time vs sceneAt');
    near(t.scene.duration, phase.duration, 'duration vs sceneAt');
    near(t.scene.totalBars, timing.barsPerScene, 'bars per scene');
    ok(t.scene.known && t.beat.source === 'scene-clock' && t.overrun === 0, 'known scene on the saved clock');
  }
  for (let i = 0; i < 300; i++) {
    const offset = Math.round((r() * 12 - 4) * 1000) / 1000, changes = [];
    let at = offset;
    for (let k = 0, n = Math.floor(r() * 5); k < n; k++) { at += 5 + r() * 60; changes.push({ at: Math.round(at * 1000) / 1000, bpm: 30 + Math.floor(r() * 300) }); at = changes.at(-1).at; }
    const pattern = Array.from({ length: 1 + Math.floor(r() * 4) }, () => 1 + Math.floor(r() * 12));
    const timing = { ...v1, bpm: 40 + Math.floor(r() * 250), offsetSeconds: offset, barsPerScene: pattern[0], version: 2, beatsPerBar: 1 + Math.floor(r() * 7), barsPattern: pattern, patternHold: r() < 0.3, ...(changes.length ? { tempoMap: changes } : {}) };
    const clock = S.compileSceneClock(timing), pos = r() * 500 - 2, f = clock.at(pos, [0, 1, 2, 3], false);
    const t = derive({ time: pos, grid: clock.clockGrid, sceneStart: f.start, sceneEnd: f.end });
    near(t.scene.progress, f.progress, 'progress vs SceneClock');
    near(t.scene.remaining, Math.min(f.duration, f.remaining), 'remaining vs SceneClock (a scene that has not begun shows its full duration)');
    eq(t.scene.remainingBars, f.barsRemaining, 'remaining bars vs SceneClock');
    if (pos >= offset) {
      near(t.beat.pos, f.beat, 'beat vs SceneClock');
      eq(t.beat.barIndex, f.bar, 'bar vs SceneClock');
      eq(t.beat.inBar, f.beatInBar, 'beat in bar vs SceneClock');
      near(t.beat.phase, f.beatPhase, 'beat phase vs SceneClock');
      near(t.beat.barPhase, f.barPhase, 'bar phase vs SceneClock');
      near(t.beat.bpm, f.bpm, 'tempo vs SceneClock');
      eq(t.beat.beatsPerBar, f.beatsPerBar, 'beats per bar vs SceneClock');
      near(t.beat.scenePos, f.beat - f.startBeat, 'scene beat vs SceneClock');
      near(t.scene.elapsedBars, (f.beat - f.startBeat) / f.beatsPerBar, 'elapsed bars vs SceneClock');
      near(t.scene.totalBars, (f.endBeat - f.startBeat) / f.beatsPerBar, 'total bars vs SceneClock');
    }
  }
}

// ---- composition with the shared timingSignals(): every beat field is that function's value
{
  const r = rng(23);
  for (let i = 0; i < 200; i++) {
    const g = { offset: r() * 10, beatsPerBar: 1 + Math.floor(r() * 8), bpm: 30 + r() * 300 };
    const start = g.offset + r() * 50, end = start + 1 + r() * 60, time = start + r() * 80 - 5;
    const s = G.timingSignals(time, g, start, end, { bpm: g.bpm, localTime: Math.max(0, time - start) });
    const t = derive({ time, grid: g, sceneStart: start, sceneEnd: end });
    eq([t.beat.pos, t.beat.scenePos, t.beat.barIndex, t.beat.inBar, t.beat.phase, t.beat.barPhase, t.beat.beatsPerBar], [s.beat, s.sceneBeat, s.bar, s.beatInBar, s.beatPhase, s.barPhase, s.beatsPerBar], 'beat fields are timingSignals()');
    eq([t.scene.progress, t.scene.remaining], [s.interval.progress, Math.min(end - start, s.interval.remaining)], 'scene interval is timingSignals().interval (remaining never exceeds the duration)');
    if (time >= start) eq(t.scene.remaining, s.interval.remaining, 'from the start on, remaining is timingSignals().interval.remaining exactly');
  }
}

// ---- exact endpoints, overrun, and frame-rate independence
{
  const r = rng(31);
  for (let i = 0; i < 120; i++) {
    const g = { offset: r() * 5, beatsPerBar: 4, bpm: 40 + Math.floor(r() * 200) }, bars = 1 + Math.floor(r() * 16);
    const start = g.offset + (240 / g.bpm) * bars * Math.floor(r() * 6), end = start + (240 / g.bpm) * bars;
    const at = time => derive({ time, grid: g, sceneStart: start, sceneEnd: end });
    const a = at(start), b = at(end), c = at(end + 2.5), d = at(start - 1);
    eq([a.scene.progress, a.scene.elapsed, a.localTime], [0, 0, 0], 'start: progress 0');
    near(a.scene.remaining, end - start, 'start: full remaining');
    eq([b.scene.progress, b.scene.remaining, b.scene.remainingBars, b.overrun], [1, 0, 0, 0], 'end: exactly 1 and 0');
    eq(C.hudCountdown(b.scene.remaining), 0, 'the countdown reaches 0 exactly at the end');
    eq([c.scene.progress, c.scene.remaining, c.scene.remainingBars], [1, 0, 0], 'past the end: held');
    near(c.overrun, 2.5, 'overrun grows past the end');
    eq([d.scene.progress, d.localTime, d.overrun], [0, 0, 0], 'before the start: clamped');
    ok(at(end - 1e-6).scene.progress < 1 && C.hudCountdown(at(end - 1e-6).scene.remaining) >= 1, 'just before the end is not finished');
    near(a.scene.totalBars, bars, 'total bars');
    eq(a.scene.remainingBars, bars, 'remaining bars at the start');
  }
  // sampled at 24..240 fps the countdown never rises, progress never falls, and both hit their endpoints
  const g = { offset: 0, beatsPerBar: 4, bpm: 125 }, start = 0, end = 240 * 4 / 125;
  for (const fps of [24, 25, 30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240]) {
    let progress = -1, count = Infinity, last = null;
    for (let k = 0; k / fps <= end + 1 / fps; k++) {
      const t = derive({ time: k / fps, grid: g, sceneStart: start, sceneEnd: end }), shown = C.hudCountdown(t.scene.remaining);
      ok(t.scene.progress >= progress && shown <= count, `${fps} fps monotone at frame ${k}`);
      progress = t.scene.progress; count = shown; last = t;
    }
    eq([last.scene.progress, C.hudCountdown(last.scene.remaining)], [1, 0], `${fps} fps ends exactly`);
    eq(C.hudCountdown(derive({ time: 0, grid: g, sceneStart: start, sceneEnd: end }).scene.remaining), Math.ceil(end - 1e-9), 'countdown starts at the whole seconds');
  }
  eq([C.hudCountdown(0), C.hudCountdown(-5), C.hudCountdown(2.0000000001), C.hudCountdown(2.000001), C.hudCountdown(2.5), C.hudCountdown(1e-10)], [0, 0, 2, 3, 3, 0], 'countdown rounding (1e-9 s of slack below a whole second)');
}

// ---- unknown end: an honest free cycle, never a fake deadline
{
  const free = derive({ time: 4 });
  eq([free.beat.source, free.scene.known, free.sceneEnd, free.overrun], ['fallback', false, null, 0], 'no grid, no tempo: fallback');
  near(free.scene.duration, 8 * 4 * 60 / 120, 'free cycle length (8 bars at 120)');
  near(free.scene.freePhase, 0.25, 'free phase at 4 s');
  near(free.scene.remaining, 12, 'free cycle remaining');
  eq([free.scene.totalBars, free.beat.bpm, free.beat.beatsPerBar], [8, 120, 4], 'free cycle bars and fallback tempo');
  near(derive({ time: 16 }).scene.freePhase, 0, 'the cycle wraps');
  near(derive({ time: 20 }).scene.freePhase, 0.25, 'and repeats');
  eq(derive({ time: 4 }, 4).freeBars, 4, 'freeBars is honoured');
  near(derive({ time: 4 }, 4).scene.freePhase, 0.5, 'a 4-bar free cycle');
  eq(derive({ time: 4 }, 1000).freeBars, 32, 'freeBars is clamped to 32');
  eq(derive({ time: 4 }, NaN).freeBars, 8, 'a non-finite freeBars falls back to 8');
  const live = derive({ time: 10, sceneStart: 2, tempo: { bpm: 90, beatIndex: 37, beatPhase: 0.25, locked: true } });
  eq([live.beat.source, live.beat.inBar, live.beat.barIndex, live.beat.bpm, live.scene.known], ['tempo', 1, 9, 90, false], 'locked live tempo');
  near(live.beat.pos, 37.25, 'live beat position');
  near(live.beat.phase, 0.25, 'live beat phase');
  near(live.beat.barPhase, 1.25 / 4, 'live bar phase');
  near(live.scene.duration, 8 * 4 * 60 / 90, 'free cycle at the live tempo');
  for (const tempo of [{ bpm: 90, beatIndex: 3, beatPhase: 0.5, locked: false }, { bpm: 19, beatIndex: 3, beatPhase: 0.5, locked: true }, { bpm: 401, beatIndex: 3, beatPhase: 0.5, locked: true }, { bpm: NaN, beatIndex: 3, beatPhase: 0.5, locked: true }, null, undefined]) {
    eq(derive({ time: 10, tempo }).beat.source, 'fallback', `tempo ${JSON.stringify(tempo)} is not usable`);
  }
  const noEnd = derive({ time: 7, grid: grid120, sceneStart: 0, sceneEnd: null });
  eq([noEnd.beat.source, noEnd.scene.known, noEnd.sceneBeats], ['scene-clock', false, 32], 'a grid without an end keeps the grid but not the deadline');
  const preloaded = derive({ time: 30, grid: grid120, sceneStart: 30, sceneEnd: 46 });
  eq([preloaded.localTime, preloaded.scene.progress, preloaded.overrun], [0, 0, 0], 'a preloaded scene renders at its start');
  eq(derive({ time: 5, sceneStart: 5, sceneEnd: 5 }).scene.known, false, 'an empty interval is unknown');
  eq(derive({ time: 5, sceneStart: 5, sceneEnd: 4 }).scene.known, false, 'a reversed interval is unknown');
}

// ---- tempo maps: bars and time follow the grid
{
  const g = { offset: 0, beatsPerBar: 4, bpm: 120, changes: [[8, 60]] }; // 16 beats in the first 8 s, then 60 BPM
  const t = derive({ time: 12, grid: g, sceneStart: 0, sceneEnd: 24 });
  near(t.beat.pos, 16 + 4, 'beat position across a tempo change');
  eq(t.beat.bpm, 60, 'tempo after the change');
  near(t.scene.totalBars, (16 + 16) / 4, 'scene length in bars across a change');
  near(t.scene.elapsedBars, 20 / 4, 'elapsed bars across a change');
  eq(t.scene.remainingBars, 3, 'remaining bars across a change');
  near(C.resolveHudTimeRef('s+4b', t), 8, 'four bars is 8 s while the tempo is 120');
  near(C.resolveHudTimeRef('s+6b', t), 8 + 8, 'six bars crosses into the slower section: 16 beats + 8 beats');
  near(C.resolveHudTimeRef('e-1b', t), 24 - 4, 'one bar before the end at 60 BPM');
}

// ---- named intervals
{
  const names = [{ id: 'boss', start: 4, end: 12 }, { id: 'last-bar', start: 14, end: 16 }, { id: 'Bad Id', start: 0, end: 1 }, { id: '__proto__', start: 0, end: 1 }, { id: 'flat', start: 3, end: 3 }, { id: 'nan', start: NaN, end: 4 }];
  const t = derive({ time: 8, grid: grid120, sceneStart: 0, sceneEnd: 16, named: names });
  eq(Object.keys(t.named).sort(), ['boss', 'last-bar'], 'only well-formed, non-empty intervals');
  near(t.named.boss.progress, 0.5, 'named progress');
  near(t.named.boss.remaining, 4, 'named remaining');
  eq(t.named.boss.known, true, 'a resolved interval is known');
  eq([t.named['last-bar'].progress, t.named['last-bar'].remaining], [0, 2], 'before a named interval');
  const declared = { boss: { from: 's+1b', to: 'e-1b' }, late: { from: 'e-2b', to: 'e-0' }, empty: { from: 's+4b', to: 's+4b' } };
  const d = derive({ time: 8, grid: grid120, sceneStart: 0, sceneEnd: 16 }, 8, { declared });
  eq([d.named.boss.known, d.named.late.known, d.named.empty.known], [true, true, false], 'declared defaults resolve; an empty span is unresolved');
  near(d.named.boss.duration, 12, 'declared span: 2 s to 14 s');
  near(d.named.boss.progress, 0.5, 'declared progress');
  const given = derive({ time: 8, grid: grid120, sceneStart: 0, sceneEnd: 16, named: [{ id: 'boss', start: 6, end: 10 }] }, 8, { declared });
  near(given.named.boss.duration, 4, 'the host-resolved interval wins over the declared default');
  const unknownEnd = derive({ time: 8, grid: grid120, sceneStart: 0, sceneEnd: null }, 8, { declared });
  eq([unknownEnd.named.boss.known, unknownEnd.named.late.known], [false, false], 'end-relative defaults are unresolved while the scene end is unknown');
  ok(unknownEnd.named.boss.duration > 0 && Number.isFinite(unknownEnd.named.boss.freePhase), 'an unresolved span falls back to the free cycle');
  eq(C.hudTimingValue(t, 'iv', 'remaining', 'boss'), 4, 'iv value (timing, group, field, id)');
  eq(C.hudTimingValue(t, 'iv', 'remaining', 'nothing'), undefined, 'an unknown interval id has no value (the binding uses fb)');
  eq(C.hudTimingValue(t, 'iv', 'remaining', '__proto__'), undefined, 'no prototype lookups');
  eq(C.hudTimingValue(t, 'iv', 'remaining', 'constructor'), undefined, 'no inherited lookups');
  eq(C.hudTimingValue(t, 'iv', 'known', 'boss'), 1, 'iv known');
  // TIM's named intervals are beats since the offset: resolved through the grid they land where a saved timing says
  const compiled = G.compileGrid(90, 1.5);
  const viaBeats = derive({ time: 30, grid: { offset: 1.5, beatsPerBar: 4, bpm: 90 }, sceneStart: 1.5, sceneEnd: 1.5 + 32, named: [{ id: 'iv1', start: compiled.timeAt(8), end: compiled.timeAt(40) }] });
  near(viaBeats.named.iv1.totalBars, 8, 'a named interval of 32 beats is 8 bars');
}

// ---- named intervals outside their window: the setup's interval keeps its place, the declared default only fills a missing id
{
  const declared = { boss: { from: 's+1b', to: 'e-1b' } }, setup = { id: 'boss', start: 6, end: 10 };
  const at = (time, named) => derive({ time, grid: grid120, sceneStart: 0, sceneEnd: 16, named }, 8, { declared });
  // the host passes every saved interval (SceneClock.intervals): before the window it is full, after it is empty, both known, never the declared span
  const before = at(2, [setup]).named.boss, inside = at(8, [setup]).named.boss, after = at(12, [setup]).named.boss;
  eq([before.known, before.progress, before.remaining, before.duration], [true, 0, 4, 4], 'before its window: not started, full remaining');
  eq([inside.progress, inside.remaining], [0.5, 2], 'inside its window');
  eq([after.known, after.progress, after.remaining, after.remainingBars], [true, 1, 0, 0], 'after its window: finished');
  eq([C.hudTimingValue(at(2, [setup]), 'iv', 'remaining01', 'boss'), C.hudTimingValue(at(12, [setup]), 'iv', 'remaining01', 'boss')], [1, 0], 'a bound bar reads full before and empty after');
  for (const time of [0, 3, 6, 6.5, 9.99, 10, 11, 16]) near(at(time, [setup]).named.boss.duration, 4, `the saved interval never becomes the declared span (${time} s)`);
  // only the running ones passed: between the windows the declared default shows instead (the reason the host passes them all)
  const activeOnly = at(12, []).named.boss;
  near(activeOnly.duration, 12, 'an absent id falls back to the declared default (2 s to 14 s)'); ok(activeOnly.progress > 0.8 && activeOnly.progress < 0.9, 'and reads its own progress');
  // no declared default and not passed: an honest free cycle, unknown
  const bare = derive({ time: 12, grid: grid120, sceneStart: 0, sceneEnd: 16 });
  eq(Object.keys(bare.named), [], 'no default, no interval');
  eq(C.hudTimingValue(bare, 'iv', 'known', 'boss'), undefined, 'the binding then uses its own fallback');
  // replay: the same list at the same time gives the same span, whatever else was evaluated
  eq(JSON.stringify(plain(at(12, [setup]).named)), JSON.stringify(plain(at(12, [setup]).named)), 'deterministic');
}

// ---- the scene clock's own named intervals feed the HUD frame directly (SceneClock.intervals and activeIntervals)
{
  const timing = { enabled: true, bpm: 120, offsetSeconds: 0, barsPerScene: 8, seed: 1, version: 2, intervals: [{ id: 'boss', startBeat: 8, endBeat: 24 }, { id: 'coda', startBeat: 28, endBeat: 32 }] };
  const clock = S.compileSceneClock(timing), order = [0, 1];
  ok(Array.isArray(clock.intervals) && clock.intervals.length === 2 && typeof clock.activeIntervals === 'function', 'the scene clock exposes intervals and activeIntervals');
  for (const position of [0, 3.9, 4, 10, 11.9, 12, 14, 15.9]) {
    const f = clock.at(position, order, false), args = { time: position, grid: clock.clockGrid, sceneStart: f.start, sceneEnd: f.end };
    const all = derive({ ...args, named: clock.intervals }), active = derive({ ...args, named: clock.activeIntervals(position) });
    eq(Object.keys(all.named).sort(), ['boss', 'coda'], `every saved interval is present at ${position} s`);
    const running = clock.activeIntervals(position).map(x => x.id).sort();
    eq(Object.keys(active.named).sort(), running, `only the running ones are present when only those are passed (${running.join('+') || 'none'})`);
    for (const id of running) eq(JSON.stringify(plain(active.named[id])), JSON.stringify(plain(all.named[id])), `a running interval reads the same either way (${id})`);
  }
  const t = derive({ time: 10, grid: clock.clockGrid, sceneStart: 0, sceneEnd: 16, named: clock.intervals });
  near(t.named.boss.totalBars, 4, 'boss: 16 beats are four bars'); near(t.named.boss.progress, 0.75, 'boss: beat 20 of 8..24'); eq(t.named.boss.remainingBars, 1, 'boss: one bar to go');
  eq([t.named.coda.progress, t.named.coda.remaining, t.named.coda.known], [0, 2, true], 'coda: not started yet, two seconds long');
  near(C.hudTimingValue(t, 'iv', 'totalBars', 'boss'), 4, 'iv.boss.totalBars'); near(C.hudTimingValue(t, 'iv', 'remaining01', 'boss'), 0.25, 'iv.boss.remaining01');
}

// ---- time references
{
  const t = derive({ time: 5, grid: { offset: 0, beatsPerBar: 4, bpm: 120 }, sceneStart: 10, sceneEnd: 26 });
  const R = ref => C.resolveHudTimeRef(ref, t);
  near(R('s+0'), 10, 's+0'); near(R('s+2b'), 14, 's+2b'); near(R('s+1.5'), 11.5, 's+1.5 seconds'); near(R('s+1.5s'), 11.5, 's+1.5s');
  near(R('e-0'), 26, 'e-0'); near(R('e-1b'), 24, 'e-1b'); near(R('e-2'), 24, 'e-2 seconds'); near(R('f0.5'), 18, 'f0.5'); near(R('f0'), 10, 'f0'); near(R('f1'), 26, 'f1');
  near(R('s-1b'), 8, 's-1b is before the start but after the clock origin');
  eq(R('nope'), null, 'malformed'); eq(R(''), null, 'empty'); eq(R('s+1x'), null, 'bad unit');
  const open = derive({ time: 5, sceneStart: 10, sceneEnd: null });
  eq([C.resolveHudTimeRef('e-0', open), C.resolveHudTimeRef('e-1b', open), C.resolveHudTimeRef('f0.5', open)], [null, null, null], 'end and fraction references are unresolved while the end is unknown');
  near(C.resolveHudTimeRef('s+2b', open), 14, 'start references still resolve on the fallback clock');
  eq(C.resolveHudTimeRef({ anchor: 'e', offset: -1, unit: 'b', frac: 0 }, t), 24, 'a parsed reference is accepted');
}

// ---- tracks and value mapping
{
  const t = derive({ time: 5, track: { position: 30, duration: 120 } });
  eq([t.track.known, t.track.progress, t.track.remaining, t.track.duration], [true, 0.25, 90, 120], 'track with a duration');
  for (const duration of [null, 0, -3, NaN, Infinity, '9']) { const x = derive({ time: 5, track: { position: 30, duration } }); eq([x.track.known, x.track.duration, x.track.progress, x.track.remaining], [false, null, 0, 0], `track duration ${String(duration)}`); }
  eq(derive({ track: { position: 500, duration: 120 } }).track.progress, 1, 'track progress is clamped');
  eq(derive({ track: null }).track.known, false, 'a missing track is unknown');
  const v = (g, f, id) => C.hudTimingValue(t, g, f, id);
  eq([v('track', 'known'), v('track', 'duration'), v('track', 'position')], [1, 120, 30], 'track values');
  eq(C.hudTimingValue(derive({}), 'track', 'duration'), 0, 'unknown track duration reads as 0');
  const s = derive({ time: 12, grid: grid120, sceneStart: 8, sceneEnd: 24 });
  near(C.hudTimingValue(s, 'interval', 'remaining01'), 12 / 16, 'remaining01'); eq(C.hudTimingValue(s, 'interval', 'known'), 1, 'interval known');
  eq(C.hudTimingValue(derive({ time: 30, grid: grid120, sceneStart: 8, sceneEnd: 24 }), 'interval', 'overrun'), 6, 'interval overrun');
  near(C.hudTimingValue(s, 'clock', 'beatPos'), 24, 'clock beatPos'); near(C.hudTimingValue(s, 'clock', 'bpm'), 120, 'clock bpm');
  near(C.hudTimingValue(derive({ time: 12.5 }), 'clock', 'sweep'), (12.5 % 8) / 8, 'clock sweep');
  for (const f of C.HUD_SPAN_FIELDS) ok(typeof C.hudTimingValue(s, 'interval', f) === 'number', `interval.${f}`);
  eq(C.hudTimingValue(s, 'interval', 'bogus'), undefined, 'unknown field');
}

// ---- garbage in, finite numbers out; inputs are never mutated; the grid memo cannot follow a caller's mutation
{
  const ugly = [NaN, Infinity, -Infinity, -1, 0, 1e300, -1e300, '5', null, undefined, {}, []];
  const r = rng(41);
  const finiteAll = (v, path) => { if (typeof v === 'number') ok(Number.isFinite(v), `${path} must be finite`); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'clock') finiteAll(x, `${path}.${k}`); };
  for (let i = 0; i < 600; i++) {
    const pick = () => ugly[Math.floor(r() * ugly.length)];
    const o = { time: r() < 0.5 ? pick() : r() * 100, sceneStart: r() < 0.5 ? pick() : r() * 50, sceneEnd: r() < 0.5 ? pick() : 50 + r() * 50,
      grid: r() < 0.5 ? { offset: pick(), beatsPerBar: pick(), bpm: pick(), changes: pick() } : r() < 0.5 ? grid120 : pick(),
      tempo: r() < 0.5 ? { bpm: pick(), beatIndex: pick(), beatPhase: pick(), locked: r() < 0.7 } : pick(), named: r() < 0.5 ? [{ id: 'a', start: pick(), end: pick() }, pick()] : pick(),
      track: r() < 0.5 ? { position: pick(), duration: pick() } : pick() };
    const t = C.deriveHudTiming(o, pick(), r() < 0.3 ? { declared: { a: { from: 'e-1b', to: 'e-0' } } } : {});
    finiteAll(plain(t), 'timing');
    finiteAll(C.evalHudEvents({ a: { on: 'bar', n: 5, seed: 3 }, b: { on: 'half-bar', n: 64, seed: 4294967295, bias: 1, gap: 16, from: 's+1b', to: 'e-1b' } }, t), 'events');
  }
  const frozen = deepFreeze(input({ time: 9, grid: { offset: 1, beatsPerBar: 4, bpm: 100, changes: [[20, 90]] }, sceneStart: 5, sceneEnd: 30, tempo: { bpm: 90, beatIndex: 1, beatPhase: 0.5, locked: true }, named: [{ id: 'a', start: 6, end: 12 }], track: { position: 1, duration: 60 } }));
  C.deriveHudTiming(frozen, 8, deepFreeze({ declared: { z: { from: 's+1b', to: 's+2b' } } }));
  ok(true, 'frozen input is accepted (no mutation)');
  const g = { offset: 0, beatsPerBar: 4, bpm: 120 };
  const before = derive({ time: 10, grid: g, sceneStart: 0, sceneEnd: 16 });
  g.bpm = 60;
  const after = derive({ time: 10, grid: g, sceneStart: 0, sceneEnd: 16 });
  eq([before.beat.bpm, after.beat.bpm], [120, 60], 'a mutated grid is recompiled');
  const gc = { offset: 0, beatsPerBar: 4, bpm: 120, changes: [[5, 90]] };
  const c1 = derive({ time: 10, grid: gc, sceneStart: 0, sceneEnd: 16 });
  gc.changes[0][1] = 200;
  const c2 = derive({ time: 10, grid: gc, sceneStart: 0, sceneEnd: 16 });
  ok(c1.beat.pos !== c2.beat.pos, 'a mutated tempo change is recompiled');
}

// ---- seek equivalence: a frame depends on its inputs only, never on the frames evaluated before it
{
  const r = rng(51);
  const events = { a: { on: 'beat', n: 9, seed: 11, bias: 0.2, gap: 1 }, b: { on: 'bar', n: 5, seed: 23, from: 's+1b' } };
  const frame = time => ({ time, grid: { offset: 0.5, beatsPerBar: 4, bpm: 128, changes: [[40, 100]] }, sceneStart: 20, sceneEnd: 60, named: [{ id: 'iv', start: 30, end: 50 }] });
  const times = Array.from({ length: 200 }, () => 15 + r() * 60);
  const fresh = times.map(t => JSON.stringify([plain(C.deriveHudTiming(input(frame(t)), 8)), C.evalHudEvents(events, C.deriveHudTiming(input(frame(t)), 8))]));
  const order = times.map((_, i) => i).sort(() => r() - 0.5);
  for (const i of order) {
    C.deriveHudTiming(input(frame(r() * 100)), 8); // unrelated frames in between
    eq(JSON.stringify([plain(C.deriveHudTiming(input(frame(times[i])), 8)), C.evalHudEvents(events, C.deriveHudTiming(input(frame(times[i])), 8))]), fresh[i], 'same inputs, same frame, whatever came before');
  }
}

// ---- event schedules: parity with the normative prototype
{
  // independent copy of .tmp/hud/proto-sched.mjs (the design's reference implementation)
  const hash = (seed, k) => { let n = (Math.imul((seed ^ 0x9e3779b9) + k * 0x85ebca6b + 1, 0x45d9f3b)) >>> 0; n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); n = (n ^ (n >>> 16)) >>> 0; return n / 4294967296; };
  const proto = ({ n, seed, bias = 0, gap = 0 }, slots) => {
    n = Math.min(n, slots); const g = 2 ** bias; const a = k => Math.round(slots * Math.pow(k / n, g)); const ev = []; let last = -1e9;
    for (let k = 0; k < n; k++) { const lo = a(k), hi = Math.max(lo + 1, a(k + 1)); const s = Math.min(slots - 1, lo + Math.floor(hash(seed, k) * (hi - lo))); if (s - last > gap) { ev.push({ slot: s, w: .6 + .8 * hash(seed, 1000 + k) }); last = s; } }
    const total = ev.reduce((x, e) => x + e.w, 0); let c = 0; for (const e of ev) { c += e.w / total; e.cum = c; } return ev;
  };
  const r = rng(61);
  let plans = 0;
  for (let i = 0; i < 400; i++) {
    const spec = { n: 1 + Math.floor(r() * 64), seed: Math.floor(r() * 4294967296), bias: Math.round((r() * 2 - 1) * 100) / 100, gap: Math.floor(r() * 4) }, slots = 1 + Math.floor(r() * 130);
    const mine = C.planHudEvent(spec, slots), ref = proto(spec, slots);
    eq([...mine.at], ref.map(e => e.slot), `slots for ${JSON.stringify(spec)} on ${slots}`);
    mine.cum.forEach((c, k) => near(c, ref[k].cum, 'cumulative weight', 1e-12));
    ok(mine.at.length <= Math.min(spec.n, slots) && mine.at.length >= 1, 'count bound');
    ok(mine.at.every((s, k) => s >= 0 && s < slots && (k === 0 || s - mine.at[k - 1] > spec.gap)), 'slots in range, strictly increasing, gap respected');
    ok(mine.cum.every((c, k) => c > 0 && (k === 0 || c > mine.cum[k - 1])), 'cum strictly increasing');
    eq(mine.cum.at(-1), 1, 'cum is exactly 1 at the last event');
    ok(C.planHudEvent(spec, slots) === mine, 'plans are memoised and equal');
    ok(Object.isFrozen(mine) && Object.isFrozen(mine.at), 'plans are frozen');
    plans++;
  }
  eq(C.hudHash(11, 0), hash(11, 0), 'hash parity'); eq(C.hudHash(4294967295, 63), hash(4294967295, 63), 'hash parity at the extremes');
  // the typical amount of events survives (as the prototype asserted for gap-free specs)
  for (const [bars, n, seed, bias] of [[8, 9, 11, 0.2], [8, 6, 23, -0.1], [2, 12, 5, 0], [1, 9, 3, 0], [16, 40, 9, 0.5], [128, 64, 1, -0.5]]) {
    const p = C.planHudEvent({ n, seed, bias }, bars * 4);
    ok(p.at.length >= Math.min(n, bars * 4) * 0.6, `bars ${bars} n ${n}: ${p.at.length} events`);
  }
  eq([C.planHudEvent({ n: 5, seed: 1 }, 0).at.length, C.planHudEvent({ n: 0, seed: 1 }, 10).at.length, C.planHudEvent({ n: 5, seed: 1 }, NaN).at.length], [0, 0, 0], 'empty plans');
  eq(C.planHudEvent({ n: 5, seed: 1 }, 1).at.length, 1, 'one slot holds one event');
  ok(C.planHudEvent({ n: 64, seed: 1, gap: 0 }, 3).at.length <= 3, 'never more events than slots');
  ok(plans === 400, 'ran');
}

// ---- event values on a real timeline
{
  const g = { offset: 0, beatsPerBar: 4, bpm: 120 };
  const at = (time, sceneEnd = 16, extra = {}) => derive({ time, grid: g, sceneStart: 0, sceneEnd, ...extra });
  const spec = { on: 'beat', n: 9, seed: 11, bias: 0.2, gap: 1 };
  const plan = C.planHudEvent(spec, 32);
  // count follows the beat grid exactly, at any position
  for (let beat = 0; beat < 33; beat++) {
    const v = C.evalHudEvent(spec, at(beat * 0.5 + 0.01));
    eq(v.count, plan.at.filter(s => s <= beat).length, `count after beat ${beat}`);
    eq(v.cum, v.count ? plan.cum[v.count - 1] : 0, 'cum follows count');
    eq(v.remaining, 1 - v.cum, 'remaining is 1 - cum');
  }
  const done = C.evalHudEvent(spec, at(16));
  eq([done.cum, done.remaining, done.count], [1, 0, plan.at.length], 'exactly 1 and 0 at the scene end');
  eq(C.evalHudEvent(spec, at(30)).remaining, 0, 'and it stays there through the overrun');
  eq(C.evalHudEvent(spec, at(0)).count, plan.at[0] === 0 ? 1 : 0, 'nothing before the first slot');
  // pulse, since, next around the first event
  const first = plan.at.find(slot => slot > 0), tFirst = first * 0.5; // the fixture's slot 0 is an event, so the first later one shows a clean pulse and countdown
  const onTop = C.evalHudEvent(spec, at(tFirst + 1e-12));
  near(onTop.pulse, 1, 'pulse is 1 at an event', 1e-6);
  near(C.evalHudEvent(spec, at(tFirst + 0.25)).pulse, Math.exp(-1), 'pulse decays with tau 0.25 s', 1e-9);
  near(C.evalHudEvent(spec, at(tFirst + 0.25)).since, 0.25, 'since in seconds');
  eq(C.evalHudEvent({ ...spec, from: 's+2b' }, at(1)).since, 60, 'no event yet: since is the far value');
  eq(C.evalHudEvent(spec, at(0)).count, plan.at[0] === 0 ? 1 : 0, 'an event on slot 0 has fired at the scene start');
  near(C.evalHudEvent(spec, at(tFirst - 0.2)).next, 0.2, 'next in seconds', 1e-9);
  eq(C.evalHudEvent(spec, at(16)).next, 60, 'no next event after the last');
  // evaluation order does not matter (seek safe)
  const r = rng(71), times = Array.from({ length: 300 }, () => r() * 20 - 1);
  const ordered = [...times].sort((a, b) => a - b).map(t => [t, JSON.stringify(C.evalHudEvent(spec, at(t)))]);
  for (const [t, expected] of ordered.sort(() => r() - 0.5)) eq(JSON.stringify(C.evalHudEvent(spec, at(t))), expected, `order independence at ${t}`);
  // tempo independence: the same bar lengths at other tempos give the same count and cum at the same beat
  for (const bpm of [60, 90, 150, 200]) {
    const gb = { offset: 0, beatsPerBar: 4, bpm }, end = 8 * 240 / bpm;
    for (let beat = 0; beat < 33; beat += 3) {
      const v = C.evalHudEvent(spec, derive({ time: (beat + 0.01) * 60 / bpm, grid: gb, sceneStart: 0, sceneEnd: end }));
      eq([v.count, v.cum], [plan.at.filter(s => s <= beat).length, plan.at.filter(s => s <= beat).length ? plan.cum[plan.at.filter(s => s <= beat).length - 1] : 0], `${bpm} BPM, beat ${beat}`);
    }
  }
  // bar and half-bar units
  const bar = C.evalHudEvent({ on: 'bar', n: 4, seed: 9 }, at(16)), barPlan = C.planHudEvent({ n: 4, seed: 9 }, 8);
  eq([bar.count, C.hudEventWindow({ on: 'bar' }, at(0)).slots, C.hudEventWindow({ on: 'half-bar' }, at(0)).slots, C.hudEventWindow({ on: 'beat' }, at(0)).slots], [barPlan.at.length, 8, 16, 32], 'slots per unit');
  eq(C.hudEventWindow({ on: 'beat' }, at(0, 15)).slots, 30, 'a 7.5 s scene has 30 beat slots');
  // from and to bound the window
  const win = { on: 'beat', n: 6, seed: 5, from: 's+1b', to: 'e-1b' };
  eq(C.hudEventWindow(win, at(0)), { start: 4, unit: 1, slots: 24 }, 'window in scene-relative beats');
  eq(C.evalHudEvent(win, at(1.9)).count, 0, 'no event before from (s+1b is 2 s at 120 BPM)');
  eq(C.evalHudEvent(win, at(14.1)).cum, 1, 'all events land before to');
  const wp = C.planHudEvent(win, 24);
  eq(C.evalHudEvent(win, at(2 + wp.at[0] * 0.5 + 0.001)).count, 1, 'the first windowed event fires at from + slot');
  eq(C.hudEventWindow({ on: 'beat', from: 'e-1b', to: 's+1b' }, at(0)).slots, 0, 'a reversed window is empty');
  const empty = C.evalHudEvent({ on: 'beat', n: 5, seed: 1, from: 'e-1b', to: 's+1b' }, at(8));
  eq([empty.cum, empty.remaining, empty.count, empty.pulse], [0, 1, 0, 0], 'an empty window never fires');
  eq(C.evalHudEvent({ on: 'beat', n: 64, seed: 3 }, at(16, 1.5)).count, C.planHudEvent({ n: 64, seed: 3 }, 3).at.length, 'more events than slots is bounded by slots');
  // unknown end: the schedule runs on the free cycle and repeats
  const openSpec = { on: 'bar', n: 5, seed: 8 }, open = time => derive({ time }, 4);
  const cyc = 4 * 2; // four bars at 120 BPM
  for (let s = 0; s < 8; s += 0.5) {
    const a = C.evalHudEvent(openSpec, open(s + 0.01)), b = C.evalHudEvent(openSpec, open(s + 0.01 + cyc)), c = C.evalHudEvent(openSpec, open(s + 0.01 + 5 * cyc));
    eq([a.count, a.cum], [b.count, b.cum], 'the free cycle repeats');
    eq([a.count, a.cum], [c.count, c.cum], 'and keeps repeating');
  }
  eq(C.evalHudEvent(openSpec, open(cyc - 0.01)).cum, 1, 'the cycle completes before it wraps');
  eq(C.evalHudEvent(openSpec, open(cyc + 0.01)).cum <= C.evalHudEvent(openSpec, open(cyc - 0.01)).cum, true, 'and starts over');
  eq(Object.keys(C.evalHudEvents({ x: spec, y: openSpec }, at(4))).sort(), ['x', 'y'], 'evalHudEvents keys');
  eq(C.evalHudEvents(undefined, at(4)), {}, 'no events, no values');
  eq(C.hudEventField(done, 'cum'), 1, 'field lookup'); eq(C.hudEventField(done, 'nope'), undefined, 'unknown field');
}

// ---- event seconds integrate tempo steps, including a nonzero scene origin and the current free cycle
{
  const g = {offset: 2, beatsPerBar: 4, bpm: 120, changes: [[5, 60], [11, 180]]};
  // Independent piecewise inverse: six beats by 5 s, twelve by 11 s, then three per second.
  const seconds = beat => beat <= 0 ? 2 : beat <= 6 ? 2 + beat / 2 : beat <= 12 ? 5 + beat - 6 : 11 + (beat - 12) / 3;
  const beats = time => time <= 2 ? 0 : time <= 5 ? (time - 2) * 2 : time <= 11 ? 6 + time - 5 : 12 + (time - 11) * 3;
  const startBeat = 4, start = seconds(startBeat), endBeat = 36, end = seconds(endBeat);
  for (const known of [true, false]) for (const on of ['beat', 'bar', 'half-bar']) {
    const unit = on === 'beat' ? 1 : on === 'bar' ? 4 : 2, freeBeats = 8;
    const spec = {on, n: 64, seed: 7, ...(known ? {from: 's+1b', to: 'e-1b'} : {})};
    const windowStart = known ? 4 : 0, spanBeats = known ? endBeat - startBeat : freeBeats;
    const slots = Math.floor((spanBeats - (known ? 8 : 0)) / unit), plan = C.planHudEvent(spec, slots);
    const times = Array.from({length: 160}, (_, k) => start + k * .125);
    for (const time of times) {
      const cycle = known ? 0 : Math.floor(Math.max(0, beats(time) - startBeat) / freeBeats);
      const origin = startBeat + cycle * freeBeats;
      const eventTimes = plan.at.map(slot => seconds(origin + windowStart + slot * unit));
      const count = eventTimes.filter(at => at <= time + 1e-9).length;
      const t = derive({time, grid: g, sceneStart: start, sceneEnd: known ? end : null}, 2), actual = C.evalHudEvent(spec, t);
      eq(actual.count, count, 'known/free event count follows independently integrated event times');
      const since = count ? Math.min(60, Math.max(0, time - eventTimes[count - 1])) : 60;
      const next = count < eventTimes.length ? Math.min(60, Math.max(0, eventTimes[count] - time)) : 60;
      near(actual.since, since, 'since integrates every crossed tempo step');
      near(actual.next, next, 'next integrates future tempo steps');
      near(actual.pulse, count && since < 60 ? Math.exp(-since / .25) : 0, 'pulse decays in true seconds');
      eq(C.evalHudEvent(spec, derive({time, grid: g, sceneStart: start, sceneEnd: known ? end : null}, 2)), actual, 'replay preserves event seconds');
    }
  }
  const simple = {offset: 0, beatsPerBar: 4, bpm: 120, changes: [[2, 60]]};
  const v = C.evalHudEvent({on: 'beat', n: 4, seed: 1, to: 's+2'}, derive({time: 3, grid: simple, sceneStart: 0, sceneEnd: 8}));
  near(v.since, 1.5, 'last event on beat 3 happened at 1.5 s, not one current-tempo interval per historical beat');
}

// ---- the manifest's signal registry and this module answer exactly the same names
{
  const t = derive({ time: 12, grid: grid120, sceneStart: 8, sceneEnd: 24, named: [{ id: 'boss', start: 9, end: 20 }], track: { position: 3, duration: 100 } });
  for (const group of ['interval', 'clock', 'track']) for (const field of M.HUD_SIGNAL_FIELDS[group]) ok(Number.isFinite(C.hudTimingValue(t, group, field)), `${group}.${field} has a finite value`);
  for (const field of M.HUD_SIGNAL_FIELDS.iv) ok(Number.isFinite(C.hudTimingValue(t, 'iv', field, 'boss')), `iv.boss.${field} has a finite value`);
  const values = C.evalHudEvent({ on: 'beat', n: 4, seed: 1 }, t);
  for (const field of M.HUD_SIGNAL_FIELDS.ev) ok(Number.isFinite(C.hudEventField(values, field)), `ev.<id>.${field} has a finite value`);
  eq([...C.HUD_SPAN_FIELDS], [...M.HUD_SIGNAL_FIELDS.iv], 'the span fields are the iv fields, in the registry order');
  eq(C.hudTimingValue(t, 'iv', 'overrun', 'boss'), undefined, 'a named interval has no overrun (the registry has none either)');
  eq(M.HUD_SIGNAL_FIELDS.interval.filter(f => !C.HUD_SPAN_FIELDS.includes(f)), ['overrun'], 'the scene interval is the span fields plus overrun');
  // every name the manifest can bind resolves through parseHudSignal to a group this module can evaluate (or a group the engine owns)
  const owned = new Set(['audio', 'seed', 'const']);
  for (const name of M.HUD_STATIC_SIGNALS) {
    const info = M.parseHudSignal(name);
    if (owned.has(info.group)) continue;
    ok(C.hudTimingValue(t, info.group, info.field, info.id) !== undefined, `${name} is answered by hudTimingValue`);
  }
  // the manifest's time reference grammar is the one this module resolves
  for (const ref of ['s+0', 's+2b', 'e-1b', 'e-0', 's+1.5', 'f0.5', 'f1']) ok(C.resolveHudTimeRef(ref, t) !== null && M.parseTimeRef(ref) !== null, `${ref} parses in the manifest and resolves here`);
}

// ---- event values over dense sweeps: bounded, monotone, complete, on tempo maps, bar units and windows
{
  const r = rng(83);
  let sweeps = 0, complete = 0;
  for (let i = 0; i < 150; i++) {
    const offset = r() * 4, changes = [];
    let at = offset;
    for (let k = 0, n = Math.floor(r() * 4); k < n; k++) { at += 3 + r() * 20; changes.push([at, 40 + r() * 250]); }
    const g = { offset, beatsPerBar: 2 + Math.floor(r() * 5), bpm: 60 + r() * 140, ...(changes.length ? { changes } : {}) };
    const clock = C.hudGridClock(g), bar = g.beatsPerBar, bars = 1 + Math.floor(r() * 12), startBeat = Math.floor(r() * 8) * bar;
    const start = clock.timeAt(startBeat), end = clock.timeAt(startBeat + bars * bar);
    const spec = { on: ['beat', 'bar', 'half-bar'][i % 3], n: 1 + Math.floor(r() * 20), seed: Math.floor(r() * 4294967296), bias: r() * 2 - 1, gap: Math.floor(r() * 3), ...(i % 4 === 0 ? { from: 's+1b', to: 'e-1b' } : {}) };
    const at2 = time => derive({ time, grid: g, sceneStart: start, sceneEnd: end });
    let previous = null;
    const steps = 320;
    for (let k = 0; k <= steps; k++) {
      const time = start - 0.5 + (end - start + 1.5) * k / steps;
      const v = C.evalHudEvent(spec, at2(time));
      ok(v.cum >= 0 && v.cum <= 1 && v.remaining >= 0 && v.remaining <= 1 && Math.abs(v.cum + v.remaining - 1) < 1e-12 && v.pulse >= 0 && v.pulse <= 1 && v.since >= 0 && v.since <= 60 && v.next >= 0 && v.next <= 60 && Number.isInteger(v.count), 'event values stay in range');
      if (previous) ok(v.cum >= previous.cum && v.count >= previous.count && v.remaining <= previous.remaining, 'cum and count never fall, remaining never rises');
      if (v.count === 0) ok(v.pulse === 0 && v.since === 60 && v.cum === 0, 'before the first event: no pulse, far since');
      previous = v;
    }
    const window = C.hudEventWindow(spec, at2(end)), events = C.planHudEvent(spec, window.slots).at.length;
    const last = C.evalHudEvent(spec, at2(end));
    if (events) { eq([last.cum, last.remaining, last.count], [1, 0, events], 'a non-empty schedule is complete at the scene end'); complete++; } else eq([last.cum, last.count], [0, 0], 'an empty window never fires');
    sweeps++;
  }
  ok(sweeps === 150 && complete > 100, `${sweeps} sweeps, ${complete} with events`);
}

// ---- event specs handed over by code (a manifest cannot hold these, an engine bug might): total, finite, deterministic
{
  const t = derive({ time: 5, grid: grid120, sceneStart: 0, sceneEnd: 16 });
  const plain0 = C.evalHudEvent({ on: 'beat', n: 6, seed: 5 }, t);
  eq(C.evalHudEvent({ on: 'beat', n: 6, seed: 5, from: 'garbage', to: 'nope' }, t), plain0, 'a malformed window reference reads as absent');
  for (const spec of [{ on: 'bogus', n: 4, seed: 1 }, { on: 'bar', n: NaN, seed: 1 }, { on: 'bar', n: 4, seed: NaN }, { on: 'bar', n: 4, seed: -5 }, { on: 'bar', n: 4, seed: 1e30 }, { on: 'beat', n: 1e9, seed: 1 }, { on: 'beat', n: -3, seed: 1 }, { on: 'beat', n: 4, seed: 1, bias: 50, gap: -2 }]) {
    const v = C.evalHudEvent(spec, t);
    ok(Object.values(v).every(Number.isFinite) && v.cum >= 0 && v.cum <= 1, `spec ${JSON.stringify(spec)} evaluates to finite values`);
    eq(JSON.stringify(C.evalHudEvent(spec, t)), JSON.stringify(v), 'and is deterministic');
  }
  const plan = C.planHudEvent({ n: 5, seed: 3 }, 20);
  ok(Object.isFrozen(plan) && Object.isFrozen(plan.at) && Object.isFrozen(plan.cum), 'plans are immutable, so the memo cannot be corrupted by a caller');
  assert.throws(() => { 'use strict'; plan.at.push(1); }, TypeError); checks++;
  // a tiny memo capacity must not change any answer (the cache is an optimisation only)
  const before = JSON.stringify(Array.from({ length: 300 }, (_, k) => C.planHudEvent({ n: 1 + (k % 50), seed: k * 7919, bias: (k % 9) / 9, gap: k % 3 }, 5 + (k % 61))));
  const again = JSON.stringify(Array.from({ length: 300 }, (_, k) => C.planHudEvent({ n: 1 + (k % 50), seed: k * 7919, bias: (k % 9) / 9, gap: k % 3 }, 5 + (k % 61))));
  eq(again, before, 'plans are stable across memo eviction (the memo clears at 256 entries)');
}

// ---- repeat and seek: a scene played twice gives the same frames, and unrelated scenes in between change nothing
{
  const scene = { grid: { offset: 0.25, beatsPerBar: 3, bpm: 111, changes: [[30, 90]] }, sceneStart: 6, sceneEnd: 56 };
  const events = { a: { on: 'beat', n: 12, seed: 4, bias: 0.3, gap: 1 }, b: { on: 'bar', n: 5, seed: 8, from: 's+1b', to: 'e-2b' } };
  const declared = { boss: { from: 's+2b', to: 'e-2b' } };
  const frame = (time, other = false) => {
    const s = other ? { grid: { offset: 0, beatsPerBar: 4, bpm: 200 }, sceneStart: 1, sceneEnd: 9 } : scene;
    const t = C.deriveHudTiming(input({ time, ...s }), 8, { declared });
    return JSON.stringify([plain(t), C.evalHudEvents(events, t)]);
  };
  const times = Array.from({ length: 120 }, (_, k) => 3 + k * 0.5);
  const first = times.map(t => frame(t)), second = times.map(t => (frame(t, true), frame(t)));
  eq(second, first, 'the second pass of the same scene equals the first, with another scene evaluated between every frame');
  const back = [...times].reverse().map(t => frame(t)).reverse();
  eq(back, first, 'and playing backwards gives the same frames');
}

// ---- beat boundaries: a beat, bar or event slot that starts exactly at t is already current at t, on every clock and at any tempo
{
  const r = rng(97);
  let beats = 0, slotsChecked = 0, grids = 0;
  const randomGrid = () => {
    const offset = r() * 5, changes = [];
    let at = offset;
    for (let k = 0, n = Math.floor(r() * 4); k < n; k++) { at += 3 + r() * 20; changes.push([at, 40 + r() * 250]); }
    return { offset, beatsPerBar: 1 + Math.floor(r() * 8), bpm: 50 + r() * 200, ...(changes.length ? { changes } : {}) };
  };
  for (let i = 0; i < 300; i++) {
    const g = randomGrid(), clock = C.hudGridClock(g), bpb = g.beatsPerBar, sBeat = Math.floor(r() * 6) * bpb, bars = 1 + Math.floor(r() * 8);
    const start = clock.timeAt(sBeat), end = clock.timeAt(sBeat + bars * bpb), at = time => derive({ time, grid: g, sceneStart: start, sceneEnd: end });
    for (let k = 0; k < 40; k++) {
      const b = at(clock.timeAt(k)).beat;
      eq([b.inBar, b.barIndex], [k % bpb, Math.floor(k / bpb)], `beat ${k} is current at its own time (${JSON.stringify(g).slice(0, 80)})`);
      ok(b.phase >= 0 && b.phase < 1e-9 && b.barPhase >= 0 && b.barPhase < 1, 'and its phase starts at 0');
      if (k > 0) { const before = at(clock.timeAt(k) - 1e-6).beat; eq(before.inBar, (k - 1) % bpb, 'one microsecond earlier the previous beat is still current'); ok(before.phase > 0.99 && before.phase < 1, 'with its phase almost complete'); }
      beats++;
    }
    for (const on of ['beat', 'bar', 'half-bar']) {
      const spec = { on, n: 1 + Math.floor(r() * 24), seed: Math.floor(r() * 4294967296), bias: r() * 2 - 1, gap: Math.floor(r() * 3) };
      const w = C.hudEventWindow(spec, at(start)), plan = C.planHudEvent(spec, w.slots);
      for (let s = 0; s < w.slots; s++) {
        const t = clock.timeAt(sBeat + w.start + s * w.unit);
        eq(C.evalHudEvent(spec, at(t)).count, plan.at.filter(x => x <= s).length, `${on} slot ${s} has fired at its own time`);
        if (s > 0) eq(C.evalHudEvent(spec, at(t - 1e-6)).count, plan.at.filter(x => x <= s - 1).length, `${on} slot ${s} has not fired a microsecond early`);
        slotsChecked++;
      }
    }
    grids++;
  }
  // the fallback clock (120 BPM, four beats a bar, beat 0 at the scene start) is exact on the half-second
  for (const start of [0, 3.7, 12.345, 100]) for (let k = 0; k < 400; k++) {
    const b = derive({ time: start + k * 0.5, sceneStart: start }).beat;
    ok(b.source === 'fallback' && b.inBar === k % 4 && b.barIndex === Math.floor(k / 4) && b.phase >= 0 && b.phase < 1e-9, `fallback beat ${k} from ${start}`);
  }
  // the live tracker's own beat index and phase are passed through; the scene-relative position still follows the tempo
  for (const bpm of [60, 90, 128, 133.3, 174, 200]) for (let k = 0; k < 200; k += 7) {
    const t = derive({ time: 3.7 + k * 60 / bpm, sceneStart: 3.7, tempo: { bpm, beatIndex: k, beatPhase: 0, locked: true } });
    near(t.beat.scenePos, k, `tempo ${bpm}: scene beat ${k}`); eq([t.beat.inBar, t.beat.barIndex, t.beat.source], [k % 4, Math.floor(k / 4), 'tempo'], 'and the tracker fields pass through');
  }
  ok(beats > 10000 && slotsChecked > 5000 && grids === 300, `${beats} beat boundaries and ${slotsChecked} event slots on ${grids} tempo maps`);
}

// ---- a fresh module instance (a second worker, a restarted worker) replays exactly what the first one computed
{
  const fresh = await load('src/hud/hud-clock.ts');
  const r = rng(101), plainJson = t => JSON.stringify(t);
  let compared = 0;
  for (let i = 0; i < 500; i++) {
    const g = { offset: r() * 3, beatsPerBar: 1 + Math.floor(r() * 8), bpm: 50 + r() * 200, ...(r() < 0.3 ? { changes: [[20 + r() * 30, 60 + r() * 120]] } : {}) };
    const o = input({ time: r() * 100 - 5, grid: r() < 0.7 ? g : null, sceneStart: 5, sceneEnd: r() < 0.7 ? 15 + r() * 30 : null, named: r() < 0.5 ? [{ id: 'a', start: 8, end: 20 }] : undefined, track: { position: r() * 50, duration: r() < 0.5 ? 200 : null } });
    const declared = { declared: { z: { from: 's+1b', to: 'e-1b' }, y: { from: 'f0.25', to: 'f0.75' } } }, spec = { on: 'bar', n: 6, seed: Math.floor(r() * 1e9), bias: 0.2, gap: 1, from: 's+1b' };
    const a = C.deriveHudTiming(o, 8, declared), b = fresh.deriveHudTiming(o, 8, declared);
    eq(plainJson(a), plainJson(b), 'the timing is the same in a fresh module instance');
    eq(plainJson(C.evalHudEvent(spec, a)), plainJson(fresh.evalHudEvent(spec, b)), 'and so are the event values');
    compared++;
  }
  eq(compared, 500, 'compared');
  for (const [seed, k] of [[0, 0], [1, 1], [4294967295, 63], [123456789, 999]]) eq(C.hudHash(seed, k), fresh.hudHash(seed, k), 'the schedule hash is a pure function');
}

// ---- extremes: very long sessions and distant offsets stay finite and ordered
{
  const g = { offset: 1e6, beatsPerBar: 16, bpm: 400, changes: [[2e6, 20], [5e6, 400]] };
  let previous = -1;
  for (const time of [-1e9, 0, 1e6 - 1, 1e6, 1e6 + 0.5, 2e6, 3e6, 5e6, 7e6, 1e9]) {
    const t = derive({ time, grid: g, sceneStart: 1e6, sceneEnd: 8e6 }), b = t.beat;
    ok(Object.entries(plain(t.scene)).every(([key, x]) => key === 'known' || Number.isFinite(x)) && [b.pos, b.phase, b.barPos, b.barPhase, b.bpm].every(Number.isFinite), `finite values at ${time} s`);
    ok(b.pos >= previous && t.scene.progress >= 0 && t.scene.progress <= 1 && b.phase >= 0 && b.phase < 1 && b.inBar >= 0 && b.inBar < 16, `ordered values at ${time} s`);
    previous = b.pos;
    const v = C.evalHudEvent({ on: 'bar', n: 64, seed: 7, gap: 2 }, t);
    ok(Object.values(v).every(Number.isFinite) && v.cum >= 0 && v.cum <= 1, `finite event values at ${time} s`);
  }
  const longFree = derive({ time: 1e9 + 0.25 }, 32);
  ok(Number.isFinite(longFree.scene.freePhase) && longFree.scene.freePhase >= 0 && longFree.scene.freePhase <= 1 && longFree.beat.phase >= 0 && longFree.beat.phase < 1, 'a session a billion seconds long still cycles');
  eq(derive({ time: 1e300 }).time, 1e9, 'a time beyond the cap is clamped');
}

// ---- hygiene: no clocks or randomness, no private paths, in the modules this check covers
{
  const strip = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
  for (const file of ['src/hud/hud-clock.ts', 'src/hud/hud-manifest.ts', 'src/hud-preset.ts']) {
    const code = strip(readFileSync(file, 'utf8'));
    for (const banned of ['Math.random', 'Date.now', 'performance.now', 'new Date', 'localStorage', 'sessionStorage', 'document.', 'window.']) ok(!code.includes(banned), `${file} must not use ${banned}`);
  }
  const private_ = [['C:', '\\Users'].join(''), ['hot', 'gh'].join(''), ['@', 'gmail'].join(''), ['Levon', 'French'].join('')];
  for (const file of ['src/hud/hud-clock.ts', 'src/hud/hud-manifest.ts', 'src/hud-preset.ts', 'tools/check-hud-clock.mjs', 'tools/fixtures-hud.mjs']) {
    const text = readFileSync(file, 'utf8');
    for (const word of private_) ok(!text.includes(word), `${file} must not contain a private path or name`);
  }
}

console.log(`HUD clock: ${checks} checks. Scene-clock parity, exact endpoints at 24-240 fps, free cycle and fallbacks, named intervals, time references, garbage input, seek equivalence, beat boundaries, fresh-instance replay, extremes and event schedules PASS (CPU-only)`);
