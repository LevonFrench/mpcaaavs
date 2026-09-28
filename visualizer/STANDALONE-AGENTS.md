# Stock AAAVS shared Player

Preserve the Studio, projector, offline renderer, original presets and render
golden hashes. Shared Player features are mirrored from the MPC-HC-AAAVS
repository; read `docs/AAAVS-SHARED-DEVELOPMENT.md` before editing.

Keep common audio, timing, preset management and transitions in one source
implementation. Coordinate changes back into the canonical visualizer source
and use its `tools/mirror-aaavs.py` preview/apply/check workflow. Do not overwrite
independent destination edits or private catalogs, ratings and setups.

The Player builds into `dist/player/`; never overwrite the Studio's separate
workers. Its local server performs filename ratings and persistence. Static
hosting does not offer that service. NERV/HUD support in the shared Player is
not yet NERV/HUD offline export support.

Future song analysis and HUD work is shared across both apps. Follow
`docs/SONG-ANALYSIS-AND-HUD-DRIVERS.md` and `docs/HUD-ANIMATION-BEDS.md`.
Require CPU checks and both applicable builds before calling a feature mirrored;
distinguish that from live audio, visual and GPU acceptance. Keep the GPU free
when the owner reserves it for other rendering.
