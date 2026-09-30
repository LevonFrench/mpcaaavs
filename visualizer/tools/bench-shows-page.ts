// Browser half of tools/bench-shows.mjs (AAAVS). Bundled by esbuild with `@viz` aliased to a checkout's src/, so the same harness runs
// against the candidate and against a `--compare` baseline checkout. It imports nothing that a pre-instrumentation checkout lacks.
//
// It plays the part of the MPC host / the Player for the workers, the way src/mpc-host.ts does:
//  - one synthetic stereo signal (kick, snare, hat, bass, pad) analysed into AVS audio frames by the real AvsAudioAnalyser;
//  - requests paced by requestAnimationFrame at the display rate; a slot with a request outstanding skips the tick (a missed frame),
//    exactly like the host's `busy` flag;
//  - the media clock follows the wall clock, so a slow frame skips media time instead of slowing the music down;
//  - each returned bitmap is drawn on a visible canvas (the present) and closed.
// @ts-nocheck
import { AvsAudioAnalyser } from '@viz/avs/audio.ts';
import { MultiViewSession } from '@viz/multi-view-session.ts';
import { HudFeed } from '@viz/hud/hud-host.ts';
import { DEFAULT_PREFS } from '@viz/mpc-display.ts';

const SR = 44100;
const now = () => performance.now();
const epoch = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The synthetic music: deterministic, rich enough that every band of the analyser moves. */
function makeAudio(bpm) {
  const beat = 60 / bpm, an = new AvsAudioAnalyser();
  const L = new Float32Array(576), R = new Float32Array(576);
  const sample = (t, side) => {
    const bt = ((t - 0.37) % beat + beat) % beat, beatNo = Math.floor((t - 0.37) / beat), bar = Math.floor(beatNo / 4);
    const kick = bt < 0.16 ? Math.sin(2 * Math.PI * (48 + 70 * Math.exp(-bt * 28)) * bt) * Math.exp(-bt * 18) * 0.85 : 0;
    const sb = ((t - 0.37 - beat) % (2 * beat) + 2 * beat) % (2 * beat);
    const snare = sb < 0.12 ? (Math.sin(t * 91234.5 + side) * 0.6 + Math.sin(2 * Math.PI * 190 * sb)) * Math.exp(-sb * 26) * 0.35 : 0;
    const hb = (bt + beat / 2) % beat;
    const hat = hb < 0.035 ? Math.sin(t * 131071.3 + side * 3) * Math.exp(-hb * 110) * 0.22 : 0;
    const root = [55, 55, 65.4, 49][((bar % 4) + 4) % 4];
    const bass = Math.sin(2 * Math.PI * root * t) * 0.16 * (0.6 + 0.4 * Math.sin(2 * Math.PI * t * (bpm / 60) * 2));
    const trem = 0.6 + 0.4 * Math.sin(2 * Math.PI * 0.35 * t);
    const pad = (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 261.63 * t * (side ? 1.003 : 1)) + Math.sin(2 * Math.PI * 329.63 * t)) * 0.035 * trem;
    const lead = Math.sin(2 * Math.PI * (880 + 220 * Math.sin(t * 0.7)) * t) * 0.03 * (Math.floor(t * 4) % 2);
    return kick + snare + hat + bass + pad + lead;
  };
  return {
    /** The AVS frame and 1152-float PCM (left then right) of the 576-sample window ending at media time t. */
    at(t) {
      for (let i = 0; i < 576; i++) { const tt = t - (576 - i) / SR; L[i] = sample(tt, 0); R[i] = sample(tt, 1); }
      const frame = an.analyse({ left: L, right: R });
      const pcm = new Float32Array(1152); pcm.set(L); pcm.set(R, 576);
      return { frame, pcm };
    },
  };
}

function gpuInfo() {
  try {
    const c = document.createElement('canvas'), g = c.getContext('webgl2');
    const e = g.getExtension('WEBGL_debug_renderer_info');
    return g ? { vendor: e ? g.getParameter(e.UNMASKED_VENDOR_WEBGL) : g.getParameter(g.VENDOR), renderer: e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER) } : null;
  } catch { return null; }
}

function stage() {
  let c = document.getElementById('present');
  if (!c) { c = document.createElement('canvas'); c.id = 'present'; c.width = 1920; c.height = 1080; c.style.cssText = 'position:fixed;left:0;top:0;width:1920px;height:1080px'; document.body.append(c); }
  return c;
}

/** Fraction of lit samples in a rectangle of the present canvas (proves a plate drew something). */
function lit(ctx, r) {
  try {
    const w = Math.max(1, Math.floor(r.w)), h = Math.max(1, Math.floor(r.h));
    const d = ctx.getImageData(Math.floor(r.x), Math.floor(r.y), w, h).data;
    let n = 0, total = 0;
    for (let i = 0; i < d.length; i += 64) { total++; if (d[i] + d[i + 1] + d[i + 2] > 60) n++; }
    return n / Math.max(1, total);
  } catch { return -1; }
}

/**
 * Run worker slots concurrently for warmup + seconds. o = { seconds, warmup, perfMode, bpm, fps, slots: [{ root, file, plate, kind, width, height, scale, rect }] }.
 * A slot is one worker with its own pacing state (what the MPC host keeps per preset slot).
 */
async function runSlots(o) {
  const { seconds, warmup, perfMode = 0, bpm = 128, slots, minFrames = 0, pacing = 'timer', complete = true, fps = 60 } = o;
  const audio = makeAudio(bpm), BAR = 240 / bpm, S0 = 0.37 + 16 * BAR;
  const sceneBars = Math.max(8, Math.ceil((warmup + seconds * 3 + 6) / BAR)), S1 = S0 + sceneBars * BAR;
  const grid = { offset: 0.37, beatsPerBar: 4, bpm };
  const canvas = stage(), ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const ws = [];
  for (const s of slots) {
    const assets = new URL(`${s.root}/show-assets/`, location.href).href;
    const url = `${s.root}/${s.file}?assets=${encodeURIComponent(assets)}&scale=${s.scale ?? 1}`;
    const w = { s, gen: 1, seq: 0, busy: false, sentAt: 0, replies: [], wake: null, frames: [], ticks: 0, missed: 0, first: null, loadMs: 0, error: null, renderer: null, size: null, bytes: 0, requests: 0, worker: null };
    const created = now();
    w.worker = new Worker(url, { type: 'module' });
    w.worker.onmessage = (e) => { w.replies.push([now(), e.data]); w.wake?.(); };
    w.worker.onerror = (e) => { w.error = e.message || 'worker error'; w.wake?.(); };
    w.next = (pred, timeout = 120000) => new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('timed out waiting for the worker')), timeout);
      const f = () => {
        if (w.error) { clearTimeout(timer); return rej(new Error(w.error)); }
        const i = w.replies.findIndex(([, d]) => pred(d));
        if (i >= 0) { clearTimeout(timer); return res(w.replies.splice(i, 1)[0]); }
        w.wake = f;
      };
      f();
    });
    const preset = await (await fetch(s.presetUrl ?? `${s.root}/nerv-presets/${s.plate}.nerv`)).arrayBuffer();
    w.worker.postMessage({ type: 'load', generation: 1, preset, bitmaps: [], width: s.width, height: s.height, gpuLane: 'exact' }, [preset]);
    const [readyAt, ready] = await w.next((d) => d.type === 'ready' || d.type === 'error');
    if (ready.type === 'error') throw new Error(`${s.plate}: ${ready.message}`);
    w.loadMs = readyAt - created; w.renderer = ready.renderer ?? null;
    ws.push(w);
  }
  const t0 = now(), warmEnd = t0 + warmup * 1000, softEnd = warmEnd + seconds * 1000, capEnd = warmEnd + seconds * 3000;
  let end = softEnd;
  const raf = [];
  let lastRaf = 0, tickMs = [];
  const onReply = (w) => {
    while (w.replies.length) {
      const [arrive, d] = w.replies.shift();
      if (d.type === 'error') { w.error = d.message; continue; }
      if (d.type !== 'frame') continue;
      const rtt = arrive - w.sentAt;
      const p0 = now();
      const r = w.s.rect;
      ctx.drawImage(d.bitmap, r.x, r.y, r.w, r.h);
      const present = now() - p0;
      // completion: a 1-pixel readback forces the pixels of this frame to exist. Software GL (SwiftShader) runs the shaders on the CPU in the GPU
      // process, so without it the worker answers long before the frame is rendered and every time is meaningless.
      let done = null;
      if (complete) { ctx.getImageData(r.x + (r.w >> 1), r.y + (r.h >> 1), 1, 1); done = now() - w.sentAt; }
      w.size = [d.width, d.height];
      d.bitmap.close();
      if (w.first === null) w.first = rtt;
      if (w.sentAt >= warmEnd) {
        const ep = d.perf?.epoch;
        w.frames.push({ at: arrive - warmEnd, rtt, done, renderMs: d.renderMs, present, stages: d.perf ? d.perf.stages : null, reply: typeof ep === 'number' ? Math.max(0, performance.timeOrigin + arrive - ep) : null,
          fx: d.effectMs ?? null, up: d.uploadMs ?? null, enc: d.encodeSubmitMs ?? null, gpu: d.gpuMs ?? null, gpuLat: d.gpuLatencyMs ?? null });
      }
      w.busy = false;
    }
  };
  for (const w of ws) w.wake = () => onReply(w);
  await new Promise((resolve) => {
    const tick = (ts) => {
      const n = now();
      if (pacing === 'raf' && lastRaf && n >= warmEnd) raf.push(ts - lastRaf);
      lastRaf = ts;
      // the run ends after `seconds`, or later (up to 3x) until every slot has delivered `minFrames` frames
      if (n >= softEnd && end === softEnd && n < capEnd && ws.some((w) => w.frames.length < minFrames)) end = capEnd;
      if (end === capEnd && ws.every((w) => w.frames.length >= minFrames)) end = n;
      const media = S0 + 0.2 + (n - t0) / 1000;
      const a = audio.at(media);
      for (const w of ws) onReply(w);
      if (n < end) {
        for (const w of ws) {
          if (n >= warmEnd) w.ticks++;
          if (w.busy) { if (n >= warmEnd) w.missed++; continue; }
          const localTime = media - S0;
          const clock = { time: media, localTime, progress: localTime / (S1 - S0), bpm, seed: 7, grid, sceneStart: S0, sceneEnd: S1 };
          const pcm = a.pcm.slice().buffer;
          const msg = { type: 'render', generation: 1, sequence: ++w.seq, pcm, audio: a.frame, width: w.s.width, height: w.s.height };
          if (w.s.kind !== 'avs') msg.nerv = clock;
          if (perfMode > 0 && w.s.kind !== 'avs') msg.perf = { mode: perfMode, sent: epoch() };
          w.busy = true; w.sentAt = now();
          if (n >= warmEnd) { w.requests++; w.bytes += pcm.byteLength + 4 * 576 + 256; }
          w.worker.postMessage(msg, [pcm]);
        }
      }
      tickMs.push(now() - n);
      if (n >= end && ws.every((w) => !w.busy)) return resolve();
      if (n > end + 60000) return resolve();
      schedule();
    };
    // 'raf' paces like the host (real display vsync: headed or real-GPU runs); 'timer' is a 60 Hz timer for headless software-GL runs,
    // where the compositor produces frames at an arbitrary rate
    let nextAt = now();
    const schedule = () => {
      if (pacing === 'raf') return requestAnimationFrame(tick);
      nextAt += 1000 / fps;
      const n = now();
      if (nextAt < n - 4000 / fps) nextAt = n;
      setTimeout(() => tick(now()), Math.max(0, nextAt - n));
    };
    schedule();
  });
  const out = ws.map((w) => ({ plate: w.s.plate, kind: w.s.kind, width: w.s.width, height: w.s.height, scale: w.s.scale ?? 1, loadMs: w.loadMs, firstMs: w.first, renderer: w.renderer, replySize: w.size,
    ticks: w.ticks, missed: w.missed, requests: w.requests, bytes: w.bytes, error: w.error, lit: lit(ctx, w.s.rect), frames: w.frames }));
  for (const w of ws) w.worker.terminate();
  return { workers: out, raf, tickMs: tickMs.slice(-Math.max(10, raf.length)), seconds, gpu: gpuInfo() };
}

// ------------------------------------------------------------------ real Multiview
class ProbeWorker {
  constructor(url, probe) {
    this.w = new Worker(url, { type: 'module' });
    this.probe = probe; this.sent = new Map(); this.id = probe.workers.length; this.plate = '?';
    probe.workers.push({ id: this.id, plate: '?', frames: [], live: true });
  }
  postMessage(m, t) {
    if (m.type === 'load') { try { this.plate = JSON.parse(new TextDecoder().decode(m.preset)).scene; this.probe.workers[this.id].plate = this.plate; } catch {} }
    if (m.type === 'render') this.sent.set(m.sequence, now());
    this.w.postMessage(m, t);
  }
  set onmessage(fn) {
    this.w.onmessage = (e) => {
      const d = e.data;
      if (d?.type === 'frame') {
        const s = this.sent.get(d.sequence);
        if (s !== undefined) { this.sent.delete(d.sequence); if (this.probe.measuring) this.probe.workers[this.id].frames.push({ rtt: now() - s, renderMs: d.renderMs, at: now() }); }
      }
      fn(e);
    };
  }
  set onerror(fn) { this.w.onerror = fn; }
  terminate() { this.probe.workers[this.id].live = false; this.w.terminate(); }
}

/** The real MultiViewSession (lane clock, runtime, compositor) with its real Canvas2D NERV workers, driven like the host's frame loop. */
async function runMultiview(o) {
  const { root, plates, count, layout, seconds, warmup, bpm = 120, quality = 'high', pacing = 'timer', complete = true, fps = 60 } = o;
  const audio = makeAudio(bpm);
  const catalog = plates.map((plate, i) => ({ id: plate, name: plate, fileName: `${plate}.nerv`, sha256: (i + 1).toString(16).padStart(64, '0'), bytes: 60, url: '', parserStatus: 'lossless', autoEligible: true, kind: 'nerv', scene: plate }));
  const canvas = stage(), ctx = canvas.getContext('2d', { alpha: false });
  const probe = { workers: [], measuring: false };
  const fails = new Set(), log = [];
  let latest = audio.at(40).frame, pcm = audio.at(40).pcm, presents = [], completes = [], presentCount = 0, surfaceSize = null;
  const t0 = now(), startMedia = 40;
  const position = () => startMedia + (now() - t0) / 1000;
  const store = new Map();
  const session = new MultiViewSession({
    catalog: () => catalog,
    presets: async (p) => new Uint8Array(await (await fetch(`${root}/nerv-presets/${p.fileName}`)).arrayBuffer()),
    bitmaps: async () => [],
    worker: (url) => new ProbeWorker(`${root}/${url}`, probe),
    view: () => ({ width: 1920, height: 1080, dpr: 1 }),
    display: () => ({ ...DEFAULT_PREFS, quality }),
    audio: () => latest, pcm: () => pcm, hudFeed: new HudFeed(),
    position, duration: () => 300, playing: () => true, visible: () => true, reducedMotion: () => false,
    mode: () => {}, announce: (t) => log.push(t), failed: (i) => fails.add(i), failures: () => fails,
    present: (surface) => {
      const p0 = now();
      if (canvas.width !== 1920) canvas.width = 1920;
      ctx.drawImage(surface, 0, 0, 1920, 1080);
      const d = now() - p0;
      if (complete) { ctx.getImageData(960, 540, 1, 1); if (probe.measuring) completes.push(now() - p0 - d); }
      surfaceSize = [surface.width, surface.height];
      presentCount++; if (probe.measuring) presents.push(d);
    },
    storage: () => ({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) }),
    now,
  });
  const plan = session.plan;
  const panes = plan.panes.map((p) => ({ ...p, bars: 128, phaseBars: 0, auto: true, shuffle: false, source: null }));
  session.apply({ ...plan, count, layout, panes, source: { kind: 'all-presets' }, gutter: 4, avoidDuplicates: true });
  session.enable(true);
  const raf = [], frameMs = [], ages = [];
  let lastRaf = 0, measureFrom = Infinity;
  const ready = () => session.runtime && session.runtime.lanes.slice(0, count).every((l) => l.current?.bitmap);
  const tStart = now();
  await new Promise((resolve, reject) => {
    const tick = (ts) => {
      const n = now();
      if (n - tStart > 120000) return reject(new Error(`multiview panes did not load: ${JSON.stringify(log)}`));
      const a = audio.at(position());
      latest = a.frame; pcm = a.pcm; session.feed(a.frame);
      if (!probe.measuring && ready() && n - tStart > warmup * 1000) { probe.measuring = true; measureFrom = n; presents.length = 0; probe.workers.forEach((w) => { w.frames.length = 0; }); }
      const f0 = now();
      session.frame(n);
      const f1 = now();
      if (probe.measuring) {
        if (pacing === 'raf' && lastRaf) raf.push(ts - lastRaf);
        frameMs.push(f1 - f0);
        const age = session.frameAge; if (age !== null) ages.push(age);
      }
      lastRaf = ts;
      if (probe.measuring && n - measureFrom >= seconds * 1000) return resolve();
      schedule();
    };
    let nextAt = now();
    const schedule = () => {
      if (pacing === 'raf') return requestAnimationFrame(tick);
      nextAt += 1000 / fps;
      const n = now();
      if (nextAt < n - 4000 / fps) nextAt = n;
      setTimeout(() => tick(now()), Math.max(0, nextAt - n));
    };
    schedule();
  });
  const wall = (now() - measureFrom) / 1000;
  const info = { plates: probe.workers.filter((w) => w.live).map((w) => w.plate), log: log.slice(-6), failed: [...fails] };
  const workers = probe.workers.filter((w) => w.live).map((w) => ({ plate: w.plate, frames: w.frames }));
  const result = { workers, presents, completes, presentCount, wall, raf, frameMs, ages, surface: surfaceSize, info, gpu: gpuInfo() };
  session.close();
  return result;
}

window.bench = { runSlots, runMultiview, gpuInfo, sleep };
window.benchReady = true;
