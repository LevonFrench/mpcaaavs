# MPC-AAAVS

An experimental fork of [MPC-HC](https://github.com/clsid2/mpc-hc) that places the AAAVS music visualizer in the player's album-art area.

The native toolbar adds **previous preset**, **next preset**, **preset shuffle**, and **Auto** beside the playback controls, using MPC-HC's existing themed icons. Track controls keep their usual behavior. Previous walks actual preset history; shuffle chooses random or sequential selection for both manual and automatic switching. Right-click Auto for phrase and transition options.

**Experimental developer build — not a public binary release.** The Windows x64 Release Lite player now compiles successfully with Visual Studio 2022 v143, MFC/ATL, Windows SDK 10, NASM and Yasm. Local UI checks confirmed embedded visualization, previous/next preset selection, shuffle across the full collection and pause. The embedded renderer bundle, TypeScript checks, navigation tests and native PCM unit test also pass. CI checks source only, not native playback or GPU rendering.

## Musical auto switching and AVS transitions

Auto defaults to adaptive 2–12-bar holds. Fixed 2, 4, 8, and 12 bars are available. The AAAVS transient detector and tempo tracker follow the live playback clock, with analysis-only normalization for quieter audio; switching waits for a trusted tempo and inferred four-beat bar boundary. These are inferred bars, not song-structure or time-signature recognition. Silence, pauses, seeks, and lost tempo lock rearm or hold the scheduler instead of triggering wall-clock switches.

The next preset is prepared one bar early. The current preset continues rendering while it loads; failed candidates are skipped for the session. Manual selections restart the phrase countdown. At most two preset workers are retained.

All 14 classic AVS transition styles are available, plus random and cut. Default is a two-second cross dissolve; optional 1-, 2-, or 4-beat duration uses the tempo at transition start (two-second fallback without a lock). The outgoing preset can keep animating, or freeze to reduce rendering work. Options currently last for the player session. The flash limiter applies after compositing. This is behavioral emulation, not a claim of pixel-identical Winamp output.

See [transition implementation notes](docs/AVS-TRANSITIONS.md) and the [upstream notice](THIRD-PARTY-AVS-TRANSITIONS.txt). Automated checks cover phrase scheduling, synthetic pulse tempo lock, and transition geometry/endpoints; real-song musical alignment remains a listening-test requirement.

## Architecture

- MPC-HC remains responsible for decoding, audio output, seeking and transport.
- A bounded, timestamped PCM tap feeds AAAVS without blocking the audio thread.
- WebView2 embeds the AAAVS worker in the existing artwork rectangle for audio-only media.
- Rendering uses the exact AVS compatibility lane with the presentation flash limiter.
- Video playback retains the original renderer. Failed visualization falls back to artwork.
- The fork uses a separate executable name, settings location and window class.

Broader Windows validation remains: measured audio/visual sync, resize/DPI/fullscreen, video transitions and failure recovery. AudioSwitcher must be enabled; bitstream passthrough provides no PCM. Multichannel analysis currently uses the first two channels.

## Presets

The development installation uses a **3,409-entry local canonical collection**, including the 124 curated picks. Every local catalog file passed size and SHA-256 verification. Three entries have recorded parser failures. Inclusion in the catalog does not imply faithful rendering of every historical effect.

**No preset packs, third-party bitmap packs, fonts or APE binaries are distributed in this repository.** Keep your existing collection local, under `visualizer/avs presets/`, with:

- `catalog/presets.json`, `catalog/parser-validation.json`, `catalog/dependencies.json`
- the catalog's `presets/unique/` files
- the catalog's `dependencies/unique/` files and original notices

The host lazily loads every catalog entry and integrity-checks preset bytes. Package-scoped BMP assets are passed to the existing bitmap resolver. Historical APE binaries are not executed. Missing/unsupported effects, fonts and ambiguous bitmap names may differ from Winamp. Redistribution permissions for the collected packs have not been established; the collection remains Git-ignored.

## Build

Windows x64 is the initial target. Follow [MPC-HC's native build prerequisites](docs/Compilation.md), including Visual Studio 2022 C++ with v143 MFC/ATL and the appropriate Windows SDK. Restore upstream source dependencies with `git submodule update --init --recursive`.

Run `tools/prepare-aaavs.ps1` from PowerShell to download the pinned Microsoft WebView2 SDK, NASM and Yasm, then install/build the JavaScript dependencies. This does not install Visual Studio components or the WebView2 Runtime.

For source checks, enter the `visualizer` directory and run:

```text
npm ci
npm run check
npm run build
```

The public renderer build deliberately does not embed preset or bitmap packs. With your local collection present, run `npm run check:local-catalog` to verify the entire catalog.

Run `python tools/build-native.py` for the x64 **Release Lite developer build**, then `tools/stage-aaavs.ps1` to stage the visualizer and local collection alongside `mpc-aaavs.exe`. Double-click `start-mpc-aaavs.cmd` to launch a completed local build. Lite omits internal LAV codecs and uses installed DirectShow codecs (such as K-Lite); a self-contained release needs the full upstream codec build. WebView2 Runtime must be available on the target machine. The staging tool is for local use, not a public redistribution package. On the development machine, the required DirectX support DLL and optional MediaInfo/icon DLLs were copied locally from the existing K-Lite installation, which was left unchanged; these DLLs are not in this repository.

## Provenance and license

This branch preserves MPC-HC history and starts from upstream commit `8e1cc8761f8dfb0352779ace61c85774e4705fd5`. AAAVS's TypeScript rendering engine and this native integration are added under the repository's [GPL v3 terms](COPYING.txt); existing third-party source notices remain in their files. Preset and dependency packs are separate from the code and are not covered by that statement.

[MPC-HC's original README](docs/MPC-HC-UPSTREAM-README.md) is preserved. This is an independent experimental fork, not an official MPC-HC release.
