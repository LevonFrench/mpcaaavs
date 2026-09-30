# NERV show: upstream vs port contact sheets

Each sheet shows bizarro/evangelion (MIT) on the left and the AAAVS show engine port on the right, at the same
song times from the reference fixture (`visualizer/tools/fixtures/nerv-reference`). Both render at 1920x1080 in
headless Chromium with SwiftShader software WebGL. Both use the same synthesized waveform
(`src/song-map/synth-wave.ts`, written to upstream's `data/wave.bin` by `tools/make-nerv-fixture.mjs --upstream-wave`),
because the song itself is not in either repository. Sheets are downscaled JPGs.

Reproduce (from `visualizer/`):

    node tools/make-nerv-fixture.mjs <evangelion checkout> --upstream-wave <evangelion checkout>/data/wave.bin
    SHOW_CHROMIUM=<chromium> node tools/render-show-stills.mjs --plates --per 3 --compare <evangelion checkout> --out <dir>

## Pixel metrics (full-resolution PNGs, 8-bit)

MAE is the mean absolute error per channel. px>24 is the share of pixels where any channel differs by more than 24 levels.

| plate | t (s) | MAE | PSNR (dB) | px>24 |
| --- | --- | --- | --- | --- |
| alert | 88.74 | 0.57 | 32.38 | 1.37% |
| alert | 94.57 | 0.58 | 32.05 | 1.36% |
| alert | 100.40 | 0.60 | 32.11 | 1.50% |
| atfield | 71.06 | 0.32 | 34.57 | 0.73% |
| atfield | 77.54 | 0.32 | 34.40 | 0.76% |
| atfield | 84.02 | 0.23 | 36.63 | 0.63% |
| battery | 58.97 | 0.82 | 29.63 | 1.64% |
| battery | 62.85 | 0.82 | 29.99 | 2.08% |
| battery | 66.74 | 0.72 | 30.38 | 1.69% |
| berserk | 148.14 | 3.52 | 23.05 | 7.02% |
| berserk | 153.97 | 3.74 | 22.93 | 6.88% |
| berserk | 159.80 | 3.26 | 23.26 | 6.89% |
| boot | 1.52 | 0.03 | 44.57 | 0.07% |
| boot | 4.55 | 0.03 | 44.57 | 0.07% |
| boot | 7.58 | 0.86 | 28.17 | 0.64% |
| city | 124.09 | 0.57 | 31.45 | 1.25% |
| city | 128.63 | 0.57 | 31.42 | 1.25% |
| city | 133.16 | 0.60 | 31.17 | 1.36% |
| end | 178.84 | 0.22 | 35.78 | 0.44% |
| end | 181.28 | 4.90 | 20.91 | 4.18% |
| end | 183.73 | 7.09 | 18.40 | 4.46% |
| harmonics | 39.16 | 0.20 | 35.81 | 0.39% |
| harmonics | 43.05 | 0.20 | 35.81 | 0.39% |
| harmonics | 46.94 | 0.24 | 34.51 | 0.41% |
| impact | 164.34 | 0.79 | 30.60 | 1.79% |
| impact | 170.17 | 0.73 | 31.11 | 1.84% |
| impact | 176.00 | 0.46 | 33.54 | 1.40% |
| magi | 10.04 | 1.14 | 27.76 | 1.81% |
| magi | 13.28 | 1.22 | 27.64 | 1.86% |
| magi | 16.52 | 1.25 | 27.69 | 1.83% |
| plug | 103.97 | 0.76 | 29.72 | 1.59% |
| plug | 107.85 | 0.81 | 29.88 | 1.82% |
| plug | 111.74 | 0.75 | 30.48 | 1.79% |
| psycho | 19.36 | 0.47 | 33.24 | 1.12% |
| psycho | 23.25 | 0.52 | 32.51 | 1.20% |
| psycho | 27.14 | 0.54 | 32.46 | 1.36% |
| radar | 29.84 | 0.37 | 33.76 | 0.79% |
| radar | 33.08 | 0.37 | 33.67 | 0.91% |
| radar | 36.32 | 0.37 | 33.83 | 0.78% |
| seele | 49.64 | 0.76 | 30.45 | 1.13% |
| seele | 52.88 | 0.37 | 34.46 | 0.91% |
| seele | 56.12 | 0.75 | 30.23 | 1.21% |
| sync | 136.37 | 0.98 | 29.37 | 2.11% |
| sync | 140.25 | 1.18 | 28.67 | 2.61% |
| sync | 144.14 | 2.53 | 24.75 | 4.54% |
| target | 114.44 | 0.27 | 35.69 | 0.64% |
| target | 117.68 | 0.27 | 35.66 | 0.64% |
| target | 120.92 | 0.25 | 36.28 | 0.61% |

## Known, intentional differences

- **Japanese type.** Upstream draws Japanese with system fonts (Hiragino on macOS; in this Linux container, a generic
  fallback serif). The port bundles Noto Sans JP and Noto Serif JP subsets (OFL) so every host renders the same. That
  accounts for nearly all of the remaining difference. It is largest on the plates that set a big Japanese title
  (berserk 暴走, end 終劇, sync 同調率), and everything else in those frames (layout, glitches, meters, scopes, timers)
  matches.
- **Neutral names.** Franchise words (for example the "EVANGELION" prefix in berserk's status header) are passed as
  show params and default to empty in public builds. See `ShowParams.unit` in `src/show/protocol.ts`.

Neither reference is the original video render. Upstream's own look depends on macOS fonts, and the scopes read a
synthesized waveform, not the song.

