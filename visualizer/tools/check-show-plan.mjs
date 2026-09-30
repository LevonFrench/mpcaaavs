// CPU checks for the show director (src/show/plan.ts, AAAVS).
//
//  1. On the reference fixture, planShow(songMap, NERV_SHOW) reproduces bizarro/evangelion's hand-cut timeline
//     (app/src/timeline.ts, MIT) exactly: same plates in the same order, the same windows, and bar maps that are the
//     identity (each plate plays its own home bars).
//  2. On synthetic song maps (tempos, lengths, arrangements) the plan keeps its invariants: windows are contiguous and
//     cover the song, start and end on downbeats, every drop downbeat is a hard cut, plates never repeat back to back,
//     parts respect the per-role bar limits, the intro plate opens and the outro plate closes, and every plate's
//     bar map sends its home window onto its song window (so its story resolves on the window's last bar).
//  3. Determinism: planning twice gives identical plans.
//
//   node tools/check-show-plan.mjs [--print]
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const VIS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  stdin: {
    contents: `export { planShow, splitBars, downbeatGrid, barIndexAt } from './src/show/plan.ts';
      export { NERV_SHOW, NERV_PLATE_IDS } from './src/shows/nerv/show-def.ts';
      export { songToHome, homeToSong } from './src/show/bar-map.ts';`,
    resolveDir: VIS, loader: 'ts',
  },
  bundle: true, format: 'esm', write: false, logLevel: 'error',
});
const { planShow, splitBars, downbeatGrid, NERV_SHOW, NERV_PLATE_IDS, songToHome, homeToSong } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

let assertions = 0;
const ok = (c, msg) => { assertions++; assert.ok(c, msg); };
const eq = (a, b, msg) => { assertions++; assert.deepEqual(a, b, msg); };
const near = (a, b, msg, eps = 1e-9) => { assertions++; assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`); };

// ------------------------------------------------------------------ 1. the reference timeline
const fixture = JSON.parse(readFileSync(join(VIS, 'tools/fixtures/nerv-reference/song-map.json'), 'utf8'));
// upstream app/src/timeline.ts, transcribed: E(id, bar(a), bar(b)) with bar(k) = downbeats[k + 2] (1.8 s bars past the end)
const UPSTREAM = [
  ['boot', null, 2], ['magi', 2, 7], ['psycho', 7, 13], ['radar', 13, 18], ['harmonics', 18, 24], ['seele', 24, 29],
  ['battery', 29, 35], ['atfield', 35, 45], ['alert', 45, 54], ['plug', 54, 60], ['target', 60, 65], ['city', 65, 72],
  ['sync', 72, 78], ['berserk', 78, 87], ['impact', 87, 96], ['end', 96, null],
];
const D = fixture.downbeats;
const upBar = (k) => D[k + 2] ?? D[D.length - 1] + (k + 2 - D.length + 1) * 1.8;
const plan = planShow(fixture, NERV_SHOW);
if (process.argv.includes('--print')) {
  for (const p of plan) console.log(p.id.padEnd(10), p.role.padEnd(9), p.start.toFixed(3).padStart(8), p.end.toFixed(3).padStart(8), `bars ${p.startBar}-${p.endBar}`, JSON.stringify(p.params));
}
eq(plan.map((p) => p.id), UPSTREAM.map((u) => u[0]), 'reference plan: plate order matches upstream timeline.ts');
UPSTREAM.forEach(([id, a, b], i) => {
  const p = plan[i];
  near(p.start, a === null ? 0 : upBar(a), `reference plan: ${id} start`);
  near(p.end, b === null ? fixture.duration : upBar(b), `reference plan: ${id} end`);
  // identity bar map: home bar k plays on song downbeat k + barOff
  const bm = p.barMap;
  const home = NERV_SHOW.plates[id].home;
  eq([bm.homeStart, bm.homeEnd], [home[0], home[1]], `reference plan: ${id} home window`);
  eq([bm.songStart - bm.barOff, bm.songEnd - bm.barOff], [home[0], home[1]], `reference plan: ${id} plays its own home bars`);
});
eq(new Set(plan.map((p) => p.id)), new Set(NERV_PLATE_IDS), 'reference plan: every NERV plate appears');

// ------------------------------------------------------------------ 2. synthetic songs
function song({ bpm, bars, sections, lead = 0, swing = 0, dur }) {
  const beat = 60 / bpm, beats = [], downbeats = [];
  for (let i = 0; i < bars * 4; i++) {
    const t = lead + i * beat + (i % 2 ? swing * beat : 0);
    beats.push(+t.toFixed(4));
    if (i % 4 === 0) downbeats.push(+t.toFixed(4));
  }
  const duration = dur ?? lead + bars * 4 * beat;
  let a = 0;
  const secs = sections.map(([role, n], k) => {
    const s = { name: `${role}${k}`, role, start: a === 0 ? 0 : downbeats[a], end: downbeats[a + n] ?? duration, energy: role === 'drop' ? 1 : 0.5 };
    a += n;
    return s;
  });
  assert.equal(a, bars, 'synthetic arrangement covers the bars');
  return { version: 1, duration, bpm, fps: 100, beats, downbeats, sections: secs, features: {}, onsets: {}, confidence: { tempo: 1, downbeat: 1, sections: 1 }, approximations: [] };
}
const MAX = { intro: 16, groove: 8, break: 8, build: 8, drop: 12, breakdown: 8, outro: 16, bridge: 12 };
const SONGS = {
  'edm 128': song({ bpm: 128, bars: 96, sections: [['intro', 16], ['build', 8], ['drop', 16], ['breakdown', 16], ['build', 8], ['drop', 24], ['outro', 8]] }),
  'dnb 174': song({ bpm: 174, bars: 128, lead: 0.37, sections: [['intro', 32], ['drop', 32], ['breakdown', 16], ['break', 4], ['drop', 32], ['outro', 12]] }),
  'hiphop 90 swing': song({ bpm: 90, bars: 40, swing: 0.16, lead: 1.1, sections: [['intro', 4], ['groove', 16], ['break', 2], ['groove', 12], ['outro', 6]] }),
  'odd lengths 133.33': song({ bpm: 133.333, bars: 71, lead: 0.5, sections: [['intro', 3], ['groove', 13], ['break', 1], ['groove', 11], ['build', 7], ['drop', 19], ['breakdown', 9], ['outro', 8]] }),
  // break after a breakdown that ended on seele: the break's first candidate is seele again
  'breakdown into break': song({ bpm: 124, bars: 40, sections: [['intro', 4], ['breakdown', 16], ['break', 8], ['groove', 8], ['outro', 4]] }),
  'short loop': song({ bpm: 120, bars: 6, sections: [['groove', 6]] }),
  'no sections': { ...song({ bpm: 100, bars: 24, sections: [['groove', 24]] }), sections: [] },
};
// Pinned edits (reviewed by eye): 8-bar phrase splits, a 4-bar break bridging into a drop (plug takes the break and
// 8 drop bars), a 1-bar break folded into the groove before it, near-equal splits of odd lengths, and a break after a
// breakdown skipping the plate that just played.
const EXPECTED = {
  'edm 128': 'boot[0-16] battery[16-24] atfield[24-32] alert[32-40] city[40-48] seele[48-56] sync[56-64] target[64-72] berserk[72-80] impact[80-88] end[88-96]',
  'dnb 174': 'boot[0-8] magi[8-16] psycho[16-24] radar[24-32] atfield[32-40] alert[40-48] target[48-56] berserk[56-64] city[64-72] seele[72-80] plug[80-92] impact[92-100] atfield[100-108] alert[108-116] end[116-128]',
  'hiphop 90 swing': 'boot[0-4] magi[4-12] psycho[12-20] seele[20-22] radar[22-28] harmonics[28-34] end[34-40]',
  'odd lengths 133.33': 'boot[0-3] magi[3-10] psycho[10-17] radar[17-22] harmonics[22-28] battery[28-35] atfield[35-44] alert[44-54] city[54-58] seele[58-63] end[63-71]',
  'breakdown into break': 'boot[0-4] city[4-12] seele[12-20] city[20-28] magi[28-36] end[36-40]',
  'short loop': 'magi[0-6]',
  'no sections': 'magi[0-8] psycho[8-16] radar[16-24]',
};
for (const [name, map] of Object.entries(SONGS)) {
  const p = planShow(map, NERV_SHOW);
  const d = downbeatGrid(map);
  ok(p.length > 0, `${name}: plan is not empty`);
  near(p[0].start, 0, `${name}: first window starts at 0`);
  near(p[p.length - 1].end, map.duration, `${name}: last window ends at the song end`);
  for (let i = 0; i < p.length; i++) {
    const x = p[i];
    ok(x.end > x.start, `${name}: ${x.id} window is not empty`);
    ok(Number.isInteger(x.startBar) && Number.isInteger(x.endBar) && x.endBar > x.startBar, `${name}: ${x.id} spans whole bars`);
    if (i > 0) {
      near(x.start, p[i - 1].end, `${name}: windows are contiguous at ${i}`);
      eq(x.startBar, p[i - 1].endBar, `${name}: bar windows are contiguous at ${i}`);
      ok(x.id !== p[i - 1].id, `${name}: ${x.id} does not repeat back to back`);
      if (x.startBar < d.length) near(x.start, d[x.startBar], `${name}: ${x.id} starts on a downbeat`);
    }
    ok(x.endBar - x.startBar <= MAX[x.role], `${name}: ${x.id} (${x.role}) within ${MAX[x.role]} bars`);
    ok(x.id in NERV_SHOW.plates, `${name}: ${x.id} is a NERV plate`);
    const bm = x.barMap, home = NERV_SHOW.plates[x.id].home;
    eq([bm.homeStart, bm.homeEnd, bm.songStart, bm.songEnd], [home[0], home[1], x.startBar, x.endBar], `${name}: ${x.id} bar map`);
    // the window's first and last song bars play the home window's first and last bars, the window's end is the
    // home window's end, and home bars never go backwards (the story runs forward and resolves on the last bar)
    const na = x.endBar - x.startBar, nh = home[1] - home[0];
    eq(songToHome(bm, 0), 0, `${name}: ${x.id} opens on its first home bar`);
    eq(Math.floor(songToHome(bm, na - 1)), nh - 1, `${name}: ${x.id} plays its last home bar in its last bar`);
    eq(songToHome(bm, na), nh, `${name}: ${x.id} ends where its home window ends`);
    for (let j = 1; j < na; j++) ok(songToHome(bm, j) >= songToHome(bm, j - 1), `${name}: ${x.id} home bars never go backwards`);
    eq(homeToSong(bm, nh), na, `${name}: ${x.id} home end maps to the window end`);
  }
  // hard cuts on drop downbeats: every drop section starts exactly on a window boundary, except where a bridge
  // (a short break into a drop) carries the drop downbeat as its params.drop
  for (const s of map.sections) {
    if (s.role !== 'drop' || s.start === 0) continue;
    const cut = p.some((x) => Math.abs(x.start - s.start) < 1e-6);
    const bridged = p.some((x) => x.role === 'bridge' && Math.abs(x.params.drop - s.start) < 1e-6);
    ok(cut || bridged, `${name}: drop at ${s.start.toFixed(3)} s is a hard cut or a bridge's drop`);
  }
  const hasIntro = map.sections[0]?.role === 'intro', hasOutro = map.sections[map.sections.length - 1]?.role === 'outro';
  if (hasIntro) eq(p[0].id, NERV_SHOW.intro, `${name}: intro plate opens`);
  if (hasOutro) eq(p[p.length - 1].id, NERV_SHOW.outro, `${name}: outro plate closes`);
  eq(planShow(map, NERV_SHOW), p, `${name}: planning is deterministic`);
  const got = p.map((x) => `${x.id}[${x.startBar}-${x.endBar}]`).join(' ');
  if (process.argv.includes('--print')) console.log(`${name}: ${got}`);
  if (EXPECTED[name]) eq(got, EXPECTED[name], `${name}: planned edit`);
}

// ------------------------------------------------------------------ 3. phrase splitting
eq(splitBars(8, 8), [8], 'splitBars: fits');
eq(splitBars(16, 8), [8, 8], 'splitBars: 8-bar phrases');
eq(splitBars(24, 12), [8, 8, 8], 'splitBars: multiples of 8 split on phrases even when longer parts fit');
eq(splitBars(19, 12), [9, 10], 'splitBars: near-equal parts, shorter first');
eq(splitBars(13, 8), [6, 7], 'splitBars: 13 bars');

console.log(`Show director CPU checks PASS (${assertions} assertions): upstream timeline reproduced on the reference fixture, ${Object.keys(SONGS).length} synthetic arrangements keep contiguity, downbeat cuts, drop hard cuts, bar limits, intro/outro plates, bar maps and determinism.`);
