# PCM, spectrum and Auto wiring

The September 27 follow-up addressed a reported Auto stuck at "Listening for tempo" and missing high-frequency reactivity. No player, browser or GPU was launched while the owner was rendering.

## Corrected path

1. AudioSwitcher taps decoded PCM without altering playback. Each native window carries media timestamp, source sample rate, valid sample count, epoch and sequence. The ring stays bounded; batches now hold 64 windows (previously 16), enough for ordinary 33ms polling at 384kHz. Overflow and producer drops remain explicit discontinuities.
2. The embedded host normalizes source PCM to 44.1kHz with a stereo streaming windowed-sinc resampler. Real packet lengths prevent zero-filled tails becoming false transients. History and fractional phase persist across packets; seek/gap/rate changes reset the stream. Filter lookahead affects availability, not source timestamps.
3. Every normalized window feeds the canonical AVS waveform/spectrum analyser. Each active/prepared/outgoing renderer has an independent spectrum maximum/beat latch. The final already-log-mapped AVS audio frame is sent with render requests; workers use it for the shared CPU and GPU effect context. The old renderer path analysed only the latest short PCM snapshot and missed intermediate transients.
4. Auto also consumes the normalized timed windows. Overall amplitude attacks remain; independent spectral-band rises add evidence from percussion over steady bass. The lowest spectral block is excluded from this additional detector to avoid short-window bass phase modulation; bass still uses the amplitude detector. Tempo confidence, four-beat inferred bars and 2–12-bar targets remain. No wall-clock switching was introduced.

Existing non-MPC clients can still send PCM-only worker requests. Classic spectrum layout remains 512 FFT-derived slots plus the 64-slot decay tail; it is intentionally not a uniform 576-bin frequency axis. Analysis does not change audible playback or add treble gain.

## CPU evidence

- Native PCM fixture checks sample-rate/valid-length metadata and ordinary 33ms batch capacity at 44.1,48,96,192 and 384kHz, in addition to format/layout/gap tests.
- J:/projects/mpcaaavs/visualizer/tools/check-mpc-spectrum.mjs verifies 100Hz,1kHz,6kHz,12kHz and 18kHz at all five rates, partial 317-sample packets, stereo isolation, correct peak placement and getspec access.
- A 12kHz burst followed by silence remains in the renderer's held spectrum and is cleared after consumption. The actual host mock checks that this spectrum reaches the worker render message.
- Steady bass plus weak 9kHz percussion at 120BPM previously failed to lock; the corrected director locks and produces phrase switches. Steady 30/60/100/440/1000/9000Hz tones do not lock a false tempo in the fixture.
- End-to-end resampler/director fixtures with 8kHz rhythmic bursts at 48 and 384kHz acquire 120BPM through 33ms polling.
- Existing TypeScript, host lifecycle, navigation, transition, security and audio tests still pass. Native Release Lite rebuild passes; updated renderer is staged alongside it.

These are source/CPU fixtures, not proof of actual listening alignment or visual fidelity for every historical preset. The entire catalog uses the same corrected audio handoff, but unsupported legacy effects remain unsupported. Multichannel analysis still uses the first two channels; passthrough without decoded PCM cannot supply audio. Native device output rate/latency and this user's current song were not measured in this GPU-free run.
