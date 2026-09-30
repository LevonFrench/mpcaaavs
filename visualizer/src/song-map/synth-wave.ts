// A plausible stereo waveform synthesized from a song map, for song maps without PCM (AAAVS addition).
//
// The reference fixture (bizarro/evangelion's data/audio.json + spectrum.bin) ships no wave.bin, because
// that file is a playable copy of the song. Scopes still need a signal: this builds one from the analysis
// alone, so it is deterministic and carries the song's structure (kicks, claps, hats, bass pitch, chroma
// pads, vocal chops, band envelopes) but not its actual sound. Scopes drawn from it are APPROXIMATE.
import type { SongMapBinary, SongMapJSON } from './types.ts';

export interface SynthWave { wave: Float32Array; rate: number; channels: 2; frames: number }

const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export function synthesizeWave(map: SongMapJSON, bin?: Partial<SongMapBinary> | null, rate = 11025): SynthWave {
  const frames = Math.max(1, Math.floor(map.duration * rate));
  const out = new Float32Array(frames * 2);
  const fps = map.fps || 100;
  const feat = (k: keyof SongMapJSON['features']) => map.features?.[k] ?? [];
  const F = { low: feat('low'), mid: feat('mid'), high: feat('high'), bass: feat('bass'), vocal: feat('vocal'), other: feat('other'), rms: feat('rms') };
  const env = (a: number[], x: number) => {
    if (!a.length) return 0;
    const i = Math.floor(x);
    if (i < 0) return a[0]!;
    if (i >= a.length - 1) return a[a.length - 1]!;
    return a[i]! + (a[i + 1]! - a[i]!) * (x - i);
  };
  const bassMidi = map.bass_midi ?? [];
  const mel = map.spectrum?.mel ?? 64, S = mel + (map.spectrum?.chroma ?? 12);
  const spec = bin?.spec, specFrames = spec ? Math.floor(spec.length / S) : 0;
  // the three strongest chroma bins per analysis frame, as pad voices
  const voices = new Float32Array(Math.max(1, specFrames) * 6);
  for (let f = 0; f < specFrames; f++) {
    const idx = [...Array(12).keys()].sort((a, b) => spec![f * S + mel + b]! - spec![f * S + mel + a]!);
    for (let v = 0; v < 3; v++) { voices[f * 6 + v * 2] = idx[v]!; voices[f * 6 + v * 2 + 1] = spec![f * S + mel + idx[v]!]! / 255; }
  }
  const on = map.onsets ?? { kick: [], snare: [], hat: [], vocal: [] };
  const lists = { kick: on.kick ?? [], snare: on.snare ?? [], hat: on.hat ?? [], vocal: on.vocal ?? [] };
  const ptr = { kick: 0, snare: 0, hat: 0, vocal: 0 };
  // deterministic noise per channel
  let sL = 0x9e3779b9 >>> 0, sR = 0x7f4a7c15 >>> 0;
  const nz = (ch: 0 | 1) => {
    if (ch === 0) { sL = (Math.imul(sL, 1664525) + 1013904223) >>> 0; return sL / 2147483648 - 1; }
    sR = (Math.imul(sR, 1664525) + 1013904223) >>> 0; return sR / 2147483648 - 1;
  };
  let phB = 0, prevNL = 0, prevNR = 0;
  const phP = new Float64Array(6);
  let peak = 1e-6;
  const TAU = Math.PI * 2;
  for (let n = 0; n < frames; n++) {
    const t = n / rate, x = t * fps;
    const fi = Math.max(0, Math.min(Math.max(0, specFrames - 1), Math.round(x)));
    // bass: pitch from bass_midi (fallback: low E), level from the bass stem / low band
    const bm = bassMidi.length ? bassMidi[Math.max(0, Math.min(bassMidi.length - 1, Math.round(x)))]! : 0;
    const fb = bm > 0 ? midiHz(bm) : 41.2;
    phB += TAU * fb / rate;
    const bassA = 0.42 * Math.max(env(F.bass, x), 0.6 * env(F.low, x));
    const bass = bassA * (Math.sin(phB) + 0.35 * Math.sin(2 * phB) + 0.12 * Math.sin(3 * phB));
    // pads: three chroma voices in octave 4, level from the mid band / harmonic stem
    const padA = 0.16 * Math.max(env(F.other, x), 0.7 * env(F.mid, x));
    let padL = 0, padR = 0;
    for (let v = 0; v < 3; v++) {
      const pc = specFrames ? voices[fi * 6 + v * 2]! : [0, 4, 7][v]!;
      const w = specFrames ? voices[fi * 6 + v * 2 + 1]! : 0.6;
      const f = 261.63 * Math.pow(2, pc / 12);
      phP[v] = (phP[v]! + TAU * f / rate) % TAU;
      phP[v + 3] = (phP[v + 3]! + TAU * f * 1.004 / rate) % TAU; // detuned right voice
      padL += w * Math.sin(phP[v]!); padR += w * Math.sin(phP[v + 3]!);
    }
    padL *= padA; padR *= padA;
    // drums from onsets
    let kick = 0, snL = 0, snR = 0, hatL = 0, hatR = 0, voc = 0;
    const nL = nz(0), nR = nz(1);
    for (const k of ['kick', 'snare', 'hat', 'vocal'] as const) {
      const L = lists[k];
      while (ptr[k] < L.length && L[ptr[k]]![0] <= t) ptr[k]++;
      for (let i = ptr[k] - 1; i >= 0 && i >= ptr[k] - 3; i--) {
        const [ot, s] = L[i]!, dt = t - ot;
        if (k === 'kick') { if (dt > 0.5) break; kick += s * Math.exp(-dt / 0.11) * Math.sin(TAU * (45 * dt + 65 * 0.035 * (1 - Math.exp(-dt / 0.035)))); }
        else if (k === 'snare') { if (dt > 0.4) break; const e = s * Math.exp(-dt / 0.075); snL += e * (0.55 * nL + 0.3 * Math.sin(TAU * 190 * dt)); snR += e * (0.55 * nR + 0.3 * Math.sin(TAU * 190 * dt)); }
        else if (k === 'hat') { if (dt > 0.15) break; const e = s * Math.exp(-dt / 0.022) * 0.28; hatL += e * (nL - prevNL); hatR += e * (nR - prevNR); }
        else { if (dt > 0.6) break; voc += s * Math.exp(-dt / 0.18) * Math.sin(TAU * (523.25 * dt + 0.8 * Math.sin(TAU * 5.5 * dt))); }
      }
    }
    const vocA = 0.1 + 0.25 * env(F.vocal, x);
    const hiA = 0.05 * env(F.high, x);
    const L = bass + padL + 0.8 * kick + snL + hatL + vocA * voc + hiA * nL;
    const R = bass + padR + 0.8 * kick + snR + hatR + vocA * voc + hiA * nR;
    prevNL = nL; prevNR = nR;
    out[2 * n] = L; out[2 * n + 1] = R;
    const m = Math.max(Math.abs(L), Math.abs(R));
    if (m > peak) peak = m;
  }
  const g = 0.98 / peak;
  for (let i = 0; i < out.length; i++) out[i]! *= g;
  return { wave: out, rate, channels: 2, frames };
}
