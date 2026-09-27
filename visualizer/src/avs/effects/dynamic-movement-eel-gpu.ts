import { avsAudioSample } from '../audio.ts';
import { compileAvsEel } from '../eel/compiler.ts';
import { parseAvsEel } from '../eel/parser.ts';
import type { AvsEelAst, AvsEelBoundExecutor, AvsEelGlobalStateLike, AvsEelNode } from '../eel/types.ts';
import { AvsEelVm } from '../eel/vm.ts';
import type { AvsFrameGraphCapability, AvsGpuPassContext, PackedAvsGpuPass } from '../gpu-frame-graph.ts';
import type { AvsAudioFrame } from '../types.ts';
import type { AvsDynamicMovementConfig } from './dynamic-movement.ts';

/**
 * Enhanced-only Dynamic Movement path. Point EEL is evaluated as independent
 * f32 grid invocations, so the full-resolution packed map never crosses the
 * CPU/GPU boundary. Classic AVS and the exact lane stay on the f64 CPU VM.
 */
export const AVS_ENHANCED_DYNAMIC_MOVEMENT_RESIDENT_CAPABILITY: AvsFrameGraphCapability = {
  id: 'dynamic-movement-resident-f32-map', backend: 'webgpu', lane: '120', byteExact: false,
  reason: 'CPU preserves init/frame/beat state; pure point EEL generates the coarse grid and resamples resident packed-u32 surfaces on WebGPU.',
};

export interface EnhancedDynamicMovementResidentProgram {
  readonly source: string;
  readonly wgsl: string;
  readonly uniformNames: readonly string[];
  readonly workgroupSize: 256;
}

export type EnhancedDynamicMovementResidentCompileResult =
  | { readonly eligible: true; readonly program: EnhancedDynamicMovementResidentProgram }
  | { readonly eligible: false; readonly reason: string };

const POINT_INPUTS = new Set(['x', 'y', 'd', 'r']);
const WORKGROUP_SIZE = 256 as const;

/** Compile only point-independent EEL whose writes cannot escape GPU invocations. */
export function compileEnhancedDynamicMovementResident(
  config: Pick<AvsDynamicMovementConfig, 'point' | 'init' | 'frame' | 'beat'>,
): EnhancedDynamicMovementResidentCompileResult {
  let point: AvsEelAst;
  try {
    // Parsing alone accepts unknown call identifiers. The classic compiler is
    // the semantic gate, so an invalid classic script can never gain behavior
    // merely by entering the enhanced lane.
    compileAvsEel(config.point);
    point = parseAvsEel(config.point);
  }
  catch (error) { return rejected(error); }

  const phaseReferences = new Set<string>();
  for (const source of [config.init, config.frame, config.beat]) {
    if (!source.trim()) continue;
    try { collectVariables(parseAvsEel(source).body, phaseReferences); }
    catch (error) { return rejected(error); }
  }
  const analysis = analysePointProgram(point.body, phaseReferences);
  if (!analysis.ok) return { eligible: false, reason: analysis.reason };
  try {
    const builder = new DynamicMovementWgslBuilder(analysis.uniformNames);
    const body = builder.program(point.body);
    return {
      eligible: true,
      program: {
        source: config.point,
        wgsl: residentShaderSource(body, analysis.uniformNames, builder.localNames),
        uniformNames: analysis.uniformNames,
        workgroupSize: WORKGROUP_SIZE,
      },
    };
  } catch (error) { return rejected(error); }
}

type Analysis = { readonly ok: true; readonly uniformNames: readonly string[] } | { readonly ok: false; readonly reason: string };

function analysePointProgram(root: AvsEelNode, phaseReferences: ReadonlySet<string>): Analysis {
  const values = root.kind === 'sequence' ? root.values : [root];
  const written = new Set<string>();
  collectWrites(root, written);
  for (const name of written) {
    if (isRegister(name)) return { ok: false, reason: `${name} is shared register state` };
    if (phaseReferences.has(name)) return { ok: false, reason: `${name} is observed by init/frame/beat code` };
  }

  const initialized = new Set(POINT_INPUTS);
  const reads = new Set<string>(['alpha']);
  for (const node of values) {
    const assignment = directAssignment(node);
    if (assignment) {
      const target = normalize(assignment.target);
      const failure = validatePure(assignment.value, written, initialized, reads);
      if (failure) return { ok: false, reason: failure };
      if (assignment.operator !== '=' && !initialized.has(target)) {
        return { ok: false, reason: `${target}${assignment.operator} carries point-to-point state` };
      }
      initialized.add(target);
      continue;
    }
    const failure = validatePure(node, written, initialized, reads);
    if (failure) return { ok: false, reason: failure };
  }
  const uniformNames = [...reads]
    .filter(name => !POINT_INPUTS.has(name) && !written.has(name) && !['$pi', '$e', '$phi'].includes(name))
    .sort();
  return { ok: true, uniformNames };
}

function validatePure(
  node: AvsEelNode,
  written: ReadonlySet<string>,
  initialized: ReadonlySet<string>,
  reads: Set<string>,
): string | null {
  if (node.kind === 'variable') {
    const name = normalize(node.name);
    if (written.has(name) && !initialized.has(name)) return `${name} is read before per-point initialization`;
    reads.add(name);
    return null;
  }
  if (node.kind === 'assign' || (node.kind === 'call' && node.name === 'assign')) {
    return 'nested or conditional mutation is order-sensitive';
  }
  if (node.kind === 'call' && ['loop', 'rand', 'megabuf', 'gmegabuf', 'getosc', 'getspec', 'gettime', 'getkbmouse'].includes(node.name)) {
    return `${node.name} is not a safe independent point operation`;
  }
  for (const child of children(node)) {
    const failure = validatePure(child, written, initialized, reads);
    if (failure) return failure;
  }
  return null;
}

/** Persistent CPU phase state, intentionally independent of resizable GPU resources. */
export class EnhancedDynamicMovementResidentState {
  private readonly vm: AvsEelVm;
  private readonly init: AvsEelBoundExecutor | null;
  private readonly frame: AvsEelBoundExecutor | null;
  private readonly beat: AvsEelBoundExecutor | null;
  private readonly packedVariables: Float32Array;
  private initialized = false;

  constructor(
    readonly config: AvsDynamicMovementConfig,
    readonly program: EnhancedDynamicMovementResidentProgram,
    global: AvsEelGlobalStateLike,
    seed: number,
  ) {
    this.vm = new AvsEelVm({ global, seed });
    this.init = bindOrNull(config.init, this.vm);
    this.frame = bindOrNull(config.frame, this.vm);
    this.beat = bindOrNull(config.beat, this.vm);
    this.packedVariables = new Float32Array(Math.max(4, program.uniformNames.length));
  }

  update(audio: AvsAudioFrame, width: number, height: number): Float32Array {
    this.vm.setHost({
      getosc: (band, sampleWidth, channel) => avsAudioSample(audio, 'osc', band, sampleWidth, channel),
      getspec: (band, sampleWidth, channel) => avsAudioSample(audio, 'spec', band, sampleWidth, channel),
    });
    this.vm.set('w', width); this.vm.set('h', height);
    this.vm.set('b', audio.beat ? 1 : 0); this.vm.set('alpha', 0.5);
    if (!this.initialized) { this.init?.(); this.initialized = true; }
    this.frame?.(); if (audio.beat) this.beat?.();
    for (let index = 0; index < this.program.uniformNames.length; index++) {
      const value = this.vm.get(this.program.uniformNames[index]!);
      this.packedVariables[index] = Number.isFinite(value) ? value : 0;
    }
    return this.packedVariables;
  }
}

export class EnhancedDynamicMovementResidentGpuPass implements PackedAvsGpuPass {
  readonly capability = AVS_ENHANCED_DYNAMIC_MOVEMENT_RESIDENT_CAPABILITY;
  private readonly gridPipeline: GPUComputePipeline;
  private readonly resamplePipeline: GPUComputePipeline;
  private readonly bindGroupLayout: GPUBindGroupLayout;
  private readonly grid: GPUBuffer;
  private readonly variables: GPUBuffer;
  private readonly params: GPUBuffer;
  private readonly packedParams = new Uint32Array(12);
  private readonly groups = new WeakMap<GPUBuffer, WeakMap<GPUBuffer, GPUBindGroup>>();
  private destroyed = false;

  constructor(
    private readonly device: GPUDevice,
    readonly state: EnhancedDynamicMovementResidentState,
    private readonly width: number,
    private readonly height: number,
  ) {
    const { config, program } = state;
    if (config.buffer !== 0 || config.noMove) throw new Error('Resident Dynamic Movement rejects global-buffer and no-move modes');
    if (config.bilinear && (width < 2 || height < 2)) throw new RangeError('Resident bilinear Dynamic Movement requires dimensions >= 2');
    const columns = columnsFor(config), rows = rowsFor(config);
    const module = device.createShaderModule({ label: 'AVS enhanced Dynamic Movement resident map', code: program.wgsl });
    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'AVS Dynamic Movement resident layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    const layout = device.createPipelineLayout({ label: 'AVS Dynamic Movement resident pipeline layout', bindGroupLayouts: [this.bindGroupLayout] });
    this.gridPipeline = device.createComputePipeline({ layout, compute: { module, entryPoint: 'dynamic_movement_grid' } });
    this.resamplePipeline = device.createComputePipeline({ layout, compute: { module, entryPoint: 'dynamic_movement_resample' } });
    this.grid = storageBuffer(device, 'AVS Dynamic Movement resident grid', columns * rows * 16, 0);
    this.variables = storageBuffer(device, 'AVS Dynamic Movement resident uniforms', Math.max(4, program.uniformNames.length) * 4, GPUBufferUsage.COPY_DST);
    this.params = device.createBuffer({ label: 'AVS Dynamic Movement resident params', size: this.packedParams.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** Uploads scalar phase state only; the coarse grid and packed sampling map stay on GPU. */
  update(audio: AvsAudioFrame): void {
    this.assertActive();
    const packedVariables = this.state.update(audio, this.width, this.height);
    const { config, program } = this.state;
    this.packedParams.set([
      this.width, this.height, this.width * this.height, columnsFor(config), rowsFor(config),
      config.bilinear ? 1 : 0, config.blend ? 1 : 0, config.wrap ? 1 : 0,
      config.rectangular ? 1 : 0, program.uniformNames.length, 0, 0,
    ]);
    this.device.queue.writeBuffer(this.variables, 0, packedVariables.buffer as ArrayBuffer, packedVariables.byteOffset, packedVariables.byteLength);
    this.device.queue.writeBuffer(this.params, 0, this.packedParams);
  }

  encode(context: AvsGpuPassContext): void {
    this.assertActive();
    let targets = this.groups.get(context.source);
    if (!targets) { targets = new WeakMap(); this.groups.set(context.source, targets); }
    let group = targets.get(context.target);
    if (!group) {
      group = context.device.createBindGroup({
        label: 'AVS Dynamic Movement resident bindings', layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: context.source } }, { binding: 1, resource: { buffer: context.target } },
          { binding: 2, resource: { buffer: this.grid } }, { binding: 3, resource: { buffer: this.variables } },
          { binding: 4, resource: { buffer: this.params } },
        ],
      });
      targets.set(context.target, group);
    }
    let pass = context.encoder.beginComputePass({ label: 'AVS Dynamic Movement resident grid' });
    pass.setPipeline(this.gridPipeline); pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(columnsFor(this.state.config) * rowsFor(this.state.config) / WORKGROUP_SIZE)); pass.end();
    pass = context.encoder.beginComputePass({ label: 'AVS Dynamic Movement resident resample' });
    pass.setPipeline(this.resamplePipeline); pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(context.width * context.height / WORKGROUP_SIZE)); pass.end();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.grid.destroy(); this.variables.destroy(); this.params.destroy();
  }

  private assertActive(): void { if (this.destroyed) throw new Error('AVS resident Dynamic Movement pass is destroyed'); }
}

function residentShaderSource(body: string, uniformNames: readonly string[], locals: ReadonlySet<string>): string {
  const declarations = [...locals].filter(name => !['v_x', 'v_y', 'v_d', 'v_r', 'v_alpha'].includes(name)).sort()
    .map(name => `var ${name}: f32 = 0.0;`).join('\n  ');
  const alphaIndex = uniformNames.indexOf('alpha');
  return /* wgsl */ `
struct Params { width:u32, height:u32, pixels:u32, columns:u32, rows:u32, bilinear:u32, blend_enabled:u32, wrap_enabled:u32, rectangular:u32, variable_count:u32, _p0:u32, _p1:u32 };
@group(0) @binding(0) var<storage,read> source:array<u32>;
@group(0) @binding(1) var<storage,read_write> destination:array<u32>;
@group(0) @binding(2) var<storage,read_write> grid:array<vec4f>;
@group(0) @binding(3) var<storage,read> initial:array<f32>;
@group(0) @binding(4) var<uniform> params:Params;
fn finite(v:f32)->f32{return select(0.0,v,v==v&&abs(v)<=3.402823e38);}
fn truth(v:f32)->bool{return abs(v)>=0.00001;}
fn close(a:f32,b:f32)->bool{return abs(a-b)<0.00001;}
fn divide(a:f32,b:f32)->f32{return select(finite(a/b),0.0,abs(b)<1.1920929e-7);}
fn modulo(a:f32,b:f32)->f32{return select(finite(a%b),0.0,abs(b)<1.1920929e-7);}
fn avs_table(a:u32,b:u32)->u32{var r=(a*b)/255u;let c=(a==147u&&(b==85u||b==170u))||(a==155u&&(b==51u||b==102u||b==153u||b==204u))||(a==171u&&(b==85u||b==170u))||(a==187u&&(b==75u||b==150u||b==165u))||(a==195u&&b==153u);if(c){r-=1u;}return r;}
fn blend_avs(a:u32,b:u32,alpha:u32)->u32{let inv=255u-alpha;let lo=avs_table(a&255u,alpha)+avs_table(b&255u,inv);let mi=avs_table((a>>8u)&255u,alpha)+avs_table((b>>8u)&255u,inv);let hi=avs_table((a>>16u)&255u,alpha)+avs_table((b>>16u)&255u,inv);return lo|(mi<<8u)|(hi<<16u);}
fn sample4(offset:u32,fx:u32,fy:u32)->u32{let ix=255u-fx;let iy=255u-fy;let w=array<u32,4>(avs_table(ix,iy),avs_table(fx,iy),avs_table(ix,fy),avs_table(fx,fy));let p=array<u32,4>(source[offset],source[offset+1u],source[offset+params.width],source[offset+params.width+1u]);var lo=0u;var mi=0u;var hi=0u;for(var i=0u;i<4u;i++){lo+=avs_table(p[i]&255u,w[i]);mi+=avs_table((p[i]>>8u)&255u,w[i]);hi+=avs_table((p[i]>>16u)&255u,w[i]);}return (lo&255u)|((mi&255u)<<8u)|((hi&255u)<<16u);}
@compute @workgroup_size(${WORKGROUP_SIZE}) fn dynamic_movement_grid(@builtin(global_invocation_id) id:vec3u){
  let index=id.x;if(index>=params.columns*params.rows){return;}let gx=index%params.columns;let gy=index/params.columns;
  let sx=f32(gx)*f32(params.width)/f32(params.columns-1u);let sy=f32(gy)*f32(params.height)/f32(params.rows-1u);
  let cx=f32(params.width)*0.5;let cy=f32(params.height)*0.5;let radius=sqrt(f32(params.width*params.width+params.height*params.height))*0.5;
  var v_x=(sx-cx)*(2.0/f32(params.width));var v_y=(sy-cy)*(2.0/f32(params.height));
  var v_d=sqrt((sx-cx)*(sx-cx)+(sy-cy)*(sy-cy))/radius;var v_r=atan2(sy-cy,sx-cx)+3.14159265358979323846*0.5;
  var v_alpha:f32=${alphaIndex < 0 ? '0.5' : `initial[${alphaIndex}u]`};${declarations ? `\n  ${declarations}` : ''}
  var _result=0.0;${body ? `\n  ${body}` : ''}
  var mx=0.0;var my=0.0;if(params.rectangular!=0u){mx=(v_x+1.0)*f32(params.width)*0.5;my=(v_y+1.0)*f32(params.height)*0.5;}else{let distance=v_d*radius;let angle=v_r-3.14159265358979323846*0.5;mx=f32(params.width)*0.5+cos(angle)*distance;my=f32(params.height)*0.5+sin(angle)*distance;}grid[index]=vec4f(mx,my,clamp(v_alpha,0.0,1.0),0.0);
}
@compute @workgroup_size(${WORKGROUP_SIZE}) fn dynamic_movement_resample(@builtin(global_invocation_id) id:vec3u){
  let i=id.x;if(i>=params.pixels){return;}let x=i%params.width;let y=i/params.width;
  let cellfx=f32(x)*f32(params.columns-1u)/f32(params.width);let cellfy=f32(y)*f32(params.rows-1u)/f32(params.height);
  let cellx=min(params.columns-2u,u32(cellfx));let celly=min(params.rows-2u,u32(cellfy));let fx=cellfx-f32(cellx);let fy=cellfy-f32(celly);let invy=1.0-fy;let tl=cellx+celly*params.columns;
  let a=grid[tl];let b=grid[tl+1u];let c=grid[tl+params.columns];let d=grid[tl+params.columns+1u];
  var mapped=(a+(b-a)*fx)*invy+(c+(d-c)*fx)*fy;let maximum=vec2f(f32(params.width-select(1u,2u,params.bilinear!=0u)),f32(params.height-select(1u,2u,params.bilinear!=0u)));let span=max(vec2f(1.0),maximum);
  if(params.wrap_enabled!=0u){mapped.xy=((mapped.xy%span)+span)%span;}else{mapped.x=clamp(mapped.x,0.0,maximum.x);mapped.y=clamp(mapped.y,0.0,maximum.y);}
  let ix=u32(mapped.x);let iy=u32(mapped.y);let offset=ix+iy*params.width;var sampled=source[offset];
  if(params.bilinear!=0u&&params.width>=2u&&params.height>=2u){sampled=sample4(offset,u32((mapped.x-f32(ix))*256.0)&255u,u32((mapped.y-f32(iy))*256.0)&255u);}let alpha=u32(clamp(mapped.z,0.0,1.0)*255.0);destination[i]=select(sampled,blend_avs(sampled,source[i],alpha),params.blend_enabled!=0u);
}`;
}

class DynamicMovementWgslBuilder {
  readonly localNames = new Set<string>();
  private readonly uniformIndex = new Map<string, number>();
  constructor(uniformNames: readonly string[]) { uniformNames.forEach((name, index) => this.uniformIndex.set(name, index)); }
  program(root: AvsEelNode): string {
    const values = root.kind === 'sequence' ? root.values : [root];
    const lines: string[] = [];
    for (const node of values) {
      const assignment = directAssignment(node);
      if (!assignment) { lines.push(`_result=finite(${this.expression(node)});`); continue; }
      const target = this.name(assignment.target); this.localNames.add(target);
      lines.push(`${target}=${assignmentExpression(assignment.operator, target, this.expression(assignment.value))};`, `_result=${target};`);
    }
    return lines.join('\n  ');
  }
  private expression(node: AvsEelNode): string {
    switch (node.kind) {
      case 'number': return numberLiteral(node.value);
      case 'variable': return this.variable(node.name);
      case 'unary': { const v=this.expression(node.value);if(node.operator==='+')return`finite(${v})`;if(node.operator==='-')return`finite(-(${v}))`;if(node.operator==='!')return`select(1.0,0.0,truth(${v}))`;if(node.operator==='~')return`f32(~i32(${v}))`;throw new Error(`Unsupported unary ${node.operator}`); }
      case 'binary': return this.binary(node.operator,node.left,node.right);
      case 'conditional': return `select(${this.expression(node.no)},${this.expression(node.yes)},truth(${this.expression(node.condition)}))`;
      case 'call': return this.call(node.name,node.args);
      case 'sequence': if(node.values.length===1)return this.expression(node.values[0]!);throw new Error('Nested sequence is not GPU-pure');
      case 'assign': throw new Error('Nested assignment is not GPU-pure');
    }
  }
  private binary(op:string,l:AvsEelNode,r:AvsEelNode):string { const a=this.expression(l),b=this.expression(r);switch(op){case'+':return`finite((${a})+(${b}))`;case'-':return`finite((${a})-(${b}))`;case'*':return`finite((${a})*(${b}))`;case'/':return`divide(${a},${b})`;case'%':return`modulo(${a},${b})`;case'**':return`finite(pow(${a},${b}))`;case'|':return`f32(i32(${a})|i32(${b}))`;case'&':return`f32(i32(${a})&i32(${b}))`;case'^':return`f32(i32(${a})^i32(${b}))`;case'<<':return`f32(i32(${a})<<(u32(i32(${b}))&31u))`;case'>>':return`f32(i32(${a})>>(u32(i32(${b}))&31u))`;case'&&':return`select(0.0,select(0.0,1.0,truth(${b})),truth(${a}))`;case'||':return`select(select(0.0,1.0,truth(${b})),1.0,truth(${a}))`;case'==':return`select(0.0,1.0,close(${a},${b}))`;case'!=':return`select(1.0,0.0,close(${a},${b}))`;case'===':return`select(0.0,1.0,(${a})==(${b}))`;case'!==':return`select(0.0,1.0,(${a})!=(${b}))`;case'<':case'<=':case'>':case'>=':return`select(0.0,1.0,(${a})${op}(${b}))`;default:throw new Error(`Unsupported binary ${op}`);} }
  private call(name:string,nodes:readonly AvsEelNode[]):string { if(name==='if')return`select(${this.expression(nodes[2]!)},${this.expression(nodes[1]!)},truth(${this.expression(nodes[0]!)}))`;const a=nodes.map(n=>this.expression(n)),one=(f:string)=>`finite(${f}(${a[0]}))`,two=(f:string)=>`finite(${f}(${a[0]},${a[1]}))`;switch(name){case'sin':case'cos':case'tan':case'asin':case'acos':case'atan':case'sqrt':case'exp':case'log':case'abs':case'floor':case'ceil':return one(name);case'atan2':return two('atan2');case'sqr':return`finite((${a[0]})*(${a[0]}))`;case'invsqrt':return`finite(inverseSqrt(${a[0]}))`;case'pow':case'min':case'max':return two(name);case'log10':return`finite(log2(${a[0]})/log2(10.0))`;case'int':return`finite(trunc(${a[0]}))`;case'sign':return`select(select(0.0,1.0,(${a[0]})>0.0),-1.0,(${a[0]})<0.0)`;case'equal':return`select(0.0,1.0,close(${a[0]},${a[1]}))`;case'above':return`select(0.0,1.0,(${a[0]})>(${a[1]}))`;case'below':return`select(0.0,1.0,(${a[0]})<(${a[1]}))`;case'band':return`select(0.0,1.0,truth(${a[0]})&&truth(${a[1]}))`;case'bor':return`select(0.0,1.0,truth(${a[0]})||truth(${a[1]}))`;case'bnot':return`select(1.0,0.0,truth(${a[0]}))`;default:throw new Error(`Function ${name} is not supported by resident Dynamic Movement`);} }
  private variable(raw:string):string { const name=normalize(raw);if(name==='$pi')return'3.14159265358979323846';if(name==='$e')return'2.71828182845904523536';if(name==='$phi')return'1.61803398874989484820';const local=this.name(name);if(POINT_INPUTS.has(name)||this.localNames.has(local))return local;const index=this.uniformIndex.get(name);if(index===undefined)throw new Error(`Missing GPU input ${name}`);return`initial[${index}u]`; }
  private name(raw:string):string{return`v_${normalize(raw).replace(/^\$/,'').replace(/[^a-z0-9_]/g,'_')}`;}
}

function collectWrites(node:AvsEelNode,target:Set<string>):void { if(node.kind==='assign'&&node.target.kind==='variable')target.add(normalize(node.target.name));if(node.kind==='call'&&node.name==='assign'&&node.args[0]?.kind==='variable')target.add(normalize(node.args[0].name));for(const child of children(node))collectWrites(child,target); }
function collectVariables(node:AvsEelNode,target:Set<string>):void { if(node.kind==='variable')target.add(normalize(node.name));for(const child of children(node))collectVariables(child,target); }
function directAssignment(node:AvsEelNode):{target:string;operator:string;value:AvsEelNode}|null { if(node.kind==='assign'&&node.target.kind==='variable')return{target:node.target.name,operator:node.operator,value:node.value};if(node.kind==='call'&&node.name==='assign'&&node.args[0]?.kind==='variable'&&node.args[1])return{target:node.args[0].name,operator:'=',value:node.args[1]};return null; }
function children(node:AvsEelNode):readonly AvsEelNode[]{switch(node.kind){case'number':case'variable':return[];case'unary':return[node.value];case'binary':return[node.left,node.right];case'conditional':return[node.condition,node.yes,node.no];case'assign':return[node.target,node.value];case'call':return node.args;case'sequence':return node.values;}}
function assignmentExpression(op:string,left:string,right:string):string { switch(op){case'=':return`finite(${right})`;case'+=':return`finite(${left}+(${right}))`;case'-=':return`finite(${left}-(${right}))`;case'*=':return`finite(${left}*(${right}))`;case'/=':return`divide(${left},${right})`;case'%=':return`modulo(${left},${right})`;case'|=':return`f32(i32(${left})|i32(${right}))`;case'&=':return`f32(i32(${left})&i32(${right}))`;case'^=':return`f32(i32(${left})^i32(${right}))`;case'**=':return`finite(pow(${left},${right}))`;default:throw new Error(`Unsupported assignment ${op}`);} }
function bindOrNull(source:string,vm:AvsEelVm):AvsEelBoundExecutor|null { if(!source.trim())return null;try{return compileAvsEel(source).bind(vm);}catch{return null;} }
function columnsFor(config:AvsDynamicMovementConfig):number{return clampInt(Math.trunc(config.gridWidth)+1,2,256);}
function rowsFor(config:AvsDynamicMovementConfig):number{return clampInt(Math.trunc(config.gridHeight)+1,2,256);}
function storageBuffer(device:GPUDevice,label:string,size:number,extra:GPUBufferUsageFlags):GPUBuffer{return device.createBuffer({label,size:Math.max(16,Math.ceil(size/16)*16),usage:GPUBufferUsage.STORAGE|extra});}
function normalize(name:string):string{return name.toLowerCase().slice(0,8);}
function isRegister(name:string):boolean{return /^reg\d\d$/.test(name);}
function numberLiteral(value:number):string{if(!Number.isFinite(value))return'0.0';return Number.isInteger(value)?`${value}.0`:`${value}`;}
function clampInt(value:number,min:number,max:number):number{return value<min?min:value>max?max:value;}
function rejected(error:unknown):EnhancedDynamicMovementResidentCompileResult{return{eligible:false,reason:error instanceof Error?error.message:String(error)};}
