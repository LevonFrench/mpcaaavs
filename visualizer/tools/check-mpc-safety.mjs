import { build } from 'esbuild';
import assert from 'node:assert/strict';
async function load(path) {
  const r = await build({ entryPoints: [path], bundle: true, format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);
}
const { constructOwned } = await load('src/owned-resources.ts');
for (let failed = 0; failed < 4; failed++) {
  const destroyed = [], error = new Error('factory failed');
  const factories = Array.from({ length: 4 }, (_, i) => () => {
    if (i === failed) throw error;
    return { destroy() { destroyed.push(i); if (i === 1) throw new Error('cleanup failed'); } };
  });
  assert.throws(() => constructOwned(factories), value => value === error);
  assert.deepEqual(destroyed, Array.from({ length: failed }, (_, i) => failed - i - 1));
}
let releases = 0;
const owned = constructOwned([() => ({ destroy() { releases++; } }), () => ({})]);
assert.equal(releases, 0); assert.equal(owned.length, 2);
owned[0].destroy(); assert.equal(releases, 1);
const { FlashGate, PROBE_W, PROBE_H } = await load('src/flash-gate.ts');
const pixels = new Uint8ClampedArray(PROBE_W * PROBE_H * 4);
let sample = pixels, draws = 0;
const sampler = () => { if (sample instanceof Error) throw sample; return sample; };
const gated = new FlashGate('limit', sampler), control = new FlashGate('limit', () => pixels);
const ctx = { globalAlpha: 1, canvas: { width: 640, height: 360 } };
const source = {};
for (let i = 0; i < 30; i++) {
  pixels.fill(Math.floor(i / 3) % 2 ? 255 : 0);
  gated.present(ctx, source, i / 60, () => {});
  control.present(ctx, source, i / 60, () => {});
}
for (const unavailable of [null, new Uint8ClampedArray(3), new Error('probe failed')]) {
  sample = unavailable;
  const result = gated.present(ctx, source, .5, () => draws++);
  assert.equal(result.blend, 0); assert.equal(result.limited, true);
  assert.equal(gated.available, false); assert.equal(ctx.globalAlpha, 1);
}
assert.equal(draws, 0);
sample = pixels; pixels.fill(255);
const recovered = gated.present(ctx, source, .51, () => draws++);
const expected = control.present(ctx, source, .51, () => {});
assert.deepEqual(recovered, expected, 'unavailable frames must preserve retained-display history');
assert.equal(gated.available, true); assert.equal(draws, 1);
gated.setMode('strict'); sample = null;
assert.equal(gated.present(ctx, source, .52, () => draws++).mode, 'strict');
gated.setMode('off');
assert.equal(gated.present(ctx, source, .53, () => draws++).blend, 1);
assert.equal(draws, 2, 'explicit off mode still draws');
console.log('CPU safety: transactional resource rollback, retained flash history, unreadable probe hold/recovery PASS');
