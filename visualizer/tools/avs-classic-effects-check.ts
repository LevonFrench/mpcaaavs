import {
  AVS_AUDIO_SAMPLES,
  AvsExecutor,
  AvsFramebuffer,
  registerAvsClassicEffects,
  type AvsAudioFrame,
  type AvsComponent,
  type AvsPresetAst,
} from '../src/avs/index.ts';

let checks = 0;

// Fadeout approaches every channel independently and snaps inside the step.
equalPixels(
  render(3, [10, 0x302010], [0x000000, 0x181c25, 0x403020]),
  [0x0a0a0a, 0x22201b, 0x362616],
  'Fadeout channel approach',
);

// Normal Blur's boundary kernels differ from its center kernel.
equalPixels(
  render(6, [1, 0], grayGrid([0, 16, 32, 48, 64, 80, 96, 112, 128]), 3, 3),
  grayGrid([16, 28, 40, 52, 64, 76, 88, 100, 112]),
  'normal Blur edge weights',
);
equal(
  render(6, [2, 1], grayGrid([0, 16, 32, 48, 64, 80, 96, 112, 128]), 3, 3)[4],
  gray(69),
  'light Blur rounded center',
);
equal(
  render(6, [3, 1], grayGrid([0, 16, 32, 48, 64, 80, 96, 112, 128]), 3, 3)[4],
  gray(67),
  'heavy Blur rounded center',
);
for (const [width, height] of [[2, 2], [2, 5], [5, 2], [3, 4], [7, 6]] as const) {
  const pixels = deterministicPixels(width * height, width * 257 + height);
  for (const mode of [1, 2, 3]) for (const roundUp of [0, 1]) {
    equalPixels(
      render(6, [mode, roundUp], pixels, width, height),
      referenceBlur(pixels, width, height, mode, roundUp !== 0),
      `Blur differential ${width}x${height} mode ${mode} round ${roundUp}`,
    );
  }
}

// Non-subpixel zoom-in is a centered 16.16 fixed-point nearest sample.
equalPixels(
  render(4, [0, 0, 0, 0, 0], sequence(16), 4, 4),
  [6, 6, 7, 7, 6, 6, 7, 7, 10, 10, 11, 11, 10, 10, 11, 11],
  'Blitter Feedback nearest zoom-in',
);
equalPixels(
  render(4, [36, 36, 0, 0, 0], sequence(64), 8, 8).slice(0, 8),
  [1, 2, 1, 2, 3, 4, 7, 8],
  'Blitter Feedback central zoom-out',
);

// Scatter keeps four edge rows and samples the center through its 512-entry table.
const scattered = render(16, [1], sequence(80), 8, 10, false, () => 0);
equalPixels(scattered.slice(0, 32), sequence(32), 'Scatter top safety rows');
equalPixels(scattered.slice(32, 48), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21], 'Scatter deterministic center');
equalPixels(scattered.slice(48), sequence(32, 49), 'Scatter bottom safety rows');

// Brightness uses fixed-point tables; positive settings are intentionally 16x steeper.
equal(
  render(22, [1, 0, 0, 4096, -2048, -4096, 1, 0, 0, 16], [0x102030])[0],
  0xff1000,
  'Brightness replace table',
);
equal(
  render(22, [1, 1, 0, 0, 0, 0, 0, 0, 0, 16], [0x804020])[0],
  0xff8040,
  'Brightness saturating additive',
);
equalPixels(
  render(22, [1, 0, 0, 4096, 4096, 4096, 0, 0x102030, 1, 0], [0x102030, 0x112030]),
  [0x102030, 0xffffff],
  'Brightness exclusion range',
);

// Static Mirror mode 5 copies left-to-right, then top-to-bottom.
equalPixels(
  render(26, [1, 5, 0, 0, 4], sequence(16), 4, 4),
  [1, 2, 2, 1, 5, 6, 6, 5, 5, 6, 6, 5, 1, 2, 2, 1],
  'Mirror ordered directions',
);
// Beat-random Mirror receives an injectable integer source.
equalPixels(
  render(26, [1, 15, 1, 0, 2], sequence(16), 4, 4, true, () => 5),
  [1, 2, 2, 1, 5, 6, 6, 5, 5, 6, 6, 5, 1, 2, 2, 1],
  'Mirror deterministic beat mode',
);

console.log(`avs-classic-effects-check: PASS (${checks} assertions)`);

function render(
  effectId: number,
  config: readonly number[],
  pixels: readonly number[],
  width = pixels.length,
  height = 1,
  beat = false,
  randomInt?: (maximum: number) => number,
): number[] {
  const component = payloadComponent(effectId, config);
  const preset: AvsPresetAst = {
    version: 2,
    header: 'Nullsoft AVS Preset 0.2\u001a',
    clearEveryFrame: false,
    components: [component],
    byteLength: 0,
  };
  const framebuffer = new AvsFramebuffer(width, height, Uint32Array.from(pixels));
  const executor = new AvsExecutor(preset, registerAvsClassicEffects(undefined, { randomInt }));
  executor.render(framebuffer, emptyAudio(beat));
  equal(executor.stats.unsupported, 0, `effect ${effectId} registered`);
  return Array.from(framebuffer.pixels);
}

function payloadComponent(effectId: number, values: readonly number[]): AvsComponent {
  const payload = new Uint8Array(values.length * 4);
  const view = new DataView(payload.buffer);
  values.forEach((value, index) => view.setInt32(index * 4, value, true));
  return {
    effectId, apeId: null, payload, fileOffset: 0, path: '1',
    children: [], list: null, listCode: null,
  };
}

function emptyAudio(beat: boolean): AvsAudioFrame {
  return {
    waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    beat, beatLevel: 0,
  };
}

function sequence(length: number, start = 1): number[] {
  return Array.from({ length }, (_, index) => start + index);
}

function gray(value: number): number { return value | (value << 8) | (value << 16); }
function grayGrid(values: readonly number[]): number[] { return values.map(gray); }

function deterministicPixels(length: number, seed: number): number[] {
  let state = seed >>> 0;
  return Array.from({ length }, () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return state & 0x00ffffff;
  });
}

function referenceBlur(
  source: readonly number[], width: number, height: number, mode: number, roundUp: boolean,
): number[] {
  const result = new Array<number>(source.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    const center = source[index]!;
    const left = x > 0 ? source[index - 1]! : 0;
    const right = x + 1 < width ? source[index + 1]! : 0;
    const up = y > 0 ? source[index - width]! : 0;
    const down = y + 1 < height ? source[index + width]! : 0;
    const atLeft = x === 0; const atRight = x === width - 1;
    const atTop = y === 0; const atBottom = y === height - 1;
    let terms: Array<readonly [number, number]>;
    let rounding: number;
    if (mode === 3) {
      const horizontal: Array<readonly [number, number]> = atLeft ? [[right, 1]] : atRight ? [[left, 1]] : [[left, 2], [right, 2]];
      const vertical: Array<readonly [number, number]> = atTop ? [[down, 1]] : atBottom ? [[up, 1]] : [[up, 2], [down, 2]];
      terms = [...horizontal, ...vertical];
      rounding = atLeft || atRight ? (atTop || atBottom ? 1 : 2) : (atTop || atBottom ? 2 : 3);
    } else if (mode === 2) {
      const corner = (atLeft || atRight) && (atTop || atBottom);
      const edge = atLeft || atRight || atTop || atBottom;
      terms = [[center, 1]];
      if (corner) terms.push([center, 2], [atLeft ? right : left, 3], [atTop ? down : up, 3]);
      else if (edge) {
        terms.push([center, 3]);
        if (!atLeft && !atRight) terms.push([left, 3], [right, 3], [atTop ? down : up, 3]);
        else terms.push([atLeft ? right : left, 3], [up, 3], [down, 3]);
      } else terms.push([center, 2], [left, 4], [right, 4], [up, 4], [down, 4]);
      rounding = corner ? 3 : edge ? 4 : 5;
    } else {
      const corner = (atLeft || atRight) && (atTop || atBottom);
      const edge = atLeft || atRight || atTop || atBottom;
      if (corner) terms = [[center, 1], [atLeft ? right : left, 2], [atTop ? down : up, 2]];
      else if (edge && (atTop || atBottom)) terms = [[center, 2], [left, 2], [right, 2], [atTop ? down : up, 2]];
      else if (edge) terms = [[center, 2], [atLeft ? right : left, 2], [up, 2], [down, 2]];
      else terms = [[center, 1], [left, 3], [right, 3], [up, 3], [down, 3]];
      rounding = corner ? 2 : edge ? 3 : 4;
    }
    let red = roundUp ? rounding : 0;
    let green = red; let blue = red;
    for (const [pixel, shift] of terms) {
      blue += (pixel & 255) >>> shift;
      green += ((pixel >>> 8) & 255) >>> shift;
      red += ((pixel >>> 16) & 255) >>> shift;
    }
    result[index] = (blue & 255) | ((green & 255) << 8) | ((red & 255) << 16);
  }
  return result;
}

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
