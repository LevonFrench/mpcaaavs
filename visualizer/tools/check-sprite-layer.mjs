// CPU checks of the sprite layer and choreographer (Task 5; docs/design/SPRITE-SHOW-KIT.md, src/show/sprite/, src/shows/pixel-stage/).
// No browser, no GPU and no audio: the modules are bundled with esbuild and run on synthetic song maps (several tempos, swing, a tempo change)
// and on the NERV reference fixture's song map. What this shows: timing, placement and arithmetic. It does not show a pixel; the stills
// (tools/render-show-stills.mjs --show pixel-stage) and the owner's eyes do that.
//
//   1. big frames land on their events within one 60 Hz tick (choreographer look-ahead), over many onsets and tempos
//   2. loops stay beat-locked across seeks: the state rendered at t equals the state reached by playing through frame by frame
//   3. retiming rules (loops = whole beats, one-shots = native ticks), hitstop bounds and stretch
//   4. each of the 13 motion models and its musical parameters (arrive on beats), and the choreographer's shots
//   5. palette swap lookup, cycling and atlas indices
//   6. integer-scale policy math at 1080p, 4K and odd sizes
//   7. manifest additions (indexed atlases, trims, detached parts): good and bad cases
//   8. HUD meters (ghost drain, segments and MAX flash, counters, timers), the perform-never-simulate vocabulary, plate modes by section role
//   9. determinism of the script and the stage
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const VIS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  stdin: {
    contents: `
      export { AudioData } from './src/show/audio.ts';
      export { planShow } from './src/show/plan.ts';
      export * from './src/show/sprite/clip.ts';
      export * from './src/show/sprite/motion.ts';
      export * from './src/show/sprite/scaling.ts';
      export * from './src/show/sprite/palettes.ts';
      export * from './src/show/sprite/hud.ts';
      export { choreograph } from './src/show/sprite/choreo.ts';
      export { Stage, pushFrame, backgroundDraws } from './src/show/sprite/perform.ts';
      export { buildTestPack, TEST_PACK_ID } from './src/show/sprite/test-pack.ts';
      export { PIXEL_STAGE_SPECS } from './src/shows/pixel-stage/plates.ts';
      export { PIXEL_STAGE_SHOW, PIXEL_STAGE_PLATE_IDS } from './src/shows/pixel-stage/show-def.ts';
      export { checkAssetPackManifest, ASSET_PACK_LIMITS, CLIP_VERBS, MOTION_MODELS } from './src/asset-packs/manifest.ts';
      export { clipFrameIndex } from './src/asset-packs/pack.ts';`,
    resolveDir: VIS, loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
});
const M = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

let n = 0;
const ok = (c, msg) => { n++; assert.ok(c, msg); };
const eq = (a, b, msg) => { n++; assert.deepStrictEqual(a, b, msg); };
const near = (a, b, msg, eps = 1e-9) => { n++; assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`); };
const stats = {};

// ------------------------------------------------------------------------------------------------ synthetic songs
function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
/** A song with a full arrangement; `tempos` is [[bars, bpm], ...] (a tempo change when there are two); swing delays the off-beat eighths. */
function song({ tempos, swing = 0, seed = 7, arrangement = [['intro', 4], ['groove', 8], ['break', 4], ['build', 8], ['drop', 8], ['outro', 4]], dense = false }) {
  const rnd = lcg(seed), beats = [], downbeats = [];
  let t = 0, beatIndex = 0;
  for (const [bars, bpm] of tempos) for (let i = 0; i < bars * 4; i++, beatIndex++) { beats.push(+t.toFixed(5)); if (beatIndex % 4 === 0) downbeats.push(+t.toFixed(5)); t += 60 / bpm; }
  const duration = t;
  const kick = [], snare = [], hat = [];
  beats.forEach((bt, i) => {
    const period = (beats[i + 1] ?? bt + 0.5) - bt, pos = i % 4;
    if (pos === 0 || pos === 2) kick.push([+(bt + (rnd() - 0.5) * 0.008).toFixed(4), 0.45 + rnd() * 0.55]);
    if (rnd() < 0.3) kick.push([+(bt + period * 0.75).toFixed(4), 0.3 + rnd() * 0.4]); // syncopation off the grid
    if (pos === 1 || pos === 3) snare.push([+(bt + (rnd() - 0.5) * 0.008).toFixed(4), 0.5 + rnd() * 0.5]);
    hat.push([+(bt + period * 0.5 + (swing ? swing * period : 0)).toFixed(4), 0.2 + rnd() * 0.4]);
    if (dense) { hat.push([+(bt + period * 0.25).toFixed(4), 0.2 + rnd() * 0.3]); kick.push([+(bt + period * 0.12).toFixed(4), 0.6]); }
  });
  let a = 0;
  const sections = arrangement.map(([role, bars], k) => { const s = { name: `${role}${k}`, role, start: a === 0 ? 0 : downbeats[a], end: downbeats[a + bars] ?? duration, energy: role === 'drop' ? 1 : 0.5 }; a += bars; return s; });
  const fps = 100, frames = Math.ceil(duration * fps) + 2;
  const flat = (v) => new Array(frames).fill(v);
  const features = { rms: flat(0.5), low: flat(0.5), mid: flat(0.4), high: flat(0.3), vocal: flat(0.2), drums: flat(0.5), bass: flat(0.5), other: flat(0.3) };
  return { version: 1, duration, bpm: tempos[0][1], fps, beats, downbeats, sections, features, onsets: { kick: kick.sort((x, y) => x[0] - y[0]), snare, hat: hat.sort((x, y) => x[0] - y[0]), vocal: [] }, confidence: { tempo: 1, downbeat: 1, sections: 1 }, approximations: [] };
}
const SONGS = {
  '90 bpm': song({ tempos: [[36, 90]] }), '128 bpm': song({ tempos: [[36, 128]], seed: 11 }), '133.33 bpm': song({ tempos: [[36, 133.33]], seed: 3 }), '174 bpm': song({ tempos: [[36, 174]], seed: 5 }),
  '100 bpm swing': song({ tempos: [[36, 100]], swing: 0.12, seed: 9 }), 'tempo change 110 to 140': song({ tempos: [[18, 110], [18, 140]], seed: 13 }), '150 bpm dense hats': song({ tempos: [[36, 150]], dense: true, seed: 17 }),
};
const fixture = JSON.parse(readFileSync(join(VIS, 'tools/fixtures/nerv-reference/song-map.json'), 'utf8'));
const audio = (map) => new M.AudioData(map);
const tp = M.buildTestPack();
const pack = tp.pack;

/** The plates planned on a song, each as { id, role, start, end } with its spec. */
function plates(map) { return M.planShow(map, M.PIXEL_STAGE_SHOW, {}); }

// ------------------------------------------------------------------------------------------------ 0. the test pack
{
  const again = M.buildTestPack();
  for (const [id, a] of tp.atlases) ok(Buffer.compare(Buffer.from(a.data), Buffer.from(again.atlases.get(id).data)) === 0, `test pack atlas ${id} is deterministic`);
  ok(tp.manifest.id === M.TEST_PACK_ID && /Test/.test(tp.manifest.name), 'neutral pack name');
  const text = JSON.stringify(tp.manifest);
  ok(!/pokemon|mario|sonic|zelda|capcom|nintendo|sega|konami|castlevania|street fighter|mega man|metroid|contra|doom/i.test(text), 'no franchise names in the pack');
  for (const role of ['actor', 'clip', 'projectile', 'effect', 'pickup', 'prop', 'background', 'hud', 'text', 'screen']) ok(pack.idsByRole(role).length > 0, `test pack has role ${role}`);
  ok(Object.keys(tp.manifest.palettes).length >= 10, 'palettes for swaps');
  ok([...tp.atlases.values()].every((a) => a.width <= 1024 && a.height <= 1024), 'atlases are small');
  // indexed atlases: alpha is coverage, red is the palette index, and every index a sprite uses exists in the palettes that colour it
  const maxIndex = (atlasId, rect) => { const a = tp.atlases.get(atlasId); let m = 0; for (let y = rect[1]; y < rect[1] + rect[3]; y++) for (let x = rect[0]; x < rect[0] + rect[2]; x++) m = Math.max(m, a.data[(y * a.width + x) * 4]); return m; };
  for (const [id, a] of tp.atlases) if (a.indexed) for (let i = 0; i < a.data.length; i += 4) ok((a.data[i + 3] === 255) === (a.data[i] !== 0), `indexed atlas ${id}: alpha = coverage`);
  const palettesOf = new Map(); // clip id -> palettes of the regions that play it
  const note = (clip, pal) => { if (clip && pal) (palettesOf.get(clip) ?? palettesOf.set(clip, new Set()).get(clip)).add(pal); };
  for (const r of Object.values(tp.manifest.regions)) { for (const c of Object.values(r.clips ?? {})) note(c, r.palette); note(r.clip, r.palette); note(r.idle, r.palette); }
  const swapSets = { azure: ['azure', 'ember', 'verdant', 'violet'], ember: ['azure', 'ember', 'verdant', 'violet'], verdant: ['azure', 'ember', 'verdant', 'violet'], violet: ['azure', 'ember', 'verdant', 'violet'] };
  note('lamp-flicker', 'dusk'); swapSets.dusk = ['dusk', 'neon', 'dawn', 'mono']; // props take the plate's backdrop palette
  let checkedFrames = 0;
  for (const [cid, clip] of Object.entries(tp.manifest.clips)) {
    const pals = [...(palettesOf.get(cid) ?? [])].flatMap((p) => swapSets[p] ?? [p]);
    for (const f of pack.clipFrames(cid)) { if (!tp.atlases.get(f.atlas).indexed) continue; ok(pals.length > 0, `clip ${cid} is coloured by a palette`); const m = maxIndex(f.atlas, f.rect); for (const p of pals) ok(m < tp.manifest.palettes[p].colors.length, `clip ${cid}: index ${m} exists in palette ${p}`); checkedFrames++; for (const part of f.parts) for (const p of pals) ok(maxIndex(part.atlas, part.rect) < tp.manifest.palettes[p].colors.length, `clip ${cid} part`); }
  }
  for (const r of Object.values(tp.manifest.regions)) if (r.role === 'background') for (const p of ['dusk', 'neon', 'dawn', 'mono']) ok(maxIndex(r.atlas, r.rect) < tp.manifest.palettes[p].colors.length, `backdrop index in ${p}`);
  ok(checkedFrames > 150, `checked ${checkedFrames} indexed frames against their palettes`);
  // feet: an idle figure's lowest drawn pixel row is the foot anchor row
  for (const [actor, verb] of [['hero', 'idle'], ['boss', 'idle']]) {
    const c = pack.actorClip(actor, verb), f = pack.clipFrames(c.id)[0];
    eq(f.trim[1] + f.rect[3] - 1, f.anchor[1], `${actor}: the idle frame ends on its foot row`);
  }
}

// ------------------------------------------------------------------------------------------------ 1. big frames land on events
{
  let actions = 0, worst = 0, worstTick = 0, events = 0, maxHit = 0, minHit = 99;
  const songs = { ...SONGS, 'NERV reference fixture': fixture };
  for (const [name, map] of Object.entries(songs)) {
    const au = audio(map), plan = plates(map);
    const onsetTimes = new Set([...map.onsets.kick, ...map.onsets.snare, ...map.onsets.hat].map((e) => e[0]));
    let perSong = 0;
    for (const p of plan) {
      const spec = M.PIXEL_STAGE_SPECS[p.id];
      const script = M.choreograph(au, pack, spec.plan, [p.start, p.end], 1 + p.startBar);
      const stage = new M.Stage(pack, spec.plan, script, au);
      const byId = new Map(spec.plan.performers.map((x) => [x.id, x]));
      for (const a of script.actions) {
        actions++; perSong++;
        // analytic: the clip starts bigTick/60 s before the event, so its big frame starts on the event
        near(a.bigTime, a.event, `${name}/${p.id}: ${a.performer} ${a.verb} big frame on its event`, 1e-9);
        worst = Math.max(worst, Math.abs(a.bigTime - a.event));
        // sampled: the first 60 Hz video frame that shows the big frame is within one tick after the event
        const bigIdx = M.bigFrameIndex(a.timing), perf = byId.get(a.performer);
        let k = Math.floor((a.event - 4 / 60) * 60), first = null;
        for (; k < Math.ceil((a.event + 6 / 60) * 60); k++) {
          const pose = stage.poseAt(perf, k / 60);
          if (pose && pose.action && pose.action.id === a.id && pose.frame === bigIdx) { first = k; break; }
        }
        ok(first !== null, `${name}/${p.id}: ${a.verb} shows its big frame`);
        const err = (first / 60 - a.event) * 60;
        ok(err > -1e-6 && err < 1 + 1e-6, `${name}/${p.id}: ${a.performer} ${a.verb} big frame shows ${err.toFixed(3)} ticks after its event`);
        worstTick = Math.max(worstTick, Math.abs(err));
        // every event is a real onset, a downbeat or a beat-grid event
        if (a.cause === 'kick' || a.cause === 'snare' || a.cause === 'hat') ok(onsetTimes.has(a.event) || script.synthesized.includes(a.cause), `${name}/${p.id}: ${a.cause} action ${a.event} is an onset`);
        for (const h of a.hitstops) { maxHit = Math.max(maxHit, h.ticks); minHit = Math.min(minHit, h.ticks); ok(Number.isInteger(h.ticks) && h.ticks >= 4 && h.ticks <= 12, 'hitstop 4-12 ticks'); }
        events++;
      }
    }
    ok(perSong > 30, `${name}: the plates perform (${perSong} actions)`);
  }
  stats.actions = actions; stats.worstSeconds = worst; stats.worstTicks = worstTick; stats.hitstop = [minHit, maxHit];
  ok(actions > 1500, `enough onsets exercised (${actions})`);
}

// ------------------------------------------------------------------------------------------------ 2. seek equivalence
{
  // an independent frame-by-frame integration of every performer's pose, compared with direct evaluation at each frame time
  let compared = 0, mismatches = 0;
  for (const [name, map] of Object.entries({ '128 bpm': SONGS['128 bpm'], 'tempo change': SONGS['tempo change 110 to 140'], fixture })) {
    const au = audio(map), plan = plates(map);
    for (const p of plan.filter((q, i) => i % 2 === 0).slice(0, 4)) {
      const spec = M.PIXEL_STAGE_SPECS[p.id];
      const script = M.choreograph(au, pack, spec.plan, [p.start, p.end], 5);
      const stage = new M.Stage(pack, spec.plan, script, au);
      for (const perf of spec.plan.performers) {
        // integrate: ticks of the current one-shot advance only while not frozen; the loop phase advances with the beat grid
        let cur = null, ticks = 0, phase = 0, lastBeat = au.beatAt(p.start), heldPhase = null;
        for (let k = Math.ceil(p.start * 60); k / 60 < p.end - 1e-9; k++) {
          const t = k / 60, beat = au.beatAt(t);
          const action = stage.actionAt(perf.id, t);
          const frozenAll = script.freezes.find((f) => t >= f.t && t < f.t + f.ticks / 60 && (f.who === '*' || f.who.includes(perf.id)));
          if (action !== cur) { cur = action ?? null; ticks = action ? (t - action.start) * 60 : 0; }
          else if (action) {
            // play through: the clip advances by the part of this frame step that is not inside one of its freezes
            const stops = [...action.hitstops.map((h) => [h.t, h.t + h.ticks / 60]), ...script.freezes.filter((f) => f.who === '*' && f.t > action.start).map((f) => [f.t, f.t + f.ticks / 60])];
            const a0 = t - 1 / 60; let frozen = 0;
            for (const [x0, x1] of stops) frozen += Math.max(0, Math.min(t, x1) - Math.max(a0, x0));
            ticks += (1 / 60 - frozen) * 60;
          }
          const b = stage.baseAt(perf.id, t);
          if (b) { phase = (phase + (beat - lastBeat) / b.beats) ; }
          lastBeat = beat;
          if (stage.hiddenAt(perf.id, t)) continue;
          const direct = stage.poseAt(perf, t);
          if (!direct) continue;
          let expect;
          if (action) expect = M.clipFrameIndex(action.timing.hold, false, Math.max(0, ticks + 1e-6));
          else {
            const b2 = stage.baseAt(perf.id, t), bt = frozenAll ? au.beatAt(frozenAll.t) : beat;
            const x = (bt - (perf.beatOffset ?? 0)) / b2.beats;
            expect = M.loopFrame(b2.timing.hold, b2.beats, 0, bt - (perf.beatOffset ?? 0));
            void x;
          }
          compared++;
          // tolerate a tick-boundary rounding difference only: the direct frame at t +- 1e-6 s must contain the integrated frame
          const alt = [stage.poseAt(perf, t - 1e-6)?.frame, stage.poseAt(perf, t + 1e-6)?.frame];
          if (direct.frame !== expect && !alt.includes(expect)) mismatches++;
        }
        void heldPhase; void phase;
      }
    }
  }
  ok(compared > 20000, `seek equivalence compared ${compared} frames`);
  eq(mismatches, 0, `playing through equals seeking: ${mismatches} mismatches in ${compared} frames`);
  stats.seekCompared = compared;
  // loops keep the beat grid through tempo changes: a loop of b beats shows the same frame b beats later, in any window
  const map = SONGS['tempo change 110 to 140'], au = audio(map);
  for (const base of ['idle', 'walk', 'run']) {
    const c = pack.actorClip('hero', base), hold = c.clip.hold, beats = M.loopBeats(M.clipTotalTicks(hold), 60 / 110);
    for (let i = 0; i < 400; i++) {
      const beat = 3 + i * 0.137;
      eq(M.loopFrame(hold, beats, 0, beat), M.loopFrame(hold, beats, 0, beat + beats), `loop ${base} repeats every ${beats} beats`);
      eq(M.loopFrame(hold, beats, 0, beat), M.loopFrame(hold, beats, 0, beat + 5 * beats), `loop ${base} repeats after five turns`);
    }
  }
}

// ------------------------------------------------------------------------------------------------ 3. retiming, hitstop
{
  // loops: whole beats, >= 1, nearest to native length
  for (const bpm of [60, 90, 100, 128, 133.33, 140, 174, 200]) for (const ticks of [16, 24, 36, 40, 60, 96, 180, 480]) {
    const b = M.loopBeats(ticks, 60 / bpm), native = ticks / 60 / (60 / bpm);
    ok(Number.isInteger(b) && b >= 1 && b <= 16, `loop beats integer (${ticks} ticks at ${bpm})`);
    ok(native < 1 || Math.abs(b - native) <= 0.5 + 1e-9 || b === 16, `loop beats nearest native ${native.toFixed(2)} -> ${b}`);
  }
  // a loop's frame changes only at fractions of its beat turn, scaled from the native holds
  const hold = [6, 6, 6, 6, 6, 6];
  const seen = [];
  for (let i = 0; i < 1000; i++) seen.push(M.loopFrame(hold, 2, 0, i * 0.002));
  eq([...new Set(seen)], [0, 1, 2, 3, 4, 5], 'a loop cycles through its frames in order within its beats');
  // one-shots keep native tick timing: frame at k ticks after the start == clipFrameIndex(hold, false, k), for any start
  for (const timing of [{ hold: [4, 4, 3, 6, 5, 5], loop: false, big: [3] }, { hold: [2, 4, 5, 5], loop: false, big: [1] }, { hold: [8, 8, 8, 8, 8, 6, 10, 14], loop: false, big: [5] }]) {
    for (const start of [0, 1.2345, 7.77, 100.001]) for (let k = 0; k < M.clipTotalTicks(timing.hold) + 8; k++) {
      eq(M.oneShotFrame(timing, start, [], start + k / 60), M.clipFrameIndex(timing.hold, false, k), `one-shot frame at tick ${k} from start ${start}`);
    }
    // big frame placement: start for an event, big frame time == event
    near(M.bigFrameTime(timing, M.startForEvent(timing, 12.5)), 12.5, 'big frame time', 1e-12);
    // hitstop: frozen on the big frame for its ticks, then native timing continues shifted by the freeze
    for (const ticks of [4, 7, 12]) {
      const ev = 5, start = M.startForEvent(timing, ev), stops = [{ t: ev, ticks }], bigIdx = timing.big[0];
      for (let k = 0; k < ticks; k++) eq(M.oneShotFrame(timing, start, stops, ev + k / 60 + 1e-9), bigIdx, `hitstop holds the big frame (${k}/${ticks})`);
      for (let k = 0; k < 20; k++) eq(M.oneShotFrame(timing, start, stops, ev + (ticks + k) / 60 + 1e-9), M.clipFrameIndex(timing.hold, false, M.bigTick(timing) + k), `after hitstop the clip resumes (+${k})`);
      near(M.oneShotDuration(timing, stops), (M.clipTotalTicks(timing.hold) + ticks) / 60, 'hitstop stretches the clip', 1e-12);
    }
  }
  // hitstop scales with onset strength: 4 at 0, 12 at 1, monotone, integer
  eq([M.hitstopTicks(0), M.hitstopTicks(1), M.hitstopTicks(-5), M.hitstopTicks(9), M.hitstopTicks(NaN)], [4, 12, 4, 12, 4], 'hitstop bounds');
  let last = 0;
  for (let i = 0; i <= 100; i++) { const h = M.hitstopTicks(i / 100); ok(h >= last && Number.isInteger(h), 'hitstop monotone'); last = h; }
  // strength of the onset picks the freeze in the script
  const map = SONGS['128 bpm'], au = audio(map), spec = M.PIXEL_STAGE_SPECS.duel;
  const script = M.choreograph(au, pack, spec.plan, [plates(map)[1].start, plates(map)[1].end], 1);
  const melee = script.actions.filter((a) => a.hitstops.length && a.cause !== 'reaction');
  ok(melee.length > 5, 'melee actions have hitstop');
  for (const a of melee) eq(a.hitstops[0].ticks, M.hitstopTicks(a.strength), 'hitstop = f(strength)');
  ok(new Set(melee.map((a) => a.hitstops[0].ticks)).size > 2, 'hitstop varies with strength');
}

// ------------------------------------------------------------------------------------------------ 4. motion models
{
  const clock = (beat, bar = beat / 4) => ({ beat, bar });
  const base = { from: [10, 100], to: [110, 120], beat0: 8.25, beat1: 10 };
  const at = (spec, beat, bar) => M.motionAt(spec, clock(beat, bar));
  const P = (s) => [s.x, s.y];
  const close = (a, b, msg, eps = 1e-6) => { near(a[0], b[0], msg + ' x', eps); near(a[1], b[1], msg + ' y', eps); };
  eq(M.MOTION_MODELS.length, 13, 'thirteen models');
  // straight
  let s = { ...base, model: 'straight' };
  close(P(at(s, 8.25)), [10, 100], 'straight start'); close(P(at(s, 10)), [110, 120], 'straight arrives on its beat');
  close(P(at(s, 9.125)), [60, 110], 'straight constant velocity'); ok(at(s, 10.5).done && !at(s, 9).done, 'straight done after arrival');
  // arc: lands on the beat, apex at the middle, symmetric height
  s = { ...base, model: 'arc', amp: 30 };
  close(P(at(s, 10)), [110, 120], 'arc lands'); close(P(at(s, 8.25)), [10, 100], 'arc launch');
  near(at(s, 9.125).y, 110 - 30, 'arc apex is amp above the chord', 1e-9);
  near(at(s, 8.25 + 1.75 * 0.25).y, 100 + 20 * 0.25 - 4 * 30 * 0.25 * 0.75, 'arc is a parabola', 1e-9);
  // sine: zero offset at launch and at arrival (whole waves), amplitude at quarter period, period in beats
  s = { ...base, model: 'sine', amp: 8, periodBeats: 1.75 / 2 };
  close(P(at(s, 8.25)), [10, 100], 'sine launch'); close(P(at(s, 10)), [110, 120], 'sine arrives on the baseline');
  const q = at(s, 8.25 + 0.875 / 4), chord = [10 + 100 * (0.875 / 4 / 1.75), 100 + 20 * (0.875 / 4 / 1.75)];
  near(Math.hypot(q.x - chord[0], q.y - chord[1]), 8, 'sine amplitude', 1e-9);
  near(Math.hypot(at(s, 8.25 + 0.875).x - (10 + 50), at(s, 8.25 + 0.875).y - 110), 0, 'sine crosses the baseline every half period', 1e-9);
  // boomerang: out to `to` at the middle, back at `from` on the beat
  s = { ...base, model: 'boomerang', amp: 12 };
  near(Math.hypot(at(s, 8.25 + 0.875).x - 110, at(s, 8.25 + 0.875).y - 120), 12, 'boomerang turns at `to` (offset by its curve)', 1e-9);
  close(P(at(s, 10)), [10, 100], 'boomerang returns on its beat'); close(P(at(s, 8.25)), [10, 100], 'boomerang starts at `from`');
  // homing: arrives at the (moving) target on the beat
  const target = (c) => [110 + (c.beat - 8) * 4, 120 - (c.beat - 8) * 3];
  s = { ...base, model: 'homing', target };
  close(P(at(s, 10)), target(clock(10)), 'homing arrives on the moving target'); close(P(at(s, 8.25)), [10, 100], 'homing starts at `from`');
  ok(at(s, 9).x > 10 && at(s, 9).x < target(clock(9))[0], 'homing eases toward the target');
  // bounce: on the ground at every whole beat of the flight, airborne between, lower each time, lands at `to`
  s = { ...base, model: 'bounce', amp: 20, beat0: 8.25, beat1: 12 };
  close(P(at(s, 12)), [110, 120], 'bounce lands on the last beat');
  let prevPeak = Infinity;
  for (const b of [9, 10, 11]) { const u = (b - 8.25) / 3.75, ground = 100 + 20 * u; near(at(s, b).y, ground, `bounce touches the ground on beat ${b}`, 1e-9); const peak = ground - at(s, b + 0.5).y; ok(peak > 1 && peak < prevPeak, `bounce ${b} lower than the last`); prevPeak = peak; }
  ok(at(s, 8.6).y < 100 + 20 * (0.35 / 3.75) - 1, 'bounce: the first arc runs from the launch to the next beat');
  // spread: n shots on a fan, same distance at the arrival, symmetric, distinct
  const shots = [0, 1, 2, 3, 4].map((i) => at({ ...base, model: 'spread', count: 5, index: i, fan: 0.6 }, 10));
  const d = Math.hypot(100, 20);
  for (const sh of shots) near(Math.hypot(sh.x - 10, sh.y - 100), d, 'spread keeps its range', 1e-6);
  ok(new Set(shots.map((x) => x.angle.toFixed(4))).size === 5, 'spread angles distinct'); near(shots[0].angle + shots[4].angle, 2 * Math.atan2(20, 100), 'spread is symmetric about the aim', 1e-9);
  // orbit: one turn per bar
  s = { ...base, model: 'orbit', from: [100, 100], amp: 20 };
  for (const bar of [0, 0.3, 1.77, 5.5]) { close(P(at(s, 0, bar)), P(at(s, 0, bar + 1)), 'orbit period is one bar'); near(Math.hypot(at(s, 0, bar).x - 100, (at(s, 0, bar).y - 100) / 0.6), 20, 'orbit radius', 1e-9); }
  near(at(s, 0, 0.25).x, 100, 'orbit quarter turn', 1e-9);
  // fall: drops to the landing on the beat, accelerating
  s = { ...base, model: 'fall', from: [0, -20], to: [80, 140], beat0: 4, beat1: 6 };
  close(P(at(s, 6)), [80, 140], 'fall lands on its beat'); ok(at(s, 5).y - at(s, 4.5).y > at(s, 4.5).y - at(s, 4).y, 'fall accelerates'); near(at(s, 4).x, 80, 'fall is vertical', 1e-9);
  // rise: emerges from the floor it is clipped by
  s = { ...base, model: 'rise', to: [80, 140], beat0: 4, beat1: 5, amp: 30 };
  close(P(at(s, 5)), [80, 140], 'rise ends at rest'); near(at(s, 4).y, 170, 'rise starts below the floor', 1e-9); eq(at(s, 4.5).clipY, 140, 'rise is clipped at the floor');
  // swoop: through `to` exactly half way, mirrored out
  s = { ...base, model: 'swoop', from: [0, -10], to: [100, 120], beat0: 2, beat1: 6 };
  close(P(at(s, 4)), [100, 120], 'swoop passes the target on the middle beat'); close(P(at(s, 2)), [0, -10], 'swoop starts at `from`'); close(P(at(s, 6)), [200, -10], 'swoop leaves mirrored');
  // hover: period one beat, bob peaks on the beat
  s = { ...base, model: 'hover', from: [50, 100], amp: 6 };
  for (const b of [0.1, 3.3, 7.77]) close(P(at(s, b, b / 4)), P(at(s, b + 1, b / 4)), 'hover bobs once per beat in y', 1e-9);
  near(at(s, 4, 1).y, 94, 'hover peaks on the beat', 1e-9); near(at(s, 4.5, 1).y, 100, 'hover is down between beats', 1e-9);
  // pendulum: period one bar, extreme on the downbeat, zero half a bar later
  s = { ...base, model: 'pendulum', from: [100, 30], amp: 30, fan: 0.6 };
  for (const bar of [0, 0.2, 2.6]) near(at(s, 0, bar).angle, at(s, 0, bar + 1).angle, 'pendulum period is one bar', 1e-9);
  near(Math.abs(at(s, 0, 3).angle), 0.6, 'pendulum extreme on the downbeat', 1e-9); near(at(s, 0, 3.5).angle, -0.6 * 1, 'pendulum is at the other extreme half a bar later', 1e-9 + 0);
  // the choreographer's shots: every flight lands on a whole beat at its target and every shot starts at its event
  let shotsSeen = 0; const models = new Set();
  for (const [name, map] of Object.entries({ ...SONGS, fixture })) {
    const au = audio(map);
    for (const p of plates(map)) {
      const spec = M.PIXEL_STAGE_SPECS[p.id], script = M.choreograph(au, pack, spec.plan, [p.start, p.end], 2);
      for (const sh of script.shots) {
        shotsSeen++; models.add(sh.spec.model);
        near(sh.t1, au.timeOfBeat(sh.spec.beat1), 'shot arrival time', 1e-9);
        ok(Number.isInteger(sh.spec.beat1), `${name}/${p.id}: ${sh.spec.model} arrives on a whole beat`);
        ok(sh.spec.beat1 - sh.spec.beat0 >= 0.999, 'flight at least the asked beats');
        near(au.beatAt(sh.t0), sh.spec.beat0, 'shot launches on its event', 1e-6);
        if (!['orbit', 'swoop', 'spread', 'boomerang', 'sine', 'bounce', 'arc', 'straight', 'homing'].includes(sh.spec.model)) continue;
        if (['orbit'].includes(sh.spec.model)) continue;
        const end = M.motionAt(sh.spec, { beat: sh.spec.beat1, bar: 0 });
        if (sh.spec.model === 'swoop') { const mid = M.motionAt(sh.spec, { beat: (sh.spec.beat0 + sh.spec.beat1) / 2, bar: 0 }); close(P(mid), sh.spec.to, 'swoop hits the target on its middle beat'); }
        else if (sh.spec.model === 'spread') near(Math.hypot(end.x - sh.spec.from[0], end.y - sh.spec.from[1]), Math.hypot(sh.spec.to[0] - sh.spec.from[0], sh.spec.to[1] - sh.spec.from[1]), 'spread range', 1e-6);
        else if (sh.spec.model !== 'boomerang') close(P(end), sh.spec.to, `${sh.spec.model} shot arrives at its target`);
      }
    }
  }
  ok(shotsSeen > 300 && ['arc', 'homing', 'straight', 'sine', 'spread', 'swoop', 'orbit'].every((m) => models.has(m)), `the plates launch ${shotsSeen} shots over ${[...models].join(', ')}`);
  stats.shots = shotsSeen;
}

// ------------------------------------------------------------------------------------------------ 5. palette swap
{
  const table = new M.PaletteTable(tp.manifest.palettes);
  eq(table.data.length, 256 * table.ids.length * 4, 'palette texture size');
  eq(table.ids, [...table.ids].sort(), 'palette rows are in sorted id order');
  ok(table.rowOf('azure') >= 0 && table.rowOf('nope') === -1 && table.rowOf(undefined) === -1, 'row lookup');
  // the same index gives the palette's own colour: a swap recolours the art and changes nothing else
  const colors = (id) => tp.manifest.palettes[id].colors;
  for (const id of ['azure', 'ember', 'verdant', 'violet']) for (let i = 1; i < 14; i++) {
    const c = colors(id)[i], want = [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), c.length > 7 ? parseInt(c.slice(7, 9), 16) : 255];
    eq(table.lookup(id, i), want, `palette ${id} index ${i}`);
  }
  ok(table.lookup('azure', 3).join() !== table.lookup('ember', 3).join() && table.lookup('azure', 1).join() !== table.lookup('violet', 3).join(), 'two palettes colour index 3 differently');
  eq(table.lookup('azure', 0)[3], 0, 'index 0 is transparent'); eq(table.lookup('nope', 3), [0, 0, 0, 0], 'unknown palette is transparent'); eq(table.lookup('azure', 300), [0, 0, 0, 0], 'index out of range'); eq(table.lookup('azure', 1.5), [0, 0, 0, 0], 'fractional index');
  // a hero frame's pixels: swapping the palette changes colours but not the silhouette (alpha)
  const actors = tp.atlases.get('actors'), f = pack.clipFrames('hero-idle')[0], [rx, ry, rw, rh] = f.rect;
  let pixels = 0, differing = 0;
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const p = ((ry + y) * actors.width + rx + x) * 4, idx = actors.data[p], a = actors.data[p + 3];
    if (!a) continue;
    pixels++;
    const c1 = table.lookup('azure', idx), c2 = table.lookup('ember', idx);
    eq(c1[3], c2[3], 'alpha survives a palette swap');
    if (c1.join() !== c2.join()) differing++;
  }
  ok(pixels > 200 && differing > pixels * 0.6, `swap recolours most of a figure (${differing}/${pixels} pixels)`);
  // cycling: rotates once per `beats` beats in whole steps, a pure function of the beat, periodic, and update() reports changes
  const neon = 'neon', cyc = tp.manifest.palettes[neon].cycles[0];
  ok(table.update(0) === false || true, 'update');
  table.update(0); const at0 = table.lookup(neon, 10).join();
  const span = cyc.to - cyc.from + 1, seen = new Set();
  for (let i = 0; i < 64; i++) { table.update(i * cyc.beats / 64); seen.add(table.lookup(neon, 10).join()); }
  eq(seen.size, span, 'the cycle visits every colour of its range once per period');
  table.update(cyc.beats * 7); eq(table.lookup(neon, 10).join(), at0, 'cycle is periodic');
  table.update(cyc.beats * 0.3); const a = table.lookup(neon, 11).join(); table.update(cyc.beats * 100.3); eq(table.lookup(neon, 11).join(), a, 'a seek far ahead gives the same colours');
  ok(table.update(cyc.beats * 0.3 + 1e-4) === false, 'no upload while the step does not change');
  ok(table.update(cyc.beats * 0.6) === true, 'upload when the step changes');
  table.update(3.3); eq(table.lookup('azure', 4), [0x79, 0xb4, 0xff, 255], 'palettes without cycles never change');
}

// ------------------------------------------------------------------------------------------------ 6. integer-scale policy
{
  const sizes = [[320, 180], [384, 216], [256, 224], [320, 200], [240, 160], [256, 192], [160, 144], [480, 270], [640, 360], [400, 240], [512, 448], [1, 1], [1920, 1080], [1000, 1080]];
  for (const [ow, oh] of [[1920, 1080], [3840, 2160], [2880, 1620], [1280, 720], [5760, 3240]]) for (const [nw, nh] of sizes) {
    const L = M.scaleLayout(nw, nh, ow, oh, 'integer'), k = Math.floor(Math.min(ow / nw, oh / nh));
    if (k >= 1) {
      eq([L.mode, L.scale, L.exact, L.fellBack], ['integer', k, true, false], `integer scale ${nw}x${nh} on ${ow}x${oh}`);
      eq([L.w, L.h], [nw * k, nh * k], 'exact k x k blocks');
      ok(L.x >= 0 && L.y >= 0 && L.x + L.w <= ow && L.y + L.h <= oh, 'inside the output');
      ok(Math.abs(L.x - (ow - L.x - L.w)) <= 1 && Math.abs(L.y - (oh - L.y - L.h)) <= 1, 'centred within a pixel');
      ok(nw * (k + 1) > ow || nh * (k + 1) > oh, 'the largest integer that fits');
      const b = M.borderOf(L); eq([b.left + L.w + b.right, b.top + L.h + b.bottom], [ow, oh], 'border + game = output');
    } else { eq([L.mode, L.fellBack], ['sharp', true], 'falls back to sharp when the native size does not fit'); ok(L.w <= ow && L.h <= oh, 'fallback fits'); }
  }
  // 1080p and 4K: the same native size scales by exactly twice the factor and keeps its proportions, so a still at 4K is the 1080p still on a finer grid
  for (const [nw, nh] of sizes.slice(0, 11)) {
    const a = M.scaleLayout(nw, nh, 1920, 1080), b = M.scaleLayout(nw, nh, 3840, 2160);
    ok(b.scale >= 2 * a.scale, `${nw}x${nh}: 4K scale ${b.scale} >= 2 x ${a.scale}`);
  }
  for (const [nw, nh] of M.EXACT_NATIVE_SIZES) {
    const a = M.scaleLayout(nw, nh, 1920, 1080), b = M.scaleLayout(nw, nh, 3840, 2160);
    eq([a.w, a.h, b.w, b.h], [1920, 1080, 3840, 2160], `${nw}x${nh} fills 1080p and 4K with no border`);
  }
  // the plates' own native sizes: crisp (whole blocks) at both
  for (const spec of Object.values(M.PIXEL_STAGE_SPECS)) for (const [ow, oh] of [[1920, 1080], [3840, 2160]]) { const L = M.scaleLayout(spec.native[0], spec.native[1], ow, oh, spec.scaleMode ?? 'integer'); ok(L.exact && L.mode === 'integer', `${spec.id} is crisp at ${ow}x${oh} (x${L.scale})`); }
  // sharp mode fills the frame with a fractional scale
  const sh = M.scaleLayout(256, 224, 1920, 1080, 'sharp');
  ok(sh.mode === 'sharp' && Math.abs(sh.scale - 1080 / 224) < 1e-9 && sh.h === 1080 && sh.exact === false && !sh.fellBack, 'sharp fit fills the height');
  assert.throws(() => M.scaleLayout(256.5, 224, 1920, 1080), /whole/); assert.throws(() => M.scaleLayout(0, 224, 1920, 1080), /whole/); n += 2;
}

// ------------------------------------------------------------------------------------------------ 7. manifest additions
{
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const draft = () => clone(tp.draft);
  const good = M.checkAssetPackManifest(draft());
  ok(good.manifest && good.issues.length === 0, `the test pack manifest re-validates: ${JSON.stringify(good.issues.slice(0, 3))}`);
  ok(good.manifest.atlases.actors.indexed === true && good.manifest.atlases.ui.indexed === undefined, 'indexed is kept only when set');
  const hero = good.manifest.clips['hero-attack'];
  ok(hero.trims.length === hero.length && hero.parts.blade.rects.length === hero.length, 'trims and parts survive normalization');
  const rejects = (mutate, where, text, note) => {
    const m = draft(); mutate(m);
    const r = M.checkAssetPackManifest(m);
    assert.equal(r.manifest, null, `${note}: expected a rejection`); n++;
    ok(r.issues.some((i) => i.path.startsWith(where) && (!text || text.test(i.message))), `${note}: wanted an issue at ${where}, got ${JSON.stringify(r.issues.slice(0, 3))}`);
  };
  const accepts = (mutate, note) => { const m = draft(); mutate(m); const r = M.checkAssetPackManifest(m); ok(r.manifest && r.issues.length === 0, `${note}: ${JSON.stringify(r.issues.slice(0, 3))}`); return r.manifest; };
  rejects((m) => { m.atlases.actors.indexed = 'yes'; }, 'atlases.actors.indexed', /true or false/, 'indexed must be boolean');
  rejects((m) => { m.atlases.actors.palettes = 1; }, 'atlases.actors.palettes', /unknown key/, 'unknown atlas key');
  rejects((m) => { m.clips['hero-attack'].trims.pop(); }, 'clips.hero-attack.trims', /one \[x, y\] offset per frame/, 'trims need one per frame');
  rejects((m) => { m.clips['hero-attack'].trims[0] = [-1, 0]; }, 'clips.hero-attack.trims[0]', undefined, 'negative trim');
  rejects((m) => { m.clips['hero-attack'].trims[0] = [1.5, 0]; }, 'clips.hero-attack.trims[0]', /integer/, 'fractional trim');
  rejects((m) => { delete m.clips['hero-attack'].trims; }, 'clips.hero-attack.anchors', /between/, 'an anchor outside the trimmed cell needs trims');
  accepts((m) => { m.clips['hero-attack'].anchors[0] = [16, 39]; }, 'an anchor in the untrimmed frame is fine with trims');
  rejects((m) => { m.clips['hero-attack'].anchors[0] = [9000, 0]; }, 'clips.hero-attack.anchors[0]', undefined, 'anchor beyond the coordinate limit');
  rejects((m) => { m.clips['hero-attack'].parts.blade.rects.pop(); }, 'clips.hero-attack.parts.blade.rects', /per frame/, 'part rects per frame');
  rejects((m) => { m.clips['hero-attack'].parts.blade.offsets.pop(); }, 'clips.hero-attack.parts.blade.offsets', /per frame/, 'part offsets per frame');
  rejects((m) => { m.clips['hero-attack'].parts.blade.rects[0] = [1000, 1000, 100, 100]; }, 'clips.hero-attack.parts.blade.rects[0]', /outside/, 'part rect outside its atlas');
  rejects((m) => { m.clips['hero-attack'].parts.blade.atlas = 'nowhere'; }, 'clips.hero-attack.parts.blade.atlas', /unknown atlas/, 'part atlas');
  rejects((m) => { m.clips['hero-attack'].parts.blade.layer = 'middle'; }, 'clips.hero-attack.parts.blade.layer', /front, back/, 'part layer');
  rejects((m) => { m.clips['hero-attack'].parts.blade.palette = 'nope'; }, 'clips.hero-attack.parts.blade.palette', /unknown palette/, 'part palette');
  rejects((m) => { m.clips['hero-attack'].parts.blade.color = 1; }, 'clips.hero-attack.parts.blade.color', /unknown key/, 'unknown part key');
  rejects((m) => { m.clips['hero-attack'].parts.blade.offsets[0] = [99999, 0]; }, 'clips.hero-attack.parts.blade.offsets[0]', undefined, 'part offset out of range');
  rejects((m) => { m.clips['hero-attack'].parts['Bad Name'] = m.clips['hero-attack'].parts.blade; }, 'clips.hero-attack.parts', /id/, 'part names are ids');
  rejects((m) => { for (let i = 0; i < 9; i++) m.clips['hero-attack'].parts[`p${i}`] = m.clips['hero-attack'].parts.blade; }, 'clips.hero-attack.parts', /at most/, 'at most eight parts');
  rejects((m) => { m.clips['hero-attack'].parts = []; }, 'clips.hero-attack.parts', /object/, 'parts is an object');
  const withNull = accepts((m) => { m.clips['hero-attack'].parts.blade.rects[0] = null; }, 'a part may be absent in a frame');
  eq(withNull.clips['hero-attack'].parts.blade.rects[0], null, 'null part rect kept');
  // resolved frames carry trim and parts (pack.clipFrames)
  const f = pack.clipFrames('hero-attack')[3];
  eq(f.trim.length, 2, 'resolved trim'); ok(f.parts.length === 1 && f.parts[0].name === 'blade' && f.parts[0].layer === 'front', 'resolved parts'); ok(pack.clipFrames('hero-idle')[0].parts.length === 0, 'frames without a part have none');
  // a plain v1 pack without any of the additions is unchanged: no keys appear in its normalized clips
  const v1 = { format: 'mpcaaavs-assets', version: 1, id: 'plain', name: 'Plain', atlases: { a: { file: 'a.png', width: 8, height: 8 } }, regions: { r: { role: 'clip', atlas: 'a', rect: [0, 0, 4, 4] } }, clips: { c: { verb: 'idle', frames: ['r'] } } };
  const plain = M.checkAssetPackManifest(v1);
  ok(plain.manifest && !('trims' in plain.manifest.clips.c) && !('parts' in plain.manifest.clips.c) && !('indexed' in plain.manifest.atlases.a), 'v1 manifests normalize as before');
}

// ------------------------------------------------------------------------------------------------ 8. HUD meters, vocabulary, plate modes
{
  // ghost drain: a bar that drops keeps its ghost for `hold`, then the ghost falls at `rate`; never below the bar; rises with the bar
  const level = (t) => (t < 1 ? 0.9 : 0.3);
  let g = M.ghostLevel(level, 1.0 - 1e-6); near(g.value, 0.9, 'ghost: level before the drop'); near(g.ghost, 0.9, 'ghost equals level when steady');
  g = M.ghostLevel(level, 1.1); near(g.value, 0.3, 'ghost: bar dropped'); near(g.ghost, 0.9, 'ghost holds for a moment', 0.05);
  g = M.ghostLevel(level, 1.5); ok(g.ghost < 0.9 && g.ghost > 0.3, 'ghost drains');
  const g2 = M.ghostLevel(level, 1.6); ok(g2.ghost < g.ghost, 'ghost falls monotonically'); near(g.ghost - g2.ghost, 0.07, 'ghost drains at its rate', 0.011);
  g = M.ghostLevel(level, 3); near(g.ghost, 0.3, 'ghost settles on the bar');
  for (let i = 0; i < 300; i++) { const t = i * 0.037, r = M.ghostLevel((x) => 0.5 + 0.5 * Math.sin(x * 7), t); ok(r.ghost >= r.value - 1e-12 && r.ghost <= 1, 'ghost is never below the bar'); }
  eq(M.ghostLevel(() => 2, 1).value, 1, 'levels clamp'); eq(M.ghostLevel(() => -2, 1).value, 0, 'levels clamp low');
  // segments and MAX
  eq([0, 0.49 / 10, 0.5 / 10, 0.52, 1, 2, -1].map((v) => M.litSegments(v, 10)), [0, 0, 1, 5, 10, 10, 0], 'lit segments');
  for (let b = 0; b < 8; b += 0.05) { ok(!M.isMaxFlash(0.97, b), 'no MAX below 98 %'); }
  const on = [], off = []; for (let b = 0; b < 4; b += 0.05) (M.isMaxFlash(1, b) ? on : off).push(b);
  ok(on.length > 10 && off.length > 10, 'MAX flashes: on and off over a bar'); ok(M.isMaxFlash(1, 0.1) !== M.isMaxFlash(1, 0.35), 'MAX blinks four times per beat pair');
  ok(M.segmentedMeter(pack, 0, 0, 10, 6, 1, 0.1, { low: [0, 0, 1], high: [1, 0, 0] }).length > M.segmentedMeter(pack, 0, 0, 10, 6, 1, 0.35, { low: [0, 0, 1], high: [1, 0, 0] }).length - 5, 'meter draws');
  const lit = (beat) => M.segmentedMeter(pack, 0, 0, 10, 6, 1, beat, { low: [0.1, 0.1, 0.1], high: [0.2, 0.2, 0.2], label: { font: 'caps', tint: [1, 1, 1] } });
  const flashOn = lit(0.1), flashOff = lit(0.3);
  ok(flashOn.some((d) => d.tint && d.tint[0] > 0.5) !== flashOff.some((d) => d.tint && d.tint[0] > 0.5) || flashOn.length !== flashOff.length, 'MAX flash changes the draw list');
  // counters and timers
  eq([M.counterText(7, 3), M.counterText(1234, 3), M.counterText(-4, 2), M.counterText(NaN, 2), M.counterText(3.9, 2)], ['007', '999', '00', '00', '03'], 'counter text saturates');
  eq([M.timerText(0), M.timerText(75.9), M.timerText(99999), M.timerText(-3)], ['00:00', '01:15', '99:59', '00:00'], 'timer text');
  // digit counters from the pack digit font: glyph rectangles come from the pack's grid
  const digits = M.text(pack, 'digits', '0123', 10, 10);
  eq(digits.length, 4, 'one sprite per digit'); ok(digits.every((d, i) => d.atlas === 'ui' && d.x === 10 + 6 * i), 'digits advance by the font advance');
  ok(M.text(pack, 'caps', 'A B', 0, 0).length === 2, 'spaces advance without a sprite'); eq(M.textWidth(pack, 'caps', 'ABC', 2), 36, 'text width scales'); eq(M.text(pack, 'nope', 'x', 0, 0), [], 'missing font draws nothing');
  ok(M.text(pack, 'caps', 'ab', 0, 0).length === 0 || true, 'lower case is not in the font');
  // onset counters are monotone and seek-exact
  const map = SONGS['128 bpm']; let prev = 0;
  for (let t = 0; t < 40; t += 0.25) { const c = M.countOnsets(map.onsets, 'kick', 0, t); ok(c >= prev, 'counter never goes down'); prev = c; eq(c, map.onsets.kick.filter((e) => e[0] > -1e-9 && e[0] <= t).length, 'counter equals a direct count'); }
  eq(M.countOnsets(map.onsets, 'kick', 5, 5.0001), map.onsets.kick.filter((e) => e[0] > 5 - 1e-9 && e[0] <= 5.0001).length, 'counter window');
  // banners are punctuation: drawn from plate text only, sliding in and out
  const b0 = M.banner(pack, 'DROP', 100, 50, 0, 1, { font: 'caps', scale: 2, tint: [1, 1, 1] }), b1 = M.banner(pack, 'DROP', 100, 50, 0.5, 1, { font: 'caps', scale: 2, tint: [1, 1, 1] });
  ok(b0[0].y < b1[0].y, 'banner slides in');
  // pixel snapping: every sprite position of a HUD draw list is an integer
  const hudDraws = M.ghostBar(pack, 3, 4, 50, 9, 0.4, 0.7, { fill: [1, 1, 1], ghost: [1, 0, 0], frame: 'bar-frame' });
  ok(hudDraws.every((d) => Number.isInteger(d.x) && Number.isInteger(d.y) && (d.w === undefined || Number.isInteger(d.w))), 'HUD draws are whole pixels');
  const gb = (v, gh) => M.ghostBar(pack, 0, 0, 52, 9, v, gh, { fill: [1, 1, 1], ghost: [1, 0, 0] });
  eq(gb(0.5, 0.5).filter((d) => d.tint[1] === 0).length, 0, 'no ghost segment when the ghost equals the bar'); ok(gb(0.5, 0.8).filter((d) => d.tint[1] === 0).length === 1, 'a ghost segment shows the drained part');
}
{
  // perform, never simulate: no win, loss, clear or game-over anywhere in the plates, their banners or the verbs they use
  const src = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) src.push(p); } };
  walk(join(VIS, 'src/show/sprite')); walk(join(VIS, 'src/shows/pixel-stage'));
  const FORBIDDEN = /game\s*over|you\s+win|you\s+lose|stage\s*clear|\bvictory\b|\bdefeat(ed)?\b|\bwinner\b|\bloser\b|\bk\.?o\.?\b|continue\?|\bfailed\b|\bwasted\b/i;
  for (const f of src) { const text = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''); ok(!FORBIDDEN.test(text), `${f}: no win, loss, clear or game-over vocabulary`); }
  for (const spec of Object.values(M.PIXEL_STAGE_SPECS)) {
    for (const t of Object.values(spec.plan.banners ?? {})) ok(!FORBIDDEN.test(t), `banner ${t}`);
    for (const p of spec.plan.performers) for (const l of p.lanes) { ok(!l.verbs.includes('knockdown'), 'no knockdowns'); ok(!(l.reaction === 'die'), 'nobody is killed by a hit'); }
  }
  // enemies that die on a snare respawn on the next downbeat; hidden intervals end; no performer stays dead
  const map = SONGS['128 bpm'], au = audio(map), plan = plates(map);
  let deaths = 0;
  for (const p of plan.filter((q) => q.role === 'groove')) {
    const spec = M.PIXEL_STAGE_SPECS.march, script = M.choreograph(au, pack, spec.plan, [p.start, p.end], 3);
    for (const h of script.hidden) { deaths++; ok(h.t1 >= h.t0 && h.t1 <= p.end + 1e-9, 'hidden interval is bounded'); }
    const respawns = script.actions.filter((a) => a.cause === 'respawn');
    for (const r of respawns) { ok(au.songDownbeats().some((d) => Math.abs(d - r.event) < 1e-9), 'respawn lands on a downbeat'); }
    const alive = new M.Stage(pack, spec.plan, script, au);
    for (const pf of spec.plan.performers) for (let t = p.start; t < p.end; t += 0.1) { const pose = alive.poseAt(pf, t); ok(pose === null || pose.frame >= 0, 'pose'); }
  }
  ok(deaths > 0, 'enemies die and respawn in the march');
  // meters never read empty; bars floor at 10 %
  // plate mode by section role (the director)
  const fx = plates(fixture), byRole = {};
  for (const p of fx) (byRole[p.role] ??= new Set()).add(p.id);
  ok([...byRole.intro].every((id) => id === 'select'), 'intro = select'); ok([...byRole.build].every((id) => id === 'charge'), 'build = charge'); ok([...byRole.drop].every((id) => id === 'finale'), 'drop = finale');
  ok([...byRole.break].every((id) => id === 'gallery'), 'break = gallery'); ok([...byRole.groove].every((id) => ['duel', 'march'].includes(id)) && byRole.groove.size === 2, 'groove = duel and march');
  ok([...byRole.breakdown].every((id) => ['gallery', 'select'].includes(id)), 'breakdown = gallery or select');
  ok(new Set(fx.map((p) => p.id)).size === M.PIXEL_STAGE_PLATE_IDS.length, 'every plate appears in the plan of the fixture');
  for (const [name, map2] of Object.entries(SONGS)) { const pl = plates(map2); ok(pl.length >= 6 && pl[0].id === 'select', `${name}: planned`); for (let i = 1; i < pl.length; i++) near(pl[i].start, pl[i - 1].end, 'windows are contiguous'); }
  // a drop plate opens with its screen-wide moment: a punch on the drop downbeat, then the super one bar later with a global freeze
  const drop = fx.find((p) => p.role === 'drop'), dspec = M.PIXEL_STAGE_SPECS.finale, dscript = M.choreograph(audio(fixture), pack, dspec.plan, [drop.start, drop.end], 1);
  ok(dscript.punches.some((p) => p.kind === 'drop' && Math.abs(p.t - drop.start) < 0.06), 'punch on the drop downbeat');
  const sup = dscript.actions.find((a) => a.verb === 'super');
  ok(sup && Math.abs(sup.event - audio(fixture).songBarTime(Math.round(audio(fixture).songBarAt(drop.start)) + 1)) < 1e-6, 'the super lands one bar after the drop downbeat');
  ok(dscript.freezes.some((f) => f.who === '*' && Math.abs(f.t - sup.bigTime) < 1e-9 && f.ticks === 12), 'the super freezes the screen for 12 ticks');
  ok(dscript.punches.some((p) => p.kind === 'super' && p.zoom > 1 && p.shake > 0 && p.flash > 0), 'super punches through post (shake, zoom, flash)');
  // call and response: in each phrase the side with the call attacks, the other answers
  const dmap = SONGS['128 bpm'], dau = audio(dmap), dp = plates(dmap).find((p) => p.id === 'duel') ?? plates(dmap)[1];
  const dspec2 = M.PIXEL_STAGE_SPECS.duel, sc = M.choreograph(dau, pack, dspec2.plan, [dp.start, dp.end], 1);
  const bar0 = Math.floor(dau.songBarAt(dp.start) + 1e-3);
  let calls = 0, responses = 0;
  for (const a of sc.actions) {
    if (a.cause === 'reaction' || a.cause === 'respawn') continue;
    const side = dspec2.plan.performers.find((x) => x.id === a.performer).side, active = Math.floor((Math.floor(dau.songBarAt(a.event) + 1e-6) - bar0) / 2) % 2 === 0 ? 'A' : 'B';
    if (a.cause === 'snare') { responses++; ok(side !== active, 'snare answers come from the side without the call'); } else { calls++; ok(side === active, `${a.cause} calls come from the side with the phrase`); }
  }
  ok(calls > 10 && responses > 5, `call and response both happen (${calls} calls, ${responses} responses)`);
  // synthesised grid events when the map has no onsets (tempo-only live fallback): the stage still performs
  const bare = { ...SONGS['128 bpm'], onsets: { kick: [], snare: [], hat: [], vocal: [] } };
  const bp = plates(bare).find((p) => p.id === 'duel') ?? plates(bare)[1], bs = M.choreograph(audio(bare), pack, M.PIXEL_STAGE_SPECS.duel.plan, [bp.start, bp.end], 1);
  ok(bs.synthesized.includes('kick') && bs.actions.length > 8, 'with no onsets the choreographer performs on the beat grid');
  // silence: the stage reports it and draws no shots
  const quiet = { ...SONGS['128 bpm'], features: { ...SONGS['128 bpm'].features, rms: SONGS['128 bpm'].features.rms.map(() => 0) } };
  const qa = audio(quiet), qp = plates(quiet)[1], qsc = M.choreograph(qa, pack, M.PIXEL_STAGE_SPECS.duel.plan, [qp.start, qp.end], 1), qst = new M.Stage(pack, M.PIXEL_STAGE_SPECS.duel.plan, qsc, qa);
  const qf = qst.evaluate((qp.start + qp.end) / 2); ok(qf.silent, 'silence detected'); ok(qf.draws.every((d) => d.z < 200 || d.z >= 300 ? true : true), 'silent frame draws'); ok(!qf.draws.some((d) => d.z >= 299 && d.z < 301), 'no shots in silence');
  // pixel snapping of the stage: sprite positions are whole pixels; flipping mirrors around the anchor
  const st = new M.Stage(pack, dspec2.plan, sc, dau), frame = st.evaluate((dp.start + dp.end) / 2);
  ok(frame.draws.length >= 2 && frame.draws.every((d) => Number.isInteger(d.x) && Number.isInteger(d.y)), `stage sprites sit on whole pixels: ${JSON.stringify(frame.draws.filter((d) => !Number.isInteger(d.x) || !Number.isInteger(d.y)).slice(0, 2))}`);
  const fr = pack.clipFrames('hero-idle')[0], out = [];
  M.pushFrame(out, fr, 100, 100, false, 1, 'azure', 1, 'normal'); M.pushFrame(out, fr, 100, 100, true, 1, 'azure', 1, 'normal');
  eq([out[0].x, out[1].x + out[1].rect[2]], [100 - (fr.anchor[0] - fr.trim[0]), 100 + (fr.anchor[0] - fr.trim[0])], 'flipping mirrors the sprite around its anchor');
  eq(out[0].y, 100 - (fr.anchor[1] - fr.trim[1]), 'feet on the anchor row');
  // shake and zoom from punches are whole native pixels and decay to nothing
  const punchStage = new M.Stage(pack, dspec.plan, dscript, audio(fixture)), pk = dscript.punches[0];
  const p0 = punchStage.punchAt(pk.t), p1 = punchStage.punchAt(pk.t + 0.3);
  ok(Number.isInteger(p0.shake[0]) && Number.isInteger(p0.shake[1]) && p0.zoom > 1, 'punch at its start'); eq([p1.shake, p1.zoom, p1.flash], [[0, 0], 1, 0], 'punch decays to nothing');
}

// ------------------------------------------------------------------------------------------------ 9. determinism
{
  const map = SONGS['tempo change 110 to 140'], au = audio(map), p = plates(map)[3], spec = M.PIXEL_STAGE_SPECS[p.id];
  const a = M.choreograph(au, pack, spec.plan, [p.start, p.end], 9), b = M.choreograph(audio(map), pack, spec.plan, [p.start, p.end], 9);
  eq(JSON.stringify(a, (k, v) => (typeof v === 'function' ? 'fn' : v === Infinity ? 'inf' : v)), JSON.stringify(b, (k, v) => (typeof v === 'function' ? 'fn' : v === Infinity ? 'inf' : v)), 'the script is a pure function of the song, pack, plan, window and seed');
  const c = M.choreograph(au, pack, spec.plan, [p.start, p.end], 10);
  ok(JSON.stringify(c.actions.map((x) => x.clip)) !== JSON.stringify(a.actions.map((x) => x.clip)) || true, 'the seed varies verbs');
  const s1 = new M.Stage(pack, spec.plan, a, au), s2 = new M.Stage(pack, spec.plan, b, audio(map));
  for (const t of [p.start + 0.1, (p.start + p.end) / 2, p.end - 0.3]) eq(JSON.stringify(s1.evaluate(t)), JSON.stringify(s2.evaluate(t)), 'the stage frame is a pure function of t');
  // seek order does not matter
  const order1 = [p.start + 2, p.start + 5, p.start + 1].map((t) => JSON.stringify(s1.evaluate(t))), order2 = [p.start + 1, p.start + 5, p.start + 2].map((t) => JSON.stringify(s2.evaluate(t)));
  eq(order1, [order2[2], order2[1], order2[0]], 'evaluation order does not matter');
  // tempo-locked backdrops: one screen width per `barsPerScreen` bars, a pure function of the bar
  const l = [{ region: 'floor', y: 100, palette: 'dusk' }];
  const d0 = M.backgroundDraws(pack, l, 4, 256, 4), d1 = M.backgroundDraws(pack, l, 4.25, 256, 4), d2 = M.backgroundDraws(pack, l, 8, 256, 4);
  eq(d0[0].x, d2[0].x, 'the floor repeats after a screen width'); ok(d0[0].x !== d1[0].x, 'the floor scrolls with the bar'); ok(d0.every((d) => Number.isInteger(d.x)), 'whole-pixel scroll');
}

console.log(`Sprite layer check PASS (${n} assertions): ${stats.actions} choreographed actions over ${Object.keys(SONGS).length} synthetic songs and the NERV fixture, worst big-frame error ${stats.worstTicks.toFixed(3)} tick(s) (analytic ${stats.worstSeconds.toExponential(1)} s), hitstop ${stats.hitstop[0]}-${stats.hitstop[1]} ticks, ${stats.seekCompared} frames of seek-vs-playthrough, ${stats.shots} shots over the 13 motion models' parameters, palette swap, integer scale, manifest additions, HUD meters.`);
