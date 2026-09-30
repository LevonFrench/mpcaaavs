import { build } from 'esbuild';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Generates src/mpc-hc/AAAVSTransitionNames.h from TRANSITION_META (src/mpc-transition.ts), the single source of transition names.
// CPU only: bundles the pure transition module with esbuild. Usage (from visualizer/):
//   node tools/gen-transition-names.mjs            write ../src/mpc-hc/AAAVSTransitionNames.h (keeps the target's CRLF or LF style)
//   node tools/gen-transition-names.mjs --check    exit 1 when the committed header differs from the regenerated text
//   node tools/gen-transition-names.mjs --out <p>  write to another path (for example a scratch directory)
// check-mpc-transition-fx.mjs imports renderHeader/loadMeta and compares the text (line endings ignored).
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HEADER_PATH = resolve(root, '../src/mpc-hc/AAAVSTransitionNames.h');

export async function loadMeta() {
  const result = await build({ entryPoints: [resolve(root, 'src/mpc-transition.ts')], bundle: true, format: 'esm', write: false, logLevel: 'silent' });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  return { meta: mod.TRANSITION_META, count: mod.TRANSITION_COUNT, cut: mod.TRANSITION_CUT };
}
/** Wide string literal with universal-character-names for anything outside printable ASCII, so the header is encoding-agnostic. */
const literal = text => `L"${[...text].map(ch => { const c = ch.codePointAt(0); if (c > 0xffff) throw Error(`Transition name outside the BMP: ${text}`); return ch === '"' || ch === '\\' ? `\\${ch}` : c >= 0x20 && c < 0x7f ? ch : `\\u${c.toString(16).toUpperCase().padStart(4, '0')}`; }).join('')}"`;
/** 0 classic AVS styles, 1 NERV and HUD styles, 2 special (the selectors and Cut). */
export const groupOf = (m, index, cut) => m.kind === 'fx' ? 1 : m.kind === 'selector' || index === cut ? 2 : 0;
export function renderHeader({ meta, count, cut }) {
  if (meta.length !== count) throw Error(`TRANSITION_META has ${meta.length} entries, expected ${count}`);
  const lines = [
    '// generated from TRANSITION_META; do not edit',
    '// Source: visualizer/src/mpc-transition.ts. Regenerate: node tools/gen-transition-names.mjs (from visualizer/).',
    '// kTransitionGroup: 0 classic AVS styles 1-14, 1 NERV and HUD styles, 2 special (Random, Cut and the two selectors).',
    '#pragma once',
    '',
    `constexpr int kTransitionCount = ${count};`,
    'constexpr const wchar_t* kTransitionNames[kTransitionCount] = {',
    ...meta.map((m, i) => `    ${literal(m.name)},  // ${i}`),
    '};',
    'constexpr unsigned char kTransitionGroup[kTransitionCount] = {',
    `    ${meta.map((m, i) => groupOf(m, i, cut)).join(', ')}`,
    '};',
    '',
  ];
  return lines.join('\n');
}
const normal = text => text.replace(/\r\n/g, '\n');
export async function generate() { return renderHeader(await loadMeta()); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), text = await generate();
  const outIndex = args.indexOf('--out'), target = outIndex >= 0 ? resolve(args[outIndex + 1] ?? '') : HEADER_PATH;
  if (args.includes('--check')) {
    if (!existsSync(target)) { console.error(`Missing ${target}`); process.exit(1); }
    if (normal(readFileSync(target, 'utf8')) !== text) { console.error(`${target} differs from TRANSITION_META; run node tools/gen-transition-names.mjs`); process.exit(1); }
    console.log(`AAAVSTransitionNames.h is current (${target})`);
  } else {
    // The native sources are CRLF; keep whatever line-ending style an existing target already has (a new file gets LF; --check ignores the difference).
    const LF = String.fromCharCode(10), CRLF = String.fromCharCode(13, 10), crlf = existsSync(target) && readFileSync(target, 'utf8').includes(CRLF);
    writeFileSync(target, crlf ? text.split(LF).join(CRLF) : text, 'utf8'); console.log(`Wrote ${target}`);
  }
}
