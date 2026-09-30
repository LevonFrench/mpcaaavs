/** Show render worker (AAAVS): the port of bizarro/evangelion's engine (MIT, see THIRD-PARTY-NERV.txt) rendering
 * the NERV show with WebGL2 (three.js, HalfFloat linear HDR, upstream post chain) into an OffscreenCanvas.
 * Output size is 1920x1080 times the scale in the worker URL (`?scale=2` = 3840x2160); a scale change restarts the worker.
 * Frames are pure functions of media time, seed and the song map: a seek simply renders the new time.
 * Dialects: src/show/protocol.ts (show-init / show-render). */
import { Engine, type TimelineEntry } from './show/engine.ts';
import { AudioData } from './show/audio.ts';
import { PW, PH, SCALE } from './show/gl.ts';
import { setAssetBase } from './show/canvas.ts';
import { planShow, type PlannedPlate } from './show/plan.ts';
import { validateShowRequest, type ShowAudioMessage, type ShowInitMessage, type ShowPlanEntry, type ShowRenderMessage } from './show/protocol.ts';
import { LiveAudioData } from './show/live.ts';
import { NERV_SCENE_CLASSES, NERV_SHOW, type NervPlateId } from './shows/nerv/index.ts';
import { validateSongMap } from './song-map/validate.ts';
import { synthesizeWave } from './song-map/synth-wave.ts';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

const canvas = new OffscreenCanvas(PW, PH);
let engine: Engine | null = null;
let entries: TimelineEntry[] = [];
let generation = -1;
let queue: Promise<void> = Promise.resolve();
let verbose = false;
let live: LiveAudioData | null = null;
const debug = (s: string) => { if (verbose) console.info('[show worker]', s); };

/** Timeline entries for planned plates (one scene instance per window). */
export function entriesFor(plan: readonly PlannedPlate[]): TimelineEntry[] {
  return plan.map((p) => {
    const cls = NERV_SCENE_CLASSES[p.id as NervPlateId];
    if (!cls) throw new Error(`unknown NERV plate ${p.id}`);
    return { id: p.id, key: `${p.id}@${p.start.toFixed(4)}-${p.end.toFixed(4)}`, load: () => ({ default: cls }), start: p.start, end: p.end, barMap: p.barMap, params: p.params };
  });
}

async function init(m: ShowInitMessage) {
  const t0 = performance.now();
  setAssetBase(m.assetBase);
  verbose = m.verbose === true;
  let audio: AudioData, synthesized = false;
  if (!m.songMap) {
    // live fallback: tempo grid + live AVS frames (show-audio) until a song map arrives in a new show-init
    audio = live = new LiveAudioData({ duration: m.duration!, bpm: m.bpm!, firstBeat: m.firstBeat, sampleRate: m.sampleRate });
  } else {
    live = null;
    const spec = m.spec ? new Uint8Array(m.spec) : undefined;
    const map = validateSongMap(m.songMap, { spec });
    let wave: Float32Array | undefined = m.wave ? new Float32Array(m.wave) : undefined;
    if (!wave) {
      const w = synthesizeWave(map, { spec });
      wave = w.wave; synthesized = true;
      map.wave = { rate: w.rate, channels: 2, frames: w.frames };
    }
    audio = new AudioData(map, { spec, wave });
  }
  const map = audio.map;
  debug(`analysis ready ${(performance.now() - t0).toFixed(0)} ms`);
  let plan = planShow(map, NERV_SHOW, { ...(m.params ?? {}) });
  const full = plan;
  if (m.only?.length) plan = plan.filter((p) => m.only!.includes(p.id));
  entries = entriesFor(plan);
  if (!engine) {
    engine = new Engine(canvas as unknown as HTMLCanvasElement, () => entries);
    engine.onProgress = (msg) => debug(`${msg} ${(performance.now() - t0).toFixed(0)} ms`);
    await engine.init(audio);
  } else await engine.setAudio(audio, entries);
  debug(`engine ready ${(performance.now() - t0).toFixed(0)} ms`);
  const out: ShowPlanEntry[] = full.map((p) => ({ id: p.id, role: p.role, start: p.start, end: p.end, startBar: p.startBar, endBar: p.endBar }));
  scope.postMessage({ type: 'show-ready', generation: m.generation, plan: out, duration: map.duration, scale: SCALE, width: PW, height: PH, errors: engine.errors.slice(), synthesizedWave: synthesized, initMs: performance.now() - t0 });
}

function render(m: ShowRenderMessage) {
  if (!engine) throw new Error('show worker not initialised');
  const t0 = performance.now();
  engine.render(m.time, m.dt ?? 1 / 60, true);
  if (m.sync) engine.renderer.getContext().finish();
  const renderMs = performance.now() - t0;
  const bitmap = canvas.transferToImageBitmap();
  const e = entries.find((x) => m.time >= x.start && m.time < x.end);
  scope.postMessage({ type: 'show-frame', generation: m.generation, sequence: m.sequence, bitmap, width: PW, height: PH, renderMs, plate: e?.id ?? null }, [bitmap]);
}

function pushAudio(m: ShowAudioMessage) {
  if (!live) return; // a song map is loaded: live frames are not needed
  const w = new Uint8Array(m.waveform), sp = new Uint8Array(m.spectrum);
  live.push(m.time, { waveform: [w.subarray(0, 576), w.subarray(576)], spectrum: [sp.subarray(0, 576), sp.subarray(576)], beat: m.beat, beatLevel: m.beatLevel });
}

scope.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    let gen = -1;
    try {
      const m = validateShowRequest(data);
      gen = m.generation;
      if (m.type === 'show-init') { generation = m.generation; await init(m); return; }
      if (m.generation !== generation) return;
      if (m.type === 'show-audio') { pushAudio(m); return; }
      render(m);
    } catch (error) {
      scope.postMessage({ type: 'show-error', generation: gen, message: String((error as Error)?.stack ?? error) });
    }
  });
};
