import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
// CPU check of src/render-resolution.ts (docs/design/RESOLUTION-PIPELINE.md sections 5 and 8, CONTRACT 2.3.1). No browser, GPU, server or
// renderer: esbuild bundles the pure policy module and the real Studio presentation helpers it delegates to, and the assertions run in Node.
async function load(path){const r=await build({entryPoints:[path],bundle:true,format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);}
const R=await load('src/render-resolution.ts'),P=await load('src/avs-presentation.ts');
let seed=0x5eed1234;const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
const pick=list=>list[Math.floor(rnd()*list.length)];
let assertions=0;const ok=(cond,label)=>{assertions++;assert.ok(cond,label);};
const near=(a,b,eps,label)=>{assertions++;assert.ok(Math.abs(a-b)<=eps,`${label}: ${a} vs ${b}`);};

// ---- 0. static shape: pure module, imports only the Studio helpers, frozen public constants
{
 const text=readFileSync('src/render-resolution.ts','utf8');
 const imports=[...text.matchAll(/^import\s[^;]*from\s+'([^']+)'/gm)].map(m=>m[1]);
 assert.deepEqual(imports,['./avs-presentation.ts'],'render-resolution.ts imports only avs-presentation.ts');
 for(const banned of ['Date.now','Math.random','performance.now','document.','window.','localStorage','setTimeout','requestAnimationFrame'])assert.ok(!text.includes(banned),`pure module must not use ${banned}`);
 assert.deepEqual(R.NERV_DESIGN,{width:960,height:540});assert.ok(Object.isFrozen(R.NERV_DESIGN));
 assert.deepEqual(Object.keys(R.TIERS),['performance','balanced','high','native']);
 assert.deepEqual(JSON.parse(JSON.stringify(R.TIERS)),{performance:{maxEdge:1280,maxPixels:921600},balanced:{maxEdge:1920,maxPixels:2073600},high:{maxEdge:2560,maxPixels:3686400},native:{maxEdge:3840,maxPixels:8294400}});
 ok(Object.isFrozen(R.TIERS)&&Object.values(R.TIERS).every(Object.isFrozen),'TIERS frozen');
 assert.equal(R.AUTO_CEILING,'high');assert.equal(R.HARD_MAX_EDGE,4096);assert.equal(R.HARD_MAX_PIXELS,3840*2160);assert.equal(R.MIN_EDGE,64);
 assert.deepEqual({...R.LEGACY_AVS},{width:640,maxHeight:640,presentMaxWidth:1920,presentMaxHeight:1080});
 assert.deepEqual({...R.DEFAULT_DISPLAY},{quality:'auto',avsResolution:'classic',pixelArt:'auto'});assert.ok(Object.isFrozen(R.DEFAULT_DISPLAY));
 assert.deepEqual([...R.FIXED_TIERS],['performance','balanced','high','native']);
 const expectedExports=['AUTO_CEILING','DEFAULT_DISPLAY','FIXED_TIERS','GOVERNOR_BAN_MS','HARD_MAX_EDGE','HARD_MAX_PIXELS','LEGACY_AVS','MIN_EDGE','NERV_DESIGN','QualityGovernor','TIERS','applyDesignTransform','describeResolved','fitWithin','resolveRender','snapBaseline','snapSpan','snapStroke','strokePx','surfaceMetrics','transitionSurface'];
 assert.deepEqual(Object.keys(R).sort(),expectedExports,'public surface: add new exports to this pin');
}

// ---- 1. AVS classic parity: bit-identical to the rule mpc-host.ts shipped before this work (render() line 177, frame() lines 353-354)
function shipped(clientWidth,clientHeight,devicePixelRatio){
 const width=640,height=Math.max(64,Math.min(640,Math.round(width*clientHeight/Math.max(1,clientWidth))));
 const scale=Math.min(devicePixelRatio||1,1920/Math.max(1,clientWidth),1080/Math.max(1,clientHeight));
 return {render:{width,height},canvas:{width:Math.max(1,Math.round(clientWidth*scale)),height:Math.max(1,Math.round(clientHeight*scale))}};
}
const classic=(cssWidth,cssHeight,dpr,extra={})=>R.resolveRender({kind:'avs',cssWidth,cssHeight,dpr,tier:'auto',...extra});
let parity=0;
const parityCase=(w,h,d)=>{
 const want=shipped(w,h,d),got=classic(w,h,d);
 assert.deepStrictEqual({render:{...got.render},canvas:{...got.canvas}},want,`classic parity ${w}x${h}@${d}`);
 assert.deepStrictEqual({...got.box},{x:0,y:0,width:want.canvas.width,height:want.canvas.height});
 assert.equal(got.smoothing,'nearest');assert.equal(got.cssImageRendering,'pixelated');assert.equal(got.integerScale,null);assert.equal(got.prescale,1);assert.equal(got.metrics,null);
 parity++;
};
const dprs=[0,0.1,0.25,0.5,0.75,1,1.1,1.25,1.5,1.75,2,2.25,2.5,3,4,5,8,16,100,Infinity,NaN];
for(let n=0;n<5000;n++)parityCase(Math.floor(rnd()*4001),Math.floor(rnd()*2401),rnd()<.5?pick(dprs):rnd()*10);   // 5,000 random sizes, half with a continuous DPR
for(let n=0;n<1500;n++)parityCase(rnd()*4000,rnd()*2400,pick(dprs));                                             // fractional CSS sizes (getBoundingClientRect style)
for(let n=0;n<500;n++)parityCase(Math.floor(rnd()*60000),Math.floor(rnd()*40000),pick(dprs));                     // absurdly large views
for(const w of [0,1,2,63,64,65,320,479,480,481,640,641,1000,1279,1280,1281,1366,1600,1918,1919,1920,1921,2048,2560,3440,3840,7680])
 for(const h of [0,1,2,63,64,65,180,360,479,480,481,540,640,641,720,768,900,1000,1080,1200,1440,1600,2160,4320])
  for(const d of [1,1.25,1.5,2])parityCase(w,h,d);                                                               // the structured grid around every threshold
for(const [w,h] of [[1e308,1e308],[1e308,5],[5,1e308],[1e15,1e15]])for(const d of [1,3,Infinity])parityCase(w,h,d);
ok(parity>=7000,'classic parity case count');
// The rule reads only CSS pixels and DPR: nothing else may move a classic surface.
for(let n=0;n<300;n++){
 const w=Math.floor(rnd()*3000),h=Math.floor(rnd()*2000),d=pick([1,1.25,1.5,2]),base=classic(w,h,d);
 const varied=classic(w,h,d,{deviceWidth:Math.floor(rnd()*9000),deviceHeight:Math.floor(rnd()*6000),tier:pick(['auto','performance','native']),autoTier:'performance',
  traits:{logical:{width:100,height:100},pixelGrid:{width:320,height:180}},pixelArt:'integer',budget:{maxPixels:5000,maxBytes:1e5,surfaces:9},avs:{mode:'classic',scale:1}});
 assert.equal(varied.key,base.key,'classic ignores device size, tier, traits, pixel-art and budget');
}
// A missing or unknown avs mode is classic; a NaN DPR is the shipped `|| 1`; a negative DPR (degenerate in the shipped code) is 1 and stays finite.
for(const d of [-1,-0.5,-Infinity,-1e9])assert.equal(classic(1000,600,d).key,classic(1000,600,1).key,`negative dpr ${d}`);
assert.equal(classic(1000,600,1,{avs:{mode:'bogus'}}).key,classic(1000,600,1).key);assert.equal(classic(1000,600,NaN).key,classic(1000,600,1).key);

// ---- 2. representative displays x tiers x kinds, against literal tables (RES sections 3 and 5.2, Appendix A)
const displays={'480x480@1':[480,480,1],'1280x720@1':[1280,720,1],'1920x1080@1':[1920,1080,1],'2560x1440@1.25':[2048,1152,1.25],'3840x2160@1.5':[2560,1440,1.5]};
const nervTable={   // performance, balanced, high, native, auto -> [w,h,presentScale x1000]
 '480x480@1':[[480,480,1000],[480,480,1000],[480,480,1000],[480,480,1000],[480,480,1000]],
 '1280x720@1':[[1280,720,1000],[1280,720,1000],[1280,720,1000],[1280,720,1000],[1280,720,1000]],
 '1920x1080@1':[[1280,720,1500],[1920,1080,1000],[1920,1080,1000],[1920,1080,1000],[1920,1080,1000]],
 '2560x1440@1.25':[[1280,720,2000],[1920,1080,1333],[2560,1440,1000],[2560,1440,1000],[2560,1440,1000]],
 '3840x2160@1.5':[[1280,720,3000],[1920,1080,2000],[2560,1440,1500],[3840,2160,1000],[2560,1440,1500]],
};
const tierOrder=['performance','balanced','high','native','auto'];
for(const [name,[w,h,d]] of Object.entries(displays))tierOrder.forEach((tier,t)=>{
 for(const kind of ['nerv','hud']){
  const r=R.resolveRender({kind,cssWidth:w,cssHeight:h,dpr:d,tier}),[ew,eh,ep]=nervTable[name][t];
  assert.deepEqual([r.render.width,r.render.height],[ew,eh],`${kind} ${tier} render at ${name}`);
  assert.deepEqual([r.canvas.width,r.canvas.height],[ew,eh],'the vector canvas equals the render size');
  near(Math.round(r.presentScale*1000),ep,1,`${kind} ${tier} present ratio at ${name}`);
  assert.equal(r.smoothing,'bilinear');assert.equal(r.cssImageRendering,'auto');assert.equal(r.integerScale,null);assert.equal(r.prescale,1);
  assert.equal(r.tier,tier==='auto'?'high':tier,'auto resolves to High');
  assert.deepEqual({...r.box},{x:0,y:0,width:ew,height:eh});
 }
});
// design-canvas scale (S) column of RES 3
const sTable={'480x480@1':.5,'1280x720@1':4/3,'1920x1080@1':2,'2560x1440@1.25':8/3,'3840x2160@1.5':8/3};
for(const [name,[w,h,d]] of Object.entries(displays))near(R.resolveRender({kind:'nerv',cssWidth:w,cssHeight:h,dpr:d,tier:'auto'}).metrics.scale,sTable[name],1e-9,`S at ${name}`);
// AVS via the shipped Studio policy (Appendix A): classic / crisp / high
const avsTable={
 '480x480@1':[[640,640],[480,480,1],[480,480]],
 '1280x720@1':[[640,360],[640,360,2],[1280,720]],
 '1920x1080@1':[[640,360],[640,360,3],[1280,720]],
 '2560x1440@1.25':[[640,360],[640,360,4],[1280,720]],
 '3840x2160@1.5':[[640,360],[640,360,6],[1280,720]],
};
for(const [name,[w,h,d]] of Object.entries(displays))['classic','crisp','high'].forEach((mode,m)=>{
 const r=R.resolveRender({kind:'avs',cssWidth:w,cssHeight:h,dpr:d,tier:'auto',avs:{mode}}),[ew,eh,ek]=avsTable[name][m];
 assert.deepEqual([r.render.width,r.render.height],[ew,eh],`avs ${mode} render at ${name}`);
 if(mode==='crisp'){assert.equal(r.integerScale,ek,`avs crisp k at ${name}`);assert.equal(r.box.width,ek*ew);assert.equal(r.box.height,ek*eh);}
 else assert.equal(r.integerScale,null);
 assert.equal(r.smoothing,'nearest');assert.equal(r.cssImageRendering,'pixelated');assert.equal(r.metrics,null);
});
{const c=R.resolveRender({kind:'avs',cssWidth:2048,cssHeight:1152,dpr:1.25,tier:'auto',avs:{mode:'high'}}).canvas;assert.deepEqual([c.width,c.height],[1920,1080],'high keeps the classic present canvas (1920x1080 cap)');}

// ---- 3. crisp and high delegate to the shipped Studio functions: random displays against avs-presentation.ts itself
for(let n=0;n<800;n++){
 const w=Math.floor(320+rnd()*3800),h=Math.floor(240+rnd()*2200),d=pick([1,1.25,1.5,2]),dw=Math.round(w*d),dh=Math.round(h*d);
 const shown=R.fitWithin(dw,dh,R.HARD_MAX_EDGE,R.HARD_MAX_PIXELS);
 const crispGov=new P.AvsFrameGovernor(P.avsGovernorOptions({upscale:'pixelated',resolution:'crisp',frameRate:'display'},'worker'));
 const dims=crispGov.dimensions(shown.width,shown.height),layout=P.avsPresentationLayout('pixelated',dims.width,dims.height,shown.width,shown.height,true);
 const crisp=R.resolveRender({kind:'avs',cssWidth:w,cssHeight:h,dpr:d,tier:'auto',avs:{mode:'crisp'}});
 assert.deepEqual([crisp.render.width,crisp.render.height],[dims.width,dims.height],`crisp raster ${w}x${h}@${d}`);
 assert.deepEqual([crisp.box.x,crisp.box.y,crisp.box.width,crisp.box.height],[layout.box.left,layout.box.top,layout.box.width,layout.box.height],'crisp box is the Studio integer cover');
 assert.deepEqual([crisp.canvas.width,crisp.canvas.height],[shown.width,shown.height]);
 ok(Number.isInteger(crisp.integerScale)&&crisp.integerScale>=1&&crisp.box.width===crisp.integerScale*crisp.render.width&&crisp.box.height===crisp.integerScale*crisp.render.height,'crisp blocks are exact k x k');
 ok(crisp.box.x<=0&&crisp.box.y<=0&&crisp.box.x+crisp.box.width>=shown.width&&crisp.box.y+crisp.box.height>=shown.height,'the crisp cover covers the canvas');
 for(const [scale,quantised] of [[2,2],[1.5,1.5],[1,1],[undefined,2],[1.9,2],[1.3,1.5],[1.1,1],[NaN,2]]){
  const high=R.resolveRender({kind:'avs',cssWidth:w,cssHeight:h,dpr:d,tier:'auto',avs:{mode:'high',scale}});
  const g=new P.AvsFrameGovernor({tiers:[{scale:quantised,fps:60}],initialTier:0}),hd=g.dimensions(dw,dh);
  assert.deepEqual([high.render.width,high.render.height],[hd.width,hd.height],`high x${quantised} raster ${w}x${h}@${d}`);
  const c=shipped(w,h,d).canvas;assert.deepEqual([high.canvas.width,high.canvas.height],[c.width,c.height],'high presents on the classic canvas rule');
  ok(high.render.width*high.render.height<=Math.max(230400*4,dw*dh)&&high.render.width>=1,'high stays within twice the Studio caps');
 }
}
// The high scale at 1 is the Studio "floor classic" tier; scale 2 never renders above the display itself (a 480x480 view stays 480x480).
{const s=R.resolveRender({kind:'avs',cssWidth:480,cssHeight:480,dpr:1,tier:'auto',avs:{mode:'high',scale:2}}).render;assert.deepEqual([s.width,s.height],[480,480]);}

// ---- 4. vector kinds: invariants over random inputs
const vec=(kind,w,h,d,tier,extra={})=>R.resolveRender({kind,cssWidth:w,cssHeight:h,dpr:d,tier,...extra});
const fixed=['performance','balanced','high','native'];
for(let n=0;n<3000;n++){
 const w=Math.floor(80+rnd()*7000),h=Math.floor(80+rnd()*4500),d=pick([0.5,0.75,1,1.25,1.5,1.75,2,2.5,3,4]),dw=Math.round(w*d),dh=Math.round(h*d);
 const kind=pick(['nerv','hud']);let previousPixels=0;
 for(const tier of fixed){
  const r=vec(kind,w,h,d,tier),spec=R.TIERS[tier];
  ok(Number.isInteger(r.render.width)&&Number.isInteger(r.render.height)&&r.render.width>=64&&r.render.height>=64,'integer render size within MIN_EDGE');
  ok(Math.max(r.render.width,r.render.height)<=Math.min(spec.maxEdge,R.HARD_MAX_EDGE)&&r.render.width*r.render.height<=spec.maxPixels,`${tier} caps hold at ${dw}x${dh}`);
  ok(r.render.width*r.render.height<=R.HARD_MAX_PIXELS,'hard pixel cap');
  ok(r.render.width<=Math.max(dw,64)&&r.render.height<=Math.max(dh,64),'a vector surface never exceeds the device size');
  if(r.render.width>64&&r.render.height>64)ok(Math.abs(r.render.width*dh-r.render.height*dw)<=Math.max(dw,dh),`uniform aspect within one pixel at ${dw}x${dh}`);
  ok(r.render.width*r.render.height>=previousPixels,'pixel count is monotone across tiers');previousPixels=r.render.width*r.render.height;
  assert.equal(r.tier,tier);assert.equal(r.key,vec(kind,w,h,d,tier).key,'resolve is deterministic');
  near(r.metrics.scale,Math.min(r.render.width/960,r.render.height/540),1e-12,'metrics follow the render size');
 }
 const auto=vec(kind,w,h,d,'auto'),high=vec(kind,w,h,d,'high');
 assert.equal(auto.key,high.key,'Auto without a governor tier is High');
 for(const at of ['performance','balanced','high'])assert.equal(vec(kind,w,h,d,'auto',{autoTier:at}).key,vec(kind,w,h,d,at).key,`Auto steps to ${at}`);
 assert.equal(vec(kind,w,h,d,'auto',{autoTier:'native'}).key,high.key,'Auto never exceeds High, whatever the governor reports');
 assert.equal(vec(kind,w,h,d,'auto',{autoTier:'native'}).tier,'high');
 // an observed device box wins over css * dpr
 const observed=vec(kind,w,h,d,'native',{deviceWidth:1000,deviceHeight:600});assert.deepEqual([observed.render.width,observed.render.height],[1000,600]);
}
// budgets only shrink, never below a MIN_EDGE square, and bytes divide by the surface count
{
 const free=vec('nerv',3840,2160,1,'native'),capped=vec('nerv',3840,2160,1,'native',{budget:{maxPixels:1e6}});
 ok(capped.render.width*capped.render.height<=1e6&&capped.render.width<free.render.width,'budget.maxPixels shrinks');
 const bytes=vec('nerv',3840,2160,1,'native',{budget:{maxBytes:8*1048576,surfaces:4}});ok(bytes.render.width*bytes.render.height*4*4<=8*1048576,'budget.maxBytes / surfaces holds');
 const tiny=vec('nerv',3840,2160,1,'native',{budget:{maxBytes:1,surfaces:99}});assert.deepEqual([tiny.render.width,tiny.render.height],[64,64],'a tiny budget bottoms out at MIN_EDGE');
 const loose=vec('nerv',1280,720,1,'performance',{budget:{maxPixels:1e9}});assert.equal(loose.key,vec('nerv',1280,720,1,'performance').key,'a loose budget changes nothing');
}
// design canvas from traits; garbage falls back to NERV_DESIGN
{
 const hudLogical=vec('hud',1280,720,1,'auto',{traits:{logical:{width:640,height:360}}});near(hudLogical.metrics.scale,2,1e-12,'HUD design canvas 640x360 at 1280x720');
 for(const logical of [{width:0,height:10},{width:-5,height:5},{width:NaN,height:1},undefined])assert.equal(vec('hud',1280,720,1,'auto',{traits:{logical}}).metrics.logicalWidth,960);
 assert.notEqual(hudLogical.key,vec('hud',1280,720,1,'auto').key,'the design canvas is part of the identity');
}
// NERV never takes the pixel-art path
assert.equal(vec('nerv',1920,1080,1,'auto',{traits:{pixelGrid:{width:320,height:180}}}).smoothing,'bilinear');

// ---- 5. pixel-art integer rule (RES 5.4) against the Appendix A table, then properties over a grid list x display list
const gridTable={   // display: [w,h,dpr] -> per grid [smoothing, k or prescale, boxW, boxH]
 '1280x720':[1280,720,[['nearest',4,1280,720],['sharp-bilinear',3,823,720],['nearest',3,1152,672],['sharp-bilinear',3,960,720]]],
 '1920x1080':[1920,1080,[['nearest',6,1920,1080],['sharp-bilinear',4,1234,1080],['sharp-bilinear',4,1851,1080],['sharp-bilinear',4,1440,1080]]],
 '1920x900':[1920,900,[['nearest',5,1600,900],['sharp-bilinear',4,1029,900],['sharp-bilinear',4,1543,900],['sharp-bilinear',3,1200,900]]],
 '2560x1440':[2560,1440,[['nearest',8,2560,1440],['sharp-bilinear',6,1646,1440],['nearest',6,2304,1344],['sharp-bilinear',6,1920,1440]]],
 '3840x2160':[3840,2160,[['nearest',12,3840,2160],['sharp-bilinear',9,2469,2160],['nearest',9,3456,2016],['sharp-bilinear',9,2880,2160]]],
};
const grids=[[320,180],[256,224],[384,224],[320,240]];
for(const [name,[w,h,rows]] of Object.entries(gridTable))grids.forEach(([gw,gh],g)=>{
 const r=R.resolveRender({kind:'hud',cssWidth:w,cssHeight:h,dpr:1,tier:'auto',traits:{pixelGrid:{width:gw,height:gh}}}),[smoothing,k,bw,bh]=rows[g];
 assert.equal(r.smoothing,smoothing,`${gw}x${gh} at ${name}`);assert.deepEqual([r.box.width,r.box.height],[bw,bh],`${gw}x${gh} box at ${name}`);
 if(smoothing==='nearest'){assert.equal(r.integerScale,k);assert.equal(r.prescale,1);}else{assert.equal(r.prescale,k);assert.equal(r.integerScale,null);}
 assert.deepEqual([r.render.width,r.render.height],[gw,gh],'the render surface is the native grid');assert.deepEqual([r.canvas.width,r.canvas.height],[w,h],'the canvas is the device size (1:1)');
 assert.equal(r.cssImageRendering,'pixelated');
});
{
 const list=[[320,180],[256,224],[384,224],[320,240],[160,144],[240,160],[640,480],[224,288],[64,64],[1920,1080],[100,100]];
 const screens=[[1280,720],[1920,1080],[1920,900],[1366,768],[2560,1440],[2560,1600],[3440,1440],[3840,2160],[640,360],[300,200],[480,480],[7680,4320],[100,60]];
 for(const [gw,gh] of list)for(const [sw,sh] of screens)for(const mode of ['auto','integer','smooth']){
  const r=R.resolveRender({kind:'hud',cssWidth:sw,cssHeight:sh,dpr:1,tier:'auto',pixelArt:mode,traits:{pixelGrid:{width:gw,height:gh}}});
  const canvas=R.fitWithin(sw,sh,R.HARD_MAX_EDGE,R.HARD_MAX_PIXELS),kFit=Math.min(canvas.width/gw,canvas.height/gh),kInt=Math.floor(kFit+1e-9);
  const label=`${gw}x${gh} on ${sw}x${sh} ${mode}`;
  assert.deepEqual([r.canvas.width,r.canvas.height],[canvas.width,canvas.height],label);
  ok(Number.isInteger(r.box.x)&&Number.isInteger(r.box.y)&&r.box.x>=0&&r.box.y>=0&&r.box.x+r.box.width<=r.canvas.width&&r.box.y+r.box.height<=r.canvas.height,`box integral and inside the canvas: ${label}`);
  ok(Math.abs((r.canvas.width-2*r.box.x-r.box.width))<=1&&Math.abs((r.canvas.height-2*r.box.y-r.box.height))<=1,`box centred: ${label}`);
  if(kInt<1){assert.equal(r.smoothing,'bilinear',label);assert.equal(r.integerScale,null);assert.equal(r.prescale,1);}
  else if(mode==='smooth'){assert.equal(r.smoothing,'sharp-bilinear',label);assert.equal(r.prescale,kInt);}
  else if(mode==='integer'){assert.equal(r.smoothing,'nearest',label);assert.equal(r.integerScale,kInt);}
  else{
   const coverage=(kInt*gw)*(kInt*gh)/(canvas.width*canvas.height);
   if(coverage>=0.8)assert.equal(r.smoothing,'nearest',`auto takes integer when at most 20 percent is lost: ${label}`);
   else{assert.equal(r.smoothing,'sharp-bilinear',label);assert.equal(r.prescale,kInt);}
  }
  if(r.smoothing==='nearest'){
   ok(Number.isInteger(r.integerScale)&&r.box.width===r.integerScale*gw&&r.box.height===r.integerScale*gh,`exact k x k enlargement: ${label}`);
   if(mode==='auto')ok(r.box.width*r.box.height>=0.8*r.canvas.width*r.canvas.height-1e-6,`auto coverage >= 0.8: ${label}`);
  }else{
   ok(Math.abs(r.box.width*gh-r.box.height*gw)<=0.5*(gw+gh)+1e-6,`smooth box keeps the grid aspect: ${label}`);
   ok(r.box.width===r.canvas.width||r.box.height===r.canvas.height,`smooth box fills one axis: ${label}`);
  }
  near(r.metrics.scale,1,0,`pixel-art metrics are the identity: ${label}`);assert.equal(r.metrics.offsetX,0);
 }
}
// pixel aspect ratio: exact horizontal factors only, never a fractional one (RES 5.4 rule 5)
{
 const withPar=(w,h,grid,pixelArt='auto')=>R.resolveRender({kind:'hud',cssWidth:w,cssHeight:h,dpr:1,tier:'auto',pixelArt,traits:{pixelGrid:grid}});
 const wide=withPar(1920,1080,{width:256,height:180,par:2});       // kFit = min(1920/512, 6) = 3.75 -> kInt 3, horizontal 6
 assert.equal(wide.smoothing,'sharp-bilinear','par 2 at 256x180 covers only 0.4 of the screen');
 const exactPar=withPar(1536,720,{width:256,height:180,par:2});    // kInt 3 (1536/512 = 3), 720/180 = 4 -> kInt 3; box 1536x540 (coverage 0.75)
 assert.equal(exactPar.smoothing,'sharp-bilinear');
 const fits=withPar(1024,720,{width:256,height:180,par:2});        // kFit = min(2, 4) = 2 -> horizontal 4x, vertical 2x: box 1024x360 (0.5)
 assert.equal(fits.smoothing,'sharp-bilinear');
 const forced=withPar(1024,720,{width:256,height:180,par:2},'integer');assert.equal(forced.smoothing,'nearest');assert.deepEqual([forced.box.width,forced.box.height,forced.integerScale],[1024,360,2],'integer mode with par 2 is 4x horizontal, 2x vertical');
 const nearFull=withPar(1024,380,{width:256,height:190,par:2});   // kFit = min(2, 2) = 2 -> box 1024x380 covers the screen
 assert.equal(nearFull.smoothing,'nearest');assert.deepEqual([nearFull.box.width,nearFull.box.height],[1024,380]);
 const fourThirds=withPar(1920,1080,{width:256,height:224,par:4/3},'integer');   // kInt 4 -> 5.33 horizontal: integer mode rounds to 5, never fractional
 assert.equal(fourThirds.smoothing,'nearest');assert.equal(fourThirds.box.width%256,0);assert.equal(fourThirds.box.height%224,0);
 const autoFractional=withPar(1920,1080,{width:256,height:224,par:4/3});assert.equal(autoFractional.smoothing,'sharp-bilinear','auto never picks a fractional horizontal factor');
 const threes=withPar(1920,1080,{width:240,height:180,par:4/3});   // kInt 6 (min(1920/320, 6)) -> 8 horizontal: exact
 assert.deepEqual([threes.smoothing,threes.integerScale,threes.box.width,threes.box.height],['nearest',6,1920,1080]);
 // absurd pixel aspect and grids fall back safely
 for(const par of [0,-1,NaN,Infinity,1e9,1e-9])assert.doesNotThrow(()=>withPar(800,600,{width:320,height:180,par}));
 for(const grid of [{width:0,height:0},{width:NaN,height:5},{width:-1,height:-1},null,undefined,'x',5])assert.equal(withPar(800,600,grid).smoothing,'bilinear','a bad grid is the vector path');
}
// budget caps the pixel-art canvas but never the native grid
{
 const r=R.resolveRender({kind:'hud',cssWidth:3840,cssHeight:2160,dpr:1,tier:'auto',budget:{maxPixels:1920*1080},traits:{pixelGrid:{width:320,height:180}}});
 ok(r.canvas.width*r.canvas.height<=1920*1080&&r.render.width===320,'pixel-art: budget limits the canvas, not the grid');
}

// ---- 6. fitWithin
assert.deepEqual({...R.fitWithin(3840,2160,2560,2560*1440)},{width:2560,height:1440},'exact 2560x1440 despite float rounding of the scale');
assert.deepEqual({...R.fitWithin(1920,1080,1280,1280*720)},{width:1280,height:720});
assert.deepEqual({...R.fitWithin(1918,960,1280,1280*720)},{width:1280,height:640});
assert.deepEqual({...R.fitWithin(800,600,4096,1e9)},{width:800,height:600},'never enlarges');
assert.deepEqual({...R.fitWithin(40,30,4096,1e9)},{width:64,height:64},'MIN_EDGE floor');
assert.deepEqual({...R.fitWithin(NaN,NaN,NaN,NaN)},{width:64,height:64});
assert.deepEqual({...R.fitWithin(-5,1e300,0,-1)},R.fitWithin(1,1e300,4096,R.HARD_MAX_PIXELS),'invalid input and caps fall back');
for(let n=0;n<4000;n++){
 const w=1+Math.floor(rnd()*12000),h=1+Math.floor(rnd()*8000),edge=pick([64,100,640,1280,1920,2560,3840,4096]),pixels=pick([4096,50000,230400,921600,2073600,3686400,8294400]);
 const r=R.fitWithin(w,h,edge,pixels);
 ok(r.width>=64&&r.height>=64&&Number.isInteger(r.width)&&Number.isInteger(r.height),'fitWithin integer >= MIN_EDGE');
 if(Math.max(64,edge)===edge&&pixels>=4096){ok(Math.max(r.width,r.height)<=Math.max(edge,64)&&r.width*r.height<=Math.max(pixels,4096),`fitWithin caps ${w}x${h} edge ${edge} px ${pixels}`);}
 if(w>=64&&h>=64)ok(r.width<=w&&r.height<=h,'fitWithin never enlarges');
}

// ---- 6b. the worker re-fits the requested size with the hard caps (CONTRACT 2.3.4): that must be the identity on everything the policy
//          resolves, so the size a worker applies and reports is exactly the size the host asked for. fitWithin is also idempotent.
{
 let identities=0;
 const hard=(s)=>R.fitWithin(s.width,s.height,R.HARD_MAX_EDGE,R.HARD_MAX_PIXELS);
 for(let n=0;n<3000;n++){
  const w=Math.floor(80+rnd()*9000),h=Math.floor(80+rnd()*6000),d=pick([0.5,1,1.25,1.5,2,3,4]),kind=pick(['nerv','hud']),tier=pick(['auto','performance','balanced','high','native']);
  const r=vec(kind,w,h,d,tier,rnd()<.3?{deviceWidth:Math.floor(64+rnd()*8000),deviceHeight:Math.floor(64+rnd()*5000)}:{});
  assert.deepEqual({...hard(r.render)},{...r.render},`the worker re-fit is the identity for ${kind} ${tier} ${w}x${h}@${d}`);identities++;
  const f=R.fitWithin(w*d,h*d,pick([640,1280,1920,2560,3840,4096]),pick([230400,921600,2073600,3686400,8294400]));
  assert.deepEqual({...R.fitWithin(f.width,f.height,pick([1e9]),pick([1e12]))},{...f},'fitWithin never enlarges a fitted size');
 }
 // catalog pixel grids (64..1920) resolve to the native grid, and the worker re-fit keeps it
 for(const [gw,gh] of [[64,64],[320,180],[256,224],[384,224],[1920,1080],[1920,1920],[64,1920],[1920,64]]){
  const r=R.resolveRender({kind:'hud',cssWidth:1280,cssHeight:720,dpr:1,tier:'auto',traits:{pixelGrid:{width:gw,height:gh}}});
  assert.deepEqual({...hard(r.render)},{width:gw,height:gh},`the worker re-fit keeps the ${gw}x${gh} grid`);identities++;
 }
 // No worker re-fits an AVS surface, and the Studio policy behind crisp and high may legitimately go below MIN_EDGE on a very narrow view
 // (a 100x3000 view gives a 46-pixel-wide raster), so the invariant for AVS is the hard caps, not the re-fit identity.
 for(const mode of ['classic','crisp','high'])for(let n=0;n<300;n++){
  const r=R.resolveRender({kind:'avs',cssWidth:Math.floor(100+rnd()*5000),cssHeight:Math.floor(100+rnd()*3000),dpr:pick([1,1.5,2,3]),tier:'auto',avs:{mode}});
  ok(r.render.width>=1&&r.render.height>=1&&Math.max(r.render.width,r.render.height)<=R.HARD_MAX_EDGE&&r.render.width*r.render.height<=R.HARD_MAX_PIXELS,`AVS ${mode} surfaces satisfy the hard caps`);
  if(mode==='classic')assert.deepEqual({...hard(r.render)},{...r.render},'a classic surface (640 wide, at least 64 high, at most 640) is its own re-fit');
  identities++;
 }
 ok(identities>3000,'worker re-fit identity sweep size');
}

// ---- 7. totality: nothing throws, everything finite, for garbage
{
 const junk=[undefined,null,NaN,Infinity,-Infinity,0,-0,-1,-1e9,1e-9,0.5,1,5.5,1e6,1e9,1e15,1e300,Number.MAX_VALUE,Number.MIN_VALUE,'8','x',{},[],true,()=>1,{width:5},Symbol.iterator].filter(v=>typeof v!=='symbol');
 let calls=0;
 for(const kind of ['nerv','hud','avs','bogus',undefined,null])for(const w of junk)for(const d of [1,...junk.slice(0,12)]){
  const input={kind,cssWidth:w,cssHeight:pick(junk),dpr:d,deviceWidth:pick(junk),deviceHeight:pick(junk),tier:pick(['auto','high','native','bogus',null,5]),autoTier:pick(['native','x',undefined,'balanced']),
   pixelArt:pick(['auto','integer','smooth','x',undefined]),avs:pick([undefined,{mode:'crisp'},{mode:'high',scale:pick(junk)},{mode:'x'},null]),
   traits:pick([undefined,null,{logical:{width:pick(junk),height:pick(junk)}},{pixelGrid:{width:pick(junk),height:pick(junk),par:pick(junk)}},{pixelGrid:{width:320,height:180}}]),
   budget:pick([undefined,null,{maxPixels:pick(junk),maxBytes:pick(junk),surfaces:pick(junk)}])};
  const r=R.resolveRender(input);calls++;
  for(const v of [r.render.width,r.render.height,r.canvas.width,r.canvas.height,r.box.x,r.box.y,r.box.width,r.box.height,r.presentScale,r.prescale])ok(Number.isFinite(v),`finite result for ${JSON.stringify(input,(k,x)=>typeof x==='function'?'fn':x)}`);
  ok(r.render.width>=1&&r.render.height>=1&&r.canvas.width>=1&&r.canvas.height>=1&&typeof r.key==='string','positive sizes');
  ok(r.render.width*r.render.height<=Math.max(R.HARD_MAX_PIXELS,640*640),'never above the hard pixel cap (AVS classic 640x640 is smaller)');
  if(r.metrics)ok(Number.isFinite(r.metrics.scale)&&r.metrics.scale>0&&Number.isFinite(r.metrics.offsetX)&&Number.isFinite(r.metrics.contentWidth),'finite metrics');
  R.describeResolved(r);
 }
 assert.doesNotThrow(()=>R.resolveRender(undefined));assert.doesNotThrow(()=>R.resolveRender(null));assert.doesNotThrow(()=>R.resolveRender(5));
 ok(calls>1000,'totality sweep size');
 // the input is never mutated
 const frozen=Object.freeze({kind:'nerv',cssWidth:800,cssHeight:600,dpr:2,tier:'auto',traits:Object.freeze({logical:Object.freeze({width:640,height:360})}),budget:Object.freeze({maxPixels:1e6})});
 assert.doesNotThrow(()=>R.resolveRender(frozen));
}

// ---- 7b. regression: a denormal or astronomically large design canvas or surface used to overflow w / lw (scale Infinity), which made the
//          letterbox offsets NaN. Metrics stay finite and positive for every combination, through resolveRender and surfaceMetrics alike.
{
 const wild=[5e-324,1e-300,1e-9,0.5,1,960,1e6,1e9,1e300,Number.MAX_VALUE,Infinity,NaN,-1,0];
 const finiteMetrics=(m,label)=>{for(const key of ['width','height','logicalWidth','logicalHeight','scale','offsetX','offsetY','contentWidth','contentHeight'])ok(Number.isFinite(m[key]),`${label}: ${key} is finite (${m[key]})`);ok(m.scale>0&&m.logicalWidth>=1&&m.logicalHeight>=1&&m.width>=1&&m.height>=1,`${label}: positive`);};
 for(const lw of wild)for(const lh of wild){
  for(const kind of ['nerv','hud'])finiteMetrics(vec(kind,1280,720,1,'auto',{traits:{logical:{width:lw,height:lh}}}).metrics,`${kind} logical ${lw}x${lh}`);
  for(const [w,h] of [[1280,720],[1,1],[1e7,1e7],[1e300,1e300],[Infinity,NaN],[0,-5]]){
   const m=R.surfaceMetrics(w,h,lw,lh);finiteMetrics(m,`surfaceMetrics(${w},${h},${lw},${lh})`);
   for(const width of wild){const px=R.strokePx(m,width);ok(Number.isInteger(px)&&px>=1,`strokePx(${width}) is an integer >= 1 (${px})`);}
  }
 }
 // ordinary design canvases are untouched by the bounds
 const std=R.surfaceMetrics(1920,1080,640,360);assert.deepEqual([std.logicalWidth,std.logicalHeight,std.scale,std.offsetX,std.offsetY],[640,360,3,0,0]);
 const tiny=R.surfaceMetrics(100,100,64,64);assert.deepEqual([tiny.logicalWidth,tiny.logicalHeight,tiny.scale],[64,64,100/64]);
}

// ---- 8. snapping algebra (RES 8 test 5): device-space edges are integers, movement is bounded, spans tile
const SIZES=[[640,360],[480,480],[1280,720],[1280,590],[1918,960],[1920,900],[1920,1080],[2560,1440],[3840,2160],[1366,768],[240,540],[961,541]];
for(const [w,h] of SIZES){
 const m=R.surfaceMetrics(w,h,960,540);
 ok(Number.isInteger(m.offsetX)&&Number.isInteger(m.offsetY)&&Number.isInteger(m.contentWidth)&&Number.isInteger(m.contentHeight),`integer letterbox at ${w}x${h}`);
 ok(m.offsetX>=0&&m.offsetY>=0&&m.offsetX+m.contentWidth<=w&&m.offsetY+m.contentHeight<=h,`design rectangle inside the surface at ${w}x${h}`);
 near(m.scale,Math.min(w/960,h/540),1e-12,'scale');ok(!Object.is(m.offsetX,-0)&&!Object.is(m.offsetY,-0),'no negative zero offsets');
 for(let n=0;n<1500;n++){
  const axis=rnd()<.5?'x':'y',v=rnd()*(axis==='x'?960:540),width=pick([0.25,0.5,1,1.5,2,3,5]),px=R.strokePx(m,width),o=axis==='x'?m.offsetX:m.offsetY;
  assert.equal(px,Math.max(1,Math.round(width*m.scale)));ok(Number.isInteger(px)&&px>=1,'strokePx is an integer >= 1');
  const c=R.snapStroke(m,axis,v,px),dev=c*m.scale+o,left=dev-px/2,right=dev+px/2;
  near(left,Math.round(left),1e-6,'stroke left edge');near(right,Math.round(right),1e-6,'stroke right edge');
  ok(Math.abs(c-v)*m.scale<=0.5+1e-6,'stroke centre moves by at most half a device pixel');
  const len=rnd()*(axis==='x'?400:300),[a,l]=R.snapSpan(m,axis,v,len),d0=a*m.scale+o,d1=(a+l)*m.scale+o;
  near(d0,Math.round(d0),1e-6,'span near edge');near(d1,Math.round(d1),1e-6,'span far edge');ok(l*m.scale>=1-1e-6,'a positive span keeps >= 1 device pixel');
  ok(Math.abs(a-v)*m.scale<=0.5+1e-6,'span near edge moves <= 0.5 device px');
  const y=rnd()*540,b=R.snapBaseline(m,y),dy=b*m.scale+m.offsetY;near(dy,Math.round(dy),1e-6,'baseline on a device row');ok(Math.abs(b-y)*m.scale<=0.5+1e-6,'baseline moves <= 0.5 device px');
 }
 // adjacent spans share their common edge exactly: no seam, no overlap
 for(let n=0;n<300;n++){
  let x=rnd()*40,end=0,prevFar=null;
  for(let k=0;k<6;k++){
   const len=1.01/m.scale+rnd()*30,[a,l]=R.snapSpan(m,'x',x,len),near0=Math.round(a*m.scale+m.offsetX),far=Math.round((a+l)*m.scale+m.offsetX);
   if(prevFar!==null)assert.equal(near0,prevFar,`spans share an edge at ${w}x${h}`);
   prevFar=far;x=x+len;end=far;assertions++;
  }
 }
 assert.equal(R.snapSpan(m,'x',10,0)[1],0,'a zero-length span stays zero length');assert.equal(R.snapSpan(m,'y',10,-5)[1],0,'a negative length is empty');
}
assert.deepEqual([R.strokePx(R.surfaceMetrics(640,360,960,540),0),R.strokePx(R.surfaceMetrics(640,360,960,540),-3),R.strokePx(R.surfaceMetrics(640,360,960,540),NaN)],[1,1,1]);
{
 const m=R.surfaceMetrics(1920,1080,960,540);
 assert.deepEqual([m.scale,m.offsetX,m.offsetY,m.contentWidth,m.contentHeight],[2,0,0,1920,1080]);
 assert.equal(R.strokePx(m,1),2,'1 logical px is 2 device px at S = 2');assert.equal(R.snapStroke(m,'x',10.2,2),10,'an even stroke centres on a pixel edge: 20.4 -> 20 device px');
 assert.equal(R.snapStroke(m,'x',10.2,1),10.25,'an odd stroke centres on a pixel middle: 20.4 -> 20.5 device px');
 const letter=R.surfaceMetrics(1918,960,960,540);   // height limited: S = 1.7778, content 1707 wide, offset (1918-1706.67)/2 = 105.67 -> 106
 near(letter.scale,960/540,1e-12,'S');assert.equal(letter.offsetX,106);assert.equal(letter.offsetY,0);assert.equal(letter.contentWidth,1707);
 const odd=R.surfaceMetrics(0,NaN,-1,Infinity);ok(odd.width===1&&odd.logicalWidth===960&&Number.isFinite(odd.scale),'surfaceMetrics is total');
}
// design transform: translate, scale and a clip whose device edges are integers
{
 for(const [w,h] of SIZES){
  const m=R.surfaceMetrics(w,h,960,540);let tx=0,ty=0,sx=1,sy=1,path=null,clipped=null;const calls=[];
  const tracker={translate(x,y){tx+=x*sx;ty+=y*sy;calls.push('translate');},scale(x,y){sx*=x;sy*=y;calls.push('scale');},beginPath(){path=null;calls.push('beginPath');},rect(x,y,rw,rh){path=[x*sx+tx,y*sy+ty,(x+rw)*sx+tx,(y+rh)*sy+ty];calls.push('rect');},clip(){clipped=path;calls.push('clip');}};
  R.applyDesignTransform(tracker,m);
  assert.deepEqual(calls,['translate','scale','beginPath','rect','clip']);
  near(tx,m.offsetX,1e-9,'translate x');near(ty,m.offsetY,1e-9,'translate y');near(sx,m.scale,1e-12,'scale');
  for(const edge of clipped)near(edge,Math.round(edge),1e-6,`clip edge on a device pixel at ${w}x${h}`);
  near(clipped[0],m.offsetX,1e-9,'clip starts at the letterbox');near(clipped[2]-clipped[0],m.contentWidth,1e-6,'clip covers the content');
 }
}

// ---- 9. Auto governor
{
 const G=R.QualityGovernor,interval=1000/60;
 const g=new G();assert.equal(g.tier,'high','starts at the ceiling');
 let now=0,changes=[];const feed=(n,ms,dt=interval)=>{for(let k=0;k<n;k++){now+=dt;if(g.record(ms,now))changes.push([Math.round(now),g.tier]);}};
 feed(29,25);assert.equal(g.tier,'high','30 warm-up samples are ignored');
 feed(1,25);feed(11,25);assert.equal(g.tier,'high','a step down needs 12 overloaded samples after the warm-up');
 feed(1,25);assert.equal(g.tier,'balanced','the 12th overloaded sample steps down');assert.equal(changes.length,1);
 const leftAt=now;
 feed(400,25);assert.ok(changes.length===1||changes[1][0]-leftAt>=4000,'dwell: a second step waits at least 4 s from the change');
 feed(400,25);assert.equal(g.tier,'performance');feed(300,25);assert.equal(g.tier,'performance','never below the floor');
 // the tier just left is banned for a minute even when there is plenty of headroom
 const leftBalancedAt=changes.at(-1)[0];
 feed(300,2);assert.equal(g.tier,'performance','the ban keeps the governor down even with 600 roomy samples');
 for(let guard=0;g.tier==='performance'&&guard<20000;guard++)feed(1,2);
 assert.equal(g.tier,'balanced','it climbs again once the minute is over');
 ok(now-leftBalancedAt>=R.GOVERNOR_BAN_MS&&now-leftBalancedAt<=R.GOVERNOR_BAN_MS+3*interval,`climbed ${now-leftBalancedAt} ms after leaving balanced`);
 feed(20000,2);assert.equal(g.tier,'high','it recovers to the ceiling and stops there');feed(5000,1);assert.equal(g.tier,'high','never above the ceiling');
 g.reset();assert.equal(g.tier,'high','reset restores the ceiling');
 // ceiling / floor options; Native is unreachable
 assert.equal(new G({ceiling:'native'}).tier,'high','Auto cannot be configured to reach Native');
 assert.equal(new G({ceiling:'balanced'}).tier,'balanced');
 { const f=new G({floor:'balanced',warmup:0,downSamples:3,dwellMs:0});let t=0;for(let k=0;k<50;k++){t+=17;f.record(40,t);}assert.equal(f.tier,'balanced','floor holds');}
 { const c=new G({ceiling:'performance',floor:'high'});assert.equal(c.tier,'performance','floor cannot exceed the ceiling');}
 // invalid samples are ignored
 { const h=new G({warmup:0,downSamples:2,dwellMs:0});for(const bad of [NaN,-1,Infinity,undefined,'x'])assert.equal(h.record(bad,1),false);assert.equal(h.record(20,NaN),false);assert.equal(h.tier,'high');}
 // no oscillation: high is overloaded, balanced is comfortable; the ban limits the cycle to one per minute
 { const cost={high:22,balanced:5,performance:3},o=new G();let t=0,moves=[];for(let k=0;k<60*60*5;k++){t+=interval;if(o.record(cost[o.tier],t))moves.push([t,o.tier]);}
   ok(moves.length<=12,`governor moved ${moves.length} times in 300 s`);
   for(let k=1;k<moves.length;k++)if(moves[k][1]==='high')ok(moves[k][0]-moves[k-1][0]>=R.GOVERNOR_BAN_MS-1,'each return to the banned tier waits out the ban');
   assert.equal(moves[0][1],'balanced'); }
 // custom target frame rate scales the interval
 { const slow=new G({targetFps:30,warmup:0,downSamples:4,dwellMs:0});let t=0;for(let k=0;k<10;k++){t+=33;slow.record(25,t);}assert.equal(slow.tier,'high','25 ms is fine at 30 fps');
   const fast=new G({targetFps:144,warmup:0,downSamples:4,dwellMs:0});t=0;for(let k=0;k<10;k++){t+=7;fast.record(9,t);}assert.notEqual(fast.tier,'high','9 ms is overloaded at 144 fps'); }
}

// ---- 10. transitionSurface and describeResolved
{
 const S=(w,h)=>({width:w,height:h}),T=R.transitionSurface;
 assert.deepEqual(T({render:S(640,360),kind:'avs'},{render:S(640,360),kind:'avs'}),{size:S(640,360),smooth:false},'two AVS slots keep the classic nearest transition');
 assert.deepEqual(T({render:S(640,360),kind:'avs'},{render:S(1920,1080),kind:'nerv'}),{size:S(1920,1080),smooth:true},'the larger side wins; a scene kind smooths');
 assert.deepEqual(T({render:S(1920,1080),kind:'nerv'},{render:S(640,360),kind:'avs'}),{size:S(1920,1080),smooth:true});
 const a=T({render:S(1000,500),kind:'nerv'},{render:S(500,1000),kind:'hud'});assert.deepEqual(a.size,S(500,1000),'ties go to the incoming side');
 const src={render:S(10,10),kind:'avs'};T(src,src).size.width=99;assert.equal(src.render.width,10,'the result never aliases an input');
 assert.equal(T({render:S(320,180),kind:'hud'},{render:S(320,180),kind:'nerv'}).smooth,true);
 assert.equal(R.describeResolved(vec('nerv',1920,1080,1,'auto')),'NERV 1920x1080 - scale 2.00 - high');
 assert.equal(R.describeResolved(vec('nerv',3840/1.5,2160/1.5,1.5,'native')),'NERV 3840x2160 - scale 4.00 - native');
 assert.equal(R.describeResolved(vec('hud',1280,720,1,'balanced')),'HUD 1280x720 - scale 1.33 - balanced');
 assert.equal(R.describeResolved(classic(1920,1080,1)),'AVS 640x360 - x3.00');
 assert.equal(R.describeResolved(R.resolveRender({kind:'avs',cssWidth:1920,cssHeight:1080,dpr:1,tier:'auto',avs:{mode:'crisp'}})),'AVS 640x360 - integer x3');
 const pa=(w,h,gw,gh,mode)=>R.resolveRender({kind:'hud',cssWidth:w,cssHeight:h,dpr:1,tier:'auto',pixelArt:mode,traits:{pixelGrid:{width:gw,height:gh}}});
 assert.equal(R.describeResolved(pa(1920,1080,320,180)),'HUD 320x180 - integer x6');
 assert.equal(R.describeResolved(pa(1920,1080,256,224)),'HUD 256x224 - sharp-bilinear x4');
 assert.equal(R.describeResolved(pa(200,100,320,180)),'HUD 320x180 - smooth x0.56');
 assert.ok(/^[\x20-\x7e]+$/.test(R.describeResolved(vec('nerv',800,600,1,'auto'))),'ASCII only');
}

// ---- 11. identity: the key changes exactly when something a presenter or worker must react to changes
{
 const a=vec('nerv',1920,1080,1,'auto'),b=vec('nerv',1920,1080,1,'high');assert.equal(a.key,b.key);
 assert.notEqual(a.key,vec('nerv',1921,1080,1,'auto').key);assert.notEqual(a.key,vec('hud',1920,1080,1,'auto').key);
 assert.equal(vec('nerv',480,480,1,'performance').key,vec('nerv',480,480,1,'native').key,'a tier that changes nothing on screen changes nothing');
 assert.notEqual(pixelKey(320,180),pixelKey(256,224));function pixelKey(gw,gh){return R.resolveRender({kind:'hud',cssWidth:1920,cssHeight:1080,dpr:1,tier:'auto',traits:{pixelGrid:{width:gw,height:gh}}}).key;}
 assert.ok(Object.isFrozen(a),'results are frozen');
}
console.log(`Render resolution: classic AVS parity (${parity} cases), tier x display tables, crisp/high against the Studio policy, vector invariants, integer rule, snapping algebra, governor, totality PASS (${assertions} assertions)`);
