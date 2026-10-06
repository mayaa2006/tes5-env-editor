/**
 * The virtual Data folder: what the game actually sees. Combines loose files
 * from one or more roots (game Data, then MO2 mods in priority order, then
 * overwrite) with BSA archives. Loose files always beat archives; among
 * archives, the later-loading one wins.
 */
import { BsaArchive, normalizePath, type ByteSource } from '@tes5/assets';
import { basename, joinPath, walkFiles, type FileSystem } from './fs';
import type { GameRelease } from '@tes5/esp';
import { VANILLA_ARCHIVES } from './game';

export type AssetSource =
  | { kind: 'loose'; root: string; file: string }
  | { kind: 'archive'; archive: string };

export interface AssetEntry {
  /** Normalised path relative to Data, e.g. "meshes\\clutter\\box.nif" (lower-case, backslashes). */
  path: string;
  source: AssetSource;
  /** Other sources this file overrides (lowest first). */
  overridden: AssetSource[];
}

export interface VirtualDataOptions {
  game: GameRelease;
  /** Loose-file roots, lowest priority first. */
  roots: string[];
  /** Active plugins in load order (to order plugin archives). */
  plugins: string[];
  /** Skip indexing loose files under these top-level folders (huge and irrelevant to editing). */
  skipFolders?: string[];
}

export class VirtualData {
  private readonly entries = new Map<string, AssetEntry>();
  private readonly archives = new Map<string, BsaArchive>();
  /** Archive file name → full path. */
  readonly archiveOrder: string[] = [];

  constructor(
    readonly fs: FileSystem,
    readonly options: VirtualDataOptions,
  ) {}

  /** Scan roots and archives. Call again after files change. */
  async build(): Promise<void> {
    this.entries.clear();
    this.archives.clear();
    this.archiveOrder.length = 0;
    const skip = new Set((this.options.skipFolders ?? ['skse', 'calientetools', 'nemesis_engine', 'fnis']).map((s) => s.toLowerCase()));
    const looseByRoot: { root: string; files: string[] }[] = [];
    const archivePaths = new Map<string, string>(); // lower name → full path (highest root wins)
    for (const root of this.options.roots) {
      const files = (await walkFiles(this.fs, root)).filter((f) => !skip.has(f.split('/')[0]!.toLowerCase()));
      looseByRoot.push({ root, files });
      for (const f of files) {
        if (!f.includes('/') && /\.bsa$/i.test(f)) archivePaths.set(f.toLowerCase(), joinPath(root, f));
      }
    }
    // Archive order: vanilla list first, then archives matching active plugins in load order.
    const ordered: string[] = [];
    const take = (lowerName: string) => {
      const p = archivePaths.get(lowerName);
      if (p && !ordered.includes(p)) ordered.push(p);
    };
    for (const a of VANILLA_ARCHIVES[this.options.game]) take(a.toLowerCase());
    for (const plugin of this.options.plugins) {
      const base = plugin.replace(/\.(esm|esp|esl)$/i, '').toLowerCase();
      for (const name of [...archivePaths.keys()].sort()) {
        if (name === `${base}.bsa` || name.startsWith(`${base} - `)) take(name);
      }
    }
    for (const p of ordered) {
      try {
        const archive = this.openArchive(p);
        if (!archive) continue;
        this.archiveOrder.push(p);
        const name = basename(p);
        for (const f of archive.files) this.add(f.path, { kind: 'archive', archive: name });
      } catch {
        // unreadable or non-Skyrim archive: ignore
      }
    }
    for (const { root, files } of looseByRoot) {
      for (const f of files) {
        if (/\.(bsa|esm|esp|esl)$/i.test(f) && !f.includes('/')) continue;
        this.add(normalizePath(f), { kind: 'loose', root, file: f });
      }
    }
  }

  private openArchive(path: string): BsaArchive | undefined {
    const name = basename(path);
    let source: ByteSource;
    if (this.fs.openRandomAccess) {
      const f = this.fs.openRandomAccess(path);
      source = { size: f.size, read: (o, l) => f.read(o, l) };
    } else return undefined;
    const a = new BsaArchive(source, name);
    this.archives.set(name.toLowerCase(), a);
    return a;
  }

  private add(path: string, source: AssetSource): void {
    const existing = this.entries.get(path);
    if (existing) {
      existing.overridden.push(existing.source);
      existing.source = source;
    } else this.entries.set(path, { path, source, overridden: [] });
  }

  get size(): number {
    return this.entries.size;
  }

  has(path: string): boolean {
    return this.entries.has(normalizePath(path));
  }

  entry(path: string): AssetEntry | undefined {
    return this.entries.get(normalizePath(path));
  }

  async read(path: string): Promise<Uint8Array> {
    const e = this.entry(path);
    if (!e) throw new Error(`File not found in Data: ${path}`);
    if (e.source.kind === 'loose') return this.fs.readFile(joinPath(e.source.root, e.source.file));
    const a = this.archives.get(e.source.archive.toLowerCase());
    if (!a) throw new Error(`Archive not open: ${e.source.archive}`);
    return a.read(e.path);
  }

  /** Entries under a folder prefix (e.g. "meshes\\clutter"), optionally filtered by extension. */
  list(prefix = '', ext?: string): AssetEntry[] {
    const p = normalizePath(prefix);
    const out: AssetEntry[] = [];
    for (const e of this.entries.values()) {
      if (p && !e.path.startsWith(p.endsWith('\\') ? p : `${p}\\`) && e.path !== p) continue;
      if (ext && !e.path.endsWith(ext)) continue;
      out.push(e);
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Immediate children (folders and files) of a folder, for tree browsers. */
  children(prefix = ''): { folders: string[]; files: AssetEntry[] } {
    const p = normalizePath(prefix);
    const folders = new Set<string>();
    const files: AssetEntry[] = [];
    const head = p ? `${p}\\` : '';
    for (const e of this.entries.values()) {
      if (!e.path.startsWith(head)) continue;
      const rest = e.path.slice(head.length);
      const i = rest.indexOf('\\');
      if (i >= 0) folders.add(rest.slice(0, i));
      else files.push(e);
    }
    return { folders: [...folders].sort(), files: files.sort((a, b) => a.path.localeCompare(b.path)) };
  }

  /** Forget a generated loose file that was removed (undo), uncovering whatever it overrode. */
  removeLoose(root: string, relPath: string): void {
    const key = normalizePath(relPath);
    const e = this.entries.get(key);
    if (!e || e.source.kind !== 'loose' || e.source.root !== root) return;
    const prev = e.overridden.pop();
    if (prev) e.source = prev;
    else this.entries.delete(key);
  }

  /** Register an in-memory/generated file (e.g. a newly saved script) without rescanning. */
  addLoose(root: string, relPath: string): void {
    this.add(normalizePath(relPath), { kind: 'loose', root, file: relPath.replace(/\\/g, '/') });
  }
}
