// Node adapter for asset packs: the same `AssetPackSource` contract as the browser's fetch source, over a local directory. Used by the
// checks and by tools/validate-asset-pack.mjs. The browser hosts never use this file; they read `show-assets-private/<pack>/` through
// fetch (src/asset-packs/source.ts). It re-validates every path with the shared allowlist and refuses symlinks and anything that
// resolves outside the pack directory.
import { build } from 'esbuild';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
/** The asset-pack module (src/asset-packs/index.ts) bundled for Node. */
export async function loadAssetPackModule() {
  const result = await build({ entryPoints: [path.join(root, 'src/asset-packs/index.ts')], bundle: true, format: 'esm', write: false, platform: 'node' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

/** `directory` is the pack's own directory (its name is the pack id). `A` is the loaded asset-pack module. */
export function fsPackSource(A, directory) {
  const packDir = path.resolve(directory), packId = path.basename(packDir);
  if (!A.isPackId(packId)) throw new Error('Invalid asset pack id');
  return {
    packId,
    async read(file, byteLimit) {
      const problem = A.packPathProblem(file);
      if (problem) throw new Error(`Invalid asset pack path: ${problem}`);
      const full = path.join(packDir, ...file.split('/'));
      let info;
      try { info = await lstat(full); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new A.AssetPackMissingError(); throw error; }
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('Asset pack files must be regular files');
      const real = await realpath(full), realDir = await realpath(packDir);
      if (real !== path.join(realDir, ...file.split('/'))) throw new Error('Asset pack path escaped the pack directory');
      if (info.size > byteLimit) throw new Error('Local asset exceeds byte budget');
      const handle = await open(full, 'r');
      try { const bytes = new Uint8Array(info.size); const { bytesRead } = await handle.read(bytes, 0, info.size, 0); return bytes.subarray(0, bytesRead); } finally { await handle.close(); }
    },
  };
}
