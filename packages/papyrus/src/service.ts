/**
 * Editor features for Papyrus: diagnostics, completions, hover, signature help,
 * go-to-definition and outline. Independent of Monaco; the Studio adapts these
 * results to Monaco's providers.
 */
import type { Diagnostic, FunctionDecl, Script, Stmt } from './ast';
import { Checker, Scope, T, typeOf, typeToString, type Inferred, type PType } from './checker';
import { PRIMITIVES, ScriptIndex } from './index-store';
import { KEYWORD_CASING, type Range } from './lexer';
import { parse, parseExpression } from './parser';

export type CompletionKind = 'keyword' | 'function' | 'event' | 'property' | 'variable' | 'type' | 'snippet' | 'parameter';

export interface CompletionItem {
  label: string;
  kind: CompletionKind;
  detail?: string;
  documentation?: string;
  insertText?: string;
  /** Snippet syntax ($1, ${1:name}) in insertText. */
  isSnippet?: boolean;
  sortText?: string;
}

export interface HoverInfo {
  contents: string;
  range: Range;
}

export interface SignatureInfo {
  label: string;
  documentation?: string;
  parameters: { label: string }[];
  activeParameter: number;
}

export interface OutlineSymbol {
  name: string;
  kind: 'script' | 'function' | 'event' | 'property' | 'variable' | 'state';
  detail?: string;
  range: Range;
  children?: OutlineSymbol[];
}

export function signatureOf(fn: FunctionDecl): string {
  const params = fn.params.map((p) => `${p.type.name}${p.type.isArray ? '[]' : ''} ${p.name}${p.default ? ' = …' : ''}`).join(', ');
  const ret = fn.returnType ? `${fn.returnType.name}${fn.returnType.isArray ? '[]' : ''} ` : '';
  const flags = `${fn.isGlobal ? ' Global' : ''}${fn.isNative ? ' Native' : ''}`;
  return `${ret}${fn.kind === 'event' ? 'Event' : 'Function'} ${fn.name}(${params})${flags}`;
}

function contains(r: Range, offset: number): boolean {
  return r.start.offset <= offset && offset <= r.end.offset;
}

function offsetToLineStart(src: string, offset: number): number {
  const i = src.lastIndexOf('\n', offset - 1);
  return i + 1;
}

export class PapyrusLanguageService {
  readonly index: ScriptIndex;

  constructor(index = new ScriptIndex()) {
    this.index = index;
  }

  /** Parse + semantic check. The parsed script is registered in the index. */
  diagnostics(source: string): Diagnostic[] {
    const res = parse(source);
    if (res.script.lower) this.index.addParsed(res.script, 'user');
    const semantic = new Checker(res.script, this.index).check();
    return [...res.diagnostics, ...semantic];
  }

  outline(source: string): OutlineSymbol[] {
    const s = parse(source).script;
    if (!s.name) return [];
    const fnSym = (f: FunctionDecl): OutlineSymbol => ({ name: f.name, kind: f.kind, detail: signatureOf(f), range: f.range });
    const children: OutlineSymbol[] = [
      ...s.properties.map((p) => ({ name: p.name, kind: 'property' as const, detail: typeToString(typeOf(p.type)), range: p.range })),
      ...s.variables.map((v) => ({ name: v.name, kind: 'variable' as const, detail: typeToString(typeOf(v.type)), range: v.range })),
      ...s.functions.map(fnSym),
      ...s.states.map((st) => ({ name: st.name, kind: 'state' as const, detail: st.isAuto ? 'Auto State' : 'State', range: st.range, children: st.functions.map(fnSym) })),
    ];
    return [{ name: s.name, kind: 'script', detail: s.extends ? `extends ${s.extends}` : undefined, range: s.headerRange ?? s.nameRange!, children }];
  }

  // ---------------------------------------------------------------- context

  private functionAt(script: Script, offset: number): FunctionDecl | undefined {
    const all = [
      ...script.functions,
      ...script.states.flatMap((s) => s.functions),
      ...script.properties.flatMap((p) => [p.getter, p.setter].filter((f): f is FunctionDecl => !!f)),
    ];
    return all.find((f) => f.body && contains(f.range, offset));
  }

  /** Scope containing every local visible at `offset`. */
  scopeAt(script: Script, offset: number): { scope: Scope; fn?: FunctionDecl; checker: Checker } {
    const checker = new Checker(script, this.index);
    const fn = this.functionAt(script, offset);
    if (!fn) return { scope: checker.scriptScope(), checker };
    const scope = checker.functionScope(fn);
    const walk = (body: readonly Stmt[], sc: Scope): Scope => {
      for (const st of body) {
        if (st.range.start.offset > offset) break;
        if (st.kind === 'local') sc.define({ name: st.name, type: typeOf(st.type), kind: 'local', range: st.nameRange });
        if (st.kind === 'if' && contains(st.range, offset)) {
          for (const b of st.branches) if (contains(b.range, offset) || b.body.some((x) => contains(x.range, offset))) return walk(b.body, new Scope(sc));
          if (st.elseBody) return walk(st.elseBody, new Scope(sc));
        }
        if (st.kind === 'while' && contains(st.range, offset)) return walk(st.body, new Scope(sc));
      }
      return sc;
    };
    return { scope: walk(fn.body ?? [], scope), fn, checker };
  }

  /** Text of the postfix expression ending right before `end` (e.g. "Game.GetPlayer()"). */
  private expressionBefore(src: string, end: number): string {
    let i = end - 1;
    let depth = 0;
    while (i >= 0) {
      const c = src[i]!;
      if (c === ')' || c === ']') depth++;
      else if (c === '(' || c === '[') {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && !/[A-Za-z0-9_.]/.test(c)) break;
      i--;
    }
    return src.slice(i + 1, end).trim();
  }

  private inferText(text: string, script: Script, offset: number): Inferred {
    const { expr } = parseExpression(text);
    if (!expr) return null;
    const { scope, fn, checker } = this.scopeAt(script, offset);
    checker.fn = fn;
    return checker.infer(expr, scope);
  }

  private membersOf(type: Inferred): CompletionItem[] {
    if (!type) return [];
    const items: CompletionItem[] = [];
    if ('static' in type) {
      for (const s of this.index.chain(type.script.name).scripts) {
        for (const f of s.functions) {
          if (f.isGlobal) items.push(this.fnItem(f, s.name));
        }
      }
      return items;
    }
    if (type.isArray) {
      items.push({ label: 'Length', kind: 'property', detail: 'Int' });
      items.push({ label: 'Find', kind: 'function', detail: 'Int Function Find(value, Int aiStartIndex = 0)', insertText: 'Find(${1})', isSnippet: true });
      items.push({ label: 'RFind', kind: 'function', detail: 'Int Function RFind(value, Int aiStartIndex = -1)', insertText: 'RFind(${1})', isSnippet: true });
      return items;
    }
    if (PRIMITIVES.has(type.lower)) return [];
    const seen = new Set<string>();
    for (const s of this.index.chain(type.lower).scripts) {
      for (const f of s.functions) {
        if (f.isGlobal || f.kind === 'event' || seen.has(f.lower)) continue;
        seen.add(f.lower);
        items.push(this.fnItem(f, s.name));
      }
      for (const p of s.properties) {
        if (seen.has(p.lower)) continue;
        seen.add(p.lower);
        items.push({ label: p.name, kind: 'property', detail: `${typeToString(typeOf(p.type))} (${s.name})`, documentation: p.doc });
      }
    }
    return items;
  }

  private fnItem(f: FunctionDecl, owner: string): CompletionItem {
    const snippetArgs = f.params
      .filter((p) => !p.default)
      .map((p, i) => `\${${i + 1}:${p.name}}`)
      .join(', ');
    return {
      label: f.name,
      kind: f.kind === 'event' ? 'event' : 'function',
      detail: `${signatureOf(f)} — ${owner}`,
      documentation: f.doc,
      insertText: `${f.name}(${snippetArgs})`,
      isSnippet: true,
    };
  }

  complete(source: string, offset: number): CompletionItem[] {
    const res = parse(source);
    const script = res.script;
    const lineStart = offsetToLineStart(source, offset);
    const linePrefix = source.slice(lineStart, offset);
    const wordMatch = /[A-Za-z_][A-Za-z0-9_]*$/.exec(linePrefix);
    const wordStart = offset - (wordMatch ? wordMatch[0].length : 0);

    // Member access: "<expr>.<partial>"
    if (source[wordStart - 1] === '.') {
      const exprText = this.expressionBefore(source, wordStart - 1);
      if (!exprText) return [];
      return this.membersOf(this.inferText(exprText, script, offset));
    }

    const trimmed = linePrefix.trimStart().toLowerCase();
    // "Event On..." at top level: offer events of parent scripts as snippets.
    if (/^event\s+[a-z0-9_]*$/.test(trimmed)) {
      const items: CompletionItem[] = [];
      const seen = new Set<string>();
      for (const s of this.index.chain(script.extends).scripts) {
        for (const f of s.functions) {
          if (f.kind !== 'event' || seen.has(f.lower)) continue;
          seen.add(f.lower);
          const params = f.params.map((p) => `${p.type.name}${p.type.isArray ? '[]' : ''} ${p.name}`).join(', ');
          items.push({
            label: f.name,
            kind: 'event',
            detail: `${signatureOf(f)} — ${s.name}`,
            insertText: `${f.name}(${params})\n\t$0\nEndEvent`,
            isSnippet: true,
          });
        }
      }
      return items;
    }
    // After "extends" or a type position: script names.
    if (/\bextends\s+[a-z0-9_]*$/.test(trimmed) || /^import\s+[a-z0-9_]*$/.test(trimmed)) {
      return this.index.names().map((n) => ({ label: n, kind: 'type' as const }));
    }

    const items: CompletionItem[] = [];
    const { scope, fn } = this.scopeAt(script, offset);
    for (const v of scope.all()) {
      items.push({ label: v.name, kind: v.kind === 'property' ? 'property' : v.kind === 'param' ? 'parameter' : 'variable', detail: typeToString(v.type), sortText: `0${v.name}` });
    }
    if (fn) {
      // Functions callable without a qualifier.
      const seen = new Set<string>();
      for (const f of [...script.functions, ...script.states.flatMap((s) => s.functions)]) {
        if (f.kind === 'event' || seen.has(f.lower)) continue;
        seen.add(f.lower);
        items.push({ ...this.fnItem(f, script.name), sortText: `1${f.name}` });
      }
      for (const s of this.index.chain(script.extends).scripts) {
        for (const f of s.functions) {
          if (f.kind === 'event' || seen.has(f.lower)) continue;
          seen.add(f.lower);
          items.push({ ...this.fnItem(f, s.name), sortText: `2${f.name}` });
        }
      }
      for (const kw of ['If', 'ElseIf', 'Else', 'EndIf', 'While', 'EndWhile', 'Return', 'New', 'As', 'None', 'True', 'False', 'Self', 'Parent']) {
        items.push({ label: kw, kind: 'keyword', sortText: `5${kw}` });
      }
      items.push({ label: 'if … endif', kind: 'snippet', insertText: 'If ${1:condition}\n\t$0\nEndIf', isSnippet: true, sortText: '4if' });
      items.push({ label: 'while … endwhile', kind: 'snippet', insertText: 'While ${1:condition}\n\t$0\nEndWhile', isSnippet: true, sortText: '4while' });
    } else {
      for (const kw of ['Function', 'EndFunction', 'Event', 'EndEvent', 'Property', 'EndProperty', 'Auto', 'AutoReadOnly', 'State', 'EndState', 'Import', 'Hidden', 'Conditional', 'Global', 'Native']) {
        items.push({ label: kw, kind: 'keyword', sortText: `5${kw}` });
      }
      items.push({
        label: 'Property … Auto',
        kind: 'snippet',
        insertText: '${1:Type} Property ${2:Name} Auto',
        isSnippet: true,
        documentation: 'Auto property. Values are filled automatically by the editor when an EditorID matches the name.',
      });
      items.push({ label: 'Function … EndFunction', kind: 'snippet', insertText: 'Function ${1:Name}(${2})\n\t$0\nEndFunction', isSnippet: true });
      items.push({ label: 'Event … EndEvent', kind: 'snippet', insertText: 'Event ${1:OnInit}(${2})\n\t$0\nEndEvent', isSnippet: true });
      items.push({ label: 'State … EndState', kind: 'snippet', insertText: 'State ${1:Name}\n\t$0\nEndState', isSnippet: true });
    }
    for (const n of this.index.names()) items.push({ label: n, kind: 'type', sortText: `3${n}` });
    for (const t of ['Bool', 'Int', 'Float', 'String']) items.push({ label: t, kind: 'type', sortText: `3${t}` });
    return items;
  }

  // ---------------------------------------------------------------- hover / signature / definition

  private wordAt(source: string, offset: number): { word: string; start: number; end: number } | undefined {
    let s = offset;
    let e = offset;
    while (s > 0 && /[A-Za-z0-9_]/.test(source[s - 1]!)) s--;
    while (e < source.length && /[A-Za-z0-9_]/.test(source[e]!)) e++;
    if (s === e) return undefined;
    return { word: source.slice(s, e), start: s, end: e };
  }

  private rangeOf(source: string, start: number, end: number): Range {
    const pos = (o: number) => {
      const before = source.slice(0, o);
      const line = before.split('\n').length - 1;
      return { line, col: o - (before.lastIndexOf('\n') + 1), offset: o };
    };
    return { start: pos(start), end: pos(end) };
  }

  private resolveSymbol(source: string, offset: number): { label: string; doc?: string; def?: { script: string; range: Range }; range: Range } | undefined {
    const w = this.wordAt(source, offset);
    if (!w) return undefined;
    const script = parse(source).script;
    const range = this.rangeOf(source, w.start, w.end);
    const lower = w.word.toLowerCase();
    if (KEYWORD_CASING[lower] && !this.index.has(lower)) return { label: KEYWORD_CASING[lower]!, range };
    if (source[w.start - 1] === '.') {
      const exprText = this.expressionBefore(source, w.start - 1);
      const t = this.inferText(exprText, script, offset);
      if (!t) return undefined;
      const typeName = 'static' in t ? t.script.name : (t as PType).lower;
      if (!('static' in t) && (t as PType).isArray) return lower === 'length' ? { label: 'Int Length', range } : undefined;
      const fn = this.index.findFunction(typeName, lower);
      if (fn) return { label: signatureOf(fn.fn), doc: fn.fn.doc, def: { script: fn.owner.name, range: fn.fn.nameRange }, range };
      const prop = this.index.findProperty(typeName, lower);
      if (prop) return { label: `${typeToString(typeOf(prop.prop.type))} Property ${prop.prop.name}`, doc: prop.prop.doc, def: { script: prop.owner.name, range: prop.prop.nameRange }, range };
      return undefined;
    }
    const { scope } = this.scopeAt(script, offset);
    const v = scope.lookup(lower);
    if (v) return { label: `(${v.kind}) ${typeToString(v.type)} ${v.name}`, def: { script: script.name, range: v.range }, range };
    const own = [...script.functions, ...script.states.flatMap((s) => s.functions)].find((f) => f.lower === lower);
    if (own) return { label: signatureOf(own), doc: own.doc, def: { script: script.name, range: own.nameRange }, range };
    const inherited = this.index.findFunction(script.extends, lower);
    if (inherited) return { label: signatureOf(inherited.fn), doc: inherited.fn.doc, def: { script: inherited.owner.name, range: inherited.fn.nameRange }, range };
    const sc = this.index.get(lower);
    if (sc) return { label: `Scriptname ${sc.name}${sc.extends ? ` extends ${sc.extends}` : ''}`, doc: sc.doc, def: { script: sc.name, range: sc.nameRange ?? range }, range };
    if (PRIMITIVES.has(lower)) return { label: `(type) ${KEYWORD_CASING[lower]}`, range };
    return undefined;
  }

  hover(source: string, offset: number): HoverInfo | undefined {
    const s = this.resolveSymbol(source, offset);
    if (!s) return undefined;
    return { contents: s.doc ? `${s.label}\n\n${s.doc}` : s.label, range: s.range };
  }

  definition(source: string, offset: number): { script: string; range: Range } | undefined {
    return this.resolveSymbol(source, offset)?.def;
  }

  signatureHelp(source: string, offset: number): SignatureInfo | undefined {
    // Find the innermost unclosed "(" on the current statement.
    let depth = 0;
    let commas = 0;
    let i = offset - 1;
    for (; i >= 0; i--) {
      const c = source[i]!;
      if (c === '\n') return undefined;
      if (c === ')') depth++;
      else if (c === '(') {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) commas++;
      else if (c === '"') {
        // skip string backwards
        i--;
        while (i >= 0 && source[i] !== '"' && source[i] !== '\n') i--;
      }
    }
    if (i < 0) return undefined;
    const calleeText = this.expressionBefore(source, i);
    if (!calleeText) return undefined;
    const script = parse(source).script;
    let fn: FunctionDecl | undefined;
    const dot = calleeText.lastIndexOf('.');
    if (dot < 0) {
      const lower = calleeText.toLowerCase();
      fn = [...script.functions, ...script.states.flatMap((s) => s.functions)].find((f) => f.lower === lower) ?? this.index.findFunction(script.extends, lower)?.fn;
    } else {
      const t = this.inferText(calleeText.slice(0, dot), script, offset);
      if (t) {
        const typeName = 'static' in t ? t.script.name : (t as PType).lower;
        fn = this.index.findFunction(typeName, calleeText.slice(dot + 1).toLowerCase())?.fn;
      }
    }
    if (!fn) return undefined;
    return {
      label: signatureOf(fn),
      documentation: fn.doc,
      parameters: fn.params.map((p) => ({ label: `${p.type.name}${p.type.isArray ? '[]' : ''} ${p.name}` })),
      activeParameter: Math.min(commas, Math.max(0, fn.params.length - 1)),
    };
  }
}

export { T };
