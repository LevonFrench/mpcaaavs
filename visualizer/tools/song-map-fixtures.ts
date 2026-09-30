// Deterministic synthetic tracks with exact ground truth for the song-map CPU checks.
// Everything is generated in code (no audio files): drums, bass, pads, vocal-like chops,
// risers and snare rolls arranged as intro/groove/break/build/drop/breakdown/outro.

export type Style = 'house' | 'hiphop' | 'trance' | 'dnb';
export type Role = 'intro' | 'groove' | 'break' | 'build' | 'drop' | 'breakdown' | 'outro';

export interface FixtureSpec {
  readonly name: string;
  readonly style: Style;
  readonly sampleRate: number;
  /** Tempo per bar range: [{fromBar, bpm}], first entry fromBar 0. */
  readonly tempo: readonly { readonly fromBar: number; readonly bpm: number }[];
  /** Silence before the first downbeat, seconds (less than one beat). */
  readonly lead: number;
  readonly swing?: number;
  readonly arrangement: readonly { readonly role: Role; readonly bars: number }[];
  readonly seed: number;
  /** Seconds of tail after the last bar. */
  readonly tail?: number;
}

export interface FixtureTruth {
  readonly duration: number;
  readonly beats: number[];
  readonly downbeats: number[];
  readonly regions: { start: number; end: number; bpm: number }[];
  readonly sections: { role: Role; start: number; end: number; startBar: number }[];
  readonly onsets: { kick: number[]; snare: number[]; hat: number[]; vocal: number[] };
  readonly bass: { start: number; end: number; midi: number }[];
  readonly barLength: (t: number) => number;
}

export interface Fixture { readonly spec: FixtureSpec; readonly left: Float32Array; readonly right: Float32Array; readonly truth: FixtureTruth }

export const STANDARD_ARRANGEMENT: readonly { role: Role; bars: number }[] = [
  { role: 'intro', bars: 8 }, { role: 'groove', bars: 16 }, { role: 'break', bars: 8 }, { role: 'build', bars: 8 },
  { role: 'drop', bars: 16 }, { role: 'breakdown', bars: 8 }, { role: 'build', bars: 8 }, { role: 'drop', bars: 16 }, { role: 'outro', bars: 8 },
];

const TABLE = 4096;
const SINE = new Float32Array(TABLE + 1);
for (let i = 0; i <= TABLE; i++) SINE[i] = Math.sin(2 * Math.PI * i / TABLE);
function sine(phase: number): number { const x = (phase - Math.floor(phase)) * TABLE, i = x | 0, f = x - i; return SINE[i]! + (SINE[i + 1]! - SINE[i]!) * f; }
function saw(phase: number): number { return 2 * (phase - Math.floor(phase)) - 1; }
const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

class Rng { constructor(private s: number) { this.s = (s >>> 0) || 1; } next(): number { let x = this.s; x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; this.s = x; return x / 4294967296 * 2 - 1; } }

/** RBJ biquad for voice rendering. */
class Bq {
  z1 = 0; z2 = 0; b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  set(kind: 'lp' | 'hp' | 'bp', hz: number, q: number, rate: number): this {
    const w = 2 * Math.PI * Math.min(hz, rate * .45) / rate, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    if (kind === 'lp') { this.b0 = (1 - c) / 2 / a0; this.b1 = (1 - c) / a0; this.b2 = this.b0; }
    else if (kind === 'hp') { this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; this.b2 = this.b0; }
    else { this.b0 = al / a0; this.b1 = 0; this.b2 = -al / a0; }
    this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0; return this;
  }
  push(x: number): number { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
}

interface Ctx { rate: number; left: Float32Array; right: Float32Array; rng: Rng }
function add(ctx: Ctx, i: number, v: number, pan = 0): void {
  if (i < 0 || i >= ctx.left.length) return;
  ctx.left[i]! += v * (1 - pan) ; ctx.right[i]! += v * (1 + pan);
}

function kick(ctx: Ctx, t: number, amp: number): void {
  const s = Math.round(t * ctx.rate), n = Math.round(.35 * ctx.rate);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const tt = i / ctx.rate, f = 50 + 110 * Math.exp(-tt / .03);
    phase += f / ctx.rate;
    const click = i < ctx.rate * .003 ? ctx.rng.next() * .5 * (1 - i / (ctx.rate * .003)) : 0;
    add(ctx, s + i, amp * (sine(phase) * Math.exp(-tt / .11) + click));
  }
}
function snare(ctx: Ctx, t: number, amp: number, clap = false): void {
  const s = Math.round(t * ctx.rate), n = Math.round(.3 * ctx.rate), bp = new Bq().set('bp', 2200, .7, ctx.rate);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const tt = i / ctx.rate;
    let env = Math.exp(-tt / .075);
    if (clap) env *= tt < .02 ? .6 + .4 * Math.cos(2 * Math.PI * tt / .007) : 1;
    phase += 190 / ctx.rate;
    add(ctx, s + i, amp * (bp.push(ctx.rng.next()) * 2.2 * env + .5 * sine(phase) * Math.exp(-tt / .04)), .05);
  }
}
function hat(ctx: Ctx, t: number, amp: number, open = false): void {
  const s = Math.round(t * ctx.rate), decay = open ? .11 : .022, n = Math.round(decay * 6 * ctx.rate);
  const hp = new Bq().set('hp', 8000, .7, ctx.rate), hp2 = new Bq().set('hp', 8000, .7, ctx.rate);
  for (let i = 0; i < n; i++) add(ctx, s + i, amp * hp2.push(hp.push(ctx.rng.next())) * Math.exp(-i / ctx.rate / decay), -.2);
}
function crash(ctx: Ctx, t: number, amp: number): void {
  const s = Math.round(t * ctx.rate), n = Math.round(2.5 * ctx.rate), hp = new Bq().set('hp', 5000, .7, ctx.rate);
  for (let i = 0; i < n; i++) add(ctx, s + i, amp * hp.push(ctx.rng.next()) * Math.exp(-i / ctx.rate / .7), .3);
}
function bassNote(ctx: Ctx, t: number, dur: number, midi: number, amp: number, duck: readonly number[] | null, reese = false): void {
  const s = Math.round(t * ctx.rate), n = Math.round(dur * ctx.rate), lp = new Bq().set('lp', 420, .8, ctx.rate), f = midiHz(midi);
  let p1 = 0, p2 = 0, k = 0;
  for (let i = 0; i < n; i++) {
    const tt = i / ctx.rate, abs = t + tt;
    p1 += f / ctx.rate; p2 += f * 1.006 / ctx.rate;
    const env = Math.min(1, tt / .008) * Math.min(1, (dur - tt) / .015);
    let g = 1;
    if (duck) { while (k + 1 < duck.length && duck[k + 1]! <= abs) k++; const since = abs - (duck[k] ?? -9); if (since >= 0 && since < .3) g = 1 - .75 * Math.exp(-since / .07); }
    const osc = reese ? .5 * (saw(p1) + saw(p2)) : .7 * saw(p1) + .5 * sine(p1);
    add(ctx, s + i, amp * g * env * lp.push(osc));
  }
}
function pad(ctx: Ctx, t: number, dur: number, chord: readonly number[], amp: number): void {
  const s = Math.round(t * ctx.rate), n = Math.round((dur + .4) * ctx.rate);
  const phases = new Float64Array(chord.length * 2);
  for (let i = 0; i < n; i++) {
    const tt = i / ctx.rate, env = Math.min(1, tt / .25) * (tt > dur ? Math.exp(-(tt - dur) / .12) : 1);
    let v = 0;
    for (let c = 0; c < chord.length; c++) {
      const f = midiHz(chord[c]!);
      phases[2 * c]! += f * .998 / ctx.rate; phases[2 * c + 1]! += f * 1.002 / ctx.rate;
      const a = phases[2 * c]!, b = phases[2 * c + 1]!;
      v += sine(a) + sine(b) + .35 * (sine(2 * a) + sine(2 * b)) + .15 * sine(3 * a);
    }
    add(ctx, s + i, amp * env * v / chord.length, (Math.sin(tt * .7) * .2));
  }
}
function vocal(ctx: Ctx, t: number, midi: number, amp: number): void {
  const s = Math.round(t * ctx.rate), dur = .2, n = Math.round(dur * ctx.rate), f = midiHz(midi);
  const weights = [1, .9, .7, 1.1, .8, .45, .3, .2];
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const tt = i / ctx.rate;
    phase += f * (1 + .012 * Math.sin(2 * Math.PI * 5.5 * tt)) / ctx.rate;
    let v = 0; for (let h = 0; h < weights.length; h++) v += weights[h]! * sine((h + 1) * phase) / (h + 1) ** .3;
    const env = Math.min(1, tt / .012) * Math.exp(-Math.max(0, tt - .05) / .07);
    add(ctx, s + i, amp * env * v / 3, .1);
  }
}
function riser(ctx: Ctx, t: number, dur: number, amp: number): void {
  const s = Math.round(t * ctx.rate), n = Math.round(dur * ctx.rate), bq = new Bq();
  for (let i = 0; i < n; i++) {
    const x = i / n;
    if ((i & 63) === 0) bq.set('bp', 400 + 6000 * x * x, 1.2, ctx.rate);
    add(ctx, s + i, amp * x * x * bq.push(ctx.rng.next()) * 2);
  }
}
function lead(ctx: Ctx, t: number, dur: number, chord: readonly number[], amp: number): void {
  const s = Math.round(t * ctx.rate), n = Math.round(dur * ctx.rate), lp = new Bq().set('lp', 3000, .7, ctx.rate);
  const phases = new Float64Array(chord.length);
  for (let i = 0; i < n; i++) {
    const tt = i / ctx.rate, env = Math.min(1, tt / .005) * Math.exp(-tt / .12);
    let v = 0; for (let c = 0; c < chord.length; c++) { phases[c]! += midiHz(chord[c]! + 12) / ctx.rate; v += saw(phases[c]!); }
    add(ctx, s + i, amp * env * lp.push(v / chord.length), -.15);
  }
}

const BASS_ROOTS = [33, 29, 31, 28];            // A1 F1 G1 E1 (55 / 43.7 / 49 / 41.2 Hz)
const CHORDS = [[57, 60, 64], [53, 57, 60], [55, 59, 62], [52, 55, 59]];
const VOCAL_NOTES = [69, 71, 72, 74, 76];

export function renderFixture(spec: FixtureSpec): Fixture {
  const rate = spec.sampleRate, bars = spec.arrangement.reduce((s, a) => s + a.bars, 0);
  // Beat grid (4/4) through the tempo map.
  const beatTimes: number[] = [];
  let t = spec.lead;
  for (let beat = 0; beat <= bars * 4; beat++) {
    beatTimes.push(t);
    const bar = Math.floor(beat / 4);
    let bpm = spec.tempo[0]!.bpm; for (const e of spec.tempo) if (bar >= e.fromBar) bpm = e.bpm;
    t += 60 / bpm;
  }
  const duration = beatTimes[bars * 4]! + (spec.tail ?? 1.5);
  const total = Math.ceil(duration * rate);
  const ctx: Ctx = { rate, left: new Float32Array(total), right: new Float32Array(total), rng: new Rng(spec.seed) };
  const beatAt = (b: number) => {
    if (b <= 0) return beatTimes[0]! + b * (beatTimes[1]! - beatTimes[0]!);
    const i = Math.min(beatTimes.length - 2, Math.floor(b)), f = b - i;
    return beatTimes[i]! + f * (beatTimes[i + 1]! - beatTimes[i]!);
  };
  const step = (bar: number, s16: number) => {
    let s = s16;
    // Swing delays the off-beat eighths (0.5 = straight).
    if (spec.swing && s16 % 4 === 2) s = s16 - 2 + 4 * spec.swing;
    return beatAt(bar * 4 + s / 4);
  };
  const truth = { kick: [] as number[], snare: [] as number[], hat: [] as number[], vocal: [] as number[] };
  const bassTruth: { start: number; end: number; midi: number }[] = [];
  const sections: { role: Role; start: number; end: number; startBar: number }[] = [];
  const style = spec.style;
  const kickSteps = style === 'hiphop' ? [0, 7, 10] : style === 'dnb' ? [0, 10] : [0, 4, 8, 12];
  const snareSteps = [4, 12];
  let bar0 = 0;
  const kicksOf: number[] = [];
  // First pass: drums, so bass ducking knows the kick times.
  const plan: { role: Role; bar: number; index: number; within: number; len: number }[] = [];
  for (const section of spec.arrangement) {
    for (let i = 0; i < section.bars; i++) plan.push({ role: section.role, bar: bar0 + i, index: sections.length, within: i, len: section.bars });
    sections.push({ role: section.role, start: beatAt(bar0 * 4), end: beatAt((bar0 + section.bars) * 4), startBar: bar0 });
    bar0 += section.bars;
  }
  sections[0] = { ...sections[0]!, start: 0 };
  sections[sections.length - 1] = { ...sections[sections.length - 1]!, end: duration };
  const vr = new Rng(spec.seed ^ 0x9e3779b9);
  for (const p of plan) {
    const { role, bar, within, len } = p;
    const drums = role === 'groove' || role === 'drop' || role === 'build';
    if (drums) {
      const steps = role === 'build' ? [0, 4, 8, 12] : kickSteps;
      for (const s of steps) { const at = step(bar, s); kick(ctx, at, role === 'drop' ? .9 : .8); truth.kick.push(at); kicksOf.push(at); }
    }
    if (role === 'groove' || role === 'drop') {
      const fill = role === 'groove' && within === len - 1;
      for (const s of fill ? [4, 10, 12, 14] : snareSteps) { const at = step(bar, s); snare(ctx, at, .5, style === 'house' || style === 'trance'); truth.snare.push(at); }
    }
    if (role === 'build') {
      const sixteenth = within >= len / 2, amp = .18 + .3 * within / len;
      for (let s = 0; s < 16; s += sixteenth ? 1 : 2) { const at = step(bar, s); snare(ctx, at, amp); truth.snare.push(at); }
      if (within % 2 === 1) for (const s of [2, 10]) { const at = step(bar, s); vocal(ctx, at, VOCAL_NOTES[Math.floor((vr.next() + 1) * 2.5)]!, .22); truth.vocal.push(at); }
      if (within === 0) riser(ctx, step(bar, 0), beatAt((bar + len) * 4) - step(bar, 0), .12);
    }
    const hats = role === 'groove' || role === 'drop' || (role === 'outro' && within < len / 2);
    if (hats) {
      if (style === 'house' || style === 'trance') for (const s of [2, 6, 10, 14]) { const at = step(bar, s); hat(ctx, at, .22, true); truth.hat.push(at); }
      else for (let s = 0; s < 16; s += 2) { if (s === 4 || s === 12) continue; const at = step(bar, s); hat(ctx, at, .2); if (!kickSteps.includes(s)) truth.hat.push(at); }
    }
    if (role === 'drop' && within === 0) { const at = step(bar, 0); crash(ctx, at, .18); }
    if (role === 'breakdown' && within === len - 2) { const at = step(bar, 8); vocal(ctx, at, 72, .22); truth.vocal.push(at); }
  }
  kicksOf.sort((x, y) => x - y);
  for (const p of plan) {
    const { role, bar } = p;
    const chord = CHORDS[bar % 4]!, root = BASS_ROOTS[bar % 4]!;
    const barStart = beatAt(bar * 4), barEnd = beatAt(bar * 4 + 4);
    if (role !== 'drop' || style === 'hiphop' || style === 'dnb') pad(ctx, barStart, barEnd - barStart, chord, role === 'groove' || role === 'drop' ? .07 : .1);
    const bass = role === 'groove' || role === 'drop' || role === 'break';
    if (bass) {
      const amp = role === 'drop' ? .5 : .4;
      if (style === 'house' || style === 'trance') {
        const steps = style === 'house' ? [2, 6, 10, 14] : [1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15];
        const noteLen = style === 'house' ? beatAt(bar * 4 + .45) - barStart : beatAt(bar * 4 + .2) - barStart;
        for (const s of steps) { const at = step(bar, s); bassNote(ctx, at, noteLen, root, amp, role === 'break' ? null : kicksOf); bassTruth.push({ start: at, end: at + noteLen, midi: root }); }
      } else {
        const halves = style === 'hiphop' ? [[0, 2], [2, 4]] : [[0, 4]];
        for (const [a, b] of halves) {
          const s0 = beatAt(bar * 4 + a!), s1 = beatAt(bar * 4 + b!) - .01;
          bassNote(ctx, s0, s1 - s0, root, amp, null, style === 'dnb'); bassTruth.push({ start: s0, end: s1, midi: root });
        }
      }
    }
    if (role === 'drop') for (const s of [2, 6, 10, 14]) lead(ctx, step(bar, s), .18, chord, .12);
  }
  // Truth grid: every beat of the (extended) grid inside the file.
  const beats: number[] = [], downbeats: number[] = [];
  const period0 = beatTimes[1]! - beatTimes[0]!;
  for (let k = -8; k < 0; k++) { const tt = beatTimes[0]! + k * period0; if (tt >= 0) { beats.push(tt); if (((k % 4) + 4) % 4 === 0) downbeats.push(tt); } }
  const lastPeriod = beatTimes[beatTimes.length - 1]! - beatTimes[beatTimes.length - 2]!;
  for (let k = 0; ; k++) {
    const tt = k < beatTimes.length ? beatTimes[k]! : beatTimes[beatTimes.length - 1]! + (k - beatTimes.length + 1) * lastPeriod;
    if (tt > duration) break;
    beats.push(tt); if (k % 4 === 0) downbeats.push(tt);
  }
  const regions = spec.tempo.map((e, i) => ({ start: i === 0 ? 0 : beatAt(e.fromBar * 4), end: i + 1 < spec.tempo.length ? beatAt(spec.tempo[i + 1]!.fromBar * 4) : duration, bpm: e.bpm }));
  for (const list of Object.values(truth)) list.sort((x, y) => x - y);
  // Keep headroom: peak-normalise to 0.9.
  let peak = 0; for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(ctx.left[i]!), Math.abs(ctx.right[i]!));
  const g = peak > 0 ? .9 / peak : 1; for (let i = 0; i < total; i++) { ctx.left[i]! *= g; ctx.right[i]! *= g; }
  const barLength = (tt: number) => {
    let bpm = spec.tempo[0]!.bpm; for (const r of regions) if (tt >= r.start) bpm = r.bpm;
    return 240 / bpm;
  };
  return { spec, left: ctx.left, right: ctx.right, truth: { duration, beats, downbeats, regions, sections, onsets: truth, bass: bassTruth, barLength } };
}

export const FIXTURES: readonly FixtureSpec[] = [
  { name: 'house-128', style: 'house', sampleRate: 44100, tempo: [{ fromBar: 0, bpm: 128 }], lead: .37, arrangement: STANDARD_ARRANGEMENT, seed: 11 },
  { name: 'hiphop-90-swing', style: 'hiphop', sampleRate: 44100, tempo: [{ fromBar: 0, bpm: 90 }], lead: .21, swing: .62, arrangement: STANDARD_ARRANGEMENT, seed: 23 },
  { name: 'trance-133.33', style: 'trance', sampleRate: 44100, tempo: [{ fromBar: 0, bpm: 400 / 3 }], lead: .05, arrangement: STANDARD_ARRANGEMENT, seed: 37 },
  { name: 'dnb-174', style: 'dnb', sampleRate: 48000, tempo: [{ fromBar: 0, bpm: 174 }], lead: .12, arrangement: STANDARD_ARRANGEMENT, seed: 41 },
  { name: 'house-120-to-128', style: 'house', sampleRate: 44100, tempo: [{ fromBar: 0, bpm: 120 }, { fromBar: 40, bpm: 128 }], lead: 0, arrangement: STANDARD_ARRANGEMENT, seed: 53 },
];

/** Ground-truth bass line: sustained notes from E1 to C3 (41 Hz to 131 Hz), no drums. Exercises the bass pitch track alone. */
export function renderBassFixture(sampleRate = 44100): { left: Float32Array; right: Float32Array; truth: Pick<FixtureTruth, 'duration' | 'bass' | 'onsets'> } {
  const midis = [28, 31, 33, 36, 40, 43, 45, 38, 35, 30, 41, 47, 34, 29, 44, 48];
  const noteLen = .7, gap = .1, lead = 1, duration = lead + midis.length * (noteLen + gap) + 1;
  const total = Math.ceil(duration * sampleRate);
  const ctx: Ctx = { rate: sampleRate, left: new Float32Array(total), right: new Float32Array(total), rng: new Rng(7) };
  const bass: FixtureTruth['bass'] = [];
  midis.forEach((midi, i) => {
    const start = lead + i * (noteLen + gap);
    bassNote(ctx, start, noteLen, midi, .5, null, i % 2 === 1);
    bass.push({ start, end: start + noteLen, midi });
  });
  let peak = 0; for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(ctx.left[i]!), Math.abs(ctx.right[i]!));
  const g = peak > 0 ? .9 / peak : 1; for (let i = 0; i < total; i++) { ctx.left[i]! *= g; ctx.right[i]! *= g; }
  return { left: ctx.left, right: ctx.right, truth: { duration, bass, onsets: { kick: [], snare: [], hat: [], vocal: [] } } };
}
