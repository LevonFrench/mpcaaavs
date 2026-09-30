import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AVS_TEXER_APE_ID,
  AVS_TEXER_II_APE_ID,
  decodeAvsSuperScope,
  decodeAvsTexer2Config,
  decodeAvsTexerConfig,
  parseAvsPreset,
  planAvsOrderedTileBinning,
  type AvsComponent,
} from '../src/avs/index.ts';

const WIDTH = 640;
const HEIGHT = 360;
const roots = [
  { id: 'bundled', paths: [resolve('assets/avs-presets/community-picks'), resolve('assets/avs-presets/winamp-5-picks')] },
  { id: 'private', paths: [resolve('avs presets/presets/unique')] },
] as const;

const result: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  frame: { width: WIDTH, height: HEIGHT },
  scheduler: 'stable per-tile source-order membership bitset',
};

for (const root of roots) {
  const files = root.paths.flatMap(path => avsFiles(path));
  const reasons: Record<string, number> = {};
  const kinds: Record<string, { instances: number; eligible: number }> = {};
  const tileSizes: Record<string, number> = {};
  const memoryBytes: number[] = [];
  let parsed = 0, failed = 0, targetPresets = 0, instances = 0, eligible = 0;
  for (const file of files) {
    try {
      const preset = parseAvsPreset(new Uint8Array(readFileSync(file)));
      parsed++;
      let targeted = false;
      visit(preset.components, component => {
        const classified = classify(component);
        if (!classified) return;
        targeted = true; instances++;
        const kind = kinds[classified.kind] ??= { instances: 0, eligible: 0 };
        kind.instances++;
        const plan = planAvsOrderedTileBinning(WIDTH, HEIGHT, classified.capacity);
        if (plan.eligible) {
          eligible++; kind.eligible++;
          tileSizes[String(plan.tileSize)] = (tileSizes[String(plan.tileSize)] ?? 0) + 1;
          memoryBytes.push(plan.membershipBytes);
        } else reasons[plan.reason ?? 'unknown'] = (reasons[plan.reason ?? 'unknown'] ?? 0) + 1;
      });
      if (targeted) targetPresets++;
    } catch { failed++; }
  }
  memoryBytes.sort((a, b) => a - b);
  result[root.id] = {
    files: files.length, parsed, failed, targetPresets, instances, eligible,
    eligibilityPercent: instances === 0 ? 100 : eligible / instances * 100,
    kinds, tileSizes, reasons,
    membershipBytes: {
      p50: percentile(memoryBytes, 0.5),
      p95: percentile(memoryBytes, 0.95),
      max: memoryBytes.at(-1) ?? 0,
    },
  };
}

console.log(JSON.stringify(result, null, 2));

function classify(component: AvsComponent): { kind: string; capacity: number } | null {
  if (component.effectId === 36) {
    const config = decodeAvsSuperScope(component.payload);
    return { kind: config.lines ? 'superscope-lines' : 'superscope-points', capacity: 128 * 1024 };
  }
  if (component.apeId === AVS_TEXER_APE_ID) {
    const particles = decodeAvsTexerConfig(component.payload).particles;
    return { kind: 'texer', capacity: Math.min(WIDTH * HEIGHT, Math.max(1, particles)) };
  }
  if (component.apeId === AVS_TEXER_II_APE_ID) {
    const config = decodeAvsTexer2Config(component.payload);
    return { kind: 'texer-ii', capacity: 65_536 * (config.wrap ? 4 : 1) };
  }
  return null;
}

function visit(components: readonly AvsComponent[], callback: (component: AvsComponent) => void): void {
  for (const component of components) { callback(component); visit(component.children, callback); }
}

function avsFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...avsFiles(path));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.avs')) files.push(path);
  }
  return files;
}

function percentile(values: readonly number[], fraction: number): number {
  return values.length === 0 ? 0 : values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)]!;
}
