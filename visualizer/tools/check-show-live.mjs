// CPU checks for the show engine's live fallback (src/show/live.ts, AAAVS): the tempo-only grid and neutral
// arrangement, the director on it, analysis from AVS audio frames (made by the real AvsAudioAnalyser from synthetic
// PCM: kicks on the beat, hats on the off-beat, a bass note), determinism, seeks, capacity, the dirty ranges the GPU
// copies read, and validation of the worker's live messages.
//
//   node tools/check-show-live.mjs
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const VIS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  stdin: {
    contents: `export { LiveAudioData, liveSongMap, isLive, LIVE_WAVE_RATE } from './src/show/live.ts';
      export { planShow } from './src/show/plan.ts';
      export { NERV_SHOW } from './src/shows/nerv/show-def.ts';
      export { AvsAudioAnalyser } from './src/avs/audio.ts';
      export { validateShowRequest } from './src/show/protocol.ts';`,
    resolveDir: VIS, loader: 'ts',
  },
  bundle: true, format: 'esm', write: false, logLevel: 'error',
});
const { LiveAudioData, liveSongMap, isLive, LIVE_WAVE_RATE, planShow, NERV_SHOW, AvsAudioAnalyser, validateShowRequest } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

let n = 0;
const ok = (c, msg) => { n++; assert.ok(c, msg); };
const eq = (a, b, msg) => { n++; assert.deepEqual(a, b, msg); };
const near = (a, b, eps, msg) => { n++; assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`); };

// ------------------------------------------------------------------ tempo grid + arrangement
{
  const m = liveSongMap({ duration: 60, bpm: 128, firstBeat: 0.3 });
  const p = 60 / 128;
  near(m.beats[0], 0.3 % p, 1e-6, 'grid: first beat is the phase of firstBeat');
  for (let i = 1; i < m.beats.length; i++) near(m.beats[i] - m.beats[i - 1], p, 1e-5, `grid: beat ${i} spacing`);
  ok(m.beats[m.beats.length - 1] < 60 && m.beats[m.beats.length - 1] + p >= 60 - 1e-6, 'grid: beats cover the media');
  eq(m.downbeats, m.beats.filter((_, i) => i % 4 === 0), 'grid: a downbeat every 4 beats');
  eq(m.sections.map((s) => s.role), ['intro', 'groove', 'outro'], 'arrangement: intro, groove, outro');
  near(m.sections[1].start, m.downbeats[4], 1e-9, 'arrangement: intro is 4 bars');
  near(m.sections[2].start, m.downbeats[m.downbeats.length - 4], 1e-9, 'arrangement: outro is the last 4 bars');
  eq(m.confidence, { tempo: 0.5, downbeat: 0, sections: 0 }, 'confidences are honest');
  ok(['tempo-grid', 'sections', 'bass_midi'].every((k) => m.approximations.includes(k)), 'approximations are listed');
  near(liveSongMap({ duration: 60, bpm: 128, firstBeat: -0.2 }).beats[0], p - 0.2, 1e-6, 'grid: negative phase wraps');
  eq(liveSongMap({ duration: 10, bpm: 100 }).sections.map((s) => s.role), ['groove'], 'arrangement: short media is one groove');
  const plan = planShow(m, NERV_SHOW);
  eq(plan[0].id, 'boot', 'director on the live map: boot opens');
  eq(plan[plan.length - 1].id, 'end', 'director on the live map: end closes');
  near(plan[plan.length - 1].end, 60, 1e-9, 'director on the live map: covers the media');
}

// ------------------------------------------------------------------ analysis from AVS frames
const SR = 44100, BPM = 120, DUR = 8, FPS = 60;
function pcm(dur) {
  const L = new Float32Array(Math.ceil(dur * SR)), R = new Float32Array(L.length);
  const beat = 60 / BPM;
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  for (let i = 0; i < L.length; i++) {
    const t = i / SR, kb = t % beat, hb = (t + beat / 2) % beat;
    const kick = kb < 0.12 ? Math.sin(2 * Math.PI * (50 + 60 * Math.exp(-kb * 30)) * kb) * Math.exp(-kb * 22) * 0.9 : 0;
    const hat = hb < 0.03 ? rnd() * Math.exp(-hb * 120) * 0.35 : 0;
    const bass = Math.sin(2 * Math.PI * 55 * t) * 0.08;
    L[i] = kick + hat + bass; R[i] = kick + hat * 0.8 + bass;
  }
  return { L, R };
}
function frames(dur, t0 = 0) {
  const { L, R } = pcm(dur + 1);
  const an = new AvsAudioAnalyser();
  const out = [];
  for (let k = Math.ceil(t0 * FPS); k / FPS <= dur; k++) {
    const t = k / FPS, end = Math.floor(t * SR);
    if (end < 576) continue;
    out.push([t, an.analyse({ left: L.subarray(end - 576, end), right: R.subarray(end - 576, end) })]);
  }
  return out;
}
const F = frames(DUR);
const live = new LiveAudioData({ duration: 30, bpm: BPM });
ok(isLive(live), 'isLive');
eq(live.waveRate, LIVE_WAVE_RATE, 'live wave rate');
for (const [t, f] of F) live.push(t, f);
ok(live.revision === F.length, 'every push counts as a revision');

const kicks = live.onsets.kick, beat = 60 / BPM;
ok(kicks.length >= DUR / beat - 3 && kicks.length <= DUR / beat + 2, `kick onsets from the AVS beat detector: ${kicks.length} for ${DUR / beat} kicks`);
for (const [t] of kicks) {
  const d = Math.min(t % beat, beat - (t % beat));
  ok(d < 0.06, `kick onset at ${t.toFixed(3)} is within 60 ms of a kick`);
}
ok(live.onsets.hat.length >= 4, `hat onsets detected: ${live.onsets.hat.length}`);
for (const k of ['kick', 'snare', 'hat']) {
  const l = live.onsets[k];
  for (let i = 1; i < l.length; i++) ok(l[i][0] > l[i - 1][0], `${k} onsets are sorted`);
  for (const [, s] of l) ok(s >= 0 && s <= 1, `${k} strength in 0..1`);
}
// envelopes: low band is higher on the kick than between kicks (after the adaptive normaliser settles)
let on = 0, off = 0;
for (let b = 4; b < DUR / beat - 1; b++) { on += live.env('low', b * beat + 0.03); off += live.env('low', b * beat + 0.3); }
ok(on > off * 1.3, `low envelope rises on kicks (${on.toFixed(2)} vs ${off.toFixed(2)})`);
ok(live.hit('kick', kicks[3][0] + 0.01) > 0.3 * kicks[3][1], 'hit() decays from a live kick');
// spectrum: low mel bands carry more energy than the top ones on a kick; chroma is 0..1 with a max of 1
const mf = live.melFrame(4 * beat + 0.03);
const lowMel = (mf[0] + mf[1] + mf[2] + mf[3] + mf[4] + mf[5]) / 6, topMel = (mf[58] + mf[59] + mf[60] + mf[61] + mf[62] + mf[63]) / 6;
ok(lowMel > topMel, `mel: low bands (${lowMel.toFixed(2)}) above top bands (${topMel.toFixed(2)}) on a kick`);
const ch = live.chroma(4 * beat + 0.2);
ok(Math.max(...ch) > 0.99 && Math.min(...ch) >= 0, 'chroma normalised per frame');
// waveform: written where frames were pushed, silent in the future
let energy = 0;
for (let t = 2; t < 3; t += 1 / 500) energy += Math.abs(live.waveAt(t)[0]);
ok(energy > 5, `waveform written (${energy.toFixed(1)})`);
eq(live.waveAt(20), [0, 0], 'waveform in the future is silence');
eq(live.env('rms', 20), 0, 'envelopes in the future are zero');
eq(live.bassMidi(3), 0, 'bass pitch is unknown live');

// determinism: the same pushes give the same analysis
{
  const b = new LiveAudioData({ duration: 30, bpm: BPM });
  for (const [t, f] of F) b.push(t, f);
  eq(Array.from(b.spec.subarray(0, 900 * 76)), Array.from(live.spec.subarray(0, 900 * 76)), 'determinism: spectrogram');
  eq(b.onsets, live.onsets, 'determinism: onsets');
  eq(Array.from(b.wave.subarray(0, 60000)), Array.from(live.wave.subarray(0, 60000)), 'determinism: waveform');
}

// dirty ranges for the GPU copies
{
  const a = new LiveAudioData({ duration: 30, bpm: BPM });
  eq(a.takeDirty(), null, 'nothing dirty before a push');
  a.push(F[100][0], F[100][1]);
  const d = a.takeDirty();
  eq([d.f0, d.f1], [Math.round(F[100][0] * 100), Math.round(F[100][0] * 100)], 'dirty frames of one push');
  ok(d.w1 >= d.w0 && d.w1 <= Math.floor(F[100][0] * LIVE_WAVE_RATE) && d.w0 >= Math.ceil((F[100][0] - 576 / SR) * LIVE_WAVE_RATE), 'dirty wave samples cover the frame window');
  eq(a.takeDirty(), null, 'takeDirty clears');
  a.push(F[101][0], F[101][1]); a.push(F[102][0], F[102][1]);
  const d2 = a.takeDirty();
  ok(d2.f0 === Math.round(F[100][0] * 100) + 1 && d2.f1 === Math.round(F[102][0] * 100), 'consecutive pushes fill the gap frames and merge their dirty ranges');
}

// seek back: onsets after the new time are dropped, later pushes rebuild them
{
  const a = new LiveAudioData({ duration: 30, bpm: BPM });
  for (const [t, f] of F) a.push(t, f);
  const before = a.onsets.kick.filter(([t]) => t < 3).length;
  const [t3, f3] = F.find(([t]) => t >= 3);
  a.push(t3, f3);
  ok(a.onsets.kick.every(([t]) => t <= t3), 'seek back drops onsets after the new time');
  eq(a.onsets.kick.filter(([t]) => t < 3).length, before, 'seek back keeps earlier onsets');
}

// capacity: pushes past maxSeconds are ignored
{
  const a = new LiveAudioData({ duration: 600, bpm: BPM, maxSeconds: 5 });
  eq(a.capacityFrames, 501, 'capacity frames for maxSeconds');
  a.push(6, F[50][1]);
  eq(a.revision, 0, 'a push past capacity is ignored');
  a.push(-1, F[50][1]); a.push(NaN, F[50][1]);
  eq(a.revision, 0, 'invalid times are ignored');
}

// origin: a window starting at 100 s reads the same analysis at media time 100 + x as a window at 0 reads at x
{
  const w = new LiveAudioData({ duration: 400, bpm: BPM, origin: 100, maxSeconds: 30 });
  eq(w.origin, 100, 'origin window');
  eq(w.capacityFrames, 3001, 'origin window capacity');
  for (const [t, f] of F) w.push(t + 100, f);
  eq(w.onsets.kick.map(([t, s]) => [+(t - 100).toFixed(9), s]), live.onsets.kick.map(([t, s]) => [+t.toFixed(9), s]), 'origin: onsets are absolute media times');
  for (const x of [0.5, 2.03, 4.51, 7.2]) {
    near(w.env('low', 100 + x), live.env('low', x), 1e-6, `origin: env at ${x}`);
    near(w.mel(100 + x, 3), live.mel(x, 3), 1e-6, `origin: mel at ${x}`);
    near(w.waveAt(100 + x)[0], live.waveAt(x)[0], 1e-6, `origin: waveAt at ${x}`);
  }
  const before = w.revision;
  w.push(99, F[10][1]);
  eq(w.revision, before, 'a push before the origin is ignored');
}

// ------------------------------------------------------------------ worker messages
const buf = (len) => new ArrayBuffer(len);
const audioMsg = (o = {}) => ({ type: 'show-audio', generation: 1, time: 1.5, waveform: buf(1152), spectrum: buf(1152), beat: false, beatLevel: 0, ...o });
eq(validateShowRequest(audioMsg()).type, 'show-audio', 'show-audio accepted');
for (const [bad, why] of [[{ waveform: buf(1151) }, 'short waveform'], [{ spectrum: new Uint8Array(1152) }, 'typed array instead of ArrayBuffer'], [{ time: -1 }, 'negative time'], [{ time: NaN }, 'NaN time'], [{ beat: 1 }, 'non-boolean beat'], [{ beatLevel: -3 }, 'negative beat level']]) {
  n++; assert.throws(() => validateShowRequest(audioMsg(bad)), undefined, `show-audio rejects ${why}`);
}
const initLive = (o = {}) => ({ type: 'show-init', generation: 0, assetBase: '/', songMap: null, duration: 180, bpm: 128, ...o });
eq(validateShowRequest(initLive({ firstBeat: 0.4, sampleRate: 48000 })).type, 'show-init', 'live show-init accepted');
for (const [bad, why] of [[{ bpm: 10 }, 'tempo too low'], [{ duration: 0 }, 'zero duration'], [{ firstBeat: Infinity }, 'infinite phase'], [{ sampleRate: 1000 }, 'implausible PCM rate']]) {
  n++; assert.throws(() => validateShowRequest(initLive(bad)), undefined, `live show-init rejects ${why}`);
}

console.log(`Show live fallback CPU checks PASS (${n} assertions): tempo grid and arrangement, director on it, kick/hat onsets, envelopes, mel, chroma and waveform from real AVS frames, determinism, dirty ranges, seeks, capacity and live message validation.`);
