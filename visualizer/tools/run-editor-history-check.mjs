import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'aaavs-editor-history-'));
const output = join(scratch, 'check.mjs');
try {
  await build({
    entryPoints: [resolve('tools/editor-history-check.ts')], outfile: output,
    bundle: true, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
  });
  await import(`${pathToFileURL(output).href}?run=${Date.now()}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
