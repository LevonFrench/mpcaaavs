// The projector window.
//
// A second, chromeless window that shows ONLY the picture: no HUD, no panels,
// no hint bar, no first-run guide. Drag it to a second display, press F11, and
// the output is clean. The control window keeps every control.
//
// This is deliberately NOT `main.ts` with the furniture hidden. It owns its own
// `GPUDevice` because a device cannot cross a browsing context (the full
// argument is at the top of `link.ts`), and it owns nothing else: no
// AudioEngine, no TempoTracker, no Scheduler, no director, no sequencer, no
// preset bank. Every decision has already been made in the control window and
// arrives over the link. This window's entire job is:
//
//   receive a description -> render it -> present it
//
// So the two windows cannot drift on a decision, because only one of them
// makes decisions. They can drift on a PICTURE — a dropped frame here shows a
// slightly older audio snapshot than the control window's — and that is the
// correct trade: the projector is a display, and a display that stalls waiting
// to agree is worse than one that is a frame behind.
//
// The one piece of state this window does own is its `Transition`, because a
// crossfade is a function of time and the transition spec, both of which arrive
// with the preset. Running it locally keeps a preset change looking identical
// in both windows without a per-frame mix value on the wire.

import { initGpu, createSampler, createFullscreenPipeline, resize, GpuInitError, type Gpu } from './gpu.ts';
import { AudioGpu } from './audiogpu.ts';
import { LayerStack, type StackPlan } from './layers.ts';
import { Transition, needsBothChains, type TransitionSpec } from './director.ts';
import { GpuTimer } from './gputimer.ts';
import { Renderer, type FrameState, type PooledTarget } from './renderer.ts';
import { SOURCE_PASSES } from './sources/index.ts';
import { OPERATOR_PASSES } from './ops/index.ts';
import {
  AVS_DISPLAY_SETTINGS_KEY, AvsDimensionsDebouncer, AvsFrameGovernor, DisplayRateEstimator, avsGovernorOptions,
  parseAvsDisplaySettings, type AvsDisplaySettings,
} from './avs-presentation.ts';
import { AvsCanvasPresenter, AvsWorkerRenderer, currentAvsViewport } from './avs-worker-client.ts';
import { Link, LinkAudioReceiver, type LinkMessage } from './link.ts';
import { applyLayerFields, loadShowStack, patchLayerParams } from './show-state.ts';
import { FlashGate } from './flash-gate.ts';
import { FrameRecorder } from './frame-recorder.ts';
import type { AvsComponentControl } from './avs/index.ts';
import type { AvsFrameGraphLane } from './avs/gpu-frame-graph.ts';
import type { Preset } from './contracts.ts';

import presentWGSL from './shaders/present.wgsl';

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const canvas = $('stage') as HTMLCanvasElement;
const status = $('status');
const err = $('err');

// Same shape as the control window's compatibility surface: the AVS lane draws
// into its own 2D canvas stacked over the WebGPU one, because it presents an
// ImageBitmap rather than a swapchain texture.
const avsCanvas = document.createElement('canvas');
avsCanvas.id = 'avs-stage';
avsCanvas.setAttribute('aria-label', 'Imported Winamp AVS preset');
avsCanvas.style.cssText = 'display:none;position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;image-rendering:pixelated';
canvas.insertAdjacentElement('afterend', avsCanvas);
// Not `desynchronized`: frames are presented from rAF (see renderFrame).
const avsContext = avsCanvas.getContext('2d', { alpha: false });
const avsPresenter = avsContext ? new AvsCanvasPresenter(avsCanvas, avsContext) : null;

function fail(message: string): void {
  err.textContent = message;
  err.hidden = false;
  status.hidden = true;
}

// ---------------------------------------------------------------- boot

let gpu: Gpu;
try {
  gpu = await initGpu(canvas);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  resize(gpu, window.innerWidth, window.innerHeight, dpr);
} catch (error) {
  fail(error instanceof GpuInitError
    ? error.message
    : `The projector could not start: ${error instanceof Error ? error.message : String(error)}`);
  throw error;
}

const device = gpu.device;
const sampler = createSampler(gpu);
const timer = new GpuTimer(device, gpu.hasTimestamp);
const audioGpu = new AudioGpu(device);
const renderer = new Renderer({ gpu, timer, audioGpu });
renderer.register(...SOURCE_PASSES, ...OPERATOR_PASSES);

const stack = new LayerStack();
let preset: Preset | null = null;
let plan: StackPlan | null = null;
const transition = new Transition();
let outgoingFrame: PooledTarget | null = null;
let captureOutgoing = false;

const presentPipeline = createFullscreenPipeline(gpu, 'present', presentWGSL, gpu.swapFormat);
const postParams = device.createBuffer({
  label: 'post-params', size: 32,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
const presentBinds = new Map<GPUTextureView, GPUBindGroup>();
const f32 = new Float32Array(8);

/** Cached by view identity, for the same ping-pong reason `main.ts` caches it. */
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
  if (presentBinds.size >= 64) presentBinds.clear();
  presentBinds.set(view, created);
  return created;
}

window.addEventListener('resize', () => {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (!resize(gpu, window.innerWidth, window.innerHeight, dpr)) return;
  renderer.resize();
  presentBinds.clear();
});

// ---------------------------------------------------------------- avs lane

// Display settings are the control window's, read from the shared
// localStorage key and followed live through the `storage` event, so the link
// protocol does not change. Defaults keep today's raster and cadence.
function readAvsDisplaySettings(): AvsDisplaySettings {
  try { return parseAvsDisplaySettings(localStorage.getItem(AVS_DISPLAY_SETTINGS_KEY)); }
  catch { return parseAvsDisplaySettings(null); }
}
let avsDisplaySettings = readAvsDisplaySettings();
// Floor-aware: in Classic/Crisp the governor has one scale-1 tier, so
// recordRender (now fed from every frame) can never downscale the show; High
// steps down to classic under load and no further.
let avsGovernor = new AvsFrameGovernor(avsGovernorOptions(avsDisplaySettings, 'worker'));
const avsDisplayRate = new DisplayRateEstimator();
// Dims follow the window only after 250 ms of stability: F11 or a drag to the
// second display costs one preset reset at the settled size, not several.
const avsDims = new AvsDimensionsDebouncer(250);
let avsDispatchedThisVsync = false;

function applyAvsPresenterSettings(): void {
  if (!avsPresenter) return;
  avsPresenter.mode = avsDisplaySettings.upscale;
  avsPresenter.integerCover = avsDisplaySettings.resolution === 'crisp';
}
applyAvsPresenterSettings();

window.addEventListener('storage', (event) => {
  if (event.key !== AVS_DISPLAY_SETTINGS_KEY) return;
  const next = parseAvsDisplaySettings(event.newValue);
  const rasterChanged = next.resolution !== avsDisplaySettings.resolution || next.frameRate !== avsDisplaySettings.frameRate;
  avsDisplaySettings = next;
  applyAvsPresenterSettings();
  if (!rasterChanged) return;
  avsGovernor = new AvsFrameGovernor(avsGovernorOptions(next, 'worker'));
  avsGovernor.setDisplayHz(avsDisplayRate.hz);
  avsDims.settle(avsSourceDims());
});

/** Raster for the current window: surface size for `fit` (as before), device pixels for crisp. */
function avsSourceDims(): { width: number; height: number } {
  const source = avsGovernor.policy === 'integer' ? currentAvsViewport() : { width: gpu.width, height: gpu.height };
  return avsGovernor.dimensions(source.width, source.height);
}

/** Dispatch when idle; from rAF and again the moment a frame lands (see main.ts). */
function dispatchAvs(nowMs: number): void {
  const worker = avsWorkerRenderer;
  if (!worker?.active || receiver.paused || worker.busy || avsDispatchedThisVsync) return;
  if (!avsGovernor.shouldRender(nowMs)) return;
  const { width, height } = avsDims.current(avsSourceDims(), nowMs);
  if (worker.render(receiver.snapshot, width, height)) avsDispatchedThisVsync = true;
}

let avsLoadRevision = 0;
let avsControls: readonly AvsComponentControl[] = [];
/** The live AVS description, kept so a GPU-lane change can reload it on a fresh worker. */
let avsLive: { readonly bytes: Uint8Array; readonly fileName: string } | null = null;
/**
 * 'exact' unless the control window says the performer opted into the
 * approximate GPU generators. Arrives as `render-settings`; never persisted
 * here, because the control window owns the choice.
 */
let avsGpuLane: AvsFrameGraphLane = 'exact';

/**
 * Flash limiting on the projector is ENFORCED, with no override: the owner
 * decision is that a wall is always limited. It gates the final bitmap at
 * present time (see flash-gate.ts), so AVS pixels and feedback state are
 * untouched. 'strict' is the candidate if a wall-projection setting is added.
 */
const flashGate = new FlashGate('limit');
/** Delivered-frame timing for this window, read through the dev handle. */
const frameRecorder = new FrameRecorder();

/**
 * Worker-only, on purpose.
 *
 * The control window keeps a main-thread `AvsCompatibilityRuntime` fallback for
 * browsers without `OffscreenCanvas`. Duplicating it here would put an exact
 * CPU executor on the projector's main thread, competing with the render loop
 * it exists to keep smooth — and any browser with WebGPU has workers. If the
 * worker cannot start, this window says so rather than degrading silently.
 */
function createAvsWorkerRenderer(lane: AvsFrameGraphLane): AvsWorkerRenderer | null {
  if (!AvsWorkerRenderer.supported() || !avsContext) return null;
  try {
    return new AvsWorkerRenderer({
      canvas: avsCanvas,
      context: avsContext,
      gpuLane: lane,
      latchFrames: true,
      onFrame() {
        // The first AVS frame is the proof the link works end to end.
        status.hidden = true;
        if (!avsWorkerRenderer) return;
        // Floor-aware (WP5): Classic/Crisp cannot change tier, High may step
        // down to classic after its dwell and no further.
        avsGovernor.recordRender(avsWorkerRenderer.lastRenderMs, performance.now());
        frameRecorder.recordRender(avsWorkerRenderer.lastRenderMs);
        if (avsWorkerRenderer.gpuMs !== undefined) frameRecorder.recordGpu(avsWorkerRenderer.gpuMs);
      },
      onIdle() { dispatchAvs(performance.now()); },
    });
  } catch (error) {
    console.warn('[aaavs] projector could not create the AVS render worker:', error);
    return null;
  }
}

let avsWorkerRenderer: AvsWorkerRenderer | null = createAvsWorkerRenderer(avsGpuLane);

/**
 * Follow the control window's GPU lane. The lane is fixed per worker (it is
 * sent with each load), so a change means a fresh worker and a reload of the
 * live preset on it: the same preset reset the control window takes.
 */
function setAvsGpuLane(lane: AvsFrameGraphLane): void {
  if (lane === avsGpuLane) return;
  avsGpuLane = lane;
  if (!avsWorkerRenderer) return;
  avsLoadRevision++;
  avsWorkerRenderer.dispose();
  avsWorkerRenderer = createAvsWorkerRenderer(lane);
  if (avsLive) void loadAvs(avsLive.bytes, avsLive.fileName);
  else avsCanvas.style.display = 'none';
}

async function loadAvs(bytes: Uint8Array, fileName: string): Promise<void> {
  avsLive = { bytes, fileName };
  const worker = avsWorkerRenderer;
  if (!worker) {
    fail('This browser cannot run the AVS compatibility worker, so the projector cannot mirror an AVS preset.');
    return;
  }
  const revision = ++avsLoadRevision;
  avsGovernor.reset();
  flashGate.reset();
  frameRecorder.markPresetSwitch(performance.now());
  const { width, height } = avsSourceDims();
  avsDims.settle({ width, height });
  try {
    await worker.load(bytes, width, height);
  } catch (error) {
    if (revision !== avsLoadRevision) return;
    console.warn(`[aaavs] projector could not load ${fileName}:`, error);
    return;
  }
  if (revision !== avsLoadRevision || avsWorkerRenderer !== worker) return;
  avsCanvas.width = width;
  avsCanvas.height = height;
  avsCanvas.style.display = 'block';
  worker.setControls(avsControls);
  status.hidden = true;
}

function clearAvs(): void {
  avsLoadRevision++;
  avsLive = null;
  avsWorkerRenderer?.clear();
  avsCanvas.style.display = 'none';
}

// ---------------------------------------------------------------- the link

const receiver = new LinkAudioReceiver();

/**
 * A `preset` message is how the control window leaves the AVS lane, so the
 * AVS lane is cleared first. The stack rules are `show-state.ts`'s, the same
 * ones the control window applied to its own stack.
 */
function applyPreset(next: Preset, at: number, bpm: number, spec: TransitionSpec | null): void {
  clearAvs();
  preset = next;
  const loaded = loadShowStack(stack, renderer, transition, next, spec, at, bpm);
  plan = loaded.plan;
  if (spec) captureOutgoing = loaded.captureOutgoing;
  status.hidden = true;
}

function handle(message: LinkMessage): void {
  switch (message.kind) {
    case 'audio':
      receiver.accept(message.frame);
      if (receiver.frames === 1) status.hidden = true;
      return;
    case 'preset':
      applyPreset(message.preset, message.at, message.bpm, message.transition);
      return;
    case 'params':
      patchLayerParams(stack, message.type, message.patch);
      return;
    case 'layer-fields':
      // In place, by id: a slider drag must never reload the stack here.
      applyLayerFields(stack, message.fields);
      return;
    case 'mixer':
      stack.applyMixerSnapshot(message.mixer);
      return;
    case 'render-settings':
      setAvsGpuLane(message.gpuLane === '120' ? '120' : 'exact');
      return;
    case 'avs-load':
      void loadAvs(message.bytes, message.fileName);
      return;
    case 'avs-clear':
      clearAvs();
      return;
    case 'avs-controls':
      avsControls = message.controls;
      avsWorkerRenderer?.setControls(avsControls);
      return;
    case 'hello':
      // The control window restarted under us. Ask it for state again rather
      // than keep rendering whatever this window happened to hold.
      link.announce();
      return;
    default:
      return;
  }
}

const link = new Link({
  role: 'projector',
  onMessage: handle,
  onPeerChange(live) {
    if (live) return;
    // The control window went away. Keep the last picture on screen — a
    // projector that blanks because a laptop lid closed is worse than one that
    // holds a frame — but say what happened.
    status.textContent = 'control window disconnected — waiting…';
    status.hidden = false;
  },
});

if (!link.available) {
  fail('This browser does not support BroadcastChannel, which the projector window needs to receive the show.');
}

// Announce, then keep announcing until the control window answers. A projector
// opened before the control window has finished booting would otherwise sit
// blank forever waiting for a state message that was already sent.
link.announce();
const announceTimer = setInterval(() => {
  if (link.peerLive) clearInterval(announceTimer);
  else link.announce();
}, 600);

function disposePage(): void {
  clearInterval(announceTimer);
  avsWorkerRenderer?.dispose();
  link.dispose();
}
window.addEventListener('pagehide', disposePage, { once: true });
window.addEventListener('beforeunload', disposePage, { once: true });

// ---------------------------------------------------------------- frame

function renderFrame(nowMs: number): void {
  avsGovernor.setDisplayHz(avsDisplayRate.tick(nowMs));
  const audio = receiver.snapshot;
  const t = audio.time;
  const post = receiver.post;

  // The AVS lane, exactly as the control window branches: its 2D canvas fully
  // covers the WebGPU one, so nothing below is worth encoding.
  if (avsWorkerRenderer?.active) {
    avsDispatchedThisVsync = false;
    if (avsPresenter && avsContext) {
      const viewport = currentAvsViewport();
      const presented = avsWorkerRenderer.presentLatest((bitmap, width, height) => {
        flashGate.present(avsContext, bitmap, nowMs / 1000, () => avsPresenter.present(bitmap, width, height, viewport));
      });
      frameRecorder.setDisplayHz(avsDisplayRate.hz ?? 0);
      // Delivered AVS frames only: rAF ticks with no new frame are not frames.
      if (presented) {
        frameRecorder.frame(nowMs);
        frameRecorder.markPresented(performance.now());
      }
    }
    dispatchAvs(nowMs);
    requestAnimationFrame(renderFrame);
    return;
  }

  if (!preset || !plan) {
    requestAnimationFrame(renderFrame);
    return;
  }

  transition.update(t);
  if (!transition.active && outgoingFrame) {
    renderer.releaseTarget(outgoingFrame);
    outgoingFrame = null;
  }

  const beats = receiver.beats;
  stack.update(beats);
  const framed = stack.frame(beats);
  plan = framed.plan;

  timer.beginFrame();
  const encoder = device.createCommandEncoder();
  if (captureOutgoing) {
    if (outgoingFrame) renderer.releaseTarget(outgoingFrame);
    outgoingFrame = renderer.captureOutput(encoder);
    captureOutgoing = false;
  }

  audioGpu.upload(audio, device.queue);

  const frameState: FrameState = {
    resolved: framed.resolved,
    audio,
    palette: preset.palette,
    time: t,
    beats,
    bpm: receiver.bpm,
    dtBeats: receiver.dtBeats,
    dtSeconds: receiver.dtSeconds,
    frame: receiver.frameIndex,
  };
  let output = renderer.execute(encoder, plan, frameState);
  if (transition.active && outgoingFrame && needsBothChains(transition.kind)) {
    const composite = renderer.transition(
      encoder, outgoingFrame, output, transition.current, transition.mix, transition.seed, frameState,
    );
    output = composite;
    renderer.releaseTarget(composite);
  }

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
  timer.endFrame(encoder);
  device.queue.submit([encoder.finish()]);
  timer.poll();

  requestAnimationFrame(renderFrame);
}

requestAnimationFrame(renderFrame);

// Dev handle, matching the control window's. A projector that is silently
// receiving nothing looks exactly like one that is receiving zeros.
(globalThis as unknown as Record<string, unknown>).__aaavsProjector = {
  gpu, renderer, stack, audioGpu, timer, link, receiver, flashGate, frameRecorder,
  get state() {
    return {
      peerLive: link.peerLive,
      frames: receiver.frames,
      preset: preset?.name ?? null,
      avs: avsWorkerRenderer?.active ?? false,
      avsWidth: avsWorkerRenderer?.lastWidth ?? 0,
      avsHeight: avsWorkerRenderer?.lastHeight ?? 0,
      avsRenderedFrames: avsWorkerRenderer?.renderedFrames ?? 0,
      avsRenderMs: avsWorkerRenderer?.averageRenderMs ?? 0,
      avsDisplay: avsDisplaySettings,
      avsGpuLane,
      flashMode: flashGate.mode,
      flashAvailable: flashGate.available,
      mixer: stack.mixerSnapshot(),
      time: receiver.snapshot.time,
      bpm: receiver.bpm,
    };
  },
};
