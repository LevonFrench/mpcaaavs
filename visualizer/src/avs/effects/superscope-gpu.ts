import { parseAvsEel } from '../eel/parser.ts';
import { compileAvsEel } from '../eel/compiler.ts';
import { AvsEelVm } from '../eel/vm.ts';
import type {
  AvsEelAst, AvsEelBoundExecutor, AvsEelGlobalStateLike, AvsEelNode, AvsEelProgram,
} from '../eel/types.ts';
import type { AvsAudioFrame } from '../types.ts';
import { avsAudioSample } from '../audio.ts';
import type { AvsFrameGraphCapability, AvsGpuPassContext, PackedAvsGpuPass } from '../gpu-frame-graph.ts';
import type { AvsSuperScopeConfig } from './superscope.ts';

/**
 * Explicitly approximate SuperScope generator. It evaluates independent point
 * scripts in parallel with WebGPU f32 arithmetic. Classic AVS stays on the
 * ordered f64 CPU executor; callers must opt in to this capability.
 */
export const AVS_ENHANCED_SUPERSCOPE_GPU_CAPABILITY = {
  id: 'enhanced-superscope-f32-generator',
  backend: 'webgpu',
  lane: '120',
  byteExact: false,
  reason: 'Parallel f32 point evaluation changes classic AVS f64 rounding and cannot preserve point-to-point mutation.',
} as const;

export interface EnhancedSuperScopeGpuProgram {
  readonly source: string;
  readonly wgsl: string;
  /** VM variables sampled once before dispatch, in this exact order. */
  readonly uniformNames: readonly string[];
  readonly workgroupSize: 256;
  readonly outputStrideBytes: 16;
  readonly usesHostAudio: boolean;
}

export type EnhancedSuperScopeGpuCompileResult =
  | { readonly eligible: true; readonly program: EnhancedSuperScopeGpuProgram }
  | { readonly eligible: false; readonly reason: string };

export interface EnhancedSuperScopeGpuFrame {
  readonly count: number;
  readonly width: number;
  readonly height: number;
  readonly xor: 0 | 128;
  readonly audio: Uint8Array;
  /** Full stereo host data, required only when point code uses getosc/getspec. */
  readonly hostAudio?: AvsAudioFrame;
  readonly variables: Readonly<Record<string, number>>;
}

export interface EnhancedSuperScopeGpuDispatch {
  readonly output: GPUBuffer;
  readonly count: number;
  readonly outputStrideBytes: 16;
}

const INPUTS = new Set(['i', 'v']);
const OUTPUTS = ['x', 'y', 'red', 'green', 'blue', 'skip', 'drawmode', 'linesize'] as const;
const WORKGROUP_SIZE = 256 as const;
const OUTPUT_STRIDE = 16 as const;

/**
 * Compile a point script only when each written variable is initialized inside
 * each invocation before it is read. This rejects reg/memory/random/host calls,
 * loops, conditional mutation, and point-to-point accumulators.
 */
export function compileEnhancedSuperScopeGpu(source: string): EnhancedSuperScopeGpuCompileResult {
  let ast: AvsEelAst;
  try { ast = parseAvsEel(source); }
  catch (error) { return { eligible: false, reason: error instanceof Error ? error.message : String(error) }; }

  const analysis = analysePointProgram(ast.body);
  if (!analysis.ok) return { eligible: false, reason: analysis.reason };
  try {
    const builder = new WgslBuilder(analysis.uniformNames);
    const body = builder.program(ast.body);
    return {
      eligible: true,
      program: {
        source,
        wgsl: shaderSource(body, analysis.uniformNames, builder.localNames),
        uniformNames: analysis.uniformNames,
        workgroupSize: WORKGROUP_SIZE,
        outputStrideBytes: OUTPUT_STRIDE,
        usesHostAudio: analysis.usesHostAudio,
      },
    };
  } catch (error) {
    return { eligible: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Owns resident input/output buffers. The generated point buffer remains on
 * GPU for a subsequent raster pass; this class intentionally offers no
 * readback helper on the render path.
 */
export class EnhancedSuperScopeGpuGenerator {
  readonly capability = AVS_ENHANCED_SUPERSCOPE_GPU_CAPABILITY;
  readonly program: EnhancedSuperScopeGpuProgram;
  readonly maxPoints: number;

  private readonly device: GPUDevice;
  private readonly pipeline: GPUComputePipeline;
  private readonly audioBuffer: GPUBuffer;
  private readonly hostAudioBuffer: GPUBuffer;
  private readonly variableBuffer: GPUBuffer;
  private readonly paramsBuffer: GPUBuffer;
  private readonly outputBuffer: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private readonly packedAudio = new Uint32Array(576);
  private readonly packedHostAudio = new Uint32Array(576 * 4);
  private readonly packedVariables: Float32Array;
  private readonly packedParams = new Uint32Array(8);
  private destroyed = false;

  constructor(device: GPUDevice, program: EnhancedSuperScopeGpuProgram, maxPoints = 128 * 1024) {
    if (!Number.isInteger(maxPoints) || maxPoints <= 0) throw new RangeError(`Invalid SuperScope point capacity ${maxPoints}`);
    const outputBytes = maxPoints * OUTPUT_STRIDE;
    if (outputBytes > Number(device.limits.maxStorageBufferBindingSize)) {
      throw new RangeError(`SuperScope point buffer needs ${outputBytes} bytes; adapter limit is ${device.limits.maxStorageBufferBindingSize}`);
    }
    this.device = device;
    this.program = program;
    this.maxPoints = maxPoints;
    this.packedVariables = new Float32Array(Math.max(4, program.uniformNames.length));
    const module = device.createShaderModule({ label: 'AVS enhanced f32 SuperScope generator', code: program.wgsl });
    this.pipeline = device.createComputePipeline({
      label: 'AVS enhanced f32 SuperScope generator', layout: 'auto',
      compute: { module, entryPoint: 'superscope_points' },
    });
    this.audioBuffer = storageBuffer(device, 'AVS SuperScope audio', this.packedAudio.byteLength, GPUBufferUsage.COPY_DST);
    this.hostAudioBuffer = storageBuffer(device, 'AVS SuperScope host audio', this.packedHostAudio.byteLength, GPUBufferUsage.COPY_DST);
    this.variableBuffer = storageBuffer(device, 'AVS SuperScope variables', this.packedVariables.byteLength, GPUBufferUsage.COPY_DST);
    this.paramsBuffer = device.createBuffer({
      label: 'AVS SuperScope generator params', size: this.packedParams.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.outputBuffer = storageBuffer(device, 'AVS SuperScope generated points', outputBytes, GPUBufferUsage.COPY_SRC);
    this.bindGroup = device.createBindGroup({
      label: 'AVS enhanced SuperScope generator inputs', layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.audioBuffer } },
        { binding: 1, resource: { buffer: this.hostAudioBuffer } },
        { binding: 2, resource: { buffer: this.variableBuffer } },
        { binding: 3, resource: { buffer: this.paramsBuffer } },
        { binding: 4, resource: { buffer: this.outputBuffer } },
      ],
    });
  }

  /** Uploads only 2.3 KiB of audio plus scalar state; generated points stay resident. */
  writeFrame(frame: EnhancedSuperScopeGpuFrame): number {
    this.assertActive();
    if (frame.audio.length < 576) throw new RangeError(`SuperScope audio needs 576 samples, got ${frame.audio.length}`);
    const count = clampInt(frame.count, 0, this.maxPoints);
    for (let index = 0; index < 576; index++) this.packedAudio[index] = frame.audio[index]!;
    for (let index = 0; index < this.program.uniformNames.length; index++) {
      const value = frame.variables[this.program.uniformNames[index]!] ?? 0;
      this.packedVariables[index] = Number.isFinite(value) ? value : 0;
    }
    this.packedParams.set([count, frame.width >>> 0, frame.height >>> 0, frame.xor, this.program.uniformNames.length]);
    this.device.queue.writeBuffer(this.audioBuffer, 0, this.packedAudio);
    if (this.program.usesHostAudio) {
      if (!frame.hostAudio) throw new Error('SuperScope GPU point script uses getosc/getspec but no hostAudio was supplied');
      this.packHostAudio(frame.hostAudio);
      this.device.queue.writeBuffer(this.hostAudioBuffer, 0, this.packedHostAudio);
    }
    this.device.queue.writeBuffer(
      this.variableBuffer, 0, this.packedVariables.buffer as ArrayBuffer,
      this.packedVariables.byteOffset, this.packedVariables.byteLength,
    );
    this.device.queue.writeBuffer(this.paramsBuffer, 0, this.packedParams);
    return count;
  }

  encode(encoder: GPUCommandEncoder, count: number): EnhancedSuperScopeGpuDispatch {
    this.assertActive();
    const bounded = clampInt(count, 0, this.maxPoints);
    if (bounded !== 0) {
      const pass = encoder.beginComputePass({ label: 'AVS enhanced f32 SuperScope points' });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.dispatchWorkgroups(Math.ceil(bounded / WORKGROUP_SIZE));
      pass.end();
    }
    return { output: this.outputBuffer, count: bounded, outputStrideBytes: OUTPUT_STRIDE };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.audioBuffer.destroy();
    this.hostAudioBuffer.destroy();
    this.variableBuffer.destroy();
    this.paramsBuffer.destroy();
    this.outputBuffer.destroy();
  }

  private assertActive(): void {
    if (this.destroyed) throw new Error('AVS enhanced SuperScope generator is destroyed');
  }

  private packHostAudio(audio: AvsAudioFrame): void {
    const channels = [audio.waveform[0], audio.waveform[1], audio.spectrum[0], audio.spectrum[1]];
    for (let channel = 0; channel < channels.length; channel++) {
      const source = channels[channel]!;
      for (let index = 0; index < 576; index++) this.packedHostAudio[channel * 576 + index] = source[index]!;
    }
  }
}

const ENHANCED_RASTER_WGSL = /* wgsl */ `
struct ScopePoint { x: i32, y: i32, color: u32, flags: u32 };
struct RasterParams { count: u32, width: u32, height: u32, _pad: u32 };
@group(0) @binding(0) var<storage, read> points: array<ScopePoint>;
@group(0) @binding(1) var<storage, read_write> pixels: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> params: RasterParams;

@compute @workgroup_size(256)
fn raster_points(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= params.count) { return; }
  let point = points[index];
  if ((point.flags & 1u) != 0u || point.x < 0 || point.y < 0 || point.x >= i32(params.width) || point.y >= i32(params.height)) {
    return;
  }
  atomicStore(&pixels[u32(point.y) * params.width + u32(point.x)], point.color);
}`;

/**
 * Live terminal pass: exact CPU frame/init/beat state feeds the enhanced f32
 * point generator; an unordered point-only raster stays resident on GPU.
 */
export class EnhancedSuperScopeGpuTerminalPass implements PackedAvsGpuPass {
  readonly capability: AvsFrameGraphCapability = AVS_ENHANCED_SUPERSCOPE_GPU_CAPABILITY;

  private readonly generator: EnhancedSuperScopeGpuGenerator;
  private readonly vm: AvsEelVm;
  private readonly pointUniforms: readonly string[];
  private readonly init: AvsEelBoundExecutor | null;
  private readonly frame: AvsEelBoundExecutor | null;
  private readonly beat: AvsEelBoundExecutor | null;
  private readonly host: { audio: AvsAudioFrame };
  private readonly rasterPipeline: GPUComputePipeline;
  private readonly rasterParams: GPUBuffer;
  private readonly rasterWords = new Uint32Array(4);
  private readonly rasterGroups = new WeakMap<GPUBuffer, GPUBindGroup>();
  private readonly centeredAudio = new Uint8Array(576);
  private initialized = false;
  private colorPosition = 0;
  private count = 0;
  private destroyed = false;

  constructor(
    private readonly device: GPUDevice,
    private readonly config: AvsSuperScopeConfig,
    program: EnhancedSuperScopeGpuProgram,
    global: AvsEelGlobalStateLike,
    seed: number,
    maxPoints = 128 * 1024,
  ) {
    this.generator = new EnhancedSuperScopeGpuGenerator(device, program, maxPoints);
    this.pointUniforms = program.uniformNames;
    this.vm = new AvsEelVm({ global, seed });
    this.host = { audio: emptyAudioFrame() };
    this.vm.setHost({
      getosc: (band, width, channel) => avsAudioSample(this.host.audio, 'osc', band, width, channel),
      getspec: (band, width, channel) => avsAudioSample(this.host.audio, 'spec', band, width, channel),
    });
    this.vm.set('n', 100);
    this.init = bindOrNull(config.init, this.vm);
    this.frame = bindOrNull(config.frame, this.vm);
    this.beat = bindOrNull(config.beat, this.vm);
    const module = device.createShaderModule({ label: 'AVS enhanced SuperScope point raster', code: ENHANCED_RASTER_WGSL });
    this.rasterPipeline = device.createComputePipeline({
      label: 'AVS enhanced SuperScope point raster', layout: 'auto',
      compute: { module, entryPoint: 'raster_points' },
    });
    this.rasterParams = device.createBuffer({
      label: 'AVS enhanced SuperScope raster params', size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /** Execute host/frame phases after the exact CPU prefix and stage GPU inputs. */
  updateFrame(audio: AvsAudioFrame, width: number, height: number): void {
    this.assertActive();
    this.host.audio = audio;
    this.colorPosition++;
    if (this.colorPosition >= this.config.colors.length * 64) this.colorPosition = 0;
    const color = interpolatedScopeColor(this.config.colors, this.colorPosition);
    this.vm.set('h', height);
    this.vm.set('w', width);
    this.vm.set('b', audio.beat ? 1 : 0);
    this.vm.set('blue', (color & 255) / 255);
    this.vm.set('green', ((color >>> 8) & 255) / 255);
    this.vm.set('red', ((color >>> 16) & 255) / 255);
    this.vm.set('skip', 0);
    this.vm.set('linesize', 1);
    this.vm.set('drawmode', 0);
    if (!this.initialized) { this.init?.(); this.initialized = true; }
    this.frame?.();
    if (audio.beat) this.beat?.();
    const requested = Math.trunc(this.vm.get('n'));
    const selected = scopeGpuChannel(audio, this.config.channel, this.centeredAudio);
    const variables: Record<string, number> = {};
    for (const name of this.pointUniforms) variables[name] = this.vm.get(name);
    this.count = this.generator.writeFrame({
      count: requested, width, height, xor: (this.config.channel & 4) !== 0 ? 0 : 128,
      audio: selected, hostAudio: audio, variables,
    });
    this.rasterWords.set([this.count, width, height, 0]);
    this.device.queue.writeBuffer(this.rasterParams, 0, this.rasterWords);
  }

  encode(context: AvsGpuPassContext): void {
    this.assertActive();
    context.encoder.copyBufferToBuffer(context.source, 0, context.target, 0, context.width * context.height * 4);
    const generated = this.generator.encode(context.encoder, this.count);
    if (generated.count === 0) return;
    let group = this.rasterGroups.get(context.target);
    if (!group) {
      group = context.device.createBindGroup({
        label: 'AVS enhanced SuperScope raster target', layout: this.rasterPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: generated.output } },
          { binding: 1, resource: { buffer: context.target } },
          { binding: 2, resource: { buffer: this.rasterParams } },
        ],
      });
      this.rasterGroups.set(context.target, group);
    }
    const pass = context.encoder.beginComputePass({ label: 'AVS enhanced SuperScope point raster' });
    pass.setPipeline(this.rasterPipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(generated.count / 256));
    pass.end();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generator.destroy();
    this.rasterParams.destroy();
  }

  private assertActive(): void {
    if (this.destroyed) throw new Error('AVS enhanced SuperScope terminal pass is destroyed');
  }
}

type Analysis = { ok: true; uniformNames: string[]; usesHostAudio: boolean } | { ok: false; reason: string };

function analysePointProgram(root: AvsEelNode): Analysis {
  const values = root.kind === 'sequence' ? root.values : [root];
  const written = new Set<string>();
  collectWrites(root, written);
  const initialized = new Set(INPUTS);
  const reads = new Set<string>();
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
  for (const name of OUTPUTS) {
    if (written.has(name) && !initialized.has(name)) return { ok: false, reason: `${name} is not initialized on every point` };
    if (!initialized.has(name)) reads.add(name);
  }
  const uniformNames = [...reads].filter(name => !INPUTS.has(name)).sort();
  return { ok: true, uniformNames, usesHostAudio: containsHostAudio(root) };
}

function collectWrites(node: AvsEelNode, target: Set<string>): void {
  if (node.kind === 'assign' && node.target.kind === 'variable') target.add(normalize(node.target.name));
  if (node.kind === 'call' && node.name === 'assign' && node.args[0]?.kind === 'variable') target.add(normalize(node.args[0].name));
  for (const child of children(node)) collectWrites(child, target);
}

function validatePure(node: AvsEelNode, written: ReadonlySet<string>, initialized: ReadonlySet<string>, reads: Set<string>): string | null {
  if (node.kind === 'variable') {
    const name = normalize(node.name);
    if (written.has(name) && !initialized.has(name)) return `${name} is read before per-point initialization`;
    reads.add(name);
    return null;
  }
  if (node.kind === 'assign' || (node.kind === 'call' && node.name === 'assign')) {
    return 'nested or conditional mutation is order-sensitive';
  }
  if (node.kind === 'call' && ['loop', 'rand', 'megabuf', 'gmegabuf', 'gettime', 'getkbmouse'].includes(node.name)) {
    return `${node.name} is not point-independent`;
  }
  for (const child of children(node)) {
    const failure = validatePure(child, written, initialized, reads);
    if (failure) return failure;
  }
  return null;
}

function directAssignment(node: AvsEelNode): { target: string; operator: string; value: AvsEelNode } | null {
  if (node.kind === 'assign' && node.target.kind === 'variable') {
    return { target: node.target.name, operator: node.operator, value: node.value };
  }
  if (node.kind === 'call' && node.name === 'assign' && node.args[0]?.kind === 'variable' && node.args[1]) {
    return { target: node.args[0].name, operator: '=', value: node.args[1] };
  }
  return null;
}

class WgslBuilder {
  readonly localNames = new Set<string>();
  private temporary = 0;
  private readonly uniformIndex = new Map<string, number>();

  constructor(uniformNames: readonly string[]) {
    uniformNames.forEach((name, index) => this.uniformIndex.set(name, index));
  }

  program(root: AvsEelNode): string {
    const values = root.kind === 'sequence' ? root.values : [root];
    const lines: string[] = [];
    for (const node of values) {
      const assignment = directAssignment(node);
      if (!assignment) { lines.push(`_result = finite(${this.expression(node)});`); continue; }
      const target = this.name(assignment.target);
      this.localNames.add(target);
      const right = this.expression(assignment.value);
      const next = assignmentExpression(assignment.operator, target, right);
      lines.push(`${target} = ${next};`, `_result = ${target};`);
    }
    return lines.join('\n  ');
  }

  private expression(node: AvsEelNode): string {
    switch (node.kind) {
      case 'number': return numberLiteral(node.value);
      case 'variable': return this.variable(node.name);
      case 'unary': {
        const value = this.expression(node.value);
        if (node.operator === '+') return `finite(${value})`;
        if (node.operator === '-') return `finite(-(${value}))`;
        if (node.operator === '!') return `select(1.0,0.0,truth(${value}))`;
        if (node.operator === '~') return `f32(~i32(${value}))`;
        throw new Error(`Unsupported unary ${node.operator}`);
      }
      case 'binary': return this.binary(node.operator, node.left, node.right);
      case 'conditional': return `select(${this.expression(node.no)},${this.expression(node.yes)},truth(${this.expression(node.condition)}))`;
      case 'call': return this.call(node.name, node.args);
      case 'sequence': {
        if (node.values.length !== 1) throw new Error('Nested sequence is not GPU-pure');
        return this.expression(node.values[0]!);
      }
      case 'assign': throw new Error('Nested assignment is not GPU-pure');
    }
  }

  private binary(operator: string, leftNode: AvsEelNode, rightNode: AvsEelNode): string {
    const left = this.expression(leftNode);
    const right = this.expression(rightNode);
    switch (operator) {
      case '+': return `finite((${left})+(${right}))`;
      case '-': return `finite((${left})-(${right}))`;
      case '*': return `finite((${left})*(${right}))`;
      case '/': return `divide(${left},${right})`;
      case '%': return `modulo(${left},${right})`;
      case '**': return `finite(pow(${left},${right}))`;
      case '|': return `f32(i32(${left})|i32(${right}))`;
      case '&': return `f32(i32(${left})&i32(${right}))`;
      case '^': return `f32(i32(${left})^i32(${right}))`;
      case '<<': return `f32(i32(${left})<<(u32(i32(${right}))&31u))`;
      case '>>': return `f32(i32(${left})>>(u32(i32(${right}))&31u))`;
      case '&&': return `select(0.0,select(0.0,1.0,truth(${right})),truth(${left}))`;
      case '||': return `select(select(0.0,1.0,truth(${right})),1.0,truth(${left}))`;
      case '==': return `select(0.0,1.0,close(${left},${right}))`;
      case '!=': return `select(1.0,0.0,close(${left},${right}))`;
      case '===': return `select(0.0,1.0,(${left})==(${right}))`;
      case '!==': return `select(0.0,1.0,(${left})!=(${right}))`;
      case '<': case '<=': case '>': case '>=': return `select(0.0,1.0,(${left})${operator}(${right}))`;
      default: throw new Error(`Unsupported binary ${operator}`);
    }
  }

  private call(name: string, nodes: readonly AvsEelNode[]): string {
    if (name === 'if') return `select(${this.expression(nodes[2]!)},${this.expression(nodes[1]!)},truth(${this.expression(nodes[0]!)}))`;
    const args = nodes.map(node => this.expression(node));
    const one = (fn: string): string => `finite(${fn}(${args[0]}))`;
    const two = (fn: string): string => `finite(${fn}(${args[0]},${args[1]}))`;
    switch (name) {
      case 'sin': case 'cos': case 'tan': case 'asin': case 'acos': case 'atan':
      case 'sqrt': case 'exp': case 'log': case 'log2': case 'abs': case 'floor': case 'ceil':
        return one(name);
      case 'atan2': return two('atan2');
      case 'sqr': return `finite((${args[0]})*(${args[0]}))`;
      case 'invsqrt': return `finite(inverseSqrt(${args[0]}))`;
      case 'pow': case 'min': case 'max': return two(name);
      case 'log10': return `finite(log2(${args[0]})/log2(10.0))`;
      case 'int': return `finite(trunc(${args[0]}))`;
      case 'sign': return `select(select(0.0,1.0,(${args[0]})>0.0),-1.0,(${args[0]})<0.0)`;
      case 'equal': return `select(0.0,1.0,close(${args[0]},${args[1]}))`;
      case 'above': return `select(0.0,1.0,(${args[0]})>(${args[1]}))`;
      case 'below': return `select(0.0,1.0,(${args[0]})<(${args[1]}))`;
      case 'band': return `select(0.0,1.0,truth(${args[0]})&&truth(${args[1]}))`;
      case 'bor': return `select(0.0,1.0,truth(${args[0]})||truth(${args[1]}))`;
      case 'bnot': return `select(1.0,0.0,truth(${args[0]}))`;
      case 'getosc': return `avs_audio(0u,${args[0]},${args[1]},${args[2]})`;
      case 'getspec': return `avs_audio(1u,${args[0]},${args[1]},${args[2]})`;
      default: throw new Error(`Function ${name} is not supported by enhanced GPU SuperScope`);
    }
  }

  private variable(rawName: string): string {
    const raw = normalize(rawName);
    if (raw === '$pi') return '3.14159265358979323846';
    if (raw === '$e') return '2.71828182845904523536';
    if (raw === '$phi') return '1.61803398874989484820';
    const name = this.name(raw);
    if (INPUTS.has(raw) || this.localNames.has(name)) return name;
    const index = this.uniformIndex.get(raw);
    if (index === undefined) throw new Error(`Missing GPU input ${raw}`);
    return `initial[${index}u]`;
  }

  private name(rawName: string): string {
    const normalized = normalize(rawName).replace(/^\$/, '');
    return `v_${normalized.replace(/[^a-z0-9_]/g, '_')}`;
  }
}

function shaderSource(body: string, uniformNames: readonly string[], localNames: ReadonlySet<string>): string {
  const safeLocals = new Set(localNames);
  safeLocals.add('v_x'); safeLocals.add('v_y'); safeLocals.add('v_red'); safeLocals.add('v_green');
  safeLocals.add('v_blue'); safeLocals.add('v_skip'); safeLocals.add('v_drawmode'); safeLocals.add('v_linesize');
  const declarations = [...safeLocals].sort().map(name => {
    const raw = name.slice(2);
    const index = uniformNames.indexOf(raw);
    return `var ${name}: f32 = ${index < 0 ? '0.0' : `initial[${index}u]`};`;
  }).join('\n  ');
  return /* wgsl */ `
struct Params { count: u32, width: u32, height: u32, xor_mask: u32, variable_count: u32, _p0: u32, _p1: u32, _p2: u32 };
struct ScopePoint { x: i32, y: i32, color: u32, flags: u32 };
@group(0) @binding(0) var<storage, read> audio: array<u32>;
@group(0) @binding(1) var<storage, read> host_audio: array<u32>;
@group(0) @binding(2) var<storage, read> initial: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var<storage, read_write> points: array<ScopePoint>;

fn finite(value: f32) -> f32 { return select(0.0, value, value == value && abs(value) <= 3.402823e38); }
fn truth(value: f32) -> bool { return abs(value) >= 0.00001; }
fn close(a: f32, b: f32) -> bool { return abs(a - b) < 0.00001; }
fn divide(a: f32, b: f32) -> f32 { return select(finite(a / b), 0.0, abs(b) < 1.1920929e-7); }
fn modulo(a: f32, b: f32) -> f32 { return select(finite(a % b), 0.0, abs(b) < 1.1920929e-7); }
fn byte(value: f32) -> u32 { return u32(clamp(value, 0.0, 1.0) * 255.0); }
fn avs_audio(kind: u32, band: f32, width: f32, channel_value: f32) -> f32 {
  let channel = i32(floor(channel_value + 0.5));
  if (channel < 0 || channel > 2) { return 0.0; }
  var centre = i32(band * 576.0);
  var span = max(1, i32(width * 576.0));
  centre -= span / 2;
  if (centre < 0) { span += centre; centre = 0; }
  centre = min(centre, 575);
  span = min(span, 576 - centre);
  if (span <= 0) { return 0.0; }
  var sum = 0.0;
  for (var sample = centre; sample < centre + span; sample++) {
    let base = kind * 1152u;
    let left_byte = host_audio[base + u32(sample)];
    let right_byte = host_audio[base + 576u + u32(sample)];
    var left = f32(left_byte) / 255.0;
    var right = f32(right_byte) / 255.0;
    if (kind == 0u) {
      left = f32(select(i32(left_byte), i32(left_byte) - 256, left_byte >= 128u)) / 127.5;
      right = f32(select(i32(right_byte), i32(right_byte) - 256, right_byte >= 128u)) / 127.5;
    }
    sum += select(select(left, right, channel == 2), (left + right) * 0.5, channel == 0);
  }
  return sum / f32(span);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn superscope_points(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= params.count) { return; }
  let audio_position = f32(index) * 576.0 / f32(params.count);
  let source_index = min(575u, u32(audio_position));
  let fraction = audio_position - f32(source_index);
  let a = f32(audio[source_index] ^ params.xor_mask);
  let b = f32(audio[min(575u, source_index + 1u)] ^ params.xor_mask);
  var v_v = (a * (1.0 - fraction) + b * fraction) / 128.0 - 1.0;
  var v_i = select(f32(index) / f32(params.count - 1u), 0.0, params.count == 1u);
  ${declarations}
  var _result = 0.0;
  ${body}
  let color = byte(v_blue) | (byte(v_green) << 8u) | (byte(v_red) << 16u);
  let skipped = select(0u, 1u, v_skip >= 0.00001);
  let line = select(0u, 2u, v_drawmode >= 0.00001);
  let line_size = u32(clamp(trunc(v_linesize + 0.5), 1.0, 255.0));
  points[index] = ScopePoint(
    i32(trunc((v_x + 1.0) * f32(params.width) * 0.5)),
    i32(trunc((v_y + 1.0) * f32(params.height) * 0.5)),
    color,
    skipped | line | (line_size << 8u),
  );
}`;
}

function assignmentExpression(operator: string, left: string, right: string): string {
  switch (operator) {
    case '=': return `finite(${right})`;
    case '+=': return `finite(${left}+(${right}))`;
    case '-=': return `finite(${left}-(${right}))`;
    case '*=': return `finite(${left}*(${right}))`;
    case '/=': return `divide(${left},${right})`;
    case '%=': return `modulo(${left},${right})`;
    case '|=': return `f32(i32(${left})|i32(${right}))`;
    case '&=': return `f32(i32(${left})&i32(${right}))`;
    case '^=': return `f32(i32(${left})^i32(${right}))`;
    case '**=': return `finite(pow(${left},${right}))`;
    default: throw new Error(`Unsupported assignment ${operator}`);
  }
}

function containsHostAudio(node: AvsEelNode): boolean {
  if (node.kind === 'call' && (node.name === 'getosc' || node.name === 'getspec')) return true;
  return children(node).some(containsHostAudio);
}

function children(node: AvsEelNode): readonly AvsEelNode[] {
  switch (node.kind) {
    case 'number': case 'variable': return [];
    case 'unary': return [node.value];
    case 'binary': return [node.left, node.right];
    case 'conditional': return [node.condition, node.yes, node.no];
    case 'assign': return [node.target, node.value];
    case 'call': return node.args;
    case 'sequence': return node.values;
  }
}

function storageBuffer(device: GPUDevice, label: string, size: number, extra: GPUBufferUsageFlags): GPUBuffer {
  return device.createBuffer({ label, size: Math.max(16, align(size, 16)), usage: GPUBufferUsage.STORAGE | extra });
}
function normalize(name: string): string { return name.toLowerCase().slice(0, 8); }
function numberLiteral(value: number): string {
  if (!Number.isFinite(value)) return '0.0';
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
}
function clampInt(value: number, minimum: number, maximum: number): number {
  const integer = Number.isFinite(value) ? Math.trunc(value) : 0;
  return integer < minimum ? minimum : integer > maximum ? maximum : integer;
}
function align(value: number, alignment: number): number { return Math.ceil(value / alignment) * alignment; }

function bindOrNull(source: string, vm: AvsEelVm): AvsEelBoundExecutor | null {
  if (!source.trim()) return null;
  let program: AvsEelProgram;
  try { program = compileAvsEel(source); } catch { return null; }
  return program.bind(vm);
}
function interpolatedScopeColor(colors: readonly number[], position: number): number {
  const index = Math.trunc(position / 64);
  const fraction = position & 63;
  const first = colors[index]!;
  const second = colors[(index + 1) % colors.length]!;
  const channel = (shift: number): number => Math.trunc(
    (((first >>> shift) & 255) * (63 - fraction) + ((second >>> shift) & 255) * fraction) / 64,
  );
  return channel(0) | (channel(8) << 8) | (channel(16) << 16);
}
function scopeGpuChannel(audio: AvsAudioFrame, selection: number, centered: Uint8Array): Uint8Array {
  const source = (selection & 4) !== 0 ? audio.spectrum : audio.waveform;
  const channel = selection & 3;
  if (channel < 2) return source[channel as 0 | 1];
  for (let index = 0; index < centered.length; index++) {
    centered[index] = (Math.trunc(signedByte(source[0][index]!) / 2) +
      Math.trunc(signedByte(source[1][index]!) / 2)) & 255;
  }
  return centered;
}
function signedByte(value: number): number { return value < 128 ? value : value - 256; }
function emptyAudioFrame(): AvsAudioFrame {
  return {
    waveform: [new Uint8Array(576), new Uint8Array(576)],
    spectrum: [new Uint8Array(576), new Uint8Array(576)],
    beat: false, beatLevel: 0,
  };
}
