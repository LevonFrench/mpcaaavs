# MPC-AAAVS

An experimental fork of [MPC-HC](https://github.com/clsid2/mpc-hc) that places the AAAVS music visualizer in the player's album-art area.

The native toolbar adds **previous preset**, **next preset**, and **preset shuffle** beside the playback controls, using MPC-HC's existing themed icons. Track controls keep their usual behavior. Previous walks actual preset history; shuffle changes the next-preset selection and does not advance on a timer.

**Source prototype — no runnable release is available yet.** The embedded renderer bundle, TypeScript checks, navigation tests, native PCM unit test, and standalone WebView2 bridge compilation pass locally. The complete Windows player has not been built or tested. MFC/ATL and upstream third-party dependencies are missing in the development environment. CI checks source only, not native playback or GPU rendering.

## Architecture

- MPC-HC remains responsible for decoding, audio output, seeking and transport.
- A bounded, timestamped PCM tap feeds AAAVS without blocking the audio thread.
- WebView2 embeds the AAAVS worker in the existing artwork rectangle for audio-only media.
- Rendering uses the exact AVS compatibility lane with the presentation flash limiter.
- Video playback retains the original renderer. Failed visualization falls back to artwork.
- The fork uses a separate executable name, settings location and window class.

These integration behaviors still require end-to-end Windows validation, including sync, resize, fullscreen, toolbar appearance and failure recovery. AudioSwitcher must be enabled; bitstream passthrough provides no PCM. Multichannel analysis currently uses the first two channels.

## Presets

The development installation uses a **3,409-entry local canonical collection**, including the 124 curated picks. Every local catalog file passed size and SHA-256 verification. Three entries have recorded parser failures. Inclusion in the catalog does not imply faithful rendering of every historical effect.

**No preset packs, third-party bitmap packs, fonts or APE binaries are distributed in this repository.** Keep your existing collection local, under `visualizer/avs presets/`, with:

- `catalog/presets.json`, `catalog/parser-validation.json`, `catalog/dependencies.json`
- the catalog's `presets/unique/` files
- the catalog's `dependencies/unique/` files and original notices

The host lazily loads every catalog entry and integrity-checks preset bytes. Package-scoped BMP assets are passed to the existing bitmap resolver. Historical APE binaries are not executed. Missing/unsupported effects, fonts and ambiguous bitmap names may differ from Winamp. Redistribution permissions for the collected packs have not been established; the collection remains Git-ignored.

## Build

Windows x64 is the initial target. Follow [MPC-HC's native build prerequisites](docs/Compilation.md), including Visual Studio 2022 C++ with v143 MFC/ATL and the appropriate Windows SDK. Restore upstream source dependencies with `git submodule update --init --recursive`.

Run `tools/prepare-aaavs.ps1` from PowerShell to download the pinned Microsoft WebView2 SDK and install/build the JavaScript dependencies. This does not install Visual Studio components or the WebView2 Runtime.

For source checks, enter the `visualizer` directory and run:

```text
npm ci
npm run check
npm run build
```

The public renderer build deliberately does not embed preset or bitmap packs. With your local collection present, run `npm run check:local-catalog` to verify the entire catalog.

Run `python tools/build-native.py` for the x64 **Release Lite developer build**, then `tools/stage-aaavs.ps1` to stage the visualizer and local collection alongside `mpc-aaavs.exe`. Lite omits internal LAV codecs; a release needs the full upstream codec build. WebView2 Runtime must be available on the target machine. The staging tool is for local use, not a public redistribution package.

## Provenance and license

This branch preserves MPC-HC history and starts from upstream commit `8e1cc8761f8dfb0352779ace61c85774e4705fd5`. AAAVS's TypeScript rendering engine and this native integration are added under the repository's [GPL v3 terms](COPYING.txt); existing third-party source notices remain in their files. Preset and dependency packs are separate from the code and are not covered by that statement.

[MPC-HC's original README](docs/MPC-HC-UPSTREAM-README.md) is preserved. This is an independent experimental fork, not an official MPC-HC release.
