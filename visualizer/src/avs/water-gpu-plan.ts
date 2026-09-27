import { assessExactGpuWater } from './effects/water-gpu.ts';
import type { AvsComponent, AvsPresetAst } from './types.ts';
export interface AvsTerminalGpuWaterPlan{readonly cpuPreset:AvsPresetAst;readonly components:readonly AvsComponent[];readonly reason:string;}
export function planTerminalExactGpuWater(preset:AvsPresetAst,width:number,height:number):AvsTerminalGpuWaterPlan{
  if(!preset.clearEveryFrame)return empty(preset,'root feedback would require GPU-to-CPU Water readback');let split=preset.components.length;const reverse:AvsComponent[]=[];
  while(split>0){const component=preset.components[split-1]!,result=assessExactGpuWater(component,width,height);if(!result.eligible)break;reverse.push(component);split--;}
  const components=reverse.reverse();if(!components.length)return empty(preset,'no enabled root-terminal Water suffix');return{cpuPreset:{...preset,components:preset.components.slice(0,split)},components,reason:`${components.length} stateful Water pass${components.length===1?'':'es'} eligible for exact resident WebGPU`};
}
function empty(preset:AvsPresetAst,reason:string):AvsTerminalGpuWaterPlan{return{cpuPreset:preset,components:[],reason};}
