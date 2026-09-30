import {build} from 'esbuild';
import assert from 'node:assert/strict';
async function load(path){const result=await build({entryPoints:[path],bundle:true,format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);}
const K=await load('src/mpc-scene-clock.ts');
const {sceneAt,compileSceneClock,cycleOrder,parseSceneTiming,validateSceneTiming,scheduleSceneCue,defaultSceneTiming}=K;
const {compileGrid}=await load('src/mpc-beat-grid.ts');
const {parseSetups,defaultSettings}=await load('src/mpc-setups.ts');
let seedState=1234567;const rnd=()=>(seedState=(Math.imul(seedState,1664525)+1013904223)>>>0)/4294967296;
const pick=list=>list[Math.floor(rnd()*list.length)];

// ---- Verbatim copy of the v1 clock (before Timing System v2). The differential below proves the fast path is bit-identical. ----
function v1random(seed){let state=seed>>>0;return ()=>{state=(state+0x6d2b79f5)>>>0;let n=state;n=Math.imul(n^(n>>>15),n|1);n^=n+Math.imul(n^(n>>>7),n|61);return ((n^(n>>>14))>>>0)/4294967296;};}
function v1shuffled(values,seed){const result=[...values],next=v1random(seed);for(let i=result.length-1;i>0;i--){const j=Math.floor(next()*(i+1));[result[i],result[j]]=[result[j],result[i]];}return result;}
function v1cycleOrder(base,cycle,seed){
  if(base.length<=2)return base;
  const last=base[cycle%base.length],previousLast=base[(cycle+base.length-1)%base.length];
  const middle=v1shuffled(base.filter(index=>index!==last),(seed^Math.imul(cycle+1,0x9e3779b1))>>>0);
  if(middle[0]===previousLast)[middle[0],middle[1]]=[middle[1],middle[0]];
  return [...middle,last];
}
function v1cuedIndex(n,order,cue,seed,shuffle){
  const relative=n-cue.ordinal;
  if(!shuffle)return order[(order.indexOf(cue.index)+relative)%order.length];
  const cueSeed=(seed^Math.imul(cue.ordinal+1,0x85ebca6b))>>>0;
  const base=v1shuffled(order,cueSeed);
  if(base.length<=2){
    if(base[0]!==cue.index)[base[0],base[1]]=[base[1],base[0]];
    return base[relative%base.length];
  }
  if(base[0]===cue.index)[base[0],base[1]]=[base[1],base[0]];
  const cycle=Math.floor(relative/base.length),sequence=[...v1cycleOrder(base,cycle,cueSeed)];
  if(cycle===0){
    const chosen=sequence.indexOf(cue.index);
    [sequence[0],sequence[chosen]]=[sequence[chosen],sequence[0]];
  }
  return sequence[relative%base.length];
}
function v1sceneAt(position,order,timing,shuffle,cues=[]){
  if(!timing.enabled||!order.length||!Number.isFinite(position))return null;
  const duration=240*timing.barsPerScene/timing.bpm;
  const elapsed=Math.max(0,Math.max(0,position)-timing.offsetSeconds);
  const ordinal=Math.floor((elapsed+1e-10)/duration);
  if(!Number.isSafeInteger(ordinal))return null;
  const base=shuffle?v1shuffled(order,timing.seed):order;
  const at=n=>{
    let low=0,high=cues.length;
    while(low<high){const middle=Math.floor((low+high)/2);if(cues[middle].ordinal<=n)low=middle+1;else high=middle;}
    const cue=low?cues[low-1]:undefined;
    return cue?v1cuedIndex(n,order,cue,timing.seed,shuffle):shuffle?v1cycleOrder(base,Math.floor(n/order.length),timing.seed)[n%order.length]:order[n%order.length];
  };
  const localTime=Math.max(0,Math.min(duration,elapsed-ordinal*duration));
  return {index:at(ordinal),previousIndex:at(Math.max(0,ordinal-1)),ordinal,start:timing.offsetSeconds+ordinal*duration,localTime,progress:localTime/duration,duration};
}
const sevenKeys=frame=>frame&&{index:frame.index,previousIndex:frame.previousIndex,ordinal:frame.ordinal,start:frame.start,localTime:frame.localTime,progress:frame.progress,duration:frame.duration};

// 1. v1 parity, bit for bit, over 1e5 random inputs including shuffles and recorded cues; through sceneAt and through the compiled clock.
{
  let compared=0;
  for(let run=0;run<2000;run++){
    const timing={...defaultSceneTiming,enabled:true,bpm:pick([20,92,109,120,133.33,400,20+rnd()*380]),barsPerScene:pick([1,2,4,8,12,128,1+Math.floor(rnd()*128)]),offsetSeconds:pick([0,.375,-17,3600,-3600,(rnd()-.5)*7200]),seed:pick([0,1,73,4294967295,Math.floor(rnd()*4294967296)])};
    const size=pick([1,2,3,4,7,16,40]),pool=Array.from({length:60},(_,i)=>i*3+1),order=[...pool].sort(()=>rnd()-.5).slice(0,size),shuffle=rnd()<.5;
    const cues=[];let ordinal=-1;for(let c=0;c<pick([0,0,1,3,9]);c++){ordinal+=1+Math.floor(rnd()*6);cues.push({ordinal,index:pick(order)});}
    const clock=compileSceneClock(timing),span=240*timing.barsPerScene/timing.bpm;
    for(let i=0;i<50;i++){
      const position=pick([rnd()*span*30,rnd()*5e5,-5,0,timing.offsetSeconds,timing.offsetSeconds+span*Math.floor(rnd()*40),timing.offsetSeconds+span*Math.floor(rnd()*40)-1e-11,rnd()*100,1e12]);
      const expected=v1sceneAt(position,order,timing,shuffle,cues);
      assert.deepEqual(sceneAt(position,order,timing,shuffle,cues),expected,`sceneAt ${JSON.stringify({timing,position,shuffle})}`);
      const frame=clock.at(position,order,shuffle,cues);
      assert.deepEqual(sevenKeys(frame),expected,'clock frame');
      if(expected){assert.equal(frame.end,timing.offsetSeconds+(expected.ordinal+1)*span);assert.equal(frame.beatsPerBar,4);assert.equal(frame.startBeat,expected.ordinal*timing.barsPerScene*4);}
      compared++;
    }
  }
  assert.equal(compared,100000);
}
// The compiled clock keeps the v1 error behaviour.
{
  const timing={...defaultSceneTiming,enabled:true},clock=compileSceneClock(timing),order=[8,2,7,4];
  assert.equal(clock.at(Infinity,order,false),null);assert.equal(clock.at(NaN,order,false),null);assert.equal(clock.at(Number.MAX_VALUE,order,false),null);assert.equal(clock.at(10,[],false),null);
  assert.equal(compileSceneClock(defaultSceneTiming).at(10,order,false),null,'a disabled clock is null');
  assert.throws(()=>clock.at(10,[1,1],true));assert.throws(()=>clock.at(10,[-1],false));assert.throws(()=>clock.at(10,[1.5],false));
  for(const cues of [null,{},[{ordinal:-1,index:8}],[{ordinal:.5,index:8}],[{ordinal:2,index:8},{ordinal:1,index:2}],[{ordinal:2,index:8},{ordinal:2,index:2}],[{ordinal:2,index:-1}],[{ordinal:2,index:999}]])assert.throws(()=>clock.at(70,order,false,cues));
  for(const bad of [null,{},{...timing,bpm:0},{...timing,barsPerScene:129},{...timing,seed:-1},{...timing,beatsPerBar:0}])assert.throws(()=>compileSceneClock(bad));
  // Order and cue lists are validated once per array; a new invalid array is still caught.
  const bad=[1,2,3];clock.at(5,bad,false);assert.throws(()=>clock.at(5,[1,2,2],false));
  const big=Array.from({length:3400},(_,i)=>i*2);
  for(let i=0;i<50;i++)assert.equal(clock.at(i*7.3,big,i%2===0)?.ordinal!==undefined,true);
}

// 2. The general beat-domain path agrees with the legacy arithmetic to 1e-9 on constant, four-beat inputs.
{
  let compared=0;
  for(let run=0;run<600;run++){
    const bars=pick([1,2,4,8,16,128]),bpm=pick([20,92,120,133.33,400,20+rnd()*380]),offset=pick([0,.375,-17,(rnd()-.5)*200]),legacy={...defaultSceneTiming,enabled:true,bpm,barsPerScene:bars,offsetSeconds:offset,seed:5};
    const general=compileSceneClock({...legacy,barsPattern:[bars]}),old=compileSceneClock(legacy),order=[3,1,4,5,9,2,6],span=240*bars/bpm;
    for(let i=0;i<40;i++){
      const position=offset+span*(rnd()*60);
      const nearBoundary=Math.abs(((position-offset)/span)-Math.round((position-offset)/span))*span<1e-6;
      if(nearBoundary)continue;
      const a=general.at(position,order,rnd()<.5,[]),b=old.at(position,order,false,[]),c2=general.at(position,order,false,[]);
      assert.equal(a.ordinal,b.ordinal);assert.ok(Math.abs(a.start-b.start)<1e-9&&Math.abs(a.localTime-b.localTime)<1e-9&&Math.abs(a.duration-b.duration)<1e-9&&Math.abs(a.progress-b.progress)<1e-9,`${bpm} ${bars} ${offset}`);
      assert.equal(c2.index,b.index);assert.equal(c2.previousIndex,b.previousIndex);
      assert.ok(Math.abs(a.end-b.end)<1e-9&&Math.abs(a.beat-b.beat)<1e-9&&a.bar===b.bar&&a.beatInBar===b.beatInBar&&a.barsRemaining===b.barsRemaining);
      compared++;
    }
  }
  assert.ok(compared>20000);
}

// 3. Patterns: [4,4,8,16] boundaries, cycling and hold-last, several meters.
{
  const bpm=120,offset=1.5,order=[10,11,12,13,14,15];
  for(const [pattern,hold,perBar] of [[[4,4,8,16],false,4],[[4,4,8,16],true,4],[[2,1,3],false,3],[[1,5],true,5],[[3],false,7],[[7,1,1],true,16],[[1],true,1]]){
    const timing={...defaultSceneTiming,enabled:true,bpm,offsetSeconds:offset,seed:9,barsPerScene:pattern[0],barsPattern:pattern,patternHold:hold,beatsPerBar:perBar};
    const clock=compileSceneClock(timing),beatSeconds=60/bpm;
    let startBeat=0;
    for(let n=0;n<40;n++){
      const bars=hold&&n>=pattern.length?pattern.at(-1):pattern[n%pattern.length],beats=bars*perBar;
      const start=clock.grid.timeAt(startBeat);
      const first=clock.at(start,order,false,[]);
      assert.equal(first.ordinal,n,`${pattern} hold ${hold} n ${n}`);assert.equal(first.startBeat,startBeat);assert.equal(first.endBeat,startBeat+beats);assert.equal(first.start,start);
      assert.ok(Math.abs(first.duration-beats*beatSeconds)<1e-9);assert.equal(first.localTime,0);assert.equal(first.beatsPerBar,perBar);
      assert.equal(first.index,order[n%order.length]);
      assert.equal(first.barsRemaining,bars,'a full scene of bars remains at its start');
      assert.equal(first.bar,startBeat/perBar);assert.equal(first.beatInBar,0);assert.equal(first.beatPhase,0);assert.equal(first.barPhase,0);
      const before=clock.at(start-1e-6,order,false,[]);assert.equal(before.ordinal,Math.max(0,n-1));
      if(n>0){assert.equal(before.barsRemaining,1,'one bar left just before the boundary');assert.ok(before.remaining>0&&before.remaining<2e-6);assert.equal(before.end,start,'end of a scene is bitwise the start of the next');assert.equal(first.previousStart,before.start);assert.equal(first.previousFrozen,before.duration);}
      const middle=clock.at(start+first.duration/2,order,false,[]);assert.equal(middle.ordinal,n);assert.ok(Math.abs(middle.progress-.5)<1e-9);assert.ok(Math.abs(middle.beatProgress-.5)<1e-9);
      startBeat+=beats;
    }
    assert.equal(clock.boundaryBar(5),clock.grid.constant?compileSceneClock(timing).boundaryBar(5):0);
  }
  // Explicit pattern arithmetic for the documented example.
  const clock=compileSceneClock({...defaultSceneTiming,enabled:true,bpm:120,offsetSeconds:0,barsPattern:[4,4,8,16],barsPerScene:4});
  assert.deepEqual([0,1,2,3,4,5].map(n=>clock.boundaryBar(n)),[0,4,8,16,32,36]);
  assert.deepEqual([0,4,8,16,32,36,40].map(t=>clock.at(t*2,[0,1,2,3],false,[]).ordinal),[0,1,2,3,4,5,6]);
  assert.equal(clock.at(31*2,[0,1,2,3],false,[]).ordinal,3);
}

// 4. Meters: durations for beatsPerBar 3, 5, 7 and the bar counter.
for(const perBar of [3,5,7]){
  const timing={...defaultSceneTiming,enabled:true,bpm:100,barsPerScene:2,offsetSeconds:0,beatsPerBar:perBar},clock=compileSceneClock(timing),order=[0,1,2];
  const f=clock.at(0,order,false,[]);assert.ok(Math.abs(f.duration-2*perBar*.6)<1e-12);assert.equal(f.endBeat,2*perBar);
  const g=clock.at(.6*(perBar+1),order,false,[]);assert.equal(g.bar,1);assert.equal(g.beatInBar,1);assert.equal(g.barsRemaining,1);assert.equal(clock.barBeat(.6*(perBar+1)).bar,2);assert.equal(clock.barBeat(.6*(perBar+1)).beat,2);
  assert.equal(clock.clockGrid.beatsPerBar,perBar);
}

// 5. Tempo maps: boundaries stay on beats, adjacent scenes share their boundary bitwise, the tempo is instantaneous.
{
  const timing={...defaultSceneTiming,enabled:true,bpm:120,offsetSeconds:1.5,barsPerScene:2,seed:3,tempoMap:[{at:20,bpm:90},{at:50,bpm:140.5},{at:51.25,bpm:20},{at:300,bpm:400}]};
  const clock=compileSceneClock(timing),grid=compileGrid(120,1.5,timing.tempoMap),order=[0,1,2,3];let previousEnd=null;
  assert.equal(clock.grid.constant,false);
  assert.deepEqual(clock.clockGrid,{offset:1.5,bpm:120,beatsPerBar:4,changes:[[20,90],[50,140.5],[51.25,20],[300,400]]});
  for(let n=0;n<400;n++){
    const start=grid.timeAt(8*n),frame=clock.at(start,order,false,[]);
    assert.equal(frame.ordinal,n);assert.equal(frame.start,start);assert.equal(frame.startBeat,8*n);assert.equal(frame.localTime,0);
    if(previousEnd!==null)assert.equal(previousEnd,frame.start,'end of scene n is bitwise the start of scene n+1');
    previousEnd=frame.end;
    if(n>0)assert.equal(clock.at(start-1e-6,order,false,[]).ordinal,n-1);
    const mid=clock.at((frame.start+frame.end)/2,order,false,[]);assert.equal(mid.ordinal,n);assert.ok(Math.abs(mid.beat-(8*n+mid.beatProgress*8))<1e-9);
    assert.equal(mid.bpm,grid.bpmAt((frame.start+frame.end)/2));
  }
  assert.equal(clock.at(10,order,false,[]).bpm,120);assert.equal(clock.at(20,order,false,[]).bpm,90);assert.equal(clock.at(60,order,false,[]).bpm,20);assert.equal(clock.at(1000,order,false,[]).bpm,400);
  // Scene durations change with the tempo but always cover whole beats.
  const slow=clock.at(150,order,false,[]),fast=clock.at(1000,order,false,[]);assert.ok(Math.abs(slow.duration-24)<1e-9&&Math.abs(fast.duration-1.2)<1e-9,`${slow.duration} ${fast.duration}`);
}

// 6. Signals at and around a boundary, count-in and the bar:beat readout.
{
  const timing={...defaultSceneTiming,enabled:true,bpm:120,offsetSeconds:4,barsPerScene:2,beatsPerBar:3,barsPattern:[2]},clock=compileSceneClock(timing),order=[0,1];
  const early=clock.at(0,order,false,[]);assert.equal(early.countIn,4);assert.equal(early.ordinal,0);assert.equal(early.beat,0);assert.equal(early.localTime,0);assert.equal(early.remaining,7,'remaining counts down to the scene end, count-in included');assert.deepEqual(clock.barBeat(0),{bar:1,beat:1});
  assert.equal(clock.at(1,order,false,[]).countIn,3);assert.equal(clock.at(4,order,false,[]).countIn,0);assert.equal(clock.at(10,order,false,[]).countIn,0);
  assert.deepEqual([4,4.5,5,5.5,6,6.5].map(t=>clock.barBeat(t)),[{bar:1,beat:1},{bar:1,beat:2},{bar:1,beat:3},{bar:2,beat:1},{bar:2,beat:2},{bar:2,beat:3}]);
  assert.deepEqual(clock.barBeat(NaN),{bar:1,beat:1});assert.deepEqual(clock.barBeat(-50),{bar:1,beat:1});
  const at=t=>clock.at(t,order,false,[]);
  assert.equal(at(5.5-1e-12).bar,1,'within the tolerance of a bar line the bar has begun');assert.equal(at(5.5-1e-4).bar,0);assert.equal(at(5.5-1e-4).beatInBar,2);
  assert.ok(Math.abs(at(5.25).beatPhase-.5)<1e-12);assert.ok(Math.abs(at(5.25).barPhase-(2+.5)/3)<1e-12);
  assert.equal(at(7).barsRemaining,2,'the next scene starts with all its bars');assert.equal(at(4).barsRemaining,2);assert.equal(at(6.9).barsRemaining,1);assert.equal(at(5.4).barsRemaining,2);
  assert.equal(at(7.999999).remaining>0,true);
  // A negative position reads as zero, exactly like v1.
  assert.deepEqual(sevenKeys(clock.at(-10,order,false,[])),sevenKeys(clock.at(0,order,false,[])));
  // sceneAt (the legacy entry point) agrees with the clock's seven keys under a v2 timing too.
  for(const t of [0,4,5.5,7,8,100,1234.5])assert.deepEqual(sceneAt(t,order,timing,false,[]),sevenKeys(clock.at(t,order,false,[])));
}

// 7. Determinism: any evaluation order gives the same frames; pause, seek and repeat cannot change a frame.
{
  const timing={...defaultSceneTiming,enabled:true,bpm:133.33,offsetSeconds:2.75,barsPerScene:4,seed:88,beatsPerBar:5,barsPattern:[4,2,8],patternHold:false,tempoMap:[{at:60,bpm:97},{at:200,bpm:150}]};
  const clock=compileSceneClock(timing),order=[5,6,7,8,9,10],cues=[{ordinal:3,index:8},{ordinal:9,index:5}];
  const fade={timing:6,randomSet:22,anchor:1,fixedMs:1500},positions=Array.from({length:2000},()=>rnd()*1200);
  for(const shuffle of [false,true]){
    const sequential=positions.map(p=>clock.at(p,order,shuffle,cues,fade));
    const fresh=compileSceneClock(timing),shuffledOrder=positions.map((_,i)=>i).sort(()=>rnd()-.5);
    for(const i of shuffledOrder){assert.deepEqual(fresh.at(positions[i],order,shuffle,cues,fade),sequential[i],'random evaluation order');assert.deepEqual(clock.at(positions[i],order,shuffle,cues,fade),sequential[i],'repeat');}
    assert.deepEqual(clock.at(positions[7],[...order],shuffle,[...cues],fade),sequential[7],'equal contents in new arrays');
  }
  // The compiled clock does not mutate its inputs.
  const snapshot=JSON.stringify({timing,order,cues,fade});clock.at(10,order,true,cues,fade);assert.equal(JSON.stringify({timing,order,cues,fade}),snapshot);
  assert.notEqual(clock.timing,timing,'the compiled clock owns a validated copy');
}

// 8. Shuffle and recorded cues are keyed by ordinal and follow the pattern.
{
  const timing={...defaultSceneTiming,enabled:true,bpm:120,barsPattern:[2,4,1,3],beatsPerBar:4,seed:21},clock=compileSceneClock(timing),order=Array.from({length:16},(_,i)=>i*5+3);
  const phase=clock.at(1,order,false,[]),cues=scheduleSceneCue([],phase,order[9]);
  const boundary=clock.grid.timeAt(clock.boundaryBar(1)*4);
  assert.equal(clock.at(boundary-1e-6,order,false,cues).index,order[0]);assert.equal(clock.at(boundary,order,false,cues).index,order[9],'the cue lands on the pattern boundary');
  assert.equal(clock.at(boundary,order,false,cues).previousIndex,order[0]);
  const next=clock.at(clock.grid.timeAt(clock.boundaryBar(2)*4),order,false,cues);assert.equal(next.index,order[10],'ordered cues continue from the chosen scene');
  // Shuffled cycles stay permutations and never repeat across a cycle boundary, with a pattern in force.
  for(const count of [1,2,3,5,16])for(const seed of [0,1,29,4294967295]){
    const list=order.slice(0,count),c={...timing,seed},k=compileSceneClock(c);let previous;
    for(let cycle=0;cycle<6;cycle++){
      const seen=[];
      for(let n=0;n<count;n++){const f=k.at(k.grid.timeAt(k.boundaryBar(cycle*count+n)*4),list,true,[]);assert.equal(f.ordinal,cycle*count+n);seen.push(f.index);if(previous!==undefined&&count>1)assert.notEqual(f.index,previous);if(previous!==undefined)assert.equal(f.previousIndex,previous);previous=f.index;}
      assert.deepEqual([...seen].sort((a,b)=>a-b),list);
    }
  }
}

// 9. Fade windows: both anchors, the seeded pick by incoming ordinal, seeks inside a window.
{
  const timing={...defaultSceneTiming,enabled:true,bpm:120,offsetSeconds:0,barsPerScene:2,seed:5},clock=compileSceneClock(timing),order=[0,1,2,3,4,5];   // 4 s scenes
  const beatsFade={timing:3,randomSet:31,anchor:0,fixedMs:2000};    // 2 beats = 1 s
  const start=clock.at(8.25,order,false,[],beatsFade).fade;
  assert.equal(start.ordinal,2);assert.equal(start.from,1);assert.equal(start.to,2);assert.equal(start.start,8);assert.equal(start.end,9);assert.equal(start.seconds,1);assert.equal(start.beats,2);assert.equal(start.timing,3);assert.equal(start.anchor,0);assert.equal(start.pivot,0);assert.equal(start.progress,.25);
  assert.equal(clock.at(9,order,false,[],beatsFade).fade,null,'the window is half-open');assert.equal(clock.at(8,order,false,[],beatsFade).fade.progress,0);assert.equal(clock.at(3.5,order,false,[],beatsFade).fade,null);
  const end=clock.at(11.75,order,false,[],{...beatsFade,anchor:1}).fade;
  assert.equal(end.ordinal,3,'the window belongs to the boundary it lands on');assert.equal(end.from,2);assert.equal(end.to,3);assert.equal(end.start,11);assert.equal(end.end,12);assert.equal(end.pivot,1);assert.equal(end.progress,.75);
  const during=clock.at(11.75,order,false,[],{...beatsFade,anchor:1});assert.equal(during.index,2,'the musically current scene is unchanged during an end-anchored window');assert.equal(during.ordinal,2);
  assert.equal(clock.at(12,order,false,[],{...beatsFade,anchor:1}).fade,null);assert.equal(clock.at(12,order,false,[],{...beatsFade,anchor:1}).ordinal,3);
  // A fade longer than the scene is capped by the incoming scene (start) or the outgoing scene (end).
  const long={timing:5,randomSet:31,anchor:0,fixedMs:2000};    // 2 bars = 16 beats = 8 s, scenes are 4 s
  assert.equal(clock.at(8.5,order,false,[],long).fade.seconds,4);assert.equal(clock.at(8.5,order,false,[],long).fade.beats,8);
  assert.equal(clock.at(10,order,false,[],{...long,anchor:1}).fade.seconds,4);
  // Seconds mode is the legacy fixed length; Instant has no window; Random follows the seeded bag by ordinal, and replays after a seek.
  const seconds=clock.at(8.5,order,false,[],{timing:0,randomSet:31,anchor:0,fixedMs:750}).fade;assert.equal(seconds.seconds,.75);assert.equal(seconds.timing,0);
  assert.equal(clock.at(8.5,order,false,[],{timing:1,randomSet:31,anchor:0,fixedMs:750}).fade,null);
  const random={timing:6,randomSet:31,anchor:0,fixedMs:2000},picks=[];
  for(let n=1;n<40;n++)picks.push(clock.at(4*n+.1,order,false,[],random).fade?.timing??1);
  assert.ok(new Set(picks).size>1);
  const replay=[];for(let n=39;n>=1;n--)replay.unshift(clock.at(4*n+.1,order,false,[],random).fade?.timing??1);
  assert.deepEqual(replay,picks,'the same boundary draws the same fade after seeking away and back');
  // The fade of a tempo-mapped clock ends on a real beat.
  const mapped=compileSceneClock({...timing,tempoMap:[{at:9.3,bpm:60}]});
  const crossing=mapped.at(8.3,order,false,[],{timing:4,randomSet:31,anchor:0,fixedMs:2000}).fade;    // boundary at beat 16 (8 s), the tempo halves at 9.3 s
  assert.equal(crossing.ordinal,2);assert.equal(crossing.start,8);assert.ok(Math.abs(mapped.grid.beatAt(crossing.end)-20)<1e-9,'a start-anchored bar ends exactly four beats after the boundary');assert.ok(Math.abs(crossing.seconds-2.7)<1e-9);assert.equal(crossing.beats,4);
  const landing=mapped.at(13.5,order,false,[],{timing:4,randomSet:31,anchor:1,fixedMs:2000}).fade;    // boundary at beat 24 (14.7 s)
  assert.equal(landing.ordinal,3);assert.ok(Math.abs(landing.end-mapped.grid.timeAt(24))<1e-9);assert.ok(Math.abs(mapped.grid.beatAt(landing.start)-20)<1e-9,'an end-anchored bar begins exactly four beats before the boundary');
}

// 10. Parsing: strict per field, minimal serialisation, tolerant of the future.
{
  const v1={enabled:true,bpm:109,offsetSeconds:2.75,barsPerScene:12,seed:73};
  const round=value=>JSON.parse(JSON.stringify(parseSceneTiming(JSON.parse(JSON.stringify(value)))));
  assert.deepEqual(round(v1),v1);assert.equal(JSON.stringify(parseSceneTiming(v1)),JSON.stringify(v1),'a v1 timing serialises as exactly its five keys');
  assert.deepEqual(Object.keys(parseSceneTiming({...v1,foo:1,version:2,beatsPerBar:4,patternHold:false,script:[],intervals:[],bar:{}})),['enabled','bpm','offsetSeconds','barsPerScene','seed'],'defaults and unknown keys are dropped');
  assert.deepEqual(Object.keys(parseSceneTiming({...v1,version:7})),Object.keys(v1),'version alone adds nothing');
  const hash='a'.repeat(64);
  const full={...v1,version:2,beatsPerBar:3,barsPattern:[4,4,8,16],patternHold:true,tempoMap:[{at:20,bpm:90},{at:40.5,bpm:120}],script:[{ordinal:0,preset:hash},{ordinal:9,preset:'f'.repeat(64)}],intervals:[{id:'boss_timer-1',startBeat:0,endBeat:64.5}]};
  assert.deepEqual(parseSceneTiming(full),full);assert.deepEqual(Object.keys(parseSceneTiming(full)),['enabled','bpm','offsetSeconds','barsPerScene','seed','version','beatsPerBar','barsPattern','patternHold','tempoMap','script','intervals']);
  assert.deepEqual(round(full),full,'a v2 timing round trips');
  assert.deepEqual(parseSceneTiming({...full,version:3,future:{x:1}}),full,'a newer version keeps the fields this build knows');
  assert.equal(parseSceneTiming({...v1,beatsPerBar:5}).version,2,'version 2 is written with the first v2 field');
  assert.deepEqual(parseSceneTiming({...v1,patternHold:true}),{...v1,version:2,patternHold:true});
  // Entries are rebuilt from known keys and copied.
  const source={...v1,tempoMap:[{at:20,bpm:90,extra:1}],barsPattern:[4]},parsed=parseSceneTiming(source);
  assert.deepEqual(parsed.tempoMap,[{at:20,bpm:90}]);parsed.barsPattern.push(5);parsed.tempoMap.push({at:1,bpm:1});assert.deepEqual(source.barsPattern,[4]);assert.equal(source.tempoMap.length,1,'the result does not alias its input');
  const polluted=JSON.parse('{"enabled":true,"bpm":120,"offsetSeconds":0,"barsPerScene":8,"seed":1,"__proto__":{"polluted":true},"constructor":{"x":1}}');
  assert.deepEqual(Object.keys(parseSceneTiming(polluted)),Object.keys(v1));assert.equal({}.polluted,undefined);
  const bad=(patch,pattern)=>assert.throws(()=>parseSceneTiming({...v1,...patch}),pattern,JSON.stringify(patch).slice(0,120));
  for(const value of [0,17,2.5,-1,'4',null,NaN,Infinity,true])bad({beatsPerBar:value},/beatsPerBar must be a whole number from 1 to 16/);
  for(const value of [1,16,3])assert.doesNotThrow(()=>parseSceneTiming({...v1,beatsPerBar:value}));
  for(const value of [[],Array.from({length:65},()=>4),[0],[129],[1.5],['4'],[4,NaN],[null],'4,4',{},4,null])bad({barsPattern:value},/barsPattern must list 1 to 64 whole numbers from 1 to 128/);
  for(const value of [[1],[128],Array.from({length:64},(_,i)=>i+1)])assert.doesNotThrow(()=>parseSceneTiming({...v1,barsPattern:value}));
  for(const value of ['yes',1,0,null])bad({patternHold:value},/patternHold must be true or false/);
  const map=(...entries)=>entries.map(([at,bpm])=>({at,bpm}));
  for(const value of [[],Array.from({length:257},(_,i)=>({at:3+i,bpm:100})),map([2.75,100]),map([2,100]),map([10,100],[10,90]),map([10,100],[9,90]),map([1000001,100]),map([10,19.99]),map([10,400.01]),map([NaN,100]),map([10,NaN]),map([Infinity,100]),[null],['x'],[{at:'10',bpm:100}],{at:10,bpm:100},null])bad({tempoMap:value},/tempoMap/);
  assert.doesNotThrow(()=>parseSceneTiming({...v1,tempoMap:map([2.75000001,20],[1e6,400])}));assert.doesNotThrow(()=>parseSceneTiming({...v1,tempoMap:Array.from({length:256},(_,i)=>({at:3+i,bpm:100}))}));
  bad({offsetSeconds:30,tempoMap:map([20,100])},/tempoMap/);assert.doesNotThrow(()=>parseSceneTiming({...v1,offsetSeconds:-3600,tempoMap:map([-3599,100])}));
  const cue=(ordinal,preset=hash)=>({ordinal,preset});
  for(const value of [[cue(-1)],[cue(1.5)],[cue(NaN)],[cue(1),cue(1)],[cue(2),cue(1)],[cue(1,'A'.repeat(64))],[cue(1,'a'.repeat(63))],[cue(1,'g'.repeat(64))],[cue(1,5)],[null],Array.from({length:1025},(_,i)=>cue(i)),'x',{}])bad({script:value},/script/);
  assert.doesNotThrow(()=>parseSceneTiming({...v1,script:Array.from({length:1024},(_,i)=>cue(i))}));assert.doesNotThrow(()=>parseSceneTiming({...v1,script:[cue(0)]}));
  const iv=(id,startBeat,endBeat)=>({id,startBeat,endBeat});
  for(const value of [[iv('A',0,1)],[iv('',0,1)],[iv('x'.repeat(33),0,1)],[iv('a b',0,1)],[iv('a',0,1),iv('a',1,2)],[iv('a',-1,1)],[iv('a',1,1)],[iv('a',2,1)],[iv('a',0,1e7+1)],[iv('a',NaN,1)],[iv('a',0,Infinity)],[iv('a','0',1)],[null],Array.from({length:65},(_,i)=>iv(`i${i}`,0,1)),'x'])bad({intervals:value},/intervals/);
  assert.doesNotThrow(()=>parseSceneTiming({...v1,intervals:Array.from({length:64},(_,i)=>iv(`i${i}`,0,1e7)).concat([])}));assert.doesNotThrow(()=>parseSceneTiming({...v1,intervals:[iv('x'.repeat(32),0,.5)]}));
  for(const value of ['2',0,-1,1.5,null,NaN])bad({version:value},/version must be a positive whole number/);
  // v1 fields keep the historical message.
  for(const patch of [{bpm:19},{bpm:401},{offsetSeconds:3601},{barsPerScene:0},{barsPerScene:129},{seed:-1},{enabled:1}])bad(patch,/^Error: Scene timing requires 20–400 BPM|Scene timing requires 20–400 BPM/);
  assert.equal(validateSceneTiming(full),true);assert.equal(validateSceneTiming({...full,beatsPerBar:99}),false);
  // The setup file path parses v2 timing and round trips it.
  const setup={id:'s',name:'S',presets:[hash],settings:defaultSettings,timing:full};
  assert.deepEqual(parseSetups(JSON.parse(JSON.stringify([setup]))),[{...setup}]);
  assert.deepEqual(parseSetups([{...setup,timing:v1}])[0].timing,v1);assert.deepEqual(parseSetups([{id:'s',name:'S',presets:[hash],settings:defaultSettings}])[0].timing,defaultSceneTiming);
}

// 11. cycleOrder is exported with its v1 behaviour.
for(const size of [1,2,3,4,9])for(const seed of [0,7,4294967295])for(let cycle=0;cycle<12;cycle++){const base=Array.from({length:size},(_,i)=>i+10);assert.deepEqual(cycleOrder(base,cycle,seed),v1cycleOrder(base,cycle,seed));}

// 12. Named intervals resolve to seconds through the grid (tempo map included); only the running ones are active, and none allocates per frame.
{
  const iv=(id,startBeat,endBeat)=>({id,startBeat,endBeat}),base={enabled:true,bpm:120,offsetSeconds:2,barsPerScene:4,seed:3};
  const bare=compileSceneClock(base);
  assert.deepEqual(bare.intervals,[]);assert.deepEqual(bare.activeIntervals(5),[]);assert.equal(bare.activeIntervals(1),bare.activeIntervals(99),'one shared empty array');
  const timing={...base,version:2,intervals:[iv('boss',8,40),iv('warn',0,4),iv('overlap',8,12),iv('late',1000,1001)],tempoMap:[{at:12,bpm:60}]};
  const clock=compileSceneClock(timing),grid=compileGrid(120,2,timing.tempoMap);
  assert.deepEqual(clock.intervals.map(i=>i.id),['boss','warn','overlap','late'],'timing order is kept');
  for(const [i,source] of timing.intervals.entries()){assert.equal(clock.intervals[i].start,grid.timeAt(source.startBeat));assert.equal(clock.intervals[i].end,grid.timeAt(source.endBeat));assert.ok(clock.intervals[i].end>clock.intervals[i].start);}
  // 120 BPM to 12 s (beat 20), then 60 BPM: beat 8 is 6 s, beat 40 is 32 s.
  assert.equal(clock.intervals[0].start,6);assert.equal(clock.intervals[0].end,32);assert.equal(clock.intervals[1].start,2,'startBeat 0 is the offset');assert.equal(clock.intervals[1].end,4);
  assert.ok(Object.isFrozen(clock.intervals)&&clock.intervals.every(Object.isFrozen),'resolved intervals are immutable');
  const ids=position=>clock.activeIntervals(position).map(i=>i.id);
  assert.deepEqual(ids(1.999),[]);assert.deepEqual(ids(2),['warn'],'the start is inside');assert.deepEqual(ids(3.9999),['warn']);assert.deepEqual(ids(4),[],'the end is outside');
  assert.deepEqual(ids(6),['boss','overlap'],'overlapping intervals keep timing order');assert.deepEqual(ids(31.9999),['boss']);assert.deepEqual(ids(32),[]);
  assert.deepEqual(ids(NaN),[]);assert.deepEqual(ids(Infinity),[]);assert.deepEqual(ids(-5),[]);
  assert.equal(clock.activeIntervals(4),clock.activeIntervals(50),'no running interval shares one empty array');
  // Pure in position: the same answer in any order, and the tempo-free grid agrees with the arithmetic.
  const probes=[0,2,3,4,6,7,9,31.9999,32,500,2,6];
  assert.deepEqual([...probes].reverse().map(ids).reverse(),probes.map(ids));
  const flat=compileSceneClock({...base,version:2,intervals:[iv('a',4,8)]});
  assert.equal(flat.intervals[0].start,4);assert.equal(flat.intervals[0].end,6,'beats 4 to 8 at 120 BPM after a 2 s offset run from 4 s to 6 s');
}

console.log('Scene clock v2 CPU: 100,000 bit-identical v1 comparisons (shuffle, cues, offsets), general path within 1e-9, patterns with cycle/hold and meters 1-16, tempo maps with bitwise shared boundaries, signals and count-in, evaluation-order independence, cues on pattern boundaries, fade windows for both anchors, named intervals resolved through the grid, strict per-field parsing, minimal serialisation and v1 round trip PASS');
