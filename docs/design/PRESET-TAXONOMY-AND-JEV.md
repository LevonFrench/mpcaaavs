# Preset taxonomy, the master AVS folder, and the Jev decision model

Status: design only. Nothing in this document is implemented. Every statement is
tagged **EXISTS** (verified by reading the code or data in this checkout),
**MEASURED** (produced by a throwaway CPU-only script over the local collection;
not committed) or **PROPOSED**. No GPU, browser, player, server or external API was
used. No Jev/TypeSafe API key exists on the design machine and none was requested,
read or used. Nothing here claims visual, GPU or live acceptance.

Companion documents: [PRESET-MANAGEMENT](../PRESET-MANAGEMENT.md),
[AAAVS shared development](../AAAVS-SHARED-DEVELOPMENT.md). The folder browser itself
(tree UI, search, sorting, Play folder) is specified separately in
`docs/design/PRESET-BROWSER-V2.md`; this document supplies the *data* that browser
consumes and states the contract it must meet (section 6).

## 1. Verdicts in one page

| Question | Verdict |
| --- | --- |
| Can a browsable style taxonomy be built with zero network and no key? | **Yes.** 18 categories from the parsed effect list, about 250 lines of shared TypeScript, and a measured prototype that yields a sane spread (section 4). This is the deliverable that matters. |
| Does Jev add value to classification? | **Marginal, and unproven.** Jev is text-only. It cannot see the render. It reads the same effect list the rules already read, plus a cryptic title. Worth one cheap, owner-run experiment gated on a small owner-labelled gold set (sections 5 and 9); otherwise skip. |
| Should Jev run at play time (per frame, per scene change, per transition)? | **No.** Network dependency and 250-590 ms client latency in a music visualizer, plus song and library data leaving the machine. A static table authored offline does the same job. |
| Is it safe to send presets to Jev? | **Only a narrow allowlist**, only when the owner supplies a key at run time, only after a dry-run the owner has read (section 5.3). Default behaviour never touches the network. |
| Does the existing runner (`newsjack_jev_runner.py`) match the real SDK? | **Partly.** Imports and `system_one()` match; three attribute/argument names do not, and a broad `except` would silently substitute keyword heuristics. Do not reuse it (section 3.2). |
| Is Jev useful in *this build workflow* without a key? | **No.** Its harness is shadow-mode and needs a key; its deterministic layer is the only part that runs, and it duplicates what our own checks already do (section 8). |

## 2. What exists today (verified in the checkout)

- **Parser.** `visualizer/src/avs/preset.ts` `parseAvsPreset()` returns
  `AvsPresetAst { version, clearEveryFrame, components[], byteLength }`. Each
  `AvsComponent` exposes `effectId` (signed int; `-2` is Effect List), `apeId`
  (32-byte APE name or `null`), `payload` (opaque bytes), `path`, `children`, and for
  lists `list` (`enabled`, blend modes, `beatRender`, `beatRenderFrames`, buffer
  indices) and `listCode` (`init`/`frame` EEL strings). **The parser does not name
  effects and does not decode per-effect settings.**
- **Names.** Built-in ids 0-45 map to names in three private copies
  (`src/avs/editor-model.ts` `BUILTIN_RENDERER_NAMES`, `tools/avs-coverage-report.ts`,
  `tools/analyze_winamp5_presets.py`). APE identity is the `apeId` string; nine have
  exported constants (`AVS_COLOR_MAP_APE_ID`, `AVS_TEXER_APE_ID`, ...).
- **Per-effect decoders** are exported from `src/avs/effects/*` and take a component
  payload: `decodeAvsSuperScope` (`lines` boolean, `point`/`frame`/`beat`/`init` EEL),
  `decodeAvsMovement` (`effect` 0-23 built-in or `32767` scripted, `expression`),
  `decodeAvsDynamicMovement` (EEL, `gridWidth`/`gridHeight`, `buffer`),
  `decodeAvsMirror` (`mode`, `randomOnBeat`), `decodeAvsTexerConfig` and
  `decodeAvsTexer2Config` (`image`, `particles`, EEL), `decodeAvsColorMap`,
  `decodeAvsConvolutionConfig`, `decodeAvsBump`, `decodeAvsBlitterFeedback` and more.
  They read payloads only; they are the only honest source for "lines vs dots",
  "scripted vs built-in movement" and similar facts.
- **Support truth.** `avs-render.worker.ts` builds `createAvsCompatibilityRegistry()`
  and the executor counts a component with no handler as `unsupported` and skips it.
  `registry.handler(component)` therefore tells exactly which components will not
  render. **MEASURED:** 574 of 3,406 parseable presets (16.8 %) contain at least one
  such component.
- **Catalog.** `src/avs/local-collection.ts` loads `avs presets/catalog/presets.json`
  and `parser-validation.json` through `boundedJson`; entries carry `sha256`,
  `display_name`, `canonical_path`, `bytes`, optional `rating` (rating is also in the
  filename `... [N stars].avs`), `notWorking`, `kind` (`avs`|`nerv`) and `scene`.
  Identity is the content hash: ratings rename files but never change `sha256`.
- **Serving.** Native: WebView2 maps `visualizer/` to `https://aaavs.invalid/` and
  only `mpc.html` may navigate; the page `fetch`es collection files same-origin
  (`AAAVSView.cpp`). Standalone: `tools/standalone-library.mjs` serves the same tree
  statically and hides only `.aaavs-private`, `setups.json`, `settings.json` and
  transaction artifacts. **A new `catalog/categories.json` is therefore fetchable in
  both hosts with no host change.**
- **Not present.** No folder, category, tag or style concept exists in
  `mpc-management.ts`, `mpc-setups.ts` or `mpc-host.ts` (grepped). Setups are flat
  ordered hash lists. The shipped release catalog is NERV-only (16 entries,
  enforced by `tools/package-release.py`), so anything derived from the AVS catalog is
  absent from public artifacts by construction.
- **Test idiom.** `tools/check-*.mjs` bundle TypeScript with `esbuild` and import it
  from a `data:` URL; `check-mpc-catalog.mjs` reads the local collection directly.
- **HUD kit manifests.** `assets/hud-kits/*/manifest.json`: 488 kits, **MEASURED**
  1,795 elements, 250 distinct `role` strings (160 appear once), each with
  `aaavsProposal.driver`, `normalizedRect`, `observedState` text.

## 3. Jev: an honest assessment

### 3.1 What Jev is (sources: TypeSafe docs fetched for this task; harness wiki `Ref-Live-Findings`, which recorded 41 live calls by another session)

| Item | Fact |
| --- | --- |
| Model | "System One": returns typed probabilities, no generated text. Pin `jev-1.13.0`; `jev-latest` is an alias that moves. `model` is required on the wire. |
| Endpoint | `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`, body `{model, state, questions}`; answers `{model, answers, usage}`. |
| Primitives | `choice` (max 255 options; returns choice, per-option probabilities, confidence), `score` (2-10 ordered levels; fractional probability-weighted score, confidence), `noul` (probability only; no confidence). Questions in one request share state and run in parallel. |
| Confidence | `(K*p_max - 1)/(K - 1)`, K = option count. Not accuracy; not comparable across different K. Noul has none. |
| Limits | 64k context, 32k for state plus the longest question; text only. |
| Price | about $0.042 per million input tokens, output free; ~300 tokens fixed overhead per request. |
| Latency | vendor 70-500 ms; observed client 250-590 ms through a proxy. |
| Rate limit | 1,200 requests/min, 250k tokens/s (dynamic). |
| Privacy | Vendor says inputs are not used for training; retention period not stated; zero retention is an enterprise option; injected text in state can steer answers. |
| Key | `TYPESAFE_API_KEY` for the SDKs. None exists on this machine. |

The `typesafe:typesafe-ai` skill's design guidance applies: keep code-owned policy,
keep rules and exact lookups in code, ask one narrow judgment per question, include a
no-match option, and validate thresholds on the user's own labelled data rather than
copying cookbook numbers.

### 3.2 The runner's SDK usage does not fully match the real SDK

The Jev harness's `newsjack_jev_runner.py` (a reading source only, outside this repository)
was compared with the live Python SDK page and with the harness wiki's discrepancy
ledger (which read the published `typesafe-sdk` package). I did not install the SDK
or read its source myself.

| Runner code | Verdict |
| --- | --- |
| `from typesafe_sdk import TypeSafeClient, Choice, Score, Noul` | Matches. |
| `client.system_one(state=..., questions=...)` | Matches. |
| `Choice(instructions=..., criteria={...})` | Matches. |
| `Score(instructions=..., labels=[...])` | **Wrong.** Real argument is `criteria=[...]` (ordered list). |
| `result.answers["k"].winning_key` | **Wrong.** Real: `result.choices["k"].choice`. |
| `result.answers["k"].score` | **Wrong.** Real: `result.scores["k"].score`. |
| broad `except Exception` -> keyword fallback | Any of the above raises `AttributeError`/`TypeError`, is caught, and the run silently reports keyword results labelled `simulated_jev_logic` with invented confidences (0.96, 0.99). A keyed run of this file would very likely never produce a live answer. |
| `--api-key <key>` CLI flag | Puts a secret in shell history and process listings. |

Consequence: our tool does not import this runner. It calls the REST contract
directly (section 5), which the harness's `deciders/typesafe_rest.py` also does with
strict validation. The harness's own client, not the runner, is the better reference.

### 3.3 Where a System One judgment would and would not help here

| Candidate | Value | Risk | Verdict |
| --- | --- | --- | --- |
| Classify 3,409 presets into a style taxonomy (name + effect summary) | Small over rules: reads cryptic titles, second opinion on ambiguous mixes. Cannot see pixels. | Names go to a third party | **Optional dev-time experiment**, gated on gold-set accuracy (sec. 5, 9). |
| Score preset "intensity/energy/busy-ness" for mood shuffle | Weak: text-only guess. Deterministic proxy (beat-render lists, OnBeat Clear, Custom BPM, component count) is already informative; owner star ratings and skip history are better signals. | Same | **Skip by default**; the Score question is specified but off. |
| Pick a transition style from musical context | Style choice is a small table of ~16 options. A scene change happens every 2-8 bars, so latency would even be tolerable, but the player would depend on a network service and export song analytics. | Privacy, offline use, reproducibility (seeded timing must be deterministic) | **Reject at run time.** If wanted, precompute a static style-affinity table offline (style x category x energy, about 1,150 Score calls, well under a cent) and ship the table as data. Author it by hand first; Jev only if the owner wants a second opinion. |
| Screen HUD kit manifests for role/driver mis-labels | Real but small: 250 role strings, 160 singletons. 462 of the 471 `*viewport*` elements map to `background-*` drivers and 476 of 523 `*panel*` elements to dock or anchor drivers; the genuine anomalies are in the long tail. | Text about game screenshots leaves the machine; assets are local research kits | **Deterministic pre-screen first** (sec. 7). Jev Noul only to rank the residual conflicts, and only with owner consent. |
| Gate destructive automation (rating renames, catalog writes, not-working marks) | None: those paths are already deterministic, transactional and confined (`standalone-library.mjs`, `AAAVSLibrary.h`). | Adds a false-allow path | **No.** |
| Per-frame, per-beat or audio-reactive use | Negative. | Latency, dependency | **Never.** |

## 4. Deterministic baseline (no network, no key)

### 4.1 Signals: what the parser truly exposes

| Signal | Source | Reliability |
| --- | --- | --- |
| Effect identity (built-in id / APE string), count, nesting, order | `effectId`, `apeId`, `children` | Exact |
| Lists: count, depth, beat-render flag, blend modes, `listCode` present | `component.list`, `listCode` | Exact |
| SuperScope draws lines vs dots; has beat code; assigns `z`; uses `atan`/`sqrt` | `decodeAvsSuperScope` + light regex on EEL | Lines/dots exact; regex is a hint |
| Movement built-in vs scripted; built-in id 23 is the 6-way kaleidoscope | `decodeAvsMovement` (`effect`, `expression`; `movement.ts` documents id 23 as `y=(r*6)/$pi;x=d`) | Exact for the flag; names of other built-ins are not documented in the repo and are not used |
| Mirror mode, Texer image/particles, Color Map, Convolution, Bump | decoders | Exact |
| Unsupported components | `registry.handler(component)` | Exact (CPU registry, which the worker shares) |
| Title tokens and an "Author - Title" prefix | catalog `display_name` | Heuristic; strip ` [N stars]` first |

Not available and therefore not used: rendered appearance, colour palette, motion
speed, any judgment of quality; per-effect payloads for effects with no decoder
(e.g. Water, Bump strength beyond the decoder, Comment text). Two traps found while
measuring: (1) `SuperScope` beat code and `Dynamic Movement` beat code are non-empty
in most presets, so "has beat code" does not indicate beat reactivity and is excluded;
(2) the polar variables `d`/`r` appear in nearly every scripted movement, so "polar
math" does not indicate a swirl. Only structural beat evidence (beat-render lists,
OnBeat Clear, Custom BPM) is used.

### 4.2 Taxonomy: 18 categories in 6 families (PROPOSED)

The two-level tree is what the master folder shows under **By style**. Every preset
has exactly one primary category and up to two secondary tags.
"Share" is the MEASURED primary share of the 3,409-preset local collection using the
rules in 4.3 (3 unparseable presets have no category).

| Family | Id | Label | Definition (what belongs) | Share |
| --- | --- | --- | --- | ---: |
| Scopes | `scope-classic` | Waveforms & Oscilloscopes | Audio line or spectrum drawn as a scope: Simple, Timescope, line-mode SuperScope with little else. | 7.0 % |
| Scopes | `scope-geometry` | Superscope Geometry | Three or more SuperScopes, or scripted shapes, forming figures rather than a plain wave. | 8.9 % |
| Scopes | `rings-stars` | Rings, Stars & Radial | Ring, Oscilloscope Star, Rotating Stars, Bass Spin. | 3.7 % |
| Particles & Space | `particles` | Particles & Dot Fields | Moving Particle, Dot Grid, Dot Fountain, dot-mode SuperScope, Texer sprites. | 9.9 % |
| Particles & Space | `starfield` | Starfields & Flight | Starfield (built-in or APE) as the identity. | 4.5 % |
| Particles & Space | `perspective-3d` | 3D & Perspective | Dot Plane, a SuperScope that assigns `z`, Texer II with depth, 3D/triangle APEs. | 2.2 % |
| Feedback & Motion | `tunnel-zoom` | Tunnels, Zoom & Echo Feedback | Movement/Dynamic Movement engines with decay (Fade Out, Blur), Blitter Feedback, delay and buffer echo; the "default engine" family. | 10.9 % |
| Feedback & Motion | `spin-rotate` | Spin & Rotate | Roto Blitter, Bass Spin dominated. | 3.6 % |
| Feedback & Motion | `kaleido-mirror` | Kaleidoscope & Mirror | Mirror, or movement built-in 23 / kaleidoscope-shaped scripts. | 4.5 % |
| Surface & Colour | `water-ripple` | Water & Ripples | Water, Water Bump. | 3.8 % |
| Surface & Colour | `bump-relief` | Bump, Relief & Convolution | Bump, Convolution filters. | 4.3 % |
| Surface & Colour | `color-grade` | Colour Maps & Grading | Color Map, Dynamic Color Modifier, Unique Tone, Color Fade, Channel Shift. | 12.9 % |
| Surface & Colour | `glitch-digital` | Glitch & Digital Decay | Interferences, Grain, Mosaic, Scatter, Interleave, Color Reduction, MULTIFILTER. | 5.1 % |
| Beat & Frame | `beat-flash` | Beat Flash & Strobe | OnBeat Clear, Custom BPM, beat-render lists, Invert flashes. | 3.3 % |
| Beat & Frame | `text-image` | Text, Pictures & Video | Text, Picture (I/II), AVI, SVP. | 5.0 % |
| Structure | `multi-scene` | Layered Multi-scene | 45 or more components or 8 or more lists and no decisive style. | 1.5 % |
| Structure | `minimal` | Minimal & Fragments | Three or fewer components: test, demo and component samples. | 7.2 % |
| Structure | `mixed` | General Mix | Nothing scored clearly. Also the fallback for a Jev `general_mix`. | 1.6 % |

NERV scenes and HUD packs are separate top-level folders owned by their own
kind (`kind: 'nerv'` today); they are not part of this AVS style taxonomy.

### 4.3 Classifier rules (PROPOSED; prototype in scratch reproduces the shares above)

Score per category, then structural overrides.

1. **Evidence weights.** Each recognised effect adds its weight once, scaled by
   `1 + 0.35*log2(min(count, 8))`. Identity effects weigh 2-3.5; supporting effects
   1-1.5. Examples: Simple 3, Ring/Star/Rotating Stars 3, Moving Particle 2,
   Starfield 3.5, Water 3, Water Bump 3.5, Bump 3, Convolution 2, Color Map 2.5,
   Dynamic Color Modifier 3, Interferences/Grain 3, Mirror 3, Roto Blitter 3, Text 3.5,
   Picture 3, OnBeat Clear 3, Custom BPM 1.5, Blitter Feedback 2.5 (tunnel), Video
   Delay 2.5 (tunnel), Buffer Save 0.5 (tunnel).
2. **Zero-weight engines.** Movement, Dynamic Movement, Blur, Fade Out, Comment, Set
   Render Mode, Fast Brightness, Buffer Save (mostly) carry no direct weight: they are
   in 42-62 % of all presets and would flood every category. (**MEASURED** prevalence:
   Movement 62 %, Dynamic Movement 57 %, Comment 56 %, SuperScope 55 %, Blur 48 %,
   Set Render Mode 47 %, Fade Out 42 %.) They contribute only through the two
   composite rules below.
3. **Composite rules.** Movement or Dynamic Movement plus Fade Out or Blur: +1.6
   `tunnel-zoom`. Built-in-only movement: +1.2 `tunnel-zoom`. Two or more Dynamic
   Movements: +0.6 `tunnel-zoom`. Kaleidoscope movement (built-in 23 or script with
   angular multiplier): +3 `kaleido-mirror`. SuperScope lines (cap 2): +1 each
   `scope-classic`. SuperScope dots (cap 3): +0.8 each `particles`. Three or more
   SuperScopes: +1.5 + 0.25n `scope-geometry`. SuperScope assigning `z`: +2 + 0.4n
   `perspective-3d`. Beat-render lists: +0.9 each (cap 3) `beat-flash`.
4. **Structural overrides.** `components <= 3` -> `minimal`. `components >= 45` or
   `lists >= 8` -> keep the top style if its score is at least 6, else `multi-scene`;
   when a style wins, `multi-scene` is added as a tag. Top score below 2.0 -> `mixed`.
5. **Tags.** Up to two categories other than the primary scoring at least
   `max(2.0, 0.6 * top)`.
6. **Confidence** `k = min(1, top/6) * (0.5 + 0.5*margin)`, `margin = (top - second)/top`;
   `minimal` is fixed 0.9. **MEASURED** quantiles: p10 0.25, p50 0.41, p90 0.75. A
   review threshold of `k < 0.28` or `mixed` selects 699 presets (20.5 %).
7. **Fixed tie-break.** Ties resolve by the order of the table in 4.2 so output is
   order- and platform-independent.

All numbers are starting points that belong in one exported table
(`TAXONOMY_WEIGHTS`) and are validated by the gold set (section 9), not by taste.

### 4.4 Facets that ride along with the category (PROPOSED)

| Facet | Values | Rule |
| --- | --- | --- |
| `b` busyness | 1-5 | components <= 5, 12, 22, 40, more. **MEASURED** 354 / 1,028 / 1,431 / 429 / 164. |
| `beat` | `reactive`/`flowing` | any beat-render list, OnBeat Clear or Custom BPM. 745 / 2,661. |
| `e` energy | `calm`/`steady`/`driving`/`intense` | intense = reactive and busyness >= 4, or OnBeat Clear with Invert; driving = reactive; steady = busyness >= 3; else calm. 1,261 / 1,400 / 441 / 304. |
| `f` fidelity | `full`/`partial` | any component without a handler. 2,832 / 574. Sorts unsupported presets down and lets Auto avoid them. |
| `a` author | optional string | prefix of `display_name` before ` - `, rejected when numeric, an effect or style word, or longer than 40 characters. 1,550 names contain the separator but only 211 distinct prefixes; one prefix covers about a fifth of the collection. Precision is heuristic (one false-positive prefix is a preset family name). |

`e` and `b` are deliberately coarse proxies; ratings remain the owner's real quality
signal and must not be replaced by them.

### 4.5 Measured prototype results (CPU-only, private collection, not committed)

- 3,406 of 3,409 parse; 57k components; 0 decoder errors on the four decoded effects.
- Primary distribution: largest bucket `color-grade` 12.9 %, smallest style bucket
  `perspective-3d` 2.2 %; `mixed` 1.6 %. No bucket dominates.
- **Weak external validation only.** Title keywords (water, star, kaleido, text,
  tunnel, spin...) hit a category's primary-or-tag 30 % of the time over 1,048 title
  matches, against base rates of 2-13 %: a 3-7x lift, but far from agreement, because
  titles are mostly evocative and only some are literal. This is not accuracy. It is a
  sanity signal that the rules are not random. **Real accuracy is unmeasured until an
  owner-labelled gold set exists.**

### 4.6 Known failure modes

- **Engine-dominated presets** (a scripted Movement plus SuperScope with all the look
  in EEL) end in `tunnel-zoom`, `scope-geometry` or `mixed`; effects alone cannot
  say "looks like fire". Bounded improvement: light EEL keyword hints (exists today:
  `sin`, `cos`, `atan`); a general EEL analysis is out of scope.
- **Ubiquitous-engine bias:** because engines carry no weight, a preset whose only
  distinctive effect is a single Buffer Save lands in the family of its next-strongest
  signal, often `mixed`.
- **Unsupported effects can be the identity:** 78 presets have an Oscilloscope Star
  and 92 a Bass Spin, neither runnable. They are classified by intent but tagged
  `partial`; the browser must show that badge, not hide them.
- **Author precision:** the prefix heuristic mislabels titles that begin with a style
  word; it is a sort key only and is never used for security or grouping guarantees.
- **Old APEs with unknown semantics** (FunkyFX, Flock Off, Normalise...) count only
  toward fidelity and one glitch weight.
- **Taxonomy drift:** changing weights re-buckets thousands of presets. Bump
  `taxonomy.version`; the page ignores a `categories.json` with a mismatched version
  rather than mixing schemes.

### 4.7 Shared source layout (PROPOSED)

`visualizer/src/avs/preset-taxonomy.ts`: pure, no DOM, no fetch.

```ts
export const TAXONOMY_VERSION = 1;
export interface TaxonomyCategory { readonly id: CategoryId; readonly label: string; readonly family: string; readonly definition: string }
export const TAXONOMY: readonly TaxonomyCategory[];       // order = tie-break order
export interface PresetComposition {                       // plain JSON: testable, and the only thing ever sent to Jev
  readonly components: number; readonly lists: number; readonly maxDepth: number; readonly beatLists: number;
  readonly effects: Readonly<Record<string, number>>;      // builtin id as "b36" or APE name as "ape:Texer"
  readonly detail: { ssLines: number; ssDots: number; ssZ: number; mvBuiltin: number; mvScript: number; mvKaleido: number; unsupported: number; decoded: boolean };
}
export function compositionOf(ast: AvsPresetAst, has: (c: AvsComponent) => boolean): PresetComposition;
export function classifyComposition(c: PresetComposition): { primary: CategoryId; tags: CategoryId[]; k: number; facets: Facets };
export function sanitizeTitle(displayName: string): string; export function authorOf(displayName: string): string | null;
```

`has` is `registry.handler(c) !== undefined`, injected so the module never imports the
GPU or worker code and tests can pass a stub. The one shared table of built-in names
can live here (renamed export) instead of a fourth copy.

## 5. Jev-ready adapter: `visualizer/tools/classify-presets.mjs` (PROPOSED, dev-time only)

### 5.1 Behaviour

```text
node tools/classify-presets.mjs --collection "<abs>/avs presets"            # default: offline only
node tools/classify-presets.mjs --collection ... --jev-dry-run             # print exact payloads + token/cost estimate, send nothing
node tools/classify-presets.mjs --collection ... --jev --send              # needs TYPESAFE_API_KEY in the environment
        [--no-names] [--all] [--limit N] [--concurrency 4] [--review-csv <path>]
```

- **Default is offline and deterministic.** It parses each catalog entry's file
  (verifying size and SHA-256 as `check-mpc-catalog.mjs` already does), runs
  `classifyComposition`, and writes `catalog/categories.json`. No key, no network.
- **Jev is opt-in twice**: `--jev` selects the path; `--send` performs it. Without
  `--send` it prints the payloads it *would* send (the owner reads them first).
- **The key** is read only from `process.env.TYPESAFE_API_KEY` (or from the output of a
  command named in `TYPESAFE_API_KEY_COMMAND`, argv-split, no shell, so a password
  manager can supply it). It is never accepted as a flag, never written to any file
  or log, and error text is scrubbed of it. If neither is set, `--send` exits with a
  message and the offline result is still written.
- **Transport** is `fetch` to `https://api.typesafe.ai/v1/systemone` (base URL
  overridable only to `https` or loopback for the tests), `redirect: 'error'`, 1 MiB
  response cap, a timeout of 10 s, at most one retry on 429/5xx with jittered backoff,
  a JSON `content-type` required. A non-JSON or HTML body is "backend unavailable",
  never an answer. No dependency is added: the REST contract is small and the
  harness already implements the same guards in Python.
- **Concurrency 4**, far under the 1,200 requests/min limit.
- **Writes only new files** in `catalog/`: `categories.json`,
  `categories.jev-cache.jsonl`, `categories.review.csv`. It never opens
  `presets.json`, `parser-validation.json`, ratings, setups or settings for writing,
  refuses a `--collection` that lacks `catalog/presets.json`, writes atomically
  (temp file then rename), and never modifies `categories.overrides.json`.
- Only `kind: 'avs'` entries are classified; NERV manifests are skipped.

### 5.2 What is sent, and what is never sent

Per preset, one request with a `state` object of about 150-250 tokens:

```json
{
  "title": "<display name, ' [N stars]' stripped, control characters removed, <= 80 chars>",
  "effects": [ {"name": "SuperScope", "count": 3, "detail": "2 line-mode, 1 dot-mode"}, {"name": "Movement", "count": 2, "detail": "scripted"}, {"name": "Blur", "count": 1} ],
  "structure": { "components": 14, "effect_lists": 2, "max_depth": 1, "beat_render_lists": 0 },
  "unrunnable_effects": ["Oscilloscope Star"]
}
```

Never sent: `sha256`, `canonical_path`, package or source ids, occurrence or original
paths, file names, byte sizes, ratings, `notWorking` marks, setups, settings, any
absolute or drive path, any EEL source code, bitmap or dependency file names, song or
playback information, machine or user identifiers. `--no-names` drops `title`.
The allowlist is enforced by constructing the object from a fixed field list, and a
test asserts by scanning the serialised body (section 9). The owner reading the
`--jev-dry-run` output is the consent step. Preset names come from a public-web
collection but are treated as private local library data, as `AGENTS.md` requires.

### 5.3 Question wording (PROPOSED; exact text to ship)

Independent questions over the same state go in one request.

**`style` (Choice, 18 options, includes the no-match `general_mix`)**

Instructions: "Which visual style family best describes this Winamp AVS preset? You
can only see its effect list, its structure and its title, not its rendered output.
The effect list is the main evidence; the title breaks ties and is often only a
poetic name. Prefer the family of the most distinctive effect. Movement, Dynamic
Movement, Blur, Fade Out and Comment appear in most presets and are not evidence of
style by themselves. Choose `general_mix` when no family clearly fits."

Criteria (each `{what, not_for}` per TypeSafe's guidance to add `not_for` where labels
collide; abbreviated here, shipped in full in the tool):

| Key | what | not_for |
| --- | --- | --- |
| `scope_classic` | Audio waveform or spectrum drawn as one or two lines: Simple, Timescope, a line-mode SuperScope with little else. | Many-shape figures (`scope_geometry`); particles. |
| `scope_geometry` | Three or more SuperScopes or scripted shapes forming figures, lattices or Lissajous curves. | A single wave line. |
| `rings_stars` | Ring, Oscilloscope Star, Rotating Stars, Bass Spin as the main visual. | Starfield flying-through-space (`starfield`). |
| `particles` | Moving Particle, Dot Grid, Dot Fountain, dot-mode SuperScope, Texer sprites. | Perspective or z-depth (`perspective_3d`). |
| `starfield` | Starfield effect as the identity. | Dots on a grid. |
| `perspective_3d` | Dot Plane, z-assigning SuperScope, Texer II depth, 3D or triangle APE. | Flat zoom tunnels. |
| `tunnel_zoom` | Movement or Dynamic Movement with Fade Out or Blur, Blitter Feedback, video-delay echo, where feedback is the look. | A preset with a distinctive render effect. |
| `spin_rotate` | Roto Blitter or Bass Spin dominate. | Kaleidoscopes. |
| `kaleido_mirror` | Mirror effect or six-way kaleidoscope movement. | Plain symmetry from a SuperScope. |
| `water_ripple` | Water or Water Bump. | Bump lighting alone. |
| `bump_relief` | Bump or Convolution as the look. | Water ripples. |
| `color_grade` | Color Map, Dynamic Color Modifier, Unique Tone, Color Fade as the look. | Presets where colour effects merely accompany a renderer. |
| `glitch_digital` | Interferences, Grain, Mosaic, Scatter, Interleave, Color Reduction. | Beat strobes. |
| `beat_flash` | OnBeat Clear, Custom BPM, beat-render lists, inversion flashes. | Smooth motion. |
| `text_image` | Text, Picture, AVI. | - |
| `multi_scene` | Very many components or effect lists with no dominant style. | A large preset with an obvious identity. |
| `minimal` | Three or fewer components; a test or fragment. | - |
| `general_mix` | Nothing clearly fits. | - |

**`intensity` (Score, five levels; OFF unless `--intensity`)**

Instructions: "How intense is this preset likely to look when playing music? Judge
only from the effect list and structure." Levels (concrete situations, each standing
alone per the docs): 0 "Calm: slow drifting motion, no beat-triggered effects";
1 "Gentle: smooth motion with at most subtle beat pulses"; 2 "Moderate: clearly
audio-reactive with steady motion"; 3 "Energetic: strong beat-driven movement or
frequent flashes"; 4 "Aggressive: strobing, hard flashes or rapid distortion".

**No Noul is used for classification** (a multi-class label set is a Choice). One
optional Noul, `looks_like_test_fragment`, may be added to demote fragments; the
deterministic `minimal` rule already covers 7 % and is enough.

### 5.4 Acceptance policy (starting values, calibrate on the gold set)

Let `p` be Jev's probability for its chosen option and `q` the second-highest. With
K = 18, `confidence >= 0.5` corresponds to `p >= 0.53`, so `p` and margin are used
directly.

- Candidates: `mixed` or `k < 0.28` (about 700 presets, about $0.03 in tokens), or all
  with `--all` (about 3,400 requests, about 5-6 minutes at concurrency 4, about $0.15-0.20 at
  1,000-1,300 input tokens each).
- Accept Jev's category when `p >= 0.55` and `p - q >= 0.20` and it is not
  `general_mix`; record source `j`, keep the deterministic category as tag if it
  differs and scored well.
- If Jev agrees with the deterministic primary: keep it, source `sj`, raise `k`.
- If deterministic `k >= 0.6` and Jev disagrees: keep deterministic, write a conflict
  row to the review CSV. Jev never overrides a confident structural decision.
- Any failure, refusal to validate, low `p`: keep the deterministic result. A
  malformed response (wrong type, choice not among options, probabilities not summing
  near 1, choice not the argmax) discards that preset's Jev answer, as the harness's
  `parse_answers` does.
- Owner overrides (`categories.overrides.json`, new file, hash-keyed) always win and
  are never rewritten.

### 5.5 Caching, reproducibility, cost

Cache key: SHA-256 of `model + promptVersion + taxonomyVersion + canonical state JSON`.
The cache stores fingerprints and answers only (no titles, no request bodies), one
line per call, in `catalog/categories.jev-cache.jsonl`. Reruns are free. A model or
prompt bump changes the key, so old answers are ignored, not mixed. Use the pinned
model `jev-1.13.0`; record `model` from each response in `categories.json`.
Cost and time at the documented price and observed latency are negligible
($0.03-0.20 and 1-6 minutes); the real costs are privacy and the owner's review time.

### 5.6 Review path

`categories.review.csv` lists, sorted worst first: id-free rows `row, title, deterministic
category, k, Jev category, p, conflict` for `k < 0.28`, `mixed`, and every
disagreement. The owner edits a `category` column and saves it as
`categories.overrides.json` via a second mode `--import-review`. Overrides are keyed by
hash and carry source `o`.

## 6. How the taxonomy feeds the master AVS folder (PROPOSED contract)

### 6.1 `catalog/categories.json` schema (version 1)

Location: `visualizer/avs presets/catalog/categories.json` (private, gitignored with
the collection; a **new** file next to `presets.json`; `presets.json` is never edited).

```json
{
  "format": "aaavs-categories", "version": 1,
  "taxonomy": { "id": "aaavs-style", "version": 1 },
  "generated": "2026-09-30T00:00:00Z",
  "generator": { "tool": "classify-presets", "method": "structure-v1", "jev": null },
  "catalogSha": "<sha256 over the sorted preset hashes it covers>",
  "entries": {
    "<64-hex sha256>": { "c": "particles", "t": ["glitch-digital"], "e": "driving", "b": 3, "f": "full", "a": "Some Author", "s": "s", "k": 0.62 }
  }
}
```

`c` category id, `t` up to 2 tags, `e` energy, `b` busyness 1-5, `f` fidelity, `a`
optional author, `s` source (`s` structure, `j` Jev, `sj` both, `o` owner), `k` 0-1.
With Jev, `generator.jev` is `{"model":"jev-1.13.0","promptVersion":1}`. Size: about
110 bytes per entry, roughly 400 KB for 3,409 entries; `MAX_CATALOG_BYTES` is 32 MiB
and `MAX_CATALOG_ENTRIES` 50,000.

### 6.2 Loading rules

A new `src/avs/preset-categories.ts` (so the hub file `local-collection.ts` need not
change) exports `fetchLocalCategories(baseUri)` and a pure `parseCategories(json,
catalog)`:

- URL is built exactly like the catalog's: `new URL('./avs presets/catalog/categories.json', document.baseURI)`,
  read through `boundedJson`. Any failure (404, timeout, parse) returns `null` and the
  browser shows the flat catalog plus non-AI folders; it never blocks startup, never
  logs a path, and never retries in a loop.
- Validate as strictly as `parseLocalAvsCatalog`: `format`/`version`/taxonomy version
  must match or the file is ignored; keys must match `^[0-9a-f]{64}$` (rejects
  `__proto__`); unknown category ids drop the entry; strings are length-capped;
  entries not in the loaded catalog are ignored; missing entries get category
  `unclassified` so a stale file degrades to "Unsorted", not an error. Objects are
  built with `Object.create(null)` or a `Map`.
- The result is joined to the catalog by hash into a read-only `Map<string, PresetTaxon>`;
  the catalog objects stay frozen and unchanged.

### 6.3 Folder tree, search, sort (what the browser needs from this document)

- Computed folders under **Master AVS**: **By style** (family, category), **By energy**
  and **By busyness**, **By author** (`a`), **By rating** and **Unsorted**. Source-pack
  folders come from `presets.json` `occurrences[].package_id`, which the loader does
  not expose today; that is a browser-side addition, not part of `categories.json`.
- Search text for a row is title + category label + tag labels + author, so
  "kaleidoscope" finds `kaleido-mirror` members with unrelated titles.
- Sort keys added: category, energy, busyness, fidelity (partial last), author.
- **Play folder** = the members of a computed or user folder, filtered by the existing
  `eligiblePresets` rules (minimum rating, not-working, session failures, parse
  errors, and optionally `f: partial`). Categories are read-only computed folders;
  user-made folders remain setups (`setups.json`), which already survive renames.

### 6.4 Where the file does and does not ship

Staging preserves an installed `catalog/` and copies it only on a fresh install
(`stage-aaavs.ps1`); the release package carries a 16-entry NERV-only catalog
(`package-release.py`). `categories.json` is therefore private by default and
absent from public artifacts; both hosts must behave correctly without it. Because
hashes are stable across rating renames, an installed copy stays valid; a re-run of
the tool is needed only after adding presets.

## 7. HUD manifest screening (deterministic first)

`visualizer/tools/check-hud-manifest-roles.mjs` (PROPOSED, CPU only, read-only over
`assets/hud-kits/*/manifest.json`, prints counts, never rewrites manifests):

- **Role families** by token (`viewport`, `panel`, `meter|gauge|vitality|health`,
  `counter|score|timer|countdown`, `radar|minimap`, `reticle|crosshair|pipper`,
  `spectr|graph`, `selector`, ...) versus the driver vocabulary
  (`background-*`, `*-dock`, `*-meter`, `*-clock`, `*-sweep`...). MEASURED baseline:
  462 of 471 viewport-role elements map to a `background-*` driver and 476 of 523
  panel-role elements to dock/anchor drivers; the mismatches cluster in the
  90-element "other" family and in roles like `health`/`vitality` mapped to an audio
  RMS driver (which may be an intended design mapping rather than a defect).
- **Geometry sanity** from `normalizedRect`: a meter, gauge, counter or timer role
  covering more than half the frame (2 found), a viewport under 20 % (3 found).
- **Vocabulary drift**: 250 roles, 160 singletons; propose canonical role families
  and report unmapped singletons.
- Output is a ranked report, not an auto-fix. Jev's optional part is one Noul per
  flagged element ("The driver X is a sensible audio mapping for an on-screen element
  described as Y") to order the residual few hundred conflicts; the manifests are
  local research kits, so this is a separate owner consent from preset names.
  Screening 1,795 elements is about 300k tokens (about a cent) and does not need
  Jev to be useful.

## 8. Jev in this project's build workflow: brief and honest

The external Jev harness (`plugins/jev-harness` in its own repository) is a Claude Code plugin
whose specs (`gate.bash`, `gate.write`, `check.complete`, `check.stuck`) ship in
**shadow mode**. Jev can only return "no opinion", "ask", a fixed injection or a
proof-backed block; **deny comes only from its deterministic layer**. It needs a key
for every Jev question and this machine has none, so today only its deterministic
regexes could run, and they overlap what the AGENTS.md rules and our checks already
enforce (no golden re-recording, no private paths in public docs, no touching
`avs presets/**`).

Realistic uses **if the owner later supplies a key**, in priority order:

1. `judge --pack claim-vs-source` on review findings: state is a claim plus a quoted
   source excerpt, so it is verification of "does the cited code line say this",
   the pattern the Jev docs call a citation check. It can only compare text it is
   given. Worth trying on the two planned review rounds; low cost.
2. `gate.write` in shadow to flag secrets or private-path leaks in files headed for
   public docs. A pure regex/grep check in `tools/` does this without a key and is
   preferable.
3. Choice routing of review findings by owner-relevance (implement/defer/reject).
   Low value: the owner and the agent already triage; misroutes are costly.

**Not worth it without a key**, and only marginal with one. Nothing in this design
depends on it, and no CI or check may call an external API.

## 9. CPU test plan (synthetic parsed presets; no collection, GPU or network)

All new checks are `visualizer/tools/check-*.mjs`, esbuild-bundled like the others,
and are added to `npm run check` (and `check:player`) only after they pass.

**`check-preset-taxonomy.mjs`** (classifier)
1. **Integrity:** ids unique, 12-20 categories, every category has label, family,
   definition; every weight-table key is a known built-in id or exported APE
   constant; the tie-break order equals the taxonomy order.
2. **Table-driven synthetic compositions** (built directly as `PresetComposition`
   and also as ASTs through `serializeAvsPreset`/`parseAvsPreset` with hand-built
   component records): Starfield+Blur+Movement -> `starfield`; Water+Movement ->
   `water-ripple`; Mirror -> `kaleido-mirror`; Oscilloscope Star -> `rings-stars` with
   `f: partial`; five line SuperScopes -> `scope-geometry`; one z-assigning SuperScope
   -> `perspective-3d`; OnBeat Clear+beat-render list -> `beat-flash`; Text -> `text-image`;
   a one-component preset -> `minimal`; nothing distinctive -> `mixed`.
3. **Ubiquitous-engine invariance:** for 200 seeded random compositions, adding any
   number of Movement/Dynamic Movement/Blur/Fade Out/Comment/Set Render Mode components
   never changes a decisive (`k >= 0.6`, non-tunnel) primary.
4. **Boundaries:** components 3/4 and 44/45; lists 7/8; top score just below and above
   2.0 and 6.0.
5. **Determinism and order independence:** permuting components, flattening or nesting
   lists, and running twice give identical output apart from the structure counters.
6. **Robustness:** unknown APE id, negative or huge unknown `effectId`, empty preset,
   `decoded: false` payloads: no throw; unknown effects affect only `f`.
7. **Confidence:** `k` in [0,1]; adding decisive evidence never lowers the primary's
   score; `minimal` is exactly 0.9.
8. **Titles:** `sanitizeTitle` strips ` [N stars]`, control characters and clamps length;
   `authorOf` rejects numeric prefixes, style/effect words, over-long prefixes and
   names with no separator, and handles multiple separators.
9. **Optional corpus bands** (skipped when the collection is absent): no category above
   20 % or below 1 %, `mixed` under 4 %, parse errors at most 5, partial fidelity
   between 10 % and 25 %. Bands, never exact counts, so catalog growth does not break
   the check.

**`check-preset-categories.mjs`** (loader): missing file -> `null`; wrong
`format`/`version`/taxonomy version -> ignored; bad hex, `__proto__`, oversize string,
over 50,000 entries, unknown category -> rejected or dropped without throwing;
entries absent from the catalog ignored; catalog entries absent from the file become
`unclassified`; tags de-duplicated and capped at 2; catalog objects unchanged and
frozen.

**`check-classify-presets.mjs`** (adapter, with an injected `fetch`, temp collection,
no server): no key -> `fetch` never called and the offline file is written; key set
but no `--send` -> dry run only; **payload allowlist** (serialised bodies contain none
of `sha256`, `canonical_path`, `presets/unique`, `rating`, `notWorking`, a drive
letter, a backslash, `package`, or any EEL text, with hostile titles and paths in the
fixture); `--no-names` drops the title; sentinel key never appears in stdout, stderr,
any written file or any thrown message; 429, 5xx, HTML, wrong type, non-argmax choice
and non-summing probabilities all fall back per preset with a normal exit; acceptance
policy table (agree, disagree with confident structure, low `p`, `general_mix`); cache
hit prevents a second call and a model or prompt bump invalidates it; **only the three
new files are created** (every other file's hash and mtime in the temp collection is
unchanged; `presets.json` byte-identical); atomic write; `categories.overrides.json`
is never rewritten and always wins; refuses a directory without `catalog/presets.json`.

**Not verifiable on CPU and deferred:** how the tree and Play folder look and feel;
real Jev accuracy; latency against the real service; the owner-labelled gold set
(below).

**Gold set (owner task, the gate for Jev):** the tool emits a stratified sample of 150
presets (about 8 per category, weighted to low-`k`) as a CSV of title plus effect
summary with an empty `category` column. Owner labelling takes roughly 20-30 minutes.
Report top-1 accuracy and top-2 coverage for structure alone and for structure+Jev.
Enable Jev output only if it improves top-1 by at least 5 points **and** does not
reduce agreement on the confident (`k >= 0.6`) slice; otherwise keep it off and delete
the cache. Until then Jev results are labelled `unvalidated` and never override.

## 10. Owner decisions needed to enable the live Jev path

Defaults are the recommended answer.

1. **Use Jev at all?** Default **no**; ship the deterministic taxonomy, judge Jev
   later on the gold set.
2. **Obtain a TypeSafe account and key?** Terms, data-processing and retention apply;
   the vendor states no retention period and offers zero retention only on enterprise
   plans. The key never enters the repo, chat, config or logs; the owner runs the tool
   in their own shell. No agent handles the key or runs the `--send` path.
3. **Are preset display names allowed to leave the machine?** Default **yes but only
   after reading `--jev-dry-run`**; otherwise `--no-names` (composition only, lower
   accuracy).
4. **Key supply:** environment variable at run time, or a key command from a password
   manager. Never a flag or a file.
5. **Pin `jev-1.13.0` and the acceptance thresholds in section 5.4?** Default yes;
   thresholds are revisited after the gold set.
6. **Gold-set labelling:** will the owner spend about 30 minutes? Without it the
   Jev output stays advisory.
7. **Intensity Score:** default off; deterministic `e` is used for mood shuffle.
8. **HUD manifest screening by Jev:** default deterministic only.
9. **Publishing:** `categories.json`, the cache and overrides stay private; a
   NERV/HUD pack category table authored by us may ship as static data.
10. **Model bumps:** re-run and re-gate on any `jev-latest` change, never silently.

## 11. Files and shared edits

New files owned by this stream: `visualizer/src/avs/preset-taxonomy.ts`,
`visualizer/src/avs/preset-categories.ts`, `visualizer/tools/classify-presets.mjs`,
`visualizer/tools/check-preset-taxonomy.mjs`, `visualizer/tools/check-preset-categories.mjs`,
`visualizer/tools/check-classify-presets.mjs`, and optionally
`visualizer/tools/check-hud-manifest-roles.mjs`. Generated, private, never committed:
`visualizer/avs presets/catalog/categories.json`, `categories.jev-cache.jsonl`,
`categories.review.csv`, `categories.overrides.json`.

Shared edits needed elsewhere (not made here): `src/mpc-host.ts` calls
`fetchLocalCategories` after the catalog and passes the map to the manager;
`src/mpc-management.ts` renders the folders, search text, sort keys and Play folder
(defined in `PRESET-BROWSER-V2.md`); `package.json` adds the three checks to `check`
and `check:player`; `tools/aaavs-mirror.json` lists the new source, tool and check
files so stock AAAVS receives them; `docs/AAAVS-SHARED-DEVELOPMENT.md` gains one
table row. No change to `AAAVSView.cpp`, `AAAVSLibrary.h` or the standalone library
server is required.

## 12. Non-goals and risks

- Not a quality ranking; ratings stay the owner's.
- Not a claim that the categories look right: only structure-derived and unvalidated
  visually. The 30 % title-keyword agreement is a sanity signal, not accuracy.
- The CPU registry defines "partial"; if the GPU lane diverges from it the badge could
  mislead; the runtime `unsupported` counter remains the authority.
- A tool that can call a paid third-party API must stay unreachable from tests and
  from any default command; the two-flag design and the fixed allowlist are the
  controls.
- Jev semantics may change under `jev-latest`; pinning and the cache key manage this.
