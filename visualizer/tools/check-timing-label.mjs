import {build} from 'esbuild';
import assert from 'node:assert/strict';
async function load(path){const result=await build({entryPoints:[path],bundle:true,format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);}
const {timingLabel,FpsLabel,LABEL_NO_ELIGIBLE,LABEL_CLOCK_HELD}=await load('src/timing-label.ts');

// Verbatim oracle: the nested ternary that mpc-host.ts frame() assigned to timing.textContent before the timing label module.
function oracle(v){
  const {director,eligibleCount,phase,sceneTiming,queued,catalog,sequenceSuspended,playing,prepared,loading,bars}=v;
  return director.enabled&&!eligibleCount?'Auto · no eligible presets — lower the shuffle rating or restore a preset':phase?`Scene clock · ${sceneTiming.bpm} BPM · ${Math.ceil((phase.duration-phase.localTime)*sceneTiming.bpm/240)} bars · ${playing?'playing':'paused'}${queued?` · queued ${catalog[queued.index].name}`:''}`:sceneTiming.enabled&&sequenceSuspended?'Scene clock held · activate setup or toggle Auto off/on to resume':!director.enabled ? 'Auto off' : !playing ? 'Auto paused' : !director.tempo.locked ? (director.energy < .001 ? 'Auto · waiting for audio signal' : 'Auto · listening for tempo') : `${Math.round(director.tempo.bpm)} BPM · ${bars === null ? 'waiting for music' : `${bars} bars`} ${prepared?.bitmap ? '· ready' : loading ? '· preparing' : ''}`;
}
const catalog=[{name:'Zero'},{name:'NERV berserk'}];
let cases=0;
for(const enabled of [true,false])for(const eligibleCount of [0,3])for(const phase of [null,{duration:16,localTime:3},{duration:2,localTime:2},{duration:7.5,localTime:0}])for(const queued of [null,{index:1}])
for(const clockEnabled of [true,false])for(const sequenceSuspended of [true,false])for(const playing of [true,false])for(const locked of [true,false])for(const energy of [0,.0005,.01])
for(const bars of [null,0,7])for(const prepared of [null,{bitmap:{}},{bitmap:null}])for(const loading of [true,false])for(const tempoBpm of [127.5,90.4,133.33])for(const bpm of [120,133.33,92]){
  const v={director:{enabled,energy,tempo:{locked,bpm:tempoBpm}},eligibleCount,phase,sceneTiming:{bpm,enabled:clockEnabled},queued,catalog,sequenceSuspended,playing,prepared,loading,bars};
  const input={autoEnabled:enabled,eligibleCount,clock:phase!==null,sceneBpm:bpm,clockBarsLeft:phase?Math.ceil((phase.duration-phase.localTime)*bpm/240):0,playing,
    queuedName:queued?catalog[queued.index].name:null,clockEnabled,sequenceSuspended,tempoLocked:locked,energy,tempoBpm,remainingBars:bars,ready:!!prepared?.bitmap,loading,fps:null,barBeat:null};
  assert.equal(timingLabel(input),oracle(v),JSON.stringify(input));
  // Absent optional fields and an empty resolution string change nothing either.
  assert.equal(timingLabel({...input,resolution:undefined}),oracle(v));assert.equal(timingLabel({...input,resolution:''}),oracle(v));
  cases++;
}
assert.ok(cases>50000);
// The trailing space of the locked-tempo text is part of today's output.
assert.equal(timingLabel({autoEnabled:true,eligibleCount:2,clock:false,sceneBpm:120,clockBarsLeft:0,playing:true,queuedName:null,clockEnabled:false,sequenceSuspended:false,tempoLocked:true,energy:.5,tempoBpm:128.4,remainingBars:12,ready:false,loading:false,fps:null,barBeat:null}),'128 BPM · 12 bars ');

const base={autoEnabled:true,eligibleCount:5,clock:false,sceneBpm:120,clockBarsLeft:3,playing:true,queuedName:null,clockEnabled:false,sequenceSuspended:false,tempoLocked:false,energy:.5,tempoBpm:128.4,remainingBars:12,ready:false,loading:false,fps:null,barBeat:null};
const label=over=>timingLabel({...base,...over});
// The fps segment sits right after the BPM token when the state has one, otherwise it is appended.
assert.equal(label({tempoLocked:true,ready:true,fps:'60 fps'}),'128 BPM · 60 fps · 12 bars · ready');
assert.equal(label({tempoLocked:true,loading:true,fps:'60 fps'}),'128 BPM · 60 fps · 12 bars · preparing');
assert.equal(label({tempoLocked:true,remainingBars:null,fps:'60 fps'}),'128 BPM · 60 fps · waiting for music ');
assert.equal(label({clock:true,fps:'60 fps'}),'Scene clock · 120 BPM · 60 fps · 3 bars · playing');
assert.equal(label({clock:true,fps:'60 fps',barBeat:{bar:17,beat:3}}),'Scene clock · 120 BPM · 60 fps · bar 17.3 · 3 bars · playing');
assert.equal(label({clock:true,fps:'60 fps (render 58 · clock 30 Hz)',barBeat:{bar:17,beat:3}}),'Scene clock · 120 BPM · 60 fps (render 58 · clock 30 Hz) · bar 17.3 · 3 bars · playing');
assert.equal(label({clock:true,barBeat:{bar:1,beat:1}}),'Scene clock · 120 BPM · bar 1.1 · 3 bars · playing','the bar readout does not need fps');
assert.equal(label({clock:true,playing:false,barBeat:{bar:4,beat:2}}),'Scene clock · 120 BPM · bar 4.2 · 3 bars · paused');
// A frame rate handed over while paused is dropped (the host's FpsLabel already returns null then); the bar readout and the resolution stay.
assert.equal(label({clock:true,playing:false,fps:'60 fps',barBeat:{bar:4,beat:2}}),'Scene clock · 120 BPM · bar 4.2 · 3 bars · paused');
assert.equal(label({clock:true,playing:false,fps:'60 fps',resolution:'1920×1080'}),'Scene clock · 120 BPM · 1920×1080 · 3 bars · paused');
assert.equal(label({autoEnabled:false,playing:false,fps:'60 fps'}),'Auto off');
assert.equal(label({clockEnabled:true,sequenceSuspended:true,playing:false,fps:'60 fps'}),LABEL_CLOCK_HELD);
assert.equal(label({clock:true,fps:'60 fps',queuedName:'NERV berserk'}),'Scene clock · 120 BPM · 60 fps · 3 bars · playing · queued NERV berserk');
assert.equal(label({clockEnabled:true,sequenceSuspended:true,fps:'60 fps'}),`${LABEL_CLOCK_HELD} · 60 fps`);
assert.equal(label({autoEnabled:false,fps:'60 fps'}),'Auto off · 60 fps');
assert.equal(label({energy:0,fps:'60 fps'}),'Auto · waiting for audio signal · 60 fps');
assert.equal(label({energy:.2,fps:'60 fps'}),'Auto · listening for tempo · 60 fps');
// Paused, or nothing eligible: unchanged text, no fps and no resolution.
assert.equal(label({playing:false,fps:'60 fps',resolution:'1920×1080'}),'Auto paused');
assert.equal(label({eligibleCount:0,fps:'60 fps',resolution:'1920×1080',clock:true,barBeat:{bar:2,beat:2}}),LABEL_NO_ELIGIBLE);
assert.ok(LABEL_NO_ELIGIBLE.includes('no eligible'));
// Resolution (detail mode only, decided by the host) sits beside the fps segment; alone it takes the same slot.
assert.equal(label({clock:true,fps:'60 fps',resolution:'1920×1080',barBeat:{bar:2,beat:1}}),'Scene clock · 120 BPM · 60 fps · 1920×1080 · bar 2.1 · 3 bars · playing');
assert.equal(label({tempoLocked:true,fps:null,resolution:'1280×720',ready:true}),'128 BPM · 1280×720 · 12 bars · ready');
assert.equal(label({autoEnabled:false,resolution:'640×360'}),'Auto off · 640×360');
// Text written by the host must only change when the state does: identical input gives identical text.
{const a=label({clock:true,fps:'59 fps'}),b=label({clock:true,fps:'59 fps'});assert.equal(a,b);assert.notEqual(a,label({clock:true,fps:'60 fps'}));}
// Wired together with FpsLabel over mocked frame times: 16.667 ms spacing reads 60.
{
  const {FpsMeter}=await load('src/fps-meter.ts');
  const meter=new FpsMeter(),fps=new FpsLabel();let now=1000,text='';
  for(let i=0;i<90;i++){meter.mark(now);now+=1000/60;text=label({tempoLocked:true,ready:true,fps:fps.segment(now,{present:meter.read(now)},1,true)});}
  assert.match(text,/^128 BPM · (59|60|61) fps · 12 bars · ready$/);
  const hidden=label({tempoLocked:true,ready:true,fps:fps.segment(now+5000,{present:meter.read(now+5000)},1,true)});
  assert.equal(hidden,'128 BPM · 12 bars · ready','a stalled meter omits the segment instead of printing 0 fps');
  assert.equal(label({tempoLocked:true,ready:true,fps:fps.segment(now,{present:meter.read(now)},0,true)}),'128 BPM · 12 bars · ready','showFps 0');
}
console.log(`Timing label CPU: ${cases} states byte-identical to the verbatim ternary, fps and bar:beat placement in every state, paused and no-eligible unchanged, resolution slot, stalled meter PASS`);
