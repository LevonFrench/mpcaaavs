// AVS decoded fields, projected as descriptors.
//
// Read-side only. Nothing here decodes, encodes, re-orders or validates a byte:
// it reads an `AvsEditorInspection` (already produced by `avs/editor-model.ts`)
// and emits `ParamDescriptor`s plus the partial `AvsEditorFieldPatch` that
// writes each one. The bounds below are transcribed from the `integerInRange`
// calls in `patchAvsEditorNodeFields` and the defaults from the `readI32`
// fallbacks in `inspect` — that write path is still the authority and still
// throws, so this projection cannot widen a range by getting one wrong.
//
// Only the three field-patchable inspection kinds appear. The other nine
// (`superscope`, `texer`, `texer-ii`, `convolution`, `color-map`, `movement`,
// `dynamic-movement`, `effect-list`, `opaque`) have no `AvsEditorFieldPatch`
// arm at all and are edited as raw payload hex or read as EEL source, so they
// get no descriptors and keep the bespoke editors they already had.

import type { ParamDescriptor, ParamValue } from './descriptor.ts';
import type { AvsEditorFieldPatch, AvsEditorInspection } from '../avs/editor-model.ts';

/** Group every AVS renderer field lands in. Not `preset` — these are not preset changes. */
export const AVS_PARAM_GROUP = 'avs';

/**
 * One decoded AVS field.
 *
 * `read` and `patch` are pure functions of the descriptor's own field, so a
 * caller can hold this object across a preset reload: the value comes from
 * whatever inspection it is handed, never from a value captured here.
 */
export interface AvsFieldParam {
  readonly descriptor: ParamDescriptor;
  /** Pull this field out of a freshly decoded inspection of the same node. */
  read(inspection: AvsEditorInspection): ParamValue;
  /** The partial patch that writes it. One field per patch; merge before applying. */
  patch(value: ParamValue): AvsEditorFieldPatch;
}

/** Every AVS write re-serialises the preset, so none of them is a live write. */
const AVS_COST = 'reload' as const;

function integer(
  path: string,
  field: string,
  label: string,
  min: number,
  max: number,
  defaultValue: number,
): ParamDescriptor {
  return {
    id: `avs.${path}.${field}`,
    label,
    kind: 'number',
    defaultValue,
    min,
    max,
    step: 1,
    group: AVS_PARAM_GROUP,
    cost: AVS_COST,
  };
}

function option(
  path: string,
  field: string,
  label: string,
  values: readonly string[],
  defaultValue: number,
): ParamDescriptor {
  return {
    id: `avs.${path}.${field}`,
    label,
    kind: 'select',
    defaultValue,
    values,
    group: AVS_PARAM_GROUP,
    cost: AVS_COST,
  };
}

function flag(path: string, field: string, label: string, defaultValue: boolean): ParamDescriptor {
  return {
    id: `avs.${path}.${field}`,
    label,
    kind: 'boolean',
    defaultValue,
    group: AVS_PARAM_GROUP,
    cost: AVS_COST,
  };
}

/**
 * The value, as the patch type states it. Deliberately NOT clamped here.
 *
 * `ParamRegistry.set` already runs `clampParam` before it calls any accessor,
 * so every registry-driven write (a CC, a pad, a step) arrives in range. The
 * inspector's form is the one caller that does not go through the registry,
 * and it must keep reaching `integerInRange` in `patchAvsEditorNodeFields`
 * raw: that is what makes a typed 300, a fraction or an emptied field an
 * error the form reports instead of a silently different byte.
 */
function quad(value: ParamValue): 0 | 1 | 2 | 3 {
  return Number(value) as 0 | 1 | 2 | 3;
}

function whole(value: ParamValue): number {
  return Number(value);
}

function truth(value: ParamValue): boolean {
  return typeof value === 'boolean' ? value : Number(value) >= 0.5;
}

const BLUR_MODES = ['Disabled', 'Normal', 'Light', 'Heavy'] as const;
const BUFFER_DIRECTIONS = ['Save', 'Restore', 'Alternate save/restore', 'Restore on beat'] as const;

/**
 * Descriptors for one node's decoded fields, in the order the inspector drew
 * them by hand before this existed. Empty for every kind without a patch arm,
 * which is the signal a surface uses to fall back to its bespoke editor.
 */
export function avsFieldParams(
  inspection: AvsEditorInspection,
  path: string,
): readonly AvsFieldParam[] {
  if (inspection.kind === 'blur') {
    const mode = option(path, 'mode', 'Mode', BLUR_MODES, 1);
    const roundUp = flag(path, 'roundUp', 'Round upward', false);
    return [
      {
        descriptor: mode,
        read: (i) => (i.kind === 'blur' ? i.mode : mode.defaultValue),
        patch: (value) => ({ kind: 'blur', mode: quad(value) }),
      },
      {
        descriptor: roundUp,
        read: (i) => (i.kind === 'blur' ? i.roundUp : roundUp.defaultValue),
        patch: (value) => ({ kind: 'blur', roundUp: truth(value) }),
      },
    ];
  }

  if (inspection.kind === 'buffer-save') {
    const direction = option(path, 'direction', 'Direction', BUFFER_DIRECTIONS, 0);
    const buffer = integer(path, 'buffer', 'Buffer', 0, 7, 0);
    const blendMode = integer(path, 'blendMode', 'Blend mode', 0, 11, 0);
    const alpha = integer(path, 'adjustableAlpha', 'Adjustable alpha', 0, 255, 128);
    return [
      {
        descriptor: direction,
        read: (i) => (i.kind === 'buffer-save' ? i.direction : direction.defaultValue),
        patch: (value) => ({ kind: 'buffer-save', direction: quad(value) }),
      },
      {
        descriptor: buffer,
        read: (i) => (i.kind === 'buffer-save' ? i.buffer : buffer.defaultValue),
        patch: (value) => ({ kind: 'buffer-save', buffer: whole(value) }),
      },
      {
        descriptor: blendMode,
        read: (i) => (i.kind === 'buffer-save' ? i.blendMode : blendMode.defaultValue),
        patch: (value) => ({ kind: 'buffer-save', blendMode: whole(value) }),
      },
      {
        descriptor: alpha,
        read: (i) => (i.kind === 'buffer-save' ? i.adjustableAlpha : alpha.defaultValue),
        patch: (value) => ({ kind: 'buffer-save', adjustableAlpha: whole(value) }),
      },
    ];
  }

  if (inspection.kind === 'set-render-mode') {
    // Defaults are the four sub-fields of the 0x80010000 fallback in `inspect`:
    // enabled bit set, blend 0, alpha 0, line width 1.
    const enabled = flag(path, 'enabled', 'Enabled', true);
    const blendMode = integer(path, 'blendMode', 'Blend mode', 0, 9, 0);
    const alpha = integer(path, 'adjustableAlpha', 'Adjustable alpha', 0, 255, 0);
    const lineWidth = integer(path, 'lineWidth', 'Line width', 0, 255, 1);
    return [
      {
        descriptor: enabled,
        read: (i) => (i.kind === 'set-render-mode' ? i.enabled : enabled.defaultValue),
        patch: (value) => ({ kind: 'set-render-mode', enabled: truth(value) }),
      },
      {
        descriptor: blendMode,
        read: (i) => (i.kind === 'set-render-mode' ? i.blendMode : blendMode.defaultValue),
        patch: (value) => ({ kind: 'set-render-mode', blendMode: whole(value) }),
      },
      {
        descriptor: alpha,
        read: (i) => (i.kind === 'set-render-mode' ? i.adjustableAlpha : alpha.defaultValue),
        patch: (value) => ({ kind: 'set-render-mode', adjustableAlpha: whole(value) }),
      },
      {
        descriptor: lineWidth,
        read: (i) => (i.kind === 'set-render-mode' ? i.lineWidth : lineWidth.defaultValue),
        patch: (value) => ({ kind: 'set-render-mode', lineWidth: whole(value) }),
      },
    ];
  }

  return [];
}

/**
 * Fold one node's per-field patches into the single patch the write path takes.
 *
 * A form submits every field at once and `patchAvsEditorNodeFields` reloads the
 * preset once per call, so applying them one at a time would mean four reloads
 * where one will do. Every patch in the array shares one `kind` (they come from
 * one node) and each carries exactly one field, so a shallow merge is the whole
 * union — patches of a different kind are dropped rather than blended.
 */
export function mergeAvsFieldPatches(
  patches: readonly AvsEditorFieldPatch[],
): AvsEditorFieldPatch | null {
  const first = patches[0];
  if (!first) return null;
  const same = patches.filter((patch) => patch.kind === first.kind);
  return Object.assign({}, ...same) as AvsEditorFieldPatch;
}
