import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  AVS_AUDIO_SAMPLES,
  AvsCompatibilityRuntime,
  createAvsCompatibilityRegistry,
  parseAvsPreset,
  registerAvsBeatParticleEffects,
  type AvsAudioFrame,
  type AvsPresetAst,
  type AvsStereoPcm,
} from '../src/avs/index.ts';

// Corpus pixel-exactness gate. Every frame of every bundled preset is FNV
// hashed through both render() and renderPcm() with a deterministic registry,
// then compared against tools/avs-corpus-hashes.json. Any speed change to
// src/avs must leave these hashes bit-identical.

type ReferenceModule = typeof import('../src/avs/index.ts');
type RenderPath = 'render' | 'renderPcm';

interface Tier {
  frames: number;
  sizes: readonly { width: number; height: number }[];
}

interface TierBaseline {
  frames: number;
  sizes: string[];
  recordedAt: string;
  node: string;
  presets: Record<string, Record<string, Record<RenderPath, string[]>>>;
}

interface BaselineFile {
  schemaVersion: 1;
  hash: string;
  note: string;
  tiers: Partial<Record<'fast' | 'full', TierBaseline>>;
}

const ROOTS = [
  { collection: 'community-picks', path: resolve('assets/avs-presets/community-picks') },
  { collection: 'winamp-5-picks', path: resolve('assets/avs-presets/winamp-5-picks') },
] as const;
const EXPECTED_PRESETS = 124;
const BASELINE = resolve('tools/avs-corpus-hashes.json');
const PATHS: readonly RenderPath[] = ['render', 'renderPcm'];
// 317x179 is odd in both axes and not a multiple of any kernel/block size,
// so border, wrap and remainder-row code paths are exercised.
const TIERS: Record<'fast' | 'full', Tier> = {
  fast: { frames: 4, sizes: [{ width: 317, height: 179 }] },
  full: { frames: 16, sizes: [{ width: 640, height: 360 }, { width: 317, height: 179 }] },
};

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  printUsage();
  process.exit(0);
}
const tierName = args.includes('--full') ? 'full' : 'fast';
const tier = TIERS[tierName];
const record = args.includes('--record');
const requireComplete = args.includes('--require-complete');
const presetFilter = readOption('preset').toLowerCase();
if (record && presetFilter) throw new Error('--record cannot be combined with --preset; baselines cover the whole corpus');

const audioFrames = deterministicAudioFrames(tier.frames);
const pcmFrames = deterministicPcmFrames(tier.frames);
const corpus = loadCorpus();
if (corpus.length !== EXPECTED_PRESETS) throw new Error(`found ${corpus.length} presets, expected ${EXPECTED_PRESETS}`);
const selected = presetFilter ? corpus.filter(preset => preset.key.toLowerCase().includes(presetFilter)) : corpus;
if (selected.length === 0) throw new Error(`No presets match --preset=${JSON.stringify(presetFilter)}`);

const baselineFile = readBaseline();
const baseline = baselineFile?.tiers[tierName];
if (!record && !baseline) {
  throw new Error(`${BASELINE} has no '${tierName}' tier; record one from a known-good tree with --${tierName} --record`);
}
if (!record && baseline && (baseline.frames !== tier.frames || baseline.sizes.join() !== tier.sizes.map(sizeText).join())) {
  throw new Error(`baseline '${tierName}' tier was recorded with different frames/sizes; re-record it`);
}

const started = performance.now();
let rendered = 0;
let unsupported = 0;
let mismatches = 0;
let checksum = 0x811c9dc5;
const recorded: TierBaseline['presets'] = {};

for (const [index, preset] of selected.entries()) {
  const entry: Record<string, Record<RenderPath, string[]>> = {};
  for (const size of tier.sizes) {
    const bySize = { render: [] as string[], renderPcm: [] as string[] };
    for (const path of PATHS) {
      const hashes = bySize[path];
      renderFrames(preset.ast, size.width, size.height, path, (runtimeFrame, stats) => {
        rendered += stats.rendered;
        unsupported += stats.unsupported;
        hashes.push(hex(hashPixels(runtimeFrame)));
      });
      for (const hash of hashes) checksum = (Math.imul(checksum ^ parseInt(hash, 16), 0x01000193)) >>> 0;
      const expected = baseline?.presets[preset.key]?.[sizeText(size)]?.[path];
      if (!record) {
        if (!expected) throw new Error(`${preset.key}: no baseline hashes for ${sizeText(size)} ${path}`);
        const frame = hashes.findIndex((hash, i) => hash !== expected[i]);
        if (frame >= 0) {
          mismatches++;
          if (mismatches === 1) await reportFirstMismatch(preset, size.width, size.height, path, frame, expected[frame]!, hashes[frame]!);
          else console.error(`MISMATCH ${preset.key} ${sizeText(size)} ${path} frame ${frame}`);
        }
      }
    }
    entry[sizeText(size)] = bySize;
  }
  recorded[preset.key] = entry;
  if ((index + 1) % 31 === 0) console.error(`  ${index + 1}/${selected.length}`);
}

if (requireComplete && unsupported !== 0) throw new Error(`${unsupported} unsupported renderer executions remain`);
if (rendered === 0) throw new Error('corpus render executed no renderer records');
const seconds = ((performance.now() - started) / 1000).toFixed(1);
const summary = `${selected.length} presets; ${tier.frames} frames x ${tier.sizes.map(sizeText).join('+')} x render+renderPcm; `
  + `${rendered} renderer executions; ${unsupported} unsupported; corpus hash ${hex(checksum)}; ${seconds} s`;

if (record) {
  const file: BaselineFile = baselineFile ?? {
    schemaVersion: 1,
    hash: 'FNV-1a over packed 0x00RRGGBB framebuffer words, one hash per frame; frame 0 is the preinit frame; registry randomInt=0, Custom BPM clock +25 ms per read',
    note: 'Generated by node tools/run-avs-corpus-render-check.mjs --record [--full]. Do not hand-edit.',
    tiers: {},
  };
  file.tiers[tierName] = {
    frames: tier.frames,
    sizes: tier.sizes.map(sizeText),
    recordedAt: new Date().toISOString(),
    node: process.version,
    presets: recorded,
  };
  writeFileSync(BASELINE, `${JSON.stringify(file, null, 1)}\n`);
  console.log(`avs-corpus-render-check: RECORDED ${tierName} (${summary}) -> ${BASELINE}`);
} else if (mismatches > 0) {
  console.error(`avs-corpus-render-check: FAIL ${tierName} (${mismatches} preset/size/path streams differ; ${summary})`);
  process.exitCode = 1;
} else {
  console.log(`avs-corpus-render-check: PASS ${tierName} (${summary})`);
}

function renderFrames(
  ast: AvsPresetAst, width: number, height: number, path: RenderPath,
  visit: (pixels: Uint32Array, stats: { rendered: number; unsupported: number }) => void,
  module: Pick<ReferenceModule, 'AvsCompatibilityRuntime' | 'createAvsCompatibilityRegistry' | 'registerAvsBeatParticleEffects'> = {
    AvsCompatibilityRuntime, createAvsCompatibilityRegistry, registerAvsBeatParticleEffects,
  },
): void {
  const registry = module.createAvsCompatibilityRegistry({ randomInt: () => 0 });
  // Custom BPM's arbitrary-interval mode reads GetTickCount; the default is the
  // wall clock, which made Retrosquares and hubble002 nondeterministic. A clock
  // that advances 25 ms per read is reproducible. Re-registering also replaces
  // Moving Particle and Starfield, whose defaults (no random hook) are unchanged.
  let tick = 0;
  module.registerAvsBeatParticleEffects(registry, { now: () => (tick += 25) });
  const runtime = new module.AvsCompatibilityRuntime(ast, width, height, registry);
  for (let frame = 0; frame < tier.frames; frame++) {
    const result = path === 'render'
      ? runtime.render(audioFrames[frame]!, frame === 0)
      : runtime.renderPcm(pcmFrames[frame]!, frame === 0);
    visit(result.framebuffer.pixels, result.stats);
  }
}

async function reportFirstMismatch(
  preset: CorpusPreset, width: number, height: number, path: RenderPath,
  frame: number, expected: string, actual: string,
): Promise<void> {
  console.error(
    `MISMATCH ${preset.key} ${width}x${height} ${path} frame ${frame}: expected ${expected}, got ${actual}` +
    `${frame === 0 ? ' (preinit frame)' : ''}`,
  );
  const referencePath = process.env.AAAVS_CORPUS_REFERENCE_BUNDLE;
  if (!referencePath) {
    console.error('  (pass --reference=<pristine tree root> to locate the first differing pixel)');
    return;
  }
  const reference = await import(referencePath) as ReferenceModule;
  const referenceAst = reference.parseAvsPreset(preset.bytes);
  const want: Uint32Array[] = [];
  const got: Uint32Array[] = [];
  renderFrames(referenceAst as AvsPresetAst, width, height, path, (pixels) => { want.push(pixels.slice()); }, reference);
  renderFrames(preset.ast, width, height, path, (pixels) => { got.push(pixels.slice()); });
  const referenceHash = hex(hashPixels(want[frame]!));
  if (referenceHash !== expected) {
    console.error(`  reference tree hashes frame ${frame} to ${referenceHash}, not the baseline ${expected}; the reference is not the recorded tree`);
  }
  const a = want[frame]!;
  const b = got[frame]!;
  let differing = 0;
  let first = -1;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { differing++; if (first < 0) first = i; }
  if (first < 0) {
    console.error('  reference and current pixels agree on this frame; the difference is nondeterministic');
    return;
  }
  const x = first % width;
  const y = Math.floor(first / width);
  console.error(
    `  first differing pixel (${x}, ${y}): expected 0x${hex(a[first]! >>> 0)}, got 0x${hex(b[first]! >>> 0)}; ` +
    `${differing} of ${a.length} pixels differ in this frame`,
  );
}

interface CorpusPreset {
  key: string;
  bytes: Uint8Array;
  ast: AvsPresetAst;
}

function loadCorpus(): CorpusPreset[] {
  return ROOTS.flatMap(({ collection, path }) => readdirSync(path)
    .filter(name => name.toLowerCase().endsWith('.avs'))
    .sort((a, b) => a.localeCompare(b))
    .map(name => {
      const buffer = readFileSync(join(path, name));
      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      return { key: `${collection}/${name}`, bytes, ast: parseAvsPreset(bytes) };
    }));
}

function readBaseline(): BaselineFile | null {
  if (!existsSync(BASELINE)) return null;
  return JSON.parse(readFileSync(BASELINE, 'utf8')) as BaselineFile;
}

function hashPixels(pixels: Uint32Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < pixels.length; i++) hash = Math.imul(hash ^ pixels[i]!, 0x01000193);
  return hash >>> 0;
}

function hex(value: number): string { return value.toString(16).padStart(8, '0'); }
function sizeText(size: { width: number; height: number }): string { return `${size.width}x${size.height}`; }

function readOption(name: string): string {
  const prefix = `--${name}=`;
  return args.find(arg => arg.startsWith(prefix))?.slice(prefix.length) ?? '';
}

function deterministicAudioFrames(count: number): readonly AvsAudioFrame[] {
  return Array.from({ length: count }, (_, frame) => {
    const waveform = [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)] as const;
    const spectrum = [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)] as const;
    const beat = frame % 3 === 1;
    for (let channel = 0; channel < 2; channel++) {
      for (let i = 0; i < AVS_AUDIO_SAMPLES; i++) {
        const phase = i * (channel === 0 ? 0.071 : 0.113) + frame * 0.37;
        waveform[channel][i] = Math.trunc(Math.sin(phase) * (beat ? 112 : 48)) & 255;
        spectrum[channel][i] = Math.max(0, 220 - Math.trunc(i * 0.35) - channel * 17 - (frame % 4) * 9);
      }
    }
    return { waveform, spectrum, beat, beatLevel: beat ? 576 * 72 : 576 * 24 };
  });
}

function deterministicPcmFrames(count: number): readonly AvsStereoPcm[] {
  return Array.from({ length: count }, (_, frame) => {
    const left = new Float32Array(AVS_AUDIO_SAMPLES);
    const right = new Float32Array(AVS_AUDIO_SAMPLES);
    const amplitude = frame % 3 === 1 ? 0.9 : 0.42;
    for (let i = 0; i < AVS_AUDIO_SAMPLES; i++) {
      left[i] = Math.sin(i * 0.071 + frame * 0.37) * amplitude;
      right[i] = Math.sin(i * 0.113 + frame * 0.29) * amplitude;
    }
    return { left, right };
  });
}

function printUsage(): void {
  console.log(`AVS corpus pixel-exactness gate

Usage: node tools/run-avs-corpus-render-check.mjs [options]

  --fast                  4 frames at 317x179, both render paths (default)
  --full                  16 frames at 640x360 and 317x179, both render paths
  --record                write this tier's hashes to tools/avs-corpus-hashes.json
  --require-complete      also fail on any unsupported renderer execution
  --preset=TEXT           compare only presets whose collection/name contains TEXT
  --reference=DIR         pristine tree root (containing src/avs/index.ts); on the
                          first mismatch, re-render it to report the first differing pixel
  -h, --help              show this help`);
}
