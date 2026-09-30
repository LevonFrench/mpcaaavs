import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
async function load(path){const result=await build({entryPoints:[path],bundle:true,format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);}
const T=await load('src/mpc-timing-tools.ts');
const {TapTempo,nudgeOffset,downbeatHere,restartHere,captureTempo,tidyTiming,rebaseTiming,replaceTiming,OFFSET_LIMIT,TAP_GAP_SECONDS,TAP_MAX,TAP_MIN}=T;
const {compileGrid}=await load('src/mpc-beat-grid.ts');
const {parseSceneTiming,defaultSceneTiming,compileSceneClock}=await load('src/mpc-scene-clock.ts');
let seedState=20260929;const rnd=()=>(seedState=(Math.imul(seedState,1664525)+1013904223)>>>0)/4294967296;
const pick=list=>list[Math.floor(rnd()*list.length)];
const near=(a,b,eps)=>Math.abs(a-b)<=eps;

assert.deepEqual([OFFSET_LIMIT,TAP_GAP_SECONDS,TAP_MAX,TAP_MIN],[3600,2,12,4]);

// ---- Tap tempo ----
{
  // 60, 92, 128 and 174 BPM with +-20 ms of jitter: within one percent once twelve taps are in.
  let worst=0;
  for(const bpm of [60,92,128,174])for(let trial=0;trial<40;trial++){
    const tap=new TapTempo(),start=rnd()*100;let estimate=null;
    for(let i=0;i<12;i++)estimate=tap.tap(start+i*60/bpm+(rnd()*2-1)*.02);
    assert.ok(estimate!==null&&Math.abs(estimate-bpm)/bpm<.01,`${bpm} BPM tapped as ${estimate}`);worst=Math.max(worst,Math.abs(estimate-bpm)/bpm);
    assert.equal(tap.count,12);
  }
  assert.ok(worst<.01,`worst relative error ${worst}`);
  // Without jitter four taps are already exact, and fewer than four give nothing.
  for(const bpm of [60,92,128,174,33.33,399.5]){
    const tap=new TapTempo(),estimates=[];for(let i=0;i<6;i++)estimates.push(tap.tap(7+i*60/bpm));
    assert.deepEqual(estimates.slice(0,3),[null,null,null],'under four taps there is no estimate');
    for(const e of estimates.slice(3))assert.equal(e,Math.round(bpm*100)/100,`${bpm} BPM`);
  }
  // The result is rounded to 0.01.
  {const tap=new TapTempo();let e;for(let i=0;i<5;i++)e=tap.tap(i*(60/127.337));assert.equal(e,127.34);}
  // A gap over two seconds starts a new set; exactly two seconds does not.
  {
    const tap=new TapTempo();for(const t of [0,.5,1,1.5])tap.tap(t);assert.equal(tap.count,4);
    assert.equal(tap.tap(3.5),120,'a gap of exactly two seconds continues the set (four beats missed)');assert.equal(tap.count,5);
    assert.equal(tap.tap(6.5001),null);assert.equal(tap.count,1,'a gap over two seconds starts over');
    for(const t of [7.0001,7.5001])tap.tap(t);assert.equal(tap.tap(8.0001),120);
  }
  // Time that does not advance (taps while paused, a seek back) starts over with that tap; non-finite input is ignored.
  {
    const tap=new TapTempo();for(const t of [10,10.5,11,11.5])tap.tap(t);assert.equal(tap.count,4);
    assert.equal(tap.tap(11.5),null);assert.equal(tap.count,1,'the same timestamp again starts over');
    for(const t of [12,12.5,13])tap.tap(t);assert.equal(tap.count,4);
    tap.tap(2);assert.equal(tap.count,1,'a seek backwards starts over');
    for(const bad of [NaN,Infinity,-Infinity,undefined,'x',null]){const before=tap.count;tap.tap(bad);assert.equal(tap.count,before,`${String(bad)} is ignored`);}
    tap.tap(2.5);tap.tap(3);const e=tap.tap(3.5);assert.equal(e,120);tap.tap(NaN);assert.equal(tap.tap(4),120);
  }
  // Outliers: a stray extra tap, a double tap, a stray first tap, and missed beats.
  {
    const run=times=>{const tap=new TapTempo();let e=null;for(const t of times)e=tap.tap(t);return e;};
    assert.equal(run([0,.5,1,1.2,1.5,2,2.5]),120,'an extra tap between beats is rejected');
    assert.equal(run([0,.5,1,1.001,1.5,2,2.5]),120,'a double tap is rejected');
    assert.equal(run([0.2,.5,1,1.5,2,2.5]),120,'a stray early first tap is skipped');
    assert.equal(run([0,.5,1,2,2.5,3]),120,'a missed beat counts as two beats');
    assert.equal(run([0,.5,1.5,2,2.5,3.5]),120,'two missed beats');
    // A tap late by more than a quarter of the beat is dropped, one within the tolerance is used.
    assert.equal(run([0,.5,1,1.5,2.2,2.5,3]),120);
    const slightly=run([0,.5,1,1.5+.1,2,2.5,3]);assert.ok(slightly!==null&&Math.abs(slightly-120)<2);
    // Too few good taps: four taps with one outlier are three usable ones.
    assert.equal(run([0,.5,.7,1]),null);
    // Everything fast: 600 BPM is out of range, so no estimate. Slow but legal: 31.58 BPM.
    assert.equal(run([0,.1,.2,.3,.4]),null);assert.equal(run([0,1.9,3.8,5.7]),31.58);
    assert.equal(run([0,.15,.3,.45]),400,'400 BPM is the upper limit');assert.equal(run([0,.1499,.2998,.4497]),null,'just above 400 BPM');
  }
  // Only the last twelve taps count: a tempo change is followed once twelve taps at the new tempo are in.
  {
    const tap=new TapTempo();let t=0,e;for(let i=0;i<20;i++){e=tap.tap(t);t+=60/100;}assert.equal(tap.count,12);assert.equal(e,100);
    for(let i=0;i<14;i++){t+=.0;e=tap.tap(t);t+=60/140;}
    assert.equal(tap.count,12);assert.ok(near(e,140,.01),`the estimate followed the new tempo (${e})`);
  }
  // reset forgets everything.
  {const tap=new TapTempo();for(let i=0;i<5;i++)tap.tap(i*.5);tap.reset();assert.equal(tap.count,0);assert.equal(tap.tap(9),null);assert.equal(tap.count,1);}
}

// ---- Nudge ----
{
  assert.equal(nudgeOffset(0.1,0.2),0.3,'no floating point residue');assert.equal(nudgeOffset(.42,.05),.47);assert.equal(nudgeOffset(1.5,-.01),1.49);
  let offset=0;for(let i=0;i<1000;i++)offset=nudgeOffset(offset,.01);assert.equal(offset,10,'a thousand 10 ms nudges add up exactly');
  for(let i=0;i<1000;i++)offset=nudgeOffset(offset,-.05);assert.equal(offset,-40);
  assert.equal(nudgeOffset(0,60/128),.46875);assert.equal(nudgeOffset(2,-60/133.33),1.549989);
  assert.equal(nudgeOffset(3599.99,.02),3600);assert.equal(nudgeOffset(-3599.99,-.02),-3600);assert.equal(nudgeOffset(0,1e9),3600);assert.equal(nudgeOffset(0,-1e9),-3600);
  assert.equal(nudgeOffset(4000,-.01),3600,'an out-of-range offset is pulled back');
  assert.equal(nudgeOffset(NaN,.25),.25,'a cleared offset field reads as 0');assert.equal(nudgeOffset(undefined,-.25),-.25);
  for(const bad of [NaN,Infinity,-Infinity,undefined,'1',null])assert.equal(nudgeOffset(1.5,bad),1.5,`delta ${String(bad)} changes nothing`);
  assert.ok(Object.is(nudgeOffset(1e-7,-1e-7),0),'no negative zero');assert.ok(Object.is(nudgeOffset(0,-1e-9),0));
  assert.equal(nudgeOffset(1.23456789,0),1.234568,'rounded to a microsecond');
}

// ---- Downbeat here, restart here ----
const base=(over={})=>({...defaultSceneTiming,enabled:true,bpm:120,offsetSeconds:1,...over});
{
  const t=base();
  assert.equal(downbeatHere(t,5.3),1.3,'a bar is 2 s at 120 BPM: the offset moves forward by the distance from the previous bar line');
  assert.equal(downbeatHere({...t,offsetSeconds:1.3},5.3),1.3,'idempotent');
  assert.equal(downbeatHere(t,5),1,'a position already on a bar line changes nothing');assert.equal(downbeatHere(t,1),1);assert.equal(downbeatHere(t,7),1);
  assert.equal(downbeatHere(t,6.9999999),1,'within the snap tolerance');assert.equal(downbeatHere(t,6.99),2.99);
  assert.equal(downbeatHere(base({offsetSeconds:10}),3.1),11.1,'before the offset the bar grid extends backwards');
  assert.equal(downbeatHere({...t,beatsPerBar:3},4),1,'3/4 at 120 BPM is a 1.5 s bar and 4 - 1 = 3 s is two bars');
  assert.equal(downbeatHere({...t,beatsPerBar:3},4.2),1.2);assert.equal(downbeatHere({...t,beatsPerBar:7},9),2,'7/4 at 120 BPM is a 3.5 s bar: 8 mod 3.5 = 1');
  for(const bad of [NaN,Infinity,undefined,'5'])assert.equal(downbeatHere(t,bad),1,`position ${String(bad)} changes nothing`);
  assert.equal(downbeatHere({...t,offsetSeconds:NaN},5.3),1.3,'a cleared offset reads as 0');assert.equal(downbeatHere({...t,offsetSeconds:NaN},6),0);
  assert.equal(downbeatHere({...t,tempoMap:[{at:-5,bpm:100}]},5.3),1,'an invalid tempo map changes nothing');
  assert.equal(restartHere(12.3456789),12.345679);assert.equal(restartHere(5000),3600);assert.equal(restartHere(-5000),-3600);assert.equal(restartHere(NaN),0);assert.equal(restartHere(Infinity),0);assert.ok(Object.is(restartHere(-1e-9),0));assert.equal(restartHere(0),0);
}
{
  // Alignment and idempotence over random timings, meters and tempo maps: with the tempo timeline kept, the position sits on a bar line.
  let checked=0,moved=0;
  for(let run=0;run<3000;run++){
    const bpb=pick([1,2,3,4,5,7,16]),bpm=pick([20,60,92,120,133.33,240,400,20+rnd()*380]),offset=Math.round((rnd()-.5)*400)/1000*pick([1,50]);
    const map=[],changes=rnd()<.5?0:1+Math.floor(rnd()*4);let at=offset;
    for(let i=0;i<changes;i++){at+=.05+rnd()*40;map.push({at:Math.round(at*1e6)/1e6,bpm:pick([20,80,140,300,20+rnd()*380])});}
    const timing=base({bpm,offsetSeconds:offset,beatsPerBar:bpb,...(map.length?{tempoMap:map}:{})});
    const position=map.length?offset+rnd()*(at-offset+60):offset+(rnd()-.3)*pick([2,20,200]);
    const d=downbeatHere(timing,position);
    if(position>=timing.offsetSeconds)assert.ok(d>=timing.offsetSeconds-1e-9,'the offset never moves backwards from before the position'),assert.ok(d<=position+1e-6);
    const adopted=rebaseTiming(timing,d),grid=compileGrid(adopted.bpm,adopted.offsetSeconds,adopted.tempoMap??[]);
    if(position>=d){
      const beats=grid.beatAt(position);
      assert.ok(near(beats,Math.round(beats/bpb)*bpb,3e-5*Math.max(1,bpm/60)),`position on a bar line: ${beats} of ${bpb} (${JSON.stringify(timing)} at ${position} -> ${d})`);checked++;
    }else if(!map.length){
      const beats=-(d-position)*bpm/60;assert.ok(near(beats,Math.round(beats/bpb)*bpb,3e-5*Math.max(1,bpm/60)));checked++;
    }
    if(d!==timing.offsetSeconds)moved++;
    // One bar at most: the first bar line after the offset.
    if(!map.length)assert.ok(Math.abs(d-timing.offsetSeconds)<bpb*60/bpm+1e-6);
    // Idempotent, exactly.
    assert.equal(downbeatHere(adopted,position),adopted.offsetSeconds,'a second Downbeat here changes nothing');
  }
  assert.ok(checked>2500&&moved>2500,`${checked} alignments, ${moved} moves`);
}
{
  // The clock agrees: after Downbeat here the bar counter reads a bar start at the position.
  const timing=base({bpm:100,offsetSeconds:.25,beatsPerBar:5,barsPattern:[2,3]}),position=47.3,d=downbeatHere(timing,position);
  const clock=compileSceneClock({...timing,offsetSeconds:d}),beats=clock.grid.beatAt(position);
  assert.ok(near(beats,Math.round(beats/5)*5,1e-4),`the clock's bar counter reads a bar line at the position (${beats})`);
  assert.equal(clock.at(position,[0,1,2],false,[]).beatsPerBar,5);
}

// ---- Use detected tempo ----
{
  const tempo=(over={})=>({locked:true,bpm:128.004,phase:.25,...over});
  assert.equal(captureTempo(tempo({locked:false}),95.3),null);
  for(const bad of [{bpm:NaN},{bpm:19.99},{bpm:400.01},{bpm:Infinity},{phase:NaN},{phase:-.01},{phase:1.01}])assert.equal(captureTempo(tempo(bad),95.3),null,JSON.stringify(bad));
  assert.equal(captureTempo(tempo(),NaN),null);assert.equal(captureTempo(null,5),null);assert.equal(captureTempo({bpm:120,phase:0},5),null,'locked must be exactly true');
  assert.equal(captureTempo(tempo({bpm:127.996}),95.3).bpm,128);assert.equal(captureTempo(tempo({bpm:127.994}),95.3).bpm,127.99);assert.equal(captureTempo(tempo({bpm:399.996}),9).bpm,400);assert.equal(captureTempo(tempo({bpm:19.996}),9).bpm,20);
  // The saved grid passes through the most recent detected beat, and the offset is the beat nearest to the song start by default.
  for(const [bpm,phase,position] of [[128.004,.25,95.3],[92,0,10],[174.2,.999,300.123],[60,.5,.4],[400,.3,1234.5],[20,.9,3000]]){
    const c=captureTempo({locked:true,bpm,phase},position),period=60/c.bpm,last=position-phase*60/bpm,grid=compileGrid(c.bpm,c.offsetSeconds);
    assert.ok(Math.abs(c.offsetSeconds)<=period/2+2e-6,`offset ${c.offsetSeconds} is within half a beat of the start (${bpm} ${phase})`);
    const beats=(last-c.offsetSeconds)/period;assert.ok(near(beats,Math.round(beats),3e-6*Math.max(1,c.bpm/60)),`the last detected beat is a beat of the saved grid (${beats})`);
    const near50=captureTempo({locked:true,bpm,phase},position,4,50);assert.ok(Math.abs(near50.offsetSeconds-50)<=period/2+2e-6,'currentOffset picks the nearest beat');
    assert.equal(captureTempo({locked:true,bpm,phase},position,7).offsetSeconds,c.offsetSeconds,'beatsPerBar has no effect today');
  }
  assert.equal(captureTempo(tempo(),95.3,4,5000).offsetSeconds,3600,'clamped to the offset limit');assert.equal(captureTempo(tempo(),95.3,4,-5000).offsetSeconds,-3600);
  assert.ok(captureTempo(tempo(),95.3,4,1e9).offsetSeconds<=3600);assert.ok(captureTempo(tempo(),95.3,4,-1e9).offsetSeconds>=-3600);
  assert.equal(captureTempo(tempo(),95.3,4,NaN).offsetSeconds,captureTempo(tempo(),95.3).offsetSeconds);
  // Exact case: 120 BPM, a beat at 10.0 s, currentOffset 0.
  assert.deepEqual(captureTempo({locked:true,bpm:120,phase:.5},10.25),{bpm:120,offsetSeconds:0},'beats at 10.0 and every half second: 0 is one');
  assert.deepEqual(captureTempo({locked:true,bpm:120,phase:.3},10.15),{bpm:120,offsetSeconds:0},'0.15 s after the beat at 10.0 (phase .3 of .5 s)');
  assert.deepEqual(captureTempo({locked:true,bpm:120,phase:.1},10.15),{bpm:120,offsetSeconds:.1},'the last beat at 10.1 puts a beat of the half-second grid at 0.1, nearer to 0 than -0.4');
}

// ---- Rebasing and tidying ----
{
  // The tempo timeline is preserved: beat counts between any two later times are unchanged, and the input is untouched.
  for(let run=0;run<600;run++){
    const offset=Math.round((rnd()-.5)*200)/100,changes=[];let at=offset;
    for(let i=0;i<1+Math.floor(rnd()*5);i++){at+=Math.round((.05+rnd()*30)*1000)/1000;changes.push({at,bpm:pick([20,64,90,133.5,240,400])});}
    const timing=base({bpm:pick([20,100,180]),offsetSeconds:offset,tempoMap:changes,beatsPerBar:pick([3,4,4,5])});
    const snapshot=JSON.stringify(timing),target=Math.round((offset+rnd()*(at-offset+10))*1000)/1000;
    const moved=rebaseTiming(timing,target);
    assert.equal(JSON.stringify(timing),snapshot,'the input is not mutated');assert.equal(moved.offsetSeconds,target);
    assert.ok((moved.tempoMap??[]).every(c=>c.at>target),'no change precedes the new offset');
    assert.doesNotThrow(()=>parseSceneTiming(moved));
    const before=compileGrid(timing.bpm,offset,changes),after=compileGrid(moved.bpm,moved.offsetSeconds,moved.tempoMap??[]);
    const t1=target+rnd()*20,t2=t1+rnd()*(at+30);
    assert.ok(near(before.beatAt(t2)-before.beatAt(t1),after.beatAt(t2)-after.beatAt(t1),1e-7),'beat counts between later times are unchanged');
    assert.ok(near(before.beatAt(t2)-before.beatAt(target),after.beatAt(t2),1e-7),'beat zero moved to the new offset');
    assert.deepEqual(rebaseTiming(moved,target),moved,'idempotent');
    if(target<offset+1e-12&&target>=offset)assert.equal(moved.bpm,timing.bpm);
  }
  // A folded tempo map that empties drops its keys: a v1 timing comes back with exactly its five keys.
  {
    const timing=base({offsetSeconds:0,tempoMap:[{at:10,bpm:90}]}),moved=rebaseTiming(timing,25);
    assert.deepEqual(moved,{enabled:true,bpm:90,offsetSeconds:25,barsPerScene:8,seed:1});assert.equal(JSON.stringify(Object.keys(moved)),JSON.stringify(Object.keys(defaultSceneTiming)));
    const keep=rebaseTiming({...timing,barsPattern:[2,4]},25);assert.equal(keep.version,2);assert.deepEqual(keep.barsPattern,[2,4]);assert.equal('tempoMap' in keep,false);
    assert.equal(rebaseTiming(timing,-4000).offsetSeconds,-3600);assert.equal(rebaseTiming(timing,NaN).offsetSeconds,0);assert.equal(rebaseTiming(base(),12).offsetSeconds,12);
  }
  // tidyTiming: default-valued v2 fields go, version follows.
  {
    const v1=base();assert.equal(JSON.stringify(tidyTiming({...v1})),JSON.stringify(v1));
    const messy=tidyTiming({...v1,version:2,beatsPerBar:4,patternHold:false,tempoMap:[],script:[],intervals:[],barsPattern:[8]});
    assert.deepEqual(Object.keys(messy),Object.keys(v1),'defaults and an empty pattern equal to barsPerScene vanish');
    assert.deepEqual(tidyTiming({...v1,barsPattern:[8],patternHold:true}),v1,'a one-entry pattern equal to barsPerScene is the default, hold or not');
    assert.deepEqual(tidyTiming({...v1,patternHold:true}),v1,'hold means nothing without a pattern');
    assert.deepEqual(tidyTiming({...v1,version:7}),v1,'a stale version goes');
    const kept=tidyTiming({...v1,beatsPerBar:3,barsPattern:[4,4],patternHold:true});assert.deepEqual(kept,{...v1,version:2,beatsPerBar:3,barsPattern:[4,4],patternHold:true});
    assert.equal(tidyTiming({...v1,barsPattern:[4]}).version,2,'a one-entry pattern that differs from barsPerScene is kept');
    const only=tidyTiming({...v1,tempoMap:[{at:5,bpm:100}]});assert.equal(only.version,2);
    assert.deepEqual(tidyTiming(tidyTiming({...kept,tempoMap:[]})),kept,'idempotent');
    // The tidied form is what the parser writes.
    for(const t of [v1,{...v1,beatsPerBar:5},{...v1,barsPattern:[2,4],patternHold:true,tempoMap:[{at:12,bpm:99}]},{...v1,intervals:[{id:'a',startBeat:0,endBeat:4}]}]){
      const tidy=tidyTiming({...t}),parsed=parseSceneTiming(tidy);assert.equal(JSON.stringify(parsed),JSON.stringify(tidy),'tidy output equals the parsed form');
    }
  }
  // replaceTiming edits the draft in place.
  {const draft=base({beatsPerBar:5}),ref=draft;replaceTiming(draft,{enabled:false,bpm:99,offsetSeconds:3,barsPerScene:2,seed:5});assert.equal(draft,ref);assert.deepEqual(draft,{enabled:false,bpm:99,offsetSeconds:3,barsPerScene:2,seed:5});assert.equal('beatsPerBar' in draft,false);}
}

// ---- Purity: no clocks, randomness or DOM in the module ----
{
  const source=readFileSync('src/mpc-timing-tools.ts','utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*$/gm,'');
  for(const forbidden of [/Math\.random/,/Date\.now/,/performance\.now/,/\bnew Date\b/,/\bdocument\b/,/\bwindow\b/,/\bsetTimeout\b/,/localStorage/])assert.ok(!forbidden.test(source),`${forbidden} must not appear in mpc-timing-tools.ts`);
}
console.log('Timing tools CPU: tap tempo at four tempi with jitter, outliers, missed beats, gaps, resets and limits; nudge exactness and clamps; Downbeat here alignment and idempotence over 3,000 random timings with meters and tempo maps; restart; detected-tempo capture; tempo-preserving rebase; tidy timing; purity PASS');
