import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'aaavs-crate-'));
const output = join(scratch, 'check.mjs');
try {
  await build({
    entryPoints: [resolve('tools/crate-check.ts')], outfile: output,
    bundle: true, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
    // The check reads src/ui.ts and src/main.ts relative to its own directory.
    define: { 'import.meta.dirname': JSON.stringify(resolve('tools')) },
  });
  await import(`${pathToFileURL(output).href}?run=${Date.now()}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
