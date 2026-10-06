import type { Range } from './lexer';

export interface TypeRef {
  name: string;
  lower: string;
  isArray: boolean;
  range: Range;
}

export type Expr =
  | { kind: 'literal'; type: 'int' | 'float' | 'string' | 'bool' | 'none'; value: number | string | boolean | null; range: Range }
  | { kind: 'ident'; name: string; lower: string; range: Range }
  | { kind: 'self'; range: Range }
  | { kind: 'parent'; range: Range }
  | { kind: 'member'; object: Expr; name: string; lower: string; nameRange: Range; range: Range }
  | { kind: 'call'; callee: Expr; args: CallArg[]; range: Range }
  | { kind: 'index'; object: Expr; index: Expr; range: Range }
  | { kind: 'unary'; op: '-' | '!'; operand: Expr; range: Range }
  | { kind: 'binary'; op: string; left: Expr; right: Expr; range: Range }
  | { kind: 'cast'; expr: Expr; type: TypeRef; range: Range }
  | { kind: 'new'; type: TypeRef; size: Expr; range: Range }
  | { kind: 'length'; object: Expr; range: Range }
  | { kind: 'paren'; expr: Expr; range: Range }
  | { kind: 'error'; range: Range };

export interface CallArg {
  name?: string;
  value: Expr;
}

export type Stmt =
  | { kind: 'local'; type: TypeRef; name: string; lower: string; init?: Expr; nameRange: Range; range: Range }
  | { kind: 'assign'; op: string; target: Expr; value: Expr; range: Range }
  | { kind: 'expr'; expr: Expr; range: Range }
  | { kind: 'return'; value?: Expr; range: Range }
  | { kind: 'if'; branches: { cond: Expr; body: Stmt[]; range: Range }[]; elseBody?: Stmt[]; range: Range }
  | { kind: 'while'; cond: Expr; body: Stmt[]; range: Range };

export interface Param {
  type: TypeRef;
  name: string;
  lower: string;
  default?: Expr;
  range: Range;
}

export interface FunctionDecl {
  kind: 'function' | 'event';
  name: string;
  lower: string;
  returnType?: TypeRef;
  params: Param[];
  isGlobal: boolean;
  isNative: boolean;
  body?: Stmt[];
  doc?: string;
  /** Owning state name (lower-case), undefined for the empty state. */
  state?: string;
  range: Range;
  nameRange: Range;
}

export interface PropertyDecl {
  name: string;
  lower: string;
  type: TypeRef;
  init?: Expr;
  isAuto: boolean;
  isAutoReadOnly: boolean;
  isHidden: boolean;
  isConditional: boolean;
  getter?: FunctionDecl;
  setter?: FunctionDecl;
  doc?: string;
  range: Range;
  nameRange: Range;
}

export interface VariableDecl {
  name: string;
  lower: string;
  type: TypeRef;
  init?: Expr;
  isConditional: boolean;
  range: Range;
  nameRange: Range;
}

export interface StateDecl {
  name: string;
  lower: string;
  isAuto: boolean;
  functions: FunctionDecl[];
  range: Range;
}

export interface Script {
  name: string;
  lower: string;
  extends?: string;
  isHidden: boolean;
  isConditional: boolean;
  doc?: string;
  imports: string[];
  variables: VariableDecl[];
  properties: PropertyDecl[];
  /** Functions and events of the empty state. */
  functions: FunctionDecl[];
  states: StateDecl[];
  headerRange?: Range;
  nameRange?: Range;
}

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  range: Range;
  code?: string;
}
