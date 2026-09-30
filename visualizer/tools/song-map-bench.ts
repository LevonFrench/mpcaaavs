// Throughput and memory of the song-map scan on long synthetic tracks (not part of `npm run check`).
// The track is the house-128 fixture looped to length and generated block by block, so the source itself stays small.
//   node tools/bench-song-map.mjs [minutes ...]        (default: 5 60)
// One child process per length so `maxRSS` is that run's own peak. The analysis runs in-process through the same
// engine a Worker hosts; a real Worker moves it to another thread but does the same work.
import { InlineSongMapWorker } from '../src/song-map/inline-worker.ts';
import { SongMapScan, type PcmSource, type SongMapUpdate } from '../src/song-map/scan.ts';
import { FIXTURES, renderFixture } from './song-map-fixtures.ts';

const minutes = Number(process.argv[2] ?? 5);
const spec = FIXTURES.find(f => f.name === 'house-128')!;
const fixture = renderFixture(spec);
const rate = spec.sampleRate, loop = fixture.left.length, total = Math.round(minutes * 60 * rate);
const source: PcmSource = {
  sampleRate: rate, totalSamples: total,
  read(start, length) {
    const left = new Float32Array(length), right = new Float32Array(length);
    for (let i = 0, p = start % loop; i < length; i++, p = p + 1 === loop ? 0 : p + 1) { left[i] = fixture.left[p]!; right[i] = fixture.right[p]!; }
    return { left, right };
  },
};
const mb = (bytes: number) => (bytes / 1048576).toFixed(0);
const rss = () => process.memoryUsage().rss;
const baseline = rss();
let peak = baseline, first: SongMapUpdate | null = null, last: SongMapUpdate | null = null, updates = 0, peakHeap = 0;
const t0 = performance.now();
const sample = setInterval(() => { peak = Math.max(peak, rss()); }, 100);
const scan = new SongMapScan({
  worker: new InlineSongMapWorker(task => { setTimeout(task, 0); }), source, now: () => performance.now(),
  onUpdate: update => { updates++; first ??= update; last = update; peakHeap = Math.max(peakHeap, update.heapBytes); peak = Math.max(peak, rss()); },
});
await scan.start();
clearInterval(sample);
const seconds = (performance.now() - t0) / 1000, audio = total / rate;
const maxRss = process.resourceUsage().maxRSS * 1024;
const map = (last as unknown as SongMapUpdate).map;
console.log(JSON.stringify({
  minutes, audioSeconds: Math.round(audio), wallSeconds: +seconds.toFixed(1), realtimeFactor: +(audio / seconds).toFixed(1),
  firstResultSeconds: +((first as unknown as SongMapUpdate).elapsedMs / 1000).toFixed(2), firstResultCoverage: (first as unknown as SongMapUpdate).coverage,
  revisions: updates, bpm: map.bpm, sections: map.sections.length, beats: map.beats.length, complete: (last as unknown as SongMapUpdate).complete,
  analyzerHeapMB: +mb(peakHeap), baselineRssMB: +mb(baseline), peakRssMB: +mb(Math.max(peak, maxRss)), peakRssOverBaselineMB: +mb(Math.max(peak, maxRss) - baseline),
  note: 'looped synthetic house fixture; in-process engine; node ' + process.version,
}));
