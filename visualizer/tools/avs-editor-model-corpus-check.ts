import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createAvsEditorModel, parseAvsPreset, serializeAvsEditorModel, serializeAvsPreset } from '../src/avs/index.ts';

const root = resolve(process.argv.find((argument) => argument.startsWith('--root='))?.slice(7) ?? 'assets/avs-presets');
const files = walk(root).filter((path) => path.toLowerCase().endsWith('.avs'));
let nodes = 0;
let parseErrors = 0;
let sourceRoundTripExceptions = 0;
for (const path of files) {
  const inputBuffer = readFileSync(path);
  const input = new Uint8Array(inputBuffer.buffer, inputBuffer.byteOffset, inputBuffer.byteLength);
  let parsed;
  try { parsed = parseAvsPreset(input); }
  catch { parseErrors++; continue; }
  const model = createAvsEditorModel(parsed);
  nodes += countNodes(model.nodes);
  const output = serializeAvsEditorModel(model);
  const parserOutput = serializeAvsPreset(parsed);
  if (!sameBytes(output, parserOutput)) {
    throw new Error(`Editor model diverged from the lossless preset writer: ${path}`);
  }
  if (!sameBytes(output, input)) sourceRoundTripExceptions++;
}
console.log(`avs-editor-model-corpus-check: PASS (${files.length - parseErrors}/${files.length} parsed presets; ${nodes} nodes; ${sourceRoundTripExceptions} parser round-trip exceptions; ${parseErrors} parse exclusions)`);

function walk(directory: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) output.push(...walk(path));
    else output.push(path);
  }
  return output;
}

function countNodes(nodesToCount: readonly { readonly children: readonly unknown[] }[]): number {
  let count = 0;
  const visit = (nodesToVisit: readonly { readonly children: readonly unknown[] }[]): void => {
    for (const node of nodesToVisit) {
      count++;
      visit(node.children as readonly { readonly children: readonly unknown[] }[]);
    }
  };
  visit(nodesToCount);
  return count;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && !left.some((value, index) => value !== right[index]);
}
