import {
  AVS_AUDIO_SAMPLES,
  AvsEffectRegistry,
  AvsExecutor,
  AvsFramebuffer,
  decodeAvsBump,
  decodeAvsText,
  registerAvsBump,
  registerAvsText,
  type AvsAudioFrame,
  type AvsComponent,
  type AvsPresetAst,
  type AvsTextRasterRequest,
} from '../src/avs/index.ts';

let checks = 0;

const textPayload = makeTextPayload({
  text: 'HELLO;WORLD', color: 0x123456, normalFrames: 2,
  fontHeight: -14, fontWeight: 700, fontFace: 'Arial', outline: 1,
  outlineColor: 0x654321, xShift: 12, yShift: -8, outlineSize: 3, randomWord: 1, shadow: 1,
});
const textConfig = decodeAvsText(textPayload);
equal(textConfig.text, 'HELLO;WORLD', 'Text string after Win32 structures');
equal(textConfig.font.height, -14, 'Text LOGFONT height');
equal(textConfig.font.weight, 700, 'Text LOGFONT weight');
equal(textConfig.font.face, 'Arial', 'Text LOGFONT face');
equal(textConfig.outlineColor, 0x654321, 'Text versioned outline color');
equal(textConfig.shadow, true, 'Text trailing shadow flag');

const legacyBump = decodeAvsBump(makeBumpPayload({
  frame: 'x=.5', beatCode: 'x=1', init: 'x=0', includeOldStyle: false,
}));
equal(legacyBump.frame, 'x=.5', 'Bump frame script');
equal(legacyBump.beat, 'x=1', 'Bump beat script');
equal(legacyBump.init, 'x=0', 'Bump init script');
equal(legacyBump.oldStyle, true, 'Bump missing style word selects legacy percentage coordinates');

const requests: AvsTextRasterRequest[] = [];
const textRegistry = registerAvsText(new AvsEffectRegistry(), {
  title: () => '01. Demo Song - Winamp',
  playbackPositionMs: () => 62_345,
  rasterize: (request) => {
    requests.push(request);
    const pixels = new Uint32Array(request.width * request.height);
    const mask = new Uint8Array(pixels.length);
    if (request.text) { pixels[0] = request.color; mask[0] = 1; }
    return { pixels, mask, textWidth: request.text.length, textHeight: 1 };
  },
});
textRegistry.eelGlobal.registers[0] = 1.25;
const textExecutor = executorFor([
  component(28, makeTextPayload({
    text: 'A$(reg00:.2);$(title:4) $(playpos.2)', normalFrames: 1, color: 0x010203,
  }), 'text'),
], textRegistry);
const firstText = framebuffer(2, 1, [0x101010, 0]);
textExecutor.render(firstText, audio(false));
equal(requests[0]?.text, 'A1.25', 'Text reg substitution and first word');
equal(firstText.pixels[0], 0x010203, 'Text replacement blend');
const secondText = framebuffer(2, 1, [0, 0]);
textExecutor.render(secondText, audio(false));
equal(requests[1]?.text, 'Demo 1:02.34', 'Text title truncation and play position substitution');

const beatRequests: AvsTextRasterRequest[] = [];
const beatRegistry = registerAvsText(new AvsEffectRegistry(), {
  rasterize: (request) => {
    beatRequests.push(request);
    return {
      pixels: new Uint32Array(request.width * request.height).fill(0x202020),
      mask: new Uint8Array(request.width * request.height).fill(1), textWidth: 1, textHeight: 1,
    };
  },
});
const beatText = executorFor([
  component(28, makeTextPayload({ text: 'A;B', onBeat: 1, beatFrames: 2 }), 'beat-text'),
], beatRegistry);
beatText.render(framebuffer(1, 1, [0]), audio(false));
equal(beatRequests.length, 0, 'Beat-sensitive Text is hidden before a beat');
beatText.render(framebuffer(1, 1, [0]), audio(true));
equal(beatRequests[0]?.text, 'B', 'Beat-sensitive Text advances and starts timer on beat');
beatText.render(framebuffer(1, 1, [0]), audio(false));
equal(beatRequests.length, 2, 'Beat-sensitive Text persists for configured frames');
beatText.render(framebuffer(1, 1, [0]), audio(false));
equal(beatRequests.length, 2, 'Beat-sensitive Text hides after timer expires');

const depthPixels = new Array(25).fill(0);
depthPixels[12] = 0x010101;
depthPixels[13] = 0x0a0a0a;
depthPixels[17] = 0x0a0a0a;
const bumpRegistry = registerAvsBump(new AvsEffectRegistry());
const bump = render(
  29,
  makeBumpPayload({ frame: 'x=.5;y=.5;bi=getspec(0,0,1)', oldStyle: 0, depth: 30 }),
  5, 5, depthPixels, audio(false, 255), bumpRegistry,
);
equal(bump[12], 0x404040, 'Bump portable lighting and getspec host');
equal(bump[0], 0, 'Bump clears output border');

const beatBumpRegistry = registerAvsBump(new AvsEffectRegistry());
const beatBumpPayload = makeBumpPayload({
  frame: 'x=.5;y=.5;bi=1;reg00=isbeat;reg01=islbeat', oldStyle: 0,
  onBeat: 1, depth: 30, beatDepth: 100, duration: 2,
});
const beatBumpExecutor = executorFor([component(29, beatBumpPayload, 'beat-bump')], beatBumpRegistry);
const beatBumpFrame = framebuffer(5, 5, depthPixels);
beatBumpExecutor.render(beatBumpFrame, audio(true));
equal(beatBumpFrame.pixels[12], 0xd6d6d6, 'Bump beat depth applies immediately');
equal(beatBumpRegistry.eelGlobal.registers[0], 0, 'Bump scripts observe previous isbeat value');
const afterBeat = framebuffer(5, 5, depthPixels);
beatBumpExecutor.render(afterBeat, audio(false));
equal(beatBumpRegistry.eelGlobal.registers[0], -1, 'Bump refreshes isbeat after scripts');
equal(beatBumpRegistry.eelGlobal.registers[1], 1, 'Bump scripts see pre-trigger long-beat state on following frame');
const afterLongBeat = framebuffer(5, 5, depthPixels);
beatBumpExecutor.render(afterLongBeat, audio(false));
equal(beatBumpRegistry.eelGlobal.registers[1], -1, 'Bump refreshed long-beat state reaches later scripts');

const noBuffer = render(
  29,
  makeBumpPayload({ frame: 'x=.5;y=.5', oldStyle: 0, buffer: 1 }),
  3, 3, new Array(9).fill(0x111111), audio(false), registerAvsBump(new AvsEffectRegistry()),
);
equal(noBuffer[4], 0x111111, 'Bump missing global depth buffer bypasses');

console.log(`avs-text-bump-runtime-check: PASS (${checks} assertions)`);

function render(
  effectId: number,
  payload: Uint8Array,
  width: number,
  height: number,
  pixels: readonly number[],
  frame: AvsAudioFrame,
  registry: AvsEffectRegistry,
): Uint32Array {
  const target = framebuffer(width, height, pixels);
  executorFor([component(effectId, payload, `effect-${effectId}`)], registry).render(target, frame);
  return target.pixels;
}

function executorFor(components: readonly AvsComponent[], registry: AvsEffectRegistry): AvsExecutor {
  const preset: AvsPresetAst = {
    version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: false,
    components, byteLength: components.reduce((sum, item) => sum + item.payload.length + 32, 0),
  };
  return new AvsExecutor(preset, registry);
}

function component(effectId: number, payload: Uint8Array, path: string): AvsComponent {
  return { effectId, apeId: null, payload, fileOffset: 0, path, children: [], list: null, listCode: null };
}

function framebuffer(width: number, height: number, pixels: readonly number[]): AvsFramebuffer {
  return new AvsFramebuffer(width, height, Uint32Array.from(pixels));
}

function makeTextPayload(options: {
  text?: string; enabled?: number; color?: number; additive?: number; average?: number;
  onBeat?: number; insertBlank?: number; randomPosition?: number; verticalAlign?: number;
  horizontalAlign?: number; beatFrames?: number; normalFrames?: number; fontHeight?: number;
  fontWeight?: number; fontFace?: string; outline?: number; outlineColor?: number;
  xShift?: number; yShift?: number; outlineSize?: number; randomWord?: number; shadow?: number;
}): Uint8Array {
  const text = new TextEncoder().encode(`${options.text ?? ''}\0`);
  const payload = new Uint8Array(44 + 60 + 60 + 4 + text.length + 28);
  const view = new DataView(payload.buffer);
  const header = [
    options.enabled ?? 1, options.color ?? 0xffffff, options.additive ?? 0, options.average ?? 0,
    options.onBeat ?? 0, options.insertBlank ?? 0, options.randomPosition ?? 0,
    options.verticalAlign ?? 4, options.horizontalAlign ?? 1,
    options.beatFrames ?? 15, options.normalFrames ?? 15,
  ];
  header.forEach((value, index) => view.setInt32(index * 4, value, true));
  const logFont = 44 + 60;
  view.setInt32(logFont, options.fontHeight ?? -7, true);
  view.setInt32(logFont + 16, options.fontWeight ?? 400, true);
  payload.set(new TextEncoder().encode(options.fontFace ?? 'Arial').subarray(0, 31), logFont + 28);
  let offset = logFont + 60;
  view.setInt32(offset, text.length, true); offset += 4;
  payload.set(text, offset); offset += text.length;
  const suffix = [
    options.outline ?? 0, options.outlineColor ?? 0, options.xShift ?? 0, options.yShift ?? 0,
    options.outlineSize ?? 1, options.randomWord ?? 0, options.shadow ?? 0,
  ];
  suffix.forEach((value) => { view.setInt32(offset, value, true); offset += 4; });
  return payload;
}

function makeBumpPayload(options: {
  enabled?: number; onBeat?: number; duration?: number; depth?: number; beatDepth?: number;
  additive?: number; average?: number; frame?: string; beatCode?: string; init?: string;
  showLight?: number; invert?: number; oldStyle?: number; buffer?: number; includeOldStyle?: boolean;
}): Uint8Array {
  const scripts = [options.frame ?? '', options.beatCode ?? '', options.init ?? ''];
    const encoded = scripts.map((script) => new TextEncoder().encode(`${script}\0`));
  const suffixWords = options.includeOldStyle === false ? 2 : 4;
  const payload = new Uint8Array(28 + encoded.reduce((sum, bytes) => sum + 4 + bytes.length, 0) + suffixWords * 4);
  const view = new DataView(payload.buffer);
  const header = [
    options.enabled ?? 1, options.onBeat ?? 0, options.duration ?? 15,
    options.depth ?? 30, options.beatDepth ?? 100, options.additive ?? 0, options.average ?? 0,
  ];
  header.forEach((value, index) => view.setInt32(index * 4, value, true));
  let offset = 28;
  for (const bytes of encoded) {
    view.setInt32(offset, bytes.length, true); offset += 4;
    payload.set(bytes, offset); offset += bytes.length;
  }
  view.setInt32(offset, options.showLight ?? 0, true); offset += 4;
  view.setInt32(offset, options.invert ?? 0, true); offset += 4;
  if (options.includeOldStyle !== false) {
    view.setInt32(offset, options.oldStyle ?? 0, true); offset += 4;
    view.setInt32(offset, options.buffer ?? 0, true);
  }
  return payload;
}

function audio(beat: boolean, firstSpectrum = 0): AvsAudioFrame {
  const spectrum = [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)] as const;
  spectrum[0][0] = firstSpectrum;
  return {
    waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    spectrum, beat, beatLevel: 0,
  };
}

function equal(actual: unknown, expected: unknown, label: string): void {
  checks++;
  if (actual !== expected) throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`);
}
