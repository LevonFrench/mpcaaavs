import { performance } from 'node:perf_hooks';
import { TempoTracker } from '../src/clock.ts';

interface CaseResult { name: string; expectedBpm: number; estimatedBpm: number; absoluteErrorBpm: number; relativeErrorPercent: number; locked: boolean; confidence: number; lockOnset: number | null; lockSeconds: number | null; onsetCount: number }
const cases: CaseResult[] = [];
const started = performance.now();
for (const bpm of [55, 72, 90, 120, 160, 200]) cases.push(run(`click-${bpm}`, bpm, clicks(bpm, 28, index => ((index * 17) % 7 - 3) * 0.001)));
const swingEvents: number[] = [0]; let swingTime = 0; const swingPeriod = 60 / 118;
for (let index = 1; index < 34; index++) { swingTime += swingPeriod * (index % 2 ? 1.08 : 0.92); swingEvents.push(swingTime); }
cases.push(run('swing-8-percent', 118, swingEvents));
cases.push(run('missing-hits', 128, clicks(128, 42).filter((_, index) => index % 7 !== 3 && index % 11 !== 5)));
const doubles: number[] = []; for (const [index, time] of clicks(110, 36).entries()) { doubles.push(time); if (index % 5 === 2) doubles.push(time + 0.17); } cases.push(run('double-hits', 110, doubles));
const rampEvents: number[] = [0]; let rampTime = 0; for (let index = 0; index < 48; index++) { rampTime += 60 / (90 + 60 * index / 47); rampEvents.push(rampTime); } cases.push(run('ramp-90-to-150-final', 150, rampEvents));

const clean = cases.filter(value => value.name.startsWith('click-'));
const errors = cases.map(value => value.absoluteErrorBpm), relativeErrors = cases.map(value => value.relativeErrorPercent);
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(), node: process.version, deterministic: true, elapsedMs: performance.now() - started,
  summary: {
    cases: cases.length, locked: cases.filter(value => value.locked).length,
    cleanMeanAbsoluteErrorBpm: mean(clean.map(value => value.absoluteErrorBpm)),
    allMeanAbsoluteErrorBpm: mean(errors), allMeanRelativeErrorPercent: mean(relativeErrors),
    worstAbsoluteErrorBpm: Math.max(...errors), maxLockOnsets: Math.max(...cases.map(value => value.lockOnset ?? Infinity)),
  }, cases,
}, null, 2));

function run(name: string, expectedBpm: number, events: readonly number[]): CaseResult { const tracker = new TempoTracker(); let lockOnset: number | null = null, lockSeconds: number | null = null; events.forEach((time, index) => { tracker.addOnset(time); tracker.update(time); if (tracker.locked && lockOnset === null) { lockOnset = index + 1; lockSeconds = time - events[0]!; } }); return { name, expectedBpm, estimatedBpm: tracker.bpm, absoluteErrorBpm: Math.abs(tracker.bpm - expectedBpm), relativeErrorPercent: Math.abs(tracker.bpm - expectedBpm) / expectedBpm * 100, locked: tracker.locked, confidence: tracker.confidence, lockOnset, lockSeconds, onsetCount: events.length }; }
function clicks(bpm: number, count: number, jitter: (index: number) => number = () => 0): number[] { const period = 60 / bpm; return Array.from({ length: count }, (_, index) => index * period + jitter(index)); }
function mean(values: readonly number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }
