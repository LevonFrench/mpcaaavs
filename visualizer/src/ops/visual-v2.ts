// AAAVS visual system V2: composition-aware spatial operators.
//
// Each registry type owns a shader and a compact parameter interface.  The old
// implementation sent every effect through one mode branch and one twelve-float
// block, which made unrelated concepts such as aperture radius, print-dot size,
// and lens radius share the same `radius` control.  Legacy preset keys are still
// accepted at this adapter seam, but they never cross the CPU/GPU interface.

import { AUDIO_WGSL } from '../audiogpu.ts';
import type { ParamValue, PassContext, PassDescriptor } from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP, passBindingsWGSL } from '../renderer.ts';

import COMMON_WGSL from '../shaders/visual-v2-ops/common.wgsl';
import NEGATIVE_SPACE_WGSL from '../shaders/visual-v2-ops/negative-space.wgsl';
import DIFFRACTION_WGSL from '../shaders/visual-v2-ops/diffraction.wgsl';
import ENGRAVE_WGSL from '../shaders/visual-v2-ops/engrave.wgsl';
import FOLDGLASS_WGSL from '../shaders/visual-v2-ops/foldglass.wgsl';
import RANK_STRETCH_WGSL from '../shaders/visual-v2-ops/rank-stretch.wgsl';
import RISO_WGSL from '../shaders/visual-v2-ops/riso.wgsl';
import EDGEFLOW_WGSL from '../shaders/visual-v2-ops/edgeflow.wgsl';
import LENSFIELD_WGSL from '../shaders/visual-v2-ops/lensfield.wgsl';
import DROP_REST_WGSL from '../shaders/visual-v2-ops/drop-rest.wgsl';

type Params = Readonly<Record<string, ParamValue>>;

export type VisualV2OperatorType =
  | 'negative-space'
  | 'diffraction'
  | 'engrave'
  | 'foldglass'
  | 'rank-stretch'
  | 'riso'
  | 'edgeflow'
  | 'lensfield'
  | 'drop-rest';

// ---------------------------------------------------------------------------
// Operator-specific parameter interfaces
// ---------------------------------------------------------------------------

export const NEGATIVE_SPACE_DEFAULTS: Readonly<Record<string, ParamValue>> = {
  apertureMix: 1,
  outsideDim: 0.5,
  apertureRadius: 1,
  edgeDefinition: 1,
  centreX: -0.22,
  centreY: 0.06,
};

export const DIFFRACTION_DEFAULTS: Readonly<Record<string, ParamValue>> = {
  flareMix: 1,
  flareGain: 0.5,
  sampleRadiusPx: 1,
  sampleSpacing: 1,
  luminanceThreshold: 0.55,
  spectralTint: 1,
  axisOffsetTurns: 0,
  axisTurnNumerator: 1,
  axisBarDenominator: 128,
};

export const ENGRAVE_DEFAULTS: Readonly<Record<string, ParamValue>> = {
  engravingMix: 1,
  edgeGain: 0.5,
  gradientRadiusPx: 1,
  hatchDefinition: 1,
  markThreshold: 0.55,
  hatchOffsetTurns: 0,
};

export const FOLDGLASS_DEFAULTS: Readonly<Record<string, ParamValue>> = {
  glassMix: 1,
  refractionStrength: 0.5,
  creaseWidth: 1,
  foldSlope: 1,
  centreX: -0.22,
  centreY: 0.06,
  foldOffsetTurns: 0,
  foldTurnNumerator: 1,
  foldBarDenominator: 256,
};

export const RANK_STRETCH_DEFAULTS: Readonly<Record<string, ParamValue>> = {
  rankMix: 1,
  extremaMix: 0.5,
  searchRadiusPx: 1,
  sampleSpread: 1,
  contrastThreshold: 0.55,
  stripeWidthPx: 16,
  scanOffsetTurns: 0,
  scanTurnNumerator: 1,
  scanBarDenominator: 256,
};

export const RISO_DEFAULTS: Readonly<Record<string, ParamValue>> = {
  printMix: 1,
  registrationStrength: 0.5,
  registrationRadiusPx: 1,
  dotDefinition: 1,
  plateBalance: 1,
  inkThreshold: 0.55,
  registrationOffsetTurns: 0,
};

export const EDGEFLOW_DEFAULTS: Readonly<Record<string, ParamValue>> = {
  flowMix: 1,
  advectionStrength: 0.5,
  gradientRadiusPx: 1,
  travelDetail: 1,
  structureMix: 1,
  forwardBias: 0.66,
  reverseTravel: 0.55,
};

export const LENSFIELD_DEFAULTS: Readonly<Record<string, ParamValue>> = {
  lensMix: 1,
  refractionStrength: 0.5,
  lensRadius: 1,
  rimDefinition: 1,
  refractionMix: 1,
  centreX: -0.22,
  centreY: 0.06,
};

export const DROP_REST_DEFAULTS: Readonly<Record<string, ParamValue>> = {
  restMix: 1,
  blackout: 0.5,
};

/** Defaults keyed by the stable registry ID rather than pooled into one parameter soup. */
export const VISUAL_V2_OPERATOR_DEFAULTS = {
  'negative-space': NEGATIVE_SPACE_DEFAULTS,
  diffraction: DIFFRACTION_DEFAULTS,
  engrave: ENGRAVE_DEFAULTS,
  foldglass: FOLDGLASS_DEFAULTS,
  'rank-stretch': RANK_STRETCH_DEFAULTS,
  riso: RISO_DEFAULTS,
  edgeflow: EDGEFLOW_DEFAULTS,
  lensfield: LENSFIELD_DEFAULTS,
  'drop-rest': DROP_REST_DEFAULTS,
} as const satisfies Readonly<Record<VisualV2OperatorType, Readonly<Record<string, ParamValue>>>>;

// ---------------------------------------------------------------------------
// Compatibility and musical-ratio adapters
// ---------------------------------------------------------------------------

function rawNumber(params: Params, key: string): number | undefined {
  const raw = params[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/** Read the operator-specific key first, then one legacy generic alias. */
function num(
  params: Params,
  key: string,
  legacyKey: string | undefined,
  fallback: number,
  lo: number,
  hi: number,
): number {
  const value = rawNumber(params, key) ?? (legacyKey ? rawNumber(params, legacyKey) : undefined) ?? fallback;
  return value < lo ? lo : value > hi ? hi : value;
}

/** Positive fractional part; `%` preserves the sign during preroll. */
function fract(value: number): number {
  return value - Math.floor(value);
}

const TAU = Math.PI * 2;

interface MusicalAxis {
  readonly offsetKey: string;
  readonly numeratorKey: string;
  readonly denominatorKey: string;
  readonly defaultNumerator: number;
  readonly defaultDenominator: number;
  /** The old shader multiplied `rate` by this integer denominator. */
  readonly legacyRateDivisor: 32 | 64;
}

/**
 * Resolve an animated orientation as an explicit rational number of turns per
 * musical bar.  Only the wrapped angle reaches WGSL, so no shader can quietly
 * reintroduce an arbitrary float time multiplier.
 *
 * Old presets express the static angle in half-turns (`angle * PI`) and motion
 * as `rate / 32` or `rate / 64`.  Their adapter is quantised to an eighth-rate
 * grid, exactly preserving every rate authored by the V2 preset bank.
 */
function musicalAxisRadians(params: Params, ctx: PassContext, spec: MusicalAxis): number {
  const offsetTurns = rawNumber(params, spec.offsetKey)
    ?? (rawNumber(params, 'angle') ?? 0) * 0.5;

  const hasExplicitRatio = rawNumber(params, spec.numeratorKey) !== undefined
    || rawNumber(params, spec.denominatorKey) !== undefined;

  let numerator: number;
  let denominator: number;
  if (hasExplicitRatio) {
    numerator = Math.trunc(num(
      params, spec.numeratorKey, undefined, spec.defaultNumerator, -256, 256,
    ));
    denominator = Math.max(1, Math.trunc(num(
      params, spec.denominatorKey, undefined, spec.defaultDenominator, 1, 4096,
    )));
  } else if (rawNumber(params, 'rate') !== undefined) {
    numerator = Math.round(num(params, 'rate', undefined, 0.25, -4, 4) * 8);
    denominator = spec.legacyRateDivisor * 8;
  } else {
    numerator = spec.defaultNumerator;
    denominator = spec.defaultDenominator;
  }

  return fract(offsetTurns + ctx.bars * numerator / denominator) * TAU;
}

// ---------------------------------------------------------------------------
// Descriptor assembly
// ---------------------------------------------------------------------------

interface OperatorModule {
  readonly structName: string;
  readonly uniformFloats: 4 | 8;
  readonly shader: string;
  readonly usesAudio: boolean;
  readonly writeUniforms: (out: Float32Array, ctx: PassContext) => void;
}

function pass(type: VisualV2OperatorType): (module: OperatorModule) => PassDescriptor {
  return (module): PassDescriptor => {
    const shape = {
      type,
      family: 'operator' as const,
      input: 'accumulator' as const,
      usesAudio: module.usesAudio,
      uniformFloats: module.uniformFloats,
      code: '',
    } satisfies PassDescriptor;
    const params = `@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> P : ${module.structName};`;
    return {
      ...shape,
      code: [
        PASS_COMMON_WGSL,
        module.usesAudio ? AUDIO_WGSL : '',
        passBindingsWGSL(shape),
        COMMON_WGSL,
        module.shader,
        params,
      ].filter(Boolean).join('\n'),
      // Replace operators stay full resolution: a lower-scale identity would be
      // a down/up-sampled copy, not the byte-preserving accumulator.
      defaultResolutionScale: 1,
      writeUniforms: module.writeUniforms,
    };
  };
}

export const negativeSpacePass = pass('negative-space')({
  structName: 'NegativeSpaceParams',
  uniformFloats: 8,
  shader: NEGATIVE_SPACE_WGSL,
  usesAudio: true,
  writeUniforms(out, ctx): void {
    const p = ctx.params;
    out[0] = num(p, 'apertureMix', 'amount', 1, 0, 1);
    out[1] = num(p, 'outsideDim', 'strength', 0.5, 0, 1);
    out[2] = num(p, 'apertureRadius', 'radius', 1, 0.1, 8);
    out[3] = num(p, 'edgeDefinition', 'detail', 1, 0.1, 6);
    out[4] = num(p, 'centreX', 'focusX', -0.22, -1.5, 1.5);
    out[5] = num(p, 'centreY', 'focusY', 0.06, -1.5, 1.5);
  },
});

export const diffractionPass = pass('diffraction')({
  structName: 'DiffractionParams',
  uniformFloats: 8,
  shader: DIFFRACTION_WGSL,
  usesAudio: true,
  writeUniforms(out, ctx): void {
    const p = ctx.params;
    out[0] = num(p, 'flareMix', 'amount', 1, 0, 1);
    out[1] = num(p, 'flareGain', 'strength', 0.5, 0, 4);
    out[2] = num(p, 'sampleRadiusPx', 'radius', 1, 0.1, 8);
    out[3] = num(p, 'sampleSpacing', 'detail', 1, 0.1, 6);
    out[4] = num(p, 'luminanceThreshold', 'threshold', 0.55, 0, 4);
    out[5] = num(p, 'spectralTint', 'mix', 1, 0, 1);
    out[6] = musicalAxisRadians(p, ctx, {
      offsetKey: 'axisOffsetTurns',
      numeratorKey: 'axisTurnNumerator',
      denominatorKey: 'axisBarDenominator',
      defaultNumerator: 1,
      defaultDenominator: 128,
      legacyRateDivisor: 32,
    });
  },
});

export const engravePass = pass('engrave')({
  structName: 'EngraveParams',
  uniformFloats: 8,
  shader: ENGRAVE_WGSL,
  usesAudio: false,
  writeUniforms(out, ctx): void {
    const p = ctx.params;
    out[0] = num(p, 'engravingMix', 'amount', 1, 0, 1);
    out[1] = num(p, 'edgeGain', 'strength', 0.5, 0, 4);
    out[2] = num(p, 'gradientRadiusPx', 'radius', 1, 0.1, 8);
    out[3] = num(p, 'hatchDefinition', 'detail', 1, 0.1, 6);
    out[4] = num(p, 'markThreshold', 'threshold', 0.55, 0, 4);
    out[5] = (rawNumber(p, 'hatchOffsetTurns') ?? (rawNumber(p, 'angle') ?? 0) * 0.5) * TAU;
  },
});

export const foldglassPass = pass('foldglass')({
  structName: 'FoldglassParams',
  uniformFloats: 8,
  shader: FOLDGLASS_WGSL,
  usesAudio: true,
  writeUniforms(out, ctx): void {
    const p = ctx.params;
    out[0] = num(p, 'glassMix', 'amount', 1, 0, 1);
    out[1] = num(p, 'refractionStrength', 'strength', 0.5, 0, 4);
    out[2] = num(p, 'creaseWidth', 'radius', 1, 0.1, 8);
    out[3] = num(p, 'foldSlope', 'detail', 1, 0.1, 6);
    out[4] = num(p, 'centreX', 'focusX', -0.22, -1.5, 1.5);
    out[5] = num(p, 'centreY', 'focusY', 0.06, -1.5, 1.5);
    out[6] = musicalAxisRadians(p, ctx, {
      offsetKey: 'foldOffsetTurns',
      numeratorKey: 'foldTurnNumerator',
      denominatorKey: 'foldBarDenominator',
      defaultNumerator: 1,
      defaultDenominator: 256,
      legacyRateDivisor: 64,
    });
  },
});

export const rankStretchPass = pass('rank-stretch')({
  structName: 'RankStretchParams',
  uniformFloats: 8,
  shader: RANK_STRETCH_WGSL,
  usesAudio: false,
  writeUniforms(out, ctx): void {
    const p = ctx.params;
    const detail = num(p, 'sampleSpread', 'detail', 1, 0.1, 6);
    out[0] = num(p, 'rankMix', 'amount', 1, 0, 1);
    out[1] = num(p, 'extremaMix', 'strength', 0.5, 0, 1);
    out[2] = num(p, 'searchRadiusPx', 'radius', 1, 0.1, 8);
    out[3] = detail;
    out[4] = num(p, 'contrastThreshold', 'threshold', 0.55, 0, 4);
    out[5] = num(p, 'stripeWidthPx', undefined, 7 + detail * 9, 1, 128);
    out[6] = musicalAxisRadians(p, ctx, {
      offsetKey: 'scanOffsetTurns',
      numeratorKey: 'scanTurnNumerator',
      denominatorKey: 'scanBarDenominator',
      defaultNumerator: 1,
      defaultDenominator: 256,
      legacyRateDivisor: 64,
    });
  },
});

export const risoPass = pass('riso')({
  structName: 'RisoParams',
  uniformFloats: 8,
  shader: RISO_WGSL,
  usesAudio: true,
  writeUniforms(out, ctx): void {
    const p = ctx.params;
    out[0] = num(p, 'printMix', 'amount', 1, 0, 1);
    out[1] = num(p, 'registrationStrength', 'strength', 0.5, 0, 4);
    out[2] = num(p, 'registrationRadiusPx', 'radius', 1, 0.1, 8);
    out[3] = num(p, 'dotDefinition', 'detail', 1, 0.1, 6);
    out[4] = num(p, 'plateBalance', 'mix', 1, 0, 1);
    out[5] = num(p, 'inkThreshold', 'threshold', 0.55, 0, 4);
    out[6] = (rawNumber(p, 'registrationOffsetTurns') ?? (rawNumber(p, 'angle') ?? 0) * 0.5) * TAU;
  },
});

export const edgeflowPass = pass('edgeflow')({
  structName: 'EdgeflowParams',
  uniformFloats: 8,
  shader: EDGEFLOW_WGSL,
  usesAudio: true,
  writeUniforms(out, ctx): void {
    const p = ctx.params;
    out[0] = num(p, 'flowMix', 'amount', 1, 0, 1);
    out[1] = num(p, 'advectionStrength', 'strength', 0.5, 0, 4);
    out[2] = num(p, 'gradientRadiusPx', 'radius', 1, 0.1, 8);
    out[3] = num(p, 'travelDetail', 'detail', 1, 0.1, 6);
    out[4] = num(p, 'structureMix', 'mix', 1, 0, 1);
    out[5] = num(p, 'forwardBias', undefined, 0.66, 0, 1);
    out[6] = num(p, 'reverseTravel', undefined, 0.55, 0, 2);
  },
});

export const lensfieldPass = pass('lensfield')({
  structName: 'LensfieldParams',
  uniformFloats: 8,
  shader: LENSFIELD_WGSL,
  usesAudio: true,
  writeUniforms(out, ctx): void {
    const p = ctx.params;
    out[0] = num(p, 'lensMix', 'amount', 1, 0, 1);
    out[1] = num(p, 'refractionStrength', 'strength', 0.5, 0, 4);
    out[2] = num(p, 'lensRadius', 'radius', 1, 0.1, 8);
    out[3] = num(p, 'rimDefinition', 'detail', 1, 0.1, 6);
    out[4] = num(p, 'refractionMix', 'mix', 1, 0, 1);
    out[5] = num(p, 'centreX', 'focusX', -0.22, -1.5, 1.5);
    out[6] = num(p, 'centreY', 'focusY', 0.06, -1.5, 1.5);
  },
});

export const dropRestPass = pass('drop-rest')({
  structName: 'DropRestParams',
  uniformFloats: 4,
  shader: DROP_REST_WGSL,
  usesAudio: false,
  writeUniforms(out, ctx): void {
    const p = ctx.params;
    out[0] = num(p, 'restMix', 'amount', 1, 0, 1);
    out[1] = num(p, 'blackout', 'strength', 0.5, 0, 1);
  },
});

export const VISUAL_V2_OPERATOR_PASSES: readonly PassDescriptor[] = [
  negativeSpacePass,
  diffractionPass,
  engravePass,
  foldglassPass,
  rankStretchPass,
  risoPass,
  edgeflowPass,
  lensfieldPass,
  dropRestPass,
];
