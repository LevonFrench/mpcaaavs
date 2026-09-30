# Cloud session handoff

Start here if you are a cloud session working on this repository. Read
`AGENTS.md` first: it defines the product direction (authored, song-aware HUD
"shows" in the style of the NERV and P(doom) reference videos) and the rules.

## Working rules for this session

- Fan out: use subagents on the cheapest model that can do the job (Haiku for
  mechanical edits, searches and test runs; Sonnet for ordinary code; reserve the
  largest model for architecture and visual judgement).
- Work only on the `cloud/*` branches below. Never push to `aaavs-integration`
  or `main`, never open pull requests, never force-push. The owner merges
  locally after a native Windows build.
- Private material (game-derived assets, reference videos, the HUD research
  wiki, title overlays) lives only on the owner's machine. It is not in this
  repository and must never be added. Public names stay neutral.
- Report each task as: branch and SHA, what works, exact commands with
  pass/fail, and what is unverified.

## Branches

| Branch | State |
| --- | --- |
| `cloud/multiview-repairs` | Done. Ten Multiview defects fixed with regression checks; CPU suite and both builds pass. The `src/mpc-hc/AAAVSView.cpp` change is uncompiled (Windows only). Leave it alone. |
| `cloud/nerv-show-engine` | Work in progress, stopped mid phase 1. Engine (`visualizer/src/show/`), all 16 plates (`visualizer/src/shows/nerv/`), OFL fonts (`visualizer/show-assets/fonts/`), reference fixture (`visualizer/tools/fixtures/nerv-reference/`) and a still renderer (`visualizer/tools/render-show-stills.mjs`) are ported but unverified: typecheck, rendering and host wiring have not been run. |
| `cloud/song-map` | Work in progress. Shared contract `visualizer/src/song-map/types.ts` plus analyzer kernels, rhythm, sections and a synthetic fixture generator. Not wired into `npm run check`, not verified. |

`visualizer/src/song-map/types.ts` is the shared contract between the engine
and the analyzer. Both branches carry the identical file; change it only in a
way both sides adopt.

## Task 1: finish the NERV show engine (`cloud/nerv-show-engine`)

Goal: a faithful port of https://github.com/bizarro/evangelion (MIT) so AAAVS
renders the same frames as the original video. Clone it and
https://github.com/mexicat/pdoom-video for reference; read evangelion's
`docs/TREATMENT.md` and `docs/ENGINE.md`. Port, do not reinterpret.

1. Get the branch to typecheck and pass `npm run check`, `npm run build` and
   `npm run build:player` (from `visualizer/`).
2. Still renderer: Playwright headless Chromium with software WebGL
   (`--use-angle=swiftshader --enable-unsafe-swiftshader`) renders any plate at
   given song times from the fixture at 1920x1080. Render the upstream app at
   the same times and make side-by-side contact sheets per plate. Look at them
   and iterate until each plate matches. Commit the sheets (small JPGs) under
   `.show-stills/` on this branch only.
3. `planShow(songMap, plates)`: assign plates to any song by section role
   (intro: boot; groove: magi, psycho, radar, harmonics; break: seele, city;
   build: battery, sync; drop: atfield, alert, target, berserk, impact;
   breakdown: city, seele, plug; outro: end), split long sections on 8-bar
   phrases, hard-cut on drop downbeats, and give every plate a window its story
   resolves in. For the fixture it must reproduce upstream's timeline exactly
   (add a check).
4. Live fallback when no song map exists yet: derive the audio sample from the
   live `AvsAudioFrame` and a tempo-only grid.
5. Host: NERV presets (`visualizer/nerv-presets/`) render through the new
   engine in the shared Player and MPC host, behind a setting that defaults to
   the new engine once it passes; keep `visualizer/src/nerv-scenes.ts` as the
   fallback. Keep `visualizer/src/mpc-host.ts` changes small.
6. Determinism: frames are pure functions of media time, seed and song map.

## Task 2: finish the song map (`cloud/song-map`)

Implements `docs/SONG-ANALYSIS-AND-HUD-DRIVERS.md`. Reference semantics:
evangelion's `analysis/analyze.py` and `app/src/engine/audio.ts`.

1. Worker-based, chunked analysis of decoded PCM producing `SongMapJSON` +
   `SongMapBinary`: 100 fps envelopes, tempo and beats, downbeats, kick, snare,
   hat and vocal-proxy onsets, bass pitch, 64-band mel, 12-bin chroma, 11025 Hz
   waveform, sections with roles (intro, groove, break, build, drop, breakdown,
   outro) and energy, honest confidences and an `approximations` list.
2. Progressive delivery with a revision number; cache by track identity and
   `SONG_MAP_VERSION` through the existing persistence adapters.
3. Start the scan when the shared Player opens a file. For the MPC host use the
   PCM it already receives and document what the native bridge must add.
4. `SongMapClock`: sectionAt, nextBoundary, barAt, beatAt, timeOfBeat,
   revision.
5. Synthetic ground-truth fixtures (several tempos incl. 90, 128, 133.33, 174,
   swing, a tempo change, known bass pitches, a full arrangement) with metrics
   wired into `npm run check`: tempo within 1%, beat F-measure, downbeats,
   section boundaries within one bar, role labels. Report throughput and peak
   memory for 5- and 60-minute tracks. Never commit audio.

## Task 3: show asset packs (new branch `cloud/show-asset-packs`, from `aaavs-integration`)

Game-derived art for upcoming shows is extracted on the owner's machine into a
git-ignored `show-assets-private/<pack>/` directory. The public engine needs a
way to use it without shipping it.

1. Define an asset-pack manifest (JSON): pack id, neutral display name, image
   atlases with named regions (sprites, frames, digits, fonts as glyph grids),
   palettes, per-region anchors and nine-slice margins, and animation strips.
2. A loader that reads a pack from a local directory through the existing host
   persistence/transport adapters (browser Player and MPC host), validates it
   strictly, and exposes typed lookups to show plates.
3. Every plate that uses a pack must also draw a procedural stand-in when the
   pack is absent, so the public build works with no private files.
4. Checks for manifest validation, path traversal rejection, missing-pack
   fallback, and that release packaging (`tools/check-release-package.py`,
   `tools/package-release.py`) never includes `show-assets-private/`.

## Task 4: integration branch (after tasks 1 and 2 pass)

Create `cloud/integration` from `aaavs-integration`, merge
`cloud/multiview-repairs`, `cloud/song-map` and `cloud/nerv-show-engine` (and
task 3 if done), resolve conflicts, and run the full `npm run check`,
`npm run build` and `npm run build:player`. Push `cloud/integration` only.
