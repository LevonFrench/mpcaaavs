import { compileEnhancedSuperScopeGpu, type EnhancedSuperScopeGpuProgram } from './effects/superscope-gpu.ts';
import { decodeAvsSuperScope, type AvsSuperScopeConfig } from './effects/superscope.ts';
import type { AvsComponent, AvsPresetAst } from './types.ts';

export interface AvsTerminalEnhancedSuperScopePlan {
  readonly cpuPreset: AvsPresetAst;
  readonly component: AvsComponent | null;
  readonly config: AvsSuperScopeConfig | null;
  readonly program: EnhancedSuperScopeGpuProgram | null;
  readonly reason: string;
}

/**
 * Extract exactly one root-level terminal point-mode SuperScope for the opt-in
 * f32 lane. Every ambiguous dependency fails closed to the original CPU AST.
 */
export function planTerminalEnhancedSuperScope(preset: AvsPresetAst): AvsTerminalEnhancedSuperScopePlan {
  if (!preset.clearEveryFrame) return fallback(preset, 'root feedback requires ordered CPU SuperScope');
  const component = preset.components.at(-1);
  if (!component || component.list || component.apeId || component.effectId !== 36) {
    return fallback(preset, 'no root-level terminal SuperScope');
  }
  if (preset.components.slice(0, -1).some(value => !value.list && !value.apeId && value.effectId === 40)) {
    return fallback(preset, 'root Set Render Mode makes SuperScope blending stateful');
  }
  const config = decodeAvsSuperScope(component.payload);
  if (config.lines) return fallback(preset, 'line-mode SuperScope requires ordered rasterization');
  if (config.colors.length === 0) return fallback(preset, 'SuperScope has no drawable colors');
  if ([config.init, config.frame, config.beat].some(source => /\b(?:drawmode|linesize)\b/i.test(source))) {
    return fallback(preset, 'frame code can switch point raster mode');
  }
  const compiled = compileEnhancedSuperScopeGpu(config.point);
  if (!compiled.eligible) return fallback(preset, `point script requires CPU: ${compiled.reason}`);
  // An assigned drawmode is not present in the sampled input set. Requiring
  // it here proves point code leaves the host-owned point mode unchanged.
  if (!compiled.program.uniformNames.includes('drawmode')) {
    return fallback(preset, 'point code can switch raster mode');
  }
  return {
    cpuPreset: { ...preset, components: preset.components.slice(0, -1) },
    component, config, program: compiled.program,
    reason: '1 terminal point-independent SuperScope moved to enhanced f32 WebGPU',
  };
}

function fallback(preset: AvsPresetAst, reason: string): AvsTerminalEnhancedSuperScopePlan {
  return { cpuPreset: preset, component: null, config: null, program: null, reason };
}
