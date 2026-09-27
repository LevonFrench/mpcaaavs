/** Source span retained on every EEL node for actionable compile errors. */
export interface AvsEelSpan {
  readonly start: number;
  readonly end: number;
}

export type AvsEelAssignmentOperator = '=' | '+=' | '-=' | '*=' | '/=' | '%=' | '|=' | '&=' | '^=' | '**=';

export type AvsEelNode =
  | { readonly kind: 'number'; readonly value: number; readonly span: AvsEelSpan }
  | { readonly kind: 'variable'; readonly name: string; readonly span: AvsEelSpan }
  | { readonly kind: 'unary'; readonly operator: string; readonly value: AvsEelNode; readonly span: AvsEelSpan }
  | { readonly kind: 'binary'; readonly operator: string; readonly left: AvsEelNode; readonly right: AvsEelNode; readonly span: AvsEelSpan }
  | { readonly kind: 'conditional'; readonly condition: AvsEelNode; readonly yes: AvsEelNode; readonly no: AvsEelNode; readonly span: AvsEelSpan }
  | { readonly kind: 'assign'; readonly operator: AvsEelAssignmentOperator; readonly target: AvsEelNode; readonly value: AvsEelNode; readonly span: AvsEelSpan }
  | { readonly kind: 'call'; readonly name: string; readonly args: readonly AvsEelNode[]; readonly span: AvsEelSpan }
  | { readonly kind: 'sequence'; readonly values: readonly AvsEelNode[]; readonly span: AvsEelSpan };

export interface AvsEelAst {
  readonly kind: 'program';
  readonly source: string;
  readonly body: AvsEelNode;
}

/** AVS-specific host callbacks registered around NS-EEL by vis_avs. */
export interface AvsEelHostFunctions {
  readonly getosc?: (band: number, width: number, channel: number) => number;
  readonly getspec?: (band: number, width: number, channel: number) => number;
  readonly gettime?: (value: number) => number;
  readonly getkbmouse?: (selector: number) => number;
}

export interface AvsEelVmOptions {
  readonly global?: AvsEelGlobalStateLike;
  readonly host?: AvsEelHostFunctions;
  /** Reproducible unsigned 32-bit random seed. Zero is accepted. */
  readonly seed?: number;
  /** Runaway guard for `loop`; defaults to 1,048,576 iterations. */
  readonly maxLoopIterations?: number;
}

/** Structural interface avoids a runtime cycle between compiler and VM. */
export interface AvsEelGlobalStateLike {
  readonly registers: Float64Array;
  readonly memory: AvsEelMemoryLike;
}

export interface AvsEelMemoryLike {
  read(index: number): number;
  write(index: number, value: number): void;
  clear(): void;
}

export interface AvsEelReference {
  get(): number;
  set(value: number): void;
}

/** A variable cell resolved once so hot EEL programs avoid repeated name lookups. */
export interface AvsEelVariableBinding {
  readonly values: Float64Array | number[];
  readonly index: number;
}

export interface AvsEelExecutableVm {
  readonly maxLoopIterations: number;
  bindVariable(name: string): AvsEelVariableBinding;
  getVariable(name: string): number;
  setVariable(name: string, value: number): void;
  variable(name: string): AvsEelReference;
  memory(global: boolean, index: number): AvsEelReference;
  readMemory(global: boolean, index: number): number;
  writeMemory(global: boolean, index: number, value: number): void;
  host(name: keyof AvsEelHostFunctions, first: number, second?: number, third?: number): number;
  random(limit: number): number;
}

export interface AvsEelProgram {
  readonly source: string;
  readonly ast: AvsEelAst;
  /** Permanently bind this program to one stateful VM for hot repeated execution. */
  bind(vm: AvsEelExecutableVm): AvsEelBoundExecutor;
  execute(vm: AvsEelExecutableVm): number;
}

export type AvsEelBoundExecutor = () => number;

export class AvsEelSyntaxError extends SyntaxError {
  constructor(message: string, readonly offset: number, source: string) {
    const before = source.slice(0, offset);
    const line = before.split('\n').length;
    const lastNewline = before.lastIndexOf('\n');
    const column = offset - lastNewline;
    super(`${message} at ${line}:${column}`);
    this.name = 'AvsEelSyntaxError';
  }
}

export class AvsEelCompileError extends Error {
  constructor(message: string, readonly span: AvsEelSpan) {
    super(`${message} (characters ${span.start}-${span.end})`);
    this.name = 'AvsEelCompileError';
  }
}
