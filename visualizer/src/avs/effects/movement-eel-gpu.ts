import { compileAvsEel } from '../eel/compiler.ts';
import { parseAvsEel } from '../eel/parser.ts';
import type { AvsEelAst, AvsEelGlobalStateLike, AvsEelNode } from '../eel/types.ts';
import { AvsEelVm } from '../eel/vm.ts';
import type { AvsFrameGraphCapability, AvsGpuPassContext, PackedAvsGpuPass } from '../gpu-frame-graph.ts';
import type { AvsAudioFrame } from '../types.ts';
import type { AvsMovementConfig } from './movement.ts';

const CUSTOM_MOVEMENT = 32_767;
const WORKGROUP_SIZE = 256 as const;
const POINT_INPUTS = new Set(['x', 'y', 'd', 'r']);
const DIMENSIONS = new Set(['sw', 'sh']);

export const AVS_ENHANCED_MOVEMENT_EEL_GPU_CAPABILITY: AvsFrameGraphCapability = {
  id: 'movement-pure-eel-resident-map', backend: 'webgpu', lane: '120', byteExact: false,
  reason: 'Pure inverse custom Movement EEL builds its coordinate/weight map resident with f32, then uses exact packed-u32 AVS sampling.',
};

export interface EnhancedMovementEelGpuProgram {
  readonly source: string;
  readonly wgsl: string;
  readonly uniformNames: readonly string[];
  readonly workgroupSize: 256;
}

export type EnhancedMovementEelGpuCompileResult =
  | { readonly eligible: true; readonly program: EnhancedMovementEelGpuProgram }
  | { readonly eligible: false; readonly reason: string };

export function compileEnhancedMovementEelGpu(config: AvsMovementConfig): EnhancedMovementEelGpuCompileResult {
  if (config.effect !== CUSTOM_MOVEMENT) return { eligible: false, reason: 'only custom Movement EEL is eligible' };
  if (config.sourceMapped !== 0) return { eligible: false, reason: 'forward or beat-toggled source mapping is order-sensitive' };
  let ast: AvsEelAst;
  try { compileAvsEel(config.expression); ast = parseAvsEel(config.expression); }
  catch (error) { return rejected(error); }
  const analysis = analyse(ast.body);
  if (!analysis.ok) return { eligible: false, reason: analysis.reason };
  try {
    const builder = new MovementWgslBuilder(analysis.uniformNames);
    const body = builder.program(ast.body);
    return {
      eligible: true,
      program: {
        source: config.expression,
        wgsl: shaderSource(body, analysis.uniformNames, builder.localNames),
        uniformNames: analysis.uniformNames,
        workgroupSize: WORKGROUP_SIZE,
      },
    };
  } catch (error) { return rejected(error); }
}

type Analysis = { readonly ok: true; readonly uniformNames: readonly string[] } | { readonly ok: false; readonly reason: string };

function analyse(root: AvsEelNode): Analysis {
  const values = root.kind === 'sequence' ? root.values : [root];
  const written = new Set<string>(); collectWrites(root, written);
  for (const name of written) {
    if (isRegister(name)) return { ok: false, reason: `${name} is shared register state` };
    if (DIMENSIONS.has(name)) return { ok: false, reason: `${name} is loop-carried dimension state` };
  }
  const initialized = new Set(POINT_INPUTS), reads = new Set<string>();
  for (const node of values) {
    const assignment = directAssignment(node);
    if (assignment) {
      const target = normalize(assignment.target);
      const failure = validatePure(assignment.value, written, initialized, reads);
      if (failure) return { ok: false, reason: failure };
      if (assignment.operator !== '=' && !initialized.has(target)) return { ok: false, reason: `${target}${assignment.operator} carries point-to-point state` };
      initialized.add(target); continue;
    }
    const failure = validatePure(node, written, initialized, reads);
    if (failure) return { ok: false, reason: failure };
  }
  const uniformNames = [...reads]
    .filter(name => !POINT_INPUTS.has(name) && !DIMENSIONS.has(name) && !written.has(name) && !['$pi', '$e', '$phi'].includes(name))
    .sort();
  return { ok: true, uniformNames };
}

function validatePure(node: AvsEelNode, written: ReadonlySet<string>, initialized: ReadonlySet<string>, reads: Set<string>): string | null {
  if (node.kind === 'variable') {
    const name = normalize(node.name);
    if (written.has(name) && !initialized.has(name)) return `${name} is read before per-point initialization`;
    reads.add(name); return null;
  }
  if (node.kind === 'assign' || (node.kind === 'call' && node.name === 'assign')) return 'nested or conditional mutation is order-sensitive';
  if (node.kind === 'call' && ['loop', 'rand', 'megabuf', 'gmegabuf', 'getosc', 'getspec', 'gettime', 'getkbmouse'].includes(node.name)) {
    return `${node.name} is not a safe independent point operation`;
  }
  for (const child of children(node)) { const failure = validatePure(child, written, initialized, reads); if (failure) return failure; }
  return null;
}

/** Persistent map program and shared-register snapshot source. */
export class EnhancedMovementEelGpuState {
  private readonly vm: AvsEelVm;
  private readonly values: Float32Array;
  constructor(readonly config: AvsMovementConfig, readonly program: EnhancedMovementEelGpuProgram, global: AvsEelGlobalStateLike) {
    this.vm = new AvsEelVm({ global }); this.values = new Float32Array(Math.max(4, program.uniformNames.length));
  }
  capture(): Float32Array {
    for (let index = 0; index < this.program.uniformNames.length; index++) {
      const value = this.vm.get(this.program.uniformNames[index]!); this.values[index] = Number.isFinite(value) ? value : 0;
    }
    return this.values;
  }
}

export class EnhancedMovementEelGpuPass implements PackedAvsGpuPass {
  readonly capability = AVS_ENHANCED_MOVEMENT_EEL_GPU_CAPABILITY;
  lastEncodedPasses: 0 | 1 | 2 = 0;
  private readonly mapPipeline: GPUComputePipeline;
  private readonly samplePipeline: GPUComputePipeline;
  private readonly layout: GPUBindGroupLayout;
  private readonly map: GPUBuffer;
  private readonly variables: GPUBuffer;
  private readonly params: GPUBuffer;
  private readonly paramsWords = new Uint32Array(8);
  private readonly groups = new WeakMap<GPUBuffer, WeakMap<GPUBuffer, GPUBindGroup>>();
  private prepared = false;
  private mapEncoded = false;
  private destroyed = false;

  constructor(private readonly device: GPUDevice, readonly state: EnhancedMovementEelGpuState, private readonly width: number, private readonly height: number) {
    const { config, program } = state;
    if (config.sourceMapped !== 0 || config.effect !== CUSTOM_MOVEMENT) throw new Error('Movement EEL GPU pass requires inverse custom mapping');
    const pixels = width * height;
    if (width <= 0 || height <= 0 || pixels >= 0x00400000) throw new RangeError('Movement EEL GPU dimensions unsupported');
    const module = device.createShaderModule({ label: 'AVS enhanced custom Movement EEL', code: program.wgsl });
    this.layout = device.createBindGroupLayout({ label: 'AVS custom Movement EEL layout', entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    this.mapPipeline = device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint: 'movement_eel_map' } });
    this.samplePipeline = device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint: 'movement_eel_sample' } });
    this.map = storage(device, 'AVS custom Movement resident map', pixels * 4, 0);
    this.variables = storage(device, 'AVS custom Movement EEL uniforms', Math.max(4, program.uniformNames.length) * 4, GPUBufferUsage.COPY_DST);
    this.params = device.createBuffer({ label: 'AVS custom Movement params', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** Capture shared globals once, matching the classic resize-time table build. */
  prepare(): void {
    if (this.prepared) return; this.assertActive();
    const { config, program } = this.state;
    const bilinear = config.subpixel && this.width > 1 && this.height > 1;
    const values = this.state.capture();
    this.paramsWords.set([this.width, this.height, this.width * this.height, bilinear ? 1 : 0, config.blend ? 1 : 0, config.wrap ? 1 : 0, config.rectangular ? 1 : 0, program.uniformNames.length]);
    this.device.queue.writeBuffer(this.variables, 0, values.buffer as ArrayBuffer, values.byteOffset, values.byteLength);
    this.device.queue.writeBuffer(this.params, 0, this.paramsWords); this.prepared = true;
  }
  update(_audio: AvsAudioFrame): void { this.prepare(); }

  encode(context: AvsGpuPassContext): void {
    this.prepare();
    let targets = this.groups.get(context.source); if (!targets) { targets = new WeakMap(); this.groups.set(context.source, targets); }
    let group = targets.get(context.target);
    if (!group) {
      group = context.device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: { buffer: context.source } }, { binding: 1, resource: { buffer: context.target } },
        { binding: 2, resource: { buffer: this.map } }, { binding: 3, resource: { buffer: this.variables } },
        { binding: 4, resource: { buffer: this.params } },
      ] }); targets.set(context.target, group);
    }
    const generatedMap = !this.mapEncoded;
    if (generatedMap) {
      const mapPass = context.encoder.beginComputePass({ label: 'AVS custom Movement EEL resident map' });
      mapPass.setPipeline(this.mapPipeline); mapPass.setBindGroup(0, group); mapPass.dispatchWorkgroups(Math.ceil(context.width * context.height / WORKGROUP_SIZE)); mapPass.end();
      this.mapEncoded = true;
    }
    const samplePass = context.encoder.beginComputePass({ label: 'AVS custom Movement exact sample' });
    samplePass.setPipeline(this.samplePipeline); samplePass.setBindGroup(0, group); samplePass.dispatchWorkgroups(Math.ceil(context.width * context.height / WORKGROUP_SIZE)); samplePass.end();
    this.lastEncodedPasses = generatedMap ? 2 : 1;
  }

  destroy(): void { if (this.destroyed) return; this.destroyed = true; this.map.destroy(); this.variables.destroy(); this.params.destroy(); }
  private assertActive(): void { if (this.destroyed) throw new Error('AVS custom Movement EEL pass is destroyed'); }
}

function shaderSource(body: string, uniforms: readonly string[], locals: ReadonlySet<string>): string {
  const declarations = [...locals].filter(name => !['v_x','v_y','v_d','v_r'].includes(name)).sort().map(name => `var ${name}:f32=0.0;`).join('\n  ');
  return /* wgsl */ `
struct Params{width:u32,height:u32,pixels:u32,bilinear:u32,blend_enabled:u32,wrap_enabled:u32,rectangular:u32,variable_count:u32};
@group(0)@binding(0)var<storage,read>source:array<u32>;@group(0)@binding(1)var<storage,read_write>destination:array<u32>;@group(0)@binding(2)var<storage,read_write>coordinate_map:array<u32>;@group(0)@binding(3)var<storage,read>initial:array<f32>;@group(0)@binding(4)var<uniform>params:Params;
fn finite(v:f32)->f32{return select(0.0,v,v==v&&abs(v)<=3.402823e38);}fn truth(v:f32)->bool{return abs(v)>=0.00001;}fn close(a:f32,b:f32)->bool{return abs(a-b)<0.00001;}fn divide(a:f32,b:f32)->f32{return select(finite(a/b),0.0,abs(b)<1.1920929e-7);}fn modulo_f(a:f32,b:f32)->f32{return select(finite(a%b),0.0,abs(b)<1.1920929e-7);}fn positive_mod(v:i32,m:i32)->i32{let r=v%m;return select(r,r+m,r<0);}
fn avs_table(a:u32,b:u32)->u32{var r=(a*b)/255u;let c=(a==147u&&(b==85u||b==170u))||(a==155u&&(b==51u||b==102u||b==153u||b==204u))||(a==171u&&(b==85u||b==170u))||(a==187u&&(b==75u||b==150u||b==165u))||(a==195u&&b==153u);if(c){r-=1u;}return r;}fn avs_average(a:u32,b:u32)->u32{return((a>>1u)&0x007f7f7fu)+((b>>1u)&0x007f7f7fu);}fn avs_bilinear(offset:u32,key:u32)->u32{let xp=(key>>5u)<<3u;let yp=(key&31u)<<3u;let ix=255u-xp;let iy=255u-yp;let w=array<u32,4>(avs_table(ix,iy),avs_table(xp,iy),avs_table(ix,yp),avs_table(xp,yp));let p=array<u32,4>(source[offset],source[offset+1u],source[offset+params.width],source[offset+params.width+1u]);var lo=0u;var mi=0u;var hi=0u;for(var i=0u;i<4u;i++){lo+=avs_table(p[i]&255u,w[i]);mi+=avs_table((p[i]>>8u)&255u,w[i]);hi+=avs_table((p[i]>>16u)&255u,w[i]);}return(lo&255u)|((mi&255u)<<8u)|((hi&255u)<<16u);}
@compute @workgroup_size(${WORKGROUP_SIZE})fn movement_eel_map(@builtin(global_invocation_id)id:vec3u){let index=id.x;if(index>=params.pixels){return;}let px=index%params.width;let py=index/params.width;let hw=params.width/2u;let hh=params.height/2u;let xd=f32(i32(px)-i32(hw));let yd=f32(i32(py)-i32(hh));let md=sqrt(f32(params.width*params.width+params.height*params.height))*0.5;var v_x=select(xd/f32(hw),0.0,hw==0u);var v_y=select(yd/f32(hh),0.0,hh==0u);var v_d=select(sqrt(xd*xd+yd*yd)/md,0.0,md==0.0);var v_r=atan2(yd,xd)+3.14159265358979323846*0.5;${declarations}var _result=0.0;${body}var sx=0.0;var sy=0.0;if(params.rectangular!=0u){sx=(v_x+1.0)*f32(hw);sy=(v_y+1.0)*f32(hh);}else{let distance=v_d*md;let angle=v_r-3.14159265358979323846*0.5;sx=f32(hw)+cos(angle)*distance;sy=f32(hh)+sin(angle)*distance;}if(params.bilinear==0u){sx+=0.5;sy+=0.5;var ix=i32(trunc(sx));var iy=i32(trunc(sy));if(params.wrap_enabled!=0u){ix=positive_mod(ix,i32(params.width));iy=positive_mod(iy,i32(params.height));}else{ix=clamp(ix,0,i32(params.width)-1);iy=clamp(iy,0,i32(params.height)-1);}coordinate_map[index]=u32(ix+iy*i32(params.width));return;}var ix=i32(trunc(sx));var iy=i32(trunc(sy));var xp=i32(trunc(32.0*(sx-f32(ix))));var yp=i32(trunc(32.0*(sy-f32(iy))));if(params.wrap_enabled!=0u){ix=positive_mod(ix,i32(params.width)-1);iy=positive_mod(iy,i32(params.height)-1);}else{if(ix<0){ix=0;xp=0;}else if(ix>=i32(params.width)-1){ix=i32(params.width)-2;xp=31;}if(iy<0){iy=0;yp=0;}else if(iy>=i32(params.height)-1){iy=i32(params.height)-2;yp=31;}}let packed=bitcast<u32>((ix+iy*i32(params.width))|(yp<<22)|(xp<<27));let xw=(packed>>24u)&248u;let yw=(packed>>19u)&248u;let key=(xw<<2u)|(yw>>3u);coordinate_map[index]=(packed&0x003fffffu)|(key<<22u);}
@compute @workgroup_size(${WORKGROUP_SIZE})fn movement_eel_sample(@builtin(global_invocation_id)id:vec3u){let i=id.x;if(i>=params.pixels){return;}let packed=coordinate_map[i];let offset=packed&0x003fffffu;var sampled=source[offset];if(params.bilinear!=0u){sampled=avs_bilinear(offset,packed>>22u);}destination[i]=select(sampled,avs_average(source[i],sampled),params.blend_enabled!=0u);}`;
}

class MovementWgslBuilder {
  readonly localNames=new Set<string>();private readonly uniformIndex=new Map<string,number>();constructor(names:readonly string[]){names.forEach((name,index)=>this.uniformIndex.set(name,index));}
  program(root:AvsEelNode):string{const values=root.kind==='sequence'?root.values:[root],lines:string[]=[];for(const node of values){const a=directAssignment(node);if(!a){lines.push(`_result=finite(${this.expression(node)});`);continue;}const target=this.name(a.target);this.localNames.add(target);lines.push(`${target}=${assignmentExpression(a.operator,target,this.expression(a.value))};`,`_result=${target};`);}return lines.join('');}
  private expression(node:AvsEelNode):string{switch(node.kind){case'number':return numberLiteral(node.value);case'variable':return this.variable(node.name);case'unary':{const v=this.expression(node.value);if(node.operator==='+')return`finite(${v})`;if(node.operator==='-')return`finite(-(${v}))`;if(node.operator==='!')return`select(1.0,0.0,truth(${v}))`;if(node.operator==='~')return`f32(~i32(${v}))`;throw new Error(`Unsupported unary ${node.operator}`);}case'binary':return this.binary(node.operator,node.left,node.right);case'conditional':return`select(${this.expression(node.no)},${this.expression(node.yes)},truth(${this.expression(node.condition)}))`;case'call':return this.call(node.name,node.args);case'sequence':if(node.values.length===1)return this.expression(node.values[0]!);throw new Error('Nested sequence is not GPU-pure');case'assign':throw new Error('Nested assignment is not GPU-pure');}}
  private binary(op:string,l:AvsEelNode,r:AvsEelNode):string{const a=this.expression(l),b=this.expression(r);switch(op){case'+':return`finite((${a})+(${b}))`;case'-':return`finite((${a})-(${b}))`;case'*':return`finite((${a})*(${b}))`;case'/':return`divide(${a},${b})`;case'%':return`modulo_f(${a},${b})`;case'**':return`finite(pow(${a},${b}))`;case'|':return`f32(i32(${a})|i32(${b}))`;case'&':return`f32(i32(${a})&i32(${b}))`;case'^':return`f32(i32(${a})^i32(${b}))`;case'<<':return`f32(i32(${a})<<(u32(i32(${b}))&31u))`;case'>>':return`f32(i32(${a})>>(u32(i32(${b}))&31u))`;case'&&':return`select(0.0,select(0.0,1.0,truth(${b})),truth(${a}))`;case'||':return`select(select(0.0,1.0,truth(${b})),1.0,truth(${a}))`;case'==':return`select(0.0,1.0,close(${a},${b}))`;case'!=':return`select(1.0,0.0,close(${a},${b}))`;case'===':return`select(0.0,1.0,(${a})==(${b}))`;case'!==':return`select(0.0,1.0,(${a})!=(${b}))`;case'<':case'<=':case'>':case'>=':return`select(0.0,1.0,(${a})${op}(${b}))`;default:throw new Error(`Unsupported binary ${op}`);}}
  private call(name:string,nodes:readonly AvsEelNode[]):string{if(name==='if')return`select(${this.expression(nodes[2]!)},${this.expression(nodes[1]!)},truth(${this.expression(nodes[0]!)}))`;const a=nodes.map(n=>this.expression(n)),one=(f:string)=>`finite(${f}(${a[0]}))`,two=(f:string)=>`finite(${f}(${a[0]},${a[1]}))`;switch(name){case'sin':case'cos':case'tan':case'asin':case'acos':case'atan':case'sqrt':case'exp':case'log':case'abs':case'floor':case'ceil':return one(name);case'atan2':return two('atan2');case'sqr':return`finite((${a[0]})*(${a[0]}))`;case'invsqrt':return`finite(inverseSqrt(${a[0]}))`;case'pow':case'min':case'max':return two(name);case'log10':return`finite(log2(${a[0]})/log2(10.0))`;case'int':return`finite(trunc(${a[0]}))`;case'sign':return`select(select(0.0,1.0,(${a[0]})>0.0),-1.0,(${a[0]})<0.0)`;case'equal':return`select(0.0,1.0,close(${a[0]},${a[1]}))`;case'above':return`select(0.0,1.0,(${a[0]})>(${a[1]}))`;case'below':return`select(0.0,1.0,(${a[0]})<(${a[1]}))`;case'band':return`select(0.0,1.0,truth(${a[0]})&&truth(${a[1]}))`;case'bor':return`select(0.0,1.0,truth(${a[0]})||truth(${a[1]}))`;case'bnot':return`select(1.0,0.0,truth(${a[0]}))`;default:throw new Error(`Function ${name} is not supported by enhanced Movement EEL`);}}
  private variable(raw:string):string{const name=normalize(raw);if(name==='$pi')return'3.14159265358979323846';if(name==='$e')return'2.71828182845904523536';if(name==='$phi')return'1.61803398874989484820';if(name==='sw')return'f32(params.width)';if(name==='sh')return'f32(params.height)';const local=this.name(name);if(POINT_INPUTS.has(name)||this.localNames.has(local))return local;const index=this.uniformIndex.get(name);if(index===undefined)throw new Error(`Missing GPU input ${name}`);return`initial[${index}u]`;}
  private name(raw:string):string{return`v_${normalize(raw).replace(/^\$/,'').replace(/[^a-z0-9_]/g,'_')}`;}
}

function collectWrites(node:AvsEelNode,target:Set<string>):void{if(node.kind==='assign'&&node.target.kind==='variable')target.add(normalize(node.target.name));if(node.kind==='call'&&node.name==='assign'&&node.args[0]?.kind==='variable')target.add(normalize(node.args[0].name));for(const child of children(node))collectWrites(child,target);}
function directAssignment(node:AvsEelNode):{target:string;operator:string;value:AvsEelNode}|null{if(node.kind==='assign'&&node.target.kind==='variable')return{target:node.target.name,operator:node.operator,value:node.value};if(node.kind==='call'&&node.name==='assign'&&node.args[0]?.kind==='variable'&&node.args[1])return{target:node.args[0].name,operator:'=',value:node.args[1]};return null;}
function children(node:AvsEelNode):readonly AvsEelNode[]{switch(node.kind){case'number':case'variable':return[];case'unary':return[node.value];case'binary':return[node.left,node.right];case'conditional':return[node.condition,node.yes,node.no];case'assign':return[node.target,node.value];case'call':return node.args;case'sequence':return node.values;}}
function assignmentExpression(op:string,left:string,right:string):string{switch(op){case'=':return`finite(${right})`;case'+=':return`finite(${left}+(${right}))`;case'-=':return`finite(${left}-(${right}))`;case'*=':return`finite(${left}*(${right}))`;case'/=':return`divide(${left},${right})`;case'%=':return`modulo_f(${left},${right})`;case'|=':return`f32(i32(${left})|i32(${right}))`;case'&=':return`f32(i32(${left})&i32(${right}))`;case'^=':return`f32(i32(${left})^i32(${right}))`;case'**=':return`finite(pow(${left},${right}))`;default:throw new Error(`Unsupported assignment ${op}`);}}
function storage(device:GPUDevice,label:string,size:number,extra:GPUBufferUsageFlags):GPUBuffer{return device.createBuffer({label,size:Math.max(16,Math.ceil(size/16)*16),usage:GPUBufferUsage.STORAGE|extra});}
function normalize(name:string):string{return name.toLowerCase().slice(0,8);}function isRegister(name:string):boolean{return/^reg\d\d$/.test(name);}function numberLiteral(value:number):string{if(!Number.isFinite(value))return'0.0';return Number.isInteger(value)?`${value}.0`:`${value}`;}function rejected(error:unknown):EnhancedMovementEelGpuCompileResult{return{eligible:false,reason:error instanceof Error?error.message:String(error)};}
