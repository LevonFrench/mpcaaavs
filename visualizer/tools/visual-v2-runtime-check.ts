import { SLOTS_PER_BEAT } from '../src/clock.ts';
import { Layer, euclid } from '../src/layers.ts';
import { V2_PRESET_BANK } from '../src/presets/visual-v2.ts';
import { CLIFFORD_DEFAULTS } from '../src/sources/clifford.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`visual-v2-runtime-check: ${message}`);
}

function close(a: number, b: number, epsilon = 1e-9): boolean {
  return Math.abs(a - b) <= epsilon;
}

const rave = V2_PRESET_BANK.find((entry) => entry.preset.name === 'prism-overload')?.preset;
assert(rave, 'prism-overload preset is missing');

const primarySpec = rave.layers.find((layer) => layer.id === 'wings');
const restSpec = rave.layers.find((layer) => layer.id === 'phrase-rest');
assert(primarySpec, 'prism-overload primary layer is missing');
assert(restSpec, 'prism-overload phrase-rest layer is missing');

// Any retriggered non-zero attack has to finish before the shortest cyclic
// Euclidean gap. Otherwise Layer.update replaces the live timestamp and the
// whole layer snaps to zero at the next pulse.
for (const { preset } of V2_PRESET_BANK) {
  for (const spec of preset.layers) {
    if (spec.envelope.attackBeats <= 0) continue;
    const pattern = euclid(spec.trigger.euclidK, spec.trigger.euclidN);
    const onsets = pattern.flatMap((on, index) => on ? [index] : []);
    assert(onsets.length > 0, `${preset.name}/${spec.id} has an attack but no trigger onset`);
    let minSteps = pattern.length;
    for (let i = 0; i < onsets.length; i++) {
      const here = onsets[i]!;
      const next = onsets[(i + 1) % onsets.length]! + (i + 1 === onsets.length ? pattern.length : 0);
      minSteps = Math.min(minSteps, next - here);
    }
    const layer = new Layer(spec, preset.seed);
    const gapBeats = minSteps * layer.strideSlots / SLOTS_PER_BEAT;
    const envelopeBeats = spec.envelope.attackBeats + spec.envelope.holdBeats + spec.envelope.releaseBeats;
    assert(envelopeBeats <= gapBeats,
      `${preset.name}/${spec.id} envelope ${envelopeBeats} beats exceeds ${gapBeats}-beat trigger gap`);
  }
}

// The primary is a continuous 4-bar scene. A new 4-bar pulse must not create
// the old progress=1 -> progress=0 retrigger blink.
const primary = new Layer(primarySpec, rave.seed);
primary.update(0);
assert(close(primary.progress(0), 1), 'primary is not fully present on its first frame');
primary.update(15.999);
assert(close(primary.progress(15.999), 1), 'primary faded before its recurring 4-bar pulse');
primary.update(16);
assert(close(primary.progress(16), 1), 'primary blinked at its recurring 4-bar pulse');

// E(1,4) with offset 1 opens on bar-index 3: beats [12,16), the fourth bar
// of each 16-beat phrase. It must be a true no-op everywhere else.
const rest = new Layer(restSpec, rave.seed);
rest.update(0);
assert(close(rest.progress(0), 0), 'phrase rest incorrectly opens in bar 1');
rest.update(11.999);
assert(close(rest.progress(11.999), 0), 'phrase rest opens before bar 4');
rest.update(12);
assert(close(rest.progress(12), 1), 'phrase rest does not open on bar 4 downbeat');
rest.update(15.999);
assert(close(rest.progress(15.999), 1), 'phrase rest does not hold through bar 4');
rest.update(16);
assert(close(rest.progress(16), 0), 'phrase rest leaks into the next phrase');
rest.update(28);
assert(close(rest.progress(28), 1), 'phrase rest does not recur on the next phrase bar 4');

// Frame-rate independence: sampling the same musical positions at common
// presentation rates must yield the same gate state. The scheduler is in beats,
// not frames or seconds.
for (const fps of [30, 60, 120, 165]) {
  const layer = new Layer(restSpec, rave.seed);
  const bpm = 128;
  const beatsPerFrame = bpm / (60 * fps);
  let atBar4 = 0;
  let outside = 0;
  for (let frame = 0; frame <= Math.ceil((16.25 / beatsPerFrame)); frame++) {
    const beat = frame * beatsPerFrame;
    layer.update(beat);
    const p = layer.progress(beat);
    if (beat >= 12 && beat < 16) atBar4 += p > 0.999 ? 1 : 0;
    if (beat < 11.9 || beat > 16.1) outside += p > 1e-6 ? 1 : 0;
  }
  assert(atBar4 > 0, `${fps}fps never observes the fourth-bar rest`);
  assert(outside === 0, `${fps}fps observes phrase-rest outside the fourth bar`);
}

// Clifford is bounded for every coefficient but is not visually chaotic for
// every coefficient. The old default drive crossed periodic windows and made
// 96k independent points converge to a handful of tiny rings. Approximate the
// shader's f32 map over the complete reachable default-a interval and require
// broad endpoint occupancy. This is deterministic and needs no GPU.
function cliffordDefault(key: string): number {
  const value = CLIFFORD_DEFAULTS[key];
  assert(typeof value === 'number', `Clifford default ${key} is not numeric`);
  return value;
}

const f32 = Math.fround;
const positiveFract = (value: number): number => value - Math.floor(value);

function cliffordHash11(value: number): number {
  let x = f32(positiveFract(f32(value * 0.1031)));
  x = f32(x * f32(x + 33.33));
  return positiveFract(f32(f32(x + x) * x));
}

function cliffordEndpointOccupancy(a: number): number {
  const bins = new Set<string>();
  const pa = f32(a);
  const pb = f32(cliffordDefault('b'));
  const pc = f32(cliffordDefault('c'));
  const pd = f32(cliffordDefault('d'));
  for (let seed = 0; seed < 64; seed++) {
    let x = f32((cliffordHash11(f32(seed + 0.13)) - 0.5) * 2);
    let y = f32((cliffordHash11(f32(seed + 7.71)) - 0.5) * 2);
    for (let iteration = 0; iteration < 512; iteration++) {
      const nextX = f32(
        f32(Math.sin(f32(pa * y))) + f32(pc * Math.cos(f32(pa * x))),
      );
      const nextY = f32(
        f32(Math.sin(f32(pb * x))) + f32(pd * Math.cos(f32(pb * y))),
      );
      x = nextX;
      y = nextY;
    }
    // One-percent-of-map bins distinguish a density field from a short cycle
    // without depending on exact transcendental results across JS engines.
    bins.add(`${Math.round(x * 100)},${Math.round(y * 100)}`);
  }
  return bins.size;
}

const aBase = cliffordDefault('aBase');
const aHigh = cliffordDefault('aHigh');
const aPulse = cliffordDefault('aPulse');
const aMin = aBase + Math.min(0, aHigh) + Math.min(0, aPulse);
const aMax = aBase + Math.max(0, aHigh) + Math.max(0, aPulse);
for (let sample = 0; sample <= 12; sample++) {
  const a = aMin + (aMax - aMin) * sample / 12;
  const occupancy = cliffordEndpointOccupancy(a);
  assert(
    occupancy >= 56,
    `Clifford default drive collapses at a=${a.toFixed(3)} (${occupancy}/64 endpoint bins)`,
  );
}

console.log(
  'visual-v2-runtime-check: PASS ' +
  '(continuous primary; exact fourth-bar rest; 30/60/120/165fps; Clifford chaotic corridor)',
);
