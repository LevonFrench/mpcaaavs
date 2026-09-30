import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
async function load(path){const result=await build({entryPoints:[path],bundle:true,format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);}
const {FpsMeter}=await load('src/fps-meter.ts');
const {FpsLabel}=await load('src/timing-label.ts');
let seedState=91;const rnd=()=>(seedState=(Math.imul(seedState,1664525)+1013904223)>>>0)/4294967296;

// Steady rates are read within one percent.
for(const hz of [24,30,60,120,144,240]){
  const m=new FpsMeter();let t=100;
  for(let i=0;i<hz*3;i++){m.mark(t);t+=1000/hz;}
  const r=m.read(t-1000/hz);
  assert.ok(Math.abs(r.fps-hz)<hz*.01,`${hz} Hz read ${r.fps}`);
  assert.ok(Math.abs(r.worstMs-1000/hz)<1e-6);assert.ok(r.samples>=3);
}
// Jittered arrival: the window smooths it. Bursts followed by idle.
{
  const m=new FpsMeter();let t=0;
  for(let i=0;i<300;i++){t+=1000/60+(rnd()-.5)*8;m.mark(t);}
  const r=m.read(t);assert.ok(Math.abs(r.fps-60)<3,`jitter ${r.fps}`);assert.ok(r.worstMs>16.6&&r.worstMs<25);
  const burst=new FpsMeter();for(let i=0;i<40;i++)burst.mark(1000+i*2);
  assert.ok(burst.read(1080).fps>400,'a burst is a high instantaneous rate, not an average with the idle time');
  assert.equal(burst.read(1080+800),null,'idle after a burst: stale');
}
// Too few samples, stale readings.
{
  const m=new FpsMeter();assert.equal(m.read(0),null);m.mark(10);assert.equal(m.read(10),null);m.mark(26);assert.equal(m.read(26),null,'two samples');m.mark(43);assert.ok(m.read(43));
  assert.ok(m.read(43+750));assert.equal(m.read(43+751),null,'stale after 750 ms');
}
// A gap over 500 ms resets and needs three fresh samples; equal or earlier timestamps reset too.
{
  const m=new FpsMeter();let t=0;for(let i=0;i<100;i++){m.mark(t);t+=1000/60;}
  assert.ok(m.read(t));
  m.mark(t+5000);assert.equal(m.read(t+5000),null);
  for(let i=1;i<=5;i++)m.mark(t+5000+i*1000/60);
  const r=m.read(t+5000+5*1000/60);assert.ok(r.fps>59&&r.fps<61);assert.equal(r.samples,6,'the pre-gap history is gone');
  const at=t+5000+5*1000/60;
  m.mark(at);assert.equal(m.read(at),null,'the same timestamp restarts the window');
  m.mark(at+16);m.mark(at+32);m.mark(at+48);m.mark(at+10);assert.equal(m.read(at+10),null,'time going backwards restarts the window');
  const g=new FpsMeter({gapMs:100});g.mark(0);g.mark(50);g.mark(100);g.mark(150);assert.ok(g.read(150));g.mark(260);assert.equal(g.read(260),null,'custom gap');
}
// Non-finite input never disturbs the window.
{
  const m=new FpsMeter();let t=0;for(let i=0;i<30;i++){m.mark(t);t+=1000/60;}
  const before=m.read(t);
  for(const bad of [NaN,Infinity,-Infinity,undefined,'x'])m.mark(bad);
  assert.deepEqual(m.read(t),before);assert.equal(m.read(NaN),null);assert.equal(m.read(Infinity),null);
}
// The ring wraps: only the last `capacity` events count, and the span is still right.
{
  const m=new FpsMeter({capacity:16,windowMs:100000});let t=0;
  for(let i=0;i<1000;i++){m.mark(t);t+=10;}
  const r=m.read(t-10);assert.equal(r.samples,16);assert.ok(Math.abs(r.fps-100)<1e-9);
  const small=new FpsMeter({capacity:1});for(let i=0;i<10;i++)small.mark(i*10);assert.ok(small.read(90).samples<=4,'the capacity floor is four');
  const big=new FpsMeter();let u=0;for(let i=0;i<5000;i++){big.mark(u);u+=1000/1000;}   // 1000 Hz overflows the 512 ring, and still reads about 1000
  assert.ok(Math.abs(big.read(u).fps-1000)<1);
}
// Window options and option sanitising.
{
  const m=new FpsMeter({windowMs:200});let t=0;for(let i=0;i<50;i++){m.mark(t);t+=10;}
  assert.equal(m.read(t-10).samples,21);
  for(const bad of [{windowMs:-1},{windowMs:NaN},{gapMs:0},{staleMs:'x'},{capacity:0}])assert.doesNotThrow(()=>{const x=new FpsMeter(bad);for(let i=0;i<30;i++)x.mark(i*16);assert.ok(x.read(29*16));});
}
// Reset and independence of channels.
{
  const a=new FpsMeter(),b=new FpsMeter();let t=0;
  for(let i=0;i<60;i++){a.mark(t);if(i%2===0)b.mark(t);t+=1000/60;}
  const ra=a.read(t),rb=b.read(t);assert.ok(Math.abs(ra.fps-60)<1);assert.ok(Math.abs(rb.fps-30)<1);
  a.reset();assert.equal(a.read(t),null);assert.ok(b.read(t));
}
// Hidden tab: no marks arrive, so the reading goes stale and never turns into an average.
{
  const m=new FpsMeter();let t=0;for(let i=0;i<120;i++){m.mark(t);t+=1000/60;}
  assert.equal(m.read(t+10000),null);m.mark(t+10000);assert.equal(m.read(t+10000),null);
}

// FpsLabel: formatting, refresh limiter and hysteresis.
{
  const at=(fps,extra={})=>({present:{fps,worstMs:20,samples:60},...extra});
  const label=new FpsLabel();
  assert.equal(label.segment(0,at(60),1,true),'60 fps');
  assert.equal(label.segment(0,at(60),0,true),null,'off');
  assert.equal(label.segment(0,{present:null},1,true),null,'no reading');
  assert.equal(label.segment(0,at(60),1,false),null,'not playing');
  const f=new FpsLabel();
  assert.equal(f.segment(0,at(59.6),1,true),'60 fps');
  assert.equal(f.segment(100,at(30),1,true),'60 fps','the text is held for the refresh interval');
  assert.equal(f.segment(499,at(30),1,true),'60 fps');
  assert.equal(f.segment(500,at(30),1,true),'30 fps');
  assert.equal(f.segment(400,at(45),1,true),'45 fps','a clock that ran backwards refreshes at once');
  // Hysteresis: a wobble of one count around a rounding boundary does not change the text.
  const h=new FpsLabel(1);let t=0;
  assert.equal(h.segment(t+=10,at(60.2),1,true),'60 fps');
  assert.equal(h.segment(t+=10,at(59.6),1,true),'60 fps','59.6 stays at 60');
  assert.equal(h.segment(t+=10,at(60.4),1,true),'60 fps');
  assert.equal(h.segment(t+=10,at(58.9),1,true),'59 fps','a real change is shown');
  assert.equal(h.segment(t+=10,at(59.3),1,true),'59 fps');
  // One decimal below ten, integer at ten or more, 999+ above.
  const d=new FpsLabel(1);let u=0;
  assert.equal(d.segment(u+=10,at(9.44),1,true),'9.4 fps');
  assert.equal(d.segment(u+=10,at(9.96),1,true),'10 fps');
  assert.equal(d.segment(u+=10,at(10),1,true),'10 fps');
  assert.equal(d.segment(u+=10,at(1),1,true),'1.0 fps');
  assert.equal(d.segment(u+=10,at(998.4),1,true),'998 fps');
  assert.equal(d.segment(u+=10,at(999.6),1,true),'999+ fps');
  assert.equal(d.segment(u+=10,at(5000),1,true),'999+ fps');
  // Detail mode shows the other channels; the display rate only when it differs from the presented rate.
  const dd=new FpsLabel(1);let v=0;
  const full=at(60,{display:{fps:60,worstMs:17,samples:60},render:{fps:58.2,worstMs:30,samples:58},clock:{fps:30.1,worstMs:40,samples:30}});
  assert.equal(dd.segment(v+=10,full,2,true),'60 fps (render 58 · clock 30 Hz)');
  assert.equal(dd.segment(v+=10,at(60,{display:{fps:144,worstMs:7,samples:144},render:{fps:8.44,worstMs:9,samples:9}}),2,true),'60 fps (display 144 · render 8.4)');
  assert.equal(dd.segment(v+=10,at(60,{clock:{fps:30,worstMs:40,samples:30}}),2,true),'60 fps (clock 30 Hz)');
  assert.equal(dd.segment(v+=10,at(60),2,true),'60 fps','detail with only the present channel');
  assert.equal(dd.segment(v+=10,full,1,true),'60 fps','plain mode never shows detail');
  // Turning the label off or pausing resets it, so the first reading after resuming is shown at once.
  const r=new FpsLabel(1000);r.segment(0,at(60),1,true);r.segment(10,at(60),1,false);assert.equal(r.segment(20,at(30),1,true),'30 fps');
}
{
  const source=readFileSync('src/fps-meter.ts','utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*$/gm,'');
  for(const forbidden of [/Math\.random/,/Date\.now/,/performance\.now/,/\bdocument\b/,/\bwindow\b/,/\bnew Date\b/])assert.ok(!forbidden.test(source),`${forbidden} must not appear in fps-meter.ts`);
}
console.log('FPS meter CPU: six steady rates, jitter, bursts, stall/backwards/equal-time resets, non-finite input, ring wrap, options, independent channels, label formatting, refresh limiter, hysteresis and detail text PASS');
