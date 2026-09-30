import {
  AVS_AUDIO_SAMPLES,
  AVS_CONVOLUTION_APE_ID,
  AVS_MULTIFILTER_APE_ID,
  AvsExecutor,
  AvsFramebuffer,
  decodeAvsConvolutionConfig,
  decodeAvsMultiFilterConfig,
  registerAvsConvolutionFilter,
  registerAvsMultiFilter,
  type AvsAudioFrame,
  type AvsComponent,
  type AvsPresetAst,
} from '../src/avs/index.ts';

let checks = 0;

const decoded = decodeAvsConvolutionConfig(convolutionPayload({
  flags: [1, 1, 1, 1], kernel: kernel([[0, 0, 9]]), bias: -2, scale: 3, filename: 'saved.cff',
}));
equal(decoded.kernel.length, 49, 'Convolution is 7x7');
equal(decoded.kernel[24], 9, 'kernel row-major centre');
equal(decoded.bias, -2, 'bias offset');
equal(decoded.scale, 3, 'scale offset');
equal(decoded.legacyFilename, 'saved.cff', 'unterminated trailing filename');
equal(decodeAvsConvolutionConfig(i32Payload([2, 2, 2, 2])).enabled, false, 'flags require exactly one');
equal(decodeAvsConvolutionConfig(new Uint8Array()).kernel[24], 1, 'short payload keeps identity default');

equalPixels(
  renderConvolution({ kernel: kernel([[0, 0, 1]]) }, [gray(10), gray(20), gray(30)]),
  [gray(10), gray(20), gray(30)],
  'identity convolution',
);
equalPixels(
  renderConvolution({ kernel: kernel([[-1, 0, 1]]) }, [gray(10), gray(20), gray(30)]),
  [gray(10), gray(10), gray(20)],
  'left sample and clamp-to-edge',
);
equalPixels(
  renderConvolution({ kernel: kernel([[1, 0, 1]]) }, [gray(10), gray(20), gray(30)]),
  [gray(20), gray(30), gray(30)],
  'right-only in-place sampling',
);
equal(
  renderConvolution({ kernel: kernel([[0, 0, 1]]), bias: -1, scale: 256 }, [gray(10)])[0],
  gray(0),
  'default subtraction saturates',
);
equal(
  renderConvolution({ flags: [1, 1, 0, 0], kernel: kernel([[0, 0, 1]]), bias: -1, scale: 256 }, [gray(10)])[0],
  rgba(255),
  'wrap subtraction is modulo arithmetic',
);
equal(
  renderConvolution({ flags: [1, 0, 1, 0], kernel: kernel([[0, 0, 1]]), bias: -1, scale: 256 }, [gray(10)])[0],
  rgba(127),
  'absolute mode preserves native sign-bit clearing quirk',
);
equal(
  renderConvolution({ flags: [1, 0, 1, 0], kernel: kernel([[0, 0, 200]]) }, [gray(255)])[0],
  0,
  'absolute block is omitted without a negative term',
);
equal(
  renderConvolution({ kernel: kernel([[0, 0, 1]]), scale: 3 }, [gray(3)])[0],
  gray(0),
  'non-power scale uses multiply-high reciprocal',
);
equalPixels(
  renderConvolution({ flags: [1, 0, 0, 1], kernel: kernel([[-1, 0, 1]]) }, grayGrid([1, 2, 3, 4]), 2, 2),
  grayGrid([2, 3, 4, 5]),
  'two-pass adds left and up kernels before scaling',
);

const partialMulti = decodeAvsMultiFilterConfig(new Uint8Array([0]));
equal(partialMulti.enabled, false, 'MultiFilter memcpy accepts partial struct');
equal(decodeAvsMultiFilterConfig(new Uint8Array(17)).enabled, true, 'MultiFilter oversized payload ignored');
equalPixels(
  renderMulti([1, 0, 0, 0], [rgba(0), rgba(64), rgba(127), rgba(128), rgba(192), rgba(255)]),
  [rgba(0), rgba(128), rgba(254), rgba(254), rgba(126), rgba(0)],
  'Chrome fold',
);
equalPixels(renderMulti([1, 1, 0, 0], [rgba(64)]), [rgba(254)], 'Double Chrome');

const toggledRegistry = registerAvsMultiFilter();
equalPixels(renderMulti([1, 0, 1, 0], [rgba(64)], false, toggledRegistry), [rgba(64)], 'toggle initially off');
equalPixels(renderMulti([1, 0, 1, 0], [rgba(64)], true, toggledRegistry), [rgba(128)], 'beat toggles on');
equalPixels(renderMulti([1, 0, 1, 0], [rgba(64)], false, toggledRegistry), [rgba(128)], 'toggle state is retained');
equalPixels(renderMulti([1, 0, 0, 1], [rgba(64)]), [rgba(64)], 'reactive Chrome installed no-op');
equalPixels(
  renderMulti([1, 3, 0, 0], grayGrid([0, 0, 0, 0, 1, 0, 0, 0, 0]), false, undefined, 3, 3),
  [0, 0xffffffff, 0, 0xffffffff, 0xffffffff, 0, 0, 0, 0],
  'Infinite Root scratch border direction',
);

console.log(`avs-ape-effects-check: PASS (${checks} assertions)`);

interface ConvolutionInput {
  readonly flags?: readonly [number, number, number, number];
  readonly kernel: readonly number[];
  readonly bias?: number;
  readonly scale?: number;
  readonly filename?: string;
}

function renderConvolution(input: ConvolutionInput, pixels: readonly number[], width = pixels.length, height = 1): number[] {
  return render(AVS_CONVOLUTION_APE_ID, convolutionPayload(input), pixels, width, height, false, registerAvsConvolutionFilter());
}

function renderMulti(
  values: readonly number[], pixels: readonly number[], beat = false,
  registry = registerAvsMultiFilter(), width = pixels.length, height = 1,
): number[] {
  return render(AVS_MULTIFILTER_APE_ID, i32Payload(values), pixels, width, height, beat, registry);
}

function render(
  apeId: string, payload: Uint8Array, pixels: readonly number[], width: number, height: number,
  beat: boolean, registry: ReturnType<typeof registerAvsConvolutionFilter>,
): number[] {
  const component: AvsComponent = {
    effectId: -1, apeId, payload, fileOffset: 0, path: '1', children: [], list: null, listCode: null,
  };
  const preset: AvsPresetAst = {
    version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: false,
    components: [component], byteLength: payload.length,
  };
  const framebuffer = new AvsFramebuffer(width, height, Uint32Array.from(pixels));
  const executor = new AvsExecutor(preset, registry);
  executor.render(framebuffer, emptyAudio(beat));
  equal(executor.stats.unsupported, 0, `${apeId} registered`);
  return Array.from(framebuffer.pixels);
}

function convolutionPayload(input: ConvolutionInput): Uint8Array {
  const bytes = new TextEncoder().encode(input.filename ?? '');
  const payload = new Uint8Array(220 + bytes.length);
  const words = [
    ...(input.flags ?? [1, 0, 0, 0]), ...input.kernel,
    input.bias ?? 0, input.scale ?? 1,
  ];
  const view = new DataView(payload.buffer);
  words.forEach((value, index) => view.setInt32(index * 4, value, true));
  payload.set(bytes, 220);
  return payload;
}

function kernel(entries: readonly (readonly [number, number, number])[]): number[] {
  const values = Array<number>(49).fill(0);
  for (const [x, y, value] of entries) values[(y + 3) * 7 + x + 3] = value;
  return values;
}
function i32Payload(values: readonly number[]): Uint8Array {
  const payload = new Uint8Array(values.length * 4);
  const view = new DataView(payload.buffer);
  values.forEach((value, index) => view.setInt32(index * 4, value, true));
  return payload;
}
function emptyAudio(beat: boolean): AvsAudioFrame {
  return {
    waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    beat, beatLevel: 0,
  };
}
function gray(value: number): number { return value | (value << 8) | (value << 16); }
function rgba(value: number): number { return (value | (value << 8) | (value << 16) | (value << 24)) >>> 0; }
function grayGrid(values: readonly number[]): number[] { return values.map(gray); }
function equalPixels(actual: readonly number[], expected: readonly number[], label: string): void {
  checks++;
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label}: got [${actual.join(', ')}], expected [${expected.join(', ')}]`);
  }
}
function equal(actual: unknown, expected: unknown, label: string): void {
  checks++;
  if (actual !== expected) throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`);
}
