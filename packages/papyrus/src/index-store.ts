import type { FunctionDecl, PropertyDecl, Script, VariableDecl } from './ast';
import { parse } from './parser';
import { STUB_SOURCES } from './stubs';

export const PRIMITIVES = new Set(['bool', 'int', 'float', 'string']);

/**
 * Lazily parsed set of scripts available to the checker (vanilla sources,
 * SKSE sources, the mod's own scripts...). Sources are registered by name and
 * parsed on first use.
 */
export class ScriptIndex {
  private readonly sources = new Map<string, { name: string; load: () => string; origin: string }>();
  private readonly parsed = new Map<string, Script>();

  constructor(opts: { includeStubs?: boolean } = {}) {
    if (opts.includeStubs ?? true) {
      for (const [name, src] of Object.entries(STUB_SOURCES)) this.addSource(name, () => src, 'builtin');
    }
  }

  /** Register (or replace) a script source. `load` is called at most once. */
  addSource(name: string, load: () => string, origin = 'user'): void {
    const lower = name.toLowerCase();
    this.sources.set(lower, { name, load, origin });
    this.parsed.delete(lower);
  }

  /** Register an already-parsed script (e.g. the file being edited). */
  addParsed(script: Script, origin = 'user'): void {
    if (!script.lower) return;
    this.sources.set(script.lower, { name: script.name, load: () => '', origin });
    this.parsed.set(script.lower, script);
  }

  has(name: string): boolean {
    return this.sources.has(name.toLowerCase());
  }

  origin(name: string): string | undefined {
    return this.sources.get(name.toLowerCase())?.origin;
  }

  names(): string[] {
    return [...this.sources.values()].map((s) => s.name);
  }

  get(name: string | undefined): Script | undefined {
    if (!name) return undefined;
    const lower = name.toLowerCase();
    const hit = this.parsed.get(lower);
    if (hit) return hit;
    const src = this.sources.get(lower);
    if (!src) return undefined;
    let text = '';
    try {
      text = src.load();
    } catch {
      return undefined;
    }
    const script = parse(text).script;
    this.parsed.set(lower, script);
    return script;
  }

  /** Script and its ancestors, nearest first. Stops at unknown parents or cycles. */
  chain(name: string | undefined): { scripts: Script[]; complete: boolean } {
    const scripts: Script[] = [];
    const seen = new Set<string>();
    let cur = this.get(name);
    let complete = !!cur;
    while (cur && !seen.has(cur.lower)) {
      seen.add(cur.lower);
      scripts.push(cur);
      if (!cur.extends) break;
      const p = this.get(cur.extends);
      if (!p) {
        complete = false;
        break;
      }
      cur = p;
    }
    return { scripts, complete };
  }

  isSubtype(child: string, ancestor: string): boolean {
    const a = ancestor.toLowerCase();
    return this.chain(child).scripts.some((s) => s.lower === a);
  }

  findFunction(typeName: string | undefined, fnLower: string): { fn: FunctionDecl; owner: Script } | undefined {
    for (const s of this.chain(typeName).scripts) {
      const fn = s.functions.find((f) => f.lower === fnLower);
      if (fn) return { fn, owner: s };
    }
    return undefined;
  }

  findProperty(typeName: string | undefined, lower: string): { prop: PropertyDecl; owner: Script } | undefined {
    for (const s of this.chain(typeName).scripts) {
      const prop = s.properties.find((p) => p.lower === lower);
      if (prop) return { prop, owner: s };
    }
    return undefined;
  }

  findVariable(script: Script, lower: string): VariableDecl | undefined {
    return script.variables.find((v) => v.lower === lower);
  }
}
