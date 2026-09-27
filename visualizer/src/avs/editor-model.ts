import {
  AVS_COLOR_MAP_APE_ID,
  AVS_CONVOLUTION_APE_ID,
  AVS_TEXER_APE_ID,
  AVS_TEXER_II_APE_ID,
  decodeAvsColorMap,
  decodeAvsConvolutionConfig,
  decodeAvsDynamicMovement,
  decodeAvsMovement,
  decodeAvsSuperScope,
  decodeAvsTexer2Config,
  decodeAvsTexerConfig,
} from './effects/index.ts';
import { serializeAvsPreset } from './preset.ts';
import type { AvsComponent, AvsEffectListSettings, AvsPresetAst, AvsPresetVersion } from './types.ts';

const BUILTIN_RENDERER_NAMES = [
  'Simple', 'Dot Plane', 'Oscilloscope Star', 'Fade Out', 'Blitter Feedback',
  'OnBeat Clear', 'Blur', 'Bass Spin', 'Moving Particle', 'Roto Blitter',
  'SVP Loader', 'Color Fade', 'Color Clip', 'Rotating Stars', 'Ring',
  'Movement', 'Scatter', 'Dot Grid', 'Buffer Save', 'Dot Fountain', 'Water',
  'Comment', 'Brightness', 'Interleave', 'Grain', 'Clear Screen', 'Mirror',
  'Starfield', 'Text', 'Bump', 'Mosaic', 'Water Bump', 'AVI', 'Custom BPM',
  'Picture', 'Dynamic Distance Modifier', 'SuperScope', 'Invert', 'Unique Tone',
  'Timescope', 'Set Render Mode', 'Interferences', 'Dynamic Shift',
  'Dynamic Movement', 'Fast Brightness', 'Dynamic Color Modifier',
] as const;

export type AvsEditorInspection =
  | { readonly kind: 'effect-list'; readonly settings: AvsEffectListSettings; readonly code: AvsComponent['listCode'] }
  | { readonly kind: 'superscope'; readonly config: ReturnType<typeof decodeAvsSuperScope> }
  | { readonly kind: 'movement'; readonly config: ReturnType<typeof decodeAvsMovement> }
  | { readonly kind: 'dynamic-movement'; readonly config: ReturnType<typeof decodeAvsDynamicMovement> }
  | { readonly kind: 'blur'; readonly mode: number; readonly roundUp: boolean }
  | { readonly kind: 'set-render-mode'; readonly enabled: boolean; readonly blendMode: number; readonly adjustableAlpha: number; readonly lineWidth: number }
  | { readonly kind: 'buffer-save'; readonly direction: number; readonly buffer: number; readonly blendMode: number; readonly adjustableAlpha: number }
  | { readonly kind: 'texer'; readonly config: ReturnType<typeof decodeAvsTexerConfig> }
  | { readonly kind: 'texer-ii'; readonly config: ReturnType<typeof decodeAvsTexer2Config> }
  | { readonly kind: 'convolution'; readonly config: ReturnType<typeof decodeAvsConvolutionConfig> }
  | { readonly kind: 'color-map'; readonly config: ReturnType<typeof decodeAvsColorMap> }
  | { readonly kind: 'opaque'; readonly byteLength: number; readonly decodeError?: string };

export interface AvsEditorNode {
  /** Identity within this editing session. It does not change when siblings move. */
  readonly path: string;
  readonly rendererName: string;
  readonly summary: string;
  readonly effectId: number;
  readonly apeId: string | null;
  readonly enabled: boolean | null;
  readonly payload: Uint8Array;
  readonly inspection: AvsEditorInspection;
  readonly children: readonly AvsEditorNode[];
  /** Original list bytes before and after child records; absent for leaf renderers. */
  readonly listEnvelope: { readonly prefix: Uint8Array; readonly suffix: Uint8Array } | null;
}

export interface AvsEditorModel {
  readonly version: AvsPresetVersion;
  readonly header: string;
  readonly clearEveryFrame: boolean;
  readonly byteLength: number;
  readonly nodes: readonly AvsEditorNode[];
}

export type AvsEditorFieldPatch =
  | {
    readonly kind: 'blur';
    readonly mode?: 0 | 1 | 2 | 3;
    readonly roundUp?: boolean;
  }
  | {
    readonly kind: 'buffer-save';
    readonly direction?: 0 | 1 | 2 | 3;
    readonly buffer?: number;
    readonly blendMode?: number;
    readonly adjustableAlpha?: number;
  }
  | {
    readonly kind: 'set-render-mode';
    readonly enabled?: boolean;
    readonly blendMode?: number;
    readonly adjustableAlpha?: number;
    readonly lineWidth?: number;
  };

/**
 * Build the immutable editor view. Raw payloads remain authoritative, while
 * decoded values are inspector hints supplied by the compatibility decoders.
 */
export function createAvsEditorModel(preset: AvsPresetAst): AvsEditorModel {
  return {
    version: preset.version,
    header: preset.header,
    clearEveryFrame: preset.clearEveryFrame,
    byteLength: preset.byteLength,
    nodes: preset.components.map(componentToNode),
  };
}

/** Losslessly serialize the current model, rebuilding only edited list containers. */
export function serializeAvsEditorModel(model: AvsEditorModel): Uint8Array {
  return serializeAvsPreset({
    version: model.version,
    header: model.header,
    clearEveryFrame: model.clearEveryFrame,
    components: model.nodes.map(nodeToComponent),
    byteLength: model.byteLength,
  });
}

/** Enable or disable an Effect List without changing any unrelated mode bits. */
export function setAvsEditorNodeEnabled(
  model: AvsEditorModel,
  path: string,
  enabled: boolean,
): AvsEditorModel {
  return updateNode(model, path, (node) => {
    if (!node.listEnvelope || node.inspection.kind !== 'effect-list') {
      throw new Error(`Renderer ${path} does not have a source-faithful enable flag`);
    }
    const prefix = node.listEnvelope.prefix.slice();
    const extended = (prefix[0]! & 0x80) !== 0;
    const mode = extended ? readU32(prefix, 1, node.inspection.settings.mode) : prefix[0]!;
    const nextMode = enabled ? mode & ~2 : mode | 2;
    if (extended) writeU32(prefix, 1, nextMode);
    else prefix[0] = nextMode & 255;
    return {
      ...node,
      enabled,
      summary: `${enabled ? 'Enabled' : 'Disabled'} · ${node.children.length} renderer${node.children.length === 1 ? '' : 's'}`,
      listEnvelope: { prefix, suffix: node.listEnvelope.suffix },
      inspection: {
        ...node.inspection,
        settings: { ...node.inspection.settings, mode: nextMode, enabled },
      },
    };
  });
}

/** Replace a leaf renderer payload verbatim and refresh its decoded inspector. */
export function patchAvsEditorNodePayload(
  model: AvsEditorModel,
  path: string,
  payload: Uint8Array,
): AvsEditorModel {
  return updateNode(model, path, (node) => {
    if (node.listEnvelope) throw new Error(`Renderer ${path} is a list; edit its children or enable flag instead`);
    const nextPayload = payload.slice();
    const inspection = inspect(node.effectId, node.apeId, nextPayload, null);
    return { ...node, payload: nextPayload, inspection, summary: inspectionSummary(inspection, 0) };
  });
}

/**
 * Patch source-proven fields without disturbing unrecognized payload bytes.
 * Short legacy payloads are rejected rather than expanded with guessed data.
 */
export function patchAvsEditorNodeFields(
  model: AvsEditorModel,
  path: string,
  patch: AvsEditorFieldPatch,
): AvsEditorModel {
  const node = findAvsEditorNode(model, path);
  if (!node) throw new Error(`Unknown AVS editor path ${path}`);
  if (node.inspection.kind !== patch.kind) {
    throw new Error(`Renderer ${path} is ${node.inspection.kind}, not ${patch.kind}`);
  }
  const payload = node.payload.slice();
  if (patch.kind === 'blur') {
    requirePayload(payload, 8, path, patch.kind);
    if (patch.mode !== undefined) writeI32(payload, 0, integerInRange(patch.mode, 0, 3, 'Blur mode'));
    if (patch.roundUp !== undefined) writeI32(payload, 4, patch.roundUp ? 1 : 0);
  } else if (patch.kind === 'buffer-save') {
    requirePayload(payload, 16, path, patch.kind);
    if (patch.direction !== undefined) writeI32(payload, 0, integerInRange(patch.direction, 0, 3, 'Buffer Save direction'));
    if (patch.buffer !== undefined) writeI32(payload, 4, integerInRange(patch.buffer, 0, 7, 'Buffer Save buffer'));
    if (patch.blendMode !== undefined) writeI32(payload, 8, integerInRange(patch.blendMode, 0, 11, 'Buffer Save blend mode'));
    if (patch.adjustableAlpha !== undefined) writeI32(payload, 12, integerInRange(patch.adjustableAlpha, 0, 255, 'Buffer Save alpha'));
  } else {
    requirePayload(payload, 4, path, patch.kind);
    let mode = readU32(payload, 0, 0);
    if (patch.enabled !== undefined) mode = patch.enabled ? mode | 0x80000000 : mode & 0x7fffffff;
    if (patch.blendMode !== undefined) mode = (mode & 0xffffff00) | integerInRange(patch.blendMode, 0, 9, 'Set Render Mode blend mode');
    if (patch.adjustableAlpha !== undefined) mode = (mode & 0xffff00ff) | (integerInRange(patch.adjustableAlpha, 0, 255, 'Set Render Mode alpha') << 8);
    if (patch.lineWidth !== undefined) mode = (mode & 0xff00ffff) | (integerInRange(patch.lineWidth, 0, 255, 'Set Render Mode line width') << 16);
    writeU32(payload, 0, mode);
  }
  return patchAvsEditorNodePayload(model, path, payload);
}

/** Reorder one sibling set using stable paths; no renderer bytes are rewritten. */
export function reorderAvsEditorChildren(
  model: AvsEditorModel,
  parentPath: string | null,
  orderedPaths: readonly string[],
): AvsEditorModel {
  if (parentPath === null) return { ...model, nodes: reorder(model.nodes, orderedPaths, 'root') };
  return updateNode(model, parentPath, (node) => ({
    ...node,
    children: reorder(node.children, orderedPaths, parentPath),
  }));
}

export function findAvsEditorNode(model: AvsEditorModel, path: string): AvsEditorNode | null {
  const visit = (nodes: readonly AvsEditorNode[]): AvsEditorNode | null => {
    for (const node of nodes) {
      if (node.path === path) return node;
      const child = visit(node.children);
      if (child) return child;
    }
    return null;
  };
  return visit(model.nodes);
}

function componentToNode(component: AvsComponent): AvsEditorNode {
  const children = component.children.map(componentToNode);
  const envelope = component.list ? listEnvelope(component) : null;
  const inspection = inspect(component.effectId, component.apeId, component.payload, component);
  return {
    path: component.path,
    rendererName: rendererName(component.effectId, component.apeId),
    summary: inspectionSummary(inspection, children.length),
    effectId: component.effectId,
    apeId: component.apeId,
    enabled: component.list?.enabled ?? null,
    payload: component.payload.slice(),
    inspection,
    children,
    listEnvelope: envelope,
  };
}

function nodeToComponent(node: AvsEditorNode): AvsComponent {
  const children = node.children.map(nodeToComponent);
  const payload = node.listEnvelope
    ? concatenate([node.listEnvelope.prefix, ...children.map(serializeComponentBytes), node.listEnvelope.suffix])
    : node.payload.slice();
  const settings = node.inspection.kind === 'effect-list' ? node.inspection.settings : null;
  return {
    effectId: node.effectId,
    apeId: node.apeId,
    payload,
    fileOffset: 0,
    path: node.path,
    children,
    list: settings,
    listCode: node.inspection.kind === 'effect-list' ? node.inspection.code : null,
  };
}

function serializeComponentBytes(component: AvsComponent): Uint8Array {
  const ape = component.apeId !== null;
  const headerLength = ape ? 40 : 8;
  const output = new Uint8Array(headerLength + component.payload.length);
  const view = new DataView(output.buffer);
  view.setInt32(0, component.effectId, true);
  let lengthOffset = 4;
  if (ape) {
    for (let index = 0; index < Math.min(31, component.apeId!.length); index++) {
      output[4 + index] = component.apeId!.charCodeAt(index) & 255;
    }
    lengthOffset = 36;
  }
  view.setUint32(lengthOffset, component.payload.length, true);
  output.set(component.payload, headerLength);
  return output;
}

function listEnvelope(component: AvsComponent): { prefix: Uint8Array; suffix: Uint8Array } {
  if (component.children.length === 0) return { prefix: component.payload.slice(), suffix: new Uint8Array() };
  const payloadStart = component.fileOffset + 8;
  const first = component.children[0]!;
  const last = component.children[component.children.length - 1]!;
  const prefixLength = first.fileOffset - payloadStart;
  const lastLength = (last.apeId === null ? 8 : 40) + last.payload.length;
  const suffixOffset = last.fileOffset + lastLength - payloadStart;
  if (prefixLength < 0 || suffixOffset < prefixLength || suffixOffset > component.payload.length) {
    throw new Error(`Effect List ${component.path} has inconsistent source offsets`);
  }
  return {
    prefix: component.payload.slice(0, prefixLength),
    suffix: component.payload.slice(suffixOffset),
  };
}

function inspect(
  effectId: number,
  apeId: string | null,
  payload: Uint8Array,
  component: AvsComponent | null,
): AvsEditorInspection {
  try {
    if (component?.list) return { kind: 'effect-list', settings: component.list, code: component.listCode };
    if (effectId === 6) return { kind: 'blur', mode: readI32(payload, 0, 1), roundUp: readI32(payload, 4, 0) !== 0 };
    if (effectId === 15) return { kind: 'movement', config: decodeAvsMovement(payload) };
    if (effectId === 18) return {
      kind: 'buffer-save', direction: readI32(payload, 0, 0), buffer: readI32(payload, 4, 0),
      blendMode: readI32(payload, 8, 0), adjustableAlpha: readI32(payload, 12, 128),
    };
    if (effectId === 36) return { kind: 'superscope', config: decodeAvsSuperScope(payload) };
    if (effectId === 40) {
      const mode = readU32(payload, 0, 0x80010000);
      return {
        kind: 'set-render-mode', enabled: (mode & 0x80000000) !== 0,
        blendMode: mode & 255, adjustableAlpha: (mode >>> 8) & 255, lineWidth: (mode >>> 16) & 255,
      };
    }
    if (effectId === 43) return { kind: 'dynamic-movement', config: decodeAvsDynamicMovement(payload) };
    if (apeId === AVS_TEXER_APE_ID) return { kind: 'texer', config: decodeAvsTexerConfig(payload) };
    if (apeId === AVS_TEXER_II_APE_ID) return { kind: 'texer-ii', config: decodeAvsTexer2Config(payload) };
    if (apeId === AVS_CONVOLUTION_APE_ID) return { kind: 'convolution', config: decodeAvsConvolutionConfig(payload) };
    if (apeId === AVS_COLOR_MAP_APE_ID) return { kind: 'color-map', config: decodeAvsColorMap(payload) };
  } catch (error) {
    return { kind: 'opaque', byteLength: payload.length, decodeError: error instanceof Error ? error.message : String(error) };
  }
  return { kind: 'opaque', byteLength: payload.length };
}

function rendererName(effectId: number, apeId: string | null): string {
  if (effectId === -2) return 'Effect List';
  if (apeId) return apeId;
  return BUILTIN_RENDERER_NAMES[effectId] ?? `Unknown Renderer ${effectId}`;
}

function inspectionSummary(inspection: AvsEditorInspection, childCount: number): string {
  switch (inspection.kind) {
    case 'effect-list': return `${inspection.settings.enabled ? 'Enabled' : 'Disabled'} · ${childCount} renderer${childCount === 1 ? '' : 's'}`;
    case 'superscope': return `${inspection.config.lines ? 'Lines' : 'Points'} · ${inspection.config.colors.length} color${inspection.config.colors.length === 1 ? '' : 's'}`;
    case 'movement': return `Effect ${inspection.config.effect} · ${inspection.config.subpixel ? 'bilinear' : 'nearest'}${inspection.config.wrap ? ' · wrap' : ''}`;
    case 'dynamic-movement': return `${inspection.config.gridWidth}×${inspection.config.gridHeight} grid · ${inspection.config.bilinear ? 'bilinear' : 'nearest'}`;
    case 'blur': return `${['Off', 'Normal', 'Light', 'Heavy'][inspection.mode] ?? `Mode ${inspection.mode}`}${inspection.roundUp ? ' · round up' : ''}`;
    case 'set-render-mode': return `${inspection.enabled ? 'Enabled' : 'Disabled'} · blend ${inspection.blendMode} · width ${inspection.lineWidth}`;
    case 'buffer-save': return `${inspection.direction === 0 ? 'Save to' : inspection.direction === 1 ? 'Restore from' : 'Alternate'} buffer ${inspection.buffer + 1}`;
    case 'texer': return `${inspection.config.image || 'No bitmap'} · ${inspection.config.particles} particles`;
    case 'texer-ii': return `${inspection.config.image || 'Embedded bitmap'}${inspection.config.resize ? ' · resize' : ''}${inspection.config.wrap ? ' · wrap' : ''}`;
    case 'convolution': return `7×7 kernel · scale ${inspection.config.scale}${inspection.config.twoPass ? ' · two pass' : ''}`;
    case 'color-map': {
      const active = inspection.config.maps.filter((map) => map.enabled).length;
      return `${active} active map${active === 1 ? '' : 's'} · blend ${inspection.config.blendMode}`;
    }
    case 'opaque': return `${inspection.byteLength} raw byte${inspection.byteLength === 1 ? '' : 's'}`;
  }
}

function updateNode(
  model: AvsEditorModel,
  path: string,
  update: (node: AvsEditorNode) => AvsEditorNode,
): AvsEditorModel {
  let found = false;
  const visit = (nodes: readonly AvsEditorNode[]): readonly AvsEditorNode[] => nodes.map((node) => {
    if (node.path === path) { found = true; return update(node); }
    const children = visit(node.children);
    return children === node.children ? node : { ...node, children };
  });
  const nodes = visit(model.nodes);
  if (!found) throw new Error(`Unknown AVS editor path ${path}`);
  return { ...model, nodes };
}

function reorder(nodes: readonly AvsEditorNode[], order: readonly string[], parent: string): readonly AvsEditorNode[] {
  if (nodes.length !== order.length || new Set(order).size !== order.length) {
    throw new Error(`Reorder for ${parent} must contain every child path exactly once`);
  }
  const byPath = new Map(nodes.map((node) => [node.path, node]));
  const result = order.map((path) => byPath.get(path));
  if (result.some((node) => !node)) throw new Error(`Reorder for ${parent} contains a foreign child path`);
  return result as readonly AvsEditorNode[];
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

function readI32(bytes: Uint8Array, offset: number, fallback: number): number {
  return offset + 4 <= bytes.length
    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset, true)
    : fallback;
}

function readU32(bytes: Uint8Array, offset: number, fallback: number): number {
  return offset + 4 <= bytes.length
    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true)
    : fallback >>> 0;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  if (offset + 4 > bytes.length) throw new Error('Truncated Effect List mode word');
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

function writeI32(bytes: Uint8Array, offset: number, value: number): void {
  if (offset + 4 > bytes.length) throw new Error('Truncated AVS field');
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setInt32(offset, value, true);
}

function requirePayload(bytes: Uint8Array, length: number, path: string, kind: string): void {
  if (bytes.length < length) throw new Error(`Renderer ${path} has a truncated ${kind} payload`);
}

function integerInRange(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}
