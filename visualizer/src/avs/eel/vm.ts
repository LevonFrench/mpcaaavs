import type {
  AvsEelExecutableVm,
  AvsEelGlobalStateLike,
  AvsEelHostFunctions,
  AvsEelMemoryLike,
  AvsEelProgram,
  AvsEelReference,
  AvsEelVariableBinding,
  AvsEelVmOptions,
} from './types.ts';

const REGISTER_COUNT = 100;
const MEMORY_BLOCK_SIZE = 16_384;
const MEMORY_BLOCK_COUNT = 64;
const MEMORY_CELL_COUNT = MEMORY_BLOCK_SIZE * MEMORY_BLOCK_COUNT;
const DEFAULT_MAX_LOOPS = 4_096;
const MEMORY_CLOSE_FACTOR = 0.00001;

/** Sparse AVS EEL1 memory. Reads do not allocate; writes allocate 16K pages. */
export class AvsEelMemory implements AvsEelMemoryLike {
  private readonly blocks = new Map<number, Float64Array>();

  read(value: number): number {
    const index = memoryIndex(value);
    if (index < 0) return 0;
    const block = this.blocks.get(Math.floor(index / MEMORY_BLOCK_SIZE));
    return block?.[index % MEMORY_BLOCK_SIZE] ?? 0;
  }

  write(value: number, next: number): void {
    const index = memoryIndex(value);
    if (index < 0) return;
    const blockIndex = Math.floor(index / MEMORY_BLOCK_SIZE);
    let block = this.blocks.get(blockIndex);
    if (!block) {
      if (next === 0) return;
      block = new Float64Array(MEMORY_BLOCK_SIZE);
      this.blocks.set(blockIndex, block);
    }
    block[index % MEMORY_BLOCK_SIZE] = Number.isFinite(next) ? next : 0;
  }

  clear(): void { this.blocks.clear(); }
}

/** State shared by all AVS EEL VM instances in one compatibility graph. */
export class AvsEelGlobalState implements AvsEelGlobalStateLike {
  readonly registers = new Float64Array(REGISTER_COUNT);
  readonly memory = new AvsEelMemory();
  reset(): void { this.registers.fill(0); this.memory.clear(); }
}

/** Persistent component-local EEL context. Compile once, execute every phase/frame. */
export class AvsEelVm implements AvsEelExecutableVm {
  readonly global: AvsEelGlobalStateLike;
  readonly localMemory = new AvsEelMemory();
  readonly maxLoopIterations: number;
  private hostFunctions: AvsEelHostFunctions;
  private randomState: number;
  private readonly references = new Map<string, AvsEelReference>();
  private readonly bindings = new Map<string, AvsEelVariableBinding>();
  private readonly variableIndexes = new Map<string, number>();
  private readonly variableValues: number[] = [];

  constructor(options: AvsEelVmOptions = {}) {
    this.global = options.global ?? new AvsEelGlobalState();
    this.hostFunctions = options.host ?? {};
    this.randomState = options.seed === undefined ? 0x6d2b79f5 : options.seed >>> 0;
    this.maxLoopIterations = Math.max(0, Math.trunc(options.maxLoopIterations ?? DEFAULT_MAX_LOOPS));
  }

  execute(program: AvsEelProgram): number { return program.execute(this); }

  setHost(host: AvsEelHostFunctions): void { this.hostFunctions = host; }
  reseed(seed: number): void { this.randomState = seed >>> 0; }

  get(name: string): number { return this.variable(name).get(); }
  set(name: string, value: number): void { this.variable(name).set(value); }

  /** Resolve an EEL identifier to stable numeric storage once per VM. */
  bindVariable(rawName: string): AvsEelVariableBinding {
    const name = rawName.toLowerCase().slice(0, 8);
    const cached = this.bindings.get(name);
    if (cached) return cached;
    const register = registerIndex(name);
    let binding: AvsEelVariableBinding;
    if (register >= 0) {
      binding = { values: this.global.registers, index: register };
    } else {
      let index = this.variableIndexes.get(name);
      if (index === undefined) {
        index = this.variableValues.length;
        this.variableIndexes.set(name, index);
        this.variableValues.push(0);
      }
      binding = { values: this.variableValues, index };
    }
    this.bindings.set(name, binding);
    return binding;
  }

  /** Fast path for compiler-normalized static identifiers. */
  getVariable(name: string): number {
    const binding = this.bindVariable(name);
    return binding.values[binding.index] ?? 0;
  }

  /** Fast path for compiler-normalized static identifiers. */
  setVariable(name: string, value: number): void {
    const binding = this.bindVariable(name);
    binding.values[binding.index] = clean(value);
  }

  variable(rawName: string): AvsEelReference {
    // AVS used EEL1 compatibility mode: identifiers are case-insensitive and
    // only their first eight characters participate in lookup.
    const name = rawName.toLowerCase().slice(0, 8);
    const cached = this.references.get(name);
    if (cached) return cached;
    const binding = this.bindVariable(name);
    const reference: AvsEelReference = {
      get: () => binding.values[binding.index] ?? 0,
      set: (value) => { binding.values[binding.index] = clean(value); },
    };
    this.references.set(name, reference);
    return reference;
  }

  memory(global: boolean, rawIndex: number): AvsEelReference {
    const memory = global ? this.global.memory : this.localMemory;
    // Capture the interpreted index once. `assign(gmegabuf(i=i+1), x)` must
    // not evaluate its side effect again while setting the selected cell.
    const index = memoryIndex(rawIndex);
    return { get: () => memory.read(index), set: (value) => memory.write(index, clean(value)) };
  }

  readMemory(global: boolean, index: number): number {
    return (global ? this.global.memory : this.localMemory).read(index);
  }

  writeMemory(global: boolean, index: number, value: number): void {
    (global ? this.global.memory : this.localMemory).write(index, clean(value));
  }

  host(name: keyof AvsEelHostFunctions, first: number, second = 0, third = 0): number {
    const fn = this.hostFunctions[name];
    if (!fn) return 0;
    if (name === 'getosc' || name === 'getspec') {
      return clean((fn as (a: number, b: number, c: number) => number)(first, second, third));
    }
    return clean((fn as (value: number) => number)(first));
  }

  random(limit: number): number {
    // xorshift32: small, stable across JS engines, and zero-seed safe by the
    // Weyl addition. Determinism is the compatibility contract here; native
    // libc rand() varied between AVS hosts and cannot be reproduced portably.
    let state = (this.randomState + 0x9e3779b9) >>> 0;
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    this.randomState = state >>> 0;
    const bound = Math.max(0, Math.trunc(limit));
    return bound > 1 ? this.randomState % bound : 0;
  }

  resetLocal(): void { this.variableValues.fill(0); this.localMemory.clear(); }
}

function memoryIndex(value: number): number {
  if (!Number.isFinite(value) || value < 0) return -1;
  const index = Math.trunc(value + MEMORY_CLOSE_FACTOR);
  return index < 0 || index >= MEMORY_CELL_COUNT ? -1 : index;
}
function clean(value: number): number { return Number.isFinite(value) ? value : 0; }
function registerIndex(name: string): number {
  if (name.length !== 5 || name.charCodeAt(0) !== 114 || name.charCodeAt(1) !== 101 || name.charCodeAt(2) !== 103) return -1;
  const tens = name.charCodeAt(3) - 48;
  const ones = name.charCodeAt(4) - 48;
  return tens >= 0 && tens <= 9 && ones >= 0 && ones <= 9 ? tens * 10 + ones : -1;
}
