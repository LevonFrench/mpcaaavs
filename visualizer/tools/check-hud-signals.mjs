import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
// Signals v2 bus (docs/design/HUD-PACK-ENGINE.md 3.2-3.4 and Appendix B, docs/design/CONTRACT.md 2.3.8). CPU only, synthetic audio only:
// the click track is a REGRESSION bound for the detector wiring, not proof of accuracy on real music. Nothing here plays audio or
// touches a GPU. Replay determinism, seek reset, ABI layout, pan sign, mono fallback, rate limits, garbage input and the bit-exact
// `legacy` values against nerv-scenes `band()` are asserted.
async function load(path){const r=await build({entryPoints:[path],bundle:true,format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);}
const M=await load('src/hud/hud-signals.ts');
const {nervBand}=await load('src/nerv-scenes.ts');
const {HudSignalBus,HUD_BANDS,HUD_GROUPS,HUD_SIGNAL_OFFSETS:O,HUD_SIGNAL_FLOATS,packHudSignals,unpackHudSignals,emptyHudSignals,hudLegacyBands,DEFAULT_HUD_SIGNAL_OPTIONS}=M;
const SR=44100,HOP=576,HOP_SEC=HOP/SR;
const f32=Math.fround;

// ---- helpers ----
function rng(seed){let s=seed>>>0;return()=>(s=(Math.imul(s,1664525)+1013904223)>>>0)/4294967296;}
const emptyAvs=()=>({waveform:[new Uint8Array(576),new Uint8Array(576)],spectrum:[new Uint8Array(576),new Uint8Array(576)],beat:false,beatLevel:0});
const AVS=emptyAvs();
/** Stereo signal generator: fn(i, out) writes out[0]=L, out[1]=R for sample i. */
function makeSignal(seconds,fn){const n=Math.floor(seconds*SR/HOP)*HOP,L=new Float32Array(n),R=new Float32Array(n),o=[0,0];for(let i=0;i<n;i++){fn(i,o);L[i]=o[0];R[i]=o[1];}return {L,R,hops:n/HOP};}
const sine=(hz,amp)=>i=>amp*Math.sin(2*Math.PI*hz*i/SR);
/** Feed a signal hop by hop; `each(snapshot, unpacked|null, hopIndex)` is called after every hop with a fresh snapshot. */
function run(bus,sig,{from=0,to=sig.hops,t0=0,each,avs=AVS}={}){
 const pcm=new Float32Array(2*HOP);let last=null;
 for(let h=from;h<to;h++){pcm.set(sig.L.subarray(h*HOP,h*HOP+HOP),0);pcm.set(sig.R.subarray(h*HOP,h*HOP+HOP),HOP);const t=t0+h*HOP_SEC;bus.push(pcm,t);last=bus.snapshot(t,avs);if(each)each(last,h,t);}
 return last;
}
const U=a=>unpackHudSignals(a);
const isF32=a=>a instanceof Float32Array&&a.length===64;

// ---- 1. exports and the Appendix B layout ----
for(const name of ['HudSignalBus','HUD_BANDS','HUD_GROUPS','HUD_SIGNAL_OFFSETS','HUD_SIGNAL_FLOATS','packHudSignals','unpackHudSignals','emptyHudSignals','hudLegacyBands','DEFAULT_HUD_SIGNAL_OPTIONS','HUD_BAND_EDGES_HZ','HUD_SIGNALS_VERSION','HUD_COUNT_WRAP','HUD_AGE_MAX'])assert.ok(name in M,`export ${name}`);
assert.deepEqual([...HUD_BANDS],['sub','low','mid','high','air']);
assert.deepEqual([...HUD_GROUPS],['kick','snare','hat','tonal','any']);
assert.deepEqual([...M.HUD_BAND_EDGES_HZ],[0,80,250,2000,8000,20000]);
assert.equal(HUD_SIGNAL_FLOATS,64);
assert.equal(M.HUD_SIGNALS_VERSION,2);
// Appendix B, literally.
assert.deepEqual({...O},{version:0,t:1,dt:2,live:3,rms:4,pan:5,width:6,flux:7,centroid:8,contour:9,beatLatched:13,beatLevel:14,band:15,bandL:20,bandR:25,panBand:30,onsetEnv:35,onsetFired:40,onsetCount:45,onsetAge:50,onsetStrength:55,legacy:60});
{ // every float slot is claimed exactly once
 const used=new Array(64).fill(0);
 for(const i of [O.version,O.t,O.dt,O.live,O.rms,O.pan,O.width,O.flux,O.centroid,O.beatLatched,O.beatLevel])used[i]++;
 for(const [base,n] of [[O.contour,4],[O.band,5],[O.bandL,5],[O.bandR,5],[O.panBand,5],[O.onsetEnv,5],[O.onsetFired,5],[O.onsetCount,5],[O.onsetAge,5],[O.onsetStrength,5],[O.legacy,4]])for(let k=0;k<n;k++)used[base+k]++;
 assert.deepEqual(used,new Array(64).fill(1),'the 64 slots are each used exactly once');
}
assert.deepEqual(DEFAULT_HUD_SIGNAL_OPTIONS.rate,{kick:5,snare:5,hat:8,tonal:6,any:8});
assert.equal(DEFAULT_HUD_SIGNAL_OPTIONS.norm.releaseSec,8);assert.equal(DEFAULT_HUD_SIGNAL_OPTIONS.norm.floorSec,4);assert.equal(DEFAULT_HUD_SIGNAL_OPTIONS.norm.minSpan,0.05);assert.equal(DEFAULT_HUD_SIGNAL_OPTIONS.rampSec,0.25);
assert.deepEqual(DEFAULT_HUD_SIGNAL_OPTIONS.contour,{fastSec:1,slowSec:8});
assert.ok(Object.isFrozen(DEFAULT_HUD_SIGNAL_OPTIONS)&&Object.isFrozen(DEFAULT_HUD_SIGNAL_OPTIONS.rate),'defaults are frozen');

// ---- 2. ABI pack / unpack round trip ----
{
 const r=rng(7);
 const bands=()=>({sub:f32(r()),low:f32(r()),mid:f32(r()),high:f32(r()),air:f32(r())});
 for(let trial=0;trial<200;trial++){
  const onset={};for(const g of HUD_GROUPS)onset[g]={env:f32(r()),fired:r()<.5,count:Math.floor(r()*(1<<24)),ageSec:f32(r()*60),strength:f32(r())};
  const s={version:2,t:f32(r()*5000),dt:f32(.001+r()*.249),live:r()<.5,rms:f32(r()),band:bands(),bandL:bands(),bandR:bands(),pan:f32(r()*2-1),panBand:bands(),width:f32(r()),flux:f32(r()),centroid:f32(r()),
   contour:{fast:f32(r()),slow:f32(r()),slope:f32(r()*2-1),tension:f32(r())},onset,beat:{latched:r()<.5,level:Math.floor(r()*73728)},legacy:{low:f32(r()),mid:f32(r()),high:f32(r()),level:f32(r())}};
  const packed=packHudSignals(s);
  assert.ok(isF32(packed));
  assert.deepEqual(U(packed),s,'unpack(pack(x)) equals x for float32-exact input');
  assert.deepEqual([...packHudSignals(U(packed))],[...packed],'pack(unpack(x)) is bit-identical');
 }
 const out=new Float32Array(64).fill(9);
 assert.equal(packHudSignals(emptyHudSignals(1.5),out),out,'pack fills the given buffer');
 assert.equal(out.filter(x=>x===9).length,0,'pack overwrites every slot');
 const e=emptyHudSignals(3,0.02);
 assert.equal(e.version,2);assert.equal(e.live,false);assert.equal(e.dt,.02);assert.equal(U(packHudSignals(e)).dt,f32(.02));assert.equal(e.onset.any.ageSec,60);
 assert.equal(emptyHudSignals(NaN,Infinity).t,0);assert.equal(emptyHudSignals(0,99).dt,.25);assert.equal(emptyHudSignals(0,0).dt,.001);
 assert.equal(U(packHudSignals(e)).onset.kick.ageSec,60);
 // rejects
 assert.equal(U(null),null);assert.equal(U(undefined),null);assert.equal(U(new Float32Array(63)),null);
 const bad=packHudSignals(e);bad[0]=1;assert.equal(U(bad),null,'other version');bad[0]=3;assert.equal(U(bad),null);
 // counts wrap at 2^24 and stay exact; age clamps at 60; non-finite become 0
 const w=emptyHudSignals();const w2={...w,onset:{...w.onset,any:{env:0,fired:false,count:(1<<24)+5,ageSec:99,strength:NaN}}};
 const wu=U(packHudSignals(w2));assert.equal(wu.onset.any.count,5);assert.equal(wu.onset.any.ageSec,60);assert.equal(wu.onset.any.strength,0);
 const bigCount=U(packHudSignals({...w,onset:{...w.onset,kick:{...w.onset.kick,count:(1<<24)-1}}}));assert.equal(bigCount.onset.kick.count,(1<<24)-1);
 assert.ok(Object.isFrozen(M.HUD_SIGNAL_OFFSETS));
}

// ---- 3. click-track regression bounds (the design's probe: 120 BPM, kick 60 Hz LEFT, noise hat RIGHT, 220 Hz pad) ----
const DUR=24;
const truth=[];
const click=(()=>{const N=SR*DUR,L=new Float32Array(N),R=new Float32Array(N),r=rng(12345),rnd=()=>r()-.5;
 for(let beat=0;beat<DUR*2;beat++){const t0=beat*.5,i0=Math.floor(t0*SR);truth.push({t:t0,kind:'kick'});
  for(let i=0;i<SR*.12&&i0+i<N;i++)L[i0+i]+=.7*Math.sin(2*Math.PI*(60+90*Math.exp(-i/1500))*i/SR)*Math.exp(-i/(SR*.05));
  const h0=Math.floor((t0+.25)*SR);truth.push({t:t0+.25,kind:'hat'});let prev=0;
  for(let i=0;i<SR*.04&&h0+i<N;i++){const n=rnd();const hp=n-prev;prev=n;R[h0+i]+=.5*hp*Math.exp(-i/(SR*.012));}}
 for(let i=0;i<N;i++){const pad=.02*Math.sin(2*Math.PI*220*i/SR);L[i]+=pad;R[i]+=pad;}
 return {L,R,hops:Math.floor(N/HOP)};})();
let clickSnaps;
{
 const bus=new HudSignalBus();const events=[];const groupEvents={kick:[],snare:[],hat:[],tonal:[]};const prev={};for(const g of HUD_GROUPS)prev[g]=0;
 const firedAt=[];let firedMismatch=0,livePanOnKick=[];
 clickSnaps=[];
 run(bus,click,{each:(snap,h,t)=>{const s=U(snap);clickSnaps.push(s);
  for(const g of HUD_GROUPS){const c=s.onset[g].count;if(c!==prev[g]){for(let k=0;k<c-prev[g];k++){if(g==='any')events.push(t);else groupEvents[g].push(t);}
    if(s.onset[g].fired!==true)firedMismatch++;prev[g]=c;}
   else if(s.onset[g].fired)firedMismatch++;}
  if(s.live&&s.onset.kick.fired)livePanOnKick.push(s.pan);}});
 const used=new Set(),latencies=[];let hit=0;
 for(const tr of truth){const i=events.findIndex((t,k)=>!used.has(k)&&t-tr.t>=-.015&&t-tr.t<=.09);if(i>=0){used.add(i);hit++;latencies.push(events[i]-tr.t);}}
 const recall=hit/truth.length,falsePositives=events.length-used.size;
 assert.ok(recall>=.95,`click-track recall ${recall}`);
 assert.ok(falsePositives<=3,`click-track false positives ${falsePositives}`);
 assert.ok(latencies.every(l=>Math.abs(l)<=1.5*HOP_SEC),`latency within 1.5 hops: ${latencies.map(l=>(l*1000).toFixed(1))}`);
 assert.equal(firedMismatch,0,'`fired` is true exactly on the snapshot where a count advanced');
 const kicks=groupEvents.kick.length;assert.ok(kicks>=40&&kicks<=56,`kick-group events ${kicks} (48 kicks in the material)`);
 // the kick is hard left: the pan at kick onsets is on the left
 const meanKickPan=livePanOnKick.reduce((a,b)=>a+b,0)/livePanOnKick.length;assert.ok(meanKickPan<-.2,`pan at kick onsets ${meanKickPan}`);
 // every snapshot is finite and in range
 const sn=clickSnaps[clickSnaps.length-1];assert.equal(sn.live,true);
}

// ---- 4. finite values and ranges over the whole click track ----
for(const s of clickSnaps){
 const flat=[s.t,s.dt,s.rms,s.pan,s.width,s.flux,s.centroid,s.contour.fast,s.contour.slow,s.contour.slope,s.contour.tension,s.beat.level,s.legacy.low,s.legacy.mid,s.legacy.high,s.legacy.level];
 for(const b of HUD_BANDS)flat.push(s.band[b],s.bandL[b],s.bandR[b],s.panBand[b]);
 for(const g of HUD_GROUPS){const o=s.onset[g];flat.push(o.env,o.count,o.ageSec,o.strength);assert.ok(Number.isInteger(o.count)&&o.count>=0);assert.ok(o.ageSec>=0&&o.ageSec<=60);assert.ok(o.env>=0&&o.env<=1&&o.strength>=0&&o.strength<=1);}
 assert.ok(flat.every(Number.isFinite),'no NaN or Infinity');
 for(const v of [s.rms,s.width,s.flux,s.centroid,s.contour.fast,s.contour.slow,s.contour.tension,...HUD_BANDS.flatMap(b=>[s.band[b],s.bandL[b],s.bandR[b]])])assert.ok(v>=0&&v<=1,`0..1 range: ${v}`);
 for(const v of [s.pan,s.contour.slope,...HUD_BANDS.map(b=>s.panBand[b])])assert.ok(v>=-1&&v<=1,`-1..1 range: ${v}`);
 assert.equal(s.dt,f32(s.dt));assert.ok(s.dt>=.001&&s.dt<=.25+1e-6);
}

// ---- 5. live flag, ramp, silence ----
{
 const bus=new HudSignalBus();
 let s=U(bus.snapshot(0,AVS));
 assert.equal(s.version,2);assert.equal(s.live,false,'a fresh bus is not live');assert.equal(s.rms,0);assert.equal(s.t,0);assert.equal(s.dt,f32(1/60),'first dt is the nominal frame');
 assert.equal(U(bus.snapshot(12.5,AVS)).t,12.5,'without data t follows the request');
 const tone=makeSignal(4,(i,o)=>{o[0]=o[1]=sine(1000,.3)(i);});
 const lives=[];run(bus,tone,{each:(snap)=>lives.push(snap[O.live])});
 const firstLive=lives.indexOf(1);
 assert.ok((firstLive+1)*HOP_SEC>=.25-1e-9&&firstLive*HOP_SEC<.25,`live after the ramp, first live hop ${firstLive}`);
 assert.ok(lives.slice(firstLive).every(x=>x===1),'stays live');
 s=U(bus.snapshot(tone.hops*HOP_SEC-HOP_SEC,AVS));assert.ok(s.rms>0&&s.band.mid>0);
 // zero output while not live, including inside the ramp
 const ramp=new HudSignalBus();const early=[];run(ramp,tone,{to:10,each:snap=>early.push(snap)});
 for(const a of early){if(a[O.live]===0){for(const i of [O.rms,O.pan,O.width,O.flux,O.centroid,...[9,10,11,12],...Array.from({length:20},(_,k)=>15+k),...Array.from({length:5},(_,k)=>35+k),...Array.from({length:5},(_,k)=>40+k),...Array.from({length:5},(_,k)=>55+k)])assert.equal(a[i],0,`slot ${i} is zero while not live`);}}
 // silence -> live false and zeros; sound returns -> live true
 const silence=makeSignal(1,()=>{});
 const sbus=new HudSignalBus();run(sbus,tone);
 const t1=tone.hops*HOP_SEC;
 const seenLive=[];run(sbus,silence,{t0:t1,each:(snap)=>seenLive.push(snap[O.live])});
 assert.equal(seenLive[0],1,'a single silent hop does not drop live');assert.equal(seenLive[seenLive.length-1],0,'sustained silence is not live');
 s=U(sbus.snapshot(t1+silence.hops*HOP_SEC-HOP_SEC,AVS));assert.equal(s.live,false);assert.equal(s.rms,0);assert.equal(s.flux,0);for(const b of HUD_BANDS){assert.equal(s.band[b],0);assert.equal(s.panBand[b],0);}
 assert.equal(s.pan,0);assert.equal(s.width,0);assert.equal(s.centroid,0);
 const t2=t1+silence.hops*HOP_SEC;const back=[];run(sbus,tone,{t0:t2,to:20,each:snap=>back.push(snap[O.live])});
 assert.equal(back[back.length-1],1,'live again after sound resumes');
 // stale: a snapshot far past the newest hop is not live
 assert.equal(U(sbus.snapshot(t2+20*HOP_SEC+1,AVS)).live,false,'stale data is not live');
 assert.equal(U(sbus.snapshot(t2+20*HOP_SEC-HOP_SEC+.3,AVS)).live,true);
 // t is the newest pushed hop
 const tb=new HudSignalBus();run(tb,tone,{to:30,t0:100});assert.equal(U(tb.snapshot(100.4,AVS)).t,f32(100+29*HOP_SEC));
}

// ---- 6. pan sign (+1 = right), per-band pan, width, mono fallback ----
{
 const steady=(fn,secs=2)=>{const b=new HudSignalBus();return U(run(b,makeSignal(secs,fn)));};
 const right=steady((i,o)=>{o[0]=0;o[1]=sine(1000,.4)(i);});
 assert.ok(right.pan>.95,`right-only pan ${right.pan}`);assert.ok(right.panBand.mid>.95);assert.ok(right.bandR.mid>right.bandL.mid);assert.equal(right.bandL.mid,0);
 const left=steady((i,o)=>{o[0]=sine(1000,.4)(i);o[1]=0;});
 assert.ok(left.pan<-.95,`left-only pan ${left.pan}`);assert.ok(left.panBand.mid<-.95);assert.ok(left.bandL.mid>left.bandR.mid);
 const third=steady((i,o)=>{o[0]=sine(1000,.2)(i);o[1]=sine(1000,.4)(i);});
 assert.ok(Math.abs(third.pan-1/3)<.03,`R=2L pan ${third.pan}`);
 // per-band pan: 60 Hz hard left, 5 kHz hard right
 const split=steady((i,o)=>{o[0]=sine(60,.3)(i);o[1]=sine(5000,.3)(i);});
 assert.ok(split.panBand.sub<-.95&&split.panBand.high>.95,`per-band pan ${JSON.stringify(split.panBand)}`);
 assert.ok(Math.abs(split.pan)<=1);
 // mono: identical channels, with noise so every band is populated
 const r=rng(99);const mono=makeSignal(3,(i,o)=>{o[0]=o[1]=.3*(r()-.5)+sine(200,.1)(i);});
 const mb=new HudSignalBus();let worst=0,worstBand=0;const ms=U(run(mb,mono,{each:(snap)=>{const s=U(snap);worst=Math.max(worst,Math.abs(s.pan),Math.abs(s.width));for(const b of HUD_BANDS){worst=Math.max(worst,Math.abs(s.panBand[b]));worstBand=Math.max(worstBand,Math.abs(s.bandL[b]-s.bandR[b]));}}}));
 assert.equal(ms.live,true);assert.equal(worst,0,`mono pan, width and per-band pan are exactly 0 (worst ${worst})`);assert.ok(worstBand<1e-6,'mono: bandL equals bandR');assert.ok(ms.band.mid>0);
 // wide and anti-phase
 const anti=steady((i,o)=>{const v=sine(500,.3)(i);o[0]=v;o[1]=-v;});assert.ok(anti.width>.95,`anti-phase width ${anti.width}`);assert.equal(Math.abs(anti.pan),0);
 const wide=steady((i,o)=>{o[0]=sine(500,.3)(i);o[1]=sine(730,.3)(i);});assert.ok(wide.width>.3&&wide.width<.7,`independent channels width ${wide.width}`);
 // silence has no pan
 assert.equal(steady(()=>{}).pan,0);
}

// ---- 7. per-band adaptive normalisation ----
{
 const cfg=(amp)=>{
  const steadyBus=new HudSignalBus();const steady=U(run(steadyBus,makeSignal(90,(i,o)=>{o[0]=o[1]=sine(1000,amp)(i);})));
  const burstBus=new HudSignalBus();const on=[],off=[];
  run(burstBus,makeSignal(60,(i,o)=>{o[0]=o[1]=(i/SR*2)%1<.5?sine(1000,amp)(i):0;}),{each:(snap,h,t)=>{if(t<40)return;const ph=(t*2)%1;const s=U(snap);if(ph>.1&&ph<.44)on.push(s.band.mid);else if(ph>.6&&ph<.95)off.push(s.band.mid);}});
  const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
  return {steady:steady.band.mid,steadyRms:steady.rms,on:mean(on),off:mean(off)};
 };
 const loud=cfg(.4),quiet=cfg(.004);
 assert.ok(Math.abs(loud.steady-.5)<.05&&Math.abs(quiet.steady-.5)<.05,`steady tones read mid-scale: ${loud.steady} ${quiet.steady}`);
 assert.ok(Math.abs(loud.steady-quiet.steady)<.02,'steady tones converge to the same value at both levels');
 assert.ok(Math.abs(loud.steadyRms-quiet.steadyRms)<.05,'broadband level converges too');
 assert.ok(loud.on>.8&&quiet.on>.8,`bursts read high while on: ${loud.on} ${quiet.on}`);assert.ok(loud.off<.1&&quiet.off<.1,`and low in the gaps: ${loud.off} ${quiet.off}`);
 assert.ok(Math.abs(loud.on-quiet.on)<.1,'level invariance of the normalised bursts');
 // a fresh bus starts from the priors: the first live values are v / 0.6-scaled and bounded
 const fresh=new HudSignalBus();const first=U(run(fresh,makeSignal(.5,(i,o)=>{o[0]=o[1]=sine(1000,.4)(i);})));assert.ok(first.band.mid>0&&first.band.mid<=1);
 // options change the adaptation: a very short release converges to mid-scale much faster
 const quick=new HudSignalBus({norm:{releaseSec:.5,floorSec:.5,minSpan:.05,priors:{sub:.6,low:.6,mid:.6,high:.6,air:.6}}});
 const qs=U(run(quick,makeSignal(6,(i,o)=>{o[0]=o[1]=sine(1000,.004)(i);})));assert.ok(Math.abs(qs.band.mid-.5)<.05,`fast trackers converge in 6 s: ${qs.band.mid}`);
 const slow=new HudSignalBus();const ss=U(run(slow,makeSignal(6,(i,o)=>{o[0]=o[1]=sine(1000,.004)(i);})));assert.ok(Math.abs(ss.band.mid-.5)>Math.abs(qs.band.mid-.5),`default trackers converge more slowly (${ss.band.mid} vs ${qs.band.mid})`);
}

// ---- 8. event groups: refractory, token bucket and rate options under a dense burst ----
{
 const T=6,r=rng(5);
 const dense=makeSignal(T,(i,o)=>{const ph=(i/SR)%.1;const v=ph<.02?.8*(r()*2-1)*Math.exp(-ph*60):0;o[0]=v;o[1]=v;});   // 10 broadband bursts per second
 const count=(opts)=>{const bus=new HudSignalBus(opts);const s=U(run(bus,dense));const c={};for(const g of HUD_GROUPS)c[g]=s.onset[g].count;return c;};
 const c0=count();
 for(const g of HUD_GROUPS)assert.ok(c0[g]<=DEFAULT_HUD_SIGNAL_OPTIONS.rate[g]*T+3,`${g}: ${c0[g]} events within rate*T+burst`);
 assert.ok(c0.any>=20,`dense burst still produces events (${c0.any})`);
 const c2=count({rate:{kick:5,snare:5,hat:8,tonal:6,any:2}});assert.ok(c2.any<=2*T+3&&c2.any>=2*T*.6,`any limited to 2/s: ${c2.any}`);
 const c3=count({rate:{kick:0,snare:5,hat:8,tonal:6,any:8}});assert.equal(c3.kick,0,'a zero rate disables a group');assert.ok(c3.any>0);
 // group counts never exceed the accepted 'any' plus the group's own bucket
 assert.ok(c0.kick+c0.snare+c0.hat+c0.tonal<=c0.any+3*4);
 // no window of 1 s holds more than rate + burst events (checked on the click-independent dense burst)
 const bus=new HudSignalBus();const times={};for(const g of HUD_GROUPS)times[g]=[];const prev={};for(const g of HUD_GROUPS)prev[g]=0;
 run(bus,dense,{each:(snap,h,t)=>{const s=U(snap);for(const g of HUD_GROUPS){for(let k=prev[g];k<s.onset[g].count;k++)times[g].push(t);prev[g]=s.onset[g].count;}}});
 for(const g of HUD_GROUPS){const ts=times[g];for(let a=0;a<ts.length;a++){const inWin=ts.filter(x=>x>=ts[a]&&x<ts[a]+1).length;assert.ok(inWin<=DEFAULT_HUD_SIGNAL_OPTIONS.rate[g]+3,`${g}: ${inWin} events in one second`);}}
 // refractory of the shared detector: no two 'any' events closer than 90 ms
 const anyT=times.any;for(let k=1;k<anyT.length;k++)assert.ok(anyT[k]-anyT[k-1]>=.09-HOP_SEC-1e-9,'refractory spacing');
 // onset envelope decays after an event and strength is held
 const cb=new HudSignalBus();let peakEnv=0,decayed=false,heldStrength=0;let lastCount=0;
 run(cb,click,{each:(snap)=>{const s=U(snap);if(s.onset.any.count!==lastCount){lastCount=s.onset.any.count;peakEnv=s.onset.any.env;heldStrength=s.onset.any.strength;}else if(peakEnv>0&&s.onset.any.env<peakEnv*.6){decayed=true;}
  if(s.live&&lastCount>0)assert.equal(s.onset.any.strength,heldStrength,'strength is held between events');}});
 assert.ok(decayed&&peakEnv>0,'onset env decays between events');
 // ageSec grows since the last event and is 60 before any
 const ab=new HudSignalBus();assert.equal(U(ab.snapshot(0,AVS)).onset.kick.ageSec,60);
 let ageOk=true,lastFireT=null,cnt=0;run(ab,click,{each:(snap,h,t)=>{const s=U(snap);if(s.onset.any.count!==cnt){cnt=s.onset.any.count;lastFireT=t;}if(lastFireT!==null&&Math.abs(s.onset.any.ageSec-Math.min(60,t-lastFireT))>1e-3)ageOk=false;}});
 assert.ok(ageOk,'ageSec is media seconds since the last accepted event');
}

// ---- 9. determinism, seek/reset, repeated snapshots ----
{
 const seg=makeSignal(6,(i,o)=>{const r=Math.sin(i*.0007)*.3;o[0]=sine(180,.2)(i)+r*Math.sin(i*1.3);o[1]=sine(2600,.15)(i)+((i>>9)&1?.2*Math.sin(i*.9):0);});
 const trace=(bus,opts={})=>{const out=[];run(bus,seg,{...opts,each:(snap,h)=>out.push(Array.from(snap))});return out;};
 const a=trace(new HudSignalBus()),b=trace(new HudSignalBus());
 assert.deepEqual(a,b,'two buses fed the same hops agree bit for bit');
 // a bus with junk history + reset() equals a fresh one
 const junk=makeSignal(3,(i,o)=>{o[0]=Math.sin(i*.01)*.9;o[1]=Math.sin(i*.037);});
 const dirty=new HudSignalBus();run(dirty,junk,{t0:500});dirty.snapshot(503,AVS);dirty.reset();
 assert.deepEqual(trace(dirty),a,'reset() restores a fresh bus exactly');
 // a seek: jump the media time and reset; the replay of the same interval is identical to the first pass
 const seekBus=new HudSignalBus();run(seekBus,seg,{to:200});seekBus.reset();
 const replay=[];run(seekBus,seg,{from:100,to:300,each:(snap)=>replay.push(Array.from(snap))});
 const cold=[];run(new HudSignalBus(),seg,{from:100,to:300,each:(snap)=>cold.push(Array.from(snap))});
 assert.deepEqual(replay,cold,'after a seek reset the interval replays identically to a cold start at that point');
 assert.equal(replay[0][O.live],0);
 // repeated snapshots at one time: identical, dt stable, fired stable; a different avs changes only legacy and beat
 const rb=new HudSignalBus();run(rb,seg,{to:120});
 const tS=120*HOP_SEC;const s1=rb.snapshot(tS,AVS),s2=rb.snapshot(tS,AVS);assert.deepEqual([...s1],[...s2]);
 const busy=emptyAvs();for(let i=0;i<576;i++){busy.spectrum[0][i]=(i*7)&255;busy.spectrum[1][i]=(i*13)&255;}busy.beat=true;busy.beatLevel=9216;
 const s3=rb.snapshot(tS,busy);
 for(let i=0;i<64;i++){const legacyOrBeat=i>=O.legacy||i===O.beatLatched||i===O.beatLevel;if(!legacyOrBeat)assert.equal(s3[i],s1[i],`slot ${i} independent of the avs frame`);}
 assert.equal(s3[O.beatLatched],1);assert.equal(s3[O.beatLevel],9216);assert.notEqual(s3[O.legacy],s1[O.legacy]);
 const earlier=rb.snapshot(tS-.05,AVS);assert.equal(earlier[O.dt],s1[O.dt],'an earlier time reuses dt');assert.deepEqual(Array.from(earlier).slice(0,60),Array.from(s1).slice(0,60));
 // dt clamps
 const db=new HudSignalBus();run(db,seg,{to:60});const base=60*HOP_SEC;
 db.snapshot(base,AVS);assert.equal(db.snapshot(base+.0001,AVS)[O.dt],f32(.001));assert.equal(db.snapshot(base+1,AVS)[O.dt],f32(.25));assert.equal(db.snapshot(base+1.01,AVS)[O.dt],f32(.01));
 // out parameter
 const out=new Float32Array(64);assert.equal(rb.snapshot(tS,AVS,out),out);assert.deepEqual([...out],[...s1]);
 // fired is delivered once: true at the first snapshot after an event, false at the next distinct time
 const fb=new HudSignalBus();let firedRuns=0,prevFired=false;
 run(fb,click,{each:(snap)=>{const f=snap[O.onsetFired+4]===1;if(f&&prevFired)firedRuns++;prevFired=f;}});
 assert.equal(firedRuns,0,'fired never stays true for two consecutive hops in the click track');
}

// ---- 10. discontinuities and duplicates ----
{
 const tone=makeSignal(1,(i,o)=>{o[0]=o[1]=sine(800,.3)(i);});
 const one=new HudSignalBus();run(one,tone,{to:40});
 const dup=new HudSignalBus();const pcm=new Float32Array(2*HOP);
 for(let h=0;h<40;h++){pcm.set(tone.L.subarray(h*HOP,h*HOP+HOP),0);pcm.set(tone.R.subarray(h*HOP,h*HOP+HOP),HOP);dup.push(pcm,h*HOP_SEC);dup.push(pcm,h*HOP_SEC+.001);dup.snapshot(h*HOP_SEC,AVS);}
 assert.deepEqual([...dup.snapshot(39*HOP_SEC,AVS)],[...one.snapshot(39*HOP_SEC,AVS)],'a duplicate hop within half a hop is dropped');
 // forward gap beyond 0.5 s resets
 const g=new HudSignalBus();run(g,tone,{to:40});assert.equal(g.snapshot(39*HOP_SEC,AVS)[O.live],1);
 pcm.set(tone.L.subarray(0,HOP),0);pcm.set(tone.R.subarray(0,HOP),HOP);g.push(pcm,50);
 let s=U(g.snapshot(50,AVS));assert.equal(s.live,false,'a forward gap resets: not live again');assert.equal(s.onset.any.count,0);assert.equal(s.t,50);
 // backward step resets
 const bk=new HudSignalBus();run(bk,tone,{to:40,t0:10});bk.push(pcm,5);s=U(bk.snapshot(5,AVS));assert.equal(s.live,false);assert.equal(s.t,5);
 // small forward gaps (dropped packets) are tolerated
 const sg=new HudSignalBus();run(sg,tone,{to:30});pcm.set(tone.L.subarray(0,HOP),0);sg.push(pcm,30*HOP_SEC+.1);assert.equal(sg.snapshot(30*HOP_SEC+.1,AVS)[O.live],1);
}

// ---- 11. garbage input never produces NaN and never throws ----
{
 const bus=new HudSignalBus();const r=rng(3);const pcm=new Float32Array(2*HOP);
 const check=snap=>{assert.ok(isF32(snap));for(let i=0;i<64;i++)assert.ok(Number.isFinite(snap[i]),`slot ${i} finite`);assert.equal(snap[0],2);};
 const values=[NaN,Infinity,-Infinity,1e30,-1e30,0,1,-1,.5];
 let t=0;
 for(let k=0;k<200;k++){for(let i=0;i<2*HOP;i++)pcm[i]=k%3===0?values[(i+k)%values.length]:(r()*2-1)*(k%5===0?8:1);bus.push(pcm,t);t+=HOP_SEC;check(bus.snapshot(t,AVS));}
 bus.push(new Float32Array(10),t);bus.push(new Float32Array(1152*2),t);bus.push(null,t);bus.push(pcm,NaN);bus.push(pcm,Infinity);bus.push(pcm,undefined);
 check(bus.snapshot(NaN,AVS));check(bus.snapshot(Infinity,AVS));check(bus.snapshot(-5,AVS));check(bus.snapshot(t,undefined));check(bus.snapshot(t,null));check(bus.snapshot(t,{}));check(bus.snapshot(t,{spectrum:[null,null]}));
 check(bus.snapshot(t,{waveform:[],spectrum:[new Uint8Array(3),new Uint8Array(0)],beat:'yes',beatLevel:'lots'}));
 check(bus.snapshot(t,{...AVS,beatLevel:NaN}));
 // the bus still works after the abuse
 bus.reset();const good=makeSignal(1,(i,o)=>{o[0]=o[1]=sine(440,.3)(i);});check(run(bus,good,{t0:0}));assert.equal(bus.snapshot(good.hops*HOP_SEC,AVS)[O.live],1);
 // full-scale square and Nyquist alternation
 const harsh=makeSignal(2,(i,o)=>{o[0]=(i&1)?1:-1;o[1]=((i>>6)&1)?1:-1;});check(run(new HudSignalBus(),harsh));
 // options sanitisation: garbage falls back to defaults
 const o1=new HudSignalBus({norm:{releaseSec:-1,floorSec:NaN,minSpan:0,priors:{sub:9,low:-2,mid:NaN}},rate:{kick:-3,any:NaN},contour:{fastSec:0,slowSec:Infinity},rampSec:-1});
 assert.equal(o1.options.norm.releaseSec,8);assert.equal(o1.options.norm.floorSec,4);assert.equal(o1.options.norm.minSpan,.05);assert.equal(o1.options.norm.priors.sub,1);assert.equal(o1.options.norm.priors.low,0);assert.equal(o1.options.norm.priors.mid,.6);
 assert.equal(o1.options.rate.kick,5);assert.equal(o1.options.rate.any,8);assert.equal(o1.options.contour.fastSec,1);assert.equal(o1.options.contour.slowSec,8);assert.equal(o1.options.rampSec,.25);
 check(run(o1,good));
 assert.ok(Object.isFrozen(o1.options)&&Object.isFrozen(o1.options.norm.priors),'sanitised options are frozen');
 const o2=new HudSignalBus({rampSec:0});assert.equal(o2.options.rampSec,0);
 assert.equal(U(o2.snapshot(0,AVS)).live,false,'no data is never live even with a zero ramp');
}

// ---- 12. legacy values are bit-exact with nerv-scenes band(), beat is a pass-through ----
{
 const r=rng(2026);
 const frame=mode=>{const a=emptyAvs();for(let c=0;c<2;c++)for(let i=0;i<576;i++){
  a.spectrum[c][i]=mode===0?0:mode===1?255:mode===2?(r()*256)|0:mode===3?(i<12?255-i*9:(r()<.1?(r()*90)|0:0)):(Math.exp(-i/(40+c*60))*255)|0;
  a.waveform[c][i]=(r()*256)|0;}return a;};
 let compared=0;
 for(let trial=0;trial<300;trial++){
  const a=frame(trial%5);
  const want={low:nervBand(a,0,10),mid:nervBand(a,10,93),high:nervBand(a,93,512)};want.level=(want.low+want.mid+want.high)/3;
  const got=hudLegacyBands(a);
  assert.deepEqual(got,want,`hudLegacyBands equals nervBand exactly (trial ${trial})`);
  const bus=new HudSignalBus();const u=U(bus.snapshot(1,a));
  for(const k of ['low','mid','high','level'])assert.equal(u.legacy[k],f32(want[k]),`packed legacy.${k}`);
  compared++;
 }
 assert.equal(compared,300);
 // legacy is independent of the analysed audio and valid while live is false
 const bus=new HudSignalBus();const a=frame(3);const u=U(bus.snapshot(0,a));assert.equal(u.live,false);assert.ok(u.legacy.low>0);
 assert.deepEqual(hudLegacyBands(null),{low:0,mid:0,high:0,level:0});assert.deepEqual(hudLegacyBands({}),{low:0,mid:0,high:0,level:0});
 // the module reproduces the exact NERV slot boundaries: change one slot and only the band containing it moves
 const p=emptyAvs();p.spectrum[0][9]=200;const pl=hudLegacyBands(p);p.spectrum[0][9]=0;p.spectrum[0][10]=200;const pm=hudLegacyBands(p);
 assert.ok(pl.low>0&&pl.mid===0&&pm.low===0&&pm.mid>0);
 // beat pass-through
 const bb=new HudSignalBus();const q=emptyAvs();q.beat=true;q.beatLevel=73728;let x=U(bb.snapshot(0,q));assert.equal(x.beat.latched,true);assert.equal(x.beat.level,73728);
 q.beat=false;q.beatLevel=-5;x=U(bb.snapshot(0,q));assert.equal(x.beat.latched,false);assert.equal(x.beat.level,0);
}

// ---- 13. centroid, flux, contour ----
{
 const c=(hz)=>U(run(new HudSignalBus(),makeSignal(2,(i,o)=>{o[0]=o[1]=sine(hz,.3)(i);}))).centroid;
 const c100=c(100),c1k=c(1000),c8k=c(8000);
 assert.ok(c100<c1k&&c1k<c8k,`centroid rises with frequency ${c100} ${c1k} ${c8k}`);
 assert.ok(Math.abs(c1k-Math.log(1000/20)/Math.log(1000))<.05,`1 kHz centroid ${c1k}`);
 assert.ok(Math.abs(c100-Math.log(100/20)/Math.log(1000))<.06&&Math.abs(c8k-Math.log(8000/20)/Math.log(1000))<.06);
 // flux is high near onsets and near zero in a steady tone
 let onsetFlux=0,n=0;const cb=new HudSignalBus();run(cb,click,{each:(snap)=>{const s=U(snap);if(s.onset.any.fired){onsetFlux+=s.flux;n++;}}});assert.ok(n>0&&onsetFlux/n>.5,`flux at onsets ${onsetFlux/n}`);
 const steady=U(run(new HudSignalBus(),makeSignal(4,(i,o)=>{o[0]=o[1]=sine(1000,.3)(i);})));assert.ok(steady.flux<.05,`steady flux ${steady.flux}`);
 // contour: a rising level reads as a build, a falling level as a release, steady sits at 0.5
 const ramp=(from,to,secs)=>makeSignal(secs,(i,o)=>{const p=i/SR/secs;const amp=from*Math.pow(to/from,p);o[0]=o[1]=sine(400,amp)(i)+sine(3000,amp*.5)(i);});
 const tension=(sig)=>{let last;run(new HudSignalBus(),sig,{each:(snap,h)=>{if(h===sig.hops-1)last=U(snap);}});return last;};
 const up=tension(ramp(.005,.4,14)),down=tension(ramp(.4,.005,14)),flat=tension(makeSignal(30,(i,o)=>{o[0]=o[1]=sine(400,.2)(i)+sine(3000,.1)(i);}));
 assert.ok(up.contour.slope>.3&&up.contour.tension>.7,`build ${JSON.stringify(up.contour)}`);
 assert.ok(down.contour.slope<-.3&&down.contour.tension<.3,`release ${JSON.stringify(down.contour)}`);
 assert.ok(Math.abs(flat.contour.slope)<.05&&Math.abs(flat.contour.tension-.5)<.1,`steady ${JSON.stringify(flat.contour)}`);
 assert.ok(up.contour.fast>up.contour.slow&&down.contour.fast<down.contour.slow);
}

// ---- 14. purity: no clock, randomness, timers or DOM in the module ----
{
 const src=readFileSync('src/hud/hud-signals.ts','utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*$/gm,'');
 for(const banned of ['Date.now','Math.random','performance.now','setTimeout','setInterval','requestAnimationFrame','document','window.','localStorage','fetch(','self.','postMessage','AudioContext'])assert.ok(!src.includes(banned),`hud-signals.ts must not use ${banned}`);
 assert.ok(/from '\.\.\/audio-features\.ts'/.test(src)&&!/nerv-scenes/.test(src),'depends only on the shared detector');
}
console.log('hud-signals: all checks passed');
