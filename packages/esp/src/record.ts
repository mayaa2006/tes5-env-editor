import { unzlibSync, zlibSync } from 'fflate';
import { BinaryReader, BinaryWriter, bytesEqual, hex } from './binary';
import { RecordFlags } from './constants';
import { decodeCp1252, encodeCp1252 } from './text';

export const RECORD_HEADER_SIZE = 24;

/** One field of a record: a four-character type followed by raw data. */
export interface Subrecord {
  sig: string;
  data: Uint8Array;
}

export interface RecordHeaderInit {
  sig: string;
  formId: number;
  flags?: number;
  vc1?: number;
  formVersion?: number;
  vc2?: number;
}

/**
 * A main record (anything that is not a GRUP). Subrecords are parsed lazily
 * from the stored bytes the first time they are needed, so loading a 250 MB
 * master only costs one small object per record.
 *
 * Records that were never modified are written back byte-for-byte, which is
 * what keeps this editor from producing "wild edits" or churn in untouched data.
 */
export class PluginRecord {
  readonly kind = 'record' as const;
  sig: string;
  flags: number;
  /** File-local FormID (upper byte = index into this plugin's master list). */
  formId: number;
  /** Version-control info 1 (timestamp + user) — ignored by the game. */
  vc1: number;
  /** Internal form version (43 = Skyrim LE CK, 44 = Skyrim SE CK). */
  formVersion: number;
  /** Version-control info 2 — ignored by the game. */
  vc2: number;
  /** Byte offset in the source file, for diagnostics. -1 for new records. */
  offset = -1;

  /** Stored data exactly as read (possibly compressed). Null once modified. */
  private stored: Uint8Array | null;
  /** Flags at load time; used to know whether stored bytes are still valid. */
  private storedFlags: number;
  private subs: Subrecord[] | null = null;
  private modified = false;

  constructor(init: RecordHeaderInit, stored: Uint8Array | null = null) {
    this.sig = init.sig;
    this.formId = init.formId >>> 0;
    this.flags = (init.flags ?? 0) >>> 0;
    this.vc1 = init.vc1 ?? 0;
    this.formVersion = init.formVersion ?? 44;
    this.vc2 = init.vc2 ?? 0;
    this.stored = stored;
    this.storedFlags = this.flags;
    if (!stored) this.subs = [];
  }

  static create(sig: string, formId: number, subrecords: Subrecord[] = [], flags = 0, formVersion = 44): PluginRecord {
    const r = new PluginRecord({ sig, formId, flags, formVersion });
    r.subs = subrecords.map((s) => ({ sig: s.sig, data: s.data }));
    r.modified = true;
    return r;
  }

  get isModified(): boolean {
    return this.modified;
  }

  markModified(): void {
    this.subrecords; // force decode before dropping stored bytes
    this.modified = true;
    this.stored = null;
  }

  get isDeleted(): boolean {
    return (this.flags & RecordFlags.Deleted) !== 0;
  }
  set isDeleted(v: boolean) {
    this.setFlag(RecordFlags.Deleted, v);
  }
  get isCompressed(): boolean {
    return (this.flags & RecordFlags.Compressed) !== 0;
  }
  get isPersistent(): boolean {
    return (this.flags & RecordFlags.Persistent) !== 0;
  }
  get isInitiallyDisabled(): boolean {
    return (this.flags & RecordFlags.InitiallyDisabled) !== 0;
  }

  setFlag(flag: number, on: boolean): void {
    const next = on ? (this.flags | flag) >>> 0 : (this.flags & ~flag) >>> 0;
    if (next !== this.flags) {
      this.flags = next;
      if (flag === RecordFlags.Compressed) this.markModified();
    }
  }

  /** Decompressed record payload. */
  get payload(): Uint8Array {
    if (this.stored && !this.modified) return decompressPayload(this.stored, this.storedFlags, this);
    return encodeSubrecords(this.subrecords);
  }

  /** Parsed subrecords. Mutating the returned array requires calling markModified(). */
  get subrecords(): Subrecord[] {
    if (!this.subs) {
      const payload = this.stored ? decompressPayload(this.stored, this.storedFlags, this) : new Uint8Array(0);
      this.subs = parseSubrecords(payload, this);
    }
    return this.subs;
  }

  set subrecords(list: Subrecord[]) {
    this.subs = list;
    this.modified = true;
    this.stored = null;
  }

  get(sig: string): Subrecord | undefined {
    return this.subrecords.find((s) => s.sig === sig);
  }

  /**
   * First subrecord's data without parsing and caching the whole record —
   * for scans over every record (search, indexes) that must not keep a
   * parsed copy of a 250 MB master in memory.
   */
  peek(sig: string): Uint8Array | undefined {
    if (this.subs || !this.stored) return this.get(sig)?.data;
    // Navmeshes and landscape never have an Editor ID; they're most of a master's compressed data.
    if (sig === 'EDID' && this.isCompressedStored && NO_EDITOR_ID.has(this.sig)) return undefined;
    if (this.isCompressedStored) return findSubrecord(decompressPayload(this.stored, this.storedFlags, this), sig);
    return findSubrecord(this.stored, sig);
  }

  private get isCompressedStored(): boolean {
    return (this.storedFlags & RecordFlags.Compressed) !== 0;
  }

  /**
   * Does any subrecord contain this little-endian u32 (e.g. a FormID)?
   * Scans the raw payload without parsing or caching the record.
   */
  containsU32(value: number): boolean {
    const payload = this.subs ? null : this.stored ? (this.isCompressedStored ? decompressPayload(this.stored, this.storedFlags, this) : this.stored) : null;
    const b0 = value & 0xff;
    const b1 = (value >>> 8) & 0xff;
    const b2 = (value >>> 16) & 0xff;
    const b3 = (value >>> 24) & 0xff;
    const scan = (d: Uint8Array, from: number, to: number): boolean => {
      for (let i = from; i + 4 <= to; i++) if (d[i] === b0 && d[i + 1] === b1 && d[i + 2] === b2 && d[i + 3] === b3) return true;
      return false;
    };
    if (!payload) return this.subrecords.some((s) => scan(s.data, 0, s.data.byteLength));
    let pos = 0;
    let bigSize = -1;
    const n = payload.byteLength;
    while (pos + 6 <= n) {
      let size = payload[pos + 4]! | (payload[pos + 5]! << 8);
      if (payload[pos] === 0x58 && payload[pos + 1] === 0x58 && payload[pos + 2] === 0x58 && payload[pos + 3] === 0x58 && size === 4 && pos + 10 <= n) {
        bigSize = (payload[pos + 6]! | (payload[pos + 7]! << 8) | (payload[pos + 8]! << 16) | (payload[pos + 9]! << 24)) >>> 0;
        pos += 10;
        continue;
      }
      if (bigSize >= 0) {
        size = bigSize;
        bigSize = -1;
      }
      const end = Math.min(n, pos + 6 + size);
      if (scan(payload, pos + 6, end)) return true;
      pos = end;
    }
    return false;
  }

  /** Drop the parsed subrecord cache of an unmodified record (it is re-parsed on demand). */
  releaseParsed(): void {
    if (!this.modified && this.stored) this.subs = null;
  }

  getAll(sig: string): Subrecord[] {
    return this.subrecords.filter((s) => s.sig === sig);
  }

  has(sig: string): boolean {
    return this.subrecords.some((s) => s.sig === sig);
  }

  /** Replace the first subrecord with this signature, or insert it (after `after` signatures if given). */
  set(sig: string, data: Uint8Array, opts: { insertAfter?: readonly string[]; insertBefore?: readonly string[] } = {}): void {
    const list = this.subrecords;
    const i = list.findIndex((s) => s.sig === sig);
    if (i >= 0) list[i] = { sig, data };
    else insertSubrecord(list, { sig, data }, opts);
    this.markModified();
  }

  remove(sig: string): boolean {
    const list = this.subrecords;
    const before = list.length;
    this.subs = list.filter((s) => s.sig !== sig);
    if (this.subs.length !== before) {
      this.markModified();
      return true;
    }
    return false;
  }

  /** Editor ID (EDID) or undefined. */
  get editorId(): string | undefined {
    const d = this.peek('EDID');
    return d ? readZString(d) : undefined;
  }
  set editorId(v: string | undefined) {
    if (v === undefined || v === '') this.remove('EDID');
    else this.set('EDID', zstringBytes(v), { insertBefore: ['*'] });
  }

  /** Number of bytes this record occupies when serialized (header included). */
  get serializedSize(): number {
    return RECORD_HEADER_SIZE + this.encodeData().byteLength;
  }

  /** Stored bytes can be reused as long as nothing changed that affects their encoding. */
  private get storedValid(): boolean {
    return !!this.stored && !this.modified && ((this.flags ^ this.storedFlags) & RecordFlags.Compressed) === 0;
  }

  private encodeData(): Uint8Array {
    if (this.storedValid) return this.stored!;
    const payload = encodeSubrecords(this.subrecords);
    if (this.isCompressed) return compressPayload(payload);
    return payload;
  }

  writeTo(w: BinaryWriter): void {
    const data = this.encodeData();
    w.sig(this.sig).u32(data.byteLength).u32(this.flags).u32(this.formId).u32(this.vc1).u16(this.formVersion).u16(this.vc2);
    w.bytes(data);
  }

  /** Deep copy (always fully decoded and marked modified). */
  clone(): PluginRecord {
    const r = PluginRecord.create(
      this.sig,
      this.formId,
      this.subrecords.map((s) => ({ sig: s.sig, data: s.data.slice() })),
      this.flags,
      this.formVersion,
    );
    r.vc1 = this.vc1;
    r.vc2 = this.vc2;
    return r;
  }

  toString(): string {
    const ed = this.editorId;
    return `${this.sig} [${hex(this.formId)}]${ed ? ` "${ed}"` : ''}`;
  }
}

/** Errors raised while parsing carry the record they came from. */
export class RecordParseError extends Error {
  constructor(
    message: string,
    readonly record?: PluginRecord,
  ) {
    super(record ? `${record.toString()}: ${message}` : message);
  }
}

const NO_EDITOR_ID = new Set(['NAVM', 'LAND']);

export function decompressPayload(stored: Uint8Array, flags: number, rec?: PluginRecord): Uint8Array {
  if ((flags & RecordFlags.Compressed) === 0) return stored;
  if (stored.byteLength < 4) throw new RecordParseError('compressed record too small', rec);
  const r = new BinaryReader(stored);
  const size = r.u32();
  if (size === 0) return new Uint8Array(0);
  const out = new Uint8Array(size);
  try {
    unzlibSync(stored.subarray(4), { out });
  } catch (e) {
    throw new RecordParseError(`zlib error: ${(e as Error).message}`, rec);
  }
  return out;
}

export function compressPayload(payload: Uint8Array): Uint8Array {
  const z = zlibSync(payload, { level: 6 });
  const out = new Uint8Array(4 + z.byteLength);
  new DataView(out.buffer).setUint32(0, payload.byteLength, true);
  out.set(z, 4);
  return out;
}

export function parseSubrecords(payload: Uint8Array, rec?: PluginRecord): Subrecord[] {
  const out: Subrecord[] = [];
  const r = new BinaryReader(payload);
  let bigSize = -1;
  while (r.remaining > 0) {
    if (r.remaining < 6) {
      throw new RecordParseError(`truncated subrecord header at payload offset ${r.pos}`, rec);
    }
    const sig = r.sig();
    let size = r.u16();
    if (sig === 'XXXX') {
      if (size !== 4) throw new RecordParseError('XXXX subrecord must have size 4', rec);
      bigSize = r.u32();
      continue;
    }
    if (bigSize >= 0) {
      size = bigSize;
      bigSize = -1;
    }
    if (size > r.remaining) {
      throw new RecordParseError(`subrecord ${sig} size ${size} exceeds remaining ${r.remaining} bytes`, rec);
    }
    out.push({ sig, data: r.bytesView(size) });
  }
  return out;
}

/** Find a subrecord in a raw payload without materializing the others. */
export function findSubrecord(payload: Uint8Array, sig: string): Uint8Array | undefined {
  const a = sig.charCodeAt(0);
  const b = sig.charCodeAt(1);
  const c = sig.charCodeAt(2);
  const d = sig.charCodeAt(3);
  let pos = 0;
  let bigSize = -1;
  const n = payload.byteLength;
  while (pos + 6 <= n) {
    let size = payload[pos + 4]! | (payload[pos + 5]! << 8);
    const isXXXX = payload[pos] === 0x58 && payload[pos + 1] === 0x58 && payload[pos + 2] === 0x58 && payload[pos + 3] === 0x58;
    if (isXXXX && size === 4 && pos + 10 <= n) {
      bigSize = (payload[pos + 6]! | (payload[pos + 7]! << 8) | (payload[pos + 8]! << 16) | (payload[pos + 9]! << 24)) >>> 0;
      pos += 10;
      continue;
    }
    if (bigSize >= 0) {
      size = bigSize;
      bigSize = -1;
    }
    if (pos + 6 + size > n) return undefined;
    if (payload[pos] === a && payload[pos + 1] === b && payload[pos + 2] === c && payload[pos + 3] === d) return payload.subarray(pos + 6, pos + 6 + size);
    pos += 6 + size;
  }
  return undefined;
}

export function encodeSubrecords(subs: readonly Subrecord[]): Uint8Array {
  let total = 0;
  for (const s of subs) total += (s.data.byteLength > 0xffff ? 10 : 0) + 6 + s.data.byteLength;
  const w = new BinaryWriter(total);
  for (const s of subs) {
    if (s.data.byteLength > 0xffff) {
      w.sig('XXXX').u16(4).u32(s.data.byteLength);
      w.sig(s.sig).u16(0);
    } else {
      w.sig(s.sig).u16(s.data.byteLength);
    }
    w.bytes(s.data);
  }
  return w.toBytes();
}

/**
 * Insert keeping a sensible position: after the last subrecord whose signature is
 * in `insertAfter`, or before the first in `insertBefore` ("*" = very first).
 */
export function insertSubrecord(
  list: Subrecord[],
  sub: Subrecord,
  opts: { insertAfter?: readonly string[]; insertBefore?: readonly string[] } = {},
): void {
  if (opts.insertBefore) {
    if (opts.insertBefore.includes('*')) {
      list.unshift(sub);
      return;
    }
    const i = list.findIndex((s) => opts.insertBefore!.includes(s.sig));
    if (i >= 0) {
      list.splice(i, 0, sub);
      return;
    }
  }
  if (opts.insertAfter) {
    let last = -1;
    list.forEach((s, i) => {
      if (opts.insertAfter!.includes(s.sig)) last = i;
    });
    if (last >= 0) {
      list.splice(last + 1, 0, sub);
      return;
    }
  }
  list.push(sub);
}

export function readZString(data: Uint8Array): string {
  let end = data.indexOf(0);
  if (end < 0) end = data.byteLength;
  return decodeCp1252(data.subarray(0, end));
}

export function zstringBytes(s: string): Uint8Array {
  const enc = encodeCp1252(s);
  const out = new Uint8Array(enc.byteLength + 1);
  out.set(enc);
  return out;
}

export function subrecordsEqual(a: readonly Subrecord[], b: readonly Subrecord[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.sig !== b[i]!.sig || !bytesEqual(a[i]!.data, b[i]!.data)) return false;
  }
  return true;
}
