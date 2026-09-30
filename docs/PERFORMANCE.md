# Performance: measuring the show engine and Multiview

Phase 1 of the performance work is *measure before changing anything*. This page describes the instrumentation, the bench tool, how to
run it on a machine with a real GPU, the baseline taken before any optimisation, and what cannot be measured without a GPU.
Nothing here changes a rendered pixel or a behaviour: the instrumentation is off by default and costs one boolean test per call site
when off (`node tools/check-perf-trace.mjs` and `node tools/check-perf-host.mjs` keep that true).

## 1. The instrumentation

### Switching it on

| where | how |
|---|---|
| show worker | a render message carries `perf: { mode, sent }` (`mode` 1 = CPU timestamps, 2 = GPU-synchronised; `sent` = `performance.timeOrigin + performance.now()` of the host at `postMessage`), or the worker URL has `?perf=1` / `?perf=sync`. Without either it is off. |
| host page (MPC-HC WebView2 and the standalone Player share `src/mpc-host.ts`) | `?perf=1` or `?perf=sync` on the page URL, `localStorage["mpcaaavs.perf"] = "1"` or `"sync"`, **Ctrl+Alt+P** (cycles off, CPU timestamps, synchronised, off), or `window.__aaavsPerf.enable(1 or 2)` from the console. **Ctrl+Alt+Shift+P** downloads the JSON trace; `window.__aaavsPerf.trace()` returns it; `.download()`, `.reset()`, `.disable()`. While on, the host adds `perf` to the NERV render requests and appends a perf segment to the timing overlay (`perf ms p50/p95: worker 12.3/18.1 · rtt 14.2/21 · present 0.8/1.4 · raf 16.7/17.9 · busy 3.1 · audio 75/s`), and forces the overlay visible. |
| bench | `tools/bench-shows.mjs` enables it by default (`--no-stages` turns it off, `--sync` selects mode 2). |

Mode 2 ("sync") waits for the GPU before and after each GL-facing stage with a 1x1 `readPixels` from a private target (Chromium's
`gl.finish()` only flushes, it does not wait). It attributes GPU time to the stage that queued it, but it **serialises the CPU and the GPU**:
the frame total is larger than a real, pipelined frame, and stages that would overlap in production do not. Use mode 1 for "what does a real
frame cost the worker's CPU" and mode 2 for "which pass is expensive". Canvas2D rasterisation is not covered by the wait: Chromium flushes a
layer's 2D work when the canvas is uploaded as a texture, so it shows up in `gl.upload.canvas`.

### Stages

All names are in `PERF_STAGES` in `src/perf-trace.ts`; `node tools/check-perf-trace.mjs` fails if the code emits a name that is not listed here
or in that table, or if a listed name is no longer emitted. Times are milliseconds; a stage that ran more than once in a frame is summed.
A *parent* includes its children.

<!-- STAGE-TABLE:begin -->
| stage | where | inside | what it measures |
|---|---|---|---|
| `frame.total` | worker |  | Whole frame build in the worker: from the render message to the finished ImageBitmap, excluding the reply postMessage. |
| `frame.window` | worker | `frame.total` | NERV preset window (presetWindow) and, when the scene window changed, the rebuild of the live analysis and the engine timeline (first frame of a scene). |
| `live.push` | worker | `frame.total` | Pushing the host AVS audio frame into the live analysis (LiveAudioData.push); in the show dialect one sample per show-audio message. |
| `frame.plates` | worker | `frame.total` | All engine renders of the frame (one per plate, two during a crossfade). |
| `engine.render` | worker | `frame.plates` | One Engine.render call: analysis textures, scene composite, HUD, post chain and blit. |
| `engine.spectrum` | worker | `engine.render` | Upload of the live analysis textures that changed since the last frame (mel, chroma, waveform). |
| `engine.composite` | worker | `engine.render` | Scene composite: every active scene rendered into HDR targets and crossfaded. |
| `scene.render` | worker | `engine.composite` | Scene.render of the plate(s): its Canvas2D layers, GL draws and their texture uploads. |
| `scene.preroll` | worker | `engine.composite` | Fast-forward re-simulation of a stateful scene after a seek (never in steady playback). |
| `engine.xfade` | worker | `engine.composite` | The default crossfade pass between two overlapping scenes. |
| `engine.hud` | worker | `engine.render` | HUD overlay (captions, crop marks): Canvas2D draw plus texture upload. |
| `engine.post` | worker | `engine.render` | The post chain: bloom pyramid and the final grade pass. |
| `post.bloom` | worker | `engine.post` | Bloom prefilter, 6 downsamples and 6 upsamples. |
| `post.final` | worker | `engine.post` | Final pass: aberration, bloom and halation add, HUD composite, tone shoulder, vignette, grain. |
| `engine.blit` | worker | `engine.render` | Copy of the final target to the canvas. |
| `comp.draw` | worker |  | Compositor.draw calls (texture over target): their CPU time; the first use of a freshly uploaded Canvas2D layer includes its texture upload. Overlaps scene.render and engine.composite. |
| `canvas2d.draw` | worker |  | Sum of the Layer2D draw spans (clear() to upload()): Canvas2D command recording, plus any other work between the two calls. |
| `gl.upload.canvas` | worker |  | Texture uploads from a Canvas2D layer (texImage2D/texSubImage2D with a canvas source); the GPU raster of the layer is flushed here. |
| `gl.upload.data` | worker |  | Texture uploads from typed arrays (analysis textures, scope banks). |
| `gl.upload.buffer` | worker |  | bufferData/bufferSubData (line and geometry buffers). |
| `frame.fit` | worker | `frame.total` | Copy of the WebGL canvas into the 2D output surface (letterbox, scale). Without sync timing this is where queued GPU work is waited for. |
| `frame.transition` | worker | `frame.total` | The AVS-style transition between the outgoing and incoming plate (Canvas2D). |
| `frame.bitmap` | worker | `frame.total` | transferToImageBitmap of the output surface. |
| `frame.reply` | worker |  | The reply postMessage (structured clone and transfer); reported with the next frame. |
| `msg.request` | worker |  | Time the render request spent between the host postMessage and the worker starting it (flight plus queueing behind earlier work); needs the host to send its epoch. |
| `host.rtt` | host |  | Request to frame reply of the active slot, measured on the main thread. |
| `host.reply` | host |  | Time the frame reply spent between the worker postMessage and the host handler starting (flight plus main-thread queueing). |
| `host.complete` | host |  | Bench only: time from the reply to the frame's pixels existing (a 1-pixel readback of the presented canvas): GPU work the worker had queued but not finished. |
| `host.present` | host |  | Main-thread draw of a presented frame: flash gate and canvas copy/scale. |
| `host.transition` | host |  | Main-thread AVS transition composite between two worker bitmaps. |
| `host.raf.interval` | host |  | Interval between requestAnimationFrame callbacks (display cadence; jitter is its spread). |
| `host.raf.busy` | host |  | Duration of the requestAnimationFrame callback body on the main thread. |
| `host.audio.msg` | host |  | Handling of one native audio message on the main thread (analysis, worker audio queues, scene clock), until the ack. |
<!-- STAGE-TABLE:end -->

Layer stages are named `layer.<plate>.<field>.draw` and `.upload` (for example `layer.magi.L.draw`, `layer.sync.hud.upload`; `layer.hud.*` is the
engine's caption layer). `draw` is the span from the layer's first `clear()` of the frame to its `upload()` call: Canvas2D command recording
plus anything else the plate does between the two. `upload` is the texture upload of that canvas (`texImage2D`/`texSubImage2D` with a canvas
source, patched on the GL context instance only while profiling), which is where Chromium rasterises the recorded 2D commands.
The host counters are `host.audio.messages`, `host.audio.frames`, `host.audio.floats` (native audio messages, their PCM frames and floats per
second; the JSON on the wire is several times the float payload), `host.render.messages`, `host.render.bytes`, `host.frame.messages`.

### The trace

`window.__aaavsPerf.trace()` and the bench produce the same shape (validated by `validateTrace`):

```json
{ "format": "aaavs-perf-trace", "version": 1, "source": "host", "mode": 1, "frames": 600, "seconds": 10.0,
  "stages": { "frame.total": { "n": 600, "mean": 7.1, "p50": 6.4, "p95": 12.0, "p99": 15.3, "max": 21.7 }, "...": {} },
  "counters": { "host.render.messages": { "total": 600, "perSecond": 60 } },
  "series": { "frame.total": [7.1, 6.9] },
  "meta": {} }
```

`series` (the last 4096 values of each stage) is only in a downloaded host trace; bench reports carry summaries only (`--raw` adds round-trip
times). A stage that did not run in a frame counts as 0 in the bench's summaries (so `frame.window`'s p50 is 0 and its max is the scene rebuild hitch).

## 2. The bench: `tools/bench-shows.mjs`

It drives the real workers in Chromium the way the host does: the NERV preset dialect (`load` a `.nerv` preset, then `render` with a
`NervPlaybackFrame`, an `AvsAudioFrame` and a PCM buffer on every display tick), audio frames produced by the real `AvsAudioAnalyser` from
a synthetic kick, snare, hat, bass and pad signal, a media clock that follows the wall clock (a slow frame skips media time), a scene window
of whole bars on a saved beat grid, and one request in flight per slot exactly like the host's `busy` flag. Each returned bitmap is drawn on a visible canvas (the present) and closed.

```
node tools/bench-shows.mjs [options]
  --seconds N          measured seconds per plate and size (default 10); continues (up to 3x) until --min-frames are in
  --warmup N           unmeasured seconds first (default 1.5): scene build, shader compile, first-use uploads
  --min-frames N       frames each slot must deliver (default 20)
  --sizes WxH,...      default 1920x1080,3840x2160. The show engine renders 1920x1080 x scale: 4K = the worker at ?scale=2
  --plates a,b,...     default all 16: boot magi psycho radar harmonics seele battery atfield alert plug target city sync berserk impact end
  --multiview 2,4      Multiview lane counts (default 2,4; none to skip)
  --multiview-modes    real (the real MultiViewSession with its Canvas2D NERV workers) and/or show (N concurrent show-engine workers at pane size)
  --mv-plates a,b,c,d  plates shown by Multiview (default magi,radar,seele,berserk)
  --avs-dir <dir>      bench the heaviest .avs presets of a local catalogue (--avs-max N, --avs-size WxH); --avs-synth adds 3 synthetic heavy presets
  --sync               GPU-synchronised stage timing (mode 2)        --no-stages   instrumentation off (cleanest A/B)
  --compare <dir>      another checkout's visualizer/ directory: candidate and baseline run interleaved plate by plate in one browser session
  --repeat N           rounds (default 1); with --compare the order alternates and the frames of all rounds are pooled
  --chromium <path>    browser executable (or env SHOW_CHROMIUM)     --gpu  real GPU (no SwiftShader flags)    --headed  visible window
  --browser-arg <a>    extra Chromium flag, repeatable               --pacing raf|timer   --complete / --no-complete
  --out <file>  --raw  --merge a.json,b.json
```

What it reports for every plate and size: frames delivered, the **effective fps** (delivered frames per second), **ticks missed** (a 60 Hz
tick with the previous request still outstanding: the host would present the old image again), **frames over 16.7 ms** (the 60 fps budget), p50/p95/p99/max of the
frame total, of the worker's `frame.total`, and of every stage, a frame-time histogram (edges 4, 8, 12, 16.7, 20, 25, 33.4, 50, 67, 100, 200, 500, 1000 ms), the cold start
(worker ready time and the first frame, which includes the scene build) and a check that the plate drew something (`lit`).

**Frame total.** With `--complete` (the default for software GL) a frame counts when its pixels exist: the page does a 1-pixel readback of the
canvas it just drew the bitmap on. Software GL (SwiftShader) runs the fragment shaders on the CPU inside the GPU process, so without it the
worker replies within milliseconds of *queueing* the frame and every number is meaningless. `host.complete` is that extra wait. On a real GPU the
host does not wait for the GPU (the compositor does), so `--gpu` turns it off and the total is request to reply; add `--complete` to force it.

**Pacing.** `--pacing raf` (default with `--gpu` or `--headed`) uses `requestAnimationFrame` like the host: real display cadence, and `host.raf.interval` is the
display jitter. Headless software-GL runs use a 60 Hz timer (`timer`) because the headless compositor produces frames at an arbitrary, slow rate.

**A/B.** `--compare <other visualizer dir>` builds that checkout's workers and the same harness page against it and runs candidate and baseline alternately
(order swapped every plate, and every round with `--repeat`) in one browser session, so load drift on a shared machine hits both. It prints
a delta table (negative = candidate faster). A baseline without the instrumentation (an older checkout) works: the page-side totals do not need it; per-stage columns are
then empty for it. Use `--no-stages` for the cleanest A/B of two instrumented builds.

**Multiview.** `multiview-real` runs the real `MultiViewSession` (lane clock, runtime, compositor) in the page with stub host callbacks and the real
Canvas2D NERV workers behind a probe that times every pane request; panels are held (128 bars per scene) so no scene change interrupts a run.
Multiview does not use the show engine today (it always uses the Canvas2D NERV scenes), so `multiview-show` runs 2 or 4 concurrent show-engine workers at
pane size (960x1080 for 2, 958x538 for 4; the engine still renders 1920x1080 internally and letterboxes): that is not a product path, it is what
the show engine would cost in panes. The real-Multiview numbers include the real composite on the main thread (`main` = tick plus composite per display tick).

**AVS.** The repository contains no AVS presets (the banks are private and absent from a clean checkout), so AVS benching needs the owner's catalogue:
`--avs-dir <folder with .avs files>` probes every preset for 1.5 s and benches the heaviest `--avs-max` with the real `avs-render.worker`
(CPU lane in a headless browser; WebGPU only where the browser offers it). `--avs-synth` adds three presets built in code with the repository's own
writer (8192-point dot SuperScope, four 4096-point line scopes, scopes with three heavy blurs); they exercise the EEL and blur paths, not
the real bank's mix of effects.

### Windows, real GPU (PowerShell)

```powershell
cd visualizer
npm install
node tools/bench-shows.mjs --gpu --chromium "C:\Program Files\Google\Chrome\Application\chrome.exe" --sizes 1920x1080,3840x2160 --seconds 20 --out bench.json
```

For Edge use `--chromium "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"`. Useful variants:

```powershell
# the GPU-synchronised stage breakdown (which pass is expensive)
node tools/bench-shows.mjs --gpu --chromium "C:\Program Files\Google\Chrome\Application\chrome.exe" --sync --sizes 1920x1080,3840x2160 --seconds 20 --out bench-sync.json
# a visible window with real vsync pacing, only some plates
node tools/bench-shows.mjs --gpu --headed --chromium "C:\Program Files\Google\Chrome\Application\chrome.exe" --plates magi,psycho,berserk --seconds 30 --out bench-headed.json
# a local AVS catalogue
node tools/bench-shows.mjs --gpu --chromium "C:\Program Files\Google\Chrome\Application\chrome.exe" --avs-dir "D:\avs presets" --multiview none --plates boot --sizes 1920x1080 --out bench-avs.json
# before/after an optimisation: a second checkout of the baseline next to this one
node tools/bench-shows.mjs --gpu --chromium "C:\Program Files\Google\Chrome\Application\chrome.exe" --compare ..\..\baseline\visualizer --repeat 3 --out ab.json
# readable tables from any report
node tools/bench-report.mjs bench.json > tables.md
```

Close other GPU-heavy programs first, leave the machine alone during a run, and run it twice: the second run shows the run-to-run spread.
`npm install` (playwright-core, esbuild) is all it needs; the browser is the installed Chrome or Edge. Send `bench.json` back; it holds
summaries, not per-frame traces.

### Proving the instrumentation does not change the picture

`node tools/render-show-stills.mjs --plates --per 2 --perf-identity` renders each still plain, plain again (the software renderer's own noise), with CPU stage timing and with
GPU-synchronised stage timing, and compares the frames pixel by pixel (see section 4).

<!-- BASELINE:begin -->
<!-- BASELINE:end -->
