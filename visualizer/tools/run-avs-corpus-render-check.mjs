import { build } from 'esbuild';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'aaavs-avs-corpus-'));
const output = join(scratch, 'check.mjs');
const options = { bundle: true, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent' };
try {
  await build({ ...options, entryPoints: [resolve('tools/avs-corpus-render-check.ts')], outfile: output });
  // --reference=DIR bundles a pristine tree's src/avs so the check can locate
  // the first differing pixel of a mismatch instead of only the frame.
  const reference = process.argv.find(arg => arg.startsWith('--reference='))?.slice('--reference='.length);
  if (reference) {
    const entry = resolve(reference, 'src/avs/index.ts');
    if (!existsSync(entry)) throw new Error(`--reference: ${entry} does not exist`);
    const referenceOutput = join(scratch, 'reference.mjs');
    await build({ ...options, entryPoints: [entry], outfile: referenceOutput });
    process.env.AAAVS_CORPUS_REFERENCE_BUNDLE = pathToFileURL(referenceOutput).href;
  }
  const forwarded = process.argv.slice(2);
  process.argv.splice(2, process.argv.length - 2, ...forwarded);
  await import(`${pathToFileURL(output).href}?run=${Date.now()}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
