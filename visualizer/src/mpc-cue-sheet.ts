/** Portable cue sheets (docs/design/TIMING-SYSTEM-V2.md 5.7, CONTRACT 2.2.7 and 2.3.2).
 * One JSON text carries a repeatable scene timing, the transition-timing settings that go with it and a short note, so a show can be moved
 * between machines and between MPC-HC and the Player through the clipboard. Presets are referenced by sha256 only: no path, title, tag or
 * rating ever leaves the machine, and a hash the importing catalogue does not hold is dropped and counted. Pure: no DOM, no clipboard, no clocks.
 *
 *   {"format":"aaavs-cue-sheet","version":1,"name":"...","timing":{...},"fade":{...},"note":"..."}
 *
 * Import refuses more than 256 KiB, anything that is not that format, a `version` above 1, and any object key named `__proto__` or
 * `constructor`; unknown keys are dropped; every timing rule is the setup file's (`parseSceneTiming`), so a sheet can never carry a clock a
 * setup could not.
 */
import { DURATION_MS_MAX, DURATION_MS_MIN, FADE_ANCHOR_COUNT, FADE_RANDOM_SET_ALL, FADE_RANDOM_SET_MIN, FADE_TIMING_COUNT } from './mpc-contract.ts';
import { MAX_SCENE_CUES, MAX_SCRIPT, parseSceneTiming, type SceneTiming, type ScriptedCue, type SessionSceneCue } from './mpc-scene-clock.ts';
import { tidyTiming } from './mpc-timing-tools.ts';

export const CUE_SHEET_FORMAT = 'aaavs-cue-sheet';
export const CUE_SHEET_VERSION = 1;
export const CUE_SHEET_MAX_BYTES = 256 * 1024;
export const CUE_NAME_MAX = 120, CUE_NOTE_MAX = 200;

/** The transition-timing settings a sheet may carry (the four `SetupSettings` fields that shape a fade, plus the Seconds length). */
export interface CueSheetFade { fadeTiming: number; fadeRandomSet: number; fadeAnchor: number; durationMs: number }
export interface CueSheetInput { name?: string; timing: SceneTiming; fade?: CueSheetFade; note?: string }
export interface CueSheetImport { timing: SceneTiming; fade?: CueSheetFade; name?: string; note?: string; dropped: number }

const HASH = /^[0-9a-f]{64}$/;
// C0 and C1 controls, DEL and the Unicode line and paragraph separators.
const CONTROL = new RegExp(`[\u0000-\u001f\u007f-\u009f${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
const isInt = (value: unknown, low: number, high: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high;

function utf8Length(text: string): number {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3; }
  return bytes;
}

/** A text field: control characters are removed; over-long or non-text values are an error naming the field. */
function textField(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw Error(`Cue sheet ${label} must be text of at most ${max} characters`);
  const clean = value.replace(CONTROL, '').trim();
  if (clean.length > max) throw Error(`Cue sheet ${label} must be text of at most ${max} characters`);
  return clean;
}

function fadeFields(value: unknown): CueSheetFade {
  const f = value as Record<string, unknown> | null;
  if (!f || typeof f !== 'object' || Array.isArray(f) || !isInt(f.fadeTiming, 0, FADE_TIMING_COUNT - 1) || !isInt(f.fadeRandomSet, FADE_RANDOM_SET_MIN, FADE_RANDOM_SET_ALL)
    || !isInt(f.fadeAnchor, 0, FADE_ANCHOR_COUNT - 1) || !isInt(f.durationMs, DURATION_MS_MIN, DURATION_MS_MAX)) throw Error('Cue sheet fade settings are missing or out of range');
  return { fadeTiming: f.fadeTiming, fadeRandomSet: f.fadeRandomSet, fadeAnchor: f.fadeAnchor, durationMs: f.durationMs };
}

/** Serialise a cue sheet. The timing is validated exactly like a saved setup's (an invalid draft throws its specific message); the result is at most
 * 256 KiB. Layout: one key per line, values compact, so a text area shows it readably. */
export function exportCueSheet(input: CueSheetInput): string {
  if (!input || typeof input !== 'object' || input.timing === undefined) throw Error('Nothing to export');
  const timing = parseSceneTiming(input.timing);
  const parts = [`"format":${JSON.stringify(CUE_SHEET_FORMAT)},"version":${CUE_SHEET_VERSION}`];
  if (input.name !== undefined) { const name = textField(input.name, 'name', CUE_NAME_MAX); if (name) parts.push(`\n "name":${JSON.stringify(name)}`); }
  parts.push(`\n "timing":${JSON.stringify(timing)}`);
  if (input.fade !== undefined) parts.push(`\n "fade":${JSON.stringify(fadeFields(input.fade))}`);
  if (input.note !== undefined) { const note = textField(input.note, 'note', CUE_NOTE_MAX); if (note) parts.push(`\n "note":${JSON.stringify(note)}`); }
  const text = `{${parts.join(',')}}`;
  if (utf8Length(text) > CUE_SHEET_MAX_BYTES) throw Error('This cue sheet is larger than 256 KiB');
  return text;
}

/** Read a cue sheet. `resolve` maps a preset sha256 to its index in the importing catalogue (undefined when it holds none); script entries whose
 * preset it does not know are dropped and counted in `dropped`. The returned timing has passed `parseSceneTiming`, so it is safe to adopt as the draft;
 * `fade`, `name` and `note` are present only when the sheet carried valid ones. Throws an Error with a plain message for every refusal. */
export function importCueSheet(text: string, resolve: (sha256: string) => number | undefined): CueSheetImport {
  if (typeof text !== 'string') throw Error('A cue sheet is text');
  if (utf8Length(text) > CUE_SHEET_MAX_BYTES) throw Error('A cue sheet is limited to 256 KiB');
  let doc: unknown;
  try {
    doc = JSON.parse(text, (key, value) => {
      if (key === '__proto__' || key === 'constructor') throw new SyntaxError('forbidden key');
      return value;
    });
  } catch (error) {
    throw Error(error instanceof SyntaxError && error.message === 'forbidden key' ? 'This cue sheet contains a forbidden key' : 'This is not valid JSON');
  }
  const d = doc as Record<string, unknown> | null;
  if (!d || typeof d !== 'object' || Array.isArray(d) || d.format !== CUE_SHEET_FORMAT) throw Error('This is not an AAAVS cue sheet');
  if (typeof d.version !== 'number' || !Number.isInteger(d.version) || d.version < 1) throw Error('This cue sheet has no valid version');
  if (d.version > CUE_SHEET_VERSION) throw Error(`This cue sheet is version ${d.version}; this build reads version ${CUE_SHEET_VERSION}. Update the application to import it.`);
  if (d.timing === undefined) throw Error('This cue sheet has no timing');
  const parsed = parseSceneTiming(d.timing);
  let dropped = 0;
  let timing: SceneTiming = parsed;
  if (parsed.script) {
    const known: ScriptedCue[] = [];
    for (const cue of parsed.script) {
      const index = resolve(cue.preset);
      if (Number.isSafeInteger(index) && (index as number) >= 0) known.push({ ordinal: cue.ordinal, preset: cue.preset }); else dropped++;
    }
    const next = { ...parsed } as SceneTiming & Record<string, unknown>;
    if (known.length) next.script = known;
    else {
      // The parser's own minimal form: with no v2 field left, the version goes too.
      delete next.script;
      if (!['beatsPerBar', 'barsPattern', 'patternHold', 'tempoMap', 'intervals'].some(key => next[key] !== undefined)) delete next.version;
    }
    timing = next;
  }
  const result: CueSheetImport = { timing, dropped };
  if (d.fade !== undefined) result.fade = fadeFields(d.fade);
  if (d.name !== undefined) { const name = textField(d.name, 'name', CUE_NAME_MAX); if (name) result.name = name; }
  if (d.note !== undefined) { const note = textField(d.note, 'note', CUE_NOTE_MAX); if (note) result.note = note; }
  return result;
}

/** The session cues a script contributes on activation: one `{ordinal, index}` per entry whose preset the catalogue and the active pool hold.
 * `pool` is the active setup's order (catalog indices); an index outside it is dropped, since the clock only cues presets it can play.
 * Ordinals are the script's own (strictly increasing), so the result is valid input for `SceneClock.at` and for `scheduleSceneCue`, which
 * appends live choices under the same 1024-cue budget. */
export function sceneCuesFromScript(script: readonly ScriptedCue[] | undefined, resolve: (sha256: string) => number | undefined, pool?: readonly number[] | ReadonlySet<number>): SessionSceneCue[] {
  if (!script?.length) return [];
  const members = pool === undefined ? null : pool instanceof Set ? pool : new Set(pool);
  const cues: SessionSceneCue[] = [];
  for (const cue of script) {
    if (cues.length >= MAX_SCENE_CUES) break;
    const index = resolve(cue.preset);
    if (Number.isSafeInteger(index) && (index as number) >= 0 && (!members || members.has(index as number))) cues.push({ ordinal: cue.ordinal, index: index as number });
  }
  return cues;
}

/** "Bake session choices into script": merge the session's manual cues into the timing's script as sha256 entries (a session cue wins over a
 * script entry for the same ordinal). `hashOf` maps a catalog index to its sha256; a cue it cannot name is dropped. The script keeps at most 1024
 * entries (the earliest ordinals); entries beyond it are dropped. Returns a new timing (tidy) and how many cues were dropped. */
export function bakeSessionCues(timing: SceneTiming, cues: readonly SessionSceneCue[], hashOf: (index: number) => string | undefined): { timing: SceneTiming; dropped: number } {
  const byOrdinal = new Map<number, string>();
  for (const cue of timing.script ?? []) byOrdinal.set(cue.ordinal, cue.preset);
  let dropped = 0;
  for (const cue of cues) {
    const hash = hashOf(cue.index);
    if (typeof hash === 'string' && HASH.test(hash) && Number.isSafeInteger(cue.ordinal) && cue.ordinal >= 0) byOrdinal.set(cue.ordinal, hash); else dropped++;
  }
  const merged = [...byOrdinal].sort((a, b) => a[0] - b[0]);
  if (merged.length > MAX_SCRIPT) { dropped += merged.length - MAX_SCRIPT; merged.length = MAX_SCRIPT; }
  const next: SceneTiming = { ...timing };
  if (merged.length) next.script = merged.map(([ordinal, preset]) => ({ ordinal, preset })); else delete next.script;
  return { timing: tidyTiming(next), dropped };
}
