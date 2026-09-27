# PCM, spectrum and Auto wiring

The September 27 follow-up addressed a reported Auto stuck at "Listening for tempo" and missing high-frequency reactivity. No player, browser or GPU was launched while the owner was rendering.

## Corrected path

1. AudioSwitcher taps decoded PCM without altering playback. Each native window carries media timestamp, source sample rate, valid sample count, epoch and sequence. The ring stays bounded; batches now hold 64 windows (previously 16), enough for ordinary 33ms polling at 384kHz. Overflow and producer drops remain explicit discontinuities.
2. The embedded host normalizes source PCM to 44.1kHz with a stereo streaming windowed-sinc resampler. Real packet lengths prevent zero-filled tails becoming false transients. History and fractional phase persist across packets; seek/gap/rate changes reset the stream. Filter lookahead affects availability, not source timestamps.
3. Every normalized window feeds the canonical AVS waveform/spectrum analyser. Each active/prepared/outgoing renderer has an independent spectrum maximum/beat latch. The final already-log-mapped AVS audio frame is sent with render requests; workers use it for the shared CPU and GPU effect context. The old renderer path analysed only the latest short PCM snapshot and missed intermediate transients.
4. Auto consumes the normalized timed windows through a dedicated rolling estimator. Stereo 200 Hz low-pass bass and high-pass percussion envelopes are sampled in 10 ms bins. Autocorrelation combines one-, two- and four-beat recurrence over 6–12 seconds; isolated transients and syncopated intervals cannot alone define the BPM. Repeated estimates are required to acquire or replace a clock. An established tempo coasts through short breakdowns, while silence eventually unlocks it. Dropped PCM packets preserve tempo and phrase state; actual seeks reset both. Four-beat inferred bars and 2–12-bar targets remain. No wall-clock switching was introduced.

Existing non-MPC clients can still send PCM-only worker requests. Classic spectrum layout remains 512 FFT-derived slots plus the 64-slot decay tail; it is intentionally not a uniform 576-bin frequency axis. Analysis does not change audible playback or add treble gain.

## CPU evidence

- Native PCM fixture checks sample-rate/valid-length metadata and ordinary 33ms batch capacity at 44.1,48,96,192 and 384kHz, in addition to format/layout/gap tests.
- J:/projects/mpcaaavs/visualizer/tools/check-mpc-spectrum.mjs verifies 100Hz,1kHz,6kHz,12kHz and 18kHz at all five rates, partial 317-sample packets, stereo isolation, correct peak placement and getspec access.
- A 12kHz burst followed by silence remains in the renderer's held spectrum and is cleared after consumption. The actual host mock checks that this spectrum reaches the worker render message.
- Steady bass plus weak 9kHz percussion at 120BPM previously failed to lock; the corrected director locks and produces phrase switches. Steady 30/60/100/440/1000/9000Hz tones do not lock a false tempo in the fixture.
- End-to-end resampler/director fixtures with 8kHz rhythmic bursts at 48 and 384kHz acquire 120BPM through 33ms polling.
- Existing TypeScript, host lifecycle, navigation, transition, security and audio tests still pass. Native Release Lite rebuild passes; updated renderer is staged alongside it.

These are source/CPU fixtures, not proof of actual listening alignment or visual fidelity for every historical preset. The entire catalog uses the same corrected audio handoff, but unsupported legacy effects remain unsupported. Multichannel analysis still uses the first two channels; passthrough without decoded PCM cannot supply audio. Native device output rate/latency and live playback were not measured in this GPU-free run.

## Real-track tempo regression

The owner's reported 109 BPM and 92 BPM tracks exposed the limits of the earlier transient-only detector. The new design takes the useful low-pass/multi-interval idea from the locally supplied BPM Explorer project, with a new streaming implementation (no source copied).

CPU-only decoding of both complete local files, followed by the actual director path, produced:

| Track | Reference | Measured range after 10 seconds | Locked frames checked | Phrase switches (2-bar setting) |
| --- | --- | --- | --- | --- |
| Fabolous — Young’n | 109 | 108.97–109 | 15,038 | 30 |
| Jadakiss — Knock Yourself Out | 92 | 92 | 15,536 | 26 |

Both first locked at about 7.01 seconds. Every checked frame retained lock within 2 BPM of the supplied reference. Audio files are not included in the repository. The optional `J:/projects/mpcaaavs/visualizer/tools/check-mpc-track.mjs` accepts `path-to-stereo-44100-f32le=expectedBpm` arguments. Synthetic CI checks cover repeated dropped packets, dense percussion, missing attacks, fills, breakdowns, a 109-to-92 tempo change, seeks and eventual silence unlock.

This establishes CPU tempo and scheduler behavior on these files, not live device latency, exact downbeat alignment or universal genre accuracy. The renderer audio path is unchanged by this estimator replacement.
