// aaavs — the integration point.
//
// As of this session there is no hard-coded render chain. The frame is:
//
//   audio -> snapshot -> timeline -> LayerStack.frame(beats) -> StackPlan
//         -> Renderer.execute(plan)  -> present
//
// and every visual decision in it comes from `DEFAULT_PRESET` (or the preset in
// the URL hash) by way of `layers.ts`. The old slice —
// `compute(lorenz) -> fade -> points -> kaleido` — is now four LAYERS, not four
// blocks of code: `lorenz` and `spectrum` as sources, `feedback` in place of the
// hand-written fade, and `kaleidoscope` as an operator. Adding a source to the
// show is now an entry in a preset, and adding a new KIND of source is a
// descriptor in `src/sources/` plus its line in that directory's registry.
//
// What this file still owns, and should:
//
//   - the audio engine, the worklet detector and which of the two feeds tempo
//   - the timeline/scheduler pair and the transport reset (§4.10)
//   - the audio->GPU upload, the GPU timer, the debug overlay, the golden harness
//   - `present`, because the tone map, bloom and grain belong to one pass that
//     owns display space and `renderer.ts` deliberately stops before it
//   - the default preset, because a contract that carries data grows opinions
//
// The audio clock (§4.6) is the only musical time source. `performance.now`
// is used for frame timing and AVS cost measurement; neither feeds a musical
// decision.

import { initGpu, createSampler, createFullscreenPipeline, resize, GpuInitError, type Gpu } from './gpu.ts';
import { AudioEngine } from './audio.ts';
import { TempoTracker, SLOTS_PER_BEAT, resolveTempoBpm } from './clock.ts';
import { StaticTimeline, TierBTimeline, Scheduler, type ScheduleRequest } from './timeline.ts';
import { WorkletDetector, ringAvailable } from './worklet-host.ts';
import { AudioGpu } from './audiogpu.ts';
import { LayerStack, type StackPlan } from './layers.ts';
import { presetFromLocation } from './preset.ts';
import { PresetDirector, Transition, needsBothChains, type TransitionSpec } from './director.ts';
import { PRESET_BANK } from './presets/index.ts';
import { GpuTimer } from './gputimer.ts';
import { DebugOverlay } from './debug.ts';
import { GoldenHarness, goldenConfig, goldenFail } from './testkit.ts';
import { Renderer, type FrameState, type PooledTarget } from './renderer.ts';
import { SOURCE_PASSES } from './sources/index.ts';
import { OPERATOR_PASSES } from './ops/index.ts';
import { LayerUI, type TransportReadout } from './ui.ts';
import { createInputBus } from './input/index.ts';
import { createSequencer, type Sequencer } from './sequencer/index.ts';
import {
  ParamRegistry, avsFieldParams, globalParamEntries,
  REST_PARAM_ID, type ParamEntry, type ParamHost, type ParamUnregister,
} from './params/index.ts';
import {
  Link, createLinkAudioFrame, packLinkAudioFrame,
  type LinkFrameState, type LinkMessage,
} from './link.ts';
import { Rng } from './rng.ts';
import { AvsEditor, type AvsEditorNodeState } from './avs-editor.ts';
import {
  AvsCompatibilityRuntime,
  createAvsEditorModel,
  createAvsCompatibilityRegistry,
  parseAvsPreset,
  patchAvsEditorNodeFields,
  patchAvsEditorNodePayload,
  serializeAvsEditorModel,
  findAvsEditorNode,
  reorderAvsEditorChildren,
  setAvsEditorNodeEnabled,
  type AvsComponent,
  type AvsComponentControl,
  type AvsEditorFieldPatch,
  type AvsEditorModel,
  type AvsEditorNode as AvsEditorDecodedNode,
  type AvsPresetAst,
} from './avs/index.ts';
import { loadBundledAvsBitmapResolver } from './avs/bundled-bitmaps.ts';
import {
  AVS_PRESET_SOURCES, PERSONAL_AVS_BANK,
  type AvsPresetEntry,
} from './avs/preset-sources.ts';
import {
  AvsLiveDirector,
  AvsLiveLoadGuard,
  resolveAvsLiveBarPosition,
  type AvsLiveDirectorPreset,
} from './avs/live-director.ts';
import {
  AVS_DISPLAY_SETTINGS_KEY, AVS_FRAME_RATE_LOCKS, AVS_QUALITY_TIERS, AVS_RESOLUTION_MODES, AVS_UPSCALE_MODES,
  AvsDimensionsDebouncer, AvsFrameGovernor, DisplayRateEstimator, avsGovernorOptions, copyAvsPixelsToRgba,
  nextInCycle, parseAvsDisplaySettings, type AvsDisplaySettings,
} from './avs-presentation.ts';
import { AvsCanvasPresenter, AvsWorkerRenderer, currentAvsViewport } from './avs-worker-client.ts';
import { createBrowserOfflineStudio } from './offline-browser.ts';
import {
  ShowEditTracker, loadShowStack, patchLayerParams, wirePreset,
} from './show-state.ts';
import { isTextEntry } from './keyboard-guard.ts';
import { FlashGate } from './flash-gate.ts';
import {
  FLASH_MODES, FlashLimiter, createFrameStats, limitRgbaFrame, parseFlashMode,
  type FlashDecision, type FlashMode,
} from './flash-limiter.ts';
import { FrameRecorder, createFrameReadout } from './frame-recorder.ts';
import type { AvsFrameGraphLane } from './avs/gpu-frame-graph.ts';
import type { AudioSnapshot, ParamValue, Preset, Timeline } from './contracts.ts';

import presentWGSL from './shaders/present.wgsl';

const $ = (id: string) => document.getElementById(id)!;
const canvas = $('stage') as HTMLCanvasElement;
const avsCanvas = document.createElement('canvas');
avsCanvas.id = 'avs-stage';
avsCanvas.setAttribute('aria-label', 'Imported Winamp AVS preset');
avsCanvas.style.cssText = 'display:none;position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;image-rendering:pixelated';
canvas.insertAdjacentElement('afterend', avsCanvas);
// Not `desynchronized`: frames are presented from rAF, and a CSS-scaled,
// sometimes-dimmed canvas gains no latency from the front-buffer path anyway.
const avsContext = avsCanvas.getContext('2d', { alpha: false });
const avsPresenter = avsContext ? new AvsCanvasPresenter(avsCanvas, avsContext) : null;
const hud = $('hud');
const err = $('err');

/** Display-space post parameters. The only visual state left outside the preset. */
const post = {
  bloom: 0.28,
  exposure: 1.0,
  vignette: 0.7,
  grain: 0.35,
};

// The one list of live parameters. Declared here, at the top, because the AVS
// lane publishes into it while a preset loads and that can happen before the
// live-input block further down has run. What goes IN it is registered there.
const paramRegistry = new ParamRegistry();

const stats = {
  scheduledEvents: 0,
  lateBy: 0,
};

/**
 * The projector link, or null in golden mode and where BroadcastChannel is not
 * available. Declared HERE, far above the block that builds it, because
 * `applyPreset`, `patchParams`, `loadAvsPreset` and `setAvsControl` all
 * publish to it and all sit above that block. A `const` down there would be in
 * its temporal dead zone for anything the boot sequence happens to call first.
 */
let projectorLink: Link | null = null;
/** Set by any panel edit; flushed once per frame by `publishProjectorFrame`. */
let projectorPresetDirty = false;
/**
 * What the projector was last told about the stack, so a coalesced panel edit
 * goes out as the cheapest correct message: in-place hot fields for a slider,
 * a mixer snapshot for mute/solo, a whole preset only for a structural change.
 */
const showEdits = new ShowEditTracker();
/**
 * Re-read the AVS/native lane in the step grid and the input panel. Assigned
 * once both exist (far below); a lane change during boot is a no-op, and both
 * panels re-read the predicate when they open anyway.
 */
let laneAvailabilityRefresh: (() => void) | null = null;
function notifyLaneChanged(): void { laneAvailabilityRefresh?.(); }

// ---------------------------------------------------------------- golden mode
//
// Must run before the canvas is sized: the capture size comes from the query
// string, not the window, and `goldenConfig()` also arms `forbidNondeterminism`.
// Golden and isolated source/operator probes can deliberately allocate large
// GPU targets and run for many frames. They are development controls, not a
// public URL API. Ignore them outside loopback so a crafted Pages link cannot
// turn somebody else's tab into an unbounded test runner.
const loopbackTestHost = location.hostname === 'localhost'
  || location.hostname === '127.0.0.1'
  || location.hostname === '[::1]';
const testSearch = loopbackTestHost ? location.search : '';
const testQuery = new URLSearchParams(testSearch);
const golden = goldenConfig(testSearch);
const transitionTest = testQuery.get('transitionTest') === '1';
const ledStyleTest = testQuery.get('ledStyleTest');
const presetTest = testQuery.get('presetTest');
const sourceTest = testQuery.get('sourceTest');
const operatorTest = testQuery.get('operatorTest');
const uiTest = testQuery.get('uiTest') === '1';

// ---------------------------------------------------------------- audio

const audio = new AudioEngine();
const tempo = new TempoTracker();
const detector = new WorkletDetector();

const tierB = new TierBTimeline(tempo);
// Preset evidence needs a beat-zero authority. Tier B deliberately acquires
// phase only after enough onsets; using it for a frame-numbered golden makes a
// nominal "bar 4" capture depend on detector lock latency. The historical
// default golden keeps its old Tier-B path so its machine-local baseline stays
// byte comparable.
const timeline: Timeline = golden && (presetTest || sourceTest || operatorTest)
  ? StaticTimeline.fromTempo(golden.bpm, 0, Math.max(32, golden.frames * golden.dt + 4))
  : tierB;
const scheduler = new Scheduler();

/**
 * One scheduler request per layer, keyed by `LayerSpec.id`.
 *
 * Rebuilt whenever the preset changes, because the key must be stable per layer
 * or the scheduler's tick cursor resets under it — which shows up as a burst of
 * events on the frame after an edit.
 *
 * Stated plainly, because it is the kind of thing that looks like dead code:
 * the ENVELOPES the renderer uses come from `Layer.update`/`Layer.progress`, not
 * from here. `Scheduler` is the look-ahead path (§4.3/§4.6) — it applies the
 * anchor lead, the output latency and swing, and it is what proves the grid is
 * being predicted rather than reacted to. Today its output feeds the HUD's
 * lateness readout and nothing else. Two mechanisms for one job is a real
 * duplication and it is written down in HANDOFF.md rather than hidden here.
 */
let requests: ScheduleRequest[] = [];
let lastPoll = 0;

const onsetCounts: Record<string, number> = { kick: 0, snare: 0, hat: 0, tonal: 0 };

// Created before the onset callbacks below rather than after `initGpu`, because
// those callbacks push onsets into it and a detector that fires during boot must
// not find it undefined.
const overlay = new DebugOverlay();

// ---------------------------------------------------------------- flash + RUM
//
// Flash limiting for THIS window: persisted, default 'limit', cycled by the
// FLASH button (limit -> strict -> off). The projector ignores it: a wall is
// always limited (projector-window.ts). Live limiting happens at present time
// on a copy or through globalAlpha (flash-gate.ts) and never touches an AVS
// runtime's framebuffer, which is feedback state.
const FLASH_MODE_KEY = 'aaavs.flashMode';
function readFlashMode(): FlashMode {
  try { return parseFlashMode(localStorage.getItem(FLASH_MODE_KEY)); }
  catch { return 'limit'; /* private mode */ }
}
let flashMode: FlashMode = readFlashMode();
const flashGate = new FlashGate(flashMode);
/** The main-thread CPU fallback presents through putImageData, which ignores globalAlpha. */
const cpuFlash = new FlashLimiter(flashMode);
const cpuFlashStats = createFrameStats();
let cpuFlashPrev: Uint8ClampedArray | null = null;
/** The last limiter decision, for the D overlay. Null outside the AVS lane. */
let latestFlash: FlashDecision | null = null;

// Delivered-frame timing (frame-recorder.ts), shown in the D overlay.
const frameRecorder = new FrameRecorder();
const rumReadout = createFrameReadout();
overlay.setFrameStats(rumReadout);

// The AVS GPU lane. 'exact' is the default and keeps AVS output bit-exact;
// '120' is the performer's opt-in "approximate GPU" mode, persisted here and
// sent to the projector. The lane is fixed per worker, so a change recreates it.
const GPU_LANE_KEY = 'aaavs.gpuLane';
function readGpuLane(): AvsFrameGraphLane {
  try { return localStorage.getItem(GPU_LANE_KEY) === '120' ? '120' : 'exact'; }
  catch { return 'exact'; /* private mode */ }
}
let avsGpuLane: AvsFrameGraphLane = readGpuLane();

// The main-thread detector in audio.ts and the worklet both produce onsets. Only
// one may feed the tracker, or every onset counts twice and the tempo histogram
// votes for double time.
audio.onOnset = (o) => {
  if (detector.attached) return;
  tempo.addOnset(o.time);
  onsetCounts[o.klass] = (onsetCounts[o.klass] ?? 0) + 1;
  overlay.pushOnset(o);
};
detector.onOnset = (o) => {
  tempo.addOnset(o.time);
  onsetCounts[o.klass] = (onsetCounts[o.klass] ?? 0) + 1;
  overlay.pushOnset(o);
};

let detectorError = '';

/** Splice the worklet in, once, after the context exists. */
async function ensureDetector(): Promise<void> {
  const ctx = audio.ctx;
  const tap = audio.tap;
  if (!ctx || !tap || detector.attached) return;
  try {
    await detector.attach(ctx, tap);
  } catch (e) {
    detectorError = e instanceof Error ? e.message : String(e);
    console.warn('[aaavs] worklet detector unavailable, falling back:', detectorError);
  }
}

/** Seek / track change (§4.10). Every piece of grid state resets together. */
function resetTransport(now: number): void {
  tempo.reset();
  tierB.reset();
  resetSeekDependentState(now);
}

function resetSeekDependentState(now: number): void {
  scheduler.reset();
  sequencer?.reset();
  stack.reset();
  renderer.resetLayerState();
  detector.reset();
  lastPoll = now;
  stats.scheduledEvents = 0;
  stats.lateBy = 0;
  if (activeAvsCatalogId && (avsEditorModel !== null || avsWorkerRenderer?.active || avsRuntime !== null)) {
    avsLiveDirector.select(activeAvsCatalogId, avsBarPosition(now));
  }
}

async function toggleTransport(): Promise<void> {
  if (!audio.canTransport) return;
  if (audio.isPlaying) await audio.pause();
  else await audio.resume();
  detector.timeOrigin = (audio.ctx?.currentTime ?? 0) - audio.currentTime;
}

function skipBar(direction: -1 | 1): void {
  if (!audio.canTransport) return;
  const from = audio.currentTime;
  const bpm = timeline.bpm(from) || tempo.bpm || 120;
  const target = Math.max(0, from + direction * 4 * 60 / bpm);
  const deltaBeats = (target - from) * bpm / 60;
  audio.seek(target);

  // A whole-bar jump preserves musical phase and a trustworthy tempo lock.
  // Re-anchor both snapshots together; everything tied to old content is reset.
  if (tempo.locked && timeline === tierB) {
    tempo.seekByBeats(deltaBeats, target);
    tierB.seekByBeats(deltaBeats, target);
    resetSeekDependentState(target);
  } else {
    resetTransport(target);
  }
  detector.timeOrigin = (audio.ctx?.currentTime ?? 0) - audio.currentTime;
}

// ---------------------------------------------------------------- preset
//
// The default show. It lives here and not in preset.ts on purpose — a contract
// or a validator that carries data grows opinions about what a show should look
// like, and the module that owns the behaviour should own the default.
//
// Art direction, applied rather than cited:
//
//   THREE HUES. 268 (the near-black floor), 330 (the subject) and 214 (the
//   counterpoint). `accent` is 330 as well — it is the subject's own hue with
//   HDR headroom, not a fourth colour. §2.2.
//
//   ONE FOCAL POINT. `primary` is the only slot above intensity 1.0 that any
//   live layer uses, so the attractor is the only thing bloom finds. The
//   spectrum sits at 0.7 and reads as structure, not as a second subject. §2.4.
//
//   NEGATIVE SPACE. The spectrum reaches 30% of the frame height and the
//   attractor is a thin ribbon; most of the frame is `bg`, which the vignette in
//   `present.wgsl` then pushes further down at the corners. §4.3.
//
// Two envelope shapes appear, and the difference is deliberate:
//
//   SUSTAINED — `attackBeats: 0` with `anchor: 'start'` and a hold longer than
//   the trigger period. `evalEnvelope` treats a zero attack as instant, so
//   progress is pinned at 1 and the layer never dips. This is the only correct
//   shape for a `replace` operator, whose opacity multiplies its output: a
//   kaleidoscope whose envelope dipped would flash the whole frame black.
//
//   BREATHING — a fast attack against a release several times longer than the
//   trigger period, so the layer swells on the pulse and falls only part of the
//   way back before the next one. The attractor pulses roughly 0.64 -> 1.0 per
//   beat and the spectrum roughly 0.4 -> 1.0 per bar. Both numbers are the
//   arithmetic of `evalEnvelope`, not a guess, and both are chosen to be a pulse
//   rather than a strobe (§3.2).

const DEFAULT_PRESET: Preset = {
  version: 1,
  name: 'first-light',
  seed: 1,
  layers: [
    {
      // The floor. A geometric-axis spectrum across the bottom third — the GRID
      // look of art-direction §1.2, kept quiet so it frames the subject.
      id: 'grid',
      type: 'spectrum',
      family: 'source',
      params: {
        mode: 'bars',
        bars: 40,
        gain: 1.0,
        gamma: 0.6,
        gap: 0.4,
        height: 0.3,
        bodyLevel: 0.5,
        capLevel: 0.9,
      },
      blend: 'add',
      opacity: 0.8,
      // Breathing, once per bar. Release 12 beats against a 4-beat period, so
      // the floor falls to ~0.4 and swells back on every downbeat.
      envelope: { attackBeats: 0.35, holdBeats: 1, releaseBeats: 12 },
      trigger: { division: 'bar', euclidK: 1, euclidN: 1, probability: 1, offsetSteps: 0 },
      anchor: 'peak',
      palette: 'secondary',
      enabled: true,
      resolutionScale: 1,
    },
    {
      // The subject. Everything the vertical slice's compute+points pair did,
      // now one descriptor: `src/sources/lorenz.ts`.
      id: 'attractor',
      type: 'lorenz',
      family: 'source',
      params: {
        trajectories: 24_000,
        substeps: 6,
        simPerBeat: 0.85,
        spinBars: 16,
        hueBars: 48,
        rhoLow: 14,
        rhoPulse: 6,
        // Raised well above LORENZ_DEFAULTS, and this is the one set of numbers
        // in the preset that had to change rather than move. In the old chain
        // the accumulator itself retained the trail, so a per-frame brightness
        // of ~0.03 reached a steady state around fifty times that. Here the
        // trail is a separate `feedback` layer whose steady state is `gain`
        // times the frame beneath — a multiplier of ~1.85 in total, not ~50 —
        // so the per-frame figure has to carry the brightness itself.
        // Derived, not measured: NOBODY HAS LOOKED AT THIS ON A SCREEN.
        brightBase: 0.10,
        brightLevel: 0.30,
        brightEnv: 0.20,
        fit: 0.022,
        thickness: 0.0016,
      },
      blend: 'add',
      opacity: 1,
      // Breathing, once per beat. Release 3 beats against a 1-beat period puts
      // the trough near 0.64 — a pulse, not a strobe. `progress` also drives
      // `rhoPulse`, so the attractor changes SHAPE on the beat rather than only
      // getting brighter (§3.3).
      envelope: { attackBeats: 0.12, holdBeats: 0.55, releaseBeats: 3 },
      trigger: { division: 'beat', euclidK: 1, euclidN: 1, probability: 1, offsetSteps: 0 },
      anchor: 'peak',
      palette: 'primary',
      enabled: true,
      resolutionScale: 1,
    },
    {
      // What `fade.wgsl` used to be. A feedback layer owns its own ping-pong
      // pair, decays in BEATS, and composites additively — the same trail, with
      // a stability-clamped zoom the hand-written version never had.
      id: 'trail',
      type: 'feedback',
      family: 'feedback',
      params: {
        tauBeats: 1.2,
        gain: 0.85,
        zoomPerBeat: 1.0,
        // Off-centre. The centred version is the "everything radiates from the
        // middle" composition art-direction §4.1 rejects, and feedback is the
        // one effect where moving the origin costs nothing.
        centreX: 0.42,
        centreY: 0.56,
        clipCeiling: 1.15,
        edgeFade: 0.04,
      },
      blend: 'add',
      // 1, deliberately. `feedback.ts` already multiplies its injection by
      // `ctx.opacity`, and the renderer's composite blit multiplies by it again,
      // so any value below 1 is applied twice. Documented in HANDOFF.md.
      opacity: 1,
      // Sustained: hold 4.5 beats against a 4-beat trigger, so progress never
      // leaves 1. A trail that re-attacked would visibly restart every bar.
      envelope: { attackBeats: 0, holdBeats: 4.5, releaseBeats: 2 },
      trigger: { division: 'bar', euclidK: 1, euclidN: 1, probability: 1, offsetSteps: 0 },
      anchor: 'start',
      palette: 'primary',
      enabled: true,
      // Half res. A trail is soft and low-frequency, and its history pair is
      // 30 MB at 2560x1440 — the best candidate in the stack for §4.11.
      resolutionScale: 0.5,
    },
    {
      // The operator, unchanged in intent from the slice.
      id: 'fold',
      type: 'kaleidoscope',
      family: 'operator',
      params: { segments: 6, rotBars: 64, mix: 0.55 },
      blend: 'replace',
      opacity: 1,
      // Sustained, and it MUST be: this shader multiplies its output by
      // `C.opacity`, so a dipping envelope on a `replace` blend is a black flash.
      envelope: { attackBeats: 0, holdBeats: 4.5, releaseBeats: 2 },
      trigger: { division: 'bar', euclidK: 1, euclidN: 1, probability: 1, offsetSteps: 0 },
      anchor: 'start',
      palette: 'primary',
      enabled: true,
      resolutionScale: 1,
    },
  ],
  palette: {
    name: 'first-light',
    bg:        { l: 0.035, c: 0.018, h: 268, intensity: 1 },
    primary:   { l: 0.70,  c: 0.17,  h: 330, intensity: 1.7 },
    secondary: { l: 0.55,  c: 0.11,  h: 214, intensity: 0.7 },
    // The subject's hue with headroom, not a fourth colour.
    accent:    { l: 0.90,  c: 0.20,  h: 330, intensity: 2.4 },
    ramp: [
      { at: 0,    color: { l: 0.05, c: 0.02, h: 268, intensity: 1 } },
      { at: 0.55, color: { l: 0.55, c: 0.11, h: 214, intensity: 0.9 } },
      { at: 1,    color: { l: 0.88, c: 0.18, h: 330, intensity: 2.0 } },
    ],
  },
};

const stack = new LayerStack();
let preset: Preset = DEFAULT_PRESET;
let presetError = '';
try {
  preset = PRESET_BANK.find((entry) => entry.preset.name === presetTest)?.preset
    ?? presetFromLocation(location.hash)
    // Preserve the historical machine-local golden baseline while making the
    // first authored V2 scene the real application default.
    ?? (golden ? DEFAULT_PRESET : PRESET_BANK[0]!.preset);
} catch (e) {
  // A bad shared link must say so rather than boot into a blank stack.
  presetError = e instanceof Error ? e.message : String(e);
}
// Golden-only visual probe. It makes every spectrum layer a physical ladder in
// one chosen shape without mutating the real preset bank or requiring a UI
// interaction before capture.
if (ledStyleTest) {
  preset = {
    ...preset,
    name: `${preset.name}-${ledStyleTest}`,
    layers: preset.layers.map((layer) => layer.type !== 'spectrum' ? layer : {
      ...layer,
      params: { ...layer.params, ledStyle: ledStyleTest, segments: 12, segGap: 0.32, ledOff: 0.12 },
    }),
  };
}
if (sourceTest) {
  preset = {
    version: 1,
    name: `audit-${sourceTest}`,
    seed: 0xaad17,
    palette: preset.palette,
    layers: [{
      id: 'audit', type: sourceTest, family: 'source', params: {}, blend: 'add', opacity: 1,
      envelope: { attackBeats: 0.05, holdBeats: 64, releaseBeats: 1 },
      trigger: { division: 'beat', euclidK: 1, euclidN: 1, probability: 1, offsetSteps: 0 },
      anchor: 'peak', palette: 'primary', enabled: true, resolutionScale: 1,
    }],
  };
}
if (operatorTest) {
  preset = {
    version: 1,
    name: `audit-operator-${operatorTest}`,
    seed: 0xaa0f2,
    palette: preset.palette,
    layers: [
      {
        id: 'audit-source', type: 'phosphor-orbit', family: 'source', params: {}, blend: 'add', opacity: 1,
        envelope: { attackBeats: 0, holdBeats: 64, releaseBeats: 1 },
        trigger: { division: '4bar', euclidK: 1, euclidN: 1, probability: 1, offsetSteps: 0 },
        anchor: 'start', palette: 'primary', enabled: true, resolutionScale: 1,
      },
      {
        id: 'audit-operator', type: operatorTest, family: 'operator', params: {}, blend: 'replace', opacity: 1,
        envelope: { attackBeats: 0, holdBeats: 64, releaseBeats: 1 },
        trigger: { division: '4bar', euclidK: 1, euclidN: 1, probability: 1, offsetSteps: 0 },
        anchor: 'start', palette: 'accent', enabled: true, resolutionScale: 1,
      },
    ],
  };
}
stack.load(preset);
rebuildRequests();

// The director owns WHEN and WHICH; applying is ours, because loading touches
// the stack, the scheduler and the renderer's target pool.
const director = new PresetDirector([...PRESET_BANK], {
  dynamic: true, minBars: 2, maxBars: 12, seed: 0xa4a5,
});
const transition = new Transition();
let outgoingFrame: PooledTarget | null = null;
let captureOutgoing = false;

/**
 * Leave the AVS lane for the native stack: supersede any AVS load, tear down
 * the workbench and the live AVS description. Shared by a director/keyboard
 * preset change (`applyPreset`) and a panel file load (`onLoadPreset`).
 */
function leaveAvsLane(): void {
  avsLoadRevision++;
  avsLiveLoadGuard.supersede();
  avsEditor?.dispose();
  avsEditor = null;
  avsEditorHost = null;
  avsEditorModel = null;
  syncAvsParams();
  avsControls.clear();
  ui?.setLayerEditor(null);
  ui?.setPersonalAvsCanAdd(false);
  avsWorkerRenderer?.clear();
  avsRuntime = null;
  avsPresetName = '';
  avsLiveBytes = null;
  avsLiveFileName = '';
  avsCanvas.style.display = 'none';
  latestFlash = null;
}

/**
 * Adopt a native preset in this window (via show-state.ts, the same rules the
 * projector applies) and tell the projector. One `preset` message covers both
 * halves: the projector's handler leaves the AVS lane before it loads the
 * stack. The mixer snapshot follows because the preset does not carry it.
 */
function adoptNativePreset(next: Preset, spec: TransitionSpec | null, now: number, bpm: number): void {
  frameRecorder.markPresetSwitch(performance.now());
  preset = next;
  const loaded = loadShowStack(stack, renderer, transition, next, spec, now, bpm);
  plan = loaded.plan;
  if (spec) captureOutgoing = loaded.captureOutgoing;
  rebuildRequests();
  knownLayerIds = stack.all.map((l) => l.id).join('|');
  presetError = '';
  ui.setPreset(next);
  showEdits.rebase(stack);
  projectorPresetDirty = false;
  projectorSend({ kind: 'preset', preset: next, transition: spec, at: now, bpm });
  projectorSend({ kind: 'mixer', mixer: stack.mixerSnapshot() });
  notifyLaneChanged();
}

function applyPreset(next: Preset, spec?: TransitionSpec, now = 0, bpm = 120): void {
  leaveAvsLane();
  adoptNativePreset(next, spec ?? null, now, bpm);
}
let plan: StackPlan = stack.frame(0).plan;

function rebuildRequests(): void {
  requests = preset.layers.map((spec) => ({
    key: spec.id,
    trigger: spec.trigger,
    anchor: spec.anchor,
    envelope: spec.envelope,
    swing: 0,
    seed: preset.seed,
  }));
}

// ---------------------------------------------------------------- boot

let gpu: Gpu;
try {
  // Golden mode forces DPR 1 and the requested size. A device-pixel-ratio in the
  // capture makes the baseline depend on which monitor the browser opened on.
  const dpr = golden ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = golden ? golden.width : Math.round(window.innerWidth * dpr);
  canvas.height = golden ? golden.height : Math.round(window.innerHeight * dpr);
  gpu = await initGpu(canvas);
} catch (e) {
  const msg = e instanceof GpuInitError ? e.message : String(e);
  err.textContent = msg;
  err.hidden = false;
  goldenFail(e);
  throw e;
}

const device = gpu.device;
const sampler = createSampler(gpu);
const timer = new GpuTimer(device, gpu.hasTimestamp);
const audioGpu = new AudioGpu(device);
const harness = golden ? new GoldenHarness(golden) : null;

const renderer = new Renderer({ gpu, timer, audioGpu });
renderer.register(...SOURCE_PASSES, ...OPERATOR_PASSES);
renderer.prune(stack.all.map((l) => l.id));

/** The layer set the renderer last pruned against. See `onEdit` below. */
let knownLayerIds = stack.all.map((l) => l.id).join('|');
let avsRuntime: AvsCompatibilityRuntime | null = null;
let avsPresetName = '';
/**
 * The bytes of whatever `.avs` is live, kept so a projector window that opens
 * (or reloads) mid-set can be handed the current preset. Every edit in the AVS
 * workbench re-enters `loadAvsPreset` with the re-serialised graph, so this is
 * the edited preset, not the one originally chosen from a bank.
 */
let avsLiveBytes: Uint8Array | null = null;
let avsLiveFileName = '';
let avsUnsupported = 0;
const avsPcmLeft = new Float32Array(576);
const avsPcmRight = new Float32Array(576);
// AVS display settings (upscale mode, raster policy, frame-rate lock) are
// shared with the projector window through localStorage. The defaults keep
// today's look (pixelated stretch, classic 640-class raster, display rate);
// everything else is opt-in (see DEFAULT_AVS_DISPLAY_SETTINGS).
let avsDisplaySettings: AvsDisplaySettings = readAvsDisplaySettings();
if (avsPresenter) {
  avsPresenter.mode = avsDisplaySettings.upscale;
  avsPresenter.integerCover = avsDisplaySettings.resolution === 'crisp';
}
// Worker rendering starts at the full classic 640×360 cap and, in Classic,
// can never leave it: its governor has one tier (the scale-1 floor), so wiring
// recordRender only feeds the average. The four adaptive tiers remain only for
// the main-thread compatibility fallback on browsers without workers.
let avsGovernor = new AvsFrameGovernor(avsGovernorOptions(avsDisplaySettings, 'worker'));
let avsFallbackGovernor = new AvsFrameGovernor(avsGovernorOptions(avsDisplaySettings, 'fallback'));
const avsDisplayRate = new DisplayRateEstimator();
// AVS dims only follow the window after 250 ms of stability: each change
// resets the preset's feedback state and rebuilds the worker's GPU surface.
const avsDims = new AvsDimensionsDebouncer(250);
let avsImage: ImageData | null = null;
let avsImageWords: Uint32Array | null = null;
let avsLastRenderMs = 0;
/** Freshest audio from rAF, for frames dispatched the moment the worker goes idle. */
let avsLatestAudio: AudioSnapshot | null = null;
/** At most one dispatch per vsync, so a fast preset cannot outrun the display. */
let avsDispatchedThisVsync = false;
let avsLastDispatchMs = -Infinity;
/** While the projector presents, this window is a dimmed monitor: cap its AVS work. */
const AVS_MONITOR_FPS = 24;
let projectorPresenting = false;
let avsWorkerRenderer: AvsWorkerRenderer | null = createAvsWorkerRenderer();
let avsEditor: AvsEditor | null = null;
let avsEditorHost: HTMLDivElement | null = null;
let avsEditorModel: AvsEditorModel | null = null;
let avsEditorFileName = '';
const avsControls = new Map<string, AvsComponentControl>();
const avsCapabilityRegistry = createAvsCompatibilityRegistry();
let avsLoadRevision = 0;
/** The worker load awaiting its ack, so a GPU-lane change can re-issue it on the new worker. */
let avsInFlightLoad: { readonly bytes: Uint8Array; readonly fileName: string; readonly revision: number } | null = null;
interface AvsLiveCatalogEntry extends AvsLiveDirectorPreset {
  readonly fileName: string;
  load(): Promise<Uint8Array>;
}
const bundledAvsLiveBank: readonly AvsPresetEntry[] = await AVS_PRESET_SOURCES.list('bundled');
let localAvsLiveBank: readonly AvsLiveCatalogEntry[] = [];
let personalAvsPresets: readonly AvsPresetEntry[] = [];
let personalAvsLiveBank: readonly AvsLiveCatalogEntry[] = [];
let activeAvsLiveBank: readonly AvsLiveCatalogEntry[] = bundledAvsLiveBank;
let activeAvsCatalogId = '';
const avsLiveLoadGuard = new AvsLiveLoadGuard();

async function ensureLocalAvsCatalog(): Promise<readonly AvsPresetEntry[]> {
  if (localAvsLiveBank.length) return localAvsLiveBank as readonly AvsPresetEntry[];
  localAvsLiveBank = await AVS_PRESET_SOURCES.autoBank('local');
  return localAvsLiveBank as readonly AvsPresetEntry[];
}

async function refreshPersonalAvsBank(updateUi: boolean): Promise<void> {
  try { personalAvsPresets = await AVS_PRESET_SOURCES.list('personal'); }
  catch (error) {
    personalAvsPresets = [];
    console.warn('[aaavs] personal AVS bank unavailable:', error);
  }
  personalAvsLiveBank = personalAvsPresets;
  if (updateUi) ui.setPersonalAvsPresets(personalAvsPresets);
}

function avsBarPosition(at = audio.currentTime): number {
  const trackedBpm = timeline.bpm(at);
  return resolveAvsLiveBarPosition(
    timeline.slotAt(at) / SLOTS_PER_BEAT / 4,
    trackedBpm,
    at,
    resolveTempoBpm(trackedBpm, tempo.bpm),
  );
}

type AvsLiveBankKind = 'bundled' | 'local' | 'personal' | 'external';
function avsLiveBankKind(bank: readonly AvsLiveCatalogEntry[]): AvsLiveBankKind {
  if (bank === bundledAvsLiveBank) return 'bundled';
  if (bank === localAvsLiveBank) return 'local';
  if (bank === personalAvsLiveBank) return 'personal';
  return 'external';
}

async function loadAvsCatalogEntry(
  entry: AvsLiveCatalogEntry,
  bank: readonly AvsLiveCatalogEntry[],
  selectionPending = false,
): Promise<void> {
  if (!selectionPending && activeAvsCatalogId) {
    avsLiveDirector.select(activeAvsCatalogId, avsBarPosition());
  }
  const ticket = avsLiveLoadGuard.begin();
  const revision = ++avsLoadRevision;
  try {
    const bytes = await entry.load();
    if (!avsLiveLoadGuard.isCurrent(ticket) || revision !== avsLoadRevision) return;
    const loaded = await loadAvsPreset(bytes, entry.fileName, false, revision);
    if (!loaded || !avsLiveLoadGuard.isCurrent(ticket) || revision !== avsLoadRevision) return;

    const bankChanged = activeAvsLiveBank !== bank;
    activeAvsLiveBank = bank;
    activeAvsCatalogId = entry.id;
    if (bankChanged) avsLiveDirector.setBank(bank, entry.id, avsBarPosition());
    else if (selectionPending) avsLiveDirector.commit(entry.id, avsBarPosition());
    else avsLiveDirector.select(entry.id, avsBarPosition());
    if (bank.length < 2) avsLiveDirector.enabled = false;
    ui.setAuto(avsLiveDirector.enabled);
    ui.setAvsPresetSelection(entry.id, avsLiveBankKind(bank));
  } catch (error) {
    if (selectionPending && avsLiveLoadGuard.isCurrent(ticket)) {
      avsLiveDirector.cancel(entry.id, avsBarPosition());
    }
    throw error;
  } finally {
    avsLiveLoadGuard.finish(ticket);
  }
}

async function addCurrentAvsToPersonalBank(): Promise<void> {
  if (!avsEditorModel) throw new Error('Load an AVS preset before adding it to My AVS bank');
  const bytes = serializeAvsEditorModel(avsEditorModel);
  const name = avsEditorFileName.replace(/\.avs$/i, '') || 'Edited AVS preset';
  await PERSONAL_AVS_BANK.put(name, bytes, `${name}.avs`);
  AVS_PRESET_SOURCES.invalidate('personal');
  await refreshPersonalAvsBank(true);
}

async function exportPersonalAvsBank(): Promise<void> {
  const blob = await PERSONAL_AVS_BANK.exportBlob();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'aaavs-personal-avs-bank.json';
  link.click();
  requestAnimationFrame(() => URL.revokeObjectURL(link.href));
}

async function importPersonalAvsBank(file: File): Promise<void> {
  await PERSONAL_AVS_BANK.importFile(file);
  AVS_PRESET_SOURCES.invalidate('personal');
  await refreshPersonalAvsBank(true);
}

function createAvsWorkerRenderer(): AvsWorkerRenderer | null {
  if (!AvsWorkerRenderer.supported() || !avsContext) return null;
  try {
    return new AvsWorkerRenderer({
      canvas: avsCanvas,
      context: avsContext,
      gpuLane: avsGpuLane,
      latchFrames: true,
      onFrame() {
        if (!avsWorkerRenderer) return;
        avsLastRenderMs = avsWorkerRenderer.lastRenderMs;
        avsUnsupported = avsWorkerRenderer.unsupported;
        // Floor-aware: Classic/Crisp cannot change tier, High may step down
        // (never below classic) after its dwell. A tier change reaches the
        // worker through the dims of the next dispatch.
        avsGovernor.recordRender(avsLastRenderMs, performance.now());
        frameRecorder.recordRender(avsLastRenderMs);
        if (avsWorkerRenderer.gpuMs !== undefined) frameRecorder.recordGpu(avsWorkerRenderer.gpuMs);
      },
      onIdle() { dispatchAvsWorkerFrame(performance.now()); },
    });
  } catch (error) {
    console.warn('[aaavs] could not create AVS render worker, using main-thread fallback:', error);
    return null;
  }
}

/**
 * Switch the AVS GPU lane. Persisted, mirrored to the projector, and applied
 * by recreating the worker (the lane is sent with each load) and reloading the
 * live preset on it with its controls kept. The CPU fallback has no GPU lane.
 */
function setAvsGpuLane(lane: AvsFrameGraphLane): void {
  if (lane === avsGpuLane) return;
  avsGpuLane = lane;
  try { localStorage.setItem(GPU_LANE_KEY, lane); } catch { /* private mode */ }
  projectorSend({ kind: 'render-settings', gpuLane: lane });
  refreshSettingsButtons();
  const worker = avsWorkerRenderer;
  if (!worker) return;
  // A load still waiting on the old worker is what the performer asked for
  // last: disposing the worker supersedes it, so reload THAT, not the preset
  // it was replacing (or nothing, if it was the first AVS load).
  const inFlight = avsInFlightLoad?.revision === avsLoadRevision ? avsInFlightLoad : null;
  worker.dispose();
  avsWorkerRenderer = createAvsWorkerRenderer();
  const bytes = inFlight?.bytes ?? avsLiveBytes;
  const fileName = inFlight?.fileName ?? avsLiveFileName;
  if (!bytes) return;
  void loadAvsPreset(bytes, fileName, true).catch((error) => {
    console.error('[aaavs] reloading AVS on the new GPU lane failed:', error);
  });
}

function setFlashMode(mode: FlashMode): void {
  flashMode = mode;
  flashGate.setMode(mode);
  // The CPU fallback's history and its previous-output buffer stop updating
  // while off; blending against a frame from before the switch would ghost it.
  cpuFlash.reset();
  try { localStorage.setItem(FLASH_MODE_KEY, mode); } catch { /* private mode */ }
  if (mode === 'off') latestFlash = null;
  refreshSettingsButtons();
}

function readAvsDisplaySettings(): AvsDisplaySettings {
  try { return parseAvsDisplaySettings(localStorage.getItem(AVS_DISPLAY_SETTINGS_KEY)); }
  catch { return parseAvsDisplaySettings(null); /* private mode */ }
}

/**
 * The size the AVS raster is derived from. `fit` keeps the DPR-2-capped
 * WebGPU surface size it always used, so default rasters are unchanged;
 * the integer (crisp) policy needs real device pixels.
 */
function avsSourceSize(governor: AvsFrameGovernor): { width: number; height: number } {
  return governor.policy === 'integer' ? currentAvsViewport() : { width: gpu.width, height: gpu.height };
}

/** Settled (debounced) AVS dims for the next frame. */
function avsTargetDims(governor: AvsFrameGovernor, nowMs: number): { width: number; height: number } {
  const source = avsSourceSize(governor);
  return avsDims.current(governor.dimensions(source.width, source.height), nowMs);
}

function applyAvsDisplaySettings(next: AvsDisplaySettings, persist: boolean): void {
  const rasterChanged = next.resolution !== avsDisplaySettings.resolution || next.frameRate !== avsDisplaySettings.frameRate;
  avsDisplaySettings = next;
  if (persist) {
    try { localStorage.setItem(AVS_DISPLAY_SETTINGS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  }
  if (avsPresenter) {
    avsPresenter.mode = next.upscale;
    avsPresenter.integerCover = next.resolution === 'crisp';
  }
  if (rasterChanged) {
    const hz = avsDisplayRate.hz;
    avsGovernor = new AvsFrameGovernor(avsGovernorOptions(next, 'worker'));
    avsFallbackGovernor = new AvsFrameGovernor(avsGovernorOptions(next, 'fallback'));
    avsGovernor.setDisplayHz(hz);
    avsFallbackGovernor.setDisplayHz(hz);
    // A deliberate raster change resets the preset once, now, not after a debounce.
    const governor = avsWorkerRenderer?.active ? avsGovernor : avsFallbackGovernor;
    const source = avsSourceSize(governor);
    avsDims.settle(governor.dimensions(source.width, source.height));
  }
}

function syncAvsSurface(nowMs: number): void {
  if (!avsRuntime) return;
  const { width, height } = avsTargetDims(avsFallbackGovernor, nowMs);
  if (avsRuntime.framebuffer.width !== width || avsRuntime.framebuffer.height !== height) {
    avsRuntime.resize(width, height);
    avsImage = null;
    avsImageWords = null;
  }
}

async function loadAvsPreset(
  bytes: Uint8Array,
  fileName: string,
  preserveControls = false,
  requestedRevision?: number,
): Promise<boolean> {
  const loadRevision = requestedRevision ?? ++avsLoadRevision;
  if (loadRevision !== avsLoadRevision) return false;
  frameRecorder.markPresetSwitch(performance.now());
  flashGate.reset();
  cpuFlash.reset();
  avsGovernor.reset();
  avsFallbackGovernor.reset();
  // A load resets the preset anyway, so it adopts the current size at once.
  const loadGovernor = avsWorkerRenderer ? avsGovernor : avsFallbackGovernor;
  const loadSource = avsSourceSize(loadGovernor);
  const { width, height } = loadGovernor.dimensions(loadSource.width, loadSource.height);
  avsDims.settle({ width, height });
  const parsed = parseAvsPreset(bytes);
  const nextEditorModel = createAvsEditorModel(parsed);
  if (!preserveControls) avsControls.clear();
  // Keep the current AVS workbench mounted until the replacement renderer is
  // actually ready. Unmounting it here made every preset/action collapse the
  // drawer to its narrow native width, expose unrelated native-layer controls,
  // then expand again after the worker acked the load.
  avsRuntime = null;
  const worker = avsWorkerRenderer;
  if (worker) {
    avsInFlightLoad = { bytes, fileName, revision: loadRevision };
    try {
      try {
        await worker.load(bytes, width, height);
      } finally {
        if (avsInFlightLoad?.revision === loadRevision) avsInFlightLoad = null;
      }
      if (loadRevision !== avsLoadRevision || avsWorkerRenderer !== worker) return false;
      avsUnsupported = worker.unsupported;
      avsPresetName = fileName.replace(/\.avs$/i, '');
      avsCanvas.width = width;
      avsCanvas.height = height;
      avsLastRenderMs = 0;
      avsCanvas.style.display = 'block';
      avsLiveDirector.enabled ||= director.enabled;
      director.enabled = false;
      ui.setAuto(avsLiveDirector.enabled);
      worker.setControls([...avsControls.values()]);
      avsEditorModel = nextEditorModel;
      avsEditorFileName = fileName;
      syncAvsParams();
      activateAvsEditor(parsed, fileName, preserveControls);
      adoptAvsForProjector(bytes, fileName);
      notifyLaneChanged();
      return true;
    } catch (error) {
      if (loadRevision !== avsLoadRevision || avsWorkerRenderer !== worker) return false;
      if (error instanceof Error && error.message === 'AVS preset load superseded') return false;
      console.warn('[aaavs] worker renderer unavailable, using main-thread fallback:', error);
      worker.dispose();
      if (avsWorkerRenderer === worker) avsWorkerRenderer = null;
    }
  }
  const bitmapResolver = await loadBundledAvsBitmapResolver();
  if (loadRevision !== avsLoadRevision) return false;
  const registry = createAvsCompatibilityRegistry({}, { bitmapResolver });
  // The fallback has its own governor; after a worker failure its dims may
  // differ from the worker's (High mode), so size from it directly.
  const fallbackSource = avsSourceSize(avsFallbackGovernor);
  const fallbackDims = avsFallbackGovernor.dimensions(fallbackSource.width, fallbackSource.height);
  avsDims.settle(fallbackDims);
  const nextRuntime = new AvsCompatibilityRuntime(parsed, fallbackDims.width, fallbackDims.height, registry);
  nextRuntime.setControls([...avsControls.values()]);
  const warmup = nextRuntime.render(undefined, true);
  if (loadRevision !== avsLoadRevision) return false;
  avsRuntime = nextRuntime;
  avsUnsupported = warmup.stats.unsupported;
  avsPresetName = fileName.replace(/\.avs$/i, '');
  avsCanvas.width = fallbackDims.width;
  avsCanvas.height = fallbackDims.height;
  avsImage = null;
  avsImageWords = null;
  avsLastRenderMs = 0;
  avsCanvas.style.display = 'block';
  avsLiveDirector.enabled ||= director.enabled;
  director.enabled = false;
  ui.setAuto(avsLiveDirector.enabled);
  avsEditorModel = nextEditorModel;
  avsEditorFileName = fileName;
  syncAvsParams();
  activateAvsEditor(parsed, fileName, preserveControls);
  adoptAvsForProjector(bytes, fileName);
  notifyLaneChanged();
  return true;
}

/**
 * Hold the live `.avs` bytes and hand them to the projector.
 *
 * A copy, because `AvsWorkerRenderer.load` normalises its input into a
 * transferable buffer and the caller's view may be backed by anything; the
 * copy is one per preset load, never one per frame. Controls follow the bytes
 * immediately so a mid-set mute does not survive on the projector's copy of a
 * preset that no longer has that node.
 */
function adoptAvsForProjector(bytes: Uint8Array, fileName: string): void {
  avsLiveBytes = new Uint8Array(bytes);
  avsLiveFileName = fileName;
  projectorSend({ kind: 'avs-load', bytes: avsLiveBytes, fileName });
  projectorSend({ kind: 'avs-controls', controls: [...avsControls.values()] });
}

/** True while the projector shows the output and this window is a capped monitor. */
function avsMonitorThrottled(nowMs: number): boolean {
  return projectorPresenting && nowMs - avsLastDispatchMs < 1000 / AVS_MONITOR_FPS - 1;
}

/**
 * Dispatch one worker frame if the worker is idle. Called from rAF and again
 * the moment a frame comes back (`onIdle`), so the worker never sits idle
 * until the next vsync: the period becomes max(render, vsync) instead of
 * ceil(render / vsync) vsyncs. The one-per-vsync flag stops a fast preset from
 * rendering (and animating) faster than the display.
 */
function dispatchAvsWorkerFrame(nowMs: number): boolean {
  const worker = avsWorkerRenderer;
  if (!worker?.active || !avsLatestAudio || audio.isPaused || harness) return false;
  // Do not consume a cadence slot while the prior frame is still running.
  // Otherwise a 40 ms preset at a 30 fps target gets dispatched only every
  // other 33 ms slot (~15 fps) even though the worker is ready around 24 fps.
  if (worker.busy || avsDispatchedThisVsync || avsMonitorThrottled(nowMs)) return false;
  if (!avsGovernor.shouldRender(nowMs)) return false;
  const { width, height } = avsTargetDims(avsGovernor, nowMs);
  if (!worker.render(avsLatestAudio, width, height)) return false;
  avsDispatchedThisVsync = true;
  avsLastDispatchMs = nowMs;
  return true;
}

/**
 * Draw the newest completed worker frame through the flash gate. Called once
 * per rAF; true when a new frame went up. `nowMs` is the rAF clock: the
 * limiter's window must keep moving while the audio clock pauses or rewinds.
 */
function presentAvsWorkerFrame(nowMs: number): boolean {
  const worker = avsWorkerRenderer;
  if (!worker || !avsPresenter || !avsContext) return false;
  const viewport = currentAvsViewport();
  const context = avsContext;
  return worker.presentLatest((bitmap, width, height) => {
    latestFlash = flashGate.present(context, bitmap, nowMs / 1000, () => avsPresenter.present(bitmap, width, height, viewport));
  });
}

function renderAvsPreset(audioFrame: AudioSnapshot, nowMs: number): boolean {
  if (!avsContext) return false;
  if (avsWorkerRenderer?.active) {
    avsLatestAudio = audioFrame;
    return dispatchAvsWorkerFrame(nowMs);
  }
  if (!avsRuntime || avsMonitorThrottled(nowMs) || !avsFallbackGovernor.shouldRender(nowMs)) return false;
  avsLastDispatchMs = nowMs;
  syncAvsSurface(nowMs);
  const started = performance.now();
  const frames = Math.max(1, Math.trunc(audioFrame.waveform.length / 2));
  for (let i = 0; i < 576; i++) {
    const source = Math.min(frames - 1, Math.trunc(i * frames / 576));
    avsPcmLeft[i] = audioFrame.waveform[source * 2] ?? 0;
    avsPcmRight[i] = audioFrame.waveform[source * 2 + 1] ?? avsPcmLeft[i]!;
  }
  const frame = avsRuntime.renderPcm({ left: avsPcmLeft, right: avsPcmRight });
  avsUnsupported = frame.stats.unsupported;
  if (!avsImage || avsImage.width !== frame.framebuffer.width || avsImage.height !== frame.framebuffer.height) {
    avsImage = new ImageData(frame.framebuffer.width, frame.framebuffer.height);
    avsImageWords = new Uint32Array(
      avsImage.data.buffer,
      avsImage.data.byteOffset,
      frame.framebuffer.pixels.length,
    );
  }
  copyAvsPixelsToRgba(frame.framebuffer.pixels, avsImage.data, avsImageWords ?? undefined);
  // `avsImage` is this frame's presentation copy, so limiting it in place
  // leaves the runtime's framebuffer (its feedback state) untouched.
  if (!cpuFlashPrev || cpuFlashPrev.length !== avsImage.data.length) {
    cpuFlashPrev = new Uint8ClampedArray(avsImage.data.length);
    cpuFlash.reset();
  }
  cpuFlash.setMode(flashMode);
  latestFlash = flashMode === 'off'
    ? null
    : limitRgbaFrame(cpuFlash, cpuFlashStats, avsImage.data, cpuFlashPrev, avsImage.width, avsImage.height, nowMs / 1000);
  if (avsPresenter) avsPresenter.presentImageData(avsImage, currentAvsViewport());
  else avsContext.putImageData(avsImage, 0, 0);
  avsLastRenderMs = performance.now() - started;
  avsFallbackGovernor.recordRender(avsLastRenderMs);
  frameRecorder.recordRender(avsLastRenderMs);
  return true;
}

function avsControl(path: string): Required<AvsComponentControl> {
  const current = avsControls.get(path);
  return {
    path,
    enabled: current?.enabled ?? true,
    muted: current?.muted ?? false,
    solo: current?.solo ?? false,
  };
}

function setAvsControl(path: string, patch: Omit<AvsComponentControl, 'path'>): void {
  const next = { ...avsControl(path), ...patch, path };
  if (next.enabled && !next.muted && !next.solo) avsControls.delete(path);
  else avsControls.set(path, next);
  const controls = [...avsControls.values()];
  if (avsWorkerRenderer?.active) avsWorkerRenderer.setControls(controls);
  else avsRuntime?.setControls(controls);
  projectorSend({ kind: 'avs-controls', controls });
  avsEditor?.refresh();
}

function avsNodeState(component: AvsComponent, path: string): AvsEditorNodeState {
  const control = avsControl(path);
  return {
    enabled: (component.list?.enabled ?? true) && control.enabled,
    muted: control.muted,
    soloed: control.solo,
    supported: component.list !== null || avsCapabilityRegistry.handler(component) !== undefined,
  };
}

/**
 * Publish the loaded AVS preset's patchable renderer fields.
 *
 * The same `avsFieldParams` projection the inspector draws from, registered so
 * a blur mode or a Set Render Mode line width can be bound to a knob or written
 * by a step — which is the whole point of there being one list.
 *
 * Registration follows the STRUCTURE, not the values: the accessors resolve the
 * node by path at call time, so a field edit (which reloads the preset) leaves
 * the ids identical and the early return below keeps every binding alive. The
 * ids go away only when a preset with a different shape loads.
 *
 * These are declared `cost: 'reload'` in the adapter, so the registry throttles
 * them rather than queueing one preset re-serialisation per CC event.
 */
let avsParamRelease: ParamUnregister | null = null;
let avsParamSignature = '';

function applyAvsFieldPatch(path: string, patch: AvsEditorFieldPatch): Promise<void> {
  if (!avsEditorModel) return Promise.resolve();
  avsEditorModel = patchAvsEditorNodeFields(avsEditorModel, path, patch);
  return loadAvsPreset(serializeAvsEditorModel(avsEditorModel), avsEditorFileName, true).then(() => {});
}

function collectAvsParams(nodes: readonly AvsEditorDecodedNode[], out: ParamEntry[]): void {
  for (const node of nodes) {
    const path = node.path;
    for (const field of avsFieldParams(node.inspection, path)) {
      out.push({
        descriptor: field.descriptor,
        accessor: {
          get: () => {
            const live = avsEditorModel ? findAvsEditorNode(avsEditorModel, path) : null;
            return live ? field.read(live.inspection) : field.descriptor.defaultValue;
          },
          set: (value) => {
            void applyAvsFieldPatch(path, field.patch(value)).catch((error: unknown) => {
              console.error('[aaavs] AVS param write failed:', error);
            });
          },
        },
      });
    }
    collectAvsParams(node.children, out);
  }
}

function syncAvsParams(): void {
  const entries: ParamEntry[] = [];
  if (avsEditorModel) collectAvsParams(avsEditorModel.nodes, entries);
  const signature = entries.map((entry) => entry.descriptor.id).join('|');
  if (signature === avsParamSignature) return;
  avsParamSignature = signature;
  avsParamRelease?.();
  avsParamRelease = entries.length ? paramRegistry.registerAll(entries) : null;
}

function activateAvsEditor(parsed: AvsPresetAst, fileName: string, preserveView: boolean): void {
  ui.setPersonalAvsCanAdd(true);
  if (preserveView && avsEditor) {
    avsEditor.setPreset(parsed, fileName.replace(/\.avs$/i, ''));
    return;
  }
  showAvsEditor(parsed, fileName);
}

function showAvsEditor(parsed: AvsPresetAst, fileName: string): void {
  avsEditor?.dispose();
  avsEditorHost = document.createElement('div');
  avsEditorHost.className = 'ui-avs-editor-host';
  ui.setLayerEditor(avsEditorHost);
  avsEditor = new AvsEditor({
    host: avsEditorHost,
    preset: parsed,
    presetName: fileName.replace(/\.avs$/i, ''),
    getNodeState: avsNodeState,
    onSetEnabled: async (component, path, enabled) => {
      if (component.list && avsEditorModel) {
        avsEditorModel = setAvsEditorNodeEnabled(avsEditorModel, path, enabled);
        await loadAvsPreset(serializeAvsEditorModel(avsEditorModel), avsEditorFileName, true);
        return;
      }
      setAvsControl(path, { enabled });
    },
    onSetMuted: (_component, path, muted) => setAvsControl(path, { muted }),
    onSetSoloed: (_component, path, solo) => setAvsControl(path, { solo }),
    onMove: async (_component, path, parentPath, direction) => {
      if (!avsEditorModel) return;
      const siblings = parentPath === null
        ? avsEditorModel.nodes
        : findAvsEditorNode(avsEditorModel, parentPath)?.children ?? [];
      const from = siblings.findIndex((node) => node.path === path);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= siblings.length) return;
      const order = siblings.map((node) => node.path);
      [order[from], order[to]] = [order[to]!, order[from]!];
      avsEditorModel = reorderAvsEditorChildren(avsEditorModel, parentPath, order);
      // Serialized AVS paths are ordinal. A structural edit therefore starts a
      // fresh mixer-control session rather than applying old paths to new nodes.
      avsControls.clear();
      await loadAvsPreset(serializeAvsEditorModel(avsEditorModel), avsEditorFileName, true);
    },
    onSave: saveAvsEditorPreset,
    onAddToBank: addCurrentAvsToPersonalBank,
    // Undo/redo/revert restore the snapshotted bytes exactly (A-crate), not a
    // replay of inverse edits. loadAvsPreset(…, true) keeps the editor and its
    // history, and rebuilds avsEditorModel from the bytes.
    onRestoreBytes: async (bytes) => {
      avsControls.clear();
      await loadAvsPreset(bytes, avsEditorFileName, true);
    },
    onPatchPayload: async (_component, path, payload) => {
      if (!avsEditorModel) return;
      avsEditorModel = patchAvsEditorNodePayload(avsEditorModel, path, payload);
      await loadAvsPreset(serializeAvsEditorModel(avsEditorModel), avsEditorFileName, true);
    },
    // One write path, shared with the registry accessor built by
    // `collectAvsParams`, so an Apply in the form and a bound knob cannot
    // diverge on what patching a field means.
    onPatchFields: (_component, path, patch) => applyAvsFieldPatch(path, patch),
    onError: (error) => console.error('[aaavs] AVS editor action failed:', error),
  });
}

function saveAvsEditorPreset(): void {
  if (!avsEditorModel) return;
  const bytes = serializeAvsEditorModel(avsEditorModel);
  const sourceName = avsEditorFileName.replace(/\.avs$/i, '') || 'preset';
  const safeName = sourceName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  const link = document.createElement('a');
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  link.href = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
  link.download = `${safeName}.edited.avs`;
  link.click();
  requestAnimationFrame(() => URL.revokeObjectURL(link.href));
}

// ---- present ----------------------------------------------------------
// The only pipeline this file still builds. `renderer.execute` returns an HDR
// target and stops; everything about display space — tone map, bloom, vignette,
// grain — belongs to one pass, and this is it.
const presentPipeline = createFullscreenPipeline(gpu, 'present', presentWGSL, gpu.swapFormat);
const postParams = device.createBuffer({
  label: 'post-params', size: 32,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});

/**
 * Present bind groups, cached by the view they point at.
 *
 * The renderer's output is a POOLED target and alternates between two textures
 * as the accumulator ping-pongs, so a single bind group built once would sample
 * the wrong side on half the frames — which is not an error, renders happily,
 * and looks like a one-frame lag. Keyed by view identity rather than rebuilt per
 * frame, because in the steady state there are exactly two of them.
 */
const presentBinds = new Map<GPUTextureView, GPUBindGroup>();

function presentBindFor(view: GPUTextureView): GPUBindGroup {
  const existing = presentBinds.get(view);
  if (existing) return existing;
  const created = device.createBindGroup({
    label: 'present',
    layout: presentPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: view },
      { binding: 1, resource: sampler },
      { binding: 2, resource: { buffer: postParams } },
    ],
  });
  // The pool mints new views whenever a resolution scale changes; without a
  // ceiling this map would hold every one of them alive forever.
  if (presentBinds.size >= 64) presentBinds.clear();
  presentBinds.set(view, created);
  return created;
}

// Not registered in golden mode: a resize mid-capture rebuilds every target and
// clears the accumulator, which silently changes the picture being captured.
if (!golden) {
  window.addEventListener('resize', () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (!resize(gpu, window.innerWidth, window.innerHeight, dpr)) return;
    renderer.resize();
    presentBinds.clear();
  });
}

// ---------------------------------------------------------------- ui
//
// Constructed AFTER `stack.load`, and that ordering is load-bearing:
// `LayerStack.add` seeds new layers from the stack's private seed, which only
// `load` sets. A panel built against an unloaded stack adds layers seeded from 0
// while the preset's own layers are seeded from `preset.seed` — deterministic,
// silent, and visually wrong.

if (!golden) await refreshPersonalAvsBank(false);
const ui = new LayerUI({
  stack,
  preset,
  registry: renderer.types,
  avsPresets: bundledAvsLiveBank.map(({ id, name, collection }) => ({ id, name, collection })),
  onAutoChange(on) {
    const avsActive = avsEditorModel !== null || avsWorkerRenderer?.active || avsRuntime !== null;
    avsLiveDirector.enabled = avsActive && on && activeAvsLiveBank.length > 1;
    director.enabled = !avsActive && on;
    if (avsLiveDirector.enabled && activeAvsCatalogId) {
      const frame = snapshot(audio.currentTime);
      avsLiveDirector.select(activeAvsCatalogId, avsBarPosition(), Math.max(frame.level, frame.beat));
    }
    ui.setAuto(avsActive ? avsLiveDirector.enabled : director.enabled);
  },
  async onTogglePlayback() { await toggleTransport(); },
  onSkipBar(direction) { skipBar(direction); },
  onLoadPreset(next) {
    leaveAvsLane();
    director.enabled = avsLiveDirector.enabled;
    avsLiveDirector.enabled = false;
    ui.setAuto(director.enabled);
    // `loadShowStack` prunes per-layer GPU state for layers the new preset does
    // not have (a feedback pair is 30 MB at 2K). No transition: loading a file
    // is not a musical move, so both windows hard-cut.
    adoptNativePreset(next, null, audio.currentTime, timeline.bpm(audio.currentTime) || tempo.bpm || 120);
  },
  async onPickAvsPreset(id) {
    const entry = bundledAvsLiveBank.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`Unknown bundled AVS preset: ${id}`);
    await loadAvsCatalogEntry(entry, bundledAvsLiveBank);
  },
  ...(loopbackTestHost ? {
    async onRequestLocalAvsPresets() {
      const catalog = await AVS_PRESET_SOURCES.list('local');
      await ensureLocalAvsCatalog();
      return catalog.map(({ id, name, autoEligible }) => ({
        id, name: `${name}${autoEligible === false ? ' · unavailable' : ''}`,
      }));
    },
    async onPickLocalAvsPreset(id: string) {
      await ensureLocalAvsCatalog();
      const entry = await AVS_PRESET_SOURCES.require('local', id);
      if (entry.autoEligible === false) throw new Error(`${entry.name} is unavailable: ${entry.unavailableReason ?? 'parser rejected this preset'}`);
      await loadAvsCatalogEntry(entry, localAvsLiveBank);
    },
  } : {}),
  personalAvsPresets,
  onAddPersonalAvsPreset: addCurrentAvsToPersonalBank,
  async onPickPersonalAvsPreset(id) {
    const entry = personalAvsLiveBank.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`Unknown personal AVS preset: ${id}`);
    await loadAvsCatalogEntry(entry, personalAvsLiveBank);
  },
  async onRemovePersonalAvsPreset(id) {
    const wasPersonalBank = activeAvsLiveBank === personalAvsLiveBank;
    const removedActivePreset = wasPersonalBank && activeAvsCatalogId === id;
    await PERSONAL_AVS_BANK.remove(id);
    AVS_PRESET_SOURCES.invalidate('personal');
    await refreshPersonalAvsBank(true);
    if (removedActivePreset) {
      const replacementBank = personalAvsLiveBank.length ? personalAvsLiveBank : bundledAvsLiveBank;
      const replacement = replacementBank[0];
      if (replacement) await loadAvsCatalogEntry(replacement, replacementBank);
    } else if (wasPersonalBank) {
      avsLiveDirector.setBank(personalAvsLiveBank, activeAvsCatalogId, avsBarPosition());
      ui.setAvsPresetSelection(activeAvsCatalogId, 'personal');
    }
  },
  onImportPersonalAvsBank: importPersonalAvsBank,
  onExportPersonalAvsBank: exportPersonalAvsBank,
  async onLoadAvsPreset(bytes, fileName) {
    const data = bytes.slice();
    const entry: AvsLiveCatalogEntry = {
      id: `import:${fileName}:${data.byteLength}`, name: fileName.replace(/\.avs$/i, ''), fileName,
      load: async () => data.slice(),
    };
    await loadAvsCatalogEntry(entry, [entry]);
  },
  // Fires on EVERY edit, including each step of a slider drag, so it must not do
  // per-edit work. `prune` clears the whole bind-group cache, which is a frame
  // of rebuilds — cheap once, wasteful sixty times a second — so it only runs
  // when the set of layers has actually changed.
  onEdit() {
    // Mirroring is coalesced to one flush per frame for the same reason: a
    // slider drag is sixty edits a second and the projector only needs the
    // last of them. The flush classifies the edit (ShowEditTracker), so a
    // field edit never reloads the projector's stack.
    projectorPresetDirty = true;
    const ids = stack.all.map((l) => l.id).join('|');
    if (ids === knownLayerIds) return;
    knownLayerIds = ids;
    renderer.prune(stack.all.map((l) => l.id));
  },
  // Golden captures keep the panel out of image baselines, except the dedicated
  // UI test, which needs the production layout visibly open for page capture.
  open: !golden || uiTest,
});
const avsLiveDirector = new AvsLiveDirector();
// `activeAvsLiveBank` starts on bundled, so the first bundled selection takes
// the same-bank path in `loadAvsCatalogEntry`. Seed the director explicitly;
// otherwise its private bank stays empty and auto-update can never select.
avsLiveDirector.setBank(bundledAvsLiveBank, '', avsBarPosition());

// The shipped experience is AVS-first. The old AAAVS remix bank remains only
// as an internal renderer fixture for golden/source probes; it is not a second
// user-facing preset system competing with the real AVS catalog.
const useNativeProbeSurface = golden || transitionTest || Boolean(
  ledStyleTest || presetTest || sourceTest || operatorTest || uiTest,
);
if (!useNativeProbeSurface) {
  // Start on a lightweight, authored AVS preset so a high-refresh display can
  // immediately demonstrate that the compatibility path is not capped at 30.
  const initialAvsPreset = bundledAvsLiveBank.find((entry) => entry.name === 'UnConeD - Neon Coaster')
    ?? bundledAvsLiveBank[0];
  const loading = document.createElement('div');
  loading.className = 'ui-avs-loading';
  loading.textContent = initialAvsPreset ? `loading ${initialAvsPreset.name}…` : 'no AVS presets available';
  ui.setLayerEditor(loading);
  if (initialAvsPreset) {
    void loadAvsCatalogEntry(initialAvsPreset, bundledAvsLiveBank).catch((error) => {
      loading.classList.add('is-error');
      loading.textContent = `AVS preset failed to load: ${String(error)}`;
    });
  }
}

// Whole-track exports live in their own full-screen workbench and worker. The
// interactive renderer keeps running independently underneath it, which makes
// closing the studio a presentation action rather than a transport reset.
const offline = golden ? null : createBrowserOfflineStudio();
const offlineLauncher = offline ? document.createElement('button') : null;
if (offlineLauncher && offline) {
  offlineLauncher.type = 'button';
  offlineLauncher.textContent = 'OFFLINE RENDER';
  offlineLauncher.title = 'Open sample-clock offline render studio (R)';
  offlineLauncher.setAttribute('aria-label', 'Open offline render studio');
  offlineLauncher.style.cssText = [
    'position:fixed', 'right:1rem', 'bottom:1rem', 'z-index:20',
    'padding:.65rem .85rem', 'border:1px solid rgba(66,216,238,.55)',
    'border-radius:3px', 'background:rgba(5,10,16,.88)', 'color:#42d8ee',
    'font:700 10px/1 ui-monospace,"Cascadia Mono",Consolas,monospace',
    'letter-spacing:.12em', 'cursor:pointer', 'backdrop-filter:blur(10px)',
  ].join(';');
  offlineLauncher.addEventListener('click', () => offline.studio.open());
  document.body.append(offlineLauncher);
}

// ------------------------------------------------------------ live params
//
// One registry, three surfaces. `src/params/` holds the declaration of every
// live parameter — label, kind, range, step, unit, group — and this block is
// where those declarations get their plumbing. The MIDI mapping panel
// (`src/input/`), the step lane's target dropdown (`src/sequencer/`) and the
// AVS inspector's parameter form (`src/avs-editor.ts`) all read that one list,
// so a parameter declared once appears in all three without any of them being
// touched. Before this, the same knob's range was written out three times and
// the three copies were free to disagree in silence.
//
// What the registry is allowed to touch is what is registered below and
// nothing else — there is no reflection into the layer graph, so a stray CC
// cannot reach a parameter nobody deliberately declared.
//
// Every accessor calls the SAME function the keyboard calls. A pad bound to
// "next preset" therefore respects the AVS load guard, the director's bar
// anchoring and the AVS/native lane split for free, because it is not a second
// implementation of any of that.
//
// Seeded, because `Math.random()` is banned engine-wide (§4.7, rng.ts). A pad
// that picks a preset is still reproducible: the same sequence of presses in
// the same order produces the same show.
const presetRng = new Rng(0x51de5eed);

/**
 * The plumbing half of a global parameter. Every member already existed; this
 * interface only names the subset `src/params/globals.ts` is allowed to use.
 */
const paramHost: ParamHost = {
  patchParams: (type, patch) => patchParams(type, patch),
  readParam: (type, key, fallback) => readParam(type, key, fallback),
  post,
  toggleKaleidoscopeMix: () => toggleKaleidoscopeMix(),
  toggleAutoPresets: () => toggleAutoPresets(),
  stepPreset: (direction) => stepPreset(direction),
  randomPreset: () => randomPreset(),
  toggleTransport: () => { void toggleTransport(); },
  skipBar: (direction) => skipBar(direction),
};
paramRegistry.registerAll(globalParamEntries(paramHost));

// Golden captures get no input surface: the panel injects a stylesheet and the
// OSC client opens a socket, and neither belongs in a deterministic capture.
const inputBus = golden ? null : createInputBus(paramRegistry, { isAvsLaneActive: avsLaneActive });

// ---------------------------------------------------------------- step grid
//
// The 16-step lane rides the SAME musical clock everything else does: it owns a
// `Scheduler` polled on the `1/16` division against the same `Timeline` and the
// same audio-clock `t` as the layer requests. There is no second clock here.
//
// A step does not do anything new. It resolves to a parameter id from the same
// registry the MIDI panel lists and goes out through `InputMappings.dispatch` —
// byte for byte the call a bound MIDI note makes — so a lane firing "next
// preset" respects the AVS load guard and the AVS/native lane split for the
// same reason a pad does.
const sequencer: Sequencer | null = inputBus ? createSequencer({
  registry: paramRegistry,
  dispatcher: inputBus.mappings,
  defaultTarget: REST_PARAM_ID,
  isAvsLaneActive: avsLaneActive,
}) : null;
// Native-only targets are greyed out while the AVS lane is live. Both calls
// are cheap no-ops while their panel is closed.
laneAvailabilityRefresh = () => {
  sequencer?.refreshLaneAvailability();
  inputBus?.panel.refreshLaneAvailability();
};
notifyLaneChanged();

// ---------------------------------------------------------------- projector
//
// The second window. It renders the show and nothing else, so it can be dragged
// to a projector and fullscreened without any of this window's furniture
// following it there.
//
// It runs its OWN GPU device, because a `GPUDevice` and a configured
// `GPUCanvasContext` cannot cross a browsing context. The reasoning for that
// shape — and for rejecting the captureStream/WebRTC alternative — is written
// out at the top of `link.ts` rather than here, because it is a property of the
// link, not of this file.
//
// What this block owns is the CONTROL side of that arrangement: opening the
// window, answering its hello with the complete current state, mirroring every
// change as it happens, and making it obvious in here where the output went.
// Nothing below sends anything while no projector is listening: `projectorSend`
// is a no-op then, which matters because `postMessage` still pays for a full
// structured clone whether or not anybody is on the other end.

/** Send only when a projector is actually listening. Otherwise free. */
function projectorSend(message: LinkMessage): void {
  if (!projectorLink?.peerLive) return;
  projectorLink.post(message);
}

/**
 * Everything a freshly opened (or freshly reloaded) projector needs.
 *
 * Sent in response to its `hello`, and it must be the WHOLE state rather than a
 * request for one: the projector cannot ask for "the preset" without knowing
 * which lane is live, and a set is not the moment to negotiate.
 */
function sendProjectorState(): void {
  if (!projectorLink) return;
  projectorLink.post({
    kind: 'preset',
    preset: wirePreset(preset, stack),
    transition: null,
    at: audio.currentTime,
    bpm: timeline.bpm(audio.currentTime) || tempo.bpm || 120,
  });
  projectorLink.post({ kind: 'mixer', mixer: stack.mixerSnapshot() });
  // Before any avs-load, so the projector builds its worker on the right lane.
  projectorLink.post({ kind: 'render-settings', gpuLane: avsGpuLane });
  // The projector now holds exactly this stack, whatever edits were pending.
  showEdits.rebase(stack);
  projectorPresetDirty = false;
  if (avsLiveBytes) {
    projectorLink.post({ kind: 'avs-load', bytes: avsLiveBytes, fileName: avsLiveFileName });
    projectorLink.post({ kind: 'avs-controls', controls: [...avsControls.values()] });
  } else {
    projectorLink.post({ kind: 'avs-clear' });
  }
}

const projectorFrame = golden ? null : createLinkAudioFrame();

/**
 * One packed audio frame per rAF, plus any coalesced preset edit.
 *
 * Called from `renderFrame` ABOVE the AVS early return, so the projector is fed
 * in both lanes. The packed frame is a single reused `Float32Array` — see
 * `link.ts` for what is in it and why the spectrogram is not.
 */
function publishProjectorFrame(a: AudioSnapshot, state: LinkFrameState): void {
  if (!projectorLink?.peerLive || !projectorFrame) return;
  // Never flush the native preset while the AVS lane is live. The projector's
  // `preset` handler leaves the AVS lane before it loads the native stack — it
  // has to, because a preset change IS how this window leaves that lane — so a
  // bare flush here (any panel click sets the dirty bit, and the panel stays
  // usable during AVS) would drop the projector out of AVS while this window
  // stays in it, and nothing would ever put it back. The native stack is
  // invisible under AVS anyway; the bit is held until the lane is native again.
  if (projectorPresetDirty && !avsLaneActive()) {
    projectorPresetDirty = false;
    // Structural edits (a layer added, removed, reordered or rebuilt) reload
    // the projector's stack, so mute/solo follow them; a field edit goes in
    // place and leaves the projector's triggers and feedback trails alone.
    const edit = showEdits.take(stack);
    if (edit.kind === 'structural') {
      projectorLink.post({ kind: 'preset', preset: wirePreset(preset, stack), transition: null, at: a.time, bpm: state.bpm });
      projectorLink.post({ kind: 'mixer', mixer: edit.mixer });
    } else if (edit.kind === 'fields') {
      if (edit.fields.length) projectorLink.post({ kind: 'layer-fields', fields: edit.fields });
      if (edit.mixer) projectorLink.post({ kind: 'mixer', mixer: edit.mixer });
    }
  }
  packLinkAudioFrame(projectorFrame, a, post, state);
  projectorLink.post({ kind: 'audio', frame: projectorFrame });
}

const projectorButton = golden ? null : document.createElement('button');
let projectorWindow: Window | null = null;

/**
 * Dim this window's stage while the projector holds the output.
 *
 * Not hidden: a black control window looks broken, and the operator still needs
 * to see what is playing to drive it. Dimmed and labelled is the honest state —
 * "this is a monitor now, the show is over there".
 */
function setProjectorPresenting(live: boolean): void {
  // Also caps this window's AVS dispatch to AVS_MONITOR_FPS, so the dimmed
  // monitor does not compete with the projector's own worker and GPU device.
  projectorPresenting = live;
  canvas.style.opacity = live ? '0.3' : '';
  avsCanvas.style.opacity = live ? '0.3' : '';
  if (!projectorButton) return;
  projectorButton.textContent = live ? 'PROJECTOR ●' : 'PROJECTOR';
  projectorButton.style.color = live ? '#ff3d81' : '#42d8ee';
  projectorButton.style.borderColor = live ? 'rgba(255,61,129,.55)' : 'rgba(66,216,238,.55)';
  projectorButton.title = live
    ? 'Output is on the projector window — click to focus it'
    : 'Open the output-only projector window (O)';
}

function openProjector(): void {
  if (!projectorLink) return;
  if (projectorWindow && !projectorWindow.closed) {
    projectorWindow.focus();
    return;
  }
  // A named window, so pressing O twice reuses the one that is already open
  // even after this window has reloaded and lost the handle.
  projectorWindow = window.open(
    'projector.html',
    'aaavs-projector',
    'popup=yes,noopener=no,width=1280,height=720',
  );
  if (!projectorWindow) {
    console.warn('[aaavs] the projector window was blocked. Allow pop-ups for this origin.');
    if (projectorButton) projectorButton.title = 'Pop-up blocked — allow pop-ups for this origin';
  }
}

if (!golden) {
  projectorLink = new Link({
    role: 'control',
    onMessage(message) {
      // A projector only ever announces itself; everything else flows outward.
      if (message.kind === 'hello') sendProjectorState();
    },
    onPeerChange: setProjectorPresenting,
  });
  // A projector left open across a reload of THIS window is still there and
  // still rendering the old state. Announce so it re-asks for the new one.
  projectorLink.announce();
}

// Two persisted live settings, visible rather than buried in a key: flash
// limiting for this window, and the approximate-GPU opt-in (both windows).
const flashButton = golden ? null : document.createElement('button');
const gpuLaneButton = golden ? null : document.createElement('button');
const FLASH_LABELS: Readonly<Record<FlashMode, string>> = { limit: 'FLASH LIMIT', strict: 'FLASH STRICT', off: 'FLASH OFF' };

function refreshSettingsButtons(): void {
  if (flashButton) {
    flashButton.textContent = FLASH_LABELS[flashMode];
    flashButton.setAttribute('aria-label', `Flash limiting in this window: ${flashMode}. Click to change.`);
    flashButton.title = flashMode === 'off'
      ? 'Flash limiting is OFF in this window (the projector is always limited)'
      : `Flash limiting: ${flashMode} (the projector is always limited). Click to cycle limit / strict / off.`;
    flashButton.style.color = flashMode === 'off' ? '#ff3d81' : '#42d8ee';
  }
  if (gpuLaneButton) {
    const approximate = avsGpuLane === '120';
    gpuLaneButton.textContent = approximate ? 'GPU APPROX' : 'GPU EXACT';
    gpuLaneButton.setAttribute('aria-pressed', String(approximate));
    gpuLaneButton.setAttribute('aria-label', 'Approximate GPU effects (120 lane)');
    gpuLaneButton.title = approximate
      ? 'Approximate GPU effects ON: faster, not bit-exact with Winamp AVS. Click for exact.'
      : 'Exact AVS output (default). Click to allow approximate GPU effects for speed.';
    gpuLaneButton.style.color = approximate ? '#ff3d81' : '#42d8ee';
  }
}

function styleCornerButton(button: HTMLButtonElement, bottom: string): void {
  button.type = 'button';
  button.style.cssText = [
    'position:fixed', 'right:1rem', `bottom:${bottom}`, 'z-index:20',
    'padding:.65rem .85rem', 'border:1px solid rgba(66,216,238,.55)',
    'border-radius:3px', 'background:rgba(5,10,16,.88)', 'color:#42d8ee',
    'font:700 10px/1 ui-monospace,"Cascadia Mono",Consolas,monospace',
    'letter-spacing:.12em', 'cursor:pointer', 'backdrop-filter:blur(10px)',
  ].join(';');
}

if (flashButton) {
  styleCornerButton(flashButton, '6.8rem');
  // FLASH_MODES is off, limit, strict: the cycle runs limit -> strict -> off -> limit.
  flashButton.addEventListener('click', () => setFlashMode(nextInCycle(FLASH_MODES, flashMode)));
  document.body.append(flashButton);
}
if (gpuLaneButton) {
  styleCornerButton(gpuLaneButton, '9.7rem');
  gpuLaneButton.addEventListener('click', () => setAvsGpuLane(avsGpuLane === '120' ? 'exact' : '120'));
  document.body.append(gpuLaneButton);
}
refreshSettingsButtons();

if (projectorButton) {
  projectorButton.type = 'button';
  projectorButton.textContent = 'PROJECTOR';
  projectorButton.setAttribute('aria-label', 'Open the output-only projector window');
  projectorButton.title = 'Open the output-only projector window (O)';
  projectorButton.style.cssText = [
    'position:fixed', 'right:1rem', 'bottom:3.9rem', 'z-index:20',
    'padding:.65rem .85rem', 'border:1px solid rgba(66,216,238,.55)',
    'border-radius:3px', 'background:rgba(5,10,16,.88)', 'color:#42d8ee',
    'font:700 10px/1 ui-monospace,"Cascadia Mono",Consolas,monospace',
    'letter-spacing:.12em', 'cursor:pointer', 'backdrop-filter:blur(10px)',
  ].join(';');
  projectorButton.addEventListener('click', openProjector);
  document.body.append(projectorButton);
}

// ---------------------------------------------------------------- frame

const f32 = new Float32Array(8);
let last = performance.now();
let frames = 0;
let fpsAcc = 0;
let fps = 0;
let frameCount = 0;
let peakLevel = 0;

/** The frame's audio, read ONCE and passed down (contracts.ts, `AudioSnapshot`). */
function snapshot(t: number): AudioSnapshot {
  const realtime = detector.attached ? detector.features : null;
  return {
    time: t,
    level: realtime?.level ?? audio.level,
    beat: detector.attached ? detector.beat : audio.beat,
    bands: realtime?.bands ?? audio.bands,
    pan: realtime?.pan ?? audio.pan,
    width: realtime?.width ?? audio.width,
    crest: realtime?.crest ?? audio.crest,
    centroid: realtime?.centroid ?? audio.centroid,
    flatness: realtime?.flatness ?? audio.flatness,
    perceptualBands: realtime?.perceptualBands ?? audio.perceptualBands,
    perceptualFlux: realtime?.perceptualFlux ?? audio.perceptualFlux,
    waveform: audio.waveform,
    spectrum: audio.spectrum,
    bandPan: audio.bandPan,
    spectrogram: audio.spectrogram,
    spectrogramRow: audio.spectrogramRow,
    peaks: audio.peaks,
  };
}

/** Keep readouts cheap in the AVS lane while audio analysis still runs every rAF. */
function updateFrameReadout(
  a: AudioSnapshot,
  t: number,
  bpm: number,
  transportBeats: number,
  dt: number,
  presented: boolean,
): void {
  fpsAcc += dt;
  if (presented) frames++;
  let refreshHud = false;
  if (fpsAcc >= 0.5) {
    fps = frames / fpsAcc;
    frames = 0;
    fpsAcc = 0;
    refreshHud = true;
  }
  if (refreshHud) updateHud(t, bpm);

  // During AVS cadence skips these values cannot have changed enough to merit
  // DOM work. A paused lane still refreshes on the half-second HUD heartbeat.
  if (presented || refreshHud) {
    ui.update({
      bpm, locked: tempo.locked, confidence: timeline.confidence, beats: transportBeats,
      playing: audio.isPlaying, canControl: audio.canTransport,
    } satisfies TransportReadout);
  }

  if (overlay.visible && (presented || refreshHud)) {
    frameRecorder.readout(rumReadout);
    overlay.setFlashStatus(latestFlash);
    overlay.draw({
      audio: a,
      flux: detector.attached ? detector.features.flux : audio.debugFlux,
      threshold: detector.attached ? detector.features.thresh : audio.debugThresh,
      timings: timer.timings,
      bpm,
      tempoLocked: tempo.locked,
      confidence: timeline.confidence,
      fps,
      sampleRate: audio.ctx?.sampleRate ?? 48000,
    });
  }
}

function frame(nowMs: number): void {
  try {
    renderFrame(nowMs);
  } catch (e) {
    if (harness) { goldenFail(e); return; }
    throw e;
  }
}

function renderFrame(nowMs: number): void {
  // rAF time is used ONLY for the frame delta and for FPS. Every musical
  // decision below reads the audio clock instead (§4.6). In golden mode even the
  // delta is fixed, because a chaotic system integrated at a variable step is
  // not reproducible.
  const wallDt = harness ? harness.dt : Math.max(0, (nowMs - last) / 1000);
  const dt = harness ? harness.dt : Math.min(wallDt, 1 / 20);
  last = nowMs;
  // Display refresh for the AVS governors (budget and vsync-divisor cadence).
  // Pacing only; it feeds nothing musical.
  if (!harness) {
    const hz = avsDisplayRate.tick(nowMs);
    avsGovernor.setDisplayHz(hz);
    avsFallbackGovernor.setDisplayHz(hz);
    frameRecorder.setDisplayHz(hz ?? 0);
  }

  // Re-read EVERY frame. Output latency is 5-40 ms typically, far worse on
  // Bluetooth, and it changes at runtime when the output device does (§4.6).
  scheduler.outputLatency = audio.ctx?.outputLatency ?? 0;

  let a: AudioSnapshot;
  let t: number;
  if (harness) {
    t = harness.time;
    a = harness.audio;
    for (const o of harness.audio.onsets) {
      tempo.addOnset(o.time);
      onsetCounts[o.klass] = (onsetCounts[o.klass] ?? 0) + 1;
    }
  } else {
    audio.update(dt);
    detector.poll(dt);
    t = audio.currentTime;
    a = snapshot(t);
  }

  // ONE tracker advance per frame. `TierBTimeline.update()` calls
  // `tempo.update()` internally.
  tierB.update(t);

  // Musical time. Falls back to 120 BPM before lock so motion never stalls.
  const tlBpm = timeline.bpm(t);
  const bpm = resolveTempoBpm(tlBpm, tempo.bpm);
  const transportDt = audio.isPaused && !harness ? 0 : dt;
  const dBeats = transportDt / (60 / bpm);

  // --- the director. Preset changes land ON a phrase boundary, scheduled the
  // same way layers are (§4.3), never reacted to. Off by default: nothing
  // should start rearranging itself unasked.
  director.outputLatency = scheduler.outputLatency;
  sequencer?.setOutputLatency(scheduler.outputLatency);
  transition.update(t);
  if (!transition.active && outgoingFrame) {
    renderer.releaseTarget(outgoingFrame);
    outgoingFrame = null;
  }
  {
    // Energy gates the pick, so a quiet lab preset does not land on a drop.
    // `level` is a stand-in until the tension score exists (§6).
    // `beat` is the detector's decaying onset envelope, available on both the
    // live and synthetic AudioSnapshot paths. It is the portable impact signal
    // the director needs; onset objects stay owned by the tempo subsystem.
    const avsActive = avsEditorModel !== null || avsWorkerRenderer?.active || avsRuntime !== null;
    // PRECEDENCE: the step grid outranks both automatic directors.
    //
    // A written rhythm and a dwell timer are two answers to the same question,
    // and letting both answer means the grid's cut on step 5 gets overwritten
    // by the director's cut half a bar later — which reads as the grid being
    // broken, not as two features cooperating. So: if any enabled lane points
    // at a preset-changing target AND has at least one step on, the automatic
    // directors are not polled at all this frame. A lane parked on `rest`, or
    // written but with every step off, yields; the performer gets automatic
    // changes back by clearing the lane or stopping the grid, without having to
    // find a second switch.
    //
    // The AVS director does not go stale while it is held off: every
    // grid-fired change runs through `loadAvsCatalogEntry`, which calls
    // `avsLiveDirector.select(...)` and re-arms the dwell from the current bar.
    // So when the grid stops owning presets the director resumes from the last
    // change the grid made, not from a boundary it planned bars ago.
    const gridOwnsPresets = sequencer?.lanes.ownsPresetChanges ?? false;
    if (avsActive) {
      if (!gridOwnsPresets && !avsLiveLoadGuard.busy) {
        const selected = avsLiveDirector.update(avsBarPosition(t), a.level, a.beat);
        const entry = selected && activeAvsLiveBank.find((candidate) => candidate.id === selected.id);
        if (entry) {
          void loadAvsCatalogEntry(entry, activeAvsLiveBank, true).catch((error) => {
            console.error('[aaavs] responsive AVS auto switch failed:', error);
          });
        }
      }
    } else if (!gridOwnsPresets) {
      const change = director.update(timeline, t, a.level, a.beat);
      if (change) applyPreset(change.preset, change.transition, t, bpm);
    }
  }

  // Golden-only transition smoke test. It starts after a few rendered frames so
  // the outgoing texture is real content, not the initial cleared accumulator.
  if (transitionTest && frameCount === 108) {
    applyPreset(PRESET_BANK[1]!.preset, { kind: 'crossfade', beats: 8, curve: 'equalPower' }, t, bpm);
  }

  // --- the scheduler. Fires AHEAD so the visual peaks on the beat. --------
  for (const req of requests) {
    for (const ev of scheduler.due(timeline, t, req)) {
      stats.scheduledEvents++;
      stats.lateBy = ev.lateBy;
    }
  }
  // The step grid, on the same poll, from the same clock. Deliberately AFTER
  // the director block: a step that changes preset must win against a decision
  // the director already declined to make this frame, not race it.
  sequencer?.update(timeline, t);

  void scheduler.content(timeline, lastPoll, t);
  lastPoll = t;

  // Peak-hold for the readout. An instantaneous level sampled twice a second
  // reads 0.00 almost always.
  peakLevel = Math.max(a.level, peakLevel - dt * 0.9);

  // --- the layer stack ---------------------------------------------------
  const nowBeats = timeline.slotAt(t) / SLOTS_PER_BEAT;
  const transportBeats = tlBpm > 0 ? nowBeats : t * bpm / 60;

  // --- the projector, if one is open -------------------------------------
  // Deliberately ABOVE the AVS early return, for the same reason the audio and
  // scheduling work is: the second window must be fed in BOTH lanes, and the
  // shipped default is the AVS one. Below the branch this would be dead code in
  // ordinary use.
  publishProjectorFrame(a, {
    bpm,
    beats: nowBeats,
    dtBeats: dBeats,
    dtSeconds: transportDt,
    frameIndex: frameCount,
    playing: audio.isPlaying,
    paused: audio.isPaused,
  } satisfies LinkFrameState);

  // Imported AVS is a CPU compatibility lane displayed by its own canvas. Do
  // not render the fully obscured native WebGPU stack underneath it. Crucially,
  // this branch is AFTER audio polling, tempo and scheduling: lowering visual
  // cadence must never lower audio-analysis cadence or alter the audio clock.
  if ((avsWorkerRenderer?.active || avsRuntime) && !harness) {
    // A new vsync: present the newest completed worker frame (closing any it
    // superseded), then let the worker take the next one.
    avsDispatchedThisVsync = false;
    const workerPresented = presentAvsWorkerFrame(nowMs);
    const submitted = !audio.isPaused && renderAvsPreset(a, nowMs);
    const presented = avsWorkerRenderer?.active ? workerPresented : submitted;
    if (presented) {
      frameCount++;
      // Delivered AVS frames only: a rAF tick with no new frame is not a frame.
      frameRecorder.frame(nowMs);
      frameRecorder.markPresented(performance.now());
    }
    updateFrameReadout(a, t, bpm, transportBeats, wallDt, presented);
    requestAnimationFrame(frame);
    return;
  }

  stack.update(nowBeats);
  const framed = stack.frame(nowBeats);
  plan = framed.plan;

  timer.beginFrame();
  const encoder = device.createCommandEncoder();

  // `applyPreset` has already swapped the data stack, but the renderer's HDR
  // accumulator still holds the last fully rendered outgoing frame. Copy it
  // before the incoming stack reuses that ping-pong target.
  if (captureOutgoing) {
    if (outgoingFrame) renderer.releaseTarget(outgoingFrame);
    outgoingFrame = renderer.captureOutput(encoder);
    captureOutgoing = false;
  }

  // Audio -> GPU, before any encoder work reads it.
  audioGpu.upload(a, device.queue);

  // --- the whole picture -------------------------------------------------
  // Every pass, in the order `planStack` chose. There is nothing else here and
  // there must not be: a special case at this level is a layer the preset does
  // not describe and the UI cannot edit.
  const frameState: FrameState = {
    resolved: framed.resolved,
    audio: a,
    palette: preset.palette,
    time: t,
    beats: nowBeats,
    bpm,
    dtBeats: dBeats,
    dtSeconds: transportDt,
    frame: frameCount,
  };
  let output = renderer.execute(encoder, plan, frameState);
  if (transition.active && outgoingFrame && needsBothChains(transition.kind)) {
    const composite = renderer.transition(
      encoder, outgoingFrame, output, transition.current, transition.mix, transition.seed, frameState,
    );
    output = composite;
    // This transient is only sampled by the present pass below, so it may return
    // to the pool once that pass has been encoded.
    renderer.releaseTarget(composite);
  }

  // --- present: tone map to the swapchain --------------------------------
  const aspect = gpu.width / gpu.height;
  f32.set([post.bloom, post.exposure, post.vignette, aspect, post.grain, t, 0, 0]);
  device.queue.writeBuffer(postParams, 0, f32);
  {
    const pass = timer.beginPass(encoder, gpu.context.getCurrentTexture().createView(), 'present', 'clear');
    pass.setPipeline(presentPipeline);
    pass.setBindGroup(0, presentBindFor(output.view));
    pass.draw(3);
    timer.endPass(pass);
  }

  // Must be the last thing on the encoder: it resolves the query set and copies
  // it out, and a pass encoded after it would not be in the copy.
  timer.endFrame(encoder);
  device.queue.submit([encoder.finish()]);
  // After the submit, never before.
  timer.poll();
  frameCount++;
  if (!harness) {
    frameRecorder.frame(nowMs);
    frameRecorder.markPresented(performance.now());
    if (timer.enabled && timer.timings.length) frameRecorder.recordGpu(timer.totalMs);
  }

  // --- hud ---------------------------------------------------------------
  updateFrameReadout(a, t, bpm, transportBeats, wallDt, true);

  if (harness) {
    harness.advance();
    // Stopping the loop BEFORE awaiting the capture is load-bearing: a WebGPU
    // canvas holds its contents only until the next `getCurrentTexture()`.
    if (harness.done) { void harness.capture(device, canvas); return; }
  }

  requestAnimationFrame(frame);
}

let avsHudRendered = 0;
let avsHudAtMs = 0;
/** Worker frames completed per second since the last HUD refresh (presented + superseded). */
function avsHudRenderedFps(worker: AvsWorkerRenderer): number {
  const now = performance.now();
  const rendered = worker.renderedFrames;
  const elapsed = now - avsHudAtMs;
  const rate = avsHudAtMs > 0 && elapsed > 0 && rendered >= avsHudRendered
    ? (rendered - avsHudRendered) * 1000 / elapsed
    : 0;
  avsHudRendered = rendered;
  avsHudAtMs = now;
  return rate;
}

/** Worker GPU timestamp telemetry for the HUD: empty when the device has no timestamp-query. */
function avsWorkerGpuLabel(worker: AvsWorkerRenderer): string {
  const gpuPart = worker.gpuMs !== undefined
    ? ` · gpu ${worker.gpuMs.toFixed(2)}ms${worker.gpuLatencyMs !== undefined ? ` (+${worker.gpuLatencyMs.toFixed(0)}ms readback)` : ''}`
    : '';
  return gpuPart + (worker.gpuError ? ` · GPU error: ${worker.gpuError}` : '');
}

/** The honest quality line: what the raster, upscale and cadence actually are. */
function avsDisplayLabel(governor: AvsFrameGovernor): string {
  const s = avsDisplaySettings;
  const raster = s.resolution === 'high'
    ? `high ${governor.tier.scale}x (floor classic)`
    : s.resolution === 'crisp' ? 'crisp integer-fit' : 'classic';
  const hz = governor.measuredDisplayHz;
  const cadence = s.frameRate === 'display' ? 'display' : `${s.frameRate} fps lock`;
  const every = hz ? ` = every ${Math.round(governor.renderIntervalMs * hz / 1000)} vsync @ ${hz.toFixed(0)} Hz` : '';
  return `AVS raster ${raster} [V] · upscale ${s.upscale} [U] · cadence ${cadence}${every} [F]`
    + ` · GPU ${avsGpuLane === '120' ? 'approx (120)' : 'exact'} · flash ${flashMode}${flashGate.available ? '' : ' (unavailable)'}`
    + (projectorPresenting ? ` · monitor capped ${AVS_MONITOR_FPS} fps` : '');
}

function updateHud(t: number, bpm: number): void {
  const avsActive = Boolean(avsWorkerRenderer?.active || avsRuntime);
  // The real raster from the worker's message: the canvas itself may be prescaled.
  const avsWidth = avsWorkerRenderer?.active ? avsWorkerRenderer.lastWidth || '–' : avsRuntime?.framebuffer.width;
  const avsHeight = avsWorkerRenderer?.active ? avsWorkerRenderer.lastHeight || '–' : avsRuntime?.framebuffer.height;
  const avsRenderedFps = avsWorkerRenderer?.active ? avsHudRenderedFps(avsWorkerRenderer) : null;
  const lock = tempo.locked
    ? `${tempo.bpm.toFixed(1)} BPM · ${(timeline.confidence * 100) | 0}%`
    : tempo.bpm > 0
      ? `${tempo.bpm.toFixed(1)} BPM · reacquiring beat phase`
      : `listening… (assuming ${bpm})`;
  const det = detector.attached
    ? `worklet · ring ${ringAvailable()} · dropped ${detector.dropped}`
    : (detectorError ? 'rAF fallback (worklet failed)' : 'rAF (worklet not attached)');
  const bold = (value: unknown): HTMLElement => {
    const node = document.createElement('b');
    node.textContent = String(value);
    return node;
  };
  const lines: (string | Node)[][] = [
    [
      bold(`${fps.toFixed(0)} fps`),
      ` · ${avsActive ? `${avsWidth}×${avsHeight} AVS` : `${gpu.width}×${gpu.height}`}`,
      ...(harness ? [' · ', bold('GOLDEN')] : []),
    ],
    ['preset ', bold(avsActive ? `${avsPresetName} (AVS compatibility)` : preset.name), ` · ${avsActive ? 'legacy ordered graph' : `${stack.length} layers`} · auto `, bold((avsActive ? avsLiveDirector.enabled : director.enabled) ? 'on' : 'off'), ` (${director.dynamic ? `${director.minBars}–${director.maxBars}bar responsive` : `${director.every}bar`})`],
    ...(avsActive ? [[
      `AVS ${avsLastRenderMs.toFixed(1)}ms · ${avsWorkerRenderer?.active ? `${avsWorkerRenderer.presenter} · GPU effects ${avsWorkerRenderer.gpuEffectPasses} · present ${avsWorkerRenderer.lastPresentMs.toFixed(2)}ms${avsWorkerGpuLabel(avsWorkerRenderer)} · rendered ${avsRenderedFps!.toFixed(0)} fps` : `CPU fallback · quality ${avsFallbackGovernor.qualityIndex + 1}/${AVS_QUALITY_TIERS.length}`} · unsupported records `,
      bold(avsUnsupported),
    ], [avsDisplayLabel(avsWorkerRenderer?.active ? avsGovernor : avsFallbackGovernor)]] : []),
    ['tempo ', bold(lock), ` · horizon ${timeline.horizonSec.toFixed(2)}s`],
    [`slot ${timeline.slotAt(t).toFixed(0)} · scheduled ${stats.scheduledEvents} · late ${(stats.lateBy * 1000).toFixed(1)}ms`],
    [`audio clock ${t.toFixed(2)}s · level ${peakLevel.toFixed(2)}`],
    ['detector ', bold(det)],
    [`onsets k${onsetCounts.kick} s${onsetCounts.snare} h${onsetCounts.hat} t${onsetCounts.tonal}`],
    [`passes ${plan.passCount} · targets ${plan.targetCount}/${renderer.targetCount}`],
    [`gpu ${timer.enabled ? `${timer.totalMs.toFixed(2)}ms` : 'no timestamp-query'}`],
    ['isolated: ', bold(self.crossOriginIsolated), ' · SAB: ', bold(typeof SharedArrayBuffer !== 'undefined')],
    ...(presetError ? [['preset: ', bold(presetError)]] : []),
  ];
  const fragment = document.createDocumentFragment();
  lines.forEach((parts, index) => {
    if (index > 0) fragment.append(document.createElement('br'));
    for (const part of parts) fragment.append(typeof part === 'string' ? document.createTextNode(part) : part);
  });
  hud.replaceChildren(fragment);
}

requestAnimationFrame(frame);

// Browsers normally dispose an AudioContext with its document, but an in-app
// browser can retain a document briefly while its tab animation completes.
// Tear down the graph explicitly so a looping file or scheduled test click can
// never survive that close/navigation boundary.
let pageDisposed = false;
function disposePage(): void {
  if (pageDisposed) return;
  pageDisposed = true;
  detector.detach();
  audio.dispose();
  avsWorkerRenderer?.dispose();
  offline?.dispose();
  inputBus?.dispose();
  sequencer?.dispose();
  paramRegistry.dispose();
  // `bye` first, so a projector on a second display stops waiting out the
  // heartbeat timeout the instant this window is closed on purpose. The
  // projector itself is deliberately NOT closed: an operator who reloads the
  // control window should not have to re-place a window on the wall.
  projectorLink?.dispose();
}
window.addEventListener('pagehide', disposePage, { once: true });
window.addEventListener('beforeunload', disposePage, { once: true });

// Dev handle. An inspectable engine is worth far more than a printed number
// when something is silently zero.
const avsCompatibilityDiagnostics = {
  get workerRenderer(): AvsWorkerRenderer | null { return avsWorkerRenderer; },
  get diagnostics() {
    return avsWorkerRenderer ? {
      active: avsWorkerRenderer.active,
      presenter: avsWorkerRenderer.presenter,
      renderMs: avsWorkerRenderer.lastRenderMs,
      effectMs: avsWorkerRenderer.lastEffectMs,
      uploadMs: avsWorkerRenderer.lastUploadMs,
      encodeSubmitMs: avsWorkerRenderer.lastEncodeSubmitMs,
      gpuMs: avsWorkerRenderer.gpuMs,
      gpuLatencyMs: avsWorkerRenderer.gpuLatencyMs,
      gpuError: avsWorkerRenderer.gpuError,
      mainThreadPresentMs: avsWorkerRenderer.lastPresentMs,
      gpuEffectPasses: avsWorkerRenderer.gpuEffectPasses,
      gpuEffectComponents: avsWorkerRenderer.gpuEffectComponents,
      gpuFusedPointwiseOperations: avsWorkerRenderer.gpuFusedPointwiseOperations,
      gpuEffectPlan: avsWorkerRenderer.gpuEffectPlan,
      width: avsWorkerRenderer.lastWidth,
      height: avsWorkerRenderer.lastHeight,
      renderedFrames: avsWorkerRenderer.renderedFrames,
      supersededFrames: avsWorkerRenderer.supersededFrames,
      displayHz: avsGovernor.measuredDisplayHz,
      tierScale: avsGovernor.tier.scale,
    } : {
      active: false,
      presenter: 'main-thread-cpu' as const,
      renderMs: avsLastRenderMs,
      effectMs: avsLastRenderMs,
      uploadMs: 0,
      encodeSubmitMs: 0,
      mainThreadPresentMs: 0,
      gpuEffectPasses: 0,
      gpuEffectComponents: 0,
      gpuFusedPointwiseOperations: 0,
      gpuEffectPlan: 'main-thread exact CPU fallback',
    };
  },
};
(globalThis as unknown as Record<string, unknown>).__aaavs = {
  audio, tempo, timeline: tierB, scheduler, detector, stack, audioGpu, timer, overlay, renderer, ui, offline, post, gpu,
  input: inputBus,
  sequencer,
  params: paramRegistry,
  projector: {
    open: openProjector,
    get live(): boolean { return projectorLink?.peerLive ?? false; },
    get available(): boolean { return projectorLink?.available ?? false; },
    get avsFileName(): string { return avsLiveFileName; },
  },
  avsCompatibility: avsCompatibilityDiagnostics,
  flash: {
    get mode(): FlashMode { return flashMode; },
    set(mode: FlashMode): void { setFlashMode(parseFlashMode(mode)); },
    get latest(): FlashDecision | null { return latestFlash; },
    get available(): boolean { return flashGate.available; },
  },
  gpuLane: {
    get lane(): AvsFrameGraphLane { return avsGpuLane; },
    set(lane: AvsFrameGraphLane): void { setAvsGpuLane(lane === '120' ? '120' : 'exact'); },
  },
  /** Delivered-frame recording as JSON, for attaching to a performance report. */
  frameRecording: (): string => frameRecorder.exportJson({
    preset: avsPresetName || preset.name,
    width: avsWorkerRenderer?.lastWidth ?? gpu.width,
    height: avsWorkerRenderer?.lastHeight ?? gpu.height,
    lane: avsLaneActive() ? `avs-${avsGpuLane}` : 'native',
  }),
  avsDisplay: {
    get settings(): AvsDisplaySettings { return avsDisplaySettings; },
    set(patch: Partial<AvsDisplaySettings>): void {
      applyAvsDisplaySettings(parseAvsDisplaySettings(JSON.stringify({ ...avsDisplaySettings, ...patch })), true);
    },
  },
  avsLive: () => ({
    ...avsLiveDirector.diagnostics(),
    barPosition: avsBarPosition(),
    activeCatalogId: activeAvsCatalogId,
    activeBankSize: activeAvsLiveBank.length,
    loadBusy: avsLiveLoadGuard.busy,
  }),
};

// ---------------------------------------------------------------- input

/**
 * Edit a live layer's params in place, by TYPE.
 *
 * The keyboard shortcuts predate the layer graph, and the honest way to keep
 * them is to have them do what the panel does: write the param on whatever
 * layers of that type are in the stack, rather than reach for a global that the
 * preset no longer owns. A stack with no layer of that type simply ignores the
 * key, which is correct — there is nothing to change.
 *
 * `spec` is `readonly` because a spec round-trips to JSON and reordering must
 * not rewrite it. `params` is one of the fields `ui.ts` also mutates in place
 * (its `hotSet`), for the same reason: rebuilding the `Layer` would reset its
 * trigger state and the effect would restart mid-bar.
 */
function patchParams(type: string, patch: Readonly<Record<string, ParamValue>>): void {
  if (!patchLayerParams(stack, type, patch)) return;
  ui.refresh();
  // The patch, not the preset. A knob bound to `kaleido.segments` writes this
  // at MIDI rate, and the projector applies it with the same by-type rule.
  projectorSend({ kind: 'params', type, patch });
}

/** First value of `key` among layers of `type`, or `fallback`. */
function readParam(type: string, key: string, fallback: number): number {
  for (const layer of stack.all) {
    if (layer.spec.type !== type) continue;
    const v = layer.spec.params[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return fallback;
}

/**
 * The three shortcut ACTIONS, lifted out of the keydown handler.
 *
 * They were extracted rather than copied when live input arrived: a MIDI pad
 * that stepped the preset by re-implementing the AVS/native branch would be a
 * second copy of the rule about which director is live, and the two copies
 * would disagree the first time one of them was edited. The keyboard calls
 * these; so does `mappings.ts`. Nothing else changed about what they do.
 */
function avsLaneActive(): boolean {
  return avsEditorModel !== null || avsWorkerRenderer?.active || avsRuntime !== null;
}

function toggleAutoPresets(): void {
  const avsActive = avsLaneActive();
  if (avsActive) {
    avsLiveDirector.enabled = activeAvsLiveBank.length > 1 && !avsLiveDirector.enabled;
    if (avsLiveDirector.enabled && activeAvsCatalogId) {
      const frame = snapshot(audio.currentTime);
      avsLiveDirector.select(activeAvsCatalogId, avsBarPosition(), Math.max(frame.level, frame.beat));
    }
  } else director.enabled = !director.enabled;
  ui.setAuto(avsActive ? avsLiveDirector.enabled : director.enabled);
}

function stepPreset(direction: -1 | 1): void {
  const avsActive = avsLaneActive();
  if (avsActive && activeAvsLiveBank.length > 1 && !avsLiveLoadGuard.busy) {
    const current = Math.max(0, activeAvsLiveBank.findIndex((entry) => entry.id === activeAvsCatalogId));
    const entry = activeAvsLiveBank[(current + direction + activeAvsLiveBank.length) % activeAvsLiveBank.length]!;
    void loadAvsCatalogEntry(entry, activeAvsLiveBank).catch((error) => {
      console.error('[aaavs] manual AVS step failed:', error);
    });
  } else if (!avsActive) {
    const c = director.step(direction, audio.currentTime);
    applyPreset(c.preset, c.transition, audio.currentTime, timeline.bpm(audio.currentTime) || 120);
  }
}

/**
 * Jump to another preset in whichever bank is live.
 *
 * "Random" here means "not the one already showing" — a random pick that can
 * repeat reads as a dead pad, and on a four-preset bank it repeats a quarter of
 * the time. The native lane gets there through `director.step` with a random
 * non-zero delta rather than a new API, because `step` is already the call that
 * moves by hand WITHOUT disturbing the automatic cycle's determinism.
 */
function randomPreset(): void {
  const avsActive = avsLaneActive();
  if (avsActive) {
    if (activeAvsLiveBank.length < 2 || avsLiveLoadGuard.busy) return;
    const others = activeAvsLiveBank.filter((entry) => entry.id !== activeAvsCatalogId);
    const pool = others.length ? others : activeAvsLiveBank;
    void loadAvsCatalogEntry(presetRng.pick(pool), activeAvsLiveBank).catch((error) => {
      console.error('[aaavs] random AVS pick failed:', error);
    });
    return;
  }
  if (director.size < 2) return;
  const delta = 1 + presetRng.int(director.size - 1);
  const c = director.step(delta, audio.currentTime);
  applyPreset(c.preset, c.transition, audio.currentTime, timeline.bpm(audio.currentTime) || 120);
}

function toggleKaleidoscopeMix(): void {
  const mix = readParam('kaleidoscope', 'mix', 0.55);
  patchParams('kaleidoscope', { mix: mix > 0.05 ? 0 : 0.55 });
}

document.addEventListener('dragover', (e) => {
  if (offline?.studio.isOpen()) return;
  e.preventDefault();
});
document.addEventListener('drop', async (e) => {
  if (offline?.studio.isOpen()) return;
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  $('hint').hidden = true;
  try {
    await audio.loadFile(file);
  } catch (loadErr) {
    // Without this the failure is an unhandled rejection: no sound, no message,
    // nothing in the UI. "I dropped a file and nothing happened" is the single
    // least debuggable bug shape there is, so say what went wrong.
    const msg = loadErr instanceof Error ? loadErr.message : String(loadErr);
    const hint = $('hint');
    hint.hidden = false;
    hint.textContent = `Could not play ${file.name}: ${msg}`;
    console.error('[aaavs] file load failed', loadErr);
    return;
  }
  // Reset AFTER decode/play. Decoding can take seconds while the previous
  // source is still audible; resetting before the await let old-song onsets
  // repopulate the fresh tracker, then the new song inherited that evidence
  // and could sit on the 120 pre-lock fallback indefinitely.
  resetTransport(0);
  await ensureDetector();
  // `startedAt` is private, but `currentTime` is defined as ctx.currentTime
  // minus it, so the origin follows from the pair (§4.6).
  detector.timeOrigin = (audio.ctx?.currentTime ?? 0) - audio.currentTime;
  // After the origin, not before: reset() re-empties the worklet's flux ring.
  detector.reset();
});

// --------------------------------------------------------------- first-run guide
// Shown once per browser, then only on demand. Versioned key, so materially
// changing the guide re-shows it to people who already dismissed the old one.
// v2: the photosensitivity warning was added, so everyone sees it once.
const GUIDE_SEEN = 'aaavs.guide.v2';
const guideWrap = $('guideWrap');

function openGuide(): void {
  guideWrap.hidden = false;
  const dlg = $('guide');
  dlg.scrollTop = 0;
  // Focus the dialog, not the button at the bottom: focusing a control scrolls
  // it into view, which opens the guide already scrolled past the content.
  (dlg as HTMLElement).focus({ preventScroll: true });
}

function closeGuide(): void {
  guideWrap.hidden = true;
  try { localStorage.setItem(GUIDE_SEEN, '1'); } catch { /* private mode */ }
}

$('guideClose').addEventListener('click', closeGuide);
$('guideGo').addEventListener('click', closeGuide);
guideWrap.addEventListener('click', (e) => { if (e.target === guideWrap) closeGuide(); });

if (!goldenConfig()) {
  try {
    if (!localStorage.getItem(GUIDE_SEEN)) openGuide();
  } catch {
    // localStorage unavailable. Show it every time rather than never — a
    // repeated dialog beats an undiscoverable app.
    openGuide();
  }
}

window.addEventListener('keydown', (e) => {
  // The guide swallows keys while open, so a shortcut pressed behind a modal
  // cannot silently take effect.
  if (!guideWrap.hidden) {
    if (e.key === 'Escape' || e.key === '?' || e.key === 'Enter') closeGuide();
    return;
  }
  // Backstop for every panel: a key typed into a field (the AVS inspector, the
  // offline studio, the step grid, the input panel, the layer panel) is the
  // field's, never a shortcut. Arrow keys on a slider must not skip a bar and
  // Space in a text box must not pause. Escape still gets out of panels.
  if (isTextEntry(e.target) && e.key !== 'Escape') return;
  // A modifier means the chord belongs to the browser or the OS, not to us.
  // Without this Ctrl+S toggles the step grid *and* opens Chrome's save dialog,
  // and Ctrl+R reloads the page through the offline studio. src/ui.ts:921
  // already guards this way; the two handlers now agree.
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // The offline studio owns its complete keyboard surface while open. Do this
  // before live effect/transport shortcuts so typing BPM or seed values cannot
  // mutate the visualizer behind the modal workbench.
  if (offline?.studio.isOpen()) return;
  // The input panel is a setup surface, not a modal — it deliberately does not
  // swallow the keyboard the way the guide and the studio do. Escape is the
  // only key it claims, and only while it is open.
  if (e.key === 'Escape' && inputBus?.panel.isOpen()) {
    inputBus.panel.close();
    return;
  }
  if (e.key === 'Escape' && sequencer?.grid.isOpen()) {
    sequencer.grid.close();
    return;
  }
  // The panel binds its own capture-phase listener and stops propagation while
  // focus is in a text, number, range or select control, so these never fire
  // while someone is typing a layer name.
  const avsKeyboardActive = avsEditorModel !== null || avsWorkerRenderer?.active || avsRuntime !== null;
  if (!avsKeyboardActive) {
    if (e.key >= '2' && e.key <= '9') patchParams('kaleidoscope', { segments: Number(e.key) });
    if (e.key === '1') patchParams('kaleidoscope', { segments: 0 });          // bypass
    if (e.key === 'k') toggleKaleidoscopeMix();
    // Trail length. Beats, not seconds — the same key at 90 and 174 BPM
    // changes the trail by the same musical amount.
    if (e.key === '[') patchParams('feedback', { tauBeats: Math.max(0.1, readParam('feedback', 'tauBeats', 1.2) - 0.15) });
    if (e.key === ']') patchParams('feedback', { tauBeats: Math.min(8, readParam('feedback', 'tauBeats', 1.2) + 0.15) });
  }
  if (e.key === 'h') hud.hidden = !hud.hidden;
  if (e.key === '?') { openGuide(); return; }
  if (e.code === 'Space') {
    e.preventDefault();
    void toggleTransport();
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    skipBar(e.key === 'ArrowRight' ? 1 : -1);
  }
  // P toggles automatic preset changes; , and . step by hand. Stepping does not
  // disturb the automatic cycle's determinism — the hash input is the cycle
  // counter, which a manual step deliberately leaves alone.
  if (e.key === 'p') toggleAutoPresets();
  if (e.key === ',' || e.key === '.') stepPreset(e.key === '.' ? 1 : -1);
  if (e.key === 'i') inputBus?.panel.toggle();
  if (e.key === 's') sequencer?.grid.toggle();
  if (e.key === 'd') overlay.toggle();
  // O opens the projector window. The offline render studio moved to R when the
  // projector arrived: both are "put the picture somewhere else", but only one
  // of them is a live action, and the live one gets the key that is easiest to
  // find mid-set. R is still one press, and the launcher button says so.
  if (e.key === 'o') openProjector();
  // AVS display settings, persisted and mirrored to the projector window:
  // U upscale filter, V AVS raster (classic / crisp / high), F frame-rate lock.
  // Presentation and pacing only; classic AVS pixels are never altered.
  if (e.key === 'u') applyAvsDisplaySettings({ ...avsDisplaySettings, upscale: nextInCycle(AVS_UPSCALE_MODES, avsDisplaySettings.upscale) }, true);
  if (e.key === 'v') applyAvsDisplaySettings({ ...avsDisplaySettings, resolution: nextInCycle(AVS_RESOLUTION_MODES, avsDisplaySettings.resolution) }, true);
  if (e.key === 'f') applyAvsDisplaySettings({ ...avsDisplaySettings, frameRate: nextInCycle(AVS_FRAME_RATE_LOCKS, avsDisplaySettings.frameRate) }, true);
  if (e.key === 'r') offline?.studio.open();
  // Known-tempo click track, so the clock can be verified without a file.
  if (e.key === 't') {
    resetTransport(0);
    audio.startTestSignal(128);
    void ensureDetector().then(() => {
      detector.timeOrigin = (audio.ctx?.currentTime ?? 0) - audio.currentTime;
      detector.reset();
    });
    $('hint').hidden = true;
  }
});
