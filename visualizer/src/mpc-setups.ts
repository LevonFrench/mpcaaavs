import {parseSceneTiming,type SceneTiming} from './mpc-scene-clock.ts';
import {BEATS_FROM_FADE,FADE_ANCHOR_COUNT,FADE_FROM_BEATS,FADE_RANDOM_SET_ALL,FADE_RANDOM_SET_MIN,FADE_TIMING_COUNT,QUEUE_QUANTIZE_COUNT,TRANSITION_COUNT} from './mpc-contract.ts';
import type {FadeAnchor,FadeSpec} from './mpc-transition-timing.ts';
export interface SetupSettings { enabled:boolean; bars:number; shuffle:boolean; minimumRating:number; transition:number; beats:number; durationMs:number; keepOld:boolean; manualFade:boolean; autoFade:boolean;
  /** Optional v2 fields (contract 2.2.1). Copied only when present; a present invalid value is rejected. */
  fadeTiming?:number; fadeRandomSet?:number; fadeAnchor?:number; queueQuantize?:number }
export interface PresetSetup { id:string; name:string; presets:string[]; settings:SetupSettings; timing?:SceneTiming }
export const defaultSettings:SetupSettings={enabled:true,bars:0,shuffle:false,minimumRating:0,transition:1,beats:0,durationMs:2000,keepOld:true,manualFade:true,autoFade:true};
const integerIn=(value:unknown,low:number,high:number)=>typeof value==='number'&&Number.isInteger(value)&&value>=low&&value<=high;
/** Validate one settings object. Legacy input yields exactly the ten historical keys; the four v2 fields are added only when present. */
export function parseSettings(value:unknown):SetupSettings {
  const s=value as Record<string,unknown>|null|undefined;
  if(!s||![0,2,4,8,12].includes(s.bars as number)||![0,1,2,4].includes(s.beats as number)||!integerIn(s.transition,0,TRANSITION_COUNT-1)||!integerIn(s.durationMs,250,8000)||['enabled','shuffle','keepOld','manualFade','autoFade'].some(k=>typeof s[k]!=='boolean'))throw Error('Invalid setup settings');
  const minimumRating=s.minimumRating===undefined?0:s.minimumRating;
  if(!integerIn(minimumRating,0,5))throw Error('Invalid shuffle minimum rating');
  const result:SetupSettings={enabled:s.enabled as boolean,bars:s.bars as number,shuffle:s.shuffle as boolean,minimumRating:minimumRating as number,transition:s.transition as number,beats:s.beats as number,durationMs:s.durationMs as number,keepOld:s.keepOld as boolean,manualFade:s.manualFade as boolean,autoFade:s.autoFade as boolean};
  for(const [key,low,high] of [['fadeTiming',0,FADE_TIMING_COUNT-1],['fadeRandomSet',FADE_RANDOM_SET_MIN,FADE_RANDOM_SET_ALL],['fadeAnchor',0,FADE_ANCHOR_COUNT-1],['queueQuantize',0,QUEUE_QUANTIZE_COUNT-1]] as const){
    if(s[key]===undefined)continue;
    if(!integerIn(s[key],low,high))throw Error('Invalid setup settings');
    result[key]=s[key] as number;
  }
  return result;
}
export function parseSetups(value:unknown):PresetSetup[] {
  if(!Array.isArray(value)||value.length>100)throw Error('Setup file must contain at most 100 setups');
  const ids=new Set<string>();
  return value.map(v=>{
    if(!v || typeof v.id!=='string'||!v.id||v.id.length>100||ids.has(v.id)||typeof v.name!=='string'||!v.name.trim()||v.name.length>120||!Array.isArray(v.presets)||v.presets.length>500||v.presets.some((h:unknown)=>typeof h!=='string'||!/^[0-9a-f]{64}$/.test(h))||new Set(v.presets).size!==v.presets.length)throw Error('Invalid setup or duplicate preset');
    ids.add(v.id);
    return {id:v.id,name:v.name.trim(),presets:[...v.presets],settings:parseSettings(v.settings),timing:parseSceneTiming(v.timing)};
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
/** C-03: `fadeTiming` (0..6) is authoritative when present; otherwise it derives from the legacy `beats` (0, 1, 2, 4). */
export function effectiveFadeTiming(s:Pick<SetupSettings,'beats'|'fadeTiming'>):number {
  return s.fadeTiming!==undefined?s.fadeTiming:(FADE_FROM_BEATS[s.beats]??0);
}
/** The stored fade fields as a spec for `pickFade` and `planFade` (absent fields read as their defaults). */
export function fadeSpecOf(s:Pick<SetupSettings,'beats'|'fadeTiming'|'fadeRandomSet'|'fadeAnchor'|'durationMs'>):FadeSpec {
  return {timing:effectiveFadeTiming(s) as FadeSpec['timing'],randomSet:s.fadeRandomSet??FADE_RANDOM_SET_ALL,anchor:(s.fadeAnchor??0) as FadeAnchor,fixedMs:s.durationMs};
}
const legacyKeys=(s:SetupSettings,beats:number):SetupSettings=>({enabled:s.enabled,bars:s.bars,shuffle:s.shuffle,minimumRating:s.minimumRating,transition:s.transition,beats,durationMs:s.durationMs,keepOld:s.keepOld,manualFade:s.manualFade,autoFade:s.autoFade});
/** What a setup or a `managementSettings()` result stores (C-03, C-04): `beats` is always the projection of the effective fade timing, and
 * each v2 field is written only when it differs from its default (`fadeTiming` equal to `FADE_FROM_BEATS[beats]` counts as default),
 * so legacy input round-trips with exactly its ten keys. Output key order matches `parseSettings`. */
export function canonicalSettings(s:SetupSettings):SetupSettings {
  const timing=effectiveFadeTiming(s),beats=BEATS_FROM_FADE[timing]??0,result=legacyKeys(s,beats);
  if(timing!==FADE_FROM_BEATS[beats])result.fadeTiming=timing;
  if(s.fadeRandomSet!==undefined&&s.fadeRandomSet!==FADE_RANDOM_SET_ALL)result.fadeRandomSet=s.fadeRandomSet;
  if(s.fadeAnchor!==undefined&&s.fadeAnchor!==0)result.fadeAnchor=s.fadeAnchor;
  if(s.queueQuantize!==undefined&&s.queueQuantize!==0)result.queueQuantize=s.queueQuantize;
  return result;
}
/** Canonical settings for a fade spec (the host's live state) plus the manual queue mode. */
export function settingsWithFade(base:SetupSettings,spec:FadeSpec,queueQuantize=0):SetupSettings {
  return canonicalSettings({...base,fadeTiming:spec.timing,fadeRandomSet:spec.randomSet,fadeAnchor:spec.anchor,durationMs:spec.fixedMs,queueQuantize});
}
/** C-13: the `configure` payload always carries all four fade fields (defaults for absent ones) so activating a setup never depends on the previous one.
 * Display preferences never travel here (C-14). */
export function configureSettings(s:SetupSettings):SetupSettings&{fadeTiming:number;fadeRandomSet:number;fadeAnchor:number;queueQuantize:number} {
  const timing=effectiveFadeTiming(s);
  return {...legacyKeys(s,BEATS_FROM_FADE[timing]??0),fadeTiming:timing,fadeRandomSet:s.fadeRandomSet??FADE_RANDOM_SET_ALL,fadeAnchor:s.fadeAnchor??0,queueQuantize:s.queueQuantize??0};
}
