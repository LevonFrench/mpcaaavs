# Render resolution pipeline: how AAAVS picks pixels, why NERV is soft, and the fix

Status: design, 2026-09-28. Read-only investigation of `visualizer/src/`, `src/mpc-hc/` and `visualizer/tools/`.
No GPU work, browser, player, server, profiler or renderer was run. Everything tagged **[EXISTS]** was read from source in the
current working tree (several files are uncommitted, so line numbers drift). Everything tagged **[PROPOSED]** does not exist.
Numbers marked *estimate* are arithmetic or extrapolation, not measurements. No visual, GPU or live acceptance is claimed.
Nothing in this design is a fuzzy judgment: preset kind, design canvas and pixel-art status are authored manifest data.

Related designs: [Transitions V2](TRANSITIONS-V2.md) (transition surfaces and the `u` hairline unit),
[Timing system V2](TIMING-SYSTEM-V2.md) (native `Settings()`/`Preferences()` additions and menu IDs, FPS overlay),
[Preset browser V2](PRESET-BROWSER-V2.md) (`hud` catalog kind), [HUD research gaps](HUD-RESEARCH-GAPS.md) (pixel grids, EQ4/F2),
[HUD animation beds](../HUD-ANIMATION-BEDS.md), [shared development rules](../AAAVS-SHARED-DEVELOPMENT.md).

## 1. Summary

1. **Today one hard-coded number decides everything.** `mpc-host.ts` renders every preset kind on a 640-wide surface
   (`render()`, line 176), presents it with nearest-neighbour sampling (`imageSmoothingEnabled = false`, line 364, plus CSS
   `image-rendering: pixelated`), and caps the visible canvas at 1920x1080 (lines 352-353). DPR, tiers, preset kind and window aspect
   only affect the *present* canvas; the *render* surface is 640 x (at most 640).
2. **NERV is fuzzy for three stacked reasons.** (a) The 960x540 design is rasterised at scale 0.667, so 11 px labels are 7.3 px and
   1 px hairlines are 0.67 px. (b) That raster is then enlarged by nearest neighbour by 2x, 3x, 4x or 6x (or downscaled by 0.75x on
   a 480x480 view), which turns antialiased vector edges into blocks. (c) On fractional DPR and non-16:9 views the two resamples
   compound, and unevenly (3-px and 4-px blocks). Section 3 quantifies five displays.
3. **A verified good-news finding.** The NERV scene code is already scale-invariant. A CPU probe recorded all 16 scenes at 7 surface
   sizes; after removing the background clear and the letterbox `translate`/`scale`, the logical drawing streams were identical in 96 of 96
   comparisons. Raising the surface size therefore makes text and lines sharper with no scene edits. The remaining scene work is
   *crispness at fractional scales* (device-pixel snapping), not layout.
4. **The fix is a pure policy module** `visualizer/src/render-resolution.ts` (section 5) that decides render size, present canvas,
   smoothing, integer scale and the design-canvas transform from (CSS size, DPR, kind, quality tier, pixel-art traits, budget).
   NERV/HUD vector scenes render at device resolution with smoothing. Retro pixel-art HUDs render on their native grid and are
   presented with integer nearest-neighbour scaling. **AVS classic is bit-for-bit unchanged** (a legacy-parity fuzz of 5,000 sizes passed
   in a scratch prototype); crisp and high AVS are opt-in and delegate to the shipped Studio policy in `avs-presentation.ts`.
5. **Five quality tiers**: Auto (default, starts at High, governor may step down), Performance 1280x720, Balanced 1920x1080,
   High 2560x1440, Native 3840x2160 (hard cap 8,294,400 px). Cost is unmeasured, so Auto never exceeds High and Native is explicit.
6. **Not part of this change**: the Studio, projector and offline paths (untouched, they keep their own policy); GPU/AVS shader
   code; golden hashes (never re-recorded).

## 2. How pixel dimensions are decided today **[EXISTS]**

### 2.1 Map

```
window / WebView2 bounds (physical px, per-monitor DPI v2)         src/mpc-hc/AAAVSView.cpp:122-127,235; src/mpc-hc/res/mpc-hc.exe.manifest:40-41
  -> page CSS box (canvas 100% x 100%)                                mpc.html:6; standalone.html #stage
  -> mpc-host render(): width=640, height=clamp(640*cssH/cssW, 64, 640)          mpc-host.ts:176   (CSS px, no DPR)
  -> worker:  AVS  -> runtime.resize + OffscreenCanvas + WebGPU packed-u32 terminal   avs-render.worker.ts:172-178,250-301
              NERV -> clamp 1280x720 -> 1..3 OffscreenCanvases -> transferToImageBitmap  nerv-render.worker.ts:29-57
  -> main thread bitmap (640xH)
  -> composite canvas (bitmap size) [+ AvsTransition on main thread]            mpc-host.ts:356-362
  -> FlashGate.present(): probe 256x144, then drawImage(composite,0,0,cw,ch)    mpc-host.ts:365; flash-gate.ts:22-23,70-98
        cw,ch = round(cssW*s), round(cssH*s), s = min(dpr, 1920/cssW, 1080/cssH)   mpc-host.ts:352-353
        imageSmoothingEnabled=false                                             mpc-host.ts:364
  -> compositor stretch of the cw x ch canvas to the physical box, image-rendering: pixelated
```

### 2.2 MPC host (`visualizer/src/mpc-host.ts`)

| # | Fact | Where |
| --- | --- | --- |
| H1 | `render()` hard-codes `width = 640`, `height = max(64, min(640, round(640 * clientHeight / max(1, clientWidth))))` for every kind. It reads CSS pixels; DPR is not consulted. | 176 |
| H2 | AVS `load` always sends `width: 640, height: 360, gpuLane: 'exact'`. For any view that is not 16:9 the first `render` changes the height, so the preset pays warm-up at 640x360 and then `runtime.resize` + `executor.reset()` (feedback state cleared). | 252; `runtime.ts:55-60`; `avs-render.worker.ts:172-178` |
| H3 | A 480x480 view renders 640x640 (409,600 px, 1.78x the Studio's 230,400 px cap), which is then shrunk to 480x480 by nearest neighbour. | 176, 352-365 |
| H4 | No debounce: every dispatch recomputes `height` from `clientHeight`, so a window drag resets AVS state on each step. The Studio debounces dimensions for 250 ms (`AvsDimensionsDebouncer`). | 176; `avs-presentation.ts:476-506` |
| H5 | Present canvas = uniform fit to at most 1920x1080 device pixels; the CSS box stretches it the rest of the way. | 352-353, 363 |
| H6 | Every present copies the newest bitmap into a `composite` canvas (`cc.drawImage(active.bitmap, ...)`), even with no transition, then draws `composite` to the display. One extra full-frame blit per frame. | 36, 356-362 |
| H7 | Smoothing off in JS *and* CSS: nearest neighbour end to end. Vector NERV plates are treated like pixel art. | 364; `mpc.html:6`; `standalone.html` (inline CSS) |
| H8 | Clocked NERV to NERV changes are blended inside the incoming scene's worker and the outgoing slot is disposed. Auto (non-clocked) changes use a main-thread `AvsTransition` between two slots. | 214-217; `nerv-render.worker.ts:42-55` |
| H9 | Scene-clock lookahead starts a second worker up to `min(2 s, 240/bpm, duration/4)` before a boundary. With Auto transitions on and a style other than Cut, the prepared slot renders its first frame at blend 0, which takes the blended (3-surface) path. | 106; `nerv-render.worker.ts:42` |
| H10 | The AVS worker reports a real `renderMs`; the NERV worker reports `renderMs: 0`, and the host runs no governor for either. There is no cost feedback. | `avs-render.worker.ts:232`; `nerv-render.worker.ts:57` |

### 2.3 NERV worker and scene drawing

- **Worker.** Width/height are clamped **independently** to 1280 and 720 (`nerv-render.worker.ts:29`), which distorts aspect for any
  request that exceeds one axis (unreachable today because the host asks for at most 640). It keeps three `OffscreenCanvas`
  surfaces (`canvas`, `oldCanvas`, `nextCanvas`, lines 13, 43-44) that are never released after a transition ends, and
  `AvsTransition` adds `mask` and `tile` (1x1 until Dot Dissolve, `mpc-transition.ts:39-40`). A blended frame renders two scenes and a
  composite (lines 46-54). Output leaves via `transferToImageBitmap` (line 56).
- **Scenes.** `renderNervScene()` draws in a 960x540 logical space: `scale = min(width/960, height/540)`, `translate((width-960*scale)/2, ...)`,
  `scale(scale, scale)`, clip to the design rectangle (`nerv-scenes.ts:386-388`). Verified by CPU probe: **the 16 scenes emit
  identical logical op streams at 640x360, 1280x720, 1920x1080, 2560x1440, 3840x2160, 1920x900 and 480x480** once the background
  `fillRect(0,0,width,height)` and the letterbox `translate`/`scale` are removed (96/96 comparisons). All fonts (9 to 164 logical px) and
  line widths (1 to 5 logical px, `plug` adds a dynamic `1 + depth*low*3`) are logical. There is no `measureText`, no absolute
  device-pixel constant and no `ctx.scale` other than the entry transform and the `title()` squeeze.
- **What is missing for crispness.** No pixel snapping of hairlines, rectangles, clip edges or text baselines; the letterbox offset is
  fractional in general (for example 1918x960 gives x = 105.67); hairlines are `S` device px wide with `S` rarely an integer; no text
  rendering hints; 9 to 11 px labels (`RAW AVS 576` is 9 px, line 152) are marginal below `S` of about 1 (estimate).
- **Draw-call load.** 178 to 635 draw calls per frame (mean about 317; `fill`, `stroke`, `fillRect`, `strokeRect`, `fillText`), independent of
  resolution. The resolution-dependent part is the full-surface clear plus panel/hex fills.

### 2.4 AVS worker and the exact lane

- The CPU compatibility executor fills a full `Uint32Array(w*h)` framebuffer each frame; the `'exact'` GPU lane is a **terminal suffix of
  byte-exact passes** over a packed-u32 resident buffer that is uploaded every frame (`uploadExecuteAndPresent`,
  `avs-render.worker.ts:221-225`). Every pass takes width/height as parameters (`gpu-frame-graph.ts:205,453,511,579`), so exactness is
  **not size dependent in semantics**, only in cost and allocation.
- Size-dependent mechanics: `runtime.resize` reallocates the framebuffer and resets executor state (`runtime.ts:55-60`);
  `ensureSurface` calls `gpuGraph.resize` which reallocates the two resident buffers and requires recompiling every size-baked pass
  (`gpu-frame-graph.ts:836-859`; worker `176-178`). Resident GPU bytes are `surfaces x 4` per pixel (`gpu-surface-plan.ts:175`).
  Passes dispatch one-dimensionally, `ceil(w*h/256)` workgroups (`gpu-frame-graph.ts:1100,1140,1194,1245,1295`), so the WebGPU default
  limit of 65,535 workgroups bounds a frame at about 16.7 Mpx; the proposed hard cap of 8.3 Mpx is safely inside it, and
  `planPackedAvsFrameGraph` rejects a frame above `maxStorageBufferBindingSize` (`gpu-frame-graph.ts:684-689`).
- Golden coverage is only 317x179 (fast) and 640x360 plus 317x179 (full) (`avs-corpus-render-check.ts:52-53`). No other size is hash gated.
- Effects that are defined in absolute pixels (kernel taps in Convolution/Blur, Water neighbours, one-pixel movement shifts, Texer sprites at
  `bitmap.width` px, `texer.ts:129-142`, Text in px, SuperScope 1 px lines) look finer and sparser at higher resolution. That is a look change,
  not a correctness defect. `beat-particle.ts:186` scales count by area.
- The host pins `gpuLane: 'exact'`; the approximate `'120'` lane is not used by MPC-HC or the Player.

### 2.5 Presentation, transitions and the flash gate

- `FlashGate.present()` downsamples the source to a 256x144 probe every present (`flash-gate.ts:22-23,102-121`, bilinear at the context's
  default quality) and then draws through a callback; it resets the limiter if the callback resized the canvas (line 96). The probe cost is
  independent of source size, but its *sampling* is not: a 1920x1080 source is reduced 7.5x with four-tap bilinear (2.5x today, 15x at 4K).
- `AvsTransition.draw` forces `imageSmoothingEnabled = false` (`mpc-transition.ts:47`). The Center Squeeze mode (case 9) scales bitmaps with nearest
  neighbour, which will alias vector content at native size. Case 8 (Center Push) uses `w / 2` (fractional at odd widths, lines 71-72), Dot Dissolve uses
  absolute 17/9/5/3/2 px cells (line 85) and reassigns `mask.width/height` every frame (line 88), which reallocates and clears the
  bitmap each time.
- The transition layer allocates nothing at the resolution it is given except through the host `composite` and (Dot Dissolve) `mask`.

### 2.6 The embedded MPC-HC view

- The WebView2 controller fills the child view window: `put_Bounds(GetClientRect(parent))` in physical pixels (`src/mpc-hc/AAAVSView.cpp:122-127,235`).
  The executable manifest declares PerMonitorV2 DPI awareness (`src/mpc-hc/res/mpc-hc.exe.manifest:40-41`), so those are true device pixels and the
  page's `devicePixelRatio` is expected to be the monitor scale (documented WebView2 behaviour; not verified here).
- Audio-only sizing: cover art is bounded by `nCoverArtSizeLimit`, default 600 (`src/mpc-hc/AppSettings.cpp:260`); `GetVideoOrArtSize` and
  `GetZoomWindowSize` keep the existing window when the art is under 300 px tall and the window is under 420 px tall (`src/mpc-hc/MainFrm.cpp:13860-13906`).
  The initial view therefore depends on the saved window size and logo (not measured; the 480x480 case is representative of a small window, not a measured default); users then maximise or go full
  screen, giving the whole monitor. A maximised window's view is the client area minus toolbars and status bar, so **fractional scales such as
  S = 1.78 (1918x960) are the norm, not the exception**.
- Persistence today: `Preferences(save)` reads/writes `WriteProfileInt(L"AAAVS", key, ...)` under `Software\MPC-AAAVS\MPC-AAAVS`
  (`src/mpc-hc/AAAVSView.cpp:74-85`; `src/mpc-hc/Profile.cpp:34`); `Settings()` posts one flat JSON message (lines 91-103); `Options()` is a `TrackPopupMenu`
  with fixed item IDs 1-5, 20-35, 40-43, 50-53, 60-65, 70-75 (lines 274-311). Sibling designs claim 54-55, 80-96 and 100-132.

### 2.7 Stock Studio (must not break)

- The WebGPU stage sizes to `round(css * min(dpr, 2))` (`gpu.ts:160-166`; `main.ts:663,1372`; `projector-window.ts:78,128`).
- AVS presets: `AvsFrameGovernor.dimensions` fits the source (the DPR-2 stage size, or real device pixels for the integer policy) inside
  `maxEdge = 640` and `maxPixels = 230,400`, scaled by the tier (`avs-presentation.ts:95-96,185-205`). Modes are `classic` (fit),
  `crisp` (integer factor `k`, raster `ceil(W/k) x ceil(H/k)` with 10/9 cap slack, lines 213-224) and `high` (tiers 2x, 1.5x, 1x, floor 1x, 2 s dwell,
  `avsGovernorOptions`, lines 330-355). `AvsDimensionsDebouncer(250)` protects state (lines 476-506). `AvsCanvasPresenter` places the raster
  with `avsPresentationLayout` (nearest, sharp-bilinear or integer letterbox, lines 401-433; `avs-worker-client.ts:337-414`).
- Offline output uses fixed profiles (736x416 anchor, 1920x1080, 2560x1440 and others, `offline/profiles.ts`), an AVS-only executor, and does not
  render NERV. It never consults the live policy.
- **Consequence.** The new module imports from, but never modifies, `avs-presentation.ts`; Studio call sites are untouched; NERV/HUD kinds stay
  filtered out of Studio, projector and offline.

### 2.8 Standalone Player

- Same `mpc-host.ts`. `#stage` is `flex: 1` between a header and a transport block, so a maximised 1920x1080 window gives roughly 1920x900
  (estimate; not measured), which is height-limited for NERV (S = 1.667). `canvas` CSS is `100% x 100%` with `image-rendering: pixelated`.
- Options live in a `<dialog>` whose controls are wired through `settingsFields` and `StandaloneBridge.emit` (`standalone-player.ts:107,52-96`;
  `standalone.html:16-28`). The library service validates `settings` and drops unknown keys (`standalone-library.mjs:16-26`), so display
  preferences must not travel through `configure`.

## 3. Why NERV is soft: the arithmetic **[EXISTS] today, [PROPOSED] fix**

`S` is device pixels per logical unit of the 960x540 design. "Loss" is device scale divided by render scale: how much coarser than the display
the picture is. Today's render scale is 0.667 for 16:9 and narrower views (lower for ultra-wide ones, because the height follows the aspect).

| Display (CSS x DPR = device) | Today: render, canvas, stretch | Upscale | Integer? | Loss | 11 px label |
| --- | --- | --- | --- | --- | --- |
| 480x480 @1 | 640x640, canvas 480x480 | 0.75 down | no (nearest drops every 4th line) | 0.75 (aliasing) | 7.3 render px sampled down to 5.5 |
| 1280x720 @1 | 640x360, canvas 1280x720 | 2 | yes | 2.0 | 7.3 render px shown 2x |
| 1920x1080 @1 | 640x360, canvas 1920x1080 | 3 | yes | 3.0 | 7.3 render px shown 3x |
| 2560x1440 @1.25 (css 2048x1152) | 640x360, canvas 1920x1080, CSS x1.333 | 3 then 1.333 = 4 | no (3 px and 4 px blocks alternate) | 4.0 | 7.3 render px shown 4x |
| 3840x2160 @1.5 (css 2560x1440) | 640x360, canvas 1920x1080, CSS x2 | 3 then 2 = 6 | yes | 6.0 | 7.3 render px shown 6x |

After (NERV, vector, default Auto = High cap 2560x1440; Native for comparison):

| Display | Auto render (S) | Present ratio | Blockiness/softness | Native tier |
| --- | --- | --- | --- | --- |
| 480x480 | 480x480 (0.5) | 1.0 | none; content is 480x270, legibility is limited by physics (11 px = 5.5 px) | same |
| 1280x720 | 1280x720 (1.333) | 1.0 | none | same |
| 1920x1080 | 1920x1080 (2.0) | 1.0 | none; S is an integer so 1 logical px = 2 device px exactly | same |
| 2560x1440 @1.25 | 2560x1440 (2.667) | 1.0 | none; snapping needed because S is fractional | same |
| 3840x2160 @1.5 | 2560x1440 (2.667) | 1.5 (compositor bilinear) | mild softness by choice | 3840x2160 (4.0), 1.0 |

Balanced (1920x1080 cap) gives the same 1:1 result at 1080p and a 1.333 / 2.0 bilinear stretch at 1440p / 4K; Performance (1280x720) gives 1.5 / 2.0 / 3.0.

## 4. Cost and risk of higher resolution **[EXISTS] inputs, estimates marked**

### 4.1 NERV memory and bandwidth

`B` is one RGBA surface, `w*h*4`. The **clocked NERV worst case is 10 B**: two workers (active plus the prepared lookahead slot, H9) each holding
`canvas`, `oldCanvas`, `nextCanvas` (never released), plus the main-thread display canvas, `composite`, active bitmap and prepared bitmap. Dot Dissolve adds a
`mask` per worker (12 B). Unclocked NERV with a main-thread transition is about 6 B.

| Render size | Pixels (x today) | B (MiB) | Steady 4 B | Worst 10 B | Worst with masks 12 B | One copy at 60 fps |
| --- | --- | --- | --- | --- | --- | --- |
| 640x360 (today) | 230,400 (1x) | 0.88 | 3.5 | 8.8 | 10.5 | 53 MiB/s |
| 1280x720 | 921,600 (4x) | 3.52 | 14.1 | 35.2 | 42.2 | 211 MiB/s |
| 1920x1080 | 2,073,600 (9x) | 7.91 | 31.6 | 79.1 | 94.9 | 475 MiB/s |
| 2560x1440 | 3,686,400 (16x) | 14.06 | 56.3 | 140.6 | 168.8 | 844 MiB/s |
| 3840x2160 | 8,294,400 (36x) | 31.64 | 126.6 | 316.4 | 379.7 | 1,898 MiB/s |

- `transferToImageBitmap` is designed to move the backing store across threads without a copy (browser behaviour, not measured here); the copies that cost bandwidth are the main-thread blits (H6): worker bitmap to
  `composite`, `composite` to display, plus the probe downsample. Removing the `composite` copy for non-transition frames (section 5.8) saves one full-frame blit.
  On a GPU-accelerated canvas a 4K blit is a VRAM copy; on a software-backed canvas each blit is a CPU memcpy that scales with `B` (a 1080p copy is on the order of
  1 to 2 ms, *estimate*), so a software fallback at 4K could cost tens of ms on the main thread. That is why Native is explicit and Auto is capped at High.
- Draw-call count is resolution independent (178 to 635). If Canvas2D in the worker is GPU rasterised, per-frame cost grows slowly with area. If it falls back to
  software raster, the full-surface clear plus panel and hex fills grow with pixels. **Unmeasured; the Auto governor (section 5.6) exists because of this.**
- The NERV clocked path renders two scenes plus a composite per transition frame (`nerv-render.worker.ts:46-54`): 2x draw work and 3 surfaces for the transition
  duration.

### 4.2 AVS at higher exact-lane sizes (opt-in only)

- Baseline (`visualizer/HANDOFF.md`, 2026-09-26 entry; Node CPU numbers, 640x360, lane `cpu`): p50 19.29 ms, p90 33.48 ms, p99 56.68 ms; 47 of 124 presets inside 60 Hz, 11 of 124 inside 120 Hz.
- Per-pixel components scale with area (4x at 1280x720, 9x at 1920x1080), per-point components scale with line length (about 2x). *Estimate*: p50 about 39 to 77 ms at 1280x720
  (roughly 13 to 26 fps for the median preset). A preset must cost 4.2 ms or less at 640x360 to hold 60 Hz at 720p, which is at most the 11 presets that currently fit 120 Hz.
- Upload per frame grows to 3.5 MiB (720p) and 7.9 MiB (1080p) at `w*h*4`; resident GPU memory is `w*h*4*surfaces`. Two workers render during a transition (`keepOld`),
  doubling CPU. A resize resets AVS feedback state and rebuilds GPU resources (H2, H4).
- Byte exactness is proven only at 317x179 and 640x360. A larger size needs either an owner-approved new baseline or a record-nothing CPU-versus-exact-GPU parity check.
- Therefore AVS `classic` stays default; `high` is labelled experimental and reuses the Studio governor (2 s dwell, never below classic, never stepping back up mid-preset).

## 5. Render resolution policy **[PROPOSED]**

### 5.1 Module `visualizer/src/render-resolution.ts`

Pure, dependency-free except type/function imports from `avs-presentation.ts`. No DOM, no clocks except injected ones. Exact signatures:

```ts
import type { AvsResolutionMode } from './avs-presentation.ts';

export type RenderKind = 'nerv' | 'hud' | 'avs';
export type QualityTier = 'auto' | 'performance' | 'balanced' | 'high' | 'native';
export type FixedTier = Exclude<QualityTier, 'auto'>;
export type PixelArtScaling = 'auto' | 'integer' | 'smooth';
export type Smoothing = 'nearest' | 'bilinear' | 'sharp-bilinear';

export interface Size { readonly width: number; readonly height: number }
export interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface TierSpec { readonly maxEdge: number; readonly maxPixels: number }

export const TIERS: Readonly<Record<FixedTier, TierSpec>>;   // 5.2
export const AUTO_CEILING: FixedTier;                          // 'high'
export const HARD_MAX_EDGE = 4096, HARD_MAX_PIXELS = 3840 * 2160, MIN_EDGE = 64;
export const LEGACY_AVS = { width: 640, maxHeight: 640, presentMaxWidth: 1920, presentMaxHeight: 1080 } as const;

export interface PixelGrid { readonly width: number; readonly height: number; readonly par?: number }  // par = pixel width/height, default 1
export interface SceneTraits {
  readonly logical?: Size;                 // design canvas; NERV_DESIGN (960x540) when absent
  readonly pixelGrid?: PixelGrid | null;   // present => retro pixel-art scene
}
export interface Budget { readonly maxPixels?: number; readonly maxBytes?: number; readonly surfaces?: number }

export interface ResolveInput {
  readonly kind: RenderKind;
  readonly cssWidth: number; readonly cssHeight: number; readonly dpr: number;
  /** Exact device-pixel content box from ResizeObserver when available; wins over cssSize*dpr for vector kinds. */
  readonly deviceWidth?: number; readonly deviceHeight?: number;
  readonly tier: QualityTier;
  readonly autoTier?: FixedTier;           // the governor's current tier when tier === 'auto' (default AUTO_CEILING)
  readonly traits?: SceneTraits;
  readonly pixelArt?: PixelArtScaling;     // default 'auto'
  readonly avs?: { readonly mode: AvsResolutionMode; readonly scale?: number }; // kind 'avs'; default classic
  readonly budget?: Budget;
}

export interface ResolvedRender {
  readonly kind: RenderKind;
  readonly tier: QualityTier;              // effective tier (auto resolved); 'auto' never appears for avs/pixel-art
  readonly render: Size;                   // worker surface -> AvsWorkerRenderMessage.width/height
  readonly canvas: Size;                   // display canvas backing store
  readonly box: Box;                       // where the render surface is drawn on the canvas (device px, integers)
  readonly smoothing: Smoothing;           // drives imageSmoothingEnabled/Quality
  readonly cssImageRendering: 'auto' | 'pixelated';
  readonly integerScale: number | null;    // k when render->box is an exact k x k nearest enlargement
  readonly prescale: number;               // nearest prescale before the final resample (sharp-bilinear only, else 1)
  readonly presentScale: number;           // device px per render px, telemetry
  readonly metrics: SurfaceMetrics | null; // design-canvas metrics for scenes (null for avs)
  readonly key: string;                    // stable identity for change detection
}
export function resolveRender(input: ResolveInput): ResolvedRender;
export function fitWithin(width: number, height: number, maxEdge: number, maxPixels: number): Size; // uniform, floor, >= MIN_EDGE

// --- design canvas (shared by NERV, HUD and any future scene) ---
export interface SurfaceMetrics {
  readonly width: number; readonly height: number;
  readonly logicalWidth: number; readonly logicalHeight: number;
  readonly scale: number;                        // min(width/lw, height/lh): device px per logical unit
  readonly offsetX: number; readonly offsetY: number;          // integer letterbox offsets
  readonly contentWidth: number; readonly contentHeight: number; // round(lw*scale), round(lh*scale)
}
export function surfaceMetrics(width: number, height: number, logicalWidth: number, logicalHeight: number): SurfaceMetrics;
export function strokePx(m: SurfaceMetrics, logicalWidth: number): number;                        // >= 1 device px, integer
export function snapStroke(m: SurfaceMetrics, axis: 'x' | 'y', v: number, px: number): number;    // stroke edges on the pixel grid
export function snapSpan(m: SurfaceMetrics, axis: 'x' | 'y', v: number, length: number): readonly [number, number]; // fill edges
export function snapBaseline(m: SurfaceMetrics, y: number): number;                                // text baseline
export interface TransformLike { translate(x: number, y: number): void; scale(x: number, y: number): void; beginPath(): void; rect(x: number, y: number, w: number, h: number): void; clip(): void }
export function applyDesignTransform(c: TransformLike, m: SurfaceMetrics): void;                   // translate, scale, snapped clip

// --- Auto governor and host glue ---
export class QualityGovernor {
  constructor(options?: { ceiling?: FixedTier; floor?: FixedTier; targetFps?: number; downSamples?: number;
                          upSamples?: number; dwellMs?: number; warmup?: number });
  get tier(): FixedTier;
  reset(): void;
  record(frameMs: number, nowMs: number): boolean;      // true when the tier changed
}
export interface DisplaySettings { readonly quality: QualityTier; readonly avsResolution: AvsResolutionMode; readonly pixelArt: PixelArtScaling }
export const DEFAULT_DISPLAY: DisplaySettings;          // { quality: 'auto', avsResolution: 'classic', pixelArt: 'auto' }
export function parseDisplaySettings(value: unknown): DisplaySettings;   // tolerant: ints (wire) or strings (storage)
export function displayToWire(s: DisplaySettings): { quality: number; avsResolution: number; pixelArt: number };
export function transitionSurface(a: { render: Size; kind: RenderKind }, b: { render: Size; kind: RenderKind }): { size: Size; smooth: boolean };
export function describeResolved(r: ResolvedRender): string;             // "NERV 1920x1080 - scale 2.00 - high"
```

`resolveRender` is total: NaN, zero, negative and huge inputs return a valid finite result (sizes are clamped to `MIN_EDGE` and the hard caps, DPR to 0.5..8).

### 5.2 Quality tiers (vector kinds: NERV and HUD)

| Tier | Wire | Long-edge cap | Pixel cap | Result at 1080p / 1440p / 4K | 10 B memory |
| --- | --- | --- | --- | --- | --- |
| Auto (default) | 0 | starts at High; governor may step down to Performance, never up past High | 3,686,400 (High) | 1:1 / 1:1 / 1.5x stretch | up to 141 MiB |
| Performance | 1 | 1280 | 921,600 (1280x720) | 1.5x / 2x / 3x bilinear | 35 MiB |
| Balanced | 2 | 1920 | 2,073,600 (1920x1080) | 1:1 / 1.333x / 2x | 79 MiB |
| High | 3 | 2560 | 3,686,400 (2560x1440) | 1:1 / 1:1 / 1.5x | 141 MiB |
| Native | 4 | 3840 | 8,294,400 (3840x2160) = `HARD_MAX_PIXELS` | 1:1 at all three | 316 MiB |

Rule: `f = min(1, maxEdge / max(dw, dh), sqrt(maxPixels / (dw * dh)))`; render = `floor(d * f)` on both axes (uniform, so aspect is kept and the pixel cap
is never exceeded by rounding), or exactly `d` when `f = 1`. `maxPixels` is further reduced by `budget.maxPixels` and by
`budget.maxBytes / (4 * surfaces)`. Balanced reproduces today's 1920x1080 present cap, so it is the conservative bridge.

### 5.3 Per-kind rules

| Kind | Render surface | Display canvas | Smoothing / CSS | Notes |
| --- | --- | --- | --- | --- |
| `nerv` | tier fit of device size (window aspect; the scene letterbox stays inside the surface) | equals render size; the compositor stretches by `device / render` | `bilinear`, `image-rendering: auto` | design 960x540 from `NERV_DESIGN`; snapping active (section 6) |
| `hud`, vector | as `nerv`; `traits.logical` from the preset manifest | as `nerv` | as `nerv` | scenes must draw through the design-canvas contract (section 7) |
| `hud`, pixel art (`traits.pixelGrid`) | exactly the native grid `gw x gh` | device size (fit to hard caps), so the mapping is 1:1 | `nearest` (integer) or `sharp-bilinear`; CSS `pixelated` | tier ignored; only `budget` and hard caps apply |
| `avs`, `classic` (default) | **exactly today's rule**: 640 x `clamp(round(640*cssH/max(1,cssW)), 64, 640)` | **exactly today's rule**: `round(css*s)`, `s = min(dpr, 1920/max(1,cssW), 1080/max(1,cssH))` | `nearest`, `pixelated` | inputs are CSS px and DPR; `deviceWidth/Height` are ignored |
| `avs`, `crisp` | Studio integer policy `ceil(W/k) x ceil(H/k)` via `AvsFrameGovernor.dimensions` | device size; `box` from `avsPresentationLayout(..., integerCover = true)` | `nearest`, `pixelated`, `integerScale = k` | opt-in |
| `avs`, `high` | Studio 2x/1.5x/1x tiers via the same governor, floor classic | as `classic` | `nearest`, `pixelated` | opt-in, experimental; needs the Studio governor and a dimensions debouncer |

Prototype results (CPU only, real `avs-presentation.ts` bundled): `crisp` at 1280x720, 1920x1080, 2560x1440 and 3840x2160 gives 640x360 with `k` = 2, 3, 4 and 6; at
480x480 it gives 480x480 with `k` = 1. `high` gives 1280x720 (4x pixels) on the four wide displays and 480x480 at 480x480. `high` at 1080p then stretches 1.5x with nearest, which is
*not* an integer factor: keep `crisp` in mind for exact pixels. `classic` at 480x480 remains 640x640 (the shipped behaviour; see Q3).

### 5.4 Integer-scale rule (pixel-art scenes)

Let `kFit = min(dw/gw, dh/gh)` and `kInt = floor(kFit)`; `par` is the pixel aspect ratio from the authored grid (default 1; HUD research EQ4 shows kit metadata
cannot supply it, so it must be authored).

1. `kInt >= 1` and `mode === 'integer'`: `box = kInt*gw x kInt*gh` centred at integer offsets, `smoothing = 'nearest'`, `integerScale = kInt`.
2. `mode === 'auto'`: integer when `(kInt*gw)*(kInt*gh) >= 0.8 * dw*dh` (at most 20% of the display lost to bars). Otherwise `sharp-bilinear`:
   nearest prescale by `kInt` into a scratch surface, then a smoothed draw to the aspect-preserving box `round(gw*kFit) x round(gh*kFit)`.
3. `mode === 'smooth'`: always `sharp-bilinear` when `kInt >= 1`.
4. `kInt < 1` (display smaller than the grid): `bilinear` with `imageSmoothingQuality = 'high'`, aspect-preserving box, `integerScale = null`.
5. `par !== 1`: horizontal factor `round(kInt * par)` is used only when within 0.02 of an integer (for example `par` 2, or `par` 4/3 when `kInt` is a multiple of 3); otherwise `auto` resolves to `sharp-bilinear`.
   The integer mode never produces a fractional scale on either axis.

Prototype table (320x180, 256x224, 384x224, 320x240 grids): 1080p gives `nearest k=6` for 320x180 and `sharp-bilinear` for the other three (coverage 0.46 to 0.66); 1920x900 gives k=5 for
320x180; 4K gives k=12 for 320x180. The test plan pins these values.

### 5.5 Aspect, caps and debouncing

- Vector surfaces keep the window aspect (`fitWithin` is uniform); the scene letterboxes itself with integer offsets. Optional `cropToDesign` (rollout step 7) would size the surface
  to the design aspect inside the window (saves 10% at 16:10, 25% at 4:3 and 21:9, 44% at 1:1) at the cost of a box and bars.
- Hard caps: `HARD_MAX_PIXELS = 8,294,400`, `HARD_MAX_EDGE = 4096`, `MIN_EDGE = 64`. The NERV worker validates against them with a uniform down-fit, not per-axis clamps (section 2.3).
- Debounce: AVS kinds use `AvsDimensionsDebouncer(250)` (a size change resets feedback state); vector kinds use the same class at 120 ms, because their cost is allocation churn
  and not state. While a debounce is pending the compositor stretches the previous frame (smooth for vector, nearest for AVS).
- Device size: prefer `ResizeObserver` with `devicePixelContentBoxSize` (`observe(canvas, { box: 'device-pixel-content-box' })`, guarded by try/catch) for vector kinds so the backing
  store equals the snapped device box exactly on fractional DPR and browser zoom; fall back to `round(clientWidth * dpr)`.

### 5.6 Auto governor **[PROPOSED]**

`QualityGovernor` picks a `FixedTier` from measured frame cost. Because NERV reports `renderMs: 0` today (H10), the host measures dispatch-to-frame round trip (`performance.now()` at
`postMessage(render)` and at the `frame` reply) and the NERV worker should also report a real `renderMs`.

Initial constants (tuning starting points, to be calibrated at runtime): interval `1000/targetFps` (60 fps: 16.7 ms); overloaded when a sample exceeds the interval or the EMA exceeds 0.75 of it;
headroom when a sample is under 0.5 and the EMA under 0.35 of it; step down after 12 overloaded samples; step up after 600 headroom samples; 4 s dwell between changes; a tier that was just left
is banned for 60 s (no oscillation); 30 samples of warm-up after every change. Frames are recorded only for the active slot while playing. A scratch simulation of 22 ms load followed by 3 ms load
walked High to Balanced to Performance and back up after the ban, without oscillating. It never selects Native.

### 5.7 Transitions and their surfaces

- **In-worker NERV transitions.** All three surfaces use the same resolved render size (already the case in `surface()`). Release `oldCanvas`/`nextCanvas` when `blend >= 1` (they are reallocated at the next boundary),
  which removes 2 B per worker from the steady state.
- **Constructor options** for `AvsTransition` (both default to today's behaviour): `smooth?: boolean` (default `false`; when true, `draw` sets `imageSmoothingEnabled = true` and `imageSmoothingQuality = 'high'`, and vector NERV/HUD
  transitions pass true) and `designWidth?: number` (default 640; Dot Dissolve scales cells and dots by `u = max(1, round(h/360))`, the same unit Transitions V2 uses, so the look is proportionally constant).
  Transitions V2 keeps `imageSmoothingEnabled = false` at the top of `draw` and sets it inside the modes that need smoothing; with this option the top-of-`draw` default becomes `this.smooth`, and a mode that needs nearest (Mosaic Drop) still sets it explicitly. Also fix `w / 2` to `Math.floor(w / 2)` in case 8 so fractional offsets cannot blur under smoothing, and guard `mask.width`/`mask.height` and `tile.width` assignments (assign only on change; clear with `clearRect`).
- **Main-thread transitions between slots** (Auto, mixed kinds): `transitionSurface(a, b)` returns the larger of the two render sizes (by area; ties go to the incoming side) and `smooth = a.kind !== 'avs' || b.kind !== 'avs'`.
  The side that is smaller is enlarged by `AvsTransition.draw`'s existing scaled draws. The composite canvas is sized to that surface.
- **Skip the composite copy** on frames without a transition: `FlashGate.present` accepts any `CanvasImageSource`, so the bitmap can be sampled and drawn directly (one full-frame blit less, 4B to 3B steady).

### 5.8 Worker protocol and host wiring

The render surface already travels as `width`/`height` on `AvsWorkerLoadMessage` and `AvsWorkerRenderMessage` (`avs-worker-protocol.ts:23-24,36-37`); the reply reports the applied size. **No new worker message types**; the only new message is the page-to-native `display:` string in 5.9. Changes:

1. **Host.** `render()` and `prepare()` take sizes from `RenderSizer.resolve(kind, traits, cssSize, dpr)`; the AVS `load` message carries the policy size instead of `640x360` (fixes H2). A small stateful `RenderSizer` owns
   the `DisplaySettings`, the `QualityGovernor`, the debouncers and the observed device size, and is unit-testable with a fake clock.
2. **Present.** Replace lines 352-365 of `mpc-host.ts` with: read `r = sizer.resolve(...)` for the active slot; set `canvas.width/height` from `r.canvas` (flash reset on change); set
   `canvas.style.imageRendering = r.cssImageRendering` when it changes (inline style overrides the static stylesheet rule, so `mpc.html` and `standalone.html` need no CSS edit); set
   `context.imageSmoothingEnabled = r.smoothing !== 'nearest'` and `imageSmoothingQuality = 'high'`; draw the source into `r.box` (for `sharp-bilinear` first enlarge by `r.prescale` with nearest into a scratch
   canvas, then smooth-draw).
3. **NERV worker.** Replace the per-axis clamps with `fitWithin(w, h, HARD_MAX_EDGE, HARD_MAX_PIXELS)`; report `renderMs` from `performance.now()`; release transition surfaces; create the transition with `smooth: true`.
4. **AVS worker.** Unchanged code. `classic` keeps sending today's sizes.
5. **Flash probe.** `canvasProbeSampler(options?: { smoothingQuality?: ImageSmoothingQuality })`; `mpc-host` passes `'medium'` for the reduced-aliasing 7.5x to 15x downsample. Studio's default stays untouched.

### 5.9 Options and persistence

Three preferences, all device-local (never part of a setup): **Render quality** (Auto default, Performance, Balanced, High, Native), **AVS resolution** (Classic default, Crisp, High experimental) and
**Pixel-art scaling** (Auto default, Integer, Smooth).

- **Wire format.** Native to page: three optional integers appended to the existing `settings` message: `quality` 0..4 (0 auto, 1 performance, 2 balanced, 3 high, 4 native), `avsResolution` 0..2 (0 classic, 1 crisp, 2 high), `pixelArt` 0..2 (0 auto, 1 integer, 2 smooth). A missing or invalid key keeps the current value; an old page ignores them;
  an old native never sends them (defaults apply). Page to native: a plain string `display:{"quality":n,"avsResolution":n,"pixelArt":n}` (parsed with the existing rapidjson helpers, clamped, then `Settings()`).
  Do not route through the `configure` library op (its validator resets absent keys).
- **Native menu** (`AAAVSView::Options()`): three submenus with IDs in a range no sibling design uses: quality 200-204, AVS resolution 210-212, pixel-art scaling 220-222 (siblings use 54-55, 80-96, 100-132).
  New state `int quality = 0, avsResolution = 0, pixelArt = 0;` clamped in `Preferences()`; registry values `Quality`, `AvsResolution`, `PixelArt` under `AAAVS`. `Settings()` appends
  `,"quality":N,"avsResolution":N,"pixelArt":N` after the timing keys.
- **Player.** `standalone.html` gets three selects (`setting-quality`, `setting-avsResolution`, `setting-pixelArt`); `standalone-player.ts` handles them with a separate `displayFields` list persisted as one JSON object under
  `localStorage` key `aaavs.mpcDisplay.v1` (strings; tolerant parse; try/catch for private windows), emits the wire integers into the `settings` message, and handles `display:` in `StandaloneBridge.postMessage`.
  `standalone-library.mjs` is not touched.
- **Preset Manager** (`mpc-management.ts`, shared by both hosts): a "Display" row in the top controls with the same three selects through new `Actions.display()` and `Actions.setDisplay(patch)`,
  so at least one control surface exists in both apps from the first release.
- **Feedback.** On change, `announce(describeResolved(r))`. The detail state of the FPS overlay (Timing V2, section 3) can append `1920x1080` at no cost.

## 6. NERV drawing changes **[PROPOSED]**

Raising the surface already scales everything (2.3). These edits make lines and text **crisp** at fractional `S` and give the minimum stroke a floor. They keep op order, kinds, strings and all unsnapped coordinates, so the drawing streams still match across sizes apart from snap offsets of at most half a device pixel per edge. State: a module-level `let M: SurfaceMetrics`, assigned at the top of `renderNervScene` and reset in a `finally`
(rendering is synchronous, one call at a time per worker).

| Function (current lines) | Change |
| --- | --- |
| `NERV_DESIGN` (new export near line 11) | `{ width: 960, height: 540 }`, used by the entry, the policy and tests instead of the literals at lines 386-388. |
| `label` (34-37), `title` (38-43) | Snap only the baseline (y) with `snapBaseline`; the x anchor keeps its design coordinate (subpixel glyph positioning). Fonts stay in logical px. |
| `line` (44-46) | `px = strokePx(M, width)` (>= 1 device px); `lineWidth = px / M.scale`; when `x1 === x2` or `y1 === y2` replace the constant coordinate with `snapStroke` so both stroke edges land on the pixel grid. Diagonals unchanged. This automatically fixes `brackets` (66-71), `grid` (86-91), the `scope` centre rule (107) and `city` lines (318-329). |
| `circle` (56-58) and every direct polygon/arc stroke width: `hexField` (133), `boot` ring (166), `atfield` rings (271), `plug` tunnel (299), `berserk` rings (343) | Width floor only: `max(width, 1 / M.scale)` (a `hair()` helper). The polygons' axis-aligned edges are deliberately left unsnapped (decorative rings with alpha). |
| `panel` (59-65) | Path coordinates and the chamfer stroke go through the same edge snap; the label plate `fillRect` uses `rect`. |
| new `rect(c, x, y, w, h)` | Snaps near and far edges independently with `snapSpan` (shared edges round identically, so no seams or overlaps); minimum 1 device px when `w`/`h` > 0. |
| `meter` (80-85), `spectrum` (116-126) | Per-cell `fillRect` becomes `rect`, including the `unit - 2` gap, the 1-logical-px baseline under each spectrum bar and the unlit cell colour. Removes fractional cell seams on fractional `unit`. |
| `hazard` (72-79), `plug` clip (296) | Snap the clip rectangle with `snapSpan` (clip edges are antialiased, so a fractional clip edge is a soft edge). |
| direct `fillRect`/`strokeRect` in scenes | Route through `rect` / a new `outline` (stroke inset by half the device width so its outer edge lies on the grid): `chrome` beat cells (154), `boot` cursor (164), `radar` blips (208), `digits` segments (249-251), `city` boxes and window lights (324-328), and any equivalent in the redesigned NERV scenes. |
| `scope` (106-115) | Polyline coordinates unchanged (the existing test asserts them); width floor; optional `lineJoin = 'round'` inside `save`/`restore` to avoid miter spikes on dense traces at high resolution. |
| `renderNervScene` (376-392) | `M = surfaceMetrics(width, height, NERV_DESIGN.width, NERV_DESIGN.height)`; integer letterbox offsets (`translate(M.offsetX, M.offsetY)`, `scale(M.scale, M.scale)`); clip `rect(0, 0, contentWidth / scale, contentHeight / scale)` so the clip edge sits on the pixel grid; set `c.textRendering = 'geometricPrecision'` inside the existing `save`/`restore`. |

Text hints, and an honest caveat: with `textRendering = 'geometricPrecision'` the browser is asked for unhinted, subpixel-positioned glyphs, which is what a design scaled by an arbitrary `S` needs (hinted integer advances
and stem snapping change per size and can space the monospace `PCM STEREO...........CONNECTED` rows unevenly). Whether that looks better than the platform's default at 9 to 12 px is an empirical question that needs an
on-screen A/B (section 10). `fontKerning` stays at its default (the serif titles benefit from kerning; the monospace labels are unaffected). `measureText` must not be introduced (the recording fake context throws on unknown APIs).

**Verified in a scratch prototype** (a patched copy of `nerv-scenes.ts` with these helpers, a fake recording context and a scale/translate tracker; CPU only, not part of the repo): across the 16 scenes at 12 surface sizes (640x360 up to 3840x2160, plus 1280x590, 1918x960, 1920x900, 1366x768, 480x480, 240x540) all 3,658 rectangle fills, 331 text baselines, 20 clip rectangles and 516 single-segment strokes of each 16-scene set landed on integer device pixels (0 failures at every size), no stroke was thinner than one device pixel (799 strokes were below one pixel at 640x360 before), op counts, kinds, strings and font sizes were identical across sizes (176/176 comparisons), all arcs and text x anchors were exactly equal, and every other coordinate stayed within the snap bound. Today's code at 1918x960 fails the same integrality checks on 3,658/3,658 rectangles, 275/331 baselines, 20/20 clips and 779/779 stroke segments. Polygon (hex/octagon) axis-aligned edges (263 segments per frame set) remain unsnapped by design.

Explicit non-goals: no change to any scene composition, colour, text content or audio mapping; the NERV pack redesign stream keeps ownership of scene functions. To limit merge friction, land the helper block
(lines 22-138) and the entry (lines 376-392) first, or move the helpers to a new `nerv-draw.ts` that both streams import.

## 7. Contract for HUD scenes (blocks any resolution-independent HUD)

`src/hud/fighting-hud-bed.ts` as it stands today mixes proportional layout with fixed device pixels: `barMargin = max(12, width*0.04)`, `barHeight = max(16, height*0.045)`, `centerTimerW = 60`,
`topDockHeight = barHeight + 36`, and fonts/strokes of `11px`, `32px`, `12px`, `14px`, `18px`, `28px` and `lineWidth` 1 to 3 (lines 1018-1222 and 1278-1297), plus `measureText` (line 1156) and `Date.now()`
(line 1262). If that scene is rendered at 1920x1080 instead of 640x360 the boxes triple while text and strokes do not: exactly the "merely smaller" failure. Every HUD scene must instead:

1. Declare a design canvas (`traits.logical`, for example 640x360 or the authored source grid) and draw only in those coordinates after `applyDesignTransform(c, surfaceMetrics(w, h, lw, lh))`.
2. Never read `width`/`height` for layout, and use no unscaled pixel constants; text sizes and strokes are logical.
3. Use the snapping helpers for hairlines, rectangles and baselines (vector HUDs) or draw on the native grid with no transform (pixel-art HUDs: the surface *is* the grid; `traits.pixelGrid`).
4. Declare `pixelGrid` (with `par`) only from authored data. Kit `nativeResolution` metadata is unreliable (HUD research EQ4).
5. Stay deterministic: replace `Date.now()` with the frame's media time.

## 8. CPU test plan **[PROPOSED]** (no browser, no GPU)

`visualizer/tools/check-render-resolution.mjs` (new; bundles the TS with esbuild like the other checks; add to `package.json` `check` and to the mirror manifest):

1. **Legacy parity.** For 5,000+ pseudo-random `(cssW, cssH, dpr)` including extremes, `resolveRender({ kind: 'avs', avs: classic })` equals a verbatim copy of the shipped formulas for render size and present canvas.
2. **Representative table.** The five displays x five tiers x three kinds are compared to a literal expected table (the tables in section 3 and 5).
3. **Invariants.** For random inputs: finite integers, `render` and `canvas` within hard caps and `>= MIN_EDGE`, uniform aspect within one pixel, monotone pixel count across tiers, `Auto` never above `High`, and NaN/0/negative/huge inputs never throw.
4. **Integer rule.** For a grid list x display list: `integerScale` is an integer exactly when documented, `box` offsets are integers and inside the canvas, coverage >= 0.8 for integer, `sharp-bilinear` prescale equals `kInt`, and `par` behaviour matches 5.4.
5. **Snapping algebra.** For 10 surface sizes (including 480x480, 1280x590, 1918x960, 1920x900, 1366x768): `strokePx >= 1`, snapped stroke edges and `snapSpan` edges are integers in device space (tolerance 1e-6), movement <= 0.5 px (+ width rounding), and adjacent spans share edges. A scratch prototype ran 80,000 such checks.
6. **Governor.** Synthetic frame-time traces: step-down after the configured samples, dwell respected, ban prevents oscillation, never above ceiling or below floor, `reset` restores the ceiling.
7. **Display settings.** `parseDisplaySettings` round-trips ints and strings, ignores garbage, defaults match `DEFAULT_DISPLAY`.

Extend `tools/check-nerv-scenes.mjs` (the fake recording context already fails on unknown APIs and leaked state; add `imageSmoothingEnabled`, `textRendering` and friends to the allowed setters; do not add `measureText`):

8. **Scale invariance.** Render every scene at 640x360, 960x540, 1280x720, 1920x1080, 2560x1440, 3840x2160, 1920x900, 480x480 and 240x540. A small transform tracker replays `save/restore/translate/scale` and maps every coordinate to device
   space; then assert (a) identical op count, order, kinds, strings and logical font sizes across sizes, (b) every snapped centre or baseline coordinate differs from the reference-size coordinate by at most `0.5/S + 0.5/S_ref` logical units and every snapped length by at most `1/S + 1/S_ref`; arcs, `fillText` x anchors and non-snapped polyline/polygon coordinates are exactly equal.
9. **Crispness.** For every single-segment axis-aligned stroke (the `line` helper), panel outline edge, `fillRect` and clip rectangle under the design transform, device-space edges are integers (1e-6); polygon and polyline strokes are excluded; every stroke has `lineWidth * S >= 1 - 1e-9`; every alphabetic `fillText` baseline is an integer in device space; the letterbox `translate` and clip edges are integers.
10. **No regression.** The existing psycho signed-PCM coordinate assertions (`check-nerv-scenes.mjs:72-73`) still pass; repeat/seek determinism digests hold at each size.

Update and extend the worker/host/transition checks:

11. `check-nerv-worker.mjs:86` currently expects a 99999x99999 request to become 1280x720; change it to a uniform down-fit within `HARD_MAX_PIXELS`, aspect preserved. Add: applied size returned in the reply, real numeric `renderMs`, `oldCanvas`/`nextCanvas` released after `blend >= 1`, transition created with `smooth: true`.
12. `check-mpc-host.mjs`, `check-nerv-host.mjs`: fixtures need `canvas.style` and optional `ResizeObserver`; assert AVS classic requests 640x360 at a 640x360 view and that the AVS `load` carries the policy size; the "presentation pixels are bounded" assertion (`check-mpc-host.mjs:86-87`) stays true for the fixture catalog (AVS classic, 1920x1080); add NERV bounded-by-`HARD_MAX_PIXELS` and a 250 ms / 120 ms debounce test with a fake clock.
13. `mpc-transition-raster-check.mjs`: default `smooth: false` output unchanged; with `smooth: true` a recording context sees `imageSmoothingEnabled = true` and integer geometry for case 8 at odd widths; Dot Dissolve cell size follows `u`; `mask` is not reassigned when unchanged.
14. `flash-limiter-check.ts`: the sampler option is plumbed and the default sampler is unchanged.

Golden AVS hashes are not touched and are not re-recorded.

## 9. Rollout order

1. **Policy module and its check, no wiring.** Land `render-resolution.ts` and `check-render-resolution.mjs`; add the check to `npm run check`, `check:player` and the mirror manifest. Gate: parity fuzz passes, both builds unchanged.
2. **NERV scene crispness** (section 6) with tests 8-10. Behaviour at 640x360 changes only by snapping. Coordinate with the NERV redesign stream first, or extract `nerv-draw.ts`.
3. **Host wiring for NERV only**: `RenderSizer`, present path, worker uniform clamp and telemetry, `smooth`/`u`/`floor(w/2)` in `AvsTransition`, transition-surface release, composite skip, flash probe option. AVS still resolves to `classic`. Default tier Auto. This is the step the owner will see: sharp NERV.
4. **Options and persistence**: native menu and registry, Player selects and `localStorage`, Preset Manager row, announcements. Add `Performance` as the documented escape hatch.
5. **AVS opt-ins**: `crisp` and `high` through the Studio helpers with the 250 ms debouncer, a `renderMs` feed to the Studio governor, and the load-size fix. Off by default.
6. **HUD kinds**: after the HUD stream adopts the design-canvas contract (section 7) and a `hud` catalog kind exists, add pixel-art scenes with `pixelGrid`.
7. **Optional**: `cropToDesign`, `nerv-draw.ts` extraction, resolution in the FPS detail overlay.
8. Each step: `npm run check`, `npm run build`, `npm run build:player`, and the mirror preview/check against the stock checkout; stop on conflicts. Runtime acceptance (section 10) is separate and deferred.

## 10. Runtime and GPU acceptance to run later (do not run while the GPU is reserved)

1. **NERV clarity**: 16 scenes at 1080p, 1440p and 4K, DPR 1, 1.25 and 1.5, before/after captures; legibility of 9 to 11 px labels at S = 1.33, 1.667 and 2.0; hairline crispness and scope-trace shimmer; no seams at the letterbox.
2. **Text A/B**: `textRendering` `auto` vs `geometricPrecision` at S = 1.185, 1.667, 2.0; monospace column alignment in boot rows.
3. **Cost**: worker frame time and main-thread present time per tier on the target GPU, with GPU raster and (if forced) software raster; worst scenes (`city`, `psycho`, `atfield`, `berserk`); during a clocked transition with the lookahead worker; memory
   (working set and GPU memory) against the 10 B model; Auto governor steps down under synthetic load and does not oscillate.
4. **Device pixels**: `canvas.width` equals `devicePixelContentBoxSize` at 100/125/150/175% DPI and while dragging between monitors; browser zoom 90/110/125% in the Player; confirm WebView2 reports the monitor scale as `devicePixelRatio`.
5. **AVS classic unchanged**: presented-canvas diff of five presets at 1920x1080 before/after; no state reset when the window is resized after the debounce is added.
6. **AVS crisp/high**: exact k x k blocks, governor step-down and dwell, two-worker CPU during a transition, memory at 1280x720 with two workers; CPU-versus-exact-GPU parity at the larger size.
7. **Flash probe fidelity**: strobe fixtures at 640x360, 1920x1080 and 3840x2160 with the default and `medium` samplers; the limiter decision must not degrade (photosensitivity safety).
8. **Transitions at native size**: squeeze, push, wipe, dot dissolve on NERV and mixed AVS/NERV; no aliasing or seams; Dot Dissolve proportions.
9. **Pixel-art HUD** (when it exists): integer k at 1080p/1440p/4K, exact bars, no half-pixel shimmer in motion, sharp-bilinear fallback look, tate (portrait) grids.
10. **Native and Player**: registry round trip and menu checks, `display:` message, options dialog, Preset Manager row, fullscreen and monitor changes.

## 11. Risks and open questions

Risks:
- Cost and memory at high tiers are unmeasured (sections 4.1, 10.3); mitigated by Auto capped at High, the governor, Performance as an escape hatch and Native being explicit.
- Software-raster fallback for worker Canvas2D would make cost proportional to pixels; unverified whether the target WebView2 uses GPU raster there.
- `nerv-scenes.ts` is co-edited by the NERV redesign stream; land helper and entry edits first or extract `nerv-draw.ts`.
- The HUD bed cannot benefit until it adopts the design-canvas contract (section 7).
- Flash-probe aliasing at larger sources is a safety-relevant risk; the `medium` sampler and item 10.7 address it, but it must be confirmed.
- Two live NERV workers plus transitions reach 10 B (316 MiB at 4K); surface release and composite skip reduce it, Native carries the residual risk.
- Existing tests hard-code the 1280x720 worker clamp and fixture canvases without `style`; they change with this work (tests 11-12).
- A `hud` kind does not exist in the catalog parser yet (Preset browser V2, L1).

Open questions (defaults in brackets):
- Q1. Default tier: Auto capped at High (2560x1440) [yes], or Balanced?
- Q2. Should NERV hairlines scale with resolution (design-proportional, floored at 1 device px, snapped) [yes] or stay one device pixel wide?
- Q3. For non-16:9 views, keep the shipped AVS `classic` rule (up to 640x640) [yes] or adopt the Studio fit rule (230,400 px cap)?
- Q4. Expose Native in the first release [yes, explicit]?
- Q5. `textRendering = 'geometricPrecision'` as the default [yes, pending the A/B in 10.2]?
- Q6. `cropToDesign` surfaces (fewer pixels on non-16:9 windows) [no, phase 7 optional]?

## Appendix A: worked results of the scratch prototype

Legacy parity: 5,000 random CSS/DPR pairs identical. NERV render size by tier (S in parentheses; present ratio after the `x`):

| Display | Performance | Balanced | High | Native | Auto |
| --- | --- | --- | --- | --- | --- |
| 480x480 @1 | 480x480 (0.5) | same | same | same | same |
| 1280x720 @1 | 1280x720 (1.333) | same | same | same | same |
| 1920x1080 @1 | 1280x720 x1.5 (1.333) | 1920x1080 (2.0) | 1920x1080 | 1920x1080 | 1920x1080 |
| 2560x1440 @1.25 | 1280x720 x2 | 1920x1080 x1.333 (2.0) | 2560x1440 (2.667) | 2560x1440 | 2560x1440 |
| 3840x2160 @1.5 | 1280x720 x3 | 1920x1080 x2 | 2560x1440 x1.5 (2.667) | 3840x2160 (4.0) | 2560x1440 x1.5 |

AVS via the shipped Studio policy (render size, pixel multiple of 640x360):

| Display | classic (shipped) | crisp | high |
| --- | --- | --- | --- |
| 480x480 | 640x640 (1.78x) | 480x480, k=1 | 480x480 |
| 1280x720 | 640x360 | 640x360, k=2 | 1280x720 (4x) |
| 1920x1080 | 640x360 | 640x360, k=3 | 1280x720 (4x), present x1.5 nearest |
| 2560x1440 @1.25 | 640x360, canvas 1920x1080, CSS x1.333 | 640x360, k=4 | 1280x720, canvas 1920x1080, CSS x1.333 |
| 3840x2160 @1.5 | 640x360, canvas 1920x1080, CSS x2 | 640x360, k=6 | 1280x720, canvas 1920x1080, CSS x2 |

Pixel-art (Auto scaling):

| Display | 320x180 | 256x224 | 384x224 | 320x240 |
| --- | --- | --- | --- | --- |
| 1280x720 | k=4 | sharp-bilinear (prescale 3) | k=3, box 1152x672 | sharp-bilinear (prescale 3) |
| 1920x1080 | k=6 | sharp-bilinear (prescale 4) | sharp-bilinear (prescale 4) | sharp-bilinear (prescale 4) |
| 1920x900 stage | k=5, box 1600x900 | sharp-bilinear (prescale 4) | sharp-bilinear (prescale 4) | sharp-bilinear (prescale 3) |
| 2560x1440 | k=8 | sharp-bilinear (prescale 6) | k=6, box 2304x1344 | sharp-bilinear (prescale 6) |
| 3840x2160 | k=12 | sharp-bilinear (prescale 9) | k=9, box 3456x2016 | sharp-bilinear (prescale 9) |

Snapping: at every tested size the maximum stroke-centre movement is 0.5 device pixel, and stroke/fill edges land on integers (8,000 checks per size).
