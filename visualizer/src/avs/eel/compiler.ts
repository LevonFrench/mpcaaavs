import { parseAvsEel } from './parser.ts';
import { compileAvsEelJit } from './jit.ts';
import {
  AvsEelCompileError,
  type AvsEelAst,
  type AvsEelBoundExecutor,
  type AvsEelExecutableVm,
  type AvsEelNode,
  type AvsEelProgram,
  type AvsEelReference,
  type AvsEelVariableBinding,
} from './types.ts';

type Eval = (vm: AvsEelExecutableVm) => number;
type Ref = (vm: AvsEelExecutableVm) => AvsEelReference;
const CLOSE = 0.00001;
/** Longest EEL source (characters) offered to the straight-line JIT. */
const JIT_SOURCE_LIMIT = 4_000;

/** Parse and compile AVS EEL into reusable CPU closures. */
export function compileAvsEel(source: string): AvsEelProgram {
  return compileAvsEelAst(parseAvsEel(source));
}

/** Compile an already parsed AST. */
export function compileAvsEelAst(ast: AvsEelAst): AvsEelProgram {
  const fallback = compileNode(ast.body);
  // Straight-line compilation wins decisively for per-point code that runs
  // thousands of times, including long scripts (Tokyo Bullet's 1.4-1.9k-char
  // point code). Giant generated functions stay on the closure evaluator:
  // browsers tier them poorly. The real size limit is the generated-source cap
  // in jit.ts; this source gate only skips the codegen attempt for sources that
  // would almost always exceed it (corpus generated code runs 5.6-11.4x the
  // source, so past ~4.3k characters nothing in the corpus fits under 24k).
  const bindJit = ast.source.length <= JIT_SOURCE_LIMIT ? compileAvsEelJit(ast.body) : null;
  const bind = (vm: AvsEelExecutableVm): AvsEelBoundExecutor => (
    bindJit ? bindJit(vm) : () => fallback(vm)
  );
  let boundVm: AvsEelExecutableVm | undefined;
  let boundExecute: AvsEelBoundExecutor | undefined;
  const execute = (vm: AvsEelExecutableVm): number => {
    if (vm !== boundVm) {
      boundVm = vm;
      boundExecute = bind(vm);
    }
    return boundExecute!();
  };
  return { source: ast.source, ast, bind, execute };
}

function compileNode(node: AvsEelNode): Eval {
  switch (node.kind) {
    case 'number': return () => node.value;
    case 'variable': {
      if (node.name === '$pi') return () => Math.PI;
      if (node.name === '$e') return () => Math.E;
      if (node.name === '$phi') return () => (1 + Math.sqrt(5)) * 0.5;
      const name = normalizeVariable(node.name);
      const access = variableAccess(name);
      return (vm) => access.get(vm);
    }
    case 'sequence': {
      const values = node.values.map(compileNode);
      return (vm) => {
        let result = 0;
        for (const value of values) result = finite(value(vm));
        return result;
      };
    }
    case 'unary': {
      const value = compileNode(node.value);
      switch (node.operator) {
        case '+': return (vm) => finite(value(vm));
        case '-': return (vm) => finite(-value(vm));
        case '!': return (vm) => truth(value(vm)) ? 0 : 1;
        case '~': return (vm) => ~integer(value(vm));
        default: throw new AvsEelCompileError(`Unknown unary operator ${node.operator}`, node.span);
      }
    }
    case 'binary': return compileBinary(node.operator, compileNode(node.left), compileNode(node.right), node.span);
    case 'conditional': {
      const condition = compileNode(node.condition);
      const yes = compileNode(node.yes);
      const no = compileNode(node.no);
      return (vm) => truth(condition(vm)) ? yes(vm) : no(vm);
    }
    case 'assign': {
      if (node.target.kind === 'variable') {
        const name = normalizeVariable(node.target.name);
        const access = variableAccess(name);
        const value = compileNode(node.value);
        return (vm) => {
          const right = value(vm);
          const left = access.get(vm);
          const result = assignment(node.operator, left, right);
          access.set(vm, result);
          return result;
        };
      }
      if (node.target.kind === 'call' && (node.target.name === 'megabuf' || node.target.name === 'gmegabuf')) {
        arity(node.target.name, node.target.args, 1, node.target.span);
        const global = node.target.name === 'gmegabuf';
        const index = compileNode(node.target.args[0]!);
        const value = compileNode(node.value);
        return (vm) => {
          const address = index(vm);
          const right = value(vm);
          const left = vm.readMemory(global, address);
          const result = assignment(node.operator, left, right);
          vm.writeMemory(global, address, result);
          return result;
        };
      }
      const target = compileReference(node.target);
      const value = compileNode(node.value);
      return (vm) => {
        const reference = target(vm);
        const right = value(vm);
        const left = reference.get();
        const result = assignment(node.operator, left, right);
        reference.set(result);
        return result;
      };
    }
    case 'call': return compileCall(node.name, node.args, node.span);
  }
}

function compileBinary(operator: string, left: Eval, right: Eval, span: AvsEelNode['span']): Eval {
  switch (operator) {
    case '&&': return (vm) => truth(left(vm)) ? (truth(right(vm)) ? 1 : 0) : 0;
    case '||': return (vm) => truth(left(vm)) ? 1 : (truth(right(vm)) ? 1 : 0);
    case '+': return (vm) => finite(left(vm) + right(vm));
    case '-': return (vm) => finite(left(vm) - right(vm));
    case '*': return (vm) => finite(left(vm) * right(vm));
    case '/': return (vm) => divide(left(vm), right(vm));
    case '%': return (vm) => modulo(left(vm), right(vm));
    case '**': return (vm) => finite(Math.pow(left(vm), right(vm)));
    case '|': return (vm) => integer(left(vm)) | integer(right(vm));
    case '&': return (vm) => integer(left(vm)) & integer(right(vm));
    case '^': return (vm) => integer(left(vm)) ^ integer(right(vm));
    case '<<': return (vm) => integer(left(vm)) << (integer(right(vm)) & 31);
    case '>>': return (vm) => integer(left(vm)) >> (integer(right(vm)) & 31);
    case '<': return (vm) => left(vm) < right(vm) ? 1 : 0;
    case '<=': return (vm) => left(vm) <= right(vm) ? 1 : 0;
    case '>': return (vm) => left(vm) > right(vm) ? 1 : 0;
    case '>=': return (vm) => left(vm) >= right(vm) ? 1 : 0;
    case '==': return (vm) => close(left(vm), right(vm)) ? 1 : 0;
    case '!=': return (vm) => close(left(vm), right(vm)) ? 0 : 1;
    case '===': return (vm) => left(vm) === right(vm) ? 1 : 0;
    case '!==': return (vm) => left(vm) !== right(vm) ? 1 : 0;
    default: throw new AvsEelCompileError(`Unknown binary operator ${operator}`, span);
  }
}

function compileCall(name: string, nodes: readonly AvsEelNode[], span: AvsEelNode['span']): Eval {
  // NS-EEL's control functions are special forms: unselected branches/body are
  // not evaluated. This matters because AVS authors put assignments in them.
  if (name === 'if') {
    arity(name, nodes, 3, span);
    const condition = compileNode(nodes[0]!);
    const yes = compileNode(nodes[1]!);
    const no = compileNode(nodes[2]!);
    return (vm) => truth(condition(vm)) ? yes(vm) : no(vm);
  }
  if (name === 'loop') {
    arity(name, nodes, 2, span);
    const count = compileNode(nodes[0]!);
    const body = compileNode(nodes[1]!);
    return (vm) => {
      const iterations = Math.min(Math.max(0, integer(count(vm))), vm.maxLoopIterations);
      let result = 0;
      for (let i = 0; i < iterations; i++) result = body(vm);
      return finite(result);
    };
  }
  if (name === 'assign') {
    arity(name, nodes, 2, span);
    const value = compileNode(nodes[1]!);
    if (nodes[0]!.kind === 'variable') {
      const targetName = normalizeVariable(nodes[0]!.name);
      const access = variableAccess(targetName);
      return (vm) => {
        const result = finite(value(vm));
        access.set(vm, result);
        return result;
      };
    }
    if (nodes[0]!.kind === 'call' && (nodes[0]!.name === 'megabuf' || nodes[0]!.name === 'gmegabuf')) {
      const global = nodes[0]!.name === 'gmegabuf';
      const index = compileNode(nodes[0]!.args[0]!);
      return (vm) => {
        const address = index(vm);
        const result = finite(value(vm));
        vm.writeMemory(global, address, result);
        return result;
      };
    }
    const target = compileReference(nodes[0]!);
    return (vm) => {
      const reference = target(vm);
      const result = finite(value(vm));
      reference.set(result);
      return result;
    };
  }
  if (name === 'megabuf' || name === 'gmegabuf') {
    arity(name, nodes, 1, span);
    const index = compileNode(nodes[0]!);
    return (vm) => vm.readMemory(name === 'gmegabuf', index(vm));
  }

  const args = nodes.map(compileNode);
  const one = (fn: (value: number) => number): Eval => {
    arity(name, nodes, 1, span); return (vm) => finite(fn(args[0]!(vm)));
  };
  const two = (fn: (a: number, b: number) => number): Eval => {
    arity(name, nodes, 2, span); return (vm) => finite(fn(args[0]!(vm), args[1]!(vm)));
  };

  switch (name) {
    case 'sin': return one(Math.sin);
    case 'cos': return one(Math.cos);
    case 'tan': return one(Math.tan);
    case 'asin': return one(Math.asin);
    case 'acos': return one(Math.acos);
    case 'atan': return one(Math.atan);
    case 'atan2': return two(Math.atan2);
    case 'sqrt': return one(Math.sqrt);
    case 'sqr': return one((v) => v * v);
    case 'invsqrt': return one((v) => 1 / Math.sqrt(v));
    case 'pow': return two(Math.pow);
    case 'exp': return one(Math.exp);
    case 'log': return one(Math.log);
    case 'log10': return one(Math.log10);
    case 'abs': return one(Math.abs);
    case 'floor': return one(Math.floor);
    case 'ceil': return one(Math.ceil);
    case 'int': return one(Math.trunc);
    case 'sign': return one((v) => v < 0 ? -1 : v > 0 ? 1 : 0);
    case 'min': return two(Math.min);
    case 'max': return two(Math.max);
    case 'equal': return two((a, b) => close(a, b) ? 1 : 0);
    case 'above': return two((a, b) => a > b ? 1 : 0);
    case 'below': return two((a, b) => a < b ? 1 : 0);
    case 'band': return two((a, b) => truth(a) && truth(b) ? 1 : 0);
    case 'bor': return two((a, b) => truth(a) || truth(b) ? 1 : 0);
    case 'bnot': return one((v) => truth(v) ? 0 : 1);
    case 'rand': {
      arity(name, nodes, 1, span);
      return (vm) => vm.random(args[0]!(vm));
    }
    case 'getosc':
    case 'getspec': {
      arity(name, nodes, 3, span);
      return (vm) => vm.host(name, args[0]!(vm), args[1]!(vm), args[2]!(vm));
    }
    case 'gettime':
    case 'getkbmouse': {
      arity(name, nodes, 1, span);
      return (vm) => vm.host(name, args[0]!(vm));
    }
    default: throw new AvsEelCompileError(`Unknown EEL function ${name}`, span);
  }
}

function compileReference(node: AvsEelNode): Ref {
  if (node.kind === 'variable') {
    if (node.name === '$pi' || node.name === '$e' || node.name === '$phi') {
      throw new AvsEelCompileError(`Cannot assign to constant ${node.name}`, node.span);
    }
    const name = normalizeVariable(node.name);
    let boundVm: AvsEelExecutableVm | undefined;
    let reference: AvsEelReference | undefined;
    return (vm) => {
      if (vm !== boundVm) {
        boundVm = vm;
        reference = vm.variable(name);
      }
      return reference!;
    };
  }
  if (node.kind === 'call' && (node.name === 'megabuf' || node.name === 'gmegabuf')) {
    arity(node.name, node.args, 1, node.span);
    const index = compileNode(node.args[0]!);
    return (vm) => vm.memory(node.name === 'gmegabuf', index(vm));
  }
  if (node.kind === 'conditional') {
    const condition = compileNode(node.condition);
    const yes = compileReference(node.yes);
    const no = compileReference(node.no);
    return (vm) => truth(condition(vm)) ? yes(vm) : no(vm);
  }
  if (node.kind === 'call' && node.name === 'if') {
    arity(node.name, node.args, 3, node.span);
    const condition = compileNode(node.args[0]!);
    const yes = compileReference(node.args[1]!);
    const no = compileReference(node.args[2]!);
    return (vm) => truth(condition(vm)) ? yes(vm) : no(vm);
  }
  throw new AvsEelCompileError('Assignment target must be a variable, memory cell, or conditional reference', node.span);
}

function arity(name: string, args: readonly unknown[], expected: number, span: AvsEelNode['span']): void {
  if (args.length !== expected) throw new AvsEelCompileError(`${name} expects ${expected} arguments, got ${args.length}`, span);
}
function truth(value: number): boolean { return Math.abs(value) >= CLOSE; }
function close(a: number, b: number): boolean { return Math.abs(a - b) < CLOSE; }
function integer(value: number): number { return Number.isFinite(value) ? Math.trunc(value) : 0; }
function finite(value: number): number { return Number.isFinite(value) ? value : 0; }
function divide(a: number, b: number): number { return Math.abs(b) < Number.EPSILON ? 0 : finite(a / b); }
function modulo(a: number, b: number): number { return Math.abs(b) < Number.EPSILON ? 0 : finite(a % b); }
function normalizeVariable(name: string): string { return name.toLowerCase().slice(0, 8); }

function variableAccess(name: string): {
  get(vm: AvsEelExecutableVm): number;
  set(vm: AvsEelExecutableVm, value: number): void;
} {
  let boundVm: AvsEelExecutableVm | undefined;
  let binding: AvsEelVariableBinding | undefined;
  const resolve = (vm: AvsEelExecutableVm): AvsEelVariableBinding => {
    if (vm !== boundVm) {
      boundVm = vm;
      binding = vm.bindVariable(name);
    }
    return binding!;
  };
  return {
    get(vm) {
      const cell = resolve(vm);
      return cell.values[cell.index] ?? 0;
    },
    set(vm, value) {
      const cell = resolve(vm);
      cell.values[cell.index] = finite(value);
    },
  };
}
function assignment(operator: string, left: number, right: number): number {
  let result: number;
  switch (operator) {
    case '=': result = right; break;
    case '+=': result = left + right; break;
    case '-=': result = left - right; break;
    case '*=': result = left * right; break;
    case '/=': result = divide(left, right); break;
    case '%=': result = modulo(left, right); break;
    case '|=': result = integer(left) | integer(right); break;
    case '&=': result = integer(left) & integer(right); break;
    case '^=': result = integer(left) ^ integer(right); break;
    case '**=': result = Math.pow(left, right); break;
    default: result = 0;
  }
  return finite(result);
}
