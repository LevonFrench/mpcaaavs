import assert from 'node:assert/strict';
import {
  AVS_FRAME_RATE_LOCKS, AVS_QUALITY_TIERS, AVS_RESOLUTION_MODES, AVS_UPSCALE_MODES, AvsDimensionsDebouncer,
  AvsFrameGovernor, DEFAULT_AVS_DISPLAY_SETTINGS, DisplayRateEstimator, avsGovernorOptions, avsPresentationLayout,
  copyAvsPixelsToRgba, frameRateLockFps, nextInCycle, parseAvsDisplaySettings, presentationScale,
} from '../src/avs-presentation.ts';
import { AvsWorkerRenderer } from '../src/avs-worker-client.ts';
import type { AvsWorkerRequest, AvsWorkerResponse } from '../src/avs-worker-protocol.ts';
import type { AudioSnapshot } from '../src/contracts.ts';

const governor = new AvsFrameGovernor();
assert.deepEqual(governor.dimensions(1920, 1080), { width: 429, height: 241 });
assert.deepEqual(governor.dimensions(1080, 1920), { width: 241, height: 429 });
assert.deepEqual(governor.dimensions(2160, 2160), { width: 322, height: 322 });

// A display running below the AVS ceiling is never cadence-throttled. The busy
// worker gate, not this governor, provides one-frame backpressure.
let audioTicks = 0;
let visualFrames = 0;
for (let tick = 0; tick <= 60; tick++) {
  audioTicks++;
  if (governor.shouldRender(tick * (1000 / 60))) visualFrames++;
}
assert.equal(audioTicks, 61);
assert.equal(visualFrames, 61, `expected every 60 Hz display frame, got ${visualFrames}`);

// A 240 Hz callback stream is capped at approximately 165 AVS frames/second.
const ceiling = new AvsFrameGovernor({ initialTier: 0 });
let cappedFrames = 0;
for (let tick = 0; tick <= 240; tick++) {
  if (ceiling.shouldRender(tick * (1000 / 240))) cappedFrames++;
}
assert.ok(cappedFrames >= 164 && cappedFrames <= 166, `expected ~165 AVS frames, got ${cappedFrames}`);

// A long stall produces one frame, never a catch-up burst on subsequent rAFs.
assert.equal(governor.shouldRender(5000), true);
assert.equal(governor.shouldRender(5001), false);

const adaptive = new AvsFrameGovernor({
  initialTier: 0,
  downgradeSamples: 3,
  upgradeSamples: 4,
});
assert.equal(adaptive.qualityIndex, 0);
assert.equal(adaptive.recordRender(8), false);
assert.equal(adaptive.recordRender(8), false);
assert.equal(adaptive.recordRender(8), true);
assert.equal(adaptive.qualityIndex, 1);
assert.deepEqual(adaptive.dimensions(1920, 1080), { width: 512, height: 288 });
for (let i = 0; i < 3; i++) assert.equal(adaptive.recordRender(1), false);
assert.equal(adaptive.recordRender(1), true);
assert.equal(adaptive.qualityIndex, 0);

// Multi-hundred-ms frames downgrade immediately rather than waiting several
// seconds to collect the normal hysteresis window.
const pathological = new AvsFrameGovernor({ initialTier: 0 });
for (let tier = 1; tier < AVS_QUALITY_TIERS.length; tier++) {
  assert.equal(pathological.recordRender(500), true);
  assert.equal(pathological.qualityIndex, tier);
}
assert.equal(pathological.recordRender(500), false);

// The production tiers reduce both pixels and cadence under sustained load.
assert.deepEqual(AVS_QUALITY_TIERS.map((tier) => [tier.scale, tier.fps]), [
  [1, 165], [0.8, 120], [0.67, 60], [0.5, 30],
]);

const packed = new Uint32Array([0x00112233, 0x00a0b0c0, 0x00000000, 0x00ffffff]);
const rgba = new Uint8ClampedArray(packed.length * 4);
const words = new Uint32Array(rgba.buffer);
copyAvsPixelsToRgba(packed, rgba, words);
assert.deepEqual([...rgba], [
  0x11, 0x22, 0x33, 0xff,
  0xa0, 0xb0, 0xc0, 0xff,
  0x00, 0x00, 0x00, 0xff,
  0xff, 0xff, 0xff, 0xff,
]);
assert.throws(() => copyAvsPixelsToRgba(packed, new Uint8ClampedArray(3)), /expected 16/);

// ---------------------------------------------------------------- scale table
// 17 common panels. `fit` is today's raster and must never move; `k`/`exact`
// is the sharp-bilinear integer prescale (exact = the compositor remainder is
// exactly 1, i.e. sharp-bilinear draws the same blocks as nearest today);
// `crisp` is the opt-in integer raster with its device-pixel factor.
const classic = new AvsFrameGovernor(avsGovernorOptions(DEFAULT_AVS_DISPLAY_SETTINGS, 'worker'));
const crisp = new AvsFrameGovernor(avsGovernorOptions({ ...DEFAULT_AVS_DISPLAY_SETTINGS, resolution: 'crisp' }, 'worker'));
const scaleTable: readonly [number, number, [number, number], number, boolean, number, [number, number]][] = [
  [1280, 720, [640, 360], 2, true, 2, [640, 360]],
  [1366, 768, [640, 360], 2, false, 3, [456, 256]],
  [1440, 900, [607, 379], 2, false, 3, [480, 300]],
  [1536, 864, [640, 360], 2, false, 3, [512, 288]],
  [1600, 900, [640, 360], 2, false, 3, [534, 300]],
  [1680, 1050, [607, 379], 2, false, 3, [560, 350]],
  [1920, 1080, [640, 360], 3, true, 3, [640, 360]],
  [1920, 1200, [607, 379], 3, false, 3, [640, 400]],
  [2560, 1080, [640, 270], 4, true, 4, [640, 270]],
  [2560, 1440, [640, 360], 4, true, 4, [640, 360]],
  [2560, 1600, [607, 379], 4, false, 4, [640, 400]],
  [2880, 1800, [607, 379], 4, false, 5, [576, 360]],
  [3440, 1440, [640, 268], 5, false, 5, [688, 288]],
  [3840, 2160, [640, 360], 6, true, 6, [640, 360]],
  [1024, 768, [554, 416], 1, false, 2, [512, 384]],
  [1280, 800, [607, 379], 2, false, 2, [640, 400]],
  [1280, 1024, [537, 429], 2, false, 3, [427, 342]],
];
assert.equal(scaleTable.length, 17);
for (const [dw, dh, [fw, fh], k, exact, ck, [cw, ch]] of scaleTable) {
  const label = `${dw}x${dh}`;
  // The default worker governor (settings = today) and the historical tier-0
  // governor agree on every panel.
  assert.deepEqual(classic.dimensions(dw, dh), { width: fw, height: fh }, label);
  assert.deepEqual(new AvsFrameGovernor({ initialTier: 0 }).dimensions(dw, dh), { width: fw, height: fh }, label);
  const scale = presentationScale(fw, fh, dw, dh);
  assert.equal(scale.scale, k, `${label} prescale`);
  assert.equal(scale.remainder === 1 && scale.remainderX === 1 && scale.remainderY === 1, exact, `${label} remainder`);
  assert.deepEqual(crisp.dimensions(dw, dh), { width: cw, height: ch }, `${label} crisp`);
  assert.equal(crisp.integerFactor(dw, dh), ck, `${label} crisp k`);
  // Crisp overscan is at most k-1 device px per axis and is centred.
  const cover = avsPresentationLayout('pixelated', cw, ch, dw, dh, true);
  assert.equal(cover.box!.width, ck * cw, `${label} crisp cover`);
  assert.ok(cover.box!.width - dw < ck && cover.box!.height - dh < ck && cover.box!.height >= dh, `${label} overscan`);

  // Default presentation is exactly today's: raster-sized canvas, CSS stretch, nearest.
  assert.deepEqual(avsPresentationLayout('pixelated', fw, fh, dw, dh), {
    canvasWidth: fw, canvasHeight: fh, prescale: 1, box: null, imageRendering: 'pixelated',
  }, label);
  const sharp = avsPresentationLayout('sharp-bilinear', fw, fh, dw, dh);
  assert.equal(sharp.canvasWidth, k * fw);
  assert.equal(sharp.prescale, k);
  // Integer displays: k*w == device and the filter stays nearest, so the default
  // sharp-bilinear output is today's pixelated output (also confirmed by
  // headless-Chrome screenshots: 0 differing pixels).
  if (exact) {
    assert.equal(sharp.imageRendering, 'pixelated', `${label} exact sharp`);
    assert.deepEqual([sharp.canvasWidth, sharp.canvasHeight], [dw, dh], `${label} exact sharp canvas`);
  }
  const letterbox = avsPresentationLayout('integer-letterbox', fw, fh, dw, dh);
  assert.ok(letterbox.box!.left >= 0 && letterbox.box!.width === k * fw && letterbox.box!.width <= dw, `${label} letterbox`);
}
// VQ1's measured factors for today's fit raster.
assert.equal((1920 / 607).toFixed(3), '3.163');
assert.equal((1024 / 554).toFixed(3), '1.848');
// Within one device pixel of an integer, sharp-bilinear keeps nearest; beyond, bilinear.
assert.equal(avsPresentationLayout('sharp-bilinear', 640, 323, 1920, 970).imageRendering, 'pixelated');
assert.equal(avsPresentationLayout('sharp-bilinear', 607, 379, 1920, 1200).imageRendering, 'auto');

// ---------------------------------------------------------------- governor floor
// Classic and crisp worker governors can never leave scale 1, whatever the load,
// the display rate or the clock: the default raster is invariant under recordRender.
for (const governorUnderTest of [classic, crisp]) {
  const before = governorUnderTest.dimensions(1920, 1080);
  governorUnderTest.setDisplayHz(60);
  for (let i = 0; i < 2000; i++) {
    assert.equal(governorUnderTest.recordRender(i % 7 === 0 ? 900 : 40, i * 40), false);
    assert.equal(governorUnderTest.tier.scale, 1);
  }
  assert.deepEqual(governorUnderTest.dimensions(1920, 1080), before);
  assert.ok(governorUnderTest.averageRenderMs > 0, 'recordRender still feeds the average');
  governorUnderTest.setDisplayHz(null);
}
// Every frame-rate lock keeps the floor too.
for (const frameRate of AVS_FRAME_RATE_LOCKS) {
  for (const resolution of AVS_RESOLUTION_MODES) {
    const g = new AvsFrameGovernor(avsGovernorOptions({ ...DEFAULT_AVS_DISPLAY_SETTINGS, frameRate, resolution }, 'worker'));
    for (let i = 0; i < 500; i++) g.recordRender(1000, i * 5000);
    assert.ok(g.tier.scale >= 1, `${resolution}/${frameRate} floor`);
  }
}
// High starts at 2x caps (never above the display), steps down only after the
// warm-up and the 2 s dwell, stops at classic, and never climbs back mid-preset.
const high = new AvsFrameGovernor(avsGovernorOptions({ ...DEFAULT_AVS_DISPLAY_SETTINGS, resolution: 'high' }, 'worker'));
high.setDisplayHz(60);
assert.deepEqual(high.dimensions(1920, 1080), { width: 1280, height: 720 });
assert.deepEqual(high.dimensions(800, 450), { width: 800, height: 450 });
for (let i = 0; i < 3; i++) assert.equal(high.recordRender(900, i), false, 'warm-up ignored');
assert.equal(high.recordRender(900, 10), true);
assert.equal(high.tier.scale, 1.5);
for (let i = 0; i < 20; i++) assert.equal(high.recordRender(900, 20 + i), false, 'dwell holds 1.5x');
assert.equal(high.recordRender(900, 2100), true);
assert.equal(high.tier.scale, 1);
assert.deepEqual(high.dimensions(1920, 1080), { width: 640, height: 360 });
for (let i = 0; i < 5000; i++) assert.equal(high.recordRender(0.1, 10_000 + i), false, 'no upgrade mid-preset');
high.reset();
assert.equal(high.tier.scale, 2);

// The fallback keeps today's four tiers with the default settings.
assert.deepEqual(avsGovernorOptions(DEFAULT_AVS_DISPLAY_SETTINGS, 'fallback'), { initialTier: 0, dimensionsPolicy: 'fit' });
const lockedFallback = new AvsFrameGovernor(avsGovernorOptions({ ...DEFAULT_AVS_DISPLAY_SETTINGS, frameRate: '30' }, 'fallback'));
assert.equal(lockedFallback.tier.fps, 30);

// ---------------------------------------------------------------- display-aware cadence
// Budget follows min(tier fps, display): a 12 ms frame on a 60 Hz panel is not
// "twice over" a 6 ms budget. Without setDisplayHz the old rule is unchanged.
const legacyBudget = new AvsFrameGovernor({ initialTier: 0 });
assert.equal(legacyBudget.recordRender(13), true, 'unchanged legacy immediate step-down');
const displayBudget = new AvsFrameGovernor({ initialTier: 0 });
displayBudget.setDisplayHz(60);
assert.equal(displayBudget.recordRender(13), false);
// Vsync-divisor cadence with half-a-vsync tolerance: a 60 fps lock on a 120 Hz
// panel with +-1 ms rAF jitter renders every second vsync, never 1 or 3.
const locked = new AvsFrameGovernor(avsGovernorOptions({ ...DEFAULT_AVS_DISPLAY_SETTINGS, frameRate: '60' }, 'worker'));
locked.setDisplayHz(120);
let previous = -1;
const gaps = new Map<number, number>();
for (let vsync = 0; vsync < 600; vsync++) {
  const jitter = ((vsync * 7919) % 200) / 100 - 1;
  if (locked.shouldRender(vsync * (1000 / 120) + jitter)) {
    if (previous >= 0) gaps.set(vsync - previous, (gaps.get(vsync - previous) ?? 0) + 1);
    previous = vsync;
  }
}
assert.deepEqual([...gaps.keys()], [2], `120 Hz @ 60 gaps ${JSON.stringify([...gaps])}`);
// A 30 fps lock on 60 Hz is every other vsync; 'display' is every vsync.
const thirty = new AvsFrameGovernor(avsGovernorOptions({ ...DEFAULT_AVS_DISPLAY_SETTINGS, frameRate: '30' }, 'worker'));
thirty.setDisplayHz(60);
assert.equal(thirty.renderIntervalMs, 2000 / 60);
classic.setDisplayHz(60);
assert.equal(classic.renderIntervalMs, 1000 / 60);
classic.setDisplayHz(null);

const rate = new DisplayRateEstimator();
assert.equal(rate.hz, null);
for (let i = 0; i < 90; i++) rate.tick(i * (1000 / 144) + (i === 40 ? 30 : 0));
assert.ok(Math.abs(rate.hz! - 144) < 0.5, `estimated ${rate.hz}`);

// Dims debounce: a drag through many sizes adopts only the size that held for 250 ms.
const debounce = new AvsDimensionsDebouncer(250);
assert.deepEqual(debounce.current({ width: 640, height: 360 }, 0), { width: 640, height: 360 });
for (let t = 10; t < 400; t += 10) {
  assert.deepEqual(debounce.current({ width: 600 + t / 10, height: 340 }, t), { width: 640, height: 360 }, 'drag');
}
assert.deepEqual(debounce.current({ width: 620, height: 347 }, 400), { width: 640, height: 360 });
assert.deepEqual(debounce.current({ width: 620, height: 347 }, 649), { width: 640, height: 360 });
assert.deepEqual(debounce.current({ width: 620, height: 347 }, 650), { width: 620, height: 347 });
debounce.settle({ width: 320, height: 180 });
assert.deepEqual(debounce.current({ width: 320, height: 180 }, 651), { width: 320, height: 180 });

// Settings parse defensively and default to today's look.
assert.deepEqual(parseAvsDisplaySettings(null), DEFAULT_AVS_DISPLAY_SETTINGS);
assert.deepEqual(parseAvsDisplaySettings('{not json'), DEFAULT_AVS_DISPLAY_SETTINGS);
assert.deepEqual(parseAvsDisplaySettings('{"upscale":"sharp-bilinear","resolution":"nope","frameRate":"30"}'), {
  upscale: 'sharp-bilinear', resolution: 'classic', frameRate: '30',
});
// Default presentation is today's pixelated stretch; sharp-bilinear is opt-in.
assert.equal(DEFAULT_AVS_DISPLAY_SETTINGS.upscale, 'pixelated');
assert.equal(DEFAULT_AVS_DISPLAY_SETTINGS.resolution, 'classic');
assert.equal(DEFAULT_AVS_DISPLAY_SETTINGS.frameRate, 'display');
assert.equal(nextInCycle(AVS_UPSCALE_MODES, 'pixelated'), 'sharp-bilinear');
assert.equal(nextInCycle(AVS_UPSCALE_MODES, 'integer-letterbox'), 'pixelated');
assert.equal(frameRateLockFps('display'), 165);

// ---------------------------------------------------------------- latch + dispatch-on-idle
// The host-facing half of WP5, exercised through the real client with a fake
// port: frames are latched (a superseded bitmap is closed unseen), presented
// once from rAF, and every returning frame, stale or current, reports idle.
{
  const posted: AvsWorkerRequest[] = [];
  let onmessage: ((event: MessageEvent<AvsWorkerResponse>) => void) | null = null;
  const port = {
    get onmessage() { return onmessage; },
    set onmessage(handler) { onmessage = handler; },
    onerror: null,
    postMessage(message: AvsWorkerRequest) { posted.push(message); },
    terminate() {},
  };
  const emit = (message: AvsWorkerResponse) => onmessage?.({ data: message } as MessageEvent<AvsWorkerResponse>);
  let idle = 0;
  let unscaledDraws = 0;
  const client = new AvsWorkerRenderer({
    canvas: { width: 0, height: 0 } as HTMLCanvasElement,
    context: { drawImage() { unscaledDraws++; } } as unknown as CanvasRenderingContext2D,
    createWorker: () => port,
    latchFrames: true,
    onIdle() { idle++; },
  });
  const loading = client.load(new Uint8Array([1]), 640, 360);
  emit({ type: 'ready', generation: 1, unsupported: 0, preset: { version: 2, header: '', clearEveryFrame: false, components: [], byteLength: 1 } });
  await loading;
  const pcmAudio = { waveform: new Float32Array(4) } as AudioSnapshot;
  const closed: number[] = [];
  const frame = (id: number, generation = 1): AvsWorkerResponse => ({
    type: 'frame', generation, sequence: id, pcm: new ArrayBuffer(576 * 2 * 4),
    bitmap: { close() { closed.push(id); } } as ImageBitmap, width: 640, height: 360, unsupported: 0, renderMs: 17,
  });
  assert.equal(client.render(pcmAudio, 640, 360), true);
  emit(frame(1));
  assert.equal(idle, 1);
  assert.equal(client.busy, false, 'idle before the next rAF');
  assert.equal(client.render(pcmAudio, 640, 360), true);
  emit(frame(2));
  assert.deepEqual(closed, [1], 'superseded bitmap closed unseen');
  assert.equal(client.supersededFrames, 1);
  assert.equal(client.renderedFrames, 2);
  assert.equal(unscaledDraws, 0, 'nothing drawn off-vsync');
  const drawn: number[] = [];
  assert.equal(client.presentLatest((_bitmap, width, height) => { drawn.push(width, height); }), true);
  assert.deepEqual(drawn, [640, 360]);
  assert.deepEqual(closed, [1, 2]);
  assert.equal(client.presentLatest(), false, 'one present per completed frame');
  assert.equal(client.lastWidth, 640);
  emit(frame(3, 0));
  assert.equal(idle, 3, 'stale frames still free the worker');
  assert.deepEqual(closed, [1, 2, 3]);
  assert.equal(client.render(pcmAudio, 640, 360), true);
  emit(frame(4));
  client.clear();
  assert.deepEqual(closed, [1, 2, 3, 4], 'clear closes a latched frame');
  assert.equal(client.hasFrame, false);
  client.dispose();
}

console.log('avs-presentation-check: adaptive cadence, resolution, zero-allocation conversion, 17-panel scale table, governor floor and frame latch pass');
