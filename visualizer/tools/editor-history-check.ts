// AVS editor undo/redo/revert contract (src/avs-editor.ts history).
//
// Drives the exported history pieces against a fake host that edits exactly
// the way src/main.ts does (editor-model patch → serialize → reparse), then
// proves that replaying the recorded undo ops lands byte-for-byte on each
// snapshot, all the way back to the loaded preset, and that redo returns to
// the edited bytes. A sabotaged undo op must be caught by the byte oracle.
//
// Run: node tools/run-editor-history-check.mjs. Exits non-zero on regression.

import {
  AVS_EDITOR_HISTORY_LIMIT,
  AvsEditorHistory,
  applyAvsEditorHistoryOp,
  avsBytesEqual,
  avsEditorHistoryOps,
  avsMovedPath,
  buildAvsEditorModel,
  type AvsEditorCallbacks,
  type AvsEditorHistoryEntry,
  type AvsEditorTrackedChange,
} from '../src/avs-editor.ts';
import {
  AVS_PRESET_HEADER_V2,
  createAvsEditorModel,
  findAvsEditorNode,
  parseAvsPreset,
  patchAvsEditorNodeFields,
  patchAvsEditorNodePayload,
  reorderAvsEditorChildren,
  serializeAvsEditorModel,
  setAvsEditorNodeEnabled,
} from '../src/avs/index.ts';
import type { AvsPresetAst } from '../src/avs/types.ts';

let assertions = 0;
function assert(condition: unknown, label: string): void {
  assertions++;
  if (!condition) throw new Error(`editor-history-check: ${label}`);
}

// --- fixture: [Effect List [Blur, Mystery APE], Blur] -----------------------
const blurPayload = i32Payload([2, 1]);
const apePayload = Uint8Array.of(9, 8, 7, 6, 5);
const listPayload = concatenate([
  Uint8Array.of(0),
  rendererRecord(6, null, blurPayload),
  rendererRecord(16_384, 'Mystery APE', apePayload),
  Uint8Array.of(0, 0, 0),
]);
const source = concatenate([
  latin1(AVS_PRESET_HEADER_V2),
  Uint8Array.of(1),
  rendererRecord(-2, null, listPayload),
  rendererRecord(6, null, i32Payload([1, 0])),
]);

// --- fake host: the same edit paths main.ts wires into the editor ------------
let bytes = source;
let preset: AvsPresetAst = parseAvsPreset(bytes);
let model = createAvsEditorModel(preset);
function reload(next: Uint8Array): void {
  bytes = next;
  preset = parseAvsPreset(next);
  model = createAvsEditorModel(preset);
}
const host: AvsEditorCallbacks = {
  onPatchPayload: (_component, path, payload) => reload(serializeAvsEditorModel(patchAvsEditorNodePayload(model, path, payload))),
  onPatchFields: (_component, path, patch) => reload(serializeAvsEditorModel(patchAvsEditorNodeFields(model, path, patch))),
  onSetEnabled: (component, path, enabled) => {
    if (component.list) reload(serializeAvsEditorModel(setAvsEditorNodeEnabled(model, path, enabled)));
  },
  onMove: (_component, path, parentPath, direction) => {
    const siblings = parentPath === null ? model.nodes : findAvsEditorNode(model, parentPath)?.children ?? [];
    const from = siblings.findIndex((node) => node.path === path);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= siblings.length) return;
    const order = siblings.map((node) => node.path);
    [order[from], order[to]] = [order[to]!, order[from]!];
    reload(serializeAvsEditorModel(reorderAvsEditorChildren(model, parentPath, order)));
  },
};

const history = new AvsEditorHistory();

/** What AvsEditor.trackEdit does, minus the DOM. */
function edit(label: string, path: string, change: AvsEditorTrackedChange, run: () => void): boolean {
  const node = buildAvsEditorModel(preset).flatNodes.find((candidate) => candidate.path === path);
  assert(node, `fixture has ${path}`);
  const before = bytes;
  const beforePayload = node!.component.payload.slice();
  run();
  const ops = avsEditorHistoryOps(change, node!, beforePayload, preset);
  assert(ops, `ops for ${label}`);
  return history.record({ label, ...ops!, before, after: bytes });
}

function nodeAt(path: string) {
  return buildAvsEditorModel(preset).flatNodes.find((candidate) => candidate.path === path)!;
}

// --- pure helpers -------------------------------------------------------------
assert(avsMovedPath(null, 2, 1) === '3' && avsMovedPath('1', 2, -1) === '1.1', 'moved path arithmetic');
assert(avsBytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2)) && !avsBytesEqual(Uint8Array.of(1), Uint8Array.of(2)), 'byte equality');

// --- record four real edits and one no-op --------------------------------------
assert(edit('blur fields', '1.1', { kind: 'payload' },
  () => host.onPatchFields!(nodeAt('1.1').component, '1.1', { kind: 'blur', mode: 3, roundUp: true })), 'field edit recorded');
assert(edit('move blur down', '1.1', { kind: 'move', direction: 1 },
  () => host.onMove!(nodeAt('1.1').component, '1.1', '1', 1)), 'move recorded');
assert(edit('patch APE payload', '1.1', { kind: 'payload' },
  () => host.onPatchPayload!(nodeAt('1.1').component, '1.1', Uint8Array.of(1, 2, 3))), 'payload patch recorded');
assert(edit('disable list', '1', { kind: 'list-enabled', enabled: false },
  () => host.onSetEnabled!(nodeAt('1').component, '1', false)), 'list power recorded');
assert(!edit('no-op payload', '2', { kind: 'payload' },
  () => host.onPatchPayload!(nodeAt('2').component, '2', nodeAt('2').component.payload.slice())), 'identical bytes are not a history step');
assert(history.undoDepth === 4 && history.redoDepth === 0, 'four steps recorded');
assert(!avsBytesEqual(bytes, source), 'edits changed the preset');
const edited = bytes;

// --- undo every step: each lands exactly on its snapshot, the last on the source
const undone: AvsEditorHistoryEntry[] = [];
for (let entry = history.peekUndo(); entry; entry = history.peekUndo()) {
  await applyAvsEditorHistoryOp(entry.undo, preset, host);
  history.commitUndo();
  assert(avsBytesEqual(bytes, entry.before), `undo "${entry.label}" restores its before-bytes exactly`);
  undone.push(entry);
}
assert(avsBytesEqual(bytes, source), 'undoing everything reverts to the loaded bytes');
assert(history.redoDepth === 4 && history.canReplayToLoaded, 'revert-by-replay leaves the run on the redo stack');

// --- redo every step back to the edited bytes -----------------------------------
for (let entry = history.peekRedo(); entry; entry = history.peekRedo()) {
  await applyAvsEditorHistoryOp(entry.redo, preset, host);
  history.commitRedo();
  assert(avsBytesEqual(bytes, entry.after), `redo "${entry.label}" restores its after-bytes exactly`);
}
assert(avsBytesEqual(bytes, edited), 'redo returns to the edited preset');

// --- a new edit clears redo ------------------------------------------------------
await applyAvsEditorHistoryOp(history.peekUndo()!.undo, preset, host);
history.commitUndo();
assert(history.redoDepth === 1, 'one step undone');
assert(edit('patch top-level blur', '2', { kind: 'payload' },
  () => host.onPatchPayload!(nodeAt('2').component, '2', i32Payload([3, 1]))), 'a fresh edit is recorded after an undo');
assert(history.redoDepth === 0 && history.undoDepth === 4, 'a new edit clears redo');

// --- byte-restore hook: exact, no replay ------------------------------------------
{
  let restored: Uint8Array | null = null;
  await applyAvsEditorHistoryOp({ kind: 'bytes', bytes: source }, preset, { onRestoreBytes: (next) => { restored = next; } });
  assert(restored && avsBytesEqual(restored, source) && restored !== source, 'bytes op hands the host an exact copy');
  let threw = false;
  try { await applyAvsEditorHistoryOp({ kind: 'bytes', bytes: source }, preset, {}); } catch { threw = true; }
  assert(threw, 'bytes op without a restore hook refuses rather than guessing');
}

// --- NEGATIVE: the byte oracle catches a wrong inverse -----------------------------
{
  reload(source);
  const node = nodeAt('1.1');
  const before = bytes;
  host.onMove!(node.component, '1.1', '1', 1);
  // Sabotage: "undo" the move by repeating it instead of inverting it.
  const wrong = { kind: 'move', path: avsMovedPath('1', 1, 1), parentPath: '1', direction: 1 } as const;
  await applyAvsEditorHistoryOp(wrong, preset, host);
  assert(!avsBytesEqual(bytes, before), 'negative: a non-inverse undo is detectable by the byte snapshot');
  let threw = false;
  try { await applyAvsEditorHistoryOp({ kind: 'payload', path: '9.9', payload: new Uint8Array() }, preset, host); } catch { threw = true; }
  assert(threw, 'undo against a vanished path throws instead of patching something else');
}

// --- bound -------------------------------------------------------------------------
{
  const bounded = new AvsEditorHistory(4);
  for (let i = 0; i < 7; i++) {
    bounded.record({ label: `step ${i}`, undo: { kind: 'bytes', bytes: Uint8Array.of(i) }, redo: { kind: 'bytes', bytes: Uint8Array.of(i + 1) },
      before: Uint8Array.of(i), after: Uint8Array.of(i + 1) });
  }
  assert(bounded.undoDepth === 4 && bounded.dropped === 3, 'history is bounded and counts dropped steps');
  assert(!bounded.canReplayToLoaded, 'past the bound, replay can no longer reach the loaded preset');
  bounded.reset();
  assert(bounded.undoDepth === 0 && bounded.canReplayToLoaded, 'reset clears the floor');
  assert(AVS_EDITOR_HISTORY_LIMIT >= 32, 'default bound is generous');
}

console.log(`editor-history-check: PASS (${assertions} assertions)`);

// ---------------------------------------------------------------------------

function rendererRecord(effectId: number, apeId: string | null, payload: Uint8Array): Uint8Array {
  const headerLength = apeId === null ? 8 : 40;
  const output = new Uint8Array(headerLength + payload.length);
  const view = new DataView(output.buffer);
  view.setInt32(0, effectId, true);
  let lengthOffset = 4;
  if (apeId !== null) {
    output.set(latin1(apeId).subarray(0, 31), 4);
    lengthOffset = 36;
  }
  view.setUint32(lengthOffset, payload.length, true);
  output.set(payload, headerLength);
  return output;
}

function i32Payload(values: readonly number[]): Uint8Array {
  const output = new Uint8Array(values.length * 4);
  const view = new DataView(output.buffer);
  values.forEach((value, index) => view.setInt32(index * 4, value, true));
  return output;
}

function latin1(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0) & 255);
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
