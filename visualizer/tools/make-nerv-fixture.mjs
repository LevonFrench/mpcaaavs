// Converts bizarro/evangelion's analysis (data/audio.json + data/spectrum.bin, MIT) into the shared
// song-map contract (src/song-map/types.ts) under tools/fixtures/nerv-reference/.
//   node tools/make-nerv-fixture.mjs <evangelion checkout> [--upstream-wave <out wave.bin>]
// --upstream-wave also writes the synthesized waveform (src/song-map/synth-wave.ts) as upstream's int16
// data/wave.bin, so the reference app's scopes read the same approximate signal as ours.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const src = process.argv[2];
if (!src) { console.error('usage: node tools/make-nerv-fixture.mjs <evangelion checkout> [--upstream-wave <file>]'); process.exit(2); }
const waveOut = process.argv.includes('--upstream-wave') ? process.argv[process.argv.indexOf('--upstream-wave') + 1] : null;
const up = JSON.parse(readFileSync(join(src, 'data/audio.json'), 'utf8'));
const out = resolve(here, 'fixtures/nerv-reference');
mkdirSync(out, { recursive: true });

// Section roles of the reference edit (docs/TREATMENT.md "Song map").
const ROLE = { intro: 'intro', groove1: 'groove', breaka: 'break', groove2: 'groove', break1: 'break', build1: 'build', drop1: 'drop', drop1b: 'drop', break2: 'break', drop2: 'drop', breakdown: 'breakdown', build2: 'build', drop3: 'drop', drop3b: 'drop', outro: 'outro' };
const FEATURES = ['rms', 'low', 'mid', 'high', 'vocal', 'drums', 'bass', 'other'];
const features = Object.fromEntries(FEATURES.map((k) => [k, up.features?.[k] ?? up[k]]));
const meanRms = (s) => {
  const a = features.rms, i0 = Math.floor(s.start * up.fps), i1 = Math.min(a.length, Math.ceil(s.end * up.fps));
  let m = 0; for (let i = i0; i < i1; i++) m += a[i]; return m / Math.max(1, i1 - i0);
};
const means = up.sections.map(meanRms), top = Math.max(...means);
const map = {
  version: 1,
  duration: up.duration,
  bpm: up.bpm,
  fps: up.fps,
  beats: up.beats,
  downbeats: up.downbeats,
  bar0: up.bar0,
  sections: up.sections.map((s, i) => {
    if (!ROLE[s.name]) throw new Error(`no role for section ${s.name}`);
    return { name: s.name, role: ROLE[s.name], start: s.start, end: s.end, energy: Math.round((means[i] / top) * 1000) / 1000 };
  }),
  features,
  onsets: { kick: up.onsets.kick, snare: up.onsets.snare, hat: up.onsets.hat, vocal: up.onsets.vocal },
  bass_midi: up.bass_midi,
  spectrum: { frames: up.spectrum.frames, mel: up.spectrum.mel, chroma: up.spectrum.chroma, fmin: up.spectrum.fmin, fmax: up.spectrum.fmax },
  // hand-cut reference analysis (demucs stems, hand-checked grid and sections): full confidence
  confidence: { tempo: 1, downbeat: 1, sections: 1 },
  approximations: [],
};
writeFileSync(join(out, 'song-map.json'), JSON.stringify(map));
copyFileSync(join(src, 'data/spectrum.bin'), join(out, 'spectrum.bin'));
console.log(`wrote ${join(out, 'song-map.json')} and spectrum.bin (${map.sections.length} sections, ${map.downbeats.length} downbeats)`);

if (waveOut) {
  const b = await build({ entryPoints: [resolve(here, '../src/song-map/synth-wave.ts')], bundle: true, format: 'esm', write: false });
  const { synthesizeWave } = await import(`data:text/javascript;base64,${Buffer.from(b.outputFiles[0].text).toString('base64')}`);
  const spec = new Uint8Array(readFileSync(join(out, 'spectrum.bin')));
  const w = synthesizeWave(map, { spec }, up.wave?.rate ?? 11025);
  const i16 = new Int16Array(w.wave.length);
  for (let i = 0; i < i16.length; i++) i16[i] = Math.max(-32767, Math.min(32767, Math.round(w.wave[i] * 32767)));
  mkdirSync(dirname(resolve(waveOut)), { recursive: true });
  writeFileSync(waveOut, Buffer.from(i16.buffer));
  console.log(`wrote ${resolve(waveOut)} (${w.frames} frames at ${w.rate} Hz, synthesized)`);
}
