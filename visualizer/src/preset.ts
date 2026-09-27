// Preset serialisation: JSON in, JSON out, plus the URL-hash form used for
// sharing (Phase 3).
//
// The job of this file is to be the ONLY door into the engine for untrusted
// data. A preset arrives from localStorage written by a build that no longer
// exists, or from a URL someone edited by hand, and by the time it reaches the
// layer graph it must either be a valid `Preset` or have thrown. There is no
// third state — a half-validated preset renders a black frame, and a black
// frame is indistinguishable from a shader bug, a muted stack, an opacity of
// zero and a device loss. Rejecting loudly at the door is worth more than every
// tolerant fallback that could be written here.
//
// The second job is determinism (§4.7). `serialise` writes fields in a fixed
// order and normalises every number, so the same preset produces the same bytes
// on every machine and every run. That is what makes "saved and reloaded
// pixel-identically" (Phase 3 DoD) testable by comparing strings rather than
// pixels.
//
// What it deliberately does NOT do: supply default presets (that belongs to
// whoever owns the four looks of the art direction), touch the DOM beyond
// reading and writing `location.hash` on request, or know what any layer type
// means. It validates SHAPE and enumerations, not taste.

import {
  type Anchor,
  type BlendMode,
  type Envelope,
  type LayerFamily,
  type LayerSpec,
  type Palette,
  type PaletteColor,
  type PaletteSlot,
  type PaletteStop,
  type ParamValue,
  type Preset,
  PRESET_VERSION,
  type TriggerSpec,
  migrate,
} from './contracts.ts';
import { DIVISIONS, type DivisionName } from './clock.ts';

/**
 * Thrown for anything structurally wrong. Separate from `PresetVersionError`
 * (which contracts.ts owns) because the two need different UI: a version error
 * means "this build is too old", a validation error means "this file is broken".
 */
export class PresetError extends Error {}

// ---------------------------------------------------------------------------
// Accepted enumerations
//
// Listed explicitly rather than derived from the types, because TypeScript
// unions do not survive to runtime and the alternative is a cast that accepts
// anything. Adding a family or a blend mode means editing here as well as
// contracts.ts, and that is the intended friction: an unlisted value must fail
// rather than reach a `switch` that has no case for it.
// ---------------------------------------------------------------------------

const FAMILIES: readonly LayerFamily[] = ['source', 'warp', 'color', 'feedback', 'operator'];

const BLENDS: readonly BlendMode[] = [
  'replace', 'add', 'max', 'min', '50/50',
  'subtract', 'multiply', 'xor', 'adjustable', 'alpha',
];

const ANCHORS: readonly Anchor[] = ['start', 'peak', 'end'];

const SLOTS: readonly PaletteSlot[] = ['bg', 'primary', 'secondary', 'accent'];

const DIVISION_NAMES = Object.keys(DIVISIONS) as DivisionName[];

// ---------------------------------------------------------------------------
// Field readers
//
// Each one names the path it failed at. "Preset is invalid" costs an hour with
// a 40-layer preset; "layers[7].trigger.euclidN must be an integer >= 1, got 0"
// costs nothing.
// ---------------------------------------------------------------------------

function obj(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new PresetError(`${path} must be an object, got ${describe(v)}.`);
  }
  return v as Record<string, unknown>;
}

function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new PresetError(`${path} must be an array, got ${describe(v)}.`);
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string') throw new PresetError(`${path} must be a string, got ${describe(v)}.`);
  return v;
}

/**
 * Numbers must be FINITE. `NaN` and `Infinity` survive `typeof x === 'number'`,
 * do not survive `JSON.stringify` (they become `null`), and propagate silently
 * through every downstream calculation until a whole layer vanishes. This is
 * the single most valuable check in the file.
 */
function num(v: unknown, path: string, lo = -Infinity, hi = Infinity): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new PresetError(`${path} must be a finite number, got ${describe(v)}.`);
  }
  if (v < lo || v > hi) {
    throw new PresetError(`${path} must be within [${lo}, ${hi}], got ${v}.`);
  }
  return v;
}

function int(v: unknown, path: string, lo = -Infinity, hi = Infinity): number {
  const n = num(v, path, lo, hi);
  if (!Number.isInteger(n)) throw new PresetError(`${path} must be an integer, got ${n}.`);
  return n;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw new PresetError(`${path} must be a boolean, got ${describe(v)}.`);
  return v;
}

function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  const s = str(v, path);
  if (!(allowed as readonly string[]).includes(s)) {
    throw new PresetError(
      `${path} is '${s}', which this build does not know. Expected one of: ${allowed.join(', ')}.`,
    );
  }
  return s as T;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  if (typeof v === 'string') return `'${v}'`;
  return typeof v;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function readEnvelope(v: unknown, path: string): Envelope {
  const o = obj(v, path);
  return {
    attackBeats: num(o['attackBeats'], `${path}.attackBeats`, 0, 256),
    holdBeats: num(o['holdBeats'], `${path}.holdBeats`, 0, 256),
    releaseBeats: num(o['releaseBeats'], `${path}.releaseBeats`, 0, 256),
  };
}

function readTrigger(v: unknown, path: string): TriggerSpec {
  const o = obj(v, path);
  const division = oneOf(o['division'], `${path}.division`, DIVISION_NAMES);
  const euclidN = int(o['euclidN'], `${path}.euclidN`, 1, 256);
  const euclidK = int(o['euclidK'], `${path}.euclidK`, 0, 256);
  if (euclidK > euclidN) {
    throw new PresetError(
      `${path}.euclidK (${euclidK}) exceeds euclidN (${euclidN}). E(k, n) cannot place more onsets than it has steps.`,
    );
  }
  return {
    division,
    euclidK,
    euclidN,
    probability: num(o['probability'], `${path}.probability`, 0, 1),
    offsetSteps: int(o['offsetSteps'], `${path}.offsetSteps`, -1024, 1024),
  };
}

/**
 * The accumulator for a params bag.
 *
 * Null-prototype, and that is not paranoia about prototype pollution — the
 * pollution route is closed already, because a param is only ever a number,
 * boolean or string. It is about SILENT LOSS: `out['__proto__'] = 'x'` on an
 * ordinary object is a no-op that throws nothing and warns nothing, so a layer
 * with a param called `__proto__` would round-trip through save/load with that
 * param quietly gone. A dropped parameter is exactly the class of bug this file
 * exists to make impossible.
 */
function emptyParams(): Record<string, ParamValue> {
  return Object.create(null) as Record<string, ParamValue>;
}

function readParams(v: unknown, path: string): Record<string, ParamValue> {
  const o = obj(v, path);
  const out = emptyParams();
  // Sorted so serialisation is byte-stable regardless of insertion order.
  for (const key of Object.keys(o).sort()) {
    const value = o[key];
    const t = typeof value;
    if (t === 'number') {
      out[key] = num(value, `${path}.${key}`);
    } else if (t === 'boolean' || t === 'string') {
      out[key] = value as ParamValue;
    } else {
      throw new PresetError(
        `${path}.${key} must be a number, boolean or string — preset params are flat so presets stay JSON. Got ${describe(value)}.`,
      );
    }
  }
  return out;
}

function readLayer(v: unknown, path: string): LayerSpec {
  const o = obj(v, path);
  const id = str(o['id'], `${path}.id`);
  if (id.length === 0) {
    throw new PresetError(`${path}.id is empty. IDs seed per-layer variation and must be stable and unique (§4.7).`);
  }
  return {
    id,
    type: str(o['type'], `${path}.type`),
    family: oneOf(o['family'], `${path}.family`, FAMILIES),
    params: readParams(o['params'], `${path}.params`),
    blend: oneOf(o['blend'], `${path}.blend`, BLENDS),
    opacity: num(o['opacity'], `${path}.opacity`, 0, 1),
    envelope: readEnvelope(o['envelope'], `${path}.envelope`),
    trigger: readTrigger(o['trigger'], `${path}.trigger`),
    anchor: oneOf(o['anchor'], `${path}.anchor`, ANCHORS),
    palette: oneOf(o['palette'], `${path}.palette`, SLOTS),
    enabled: bool(o['enabled'], `${path}.enabled`),
    // Upper bound is 1: a layer cannot render above the global render scale,
    // which is itself the one knob that degrades 2K120 gracefully (§4.11).
    resolutionScale: num(o['resolutionScale'], `${path}.resolutionScale`, 0.05, 1),
  };
}

function readColor(v: unknown, path: string): PaletteColor {
  const o = obj(v, path);
  return {
    l: num(o['l'], `${path}.l`, 0, 1),
    c: num(o['c'], `${path}.c`, 0, 0.5),
    h: num(o['h'], `${path}.h`, -360, 720),
    // Above 1.0 is HDR headroom and is what bloom finds. Capped low on purpose:
    // if three layers all exceed 1.0 the frame has no focal point at all
    // (art direction §2.4), so a preset asking for 40x is a mistake, not intent.
    intensity: num(o['intensity'], `${path}.intensity`, 0, 8),
  };
}

function readPalette(v: unknown, path: string): Palette {
  const o = obj(v, path);
  const rawRamp = arr(o['ramp'], `${path}.ramp`);
  const ramp: PaletteStop[] = rawRamp.map((stop, i) => {
    const so = obj(stop, `${path}.ramp[${i}]`);
    return {
      at: num(so['at'], `${path}.ramp[${i}].at`, 0, 1),
      color: readColor(so['color'], `${path}.ramp[${i}].color`),
    };
  });
  // Sorted rather than rejected out of order: a ramp is a set of stops and the
  // order is derivable, so demanding it of the author buys nothing. Sorting is
  // stable, so equal positions keep their authored order and the result is
  // still deterministic.
  ramp.sort((a, b) => a.at - b.at);

  return {
    name: str(o['name'], `${path}.name`),
    bg: readColor(o['bg'], `${path}.bg`),
    primary: readColor(o['primary'], `${path}.primary`),
    secondary: readColor(o['secondary'], `${path}.secondary`),
    accent: readColor(o['accent'], `${path}.accent`),
    ramp,
  };
}

/**
 * Turn already-migrated data into a `Preset`, or throw.
 *
 * Returns a fresh object rather than the input. The input came from
 * `JSON.parse` and carries whatever extra keys the author left in it; keeping
 * it would let an unknown field ride along, get re-serialised, and eventually
 * be mistaken for something this build supports.
 */
export function validate(raw: unknown): Preset {
  const o = obj(raw, 'preset');

  const layers = arr(o['layers'], 'preset.layers').map((l, i) => readLayer(l, `preset.layers[${i}]`));

  // Duplicate IDs are the one cross-layer check worth making here. IDs seed
  // per-layer hashed variation, so two layers sharing one are not merely
  // confusing in the UI — they are visually identical, deterministically, and
  // the user's reasonable conclusion is that the second layer is broken.
  const seen = new Set<string>();
  for (const layer of layers) {
    if (seen.has(layer.id)) {
      throw new PresetError(`preset.layers has two layers with id '${layer.id}'. IDs seed per-layer variation and must be unique.`);
    }
    seen.add(layer.id);
  }

  return {
    version: PRESET_VERSION,
    name: str(o['name'], 'preset.name'),
    seed: int(o['seed'], 'preset.seed', 0, 0xffffffff),
    layers,
    palette: readPalette(o['palette'], 'preset.palette'),
  };
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * Canonical JSON.
 *
 * Built field by field rather than by handing the object to `JSON.stringify`,
 * because object key order in JS is insertion order and a preset that has been
 * edited in the UI has a different insertion order from one that was just
 * loaded. Byte-identical output for equal presets is what lets Phase 3's
 * "saved and reloaded pixel-identically" be asserted with a string comparison
 * instead of a screenshot.
 *
 * `pretty` is for files a human will read; the hash form uses the compact one.
 */
export function serialise(preset: Preset, pretty = false): string {
  const canonical = canonicalise(preset);
  return pretty ? JSON.stringify(canonical, null, 2) : JSON.stringify(canonical);
}

function canonicalise(p: Preset): unknown {
  return {
    version: PRESET_VERSION,
    name: p.name,
    seed: p.seed,
    layers: p.layers.map((l) => ({
      id: l.id,
      type: l.type,
      family: l.family,
      params: sortedParams(l.params),
      blend: l.blend,
      opacity: l.opacity,
      envelope: {
        attackBeats: l.envelope.attackBeats,
        holdBeats: l.envelope.holdBeats,
        releaseBeats: l.envelope.releaseBeats,
      },
      trigger: {
        division: l.trigger.division,
        euclidK: l.trigger.euclidK,
        euclidN: l.trigger.euclidN,
        probability: l.trigger.probability,
        offsetSteps: l.trigger.offsetSteps,
      },
      anchor: l.anchor,
      palette: l.palette,
      enabled: l.enabled,
      resolutionScale: l.resolutionScale,
    })),
    palette: {
      name: p.palette.name,
      bg: colorOf(p.palette.bg),
      primary: colorOf(p.palette.primary),
      secondary: colorOf(p.palette.secondary),
      accent: colorOf(p.palette.accent),
      // Sorted here as well as in `readPalette`, so that `serialise` is
      // idempotent: `serialise(p)` must equal `serialise(deserialise(serialise(p)))`
      // for a preset that was built in memory and never went through a load.
      // Normalising in only one of the two paths is how a round-trip test passes
      // while the actual save/share path still produces two different strings
      // for the same preset.
      ramp: [...p.palette.ramp]
        .sort((a, b) => a.at - b.at)
        .map((s) => ({ at: s.at, color: colorOf(s.color) })),
    },
  };
}

function colorOf(c: PaletteColor): unknown {
  return { l: c.l, c: c.c, h: c.h, intensity: c.intensity };
}

function sortedParams(params: Readonly<Record<string, ParamValue>>): Record<string, ParamValue> {
  const out = emptyParams();
  for (const key of Object.keys(params).sort()) {
    const v = params[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * Parse, migrate, validate. The only supported way in.
 *
 * `migrate` runs BEFORE `validate` because an old preset is legitimately
 * missing fields that this build's validator requires — validating first would
 * reject exactly the presets migration exists to rescue.
 */
export function deserialise(text: string): Preset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new PresetError(`Preset is not valid JSON: ${(err as Error).message}`);
  }
  return validate(migrate(parsed));
}

// ---------------------------------------------------------------------------
// URL hash
// ---------------------------------------------------------------------------

/**
 * base64url of the compact JSON.
 *
 * Not compressed. `CompressionStream('deflate-raw')` would roughly halve it,
 * but it is asynchronous, and making "read the preset out of the URL" an async
 * operation puts a promise in front of the first frame for a saving that only
 * matters past a few kilobytes. Revisit if presets grow past what a browser
 * will carry in a fragment (~64 KB in practice, far more than a 40-layer stack).
 *
 * base64url rather than plain base64 because `+` and `/` are legal in a
 * fragment but survive copy-paste through chat clients and mail readers
 * unpredictably, and `=` padding is the classic thing a URL shortener eats.
 */
export function encodeHash(preset: Preset): string {
  const json = serialise(preset);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  // Chunked: spreading a large array into String.fromCharCode blows the
  // argument limit somewhere around 100k entries, and it does it as a
  // RangeError at the worst possible moment rather than at build time.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeHash(hash: string): Preset {
  const clean = hash.replace(/^#/, '').trim();
  if (clean.length === 0) throw new PresetError('No preset in the URL hash.');

  const b64 = clean.replace(/-/g, '+').replace(/_/g, '/');
  // btoa/atob want the padding back even though the URL form drops it.
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);

  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new PresetError('URL hash is not valid base64url — it was probably truncated in transit.');
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  let json: string;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new PresetError('URL hash did not decode to text.');
  }
  return deserialise(json);
}

/**
 * Read a preset from `location.hash`, or null if there is not one.
 *
 * Null only for "there was nothing there". A hash that IS present and IS broken
 * throws, because silently starting from the default preset when the user
 * clearly pasted a link is the same black-frame ambiguity this file exists to
 * prevent.
 */
export function presetFromLocation(hash: string): Preset | null {
  const clean = hash.replace(/^#/, '').trim();
  if (clean.length === 0) return null;
  return decodeHash(clean);
}
