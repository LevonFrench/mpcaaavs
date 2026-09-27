// The render graph executor — the thing that turns `layers.ts`'s pass plan into
// WebGPU commands.
//
// Plan §4.9 says the render graph IS the product, and this is it: a pipeline
// cache, a target pool, and one `execute` that walks a `StackPlan` in order,
// ping-ponging the accumulator, honouring per-layer blend, opacity and
// resolution scale, and wrapping every pass in the `GpuTimer` so §4.11's budget
// is measured rather than asserted.
//
// Three things it deliberately does NOT do, and must not be extended to do:
//
//   - It does not DECIDE anything. Which layers are live, how far through their
//     envelopes they are, and what the pass order is are all `layers.ts`'s
//     answers, arrived at with no GPU in sight so that the golden harness can
//     check them on a machine that has none (§4.7). This file consumes that
//     plan; if the plan is wrong the fix belongs there.
//   - It does not know what any layer DRAWS. Everything type-specific arrives
//     as a `PassDescriptor` (contracts.ts) and is looked up by `LayerSpec.type`.
//     A new source is a new descriptor and zero edits here.
//   - It does not present. The final tone map, bloom and grain belong to one
//     pass that owns display space (`present.wgsl`), and putting the swapchain
//     in here would mean the renderer had an opinion about what a frame looks
//     like rather than how it is assembled. `execute` returns the accumulated
//     HDR target and stops.
//
// The single most expensive mistake this file exists to prevent is creating GPU
// objects per frame. A `GPURenderPipeline` costs milliseconds to compile; at
// 120 fps there are 8.33 of them in the whole frame. Pipelines, shader modules,
// bind group layouts and bind groups are therefore all cached, and the caches
// are keyed on everything that can actually change — which for a bind group
// includes the identity of the textures it points at, because the accumulator
// swaps every pass and a stale bind group samples last pass's picture and looks
// almost right.

import {
  AUDIO_GROUP,
  type AudioGpu,
} from './audiogpu.ts';
import type {
  AudioSnapshot,
  BlendMode,
  LayerSpec,
  Palette,
  PaletteColor,
  ParamValue,
  PassContext,
  PassDescriptor,
  PassRegistry,
} from './contracts.ts';
import type { Gpu, Target } from './gpu.ts';
import { createSampler } from './gpu.ts';
import type { GpuTimer } from './gputimer.ts';
import { BLEND_PLANS, type PassPlan, type ResolvedLayer, type StackPlan } from './layers.ts';
import { packTransition, transitionWgslConstants, type TransitionSpec } from './director.ts';
import transitionWGSL from './shaders/transition.wgsl';

// ---------------------------------------------------------------------------
// The binding contract
//
// Fixed numbers, not derived ones. Five people are writing passes against this
// simultaneously and a layout that has to be inferred from the descriptor is a
// layout that two of them will infer differently. Bindings that a given
// descriptor does not ask for are simply absent from the layout; the numbers of
// the ones that remain never shift.
// ---------------------------------------------------------------------------

/** Group 0 is the pass. Group 1 is audio and is identical everywhere (`AUDIO_GROUP`). */
export const PASS_GROUP = 0;

export const PASS_BINDING = {
  /** Renderer-owned frame constants. Always present. See `PASS_COMMON_WGSL`. */
  common: 0,
  /** The accumulated frame, when `input === 'accumulator'`. */
  input: 1,
  /** Linear, clamp-to-edge. Paired with `input`. */
  sampler: 2,
  /** This layer's own previous output, when `history` is set. */
  history: 3,
  /** The pass's own uniform block, when `uniformFloats > 0`. */
  params: 4,
  /** First storage buffer. Subsequent ones follow in declaration order. */
  storage0: 5,
} as const;

/** f32 count of the `Common` block. Mirrors the struct in `PASS_COMMON_WGSL`. */
const COMMON_FLOATS = 20;

// Field offsets into the Common staging array, in FLOATS. Named for the same
// reason `audiogpu.ts` names its own: a bare index is how `bpm` and `dtBeats`
// quietly swap places and the result still looks like a plausible frame.
const C_RES = 0;        // vec2
const C_ASPECT = 2;
const C_OPACITY = 3;
const C_PROGRESS = 4;
const C_TIME = 5;
const C_BEATS = 6;
const C_BARS = 7;
const C_BPM = 8;
const C_DT_SEC = 9;
const C_DT_BEATS = 10;
const C_SEED = 11;
const C_COLOR = 12;     // vec4 — must land on a 16-byte boundary, and 48 does
const C_FRAME = 16;
// 17..19 are the struct's tail padding. Never written, never read.

/**
 * Prepend to every pass shader, exactly as `AUDIO_WGSL` is prepended to every
 * audio-reading one. Declares group 0 binding 0 and the fullscreen helper.
 *
 * The `Common` block is renderer-owned and identical for every pass, which is
 * what lets `opacity`, the envelope and the layer's palette colour arrive
 * without every descriptor having to remember to pack them. It does NOT apply
 * opacity for you — fixed-function blending has no per-draw multiplier, so a
 * pass that ignores `C.opacity` is a pass whose opacity slider does nothing.
 * Multiply your output by it. That is the one obligation this header imposes.
 *
 * `C.color` is the layer's palette slot already converted to LINEAR sRGB with
 * its intensity applied, so `rgb` may legitimately exceed 1.0 — that headroom
 * is what bloom looks for, and art-direction §2.4 says it belongs to the focal
 * element alone. Interpolating between colours is OKLCH work and happens on the
 * CPU in the palette module; by the time it reaches a shader it is linear.
 */
export const PASS_COMMON_WGSL = /* wgsl */`
// ---- pass common (generated by renderer.ts — keep in sync) -----------------
//
// std140-ish, explicit about every byte:
//   0  resolution.xy      8  aspect     12 opacity
//   16 progress          20 time        24 beats     28 bars
//   32 bpm               36 dtSec       40 dtBeats   44 seed
//   48 color (vec4 — 48 is the first legal 16-byte boundary past 44)
//   64 frame             68..79 padding            -> size 80
//
// No vec3 anywhere, deliberately: a vec3 aligns to 16 but occupies 12, so it
// drags four bytes of invisible padding that the TypeScript side has to know
// about and cannot see.
struct Common {
  resolution : vec2<f32>,   // attachment size in PIXELS, after resolution scale
  aspect     : f32,         // resolution.x / resolution.y
  opacity    : f32,         // spec.opacity * envelope. MULTIPLY YOUR OUTPUT BY THIS.
  progress   : f32,         // envelope 0..1 on its own
  time       : f32,         // audio-clock seconds (plan 4.6). Never a wall clock.
  beats      : f32,         // continuous beat position, fractional
  bars       : f32,         // beats / 4
  bpm        : f32,
  dtSec      : f32,         // for exp(-dt/tau) decay, and nothing else
  dtBeats    : f32,         // the correct step for anything that integrates
  seed       : f32,         // per-layer, integral, < 2^24 so f32 holds it exactly
  color      : vec4<f32>,   // palette slot: LINEAR rgb (may exceed 1.0) + intensity
  frame      : f32,
  _pad0      : f32,
  _pad1      : f32,
  _pad2      : f32,
};

@group(${PASS_GROUP}) @binding(${PASS_BINDING.common}) var<uniform> C : Common;

/**
 * The covering triangle. Three vertices, no vertex buffer — cheaper than a quad
 * and it has no diagonal seam. Call it from your own @vertex fn:
 *
 *   @vertex fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
 *     return fullscreenTriangle(vi);
 *   }
 */
fn fullscreenTriangle(vi : u32) -> vec4<f32> {
  let p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>( 3.0, -1.0), vec2<f32>(-1.0,  3.0),
  );
  return vec4<f32>(p[vi], 0.0, 1.0);
}

/** Normalised 0..1 coordinate of the current fragment. */
fn fragUV(frag : vec4<f32>) -> vec2<f32> {
  return frag.xy / C.resolution;
}
// ---- end pass common ------------------------------------------------------
`;

/**
 * Declarations for the optional group-0 bindings, generated to match whatever
 * the descriptor asked for.
 *
 * Offered so a pass author never types a binding number. The alternative —
 * everyone writing `@group(0) @binding(3)` by hand — validates perfectly right
 * up until someone adds a storage buffer and every later index shifts by one,
 * at which point the shader samples the wrong texture and reports nothing.
 */
export function passBindingsWGSL(desc: PassDescriptor): string {
  const lines: string[] = [];
  if (inputOf(desc) === 'accumulator') {
    lines.push(`@group(${PASS_GROUP}) @binding(${PASS_BINDING.input}) var src : texture_2d<f32>;`);
  }
  // One sampler serves both textures. It is declared whenever EITHER exists, not
  // only alongside `src` — a feedback layer that reads nothing but its own
  // history still has to sample it, and omitting the declaration there produces
  // a shader that will not compile against the layout the renderer built.
  if (inputOf(desc) === 'accumulator' || historyOf(desc)) {
    lines.push(`@group(${PASS_GROUP}) @binding(${PASS_BINDING.sampler}) var samp : sampler;`);
  }
  if (historyOf(desc)) {
    lines.push(`@group(${PASS_GROUP}) @binding(${PASS_BINDING.history}) var hist : texture_2d<f32>;`);
  }
  const storage = desc.storage ?? [];
  for (let i = 0; i < storage.length; i++) {
    const s = storage[i];
    if (!s) continue;
    lines.push(
      `@group(${PASS_GROUP}) @binding(${PASS_BINDING.storage0 + i}) ` +
      `var<storage, read> ${s.label} : array<f32>;`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Frame state
// ---------------------------------------------------------------------------

/**
 * Everything the renderer needs about the frame, read ONCE by the caller and
 * handed down whole.
 *
 * The same discipline as `AudioSnapshot`, for the same reason: passes that each
 * reach for "now" at the moment they happen to run disagree about when now is,
 * and the disagreement is invisible until two layers that should be locked
 * together visibly are not. It also makes the frame a pure function of this
 * struct, which is the whole of §4.7.
 */
export interface FrameState {
  /** In stack order, from `LayerStack.resolve`. Layers at progress 0 are already gone. */
  readonly resolved: readonly ResolvedLayer[];
  readonly audio: AudioSnapshot;
  readonly palette: Palette;
  /** Audio-clock seconds. */
  readonly time: number;
  /** Continuous beat position — `timeline.slotAt(t) / SLOTS_PER_BEAT`. */
  readonly beats: number;
  readonly bpm: number;
  /** Beats since the previous frame. */
  readonly dtBeats: number;
  /** Seconds since the previous frame. Fixed in golden mode. */
  readonly dtSeconds: number;
  /** Monotonic, deterministic. Not a wall clock and not a timestamp. */
  readonly frame: number;
}

// ---------------------------------------------------------------------------
// Target pool
// ---------------------------------------------------------------------------

/** A pooled render target. `uid` exists so bind groups can be cached by identity. */
export interface PooledTarget extends Target {
  readonly uid: number;
  readonly width: number;
  readonly height: number;
}

let nextUid = 1;

/**
 * Acquire/release `rgba16float` targets by size.
 *
 * A pool rather than a fixed set because per-layer resolution scaling (§4.11) is
 * a REQUIREMENT, not an optimisation — at 2560x1440@120 a single full-res pass
 * moves ~7.1 GB/s, and a quarter-res one moves 1/16 of that. The number of
 * distinct sizes in flight is therefore however many scales the preset uses,
 * which is not knowable ahead of time and changes when a slider moves.
 *
 * COPY_SRC and COPY_DST are on every target because the non-`replace` transform
 * path copies the accumulator into its destination before blending onto it (see
 * `transformPass`), and a usage flag that is missing shows up as a validation
 * error three passes later rather than where the target was made.
 */
class TargetPool {
  private readonly device: GPUDevice;
  private readonly format: GPUTextureFormat;
  private readonly free = new Map<string, PooledTarget[]>();
  private readonly all = new Set<PooledTarget>();

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  acquire(width: number, height: number, label: string): PooledTarget {
    const key = `${width}x${height}`;
    const bucket = this.free.get(key);
    const reused = bucket?.pop();
    if (reused) return reused;

    const texture = this.device.createTexture({
      label: `pool:${label}:${key}`,
      size: [width, height],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT
           | GPUTextureUsage.TEXTURE_BINDING
           | GPUTextureUsage.COPY_SRC
           | GPUTextureUsage.COPY_DST,
    });
    const target: PooledTarget = {
      texture, view: texture.createView(), uid: nextUid++, width, height,
    };
    this.all.add(target);
    return target;
  }

  release(target: PooledTarget): void {
    const key = `${target.width}x${target.height}`;
    let bucket = this.free.get(key);
    if (!bucket) { bucket = []; this.free.set(key, bucket); }
    // Guard against a double release putting one target in the pool twice, which
    // hands the same texture to two passes and produces a frame that is
    // simultaneously correct and not.
    if (!bucket.includes(target)) bucket.push(target);
  }

  /** Live target count. Reported by the overlay next to `StackPlan.targetCount`. */
  get size(): number { return this.all.size; }

  destroy(): void {
    for (const t of this.all) t.texture.destroy();
    this.all.clear();
    this.free.clear();
  }
}

// ---------------------------------------------------------------------------
// Renderer-owned shaders
//
// Two, and only two. Everything else in the frame belongs to a layer.
// ---------------------------------------------------------------------------

/**
 * Copy a texture onto the accumulator, scaled by `C.opacity`, with whatever
 * blend state the pipeline was built with.
 *
 * This is what makes per-layer resolution scaling possible at all: a pass that
 * renders at half res cannot write into a full-res attachment, so it renders
 * into a pooled half-res target and this upsamples the result into place. The
 * blit itself is full-res but is one bilinear tap, whereas the pass it replaces
 * may be a forty-tap warp — which is exactly the trade §4.11 asks for.
 */
const BLIT_WGSL = /* wgsl */`
${PASS_COMMON_WGSL}
@group(${PASS_GROUP}) @binding(${PASS_BINDING.input}) var src : texture_2d<f32>;
@group(${PASS_GROUP}) @binding(${PASS_BINDING.sampler}) var samp : sampler;

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  return fullscreenTriangle(vi);
}

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let c = textureSampleLevel(src, samp, fragUV(frag), 0.0);
  return c * C.opacity;
}
`;

/**
 * The `xor` blend, which is the one mode in §4.1 that fixed-function blending
 * cannot express (see `BLEND_PLANS` for the full argument).
 *
 * It reads BOTH sides, which is why `layers.ts` charges it a scratch target and
 * a second pass: a WebGPU render pass may not sample the attachment it writes.
 * The quantisation to 16 bits is arbitrary but has to be SOMETHING — a bitwise
 * XOR of two floats is not a defined image operation, so the mode only means
 * anything once both sides are integers. Values above 1.0 are clamped rather
 * than wrapped: wrapping HDR headroom into the low bits turns a bright
 * highlight into noise, which reads as a broken effect rather than a stylised
 * one.
 */
const XOR_WGSL = /* wgsl */`
${PASS_COMMON_WGSL}
@group(${PASS_GROUP}) @binding(${PASS_BINDING.input}) var src : texture_2d<f32>;
@group(${PASS_GROUP}) @binding(${PASS_BINDING.sampler}) var samp : sampler;
@group(${PASS_GROUP}) @binding(${PASS_BINDING.history}) var dst : texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  return fullscreenTriangle(vi);
}

fn q(v : vec3<f32>) -> vec3<u32> {
  return vec3<u32>(clamp(v, vec3<f32>(0.0), vec3<f32>(1.0)) * 65535.0);
}

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);
  let s = textureSampleLevel(src, samp, uv, 0.0);
  let d = textureSampleLevel(dst, samp, uv, 0.0);
  let x = vec3<f32>(q(s.rgb) ^ q(d.rgb)) / 65535.0;
  // Opacity crossfades back to the untouched destination, so the layer's
  // opacity slider means the same thing it does for every other blend.
  return vec4<f32>(mix(d.rgb, x, C.opacity), max(d.a, s.a));
}
`;

/**
 * Blends whose result is unchanged by first compositing the run against black.
 *
 * This is the gate on scaling a DRAW run. A draw at reduced resolution has to
 * land in a pooled target and be blitted up, and the pooled target starts
 * black — so `min` becomes min(x, 0) = 0, `multiply` becomes x * 0 = 0, and
 * `subtract` goes negative, none of which is what the user composed. For those
 * modes the run is rendered at full resolution instead and the scale is
 * ignored. Silently producing a black layer would be worse than spending the
 * bandwidth.
 *
 * Transforms are not restricted this way: they already write to a separate
 * target and the blend happens at composite time against the real destination.
 */
const SCALABLE_DRAW_BLENDS: ReadonlySet<BlendMode> = new Set<BlendMode>(['add', 'max', 'replace']);

/** Below this, a scale is treated as 1 and the indirection is skipped entirely. */
const SCALE_EPSILON = 0.001;

// ---------------------------------------------------------------------------
// Per-layer GPU resources
// ---------------------------------------------------------------------------

interface HistoryPair {
  read: PooledTarget;
  write: PooledTarget;
  /** `WxH` of the pair, so a resolution-scale change rebuilds it. */
  size: string;
}

/**
 * The compute stage gets its OWN copies of `common` and `params`.
 *
 * Not redundancy — a correctness requirement, and a subtle one. `writeBuffer`
 * enqueues against the QUEUE, not against a position in the command stream, so
 * every write issued during a frame lands before any command in that frame's
 * submit executes. Sharing one uniform buffer between the compute prepass and
 * the render pass therefore does not give the compute pass the values written
 * for it: it gives it the LAST values written that frame, which are the render
 * pass's. The two disagree about attachment size whenever the layer's draw is
 * promoted to full resolution, and the symptom is a compute shader that sizes
 * itself against the wrong viewport once in a while.
 */
interface LayerResources {
  /** Identity that owns persistent state. Same ID with a new type/seed is a new simulation. */
  readonly type: string;
  readonly seed: number;
  readonly common: GPUBuffer;
  params: GPUBuffer | null;
  paramFloats: number;
  computeCommon: GPUBuffer | null;
  computeParams: GPUBuffer | null;
  computeParamFloats: number;
  storage: GPUBuffer[];
  storageBytes: number[];
  history: HistoryPair | null;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export interface RendererDeps {
  readonly gpu: Gpu;
  readonly timer: GpuTimer;
  readonly audioGpu: AudioGpu;
}

export class Renderer {
  private readonly gpu: Gpu;
  private readonly device: GPUDevice;
  private readonly timer: GpuTimer;
  private readonly audioGpu: AudioGpu;
  private readonly sampler: GPUSampler;
  private readonly pool: TargetPool;

  private readonly registry = new Map<string, PassDescriptor>();

  // -- caches. Every one of these is keyed on everything that can change, and
  //    that is not paranoia: a pipeline cache keyed on the descriptor alone
  //    hands a swapchain-format pipeline to an HDR attachment, which is a
  //    validation error, and a bind group cache keyed on the layer alone hands
  //    the previous ping-pong side to a pass that wants the current one, which
  //    is not an error at all and merely looks like a one-frame lag.
  private readonly modules = new Map<string, GPUShaderModule>();
  private readonly renderPipelines = new Map<string, GPURenderPipeline>();
  private readonly computePipelines = new Map<string, GPUComputePipeline>();
  private readonly renderLayouts = new Map<string, GPUBindGroupLayout>();
  private readonly computeLayouts = new Map<string, GPUBindGroupLayout>();
  private readonly bindGroups = new Map<string, GPUBindGroup>();

  private readonly resources = new Map<string, LayerResources>();

  /** Ping-pong accumulator. `cur` is the frame so far; `spare` is where the next transform lands. */
  private cur: PooledTarget | null = null;
  private spare: PooledTarget | null = null;
  /** False until something has written `cur` this frame. Guards reading an undefined accumulator. */
  private accumCleared = false;

  /**
   * Uniform buffers for the renderer's OWN blits and composites, cycled per
   * frame. Several blits can be in flight in one encoder with different
   * opacities, and `queue.writeBuffer` is ordered against the whole submit
   * rather than against individual commands — so reusing one buffer would give
   * every blit in the frame the last opacity written to it.
   */
  private readonly utility: GPUBuffer[] = [];
  private utilityUsed = 0;
  private readonly transitionBuffers: GPUBuffer[] = [];
  private transitionUsed = 0;

  /** Staging for `Common`. Reused; 80 bytes per pass per frame is litter. */
  private readonly commonStage = new Float32Array(COMMON_FLOATS);
  private readonly transitionStage = new Float32Array(8);
  /** Staging for pass params. Grown on demand, never shrunk. */
  private paramStage = new Float32Array(64);

  /** 1x1 black, for a declared input binding that has nothing sensible to point at. */
  private blackView: GPUTextureView | null = null;

  /** Types warned about once. A per-frame console message is a per-frame allocation. */
  private readonly warned = new Set<string>();

  constructor(deps: RendererDeps) {
    this.gpu = deps.gpu;
    this.device = deps.gpu.device;
    this.timer = deps.timer;
    this.audioGpu = deps.audioGpu;
    this.sampler = createSampler(deps.gpu);
    this.pool = new TargetPool(deps.gpu.device, deps.gpu.hdrFormat);
  }

  // -- registration -------------------------------------------------------

  /** Register a layer type. Re-registering the same type replaces it and drops its cached pipelines. */
  register(...descs: readonly PassDescriptor[]): void {
    for (const desc of descs) {
      if (this.registry.has(desc.type)) this.evictType(desc.type);
      this.registry.set(desc.type, desc);
    }
  }

  get types(): PassRegistry { return this.registry; }

  // -- lifecycle ----------------------------------------------------------

  /**
   * The HDR frame `execute` last produced. What `present` should sample.
   *
   * Valid only after `execute` and only until the next one — it is a pooled
   * target and the pool will hand it out again.
   */
  get output(): Target {
    return this.ensureAccumulator();
  }

  /** Live pooled targets, for the debug overlay to compare against `StackPlan.targetCount`. */
  get targetCount(): number { return this.pool.size; }

  /**
   * Drop every size-dependent resource. Call after `gpu.resize` returns true.
   *
   * Feedback history goes with it, and that is correct rather than unfortunate:
   * a trail buffer stretched from one resolution to another is not the trail the
   * user was looking at, and §4.10 already establishes that stale feedback state
   * is the thing that makes a frame look inexplicably wrong.
   */
  resize(): void {
    this.cur = null;
    this.spare = null;
    for (const res of this.resources.values()) res.history = null;
    this.bindGroups.clear();
    this.pool.destroy();
  }

  /**
   * Clear only temporal history while preserving pipelines, storage buffers and
   * pooled render targets. A seek, source change, or deterministic test reset
   * must never reveal pixels accumulated before the new transport origin.
   */
  resetHistory(): void {
    for (const res of this.resources.values()) {
      if (!res.history) continue;
      this.pool.release(res.history.read);
      this.pool.release(res.history.write);
      res.history = null;
    }
    this.bindGroups.clear();
  }

  /**
   * Reset every per-layer temporal resource while preserving shared pipelines
   * and the target pool. This is the transport/preset boundary: feedback
   * textures and compute storage both contain playback history, so clearing
   * only one of them makes a seeded show depend on what was viewed beforehand.
   */
  resetLayerState(): void {
    for (const res of this.resources.values()) this.destroyLayer(res);
    this.resources.clear();
    this.bindGroups.clear();
  }

  destroy(): void {
    for (const res of this.resources.values()) this.destroyLayer(res);
    this.resources.clear();
    for (const b of this.utility) b.destroy();
    this.utility.length = 0;
    this.pool.destroy();
    this.bindGroups.clear();
    this.cur = null;
    this.spare = null;
  }

  /**
   * Forget per-layer state for layers no longer in the stack. Call on preset
   * load and after removing a layer.
   *
   * Not optional housekeeping: a feedback layer holds two full-res
   * `rgba16float` targets, which at 2560x1440 is 30 MB the pair. Editing a
   * preset a dozen times without this is 350 MB of orphaned trail buffers.
   */
  prune(keep: Iterable<string>): void {
    const alive = new Set(keep);
    for (const [id, res] of this.resources) {
      if (alive.has(id)) continue;
      this.destroyLayer(res);
      this.resources.delete(id);
    }
    this.bindGroups.clear();
  }

  private destroyLayer(res: LayerResources): void {
    res.common.destroy();
    res.params?.destroy();
    res.computeCommon?.destroy();
    res.computeParams?.destroy();
    for (const b of res.storage) b.destroy();
    if (res.history) {
      // Back to the pool rather than destroyed — the next feedback layer at the
      // same resolution reuses them, and target churn at 2K is measurable.
      this.pool.release(res.history.read);
      this.pool.release(res.history.write);
      res.history = null;
    }
  }

  // -- the frame ----------------------------------------------------------

  /**
   * Encode one frame of the plan. Returns the accumulated HDR target.
   *
   * Ordering, and why it is this ordering:
   *
   *   1. Every compute prepass, hoisted to the top. A merged draw run holds
   *      several layers, so there is no "immediately before" that is true for
   *      all of them; the only ordering that is the same for every member is
   *      "before everything", and the GPU overlaps them anyway.
   *   2. The passes, in plan order. `kind` decides the target rotation, not
   *      `swapsAccumulator` — the scaled path legitimately writes through a
   *      pooled target and lands back on the SAME accumulator side, so it does
   *      not swap even though the plan says a transform does. The plan's flag
   *      describes the logical shape; this decides the physical one.
   *
   * Layers whose envelope has expired never appear here at all: `resolve`
   * dropped them before `planStack` ever saw them, which is what makes "a layer
   * at 0 is a true no-op" (Phase 5 DoD) true. The `byId` lookup below is
   * belt-and-braces for a plan and a resolved list that have drifted apart, and
   * a pass with no surviving members is skipped rather than run empty. Pass
   * count is the budget (§4.11); an invisible pass has spent it.
   */
  execute(encoder: GPUCommandEncoder, plan: StackPlan, frame: FrameState): Target {
    const accumulator = this.ensureAccumulator();
    this.accumCleared = false;
    this.utilityUsed = 0;
    this.transitionUsed = 0;

    const byId = new Map<string, ResolvedLayer>();
    for (const r of frame.resolved) byId.set(r.layer.id, r);

    // 1. Compute prepasses.
    for (const r of frame.resolved) {
      const desc = this.descriptorFor(r);
      if (desc?.compute) this.runCompute(encoder, desc, r, frame, r.layer.spec.resolutionScale);
    }

    // Scratch produced by a `usesScratch` pass and consumed by the composite
    // that immediately follows it. One is enough for the whole stack, which is
    // `planStack`'s claim and is true because no two shader-blend layers can be
    // mid-flight at once.
    let scratch: PooledTarget | null = null;

    // 2. The passes.
    for (const pass of plan.passes) {
      const members: ResolvedLayer[] = [];
      for (const id of pass.layerIds) {
        const r = byId.get(id);
        if (r) members.push(r);
      }
      if (members.length === 0) continue;

      switch (pass.kind) {
        case 'draw':
          scratch = this.drawRun(encoder, pass, members, frame, scratch);
          break;
        case 'transform':
          scratch = this.transformRun(encoder, pass, members, frame, scratch);
          break;
        case 'feedback':
          this.feedbackPass(encoder, pass, members, frame);
          break;
        case 'composite':
          scratch = this.compositePass(encoder, pass, members, frame, scratch);
          break;
      }
    }

    if (scratch) this.pool.release(scratch);

    // An empty stack renders black — Phase 0's DoD, and the only path that
    // reaches here without having written the accumulator.
    if (!this.accumCleared) this.clearAccumulator(encoder);

    return this.cur ?? accumulator;
  }

  /** Snapshot the current HDR accumulator before a preset load reuses it. */
  captureOutput(encoder: GPUCommandEncoder): PooledTarget {
    const source = this.ensureAccumulator();
    const held = this.pool.acquire(source.width, source.height, 'transition-from');
    encoder.copyTextureToTexture(
      { texture: source.texture },
      { texture: held.texture },
      [source.width, source.height],
    );
    return held;
  }

  /** Composite a held outgoing frame with the live incoming accumulator. */
  transition(
    encoder: GPUCommandEncoder,
    from: PooledTarget,
    to: Target,
    spec: TransitionSpec,
    mix: number,
    seed: number,
    frame: FrameState,
  ): PooledTarget {
    const target = this.pool.acquire(this.gpu.width, this.gpu.height, 'transition-to');
    const code = [PASS_COMMON_WGSL, transitionWgslConstants(),
      `@group(${PASS_GROUP}) @binding(${PASS_BINDING.input}) var fromTex : texture_2d<f32>;`,
      `@group(${PASS_GROUP}) @binding(${PASS_BINDING.sampler}) var samp : sampler;`,
      `@group(${PASS_GROUP}) @binding(${PASS_BINDING.history}) var toTex : texture_2d<f32>;`,
      `@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> T : Trans;`,
      transitionWGSL,
    ].join('\n');
    const pipeline = this.utilityPipeline('transition', code, target.texture.format, 'replace', true, true);
    const common = this.nextUtilityBuffer();
    const c = this.commonStage;
    c.fill(0);
    c[C_RES] = target.width;
    c[C_RES + 1] = target.height;
    c[C_ASPECT] = target.width / Math.max(target.height, 1);
    c[C_OPACITY] = 1;
    c[C_TIME] = frame.time;
    c[C_BEATS] = frame.beats;
    c[C_BARS] = frame.beats / 4;
    c[C_BPM] = frame.bpm;
    c[C_DT_SEC] = frame.dtSeconds;
    c[C_DT_BEATS] = frame.dtBeats;
    c[C_FRAME] = frame.frame;
    this.device.queue.writeBuffer(common, 0, c);
    const params = this.nextTransitionBuffer();
    packTransition(spec, mix, seed, c[C_ASPECT], this.transitionStage);
    this.device.queue.writeBuffer(params, 0, this.transitionStage);
    const bind = this.device.createBindGroup({
      label: 'transition', layout: pipeline.getBindGroupLayout(PASS_GROUP), entries: [
        { binding: PASS_BINDING.common, resource: { buffer: common } },
        { binding: PASS_BINDING.input, resource: from.view },
        { binding: PASS_BINDING.sampler, resource: this.sampler },
        { binding: PASS_BINDING.history, resource: to.view },
        { binding: PASS_BINDING.params, resource: { buffer: params } },
      ],
    });
    const pass = this.timer.beginPass(encoder, target.view, 'transition', 'clear');
    pass.setPipeline(pipeline);
    pass.setBindGroup(PASS_GROUP, bind);
    pass.draw(3);
    this.timer.endPass(pass);
    return target;
  }

  /** A caller-owned snapshot or transition target is safe to return after encoding. */
  releaseTarget(target: PooledTarget): void { this.pool.release(target); }

  // -- pass kinds ---------------------------------------------------------

  /**
   * A run of sources (and fixed-function feedback composites) drawn into the
   * accumulator with fixed-function blending.
   *
   * N sources are N draw calls into one attachment, not N passes — a source
   * does not read the accumulator, so there is nothing to ping-pong. That is the
   * single biggest saving available at 2K120 and it is `planStack` that found
   * it; all this does is honour it.
   */
  private drawRun(
    encoder: GPUCommandEncoder,
    plan: PassPlan,
    members: readonly ResolvedLayer[],
    frame: FrameState,
    scratch: PooledTarget | null,
  ): PooledTarget | null {
    const cur = this.ensureAccumulator();
    const scale = clampScale(plan.resolutionScale);

    // Scaling a draw run needs every member's blend to survive being composited
    // against black first. See SCALABLE_DRAW_BLENDS.
    const scalable = scale < 1 - SCALE_EPSILON
      && members.every((m) => SCALABLE_DRAW_BLENDS.has(m.layer.blend));

    let target: PooledTarget;
    let load: GPULoadOp;
    if (plan.usesScratch) {
      target = this.pool.acquire(...this.sizeFor(scale), plan.label);
      load = 'clear';
    } else if (scalable) {
      target = this.pool.acquire(...this.sizeFor(scale), plan.label);
      load = 'clear';
    } else {
      target = cur;
      load = this.accumCleared ? 'load' : 'clear';
      this.accumCleared = true;
    }

    const pass = this.timer.beginPass(encoder, target.view, plan.label, load);
    for (const m of members) {
      if (m.layer.spec.family === 'feedback') {
        // `planStack` folds a fixed-function feedback composite into a draw run
        // because compositing a finished texture IS a source draw. The texture
        // is the layer's own history, not a pass to be re-run — running the
        // feedback shader again here would advance the trail twice per frame.
        const history = this.resourcesFor(m).history;
        if (!history) continue;
        this.encodeBlit(pass, history.read, target, m.layer.blend, m.opacity, frame, m);
        continue;
      }
      this.encodeLayerDraw(pass, target, m, frame, m.layer.blend);
    }
    this.timer.endPass(pass);

    if (plan.usesScratch) {
      if (scratch) this.pool.release(scratch);
      return target;
    }
    if (scalable) {
      // Composite the run in one go with the blend its members share. They do
      // share it in every case that reaches here: a mixed-blend run is only
      // scalable if every mode is in the allowlist, and every mode in the
      // allowlist composites associatively.
      const first = members[0];
      if (first) {
        this.blitPass(encoder, target, cur, first.layer.blend, 1, frame, first, `${plan.label}:up`);
      }
      this.pool.release(target);
    }
    return scratch;
  }

  /**
   * Warps, operators and colour ops: sample the accumulator, write elsewhere.
   *
   * `planStack` merges consecutive colour layers into one `transform` on the
   * grounds that a run of per-pixel functions is a chain a single shader could
   * apply in sequence. That shader does not exist yet — composing N descriptors'
   * fragment bodies into one module is a real feature, not a detail — so a
   * multi-member run is executed here as N sequential passes, which is correct
   * but does not yet collect the saving. It is the one place the plan promises
   * more than this file delivers, and it is visible rather than silent because
   * each member is timed under its own label.
   */
  private transformRun(
    encoder: GPUCommandEncoder,
    plan: PassPlan,
    members: readonly ResolvedLayer[],
    frame: FrameState,
    scratch: PooledTarget | null,
  ): PooledTarget | null {
    this.requireAccumulator(encoder);
    const scale = clampScale(plan.resolutionScale);
    const scaled = scale < 1 - SCALE_EPSILON;
    let carried = scratch;

    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      if (!m) continue;
      const cur = this.ensureAccumulator();
      const label = members.length > 1 ? `transform:${m.layer.id}` : plan.label;

      if (plan.usesScratch) {
        // Feeds a shader blend. Write the raw transform result; the composite
        // that follows does the blending.
        const target = this.pool.acquire(...this.sizeFor(scale), label);
        const pass = this.timer.beginPass(encoder, target.view, label, 'clear');
        this.encodeLayerDraw(pass, target, m, frame, 'replace', cur);
        this.timer.endPass(pass);
        if (carried) this.pool.release(carried);
        carried = target;
        continue;
      }

      if (scaled) {
        // Reduced-res result, then one bilinear blit up with the layer's blend.
        // The blend lands against the real accumulator here, so ANY mode is
        // valid on this path — unlike the draw case.
        const target = this.pool.acquire(...this.sizeFor(scale), label);
        const pass = this.timer.beginPass(encoder, target.view, label, 'clear');
        this.encodeLayerDraw(pass, target, m, frame, 'replace', cur);
        this.timer.endPass(pass);
        this.blitPass(encoder, target, cur, m.layer.blend, 1, frame, m, `${label}:up`);
        this.pool.release(target);
        continue;
      }

      const spare = this.ensureSpare();
      let load: GPULoadOp = 'clear';
      if (m.layer.blend !== 'replace') {
        // The blend needs the accumulated frame as its DESTINATION, and the
        // destination here is `spare`, which holds the frame from two swaps ago.
        // Copy first. One full-res copy for the uncommon case is cheaper than
        // the alternative, which is every warp and operator shader implementing
        // ten blend modes itself.
        encoder.copyTextureToTexture(
          { texture: cur.texture }, { texture: spare.texture },
          [cur.width, cur.height],
        );
        load = 'load';
      }
      const pass = this.timer.beginPass(encoder, spare.view, label, load);
      this.encodeLayerDraw(pass, spare, m, frame, m.layer.blend, cur);
      this.timer.endPass(pass);
      this.swap();
    }
    return carried;
  }

  /**
   * A feedback layer advancing its own history.
   *
   * It reads its own previous output (`hist`) and may also read the accumulator
   * (`src`), which is what separates a trail that decays in place from one that
   * captures the frame beneath it. It does NOT touch the accumulator — the
   * composite is a separate plan entry, and keeping them apart is what lets a
   * feedback layer have any blend mode at all.
   */
  private feedbackPass(
    encoder: GPUCommandEncoder,
    plan: PassPlan,
    members: readonly ResolvedLayer[],
    frame: FrameState,
  ): void {
    const m = members[0];
    if (!m) return;
    const desc = this.descriptorFor(m);
    if (!desc) return;

    const res = this.resourcesFor(m);
    const scale = clampScale(plan.resolutionScale);
    const [w, h] = this.sizeFor(scale);
    const size = `${w}x${h}`;
    if (!res.history || res.history.size !== size) {
      if (res.history) {
        this.pool.release(res.history.read);
        this.pool.release(res.history.write);
      }
      const pair: HistoryPair = {
        read: this.pool.acquire(w, h, `${m.layer.id}:fb-a`),
        write: this.pool.acquire(w, h, `${m.layer.id}:fb-b`),
        size,
      };
      // Zero both sides before anything samples them. A pooled target arrives
      // holding whatever the last pass to use it left behind, and the first
      // frame of a trail would therefore start from a stale picture — which is
      // §4.7's "feedback layers seed from the preset, not from whatever was in
      // the buffer" failing in the one way that still produces a plausible
      // image. Two clears, once per resolution change, is not a budget item.
      for (const t of [pair.read, pair.write]) {
        this.timer.endPass(this.timer.beginPass(encoder, t.view, `${m.layer.id}:fb-init`, 'clear'));
      }
      res.history = pair;
    }

    // Only bind the accumulator if the pass asked for it, and only once it
    // holds something. A feedback layer at the very bottom of the stack is
    // legitimate and must not read an uninitialised texture.
    let source: PooledTarget | null = null;
    if (inputOf(desc) === 'accumulator') {
      this.requireAccumulator(encoder);
      source = this.ensureAccumulator();
    }

    const pass = this.timer.beginPass(encoder, res.history.write.view, plan.label, 'clear');
    this.encodeLayerDraw(pass, res.history.write, m, frame, 'replace', source, res.history.read);
    this.timer.endPass(pass);

    // Swap so the entry that composites this layer reads what we just wrote.
    const t = res.history.read;
    res.history.read = res.history.write;
    res.history.write = t;
  }

  /**
   * Resolve a `shader` blend — today `xor` alone, per `BLEND_PLANS`.
   *
   * Samples the source (the scratch target, or a feedback layer's own history)
   * and the accumulator, and writes the result to the other accumulator side.
   * Both sides are inputs, which is the entire reason this costs a pass: a
   * render pass may not sample its own attachment.
   */
  private compositePass(
    encoder: GPUCommandEncoder,
    plan: PassPlan,
    members: readonly ResolvedLayer[],
    frame: FrameState,
    scratch: PooledTarget | null,
  ): PooledTarget | null {
    const m = members[0];
    if (!m) return scratch;
    this.requireAccumulator(encoder);
    const cur = this.ensureAccumulator();
    const spare = this.ensureSpare();

    let source: PooledTarget | null = scratch;
    if (plan.feedbackSlot) source = this.resourcesFor(m).history?.read ?? null;
    if (!source) return scratch;

    const pipeline = this.utilityPipeline('xor', XOR_WGSL, this.gpu.hdrFormat, 'replace', true);
    const common = this.nextUtilityBuffer();
    this.writeCommon(common, m, frame, spare.width, spare.height, m.opacity);

    const bind = this.device.createBindGroup({
      label: plan.label,
      layout: pipeline.getBindGroupLayout(PASS_GROUP),
      entries: [
        { binding: PASS_BINDING.common, resource: { buffer: common } },
        { binding: PASS_BINDING.input, resource: source.view },
        { binding: PASS_BINDING.sampler, resource: this.sampler },
        { binding: PASS_BINDING.history, resource: cur.view },
      ],
    });

    const pass = this.timer.beginPass(encoder, spare.view, plan.label, 'clear');
    pass.setPipeline(pipeline);
    pass.setBindGroup(PASS_GROUP, bind);
    pass.draw(3);
    this.timer.endPass(pass);
    this.swap();

    if (scratch) this.pool.release(scratch);
    return null;
  }

  // -- encoding primitives ------------------------------------------------

  /** Set up and issue one layer's draw inside an already-open render pass. */
  private encodeLayerDraw(
    pass: GPURenderPassEncoder,
    target: PooledTarget,
    m: ResolvedLayer,
    frame: FrameState,
    blend: BlendMode,
    source: PooledTarget | null = null,
    history: PooledTarget | null = null,
  ): void {
    const desc = this.descriptorFor(m);
    if (!desc) return;

    const ctx = this.contextFor(m, frame, target.width, target.height);
    const res = this.resourcesFor(m);

    this.writeCommon(res.common, m, frame, target.width, target.height, m.opacity);
    this.writeParams(desc, res, ctx, 'render');

    const pipeline = this.renderPipeline(desc, target.texture.format, blend);
    const bind = this.bindGroupFor(desc, m, res, source, history);

    pass.setPipeline(pipeline);
    pass.setBindGroup(PASS_GROUP, bind);
    if (desc.usesAudio) pass.setBindGroup(AUDIO_GROUP, this.audioGpu.bindGroup);

    // `setBlendConstant` is ENCODER state, not pipeline state, and it defaults
    // to zero — a `50/50` layer whose constant was never set renders completely
    // invisible rather than merely wrong, which is the hardest kind of bug to
    // spot. Setting it per draw is what lets two `adjustable` layers with
    // different mixes still share one render pass.
    if (m.blendConstant !== null) {
      const c = m.blendConstant;
      pass.setBlendConstant({ r: c, g: c, b: c, a: c });
    }

    const draw = desc.draw ?? { kind: 'fullscreen' as const };
    if (draw.kind === 'fullscreen') {
      pass.draw(3);
    } else {
      const n = Math.max(0, Math.floor(draw.vertexCount(ctx)));
      if (n > 0) pass.draw(n);
    }
  }

  /** A blit issued inside an already-open render pass (a member of a draw run). */
  private encodeBlit(
    pass: GPURenderPassEncoder,
    source: PooledTarget,
    target: PooledTarget,
    blend: BlendMode,
    opacity: number,
    frame: FrameState,
    m: ResolvedLayer,
  ): void {
    const pipeline = this.utilityPipeline('blit', BLIT_WGSL, target.texture.format, blend, false);
    const common = this.nextUtilityBuffer();
    this.writeCommon(common, m, frame, target.width, target.height, opacity);
    const bind = this.device.createBindGroup({
      label: `blit:${m.layer.id}`,
      layout: pipeline.getBindGroupLayout(PASS_GROUP),
      entries: [
        { binding: PASS_BINDING.common, resource: { buffer: common } },
        { binding: PASS_BINDING.input, resource: source.view },
        { binding: PASS_BINDING.sampler, resource: this.sampler },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(PASS_GROUP, bind);
    if (m.blendConstant !== null) {
      const c = m.blendConstant;
      pass.setBlendConstant({ r: c, g: c, b: c, a: c });
    }
    pass.draw(3);
  }

  /** A blit that owns its own render pass, so it gets its own timer row. */
  private blitPass(
    encoder: GPUCommandEncoder,
    source: PooledTarget,
    target: PooledTarget,
    blend: BlendMode,
    opacity: number,
    frame: FrameState,
    m: ResolvedLayer,
    label: string,
  ): void {
    const load: GPULoadOp = target === this.cur && !this.accumCleared ? 'clear' : 'load';
    if (target === this.cur) this.accumCleared = true;
    const pass = this.timer.beginPass(encoder, target.view, label, load);
    this.encodeBlit(pass, source, target, blend, opacity, frame, m);
    this.timer.endPass(pass);
  }

  /** Dispatch a source's compute prepass. */
  private runCompute(
    encoder: GPUCommandEncoder,
    desc: PassDescriptor,
    m: ResolvedLayer,
    frame: FrameState,
    scale: number,
  ): void {
    const compute = desc.compute;
    if (!compute) return;
    const [w, h] = this.sizeFor(clampScale(scale));
    const ctx = this.contextFor(m, frame, w, h);
    const res = this.resourcesFor(m);

    if (!res.computeCommon) {
      res.computeCommon = this.device.createBuffer({
        label: `common:${m.layer.id}:compute`,
        size: COMMON_FLOATS * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.bindGroups.clear();
    }
    this.writeCommon(res.computeCommon, m, frame, w, h, m.opacity);
    this.writeParams(desc, res, ctx, 'compute');

    const pipeline = this.computePipeline(desc);
    const bind = this.computeBindGroup(desc, m, res);
    const wg = compute.workgroups(ctx);
    const [x, y, z] = typeof wg === 'number' ? [wg, 1, 1] : wg;
    if (x <= 0) return;

    const pass = this.timer.beginComputePass(encoder, `compute:${m.layer.id}`);
    pass.setPipeline(pipeline);
    pass.setBindGroup(PASS_GROUP, bind);
    if (desc.usesAudio) pass.setBindGroup(AUDIO_GROUP, this.audioGpu.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(x), Math.ceil(y), Math.ceil(z));
    this.timer.endPass(pass);
  }

  // -- accumulator --------------------------------------------------------

  private ensureAccumulator(): PooledTarget {
    if (!this.cur) this.cur = this.pool.acquire(this.gpu.width, this.gpu.height, 'accum-a');
    return this.cur;
  }

  private ensureSpare(): PooledTarget {
    if (!this.spare) this.spare = this.pool.acquire(this.gpu.width, this.gpu.height, 'accum-b');
    return this.spare;
  }

  private swap(): void {
    const t = this.cur;
    this.cur = this.spare;
    this.spare = t;
    this.accumCleared = true;
  }

  /**
   * Guarantee the accumulator holds something before a pass SAMPLES it.
   *
   * Reading a target that has not been written this frame is not an error and
   * does not warn — it silently returns whatever the pool last left there, which
   * is usually a plausible-looking frame from a different part of the show. That
   * is exactly the class of bug that gets diagnosed as "the warp is broken".
   */
  private requireAccumulator(encoder: GPUCommandEncoder): void {
    if (!this.accumCleared) this.clearAccumulator(encoder);
  }

  private clearAccumulator(encoder: GPUCommandEncoder): void {
    const cur = this.ensureAccumulator();
    const pass = this.timer.beginPass(encoder, cur.view, 'accum:clear', 'clear');
    this.timer.endPass(pass);
    this.accumCleared = true;
  }

  /** Attachment size for a resolution scale. Never zero; a 1px target is still a valid one. */
  private sizeFor(scale: number): [number, number] {
    if (scale >= 1 - SCALE_EPSILON) return [this.gpu.width, this.gpu.height];
    return [
      Math.max(1, Math.round(this.gpu.width * scale)),
      Math.max(1, Math.round(this.gpu.height * scale)),
    ];
  }

  // -- resources ----------------------------------------------------------

  private descriptorFor(m: ResolvedLayer): PassDescriptor | null {
    const spec = m.layer.spec;
    const desc = this.registry.get(spec.type);
    if (!desc) {
      this.warnOnce(`type:${spec.type}`, `no pass registered for type '${spec.type}' — layer '${spec.id}' will not render.`);
      return null;
    }
    if (desc.family !== spec.family) {
      // Family decides scheduling (`planStack` switches on it), so a descriptor
      // that disagrees with the spec has already been scheduled as the wrong
      // shape — the pass would run in a slot that binds the wrong inputs.
      this.warnOnce(
        `family:${spec.type}`,
        `layer '${spec.id}' declares family '${spec.family}' but pass '${desc.type}' is '${desc.family}'. Refusing to render it.`,
      );
      return null;
    }
    return desc;
  }

  private resourcesFor(m: ResolvedLayer): LayerResources {
    const id = m.layer.id;
    const existing = this.resources.get(id);
    if (existing) {
      // IDs are editable and survive hot preset replacement. Reusing a buffer
      // after either the algorithm or deterministic seed changes leaks the old
      // simulation into a logically new layer, even when its byte size matches.
      if (existing.type === m.layer.spec.type && existing.seed === m.layer.seed) {
        this.syncStorage(existing, m);
        return existing;
      }
      this.destroyLayer(existing);
      this.resources.delete(id);
      this.bindGroups.clear();
    }
    const created: LayerResources = {
      type: m.layer.spec.type,
      seed: m.layer.seed,
      common: this.device.createBuffer({
        label: `common:${id}`,
        size: COMMON_FLOATS * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
      params: null,
      paramFloats: 0,
      computeCommon: null,
      computeParams: null,
      computeParamFloats: 0,
      storage: [],
      storageBytes: [],
      history: null,
    };
    this.resources.set(id, created);
    this.syncStorage(created, m);
    return created;
  }

  /**
   * Allocate (or reallocate) the layer's persistent buffers.
   *
   * Per LAYER, not per type: two `lorenz` layers are two independent systems
   * with different seeds, and sharing one point buffer between them would make
   * them the same attractor drawn twice. They still share one pipeline, which is
   * the whole point of splitting the descriptor from the instance.
   */
  private syncStorage(res: LayerResources, m: ResolvedLayer): void {
    const desc = this.registry.get(m.layer.spec.type);
    const specs = desc?.storage ?? [];
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      if (!s) continue;
      const bytes = Math.max(4, Math.ceil(s.bytes(m.layer.spec.params) / 4) * 4);
      if (res.storageBytes[i] === bytes && res.storage[i]) continue;
      res.storage[i]?.destroy();
      const buffer = this.device.createBuffer({
        label: `${m.layer.id}:${s.label}`,
        size: bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      res.storage[i] = buffer;
      res.storageBytes[i] = bytes;
      // Seeded from the preset, never from whatever the driver left in the
      // allocation — §4.7 names this case explicitly, and an uninitialised
      // storage buffer is the one source of non-determinism that still produces
      // a picture and so never gets noticed.
      const view = new Float32Array(bytes / 4);
      s.init?.(view, m.layer.seed, m.layer.spec.params);
      this.device.queue.writeBuffer(buffer, 0, view);
      // The bind groups pointing at the old buffer are stale.
      this.bindGroups.clear();
    }
  }

  private nextUtilityBuffer(): GPUBuffer {
    const existing = this.utility[this.utilityUsed];
    if (existing) { this.utilityUsed++; return existing; }
    const buffer = this.device.createBuffer({
      label: `common:utility-${this.utilityUsed}`,
      size: COMMON_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.utility.push(buffer);
    this.utilityUsed++;
    return buffer;
  }

  private nextTransitionBuffer(): GPUBuffer {
    const existing = this.transitionBuffers[this.transitionUsed];
    if (existing) { this.transitionUsed++; return existing; }
    const buffer = this.device.createBuffer({
      label: `params:transition-${this.transitionUsed}`,
      size: 8 * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.transitionBuffers.push(buffer);
    this.transitionUsed++;
    return buffer;
  }

  // -- uniforms -----------------------------------------------------------

  private contextFor(m: ResolvedLayer, frame: FrameState, width: number, height: number): PassContext {
    const spec = m.layer.spec;
    return {
      spec,
      params: spec.params,
      progress: m.progress,
      opacity: m.opacity,
      seed: m.layer.seed,
      audio: frame.audio,
      palette: frame.palette,
      color: frame.palette[spec.palette],
      time: frame.time,
      beats: frame.beats,
      bars: frame.beats / 4,
      bpm: frame.bpm,
      dtBeats: frame.dtBeats,
      dtSeconds: frame.dtSeconds,
      width,
      height,
      aspect: height > 0 ? width / height : 1,
      frame: frame.frame,
    };
  }

  private writeCommon(
    buffer: GPUBuffer,
    m: ResolvedLayer,
    frame: FrameState,
    width: number,
    height: number,
    opacity: number,
  ): void {
    const s = this.commonStage;
    s[C_RES] = width;
    s[C_RES + 1] = height;
    s[C_ASPECT] = height > 0 ? width / height : 1;
    s[C_OPACITY] = opacity;
    s[C_PROGRESS] = m.progress;
    s[C_TIME] = frame.time;
    s[C_BEATS] = frame.beats;
    s[C_BARS] = frame.beats / 4;
    s[C_BPM] = frame.bpm;
    s[C_DT_SEC] = frame.dtSeconds;
    s[C_DT_BEATS] = frame.dtBeats;
    // Wrapped below 2^24 so f32 holds it EXACTLY. A 32-bit seed rounds on the
    // way into a float, so two layers whose seeds differ in the low bits would
    // arrive in the shader identical — a determinism bug that looks like a
    // missing feature.
    s[C_SEED] = m.layer.seed % 16_777_216;

    const rgb = oklchToLinear(frame.palette[m.layer.spec.palette]);
    s[C_COLOR] = rgb[0];
    s[C_COLOR + 1] = rgb[1];
    s[C_COLOR + 2] = rgb[2];
    s[C_COLOR + 3] = frame.palette[m.layer.spec.palette].intensity;
    s[C_FRAME] = frame.frame;

    this.device.queue.writeBuffer(buffer, 0, s);
  }

  private writeParams(
    desc: PassDescriptor,
    res: LayerResources,
    ctx: PassContext,
    stage: 'render' | 'compute',
  ): void {
    const floats = desc.uniformFloats ?? 0;
    if (floats <= 0) return;
    // Rounded to 4 floats: WGSL rounds a uniform struct's size up to a multiple
    // of its 16-byte alignment, and a buffer smaller than the struct the shader
    // declares is a validation error rather than a silent truncation.
    const padded = Math.ceil(floats / 4) * 4;
    const held = stage === 'render' ? res.params : res.computeParams;
    const heldFloats = stage === 'render' ? res.paramFloats : res.computeParamFloats;
    let buffer = held;
    if (!buffer || heldFloats !== padded) {
      held?.destroy();
      buffer = this.device.createBuffer({
        label: `params:${ctx.spec.id}:${stage}`,
        size: padded * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      if (stage === 'render') { res.params = buffer; res.paramFloats = padded; }
      else { res.computeParams = buffer; res.computeParamFloats = padded; }
      this.bindGroups.clear();
    }
    if (this.paramStage.length < padded) this.paramStage = new Float32Array(padded);
    const view = this.paramStage.subarray(0, padded);
    view.fill(0);
    desc.writeUniforms?.(view.subarray(0, floats), ctx);
    this.device.queue.writeBuffer(buffer, 0, view);
  }

  // -- layouts, pipelines, bind groups -------------------------------------

  private module(label: string, code: string): GPUShaderModule {
    const existing = this.modules.get(code);
    if (existing) return existing;
    const created = this.device.createShaderModule({ label, code });
    void created.getCompilationInfo().then((info) => {
      const errors = info.messages.filter((m) => m.type === 'error');
      if (errors.length) console.error(`[aaavs] shader ${label}:`, errors.map((m) => m.message).join('\n'));
    });
    this.modules.set(code, created);
    return created;
  }

  /** Shape key: everything that changes the bind group layout, and nothing else. */
  private shapeKey(desc: PassDescriptor): string {
    return [
      inputOf(desc) === 'accumulator' ? 'i' : '-',
      historyOf(desc) ? 'h' : '-',
      (desc.uniformFloats ?? 0) > 0 ? 'p' : '-',
      (desc.storage?.length ?? 0),
    ].join('');
  }

  private renderLayout(desc: PassDescriptor): GPUBindGroupLayout {
    const key = this.shapeKey(desc);
    const existing = this.renderLayouts.get(key);
    if (existing) return existing;

    const vis = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const entries: GPUBindGroupLayoutEntry[] = [
      { binding: PASS_BINDING.common, visibility: vis, buffer: { type: 'uniform' } },
    ];
    if (inputOf(desc) === 'accumulator') {
      entries.push({ binding: PASS_BINDING.input, visibility: vis, texture: { sampleType: 'float' } });
      entries.push({ binding: PASS_BINDING.sampler, visibility: vis, sampler: { type: 'filtering' } });
    }
    if (historyOf(desc)) {
      // A feedback pass that does not otherwise read the accumulator still needs
      // a sampler for its own history, so the sampler is added here too when the
      // input binding did not already bring one.
      if (inputOf(desc) !== 'accumulator') {
        entries.push({ binding: PASS_BINDING.sampler, visibility: vis, sampler: { type: 'filtering' } });
      }
      entries.push({ binding: PASS_BINDING.history, visibility: vis, texture: { sampleType: 'float' } });
    }
    if ((desc.uniformFloats ?? 0) > 0) {
      entries.push({ binding: PASS_BINDING.params, visibility: vis, buffer: { type: 'uniform' } });
    }
    const storage = desc.storage ?? [];
    for (let i = 0; i < storage.length; i++) {
      // read-only-storage, not storage: a writable storage binding is not
      // visible to a vertex stage, and the vertex stage is exactly what reads
      // this. The compute side gets its own layout where it is writable.
      entries.push({
        binding: PASS_BINDING.storage0 + i,
        visibility: vis,
        buffer: { type: 'read-only-storage' },
      });
    }
    const created = this.device.createBindGroupLayout({ label: `pass:${key}`, entries });
    this.renderLayouts.set(key, created);
    return created;
  }

  private computeLayout(desc: PassDescriptor): GPUBindGroupLayout {
    const key = `c${this.shapeKey(desc)}`;
    const existing = this.computeLayouts.get(key);
    if (existing) return existing;
    const vis = GPUShaderStage.COMPUTE;
    const entries: GPUBindGroupLayoutEntry[] = [
      { binding: PASS_BINDING.common, visibility: vis, buffer: { type: 'uniform' } },
    ];
    if ((desc.uniformFloats ?? 0) > 0) {
      entries.push({ binding: PASS_BINDING.params, visibility: vis, buffer: { type: 'uniform' } });
    }
    const storage = desc.storage ?? [];
    for (let i = 0; i < storage.length; i++) {
      entries.push({
        binding: PASS_BINDING.storage0 + i,
        visibility: vis,
        buffer: { type: 'storage' },
      });
    }
    const created = this.device.createBindGroupLayout({ label: key, entries });
    this.computeLayouts.set(key, created);
    return created;
  }

  /**
   * The pipeline cache. Keyed on (type, target format, blend).
   *
   * All three matter. Format because an HDR pipeline bound to the swapchain is a
   * validation error; blend because the blend state is baked into the pipeline
   * and the same layer type appears at different blends in the same preset.
   * Nothing else about a pass varies at runtime, which is why the descriptor's
   * WGSL can be compiled once and reused for the lifetime of the page.
   *
   * `layout: 'auto'` is deliberately NOT used. An auto layout is private to its
   * pipeline, so a bind group made for one cannot be set on another — and the
   * audio bind group (`audiogpu.ts`) is one object shared by every pass in the
   * project. Explicit layouts are the only way that sharing works.
   */
  private renderPipeline(
    desc: PassDescriptor,
    format: GPUTextureFormat,
    blend: BlendMode,
  ): GPURenderPipeline {
    const key = `${desc.type}|${format}|${blend}`;
    const existing = this.renderPipelines.get(key);
    if (existing) return existing;

    const plan = BLEND_PLANS[blend];
    // A shader blend has no fixed-function state; the pass that feeds the
    // composite writes its raw result, so it is a straight overwrite.
    const state = plan.implementation === 'shader'
      ? BLEND_PLANS.replace.state
      : plan.state;

    const module = this.module(desc.type, desc.code);
    const layouts: GPUBindGroupLayout[] = [this.renderLayout(desc)];
    if (desc.usesAudio) layouts[AUDIO_GROUP] = this.audioGpu.layout;

    const created = this.device.createRenderPipeline({
      label: key,
      layout: this.device.createPipelineLayout({ label: key, bindGroupLayouts: layouts }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format, blend: state }] },
      primitive: { topology: 'triangle-list' },
    });
    this.renderPipelines.set(key, created);
    return created;
  }

  private computePipeline(desc: PassDescriptor): GPUComputePipeline {
    const compute = desc.compute;
    if (!compute) throw new Error(`pass '${desc.type}' has no compute stage`);
    const key = `${desc.type}|compute`;
    const existing = this.computePipelines.get(key);
    if (existing) return existing;

    const layouts: GPUBindGroupLayout[] = [this.computeLayout(desc)];
    if (desc.usesAudio) layouts[AUDIO_GROUP] = this.audioGpu.layout;
    const created = this.device.createComputePipeline({
      label: key,
      layout: this.device.createPipelineLayout({ label: key, bindGroupLayouts: layouts }),
      compute: {
        module: this.module(`${desc.type}:compute`, compute.code),
        entryPoint: compute.entryPoint ?? 'main',
      },
    });
    this.computePipelines.set(key, created);
    return created;
  }

  /**
   * Bind groups, cached by everything they point at.
   *
   * The texture uids are in the key because the accumulator swaps sides every
   * transform. A cache keyed on the layer alone hands back a group aimed at the
   * OTHER side, which is not an error, renders happily, and shows the previous
   * pass's picture — the single hardest bug in this file to see. In the steady
   * state a layer produces at most a handful of entries (the accumulator
   * alternates between exactly two targets), so this allocates nothing per frame
   * once warmed.
   */
  private bindGroupFor(
    desc: PassDescriptor,
    m: ResolvedLayer,
    res: LayerResources,
    source: PooledTarget | null,
    history: PooledTarget | null,
  ): GPUBindGroup {
    const srcUid = source?.uid ?? 0;
    const histUid = history?.uid ?? 0;
    const key = `${m.layer.id}|${desc.type}|${srcUid}|${histUid}|${res.paramFloats}`;
    const existing = this.bindGroups.get(key);
    if (existing) return existing;

    const entries: GPUBindGroupEntry[] = [
      { binding: PASS_BINDING.common, resource: { buffer: res.common } },
    ];
    const wantsInput = inputOf(desc) === 'accumulator';
    if (wantsInput) {
      entries.push({ binding: PASS_BINDING.input, resource: source?.view ?? this.black() });
    }
    if (wantsInput || historyOf(desc)) {
      entries.push({ binding: PASS_BINDING.sampler, resource: this.sampler });
    }
    if (historyOf(desc)) {
      entries.push({ binding: PASS_BINDING.history, resource: history?.view ?? this.black() });
    }
    if (res.params) entries.push({ binding: PASS_BINDING.params, resource: { buffer: res.params } });
    for (let i = 0; i < res.storage.length; i++) {
      const buffer = res.storage[i];
      if (buffer) entries.push({ binding: PASS_BINDING.storage0 + i, resource: { buffer } });
    }

    const created = this.device.createBindGroup({
      label: key,
      layout: this.renderLayout(desc),
      entries,
    });
    this.cacheBindGroup(key, created);
    return created;
  }

  /**
   * Insert with a ceiling.
   *
   * In the steady state the cache holds a handful of entries per layer — the
   * accumulator alternates between exactly two targets — and never grows. It
   * only climbs when the set of targets churns, which happens when a resolution
   * scale is being dragged: every intermediate size mints new pooled targets
   * with new uids and therefore new keys. Bind groups keep their textures alive,
   * so an unbounded cache there is an unbounded texture leak. Dropping the lot
   * costs one frame of rebuilds and is invisible.
   */
  private cacheBindGroup(key: string, group: GPUBindGroup): void {
    if (this.bindGroups.size >= 512) this.bindGroups.clear();
    this.bindGroups.set(key, group);
  }

  private computeBindGroup(desc: PassDescriptor, m: ResolvedLayer, res: LayerResources): GPUBindGroup {
    const common = res.computeCommon;
    if (!common) throw new Error(`compute uniforms missing for layer '${m.layer.id}'`);
    const key = `c|${m.layer.id}|${desc.type}|${res.computeParamFloats}`;
    const existing = this.bindGroups.get(key);
    if (existing) return existing;
    const entries: GPUBindGroupEntry[] = [
      { binding: PASS_BINDING.common, resource: { buffer: common } },
    ];
    if (res.computeParams) entries.push({ binding: PASS_BINDING.params, resource: { buffer: res.computeParams } });
    for (let i = 0; i < res.storage.length; i++) {
      const buffer = res.storage[i];
      if (buffer) entries.push({ binding: PASS_BINDING.storage0 + i, resource: { buffer } });
    }
    const created = this.device.createBindGroup({
      label: key,
      layout: this.computeLayout(desc),
      entries,
    });
    this.cacheBindGroup(key, created);
    return created;
  }

  /** Blit and composite pipelines. Same cache, distinct key space. */
  private utilityPipeline(
    name: string,
    code: string,
    format: GPUTextureFormat,
    blend: BlendMode,
    readsDst: boolean,
    withParams = false,
  ): GPURenderPipeline {
    const key = `~${name}|${format}|${blend}`;
    const existing = this.renderPipelines.get(key);
    if (existing) return existing;

    const vis = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const entries: GPUBindGroupLayoutEntry[] = [
      { binding: PASS_BINDING.common, visibility: vis, buffer: { type: 'uniform' } },
      { binding: PASS_BINDING.input, visibility: vis, texture: { sampleType: 'float' } },
      { binding: PASS_BINDING.sampler, visibility: vis, sampler: { type: 'filtering' } },
    ];
    if (readsDst) {
      entries.push({ binding: PASS_BINDING.history, visibility: vis, texture: { sampleType: 'float' } });
    }
    if (withParams) {
      entries.push({ binding: PASS_BINDING.params, visibility: vis, buffer: { type: 'uniform' } });
    }
    const layout = this.device.createBindGroupLayout({ label: key, entries });
    const plan = BLEND_PLANS[blend];
    const created = this.device.createRenderPipeline({
      label: key,
      layout: this.device.createPipelineLayout({ label: key, bindGroupLayouts: [layout] }),
      vertex: { module: this.module(name, code), entryPoint: 'vs' },
      fragment: {
        module: this.module(name, code),
        entryPoint: 'fs',
        targets: [{ format, blend: plan.implementation === 'shader' ? BLEND_PLANS.replace.state : plan.state }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.renderPipelines.set(key, created);
    return created;
  }

  /** Drop everything compiled for a type. Called when a descriptor is replaced (hot reload). */
  private evictType(type: string): void {
    for (const key of [...this.renderPipelines.keys()]) {
      if (key.startsWith(`${type}|`)) this.renderPipelines.delete(key);
    }
    this.computePipelines.delete(`${type}|compute`);
    this.bindGroups.clear();
  }

  private black(): GPUTextureView {
    if (this.blackView) return this.blackView;
    const texture = this.device.createTexture({
      label: 'black-1x1',
      size: [1, 1],
      format: this.gpu.hdrFormat,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // rgba16float: four half-floats, all zero. Zeroed on creation, but written
    // explicitly so the value does not depend on the driver's initialisation.
    this.device.queue.writeTexture(
      { texture },
      new Uint16Array([0, 0, 0, 0]),
      { bytesPerRow: 8 },
      [1, 1],
    );
    this.blackView = texture.createView();
    return this.blackView;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[renderer] ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A source draws into the accumulator, so it cannot sample it; everything else reads it by definition. */
function inputOf(desc: PassDescriptor): 'none' | 'accumulator' {
  if (desc.input) return desc.family === 'source' && desc.input === 'accumulator' ? 'none' : desc.input;
  return desc.family === 'source' ? 'none' : 'accumulator';
}

function historyOf(desc: PassDescriptor): boolean {
  return desc.history ?? desc.family === 'feedback';
}

function clampScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return scale > 1 ? 1 : scale;
}

/**
 * OKLCH -> linear sRGB.
 *
 * Here rather than in a palette module because the renderer needs it on the
 * frame path and a cross-import for fifteen lines of arithmetic is a worse
 * trade than the duplication. If a palette module lands with its own copy, this
 * one goes and the import comes in — but the CONVERSION must stay identical,
 * because a colour that differs in the last bit fails the golden harness.
 *
 * Note there is no gamut clamp. Values outside sRGB, and above 1.0, are
 * deliberately preserved: the headroom is what bloom finds, and art-direction
 * §2.4 gives it to the focal element specifically.
 */
function oklchToLinear(c: PaletteColor): [number, number, number] {
  const h = (c.h * Math.PI) / 180;
  const a = c.c * Math.cos(h);
  const b = c.c * Math.sin(h);

  const l_ = c.l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = c.l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = c.l - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const k = c.intensity;
  return [
    (4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s) * k,
    (-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s) * k,
    (-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s) * k,
  ];
}

// Re-exported so a pass module has one import for everything it needs to
// describe itself. `contracts.ts` remains the definition; this is convenience,
// not a second source of truth.
export type {
  ComputeSpec,
  DrawSpec,
  PassContext,
  PassDescriptor,
  PassInput,
  PassRegistry,
  StorageSpec,
} from './contracts.ts';
export type { LayerSpec, ParamValue };
