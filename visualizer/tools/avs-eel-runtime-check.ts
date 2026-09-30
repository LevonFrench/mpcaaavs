import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AvsEelGlobalState,
  AvsEelVm,
  compileAvsEel,
} from '../src/avs/index.ts';

let checks = 0;

export function runAvsEelRuntimeFixture(): void {
  const global = new AvsEelGlobalState();
  const calls: string[] = [];
  const vm = new AvsEelVm({
    global,
    seed: 0x12345678,
    host: {
      getosc: (band, width, channel) => { calls.push(`osc:${band}:${width}:${channel}`); return band + width + channel; },
      getspec: (band, width, channel) => { calls.push(`spec:${band}:${width}:${channel}`); return band - width + channel; },
      gettime: (value) => { calls.push(`time:${value}`); return 12.5 - value; },
      getkbmouse: (selector) => { calls.push(`key:${selector}`); return selector === 32 ? 1 : 0; },
    },
  });

  const persistent = compileAvsEel('x=x+1; y=2+3*4; z=(2+3)*4;');
  vm.execute(persistent); vm.execute(persistent);
  equal(vm.get('x'), 2, 'component locals persist between executions');
  equal(vm.get('y'), 14, 'operator precedence');
  equal(vm.get('z'), 20, 'parentheses override precedence');

  const boundPersistent = persistent.bind(vm);
  boundPersistent(); boundPersistent();
  equal(vm.get('x'), 4, 'bound executor preserves component-local state');
  const otherVm = new AvsEelVm({ global });
  const otherBound = persistent.bind(otherVm);
  otherBound();
  equal(otherVm.get('x'), 1, 'one program independently binds multiple VMs');
  equal(vm.get('x'), 4, 'independent bound VM does not replace original binding');
  const boundStateful = compileAvsEel(
    'reg02+=1;assign(gmegabuf(9),reg02);sample=getosc(.25,.1,2);assign(megabuf(4),sample);x=1;x+=(x=2)',
  ).bind(vm);
  boundStateful(); boundStateful();
  equal(global.registers[2], 2, 'bound executor preserves shared register mutation');
  equal(global.memory.read(9), 2, 'bound executor preserves shared megabuf mutation');
  equal(vm.localMemory.read(4), 2.35, 'bound executor preserves local megabuf mutation');
  equal(vm.get('x'), 4, 'bound assignment preserves right-before-left f64 ordering');

  vm.execute(compileAvsEel('reg00=9; assign(gmegabuf(7),reg00); assign(megabuf(3),4);'));
  const sibling = new AvsEelVm({ global, seed: 1 });
  equal(sibling.get('reg00'), 9, 'reg00..reg99 are shared');
  equal(sibling.execute(compileAvsEel('gmegabuf(7)')), 9, 'gmegabuf is shared');
  equal(sibling.execute(compileAvsEel('megabuf(3)')), 0, 'megabuf is component-local');
  equal(vm.execute(compileAvsEel('megabuf(3)')), 4, 'local megabuf persists');
  vm.execute(compileAvsEel('VeryLongName=11; VERYLONGtail=12;'));
  equal(vm.get('verylong'), 12, 'locals are case-insensitive and significant for eight characters');
  vm.execute(compileAvsEel('assign(megabuf(1048575),8); assign(megabuf(1048576),9);'));
  equal(vm.execute(compileAvsEel('megabuf(1048575)')), 8, 'megabuf exposes 64 16K blocks');
  equal(vm.execute(compileAvsEel('megabuf(1048576)')), 0, 'megabuf rejects indexes after 64 16K blocks');

  vm.execute(compileAvsEel('pick=0; assign(if(above(reg00,1),pick,other),17);'));
  equal(vm.get('pick'), 17, 'conditional lvalue assignment');
  equal(vm.get('other'), 0, 'unselected lvalue is lazy');

  vm.execute(compileAvsEel('side=0; a=if(1,3,assign(side,10)); b=if(0,assign(side,20),4);'));
  equal(vm.get('side'), 0, 'if evaluates only selected branch');
  equal(vm.get('a'), 3, 'if true value');
  equal(vm.get('b'), 4, 'if false value');
  vm.execute(compileAvsEel('x=1; order=x+(x=2);'));
  equal(vm.get('order'), 3, 'binary operands evaluate left to right');

  vm.execute(compileAvsEel('n=0; loop(5,n+=2); loop(0,n=999);'));
  equal(vm.get('n'), 10, 'loop evaluates body exact count and zero is lazy');
  vm.execute(compileAvsEel('n=0; loop(999999,n+=1);'));
  equal(vm.get('n'), 4096, 'loop is capped at the EEL compatibility limit');
  equal(vm.execute(compileAvsEel('band(1,below(1,2))+bor(0,1)+bnot(0)')), 3, 'boolean builtins');
  equal(vm.execute(compileAvsEel('equal(1,1.000001)+above(2,1)+below(1,2)')), 3, 'comparison builtins');
  equal(vm.execute(compileAvsEel('5%2 + (5&3) + (4|1) + (7^2)')), 12, 'modulo and bitwise operators');
  near(vm.execute(compileAvsEel('sqr(3)+sqrt(9)+pow(2,3)+invsqrt(4)')), 20.5, 'math functions');

  equal(vm.execute(compileAvsEel('getosc(.25,.1,2)')), 2.35, 'getosc host injection');
  equal(vm.execute(compileAvsEel('getspec(.25,.1,2)')), 2.15, 'getspec host injection');
  equal(vm.execute(compileAvsEel('gettime(2)')), 10.5, 'gettime host injection');
  equal(vm.execute(compileAvsEel('getkbmouse(32)')), 1, 'getkbmouse host injection');
  equal(calls.length, 6, 'bound and generic hosts are called once per expression');

  const randomA = new AvsEelVm({ seed: 42 });
  const randomB = new AvsEelVm({ seed: 42 });
  const randomProgram = compileAvsEel('rand(1000)+rand(1000)*1000');
  equal(randomA.execute(randomProgram), randomB.execute(randomProgram), 'rand is deterministic from seed');

  // The straight-line executor is an optional optimization. Browsers with a
  // strict `script-src` policy can reject dynamic compilation, so every
  // program must retain exactly the same closure-VM execution path.
  const nativeFunction = globalThis.Function;
  try {
    globalThis.Function = (() => { throw new EvalError('unsafe-eval blocked by CSP'); }) as FunctionConstructor;
    const cspVm = new AvsEelVm();
    const cspProgram = compileAvsEel('x=3; y=x*4+2;');
    cspVm.execute(cspProgram);
    equal(cspVm.get('y'), 14, 'strict CSP falls back to the closure evaluator');
    cspProgram.bind(cspVm)();
    equal(cspVm.get('y'), 14, 'strict CSP bound executor uses the closure evaluator');
  } finally {
    globalThis.Function = nativeFunction;
  }

  // Compile every decoded code block in the research corpus. This is a parser
  // and builtin coverage fixture, not a golden render: it catches a language
  // feature entering a preset before an effect implementation depends on it.
  const community = compileCorpus(
    'Community Picks',
    'docs/research/community-picks/inventory.json',
    2_983,
    new Map([
      [733, 'source typo: missing operator before dcos(...)'],
      [1154, 'malformed source: unmatched closing parenthesis'],
      [1916, 'malformed source: lone percent operator'],
      [2350, 'truncated source: missing assignment target'],
      [2450, 'truncated source: missing assignment target'],
      [2451, 'truncated source: missing first assignment target'],
    ]),
  );
  const winamp = compileCorpus(
    'Winamp 5 Picks',
    'docs/research/winamp5-picks-inventory.json',
    1_502,
    new Map(),
  );
  equal(community.compiled, 2_977, 'all valid textual Community Picks EEL blocks compile');
  equal(winamp.compiled, 1_502, 'all textual Winamp 5 Picks EEL blocks compile');

  console.log(
    `avs-eel-runtime-check: PASS (${checks} assertions; ` +
    `${community.compiled}/${community.total} Community and ${winamp.compiled}/${winamp.total} Winamp corpus programs; ` +
    `${community.knownMalformed} categorized malformed Community sources)`,
  );
}

function compileCorpus(
  label: string,
  path: string,
  expectedTotal: number,
  knownMalformed: ReadonlyMap<number, string>,
): { compiled: number; total: number; knownMalformed: number } {
  const inventory = JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown;
  const sourceBlocks: string[] = [];
  collectCode(inventory, sourceBlocks);
  equal(sourceBlocks.length, expectedTotal, `${label} textual source inventory is stable`);
  const unexpected: string[] = [];
  const observedMalformed = new Set<number>();
  let compiled = 0;
  for (const [index, source] of sourceBlocks.entries()) {
    try { compileAvsEel(source); compiled++; }
    catch (error) {
      const category = knownMalformed.get(index);
      if (category) { observedMalformed.add(index); continue; }
      unexpected.push(`block ${index}: ${error instanceof Error ? error.message : String(error)} :: ${JSON.stringify(source.slice(0, 160))}`);
    }
  }
  for (const [index, category] of knownMalformed) {
    if (!observedMalformed.has(index)) unexpected.push(`expected malformed block ${index} was not observed (${category})`);
  }
  if (unexpected.length > 0) throw new Error(`${label} unexpected EEL compile results (${unexpected.length}):\n${unexpected.join('\n')}`);
  return { compiled, total: sourceBlocks.length, knownMalformed: observedMalformed.size };
}

function collectCode(value: unknown, out: string[], key = ''): void {
  if (typeof value === 'string') {
    if (
      (key === 'code' || key === 'init' || key === 'perFrame' || key === 'onBeat' || key === 'perPoint' || key.endsWith('_code')) &&
      value.trim() &&
      /[\x20-\x7e]/.test(value)
    ) out.push(value);
    return;
  }
  if (Array.isArray(value)) { for (const item of value) collectCode(item, out); return; }
  if (!value || typeof value !== 'object') return;
  for (const [childKey, child] of Object.entries(value)) collectCode(child, out, childKey);
}

function equal(actual: unknown, expected: unknown, label: string): void {
  checks++;
  if (actual !== expected) throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`);
}
function near(actual: number, expected: number, label: string): void {
  checks++;
  if (Math.abs(actual - expected) > 1e-9) throw new Error(`${label}: got ${actual}, expected ${expected}`);
}
