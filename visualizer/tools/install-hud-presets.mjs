// Local installation is explicit. Tests call this only with temporary collections.
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, isInside, noLinks } from './check-hud-kits.mjs';
import { hudSchema, checkGenerated } from './build-hud-packs.mjs';
import { PACK_LABELS, slug } from './hud-taxonomy.mjs';
const defaultSource=fileURLToPath(new URL('../hud-presets/',import.meta.url));
function reparseGuard(target){
  if(process.platform!=='win32')return;
  const script="$ErrorActionPreference='Stop'\n$current=$env:AAAVS_HUD_TARGET\nwhile($current){if(Test-Path -LiteralPath $current){if((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){exit 42}};$current=[IO.Path]::GetDirectoryName($current)}\nif(Test-Path -LiteralPath $env:AAAVS_HUD_TARGET){if(Get-ChildItem -LiteralPath $env:AAAVS_HUD_TARGET -Recurse -Force -Attributes ReparsePoint | Select-Object -First 1){exit 42}}";
  try{execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:{...process.env,AAAVS_HUD_TARGET:target},stdio:'pipe',windowsHide:true});}catch(e){throw Error(e.status===42?'Linked collection paths and reparse points are refused':'Cannot verify Windows collection path attributes');}
}
function walk(dir,suffix){noLinks(dir);return readdirSync(dir,{withFileTypes:true}).flatMap(e=>{if(e.isSymbolicLink())throw Error('Linked pack/collection paths are refused');const p=path.join(dir,e.name);return e.isDirectory()?walk(p,suffix):e.isFile()&&(!suffix||e.name.endsWith(suffix))?[p]:[];});}
function load(file,field){noLinks(file);if(!existsSync(file))return {[field]:[]};if(lstatSync(file).size>32*1024*1024)throw Error('Oversized catalog');const v=JSON.parse(readFileSync(file,'utf8'));if(!v||typeof v!=='object'||!Array.isArray(v[field]))throw Error('Invalid existing catalog');return v;}
export function atomicHudJson(file,value,{write=writeFileSync,sync=fsyncSync,rename=renameSync}={}){const bytes=JSON.stringify(value,null,2)+'\n';noLinks(file);if(existsSync(file)&&readFileSync(file,'utf8')===bytes)return;const tmp=file+'.'+randomUUID()+'.writing',fd=openSync(tmp,'wx',0o600);try{try{write(fd,bytes);sync(fd);}finally{closeSync(fd);}rename(tmp,file);}finally{if(existsSync(tmp))unlinkSync(tmp);}}
/** Temporaries this installer creates next to a new preset; only these are ever cleaned up. */
const PUBLISH_TEMP=/^HUD .+\.hud\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.writing$/;
/**
 * Publish a NEW preset file: the bytes go to a flushed, exclusive temporary, then a no-clobber hard link makes the final name appear
 * complete or not at all. An interrupted write therefore never leaves a final-path file that blocks a retry, and a destination that
 * appeared in the meantime is never overwritten (identical bytes are accepted). Volumes without hard links fall back to an existence
 * check and an atomic rename under the install lock. `io` exists for fault injection in the CPU check.
 */
export function publishNewFile(file,bytes,{write=writeFileSync,sync=fsyncSync,link=linkSync,rename=renameSync,unlink=unlinkSync}={}){
  noLinks(file);const tmp=file+'.'+randomUUID()+'.writing',fd=openSync(tmp,'wx',0o600);
  const occupied=()=>{if(!lstatSync(file).isFile()||hash(readFileSync(file))!==hash(bytes))throw Error('HUD destination occupied by different content');};
  try{
    try{write(fd,bytes);sync(fd);}finally{closeSync(fd);}
    try{link(tmp,file);}
    catch(error){
      if(error?.code==='EEXIST'){occupied();return;}
      if(!['EPERM','ENOTSUP','ENOSYS','EXDEV','EINVAL'].includes(error?.code))throw error;
      if(existsSync(file)){occupied();return;}
      rename(tmp,file);
    }
  }finally{if(existsSync(tmp))unlink(tmp);}
}
function destination(root,relative){if(typeof relative!=='string'||!relative.startsWith('presets/unique/')||!relative.endsWith('.hud')||/[\\:%\0]/.test(relative)||relative.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('Invalid HUD preset path');const result=path.join(root,...relative.split('/'));noLinks(result);return result;}
function overlay(file){if(!file)return null;noLinks(file);if(lstatSync(file).size>2*1024*1024)throw Error('Oversized local title overlay');const value=JSON.parse(readFileSync(file,'utf8'));if(value?.format!=='aaavs-hud-titles'||value.version!==1||!value.titles||typeof value.titles!=='object'||Array.isArray(value.titles))throw Error('Invalid local title overlay');const titles={};for(const [id,title] of Object.entries(value.titles)){if(!/^[a-z0-9][a-z0-9-]{1,47}$/.test(id)||typeof title!=='string'||title.length<1||title.length>240||/[\x00-\x1f\x7f]/.test(title))throw Error('Invalid local title');titles[id]=title;}return titles;}
export async function installHudPresets(target,{source=defaultSource,localOverlay,supersede=false,io}={}){
  if(typeof target!=='string'||!path.isAbsolute(target))throw Error('Supply an absolute collection directory');const root=path.resolve(target),sourceRoot=path.resolve(source);if(isInside(sourceRoot,root)||isInside(root,sourceRoot))throw Error('Source packs and target collection must be separate');
  noLinks(root);noLinks(sourceRoot);reparseGuard(root);if(existsSync(root))walk(root);await checkGenerated(sourceRoot);
  const schema=await hudSchema(),titles=overlay(localOverlay),registryFile=path.join(sourceRoot,'_registry.json'),registry=existsSync(registryFile)?JSON.parse(readFileSync(registryFile,'utf8')):null,metadata=new Map(Object.values(registry?.entries??{}).filter(e=>e.active).map(e=>[e.id,e]));
  const inactive=new Set(Object.values(registry?.entries??{}).filter(e=>!e.active).map(e=>e.id));
  const scenes=walk(sourceRoot,'.hud').map(file=>{const bytes=readFileSync(file),m=schema.parseHudManifest(JSON.parse(bytes.toString('utf8'))),meta=metadata.get(m.id),label=PACK_LABELS.find(p=>slug(p)===m.pack);if(!label)throw Error('Unknown HUD pack label');const folder=meta?.folder??`${label}/${m.title}`;if(!folder.startsWith(label+'/')||folder.split('/').length>6||folder.split('/').some(p=>!p||p.length>80||/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(p)))throw Error('Invalid HUD folder hint');return {m,bytes,sha256:hash(bytes),label,folder,order:meta?.order??0};}).filter(scene=>!inactive.has(scene.m.id));
  if(new Set(scenes.map(s=>s.m.id)).size!==scenes.length)throw Error('Duplicate source HUD id');
  mkdirSync(path.join(root,'catalog'),{recursive:true});mkdirSync(path.join(root,'presets','unique'),{recursive:true});
  // Share the already-deployed NERV/service transaction mutex. A separate HUD mutex would not protect existing hosts.
  const lock=path.join(root,'catalog','nerv-install.lock');noLinks(lock);const fd=openSync(lock,'wx',0o600);let ratingFd;
  try{
    // Temporaries left by an interrupted earlier run are this installer's own and never a destination; clear them under the lock.
    const unique=path.join(root,'presets','unique');for(const name of readdirSync(unique))if(PUBLISH_TEMP.test(name)){const stale=path.join(unique,name);noLinks(stale);if(lstatSync(stale).isFile())unlinkSync(stale);}
    const ratingPath=path.join(root,'catalog','ratings.lock');noLinks(ratingPath);ratingFd=openSync(ratingPath,'a+');const catalogFile=path.join(root,'catalog','presets.json'),validationFile=path.join(root,'catalog','parser-validation.json'),catalog=load(catalogFile,'presets'),validation=load(validationFile,'results'),byHash=new Map(),byId=new Map();
    for(const entry of catalog.presets){if(!entry||!/^([a-f0-9]{64})$/i.test(entry.sha256)||byHash.has(entry.sha256.toLowerCase()))throw Error('Invalid/duplicate existing identity');byHash.set(entry.sha256.toLowerCase(),entry);if(entry.kind==='hud'){destination(root,entry.canonical_path);if(entry.hud?.id&&!entry.superseded)byId.set(entry.hud.id,entry);}}
    let added=0,superseded=0;const writes=[];
    for(const scene of scenes){const {m,sha256,bytes,label,folder,order}=scene;let entry=byHash.get(sha256);const previous=byId.get(m.id);
      if(previous&&previous.sha256!==sha256&&!supersede)throw Error('Changed HUD id requires --supersede');
      if(!entry){entry={sha256,bytes:bytes.length,kind:'hud',canonical_path:`presets/unique/HUD ${m.id}${previous?' - '+sha256.slice(0,12):''}.hud`,display_name:m.title,folder,hud:{id:m.id,pack:label,family:m.family,tags:m.tags??[],tier:m.meta?.tier??'auto',order,canvas:m.canvas}};if(previous&&previous.sha256!==sha256){for(const key of ['rating','notWorking'])if(Object.hasOwn(previous,key))entry[key]=previous[key];previous.superseded=true;superseded++;}catalog.presets.push(entry);byHash.set(sha256,entry);byId.set(m.id,entry);added++;}
      else if(entry.bytes!==bytes.length||entry.kind!=='hud'||entry.hud?.id!==m.id)throw Error('Conflicting existing manifest metadata');
      const dest=destination(root,entry.canonical_path);if(existsSync(dest)){if(!lstatSync(dest).isFile()||hash(readFileSync(dest))!==sha256)throw Error('HUD destination occupied by different content');}else writes.push([dest,bytes]);
      const matches=validation.results.filter(r=>r?.sha256?.toLowerCase()===sha256);if(matches.length>1)throw Error('Duplicate parser identity');if(!matches.length)validation.results.push({sha256,canonical_path:entry.canonical_path,status:'unknown',kind:'hud'});else Object.assign(matches[0],{canonical_path:entry.canonical_path,status:'unknown',kind:'hud'});
    }
    // Preflight finishes before any preset/catalog write. New presets publish complete or not at all, so an interrupted run retries cleanly by hash.
    for(const [file,bytes] of writes)publishNewFile(file,bytes,io);
    if(titles){const titleFile=path.join(root,'catalog','hud-titles.json');noLinks(titleFile);let prior={};if(existsSync(titleFile))prior=overlay(titleFile);atomicHudJson(titleFile,{format:'aaavs-hud-titles',version:1,titles:{...prior,...titles}});}
    atomicHudJson(validationFile,validation);atomicHudJson(catalogFile,catalog);return {added,superseded,scenes:scenes.length,total:catalog.presets.length};
  }finally{if(ratingFd!==undefined)closeSync(ratingFd);closeSync(fd);unlinkSync(lock);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const args=process.argv.slice(2),target=args.shift(),options={};for(let i=0;i<args.length;i++){if(args[i]==='--supersede')options.supersede=true;else if(args[i]==='--source')options.source=args[++i];else if(args[i]==='--local-overlay'||args[i]==='--titles')options.localOverlay=args[++i];else throw Error('Unknown installer option');}console.log(JSON.stringify(await installHudPresets(target,options)));}catch(e){console.error(e.message);process.exitCode=1;}
}
