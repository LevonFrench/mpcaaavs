import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { assessExactGpuBump, decodeAvsBump, parseAvsPreset, type AvsComponent } from '../src/avs/index.ts';

const corpora = [
  { id: 'bundled', paths: [resolve('assets/avs-presets/community-picks'), resolve('assets/avs-presets/winamp-5-picks')] },
  { id: 'private', paths: [resolve('avs presets/presets/unique')] },
];
const output: Record<string, unknown> = {
  definition: 'Fail-closed isolated pass: enabled ID 29, current framebuffer depth (buffer=0), and literal final top-level component. Nested/list/global-buffer scheduling remains an integration dependency.',
};
for (const corpus of corpora) {
  let parsed = 0, failed = 0, targetPresets = 0, instances = 0, pixelEligible = 0, terminalEligible = 0;
  const rejections: Record<string, number> = {}, buffers: Record<string, number> = {}, blendModes: Record<string, number> = {};
  for (const file of corpus.paths.flatMap(files)) {
    try {
      const preset = parseAvsPreset(new Uint8Array(readFileSync(file))); parsed++;
      let targeted = false;
      visit(preset.components, component => {
        if (component.effectId !== 29) return;
        targeted = true; instances++; const config = decodeAvsBump(component.payload);
        buffers[String(config.buffer)] = (buffers[String(config.buffer)] ?? 0) + 1;
        const blend = config.additive ? 'additive' : config.average ? 'average' : 'replace';
        blendModes[blend] = (blendModes[blend] ?? 0) + 1;
        const eligibility = assessExactGpuBump(config, { terminal: true });
        if (eligibility.eligible) pixelEligible++; else rejections[eligibility.reason] = (rejections[eligibility.reason] ?? 0) + 1;
      });
      if (targeted) targetPresets++;
      const tail = preset.components[preset.components.length - 1];
      if (tail?.effectId === 29 && assessExactGpuBump(decodeAvsBump(tail.payload), { terminal: true }).eligible) terminalEligible++;
    } catch { failed++; }
  }
  output[corpus.id] = { files: corpus.paths.flatMap(files).length, parsed, failed, targetPresets, instances, pixelEligible,
    pixelEligibilityPercent: instances ? pixelEligible / instances * 100 : 100, terminalEligible, buffers, blendModes, rejections };
}
console.log(JSON.stringify(output, null, 2));

function visit(components: readonly AvsComponent[], callback: (component: AvsComponent) => void): void {
  for (const component of components) { callback(component); visit(component.children, callback); }
}
function files(directory: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...files(path));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.avs')) output.push(path);
  }
  return output;
}
