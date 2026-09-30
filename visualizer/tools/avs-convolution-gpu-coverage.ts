import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { parseAvsPreset, planTerminalExactGpuConvolutions } from '../src/avs/index.ts';
import { planTerminalExactGpuPasses } from '../src/avs/gpu-preset-plan.ts';
const root = resolve(process.argv.find(value => value.startsWith('--root='))?.slice(7) ?? 'avs presets/presets/unique');
const files = walk(root).sort(); let parsed = 0, eligible = 0, fusedPointwise = 0; const examples: string[] = [], fusedExamples: string[] = [];
for (const file of files) { try { const ast = parseAvsPreset(readFileSync(file)), suffix = planTerminalExactGpuPasses(ast), plan = planTerminalExactGpuConvolutions(suffix.cpuPreset); parsed++; if (plan.configs.length) { eligible++; if (examples.length < 12) examples.push(file); if (suffix.passes[0]?.kind === 'pointwise') { fusedPointwise++; if (fusedExamples.length < 12) fusedExamples.push(file); } } } catch {} }
console.log(JSON.stringify({ files: files.length, parsed, terminalEligible: eligible, fusedPointwise, examples, fusedExamples }, null, 2));
function walk(path: string): string[] { if (!statSync(path).isDirectory()) return extname(path).toLowerCase() === '.avs' ? [path] : []; return readdirSync(path).flatMap(name => walk(join(path, name))); }
