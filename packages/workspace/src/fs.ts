/**
 * File-system abstraction so the engine runs in Node (Electron main / CLI),
 * in tests, and in the browser demo with an in-memory file system.
 * Paths always use forward slashes internally.
 */

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface FileStat {
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
}

/** Random access to a large file (archives) without reading it whole. */
export interface RandomAccessFile {
  readonly size: number;
  read(offset: number, length: number): Uint8Array;
  close(): void;
}

export interface FileSystem {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat | undefined>;
  readdir(path: string): Promise<DirEntry[]>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Optional: synchronous random access (used for BSA archives). */
  openRandomAccess?(path: string): RandomAccessFile;
}

export function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

export function joinPath(...parts: string[]): string {
  const filtered = parts.filter((p) => p !== '');
  if (!filtered.length) return '';
  const joined = filtered.map((p, i) => (i === 0 ? normalizeSlashes(p).replace(/\/+$/, '') : normalizeSlashes(p).replace(/^\/+|\/+$/g, ''))).join('/');
  return joined || '/';
}

export function dirname(p: string): string {
  const n = normalizeSlashes(p).replace(/\/+$/, '');
  const i = n.lastIndexOf('/');
  return i <= 0 ? (i === 0 ? '/' : '') : n.slice(0, i);
}

export function basename(p: string): string {
  const n = normalizeSlashes(p).replace(/\/+$/, '');
  return n.slice(n.lastIndexOf('/') + 1);
}

export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i).toLowerCase();
}

/** Recursively list files under `root` (relative paths, forward slashes). */
export async function walkFiles(fs: FileSystem, root: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  let entries: DirEntry[];
  try {
    entries = await fs.readdir(prefix ? joinPath(root, prefix) : root);
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory) out.push(...(await walkFiles(fs, root, rel)));
    else out.push(rel);
  }
  return out;
}

/** Case-insensitive lookup of an existing child name (Windows game folders are case-insensitive). */
export async function findChild(fs: FileSystem, dir: string, name: string): Promise<string | undefined> {
  try {
    const lower = name.toLowerCase();
    const hit = (await fs.readdir(dir)).find((e) => e.name.toLowerCase() === lower);
    return hit ? joinPath(dir, hit.name) : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ memory implementation

interface MemNode {
  dir: boolean;
  data?: Uint8Array;
  mtimeMs: number;
  children?: Map<string, MemNode>;
}

/** Case-insensitive in-memory file system (like NTFS) for tests and the browser demo. */
export class MemoryFileSystem implements FileSystem {
  private root: MemNode = { dir: true, mtimeMs: Date.now(), children: new Map() };

  private parts(p: string): string[] {
    return normalizeSlashes(p).split('/').filter((x) => x && x !== '.');
  }

  private node(p: string, create: 'dir' | 'file' | false = false): MemNode | undefined {
    let cur = this.root;
    const parts = this.parts(p);
    for (let i = 0; i < parts.length; i++) {
      const key = parts[i]!.toLowerCase();
      let next = cur.children?.get(key);
      if (!next) {
        if (!create) return undefined;
        const isLast = i === parts.length - 1;
        next = isLast && create === 'file' ? { dir: false, mtimeMs: Date.now(), data: new Uint8Array(0) } : { dir: true, mtimeMs: Date.now(), children: new Map() };
        (next as MemNode & { name?: string }).name = parts[i]!;
        cur.children!.set(key, next);
      }
      cur = next;
    }
    return cur;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const n = this.node(path);
    if (!n || n.dir) throw new Error(`ENOENT: ${path}`);
    return n.data!;
  }

  readFileSync(path: string): Uint8Array {
    const n = this.node(path);
    if (!n || n.dir) throw new Error(`ENOENT: ${path}`);
    return n.data!;
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    this.writeFileSync(path, data);
  }

  writeFileSync(path: string, data: Uint8Array | string): void {
    const n = this.node(path, 'file')!;
    if (n.dir) throw new Error(`EISDIR: ${path}`);
    n.data = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    n.mtimeMs = Date.now();
  }

  async exists(path: string): Promise<boolean> {
    return !!this.node(path);
  }

  existsSync(path: string): boolean {
    return !!this.node(path);
  }

  async stat(path: string): Promise<FileStat | undefined> {
    const n = this.node(path);
    if (!n) return undefined;
    return { size: n.data?.byteLength ?? 0, mtimeMs: n.mtimeMs, isDirectory: n.dir };
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const n = this.node(path);
    if (!n || !n.dir) throw new Error(`ENOTDIR: ${path}`);
    return [...n.children!.values()].map((c) => ({ name: (c as MemNode & { name?: string }).name ?? '', isDirectory: c.dir }));
  }

  async mkdir(path: string): Promise<void> {
    this.node(path, 'dir');
  }

  async remove(path: string): Promise<void> {
    const parts = this.parts(path);
    const parent = this.node(parts.slice(0, -1).join('/'));
    parent?.children?.delete(parts[parts.length - 1]!.toLowerCase());
  }

  async rename(from: string, to: string): Promise<void> {
    const data = await this.readFile(from);
    await this.writeFile(to, data);
    await this.remove(from);
  }

  openRandomAccess(path: string): RandomAccessFile {
    const data = this.readFileSync(path);
    return { size: data.byteLength, read: (o, l) => data.subarray(o, o + l), close: () => {} };
  }
}
