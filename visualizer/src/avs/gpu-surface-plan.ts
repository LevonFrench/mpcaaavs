import { AVS_LIST_BLEND_MODES, decodeAvsListBlend, type AvsListBlendMode } from './framebuffer.ts';
import type { AvsComponent, AvsPresetAst } from './types.ts';

/** Stable GPU resource identity; no operation in this model performs readback. */
export type AvsResidentSurfaceId =
  | '$root'
  | '$root:alternate'
  | `$list:${string}:retained`
  | `$list:${string}:alternate`
  | `$list:${string}:fast-alternate`
  | `$global:${number}`;

export interface AvsResidentSurface {
  readonly id: AvsResidentSurfaceId;
  readonly role: 'root' | 'alternate' | 'list-retained' | 'global-buffer';
  /** Root, retained list images, alternates, and global buffers survive frames. */
  readonly persistent: true;
  /** Global buffers are zero-initialized only when a producer first creates them. */
  readonly lazy: boolean;
  readonly ownerPath: string | null;
  readonly bufferIndex: number | null;
}

export type AvsResidentScopeId = '$root' | `$list:${string}`;

/**
 * A logical current/spare pair. Encoders must resolve `current` at operation
 * time because an out-of-place effect may swap it before a list or Buffer Save.
 */
export interface AvsResidentScope {
  readonly id: AvsResidentScopeId;
  readonly primary: AvsResidentSurfaceId | null;
  readonly alternate: AvsResidentSurfaceId;
  /** Fast replace/replace lists begin on their parent's current slot. */
  readonly aliasesParentCurrent: AvsResidentScopeId | null;
}

export interface AvsResidentBlend {
  readonly mode: AvsListBlendMode;
  readonly amount: number;
  readonly depth: AvsResidentSurfaceId | null;
  readonly invertDepth: boolean;
  readonly missingDepth: 'no-op';
}

export type AvsResidentOperation =
  | {
    readonly kind: 'root-clear';
    readonly target: '$root';
    readonly condition: 'frame-not-preinit';
  }
  | {
    readonly kind: 'list-enter';
    readonly path: string;
    readonly parentScope: AvsResidentScopeId;
    readonly targetScope: AvsResidentScopeId;
    readonly parent: AvsResidentSurfaceId;
    readonly target: AvsResidentSurfaceId;
    readonly alternate: AvsResidentSurfaceId;
    readonly direct: boolean;
    readonly clearEveryFrame: boolean;
    readonly blend: AvsResidentBlend | null;
    readonly cpuControl: boolean;
    readonly clearControl: 'never' | 'always' | 'cpu';
    readonly blendCondition: 'frame-not-preinit';
  }
  | {
    readonly kind: 'list-exit';
    readonly path: string;
    readonly sourceScope: AvsResidentScopeId;
    readonly parentScope: AvsResidentScopeId;
    readonly source: AvsResidentSurfaceId;
    readonly parent: AvsResidentSurfaceId;
    readonly direct: boolean;
    readonly blend: AvsResidentBlend | null;
    readonly blendCondition: 'frame-not-preinit';
  }
  | {
    readonly kind: 'effect';
    readonly path: string;
    readonly effectId: number;
    readonly apeId: string | null;
    readonly target: AvsResidentSurfaceId;
    readonly alternate: AvsResidentSurfaceId;
    readonly scope: AvsResidentScopeId;
    readonly capability: string;
  }
  | {
    readonly kind: 'buffer-save';
    readonly path: string;
    readonly framebufferScope: AvsResidentScopeId;
    readonly framebuffer: AvsResidentSurfaceId;
    readonly buffer: AvsResidentSurfaceId;
    readonly bufferIndex: number;
    readonly direction: number;
    readonly possibleDirections: readonly ('store' | 'load')[];
    readonly alternatesEachFrame: boolean;
    readonly createsBuffer: boolean;
    readonly cpuPhaseState: boolean;
    readonly condition: 'frame-not-preinit';
    readonly blendCode: number;
    readonly blendMode: AvsListBlendMode;
    readonly amount: number;
  }
  | {
    readonly kind: 'cpu-control';
    readonly path: string;
    readonly effectId: 21 | 33 | 40;
    readonly target: AvsResidentSurfaceId;
    readonly scope: AvsResidentScopeId;
  };

export interface AvsResidentPlanIssue {
  readonly path: string;
  readonly code: 'unsupported-renderer' | 'unsupported-list-blend';
  readonly message: string;
}

export interface AvsResidentEffectCapability {
  readonly id: string;
  readonly byteExact: boolean;
  /** False if the effect requires a framebuffer readback between passes. */
  readonly readbackFree: boolean;
}

export interface AvsResidentSurfacePlannerOptions {
  /** Renderer capability lookup. Absence rejects the renderer. */
  readonly effectCapability?: (component: AvsComponent) => AvsResidentEffectCapability | null;
}

export interface AvsResidentSurfacePlan {
  readonly surfaces: readonly AvsResidentSurface[];
  readonly scopes: readonly AvsResidentScope[];
  readonly operations: readonly AvsResidentOperation[];
  readonly issues: readonly AvsResidentPlanIssue[];
  readonly eligible: boolean;
  readonly framebufferReadbacks: 0;
  readonly rootFeedbackResident: boolean;
  readonly residentBytesPerPixel: number;
}

const CONTROL_EFFECTS = new Set([21, 33, 40]);

/**
 * Compile AVS framebuffer ownership into a resident resource/operation plan.
 *
 * This is deliberately a planning seam, not a GPU executor. It mirrors the CPU
 * executor's parent/list/global-buffer dependencies and rejects any renderer
 * that has not supplied an exact, readback-free capability. A later encoder can
 * bind these stable identities without exposing pixel data back to JavaScript.
 */
export function planAvsResidentSurfaces(
  preset: AvsPresetAst,
  options: AvsResidentSurfacePlannerOptions = {},
): AvsResidentSurfacePlan {
  const surfaces = new Map<AvsResidentSurfaceId, AvsResidentSurface>();
  const scopes = new Map<AvsResidentScopeId, AvsResidentScope>();
  const operations: AvsResidentOperation[] = [];
  const issues: AvsResidentPlanIssue[] = [];
  addSurface(surfaces, '$root', 'root', false, null, null);
  addSurface(surfaces, '$root:alternate', 'alternate', false, '$root', null);
  scopes.set('$root', { id: '$root', primary: '$root', alternate: '$root:alternate', aliasesParentCurrent: null });
  if (preset.clearEveryFrame) {
    operations.push({ kind: 'root-clear', target: '$root', condition: 'frame-not-preinit' });
  }
  visitChildren(preset.components, scopes.get('$root')!, scopes, surfaces, operations, issues, options);
  return {
    surfaces: [...surfaces.values()],
    scopes: [...scopes.values()],
    operations,
    issues,
    eligible: issues.length === 0,
    framebufferReadbacks: 0,
    rootFeedbackResident: !preset.clearEveryFrame,
    residentBytesPerPixel: surfaces.size * Uint32Array.BYTES_PER_ELEMENT,
  };
}

function visitChildren(
  children: readonly AvsComponent[],
  scope: AvsResidentScope,
  scopes: Map<AvsResidentScopeId, AvsResidentScope>,
  surfaces: Map<AvsResidentSurfaceId, AvsResidentSurface>,
  operations: AvsResidentOperation[],
  issues: AvsResidentPlanIssue[],
  options: AvsResidentSurfacePlannerOptions,
): void {
  for (const component of children) {
    if (component.list) {
      visitList(component, scope, scopes, surfaces, operations, issues, options);
      continue;
    }
    if (!component.apeId && component.effectId === 18) {
      addBufferSave(component, scope, scopes, surfaces, operations);
      continue;
    }
    if (!component.apeId && CONTROL_EFFECTS.has(component.effectId)) {
      operations.push({
        kind: 'cpu-control', path: component.path, effectId: component.effectId as 21 | 33 | 40,
        target: scope.primary ?? inheritedPrimary(scope, scopes), scope: scope.id,
      });
      continue;
    }
    const capability = options.effectCapability?.(component) ?? null;
    if (!capability || !capability.byteExact || !capability.readbackFree) {
      issues.push({
        path: component.path,
        code: 'unsupported-renderer',
        message: `${component.apeId ?? `renderer ${component.effectId}`} lacks an exact readback-free resident capability`,
      });
      continue;
    }
    operations.push({
      kind: 'effect', path: component.path, effectId: component.effectId,
      apeId: component.apeId, target: scope.primary ?? inheritedPrimary(scope, scopes),
      alternate: scope.alternate, scope: scope.id, capability: capability.id,
    });
  }
}

function visitList(
  component: AvsComponent,
  parentScope: AvsResidentScope,
  scopes: Map<AvsResidentScopeId, AvsResidentScope>,
  surfaces: Map<AvsResidentSurfaceId, AvsResidentSurface>,
  operations: AvsResidentOperation[],
  issues: AvsResidentPlanIssue[],
  options: AvsResidentSurfacePlannerOptions,
): void {
  const settings = component.list!;
  const direct = settings.inputBlendMode === 1 && settings.outputBlendMode === 1;
  const parent = parentScope.primary ?? inheritedPrimary(parentScope, scopes);
  const target: AvsResidentSurfaceId = direct ? parent : `$list:${component.path}:retained`;
  const alternate: AvsResidentSurfaceId = direct
    ? `$list:${component.path}:fast-alternate`
    : `$list:${component.path}:alternate`;
  if (!direct) addSurface(surfaces, target, 'list-retained', false, component.path, null);
  addSurface(surfaces, alternate, 'alternate', false, component.path, null);
  const scopeId: AvsResidentScopeId = `$list:${component.path}`;
  const listScope: AvsResidentScope = {
    id: scopeId,
    primary: direct ? null : target,
    alternate,
    aliasesParentCurrent: direct ? parentScope.id : null,
  };
  scopes.set(scopeId, listScope);
  const input = direct ? null : listBlend(component.path, settings.inputBlendMode, settings.inputBlendValue,
    settings.inputBuffer, settings.inputInvert, surfaces, issues);
  const output = direct ? null : listBlend(component.path, settings.outputBlendMode, settings.outputBlendValue,
    settings.outputBuffer, settings.outputInvert, surfaces, issues);
  operations.push({
    kind: 'list-enter', path: component.path, parentScope: parentScope.id, targetScope: scopeId,
    parent, target, alternate, direct,
    clearEveryFrame: settings.clearEveryFrame, blend: input,
    cpuControl: Boolean(component.listCode?.enabled || settings.beatRender || !settings.enabled),
    clearControl: component.listCode?.enabled ? 'cpu' : settings.clearEveryFrame ? 'always' : 'never',
    blendCondition: 'frame-not-preinit',
  });
  visitChildren(component.children, listScope, scopes, surfaces, operations, issues, options);
  operations.push({
    kind: 'list-exit', path: component.path, sourceScope: scopeId, parentScope: parentScope.id,
    source: target, parent, direct, blend: output, blendCondition: 'frame-not-preinit',
  });
}

function listBlend(
  path: string,
  modeCode: number,
  amount: number,
  depthIndex: number,
  invertDepth: boolean,
  surfaces: Map<AvsResidentSurfaceId, AvsResidentSurface>,
  issues: AvsResidentPlanIssue[],
): AvsResidentBlend {
  if (!(modeCode in AVS_LIST_BLEND_MODES)) {
    issues.push({ path, code: 'unsupported-list-blend', message: `unknown Effect List blend mode ${modeCode}` });
  }
  const mode = decodeAvsListBlend(modeCode);
  const index = clamp(depthIndex, 0, 7);
  const depth: AvsResidentSurfaceId | null = mode === 'buffer-depth' ? `$global:${index}` : null;
  if (depth) addSurface(surfaces, depth, 'global-buffer', true, null, index);
  return { mode, amount, depth, invertDepth, missingDepth: 'no-op' };
}

function addBufferSave(
  component: AvsComponent,
  scope: AvsResidentScope,
  scopes: Map<AvsResidentScopeId, AvsResidentScope>,
  surfaces: Map<AvsResidentSurfaceId, AvsResidentSurface>,
  operations: AvsResidentOperation[],
): void {
  const direction = int(component.payload, 0, 0);
  const bufferIndex = clamp(int(component.payload, 4, 0), 0, 7);
  const blendCode = int(component.payload, 8, 0);
  const amount = int(component.payload, 12, 128);
  const framebuffer = scope.primary ?? inheritedPrimary(scope, scopes);
  const buffer: AvsResidentSurfaceId = `$global:${bufferIndex}`;
  addSurface(surfaces, buffer, 'global-buffer', true, null, bufferIndex);
  const alternating = direction >= 2;
  const possibleDirections: readonly ('store' | 'load')[] = alternating
    ? ['store', 'load']
    : direction === 0 ? ['store'] : ['load'];
  operations.push({
    kind: 'buffer-save', path: component.path, framebufferScope: scope.id,
    framebuffer, buffer, bufferIndex, direction,
    possibleDirections, alternatesEachFrame: alternating, createsBuffer: direction !== 1,
    cpuPhaseState: alternating, condition: 'frame-not-preinit',
    blendCode, blendMode: decodeBufferSaveBlend(blendCode), amount,
  });
}

function decodeBufferSaveBlend(code: number): AvsListBlendMode {
  return ({
    0: 'replace', 1: 'average', 2: 'additive', 3: 'every-other-pixel',
    4: 'destination-minus-source', 5: 'every-other-line', 6: 'xor',
    7: 'maximum', 8: 'minimum', 9: 'source-minus-destination',
    10: 'multiply', 11: 'adjustable',
  } as const)[code as 0] ?? 'replace';
}

function addSurface(
  surfaces: Map<AvsResidentSurfaceId, AvsResidentSurface>,
  id: AvsResidentSurfaceId,
  role: AvsResidentSurface['role'],
  lazy: boolean,
  ownerPath: string | null,
  bufferIndex: number | null,
): void {
  if (!surfaces.has(id)) surfaces.set(id, { id, role, persistent: true, lazy, ownerPath, bufferIndex });
}

function int(payload: Uint8Array, offset: number, fallback: number): number {
  return offset + 4 <= payload.byteLength
    ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true)
    : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function inheritedPrimary(
  scope: AvsResidentScope,
  scopes: Map<AvsResidentScopeId, AvsResidentScope>,
): AvsResidentSurfaceId {
  let current = scope;
  while (current.primary === null) {
    const parent = current.aliasesParentCurrent && scopes.get(current.aliasesParentCurrent);
    if (!parent) throw new Error(`Resident scope ${current.id} has no physical parent`);
    current = parent;
  }
  return current.primary;
}
