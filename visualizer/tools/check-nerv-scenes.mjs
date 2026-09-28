import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/nerv-scenes.ts'], bundle: true, format: 'esm', write: false });
const { NERV_SCENES, renderNervScene } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

// Record actual path coordinates, text and styling without a browser, a canvas
// implementation, or GPU. Invalid geometry and leaked drawing state fail here.
function recordingContext() {
  const operations = [], stack = [];
  let state = { globalAlpha: .45, globalCompositeOperation: 'multiply', font: '11px serif', fillStyle: '#abc', strokeStyle: '#def', lineWidth: 3, shadowBlur: 7 };
  const initial = { ...state };
  const methods = new Set(['setTransform', 'translate', 'scale', 'setLineDash', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'fill', 'stroke', 'fillRect', 'strokeRect', 'fillText', 'arc', 'rect', 'clip']);
  const context = new Proxy({}, {
    set(_target, key, value) {
      if (typeof value === 'number') assert.ok(Number.isFinite(value), `nonfinite ${String(key)}`);
      state[key] = value; operations.push(['set', key, value]); return true;
    },
    get(_target, key) {
      if (key === 'save') return () => { stack.push({ ...state }); operations.push(['save']); };
      if (key === 'restore') return () => { assert.ok(stack.length, 'unbalanced restore'); state = stack.pop(); operations.push(['restore']); };
      if (methods.has(key)) return (...args) => {
        for (const value of args.flat()) if (typeof value === 'number') assert.ok(Number.isFinite(value), `nonfinite ${String(key)} argument`);
        if (key === 'arc') assert.ok(args[2] >= 0, 'negative arc radius');
        operations.push([key, ...args]);
      };
      if (key in state) return state[key];
      throw new Error(`Unexpected context API: ${String(key)}`);
    },
  });
  return { context, operations, verify: () => { assert.equal(stack.length, 0, 'drawing state stack leak'); assert.deepEqual(state, initial, 'caller context must be restored'); } };
}
function audio() { return { waveform: [new Uint8Array(576), new Uint8Array(576)], spectrum: [new Uint8Array(576), new Uint8Array(576)], beat: false, beatLevel: 0 }; }
const silence = audio();
const fixture = audio();
for (let i = 0; i < 576; i++) {
  fixture.waveform[0][i] = Math.round(Math.sin(i * .059) * 110) & 255;
  fixture.waveform[1][i] = Math.round(Math.cos(i * .043) * 89) & 255;
  fixture.spectrum[0][i] = (i * 19 + 61) % 256;
  fixture.spectrum[1][i] = (i * 11 + 29) % 256;
}
const frame = { time: 147.125, localTime: 7.125, progress: .43, bpm: 109, seed: 741, audio: fixture };
function recording(scene, input = fixture, changes = {}) {
  const r = recordingContext();
  renderNervScene(r.context, 640, 360, { ...frame, scene, audio: input, ...changes });
  r.verify();
  return r.operations;
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reference = new Map(NERV_SCENES.map(scene => [scene, digest(recording(scene))]));
assert.equal(reference.size, 16); assert.equal(new Set(reference.values()).size, 16, 'plates must have distinct compositions');
for (const scene of [...NERV_SCENES].reverse()) {
  recording(scene, fixture, { time: 4000, localTime: 290, seed: 883 });
  recording(scene, fixture, { time: 0, localTime: 0, progress: 0 });
  const repeated = recording(scene);
  assert.equal(digest(repeated), reference.get(scene), `${scene}: render result depends on prior playback/seek order`);
  assert.ok(repeated.length > 400, `${scene}: incomplete instrument`);
  assert.ok(repeated.some(op => op[0] === 'fillText'), `${scene}: missing HUD text`);
  assert.notEqual(digest(recording(scene, silence)), reference.get(scene), `${scene}: disconnected audio`);
  for (const [label, bin] of [['low', 3], ['mid', 48], ['high', 400], ['nyquist-edge', 511], ['AVS-tail', 575]]) {
    const signal = audio(); signal.spectrum[1][bin] = 255;
    assert.notEqual(digest(recording(scene, signal)), digest(recording(scene, silence)), `${scene}: right-channel ${label} input disconnected`);
  }
  recording(scene, fixture, { time: Number.NaN, localTime: Infinity, progress: -2, bpm: 0, seed: Number.NaN });
  const small = recordingContext(); renderNervScene(small.context, 240, 540, { ...frame, scene }); small.verify();
}

// Verify canonical signed-byte waveform semantics, including the two extrema.
const signed = audio(); signed.waveform[0][0] = 128; signed.waveform[0][2] = 127;
const psychograph = recording('psycho', signed);
assert.ok(psychograph.some(op => op[0] === 'moveTo' && op[1] === 127 && Math.abs(op[2] - (125 + 31 + 27.9)) < 1e-8), 'signed PCM -128 must draw below the centreline');
assert.ok(psychograph.some(op => op[0] === 'lineTo' && Math.abs(op[1] - (127 + 559 / 287)) < 1e-8 && op[2] < 156), 'signed PCM +127 must draw above the centreline');
console.log('NERV scenes: 16 distinct instruments, repeat/seek determinism, full stereo spectrum, signed PCM, finite geometry and context isolation PASS (CPU-only)');
