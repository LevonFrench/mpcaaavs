import { AVS_COLOR_MAP_APE_ID, decodeAvsColorMap, type AvsColorMapConfig } from './effects/color-map.ts';
import { assessExactGpuColorMap } from './effects/color-map-gpu.ts';
import type { AvsComponent, AvsPresetAst } from './types.ts';

export interface AvsTerminalGpuColorMapPlan {
  readonly cpuPreset: AvsPresetAst;
  readonly configs: readonly AvsColorMapConfig[];
  readonly extractedComponents: number;
  readonly reason: string;
}

export function planTerminalExactGpuColorMaps(preset: AvsPresetAst): AvsTerminalGpuColorMapPlan {
  if (!preset.clearEveryFrame) return empty(preset, 'root framebuffer feedback requires exact CPU Color Map');
  let split=preset.components.length; const reverse:AvsColorMapConfig[]=[];
  while(split>0){const config=configFor(preset.components[split-1]!);if(!config)break;reverse.push(config);split--;}
  const configs=reverse.reverse(); if(!configs.length)return empty(preset,'no safe stable root-terminal Color Map suffix');
  return {cpuPreset:{...preset,components:preset.components.slice(0,split)},configs,extractedComponents:configs.length,
    reason:`${configs.length} stable Color Map${configs.length===1?'':'s'} eligible for exact resident WebGPU`};
}
function configFor(component:AvsComponent):AvsColorMapConfig|null{if(component.list||component.children.length||component.apeId!==AVS_COLOR_MAP_APE_ID)return null;const config=decodeAvsColorMap(component.payload);return assessExactGpuColorMap(config).eligible?config:null;}
function empty(preset:AvsPresetAst,reason:string):AvsTerminalGpuColorMapPlan{return{cpuPreset:preset,configs:[],extractedComponents:0,reason};}
