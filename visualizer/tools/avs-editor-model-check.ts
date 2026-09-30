import {
  AVS_PRESET_HEADER_V2,
  AvsCompatibilityRuntime,
  createAvsEditorModel,
  findAvsEditorNode,
  parseAvsPreset,
  patchAvsEditorNodeFields,
  patchAvsEditorNodePayload,
  reorderAvsEditorChildren,
  serializeAvsEditorModel,
  setAvsEditorNodeEnabled,
} from '../src/avs/index.ts';

let checks = 0;
const blurPayload = i32Payload([2, 1]);
const opaquePayload = Uint8Array.of(9, 8, 7, 6, 5);
const nestedPayload = concatenate([
  Uint8Array.of(0),
  rendererRecord(6, null, blurPayload),
  rendererRecord(16_384, 'Mystery APE', opaquePayload),
  Uint8Array.of(0, 0, 0),
]);
const source = concatenate([
  latin1(AVS_PRESET_HEADER_V2),
  Uint8Array.of(1),
  rendererRecord(-2, null, nestedPayload),
]);

const parsed = parseAvsPreset(source);
const model = createAvsEditorModel(parsed);
bytesEqual(serializeAvsEditorModel(model), source, 'unchanged model serializes byte-for-byte');
equal(model.nodes[0]?.rendererName, 'Effect List', 'human Effect List name');
equal(model.nodes[0]?.summary, 'Enabled · 2 renderers', 'Effect List summary');
equal(findAvsEditorNode(model, '1.1')?.rendererName, 'Blur', 'human built-in name');
equal(findAvsEditorNode(model, '1.1')?.summary, 'Light · round up', 'decoded Blur summary');
equal(findAvsEditorNode(model, '1.2')?.inspection.kind, 'opaque', 'unknown APE remains opaque');
bytesEqual(findAvsEditorNode(model, '1.2')!.payload, opaquePayload, 'unknown payload preserved');

const disabled = setAvsEditorNodeEnabled(model, '1', false);
equal(model.nodes[0]?.enabled, true, 'enable edit does not mutate original model');
equal(disabled.nodes[0]?.enabled, false, 'enable edit returns updated model');
const disabledRoundTrip = parseAvsPreset(serializeAvsEditorModel(disabled));
equal(disabledRoundTrip.components[0]?.list?.enabled, false, 'disabled list reparses disabled');
bytesEqual(disabledRoundTrip.components[0]!.children[1]!.payload, opaquePayload, 'enable edit preserves opaque child');

const reordered = reorderAvsEditorChildren(model, '1', ['1.2', '1.1']);
equal(reordered.nodes[0]?.children[0]?.path, '1.2', 'stable path follows reordered node');
equal(model.nodes[0]?.children[0]?.path, '1.1', 'reorder does not mutate original model');
const reorderedBytes = serializeAvsEditorModel(reordered);
const reorderedRoundTrip = parseAvsPreset(reorderedBytes);
equal(reorderedRoundTrip.components[0]?.children[0]?.apeId, 'Mystery APE', 'reordered APE is first after parse');
equal(reorderedRoundTrip.components[0]?.children[1]?.effectId, 6, 'reordered Blur is second after parse');
bytesEqual(reorderedRoundTrip.components[0]!.children[0]!.payload, opaquePayload, 'reorder preserves opaque bytes');
bytesEqual(reorderedRoundTrip.components[0]!.payload.slice(-3), Uint8Array.of(0, 0, 0), 'reorder preserves list tail');

const heavyPayload = i32Payload([3, 0]);
const patched = patchAvsEditorNodePayload(model, '1.1', heavyPayload);
equal(findAvsEditorNode(patched, '1.1')?.summary, 'Heavy', 'payload patch refreshes inspector summary');
bytesEqual(findAvsEditorNode(model, '1.1')!.payload, blurPayload, 'payload patch does not mutate original bytes');
bytesEqual(
  parseAvsPreset(serializeAvsEditorModel(patched)).components[0]!.children[0]!.payload,
  heavyPayload,
  'leaf payload patch round-trips exactly',
);
throws(() => setAvsEditorNodeEnabled(model, '1.2', false), 'opaque leaf enable is rejected');
throws(() => reorderAvsEditorChildren(model, '1', ['1.1']), 'partial reorder is rejected');

const blurFieldsSource = modelForRenderer(6, concatenate([i32Payload([1, 0]), Uint8Array.of(0xde, 0xad)]));
const blurFields = patchAvsEditorNodeFields(blurFieldsSource, '1', { kind: 'blur', mode: 3, roundUp: true });
equal(findAvsEditorNode(blurFields, '1')?.summary, 'Heavy · round up', 'typed Blur patch refreshes summary');
bytesEqual(findAvsEditorNode(blurFields, '1')!.payload.slice(8), Uint8Array.of(0xde, 0xad), 'typed Blur patch preserves unknown tail');
bytesEqual(findAvsEditorNode(blurFieldsSource, '1')!.payload.slice(0, 8), i32Payload([1, 0]), 'typed Blur patch is immutable');
const beforeBlur = new AvsCompatibilityRuntime(serializeAvsEditorModel(blurFieldsSource), 3, 3);
const afterBlur = new AvsCompatibilityRuntime(serializeAvsEditorModel(blurFields), 3, 3);
beforeBlur.framebuffer.pixels[4] = 0xffffff;
afterBlur.framebuffer.pixels[4] = 0xffffff;
beforeBlur.render();
afterBlur.render();
notEqual(
  framebufferHash(beforeBlur.framebuffer.pixels),
  framebufferHash(afterBlur.framebuffer.pixels),
  'typed leaf field edit changes rendered framebuffer pixels',
);

const bufferSource = modelForRenderer(18, concatenate([i32Payload([0, 0, 0, 128]), Uint8Array.of(0xfa, 0xce)]));
const bufferFields = patchAvsEditorNodeFields(bufferSource, '1', {
  kind: 'buffer-save', direction: 3, buffer: 7, blendMode: 11, adjustableAlpha: 200,
});
const bufferInspection = findAvsEditorNode(bufferFields, '1')!.inspection;
equal(bufferInspection.kind, 'buffer-save', 'typed Buffer Save patch remains decoded');
if (bufferInspection.kind === 'buffer-save') {
  equal(bufferInspection.direction, 3, 'typed Buffer Save direction');
  equal(bufferInspection.buffer, 7, 'typed Buffer Save buffer');
  equal(bufferInspection.blendMode, 11, 'typed Buffer Save blend');
  equal(bufferInspection.adjustableAlpha, 200, 'typed Buffer Save alpha');
}
bytesEqual(findAvsEditorNode(bufferFields, '1')!.payload.slice(16), Uint8Array.of(0xfa, 0xce), 'typed Buffer Save patch preserves unknown tail');

const renderModeSource = modelForRenderer(40, concatenate([i32Payload([0x81223304]), Uint8Array.of(0xbe, 0xef)]));
const renderModeFields = patchAvsEditorNodeFields(renderModeSource, '1', {
  kind: 'set-render-mode', enabled: false, blendMode: 9, adjustableAlpha: 77, lineWidth: 5,
});
equal(readU32(findAvsEditorNode(renderModeFields, '1')!.payload, 0), 0x01054d09, 'typed Set Render Mode patch changes only known bits');
bytesEqual(findAvsEditorNode(renderModeFields, '1')!.payload.slice(4), Uint8Array.of(0xbe, 0xef), 'typed Set Render Mode patch preserves unknown tail');
const renderModeEnabled = patchAvsEditorNodeFields(renderModeFields, '1', { kind: 'set-render-mode', enabled: true });
equal(readU32(findAvsEditorNode(renderModeEnabled, '1')!.payload, 0), 0x81054d09, 'typed Set Render Mode enable restores only enable bit');

throws(
  () => patchAvsEditorNodeFields(blurFieldsSource, '1', { kind: 'buffer-save', buffer: 1 }),
  'typed patch renderer mismatch is rejected',
);
throws(
  () => patchAvsEditorNodeFields(blurFieldsSource, '1', { kind: 'blur', mode: 9 as 3 }),
  'typed patch range violation is rejected',
);
throws(
  () => patchAvsEditorNodeFields(modelForRenderer(6, Uint8Array.of(1)), '1', { kind: 'blur', mode: 2 }),
  'typed patch truncated payload is rejected',
);

console.log(`avs-editor-model-check: PASS (${checks} assertions)`);

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

function modelForRenderer(effectId: number, payload: Uint8Array) {
  const bytes = concatenate([
    latin1(AVS_PRESET_HEADER_V2),
    Uint8Array.of(0),
    rendererRecord(effectId, null, payload),
  ]);
  return createAvsEditorModel(parseAvsPreset(bytes));
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

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function equal(actual: unknown, expected: unknown, label: string): void {
  checks++;
  if (actual !== expected) throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`);
}

function notEqual(actual: unknown, expected: unknown, label: string): void {
  checks++;
  if (actual === expected) throw new Error(`${label}: both were ${String(actual)}`);
}

function framebufferHash(pixels: Uint32Array): number {
  let hash = 2166136261;
  for (const pixel of pixels) hash = Math.imul(hash ^ pixel, 16777619);
  return hash >>> 0;
}

function bytesEqual(actual: Uint8Array, expected: Uint8Array, label: string): void {
  checks++;
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label}: byte arrays differ (${actual.length} vs ${expected.length})`);
  }
}

function throws(run: () => unknown, label: string): void {
  checks++;
  try { run(); } catch { return; }
  throw new Error(`${label}: expected an exception`);
}
