# Transitions V2: beat-aware, NERV/HUD-flavoured scene transitions

Status: design proposal. Nothing in this document is implemented. Every statement marked **EXISTS** was
verified against the source at the time of writing; everything marked **PROPOSED** is new design. No GPU,
browser, player or renderer was run to produce it. All acceptance below is CPU/source level; pixel, visual
and live-GPU acceptance is explicitly deferred (see section 9.4).

Scope: shared source in `visualizer/src/` (identical for the MPC-HC host and the stock AAAVS Player). Paths in
this document are repository-relative.

Related documents: `docs/AVS-TRANSITIONS.md` (classic modes), `docs/NERV-SCENES.md` (clocked NERV changes),
`docs/HUD-ANIMATION-BEDS.md` (transition start/peak/end anchors), `docs/SONG-ANALYSIS-AND-HUD-DRIVERS.md`.
A companion design covers transition timing modes (Instant / 1 beat / 2 beats / 1 bar / 2 bars / Random
duration) and the repeatable scene clock; section 5 states the exact contract this design needs from it.

---

## 1. What exists today (verified)

| Fact | Where |
| --- | --- |
| 16 modes, index = stored value: `0 Random, 1 Cross dissolve, 2 L/R Push, 3 R/L Push, 4 T/B Push, 5 B/T Push, 6 9 Random Blocks, 7 Split L/R Push, 8 L/R to Center Push, 9 L/R to Center Squeeze, 10-13 directional wipes, 14 Dot Dissolve, 15 Cut` | `visualizer/src/mpc-transition.ts:4` |
| `draw(ctx, old, next, progress, w, h)` has no tempo, seed, audio or env input. Sine ease `s = (1-cos(pi t))/2` for spatial modes, linear `t` for dissolve. `t >= 1` or mode 15 draws `next` only. Each call starts by drawing `old` full-frame, then layers rect clips. | `mpc-transition.ts:45-95` |
| Constructor `seed` drives block order (8 PRNG draws) and then Random: `1 + floor(random()*14)`. Without a seed it uses `Math.random`. Random therefore never yields Cut (15) and the stream order is an implicit contract. | `mpc-transition.ts:38-44` |
| Scratch surfaces `mask`/`tile` are created in the constructor through `createCanvas` (HTML canvas on the main thread, `OffscreenCanvas` in the worker). | `mpc-transition.ts:39-40` |
| Main-thread compositor (AVS to AVS): `commit()` builds `new AvsTransition(transitionMode)` with no seed, `transitionStart = position`, duration = beats at the trusted tempo or `durationMs`. `frame()` computes `t = (position - transitionStart)/transitionDuration` and calls `transition.draw(cc, outgoing.bitmap, active.bitmap, t, w, h)` on the 640-wide composite, then presents through `FlashGate`. Seek discards the transition. | `mpc-host.ts:214-217`, `:279`, `:355-366` |
| NERV clocked changes: the worker of the *incoming* scene renders both plates (`renderNervScene` twice), then `transition.draw(ctx, oldCanvas, nextCanvas, clock.blend, ...)`. `blend = min(1, localTime/fadeSeconds)` is computed in `render()` from the scene clock, so it starts at the boundary (anchor = START). `transitionSeed` mixes `sceneTiming.seed`, ordinal and both preset hashes, so Random and block order replay after a seek. The worker caches the `AvsTransition` by key `${mode}:${seed}`. | `mpc-host.ts:178-188`, `nerv-render.worker.ts:42-55` |
| Worker validates `transitionMode` as integer `0..15`, all clock numbers finite. `blend <= 0` draws old only unless mode 15. | `nerv-render.worker.ts:35-38`, `:53` |
| Protocol carries only `previousScene, previousLocalTime, previousTime, blend, transitionMode, transitionSeed`. | `avs-worker-protocol.ts:8-15` |
| The tempo object exposes `locked`, `bpm`, `beatIndex`, `phase` (used as `(beatIndex+phase)/4` for the bar grid). | `mpc-auto-director.ts:11`, `:41` |
| Scene clock: boundary ordinals from `240*barsPerScene/bpm`; `ScenePhase` has `index, previousIndex, ordinal, start, localTime, progress, duration`. No notion of beat phase, bar number or boundary strength. | `mpc-scene-clock.ts:9-17`, `:123-141` |
| Presentation flash gate: every frame the compositor produces is downsampled to a 256x144 probe (64x36 cells) and drawn with `globalAlpha = blend`. It is the last line of defence for any transition. Modes must still be safe by construction. | `flash-gate.ts`, `flash-limiter.ts` |
| NERV vocabulary reusable by transitions: hazard strip (40 unit period, 18 unit stroke, 45 degree), hex field (radius 24, pointy, 48x42 pitch), octagon-capable `polygon()`, radar arm with `fract(beats/4)` revolution, ink `#050605`, orange `#ff8526`, amber `#ffc15a`, cyan `#58d6ef`, Consolas/monospace 600 weight labels. The scene plate is a 960x540 design space letterboxed into the frame. | `nerv-scenes.ts:23-25`, `:72-79`, `:127-138`, `:198`, `:376-392` |
| The Studio has its own, unrelated GPU transition system (`TransitionKind`, `packTransition` in `director.ts`). Nothing here changes it. | `director.ts:360-560` |
| There is no reduced-motion input anywhere in the visualizer today. | search for `reducedMotion`/`prefers-reduced-motion`: no matches |
| CPU verification of modes 1-13 is a scalar `Raster` double with rect clips only; modes 14/15 and Random get draw-call/endpoint smoke and a fake-context replay in the worker test. | `tools/mpc-transition-raster-check.mjs`, `tools/check-mpc-auto.mjs:45-59`, `tools/check-nerv-worker.mjs:10-94` |

Two latent quirks worth fixing while touching this code (PROPOSED, low risk): `commit()` constructs the transition without a seed,
so an AVS-to-AVS Random choice is not reproducible in tests; and `blend = min(1, localTime/fadeSeconds)` would divide by zero if a
future "Instant" duration reached it (Instant must be treated as Cut, section 5.4).

---

## 2. Goals and safety rules

Goals: 15 visually striking modes that read as NERV/HUD instruments (hazard tape, MAGI hex cells, AT-field octagon, radar,
CRT, countdown) plus tempo-locked and glitch styles; each costs a handful of Canvas2D calls per frame; each is a pure function of
`(t, env, constructor seed, w, h)` so a seek replays it exactly; the classic 16 indices and their output stay untouched.

### 2.1 Photosensitive-safety rules (binding for every new mode)

The presentation limiter stays the backstop (it models per-cell luminance at 10x10 px probe cells), but the modes must not lean on it.

- **S1 Monotone reveal.** Every reveal-family mode switches each pixel from old to new at most once and never back. (The
  limiter's flash count needs a *pair* of opposing changes; a single step is a cut, which the app already offers as mode 15.)
- **S2 Direction-parallel patterns.** Any high-contrast pattern that moves with an edge (hazard stripes, EQ caps) must be constant along the
  direction of motion, so a fixed pixel sees one stripe colour while the band passes. A stripe pattern perpendicular to the motion would
  strobe at `speed/period` (about 18 Hz for a 1 s wipe with 38 px stripes) and is forbidden.
- **S3 Change-rate caps.** Anything that steps rather than glides is quantised to at most 8 Hz (monotone reveal steps) or 4 Hz
  (non-monotone jitter: glitch offsets, smear vectors, numerals). The cap is computed from `beatsTotal` and `bpm`.
- **S4 Decoration area.** Accent lines, rings, caps and bars together cover at most 15% of the frame and are never full-frame. No `lighter`
  composite, no full-frame white/black pulse. Bright (white-ish) decoration covers at most 1% of the frame (CRT line only).
- **S5 One excursion.** At most one dark dip per pixel per transition (Tile Flip backplate). Hosts never overlap two transitions.
- **S6 Motion budget.** Scale/parallax modes (Kick-Punch Zoom, Mosaic Drop, Tile Flip, Glitch, Datamosh) are `calm:false`; with
  `reducedMotion` they map to Cross dissolve (mode 1) or are excluded from random pools (section 3.4).
- **S7 Limiter-clean by construction.** A CPU sweep (section 9.2, item 7) runs worst-case contrast frames (black to white, black to saturated red)
  through the real `FlashLimiter` and requires `limited === false` for every new mode.

Endpoint contract (all modes): `t <= 0` produces exactly `old`; `t >= 1` produces exactly `next` (existing early return, keep it as the first
statement after `draw(old)`); and by construction the effect is visually complete before `t = 1`
(the last quantised step maps to full reveal, section 3.3) so no mode depends on the final frame to be right.

---

## 3. API

### 3.1 Env object

**PROPOSED** in `visualizer/src/mpc-transition.ts` (types and meta) and `visualizer/src/mpc-transition-fx.ts` (new file, geometry):

```ts
export interface TransitionEnv {
  readonly bpm: number;          // 20..400. Scene-clock BPM, else the locked tempo, else 120.
  readonly beatPhase: number;    // 0..1, fract of the musical beat at this frame (pure function of media time)
  readonly barPhase: number;     // 0..1, fract of the 4-beat bar
  readonly beatsTotal: number;   // transition length in beats = fadeSeconds*bpm/60, clamped 0.25..64
  readonly level: number;        // 0..1 audio energy, quantised to quarters. Decoration only, never reveal geometry.
  readonly bands?: readonly number[]; // optional 16 values 0..1, frozen when the transition starts (AVS path only)
  readonly accent: 0 | 1;        // 0 neutral cool-grey accent, 1 NERV orange/amber (both scenes are NERV/HUD plates)
  readonly reducedMotion: boolean;
}
export const defaultTransitionEnv: TransitionEnv = { bpm: 120, beatPhase: 0, barPhase: 0, beatsTotal: 4, level: 0, accent: 0, reducedMotion: false };
draw(ctx, old, next, progress, w, h, env?: Partial<TransitionEnv>)   // 7th arg optional; six-argument callers keep working
```

Decisions:

- The requested `seed` is **not** duplicated in env. The seed is constructor-owned: it fixes Random resolution, block order and every
  per-mode parameter table, and it is what the worker's cache key covers. A second seed in env could desynchronise them.
- Classic modes 0-15 never read env (pinned by a test, section 9.2), so their output and the frozen expectations do not move.
- `level` and `bands` only scale decoration (ring width, cap height, glow alpha) or the *shape* of a bounded envelope. `level` never moves
  a reveal edge, so the pixel that is old or new at time `t` is a function of `(t, seed, beatsTotal)` alone and a seek replays it exactly.
- `beatPhase`/`barPhase` are used only for decoration or bounded pulses (stripe march, 3% zoom punch). Reveal position uses quantised `t`
  (3.3), which aligns to the beat grid whenever the transition starts on a beat and its length is a whole number of beats.
  Anchoring (section 5) is what makes those two conditions true.

### 3.2 Meta table (single source of truth for names, tags and ranges)

```ts
export interface TransitionMeta {
  readonly name: string;
  readonly kind: 'classic' | 'fx' | 'selector';
  readonly family: 'dissolve' | 'push' | 'wipe' | 'reveal' | 'tick' | 'glitch' | 'build';
  readonly minBeats: number; readonly maxBeats: number;   // modes that cannot work outside this length are not offered by pools
  readonly hit: ((beats: number) => number) | null;        // peak/"drop" anchor as a fraction of the transition, or null
  readonly calm: boolean;                                  // allowed under reducedMotion
  readonly nerv: boolean;                                  // NERV/HUD-flavoured (Smart random boosts these on NERV/HUD pairs)
  readonly dramatic: boolean;                              // preferred on section boundaries
  readonly cost: { draw: number; clip: number; fill: number; text: number };  // hard caps asserted by the tests
}
export const TRANSITION_META: readonly TransitionMeta[] = [ /* 33 entries, indices below */ ];
export const TRANSITIONS: readonly string[] = TRANSITION_META.map(m => m.name);   // same export name and type as today
export const TRANSITION_COUNT = TRANSITIONS.length;                              // 33; replaces every literal 16 / 15+1
export const TRANSITION_CUT = 15;
```

`TRANSITIONS` keeps its name, so `mpc-management.ts:79` and `standalone-player.ts:186` (both build a `<select>` from it) pick up the new
entries with no change.

### 3.3 Quantised progress helpers

```ts
export const stepQ = (t: number, n: number) => t <= 0 ? 0 : Math.min(1, Math.floor(Math.min(t, 1 - 1e-9) * n) / (n - 1)); // n >= 2
export function ticks(env: TransitionEnv, perBeat: number, hz: number, lo = 2, hi = 32) {
  const secs = env.beatsTotal * 60 / env.bpm;
  return Math.max(lo, Math.min(hi, Math.round(env.beatsTotal * perBeat), Math.floor(hz * secs)));   // rate cap (S3)
}
```

`stepQ` is 0 at `t = 0`, non-decreasing, and equals exactly 1 for the last `1/n` of the transition, so the quantised effect is complete before
`t = 1`. With the transition starting on a beat and a length of whole beats, tick edges fall exactly on `1/perBeat` beat subdivisions.

### 3.4 Style selection: Random, all styles, Smart random

New indices 31 and 32 (section 4.1). Resolution stays inside the `AvsTransition` constructor so a worker and the main thread resolve identically.

```ts
export interface TransitionContext {
  readonly beatsTotal: number;      // after the timing design has resolved its own seeded duration
  readonly boundary: 0 | 1 | 2 | 3; // 0 free/manual/adaptive, 1 bar, 2 phrase (absBar % 4 == 0), 3 section (absBar % 16 == 0)
  readonly nervPair: boolean;       // both plates are NERV/HUD scene presets
  readonly reducedMotion: boolean;
  readonly energy?: 0 | 1 | 2 | 3;  // AVS path only (live level bucket at commit); the clocked path leaves it undefined
}
new AvsTransition(mode, { seed, createCanvas, context? })
```

Resolution rules (all PRNG-driven from `subSeed`, never `Math.random` when a seed exists):

- **0 Random (classic, unchanged).** `random = seededRandom(seed)`; `blockOrder(random)` consumes 8 draws; then `1 + floor(random()*14)`.
  Keep the order exactly, or every stored boundary changes style. Test pins 256 seeds (9.2).
- **31 Random, all styles.** Uniform over `[1..14] + [16..30]` filtered by `fits(meta, beatsTotal)` and, under `reducedMotion`, by `calm`.
  Uses `seededRandom(subSeed(seed, SALT.STYLE))`. Never returns 0, 15, 31 or 32.
- **32 Smart random.** Weighted pick from the same candidate set, `seededRandom(subSeed(seed, SALT.SMART))`:

| Factor | Rule |
| --- | --- |
| Fit | weight 0 if `beatsTotal < minBeats` or `> maxBeats`; 0 if `reducedMotion && !calm` |
| Length | `beatsTotal <= 1.5`: x3 `tick`,`glitch`; x0 `build`. `1.5 < b < 6`: x2 `reveal`. `b >= 6`: x3 `build`, x2 `reveal`, x0.3 `tick` |
| Boundary | 0: x0.5 `dramatic`, x0 any mode with `hit` (no musical downbeat to land on). 2: x2 `dramatic`. 3: x3 `dramatic` |
| Energy (AVS path only) | `>= 2`: x2 `glitch`,`tick`, Kick-Punch, Hazard. `<= 0`: x2 dissolve/Iris/Radar/Venetian/CRT On |
| Pair | `nervPair`: x2 `nerv`, x0.5 non-nerv. Non-NERV pair: x1 (classic modes stay available) |
| Classic | classic modes (1-14) base weight 0.5, Cross dissolve 1 |

  The clocked NERV path leaves `energy` undefined so the pick is a pure function of `(seed, beatsTotal, boundary, nervPair, reducedMotion)`.
  That is why a seek reproduces it. The live audio level is never allowed to influence which style is chosen on a path that must replay.

- **Seeds.** One boundary seed (the existing `transitionSeed`) fans out through `subSeed(seed, salt) = mix32(seed ^ imul(salt, 0x9e3779b1))`.
  Registry, exported from `mpc-transition.ts` so the timing design imports the same function:

| Salt | Consumer |
| --- | --- |
| `0` (raw seed) | classic Random and block order (unchanged legacy stream) |
| `1` STYLE | mode 31 pick |
| `2` SMART | mode 32 pick |
| `0x100 + mode` | per-mode parameter table (slats, cells, thresholds, direction) |
| `0x44` DURATION | reserved for the timing design's seeded "Random duration" pick |

  Order of resolution at a boundary is fixed: duration pick (timing design) first, then style pick (needs `beatsTotal`), then parameter table.
  The three streams are independent, so changing the duration set cannot reshuffle styles, and vice versa.

- **AVS-to-AVS seed (PROPOSED fix).** `commit()` should pass `seed = hash32(sceneTiming.seed, sha8(prev), sha8(next), round(position*1000))`.
  It is stable within the transition (the object is created once) and makes host tests deterministic. A seek still discards the transition.

- **`AvsTransition.mode`** remains the resolved concrete mode (tests read it); add `readonly requested`.

---

## 4. The new modes

### 4.1 Indices (append only; 0-15 keep their meaning and stored values)

| Index | Name | Family | minBeats | calm | nerv | hit |
| --- | --- | --- | --- | --- | --- | --- |
| 16 | Beat Step Wipe | tick | 0.5 | yes | no | - |
| 17 | Hazard Stripe Wipe | wipe | 0.5 | yes | yes | - |
| 18 | MAGI Hex Reveal | reveal | 1 | yes | yes | - |
| 19 | AT Field Iris | reveal | 0.5 | yes | yes | - |
| 20 | Radar Sweep | reveal | 1 | yes | yes | - |
| 21 | Venetian Blinds | reveal | 0.5 | yes | no | - |
| 22 | CRT Off | reveal | 0.5 | yes | yes | - |
| 23 | CRT On | reveal | 0.5 | yes | yes | - |
| 24 | Glitch Stutter | glitch | 1 | no | no | - |
| 25 | Datamosh Smear | glitch | 1 | no | no | - |
| 26 | Tile Flip | tick | 1 | no | no | - |
| 27 | Countdown Iris | build | 2 (max 9) | no | yes | 1.0 (arrival) |
| 28 | Kick-Punch Zoom | tick | 0.5 | no | no | 0.5 |
| 29 | Mosaic Drop | build | 4 | no | no | `1 - 1/beats` |
| 30 | Spectrum Bars Wipe | reveal | 0.5 | yes | no | - |
| 31 | Random, all styles | selector | - | - | - | - |
| 32 | Smart random | selector | - | - | - | - |

`TRANSITIONS.length` becomes 33. The classic label at 0 is renamed `Random · classic` (index and behaviour unchanged) to avoid two
ambiguous "Random" entries. `dramatic`: 18, 19, 20, 27, 29.

New geometry lives in `visualizer/src/mpc-transition-fx.ts` (`drawFx(state, ctx, old, next, t, w, h, env)`), called from a `default:` arm of the
existing switch (`mode >= 16`). The classic switch stays byte-for-byte as it is.

### 4.2 Common conventions

- All lengths are fractions of `w`/`h`; hairlines use `u = Math.max(1, Math.round(h/360))` so a resolution increase (composite is 640 wide
  today; the NERV worker clamps at 1280x720) changes crispness, not layout, and never the number of draw calls.
- Reveal is expressed as **one compound path -> one `clip()` -> one `drawImage(next)`**. Cell/slat/hex sets are accumulated into a single
  path (nonzero winding, polygons inflated by 2% to avoid seams) instead of one clip per cell. Frontier/partial elements are the only
  per-element draws and are capped (`cost` column below).
- Parameter tables (`tau[]`, directions, slat counts) are built lazily on first draw from `seededRandom(subSeed(seed, 0x100 + mode))`.
  `draw` itself is stateless apart from scratch canvases, so frames may be evaluated in any order.
- Every count is `Math.max(1, Math.min(desired, extent))` so 12x8 and 13x9 test surfaces work.
- Accent colour: `env.accent === 1` -> `#ff8526` lines with `#ffc15a` highlights and `#050605` ink; `0` -> `#9fc4dc` lines on `#0b0d10` ink.
- `imageSmoothingEnabled = false` is already set at the top of `draw`; zoom/scale modes (22, 23, 28) set it `true` inside `save()/restore()`.
- Cost is quoted as `D` drawImage, `C` clip, `F` fill/stroke/fillRect, `T` text ops, independent of resolution.

### 4.3 Mode specifications

**16 Beat Step Wipe** (tick). A straight wipe whose front advances in beat-subdivision steps.
Direction from seed (L to R, R to L, T to B, B to T). `n = ticks(env, 4, 8)` (sixteenth notes, at most 8 steps per second),
`q = stepQ(t, n)`, `front = round(q*extent)`; `clip rect(0..front)` -> `draw(next)`; a 2u accent bar sits on the edge for `0 < q < 1`.
Beat use: with a beat-aligned start and beat-multiple length, each tick lands on a sixteenth note. Cost D1 C1 F1.
Endpoints: `q(0) = 0` (skip everything); last tick `q = 1` before `t = 1`. Safety: monotone, S1/S3.

**17 Hazard Stripe Wipe** (wipe). 45 degree band of hazard tape sweeps across, new behind it, old ahead.
Coordinate `u = x + k*y` (k = +/-1 and mirror from seed). Band width `B = 0.14*w`; front `c = lerp(uMin - B, uMax + B, s)`.
Revealed: `u <= c - B` (quad polygon through the frame, clip, `draw(next)`). Band `c - B <= u <= c`: ink fill at 0.9 alpha, then stripes.
**S2:** stripes run *along the sweep direction* (constant `v = x - k*y`), period `40/960 * w` (the `nerv-scenes.ts` hazard pitch),
half duty, phase advanced by `beats*period` so tape marches once per beat (decoration, not reveal). At most about 30 rects in one path.
`s = transitionProgress(t)`. Endpoints: at `s = 0` the whole band is outside the frame, at `s = 1` it has fully left. Cost D1 C2 F2.
Safety: the band covers about 14% (S4) and each pixel meets one stripe colour (S2).

**18 MAGI Hex Reveal** (reveal). Pointy hex grid, circumradius `R = w/14` (about 63 cells, cap 128, scales with `w`, not with resolution).
Per-cell threshold `tau_i = 0.7*d_i/dMax + 0.3*rnd_i` where `d_i` is distance from a seeded epicentre cell, so the reveal spreads outward with noise.
`q = stepQ(t, ticks(env, 2, 4))`; cell revealed iff `tau_i < q`. One compound path of revealed hexes -> `clip` -> `draw(next)`;
cells with `q - 0.12 <= tau_i < q` get a 1.5u accent outline (one stroke), cells in `[q, q + 0.06)` get a faint 0.35 alpha outline (one stroke).
Endpoints: `tau in [0,1)` so `q = 0` reveals none and `q = 1` reveals all. Cost D1 C1 F2 (path of at most 128x6 vertices).
Safety: a hex is 50 px, five probe cells; each flips once; 4 Hz cap. Sketch in Appendix A.

**19 AT Field Iris** (reveal). Octagon (8-gon, flat top: rotate `pi/8`) opening from frame centre (or a seeded +/-15% target point).
Seed picks *open* (new inside the growing octagon) or *close* (new outside, old shrinking inside; draw `next`, then clip the octagon and draw `old`).
`R = s*Rmax`, `Rmax = farthestCornerDistance / cos(pi/8) + 2` so the octagon at `s = 1` contains every corner.
Two trailing outlines at `0.9R` and `0.8R` (alpha 0.5, 0.25, 2u): the AT-field ripple. Line width gains `level*u` and `(1-beatPhase)*u` (decoration).
Cost D1-2 C1 F3. Endpoints: `R(0) = 0` (open) / `Rmax` (close) so old is exact at `t = 0`.

**20 Radar Sweep** (reveal). A radar arm turns once around the centre; the swept wedge shows new.
Start angle a multiple of `pi/4` and direction (cw/ccw) from seed. `theta = 2*pi*t` (linear, radar-like). Path: `moveTo(c)`, `arc(c, Rr, a0, a0 +/- theta)`, `closePath`,
`clip`, `draw(next)`, with `Rr` = farthest corner distance + 2. Behind the arm: three stacked accent wedges of widths 0.10, 0.20, 0.30 rad at alpha 0.10 each (phosphor trail),
the arm itself a 2u line, and two static range rings at alpha 0.2. Cost D1 C1 F5. Endpoints: wedge empty at 0, whole disc reaches all corners as `theta -> 2*pi`.
Bar-length transitions turn about one revolution per transition (HUD "radar revolution spans four beats"). Safety: monotone; arm is a thin line crossing each pixel once.

**21 Venetian Blinds** (reveal). `N in {8,10,12,16}` slats (seed), horizontal or vertical (seed); slat `i` has delay `d_i = 0.5*(0.7*i/(N-1) + 0.3*rnd_i)`
and fill `f_i = clamp((s - d_i)/0.5)`, growing from its leading edge (or from its centre for "turning" blinds, seed). All slat rects in one path -> `clip` -> `draw(next)`.
`f_i = 0` at `s = 0`; `f_i >= 1` for all slats as `s -> 1`. Cost D1 C1. Safety: monotone; slats are at least 22 px.

**22 CRT Off** (reveal, scale). New sits underneath; old collapses onto it, first to a line, then to a dot (no black dip, so S5 holds).
Phase 1 `t in [0, 0.55]`: old drawn into `(0, (h-hh)/2, w, hh)` with `hh = max(2u, h*(1 - p^3))`, `p = t/0.55` (accelerating).
Phase 2: the line's width `ww = w*(1 - p2^2)` (p2 over `[0.55, 1]`), height 2u, centred; a 2u `#dfeaf5` line at alpha 0.85 drawn only when `hh <= 6u`
(area at most 0.6%, the only bright decoration in the set). Cost D2 F1. Endpoints: at `t = 0` old is drawn at identity (skip `next`); at `t -> 1` the dot has zero width.
Safety: monotone per pixel; smoothing on for the squash.

**23 CRT On** (reveal, scale). Mirror of 22 over old: a line grows horizontally (`t in [0, 0.45]`, height 2u, `ww = w*p^2`), then the picture opens vertically
(`hh = 2u + (h - 2u)*smoothstep(p2)`), `next` drawn scaled into that rect. Same 0.6% bright line rule. Cost D2 F1.
Endpoints: nothing new at `t = 0`; `hh -> h`, `ww = w` as `t -> 1`.

**24 Glitch Stutter** (glitch). `H in 10..16` horizontal bands with seeded heights (weights `r^2`, summing to `h`) and thresholds `tau_i in [0.05, 0.80]`.
`q = t` (not stepped). Band state: `q < tau_i - g` old; `tau_i - g <= q < tau_i` old displaced; `q >= tau_i` new, displacement decaying `1 - (q - tau_i)/g` to 0, `g = 0.18`.
Displacement `dx_i = (noise(i, tick, seed) - 0.5)*2*A`, `A = 0.10*w*4q(1-q)` (zero at both ends, continuity), integer pixels, `tick = floor(t*ticks(env, 2, 4))`.
Under `reducedMotion` `A = 0`: the band reveal remains. Draw: `old` base, settled bands merged into one rect path -> `clip` -> `draw(next)`,
active bands drawn as 9-argument slices (`drawImage(src, 0, y, w, bh, dx, y, w, bh)`) plus a wrapped copy at `dx -/+ w` (each shifted slice at most 2 draws).
Cost D at most 2H+2 (34), C1. Safety: displacement of existing content only, at most 4 Hz, band swap once per band (S1/S3).

**25 Datamosh Smear** (glitch). Grid `12 x 7`, per-block `tau_i in [g, 0.96]`, `g = 0.22`, blending a seeded dominant direction with per-block +/-1 noise for the motion vector.
`q = stepQ(t, ticks(env, 2, 4, 4, 16))`. States: `q < tau - g` old; `[tau - g, tau)` old content *dragged*: `drawImage(old, sx - mvx*p*bw*2, sy - mvy*p*bh*2, bw, bh, x, y, bw, bh)` with the source
rect clamped inside the frame, `p = (q - (tau - g))/g`; `q >= tau` new (merged compound path). Cost D1 + about 40, C1.
Endpoints: all `tau - g >= 0` so `q = 0` leaves every block at `p = 0` (identity); `tau <= 0.96` means all new at the last step. Safety: same-frame displacement, 4 Hz cap.

**26 Tile Flip** (tick). `8 x 5` tiles; delay `d_i = (1 - f)*(0.8*wave_i + 0.2*rnd_i)` with flip window `f = 0.4` and `wave_i` a normalised diagonal/radial distance from a seeded corner/centre,
so `d_i + f <= 1`. Progress `p = clamp((q - d_i)/f)`, `q = t`. `p = 0`: old (base). `0 < p < 0.5`: ink backplate rect, old tile squeezed to width `tw*cos(pi p)` about its centre.
`0.5 <= p < 1`: ink backplate, new tile squeezed to width `tw*(-cos(pi p))`. `p >= 1`: merged into the revealed rect path. Cost D at most 1+tiles-in-flight (cap 41), C1, F at most 41.
Safety S5: one dark excursion per tile, lasting `f` of the transition (at least 0.2 s at any allowed length) so at most one flash per cell; area of simultaneously flipping tiles is bounded by the wave delay.

**27 Countdown Iris** (build). Circle iris opens from centre (`R = s*Rmax`, same `Rmax` as mode 19). `K = clamp(round(beatsTotal), 2, 9)`; numeral `d = K - floor(min(t,1-1e-9)*K)` counts `K..1` on the beats.
Numeral: monospace 600 weight, size `0.28*h`, fill `#eee4d1`, `strokeText` ink 3u outline for legibility over both frames; alpha `1` until `R < 0.6*Rmax` then fades to 0.
Ring 2u accent at `R` and a four-tick crosshair. With `beatsTotal < 2` no numerals (iris only). Cost D1 C1 F4 T2. Numerals change at beat rate (below 4 Hz for tempo up to 240 BPM; above that,
`hz` cap skips alternate digits), area under 3%. Arrival: `hit = 1`, so "1" lands at the boundary end. The numeral text is a function of `t` and `beatsTotal` only, so a seek replays it.

**28 Kick-Punch Zoom** (tick). Zoom-through: old scales `1 + 0.35*t^2.2` about the centre; new scales `1.18 - 0.18*(1-(1-t)^2)`; crossfade alpha `a = smoothstep(0.30, 0.70, t)` (monotone; new is opaque from `t = 0.7`,
and because its scale is above 1 it covers the frame). Beat "punch": both scales gain `0.03 * (1 - beatPhase)^3` (`0.03 * level` when `level > 0`, else a fixed 0.02): geometric only, at most 3%.
Draw: old scaled dest rect, then `globalAlpha = a` new scaled dest rect. Cost D2 (the second skipped while `a = 0`). Endpoints: identity old at `t = 0`; new at scale 1 as `t -> 1` (scale tends to 1 and `a = 1`).
`calm: false` (S6): with `reducedMotion` the mode is replaced by Cross dissolve.

**29 Mosaic Drop** (build). Bar-length "build then drop". Drop point `d = clamp(1 - 1/beatsTotal, 0.5, 0.9)` (the last beat). Build `t < d`: old pixelated, block size stepping per beat
`p_j = round(bmax*(j/m)^1.6)`, `bmax = w/16`, `m = ceil(beatsTotal) - 1` steps, first step `p = 1` (identity). At `t = d` a hard swap to `next` pixelated at `bmax`, then `[d, 1)` resolves in four steps
`bmax, bmax/2, bmax/4, 1` (the last quarter of the drop is fully sharp `next`, so the effect completes before `t = 1`). A thin accent ring expands from the centre during the resolve.
Pixelation: one lazily created scratch surface, `drawImage(src, 0, 0, ceil(w/p), ceil(h/p))` then upscale with smoothing off (point sampling is the intended mosaic look; no per-pixel JS loops). Scratch is resized only when `p` changes (at most 12 times per transition).
Cost D2 F1. Flash note: the hard swap is one step and mosaic averaging lowers contrast; in flash terms it equals the existing Cut (mode 15), which is already accepted. With `hit` anchoring (section 5) the swap lands exactly on the boundary downbeat.
`calm: false`.

**30 Spectrum Bars Wipe** (reveal). Sixteen contiguous vertical bars fill from the bottom like an EQ. Bar `i` height fraction `f_i = clamp(q + 0.35*(b_i - 0.5)*4*q*(1-q))`, `q = s`.
`b_i` = `env.bands[i]` (frozen at transition start on the AVS path) or, when absent (clocked NERV path, or any replayed transition), `b_i = clamp(noise(i, seed)*(1.15 - 0.6*i/15))` (a seeded, tilted pseudo-spectrum).
The envelope `4q(1-q)` is 0 at both ends and `f_i' >= 0.3 > 0`, so each bar is monotone and the endpoints are exact. Compound rect path -> `clip` -> `draw(next)`; 2u accent peak caps on top of each bar (one path). Cost D1 C1 F1.

### 4.4 Cost summary

| Mode | D | C | F | T | Notes |
| --- | --- | --- | --- | --- | --- |
| 16 | 1 | 1 | 1 | 0 | |
| 17 | 1 | 2 | 2 | 0 | at most about 30 rects |
| 18 | 1 | 1 | 2 | 0 | at most 128 hexes |
| 19 | 2 | 1 | 3 | 0 | |
| 20 | 1 | 1 | 5 | 0 | |
| 21 | 1 | 1 | 0 | 0 | |
| 22 / 23 | 2 | 0 | 1 | 0 | |
| 24 | 34 | 1 | 0 | 0 | 9-argument slices |
| 25 | 41 | 1 | 0 | 0 | |
| 26 | 42 | 1 | 41 | 0 | only tiles in flight |
| 27 | 1 | 1 | 4 | 2 | |
| 28 | 2 | 0 | 0 | 0 | |
| 29 | 2 | 0 | 1 | 0 | plus at most 12 scratch resizes |
| 30 | 1 | 1 | 1 | 0 | |

Hard caps asserted by tests: `D <= 48`, `C <= 3`, `F <= 48`, `T <= 2`; totals independent of resolution. Compare classic 14 (Dot Dissolve): D1 plus a 1-pixel pattern fill. In the NERV worker a transition frame already costs
two full `renderNervScene` passes; the fx layer adds at most a few percent to that (estimate; not measured, no GPU/browser was run).

---

## 5. Aligning transitions with the scene clock

### 5.1 Definitions

Let `B` be the boundary (scene `start`), `F` the fade seconds, `beatsTotal = F*bpm/60`, and `pivot in [0,1]` the fraction of the transition that lies *before* `B`.
The transition window is `[B - pivot*F, B + (1 - pivot)*F]`, and progress is `t = clamp((position - B + pivot*F)/F)`.

| Anchor | pivot | Meaning |
| --- | --- | --- |
| `start` | 0 | **EXISTS.** Effect begins on the boundary downbeat (`blend = localTime/F`). Default and the only behaviour today. |
| `end` | 1 | PROPOSED. The new scene is fully visible exactly on the boundary; the build happens in the last `F` before it. |
| `hit` | `meta.hit(beatsTotal)` | PROPOSED. The mode's peak/drop coincides with the boundary (Mosaic Drop swap, Countdown arrival, Kick-Punch midpoint). Falls back to 0 when the mode has no `hit`. |

This maps onto the "start, peak and end anchors" in `docs/HUD-ANIMATION-BEDS.md`: `pivot` is the peak anchor's position.

### 5.2 How the host implements it with almost no change

Evaluate the scene clock `lead = pivot*F` seconds early: `phase = sceneAt(position + lead, ...)`. Then `phase.localTime = position + lead - B` and
`blend = phase.localTime/F` is *exactly* today's formula, but transitions now begin `lead` before the boundary. The new scene's own animation clock
stays true to media time: `nerv.localTime = max(0, phase.localTime - lead)` (renderNervScene already clamps negatives to 0, so the incoming scene is frozen at its first frame
during the pre-roll, the same behaviour a prepared future frame has today, then starts moving on the downbeat). The outgoing scene keeps `previousTime = position`.
Consequences to handle in `mpc-host.ts` (Phase 2, section 10):

- `clockPhase()` gains `lead` for the boundary being approached. `lead` depends on that boundary's own plan (mode, duration), which is a pure function of its ordinal and seed, so
  `phaseFor(position)`: evaluate `a = sceneAt(position)`, compute `plan(a.ordinal + 1)`, and if `position + plan.lead >= nextStart` use `sceneAt(nextStart)` as the current phase. O(1).
- Lookahead for preloading (`mpc-host.ts:105`, `min(2, 240/bpm, duration/4)`) must grow to `max(current, lead + 1)`.
- Non-overlap constraint (S5): `(1 - pivot_prev)*F_prev + pivot_next*F_next <= sceneDuration`; the plan clamps `F_next` accordingly (pure, uses the previous ordinal's recomputed plan).
- Worker protocol is unchanged for anchoring: `blend` is already the single progress scalar the host computes. Only host timing moves.

### 5.3 What this design needs from the timing design (contract)

1. Resolved transition length in beats per boundary, `beatsTotal = F*bpm/60`, computed *after* its seeded Random duration pick, with that pick taken from `subSeed(seed, SALT.DURATION = 0x44)`.
2. A per-setup anchor setting with values `start` (default; back-compatible), `hit`, `end`, persisted like other setup settings (default `start` when absent).
3. `boundary` level per boundary: `absBar = ordinal*barsPerScene` (offset-relative); `0` free/manual/adaptive, `1` bar, `2` if `absBar % 4 == 0`, `3` if `absBar % 16 == 0`.
4. A pure `plan(ordinal) -> { F, beatsTotal, pivot, mode, seed }` so replay and the non-overlap clamp work after a seek.
5. **Instant is Cut.** `F = 0` (or `beatsTotal == 0`) must bypass the compositor exactly like mode 15 (`mpc-host.ts:188`, `:217`), never divide by `F`.

### 5.4 Determinism after seeks

- Style: `transitionSeed` already mixes `sceneTiming.seed`, ordinal and both preset hashes (`mpc-host.ts:184`). Modes 0, 31, 32 resolve from it with pure functions (3.4).
- Duration: from the same seed via its own salt (5.3).
- Parameter tables: from `subSeed(seed, 0x100 + mode)`.
- `level`, `bands`, `beatPhase`: decoration only, so a replay after a seek may show different sparkle but identical reveal geometry. The AVS path discards transitions on seek anyway (`mpc-host.ts:279`).
- Env fields that affect *construction* (`beatsTotal`, `boundary`, `nervPair`, `reducedMotion`) are part of the worker cache key (6.2).

---

## 6. Wiring

### 6.1 Main-thread compositor (`visualizer/src/mpc-host.ts`)

- `commit()` (`:214-217`): construct with `{ seed, context }`, where `context = { beatsTotal: transitionDuration*bpm/60, boundary: autoPending ? (director.bars >= 4 ? 2 : 1) : 0, nervPair: false, reducedMotion, energy: bucket(director.energy) }`.
  Freeze `bands = bands16(latestAudio)` on the transition object. `transitionMode === 15` and Instant keep bypassing the compositor.
- `frame()` (`:360`): `transition.draw(cc, outgoing.bitmap, active.bitmap, t, w, h, envNow())` where
  `envNow()` = `{ bpm, beatPhase: tempo.locked ? tempo.phase : 0, barPhase: fract((tempo.beatIndex + tempo.phase)/4), beatsTotal, level: transitionLevel(latestAudio), bands, accent: 0, reducedMotion }`.
  The main-thread path is AVS to AVS (accent 0) and, for NERV to NERV during unclocked Auto, accent 1 when both catalog entries are `kind === 'nerv'`.
- `reducedMotion`: read once and on change from `matchMedia('(prefers-reduced-motion: reduce)')` (a host adapter concern; the standalone Player and MPC WebView both expose it). A future user setting can OR into it.
- New pure helpers exported from `mpc-transition.ts`: `transitionLevel(audio)` (mean of the first 93 spectrum bins of both channels over 510, quantised to quarters), `bands16(audio)`, `subSeed`, `hash32`, `stepQ`, `ticks`, `resolveTransitionMode`.

### 6.2 NERV clocked path (`mpc-host.ts` `render()` and `nerv-render.worker.ts`)

Flat additions to `NervPlaybackFrame` in `avs-worker-protocol.ts` (same style as `transitionMode`/`transitionSeed`), all optional for backward compatibility:

| Field | Type / range | Default when absent | Producer |
| --- | --- | --- | --- |
| `transitionBeats` | finite number, `0 < x <= 64` | `4` | `fadeSeconds*bpm/60` in `render()` |
| `transitionBoundary` | integer `0..3` | `0` | scene-clock ordinal/`barsPerScene` (5.3) |
| `transitionAccent` | integer `0..1` | `1` (both plates are NERV/HUD in this path) | `1` |
| `transitionReduced` | boolean | `false` | host `matchMedia` |

`transitionMode` validation becomes `Number.isInteger(mode) && mode >= 0 && mode < TRANSITION_COUNT`. Invalid values throw `Invalid transition clock`/`Invalid scene transition`, as now.
The worker builds `env` from `clock` and the message: `beatPhase = fract(clock.localTime*clock.bpm/60)`, `barPhase = fract(clock.localTime*clock.bpm/240)`, `level = transitionLevel(message.audio ?? silence)`, no `bands`.
Cache key: `${mode}:${seed}:${beats}:${boundary}:${reduced ? 1 : 0}`; construction context is `{ beatsTotal: beats, boundary, nervPair: true, reducedMotion }`.
The `blend <= 0 && mode !== 15` shortcut stays: it guarantees the exact old plate at a boundary with a zero-progress pivot-0 transition.
Worker `width`/`height` clamps are owned by the NERV resolution stream; the transition layer is resolution independent, so raising them requires no transition change.

### 6.3 Reduced motion

`calm: false` modes (24, 25, 26, 27, 28, 29) become Cross dissolve (mode 1) when explicitly chosen under `reducedMotion`; pools (31, 32) exclude them. Classic push modes are unchanged. Owner question Q3 asks whether to
extend the fallback to the classic pushes.

---

## 7. Every hard-coded transition range

`0..15`, `15`, `16` or the literal list length, with the change needed. Line numbers are at the time of writing.

| File:line | Today | Change |
| --- | --- | --- |
| `visualizer/src/mpc-transition.ts:4` | 16-name literal list | Derive from `TRANSITION_META` (33 entries); `TRANSITION_COUNT`, `TRANSITION_CUT = 15` exported |
| `mpc-transition.ts:43` | `mode === 0 ? 1 + floor(random()*14)` | Keep for 0; add `mode >= 31` resolution; store `requested` |
| `mpc-transition.ts:53` | `this.mode === 15` | Use `TRANSITION_CUT`; add `default:` -> `drawFx` (only for `mode >= 16`) |
| `visualizer/src/mpc-host.ts:44` | `transitionMode = 1` | none (valid) |
| `mpc-host.ts:187-188` | `transitionMode !== 15` decides whether `previousScene` is sent | Also treat Instant (`beatsTotal == 0`) as Cut; add the four new wire fields (6.2) |
| `mpc-host.ts:214` | `new AvsTransition(transitionMode)` | pass `{ seed, context }` |
| `mpc-host.ts:217` | `transitionMode === 15` | `TRANSITION_CUT` and Instant |
| `mpc-host.ts:334` | `message.transition <= 15 ? ... : 1` | `< TRANSITION_COUNT` |
| `mpc-host.ts:340` | `TRANSITIONS[transitionMode]` | none (array grows) |
| `mpc-host.ts:360` | `transition.draw(cc, ..., w, h)` | add `env` (6.1) |
| `visualizer/src/nerv-render.worker.ts:35,37-38` | finite check, `mode < 0 || mode > 15` | `>= TRANSITION_COUNT`; validate the four new fields |
| `nerv-render.worker.ts:49-53` | key `${mode}:${seed}`, `mode !== 15` | new key; `TRANSITION_CUT` |
| `visualizer/src/avs-worker-protocol.ts:13-14` | `transitionMode`, `transitionSeed` | add four optional fields (6.2) |
| `visualizer/src/mpc-setups.ts:11` | `s.transition>15` rejects | `>= TRANSITION_COUNT` (imported from `mpc-transition.ts`) |
| `mpc-setups.ts:2,4,14` | settings shape | any timing-design additions (anchor, duration mode) land here together |
| `visualizer/tools/standalone-library.mjs:19` | `value.transition <= 15` | `<= 32` via a shared constant read from the built table, or a literal kept in sync by the sync test (9.2, item 9) |
| `visualizer/src/standalone-player.ts:2,185-186,107` | builds `<option>`s from `TRANSITIONS`; `settingsFields` includes `transition` | none for the range; new setting fields from the timing design are added to `settingsFields` |
| `visualizer/standalone.html:21-22` | `<select id="setting-transition">` filled by script; `setting-beats` static | none for transitions; the beats/duration select belongs to the timing design |
| `visualizer/src/mpc-management.ts:78-79,97` | select built from `TRANSITIONS`; help text mentions AVS styles | none for the range; update help text to mention the new families and "Random · all styles" / "Smart random" |
| `src/mpc-hc/AAAVSView.cpp:54` | `std::clamp(integer("transition",1),0,15)` | `0, kTransitionCount - 1` |
| `AAAVSView.cpp:81` | `transition < 0 || transition > 15` -> 1 | same constant |
| `AAAVSView.cpp:96` | emits `transition` in settings JSON | none |
| `AAAVSView.cpp:280-281` | `names[]` with 16 entries, `for i<16` | generated names header (8.2), loop to `kTransitionCount` |
| `AAAVSView.cpp:281,302` | menu ids `20 + i`; `choice >= 20 && choice <= 35` | ids `kTransitionMenuBase + i` with base 100 (8.1) |
| `visualizer/tools/check-mpc-auto.mjs:49,54-56` | `TRANSITIONS.length === 16`; `for mode 1..15` | 33; loop `1..TRANSITION_COUNT-1` with a fake context extended for path/text methods |
| `visualizer/tools/check-nerv-worker.mjs:13-28,56,87,94` | fake Context has no path/text methods; `mode <= 15`; invalid `16`; banner text | extend the fake (moveTo, lineTo, closePath, arc, fill, stroke, strokeText, fillText, setTransform); iterate new modes over a bounded subset of pairs; invalid `TRANSITION_COUNT`; banner |
| `visualizer/tools/check-standalone-library.mjs:85` | `transition:[-1,0,15,16,1.5]` | `[-1,0,15,32,33,1.5]` with 32 valid, 33 invalid |
| `visualizer/tools/check-mpc-selection.mjs:15`, `check-standalone-player.mjs:23` | use `15` as Cut | none (still Cut) |
| `visualizer/tools/check-nerv-host.mjs:84-87` | modes `[0,2,6,10,14]`, 15 as Cut | add new modes and assert the four new fields |
| `tools/aaavs-mirror.json` (files list near `:99`; `scripts.check:player`) and `visualizer/package.json` `check` | mirrors `mpc-transition-raster-check.mjs` | add the new tool files and chain the new check (both `check` and `check:player`) |
| `docs/AVS-TRANSITIONS.md`, `docs/NERV-SCENES.md` ("existing AVS transition styles"), `docs/PRESET-MANAGEMENT.md:31`, `docs/AAAVS-SHARED-DEVELOPMENT.md` feature row | describe 16 classic styles | update (attribution split, new indices) |

Storage compatibility: stored values 0..15 keep their meaning. New indices are stored the same way (plain integers): MPC registry `Transition`, `setups.json`, the Player's settings file.
Downgrade risk: an older build clamps a registry value above 15 to 1 (`AAAVSView.cpp:81`), but the older `parseSetups` and the older library server *reject* a whole setup file/settings file containing
index 16+ (`mpc-setups.ts:11`, `standalone-library.mjs:19`). Forward-only is accepted (Q4).

---

## 8. Native menu (MPC-HC)

### 8.1 Menu identifiers

Current IDs: phrases `1-5`, transitions `20-35`, beats `40-43`, toggles `50-53`, seconds `60-65`, rating `70-75`. Transition IDs `20 + i` for `i` up to 32 would reach 52,
colliding with `40-43` and `50-53` (`choice >= 20 && choice <= 35` would also silently drop new entries). **Change:** `constexpr UINT kTransitionMenuBase = 100;` ids `100 + i`, handled as
`choice >= kTransitionMenuBase && choice < kTransitionMenuBase + kTransitionCount`. Reserve `200-299` for the timing design's new timing/duration items (so neither design edits the other's range) and `300+` for future.
The old `20-35` block is retired, not reused.

### 8.2 Single source for names

`AAAVSView.cpp:280` duplicates the names in C++. **PROPOSED:** `visualizer/tools/gen-transition-names.mjs` emits `src/mpc-hc/AAAVSTransitionNames.h` (`kTransitionNames[]`, `kTransitionCount`, family per index for
submenu grouping) from `TRANSITION_META`; a CPU test compares the committed header with the regenerated text (9.2, item 9). The popup becomes submenus: `Classic (1-14)`, `NERV / HUD (16-30)`, then `Random · classic`, `Random · all styles`, `Smart random`, `Cut`.

---

## 9. CPU test plan

All are node CPU scripts in the existing idiom (`esbuild` bundle of the TS source, `node:assert/strict`), chained into `npm run check` and `check:player`. None launches a browser, GPU or app.

### 9.1 Test doubles

`visualizer/tools/mpc-transition-fx-raster.mjs` (new, mirrored): a scalar `PathRaster` extending the current `Raster` idea: `beginPath/moveTo/lineTo/arc(48-gon)/rect/closePath`, nonzero point-in-polygon `clip` with a save/restore stack,
`drawImage` with 3/5/9 arguments (nearest, pixel centres), `fillRect/fill/stroke/fillText/strokeText` writing a decoration sentinel (`-1`) so reveal coverage and decoration area can be counted separately, `globalAlpha`, `setTransform` identity only,
`imageSmoothingEnabled`. Old = values `100 + i`, next = `10000 + i` so any pixel's source is identifiable. A recording context wraps it and asserts finite arguments and counts calls.

### 9.2 `visualizer/tools/check-mpc-transition-fx.mjs` (new)

1. **Table.** `TRANSITION_META.length === TRANSITIONS.length === 33`; names unique; first 16 names equal a pinned snapshot of the current list except index 0 (`Random · classic`); `hit`/`minBeats`/`maxBeats` sane.
2. **Classic unchanged.** For modes 1-15, output with and without an env argument is identical; classic `Random`: 256 seeds pinned to a fixture generated once from the unmodified constructor (`mode` and `order`) before the change. This is a new fixture, not a re-record of any golden hash.
3. **Endpoints, all new modes 16-30.** Sizes `12x8, 13x9, 256x144, 640x360`; seeds `0, 1, 7, 0xdeadbeef`; `beatsTotal` `0.5, 1, 2, 4, 8`.
   `t = 0`: pixel-exact old; `t = 1`: pixel-exact next; `t = 1e-9`: at least 98% old; `t = 1 - 1e-9`: at least 98% next (excluding decoration), with 100% for the quantised modes 16, 18, 25, 29.
4. **Monotonicity.** 240-step sweep: for reveal-family modes (16-21, 25, 30) the count of next-sourced pixels is non-decreasing and each pixel switches at most once; for 22, 23, 24, 26, 27, 28, 29 each pixel's source history has at most 2 changes (26: old, ink, new).
5. **Determinism and statelessness.** Same `(seed, env, t)` yields identical recorded operations across two instances; frames evaluated in shuffled `t` order equal in-order frames; 32 seeds give at least 12 distinct operation signatures for each seeded mode; modes 0/31/32 resolve identically for identical `(seed, context)`.
6. **Bounds.** All numeric arguments finite; each `drawImage` destination rectangle intersects the canvas (scratch draws excepted); 9-argument source rectangles lie inside the source; `clip <= 3`, `D <= 48`, `F <= 48`, `T <= 2` per frame and per-mode `cost` respected; the totals are equal at 256x144 and 1920x1080; Mosaic Drop resizes its scratch at most 12 times per transition; decoration area (sentinel pixels) at most 15% and bright decoration at most 1%.
7. **Limiter-clean sweep (S7).** At 256x144, feed each frame's RGBA probe through the real `FlashLimiter` (`computeFrameStatsRgba` + `evaluate`) at 60 and 240 fps sampling, `bpm` 90/140/200, `beatsTotal` 1/2/4/8, worst-case rasters black to white and black to `#ff0000`. Require `decision.limited === false` and `blend === 1` for every frame in `limit` mode. `strict` is reported and any failing mode/length pair is listed (informational, an owner decision).
8. **Selectors.** Smart random: `beatsTotal < 2` never yields 27; `< 4` never yields 29; `reducedMotion` never yields a non-calm mode; `boundary 0` never yields a `hit` mode; `nervPair` raises NERV-flavoured picks to at least 60% over 2000 seeds; mode 31 never yields 0/15/31/32; determinism over repeated calls; every candidate is reachable across 2000 seeds for a permissive context.
9. **Sync.** The generated header equals `AAAVSTransitionNames.h`; no `20 + i` menu construct remains; `kTransitionCount` equals `TRANSITION_COUNT`.

### 9.3 Extensions to existing checks

- `check-mpc-auto.mjs`: length 33, all-mode draw-call smoke with the extended fake context; `check-mpc-management.mjs` / `check-standalone-library.mjs` / `parseSetups`: index 32 accepted, 33/-1/1.5 rejected.
- `check-nerv-worker.mjs`: extend the fake `Context`; 33 modes across a bounded subset of scene pairs (the current 240 pairs x 33 modes is about 8k renders; use the first 24 pairs for modes 16-32 and keep all 240 for 0-15); endpoint/seek-replay assertions for the four wire fields; invalid `transitionBeats` (`0, -1, NaN, 65`), `transitionBoundary` (`4, 1.5`), `transitionAccent` (`2`), `transitionMode` (`33`); the cache key changes when `beats` changes.
- `check-nerv-host.mjs`: assert `transitionBeats` (4 at 4 beats, 2 for 1000 ms at 120 BPM), `transitionBoundary` for section boundaries, Instant produces no `previousScene`, new modes pass through as `transitionMode`. Phase 2: pivot cases (`end`, `hit`) yield `blend` values from the shifted clock and a frozen incoming scene time during pre-roll, and seek replays them.

### 9.4 Not claimed

Pixel fidelity of the real Canvas2D (clip antialiasing, smoothing, text metrics), GPU cost and frame time, audible/visible beat alignment, and the subjective quality of any mode are **not** verified by these checks and remain deferred
until the GPU is available. `npm run check`, `npm run build` and `npm run build:player` must pass, and the mirror `--check` run against the stock checkout, before this is described as available in both apps.

---

## 10. Staging

1. **Phase 1, geometry only:** `mpc-transition.ts` meta/API/resolution, `mpc-transition-fx.ts`, the raster double and `check-mpc-transition-fx.mjs`. No host change; `TRANSITIONS` grows so the Player and Manager selects show the modes immediately, but `mpc-host.ts:334`, `mpc-setups.ts:11`, `standalone-library.mjs:19` and the worker range must land in the same change (a selectable mode the validators reject would silently fall back to 1).
2. **Phase 2, wiring:** env plumbing in `mpc-host.ts` and `nerv-render.worker.ts`, four protocol fields, C++ IDs/names header, generated-header test, docs.
3. **Phase 3, selectors and reduced motion:** modes 31/32 contexts, `matchMedia`.
4. **Phase 4, anchors:** `pivot` (`end`/`hit`), lookahead growth, plan clamp; depends on the timing design's `plan(ordinal)` and anchor setting.

---

## 11. Attribution

- Modes 1-14 remain derived from `grandchild/vis_avs` `r_transition.cpp` (BSD-3-Clause, Nullsoft). `THIRD-PARTY-AVS-TRANSITIONS.txt` and the header of `mpc-transition.ts` stay as they are and continue to cover only that switch.
- Modes 16-30 are **original designs** (Canvas2D compositions written for this project); no upstream code is copied. They live in a separate file, `visualizer/src/mpc-transition-fx.ts`, whose header says so.
- Their hazard-stripe, hexagon, octagon and radar vocabulary shares geometry with `nerv-scenes.ts` (plate concepts adapted from `bizarro/evangelion`, MIT, see `THIRD-PARTY-NERV.txt`). The fx header cross-references that notice for the vocabulary; the drawing code is independent, and the stripe pitch is quoted as a ratio (40/960) rather than imported.
- CRT collapse, datamosh, glitch slicing, tile flip, mosaic and iris are generic, long-established techniques; no game, film or third-party asset, glyph set or logo is used. Numerals use the system monospace stack already used by the scenes.
- `docs/AVS-TRANSITIONS.md` gains a short table stating which indices derive from vis_avs and which are original.

---

## 12. Risks and open questions

Risks:
- **Validator drift.** The same range appears in about ten places (section 7). Mitigation: `TRANSITION_COUNT` as the one constant, the generated C++ header and the sync test.
- **Fake-context breakage.** Existing test doubles have no path/text methods; new modes throw against them. The doubles are extended in the same change.
- **Downgrade** rejects whole setup/settings files that contain index 16+ (Q4).
- **Pre-roll (anchors)** touches `sceneAt` lookahead, preloading and commit guards; it is the riskiest part and is deferred to Phase 4.
- **Canvas antialiasing seams** at clip polygon edges (hex cells, wedges): mitigated by 2% polygon inflation and one merged path, but only real-canvas checks can confirm.
- **Point-sampled mosaic** may shimmer on fine detail; `imageSmoothingQuality` tuning is a visual decision deferred until GPU/browser time.
- **Frame cost** of the two-plate NERV composition is unchanged in count but not measured here.

Owner questions (defaults in brackets):
- Q1. Rename index 0 to `Random · classic`? [Yes; index and behaviour unchanged.]
- Q2. Should mode 0 (classic Random) ever include the new modes? [No; keeps stored setups visually stable. "Random · all styles" is the opt-in.]
- Q3. Extend `reducedMotion` fallback to the classic pushes/squeeze? [No for now; touch only new modes and the pools.]
- Q4. Accept forward-only storage (older builds reject files containing index 16+)? [Yes, note it in release notes.]
- Q5. Default anchor for new setups? [`start`, matching today's behaviour; `hit` recommended for Mosaic Drop and Countdown Iris once Phase 4 exists.]

---

## Appendix A: code sketches (PROPOSED, idiom-matched, not final)

```ts
// mpc-transition.ts (excerpt)
export const subSeed = (seed: number, salt: number) => { let n = (seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0; n = Math.imul(n ^ n >>> 16, 0x45d9f3b); n = Math.imul(n ^ n >>> 16, 0x45d9f3b); return (n ^ n >>> 16) >>> 0; };
export function resolveTransitionMode(mode: number, seed: number, cx: TransitionContext): number {
  const pool = TRANSITION_META.flatMap((m, i) => m.kind === 'selector' || i === 0 || i === TRANSITION_CUT || cx.beatsTotal < m.minBeats || cx.beatsTotal > m.maxBeats || cx.reducedMotion && !m.calm ? [] : [i]);
  if (!pool.length) return 1;
  const random = seededRandom(subSeed(seed, mode === 31 ? 1 : 2));
  if (mode === 31) return pool[Math.floor(random() * pool.length)]!;
  const weights = pool.map(i => smartWeight(TRANSITION_META[i]!, cx));            // table in 3.4
  let x = random() * weights.reduce((a, b) => a + b, 0);
  for (let k = 0; k < pool.length; k++) if ((x -= weights[k]!) < 0) return pool[k]!;
  return pool.at(-1)!;
}
```

```ts
// mpc-transition-fx.ts (excerpt): MAGI Hex Reveal, single compound path
interface HexParams { R: number; cx: Float32Array; cy: Float32Array; tau: Float32Array }
function hexParams(seed: number, w: number, h: number): HexParams {
  const random = seededRandom(subSeed(seed, 0x100 + 18)), R = Math.max(4, w / 14), dx = R * Math.sqrt(3), dy = R * 1.5;
  const cols = Math.ceil(w / dx) + 1, rows = Math.ceil(h / dy) + 1, n = Math.min(128, cols * rows);
  const cx = new Float32Array(n), cy = new Float32Array(n), tau = new Float32Array(n), e = Math.floor(random() * n);
  for (let i = 0; i < n; i++) { cx[i] = (i % cols) * dx + (Math.floor(i / cols) % 2) * dx / 2; cy[i] = Math.floor(i / cols) * dy; }
  const far = Math.max(...Array.from(cx, (x, i) => Math.hypot(x - cx[e]!, cy[i]! - cy[e]!))) || 1;
  for (let i = 0; i < n; i++) tau[i] = Math.min(.999, .7 * Math.hypot(cx[i]! - cx[e]!, cy[i]! - cy[e]!) / far + .3 * random());
  return { R, cx, cy, tau };
}
function hexPath(ctx: Ctx, p: HexParams, keep: (tau: number) => boolean) {
  ctx.beginPath();
  for (let i = 0; i < p.tau.length; i++) if (keep(p.tau[i]!)) {
    for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + k * Math.PI / 3, x = p.cx[i]! + Math.cos(a) * p.R * 1.02, y = p.cy[i]! + Math.sin(a) * p.R * 1.02; k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.closePath();
  }
}
export function hexReveal(g: Fx, t: number) {
  const q = stepQ(t, ticks(g.env, 2, 4)), p = g.hex ??= hexParams(g.seed, g.w, g.h);
  if (q <= 0) return;
  g.ctx.save(); hexPath(g.ctx, p, tau => tau < q); g.ctx.clip(); g.draw(g.next); g.ctx.restore();
  g.ctx.strokeStyle = g.accent; g.ctx.lineWidth = 1.5 * g.u; hexPath(g.ctx, p, tau => tau < q && tau >= q - .12); g.ctx.stroke();
}
```
