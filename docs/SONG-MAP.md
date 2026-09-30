# Song map (implementation)

The CPU song map of `docs/SONG-ANALYSIS-AND-HUD-DRIVERS.md`: a background scan of decoded PCM that produces the
`SongMapJSON` + `SongMapBinary` contract in `visualizer/src/song-map/types.ts` (shared, unchanged, with the show
engine). Everything is shared source; the MPC host and the standalone Player differ only through adapters.

Status: CPU implementation with synthetic ground-truth checks. Real-music accuracy, the browser Player's decode path and
the MPC native bridge have not been exercised (see "Not verified").

## What it produces

100 fps envelopes (`rms low mid high vocal drums bass other`), tempo with explicit `beats` and `downbeats` (tempo
changes are real beat timestamps, not a global BPM), `bar0` (phrase phase), kick / snare / hat / vocal-proxy onsets,
`bass_midi` (YIN on a 2.7 kHz bass path), a 64-band mel and 12-bin chroma spectrum per frame (`SongMapBinary.spec`),
an 11 025 Hz stereo waveform (`SongMapBinary.wave`), sections with `role` (intro, groove, break, build, drop,
breakdown, outro) and `energy`, three honest confidences and an `approximations` list.

Honesty rules the code follows:

- Stem-free features are declared in `approximations` (`vocal`, `drums`, `bass`, `other`, `bass_midi`, `chroma`, the
  four onset kinds, plus `partial`, `spectrum.mel-bandlimited`, `onsets.hat-bandlimited`, `wave.not-cached` when true).
  Band-energy peaks are not isolated instruments; `vocal` is a harmonic 300-3400 Hz proxy.
- Confidences are heuristic scores in 0..1, not calibrated probabilities.
- A partial map (`complete: false`) never labels a chunk or live edge `outro`, and never labels a section `intro`
  unless it starts at 0. The waveform ships only when every sample of it was analysed and the track is at most
  10 minutes (`DEFAULT_MAX_WAVE_SECONDS`).
- Deterministic: a map is a pure function of the PCM. No randomness, no clock. (`SongMapUpdate.elapsedMs` is
  informational and never part of a map.)

## Modules (`visualizer/src/song-map/`)

| File | Role |
| --- | --- |
| `frames.ts`, `dsp.ts` | Streaming, chunk-exact feature stage. A region reproduces a continuous pass exactly after a 2 s pre-roll. |
| `features.ts`, `rhythm.ts`, `sections.ts` | Global refinement over compact features: envelopes and onsets, tempo/beat/downbeat, sections and roles. |
| `analyzer.ts` | `SongMapAnalyzer`, region planning (`planRegions`, `orderRegions`), snapshot build. |
| `engine.ts`, `song-map.worker.ts`, `protocol.ts`, `inline-worker.ts` | Worker engine, entry, message protocol (every message carries a job id), in-process worker. |
| `scan.ts` | `SongMapScan`: playhead-first region scheduling, bounded in-flight PCM, progressive snapshots with a revision and a `SongMapClock`, cancellation. |
| `live.ts` | `SongMapLive`: a partial map from PCM a host already receives (seeks start new runs; stored material is never stored twice). |
| `session.ts` | `SongMapSession`: one per page. Cache, then scan or live; `hold/release`; generation counter. |
| `cache.ts` | Track key, record format (gzip + base64), strict validation, `LibrarySongMapStore`, `MemorySongMapStore`. |
| `decode.ts`, `host.ts` | Browser decode and content hash; worker factory and library transports (HTTP, native bridge). |
| `clock.ts` | `SongMapClock`. |

### Scan

Files up to 5 minutes are one logical region; longer files use 5-minute cores with 2 s of context either side. The
first core is 30 s so a first useful (provisional) map arrives in under a second. A chunk boundary is a scheduling
boundary only: chunked and continuous scans produce identical maps (checked). Progressive delivery publishes one
snapshot per region, each with a strictly increasing `revision`, the analysed `coverage` spans and `complete`.
PCM is sent in 2 s blocks with at most four blocks in flight; the client never holds more than that. `cancel()` and a
track change reject late messages by job id in both directions.

### SongMapClock

`new SongMapClock(map, revision, coverage?)` is immutable, so a late scan result never changes what a caller has
already evaluated. `sectionAt(t)` (section, index, progress), `roleAt`, `nextBoundary(t, 'section' | 'bar' | 'beat')`
(strictly after `t`), `beatAt` / `timeOfBeat` and `barAt` / `timeOfBar` (continuous, interpolated between explicit
timestamps, extrapolated outside the grid), `barPosition`, `bpmAt`, `nearestBeat`, `covered`, `revision`, and
`SongMapClock.progress(t, start, end)` (the interval-counter rule). `beatsPerBar` is the map's optional meter (see "Meter"):
`barPosition().beatInBar` runs from 0 to `beatsPerBar`, and without downbeats a bar is `beatsPerBar` beats.

### Meter (beats per bar)

`SongMapJSON.beatsPerBar` is optional and additive: absent means 4, and every reader must keep working without it (older cached
maps, the live fallback and stock 4/4 analysis do not carry it). Only integers from 2 to 12 are honoured (`beatsPerBarOf` in
`src/song-map/meter.ts`); `validateSongMap` rejects anything else. `confidence.meter` (optional, 0..1) says how decisive the
analyzer's estimate was. The meter changes nothing about beats; it only says how many beats lie between two downbeats.

The analyzer's downbeat stage (`rhythm.ts`) estimates 3 versus 4 (other meters stay on 4): the per-beat accent (structural change plus
half a standardised kick strength) is autocorrelated, pooled over the tempo regions, and the meter is 3 only when the lags 3, 6, 9 and 15
clearly beat the lags 4, 8, 16 and 20 (strength above 0.15 and 1.6 times the 4-beat score; 12 and 24 are shared and ignored). Short or
weak evidence (under 48 beats) is 4. The bar phase then uses the chosen meter (snare evidence on the meter's backbeats, see below); for 4
the computation is exactly the old one. The estimate is one value for the whole track, so a track that changes meter keeps the majority.
`SONG_MAP_ANALYZER` was bumped to `aaavs-song-map-cpu-2`, so cached maps of the earlier analyzer are scanned again once.

Backbeats (`backbeats(n)`, beat indices inside the bar, 0 is the downbeat) are used for the snare evidence and for the live fallback's
predicted snares: 2/4 and 6/8 counted in two: beat 2; 3/4: beats 2 and 3; 4/4: beats 2 and 4; 5/4 (3+2): beats 2 and 4; 6/8 counted in
six: beat 4; 7/8 (2+2+3): beats 3 and 5; 9/8: beats 4 and 7; 8, 10, 11, 12: beats n/4 and 3n/4 rounded. The kick is on every beat
in every meter, strongest on the downbeat.

The show engine's live fallback (`src/show/live.ts`) takes `beatsPerBar` in its clock: downbeats every `beatsPerBar` beats, the neutral
arrangement in bars of that length and the predicted onsets above; `presetWindow` passes the host ClockGrid's `beatsPerBar` (the host
allows 1..16; 1 and above 12 read as 4 here), and the window key includes it. `AudioData.beatsPerBar` is what plates read; the NERV bar
and beat read-outs use it. Plates that hard-code four beats inside a bar in other ways are not audited.

### Cache

Keyed by track identity and `SONG_MAP_VERSION`: `<64-hex>-v<version>`. The identity is the SHA-256 of the file's bytes
(standalone Player). Only complete maps are stored, without the waveform (about 5 MB per 4 minutes; a cache hit sets
`wave.not-cached`). A record is about 260 KiB for a 32 s track and is refused above 3 MiB. A record that fails
validation, belongs to another track, analyzer or version is a miss. Persistence goes through the library channel
(`load-song-map` / `save-song-map`, replies `song-map-loaded` / `song-map-saved`); the standalone server keeps at most 200
records under `.aaavs-private/song-maps/` and never serves them.

## Hosts

Shared code: `SongMapSession` plus `createHostSongMap`. Hosts differ only in the library transport and PCM source.

- **Standalone Player** (`standalone-player.ts`): opening a file calls `session.hold()`, hashes the file, looks up the
  cache and on a miss decodes to 44.1 kHz stereo (`OfflineAudioContext.decodeAudioData`) and scans in a Worker. Files
  over 15 minutes are not decoded whole (the decoded float PCM is about 21 MB per minute); the session falls back to
  the live map. Seeks reprioritise regions. The session is `window.aaavsSongMap`.
- **MPC host** (`mpc-host.ts`, about 8 lines): uses `window.aaavsSongMap` when the page provides one, otherwise builds a
  session over the native bridge. It feeds the session the normalised 576-sample hops it already receives
  (`feedLive`); a live map starts after one second of contiguous playback and is provisional. Nothing more is needed
  for a live map.

### What the native bridge must add for the MPC host

Nothing above is required to run (an unknown library op is answered with `library-error`; the session then works
without a cache). For persistence and a full-file scan the native side needs:

1. **Track identity**: post `{"type":"track","id":"<64 lowercase hex>","duration":<seconds>}` on every track change,
   where `id` is a hash of the selected audio stream's source bytes (or of its decoded PCM under a fixed recipe).
   The host calls `openTrack({id, source: null})`, which enables cache hits. Without it a live map is not persisted.
2. **Library ops** in `AAAVSView.cpp` `Library()` alongside `load-state`: `load-song-map {key}` answering
   `{"type":"song-map-loaded","key":key,"data":<record|null>}` and `save-song-map {key,data}` answering
   `{"type":"song-map-saved","key":key}`. The record shape and limits are those of `songMapRecord` in
   `visualizer/tools/standalone-library.mjs` (key `^[0-9a-f]{64}-v[1-9][0-9]{0,3}$`, base64 payload of at most 3 MiB,
   atomic write, private folder, bounded count). Errors answer `library-error` with the same `operation`.
3. **Full-file PCM for look-ahead** (optional, needed before the first play-through completes): a background decoder
   that streams the selected stream as stereo float PCM blocks to the page; the page wraps it in a `PcmSource` and calls
   `openTrack({id, source})`. Native must publish duration, the source-to-player timestamp mapping and a cancellation
   generation, reject late blocks, and keep one decoder at reduced priority with bounded queues.
4. `visualizer/dist/song-map.worker.js` is built by `npm run build` and listed in `tools/package-release.py`.

## Checks and benchmarks

`npm run check` includes `tools/check-song-map.mjs` (about 70 s): clock, cache records and adapters, the worker protocol
(also in a real `worker_threads` thread), chunked-equals-continuous, cancellation and stale-job rejection,
backpressure, live feed with a seek, session lifecycle, library server round trip and the accuracy table below. The
library server ops are covered by `tools/check-standalone-library.mjs`.

`npm run bench:song-map [minutes...]` (not part of `check`) reports throughput and peak memory on a looped synthetic
track generated block by block.

Accuracy on synthetic ground truth (`tools/song-map-fixtures.ts`: drums, bass, pads, vocal-like chops, risers and
snare rolls arranged intro / groove / break / build / drop / breakdown / build / drop / outro). Every fixture, the 3/4 waltz included (`waltz-126`), must also read the right `beatsPerBar` (absent for 4/4). Thresholds: tempo
within 1 %, beat and downbeat F-measure at least 0.95 (70 ms), section boundaries within one bar, role accuracy at
least 0.85, drum onset F at least 0.6, bass pitch at least 0.55. The fixtures and the heuristics were developed
together, so these numbers show that the machinery works on clean, regular music, not how it performs on real songs.
The vocal-proxy onset F-measure is reported, not gated (0.04 to 0.40): it is weak by construction.

## Not verified

Real music (no annotated corpus was available); the browser Player end to end (file picker, `decodeAudioData`,
the bundled worker in a browser); the MPC native bridge; behaviour of a live map against real playback timing;
files over 15 minutes in the browser Player (live map only); the 3-vs-4 meter estimate on anything but the one synthetic waltz fixture (a
scratch run at 150 and 180 BPM also found 3, but is not gated); half/double-time ambiguity on
real material (and meters other than 3 and 4, and 3/4 below about 100 BPM, where the tempo stage can lock to double time as it can on any
slow track with an ambiguous snare pattern); stock AAAVS mirroring of the new tools.
