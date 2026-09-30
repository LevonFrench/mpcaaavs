// Music-like detector/tempo regression gate.
//
// Runs the real AdaptiveMultibandDetector (behind a replica of the worklet's
// FFT front end) and the real TempoTracker over seeded synthetic grooves, and
// asserts onset recall/precision against the synthesiser's own event times,
// tempo lock-in time, and the documented tempo octave (src/clock.ts, octave
// rule). Thresholds sit a margin below the values measured when this gate was
// written (noted inline) so a regression fails, not a rounding change.
//
// KNOWN LIMITATIONS are asserted as ceilings, not as goals: they document the
// current behaviour so it cannot silently get worse. See the notes at each.

import assert from 'node:assert/strict';
import { preferredReading, TempoTracker } from '../src/clock.ts';
import {
  allFixtures,
  analyseNative,
  matchEvents,
  seededRandom,
  traceTempo,
  type MusicFixture,
  type NativeOnset,
} from './audio-music-fixtures.ts';

interface Spec {
  readonly minRecall: number;
  readonly minPrecision: number;
  /** Max seconds from musicStart to the first lock in the expected octave; null = lock not required. */
  readonly lockWithin: number | null;
  /** Relative bpm tolerance for "correct". */
  readonly tolerance: number;
  readonly minCorrectFraction?: number;
  readonly maxMedianError?: number;
  /** Required locked bpm span (proves the tracker follows a glide). */
  readonly spans?: readonly [number, number];
  /** Locked frames at a wrong tempo allowed (default: unlimited unless set). */
  readonly maxWrongLockedFrames?: number;
  /** Beatless material: the tracker must never lock. */
  readonly neverLock?: boolean;
}

// Measured values at authoring time in trailing comments: recall/precision/lock.
const SPECS: Record<string, Spec> = {
  // R 1.00 P 1.00, lock +2.2 s, 100% correct.
  'four-on-the-floor': { minRecall: 0.95, minPrecision: 0.95, lockWithin: 4, tolerance: 0.02, minCorrectFraction: 0.95 },
  // R 1.00 P 0.95, lock +1.9 s, 100% correct (140, not 70: octave rule).
  'trap-808': { minRecall: 0.95, minPrecision: 0.9, lockWithin: 4, tolerance: 0.02, minCorrectFraction: 0.95 },
  // R 0.97 P 0.80, lock +6.4 s at 150 (not 75: octave rule), no flip.
  'half-time': { minRecall: 0.95, minPrecision: 0.75, lockWithin: 10, tolerance: 0.02, minCorrectFraction: 0.95 },
  // R 1.00 P 1.00, lock +2.3 s; median error ~3% while tempo glides ±8%.
  'rubato': {
    minRecall: 0.95, minPrecision: 0.95, lockWithin: 5, tolerance: 0.05,
    maxMedianError: 0.05, spans: [96, 104],
  },
  // R 1.00 P 1.00. KNOWN LIMITATION: 62% swing leaves 90/135/150 within a few
  // percent of each other, so the tracker does not lock. That is the safe
  // failure (no grid rather than a wrong one), so a wrong-tempo lock fails.
  'swung-hip-hop': { minRecall: 0.95, minPrecision: 0.95, lockWithin: null, tolerance: 0.04, maxWrongLockedFrames: 0 },
  // Syllable recall 0.79. Precision is not asserted: see the room-tone ceiling.
  'room-speech': { minRecall: 0.7, minPrecision: 0, lockWithin: null, tolerance: 0.04, neverLock: true },
  // Checked with the drop-specific assertions below as well.
  'silence-to-drop': { minRecall: 0.95, minPrecision: 0.95, lockWithin: 3.5, tolerance: 0.02, minCorrectFraction: 0.95 },
  // R 0.98 (the one miss is the drop kick itself, see below), lock +2.1 s.
  // Precision is bounded by the room-tone ceiling instead.
  'room-tone-to-drop': { minRecall: 0.95, minPrecision: 0, lockWithin: 3.5, tolerance: 0.02, minCorrectFraction: 0.95 },
};

let assertions = 0;
function check(condition: unknown, message: string): void { assert.ok(condition, message); assertions++; }

/** Every failed expectation for one fixture, as text. Empty = pass. */
function evaluate(fixture: MusicFixture, onsets: readonly NativeOnset[], spec: Spec): string[] {
  const failures: string[] = [];
  const times = onsets.map(onset => onset.time);
  const match = matchEvents(fixture.events.map(event => event.time), times);
  if (match.recall < spec.minRecall) failures.push(`recall ${match.recall.toFixed(3)} < ${spec.minRecall}`);
  if (match.precision < spec.minPrecision) failures.push(`precision ${match.precision.toFixed(3)} < ${spec.minPrecision}`);
  const trace = traceTempo(fixture, times, spec.tolerance);
  if (spec.neverLock && Number.isFinite(trace.firstLock)) failures.push(`beatless material locked at ${trace.firstLock.toFixed(2)} s`);
  if (spec.lockWithin !== null) {
    const lockIn = trace.firstCorrectLock - fixture.musicStart;
    if (!(lockIn <= spec.lockWithin)) failures.push(`lock-in ${lockIn.toFixed(2)} s > ${spec.lockWithin} s (final ${trace.finalBpm.toFixed(2)} BPM)`);
    if (trace.octaveSwitches !== 0) failures.push(`${trace.octaveSwitches} tempo-octave switches while locked`);
    if (!trace.finalLocked) failures.push('not locked at end of fixture');
    // Gliding material is judged by median error and span; a tracker always
    // lags a glide, so its last frame says little.
    const target = fixture.expectedBpm!;
    if (!fixture.bpmAt && Math.abs(trace.finalBpm - target) / target > spec.tolerance) {
      failures.push(`final ${trace.finalBpm.toFixed(2)} BPM, expected ${target.toFixed(2)}`);
    }
  }
  if (spec.minCorrectFraction !== undefined && trace.correctFraction < spec.minCorrectFraction) {
    failures.push(`correct-tempo fraction ${trace.correctFraction.toFixed(3)} < ${spec.minCorrectFraction}`);
  }
  if (spec.maxMedianError !== undefined && !(trace.medianRelativeError <= spec.maxMedianError)) {
    failures.push(`median tempo error ${(trace.medianRelativeError * 100).toFixed(1)}% > ${spec.maxMedianError * 100}%`);
  }
  if (spec.spans && !(trace.lockedBpmMin <= spec.spans[0] && trace.lockedBpmMax >= spec.spans[1])) {
    failures.push(`locked bpm ${trace.lockedBpmMin.toFixed(1)}-${trace.lockedBpmMax.toFixed(1)} does not follow the glide ${spec.spans.join('-')}`);
  }
  if (spec.maxWrongLockedFrames !== undefined && trace.wrongLockedFrames > spec.maxWrongLockedFrames) {
    failures.push(`${trace.wrongLockedFrames} frames locked at a wrong tempo`);
  }
  return failures;
}

// ------------------------------------------------------------ fixture gate

const fixtures = allFixtures();
const analysed = new Map<string, NativeOnset[]>();
for (const fixture of fixtures) {
  const spec = SPECS[fixture.name];
  check(spec, `${fixture.name} has a spec`);
  const onsets = analyseNative(fixture.left, fixture.right);
  analysed.set(fixture.name, onsets);
  const times = onsets.map(onset => onset.time);
  const match = matchEvents(fixture.events.map(event => event.time), times);
  const trace = traceTempo(fixture, times, spec!.tolerance);
  console.log(
    `  ${fixture.name.padEnd(18)} events ${String(match.reference).padStart(3)} onsets ${String(match.detected).padStart(3)}`
    + ` R ${match.recall.toFixed(3)} P ${match.precision.toFixed(3)}`
    + ` lock ${Number.isFinite(trace.firstCorrectLock) ? `+${(trace.firstCorrectLock - fixture.musicStart).toFixed(2)}s` : '  none'}`
    + ` bpm ${trace.finalBpm.toFixed(2)}${trace.finalLocked ? ' (locked)' : ''}`,
  );
  const failures = evaluate(fixture, onsets, spec!);
  check(failures.length === 0, `${fixture.name}: ${failures.join('; ')}`);
}

// silence -> drop: digital silence must be perfectly quiet, the drop's first
// kick must be caught on time.
{
  const onsets = analysed.get('silence-to-drop')!;
  check(onsets.length > 0 && onsets[0]!.time >= 6 - 0.05, `digital silence produced onsets: ${onsets.filter(o => o.time < 5.95).map(o => o.time.toFixed(3))}`);
  check(Math.abs(onsets[0]!.time - 6) <= 0.05, `drop kick not detected within 50 ms: ${onsets[0]?.time}`);
}
// KNOWN LIMITATION: adaptive whitening normalises near-silent (-60 dBFS) room
// tone up to full scale, so it produces ~6 false onsets/s (13 in this 2 s
// window when written), and one landing <90 ms before the drop swallows the
// drop kick through the detector's refractory gap (it did when written). The
// digital-silence fixture above proves the drop path itself. Ceiling, not a
// target: fixing it means an absolute-level gate in audio-features.ts, which
// needs real-music tuning before it can land.
{
  const onsets = analysed.get('room-tone-to-drop')!;
  check(onsets.every(onset => onset.time >= 4 - 0.02), 'digital silence before the room tone produced onsets');
  const roomFalse = onsets.filter(onset => onset.time >= 4 && onset.time < 6 - 0.05).length;
  check(roomFalse <= 16, `near-silent room tone false onsets ${roomFalse} > 16`);
  const drop = onsets.find(onset => onset.time >= 6 - 0.05);
  console.log(`  note: room-tone drop kick ${drop && Math.abs(drop.time - 6) <= 0.05 ? 'caught' : 'masked by a room-tone false onset (known limitation)'}; ${roomFalse} room-tone false onsets in 2 s`);
}
// Same limitation at speaking level: 7.5 onsets/s when written.
{
  const fixture = fixtures.find(f => f.name === 'room-speech')!;
  const rate = analysed.get(fixture.name)!.length / fixture.seconds;
  check(rate <= 9, `room/speech onset rate ${rate.toFixed(2)}/s > 9/s`);
}

// --------------------------------------------------- octave rule, unit level

check(preferredReading([75, 150]) === 150 && preferredReading([150, 75]) === 150, 'half-time 75|150 folds to 150');
check(preferredReading([70, 140]) === 140, 'trap 70|140 folds to 140');
check(preferredReading([90, 180]) === 90 && preferredReading([180, 90]) === 90, 'hip-hop 90|180 keeps 90');
check(preferredReading([135, 90]) === 90, '3:2 tie inside the band prefers the slower (swing/triplet) reading');
check(preferredReading([62, 124]) === 124, '62|124 folds to 124');
check(preferredReading([56, 84]) === 84, 'below the band the reading nearest 120 wins');

// Clean clicks are never tied with a relative: the prior must not pull them.
for (const bpm of [55, 72, 90, 120, 160, 180, 200]) {
  const tracker = run(clicks(bpm, 32));
  check(tracker.locked && Math.abs(tracker.bpm - bpm) / bpm < 0.015, `${bpm} BPM clicks read ${tracker.bpm} (locked ${tracker.locked})`);
}
// Offbeat-8th stream (house hats with no other hits) reads its quarter pulse.
// Before subdivision credit this stream scored ~0 at 124 and never locked.
{
  const tracker = run(clicks(248, 64));
  check(tracker.locked && Math.abs(tracker.bpm - 124) / 124 < 0.015, `8th stream at 124 read ${tracker.bpm} (locked ${tracker.locked})`);
}
// Half-time sweep over ghost density and seeds: dense ghosts must resolve to
// 150 for every seed; with no ghosts 75 is a clear winner and must stay 75.
for (const [ghost, expected] of [[0, 75], [0.5, 150], [1, 150]] as const) {
  for (let seed = 1; seed <= 6; seed++) {
    const random = seededRandom(seed * 977);
    const onsets: number[] = [];
    for (let index = 0; index < 40; index++) {
      const time = 0.4 + index * 0.8;
      onsets.push(time);
      if (random() < ghost) onsets.push(time + 0.4);
    }
    const tracker = run(onsets);
    check(tracker.locked && Math.abs(tracker.bpm - expected) / expected < 0.02, `half-time ghost=${ghost} seed=${seed} read ${tracker.bpm}`);
  }
}

// Loose uniform pulses at 172-200: with ~10-15 ms timing jitter the half tempo
// grazes OCTAVE_TIE, so either octave may be chosen at lock time (a uniform
// pulse is metrically ambiguous), but the chosen one must never flip while
// locked. Without OCTAVE_SWITCH several of these flipped T -> T/2 mid-stream.
for (const bpm of [172, 190, 200]) {
  for (const jitter of [0.01, 0.015]) {
    for (let seed = 1; seed <= 3; seed++) {
      const random = seededRandom(seed * 131 + bpm);
      const period = 60 / bpm;
      const tracker = new TempoTracker();
      let switches = 0, lastOctave: number | null = null;
      for (let index = 0; index < 48; index++) {
        const time = 0.3 + index * period + (random() * 2 - 1) * jitter;
        tracker.addOnset(time); tracker.update(time);
        if (!tracker.locked) continue;
        const octave = Math.round(Math.log2(tracker.bpm / bpm) * 2);
        if (lastOctave !== null && octave !== lastOctave) switches++;
        lastOctave = octave;
      }
      const reading = [bpm, bpm / 2].find(target => Math.abs(tracker.bpm - target) / target < 0.03);
      check(tracker.locked && reading !== undefined && switches === 0,
        `loose ${bpm} BPM pulse (±${jitter * 1000} ms, seed ${seed}) read ${tracker.bpm.toFixed(2)}, ${switches} octave switches while locked`);
    }
  }
}

// ------------------------------------------- negative: the gate can fail

{
  const fixture = fixtures.find(f => f.name === 'four-on-the-floor')!;
  const onsets = analysed.get(fixture.name)!;
  const spec = SPECS[fixture.name]!;
  const late = onsets.map(onset => ({ ...onset, time: onset.time + 0.12 }));
  const lateFailures = evaluate(fixture, late, spec);
  check(lateFailures.some(text => text.startsWith('recall')), `120 ms late onsets must fail recall: ${lateFailures}`);
  check(evaluate(fixture, [], spec).some(text => text.startsWith('lock-in')), 'no onsets must fail lock-in');
  check(evaluate({ ...fixture, expectedBpm: 62 }, onsets, spec).length > 0, 'wrong expected octave (62 for a 124 groove) must fail');
  const doubled = onsets.flatMap(onset => [onset, { ...onset, time: onset.time + 0.03 }]);
  check(matchEvents(fixture.events.map(e => e.time), doubled.map(o => o.time)).precision < 0.6, 'doubled detections must fail precision');
  check(preferredReading([150, 75]) !== 75, 'octave rule is not the identity on its first argument');
}

console.log(`audio-music-fixtures-check: PASS (${assertions} assertions)`);

function run(events: readonly number[]): TempoTracker {
  const tracker = new TempoTracker();
  for (const time of events) { tracker.addOnset(time); tracker.update(time); }
  return tracker;
}
function clicks(bpm: number, count: number): number[] {
  const period = 60 / bpm;
  return Array.from({ length: count }, (_, index) => 0.25 + index * period + ((index * 17) % 7 - 3) * 0.001);
}
