import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  AVS_AUDIO_SAMPLES,
  AvsAudioAnalyser,
  AvsCompatibilityRuntime,
  createAvsCompatibilityRegistry,
  parseAvsPreset,
  registerAvsBeatParticleEffects,
  type AvsAudioFrame,
  type AvsComponent,
  type AvsEffectHandler,
  type AvsEffectRegistry,
  type AvsPresetAst,
  type AvsStereoPcm,
} from '../src/avs/index.ts';
import { planTerminalExactGpuPasses } from '../src/avs/gpu-preset-plan.ts';
import { planTerminalExactGpuConvolutions } from '../src/avs/convolution-gpu-plan.ts';
import { planTerminalEnhancedDynamicMovement } from '../src/avs/dynamic-movement-gpu-plan.ts';
import { planTerminalEnhancedSuperScope } from '../src/avs/superscope-gpu-plan.ts';
import { planTerminalEnhancedMovementEel } from '../src/avs/movement-eel-gpu-plan.ts';

const ROOTS = [
  { collection: 'Community Picks', path: resolve('assets/avs-presets/community-picks') },
  { collection: 'Winamp 5 Picks', path: resolve('assets/avs-presets/winamp-5-picks') },
] as const;

const BUILTINS = [
  'Simple', 'Dot Plane', 'Oscilloscope Star', 'Fade Out', 'Blitter Feedback',
  'OnBeat Clear', 'Blur', 'Bass Spin', 'Moving Particle', 'Roto Blitter',
  'SVP Loader', 'Color Fade', 'Color Clip', 'Rotating Stars', 'Ring',
  'Movement', 'Scatter', 'Dot Grid', 'Buffer Save', 'Dot Fountain', 'Water',
  'Comment', 'Brightness', 'Interleave', 'Grain', 'Clear Screen', 'Mirror',
  'Starfield', 'Text', 'Bump', 'Mosaic', 'Water Bump', 'AVI', 'Custom BPM',
  'Picture', 'Dynamic Distance Modifier', 'SuperScope', 'Invert', 'Unique Tone',
  'Timescope', 'Set Render Mode', 'Interferences', 'Dynamic Shift',
  'Dynamic Movement', 'Fast Brightness', 'Dynamic Color Modifier',
] as const;

type Lane = 'cpu' | 'exact' | '120';

interface CorpusPreset {
  collection: string;
  name: string;
  bytes: Uint8Array;
  ast: AvsPresetAst;
  /** CPU graph actually executed for --lane (the residual after terminal GPU extraction). */
  cpuAst: AvsPresetAst;
  gpuExtractedComponents: number;
}

interface Timings {
  medianMs: number;
  meanMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  samples: number;
}

interface ScanEntry {
  collection: string;
  name: string;
  render: Timings;
  /** Construct + preinit + first frame: the preset-load hitch, dominated by EEL compile and JIT tier-up. */
  firstFrameMs: number;
  /** FNV over every measured frame's pixels; a change means the patch is not bit-exact. */
  hash: string;
  gpuExtractedComponents: number;
}

interface EffectTiming {
  label: string;
  totalMs: number;
  calls: number;
  meanCallMs: number;
  shareOfHandlerTime: number;
}

interface EffectCorpusTiming {
  label: string;
  sumMsPerFrame: number;
  presets: number;
  calls: number;
}

interface SizeBenchmark {
  width: number;
  height: number;
  pixels: number;
  construct: Timings;
  preinit: Timings;
  render: Timings;
  renderPcm: Timings;
  audioAnalyse: Timings;
  rgbaBytes: Timings;
  rgbaAllocationBytesPerCall: number;
  retainedHeapBytesAfterInit: number | null;
  retainedArrayBufferBytesAfterInit: number | null;
}

interface PresetBenchmark {
  collection: string;
  name: string;
  bytes: number;
  components: number;
  parse: Timings;
  sizes: SizeBenchmark[];
}

type CorpusSummary = ReturnType<typeof summarizeCorpus>;

interface BenchmarkResult {
  options: ReturnType<typeof parseOptions>;
  scanSummary: CorpusSummary & {
    gates?: Record<'hz60' | 'hz120', CorpusSummary>;
    firstFrame?: CorpusSummary;
    corpusHash?: string;
    gpuExtractedPresets?: number;
  };
  scan: Array<Omit<ScanEntry, 'hash' | 'firstFrameMs' | 'gpuExtractedComponents'> & Partial<ScanEntry>>;
  selected: PresetBenchmark[];
  corpusEffectAttribution?: { effects: EffectCorpusTiming[] };
  effectAttribution: { effects: EffectTiming[] };
}

const cliArgs = process.argv.slice(2);
if (cliArgs.includes('--help') || cliArgs.includes('-h')) {
  printUsage();
  process.exit(0);
}
const options = parseOptions(cliArgs);
// Enough distinct frames that warm-up and measured frames never repeat audio.
const frameCount = Math.max(options.frames, options.scanFrames) + options.warmupFrames + 3;
const audioFrames = deterministicAudioFrames(Math.max(frameCount, 8));
const pcmFrames = deterministicPcmFrames(Math.max(frameCount, 8));
const fullCorpus = loadCorpus();
const corpus = options.presetPattern
  ? fullCorpus.filter((preset) => preset.name.toLowerCase().includes(options.presetPattern.toLowerCase()))
  : fullCorpus;
if (corpus.length === 0) throw new Error(`No presets match --preset=${JSON.stringify(options.presetPattern)}`);

console.error(
  `Scanning ${corpus.length} presets at ${options.scanWidth}x${options.scanHeight} ` +
  `(lane ${options.lane}; ${options.warmupFrames} warm-up + ${options.scanFrames} measured renderPcm frames)...`,
);
const scan: ScanEntry[] = corpus.map((preset, index) => {
  const entry = scanPreset(preset);
  if ((index + 1) % 20 === 0) console.error(`  ${index + 1}/${corpus.length}`);
  return entry;
});
let corpusHash = 0x811c9dc5;
for (const entry of scan) corpusHash = Math.imul(corpusHash ^ parseInt(entry.hash, 16), 0x01000193);

const selected = ROOTS.flatMap(({ collection }) => scan
  .filter((entry) => entry.collection === collection)
  .sort((a, b) => b.render.medianMs - a.render.medianMs)
  .slice(0, options.top)
  .map((entry) => corpus.find((preset) => preset.collection === collection && preset.name === entry.name)!));

console.error(`Benchmarking ${selected.length} heaviest presets at ${options.sizes.map(sizeText).join(', ')}...`);
const benchmarks = selected.map((preset) => benchmarkPreset(preset));
const attributionSize = options.sizes.find(({ width }) => width >= 320) ?? options.sizes.at(-1)!;
const effects = profileEffects(selected, attributionSize.width, attributionSize.height);
const corpusEffects = options.attribution ? profileCorpusEffects(corpus) : [];
const sortedScan = scan.sort((a, b) => b.render.medianMs - a.render.medianMs);
const scanMedians = sortedScan.map(entry => entry.render.medianMs);
const scanSummary = {
  ...summarizeCorpus(scanMedians, options.budgetMs),
  gates: { hz60: summarizeCorpus(scanMedians, 1000 / 60), hz120: summarizeCorpus(scanMedians, 1000 / 120) },
  firstFrame: summarizeCorpus(sortedScan.map(entry => entry.firstFrameMs), Number.POSITIVE_INFINITY),
  corpusHash: (corpusHash >>> 0).toString(16).padStart(8, '0'),
  gpuExtractedPresets: sortedScan.filter(entry => entry.gpuExtractedComponents > 0).length,
};

const result = {
  schemaVersion: 3,
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  cpu: process.env.PROCESSOR_IDENTIFIER ?? 'unknown',
  options,
  corpus: { presets: corpus.length, collections: ROOTS.map(root => root.collection) },
  scanSummary,
  scan: sortedScan,
  selected: benchmarks,
  corpusEffectAttribution: {
    width: options.scanWidth,
    height: options.scanHeight,
    lane: options.lane,
    note: 'Sum over the corpus of each preset\'s mean ms/frame per effect after warm-up; instrumented, use for ranking only.',
    effects: corpusEffects,
  },
  effectAttribution: {
    width: attributionSize.width,
    height: attributionSize.height,
    note: 'Instrumented handler timings include timer overhead; use for attribution, not absolute frame time.',
    effects,
  },
};

const json = `${JSON.stringify(result, null, 2)}\n`;
if (options.json) writeFileSync(resolve(options.json), json);
if (!options.quiet) printReport(result);
if (options.compare) printComparison(JSON.parse(readFileSync(resolve(options.compare), 'utf8')) as BenchmarkResult, result);
if ((!options.json && !options.compare) || options.stdoutJson) process.stdout.write(json);

function scanPreset(preset: CorpusPreset): ScanEntry {
  let start = performance.now();
  const runtime = new AvsCompatibilityRuntime(
    preset.cpuAst, options.scanWidth, options.scanHeight, deterministicRegistry(),
  );
  runtime.renderPcm(pcmFrames[0]!, true);
  runtime.renderPcm(pcmFrames[1]!);
  const firstFrameMs = performance.now() - start;
  let frame = 2;
  for (let index = 0; index < options.warmupFrames; index++) runtime.renderPcm(pcmFrames[frame++ % pcmFrames.length]!);
  const elapsed: number[] = [];
  let hash = 0x811c9dc5;
  for (let index = 0; index < options.scanFrames; index++) {
    start = performance.now();
    runtime.renderPcm(pcmFrames[frame++ % pcmFrames.length]!);
    elapsed.push(performance.now() - start);
    // Hashing sits outside the timed window.
    const pixels = runtime.framebuffer.pixels;
    for (let i = 0; i < pixels.length; i++) hash = Math.imul(hash ^ pixels[i]!, 0x01000193);
  }
  return {
    collection: preset.collection,
    name: preset.name,
    render: summarize(elapsed),
    firstFrameMs,
    hash: (hash >>> 0).toString(16).padStart(8, '0'),
    gpuExtractedComponents: preset.gpuExtractedComponents,
  };
}

function benchmarkPreset(preset: CorpusPreset): PresetBenchmark {
  console.error(`  ${preset.collection}/${preset.name}`);
  const parseSamples: number[] = [];
  for (let index = 0; index < options.parseIterations; index++) {
    const start = performance.now();
    parseAvsPreset(preset.bytes);
    parseSamples.push(performance.now() - start);
  }
  return {
    collection: preset.collection,
    name: preset.name,
    bytes: preset.bytes.byteLength,
    components: countComponents(preset.ast.components),
    parse: summarize(parseSamples),
    sizes: options.sizes.map(({ width, height }) => benchmarkSize(preset, width, height)),
  };
}

function benchmarkSize(preset: CorpusPreset, width: number, height: number): SizeBenchmark {
  const constructs: number[] = [];
  const preinits: number[] = [];
  for (let index = 0; index < options.initIterations; index++) {
    const registry = deterministicRegistry();
    let start = performance.now();
    const runtime = new AvsCompatibilityRuntime(preset.cpuAst, width, height, registry);
    constructs.push(performance.now() - start);
    start = performance.now();
    runtime.render(audioFrames[0]!, true);
    preinits.push(performance.now() - start);
  }

  const direct = new AvsCompatibilityRuntime(preset.cpuAst, width, height, deterministicRegistry());
  direct.render(audioFrames[0]!, true);
  direct.render(audioFrames[1]!);
  for (let index = 0; index < options.warmupFrames; index++) direct.render(audioFrames[(index + 2) % audioFrames.length]!);
  const renderSamples: number[] = [];
  for (let index = 0; index < options.frames; index++) {
    const start = performance.now();
    direct.render(audioFrames[(index + 2) % audioFrames.length]!);
    renderSamples.push(performance.now() - start);
  }

  const pcm = new AvsCompatibilityRuntime(preset.cpuAst, width, height, deterministicRegistry());
  pcm.renderPcm(pcmFrames[0]!, true);
  pcm.renderPcm(pcmFrames[1]!);
  for (let index = 0; index < options.warmupFrames; index++) pcm.renderPcm(pcmFrames[(index + 2) % pcmFrames.length]!);
  const pcmSamples: number[] = [];
  for (let index = 0; index < options.frames; index++) {
    const start = performance.now();
    pcm.renderPcm(pcmFrames[(index + 2) % pcmFrames.length]!);
    pcmSamples.push(performance.now() - start);
  }

  const analyser = new AvsAudioAnalyser();
  analyser.analyse(pcmFrames[0]!);
  const analyseSamples: number[] = [];
  for (let index = 0; index < Math.max(8, options.frames); index++) {
    const start = performance.now();
    analyser.analyse(pcmFrames[index % pcmFrames.length]!);
    analyseSamples.push(performance.now() - start);
  }

  const rgbaSamples: number[] = [];
  let rgbaGuard = 0;
  for (let index = 0; index < Math.max(8, options.frames); index++) {
    const start = performance.now();
    const bytes = direct.rgbaBytes();
    rgbaSamples.push(performance.now() - start);
    rgbaGuard ^= bytes[(index * 101) % bytes.length]!;
  }
  if (rgbaGuard === -1) console.error('unreachable', rgbaGuard);

  const retained = retainedRuntimeBytes(preset, width, height);
  return {
    width, height, pixels: width * height,
    construct: summarize(constructs),
    preinit: summarize(preinits),
    render: summarize(renderSamples),
    renderPcm: summarize(pcmSamples),
    audioAnalyse: summarize(analyseSamples),
    rgbaBytes: summarize(rgbaSamples),
    rgbaAllocationBytesPerCall: width * height * 4,
    retainedHeapBytesAfterInit: retained?.heapUsed ?? null,
    retainedArrayBufferBytesAfterInit: retained?.arrayBuffers ?? null,
  };
}

function profileEffects(presets: readonly CorpusPreset[], width: number, height: number): EffectTiming[] {
  const aggregate = new Map<string, { totalMs: number; calls: number }>();
  for (const preset of presets) {
    const registry = profilingRegistry(aggregate);
    const runtime = new AvsCompatibilityRuntime(preset.cpuAst, width, height, registry);
    runtime.render(audioFrames[0]!, true);
    runtime.render(audioFrames[1]!);
    for (let index = 0; index < Math.min(3, options.frames); index++) {
      runtime.render(audioFrames[(index + 2) % audioFrames.length]!);
    }
  }
  const totalHandlerMs = [...aggregate.values()].reduce((sum, entry) => sum + entry.totalMs, 0);
  return [...aggregate.entries()]
    .map(([label, timing]) => ({
      label,
      totalMs: timing.totalMs,
      calls: timing.calls,
      meanCallMs: timing.totalMs / timing.calls,
      shareOfHandlerTime: totalHandlerMs ? timing.totalMs / totalHandlerMs : 0,
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

function profileCorpusEffects(presets: readonly CorpusPreset[]): EffectCorpusTiming[] {
  console.error(`Attributing effects over ${presets.length} presets at ${options.scanWidth}x${options.scanHeight}...`);
  const totals = new Map<string, EffectCorpusTiming>();
  const warmup = Math.min(options.warmupFrames, 6);
  const frames = Math.max(2, Math.min(4, options.scanFrames));
  for (const preset of presets) {
    const aggregate = new Map<string, { totalMs: number; calls: number }>();
    const runtime = new AvsCompatibilityRuntime(
      preset.cpuAst, options.scanWidth, options.scanHeight, profilingRegistry(aggregate),
    );
    runtime.renderPcm(pcmFrames[0]!, true);
    // A short warm-up keeps first-frame compile cost out of the attribution.
    for (let index = 1; index <= warmup; index++) runtime.renderPcm(pcmFrames[index % pcmFrames.length]!);
    aggregate.clear();
    for (let index = 0; index < frames; index++) runtime.renderPcm(pcmFrames[(index + warmup + 1) % pcmFrames.length]!);
    for (const [label, timing] of aggregate) {
      const total = totals.get(label) ?? { label, sumMsPerFrame: 0, presets: 0, calls: 0 };
      total.sumMsPerFrame += timing.totalMs / frames;
      total.presets++;
      total.calls += timing.calls;
      totals.set(label, total);
    }
  }
  return [...totals.values()].sort((a, b) => b.sumMsPerFrame - a.sumMsPerFrame);
}

function profilingRegistry(aggregate: Map<string, { totalMs: number; calls: number }>): AvsEffectRegistry {
  const registry = deterministicRegistry();
  const original = registry.handler.bind(registry);
  const wrappers = new Map<string, AvsEffectHandler>();
  registry.handler = (component: AvsComponent): AvsEffectHandler | undefined => {
    const handler = original(component);
    if (!handler) return undefined;
    const label = effectLabel(component);
    let wrapper = wrappers.get(label);
    if (!wrapper) {
      wrapper = (context) => {
        const start = performance.now();
        try { return handler(context); }
        finally {
          const elapsed = performance.now() - start;
          const current = aggregate.get(label) ?? { totalMs: 0, calls: 0 };
          current.totalMs += elapsed;
          current.calls++;
          aggregate.set(label, current);
        }
      };
      wrappers.set(label, wrapper);
    }
    return wrapper;
  };
  return registry;
}

function retainedRuntimeBytes(
  preset: CorpusPreset, width: number, height: number,
): { heapUsed: number; arrayBuffers: number } | null {
  const collect = globalThis.gc;
  if (!collect) return null;
  collect();
  const before = process.memoryUsage();
  const runtime = new AvsCompatibilityRuntime(preset.cpuAst, width, height, deterministicRegistry());
  runtime.render(audioFrames[0]!, true);
  runtime.render(audioFrames[1]!);
  collect();
  const after = process.memoryUsage();
  // Keep the runtime observable until after the snapshot.
  if (runtime.framebuffer.width !== width) throw new Error('runtime escaped benchmark');
  return {
    heapUsed: Math.max(0, after.heapUsed - before.heapUsed),
    arrayBuffers: Math.max(0, after.arrayBuffers - before.arrayBuffers),
  };
}

function printComparison(before: BenchmarkResult, after: BenchmarkResult): void {
  const key = (entry: { collection: string; name: string }) => `${entry.collection}/${entry.name}`;
  const previous = new Map(before.scan.map(entry => [key(entry), entry] as const));
  const compared = ['scanWidth', 'scanHeight', 'scanFrames', 'warmupFrames', 'lane'] as const;
  const differing = compared.filter(name => before.options?.[name] !== after.options[name]);
  console.error(`\nComparison against ${options.compare}`);
  if (differing.length) console.error(`  WARNING: options differ (${differing.join(', ')}); timings and hashes are not comparable`);
  const row = (label: string, a: number, b: number) => console.error(
    `  ${label.padEnd(13)} ${a.toFixed(2).padStart(9)} -> ${b.toFixed(2).padStart(9)} ms  (${formatDelta(a, b)})`,
  );
  const deltas = after.scan.flatMap(entry => {
    const old = previous.get(key(entry));
    return old ? [{ entry, old, delta: entry.render.medianMs - old.render.medianMs }] : [];
  }).sort((a, b) => a.delta - b.delta);
  // Percentiles over the presets present in both runs, so --preset subsets compare like with like.
  const beforeSubset = summarizeCorpus(deltas.map(({ old }) => old.render.medianMs), 0);
  const afterSubset = summarizeCorpus(deltas.map(({ entry }) => entry.render.medianMs), 0);
  console.error(`  ${deltas.length} presets in both runs`);
  row('p50', beforeSubset.p50Ms, afterSubset.p50Ms);
  row('p90', beforeSubset.p90Ms, afterSubset.p90Ms);
  row('p99', beforeSubset.p99Ms, afterSubset.p99Ms);
  row('worst', beforeSubset.worstMs, afterSubset.worstMs);
  row('sum', deltas.reduce((sum, { old }) => sum + old.render.medianMs, 0),
    deltas.reduce((sum, { entry }) => sum + entry.render.medianMs, 0));
  const firstBefore = deltas.flatMap(({ old }) => old.firstFrameMs === undefined ? [] : [old.firstFrameMs]);
  if (firstBefore.length === deltas.length) {
    row('firstFrame50', summarizeCorpus(firstBefore, 0).p50Ms,
      summarizeCorpus(deltas.map(({ entry }) => entry.firstFrameMs ?? 0), 0).p50Ms);
  }
  const within = (values: readonly number[], budget: number) => values.filter(value => value <= budget).length;
  console.error(
    `  60 Hz within  ${within(deltas.map(({ old }) => old.render.medianMs), 1000 / 60)} -> ` +
    `${within(deltas.map(({ entry }) => entry.render.medianMs), 1000 / 60)}; ` +
    `120 Hz within ${within(deltas.map(({ old }) => old.render.medianMs), 1000 / 120)} -> ` +
    `${within(deltas.map(({ entry }) => entry.render.medianMs), 1000 / 120)}`,
  );
  console.error('\nLargest wins:');
  for (const { entry, old, delta } of deltas.slice(0, 10)) {
    console.error(
      `  ${delta.toFixed(2).padStart(8)} ms  ${old.render.medianMs.toFixed(2)} -> ${entry.render.medianMs.toFixed(2)} ` +
      `(${formatDelta(old.render.medianMs, entry.render.medianMs)})  ${key(entry)}`,
    );
  }
  console.error('Largest losses:');
  for (const { entry, old, delta } of deltas.slice(-5).reverse()) {
    console.error(
      `  ${`+${delta.toFixed(2)}`.padStart(8)} ms  ${old.render.medianMs.toFixed(2)} -> ${entry.render.medianMs.toFixed(2)} ` +
      `(${formatDelta(old.render.medianMs, entry.render.medianMs)})  ${key(entry)}`,
    );
  }
  const changed = deltas.filter(({ entry, old }) => old.hash !== undefined && old.hash !== entry.hash);
  if (changed.length === 0) {
    console.error(`\nPixel hashes: all ${deltas.length} compared presets identical`);
  } else {
    console.error(`\nPixel hashes: ${changed.length} presets CHANGED (not bit-exact; confirm with run-avs-corpus-render-check.mjs --full):`);
    for (const { entry, old } of changed) console.error(`  ${old.hash} -> ${entry.hash}  ${key(entry)}`);
    process.exitCode = 1;
  }
}

function formatDelta(before: number, after: number): string {
  if (before === 0) return 'n/a';
  const percent = (after - before) / before * 100;
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`;
}

function deterministicRegistry(): AvsEffectRegistry {
  const registry = createAvsCompatibilityRegistry({ randomInt: () => 0 });
  // Custom BPM's arbitrary-interval mode reads the wall clock by default,
  // which makes measured-frame hashes nondeterministic; step 25 ms per read.
  let tick = 0;
  registerAvsBeatParticleEffects(registry, { now: () => (tick += 25) });
  return registry;
}

function loadCorpus(): CorpusPreset[] {
  return ROOTS.flatMap(({ collection, path }) => readdirSync(path)
    .filter(name => name.toLowerCase().endsWith('.avs'))
    .sort((a, b) => a.localeCompare(b))
    .map(name => {
      const buffer = readFileSync(join(path, name));
      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const ast = parseAvsPreset(bytes);
      const lane = laneCpuPreset(ast, options.lane);
      return { collection, name: basename(name), bytes, ast, cpuAst: lane.cpuPreset, gpuExtractedComponents: lane.extracted };
    }));
}

/**
 * Mirrors the terminal-GPU planning chain of src/avs-render.worker.ts (load
 * handler, WebGPU available) and returns the CPU graph left to run each
 * frame. 'cpu' is the full graph, i.e. no GPU.
 */
function laneCpuPreset(ast: AvsPresetAst, lane: Lane): { cpuPreset: AvsPresetAst; extracted: number } {
  if (lane === 'cpu') return { cpuPreset: ast, extracted: 0 };
  let extracted = 0;
  let input = ast;
  if (lane === '120') {
    const dynamicMovement = planTerminalEnhancedDynamicMovement(input);
    if (dynamicMovement.component) { input = dynamicMovement.cpuPreset; extracted++; }
    const superScope = planTerminalEnhancedSuperScope(input);
    if (superScope.component) { input = superScope.cpuPreset; extracted++; }
    const movementEel = planTerminalEnhancedMovementEel(input);
    if (movementEel.component) { input = movementEel.cpuPreset; extracted++; }
  }
  const exact = planTerminalExactGpuPasses(input);
  const convolutions = planTerminalExactGpuConvolutions(exact.cpuPreset);
  extracted += exact.extractedComponents + convolutions.extractedComponents;
  return { cpuPreset: convolutions.cpuPreset, extracted };
}

function deterministicAudioFrames(count: number): readonly AvsAudioFrame[] {
  return Array.from({ length: count }, (_, frame) => {
    const waveform = [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)] as const;
    const spectrum = [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)] as const;
    const beat = frame % 5 === 1;
    for (let channel = 0; channel < 2; channel++) for (let i = 0; i < AVS_AUDIO_SAMPLES; i++) {
      const phase = i * (channel === 0 ? 0.071 : 0.113) + frame * 0.37;
      waveform[channel][i] = Math.trunc(Math.sin(phase) * (beat ? 112 : 48)) & 255;
      spectrum[channel][i] = Math.max(0, 220 - Math.trunc(i * 0.35) - channel * 17);
    }
    return { waveform, spectrum, beat, beatLevel: beat ? 576 * 72 : 576 * 24 };
  });
}

function deterministicPcmFrames(count: number): readonly AvsStereoPcm[] {
  return Array.from({ length: count }, (_, frame) => {
    const left = new Float32Array(AVS_AUDIO_SAMPLES);
    const right = new Float32Array(AVS_AUDIO_SAMPLES);
    const amplitude = frame % 5 === 1 ? 0.9 : 0.42;
    for (let i = 0; i < AVS_AUDIO_SAMPLES; i++) {
      left[i] = Math.sin(i * 0.071 + frame * 0.37) * amplitude;
      right[i] = Math.sin(i * 0.113 + frame * 0.29) * amplitude;
    }
    return { left, right };
  });
}

function summarize(samples: readonly number[]): Timings {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return {
    medianMs: median,
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!,
    minMs: sorted[0]!, maxMs: sorted.at(-1)!, samples: sorted.length,
  };
}

function summarizeCorpus(samples: readonly number[], budgetMs: number) {
  const sorted = [...samples].sort((a, b) => a - b);
  const withinBudget = sorted.filter(value => value <= budgetMs).length;
  return {
    budgetMs,
    presets: sorted.length,
    withinBudget,
    overBudget: sorted.length - withinBudget,
    withinBudgetRatio: sorted.length === 0 ? 0 : withinBudget / sorted.length,
    p50Ms: percentile(sorted, 0.50),
    p90Ms: percentile(sorted, 0.90),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    worstMs: sorted.at(-1) ?? 0,
  };
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]!;
}

function countComponents(components: readonly AvsComponent[]): number {
  let count = 0;
  for (const component of components) count += 1 + countComponents(component.children);
  return count;
}

function effectLabel(component: AvsComponent): string {
  return component.apeId ?? `builtin:${component.effectId} ${BUILTINS[component.effectId] ?? 'Unknown'}`;
}

function sizeText(size: { width: number; height: number }): string { return `${size.width}x${size.height}`; }

function parseOptions(args: readonly string[]) {
  const read = (name: string, fallback: string): string => {
    const prefix = `--${name}=`;
    return args.find(arg => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback;
  };
  const quick = args.includes('--quick');
  const sizes = read('sizes', quick ? '96x54' : '96x54,320x180,640x360').split(',').map(value => {
    const match = /^(\d+)x(\d+)$/.exec(value.trim());
    if (!match) throw new Error(`Invalid size ${JSON.stringify(value)}`);
    return { width: Number(match[1]), height: Number(match[2]) };
  });
  const scan = /^(\d+)x(\d+)$/.exec(read('scan-size', quick ? '96x54' : '640x360'));
  if (!scan) throw new Error('Invalid --scan-size');
  const lane = read('lane', 'cpu');
  if (lane !== 'cpu' && lane !== 'exact' && lane !== '120') throw new Error('--lane must be cpu, exact or 120');
  const scanFrames = Number(read('scan-frames', quick ? '3' : '12'));
  if (!quick && scanFrames < 12) console.error(`WARNING: --scan-frames=${scanFrames} is below 12; medians will be noisy`);
  return {
    quick,
    lane: lane as Lane,
    scanWidth: Number(scan[1]), scanHeight: Number(scan[2]),
    scanFrames,
    warmupFrames: Number(read('warmup-frames', quick ? '2' : '30')),
    frames: Number(read('frames', quick ? '5' : '12')),
    parseIterations: Number(read('parse-iterations', '20')),
    initIterations: Number(read('init-iterations', '3')),
    top: Number(read('top', '4')),
    budgetMs: Number(read('budget-ms', (1000 / 120).toString())),
    presetPattern: read('preset', ''),
    sizes,
    json: read('json', ''),
    compare: read('compare', ''),
    attribution: !args.includes('--no-attribution'),
    quiet: args.includes('--quiet'),
    stdoutJson: args.includes('--stdout-json'),
  };
}

function printUsage(): void {
  console.log(`AVS performance benchmark

Usage: node tools/run-avs-performance-benchmark.mjs [options]

  --preset=TEXT           only names containing TEXT
  --scan-size=WxH         corpus scan size (default 640x360, the production size)
  --warmup-frames=N       unmeasured frames after the first frame (default 30)
  --scan-frames=N         measured renderPcm frames per preset (default 12)
  --lane=cpu|exact|120    time the full CPU graph (default) or the residual CPU
                          graph left after that lane's terminal GPU extraction
  --quick                 old triage mode: 96x54, 2 warm-up + 3 measured frames
  --sizes=WxH,...         detailed sizes (default 96x54,320x180,640x360)
  --frames=N              detailed measured frames (default 12)
  --top=N                 slowest presets per collection (default 4)
  --budget-ms=N           extra corpus budget gate (default 8.333, 120 Hz);
                          60 Hz and 120 Hz gates are always reported
  --no-attribution        skip corpus-wide per-effect attribution
  --compare=PATH          compare against an earlier --json result: percentiles,
                          per-preset deltas and pixel-hash changes (exit 1 when
                          any measured-frame hash changed)
  --json=PATH             write machine-readable results
  --stdout-json           print JSON even when --json or --compare is used
  --quiet                 suppress human report
  -h, --help              show this help without running the corpus`);
}

function printReport(result: {
  options: typeof options;
  scanSummary: typeof scanSummary;
  scan: ScanEntry[];
  selected: PresetBenchmark[];
  corpusEffectAttribution: { effects: EffectCorpusTiming[] };
  effectAttribution: { effects: EffectTiming[] };
}): void {
  const summary = result.scanSummary;
  console.error(
    `\nCorpus steady state @ ${result.options.scanWidth}x${result.options.scanHeight}, lane ${result.options.lane}: ` +
    `p50 ${summary.p50Ms.toFixed(2)}, p90 ${summary.p90Ms.toFixed(2)}, ` +
    `p95 ${summary.p95Ms.toFixed(2)}, p99 ${summary.p99Ms.toFixed(2)}, worst ${summary.worstMs.toFixed(2)} ms; ` +
    `pixel hash ${summary.corpusHash}`,
  );
  for (const [label, gate] of [['60 Hz', summary.gates.hz60], ['120 Hz', summary.gates.hz120]] as const) {
    console.error(
      `  ${label.padEnd(6)} gate @ ${gate.budgetMs.toFixed(2)} ms: ${gate.withinBudget}/${gate.presets} within ` +
      `(${(gate.withinBudgetRatio * 100).toFixed(1)}%)`,
    );
  }
  if (Math.abs(summary.budgetMs - 1000 / 120) > 1e-9) {
    console.error(`  custom gate @ ${summary.budgetMs.toFixed(2)} ms: ${summary.withinBudget}/${summary.presets} within`);
  }
  if (result.options.lane !== 'cpu') console.error(`  ${summary.gpuExtractedPresets} presets have GPU-extracted components`);
  console.error(
    `First frame (construct + preinit + first render): p50 ${summary.firstFrame.p50Ms.toFixed(2)}, ` +
    `p90 ${summary.firstFrame.p90Ms.toFixed(2)}, worst ${summary.firstFrame.worstMs.toFixed(2)} ms`,
  );
  console.error('\nSlowest corpus presets (steady-state median):');
  for (const entry of result.scan.slice(0, 12)) {
    console.error(
      `  ${entry.render.medianMs.toFixed(2).padStart(8)} ms  first ${entry.firstFrameMs.toFixed(1).padStart(7)} ms  ` +
      `${entry.collection}/${entry.name}`,
    );
  }
  if (result.corpusEffectAttribution.effects.length) {
    console.error('\nCorpus-wide effect cost (sum of per-preset ms/frame):');
    for (const effect of result.corpusEffectAttribution.effects.slice(0, 12)) {
      console.error(
        `  ${effect.sumMsPerFrame.toFixed(1).padStart(9)} ms  ${String(effect.presets).padStart(4)} presets  ${effect.label}`,
      );
    }
  }
  console.error('\nSelected multi-resolution medians:');
  for (const preset of result.selected) for (const size of preset.sizes) {
    console.error(
      `  ${String(size.width).padStart(4)}x${String(size.height).padEnd(4)} ` +
      `${size.render.medianMs.toFixed(2).padStart(8)} ms render  ` +
      `${size.renderPcm.medianMs.toFixed(2).padStart(8)} ms renderPcm  ` +
      `${size.rgbaBytes.medianMs.toFixed(2).padStart(7)} ms rgba  ${preset.name}`,
    );
  }
  console.error('\nTop instrumented effect handlers (selected presets):');
  for (const effect of result.effectAttribution.effects.slice(0, 15)) {
    console.error(
      `  ${effect.totalMs.toFixed(2).padStart(9)} ms  ` +
      `${(effect.shareOfHandlerTime * 100).toFixed(1).padStart(5)}%  ` +
      `${String(effect.calls).padStart(5)} calls  ${effect.label}`,
    );
  }
}
