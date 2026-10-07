/**
 * Small builder DSL for record definitions. Keeps the definition files close
 * to the shape of the actual data so they are easy to check against xEdit.
 */
import type {
  ArrayDef,
  CountedMember,
  CustomCodec,
  CustomDef,
  EnumDef,
  FieldDef,
  FlagsDef,
  FloatDef,
  FormIdDef,
  IntDef,
  IntType,
  LStringDef,
  MemberDef,
  RArrayMember,
  RecordCategory,
  RecordDef,
  RStructMember,
  RUnionMember,
  StructDef,
  SubMember,
  UnionContext,
  UnionDef,
  ValueDef,
  ValueMeta,
  ZStringDef,
} from './types';

// ------------------------------------------------------------------ values

export const u8 = (meta: Omit<IntDef, 't' | 'size'> = {}): IntDef => ({ t: 'int', size: 'u8', ...meta });
export const s8 = (meta: Omit<IntDef, 't' | 'size'> = {}): IntDef => ({ t: 'int', size: 's8', ...meta });
export const u16 = (meta: Omit<IntDef, 't' | 'size'> = {}): IntDef => ({ t: 'int', size: 'u16', ...meta });
export const s16 = (meta: Omit<IntDef, 't' | 'size'> = {}): IntDef => ({ t: 'int', size: 's16', ...meta });
export const u32 = (meta: Omit<IntDef, 't' | 'size'> = {}): IntDef => ({ t: 'int', size: 'u32', ...meta });
export const s32 = (meta: Omit<IntDef, 't' | 'size'> = {}): IntDef => ({ t: 'int', size: 's32', ...meta });
export const int = (size: IntType, meta: Omit<IntDef, 't' | 'size'> = {}): IntDef => ({ t: 'int', size, ...meta });
export const flags = (size: IntType, f: FlagsDef, meta: Omit<IntDef, 't' | 'size' | 'flags'> = {}): IntDef => ({ t: 'int', size, flags: f, ...meta });
export const enumOf = (size: IntType, e: EnumDef, meta: Omit<IntDef, 't' | 'size' | 'enum'> = {}): IntDef => ({ t: 'int', size, enum: e, ...meta });
export const f32 = (meta: Omit<FloatDef, 't'> = {}): FloatDef => ({ t: 'float', ...meta });
export const formid = (refs: readonly string[] = [], meta: ValueMeta = {}): FormIdDef => ({ t: 'formid', refs, ...meta });
export const zstring = (meta: Omit<ZStringDef, 't'> = {}): ZStringDef => ({ t: 'zstring', ...meta });
export const lstring = (meta: ValueMeta = {}): LStringDef => ({ t: 'lstring', ...meta });
export const fstring = (size: number, meta: ValueMeta = {}): ValueDef => ({ t: 'fstring', size, ...meta });
export const bytes = (size?: number, meta: ValueMeta = {}): ValueDef => ({ t: 'bytes', size, ...meta });
export const unused = (size: number): ValueDef => ({ t: 'unused', size, hidden: true });
export const empty = (meta: ValueMeta = {}): ValueDef => ({ t: 'empty', ...meta });
export const custom = (name: string, codec: CustomCodec<any>, meta: ValueMeta = {}): CustomDef => ({ t: 'custom', name, codec, ...meta });

/** Field tuple: [key, label, def]. */
export type F = readonly [key: string, label: string, def: ValueDef];

export const struct = (fields: readonly F[], meta: ValueMeta = {}): StructDef => ({
  t: 'struct',
  fields: fields.map(([key, label, def]): FieldDef => ({ key, label, def })),
  ...meta,
});

export const array = (of: ValueDef, count: ArrayDef['count'] = 'rest', meta: Omit<ArrayDef, 't' | 'of' | 'count'> = {}): ArrayDef => ({
  t: 'array',
  of,
  count,
  ...meta,
});

export const union = (decide: (ctx: UnionContext) => number, options: readonly ValueDef[], meta: ValueMeta = {}): UnionDef => ({
  t: 'union',
  decide,
  options,
  ...meta,
});

export const vec3 = (meta: ValueMeta = {}): StructDef =>
  struct(
    [
      ['x', 'X', f32()],
      ['y', 'Y', f32()],
      ['z', 'Z', f32()],
    ],
    meta,
  );

export const rgba = (): StructDef =>
  struct(
    [
      ['r', 'Red', u8()],
      ['g', 'Green', u8()],
      ['b', 'Blue', u8()],
      ['a', 'Alpha', u8()],
    ],
    { hint: 'color' },
  );

// ------------------------------------------------------------------ members

export const sub = (sig: string, key: string, label: string, def: ValueDef, opts: { required?: boolean; help?: string } = {}): SubMember => ({
  m: 'sub',
  sig,
  key,
  label,
  def,
  ...opts,
});

export const rarray = (key: string, label: string, of: MemberDef, opts: { required?: boolean; help?: string; prominent?: boolean } = {}): RArrayMember => ({
  m: 'rarray',
  key,
  label,
  of,
  ...opts,
});

export const rstruct = (key: string, label: string, members: readonly MemberDef[], opts: { required?: boolean; help?: string } = {}): RStructMember => ({
  m: 'rstruct',
  key,
  label,
  members,
  ...opts,
});

export const counted = (
  countSig: string,
  countSize: CountedMember['countSize'],
  key: string,
  label: string,
  inner: SubMember | RArrayMember,
  opts: { help?: string; prominent?: boolean } = {},
): CountedMember => ({ m: 'counted', countSig, countSize, key, label, inner, ...opts });

export const runion = (key: string, label: string, options: readonly MemberDef[]): RUnionMember => ({ m: 'runion', key, label, options });

export const req = <T extends MemberDef>(m: T): T => ({ ...m, required: true });

export function record(
  sig: string,
  name: string,
  members: readonly MemberDef[],
  opts: { flags?: FlagsDef; category?: RecordCategory; unordered?: boolean } = {},
): RecordDef {
  return { sig, name, members, ...opts };
}

/** Bit list helper: flagList('A', 'B', null, 'D') → {0:'A',1:'B',3:'D'}. */
export function flagList(...names: (string | null)[]): FlagsDef {
  const out: FlagsDef = {};
  names.forEach((n, i) => {
    if (n) out[i] = n;
  });
  return out;
}

export function enumList(...names: string[]): EnumDef {
  const out: EnumDef = {};
  names.forEach((n, i) => (out[i] = n));
  return out;
}
