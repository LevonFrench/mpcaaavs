import { build } from 'esbuild';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Prints the JSON Schema (draft 2020-12) of the `mpcaaavs-hud` v1 manifest, generated from the very tables the validator in src/hud/hud-manifest.ts uses,
// so the schema cannot drift from the parser. CPU only: it bundles one dependency-free module and prints JSON. It reads no preset, kit or collection.
//
//   node tools/print-hud-schema.mjs                 print the schema to standard output
//   node tools/print-hud-schema.mjs --out <file>    write it to <file> (any path you name; nothing else is written)
//   node tools/print-hud-schema.mjs --check <file>  exit 1 unless <file> holds exactly this schema (for a committed copy)
//   node tools/print-hud-schema.mjs --summary       print a one-line summary instead of the schema
// Cross-field lint (unique ids, signal resolution, contrast, cost, attention, authority) is beyond JSON Schema; the parser applies it. Anything the schema
// rejects the parser rejects too (tools/check-hud-manifest.mjs proves this on fixtures and fuzz).
const root = fileURLToPath(new URL('..', import.meta.url));
export async function loadHudSchema() {
  const bundled = await build({ entryPoints: [path.join(root, 'src/hud/hud-manifest.ts')], bundle: true, format: 'esm', write: false });
  const module = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
  return { schema: module.hudJsonSchema(), module };
}

/** Every `$ref` of the document, as [location, target]. */
export function collectRefs(node, where = '#', out = []) {
  if (Array.isArray(node)) node.forEach((x, i) => collectRefs(x, `${where}/${i}`, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') out.push([where, v]);
      else collectRefs(v, `${where}/${k}`, out);
    }
  }
  return out;
}
/** Resolve a local `#/...` pointer inside `doc`; undefined when it does not exist. */
export function resolvePointer(doc, pointer) {
  if (pointer === '#') return doc;
  if (!pointer.startsWith('#/')) return undefined;
  let node = doc;
  for (const part of pointer.slice(2).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}
export function schemaText(schema) { return `${JSON.stringify(schema, null, 2)}\n`; }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const known = new Set(['--out', '--check', '--summary']);
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && !known.has(args[i])) { console.error(`Unknown option ${args[i]}`); process.exit(2); }
    if ((args[i] === '--out' || args[i] === '--check') && (args[i + 1] === undefined || args[i + 1].startsWith('--'))) { console.error(`${args[i]} needs a file path`); process.exit(2); }
  }
  const { schema, module } = await loadHudSchema();
  const text = schemaText(schema);
  const bad = collectRefs(schema).filter(([, target]) => resolvePointer(schema, target) === undefined);
  if (bad.length) { console.error(`Unresolved $ref: ${bad.map(([w, t]) => `${w} -> ${t}`).join('; ')}`); process.exit(1); }
  if (args.includes('--summary')) {
    console.log(`mpcaaavs-hud v${module.HUD_VERSION} schema: ${module.HUD_KINDS.length} instrument kinds, ${Object.keys(schema.$defs).length} definitions, ${text.length} bytes`);
  } else if (option('--check') !== undefined) {
    const file = path.resolve(option('--check'));
    if (!existsSync(file)) { console.error(`Missing ${file}`); process.exit(1); }
    if (readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== text) { console.error(`${file} is not the current mpcaaavs-hud v1 schema`); process.exit(1); }
    console.log(`${file} matches the current mpcaaavs-hud v1 schema`);
  } else if (option('--out') !== undefined) {
    const file = path.resolve(option('--out'));
    writeFileSync(file, text);
    console.log(`Wrote ${file} (${text.length} bytes)`);
  } else process.stdout.write(text);
}
