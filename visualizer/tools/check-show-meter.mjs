// CPU checks for meters other than 4/4 in the show engine (AAAVS): the live fallback's grid and predicted onsets follow a clock's beatsPerBar,
// the preset window passes the host ClockGrid's meter on, the optional SongMapJSON.beatsPerBar reaches AudioData, the plan's downbeat grid and
// the clock, and 4/4 is unchanged bit for bit when nothing says otherwise. The song-map analyzer's 3-vs-4 estimate is gated in check-song-map.mjs.
//
//   node tools/check-show-meter.mjs
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const VIS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  stdin: {
    contents: `export { LiveAudioData, liveSongMap } from './src/show/live.ts';
      export { presetWindow } from './src/show/preset-window.ts';
      export { AudioData } from './src/show/audio.ts';
      export { planShow, downbeatGrid } from './src/show/plan.ts';
      export { NERV_SHOW, NERV_PLATE_IDS } from './src/shows/nerv/show-def.ts';
      export { SongMapClock } from './src/song-map/clock.ts';
      export { backbeats, beatsPerBarOf } from './src/song-map/meter.ts';`,
    resolveDir: VIS, loader: 'ts',
  },
  bundle: true, format: 'esm', write: false, logLevel: 'error', platform: 'neutral',
});
const M = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { LiveAudioData, liveSongMap, presetWindow, AudioData, planShow, downbeatGrid, NERV_SHOW, NERV_PLATE_IDS, SongMapClock, backbeats, beatsPerBarOf } = M;

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };
const eq = (a, b, m) => { n++; assert.deepEqual(a, b, m); };
const near = (a, b, e, m) => { n++; assert.ok(Math.abs(a - b) <= e, `${m}: ${a} vs ${b}`); };

// ------------------------------------------------------------------ live grid
{
  // 4/4 is the default and is unchanged: no beatsPerBar key, downbeats every 4 beats
  const plain = liveSongMap({ duration: 60, bpm: 128, firstBeat: 0.3 });
  eq(liveSongMap({ duration: 60, bpm: 128, firstBeat: 0.3, beatsPerBar: 4 }), plain, '4 is the default meter');
  ok(!('beatsPerBar' in plain), 'a 4/4 live map does not carry the field');
  eq(plain.downbeats, plain.beats.filter((_, i) => i % 4 === 0), '4/4 downbeats');
  for (const bad of [0, 1, 13, 3.5, NaN, '3', null, -2]) eq(liveSongMap({ duration: 60, bpm: 128, firstBeat: 0.3, beatsPerBar: bad }), plain, `an unusable meter ${String(bad)} reads as 4`);
  for (const meter of [2, 3, 5, 6, 7, 9, 12]) {
    const m = liveSongMap({ duration: 120, bpm: 96, firstBeat: 0.11, beatsPerBar: meter });
    eq(m.beatsPerBar, meter, `${meter}: the map names its meter`);
    eq(m.downbeats, m.beats.filter((_, i) => i % meter === 0), `${meter}: a downbeat every ${meter} beats`);
    eq(m.beats, liveSongMap({ duration: 120, bpm: 96, firstBeat: 0.11 }).beats, `${meter}: the beat grid itself does not depend on the meter`);
    near(m.downbeats[1] - m.downbeats[0], (60 / 96) * meter, 1e-5, `${meter}: bar length`);
    ok(m.sections.length === 3 && m.sections[1].start === m.downbeats[4], `${meter}: the arrangement (4 bars of intro) is in bars of the meter`);
    eq(new SongMapClock(m).beatsPerBar, meter, `${meter}: the clock reads the meter`);
  }
  // predicted onsets: a kick on every beat (the downbeat strongest), snares on the backbeats, hats on the off-beats
  for (const [meter, back] of [[4, [1, 3]], [3, [1, 2]], [2, [1]], [5, [1, 3]], [6, [3]], [7, [2, 4]]]) {
    const live = new LiveAudioData({ duration: 60, bpm: 120, firstBeat: 0, beatsPerBar: meter });
    const beats = live.map.beats;
    eq(live.onsets.kick.map(([t]) => t), beats.filter((t) => t > 0), `${meter}: a kick on every beat`);
    eq(live.onsets.kick.filter(([t]) => t > 0).map(([, s]) => s), beats.map((_, i) => (i % meter === 0 ? 0.85 : 0.6)).slice(1), `${meter}: the downbeat kick is the strongest`);
    eq(live.onsets.snare.map(([t]) => t), beats.filter((t, i) => t > 0 && back.includes(i % meter)), `${meter}: snares on beats ${back.map((b) => b + 1).join(' and ')}`);
    ok(live.onsets.hat.every(([t]) => Math.abs((t / 0.5) % 1 - 0.5) < 1e-6), `${meter}: hats on the off-beats`);
    eq(live.beatsPerBar, meter, `${meter}: AudioData.beatsPerBar`);
    eq(live.withBarMap({ barOff: 2, homeStart: 0, homeEnd: 8, songStart: 4, songEnd: 12 }).beatsPerBar, meter, `${meter}: a plate's bar-mapped view keeps the meter`);
    // bars and beats inside a bar
    const bar = live.barAt(live.downbeats[3] + (60 / 120) * (meter - 0.5));
    near(bar - Math.floor(bar), (meter - 0.5) / meter, 1e-6, `${meter}: bar phase on the meter's grid`);
  }
  // 4/4 live data is identical with and without the option
  const a = new LiveAudioData({ duration: 30, bpm: 128 }), b = new LiveAudioData({ duration: 30, bpm: 128, beatsPerBar: 4 });
  eq(a.onsets, b.onsets, '4/4 onsets are identical with the default meter');
  eq(backbeats(4), [1, 3], 'the 4/4 backbeats are beats 2 and 4');
  eq(a.onsets.snare.map(([t]) => t), a.map.beats.filter((t, i) => t > 0 && i % 2 === 1), '4/4 snares are on the odd beats, as before');
}

// ------------------------------------------------------------------ AudioData, plan and clock on a map with the optional field
{
  const beats = Array.from({ length: 200 }, (_, i) => 1 + i * 0.5);
  const map = (extra) => ({ version: 1, duration: 100, bpm: 120, fps: 100, beats, downbeats: [], sections: [], features: {}, onsets: { kick: [], snare: [], hat: [], vocal: [] }, confidence: { tempo: 1, downbeat: 0, sections: 0 }, approximations: [], ...extra });
  eq(new AudioData(map({})).beatsPerBar, 4, 'AudioData: absent means 4');
  eq(new AudioData(map({ beatsPerBar: 3 })).beatsPerBar, 3, 'AudioData: the map meter');
  eq(new AudioData(map({ beatsPerBar: 99 })).beatsPerBar, 4, 'AudioData: an unusable meter reads as 4');
  // with no downbeats, a bar is beatsPerBar beats on AudioData, the clock and the plan's grid
  const a3 = new AudioData(map({ beatsPerBar: 3 })), a4 = new AudioData(map({}));
  near(a3.barAt(1 + 6 * 0.5), 2, 1e-9, 'AudioData: 6 beats are 2 bars in 3/4');
  near(a4.barAt(1 + 6 * 0.5), 1.5, 1e-9, 'AudioData: 6 beats are 1.5 bars in 4/4');
  near(new SongMapClock(map({ beatsPerBar: 3 })).barAt(1 + 6 * 0.5), 2, 1e-9, 'clock: 6 beats are 2 bars in 3/4');
  eq(downbeatGrid(map({ beatsPerBar: 3 })), beats.filter((_, i) => i % 3 === 0), 'plan grid: every third beat in 3/4');
  eq(downbeatGrid(map({})), beats.filter((_, i) => i % 4 === 0), 'plan grid: every fourth beat by default');
  // the director on a 3/4 live map: contiguous, on downbeats, opening and closing plates
  const live = liveSongMap({ duration: 60, bpm: 126, firstBeat: 0.29, beatsPerBar: 3 });
  const plan = planShow(live, NERV_SHOW);
  eq(plan[0].id, 'boot', '3/4 director: boot opens');
  eq(plan[plan.length - 1].id, 'end', '3/4 director: end closes');
  for (let i = 1; i < plan.length; i++) near(plan[i].start, plan[i - 1].end, 1e-9, `3/4 director: contiguous at ${i}`);
  for (const p of plan.slice(1, -1)) ok(live.downbeats.some((d) => Math.abs(d - p.start) < 1e-6), `3/4 director: ${p.id} starts on a downbeat`);
  const bars = plan.map((p) => p.endBar - p.startBar);
  ok(bars.every((b) => b >= 1), '3/4 director: every plate has bars');
  // a 3/4 plan differs from a 4/4 plan of the same tempo only through the bar length
  near(plan[1].end - plan[1].start, (plan[1].endBar - plan[1].startBar) * (180 / 126), 1e-6, '3/4 director: a plate is a whole number of three-beat bars');
}

// ------------------------------------------------------------------ preset window: the host ClockGrid's beatsPerBar
{
  const BPM = 126;
  const gridOf = (beatsPerBar) => ({ offset: 0.29, beatsPerBar, bpm: BPM });
  const barS = (perBar) => (perBar * 60) / BPM;
  const clockOf = (perBar, o = {}) => ({ time: 100, localTime: 4, progress: 0.25, bpm: BPM, seed: 7, grid: gridOf(perBar), sceneStart: 96, sceneEnd: 96 + 8 * barS(perBar), ...o });
  for (const plate of NERV_PLATE_IDS) {
    const w3 = presetWindow(clockOf(3), plate), w4 = presetWindow(clockOf(4), plate);
    eq(w3.live.beatsPerBar, 3, `${plate}: the live window takes the grid's meter`);
    eq(w4.live.beatsPerBar, 4, `${plate}: a 4/4 grid is 4`);
    ok(w3.key !== w4.key, `${plate}: the meter is part of the analysis key`);
    const d = liveSongMap(w3.live).downbeats;
    eq(w3.current.barMap.songEnd - w3.current.barMap.songStart, 8, `${plate}: an 8-bar scene of 3/4 bars maps 8 song bars`);
    near(d[w3.current.barMap.songStart], 96, barS(3) / 2 + 1e-9, `${plate}: the bar map starts at the scene's downbeat`);
    near(d[1] - d[0], barS(3), 1e-5, `${plate}: the window's bars are three beats`);
    const keys = new Set();
    for (let t = 96; t < 96 + 8 * barS(3); t += 0.41) keys.add(presetWindow(clockOf(3, { time: t, localTime: t - 96, progress: (t - 96) / (8 * barS(3)) }), plate).key);
    eq(keys.size, 1, `${plate}: one analysis window per scene in 3/4`);
    // without a scene end the held-scene fallback uses bars of the meter
    const held = presetWindow(clockOf(3, { sceneEnd: undefined, progress: 0, localTime: 0, time: 96 }), plate);
    near(held.current.end - held.current.start, (NERV_SHOW.plates[plate].home[1] - NERV_SHOW.plates[plate].home[0]) * barS(3), 1e-6, `${plate}: default scene length is home bars of three beats`);
  }
  // 4/4 identical to before: a grid that says 4 or no grid at all
  const legacy = presetWindow({ time: 50, localTime: 10, progress: 0.5, bpm: 90, seed: 1 }, 'magi');
  eq(legacy.live.beatsPerBar, 4, 'legacy tempo (no grid): 4/4');
  near(legacy.current.end - legacy.current.start, 20, 1e-9, 'legacy tempo: scene length from progress is unchanged');
  // a grid meter the show cannot phrase on (1 or above 12) reads as 4
  for (const odd of [1, 13, 16]) eq(presetWindow(clockOf(odd), 'magi').live.beatsPerBar, 4, `a ${odd}-beat host bar reads as 4`);
}

console.log(`Show meter CPU checks PASS (${n} assertions): live grid, predicted backbeats, bars and onsets for 2..12 beats per bar, the optional map field through AudioData, the plan grid and the clock, 3/4 director, preset window meter, and unchanged 4/4.`);
