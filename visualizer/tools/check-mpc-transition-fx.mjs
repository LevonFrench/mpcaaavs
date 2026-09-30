import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as R from './mpc-transition-fx-raster.mjs';
import { HEADER_PATH, loadMeta, renderHeader } from './gen-transition-names.mjs';

// Transition styles 16-32 (docs/design/TRANSITIONS-V2.md 9.2, CONTRACT 2.3.3 and 3.6). CPU only: the real TypeScript is bundled with esbuild and drawn
// onto scalar/RGB raster doubles (tools/mpc-transition-fx-raster.mjs); no browser, Canvas, GPU or media is used, so nothing here says how a style
// LOOKS. Status: CPU-checked geometry, endpoints, monotonicity, determinism, cost bounds, photosensitivity rules S1-S7 and the generated native names.
//   1 table   2 classic output unchanged   3 endpoints   4 monotonicity   5 determinism and statelessness   6 bounds and cost   7 limiter sweep
//   8 selectors   9 generated header   10 helpers, env and malformed input   11 reduced motion and smoothing   12 source hygiene
//   13 resolution scaling of hairlines, seeded fuzz, odd seeds, extreme geometry, parameter-table cache
// Host wiring (seed, context, env, wire fields, reduced motion source) is pinned separately by tools/check-host-transitions.mjs.
async function load(path) {
  const result = await build({ entryPoints: [path], bundle: true, format: 'esm', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const T = await load('src/mpc-transition.ts'), FX = await load('src/mpc-transition-fx.ts'), C = await load('src/mpc-contract.ts'), L = await load('src/flash-limiter.ts');
const { AvsTransition, TRANSITION_META, TRANSITIONS, TRANSITION_COUNT, TRANSITION_CUT, defaultTransitionEnv, normalizeEnv, normalizeContext, resolveTransitionMode, subSeed, hash32, stepQ, ticks, transitionUnit, transitionLevel, bands16, blockOrder } = T;
const started = performance.now();
let lapAt = started;
const lap = name => { if (process.env.AAAVS_CHECK_TIMING) { const now = performance.now(); console.log(`  [timing] ${name}: ${((now - lapAt) / 1000).toFixed(1)} s`); lapAt = now; } };
const isPlainNumber = v => typeof v === 'number' && Number.isFinite(v);

// Captured ONCE from the unmodified classic module (mpc-transition.ts as committed before TRX Wave 1: constructor, blockOrder and draw) and embedded here.
// This is a new fixture for the transition module, not a re-record of any AVS golden hash. LEGACY_RANDOM_MODES: one hex digit per seed 0..255 (the style the
// classic Random resolved to); LEGACY_RANDOM_ORDERS: the 9-digit block order per seed; LEGACY_OP_HASHES: FNV-1a of the full recorded operation streams of
// each classic style (see section 2 below for the surfaces and times) and of Random over 32 seeds.
const LEGACY_RANDOM_MODES='76b49de8821988e1342867bcd5c7e4dcbc3db9ee21dd98b1b1ddc8e8c7cec6cad88abc95cec151741452a9b84dc68d7b2366447b391326c3ac9c7a58c24b2c58b59218de16bc2ab5b79a3372ec87c7358d137614396d4b68218b7ec1b99d6be4c5bdb41dd84e76773b6b175be442db13b9d3b4111157222bd7ba812441917ab5';
const LEGACY_RANDOM_ORDERS=[
 '536487102726148305508743126254187306345760128745203186653721804573124680307864251587234061350126874510263784318675402173486025685102734407516832346072815274850316506271843876154320758021436604752183024386715326751480143560872238017465716280354528641703208614753603457281842501367437120586',
 '480725163617320854481372065823716540526340178315268074273154086175248360278314065502163847716204835164750328265834017438162570286514370718426305685320147871620543168357204653487201867524301314275860034716852231507864607428531578423016723160854687250143068453712231708654435802716845367102',
 '502861437752816430657324801504612738481765023803164527510348726573028416432650781523041876402873651543817602036281754615872403160583724163842570621430857516403827504127386870153426271053684208671534361824570541687230834016257372504618486532710874312605715208643510876432728543601406317285',
 '726534180260473815831657204185704362680475321054287361013278546834615072364021578057834621673284051750163428608174523357210468302784561571342068467201385841072356017624583530481672316054278078431652137465820406318257567241308243861570204187536042658317054183726524160387538710264408153672',
 '681472503480576321836520471425386071021576483301246875126304785684302751610742853431578026708243561706831524640385712025643817621087345510468237365178240071326845637245180856042713632150874081726534730514826306548712537860214514738260253860174278504613823107654304186572621743580856743012',
 '037245618078463512345602187578103264106453872612487035215487306263504178860523741831567402067235148286173045364172580265384170320641785643180275746238150760284315143075628302816475051726348257108643621753408852163740245830761842603517481720635861430527810672435835741620761502384784126350',
 '178265430817325406134806527860135247287014536731046582276531048032561748708156342671405283503462871518430726064781235054186372028431675268304571831076452423680571754632018654078321182056374874106352183705642187305462745680321804562731187643250574106283528614370682410735758320641072418365',
 '460275831528614730672803145201843765601345278135086274476831502650724318526340718314706582820765143105728643087652431308614725502164387481657320370815264643870521132850746743501682602841537024856137137204856387162450246307158163057824830427516684105372031728546146052783706241358458610273',
].join('');
const LEGACY_OP_HASHES={"0":1913318729,"1":405296855,"2":3830126102,"3":379766842,"4":2486609827,"5":3984916557,"6":1676178406,"7":3901939035,"8":2123187850,"9":3459796389,"10":575991412,"11":2130727299,"12":1352022695,"13":2292353464,"14":1812754410,"15":3782928021};
// hash32 / subSeed pins: changing them silently reshuffles the style of every stored boundary.
const PINNED_HASHES=[3692283234,1905500794,1139902092,2747794150,3770057853];

// ---- helpers -----------------------------------------------------------------------------------------------------------------------------------
const pairCache = new Map();
/** Id sources: old pixel i is ID_OLD + i, next pixel i is ID_NEXT + i, so any output pixel names the source it was sampled from. */
function idPair(w, h) {
  const key = `${w}x${h}`;
  if (!pairCache.has(key)) pairCache.set(key, { old: R.idSource(w, h, R.ID_OLD, 'old'), next: R.idSource(w, h, R.ID_NEXT, 'next') });
  return pairCache.get(key);
}
const make = (mode, seed = 1, options = {}) => new AvsTransition(mode, { seed, createCanvas: R.rasterCanvasFactory(1), ...options });
/** One frame on a fresh id surface (so uncovered pixels show as holes). Returns the surface, the recording context and the transition. */
function idFrame(tr, w, h, t, env) {
  const { old, next } = idPair(w, h), out = new R.Surface(w, h, 1), ctx = new R.RecordingContext(out, out.getContext());
  tr.draw(ctx, old, next, t, w, h, env);
  return { out, ctx };
}
const envFor = (beats, extra = {}) => ({ bpm: 120, beatsTotal: beats, beatPhase: .3, barPhase: .6, level: .5, accent: 1, reducedMotion: false, ...extra });
const tally = classes => { const n = [0, 0, 0, 0, 0]; for (const c of classes) n[c]++; return { hole: n[0], old: n[1], next: n[2], mixed: n[3], deco: n[4], total: classes.length }; };
const sameData = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
const fract = v => v - Math.floor(v);
const seedList = n => Array.from({ length: n }, (_, i) => hash32(i, 12345));
const FX_MODES = Array.from({ length: 15 }, (_, i) => 16 + i);
const CLASSIC_NAMES = ['Random · classic', 'Cross dissolve', 'L/R Push', 'R/L Push', 'T/B Push', 'B/T Push', '9 Random Blocks', 'Split L/R Push', 'L/R to Center Push', 'L/R to Center Squeeze', 'L/R Wipe', 'R/L Wipe', 'T/B Wipe', 'B/T Wipe', 'Dot Dissolve', 'Cut'];
const NEW_NAMES = ['Beat Step Wipe', 'Hazard Stripe Wipe', 'MAGI Hex Reveal', 'AT Field Iris', 'Radar Sweep', 'Venetian Blinds', 'CRT Off', 'CRT On', 'Glitch Stutter', 'Datamosh Smear', 'Tile Flip', 'Countdown Iris', 'Kick-Punch Zoom', 'Mosaic Drop', 'Spectrum Bars Wipe', 'Random · all styles', 'Smart random'];
const QUANTISED = new Set([16, 18, 25, 29]);   // stepped effects that are completely resolved on the last step
const REVEAL = new Set([16, 17, 18, 19, 20, 21, 25, 30]);   // S1: each pixel changes source at most once
const SHAPED = new Set([22, 23, 24, 26, 27, 28, 29]);       // at most two changes (26: old, ink, new)

lap('before section 1');
// ---- 1. table ----------------------------------------------------------------------------------------------------------------------------------
{
  assert.equal(TRANSITION_COUNT, C.TRANSITION_COUNT); assert.equal(TRANSITION_CUT, C.TRANSITION_CUT); assert.equal(TRANSITION_COUNT, 33); assert.equal(TRANSITION_CUT, 15);
  assert.equal(TRANSITION_META.length, TRANSITION_COUNT); assert.equal(TRANSITIONS.length, TRANSITION_COUNT); assert.ok(Object.isFrozen(TRANSITION_META));
  assert.deepEqual(TRANSITIONS, TRANSITION_META.map(m => m.name)); assert.equal(new Set(TRANSITIONS).size, TRANSITION_COUNT, 'names are unique');
  assert.deepEqual(TRANSITIONS.slice(0, 16), CLASSIC_NAMES, 'the classic names, index 0 renamed (Q13)'); assert.deepEqual(TRANSITIONS.slice(16), NEW_NAMES);
  assert.ok(TRANSITIONS.every(n => n.length > 0 && n === n.trim() && /^[\x20-\x7e·]+$/.test(n)), 'names are printable ASCII plus the middle dot');
  assert.equal(TRANSITIONS.filter(n => n.includes('·')).length, 2);
  TRANSITION_META.forEach((m, i) => {
    assert.equal(m.kind, i === 0 || i >= 31 ? 'selector' : i <= 15 ? 'classic' : 'fx', `kind of ${i}`);
    assert.ok(m.minBeats >= 0 && m.minBeats <= m.maxBeats && m.maxBeats <= 64, `beat range of ${i}`);
    assert.ok(['calm', 'nerv', 'dramatic'].every(k => typeof m[k] === 'boolean') && typeof m.family === 'string' && m.family);
    for (const k of ['draw', 'clip', 'fill', 'text']) assert.ok(Number.isInteger(m.cost[k]) && m.cost[k] >= 0, `cost.${k} of ${i}`);
    if (m.kind === 'fx') assert.ok(m.cost.draw <= 48 && m.cost.clip <= 3 && m.cost.fill <= 48 && m.cost.text <= 2, `hard caps of ${i}`);   // the classic nine-block style clips nine times by design
    if (m.hit) for (let beats = m.minBeats || .5; beats <= m.maxBeats; beats *= 1.5) { const hit = m.hit(beats); assert.ok(isPlainNumber(hit) && hit > 0 && hit <= 1, `hit of ${i} at ${beats} beats`); }
  });
  // The design table (TRANSITIONS-V2.md 4.1): family, minimum length, calm, NERV-flavoured, dramatic.
  const table = { 16: ['tick', .5, 1, 0, 0], 17: ['wipe', .5, 1, 1, 0], 18: ['reveal', 1, 1, 1, 1], 19: ['reveal', .5, 1, 1, 1], 20: ['reveal', 1, 1, 1, 1], 21: ['reveal', .5, 1, 0, 0], 22: ['reveal', .5, 1, 1, 0], 23: ['reveal', .5, 1, 1, 0],
    24: ['glitch', 1, 0, 0, 0], 25: ['glitch', 1, 0, 0, 0], 26: ['tick', 1, 0, 0, 0], 27: ['build', 2, 0, 1, 1], 28: ['tick', .5, 0, 0, 0], 29: ['build', 4, 0, 0, 1], 30: ['reveal', .5, 1, 0, 0] };
  for (const [i, [family, min, calm, nerv, dramatic]] of Object.entries(table)) {
    const m = TRANSITION_META[i];
    assert.deepEqual([m.family, m.minBeats, +m.calm, +m.nerv, +m.dramatic], [family, min, calm, nerv, dramatic], `meta of ${i} ${m.name}`);
  }
  assert.equal(TRANSITION_META[27].maxBeats, 9); assert.equal(TRANSITION_META[27].hit(4), 1); assert.equal(TRANSITION_META[28].hit(4), .5);
  assert.equal(TRANSITION_META[29].hit(4), .75); assert.equal(TRANSITION_META[29].hit(64), .9); assert.equal(TRANSITION_META[29].hit(1), .5);
  assert.deepEqual(TRANSITION_META.flatMap((m, i) => m.hit ? [i] : []), [27, 28, 29]);
  for (let i = 1; i <= 15; i++) assert.ok(TRANSITION_META[i].calm && !TRANSITION_META[i].hit, `classic ${i} is calm and has no hit point`);
  assert.equal(TRANSITION_META[15].family, 'cut');
  assert.equal(FX.FX_FIRST, 16); assert.equal(FX.FX_LAST, 30);
}

lap('before section 2');
// ---- 2. classic output unchanged (fixture captured from the unmodified constructor and draw before the change; not a golden re-record) ------------
{
  const legacyModes = [...LEGACY_RANDOM_MODES].map(c => parseInt(c, 16)), legacyOrders = Array.from({ length: 256 }, (_, i) => LEGACY_RANDOM_ORDERS.slice(i * 9, i * 9 + 9));
  assert.equal(legacyModes.length, 256); assert.equal(legacyOrders.length, 256); assert.ok(legacyOrders.every(o => new Set(o).size === 9));
  const plainCanvas = () => ({ width: 0, height: 0, getContext: () => ({}) });
  for (let seed = 0; seed < 256; seed++) {
    const a = new AvsTransition(0, { seed, createCanvas: plainCanvas }), b = new AvsTransition(0, { seed, createCanvas: plainCanvas, context: { beatsTotal: 1, boundary: 3, nervPair: true, reducedMotion: true } });
    assert.equal(a.mode, legacyModes[seed], `classic Random, seed ${seed}`); assert.equal(a.order.join(''), legacyOrders[seed], `block order, seed ${seed}`);
    assert.equal(b.mode, legacyModes[seed], 'classic Random ignores the selector context'); assert.equal(a.requested, 0);
    assert.equal(resolveTransitionMode(0, seed, { beatsTotal: 4, boundary: 0, nervPair: false, reducedMotion: false }), legacyModes[seed], 'the pure resolver reproduces the constructor');
    for (const mode of [6, 16, 24, 31]) assert.equal(new AvsTransition(mode, { seed, createCanvas: plainCanvas }).order.join(''), legacyOrders[seed], `the block-order stream does not depend on the mode (${mode})`);
  }
  assert.equal(new Set(legacyModes).size, 14, 'classic Random reaches every animated style and never Cut');
  // Full recorded operation streams of the main context for modes 0-15 at three surfaces, hashed exactly as they were before the change.
  const fmt = v => typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(6) : String(v)) : v && v.tag ? v.tag : typeof v === 'string' ? v : typeof v;
  const recorder = log => { const props = { globalAlpha: 1, imageSmoothingEnabled: true };
    return new Proxy({}, { get(_, k) { if (k in props) return props[k]; return (...a) => { log.push(`${String(k)}(${a.map(fmt).join(',')})`); return k === 'createPattern' ? { tag: 'pattern' } : undefined; }; },
      set(_, k, v) { props[k] = v; log.push(`=${String(k)}:${fmt(v)}`); return true; } }); };
  const fnv = text => { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };
  const canvases = () => { let n = 0; return () => ({ tag: n++ === 0 ? 'mask' : 'tile', width: 0, height: 0, getContext: () => recorder([]) }); };
  const stream = (mode, seed, w, h, t, env) => { const log = [], tr = new AvsTransition(mode, { seed, createCanvas: canvases() });
    tr.draw(recorder(log), { tag: 'old', width: w, height: h }, { tag: 'next', width: w, height: h }, t, w, h, env); return `${tr.mode}|${tr.order.join('')}|${log.join(';')}`; };
  const times = [0, .05, .2, .35, .5, .7, .9, .999, 1], sizes = [[640, 360], [1280, 720], [640, 640]];
  for (let mode = 1; mode <= 15; mode++) {
    let all = '';
    for (const [w, h] of sizes) for (const t of times) all += `${stream(mode, 4242, w, h, t)}\n`;
    assert.equal(fnv(all), LEGACY_OP_HASHES[mode], `classic style ${mode}: recorded operations changed`);
  }
  let zero = '';
  for (let seed = 0; seed < 32; seed++) for (const t of [.1, .5, .95]) zero += `${stream(0, seed, 640, 360, t)}\n`;
  assert.equal(fnv(zero), LEGACY_OP_HASHES[0], 'classic Random: recorded operations changed');
  // Classic styles never read env: a hostile env object passes through, and any env value gives the same operations.
  const hostile = new Proxy({}, { get() { throw Error('a classic style read env'); }, has() { throw Error('a classic style probed env'); }, ownKeys() { throw Error('a classic style enumerated env'); } });
  for (let mode = 1; mode <= 15; mode++) {
    assert.doesNotThrow(() => stream(mode, 9, 640, 360, .5, hostile), `style ${mode}`);
    for (const t of [.25, .75]) assert.equal(stream(mode, 9, 640, 360, t, envFor(2)), stream(mode, 9, 640, 360, t, envFor(64, { bpm: 300, level: 1, reducedMotion: true, accent: 0 })), `style ${mode} ignores env`);
  }
  // Under reduced motion the classic styles are untouched (Q15) even when the context says so.
  for (let mode = 1; mode <= 15; mode++) assert.equal(new AvsTransition(mode, { seed: 3, createCanvas: plainCanvas, context: { beatsTotal: 4, boundary: 0, nervPair: false, reducedMotion: true } }).mode, mode);
  // Classic endpoints on the CPU raster: the final frame is exactly `next`; the first frame is exactly `old` (style 6 shows one block at t = 0, as the original does).
  for (const [w, h] of [[12, 8], [13, 9], [64, 36]]) {
    const { old, next } = idPair(w, h);
    for (let mode = 1; mode <= 15; mode++) {
      const last = new R.Surface(w, h, 1); make(mode, 5).draw(last.getContext(), old, next, 1, w, h); assert.ok(sameData(last.data, next.data), `style ${mode} at t=1`);
      if (mode === 6 || mode === 14 || mode === 15) continue;
      const first = new R.Surface(w, h, 1); make(mode, 5).draw(first.getContext(), old, next, 0, w, h); assert.ok(sameData(first.data, old.data), `style ${mode} at t=0 ${w}x${h}`);
    }
  }
}

lap('before section 3');
// ---- 3. endpoints of styles 16-30 ---------------------------------------------------------------------------------------------------------------------
{
  const SIZES = [[12, 8], [13, 9], [256, 144], [640, 360]], SEEDS = [0, 1, 7, 0xdeadbeef], BEATS = [.5, 1, 2, 4, 8];
  let cases = 0;
  for (const mode of FX_MODES) for (const [w, h] of SIZES) {
    const heavy = w >= 640, { old, next } = idPair(w, h);
    for (const seed of heavy ? [1, 0xdeadbeef] : SEEDS) for (const beats of heavy ? [1, 4] : BEATS) {
      const tr = make(mode, seed), env = envFor(beats), where = `style ${mode} ${w}x${h} seed ${seed} beats ${beats}`;
      cases++;
      assert.ok(sameData(idFrame(tr, w, h, 0, env).out.data, old.data), `${where}: t=0 is exactly old`);
      assert.ok(sameData(idFrame(tr, w, h, -.5, env).out.data, old.data), `${where}: t<0 is exactly old`);
      assert.ok(sameData(idFrame(tr, w, h, 1, env).out.data, next.data), `${where}: t=1 is exactly next`);
      assert.ok(sameData(idFrame(tr, w, h, 7, env).out.data, next.data), `${where}: t>1 is exactly next`);
      const early = tally(idFrame(tr, w, h, 1e-9, env).out.classes(false)), late = tally(idFrame(tr, w, h, 1 - 1e-9, env).out.classes(false));
      assert.equal(early.hole, 0, `${where}: no uncovered pixel at t=1e-9`); assert.equal(late.hole, 0, `${where}: no uncovered pixel at t=1-1e-9`);
      assert.ok(early.old >= .98 * early.total, `${where}: at least 98% old at t=1e-9 (${early.old}/${early.total})`);
      assert.ok(late.next >= .98 * late.total, `${where}: at least 98% next at t=1-1e-9 (${late.next}/${late.total})`);
      if (QUANTISED.has(mode)) assert.equal(late.next, late.total, `${where}: the last step is a complete reveal`);
    }
  }
  assert.equal(cases, 15 * (3 * 4 * 5 + 2 * 2), `${cases} endpoint cases`);
  // The composite transition object also honours the NaN/Infinity policy for every style.
  for (const mode of FX_MODES) {
    const { old, next } = idPair(12, 8), tr = make(mode, 3);
    for (const [p, expected] of [[NaN, old], [-Infinity, old], [Infinity, next]]) { const out = new R.Surface(12, 8, 1); tr.draw(out.getContext(), old, next, p, 12, 8, envFor(4)); assert.ok(sameData(out.data, expected.data), `style ${mode}, progress ${p}`); }
  }
}

lap('before section 4');
// ---- 4. monotonicity (S1, S5) and coverage ---------------------------------------------------------------------------------------------------------
{
  const [w, h] = [80, 45];
  for (const mode of FX_MODES) for (const seed of [1, 0xdeadbeef]) for (const beats of [1, 4]) {
    const tr = make(mode, seed), env = envFor(beats, { beatPhase: 0, barPhase: 0, level: 0 }), n = w * h;
    const prevData = new Uint8Array(n), prevSeen = new Uint8Array(n), dataChanges = new Uint16Array(n), seenChanges = new Uint16Array(n);
    let lastNext = -1, where = `style ${mode} seed ${seed} beats ${beats}`;
    for (let k = 0; k <= 240; k++) {
      const { out } = idFrame(tr, w, h, k / 240, env), data = out.classes(false), seen = out.classes(true), counts = tally(data);
      assert.equal(counts.hole, 0, `${where}: every pixel is covered at step ${k}`);
      if (REVEAL.has(mode)) assert.ok(counts.next >= lastNext, `${where}: the revealed area never shrinks (step ${k})`);
      lastNext = counts.next;
      if (k) for (let i = 0; i < n; i++) { if (data[i] !== prevData[i]) dataChanges[i]++; if (seen[i] !== prevSeen[i]) seenChanges[i]++; }
      prevData.set(data); prevSeen.set(seen);
    }
    const most = Math.max(...dataChanges);
    assert.ok(most <= (REVEAL.has(mode) ? 1 : 2), `${where}: a pixel changes source ${most} times`);
    if (mode === 26) assert.ok(Math.max(...seenChanges) <= 2, `${where}: Tile Flip shows old, ink, new (one dark excursion, S5)`);
    assert.ok(REVEAL.has(mode) || SHAPED.has(mode));
  }
  // Stripe orientation (S2): while the Hazard band passes a fixed pixel the pixel keeps ONE colour (no strobing across stripes).
  const flat = rgb => R.colourSource(64, 36, () => rgb, 'flat'), grey = flat([128, 128, 128]);
  for (const seed of [0, 1, 2, 3, 4, 5, 6, 7]) for (const phase of [0, .3, .9]) {
    const tr = make(17, seed), history = Array.from({ length: 64 * 36 }, () => []);
    for (let k = 1; k < 240; k++) {
      const out = new R.Surface(64, 36, 3); tr.draw(out.getContext(), grey, grey, k / 240, 64, 36, envFor(4, { beatPhase: phase }));
      for (let i = 0; i < history.length; i++) { const v = `${Math.round(out.data[i * 3])},${Math.round(out.data[i * 3 + 1])},${Math.round(out.data[i * 3 + 2])}`; const list = history[i]; if (list.at(-1) !== v) list.push(v); }
    }
    for (const list of history) assert.ok(list.length <= 3, `Hazard Stripe Wipe seed ${seed}: a pixel saw ${list.length - 1} colour changes (${list.join(' > ')})`);   // grey, band colour, grey
  }
}

lap('before section 5');
// ---- 5. determinism and statelessness ---------------------------------------------------------------------------------------------------------------
{
  const [w, h] = [64, 36], signatures = (mode, seed, ts, env, order = ts.map((_, i) => i)) => {
    const tr = make(mode, seed), by = {};
    for (const i of order) by[i] = idFrame(tr, w, h, ts[i], env).ctx.signature();
    return ts.map((_, i) => by[i]);
  };
  const ts = [.03, .12, .25, .4, .5, .61, .77, .9, .98];
  for (const mode of FX_MODES) for (const seed of [0, 5, 0xdeadbeef]) for (const beats of [1, 4]) {
    const env = envFor(beats), inOrder = signatures(mode, seed, ts, env), again = signatures(mode, seed, ts, env);
    assert.deepEqual(again, inOrder, `style ${mode}: two instances give identical operations`);
    const shuffled = [...ts.keys()].sort((a, b) => hash32(a, seed, 9) - hash32(b, seed, 9)), reversed = [...ts.keys()].reverse();
    assert.deepEqual(signatures(mode, seed, ts, env, shuffled), inOrder, `style ${mode}: frames are independent of evaluation order`);
    assert.deepEqual(signatures(mode, seed, ts, env, reversed), inOrder, `style ${mode}: a seek back replays the same frames`);
    // A worker that rebuilds its transition (cache key change, restart) after a seek draws the very same frames: a fresh instance per frame equals the long-lived one.
    assert.deepEqual(ts.map(t => idFrame(make(mode, seed), w, h, t, env).ctx.signature()), inOrder, `style ${mode}: a fresh instance per frame replays the same frames`);
    const tr = make(mode, seed);   // one instance, revisiting a frame after others
    const first = idFrame(tr, w, h, .4, env).ctx.signature(); idFrame(tr, w, h, .9, env); idFrame(tr, w, h, .1, env);
    assert.equal(idFrame(tr, w, h, .4, env).ctx.signature(), first, `style ${mode}: revisiting a frame`);
  }
  // Decoration-only inputs never move the reveal (data plane), so a seek that changes level, band levels or beat phase cannot change the geometry.
  const geometryModes = FX_MODES.filter(m => m !== 28);
  for (const mode of geometryModes) for (const seed of [1, 7]) for (const t of [.1, .3, .5, .7, .9]) {
    const base = idFrame(make(mode, seed), 96, 54, t, envFor(4, { level: 0, beatPhase: 0, barPhase: 0 })).out.classes(false);
    for (const extra of [{ level: 1, beatPhase: .77, barPhase: .2 }, { level: .25, beatPhase: .5, barPhase: .99, accent: 0 }, { level: .5, bands: Array(16).fill(.9) }]) {
      if (mode === 30 && extra.bands) continue;   // Spectrum Bars Wipe reshapes the bar heights from live bands by design
      assert.ok(sameData(idFrame(make(mode, seed), 96, 54, t, envFor(4, extra)).out.classes(false), base), `style ${mode} t=${t}: decoration inputs moved the reveal`);
    }
  }
  // Kick-Punch: the punch is a bounded geometric bump; the coarse class map (old / blended / next) does not depend on the beat phase either.
  for (const t of [.1, .4, .5, .6, .9]) assert.ok(sameData(idFrame(make(28, 1), 64, 36, t, envFor(4, { beatPhase: 0 })).out.classes(false), idFrame(make(28, 1), 64, 36, t, envFor(4, { beatPhase: .9 })).out.classes(false)));
  // Seeds vary the seeded styles and leave the others alone.
  const distinct = mode => new Set(seedList(32).map(seed => idFrame(make(mode, seed), 64, 36, .5, envFor(4)).ctx.signature())).size;
  const expectedMin = { 16: 4, 17: 4, 18: 12, 19: 12, 20: 10, 21: 12, 24: 12, 25: 12, 26: 12, 30: 12 };
  for (const mode of FX_MODES) {
    if (expectedMin[mode]) assert.ok(distinct(mode) >= expectedMin[mode], `style ${mode}: ${distinct(mode)} distinct signatures over 32 seeds, expected at least ${expectedMin[mode]}`);
    else assert.equal(distinct(mode), 1, `style ${mode} does not depend on the seed`);
  }
  assert.equal(distinct(16), 4, 'Beat Step Wipe reaches all four directions'); assert.equal(distinct(17), 4, 'Hazard Stripe Wipe reaches all four bands');
  // Different tables for different styles even with one boundary seed (independent streams).
  assert.notEqual(subSeed(77, 0x100 + 18), subSeed(77, 0x100 + 21));
}

lap('before section 6');
// ---- 6. bounds and cost -------------------------------------------------------------------------------------------------------------------------------
{
  function recordOnly(mode, seed, w, h, t, env) {
    const counts = new R.Counts(), ctx = new R.RecordingContext({ width: w, height: h }, null, counts), scratches = [];
    const factory = R.recordingCanvasFactory(counts), tr = new AvsTransition(mode, { seed, createCanvas: () => { const c = factory(); scratches.push(c); return c; } });
    const old = R.namedSource('old', w, h), next = R.namedSource('next', w, h);
    tr.draw(ctx, old, next, t, w, h, env);
    for (const d of ctx.draws) if (d.src) { const s = d.source, [sx, sy, sw, sh] = d.src; assert.ok(sx >= -1e-6 && sy >= -1e-6 && sx + sw <= s.width + 1e-6 && sy + sh <= s.height + 1e-6, `9-argument source rectangle inside ${s.tag}`); }
    assert.equal(ctx.depth, 0, 'save/restore balanced');
    return { counts, ctx, tr, scratches };
  }
  const TS = Array.from({ length: 21 }, (_, i) => i / 20);
  const seenCost = {};
  for (const mode of FX_MODES) {
    const meta = TRANSITION_META[mode], peak = { draw: 0, clip: 0, fill: 0, text: 0 };
    for (const [w, h] of [[12, 8], [13, 9], [256, 144], [640, 360], [1920, 1080]]) for (const seed of [1, 7, 0xdeadbeef]) for (const beats of [.5, 2, 4, 9, 64]) for (const t of TS) {
      const { counts } = recordOnly(mode, seed, w, h, t, envFor(beats, { bpm: [60, 120, 400][seed % 3] }));
      for (const k of Object.keys(peak)) peak[k] = Math.max(peak[k], counts[k]);
      assert.ok(counts.draw <= 48 && counts.clip <= 3 && counts.fill <= 48 && counts.text <= 2, `style ${mode}: hard caps exceeded ${JSON.stringify(counts)} at ${w}x${h} t=${t}`);
      for (const k of Object.keys(peak)) assert.ok(counts[k] <= meta.cost[k], `style ${mode} ${meta.name}: ${k} ${counts[k]} exceeds the declared cost ${meta.cost[k]} at ${w}x${h} seed ${seed} beats ${beats} t=${t}`);
    }
    seenCost[mode] = peak;
  }
  // Totals do not depend on the resolution: the number of calls is a function of (mode, seed, env, t) and never of the pixel count. The only spread allowed is
  // that an element whose size rounds to zero pixels at a small frame is skipped (a one-pixel slat, a tile squeezed to nothing, a slice that does not move);
  // the declared cost caps above still hold at every size, so no count can scale with the resolution.
  const ROUNDING = { 21: 1, 23: 1, 24: 6, 26: 4, 29: 1 }, SIZES = [[256, 144], [640, 360], [1920, 1080], [3840, 2160]];
  for (const mode of FX_MODES) for (const seed of [1, 0xdeadbeef]) for (const beats of [1, 4, 8]) for (const t of TS) {
    const at = SIZES.map(([w, h]) => recordOnly(mode, seed, w, h, t, envFor(beats)).counts);
    for (const k of ['draw', 'clip', 'fill', 'text']) {
      const spread = Math.max(...at.map(c => c[k])) - Math.min(...at.map(c => c[k]));
      assert.ok(spread <= (ROUNDING[mode] ?? 0), `style ${mode} t=${t}: ${k} calls differ by ${spread} across resolutions (${at.map(c => c[k])})`);
    }
  }
  // Mosaic Drop resizes its scratch surface at most 12 times per transition, for any length.
  for (const beats of [1, 2, 4, 8, 16, 64]) for (const [w, h] of [[256, 144], [1920, 1080], [13, 9]]) {
    const counts = new R.Counts(), tr = new AvsTransition(29, { seed: 3, createCanvas: R.recordingCanvasFactory(counts) }), ctx = new R.RecordingContext({ width: w, height: h }, null, counts);
    for (let k = 1; k < 240; k++) tr.draw(ctx, R.namedSource('old', w, h), R.namedSource('next', w, h), k / 240, w, h, envFor(beats));
    assert.ok(tr.fx.scratchResizes <= 12, `Mosaic Drop resized its scratch ${tr.fx.scratchResizes} times (${beats} beats, ${w}x${h})`);
  }
  // Decoration area (S4) and bright decoration on the id raster at the classic composite size and at 1.5x: accent lines, rings and caps stay under 15% of the frame.
  // S4 bounds accent decoration (bands, rings, caps, numerals) at 15%. Tile Flip's dark backplate is not accent decoration: it is the single dark excursion
  // of S5 (one per pixel, asserted in section 4 through the seen-colour history) and reaches about 37% of the frame at the peak of the wave, so it gets its own bound.
  const AREA_CAP = { 26: .42 }, worst = {};
  for (const mode of FX_MODES) for (const [w, h] of [[640, 360], [960, 540]]) for (const seed of [1, 7]) for (const beats of [1, 4]) for (const t of [.05, .15, .3, .45, .6, .75, .9, .97]) {
    const { out } = idFrame(make(mode, seed), w, h, t, envFor(beats, { level: 1, beatPhase: 0 })), area = out.count(R.DECO.SHAPE | R.DECO.TEXT) / (w * h), bright = out.count(R.DECO.BRIGHT) / (w * h), text = out.count(R.DECO.TEXT) / (w * h);
    worst[mode] = Math.max(worst[mode] ?? 0, area);
    assert.ok(area <= (AREA_CAP[mode] ?? .15), `style ${mode}: decoration covers ${(area * 100).toFixed(1)}% at ${w}x${h} t=${t}`);
    assert.ok(bright <= .01, `style ${mode}: bright decoration covers ${(bright * 100).toFixed(2)}% at ${w}x${h} t=${t}`);
    assert.ok(text <= .03, `style ${mode}: numerals cover ${(text * 100).toFixed(2)}% at ${w}x${h} t=${t}`);
  }
  // The decoration that outlives the reveal fades out, so nothing pops when the caller switches to `next` at t = 1.
  for (const mode of FX_MODES) for (const [w, h] of [[640, 360]]) {
    const { out } = idFrame(make(mode, 7), w, h, 1 - 1e-9, envFor(4)), area = out.count(R.DECO.SHAPE | R.DECO.TEXT) / (w * h);
    assert.ok(area <= .005, `style ${mode}: ${(area * 100).toFixed(2)}% decoration remains at the last frame`);
  }
  globalThis.__trxWorst = worst;
}

lap('before section 7');
// ---- 7. limiter-clean sweep (S7) ---------------------------------------------------------------------------------------------------------------
{
  // Worst-case contrast frames through the real FlashLimiter. The limiter reads a 64x36 grid of cell luminances, so the bulk of the sweep runs on a 64x36 raster
  // (one pixel per cell; decoration is proportionally larger than in production, which is the conservative direction); a few sweeps repeat on 128x72.
  const scenes = (W, H) => {
    const flat = rgb => R.colourSource(W, H, () => rgb, 'flat'), stripes = invert => R.colourSource(W, H, x => (Math.floor(x / (W / 8)) % 2 === 0) !== invert ? [0, 0, 0] : [255, 255, 255], 'stripes');
    const out = new R.Surface(W, H, 3);
    return { W, H, out, ctx: out.getContext(), pairs: { 'black to white': [flat([0, 0, 0]), flat([255, 255, 255])], 'black to red': [flat([0, 0, 0]), flat([255, 0, 0])], 'white to black': [flat([255, 255, 255]), flat([0, 0, 0])], 'stripes to inverse': [stripes(false), stripes(true)] } };
  };
  const SMALL = scenes(64, 36), DENSE = scenes(128, 72), stats = L.createFrameStats(), strictNotes = new Map();
  let sweeps = 0, frames = 0;
  /** One transition played at `fps` (with a tenth of a second of lead-in and a third after it) through a fresh limiter. Returns true when the limiter engaged at any frame. */
  function sweep(scene, tr, { bpm, beats, fps, pair, label, expectClean = true, strictToo = false }) {
    const { W, H, out, ctx } = scene, [old, next] = scene.pairs[pair], seconds = beats * 60 / bpm, n = Math.max(2, Math.round(seconds * fps)), pre = Math.round(.1 * fps), post = Math.round(.3 * fps);
    const limit = new L.FlashLimiter('limit'), strict = strictToo ? new L.FlashLimiter('strict') : null;
    let engaged = false;
    sweeps++;
    for (let k = -pre; k <= n + post; k++) {
      const t = k <= 0 ? 0 : Math.min(1, k / n), elapsed = Math.max(0, k) / fps;
      tr.draw(ctx, old, next, t, W, H, { bpm, beatsTotal: beats, seconds, beatPhase: fract(elapsed * bpm / 60), barPhase: fract(elapsed * bpm / 240), level: .5, accent: 1, reducedMotion: false });
      L.computeFrameStatsRgba(out.rgba(), W, H, stats); frames++;
      const time = (k + pre) / fps, d = limit.evaluate(stats, time);
      if (d.limited || d.blend !== 1) engaged = true;
      if (expectClean) assert.ok(!engaged, `${label}: the limiter engaged (limit mode) at ${bpm} bpm, ${beats} beats, ${fps} fps, ${pair}, ${W}x${H}, frame ${k}`);
      if (strict && strict.evaluate(stats, time).limited) strictNotes.set(`${label}|${beats}|${bpm}`, label);
    }
    return engaged;
  }
  // Control: the harness must be able to see a violation. A full-frame black/white strobe at 30 Hz engages the limiter; a single hard cut and a slow dissolve do not.
  {
    const strobe = { draw: (ctx, old, next, t, w, h) => ctx.drawImage(Math.round(t * 60) % 2 ? next : old, 0, 0, w, h) };   // 2 beats at 120 bpm and 60 fps: 60 frames, alternating
    assert.equal(sweep(SMALL, strobe, { bpm: 120, beats: 2, fps: 60, pair: 'black to white', label: 'control strobe', expectClean: false }), true, 'the limiter engages on a 30 Hz full-frame strobe (the sweep can see violations)');
    assert.equal(sweep(SMALL, make(15, 1), { bpm: 120, beats: 2, fps: 60, pair: 'black to white', label: 'control cut' }), false, 'a single hard cut is not a flash');
    assert.equal(sweep(SMALL, make(1, 1), { bpm: 120, beats: 2, fps: 60, pair: 'black to white', label: 'control dissolve' }), false, 'a dissolve is not a flash');
  }
  for (const mode of FX_MODES) {
    const label = `style ${mode} ${TRANSITIONS[mode]}`, one = seed => make(mode, seed);
    // 60 fps: every tempo and length up to 4 beats (8 beats at the fastest tempo), both worst-case pairs; 'strict' is evaluated on the fastest tempo only (informational).
    for (const bpm of [90, 140, 200]) for (const beats of [1, 2, 4]) for (const pair of ['black to white', 'black to red']) sweep(SMALL, one(1), { bpm, beats, fps: 60, pair, label, strictToo: bpm === 200 });
    for (const pair of ['black to white', 'black to red']) sweep(SMALL, one(1), { bpm: 200, beats: 8, fps: 60, pair, label });
    // 240 fps: only the fast transitions, where a limiter sampling at a high display rate has the most to see.
    for (const beats of [1, 2]) for (const pair of ['black to white', 'black to red']) sweep(SMALL, one(1), { bpm: 200, beats, fps: 240, pair, label, strictToo: true });
    for (const pair of ['white to black', 'stripes to inverse']) {
      for (const [bpm, beats] of [[200, 1], [140, 2]]) for (const fps of [60, 240]) sweep(SMALL, one(7), { bpm, beats, fps, pair, label });
      sweep(SMALL, one(7), { bpm: 90, beats: 4, fps: 60, pair, label });
    }
    sweep(DENSE, one(1), { bpm: 200, beats: 1, fps: 60, pair: 'black to white', label }); sweep(DENSE, one(3), { bpm: 140, beats: 2, fps: 240, pair: 'black to red', label });
  }
  const list = [...strictNotes.values()];
  console.log(`limiter sweep (S7): ${sweeps} sweeps, ${frames} frames, 'limit' mode never engaged (a 30 Hz strobe control does); 'strict' would engage on ${strictNotes.size} mode/length/tempo combinations${list.length ? ` (${[...new Set(list)].join(', ')}) - informational, an owner decision` : ''}`);
  lap('section 7');
}

lap('before section 8');
// ---- 8. selectors (0, 31, 32) ---------------------------------------------------------------------------------------------------------------------
{
  const cx = (o = {}) => ({ beatsTotal: 4, boundary: 0, nervPair: false, reducedMotion: false, ...o });
  const pick = (mode, context, n = 2000) => seedList(n).map(seed => resolveTransitionMode(mode, seed, context));
  const fits = (i, beats) => { const m = TRANSITION_META[i]; return m.kind !== 'selector' && i !== TRANSITION_CUT && beats >= m.minBeats && beats <= m.maxBeats; };
  const nervShare = list => list.filter(i => TRANSITION_META[i].nerv).length / list.length;
  // Purity: identical (seed, context) always gives the same style, and the transition object agrees with the pure resolver.
  for (const mode of [0, 31, 32]) for (const seed of seedList(64)) for (const context of [cx(), cx({ boundary: 3, nervPair: true, beatsTotal: 8 }), cx({ reducedMotion: true })]) {
    const first = resolveTransitionMode(mode, seed, context);
    assert.equal(resolveTransitionMode(mode, seed, { ...context }), first, 'pure'); assert.ok(first >= 1 && first < TRANSITION_COUNT && first !== 0 && first < 31);
    const tr = make(mode, seed, { context }); assert.equal(tr.mode, first, 'AvsTransition resolves like the pure function'); assert.equal(tr.requested, mode);
    assert.equal(make(mode, seed, { context }).mode, tr.mode);
  }
  // 31: uniform over every style that fits the length; never 0, 15, 31 or 32.
  for (const beats of [.25, .5, 1, 1.5, 2, 4, 8, 9, 10, 64]) {
    const seen = new Set(pick(31, cx({ beatsTotal: beats }))), expected = new Set(TRANSITION_META.flatMap((_, i) => fits(i, beats) ? [i] : []));
    assert.deepEqual([...seen].sort((a, b) => a - b), [...expected].sort((a, b) => a - b), `mode 31 at ${beats} beats reaches exactly the fitting styles`);
    assert.ok(![0, 15, 31, 32].some(i => seen.has(i)));
  }
  assert.equal(new Set(pick(31, cx())).size, 29, 'a permissive length reaches all 29 concrete animated styles');
  // 32: fit, length, boundary, reduced-motion and pair rules.
  for (const beats of [.5, 1, 1.5, 2, 3, 4, 8, 12]) for (const boundary of [0, 1, 2, 3]) for (const nervPair of [false, true]) {
    const seen = new Set(pick(32, cx({ beatsTotal: beats, boundary, nervPair }), 1200));
    for (const i of seen) assert.ok(fits(i, beats), `smart random chose ${i} at ${beats} beats`);
    if (beats < 2) assert.ok(!seen.has(27), 'Countdown Iris needs two beats'); if (beats < 4) assert.ok(!seen.has(29), 'Mosaic Drop needs four beats');
    if (beats <= 1.5) assert.ok(!seen.has(27) && !seen.has(29), 'no build styles on very short fades');
    if (boundary === 0) for (const i of seen) assert.ok(!TRANSITION_META[i].hit, `boundary 0 never lands a hit style (${i})`);
  }
  assert.ok(new Set(pick(32, cx({ boundary: 3, beatsTotal: 8 }))).has(29), 'a section boundary can pick the drop');
  for (const mode of [31, 32]) for (const beats of [.5, 1, 4, 8]) for (const boundary of [0, 3]) for (const seed of seedList(300)) {
    const chosen = resolveTransitionMode(mode, seed, cx({ beatsTotal: beats, boundary, reducedMotion: true }));
    assert.ok(TRANSITION_META[chosen].calm, `reduced motion never picks a non-calm style (${chosen})`);
  }
  for (const beats of [1, 4]) for (const mode of [24, 25, 26, 27, 28, 29]) assert.equal(resolveTransitionMode(mode, 5, cx({ beatsTotal: beats, reducedMotion: true })), 1, `explicit ${mode} under reduced motion is Cross dissolve`);
  for (const mode of [1, 2, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 30]) assert.equal(resolveTransitionMode(mode, 5, cx({ reducedMotion: true })), mode);
  for (const mode of Array.from({ length: 31 }, (_, i) => i).slice(1)) if (mode < 24 || mode > 29) assert.equal(resolveTransitionMode(mode, 9, cx()), mode, 'concrete styles resolve to themselves');
  // NERV pairs raise the NERV-flavoured share (at least 60% at ordinary fade lengths; always clearly above the non-NERV share).
  for (const beats of [4, 8]) for (const boundary of [0, 1, 2, 3]) assert.ok(nervShare(pick(32, cx({ beatsTotal: beats, boundary, nervPair: true }))) >= .6, `NERV share at ${beats} beats, boundary ${boundary}`);
  for (const beats of [1, 2, 4, 8]) for (const boundary of [0, 1, 2, 3]) {
    const pair = nervShare(pick(32, cx({ beatsTotal: beats, boundary, nervPair: true }))), mixed = nervShare(pick(32, cx({ beatsTotal: beats, boundary, nervPair: false })));
    assert.ok(pair > mixed + .1, `nervPair raises the NERV share at ${beats} beats, boundary ${boundary}: ${pair.toFixed(2)} vs ${mixed.toFixed(2)}`);
  }
  assert.ok(pick(32, cx({ nervPair: false })).some(i => i >= 1 && i <= 14), 'classic styles stay available for non-NERV pairs');
  // Boundary strength favours the dramatic styles; the live energy bucket (AVS path) shifts the weights.
  const dramaticShare = list => list.filter(i => TRANSITION_META[i].dramatic).length / list.length;
  assert.ok(dramaticShare(pick(32, cx({ boundary: 3, beatsTotal: 8 }))) > dramaticShare(pick(32, cx({ boundary: 1, beatsTotal: 8 }))));
  const lively = list => list.filter(i => [16, 17, 24, 25, 26, 28].includes(i)).length / list.length;
  assert.ok(lively(pick(32, cx({ energy: 3, beatsTotal: 2, boundary: 1 }))) > lively(pick(32, cx({ energy: 0, beatsTotal: 2, boundary: 1 }))));
  assert.deepEqual(pick(32, cx({ beatsTotal: 4 }), 200), pick(32, cx({ beatsTotal: 4, energy: undefined }), 200), 'an absent energy bucket changes nothing (the clocked path replays)');
  // Invalid input never throws and resolves to Cross dissolve.
  for (const mode of [NaN, -1, 33, 100, 1.5, '2', null, undefined, Infinity]) { assert.equal(resolveTransitionMode(mode, 3, cx()), 1, `${String(mode)}`); assert.equal(make(mode, 3).mode, 1); }
  for (const bad of [{ beatsTotal: NaN }, { beatsTotal: -4 }, { beatsTotal: Infinity }, { boundary: 9 }, { boundary: NaN }, { energy: 9 }]) for (const mode of [31, 32])
    for (const seed of seedList(50)) { const chosen = resolveTransitionMode(mode, seed, cx(bad)); assert.ok(Number.isInteger(chosen) && chosen >= 1 && chosen < 31 && chosen !== 15, `${JSON.stringify(bad)} -> ${chosen}`); }
  for (const mode of [0, 31, 32]) for (const missing of [undefined, null, 'x', 7, {}, []]) assert.doesNotThrow(() => resolveTransitionMode(mode, 1, missing), `${mode} with context ${String(missing)}`);
  assert.equal(resolveTransitionMode(32, 5, undefined), resolveTransitionMode(32, 5, cx()), 'a missing context is the default context');
  assert.deepEqual(normalizeContext(undefined), { beatsTotal: 4, boundary: 0, nervPair: false, reducedMotion: false }); assert.deepEqual(normalizeContext({ energy: 2, boundary: 3, beatsTotal: 100, nervPair: true, reducedMotion: true }), { beatsTotal: 64, boundary: 3, nervPair: true, reducedMotion: true, energy: 2 });
  assert.deepEqual(normalizeContext({ energy: 9, boundary: 7, beatsTotal: -1, nervPair: 1, reducedMotion: 'yes' }), { beatsTotal: 4, boundary: 0, nervPair: false, reducedMotion: false });
}

lap('before section 9');
// ---- 9. generated native names --------------------------------------------------------------------------------------------------------------------
{
  const meta = await loadMeta(), text = renderHeader(meta);
  assert.equal(meta.count, TRANSITION_COUNT); assert.equal(meta.cut, TRANSITION_CUT); assert.equal(meta.meta.length, TRANSITION_COUNT);
  const normal = value => value.replace(/\r\n/g, '\n');
  // src/mpc-hc is not part of the stock mirror: the committed-header comparison and the CLI --check run only where the native sources exist.
  const headerPresent = existsSync(HEADER_PATH);
  if (headerPresent) assert.equal(normal(readFileSync(HEADER_PATH, 'utf8')), text, 'AAAVSTransitionNames.h equals the text regenerated from TRANSITION_META (run node tools/gen-transition-names.mjs)');
  else console.log('native sources absent (stock checkout): the committed AAAVSTransitionNames.h comparison is skipped; the regenerated header is still validated');
  assert.ok(text.startsWith('// generated from TRANSITION_META; do not edit'));
  assert.match(text, new RegExp(`constexpr int kTransitionCount = ${TRANSITION_COUNT};`)); assert.match(text, /constexpr const wchar_t\* kTransitionNames\[kTransitionCount\] = \{/); assert.match(text, /constexpr unsigned char kTransitionGroup\[kTransitionCount\] = \{/);
  const names = [...text.matchAll(/^\s+L"((?:[^"\\]|\\.)*)",\s+\/\/ (\d+)$/gm)];
  assert.equal(names.length, TRANSITION_COUNT); names.forEach((m, i) => { assert.equal(Number(m[2]), i); assert.equal(m[1].replace(/\\u([0-9A-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))), TRANSITIONS[i]); });
  assert.ok(/^[\x20-\x7e\r\n]*$/.test(text), 'the header is pure ASCII (universal-character-names), so no source encoding is assumed');
  const groups = text.match(/kTransitionGroup\[kTransitionCount\] = \{\s*([^}]*)\}/)[1].split(',').map(v => Number(v.trim()));
  assert.deepEqual(groups, TRANSITIONS.map((_, i) => i === 0 || i === 15 || i >= 31 ? 2 : i <= 14 ? 0 : 1), 'group 0 classic, 1 NERV/HUD, 2 Random/Cut/selectors');
  assert.ok(text.endsWith('\n') && !text.includes('\r'));
  // The CLI agrees (and writes an identical file to an explicit path).
  const scratch = mkdtempSync(join(tmpdir(), 'aaavs-names-'));
  try {
    if (headerPresent) execFileSync(process.execPath, ['tools/gen-transition-names.mjs', '--check'], { stdio: 'pipe' });
    execFileSync(process.execPath, ['tools/gen-transition-names.mjs', '--out', join(scratch, 'names.h')], { stdio: 'pipe' });
    assert.equal(readFileSync(join(scratch, 'names.h'), 'utf8'), text);
    assert.throws(() => execFileSync(process.execPath, ['tools/gen-transition-names.mjs', '--check', '--out', join(scratch, 'missing.h')], { stdio: 'pipe' }), /Command failed/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  // Native sources (absent in a stock checkout): menu identifiers come from the generated header and the range is not hard-coded.
  const view = new URL('../../src/mpc-hc/AAAVSView.cpp', import.meta.url);
  if (existsSync(view)) {
    const cpp = readFileSync(view, 'utf8');
    assert.ok(cpp.includes('AAAVSTransitionNames.h'), 'AAAVSView.cpp includes the generated names'); assert.ok(cpp.includes('kTransitionNames') && cpp.includes('kTransitionGroup') && cpp.includes('kTransitionMenuBase'));
    assert.ok(!/\b20\s*\+\s*i\b/.test(cpp), 'no retired 20 + i transition menu identifier'); assert.ok(!/choice\s*>=\s*20\s*&&\s*choice\s*<=\s*35/.test(cpp), 'the retired 20-35 range is gone');
    assert.match(cpp, /kTransitionMenuBase\s*=\s*100/); assert.ok(!/transition\s*>\s*15\b/.test(cpp) && !/,\s*0\s*,\s*15\s*\)/.test(cpp.replace(/\/\/.*$/gm, '')), 'the transition clamp no longer stops at 15');
  } else console.log('native sources absent (stock checkout): AAAVSView.cpp menu assertions skipped');
}

lap('before section 10');
// ---- 10. helpers, env and malformed input ------------------------------------------------------------------------------------------------------------
{
  // stepQ: 0 at t <= 0, non-decreasing, exactly 1 for the last 1/n of the transition.
  for (const n of [2, 3, 4, 8, 16, 32]) {
    let previous = 0;
    assert.equal(stepQ(0, n), 0); assert.equal(stepQ(-1, n), 0); assert.equal(stepQ(NaN, n), 0); assert.equal(stepQ(1, n), 1); assert.equal(stepQ(2, n), 1); assert.equal(stepQ(1 - 1e-12, n), 1);
    for (let i = 0; i <= 1000; i++) { const q = stepQ(i / 1000, n); assert.ok(q >= previous && q >= 0 && q <= 1); previous = q; }
    assert.equal(stepQ(1 - .999 / n, n), 1, `the last 1/${n} is already complete`); assert.ok(stepQ(1 - 1.001 / n, n) < 1);
    assert.equal(new Set(Array.from({ length: 1001 }, (_, i) => stepQ(i / 1000, n))).size, n);
  }
  for (const n of [1, 0, -3, NaN, 1.9]) assert.ok(stepQ(.5, n) >= 0 && stepQ(.5, n) <= 1, `degenerate step count ${n}`);
  // ticks: within [lo, hi], never faster than hz (except that lo wins for very short transitions), overridden by exact seconds.
  for (const bpm of [20, 60, 90, 120, 200, 400]) for (const beats of [.25, .5, 1, 2, 4, 8, 16, 64]) for (const [perBeat, hz, lo, hi] of [[4, 8, 2, 32], [2, 4, 2, 32], [2, 4, 1, 32], [2, 4, 4, 16]]) {
    const env = envFor(beats, { bpm }), n = ticks(env, perBeat, hz, lo, hi), seconds = beats * 60 / bpm;
    assert.ok(Number.isInteger(n) && n >= lo && n <= hi, `ticks bounds ${n}`); assert.ok(n <= Math.max(lo, Math.floor(hz * seconds)), `S3: ${n} steps in ${seconds}s exceeds ${hz} Hz`);
    assert.equal(ticks({ ...env, seconds: seconds * 2 }, perBeat, hz, lo, hi) >= n, true, 'exact seconds from a tempo map are honoured');
  }
  assert.equal(ticks(envFor(4), 4, 8), 16, '4 beats at 120 bpm is 2 s: 16 sixteenths, exactly the 8 Hz cap'); assert.equal(ticks(envFor(4, { bpm: 240 }), 4, 8), 8, 'at 240 bpm the same 4 beats last 1 s: 8 steps, still 8 Hz'); assert.equal(ticks(envFor(64), 2, 4), 32);
  for (const bad of [{ bpm: NaN }, { bpm: 0 }, { beatsTotal: NaN }, { beatsTotal: 0 }, { beatsTotal: -1 }, { seconds: NaN }]) { const n = ticks(envFor(4, bad), 4, 8); assert.ok(Number.isInteger(n) && n >= 2 && n <= 32, JSON.stringify(bad)); }
  for (const mode of FX_MODES) for (const bpm of [20, 60, 120, 400]) for (const beats of [.25, .5, 1, 4, 64]) {
    const steps = FX.fxSteps(mode, envFor(beats, { bpm })), seconds = beats * 60 / bpm;
    if (![16, 18, 24, 25].includes(mode)) { assert.equal(steps, 0); continue; }
    const [hz, lo] = mode === 16 ? [8, 2] : mode === 18 ? [4, 2] : mode === 24 ? [4, 1] : [4, 4];
    assert.ok(steps <= Math.max(lo, Math.floor(hz * seconds)), `S3 style ${mode}: ${steps} steps in ${seconds}s`);
  }
  // subSeed / hash32: salt 0 is the legacy raw seed; other salts and parts give independent, well-mixed values; pinned so stored boundaries never reshuffle.
  for (const seed of [0, 1, 0xdeadbeef, 4294967295]) assert.equal(subSeed(seed, 0), seed >>> 0);
  assert.deepEqual([subSeed(1, 1), subSeed(1, 2), subSeed(1, 0x100 + 18), subSeed(0xdeadbeef, 1), subSeed(0xdeadbeef, 2)].map(v => v >>> 0), [subSeed(1, 1), subSeed(1, 2), subSeed(1, 0x100 + 18), subSeed(0xdeadbeef, 1), subSeed(0xdeadbeef, 2)]);
  assert.equal(new Set(Array.from({ length: 300 }, (_, salt) => subSeed(12345, salt))).size, 300, 'every salt gives a distinct stream'); assert.notEqual(subSeed(1, 1), subSeed(2, 1));
  assert.ok(Array.from({ length: 256 }, (_, s) => subSeed(s, 1)).every(v => Number.isInteger(v) && v >= 0 && v <= 0xffffffff));
  assert.notEqual(hash32(1, 2, 3), hash32(3, 2, 1), 'order sensitive'); assert.notEqual(hash32(1, 2), hash32(1, 2, 0)); assert.equal(hash32(1.9, 2.1), hash32(1, 2), 'fractions are floored');
  assert.equal(hash32(7, 8, 9), hash32(7, 8, 9)); assert.equal(hash32(), hash32());
  const bits = Array.from({ length: 512 }, (_, i) => hash32(i)).reduce((acc, v) => acc + (v >>> 0).toString(2).split('1').length - 1, 0) / 512;
  assert.ok(bits > 14 && bits < 18, `hash32 bit balance ${bits}`);
  // pinned regression values: changing them silently reshuffles the styles of every stored boundary
  const pins = [hash32(0), hash32(1, 2, 3), subSeed(1, 1), subSeed(0xdeadbeef, 2), subSeed(7, 0x100 + 24)];
  assert.deepEqual(pins, PINNED_HASHES, `hash32/subSeed changed: ${JSON.stringify(pins)}`);
  // transitionUnit: 1 for every classic AVS surface; grows with the render surface.
  for (const [w, h, u] of [[640, 360, 1], [640, 640, 1], [640, 480, 1], [1280, 720, 2], [1920, 1080, 3], [3840, 2160, 6]]) assert.equal(transitionUnit(w, h), u);
  for (const bad of [[0, 0], [NaN, 1], [1, NaN], [-4, -4], [Infinity, Infinity]]) assert.equal(transitionUnit(...bad), 1);
  // transitionLevel / bands16 read only the audio frame.
  const spectrum = fill => [new Uint8Array(576).fill(fill), new Uint8Array(576).fill(fill)];
  assert.equal(transitionLevel(null), 0); assert.equal(transitionLevel(undefined), 0); assert.equal(transitionLevel({ spectrum: [] }), 0); assert.equal(transitionLevel({ spectrum: spectrum(0) }), 0);
  assert.equal(transitionLevel({ spectrum: spectrum(255) }), 1); assert.equal(transitionLevel({ spectrum: spectrum(128) }), .5); assert.equal(transitionLevel({ spectrum: [new Uint8Array(576).fill(255)] }), 1, 'a mono frame counts as both channels');
  for (let v = 0; v <= 255; v += 5) assert.ok([0, .25, .5, .75, 1].includes(transitionLevel({ spectrum: spectrum(v) })), 'quantised to quarters');
  const low = spectrum(0); for (let i = 93; i < 576; i++) { low[0][i] = 255; low[1][i] = 255; } assert.equal(transitionLevel({ spectrum: low }), 0, 'only the first 93 bins count');
  assert.deepEqual(bands16(null), Array(16).fill(0)); assert.deepEqual(bands16({ spectrum: [] }), Array(16).fill(0));
  const full = bands16({ spectrum: spectrum(255) }); assert.equal(full.length, 16); assert.ok(full.every(v => v === 1));
  const half = bands16({ spectrum: spectrum(51) }); assert.ok(half.every(v => Math.abs(v - .2) < 1e-9));
  const oneBand = spectrum(0); oneBand[0][0] = 255; oneBand[1][0] = 255; const isolated = bands16({ spectrum: oneBand }); assert.ok(isolated[0] > 0 && isolated[1] > 0 && isolated.slice(2).every(v => v === 0), 'the lowest bin is shared by the first two bands (the log axis of the NERV spectrum plates has sub-bin bands at the bottom) and by no other');
  assert.ok(bands16({ spectrum: [new Uint8Array(8).fill(255), new Uint8Array(8).fill(255)] }).every(v => v >= 0 && v <= 1), 'short spectra are tolerated');
  // env normalisation.
  assert.deepEqual(normalizeEnv(undefined), { bpm: 120, beatPhase: 0, barPhase: 0, beatsTotal: 4, level: 0, accent: 0, reducedMotion: false }); assert.deepEqual(normalizeEnv(null), normalizeEnv({}));
  assert.deepEqual({ ...defaultTransitionEnv }, { bpm: 120, beatPhase: 0, barPhase: 0, beatsTotal: 4, level: 0, accent: 0, reducedMotion: false }); assert.ok(Object.isFrozen(defaultTransitionEnv));
  const n = normalizeEnv({ bpm: 5, beatPhase: -1, barPhase: 2, beatsTotal: 1000, level: 7, accent: 2, reducedMotion: 1, seconds: 5000, bands: [2, -1, NaN, ...Array(20).fill(.5)] });
  assert.deepEqual([n.bpm, n.beatPhase, n.barPhase, n.beatsTotal, n.level, n.accent, n.reducedMotion, n.seconds], [20, 0, 1, 64, 1, 0, false, 4096]); assert.equal(n.bands.length, 16); assert.deepEqual(n.bands.slice(0, 3), [1, 0, 0]);
  assert.equal(normalizeEnv({ bpm: 1000 }).bpm, 400); assert.equal(normalizeEnv({ beatsTotal: 0 }).beatsTotal, .25); assert.equal(normalizeEnv({ accent: 1 }).accent, 1); assert.equal(normalizeEnv({ reducedMotion: true }).reducedMotion, true);
  for (const bad of [NaN, Infinity, -Infinity, '3', null, {}, []]) { const e = normalizeEnv({ bpm: bad, beatPhase: bad, barPhase: bad, beatsTotal: bad, level: bad, seconds: bad, bands: bad }); assert.ok([e.bpm, e.beatPhase, e.barPhase, e.beatsTotal, e.level].every(isPlainNumber)); assert.ok(!('seconds' in e) && !('bands' in e) || Array.isArray(bad)); }
  assert.ok(!('seconds' in normalizeEnv({ seconds: 0 })) && !('seconds' in normalizeEnv({ seconds: -3 })));
  // Malformed env and geometry never throw and never produce a non-finite canvas argument (RecordingContext asserts finiteness).
  const hostileEnvs = [undefined, null, {}, { bpm: NaN, beatsTotal: -5, level: Infinity, bands: 'x', beatPhase: undefined }, { bpm: 0, beatsTotal: 0, seconds: NaN }, { bands: [NaN, Infinity, -1, 2], level: -4, barPhase: 99 }, { beatsTotal: 1e9, bpm: 1e9, seconds: 1e9 }, { accent: 7, reducedMotion: 'yes' }];
  for (const mode of FX_MODES) for (const env of hostileEnvs) for (const [w, h] of [[1, 1], [2, 2], [12, 8], [64, 36], [4096, 2160]]) for (const t of [1e-9, .2, .5, .95]) {
    const counts = new R.Counts(), ctx = new R.RecordingContext({ width: w, height: h }, null, counts), tr = new AvsTransition(mode, { seed: 5, createCanvas: R.recordingCanvasFactory(counts) });
    assert.doesNotThrow(() => tr.draw(ctx, R.namedSource('old', w, h), R.namedSource('next', w, h), t, w, h, env), `style ${mode} ${JSON.stringify(env)} ${w}x${h}`);
    assert.ok(ctx.draws.length >= 1); assert.equal(ctx.depth, 0);
  }
  // Sources of another size than the frame are scaled into frame space (the 9-argument slices stay inside the source).
  for (const mode of [24, 25, 26]) { const counts = new R.Counts(), ctx = new R.RecordingContext({ width: 100, height: 60 }, null, counts), tr = new AvsTransition(mode, { seed: 5, createCanvas: R.recordingCanvasFactory(counts) });
    for (const t of [.2, .5, .8]) tr.draw(ctx, R.namedSource('old', 200, 120), R.namedSource('next', 50, 30), t, 100, 60, envFor(4)); for (const d of ctx.draws) if (d.src) assert.ok(d.src[0] + d.src[2] <= d.source.width + 1e-6 && d.src[1] + d.src[3] <= d.source.height + 1e-6); }
  // Construction.
  const built = []; const factory = () => { const c = { width: 0, height: 0, getContext: () => ({}) }; built.push(c); return c; };
  new AvsTransition(16, { seed: 1, createCanvas: factory }); assert.equal(built.length, 2, 'two scratch canvases (mask, tile); Mosaic Drop creates its own lazily');
  // Without createCanvas the constructor asks the document for its two scratch canvases (the main-thread player); Mosaic Drop adds its own lazily.
  const priorDocument = globalThis.document, madeByDocument = [];
  globalThis.document = { createElement: tag => { assert.equal(tag, 'canvas'); const c = { width: 0, height: 0, getContext: () => ({}) }; madeByDocument.push(c); return c; } };
  try { const defaulted = new AvsTransition(1); assert.equal(defaulted.requested, 1); assert.equal(madeByDocument.length, 2); } finally { if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument; }
}

lap('before section 11');
// ---- 11. reduced motion and smoothing ---------------------------------------------------------------------------------------------------------
{
  const [w, h] = [64, 36], NONCALM = [24, 25, 26, 27, 28, 29], CALM = FX_MODES.filter(m => !NONCALM.includes(m));
  const trace = (tr, t, env, options = {}) => { const out = new R.Surface(w, h, 1), { old, next } = idPair(w, h), ctx = new R.RecordingContext(out, out.getContext()); tr.draw(ctx, old, next, t, w, h, env); return ctx; };
  // A non-calm style drawn under reduced motion is exactly Cross dissolve (mode 1) - from the env at draw time and from the context at construction.
  for (const mode of NONCALM) for (const t of [.1, .5, .9]) {
    const reference = trace(make(1, 3), t, envFor(4)).signature(), viaEnv = trace(make(mode, 3), t, envFor(4, { reducedMotion: true })).signature();
    assert.equal(viaEnv, reference, `style ${mode} under env.reducedMotion is Cross dissolve`);
    const fromContext = make(mode, 3, { context: { beatsTotal: 4, boundary: 0, nervPair: true, reducedMotion: true } }); assert.equal(fromContext.mode, 1); assert.equal(fromContext.requested, mode);
    assert.equal(trace(fromContext, t, envFor(4)).signature(), reference);
  }
  // Calm styles keep their reveal under reduced motion and lose the beat-driven decoration (no stripe march, no ring pulse, no glitch).
  for (const mode of CALM) for (const t of [.2, .5, .8]) {
    const a = idFrame(make(mode, 3), w, h, t, envFor(4, { reducedMotion: true })).out.classes(false), b = idFrame(make(mode, 3), w, h, t, envFor(4)).out.classes(false);
    assert.ok(sameData(a, b), `style ${mode}: reduced motion keeps the reveal geometry`);
  }
  for (const mode of [17, 19]) for (const t of [.3, .6]) {
    const x = trace(make(mode, 3), t, envFor(4, { reducedMotion: true, beatPhase: 0, level: 0 })).signature(), y = trace(make(mode, 3), t, envFor(4, { reducedMotion: true, beatPhase: .8, level: 1 })).signature();
    assert.equal(x, y, `style ${mode}: no beat-driven decoration under reduced motion`);
    assert.notEqual(trace(make(mode, 3), t, envFor(4, { beatPhase: 0, level: 0 })).signature(), trace(make(mode, 3), t, envFor(4, { beatPhase: .8, level: 1 })).signature(), `style ${mode}: the decoration does follow the beat normally`);
  }
  // Smoothing: default nearest (classic AVS output), smooth: true sets 'high' first; scaled styles turn smoothing on locally; the mosaic upscale stays nearest.
  for (let mode = 1; mode <= 30; mode++) for (const smooth of [false, true]) {
    const ctx = trace(make(mode, 3, { smooth }), .45, envFor(4));
    assert.equal(ctx.ops[0], '=globalAlpha:1'); assert.equal(ctx.ops[1], `=imageSmoothingEnabled:${smooth}`, `style ${mode} smooth=${smooth}`);
    assert.equal(ctx.ops.includes('=imageSmoothingQuality:high'), smooth, `style ${mode}: imageSmoothingQuality only with smooth`);
    assert.equal(ctx.ops[2] === '=imageSmoothingQuality:high', smooth);
  }
  for (const mode of [22, 23, 26, 28]) { const draws = trace(make(mode, 3), .45, envFor(4)).draws; assert.ok(draws.some(d => d.smoothing === true), `style ${mode} smooths its scaled draws`); assert.ok(draws.some(d => d.smoothing === false) || mode === 28, `style ${mode} keeps the 1:1 draws nearest`); }
  for (const smooth of [false, true]) for (const t of [.2, .5, .8, .95]) {
    const counts = new R.Counts(), ctx = new R.RecordingContext({ width: 640, height: 360 }, null, counts), tr = new AvsTransition(29, { seed: 3, smooth, createCanvas: R.recordingCanvasFactory(counts) });
    tr.draw(ctx, R.namedSource('old', 640, 360), R.namedSource('next', 640, 360), t, 640, 360, envFor(4));
    for (const d of ctx.draws.filter(d => d.source.tag === 'scratch')) assert.equal(d.smoothing, false, 'the mosaic upscale is point sampled (smooth=' + smooth + ')');
  }
}

lap('before section 12');
// ---- 12. source hygiene -----------------------------------------------------------------------------------------------------------------------------
{
  const fxText = readFileSync('src/mpc-transition-fx.ts', 'utf8'), mainText = readFileSync('src/mpc-transition.ts', 'utf8');
  for (const [name, text] of [['mpc-transition-fx.ts', fxText], ['mpc-transition.ts', mainText]]) {
    assert.ok(!/Date\.now|performance\.now|new Date\(/.test(text), `${name}: no wall-clock source (frames must replay after a seek)`);
    assert.ok(!/localStorage|sessionStorage|fetch\(|XMLHttpRequest|document\.(?!createElement)/.test(text), `${name}: no storage, network or DOM access`);
    assert.ok(!/subSeed\([^)]*(0x44|\b68\b)\s*\)/.test(text), `${name}: salt 0x44 is retired (contract C-08)`);
    assert.ok(!/[A-Za-z]:\\|\/Users\/|\/home\/|[\w.-]+@[\w-]+\.(com|org|net)\b/i.test(text), `${name}: no private path or e-mail address`);
  }
  assert.ok(!/Math\.random/.test(fxText), 'the new styles never call Math.random');
  const randoms = mainText.split('\n').filter(line => /Math\.random/.test(line));
  assert.ok(randoms.length >= 1 && randoms.every(line => /options\.seed|random = Math\.random|Math\.random : /.test(line)), `Math.random only where no seed was supplied: ${randoms.join(' | ')}`);
  const importsOf = text => [...text.matchAll(/^import (?:type )?[^;]*? from '([^']+)'/gm)].map(m => m[1]);
  assert.deepEqual(importsOf(mainText).sort(), ['./mpc-contract.ts', './mpc-transition-fx.ts']); assert.deepEqual(importsOf(fxText), ['./mpc-transition.ts']);
  assert.match(fxText.slice(0, 900), /Original transition styles/); assert.match(fxText.slice(0, 1200), /Nothing here is derived from vis_avs/); assert.match(mainText.slice(0, 400), /BSD-3-Clause/);
  // The classic switch is still the only place with the vis_avs-derived geometry; the new styles are dispatched from a separate module.
  assert.ok(/mode >= FX_FIRST/.test(mainText) && /drawFx\(/.test(mainText));
}

lap('before section 13');
// ---- 13. resolution scaling, fuzz, odd seeds, extreme geometry, table cache ------------------------------------------------------------------------
{
  // Hairlines and numerals scale with the unit (C-10): at an exact multiple of 640x360 (unit 2 against unit 1) the decoration fraction of the frame stays put, so a higher
  // resolution changes crispness and never layout.
  for (const mode of FX_MODES) {
    const fraction = (w, h, ts) => { let sum = 0; for (const t of ts) sum += idFrame(make(mode, 7), w, h, t, envFor(4, { level: 1, beatPhase: 0 })).out.count(R.DECO.SHAPE | R.DECO.TEXT) / (w * h); return sum / ts.length; };
    for (const [w, h, ts] of [[1280, 720, [.15, .5, .85]]]) { const base = fraction(640, 360, ts), f = fraction(w, h, ts); assert.ok(Math.abs(f - base) <= Math.max(.001, .1 * base), `style ${mode}: decoration ${(f * 100).toFixed(2)}% at ${w}x${h} against ${(base * 100).toFixed(2)}% at 640x360`); }
  }
  // Seeded fuzz over odd sizes, wild progress and hostile envs: never throws, every canvas argument is finite, every destination intersects the canvas, save/restore balance.
  let counter = 0; const r = () => hash32(counter++, 20240929) / 4294967296, pick = list => list[Math.floor(r() * list.length)];
  for (let i = 0; i < 4000; i++) {
    const mode = 16 + Math.floor(r() * 15), w = 1 + Math.floor(r() * 120), h = 1 + Math.floor(r() * 70);
    const t = pick([r(), r(), r(), r(), -r(), 1 + r(), NaN, Infinity, -Infinity, 1e-12, 1 - 1e-12]);
    const env = pick([undefined, {}, { bpm: r() * 700 - 100, beatPhase: r() * 3 - 1, barPhase: r() * 3 - 1, beatsTotal: r() * 120 - 20, level: r() * 3 - 1, accent: pick([0, 1, 2]), reducedMotion: r() < .3, seconds: pick([undefined, r() * 30, -1, NaN]), bands: pick([undefined, Array.from({ length: 16 }, () => r() * 2 - .5), [NaN], 'x']) }]);
    const counts = new R.Counts(), ctx = new R.RecordingContext({ width: w, height: h }, null, counts), tr = new AvsTransition(mode, { seed: Math.floor(r() * 4294967296), smooth: r() < .5, createCanvas: R.recordingCanvasFactory(counts) });
    assert.doesNotThrow(() => tr.draw(ctx, R.namedSource('old', w, h), R.namedSource('next', w, h), t, w, h, env), `fuzz ${i}: style ${mode} ${w}x${h} t=${t} env=${JSON.stringify(env)}`);
    assert.equal(ctx.depth, 0); assert.ok(ctx.draws.length >= 1, 'every frame draws something');
  }
  // Odd seeds: any number is a seed; the same seed always gives the same style and block order.
  const plain = () => ({ width: 0, height: 0, getContext: () => ({}) });
  for (const seed of [-1, -(2 ** 31), 2 ** 32, 2 ** 32 + 5, 1.5, NaN, Infinity, -Infinity, 1e300, 0, undefined]) for (const mode of [0, 6, 16, 24, 31, 32]) {
    const a = new AvsTransition(mode, { seed, createCanvas: plain, context: { beatsTotal: 4, boundary: 1, nervPair: true, reducedMotion: false } }), b = new AvsTransition(mode, { seed, createCanvas: plain, context: { beatsTotal: 4, boundary: 1, nervPair: true, reducedMotion: false } });
    if (seed === undefined) { assert.ok(a.mode >= 1 && a.mode < 31 && (a.mode !== 15 || mode === 15) && a.order.length === 9); continue; }   // no seed: live Random and block order, not replayable by design
    assert.equal(a.mode, b.mode, `seed ${seed} mode ${mode}`); assert.deepEqual(a.order, b.order); assert.ok(a.mode >= 1 && a.mode < 31 && a.mode !== 15 || mode === 15);
  }
  // Extreme geometry: huge, thin and tiny frames record only finite calls within the declared cost.
  for (const mode of FX_MODES) for (const [w, h] of [[16384, 9216], [8192, 1], [1, 8192], [3, 3]]) for (const [beats, t] of [[.5, .25], [4, .5], [64, .9]]) {
    const counts = new R.Counts(), ctx = new R.RecordingContext({ width: w, height: h }, null, counts), tr = new AvsTransition(mode, { seed: 11, createCanvas: R.recordingCanvasFactory(counts) });
    assert.doesNotThrow(() => tr.draw(ctx, R.namedSource('old', w, h), R.namedSource('next', w, h), t, w, h, envFor(beats)), `style ${mode} ${w}x${h}`);
    for (const k of ['draw', 'clip', 'fill', 'text']) assert.ok(counts[k] <= TRANSITION_META[mode].cost[k], `style ${mode} ${w}x${h}: ${k} ${counts[k]} within the declared cost`);
  }
  // The per-transition parameter tables are bounded and rebuild identically after an eviction (a resize sweep never grows memory, and a replay never changes).
  for (const mode of [18, 24, 26]) {
    const counts = new R.Counts(), tr = new AvsTransition(mode, { seed: 3, createCanvas: R.recordingCanvasFactory(counts) });
    const sig = (w, h) => { const ctx = new R.RecordingContext({ width: w, height: h }, null, counts); tr.draw(ctx, R.namedSource('old', w, h), R.namedSource('next', w, h), .5, w, h, envFor(4)); return ctx.signature(); };
    const first = sig(96, 54);
    for (let k = 0; k < 60; k++) sig(40 + k, 30 + k);
    assert.ok(tr.fx.tables.size <= 9, `style ${mode}: ${tr.fx.tables.size} cached tables`); assert.equal(sig(96, 54), first, `style ${mode}: the same frame after the cache was evicted`);
  }
}

lap('section 13');
console.log(`Transitions 16-32: table (${TRANSITION_COUNT}), classic output unchanged (256 seeds, 16 recorded streams), endpoints, monotonicity/coverage, determinism, cost and decoration bounds, resolution scaling, fuzz, odd seeds, extreme geometry, limiter-clean sweep, selectors, generated names, malformed input, reduced motion, source hygiene PASS in ${((performance.now() - started) / 1000).toFixed(1)} s (CPU raster doubles only; visual, GPU and live acceptance pending)`);
