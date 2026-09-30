import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  AVS_AUDIO_SAMPLES,
  AvsCompatibilityRuntime,
  createAvsCompatibilityRegistry,
  parseAvsPreset,
  type AvsAudioFrame,
  type AvsComponent,
  type AvsPresetAst,
} from '../src/avs/index.ts';
import { planTerminalExactGpuPasses } from '../src/avs/gpu-preset-plan.ts';

const BUILTIN_NAMES = [
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

// These sets are migration classifications, not claims that kernels exist.
// `parallel` means one invocation can own one destination pixel with exact
// integer arithmetic. `ordered` means multiple primitives can hit the same
// destination and native draw order/blending is observable.
const PARALLEL_BUILTINS = new Set([3, 4, 5, 6, 9, 11, 12, 15, 16, 20, 22, 23, 24, 25, 26, 29, 30, 31, 35, 37, 38, 42, 43, 44, 45]);
const ORDERED_WRITE_BUILTINS = new Set([0, 1, 2, 7, 8, 13, 14, 17, 19, 27, 28, 36, 39, 41]);
const EEL_ORDER_BUILTINS = new Set([35, 36, 42, 43, 45]);
const STATEFUL_BUILTINS = new Set([4, 8, 20, 27, 29, 31]);
const CONTROL_BUILTINS = new Set([18, 21, 33, 40]);
const PARALLEL_APES = new Set([
  'Color Map', 'Color Reduction', 'Channel Shift', 'Multiplier',
  'Holden03: Convolution Filter', 'Multi Filter', 'Virtual Effect: Addborders',
]);
const ORDERED_WRITE_APES = new Set(['Acko.net: Texer', 'Acko.net: Texer II', 'Texer', 'Texer II']);

interface SourcePreset { collection: string; path: string; name: string; ast: AvsPresetAst; bytes: number }
interface AuditRow {
  collection: string;
  name: string;
  bytes: number;
  components: number;
  currentExactTerminalBlurPasses: number;
  candidateTerminalParallelRun: number;
  parallelCandidateNodes: number;
  orderedWriteNodes: number;
  eelOrderNodes: number;
  statefulNodes: number;
  unknownVisualNodes: number;
  effectLists: number;
  retainedEffectLists: number;
  listDepthBufferDependencies: number;
  bufferSaveNodes: number;
  rootFeedback: boolean;
}

const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const width = Number(option('width', '640'));
const height = Number(option('height', '360'));
const privateSampleSize = Number(option('private-sample', '64'));
const output = resolve(option('json', 'docs/research/avs-gpu-migration-audit-2026-08-13.json'));
const roots = [
  { collection: 'Community Picks', path: resolve('assets/avs-presets/community-picks') },
  { collection: 'Winamp 5 Picks', path: resolve('assets/avs-presets/winamp-5-picks') },
  { collection: 'Private unique collection', path: resolve('avs presets/presets/unique') },
];

const parseFailures: Array<{ collection: string; name: string; error: string }> = [];
const presets = roots.flatMap(root => load(root.collection, root.path));
const rows = presets.map(audit);
const bundled = rows.filter(row => row.collection !== 'Private unique collection');
const privateRows = rows.filter(row => row.collection === 'Private unique collection');
const privatePresets = presets.filter(row => row.collection === 'Private unique collection');
const sampleCandidates = privatePresets
  .filter(preset => preset.bytes <= 200_000 && countComponents(preset.ast.components) <= 128)
  .sort((a, b) => hashName(a.name) - hashName(b.name) || a.name.localeCompare(b.name))
  .slice(0, privateSampleSize);
const sample = benchmarkSample(sampleCandidates, width, height);

const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  node: process.version,
  dimensions: { width, height, pixels: width * height, packedFramebufferBytes: width * height * 4 },
  methodology: {
    exactTerminal: 'Production planTerminalExactGpuPasses result.',
    parallelCandidate: 'Static renderer class: one invocation can own one destination pixel; kernel not necessarily implemented.',
    orderedWrite: 'Multiple primitives may target the same destination; native draw order/blend is observable.',
    retainedList: 'Effect List is not the replace-in/replace-out fast path and therefore owns a retained local surface.',
    privateSample: `Deterministic filename-hash sample of ${privateSampleSize}; presets over 200 KB or 128 nodes excluded from timing only. Classification always covers every parseable preset.`,
  },
  parseFailures,
  bundled: summarize(bundled),
  privateCollection: summarize(privateRows),
  terminalMigration: {
    bundled: terminalMigration(presets.filter(preset => preset.collection !== 'Private unique collection')),
    privateCollection: terminalMigration(privatePresets),
  },
  effectFrequency: effectFrequency(presets),
  privatePerformanceSample: sample,
  rows,
};
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ output, bundled: result.bundled, privateCollection: result.privateCollection, privatePerformanceSample: sample.summary, parseFailures }, null, 2));

function load(collection: string, path: string): SourcePreset[] {
  return readdirSync(path).filter(name => name.toLowerCase().endsWith('.avs')).sort().flatMap(name => {
    try {
      const buffer = readFileSync(join(path, name));
      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      return [{ collection, path: join(path, name), name: basename(name), ast: parseAvsPreset(bytes), bytes: bytes.byteLength }];
    } catch (error) {
      parseFailures.push({ collection, name, error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  });
}

function audit(preset: SourcePreset): AuditRow {
  const nodes = flatten(preset.ast.components);
  const exact = planTerminalExactGpuPasses(preset.ast);
  let candidateTerminalParallelRun = 0;
  if (preset.ast.clearEveryFrame) {
    for (let i = preset.ast.components.length - 1; i >= 0; i--) {
      if (!isParallel(preset.ast.components[i]!)) break;
      candidateTerminalParallelRun++;
    }
  }
  return {
    collection: preset.collection, name: preset.name, bytes: preset.bytes, components: nodes.length,
    currentExactTerminalBlurPasses: exact.blurPasses.length,
    candidateTerminalParallelRun,
    parallelCandidateNodes: nodes.filter(isParallel).length,
    orderedWriteNodes: nodes.filter(isOrderedWrite).length,
    eelOrderNodes: nodes.filter(node => !node.list && !node.apeId && EEL_ORDER_BUILTINS.has(node.effectId)).length,
    statefulNodes: nodes.filter(node => !node.list && !node.apeId && STATEFUL_BUILTINS.has(node.effectId)).length,
    unknownVisualNodes: nodes.filter(isUnknownVisual).length,
    effectLists: nodes.filter(node => Boolean(node.list)).length,
    retainedEffectLists: nodes.filter(node => Boolean(node.list) && !(node.list!.inputBlendMode === 1 && node.list!.outputBlendMode === 1)).length,
    listDepthBufferDependencies: nodes.filter(node => Boolean(node.list) && (node.list!.inputBlendMode === 12 || node.list!.outputBlendMode === 12)).length,
    bufferSaveNodes: nodes.filter(node => !node.list && !node.apeId && node.effectId === 18).length,
    rootFeedback: !preset.ast.clearEveryFrame,
  };
}

function summarize(rows: AuditRow[]) {
  const count = (predicate: (row: AuditRow) => boolean) => rows.filter(predicate).length;
  const sum = (pick: (row: AuditRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
  return {
    presets: rows.length,
    components: sum(row => row.components),
    currentExactTerminalEligiblePresets: count(row => row.currentExactTerminalBlurPasses > 0),
    currentExactTerminalBlurPasses: sum(row => row.currentExactTerminalBlurPasses),
    candidateTerminalParallelPresets: count(row => row.candidateTerminalParallelRun > 0),
    candidateTerminalParallelNodes: sum(row => row.candidateTerminalParallelRun),
    presetsWithParallelCandidates: count(row => row.parallelCandidateNodes > 0),
    parallelCandidateNodes: sum(row => row.parallelCandidateNodes),
    presetsWithOrderedWrites: count(row => row.orderedWriteNodes > 0),
    orderedWriteNodes: sum(row => row.orderedWriteNodes),
    presetsWithEelOrderHazards: count(row => row.eelOrderNodes > 0),
    eelOrderNodes: sum(row => row.eelOrderNodes),
    presetsWithStatefulEffects: count(row => row.statefulNodes > 0),
    statefulNodes: sum(row => row.statefulNodes),
    presetsWithUnknownVisuals: count(row => row.unknownVisualNodes > 0),
    unknownVisualNodes: sum(row => row.unknownVisualNodes),
    presetsWithRootFeedback: count(row => row.rootFeedback),
    presetsWithEffectLists: count(row => row.effectLists > 0),
    effectLists: sum(row => row.effectLists),
    presetsWithRetainedEffectLists: count(row => row.retainedEffectLists > 0),
    retainedEffectLists: sum(row => row.retainedEffectLists),
    presetsWithListDepthBuffers: count(row => row.listDepthBufferDependencies > 0),
    listDepthBufferDependencies: sum(row => row.listDepthBufferDependencies),
    presetsWithBufferSave: count(row => row.bufferSaveNodes > 0),
    bufferSaveNodes: sum(row => row.bufferSaveNodes),
  };
}

function effectFrequency(presets: SourcePreset[]) {
  const counts = new Map<string, { nodes: number; presets: number; classification: string }>();
  for (const preset of presets) {
    const seen = new Set<string>();
    for (const node of flatten(preset.ast.components)) {
      if (node.list) continue;
      const label = node.apeId ?? `builtin:${node.effectId} ${BUILTIN_NAMES[node.effectId] ?? 'Unknown'}`;
      const classification = isParallel(node) ? 'parallel-candidate' : isOrderedWrite(node) ? 'ordered-write' : isControl(node) ? 'control/buffer' : 'unclassified';
      const entry = counts.get(label) ?? { nodes: 0, presets: 0, classification };
      entry.nodes++;
      if (!seen.has(label)) { entry.presets++; seen.add(label); }
      counts.set(label, entry);
    }
  }
  return [...counts.entries()].map(([effect, value]) => ({ effect, ...value })).sort((a, b) => b.nodes - a.nodes);
}

function terminalMigration(presets: SourcePreset[]) {
  const candidates = new Map<string, number>();
  const blockers = new Map<string, number>();
  for (const preset of presets) {
    if (!preset.ast.clearEveryFrame) {
      blockers.set('root framebuffer feedback', (blockers.get('root framebuffer feedback') ?? 0) + 1);
      continue;
    }
    let index = preset.ast.components.length - 1;
    for (; index >= 0; index--) {
      const component = preset.ast.components[index]!;
      if (!isParallel(component)) break;
      const label = effectLabel(component);
      candidates.set(label, (candidates.get(label) ?? 0) + 1);
    }
    if (index >= 0) {
      const blocker = preset.ast.components[index]!;
      const label = blocker.list
        ? 'Effect List boundary'
        : isOrderedWrite(blocker)
          ? `${effectLabel(blocker)} [ordered-write]`
          : isControl(blocker)
            ? `${effectLabel(blocker)} [control/buffer]`
            : `${effectLabel(blocker)} [unclassified]`;
      blockers.set(label, (blockers.get(label) ?? 0) + 1);
    }
  }
  const ranked = (values: Map<string, number>) => [...values.entries()]
    .map(([effect, nodes]) => ({ effect, nodes }))
    .sort((a, b) => b.nodes - a.nodes || a.effect.localeCompare(b.effect));
  return { candidateEffects: ranked(candidates), firstBlockers: ranked(blockers) };
}

function benchmarkSample(presets: SourcePreset[], width: number, height: number) {
  const audio = deterministicAudio();
  const rows = presets.map(preset => {
    const runtime = new AvsCompatibilityRuntime(preset.ast, width, height, createAvsCompatibilityRegistry({ randomInt: () => 0 }));
    const started = performance.now();
    runtime.render(audio, true);
    const preinitMs = performance.now() - started;
    const samples: number[] = [];
    for (let frame = 0; frame < 3; frame++) {
      const before = performance.now();
      runtime.render(audio);
      samples.push(performance.now() - before);
    }
    samples.sort((a, b) => a - b);
    return { name: preset.name, preinitMs, medianRenderMs: samples[1]!, minRenderMs: samples[0]!, maxRenderMs: samples[2]! };
  }).sort((a, b) => b.medianRenderMs - a.medianRenderMs);
  const values = rows.map(row => row.medianRenderMs).sort((a, b) => a - b);
  return { summary: { presets: rows.length, p50Ms: percentile(values, .5), p90Ms: percentile(values, .9), p95Ms: percentile(values, .95), worstMs: values.at(-1) ?? 0 }, rows };
}

function deterministicAudio(): AvsAudioFrame {
  const waveform = [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)] as const;
  const spectrum = [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)] as const;
  for (let channel = 0; channel < 2; channel++) for (let index = 0; index < AVS_AUDIO_SAMPLES; index++) {
    waveform[channel][index] = Math.trunc(Math.sin(index * (channel ? .113 : .071)) * 72) & 255;
    spectrum[channel][index] = Math.max(0, 220 - Math.trunc(index * .35) - channel * 17);
  }
  return { waveform, spectrum, beat: false, beatLevel: 576 * 24 };
}

function flatten(nodes: readonly AvsComponent[]): AvsComponent[] {
  const result: AvsComponent[] = [];
  for (const node of nodes) { result.push(node); result.push(...flatten(node.children)); }
  return result;
}
function countComponents(nodes: readonly AvsComponent[]): number { return flatten(nodes).length; }
function isParallel(node: AvsComponent): boolean { return !node.list && (node.apeId ? PARALLEL_APES.has(node.apeId) : PARALLEL_BUILTINS.has(node.effectId)); }
function isOrderedWrite(node: AvsComponent): boolean { return !node.list && (node.apeId ? ORDERED_WRITE_APES.has(node.apeId) : ORDERED_WRITE_BUILTINS.has(node.effectId)); }
function isControl(node: AvsComponent): boolean { return !node.list && !node.apeId && CONTROL_BUILTINS.has(node.effectId); }
function isUnknownVisual(node: AvsComponent): boolean { return !node.list && !isParallel(node) && !isOrderedWrite(node) && !isControl(node); }
function effectLabel(node: AvsComponent): string { return node.apeId ?? `builtin:${node.effectId} ${BUILTIN_NAMES[node.effectId] ?? 'Unknown'}`; }
function hashName(value: string): number { let hash = 2166136261; for (const char of value) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); } return hash >>> 0; }
function percentile(sorted: number[], quantile: number): number { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]! : 0; }
