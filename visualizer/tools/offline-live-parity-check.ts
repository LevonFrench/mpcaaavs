import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, inflateSync } from 'node:zlib';
import {
  AvsCompatibilityRuntime,
  createAvsCompatibilityRegistry,
  parseAvsPreset,
  registerAvsBeatParticleEffects,
  type AvsBitmapResolver,
} from '../src/avs/index.ts';
import { loadBundledAvsBitmapResolver } from '../src/avs/bundled-bitmaps.ts';
import { blendPackedRgb } from '../src/avs/frame-utils.ts';
import { fillAvsPcm } from '../src/avs-worker-client.ts';
import { createFrameStats, FlashLimiter, limitPackedFrame } from '../src/flash-limiter.ts';
import { OFFLINE_PIXEL_SEMANTICS_VERSION } from '../src/offline/pixel-semantics.ts';
import type {
  OfflineFrameArtifact,
  OfflinePresetCueTransfer,
  OfflineRenderCompleteMessage,
  OfflineRenderStartMessage,
  OfflineRenderWorkerRequest,
  OfflineRenderWorkerResponse,
} from '../src/offline-render-protocol.ts';
// Installs the real offline render worker's onmessage on globalThis.
import '../src/offline-render.worker.ts';

// Live-vs-offline parity. For a fixed preset, fixed frozen PCM and a fixed
// seed, the offline export (the real src/offline-render.worker.ts, run in
// Node against an in-memory directory, its PNGs decoded back to pixels) must
// equal the live CPU path bit for bit. The live path is replayed here the way
// src/avs-render.worker.ts drives it on the exact CPU fallback: construct,
// one preinit render with silent audio, then per frame fillAvsPcm (the live
// client's decimation) -> pcmAudio.analyse -> render. Both lanes get the same
// deterministic registry (the corpus gate's pattern: injected randomInt and a
// Custom BPM clock), because live's defaults are Math.random and wall time.
//
// Also covered: per-cue reseeding (by design, owner decision 2026-09-26), the
// srgb-integer crossfade, opt-in flash limiting against the in-place limiter
// reference, PNG sRGB tagging, and the per-frame RGB24 SHA-256 authority.

const WIDTH = 128;
const HEIGHT = 72;
const FPS = 24;
const SAMPLES_PER_FRAME = 48_000 / FPS;
const FRAMES = 12;
// The last frame is deliberately short (1300 samples), as at the end of a track.
const TOTAL_SAMPLES = FRAMES * SAMPLES_PER_FRAME - 700;
// The flash limiter counts flashes per second, so its section runs 2 s.
const FLASH_FRAMES = 48;
const FLASH_SAMPLES = FLASH_FRAMES * SAMPLES_PER_FRAME;
/** Length of the fixture the next job / replay uses. */
let fixture = { frames: FRAMES, samples: TOTAL_SAMPLES };
const SPREAD_PICKS = 8;
// Presets whose preinit frame changes what follows (6 of the 124 bundled
// presets); without them the no-preinit negative control would have no teeth.
const PREINIT_SENSITIVE = ['community-picks/UnConeD - Mister Santa.avs', 'winamp-5-picks/Duo - Brainstorm.avs'];

// ---------------------------------------------------------------- source drift
// The replay below mirrors these lines; fail loudly if the live lane changes.
{
  const worker = readFileSync(resolve('src/avs-render.worker.ts'), 'utf8');
  const client = readFileSync(resolve('src/avs-worker-client.ts'), 'utf8');
  for (const needle of [
    'const warmup = runtime.render(undefined, true);',
    "runtime.pcmAudio.analyse({ left: pcm.subarray(0, 576), right: pcm.subarray(576) })",
    'let frame = runtime.render(audio);',
  ]) assert.ok(worker.includes(needle), `src/avs-render.worker.ts no longer contains: ${needle}`);
  assert.ok(client.includes('fillAvsPcm(audio.waveform, this.pcm);'), 'live client no longer decimates with fillAvsPcm');
}

// ---------------------------------------------------------------- environment
// Node's fetch has no file: scheme; the worker fetches bundled Texer bitmaps
// (file URLs next to the built check) and probes for the encoder bundle (absent
// here, so it encodes in-thread, which writes the same bytes).
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('file:')) return realFetch(input, init);
  const path = fileURLToPath(url);
  if (!existsSync(path)) return new Response(null, { status: 404 });
  return new Response(readFileSync(path));
}) as typeof fetch;

class MemoryDirectory {
  readonly kind = 'directory';
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Map<string, MemoryDirectory>();
  constructor(readonly name: string) {}
  async *values(): AsyncIterableIterator<{ kind: string; name: string }> {
    for (const name of this.directories.keys()) yield { kind: 'directory', name };
    for (const name of this.files.keys()) yield { kind: 'file', name };
  }
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemoryDirectory> {
    let directory = this.directories.get(name);
    if (!directory) {
      if (!options?.create) throw new DOMException(name, 'NotFoundError');
      directory = new MemoryDirectory(name);
      this.directories.set(name, directory);
    }
    return directory;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name) && !options?.create) throw new DOMException(name, 'NotFoundError');
    return {
      kind: 'file', name,
      createWritable: async () => {
        const parts: Uint8Array[] = [];
        return {
          write: async (data: Uint8Array) => { parts.push(new Uint8Array(data)); },
          close: async () => { this.files.set(name, Buffer.concat(parts)); },
          abort: async () => { /* nothing committed */ },
        };
      },
    };
  }
}

interface JobResult {
  readonly complete: OfflineRenderCompleteMessage;
  readonly frames: Uint32Array[];
}

let jobCounter = 0;
const workerScope = globalThis as unknown as {
  onmessage: ((event: { data: OfflineRenderWorkerRequest }) => void) | null;
  postMessage: (message: OfflineRenderWorkerResponse) => void;
};
assert.equal(typeof workerScope.onmessage, 'function', 'importing the worker installs its message handler');

async function runOfflineJob(
  presets: readonly { presetId: string; bytes: Uint8Array }[],
  cues: readonly OfflinePresetCueTransfer[],
  extra: Partial<Pick<OfflineRenderStartMessage, 'flashLimit' | 'transitionBlend'>> = {},
): Promise<JobResult> {
  const jobId = `parity-${++jobCounter}`;
  const directory = new MemoryDirectory('out');
  const completed = new Promise<OfflineRenderCompleteMessage>((resolveJob, rejectJob) => {
    workerScope.postMessage = (message) => {
      if (message.jobId !== jobId) return;
      if (message.type === 'complete') resolveJob(message);
      else if (message.type === 'error') rejectJob(new Error(message.message));
    };
  });
  workerScope.onmessage!({
    data: {
      type: 'start', jobId, width: WIDTH, height: HEIGHT, fpsNum: FPS, fpsDen: 1,
      sampleRate: 48000, totalSamples: fixture.samples,
      left: LEFT.slice(0, fixture.samples).buffer, right: RIGHT.slice(0, fixture.samples).buffer,
      presetBank: presets.map((preset) => ({ presetId: preset.presetId, presetSha256: 'n/a', bytes: preset.bytes.slice().buffer })),
      presetCues: cues,
      outputDirectory: directory as unknown as FileSystemDirectoryHandle,
      maxEncoderWorkers: 0,
      ...extra,
    },
  });
  const complete = await completed;
  assert.equal(complete.frameCount, fixture.frames);
  assert.equal(complete.pixelSemanticsVersion, OFFLINE_PIXEL_SEMANTICS_VERSION);
  const framesDirectory = directory.directories.get('frames');
  assert.ok(framesDirectory, 'frames/ was created');
  const frames: Uint32Array[] = [];
  for (const artifact of complete.artifacts) frames.push(verifyFrame(framesDirectory, artifact));
  return { complete, frames };
}

/** Parse, CRC-check and decode one written PNG; verify both ledger hashes. */
function verifyFrame(directory: MemoryDirectory, artifact: OfflineFrameArtifact): Uint32Array {
  const name = artifact.path.replace(/^frames\//, '');
  const png = directory.files.get(name);
  assert.ok(png, `missing ${artifact.path}`);
  assert.equal(sha256(png), artifact.sha256, `${artifact.path}: PNG sha256 ledger`);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks: { type: string; data: Uint8Array }[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    assert.equal(png.readUInt32BE(offset + 8 + length), crc32(png.subarray(offset + 4, offset + 8 + length)), `${type} CRC`);
    chunks.push({ type, data });
    offset += 12 + length;
  }
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['IHDR', 'sRGB', 'IDAT', 'IEND'], 'chunk order: sRGB tag precedes IDAT');
  const ihdr = Buffer.from(chunks[0]!.data);
  // The PNG raster is the executor raster: offline never upscales.
  assert.equal(ihdr.readUInt32BE(0), WIDTH);
  assert.equal(ihdr.readUInt32BE(4), HEIGHT);
  assert.deepEqual([...ihdr.subarray(8)], [8, 2, 0, 0, 0], '8-bit RGB, no alpha, no interlace');
  assert.deepEqual([...chunks[1]!.data], [0], 'sRGB chunk, perceptual rendering intent');
  const filtered = inflateSync(chunks[2]!.data);
  const stride = WIDTH * 3;
  assert.equal(filtered.length, HEIGHT * (stride + 1));
  const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    const row = y * (stride + 1);
    assert.equal(filtered[row], 1, 'filter Sub');
    for (let x = 0; x < stride; x++) {
      const prior = x >= 3 ? rgb[y * stride + x - 3]! : 0;
      rgb[y * stride + x] = (filtered[row + 1 + x]! + prior) & 0xff;
    }
  }
  assert.equal(sha256(rgb), artifact.rgbSha256, `${artifact.path}: pre-filter RGB24 authority`);
  const pixels = new Uint32Array(WIDTH * HEIGHT);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (rgb[i * 3]! << 16) | (rgb[i * 3 + 1]! << 8) | rgb[i * 3 + 2]!;
  return pixels;
}

// ---------------------------------------------------------------- live replay
function xorshift(value: number): number {
  let x = value || 0x6d2b79f5;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  return x >>> 0;
}

interface LiveOptions {
  readonly preinit?: boolean;
}

/**
 * Frames `startFrame .. startFrame + count - 1` of the live CPU lane for a
 * preset loaded at `startFrame`, fed each output frame's PCM interval.
 */
function liveFrames(
  bytes: Uint8Array, seed: number, startFrame: number, count: number,
  resolver: AvsBitmapResolver, options: LiveOptions = {},
): Uint32Array[] {
  let randomState = seed || 0x6d2b79f5;
  let nowMs = startFrame * 1000 / FPS;
  const registry = createAvsCompatibilityRegistry({
    randomInt(maximum) {
      randomState = xorshift(randomState);
      return maximum > 0 ? randomState % maximum : 0;
    },
  }, { bitmapResolver: resolver });
  registerAvsBeatParticleEffects(registry, { now: () => nowMs });
  // avs-render.worker.ts: originalPreset = parseAvsPreset(message.preset); new runtime; warmup preinit.
  const runtime = new AvsCompatibilityRuntime(parseAvsPreset(bytes), WIDTH, HEIGHT, registry);
  if (options.preinit !== false) runtime.render(undefined, true);
  const pcm = new Float32Array(1152);
  const out: Uint32Array[] = [];
  for (let frame = startFrame; frame < startFrame + count; frame++) {
    const start = frame * SAMPLES_PER_FRAME;
    const end = Math.min(start + SAMPLES_PER_FRAME, fixture.samples);
    const waveform = new Float32Array((end - start) * 2);
    for (let i = start; i < end; i++) { waveform[(i - start) * 2] = LEFT[i]!; waveform[(i - start) * 2 + 1] = RIGHT[i]!; }
    fillAvsPcm(waveform, pcm);
    nowMs = frame * 1000 / FPS;
    const audio = runtime.pcmAudio.analyse({ left: pcm.subarray(0, 576), right: pcm.subarray(576) });
    out.push(runtime.render(audio).framebuffer.pixels.slice());
  }
  return out;
}

// ---------------------------------------------------------------- fixtures
// Deterministic music-like PCM: a bass tone, a hat-like LCG noise floor and a
// loud kick burst every other frame (so beat-driven presets strobe).
const LEFT = new Float32Array(FLASH_SAMPLES);
const RIGHT = new Float32Array(FLASH_SAMPLES);
{
  let lcg = 0x2468ace;
  for (let i = 0; i < FLASH_SAMPLES; i++) {
    lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
    const noise = (lcg / 0xffffffff) * 2 - 1;
    const phase = i % (SAMPLES_PER_FRAME * 2);
    const kick = phase < 1500 ? Math.sin(phase * 0.02) * (1 - phase / 1500) : 0;
    LEFT[i] = 0.3 * Math.sin(i * 2 * Math.PI * 55 / 48_000) + 0.1 * noise + 0.8 * kick;
    RIGHT[i] = 0.3 * Math.sin(i * 2 * Math.PI * 82.5 / 48_000) - 0.1 * noise + 0.8 * kick;
  }
}

const corpus: { key: string; bytes: Uint8Array }[] = [];
for (const collection of ['community-picks', 'winamp-5-picks']) {
  const root = resolve('assets/avs-presets', collection);
  for (const file of readdirSync(root).filter((name) => name.toLowerCase().endsWith('.avs')).sort()) {
    corpus.push({ key: `${collection}/${file}`, bytes: new Uint8Array(readFileSync(join(root, file))) });
  }
}
assert.ok(corpus.length >= SPREAD_PICKS * 2, `corpus has ${corpus.length} presets`);
const step = Math.floor(corpus.length / SPREAD_PICKS);
const picks = Array.from({ length: SPREAD_PICKS }, (_, i) => corpus[i * step]!);
for (const key of PREINIT_SENSITIVE) {
  const preset = corpus.find((candidate) => candidate.key === key);
  assert.ok(preset, `missing preinit-sensitive preset ${key}`);
  picks.push(preset);
}
const PRESET_PICKS = picks.length;

const resolver = await loadBundledAvsBitmapResolver();
const firstDiff = (a: Uint32Array, b: Uint32Array): number => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
};
const sameFrames = (a: readonly Uint32Array[], b: readonly Uint32Array[]): boolean =>
  a.length === b.length && a.every((frame, i) => firstDiff(frame, b[i]!) < 0);

// ---------------------------------------------------------------- 1. single cue parity
let preinitMatters = 0;
for (const [index, preset] of picks.entries()) {
  const seed = 0x9e3779b9 ^ index;
  const offline = await runOfflineJob([{ presetId: preset.key, bytes: preset.bytes }],
    [{ frame: 0, presetId: preset.key, seed, transitionFrames: 0 }]);
  const live = liveFrames(preset.bytes, seed, 0, FRAMES, resolver);
  for (let frame = 0; frame < FRAMES; frame++) {
    const at = firstDiff(offline.frames[frame]!, live[frame]!);
    if (at >= 0) {
      throw new Error(`PARITY ${preset.key} frame ${frame}: first differing pixel (${at % WIDTH}, ${Math.floor(at / WIDTH)}) `
        + `offline 0x${offline.frames[frame]![at]!.toString(16)} live 0x${live[frame]![at]!.toString(16)}`);
    }
  }
  assert.equal(offline.complete.flashLimit, 'off');
  assert.equal(offline.complete.flashLimitedFrames, 0);
  // Teeth: the pre-version-2 offline semantics (no preinit) are distinguishable.
  if (!sameFrames(liveFrames(preset.bytes, seed, 0, FRAMES, resolver, { preinit: false }), live)) preinitMatters++;
}
assert.ok(preinitMatters >= PREINIT_SENSITIVE.length, `the preinit-sensitive presets must render differently without the preinit frame (${preinitMatters})`);

// ---------------------------------------------------------------- 2. cues: reseed + cut + crossfade
{
  const [a, b, c] = [picks[1]!, picks[4]!, picks[7]!];
  const cues: OfflinePresetCueTransfer[] = [
    { frame: 0, presetId: a.key, seed: 11, transitionFrames: 0 },
    { frame: 4, presetId: b.key, seed: 22, transitionFrames: 0 },
    { frame: 8, presetId: c.key, seed: 33, transitionFrames: 3 },
  ];
  const offline = await runOfflineJob([a, b, c].map((p) => ({ presetId: p.key, bytes: p.bytes })), cues);
  const liveA = liveFrames(a.bytes, 11, 0, 4, resolver);
  // A cue starts from its own seed and a fresh runtime whatever came before.
  const liveB = liveFrames(b.bytes, 22, 4, FRAMES - 4, resolver);
  const liveC = liveFrames(c.bytes, 33, 8, FRAMES - 8, resolver);
  const expected: Uint32Array[] = [...liveA, ...liveB.slice(0, 4)];
  for (let frame = 8; frame < FRAMES; frame++) {
    const progress = Math.min(1, (frame - 8) / 3);
    if (progress < 1) {
      const mixed = new Uint32Array(WIDTH * HEIGHT);
      blendPackedRgb(liveB[frame - 4]!, liveC[frame - 8]!, progress, mixed);
      expected.push(mixed);
    } else {
      expected.push(liveC[frame - 8]!);
    }
  }
  for (let frame = 0; frame < FRAMES; frame++) {
    assert.equal(firstDiff(offline.frames[frame]!, expected[frame]!), -1, `multi-cue frame ${frame} matches the per-cue live replay`);
  }
}

// ---------------------------------------------------------------- 3. opt-in flash limiting
fixture = { frames: FLASH_FRAMES, samples: FLASH_SAMPLES };
// Pick the presets the limiter actually engages on (plus one it may not), so
// equality with the reference is not vacuous.
const limiterReference = (bytes: Uint8Array, seed: number): { frames: Uint32Array[]; limited: number } => {
  const limiter = new FlashLimiter('limit');
  const stats = createFrameStats();
  const prevOut = new Uint32Array(WIDTH * HEIGHT);
  let limited = 0;
  const frames = liveFrames(bytes, seed, 0, fixture.frames, resolver).map((frame, index) => {
    const present = frame.slice();
    if (limitPackedFrame(limiter, stats, present, prevOut, WIDTH, HEIGHT, index / FPS).blend < 1) limited++;
    return present;
  });
  return { frames, limited };
};
const flashy = corpus.map((preset) => ({ preset, limited: limiterReference(preset.bytes, 5).limited }))
  .filter((entry) => entry.limited > 0)
  .sort((a, b) => b.limited - a.limited || a.preset.key.localeCompare(b.preset.key));
assert.ok(flashy.length > 0, 'the strobing fixture must make the limiter engage on at least one bundled preset');
let limitedTotal = 0;
for (const preset of [...flashy.slice(0, 3).map((entry) => entry.preset), picks[0]!]) {
  const cues = [{ frame: 0, presetId: preset.key, seed: 5, transitionFrames: 0 }];
  const first = await runOfflineJob([{ presetId: preset.key, bytes: preset.bytes }], cues, { flashLimit: 'limit' });
  const second = await runOfflineJob([{ presetId: preset.key, bytes: preset.bytes }], cues, { flashLimit: 'limit' });
  assert.equal(first.complete.flashLimit, 'limit');
  assert.deepEqual(first.complete.artifacts.map((x) => x.rgbSha256), second.complete.artifacts.map((x) => x.rgbSha256),
    `${preset.key}: flash-limited export is deterministic`);
  // Reference: the in-place limiter over the live frames, t = frame / fps.
  const reference = limiterReference(preset.bytes, 5);
  for (let frame = 0; frame < FLASH_FRAMES; frame++) {
    assert.equal(firstDiff(first.frames[frame]!, reference.frames[frame]!), -1, `${preset.key} frame ${frame}: limited export == limiter(live)`);
  }
  assert.equal(first.complete.flashLimitedFrames, reference.limited);
  limitedTotal += reference.limited;
}

// ---------------------------------------------------------------- 4. validation
await assert.rejects(() => runOfflineJob([{ presetId: picks[0]!.key, bytes: picks[0]!.bytes }],
  [{ frame: 0, presetId: picks[0]!.key, seed: 1, transitionFrames: 0 }],
  { flashLimit: 'sometimes' as unknown as 'limit' }), /Unknown flash limit mode/);

console.log(`offline/live parity: ${PRESET_PICKS} presets x ${FRAMES} frames at ${WIDTH}x${HEIGHT} bit-identical `
  + `(preinit distinguishes ${preinitMatters}); per-cue reseed, cut and crossfade match; `
  + `flash limiting deterministic and equal to the in-place limiter (${limitedTotal} limited frames; engages on ${flashy.length} bundled presets); `
  + 'sRGB-tagged PNGs decode to the RGB24 ledger');

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
