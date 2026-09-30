// Regenerates the generated regions of docs/PERFORMANCE.md: the stage table (from PERF_STAGES in src/perf-trace.ts) and the baseline tables (from
// docs/perf/baseline.json through tools/bench-report.mjs). `--check` fails when the stage table is stale (npm run check runs it through check-perf-trace.mjs).
//   node tools/perf-docs.mjs [--check]
import { build } from 'esbuild';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const VIS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = join(VIS, '..', 'docs', 'PERFORMANCE.md');
const BASELINE = join(VIS, '..', 'docs', 'perf', 'baseline.json');
const check = process.argv.includes('--check');
const r = await build({ entryPoints: [join(VIS, 'src/perf-trace.ts')], bundle: true, format: 'esm', write: false, logLevel: 'silent' });
const { PERF_STAGES } = await import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);
const rows = PERF_STAGES.map((s) => `| \`${s.name}\` | ${s.where} | ${s.parent ? `\`${s.parent}\`` : ''} | ${s.desc.replace(/\|/g, '/')} |`);
const stageTable = ['| stage | where | inside | what it measures |', '|---|---|---|---|', ...rows].join('\n');
const region = (text, name, body) => {
  const re = new RegExp(`(<!-- ${name}:begin -->)[\\s\\S]*?(<!-- ${name}:end -->)`);
  if (!re.test(text)) throw new Error(`PERFORMANCE.md lacks the ${name} markers`);
  return text.replace(re, `$1\n${body}\n$2`);
};
const current = readFileSync(DOC, 'utf8');
let next = region(current, 'STAGE-TABLE', stageTable);
if (existsSync(BASELINE) && !check) {
  const tables = execFileSync(process.execPath, [join(VIS, 'tools/bench-report.mjs'), BASELINE], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const m = /<!-- BASELINE:begin -->\n([\s\S]*?)\n<!-- BASELINE:end -->/.exec(current);
  const hand = m && m[1].includes('<!-- TABLES -->') ? m[1].split('<!-- TABLES -->')[0] + '<!-- TABLES -->\n' + tables + '\n<!-- /TABLES -->' + m[1].split('<!-- /TABLES -->')[1] : null;
  if (hand) next = region(next, 'BASELINE', hand);
}
if (check) {
  if (next !== current) { console.error('docs/PERFORMANCE.md stage table is stale: run node tools/perf-docs.mjs'); process.exit(1); }
  console.log('docs/PERFORMANCE.md stage table is current');
} else { writeFileSync(DOC, next); console.log('docs/PERFORMANCE.md regenerated'); }
