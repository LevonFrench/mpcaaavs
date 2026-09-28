/**
 * NERV instrument collection. Plate concepts and geometric vocabulary adapted
 * from bizarro/evangelion (MIT), Copyright (c) 2026 Giacomo Magnanini and Luis
 * Bizarro. See THIRD-PARTY-NERV.txt for the upstream license and source link.
 *
 * These are stateless live-audio instruments, not the original video's analysed
 * stems. Every moving part is computed from media time, seed and this audio frame.
 */
import type { AvsAudioFrame } from './avs/types.ts';

export const NERV_SCENES = ['boot', 'magi', 'psycho', 'radar', 'harmonics', 'seele', 'battery', 'atfield', 'alert', 'plug', 'target', 'city', 'sync', 'berserk', 'impact', 'end'] as const;
export type NervSceneId = typeof NERV_SCENES[number];
export interface NervSceneFrame {
  readonly scene: NervSceneId;
  readonly time: number;
  readonly localTime: number;
  readonly progress: number;
  readonly bpm: number;
  readonly seed: number;
  readonly audio: AvsAudioFrame;
}
type Context = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
const TAU = Math.PI * 2;
const INK = '#050605', ORANGE = '#ff8526', AMBER = '#ffc15a', GREEN = '#55e997';
const CYAN = '#58d6ef', RED = '#ff5353', PURPLE = '#b48be8', LIME = '#b8ec65', BONE = '#eee4d1';
const clamp = (value: number, low = 0, high = 1): number => Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
const fract = (value: number): number => value - Math.floor(value);
const finite = (value: number): number => Number.isFinite(value) ? value : 0;
function noise(index: number, seed: number): number {
  let n = (Math.imul(index + 31, 0x45d9f3b) ^ seed) >>> 0;
  n = Math.imul(n ^ n >>> 16, 0x45d9f3b);
  return ((n ^ n >>> 16) >>> 0) / 4294967296;
}
function label(c: Context, value: string, x: number, y: number, size = 12, color = ORANGE, align: CanvasTextAlign = 'left'): void {
  c.font = `600 ${size}px Consolas, "Courier New", monospace`;
  c.fillStyle = color; c.textAlign = align; c.textBaseline = 'alphabetic'; c.fillText(value, x, y);
}
function title(c: Context, value: string, x: number, y: number, size: number, color = BONE, squeeze = .7): void {
  c.save(); c.translate(x, y); c.scale(squeeze, 1);
  c.font = `bold ${size}px Georgia, "Times New Roman", serif`;
  c.textAlign = 'left'; c.textBaseline = 'alphabetic'; c.fillStyle = color;
  c.fillText(value, 0, 0); c.restore();
}
function line(c: Context, x1: number, y1: number, x2: number, y2: number, color = ORANGE, width = 1): void {
  c.strokeStyle = color; c.lineWidth = width; c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
}
function polygon(c: Context, x: number, y: number, r: number, sides: number, angle = 0): void {
  c.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = angle + i * TAU / sides;
    const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
    if (i) c.lineTo(px, py); else c.moveTo(px, py);
  }
  c.closePath();
}
function circle(c: Context, x: number, y: number, r: number, color = ORANGE, width = 1): void {
  c.strokeStyle = color; c.lineWidth = width; c.beginPath(); c.arc(x, y, Math.max(0, r), 0, TAU); c.stroke();
}
function panel(c: Context, x: number, y: number, w: number, h: number, text: string, color = ORANGE): void {
  c.fillStyle = '#0c1111'; c.strokeStyle = color; c.lineWidth = 1;
  c.beginPath(); c.moveTo(x, y); c.lineTo(x + w - 14, y); c.lineTo(x + w, y + 14);
  c.lineTo(x + w, y + h); c.lineTo(x + 14, y + h); c.lineTo(x, y + h - 14); c.closePath(); c.fill(); c.stroke();
  c.fillStyle = color; c.fillRect(x + 1, y + 1, Math.min(w - 18, 12 + text.length * 7), 20);
  label(c, text, x + 7, y + 15, 11, INK);
}
function brackets(c: Context, x: number, y: number, w: number, h: number, color = CYAN): void {
  const d = Math.min(18, w * .18, h * .18);
  for (const [xx, yy, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]] as const) {
    line(c, xx, yy + sy * d, xx, yy, color, 2); line(c, xx, yy, xx + sx * d, yy, color, 2);
  }
}
function hazard(c: Context, x: number, y: number, w: number, h: number, phase: number, color = ORANGE): void {
  c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip(); c.fillStyle = color;
  for (let p = -h - 40 + ((phase % 40) + 40) % 40; p < w; p += 40) {
    c.beginPath(); c.moveTo(x + p, y + h); c.lineTo(x + p + h, y);
    c.lineTo(x + p + h + 18, y); c.lineTo(x + p + 18, y + h); c.closePath(); c.fill();
  }
  c.restore();
}
function meter(c: Context, x: number, y: number, w: number, h: number, value: number, color = GREEN, count = 24): void {
  const v = clamp(value), unit = w / count;
  for (let i = 0; i < count; i++) {
    c.fillStyle = i / count < v ? color : '#172120'; c.fillRect(x + i * unit, y, Math.max(1, unit - 2), h);
  }
}
function grid(c: Context, x: number, y: number, w: number, h: number, step = 30): void {
  c.save(); c.globalAlpha = .24;
  for (let px = x; px <= x + w; px += step) line(c, px, y, px, y + h, '#537062');
  for (let py = y; py <= y + h; py += step) line(c, x, py, x + w, py, '#537062');
  c.restore();
}
// The 512-point FFT occupies slots0..511 (two AVS bytes per frequency bin).
// Slots512..575 are the legacy decaying tail, not additional high frequencies.
function spectrumValue(audio: AvsAudioFrame, index: number): number {
  return ((audio.spectrum[0][index] ?? 0) + (audio.spectrum[1][index] ?? 0)) / 510;
}
function band(audio: AvsAudioFrame, start: number, end: number): number {
  let sum = 0, peak = 0;
  for (let i = start; i < end; i++) { const v = spectrumValue(audio, i); sum += v * v; peak = Math.max(peak, v); }
  return clamp(.6 * peak + .4 * Math.sqrt(sum / Math.max(1, end - start)));
}
function wave(audio: AvsAudioFrame, index: number, channel: 0 | 1): number {
  const b = audio.waveform[channel][index] ?? 0;
  return ((b ^ 128) - 128) / 128;
}
function scope(c: Context, audio: AvsAudioFrame, x: number, y: number, w: number, h: number, color = GREEN, channel: 0 | 1 = 0, points = 288): void {
  line(c, x, y + h / 2, x + w, y + h / 2, '#24443a');
  c.strokeStyle = color; c.lineWidth = 1.5; c.beginPath();
  for (let i = 0; i < points; i++) {
    const xx = x + i / (points - 1) * w;
    const yy = y + h / 2 - wave(audio, Math.floor(i / (points - 1) * 575), channel) * h * .45;
    if (i) c.lineTo(xx, yy); else c.moveTo(xx, yy);
  }
  c.stroke();
}
function spectrum(c: Context, audio: AvsAudioFrame, x: number, y: number, w: number, h: number, color = ORANGE, count = 64, raw = false): void {
  const max = raw ? 576 : 512, unit = w / count;
  for (let i = 0; i < count; i++) {
    // A logarithmic frequency axis keeps bass and treble equally legible.
    const from = raw ? Math.floor(i * max / count) : Math.floor(Math.expm1(i / count * Math.log(513)));
    const to = raw ? Math.floor((i + 1) * max / count) : Math.floor(Math.expm1((i + 1) / count * Math.log(513)));
    const v = band(audio, Math.min(from, max - 1), Math.min(max, Math.max(from + 1, to)));
    c.fillStyle = color; c.fillRect(x + i * unit, y + h - v * h, Math.max(1, unit - 2), v * h);
    c.fillStyle = '#243330'; c.fillRect(x + i * unit, y + h + 2, Math.max(1, unit - 2), 1);
  }
}
function hexField(c: Context, cx: number, cy: number, radius: number, t: number, low: number, high: number, seed: number, color = ORANGE): void {
  for (let row = -4; row <= 4; row++) for (let col = -6; col <= 6; col++) {
    const x = cx + col * 48 + (Math.abs(row) % 2) * 24, y = cy + row * 42;
    const distance = Math.hypot(x - cx, y - cy);
    if (distance > radius) continue;
    c.save(); c.globalAlpha = .12 + .35 * (1 - distance / radius) + high * .2;
    c.strokeStyle = color; c.lineWidth = 1;
    polygon(c, x, y, 24 + Math.sin(distance * .025 - t * 2) * (1 + low * 3), 6, Math.PI / 6); c.stroke();
    if (noise(row * 17 + col, seed) > .86) { c.globalAlpha *= .3 + low * .4; c.fillStyle = color; c.fill(); }
    c.restore();
  }
}
interface Signals { low: number; mid: number; high: number; level: number; beats: number; phase: number; bar: number }
function chrome(c: Context, f: NervSceneFrame, a: Signals, accent: string): void {
  const index = NERV_SCENES.indexOf(f.scene) + 1;
  label(c, 'NERV / AUDIO TERMINAL', 24, 27, 14, accent);
  label(c, `${String(index).padStart(2, '0')} / 16   ${f.scene.toUpperCase()}`, 480, 27, 12, BONE, 'center');
  label(c, `${f.bpm.toFixed(1)} BPM  /  BAR ${String(a.bar + 1).padStart(4, '0')}`, 936, 27, 12, accent, 'right');
  line(c, 24, 39, 936, 39, accent);
  label(c, 'LO', 24, 62, 10, ORANGE); meter(c, 47, 53, 120, 8, a.low, ORANGE, 20);
  label(c, 'MID', 185, 62, 10, GREEN); meter(c, 216, 53, 120, 8, a.mid, GREEN, 20);
  label(c, 'HI', 354, 62, 10, CYAN); meter(c, 377, 53, 120, 8, a.high, CYAN, 20);
  label(c, 'LIVE STEREO / 44.1 kHz', 936, 61, 10, '#90a39a', 'right');
  line(c, 24, 492, 936, 492, accent);
  label(c, `T+ ${f.time.toFixed(2).padStart(8, '0')}   /   LOCAL ${f.localTime.toFixed(2)}`, 24, 514, 11, accent);
  label(c, 'RAW AVS 576', 500, 514, 9, '#90a39a');
  spectrum(c, f.audio, 585, 499, 220, 16, accent, 48, true);
  for (let i = 0; i < 4; i++) { c.fillStyle = i === Math.floor(a.beats) % 4 ? accent : '#24302b'; c.fillRect(838 + i * 25, 503, 17, 9); }
}
function boot(c: Context, f: NervSceneFrame, a: Signals): void {
  panel(c, 24, 86, 524, 386, 'SYSTEM START');
  const rows = ['NERV OPERATING SYSTEM // AAAVS', 'INITIALIZING SIGNAL BUS', 'PCM STEREO...........CONNECTED', 'LOW / MID / HIGH....MONITORING', 'MAGI INTERFACE.......ONLINE', 'MEDIA CLOCK..........LOCKED', 'FRAME STATE..........REPEATABLE', 'STANDBY FOR AUDIO INPUT'];
  const reveal = Math.floor(f.localTime * 3) + 1;
  rows.forEach((value, i) => {
    if (i < reveal) { label(c, String(i).padStart(2, '0'), 43, 140 + i * 32, 11, '#798b7c'); label(c, value, 78, 140 + i * 32, 14, i > 3 ? GREEN : ORANGE); }
  });
  const cursorY = 140 + Math.min(8, reveal) * 32;
  c.fillStyle = AMBER; c.fillRect(78, Math.min(445, cursorY), 9, 3);
  hexField(c, 752, 246, 156, f.localTime, a.low, a.high, f.seed);
  c.strokeStyle = AMBER; c.lineWidth = 2; polygon(c, 752, 246, 100 + a.low * 14, 6, Math.PI / 6); c.stroke();
  title(c, 'NERV', 653, 271, 64, BONE, .82);
  label(c, 'SIGNAL: LIVE', 752, 369, 15, GREEN, 'center');
  scope(c, f.audio, 590, 390, 323, 66, CYAN);
}
function magi(c: Context, f: NervSceneFrame, a: Signals): void {
  line(c, 480, 228, 277, 352, ORANGE, 5); line(c, 480, 228, 684, 352, ORANGE, 5); line(c, 277, 352, 684, 352, ORANGE, 5);
  const cells = [[354, 88, 'MELCHIOR / 01', 'LOW FREQUENCIES', a.low, ORANGE], [131, 282, 'BALTHASAR / 02', 'MID FREQUENCIES', a.mid, GREEN], [577, 282, 'CASPER / 03', 'HIGH FREQUENCIES', a.high, CYAN]] as const;
  for (const [x, y, name, caption, level, color] of cells) {
    panel(c, x, y, 250, 146, name, color); label(c, caption, x + 15, y + 43, 11, color);
    title(c, `${Math.round(level * 100)}`, x + 15, y + 104, 64, BONE);
    label(c, '%', x + 110, y + 100, 25, color); label(c, level > .3 ? 'ACTIVE' : 'MONITOR', x + 232, y + 91, 13, color, 'right');
    meter(c, x + 15, y + 120, 220, 11, level, color);
  }
  label(c, 'MAGI', 480, 276, 27, BONE, 'center');
  label(c, 'THREE CHANNEL DELIBERATION', 480, 463, 13, ORANGE, 'center');
}
function psycho(c: Context, f: NervSceneFrame, a: Signals): void {
  panel(c, 24, 85, 686, 386, 'PSYCHOGRAPH / LIVE PCM', GREEN);
  for (let i = 0; i < 4; i++) {
    const y = 121 + i * 83; grid(c, 127, y, 559, 68, 28);
    label(c, i % 2 ? 'RIGHT' : 'LEFT', 42, y + 29, 12, GREEN); label(c, `CH / 0${i + 1}`, 42, y + 48, 10, '#90a39a');
    scope(c, f.audio, 127, y + 4, 559, 62, i < 2 ? GREEN : CYAN, (i % 2) as 0 | 1);
  }
  panel(c, 735, 85, 201, 386, 'SIGNAL STATUS', GREEN);
  title(c, 'PSYCHO', 752, 158, 35, GREEN, .65);
  for (const [i, value, name, color] of [[0, a.low, '0–400 Hz', ORANGE], [1, a.mid, '400–4k Hz', GREEN], [2, a.high, '4k–22k Hz', CYAN]] as const) {
    label(c, name, 752, 220 + i * 72, 12, color); label(c, `${Math.round(value * 100)}%`, 917, 220 + i * 72, 15, color, 'right');
    meter(c, 752, 235 + i * 72, 166, 12, value, color, 16);
  }
  label(c, 'STEREO / SIGNED PCM', 752, 449, 11, '#90a39a');
}
function radarInstrument(c: Context, f: NervSceneFrame, x: number, y: number, r: number, phase: number, color = ORANGE): void {
  for (let i = 1; i <= 4; i++) circle(c, x, y, i * r / 4, i === 4 ? color : '#37493d');
  line(c, x - r, y, x + r, y, '#37493d'); line(c, x, y - r, x, y + r, '#37493d');
  const angle = phase * TAU - Math.PI / 2;
  c.save(); c.globalAlpha = .09; c.fillStyle = color; c.beginPath(); c.moveTo(x, y); c.arc(x, y, r, angle - .42, angle); c.closePath(); c.fill(); c.restore();
  line(c, x, y, x + Math.cos(angle) * r, y + Math.sin(angle) * r, color, 2);
  for (let i = 0; i < 16; i++) {
    const theta = noise(i, f.seed) * TAU, rr = r * (.15 + noise(i + 20, f.seed) * .76);
    const px = x + Math.cos(theta) * rr, py = y + Math.sin(theta) * rr;
    const level = band(f.audio, i * 32, (i + 1) * 32);
    c.fillStyle = i === 0 ? CYAN : color; c.fillRect(px - 2, py - 2, 3 + level * 5, 3 + level * 5);
  }
}
function radar(c: Context, f: NervSceneFrame, a: Signals): void {
  panel(c, 24, 85, 222, 386, 'CONTACTS'); panel(c, 714, 85, 222, 386, 'TARGET ANALYSIS', CYAN);
  radarInstrument(c, f, 480, 281, 177, fract(a.beats / 4));
  for (let i = 0; i < 7; i++) {
    const level = band(f.audio, i * 73, Math.min(512, (i + 1) * 73));
    label(c, `UNIT ${String(i + 1).padStart(2, '0')}`, 42, 136 + i * 39, 12, i === 0 ? CYAN : ORANGE);
    meter(c, 128, 126 + i * 39, 98, 10, level, i === 0 ? CYAN : ORANGE, 12);
  }
  label(c, 'PATTERN BLUE', 734, 145, 17, CYAN); title(c, `${Math.round(a.low * 100)}`, 733, 221, 74, BONE);
  label(c, 'BASS ENERGY / %', 734, 247, 11, CYAN);
  scope(c, f.audio, 734, 274, 181, 101, CYAN);
  label(c, 'SCAN: 1 TURN / BAR', 734, 429, 11, ORANGE);
  label(c, 'TACTICAL / SIGNAL FIELD', 480, 471, 12, ORANGE, 'center');
}
function harmonics(c: Context, f: NervSceneFrame, _a: Signals): void {
  panel(c, 24, 85, 912, 268, 'HARMONICS / LOG FREQUENCY SPECTRUM');
  grid(c, 44, 128, 872, 185, 44); spectrum(c, f.audio, 44, 131, 872, 180, ORANGE, 80);
  for (const [text, x] of [['86 Hz', 144], ['500', 319], ['2 kHz', 514], ['8 kHz', 708], ['22 kHz', 885]] as const) label(c, text, x, 337, 11, '#a0ada4', 'center');
  panel(c, 24, 371, 912, 100, 'STEREO WAVEFORM', CYAN);
  scope(c, f.audio, 195, 395, 718, 31, CYAN, 0); scope(c, f.audio, 195, 434, 718, 31, GREEN, 1);
  label(c, 'L / R', 44, 438, 24, BONE);
}
function seele(c: Context, f: NervSceneFrame, _a: Signals): void {
  title(c, 'SOUND ONLY', 286, 139, 54, RED, .8);
  for (let i = 0; i < 12; i++) {
    const row = i < 6 ? 0 : 1, column = i % 6;
    const x = 68 + column * 139, y = 177 + row * 140 + Math.sin(f.localTime * .35 + i) * 5;
    const level = band(f.audio, Math.floor(i * 512 / 12), Math.floor((i + 1) * 512 / 12));
    c.save(); c.globalAlpha = .4 + level * .6; panel(c, x, y, 122, 117, String(i + 1).padStart(2, '0'), RED);
    title(c, String(i + 1).padStart(2, '0'), x + 24, y + 77, 49, RED, .8); label(c, 'SOUND ONLY', x + 61, y + 103, 10, RED, 'center'); c.restore();
    line(c, x + 7, y + 115, x + 7 + 108 * level, y + 115, RED, 3);
  }
  label(c, '12 FREQUENCY ZONES / LIVE SIGNAL', 480, 466, 11, '#b28e8c', 'center');
}
const DIGITS: Readonly<Record<string, string>> = { '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgcde', '7': 'abc', '8': 'abcdefg', '9': 'abfgcd' };
function digits(c: Context, value: string, x: number, y: number, h: number, color: string): void {
  let cursor = x; const w = h * .51, thick = h * .085;
  for (const character of value) {
    if (character === ':') { c.fillStyle = color; c.fillRect(cursor, y + h * .3, thick, thick); c.fillRect(cursor, y + h * .7, thick, thick); cursor += thick * 3; continue; }
    const segments = [[0, 0, w, thick], [w - thick, 0, thick, h / 2], [w - thick, h / 2, thick, h / 2], [0, h - thick, w, thick], [0, h / 2, thick, h / 2], [0, 0, thick, h / 2], [0, h / 2 - thick / 2, w, thick]];
    segments.forEach(([xx, yy, ww, hh], i) => { c.fillStyle = (DIGITS[character] ?? '').includes('abcdefg'[i]!) ? color : '#221e18'; c.fillRect(cursor + xx!, y + yy!, ww!, hh!); });
    cursor += w + h * .15;
  }
}
function battery(c: Context, f: NervSceneFrame, a: Signals): void {
  panel(c, 24, 85, 912, 386, 'INTERNAL POWER / FOUR-BAR CLOCK', AMBER);
  label(c, 'ACTIVITY LIMIT', 480, 151, 23, AMBER, 'center');
  const beatSeconds = 60 / f.bpm;
  const remaining = Math.max(0, Math.ceil((1 - fract(a.beats / 16)) * 16 * beatSeconds));
  const clock = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  digits(c, clock, 239, 179, 145, AMBER);
  label(c, 'FOUR-BAR CYCLE', 480, 353, 13, ORANGE, 'center');
  meter(c, 139, 379, 682, 23, 1 - fract(a.beats / 16), AMBER, 48);
  label(c, `SIGNAL LOAD ${Math.round(a.level * 100)}%`, 140, 443, 13, GREEN);
  label(c, 'EXTERNAL / DISCONNECTED', 820, 443, 13, RED, 'right');
}
function atfield(c: Context, f: NervSceneFrame, a: Signals): void {
  hexField(c, 590, 283, 282, f.localTime, a.low, a.high, f.seed);
  for (let i = 0; i < 7; i++) {
    const radius = 44 + i * 29 + a.low * 16 + Math.sin(f.localTime * 1.5 - i * .6) * 6;
    c.save(); c.globalAlpha = .75 - i * .07; c.strokeStyle = i % 2 ? AMBER : ORANGE; c.lineWidth = i === 2 ? 3 : 1;
    polygon(c, 593, 286, radius, 8, Math.PI / 8); c.stroke(); c.restore();
  }
  title(c, 'A.T.', 43, 191, 100, BONE); title(c, 'FIELD', 43, 263, 92, ORANGE);
  label(c, 'PHASE SPACE', 47, 301, 15, ORANGE); label(c, 'DEPLOYED', 47, 324, 15, GREEN);
  label(c, 'FIELD STRENGTH / LOW', 47, 381, 11, ORANGE); meter(c, 47, 397, 226, 14, a.low, ORANGE);
  label(c, 'PERIMETER / HIGH', 47, 439, 11, CYAN); meter(c, 47, 453, 226, 8, a.high, CYAN);
}
function alert(c: Context, f: NervSceneFrame, a: Signals): void {
  hazard(c, 24, 84, 912, 18, f.localTime * 22, RED); hazard(c, 24, 451, 912, 18, -f.localTime * 22, RED);
  title(c, 'EMERGENCY', 48, 194, 94, RED, .81);
  label(c, 'PATTERN BLUE / SIGNAL DETECTED', 54, 227, 24, CYAN);
  const values = [a.low, a.mid, a.high]; const names = ['LOW / MASS', 'MID / ANALYSIS', 'HIGH / PERIMETER'];
  for (let i = 0; i < 3; i++) {
    const x = 25 + i * 309; panel(c, x, 251, 293, 178, names[i]!, i === 2 ? CYAN : RED);
    title(c, `${Math.round(values[i]! * 100).toString().padStart(3, '0')}`, x + 16, 348, 82, BONE);
    label(c, 'LIVE INPUT / %', x + 20, 373, 12, RED); meter(c, x + 20, 393, 250, 14, values[i]!, i === 2 ? CYAN : RED);
  }
}
function plug(c: Context, f: NervSceneFrame, a: Signals): void {
  panel(c, 24, 85, 240, 386, 'ENTRY PLUG');
  title(c, 'LCL', 44, 178, 84, AMBER); label(c, 'NEURAL CONNECTION', 44, 215, 14, GREEN);
  ['A10 INTERFACE', 'PULSE MONITOR', 'HARMONICS', 'SIGNAL BUS'].forEach((v, i) => { label(c, `${v} / OK`, 44, 269 + i * 39, 12, i % 2 ? GREEN : ORANGE); });
  meter(c, 44, 437, 197, 12, a.mid, AMBER);
  const cx = 603 + Math.sin(f.localTime * .3) * 17, cy = 276;
  c.save(); c.beginPath(); c.rect(284, 85, 652, 386); c.clip();
  for (let i = 15; i >= 0; i--) {
    const depth = fract(i / 16 + f.localTime * .075), radius = 14 + depth * depth * 390;
    c.strokeStyle = i % 4 ? ORANGE : AMBER; c.lineWidth = 1 + depth * a.low * 3;
    c.globalAlpha = .1 + depth * .55; polygon(c, cx, cy, radius, 8, Math.PI / 8); c.stroke();
  }
  c.restore(); brackets(c, cx - 32, cy - 32, 64, 64, GREEN);
  label(c, 'INSERTION / CLOCK SYNCHRONIZED', 606, 465, 11, AMBER, 'center');
}
function target(c: Context, f: NervSceneFrame, a: Signals): void {
  grid(c, 24, 86, 912, 385, 38); const x = 491 + Math.sin(f.localTime * .41) * 100, y = 257 + Math.cos(f.localTime * .29) * 43;
  circle(c, 480, 273, 171, ORANGE); circle(c, 480, 273, 111, '#596d57'); circle(c, 480, 273, 40, ORANGE);
  line(c, 274, 273, 686, 273, ORANGE); line(c, 480, 76, 480, 473, ORANGE);
  const r = 42 + a.low * 23; brackets(c, x - r, y - r, r * 2, r * 2, CYAN); circle(c, x, y, 7 + a.high * 12, CYAN, 2);
  panel(c, 27, 99, 210, 120, 'POSITRON RIFLE'); title(c, 'TARGET', 42, 158, 38, BONE); label(c, 'TRACK / LIVE', 45, 194, 13, CYAN);
  panel(c, 719, 333, 217, 137, 'CAPACITOR / MID'); label(c, `${Math.round(a.mid * 100)}%`, 738, 399, 39, AMBER); meter(c, 738, 427, 176, 17, a.mid, AMBER);
  label(c, 'AZIMUTH', 737, 123, 12, ORANGE); label(c, `${((x - 480) / 2).toFixed(1)} DEG`, 737, 148, 17, CYAN);
  label(c, 'CHARGE / BAR PHASE', 46, 390, 11, ORANGE); meter(c, 46, 408, 184, 17, fract(a.beats / 4), ORANGE);
}
function city(c: Context, f: NervSceneFrame, _a: Signals): void {
  title(c, 'TOKYO–3', 37, 148, 62, ORANGE); label(c, 'RETRACTABLE CITY / SPECTRAL PROFILE', 42, 176, 12, '#a0ada4');
  const baseY = 425, drift = Math.sin(f.localTime * .13) * 12;
  for (let i = 0; i <= 18; i++) line(c, 480 + (i - 9) * 28, 235, 480 + (i - 9) * 96, 476, '#253d36');
  for (let i = 0; i < 8; i++) { const p = i / 7; line(c, 29, 244 + p * p * 231, 931, 244 + p * p * 231, '#253d36'); }
  for (let row = 0; row < 3; row++) for (let i = 0; i < 18; i++) {
    const index = row * 18 + i, level = band(f.audio, Math.floor(index * 512 / 54), Math.floor((index + 1) * 512 / 54));
    const x = 52 + i * 48 + row * 6 + drift, y = baseY - (2 - row) * 37;
    const h = 16 + noise(index, f.seed) * 86 + level * 55, w = 23 + row * 3, d = 8;
    c.fillStyle = '#08110f'; c.fillRect(x, y - h, w, h); c.strokeStyle = row === 2 ? ORANGE : '#886742'; c.lineWidth = 1; c.strokeRect(x, y - h, w, h);
    line(c, x, y - h, x + d, y - h - d, AMBER); line(c, x + d, y - h - d, x + w + d, y - h - d, AMBER);
    line(c, x + w, y - h, x + w + d, y - h - d, AMBER); line(c, x + w + d, y - h - d, x + w + d, y - d, '#886742'); line(c, x + w, y, x + w + d, y - d, '#886742');
    if (level > .2) { c.fillStyle = CYAN; c.fillRect(x + 5, y - h + 7, 3, 4); }
  }
  const scanX = 35 + fract(f.localTime / 13) * 888; line(c, scanX, 195, scanX, 465, CYAN);
  label(c, 'GE0FRONT / 54 FREQUENCY DISTRICTS', 42, 465, 11, ORANGE);
}
function sync(c: Context, f: NervSceneFrame, a: Signals): void {
  panel(c, 24, 85, 420, 386, 'SYNCHRONIZATION / SIGNAL LEVEL', PURPLE);
  title(c, `${Math.round(a.level * 100)}`, 48, 270, 164, LIME, .75); label(c, '%', 371, 262, 55, PURPLE);
  label(c, 'STEREO INPUT ENERGY', 49, 307, 18, PURPLE); meter(c, 49, 336, 369, 22, a.level, LIME, 32);
  label(c, 'CLOCK / PHRASE PROGRESS', 49, 408, 13, PURPLE); meter(c, 49, 428, 369, 13, f.progress, PURPLE, 32);
  panel(c, 467, 85, 469, 184, 'LEFT / NEURAL CONNECTION', LIME); grid(c, 486, 124, 430, 124, 30); scope(c, f.audio, 486, 131, 430, 106, LIME, 0);
  panel(c, 467, 289, 469, 182, 'RIGHT / HARMONICS', PURPLE); grid(c, 486, 328, 430, 124, 30); scope(c, f.audio, 486, 335, 430, 106, PURPLE, 1);
}
function berserk(c: Context, f: NervSceneFrame, a: Signals): void {
  hexField(c, 722, 270, 208, f.localTime * 1.2, a.low, a.high, f.seed, PURPLE);
  for (let i = 0; i < 5; i++) {
    c.strokeStyle = i % 2 ? PURPLE : LIME; c.lineWidth = 2;
    polygon(c, 724, 270, 55 + i * 32 + a.low * 13, 6, Math.PI / 6 + Math.sin(f.localTime * .16) * .1); c.stroke();
  }
  title(c, 'BERSERK', 40, 194, 93, LIME, .7); label(c, 'LIMITER / AUDIO OVERDRIVE', 45, 229, 15, PURPLE);
  for (const [i, value, name, color] of [[0, a.low, 'MASS', LIME], [1, a.mid, 'SYNC', PURPLE], [2, a.high, 'EDGE', CYAN]] as const) {
    label(c, name, 46, 282 + i * 45, 12, color); meter(c, 110, 270 + i * 45, 300, 17, value, color, 30);
  }
  scope(c, f.audio, 42, 407, 368, 56, LIME);
  hazard(c, 480, 455, 456, 12, f.localTime * 18, PURPLE);
  label(c, 'UNIT 01 / SIGNAL UNRESTRAINED', 706, 435, 12, LIME, 'center');
}
function impact(c: Context, f: NervSceneFrame, a: Signals): void {
  const xs = [24, 334, 644], ys = [86, 216, 346];
  const names = ['SIGNAL / LEFT', 'SPECTRUM', 'MAGI / LOW', 'TACTICAL', 'THIRD IMPACT', 'MAGI / HIGH', 'SIGNAL / RIGHT', 'CLOCK', 'SYNCHRONIZATION'];
  for (let i = 0; i < 9; i++) panel(c, xs[i % 3]!, ys[Math.floor(i / 3)]!, 292, 115, names[i]!, i === 4 ? RED : ORANGE);
  scope(c, f.audio, 37, 114, 266, 76, GREEN); spectrum(c, f.audio, 348, 124, 264, 64, ORANGE, 28);
  meter(c, 659, 143, 262, 24, a.low, ORANGE, 24); label(c, 'LOW / 0–400 Hz', 659, 187, 11, ORANGE);
  radarInstrument(c, f, 170, 283, 41, fract(a.beats / 4), CYAN);
  title(c, 'THIRD IMPACT', 350, 291, 36, RED, .78); label(c, 'CONTROL WALL', 480, 314, 10, RED, 'center');
  meter(c, 659, 271, 262, 24, a.high, CYAN, 24); label(c, 'HIGH / 4k–22k Hz', 659, 315, 11, CYAN);
  scope(c, f.audio, 37, 376, 266, 74, CYAN, 1);
  label(c, `BAR ${a.bar + 1}`, 349, 410, 27, AMBER); meter(c, 349, 430, 263, 13, a.phase, AMBER, 24);
  title(c, `${Math.round(a.level * 100)}%`, 659, 422, 59, LIME); label(c, 'LIVE ENERGY', 912, 441, 10, LIME, 'right');
}
function end(c: Context, f: NervSceneFrame, _a: Signals): void {
  line(c, 254, 139, 706, 139, ORANGE); title(c, 'END', 342, 277, 136, BONE, .9);
  label(c, 'NERV / AUDIO TERMINAL', 480, 326, 20, ORANGE, 'center');
  label(c, 'SIGNAL CONTINUES', 480, 355, 12, '#a0ada4', 'center');
  scope(c, f.audio, 222, 387, 516, 66, GREEN);
}
const DRAW: Record<NervSceneId, (c: Context, f: NervSceneFrame, a: Signals) => void> = { boot, magi, psycho, radar, harmonics, seele, battery, atfield, alert, plug, target, city, sync, berserk, impact, end };

/** Independent of render history: seeking or replaying the same inputs is exact. */
export function renderNervScene(c: Context, width: number, height: number, input: NervSceneFrame): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  const f: NervSceneFrame = { ...input, time: Math.max(0, finite(input.time)), localTime: Math.max(0, finite(input.localTime)), progress: clamp(input.progress), bpm: clamp(input.bpm, 20, 400), seed: input.seed >>> 0 };
  const low = band(f.audio, 0, 10), mid = band(f.audio, 10, 93), high = band(f.audio, 93, 512);
  const beats = f.localTime * f.bpm / 60;
  const a: Signals = { low, mid, high, level: (low + mid + high) / 3, beats, phase: fract(beats), bar: Math.floor(f.time * f.bpm / 240) };
  c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  c.shadowBlur = 0; c.lineCap = 'butt'; c.lineJoin = 'miter'; c.setLineDash([]); c.fillStyle = INK; c.fillRect(0, 0, width, height);
  // Fit the complete instrument on every player aspect ratio. Narrow windows
  // receive letterboxing rather than cropped controls or overlapping labels.
  const scale = Math.min(width / 960, height / 540);
  c.translate((width - 960 * scale) / 2, (height - 540 * scale) / 2); c.scale(scale, scale);
  c.beginPath(); c.rect(0, 0, 960, 540); c.clip();
  const accent = f.scene === 'berserk' || f.scene === 'sync' ? PURPLE : f.scene === 'alert' || f.scene === 'seele' ? RED : ORANGE;
  chrome(c, f, a, accent); (DRAW[f.scene] ?? boot)(c, f, a);
  c.restore();
}
