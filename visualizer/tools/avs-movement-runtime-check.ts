import {
  AVS_AUDIO_SAMPLES,
  AvsEffectRegistry,
  AvsExecutor,
  AvsFramebuffer,
  decodeAvsMovement,
  registerAvsMovement,
  type AvsAudioFrame,
  type AvsComponent,
  type AvsPresetAst,
} from '../src/avs/index.ts';

let checks = 0;

// AVS stores built-ins 16..23 as an initial zero plus a trailing real effect ID
// so versions that only understood effects <=15 could still load the payload.
const extended = movementPayload(0, '', { trailingEffect: 20 });
equal(decodeAvsMovement(extended).effect, 20, 'extended built-in effect ID');

const identity = render(
  movementPayload(32_767, 'x=x;y=y', { rectangular: true }),
  4, 2,
  [0x000001, 0x000002, 0x000003, 0x000004, 0x000005, 0x000006, 0x000007, 0x000008],
);
arrayEqual(identity, [1, 2, 3, 4, 5, 6, 7, 8], 'custom rectangular identity inverse map');

const wrapped = render(
  movementPayload(32_767, 'x=x+2/sw', { rectangular: true, wrap: true }),
  4, 2,
  [1, 2, 3, 4, 5, 6, 7, 8],
);
arrayEqual(wrapped, [2, 3, 4, 1, 6, 7, 8, 5], 'custom inverse map wraps source coordinates');

const bilinear = render(
  movementPayload(32_767, 'x=x+1/sw', { rectangular: true, subpixel: true }),
  4, 2,
  [0x000000, 0xffffff, 0x000000, 0x000000, 0x000000, 0xffffff, 0x000000, 0x000000],
);
equal(bilinear[0], 0x808080, 'portable AVS 5-bit bilinear sample');

const shiftInput = Array.from({ length: 64 }, (_, i) => i + 1);
const builtInShift = render(movementPayload(2), 64, 1, shiftInput);
equal(builtInShift[0], 2, 'built-in shift rotate left starts one pixel later');
equal(builtInShift[63], 1, 'built-in shift rotate left wraps at row edge');

const forward = render(
  movementPayload(32_767, 'x=x+2/sw', { rectangular: true, wrap: true, sourceMapped: 1 }),
  4, 2,
  [1, 2, 3, 4, 5, 6, 7, 8],
);
arrayEqual(forward, [4, 1, 2, 3, 8, 5, 6, 7], 'source-mapped mode scatters inputs with maximum compositing');

// A bit-1 source-map config switches bit 0 on each beat. This state belongs to
// the Movement instance and therefore must survive render calls.
const toggledPayload = movementPayload(32_767, 'x=x+2/sw', {
  rectangular: true, wrap: true, sourceMapped: 2,
});
const toggled = executorFor(toggledPayload, 'toggle');
const first = framebuffer(4, 2, [1, 2, 3, 4, 5, 6, 7, 8]);
toggled.render(first, emptyAudio(true));
arrayEqual(first.pixels, [4, 1, 2, 3, 8, 5, 6, 7], 'beat toggles source mapping on');
const second = framebuffer(4, 2, [1, 2, 3, 4, 5, 6, 7, 8]);
toggled.render(second, emptyAudio(true));
arrayEqual(second.pixels, [2, 3, 4, 1, 6, 7, 8, 5], 'next beat toggles source mapping off');

console.log(`avs-movement-runtime-check: PASS (${checks} assertions)`);

function render(payload: Uint8Array, width: number, height: number, pixels: readonly number[]): Uint32Array {
  const executor = executorFor(payload, 'movement');
  const output = framebuffer(width, height, pixels);
  executor.render(output, emptyAudio(false));
  return output.pixels;
}

function executorFor(payload: Uint8Array, path: string): AvsExecutor {
  const component: AvsComponent = {
    effectId: 15, apeId: null, payload, fileOffset: 0, path,
    children: [], list: null, listCode: null,
  };
  const preset: AvsPresetAst = {
    version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: false,
    components: [component], byteLength: payload.length + 32,
  };
  return new AvsExecutor(preset, registerAvsMovement(new AvsEffectRegistry()));
}

function movementPayload(
  effect: number,
  expression = '',
  options: {
    blend?: boolean;
    sourceMapped?: number;
    rectangular?: boolean;
    subpixel?: boolean;
    wrap?: boolean;
    trailingEffect?: number;
  } = {},
): Uint8Array {
  const encoded = new TextEncoder().encode(`${expression}\0`);
  const customBytes = effect === 32_767 ? 1 + 4 + encoded.length : 0;
  const trailingBytes = options.trailingEffect === undefined ? 0 : 4;
  const payload = new Uint8Array(4 + customBytes + 20 + trailingBytes);
  const view = new DataView(payload.buffer);
  let offset = 0;
  view.setInt32(offset, effect, true); offset += 4;
  if (effect === 32_767) {
    payload[offset++] = 1;
    view.setInt32(offset, encoded.length, true); offset += 4;
    payload.set(encoded, offset); offset += encoded.length;
  }
  view.setInt32(offset, options.blend ? 1 : 0, true); offset += 4;
  view.setInt32(offset, options.sourceMapped ?? 0, true); offset += 4;
  view.setInt32(offset, options.rectangular ? 1 : 0, true); offset += 4;
  view.setInt32(offset, options.subpixel ? 1 : 0, true); offset += 4;
  view.setInt32(offset, options.wrap ? 1 : 0, true); offset += 4;
  if (options.trailingEffect !== undefined) view.setInt32(offset, options.trailingEffect, true);
  return payload;
}

function framebuffer(width: number, height: number, pixels: readonly number[]): AvsFramebuffer {
  return new AvsFramebuffer(width, height, Uint32Array.from(pixels));
}

function emptyAudio(beat: boolean): AvsAudioFrame {
  return {
    waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    beat, beatLevel: 0,
  };
}

function equal(actual: unknown, expected: unknown, label: string): void {
  checks++;
  if (actual !== expected) throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`);
}

function arrayEqual(actual: ArrayLike<number>, expected: readonly number[], label: string): void {
  checks++;
  const values = Array.from(actual);
  if (values.length !== expected.length || values.some((value, index) => value !== expected[index])) {
    throw new Error(`${label}: got [${values.join(',')}], expected [${expected.join(',')}]`);
  }
}
