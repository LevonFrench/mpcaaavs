import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
async function load(path){const result=await build({entryPoints:[path],bundle:true,format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);}
const T=await load('src/mpc-transition-timing.ts');
const {FADE_TIMING,FADE_TIMING_LABELS,defaultFadeSpec,fadeFromBeats,beatsFromFade,parseFadeFields,pickFade,planFade,boundaryLevel,FADE_BEAT_LIMIT_SECONDS}=T;
const {compileGrid}=await load('src/mpc-beat-grid.ts');
const {compileSceneClock,defaultSceneTiming}=await load('src/mpc-scene-clock.ts');
const S=await load('src/mpc-setups.ts');
const C=await load('src/mpc-contract.ts');
let seedState=4242;const rnd=()=>(seedState=(Math.imul(seedState,1664525)+1013904223)>>>0)/4294967296;

// Vocabulary and the legacy mapping in both directions.
assert.deepEqual([...FADE_TIMING],['seconds','instant','beat1','beat2','bar1','bar2','random']);
assert.deepEqual([...FADE_TIMING_LABELS],['Seconds','Instant','1 beat','2 beats','1 bar','2 bars','Random']);
assert.deepEqual({...defaultFadeSpec},{timing:0,randomSet:31,anchor:0,fixedMs:2000});assert.ok(Object.isFrozen(defaultFadeSpec));
for(const [beats,timing] of [[0,0],[1,2],[2,3],[4,4]])assert.equal(fadeFromBeats(beats),timing);
for(const invalid of [3,5,-1,1.5,NaN,undefined,null,'2',Infinity,8])assert.equal(fadeFromBeats(invalid),0,`legacy beats ${String(invalid)}`);
assert.deepEqual([0,1,2,3,4,5,6].map(beatsFromFade),[0,0,1,2,4,0,0]);
for(const invalid of [-1,7,1.5,NaN,undefined])assert.equal(beatsFromFade(invalid),0);
for(const beats of [0,1,2,4])assert.equal(beatsFromFade(fadeFromBeats(beats)),beats,'the projection round-trips every legacy value');
assert.deepEqual(C.BEATS_FROM_FADE,[0,0,1,2,4,0,0]);

// parseFadeFields: tolerant host and native message parsing.
{
  const p=raw=>parseFadeFields(raw);
  assert.deepEqual(p({}),{timing:0,randomSet:31,anchor:0,fixedMs:2000},'an old message means defaults');
  assert.deepEqual(p({beats:2}),{timing:3,randomSet:31,anchor:0,fixedMs:2000});
  assert.deepEqual(p({beats:4,durationMs:500}),{timing:4,randomSet:31,anchor:0,fixedMs:500});
  assert.deepEqual(p({beats:2,fadeTiming:6,fadeRandomSet:22,fadeAnchor:2,durationMs:8000}),{timing:6,randomSet:22,anchor:2,fixedMs:8000},'fadeTiming is authoritative over beats');
  for(const bad of [7,-1,1.5,'3',null,NaN])assert.equal(p({fadeTiming:bad,beats:1}).timing,2,`invalid fadeTiming ${String(bad)} derives from beats`);
  assert.equal(p({fadeTiming:9,beats:3}).timing,0,'invalid beats too: Seconds');
  for(const bad of [0,32,-1,2.5,'5',null,NaN])assert.equal(p({fadeRandomSet:bad}).randomSet,31,`invalid mask ${String(bad)}`);
  for(const bad of [3,-1,1.5,'1'])assert.equal(p({fadeAnchor:bad}).anchor,0);
  assert.equal(p({fadeAnchor:2}).anchor,2);
  assert.equal(p({durationMs:80000}).fixedMs,8000,'C-05: 250..8000 at every layer');assert.equal(p({durationMs:10}).fixedMs,250);assert.equal(p({durationMs:NaN}).fixedMs,2000);assert.equal(p({durationMs:'1000'}).fixedMs,2000);
  assert.equal(p({durationMs:999.6}).fixedMs,1000);
  const current={timing:5,randomSet:7,anchor:1,fixedMs:4000};
  assert.deepEqual(parseFadeFields({},current),current,'a missing key keeps the supplied current value');
  assert.deepEqual(parseFadeFields({fadeTiming:2},current),{...current,timing:2});
  assert.deepEqual(parseFadeFields({beats:1},current),{...current,timing:2});
  for(const junk of [null,undefined,'x',5,[]])assert.deepEqual(parseFadeFields(junk),{...defaultFadeSpec});
  assert.notEqual(parseFadeFields({}),defaultFadeSpec,'a fresh object each time');
}

// Lengths: every mode at every tempo and meter is exact; beat lengths stop at 16 s.
const spec=(timing,over={})=>({timing,randomSet:31,anchor:0,fixedMs:2000,...over});
for(const bpm of [20,60,120,133.33,400])for(const perBar of [1,3,4,7,16]){
  const plan=(timing,ctx={})=>planFade(spec(timing),timing,{bpm,beatsPerBar:perBar,...ctx});
  assert.equal(plan(0).seconds,2);assert.equal(plan(0).timing,0);
  assert.equal(plan(1).seconds,0);assert.equal(plan(1).beats,0);
  for(const [timing,beats] of [[2,1],[3,2],[4,perBar],[5,2*perBar]]){
    const p=plan(timing),exact=beats*60/bpm;
    assert.equal(p.seconds,Math.min(FADE_BEAT_LIMIT_SECONDS,exact),`${bpm} BPM ${perBar}/bar mode ${timing}`);
    assert.equal(p.timing,timing);
    if(exact<=16)assert.equal(p.beats,Math.min(64,beats)),assert.equal(p.pivot,0);
    else assert.ok(Math.abs(p.beats*60/bpm-16)<1e-9,'capped beats stay consistent with the seconds');
  }
}
assert.equal(FADE_BEAT_LIMIT_SECONDS,16);
// The legacy formulas: durationBeats * 60 / bpm and durationMs / 1000, bit for bit.
for(const bpm of [92,109,133.33,127.7])for(const [timing,beats] of [[2,1],[3,2],[4,4]])assert.equal(planFade(spec(timing),timing,{bpm,beatsPerBar:4}).seconds,beats*60/bpm);
// Caps by the incoming or outgoing scene, then by the absolute limit.
{
  const at=(cap,timing=4,bpm=60)=>planFade(spec(timing),timing,{bpm,beatsPerBar:4,capSeconds:cap});
  assert.equal(at(2).seconds,2);assert.equal(at(2).beats,2,'beats follow the cap');assert.equal(at(100).seconds,4);assert.equal(at(0).seconds,0);assert.equal(at(0).beats,0);
  assert.equal(at(1.5,0).seconds,1.5,'Seconds is capped by the scene too');
  assert.equal(at(NaN).seconds,4,'a non-finite cap is ignored');assert.equal(at(-3).seconds,0,'a negative cap reads as 0');
  assert.equal(planFade(spec(5),5,{bpm:20,beatsPerBar:16}).seconds,16,'the absolute limit');
  assert.equal(planFade(spec(5),5,{bpm:20,beatsPerBar:16,capSeconds:40}).seconds,16);
}
// No tempo: every non-Instant mode resolves to the fixed length; Instant stays 0.
for(const bpm of [null,undefined,0,-5,NaN])for(const timing of [0,2,3,4,5]){
  const p=planFade(spec(timing,{fixedMs:1500}),timing,{bpm,beatsPerBar:4});
  assert.equal(p.seconds,1.5,`no tempo, mode ${timing}`);assert.equal(p.beats,0);assert.equal(p.timing,timing);
  assert.equal(planFade(spec(1),1,{bpm,beatsPerBar:4}).seconds,0);
}
assert.equal(planFade(spec(0,{fixedMs:5}),0,{bpm:120,beatsPerBar:4}).seconds,.25,'the fixed length keeps 250..8000 ms');assert.equal(planFade(spec(0,{fixedMs:99999}),0,{bpm:120,beatsPerBar:4}).seconds,8);
assert.equal(planFade(spec(0,{fixedMs:2000}),0,{bpm:120,beatsPerBar:4}).beats,4,'Seconds also reports its musical length');
assert.equal(planFade(spec(4),4,{bpm:120,beatsPerBar:99}).seconds,2,'an invalid meter reads as 4');
// Invalid picks and anchors are neutralised, never thrown.
for(const bad of [7,-1,1.5,NaN,undefined])assert.doesNotThrow(()=>planFade(spec(0,{anchor:bad}),bad,{bpm:120,beatsPerBar:4}));
assert.equal(planFade(spec(0,{anchor:7}),0,{bpm:120,beatsPerBar:4}).anchor,0);

// Tempo maps: a fade ends on a real beat.
{
  const grid=compileGrid(120,0,[{at:10,bpm:60},{at:20,bpm:240}]);
  const ctx={bpm:null,beatsPerBar:4,grid};
  const start=planFade(spec(4),4,{...ctx,boundaryBeat:18});     // 18 beats = 9 s; the next 4 beats cross the change at 10 s (20 beats)
  assert.ok(Math.abs(grid.beatAt(grid.timeAt(18)+start.seconds)-22)<1e-9,'a start-anchored bar ends exactly four beats later');
  assert.ok(Math.abs(start.seconds-3)<1e-9,'one second at 120 BPM (two beats) then two seconds at 60 BPM (two beats)');
  const end=planFade(spec(4,{anchor:1}),4,{...ctx,boundaryBeat:22});
  assert.ok(Math.abs(grid.beatAt(grid.timeAt(22)-end.seconds)-18)<1e-9,'an end-anchored bar starts exactly four beats earlier');assert.equal(end.pivot,1);
  assert.ok(Math.abs(end.beats-4)<1e-9);
  const early=planFade(spec(5,{anchor:1}),5,{...ctx,boundaryBeat:3});
  assert.equal(early.seconds,grid.timeAt(3)-grid.timeAt(0),'before the offset the fade is limited to what exists');
  assert.equal(planFade(spec(1),1,{...ctx,boundaryBeat:18}).seconds,0);
  const sec=planFade(spec(0),0,{...ctx,boundaryBeat:18});assert.equal(sec.seconds,2);assert.ok(Math.abs(sec.beats-(1*2+1*1))<1e-9,'2 s starting at 9 s: one second at 120 BPM (2 beats) and one at 60 BPM (1 beat)');
}
// Anchors and the hit pivot.
{
  const hit=beats=>beats>=4?.75:.25;
  const start=planFade(spec(4,{anchor:0}),4,{bpm:120,beatsPerBar:4,pivotForBeats:hit}),endA=planFade(spec(4,{anchor:1}),4,{bpm:120,beatsPerBar:4,pivotForBeats:hit}),peak=planFade(spec(4,{anchor:2}),4,{bpm:120,beatsPerBar:4,pivotForBeats:hit});
  assert.deepEqual([start.pivot,endA.pivot,peak.pivot],[0,1,.75]);
  assert.equal(planFade(spec(2,{anchor:2}),2,{bpm:120,beatsPerBar:4,pivotForBeats:hit}).pivot,.25);
  assert.equal(planFade(spec(4,{anchor:2}),4,{bpm:120,beatsPerBar:4}).pivot,0,'without a hit point the peak behaves as the start (C-06)');
  for(const bad of [NaN,Infinity,-3,7])assert.ok([0,1].includes(planFade(spec(4,{anchor:2}),4,{bpm:120,beatsPerBar:4,pivotForBeats:()=>bad}).pivot),'a misbehaving hook is clamped');
  assert.equal(planFade(spec(1,{anchor:2}),1,{bpm:120,beatsPerBar:4,pivotForBeats:hit}).pivot,0,'Instant has no peak');
  assert.equal(planFade(spec(1,{anchor:1}),1,{bpm:120,beatsPerBar:4}).seconds,0);
}

// Random: a seeded bag over the chosen members.
const CONCRETE=[1,2,3,4,5];
for(let mask=1;mask<32;mask++)for(const seed of [0,1,12345,4294967295,0x9e3779b1]){
  const members=CONCRETE.filter((_,i)=>mask>>i&1),k=members.length,cycles=60,picks=[];
  for(let n=0;n<k*cycles;n++)picks.push(pickFade(spec(6,{randomSet:mask}),n,seed));
  for(let c=0;c<cycles;c++)assert.deepEqual([...picks.slice(c*k,c*k+k)].sort(),members,`mask ${mask} cycle ${c} is a permutation`);
  assert.ok(picks.every(p=>members.includes(p)),'membership respected');
  if(k>=3)for(let n=1;n<picks.length;n++)assert.notEqual(picks[n],picks[n-1],`no repeat at ${n}, mask ${mask}`);
  if(k===2)for(let n=1;n<picks.length;n++)assert.notEqual(picks[n],picks[n-1],'two members alternate');
  if(k===1)assert.ok(picks.every(p=>p===members[0]),'a single bit is that fixed mode');
  if(k>=4){const orders=new Set();for(let c=0;c<cycles;c++)orders.add(picks.slice(c*k,c*k+k).join());assert.ok(orders.size>3,`mask ${mask}: permutations vary between cycles`);}
}
// Replay: a pure function of (spec, ordinal, seed), independent of evaluation order, seeks and repeats.
{
  const s6=spec(6,{randomSet:22}),sequential=Array.from({length:10000},(_,n)=>pickFade(s6,n,777));
  const order=Array.from({length:10000},(_,i)=>i);for(let i=order.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
  for(const n of order)assert.equal(pickFade(s6,n,777),sequential[n]);
  // With four or five members the seed picks the permutations; with three the no-repeat rule leaves a single valid ordering per cycle.
  for(const mask of [15,31,30,27])assert.notDeepEqual(Array.from({length:60},(_,n)=>pickFade(spec(6,{randomSet:mask}),n,1)),Array.from({length:60},(_,n)=>pickFade(spec(6,{randomSet:mask}),n,2)),`the seed changes the sequence, mask ${mask}`);
  assert.notDeepEqual(Array.from({length:60},(_,n)=>pickFade(spec(6),n,5)),Array.from({length:60},(_,n)=>pickFade(spec(6),n+1,5)));
  // Live counter stream: stable for a seed.
  const live=seed=>{let count=0;return Array.from({length:40},()=>pickFade(spec(6),count++,seed));};
  assert.deepEqual(live(31337),live(31337));
  // The style salt of the transition stream is independent of this one.
  assert.notDeepEqual(Array.from({length:40},(_,n)=>pickFade(spec(6),n,9)),Array.from({length:40},(_,n)=>pickFade(spec(6),n,9^0xa5f1c3d7)));
}
// Non-random specs return their own timing; invalid masks and indices are neutralised, never thrown.
for(const timing of [0,1,2,3,4,5])assert.equal(pickFade(spec(timing),123,9),timing);
for(const bad of [0,32,-1,2.5,NaN,undefined,'7'])assert.deepEqual(Array.from({length:10},(_,n)=>pickFade(spec(6,{randomSet:bad}),n,3)),Array.from({length:10},(_,n)=>pickFade(spec(6,{randomSet:31}),n,3)),`mask ${String(bad)} reads as all five`);
for(const bad of [-5,NaN,Infinity,1.9])assert.doesNotThrow(()=>pickFade(spec(6),bad,NaN));
assert.equal(pickFade(spec(6),-5,1),pickFade(spec(6),0,1));assert.equal(pickFade(spec(6),1.9,1),pickFade(spec(6),1,1));

// boundaryLevel (C-33).
assert.deepEqual([0,1,2,3,4,5,8,12,15,16,17,32,48,64,100].map(b=>boundaryLevel(b)),[3,1,1,1,2,1,2,2,1,3,1,3,3,3,2]);
assert.equal(boundaryLevel(null),0);assert.equal(boundaryLevel(null,0),0);assert.equal(boundaryLevel(null,2),0);assert.equal(boundaryLevel(null,4),2);assert.equal(boundaryLevel(null,12),2);assert.equal(boundaryLevel(undefined,8),2);
assert.equal(boundaryLevel(7,12),1,'a clock position ignores the live phrase');
for(const bad of [NaN,Infinity,-4])assert.equal(boundaryLevel(bad),0);assert.equal(boundaryLevel(2.5),1);

// Windows on the clock: never overlap, always inside the scenes, deterministic.
{
  const patterns=[[8],[4,4,8,16],[1,2,1,3],[16,1,1,16],[2,2,2],[1]],pick=list=>list[Math.floor(rnd()*list.length)];
  let windows=0;
  for(let run=0;run<150;run++){
    const anchor=run%3,barsPattern=pick(patterns),perBar=pick([1,3,4,7]),timingId=pick([0,2,3,4,5,6,6]);
    const timing={...defaultSceneTiming,enabled:true,bpm:60+Math.floor(rnd()*140),offsetSeconds:Math.floor(rnd()*4),seed:Math.floor(rnd()*1e6),barsPattern,beatsPerBar:perBar,patternHold:rnd()<.3};
    const clock=compileSceneClock(timing),fade={timing:timingId,randomSet:1+Math.floor(rnd()*31),anchor,fixedMs:Math.floor(250+rnd()*7750)};
    const hooks=anchor===2?{pivotForBeats:(beats,ordinal)=>((ordinal*7+beats)%9)/10}:undefined;
    const order=[0,1,2,3,4],horizon=timing.offsetSeconds+240,step=Math.max(.02,60/timing.bpm/8);
    const seen=new Map();
    for(let t=timing.offsetSeconds;t<horizon;t+=step){
      const frame=clock.at(t,order,false,[],fade,hooks),w=frame.fade;
      if(!w)continue;
      assert.ok(w.progress>=0&&w.progress<=1&&w.seconds>0&&w.beats>=0&&w.beats<=64);
      assert.ok(t>=w.start-1e-9&&t<w.end+1e-9,'the frame is inside its own window');
      assert.ok(w.ordinal>=1,'scene 0 has no fade');
      assert.equal(w.from,order[(w.ordinal-1)%5]);assert.equal(w.to,order[w.ordinal%5]);
      const entry=seen.get(w.ordinal)??{first:t,last:t,window:w};entry.last=t;seen.set(w.ordinal,entry);
    }
    let previousEnd=-Infinity;
    for(const [ordinal,entry] of [...seen].sort((a,b)=>a[0]-b[0])){
      const w=entry.window;windows++;
      // A window cut short by its neighbour would mean two fades overlapped; the sampling step bounds how far short it may look.
      if(w.end<horizon-step)assert.ok(entry.last>=w.end-step*1.001-1e-9,`window ${ordinal} ran to its end (${entry.last} vs ${w.end}) ${JSON.stringify([anchor,barsPattern,perBar,timingId])}`);
      assert.ok(w.start>=previousEnd-1e-9,`window ${ordinal} does not overlap the previous one (${w.start} < ${previousEnd})`);
      previousEnd=w.end;
    }
  }
  assert.ok(windows>1000,`sampled ${windows} windows`);
  // The first scene has no fade, and Instant never produces a window.
  const clock=compileSceneClock({...defaultSceneTiming,enabled:true,bpm:120,barsPerScene:2});
  for(const anchor of [0,1,2]){
    assert.equal(clock.at(0,[0,1,2],false,[],{timing:0,randomSet:31,anchor,fixedMs:2000}).fade,null);
    for(let t=0;t<40;t+=.25)assert.equal(clock.at(t,[0,1,2],false,[],{timing:1,randomSet:31,anchor,fixedMs:2000}).fade,null);
    for(let t=0;t<40;t+=.25)assert.equal(clock.at(t,[0,1,2],false,[],undefined).fade,null,'no spec, no window');
  }
}

// mpc-setups semantics (C-03, C-04, C-13).
{
  const legacy={enabled:true,bars:8,shuffle:false,minimumRating:0,transition:1,beats:2,durationMs:2000,keepOld:true,manualFade:true,autoFade:true};
  for(const beats of [0,1,2,4]){
    const s={...legacy,beats};
    assert.deepEqual(S.canonicalSettings(s),s,'a legacy settings object is its own canonical form');
    assert.deepEqual(Object.keys(S.canonicalSettings(s)),Object.keys(s));
    assert.equal(S.effectiveFadeTiming(s),fadeFromBeats(beats));
    assert.deepEqual(S.parseSettings(S.canonicalSettings(s)),s,'and parses back unchanged');
  }
  assert.equal(S.effectiveFadeTiming({...legacy,fadeTiming:6}),6);assert.equal(S.effectiveFadeTiming({...legacy,fadeTiming:0}),0,'a present fadeTiming is authoritative even when beats disagree');
  // Each fade timing: beats is the projection, and fadeTiming is written only when the projection cannot express it.
  const expectedWrite={0:false,1:true,2:false,3:false,4:false,5:true,6:true};
  for(let timing=0;timing<7;timing++){
    const c=S.canonicalSettings({...legacy,beats:0,fadeTiming:timing});
    assert.equal(c.beats,beatsFromFade(timing));
    assert.equal('fadeTiming' in c,expectedWrite[timing],`fadeTiming ${timing}`);
    assert.equal(S.effectiveFadeTiming(c),timing,'the canonical form keeps the meaning');
    assert.deepEqual(S.canonicalSettings(c),c,'canonicalisation is idempotent');
    assert.deepEqual(S.parseSettings(c),c);
  }
  // Default-valued optional fields are dropped; non-default ones are kept, in parse order.
  assert.deepEqual(S.canonicalSettings({...legacy,fadeTiming:3,fadeRandomSet:31,fadeAnchor:0,queueQuantize:0}),{...legacy});
  const full=S.canonicalSettings({...legacy,beats:0,fadeTiming:6,fadeRandomSet:22,fadeAnchor:2,queueQuantize:3});
  assert.deepEqual(Object.keys(full),[...Object.keys(legacy),'fadeTiming','fadeRandomSet','fadeAnchor','queueQuantize']);
  assert.deepEqual(Object.keys(S.parseSettings(full)),Object.keys(full));
  // The configure payload always carries all four fields (C-13), defaults included, and never display preferences.
  for(const s of [legacy,{...legacy,beats:0},{...legacy,beats:4},full]){
    const c=S.configureSettings(s);
    assert.ok(['fadeTiming','fadeRandomSet','fadeAnchor','queueQuantize'].every(k=>Number.isInteger(c[k])));
    assert.equal(c.beats,beatsFromFade(c.fadeTiming));
    assert.ok(!('showFps' in c)&&!('timingOverlay' in c)&&!('quality' in c));
    assert.doesNotThrow(()=>S.parseSettings(c));
  }
  assert.deepEqual(S.configureSettings(legacy),{...legacy,fadeTiming:3,fadeRandomSet:31,fadeAnchor:0,queueQuantize:0});
  assert.deepEqual(S.fadeSpecOf(legacy),{timing:3,randomSet:31,anchor:0,fixedMs:2000});
  assert.deepEqual(S.fadeSpecOf(full),{timing:6,randomSet:22,anchor:2,fixedMs:2000});
  // The host's live state (a spec) folds back into stored settings.
  assert.deepEqual(S.settingsWithFade({...legacy,beats:0},{timing:4,randomSet:31,anchor:0,fixedMs:1000}),{...legacy,beats:4,durationMs:1000});
  assert.deepEqual(S.settingsWithFade(legacy,{timing:1,randomSet:31,anchor:0,fixedMs:2000}),{...legacy,beats:0,fadeTiming:1});
  assert.deepEqual(S.settingsWithFade(legacy,{timing:6,randomSet:9,anchor:1,fixedMs:2000},2),{...legacy,beats:0,fadeTiming:6,fadeRandomSet:9,fadeAnchor:1,queueQuantize:2});
  // parseSettings stays strict for a present invalid v2 value and unchanged for legacy input.
  for(const bad of [{fadeTiming:7},{fadeTiming:-1},{fadeTiming:1.5},{fadeRandomSet:0},{fadeRandomSet:32},{fadeAnchor:3},{queueQuantize:4},{fadeTiming:null},{fadeAnchor:'1'}])assert.throws(()=>S.parseSettings({...legacy,...bad}),/Invalid setup settings/,JSON.stringify(bad));
  assert.deepEqual(S.parseSettings({...legacy,fadeAnchor:2,queueQuantize:3}),{...legacy,fadeAnchor:2,queueQuantize:3});
  assert.deepEqual(S.parseSettings({...legacy,fadeTiming:undefined}),legacy);
}

// Source lint: pure module.
{
  const source=readFileSync('src/mpc-transition-timing.ts','utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*$/gm,'');
  for(const forbidden of [/Math\.random/,/Date\.now/,/performance\.now/,/\bnew Date\b/,/\bdocument\b/,/\bwindow\b/])assert.ok(!forbidden.test(source),`${forbidden} must not appear in mpc-transition-timing.ts`);
}
console.log('Transition timing CPU: legacy mapping, tolerant message parsing, exact lengths at 5 tempos x 5 meters, caps, no-tempo fallback, tempo-map beat landing, anchors and hit pivot, seeded Random bag over all 31 masks (permutations, seams, replay over 10,000 shuffled ordinals), boundary levels, non-overlapping windows on the clock, setup semantics (C-03/C-04/C-13), purity PASS');
