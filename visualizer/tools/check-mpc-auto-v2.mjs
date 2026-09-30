import {build} from 'esbuild';
import assert from 'node:assert/strict';
// Timing System v2 live director: configurable beats per bar, anticipatory switches (leadBars) and rearm(origin).
// Defaults must reproduce the shipped scheduler exactly; tools/check-mpc-auto.mjs (owned by TRX) is the other half of that gate.
async function load(path){const result=await build({entryPoints:[path],bundle:true,format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);}
const {MpcAutoDirector}=await load('src/mpc-auto-director.ts');
let seedState=20260929;const rnd=()=>(seedState=(Math.imul(seedState,1664525)+1013904223)>>>0)/4294967296;

// ---- Verbatim copy of the scheduling core before Timing System v2 (grid, rearm, configure, remainingBars). ----
class Shipped {
  enabled=true;bars=0;energy=0;target=Infinity;previousBar=-1;armedAt=NaN;preparationStarted=false;
  rearm(){this.target=Infinity;this.previousBar=-1;this.armedAt=NaN;this.preparationStarted=false;}
  configure(enabled,bars){if(enabled!==this.enabled||bars!==this.bars)this.rearm();this.enabled=enabled;this.bars=[2,4,8,12].includes(bars)?bars:0;}
  grid(bar,trusted){
    if(!this.enabled||!trusted){this.rearm();return {prepare:false,switch:false};}
    if(!Number.isFinite(this.target))this.armedAt=bar;
    if(!this.preparationStarted){
      const phrase=this.bars||Math.round(12-10*Math.max(0,Math.min(1,this.energy)));
      this.target=Math.min(Math.floor(this.armedAt+12),Math.ceil(this.armedAt+phrase));
      if(bar>=this.target-1)this.preparationStarted=true;
    }
    const boundary=Math.floor(bar)!==this.previousBar;
    this.previousBar=Math.floor(bar);
    return {prepare:bar>=this.target-1,switch:boundary&&bar>=this.target};
  }
  get remainingBars(){return Number.isFinite(this.target)?Math.max(0,this.target-this.previousBar):null;}
}

// 1. Differential: with default arguments the director schedules exactly as before, over random call sequences.
{
  let compared=0;
  for(let run=0;run<400;run++){
    const a=new MpcAutoDirector(),b=new Shipped();
    let bar=rnd()*10;
    for(let step=0;step<400;step++){
      const roll=rnd();
      if(roll<.02){const enabled=rnd()<.85,bars=[0,2,4,8,12,3][Math.floor(rnd()*6)];a.configure(enabled,bars);b.configure(enabled,bars);}
      else if(roll<.04){a.rearm();b.rearm();}
      else if(roll<.06){const e=rnd();a.energy=e;b.energy=e;}
      else if(roll<.08)bar=rnd()*200;
      const trusted=rnd()<.93;bar+=rnd()<.9?rnd()*.35:rnd()*2.5;
      const x=a.grid(bar,trusted),y=b.grid(bar,trusted);
      assert.deepEqual(x,y,`run ${run} step ${step} bar ${bar}`);assert.equal(a.remainingBars,b.remainingBars);compared++;
      assert.equal(a.grid(bar,trusted,0).switch,false,'the same bar cannot switch twice');b.grid(bar,trusted);
    }
  }
  assert.ok(compared>=160000);
  const untouched=new MpcAutoDirector();assert.equal(untouched.beatsPerBar,4);assert.equal(untouched.targetBar,null);assert.equal(untouched.remainingBars,null);
}

// 2. Beats per bar: validated, default 4, re-arms the phrase, and scales the bar grid the tempo feeds.
{
  const d=new MpcAutoDirector();
  for(const bad of [0,17,3.5,NaN,Infinity,-4,undefined,null,'5']){d.beatsPerBar=bad;assert.equal(d.beatsPerBar,4,`invalid ${String(bad)} reads as 4`);}
  for(const good of [1,3,4,5,7,16]){d.beatsPerBar=good;assert.equal(d.beatsPerBar,good);}
  d.configure(true,4);d.beatsPerBar=4;d.grid(0,true);assert.equal(d.remainingBars,4);
  d.beatsPerBar=4;assert.equal(d.remainingBars,4,'an unchanged meter does not re-arm');
  d.beatsPerBar=3;assert.equal(d.remainingBars,null,'a new meter re-arms the phrase');
}
{
  // The same 120 BPM pulse: a shorter bar makes a phrase of N bars shorter in time, so more switches fit in the same music.
  const pulse=meter=>{
    const d=new MpcAutoDirector();d.configure(true,2);d.beatsPerBar=meter;
    let switches=0;
    for(let i=0;i<2400;i++){
      const t=i/30,p=new Float32Array(1152);
      if(t%.5<.07)for(let k=0;k<p.length;k++)p[k]=.8*Math.sin(k*.13);
      if(d.update(t,true,p).switch){switches++;d.rearm();}
    }
    assert.ok(d.tempo.locked&&Math.abs(d.tempo.bpm-120)<3,'the synthetic pulse locks');
    return switches;
  };
  const s2=pulse(2),s4=pulse(4),s8=pulse(8);
  assert.ok(s2>s4&&s4>s8,`switch counts fall as bars lengthen: ${s2} ${s4} ${s8}`);
  assert.ok(Math.abs(s2/s4-2)<.45&&Math.abs(s4/s8-2)<.45,`bar length halves the count: ${s2} ${s4} ${s8}`);
}

// 3. Anticipatory switch: prepare from target - 1 - lead, switch from target - lead, level triggered until the host re-arms.
for(const bars of [2,4,8,12])for(const lead of [.25,.5,1,1.5,2,4]){
  const d=new MpcAutoDirector();d.configure(true,bars);
  const armed=.3,target=Math.min(Math.floor(armed+12),Math.ceil(armed+bars)),effective=Math.min(lead,target-armed-1);
  const first=d.grid(armed,true,lead);
  assert.equal(d.targetBar,target);assert.equal(first.switch,false);
  let prepareAt=null,switchAt=null;
  for(let bar=armed;bar<target+2;bar=Math.round((bar+.01)*1e6)/1e6){
    const r=d.grid(bar,true,lead);
    if(r.prepare&&prepareAt===null)prepareAt=bar;
    if(r.switch&&switchAt===null){switchAt=bar;break;}
  }
  assert.ok(prepareAt!==null&&switchAt!==null);
  assert.ok(Math.abs(switchAt-(target-effective))<=.0100001,`bars ${bars} lead ${lead}: switch at ${switchAt}, expected ${target-effective}`);
  assert.ok(prepareAt<=switchAt&&prepareAt>=target-1-effective-.0100001,`prepare no earlier than target - 1 - lead (${prepareAt})`);
  // Level triggered: every later call before the re-arm keeps asking to switch, on the same bar or the next.
  assert.equal(d.grid(switchAt,true,lead).switch,true);assert.equal(d.grid(switchAt+.3,true,lead).switch,true);
  d.rearm(d.targetBar);assert.equal(d.targetBar,null);
  assert.equal(d.grid(switchAt+.02,true,lead).switch,false);
  assert.equal(d.targetBar,Math.min(Math.floor(target+12),Math.ceil(target+bars)),`the next phrase is measured from the true boundary (${bars} bars, lead ${lead})`);
}

// 4. No drift: 100 consecutive phrases land on exact multiples with rearm(origin), and drift by the lead without it (lead of one bar or more).
for(const [bars,lead] of [[2,.5],[4,1],[4,2],[8,2],[8,3.5],[12,4]]){
  const run=useOrigin=>{
    const d=new MpcAutoDirector();d.configure(true,bars);
    const switches=[];let bar=.3;
    while(switches.length<100&&bar<5000){
      bar=Math.round((bar+.05)*1e6)/1e6;
      if(d.grid(bar,true,lead).switch){switches.push(bar);d.rearm(useOrigin?d.targetBar:undefined);}
    }
    return switches;
  };
  const first=Math.min(Math.floor(.3+12),Math.ceil(.3+bars)),exact=run(true),effective=Math.min(lead,first-.3-1);
  assert.equal(exact.length,100);
  exact.forEach((at,k)=>assert.ok(Math.abs(at-(first+bars*k-effective))<=.050001,`phrase ${k}: ${at}`));
  for(let k=1;k<exact.length;k++)assert.ok(Math.abs(exact[k]-exact[k-1]-bars)<=.05001,`spacing ${bars} bars (${k})`);
  const loose=run(false);
  // Re-armed at the early switch, the next phrase is measured from bar (boundary - lead) instead of the boundary, and the phrase target rounds
  // that bar up: the next phrase shortens by ceil(lead) - 1 bars. A lead of one bar or less is absorbed by the rounding; more visibly drifts.
  const average=(loose[99]-loose[0])/99,drift=Math.ceil(effective)-1;
  assert.ok(average<=bars+1e-6);
  if(drift>=1)assert.ok(average<bars-.9,`the drift is visible (${average})`);
  // (A 12-bar phrase is also capped at floor(armed + 12), so the exact figure is asserted for the shorter phrases only.)
  if(drift>=1&&bars<12)assert.ok(Math.abs(average-(bars-drift))<.1,`without the origin every phrase shortens by ${drift} bars (${average})`);
}

// 5. The pin is discarded when it is not near the bar it meets, and by an untrusted or disabled grid.
{
  const d=new MpcAutoDirector();d.configure(true,4);
  d.rearm(1000);d.grid(20.5,true);assert.equal(d.targetBar,25,'a far pin is ignored: armed at the current bar');
  d.rearm(30);d.grid(20.5,true);assert.equal(d.targetBar,34,'a pin within twelve bars is used');
  d.rearm(30);d.grid(20.5,false);d.grid(20.5,true);assert.equal(d.targetBar,25,'an untrusted grid drops the pin');
  d.rearm(NaN);d.grid(20.5,true);assert.equal(d.targetBar,25);
  d.rearm(Infinity);d.grid(20.5,true);assert.equal(d.targetBar,25);
  d.rearm(-Infinity);d.grid(20.5,true);assert.equal(d.targetBar,25);
  const off=new MpcAutoDirector();off.configure(false,4);off.rearm(5);assert.deepEqual(off.grid(6,true,2),{prepare:false,switch:false});
  // A seek resets the detector and the pin.
  const s=new MpcAutoDirector();s.configure(true,4);s.rearm(30);s.reset();s.grid(20.5,true);assert.equal(s.targetBar,25,'reset drops the pin');
  const t=new MpcAutoDirector();t.configure(true,4);t.rearm(30);t.configure(true,8);t.grid(20.5,true);assert.equal(t.targetBar,29,'a phrase-length change re-arms without a pin');
}

// 6. Invalid leads read as zero; a lead never reaches back past one bar after the phrase was armed.
{
  for(const lead of [NaN,-1,0,-Infinity,Infinity,undefined,null,'2']){
    const a=new MpcAutoDirector(),b=new Shipped();a.configure(true,4);b.configure(true,4);
    for(let bar=.3;bar<12;bar+=.07)assert.deepEqual(a.grid(bar,true,lead),b.grid(bar,true),`lead ${String(lead)}`);
  }
  const d=new MpcAutoDirector();d.configure(true,2);
  const armed=d.grid(.3,true,9);assert.equal(armed.switch,false);
  assert.equal(d.targetBar,3);
  let at=null;for(let bar=.3;bar<3.5;bar+=.05){if(d.grid(bar,true,9).switch){at=bar;break;}}
  assert.ok(at!==null&&at>=1.3-1e-9&&at<1.36,`a 2-bar phrase with a 9-bar lead switches one bar after arming (${at}), not on every bar`);
  d.rearm(d.targetBar);
  for(let bar=at;bar<2.2;bar+=.05)assert.equal(d.grid(bar,true,9).switch,false,'the next phrase does not switch immediately');
  // Adaptive phrases: a busy song (2 bars) and a calm one (12 bars) both keep the lead inside the phrase.
  for(const energy of [0,.5,1]){
    const a=new MpcAutoDirector();a.energy=energy;a.grid(0,true,3);const target=a.targetBar,phrase=Math.round(12-10*energy);assert.equal(target,phrase);
    let s=null;for(let bar=0;bar<target+1;bar+=.05){if(a.grid(bar,true,3).switch){s=bar;break;}}
    assert.ok(s!==null&&Math.abs(s-(target-Math.min(3,target-1)))<=.0500001,`energy ${energy}: switch ${s}`);
  }
}

// 7. update() forwards the lead: with the pulse locked, a lead switches earlier than none, in the same phrase.
{
  const run=lead=>{
    const d=new MpcAutoDirector();d.configure(true,4);
    let first=null;
    for(let i=0;i<1500;i++){
      const t=i/30,p=new Float32Array(1152);
      if(t%.5<.07)for(let k=0;k<p.length;k++)p[k]=.8*Math.sin(k*.13);
      const r=d.update(t,true,p,undefined,false,lead);
      if(r.switch&&first===null)first=t;
    }
    return first;
  };
  const none=run(0),ahead=run(1);
  assert.ok(none!==null&&ahead!==null&&ahead<none-1.5&&ahead>none-2.5,`one bar of lead at 120 BPM is about two seconds earlier (${ahead} vs ${none})`);
}

// 8. Purity: the scheduler has no clock or randomness of its own.
{
  const {readFile}=await import('node:fs/promises');
  const source=await readFile('src/mpc-auto-director.ts','utf8');
  for(const forbidden of ['Math.random','Date.now','performance.now'])assert.equal(source.includes(forbidden),false,`no ${forbidden}`);
}
console.log('Auto director v2 CPU: 160,000 default-argument comparisons with the shipped scheduler, beats-per-bar validation and grid scaling, anticipatory prepare/switch positions for 24 phrase/lead pairs, 100-phrase no-drift with rearm(origin), pin discard rules, lead clamp, update() lead pass-through, purity PASS');
