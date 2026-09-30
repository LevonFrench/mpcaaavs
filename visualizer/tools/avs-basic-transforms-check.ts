import {
  AVS_AUDIO_SAMPLES,
  AvsEffectRegistry,
  AvsExecutor,
  AvsFramebuffer,
  registerAvsBasicTransforms,
  type AvsAudioFrame,
  type AvsComponent,
  type AvsPresetAst,
} from '../src/avs/index.ts';

let checks = 0;
equal(render(12, [1, 0x202020, 0xa0b0c0, 10], [0x101010, 0x404040], false), [0xa0b0c0, 0x404040], 'Color Clip below');
equal(render(11, [1, 1, 2, 3, 1, 2, 3], [0], false), [0x030303], 'Colorfade neutral category');
equal(render(20, [1], [1, 2, 3, 4], false, 2, 2), [5, 5, 5, 5], 'Water corner stencil');
for (const [width, height] of [[2, 2], [2, 5], [5, 2], [3, 4], [7, 6]] as const) {
  verifyWaterSequence(width, height, 6);
}
equal(render(5, [0x123456, 0, 2], [0, 0], true), [0, 0], 'OnBeat Clear counts first beat');

const clearRegistry = registerAvsBasicTransforms(new AvsEffectRegistry());
const clearPreset = preset(component(5, [0x123456, 0, 2]));
const clearFrame = new AvsFramebuffer(1, 1);
const clearExecutor = new AvsExecutor(clearPreset, clearRegistry);
clearExecutor.render(clearFrame, audio(true));
clearExecutor.render(clearFrame, audio(true));
equal(clearFrame.pixels[0], 0x123456, 'OnBeat Clear fires at configured beat count');

const interleaved = render(23, [1, 1, 1, 0xff0000, 0, 0, 0, 1, 1, 4], new Array(9).fill(0), false, 3, 3);
equal(interleaved.some((pixel) => pixel === 0xff0000), true, 'Interleave paints selected cells');
equal(interleaved.some((pixel) => pixel === 0), true, 'Interleave leaves alternating cells');

const mosaic = render(30, [1, 1, 1, 0, 0, 0, 1], [1, 2, 3, 4], false, 2, 2);
equal(new Set(mosaic).size <= 2, true, 'Mosaic reduces source samples');

console.log(`avs-basic-transforms-check: PASS (${checks} assertions)`);

function render(
  id: number, values: readonly number[], pixels: readonly number[], beat: boolean,
  width = pixels.length, height = 1,
): number[] {
  const executor = new AvsExecutor(preset(component(id, values)), registerAvsBasicTransforms(new AvsEffectRegistry()));
  const framebuffer = new AvsFramebuffer(width, height, new Uint32Array(pixels));
  executor.render(framebuffer, audio(beat));
  return Array.from(framebuffer.pixels);
}
function component(effectId: number, values: readonly number[]): AvsComponent {
  const payload = new Uint8Array(values.length * 4);
  const view = new DataView(payload.buffer);
  values.forEach((value, index) => view.setInt32(index * 4, value, true));
  return { effectId, apeId: null, payload, fileOffset: 0, path: '1', children: [], list: null, listCode: null };
}
function preset(child: AvsComponent): AvsPresetAst {
  return { version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: false, components: [child], byteLength: 0 };
}
function audio(beat: boolean): AvsAudioFrame {
  return {
    waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)], beat, beatLevel: 0,
  };
}
function equal(actual: unknown, expected: unknown, label: string): void {
  checks++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

function verifyWaterSequence(width: number, height: number, frames: number): void {
  const executor = new AvsExecutor(
    preset(component(20, [1])),
    registerAvsBasicTransforms(new AvsEffectRegistry()),
  );
  const framebuffer = new AvsFramebuffer(width, height);
  let previous = new Uint32Array(width * height);
  let random = (width * 0x9e3779b1) ^ height;
  for (let frame = 0; frame < frames; frame++) {
    const source = new Uint32Array(width * height);
    for (let index = 0; index < source.length; index++) {
      random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
      source[index] = random & 0x00ffffff;
    }
    framebuffer.pixels.set(source);
    const expected = referenceWater(source, previous, width, height);
    executor.render(framebuffer, audio(false));
    equal(Array.from(framebuffer.pixels), Array.from(expected), `Water exact ${width}x${height} frame ${frame}`);
    previous = source;
  }
}

function referenceWater(
  source: Uint32Array, previous: Uint32Array, width: number, height: number,
): Uint32Array {
  const output = new Uint32Array(source.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const neighbors: number[] = [];
    if (x > 0) neighbors.push(source[x - 1 + y * width]!);
    if (x + 1 < width) neighbors.push(source[x + 1 + y * width]!);
    if (y > 0) neighbors.push(source[x + (y - 1) * width]!);
    if (y + 1 < height) neighbors.push(source[x + (y + 1) * width]!);
    const index = x + y * width;
    let pixel = 0;
    for (let shift = 0; shift <= 16; shift += 8) {
      let total = 0;
      for (const neighbor of neighbors) total += (neighbor >>> shift) & 255;
      if (neighbors.length > 2) total = Math.trunc(total / 2);
      const value = Math.max(0, Math.min(255, total - ((previous[index]! >>> shift) & 255)));
      pixel |= value << shift;
    }
    output[index] = pixel;
  }
  return output;
}
