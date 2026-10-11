/**
 * Papyrus compiler integration. The actual process is spawned by the host
 * (Electron main / CLI); this module decides *how*: which compiler, which
 * import folders in which order, where the flags file is, and how to read the
 * output. Most "my script won't compile in the CK" problems are wrong import
 * folders (Skyrim SE moved sources from Scripts/Source to Source/Scripts), so
 * this is detected automatically.
 */

export type CompilerKind = 'papyrus-compiler' | 'caprica';

export interface CompilerConfig {
  kind: CompilerKind;
  /** Path to PapyrusCompiler.exe or Caprica.exe. */
  executable: string;
  /** TESV_Papyrus_Flags.flg */
  flagsFile: string;
  /** Import folders, highest priority first. */
  importDirs: string[];
  /** Where .pex files go (normally Data/Scripts). */
  outputDir: string;
  optimize?: boolean;
  /** Strip debug info (-release). */
  release?: boolean;
  /** Extra arguments appended verbatim. */
  extraArgs?: string[];
}

/** Minimal file-system queries needed for detection (works with any FS backend). */
export interface PathProbe {
  exists(path: string): boolean;
  join(...parts: string[]): string;
}

export interface ScriptLayout {
  /** Folder where this mod's .psc files should be saved. */
  sourceDir: string;
  /** Folders to import, in priority order. */
  importDirs: string[];
  flagsFile?: string;
  outputDir: string;
  /** Human readable notes about what was found. */
  notes: string[];
}

/**
 * Work out script folders for a Data directory.
 * SSE/AE: Data/Source/Scripts. LE: Data/Scripts/Source. Mods (and SKSE) may use either.
 */
export function detectScriptLayout(probe: PathProbe, dataDir: string, game: 'SkyrimSE' | 'SkyrimLE' = 'SkyrimSE', extraImports: string[] = []): ScriptLayout {
  const se = probe.join(dataDir, 'Source', 'Scripts');
  const le = probe.join(dataDir, 'Scripts', 'Source');
  const notes: string[] = [];
  const hasSe = probe.exists(se);
  const hasLe = probe.exists(le);
  const preferred = game === 'SkyrimSE' ? se : le;
  const other = game === 'SkyrimSE' ? le : se;
  const importDirs = [...extraImports];
  if (probe.exists(preferred)) importDirs.push(preferred);
  if (probe.exists(other)) {
    importDirs.push(other);
    notes.push(`Also importing ${other} (some mods and SKSE install sources there).`);
  }
  if (!hasSe && !hasLe) notes.push('No script sources found. Extract Scripts.zip (Creation Kit) into Data to enable vanilla script checking.');
  let flagsFile: string | undefined;
  for (const d of [preferred, other]) {
    const f = probe.join(d, 'TESV_Papyrus_Flags.flg');
    if (probe.exists(f)) {
      flagsFile = f;
      break;
    }
  }
  if (!flagsFile) notes.push('TESV_Papyrus_Flags.flg not found; it ships with the vanilla script sources.');
  return { sourceDir: preferred, importDirs, flagsFile, outputDir: probe.join(dataDir, 'Scripts'), notes };
}

export function compilerCommand(config: CompilerConfig, files: readonly string[]): { command: string; args: string[] } {
  const imports = config.importDirs.join(';');
  if (config.kind === 'caprica') {
    // Caprica takes many files in one run. --ignorecwd: don't also import the
    // folder the app happens to run from. (--optimize is Fallout 4 only.)
    const args = ['--game', 'skyrim', '--ignorecwd', '--import', imports, '--output', config.outputDir, '--flags', config.flagsFile];
    if (config.release) args.push('--release');
    args.push(...(config.extraArgs ?? []), ...files);
    return { command: config.executable, args };
  }
  // PapyrusCompiler.exe <file|folder> -f=<flags> -i=<imports> -o=<output> [-op] [-r] [-q]
  if (files.length !== 1) {
    throw new Error('PapyrusCompiler.exe compiles one file (or folder with -all) per run; call once per file');
  }
  const args = [files[0]!, `-f=${config.flagsFile}`, `-i=${imports}`, `-o=${config.outputDir}`];
  if (config.optimize) args.push('-op');
  if (config.release) args.push('-r');
  args.push(...(config.extraArgs ?? []));
  return { command: config.executable, args };
}

export interface CompilerMessage {
  file?: string;
  line?: number;
  col?: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

/**
 * Parse compiler output. PapyrusCompiler.exe prints `path(line,col): message`;
 * Caprica prints `path (line, col:endCol): Error: message` (or `Warning W1000:`)
 * and `Compilation of 'path' failed; …`.
 */
export function parseCompilerOutput(output: string): CompilerMessage[] {
  const out: CompilerMessage[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let m = /^(.*?\.psc)\((\d+),(\d+)\):\s*(.*)$/i.exec(line);
    if (m) {
      const msg = m[4]!;
      out.push({ file: m[1], line: Number(m[2]), col: Number(m[3]), severity: /warning/i.test(msg) ? 'warning' : 'error', message: msg.replace(/^(error|warning):\s*/i, '') });
      continue;
    }
    m = /^(.*?\.psc)\s*\((\d+)[,:]\s*(\d+)(?::\d+)?\):\s*(Fatal Error|Error|Warning|Info)[^:]*:\s*(.*)$/i.exec(line);
    if (m) {
      const sev = m[4]!.toLowerCase();
      out.push({ file: m[1], line: Number(m[2]), col: Number(m[3]), severity: sev === 'warning' ? 'warning' : sev === 'info' ? 'info' : 'error', message: m[5]! });
      continue;
    }
    m = /^Compilation of '(.*?)' failed/i.exec(line);
    if (m) {
      out.push({ file: m[1], severity: 'error', message: line });
      continue;
    }
    if (/^(Fatal Error|Error):/i.test(line) || /^Unable to (locate|find)|^Import failed/i.test(line)) {
      out.push({ severity: 'error', message: line.replace(/^(Fatal Error|Error):\s*/i, '') });
      continue;
    }
    if (/No output generated|compilation failed/i.test(line)) out.push({ severity: 'error', message: line });
  }
  return out;
}

/** True when the compiler output says every file succeeded. */
export function compileSucceeded(output: string): boolean {
  return !parseCompilerOutput(output).some((m) => m.severity === 'error');
}
