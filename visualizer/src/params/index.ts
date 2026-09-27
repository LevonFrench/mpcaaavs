// The shared parameter registry, assembled.
//
// `descriptor.ts` is the declaration, `registry.ts` is the one list, and the
// two adapters project the program's existing parameters into it: `globals.ts`
// for the layer/post/transport controls and `avs-fields.ts` for one AVS
// renderer's decoded fields. Nothing in here draws anything.

export {
  PRESET_PARAM_GROUP,
  clampParam,
  formatParamValue,
  isKnobParam,
  paramFromUnit,
  paramMax,
  paramMin,
  paramMode,
  paramStep,
  paramTitle,
  paramToUnit,
} from './descriptor.ts';
export type { ParamDescriptor, ParamKind, ParamValue, ParamWriteCost } from './descriptor.ts';

export { ParamRegistry } from './registry.ts';
export type { ParamAccessor, ParamEntry, ParamUnregister } from './registry.ts';

export { REST_PARAM_ID, globalParamEntries } from './globals.ts';
export type { ParamHost } from './globals.ts';

export { AVS_PARAM_GROUP, avsFieldParams, mergeAvsFieldPatches } from './avs-fields.ts';
export type { AvsFieldParam } from './avs-fields.ts';
