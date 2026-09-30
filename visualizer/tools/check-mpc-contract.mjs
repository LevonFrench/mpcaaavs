import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
// Pins the stored-value contract (docs/design/CONTRACT.md 2.1): every constant, the two beat/fade mapping tables and
// their round trips, and the range flag day (transition index 0..32) across TypeScript, the Player server and native code.
// CPU only: bundles pure modules with esbuild and reads two source files as text. Native sources are skipped when absent (stock).
async function load(path){const r=await build({entryPoints:[path],bundle:true,format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);}
const c=await load('src/mpc-contract.ts');

// ---- constants: exact values, so a silent edit fails here and in the native/Player literal checks
const expected={
 TRANSITION_COUNT:33,TRANSITION_CUT:15,TRANSITION_RANDOM_ALL:31,TRANSITION_SMART:32,
 FADE_TIMING_COUNT:7,FADE_RANDOM_SET_MIN:1,FADE_RANDOM_SET_ALL:31,FADE_ANCHOR_COUNT:3,QUEUE_QUANTIZE_COUNT:4,
 DURATION_MS_MIN:250,DURATION_MS_MAX:8000,DURATION_MS_DEFAULT:2000,
 QUALITY_COUNT:5,AVS_RESOLUTION_COUNT:3,PIXEL_ART_COUNT:3,SHOW_FPS_COUNT:3,TIMING_OVERLAY_COUNT:2,
 DISPLAY_STORAGE_KEY:'aaavs.mpcDisplay.v1',STATE_MAX_BYTES:3670016,AUDIO_DURATION_MAX:86400,
};
for(const [name,value] of Object.entries(expected))assert.strictEqual(c[name],value,name);
assert.deepEqual([...c.LEGACY_BEATS],[0,1,2,4]);
assert.deepEqual([...c.STATE_NAMES],['folders','stats']);
assert.deepEqual([...c.BEATS_FROM_FADE],[0,0,1,2,4,0,0]);
assert.deepEqual({...c.FADE_FROM_BEATS},{0:0,1:2,2:3,4:4});
const exported=Object.keys(c).sort();
assert.deepEqual(exported,[...Object.keys(expected),'LEGACY_BEATS','STATE_NAMES','BEATS_FROM_FADE','FADE_FROM_BEATS'].sort(),'no unlisted export; add new constants to this pin');

// ---- relations between constants
assert.ok(c.TRANSITION_CUT<c.TRANSITION_COUNT&&c.TRANSITION_RANDOM_ALL<c.TRANSITION_COUNT&&c.TRANSITION_SMART===c.TRANSITION_COUNT-1);
assert.ok(c.TRANSITION_CUT<c.TRANSITION_RANDOM_ALL,'Cut, then the new styles, then the two selectors');
assert.ok(c.DURATION_MS_MIN<=c.DURATION_MS_DEFAULT&&c.DURATION_MS_DEFAULT<=c.DURATION_MS_MAX);
assert.equal(c.FADE_RANDOM_SET_ALL,(1<<(c.FADE_TIMING_COUNT-2))-1,'one random-set bit per concrete fade except Seconds and Random');
assert.ok(c.STATE_MAX_BYTES<4*1024*1024,'a state body fits under the 4 MiB library request cap');
assert.equal(c.BEATS_FROM_FADE.length,c.FADE_TIMING_COUNT);

// ---- beats <-> fadeTiming mapping tables
assert.deepEqual(Object.keys(c.FADE_FROM_BEATS).map(Number).sort(),[...c.LEGACY_BEATS],'FADE_FROM_BEATS covers exactly the legacy beats');
for(const beats of c.LEGACY_BEATS){
 const fade=c.FADE_FROM_BEATS[beats];
 assert.ok(Number.isInteger(fade)&&fade>=0&&fade<c.FADE_TIMING_COUNT,`fade for ${beats} beats`);
 assert.equal(c.BEATS_FROM_FADE[fade],beats,`beats ${beats} round-trips through fadeTiming ${fade}`);
}
assert.ok(c.BEATS_FROM_FADE.every(b=>c.LEGACY_BEATS.includes(b)),'every projection is a value old builds accept');
// fadeTiming values that have no legacy equivalent project to 0 ("Seconds") and are not recovered.
for(let fade=0;fade<c.FADE_TIMING_COUNT;fade++){
 const beats=c.BEATS_FROM_FADE[fade],back=c.FADE_FROM_BEATS[beats];
 if([0,2,3,4].includes(fade))assert.equal(back,fade,`fadeTiming ${fade} survives the legacy projection`);
 else{assert.equal(beats,0,`fadeTiming ${fade} (instant, 2 bars, random) projects to 0`);assert.equal(back,0);}
}

// ---- transition names stay consistent with the range while TRX has not yet extended the table
const {TRANSITIONS}=await load('src/mpc-transition.ts');
assert.ok(TRANSITIONS.length<=c.TRANSITION_COUNT,'no more names than stored indices');
assert.equal(TRANSITIONS[c.TRANSITION_CUT],'Cut','the Cut index never moves');

// ---- range flag day, TypeScript side: settings and setups accept 0..32 and nothing else
const {parseSetups,parseSettings,defaultSettings}=await load('src/mpc-setups.ts');
const hash='a'.repeat(64),setup=settings=>[{id:'contract',name:'Contract',presets:[hash],settings}];
for(const transition of [0,1,15,16,31,32]){
 assert.equal(parseSettings({...defaultSettings,transition}).transition,transition,`settings accept transition ${transition}`);
 assert.equal(parseSetups(setup({...defaultSettings,transition}))[0].settings.transition,transition,`setups accept transition ${transition}`);
}
for(const transition of [-1,33,64,1.5,'1',null,NaN,Infinity])assert.throws(()=>parseSettings({...defaultSettings,transition}),/Invalid setup settings/,`settings reject transition ${String(transition)}`);
for(const transition of [-1,33,1.5])assert.throws(()=>parseSetups(setup({...defaultSettings,transition})),/Invalid setup settings/);

// ---- parseSettings: legacy input unchanged, four optional v2 fields validated and copied only when present
const legacyKeys=['enabled','bars','shuffle','minimumRating','transition','beats','durationMs','keepOld','manualFade','autoFade'];
assert.deepEqual(Object.keys(parseSettings(defaultSettings)),legacyKeys,'legacy settings serialise as exactly the ten historical keys, in order');
assert.deepEqual(parseSettings(defaultSettings),defaultSettings);
const {minimumRating:_omitted,...withoutRating}=defaultSettings;
assert.equal(parseSettings(withoutRating).minimumRating,0,'a missing minimumRating means all ratings');
const v2={fadeTiming:4,fadeRandomSet:19,fadeAnchor:2,queueQuantize:3};
assert.deepEqual(parseSettings({...defaultSettings,...v2}),{...defaultSettings,...v2},'all four v2 fields are copied');
assert.deepEqual(Object.keys(parseSettings({...defaultSettings,...v2})),[...legacyKeys,'fadeTiming','fadeRandomSet','fadeAnchor','queueQuantize']);
for(const [key,value] of Object.entries(v2))assert.deepEqual(Object.keys(parseSettings({...defaultSettings,[key]:value})),[...legacyKeys,key],`${key} alone is copied alone`);
const bounds={fadeTiming:[0,c.FADE_TIMING_COUNT-1],fadeRandomSet:[c.FADE_RANDOM_SET_MIN,c.FADE_RANDOM_SET_ALL],fadeAnchor:[0,c.FADE_ANCHOR_COUNT-1],queueQuantize:[0,c.QUEUE_QUANTIZE_COUNT-1]};
for(const [key,[low,high]] of Object.entries(bounds)){
 for(const value of [low,high])assert.equal(parseSettings({...defaultSettings,[key]:value})[key],value,`${key} accepts ${value}`);
 for(const value of [low-1,high+1,1.5,'1',null,NaN,true,{}])assert.throws(()=>parseSettings({...defaultSettings,[key]:value}),/Invalid setup settings/,`${key} rejects ${String(value)}`);
 assert.equal(key in parseSettings({...defaultSettings,[key]:undefined}),false,`${key}: undefined counts as absent`);
}
assert.deepEqual(parseSetups(setup({...defaultSettings,...v2}))[0].settings,{...defaultSettings,...v2},'setups carry the v2 fields');
for(const bad of [undefined,null,0,'',[],{},{...defaultSettings,bars:3},{...defaultSettings,beats:3},{...defaultSettings,durationMs:249},{...defaultSettings,durationMs:8001},{...defaultSettings,keepOld:1}])assert.throws(()=>parseSettings(bad),/Invalid setup settings/);
assert.throws(()=>parseSettings({...defaultSettings,minimumRating:6}),/minimum rating/);

// ---- range flag day, Player server and native code (literals cannot import the TypeScript table)
const server=readFileSync('tools/standalone-library.mjs','utf8');
const serverTransition=server.match(/value\.transition\s*<=\s*(\d+)/);
assert.ok(serverTransition,'server transition upper bound literal');assert.equal(Number(serverTransition[1]),c.TRANSITION_COUNT-1,'Player server accepts exactly 0..TRANSITION_COUNT-1');
const serverDuration=server.match(/value\.durationMs\s*>=\s*(\d+)\s*&&\s*value\.durationMs\s*<=\s*(\d+)/);
assert.ok(serverDuration);assert.deepEqual([Number(serverDuration[1]),Number(serverDuration[2])],[c.DURATION_MS_MIN,c.DURATION_MS_MAX]);
const nativePath='../src/mpc-hc/AAAVSView.cpp';
if(existsSync(nativePath)){
 const native=readFileSync(nativePath,'utf8');
 const max=`(?:${c.TRANSITION_COUNT-1}|kTransitionCount\\s*-\\s*1)`;
 assert.match(native,new RegExp(`std::clamp\\(integer\\("transition",\\s*1\\),\\s*0,\\s*${max}\\)`),'native configure clamps transition to 0..TRANSITION_COUNT-1');
 assert.match(native,new RegExp(`transition\\s*>\\s*${max}\\)\\s*transition\\s*=\\s*1`),'native registry load rejects transition above TRANSITION_COUNT-1');
 assert.doesNotMatch(native,/transition\s*>\s*15\b|"transition",\s*1\),\s*0,\s*15\)/,'no leftover 0..15 transition range');
 assert.match(native,new RegExp(`std::clamp\\(integer\\("durationMs",2000\\),${c.DURATION_MS_MIN},${c.DURATION_MS_MAX}\\)`),'native configure clamps durationMs to the contract range');
}

// ---- nervBand: the exported legacy band level the HUD signal bus must match bit for bit
const nerv=await load('src/nerv-scenes.ts');
assert.equal(typeof nerv.nervBand,'function');
const frame=v=>({waveform:[new Uint8Array(576),new Uint8Array(576)],spectrum:[new Uint8Array(576).fill(v),new Uint8Array(576).fill(v)],beat:false,beatLevel:0});
assert.equal(nerv.nervBand(frame(0),0,10),0);assert.equal(nerv.nervBand(frame(255),0,10),1);
assert.ok(Math.abs(nerv.nervBand(frame(51),10,93)-0.2)<1e-12,'a flat 0.2 spectrum reads 0.2');

// ---- category taxonomy seed (SIG replaces the stubs, never the table order)
const cat=await load('src/avs/preset-categories.ts');
assert.equal(cat.TAXONOMY_VERSION,1);
assert.equal(cat.TAXONOMY.length,18);
assert.equal(new Set(cat.TAXONOMY.map(x=>x.id)).size,18,'unique category ids');
assert.deepEqual([...new Set(cat.TAXONOMY.map(x=>x.family))],['Scopes','Particles & Space','Feedback & Motion','Surface & Colour','Beat & Frame','Structure']);
assert.deepEqual(cat.TAXONOMY.map(x=>x.id),['scope-classic','scope-geometry','rings-stars','particles','starfield','perspective-3d','tunnel-zoom','spin-rotate','kaleido-mirror','water-ripple','bump-relief','color-grade','glitch-digital','beat-flash','text-image','multi-scene','minimal','mixed']);
assert.ok(cat.TAXONOMY.every(x=>/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x.id)&&x.label.length>0&&x.label.length<=48),'ids are slugs; labels are short');
assert.ok(Object.isFrozen(cat.TAXONOMY)&&cat.TAXONOMY.every(Object.isFrozen));
assert.equal(cat.parseCategories(undefined,[]),null);assert.equal(cat.parseCategories({},[]),null,'a malformed file yields null');
globalThis.fetch=async()=>{throw Error('offline');};
assert.equal(await cat.fetchLocalCategories(),null,'every loader failure yields null');
assert.equal(await cat.fetchLocalCategories('https://aaavs.invalid/mpc.html'),null);
console.log('Stored-value contract: constants, beats/fade tables and round trips, transition range 0..32 across TypeScript, Player server and native literals, settings v2 validation, nervBand, taxonomy seed PASS');
