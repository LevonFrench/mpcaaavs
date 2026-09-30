import { build } from 'esbuild';
await build({
  entryPoints:['src/standalone-player.ts','src/mpc-host.ts','src/avs-render.worker.ts','src/nerv-render.worker.ts', 'src/hud-render.worker.ts','src/song-map/song-map.worker.ts','src/worklets/player-pcm.worklet.ts'],
  bundle:true,format:'esm',target:'es2022',outdir:'dist/player',splitting:true,entryNames:'[name]',chunkNames:'shared-[hash]',loader:{'.wgsl':'text'},
  plugins:[{name:'local-preset-assets',setup(build){
    build.onResolve({filter:/(^|\/)bundled-bitmaps\.ts$/},()=>({path:'local-bitmap-resolver',namespace:'mpc-local'}));
    build.onLoad({filter:/.*/,namespace:'mpc-local'},()=>({contents:'export async function loadBundledAvsBitmapResolver(){return()=>null;}',loader:'js'}));
  }}],
});
console.log('Built standalone Player using the shared MPC host, preset workers and bounded audio tap.');
