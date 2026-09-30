import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  createAvsCompatibilityRegistry,
  parseAvsPreset,
  type AvsComponent,
} from '../src/avs/index.ts';

const defaultRoots = [
  'assets/avs-presets/community-picks',
  'assets/avs-presets/winamp-5-picks',
];
const requestedRoots = process.argv.slice(2)
  .filter((argument) => argument.startsWith('--root='))
  .map((argument) => argument.slice('--root='.length));
const roots = requestedRoots.length > 0 ? requestedRoots : defaultRoots;
const registry = createAvsCompatibilityRegistry({ randomInt: () => 0 });
const builtins = [
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
const covered = new Map<string, number>();
const missing = new Map<string, number>();
let lists = 0;
let presets = 0;
let parseErrors = 0;

for (const root of roots) {
  for (const name of readdirSync(root).filter((entry) => entry.toLowerCase().endsWith('.avs'))) {
    presets++;
    const bytes = readFileSync(join(root, name));
    try {
      const ast = parseAvsPreset(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      visit(ast.components);
    } catch {
      parseErrors++;
    }
  }
}

const implemented = sum(covered);
const unsupported = sum(missing);
const total = implemented + unsupported;
console.log(`avs-coverage-report: ${presets} presets; ${parseErrors} parse errors; ${lists} lists; ${implemented}/${total} executable records implemented (${(implemented / total * 100).toFixed(1)}%)`);
console.log('unsupported records:');
for (const [name, count] of [...missing].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
  console.log(`  ${String(count).padStart(4)}  ${name}`);
}

function visit(components: readonly AvsComponent[]): void {
  for (const component of components) {
    if (component.list) { lists++; visit(component.children); continue; }
    const name = component.apeId ?? `builtin:${component.effectId} ${builtins[component.effectId] ?? 'Unknown'}`;
    const destination = registry.handler(component) ? covered : missing;
    destination.set(name, (destination.get(name) ?? 0) + 1);
  }
}
function sum(values: ReadonlyMap<string, number>): number {
  let result = 0;
  for (const value of values.values()) result += value;
  return result;
}
