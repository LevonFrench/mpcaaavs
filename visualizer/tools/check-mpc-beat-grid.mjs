import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
async function load(path){const result=await build({entryPoints:[path],bundle:true,format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);}
const {BEAT_EPS,compileGrid,compilePattern,compileClockGrid,timingSignals,intervalSignals,MAX_TEMPO_CHANGES}=await load('src/mpc-beat-grid.ts');
let seedState=20260928;const rnd=()=>(seedState=(Math.imul(seedState,1664525)+1013904223)>>>0)/4294967296;
const fractOf=x=>x-Math.floor(x);

// 1. Round trip and strict monotonicity, with negative, zero and positive offsets and up to 256 tempo changes.
const manyChanges=(offset,count)=>Array.from({length:count},(_,i)=>({at:offset+(i+1)*7.3+rnd()*.1,bpm:20+Math.floor(rnd()*380)}));
for(const offset of [0,1.25,-17.5,3600,-3600])for(const changes of [[],[{at:offset+30,bpm:90},{at:offset+95.5,bpm:133.33},{at:offset+400,bpm:20}],manyChanges(offset,MAX_TEMPO_CHANGES)]){
  const g=compileGrid(120,offset,changes);let previous=-Infinity;
  assert.equal(g.constant,changes.length===0);
  for(let i=0;i<100000;i++){
    const beat=i*.013+1e-3,t=g.timeAt(beat);
    assert.ok(Math.abs(g.beatAt(t)-beat)<=1e-9*Math.max(1,beat),`round trip ${offset} ${changes.length} ${beat}`);
    assert.ok(t>previous,'timeAt strictly increasing');previous=t;
  }
  assert.equal(g.beatAt(offset),0);assert.equal(g.beatAt(offset-100),0);assert.equal(g.timeAt(0),offset);assert.equal(g.timeAt(-5),offset);
  assert.equal(g.bpmAt(offset-1),120,'before the offset the base tempo applies');
}

// 2. Every integer beat boundary is recovered exactly, and a moment 10 microseconds early never rounds up.
for(const [bpm,changes] of [[20,[]],[92,[]],[133.33,[]],[400,[]],[120,[{at:30.475,bpm:133.33},{at:72.075,bpm:87.5}]],[400,[{at:12,bpm:20},{at:800,bpm:400}]]]){
  const g=compileGrid(bpm,.375,changes);
  for(let n=0;n<200000;n++)if(Math.floor(g.beatAt(g.timeAt(n))+BEAT_EPS)!==n)assert.fail(`boundary ${n} lost at ${bpm} BPM with ${changes.length} changes`);
  for(let n=1;n<20000;n++)assert.equal(Math.floor(g.beatAt(g.timeAt(n)-1e-5)+BEAT_EPS),n-1,`early ${n}`);
}

// 3. Continuity at segment joins: the value from either side is bitwise the same, and the tempo applies from its own time.
{
  const changes=[{at:10,bpm:60},{at:22.5,bpm:240},{at:23,bpm:20}],g=compileGrid(100,2,changes);
  for(const c of changes){
    const before=g.beatAt(c.at-1e-9),at=g.beatAt(c.at),after=g.beatAt(c.at+1e-9);
    assert.ok(before<=at&&at<after,`monotone across ${c.at}`);assert.ok(at-before<1e-6);
    assert.equal(g.bpmAt(c.at),c.bpm,'a change applies from its own time');assert.notEqual(g.bpmAt(c.at-1e-9),c.bpm);
    assert.equal(g.timeAt(at),c.at,'a join maps back to exactly its time');
  }
  assert.equal(g.beatAt(10),8*100/60,'beats before the first change are exact');
}

// 4. Validation.
for(const [bpm,offset,changes] of [[19.99,0,[]],[400.01,0,[]],[NaN,0,[]],[120,NaN,[]],[120,Infinity,[]],[120,0,[{at:0,bpm:100}]],[120,5,[{at:5,bpm:100}]],[120,0,[{at:5,bpm:100},{at:5,bpm:90}]],[120,0,[{at:6,bpm:100},{at:5,bpm:90}]],[120,0,[{at:5,bpm:19}]],[120,0,[{at:NaN,bpm:100}]],[120,0,[null]],[120,0,Array.from({length:MAX_TEMPO_CHANGES+1},(_,i)=>({at:i+1,bpm:100}))],[120,0,'x']]){
  assert.throws(()=>compileGrid(bpm,offset,changes),/Invalid beat grid/,JSON.stringify([bpm,offset]));
}
assert.doesNotThrow(()=>compileGrid(400,-3600,Array.from({length:MAX_TEMPO_CHANGES},(_,i)=>({at:-3599+i,bpm:400}))));
for(const [bars,per,hold] of [[[],4,false],[[0],4,false],[[1.5],4,false],[[4],0,false],[[4],17,false],[[4],4.5,false],[[4,-1],4,true],[[NaN],4,false],['x',4,false]])assert.throws(()=>compilePattern(bars,per,hold),/Invalid scene pattern/);

// 5. Pattern lookup equals brute force for cyclic, hold and degenerate patterns.
for(const [bars,per,hold] of [[[4,4,8,16],4,false],[[4,4,8,16],3,true],[[1],4,false],[[1],4,true],[[128,1,7],7,false],[[2,3],5,true],[[128],16,false],[[3,1,2,5,8],1,true]]){
  const p=compilePattern(bars,per,hold),starts=[];let acc=0;
  for(let n=0;n<3000;n++){starts.push(acc);acc+=p.beats(n);}
  const cyc=bars.reduce((a,b)=>a+b,0)*per;
  for(let n=0;n<3000;n++){
    assert.equal(p.startBeat(n),starts[n],`${bars} ${hold} startBeat ${n}`);
    assert.equal(p.beats(n),hold&&n>=bars.length?bars.at(-1)*per:bars[n%bars.length]*per);
    for(const offset of [0,.5*p.beats(n),p.beats(n)-1e-7,1e-10]){
      const x=starts[n]+offset,r=p.at(x);
      assert.equal(r.ordinal,n,`${bars} ${per} ${hold} at ${n} +${offset}`);assert.equal(r.startBeat,starts[n]);assert.equal(r.beats,p.beats(n));
    }
    // A hair before a boundary, inside the tolerance, already belongs to the next scene; further away it does not.
    if(n>0){assert.equal(p.at(starts[n]-BEAT_EPS/2).ordinal,n);assert.equal(p.at(starts[n]-1e-6).ordinal,n-1);}
  }
  assert.equal(p.at(-5).ordinal,0);assert.equal(p.at(NaN).ordinal,0);assert.equal(p.startBeat(-3),0);assert.equal(p.beats(-3),p.beats(0));
  assert.ok(cyc>0);
}
{const p=compilePattern([4,4,8,16],4,false);assert.equal(p.at(Infinity).ordinal,Infinity,'an unbounded position is not a safe ordinal');}
assert.equal(compilePattern([2],4,false).at(1e15).ordinal,Math.floor((1e15+BEAT_EPS)/8));

// 6. Search cost: at most about log2(n) probes per lookup, even at the 256-change limit.
{
  let probes=0;const count=()=>{probes++;},changes=Array.from({length:MAX_TEMPO_CHANGES},(_,i)=>({at:10+i*5,bpm:100+i%50})),g=compileGrid(90,0,changes,count);
  let worst=0;
  for(let i=0;i<5000;i++){probes=0;g.beatAt(rnd()*1400);worst=Math.max(worst,probes);probes=0;g.timeAt(rnd()*4000);worst=Math.max(worst,probes);probes=0;g.bpmAt(rnd()*1400);worst=Math.max(worst,probes);}
  assert.ok(worst<=Math.ceil(Math.log2(MAX_TEMPO_CHANGES+1))+1,`probes ${worst}`);
  const pattern=compilePattern(Array.from({length:64},(_,i)=>i%7+1),4,true,count);let bad=0;
  for(let i=0;i<5000;i++){probes=0;pattern.at(rnd()*20000);bad=Math.max(bad,probes);}
  assert.ok(bad<=8,`pattern probes ${bad}`);
}

// 7. timingSignals without a grid reproduces the legacy derivation exactly.
for(let i=0;i<20000;i++){
  const time=rnd()*5000,bpm=20+rnd()*380,localTime=rnd()*200,s=timingSignals(time,null,null,null,{bpm,localTime}),beats=localTime*bpm/60;
  assert.equal(s.sceneBeat,beats);assert.equal(s.beatPhase,fractOf(beats));assert.equal(s.bar,Math.floor(time*bpm/240));
  assert.equal(s.beatsPerBar,4);assert.equal(s.barPhase,fractOf(beats/4));assert.equal(s.beat,time*bpm/60);assert.equal(s.interval,null);
  assert.ok(s.beatInBar>=0&&s.beatInBar<4&&Number.isInteger(s.beatInBar));
}
for(const bad of [NaN,Infinity,-Infinity])assert.doesNotThrow(()=>{const s=timingSignals(bad,null,null,null,{bpm:bad,localTime:bad});for(const v of [s.beat,s.sceneBeat,s.bar,s.beatPhase,s.barPhase])assert.ok(Number.isFinite(v));});

// 8. With a grid: an offset-aware bar, beatsPerBar pips, a scene-relative beat and exact interval endpoints.
{
  const grid={offset:2.5,bpm:120,beatsPerBar:3};
  const at=t=>timingSignals(t,grid,null,null,{bpm:120,localTime:0});
  assert.equal(at(0).bar,0);assert.equal(at(2.5).bar,0);assert.equal(at(2.5).beatInBar,0);
  assert.equal(at(2.5+1.5-1e-12).bar,1,'bar 1 starts three beats (1.5 s) after the offset, within the tolerance');
  assert.equal(at(2.5+1.5-1e-3).bar,0);
  assert.equal(at(2.5+1.5).beatInBar,0);assert.equal(at(2.5+2).beatInBar,1);assert.equal(at(2.5+2.5).beatInBar,2);assert.equal(at(2.5+3).beatInBar,0);
  assert.equal(at(2.5+.75).beatPhase,.5);assert.ok(Math.abs(at(2.5+1.75).barPhase-(0+.5)/3)<1e-12);assert.ok(Math.abs(at(2.5+2.25).barPhase-(1+.5)/3)<1e-12);assert.equal(at(1).beat,0);assert.equal(at(1).bar,0);
  for(const t of [0,2.5,3,5,100.3])assert.equal(at(t).beatsPerBar,3);
  const start=timingSignals(10,grid,10,20,{bpm:120,localTime:0});assert.equal(start.sceneBeat,0);
  const later=timingSignals(11.5,grid,10,20,{bpm:120,localTime:1.5});assert.ok(Math.abs(later.sceneBeat-3)<1e-9);
  const before=timingSignals(9,grid,10,20,{bpm:120,localTime:0});assert.equal(before.sceneBeat,0,'a scene rendered at its frozen start never goes negative');
  // The wire grid is validated: a malformed one falls back to the legacy derivation instead of throwing.
  for(const bad of [{offset:NaN,bpm:120,beatsPerBar:4},{offset:0,bpm:120,beatsPerBar:0},{offset:0,bpm:120,beatsPerBar:17},{offset:0,bpm:120,beatsPerBar:2.5},{offset:0,bpm:5,beatsPerBar:4},{offset:0,bpm:120,beatsPerBar:4,changes:[[-1,100]]},{offset:0,bpm:120,beatsPerBar:4,changes:[[5,100],[5,90]]},{offset:0,bpm:120,beatsPerBar:4,changes:[5]},{offset:0,bpm:120,beatsPerBar:4,changes:Array.from({length:257},(_,i)=>[i+1,100])}]){
    assert.equal(compileClockGrid(bad),null);
    const legacy=timingSignals(37.3,null,null,null,{bpm:100,localTime:12.1});
    assert.deepEqual(timingSignals(37.3,bad,null,null,{bpm:100,localTime:12.1}),legacy,JSON.stringify(bad));
  }
  assert.equal(compileClockGrid(null),null);
}
// Tempo changes travel with the grid: the bar count follows the map.
{
  const grid={offset:0,bpm:120,beatsPerBar:4,changes:[[8,60]]};   // 16 beats in 8 s, then one beat per second
  assert.ok(Math.abs(timingSignals(8,grid,null,null,{bpm:120,localTime:0}).beat-16)<1e-9);
  assert.ok(Math.abs(timingSignals(12,grid,null,null,{bpm:120,localTime:0}).beat-20)<1e-9);
  assert.equal(timingSignals(12,grid,null,null,{bpm:120,localTime:0}).bar,5);
}
// The compile cache is invisible: equal grids give equal results, and mutating a caller's object afterwards changes nothing already cached.
{
  const grid={offset:1,bpm:100,beatsPerBar:4,changes:[[5,140]]},first=timingSignals(9,grid,null,null,{bpm:100,localTime:0});
  const copy=JSON.parse(JSON.stringify(grid));
  assert.deepEqual(timingSignals(9,copy,null,null,{bpm:100,localTime:0}),first);
  grid.bpm=200;grid.changes[0][1]=30;
  assert.deepEqual(timingSignals(9,copy,null,null,{bpm:100,localTime:0}),first,'a mutated original does not leak into a later equal grid');
  assert.notDeepEqual(timingSignals(9,grid,null,null,{bpm:100,localTime:0}),first,'a changed grid recompiles');
  const flip=[0,1,2,3,4].map(i=>timingSignals(9+i,i%2?grid:copy,null,null,{bpm:100,localTime:0}).beat);
  assert.deepEqual(flip,[0,1,2,3,4].map(i=>timingSignals(9+i,i%2?grid:copy,null,null,{bpm:100,localTime:0}).beat),'alternating grids are pure');
}

// 9. Interval signals: exact endpoints, a countdown that reaches zero at the end, chained scenes without a gap.
{
  assert.equal(intervalSignals(5,10,20).progress,0);assert.equal(intervalSignals(10,10,20).progress,0);
  const end=intervalSignals(20,10,20);assert.equal(end.progress,1);assert.equal(end.remaining,0);assert.equal(end.elapsed,10);
  const past=intervalSignals(25,10,20);assert.equal(past.progress,1);assert.equal(past.remaining,0,'a held outgoing plate keeps its end value');
  const mid=intervalSignals(15,10,20);assert.equal(mid.progress,.5);assert.equal(mid.remaining,5);assert.equal(mid.elapsed,5);
  for(const [a,b] of [[null,5],[5,null],[5,5],[6,5],[NaN,5],[1,Infinity],[undefined,undefined]])assert.equal(intervalSignals(3,a,b),null);
  assert.equal(intervalSignals(NaN,1,2),null);
  const grid={offset:0,bpm:97.5,beatsPerBar:4};let previousEnd=null;
  for(let n=0;n<40;n++){
    const startTime=n*240*3/97.5,endTime=(n+1)*240*3/97.5;
    if(previousEnd!==null)assert.equal(previousEnd,startTime,'chained intervals share their boundary bitwise');previousEnd=endTime;
    const atEnd=timingSignals(endTime,grid,startTime,endTime,{bpm:97.5,localTime:0}).interval;assert.equal(atEnd.remaining,0);assert.equal(atEnd.progress,1);
    assert.equal(Math.ceil(timingSignals(startTime,grid,startTime,endTime,{bpm:97.5,localTime:0}).interval.remaining-1e-9),Math.ceil((endTime-startTime)-1e-9));
  }
  // Present with or without a grid, absent without a proper span.
  assert.equal(timingSignals(15,null,10,20,{bpm:120,localTime:5}).interval.progress,.5);
  assert.equal(timingSignals(15,{offset:0,bpm:120,beatsPerBar:4},10,null,{bpm:120,localTime:5}).interval,null);
}

// 10. The module is a pure function of its arguments.
{
  const source=readFileSync('src/mpc-beat-grid.ts','utf8');
  for(const forbidden of ['Math.random','Date.now','performance.now'])assert.ok(!source.includes(forbidden),`${forbidden} must not appear in mpc-beat-grid.ts`);
}
console.log('Beat grid CPU: round trips with 256 tempo changes, 2e5 exact integer boundaries, join continuity, validation, pattern lookup vs brute force, bounded search, legacy-exact and grid-aware timing signals, exact interval endpoints, purity PASS');
