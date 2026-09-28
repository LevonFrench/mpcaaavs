import {parseSceneTiming,type SceneTiming} from './mpc-scene-clock.ts';
export interface SetupSettings { enabled:boolean; bars:number; shuffle:boolean; transition:number; beats:number; durationMs:number; keepOld:boolean; manualFade:boolean; autoFade:boolean }
export interface PresetSetup { id:string; name:string; presets:string[]; settings:SetupSettings; timing?:SceneTiming }
export const defaultSettings:SetupSettings={enabled:true,bars:0,shuffle:false,transition:1,beats:0,durationMs:2000,keepOld:true,manualFade:true,autoFade:true};
export function parseSetups(value:unknown):PresetSetup[] {
  if(!Array.isArray(value)||value.length>100)throw Error('Setup file must contain at most 100 setups');
  const ids=new Set<string>();
  return value.map(v=>{
    if(!v || typeof v.id!=='string'||!v.id||v.id.length>100||ids.has(v.id)||typeof v.name!=='string'||!v.name.trim()||v.name.length>120||!Array.isArray(v.presets)||v.presets.length>500||v.presets.some((h:unknown)=>typeof h!=='string'||!/^[0-9a-f]{64}$/.test(h))||new Set(v.presets).size!==v.presets.length)throw Error('Invalid setup or duplicate preset');
    ids.add(v.id);const s=v.settings;
    if(!s||![0,2,4,8,12].includes(s.bars)||![0,1,2,4].includes(s.beats)||!Number.isInteger(s.transition)||s.transition<0||s.transition>15||!Number.isInteger(s.durationMs)||s.durationMs<250||s.durationMs>8000||['enabled','shuffle','keepOld','manualFade','autoFade'].some(k=>typeof s[k]!=='boolean'))throw Error('Invalid setup settings');
    return {id:v.id,name:v.name.trim(),presets:[...v.presets],settings:{enabled:s.enabled,bars:s.bars,shuffle:s.shuffle,transition:s.transition,beats:s.beats,durationMs:s.durationMs,keepOld:s.keepOld,manualFade:s.manualFade,autoFade:s.autoFade},timing:parseSceneTiming(v.timing)};
  });
}
export function setupIndices(setup:PresetSetup,catalog:readonly {sha256:string}[]):number[] {
  const indices=new Map(catalog.map((p,i)=>[p.sha256,i]));
  return setup.presets.map(hash=>{const index=indices.get(hash);if(index===undefined)throw Error('This setup contains a missing preset');return index;});
}
export function stepSetup(order:readonly number[],current:number,direction:1|-1,shuffle:boolean,random=Math.random):number|null {
  if(!order.length || order.length===1&&order[0]===current)return null;
  if(shuffle&&direction===1){const choices=order.filter(i=>i!==current);return choices[Math.floor(random()*choices.length)]??null;}
  const found=order.indexOf(current),base=found>=0?found:(direction===1?-1:0);
  return order[(base+direction+order.length)%order.length]??null;
}
