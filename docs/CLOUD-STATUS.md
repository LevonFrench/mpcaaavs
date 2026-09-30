# Cloud status

State of the cloud branches at the end of the session. Pushed branches only; nothing was pushed to
`aaavs-integration`, `main` or `develop`, and nothing was force-pushed.

`aaavs-integration` is now `d6e00e2`. `cloud/sprite-layer`, `cloud/show-hosts` and `cloud/perf` all branch from
`10517d2`, so the owner's three newer commits (`14af214`, `2627324`, `d6e00e2`) still have to be merged into each.

Unless noted, the final commands ran from `visualizer/` on the SHA listed. They ran in a Linux container with
headless Chromium on SwiftShader (software WebGL). Frame timings from these runs are relative, not real-GPU numbers.

| Task | Branch | Final SHA | Status |
| --- | --- | --- | --- |
| 5 Sprite layer and choreographer | `cloud/sprite-layer` | `badf8c3` | done |
| 6 Show hosts (a packs, b 4K, c Multiview, d meters) | `cloud/show-hosts` | `07878e7` | done; (c) and (a) unverified in a real browser |
| Perf phase 1 (measure, baseline) | `cloud/perf` | `ef1684b` | partial: measured; no optimisations yet |
| 7 Track info | none (`cloud/track-info` not created) | none | not started |

## Task 5: sprite layer and choreographer

- **Branch:** `cloud/sprite-layer`, final SHA `badf8c35b1123562561e3186dc24afbe73a3aa61`.
- **Status:** done. A subagent implemented it; the coordinator verified the checks and reviewed the stills.
- **What works:**
  - **Engine:** the sprite layer in `src/show/sprite/` (atlas upload, nearest sampling, anchor/trim/facing, palette swap
    with index and palette textures, additive and screen blending), and the integer pixel-scaling policy with a themed
    border (sharp-bilinear available).
  - **Timing:** clip retiming (loops on beats, one-shots native, hitstop 4–12 ticks), all 13 motion models, and the
    choreographer (look-ahead so big frames land on their events, call and response, plate mode chosen by section
    role, perform-never-simulate).
  - **Show pieces:** HUD-as-meters primitives, a procedural test pack, and the demo show `src/shows/pixel-stage/`
    (6 plates).
  - **Tooling:** the `--show` option in the still renderer, and additive manifest fields (`indexed`, `trims`,
    `parts`), with `version` still 1.
  - **Stills:** `.show-stills/sprite/`, 1080p and 4K crops.
- **Commands run** (coordinator, at `badf8c3`):
  - `npm run check`: PASS
  - `npm run build`: PASS
  - `npm run build:player`: PASS
  - `node tools/check-sprite-layer.mjs`: PASS. 553,191 assertions; 1,517 choreographed actions; worst big-frame error
    1.000 tick at 60 Hz sampling (0 s analytically); 23,780 seek-vs-play frames match.
  - `node tools/check-show-determinism.mjs`: PASS
  - `node tools/check-asset-packs.mjs`: PASS
  - Subagent only: `render-show-stills.mjs --show pixel-stage --determinism`, max difference 0.
- **Unfinished / next step:** none for the task scope. The next step is merging `aaavs-integration` (`d6e00e2`) into
  the branch, then an owner look at the stills and a real pack.
- **Native (C++) changes:** none.
- **Unverified:** a real extracted PNG pack, including the indexed-PNG decode path; WebView2 and native hosts; a real
  GPU.

## Task 6: show hosts

- **Branch:** `cloud/show-hosts`, final SHA `07878e73e38d4c8023eb0a370b37ec521ddab462`.
- **Status:** done. (a) and (d) came from a subagent branch (`local/hosts-ad`, merged, never pushed separately); the
  coordinator did (b) and (c).
- **(a) Asset packs:**
  - The device-local setting (`?pack=<id>`, `localStorage["mpcaaavs.showPack"]`) holds a pack id, never a path.
  - The MPC host reads `visualizer/show-assets-private/<id>/` next to the page. The Player reads packs through
    read-only library-server operations: `--show-packs <dir>`, bounded sizes, symlinks refused.
  - A `show-pack` worker message and a registry that plates read through `getShowPack()`.
  - Packs also reach Multiview show lanes. Never bundled or packaged.
- **(b) Native 4K:**
  - The engine scale follows the resolution governor: scale 2 above 1.25× 1080p, so the High tier is supersampled
    from 4K and the Native tier is native 4K.
  - The host starts the worker at the governor's scale. Later changes are debounced over 20 requests and rebuild the
    engine in place on the same WebGL context.
  - A fence-based GPU pacer keeps at most one frame in flight, so latency stays bounded when the GPU falls behind.
- **(c) Multiview:** NERV lanes start on the show engine at the pane's scale (`MultiViewWorkerHost.sceneWorker`), so a
  wall can run four shows at once.
- **(d) Meters:**
  - Optional `SongMapJSON.beatsPerBar`.
  - The analyzer estimates 3 vs 4, and a 3/4 waltz fixture is gated in the checks.
  - The live grid, preset windows and predicted onsets follow the meter.
- **Commands run** (coordinator, at `07878e7`):
  - `npm run check`: PASS
  - `npm run build`: PASS
  - `npm run build:player`: PASS
  - `python3 ../tools/check-release-package.py`: PASS
  - `SHOW_CHROMIUM=/opt/pw-browsers/chromium node tools/smoke-show-preset.mjs`: PASS. The governor case's scale
    trace is `[[0,1280,1280,1],[39,3840,3840,2],[98,1920,1920,1]]`: scale 1, then native 4K from the scale-2 engine,
    then back to scale 1.
- **Unfinished / next steps:**
  - Merge `aaavs-integration` (`d6e00e2`) into the branch. Expect conflicts in `mpc-host.ts` near `prepare()`, because
    owner commit `14af214` changed NERV show-engine start-up timing.
  - Run a 4-lane NERV Multiview wall in the real Player page and in WebView2.
  - Select a real pack in both hosts.
- **Native (C++) changes:** none. The pack wiring uses the existing `aaavs.invalid` mapping, and meters need nothing
  native.
- **Unverified:**
  - Multiview show lanes (c): CPU checks only; no real Multiview page was rendered.
  - Pack delivery in a browser or WebView2 (fake decoders in the checks).
  - The 3/4 estimate beyond one synthetic waltz. A 96 BPM waltz locked to double tempo in a scratch run; this is
    documented in `docs/SONG-MAP.md`.
  - Real-GPU behaviour of the scale switch and the pacer.
- **Stuck on:**
  - The 4K switch took several attempts. A nested worker holding a second WebGL context stalled Chromium.
  - The real root cause was unbounded GPU queueing: frames were submitted but never waited for. The fence pacer fixed
    it.

## Perf, phase 1: measure

- **Branch:** `cloud/perf`, final SHA `ef1684b1d781d61a560842adfe53616ec5b52c82`.
- **Status:** partial. Instrumentation, the benchmark tool and the baseline are done. Phase 2 (optimisations measured
  A/B, pixel-identical) was not started.
- **What works:**
  - **Instrumentation:** per-stage timing that is off by default.
    - Worker stages: frame, plates, fit, transition, bitmap, live push.
    - Engine stages: composite, scene, HUD, post, bloom, final, blit.
    - Per-layer Canvas2D draw and texture upload.
    - Host stages: round trip, present, rAF, audio messaging.
    - Toggles: `?perf=`, `localStorage["mpcaaavs.perf"]`, Ctrl+Alt+P (cycle modes) and Ctrl+Alt+Shift+P (JSON trace),
      plus an overlay segment.
  - **Benchmark:** `tools/bench-shows.mjs`: 16 plates at 1080p and 4K, Multiview with 2 and 4 lanes, synthetic AVS
    presets, `--compare` for interleaved A/B, and `--gpu --chromium <path>`.
  - **Baseline:** `docs/PERFORMANCE.md`, `docs/perf/baseline.json`.
  - **Identity:** instrumentation changes no pixel beyond the plain renderer's own noise floor
    (`docs/perf/identity.json`), and disabled overhead is within run-to-run spread (`docs/perf/overhead-ab.json`).
- **Commands run** (coordinator, at `ef1684b`):
  - `npm run check`: PASS
  - `npm run build`: PASS
  - `npm run build:player`: PASS
  - Subagent: `smoke-show-preset.mjs` PASS; `check-perf-trace` (715 assertions) and `check-perf-host` (25) run inside
    `npm run check`.
- **Baseline findings** (SwiftShader, relative only):
  - Worker CPU per frame is 2.8–17.8 ms, mostly `scene.render`.
  - GPU-side, the scene takes 62%, final post 19% and bloom 10%.
  - Heaviest plates: seele (3.9 s per software frame), then atfield, sync, plug, alert and city.
  - impact is the only plate CPU-bound on Canvas2D: 7.5 ms draw plus 8.7 ms upload.
- **Next steps:**
  1. The owner runs, on the GPU machine and twice plus once with `--sync`:
     `node tools/bench-shows.mjs --gpu --chromium "C:\Program Files\Google\Chrome\Application\chrome.exe" --sizes 1920x1080,3840x2160 --seconds 20 --out bench.json`.
  2. Take a real-host trace with Ctrl+Alt+P, then Ctrl+Alt+Shift+P.
  3. Start phase 2 with A/B runs (`--compare <baseline>/visualizer --repeat 3`):
     - skip the letterbox copy when the render size equals the engine size;
     - drop `preserveDrawingBuffer`;
     - cache static Canvas2D layers, starting with impact;
     - reduce seele's scene cost;
     - bring in the GPU pacer from `cloud/show-hosts`.
- **Native (C++) changes:** none.
- **Unverified:** everything on a real GPU; host instrumentation inside real WebView2 and the Player (fake-DOM check
  only); the owner's real AVS bank (`--avs-dir`).

## Task 7: track metadata

- **Branch:** none (`cloud/track-info` was not created). **Status:** not started. It was added to
  `docs/CLOUD-HANDOFF.md` by owner commit `14af214` during the session, never started, and left alone under the
  wind-down rule.
- **Next step:** create `cloud/track-info` from `aaavs-integration` and follow `docs/CLOUD-HANDOFF.md` Task 7, starting
  with the shared `src/track-info.ts` contract and the Player tag parser. The MPC bridge message in `AAAVSView.cpp`
  will be UNCOMPILED C++ and must be built on the owner's machine.

## Earlier branches (tasks 1–4)

`cloud/nerv-show-engine`, `cloud/song-map`, `cloud/show-asset-packs` and `cloud/integration` were verified by the
owner on Windows and fast-forwarded into `aaavs-integration` (`10517d2`). They need no further work.

## Native (C++) changes that are UNCOMPILED

None on the branches above. The only C++ change in this effort, the `AAAVSView` resize fix from
`cloud/multiview-repairs`, was compiled by the owner with MSBuild before `10517d2`.
