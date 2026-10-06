/**
 * Script workspace: finds .psc sources in the virtual Data folder, feeds them
 * to the Papyrus language service on demand, writes sources/fragments, runs
 * the compiler through a host-provided process runner, and binds scripts and
 * property values to records (VMAD) — including automatic property filling.
 */
import { VmadPropertyType, decodeCp1252, isFormKey, newVmad, type FormKey, type Vmad, type VmadProperty, type VmadScript } from '@tes5/esp';
import {
  PROPERTY_TYPE_SIGNATURES,
  PapyrusLanguageService,
  ScriptIndex,
  compileSucceeded,
  compilerCommand,
  generateFragmentSource,
  parse,
  parseCompilerOutput,
  type CompilerKind,
  type CompilerMessage,
  type Diagnostic,
  type FragmentScript,
  type Script,
} from '@tes5/papyrus';
import { normalizePath } from '@tes5/assets';
import { WorkspaceError, type Workspace } from './engine';
import { joinPath } from './fs';

export interface ProcessRunner {
  run(command: string, args: string[], opts?: { cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface CompilerSettings {
  kind: CompilerKind;
  executable: string;
  optimize?: boolean;
  release?: boolean;
}

export interface ScriptInfo {
  name: string;
  /** Path relative to Data. */
  path: string;
  origin: 'mod' | 'base';
}

export interface CompileResult {
  script: string;
  ok: boolean;
  messages: CompilerMessage[];
  output: string;
}

export class ScriptService {
  readonly index = new ScriptIndex();
  readonly language = new PapyrusLanguageService(this.index);
  private sources = new Map<string, ScriptInfo>();
  private loaded = new Map<string, string>();
  runner?: ProcessRunner;
  compiler?: CompilerSettings;

  constructor(readonly ws: Workspace) {}

  /** Folder (relative to Data) new script sources are written to. */
  get sourceFolder(): string {
    return this.ws.game === 'SkyrimSE' ? 'Source/Scripts' : 'Scripts/Source';
  }

  /** Discover all .psc files in the virtual Data folder. */
  refresh(): void {
    this.sources.clear();
    const folders = this.ws.game === 'SkyrimSE' ? ['source\\scripts', 'scripts\\source'] : ['scripts\\source', 'source\\scripts'];
    for (const folder of folders.reverse()) {
      for (const e of this.ws.vfs.list(folder, '.psc')) {
        const file = e.source.kind === 'loose' ? e.source.file : e.path;
        const name = file.slice(Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/')) + 1, -4);
        const origin = e.source.kind === 'loose' && e.source.root === this.ws.options.outputDir ? 'mod' : 'base';
        this.sources.set(name.toLowerCase(), { name, path: e.path, origin });
        if (!this.loaded.has(name.toLowerCase())) this.index.addSource(name, () => this.loaded.get(name.toLowerCase()) ?? '', origin === 'mod' ? 'user' : 'vanilla');
      }
    }
  }

  list(): ScriptInfo[] {
    return [...this.sources.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  has(name: string): boolean {
    return this.sources.has(name.toLowerCase()) || this.loaded.has(name.toLowerCase());
  }

  async read(name: string): Promise<string> {
    const lower = name.toLowerCase();
    const cached = this.loaded.get(lower);
    if (cached !== undefined) return cached;
    const info = this.sources.get(lower);
    if (!info) throw new WorkspaceError(`Script ${name} not found in Data`);
    const text = decodeText(await this.ws.vfs.read(info.path));
    this.loaded.set(lower, text);
    this.index.addSource(info.name, () => text, info.origin === 'mod' ? 'user' : 'vanilla');
    return text;
  }

  /** Load a script and its ancestors so checks/completions can see them. */
  async ensure(names: Iterable<string>): Promise<void> {
    const queue = [...names];
    const seen = new Set<string>();
    while (queue.length) {
      const n = queue.pop()!.toLowerCase();
      if (seen.has(n)) continue;
      seen.add(n);
      if (!this.sources.has(n)) continue;
      const text = await this.read(n);
      const s = parse(text).script;
      if (s.extends) queue.push(s.extends);
    }
  }

  /** Load every script the source mentions (types, casts, static calls) plus ancestors. */
  async prepare(source: string): Promise<Script> {
    const res = parse(source);
    const names = new Set<string>();
    for (const t of res.tokens) if (t.kind === 'ident' && this.sources.has(t.lower)) names.add(t.lower);
    if (res.script.extends) names.add(res.script.extends);
    await this.ensure(names);
    return res.script;
  }

  async check(source: string): Promise<Diagnostic[]> {
    await this.prepare(source);
    return this.language.diagnostics(source);
  }

  async complete(source: string, offset: number) {
    await this.prepare(source);
    return this.language.complete(source, offset);
  }

  async hover(source: string, offset: number) {
    await this.prepare(source);
    return this.language.hover(source, offset);
  }

  async signatureHelp(source: string, offset: number) {
    await this.prepare(source);
    return this.language.signatureHelp(source, offset);
  }

  /** Save a script source into the mod's output folder. */
  async write(name: string, source: string): Promise<string> {
    const rel = `${this.sourceFolder}/${name}.psc`;
    const full = joinPath(this.ws.options.outputDir, rel);
    await this.ws.fs.mkdir(joinPath(this.ws.options.outputDir, this.sourceFolder));
    await this.ws.fs.writeFile(full, new TextEncoder().encode(source.replace(/\r?\n/g, '\r\n')));
    this.ws.vfs.addLoose(this.ws.options.outputDir, rel);
    this.loaded.set(name.toLowerCase(), source);
    this.sources.set(name.toLowerCase(), { name, path: normalizePath(rel), origin: 'mod' });
    this.index.addSource(name, () => source, 'user');
    return full;
  }

  async writeFragment(model: FragmentScript): Promise<string> {
    return this.write(model.scriptName, generateFragmentSource(model));
  }

  /** Compile scripts with the configured compiler. */
  async compile(names: string[]): Promise<CompileResult[]> {
    if (!this.runner || !this.compiler) throw new WorkspaceError('No Papyrus compiler configured. Set the path to PapyrusCompiler.exe (Creation Kit) or Caprica in Settings.');
    const dataDirs = this.ws.options.roots;
    const importDirs: string[] = [joinPath(this.ws.options.outputDir, this.sourceFolder)];
    for (const root of [...dataDirs].reverse()) {
      for (const sub of this.ws.game === 'SkyrimSE' ? ['Source/Scripts', 'Scripts/Source'] : ['Scripts/Source', 'Source/Scripts']) {
        const dir = joinPath(root, sub);
        if ((await this.ws.fs.exists(dir)) && !importDirs.includes(dir)) importDirs.push(dir);
      }
    }
    let flagsFile = '';
    for (const d of importDirs) {
      const f = joinPath(d, 'TESV_Papyrus_Flags.flg');
      if (await this.ws.fs.exists(f)) {
        flagsFile = f;
        break;
      }
    }
    if (!flagsFile) throw new WorkspaceError('TESV_Papyrus_Flags.flg not found. Extract the Creation Kit script sources (Scripts.zip) into Data.');
    const results: CompileResult[] = [];
    const outputDir = joinPath(this.ws.options.outputDir, 'Scripts');
    await this.ws.fs.mkdir(outputDir);
    for (const name of names) {
      const info = this.sources.get(name.toLowerCase());
      const file = info ? (info.origin === 'mod' ? joinPath(this.ws.options.outputDir, info.path.replace(/\\/g, '/')) : `${name}.psc`) : `${name}.psc`;
      const cmd = compilerCommand({ kind: this.compiler.kind, executable: this.compiler.executable, flagsFile, importDirs, outputDir, optimize: this.compiler.optimize, release: this.compiler.release }, [file]);
      const res = await this.runner.run(cmd.command, cmd.args);
      const output = `${res.stdout}\n${res.stderr}`;
      results.push({ script: name, ok: res.code === 0 && compileSucceeded(output), messages: parseCompilerOutput(output), output });
    }
    return results;
  }

  // ---------------------------------------------------------------- record bindings (VMAD)

  scriptsOf(key: FormKey): Vmad {
    const v = this.ws.view(key);
    if (!v) throw new WorkspaceError(`${key} not found`);
    return (v.data.scripts as Vmad | undefined) ?? newVmad();
  }

  /** Attach a script to a record, creating property slots from the source's declarations. */
  async attach(key: FormKey, scriptName: string): Promise<void> {
    const script = this.has(scriptName) ? parse(await this.read(scriptName)).script : undefined;
    const props: VmadProperty[] = [];
    if (script) for (const p of script.properties) if (p.isAuto && !p.isAutoReadOnly) props.push(defaultProperty(p.name, p.type.name, p.type.isArray));
    this.ws.editRecord(
      key,
      (d) => {
        const vm = (d.scripts as Vmad | undefined) ?? newVmad();
        if (vm.scripts.some((s) => s.name.toLowerCase() === scriptName.toLowerCase())) return d;
        vm.scripts.push({ name: script?.name ?? scriptName, flags: 0, properties: props.filter((p) => p.type !== VmadPropertyType.None) });
        d.scripts = vm;
        return d;
      },
      `Attach ${scriptName}`,
    );
  }

  detach(key: FormKey, scriptName: string): void {
    this.ws.editRecord(
      key,
      (d) => {
        const vm = d.scripts as Vmad | undefined;
        if (!vm) return d;
        vm.scripts = vm.scripts.filter((s) => s.name.toLowerCase() !== scriptName.toLowerCase());
        if (!vm.scripts.length && !vm.fragments && !vm.aliases?.length) delete d.scripts;
        return d;
      },
      `Detach ${scriptName}`,
    );
  }

  setProperty(key: FormKey, scriptName: string, prop: VmadProperty): void {
    this.ws.editRecord(
      key,
      (d) => {
        const vm = d.scripts as Vmad | undefined;
        const s = vm?.scripts.find((x) => x.name.toLowerCase() === scriptName.toLowerCase());
        if (!s) throw new WorkspaceError(`${scriptName} is not attached`);
        const i = s.properties.findIndex((p) => p.name.toLowerCase() === prop.name.toLowerCase());
        if (i >= 0) s.properties[i] = prop;
        else s.properties.push(prop);
        return d;
      },
      `Set ${scriptName}.${prop.name}`,
    );
  }

  /**
   * Auto-fill object properties whose names match an EditorID of a form of a
   * compatible type (what the CK's "Auto-Fill" button does, for every script
   * at once). Returns what was filled.
   */
  async autofill(key: FormKey, opts: { overwrite?: boolean } = {}): Promise<{ script: string; property: string; value: FormKey }[]> {
    const vm = this.scriptsOf(key);
    const filled: { script: string; property: string; value: FormKey }[] = [];
    const plan: { script: VmadScript; prop: VmadProperty }[] = [];
    for (const s of vm.scripts) {
      if (!this.has(s.name)) continue;
      const parsed = parse(await this.read(s.name)).script;
      await this.ensure([parsed.extends ?? ''].filter(Boolean));
      const declared = [...parsed.properties, ...this.index.chain(parsed.extends).scripts.flatMap((x) => x.properties)];
      for (const decl of declared) {
        if (!decl.isAuto || PROPERTY_TYPE_SIGNATURES[decl.type.lower] === undefined || decl.type.isArray) continue;
        const existing = s.properties.find((p) => p.name.toLowerCase() === decl.lower);
        const hasValue = existing && existing.type === VmadPropertyType.Object && existing.value && (existing.value as { form: unknown }).form;
        if (hasValue && !opts.overwrite) continue;
        const target = this.findAutofillTarget(decl.name, decl.type.lower);
        if (!target) continue;
        const prop: VmadProperty = { name: decl.name, type: VmadPropertyType.Object, flags: 1, value: { form: target, alias: -1 } };
        plan.push({ script: s, prop });
        filled.push({ script: s.name, property: decl.name, value: target });
      }
    }
    if (plan.length) {
      this.ws.editRecord(
        key,
        (d) => {
          const v = d.scripts as Vmad;
          for (const { script, prop } of plan) {
            const s = v.scripts.find((x) => x.name === script.name)!;
            const i = s.properties.findIndex((p) => p.name.toLowerCase() === prop.name.toLowerCase());
            if (i >= 0) s.properties[i] = prop;
            else s.properties.push(prop);
          }
          return d;
        },
        'Auto-fill properties',
      );
    }
    return filled;
  }

  findAutofillTarget(name: string, typeLower: string): FormKey | undefined {
    const key = this.ws.byEditorId(name);
    if (!key && name.toLowerCase() === 'playerref' && (typeLower === 'actor' || typeLower === 'objectreference')) return '000014:Skyrim.esm';
    if (!key || !isFormKey(key)) return undefined;
    const sigs = PROPERTY_TYPE_SIGNATURES[typeLower];
    const sig = this.ws.summary(key)?.sig;
    if (!sig) return undefined;
    if (sigs && sigs.length && !sigs.includes(sig)) return undefined;
    return key;
  }
}

function defaultProperty(name: string, type: string, isArray: boolean): VmadProperty {
  const t = type.toLowerCase();
  if (isArray) {
    const map: Record<string, VmadPropertyType> = { int: VmadPropertyType.IntArray, float: VmadPropertyType.FloatArray, bool: VmadPropertyType.BoolArray, string: VmadPropertyType.StringArray };
    return { name, type: map[t] ?? VmadPropertyType.ObjectArray, flags: 1, value: [] };
  }
  switch (t) {
    case 'int':
      return { name, type: VmadPropertyType.Int, flags: 1, value: 0 };
    case 'float':
      return { name, type: VmadPropertyType.Float, flags: 1, value: 0 };
    case 'bool':
      return { name, type: VmadPropertyType.Bool, flags: 1, value: false };
    case 'string':
      return { name, type: VmadPropertyType.String, flags: 1, value: '' };
    default:
      return { name, type: VmadPropertyType.Object, flags: 1, value: { form: null, alias: -1 } };
  }
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return decodeCp1252(bytes);
  }
}
