// The ten blend modes of plan §4.1 — what each one means, which of them the
// hardware can do on its own, and how to reach the ones it cannot.
//
// The single question this file exists to answer accurately is: **is this mode
// expressible as a fixed-function `GPUBlendState`?** Getting that wrong does not
// produce an error. It produces an image that is silently, plausibly wrong —
// a `min` that is really a `max` because the factors were fiddled with, or an
// `xor` that quietly renders as `replace` because someone assumed WebGPU had
// logic-op blending. The answers below were taken from the WebGPU blending spec
// (`GPUBlendOperation`, `GPUBlendFactor`) rather than from memory, and the two
// findings that most often go the other way are recorded next to the data:
// `min` and `max` ARE blend operations, and `xor` is not expressible at all.
//
// Nine of ten are fixed-function. One is not.
//
// What this module deliberately does NOT do:
//
//   - It owns no GPU objects. Like `contracts.ts` it is data plus pure
//     functions, so the preset validator, the UI and the golden harness can all
//     ask what a blend mode is without a device in the room.
//   - It does not import `renderer.ts`, and must not. `renderer.ts` imports
//     `layers.ts`, and `layers.ts` is the natural consumer of this table, so an
//     import in that direction closes a cycle that shows up as a confusing
//     runtime `undefined` after bundling. The two binding numbers this module
//     needs are therefore re-stated below rather than imported.
//   - It does not decide when a shader composite runs, or encode one.
//     `layers.ts` charges the extra pass and the scratch target; `renderer.ts`
//     encodes it. This file says only what the pass must compute.
//
// NOTE for whoever integrates this: `layers.ts` currently carries its own copy
// of this table as `BLEND_PLANS`, written before this module existed. The two
// agree by construction — `BlendInfo` is a superset of `BlendPlan` and every
// state here is character-for-character the one there — so the merge is
// `export { BLEND_PLANS } from './blend.ts'` and a deletion. Leaving both is the
// one outcome to avoid: two tables of blend states diverge the first time
// somebody fixes one of them.

import type { BlendMode } from './contracts.ts';
import BLEND_WGSL from './shaders/blend.wgsl';

export { BLEND_WGSL };

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * How a mode is realised on the GPU.
 *
 * - `fixed` — a plain `GPUBlendState`. Free; the hardware does it as part of
 *   writing the pixel, and no extra target, pass or bandwidth is involved.
 * - `constant` — also fixed-function, but the mix amount lives in the blend
 *   CONSTANT, which is render-pass ENCODER state (`setBlendConstant`) and not
 *   pipeline state. It defaults to (0,0,0,0), so a pipeline that uses it and a
 *   caller that forgets to set it produces a completely invisible layer rather
 *   than a wrong-looking one — which is why it is worth its own category rather
 *   than being folded into `fixed`. The upside of it being encoder state: two
 *   `adjustable` layers with different amounts still share one render pass, by
 *   calling `setBlendConstant` between the draws.
 * - `shader` — not expressible as fixed-function blending at any setting. The
 *   layer renders to a scratch target and a second pass samples both scratch
 *   and destination, because a WebGPU render pass may not sample the attachment
 *   it is writing.
 */
export type BlendImplementation = 'fixed' | 'constant' | 'shader';

/**
 * Everything known about one blend mode.
 *
 * Structurally a superset of `layers.ts`'s `BlendPlan`, deliberately, so that
 * this table can replace that one without touching either's callers.
 */
export interface BlendInfo {
  readonly mode: BlendMode;
  /** For the layer UI. Sentence case; the mode key itself is not presentable. */
  readonly label: string;
  /** One line, for a tooltip. What it does, not how it is implemented. */
  readonly description: string;
  readonly implementation: BlendImplementation;
  /**
   * The fixed-function state, or absent when there is none. Absent exactly when
   * `needsShader` — the two are the same fact stated twice because callers
   * branch on one and read the other, and a caller that tests `state` for
   * undefined and one that tests `needsShader` must never be able to disagree.
   */
  readonly state?: GPUBlendState;
  /** True iff fixed-function blending cannot express this mode at all. */
  readonly needsShader: boolean;
  /**
   * True when producing the result needs the destination as a READABLE input,
   * as opposed to merely as a blend factor. This is the flag that costs a target
   * and a pass, so it is kept separate from `implementation` even though today
   * they coincide — `multiply` is the instructive case: it uses the destination
   * as a factor and still needs no read.
   */
  readonly readsDestination: boolean;
  /** The reference implementation in `shaders/blend.wgsl`. */
  readonly wgslFn: string;
  /** The `BLEND_MODE` pipeline constant selecting `wgslFn` in the composite pass. */
  readonly id: number;
  /**
   * True when `wgslFn` mixes through OKLab and therefore does NOT match `state`
   * pixel for pixel.
   *
   * Only the crossfades. Interpolating two hues in linear light walks straight
   * through the middle of the colour cube and desaturates on the way past —
   * art-direction §2.1's grey dead-zone — and OKLab is the fix. The hardware
   * cannot do it, so a preset that wants the better crossfade pays a pass for
   * it. Everything else here is light transport or coverage, where linear is
   * the physically correct answer and a perceptual space would be wrong; see
   * `blendAlpha`'s comment in the WGSL for the case that looks most like it
   * should be perceptual and is not.
   */
  readonly wgslIsPerceptual: boolean;
  /**
   * Whether multiplying the SOURCE by opacity fades the layer out to a true
   * no-op.
   *
   * This is the assumption the whole fixed-function path rests on: every pass
   * multiplies its output by `C.opacity` and there is no per-draw multiplier in
   * the API, so scaling the source is the only lever available. For half the
   * modes it is the wrong lever. `min` at opacity 0 scales its source to black
   * and min(D, 0) is black — fading the layer out fades the whole FRAME out.
   * `multiply` does the same. `50/50` at opacity 0 leaves half the destination.
   *
   * Where this is false and the opacity genuinely animates, route the layer
   * through the shader composite, which crossfades against the untouched
   * destination and is correct for every mode.
   *
   * Distinct from `renderer.ts`'s `SCALABLE_DRAW_BLENDS`, which asks a
   * different question — whether compositing a run against BLACK first and
   * blitting the result up preserves the image — and happens to exclude some of
   * the same modes for a related reason.
   */
  readonly opacityByScale: boolean;
  /** Why this mode is in the category it is in. Kept beside the data so it cannot rot apart from it. */
  readonly note: string;
}

// ---------------------------------------------------------------------------
// Blend components
//
// Named rather than inlined so that two modes claiming to do the same thing to
// alpha demonstrably do.
// ---------------------------------------------------------------------------

const SRC_ONLY: GPUBlendComponent = { operation: 'add', srcFactor: 'one', dstFactor: 'zero' };
const ONE_ONE: GPUBlendComponent = { operation: 'add', srcFactor: 'one', dstFactor: 'one' };
const KEEP_DST: GPUBlendComponent = { operation: 'add', srcFactor: 'zero', dstFactor: 'one' };
const CONSTANT_MIX: GPUBlendComponent = {
  operation: 'add', srcFactor: 'constant', dstFactor: 'one-minus-constant',
};

/**
 * `min` and `max` are genuine `GPUBlendOperation` values — this is the finding
 * most likely to be got wrong, because the operation set is usually thought of
 * as add/subtract and the min/max entries are easy to miss.
 *
 * WebGPU inherits the Vulkan and GL rule that the blend FACTORS are IGNORED
 * when the operation is `min` or `max`; the result is min(S, D) or max(S, D)
 * whatever they say. `one`/`one` is written here because it is the pair every
 * implementation agrees on and reads as intentional. Do not "tidy" it into
 * something more expressive: a factor that does nothing on one backend is a
 * validation error waiting to happen on another, and the failure would be at
 * pipeline creation on someone else's machine.
 */
function minMax(operation: 'min' | 'max'): GPUBlendComponent {
  return { operation, srcFactor: 'one', dstFactor: 'one' };
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * Declaration order of plan §4.1, which is also the order the layer UI lists
 * them in and — because it fixes `BlendInfo.id` — the numbering baked into
 * pipeline constants. Reordering this array renumbers the WGSL dispatch, so it
 * is not a free edit: append, never insert.
 */
export const BLEND_ORDER: readonly BlendMode[] = [
  'replace', 'add', 'max', 'min', '50/50',
  'subtract', 'multiply', 'xor', 'adjustable', 'alpha',
];

export const BLEND_INFO: Readonly<Record<BlendMode, BlendInfo>> = {
  replace: {
    mode: 'replace',
    label: 'Replace',
    description: 'Overwrites everything underneath.',
    implementation: 'fixed',
    state: { color: SRC_ONLY, alpha: SRC_ONLY },
    needsShader: false,
    readsDestination: false,
    wgslFn: 'blendReplace',
    id: 0,
    wgslIsPerceptual: false,
    // Scaling the source towards black is not a fade-out here, it is a fade to
    // BLACK — the destination has already been discarded. In practice a layer
    // never reaches a pass at progress 0 (`layers.ts` drops it), so this is a
    // statement about the mode rather than a bug waiting to happen.
    opacityByScale: false,
    note: 'Source only. The destination is discarded.',
  },
  add: {
    mode: 'add',
    label: 'Add',
    description: 'Accumulates light. The default for anything glowing.',
    implementation: 'fixed',
    state: { color: ONE_ONE, alpha: ONE_ONE },
    needsShader: false,
    readsDestination: false,
    wgslFn: 'blendAdd',
    id: 1,
    wgslIsPerceptual: false,
    opacityByScale: true,
    note: 'S + D. On rgba16float this genuinely accumulates instead of clipping at 1.0, which is the whole reason for the float targets (§3.2).',
  },
  max: {
    mode: 'max',
    label: 'Lighten',
    description: 'Keeps whichever side is brighter. Adds without blowing out.',
    implementation: 'fixed',
    state: { color: minMax('max'), alpha: minMax('max') },
    needsShader: false,
    readsDestination: false,
    wgslFn: 'blendMax',
    id: 2,
    wgslIsPerceptual: false,
    // max(D, S*o) -> max(D, 0) = D for non-negative D, which every target is
    // unless a `subtract` layer ran first.
    opacityByScale: true,
    note: 'max(S, D). A real GPUBlendOperation, not something to emulate. Blend factors are ignored for min/max.',
  },
  min: {
    mode: 'min',
    label: 'Darken',
    description: 'Keeps whichever side is darker. Cuts holes in what is underneath.',
    implementation: 'fixed',
    state: { color: minMax('min'), alpha: minMax('min') },
    needsShader: false,
    readsDestination: false,
    wgslFn: 'blendMin',
    id: 3,
    wgslIsPerceptual: false,
    opacityByScale: false,
    note: 'min(S, D). A real GPUBlendOperation. Blend factors are ignored for min/max.',
  },
  '50/50': {
    mode: '50/50',
    label: '50/50',
    description: 'Equal parts layer and frame.',
    implementation: 'constant',
    state: { color: CONSTANT_MIX, alpha: CONSTANT_MIX },
    needsShader: false,
    readsDestination: false,
    wgslFn: 'blendMixPerceptual',
    id: 4,
    wgslIsPerceptual: true,
    opacityByScale: false,
    note: 'c*S + (1-c)*D with c = 0.5. Requires setBlendConstant({r:.5,g:.5,b:.5,a:.5}); the default constant is zero and would render the layer invisible. The fixed path mixes in linear light, the WGSL through OKLab.',
  },
  subtract: {
    mode: 'subtract',
    label: 'Subtract',
    description: 'Darkens the frame by the layer.',
    implementation: 'fixed',
    state: {
      color: { operation: 'reverse-subtract', srcFactor: 'one', dstFactor: 'one' },
      alpha: KEEP_DST,
    },
    needsShader: false,
    readsDestination: false,
    wgslFn: 'blendSubtract',
    id: 5,
    wgslIsPerceptual: false,
    opacityByScale: true,
    note: 'D - S: the source darkens what is underneath (AVS semantics). `reverse-subtract`, NOT `subtract`, which is S - D and reads as an inverted layer. Alpha is left alone.',
  },
  multiply: {
    mode: 'multiply',
    label: 'Multiply',
    description: 'Uses the layer as a mask on the frame.',
    implementation: 'fixed',
    state: {
      color: { operation: 'add', srcFactor: 'dst', dstFactor: 'zero' },
      // `dst-alpha` rather than `dst` purely to be unambiguous about which
      // channel is meant in the alpha component. The value is identical.
      alpha: { operation: 'add', srcFactor: 'dst-alpha', dstFactor: 'zero' },
    },
    needsShader: false,
    readsDestination: false,
    wgslFn: 'blendMultiply',
    id: 6,
    wgslIsPerceptual: false,
    opacityByScale: false,
    note: 'S * D, via the destination as the SOURCE factor. This is the mode that most looks like it needs a destination read and does not: a dst FACTOR is free, a dst READ costs a target.',
  },
  xor: {
    mode: 'xor',
    label: 'XOR',
    description: 'Bitwise interference between layer and frame.',
    implementation: 'shader',
    needsShader: true,
    readsDestination: true,
    wgslFn: 'blendXor',
    id: 7,
    wgslIsPerceptual: false,
    // The composite crossfades against the destination, so opacity is correct
    // for free — but not by SCALING the source, which is what this flag asks.
    opacityByScale: false,
    note: 'The one mode fixed-function blending cannot express. WebGPU has no logic-op blending — there is no equivalent of GL glLogicOp or D3D LogicOp in the API surface and no GPUBlendOperation performs a bitwise operation. Even if there were, every target is rgba16float (§3.2) and a bitwise XOR of two floats is not a defined image operation. It needs a shader that quantises both sides, XORs, and converts back — which means reading the destination, which forces a scratch target, because a render pass may not sample its own attachment.',
  },
  adjustable: {
    mode: 'adjustable',
    label: 'Adjustable',
    description: 'Crossfade with the amount exposed as a parameter.',
    implementation: 'constant',
    state: { color: CONSTANT_MIX, alpha: CONSTANT_MIX },
    needsShader: false,
    readsDestination: false,
    wgslFn: 'blendMixPerceptual',
    id: 8,
    wgslIsPerceptual: true,
    opacityByScale: false,
    note: 'The same equation as 50/50 with the mix exposed. Not a separate blend equation. setBlendConstant is an ENCODER command, so two adjustable layers with different amounts can still share one render pass — call it between the draws.',
  },
  alpha: {
    mode: 'alpha',
    label: 'Alpha',
    description: 'Normal source-over compositing.',
    implementation: 'fixed',
    state: {
      color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
      alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    },
    needsShader: false,
    readsDestination: false,
    wgslFn: 'blendAlpha',
    id: 9,
    wgslIsPerceptual: false,
    // Scaling a straight-alpha source by opacity scales its colour but not its
    // alpha, which darkens the layer rather than fading it. Correct fading here
    // means scaling `a` too — which is what a pass that multiplies its whole
    // vec4 by C.opacity does, so this holds as long as passes follow the
    // PASS_COMMON_WGSL contract literally.
    opacityByScale: true,
    note: 'Straight (non-premultiplied) source-over. Alpha uses `one` so compositing two partly transparent layers accumulates coverage correctly instead of saturating.',
  },
};

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function blendInfo(mode: BlendMode): BlendInfo {
  return BLEND_INFO[mode];
}

export function blendLabel(mode: BlendMode): string {
  return BLEND_INFO[mode].label;
}

/**
 * The fixed-function state, or `null` when the mode needs the shader path.
 *
 * `null` rather than `undefined`, and rather than quietly returning `replace`:
 * a caller that forgets to check gets a type error at the call site instead of a
 * silently wrong image, which is the entire failure mode this module exists to
 * prevent. `renderer.ts` deliberately substitutes `replace` when building the
 * pipeline that FEEDS a shader composite — that substitution is correct there
 * and is a different decision from this one.
 */
export function blendStateFor(mode: BlendMode): GPUBlendState | null {
  return BLEND_INFO[mode].state ?? null;
}

export function needsShaderBlend(mode: BlendMode): boolean {
  return BLEND_INFO[mode].needsShader;
}

/** The `BLEND_MODE` pipeline constant for the composite pass. */
export function blendModeId(mode: BlendMode): number {
  return BLEND_INFO[mode].id;
}

/** Inverse of `blendModeId`. `null` for an id no mode claims. */
export function blendModeFromId(id: number): BlendMode | null {
  return BLEND_ORDER[id] ?? null;
}

export function isBlendMode(value: unknown): value is BlendMode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BLEND_INFO, value);
}

/**
 * Every mode whose fixed-function state cannot fade correctly by scaling the
 * source, and which therefore wants the shader composite if its opacity moves.
 *
 * Exported as data rather than left for callers to derive, because deriving it
 * means re-deciding it, and the whole point of the table is that it is decided
 * once.
 */
export const OPACITY_NEEDS_CROSSFADE: readonly BlendMode[] =
  BLEND_ORDER.filter((m) => !BLEND_INFO[m].opacityByScale);

// ---------------------------------------------------------------------------
// The composite shader
// ---------------------------------------------------------------------------

/**
 * Binding numbers `shaders/blend.wgsl` hard-codes, restated here.
 *
 * They mirror `PASS_BINDING` in `renderer.ts` — `input`, `sampler`, `history` —
 * and are NOT imported from it, because that import closes a cycle (see the file
 * header). Restating them is not duplication for its own sake: it puts the
 * numbers somewhere a reader of the TypeScript can see them, and gives the
 * integration a single assertion to write.
 */
export const BLEND_BINDING = { src: 1, sampler: 2, dst: 3 } as const;

/**
 * The composite shader, ready to hand to `createShaderModule`.
 *
 * Pass `PASS_COMMON_WGSL` in rather than having this module import it — same
 * cycle argument, and it keeps the header a caller's choice, which matters
 * because a test harness may want a stub `Common` block.
 */
export function blendCompositeWGSL(passCommonWGSL: string): string {
  return `${passCommonWGSL}\n${BLEND_WGSL}`;
}

/**
 * Pipeline-overridable constants for the composite.
 *
 * The mode is a pipeline constant, not a uniform, for two reasons. It is
 * per-pipeline anyway (the pipeline cache is already keyed on the blend), so
 * specialising costs nothing after the first frame and lets the compiler fold
 * the dispatch away. And it needs no extra binding — the renderer's composite
 * bind group is (common, input, sampler, history) with no params buffer, and a
 * shader declaring a binding its explicit layout lacks fails at pipeline
 * creation.
 *
 * The cost is that `mix` is baked too: animating an `adjustable` layer's amount
 * through the shader path compiles a pipeline per distinct value. Quantise it
 * or add a params binding. `adjustable` is fixed-function by default and only
 * reaches here when the perceptual crossfade was asked for deliberately.
 */
export function blendPipelineConstants(mode: BlendMode, mix = 0.5): Record<string, number> {
  return { BLEND_MODE: blendModeId(mode), BLEND_MIX: clamp01(mix) };
}

/** Cache key for a composite pipeline. Mode and mix both specialise the module. */
export function blendPipelineKey(mode: BlendMode, mix = 0.5): string {
  return BLEND_INFO[mode].wgslIsPerceptual
    ? `blend:${mode}:${clamp01(mix).toFixed(4)}`
    : `blend:${mode}`;
}

// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
