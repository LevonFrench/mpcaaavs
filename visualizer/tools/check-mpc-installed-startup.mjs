// Check the shipped bundle/catalog/asset path together without a browser or GPU.
// The worker boundary is recorded: this proves initialization inputs, not rendering.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

const directory=process.argv[2];
if(!directory||!path.isAbsolute(directory))throw Error('Pass the absolute installed visualizer directory');
const root=path.resolve(directory),origin='https://aaavs.invalid';
const source=await readFile(path.join(root,'dist/mpc-host.js'),'utf8');
const messages=[],requests=[],nodes=new Map(),workers=[];
let pagehide,finish;
const completed=new Promise(resolve=>finish=resolve);
globalThis.fetch=async input=>{
 const url=new URL(String(input));assert.equal(url.origin,origin,'assets must stay local');
 const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
 assert.ok(file.startsWith(root+path.sep),'asset escaped installed directory');requests.push(file);
 try{return new Response(await readFile(file));}catch(error){if(error.code==='ENOENT')return new Response(null,{status:404});throw error;}
};
const context={save(){},restore(){},drawImage(){},getImageData(){return {data:new Uint8ClampedArray(256*144*4)};}};
const canvas=()=>({width:640,height:360,clientWidth:640,clientHeight:360,getContext(){return {...context,canvas:this};}});
globalThis.document={baseURI:`${origin}/mpc.html`,hidden:false,body:{append(){},classList:{add(){},remove(){}}},createElement:()=>canvas(),querySelector(id){if(!nodes.has(id))nodes.set(id,id==='#visualizer'?canvas():{textContent:''});return nodes.get(id);},addEventListener(){}};
globalThis.OffscreenCanvas=class{constructor(){Object.assign(this,canvas());}};
globalThis.window={chrome:{webview:{postMessage(value){messages.push(value);if(value==='error'||value==='bootstrap-error')finish('failed');},addEventListener(){}}},setTimeout(fn,delay){const id=setTimeout(fn,delay);id.unref();return id;},addEventListener(event,fn){if(event==='pagehide')pagehide=fn;}};
globalThis.requestAnimationFrame=()=>0;globalThis.devicePixelRatio=1;
globalThis.Worker=class{
 constructor(url){this.url=String(url);this.requests=[];workers.push(this);}
 postMessage(request){
  this.requests.push(request);
  if(request.type==='load')queueMicrotask(()=>this.onmessage({data:{type:'ready',generation:request.generation,unsupported:0}}));
  if(request.type==='render')queueMicrotask(()=>{this.onmessage({data:{type:'frame',generation:request.generation,bitmap:{width:640,height:360,close(){}}}});finish('ready');});
 }
 terminate(){}
};
const timeout=setTimeout(()=>finish('timeout'),15000);
try{
 // Preserve the installed bundle; only give its worker URL a meaningful base in Node.
 const module=source.replaceAll('import.meta.url',JSON.stringify(`${origin}/dist/mpc-host.js`));
 await import(`data:text/javascript;base64,${Buffer.from(module).toString('base64')}`);
 const outcome=await completed;
 assert.equal(outcome,'ready',`${nodes.get('#preset')?.textContent} | ${nodes.get('#status')?.textContent}`);
 assert.ok(messages.includes('host-ready')&&messages.includes('ready'));
 assert.equal(workers.length,1);assert.ok(workers[0].url.endsWith('.worker.js'));
 const load=workers[0].requests.find(r=>r.type==='load');
 assert.ok(load.preset.byteLength>0);assert.ok(workers[0].requests.some(r=>r.type==='render'));
 console.log(`Installed startup PASS: ${nodes.get('#preset').textContent}; ${load.preset.byteLength} preset bytes, ${load.bitmaps?.length??0} bitmap aliases, ${requests.length} local asset reads. Worker graphics deliberately not executed.`);
}finally{clearTimeout(timeout);pagehide?.();}
