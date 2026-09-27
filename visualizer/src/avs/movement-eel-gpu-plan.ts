import { decodeAvsMovement, type AvsMovementConfig } from './effects/movement.ts';
import { compileEnhancedMovementEelGpu, type EnhancedMovementEelGpuProgram } from './effects/movement-eel-gpu.ts';
import type { AvsComponent, AvsPresetAst } from './types.ts';

export interface AvsTerminalEnhancedMovementEelPlan {
  readonly cpuPreset: AvsPresetAst;
  readonly component: AvsComponent | null;
  readonly config: AvsMovementConfig | null;
  readonly program: EnhancedMovementEelGpuProgram | null;
  readonly reason: string;
}

export function planTerminalEnhancedMovementEel(preset: AvsPresetAst): AvsTerminalEnhancedMovementEelPlan {
  if (!preset.clearEveryFrame) return empty(preset, 'root framebuffer feedback requires classic custom Movement');
  const component = preset.components.at(-1);
  if (!component || component.list || component.apeId || component.effectId !== 15) return empty(preset, 'no root-terminal custom Movement');
  const config = decodeAvsMovement(component.payload);
  const compiled = compileEnhancedMovementEelGpu(config);
  if (!compiled.eligible) return empty(preset, `custom Movement remains classic CPU: ${compiled.reason}`);
  return {
    cpuPreset: { ...preset, components: preset.components.slice(0, -1) }, component, config, program: compiled.program,
    reason: 'root-terminal pure inverse custom Movement map + exact packed-u32 sampling resident on WebGPU (120 lane)',
  };
}

function empty(preset: AvsPresetAst, reason: string): AvsTerminalEnhancedMovementEelPlan {
  return { cpuPreset: preset, component: null, config: null, program: null, reason };
}
