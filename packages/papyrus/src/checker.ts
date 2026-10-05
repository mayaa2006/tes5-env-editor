/**
 * Semantic checks with light type inference. Errors are only reported when the
 * checker is certain: if a script's ancestry isn't fully known from real
 * sources, "does not exist" style errors are suppressed instead of guessed.
 */
import type { Diagnostic, Expr, FunctionDecl, Script, Stmt, TypeRef } from './ast';
import { PRIMITIVES, type ScriptIndex } from './index-store';
import type { Range } from './lexer';

export interface PType {
  lower: string;
  name: string;
  isArray: boolean;
}

/** Marker for an identifier that names a script type (for static/global calls). */
export interface StaticRef {
  static: true;
  script: Script;
}

export type Inferred = PType | StaticRef | null;

export const T = {
  int: { lower: 'int', name: 'Int', isArray: false } as PType,
  float: { lower: 'float', name: 'Float', isArray: false } as PType,
  bool: { lower: 'bool', name: 'Bool', isArray: false } as PType,
  string: { lower: 'string', name: 'String', isArray: false } as PType,
  none: { lower: 'none', name: 'None', isArray: false } as PType,
};

export function typeOf(ref: TypeRef): PType {
  return { lower: ref.lower, name: ref.name, isArray: ref.isArray };
}

export function typeToString(t: PType): string {
  return `${t.name}${t.isArray ? '[]' : ''}`;
}

export interface ScopeEntry {
  name: string;
  type: PType;
  kind: 'local' | 'param' | 'variable' | 'property';
  range: Range;
}

export class Scope {
  private readonly vars = new Map<string, ScopeEntry>();
  constructor(readonly parent?: Scope) {}
  define(e: ScopeEntry): void {
    this.vars.set(e.name.toLowerCase(), e);
  }
  lookup(lower: string): ScopeEntry | undefined {
    return this.vars.get(lower) ?? this.parent?.lookup(lower);
  }
  lookupLocal(lower: string): ScopeEntry | undefined {
    return this.vars.get(lower);
  }
  all(): ScopeEntry[] {
    const out = new Map<string, ScopeEntry>();
    for (let s: Scope | undefined = this; s; s = s.parent) for (const [k, v] of s.vars) if (!out.has(k)) out.set(k, v);
    return [...out.values()];
  }
}

function isStatic(t: Inferred): t is StaticRef {
  return !!t && 'static' in t;
}

export class Checker {
  readonly diagnostics: Diagnostic[] = [];
  /** Function currently being checked (also set by the language service for scope queries). */
  fn: FunctionDecl | undefined;

  constructor(
    readonly script: Script,
    readonly index: ScriptIndex,
  ) {}

  private err(message: string, range: Range, code?: string): void {
    this.diagnostics.push({ severity: 'error', message, range, code });
  }
  private warn(message: string, range: Range, code?: string): void {
    this.diagnostics.push({ severity: 'warning', message, range, code });
  }

  /** Whether everything about a script's ancestry comes from real sources. */
  private authoritative(name: string | undefined): boolean {
    if (!name) return false;
    const { scripts, complete } = this.index.chain(name);
    return complete && scripts.every((s) => this.index.origin(s.name) !== 'builtin');
  }

  private knownType(t: TypeRef): boolean {
    return PRIMITIVES.has(t.lower) || this.index.has(t.lower) || t.lower === this.script.lower;
  }

  check(): Diagnostic[] {
    const s = this.script;
    if (!s.name) return this.diagnostics;
    if (s.extends && !this.index.has(s.extends)) {
      this.warn(`Parent script "${s.extends}" was not found in the script sources`, s.headerRange ?? s.nameRange!, 'unknown-parent');
    }
    const strictTypes = this.index.names().some((n) => this.index.origin(n) !== 'builtin' && n.toLowerCase() !== s.lower);

    // Duplicate members.
    const seen = new Map<string, Range>();
    const member = (lower: string, name: string, range: Range, what: string) => {
      if (seen.has(lower)) this.err(`${what} "${name}" is already defined`, range, 'duplicate');
      else seen.set(lower, range);
    };
    for (const v of s.variables) member(v.lower, v.name, v.nameRange, 'Variable');
    for (const p of s.properties) member(p.lower, p.name, p.nameRange, 'Property');
    const fnSeen = new Map<string, Range>();
    for (const f of s.functions) {
      if (fnSeen.has(f.lower)) this.err(`Function "${f.name}" is already defined`, f.nameRange, 'duplicate');
      else fnSeen.set(f.lower, f.nameRange);
    }
    for (const st of s.states) {
      const inState = new Set<string>();
      for (const f of st.functions) {
        if (inState.has(f.lower)) this.err(`Function "${f.name}" is already defined in state ${st.name}`, f.nameRange, 'duplicate');
        inState.add(f.lower);
        if (!s.functions.some((g) => g.lower === f.lower) && !this.index.findFunction(s.extends, f.lower)) {
          this.err(`Function "${f.name}" in state ${st.name} must also exist in the empty state or a parent script`, f.nameRange, 'state-function');
        }
      }
    }
    const autoStates = s.states.filter((st) => st.isAuto);
    if (autoStates.length > 1) this.err('Only one state can be marked Auto', autoStates[1]!.range, 'auto-state');

    if (strictTypes) {
      const checkType = (t: TypeRef | undefined) => {
        if (t && !this.knownType(t)) this.warn(`Unknown type "${t.name}"`, t.range, 'unknown-type');
      };
      s.variables.forEach((v) => checkType(v.type));
      s.properties.forEach((p) => checkType(p.type));
      [...s.functions, ...s.states.flatMap((x) => x.functions)].forEach((f) => {
        checkType(f.returnType);
        f.params.forEach((p) => checkType(p.type));
      });
    }

    for (const v of s.variables) {
      if (v.init && v.init.kind !== 'literal') this.err('Script variables can only be initialized with a literal', v.init.range, 'const-init');
    }
    for (const p of s.properties) {
      if (p.init && p.init.kind !== 'literal') this.err('Properties can only be initialized with a literal', p.init.range, 'const-init');
      if (p.getter) this.checkFunction(p.getter);
      if (p.setter) this.checkFunction(p.setter);
    }
    for (const f of s.functions) this.checkFunction(f);
    for (const st of s.states) for (const f of st.functions) this.checkFunction(f);
    return this.diagnostics;
  }

  scriptScope(): Scope {
    const scope = new Scope();
    for (const sc of [...this.index.chain(this.script.extends).scripts].reverse()) {
      for (const p of sc.properties) scope.define({ name: p.name, type: typeOf(p.type), kind: 'property', range: p.nameRange });
    }
    for (const v of this.script.variables) scope.define({ name: v.name, type: typeOf(v.type), kind: 'variable', range: v.nameRange });
    for (const p of this.script.properties) scope.define({ name: p.name, type: typeOf(p.type), kind: 'property', range: p.nameRange });
    return scope;
  }

  functionScope(fn: FunctionDecl): Scope {
    const scope = new Scope(fn.isGlobal ? undefined : this.scriptScope());
    for (const p of fn.params) scope.define({ name: p.name, type: typeOf(p.type), kind: 'param', range: p.range });
    return scope;
  }

  private checkFunction(fn: FunctionDecl): void {
    this.fn = fn;
    if (fn.kind === 'event' && !fn.isNative && this.script.extends && this.authoritative(this.script.extends)) {
      const found = this.index.findFunction(this.script.extends, fn.lower);
      if (!found || found.fn.kind !== 'event') {
        this.err(`Event "${fn.name}" does not exist on any parent of ${this.script.name}; non-native scripts cannot declare new events`, fn.nameRange, 'unknown-event');
      }
    }
    if (fn.isNative && !this.script.isHidden && this.authoritative(this.script.name)) {
      this.warn('Native functions are only allowed in native (engine) scripts', fn.nameRange, 'native');
    }
    if (!fn.body) return;
    const scope = this.functionScope(fn);
    const params = new Set<string>();
    for (const p of fn.params) {
      if (params.has(p.lower)) this.err(`Parameter "${p.name}" is already defined`, p.range, 'duplicate');
      params.add(p.lower);
    }
    this.checkBlock(fn.body, scope);
    this.fn = undefined;
  }

  checkBlock(body: readonly Stmt[], scope: Scope): void {
    for (const st of body) this.checkStmt(st, scope);
  }

  private checkStmt(st: Stmt, scope: Scope): void {
    switch (st.kind) {
      case 'local': {
        const existing = scope.lookup(st.lower);
        if (existing && (existing.kind === 'local' || existing.kind === 'param')) {
          this.err(`Variable "${st.name}" is already defined in this function`, st.nameRange, 'duplicate');
        }
        if (!this.knownType(st.type) && this.index.names().some((n) => this.index.origin(n) !== 'builtin')) {
          this.warn(`Unknown type "${st.type.name}"`, st.type.range, 'unknown-type');
        }
        if (st.init) {
          const t = this.infer(st.init, scope);
          this.checkAssignable(typeOf(st.type), t, st.init.range);
        }
        scope.define({ name: st.name, type: typeOf(st.type), kind: 'local', range: st.nameRange });
        return;
      }
      case 'assign': {
        const target = this.infer(st.target, scope);
        const value = this.infer(st.value, scope);
        if (st.target.kind === 'ident' && !isStatic(target) && target) this.checkAssignable(target, value, st.value.range);
        return;
      }
      case 'expr':
        this.infer(st.expr, scope);
        return;
      case 'return': {
        const fn = this.fn;
        if (!fn) return;
        const isGetter = fn.lower === 'get';
        if (st.value) {
          const t = this.infer(st.value, scope);
          if (!fn.returnType && !isGetter) this.err(`${fn.name} does not return a value`, st.value.range, 'return-value');
          else if (fn.returnType) this.checkAssignable(typeOf(fn.returnType), t, st.value.range);
        } else if (fn.returnType) {
          this.err(`${fn.name} must return a ${typeToString(typeOf(fn.returnType))}`, st.range, 'return-missing');
        }
        return;
      }
      case 'if':
        for (const b of st.branches) {
          this.infer(b.cond, scope);
          this.checkBlock(b.body, new Scope(scope));
        }
        if (st.elseBody) this.checkBlock(st.elseBody, new Scope(scope));
        return;
      case 'while':
        this.infer(st.cond, scope);
        this.checkBlock(st.body, new Scope(scope));
        return;
    }
  }

  private checkAssignable(target: PType, value: Inferred, range: Range): void {
    if (!value || isStatic(value)) return;
    if (value.lower === 'none') {
      if (PRIMITIVES.has(target.lower) && !target.isArray) this.err(`Cannot assign None to ${typeToString(target)}`, range, 'type');
      return;
    }
    if (target.isArray !== value.isArray) {
      this.err(`Type mismatch: expected ${typeToString(target)}, got ${typeToString(value)}`, range, 'type');
      return;
    }
    const t = target.lower;
    const v = value.lower;
    if (t === v) return;
    // Implicit conversions Papyrus performs on assignment.
    if (t === 'float' && v === 'int') return;
    if (t === 'string' && !value.isArray) return;
    if (t === 'bool' && !value.isArray) return;
    if (PRIMITIVES.has(t) || PRIMITIVES.has(v)) {
      this.err(`Type mismatch: expected ${typeToString(target)}, got ${typeToString(value)}`, range, 'type');
      return;
    }
    // Object types: allow upcasts; downcasts need an explicit "as".
    if (this.index.has(v) && this.index.has(t) && this.authoritative(v) && !this.index.isSubtype(v, t)) {
      this.err(`Cannot implicitly convert ${typeToString(value)} to ${typeToString(target)}; use "as ${target.name}"`, range, 'type');
    }
  }

  /** Infer the type of an expression, reporting errors along the way. */
  infer(e: Expr, scope: Scope): Inferred {
    switch (e.kind) {
      case 'literal':
        return e.type === 'int' ? T.int : e.type === 'float' ? T.float : e.type === 'string' ? T.string : e.type === 'bool' ? T.bool : T.none;
      case 'paren':
        return this.infer(e.expr, scope);
      case 'self':
        return { lower: this.script.lower, name: this.script.name, isArray: false };
      case 'parent': {
        if (!this.script.extends) {
          this.err('Parent can only be used in a script that extends another', e.range, 'parent');
          return null;
        }
        return { lower: this.script.extends.toLowerCase(), name: this.script.extends, isArray: false };
      }
      case 'ident': {
        const v = scope.lookup(e.lower);
        if (v) return v.type;
        const script = this.index.get(e.lower);
        if (script) return { static: true, script };
        if (e.lower === this.script.lower) return { static: true, script: this.script };
        // Properties of an unknown parent could still exist.
        if (this.script.extends && !this.index.chain(this.script.extends).complete) return null;
        if (this.fn?.isGlobal && this.script.properties.some((p) => p.lower === e.lower)) {
          this.err(`"${e.name}" is a property and cannot be used in a global function`, e.range, 'global-property');
          return null;
        }
        this.err(`Variable "${e.name}" is undefined`, e.range, 'undefined');
        return null;
      }
      case 'member': {
        const obj = this.infer(e.object, scope);
        if (!obj) return null;
        if (isStatic(obj)) {
          this.err(`"${e.name}" must be called as a function on ${obj.script.name}`, e.nameRange, 'static-member');
          return null;
        }
        if (obj.isArray || PRIMITIVES.has(obj.lower)) {
          if (e.name) this.err(`${typeToString(obj)} has no member "${e.name}"`, e.nameRange, 'member');
          return null;
        }
        const prop = this.index.findProperty(obj.lower, e.lower);
        if (prop) return typeOf(prop.prop.type);
        if (e.name && this.authoritative(obj.lower)) this.err(`"${e.name}" is not a property of ${obj.name}`, e.nameRange, 'member');
        return null;
      }
      case 'call':
        return this.inferCall(e, scope);
      case 'index': {
        const obj = this.infer(e.object, scope);
        const idx = this.infer(e.index, scope);
        if (idx && !isStatic(idx) && idx.lower !== 'int') this.err('Array index must be an Int', e.index.range, 'type');
        if (!obj || isStatic(obj)) return null;
        if (!obj.isArray) {
          this.err(`${typeToString(obj)} is not an array`, e.object.range, 'type');
          return null;
        }
        return { ...obj, isArray: false };
      }
      case 'length': {
        const obj = this.infer(e.object, scope);
        if (obj && !isStatic(obj) && !obj.isArray) this.err('Length can only be used on arrays', e.range, 'type');
        return T.int;
      }
      case 'cast': {
        this.infer(e.expr, scope);
        return typeOf(e.type);
      }
      case 'new': {
        const size = this.infer(e.size, scope);
        if (e.size.kind !== 'literal' || e.size.type !== 'int') this.err('Array size must be an integer literal in Skyrim Papyrus', e.size.range, 'array-size');
        else if ((e.size.value as number) < 1 || (e.size.value as number) > 128) this.err('Array size must be between 1 and 128', e.size.range, 'array-size');
        void size;
        return typeOf(e.type);
      }
      case 'unary': {
        const t = this.infer(e.operand, scope);
        if (e.op === '!') return T.bool;
        return t;
      }
      case 'binary': {
        const l = this.infer(e.left, scope);
        const r = this.infer(e.right, scope);
        if (['==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(e.op)) return T.bool;
        if (!l || !r || isStatic(l) || isStatic(r)) return null;
        if (e.op === '+' && (l.lower === 'string' || r.lower === 'string')) return T.string;
        if (l.lower === 'float' || r.lower === 'float') return T.float;
        if (l.lower === 'int' && r.lower === 'int') return T.int;
        if (!PRIMITIVES.has(l.lower) || !PRIMITIVES.has(r.lower)) this.err(`Operator ${e.op} cannot be used on ${typeToString(l)} and ${typeToString(r)}`, e.range, 'type');
        return null;
      }
      case 'error':
        return null;
    }
  }

  private inferCall(e: Extract<Expr, { kind: 'call' }>, scope: Scope): Inferred {
    let fn: FunctionDecl | undefined;
    let ownerName: string | undefined;
    let authoritative = false;
    const callee = e.callee;
    if (callee.kind === 'ident') {
      // Own function (any state) or inherited.
      const own = [...this.script.functions, ...this.script.states.flatMap((s) => s.functions)].find((f) => f.lower === callee.lower);
      const inherited = own ? undefined : this.index.findFunction(this.script.extends, callee.lower);
      fn = own ?? inherited?.fn;
      ownerName = own ? this.script.name : inherited?.owner.name;
      authoritative = !this.script.extends || this.authoritative(this.script.extends);
      if (!fn) {
        if (authoritative) this.err(`"${callee.name}" is not a function or does not exist`, callee.range, 'undefined-function');
        e.args.forEach((a) => this.infer(a.value, scope));
        return null;
      }
      if (this.fn?.isGlobal && !fn.isGlobal) this.err(`Cannot call member function "${fn.name}" from a global function`, callee.range, 'global-call');
    } else if (callee.kind === 'member') {
      const obj = this.infer(callee.object, scope);
      if (!obj) {
        e.args.forEach((a) => this.infer(a.value, scope));
        return null;
      }
      if (isStatic(obj)) {
        const found = this.index.findFunction(obj.script.name, callee.lower);
        authoritative = this.authoritative(obj.script.name) || obj.script === this.script;
        if (!found) {
          if (authoritative || this.index.origin(obj.script.name) === 'builtin') {
            if (authoritative) this.err(`"${callee.name}" is not a function on ${obj.script.name}`, callee.nameRange, 'undefined-function');
          }
          e.args.forEach((a) => this.infer(a.value, scope));
          return null;
        }
        if (!found.fn.isGlobal) this.err(`"${found.fn.name}" is not a global function; call it on an instance of ${obj.script.name}`, callee.nameRange, 'not-global');
        fn = found.fn;
        ownerName = found.owner.name;
      } else {
        if (obj.isArray) {
          const arrayFns: Record<string, PType> = { find: T.int, rfind: T.int };
          e.args.forEach((a) => this.infer(a.value, scope));
          if (arrayFns[callee.lower]) return arrayFns[callee.lower]!;
          this.err(`Arrays have no function "${callee.name}"`, callee.nameRange, 'member');
          return null;
        }
        const found = this.index.findFunction(obj.lower, callee.lower);
        authoritative = this.authoritative(obj.lower);
        if (!found) {
          if (authoritative) this.err(`"${callee.name}" is not a function on ${obj.name}`, callee.nameRange, 'undefined-function');
          e.args.forEach((a) => this.infer(a.value, scope));
          return null;
        }
        fn = found.fn;
        ownerName = found.owner.name;
        if (fn.isGlobal) this.warn(`"${fn.name}" is global; call it as ${ownerName}.${fn.name}()`, callee.nameRange, 'global-on-instance');
      }
    } else {
      this.err('This expression cannot be called', callee.range, 'call');
      return null;
    }
    // Arguments.
    const positional = e.args.filter((a) => !a.name);
    if (positional.length > fn.params.length) this.err(`Too many arguments for ${fn.name} (expects ${fn.params.length})`, e.range, 'args');
    const provided = new Set<number>();
    positional.forEach((_, i) => provided.add(i));
    for (const a of e.args) {
      if (!a.name) continue;
      const idx = fn.params.findIndex((p) => p.lower === a.name!.toLowerCase());
      if (idx < 0) this.err(`${fn.name} has no parameter named "${a.name}"`, a.value.range, 'args');
      else provided.add(idx);
    }
    fn.params.forEach((p, i) => {
      if (!p.default && !provided.has(i)) this.err(`Missing argument "${p.name}" for ${fn!.name}`, e.range, 'args');
    });
    e.args.forEach((a, i) => {
      const t = this.infer(a.value, scope);
      const param = a.name ? fn!.params.find((p) => p.lower === a.name!.toLowerCase()) : fn!.params[i];
      if (param && authoritative) this.checkAssignable(typeOf(param.type), t, a.value.range);
    });
    void ownerName;
    return fn.returnType ? typeOf(fn.returnType) : null;
  }
}

export function checkScript(script: Script, index: ScriptIndex): Diagnostic[] {
  return new Checker(script, index).check();
}
