# NERV scenes and repeatable timing

The public pack contains 16 live-audio presets adapted from the visual vocabulary of
[bizarro/evangelion](https://github.com/bizarro/evangelion): Boot, Magi, Psycho,
Radar, Harmonics, Seele, Battery, AT Field, Alert, Entry Plug, Target, Tokyo-3,
Sync, Berserk, Impact and End. Each has a different instrument layout; they share
terminal typography, hazard strips, stereo scopes and a full-band spectrum rail.
They are Canvas2D scene presets, not AVS binaries or the original Three.js video.
The upstream MIT notice is preserved in `J:/projects/mpcaaavs/THIRD-PARTY-NERV.txt`.
No original music, precomputed song analysis, fonts or logos are included.

## Use

1. Open **View > Visualizer > Setup Builder** (**Ctrl+F7**).
2. Choose **NERV scene set**. This fills the ordered 16-preset sequence.
3. Set **Song BPM**, **First scene offset**, **Bars per scene**, and optionally
   **Shuffle seed**. The template uses the current trusted tempo if available;
   otherwise it starts at 120 BPM. That value is a user-adjustable fixed clock,
   not a claim about the track's actual BPM.
4. Keep **Auto switching** and **Follow the song clock** enabled. Choose
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

Manual previous/next or **Load preset** holds the chosen scene and suspends the
fixed sequence. Activate the setup again, or switch Auto off and back on, to
resume at the scene corresponding to the current song position. Opening a
management panel defers automatic scene selection until the panel is closed.

## Clock and audio contract

Scene selection, local animation time and seeded shuffle are derived directly
from MPC-HC media time. Pause does not advance them. A seek or repeat reconstructs
the appropriate scene without playing through earlier scenes; late loads enter at
the current song position. Shuffle visits every preset once per cycle and avoids
adjacent repeats across cycles (a singleton naturally repeats).

Clocked NERV changes use a repeatable crossfade, or **Cut**. Duration uses the
configured number of beats at the fixed BPM, or the fixed seconds setting, capped
at one quarter of a scene. Auto-transition off also cuts. Turning off outgoing
animation freezes the outgoing geometry at its boundary time; both sides still
receive the current live audio. Other AVS transition styles remain available for
manual changes and ordinary adaptive Auto. A direct seek into a fade reconstructs
both NERV plates. Mixed AVS/NERV fixed-clock setups have deterministic selection,
but use cuts where the previous/current scene is not a NERV plate; historical AVS
internal state is not reconstructed.

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

`J:/projects/mpcaaavs/visualizer/nerv-presets/` contains data-only manifests. The
installer at `J:/projects/mpcaaavs/visualizer/tools/install-nerv-presets.mjs` merges
them into an absolute target collection by SHA-256. Staging installs the pack even
without a private AVS collection. Existing rated filenames, timestamps, setups and
private entries are preserved. Local startup still verifies each manifest's size
and digest before handoff, then validates its format/version/scene ID in the worker.

CPU checks cover all 16 distinct drawing streams, finite geometry, seeded replay,
low/mid/high and stereo input, song-clock boundaries, setup persistence, native
rating rollback, installer idempotence, malformed manifests, host seek/load races,
paused redraws, Auto cancellation and worker crossfades. Native Release Lite builds
and the staged bundle are separate from live acceptance. The player/browser/GPU
were deliberately not launched during this change; visual legibility, pacing and
integrated runtime performance still need an audition.
