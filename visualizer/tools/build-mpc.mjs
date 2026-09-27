import { build } from 'esbuild';
// The public source distribution contains no third-party preset/bitmap bank.
// Native playback supplies package-scoped BMPs from the owner's local corpus.
await build({
  entryPoints: ['src/mpc-host.ts', 'src/avs-render.worker.ts'],
  bundle: true, format: 'esm', target: 'es2022', outdir: 'dist',
  entryNames: '[name]', loader: { '.wgsl': 'text' },
  plugins: [{ name: 'local-preset-assets', setup(build) {
    build.onResolve({ filter: /(^|\/)bundled-bitmaps\.ts$/ }, () => ({ path: 'local-bitmap-resolver', namespace: 'mpc-local' }));
    build.onLoad({ filter: /.*/, namespace: 'mpc-local' }, () => ({
      contents: 'export async function loadBundledAvsBitmapResolver() { return () => null; }', loader: 'js',
    }));
  } }],
});
console.log('Built MPC-AAAVS (local preset and bitmap assets; none embedded).');
