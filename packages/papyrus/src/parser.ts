/**
 * Recursive-descent Papyrus parser with line-level error recovery: a bad line
 * produces a diagnostic and parsing resumes on the next line, so one typo never
 * hides the rest of the script (unlike the Creation Kit, which simply refuses).
 */
import type { CallArg, Diagnostic, Expr, FunctionDecl, Param, PropertyDecl, Script, StateDecl, Stmt, TypeRef, VariableDecl } from './ast';
import { lex, type Range, type Token } from './lexer';

export interface ParseResult {
  script: Script;
  diagnostics: Diagnostic[];
  tokens: Token[];
  comments: Range[];
}

const BUILTIN_TYPES = new Set(['bool', 'int', 'float', 'string']);
const BLOCK_END = new Set(['endfunction', 'endevent', 'endif', 'elseif', 'else', 'endwhile', 'endstate', 'endproperty']);
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=']);

class ParseError extends Error {}

class Parser {
  private i = 0;
  readonly diagnostics: Diagnostic[] = [];
  private pendingDoc: string | undefined;

  constructor(private readonly tokens: Token[]) {}

  // ---------------------------------------------------------------- token helpers

  private get tok(): Token {
    return this.tokens[this.i]!;
  }

  /** Current token kind (a method so TypeScript doesn't narrow across next()). */
  private k(): Token['kind'] {
    return this.tokens[this.i]!.kind;
  }

  private peek(n = 1): Token {
    return this.tokens[Math.min(this.i + n, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const t = this.tokens[this.i]!;
    if (this.i < this.tokens.length - 1) this.i++;
    return t;
  }

  private isKw(lower: string, t = this.tok): boolean {
    return t.kind === 'keyword' && t.lower === lower;
  }

  private isOp(text: string, t = this.tok): boolean {
    return t.kind === 'op' && t.text === text;
  }

  private error(message: string, range: Range = this.tok.range, code?: string): never {
    this.diagnostics.push({ severity: 'error', message, range, code });
    throw new ParseError(message);
  }

  private report(message: string, range: Range, severity: Diagnostic['severity'] = 'error', code?: string): void {
    this.diagnostics.push({ severity, message, range, code });
  }

  private expectKw(lower: string): Token {
    if (!this.isKw(lower)) this.error(`Expected "${lower}" but found "${this.tok.text || this.k()}"`);
    return this.next();
  }

  private expectOp(text: string): Token {
    if (!this.isOp(text)) this.error(`Expected "${text}" but found "${this.tok.text || this.k()}"`);
    return this.next();
  }

  private expectIdent(what = 'identifier'): Token {
    const t = this.tok;
    // Some keywords double as identifiers in practice (e.g. "Length" handled in lexer).
    if (t.kind !== 'ident') this.error(`Expected ${what} but found "${t.text || t.kind}"`);
    return this.next();
  }

  private skipDocs(): string | undefined {
    let doc: string | undefined;
    while (this.k() === 'doc' || this.k() === 'newline') {
      if (this.k() === 'doc') doc = String(this.tok.value ?? '');
      this.next();
    }
    return doc;
  }

  private endOfLine(): void {
    // Doc comments may trail a header line.
    while (this.k() === 'doc') {
      this.pendingDoc = String(this.tok.value ?? '');
      this.next();
    }
    if (this.k() !== 'newline' && this.k() !== 'eof') this.error(`Unexpected "${this.tok.text}" at end of line`);
    while (this.k() === 'newline') this.next();
  }

  private recoverToLineEnd(): void {
    while (this.k() !== 'newline' && this.k() !== 'eof') this.next();
    while (this.k() === 'newline') this.next();
  }

  private span(start: Range, end: Range = this.tokens[Math.max(0, this.i - 1)]!.range): Range {
    return { start: start.start, end: end.end };
  }

  // ---------------------------------------------------------------- script

  parseScript(): Script {
    const script: Script = {
      name: '',
      lower: '',
      isHidden: false,
      isConditional: false,
      imports: [],
      variables: [],
      properties: [],
      functions: [],
      states: [],
    };
    this.skipDocs();
    try {
      const start = this.expectKw('scriptname');
      const name = this.expectIdent('script name');
      script.name = name.text;
      script.lower = name.lower;
      script.nameRange = name.range;
      if (this.isKw('extends')) {
        this.next();
        script.extends = this.expectIdent('parent script name').text;
      }
      while (this.isKw('hidden') || this.isKw('conditional')) {
        const f = this.next();
        if (f.lower === 'hidden') script.isHidden = true;
        else script.isConditional = true;
      }
      script.headerRange = this.span(start.range);
      this.endOfLine();
      script.doc = this.pendingDoc ?? this.skipDocs();
      this.pendingDoc = undefined;
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      this.recoverToLineEnd();
    }

    while (this.k() !== 'eof') {
      const doc = this.skipDocs();
      if (this.k() === 'eof') break;
      try {
        this.parseTopLevel(script, doc, undefined);
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.recoverToLineEnd();
      }
    }
    return script;
  }

  private parseTopLevel(script: Script, doc: string | undefined, state: StateDecl | undefined): void {
    const t = this.tok;
    if (this.isKw('import')) {
      if (state) this.error('Import is only allowed at script level');
      this.next();
      script.imports.push(this.expectIdent('script name').text);
      this.endOfLine();
      return;
    }
    if (this.isKw('state') || (this.isKw('auto') && this.isKw('state', this.peek()))) {
      if (state) this.error('States cannot be nested');
      script.states.push(this.parseState());
      return;
    }
    if (this.isKw('function') || this.isKw('event')) {
      const fn = this.parseFunction(undefined, doc, state);
      (state ? state.functions : script.functions).push(fn);
      return;
    }
    // Typed declarations: function with return type, property, variable.
    if (this.startsType()) {
      const type = this.parseType();
      if (this.isKw('function')) {
        const fn = this.parseFunction(type, doc, state);
        (state ? state.functions : script.functions).push(fn);
        return;
      }
      if (this.isKw('property')) {
        if (state) this.error('Properties cannot be declared inside a state');
        script.properties.push(this.parseProperty(type, doc));
        return;
      }
      if (state) this.error('Variables cannot be declared inside a state');
      script.variables.push(this.parseVariable(type));
      return;
    }
    this.error(`Unexpected "${t.text || t.kind}"`);
  }

  private startsType(): boolean {
    const t = this.tok;
    return t.kind === 'ident' || (t.kind === 'keyword' && BUILTIN_TYPES.has(t.lower));
  }

  private parseType(): TypeRef {
    const t = this.tok;
    if (!this.startsType()) this.error(`Expected a type but found "${t.text || t.kind}"`);
    this.next();
    let isArray = false;
    if (this.isOp('[') && this.isOp(']', this.peek())) {
      this.next();
      this.next();
      isArray = true;
    }
    return { name: t.text, lower: t.lower, isArray, range: this.span(t.range) };
  }

  private parseVariable(type: TypeRef): VariableDecl {
    const name = this.expectIdent('variable name');
    let init: Expr | undefined;
    if (this.isOp('=')) {
      this.next();
      init = this.parseExpr();
    }
    let isConditional = false;
    if (this.isKw('conditional')) {
      this.next();
      isConditional = true;
    }
    const range = this.span(type.range);
    this.endOfLine();
    return { name: name.text, lower: name.lower, type, init, isConditional, range, nameRange: name.range };
  }

  private parseProperty(type: TypeRef, doc: string | undefined): PropertyDecl {
    this.expectKw('property');
    const name = this.expectIdent('property name');
    const prop: PropertyDecl = {
      name: name.text,
      lower: name.lower,
      type,
      isAuto: false,
      isAutoReadOnly: false,
      isHidden: false,
      isConditional: false,
      doc,
      range: type.range,
      nameRange: name.range,
    };
    if (this.isOp('=')) {
      this.next();
      prop.init = this.parseExpr();
    }
    while (this.k() === 'keyword' && ['auto', 'autoreadonly', 'hidden', 'conditional'].includes(this.tok.lower)) {
      const f = this.next().lower;
      if (f === 'auto') prop.isAuto = true;
      else if (f === 'autoreadonly') prop.isAutoReadOnly = true;
      else if (f === 'hidden') prop.isHidden = true;
      else prop.isConditional = true;
    }
    prop.range = this.span(type.range);
    this.endOfLine();
    if (this.pendingDoc) {
      prop.doc = this.pendingDoc;
      this.pendingDoc = undefined;
    }
    if (prop.isAutoReadOnly && !prop.init) this.report('AutoReadOnly properties need an initial value', prop.nameRange);
    if (prop.isAuto || prop.isAutoReadOnly) return prop;
    // Full property: Get/Set functions until EndProperty.
    while (!this.isKw('endproperty') && this.k() !== 'eof') {
      const fdoc = this.skipDocs();
      if (this.isKw('endproperty')) break;
      try {
        let rt: TypeRef | undefined;
        if (!this.isKw('function')) rt = this.parseType();
        const fn = this.parseFunction(rt, fdoc, undefined);
        if (fn.lower === 'get') prop.getter = fn;
        else if (fn.lower === 'set') prop.setter = fn;
        else this.report('Only Get and Set functions are allowed in a property', fn.nameRange);
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.recoverToLineEnd();
      }
    }
    if (this.isKw('endproperty')) {
      this.next();
      prop.range = this.span(type.range);
      this.endOfLine();
    } else this.report(`Missing EndProperty for property ${prop.name}`, prop.nameRange);
    if (!prop.getter && !prop.setter) this.report(`Property ${prop.name} needs Auto, AutoReadOnly or a Get/Set function`, prop.nameRange);
    return prop;
  }

  private parseState(): StateDecl {
    const start = this.tok;
    let isAuto = false;
    if (this.isKw('auto')) {
      this.next();
      isAuto = true;
    }
    this.expectKw('state');
    const name = this.expectIdent('state name');
    this.endOfLine();
    const state: StateDecl = { name: name.text, lower: name.lower, isAuto, functions: [], range: start.range };
    while (!this.isKw('endstate') && this.k() !== 'eof') {
      const doc = this.skipDocs();
      if (this.isKw('endstate') || this.k() === 'eof') break;
      try {
        this.parseTopLevel({ functions: state.functions } as unknown as Script, doc, state);
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.recoverToLineEnd();
      }
    }
    if (this.isKw('endstate')) {
      this.next();
      state.range = this.span(start.range);
      this.endOfLine();
    } else this.report(`Missing EndState for state ${state.name}`, name.range);
    return state;
  }

  private parseParams(): Param[] {
    this.expectOp('(');
    const params: Param[] = [];
    if (!this.isOp(')')) {
      for (;;) {
        const type = this.parseType();
        const name = this.expectIdent('parameter name');
        let def: Expr | undefined;
        if (this.isOp('=')) {
          this.next();
          def = this.parseExpr();
        }
        params.push({ type, name: name.text, lower: name.lower, default: def, range: this.span(type.range) });
        if (this.isOp(',')) {
          this.next();
          continue;
        }
        break;
      }
    }
    this.expectOp(')');
    return params;
  }

  private parseFunction(returnType: TypeRef | undefined, doc: string | undefined, state: StateDecl | undefined): FunctionDecl {
    const kwTok = this.next();
    const kind = kwTok.lower === 'event' ? 'event' : 'function';
    if (kind === 'event' && returnType) this.report('Events cannot have a return type', returnType.range);
    const name = this.expectIdent(`${kind} name`);
    const params = this.parseParams();
    let isGlobal = false;
    let isNative = false;
    while (this.k() === 'keyword' && ['global', 'native', 'debugonly', 'betaonly'].includes(this.tok.lower)) {
      const f = this.next().lower;
      if (f === 'global') isGlobal = true;
      if (f === 'native') isNative = true;
    }
    const start = returnType?.range ?? kwTok.range;
    const fn: FunctionDecl = {
      kind,
      name: name.text,
      lower: name.lower,
      returnType,
      params,
      isGlobal,
      isNative,
      doc,
      state: state?.lower,
      range: this.span(start),
      nameRange: name.range,
    };
    this.endOfLine();
    if (this.pendingDoc) {
      fn.doc = this.pendingDoc;
      this.pendingDoc = undefined;
    }
    if (isNative) return fn;
    const endKw = kind === 'event' ? 'endevent' : 'endfunction';
    fn.body = this.parseBlock(new Set([endKw]));
    if (this.isKw(endKw)) {
      this.next();
      fn.range = this.span(start);
      this.endOfLine();
    } else {
      this.report(`Missing ${kind === 'event' ? 'EndEvent' : 'EndFunction'} for ${fn.name}`, fn.nameRange, 'error', 'missing-end');
    }
    return fn;
  }

  /** Statements until one of the terminators (not consumed) or a structural keyword. */
  private parseBlock(terminators: Set<string>): Stmt[] {
    const body: Stmt[] = [];
    for (;;) {
      while (this.k() === 'newline' || this.k() === 'doc') this.next();
      const t = this.tok;
      if (t.kind === 'eof') return body;
      if (t.kind === 'keyword' && terminators.has(t.lower)) return body;
      // Structural keywords end the block even if unexpected (missing End...).
      if (t.kind === 'keyword' && (BLOCK_END.has(t.lower) || ['function', 'event', 'state', 'property'].includes(t.lower))) {
        if (!terminators.has(t.lower)) return body;
      }
      if (this.startsType() && (this.isKw('function', this.peek()) || this.isKw('property', this.peek()))) return body;
      if (this.startsType() && this.isOp('[', this.peek()) && this.isOp(']', this.peek(2)) && this.isKw('function', this.peek(3))) return body;
      try {
        body.push(this.parseStatement());
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.recoverToLineEnd();
      }
    }
  }

  private parseStatement(): Stmt {
    const t = this.tok;
    if (this.isKw('if')) return this.parseIf();
    if (this.isKw('while')) {
      this.next();
      const cond = this.parseExpr();
      this.endOfLine();
      const body = this.parseBlock(new Set(['endwhile']));
      if (!this.isKw('endwhile')) this.error('Missing EndWhile', t.range);
      this.next();
      const range = this.span(t.range);
      this.endOfLine();
      return { kind: 'while', cond, body, range };
    }
    if (this.isKw('return')) {
      this.next();
      let value: Expr | undefined;
      if (this.k() !== 'newline' && this.k() !== 'eof') value = this.parseExpr();
      const range = this.span(t.range);
      this.endOfLine();
      return { kind: 'return', value, range };
    }
    // Local variable declaration: Type [ [] ] Name ...
    if (this.startsType()) {
      const n1 = this.peek();
      const isArrayDecl = this.isOp('[', n1) && this.isOp(']', this.peek(2)) && this.peek(3).kind === 'ident';
      if (n1.kind === 'ident' || isArrayDecl) {
        const type = this.parseType();
        const name = this.expectIdent('variable name');
        let init: Expr | undefined;
        if (this.isOp('=')) {
          this.next();
          init = this.parseExpr();
        }
        const range = this.span(type.range);
        this.endOfLine();
        return { kind: 'local', type, name: name.text, lower: name.lower, init, nameRange: name.range, range };
      }
    }
    const expr = this.parseExpr();
    if (this.k() === 'op' && ASSIGN_OPS.has(this.tok.text)) {
      const op = this.next().text;
      const value = this.parseExpr();
      if (!['ident', 'member', 'index'].includes(expr.kind)) this.report('Cannot assign to this expression', expr.range);
      const range = this.span(t.range);
      this.endOfLine();
      return { kind: 'assign', op, target: expr, value, range };
    }
    const range = this.span(t.range);
    this.endOfLine();
    if (expr.kind !== 'call') this.report('Expression has no effect', expr.range, 'warning', 'no-effect');
    return { kind: 'expr', expr, range };
  }

  private parseIf(): Stmt {
    const start = this.next(); // If
    const branches: { cond: Expr; body: Stmt[]; range: Range }[] = [];
    let cond = this.parseExpr();
    this.endOfLine();
    let body = this.parseBlock(new Set(['elseif', 'else', 'endif']));
    branches.push({ cond, body, range: this.span(start.range) });
    let elseBody: Stmt[] | undefined;
    while (this.isKw('elseif')) {
      const t = this.next();
      cond = this.parseExpr();
      this.endOfLine();
      body = this.parseBlock(new Set(['elseif', 'else', 'endif']));
      branches.push({ cond, body, range: this.span(t.range) });
    }
    if (this.isKw('else')) {
      this.next();
      this.endOfLine();
      elseBody = this.parseBlock(new Set(['endif']));
    }
    if (!this.isKw('endif')) this.error('Missing EndIf', start.range);
    this.next();
    const range = this.span(start.range);
    this.endOfLine();
    return { kind: 'if', branches, elseBody, range };
  }

  // ---------------------------------------------------------------- expressions

  parseExpr(): Expr {
    return this.parseOr();
  }

  private binary(next: () => Expr, ops: readonly string[]): Expr {
    let left = next();
    while (this.k() === 'op' && ops.includes(this.tok.text)) {
      const op = this.next().text;
      const right = next();
      left = { kind: 'binary', op, left, right, range: { start: left.range.start, end: right.range.end } };
    }
    return left;
  }

  private parseOr(): Expr {
    return this.binary(() => this.parseAnd(), ['||']);
  }
  private parseAnd(): Expr {
    return this.binary(() => this.parseCompare(), ['&&']);
  }
  private parseCompare(): Expr {
    return this.binary(() => this.parseAdd(), ['==', '!=', '<', '>', '<=', '>=']);
  }
  private parseAdd(): Expr {
    return this.binary(() => this.parseMul(), ['+', '-']);
  }
  private parseMul(): Expr {
    return this.binary(() => this.parseUnary(), ['*', '/', '%']);
  }

  private parseUnary(): Expr {
    if (this.isOp('-') || this.isOp('!')) {
      const t = this.next();
      const operand = this.parseUnary();
      // Fold negative numeric literals.
      if (t.text === '-' && operand.kind === 'literal' && (operand.type === 'int' || operand.type === 'float')) {
        return { ...operand, value: -(operand.value as number), range: { start: t.range.start, end: operand.range.end } };
      }
      return { kind: 'unary', op: t.text as '-' | '!', operand, range: { start: t.range.start, end: operand.range.end } };
    }
    return this.parseCast();
  }

  private parseCast(): Expr {
    let e = this.parsePostfix();
    while (this.isKw('as')) {
      this.next();
      const type = this.parseType();
      e = { kind: 'cast', expr: e, type, range: { start: e.range.start, end: type.range.end } };
    }
    return e;
  }

  private parseArgs(): CallArg[] {
    this.expectOp('(');
    const args: CallArg[] = [];
    if (!this.isOp(')')) {
      for (;;) {
        let name: string | undefined;
        if (this.k() === 'ident' && this.isOp('=', this.peek())) {
          name = this.next().text;
          this.next();
        }
        args.push({ name, value: this.parseExpr() });
        if (this.isOp(',')) {
          this.next();
          continue;
        }
        break;
      }
    }
    this.expectOp(')');
    return args;
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      if (this.isOp('.')) {
        this.next();
        if (this.isKw('length')) {
          const t = this.next();
          e = { kind: 'length', object: e, range: { start: e.range.start, end: t.range.end } };
          continue;
        }
        const name = this.tok;
        if (name.kind !== 'ident') {
          this.report('Expected member name after "."', name.range, 'error', 'member-expected');
          return { kind: 'member', object: e, name: '', lower: '', nameRange: name.range, range: { start: e.range.start, end: name.range.start } };
        }
        this.next();
        e = { kind: 'member', object: e, name: name.text, lower: name.lower, nameRange: name.range, range: { start: e.range.start, end: name.range.end } };
        continue;
      }
      if (this.isOp('(')) {
        const args = this.parseArgs();
        e = { kind: 'call', callee: e, args, range: { start: e.range.start, end: this.tokens[this.i - 1]!.range.end } };
        continue;
      }
      if (this.isOp('[')) {
        this.next();
        const index = this.parseExpr();
        const close = this.expectOp(']');
        e = { kind: 'index', object: e, index, range: { start: e.range.start, end: close.range.end } };
        continue;
      }
      return e;
    }
  }

  private parsePrimary(): Expr {
    const t = this.tok;
    switch (t.kind) {
      case 'int':
        this.next();
        return { kind: 'literal', type: 'int', value: t.value as number, range: t.range };
      case 'float':
        this.next();
        return { kind: 'literal', type: 'float', value: t.value as number, range: t.range };
      case 'string':
        this.next();
        return { kind: 'literal', type: 'string', value: t.value as string, range: t.range };
      case 'ident':
        this.next();
        return { kind: 'ident', name: t.text, lower: t.lower, range: t.range };
      case 'keyword':
        switch (t.lower) {
          case 'true':
          case 'false':
            this.next();
            return { kind: 'literal', type: 'bool', value: t.lower === 'true', range: t.range };
          case 'none':
            this.next();
            return { kind: 'literal', type: 'none', value: null, range: t.range };
          case 'self':
            this.next();
            return { kind: 'self', range: t.range };
          case 'parent':
            this.next();
            return { kind: 'parent', range: t.range };
          case 'new': {
            this.next();
            const type = this.parseType();
            this.expectOp('[');
            const size = this.parseExpr();
            const close = this.expectOp(']');
            return { kind: 'new', type: { ...type, isArray: true }, size, range: { start: t.range.start, end: close.range.end } };
          }
          case 'bool':
          case 'int':
          case 'float':
          case 'string':
            // e.g. "String.Func()" is not valid Papyrus, but allow the identifier to continue parsing.
            this.next();
            return { kind: 'ident', name: t.text, lower: t.lower, range: t.range };
        }
        break;
      case 'op':
        if (t.text === '(') {
          this.next();
          const expr = this.parseExpr();
          const close = this.expectOp(')');
          return { kind: 'paren', expr, range: { start: t.range.start, end: close.range.end } };
        }
        break;
    }
    this.error(`Expected an expression but found "${t.text || t.kind}"`);
  }
}

export function parse(source: string): ParseResult {
  const lexed = lex(source);
  const parser = new Parser(lexed.tokens);
  const script = parser.parseScript();
  const diagnostics: Diagnostic[] = [
    ...lexed.errors.map((e) => ({ severity: 'error' as const, message: e.message, range: e.range, code: 'lex' })),
    ...parser.diagnostics,
  ];
  return { script, diagnostics, tokens: lexed.tokens, comments: lexed.comments };
}

/** Parse a single expression (used by condition editors and the debug console). */
export function parseExpression(source: string): { expr?: Expr; diagnostics: Diagnostic[] } {
  const lexed = lex(source);
  const parser = new Parser(lexed.tokens);
  try {
    const expr = parser.parseExpr();
    return { expr, diagnostics: parser.diagnostics };
  } catch {
    return { diagnostics: parser.diagnostics };
  }
}
