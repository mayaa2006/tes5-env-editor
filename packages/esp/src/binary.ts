/**
 * Little-endian binary reader/writer helpers used by every Bethesda format in
 * this project. All game formats are little-endian.
 */

import { decodeCp1252, encodeCp1252 } from './text';

export class BinaryReader {
  readonly view: DataView;
  pos: number;

  constructor(
    readonly bytes: Uint8Array,
    pos = 0,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = pos;
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  get remaining(): number {
    return this.bytes.byteLength - this.pos;
  }

  get eof(): boolean {
    return this.pos >= this.bytes.byteLength;
  }

  private need(n: number): void {
    if (this.pos + n > this.bytes.byteLength) {
      throw new RangeError(
        `Unexpected end of data: need ${n} byte(s) at offset ${this.pos}, only ${this.remaining} left`,
      );
    }
  }

  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }
  i8(): number {
    this.need(1);
    return this.view.getInt8(this.pos++);
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  u64(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }
  i64(): bigint {
    this.need(8);
    const v = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  /** Returns a view (no copy) of the next `n` bytes. */
  bytesView(n: number): Uint8Array {
    this.need(n);
    const v = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  /** Four-character code such as `NPC_`. */
  sig(): string {
    this.need(4);
    const b = this.bytes;
    const p = this.pos;
    this.pos += 4;
    return String.fromCharCode(b[p]!, b[p + 1]!, b[p + 2]!, b[p + 3]!);
  }

  /** Fixed-length cp1252 string; trailing NULs are stripped. */
  fixedString(n: number): string {
    const raw = this.bytesView(n);
    let end = raw.indexOf(0);
    if (end < 0) end = raw.length;
    return decodeCp1252(raw.subarray(0, end));
  }

  /** NUL-terminated cp1252 string. */
  zstring(): string {
    const start = this.pos;
    let end = start;
    while (end < this.bytes.byteLength && this.bytes[end] !== 0) end++;
    const s = decodeCp1252(this.bytes.subarray(start, end));
    this.pos = Math.min(end + 1, this.bytes.byteLength);
    return s;
  }

  /** String prefixed with a length of the given width (no terminator assumed). */
  lenString(width: 1 | 2 | 4, nulTerminated = false): string {
    const n = width === 1 ? this.u8() : width === 2 ? this.u16() : this.u32();
    const raw = this.bytesView(n);
    const end = nulTerminated && n > 0 && raw[n - 1] === 0 ? n - 1 : n;
    return decodeCp1252(raw.subarray(0, end));
  }
}

export class BinaryWriter {
  private buf: Uint8Array;
  private view: DataView;
  pos = 0;

  constructor(initialCapacity = 1024) {
    this.buf = new Uint8Array(Math.max(16, initialCapacity));
    this.view = new DataView(this.buf.buffer);
  }

  get length(): number {
    return this.pos;
  }

  private ensure(n: number): void {
    const need = this.pos + n;
    if (need <= this.buf.byteLength) return;
    let cap = this.buf.byteLength * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this {
    this.ensure(1);
    this.view.setUint8(this.pos++, v);
    return this;
  }
  i8(v: number): this {
    this.ensure(1);
    this.view.setInt8(this.pos++, v);
    return this;
  }
  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
    return this;
  }
  i16(v: number): this {
    this.ensure(2);
    this.view.setInt16(this.pos, v, true);
    this.pos += 2;
    return this;
  }
  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
    return this;
  }
  i32(v: number): this {
    this.ensure(4);
    this.view.setInt32(this.pos, v, true);
    this.pos += 4;
    return this;
  }
  u64(v: bigint): this {
    this.ensure(8);
    this.view.setBigUint64(this.pos, v, true);
    this.pos += 8;
    return this;
  }
  i64(v: bigint): this {
    this.ensure(8);
    this.view.setBigInt64(this.pos, v, true);
    this.pos += 8;
    return this;
  }
  f32(v: number): this {
    this.ensure(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
    return this;
  }
  f64(v: number): this {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
    return this;
  }
  bytes(b: Uint8Array): this {
    this.ensure(b.byteLength);
    this.buf.set(b, this.pos);
    this.pos += b.byteLength;
    return this;
  }
  zeros(n: number): this {
    this.ensure(n);
    this.buf.fill(0, this.pos, this.pos + n);
    this.pos += n;
    return this;
  }
  sig(s: string): this {
    if (s.length !== 4) throw new Error(`Signature must be 4 characters: "${s}"`);
    this.ensure(4);
    for (let i = 0; i < 4; i++) this.buf[this.pos + i] = s.charCodeAt(i) & 0xff;
    this.pos += 4;
    return this;
  }
  zstring(s: string): this {
    this.bytes(encodeCp1252(s));
    return this.u8(0);
  }
  fixedString(s: string, n: number): this {
    const enc = encodeCp1252(s);
    if (enc.byteLength > n) throw new Error(`String "${s}" does not fit in ${n} bytes`);
    this.bytes(enc);
    return this.zeros(n - enc.byteLength);
  }
  lenString(s: string, width: 1 | 2 | 4, nulTerminated = false): this {
    const enc = encodeCp1252(s);
    const n = enc.byteLength + (nulTerminated ? 1 : 0);
    if (width === 1) this.u8(n);
    else if (width === 2) this.u16(n);
    else this.u32(n);
    this.bytes(enc);
    if (nulTerminated) this.u8(0);
    return this;
  }

  /** Overwrite a uint32 at an earlier position (used for back-patching sizes). */
  patchU32(at: number, v: number): void {
    this.view.setUint32(at, v >>> 0, true);
  }

  /** Returns a copy of the written bytes. */
  toBytes(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }

  /** Returns a view over the written bytes without copying. */
  peek(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

export function hex(n: number, width = 8): string {
  return (n >>> 0).toString(16).toUpperCase().padStart(width, '0');
}
