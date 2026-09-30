// Worker-side stage profiler of the show engine (AAAVS). OFF by default: every call site is
//   const p = PERF.on ? perfBegin() : 0;  ...work...  if (PERF.on) perfEnd('stage.name', p);
// so the disabled cost is one property read and a branch, and nothing is allocated or patched.
//
// Modes (src/perf-trace.ts PerfMode): 1 = CPU timestamps around each stage; 2 = the same with gl.finish() before and after each GL-facing
// stage, so a stage includes the GPU work it queued. Mode 2 serialises the CPU and the GPU: it attributes cost to stages correctly but
// removes the pipelining a real frame enjoys, so its total is larger than a real frame. Canvas2D layer rasterisation is not covered by
// gl.finish (Chromium flushes it when the canvas is uploaded as a texture: see gl.upload.canvas).
//
// Stage times of one frame are summed into an accumulator and handed out by perfTake() for the frame reply (`perf` field).
import { epochNow, type PerfMode, type WorkerPerfFrame } from './perf-trace.ts';

/** `frame` counts the reports handed out, so a half-measured span of an earlier frame is never completed in a later one. */
export const PERF: { on: boolean; sync: boolean; gl: WebGL2RenderingContext | null; frame: number } = { on: false, sync: false, gl: null, frame: 0 };

let acc: Record<string, number> = {};
let cnt: Record<string, number> = {};

/** The clock of the profiler: the only place the show engine's instrumentation reads time (tools/check-show-determinism.mjs keeps src/show free of performance.now). */
export const perfNow = (): number => performance.now();

export function perfBegin(): number {
  if (PERF.sync && PERF.gl) PERF.gl.finish();
  return perfNow();
}
export function perfEnd(stage: string, t0: number): number {
  if (PERF.sync && PERF.gl) PERF.gl.finish();
  const d = perfNow() - t0;
  acc[stage] = (acc[stage] ?? 0) + d;
  cnt[stage] = (cnt[stage] ?? 0) + 1;
  return d;
}
/** Add a measured span without the GL sync (CPU-only stages, and time measured elsewhere). */
export function perfAdd(stage: string, ms: number) {
  acc[stage] = (acc[stage] ?? 0) + ms;
  cnt[stage] = (cnt[stage] ?? 0) + 1;
}

// ------------------------------------------------------------------ GL upload hooks (installed only while profiling)
type Patched = 'texImage2D' | 'texSubImage2D' | 'bufferData' | 'bufferSubData';
const PATCHED: readonly Patched[] = ['texImage2D', 'texSubImage2D', 'bufferData', 'bufferSubData'];
/** Canvas backing a Layer2D -> the layer (its id names layer.<id>.upload). */
const layers = new WeakMap<object, { id: string }>();
export function perfRegisterLayer(canvas: object, layer: { id: string }) { layers.set(canvas, layer); }
let hooked: WebGL2RenderingContext | null = null;
function isCanvas(x: unknown): boolean {
  return (typeof OffscreenCanvas !== 'undefined' && x instanceof OffscreenCanvas) || (typeof HTMLCanvasElement !== 'undefined' && x instanceof HTMLCanvasElement);
}
function hook(gl: WebGL2RenderingContext) {
  if (hooked === gl) return;
  unhook();
  hooked = gl;
  const proto = Object.getPrototypeOf(gl) as Record<string, (...a: unknown[]) => unknown>;
  for (const name of PATCHED) {
    const orig = proto[name]!;
    (gl as unknown as Record<string, unknown>)[name] = function (this: WebGL2RenderingContext, ...args: unknown[]) {
      if (!PERF.on) return orig.apply(this, args);
      const t0 = perfNow();
      const r = orig.apply(this, args);
      const d = perfNow() - t0;
      if (name === 'bufferData' || name === 'bufferSubData') perfAdd('gl.upload.buffer', d);
      else {
        const src = args[args.length - 1];
        if (isCanvas(src)) {
          perfAdd('gl.upload.canvas', d);
          const layer = layers.get(src as object);
          perfAdd(`layer.${layer?.id ?? 'unnamed'}.upload`, d);
        } else perfAdd('gl.upload.data', d);
      }
      return r;
    };
  }
}
function unhook() {
  if (!hooked) return;
  for (const name of PATCHED) delete (hooked as unknown as Record<string, unknown>)[name];
  hooked = null;
}

/** Set the mode for the coming frame (the worker calls this at the top of every render message with the message's `perf` field, or its URL default). */
export function perfConfigure(mode: PerfMode) {
  const on = mode !== 0;
  PERF.sync = mode === 2;
  if (on === PERF.on) { if (on && PERF.gl) hook(PERF.gl); return; }
  PERF.on = on;
  acc = {}; cnt = {};
  if (on && PERF.gl) hook(PERF.gl);
  if (!on) unhook();
}
/** The engine registers its GL context once it exists (cheap, always done). */
export function perfSetContext(gl: WebGL2RenderingContext) { PERF.gl = gl; if (PERF.on) hook(gl); }

/** The finished frame's report for the reply message, and reset. Undefined while profiling is off. */
export function perfTake(): WorkerPerfFrame | undefined {
  if (!PERF.on) return undefined;
  const epoch = epochNow();
  const frame: WorkerPerfFrame = { stages: acc, counts: cnt, mode: PERF.sync ? 2 : 1, ...(Number.isFinite(epoch) ? { epoch } : {}) };
  acc = {}; cnt = {}; PERF.frame++;
  return frame;
}
