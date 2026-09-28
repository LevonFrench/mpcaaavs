# Building mpc-hc-aaavs

Use a clean source checkout for reproducible public builds. Commands below run from the checkout root unless stated otherwise; substitute your own absolute checkout path when a tool requests one.

## Prerequisites

- Windows x64 and Visual Studio 2022 C++ build tools, v143 MFC/ATL, and Windows SDK 10. See the [upstream compilation guide](Compilation.md) for the native toolchain.
- Python 3 and Node.js 22 with npm, available on PATH.
- Git source dependencies: `git submodule update --init --recursive`.
- `powershell -ExecutionPolicy Bypass -File tools/prepare-aaavs.ps1` downloads hash-pinned WebView2 SDK, NASM, and Yasm, then installs/builds the JavaScript dependencies. It does not install Visual Studio components or the WebView2 Runtime.

## Check and build

```powershell
Set-Location visualizer
npm ci
npm run check
npm run build:mpc
Set-Location ..
python tools/check-native-audio.py
python tools/check-native-audio.py --library
python tools/build-native.py
powershell -ExecutionPolicy Bypass -File tools/stage-aaavs.ps1
```

The builder discovers MSBuild, or accepts the `MSBUILD_EXE` environment variable. It produces `bin/mpc-hc_x64 Lite/mpc-hc-aaavs.exe` and writes diagnostics to `native-build.log`. Launch a completed build with `start-mpc-hc-aaavs.cmd`.

Staging updates visualizer code and merges the 16 public NERV manifests. An existing installed preset catalog, renamed files, ratings, failure marks, and saved setups are preserved. A legacy `mpc-aaavs.ini` is copied to `mpc-hc-aaavs.ini` only when the new INI does not exist. The old application and data are not removed. Internal settings and the legacy `mpcaaavs-nerv` data-format identifier remain compatible with earlier builds; format identifiers are not product branding.

If a private AVS catalog is present, `npm run check:local-catalog` from the visualizer directory verifies its file sizes and hashes. To check the staged bundle and catalog together without graphics:

```powershell
$installedVisualizer = (Resolve-Path 'bin/mpc-hc_x64 Lite/visualizer').Path
node visualizer/tools/check-mpc-installed-startup.mjs $installedVisualizer
```

This startup check uses the real built host and files but substitutes the worker graphics boundary. It does not validate playback, focus, GPU performance, or visual fidelity.

## Release Lite limitations

Lite uses installed DirectShow codecs instead of bundling internal LAV filters. Target computers also need the Microsoft Edge WebView2 Runtime and the Microsoft DirectX End-User Runtime (including D3DX9_43). Optional MediaInfo and icon-library DLLs may be absent. A full self-contained codec release requires the upstream full build and its dependency packaging; the preview packager does not create that variant.

The [release guide](RELEASING.md) covers the public-only archive and verification steps.
