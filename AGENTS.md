# AAAVS shared visualizer development

Product: mpc-hc-aaavs. Keep the current repository URL.

Visualizer changes also target stock AAAVS. Read
`docs/AAAVS-SHARED-DEVELOPMENT.md` before changing audio, presets, transitions,
management or timing. Shared source lives in `visualizer/src/`; use host adapters
for media transport and persistence. Do not duplicate behavior in the browser
and MPC hosts. `tools/aaavs-mirror.json` defines the portable mirror surface.

Preserve the stock Studio, projector and offline renderer. NERV/HUD support in
the shared Player does not imply support in the legacy AVS-only offline path.
Never overwrite private catalogs, ratings, setups, assets or independent edits.
Run the mirror preview/check for the supplied stock checkout; stop on conflicts.

Keep song analysis and HUD component work aligned with the shared plans in
`docs/SONG-ANALYSIS-AND-HUD-DRIVERS.md` and `docs/HUD-ANIMATION-BEDS.md`. Clearly
distinguish proposed features, CPU checks, build results and live acceptance.
No GPU or application launch while the owner reserves the GPU for rendering.

Run relevant CPU checks and both applicable builds. Preserve original AVS
golden hashes; do not re-record them to hide a regression. Public artifacts must
exclude private paths, media, local presets, history and personal configuration.
