// Regression check for the 16-step lane (src/sequencer/lane.ts) and the two
// small rules its panel depends on (native-lane inert targets, the text-entry
// keyboard guard).
//
// The lane is a clock problem, so most of this drives it with a scripted
// `Timeline` and asserts on which ticks fire: first-poll priming, loop wrap at
// sixteen, a pause that must not replay, a stall that must collapse to one step,
// a tempo change that must neither skip nor repeat a tick, and a seek (reset)
// that must land cleanly in either direction. Then persistence: `laneCount`
// pads and truncates a stored grid, and a damaged stored file is repaired
// field by field rather than thrown away.
//
// `performance.now` is replaced with a throwing stub for every `update()`, and
// the lane's source is scanned (comments stripped) for a `performance.now`
// call: the module's contract is that it has no wall clock.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Timeline, TimelineEvent } from '../src/contracts.ts';
import type { InputEvent } from '../src/input/events.ts';
import { paramInputTargets, targetInert, type InputTarget } from '../src/input/mappings.ts';
import { guardKeyEvent, installKeyboardGuard, isTextEntry } from '../src/keyboard-guard.ts';
import { ParamRegistry } from '../src/params/registry.ts';
import {
  SequencerLanes,
  STEPS_PER_BAR,
  type SequencerStepEvent,
  type StepLane,
} from '../src/sequencer/lane.ts';

const STORAGE_KEY = 'aaavs.sequencer.lanes.v1';
const SLOTS_PER_BEAT = 240;
const SLOTS_PER_STEP = SLOTS_PER_BEAT / 4;

let checks = 0;

// ------------------------------------------------------------------ fixtures

/** Piecewise-constant tempo, continuous slot position — what a real timeline promises. */
class ScriptTimeline implements Timeline {
  readonly horizonSec = 8;
  readonly confidence = 1;
  private tempo = 0;
  private anchorSec = 0;
  private anchorSlot = 0;

  bpm(_atSec: number): number {
    return this.tempo;
  }

  slotAt(atSec: number): number {
    return this.anchorSlot + (atSec - this.anchorSec) * (this.tempo / 60) * SLOTS_PER_BEAT;
  }

  eventsBetween(_a: number, _b: number): TimelineEvent[] {
    return [];
  }

  /** Change tempo at `atSec` without moving the grid position. */
  setTempo(bpm: number, atSec: number): void {
    this.anchorSlot = this.tempo > 0 ? this.slotAt(atSec) : this.anchorSlot;
    this.anchorSec = atSec;
    this.tempo = bpm;
  }

  /** Jump the grid to `slot` at `atSec` (a transport seek). */
  seek(slot: number, atSec: number): void {
    this.anchorSlot = slot;
    this.anchorSec = atSec;
  }
}

class MemoryStorage {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, String(value)); }
  removeItem(key: string): void { this.data.delete(key); }
  clear(): void { this.data.clear(); }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });

interface Dispatched { targetId: string; value: number; event: InputEvent }

function makeRegistry(): ParamRegistry {
  const registry = new ParamRegistry();
  let amount = 0;
  registry.register(
    { id: 'fx.amount', label: 'FX amount', kind: 'number', defaultValue: 0 },
    { get: () => amount, set: (value) => { amount = Number(value); } },
  );
  registry.register(
    { id: 'preset.next', label: 'Next preset', kind: 'action', defaultValue: true, group: 'preset' },
    { get: () => true, set: () => {} },
  );
  registry.register(
    { id: 'kaleido.segments', label: 'Segments', kind: 'number', defaultValue: 6, min: 0, max: 64, step: 1, lane: 'native' },
    { get: () => 6, set: () => {} },
  );
  return registry;
}

function makeLanes(laneCount?: number, stored?: unknown): {
  lanes: SequencerLanes;
  steps: SequencerStepEvent[];
  sent: Dispatched[];
} {
  storage.clear();
  if (stored !== undefined) storage.setItem(STORAGE_KEY, typeof stored === 'string' ? stored : JSON.stringify(stored));
  const steps: SequencerStepEvent[] = [];
  const sent: Dispatched[] = [];
  const lanes = new SequencerLanes({
    registry: makeRegistry(),
    dispatcher: { dispatch: (targetId, value, event) => { sent.push({ targetId, value, event }); return true; } },
    ...(laneCount !== undefined ? { laneCount } : {}),
    defaultTarget: 'sequencer.rest',
    onStep: (event) => steps.push(event),
  });
  return { lanes, steps, sent };
}

/** Poll with the wall clock booby-trapped: any `performance.now()` inside `update` throws. */
function poll(lanes: SequencerLanes, timeline: Timeline, now: number): void {
  const original = performance.now;
  performance.now = (): number => { throw new Error('performance.now() called inside SequencerLanes.update'); };
  try { lanes.update(timeline, now); }
  finally { performance.now = original; }
}

// ------------------------------------------------------------- the harness itself

// Negative: the assertion helpers must be able to fail, or every PASS below is vacuous.
expectThrow(() => assert(false, 'deliberate'), 'assert() throws on false');
expectThrow(() => equal(1, 2, 'deliberate'), 'equal() throws on mismatch');

// ------------------------------------------------------------- clock behaviour

{
  const { lanes, steps, sent } = makeLanes(4);
  const tl = new ScriptTimeline();
  lanes.setAmount(0, 0.5);
  lanes.setTarget(0, 'fx.amount');
  lanes.toggleStep(0, 0);
  lanes.toggleStep(0, 4);
  // A lane with a step on but no target must stay silent.
  lanes.setTarget(1, '');
  lanes.toggleStep(1, 0);

  // Before tempo lock nothing fires, not even the playhead.
  for (let t = 0; t < 1; t += 0.1) poll(lanes, tl, t);
  equal(steps.length, 0, 'no step before tempo lock');
  equal(lanes.currentStep, -1, 'playhead parked before lock');

  // 120 BPM: one sixteenth = 0.125 s. The first poll primes and fires nothing.
  tl.setTempo(120, 1);
  poll(lanes, tl, 1.001);
  equal(steps.length, 0, 'first poll after lock primes and fires nothing');

  // Twenty sixteenths, polled once per step: ticks 1..20, steps wrap at 16.
  for (let k = 1; k <= 20; k++) poll(lanes, tl, 1 + k * 0.125 + 0.001);
  equal(steps.length, 20, 'one step event per sixteenth');
  equal(steps.map((s) => s.tick).join(','), Array.from({ length: 20 }, (_u, i) => i + 1).join(','), 'ticks are contiguous');
  equal(steps.map((s) => s.step).join(','), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4].join(','), 'loop wraps 15 -> 0');
  equal(steps[14]!.step, 15, 'tick 15 is the last step of the bar');
  equal(steps[15]!.step, 0, 'tick 16 is step 0 of the next bar');
  for (const s of steps) near(s.time, 1 + s.tick * 0.125, 1e-6, `tick ${s.tick} lands on its grid time`);

  // Dispatch: lane 1 on steps 0 and 4 → ticks 4, 16, 20. Lane 2 (no target) never.
  equal(sent.map((d) => d.event.raw).join(','), '4,16,20', 'lane 1 fires exactly on its on-steps');
  assert(sent.every((d) => d.targetId === 'fx.amount' && d.value === 0.5), 'dispatch carries target and amount');
  assert(!sent.some((d) => d.targetId === ''), 'a lane with no target does NOT dispatch');
  const wrapped = sent.find((d) => d.event.raw === 16)!;
  equal(wrapped.event.source, 'step', 'fabricated event source');
  equal(wrapped.event.kind, 'trigger', 'fabricated event kind');
  equal(wrapped.event.id, '1.1', 'fabricated event id is lane.step, 1-based');
  // atMs is the audio-clock landing time, not a wall-clock stamp.
  near(wrapped.event.atMs, (1 + 16 * 0.125) * 1000, 1e-6, 'atMs is the audio-clock landing time in ms');
  equal(steps[15]!.fired.length, 1, 'onStep reports the lanes that fired');

  // Pause: the audio clock stops, so `now` stops. Re-polling must replay nothing.
  const before = steps.length;
  const paused = 1 + 20 * 0.125 + 0.001;
  for (let i = 0; i < 30; i++) poll(lanes, tl, paused);
  equal(steps.length, before, 'polling a paused clock fires nothing');

  // Stall: ten sixteenths elapse between two polls. The backlog collapses to its
  // last tick — one step event, at most one dispatch per lane.
  const sentBefore = sent.length;
  poll(lanes, tl, 1 + 30 * 0.125 + 0.001);
  equal(steps.length, before + 1, 'a stalled backlog collapses to one step event');
  equal(steps.at(-1)!.tick, 30, 'the collapsed step is the latest tick');
  equal(lanes.currentStep, 30 % STEPS_PER_BAR, 'playhead follows the collapsed tick');
  assert(sent.length - sentBefore <= 1, 'a stalled backlog does NOT dispatch every skipped step');

  // Tempo change 120 -> 174 on the grid: no tick skipped, none repeated.
  const changeAt = 1 + 30 * 0.125 + 0.05;
  tl.setTempo(174, changeAt);
  const fromIndex = steps.length;
  for (let t = changeAt; t < changeAt + 3; t += 0.01) poll(lanes, tl, t);
  const ticks = steps.slice(fromIndex).map((s) => s.tick);
  assert(ticks.length > 20, 'ticks keep firing after the tempo change');
  equal(ticks[0], 31, 'the first tick after the change follows the last one before it');
  for (let i = 1; i < ticks.length; i++) equal(ticks[i], ticks[i - 1]! + 1, `tempo change: tick ${ticks[i - 1]} -> ${ticks[i]} contiguous`);
  const stepSec174 = 60 / 174 / 4;
  const after = steps.slice(fromIndex);
  for (let i = 1; i < after.length; i++) near(after[i]!.time - after[i - 1]!.time, stepSec174, 1e-6, 'post-change step spacing is 174 BPM');

  // Seek forward (transport reset + timeline jump): the first poll lands, fires nothing.
  const seekAt = changeAt + 3;
  tl.seek(64 * 16 * SLOTS_PER_STEP + 5, seekAt);
  lanes.reset();
  equal(lanes.currentStep, -1, 'reset parks the playhead');
  const n = steps.length;
  poll(lanes, tl, seekAt);
  equal(steps.length, n, 'first poll after a seek fires nothing (no gap dump)');
  poll(lanes, tl, seekAt + stepSec174 + 0.001);
  equal(steps.at(-1)!.tick, 64 * 16 + 1, 'after a forward seek the grid resumes from the new position');
  equal(steps.at(-1)!.step, 1, 'step index follows the new position');

  // Seek backward: without reset the scheduler would refuse old ticks forever;
  // with reset the lane resumes at the earlier position.
  const backAt = seekAt + 1;
  tl.seek(2 * 16 * SLOTS_PER_STEP + 3, backAt);
  lanes.reset();
  poll(lanes, tl, backAt);
  poll(lanes, tl, backAt + stepSec174 + 0.001);
  equal(steps.at(-1)!.tick, 2 * 16 + 1, 'after a backward seek + reset the grid resumes from the earlier bar');

  // Master switch off: the playhead still moves, nothing dispatches.
  lanes.enabled = false;
  const sentOff = sent.length;
  const stepsOff = steps.length;
  for (let k = 2; k < 40; k++) poll(lanes, tl, backAt + k * stepSec174 + 0.001);
  assert(steps.length > stepsOff, 'disabled grid still moves the playhead');
  equal(sent.length, sentOff, 'disabled grid does NOT dispatch');
}

// ------------------------------------------------------------- persistence

{
  // Fresh: laneCount rows, default target.
  const { lanes } = makeLanes(3);
  equal(lanes.lanes.length, 3, 'fresh grid has laneCount rows');
  assert(lanes.lanes.every((l) => l.target === 'sequencer.rest' && l.amount === 1), 'fresh rows take the default target');
  const { lanes: defaulted } = makeLanes();
  equal(defaulted.lanes.length, 4, 'laneCount defaults to 4');
}

function storedLane(target: string, on: number[]): StepLane {
  const steps = new Array<boolean>(STEPS_PER_BAR).fill(false);
  for (const i of on) steps[i] = true;
  return { channel: `stored ${target}`, steps, target, amount: 0.25 };
}

{
  // Pad: two stored rows, laneCount 5 → the two stored rows plus three fresh ones.
  const { lanes } = makeLanes(5, [storedLane('fx.amount', [0]), storedLane('preset.next', [8])]);
  equal(lanes.lanes.length, 5, 'stored grid is padded up to laneCount');
  assert(lanes.lanes.length !== 2, 'a stored lane count does NOT override laneCount');
  equal(lanes.lanes[0]!.target, 'fx.amount', 'padding keeps stored row 1');
  equal(lanes.lanes[1]!.target, 'preset.next', 'padding keeps stored row 2');
  assert(lanes.lanes[1]!.steps[8] === true && lanes.lanes[1]!.amount === 0.25, 'padding keeps stored steps and amount');
  equal(lanes.lanes[2]!.channel, 'lane 3', 'padded row is named by position');
  equal(lanes.lanes[4]!.target, 'sequencer.rest', 'padded row takes the default target');
  assert(lanes.ownsPresetChanges, 'a stored preset lane with a step on owns preset changes');

  // Truncate: six stored rows, laneCount 4 → the first four.
  const six = Array.from({ length: 6 }, (_u, i) => storedLane(`t${i}`, [i]));
  const { lanes: cut } = makeLanes(4, six);
  equal(cut.lanes.length, 4, 'stored grid is truncated to laneCount');
  equal(cut.lanes.map((l) => l.target).join(','), 't0,t1,t2,t3', 'truncation keeps the first rows in order');

  // The repaired shape is what gets written back.
  cut.persist();
  equal((JSON.parse(storage.getItem(STORAGE_KEY)!) as unknown[]).length, 4, 'persist writes the laneCount-shaped grid');
}

{
  // Damaged rows are repaired field by field, not rejected.
  const { lanes } = makeLanes(4, [
    { channel: 'kick', steps: [true, 'yes', 1, true], target: 'fx.amount', amount: 7 },
    null,
    'garbage',
    { steps: new Array(40).fill(true), target: 42, amount: 'loud' },
    { channel: 'nan', steps: 'x', target: 'preset.next', amount: Number.NaN },
  ]);
  equal(lanes.lanes.length, 4, 'repaired grid still has laneCount rows');
  const [a, b, c, d] = lanes.lanes as StepLane[];
  equal(a!.channel, 'kick', 'valid channel kept');
  equal(a!.steps.length, STEPS_PER_BAR, 'short step array padded to 16');
  equal(a!.steps.filter(Boolean).length, 2, 'only literal `true` counts as an on-step');
  equal(a!.amount, 1, 'out-of-range amount is clamped to 1');
  equal(b!.steps.length, STEPS_PER_BAR, 'long step array truncated to 16');
  equal(b!.target, '', 'non-string target becomes unassigned');
  equal(b!.amount, 1, 'non-numeric amount falls back to 1');
  equal(b!.channel, 'lane 2', 'missing channel is named by position');
  equal(c!.steps.filter(Boolean).length, 0, 'non-array steps become an empty row');
  equal(c!.amount, 1, 'NaN amount falls back to 1 (JSON writes NaN as null)');
  equal(d!.target, 'sequencer.rest', 'the missing fourth row is padded');

  for (const [raw, label] of [['{not json', 'invalid JSON'], ['{"a":1}', 'non-array JSON'], ['[]', 'empty array']] as const) {
    const { lanes: fallback } = makeLanes(2, raw);
    equal(fallback.lanes.length, 2, `${label} falls back to a fresh grid`);
    assert(fallback.lanes.every((l) => l.target === 'sequencer.rest'), `${label} rows take the default target`);
  }
}

// ------------------------------------------------------------- no wall clock

/** Strip // and /* *\/ comments. Good enough for this file: no URLs or `//` in strings. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
function callsWallClock(source: string): boolean {
  return /performance\s*\.\s*now\b/.test(codeOnly(source)) || /Date\s*\.\s*now\b/.test(codeOnly(source));
}
// Negative: the scanner must see a real call, and must ignore one in a comment.
assert(callsWallClock('const t = performance.now();'), 'scanner detects performance.now()');
assert(callsWallClock('x({ atMs: Date.now() })'), 'scanner detects Date.now()');
assert(!callsWallClock('// there is no performance.now here\n/* nor performance.now */ const a = 1;'), 'scanner ignores comments');
const laneSource = readFileSync(resolve('src/sequencer/lane.ts'), 'utf8');
assert(!callsWallClock(laneSource), 'src/sequencer/lane.ts calls no wall clock (performance.now / Date.now)');

// ------------------------------------------------------------- panel rules

{
  const registry = makeRegistry();
  const rows = paramInputTargets(registry);
  const native = rows.find((r) => r.id === 'kaleido.segments')!;
  const avsSafe = rows.find((r) => r.id === 'fx.amount')!;
  equal(native.nativeOnly, true, 'native-lane descriptor is flagged nativeOnly');
  assert(avsSafe.nativeOnly !== true, 'a both-lane descriptor is NOT flagged nativeOnly');
  assert(targetInert(native, true), 'native-only target is inert while the AVS lane renders');
  assert(!targetInert(native, false), 'native-only target is live on the native lane');
  assert(!targetInert(avsSafe, true), 'a both-lane target is NOT inert on the AVS lane');
  const bare: InputTarget = { id: 'x', label: 'x', mode: 'continuous' };
  assert(!targetInert(bare, true), 'an unflagged target is never inert');
}

{
  const input = (type: string): object => ({ tagName: 'INPUT', type });
  for (const type of ['text', 'number', 'range', 'search', 'email']) assert(isTextEntry(input(type) as EventTarget), `<input type=${type}> is text entry`);
  for (const type of ['button', 'checkbox', 'radio', 'submit']) assert(!isTextEntry(input(type) as EventTarget), `<input type=${type}> is NOT text entry`);
  assert(isTextEntry({ tagName: 'select' } as unknown as EventTarget), 'select is text entry');
  assert(isTextEntry({ tagName: 'TEXTAREA' } as unknown as EventTarget), 'textarea is text entry');
  assert(isTextEntry({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget), 'contenteditable is text entry');
  assert(!isTextEntry({ tagName: 'BUTTON' } as unknown as EventTarget), 'button is NOT text entry');
  assert(!isTextEntry(null), 'null target is NOT text entry');

  const slider = input('range') as EventTarget;
  const outside = input('text') as EventTarget;
  const root = { contains: (node: Node | null): boolean => node === (slider as unknown as Node) };
  const fire = (key: string, target: EventTarget): boolean => {
    let stopped = false;
    guardKeyEvent(root, { key, target, stopPropagation: () => { stopped = true; } });
    return stopped;
  };
  assert(fire('ArrowLeft', slider), 'ArrowLeft on a slider inside the panel is stopped');
  assert(fire('s', slider), 'a letter on a field inside the panel is stopped');
  assert(!fire('Escape', slider), 'Escape is NOT stopped');
  assert(!fire('ArrowLeft', outside), 'a field outside the panel is NOT guarded by it');
  assert(!fire('ArrowLeft', { tagName: 'BUTTON' } as unknown as EventTarget), 'a button is NOT guarded');

  const calls: string[] = [];
  const host = {
    addEventListener: (type: string, _l: unknown, capture?: unknown): void => { calls.push(`add:${type}:${String(capture)}`); },
    removeEventListener: (type: string, _l: unknown, capture?: unknown): void => { calls.push(`remove:${type}:${String(capture)}`); },
  };
  const remove = installKeyboardGuard(root, host);
  remove();
  remove();
  equal(calls.join(','), 'add:keydown:true,remove:keydown:true', 'guard installs a capture keydown listener and uninstalls it once');
}

console.log(`sequencer-lane-check: PASS (${checks} assertions)`);

// ------------------------------------------------------------- helpers

function assert(condition: boolean, label: string): void {
  checks++;
  if (!condition) throw new Error(`sequencer-lane-check: FAIL — ${label}`);
}
function equal<T>(actual: T, expected: T, label: string): void {
  checks++;
  if (actual !== expected) throw new Error(`sequencer-lane-check: FAIL — ${label}: got ${String(actual)}, expected ${String(expected)}`);
}
function near(actual: number, expected: number, tolerance: number, label: string): void {
  checks++;
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`sequencer-lane-check: FAIL — ${label}: got ${actual}, expected ${expected} ± ${tolerance}`);
  }
}
function expectThrow(fn: () => void, label: string): void {
  const before = checks;
  let threw = false;
  try { fn(); } catch { threw = true; }
  checks = before + 1;
  if (!threw) throw new Error(`sequencer-lane-check: FAIL — ${label}: did not throw`);
}
