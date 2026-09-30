# mpc-hc-aaavs agent guide

MPC-HC fork with an embedded AAAVS visualizer (WebView2). Product name:
mpc-hc-aaavs. Keep the current repository URL. Work on `aaavs-integration`;
`main` is the pull-request base.

## What we are building

One shared Player runs classic AVS presets and **shows**: authored, song-aware
HUD music videos in the style of the NERV and P(doom) reference videos.

A show is one themed universe (palette, type voices, panel kit) with a set of
full-screen plates. Every plate must:

- be one recognizable instrument of that universe and a real sound visualizer:
  scopes trace the waveform, analysers show the spectrum, countdowns run on the
  bar grid, alarms fire on the snares;
- tell a small story across its section: a vote resolves, a countdown hits
  zero on the drop, a sync ratio climbs through the build;
- be dense and crafted: title cards, diegetic and bilingual labels, a header
  with plate number, bar, beat, BPM and timecode, tickers, post-processing
  (bloom, scanlines, chromatic aberration), laid out for 1080p and sharp at 4K.

A song map drives the show: beats, downbeats, sections, drum onsets, energy,
mel and chroma from a background scan of the loaded file, plus live PCM. The
director assigns plates by section role (intro, groove, break, build, drop,
outro), hard-cuts on drop downbeats and uses look-ahead so each plate's story
resolves on a musical boundary.

Quality over count. One finished show beats hundreds of generic scenes. Do not
bulk-generate HUD presets from reference images; the auto-generated HUD bank is
local legacy, not a direction to expand.

## References

- NERV: bizarro/evangelion (MIT, see `THIRD-PARTY-NERV.txt`). Local checkout:
  `.tmp/reference-evangelion` (untracked). Read its `docs/TREATMENT.md`
  (concept, style bible, plate briefs) and `docs/ENGINE.md` before touching
  NERV. Port its engine, kit and plates faithfully instead of reinterpreting
  them, and keep the attribution and MIT notice.
- P(doom): mexicat/pdoom-video (MIT), the parent engine and the lyric and
  kinetic-type reference. Local checkout: `.tmp/reference-pdoom` (untracked).
- Fonts: bundle the OFL fonts the references use (Archivo, Cormorant Garamond,
  IBM Plex Mono, the stroke fonts) with their licenses. System fonts are not
  the design.
- Plans: `docs/SONG-ANALYSIS-AND-HUD-DRIVERS.md` (the song map; build it before
  adding shows), `docs/HUD-ANIMATION-BEDS.md`, `docs/MULTI-VIEW.md` (the basis of
  control-wall plates).

## Legal line

Shows borrow a genre's UI language: colours, layouts, panel shapes, instrument
types, captions. Never ship logos, wordmarks, footage, ripped game or film
assets, or copyrighted music. Real franchise titles appear only through the
private local title overlay; public names stay neutral. Anything derived from
private reference images stays local and git-ignored.

## Architecture

- Shared source lives in `visualizer/src/`. The MPC and browser hosts differ
  only through adapters for media transport and persistence; never duplicate
  behaviour per host.
- Every frame is a deterministic function of media time, seed and audio. No
  wall clock or unseeded randomness in visuals; a seek rebuilds from the
  absolute clock.
- Render in workers. WebGL2 and WebGPU are available to shows.
- Preserve the stock Studio, projector and offline renderer. Show, NERV or HUD
  support in the Player does not imply support in the AVS-only offline path.

## Stock AAAVS mirror

Shared visualizer changes also target stock AAAVS. Read
`docs/AAAVS-SHARED-DEVELOPMENT.md` before changing audio, presets, transitions,
management or timing. `tools/aaavs-mirror.json` defines the mirror surface.

```sh
python tools/mirror-aaavs.py --target <absolute-stock-aaavs-directory>          # preview
python tools/mirror-aaavs.py --target <absolute-stock-aaavs-directory> --check  # drift gate
```

Preview and check are always fine. `--apply` to the owner's stock checkout, and
any push, need the owner's explicit go-ahead. Stop on conflicts and merge
independent edits into shared source first.

## Private data

Never overwrite private catalogs, ratings, setups, assets or independent edits;
installers merge and preserve bytes and timestamps. Commits, the mirror and
release packages exclude private paths, media, local presets, generated HUD
banks, title overlays, history and personal configuration.
`tools/check-release-package.py` gates packaging.

## Verification

- From `visualizer/`: `npm run check` (full CPU suite with typecheck and Player
  checks), `npm run build` (MPC host) and `npm run build:player` (standalone
  Player). Native builds: `docs/BUILDING.md`.
- Original AVS golden hashes are the regression baseline. Never re-record them
  to hide a change.
- Visual work is judged by looking. Render stills or contact sheets at 1080p
  (and 4K for sharpness), compare them with the reference frames, and look at
  them before claiming progress. Passing CPU checks is not visual acceptance.
- Performance claims need numbers from `visualizer/tools/bench-shows.mjs` (per-stage timing, A/B with `--compare`); `docs/PERFORMANCE.md` explains the
  instrumentation, the baseline and what a software-GL run cannot tell you. Stage timing is off by default and must never change a rendered pixel.
- Report proposed features, CPU checks, builds, rendered stills and the owner's
  live acceptance as separate states. Never claim what was not observed.
