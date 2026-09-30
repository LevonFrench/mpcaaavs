import { SLOTS_PER_BAR, TempoTracker } from '../src/clock.ts';
import { TierBTimeline } from '../src/timeline.ts';

let checks = 0;
const tracker = new TempoTracker();
const timeline = new TierBTimeline(tracker);

for (let index = 0; index < 10; index++) tracker.addOnset(index * 0.5);
timeline.update(4.5);
assert(tracker.locked, 'fixture acquires tempo lock');
near(tracker.bpm, 120, 1, 'fixture tempo');
const before = timeline.slotAt(4.5);

tracker.seekByBeats(4, 6.5);
timeline.seekByBeats(4, 6.5);
timeline.update(6.5);
near(timeline.slotAt(6.5) - before, SLOTS_PER_BAR, 0.001, 'forward skip advances exactly one bar');
assert(tracker.locked, 'forward skip preserves lock');

tracker.seekByBeats(-4, 4.5);
timeline.seekByBeats(-4, 4.5);
timeline.update(4.5);
near(timeline.slotAt(4.5), before, 0.001, 'backward skip returns to prior bar');
assert(tracker.locked, 'backward skip preserves lock');

tracker.seekByBeats(-100, 0);
assert(tracker.beatIndex >= 0, 'backward skip clamps before bar one');

console.log(`transport-runtime-check: PASS (${checks} assertions)`);

function assert(condition: boolean, label: string): void {
  checks++;
  if (!condition) throw new Error(label);
}
function near(actual: number, expected: number, tolerance: number, label: string): void {
  checks++;
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: got ${actual}, expected ${expected} ± ${tolerance}`);
  }
}
