# mpc-hc-aaavs preview release notes

This preview combines MPC-HC audio playback with an embedded AAAVS visualizer. The public package contains 16 NERV scene presets. Historical AVS and bitmap collections remain external.

## Changes

- Product, executable, and launcher naming is now **mpc-hc-aaavs**. Existing installed catalogs and preset identities are retained.
- Upstream automatic update checks are disabled; the manual update command explains how to obtain a future fork build.
- **F8** marks the displayed preset as not working; Preset Manager can clear the mark. Marked presets are omitted from automatic selection.
- **Shuffle minimum rating** limits random selection to All, 1+, 2+, 3+, 4+, or 5 stars. The threshold is saved with preferences and setups.
- **F6/F7** lower or raise ratings. A native transaction updates the filename and modification date, with rollback if the catalog cannot be saved.
- **Ctrl+F6/Ctrl+F7** open Preset Manager and Setup Builder. Setups preserve preset identity across filename changes.
- Adaptive musical Auto switching, full-band audio handoff, AVS-style transitions, and fixed song-clock scene timing are included.
- The NERV pack can transition between any scenes at repeatable timing boundaries, with deterministic shuffle and session scene choices across seek/repeat.
- Mixed AVS/NERV catalogs load correctly; a failed initial preset does not dismiss an open management panel behind artwork.
- Public documentation and packaging omit machine-specific paths, private track names, personal settings, playback history, and private preset collections.

## Requirements and limitations

The shared Player and MPC host now support local HUD manifests, a folder browser with per-pack playback defaults, render quality and pixel scaling controls, musical fade timing, and transition styles 16–32. HUD-to-NERV song-clock boundaries cut; other supported scene pairs reconstruct their fades. End/hit anchors and quantized manual queues remain follow-ups. Timing v2 and transition indices 16+ are forward-only: older builds can reject or strip these settings when resaving. Back up personal settings before opening them with an older build.

The local HUD generator covers every supplied source and uses neutral procedural names. Generated banks and real-title overlays are excluded from public artifacts. See [HUD packs](HUD-PACKS.md) for the current source, fidelity and runtime validation boundaries.

Windows x64; installed DirectShow codecs; Microsoft Edge WebView2 Runtime; Microsoft DirectX End-User Runtime. This is a Release Lite preview, not a self-contained codec distribution. Keep the unpacked folder writable for ratings and setup saves.

Native compilation and CPU tests cover audio handoff, tempo/phrase scheduling, navigation, transitions, catalog validation, storage rollback, setup persistence, scene timing, and worker lifecycle. They do not establish live audio latency, every legacy preset's fidelity, browser focus, DPI/fullscreen behavior, or GPU performance. Complete the live checks in the [release guide](RELEASING.md) before promoting a candidate to a general release.
