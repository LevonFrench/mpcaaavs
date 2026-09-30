# NERV scenes and repeatable timing

The public pack contains 16 live-audio presets adapted from the visual vocabulary of
[bizarro/evangelion](https://github.com/bizarro/evangelion): Boot, Magi, Psycho,
Radar, Harmonics, Seele, Battery, AT Field, Alert, Entry Plug, Target, Tokyo-3,
Sync, Berserk, Impact and End. Each has a different instrument layout; they share
terminal typography, hazard strips, stereo scopes and a full-band spectrum rail.
They are scene presets, not AVS binaries. By default they render on the show engine, a port of
the upstream Three.js engine and its 16 plates (see **Renderer** below). The earlier Canvas2D
scenes remain as a fallback. The upstream MIT notice is preserved in `THIRD-PARTY-NERV.txt`.
The show engine bundles the OFL fonts the upstream video uses (`visualizer/show-assets/fonts`,
licenses in `LICENSES.txt`). No original music, precomputed song analysis or logos are included.

## Use

1. Open **View > Visualizer > Setup Builder** (**Ctrl+F7**).
2. Choose **NERV scene set**. This fills the ordered 16-preset sequence.
3. Set **Song BPM**, **First scene offset**, **Bars per scene**, and optionally
   **Shuffle seed**. The template uses the current trusted tempo if available;
   otherwise it starts at 120 BPM. That value is a user-adjustable fixed clock,
   not a claim about the track's actual BPM.
4. Choose any **Transition** style and its **Duration** using the existing setup
   controls. These effects follow the same song clock as the scene changes.
5. Keep **Auto switching** and **Follow the song clock** enabled. Choose
   **Activate setup** and close the panel. **Save setup** retains the list and
   timing configuration for later activation.

The template defaults to eight four-beat bars per scene. At 120 BPM that is
16 seconds per scene. A positive offset holds the opening scene until the offset;
a negative offset begins partway through the sequence. Scene selection loops after
the last preset. The fixed BPM, offset, bars and seed survive setup save/reload.
The active setup is session state; activate a saved setup again after restarting.

**Ctrl+F6** opens Preset Manager. Search **NERV** to load scenes individually,
add them to other setups, or use ordinary adaptive Auto. **F6/F7** lower/raise
the current preset's rating. Ratings rename its `.nerv` file with `[N stars]`
and update Date modified using the same native transaction as `.avs` ratings.

With the song clock and Auto enabled, manual previous/next or **Load preset**
queues a NERV scene from the active setup for the next scene boundary. Any NERV
scene in that setup can follow any other: no special pairs or fixed storyboard
are required. Further choices before that boundary replace the queued choice.
The ordered or seeded sequence continues
from the selected scene. Choices replay at the same song positions when seeking
or repeating within the current session; they are not added to the saved setup.
Activating a setup clears the session choices and restores its saved sequence at
the current song position. Turn Auto off to change scenes immediately. Loading a
legacy AVS preset or one outside the active setup still holds the fixed sequence;
activate the setup again, or switch Auto off and back on, to resume it. Opening a
management panel defers scene selection until the panel is closed.

## Renderer

NERV presets render on the show engine (`visualizer/src/show-render.worker.ts`), with WebGL2, HDR
post-processing and the upstream plates, fonts and bar-timed stories:

- A plate's story is mapped onto its scene window, so it resolves on the scene's last bar. For
  example, Magi's vote is decided and its countdown reaches zero at the scene change.
- Until a song analysis exists, the engine reads the live audio frames and the scene clock's beat
  grid. Kicks, snares and hats that have not been heard yet are predicted on that grid. Bass
  pitch, vocal onsets and future spectra are unknown in this mode, so they read as silence.
- Transitions between NERV presets use the same styles and clock as before.
- The frame is rendered at 1920x1080 and letterboxed into the render size.
- If the device has no WebGL2, the worker falls back to the Canvas2D scenes by itself.
- To keep the Canvas2D scenes on a device, set `localStorage["mpcaaavs.nervEngine"] = "legacy"`
  in the visualizer page, or open it with `?nerv=legacy`.
- Multiview lanes always use the Canvas2D scenes.

## Clock and audio contract

Scene selection, local animation time and seeded shuffle are derived directly
from MPC-HC media time. Pause does not advance them. A seek or repeat reconstructs
the appropriate scene without playing through earlier scenes; late loads enter at
the current song position. Between manual choices, shuffle visits every eligible preset
once per cycle and avoids adjacent repeats across cycles (a singleton naturally
repeats). An explicit choice can repeat the currently playing scene.

Not-working marks are excluded from timed selection. With Shuffle enabled, the
minimum shuffle rating also applies. Changing ratings, marks, or that threshold
can change the eligible sequence; queued choices that no longer qualify are cleared.
An empty eligible pool holds the current display and reports the filter condition.

Clocked NERV changes use the existing AVS transition styles: dissolve, pushes,
wipes, blocks, squeeze, dots, **Random**, or **Cut**. Random style and block order
derive from the saved seed and scene boundary, so seeking back reconstructs the
same transition. Duration uses the configured number of beats at the fixed BPM,
or the fixed seconds setting, capped at one scene's duration to prevent overlapping
transitions. Auto-transition off also cuts. Turning off outgoing animation freezes
the outgoing geometry at
its boundary time; both sides still receive the current live audio. A direct seek
into a transition reconstructs both NERV plates and the effect's current progress.
Mixed AVS/NERV fixed-clock setups have deterministic selection, but use cuts where
the previous/current scene is not a NERV plate; historical AVS internal state is
not reconstructed.

Instruments consume the existing normalized 44.1 kHz stereo PCM and 576-byte AVS
spectrum arrays. Separate spectrum peak holds preserve a transient that occurs
earlier in a native PCM batch. Low/mid/high instrument bands cover approximately
0–400 Hz, 400 Hz–4 kHz and 4–22 kHz. The 512 FFT-derived spectrum slots are distinct
from the 64 legacy tail slots. Battery displays a four-bar clock, not a remaining
track duration. The renderer does not pretend to isolate vocals or other stems.

Repeatable timing is not a promise of pixel-identical capture: live audio frames,
the protective flash limiter, fonts, surface size and delivery timing still affect
presentation. Rendering stays in the embedded artwork area. No offline video
export or original song-specific cue sheet is added.

## Packaging and verification

`visualizer/nerv-presets/` contains data-only manifests. The
installer at `visualizer/tools/install-nerv-presets.mjs` merges
them into an absolute target collection by SHA-256. Staging installs the pack even
without a private AVS collection. Existing rated filenames, timestamps, setups and
private entries are preserved. Local startup still verifies each manifest's size
and digest before handoff, then validates its format/version/scene ID in the worker.

CPU checks cover all 16 distinct drawing streams, finite geometry, seeded replay,
low/mid/high and stereo input, song-clock boundaries, setup persistence, native
rating rollback, installer idempotence, malformed manifests, host seek/load races,
paused redraws, Auto cancellation and worker transitions. Native Release Lite builds
and the staged bundle are separate from live acceptance. The player/browser/GPU
were deliberately not launched during this change; visual legibility, pacing and
integrated runtime performance still need an audition.
