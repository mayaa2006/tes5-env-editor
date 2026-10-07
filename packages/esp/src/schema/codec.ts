import { BinaryReader, BinaryWriter } from '../binary';
import type { Subrecord } from '../record';
import { decodeCp1252, encodeCp1252 } from '../text';
import type {
  CodecContext,
  CountedMember,
  DecodeResult,
  F32Bits,
  FieldDef,
  IntType,
  LStringRef,
  MemberDef,
  RecordDef,
  StructDef,
  UnknownSub,
  ValueDef,
} from './types';

const INT_SIZES: Record<IntType, number> = { u8: 1, s8: 1, u16: 2, s16: 2, u32: 4, s32: 4, u64: 8, s64: 8 };

export function intSize(t: IntType): number {
  return INT_SIZES[t];
}

/** Fixed byte size of a value, or undefined if variable. */
export function fixedSize(def: ValueDef): number | undefined {
  switch (def.t) {
    case 'int':
      return INT_SIZES[def.size];
    case 'float':
    case 'formid':
      return 4;
    case 'fstring':
      return def.size;
    case 'unused':
      return def.size;
    case 'bytes':
      return def.size;
    case 'empty':
      return 0;
    case 'struct': {
      let n = 0;
      for (const f of def.fields) {
        const s = fixedSize(f.def);
        if (s === undefined) return undefined;
        n += s;
      }
      return n;
    }
    case 'array': {
      if (typeof def.count !== 'number') return undefined;
      const s = fixedSize(def.of);
      return s === undefined ? undefined : s * def.count;
    }
    default:
      return undefined;
  }
}

// ------------------------------------------------------------------ values

function readInt(r: BinaryReader, t: IntType): number {
  switch (t) {
    case 'u8':
      return r.u8();
    case 's8':
      return r.i8();
    case 'u16':
      return r.u16();
    case 's16':
      return r.i16();
    case 'u32':
      return r.u32();
    case 's32':
      return r.i32();
    case 'u64':
      return Number(r.u64());
    case 's64':
      return Number(r.i64());
  }
}

function writeInt(w: BinaryWriter, t: IntType, v: number): void {
  switch (t) {
    case 'u8':
      w.u8(v & 0xff);
      break;
    case 's8':
      w.i8(v);
      break;
    case 'u16':
      w.u16(v & 0xffff);
      break;
    case 's16':
      w.i16(v);
      break;
    case 'u32':
      w.u32(v);
      break;
    case 's32':
      w.i32(v);
      break;
    case 'u64':
      w.u64(BigInt(Math.trunc(v)));
      break;
    case 's64':
      w.i64(BigInt(Math.trunc(v)));
      break;
  }
}

export function decodeValue(
  def: ValueDef,
  r: BinaryReader,
  end: number,
  ctx: CodecContext,
  record: Record<string, unknown>,
  parent?: Record<string, unknown>,
): unknown {
  switch (def.t) {
    case 'int':
      return readInt(r, def.size);
    case 'float': {
      const bits = r.view.getUint32(r.pos, true);
      const v = r.f32();
      if (Number.isNaN(v)) return { f32bits: bits } satisfies F32Bits;
      return v;
    }
    case 'formid': {
      const id = r.u32();
      return ctx.mapFormId ? ctx.mapFormId(id) : id;
    }
    case 'zstring': {
      if (def.prefix) return r.lenString(def.prefix);
      const start = r.pos;
      let e = start;
      while (e < end && r.bytes[e] !== 0) e++;
      const s = decodeCp1252(r.bytes.subarray(start, e));
      r.pos = Math.min(e + 1, end);
      return s;
    }
    case 'lstring': {
      if (ctx.localized) {
        const id = r.u32();
        const text = ctx.lookupString?.(ctx.subSig ?? '', id);
        return text !== undefined ? text : ({ lstringId: id } satisfies LStringRef);
      }
      const start = r.pos;
      let e = start;
      while (e < end && r.bytes[e] !== 0) e++;
      const s = decodeCp1252(r.bytes.subarray(start, e));
      r.pos = Math.min(e + 1, end);
      return s;
    }
    case 'fstring':
      return r.fixedString(def.size);
    case 'bytes': {
      const n = def.size ?? end - r.pos;
      return r.bytesView(n).slice();
    }
    case 'unused':
      return r.bytesView(Math.min(def.size, end - r.pos)).slice();
    case 'empty':
      return true;
    case 'struct':
      return decodeStruct(def, r, end, ctx, record);
    case 'array': {
      let count: number;
      if (def.count === 'rest') count = -1;
      else if (typeof def.count === 'number') count = def.count;
      else count = def.count === 'u8' ? r.u8() : def.count === 'u16' ? r.u16() : r.u32();
      const out: unknown[] = [];
      const elemSize = fixedSize(def.of);
      if (count < 0) {
        while (r.pos < end) {
          if (elemSize !== undefined && end - r.pos < elemSize) break;
          out.push(decodeValue(def.of, r, end, ctx, record, parent));
        }
        if (r.pos < end) {
          // trailing partial element — keep the bytes so encoding is lossless
          (out as unknown[] & { tail?: Uint8Array }).tail = r.bytesView(end - r.pos).slice();
        }
      } else {
        for (let i = 0; i < count; i++) out.push(decodeValue(def.of, r, end, ctx, record, parent));
      }
      return out;
    }
    case 'union': {
      const i = def.decide({ codec: ctx, parent, record, remaining: end - r.pos });
      const opt = def.options[i];
      if (!opt) throw new Error(`union option ${i} out of range`);
      return decodeValue(opt, r, end, ctx, record, parent);
    }
    case 'custom':
      return def.codec.decode(r, end - r.pos, ctx, record);
  }
}

function decodeStruct(
  def: StructDef,
  r: BinaryReader,
  end: number,
  ctx: CodecContext,
  record: Record<string, unknown>,
): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const f of def.fields) {
    if (r.pos >= end) {
      // Older form versions often store truncated structs; missing fields stay undefined.
      if (f.def.t === 'array' && f.def.count === 'rest') obj[f.key] = [];
      else obj.__truncated = true;
      break;
    }
    const need = fixedSize(f.def);
    if (need !== undefined && r.pos + need > end) {
      obj.__tail = r.bytesView(end - r.pos).slice();
      obj.__truncated = true;
      break;
    }
    obj[f.key] = decodeValue(f.def, r, end, ctx, record, obj);
  }
  return obj;
}

export function encodeValue(
  def: ValueDef,
  v: unknown,
  w: BinaryWriter,
  ctx: CodecContext,
  record: Record<string, unknown>,
  parent?: Record<string, unknown>,
): void {
  switch (def.t) {
    case 'int':
      writeInt(w, def.size, Number(v ?? def.default ?? 0));
      return;
    case 'float': {
      if (v && typeof v === 'object' && 'f32bits' in (v as object)) {
        w.u32((v as F32Bits).f32bits);
        return;
      }
      w.f32(Number(v ?? def.default ?? 0));
      return;
    }
    case 'formid': {
      const id = ctx.unmapFormId ? ctx.unmapFormId(v) : Number(v ?? 0);
      w.u32(id >>> 0);
      return;
    }
    case 'zstring': {
      const s = String(v ?? '');
      if (def.prefix) w.lenString(s, def.prefix);
      else w.zstring(s);
      return;
    }
    case 'lstring': {
      if (ctx.localized) {
        if (v && typeof v === 'object' && 'lstringId' in (v as object)) {
          w.u32((v as LStringRef).lstringId);
          return;
        }
        if (!ctx.storeString) throw new Error('Cannot encode localized string without a string table');
        w.u32(ctx.storeString(ctx.subSig ?? '', String(v ?? ''), undefined));
        return;
      }
      w.zstring(typeof v === 'string' ? v : '');
      return;
    }
    case 'fstring':
      w.fixedString(String(v ?? ''), def.size);
      return;
    case 'bytes': {
      const b = v instanceof Uint8Array ? v : new Uint8Array(def.size ?? 0);
      if (def.size !== undefined && b.byteLength !== def.size) {
        const fixed = new Uint8Array(def.size);
        fixed.set(b.subarray(0, def.size));
        w.bytes(fixed);
      } else w.bytes(b);
      return;
    }
    case 'unused': {
      const b = v instanceof Uint8Array ? v : new Uint8Array(def.size);
      w.bytes(b);
      return;
    }
    case 'empty':
      return;
    case 'struct':
      encodeStruct(def, (v ?? {}) as Record<string, unknown>, w, ctx, record);
      return;
    case 'array': {
      const arr = (Array.isArray(v) ? v : []) as unknown[] & { tail?: Uint8Array };
      if (def.count === 'u8') w.u8(arr.length);
      else if (def.count === 'u16') w.u16(arr.length);
      else if (def.count === 'u32') w.u32(arr.length);
      const n = typeof def.count === 'number' ? def.count : arr.length;
      for (let i = 0; i < n; i++) encodeValue(def.of, arr[i], w, ctx, record, parent);
      if (arr.tail) w.bytes(arr.tail);
      return;
    }
    case 'union': {
      const i = def.decide({ codec: ctx, parent, record });
      const opt = def.options[i];
      if (!opt) throw new Error(`union option ${i} out of range`);
      encodeValue(opt, v, w, ctx, record, parent);
      return;
    }
    case 'custom':
      def.codec.encode(w, v, ctx, record);
      return;
  }
}

function encodeStruct(def: StructDef, obj: Record<string, unknown>, w: BinaryWriter, ctx: CodecContext, record: Record<string, unknown>): void {
  for (const f of def.fields) {
    if (!(f.key in obj) || obj[f.key] === undefined) {
      // Truncated struct: stop at the first missing field only if the struct came from data.
      if (isTruncated(def, obj, f)) break;
    }
    encodeValue(f.def, obj[f.key], w, ctx, record, obj);
  }
  if (obj.__tail instanceof Uint8Array) w.bytes(obj.__tail);
  if (obj.__extra instanceof Uint8Array) w.bytes(obj.__extra);
}

/** A struct is truncated when a field is missing and no later field is present. */
function isTruncated(def: StructDef, obj: Record<string, unknown>, f: FieldDef): boolean {
  const i = def.fields.indexOf(f);
  for (let j = i; j < def.fields.length; j++) if (obj[def.fields[j]!.key] !== undefined) return false;
  // Only honour truncation for structs that were stored short — new objects get defaults.
  return obj.__truncated === true;
}

/** Decode the whole data of one subrecord. */
export function decodeSubrecordData(def: ValueDef, data: Uint8Array, ctx: CodecContext, record: Record<string, unknown>): unknown {
  const r = new BinaryReader(data);
  const v = decodeValue(def, r, data.byteLength, ctx, record);
  if (def.t === 'struct' && v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (r.pos < data.byteLength) o.__extra = data.subarray(r.pos).slice();
  } else if (r.pos < data.byteLength && def.t !== 'custom') {
    // Extra bytes after a scalar: preserve by wrapping.
    return { __value: v, __extra: data.subarray(r.pos).slice() };
  }
  return v;
}

export function encodeSubrecordData(def: ValueDef, v: unknown, ctx: CodecContext, record: Record<string, unknown>): Uint8Array {
  const w = new BinaryWriter(64);
  if (v && typeof v === 'object' && '__value' in (v as object) && def.t !== 'struct') {
    const o = v as { __value: unknown; __extra: Uint8Array };
    encodeValue(def, o.__value, w, ctx, record);
    w.bytes(o.__extra);
  } else {
    encodeValue(def, v, w, ctx, record);
  }
  return w.toBytes();
}

// ------------------------------------------------------------------ members

/** Signatures a member can start with. */
export function startSigs(m: MemberDef): Set<string> {
  switch (m.m) {
    case 'sub':
      return new Set([m.sig]);
    case 'rarray':
      return startSigs(m.of);
    case 'counted':
      return new Set([m.countSig, ...startSigs(m.inner)]);
    case 'runion': {
      const s = new Set<string>();
      for (const o of m.options) for (const x of startSigs(o)) s.add(x);
      return s;
    }
    case 'rstruct': {
      const s = new Set<string>();
      for (const sub of m.members) {
        for (const x of startSigs(sub)) s.add(x);
        if (sub.required) break;
      }
      return s;
    }
  }
}

const startCache = new WeakMap<MemberDef, Set<string>>();
function starts(m: MemberDef): Set<string> {
  let s = startCache.get(m);
  if (!s) {
    s = startSigs(m);
    startCache.set(m, s);
  }
  return s;
}

/** All signatures a member can contain. */
export function allSigs(m: MemberDef, out = new Set<string>()): Set<string> {
  switch (m.m) {
    case 'sub':
      out.add(m.sig);
      break;
    case 'rarray':
      allSigs(m.of, out);
      break;
    case 'counted':
      out.add(m.countSig);
      allSigs(m.inner, out);
      break;
    case 'runion':
      for (const o of m.options) allSigs(o, out);
      break;
    case 'rstruct':
      for (const x of m.members) allSigs(x, out);
      break;
  }
  return out;
}

interface Cursor {
  subs: readonly Subrecord[];
  i: number;
  errors: string[];
}

function decodeMember(m: MemberDef, cur: Cursor, ctx: CodecContext, record: Record<string, unknown>): unknown {
  switch (m.m) {
    case 'sub': {
      const s = cur.subs[cur.i]!;
      cur.i++;
      const sctx = { ...ctx, subSig: s.sig };
      try {
        return decodeSubrecordData(m.def, s.data, sctx, record);
      } catch (e) {
        cur.errors.push(`${s.sig}: ${(e as Error).message}`);
        return { __raw: s.data.slice() };
      }
    }
    case 'rarray': {
      const out: unknown[] = [];
      const st = starts(m.of);
      while (cur.i < cur.subs.length && st.has(cur.subs[cur.i]!.sig)) {
        const before = cur.i;
        out.push(decodeMember(m.of, cur, ctx, record));
        if (cur.i === before) break;
        // An rstruct element ends where a sig that only starts a new element appears.
      }
      return out;
    }
    case 'counted':
      return decodeCounted(m, cur, ctx, record);
    case 'runion': {
      const sig = cur.subs[cur.i]!.sig;
      const idx = m.options.findIndex((o) => starts(o).has(sig));
      const opt = m.options[idx]!;
      return { option: idx, value: decodeMember(opt, cur, ctx, record) };
    }
    case 'rstruct': {
      const obj: Record<string, unknown> = {};
      decodeMembers(m.members, cur, { ...ctx, group: obj }, obj, record, true);
      return obj;
    }
  }
}

function decodeCounted(m: CountedMember, cur: Cursor, ctx: CodecContext, record: Record<string, unknown>): unknown {
  let declared: number | undefined;
  if (cur.subs[cur.i]?.sig === m.countSig) {
    const s = cur.subs[cur.i]!;
    cur.i++;
    const r = new BinaryReader(s.data);
    declared = m.countSize === 'u8' ? r.u8() : m.countSize === 'u16' ? r.u16() : r.u32();
  }
  let items: unknown[] = [];
  if (cur.i < cur.subs.length && starts(m.inner).has(cur.subs[cur.i]!.sig)) {
    const v = decodeMember(m.inner, cur, ctx, record);
    items = Array.isArray(v) ? v : [];
  }
  if (declared !== undefined && declared !== items.length) {
    cur.errors.push(`${m.countSig} declares ${declared} entries but ${items.length} were found`);
  }
  if (declared !== undefined && items.length === 0) {
    // keep "count present but empty" for lossless round trips
    (items as unknown[] & { keepCount?: boolean }).keepCount = true;
  }
  if (declared === undefined && items.length > 0) {
    // Some vanilla records list items without the count subrecord (e.g. quest alias inventories).
    (items as unknown[] & { noCount?: boolean }).noCount = true;
  }
  return items;
}

/**
 * Match members in order against the subrecord stream. Nested levels stop at
 * the first subrecord none of their remaining members can start with.
 * Unordered top levels may also match earlier members that are still unset.
 */
function decodeMembers(
  members: readonly MemberDef[],
  cur: Cursor,
  ctx: CodecContext,
  target: Record<string, unknown>,
  record: Record<string, unknown>,
  nested: boolean,
  unknown?: UnknownSub[],
  unordered = false,
): string[] {
  const order: string[] = [];
  let mi = 0;
  while (cur.i < cur.subs.length) {
    const sig = cur.subs[cur.i]!.sig;
    let k = -1;
    for (let j = mi; j < members.length; j++) {
      if (starts(members[j]!).has(sig)) {
        k = j;
        break;
      }
    }
    if (k < 0 && unordered) {
      for (let j = 0; j < mi; j++) {
        if (starts(members[j]!).has(sig) && target[members[j]!.key] === undefined) {
          k = j;
          break;
        }
      }
    }
    if (k < 0) {
      if (nested) return order;
      unknown?.push({ index: cur.i, sig, data: cur.subs[cur.i]!.data });
      cur.i++;
      continue;
    }
    const m = members[k]!;
    target[m.key] = decodeMember(m, cur, ctx, record);
    order.push(m.key);
    if (k >= mi) mi = k + 1;
  }
  return order;
}

export function decodeRecordData(def: RecordDef, subs: readonly Subrecord[], ctx: CodecContext): DecodeResult {
  const data: Record<string, unknown> = {};
  const unknown: UnknownSub[] = [];
  const cur: Cursor = { subs, i: 0, errors: [] };
  const order = decodeMembers(def.members, cur, { ...ctx, recordSig: def.sig }, data, data, false, unknown, def.unordered);
  // Remember the stored order when it differs from the schema, so encoding is lossless.
  const schemaOrder = def.members.map((m) => m.key).filter((k) => order.includes(k));
  if (order.some((k, i) => schemaOrder[i] !== k)) data.__order = order;
  return { data, unknown, errors: cur.errors };
}

function encodeMember(m: MemberDef, v: unknown, out: Subrecord[], ctx: CodecContext, record: Record<string, unknown>): void {
  if (v === undefined) return;
  // A FormID field that is present but "None" is stored as 0 (e.g. MESG INAM);
  // only an absent key removes the subrecord.
  if (v === null && !(m.m === 'sub' && m.def.t === 'formid')) return;
  switch (m.m) {
    case 'sub': {
      if (v && typeof v === 'object' && '__raw' in (v as object)) {
        out.push({ sig: m.sig, data: (v as { __raw: Uint8Array }).__raw });
        return;
      }
      if (m.def.t === 'empty' && v === false) return;
      out.push({ sig: m.sig, data: encodeSubrecordData(m.def, v, { ...ctx, subSig: m.sig }, record) });
      return;
    }
    case 'rarray': {
      if (!Array.isArray(v)) return;
      for (const item of v) encodeMember(m.of, item, out, ctx, record);
      return;
    }
    case 'counted': {
      const items = (Array.isArray(v) ? v : []) as unknown[] & { keepCount?: boolean; noCount?: boolean };
      if (items.length === 0 && !items.keepCount) return;
      if (items.noCount) {
        encodeMember(m.inner, items, out, ctx, record);
        return;
      }
      const w = new BinaryWriter(4);
      if (m.countSize === 'u8') w.u8(items.length);
      else if (m.countSize === 'u16') w.u16(items.length);
      else w.u32(items.length);
      out.push({ sig: m.countSig, data: w.toBytes() });
      if (items.length) encodeMember(m.inner, items, out, ctx, record);
      return;
    }
    case 'runion': {
      const u = v as { option: number; value: unknown };
      const opt = m.options[u.option];
      if (opt) encodeMember(opt, u.value, out, ctx, record);
      return;
    }
    case 'rstruct': {
      const obj = v as Record<string, unknown>;
      const gctx = { ...ctx, group: obj };
      for (const sub of m.members) encodeMember(sub, obj[sub.key], out, gctx, record);
      return;
    }
  }
}

export function encodeRecordData(
  def: RecordDef,
  data: Record<string, unknown>,
  ctx: CodecContext,
  unknown: readonly UnknownSub[] = [],
): Subrecord[] {
  const out: Subrecord[] = [];
  const c = { ...ctx, recordSig: def.sig };
  const byKey = new Map(def.members.map((m) => [m.key, m] as const));
  for (const key of memberOrder(def, data)) encodeMember(byKey.get(key)!, data[key], out, c, data);
  const sorted = [...unknown].sort((a, b) => a.index - b.index);
  for (const u of sorted) out.splice(Math.min(u.index, out.length), 0, { sig: u.sig, data: u.data });
  return out;
}

/**
 * Order in which members are written: the stored order (if recorded) with any
 * newly set members slotted in at their schema position.
 */
export function memberOrder(def: RecordDef, data: Record<string, unknown>): string[] {
  const schema = def.members.map((m) => m.key);
  const stored = Array.isArray(data.__order) ? (data.__order as string[]).filter((k) => schema.includes(k)) : null;
  if (!stored) return schema;
  const out = [...stored];
  const rank = new Map(schema.map((k, i) => [k, i] as const));
  for (const k of schema) {
    if (out.includes(k)) continue;
    const r = rank.get(k)!;
    let at = out.findIndex((x) => rank.get(x)! > r);
    if (at < 0) at = out.length;
    out.splice(at, 0, k);
  }
  return out;
}

/** Signatures covered by a record definition. */
export function recordSigs(def: RecordDef): Set<string> {
  const s = new Set<string>();
  for (const m of def.members) allSigs(m, s);
  return s;
}
