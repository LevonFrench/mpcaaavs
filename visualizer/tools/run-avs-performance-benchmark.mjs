import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'aaavs-avs-perf-'));
const output = join(scratch, 'benchmark.mjs');
try {
  await build({
    entryPoints: [resolve('tools/avs-performance-benchmark.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    logLevel: 'silent',
  });
  await import(`${pathToFileURL(output).href}?run=${Date.now()}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
