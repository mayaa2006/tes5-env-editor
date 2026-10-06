/**
 * VMAD — the "Virtual Machine Adapter" subrecord that attaches Papyrus scripts
 * (with property values) to a record, plus script fragments for quests,
 * dialogue, packages, scenes and perks.
 *
 * Layout follows UESP's Tes5Mod:Mod_File_Format/VMAD_Field and xEdit.
 */
import { BinaryReader, BinaryWriter } from '../binary';
import { decodeCp1252, encodeCp1252 } from '../text';
import type { CodecContext, CustomCodec } from './types';

export enum VmadPropertyType {
  None = 0,
  Object = 1,
  String = 2,
  Int = 3,
  Float = 4,
  Bool = 5,
  ObjectArray = 11,
  StringArray = 12,
  IntArray = 13,
  FloatArray = 14,
  BoolArray = 15,
}

export const VMAD_TYPE_NAMES: Record<number, string> = {
  0: 'None',
  1: 'Object',
  2: 'String',
  3: 'Int',
  4: 'Float',
  5: 'Bool',
  11: 'Object[]',
  12: 'String[]',
  13: 'Int[]',
  14: 'Float[]',
  15: 'Bool[]',
};

export interface VmadObject {
  /** FormID (mapped through the codec context). Null form = 0. */
  form: unknown;
  /** Quest alias ID, or -1 for none. */
  alias: number;
  /** The unused 16 bits (kept for exact round trips). */
  unused?: number;
}

export type VmadValue = null | VmadObject | string | number | boolean | VmadObject[] | string[] | number[] | boolean[];

export interface VmadProperty {
  name: string;
  type: VmadPropertyType;
  /** 1 = Edited, 3 = Removed. Absent for VMAD version < 4. */
  flags?: number;
  value: VmadValue;
  /** String values that were not valid UTF-8 are kept as cp1252. */
  stringEncoding?: 'cp1252';
}

export interface VmadScript {
  name: string;
  /** 0 Local, 1 Inherited, 2 Removed, 3 Inherited and Removed. Absent for version < 4. */
  flags?: number;
  properties: VmadProperty[];
}

export interface QuestFragment {
  stage: number;
  /** High 16 bits of the stage field (unknown, normally 0). */
  stageUnknown?: number;
  logEntry: number;
  unknown: number;
  scriptName: string;
  fragmentName: string;
}

export interface QuestAliasScripts {
  object: VmadObject;
  version: number;
  objectFormat: number;
  scripts: VmadScript[];
}

export interface SimpleFragment {
  unknown: number;
  scriptName: string;
  fragmentName: string;
}

export interface PerkFragment extends SimpleFragment {
  index: number;
}

export interface ScenePhaseFragment extends SimpleFragment {
  /** 1 = OnStart, 2 = OnCompletion. */
  phaseFlags: number;
  phaseIndex: number;
}

export type VmadFragments =
  | { kind: 'QUST'; extraBindVersion: number; fileName: string; fragments: QuestFragment[] }
  | { kind: 'INFO' | 'PACK'; extraBindVersion: number; flags: number; fileName: string; fragments: SimpleFragment[] }
  | {
      kind: 'SCEN';
      extraBindVersion: number;
      flags: number;
      fileName: string;
      fragments: SimpleFragment[];
      phases: ScenePhaseFragment[];
    }
  | { kind: 'PERK'; extraBindVersion: number; fileName: string; fragments: PerkFragment[] };

export interface Vmad {
  version: number;
  objectFormat: number;
  scripts: VmadScript[];
  fragments?: VmadFragments;
  /** Quest alias scripts (QUST only). */
  aliases?: QuestAliasScripts[];
  /** Bytes that could not be interpreted (kept verbatim). */
  tail?: Uint8Array;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const utf8enc = new TextEncoder();

function readLen16(r: BinaryReader): string {
  return r.lenString(2);
}

function readLen16Utf8(r: BinaryReader): { s: string; cp1252?: true } {
  const n = r.u16();
  const raw = r.bytesView(n);
  try {
    return { s: utf8.decode(raw) };
  } catch {
    return { s: decodeCp1252(raw), cp1252: true };
  }
}

function writeLen16Utf8(w: BinaryWriter, s: string, cp1252?: boolean): void {
  const b = cp1252 ? encodeCp1252(s) : utf8enc.encode(s);
  w.u16(b.byteLength).bytes(b);
}

function readObject(r: BinaryReader, format: number, ctx: CodecContext): VmadObject {
  if (format === 1) {
    const id = r.u32();
    const alias = r.i16();
    const unused = r.u16();
    return { form: ctx.mapFormId ? ctx.mapFormId(id) : id, alias, ...(unused ? { unused } : {}) };
  }
  const unused = r.u16();
  const alias = r.i16();
  const id = r.u32();
  return { form: ctx.mapFormId ? ctx.mapFormId(id) : id, alias, ...(unused ? { unused } : {}) };
}

function writeObject(w: BinaryWriter, o: VmadObject, format: number, ctx: CodecContext): void {
  const id = ctx.unmapFormId ? ctx.unmapFormId(o.form) : Number(o.form ?? 0);
  if (format === 1) {
    w.u32(id).i16(o.alias ?? -1).u16(o.unused ?? 0);
  } else {
    w.u16(o.unused ?? 0).i16(o.alias ?? -1).u32(id);
  }
}

function readScripts(r: BinaryReader, version: number, format: number, ctx: CodecContext): VmadScript[] {
  const count = r.u16();
  const scripts: VmadScript[] = [];
  for (let i = 0; i < count; i++) {
    const name = readLen16(r);
    const flags = version >= 4 ? r.u8() : undefined;
    const pcount = r.u16();
    const properties: VmadProperty[] = [];
    for (let j = 0; j < pcount; j++) {
      const pname = readLen16(r);
      const type = r.u8() as VmadPropertyType;
      const pflags = version >= 4 ? r.u8() : undefined;
      const prop: VmadProperty = { name: pname, type, value: null };
      if (pflags !== undefined) prop.flags = pflags;
      switch (type) {
        case VmadPropertyType.None:
          prop.value = null;
          break;
        case VmadPropertyType.Object:
          prop.value = readObject(r, format, ctx);
          break;
        case VmadPropertyType.String: {
          const s = readLen16Utf8(r);
          prop.value = s.s;
          if (s.cp1252) prop.stringEncoding = 'cp1252';
          break;
        }
        case VmadPropertyType.Int:
          prop.value = r.i32();
          break;
        case VmadPropertyType.Float:
          prop.value = r.f32();
          break;
        case VmadPropertyType.Bool:
          prop.value = r.u8() !== 0;
          break;
        case VmadPropertyType.ObjectArray: {
          const n = r.u32();
          const arr: VmadObject[] = [];
          for (let k = 0; k < n; k++) arr.push(readObject(r, format, ctx));
          prop.value = arr;
          break;
        }
        case VmadPropertyType.StringArray: {
          const n = r.u32();
          const arr: string[] = [];
          for (let k = 0; k < n; k++) {
            const s = readLen16Utf8(r);
            if (s.cp1252) prop.stringEncoding = 'cp1252';
            arr.push(s.s);
          }
          prop.value = arr;
          break;
        }
        case VmadPropertyType.IntArray: {
          const n = r.u32();
          const arr: number[] = [];
          for (let k = 0; k < n; k++) arr.push(r.i32());
          prop.value = arr;
          break;
        }
        case VmadPropertyType.FloatArray: {
          const n = r.u32();
          const arr: number[] = [];
          for (let k = 0; k < n; k++) arr.push(r.f32());
          prop.value = arr;
          break;
        }
        case VmadPropertyType.BoolArray: {
          const n = r.u32();
          const arr: boolean[] = [];
          for (let k = 0; k < n; k++) arr.push(r.u8() !== 0);
          prop.value = arr;
          break;
        }
        default:
          throw new Error(`Unknown VMAD property type ${type} for ${name}.${pname}`);
      }
      properties.push(prop);
    }
    const script: VmadScript = { name, properties };
    if (flags !== undefined) script.flags = flags;
    scripts.push(script);
  }
  return scripts;
}

function writeScripts(w: BinaryWriter, scripts: readonly VmadScript[], version: number, format: number, ctx: CodecContext): void {
  w.u16(scripts.length);
  for (const s of scripts) {
    w.lenString(s.name, 2);
    if (version >= 4) w.u8(s.flags ?? 0);
    w.u16(s.properties.length);
    for (const p of s.properties) {
      w.lenString(p.name, 2);
      w.u8(p.type);
      if (version >= 4) w.u8(p.flags ?? 1);
      const cp = p.stringEncoding === 'cp1252';
      switch (p.type) {
        case VmadPropertyType.None:
          break;
        case VmadPropertyType.Object:
          writeObject(w, (p.value ?? { form: 0, alias: -1 }) as VmadObject, format, ctx);
          break;
        case VmadPropertyType.String:
          writeLen16Utf8(w, String(p.value ?? ''), cp);
          break;
        case VmadPropertyType.Int:
          w.i32(Number(p.value ?? 0));
          break;
        case VmadPropertyType.Float:
          w.f32(Number(p.value ?? 0));
          break;
        case VmadPropertyType.Bool:
          w.u8(p.value ? 1 : 0);
          break;
        case VmadPropertyType.ObjectArray: {
          const arr = (p.value ?? []) as VmadObject[];
          w.u32(arr.length);
          for (const o of arr) writeObject(w, o, format, ctx);
          break;
        }
        case VmadPropertyType.StringArray: {
          const arr = (p.value ?? []) as string[];
          w.u32(arr.length);
          for (const v of arr) writeLen16Utf8(w, v, cp);
          break;
        }
        case VmadPropertyType.IntArray: {
          const arr = (p.value ?? []) as number[];
          w.u32(arr.length);
          for (const v of arr) w.i32(v);
          break;
        }
        case VmadPropertyType.FloatArray: {
          const arr = (p.value ?? []) as number[];
          w.u32(arr.length);
          for (const v of arr) w.f32(v);
          break;
        }
        case VmadPropertyType.BoolArray: {
          const arr = (p.value ?? []) as boolean[];
          w.u32(arr.length);
          for (const v of arr) w.u8(v ? 1 : 0);
          break;
        }
      }
    }
  }
}

function popcount(n: number): number {
  let c = 0;
  while (n) {
    c += n & 1;
    n >>>= 1;
  }
  return c;
}

function readSimpleFragment(r: BinaryReader): SimpleFragment {
  return { unknown: r.u8(), scriptName: readLen16(r), fragmentName: readLen16(r) };
}

function writeSimpleFragment(w: BinaryWriter, f: SimpleFragment): void {
  w.u8(f.unknown ?? 0).lenString(f.scriptName, 2).lenString(f.fragmentName, 2);
}

export function decodeVmad(data: Uint8Array, recordSig: string, ctx: CodecContext): Vmad {
  const r = new BinaryReader(data);
  const version = r.i16();
  const objectFormat = r.i16();
  const scripts = readScripts(r, version, objectFormat, ctx);
  const vmad: Vmad = { version, objectFormat, scripts };
  if (r.eof) return vmad;
  const fragStart = r.pos;
  try {
    switch (recordSig) {
      case 'QUST': {
        const extraBindVersion = r.i8();
        const count = r.u16();
        const fileName = readLen16(r);
        const fragments: QuestFragment[] = [];
        for (let i = 0; i < count; i++) {
          const stage = r.u16();
          const stageUnknown = r.u16();
          const logEntry = r.u32();
          const unknown = r.u8();
          const f: QuestFragment = { stage, logEntry, unknown, scriptName: readLen16(r), fragmentName: readLen16(r) };
          if (stageUnknown) f.stageUnknown = stageUnknown;
          fragments.push(f);
        }
        vmad.fragments = { kind: 'QUST', extraBindVersion, fileName, fragments };
        const aliasCount = r.u16();
        const aliases: QuestAliasScripts[] = [];
        for (let i = 0; i < aliasCount; i++) {
          const object = readObject(r, objectFormat, ctx);
          const av = r.i16();
          const af = r.i16();
          aliases.push({ object, version: av, objectFormat: af, scripts: readScripts(r, av, af, ctx) });
        }
        vmad.aliases = aliases;
        break;
      }
      case 'INFO':
      case 'PACK': {
        const extraBindVersion = r.i8();
        const flags = r.u8();
        const fileName = readLen16(r);
        const fragments: SimpleFragment[] = [];
        const n = popcount(flags);
        for (let i = 0; i < n; i++) fragments.push(readSimpleFragment(r));
        vmad.fragments = { kind: recordSig, extraBindVersion, flags, fileName, fragments };
        break;
      }
      case 'SCEN': {
        const extraBindVersion = r.i8();
        const flags = r.u8();
        const fileName = readLen16(r);
        const fragments: SimpleFragment[] = [];
        const n = popcount(flags);
        for (let i = 0; i < n; i++) fragments.push(readSimpleFragment(r));
        const pcount = r.u16();
        const phases: ScenePhaseFragment[] = [];
        for (let i = 0; i < pcount; i++) {
          const phaseFlags = r.u8();
          const phaseIndex = r.u32();
          phases.push({ phaseFlags, phaseIndex, ...readSimpleFragment(r) });
        }
        vmad.fragments = { kind: 'SCEN', extraBindVersion, flags, fileName, fragments, phases };
        break;
      }
      case 'PERK': {
        const extraBindVersion = r.i8();
        const fileName = readLen16(r);
        const count = r.u16();
        const fragments: PerkFragment[] = [];
        for (let i = 0; i < count; i++) {
          const index = r.u32();
          fragments.push({ index, ...readSimpleFragment(r) });
        }
        vmad.fragments = { kind: 'PERK', extraBindVersion, fileName, fragments };
        break;
      }
      default:
        vmad.tail = data.subarray(fragStart).slice();
        return vmad;
    }
  } catch {
    // Unparseable fragment data: keep it verbatim.
    delete vmad.fragments;
    delete vmad.aliases;
    vmad.tail = data.subarray(fragStart).slice();
    return vmad;
  }
  if (!r.eof) vmad.tail = data.subarray(r.pos).slice();
  return vmad;
}

export function encodeVmad(v: Vmad, recordSig: string, ctx: CodecContext): Uint8Array {
  const w = new BinaryWriter(256);
  w.i16(v.version).i16(v.objectFormat);
  writeScripts(w, v.scripts, v.version, v.objectFormat, ctx);
  let f = v.fragments;
  if (!f && recordSig === 'QUST' && v.aliases && v.aliases.length) {
    // Alias scripts can only be stored after a (possibly empty) fragments section.
    f = { kind: 'QUST', extraBindVersion: 2, fileName: '', fragments: [] };
  }
  if (f) {
    switch (f.kind) {
      case 'QUST': {
        w.i8(f.extraBindVersion).u16(f.fragments.length).lenString(f.fileName, 2);
        for (const q of f.fragments) {
          w.u16(q.stage).u16(q.stageUnknown ?? 0).u32(q.logEntry).u8(q.unknown ?? 0);
          w.lenString(q.scriptName, 2).lenString(q.fragmentName, 2);
        }
        const aliases = v.aliases ?? [];
        w.u16(aliases.length);
        for (const a of aliases) {
          writeObject(w, a.object, v.objectFormat, ctx);
          w.i16(a.version).i16(a.objectFormat);
          writeScripts(w, a.scripts, a.version, a.objectFormat, ctx);
        }
        break;
      }
      case 'INFO':
      case 'PACK':
        w.i8(f.extraBindVersion).u8(f.flags).lenString(f.fileName, 2);
        for (const x of f.fragments) writeSimpleFragment(w, x);
        break;
      case 'SCEN':
        w.i8(f.extraBindVersion).u8(f.flags).lenString(f.fileName, 2);
        for (const x of f.fragments) writeSimpleFragment(w, x);
        w.u16(f.phases.length);
        for (const p of f.phases) {
          w.u8(p.phaseFlags).u32(p.phaseIndex);
          writeSimpleFragment(w, p);
        }
        break;
      case 'PERK':
        w.i8(f.extraBindVersion).lenString(f.fileName, 2).u16(f.fragments.length);
        for (const x of f.fragments) {
          w.u32(x.index);
          writeSimpleFragment(w, x);
        }
        break;
    }
  }
  if (v.tail) w.bytes(v.tail);
  return w.toBytes();
}

export const vmadCodec: CustomCodec<Vmad> = {
  decode(r, size, ctx) {
    const data = r.bytesView(size);
    return decodeVmad(data, ctx.recordSig, ctx);
  },
  encode(w, v, ctx) {
    w.bytes(encodeVmad(v, ctx.recordSig, ctx));
  },
  describe(v) {
    return v.scripts.map((s) => s.name).join(', ') || '(no scripts)';
  },
};

export function newVmad(): Vmad {
  return { version: 5, objectFormat: 2, scripts: [] };
}
