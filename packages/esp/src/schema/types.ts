/**
 * Declarative record schemas. A record is a sequence of subrecords; each
 * schema member describes one subrecord (or a repeating/grouped run of them)
 * and the value layout inside its data.
 *
 * Decoded records are plain JSON-like objects keyed by camelCase member keys,
 * which makes them easy to show in generic property editors and to diff.
 */

import type { BinaryReader, BinaryWriter } from '../binary';

export type IntType = 'u8' | 's8' | 'u16' | 's16' | 'u32' | 's32' | 'u64' | 's64';

export interface FlagsDef {
  /** Bit index → name. */
  [bit: number]: string;
}

export interface EnumDef {
  [value: number]: string;
}

export type ValueDef =
  | IntDef
  | FloatDef
  | FormIdDef
  | ZStringDef
  | LStringDef
  | FixedStringDef
  | BytesDef
  | UnusedDef
  | StructDef
  | ArrayDef
  | UnionDef
  | CustomDef
  | EmptyDef;

export interface ValueMeta {
  /** Hide from simplified editors (still decoded/encoded). */
  hidden?: boolean;
  /** Help text shown in editors. */
  help?: string;
  /** Unit or formatting hint (e.g. "degrees", "color"). */
  hint?: 'color' | 'rgb' | 'radians' | 'percent' | 'scale' | 'position' | 'text';
}

export interface IntDef extends ValueMeta {
  t: 'int';
  size: IntType;
  flags?: FlagsDef;
  enum?: EnumDef;
  default?: number;
}

export interface FloatDef extends ValueMeta {
  t: 'float';
  default?: number;
}

export interface FormIdDef extends ValueMeta {
  t: 'formid';
  /** Allowed record signatures; empty = any. */
  refs?: readonly string[];
}

export interface ZStringDef extends ValueMeta {
  t: 'zstring';
  /** Strings with a length prefix instead of NUL termination. */
  prefix?: 1 | 2 | 4;
}

export interface LStringDef extends ValueMeta {
  t: 'lstring';
}

export interface FixedStringDef extends ValueMeta {
  t: 'fstring';
  size: number;
}

export interface BytesDef extends ValueMeta {
  t: 'bytes';
  /** Fixed size; undefined consumes the rest of the subrecord. */
  size?: number;
}

export interface UnusedDef extends ValueMeta {
  t: 'unused';
  size: number;
}

export interface FieldDef {
  key: string;
  label: string;
  def: ValueDef;
}

export interface StructDef extends ValueMeta {
  t: 'struct';
  fields: readonly FieldDef[];
}

export interface ArrayDef extends ValueMeta {
  t: 'array';
  of: ValueDef;
  /** 'rest' = until end of data; a number = fixed count; else a count prefix of that width. */
  count: 'rest' | 'u8' | 'u16' | 'u32' | number;
  /** Elements must be sorted (game expects binary-searchable data). */
  sorted?: boolean;
}

export interface UnionDef extends ValueMeta {
  t: 'union';
  /** Picks an option index from context. Must work both when decoding and encoding. */
  decide: (ctx: UnionContext) => number;
  options: readonly ValueDef[];
}

export interface UnionContext {
  codec: CodecContext;
  /** Already decoded sibling fields of the enclosing struct. */
  parent: Record<string, unknown> | undefined;
  /** The record-level decoded object (members decoded so far). */
  record: Record<string, unknown>;
  /** Remaining bytes when decoding (undefined when encoding). */
  remaining?: number;
}

export interface CustomCodec<T = unknown> {
  decode(r: BinaryReader, size: number, ctx: CodecContext, record: Record<string, unknown>): T;
  encode(w: BinaryWriter, value: T, ctx: CodecContext, record: Record<string, unknown>): void;
  /** Short description for editors. */
  describe?(value: T): string;
}

export interface CustomDef extends ValueMeta {
  t: 'custom';
  name: string;
  codec: CustomCodec;
}

export interface EmptyDef extends ValueMeta {
  t: 'empty';
}

// ------------------------------------------------------------------ members

export type MemberDef = SubMember | RArrayMember | RStructMember | CountedMember | RUnionMember;

interface MemberBase {
  key: string;
  label: string;
  required?: boolean;
  help?: string;
  /** Always shown in forms, even when empty (the record's main list, such as a spell's effects). */
  prominent?: boolean;
}

/** Exactly one subrecord. */
export interface SubMember extends MemberBase {
  m: 'sub';
  sig: string;
  def: ValueDef;
}

/** A member that can repeat (consecutive occurrences). */
export interface RArrayMember extends MemberBase {
  m: 'rarray';
  of: MemberDef;
}

/** A group of subrecords that belong together (e.g. a quest stage). */
export interface RStructMember extends MemberBase {
  m: 'rstruct';
  members: readonly MemberDef[];
}

/**
 * A count subrecord followed by the counted data. The count is derived on
 * encode, so editors only see the list. `inner` is either a single subrecord
 * holding an array (KSIZ/KWDA) or an rarray (COCT/CNTO...).
 */
export interface CountedMember extends MemberBase {
  m: 'counted';
  countSig: string;
  countSize: 'u8' | 'u16' | 'u32';
  inner: SubMember | RArrayMember;
}

/** One of several alternative members. */
export interface RUnionMember extends MemberBase {
  m: 'runion';
  options: readonly MemberDef[];
}

export interface RecordDef {
  sig: string;
  name: string;
  members: readonly MemberDef[];
  /** Subrecords may appear in any order (the engine does not care). */
  unordered?: boolean;
  /** Record-header flag names for this record type. */
  flags?: FlagsDef;
  /** Category used to group records in the UI. */
  category?: RecordCategory;
}

export type RecordCategory =
  | 'Actors'
  | 'Audio'
  | 'Character'
  | 'Gameplay'
  | 'Items'
  | 'Magic'
  | 'Miscellaneous'
  | 'Quests'
  | 'Special Effects'
  | 'World Data'
  | 'World Objects';

// ------------------------------------------------------------------ context

export interface CodecContext {
  /** Plugin uses external string tables. */
  localized: boolean;
  /** Record being decoded/encoded (affects union deciders and lstring table selection). */
  recordSig: string;
  formVersion: number;
  /** Convert a stored FormID into the representation the caller wants. Default: identity number. */
  mapFormId?: (localId: number) => unknown;
  /** Inverse of mapFormId. */
  unmapFormId?: (value: unknown) => number;
  /** Resolve a localized string ID. */
  lookupString?: (subSig: string, id: number) => string | undefined;
  /** Store a localized string; returns the ID to write. */
  storeString?: (subSig: string, text: string, previousId: number | undefined) => number;
  /** Signature of the subrecord currently being processed. */
  subSig?: string;
  /** The enclosing subrecord group (rstruct) decoded so far, for unions that depend on a sibling subrecord. */
  group?: Record<string, unknown>;
}

export interface UnknownSub {
  /** Index in the original subrecord list. */
  index: number;
  sig: string;
  data: Uint8Array;
}

export interface DecodeResult {
  data: Record<string, unknown>;
  /** Subrecords the schema did not recognise (preserved on encode). */
  unknown: UnknownSub[];
  /** Fields that failed to decode, with reasons. */
  errors: string[];
}

/** Value used for a localized string when no string table is available. */
export interface LStringRef {
  lstringId: number;
}

/** Value used for a float whose bit pattern is a NaN (kept exactly). */
export interface F32Bits {
  f32bits: number;
}
