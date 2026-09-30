import {
  AVS_AUDIO_SAMPLES,
  AVS_COLOR_MAP_APE_ID,
  AvsExecutor,
  AvsFramebuffer,
  buildAvsColorMapTable,
  createAvsCompatibilityRegistry,
  decodeAvsColorMap,
  registerAvsColorMap,
  type AvsAudioFrame,
  type AvsColorMapPoint,
  type AvsComponent,
  type AvsPresetAst,
} from '../src/avs/index.ts';

let checks = 0;

const decodedPayload = payload({
  key: 4, blendMode: 9, cycleMode: 2, amount: 173, dontSkip: true, speed: 13,
  maps: [
    { enabled: true, color: 0x123456, filename: 'ember.clm', id: 0x11223344 },
    { enabled: true, color: 0xabcdef },
  ],
});
const decoded = decodeAvsColorMap(decodedPayload);
equal(decoded.key, 4, 'key mode decoded');
equal(decoded.blendMode, 9, 'blend mode decoded');
equal(decoded.mapCycleMode, 2, 'cycle mode decoded');
equal(decoded.adjustBlend, 173, 'adjustable blend byte decoded');
equal(decoded.dontSkipFastBeats, true, 'fast-beat guard decoded');
equal(decoded.cycleSpeed, 13, 'cycle speed decoded');
equal(decoded.maps.length, 8, 'all eight native map records decoded');
equal(decoded.maps[0]!.filename, 'ember.clm', 'map filename decoded');
equal(decoded.maps[0]!.id, 0x11223344, 'opaque map id preserved');
equal(decoded.maps[0]!.points[1]!.position, 255, 'dynamic point tail decoded');
equal(decoded.maps[0]!.points[1]!.color, 0x123456, 'BGR color word decoded');

const malformed = decodeAvsColorMap(new Uint8Array(32));
equal(malformed.cycleSpeed, 8, 'short config takes native default speed');
equal(malformed.maps[0]!.enabled, true, 'short config creates enabled map one');
equal(malformed.maps[1]!.enabled, false, 'short config creates disabled remaining maps');

const ramp = buildAvsColorMapTable([point(0, 0), point(255, 0xffffff)]);
equal(ramp[0], 0, 'LUT preserves first endpoint');
equal(ramp[128], 0x7f7f7f, 'LUT uses native fixed-point interpolation');
equal(ramp[255], 0xffffff, 'LUT preserves last endpoint');

const keyExpected = [0x1f1f1f, 0x3f3f3f, 0x7f7f7f, 0x6f6f6f, 0x7f7f7f, 0x494949];
for (let key = 0; key < keyExpected.length; key++) {
  const output = run(payload({ key, maps: [{ enabled: true, points: [point(0, 0), point(255, 0xffffff)] }] }), [0x204080]);
  equal(output.pixels[0], keyExpected[key], `key mode ${key}`);
}

const blendExpected = [
  0x406080, 0x60a0e0, 0x406080, 0x204060, 0x305070,
  0x000000, 0x202020, 0x081830, 0x6020e0, 0x305070,
];
for (let blendMode = 0; blendMode < blendExpected.length; blendMode++) {
  const output = run(payload({ blendMode, amount: 128, maps: [{ enabled: true, color: 0x406080 }] }), [0x204060]);
  equal(output.pixels[0], blendExpected[blendMode], `blend mode ${blendMode}`);
}

const cyclePayload = payload({
  cycleMode: 2, speed: 64,
  maps: [{ enabled: true, color: 0 }, { enabled: true, color: 0xffffff }],
});
const cycleFramebuffer = new AvsFramebuffer(1, 1);
const cycleExecutor = new AvsExecutor(preset(ape(cyclePayload, 'cycle')), registerAvsColorMap());
cycleExecutor.render(cycleFramebuffer, audio(true));
equal(cycleFramebuffer.pixels[0], 0, 'beat starts sequential transition at previous map');
cycleFramebuffer.pixels[0] = 0;
cycleExecutor.render(cycleFramebuffer, audio(false));
equal(cycleFramebuffer.pixels[0], 0x3f3f3f, 'transition advances by native speed byte');
for (let frame = 0; frame < 3; frame++) {
  cycleFramebuffer.pixels[0] = 0;
  cycleExecutor.render(cycleFramebuffer, audio(false));
}
equal(cycleFramebuffer.pixels[0], 0xffffff, 'transition reaches target map at 256');

const preinit = run(payload({ maps: [{ enabled: true, color: 0xffffff }] }), [0x123456], false, true);
equal(preinit.pixels[0], 0x123456, 'Color Map bypasses preinit');

const defaultFramebuffer = new AvsFramebuffer(1, 1, Uint32Array.of(0x123456));
const stats = new AvsExecutor(
  preset(ape(payload({ maps: [{ enabled: true, color: 0xabcdef }] }))),
  createAvsCompatibilityRegistry(),
).render(defaultFramebuffer, audio(false));
equal(stats.unsupported, 0, 'default registry dispatches exact Color Map APE id');
equal(defaultFramebuffer.pixels[0], 0xabcdef, 'default registry executes Color Map');

console.log(`avs-color-map-runtime-check: PASS (${checks} assertions)`);

interface FixtureMap {
  readonly enabled?: boolean;
  readonly color?: number;
  readonly points?: readonly AvsColorMapPoint[];
  readonly filename?: string;
  readonly id?: number;
}
interface FixtureConfig {
  readonly key?: number;
  readonly blendMode?: number;
  readonly cycleMode?: number;
  readonly amount?: number;
  readonly dontSkip?: boolean;
  readonly speed?: number;
  readonly maps?: readonly FixtureMap[];
}
function payload(config: FixtureConfig): Uint8Array {
  const maps = Array.from({ length: 8 }, (_, index) => {
    const source = config.maps?.[index];
    return {
      enabled: source?.enabled ?? index === 0,
      points: source?.points ?? [point(0, source?.color ?? 0), point(255, source?.color ?? 0)],
      filename: source?.filename ?? '', id: source?.id ?? index,
    };
  });
  const result = new Uint8Array(496 + maps.reduce((sum, map) => sum + map.points.length * 12, 0));
  const view = new DataView(result.buffer);
  view.setInt32(0, config.key ?? 0, true);
  view.setInt32(4, config.blendMode ?? 0, true);
  view.setInt32(8, config.cycleMode ?? 0, true);
  result[12] = config.amount ?? 0;
  result[14] = config.dontSkip ? 1 : 0;
  result[15] = config.speed ?? 8;
  let tail = 496;
  maps.forEach((map, index) => {
    const header = 16 + index * 60;
    view.setInt32(header, map.enabled ? 1 : 0, true);
    view.setInt32(header + 4, map.points.length, true);
    view.setUint32(header + 8, map.id, true);
    new TextEncoder().encodeInto(map.filename, result.subarray(header + 12, header + 60));
    map.points.forEach((mapPoint) => {
      view.setUint32(tail, mapPoint.position, true);
      view.setUint32(tail + 4, mapPoint.color, true);
      view.setUint32(tail + 8, mapPoint.id, true);
      tail += 12;
    });
  });
  return result;
}
function point(position: number, color: number): AvsColorMapPoint {
  return { position, color, id: position };
}
function run(bytes: Uint8Array, pixels: readonly number[], beat = false, preinit = false): AvsFramebuffer {
  const framebuffer = new AvsFramebuffer(pixels.length, 1, Uint32Array.from(pixels));
  const stats = new AvsExecutor(preset(ape(bytes)), registerAvsColorMap()).render(framebuffer, audio(beat), preinit);
  equal(stats.unsupported, 0, 'Color Map dispatches');
  return framebuffer;
}
function ape(bytes: Uint8Array, path = '1'): AvsComponent {
  return { effectId: 16384, apeId: AVS_COLOR_MAP_APE_ID, payload: bytes, fileOffset: 0, path, children: [], list: null, listCode: null };
}
function preset(component: AvsComponent): AvsPresetAst {
  return { version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: false, components: [component], byteLength: 0 };
}
function audio(beat: boolean): AvsAudioFrame {
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
