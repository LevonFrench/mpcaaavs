import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { planAvsResidentSurfaces, type AvsResidentEffectCapability } from '../src/avs/gpu-surface-plan.ts';
import { parseAvsPreset, type AvsComponent, type AvsPresetAst } from '../src/avs/index.ts';

const roots = [
  { collection: 'Community Picks', path: resolve('assets/avs-presets/community-picks') },
  { collection: 'Winamp 5 Picks', path: resolve('assets/avs-presets/winamp-5-picks') },
  { collection: 'Private unique collection', path: resolve('avs presets/presets/unique') },
];
const output = resolve(process.argv.find(arg => arg.startsWith('--json='))?.slice(7)
  ?? 'docs/research/avs-gpu-surface-plan-audit-2026-08-13.json');
const width = 640;
const height = 360;
const exact: AvsResidentEffectCapability = { id: 'audit-exact', byteExact: true, readbackFree: true };
const PARALLEL_BUILTINS = new Set([3, 4, 5, 6, 9, 11, 12, 15, 16, 20, 22, 23, 24, 25, 26, 29, 30, 31, 35, 37, 38, 42, 43, 44, 45]);
const PARALLEL_APES = new Set([
  'Color Map', 'Color Reduction', 'Channel Shift', 'Multiplier',
  'Holden03: Convolution Filter', 'Multi Filter', 'Virtual Effect: Addborders',
]);

interface Loaded { collection: string; name: string; ast: AvsPresetAst }
const parseFailures: Array<{ collection: string; name: string; error: string }> = [];
const presets: Loaded[] = roots.flatMap(root => readdirSync(root.path)
  .filter(name => name.toLowerCase().endsWith('.avs')).sort().flatMap(name => {
    try {
      const buffer = readFileSync(join(root.path, name));
      return [{ collection: root.collection, name: basename(name), ast: parseAvsPreset(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)) }];
    } catch (error) {
      parseFailures.push({ collection: root.collection, name, error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }));

const rows = presets.map(preset => {
  const structural = planAvsResidentSurfaces(preset.ast, { effectCapability: () => exact });
  const parallel = planAvsResidentSurfaces(preset.ast, { effectCapability: parallelCapability });
  const blurOnly = planAvsResidentSurfaces(preset.ast, {
    effectCapability: component => !component.apeId && component.effectId === 6 ? exact : null,
  });
  const listOps = structural.operations.filter(op => op.kind === 'list-enter');
  return {
    collection: preset.collection,
    name: preset.name,
    structuralEligible: structural.eligible,
    parallelKernelEligible: parallel.eligible,
    blurOnlyKernelEligible: blurOnly.eligible,
    rootFeedbackResident: structural.rootFeedbackResident,
    surfaces: structural.surfaces.length,
    residentBytesAt640x360: structural.residentBytesPerPixel * width * height,
    effectLists: listOps.length,
    nestedEffectLists: nestedListCount(preset.ast.components),
    retainedEffectLists: listOps.filter(op => !op.direct).length,
    bufferSaveOps: structural.operations.filter(op => op.kind === 'buffer-save').length,
    depthBlendOps: structural.operations.filter(op => (op.kind === 'list-enter' || op.kind === 'list-exit') && op.blend?.depth).length,
    structuralIssues: structural.issues,
    parallelIssues: parallel.issues.length,
  };
});

const bundled = rows.filter(row => row.collection !== 'Private unique collection');
const privateRows = rows.filter(row => row.collection === 'Private unique collection');
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  dimensions: { width, height, packedFramebufferBytes: width * height * 4 },
  note: 'Eligibility is planner/model eligibility, not live GPU execution. Structural mode assumes exact readback-free effect kernels and measures whether list/buffer topology can remain resident.',
  parseFailures,
  bundled: summarize(bundled),
  privateCollection: summarize(privateRows),
  rows,
};
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ output, bundled: result.bundled, privateCollection: result.privateCollection, parseFailures }, null, 2));

function parallelCapability(component: AvsComponent): AvsResidentEffectCapability | null {
  return component.apeId
    ? PARALLEL_APES.has(component.apeId) ? exact : null
    : PARALLEL_BUILTINS.has(component.effectId) ? exact : null;
}

function summarize(rows: typeof rows) {
  const count = (predicate: (row: typeof rows[number]) => boolean) => rows.filter(predicate).length;
  const sum = (pick: (row: typeof rows[number]) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const surfaces = rows.map(row => row.surfaces).sort((a, b) => a - b);
  const bytes = rows.map(row => row.residentBytesAt640x360).sort((a, b) => a - b);
  return {
    presets: rows.length,
    structuralEligible: count(row => row.structuralEligible),
    structurallyEligibleRootFeedback: count(row => row.structuralEligible && row.rootFeedbackResident),
    structurallyEligibleWithNestedLists: count(row => row.structuralEligible && row.nestedEffectLists > 0),
    structurallyEligibleWithRetainedLists: count(row => row.structuralEligible && row.retainedEffectLists > 0),
    structurallyEligibleWithBufferSave: count(row => row.structuralEligible && row.bufferSaveOps > 0),
    structurallyEligibleWithDepthBlend: count(row => row.structuralEligible && row.depthBlendOps > 0),
    parallelKernelEligible: count(row => row.parallelKernelEligible),
    blurOnlyKernelEligible: count(row => row.blurOnlyKernelEligible),
    surfaces: { p50: percentile(surfaces, .5), p95: percentile(surfaces, .95), max: surfaces.at(-1) ?? 0 },
    residentBytesAt640x360: { p50: percentile(bytes, .5), p95: percentile(bytes, .95), max: bytes.at(-1) ?? 0 },
    operations: {
      effectLists: sum(row => row.effectLists),
      nestedEffectLists: sum(row => row.nestedEffectLists),
      retainedEffectLists: sum(row => row.retainedEffectLists),
      bufferSave: sum(row => row.bufferSaveOps),
      depthBlend: sum(row => row.depthBlendOps),
    },
    structuralIssueCodes: issueCounts(rows),
  };
}

function issueCounts(rows: typeof rows) {
  const counts = new Map<string, number>();
  for (const row of rows) for (const issue of row.structuralIssues) {
    counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort());
}

function nestedListCount(components: readonly AvsComponent[], insideList = false): number {
  let count = 0;
  for (const component of components) {
    if (!component.list) continue;
    if (insideList) count++;
    count += nestedListCount(component.children, true);
  }
  return count;
}

function percentile(sorted: number[], quantile: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]! : 0;
}
