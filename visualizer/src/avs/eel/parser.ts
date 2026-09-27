import {
  AvsEelSyntaxError,
  type AvsEelAssignmentOperator,
  type AvsEelAst,
  type AvsEelNode,
} from './types.ts';

type TokenKind = 'number' | 'identifier' | 'operator' | 'punctuation' | 'eof';
interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** At least one physical newline separated this token from the previous. */
  readonly lineBreakBefore: boolean;
}

const ASSIGNMENTS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=', '**=']);
const PRECEDENCE: Readonly<Record<string, number>> = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6, '!=': 6, '===': 6, '!==': 6,
  '<': 7, '<=': 7, '>': 7, '>=': 7,
  '<<': 8, '>>': 8,
  '+': 9, '-': 9,
  '*': 10, '/': 10, '%': 10,
  '**': 11,
};

/** Parse classic AVS/NS-EEL expression source into a position-bearing AST. */
export function parseAvsEel(source: string): AvsEelAst {
  const parser = new Parser(source);
  return { kind: 'program', source, body: parser.program() };
}

class Parser {
  private readonly lexer: Lexer;
  private current: Token;

  constructor(private readonly source: string) {
    this.lexer = new Lexer(source);
    this.current = this.lexer.next();
  }

  program(): AvsEelNode {
    const values: AvsEelNode[] = [];
    for (;;) {
      if (this.current.kind === 'eof') break;
      if (this.take(';') || this.take(',')) continue;
      values.push(this.expression(0, true));
      if (this.take(';') || this.take(',')) continue;
      if (this.current.lineBreakBefore) continue;
      // The classic AVS editor accepted adjacent complete assignments as
      // statements even when an author omitted the semicolon (`n=30 t=-2`).
      if (this.startsExpression()) continue;
      if (!this.atEnd()) this.fail(`Expected statement separator, got ${JSON.stringify(this.current.text)}`);
    }
    if (values.length === 0) return { kind: 'number', value: 0, span: { start: 0, end: 0 } };
    if (values.length === 1) return values[0]!;
    return {
      kind: 'sequence',
      values,
      span: { start: values[0]!.span.start, end: values[values.length - 1]!.span.end },
    };
  }

  private expression(minPrecedence: number, stopAtComma: boolean): AvsEelNode {
    let left = this.prefix();

    for (;;) {
      if (stopAtComma && this.current.text === ',') break;
      if (this.current.text === '?') {
        if (minPrecedence > 0) break;
        this.advance();
        const yes = this.expression(0, true);
        this.expect(':');
        const no = this.expression(0, stopAtComma);
        left = { kind: 'conditional', condition: left, yes, no, span: { start: left.span.start, end: no.span.end } };
        continue;
      }

      if (ASSIGNMENTS.has(this.current.text)) {
        if (minPrecedence > 0) break;
        const operator = this.current.text as AvsEelAssignmentOperator;
        this.advance();
        const value = this.expression(0, stopAtComma);
        left = { kind: 'assign', operator, target: left, value, span: { start: left.span.start, end: value.span.end } };
        continue;
      }

      const precedence = PRECEDENCE[this.current.text];
      if (precedence === undefined || precedence < minPrecedence) break;
      const operator = this.current.text;
      this.advance();
      // Exponentiation is right associative; all other binary operators are left associative.
      const right = this.expression(operator === '**' ? precedence : precedence + 1, stopAtComma);
      left = { kind: 'binary', operator, left, right, span: { start: left.span.start, end: right.span.end } };
    }
    return left;
  }

  private prefix(): AvsEelNode {
    const token = this.current;
    if (token.kind === 'number') {
      this.advance();
      const value = Number(token.text);
      if (!Number.isFinite(value)) this.fail(`Invalid number ${JSON.stringify(token.text)}`, token.start);
      return { kind: 'number', value, span: { start: token.start, end: token.end } };
    }
    if (token.kind === 'identifier') {
      this.advance();
      const name = token.text.toLowerCase();
      if (!this.take('(')) return { kind: 'variable', name, span: { start: token.start, end: token.end } };
      const args: AvsEelNode[] = [];
      if (!this.take(')')) {
        do { args.push(this.expression(0, true)); } while (this.take(','));
        this.expect(')');
      }
      return { kind: 'call', name, args, span: { start: token.start, end: this.previousEnd } };
    }
    if (token.text === '(') {
      this.advance();
      const values: AvsEelNode[] = [];
      while (!this.take(')')) {
        if (this.current.kind === 'eof') this.fail('Unterminated parenthesized expression', token.start);
        if (this.take(';') || this.take(',')) continue;
        values.push(this.expression(0, true));
        if (
          this.current.text !== ')' &&
          !this.take(';') &&
          !this.take(',') &&
          !this.current.lineBreakBefore &&
          !this.startsExpression()
        ) {
          this.fail(`Expected separator or ')', got ${JSON.stringify(this.current.text)}`);
        }
      }
      if (values.length === 0) return { kind: 'number', value: 0, span: { start: token.start, end: this.previousEnd } };
      if (values.length === 1) return values[0]!;
      return { kind: 'sequence', values, span: { start: token.start, end: this.previousEnd } };
    }
    if (token.text === '+' || token.text === '-' || token.text === '!' || token.text === '~') {
      this.advance();
      const value = this.expression(12, true);
      return { kind: 'unary', operator: token.text, value, span: { start: token.start, end: value.span.end } };
    }
    this.fail(`Expected expression, got ${JSON.stringify(token.text)}`);
  }

  private previousEnd = 0;
  private startsExpression(): boolean {
    return this.current.kind === 'number' ||
      this.current.kind === 'identifier' ||
      this.current.text === '(' ||
      this.current.text === '+' ||
      this.current.text === '-' ||
      this.current.text === '!' ||
      this.current.text === '~';
  }
  private atEnd(): boolean { return this.current.kind === 'eof'; }
  private advance(): void {
    this.previousEnd = this.current.end;
    this.current = this.lexer.next();
  }
  private take(text: string): boolean {
    if (this.current.text !== text) return false;
    this.advance();
    return true;
  }
  private expect(text: string): void {
    if (!this.take(text)) this.fail(`Expected ${JSON.stringify(text)}, got ${JSON.stringify(this.current.text)}`);
  }
  private fail(message: string, offset = this.current.start): never {
    throw new AvsEelSyntaxError(message, offset, this.source);
  }
}

class Lexer {
  private offset = 0;
  constructor(private readonly source: string) {}

  next(): Token {
    const lineBreakBefore = this.skipTrivia();
    const start = this.offset;
    if (start >= this.source.length) return { kind: 'eof', text: '', start, end: start, lineBreakBefore };
    const rest = this.source.slice(start);
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (number) return this.token('number', number[0]!, lineBreakBefore);
    const identifier = /^[$A-Za-z_][$A-Za-z0-9_]*/.exec(rest);
    if (identifier) return this.token('identifier', identifier[0]!, lineBreakBefore);

    for (const operator of ['!==', '===', '**=', '<<=', '>>=', '!=', '==', '<=', '>=', '&&', '||', '<<', '>>', '**', '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=']) {
      if (rest.startsWith(operator)) return this.token('operator', operator, lineBreakBefore);
    }
    const char = this.source[start]!;
    if ('+-*/%^|&!=<>~'.includes(char)) return this.token('operator', char, lineBreakBefore);
    if ('(),;?:'.includes(char)) return this.token('punctuation', char, lineBreakBefore);
    throw new AvsEelSyntaxError(`Unexpected character ${JSON.stringify(char)}`, start, this.source);
  }

  private token(kind: TokenKind, text: string, lineBreakBefore: boolean): Token {
    const start = this.offset;
    this.offset += text.length;
    return { kind, text, start, end: this.offset, lineBreakBefore };
  }

  private skipTrivia(): boolean {
    let lineBreak = false;
    for (;;) {
      while (
        this.offset < this.source.length &&
        this.source[this.offset] !== '\u00a0' &&
        /\s/.test(this.source[this.offset]!)
      ) {
        lineBreak ||= this.source[this.offset] === '\n' || this.source[this.offset] === '\r';
        this.offset++;
      }
      // Several classic preset authors used bytes A0, A3, A4, and A9 as visual
      // comment leaders in the AVS editor. The inventory preserves their
      // Windows-1252 forms (NBSP, pound, currency). AVS ignored the remainder
      // through the next statement boundary.
      if (
        this.source[this.offset] === '\u00a0' ||
        this.source[this.offset] === '£' ||
        this.source[this.offset] === '¤' ||
        this.source[this.offset] === '©'
      ) {
        const semicolon = this.source.indexOf(';', this.offset + 1);
        const relativeNewline = this.source.slice(this.offset + 1).search(/\r?\n/);
        const newline = relativeNewline < 0 ? -1 : this.offset + 1 + relativeNewline;
        const end = semicolon >= 0 && (newline < 0 || semicolon < newline) ? semicolon + 1 : newline < 0 ? this.source.length : newline;
        this.offset = end;
        continue;
      }
      if (this.source.startsWith('//', this.offset)) {
        const newline = this.source.indexOf('\n', this.offset + 2);
        this.offset = newline < 0 ? this.source.length : newline + 1;
        lineBreak = true;
        continue;
      }
      // Historic AVS editors also emitted one-slash comment-only code fields
      // (for example `/ focal blur`). At a token boundary `/name` cannot be a
      // valid division expression, so accepting it preserves those presets.
      if (
        this.source[this.offset] === '/' &&
        this.source[this.offset + 1] !== '*' &&
        this.atLineStart(this.offset) &&
        /[\sA-Za-z_]/.test(this.source[this.offset + 1] ?? '')
      ) {
        const newline = this.source.indexOf('\n', this.offset + 1);
        this.offset = newline < 0 ? this.source.length : newline + 1;
        lineBreak = true;
        continue;
      }
      if (this.source.startsWith('/*', this.offset)) {
        const end = this.source.indexOf('*/', this.offset + 2);
        if (end < 0) throw new AvsEelSyntaxError('Unterminated block comment', this.offset, this.source);
        lineBreak ||= /[\r\n]/.test(this.source.slice(this.offset, end + 2));
        this.offset = end + 2;
        continue;
      }
      break;
    }
    return lineBreak;
  }

  private atLineStart(offset: number): boolean {
    const newline = this.source.lastIndexOf('\n', offset - 1);
    return this.source.slice(newline + 1, offset).trim().length === 0;
  }
}
