import { decodeAvsDynamicMovement, type AvsDynamicMovementConfig } from './effects/dynamic-movement.ts';
import {
  compileEnhancedDynamicMovementResident,
  type EnhancedDynamicMovementResidentProgram,
} from './effects/dynamic-movement-eel-gpu.ts';
import type { AvsComponent, AvsPresetAst } from './types.ts';

export interface AvsTerminalEnhancedDynamicMovementPlan {
  readonly cpuPreset: AvsPresetAst;
  readonly component: AvsComponent | null;
  readonly config: AvsDynamicMovementConfig | null;
  readonly residentProgram: EnhancedDynamicMovementResidentProgram | null;
  readonly residentReason: string;
  readonly reason: string;
}

export function planTerminalEnhancedDynamicMovement(preset: AvsPresetAst): AvsTerminalEnhancedDynamicMovementPlan {
  if (!preset.clearEveryFrame) return empty(preset, 'root framebuffer feedback requires classic Dynamic Movement');
  const component = preset.components.at(-1);
  if (!component || component.list || component.apeId || component.effectId !== 43) {
    return empty(preset, 'no root-terminal Dynamic Movement');
  }
  const config = decodeAvsDynamicMovement(component.payload);
  if (config.buffer !== 0) return empty(preset, 'Dynamic Movement global-buffer source remains classic CPU');
  if (config.noMove) return empty(preset, 'Dynamic Movement no-move alpha mask remains classic CPU');
  const resident = compileEnhancedDynamicMovementResident(config);
  return {
    cpuPreset: { ...preset, components: preset.components.slice(0, -1) }, component, config,
    residentProgram: resident.eligible ? resident.program : null,
    residentReason: resident.eligible ? 'pure point EEL grid generated resident on WebGPU' : `CPU map fallback: ${resident.reason}`,
    reason: resident.eligible
      ? 'root-terminal Dynamic Movement pure point EEL grid + resampler resident on WebGPU (120 lane)'
      : 'root-terminal Dynamic Movement EEL map on CPU + exact resident WebGPU resampler (120 lane)',
  };
}

function empty(preset: AvsPresetAst, reason: string): AvsTerminalEnhancedDynamicMovementPlan {
  return { cpuPreset: preset, component: null, config: null, residentProgram: null, residentReason: reason, reason };
}
