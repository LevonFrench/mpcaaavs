# Timing System v2

Status: proposed design, reviewed against the source on 2026-09-28. Nothing in this document is implemented. Every statement under "Verified current behavior" was read from the code; every "proposed" item is a design, not a build result. No GPU, application, browser or renderer was launched, and no visual, audible or live acceptance is claimed. The only executable evidence is a scratch CPU prototype of the core algorithms (see "Evidence" at the end).

Scope: (A) an FPS readout beside the BPM in the top-right timing overlay, (B) transition timing modes (Instant, 1 beat, 2 beats, 1 bar, 2 bars, Random), (C) a stronger repeatable scene clock. It follows [AAAVS shared development](../AAAVS-SHARED-DEVELOPMENT.md): all timing logic lives in shared source under `visualizer/src/`; MPC-HC and the stock Player differ only in persistence and menu/dialog adapters. It must stay compatible with [song analysis and HUD drivers](../SONG-ANALYSIS-AND-HUD-DRIVERS.md) and [HUD animation beds](../HUD-ANIMATION-BEDS.md).

## 1. Summary and recommendation

| Area | Recommendation | Phase |
| --- | --- | --- |
| FPS readout | Headline number is the **present rate** (frames actually composed to the canvas). Optional detail mode adds worker render rate and clock-update rate. Three-state setting (off / fps / detail), default fps. Pure module `fps-meter.ts`, pure label builder `timing-label.ts`. | P0 |
| Transition timing | New enum `fadeTiming` = Seconds, Instant, 1 beat, 2 beats, 1 bar, 2 bars, Random, plus a 5-bit `fadeRandomSet` and `fadeAnchor` (starts at / ends on the boundary). Legacy `beats` (0,1,2,4) is kept as a derived projection so old files, old native registry values and old builds keep working. | P1 (modes), P3 (end anchor) |
| Scene clock | `SceneTiming` v2 = v1 plus optional `beatsPerBar`, `barsPattern` (+`patternHold`), `tempoMap` (BPM steps), `script` (persisted scene cues), `intervals` (named HUD intervals). All optional and omitted at defaults, so v1 files round-trip byte-identically. A new `BeatGrid` abstraction makes the clock independent of "constant BPM" and lets a future song map plug in. | P2 |
| HUD timing | The scene clock already knows every scene's exact start and end; today's frame does not carry them. Add `sceneStart/sceneEnd`, a compact `grid`, and derived beat/bar phase to `NervSceneFrame`. This answers the owner's question: yes, NERV counters can have a start and end that are not fixed. | P2 |
| Tools | Tap tempo, offset nudge, "downbeat here", "restart sequence here", bar:beat readout, cue-sheet export/import (clipboard text), quantized manual queue on the non-clock path. | P2/P3 |
| Deferred | Tempo ramps, per-segment meter, sequence loop regions, sub-scene quantized cues on the clock, explicit beat arrays from song analysis (interface reserved), crossfades for AVS presets under the clock (transition stream). | P4 |

The single most important structural change: **transition timing is resolved by one pure function shared by the clocked path, the live Auto path and tests**, and the scene clock returns a resolved `fade` window with every frame instead of the host recomputing `fadeSeconds` in `render()`.

## 2. Verified current behavior

Read from the code, not from docs. Names are functions/identifiers in `visualizer/src/`.

### 2.1 Timing overlay and FPS

- `#timing` is an absolutely positioned element at the top right (`mpc.html`, `standalone.html`). It has `opacity:0` and becomes visible only on `body:hover`, `body:focus-within` or `body.announce`. It is therefore invisible during unattended full-screen playback.
- `mpc-host.ts` `frame(now)` runs on `requestAnimationFrame`, builds the string with one nested ternary and assigns `timing.textContent` **every animation frame** (no change check).
- The strings are: `Auto · no eligible presets — …`; scene clock: `Scene clock · {bpm} BPM · {n} bars · playing|paused[ · queued {name}]`; `Scene clock held · …`; `Auto off`; `Auto paused`; `Auto · listening for tempo`; `Auto · waiting for audio signal`; locked live tempo: `{round(bpm)} BPM · {bars|waiting for music} [· ready|· preparing]`.
- There is no FPS measurement anywhere in the host. The only frame gating is `dirty`, `resized`, or `transition && position !== lastPresentedPosition`, inside `frame()`. `dirty` is set when a worker returns a frame. The rAF loop itself runs continuously, including while paused.
- The host clock (`position`) is updated only when an `audio` message arrives: about every 33 ms in the Player (`setInterval(tick,33)`), and per native `Tick` in MPC-HC. Between messages `position` is constant, so anything derived from it (scene local time, fade progress) advances in steps at the message rate even though rAF may run at 60 to 144 Hz.
- The NERV worker replies with `renderMs:0` always; a real render cost is not currently reported.
- The NERV plate itself draws `{bpm} BPM / BAR {n}` at its top right (`chrome()` in `nerv-scenes.ts`). Its bar number is `floor(time*bpm/240)`: it ignores `offsetSeconds`, beats per bar and any tempo change.

### 2.2 Transition timing

- Legacy `beats` is in `{0,1,2,4}`; 0 means "use `durationMs`". Validated in `mpc-setups.ts` (`parseSetups`), `standalone-library.mjs` (`settings()`), the native `Preferences()` and `configure` op in `AAAVSView.cpp`, and in the host `settings` handler (`[1,2,4].includes`).
- `durationMs` limits differ by layer: setups and native `configure` clamp 250 to 8000; the host `settings` handler clamps 250 to 80000 (and `managementSettings()` re-clamps to 8000); native `Preferences()` accepts 250 to 80000 when loading the registry.
- **Live path** (`commit()` for Auto phrases and manual changes): `transitionDuration = durationBeats && director.tempo.locked ? durationBeats*60/director.tempo.bpm : durationMs/1000`. The tempo is read once at commit and not updated during the fade. Without a tempo lock the value silently falls back to `durationMs`. There is no cap against the phrase length. The blend starts at the commit position (the phrase boundary) and is driven by media position, so pause freezes it.
- **Clocked path** (`render()`): `fadeSeconds = min(clocked.duration, durationBeats ? durationBeats*60/sceneTiming.bpm : durationMs/1000)`; `blend = min(1, localTime/fadeSeconds)`. It starts at the scene boundary, uses the fixed scene-clock BPM and is capped at the **incoming** scene's duration. `check-nerv-host.mjs` asserts this (`beats:4` at 120 BPM with a one-bar scene gives `blend` 0.125 at 0.25 s).
- **Only NERV plates blend under the clock.** `commit()` disposes the outgoing slot whenever `clockPhase()?.index===active.index`, and `render()` only supplies `previousScene` when the previous catalog entry has a `scene` id. AVS presets under the scene clock therefore hard-cut at the boundary. The lookahead preload in `syncSceneClock()` is likewise limited to NERV-to-NERV changes. `docs/NERV-SCENES.md` states this.
- `Cut` (style 15) is a compositor style; `autoFade`/`manualFade` gate blending per trigger; `keepOld` freezes the outgoing plate. None of them is a zero duration.
- Random style (mode 0) and 9-block order use `seededRandom(seed)` in `mpc-transition.ts`. On the clock, `transitionSeed` is `seed ^ (ordinal+1)*0x9e3779b1 ^ hash(previous) ^ hash(current)*0x85ebca6b`, so it replays after a seek.

### 2.3 Scene clock

- `SceneTiming = {enabled,bpm,offsetSeconds,barsPerScene,seed}`; `parseSceneTiming` is strict (bpm 20..400, |offset| ≤ 3600, bars 1..128, seed 0..2^32-1) and rebuilds the object, dropping unknown keys.
- `sceneAt()` computes `duration = 240*barsPerScene/bpm` (four beats per bar is hard-coded), `ordinal = floor((elapsed+1e-10)/duration)`, then selects the preset from the order (or seeded shuffle cycles via `cycleOrder`) and recorded session cues. Before the offset the first scene holds at time zero. It re-validates timing, order and cues on every call.
- Session cues (`SessionSceneCue {ordinal,index}`, at most 1024) are memory-only and keyed by catalog **index**. Manual Next/Previous/Load queue a cue for the next scene boundary, only for NERV-to-NERV changes.
- `ScenePhase` is `{index,previousIndex,ordinal,start,localTime,progress,duration}`. `check-mpc-scene-clock.mjs` compares it with `assert.deepEqual` against exact 7-key objects, and compares `persisted[0].timing` with exactly the five v1 keys. **Both are compatibility gates for this design.**
- The frame sent to the NERV worker carries `time`, `localTime`, `progress`, `bpm`, `seed` and transition fields. `battery()` uses a hard-coded 16-beat cycle (`fract(beats/16)`), not the scene's own length. `progress` is used only by `sync()`.
- The live director (`mpc-auto-director.ts`) hard-codes four beats per bar: `grid((beatIndex+phase)/4, …)`. Its bar grid origin is the first locked bar, not a detected downbeat. `rearm()` clears `armedAt`, and the next `grid()` call sets `armedAt = bar`.
- `TempoTracker` exposes `bpm`, `locked`, `beatIndex`, `phase`; `director.reset()` clears it on seek.

### 2.4 Settings plumbing

- Native: `Preferences(save)` uses `GetProfileInt/WriteProfileInt(L"AAAVS", key)` for Auto, Shuffle, MinimumRating, KeepOld, ManualFade, AutoFade, Bars, Transition, Beats, DurationMs. `Settings()` posts one flat `{"type":"settings",…}` JSON. The `configure` library op (sent by the page on setup activation and rating changes) reads the same keys with **constant** defaults, so a key absent from the request is reset, not preserved. `Options()` is a `TrackPopupMenu` with hard-coded item IDs (1..5 phrase, 20..35 style, 40..43 beats, 50..53 toggles, 60..65 seconds, 70..75 rating).
- Player: `standalone-player.ts` `settingsFields` drives `setting-*` inputs and `bridge.configure({[key]:value})`; the change-listener loop calls `element(...).addEventListener` without a null guard, so every field needs an element. `standalone-library.mjs` `settings()` rebuilds the object from `Object.keys(defaults)` and `setups()` rebuilds each setup with only `{id,name,presets,settings,timing}`. **Unknown fields are dropped on save**, and `check-standalone-library.mjs` proves parity with the shared TypeScript `parseSetups` case by case.
- `AAAVSLibrary::Json(d["setups"])` in the native `save-setups` op writes the JSON it is given, so new setup fields persist natively without C++ schema work.

## 3. Part A: FPS readout

### 3.1 Which number

Three rates exist and mean different things. The design measures all three cheaply and shows one by default.

| Channel | Marked where | Meaning | Default |
| --- | --- | --- | --- |
| `present` | `frame()` inside the branch that composes and presents (`dirty`, `resized` or transition step) | Frames the viewer actually receives. Falls below the display rate when the worker is slower than rAF (`busy` prevents overlapping renders) and to zero when nothing changes. | **Headline** |
| `display` | top of `frame(now)` | rAF callback rate. Reads about 60 even when idle; useful to see a throttled WebView. | detail |
| `render` | `worker.onmessage` `frame` accepted for the **active** slot | Worker round-trip throughput, excluding stale-revision frames and preloading slots. | detail |
| `clock` | `audio` message that changed `position` | How often the media clock arrives. Explains stepped motion (section 2.1). | detail |

Why present and not display: display is nearly constant and says nothing about visualizer health; present drops when a heavy preset or a slow worker limits the picture. When paused with nothing dirty, present is legitimately zero, so the label **omits** the segment instead of printing `0 fps` (it already says `paused`).

Worker cost: expose real render time by filling the existing `renderMs` field in the NERV and AVS worker replies (currently constant 0 for NERV). This is optional for detail mode ("render 4.1 ms") and independent of the meter.

### 3.2 Measurement

`FpsMeter` is a sliding-window event-rate meter with injected time (rAF timestamp or `performance.now()`); no globals, no DOM, no allocation after construction.

- Ring buffer `Float64Array(512)` of event timestamps (covers 240 Hz in a one-second window).
- `mark(now)`: ignore non-finite input; **reset** when time does not advance or when the gap since the previous mark exceeds `gapMs` (500). This handles hidden tabs, `document.hidden` (rAF stops), suspended WebView, seeks that stall, and clock going backwards. No giant average is ever produced from a stall.
- `read(now)`: return `null` when fewer than three samples remain or the last mark is older than `staleMs` (750). Otherwise evict entries older than `windowMs` (1000) and return `fps = (n-1)*1000/(last-first)`, `worstMs` (largest interval in the window) and `samples`. The one-second window is the smoothing; no extra EMA is needed.
- Cost: three `mark()` calls per rAF frame (a store and a compare each). Reads happen at most twice a second.

Formatting and refresh (`FpsLabel`): the number is refreshed at most every 500 ms, shown as an integer at 10 fps or more and one decimal below, capped at `999+`, and changes only when the rounded value differs, to avoid flicker. Add `font-variant-numeric:tabular-nums;white-space:nowrap` to `#timing` so the box does not jitter.

### 3.3 Where it appears

Placement rule: the fps segment is inserted **immediately after the BPM token** when the state has one, otherwise appended after the state name. It appears only when playing, visible and the meter is fresh.

| State | Today | v2 |
| --- | --- | --- |
| Live tempo locked | `128 BPM · 12 bars · ready` | `128 BPM · 60 fps · 12 bars · ready` |
| Scene clock | `Scene clock · 120 BPM · 3 bars · playing` | `Scene clock · 120 BPM · 60 fps · bar 17.3 · 3 bars · playing` |
| Scene clock, detail | n/a | `Scene clock · 120 BPM · 60 fps (render 58 · clock 30 Hz) · bar 17.3 · 3 bars · playing` |
| Scene clock held | `Scene clock held · …` | unchanged text, `· 60 fps` appended |
| Auto off | `Auto off` | `Auto off · 60 fps` |
| Auto listening / waiting for audio | as today | `… · 60 fps` appended |
| Auto paused, no eligible presets | as today | unchanged (no fps) |

With no fps data or `showFps` off, every string must be **byte-identical to today's**. `timing-label.ts` is a pure function `timingLabel(input): string`; its CPU test keeps a verbatim copy of the current nested ternary as an oracle and compares all states.

### 3.4 Settings and persistence

Display preferences are global, not per setup, and must not travel inside `SetupSettings`: setup activation sends its settings to `configure`, and native `configure` currently resets absent keys.

| Field | Range | Default | Meaning |
| --- | --- | --- | --- |
| `showFps` | 0,1,2 | 1 | 0 off, 1 fps, 2 detail |
| `timingOverlay` | 0,1 | 0 | 0 today's hover/announce visibility, 1 always visible (`body.timing-always #timing{opacity:1}`) |

Native keys `ShowFps`, `TimingOverlay`. The host `settings` handler reads them only when present and valid, and **keeps the current value otherwise**. Native `configure` must read them with the current member as fallback (not a constant). Player: two `<select>`s, server whitelists the two optional keys.

### 3.5 The NERV plate top right

The plate's own `BPM / BAR` text is deterministic renderer output. FPS must **not** be drawn into the plate: it would make pixels depend on machine speed and break the replay checks. The plate should instead show the correct clock values (section 5.7): offset-aware bar, beats per bar, instantaneous BPM. The overlay is the FPS surface.

### 3.6 Optional clock interpolation (recommended, not required)

Because `position` steps at the message rate, motion cadence is capped by it. A bounded extrapolation `presentationPosition = position + min(0.066, (now-lastAudio)/1000)` while playing and fresh would smooth NERV local time and fade progress. Scene selection and boundaries must keep using the raw `position`. Risk: a scene drawn up to 66 ms "past" its boundary; replay stays deterministic because the same rule applies to the same inputs. Ship only after live acceptance; the `clock` rate in detail mode is what makes the problem visible.

## 4. Part B: transition timing

### 4.1 The enum

```ts
// visualizer/src/mpc-transition-timing.ts (new)
export const FADE_TIMING = ['seconds','instant','beat1','beat2','bar1','bar2','random'] as const;
export type FadeTiming = 0|1|2|3|4|5|6;                 // index into FADE_TIMING
export type ConcreteFade = 0|1|2|3|4|5;                  // what a boundary can resolve to
export interface FadeSpec { timing:FadeTiming; randomSet:number; anchor:0|1; fixedMs:number }
export const defaultFadeSpec:Readonly<FadeSpec> = Object.freeze({timing:0,randomSet:31,anchor:0,fixedMs:2000});
export interface FadePlan { timing:ConcreteFade; beats:number; seconds:number; anchor:0|1 }
```

| Value | Name | Length |
| --- | --- | --- |
| 0 | Seconds | `fixedMs` (250..8000), the existing "Seconds / fallback" control |
| 1 | Instant | 0 |
| 2 | 1 beat | 1 beat |
| 3 | 2 beats | 2 beats |
| 4 | 1 bar | `beatsPerBar` beats (4 unless the clock says otherwise) |
| 5 | 2 bars | `2*beatsPerBar` beats |
| 6 | Random | one of 1..5 chosen per boundary from `randomSet` |

`randomSet` bits: bit0 Instant, bit1 1 beat, bit2 2 beats, bit3 1 bar, bit4 2 bars; range 1..31, default 31 (all five values the owner listed). Seconds is not a member: it is a fixed duration, not one of the listed musical values. A single-bit set behaves as that fixed mode.

### 4.2 Which BPM, and what "1 beat" means

| Situation | Beat length source | Notes |
| --- | --- | --- |
| Scene clock on | the clock's `BeatGrid` at the boundary; the window is `timeAt(B+beats)-timeAt(B)` (or `timeAt(B)-timeAt(B-beats)` for the end anchor) | Exact under a tempo map: the fade ends on a grid beat. Never reads the live detector. |
| Live Auto/manual, tempo locked | `director.tempo.bpm` at the moment of commit, frozen for that fade | Same as today for beats 1,2,4. A half/double-time misread of the detector propagates by design. |
| Live/manual, no tempo lock | **none**: every non-Instant mode resolves to `fixedMs` | Matches today and the control's own label "Seconds / fallback". Auto never switches without a lock, so this happens only for manual changes. Instant stays 0. |

A bar is `beatsPerBar` beats. It is 4 everywhere until a `beatsPerBar` is set on the setup's timing block (section 5.2); the live director then uses the same value.

Caps (both prevent overlapping windows):

- Start anchor, clocked: `min(plan, incoming scene duration)`. This is today's rule and keeps the existing test valid.
- End anchor, clocked: `min(plan, outgoing scene duration)`.
- Absolute limit for beat-derived modes: 16 s.
- Live with a fixed phrase (`director.bars>0`): also `min(plan, phrase length)`; adaptive phrases apply only the absolute limit.

Seconds mode keeps today's limits (250..8000 ms). Recommendation: make the host `settings` clamp and native `Preferences()` 8000 too, so all layers agree; only a hand-edited registry value could observe the change.

### 4.3 Instant versus Cut versus autoFade off

| Control | What it does | Outgoing slot rendered? | Scope |
| --- | --- | --- | --- |
| Style **Cut** (15) | Compositor draws the incoming plate at once; duration ignored | No (disposed at commit) | Every change |
| **autoFade / manualFade off** | No blend for that trigger class | No | One trigger class |
| Timing **Instant** | Duration 0 for any style | No: a resolved length of 0 takes the same dispose path as Cut | Every change, or one member of Random |
| **keepOld off** | Outgoing plate frozen at its boundary time | Not re-rendered live | Only inside a fade window |

The practical difference: Instant can be one *member* of Random, so a setup can mix hard cuts with fades per boundary; Cut and the fade toggles cannot. Because Instant takes the Cut path it also removes the cost of rendering the outgoing slot.

### 4.4 Random

Deterministic pick, independent of history:

```ts
// pure; shares cycleOrder from mpc-scene-clock.ts (export it)
export function pickFade(spec:FadeSpec, index:number, seed:number):ConcreteFade {
  const base=CONCRETE.filter((_,i)=>spec.randomSet>>i&1);           // ascending order, k = 1..5
  return cycleOrder(base, Math.floor(index/base.length), (seed^0xa5f1c3d7)>>>0)[index%base.length]!;
}
```

- It is a "bag": every member appears exactly once per cycle of `k` boundaries, permuted per cycle, and for `k>=3` no member repeats across a cycle seam (the existing `cycleOrder` guarantee). With `k=2` it alternates; `k=1` is constant. A pure iid draw would repeat and could starve a member for many boundaries; a bag gives visible variety.
- **Clocked:** `index` is the scene ordinal of the incoming scene, `seed` is `timing.seed`. The pick is a pure function of `(seed, ordinal, set)`, so it replays identically after seek, repeat and pause, and cannot depend on frame order. The salt `0xa5f1c3d7` keeps it uncorrelated with the style seed used by Random style.
- **Live:** `index` is a per-activation counter incremented per committed fade, `seed` is the active setup's `timing.seed`, or, with no setup, a session seed created once at host start from an injectable source (default `Math.random`, only in the host; tests inject). Live picks need not replay after seek; they need only be stable, seeded and unit-testable.
- The module must contain no `Math.random`, `Date.now` or `performance.now`. A source-lint assertion in the test enforces this.
- Random timing and Random style are independent draws.

### 4.5 Start versus end anchor

Both are worth offering; the default stays **start** so existing setups behave as today.

- **Start (today):** the blend begins on the boundary and completes `d` later. The downbeat is the first frame of the change. Feels like "hit, then dissolve".
- **End ("land on the beat"):** the blend occupies `[B-d, B]`, so the incoming scene is fully present on the downbeat. Feels like "build into the drop". This is standard VJ practice for impact changes.

Feasibility differs by path:

| Path | Start anchor | End anchor |
| --- | --- | --- |
| Clocked NERV | supported today | fully deterministic; needs a wider preload lookahead (`d` + load margin, currently `min(2 s, bar, duration/4)`) and the frame contract below |
| Clocked AVS preset | hard cut today | out of scope until the transition stream adds a compositor path; the plan resolves anyway, the renderer ignores it |
| Live Auto | supported today | easy for AVS and NERV alike (pure compositor blend), but needs the director changes in section 4.6 |
| Manual change | starts now | not applicable (no boundary); starts now |

Frame contract for the end anchor. During `[B-d, B)`, `ClockFrame.index` is still the musically current scene `n-1` (its `localTime` keeps running) while `frame.fade = {from:n-1, to:n, start:B-d, end:B, progress}`. The incoming scene is drawn at `localTime = 0` (its opening frame, frozen) until `B`, then animates normally. The host renders `fade.to` as the active plate and `fade.from` as the outgoing plate whenever `fade.progress>0`. Late load is safe: progress is computed from absolute media time, so a slot that arrives halfway simply enters halfway; nothing restarts. Overlap is impossible because the cap keeps `d_n <= duration(n-1)`.

`fade.progress` is time-domain, `(t-start)/seconds`, matching today's `blend=localTime/fadeSeconds`; the window endpoints come from the grid, so a fade always ends on a real beat even across a tempo change.

### 4.6 Live path changes for the end anchor (P3)

The live director must know the fade length before the phrase boundary. Proposed, all with defaults that preserve today's behavior:

- `MpcAutoDirector.beatsPerBar` (default 4) replaces the literal 4 in `update()`.
- `grid(bar, trusted, leadBars = 0)`: `prepare` when `bar >= target - 1 - leadBars`; `switch` when `bar >= target - leadBars` (once, guarded by the existing `preparationStarted`/rearm flow instead of the whole-bar `boundary` test when `leadBars>0`).
- `rearm(origin?:number)`: when the switch fired early, the host calls `director.rearm(target)` so the next phrase is measured from the **true boundary**, not from the early commit. Without this every anticipatory commit would shorten the next phrase by `d`, a drift that accumulates. The pinned origin is discarded if it is not within one phrase of the current bar.
- Host: resolve the next pick and `leadBars = plan.beats / beatsPerBar` before calling `director.update()`.

### 4.7 Combination with legacy fields and compatibility

Stored data must load unchanged:

| Input | Result |
| --- | --- |
| `beats` present, `fadeTiming` absent (all existing setups, registry, settings.json, old page messages) | `fadeTiming = {0:0, 1:2, 2:3, 4:4}[beats]` |
| `fadeTiming` present and valid | authoritative |
| `fadeTiming` present and invalid | setup file: `parseSetups` throws (same strictness as other fields); host message: ignored, falls back to `beats` |
| Any write by a v2 build | `beats` is also written as the **projection** `{0:0, 2:1, 3:2, 4:4}` (Instant, 2 bars and Random project to 0) so an older build still loads the file and fades for `durationMs` |

"4 beats" (legacy) is now "1 bar"; with `beatsPerBar=4` they are identical, and a legacy setup can only differ if the user later sets another meter, in which case the UI states the bar length.

`SetupSettings` gains optional fields, omitted when absent:

```ts
export interface SetupSettings { /* existing fields unchanged */
  fadeTiming?:number;     // 0..6
  fadeRandomSet?:number;  // 1..31
  fadeAnchor?:number;     // 0 start, 1 end
  queueQuantize?:number;  // 0..3, P3 (section 5.8)
}
```

`defaultSettings` is **not** changed, and `parseSetups` copies these fields only when present, so `check-mpc-scene-clock.mjs` (`deepEqual(parseSetups(json)[0], configured)`), `check-mpc-management.mjs` and the legacy-setup cases stay valid. New setups created from the live settings (`managementSettings()`) will carry the fields. `validate` rules: integer within range, otherwise throw with a specific message.

### 4.8 Host protocol

Page to native and native to page, `settings` message (flat JSON, as today):

```json
{"type":"settings","enabled":true,"bars":0,"transition":1,"beats":2,"shuffle":false,"minimumRating":0,
 "manualFade":true,"autoFade":true,"durationMs":2000,"keepOld":true,
 "fadeTiming":3,"fadeRandomSet":31,"fadeAnchor":0,"queueQuantize":0,"showFps":1,"timingOverlay":0}
```

Host handling: `fadeTiming` valid int 0..6 else derived from `beats`; `fadeRandomSet` valid 1..31 else 31; `fadeAnchor` 0/1 else 0; `showFps`/`timingOverlay` keep current when missing. A page receiving an old native message (no new keys) behaves exactly as today.

### 4.9 Host sketch (clocked and live)

```ts
// clocked: render() no longer computes fadeSeconds; it reads frame.fade
const f=clocked?.fade;                                    // resolved by the scene clock
const blend=f?Math.min(1,f.progress):undefined;
nerv:{…, ...(f&&previous&&autoFade&&transitionMode!==15&&f.seconds>0?
  {previousScene:catalog[f.from]!.scene,previousTime:keepOld?position:clocked!.start,
   previousLocalTime:keepOld?position-clocked!.previousStart:clocked!.previousFrozen,blend,
   fadeSeconds:f.seconds,fadeBeats:f.beats,fadeAnchor:f.anchor}:{})}

// live: commit()
const plan=planFade(fadeSpec,pickFade(fadeSpec,liveFadeCount++,liveFadeSeed),
  {bpm:director.tempo.locked?director.tempo.bpm:null,beatsPerBar,capSeconds:liveCap()});
transitionDuration=plan.seconds;
if(!fade||transitionMode===15||plan.seconds<=0||clockPhase()?.index===active.index){dispose(outgoing);outgoing=null;transition=null;}
```

## 5. Part C: the stronger scene clock

### 5.1 Evaluation of the ideas

| Idea | Value | Cost | Risk | Verdict |
| --- | --- | --- | --- | --- |
| Beats per bar / time signature (global) | High: 3/4, 5/4, 7/8 songs are otherwise mis-barred | Low: one integer in the beat domain | Low | **P2** |
| Variable bars-per-scene pattern, e.g. `[4,4,8,16]`, with hold-last | High: phrase structures are rarely uniform; this is the bridge to a song map | Low-medium: prefix sums + binary search | Low | **P2** |
| Tempo map (BPM steps) | High for DJ sets and tempo changes; makes the "fixed BPM" honest | Medium: beat/time grid, O(log n) | Medium: precision at joins (tested) | **P2** |
| Tempo ramps | Medium | Medium: quadratic inverse | Medium | P4; approximate with steps |
| Per-segment meter | Low | Medium | Medium: scene length becomes ambiguous | P4 |
| Tap tempo | High | Low | Low | **P2** |
| Offset nudge, "downbeat here", "restart sequence here" | High | Low | Low | **P2** |
| Capture detected tempo (copy live BPM + beat phase into the draft) | Medium | Low | Low: one-shot copy, never auto-following | **P2** |
| Follow detected downbeats automatically | Medium | High | High: detector has no downbeat, would break repeatability | rejected; use song analysis |
| Bar:beat readout | High | Low | Low | **P2** |
| Beat/bar phase and interval signals to scenes | Very high: unlocks HUD counters | Medium | Low if optional | **P2** |
| Named intervals for HUD counters | High | Low-medium | Low | P3 |
| Quantized manual queue (beat/bar) on the non-clock path | Medium | Medium | Medium: needs a trusted tempo | P3 |
| Quantized cue mid-scene on the clock | Medium | High: cues become sub-scene boundaries, breaks the O(1) ordinal model | High | P4 |
| Sequence loop regions | Low: transport A-B repeat already replays deterministically | Medium | Medium: cues/shuffle interplay | P4 |
| Persisted scripted cues | High for authored shows | Low | Low | P3 |
| Cue-sheet export/import (clipboard text) | Medium-high | Low-medium | Low | P3 |
| Native file dialog for cue sheets | Low | High | Unverified in the hosted WebView | not recommended |
| Explicit beat array grid (song analysis) | High later | n/a | depends on the scanner | interface reserved |

### 5.2 `SceneTiming` v2 schema

```ts
export interface TempoChange { readonly at:number; readonly bpm:number }
export interface ScriptedCue { readonly ordinal:number; readonly preset:string }        // preset = sha256, never an index
export interface NamedInterval { readonly id:string; readonly startBeat:number; readonly endBeat:number }
export interface SceneTiming {
  enabled:boolean; bpm:number; offsetSeconds:number; barsPerScene:number; seed:number;    // v1, unchanged
  version?:2;
  beatsPerBar?:number;             // integer 1..16, default 4
  barsPattern?:readonly number[];  // 1..64 integers, each 1..128; overrides barsPerScene per ordinal
  patternHold?:boolean;            // default false: pattern cycles; true: last entry repeats forever
  tempoMap?:readonly TempoChange[];// 1..256 entries; at: seconds, > offsetSeconds, strictly increasing, <= 1e6; bpm 20..400
  script?:readonly ScriptedCue[];  // <= 1024, strictly increasing ordinals, sha256 presets
  intervals?:readonly NamedInterval[]; // <= 64; id /^[a-z0-9_-]{1,32}$/ unique; 0 <= startBeat < endBeat <= 1e7
}
```

Rules:

- **Minimal serialization.** Any v2 field equal to its default is omitted, and `version:2` is written only when some v2 field is present. A v1 timing round-trips as exactly its five keys (required by `check-mpc-scene-clock.mjs`).
- `bpm` remains the base tempo (before the first `tempoMap` entry). `barsPerScene` remains present and is the legacy projection of the pattern (its first entry) so an older build degrades to a constant clock instead of failing.
- Unknown keys are dropped on parse (today's behavior). A `version` greater than 2 is accepted and its known fields used; a future format must stay additive or use a new `format` name.
- Errors are specific (`Scene timing beatsPerBar must be a whole number from 1 to 16`), like today's single message but per field.
- File-level: `setups.json` stays a bare array. A file version would break older builds.

Downgrade caveat: an older build that loads and re-saves a v2 setup strips the v2 fields (it rebuilds `timing` and `settings`). Nothing crashes; the v2 information is lost on that save. Documented, not prevented.

### 5.3 Beat grid, pattern and clock

```ts
// visualizer/src/mpc-beat-grid.ts (new)
export const BEAT_EPS = 1e-9;
export interface BeatGrid { beatAt(t:number):number; timeAt(beat:number):number; bpmAt(t:number):number; readonly constant:boolean }
export function compileGrid(bpm:number, offset:number, changes:readonly TempoChange[]=[]):BeatGrid { /* prefix sums; two binary searches */ }
export interface ScenePattern { at(beat:number):{ordinal:number;startBeat:number;beats:number}; startBeat(ordinal:number):number; beats(ordinal:number):number }
export function compilePattern(bars:readonly number[], beatsPerBar:number, hold:boolean):ScenePattern
```

Algorithms (all O(log n), no scanning of earlier scenes):

- `beatAt(t)`: 0 for `t <= offset`; otherwise `B[i] + (t-T[i])*R[i]/60` with `i` the segment found by binary search over start times; `B[i]` are cumulative beats precomputed at compile time. `timeAt(b)` is the mirror search over `B`. Both are continuous and strictly increasing.
- `pattern.at(x)`: `x + BEAT_EPS`; one cycle holds integer beat counts, so prefix sums are exact integers. Cyclic: `cycle = floor(x/total)`, index by binary search inside the cycle. Hold: after the last entry start, `k = floor((x-P[m-1])/S[m-1])`.
- Boundary rounding: scene boundaries are integer beat positions, recovered by `floor(beatAt(t)+BEAT_EPS)`. The `1e-9`-beat tolerance replaces v1's `1e-10`-second tolerance and absorbs the sub-ulp error of `beatAt(timeAt(n))`.
- Seeks: ordinals, starts and ends are pure functions of `t`; nothing depends on evaluation order.

```ts
// visualizer/src/mpc-scene-clock.ts (extended; sceneAt unchanged in signature and result shape)
export interface FadeWindow { ordinal:number; from:number; to:number; start:number; end:number; seconds:number; beats:number; timing:ConcreteFade; anchor:0|1; progress:number }
export interface ClockFrame extends ScenePhase {
  end:number; startBeat:number; endBeat:number;
  beat:number; bar:number; beatInBar:number; beatPhase:number; barPhase:number; beatsPerBar:number;
  bpm:number;               // instantaneous tempo
  beatProgress:number;      // (beat-startBeat)/scene beats
  remaining:number;         // seconds to scene end, >= 0
  barsRemaining:number;     // ceil((endBeat-beat)/beatsPerBar - 1e-9)
  countIn:number;           // seconds until offset, 0 afterwards
  previousStart:number; previousFrozen:number;   // outgoing plate local times for keepOld on/off
  fade:FadeWindow|null;
}
export interface SceneClock { readonly timing:SceneTiming; readonly grid:BeatGrid;
  at(position:number, order:readonly number[], shuffle:boolean, cues?:readonly SessionSceneCue[], fade?:FadeSpec):ClockFrame|null;
  barBeat(position:number):{bar:number;beat:number} }
export function compileSceneClock(timing:SceneTiming):SceneClock;   // validates once; host caches per activation
export function sceneAt(/* unchanged */):ScenePhase|null;            // legacy 7-key result
```

Compatibility strategy: `sceneAt` keeps its signature and **exact result keys**. For a v1-shaped timing (no v2 fields) both `sceneAt` and `SceneClock.at` take the original arithmetic path (`240*bars/bpm`, `floor((elapsed+1e-10)/duration)`), so results are bit-identical by construction and the existing tests remain the regression gate. The general beat-domain path is used only when a v2 field is present; a property test checks that it agrees with the legacy path to 1e-9 on constant-tempo inputs. Shuffle, cues and `cycleOrder` are unchanged and keyed by ordinal.

Performance: `sceneAt` today re-parses timing and validates order and cues on every frame. `compileSceneClock` moves the timing validation to activation; per-frame order/cue validation stays (it is O(n) with n at most 500) to preserve the throw-on-bad-input behavior tested today.

### 5.4 Fade window resolution inside the clock

```ts
// for the boundary of ordinal n (n >= 1): B = pattern.startBeat(n)
const plan = planFade(spec, pickFade(spec, n, timing.seed), {beatsPerBar, capBeats: anchor===0 ? pattern.beats(n) : pattern.beats(n-1), grid, boundaryBeat: B});
// start anchor: window [timeAt(B), timeAt(B)+seconds]; end anchor: [timeAt(B)-seconds, timeAt(B)]
```

`at()` evaluates at most two candidate windows (the current boundary for the start anchor; the next boundary for the end anchor) in O(log n). Scene 0 has no fade. `planFade` converts beats to seconds through the grid, so tempo maps are exact.

### 5.5 Answer: NERV counters with non-fixed start and end

Yes. Today the scene clock knows each scene's exact start and end, but the NERV frame carries only `localTime`, `progress`, `bpm` and `seed`, and `battery()` ignores the scene entirely with a hard-coded 16-beat cycle. Fixing this is a data plumbing change, not a new clock.

Definition. A scene interval is `[start, end)` where `start = timeAt(startBeat)` and `end = timeAt(endBeat)` come from the grid and the pattern. The interval of scene `n` and the start of scene `n+1` are the **same number**, so chained intervals never gap or overlap. For any position `t`: `progress = clamp((t-start)/(end-start),0,1)`, `remaining = max(0,end-t)`, and a countdown displays `ceil(remaining - 1e-9)` whole seconds, which reaches 0 exactly at `end` independent of frame rate. A count-up is `round(from + (to-from)*progress)` with the endpoint exact. Both follow the "exact endpoint, frame-rate independent" rule in the HUD documents. An outgoing plate during a fade still receives its own interval, so it shows the count held at its end value instead of rolling over.

Frame additions (all optional; absent means today's legacy derivation, so existing scenes and tests are untouched):

```ts
// visualizer/src/nerv-scenes.ts
export interface NervClockGrid { readonly offset:number; readonly beatsPerBar:number; readonly bpm:number; readonly changes?:readonly (readonly [at:number,bpm:number])[] }
// NervSceneFrame:   grid?:NervClockGrid;  sceneStart?:number;  sceneEnd?:number;
// NervPlaybackFrame (avs-worker-protocol.ts): previousSceneStart?, previousSceneEnd?, fadeSeconds?, fadeBeats?, fadeAnchor?
export interface TimingSignals { beat:number; sceneBeat:number; bar:number; beatInBar:number; beatPhase:number; barPhase:number; beatsPerBar:number;
  interval:{start:number;end:number;progress:number;remaining:number;elapsed:number}|null }
```

`renderNervScene` derives `TimingSignals` from `time` and the frame's `grid`/`sceneStart`/`sceneEnd` with the same pure grid code the host uses. Deriving in the renderer, rather than sending precomputed scalars, is deliberate: the worker renders both the incoming and the outgoing plate at different `time` values, and deriving from `time` gives each plate correct values with no per-plate duplicate fields. Cost: with a tempo map the `changes` array (at most 256 pairs) is part of every render message; measure before shipping, and cache by a `gridRevision` if it matters. The plate's chrome then shows the correct `bar` and pips (`beatsPerBar`, not a fixed 4), and `battery()` can count down to `interval.end`, falling back to its 16-beat cycle when `interval` is null (live Auto with no clock).

Named intervals (`timing.intervals`, P3) resolve through the same code: `startBeat/endBeat` in clock beats map to seconds via the grid and appear as `activeIntervals` for HUD bindings that name them (a boss timer independent of scene length). Scope choices a HUD binding may use: `scene` (default), `bar`, or a named id. Without a clock a HUD must show its authored fallback cycle or an "estimating" state; it must not invent a countdown to an unknown boundary.

### 5.6 Beat/bar phase signals and transitions

`beatPhase`, `barPhase`, `beatInBar`, `bar` and `beatsPerBar` come from `TimingSignals` for scenes, and are also the inputs to "cooler transitions" that use the repeatable timing. The transition stream should consume this contract rather than re-derive time:

```ts
export interface TransitionSignals { progress:number; seconds:number; beats:number; beatsElapsed:number; beatPhase:number; barPhase:number; boundaryBeat:number; seed:number; anchor:0|1 }
// AvsTransition.draw(ctx, old, next, progress, w, h, signals?:TransitionSignals)  // optional 7th argument, existing calls unchanged
```

Because the seed already comes from `(seed, ordinal, previous, current)`, a beat-locked effect (blocks snapping on beats, wipe edges quantized to the beat grid) replays exactly after a seek.

### 5.7 Tools and readouts

- **bar:beat readout.** `barBeat(position)` gives the 1-based bar since the offset and the beat in the bar: `bar 17.3`. Shown only on the scene clock. Live mode shows no bar number because the live bar grid has no true downbeat.
- **Tap tempo.** Pure `TapTempo` (`mpc-timing-tools.ts`): timestamps in seconds, a gap over 2 s starts a new set, at most 12 kept, at least 4 required, taps more than 25 percent off the median interval are rejected, then least squares over tap index. Result rounded to 0.01 and accepted only in 20..400. Timestamps are **media time**: the page maps a click to `position + min(0.25, (now-lastAudio)/1000)` while playing, so a paused tap uses the frozen position. Input latency is corrected with the nudge, not hidden.
- **Nudge.** Buttons for ±10 ms, ±50 ms, ±1 beat on `offsetSeconds`; exact arithmetic on the number, clamped to the ±3600 range.
- **Downbeat here.** `offset' = offset + ((position-offset) mod barSeconds)`; the bar grid shifts to put a bar line at the current position while scene lengths stay relative to it. Idempotent. **Restart sequence here** sets `offset' = position`. Both are exact functions of numbers, unit-tested; neither reads the live detector.
- **Capture detected tempo.** Copies `director.tempo.bpm` (rounded to 0.01) into the draft and, using `tempo.phase`, moves `offset` onto the nearest beat; disabled without a lock. It is a one-shot copy: the saved clock never follows the live detector, which preserves repeatability.
- **Cue sheet (P3).** A portable JSON document, exported and imported through a text area in the Setup Builder plus the clipboard (works in both hosts with no native file dialog):

```json
{"format":"aaavs-cue-sheet","version":1,"name":"optional, up to 120 chars",
 "timing":{"enabled":true,"bpm":128,"offsetSeconds":0.42,"barsPerScene":8,"seed":7,"version":2,
           "barsPattern":[4,4,8,16],"tempoMap":[{"at":134.2,"bpm":140}],"script":[{"ordinal":4,"preset":"<sha256>"}]},
 "fade":{"fadeTiming":6,"fadeRandomSet":22,"fadeAnchor":1,"durationMs":2000},
 "note":"free text, up to 200 chars"}
```

Rules: at most 256 KiB, unknown keys dropped, `__proto__`/`constructor` keys rejected, non-finite numbers rejected, a `version` above 1 refused with a clear message, presets referenced by sha256 only and unknown ones dropped with a count. No paths, titles or tags are exported. `script` entries become the initial `sceneCues` on activation (index mapped through the active setup's order); live manual choices are appended by the existing `scheduleSceneCue`, sharing the 1024 budget. "Bake session choices into script" exports the current session cues as hash entries; today they are memory-only by design (`docs/NERV-SCENES.md`), and this remains opt-in.

### 5.8 Quantized manual queue

Today a manual change is immediate on the non-clock path and queued to the next scene boundary on the clock (NERV to NERV). Proposal (P3), setting `queueQuantize`: 0 immediate (default, today), 1 next beat, 2 next bar, 3 next phrase. On the clock, values 0 to 2 keep meaning "next scene boundary" (sub-scene cues are rejected as P4). On the live path the prepared slot waits for the next beat/bar boundary from the tempo tracker; without a lock it commits immediately and says so in the status line.

### 5.9 Compatibility with the planned song analysis

- Implementations of `BeatGrid`: `ConstantGrid` (v1), `TempoMapGrid` (v2) and, later, `ExplicitBeatGrid` over a beat-timestamp array with binary search and interpolation, which is what the analyzer produces. `SceneClock` only sees the interface.
- A cue plan maps onto v2 fields: local tempo curve to `tempoMap`, detected section lengths to `barsPattern`, authored cue intervals to `intervals`, chosen presets to `script`. Five-minute scan chunks never appear in the clock; scene lengths come from the pattern, so a chunk edge cannot become a scene ending.
- Commit rule ("do not chase a shifting endpoint"): the compiled clock is immutable per activation. A better analysis is applied by compiling a new clock and switching at a **scene boundary** at least one preload lookahead away; ordinals before the switch are unchanged. A helper `stitchClock(previous, next, atOrdinal)` is P4; the activation path already gives the required behavior at scene granularity.
- Unknown confidence: hold the current clock and show the estimating state. Never silently fall back from an analyzed clock to the live detector.

## 6. UI and native surfaces

### 6.1 Setup Builder (`mpc-management.ts`)

Transition block (per setup):

- **Timing** select: Seconds, Instant, 1 beat, 2 beats, 1 bar, 2 bars, Random (replaces the "Duration" select). Below it a line: `1 bar = 4 beats` (or the clock's meter) and, for beat modes without a clock, `no tempo lock: uses Seconds`.
- **Random includes**: five checkboxes, enabled only for Random, refusing to clear the last one.
- **Transition lands**: `Starts at the scene boundary` / `Ends on the scene boundary`.
- **Seconds / fallback** stays.
- **Manual queue** select (P3).

Repeatable scene timing block, in addition to the current four numbers: Beats per bar (1..16), Bars pattern (text `4,4,8,16` with live validation plus "hold last"), Tempo changes (rows of `time` and `BPM`, add/remove, sorted on save), buttons Tap tempo, Nudge −50/−10/+10/+50 ms, −1/+1 beat, Downbeat here, Restart sequence here, Use detected tempo (disabled unless locked), Export/Import cue sheet, and a live readout `bar 17.3 · scene 3 of 8 bars`. `timingControls()` types its numeric helper as `Exclude<keyof SceneTiming,'enabled'>`; it must be narrowed to the numeric keys. New controls must never write default-valued fields.

`Actions` gains `position():number`, `playing():boolean`, `tempo():{locked:boolean;bpm:number;phase:number}`.

### 6.2 Native menu (`AAAVSView.cpp` `Options()`)

- Replace the **Transition duration** submenu with **Transition timing** (radio items): `Seconds (classic 2 s)`, `Instant`, `1 beat`, `2 beats`, `1 bar`, `2 bars`, `Random`; items 80 to 86. Keep a **Fixed duration** submenu with the six seconds items 60 to 65 (choosing one sets `fadeTiming=0`, as it sets `beats=0` today).
- **Random includes** popup with five checked items 90 to 94; a click that would clear the last bit is ignored.
- **Transition lands on**: `Scene boundary starts it` (95) / `Scene boundary ends it` (96).
- Toggle **Show FPS** cycles off/fps/detail (54); **Timing overlay always visible** (55). Optional **Manual queue** submenu (P3).
- Item IDs are local to `TrackPopupMenu`, so no compatibility constraint.

### 6.3 Native state, preferences and messages

```cpp
int fadeTiming = -1, fadeRandomSet = 31, fadeAnchor = 0, queueQuantize = 0, showFps = 1, timingOverlay = 0;
static int FadeFromBeats(int b){ return b==1?2 : b==2?3 : b==4?4 : 0; }
static int BeatsFromFade(int f){ return f==2?1 : f==3?2 : f==4?4 : 0; }
// Preferences(): registry keys FadeTiming, FadeRandomSet, FadeAnchor, QueueQuantize, ShowFps, TimingOverlay
fadeTiming = value(L"FadeTiming", fadeTiming);              // absent key returns -1
if (fadeTiming < 0 || fadeTiming > 6) fadeTiming = FadeFromBeats(beats);   // first run after upgrade
fadeRandomSet = std::clamp(value(L"FadeRandomSet", fadeRandomSet), 1, 31);
fadeAnchor = std::clamp(value(L"FadeAnchor", fadeAnchor), 0, 1);
showFps = std::clamp(value(L"ShowFps", showFps), 0, 2);
timingOverlay = std::clamp(value(L"TimingOverlay", timingOverlay), 0, 1);
beats = BeatsFromFade(fadeTiming);                          // legacy projection, always written
```

- In save mode derive `fadeTiming` from `beats` first if it is still -1.
- `Settings()` appends `,"fadeTiming":N,"fadeRandomSet":N,"fadeAnchor":N,"queueQuantize":N,"showFps":N,"timingOverlay":N` and keeps `beats` as the projection.
- `configure` op: `fadeTiming = clamp(integer("fadeTiming", fadeTiming),0,6)`, likewise the others, with the **current member as the fallback** so a setup that lacks a key (every existing setup) leaves display prefs and fade prefs untouched; when the request has `fadeTiming` but not `beats` (or the reverse) the projection rules above resolve it. Existing clamps (`durationMs` 250..8000) stay.
- Menu handling updates `fadeTiming` and sets `beats = BeatsFromFade(fadeTiming)` in the same step.
- No new native commands or Tick payload fields are needed: FPS, tap tempo and cue sheets are page-side. Registry values written by an older build are preserved; a downgrade ignores the new keys and uses `Beats`.

### 6.4 Player (`standalone.html`, `standalone-player.ts`, `standalone-library.mjs`)

- `standalone.html`: replace `setting-beats` with `setting-fadeTiming` (7 options; keep `setting-beats` out of `settingsFields` but leave the id if legacy scripts refer to it), add `setting-fadeAnchor`, `setting-showFps`, `setting-timingOverlay` selects and five checkboxes `setting-fadeSet0..4` for the mask. Add the `#timing` CSS changes.
- `standalone-player.ts`: extend `settingsFields` with `fadeTiming`, `fadeAnchor`, `showFps`, `timingOverlay`; add dedicated binding code for the mask; **guard the listener loop** for missing elements.
- `standalone-library.mjs`: accept the new keys as **optional** in `settings()` (integers in range) and preserve them, keep `defaults` unchanged so `load-settings` on an old `settings.json` is identical; extend `timing()` and `setups()` to validate and keep every v2 field with the same rules as `mpc-scene-clock.ts` and `mpc-setups.ts`. The dependency-free duplication stays (a shared `.mjs` validator would remove it but breaks the TypeScript-only source idiom); the existing parity harness is extended with the matrix in section 8.

## 7. Files, protocol summary and rollout

New shared source (`visualizer/src/`): `fps-meter.ts`, `timing-label.ts`, `mpc-beat-grid.ts`, `mpc-transition-timing.ts`, `mpc-timing-tools.ts`, `mpc-cue-sheet.ts`. Extended: `mpc-scene-clock.ts` (schema, `SceneClock`, `cycleOrder` exported), `mpc-auto-director.ts` (`beatsPerBar`, `leadBars`, `rearm(origin)`). Shared-file edits are listed in the handoff for the hub owners: `mpc-host.ts`, `mpc-management.ts`, `mpc-setups.ts`, `nerv-scenes.ts`, `nerv-render.worker.ts`, `avs-worker-protocol.ts`, `mpc.html`, `standalone.html`, `standalone-player.ts`, `standalone-library.mjs`, `AAAVSView.cpp`, `package.json`, `tools/aaavs-mirror.json`, and the docs that describe timing (`NERV-SCENES.md`, `PRESET-MANAGEMENT.md`, the shared-development table).

Rollout:

1. **P0** FPS meter, label builder, `showFps`/`timingOverlay`, overlay CSS, DOM write dedupe. Smallest visible win, independent of everything else.
2. **P1** Fade modes on the start anchor: enum, mapping, Random bag, instant-as-cut, setups/native/Player/UI plumbing, live and clocked resolution through one function.
3. **P2** Beat grid, beats per bar, pattern, tempo map, `SceneClock`/`ClockFrame`, frame signals and intervals, bar:beat readout, tap/nudge/downbeat tools, plate chrome fix. Required before HUD counters.
4. **P3** End anchor with live lead, quantized manual queue, cue sheet, script cues, named intervals.
5. **P4** Deferred items in section 5.1.

Each phase ships behind unchanged defaults. Mirror preview/check to stock AAAVS and both builds run before any "available in both apps" statement; live acceptance stays separate.

## 8. CPU test plan

All are `visualizer/tools/check-*.mjs`, esbuild-bundled like the existing checks, no GPU, no server, no audio. Existing checks stay unmodified and must keep passing as the back-compat gate.

| File | Cases |
| --- | --- |
| `check-fps-meter.mjs` | Steady 24/30/60/120/144/240 Hz within 1 percent; jittered arrival; burst then idle; gap over 500 ms resets and returns null until three samples; stale after 750 ms; time going backwards resets; non-finite input ignored; ring wrap keeps the correct span; formatting (integer, one decimal below 10, `999+`); refresh limiter and hysteresis; channels independent |
| `check-timing-label.mjs` | Verbatim oracle of today's ternary over every state, byte-identical with fps off/absent; fps segment position after the BPM token in every state; omitted when paused/no eligible; detail mode text; existing substrings (`no eligible`, `queued NERV berserk`) preserved |
| `check-transition-timing.mjs` | Every mode at 20/60/120/133.33/400 BPM and beatsPerBar 3/4/7 gives the exact duration; caps by incoming scene, outgoing scene and 16 s; unknown tempo resolves to `fixedMs` and Instant to 0; legacy `beats` 0/1/2/4 mapping both ways and invalid values; Random over all 31 masks x several seeds: each cycle is a permutation of the set, no seam repeat for k>=3, order-independent replay over 10,000 shuffled ordinals, set membership always respected, mask 0/32/non-integer rejected; live counter stream stable for a seed; end-anchor windows never overlap for random pattern lengths; scene 0 has no fade; no `Math.random`/`Date.now`/`performance.now` in the module source |
| `check-mpc-beat-grid.mjs` | Round trip `beatAt(timeAt(b))` over 1e5 beats, with negative offsets and 256 changes; every integer beat recovered to 2e5 beats and never rounding up 10 µs early; strict monotonicity at segment joins; pattern lookup equals brute force for cyclic/hold/degenerate patterns; bounded search steps (probe counter) |
| `check-mpc-scene-clock-v2.mjs` | v1 parity: fast path equals a verbatim copy of the v1 formulas over 1e5 random `(bpm,bars,offset,position)`; general path agrees with it to 1e-9 on constant inputs; `[4,4,8,16]` boundaries, hold-last, cycling; beatsPerBar 3/5/7 durations; tempo change mid-scene keeps scene boundaries on beats and `end_n == start_{n+1}` bitwise; `remaining` is exactly 0 and `progress` 1 at `end`; `barsRemaining`, `bar`, `beatInBar`, `beatPhase` at boundaries and just before; `countIn`; seek/replay/pause determinism (random evaluation order equals sequential); shuffle and cues by ordinal with patterns; fade windows for both anchors incl. inside-window seeks; parse strictness for every new field (empty/oversize/duplicate/unsorted/out-of-range/non-integer/NaN); unknown keys dropped; `version` 3 tolerated; v1 JSON fixtures parse to exactly five keys and re-serialize unchanged |
| `check-mpc-timing-tools.mjs` | Tap tempo at 60/92/128/174 BPM with ±20 ms jitter within 1 percent; outlier tap rejected; gap reset; under four taps null; out-of-range null. Nudge exactness and clamping. Downbeat-here idempotence and bar-grid alignment. Restart-here |
| `check-mpc-cue-sheet.mjs` | Export/import round trip; sha256/index mapping and drop counts; size and count limits; prototype-pollution keys; non-finite numbers; version gate; no path/title fields; script cues merged with `scheduleSceneCue` under the shared 1024 budget |
| `check-mpc-auto.mjs` (extend) | `beatsPerBar` 3/4/5 phrase boundaries; `leadBars` switch and prepare positions; `rearm(origin)` keeps 100 consecutive phrases on exact multiples (no drift); default arguments reproduce every existing assertion |
| `check-nerv-host.mjs` (extend) | `fadeTiming` modes reach the worker as `blend`/`fadeSeconds`; Instant retains no outgoing worker; Random replays: same `nerv` frame after seeking away and back; end anchor: at `B-d/2` the active plate is scene n with blend 0.5 and local time 0 while the outgoing plate keeps running; legacy `{beats:2}` message identical to today; `#timing` contains `fps` after mocked rAF ticks (16.67 ms spacing reads 60), disappears when hidden or `showFps:0` |
| `check-mpc-management.mjs`, `check-mpc-scene-clock.mjs` (extend) | New controls write only non-default fields; builder saves exactly five timing keys for a v1 edit; pattern/tempo-change parsing errors shown; tools update the draft |
| `check-standalone-library.mjs` (extend) | Optional new settings keys accepted, preserved and rejected out of range; `defaults` and old `settings.json` unchanged; v2 timing and fade fields in the existing shared-`parseSetups` parity matrix (each new field x boundary values) |
| `check-aaavs-settings-contract.mjs` (new) | Static: regex-extract the JSON keys emitted by `AAAVSView.cpp` `Settings()` and the registry key names, compare against the host's accepted keys and the Player's `settingsFields`, so the C++ and page vocabularies cannot drift; assert the projection tables match |

Native code has no CPU harness here: it is covered by the static contract check, review, and the Release build. Runtime acceptance (menu behavior, registry migration on a machine with old values, WebView rAF rate, audible beat alignment, end-anchor feel) is separate and deliberately deferred while the GPU is reserved.

## 9. Risks and open questions

Risks:

- **Two vocabularies (`beats` vs `fadeTiming`) coexist.** Mitigation: one mapping module, `beats` written only as a projection, contract test.
- **Native `configure` resets absent keys today.** New fields must use current-member fallbacks or a setup activation would silently reset display prefs.
- **End anchor without the director fix drifts** every phrase by the fade length (`rearm(origin)` is mandatory).
- **Preload lookahead** must grow with the fade length and load time; a late slot enters at absolute progress, never restarts.
- **AVS presets under the clock still hard-cut.** The plan resolves but has no visible effect until the transition stream supplies a compositor path.
- **Frame size** with a large tempo map in every render message; measure, cache by revision if needed.
- **Downgrade** strips v2 fields when an old build re-saves.
- **Live tempo half/double misreads** change what "1 beat" means on the live path. Inherent to using the detector; the clock path avoids it.
- **Player server duplicates validation**; parity tests must cover every new field.
- **Clock interpolation** (section 3.6) trades exact boundary alignment for smoothness by up to 66 ms.
- FPS accuracy in the native WebView (rAF throttling when occluded) and whether `body:hover` visibility is reliable inside MPC-HC are unverified.

Open questions (defaults chosen if unanswered):

1. Should the timing overlay be always visible by default? Default: no, keep hover/announce, add the option.
2. Should the 4-beat legacy value be relabeled "1 bar"? Default: yes.
3. Should Random include Instant by default? Default: yes (all five).
4. Default anchor. Default: start.
5. Is clipboard text acceptable for cue sheets instead of a native file dialog? Default: yes.
6. Ship clock interpolation with P0? Default: no; add the `clock` rate to detail mode first.

## 10. Evidence

A scratch CPU prototype of the core algorithms was run under Node (no GPU, no app): beat grid with 3 tempo changes and negative/zero/positive offsets (round trip within 1e-9 over 1e5 beats, strictly increasing), integer-beat boundary recovery over 2e5 beats at 20/92/133.33/400 BPM and with tempo changes (zero errors with the 1e-9-beat tolerance; never rounding up 10 µs early), pattern lookup versus brute force for cyclic and hold patterns including 128-bar and 7-beat cases, the Random bag over all 31 masks and four seeds (permutation per cycle, no seam repeat for k>=3, order-independent), tap tempo at four tempi with jitter and gap reset, and the FPS meter at six rates plus stall/backwards-time handling. This validates the arithmetic in the design only. It is not the implementation and says nothing about host integration, native behavior or visuals.
