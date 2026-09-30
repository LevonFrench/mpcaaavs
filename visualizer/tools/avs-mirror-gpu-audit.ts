import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeAvsMirror, parseAvsPreset, planExactAvsMirrorGpu, type AvsComponent } from '../src/avs/index.ts';
const corpora = [
  { id: 'bundled', paths: [resolve('assets/avs-presets/community-picks'), resolve('assets/avs-presets/winamp-5-picks')] },
  { id: 'private', paths: [resolve('avs presets/presets/unique')] },
];
const output: Record<string, unknown> = { definition: 'ID 26 static-mode pixel eligibility plus strict literal final-top-level, single-instance planner eligibility at 640x360.' };
for (const corpus of corpora) {
  let parsed = 0, failed = 0, targetPresets = 0, instances = 0, pixelEligible = 0, terminalEligible = 0, smoothEligible = 0;
  const rejections: Record<string, number> = {}, modes: Record<string, number> = {};
  for (const file of corpus.paths.flatMap(files)) try {
    const preset = parseAvsPreset(new Uint8Array(readFileSync(file))); parsed++; const mirrors: AvsComponent[] = []; visit(preset.components, component => { if (component.effectId === 26) mirrors.push(component); });
    if (mirrors.length) targetPresets++;
    for (const component of mirrors) { instances++; const config = decodeAvsMirror(component.payload); modes[String(config.mode)] = (modes[String(config.mode)] ?? 0) + 1;
      const result = planExactAvsMirrorGpu(config, 640, 360, { terminal: true, mirrorInstances: 1 });
      if (result.eligible) { pixelEligible++; if (config.smooth) smoothEligible++; } else rejections[result.reason!] = (rejections[result.reason!] ?? 0) + 1;
    }
    const tail = preset.components[preset.components.length - 1];
    if (tail?.effectId === 26 && planExactAvsMirrorGpu(decodeAvsMirror(tail.payload), 640, 360, { terminal: true, mirrorInstances: mirrors.length }).eligible) terminalEligible++;
  } catch { failed++; }
  output[corpus.id] = { files: corpus.paths.flatMap(files).length, parsed, failed, targetPresets, instances, pixelEligible,
    pixelEligibilityPercent: instances ? pixelEligible / instances * 100 : 100, smoothEligible, terminalEligible, modes, rejections };
}
console.log(JSON.stringify(output, null, 2));
function visit(components: readonly AvsComponent[], callback: (component: AvsComponent) => void): void { for (const component of components) { callback(component); visit(component.children, callback); } }
function files(directory: string): string[] { const output: string[] = []; for (const entry of readdirSync(directory, { withFileTypes: true })) { const path = resolve(directory, entry.name); if (entry.isDirectory()) output.push(...files(path)); else if (entry.isFile() && entry.name.toLowerCase().endsWith('.avs')) output.push(path); } return output; }
