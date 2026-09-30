import {
  AVS_AUDIO_SAMPLES,
  AVS_TEXER_APE_ID,
  AVS_TEXER_II_APE_ID,
  AvsEffectRegistry,
  AvsExecutor,
  AvsFramebuffer,
  createAvsBitmapResolver,
  decodeAvsBmp,
  decodeAvsTexer2Config,
  decodeAvsTexerConfig,
  registerAvsCoreEffects,
  registerAvsTexerEffects,
  type AvsAudioFrame,
  type AvsBitmap,
  type AvsComponent,
  type AvsPresetAst,
} from '../src/avs/index.ts';

let checks = 0;

const bmp24 = decodeAvsBmp(makeBmp24(2, 2, [0xff0000, 0x00ff00, 0x0000ff, 0xffffff]));
equalPixels(bmp24.pixels, [0xff0000, 0x00ff00, 0x0000ff, 0xffffff], '24-bit BMP rows become top-down RGB');
const bmp1 = decodeAvsBmp(makeBmp1());
equalPixels(bmp1.pixels, [0xffffff, 0, 0xffffff], '1-bit palette BMP');
const bmp16 = decodeAvsBmp(makeBmp16());
equalPixels(bmp16.pixels, [0xff0000, 0x00ff00, 0x0000ff], '16-bit BI_RGB uses RGB555');
const bmpRle = decodeAvsBmp(makeBmpRle8());
equalPixels(bmpRle.pixels, [0x112233, 0x445566, 0x112233], '8-bit RLE BMP');

const resolver = createAvsBitmapResolver({ 'Assets\\Particle.BMP': bmp24 });
equal(resolver('C:\\old\\Particle.bmp'), bmp24, 'resolver basename and case normalization');

const texerPayload = makeTexerPayload('particle.bmp', 0b1010, 7);
const texerConfig = decodeAvsTexerConfig(texerPayload);
equal(texerConfig.image, 'particle.bmp', 'Texer filename');
equal(texerConfig.addToInput, true, 'Texer input mode');
equal(texerConfig.colorize, true, 'Texer mask mode');
equal(texerConfig.particles, 7, 'Texer particle limit');

const texer2Payload = makeTexer2Payload({
  image: 'sprite.bmp', resize: true, wrap: true, colorize: false,
  init: 'n=2', frame: 'x=x+1', beat: 'red=0', point: 'y=i', version: 1,
});
const texer2Config = decodeAvsTexer2Config(texer2Payload);
equal(texer2Config.version, 1, 'Texer II version');
equal(texer2Config.image, 'sprite.bmp', 'Texer II filename');
equal(texer2Config.point, 'y=i', 'Texer II length-prefixed point code');

const one: AvsBitmap = { width: 1, height: 1, pixels: Uint32Array.of(0x204060) };
equalPixels(
  render(AVS_TEXER_APE_ID, makeTexerPayload('one.bmp', 0b0101, 100), [0, 1, 0], 3, 1, { 'one.bmp': one }),
  [0, 0x204060, 0],
  'Texer stamps each nonblack source pixel into fbout',
);
equalPixels(
  render(AVS_TEXER_APE_ID, makeTexerPayload('one.bmp', 0b1001, 100), [0, 0x808080, 0], 3, 1, { 'one.bmp': one }),
  [0, 0x102030, 0],
  'Texer source-color filtering uses divide-by-256 multiply',
);
equalPixels(
  render(AVS_TEXER_APE_ID, makeTexerPayload('one.bmp', 0b0110, 1), [1, 1, 1], 3, 1, { 'one.bmp': one }),
  [0x204061, 1, 1],
  'Texer copies input and stops at its row-major particle limit',
);

const sprite: AvsBitmap = {
  width: 3, height: 3,
  pixels: Uint32Array.from([
    0x100000, 0x200000, 0x300000,
    0x400000, 0x500000, 0x600000,
    0x700000, 0x800000, 0x900000,
  ]),
};
equalPixels(
  render(AVS_TEXER_II_APE_ID, makeTexer2Payload({ image: 'sprite.bmp', init: 'n=1', point: 'x=0;y=0' }), zeros(25), 5, 5, { 'sprite.bmp': sprite }),
  grid5([[1, 1, 0x100000], [2, 1, 0x200000], [1, 2, 0x400000], [2, 2, 0x500000]]),
  'Texer II native unscaled rectangle coverage',
);
equalPixels(
  render(AVS_TEXER_II_APE_ID, makeTexer2Payload({
    image: 'sprite.bmp', init: 'n=1', colorize: true,
    point: 'x=0;y=0;red=.5;green=1;blue=0',
  }), zeros(25), 5, 5, { 'sprite.bmp': white3() }),
  grid5([[1, 1, 0x7ffe00], [2, 1, 0x7ffe00], [1, 2, 0x7ffe00], [2, 2, 0x7ffe00]]),
  'Texer II EEL color filtering',
);
const scaled = render(
  AVS_TEXER_II_APE_ID,
  makeTexer2Payload({ image: 'sprite.bmp', resize: true, init: 'n=1', point: 'x=0;y=0;sizex=2;sizey=2' }),
  zeros(49), 7, 7, { 'sprite.bmp': white3() },
);
equal(scaled.filter((pixel) => pixel !== 0).length, 9, 'Texer II fixed-point resize coverage');
equal(scaled[3 + 3 * 7], 0xfafafa, 'Texer II bilinear and white-filter rounding');
equalPixels(
  render(AVS_TEXER_II_APE_ID, makeTexer2Payload({ image: 'sprite.bmp', init: 'n=1', point: 'x=0;y=0;sizex=-1' }), zeros(25), 5, 5, { 'sprite.bmp': sprite }),
  grid5([[1, 1, 0x300000], [2, 1, 0x200000], [1, 2, 0x600000], [2, 2, 0x500000]]),
  'Texer II negative sizex mirrors without resize',
);

const persistent = new AvsEffectRegistry();
registerAvsCoreEffects(persistent); registerAvsTexerEffects(persistent, { bitmapResolver: createAvsBitmapResolver({ 'sprite.bmp': white3() }) });
const phases = makeTexer2Payload({ image: 'sprite.bmp', init: 'n=1;c=0', frame: 'c=c+1', beat: 'c=c+1', point: 'x=(c-2)*.5;y=0' });
const first = renderWithRegistry(AVS_TEXER_II_APE_ID, phases, zeros(25), 5, 5, persistent, false);
const second = renderWithRegistry(AVS_TEXER_II_APE_ID, phases, zeros(25), 5, 5, persistent, true);
notEqual(first.join(','), second.join(','), 'Texer II retains EEL state and runs beat code');

const additiveMode = 0x80000001;
equalPixels(
  render(AVS_TEXER_II_APE_ID, makeTexer2Payload({ image: 'sprite.bmp', init: 'n=1', point: 'x=0;y=0' }), grayGrid(25, 1), 5, 5, { 'sprite.bmp': white3() }, additiveMode),
  grid5([[1, 1, 0xffffff], [2, 1, 0xffffff], [1, 2, 0xffffff], [2, 2, 0xffffff]], grayGrid(25, 1)),
  'Texer II obeys Set Render Mode additive blend',
);

const orderedOverlap = render(
  AVS_TEXER_II_APE_ID,
  makeTexer2Payload({
    image: 'overlap.bmp', init: 'n=2',
    point: 'x=(i-.5)*.25;y=0;red=1-i*.5;green=i*.5;blue=0', colorize: true,
  }),
  grayGrid(49, 4), 7, 7, { 'overlap.bmp': white3() },
);
equal(orderedOverlap[3 + 3 * 7], 0x7f7f00, 'Texer II replace mode preserves later-particle draw order');

const scaledAdditive = render(
  AVS_TEXER_II_APE_ID,
  makeTexer2Payload({
    image: 'overlap.bmp', resize: true, init: 'n=1',
    point: 'x=0;y=0;sizex=2;sizey=2',
  }),
  grayGrid(49, 1), 7, 7, { 'overlap.bmp': white3() }, additiveMode,
);
equal(scaledAdditive[3 + 3 * 7], 0xfbfbfb, 'Texer II scaled additive path retains destination blending');

const wrapped = render(
  AVS_TEXER_II_APE_ID,
  makeTexer2Payload({ image: 'sprite.bmp', wrap: true, init: 'n=1', point: 'x=1.1;y=0' }),
  zeros(25), 5, 5, { 'sprite.bmp': white5() }, undefined,
);
equal(wrapped.some((pixel, index) => index % 5 === 0 && pixel !== 0), true, 'Texer II version-0 wrap reaches left edge');
equal(wrapped.some((pixel, index) => index % 5 === 4 && pixel !== 0), true, 'Texer II wrap duplicate reaches right edge');

const embedded = render(
  AVS_TEXER_II_APE_ID, makeTexer2Payload({ init: 'n=1', point: 'x=0;y=0' }),
  zeros(25 * 25), 25, 25, {},
);
equal(embedded.some((pixel) => pixel !== 0), true, 'Texer II exact embedded default bitmap fallback');

console.log(`avs-texer-effects-check: PASS (${checks} assertions)`);

interface Texer2Input {
  readonly version?: number; readonly image?: string;
  readonly resize?: boolean; readonly wrap?: boolean; readonly colorize?: boolean;
  readonly init?: string; readonly frame?: string; readonly beat?: string; readonly point?: string;
}

function render(
  apeId: string, payload: Uint8Array, pixels: readonly number[], width: number, height: number,
  assets: Readonly<Record<string, AvsBitmap | Uint8Array>>, lineMode?: number,
): number[] {
  const registry = new AvsEffectRegistry();
  registerAvsCoreEffects(registry);
  registerAvsTexerEffects(registry, { bitmapResolver: createAvsBitmapResolver(assets) });
  return renderWithRegistry(apeId, payload, pixels, width, height, registry, false, lineMode);
}

function renderWithRegistry(
  apeId: string, payload: Uint8Array, pixels: readonly number[], width: number, height: number,
  registry: AvsEffectRegistry, beat: boolean, lineMode?: number,
): number[] {
  const components: AvsComponent[] = [];
  if (lineMode !== undefined) components.push(component(null, i32Payload([lineMode]), '0', 40));
  components.push(component(apeId, payload, '1'));
  const preset: AvsPresetAst = {
    version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: false,
    components, byteLength: payload.length,
  };
  const framebuffer = new AvsFramebuffer(width, height, Uint32Array.from(pixels));
  const executor = new AvsExecutor(preset, registry);
  executor.render(framebuffer, emptyAudio(beat));
  equal(executor.stats.unsupported, 0, `${apeId} registered`);
  return Array.from(framebuffer.pixels);
}

function component(apeId: string | null, payload: Uint8Array, path: string, effectId = -1): AvsComponent {
  return { effectId, apeId, payload, fileOffset: 0, path, children: [], list: null, listCode: null };
}
function makeTexerPayload(name: string, mode: number, particles: number): Uint8Array {
  const payload = new Uint8Array(288);
  payload.set(new TextEncoder().encode(name).subarray(0, 259), 16);
  const view = new DataView(payload.buffer);
  view.setInt32(276, mode, true); view.setInt32(280, particles, true);
  return payload;
}
function makeTexer2Payload(input: Texer2Input): Uint8Array {
  const scripts = [input.init ?? '', input.frame ?? '', input.beat ?? '', input.point ?? ''];
  const encoded = scripts.map((value) => new TextEncoder().encode(value));
  const payload = new Uint8Array(280 + encoded.reduce((sum, value) => sum + 4 + value.length, 0));
  const view = new DataView(payload.buffer);
  view.setInt32(0, input.version ?? 0, true);
  payload.set(new TextEncoder().encode(input.image ?? '').subarray(0, 259), 4);
  view.setInt32(264, input.resize ? 1 : 0, true);
  view.setInt32(268, input.wrap ? 1 : 0, true);
  view.setInt32(272, input.colorize ? 1 : 0, true);
  let offset = 280;
  for (const value of encoded) {
    view.setUint32(offset, value.length, true); offset += 4;
    payload.set(value, offset); offset += value.length;
  }
  return payload;
}

function makeBmp24(width: number, height: number, topDownPixels: readonly number[]): Uint8Array {
  const stride = Math.ceil(width * 3 / 4) * 4;
  const bytes = bmpHeader(width, height, 24, 0, 54, stride * height);
  for (let storedY = 0; storedY < height; storedY++) {
    const y = height - storedY - 1;
    for (let x = 0; x < width; x++) {
      const pixel = topDownPixels[y * width + x]!;
      const offset = 54 + storedY * stride + x * 3;
      bytes[offset] = pixel & 255; bytes[offset + 1] = (pixel >>> 8) & 255; bytes[offset + 2] = (pixel >>> 16) & 255;
    }
  }
  return bytes;
}
function makeBmp1(): Uint8Array {
  const bytes = bmpHeader(3, 1, 1, 0, 62, 4, 2);
  const view = new DataView(bytes.buffer);
  view.setUint32(58, 0x00ffffff, true);
  bytes[62] = 0b10100000;
  return bytes;
}
function makeBmp16(): Uint8Array {
  const bytes = bmpHeader(3, 1, 16, 0, 54, 8);
  const view = new DataView(bytes.buffer);
  view.setUint16(54, 0x7c00, true); view.setUint16(56, 0x03e0, true); view.setUint16(58, 0x001f, true);
  return bytes;
}
function makeBmpRle8(): Uint8Array {
  const data = Uint8Array.from([0, 3, 0, 1, 0, 0, 0, 1]);
  const bytes = bmpHeader(3, 1, 8, 1, 62, data.length, 2);
  const view = new DataView(bytes.buffer);
  view.setUint32(54, 0x00112233, true); view.setUint32(58, 0x00445566, true);
  bytes.set(data, 62);
  return bytes;
}
function bmpHeader(width: number, height: number, bits: number, compression: number, offset: number, dataBytes: number, palette = 0): Uint8Array {
  const bytes = new Uint8Array(offset + dataBytes);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x42; bytes[1] = 0x4d;
  view.setUint32(2, bytes.length, true); view.setUint32(10, offset, true); view.setUint32(14, 40, true);
  view.setInt32(18, width, true); view.setInt32(22, height, true);
  view.setUint16(26, 1, true); view.setUint16(28, bits, true); view.setUint32(30, compression, true);
  view.setUint32(34, dataBytes, true); view.setUint32(46, palette, true);
  return bytes;
}
function i32Payload(values: readonly number[]): Uint8Array {
  const payload = new Uint8Array(values.length * 4); const view = new DataView(payload.buffer);
  values.forEach((value, index) => view.setInt32(index * 4, value, true)); return payload;
}
function white3(): AvsBitmap { return { width: 3, height: 3, pixels: new Uint32Array(9).fill(0xffffff) }; }
function white5(): AvsBitmap { return { width: 5, height: 5, pixels: new Uint32Array(25).fill(0xffffff) }; }
function zeros(length: number): number[] { return Array<number>(length).fill(0); }
function grayGrid(length: number, value: number): number[] { return Array<number>(length).fill(value | (value << 8) | (value << 16)); }
function grid5(points: readonly (readonly [number, number, number])[], base = zeros(25)): number[] {
  const result = [...base]; for (const [x, y, color] of points) result[y * 5 + x] = color; return result;
}
function emptyAudio(beat: boolean): AvsAudioFrame {
  return {
    waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)], beat, beatLevel: 0,
  };
}
function equalPixels(actual: ArrayLike<number>, expected: readonly number[], label: string): void {
  checks++;
  if (actual.length !== expected.length || Array.from(actual).some((value, index) => value !== expected[index])) {
    throw new Error(`${label}: got [${Array.from(actual).join(', ')}], expected [${expected.join(', ')}]`);
  }
}
function equal(actual: unknown, expected: unknown, label: string): void {
  checks++; if (actual !== expected) throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`);
}
function notEqual(actual: unknown, expected: unknown, label: string): void {
  checks++; if (actual === expected) throw new Error(`${label}: values unexpectedly matched`);
}
