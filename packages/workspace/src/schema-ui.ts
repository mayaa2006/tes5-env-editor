/**
 * Serializable description of record schemas for generic form editors.
 * (RecordDef contains functions — union deciders, custom codecs — so it can't
 * cross an IPC boundary as-is.)
 */
import { allRecordDefs, getRecordDef, recordTypeName, type MemberDef, type RecordDef, type ValueDef } from '@tes5/esp';

export type UiValue =
  | { kind: 'int'; size: string; flags?: Record<number, string>; enum?: Record<number, string>; hint?: string; hidden?: boolean; help?: string }
  | { kind: 'float'; hint?: string; hidden?: boolean; help?: string }
  | { kind: 'formid'; refs: string[]; hidden?: boolean; help?: string }
  | { kind: 'string'; localized: boolean; hint?: string; hidden?: boolean; help?: string }
  | { kind: 'bytes'; size?: number; hidden?: boolean }
  | { kind: 'struct'; fields: { key: string; label: string; value: UiValue }[]; hint?: string; hidden?: boolean }
  | { kind: 'array'; of: UiValue; fixed?: number }
  | { kind: 'union'; options: UiValue[] }
  | { kind: 'custom'; name: string }
  | { kind: 'flag' };

export type UiMember =
  | { kind: 'sub'; key: string; label: string; sig: string; value: UiValue; required?: boolean; help?: string }
  | { kind: 'list'; key: string; label: string; of: UiMember; counted?: boolean; help?: string; prominent?: boolean }
  | { kind: 'group'; key: string; label: string; members: UiMember[]; help?: string }
  | { kind: 'choice'; key: string; label: string; options: UiMember[] };

export interface UiRecordSchema {
  sig: string;
  name: string;
  category?: string;
  flags?: Record<number, string>;
  members: UiMember[];
}

function uiValue(v: ValueDef): UiValue {
  switch (v.t) {
    case 'int':
      return { kind: 'int', size: v.size, flags: v.flags, enum: v.enum, hint: v.hint, hidden: v.hidden, help: v.help };
    case 'float':
      return { kind: 'float', hint: v.hint, hidden: v.hidden, help: v.help };
    case 'formid':
      return { kind: 'formid', refs: [...(v.refs ?? [])], hidden: v.hidden, help: v.help };
    case 'zstring':
    case 'fstring':
      return { kind: 'string', localized: false, hint: v.hint, hidden: v.hidden, help: v.help };
    case 'lstring':
      return { kind: 'string', localized: true, hint: v.hint, hidden: v.hidden, help: v.help };
    case 'bytes':
      return { kind: 'bytes', size: v.size, hidden: v.hidden };
    case 'unused':
      return { kind: 'bytes', size: v.size, hidden: true };
    case 'empty':
      return { kind: 'flag' };
    case 'struct':
      return { kind: 'struct', fields: v.fields.map((f) => ({ key: f.key, label: f.label, value: uiValue(f.def) })), hint: v.hint, hidden: v.hidden };
    case 'array':
      return { kind: 'array', of: uiValue(v.of), fixed: typeof v.count === 'number' ? v.count : undefined };
    case 'union':
      return { kind: 'union', options: v.options.map(uiValue) };
    case 'custom':
      return { kind: 'custom', name: v.name };
  }
}

function uiMember(m: MemberDef): UiMember {
  switch (m.m) {
    case 'sub':
      return { kind: 'sub', key: m.key, label: m.label, sig: m.sig, value: uiValue(m.def), required: m.required, help: m.help };
    case 'rarray':
      return { kind: 'list', key: m.key, label: m.label, of: uiMember(m.of), help: m.help, prominent: m.prominent };
    case 'counted': {
      const inner = m.inner.m === 'rarray' ? uiMember(m.inner.of) : uiMember(m.inner);
      if (m.inner.m === 'sub' && m.inner.def.t === 'array') {
        return { kind: 'list', key: m.key, label: m.label, of: { kind: 'sub', key: m.inner.key, label: m.inner.label, sig: m.inner.sig, value: uiValue(m.inner.def.of) }, counted: true, help: m.help, prominent: m.prominent };
      }
      return { kind: 'list', key: m.key, label: m.label, of: inner, counted: true, help: m.help, prominent: m.prominent };
    }
    case 'rstruct':
      return { kind: 'group', key: m.key, label: m.label, members: m.members.map(uiMember), help: m.help };
    case 'runion':
      return { kind: 'choice', key: m.key, label: m.label, options: m.options.map(uiMember) };
  }
}

export function uiSchema(sig: string): UiRecordSchema | undefined {
  const def = getRecordDef(sig);
  return def ? toUi(def) : undefined;
}

function toUi(def: RecordDef): UiRecordSchema {
  return { sig: def.sig, name: def.name, category: def.category, flags: def.flags, members: def.members.map(uiMember) };
}

export function allUiSchemas(): UiRecordSchema[] {
  return allRecordDefs().map(toUi);
}

export { recordTypeName };
