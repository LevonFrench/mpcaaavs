import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TempoTracker, resolveTempoBpm } from '../src/clock.ts';

interface Result { readonly bpm: number; readonly locked: boolean; readonly confidence: number; readonly lockOnset: number }
let assertions = 0;

for (const bpm of [55, 72, 90, 120, 160, 200]) {
  const result = run(clicks(bpm, 28, index => ((index * 17) % 7 - 3) * 0.001));
  assert(result.locked, `${bpm} BPM locks`); assertions++;
  assert(relativeError(result.bpm, bpm) < 0.015, `${bpm} BPM estimate: ${result.bpm}`); assertions++;
  assert(result.lockOnset <= 10, `${bpm} BPM locks within ten onsets: ${result.lockOnset}`); assertions++;
  assert(result.confidence >= 0.55, `${bpm} BPM confidence: ${result.confidence}`); assertions++;
}

const swingEvents: number[] = [0]; let swingTime = 0; const swingPeriod = 60 / 118;
for (let index = 1; index < 34; index++) { swingTime += swingPeriod * (index % 2 ? 1.08 : 0.92); swingEvents.push(swingTime); }
const swing = run(swingEvents); assert(swing.locked && relativeError(swing.bpm, 118) < 0.025, `swing estimate ${swing.bpm}`); assertions++;

const missing = clicks(128, 42).filter((_, index) => index % 7 !== 3 && index % 11 !== 5);
const missingResult = run(missing); assert(missingResult.locked && relativeError(missingResult.bpm, 128) < 0.02, `missing-hit estimate ${missingResult.bpm}`); assertions++;

const doubled: number[] = [];
for (const [index, time] of clicks(110, 36).entries()) { doubled.push(time); if (index % 5 === 2) doubled.push(time + 0.17); }
const doubledResult = run(doubled); assert(doubledResult.locked && relativeError(doubledResult.bpm, 110) < 0.025, `double-hit estimate ${JSON.stringify(doubledResult)}`); assertions++;

const ramp: number[] = [0]; let rampTime = 0;
for (let index = 0; index < 48; index++) { const bpm = 90 + 60 * index / 47; rampTime += 60 / bpm; ramp.push(rampTime); }
const rampTracker = new TempoTracker(); let previousBpm = 0;
for (const onset of ramp) { rampTracker.addOnset(onset); rampTracker.update(onset); if (rampTracker.locked) { assert(rampTracker.bpm + 0.5 >= previousBpm, 'tempo ramp does not octave-jump backwards'); assertions++; previousBpm = rampTracker.bpm; } }
assert(rampTracker.locked && Math.abs(rampTracker.bpm - 150) < 7, `tempo-ramp final estimate ${rampTracker.bpm}`); assertions++;

const silenceTracker = new TempoTracker(); for (const onset of clicks(120, 18)) { silenceTracker.addOnset(onset); silenceTracker.update(onset); }
assert(silenceTracker.locked, 'silence fixture initially locks'); assertions++; silenceTracker.update(20);
assert(!silenceTracker.locked && silenceTracker.confidence < 0.35, 'silence unlocks with low confidence'); assertions++;
assert(relativeError(silenceTracker.bpm, 120) < 0.02, 'phase unlock retains the measured track tempo'); assertions++;
assert.equal(resolveTempoBpm(0, silenceTracker.bpm), silenceTracker.bpm, 'reacquiring phase uses measured tempo instead of 120 fallback'); assertions++;
assert.equal(resolveTempoBpm(0, 0), 120, '120 fallback is used only before tempo evidence exists'); assertions++;

const hysteresisTracker = new TempoTracker(); for (const onset of clicks(120, 18)) { hysteresisTracker.addOnset(onset); hysteresisTracker.update(onset); }
hysteresisTracker.addOnset(8.67); hysteresisTracker.addOnset(8.84);
assert(hysteresisTracker.locked, 'two off-grid false positives do not immediately break lock'); assertions++;

const seekTracker = new TempoTracker(); for (const onset of clicks(120, 18)) { seekTracker.addOnset(onset); seekTracker.update(onset); }
const seekBpm = seekTracker.bpm, seekIndex = seekTracker.beatIndex; seekTracker.update(8.25); const seekPhase = seekTracker.phase; seekTracker.seekByBeats(8, 100);
assert.equal(seekTracker.beatIndex, seekIndex + 8, 'forward seek preserves musical beat index'); assertions++;
assert.equal(seekTracker.bpm, seekBpm, 'forward seek preserves tempo'); assertions++;
seekTracker.update(100); assert(Math.abs(seekTracker.phase - seekPhase) < 1e-9, 'forward seek preserves phase'); assertions++;
for (const onset of clicks(120, 12).map(value => value + 100)) { seekTracker.addOnset(onset); seekTracker.update(onset); }
assert(seekTracker.locked && relativeError(seekTracker.bpm, 120) < 0.02, 'tracker relocks cleanly after seek'); assertions++;

const latencyTracker = new TempoTracker(); latencyTracker.inputLatency = 0.08;
for (const onset of clicks(100, 20)) { latencyTracker.addOnset(onset + 0.08); latencyTracker.update(onset); }
assert(latencyTracker.locked && relativeError(latencyTracker.bpm, 100) < 0.02, 'input latency preserves tempo'); assertions++;
assert(phaseDistance(latencyTracker.phase) < 0.08, `input latency phase correction ${latencyTracker.phase}`); assertions++;

const longTracker = new TempoTracker(); let longTime = 0, longLockedOnce = false, usedDefaultAfterLock = false;
for (let index = 0; index < 640; index++) {
  longTime += 60 / 124;
  if (index > 0 && index % 128 === 0) { longTime += 5; longTracker.update(longTime); }
  longTracker.addOnset(longTime + ((index * 13) % 5 - 2) * .001);
  longTracker.update(longTime);
  longLockedOnce ||= longTracker.locked;
  usedDefaultAfterLock ||= longLockedOnce && longTracker.bpm <= 0;
}
assert(!usedDefaultAfterLock, 'known long-session tempo never returns to the pre-evidence default'); assertions++;
assert(longTracker.locked && relativeError(longTracker.bpm, 124) < .02, `five-minute session retains/reacquires 124 BPM: ${longTracker.bpm}`); assertions++;
longTracker.reset();
for (const onset of clicks(142, 24)) { longTracker.addOnset(onset); longTracker.update(onset); }
assert(longTracker.locked && relativeError(longTracker.bpm, 142) < .02, `new-song reset earns a fresh 142 BPM lock: ${longTracker.bpm}`); assertions++;

const clockSource = readFileSync(resolve('src/clock.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
assert(!/performance\.now|Date\.now/.test(clockSource), 'tempo tracker has no wall-clock dependency'); assertions++;
const mainSource = readFileSync(resolve('src/main.ts'), 'utf8');
const dropStart = mainSource.indexOf("document.addEventListener('drop'");
const dropEnd = mainSource.indexOf('// --------------------------------------------------------------- first-run guide', dropStart);
const dropHandler = mainSource.slice(dropStart, dropEnd);
assert(dropHandler.indexOf('await audio.loadFile(file)') < dropHandler.indexOf('resetTransport(0)'), 'track-change reset happens after asynchronous decode/play'); assertions++;

console.log(`clock-tempo-tracker-check: PASS (${assertions} assertions)`);

function run(events: readonly number[]): Result { const tracker = new TempoTracker(); let lockOnset = Infinity; events.forEach((time, index) => { tracker.addOnset(time); tracker.update(time); if (tracker.locked && !Number.isFinite(lockOnset)) lockOnset = index + 1; }); return { bpm: tracker.bpm, locked: tracker.locked, confidence: tracker.confidence, lockOnset }; }
function clicks(bpm: number, count: number, jitter: (index: number) => number = () => 0): number[] { const period = 60 / bpm; return Array.from({ length: count }, (_, index) => index * period + jitter(index)); }
function relativeError(actual: number, expected: number): number { return Math.abs(actual - expected) / expected; }
function phaseDistance(phase: number): number { return Math.min(phase, 1 - phase); }
