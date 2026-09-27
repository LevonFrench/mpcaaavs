// Audio analysis -> GPU. One bind group every shader in the graph can read.
//
// Storage buffers, not textures (plan §4.9). Pulse encoded its analysis arrays
// into texels and paid for it twice: once writing the pack/unpack code, and
// again when rgba16float quietly rounded the values on the way in. A storage
// buffer is exact float32, indexed like the array it already is, and needs no
// sampler. The only thing textures would still buy is hardware bilinear, and
// every accessor here is one lerp bar the spectrogram's three — cheaper than
// the encoding it replaces.
//
// This module deliberately does NOT own the analysis (that is `audio.ts`), any
// pipeline, or any pass. It owns buffers, one upload per frame, and the WGSL
// text that describes them. Consumers prepend `AUDIO_WGSL` and bind
// `AudioGpu.bindGroup` at `AUDIO_GROUP`; nothing else about them changes.

import { SPEC_N, SPECTROGRAM_ROWS, WAVE_N } from './audio.ts';
import type { AudioSnapshot } from './contracts.ts';

/**
 * Bind group index the audio data lives at, for every pipeline in the project.
 *
 * Fixed rather than per-pipeline on purpose: a layer's own uniforms change shape
 * constantly during authoring, and if audio shared a group with them every such
 * edit would renumber the audio bindings in that shader alone. Group 0 is left
 * to the pass (its inputs, its sampler, its params) because that is the group
 * that varies; group 1 is audio and is identical everywhere.
 */
export const AUDIO_GROUP = 1;

/** Scalars uniform: 20 f32 = 80 bytes. Mirrors `AudioScalars` in `AUDIO_WGSL`. */
const SCALAR_FLOATS = 20;

// Field offsets into the staging array, in FLOATS. Named because a bare index
// in the upload path is exactly the sort of thing that silently swaps `crest`
// and `centroid` and then looks almost right on screen.
const S_TIME = 0;
const S_LEVEL = 1;
const S_BEAT = 2;
const S_PAN = 3;
const S_WIDTH = 4;
const S_CREST = 5;
const S_CENTROID = 6;
const S_FLATNESS = 7;
const S_BANDS = 8;      // vec4: sub, low, mid, high
const S_AIR = 12;
const S_SPEC_ROW = 13;
const S_SPEC_N = 14;
const S_WAVE_N = 15;
const S_SPEC_ROWS = 16;
// 17..19 are the struct's tail padding; never written, never read.

/**
 * How many spectrogram rows may have advanced before we give up on incremental
 * upload and re-send the lot. One row per analysis frame is the normal case; a
 * seek, a reset or a stalled tab produce a jump, and writing 200 individual
 * 1 KB `writeBuffer` calls to catch up is slower than one 256 KB write.
 */
const ROW_CATCHUP_LIMIT = 8;

/**
 * Owns the audio-side GPU buffers and keeps them fresh.
 *
 * Everything is read-only on the GPU, which is what allows the bind group to be
 * visible to vertex stages as well — a writable storage buffer is not, and
 * `points.wgsl`-style layers index audio data straight from the vertex shader.
 */
export class AudioGpu {
  readonly layout: GPUBindGroupLayout;
  readonly bindGroup: GPUBindGroup;

  private readonly scalarBuf: GPUBuffer;
  private readonly waveBuf: GPUBuffer;
  private readonly specBuf: GPUBuffer;
  private readonly panBuf: GPUBuffer;
  private readonly spectrogramBuf: GPUBuffer;
  private readonly peakBuf: GPUBuffer;

  /** Staging for the uniform. Reused; allocating 80 bytes per frame is litter. */
  private readonly scalars = new Float32Array(SCALAR_FLOATS);

  /** Write head we last mirrored. -1 means "nothing uploaded yet". */
  private lastRow = -1;

  constructor(device: GPUDevice) {
    const storage = (label: string, floats: number): GPUBuffer => device.createBuffer({
      label,
      size: floats * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.scalarBuf = device.createBuffer({
      label: 'audio:scalars',
      size: SCALAR_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.waveBuf = storage('audio:waveform', WAVE_N * 2);
    this.specBuf = storage('audio:spectrum', SPEC_N * 2);
    this.panBuf = storage('audio:bandPan', SPEC_N);
    this.spectrogramBuf = storage('audio:spectrogram', SPEC_N * SPECTROGRAM_ROWS);
    this.peakBuf = storage('audio:peaks', SPEC_N);

    // COMPUTE is in the visibility mask because attractors and particles (§4.5)
    // read the spectrum to drive their step, not just to colour the result.
    const vis = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;
    const ro: GPUBufferBindingLayout = { type: 'read-only-storage' };
    this.layout = device.createBindGroupLayout({
      label: 'audio',
      entries: [
        { binding: 0, visibility: vis, buffer: { type: 'uniform' } },
        { binding: 1, visibility: vis, buffer: ro },
        { binding: 2, visibility: vis, buffer: ro },
        { binding: 3, visibility: vis, buffer: ro },
        { binding: 4, visibility: vis, buffer: ro },
        { binding: 5, visibility: vis, buffer: ro },
      ],
    });

    // Created once. The buffers never change identity, so neither does this —
    // rebuilding a bind group per frame is pure CPU overhead (§4.9).
    this.bindGroup = device.createBindGroup({
      label: 'audio',
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.scalarBuf } },
        { binding: 1, resource: { buffer: this.waveBuf } },
        { binding: 2, resource: { buffer: this.specBuf } },
        { binding: 3, resource: { buffer: this.panBuf } },
        { binding: 4, resource: { buffer: this.spectrogramBuf } },
        { binding: 5, resource: { buffer: this.peakBuf } },
      ],
    });
  }

  /**
   * Mirror one frame of analysis. Call once, before any pass that reads audio.
   *
   * `audio`'s typed arrays are live references into the engine (see
   * `AudioSnapshot`), which is exactly what makes `writeBuffer` the right call
   * here: it copies into the queue's own staging immediately, so nothing
   * retains a view that the next `AudioEngine.update` will overwrite.
   */
  upload(audio: AudioSnapshot, queue: GPUQueue): void {
    const s = this.scalars;
    s[S_TIME] = audio.time;
    s[S_LEVEL] = audio.level;
    s[S_BEAT] = audio.beat;
    s[S_PAN] = audio.pan;
    s[S_WIDTH] = audio.width;
    s[S_CREST] = audio.crest;
    s[S_CENTROID] = audio.centroid;
    s[S_FLATNESS] = audio.flatness;
    s[S_BANDS + 0] = audio.bands.sub;
    s[S_BANDS + 1] = audio.bands.low;
    s[S_BANDS + 2] = audio.bands.mid;
    s[S_BANDS + 3] = audio.bands.high;
    s[S_AIR] = audio.bands.air;
    s[S_SPEC_ROW] = audio.spectrogramRow;
    // Sizes travel with the data. A shader that hardcodes 256 is a shader that
    // silently samples garbage the day SPEC_N changes, and it will not error.
    s[S_SPEC_N] = SPEC_N;
    s[S_WAVE_N] = WAVE_N;
    s[S_SPEC_ROWS] = SPECTROGRAM_ROWS;
    queue.writeBuffer(this.scalarBuf, 0, s);

    // 12 KB a frame for these four (8 + 2 + 1 + 1). Measured against the alternative of
    // dirty-tracking them: they change in full every analysis frame, so any
    // such tracking would be bookkeeping that never says no.
    queue.writeBuffer(this.waveBuf, 0, src(audio.waveform));
    queue.writeBuffer(this.specBuf, 0, src(audio.spectrum));
    queue.writeBuffer(this.panBuf, 0, src(audio.bandPan));
    queue.writeBuffer(this.peakBuf, 0, src(audio.peaks));

    this.uploadSpectrogram(audio, queue);
  }

  /**
   * The spectrogram is 256 KB and gains ONE row per analysis frame. Re-sending
   * it whole would be ~30 MB/s of pointless PCIe traffic at 120 fps, and it is
   * the single largest thing this module touches, so it gets the only real
   * incremental path here.
   */
  private uploadSpectrogram(audio: AudioSnapshot, queue: GPUQueue): void {
    const head = audio.spectrogramRow;
    // `spectrogramRow` is the row that will be written NEXT, so rows in
    // [lastRow, head) are the new ones — half-open, which is what stops the
    // most recent row being uploaded twice and the newest one never at all.
    const advanced = this.lastRow < 0
      ? SPECTROGRAM_ROWS
      : (head - this.lastRow + SPECTROGRAM_ROWS) % SPECTROGRAM_ROWS;
    this.lastRow = head;

    // Zero means the analysis has not produced a row since the last upload,
    // which is the normal case whenever the frame rate outruns it. It is also
    // what an exact 256-row lap between two uploads would look like, and those
    // are indistinguishable from `spectrogramRow` alone — but both sides run
    // off the same rAF, so a 256-frame gap in one and none in the other cannot
    // happen. If upload() ever moves off that loop this needs a real counter.
    if (advanced === 0) return;

    // `AudioEngine.resetDetector` zeroes the whole history and sends the write
    // head back to 0 on every play/start, and nothing tells us it happened —
    // all we see is a head that moved. Incrementally mirroring one row after
    // that leaves the other 255 holding the PREVIOUS track, on screen, for a
    // full lap. So any range that reaches back to row 0 re-sends everything:
    // it makes a reset self-correcting on the first upload after it, and it
    // costs one extra 256 KB write per lap (~120 KB/s at 120 fps), which is
    // less than a third of what the four small buffers above already move.
    if (advanced > ROW_CATCHUP_LIMIT || head - advanced <= 0) {
      queue.writeBuffer(this.spectrogramBuf, 0, src(audio.spectrogram));
      return;
    }
    for (let i = 0; i < advanced; i++) {
      const row = (head - 1 - i + SPECTROGRAM_ROWS) % SPECTROGRAM_ROWS;
      // dataOffset and size are in ELEMENTS for a typed array, in bytes only
      // for a raw ArrayBuffer. Getting that backwards writes four times the
      // data and throws on the last row rather than at the first.
      queue.writeBuffer(
        this.spectrogramBuf, row * SPEC_N * 4,
        src(audio.spectrogram), row * SPEC_N, SPEC_N,
      );
    }
  }

  destroy(): void {
    for (const b of [
      this.scalarBuf, this.waveBuf, this.specBuf,
      this.panBuf, this.spectrogramBuf, this.peakBuf,
    ]) b.destroy();
  }
}

/**
 * Narrow an analysis array for `writeBuffer`.
 *
 * TypeScript 5.7 made typed arrays generic over their backing buffer, so a bare
 * `Float32Array` is `Float32Array<ArrayBufferLike>` — which includes
 * `SharedArrayBuffer`, which the WebGPU typings refuse. `AudioSnapshot` cannot
 * be tightened (it is the shared contract), and copying would defeat the point
 * of the arrays being live references, so the narrowing happens here, once.
 */
function src(a: Float32Array): Float32Array<ArrayBuffer> {
  return a as Float32Array<ArrayBuffer>;
}

/**
 * Prepend to any shader that wants audio. Declares group `AUDIO_GROUP` and the
 * accessors; nothing in here allocates, branches on uniforms, or samples a
 * texture, so it is safe in a vertex stage.
 *
 * Every accessor takes NORMALISED coordinates (0..1), never a bin index. That
 * is what lets a layer be written once and keep working when SPEC_N or WAVE_N
 * changes, and it is why the sizes are uploaded rather than baked in.
 */
export const AUDIO_WGSL = /* wgsl */`
// ---- audio (generated by audiogpu.ts — keep in sync) ----------------------
//
// std140-ish uniform layout, explicit about every byte. WGSL's uniform address
// space rounds a struct's alignment up to 16, so the CPU-side Float32Array must
// agree about the tail padding or the last real field lands in the wrong slot.
//
//   0  time      4  level     8  beat      12 pan
//   16 width     20 crest     24 centroid  28 flatness
//   32 bands     (vec4: align 16 — 32 is the first legal offset for it)
//   48 air       52 specRow   56 specN     60 waveN
//   64 specRows  68 _pad0     72 _pad1     76 _pad2   -> size 80
//
// The pads at 68..79 exist solely to round the struct size to a multiple of 16.
// There is deliberately NO vec3 anywhere in here: vec3 aligns to 16 but is only
// 12 bytes wide, so it drags four bytes of INVISIBLE padding after it that the
// TypeScript side has to know about and cannot see. Five bands are therefore a
// vec4 plus a loose f32, not a vec4 plus a vec3 — uglier, and never wrong.
struct AudioScalars {
  time     : f32,
  level    : f32,
  beat     : f32,
  pan      : f32,
  width    : f32,
  crest    : f32,
  centroid : f32,
  flatness : f32,
  bands    : vec4<f32>,   // sub, low, mid, high
  air      : f32,
  specRow  : f32,         // ring row that will be written NEXT
  specN    : f32,
  waveN    : f32,
  specRows : f32,
  _pad0    : f32,
  _pad1    : f32,
  _pad2    : f32,
};

@group(${AUDIO_GROUP}) @binding(0) var<uniform> A : AudioScalars;
@group(${AUDIO_GROUP}) @binding(1) var<storage, read> audioWave : array<f32>;        // interleaved L,R
@group(${AUDIO_GROUP}) @binding(2) var<storage, read> audioSpec : array<f32>;        // interleaved L,R
@group(${AUDIO_GROUP}) @binding(3) var<storage, read> audioPan  : array<f32>;        // per bin, -1..1
@group(${AUDIO_GROUP}) @binding(4) var<storage, read> audioGram : array<f32>;        // ring, row-major
@group(${AUDIO_GROUP}) @binding(5) var<storage, read> audioPeak : array<f32>;        // per bin, peak-hold

/** Bin index and lerp weight for a normalised position across n items. */
fn audioIndex(x: f32, n: f32) -> vec3<f32> {
  let p = clamp(x, 0.0, 1.0) * (n - 1.0);
  let i0 = floor(p);
  return vec3<f32>(i0, min(i0 + 1.0, n - 1.0), p - i0);
}

/** Stereo magnitude at normalised frequency f. */
fn fftStereoAt(f: f32) -> vec2<f32> {
  let ix = audioIndex(f, A.specN);
  let a = u32(ix.x) * 2u;
  let b = u32(ix.y) * 2u;
  let l = mix(audioSpec[a],      audioSpec[b],      ix.z);
  let r = mix(audioSpec[a + 1u], audioSpec[b + 1u], ix.z);
  return vec2<f32>(l, r);
}

/**
 * Mono magnitude 0..1 at normalised frequency f.
 * Interpolated, not nearest: a spectrum read per-pixel at nearest-bin gives 256
 * visible vertical steps across a 2K frame, which reads as a bar chart however
 * pretty the colouring is (art direction §3.2).
 */
fn fftAt(f: f32) -> f32 {
  let s = fftStereoAt(f);
  return (s.x + s.y) * 0.5;
}

/** Peak-hold magnitude at normalised frequency f. */
fn peakAt(f: f32) -> f32 {
  let ix = audioIndex(f, A.specN);
  return mix(audioPeak[u32(ix.x)], audioPeak[u32(ix.y)], ix.z);
}

/** Pan of the content at normalised frequency f, -1..1. Places an effect at the screen-x of its own frequency. */
fn panAt(f: f32) -> f32 {
  let ix = audioIndex(f, A.specN);
  return mix(audioPan[u32(ix.x)], audioPan[u32(ix.y)], ix.z);
}

/** L,R sample at normalised position t through the waveform window. Lissajous wants both. */
fn waveAt(t: f32) -> vec2<f32> {
  let ix = audioIndex(t, A.waveN);
  let a = u32(ix.x) * 2u;
  let b = u32(ix.y) * 2u;
  return vec2<f32>(
    mix(audioWave[a],      audioWave[b],      ix.z),
    mix(audioWave[a + 1u], audioWave[b + 1u], ix.z),
  );
}

/**
 * Spectrogram history. uv.x is normalised frequency; uv.y is AGE — 0 is now,
 * 1 is the oldest row still held.
 *
 * The ring offset is the entire point of this function. Sampling the buffer
 * directly makes the history JUMP once per full lap, because row 0 of the
 * buffer is not the oldest row, it is wherever the writer happened to be. Every
 * spectrogram that scrolls with a seam has skipped this. Rows are addressed
 * relative to the write head and wrapped, so the image scrolls smoothly and
 * forever.
 */
fn spectrogramAt(uv: vec2<f32>) -> f32 {
  let rows = A.specRows;
  // specRow is the NEXT row to be written, so the newest data is one behind it.
  let newest = A.specRow - 1.0;
  let age = clamp(uv.y, 0.0, 1.0) * (rows - 1.0);
  var r = newest - age;
  // Positive modulo. r is routinely negative here (newest is often near row 0),
  // and WGSL's % keeps the sign of the dividend, which would index backwards.
  r = r - floor(r / rows) * rows;

  let r0 = floor(r);
  var r1 = r0 + 1.0;
  if (r1 >= rows) { r1 = r1 - rows; }
  let rt = r - r0;

  let ix = audioIndex(uv.x, A.specN);
  let n = u32(A.specN);
  let base0 = u32(r0) * n;
  let base1 = u32(r1) * n;
  let c0 = u32(ix.x);
  let c1 = u32(ix.y);

  let a = mix(audioGram[base0 + c0], audioGram[base0 + c1], ix.z);
  let b = mix(audioGram[base1 + c0], audioGram[base1 + c1], ix.z);
  return mix(a, b, rt);
}

/** Band energy by index 0..4 (sub, low, mid, high, air). */
fn bandAt(i: u32) -> f32 {
  if (i >= 4u) { return A.air; }
  return A.bands[i];
}
// ---- end audio ------------------------------------------------------------
`;
