# Stock AAAVS and MPC-HC: shared development

The visualizer is shared source with two playback adapters. MPC-HC supplies native
decoding and library persistence. Stock AAAVS supplies browser media playback and
a local library service. Both run `src/mpc-host.ts`, the same workers, Auto
director, transition compositor, management panels and setup clock. The `mpc-`
module names remain for compatibility; they do not imply a second browser copy.

## What is mirrored

| Feature | MPC-HC | Stock AAAVS |
| --- | --- | --- |
| Historical AVS catalog and external bitmaps | Embedded player | Shared Player page |
| Full-band stereo analysis and revised tempo estimator | Native PCM adapter | Streaming browser PCM adapter |
| Previous/next, Shuffle and Auto | Native toolbar/menu | Player toolbar |
| AVS transition styles, durations and manual/Auto choices | Native options | Player options |
| Ratings, filename/date changes, not-working marks | Native filesystem service | Loopback library service |
| Minimum shuffle rating and failure exclusions | Shared selection code | Shared selection code |
| Preset Manager / Setup Builder | Ctrl+F6 / Ctrl+F7 | Ctrl+F6 / Ctrl+F7 |
| Rate down/up / mark not working | F6 / F7 / F8 | F6 / F7 / F8 |
| Sixteen NERV scenes and repeatable scene timing | Embedded player | Shared Player page |
| AVS editor, projector, MIDI/OSC, offline rendering | Not a native-player UI feature | Existing Studio page retained |
| Song scan, structural cues, generic HUD component system | Planned shared work | Planned shared work |

The new browser page is `standalone.html`. The Studio at `index.html` links to it;
the Player links back. This is a new mode within AAAVS, not a replacement for its
editor or offline workflow. The existing AVS editor/projector/offline registry
filters out NERV manifests because those surfaces still use an AVS-only executor.
NERV offline rendering and a shared HUD offline evaluator remain implementation
work. A mirrored file is not proof that every studio surface supports it.

## Local use

In a stock AAAVS checkout, run the existing build and server commands:

```sh
npm run build
npm run serve
```

Open the server's Studio page and choose **Player · presets & setups**. Select
an audio file in the Player. Browser decoding support determines which formats
can play there; native DirectShow codec support is specific to MPC-HC. Audio
stays local. The Player does not upload or rewrite the selected song.

The library service requires the local server. A static-only deployment cannot
rename source files and must report a failed save instead of implying success.
The service accepts bounded same-origin requests over loopback and confines
writes to the local preset collection. Ratings rename the preset while keeping
its content hash stable. Setups and player settings are local to that AAAVS
installation; mirroring source does not overwrite private collections or make
two installations continuously synchronize personal ratings.

Install the public NERV manifest pack into the destination's existing collection
using `tools/install-nerv-presets.mjs`. Its merge preserves previously rated
names and other catalog entries. Do not replace an existing collection with the
source checkout's catalog.

## Repeatable mirror

The source authority is the MPC-HC-AAAVS repository's `visualizer/src/`, the NERV manifests,
and the explicitly listed tools/docs in `tools/aaavs-mirror.json`.
`tools/mirror-aaavs.py` accepts an absolute destination supplied by the operator.
Run these commands from the MPC-HC-AAAVS repository, even when reading this
guide's mirrored copy inside stock AAAVS:

```sh
python tools/mirror-aaavs.py --target <absolute-stock-aaavs-directory>
python tools/mirror-aaavs.py --target <absolute-stock-aaavs-directory> --apply
python tools/mirror-aaavs.py --target <absolute-stock-aaavs-directory> --check
```

The first command previews. The second applies reviewed differences. The third
fails if the destination has drifted. Initial adoption permits only the known
stock source hashes recorded in the manifest. Later updates compare each
destination file with its last mirrored hash. Independent edits stop the mirror;
merge them into shared source first. No force-overwrite option is provided.

Stock-owned package scripts, server integration, Studio navigation and one
mixed-catalog check receive small idempotent additions. Existing scripts,
studio entrypoints, asset banks, package dependencies and render baselines stay
under stock ownership. A changed integration point stops for review.

Local bookkeeping and content-addressed original-file backups are ignored by
Git. The tool never deletes destination files or copies private presets, media,
history, local configuration, build products or another checkout's Git metadata.
Interrupted applications retain original-file backups; rerun the preview and
resolve any reported conflict before continuing. Source deletions require a
separately reviewed destination change.

## Future work rule

An audio, preset, transition or timing feature belongs in shared visualizer
source first. Add host capabilities through adapters, not a fork of the driver
logic. Mirror it, run both hosts' CPU checks, and build both entrypoints before
describing it as available in both apps. Keep native window/menu/codec behavior
inside MPC-HC and browser media/storage behavior inside the standalone adapter.

The shared roadmap is [song analysis and HUD drivers](SONG-ANALYSIS-AND-HUD-DRIVERS.md)
and [HUD animation beds](HUD-ANIMATION-BEDS.md). The next common milestone is a
NERV countdown, cumulative counter and boundary transition driven by a versioned
cue plan. Exact timing, confidence, seek/repeat behavior and endpoint fallbacks
are shared. Five-minute scan chunks must never become artificial scene endings.

## Validation

- Fork: normal `npm run check`, standalone adapter/service/catalog checks and
  `npm run build:player` from `visualizer/`.
- Stock: normal `npm run check` (including its frozen AVS corpus gate),
  `npm run build`, and the mirror `--check`.
- Preserve existing golden hashes. A mismatch is a regression to investigate;
  never record new baselines to make this integration pass.
- Library fixtures verify filenames, modification times, content identity,
  invalid requests, confinement and failed transactions on temporary data.
- PCM fixtures verify stereo separation, packet timestamps, discontinuities,
  bounded queues and unsupported conditions without playing audio.

These are CPU/source/build gates. Actual browser decoding, audible timing,
WebGPU presentation, fullscreen and the visual quality of HUD beds require
separate runtime acceptance. They are intentionally deferred while the GPU is
reserved for other work.
