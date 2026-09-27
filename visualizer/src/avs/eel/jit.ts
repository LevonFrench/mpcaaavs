import type {
  AvsEelExecutableVm,
  AvsEelBoundExecutor,
  AvsEelNode,
  AvsEelVariableBinding,
} from './types.ts';

type Factory = (
  vm: AvsEelExecutableVm,
  bindings: readonly AvsEelVariableBinding[],
  helpers: typeof HELPERS,
) => AvsEelBoundExecutor;

const CLOSE = 0.00001;
const HELPERS = {
  truth(value: number): boolean { return Math.abs(value) >= CLOSE; },
  close(a: number, b: number): boolean { return Math.abs(a - b) < CLOSE; },
  integer(value: number): number { return Number.isFinite(value) ? Math.trunc(value) : 0; },
  finite(value: number): number { return Number.isFinite(value) ? value : 0; },
  divide(a: number, b: number): number {
    return Math.abs(b) < Number.EPSILON ? 0 : (Number.isFinite(a / b) ? a / b : 0);
  },
  modulo(a: number, b: number): number {
    return Math.abs(b) < Number.EPSILON ? 0 : (Number.isFinite(a % b) ? a % b : 0);
  },
};

/**
 * Compile a parsed EEL tree to straight-line JavaScript. The generated source
 * contains only numeric storage indexes and compiler-owned operations; preset
 * source text and identifier text are never interpolated. Environments that
 * disallow dynamic compilation simply use the closure evaluator instead.
 */
export function compileAvsEelJit(node: AvsEelNode): ((vm: AvsEelExecutableVm) => AvsEelBoundExecutor) | null {
  const builder = new Builder();
  let result: string;
  try { result = builder.expression(node); }
  catch (error) {
    if (error instanceof UnsupportedJitNode) return null;
    throw error;
  }
  const declarations = [...builder.variables.values()]
    .map(index => `const a${index}=b[${index}].values,j${index}=b[${index}].index;`)
    .join('');
  const source = `${declarations}return function(){${builder.lines.join('')}return ${result};}`;
  // Very large generated functions do not become hot enough per component for
  // browser JITs to optimize and can be slower than the small closure nodes.
  if (source.length > 24_000) return null;
  let factory: Factory;
  try {
    factory = new Function('vm', 'b', 'H', source) as Factory;
  } catch {
    return null;
  }
  const names = [...builder.variables.keys()];
  return (vm) => factory(vm, names.map(name => vm.bindVariable(name)), HELPERS);
}

class Builder {
  readonly variables = new Map<string, number>();
  readonly lines: string[] = [];
  private temporary = 0;

  expression(node: AvsEelNode): string {
    switch (node.kind) {
      case 'number': return numberLiteral(node.value);
      case 'variable': return this.variable(node.name);
      case 'sequence': {
        let result = '0';
        for (const value of node.values) {
          result = this.expression(value);
          const next = this.temp();
          this.lines.push(`const ${next}=H.finite(${result});`);
          result = next;
        }
        return result;
      }
      case 'unary': return this.unary(node.operator, node.value);
      case 'binary': return this.binary(node.operator, node.left, node.right);
      case 'conditional': return this.conditional(node.condition, node.yes, node.no);
      case 'assign': return this.assign(node.operator, node.target, node.value);
      case 'call': return this.call(node.name, node.args);
    }
  }

  private variable(rawName: string): string {
    if (rawName === '$pi') return 'Math.PI';
    if (rawName === '$e') return 'Math.E';
    if (rawName === '$phi') return '((1+Math.sqrt(5))*.5)';
    const index = this.variableIndex(rawName);
    return `(a${index}[j${index}]??0)`;
  }

  private variableLocation(rawName: string): string {
    const index = this.variableIndex(rawName);
    return `a${index}[j${index}]`;
  }

  private variableIndex(rawName: string): number {
    const name = normalizeVariable(rawName);
    let index = this.variables.get(name);
    if (index === undefined) {
      index = this.variables.size;
      this.variables.set(name, index);
    }
    return index;
  }

  private unary(operator: string, valueNode: AvsEelNode): string {
    const value = this.expression(valueNode);
    switch (operator) {
      case '+': return `H.finite(${value})`;
      case '-': return `H.finite(-(${value}))`;
      case '!': return `(H.truth(${value})?0:1)`;
      case '~': return `(~H.integer(${value}))`;
      default: throw new UnsupportedJitNode();
    }
  }

  private binary(operator: string, leftNode: AvsEelNode, rightNode: AvsEelNode): string {
    // Materialise the left operand before compiling any right-operand side
    // effects. EEL expressions such as `x + assign(x, 2)` depend on this order.
    const left = this.store(this.expression(leftNode));
    if (operator === '&&' || operator === '||') {
      const result = this.temp();
      this.lines.push(`let ${result};`);
      if (operator === '&&') {
        this.lines.push(`if(H.truth(${left})){`);
        const right = this.expression(rightNode);
        this.lines.push(`${result}=H.truth(${right})?1:0;}else{${result}=0;}`);
      } else {
        this.lines.push(`if(H.truth(${left})){${result}=1;}else{`);
        const right = this.expression(rightNode);
        this.lines.push(`${result}=H.truth(${right})?1:0;}`);
      }
      return result;
    }
    const right = this.expression(rightNode);
    switch (operator) {
      case '+': return `H.finite((${left})+(${right}))`;
      case '-': return `H.finite((${left})-(${right}))`;
      case '*': return `H.finite((${left})*(${right}))`;
      case '/': return `H.divide(${left},${right})`;
      case '%': return `H.modulo(${left},${right})`;
      case '**': return `H.finite(Math.pow(${left},${right}))`;
      case '|': return `(H.integer(${left})|H.integer(${right}))`;
      case '&': return `(H.integer(${left})&H.integer(${right}))`;
      case '^': return `(H.integer(${left})^H.integer(${right}))`;
      case '<<': return `(H.integer(${left})<<(H.integer(${right})&31))`;
      case '>>': return `(H.integer(${left})>>(H.integer(${right})&31))`;
      case '<': return `((${left})<(${right})?1:0)`;
      case '<=': return `((${left})<=(${right})?1:0)`;
      case '>': return `((${left})>(${right})?1:0)`;
      case '>=': return `((${left})>=(${right})?1:0)`;
      case '==': return `(H.close(${left},${right})?1:0)`;
      case '!=': return `(H.close(${left},${right})?0:1)`;
      case '===': return `((${left})===(${right})?1:0)`;
      case '!==': return `((${left})!==(${right})?1:0)`;
      default: throw new UnsupportedJitNode();
    }
  }

  private conditional(conditionNode: AvsEelNode, yesNode: AvsEelNode, noNode: AvsEelNode): string {
    const condition = this.expression(conditionNode);
    const result = this.temp();
    this.lines.push(`let ${result};if(H.truth(${condition})){`);
    const yes = this.expression(yesNode);
    this.lines.push(`${result}=${yes};}else{`);
    const no = this.expression(noNode);
    this.lines.push(`${result}=${no};}`);
    return result;
  }

  private assign(operator: string, target: AvsEelNode, valueNode: AvsEelNode): string {
    if (target.kind === 'variable') {
      if (target.name === '$pi' || target.name === '$e' || target.name === '$phi') throw new UnsupportedJitNode();
      const targetAccess = this.variableLocation(target.name);
      const right = this.expression(valueNode);
      const rightTemp = this.store(right);
      const left = this.store(targetAccess);
      const result = this.temp();
      this.lines.push(`const ${result}=${this.assignment(operator, left, rightTemp)};`);
      this.lines.push(`${targetAccess}=${result};`);
      return result;
    }
    if (isMemoryCall(target)) {
      const address = this.store(this.expression(target.args[0]!));
      const right = this.store(this.expression(valueNode));
      const global = target.name === 'gmegabuf';
      const left = this.store(`vm.readMemory(${global},${address})`);
      const result = this.temp();
      this.lines.push(`const ${result}=${this.assignment(operator, left, right)};`);
      this.lines.push(`vm.writeMemory(${global},${address},${result});`);
      return result;
    }
    throw new UnsupportedJitNode();
  }

  private call(name: string, nodes: readonly AvsEelNode[]): string {
    if (name === 'if') return this.conditional(nodes[0]!, nodes[1]!, nodes[2]!);
    if (name === 'loop') {
      const count = this.store(this.expression(nodes[0]!));
      const iterations = this.temp();
      const result = this.temp();
      const iterator = this.temp();
      this.lines.push(`const ${iterations}=Math.min(Math.max(0,H.integer(${count})),vm.maxLoopIterations);let ${result}=0;for(let ${iterator}=0;${iterator}<${iterations};${iterator}++){`);
      const body = this.expression(nodes[1]!);
      this.lines.push(`${result}=${body};}`);
      return `H.finite(${result})`;
    }
    if (name === 'assign') {
      const target = nodes[0]!;
      if (target.kind === 'variable') {
        const access = this.variableLocation(target.name);
        const value = this.store(`H.finite(${this.expression(nodes[1]!)})`);
        this.lines.push(`${access}=${value};`);
        return value;
      }
      if (isMemoryCall(target)) {
        const address = this.store(this.expression(target.args[0]!));
        const value = this.store(`H.finite(${this.expression(nodes[1]!)})`);
        this.lines.push(`vm.writeMemory(${target.name === 'gmegabuf'},${address},${value});`);
        return value;
      }
      throw new UnsupportedJitNode();
    }
    if (name === 'megabuf' || name === 'gmegabuf') {
      return `vm.readMemory(${name === 'gmegabuf'},${this.expression(nodes[0]!)})`;
    }
    const args = nodes.map(node => this.store(this.expression(node)));
    const one = (fn: string): string => `H.finite(${fn}(${args[0]}))`;
    const two = (fn: string): string => `H.finite(${fn}(${args[0]},${args[1]}))`;
    switch (name) {
      case 'sin': return one('Math.sin');
      case 'cos': return one('Math.cos');
      case 'tan': return one('Math.tan');
      case 'asin': return one('Math.asin');
      case 'acos': return one('Math.acos');
      case 'atan': return one('Math.atan');
      case 'atan2': return two('Math.atan2');
      case 'sqrt': return one('Math.sqrt');
      case 'sqr': return `H.finite((${args[0]})*(${args[0]}))`;
      case 'invsqrt': return `H.finite(1/Math.sqrt(${args[0]}))`;
      case 'pow': return two('Math.pow');
      case 'exp': return one('Math.exp');
      case 'log': return one('Math.log');
      case 'log10': return one('Math.log10');
      case 'abs': return one('Math.abs');
      case 'floor': return one('Math.floor');
      case 'ceil': return one('Math.ceil');
      case 'int': return one('Math.trunc');
      case 'sign': return `((${args[0]})<0?-1:((${args[0]})>0?1:0))`;
      case 'min': return two('Math.min');
      case 'max': return two('Math.max');
      case 'equal': return `(H.close(${args[0]},${args[1]})?1:0)`;
      case 'above': return `((${args[0]})>(${args[1]})?1:0)`;
      case 'below': return `((${args[0]})<(${args[1]})?1:0)`;
      case 'band': return `(H.truth(${args[0]})&&H.truth(${args[1]})?1:0)`;
      case 'bor': return `(H.truth(${args[0]})||H.truth(${args[1]})?1:0)`;
      case 'bnot': return `(H.truth(${args[0]})?0:1)`;
      case 'rand': return `vm.random(${args[0]})`;
      case 'getosc': return `vm.host("getosc",${args[0]},${args[1]},${args[2]})`;
      case 'getspec': return `vm.host("getspec",${args[0]},${args[1]},${args[2]})`;
      case 'gettime': return `vm.host("gettime",${args[0]})`;
      case 'getkbmouse': return `vm.host("getkbmouse",${args[0]})`;
      default: throw new UnsupportedJitNode();
    }
  }

  private store(expression: string): string {
    const temporary = this.temp();
    this.lines.push(`const ${temporary}=${expression};`);
    return temporary;
  }

  /** Inline the compile-time-known assignment operator in hot point scripts. */
  private assignment(operator: string, left: string, right: string): string {
    switch (operator) {
      case '=': return `H.finite(${right})`;
      case '+=': return `H.finite((${left})+(${right}))`;
      case '-=': return `H.finite((${left})-(${right}))`;
      case '*=': return `H.finite((${left})*(${right}))`;
      case '/=': return `H.divide(${left},${right})`;
      case '%=': return `H.modulo(${left},${right})`;
      case '|=': return `(H.integer(${left})|H.integer(${right}))`;
      case '&=': return `(H.integer(${left})&H.integer(${right}))`;
      case '^=': return `(H.integer(${left})^H.integer(${right}))`;
      case '**=': return `H.finite(Math.pow(${left},${right}))`;
      default: throw new UnsupportedJitNode();
    }
  }

  private temp(): string { return `t${this.temporary++}`; }
}

class UnsupportedJitNode extends Error {}

function isMemoryCall(node: AvsEelNode): node is Extract<AvsEelNode, { kind: 'call' }> {
  return node.kind === 'call' && (node.name === 'megabuf' || node.name === 'gmegabuf') && node.args.length === 1;
}
function normalizeVariable(name: string): string { return name.toLowerCase().slice(0, 8); }
function numberLiteral(value: number): string {
  return Number.isFinite(value) ? String(value) : '0';
}
