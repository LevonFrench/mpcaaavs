import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import {
  compileEnhancedSuperScopeGpu,
  decodeAvsSuperScope,
  parseAvsPreset,
  planTerminalEnhancedSuperScope,
  type AvsComponent,
} from '../src/avs/index.ts';

const rootArg = process.argv.find(argument => argument.startsWith('--root='))?.slice(7);
const roots = rootArg
  ? [resolve(rootArg)]
  : [resolve('assets/avs-presets/community-picks'), resolve('assets/avs-presets/winamp-5-picks')];
const files = roots.flatMap(walkAvs).sort();
let parsed = 0;
let scopes = 0;
let eligible = 0;
let scriptBytes = 0;
let eligibleBytes = 0;
const presets = new Set<string>();
const eligiblePresets = new Set<string>();
const reasons = new Map<string, number>();
const examples: Array<{ file: string; eligible: boolean; reason: string; bytes: number }> = [];
const eligibleEntries: Array<{ file: string; bytes: number; uniforms: number; point: string }> = [];
const terminalEligible: string[] = [];

for (const file of files) {
  let ast;
  try { ast = parseAvsPreset(readFileSync(file)); parsed++; }
  catch { continue; }
  if (planTerminalEnhancedSuperScope(ast).component) terminalEligible.push(file);
  visit(ast.components, component => {
    if (component.apeId || component.effectId !== 36) return;
    const point = decodeAvsSuperScope(component.payload).point;
    if (!point.trim()) return;
    scopes++;
    presets.add(file);
    scriptBytes += point.length;
    const result = compileEnhancedSuperScopeGpu(point);
    if (result.eligible) {
      eligible++;
      eligibleBytes += point.length;
      eligiblePresets.add(file);
      eligibleEntries.push({ file, bytes: point.length, uniforms: result.program.uniformNames.length, point });
      if (examples.length < 12) examples.push({ file, eligible: true, reason: '', bytes: point.length });
    } else {
      const reason = normalizeReason(result.reason);
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      if (examples.length < 12) examples.push({ file, eligible: false, reason, bytes: point.length });
    }
  });
}

console.log(JSON.stringify({
  files: files.length, parsed, scopes, eligible,
  eligibleRatio: scopes ? eligible / scopes : 0,
  scriptBytes, eligibleBytes,
  eligibleByteRatio: scriptBytes ? eligibleBytes / scriptBytes : 0,
  presetsWithScopes: presets.size,
  presetsWithEligibleScopes: eligiblePresets.size,
  terminalEligibleCount: terminalEligible.length,
  terminalEligible: terminalEligible.slice(0, 12),
  largestEligible: eligibleEntries.sort((a, b) => b.bytes - a.bytes).slice(0, 12)
    .map(({ file, bytes, uniforms }) => ({ file, bytes, uniforms })),
  rejectionReasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count })),
  examples,
}, null, 2));

function visit(components: readonly AvsComponent[], callback: (component: AvsComponent) => void): void {
  for (const component of components) { callback(component); visit(component.children, callback); }
}
function walkAvs(root: string): string[] {
  const result: string[] = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    const stat = statSync(current);
    if (stat.isDirectory()) {
      for (const name of readdirSync(current)) stack.push(join(current, name));
    } else if (extname(current).toLowerCase() === '.avs') result.push(current);
  }
  return result;
}
function normalizeReason(reason: string): string {
  return reason
    .replace(/^[a-z_$][a-z0-9_$]{0,7}\+= carries point-to-point state$/i, 'compound assignment carries point-to-point state')
    .replace(/^[a-z_$][a-z0-9_$]{0,7} is read before per-point initialization$/i, 'written variable read before per-point initialization');
}
