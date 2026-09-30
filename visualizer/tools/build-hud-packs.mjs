// Local-only procedural generator. Defaults to ALL sources, without dedupe or caps.
// Nothing is fetched, uploaded, or written into source assets. Images exist in memory only.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { decodeImage } from './png-lite.mjs';
import { hash, isInside, noLinks, readKit, auditKit } from './check-hud-kits.mjs';
import { PACK_LABELS, DECISIONS, slug, classify, driverSignal, familyOf, packOf, eraOf } from './hud-taxonomy.mjs';
const visualizer=fileURLToPath(new URL('../',import.meta.url));
export const GENERATOR_VERSION='hud-gen-1';
export const DEFAULT_INDEX=path.resolve(visualizer,'../../.wiki/topics/hud-design/assets/hud-source-index.json');
export const DEFAULT_PRIVATE_DIR=path.resolve(visualizer,'../.tmp/hud-private');
export async function tsModule(file){const b=await build({entryPoints:[file],bundle:true,format:'esm',platform:'node',write:false,logLevel:'silent'});return import(`data:text/javascript;base64,${Buffer.from(b.outputFiles[0].text).toString('base64')}`);}
let schemaPromise;export const hudSchema=()=>schemaPromise??=tsModule(path.join(visualizer,'src','hud','hud-manifest.ts'));
const round=n=>Math.round(n*1e6)/1e6;
const clamp=(n,a=0,b=1)=>Math.max(a,Math.min(b,Number.isFinite(n)?n:a));
const hex=rgb=>'#'+rgb.map(v=>Math.round(clamp(v,0,255)).toString(16).padStart(2,'0')).join('');
const rgb=h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16));
const lab=rgb=>{const [r,g,b]=rgb.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}),l=Math.cbrt(.4122214708*r+.5363325363*g+.0514459929*b),m=Math.cbrt(.2119034982*r+.6806995451*g+.1073969566*b),s=Math.cbrt(.0883024619*r+.2817188376*g+.6299787005*b);return [.2104542553*l+.793617785*m-.0040720468*s,1.9779984951*l-2.428592205*m+.4505937099*s,.0259040371*l+.7827717662*m-.808675766*s];};
const distance=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
export const DEFAULT_PALETTE=Object.freeze({ink:'#0a0c14',paper:'#f0e6c8',shade:'#151a2c',hi:'#ffffff',a1:'#f2b21c',a2:'#3d7bff',ok:'#4ade80',warn:'#f59e0b',bad:'#ef4444'});
/** Quantized, weighted OKLab k-means; deterministic farthest-point initialization and eight iterations. */
export function samplePalette(images){
  const histogram=new Map();for(const image of images){const p=image.rgba,step=Math.max(1,Math.floor(p.length/4/32768));for(let i=0;i<p.length;i+=4*step){if(p[i+3]<128)continue;const color=p.subarray(i,i+3).reduce((s,v,j)=>s|((v>>3)<<(10-j*5)),0);histogram.set(color,(histogram.get(color)??0)+1);}}
  const points=[...histogram].sort((a,b)=>a[0]-b[0]).map(([v,n])=>{const color=[(v>>10)&31,(v>>5)&31,v&31].map(x=>x*255/31);return {color,n,lab:lab(color)};});if(!points.length)return {...DEFAULT_PALETTE};
  const first=[...points].sort((a,b)=>b.n-a.n||hex(a.color).localeCompare(hex(b.color)))[0];let centres=[first.lab];
  while(centres.length<Math.min(6,points.length)){let next=points[0],farthest=-1;for(const point of points){const d=Math.min(...centres.map(c=>distance(point.lab,c)));if(d>farthest){farthest=d;next=point;}}if(farthest<1e-8)break;centres.push(next.lab);}
  let groups;for(let iteration=0;iteration<8;iteration++){groups=centres.map(()=>[]);for(const point of points){let nearest=0;for(let i=1;i<centres.length;i++)if(distance(point.lab,centres[i])<distance(point.lab,centres[nearest]))nearest=i;groups[nearest].push(point);}centres=groups.map((group,i)=>group.length?Array.from({length:3},(_,j)=>group.reduce((s,p)=>s+p.lab[j]*p.n,0)/group.reduce((s,p)=>s+p.n,0)):centres[i]);}
  const clusters=groups.filter(g=>g.length).map(g=>{const n=g.reduce((s,p)=>s+p.n,0),color=Array.from({length:3},(_,j)=>g.reduce((s,p)=>s+p.color[j]*p.n,0)/n);return {color,n,lab:lab(color)};}),total=clusters.reduce((s,c)=>s+c.n,0);
  const dark=clusters.filter(c=>c.n/total>=.08).sort((a,b)=>a.lab[0]-b.lab[0])[0]??clusters[0];
  const light=[...clusters].sort((a,b)=>b.lab[0]-a.lab[0]||Math.hypot(a.lab[1],a.lab[2])-Math.hypot(b.lab[1],b.lab[2]))[0];
  const accents=clusters.filter(c=>c.n/total>=.01&&c.lab[0]>=.35&&c.lab[0]<=.85).sort((a,b)=>Math.hypot(b.lab[1],b.lab[2])-Math.hypot(a.lab[1],a.lab[2])||hex(a.color).localeCompare(hex(b.color)));
  let a1=accents[0]?.color??rgb(DEFAULT_PALETTE.a1),a2=accents.find(c=>distance(c.lab,lab(a1))>=.12)?.color??rgb(DEFAULT_PALETTE.a2);
  if(distance(lab(rgb(hex(a1))),lab(rgb(hex(a2))))<.125){a1=rgb(DEFAULT_PALETTE.a1);a2=rgb(DEFAULT_PALETTE.a2);}
  return {ink:hex(dark.color.map(v=>v*.22)),paper:hex(light.color.map(v=>Math.max(224,Math.min(246,v)))),shade:hex(dark.color.map(v=>v*.3+12)),hi:'#ffffff',a1:hex(a1),a2:hex(a2),ok:'#4ade80',warn:'#f59e0b',bad:'#ef4444'};
}
/** Row/column contrast census chooses a dock for image-only and template sources; no pixels are retained. */
export function imageLayout(image){
  if(!image)return {dock:'top',origin:'template'};const {sampleWidth:w,sampleHeight:h,rgba:p}=image;const brightness=(x,y)=>{const i=(y*w+x)*4;return (p[i]+p[i+1]+p[i+2])/765;};
  const strips={top:[0,0,w,Math.max(1,Math.floor(h*.2))],bottom:[0,Math.floor(h*.8),w,h],left:[0,0,Math.max(1,Math.floor(w*.2)),h],right:[Math.floor(w*.8),0,w,h]};const scores=[];
  for(const [dock,[x0,y0,x1,y1]] of Object.entries(strips)){let edge=0,n=0;const step=Math.max(1,Math.floor(Math.max(w,h)/256));for(let y=y0;y<y1;y+=step)for(let x=x0;x<x1;x+=step){if(x+step<w){edge+=Math.abs(brightness(x,y)-brightness(x+step,y));n++;}if(y+step<h){edge+=Math.abs(brightness(x,y)-brightness(x,y+step));n++;}}scores.push([dock,n?edge/n:0]);}
  scores.sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));return {dock:scores[0][0],origin:'image'};
}
export function loadSources({kits,index}){
  const sources=[];if(kits&&existsSync(kits)){noLinks(kits);for(const e of readdirSync(kits,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))){if(!e.isDirectory()||e.name.startsWith('_'))continue;const kit=readKit(path.join(kits,e.name)),m=kit.manifest;sources.push({...m,type:'kit',key:kit.key,title:m.provenance?.game??m.source?.game??m.title??kit.key,platform:m.provenance?.platform??m.platform,year:m.provenance?.releaseYear??m.year,elements:m.elements??[],kit,sourceTag:hash('hud-kit:'+kit.key)});}}
  if(index&&existsSync(index)){noLinks(index);if(lstatSync(index).size>16*1024*1024)throw Error('Oversized source index');const data=JSON.parse(readFileSync(index,'utf8')),entries=Array.isArray(data)?data:data.entries;if(!Array.isArray(entries))throw Error('Invalid source index');const occurrences=new Map();for(const row of entries){if(!row||typeof row!=='object')throw Error('Invalid source-index entry');const key=String(row.id??hash(JSON.stringify(row))),n=occurrences.get(key)??0;occurrences.set(key,n+1);sources.push({...row,type:'index',key,title:row.title??key,elements:[],image:typeof row.image_file==='string'&&row.image_file?path.resolve(path.dirname(index),row.image_file):null,sourceTag:hash('hud-index:'+key+':'+n)});}}
  return sources.sort((a,b)=>a.sourceTag.localeCompare(b.sourceTag));
}
function decodeSource(source){
  const issues=[],palette=[];let image=null;const files=source.kit?source.kit.paletteImages:source.image?[source.image]:[];
  for(const file of files){try{noLinks(file);const bytes=readFileSync(file),decoded=decodeImage(bytes);palette.push(decoded);}catch{issues.push('unsupported-or-missing-image');}}
  const file=source.kit?.image??source.image;if(file)try{noLinks(file);image=decodeImage(readFileSync(file));}catch{if(!issues.length)issues.push('unsupported-or-missing-image');}else issues.push('no-image');
  return {image,palette,issues};
}
function canvasFor(source,image,pack){
  const table=[[/nes|famicom/i,256,240],[/snes/i,256,224],[/genesis|mega.drive/i,320,224],[/game.?boy(?!.*advance)/i,160,144],[/game.?boy.advance|gba/i,240,160],[/neo.?geo/i,320,224]];const platform=String(source.platform??source.provenance?.platform??'');
  for(const [re,w,h] of table)if(re.test(platform)&&image&&image.width%w===0&&image.height%h===0&&image.width/w===image.height/h)return {w,h,style:'pixel'};
  const ratio=image?image.width/image.height:16/9,w=ratio>=1?960:Math.max(64,Math.round(960*ratio)),h=ratio>=1?Math.max(64,Math.round(960/ratio)):960;return {w,h,style:'vector'};
}
function rect(value,canvas){const raw=Array.isArray(value)?value:[value?.x,value?.y,value?.width,value?.height];if(raw.some(v=>!Number.isFinite(v)))return null;let [x,y,w,h]=raw;if(x<0||y<0||w<=0||h<=0||x>=1||y>=1)return null;const snap=(v,n)=>round(Math.round(v*n)/n);x=snap(x,canvas.w);y=snap(y,canvas.h);w=Math.max(4/canvas.w,snap(Math.min(w,1-x),canvas.w));h=Math.max(4/canvas.h,snap(Math.min(h,1-y),canvas.h));if(x+w>1||y+h>1)return null;return [x,y,round(w),round(h)];}
function instrument(kind,id,r,z,driver='',role=''){
  const props={panel:{style:'flat'},viewport:{bed:'gradient',energy:.15},label:{text:'STATUS',font:'mono'},bar:{dir:/vertical|column|rail/.test(role)?'btt':'ltr',segs:12,trail:true},pips:{n:3,icon:'dot'},matrix:{cols:4,rows:2,mode:'levels'},counter:{digits:6,fmt:'score',mode:'interval',min:0,max:999999},timer:{unit:'bars',dir:'down'},portrait:{style:'emblem'},dial:{style:/globe|orb|fluid|radial/.test(role)?'orb':'needle',ticks:8},radar:{style:'radar',blips:4,rings:2},reticle:{style:'brackets',ticks:4},slots:{n:4,sel:'beat'},spectrum:{bars:8},scope:{mode:'wave'},terminal:{lines:['SYSTEM READY','CHANNELS ACTIVE'],reveal:'interval'},rain:{cols:8,set:'bin'},warning:{text:'CAUTION',style:'hazard',hz:1},combo:{text:'LINK',window:.5},banner:{cues:[{at:'s+0',text:'READY'}]},fx:{fx:'scanlines',amount:.1}}[kind];
  const layer={k:kind,id,r,z,c:kind==='viewport'?'ink':'a1',...props};if(!['panel','label','banner','fx','pips','slots','matrix','spectrum','scope','warning','combo'].includes(kind))layer.v=kind==='counter'?'interval.progress':kind==='timer'?'interval.remaining':driverSignal(driver,kind).signal;return layer;
}
function archetypeLayers(family,pack,layout,canvas){
  let items,archetype;
  if(family==='fighting'){archetype='duel';items=[['bar',[.04,.07,.36,.045]],['bar',[.6,.07,.36,.045]],['timer',[.45,.035,.1,.09]],['portrait',[.04,.15,.09,.13]],['portrait',[.87,.15,.09,.13]],['spectrum',[.2,.87,.6,.08]]];}
  else if(['cockpit','flight','racing','mecha'].includes(family)||['Cinema & TV','Anime & Mecha'].includes(pack)){archetype='triptych';items=[['bar',[.04,.12,.07,.6]],['reticle',[.38,.3,.24,.35]],['spectrum',[.8,.12,.16,.6]],['terminal',[.12,.8,.34,.14]],['radar',[.55,.78,.2,.17]]];}
  else if(['left','right'].includes(layout.dock)){archetype='command';const x=layout.dock==='left'?.04:.73;items=[['radar',[x,.08,.23,.28]],['bar',[x,.41,.23,.05]],['slots',[x,.54,.23,.08]],['counter',[x,.68,.23,.07]]];}
  else {archetype=layout.dock==='bottom'?'status':'score';const y=layout.dock==='bottom'?.78:.06;items=[['counter',[.04,y,.25,.07]],['timer',[.45,y,.13,.07]],['pips',[.73,y,.23,.065]],['bar',[.04,y+.11,.36,.05]],['slots',[.65,y+.11,.3,.05]]];}
  return {archetype,layers:[instrument('viewport','bed',[0,0,1,1],0),...items.map(([kind,r],i)=>instrument(kind,'unit-'+(i+1),rect(r,canvas),i+1))]};
}
function geometry(source,decoded,canvas,pack,family){
  const audit=source.kit?auditKit(source.kit):null,es=Array.isArray(source.elements)?source.elements:[],layout=imageLayout(decoded.image),base=archetypeLayers(family,pack,layout,canvas);
  if(audit?.corrected.layoutOrigin==='kit'){
    const layers=[],unmapped=[];for(const e of es){if(layers.length===16)break;const r=rect(e.normalizedRect,canvas);if(!r)continue;const classified=classify(e.role,e.aaavsProposal?.driver,e.observedState);if(classified.confidence==='fallback')unmapped.push(hash(String(e.role??'')));layers.push(instrument(classified.kind??DECISIONS.unknownRole,'unit-'+(layers.length+1),r,layers.length+1,e.aaavsProposal?.driver,String(e.role??'')));}
    if(layers.some(l=>!['panel','viewport','label'].includes(l.k)))return {archetype:'measured',layers,origin:'kit',unmapped,audit};
  }
  return {...base,origin:layout.origin,unmapped:[],audit};
}
const hueWord=palette=>{const [r,g,b]=rgb(palette.a1);return r>g*1.25?(b>g?'Rose':'Amber'):b>r*1.2?(g>b*.8?'Azure':'Cobalt'):g>r*1.1?'Jade':'Gold';};
function writeUnchanged(file,value){const bytes=typeof value==='string'?value:JSON.stringify(value,null,2)+'\n';noLinks(file);if(existsSync(file)&&readFileSync(file,'utf8')===bytes)return false;mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,bytes);return true;}
const strings=value=>typeof value==='string'?[value]:Array.isArray(value)?value.flatMap(strings):value&&typeof value==='object'?Object.values(value).flatMap(strings):[];
const objectKeys=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw Error('Unsafe output metadata keys');};
const HEX64=/^[a-f0-9]{64}$/;
const NEUTRAL_TITLE=/^(?:Measured|Duel|Triptych|Command|Status|Score) · (?:Rose|Amber|Azure|Cobalt|Jade|Gold) \d{4,}$/;
function metadataFolder(folder,label,title){if(typeof folder!=='string'||!folder.startsWith(label+'/')||!folder.endsWith('/'+title)||folder.split('/').length>6||folder.split('/').some(p=>!p||p.length>80||/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(p)))throw Error('Unsafe output metadata folder');const rest=folder.slice(label.length+1);if(rest!==title&&(!/^[A-Z]$/.test(rest[0]??'')||rest!==rest[0]+'/'+title))throw Error('Unsafe output metadata bucket');}
export function auditRegistry(registry){
  objectKeys(registry,['format','version','next','entries']);if(registry.format!=='aaavs-hud-registry'||registry.version!==1||!Number.isSafeInteger(registry.next)||registry.next<1||!registry.entries||typeof registry.entries!=='object'||Array.isArray(registry.entries))throw Error('Invalid registry metadata');
  const ids=new Set(),orders=new Set();for(const [key,e] of Object.entries(registry.entries)){objectKeys(e,['id','order','active','pack','title','sha256','file','inputDigest','folder']);if(!HEX64.test(key)||!/^[a-z0-9][a-z0-9-]{1,47}$/.test(e.id)||ids.has(e.id)||!Number.isSafeInteger(e.order)||e.order<1||orders.has(e.order)||e.order>=registry.next||typeof e.active!=='boolean'||!PACK_LABELS.includes(e.pack)||!NEUTRAL_TITLE.test(e.title)||!HEX64.test(e.sha256)||!HEX64.test(e.inputDigest))throw Error('Unsafe registry metadata');ids.add(e.id);orders.add(e.order);if(typeof e.file!=='string'||!PACK_LABELS.some(p=>e.file===`${slug(p)}/${e.id}.hud`))throw Error('Unsafe registry metadata file');if(e.folder!==undefined)metadataFolder(e.folder,e.pack,e.title);}
  return registry;
}
function auditPack(pack,byId,defaults){
  objectKeys(pack,['format','version','label','defaultsKey','default','scenes']);if(pack.format!=='aaavs-hud-pack'||pack.version!==1||!PACK_LABELS.includes(pack.label)||pack.defaultsKey!==pack.label||!Array.isArray(pack.scenes))throw Error('Unsafe pack metadata');objectKeys(pack.default,['barsPerScene','settings','label','character']);const authored=defaults.builtinDefault(pack.label,33);if(pack.default.label!==undefined&&pack.default.label!==pack.label||pack.default.character!==undefined&&pack.default.character!==authored.character)throw Error('Unsafe pack description');if(!Number.isInteger(pack.default.barsPerScene)||pack.default.barsPerScene<1||pack.default.barsPerScene>32)throw Error('Unsafe pack timing');objectKeys(pack.default.settings,['enabled','bars','shuffle','minimumRating','transition','beats','durationMs','keepOld','manualFade','autoFade','fadeTiming','fadeRandomSet','fadeAnchor','queueQuantize']);for(const value of Object.values(pack.default.settings))if(typeof value!=='boolean'&&(!Number.isFinite(value)||!Number.isInteger(value)))throw Error('Unsafe pack settings');
  for(const entry of pack.scenes){objectKeys(entry,['id','file','order','sha256','folder','tier','visual']);const found=byId.get(entry.id);if(!found||found.sha256!==entry.sha256||path.basename(found.file)!==entry.file||!Number.isSafeInteger(entry.order)||!['showcase','tuned','auto'].includes(entry.tier)||entry.visual!=='unreviewed')throw Error('Generated pack identity mismatch');metadataFolder(entry.folder,pack.label,found.m.title);}
}
function auditDenyList(value){objectKeys(value,['format','version','salt','hashes']);if(value.format!=='aaavs-hud-denylist'||value.version!==1||value.salt!=='hud-deny-v1'||!Array.isArray(value.hashes)||value.hashes.some(h=>typeof h!=='string'||!HEX64.test(h)))throw Error('Unsafe deny-list metadata');return new Set(value.hashes);}
export function privacyAudit(manifest,schema,deny){
  for(const text of strings(manifest))if(text.length>48||/[^\x20-\x7e\u00b7]/.test(text)||/\w+:\/\/|data:|[\\]|[a-z]:[\/]|\bwww\.|[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(text))throw Error('Public manifest contains private/unsafe text');
  for(const text of schema.hudScannedStrings(manifest))for(const ngram of schema.hudNgrams(text))if(deny.has(hash('hud-deny-v1:'+ngram)))throw Error('Public manifest contains source wording');
}
export const GENERIC_HUD_WORDS=Object.freeze(('a an and as at by for from in into is it no not of on or the to up with left right top bottom upper lower first person player twin two one zero three four '+
  'hud panel frame header footer dock console chassis housing viewport bed stage scene showcase measured duel triptych command status score system ready channels active caution link unit amber rose azure cobalt jade gold gradient canvas template image unreviewed '+
  'health vitality life lives energy armor ammo power fuel shield magic stamina gauge meter meters rail rails bar bars pip pips bargraph bargraphs spectrum spectrogram band frequency eye portrait face visor orb orbs ring rings dial needle speedometer '+
  'timer time clock countdown elapsed remaining round rank counter digits finish final start extension position progress range control online terminal digital rain voice text feed matrix consensus monitor condition danger warning alert motion tracker target targeting lock trace scan return credit combo insert continue boot sector signal channel').split(/\s+/));
export function denyList(sources,schema){
  // Common functional terms in the closed public vocabulary are not title identity.
  const generic=new Set(schema.hudWords([...PACK_LABELS,...GENERIC_HUD_WORDS,'gen auto'].join(' ')));
  const hashes=new Set();for(const source of sources)for(const ngram of schema.hudNgrams(String(source.title??'').replace(/HUD Component Kit$/i,'')))if(ngram.split(' ').some(word=>!generic.has(word)&&!/^\d+$/.test(word)))hashes.add(hash('hud-deny-v1:'+ngram));return hashes;
}
export async function refreshDenyList({kits=path.join(visualizer,'assets','hud-kits'),index=existsSync(DEFAULT_INDEX)?DEFAULT_INDEX:null,outDir=path.join(visualizer,'hud-presets')}={}){for(const protectedRoot of [kits,path.join(visualizer,'assets'),path.join(visualizer,'avs presets'),path.join(visualizer,'tools','golden')])if(isInside(outDir,protectedRoot))throw Error('Protected output directory');const schema=await hudSchema(),denied=denyList(loadSources({kits,index}),schema);noLinks(outDir);writeUnchanged(path.join(outDir,'_denylist.json'),{format:'aaavs-hud-denylist',version:1,salt:'hud-deny-v1',hashes:[...denied].sort()});return checkGenerated(outDir);}
let renderGatePromise;
/** Real CPU renderer gate: no browser/GPU. Seek equality measured at three sizes and endpoints. */
export async function engineGate(){
  return renderGatePromise??=(async()=>{const file=new URL('./check-hud-engine.mjs',import.meta.url);if(!existsSync(fileURLToPath(file)))return null;const R=await import(file.href),E=await R.loadHudEngine();return manifest=>{
    const scene=E.HudScene.compile(manifest);let budget=true,determinism=true,maxDraws=0,maxPaths=0;
    const render=(runtime,w,h,time)=>{const rec=R.recordingContext(w,h),stats=E.renderHudScene(scene,runtime,rec.ctx,w,h,R.hudFixtureFrame(time));rec.finish();maxDraws=Math.max(maxDraws,stats.draws);maxPaths=Math.max(maxPaths,stats.paths);budget&&=stats.draws<=400&&stats.paths<=2000&&stats.texts<=40&&stats.gradients<=8;return hash(JSON.stringify({calls:rec.calls,stats}));};
    for(const [w,h] of [[320,180],[960,540],[1920,1080]])for(const time of [0,8,16]){const runtime=new E.HudRuntime(scene),a=render(runtime,w,h,time);determinism&&=a===render(runtime,w,h,time);render(runtime,w,h,time+3);determinism&&=a===render(runtime,w,h,time)&&a===render(new E.HudRuntime(scene),w,h,time);}
    return {budget,determinism,maxDraws,maxPaths};};})();
}
export async function checkGenerated(directory){
  noLinks(directory);const schema=await hudSchema(),denied=existsSync(path.join(directory,'_denylist.json'))?auditDenyList(JSON.parse(readFileSync(path.join(directory,'_denylist.json'),'utf8'))):new Set();let scenes=0;const byId=new Map(),walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>{if(e.isSymbolicLink())throw Error('Linked output path');return e.isDirectory()?walk(path.join(dir,e.name)):e.isFile()&&e.name.endsWith('.hud')?[path.join(dir,e.name)]:[];});
  for(const file of walk(directory)){noLinks(file);const text=readFileSync(file,'utf8'),m=schema.parseHudManifest(JSON.parse(text));privacyAudit(m,schema,denied);if(schema.serializeHudManifest(m)!==text)throw Error('Non-canonical HUD manifest');if(byId.has(m.id))throw Error('Duplicate generated HUD id');byId.set(m.id,{m,file,sha256:hash(text)});scenes++;}
  const registryFile=path.join(directory,'_registry.json');let active=0;if(existsSync(registryFile)){const registry=auditRegistry(JSON.parse(readFileSync(registryFile,'utf8')));for(const entry of Object.values(registry.entries)){if(!entry.active)continue;const found=byId.get(entry.id);if(!found||found.sha256!==entry.sha256||found.m.title!==entry.title||path.resolve(directory,...entry.file.split('/'))!==path.resolve(found.file))throw Error('Generated registry mismatch');active++;}}
  const defaults=await tsModule(path.join(visualizer,'src','mpc-folder-defaults.ts'));for(const label of PACK_LABELS){const file=path.join(directory,slug(label),'pack.json');if(!existsSync(file))continue;auditPack(JSON.parse(readFileSync(file,'utf8')),byId,defaults);}
  return {scenes,active:existsSync(registryFile)?active:scenes,G0:'pass',privacy:'pass'};
}
/** generate({kits,index,outDir,privateDir,dryRun,gateRender?}). gateRender is the engine CPU adapter (G3/G4). */
export async function generate(options={}){
  const kits=path.resolve(options.kits??path.join(visualizer,'assets','hud-kits')),index=options.index===false?null:options.index??(existsSync(DEFAULT_INDEX)?DEFAULT_INDEX:null),outDir=path.resolve(options.outDir??path.join(visualizer,'hud-presets')),privateDir=path.resolve(options.privateDir??DEFAULT_PRIVATE_DIR);
  if(isInside(outDir,kits)||isInside(privateDir,kits)||isInside(privateDir,outDir)||isInside(outDir,privateDir))throw Error('Generated/private output must be separate from kits and each other');
  for(const protectedRoot of [path.join(visualizer,'assets'),path.join(visualizer,'avs presets'),path.join(visualizer,'tools','golden')])if(isInside(outDir,protectedRoot)||isInside(privateDir,protectedRoot))throw Error('Protected output directory');
  noLinks(outDir);noLinks(privateDir);const sources=loadSources({kits,index}),schema=await hudSchema(),defaults=await tsModule(path.join(visualizer,'src','mpc-folder-defaults.ts')),gateRender=options.gateRender??await engineGate();
  if(JSON.stringify(PACK_LABELS)!==JSON.stringify(defaults.HUD_PACK_LABELS))throw Error('HUD pack label contract drift');
  const denied=denyList(sources,schema),registryFile=path.join(outDir,'_registry.json');let old={entries:{},next:1};if(existsSync(registryFile)){noLinks(registryFile);old=auditRegistry(JSON.parse(readFileSync(registryFile,'utf8')));}
  const entries={...old.entries},counts={sources:sources.length,kits:sources.filter(s=>s.type==='kit').length,index:sources.filter(s=>s.type==='index').length,scenes:0,packs:Object.fromEntries(PACK_LABELS.map(p=>[p,0])),tiers:{showcase:0,tuned:0,auto:0},imageIssues:{},gates:{G0:{pass:0,fail:0},G1:{pass:0,fail:0},G2:{pass:0,fail:0},G3:{pass:0,fail:0,pending:0},G4:{pass:0,fail:0,pending:0},privacy:{pass:0,fail:0}},failures:[]};
  let next=old.next;const rows=[],titles={},audit=[];
  for(const source of sources){
    let stage='G0';try{const decoded=decodeSource(source);for(const issue of decoded.issues)counts.imageIssues[issue]=(counts.imageIssues[issue]??0)+1;const family=familyOf(source),label=packOf(source,family),pack=slug(label),canvas=canvasFor(source,decoded.image,label),layout=geometry(source,decoded,canvas,label,family),palette=samplePalette(decoded.palette);
      const existing=entries[source.sourceTag],order=existing?.order??next++,id=existing?.id??`${pack.slice(0,24)}-${layout.archetype}-${String(order).padStart(4,'0')}`,title=`${layout.archetype[0].toUpperCase()+layout.archetype.slice(1)} · ${hueWord(palette)} ${String(order).padStart(4,'0')}`;
      const manifest=schema.parseHudManifest({format:'mpcaaavs-hud',version:1,id,title,pack,family,era:eraOf(label),tags:['auto','unreviewed'],canvas,palette,timing:{freeBars:defaults.builtinDefault(label,33).barsPerScene},layers:layout.layers,meta:{tier:'auto',origin:layout.origin,rev:1,gen:GENERATOR_VERSION,kit:source.sourceTag.slice(0,8)}});
      const bytes=schema.serializeHudManifest(manifest);if(schema.serializeHudManifest(schema.parseHudManifest(JSON.parse(bytes)))!==bytes)throw Error('Canonical round trip mismatch');counts.gates.G0.pass++;
      stage='G1';for(const l of manifest.layers){if(l.r[2]*canvas.w<3.999||l.r[3]*canvas.h<3.999)throw Error('Geometry below minimum');}counts.gates.G1.pass++;
      stage='G2';if(schema.contrastRatio(palette.paper,palette.ink)<4.5||distance(lab(rgb(palette.a1)),lab(rgb(palette.a2)))<.12)throw Error('Palette contrast/distinctness gate');counts.gates.G2.pass++;
      if(gateRender){stage='G3';const gate=await gateRender(manifest);if(!gate.budget)throw Error('Engine budget gate');counts.gates.G3.pass++;stage='G4';if(!gate.determinism)throw Error('Engine determinism gate');counts.gates.G4.pass++;}else{counts.gates.G3.pending++;counts.gates.G4.pending++;}
      stage='privacy';privacyAudit(manifest,schema,denied);counts.gates.privacy.pass++;
      const sha256=hash(bytes),file=existing?.file??`${pack}/${id}.hud`;rows.push({manifest,bytes,file,label,order,sha256});titles[id]=String(source.title??source.key);entries[source.sourceTag]={id,order,active:true,pack:label,title,sha256,file,inputDigest:hash(JSON.stringify({source:source.kit?.manifest??source,palette,layout:layout.layers,gen:GENERATOR_VERSION},(key,value)=>['kit','directory','image','images','paletteImages'].includes(key)?undefined:value))};counts.scenes++;counts.packs[label]++;counts.tiers.auto++;if(layout.audit)audit.push(layout.audit);
    }catch(error){counts.gates[stage].fail++;counts.failures.push({source:source.sourceTag.slice(0,8),gate:stage,message:error.message});}
  }
  const active=new Set(sources.map(s=>s.sourceTag));for(const [key,entry] of Object.entries(entries))if(!active.has(key))entries[key]={...entry,active:false};
  // >60 direct title leaves receive alphabetic buckets. Metadata never uses real title text.
  for(const row of rows){const bucket=counts.packs[row.label]>60?`${row.manifest.title[0].toUpperCase()}/`:'';entries[activeKey(row,entries)].folder=`${row.label}/${bucket}${row.manifest.title}`;}
  const report={format:'aaavs-hud-generation-report',version:1,generator:GENERATOR_VERSION,dryRun:!!options.dryRun,all:true,...counts,liveAccepted:false};
  if(options.dryRun){writeUnchanged(path.join(outDir,'dry-run-report.json'),report);writeUnchanged(path.join(privateDir,'kit-metadata-overlay.json'),{format:'aaavs-hud-kit-audit',version:1,overlay:audit});return {report,rows,registry:{entries,next}};}
  if(counts.failures.length)throw Error(`HUD source gates failed (${counts.failures.length}); use --dry-run report`);
  for(const row of rows)writeUnchanged(path.join(outDir,...row.file.split('/')),row.bytes);
  for(const label of PACK_LABELS){if(label==='Showcase')continue;const packRows=rows.filter(r=>r.label===label),bundle=defaults.builtinDefault(label,33);writeUnchanged(path.join(outDir,slug(label),'pack.json'),{format:'aaavs-hud-pack',version:1,label,defaultsKey:label,default:{barsPerScene:bundle.barsPerScene,settings:bundle.settings},scenes:packRows.map(r=>({id:r.manifest.id,file:path.basename(r.file),order:r.order,sha256:r.sha256,folder:entries[activeKey(r,entries)].folder,tier:r.manifest.meta.tier,visual:'unreviewed'}))});}
  writeUnchanged(registryFile,{format:'aaavs-hud-registry',version:1,next,entries});writeUnchanged(path.join(outDir,'_denylist.json'),{format:'aaavs-hud-denylist',version:1,salt:'hud-deny-v1',hashes:[...denied].sort()});
  writeUnchanged(path.join(privateDir,'hud-titles.json'),{format:'aaavs-hud-titles',version:1,titles});writeUnchanged(path.join(privateDir,'generation-report.json'),report);writeUnchanged(path.join(privateDir,'kit-metadata-overlay.json'),{format:'aaavs-hud-kit-audit',version:1,overlay:audit});
  await checkGenerated(outDir);return {report,rows,registry:{entries,next}};
}
function activeKey(row,entries){return Object.keys(entries).find(key=>entries[key].id===row.manifest.id&&entries[key].active);}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const args=process.argv.slice(2),allowed=new Set(['--kits','--index','--out-dir','--out','--private-dir','--dry-run','--all','--check']),opts={};for(let i=0;i<args.length;i++){const key=args[i];if(!allowed.has(key))throw Error('Unknown generator option');if(['--dry-run','--all','--check'].includes(key)){opts[key.slice(2).replace(/-([a-z])/g,(_,x)=>x.toUpperCase())]=true;continue;}const value=args[++i];if(!value||value.startsWith('--'))throw Error('Missing generator option value');opts[({'--kits':'kits','--index':'index','--out-dir':'outDir','--out':'outDir','--private-dir':'privateDir'})[key]]=value;}if(opts.index==='none')opts.index=false;const result=opts.check?await checkGenerated(path.resolve(opts.outDir??path.join(visualizer,'hud-presets'))):(await generate(opts)).report;console.log(JSON.stringify(result,null,2));if(result.failures?.length)process.exitCode=1;}catch(e){console.error(e.message);process.exitCode=1;}
}
