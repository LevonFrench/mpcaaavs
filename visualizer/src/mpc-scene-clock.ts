/** Saved musical clock. It never follows the live tempo detector or wall time. */
export interface SceneTiming {
  enabled:boolean;
  bpm:number;
  offsetSeconds:number;
  barsPerScene:number;
  seed:number;
}
export interface ScenePhase {
  index:number;
  previousIndex:number;
  ordinal:number;
  start:number;
  localTime:number;
  progress:number;
  duration:number;
}
/** A manual choice recorded on the musical timeline for this playback session. */
export interface SessionSceneCue {
  ordinal:number;
  index:number;
}
export const MAX_SCENE_CUES=1024;
export const defaultSceneTiming:Readonly<SceneTiming>=Object.freeze({enabled:false,bpm:120,offsetSeconds:0,barsPerScene:8,seed:1});

/** Omitted timing keeps pre-timeline setup files compatible. Supplied timing is strict. */
export function parseSceneTiming(value:unknown):SceneTiming {
  if(value===undefined)return {...defaultSceneTiming};
  if(!value||typeof value!=='object')throw Error('Invalid repeatable scene timing');
  const v=value as Record<string,unknown>;
  if(typeof v.enabled!=='boolean'||typeof v.bpm!=='number'||!Number.isFinite(v.bpm)||v.bpm<20||v.bpm>400
    ||typeof v.offsetSeconds!=='number'||!Number.isFinite(v.offsetSeconds)||Math.abs(v.offsetSeconds)>3600
    ||typeof v.barsPerScene!=='number'||!Number.isInteger(v.barsPerScene)||v.barsPerScene<1||v.barsPerScene>128
    ||typeof v.seed!=='number'||!Number.isInteger(v.seed)||v.seed<0||v.seed>0xffffffff) {
    throw Error('Scene timing requires 20–400 BPM, an offset from −3600 to 3600 seconds, 1–128 bars and a whole-number seed from 0 to 4294967295.');
  }
  return {enabled:v.enabled,bpm:v.bpm,offsetSeconds:v.offsetSeconds,barsPerScene:v.barsPerScene,seed:v.seed};
}
export function validateSceneTiming(value:unknown):value is SceneTiming {
  if(value===undefined)return false;
  try{parseSceneTiming(value);return true;}catch{return false;}
}

function random(seed:number):()=>number {
  let state=seed>>>0;
  return ()=>{state=(state+0x6d2b79f5)>>>0;let n=state;n=Math.imul(n^(n>>>15),n|1);n^=n+Math.imul(n^(n>>>7),n|61);return ((n^(n>>>14))>>>0)/4294967296;};
}
function shuffled(values:readonly number[],seed:number):number[] {
  const result=[...values],next=random(seed);
  for(let i=result.length-1;i>0;i--){const j=Math.floor(next()*(i+1));[result[i],result[j]]=[result[j]!,result[i]!];}
  return result;
}

/** A cycle's final entry is known without evaluating earlier cycles, so seeking is O(n).
 * Reserving it, and excluding the prior cycle's final entry from the first slot,
 * allows a new permutation every cycle without repeating across the boundary.
 * With only two entries, alternating is the only no-repeat ordering.
 */
function cycleOrder(base:readonly number[],cycle:number,seed:number):readonly number[] {
  if(base.length<=2)return base;
  const last=base[cycle%base.length]!,previousLast=base[(cycle+base.length-1)%base.length]!;
  const middle=shuffled(base.filter(index=>index!==last),(seed^Math.imul(cycle+1,0x9e3779b1))>>>0);
  if(middle[0]===previousLast)[middle[0],middle[1]]=[middle[1]!,middle[0]!];
  return [...middle,last];
}

function validateCues(cues:readonly SessionSceneCue[],order?:readonly number[]):void {
  if(!Array.isArray(cues)||cues.length>MAX_SCENE_CUES)throw Error(`A repeatable session supports at most ${MAX_SCENE_CUES} scene cues`);
  let previous=-1;
  for(const cue of cues){
    if(!cue||!Number.isSafeInteger(cue.ordinal)||cue.ordinal<=previous||!Number.isSafeInteger(cue.index)||cue.index<0
      ||(order!==undefined&&!order.includes(cue.index)))throw Error('Scene cues require increasing nonnegative ordinals and preset indices from the active setup');
    previous=cue.ordinal;
  }
}

/** Queue one choice at the next scene boundary. Repeated choices before that
 * boundary replace the pending cue; past and later recorded cues remain intact.
 * Never drop old cues to make room: replay must continue to use the same history.
 */
export function scheduleSceneCue(cues:readonly SessionSceneCue[],phase:Pick<ScenePhase,'ordinal'>,target:number):SessionSceneCue[] {
  validateCues(cues);
  if(!Number.isSafeInteger(phase.ordinal)||phase.ordinal<0||phase.ordinal>=Number.MAX_SAFE_INTEGER
    ||!Number.isSafeInteger(target)||target<0)throw Error('Cannot queue an invalid scene cue');
  const ordinal=phase.ordinal+1,result=cues.map(cue=>({...cue}));
  const at=result.findIndex(cue=>cue.ordinal>=ordinal);
  if(at>=0&&result[at]!.ordinal===ordinal)result[at]={ordinal,index:target};
  else {
    if(result.length===MAX_SCENE_CUES)throw Error(`This session has ${MAX_SCENE_CUES} scene cues. Reactivate the setup to start a new session.`);
    result.splice(at<0?result.length:at,0,{ordinal,index:target});
  }
  return result;
}

/** The first shuffled cycle begins with the requested scene. Its last slot is
 * reserved exactly as in cycleOrder, so later cycles can be evaluated directly
 * after a seek and cannot repeat the preceding cycle's final scene.
 */
function cuedIndex(n:number,order:readonly number[],cue:SessionSceneCue,seed:number,shuffle:boolean):number {
  const relative=n-cue.ordinal;
  if(!shuffle)return order[(order.indexOf(cue.index)+relative)%order.length]!;
  const cueSeed=(seed^Math.imul(cue.ordinal+1,0x85ebca6b))>>>0;
  const base=shuffled(order,cueSeed);
  if(base.length<=2){
    if(base[0]!==cue.index)[base[0],base[1]]=[base[1]!,base[0]!];
    return base[relative%base.length]!;
  }
  // base[0] is cycle zero's final scene; the explicitly requested first scene
  // must occupy a different slot when the setup has more than one preset.
  if(base[0]===cue.index)[base[0],base[1]]=[base[1]!,base[0]!];
  const cycle=Math.floor(relative/base.length),sequence=[...cycleOrder(base,cycle,cueSeed)];
  if(cycle===0){
    const chosen=sequence.indexOf(cue.index);
    [sequence[0],sequence[chosen]]=[sequence[chosen]!,sequence[0]!];
  }
  return sequence[relative%base.length]!;
}

/** Derive the scene directly from song time and recorded choices. Pause, seek and
 * replay never depend on the order frames were evaluated. Four beats form a bar.
 * Before the offset, the first scene holds at time zero.
 */
export function sceneAt(position:number,order:readonly number[],timing:SceneTiming,shuffle:boolean,cues:readonly SessionSceneCue[]=[]):ScenePhase|null {
  if(!timing.enabled||!order.length||!Number.isFinite(position))return null;
  parseSceneTiming(timing);
  if(order.some(index=>!Number.isSafeInteger(index)||index<0)||new Set(order).size!==order.length)throw Error('Scene order requires unique nonnegative preset indices');
  validateCues(cues,order);
  const duration=240*timing.barsPerScene/timing.bpm;
  const elapsed=Math.max(0,Math.max(0,position)-timing.offsetSeconds);
  // Tolerance only absorbs rounding at a computed boundary (less than a nanosecond).
  const ordinal=Math.floor((elapsed+1e-10)/duration);
  if(!Number.isSafeInteger(ordinal))return null;
  const base=shuffle?shuffled(order,timing.seed):order;
  const at=(n:number)=>{
    let low=0,high=cues.length;
    while(low<high){const middle=Math.floor((low+high)/2);if(cues[middle]!.ordinal<=n)low=middle+1;else high=middle;}
    const cue=low?cues[low-1]:undefined;
    return cue?cuedIndex(n,order,cue,timing.seed,shuffle):shuffle?cycleOrder(base,Math.floor(n/order.length),timing.seed)[n%order.length]!:order[n%order.length]!;
  };
  const localTime=Math.max(0,Math.min(duration,elapsed-ordinal*duration));
  return {index:at(ordinal),previousIndex:at(Math.max(0,ordinal-1)),ordinal,start:timing.offsetSeconds+ordinal*duration,localTime,progress:localTime/duration,duration};
}
