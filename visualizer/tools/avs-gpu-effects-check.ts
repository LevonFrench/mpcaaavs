import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  AVS_AUDIO_SAMPLES, AvsCompatibilityRuntime, parseAvsPreset,
  type AvsAudioFrame, type AvsComponent, type AvsPresetAst,
} from '../src/avs/index.ts';
import {
  AVS_EXACT_BLITTER_FEEDBACK_WGSL, AVS_EXACT_BLUR_WGSL, AVS_EXACT_ROTO_BLITTER_WGSL,
  AVS_GPU_BLITTER_FEEDBACK_CAPABILITY, AVS_GPU_BLUR_CAPABILITY,
  AVS_GPU_POINTWISE_CAPABILITY, AVS_GPU_ROTO_BLITTER_CAPABILITY,
  buildExactAvsPointwiseWgsl,
  type ExactAvsGpuPassConfig, type ExactAvsPointwiseOperation,
} from '../src/avs/gpu-frame-graph.ts';
import {
  buildStaticAvsMovementGpuMap, decodeAvsMovement,
} from '../src/avs/effects/movement.ts';
import {
  buildStaticAvsBlitterFeedbackGpuParams, buildStaticAvsRotoBlitterGpuParams,
  decodeAvsBlitterFeedback, decodeAvsRotoBlitter,
} from '../src/avs/effects/blitter-gpu.ts';
import { planTerminalExactGpuPasses } from '../src/avs/gpu-preset-plan.ts';

assert.equal(AVS_GPU_BLUR_CAPABILITY.byteExact, true);
assert.equal(AVS_GPU_POINTWISE_CAPABILITY.byteExact, true);
assert.equal(AVS_GPU_ROTO_BLITTER_CAPABILITY.byteExact, true);
assert.equal(AVS_GPU_BLITTER_FEEDBACK_CAPABILITY.byteExact, true);
assert.match(AVS_EXACT_BLUR_WGSL, /var<storage, read> source/);
assert.match(AVS_EXACT_BLUR_WGSL, /var<storage, read_write> destination/);
assert.doesNotMatch(AVS_EXACT_BLUR_WGSL, /textureSample|sampler|f32/);
assert.match(AVS_EXACT_ROTO_BLITTER_WGSL, /positive_mod/);
assert.doesNotMatch(AVS_EXACT_ROTO_BLITTER_WGSL, /textureSample|sampler|\bf32\b/);
assert.doesNotMatch(AVS_EXACT_BLITTER_FEEDBACK_WGSL, /textureSample|sampler|\bf32\b/);

for (const [width, height] of [[1, 1], [1, 7], [7, 1], [2, 2], [2, 7], [7, 2], [3, 5], [17, 11]] as const) {
  const source = deterministicPixels(width * height, width * 65537 + height);
  for (const mode of [1, 2, 3] as const) for (const roundUp of [false, true]) {
    const preset = blurPreset(mode, roundUp, true);
    const plan = planTerminalExactGpuPasses(preset);
    assert.equal(plan.blurPasses.length, 1);
    assert.equal(plan.cpuPreset.components.length, 0);
    const runtime = new AvsCompatibilityRuntime(blurPreset(mode, roundUp, false), width, height);
    runtime.framebuffer.pixels.set(source);
    const expected = runtime.render(emptyAudio()).framebuffer.pixels;
    const actual = emulateShaderBlur(source, width, height, mode, roundUp);
    assert.deepEqual(actual, expected, `exact GPU Blur contract ${width}x${height} mode=${mode} round=${roundUp}`);
  }
}

const feedback = planTerminalExactGpuPasses(blurPreset(1, false, false));
assert.equal(feedback.blurPasses.length, 0);
assert.match(feedback.reason, /feedback/);
const chain = planTerminalExactGpuPasses({
  ...blurPreset(1, false, true),
  components: [blurComponent(1, false, '1'), blurComponent(3, true, '2')],
});
assert.deepEqual(chain.blurPasses, [{ mode: 1, roundUp: false }, { mode: 3, roundUp: true }]);

const pointwiseFixtures = [
  component(3, [1, 0x102030], '1'),
  component(3, [255, 0xfedcba], '1'),
  component(37, [1], '1'),
  component(44, [0], '1'),
  component(44, [1], '1'),
  component(12, [1, 0x204080, 0xa0b0c0, 10], '1'),
  component(12, [2, 0x204080, 0xa0b0c0, 10], '1'),
  component(12, [3, 0x204080, 0xa0b0c0, 37], '1'),
  component(22, [1, 0, 0, 1024, -1024, 256, 0, 0x304050, 1, 17], '1'),
  component(22, [1, 1, 0, 768, 1536, -512, 0, 0x506070, 0, 16], '1'),
] as const;
const pointwiseSource = deterministicPixels(65_537, 0x706f696e);
for (const fixture of pointwiseFixtures) {
  const preset = presetWith([fixture], true);
  const plan = planTerminalExactGpuPasses(preset);
  assert.equal(plan.extractedComponents, 1, `effect ${fixture.effectId} is exact-GPU eligible`);
  assert.equal(plan.passes.length, 1);
  const pass = plan.passes[0]!;
  assert.equal(pass.kind, 'pointwise');
  const shader = buildExactAvsPointwiseWgsl((pass as Extract<ExactAvsGpuPassConfig, { kind: 'pointwise' }>).operations);
  assert.match(shader, /var<storage, read> source/);
  assert.match(shader, /var<storage, read_write> destination/);
  assert.doesNotMatch(shader, /textureSample|sampler|\bf32\b/);
  const expected = renderCpu([fixture], pointwiseSource);
  const actual = emulateGpuPasses(pointwiseSource, pointwiseSource.length, 1, plan.passes);
  assert.deepEqual(actual, expected, `exact fused pointwise contract for effect ${fixture.effectId}`);
}

const fusedComponents = [
  component(3, [16, 0x102030], '1'),
  component(37, [1], '2'),
  component(44, [0], '3'),
  component(12, [3, 0x304050, 0xf01020, 25], '4'),
] as const;
const fused = planTerminalExactGpuPasses(presetWith(fusedComponents, true));
assert.equal(fused.extractedComponents, 4);
assert.equal(fused.fusedPointwiseOperations, 4);
assert.equal(fused.passes.length, 1, 'consecutive pointwise components fuse to one physical dispatch');
assert.deepEqual(
  emulateGpuPasses(pointwiseSource, pointwiseSource.length, 1, fused.passes),
  renderCpu(fusedComponents, pointwiseSource),
  'four-effect fused shader preserves sequential AVS byte math',
);

const mixedComponents = [
  component(3, [8, 0x101010], '1'), blurComponent(1, false, '2'),
  component(37, [1], '3'), component(44, [1], '4'),
] as const;
const mixed = planTerminalExactGpuPasses(presetWith(mixedComponents, true));
assert.equal(mixed.passes.length, 3, 'pointwise / Blur / fused pointwise becomes three resident passes');
const mixedSource = deterministicPixels(17 * 11, 0x6d697865);
assert.deepEqual(
  emulateGpuPasses(mixedSource, 17, 11, mixed.passes),
  renderCpu(mixedComponents, mixedSource, 17, 11),
  'mixed exact GPU suffix preserves CPU ordering',
);

const movementFixtures = [
  movementComponent(2, { blend: false }),
  movementComponent(3, { blend: true }),
  movementComponent(3, { subpixel: true, wrap: false }),
  movementComponent(7, { blend: true, subpixel: true }),
  movementComponent(15, { subpixel: true, wrap: true }),
] as const;
for (const [fixtureIndex, fixture] of movementFixtures.entries()) {
  const width = 17 + fixtureIndex * 2, height = 11 + fixtureIndex;
  const source = deterministicPixels(width * height, 0x4d4f5645 + fixtureIndex);
  const plan = planTerminalExactGpuPasses(presetWith([fixture], true));
  assert.equal(plan.extractedComponents, 1);
  assert.equal(plan.movementPasses, 1);
  assert.equal(plan.passes[0]?.kind, 'movement');
  assert.deepEqual(
    emulateGpuPasses(source, width, height, plan.passes),
    renderCpu([fixture], source, width, height),
    `exact static Movement GPU contract case ${fixtureIndex}`,
  );
}
const forwardMovement = planTerminalExactGpuPasses(presetWith([
  movementComponent(3, { sourceMapped: 1 }),
], true));
assert.equal(forwardMovement.movementPasses, 0, 'forward-scatter Movement remains exact CPU');
const customMovement = planTerminalExactGpuPasses(presetWith([
  movementComponent(32_767, {}, 'x=x;y=y'),
], true));
assert.equal(customMovement.movementPasses, 0, 'EEL Movement remains exact CPU');

const rotoFixtures = [
  rotoBlitterComponent({ zoom: 31, direction: 31 }),
  rotoBlitterComponent({ zoom: 16, direction: 45 }),
  rotoBlitterComponent({ zoom: 48, direction: 7, blend: true }),
  rotoBlitterComponent({ zoom: 24, direction: 61, subpixel: true }),
  rotoBlitterComponent({ zoom: 40, direction: 18, subpixel: true, blend: true }),
] as const;
for (const [fixtureIndex, fixture] of rotoFixtures.entries()) {
  const width = 17 + fixtureIndex * 2, height = 13 + fixtureIndex;
  const source = deterministicPixels(width * height, 0x524f544f + fixtureIndex);
  const plan = planTerminalExactGpuPasses(presetWith([fixture], true));
  assert.equal(plan.extractedComponents, 1);
  assert.equal(plan.rotoBlitterPasses, 1);
  assert.equal(plan.passes[0]?.kind, 'roto-blitter');
  assert.deepEqual(
    emulateGpuPasses(source, width, height, plan.passes),
    renderCpu([fixture], source, width, height),
    `exact static Roto Blitter GPU contract case ${fixtureIndex}`,
  );
}
assert.equal(
  planTerminalExactGpuPasses(presetWith([rotoBlitterComponent({ beatReverse: true })], true)).rotoBlitterPasses,
  0, 'beat-reversing Roto Blitter remains exact CPU',
);
assert.equal(
  planTerminalExactGpuPasses(presetWith([rotoBlitterComponent({ beatScale: true })], true)).rotoBlitterPasses,
  0, 'beat-scaling Roto Blitter remains exact CPU',
);

const blitterFixtures = [
  blitterFeedbackComponent({ scale: 0 }),
  blitterFeedbackComponent({ scale: 20 }),
  blitterFeedbackComponent({ scale: 30, blend: true }),
  blitterFeedbackComponent({ scale: 20, subpixel: true }),
  blitterFeedbackComponent({ scale: 20, blend: true, subpixel: true }),
  blitterFeedbackComponent({ scale: 40 }),
  blitterFeedbackComponent({ scale: 40, blend: true }),
] as const;
for (const [fixtureIndex, fixture] of blitterFixtures.entries()) {
  const width = 19 + fixtureIndex * 2, height = 13 + fixtureIndex;
  const source = deterministicPixels(width * height, 0x424c4954 + fixtureIndex);
  const plan = planTerminalExactGpuPasses(presetWith([fixture], true));
  assert.equal(plan.extractedComponents, 1);
  assert.equal(plan.blitterFeedbackPasses, 1);
  assert.equal(plan.passes[0]?.kind, 'blitter-feedback');
  assert.deepEqual(
    emulateGpuPasses(source, width, height, plan.passes),
    renderCpu([fixture], source, width, height),
    `exact static Blitter Feedback GPU contract case ${fixtureIndex}`,
  );
}
assert.equal(
  planTerminalExactGpuPasses(presetWith([blitterFeedbackComponent({ changeOnBeat: true })], true)).blitterFeedbackPasses,
  0, 'beat-changing Blitter Feedback remains exact CPU',
);

const roots = [resolve('assets/avs-presets/community-picks'), resolve('assets/avs-presets/winamp-5-picks')];
let eligible = 0;
let blurEligible = 0;
let extracted = 0;
let physicalPasses = 0;
let fusedOperations = 0;
let movementPasses = 0;
const eligibleNames: string[] = [];
for (const root of roots) for (const name of readdirSync(root).filter(value => value.endsWith('.avs'))) {
  const bytes = readFileSync(join(root, name));
  const plan = planTerminalExactGpuPasses(parseAvsPreset(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
  if (plan.blurPasses.length > 0) blurEligible++;
  if (plan.extractedComponents > 0) {
    eligible++; extracted += plan.extractedComponents; physicalPasses += plan.passes.length;
    fusedOperations += plan.fusedPointwiseOperations; movementPasses += plan.movementPasses;
    eligibleNames.push(`${name} [${plan.reason}]`);
  }
}

assert.ok(eligible >= blurEligible);
const privateCorpus = auditPrivateCorpus(resolve('avs presets/presets/unique'));
console.log(
  `avs-gpu-effects-check: exact Blur + fused pointwise planner, 48 Blur and ` +
  `${pointwiseFixtures.length + 2} pointwise, ${movementFixtures.length} Movement, and ` +
  `${rotoFixtures.length} Roto Blitter and ${blitterFixtures.length} Blitter Feedback differential cases; ` +
  `${eligible}/124 live presets eligible, ` +
  `${extracted} components -> ${physicalPasses} physical passes, ${fusedOperations} pointwise operations ` +
  `and ${movementPasses} Movement passes (${eligibleNames.join('; ')}); ` +
  (privateCorpus
    ? `private corpus ${privateCorpus.parsed}/${privateCorpus.files} parsed, ` +
      `${privateCorpus.eligiblePresets} eligible presets, ${privateCorpus.physicalPasses} physical passes, ` +
      `${privateCorpus.movementPasses} Movement, ${privateCorpus.rotoBlitterPasses} Roto Blitter, and ` +
      `${privateCorpus.blitterFeedbackPasses} Blitter Feedback passes, ` +
      `${privateCorpus.parseFailures} parse failures`
    : 'private corpus unavailable'),
);

function auditPrivateCorpus(root: string): {
  files: number; parsed: number; parseFailures: number; eligiblePresets: number;
  physicalPasses: number; extractedComponents: number; pointwiseOperations: number;
  movementPasses: number; rotoBlitterPasses: number; blitterFeedbackPasses: number;
} | null {
  if (!existsSync(root)) return null;
  const names = readdirSync(root).filter(value => value.toLowerCase().endsWith('.avs'));
  const result = {
    files: names.length, parsed: 0, parseFailures: 0, eligiblePresets: 0,
    physicalPasses: 0, extractedComponents: 0, pointwiseOperations: 0,
    movementPasses: 0, rotoBlitterPasses: 0, blitterFeedbackPasses: 0,
  };
  for (const name of names) {
    try {
      const bytes = readFileSync(join(root, name));
      const ast = parseAvsPreset(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      const plan = planTerminalExactGpuPasses(ast);
      result.parsed++;
      if (plan.extractedComponents > 0) result.eligiblePresets++;
      result.physicalPasses += plan.passes.length;
      result.extractedComponents += plan.extractedComponents;
      result.pointwiseOperations += plan.fusedPointwiseOperations;
      result.movementPasses += plan.movementPasses;
      result.rotoBlitterPasses += plan.rotoBlitterPasses;
      result.blitterFeedbackPasses += plan.blitterFeedbackPasses;
    } catch {
      result.parseFailures++;
    }
  }
  return result;
}

function blurPreset(mode: 1 | 2 | 3, roundUp: boolean, clearEveryFrame: boolean): AvsPresetAst {
  return {
    version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame,
    components: [blurComponent(mode, roundUp, '1')], byteLength: 8,
  };
}

function presetWith(components: readonly AvsComponent[], clearEveryFrame: boolean): AvsPresetAst {
  return {
    version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame,
    components, byteLength: components.reduce((total, value) => total + value.payload.byteLength + 8, 0),
  };
}

function component(effectId: number, fields: readonly number[], path: string): AvsComponent {
  const payload = new Uint8Array(fields.length * 4);
  const view = new DataView(payload.buffer);
  fields.forEach((value, index) => view.setInt32(index * 4, value, true));
  return { effectId, apeId: null, payload, fileOffset: 0, path, children: [], list: null, listCode: null };
}

function movementComponent(
  effect: number,
  options: { blend?: boolean; sourceMapped?: number; subpixel?: boolean; wrap?: boolean } = {},
  expression = '',
): AvsComponent {
  const encoded = new TextEncoder().encode(`${expression}\0`);
  const customBytes = effect === 32_767 ? 1 + 4 + encoded.length : 0;
  const payload = new Uint8Array(4 + customBytes + 20);
  const view = new DataView(payload.buffer);
  let offset = 0;
  view.setInt32(offset, effect, true); offset += 4;
  if (effect === 32_767) {
    payload[offset++] = 1; view.setInt32(offset, encoded.length, true); offset += 4;
    payload.set(encoded, offset); offset += encoded.length;
  }
  for (const value of [
    options.blend ? 1 : 0, options.sourceMapped ?? 0, 0,
    options.subpixel ? 1 : 0, options.wrap ? 1 : 0,
  ]) { view.setInt32(offset, value, true); offset += 4; }
  return { effectId: 15, apeId: null, payload, fileOffset: 0, path: '1', children: [], list: null, listCode: null };
}

function rotoBlitterComponent(options: {
  zoom?: number; direction?: number; blend?: boolean; beatReverse?: boolean;
  beatSpeed?: number; beatZoom?: number; beatScale?: boolean; subpixel?: boolean;
}): AvsComponent {
  return component(9, [
    options.zoom ?? 31, options.direction ?? 31, options.blend ? 1 : 0,
    options.beatReverse ? 1 : 0, options.beatSpeed ?? 0, options.beatZoom ?? 31,
    options.beatScale ? 1 : 0, options.subpixel ? 1 : 0,
  ], '1');
}

function blitterFeedbackComponent(options: {
  scale?: number; beatScale?: number; blend?: boolean; changeOnBeat?: boolean; subpixel?: boolean;
}): AvsComponent {
  return component(4, [
    options.scale ?? 30, options.beatScale ?? 30, options.blend ? 1 : 0,
    options.changeOnBeat ? 1 : 0, options.subpixel ? 1 : 0,
  ], '1');
}

function blurComponent(mode: 1 | 2 | 3, roundUp: boolean, path: string): AvsComponent {
  const payload = new Uint8Array(8);
  const view = new DataView(payload.buffer);
  view.setInt32(0, mode, true); view.setInt32(4, roundUp ? 1 : 0, true);
  return { effectId: 6, apeId: null, payload, fileOffset: 0, path, children: [], list: null, listCode: null };
}

function emulateShaderBlur(
  source: Uint32Array, width: number, height: number, mode: 1 | 2 | 3, roundUp: boolean,
): Uint32Array {
  if (width < 2 || height < 2) return source.slice();
  const target = new Uint32Array(source.length);
  const shifted = (pixel: number, amount: number): number => (pixel >>> amount) & [0, 0x007f7f7f, 0x003f3f3f, 0x001f1f1f, 0x000f0f0f][amount]!;
  for (let index = 0; index < source.length; index++) {
    const x = index % width; const y = Math.trunc(index / width);
    const atLeft = x === 0; const atRight = x + 1 === width;
    const atTop = y === 0; const atBottom = y + 1 === height;
    const center = source[index]!;
    const left = atLeft ? 0 : source[index - 1]!; const right = atRight ? 0 : source[index + 1]!;
    const up = atTop ? 0 : source[index - width]!; const down = atBottom ? 0 : source[index + width]!;
    const corner = (atLeft || atRight) && (atTop || atBottom);
    const edge = atLeft || atRight || atTop || atBottom;
    let value = 0; let rounding = 0;
    if (mode === 3) {
      value += atLeft || atRight ? shifted(atLeft ? right : left, 1) : shifted(left, 2) + shifted(right, 2);
      value += atTop || atBottom ? shifted(atTop ? down : up, 1) : shifted(up, 2) + shifted(down, 2);
      rounding = corner ? 1 : edge ? 2 : 3;
    } else if (mode === 2) {
      value = shifted(center, 1);
      if (corner) { value += shifted(center, 2) + shifted(atLeft ? right : left, 3) + shifted(atTop ? down : up, 3); rounding = 3; }
      else if (edge) {
        value += shifted(center, 3); rounding = 4;
        if (atTop || atBottom) value += shifted(left, 3) + shifted(right, 3) + shifted(atTop ? down : up, 3);
        else value += shifted(atLeft ? right : left, 3) + shifted(up, 3) + shifted(down, 3);
      } else { value += shifted(center, 2) + shifted(left, 4) + shifted(right, 4) + shifted(up, 4) + shifted(down, 4); rounding = 5; }
    } else if (corner) { value = shifted(center, 1) + shifted(atLeft ? right : left, 2) + shifted(atTop ? down : up, 2); rounding = 2; }
    else if (atTop || atBottom) { value = shifted(center, 2) + shifted(left, 2) + shifted(right, 2) + shifted(atTop ? down : up, 2); rounding = 3; }
    else if (atLeft || atRight) { value = shifted(center, 2) + shifted(atLeft ? right : left, 2) + shifted(up, 2) + shifted(down, 2); rounding = 3; }
    else { value = shifted(center, 1) + shifted(left, 3) + shifted(right, 3) + shifted(up, 3) + shifted(down, 3); rounding = 4; }
    target[index] = (value + (roundUp ? rounding * 0x00010101 : 0)) & 0x00ffffff;
  }
  return target;
}

function deterministicPixels(length: number, seed: number): Uint32Array {
  const output = new Uint32Array(length); let state = seed >>> 0;
  for (let index = 0; index < length; index++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; output[index] = state & 0xffffff; }
  return output;
}
function renderCpu(
  components: readonly AvsComponent[], source: Uint32Array, width = source.length, height = 1,
): Uint32Array {
  const runtime = new AvsCompatibilityRuntime(presetWith(components, false), width, height);
  runtime.framebuffer.pixels.set(source);
  return runtime.render(emptyAudio()).framebuffer.pixels.slice();
}

function emulateGpuPasses(
  source: Uint32Array, width: number, height: number, passes: readonly ExactAvsGpuPassConfig[],
): Uint32Array {
  let current = source.slice();
  for (const pass of passes) {
    if (pass.kind === 'blur') {
      current = emulateShaderBlur(current, width, height, pass.config.mode, pass.config.roundUp);
      continue;
    }
    if (pass.kind === 'movement') {
      current = emulateMovement(current, width, height, pass.config);
      continue;
    }
    if (pass.kind === 'roto-blitter') {
      current = emulateRotoBlitter(current, width, height, pass.config);
      continue;
    }
    if (pass.kind === 'blitter-feedback') {
      current = emulateBlitterFeedback(current, width, height, pass.config);
      continue;
    }
    const target = new Uint32Array(current.length);
    for (let index = 0; index < current.length; index++) {
      let pixel = current[index]! & 0x00ffffff;
      for (const operation of pass.operations) pixel = emulatePointwise(pixel, operation);
      target[index] = pixel & 0x00ffffff;
    }
    current = target;
  }
  return current;
}

function emulateBlitterFeedback(
  source: Uint32Array, width: number, height: number,
  config: ReturnType<typeof decodeAvsBlitterFeedback>,
): Uint32Array {
  const blitter = buildStaticAvsBlitterFeedbackGpuParams(config, width, height);
  assert.ok(blitter);
  const destination = source.slice();
  const average = (first: number, second: number): number =>
    ((first >>> 1) & 0x007f7f7f) + ((second >>> 1) & 0x007f7f7f);
  const nearest = (linear: number): number => linear >= 0 && linear < source.length ? source[linear]! : 0;
  const bilinear = (fixedX: number, fixedY: number): number => {
    const x = fixedX >> 16, y = fixedY >> 16;
    const x1 = Math.min(width - 1, x + 1), y1 = Math.min(height - 1, y + 1);
    const fx = (fixedX >> 8) & 255, fy = (fixedY >> 8) & 255;
    const pixels = [source[y * width + x]!, source[y * width + x1]!, source[y1 * width + x]!, source[y1 * width + x1]!];
    const channel = (shift: number): number => {
      const values = pixels.map(pixel => (pixel >>> shift) & 255);
      const top = (values[0]! * (255 - fx) + values[1]! * fx) >>> 8;
      const bottom = (values[2]! * (255 - fx) + values[3]! * fx) >>> 8;
      return (top * (255 - fy) + bottom * fy) >>> 8;
    };
    return channel(0) | (channel(8) << 8) | (channel(16) << 16);
  };
  for (let index = 0; index < source.length; index++) {
    const x = index % width, y = Math.trunc(index / width);
    if (blitter.mode === 1) {
      const extra = blitter.blend && !blitter.subpixel ? Math.trunc(x / 4) * blitter.step : 0;
      const fixedX = blitter.startX + x * blitter.step + extra;
      const fixedY = blitter.startY + y * blitter.step;
      const sampled = blitter.subpixel ? bilinear(fixedX, fixedY)
        : nearest((fixedY >> 16) * width + (fixedX >> 16));
      destination[index] = blitter.blend ? average(source[index]!, sampled) : sampled;
      continue;
    }
    const localX = x - blitter.startX, localY = y - blitter.startY;
    if (localX < 0 || localY < 0 || localX >= blitter.regionWidth || localY >= blitter.regionHeight) continue;
    const extra = blitter.blend ? Math.trunc(localX / 4) * blitter.step : 0;
    const sourceX = (32_768 + localX * blitter.step + extra) >> 16;
    const sourceY = (32_768 + localY * blitter.step) >> 16;
    const sampled = nearest(sourceY * width + sourceX);
    destination[index] = blitter.blend ? average(source[index]!, sampled) : sampled;
  }
  return destination;
}

function emulateRotoBlitter(
  source: Uint32Array, width: number, height: number,
  config: ReturnType<typeof decodeAvsRotoBlitter>,
): Uint32Array {
  const affine = buildStaticAvsRotoBlitterGpuParams(config, width, height);
  assert.ok(affine);
  const destination = new Uint32Array(source.length);
  const modulo = (value: number, divisor: number): number => {
    const result = value % divisor;
    return result < 0 ? result + divisor : result;
  };
  const table = (first: number, second: number): number => Math.trunc((first / 255) * second);
  const average = (first: number, second: number): number =>
    ((first >>> 1) & 0x007f7f7f) + ((second >>> 1) & 0x007f7f7f);
  for (let index = 0; index < source.length; index++) {
    const x = index % width, y = Math.trunc(index / width);
    const s = modulo(affine.sStart + y * affine.dsDy + x * affine.dsDx, affine.ds);
    const t = modulo(affine.tStart + y * affine.dtDy + x * affine.dtDx, affine.dt);
    const sourceX = s >> 16, sourceY = t >> 16;
    const offset = sourceX + sourceY * width;
    let sampled = source[offset]!;
    if (affine.subpixel) {
      const fx = (s >> 8) & 255, fy = (t >> 8) & 255;
      const weights = [
        table(255 - fx, 255 - fy), table(fx, 255 - fy),
        table(255 - fx, fy), table(fx, fy),
      ];
      const pixels = [source[offset]!, source[offset + 1]!, source[offset + width]!, source[offset + width + 1]!];
      const channel = (shift: number): number => pixels.reduce(
        (sum, pixel, sample) => sum + table((pixel >>> shift) & 255, weights[sample]!), 0,
      ) & 255;
      sampled = channel(0) | (channel(8) << 8) | (channel(16) << 16);
    }
    destination[index] = affine.blend ? average(source[index]!, sampled) : sampled;
  }
  return destination;
}

function emulateMovement(
  source: Uint32Array, width: number, height: number,
  config: ReturnType<typeof decodeAvsMovement>,
): Uint32Array {
  const movement = buildStaticAvsMovementGpuMap(config, width, height);
  assert.ok(movement);
  const destination = new Uint32Array(source.length);
  const table = (first: number, second: number): number => Math.trunc((first / 255) * second);
  const average = (first: number, second: number): number =>
    ((first >>> 1) & 0x007f7f7f) + ((second >>> 1) & 0x007f7f7f);
  for (let index = 0; index < source.length; index++) {
    const packed = movement.packedCoordinates[index]!;
    const offset = packed & 0x003fffff;
    let sampled = source[offset]!;
    if (movement.bilinear) {
      const key = packed >>> 22;
      const xPart = (key >>> 5) << 3, yPart = (key & 31) << 3;
      const weights = [
        table(255 - xPart, 255 - yPart), table(xPart, 255 - yPart),
        table(255 - xPart, yPart), table(xPart, yPart),
      ];
      const pixels = [source[offset]!, source[offset + 1]!, source[offset + width]!, source[offset + width + 1]!];
      const channel = (shift: number): number => pixels.reduce(
        (sum, pixel, sample) => sum + table((pixel >>> shift) & 255, weights[sample]!), 0,
      ) & 255;
      sampled = channel(0) | (channel(8) << 8) | (channel(16) << 16);
    }
    destination[index] = movement.blend ? average(source[index]!, sampled) : sampled;
  }
  return destination;
}

function emulatePointwise(pixel: number, operation: ExactAvsPointwiseOperation): number {
  const channels = (): [number, number, number] => [pixel & 255, (pixel >>> 8) & 255, (pixel >>> 16) & 255];
  const pack = (low: number, middle: number, high: number): number => low | (middle << 8) | (high << 16);
  const clamp = (value: number): number => value < 0 ? 0 : value > 255 ? 255 : Math.trunc(value);
  switch (operation.kind) {
    case 'fade': {
      const [low, middle, high] = channels();
      const approach = (value: number, target: number): number => value <= target - operation.fade
        ? (value + operation.fade) & 255 : value >= target + operation.fade
          ? (value - operation.fade) & 255 : target;
      return pack(
        approach(low, operation.target & 255),
        approach(middle, (operation.target >>> 8) & 255),
        approach(high, (operation.target >>> 16) & 255),
      );
    }
    case 'invert': return pixel ^ 0x00ffffff;
    case 'fast-brightness': {
      if (operation.direction === 1) return (pixel >>> 1) & 0x007f7f7f;
      const [low, middle, high] = channels();
      return pack(clamp(low * 2), clamp(middle * 2), clamp(high * 2));
    }
    case 'color-clip': {
      const [low, middle, high] = channels();
      const sl = operation.source & 255, sm = (operation.source >>> 8) & 255, sh = (operation.source >>> 16) & 255;
      const match = operation.mode === 1 ? low <= sl && middle <= sm && high <= sh
        : operation.mode === 2 ? low >= sl && middle >= sm && high >= sh
          : (low - sl) ** 2 + (middle - sm) ** 2 + (high - sh) ** 2 <= operation.distanceSquared;
      return match ? operation.replacement : pixel;
    }
    case 'brightness': {
      if (operation.exclude) {
        const [low, middle, high] = channels();
        if (Math.abs(low - (operation.reference & 255)) <= operation.distance
          && Math.abs(middle - ((operation.reference >>> 8) & 255)) <= operation.distance
          && Math.abs(high - ((operation.reference >>> 16) & 255)) <= operation.distance) return pixel;
      }
      const [low, middle, high] = channels();
      const adjusted = pack(
        clamp(Math.trunc(low * operation.blueMultiplier / 65_536)),
        clamp(Math.trunc(middle * operation.greenMultiplier / 65_536)),
        clamp(Math.trunc(high * operation.redMultiplier / 65_536)),
      );
      if (operation.additive) {
        return pack(
          clamp((pixel & 255) + (adjusted & 255)),
          clamp(((pixel >>> 8) & 255) + ((adjusted >>> 8) & 255)),
          clamp(((pixel >>> 16) & 255) + ((adjusted >>> 16) & 255)),
        );
      }
      return operation.average
        ? ((pixel >>> 1) & 0x007f7f7f) + ((adjusted >>> 1) & 0x007f7f7f)
        : adjusted;
    }
  }
}
function emptyAudio(): AvsAudioFrame {
  return { waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)], spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)], beat: false, beatLevel: 0 };
}
