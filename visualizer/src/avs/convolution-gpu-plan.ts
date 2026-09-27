import { assessExactGpuConvolution } from './effects/convolution-gpu.ts';
import { AVS_CONVOLUTION_APE_ID, decodeAvsConvolutionConfig, type AvsConvolutionConfig } from './effects/convolution.ts';
import type { AvsComponent, AvsPresetAst } from './types.ts';

export interface AvsTerminalGpuConvolutionPlan {
  readonly cpuPreset: AvsPresetAst;
  readonly configs: readonly AvsConvolutionConfig[];
  readonly extractedComponents: number;
  readonly reason: string;
}

/** Peel only consecutive root-terminal convolutions whose native execution is out-of-place. */
export function planTerminalExactGpuConvolutions(preset: AvsPresetAst): AvsTerminalGpuConvolutionPlan {
  if (!preset.clearEveryFrame) return empty(preset, 'root framebuffer feedback requires exact CPU convolution');
  let split = preset.components.length;
  const reverse: AvsConvolutionConfig[] = [];
  while (split > 0) {
    const config = configFor(preset.components[split - 1]!);
    if (!config) break;
    reverse.push(config); split--;
  }
  const configs = reverse.reverse();
  if (!configs.length) return empty(preset, 'no safe root-terminal exact GPU convolution');
  return {
    cpuPreset: { ...preset, components: preset.components.slice(0, split) }, configs,
    extractedComponents: configs.length,
    reason: `${configs.length} exact Holden03 convolution${configs.length === 1 ? '' : 's'} moved to resident WebGPU`,
  };
}

function configFor(component: AvsComponent): AvsConvolutionConfig | null {
  if (component.list || component.children.length || component.apeId !== AVS_CONVOLUTION_APE_ID) return null;
  const config = decodeAvsConvolutionConfig(component.payload);
  return assessExactGpuConvolution(config).eligible ? config : null;
}
function empty(preset: AvsPresetAst, reason: string): AvsTerminalGpuConvolutionPlan {
  return { cpuPreset: preset, configs: [], extractedComponents: 0, reason };
}
