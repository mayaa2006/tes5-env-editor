import type { PluginRecord, Subrecord } from '../record';
import { subrecordsEqual } from '../record';
import { decodeRecordData, encodeRecordData } from './codec';
import { getRecordDef } from './defs';
import type { CodecContext, RecordDef, UnknownSub } from './types';

export interface TypedRecord {
  sig: string;
  formId: number;
  flags: number;
  /** Decoded fields keyed by member key. */
  data: Record<string, unknown>;
  /** Subrecords the schema didn't recognise. */
  unknown: UnknownSub[];
  errors: string[];
  /**
   * True when re-encoding the decoded data reproduces the stored subrecords
   * exactly. Records that are not lossless are only edited through the raw
   * subrecord view, so a schema gap can never corrupt data.
   */
  lossless: boolean;
  /** Undefined when no typed schema exists for the signature. */
  hasSchema: boolean;
}

export function defaultCodecContext(recordSig: string, partial: Partial<CodecContext> = {}): CodecContext {
  return { localized: false, recordSig, formVersion: 44, ...partial };
}

export function decodeRecord(rec: PluginRecord, ctx: Partial<CodecContext> = {}): TypedRecord {
  const def = getRecordDef(rec.sig);
  const subs = rec.subrecords;
  if (!def) {
    return {
      sig: rec.sig,
      formId: rec.formId,
      flags: rec.flags,
      data: {},
      unknown: subs.map((s, index) => ({ index, sig: s.sig, data: s.data })),
      errors: [],
      lossless: true,
      hasSchema: false,
    };
  }
  const c = defaultCodecContext(rec.sig, { formVersion: rec.formVersion, ...ctx });
  const res = decodeRecordData(def, subs, c);
  let lossless = res.errors.length === 0;
  if (lossless) {
    try {
      // Check the raw round trip: FormIDs as stored and localized strings as IDs.
      // (Mapping FormIDs to keys or IDs to text is a presentation concern.)
      const rawCtx = defaultCodecContext(rec.sig, { formVersion: rec.formVersion, localized: c.localized });
      const raw = ctx.mapFormId || ctx.lookupString ? decodeRecordData(def, subs, rawCtx) : res;
      const again = encodeRecordData(def, raw.data, rawCtx, raw.unknown);
      lossless = raw.errors.length === 0 && subrecordsEqual(again, subs);
    } catch {
      lossless = false;
    }
  }
  return { sig: rec.sig, formId: rec.formId, flags: rec.flags, data: res.data, unknown: res.unknown, errors: res.errors, lossless, hasSchema: true };
}

export function encodeTyped(def: RecordDef, data: Record<string, unknown>, unknown: readonly UnknownSub[], ctx: Partial<CodecContext> = {}): Subrecord[] {
  return encodeRecordData(def, data, defaultCodecContext(def.sig, ctx), unknown);
}

/** Write typed data back into a record. */
export function applyTyped(rec: PluginRecord, data: Record<string, unknown>, unknown: readonly UnknownSub[] = [], ctx: Partial<CodecContext> = {}): void {
  const def = getRecordDef(rec.sig);
  if (!def) throw new Error(`No schema for ${rec.sig}; edit its subrecords directly`);
  rec.subrecords = encodeTyped(def, data, unknown, { formVersion: rec.formVersion, ...ctx });
}

/** Get a nested value by path like "config.flags" or "stages.0.index". */
export function getPath(obj: unknown, path: string | readonly (string | number)[]): unknown {
  const parts = typeof path === 'string' ? path.split('.').filter(Boolean) : path;
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string | number, unknown>)[p];
  }
  return cur;
}

/** Immutable set of a nested value; intermediate objects/arrays are copied. */
export function setPath<T>(obj: T, path: string | readonly (string | number)[], value: unknown): T {
  const parts = typeof path === 'string' ? path.split('.').filter(Boolean) : path;
  if (parts.length === 0) return value as T;
  const [head, ...rest] = parts as (string | number)[];
  const isIndex = typeof head === 'number' || /^\d+$/.test(String(head));
  const src = (obj ?? (isIndex ? [] : {})) as Record<string | number, unknown>;
  const copy: Record<string | number, unknown> = Array.isArray(src) ? ([...src] as unknown as Record<number, unknown>) : { ...src };
  // A struct that was stored truncated is completed once a field is set explicitly.
  if (!Array.isArray(src) && rest.length === 0) {
    delete copy.__truncated;
    delete copy.__tail;
  }
  copy[head!] = setPath(src[head!], rest, value);
  return copy as T;
}
