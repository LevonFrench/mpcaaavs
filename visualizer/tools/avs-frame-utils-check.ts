import assert from 'node:assert/strict';
import {
  AVS_PCM_SAMPLES,
  avsPcmSourceIndex,
  blendPackedRgb,
  blendPackedRgbLinearLight,
  crossfadeAlpha256,
  fillAvsPcm,
  fillAvsPcmPlanar,
} from '../src/avs/frame-utils.ts';
import { fillAvsPcm as liveFillAvsPcm } from '../src/avs-worker-client.ts';

// Golden vectors for the shared live/offline AVS frame helpers
// (src/avs/frame-utils.ts). The live worker client's fillAvsPcm rounding is
// authoritative; the offline lane must produce the same window.

assert.equal(AVS_PCM_SAMPLES, 576);
assert.equal(liveFillAvsPcm, fillAvsPcm, 'the live client re-exports the shared fillAvsPcm');

// --- PCM window: the historical live golden (4 interleaved samples).
{
  const pcm = new Float32Array(1152);
  fillAvsPcm(new Float32Array([1, -1, 0.5, -0.5]), pcm);
  assert.equal(pcm[0], 1);
  assert.equal(pcm[287], 1);
  assert.equal(pcm[288], 0.5);
  assert.equal(pcm[575], 0.5);
  assert.equal(pcm[576], -1);
  assert.equal(pcm[1151], -0.5);
  assert.throws(() => fillAvsPcm(new Float32Array(4), new Float32Array(2)), /1152 samples/);
}

// --- PCM window: one 24 fps frame at 48 kHz (2000 samples), value = index.
{
  const frames = 2000;
  const waveform = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) { waveform[i * 2] = i; waveform[i * 2 + 1] = -i; }
  const pcm = new Float32Array(1152);
  fillAvsPcm(waveform, pcm);
  const golden: [number, number][] = [[0, 0], [1, 3], [2, 6], [3, 10], [100, 347], [288, 1000], [575, 1996]];
  for (const [i, source] of golden) {
    assert.equal(avsPcmSourceIndex(i, frames), source, `source index ${i}`);
    assert.equal(pcm[i], source, `left[${i}]`);
    assert.equal(pcm[576 + i], -source, `right[${i}]`);
  }
  // Negative: the convention truncates. Round-to-nearest would pick 7 for
  // i=2 (2*2000/576 = 6.94) and 1998 at i=575; neither may appear.
  assert.notEqual(pcm[2], 7, 'fillAvsPcm must truncate, not round to nearest');
  assert.notEqual(pcm[575], Math.round(575 * frames / 576));
}

// --- Odd waveform: a missing right sample repeats left; empty is silence.
{
  const pcm = new Float32Array(1152);
  fillAvsPcm(new Float32Array([0.25]), pcm);
  assert.equal(pcm[0], 0.25);
  assert.equal(pcm[576], 0.25, 'missing right sample falls back to left');
  fillAvsPcm(new Float32Array(0), pcm);
  assert.ok(pcm.every((value) => value === 0), 'empty waveform is silence');
}

// --- Planar/offline window equals fillAvsPcm over the interleaved interval,
// and equals the offline lane's former formula on every nonempty interval
// (so adopting the live convention changed no offline byte).
function legacyOfflineFill(
  left: Float32Array, right: Float32Array, sampleStart: number, sampleEnd: number,
  pcmLeft: Float32Array, pcmRight: Float32Array,
): void {
  const available = Math.max(1, sampleEnd - sampleStart);
  for (let i = 0; i < 576; i++) {
    const source = Math.min(sampleEnd - 1, sampleStart + Math.trunc(i * available / 576));
    pcmLeft[i] = source >= 0 ? left[source] ?? 0 : 0;
    pcmRight[i] = source >= 0 ? right[source] ?? pcmLeft[i]! : 0;
  }
}
{
  const total = 48_000 * 3;
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  let lcg = 0x1234567;
  for (let i = 0; i < total; i++) {
    lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
    left[i] = (lcg / 0xffffffff) * 2 - 1;
    right[i] = Math.sin(i * 0.013);
  }
  const planarL = new Float32Array(576);
  const planarR = new Float32Array(576);
  const legacyL = new Float32Array(576);
  const legacyR = new Float32Array(576);
  const pcm = new Float32Array(1152);
  // Every real offline frame rate's interval length, plus awkward lengths.
  const lengths = [1, 2, 3, 100, 400, 575, 576, 577, 800, 1000, 1152, 1600, 2000, 2002, 4000];
  let intervals = 0;
  for (const length of lengths) {
    for (let start = 0; start + length <= total; start += 7919) {
      const end = start + length;
      fillAvsPcmPlanar(left, right, start, end, planarL, planarR);
      legacyOfflineFill(left, right, start, end, legacyL, legacyR);
      const interleaved = new Float32Array(length * 2);
      for (let i = 0; i < length; i++) { interleaved[i * 2] = left[start + i]!; interleaved[i * 2 + 1] = right[start + i]!; }
      fillAvsPcm(interleaved, pcm);
      for (let i = 0; i < 576; i++) {
        if (planarL[i] !== pcm[i] || planarR[i] !== pcm[576 + i]) throw new Error(`planar != live at [${start},${end}) i=${i}`);
        if (planarL[i] !== legacyL[i] || planarR[i] !== legacyR[i]) throw new Error(`planar != legacy offline at [${start},${end}) i=${i}`);
      }
      intervals++;
    }
  }
  assert.ok(intervals > 250, `exercised ${intervals} intervals`);
  // A short right channel falls back to left, as live does.
  fillAvsPcmPlanar(left, new Float32Array(0), 10, 20, planarL, planarR);
  assert.equal(planarR[0], left[10]);
  // Empty interval: silence (live's empty-waveform rule). The legacy formula
  // read the previous sample here; offline intervals are never empty, so this
  // difference is unreachable from a render.
  fillAvsPcmPlanar(left, right, 50, 50, planarL, planarR);
  assert.ok(planarL.every((v) => v === 0) && planarR.every((v) => v === 0));
  assert.throws(() => fillAvsPcmPlanar(left, right, 0, 10, new Float32Array(10), planarR), /576 samples/);
}

// --- Packed-RGB crossfade (offline 'srgb-integer').
{
  const out = new Uint32Array(1);
  const blend = (from: number, to: number, mix: number): number => {
    blendPackedRgb(new Uint32Array([from]), new Uint32Array([to]), mix, out);
    return out[0]!;
  };
  assert.equal(crossfadeAlpha256(0.5), 128);
  assert.equal(crossfadeAlpha256(-1), 0);
  assert.equal(crossfadeAlpha256(2), 256);
  assert.equal(blend(0x102030, 0xf0e0d0, 0), 0x102030, 'mix 0 is the outgoing frame');
  assert.equal(blend(0x102030, 0xf0e0d0, 1), 0xf0e0d0, 'mix 1 is the incoming frame');
  assert.equal(blend(0x102030, 0xf0e0d0, 0.5), 0x808080);
  assert.equal(blend(0x102030, 0xf0e0d0, 0.25), 0x485058);
  // Negative: the integer mix truncates (255*128 >> 8 = 127), it does not round up.
  assert.equal(blend(0x000000, 0x0000ff, 0.5), 0x00007f);
  assert.notEqual(blend(0x000000, 0x0000ff, 0.5), 0x000080);
  // Alpha is quantised to 1/256: mixes inside one step blend identically.
  assert.equal(blend(0x000000, 0xffffff, 0.5), blend(0x000000, 0xffffff, 0.5 + 0.001));
}

// --- Linear-light crossfade (offline opt-in).
{
  const from = new Uint32Array(256);
  const to = new Uint32Array(256);
  for (let code = 0; code < 256; code++) { from[code] = code * 0x010101; to[code] = (255 - code) * 0x010101; }
  const out = new Uint32Array(256);
  blendPackedRgbLinearLight(from, to, 0, out);
  assert.deepEqual([...out], [...from], 'linear-light mix 0 round-trips every 8-bit code');
  blendPackedRgbLinearLight(from, to, 1, out);
  assert.deepEqual([...out], [...to], 'linear-light mix 1 round-trips every 8-bit code');
  const one = new Uint32Array(1);
  blendPackedRgbLinearLight(new Uint32Array([0]), new Uint32Array([0xffffff]), 0.5, one);
  assert.equal(one[0], 0xbcbcbc, 'half black/white in linear light encodes to sRGB 188');
  blendPackedRgb(new Uint32Array([0]), new Uint32Array([0xffffff]), 0.5, one);
  assert.equal(one[0], 0x7f7f7f, 'the integer sRGB mix of the same pair is 127');
}

console.log('avs frame utils: PCM window golden vectors, live/offline window equivalence and crossfade blends passed');
