/**
 * Bethesda archives (BSA) for Skyrim LE (v104, zlib) and SE (v105, LZ4).
 * Reading is random-access through a small byte-source interface so large
 * archives never need to be loaded whole; writing builds a complete archive.
 */
import { unzlibSync, zlibSync } from 'fflate';
import { compressFrame, decompressFrame } from './lz4';

export const ArchiveFlags = {
  DirectoryNames: 0x1,
  FileNames: 0x2,
  Compressed: 0x4,
  RetainDirectoryNames: 0x8,
  RetainFileNames: 0x10,
  RetainFileNameOffsets: 0x20,
  Xbox360: 0x40,
  RetainStringsDuringStartup: 0x80,
  EmbedFileNames: 0x100,
  XMemCodec: 0x200,
} as const;

export const FileTypeFlags = {
  Meshes: 0x1,
  Textures: 0x2,
  Menus: 0x4,
  Sounds: 0x8,
  Voices: 0x10,
  Shaders: 0x20,
  Trees: 0x40,
  Fonts: 0x80,
  Misc: 0x100,
} as const;

const COMPRESSION_TOGGLE = 0x40000000;
/** Largest single file we will extract (1 GiB). */
const MAX_FILE_SIZE = 1 << 30;

/** Random-access byte source (a Uint8Array, or a file handle in Node). */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Uint8Array;
}

export function bufferSource(buf: Uint8Array): ByteSource {
  return { size: buf.byteLength, read: (o, l) => buf.subarray(o, o + l) };
}

export interface BsaFileEntry {
  /** Normalised path: lower-case with backslashes, e.g. meshes\clutter\box.nif */
  path: string;
  folder: string;
  name: string;
  hash: bigint;
  /** Size as stored (including embedded name and size prefix when compressed). */
  storedSize: number;
  offset: number;
  compressed: boolean;
}

export function normalizePath(p: string): string {
  return p.replace(/\//g, '\\').replace(/^\\+/, '').toLowerCase();
}

/** TES4-style BSA name hash used by Skyrim archives. */
export function bsaHash(name: string, isFolder: boolean): bigint {
  const lower = normalizePath(name);
  let root = lower;
  let ext = '';
  if (!isFolder) {
    const dot = lower.lastIndexOf('.');
    if (dot >= 0) {
      root = lower.slice(0, dot);
      ext = lower.slice(dot);
    }
  }
  const len = root.length;
  const c = (i: number) => (i >= 0 && i < len ? root.charCodeAt(i) : 0);
  let h1 = (c(len - 1) | (len > 2 ? c(len - 2) << 8 : 0) | (len << 16) | (c(0) << 24)) >>> 0;
  if (!isFolder) {
    if (ext === '.kf') h1 = (h1 | 0x80) >>> 0;
    else if (ext === '.nif') h1 = (h1 | 0x8000) >>> 0;
    else if (ext === '.dds') h1 = (h1 | 0x8080) >>> 0;
    else if (ext === '.wav') h1 = (h1 | 0x80000000) >>> 0;
  }
  let h2 = 0;
  for (let i = 1; i < len - 2; i++) h2 = (Math.imul(h2, 0x1003f) + root.charCodeAt(i)) >>> 0;
  let h3 = 0;
  for (let i = 0; i < ext.length; i++) h3 = (Math.imul(h3, 0x1003f) + ext.charCodeAt(i)) >>> 0;
  const hi = (h2 + h3) >>> 0;
  return (BigInt(hi) << 32n) | BigInt(h1);
}

function readU32(b: Uint8Array, o: number): number {
  return new DataView(b.buffer, b.byteOffset + o, 4).getUint32(0, true);
}

function readU64(b: Uint8Array, o: number): bigint {
  return new DataView(b.buffer, b.byteOffset + o, 8).getBigUint64(0, true);
}

function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.byteLength; i++) s += String.fromCharCode(b[i]!);
  return s;
}

export class BsaArchive {
  readonly version: number;
  readonly archiveFlags: number;
  readonly fileFlags: number;
  readonly files: BsaFileEntry[] = [];
  private readonly byPath = new Map<string, BsaFileEntry>();

  constructor(
    readonly source: ByteSource,
    readonly name = 'archive.bsa',
  ) {
    const h = source.read(0, 36);
    if (latin1(h.subarray(0, 4)) !== 'BSA\0') throw new Error(`${name}: not a BSA archive`);
    this.version = readU32(h, 4);
    if (this.version !== 104 && this.version !== 105) throw new Error(`${name}: unsupported BSA version ${this.version} (Skyrim uses 104/105)`);
    const folderOffset = readU32(h, 8);
    this.archiveFlags = readU32(h, 12);
    const folderCount = readU32(h, 16);
    const fileCount = readU32(h, 20);
    const totalFolderNameLength = readU32(h, 24);
    const totalFileNameLength = readU32(h, 28);
    this.fileFlags = new DataView(h.buffer, h.byteOffset + 32, 2).getUint16(0, true);

    const folderRecSize = this.version === 105 ? 24 : 16;
    const folderRecs = source.read(folderOffset, folderCount * folderRecSize);
    const hasDirNames = (this.archiveFlags & ArchiveFlags.DirectoryNames) !== 0;
    const fileRecordsStart = folderOffset + folderCount * folderRecSize;
    const fileRecordsSize = (hasDirNames ? totalFolderNameLength + folderCount : 0) + fileCount * 16;
    const fileRecs = source.read(fileRecordsStart, fileRecordsSize);
    const names: string[] = [];
    if (this.archiveFlags & ArchiveFlags.FileNames) {
      const nameBlock = source.read(fileRecordsStart + fileRecordsSize, totalFileNameLength);
      let start = 0;
      for (let i = 0; i < nameBlock.byteLength; i++) {
        if (nameBlock[i] === 0) {
          names.push(latin1(nameBlock.subarray(start, i)));
          start = i + 1;
        }
      }
    }
    const defaultCompressed = (this.archiveFlags & ArchiveFlags.Compressed) !== 0;
    let p = 0;
    let fileIndex = 0;
    for (let f = 0; f < folderCount; f++) {
      const count = readU32(folderRecs, f * folderRecSize + 8);
      let folder = '';
      if (hasDirNames) {
        const len = fileRecs[p]!;
        folder = latin1(fileRecs.subarray(p + 1, p + len)).replace(/\0+$/, '');
        p += 1 + len;
      }
      for (let i = 0; i < count; i++) {
        const hash = readU64(fileRecs, p);
        const rawSize = readU32(fileRecs, p + 8);
        const offset = readU32(fileRecs, p + 12);
        p += 16;
        const name = names[fileIndex] ?? `${hash.toString(16)}`;
        fileIndex++;
        const toggled = (rawSize & COMPRESSION_TOGGLE) !== 0;
        const entry: BsaFileEntry = {
          path: normalizePath(folder ? `${folder}\\${name}` : name),
          folder: normalizePath(folder),
          name: name.toLowerCase(),
          hash,
          storedSize: rawSize & 0x3fffffff,
          offset,
          compressed: defaultCompressed !== toggled,
        };
        this.files.push(entry);
        this.byPath.set(entry.path, entry);
      }
    }
  }

  has(path: string): boolean {
    return this.byPath.has(normalizePath(path));
  }

  entry(path: string): BsaFileEntry | undefined {
    return this.byPath.get(normalizePath(path));
  }

  /** Extract (and decompress) a file. */
  read(pathOrEntry: string | BsaFileEntry): Uint8Array {
    const e = typeof pathOrEntry === 'string' ? this.entry(pathOrEntry) : pathOrEntry;
    if (!e) throw new Error(`${this.name}: file not found: ${pathOrEntry as string}`);
    if (e.offset + e.storedSize > this.source.size) throw new Error(`${this.name}: ${e.path} lies outside the archive (corrupt BSA)`);
    let data = this.source.read(e.offset, e.storedSize);
    if (this.archiveFlags & ArchiveFlags.EmbedFileNames) {
      const n = data[0]!;
      data = data.subarray(1 + n);
    }
    if (!e.compressed) return data.slice();
    const originalSize = readU32(data, 0);
    const payload = data.subarray(4);
    // zlib can't expand more than ~1032:1 and LZ4 ~255:1; anything beyond that is corruption.
    if (originalSize > MAX_FILE_SIZE || originalSize > payload.byteLength * 1100 + 64) throw new Error(`${this.name}: ${e.path} has an impossible size (corrupt BSA)`);
    if (this.version === 105) return decompressFrame(payload, originalSize);
    const out = new Uint8Array(originalSize);
    unzlibSync(payload, { out });
    return out;
  }

  /** Files whose path starts with a folder prefix (e.g. "meshes\\clutter"). */
  list(prefix = ''): BsaFileEntry[] {
    const p = normalizePath(prefix);
    return p ? this.files.filter((f) => f.path.startsWith(p)) : this.files;
  }
}

// ------------------------------------------------------------------ writing

export interface BsaWriteOptions {
  version?: 104 | 105;
  /** Compress files (except sounds/voices, which the game streams). Default true. */
  compress?: boolean;
  /** Embed full names before each file's data (required by some tools for textures). Default false. */
  embedFileNames?: boolean;
}

function fileTypeFlag(path: string): number {
  const top = path.split('\\')[0];
  switch (top) {
    case 'meshes':
      return FileTypeFlags.Meshes;
    case 'textures':
      return FileTypeFlags.Textures;
    case 'interface':
      return FileTypeFlags.Menus;
    case 'sound':
      return path.includes('\\voice\\') ? FileTypeFlags.Voices : FileTypeFlags.Sounds;
    case 'shadersfx':
      return FileTypeFlags.Shaders;
    case 'trees':
      return FileTypeFlags.Trees;
    default:
      return FileTypeFlags.Misc;
  }
}

/** Build a Skyrim BSA from in-memory files. Paths are relative to Data. */
export function writeBsa(files: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>, opts: BsaWriteOptions = {}): Uint8Array {
  const version = opts.version ?? 105;
  const compress = opts.compress ?? true;
  const entries = (files instanceof Map ? [...files.entries()] : Object.entries(files)).map(([p, data]) => {
    const path = normalizePath(p);
    const slash = path.lastIndexOf('\\');
    return { path, folder: slash >= 0 ? path.slice(0, slash) : '', name: slash >= 0 ? path.slice(slash + 1) : path, data };
  });
  // Group by folder, sort folders and files by hash (the game binary-searches).
  const folders = new Map<string, typeof entries>();
  for (const e of entries) {
    if (!folders.has(e.folder)) folders.set(e.folder, []);
    folders.get(e.folder)!.push(e);
  }
  const folderList = [...folders.entries()]
    .map(([name, list]) => ({ name, hash: bsaHash(name, true), files: list.map((f) => ({ ...f, hash: bsaHash(f.name, false) })).sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)) }))
    .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));

  let archiveFlags = ArchiveFlags.DirectoryNames | ArchiveFlags.FileNames;
  if (compress) archiveFlags |= ArchiveFlags.Compressed;
  if (opts.embedFileNames) archiveFlags |= ArchiveFlags.EmbedFileNames;
  let fileFlags = 0;
  for (const e of entries) fileFlags |= fileTypeFlag(e.path);

  const enc = new TextEncoder();
  const folderNameBytes = folderList.map((f) => enc.encode(f.name + '\0'));
  const totalFolderNameLength = folderNameBytes.reduce((n, b) => n + b.byteLength, 0);
  const fileNameBytes = folderList.flatMap((f) => f.files.map((x) => enc.encode(x.name + '\0')));
  const totalFileNameLength = fileNameBytes.reduce((n, b) => n + b.byteLength, 0);
  const fileCount = entries.length;
  const folderRecSize = version === 105 ? 24 : 16;
  const headerSize = 36;
  const folderRecordsStart = headerSize;
  const fileRecordsStart = folderRecordsStart + folderList.length * folderRecSize;
  const fileRecordsSize = totalFolderNameLength + folderList.length + fileCount * 16;
  const namesStart = fileRecordsStart + fileRecordsSize;
  let dataPos = namesStart + totalFileNameLength;

  // Prepare file payloads.
  const payloads = folderList.map((f) =>
    f.files.map((x) => {
      const isSound = x.path.endsWith('.wav') || x.path.endsWith('.xwm') || x.path.endsWith('.fuz');
      const shouldCompress = compress && !isSound;
      const parts: Uint8Array[] = [];
      if (opts.embedFileNames) {
        const full = enc.encode(x.path);
        parts.push(new Uint8Array([full.byteLength]), full);
      }
      if (shouldCompress) {
        const size = new Uint8Array(4);
        new DataView(size.buffer).setUint32(0, x.data.byteLength, true);
        parts.push(size, version === 105 ? compressFrame(x.data) : zlibSync(x.data, { level: 9 }));
      } else parts.push(x.data);
      const total = parts.reduce((n, p) => n + p.byteLength, 0);
      const buf = new Uint8Array(total);
      let o = 0;
      for (const p of parts) {
        buf.set(p, o);
        o += p.byteLength;
      }
      return { buf, toggle: compress !== shouldCompress };
    }),
  );

  const totalData = payloads.flat().reduce((n, p) => n + p.buf.byteLength, 0);
  const out = new Uint8Array(dataPos + totalData);
  const dv = new DataView(out.buffer);
  out.set(enc.encode('BSA\0'), 0);
  dv.setUint32(4, version, true);
  dv.setUint32(8, headerSize, true);
  dv.setUint32(12, archiveFlags, true);
  dv.setUint32(16, folderList.length, true);
  dv.setUint32(20, fileCount, true);
  dv.setUint32(24, totalFolderNameLength, true);
  dv.setUint32(28, totalFileNameLength, true);
  dv.setUint16(32, fileFlags, true);

  let recPos = fileRecordsStart;
  let namePos = namesStart;
  folderList.forEach((f, fi) => {
    const fr = folderRecordsStart + fi * folderRecSize;
    dv.setBigUint64(fr, f.hash, true);
    dv.setUint32(fr + 8, f.files.length, true);
    // Folder offset points at the folder's name record, plus totalFileNameLength (format quirk).
    const offset = recPos + totalFileNameLength;
    if (version === 105) {
      dv.setUint32(fr + 12, 0, true);
      dv.setBigUint64(fr + 16, BigInt(offset), true);
    } else dv.setUint32(fr + 12, offset, true);
    const nb = folderNameBytes[fi]!;
    out[recPos] = nb.byteLength;
    out.set(nb, recPos + 1);
    recPos += 1 + nb.byteLength;
    f.files.forEach((x, xi) => {
      const p = payloads[fi]![xi]!;
      dv.setBigUint64(recPos, x.hash, true);
      dv.setUint32(recPos + 8, (p.buf.byteLength | (p.toggle ? COMPRESSION_TOGGLE : 0)) >>> 0, true);
      dv.setUint32(recPos + 12, dataPos, true);
      recPos += 16;
      out.set(p.buf, dataPos);
      dataPos += p.buf.byteLength;
      const name = enc.encode(x.name + '\0');
      out.set(name, namePos);
      namePos += name.byteLength;
    });
  });
  return out;
}
