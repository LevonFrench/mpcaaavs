# Sprite layer stills (Pixel Stage demo show)

Stills of the demo show `pixel-stage` (`visualizer/src/shows/pixel-stage/`), drawn by the sprite layer on the procedural test pack (no private
art, no audio committed). The song map is the NERV reference fixture's (`visualizer/tools/fixtures/nerv-reference/`), planned by `planShow()` with
the Pixel Stage show definition. Software rendering (headless Chromium, SwiftShader).

Files here are small JPGs: `<plate>_<time>_1080p.jpg` is a 1920x1080 still downscaled to 960x540; `<plate>_<time>_4k_crop.jpg` is an unscaled
1000x600 crop of the 3840x2160 still (every native pixel is a 10x10... see the scale in the plate's native size) to show the pixel edges.
`duel_12.96_sharp.jpg` is the same frame in the optional `sharp` scale mode (sharp-bilinear fill instead of the integer scale).

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
