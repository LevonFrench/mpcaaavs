// Flash limiter regression check (src/flash-limiter.ts). Synthetic sequences
// through the offline in-place path, with the OUTPUT judged by an analyser that
// shares no code with the limiter: if the limiter's own bookkeeping drifted,
// its self-reported rates would drift with it, so they are not the evidence.
import {
  FlashLimiter, computeFrameStatsPacked, computeFrameStatsRgba, createFrameStats, limitPackedFrame, limitRgbaFrame,
  parseFlashMode, type FlashMode,
} from '../src/flash-limiter.ts';
import { FlashGate, PROBE_H, PROBE_W } from '../src/flash-gate.ts';

let checks = 0;
const W = 640;
const H = 360;
const FPS = 60;

// -- independent analyser ---------------------------------------------------

function luminanceOf(p: number): number {
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch((p >>> 16) & 255) + 0.7152 * ch((p >>> 8) & 255) + 0.0722 * ch(p & 255);
}

/**
 * Max WCAG general-flash transitions in any 1 s (FPS-frame) window of a
 * scalar luminance series. Splits the series into monotonic moves between
 * turning points (0.1 hysteresis); a move counts once, on the frame it first
 * spans >= 0.1 with its darker end < 0.8.
 */
function maxTransitionsPerSecond(series: readonly number[]): number {
  const at: number[] = [];
  let from = series[0] ?? 0;   // where the current move started
  let cur = from;              // how far it has got
  let dir = 0;
  let counted = false;
  series.forEach((L, f) => {
    if (dir === 0) {
      if (Math.abs(L - from) < 0.1) return;
      dir = L > from ? 1 : -1;
      cur = L;
    } else if (dir > 0 ? L >= cur : L <= cur) {
      cur = L;
    } else if (Math.abs(L - cur) >= 0.1) {
      from = cur;
      cur = L;
      dir = -dir;
      counted = false;
    }
    if (!counted && Math.abs(cur - from) >= 0.1 && Math.min(cur, from) < 0.8) { at.push(f); counted = true; }
  });
  let best = 0;
  for (let i = 0, j = 0; i < at.length; i++) {
    while (at[i]! - at[j]! >= FPS) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

// -- sequence runner ----------------------------------------------------------

type Painter = (frame: Uint32Array, f: number) => void;

interface Run {
  /** Luminance of a probe pixel of each output frame. */
  probe: number[];
  blends: number[];
  flashRates: number[];
  redRates: number[];
  hash: number;
  changedBytes: boolean;
}

function run(mode: FlashMode, frames: number, paint: Painter, probeIndex = 0): Run {
  const limiter = new FlashLimiter(mode);
  const stats = createFrameStats();
  const frame = new Uint32Array(W * H);
  const source = new Uint32Array(W * H);
  const prev = new Uint32Array(W * H);
  const out: Run = { probe: [], blends: [], flashRates: [], redRates: [], hash: 0x811c9dc5, changedBytes: false };
  for (let f = 0; f < frames; f++) {
    paint(frame, f);
    source.set(frame);
    const d = limitPackedFrame(limiter, stats, frame, prev, W, H, f / FPS);
    out.probe.push(luminanceOf(frame[probeIndex]!));
    out.blends.push(d.blend);
    out.flashRates.push(d.flashRate);
    out.redRates.push(d.redFlashRate);
    for (let i = 0; i < frame.length; i += 97) {
      out.hash = Math.imul(out.hash ^ frame[i]!, 0x01000193) >>> 0;
      if (frame[i] !== source[i]) out.changedBytes = true;
    }
  }
  return out;
}

const BLACK = 0x000000;
const WHITE = 0xffffff;
const strobe = (hz: number, a: number, b: number): Painter => (frame, f) => {
  const half = FPS / hz / 2;
  frame.fill(Math.floor(f / half) % 2 === 0 ? a : b);
};

// 1. 10 Hz full-frame black/white strobe, 'limit': at most 3 flashes (6
//    transitions) in any second of OUTPUT.
const strobeOff = run('off', FPS * 5, strobe(10, BLACK, WHITE));
const strobeLimit = run('limit', FPS * 5, strobe(10, BLACK, WHITE));
const strobeStrict = run('strict', FPS * 5, strobe(10, BLACK, WHITE));
// Negative: the analyser sees the raw strobe as the ~20 transitions/s it is,
// so a pass below is not the analyser being blind.
atLeast(maxTransitionsPerSecond(strobeOff.probe), 18, 'unlimited 10 Hz strobe is detected by the analyser');
atLeast(Math.max(...strobeOff.flashRates), 8, 'limiter reports the unlimited strobe rate in off mode');
assert(strobeOff.blends.every((b) => b === 1), 'off mode never blends');
atMost(maxTransitionsPerSecond(strobeLimit.probe), 6, "'limit' output has <= 3 flashes in any second");
atMost(Math.max(...strobeLimit.flashRates), 3, "'limit' self-reported rate stays <= 3/s");
assert(Math.min(...strobeLimit.blends) < 1, "'limit' actually attenuated the strobe");
// And it does not simply freeze the screen: the flashes within budget pass.
atLeast(maxTransitionsPerSecond(strobeLimit.probe), 4, "'limit' still lets in-budget flashes through");
atMost(maxTransitionsPerSecond(strobeStrict.probe), 4, "'strict' output has <= 2 flashes in any second");
// Negative: this check fails when the limit is exceeded (the off run exceeds it).
assert(maxTransitionsPerSecond(strobeOff.probe) > 6, 'the <= 6 transitions bound is violated by the unlimited run');

// Same, at 15 Hz alternating frames at 30 fps-equivalent density (every 2 frames).
const fast = run('limit', FPS * 4, strobe(30, BLACK, WHITE));
atMost(maxTransitionsPerSecond(fast.probe), 6, "'limit' holds a 30 Hz frame-alternating strobe");

// A strobe that pauses just above the 0.80 ceiling on its way down (white,
// light grey, black) is still one transition per swing, and still limited.
{
  const light = Math.round(255 * (1.055 * 0.85 ** (1 / 2.4) - 0.055));
  const LIGHT = (light << 16) | (light << 8) | light;
  const stepped: Painter = (frame, f) => { frame.fill([WHITE, LIGHT, BLACK][Math.floor(f / 2) % 3]!); };
  atLeast(maxTransitionsPerSecond(run('off', FPS * 3, stepped).probe), 18, 'stepped strobe is detected by the analyser');
  atMost(maxTransitionsPerSecond(run('limit', FPS * 3, stepped).probe), 6, "'limit' holds a strobe that steps through the ceiling");
}

// The live GPU path cannot read back what it showed: `evaluate` records its
// prediction and the compositor blends with an 8-bit globalAlpha. Emulate that
// (alpha rounded to 1/255, channels rounded) and hold it to the same bound.
{
  const live = (paint: Painter): number[] => {
    const limiter = new FlashLimiter('limit');
    const stats = createFrameStats();
    const frame = new Uint32Array(W * H);
    const shown = new Uint32Array(W * H);
    const probe: number[] = [];
    for (let f = 0; f < FPS * 4; f++) {
      paint(frame, f);
      const d = limiter.evaluate(computeFrameStatsPacked(frame, W, H, stats), f / FPS);
      const a = f === 0 ? 1 : Math.round(d.blend * 255) / 255;
      for (let i = 0; i < shown.length; i++) {
        const p = shown[i]!, q = frame[i]!;
        const m = (s: number) => Math.round(((p >>> s) & 255) + ((((q >>> s) & 255) - ((p >>> s) & 255)) * a));
        shown[i] = (m(16) << 16) | (m(8) << 8) | m(0);
      }
      probe.push(luminanceOf(shown[0]!));
    }
    return probe;
  };
  atMost(maxTransitionsPerSecond(live(strobe(10, BLACK, WHITE))), 6, 'live (predicted-state) path holds a 10 Hz strobe');
  const light = Math.round(255 * (1.055 * 0.85 ** (1 / 2.4) - 0.055));
  const LIGHT = (light << 16) | (light << 8) | light;
  atMost(maxTransitionsPerSecond(live((frame, f) => { frame.fill([WHITE, LIGHT, BLACK][Math.floor(f / 2) % 3]!); })), 6,
    'live (predicted-state) path holds a stepped strobe');
}

// RGBA in-place helper matches the packed one byte for byte.
{
  const lp = new FlashLimiter('limit'), lr = new FlashLimiter('limit');
  const sp2 = createFrameStats(), sr2 = createFrameStats();
  const packed = new Uint32Array(W * H), prevP = new Uint32Array(W * H);
  const bytes = new Uint8ClampedArray(W * H * 4), prevR = new Uint8ClampedArray(W * H * 4);
  const paint = strobe(10, BLACK, 0xff8040);
  let same = true;
  for (let f = 0; f < FPS * 2; f++) {
    paint(packed, f);
    for (let i = 0; i < packed.length; i++) {
      const p = packed[i]!;
      bytes[i * 4] = (p >>> 16) & 255; bytes[i * 4 + 1] = (p >>> 8) & 255; bytes[i * 4 + 2] = p & 255; bytes[i * 4 + 3] = 255;
    }
    limitPackedFrame(lp, sp2, packed, prevP, W, H, f / FPS);
    limitRgbaFrame(lr, sr2, bytes, prevR, W, H, f / FPS);
    for (let i = 0; i < packed.length; i += 131) {
      const p = packed[i]!;
      if (bytes[i * 4] !== ((p >>> 16) & 255) || bytes[i * 4 + 1] !== ((p >>> 8) & 255) || bytes[i * 4 + 2] !== (p & 255)) same = false;
    }
  }
  assert(same, 'RGBA and packed in-place limiting produce the same bytes');
}

// 2. Slow fades pass through untouched: blend 1 and identical bytes.
const fade = run('limit', FPS * 6, (frame, f) => {
  const u = (f % (FPS * 2)) / (FPS * 2);
  const v = Math.round(255 * (u < 0.5 ? u * 2 : 2 - u * 2));
  frame.fill((v << 16) | (v << 8) | v);
});
assert(fade.blends.every((b) => b === 1), 'slow fade: blend stays 1 every frame');
assert(!fade.changedBytes, 'slow fade: output bytes equal input bytes');

// 3. Small-area flicker (under 25% of the frame) passes through untouched...
const area = (fraction: number, hz: number): Painter => {
  const cols = Math.round(W * fraction);
  const paint = strobe(hz, BLACK, WHITE);
  const one = new Uint32Array(1);
  return (frame, f) => {
    paint(one, f);
    frame.fill(0x404040);
    for (let y = 0; y < H; y++) frame.fill(one[0]!, y * W, y * W + cols);
  };
};
const small = run('limit', FPS * 4, area(0.18, 12));
atLeast(maxTransitionsPerSecond(small.probe), 18, 'small-area flicker is really flickering at the probe');
assert(small.blends.every((b) => b === 1), 'small-area flicker: blend stays 1');
assert(!small.changedBytes, 'small-area flicker: output bytes equal input bytes');
// ...while the same flicker over 40% of the frame is limited (negative for the area rule).
const large = run('limit', FPS * 4, area(0.4, 12));
assert(Math.min(...large.blends) < 1, 'large-area flicker is limited');
atMost(maxTransitionsPerSecond(large.probe), 6, 'large-area flicker output <= 3 flashes/s');
// 'strict' counts a smaller area: the 18% flicker is limited there.
const smallStrict = run('strict', FPS * 4, area(0.18, 12));
assert(Math.min(...smallStrict.blends) < 1, "'strict' limits flicker over 18% of the frame");

// 4. Red flash: saturated red against a grey of the same luminance, so only
//    the red-flash rule can see it.
const greyByte = Math.round(255 * (1.055 * 0.2126 ** (1 / 2.4) - 0.055));
const GREY = (greyByte << 16) | (greyByte << 8) | greyByte;
const RED = 0xff0000;
near(luminanceOf(GREY), luminanceOf(RED), 0.01, 'red and grey fixtures are luminance-matched');
const redOff = run('off', FPS * 4, strobe(10, RED, GREY));
atMost(maxTransitionsPerSecond(redOff.probe), 0, 'red/grey strobe has no general-flash transitions');
atLeast(Math.max(...redOff.redRates), 8, 'red flash detected at ~10/s');
atMost(Math.max(...redOff.flashRates), 0, 'red/grey strobe is not reported as a general flash');
const redLimit = run('limit', FPS * 4, strobe(10, RED, GREY));
assert(Math.min(...redLimit.blends) < 1, 'red flash is limited');
atMost(Math.max(...redLimit.redRates), 3, "'limit' holds red flashes to <= 3/s");
// Negative control: grey against a slightly different grey is not a red flash.
const greyOff = run('off', FPS * 2, strobe(10, GREY, 0x7a7a7a));
atMost(Math.max(...greyOff.redRates), 0, 'grey/grey strobe is not a red flash');

// 5. Offline determinism: same input, same bytes; different input, different bytes.
const again = run('limit', FPS * 5, strobe(10, BLACK, WHITE));
assert(again.hash === strobeLimit.hash, `offline limiter is deterministic (${again.hash} vs ${strobeLimit.hash})`);
const other = run('limit', FPS * 5, strobe(10, BLACK, 0xfefefe));
assert(other.hash !== strobeLimit.hash, 'hash distinguishes different input (determinism check can fail)');

// 6. Packed and RGBA stats agree on the same image.
const noise = new Uint32Array(W * H);
const rgba = new Uint8ClampedArray(W * H * 4);
let seed = 12345;
for (let i = 0; i < noise.length; i++) {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  const p = seed >>> 8;
  noise[i] = p;
  rgba[i * 4] = (p >>> 16) & 255; rgba[i * 4 + 1] = (p >>> 8) & 255; rgba[i * 4 + 2] = p & 255; rgba[i * 4 + 3] = 255;
}
const sp = computeFrameStatsPacked(noise, W, H, createFrameStats());
const sr = computeFrameStatsRgba(rgba, W, H, createFrameStats());
assert(sp.lum.every((v, i) => v === sr.lum[i]) && sp.red.every((v, i) => v === sr.red[i]), 'packed and RGBA stats agree');
near(computeFrameStatsPacked(new Uint32Array(W * H).fill(WHITE), W, H, createFrameStats()).lum[0]!, 1, 1e-3, 'white cell luminance is 1');

// 7. Modes and parsing.
assert(parseFlashMode('strict') === 'strict' && parseFlashMode('off') === 'off', 'known modes parse');
assert(parseFlashMode('bogus') === 'limit' && parseFlashMode(undefined) === 'limit', 'unknown modes fall back to limit');
// Offline export is opt-in: a job with no field must parse to 'off', never 'limit'.
assert(parseFlashMode(undefined, 'off') === 'off' && parseFlashMode('strict', 'off') === 'strict', 'offline fallback is off');

// 8. Switching on mid-strobe limits at once: the off-mode history counts.
{
  const limiter = new FlashLimiter('off');
  const stats = createFrameStats();
  const frame = new Uint32Array(W * H);
  const prev = new Uint32Array(W * H);
  const paint = strobe(10, BLACK, WHITE);
  const probe: number[] = [];
  for (let f = 0; f < FPS * 3; f++) {
    if (f === FPS * 2) limiter.setMode('limit');
    paint(frame, f);
    limitPackedFrame(limiter, stats, frame, prev, W, H, f / FPS);
    if (f >= FPS * 2) probe.push(luminanceOf(frame[0]!));
  }
  // The last second of off-mode output already spent the budget, so the first
  // half-second after the switch must hold completely.
  atMost(maxTransitionsPerSecond(probe.slice(0, FPS / 2)), 0, 'turning the limiter on mid-strobe limits immediately');
  atMost(maxTransitionsPerSecond(probe), 6, 'after the switch the output stays <= 3 flashes/s');
}

// 9. The live presenter gate (src/flash-gate.ts), with a fake probe and a fake
//    2D context: the draw runs under the limiter's globalAlpha, the alpha is
//    always restored, and the composited output holds the same bound.
{
  const probe = new Uint8ClampedArray(PROBE_W * PROBE_H * 4);
  let sampled = 0;
  const sampler = (): Uint8ClampedArray => { sampled++; return probe; };
  const fill = (v: number): void => { probe.fill(v); };
  const ctx = { globalAlpha: 1, canvas: { width: 640, height: 360 } };
  const gate = new FlashGate('limit', sampler);
  let shown = 0;
  const series: number[] = [];
  let alphaSeen = 1;
  for (let f = 0; f < FPS * 4; f++) {
    const v = Math.floor(f / 3) % 2 === 0 ? 0 : 255;
    fill(v);
    gate.present(ctx, probe as unknown as CanvasImageSource, f / FPS, () => {
      alphaSeen = ctx.globalAlpha;
      // What a 2D canvas does with drawImage under globalAlpha: 8-bit alpha, 8-bit channels.
      shown = Math.round(shown + (v - shown) * (Math.round(alphaSeen * 255) / 255));
    });
    series.push(luminanceOf((shown << 16) | (shown << 8) | shown));
  }
  atMost(maxTransitionsPerSecond(series), 6, 'presenter gate holds a 10 Hz strobe');
  assert(ctx.globalAlpha === 1, 'presenter gate restores globalAlpha');
  let threw = false;
  try { gate.present(ctx, probe as unknown as CanvasImageSource, 10, () => { throw new Error('draw failed'); }); } catch { threw = true; }
  assert(threw && ctx.globalAlpha === 1, 'presenter gate restores globalAlpha when the draw throws');

  // Off: no probe readback at all, and the frame is drawn whole.
  const before = sampled;
  gate.setMode('off');
  const off = gate.present(ctx, probe as unknown as CanvasImageSource, 11, () => { alphaSeen = ctx.globalAlpha; });
  assert(sampled === before && off.blend === 1 && alphaSeen === 1, "presenter gate in 'off' skips the probe");

  // An unreadable probe holds the last frame and reports itself unavailable.
  const blind = new FlashGate('limit', () => null);
  const d = blind.present(ctx, probe as unknown as CanvasImageSource, 0, () => { throw new Error('unmeasured draw'); });
  assert(d.blend === 0 && !blind.available, 'unreadable probe: hold, available = false');

  // A resize inside the draw clears the canvas: the limiter restarts (next frame whole).
  const sized = { globalAlpha: 1, canvas: { width: 640, height: 360 } };
  const g2 = new FlashGate('limit', sampler);
  for (let f = 0; f < FPS; f++) {
    fill(Math.floor(f / 3) % 2 === 0 ? 0 : 255);
    g2.present(sized, probe as unknown as CanvasImageSource, f / FPS, () => undefined);
  }
  fill(0);
  const held = g2.present(sized, probe as unknown as CanvasImageSource, 1, () => undefined).blend;
  assert(held < 1, 'strobed gate is limiting before the resize (resize check can fail)');
  g2.present(sized, probe as unknown as CanvasImageSource, 1 + 1 / FPS, () => { sized.canvas.width = 1280; });
  fill(255);
  equal(g2.present(sized, probe as unknown as CanvasImageSource, 1 + 2 / FPS, () => undefined).blend, 1, 'after a resize the gate starts fresh');
}

// 10. Cost. Target < 0.3 ms at 640x360; the gate is loose because CI machines vary.
{
  const stats = createFrameStats();
  const times: number[] = [];
  for (let i = 0; i < 300; i++) {
    const t0 = performance.now();
    computeFrameStatsPacked(noise, W, H, stats);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const median = times[times.length >> 1]!;
  console.log(`flash-limiter-check: computeFrameStatsPacked 640x360 median ${median.toFixed(3)} ms (target < 0.3)`);
  atMost(median, 2, 'frame stats cost stays in budget');
}

console.log(`flash-limiter-check: PASS (${checks} assertions)`);

function assert(condition: boolean, label: string): void {
  checks++;
  if (!condition) throw new Error(`flash-limiter-check: FAIL ${label}`);
}
function atMost(actual: number, limit: number, label: string): void { assert(actual <= limit, `${label}: got ${actual}, limit ${limit}`); }
function atLeast(actual: number, floor: number, label: string): void { assert(actual >= floor, `${label}: got ${actual}, floor ${floor}`); }
function equal(actual: number, expected: number, label: string): void { assert(actual === expected, `${label}: got ${actual}, expected ${expected}`); }
function near(actual: number, expected: number, tolerance: number, label: string): void {
  assert(Math.abs(actual - expected) <= tolerance, `${label}: got ${actual}, expected ${expected} +/- ${tolerance}`);
}
