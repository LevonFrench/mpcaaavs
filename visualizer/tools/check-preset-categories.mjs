import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
// Categories loader and local HUD title overlay (docs/design/PRESET-TAXONOMY-AND-JEV.md 6.2 and 9, docs/design/CONTRACT.md 2.3.8, owner
// directive C). CPU only: pure parsers on synthetic JSON, loaders against a stubbed `fetch`. No private collection is read, no network,
// no GPU. Every failure must return null without throwing, logging or retrying.
async function load(path){const r=await build({entryPoints:[path],bundle:true,format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);}
const M=await load('src/avs/preset-categories.ts');
const {TAXONOMY,TAXONOMY_VERSION,parseCategories,fetchLocalCategories,UNCLASSIFIED_ID,UNCLASSIFIED_TAXON,isClassified,parseHudTitles,fetchLocalHudTitles}=M;

const hex=n=>n.toString(16).padStart(64,'0');
const H=[...Array(8)].map((_,i)=>hex(0xa0+i));
const file=(entries,over={})=>({format:'aaavs-categories',version:1,taxonomy:{id:'aaavs-style',version:1},generated:'2026-01-01T00:00:00Z',generator:{tool:'classify-presets',method:'structure-v1',jev:null},catalogSha:hex(1),entries,...over});
const good={c:'particles',t:['glitch-digital'],e:'driving',b:3,f:'full',a:'Some Author',s:'s',k:.62};
const catalogOf=hashes=>hashes.map(sha256=>({sha256}));
const deepFreeze=o=>{if(o&&typeof o==='object'){Object.freeze(o);for(const v of Object.values(o))deepFreeze(v);}return o;};

// ---- taxonomy table (seeded by INT1, contract 2.3.8) ----
assert.equal(TAXONOMY_VERSION,1);
assert.deepEqual(TAXONOMY.map(c=>c.id),['scope-classic','scope-geometry','rings-stars','particles','starfield','perspective-3d','tunnel-zoom','spin-rotate','kaleido-mirror','water-ripple','bump-relief','color-grade','glitch-digital','beat-flash','text-image','multi-scene','minimal','mixed']);
assert.deepEqual([...new Set(TAXONOMY.map(c=>c.family))],['Scopes','Particles & Space','Feedback & Motion','Surface & Colour','Beat & Frame','Structure']);
assert.equal(new Set(TAXONOMY.map(c=>c.id)).size,18);assert.ok(TAXONOMY.every(c=>c.label.length>0&&Object.isFrozen(c))&&Object.isFrozen(TAXONOMY));
assert.equal(TAXONOMY.find(c=>c.id==='scope-classic').label,'Waveforms & Oscilloscopes');
assert.ok(!TAXONOMY.some(c=>c.id===UNCLASSIFIED_ID),'unclassified is not a category of its own');

// ---- 1. a valid file, joined to the catalog ----
{
 const json=file({[H[0]]:good,[H[1]]:{c:'mixed',t:[],e:'calm',b:1,f:'partial'}});
 const before=JSON.stringify(json);
 const catalog=deepFreeze(catalogOf([H[0],H[1],H[2]]));
 const map=parseCategories(json,catalog);
 assert.ok(map instanceof Map);assert.deepEqual([...map.keys()],[H[0],H[1],H[2]],'keys follow the catalog order');
 assert.deepEqual(map.get(H[0]),good);
 assert.deepEqual(map.get(H[1]),{c:'mixed',t:[],e:'calm',b:1,f:'partial'});
 assert.ok(Object.isFrozen(map.get(H[0]))&&Object.isFrozen(map.get(H[0]).t),'taxa are frozen');
 assert.equal(map.get(H[2]),UNCLASSIFIED_TAXON,'a catalog preset the file does not cover is unclassified');
 assert.equal(UNCLASSIFIED_TAXON.c,UNCLASSIFIED_ID);assert.equal(UNCLASSIFIED_TAXON.k,0);assert.ok(Object.isFrozen(UNCLASSIFIED_TAXON));
 assert.equal(isClassified(map.get(H[0])),true);assert.equal(isClassified(map.get(H[2])),false);assert.equal(isClassified(undefined),false);assert.equal(isClassified(null),false);
 assert.equal(JSON.stringify(json),before,'the input is not mutated');
 assert.deepEqual(catalog,catalogOf([H[0],H[1],H[2]]),'catalog rows are unchanged');
 assert.ok(catalog.every(Object.isFrozen),'and remain frozen');
 // entries absent from the catalog are ignored; an empty catalog gives an empty map, not null
 assert.equal(parseCategories(file({[H[5]]:good}),catalogOf([H[0]])).has(H[5]),false);
 assert.equal(parseCategories(file({[H[0]]:good}),[]).size,0);
 // without a catalog array every valid entry is kept and nothing is invented
 for(const none of [undefined,null,{},'x']){const m=parseCategories(file({[H[0]]:good,[H[1]]:{...good,c:'nope'}}),none);assert.deepEqual([...m.keys()],[H[0]]);}
 // duplicates, upper-case hashes and junk rows in the catalog
 const junk=parseCategories(file({[H[0]]:good}),[{sha256:H[0].toUpperCase()},{sha256:H[0]},null,undefined,{},{sha256:5},{sha256:'zz'},{sha256:H[3]},'x',[]]);
 assert.deepEqual([...junk.keys()],[H[0],H[3]]);assert.deepEqual(junk.get(H[0]),good);
}

// ---- 2. the file is ignored (null) when its identity does not match ----
{
 const e={[H[0]]:good};
 for(const [name,json] of [
  ['wrong format',file(e,{format:'other'})],['no format',(({format,...r})=>r)(file(e))],['version 2',file(e,{version:2})],['version string',file(e,{version:'1'})],['version 0',file(e,{version:0})],
  ['taxonomy id',file(e,{taxonomy:{id:'other',version:1}})],['taxonomy version',file(e,{taxonomy:{id:'aaavs-style',version:2}})],['taxonomy version 0',file(e,{taxonomy:{id:'aaavs-style',version:0}})],
  ['taxonomy missing',(({taxonomy,...r})=>r)(file(e))],['taxonomy array',file(e,{taxonomy:[]})],['taxonomy null',file(e,{taxonomy:null})],
  ['entries missing',(({entries,...r})=>r)(file(e))],['entries array',file([good])],['entries null',file(null)],['entries string',file('x')],['entries number',file(3)],
  ['null',null],['undefined',undefined],['string',JSON.stringify(file(e))],['number',3],['array',[]],['true',true],['function',()=>1],
 ])assert.equal(parseCategories(json,catalogOf([H[0]])),null,name);
 // the identity may be inherited from a prototype only if it is an own property: a polluted prototype does not count
 const inherited=Object.create({format:'aaavs-categories',version:1,taxonomy:{id:'aaavs-style',version:1},entries:{}});
 assert.equal(parseCategories(inherited,[]),null,'inherited members are not read');
 // a hostile object that throws on access degrades to null
 const boom=new Proxy({},{get(){throw new Error('boom');},ownKeys(){throw new Error('boom');},has(){throw new Error('boom');},getOwnPropertyDescriptor(){throw new Error('boom');}});
 assert.equal(parseCategories(boom,[]),null);
 assert.equal(parseCategories(file({[H[0]]:good}),new Proxy([],{get(){throw new Error('boom');}})),null,'a hostile catalog degrades to null');
}

// ---- 3. entry keys and fields: bad ones are dropped without throwing ----
{
 const polluted=JSON.parse(`{"__proto__":${JSON.stringify(good)},"constructor":${JSON.stringify(good)},"toString":${JSON.stringify(good)},"${H[0]}":${JSON.stringify(good)}}`);
 assert.ok(Object.keys(polluted).includes('__proto__'),'fixture carries an own __proto__ key like a parsed file would');
 const map=parseCategories(file(polluted),[...catalogOf([H[0]]),{sha256:'__proto__'}]);
 assert.deepEqual([...map.keys()],[H[0]]);assert.equal(({}).c,undefined,'no prototype pollution');assert.equal(Object.getPrototypeOf(map.get(H[0])),Object.prototype);
 const keys=[H[0].toUpperCase(),H[0].slice(1),H[0]+'0','0x'+H[0].slice(2),' '+H[0].slice(1),H[0].replace(/0$/,'g'),''];
 const m2=parseCategories(file(Object.fromEntries(keys.map(k=>[k,good]))),undefined);assert.equal(m2.size,0,'only lowercase 64-hex keys are accepted');
 const bad=[
  ['unknown category',{...good,c:'nope'}],['unclassified is not a category',{...good,c:'unclassified'}],['category number',{...good,c:3}],['no category',(({c,...r})=>r)(good)],
  ['unknown energy',{...good,e:'loud'}],['energy number',{...good,e:1}],['no energy',(({e,...r})=>r)(good)],
  ['busyness 0',{...good,b:0}],['busyness 6',{...good,b:6}],['busyness 2.5',{...good,b:2.5}],['busyness string',{...good,b:'3'}],['busyness NaN',{...good,b:NaN}],['no busyness',(({b,...r})=>r)(good)],
  ['unknown fidelity',{...good,f:'half'}],['no fidelity',(({f,...r})=>r)(good)],['tags not an array',{...good,t:'glitch-digital'}],['tags object',{...good,t:{}}],
  ['null entry',null],['array entry',[]],['string entry',JSON.stringify(good)],['number entry',7],
 ];
 for(const [name,entry] of bad)assert.equal(parseCategories(file({[H[0]]:entry}),catalogOf([H[0]])).get(H[0]),UNCLASSIFIED_TAXON,`${name}: dropped, the preset stays unclassified`);
 // the other entries of the same file survive a bad neighbour
 const mixed=parseCategories(file({[H[0]]:bad[0][1],[H[1]]:good}),catalogOf([H[0],H[1]]));assert.deepEqual(mixed.get(H[1]),good);assert.equal(mixed.get(H[0]),UNCLASSIFIED_TAXON);
 // every enum member and every category id is accepted
 for(const e of ['calm','steady','driving','intense'])for(const b of [1,2,3,4,5])assert.equal(parseCategories(file({[H[0]]:{...good,e,b}}),undefined).get(H[0]).e,e);
 for(const c of TAXONOMY)assert.equal(parseCategories(file({[H[0]]:{c:c.id,t:[],e:'calm',b:1,f:'full'}}),undefined).get(H[0]).c,c.id);
 // tags: known, distinct, not the primary, capped at 2; junk skipped
 const tagged=t=>parseCategories(file({[H[0]]:{...good,t}}),undefined).get(H[0]).t;
 assert.deepEqual(tagged(['glitch-digital','glitch-digital','starfield','mixed']),['glitch-digital','starfield'],'de-duplicated and capped at 2');
 assert.deepEqual(tagged(['particles','nope',3,null,'minimal']),['minimal'],'the primary, unknown and non-string tags are dropped');
 assert.deepEqual(tagged([]),[]);assert.deepEqual(tagged(Array(1000).fill('mixed').concat(['minimal'])),['mixed'],'a huge tag list is scanned only briefly');
 assert.deepEqual(parseCategories(file({[H[0]]:(({t,...r})=>r)(good)}),undefined).get(H[0]).t,[],'missing tags default to none');
 // optional fields are sanitised, not fatal
 const opt=o=>parseCategories(file({[H[0]]:{...good,...o}}),undefined).get(H[0]);
 assert.equal(opt({a:'x'.repeat(80)}).a.length,80);assert.equal('a' in opt({a:'x'.repeat(81)}),false);assert.equal('a' in opt({a:''}),false);assert.equal('a' in opt({a:'bad\u0007name'}),false);assert.equal('a' in opt({a:'line\u2028break'}),false);assert.equal('a' in opt({a:5}),false);
 for(const s of ['s','j','sj','o'])assert.equal(opt({s}).s,s);assert.equal('s' in opt({s:'x'}),false);assert.equal('s' in opt({s:1}),false);
 assert.equal(opt({k:0}).k,0);assert.equal(opt({k:1}).k,1);for(const k of [-.1,1.1,NaN,Infinity,'0.5',null])assert.equal('k' in opt({k}),false,`k=${k}`);
 assert.equal(opt({zzz:1}).zzz,undefined,'unknown keys are dropped');assert.deepEqual(Object.keys(opt({zzz:1,x:{}})).sort(),['a','b','c','e','f','k','s','t']);
 // unicode authors are fine
 assert.equal(opt({a:'Zoe Andre \u00b7 O\u2019Neil'}).a,'Zoe Andre \u00b7 O\u2019Neil');
}

// ---- 4. size limits ----
{
 const big={};for(let i=0;i<50000;i++)big[hex(i+1)]=good;
 const ok=parseCategories(file(big),undefined);assert.equal(ok.size,50000,'50,000 entries are allowed');
 big[hex(50001)]=good;
 assert.equal(parseCategories(file(big),undefined),null,'more than 50,000 entries is refused');
 const many=Array.from({length:60000},(_,i)=>({sha256:hex(i+1)}));
 assert.equal(parseCategories(file({[hex(1)]:good}),many).size,60000,'the catalog size is not the parser\'s limit');
}

// ---- 5. loader against a stubbed fetch ----
const realFetch=globalThis.fetch,realDoc=globalThis.document;
const restore=Object.fromEntries(['log','info','warn','error','debug'].map(k=>[k,console[k]]));
const say=console.log.bind(console);
const logs=[];for(const k of Object.keys(restore))console[k]=(...a)=>logs.push([k,a]);   // the loaders must be silent; restored for the final line
const calls=[];
function stub(handler){calls.length=0;globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return handler(String(url),init);};}
const json200=body=>new Response(typeof body==='string'?body:JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
{
 const BASE='http://host.test/app/index.html';
 stub(()=>json200(file({[H[0]]:good})));
 const m=await fetchLocalCategories(BASE);
 assert.ok(m instanceof Map&&m.size===1);assert.deepEqual(m.get(H[0]),good);
 assert.equal(calls.length,1);assert.equal(calls[0].url,'http://host.test/app/avs%20presets/catalog/categories.json','same collection root as the catalog loader');assert.equal(calls[0].init.cache,'no-store');
 // joined when the catalog is passed
 const joined=await fetchLocalCategories(BASE,catalogOf([H[0],H[1]]));assert.equal(joined.get(H[1]),UNCLASSIFIED_TAXON);
 // the page base is used when no base is given
 globalThis.document={baseURI:'http://doc.test/dir/page.html'};stub(()=>json200(file({})));await fetchLocalCategories();assert.equal(calls[0].url,'http://doc.test/dir/avs%20presets/catalog/categories.json');
 delete globalThis.document;stub(()=>json200(file({})));await fetchLocalCategories();assert.equal(calls[0].url,'http://127.0.0.1/avs%20presets/catalog/categories.json');
 // every failure -> null, once, silently
 const failures={
  '404':()=>new Response('missing',{status:404}),'500':()=>new Response('boom',{status:500}),'network error':()=>{throw new TypeError('Failed to fetch');},
  'html page':()=>json200('<!doctype html><title>index</title>'),'truncated json':()=>json200('{"format":"aaavs-categories","version":1,"entries":{'),'empty body':()=>json200(''),
  'wrong version':()=>json200(file({[H[0]]:good},{version:2})),'wrong taxonomy':()=>json200(file({},{taxonomy:{id:'aaavs-style',version:9}})),'array':()=>json200('[]'),'null':()=>json200('null'),
  'declared oversize':()=>({ok:true,status:200,headers:{get:()=>String(40*1024*1024)},body:{cancel(){}}}),
  'streamed oversize':()=>new Response(new Uint8Array(33*1024*1024)),
  'no body':()=>({ok:true,status:200,headers:{get:()=>null},body:null}),
 };
 for(const [name,handler] of Object.entries(failures)){
  stub(handler);let threw=false,result;try{result=await fetchLocalCategories(BASE);}catch{threw=true;}
  assert.equal(threw,false,`${name}: never throws`);assert.equal(result,null,`${name}: null`);assert.equal(calls.length,1,`${name}: not retried`);
 }
 // timeout
 stub(()=>new Promise(()=>{}));const t0=Date.now();assert.equal(await fetchLocalCategories(BASE,undefined,{timeoutMs:30}),null);assert.ok(Date.now()-t0<2000,'a stalled read gives up');
 // a fetch that is missing altogether
 delete globalThis.fetch;assert.equal(await fetchLocalCategories(BASE),null);
 // bad base URIs do not throw
 stub(()=>json200(file({})));assert.equal(await fetchLocalCategories('not a url'),null);
 assert.deepEqual(logs,[],'the loader logs nothing (no path is ever written to a console)');
}

// ---- 6. local HUD title overlay: the pure parser ----
const titlesFile=(titles,over={})=>({format:'aaavs-hud-titles',version:1,titles,...over});
{
 const ok=parseHudTitles(titlesFile({'showcase-duel-01':'Sample Arcade Title: Part II','p-neogeo-dock-03':'  Sample Cabinet \u00b7 Arcade  ','anime.mecha_02':'\u30b5\u30f3\u30d7\u30eb','x':"Caf\u00e9 Racer's HUD"}));
 assert.ok(ok instanceof Map);
 assert.deepEqual([...ok.entries()],[['showcase-duel-01','Sample Arcade Title: Part II'],['p-neogeo-dock-03','Sample Cabinet \u00b7 Arcade'],['anime.mecha_02','\u30b5\u30f3\u30d7\u30eb'],['x',"Caf\u00e9 Racer's HUD"]]);
 assert.equal(parseHudTitles(titlesFile({})).size,0,'an empty overlay is valid');
 for(const [name,json] of [['format',titlesFile({},{format:'aaavs-categories'})],['no format',{version:1,titles:{}}],['version 2',titlesFile({},{version:2})],['version string',titlesFile({},{version:'1'})],
  ['no titles',{format:'aaavs-hud-titles',version:1}],['titles array',titlesFile([])],['titles null',titlesFile(null)],['titles string',titlesFile('x')],['null',null],['undefined',undefined],['array',[]],['string','{}'],['number',1]])
  assert.equal(parseHudTitles(json),null,name);
 assert.equal(parseHudTitles(Object.create({format:'aaavs-hud-titles',version:1,titles:{}})),null,'inherited members are not read');
 assert.equal(parseHudTitles(new Proxy({},{get(){throw new Error('boom');},ownKeys(){throw new Error('boom');},getOwnPropertyDescriptor(){throw new Error('boom');}})),null);
 // limits
 const many={};for(let i=0;i<20000;i++)many[`s${i}`]='T';
 assert.equal(parseHudTitles(titlesFile(many)).size,20000,'20,000 titles are allowed');many.extra='T';assert.equal(parseHudTitles(titlesFile(many)),null,'more than 20,000 is refused');
 // ids
 const idCases={'ok-id_1.a':true,'A':true,'0':true,['a'.repeat(96)]:true,['a'.repeat(97)]:false,'':false,'-x':false,'.x':false,'_x':false,'a b':false,'a/b':false,'a\\b':false,'a:b':false,'\u00e9':false,'a\u0000b':false,'C:':false,'..':false};
 for(const [id,accepted] of Object.entries(idCases))assert.equal(parseHudTitles(titlesFile({[id]:'Title'})).has(id),accepted,`id ${JSON.stringify(id.slice(0,12))}`);
 const proto=parseHudTitles(JSON.parse('{"format":"aaavs-hud-titles","version":1,"titles":{"__proto__":"Evil","constructor":"Evil","ok":"Fine"}}'));
 assert.deepEqual([...proto.keys()],['constructor','ok'],'ids like constructor are plain map keys');
 assert.equal(proto.has('__proto__'),false,'__proto__ is not an accepted id');assert.equal(({}).polluted,undefined);
 // titles
 const t=title=>parseHudTitles(titlesFile({id1:title})).get('id1');
 assert.equal(t('a'.repeat(120)).length,120);assert.equal(t('a'.repeat(121)),undefined);assert.equal(t(' '.repeat(3)+'a'.repeat(120)+' '.repeat(3)).length,120,'trimming happens before the length limit');assert.equal(t(' '.repeat(500)+'x'),undefined,'absurd padding is refused');
 for(const [name,v] of [['empty',''],['spaces','   '],['number',5],['null',null],['object',{}],['array',['x']],['newline','a\nb'],['tab','a\tb'],['NUL','a\u0000b'],['DEL','a\u007fb'],['C1','a\u0085b'],['line separator','a\u2028b'],['paragraph separator','a\u2029b'],
  ['RLO','a\u202eb'],['LRI','a\u2066b'],['isolate pop','a\u2069b'],['RLM','a\u200fb'],['zero width space','a\u200bb'],['ZWJ','a\u200db'],['word joiner','a\u2060b'],['BOM','a\ufeffb'],['ALM','a\u061cb'],['angle bracket','<img src=x>'],['closing bracket','a>b']])
  assert.equal(t(v),undefined,`title ${name} is dropped`);
 assert.equal(t('Caf\u00e9 Racer'),'Caf\u00e9 Racer');assert.equal(t('Arcade \u00b7 Fighting'),'Arcade \u00b7 Fighting');assert.equal(t('Sample Film (1995) - "Extended Cut"'),'Sample Film (1995) - "Extended Cut"');assert.equal(t('\u30b5\u30f3\u30d7\u30eb\u30fb\u30bf\u30a4\u30c8\u30eb'),'\u30b5\u30f3\u30d7\u30eb\u30fb\u30bf\u30a4\u30c8\u30eb');
 // one bad entry never spoils the others
 const mixed=parseHudTitles(titlesFile({good1:'Good',bad:'a\nb',good2:'Also good','bad id':'x'}));assert.deepEqual([...mixed.keys()],['good1','good2']);
 const before=JSON.stringify(titlesFile({a:' T '}));const input=JSON.parse(before);parseHudTitles(input);assert.equal(JSON.stringify(input),before,'the input is not mutated');
}

// ---- 7. local HUD title overlay: the loader ----
{
 const BASE='http://host.test/app/index.html';
 stub(()=>json200(titlesFile({a1:'One',b2:' Two '})));
 const m=await fetchLocalHudTitles(BASE);
 assert.deepEqual([...m.entries()],[['a1','One'],['b2','Two']]);
 assert.equal(calls.length,1);assert.equal(calls[0].url,'http://host.test/app/avs%20presets/catalog/hud-titles.json');assert.equal(calls[0].init.cache,'no-store');
 // a UTF-8 BOM is tolerated
 stub(()=>new Response(new Uint8Array([0xef,0xbb,0xbf,...Buffer.from(JSON.stringify(titlesFile({a1:'One'})))])));assert.equal((await fetchLocalHudTitles(BASE)).get('a1'),'One');
 // just under the byte limit is fine (padding inside a string value is dropped by the title limits, so pad with whitespace)
 const pad=JSON.stringify(titlesFile({a1:'One'}))+' '.repeat(4*1024*1024-100);stub(()=>new Response(pad));assert.equal((await fetchLocalHudTitles(BASE)).size,1);
 globalThis.document={baseURI:'http://doc.test/dir/page.html'};stub(()=>json200(titlesFile({})));await fetchLocalHudTitles();assert.equal(calls[0].url,'http://doc.test/dir/avs%20presets/catalog/hud-titles.json');delete globalThis.document;
 const failures={
  '404':()=>new Response('x',{status:404}),'403':()=>new Response('x',{status:403}),'network error':()=>{throw new TypeError('Failed to fetch');},
  'html':()=>json200('<html></html>'),'truncated':()=>json200('{"format":"aaavs-hud-titles",'),'empty':()=>json200(''),'wrong format':()=>json200(titlesFile({a1:'One'},{format:'x'})),'wrong version':()=>json200(titlesFile({a1:'One'},{version:2})),
  'array':()=>json200('[]'),'null':()=>json200('null'),
  'declared oversize':()=>({ok:true,status:200,headers:{get:()=>String(5*1024*1024)},body:{cancel(){}}}),
  'streamed oversize':()=>new Response(new Uint8Array(4*1024*1024+10)),
  'invalid utf-8':()=>new Response(new Uint8Array([0x7b,0xff,0xfe,0x7d])),
  'too many titles':()=>json200(titlesFile(Object.fromEntries(Array.from({length:20001},(_,i)=>[`s${i}`,'T'])))),
 };
 for(const [name,handler] of Object.entries(failures)){
  stub(handler);let threw=false,result;try{result=await fetchLocalHudTitles(BASE);}catch{threw=true;}
  assert.equal(threw,false,`${name}: never throws`);assert.equal(result,null,`${name}: null`);assert.equal(calls.length,1,`${name}: not retried`);
 }
 stub(()=>new Promise(()=>{}));assert.equal(await fetchLocalHudTitles(BASE,{timeoutMs:30}),null);
 delete globalThis.fetch;assert.equal(await fetchLocalHudTitles(BASE),null);
 stub(()=>json200(titlesFile({})));assert.equal(await fetchLocalHudTitles('not a url'),null);
 assert.deepEqual(logs,[],'no console output');
}
globalThis.fetch=realFetch;if(realDoc===undefined)delete globalThis.document;else globalThis.document=realDoc;
Object.assign(console,restore);

// ---- 8. hygiene: ASCII source, no private paths or logging, public names only ----
{
 const src=readFileSync('src/avs/preset-categories.ts','utf8');
 assert.ok(!/[^\x00-\x7f]/.test(src),'the source is ASCII (escapes, not literal characters, for the title filters)');
 for(const banned of ['console.','localStorage','sessionStorage','Math.random','Date.now','XMLHttpRequest','/Users/','@'])assert.ok(!src.includes(banned),`preset-categories.ts must not contain ${banned}`);
 assert.ok(!/\b[A-Za-z]:\\/.test(src),'preset-categories.ts must not contain a drive-letter path');
 assert.match(src,/from '\.\/local-assets\.ts'/);
 for(const name of ['TAXONOMY','TAXONOMY_VERSION','parseCategories','fetchLocalCategories','parseHudTitles','fetchLocalHudTitles','UNCLASSIFIED_ID','isClassified'])assert.ok(name in M,`export ${name}`);
}
say('preset-categories: all checks passed');
