# Sprite layer stills (Pixel Stage demo show)

Stills of the demo show `pixel-stage` (`visualizer/src/shows/pixel-stage/`), drawn by the sprite layer on the procedural test pack (no private
art, no audio committed). The song map is the NERV reference fixture's (`visualizer/tools/fixtures/nerv-reference/`), planned by `planShow()` with
the Pixel Stage show definition. Software rendering (headless Chromium, SwiftShader).

Files here are small JPGs. `<plate>_<time>_1080p.jpg` is a 1920x1080 still downscaled to 960x540 (the downscale blurs the pixel edges; the crops
below are the sharpness evidence). `<plate>_<time>_4k_crop.jpg` is an unscaled 1000x600 crop of the 3840x2160 still: at 4K every native pixel of
the plate is an exact block of whole output pixels (integer scale 9 for the 256x224 duel, 10 for the 384x216 and 320x200 plates, 12 for the
320x180 plates), so the edges stay hard. `duel_12.96_sharp_1080p.jpg` is the duel frame rendered in the optional `sharp` scale mode (fractional
fill with the sharp-bilinear shader) instead of the default integer scale with the themed border; it was produced by temporarily setting
`scaleMode: 'sharp'` on the duel plate, which is not committed.

Plates and what each shows (time in song seconds): `select` (intro) 4.63, `duel` (groove) 12.96 and 29.12, `march` (groove) 24.66 and 42.66,
`gallery` (break) 48.32 and 102.32, `charge` (build) 60.66 and 135.75, `finale` (drop) 69.66 (the super: flash, shake, zoom), 78.82 and 147.06.

## Commands (from `visualizer/`)

```sh
export SHOW_CHROMIUM=/opt/pw-browsers/chromium     # any Chromium; the playwright-pinned build also works
# 1080p
node tools/render-show-stills.mjs --show pixel-stage --out <dir> \
  --t 4.63,12.955,29.121,24.655,42.655,48.321,102.322,60.655,135.755,69.655,78.821,147.055
# 4K (output scale 2 = 3840x2160)
node tools/render-show-stills.mjs --show pixel-stage --scale 2 --out <dir4k> --t 4.63,12.955,24.655,48.321,60.655,69.655
# every plate window at one spread time each
node tools/render-show-stills.mjs --show pixel-stage --plates --per 1 --out <dir>
```

The times above were picked by scanning each plate window for the busiest frame (most performers mid-clip, shots and effects in flight); the
frames are pure functions of the song time, so the same command renders the same pixels.
