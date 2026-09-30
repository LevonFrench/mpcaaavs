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

The first line of the output names the WebGL renderer the page got (`GL <vendor> / <renderer>`): check that it names your GPU and not SwiftShader or "Microsoft Basic Render" before trusting a run; if it does not, add `--browser-arg --use-angle=d3d11` (or `--browser-arg --use-gl=angle` and the matching `--use-angle`) and run again.
Close other GPU-heavy programs first, leave the machine alone during a run, and run it twice: the second run shows the run-to-run spread.
`npm install` (playwright-core, esbuild) is all it needs; the browser is the installed Chrome or Edge. Send `bench.json` back; it holds
summaries, not per-frame traces.

### Proving the instrumentation does not change the picture

`node tools/render-show-stills.mjs --plates --per 2 --perf-identity` renders each still plain, plain again (the software renderer's own noise), with CPU stage timing and with
GPU-synchronised stage timing, and compares the frames pixel by pixel (see section 4).

## 3. Baseline (before any optimisation)

<!-- BASELINE:begin -->
Taken with the instrumentation of commit `959620f` on branch `cloud/perf` (instrumentation only, no optimisation; the worker and engine code did not change afterwards) and stored in `docs/perf/baseline.json`, which is this section's source: 16 plates at 1080p and 4K
with CPU stage timing (10 s measured, at least 20 frames), the same 16 plates at 1080p and 7 of them at 4K with GPU-synchronised stage timing, 2 and 4 lanes of Multiview
(real and show-engine panes), and three synthetic AVS presets. The raw reports it was merged from are summaries only; `docs/perf/identity.json` is the identity run and `docs/perf/overhead-ab.json` the disabled-overhead A/B.
Regenerate the tables below with `node tools/perf-docs.mjs` after replacing `baseline.json`.

**Environment: SwiftShader on a shared 4-core Xeon, so every number is relative.** Nothing reaches 60 fps here (effective fps 0.1 to 2.1), so "dropped frames" is 100% in every row; the
useful columns are the ratios between plates, sizes and stages. How to read the two timing modes:

- *CPU timestamps* (mode 1): what the worker's CPU spends per frame. GL work is only queued here (software GL finishes it later in the GPU process), so `frame.total` is small and the GPU cost shows up in the page's `total` (request to pixels) instead.
  The worker's CPU cost is the part of this table most likely to carry over to a real machine.
- *GPU-synchronised* (mode 2): each stage waits for the GPU, so it is charged for the work it queued. This is the table to read for "which pass is expensive", with the caveat that the GPU is a software renderer on the same CPU.

### What the baseline says

1. **The worker's own CPU time is small and almost all of it is `scene.render`.** At 1080p the worker spends 2.8 to 17.8 ms per frame (p50; 3.3 to 28.6 ms at 4K). Averaged over the 16 plates
   `scene.render` is 6.9 ms (77%), `post.bloom` 0.9 ms (10%), `live.push` 0.3 ms (3%), `frame.fit` 0.3 ms (3%); the rest is under 0.2 ms each. Only `impact` is over 16.7 ms on the CPU side
   (18.7 ms mean at 1080p, 28.6 ms p50 at 4K), dominated by its Canvas2D layer: 7.5 ms of drawing plus 8.7 ms in the layer's texture upload (`gl.upload.canvas`, where the recorded 2D commands are rasterised). For the other plates the
   layers are 0.8 to 6.1 ms of drawing plus 0.4 to 5.3 ms of upload (`magi`: 4.6 + 2.3 of 9.4 ms; `alert`: 4.8 + 4.2 of 11.7 ms). The 4K worker is at most 1.7 times the 1080p one on the CPU side (`plug` 1.7, `sync` 1.7, `impact` 1.6; most plates within 20%), because the layers are drawn in logical pixels.
2. **The GPU side is what makes 4K expensive, and it is dominated by two things: the plates' own shaders, and a post chain that costs the same for every plate.** In the synchronised run at 1080p the mean frame is
   scene.render 655 ms (62%), post.final 199 ms (19%), post.bloom 107 ms (10%), engine.blit 20 ms and frame.fit 19 ms (2% each), engine.spectrum 12 ms (1%). `post.final` grows with the pixel count (156 to 220 ms at 1080p, 596 to 616 ms at 4K, in every plate) while `post.bloom`
   grows only from 80 to 118 ms to 129 to 136 ms because the pyramid is kept at logical resolution; `engine.blit` and `frame.fit` (a full-frame copy each) scale with pixels too (15 to 22 ms, then 58 to 63 ms). For the light plates (`boot`, `battery`, `target`, `end`) the post chain plus the two copies are about half of the frame (48 to 59%).
3. **One plate dwarfs the rest: `seele`.** Its `scene.render` is 3915 ms at 1080p (92% of its frame, 3.4 to 15 times the `scene.render` of any other plate) and 12.9 s per frame at 4K. Then `atfield` (1146 ms), `sync` (798), `plug` (606), `alert` (561), `city` (530); the other ten are 199 to 360 ms.
   These are shader costs on a CPU rasteriser; a GPU will rank them differently, but `seele` and `atfield` are the first two to look at on a real machine.
4. **The Compositor pass that draws a Canvas2D layer into the HDR target is a large part of `scene.render` for the layer-based plates**: `comp.draw` is 162 of 199 ms for `boot`, 252 of 281 for `end`, 330 of 561 for `alert`, 217 of 288 for `magi` at 1080p, and 513 of 608 ms for `boot` at 4K. It includes the texture upload on the layer's first use in a frame.
   (Plates that use their own pass instead of `ctx.comp`, `battery`, `sync`, `berserk`, `impact`, show no `comp.draw`; their upload is in the `layer.*.upload` rows.)
5. **4K costs 2.5 to 3.9 times the 1080p frame** (total p50, CPU-timestamp run; 2.0 to 3.3 times in the synchronised run) for a 4 times larger frame: the fixed costs (bloom, cold start, the message round trip) do not scale. `seele` (3.9x), `atfield` (3.6x) and `sync` (3.6x) scale worst in the CPU-timestamp run.
6. **Cold start** (scene build, font load, shader compile): the worker is ready in 0.19 to 0.34 s and the first frame of a scene adds 0.10 to 0.44 s in the CPU-timestamp run (0.9 to 1.4 s at 1080p and 2.2 to 3.3 s at 4K when synchronised, because every stage of that frame waits for the GPU). A scene change starts a new worker (`prepare()` in `src/mpc-host.ts`), so this cost is paid once per scene, off screen when the lookahead prepares it in time.
7. **Messaging is not a cost centre in this harness.** A render request is a 4608-byte PCM buffer plus a 2304-byte audio frame plus clock fields (about 7.2 KB, about 430 KB/s at 60 requests a second per slot); the request reaches the worker in 0.2 to 0.5 ms (p50), the reply returns in 0.1 to 0.3 ms, `live.push` costs 0.2 to 0.5 ms
   and the reply `postMessage` 0.07 to 0.5 ms. The native bridge (JSON audio messages from MPC-HC) is not part of this harness: read `host.audio.*` in a real host trace.
8. **Multiview.** Real Multiview (Canvas2D scenes, the product path): 2 lanes composite at 8.6 fps with each pane at 7.7 to 8.0 fps, 4 lanes at 7.2 fps with panes at 6.8 to 7.0 fps (15.7 pane frames a second in total for 2 lanes, 27.5 for 4). The lane clock, runtime and compositor cost 0.1 ms each per tick on the main thread;
   the ~110 to 136 ms per tick is the main thread waiting for the composite's pixels (software raster), so the real-GPU question for Multiview is the raster and composite cost of 2 to 4 panes at 1080p, which this cannot answer.
   Show-engine panes (not a product path): 2 concurrent workers deliver 1.8 frames a second in total and 4 concurrent 0.5, about 9 and 55 times fewer pane frames a second than the Canvas2D panes here (the 4-lane figure rests on 14 frames). That is the cost of putting the current show engine in panes, in software GL; it is a reason to measure it on the GPU, not a prediction.
9. **AVS** (only synthetic presets exist in the repository): the 8192-point dot SuperScope, four 4096-point line scopes, and the scopes with three heavy blurs run at 14 to 16 fps at 720p on the CPU lane, worker p50 7.6, 18.5 and 22.7 ms (`effectMs` p50 4.9, 15.6, 20.1). The real bank needs `--avs-dir` on the owner's machine.
10. **The instrumentation is free when off.** A/B of this checkout (stages off) against the commit before the instrumentation (`10517d2`), interleaved in one browser session, 2 rounds, 1080p: worker CPU p50 2.6 against 2.9 ms (`boot`), 8.4 against 8.2 (`magi`), 4.9 against 5.4 (`berserk`);
    total p50 -4.5%, +3.4%, -0.2%; all inside this machine's run-to-run spread (p95 moved by -33% to +50% between the two sides). See `docs/perf/overhead-ab.json`.

<!-- TABLES -->
Machine: Intel(R) Xeon(R) Processor @ 2.10GHz x4, linux 6.18.44-fc-v50; browser 141.0.7390.37; GL Google Inc. (Google) / ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver).
Run: 10 s measured + 1.5 s warmup per plate and size, at least 20 frames, pacing timer, completion readback on, created 2026-09-30T18:39:21.723Z.

#### 1920x1080, CPU timestamps

| plate | fps | total p50 | p95 | max | worker p50 | missed % | over 16.7 ms % | hottest stages (mean ms, share of worker mean) |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| boot | 2.1 | 471 | 561 | 580 | 2.8 | 20.0 | 100 | scene.render 1.6 (49%), post.bloom 0.8 (25%), live.push 0.2 (8%) |
| magi | 1.6 | 587 | 877 | 932 | 8.8 | 48.7 | 100 | scene.render 7.3 (78%), post.bloom 0.7 (8%), frame.fit 0.3 (3%) |
| psycho | 1.4 | 620 | 1091 | 1211 | 9.8 | 52.4 | 100 | scene.render 9.6 (79%), post.bloom 1.0 (8%), frame.fit 0.6 (5%) |
| radar | 1.3 | 672 | 1032 | 1118 | 7.6 | 52.4 | 100 | scene.render 6.6 (75%), post.bloom 1.0 (12%), live.push 0.4 (5%) |
| harmonics | 1.7 | 574 | 630 | 642 | 5.1 | 47.4 | 100 | scene.render 3.8 (63%), post.bloom 1.4 (23%), live.push 0.3 (4%) |
| seele | 0.3 | 3336 | 3553 | 3553 | 6.2 | 47.1 | 100 | scene.render 5.4 (67%), post.bloom 0.9 (12%), frame.fit 0.4 (6%) |
| battery | 1.8 | 536 | 577 | 593 | 8.1 | 50.0 | 100 | scene.render 6.5 (79%), post.bloom 0.8 (10%), post.final 0.3 (3%) |
| atfield | 0.9 | 1127 | 1192 | 1214 | 5.9 | 48.7 | 100 | scene.render 4.7 (67%), post.bloom 1.1 (15%), frame.fit 0.4 (6%) |
| alert | 1.3 | 786 | 851 | 877 | 10.6 | 54.5 | 100 | scene.render 9.7 (83%), post.bloom 0.9 (8%), frame.fit 0.3 (3%) |
| plug | 1.3 | 739 | 809 | 823 | 8.3 | 50.0 | 100 | scene.render 6.8 (77%), post.bloom 1.1 (13%), live.push 0.2 (3%) |
| target | 1.9 | 515 | 571 | 588 | 5.4 | 44.4 | 100 | scene.render 4.0 (71%), post.bloom 0.4 (8%), frame.fit 0.3 (6%) |
| city | 1.3 | 754 | 807 | 830 | 9.1 | 51.2 | 100 | scene.render 8.0 (82%), post.bloom 0.6 (6%), post.final 0.3 (3%) |
| sync | 1.2 | 660 | 1186 | 1210 | 8.7 | 52.4 | 100 | scene.render 9.5 (86%), post.bloom 0.7 (7%), live.push 0.2 (2%) |
| berserk | 1.6 | 605 | 638 | 756 | 5.0 | 47.4 | 100 | scene.render 5.9 (74%), post.bloom 0.7 (9%), live.push 0.4 (4%) |
| impact | 1.6 | 637 | 685 | 697 | 17.8 | 61.5 | 100 | scene.render 16.7 (89%), post.bloom 0.7 (4%), post.final 0.4 (2%) |
| end | 1.7 | 575 | 642 | 715 | 4.7 | 41.2 | 100 | scene.render 4.4 (68%), post.bloom 0.9 (15%), frame.fit 0.3 (5%) |

#### 3840x2160, CPU timestamps

| plate | fps | total p50 | p95 | max | worker p50 | missed % | over 16.7 ms % | hottest stages (mean ms, share of worker mean) |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| boot | 0.6 | 1614 | 1818 | 1818 | 3.3 | 20.8 | 100 | scene.render 2.1 (60%), post.bloom 0.6 (16%), live.push 0.2 (6%) |
| magi | 0.6 | 1713 | 2546 | 2546 | 7.5 | 50.0 | 100 | scene.render 7.1 (80%), post.bloom 0.6 (7%), frame.window 0.3 (3%) |
| psycho | 0.5 | 1996 | 3188 | 3188 | 8.1 | 58.1 | 100 | scene.render 10.6 (77%), post.bloom 1.7 (13%), live.push 0.6 (4%) |
| radar | 0.5 | 1970 | 2089 | 2089 | 7.6 | 40.0 | 100 | scene.render 6.3 (73%), post.bloom 1.4 (16%), live.push 0.2 (3%) |
| harmonics | 0.5 | 1845 | 1963 | 1963 | 4.9 | 48.4 | 100 | scene.render 3.8 (69%), post.bloom 0.6 (11%), live.push 0.5 (9%) |
| seele | 0.1 | 12898 | 13226 | 13226 | 7.9 | 60.0 | 100 | scene.render 17.4 (89%), post.bloom 0.6 (3%), frame.window 0.6 (3%) |
| battery | 0.6 | 1626 | 1814 | 1814 | 9.3 | 52.6 | 100 | scene.render 7.7 (81%), post.bloom 0.5 (5%), frame.fit 0.4 (4%) |
| atfield | 0.2 | 4069 | 4324 | 4324 | 8.4 | 56.3 | 100 | scene.render 10.5 (87%), post.bloom 0.6 (5%), live.push 0.3 (2%) |
| alert | 0.4 | 2295 | 2615 | 2615 | 10.9 | 60.6 | 100 | scene.render 15.5 (88%), post.bloom 1.0 (5%), live.push 0.3 (2%) |
| plug | 0.4 | 2631 | 2826 | 2826 | 14.1 | 57.7 | 100 | scene.render 12.5 (84%), post.bloom 0.8 (6%), frame.fit 0.7 (5%) |
| target | 0.6 | 1679 | 1876 | 1876 | 6.6 | 48.5 | 100 | scene.render 5.3 (73%), post.bloom 1.0 (13%), live.push 0.2 (3%) |
| city | 0.5 | 1922 | 2118 | 2118 | 10.6 | 54.5 | 100 | scene.render 9.0 (76%), post.bloom 1.6 (13%), live.push 0.3 (3%) |
| sync | 0.4 | 2358 | 3387 | 3387 | 14.9 | 60.0 | 100 | scene.render 14.8 (87%), post.bloom 0.8 (5%), post.final 0.3 (2%) |
| berserk | 0.5 | 2112 | 2254 | 2254 | 6.8 | 46.1 | 100 | scene.render 5.4 (71%), post.bloom 0.9 (12%), live.push 0.4 (5%) |
| impact | 0.5 | 1976 | 2289 | 2289 | 28.6 | 71.2 | 100 | scene.render 29.0 (93%), post.bloom 0.7 (2%), frame.bitmap 0.4 (1%) |
| end | 0.6 | 1724 | 1947 | 1947 | 3.7 | 37.0 | 100 | scene.render 4.8 (71%), post.bloom 0.7 (10%), frame.fit 0.5 (7%) |

#### 1920x1080 against 3840x2160 (CPU timestamps)

| plate | total p50 1920x1080 | total p50 3840x2160 | ratio | worker p50 1920x1080 | worker p50 3840x2160 | first frame 1920x1080 (ms) | first frame 3840x2160 (ms) |
|---|---:|---:|---:|---:|---:|---:|---:|
| boot | 471 | 1614 | 3.43x | 2.8 | 3.3 | 159 | 195 |
| magi | 587 | 1713 | 2.92x | 8.8 | 7.5 | 184 | 189 |
| psycho | 620 | 1996 | 3.22x | 9.8 | 8.1 | 327 | 441 |
| radar | 672 | 1970 | 2.93x | 7.6 | 7.6 | 153 | 151 |
| harmonics | 574 | 1845 | 3.21x | 5.1 | 4.9 | 116 | 164 |
| seele | 3336 | 12898 | 3.87x | 6.2 | 7.9 | 111 | 128 |
| battery | 536 | 1626 | 3.04x | 8.1 | 9.3 | 113 | 113 |
| atfield | 1127 | 4069 | 3.61x | 5.9 | 8.4 | 122 | 137 |
| alert | 786 | 2295 | 2.92x | 10.6 | 10.9 | 99.0 | 116 |
| plug | 739 | 2631 | 3.56x | 8.3 | 14.1 | 147 | 172 |
| target | 515 | 1679 | 3.26x | 5.4 | 6.6 | 150 | 194 |
| city | 754 | 1922 | 2.55x | 9.1 | 10.6 | 254 | 245 |
| sync | 660 | 2358 | 3.57x | 8.7 | 14.9 | 146 | 154 |
| berserk | 605 | 2112 | 3.49x | 5.0 | 6.8 | 112 | 104 |
| impact | 637 | 1976 | 3.10x | 17.8 | 28.6 | 150 | 151 |
| end | 575 | 1724 | 3.00x | 4.7 | 3.7 | 154 | 149 |

#### Per-stage mean / p95 ms, 1920x1080, CPU timestamps

| plate | frame.total | scene.render | canvas2d.draw | gl.upload.canvas | comp.draw | engine.hud | post.bloom | post.final | engine.blit | frame.fit | frame.bitmap | live.push | frame.window |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| boot | 3.18 / 5.0 | 1.57 / 2.5 | 0.80 / 1.1 | 0.43 / 0.4 | 0.58 / 0.8 | 0.03 / 0.1 | 0.81 / 1.8 | 0.10 / 0.2 | 0.06 / 0.2 | 0.13 / 0.2 | 0.04 / 0.1 | 0.24 / 0.7 | 0.07 / 0.1 |
| magi | 9.38 / 13.1 | 7.33 / 11.3 | 4.59 / 8.4 | 2.25 / 7.0 | 2.41 / 7.1 | 0.03 / 0.1 | 0.74 / 3.0 | 0.18 / 0.5 | 0.06 / 0.1 | 0.30 / 0.5 | 0.04 / 0.1 | 0.26 / 0.5 | 0.06 / 0.2 |
| psycho | 12.15 / 23.2 | 9.62 / 21.5 | 6.09 / 16.0 | 2.08 / 4.7 | 2.50 / 5.9 | 0.04 / 0.1 | 0.98 / 1.6 | 0.27 / 0.4 | 0.06 / 0.2 | 0.56 / 2.6 | 0.03 / 0.1 | 0.34 / 1.1 | 0.10 / 0.2 |
| radar | 8.80 / 21.1 | 6.64 / 14.2 | 2.99 / 6.4 | 1.94 / 6.0 | 2.41 / 8.9 | 0.03 / 0.1 | 1.03 / 3.7 | 0.27 / 0.2 | 0.04 / 0.1 | 0.12 / 0.2 | 0.05 / 0.1 | 0.43 / 0.9 | 0.07 / 0.2 |
| harmonics | 6.07 / 9.4 | 3.83 / 7.9 | 1.75 / 2.5 | 0.69 / 1.0 | 1.01 / 1.4 | 0.02 / 0.1 | 1.39 / 4.4 | 0.12 / 0.2 | 0.03 / 0.1 | 0.19 / 0.4 | 0.03 / 0.1 | 0.26 / 0.4 | 0.08 / 0.2 |
| seele | 8.03 / 26.2 | 5.38 / 21.2 | 1.31 / 1.8 | 3.13 / 16.7 | 3.53 / 19.0 | 0.02 / 0.1 | 0.93 / 3.4 | 0.21 / 0.5 | 0.09 / 0.2 | 0.44 / 1.9 | 0.01 / 0.1 | 0.31 / 0.9 | 0.16 / 0.4 |
| battery | 8.26 / 11.5 | 6.53 / 9.0 | 5.01 / 7.5 | 0.96 / 1.6 | - | 0.01 / 0.1 | 0.80 / 2.0 | 0.25 / 0.8 | 0.07 / 0.1 | 0.20 / 0.3 | 0.03 / 0.1 | 0.20 / 0.4 | 0.09 / 0.2 |
| atfield | 7.09 / 9.7 | 4.74 / 7.5 | 2.63 / 2.5 | 1.26 / 3.9 | 1.66 / 5.1 | 0.04 / 0.1 | 1.08 / 4.0 | 0.16 / 0.3 | 0.06 / 0.2 | 0.40 / 0.6 | 0.04 / 0.1 | 0.34 / 0.6 | 0.10 / 0.2 |
| alert | 11.65 / 20.9 | 9.70 / 19.6 | 4.76 / 8.0 | 4.24 / 14.5 | 4.43 / 14.7 | 0.03 / 0.1 | 0.90 / 4.1 | 0.11 / 0.2 | 0.07 / 0.2 | 0.35 / 0.3 | 0.01 / 0.1 | 0.25 / 0.4 | 0.08 / 0.2 |
| plug | 8.85 / 14.9 | 6.84 / 13.0 | 3.33 / 6.0 | 2.84 / 9.7 | 2.98 / 9.9 | 0.03 / 0.1 | 1.15 / 3.5 | 0.12 / 0.2 | 0.05 / 0.1 | 0.19 / 0.3 | 0.01 / 0.1 | 0.23 / 0.4 | 0.10 / 0.2 |
| target | 5.62 / 8.0 | 3.98 / 6.7 | 1.35 / 1.8 | 1.31 / 3.9 | 1.77 / 4.6 | 0.01 / 0.1 | 0.44 / 0.6 | 0.12 / 0.2 | 0.06 / 0.1 | 0.32 / 0.3 | 0.02 / 0.1 | 0.24 / 0.3 | 0.10 / 0.2 |
| city | 9.71 / 16.4 | 8.01 / 14.7 | 2.33 / 6.0 | 1.39 / 4.5 | 1.90 / 4.8 | 0.04 / 0.1 | 0.61 / 1.5 | 0.28 / 0.4 | 0.11 / 0.1 | 0.23 / 0.3 | 0.01 / 0.1 | 0.24 / 0.4 | 0.07 / 0.2 |
| sync | 11.04 / 24.3 | 9.52 / 23.6 | 3.68 / 7.3 | 5.28 / 20.5 | - | 0.03 / 0.1 | 0.72 / 2.7 | 0.13 / 0.2 | 0.04 / 0.1 | 0.15 / 0.3 | 0.04 / 0.1 | 0.23 / 0.3 | 0.09 / 0.1 |
| berserk | 8.07 / 13.6 | 5.94 / 9.2 | 2.77 / 6.6 | 2.46 / 6.3 | - | 0.02 / 0.1 | 0.73 / 1.1 | 0.25 / 0.4 | 0.04 / 0.2 | 0.30 / 0.4 | 0.01 / 0.1 | 0.36 / 0.3 | 0.07 / 0.1 |
| impact | 18.68 / 29.7 | 16.71 / 28.3 | 7.53 / 10.1 | 8.71 / 18.2 | - | 0.04 / 0.1 | 0.74 / 2.4 | 0.39 / 2.0 | 0.05 / 0.1 | 0.17 / 0.3 | 0.02 / 0.1 | 0.28 / 0.4 | 0.14 / 0.4 |
| end | 6.45 / 8.7 | 4.39 / 5.8 | 1.99 / 3.8 | 1.94 / 3.9 | 2.19 / 4.1 | 0.04 / 0.1 | 0.94 / 4.1 | 0.28 / 0.2 | 0.06 / 0.1 | 0.31 / 0.3 | 0.02 / 0.1 | 0.23 / 0.3 | 0.07 / 0.2 |

#### Canvas2D layers: draw and texture upload, mean ms, 1920x1080, CPU timestamps

| plate | layer | draw mean / p95 | upload mean / p95 |
|---|---|---:|---:|
| boot | boot.text | 0.79 / 1.1 | 0.39 / 0.4 |
| boot | hud | 0.01 / 0.1 | 0.04 / 0.1 |
| magi | magi.L | 4.57 / 8.4 | 2.17 / 7.0 |
| magi | hud | 0.03 / 0.1 | 0.07 / 0.3 |
| psycho | psycho.L | 6.05 / 16.0 | 1.90 / 4.6 |
| psycho | hud | 0.04 / 0.1 | 0.18 / 0.2 |
| radar | radar.L | 2.97 / 6.4 | 1.76 / 5.9 |
| radar | hud | 0.02 / 0.1 | 0.18 / 0.2 |
| harmonics | harmonics.text | 1.74 / 2.5 | 0.65 / 0.9 |
| harmonics | hud | 0.01 / 0.1 | 0.05 / 0.1 |
| seele | seele.L | 1.31 / 1.8 | 3.01 / 16.4 |
| seele | hud | - | 0.12 / 0.4 |
| battery | battery.L | 5.00 / 7.4 | 0.91 / 1.4 |
| battery | hud | 0.01 / 0.1 | 0.05 / 0.1 |
| atfield | atfield.text | 2.61 / 2.5 | 1.22 / 3.9 |
| atfield | hud | 0.03 / 0.1 | 0.04 / 0.1 |
| alert | alert.L | 4.74 / 8.0 | 4.21 / 14.5 |
| alert | hud | 0.03 / 0.1 | 0.03 / 0.1 |
| plug | plug.text | 3.32 / 6.0 | 2.77 / 9.7 |
| plug | hud | 0.01 / 0.1 | 0.07 / 0.1 |
| target | target.text | 1.34 / 1.8 | 1.27 / 3.9 |
| target | hud | 0.01 / 0.0 | 0.04 / 0.1 |
| city | city.L | 2.31 / 6.0 | 1.32 / 4.5 |
| city | hud | 0.02 / 0.1 | 0.07 / 0.1 |
| sync | sync.hud | 3.66 / 7.2 | 5.22 / 20.5 |
| sync | hud | 0.02 / 0.1 | 0.05 / 0.1 |
| berserk | berserk.hud | 2.75 / 6.6 | 2.31 / 6.2 |
| berserk | hud | 0.02 / 0.1 | 0.16 / 0.2 |
| impact | impact.L | 7.50 / 10.1 | 8.40 / 18.2 |
| impact | hud | 0.03 / 0.1 | 0.32 / 1.9 |
| end | end.L | 1.96 / 3.8 | 1.90 / 3.8 |
| end | hud | 0.03 / 0.1 | 0.04 / 0.1 |

#### Per-stage mean / p95 ms, 3840x2160, CPU timestamps

| plate | frame.total | scene.render | canvas2d.draw | gl.upload.canvas | comp.draw | engine.hud | post.bloom | post.final | engine.blit | frame.fit | frame.bitmap | live.push | frame.window |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| boot | 3.53 / 6.3 | 2.12 / 5.3 | 1.18 / 2.4 | 0.55 / 2.5 | 0.80 / 2.8 | 0.03 / 0.1 | 0.55 / 3.2 | 0.13 / 0.5 | 0.06 / 0.2 | 0.18 / 0.8 | 0.03 / 0.2 | 0.21 / 0.4 | 0.07 / 0.2 |
| magi | 8.88 / 15.3 | 7.15 / 13.6 | 4.89 / 10.6 | 1.71 / 6.3 | 1.85 / 6.6 | 0.01 / 0.2 | 0.65 / 2.1 | 0.12 / 0.3 | 0.08 / 0.3 | 0.17 / 0.5 | 0.02 / 0.1 | 0.23 / 0.7 | 0.30 / 3.1 |
| psycho | 13.80 / 59.6 | 10.65 / 56.3 | 5.90 / 28.5 | 3.60 / 24.8 | 3.71 / 25.4 | 0.04 / 0.1 | 1.75 / 8.0 | 0.15 / 0.3 | 0.15 / 0.7 | 0.14 / 0.2 | 0.01 / 0.1 | 0.59 / 1.9 | 0.15 / 0.5 |
| radar | 8.65 / 17.5 | 6.35 / 12.5 | 2.81 / 3.7 | 2.03 / 7.8 | 2.19 / 8.1 | 0.06 / 0.2 | 1.36 / 5.6 | 0.19 / 0.6 | 0.07 / 0.5 | 0.12 / 0.2 | 0.02 / 0.1 | 0.25 / 0.8 | 0.07 / 0.2 |
| harmonics | 5.54 / 12.6 | 3.80 / 7.4 | 1.88 / 3.5 | 0.85 / 2.4 | 1.06 / 2.6 | 0.06 / 0.2 | 0.61 / 1.8 | 0.19 / 0.3 | 0.04 / 0.2 | 0.15 / 0.4 | 0.01 / 0.1 | 0.47 / 3.1 | 0.06 / 0.2 |
| seele | 19.50 / 31.1 | 17.40 / 28.9 | 2.70 / 2.9 | 14.00 / 25.7 | 14.20 / 25.7 | 0.10 / 0.1 | 0.55 / 0.6 | 0.20 / 0.3 | 0.15 / 0.2 | - | 0.05 / 0.1 | 0.30 / 0.4 | 0.55 / 0.6 |
| battery | 9.41 / 18.9 | 7.67 / 16.5 | 4.98 / 10.0 | 2.21 / 11.2 | - | 0.06 / 0.2 | 0.50 / 0.9 | 0.12 / 0.2 | 0.05 / 0.1 | 0.36 / 2.4 | 0.02 / 0.1 | 0.30 / 1.6 | 0.13 / 0.8 |
| atfield | 12.17 / 37.6 | 10.54 / 35.4 | 5.06 / 22.9 | 4.20 / 11.3 | 4.40 / 11.6 | 0.06 / 0.2 | 0.59 / 0.8 | 0.16 / 0.3 | 0.10 / 0.2 | 0.10 / 0.2 | 0.06 / 0.1 | 0.27 / 0.4 | 0.13 / 0.3 |
| alert | 17.64 / 66.4 | 15.55 / 64.7 | 7.31 / 42.6 | 7.53 / 21.2 | 7.77 / 21.4 | 0.09 / 0.1 | 0.95 / 3.1 | 0.12 / 0.2 | 0.04 / 0.1 | 0.26 / 1.6 | 0.01 / 0.1 | 0.29 / 0.4 | 0.17 / 0.6 |
| plug | 14.90 / 24.5 | 12.48 / 22.9 | 4.51 / 7.5 | 6.75 / 17.4 | 6.88 / 17.6 | 0.04 / 0.1 | 0.83 / 3.8 | 0.16 / 0.4 | 0.08 / 0.1 | 0.69 / 3.7 | 0.04 / 0.1 | 0.24 / 0.4 | 0.10 / 0.3 |
| target | 7.26 / 14.8 | 5.32 / 10.2 | 2.06 / 8.0 | 1.83 / 6.3 | 2.19 / 6.2 | 0.06 / 0.3 | 0.96 / 3.7 | 0.15 / 0.5 | 0.09 / 0.8 | 0.18 / 0.6 | 0.03 / 0.1 | 0.22 / 0.4 | 0.13 / 0.7 |
| city | 11.77 / 25.8 | 8.97 / 24.2 | 2.72 / 5.4 | 2.05 / 10.8 | 2.15 / 11.0 | 0.05 / 0.1 | 1.59 / 6.9 | 0.13 / 0.3 | 0.04 / 0.1 | 0.15 / 0.2 | 0.04 / 0.1 | 0.30 / 1.0 | 0.11 / 0.3 |
| sync | 16.87 / 28.4 | 14.76 / 26.6 | 4.82 / 9.2 | 9.01 / 23.2 | - | 0.03 / 0.1 | 0.85 / 4.1 | 0.28 / 2.4 | 0.07 / 0.2 | 0.15 / 0.4 | 0.04 / 0.1 | 0.27 / 0.7 | 0.25 / 2.1 |
| berserk | 7.65 / 24.2 | 5.41 / 22.3 | 2.76 / 12.5 | 2.01 / 9.1 | - | 0.05 / 0.2 | 0.91 / 4.6 | 0.18 / 0.8 | 0.08 / 0.7 | 0.31 / 2.3 | 0.04 / 0.1 | 0.39 / 2.0 | 0.11 / 0.4 |
| impact | 31.23 / 56.8 | 28.97 / 55.1 | 9.07 / 11.7 | 19.52 / 42.9 | - | 0.05 / 0.2 | 0.73 / 1.7 | 0.35 / 3.2 | 0.06 / 0.4 | 0.25 / 2.0 | 0.43 / 6.2 | 0.33 / 0.7 | 0.28 / 1.1 |
| end | 6.84 / 28.0 | 4.83 / 26.7 | 2.38 / 8.1 | 2.01 / 18.2 | 2.24 / 18.3 | 0.04 / 0.1 | 0.67 / 3.8 | 0.12 / 0.2 | 0.04 / 0.1 | 0.47 / 5.9 | 0.03 / 0.1 | 0.31 / 0.9 | 0.16 / 0.6 |

#### Canvas2D layers: draw and texture upload, mean ms, 3840x2160, CPU timestamps

| plate | layer | draw mean / p95 | upload mean / p95 |
|---|---|---:|---:|
| boot | boot.text | 1.15 / 2.4 | 0.49 / 2.5 |
| boot | hud | 0.03 / 0.1 | 0.06 / 0.5 |
| magi | magi.L | 4.89 / 10.5 | 1.67 / 6.3 |
| magi | hud | 0.01 / 0.1 | 0.04 / 0.1 |
| psycho | psycho.L | 5.86 / 28.4 | 3.52 / 24.7 |
| psycho | hud | 0.04 / 0.1 | 0.08 / 0.2 |
| radar | radar.L | 2.77 / 3.6 | 1.97 / 7.8 |
| radar | hud | 0.05 / 0.1 | 0.05 / 0.2 |
| harmonics | harmonics.text | 1.84 / 3.4 | 0.78 / 2.3 |
| harmonics | hud | 0.04 / 0.1 | 0.07 / 0.2 |
| seele | seele.L | 2.60 / 2.8 | 13.90 / 25.5 |
| seele | hud | 0.10 / 0.1 | 0.10 / 0.2 |
| battery | battery.L | 4.94 / 10.0 | 2.14 / 11.2 |
| battery | hud | 0.04 / 0.1 | 0.06 / 0.2 |
| atfield | atfield.text | 5.01 / 22.9 | 4.13 / 11.2 |
| atfield | hud | 0.04 / 0.2 | 0.07 / 0.1 |
| alert | alert.L | 7.24 / 42.5 | 7.51 / 21.1 |
| alert | hud | 0.07 / 0.1 | 0.01 / 0.1 |
| plug | plug.text | 4.47 / 7.4 | 6.69 / 17.3 |
| plug | hud | 0.04 / 0.1 | 0.06 / 0.3 |
| target | target.text | 2.02 / 7.9 | 1.80 / 6.1 |
| target | hud | 0.04 / 0.2 | 0.04 / 0.2 |
| city | city.L | 2.69 / 5.4 | 1.97 / 10.8 |
| city | hud | 0.03 / 0.1 | 0.08 / 0.2 |
| sync | sync.hud | 4.56 / 9.2 | 8.52 / 23.2 |
| sync | sync.ovl | 0.23 / 2.5 | 0.24 / 2.9 |
| sync | hud | 0.03 / 0.1 | 0.25 / 2.4 |
| berserk | berserk.hud | 2.74 / 12.4 | 1.95 / 9.0 |
| berserk | hud | 0.03 / 0.1 | 0.06 / 0.1 |
| impact | impact.L | 9.02 / 11.6 | 19.25 / 42.8 |
| impact | hud | 0.05 / 0.2 | 0.27 / 3.1 |
| end | end.L | 2.33 / 8.1 | 1.98 / 18.2 |
| end | hud | 0.04 / 0.1 | 0.03 / 0.1 |

#### Hottest stages averaged over the 16 plates, 1920x1080, CPU timestamps

| stage | mean ms | share of worker mean |
|---|---:|---:|
| scene.render | 6.92 | 77% |
| post.bloom | 0.88 | 10% |
| live.push | 0.28 | 3% |
| frame.fit | 0.27 | 3% |
| post.final | 0.20 | 2% |
| frame.window | 0.09 | 1% |
| engine.blit | 0.06 | 1% |
| engine.hud | 0.03 | 0% |

#### 1920x1080, GL-synchronised stage timing (each stage waits for the GPU: attributes GPU time, serialises CPU and GPU)

| plate | fps | total p50 | p95 | max | worker p50 | missed % | over 16.7 ms % | hottest stages (mean ms, share of worker mean) |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| boot | 1.4 | 692 | 769 | 799 | 615 | 97.7 | 100 | post.final 214 (34%), scene.render 199 (31%), post.bloom 116 (18%) |
| magi | 1.3 | 773 | 878 | 896 | 700 | 98.0 | 100 | scene.render 288 (40%), post.final 220 (31%), post.bloom 115 (16%) |
| psycho | 1.2 | 849 | 918 | 919 | 779 | 98.1 | 100 | scene.render 360 (46%), post.final 213 (27%), post.bloom 113 (14%) |
| radar | 1.2 | 808 | 931 | 998 | 741 | 98.0 | 100 | scene.render 338 (45%), post.final 202 (27%), post.bloom 112 (15%) |
| harmonics | 1.3 | 799 | 946 | 968 | 742 | 97.8 | 100 | scene.render 311 (44%), post.final 200 (28%), post.bloom 105 (15%) |
| seele | 0.2 | 3800 | 5112 | 5112 | 3753 | 99.6 | 100 | scene.render 3915 (92%), post.final 191 (4%), post.bloom 113 (3%) |
| battery | 1.4 | 697 | 804 | 846 | 658 | 97.6 | 100 | scene.render 253 (39%), post.final 200 (31%), post.bloom 110 (17%) |
| atfield | 0.6 | 1616 | 1707 | 1707 | 1575 | 99.0 | 100 | scene.render 1146 (73%), post.final 217 (14%), post.bloom 116 (7%) |
| alert | 1.0 | 1013 | 1056 | 1056 | 969 | 98.4 | 100 | scene.render 561 (57%), post.final 211 (22%), post.bloom 113 (12%) |
| plug | 0.9 | 1059 | 1144 | 1144 | 1020 | 98.5 | 100 | scene.render 606 (59%), post.final 211 (20%), post.bloom 117 (11%) |
| target | 1.4 | 718 | 781 | 815 | 679 | 97.7 | 100 | scene.render 262 (38%), post.final 215 (31%), post.bloom 115 (17%) |
| city | 1.0 | 994 | 1077 | 1077 | 954 | 98.4 | 100 | scene.render 530 (55%), post.final 215 (22%), post.bloom 118 (12%) |
| sync | 0.8 | 1175 | 1817 | 1817 | 1134 | 98.5 | 100 | scene.render 798 (70%), post.final 171 (15%), post.bloom 93.1 (8%) |
| berserk | 1.5 | 643 | 780 | 807 | 607 | 97.5 | 100 | scene.render 305 (49%), post.final 164 (26%), post.bloom 83.3 (13%) |
| impact | 1.5 | 672 | 725 | 729 | 635 | 97.6 | 100 | scene.render 328 (51%), post.final 156 (24%), post.bloom 80.1 (12%) |
| end | 1.5 | 663 | 776 | 787 | 625 | 97.6 | 100 | scene.render 281 (44%), post.final 178 (28%), post.bloom 91.4 (14%) |

#### 3840x2160, GL-synchronised stage timing (each stage waits for the GPU: attributes GPU time, serialises CPU and GPU)

| plate | fps | total p50 | p95 | max | worker p50 | missed % | over 16.7 ms % | hottest stages (mean ms, share of worker mean) |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| boot | 0.6 | 1634 | 1804 | 1804 | 1525 | 98.9 | 100 | post.final 616 (40%), scene.render 608 (40%), post.bloom 136 (9%) |
| magi | 0.6 | 1799 | 1923 | 1923 | 1683 | 99.0 | 100 | scene.render 764 (45%), post.final 610 (36%), post.bloom 129 (8%) |
| radar | 0.5 | 1967 | 2165 | 2165 | 1849 | 99.1 | 100 | scene.render 964 (52%), post.final 607 (32%), post.bloom 130 (7%) |
| plug | 0.4 | 2678 | 2801 | 2801 | 2563 | 99.4 | 100 | scene.render 1664 (65%), post.final 599 (23%), post.bloom 135 (5%) |
| sync | 0.4 | 2372 | 3500 | 3500 | 2269 | 99.3 | 100 | scene.render 1564 (63%), post.final 613 (25%), post.bloom 133 (5%) |
| berserk | 0.5 | 2133 | 2214 | 2214 | 2021 | 99.2 | 100 | scene.render 1102 (55%), post.final 597 (30%), post.bloom 133 (7%) |
| impact | 0.5 | 2002 | 2084 | 2084 | 1882 | 99.1 | 100 | scene.render 962 (52%), post.final 596 (32%), post.bloom 130 (7%) |

#### 1920x1080 against 3840x2160 (GL-synchronised stage timing (each stage waits for the GPU: attributes GPU time, serialises CPU and GPU))

| plate | total p50 1920x1080 | total p50 3840x2160 | ratio | worker p50 1920x1080 | worker p50 3840x2160 | first frame 1920x1080 (ms) | first frame 3840x2160 (ms) |
|---|---:|---:|---:|---:|---:|---:|---:|
| boot | 692 | 1634 | 2.36x | 615 | 1525 | 1188 | 2157 |
| magi | 773 | 1799 | 2.33x | 700 | 1683 | 1180 | 2530 |
| radar | 808 | 1967 | 2.43x | 741 | 1849 | 1188 | 2575 |
| plug | 1059 | 2678 | 2.53x | 1020 | 2563 | 1440 | 3337 |
| sync | 1175 | 2372 | 2.02x | 1134 | 2269 | 1136 | 2649 |
| berserk | 643 | 2133 | 3.32x | 607 | 2021 | 987 | 2893 |
| impact | 672 | 2002 | 2.98x | 635 | 1882 | 944 | 2663 |

#### Per-stage mean / p95 ms, 1920x1080, GL-synchronised stage timing (each stage waits for the GPU: attributes GPU time, serialises CPU and GPU)

| plate | frame.total | scene.render | canvas2d.draw | gl.upload.canvas | comp.draw | engine.hud | post.bloom | post.final | engine.blit | frame.fit | frame.bitmap | live.push | frame.window |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| boot | 632.95 / 701 | 199.09 / 240 | 1.03 / 1.9 | 0.36 / 0.6 | 161.79 / 197 | 0.28 / 0.5 | 115.56 / 126 | 214.43 / 234 | 21.41 / 24.6 | 20.04 / 22.4 | 0.11 / 0.2 | 0.23 / 0.5 | 0.12 / 0.2 |
| magi | 718.88 / 801 | 287.81 / 320 | 4.26 / 6.4 | 1.50 / 2.3 | 217.24 / 249 | 0.21 / 0.3 | 114.77 / 137 | 219.51 / 249 | 22.20 / 28.1 | 21.58 / 26.4 | 0.10 / 0.2 | 0.28 / 0.6 | 0.10 / 0.2 |
| psycho | 786.39 / 822 | 360.30 / 388 | 3.31 / 3.9 | 1.45 / 3.6 | 182.26 / 197 | 0.21 / 0.3 | 113.30 / 127 | 212.84 / 230 | 21.55 / 24.3 | 20.10 / 25.1 | 0.09 / 0.2 | 0.33 / 1.2 | 0.04 / 0.1 |
| radar | 746.73 / 865 | 338.37 / 404 | 2.52 / 4.4 | 1.16 / 2.2 | 161.25 / 207 | 0.54 / 1.7 | 112.11 / 139 | 202.21 / 249 | 22.43 / 33.0 | 19.16 / 23.1 | 0.09 / 0.2 | 0.52 / 1.1 | 0.12 / 0.2 |
| harmonics | 712.15 / 868 | 311.05 / 373 | 1.75 / 2.1 | 0.93 / 1.4 | 168.92 / 205 | 0.24 / 0.4 | 104.94 / 131 | 199.63 / 242 | 21.14 / 28.2 | 19.36 / 28.1 | 0.11 / 0.2 | 0.24 / 0.3 | 0.09 / 0.2 |
| seele | 4278.30 / 5071 | 3915.00 / 4700 | 3.52 / 8.1 | 6.63 / 15.3 | 143.55 / 174 | 0.33 / 0.4 | 112.65 / 146 | 191.43 / 221 | 21.00 / 31.3 | 19.23 / 24.0 | 0.17 / 0.2 | 0.30 / 0.4 | 0.13 / 0.2 |
| battery | 654.93 / 764 | 252.69 / 310 | 3.54 / 4.6 | 1.19 / 1.8 | - | 0.29 / 0.5 | 109.64 / 145 | 200.06 / 245 | 19.23 / 24.4 | 18.93 / 22.8 | 0.09 / 0.2 | 0.38 / 1.0 | 0.09 / 0.2 |
| atfield | 1574.76 / 1670 | 1146.26 / 1214 | 3.59 / 13.5 | 3.13 / 17.2 | 216.94 / 370 | 0.26 / 0.4 | 116.22 / 132 | 216.89 / 244 | 21.32 / 23.6 | 20.41 / 27.5 | 0.12 / 0.3 | 0.54 / 3.0 | 0.27 / 2.2 |
| alert | 976.75 / 1012 | 560.75 / 598 | 4.06 / 7.5 | 2.91 / 12.3 | 330.29 / 364 | 0.24 / 0.4 | 112.58 / 134 | 211.46 / 225 | 21.32 / 27.5 | 19.47 / 25.4 | 0.11 / 0.2 | 0.25 / 0.4 | 0.06 / 0.2 |
| plug | 1029.59 / 1102 | 605.86 / 686 | 3.06 / 4.4 | 4.42 / 22.8 | 199.27 / 254 | 0.24 / 0.3 | 117.40 / 134 | 210.81 / 242 | 20.82 / 22.8 | 20.52 / 24.5 | 0.11 / 0.2 | 0.29 / 1.2 | 0.13 / 0.6 |
| target | 683.49 / 737 | 262.10 / 298 | 1.52 / 2.1 | 1.22 / 1.6 | 144.54 / 164 | 0.24 / 0.3 | 115.44 / 131 | 214.76 / 237 | 21.80 / 24.5 | 20.34 / 24.4 | 0.09 / 0.2 | 0.27 / 0.7 | 0.10 / 0.2 |
| city | 961.73 / 1039 | 529.75 / 578 | 1.88 / 2.5 | 2.01 / 14.5 | 178.16 / 203 | 0.22 / 0.3 | 117.60 / 140 | 215.40 / 247 | 21.42 / 30.4 | 19.20 / 24.4 | 0.11 / 0.2 | 0.23 / 0.4 | 0.10 / 0.2 |
| sync | 1143.16 / 1781 | 797.63 / 1487 | 3.33 / 7.8 | 4.46 / 12.3 | - | 0.34 / 0.6 | 93.14 / 154 | 171.19 / 228 | 17.74 / 30.5 | 17.49 / 31.3 | 0.13 / 0.2 | 0.22 / 0.7 | 0.11 / 0.2 |
| berserk | 629.54 / 742 | 305.37 / 365 | 2.48 / 3.1 | 1.60 / 2.2 | - | 0.24 / 0.4 | 83.31 / 97.5 | 163.73 / 206 | 16.05 / 20.7 | 17.07 / 21.0 | 0.12 / 0.2 | 0.23 / 0.4 | 0.06 / 0.2 |
| impact | 641.25 / 690 | 327.76 / 363 | 5.50 / 6.3 | 6.51 / 9.4 | - | 0.33 / 0.5 | 80.08 / 93.7 | 156.41 / 175 | 14.91 / 17.8 | 15.65 / 17.5 | 0.13 / 0.2 | 0.24 / 0.3 | 0.07 / 0.1 |
| end | 635.08 / 735 | 281.38 / 348 | 1.90 / 3.5 | 1.50 / 1.8 | 251.94 / 314 | 0.33 / 0.4 | 91.40 / 114 | 178.10 / 238 | 17.34 / 20.9 | 16.88 / 20.5 | 0.11 / 0.2 | 0.28 / 0.6 | 0.07 / 0.2 |

#### Canvas2D layers: draw and texture upload, mean ms, 1920x1080, GL-synchronised stage timing (each stage waits for the GPU: attributes GPU time, serialises CPU and GPU)

| plate | layer | draw mean / p95 | upload mean / p95 |
|---|---|---:|---:|
| boot | boot.text | 0.98 / 1.8 | 0.31 / 0.6 |
| boot | hud | 0.06 / 0.1 | 0.06 / 0.1 |
| magi | magi.L | 4.21 / 6.4 | 1.41 / 2.2 |
| magi | hud | 0.05 / 0.1 | 0.10 / 0.2 |
| psycho | psycho.L | 3.25 / 3.9 | 1.31 / 3.5 |
| psycho | hud | 0.05 / 0.1 | 0.14 / 0.2 |
| radar | radar.L | 2.46 / 4.4 | 1.05 / 2.1 |
| radar | hud | 0.06 / 0.1 | 0.10 / 0.2 |
| harmonics | harmonics.text | 1.68 / 2.1 | 0.82 / 1.3 |
| harmonics | hud | 0.07 / 0.2 | 0.11 / 0.2 |
| seele | seele.L | 3.45 / 8.1 | 6.53 / 15.2 |
| seele | hud | 0.07 / 0.1 | 0.10 / 0.1 |
| battery | battery.L | 3.50 / 4.5 | 1.10 / 1.8 |
| battery | hud | 0.04 / 0.1 | 0.09 / 0.2 |
| atfield | atfield.text | 3.54 / 13.4 | 2.99 / 16.7 |
| atfield | hud | 0.06 / 0.1 | 0.14 / 0.5 |
| alert | alert.L | 4.00 / 7.4 | 2.81 / 12.3 |
| alert | hud | 0.06 / 0.1 | 0.09 / 0.3 |
| plug | plug.text | 2.99 / 4.3 | 4.35 / 22.7 |
| plug | hud | 0.06 / 0.1 | 0.07 / 0.2 |
| target | target.text | 1.47 / 2.0 | 1.10 / 1.5 |
| target | hud | 0.05 / 0.1 | 0.12 / 0.2 |
| city | city.L | 1.83 / 2.5 | 1.89 / 14.4 |
| city | hud | 0.05 / 0.1 | 0.12 / 0.2 |
| sync | sync.hud | 2.92 / 6.0 | 4.06 / 12.2 |
| sync | sync.ovl | 0.29 / 4.7 | 0.30 / 4.8 |
| sync | hud | 0.11 / 0.4 | 0.11 / 0.2 |
| berserk | berserk.hud | 2.44 / 3.1 | 1.49 / 2.2 |
| berserk | hud | 0.05 / 0.1 | 0.12 / 0.2 |
| impact | impact.L | 5.43 / 6.3 | 6.42 / 9.3 |
| impact | hud | 0.07 / 0.1 | 0.09 / 0.2 |
| end | end.L | 1.85 / 3.5 | 1.41 / 1.4 |
| end | hud | 0.05 / 0.1 | 0.10 / 0.2 |

#### Per-stage mean / p95 ms, 3840x2160, GL-synchronised stage timing (each stage waits for the GPU: attributes GPU time, serialises CPU and GPU)

| plate | frame.total | scene.render | canvas2d.draw | gl.upload.canvas | comp.draw | engine.hud | post.bloom | post.final | engine.blit | frame.fit | frame.bitmap | live.push | frame.window |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| boot | 1527.19 / 1667 | 607.68 / 752 | 1.27 / 3.2 | 0.58 / 2.7 | 512.57 / 652 | 0.28 / 0.4 | 135.89 / 187 | 616.21 / 687 | 60.89 / 76.1 | 58.56 / 67.1 | 0.11 / 0.2 | 0.23 / 0.4 | 0.08 / 0.2 |
| magi | 1679.81 / 1814 | 763.73 / 830 | 4.67 / 12.2 | 1.61 / 6.7 | 577.22 / 644 | 0.35 / 0.9 | 129.25 / 151 | 609.93 / 692 | 59.05 / 68.2 | 62.97 / 106 | 0.13 / 0.2 | 0.29 / 0.8 | 0.07 / 0.2 |
| radar | 1869.39 / 2047 | 964.21 / 1090 | 2.81 / 3.3 | 1.92 / 6.6 | 520.35 / 620 | 0.30 / 0.5 | 129.77 / 140 | 607.35 / 652 | 57.67 / 69.3 | 57.65 / 63.5 | 0.11 / 0.2 | 0.29 / 0.7 | 0.05 / 0.2 |
| plug | 2567.86 / 2684 | 1663.64 / 1778 | 3.97 / 6.2 | 6.47 / 13.8 | 516.01 / 636 | 0.34 / 0.5 | 134.75 / 164 | 598.55 / 656 | 58.10 / 67.1 | 57.12 / 61.7 | 0.15 / 0.3 | 0.35 / 1.7 | 0.35 / 2.9 |
| sync | 2487.43 / 3389 | 1564.14 / 2427 | 3.96 / 5.8 | 6.80 / 13.6 | - | 0.43 / 0.8 | 132.58 / 150 | 612.83 / 694 | 58.82 / 67.4 | 56.88 / 71.3 | 0.13 / 0.2 | 0.34 / 0.8 | 0.15 / 0.5 |
| berserk | 2007.66 / 2084 | 1102.46 / 1205 | 2.94 / 13.2 | 1.89 / 10.1 | - | 0.33 / 0.5 | 132.51 / 162 | 596.54 / 636 | 59.98 / 74.7 | 58.39 / 72.0 | 0.13 / 0.3 | 0.26 / 0.4 | 0.06 / 0.2 |
| impact | 1857.79 / 1963 | 961.74 / 1071 | 7.57 / 11.3 | 16.64 / 27.0 | - | 0.29 / 0.4 | 129.55 / 160 | 596.44 / 649 | 57.78 / 72.7 | 59.92 / 95.1 | 0.21 / 1.5 | 0.25 / 0.5 | 0.09 / 0.2 |

#### Canvas2D layers: draw and texture upload, mean ms, 3840x2160, GL-synchronised stage timing (each stage waits for the GPU: attributes GPU time, serialises CPU and GPU)

| plate | layer | draw mean / p95 | upload mean / p95 |
|---|---|---:|---:|
| boot | boot.text | 1.19 / 3.1 | 0.48 / 2.6 |
| boot | hud | 0.08 / 0.1 | 0.10 / 0.2 |
| magi | magi.L | 4.59 / 12.1 | 1.51 / 6.6 |
| magi | hud | 0.08 / 0.2 | 0.10 / 0.3 |
| radar | radar.L | 2.75 / 3.2 | 1.81 / 6.5 |
| radar | hud | 0.06 / 0.1 | 0.11 / 0.2 |
| plug | plug.text | 3.89 / 6.2 | 6.37 / 13.6 |
| plug | hud | 0.08 / 0.1 | 0.10 / 0.2 |
| sync | sync.hud | 3.66 / 5.7 | 6.57 / 13.5 |
| sync | sync.ovl | 0.22 / 2.4 | 0.15 / 1.7 |
| sync | hud | 0.08 / 0.2 | 0.08 / 0.2 |
| berserk | berserk.hud | 2.88 / 13.2 | 1.72 / 9.4 |
| berserk | hud | 0.06 / 0.2 | 0.16 / 0.7 |
| impact | impact.L | 7.52 / 11.2 | 16.53 / 26.9 |
| impact | hud | 0.05 / 0.1 | 0.11 / 0.2 |

#### Hottest stages averaged over the 16 plates, 1920x1080, GL-synchronised stage timing (each stage waits for the GPU: attributes GPU time, serialises CPU and GPU)

| stage | mean ms | share of worker mean |
|---|---:|---:|
| scene.render | 655.07 | 62% |
| post.final | 198.68 | 19% |
| post.bloom | 106.88 | 10% |
| engine.blit | 20.10 | 2% |
| frame.fit | 19.09 | 2% |
| engine.spectrum | 11.59 | 1% |
| live.push | 0.30 | 0% |
| engine.hud | 0.28 | 0% |

#### Multiview

| run | fps | per-pane fps | main p50 / p95 / max (ms) | pane total p50 / p95 | over 16.7 ms % |
|---|---:|---|---|---|---:|
| multiview-show 2 lanes (columns: magi+radar) | 1.8 | magi 0.9, radar 0.9 | - | 1055 / 1223 | 100 |
| multiview-show 4 lanes (grid: magi+radar+seele+berserk) | 0.5 | magi 0.0, radar 0.2, seele 0.2, berserk 0.2 | - | 4451 / 8438 | 100 |
| multiview-real 2 lanes (columns: magi+radar) | 8.6 | magi 8.0, radar 7.7 | 112 / 134 / 163 | 2.1 / 122 | 100 |
| multiview-real 4 lanes (grid: magi+radar+seele+berserk) | 7.2 | magi 6.8, radar 6.9, seele 7.0, berserk 6.9 | 136 / 148 / 155 | 1.6 / 3.5 | 100 |

#### AVS

| preset | size | fps | total p50 / p95 / max | worker p50 | effectMs p50 | over 16.7 ms % |
|---|---|---:|---|---:|---:|---:|
| synth-dots-blur-heavy.avs | 1280x720 | 14.4 | 62.6 / 96.7 / 103 | 22.7 | 20.1 | 100 |
| synth-lines-4x4k.avs | 1280x720 | 15.6 | 62.5 / 71.6 / 86.3 | 18.5 | 15.6 | 100 |
| synth-dots-8k.avs | 1280x720 | 15.9 | 61.1 / 71.5 / 85.1 | 7.6 | 4.9 | 100 |


<!-- /TABLES -->
<!-- BASELINE:end -->

## 4. The instrumentation does not change the picture

Two proofs, both run against the software renderer (SwiftShader), which is deterministic enough to compare frames:

1. **Show dialect** (`node tools/render-show-stills.mjs --plates --per 2 --only boot,magi --perf-identity`): each still is rendered plain, plain again, with CPU stage timing, and GPU-synchronised.
   Result on 4 stills: plain-rerender difference 0 levels, instrumented difference 0 levels (0.000% of pixels) in both modes, and every instrumented frame carried 18-20 stages.
2. **NERV preset dialect, the path the hosts use** (`node tools/bench-shows.mjs --identity`): every plate's 10 frames (fixed media times, the same audio frames) go through a fresh worker with stage
   timing off, CPU timestamps, GPU-synchronised, and off again (the renderer's own run-to-run noise); the last frames are compared pixel by pixel.
   Result on all 16 plates at 1080p: 10 plates are bit-identical in every run (difference 0). Six plates (radar, atfield, alert, target, sync, berserk) are not bit-exact from one run to the next even
   with instrumentation off, by at most 7 levels (of 255) on at most 0.017% of the pixels; with instrumentation on the differences are the same size (at most 7 levels, at most 0.039% of
   the pixels), so the worst difference caused by the instrumentation (7 levels) equals the noise floor of the plain renderer (7 levels). Frames with instrumentation off carried 0 stages.

The CPU checks (`npm run check`) cover the other half: `tools/check-perf-trace.mjs` proves the profiler is off on import, patches nothing while off, never calls the GPU while off,
that every call site is guarded by one boolean, and that turning it on patches the four GL upload entry points on the context instance only and turning it off restores them;
`tools/check-perf-host.mjs` proves the host adds no field to any message and records nothing while off.
What a CPU check cannot prove is pixel identity (there is no GL context): that is what the two browser runs above are for.

## 5. What cannot be measured without a real GPU

Everything above was measured with SwiftShader (Chromium's software Vulkan/GL) on a shared 4-core CPU. The numbers are **relative**: ratios between plates, stages and sizes, and before/after comparisons on the same
machine in the same run. What this environment cannot tell you:

- **Real shader cost.** SwiftShader runs the fragment shaders on CPU threads inside the GPU process. The ranking of passes (bloom pyramid, final grade, plate shaders) on a GPU follows fill rate,
  bandwidth and texture cache behaviour, not CPU ALU cost; the absolute frame times here (hundreds of milliseconds at 1080p) say nothing about a GPU frame. Expect the *order* of the big stages to carry over, not their sizes.
- **CPU/GPU pipelining and latency.** How many frames a worker can queue ahead, compositor back-pressure, present cost and real vsync cadence (`host.raf.interval` jitter) need a real display path. The headless run paces with a timer and
  waits for each frame's pixels (`host.complete`), which a real host does not do; that is also why the GPU-synchronised mode (2) exists: it is the only way to see per-pass cost, and on a GPU it is much closer to the truth than here.
- **Canvas2D and texture upload cost.** Upstream puts each Canvas2D layer upload at 2-4 ms on a GPU. Here Canvas2D is rasterised in software and the upload is a memory copy, so `canvas2d.draw` and `gl.upload.canvas` are not representative in size (their share of
  the frame, and which plates are dominated by their layer, are the informative part).
- **GPU time itself.** There are no GPU timestamp queries in this environment; on a real GPU the GPU-synchronised stage times are the nearest thing.
- **The native bridge.** The MPC-HC WebView2 bridge (native audio messages as JSON with up to 64 PCM frames each, the ack round trip, `postMessage` to the page) does not exist in a headless browser. The bench emulates the page-side
  costs only (real `AvsAudioAnalyser`, one render request per tick, structured clone of the audio frame); the message counters and `host.audio.msg` must be read from the real host (Ctrl+Alt+P, then Ctrl+Alt+Shift+P for the trace).
- **Adaptive quality.** The render-size governor reacts to frame cost and so changes what a run measures; the bench bypasses it (explicit sizes). It is part of what a real-machine run through the host shows.
- **4K on a real display**, display scaling, power and thermal behaviour, multi-GPU laptops (`powerPreference: "high-performance"`), and WebGPU (the AVS lane) need the owner's machine.
- `render-show-stills.mjs --timing` and the show dialect's `sync: true` call `gl.finish()`, which Chromium implements as a flush, not a wait: their numbers (a few milliseconds per plate) measure command submission, not the frame. Use `--sync` of the bench (a real wait).

