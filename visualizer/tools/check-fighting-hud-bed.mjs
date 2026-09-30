import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/hud/fighting-hud-bed.ts'], bundle: true, format: 'esm', write: false });
const {
  FIGHTING_STYLES,
  FightingHudBed,
  evaluateFightingHud,
  renderFightingHud,
  extractFightingAudioSignals,
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

console.log('--- Testing Fighting Game HUD Animation Bed ---');

// 1. Verify Styles
assert.ok(Array.isArray(FIGHTING_STYLES), 'FIGHTING_STYLES must be an array');
assert.equal(FIGHTING_STYLES.length, 6, 'Must support 6 distinct fighting game styles');
for (const style of ['sf2', 'sfa3', 'kof98', 'garou', 'samsho', 'arcade']) {
  assert.ok(FIGHTING_STYLES.includes(style), `Missing expected style: ${style}`);
}

// 2. Audio Fixture Creation
function createAudioFixture() {
  const waveform = [new Uint8Array(576), new Uint8Array(576)];
  const spectrum = [new Uint8Array(576), new Uint8Array(576)];

  // Fill with simulated punchy kick & bass
  for (let i = 0; i < 576; i++) {
    waveform[0][i] = Math.round(Math.sin(i * 0.08) * 110) & 255;
    waveform[1][i] = Math.round(Math.cos(i * 0.08) * 110) & 255;
    spectrum[0][i] = i < 20 ? 220 : (i * 13 + 37) % 256;
    spectrum[1][i] = i < 20 ? 180 : (i * 17 + 43) % 256;
  }

  return { waveform, spectrum, beat: true, beatLevel: 210 };
}

const silence = {
  waveform: [new Uint8Array(576), new Uint8Array(576)],
  spectrum: [new Uint8Array(576), new Uint8Array(576)],
  beat: false,
  beatLevel: 0,
};

// 3. Test Signal Extraction
const fixtureAudio = createAudioFixture();
const signals = extractFightingAudioSignals(fixtureAudio, 5.0, 0.016);
assert.ok(signals.sub > 0.5, 'Sub-bass must detect fixture energy');
assert.ok(signals.low > 0.3, 'Low punch energy must be detected');
assert.ok(signals.transient > 0.6, 'Transient magnitude must be detected');
assert.ok(Number.isFinite(signals.pan), 'Pan must be finite');

// 4. Test Deterministic Evaluator (Seek Invariance & Monotonicity)
const frameA = {
  time: 30.0,
  localTime: 30.0,
  progress: 0.5,
  bpm: 130,
  seed: 9876,
  audio: fixtureAudio,
  style: 'sf2',
};

const stateA1 = evaluateFightingHud(frameA);
const stateA2 = evaluateFightingHud(frameA);
assert.deepEqual(stateA1, stateA2, 'evaluateFightingHud must be 100% deterministic (seek invariance)');

// Test timer exactness across progress:
const stateStart = evaluateFightingHud({ ...frameA, progress: 0.0 });
assert.equal(stateStart.timer, 99, 'Timer must start at 99 at progress 0');
assert.equal(stateStart.timerUrgent, false, 'Timer must not be urgent at start');
assert.equal(stateStart.phase, 'intro', 'Must be in intro phase at progress 0');

const stateUrgent = evaluateFightingHud({ ...frameA, progress: 0.92 });
assert.ok(stateUrgent.timer <= 10, 'Timer must be <= 10 at 92% progress');
assert.equal(stateUrgent.timerUrgent, true, 'Timer must be urgent at <= 10');

const stateEnd = evaluateFightingHud({ ...frameA, progress: 1.0 });
assert.equal(stateEnd.timer, 0, 'Timer must reach 0 exactly at progress 1.0');
assert.equal(stateEnd.phase, 'resolution', 'Must be in resolution phase at progress 1.0');
assert.ok(stateEnd.banner !== null, 'Banner must be active at resolution');

// 5. Test Stateful Interactive Engine (FightingHudBed)
const bed = new FightingHudBed('RYU', 'KEN', 99, 'sf2');
const initial = bed.getState();
assert.equal(initial.p1.health, 1.0, 'P1 health must start at 1.0');
assert.equal(initial.p1.ghostHealth, 1.0, 'P1 ghost health must start at 1.0');
assert.equal(initial.p2.health, 1.0, 'P2 health must start at 1.0');
assert.equal(initial.timer, 99, 'Round timer must start at 99');

// 5a. Test Life Bar Going Down on Hit Damage
bed.applyHit('p1', 0.25);
const afterHit = bed.getState();
assert.ok(Math.abs(afterHit.p1.health - 0.75) < 0.001, 'P1 health must decrease to 0.75');
assert.equal(afterHit.p1.ghostHealth, 1.0, 'Ghost health must hold at 1.0 immediately after hit');
assert.ok(afterHit.p1.ghostTimer > 0, 'Ghost timer must be active');
assert.equal(afterHit.p2.comboCount, 1, 'Attacker combo count must increment');

// 5b. Test Ghost Damage Trail Delay and Decay
// Tick 0.2s: ghost timer still holds
bed.update(silence, 0.2);
assert.equal(bed.getState().p1.ghostHealth, 1.0, 'Ghost health must hold during delay');

// Tick 0.6s: ghost timer expires and ghost begins decaying towards 0.75
bed.update(silence, 0.6);
const decayingGhost = bed.getState().p1.ghostHealth;
assert.ok(decayingGhost < 1.0, 'Ghost health must begin decaying after hold');
assert.ok(decayingGhost >= 0.75, 'Ghost health must not decay below active health');

// 5c. Test Life Bar Going Up (Healing / Restore)
bed.restoreHealth('p1', 0.15);
const restored = bed.getState();
assert.ok(Math.abs(restored.p1.health - 0.90) < 0.001, 'P1 health must increase up to 0.90');
assert.ok(restored.p1.ghostHealth >= restored.p1.health, 'Ghost health must track up with restored health');

// 5d. Test Round Reset (Smooth Life Bar Refill to 100%)
bed.resetRound(2);
const round2 = bed.getState();
assert.equal(round2.round, 2, 'Must advance to Round 2');
assert.equal(round2.p1.health, 1.0, 'P1 health must refill to 100% on round reset');
assert.equal(round2.p2.health, 1.0, 'P2 health must refill to 100% on round reset');
assert.equal(round2.timer, 99, 'Round timer must reset to 99');
assert.equal(round2.banner?.text, 'ROUND 2', 'Banner must announce Round 2');

// 5e. Test Super Bars Going Up and Down
const superBed = new FightingHudBed('KYO', 'IORI', 99, 'kof98');
assert.equal(superBed.getState().p1.superStock, 0, 'Super stock starts at 0');

// Super Bar Going Up: Charge via rhythm / hits
superBed.chargeSuper('p1', 0.5);
assert.ok(superBed.getState().p1.superGauge > 0.6, 'Super gauge must charge up');

// Charge to Level 1
superBed.chargeSuper('p1', 0.5);
assert.equal(superBed.getState().p1.superStock, 1, 'Super stock must reach Level 1');

// Charge to Level 3 / MAX
superBed.chargeSuper('p1', 2.0);
assert.equal(superBed.getState().p1.superStock, 3, 'Super stock must reach Level 3');
assert.equal(superBed.getState().p1.isMax, true, 'isMax must be true at full charge');

// Super Bar Going Down: Discharge on Super Move
superBed.dischargeSuper('p1');
const discharged = superBed.getState();
assert.equal(discharged.p1.isMax, false, 'isMax must clear after discharge');
assert.equal(discharged.p1.superStock, 0, 'Super stock must discharge down to 0');
assert.equal(discharged.p1.superGauge, 0, 'Super gauge must discharge down to 0');
assert.ok(discharged.p2.health < 1.0, 'Opponent must take heavy damage from super discharge');
assert.equal(discharged.banner?.type, 'super', 'Banner must announce Super Combo');

// 5f. Test HUD Text Banners & Combos
superBed.triggerBanner('combo', '12 HITS !', '45% DAMAGE', 1.0, 'p1');
assert.equal(superBed.getState().banner?.text, '12 HITS !', 'Combo banner must be active');

// 6. Test Canvas 2D Rendering Pipeline (Context Safety, No Leaks, Finite Geometry)
function recordingContext() {
  const operations = [];
  const stack = [];
  let state = {
    globalAlpha: 1.0,
    font: '10px sans-serif',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
  };
  const initial = { ...state };
  const methods = new Set([
    'save', 'restore', 'translate', 'scale', 'beginPath', 'moveTo', 'lineTo',
    'closePath', 'fill', 'stroke', 'fillRect', 'strokeRect', 'fillText',
    'strokeText', 'arc', 'rect', 'clip', 'measureText', 'createLinearGradient',
  ]);

  const mockGradient = { addColorStop: () => {} };

  const context = new Proxy({}, {
    set(_t, key, val) {
      if (typeof val === 'number') assert.ok(Number.isFinite(val), `Non-finite context set: ${String(key)}`);
      state[key] = val;
      operations.push(['set', key, val]);
      return true;
    },
    get(_t, key) {
      if (key === 'save') return () => { stack.push({ ...state }); operations.push(['save']); };
      if (key === 'restore') return () => {
        assert.ok(stack.length > 0, 'Unbalanced canvas restore call');
        state = stack.pop();
        operations.push(['restore']);
      };
      if (key === 'measureText') return (text) => ({ width: text.length * 8 });
      if (key === 'createLinearGradient') return (...args) => {
        for (const arg of args) assert.ok(Number.isFinite(arg), 'Non-finite gradient coordinate');
        operations.push(['createLinearGradient', ...args]);
        return mockGradient;
      };
      if (methods.has(key)) {
        return (...args) => {
          for (const arg of args) {
            if (typeof arg === 'number') assert.ok(Number.isFinite(arg), `Non-finite ${String(key)} argument`);
          }
          if (key === 'arc') assert.ok(args[2] >= 0, 'Arc radius must be non-negative');
          operations.push([key, ...args]);
        };
      }
      if (key in state) return state[key];
      throw new Error(`Unexpected context API access: ${String(key)}`);
    },
  });

  return {
    context,
    operations,
    verify: () => {
      assert.equal(stack.length, 0, 'Canvas drawing state stack leak (unbalanced save/restore)');
      assert.deepEqual(state, initial, 'Canvas drawing state must be restored to initial values');
    },
  };
}

// Render test for all 6 styles
const digest = (val) => createHash('sha256').update(JSON.stringify(val)).digest('hex');
const styleDigests = new Map();

for (const style of FIGHTING_STYLES) {
  const r = recordingContext();
  renderFightingHud(r.context, 640, 360, {
    time: 15.0,
    localTime: 15.0,
    progress: 0.35,
    bpm: 128,
    seed: 555,
    audio: fixtureAudio,
    style,
  });
  r.verify();

  assert.ok(r.operations.length > 80, `${style}: Incomplete render pipeline`);
  assert.ok(r.operations.some((op) => op[0] === 'fillText'), `${style}: Missing HUD text`);
  assert.ok(r.operations.some((op) => op[0] === 'fillRect'), `${style}: Missing life bar fills`);

  const d = digest(r.operations);
  styleDigests.set(style, d);
}

// Verify distinct style signatures
assert.equal(styleDigests.size, 6, 'All 6 styles must be recorded');
assert.equal(new Set(styleDigests.values()).size, 6, 'All 6 fighting styles must have distinct visual outputs');

// Verify seek invariance in rendering
const r1 = recordingContext();
renderFightingHud(r1.context, 640, 360, {
  time: 25.0,
  localTime: 25.0,
  progress: 0.6,
  bpm: 120,
  seed: 777,
  audio: fixtureAudio,
  style: 'sf2',
});
r1.verify();

const r2 = recordingContext();
renderFightingHud(r2.context, 640, 360, {
  time: 25.0,
  localTime: 25.0,
  progress: 0.6,
  bpm: 120,
  seed: 777,
  audio: fixtureAudio,
  style: 'sf2',
});
r2.verify();

assert.equal(digest(r1.operations), digest(r2.operations), 'Rendering must be 100% deterministic on seek/replay');

console.log('PASS: Fighting Game HUD Animation Bed verification passed (0-pixel delta, CPU-only, full feature suite).');
