// Native vs AVS beat-detector divergence report. DIAGNOSTIC ONLY: exit 0.
//
// The native lane uses AdaptiveMultibandDetector (perceptual spectral flux);
// the AVS legacy lane uses AvsBeatDetector (Winamp's slow/fast amplitude-peak
// ratio, byte-for-byte). They are deliberately different algorithms and must
// stay that way. This report only makes the difference MEASURED: it runs both
// over the same seeded fixture PCM and prints how often they agree, which one
// fires alone, and how each scores against the synthesiser's event times.
//
// AVS input mirrors the offline renderer: each 60 fps output frame's sample
// interval is decimated into AVS's fixed 576-point window (fillFramePcm in
// offline-render.worker.ts), and a beat is stamped at that frame's start time.

import { AvsAudioAnalyser } from '../src/avs/audio.ts';
import {
  allFixtures,
  analyseNative,
  FIXTURE_SAMPLE_RATE,
  matchEvents,
  ONSET_TOLERANCE_SECONDS,
  type MusicFixture,
} from './audio-music-fixtures.ts';

const FPS = 60;
const AVS_SAMPLES = 576;

function analyseAvs(fixture: MusicFixture, fps = FPS): number[] {
  const analyser = new AvsAudioAnalyser();
  const left = new Float32Array(AVS_SAMPLES), right = new Float32Array(AVS_SAMPLES);
  const beats: number[] = [];
  const frames = Math.floor(fixture.seconds * fps);
  for (let frame = 0; frame < frames; frame++) {
    const start = Math.round(frame * FIXTURE_SAMPLE_RATE / fps);
    const end = Math.round((frame + 1) * FIXTURE_SAMPLE_RATE / fps);
    const available = Math.max(1, end - start);
    for (let i = 0; i < AVS_SAMPLES; i++) {
      const source = Math.min(end - 1, start + Math.trunc(i * available / AVS_SAMPLES));
      left[i] = fixture.left[source] ?? 0;
      right[i] = fixture.right[source] ?? left[i]!;
    }
    if (analyser.analyse({ left, right }).beat) beats.push(frame / fps);
  }
  return beats;
}

function median(values: readonly number[]): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1]!;
}

const pct = (value: number): string => `${(value * 100).toFixed(0)}%`.padStart(5);
const ms = (value: number): string => Number.isFinite(value) ? `${(value * 1000).toFixed(1)}ms`.padStart(8) : '     n/a';

console.log('audio-detector-divergence-report (diagnostic; native = AdaptiveMultibandDetector, avs = AvsBeatDetector @ 60 fps)');
console.log(`match tolerance ±${ONSET_TOLERANCE_SECONDS * 1000} ms; agree = matched / union; offsets are avs - native`);
console.log('');
console.log(
  'fixture'.padEnd(19) + 'events native   avs  agree native-only avs-only  offset'
  + '  | native R/P    avs R/P    | kicks: native  avs',
);
let totalNative = 0, totalAvs = 0, totalMatched = 0;
for (const fixture of allFixtures()) {
  const native = analyseNative(fixture.left, fixture.right).map(onset => onset.time);
  const avs = analyseAvs(fixture);
  const reference = fixture.events.map(event => event.time);
  const kicks = fixture.events.filter(event => event.kind === 'kick' || event.kind === 'sub').map(event => event.time);
  const cross = matchEvents(native, avs);
  const union = native.length + avs.length - cross.matched;
  const nativeTruth = matchEvents(reference, native);
  const avsTruth = matchEvents(reference, avs);
  totalNative += native.length; totalAvs += avs.length; totalMatched += cross.matched;
  console.log(
    fixture.name.padEnd(19)
    + String(reference.length).padStart(6)
    + String(native.length).padStart(7)
    + String(avs.length).padStart(6)
    + pct(union ? cross.matched / union : 1).padStart(7)
    + String(native.length - cross.matched).padStart(12)
    + String(avs.length - cross.matched).padStart(9)
    + ms(median(cross.offsets))
    + `  | ${nativeTruth.recall.toFixed(2)}/${nativeTruth.precision.toFixed(2)}`.padEnd(15)
    + `${avsTruth.recall.toFixed(2)}/${avsTruth.precision.toFixed(2)}`.padEnd(12)
    + (kicks.length ? `| ${pct(matchEvents(kicks, native).recall)}  ${pct(matchEvents(kicks, avs).recall)}` : '|   n/a    n/a'),
  );
}
const totalUnion = totalNative + totalAvs - totalMatched;
console.log('');
console.log(`overall: ${totalMatched} shared of ${totalUnion} distinct events (${pct(totalUnion ? totalMatched / totalUnion : 1).trim()} agreement); `
  + `native fired alone ${totalNative - totalMatched}x, avs alone ${totalAvs - totalMatched}x.`);
console.log('Divergence is expected by design (frozen AVS lane); this report exists so it is measured, not assumed.');
