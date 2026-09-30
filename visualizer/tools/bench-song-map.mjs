// Runs tools/song-map-bench.ts once per track length in its own process (peak memory is per run).
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'aaavs-song-map-bench-'));
const output = join(scratch, 'bench.mjs');
try {
  await build({ entryPoints: [resolve('tools/song-map-bench.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent' });
  for (const minutes of (process.argv.length > 2 ? process.argv.slice(2) : ['5', '60'])) {
    const run = spawnSync(process.execPath, [output, minutes], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 1 << 24 });
    if (run.status !== 0) { console.error(`bench ${minutes} min failed with status ${run.status}`); process.exitCode = 1; break; }
    console.log(run.stdout.trim());
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
