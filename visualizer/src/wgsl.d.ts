// esbuild loads .wgsl as text (see package.json `--loader:.wgsl=text`).
declare module '*.wgsl' {
  const src: string;
  export default src;
}
