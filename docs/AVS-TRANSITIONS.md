# AVS transition reference

Reference: https://github.com/grandchild/vis_avs/blob/main/avs/vis_avs/r_transition.cpp
Configuration: https://github.com/grandchild/vis_avs/blob/main/avs/vis_avs/c_transition.h

J:/projects/mpcaaavs/visualizer/src/mpc-transition.ts emulates cross dissolve; four directional pushes; nine random blocks; split horizontal push; center push and squeeze; four directional wipes; and the stepped dot dissolve. Spatial modes use the original sine easing. Random selects one effect per transition. Block order is fixed at transition start, with monotonic reveal even when frames are skipped. Completion explicitly presents the incoming frame.

J:/projects/mpcaaavs/visualizer/src/mpc-host.ts uses active/prepared/outgoing worker ownership. Incoming presets load and render their first frame before being committed. Preloading begins one inferred bar before the switch, and a late preset waits for a later bar. Both presets can animate during the transition. Media time controls progress, so pause freezes the transition and seek discards it. The exact GPU preset renderer is unchanged; composition uses a bounded Canvas surface and the existing final presentation flash limiter.

Intentional differences: no inherited raw framebuffer state between independent workers; no legacy thread-priority/fullscreen restriction; no reproduction of frame-skipping bugs in random blocks. Raster rounding and browser blending can differ from native AVS. This implementation has not been validated pixel-for-pixel against Winamp.

The source repo also offers libavs host APIs, legacy/JSON loading, EEL2, and integrated historical APE effects as future compatibility references. The current AAAVS GPU renderer remains in use.

Attribution is in J:/projects/mpcaaavs/THIRD-PARTY-AVS-TRANSITIONS.txt, copied beside staged executables.
