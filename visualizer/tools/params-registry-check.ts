// Regression check for the shared parameter registry (src/params/).
//
// Two layers. First the descriptor maths every surface shares — bounds, step
// quantisation, clamping, 0..1 normalisation in both directions — because a
// wrong answer there is the "slider stops at 9 next to a knob that goes to 64"
// bug the registry exists to prevent. Then the registry itself: set/get round
// trips through an accessor, membership versioning, re-registration ownership,
// fault isolation, the trailing-edge `reload` throttle, and reset semantics —
// including that resetting an `action` does NOT press it.

import {
  clampParam,
  formatParamValue,
  isKnobParam,
  paramFromUnit,
  paramMax,
  paramMin,
  paramMode,
  paramStep,
  paramToUnit,
  paramTitle,
  type ParamDescriptor,
  type ParamValue,
} from '../src/params/descriptor.ts';
import { ParamRegistry, type ParamAccessor } from '../src/params/registry.ts';

let checks = 0;

// Negative: the assertion helpers must be able to fail, or every PASS below is vacuous.
expectThrow(() => assert(false, 'deliberate'), 'assert() throws on false');
expectThrow(() => equal(1, 2, 'deliberate'), 'equal() throws on mismatch');

const segments: ParamDescriptor = { id: 'k.seg', label: 'Segments', kind: 'number', defaultValue: 6, min: 0, max: 64, step: 1, unit: 'segments' };
const offsetStep: ParamDescriptor = { id: 'o', label: 'Offset', kind: 'number', defaultValue: 0.1, min: 0.1, max: 1.1, step: 0.25 };
const unit: ParamDescriptor = { id: 'u', label: 'Unit', kind: 'number', defaultValue: 0.5 };
const mode: ParamDescriptor = { id: 'm', label: 'Mode', kind: 'select', defaultValue: 0, values: ['a', 'b', 'c', 'd'] };
const flag: ParamDescriptor = { id: 'f', label: 'Flag', kind: 'boolean', defaultValue: false };
const press: ParamDescriptor = { id: 'p', label: 'Next', kind: 'action', defaultValue: true, group: 'preset' };
const colour: ParamDescriptor = { id: 'c', label: 'Colour', kind: 'color', defaultValue: 0xff00ff };
const code: ParamDescriptor = { id: 't', label: 'Code', kind: 'text', defaultValue: 'x=1' };
const flat: ParamDescriptor = { id: 'z', label: 'Flat', kind: 'number', defaultValue: 3, min: 3, max: 3 };

// ------------------------------------------------------------- bounds and step

equal(paramMin(segments), 0, 'number min');
equal(paramMax(segments), 64, 'number max');
equal(paramMin(unit), 0, 'number min defaults to 0');
equal(paramMax(unit), 1, 'number max defaults to 1');
equal(paramMax(mode), 3, 'select max is option count - 1');
equal(paramMax({ ...mode, values: [] }), 0, 'empty select max is 0, not -1');
equal(paramMax(flag), 1, 'boolean max is 1');
equal(paramStep(segments), 1, 'explicit step');
equal(paramStep(unit), 0, 'number step defaults to continuous');
equal(paramStep(mode), 1, 'select step defaults to 1');
equal(paramStep({ ...segments, step: -2 }), 0, 'a non-positive step falls back to the kind default (continuous for number)');
equal(paramStep({ ...mode, step: 0 }), 1, 'a zero step on a select falls back to 1');

// ------------------------------------------------------------- clamp

equal(clampParam(segments, 100), 64, 'clamp above max');
equal(clampParam(segments, -5), 0, 'clamp below min');
equal(clampParam(segments, 6.4), 6, 'integer step rounds down');
equal(clampParam(segments, 6.5), 7, 'integer step rounds half up');
equal(clampParam(segments, '12' as unknown as ParamValue), 12, 'numeric string coerces');
equal(clampParam(segments, Number.NaN), 6, 'NaN falls back to the default');
equal(clampParam(segments, Number.POSITIVE_INFINITY), 6, 'Infinity falls back to the default');
equal(clampParam(segments, true), 1, 'boolean into a number is 0/1');
near(clampParam(offsetStep, 0.5) as number, 0.6, 1e-9, 'step quantises relative to min (0.1 + 2 * 0.25)');
near(clampParam(offsetStep, 5) as number, 1.1, 1e-9, 'quantised value still clamps to max');
equal(clampParam(unit, 0.123456), 0.123456, 'continuous number is not quantised');
equal(clampParam(mode, 2.6), 3, 'select rounds to the nearest index');
equal(clampParam(mode, 9), 3, 'select clamps to the last index');
equal(clampParam(flag, 0.49), false, 'boolean threshold below 0.5');
equal(clampParam(flag, 0.5), true, 'boolean threshold at 0.5');
equal(clampParam(flag, true), true, 'boolean passes through');
equal(clampParam(press, false), true, 'an action write is always a press');
equal(clampParam(colour, 123), 123, 'color passes through');
equal(clampParam(code, 'y=2'), 'y=2', 'text passes through');

// ------------------------------------------------------------- 0..1 in and out

equal(paramFromUnit(segments, 0), 0, 'unit 0 -> min');
equal(paramFromUnit(segments, 1), 64, 'unit 1 -> max');
equal(paramFromUnit(segments, 0.5), 32, 'unit 0.5 -> midpoint');
equal(paramFromUnit(segments, 1.7), 64, 'unit above 1 is clamped');
equal(paramFromUnit(segments, -3), 0, 'unit below 0 is clamped');
equal(paramFromUnit(mode, 1), 3, 'select: unit 1.0 lands on the last option, not past it');
equal(paramFromUnit(mode, 0.2499), 0, 'select: first quarter is option 0');
equal(paramFromUnit(mode, 0.25), 1, 'select: equal-width buckets');
equal(paramFromUnit({ ...mode, values: [] }, 0.7), 0, 'select with no options is 0');
equal(paramFromUnit(flag, 0.5), true, 'boolean from unit at threshold');
equal(paramFromUnit(press, 0), true, 'action from any unit is a press');
equal(paramFromUnit(colour, 0.5), 0xff00ff, 'color from unit is its default (not drivable)');
equal(paramToUnit(segments, 16), 0.25, 'to unit');
equal(paramToUnit(segments, 640), 1, 'to unit clamps above');
equal(paramToUnit(mode, 3), 1, 'select to unit');
equal(paramToUnit(flag, true), 1, 'boolean to unit');
equal(paramToUnit(press, true), 0, 'action has no position');
equal(paramToUnit(flat, 3), 0, 'degenerate range is 0, not NaN');
equal(paramToUnit(segments, Number.NaN), 0, 'non-finite value is 0, not NaN');
for (let v = 0; v <= 64; v++) equal(paramFromUnit(segments, paramToUnit(segments, v)), v, `integer round trip ${v}`);
for (let i = 0; i < 4; i++) {
  // The inverse of a bucketed select maps index i to i/(n-1); forward from there must land back on i.
  equal(paramFromUnit(mode, paramToUnit(mode, i)), i, `select round trip ${i}`);
}

// ------------------------------------------------------------- display helpers

equal(isKnobParam(colour), false, 'color is not a knob');
equal(isKnobParam(code), false, 'text is not a knob');
equal(isKnobParam(press), true, 'action is listed with knobs');
equal(paramMode(press), 'trigger', 'action is a trigger');
equal(paramMode(segments), 'continuous', 'number is continuous');
equal(paramTitle(segments), 'Segments (segments)', 'title with unit');
equal(formatParamValue(segments, 12), '12 segments', 'integer format');
equal(formatParamValue(offsetStep, 0.6), '0.6', 'step 0.25 formats to ceil(-log10 step) = 1 digit');
equal(formatParamValue({ ...unit, step: 0.01 }, 0.5), '0.50', 'step 0.01 formats to two digits');
equal(formatParamValue(mode, 2), 'c', 'select formats as its label');
equal(formatParamValue(flag, true), 'on', 'boolean formats on/off');
equal(formatParamValue(press, true), '—', 'action has no value to show');

// ------------------------------------------------------------- the registry

/** An accessor over a plain cell, counting writes. */
function cell(initial: ParamValue): ParamAccessor & { value: ParamValue; writes: number } {
  const box = {
    value: initial,
    writes: 0,
    get: (): ParamValue => box.value,
    set: (next: ParamValue): void => { box.value = next; box.writes++; },
  };
  return box;
}

{
  const registry = new ParamRegistry();
  let notified = 0;
  registry.subscribe(() => { notified++; });
  const seg = cell(6);
  const md = cell(0);
  const fl = cell(false);
  let presses = 0;
  const pressAccessor: ParamAccessor = { get: () => true, set: () => { presses++; } };

  const v0 = registry.version;
  const unregister = registry.registerAll([
    { descriptor: segments, accessor: seg },
    { descriptor: mode, accessor: md },
    { descriptor: flag, accessor: fl },
    { descriptor: press, accessor: pressAccessor },
  ]);
  equal(registry.size, 4, 'registerAll adds every entry');
  equal(registry.version, v0 + 1, 'one registerAll is one version bump');
  equal(notified, 1, 'subscribers hear a membership change');
  equal(registry.list().map((e) => e.descriptor.id).join(','), 'k.seg,m,f,p', 'list is registration order');
  equal(registry.groups().join(','), ',preset', 'groups in first-seen order');
  equal(registry.byGroup('preset').length, 1, 'byGroup');

  // Round trips: set clamps, the accessor receives the clamped value, get reads it back.
  assert(registry.set('k.seg', 12), 'set on a known id returns true');
  equal(registry.value('k.seg'), 12, 'set/get round trip');
  registry.set('k.seg', 99);
  equal(seg.value, 64, 'set clamps before the accessor sees it');
  registry.set('m', 1.4);
  equal(registry.value('m'), 1, 'select set/get round trip rounds to an index');
  registry.set('f', 1);
  equal(registry.value('f'), true, 'boolean set/get round trip');
  assert(registry.applyUnit('k.seg', 0.25), 'applyUnit on a known id');
  equal(registry.value('k.seg'), 16, 'applyUnit writes the de-normalised value');
  near(registry.unitValue('k.seg'), 0.25, 1e-12, 'unitValue reads it back as 0.25');
  equal(registry.version, v0 + 1, 'value writes do NOT bump the membership version');

  // Unknown ids: not an error, no write anywhere.
  const writesBefore = seg.writes + md.writes + fl.writes;
  assert(!registry.set('nope', 1), 'set on an unknown id returns false');
  assert(!registry.applyUnit('nope', 1), 'applyUnit on an unknown id returns false');
  assert(!registry.reset('nope'), 'reset on an unknown id returns false');
  equal(registry.value('nope'), undefined, 'value of an unknown id is undefined');
  equal(registry.unitValue('nope'), 0, 'unitValue of an unknown id is 0');
  equal(seg.writes + md.writes + fl.writes, writesBefore, 'an unknown id does NOT write any accessor');

  // Reset puts the declared default back.
  registry.set('k.seg', 40);
  assert(registry.reset('k.seg'), 'reset on a number returns true');
  equal(registry.value('k.seg'), 6, 'reset restores the default');
  registry.set('f', true);
  registry.reset('f');
  equal(registry.value('f'), false, 'reset restores a boolean default');

  // An action is pressed by set, and NOT by reset.
  registry.set('p', false);
  equal(presses, 1, 'set on an action presses it (whatever the value)');
  assert(!registry.reset('p'), 'reset on an action returns false');
  equal(presses, 1, 'reset on an action does NOT press it');

  // Re-registration: the newer owner survives the older unregister.
  const replacement = cell(3);
  const unregisterReplacement = registry.register(segments, replacement);
  equal(registry.value('k.seg'), 3, 're-registering an id replaces the accessor');
  unregister();
  assert(registry.has('k.seg'), 'an older unregister does NOT remove a re-registered id');
  assert(!registry.has('m') && !registry.has('p'), 'unregister removes the rest of its batch');
  const v1 = registry.version;
  unregister();
  equal(registry.version, v1, 'a second unregister is a no-op');
  unregisterReplacement();
  equal(registry.size, 0, 'the newer owner removes its own entry');
  registry.dispose();
}

{
  // Faults stay local: a throwing accessor or listener does not break the registry.
  const registry = new ParamRegistry();
  const warn = console.warn;
  console.warn = (): void => {};
  try {
    registry.subscribe(() => { throw new Error('bad listener'); });
    let heard = 0;
    registry.subscribe(() => { heard++; });
    registry.register(segments, { get: () => { throw new Error('bad get'); }, set: () => { throw new Error('bad set'); } });
    equal(heard, 1, 'a throwing listener does not stop the next one');
    equal(registry.value('k.seg'), 6, 'a throwing get falls back to the default');
    assert(registry.set('k.seg', 3), 'a throwing set is swallowed, the write still counts as routed');
  } finally {
    console.warn = warn;
    registry.dispose();
  }
}

{
  // `reload` writes: leading edge immediately, the rest trailing, last value wins.
  const registry = new ParamRegistry();
  const heavy: ParamDescriptor = { ...segments, id: 'avs.heavy', cost: 'reload' };
  const box = cell(0);
  registry.register(heavy, box);
  registry.set('avs.heavy', 1);
  equal(box.writes, 1, 'first reload write lands immediately');
  for (let v = 2; v <= 20; v++) registry.set('avs.heavy', v);
  equal(box.writes, 1, 'a burst inside the window is held, NOT written through');
  await new Promise((done) => setTimeout(done, 200));
  equal(box.writes, 2, 'the held burst lands as exactly one trailing write');
  equal(box.value, 20, 'the trailing write carries the LAST value');
  registry.dispose();
}

console.log(`params-registry-check: PASS (${checks} assertions)`);

// ------------------------------------------------------------- helpers

function assert(condition: boolean, label: string): void {
  checks++;
  if (!condition) throw new Error(`params-registry-check: FAIL — ${label}`);
}
function equal<T>(actual: T, expected: T, label: string): void {
  checks++;
  if (actual !== expected) throw new Error(`params-registry-check: FAIL — ${label}: got ${String(actual)}, expected ${String(expected)}`);
}
function near(actual: number, expected: number, tolerance: number, label: string): void {
  checks++;
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`params-registry-check: FAIL — ${label}: got ${actual}, expected ${expected} ± ${tolerance}`);
  }
}
function expectThrow(fn: () => void, label: string): void {
  const before = checks;
  let threw = false;
  try { fn(); } catch { threw = true; }
  checks = before + 1;
  if (!threw) throw new Error(`params-registry-check: FAIL — ${label}: did not throw`);
}
