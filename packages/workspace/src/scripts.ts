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
import { unzipSync } from 'fflate';
import { dirname, joinPath } from './fs';

export interface ProcessRunner {
  run(command: string, args: string[], opts?: { cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Start a program without waiting for it (used to launch the game). */
  launch?(command: string, args: string[], opts?: { cwd?: string }): Promise<void>;
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
  /** The compiler chosen in the settings; when unset, findCompiler() picks one. */
  compiler?: CompilerSettings;
  /** Caprica.exe shipped with the app (the desktop app sets this). */
  bundledCaprica?: string;

  constructor(readonly ws: Workspace) {
    // Undo/redo of edits that generated scripts restores their sources.
    ws.on((e) => {
      if (e.type !== 'filesRestored') return;
      for (const f of e.files) {
        const m = /([^\\/]+)\.psc$/i.exec(f.path);
        if (!m) continue;
        const name = m[1]!;
        if (f.data) {
          const text = new TextDecoder().decode(f.data).replace(/\r\n/g, '\n');
          this.loaded.set(name.toLowerCase(), text);
          this.sources.set(name.toLowerCase(), { name, path: normalizePath(`${this.sourceFolder}/${name}.psc`), origin: 'mod' });
          this.index.addSource(name, () => text, 'user');
        } else {
          this.loaded.delete(name.toLowerCase());
          this.sources.delete(name.toLowerCase());
        }
      }
    });
  }

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
  /**
   * Write a script source into the output folder. `undoable` ties the write
   * to the next undo step (used for generated scripts that go with an edit).
   */
  async write(name: string, source: string, opts: { undoable?: boolean } = {}): Promise<string> {
    const rel = `${this.sourceFolder}/${name}.psc`;
    const full = joinPath(this.ws.options.outputDir, rel);
    await this.ws.fs.mkdir(joinPath(this.ws.options.outputDir, this.sourceFolder));
    const bytes = new TextEncoder().encode(source.replace(/\r?\n/g, '\r\n'));
    if (opts.undoable) {
      const before = (await this.ws.fs.exists(full)) ? await this.ws.fs.readFile(full) : null;
      this.ws.trackFileChange({ path: full, before, after: bytes });
    }
    await this.ws.fs.writeFile(full, bytes);
    this.ws.vfs.addLoose(this.ws.options.outputDir, rel);
    this.loaded.set(name.toLowerCase(), source);
    this.sources.set(name.toLowerCase(), { name, path: normalizePath(rel), origin: 'mod' });
    this.index.addSource(name, () => source, 'user');
    return full;
  }

  async writeFragment(model: FragmentScript): Promise<string> {
    return this.write(model.scriptName, generateFragmentSource(model), { undoable: true });
  }

  /** Folders the compiler imports from: your sources first, then each Data folder's. */
  private async importDirs(): Promise<string[]> {
    const dirs: string[] = [joinPath(this.ws.options.outputDir, this.sourceFolder)];
    for (const root of [...this.ws.options.roots].reverse()) {
      for (const sub of this.ws.game === 'SkyrimSE' ? ['Source/Scripts', 'Scripts/Source'] : ['Scripts/Source', 'Source/Scripts']) {
        const dir = joinPath(root, sub);
        if ((await this.ws.fs.exists(dir)) && !dirs.includes(dir)) dirs.push(dir);
      }
    }
    return dirs;
  }

  /** The game's flags file (TESV_Papyrus_Flags.flg), found once the game's script sources are unpacked. */
  private async flagsFile(dirs?: string[]): Promise<string> {
    for (const d of dirs ?? (await this.importDirs())) {
      const f = joinPath(d, 'TESV_Papyrus_Flags.flg');
      if (await this.ws.fs.exists(f)) return f;
    }
    return '';
  }

  /**
   * A compiler to use when none is chosen: Caprica (free, open source) that
   * comes with the app, else the Creation Kit's PapyrusCompiler.exe where the
   * CK installs it ("Papyrus Compiler" in the game folder, next to Data).
   */
  async findCompiler(): Promise<CompilerSettings | null> {
    if (this.bundledCaprica && (await this.ws.fs.exists(this.bundledCaprica))) return { kind: 'caprica', executable: this.bundledCaprica };
    for (const root of this.ws.options.roots) {
      for (const dir of [dirname(root), root]) {
        const exe = joinPath(dir, 'Papyrus Compiler', 'PapyrusCompiler.exe');
        if (await this.ws.fs.exists(exe)) return { kind: 'papyrus-compiler', executable: exe };
      }
    }
    return null;
  }

  /** The compiler compile() will use: the one chosen in the settings, else the one found. */
  async activeCompiler(): Promise<CompilerSettings | null> {
    return this.compiler ?? (await this.findCompiler());
  }

  /**
   * Whether the game's own script sources (needed to compile anything) are
   * there, and if not, the Scripts.zip the Creation Kit put in Data.
   */
  async sourcesState(): Promise<{ ready: boolean; zip: string | null }> {
    if (await this.flagsFile()) return { ready: true, zip: null };
    for (const root of this.ws.options.roots) {
      const zip = joinPath(root, 'Scripts.zip');
      if (await this.ws.fs.exists(zip)) return { ready: false, zip };
    }
    return { ready: false, zip: null };
  }

  /**
   * Unpack the Creation Kit's Scripts.zip next to it (what "extract here"
   * does), so scripts can be compiled. Files already there are kept.
   * Returns how many files were written.
   */
  async unpackSources(): Promise<number> {
    const { zip } = await this.sourcesState();
    if (!zip) throw new WorkspaceError("Scripts.zip wasn't found in Data. Install the Creation Kit (it puts Scripts.zip there), or unpack the script sources yourself.");
    const root = dirname(zip);
    const files = unzipSync(await this.ws.fs.readFile(zip));
    let written = 0;
    for (const [name, data] of Object.entries(files)) {
      if (name.endsWith('/') || !/\.(psc|flg)$/i.test(name)) continue;
      // Entries are "Source/Scripts/…"; loose ones go into the source folder.
      const rel = /^(source|scripts)[\\/]/i.test(name) ? name.replace(/\\/g, '/') : `${this.sourceFolder}/${name.replace(/^.*[\\/]/, '')}`;
      const full = joinPath(root, rel);
      if (await this.ws.fs.exists(full)) continue;
      await this.ws.fs.mkdir(dirname(full));
      await this.ws.fs.writeFile(full, data);
      this.ws.vfs.addLoose(root, rel);
      written++;
    }
    this.refresh();
    return written;
  }

  /** Is this one of your mod's scripts (its source is in your mod), rather than the game's or another mod's? */
  isOwn(name: string): boolean {
    return this.sources.get(name.toLowerCase())?.origin === 'mod';
  }

  /** Where one of your scripts' source is on disk, by its real name (the index keeps paths in lower case). */
  private async ownSourcePath(info: ScriptInfo): Promise<string> {
    const named = joinPath(this.ws.options.outputDir, this.sourceFolder, `${info.name}.psc`);
    return (await this.ws.fs.exists(named)) ? named : joinPath(this.ws.options.outputDir, info.path.replace(/\\/g, '/'));
  }

  /** Your scripts whose compiled .pex is missing or older than the source. */
  async outOfDate(): Promise<string[]> {
    const out: string[] = [];
    for (const info of this.sources.values()) {
      if (info.origin !== 'mod') continue;
      const src = await this.ws.fs.stat(await this.ownSourcePath(info));
      const pex = await this.ws.fs.stat(joinPath(this.ws.options.outputDir, 'Scripts', `${info.name}.pex`));
      if (!pex || (src && src.mtimeMs > pex.mtimeMs)) out.push(info.name);
    }
    return out.sort((a, b) => a.localeCompare(b));
  }

  /** Compile every one of your scripts that needs it (see outOfDate). */
  async compileOutOfDate(): Promise<CompileResult[]> {
    const names = await this.outOfDate();
    return names.length ? this.compile(names) : [];
  }

  /**
   * Compile scripts. Caprica does them all in one run (falling back to one at
   * a time if a failure stopped the others); PapyrusCompiler.exe one by one.
   * Each new .pex counts as part of the mod.
   */
  async compile(names: string[]): Promise<CompileResult[]> {
    const compiler = await this.activeCompiler();
    if (!this.runner) throw new WorkspaceError("Scripts can't be compiled in the demo: its files only exist in memory. Open your Skyrim folder to compile. Errors are still checked as you type.");
    if (!compiler) throw new WorkspaceError('No Papyrus compiler found. Choose Caprica.exe or the Creation Kit\'s PapyrusCompiler.exe under Compiler in the Scripts tab.');
    if (!names.length) return [];
    const importDirs = await this.importDirs();
    const flagsFile = await this.flagsFile(importDirs);
    if (!flagsFile) throw new WorkspaceError("The game's script sources aren't unpacked yet (TESV_Papyrus_Flags.flg is missing). Use \"Unpack the game's script sources\" in the Scripts tab, or extract the Creation Kit's Scripts.zip into Data.");
    const outputDir = joinPath(this.ws.options.outputDir, 'Scripts');
    await this.ws.fs.mkdir(outputDir);
    const config = { kind: compiler.kind, executable: compiler.executable, flagsFile, importDirs, outputDir, optimize: compiler.optimize, release: compiler.release };
    const files = new Map<string, string>();
    for (const name of names) {
      const info = this.sources.get(name.toLowerCase());
      // Your own sources by path; the compiler finds the game's by name in the import folders.
      files.set(name, info?.origin === 'mod' ? await this.ownSourcePath(info) : `${name}.psc`);
    }
    const fileOf = (name: string) => files.get(name)!;
    const pexTime = async (name: string) => (await this.ws.fs.stat(joinPath(outputDir, `${name}.pex`)))?.mtimeMs ?? null;
    const run = async (batch: string[]): Promise<Map<string, CompileResult>> => {
      const before = new Map<string, number | null>();
      for (const n of batch) before.set(n, await pexTime(n));
      const cmd = compilerCommand(config, batch.map(fileOf));
      const res = await this.runner!.run(cmd.command, cmd.args);
      const output = `${res.stdout}\n${res.stderr}`.trim();
      const messages = parseCompilerOutput(output);
      const out = new Map<string, CompileResult>();
      for (const name of batch) {
        const own = batch.length === 1 ? messages : messages.filter((m) => !m.file || m.file.replace(/^.*[\\/]/, '').toLowerCase() === `${name.toLowerCase()}.psc`);
        const after = await pexTime(name);
        const fresh = after !== null && after !== before.get(name);
        const ok = fresh && !own.some((m) => m.severity === 'error') && (batch.length > 1 || (res.code === 0 && compileSucceeded(output)));
        out.set(name, { script: name, ok, messages: own, output });
      }
      return out;
    };
    let results: Map<string, CompileResult>;
    if (compiler.kind === 'caprica') {
      results = await run(names);
      // A script with no error of its own that still got no .pex was stopped by another's failure: try it alone.
      if (names.length > 1)
        for (const name of names) {
          const r = results.get(name)!;
          if (!r.ok && !r.messages.some((m) => m.file && m.severity === 'error')) results.set(name, (await run([name])).get(name)!);
        }
    } else {
      results = new Map();
      for (const name of names) results.set(name, (await run([name])).get(name)!);
    }
    for (const r of results.values()) if (r.ok) this.ws.vfs.addLoose(this.ws.options.outputDir, `Scripts/${r.script}.pex`);
    return names.map((n) => results.get(n)!);
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

  /**
   * Auto properties a form's scripts declare but never set (they'll be None in
   * game). `canAutofill` says whether Auto-fill would find a value.
   */
  async emptyProperties(key: FormKey): Promise<{ script: string; property: string; type: string; canAutofill: boolean }[]> {
    const out: { script: string; property: string; type: string; canAutofill: boolean }[] = [];
    for (const s of this.scriptsOf(key).scripts) {
      if (!this.has(s.name)) continue;
      const parsed = parse(await this.read(s.name)).script;
      await this.ensure([parsed.extends ?? ''].filter(Boolean));
      const declared = [...parsed.properties, ...this.index.chain(parsed.extends).scripts.flatMap((x) => x.properties)];
      for (const decl of declared) {
        if (!decl.isAuto || decl.isAutoReadOnly || decl.init || PROPERTY_TYPE_SIGNATURES[decl.type.lower] === undefined || decl.type.isArray) continue;
        const p = s.properties.find((x) => x.name.toLowerCase() === decl.lower);
        const set = p && (p.type !== VmadPropertyType.Object || (p.value && (p.value as { form?: unknown }).form));
        if (set) continue;
        out.push({ script: s.name, property: decl.name, type: decl.type.name, canAutofill: !!this.findAutofillTarget(decl.name, decl.type.lower) });
      }
    }
    return out;
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
