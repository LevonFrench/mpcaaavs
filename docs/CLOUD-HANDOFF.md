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
| `cloud/nerv-show-engine` | Done (task 1). The engine, the 16 plates, fonts and fixture typecheck and render. Upstream contact sheets for every plate, with pixel metrics, are in `.show-stills/nerv/`. `planShow()` reproduces upstream's timeline (`check-show-plan`). There is a live fallback (`check-show-live`), and NERV presets play on the engine in both hosts with a Canvas2D fallback (`check-show-preset`, `tools/smoke-show-preset.mjs`). Determinism is covered (`check-show-determinism`, `render-show-stills.mjs --determinism`). Native WebView2 playback is not yet verified. |
| `cloud/song-map` | Done (task 2). Worker scan, `SongMapClock`, cache, Player scan on open and the MPC live feed pass `check-song-map` on synthetic fixtures. The native bridge additions are listed in `docs/SONG-MAP.md`. Nothing has been checked on real music. |
| `cloud/show-asset-packs` | Done (task 3). Manifest, loader, path rules, procedural stand-ins and the packaging guard pass `check-asset-packs` and `check-release-package.py`. No host reads packs yet. |
| `cloud/integration` | Task 4. `aaavs-integration` plus the four branches above, with conflicts resolved (the check chain, build entries, `package-release.py` and the `mpc-host.ts` imports). `npm run check`, both builds and `check-release-package.py` pass. |

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

## Task 5: sprite layer and choreographer (new branch `cloud/sprite-layer`, from `cloud/show-asset-packs` once task 3 has a loader)

Implements the engine side of `docs/design/SPRITE-SHOW-KIT.md`. Packs arrive
from a local pipeline as PNG atlases plus a manifest (roles, clips with verb,
per-frame atlas rect, trim offset, foot anchor, duration in 60 Hz ticks, `big`
flag, detached-part rects, optional indexed palettes).

1. Sprite layer in the show engine: atlas upload, nearest-neighbour sampling,
   per-frame anchoring and facing, palette swap via an index texture plus
   palette texture, additive/screen blending for effects, drop shadows off.
2. Pixel scaling policy: integer scaling of the game's native resolution with a
   themed border by default; optional sharp-bilinear shader for non-integer fits.
   Must stay crisp at 1080p and 4K.
3. Clip playback per the kit's retiming rules: loops retime to beat multiples,
   one-shots keep native tick timing and only their start shifts; hitstop
   freezes of 4-12 ticks scaled by onset strength; shake and zoom through post.
4. Motion models from the kit (straight, arc, sine, boomerang, homing, bounce,
   spread, orbit, fall, rise, swoop, hover, pendulum) with musical parameters.
5. Choreographer: maps song-map events to verbs per the kit's grammar, using
   look-ahead so each clip's `big` frame lands exactly on its event; call and
   response between performers; section role picks the plate mode. Sprite shows
   perform and never simulate play: no win, loss, clear or game-over states.
6. HUD-as-meters primitives driven by musical signals: bars with ghost drain,
   segmented meters with MAX flash, digit counters and timers from pack digit
   regions, banners as punctuation.
7. A procedural test pack generated in code (stand-in actors, projectiles,
   effects, HUD) so checks and stills run with no private files; checks that big
   frames land on onsets within one tick and that loops stay beat-locked across
   seeks.
8. Still renderer support: plates using the test pack render at 1080p and 4K.

## Task 7: track metadata for every show (new branch `cloud/track-info`, from `aaavs-integration`)

Owner priority: do this before building more show plates. Shows currently print
placeholders ("UNKNOWN ARTIST", "AUDIO SIGNAL") because no host tells the
visualizer what is playing. Title cards, episode numbers, credits, stage banners
and lyric plates should show the real song, in each show's own typography.

1. **Shared contract** `visualizer/src/track-info.ts`: `TrackInfo` with title,
   artist, album, albumArtist, year, trackNumber, trackTotal, discNumber, genre,
   composer, comment, duration, tagged BPM and key (seed the song map when
   present, never override a confident analysis), cover art (decoded image),
   unsynced lyrics, synced lyrics (timed lines), a `source` per field
   (`tags`, `filename`, `host`, `unknown`) and a revision number. Pure helpers:
   filename fallback parsing ("Artist - Title", "01 Title", "01. Artist - Title"),
   text cleanup (trim, strip "(Official Video)"-style noise optionally),
   typographic forms (upper-case, smart quotes), and a stable "episode number"
   (track number, else a hash-derived 01-99 so it is deterministic per track).
2. **Standalone Player**: read tags from the opened File in a worker with a
   self-written parser (no new dependencies): ID3v2.2/2.3/2.4 (text frames,
   TXXX, APIC, USLT, SYLT, TBPM, TKEY), ID3v1, FLAC/Ogg Vorbis comments and
   METADATA_BLOCK_PICTURE, MP4/M4A `ilst` atoms incl. `covr`, APEv2, WAV
   LIST/INFO and id3 chunks. Also a sidecar `.lrc` next to the file when the host
   can read it. Fuzz-safe: bounded sizes, malformed frames rejected, never
   throws into the player.
3. **MPC host (native, Windows)**: MPC-HC already reads title/author through
   IAMMediaContent (`m_pAMMC` in `src/mpc-hc/MainFrm.cpp`) and finds cover art
   (`src/mpc-hc/CoverArt.cpp`). Add a bridge message from
   `src/mpc-hc/AAAVSView.cpp` to the WebView, sent on file open and on change:
   `{"type":"track","title","artist","album","year","track","genre",
   "duration","path-basename","cover":<data URL or virtual-host URL>}` (JSON
   escaped, size-bounded, no full local paths). Also pass the file's basename so
   the web side can apply the filename fallback. Where MPC exposes more fields
   (IAMMediaContent2, the splitter's IPropertyBag / resource bag for embedded
   pictures), use them. You cannot compile Windows C++: keep the change small,
   mirror existing message code, mark it UNCOMPILED; the owner's machine builds
   and verifies it. The web side must work with whatever subset arrives.
4. **Shows consume it**: pass `TrackInfo` to every show engine and the NERV
   preset dialect (worker protocol field, revisioned; changes mid-play update
   the card on the next plate, never mid-animation). NERV: the boot/title card
   (the "NEON OVERDRIVE" card) shows the song title with the artist, EPISODE:NN
   from the episode number, the end card and credits use artist/album/year, the
   Japanese subtitle line stays a fixed show line unless a tag provides one. Keep
   neutral placeholders only when nothing is known.
5. **Typography hooks for future shows**: title-card primitives that render a
   string in (a) the show's bundled OFL fonts and (b) a pack-provided bitmap font
   (glyph grid region in an asset pack, e.g. a game's own font ripped locally),
   with fitting, tracking and line breaking, and graceful fallback for glyphs the
   bitmap font lacks. Synced lyrics become available to shows as timed lines
   (for later lyric plates).
6. **Privacy**: metadata and cover art stay in memory; never persisted with
   presets or setups, never logged in full, never written into release packages.
7. Checks: parser fixtures for every format (build tiny synthetic files in code),
   malformed/huge frame rejection, filename fallback cases, episode number
   determinism, NERV title card showing given metadata in a still, and the
   placeholder path. `npm run check`, both builds, release-package check.

## Task 4: integration branch (after tasks 1 and 2 pass)

Create `cloud/integration` from `aaavs-integration`, merge
`cloud/multiview-repairs`, `cloud/song-map` and `cloud/nerv-show-engine` (and
task 3 if done), resolve conflicts, and run the full `npm run check`,
`npm run build` and `npm run build:player`. Push `cloud/integration` only.
