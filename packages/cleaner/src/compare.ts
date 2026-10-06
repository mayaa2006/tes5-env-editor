/**
 * Record comparison for ITM detection. Two records are "identical" when the
 * game would see the same data: same flags (ignoring compression) and the same
 * subrecords after normalising fields the engine ignores.
 */
import {
  FormIdMapper,
  RecordFlags,
  bytesEqual,
  decodeRecord,
  type Plugin,
  type PluginRecord,
  type Subrecord,
} from '@tes5/esp';

/** Header flags that never make a record different (compression is storage only). */
const IGNORED_FLAGS = RecordFlags.Compressed;

type Normalizer = (subs: Subrecord[]) => Subrecord[];

function zeroBytes(data: Uint8Array, from: number, to: number): Uint8Array {
  if (data.byteLength <= from) return data;
  const c = data.slice();
  c.fill(0, from, Math.min(to, c.byteLength));
  return c;
}

function sortU32Array(data: Uint8Array): Uint8Array {
  const n = Math.floor(data.byteLength / 4);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const vals: number[] = [];
  for (let i = 0; i < n; i++) vals.push(dv.getUint32(i * 4, true));
  vals.sort((a, b) => a - b);
  const out = new Uint8Array(data.byteLength);
  const ov = new DataView(out.buffer);
  vals.forEach((v, i) => ov.setUint32(i * 4, v, true));
  out.set(data.subarray(n * 4), n * 4);
  return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.byteLength - b.byteLength;
}

/** Sort consecutive runs of the given signatures (sets whose order the engine ignores). */
function sortRuns(subs: Subrecord[], sigs: ReadonlySet<string>): Subrecord[] {
  const out: Subrecord[] = [];
  let i = 0;
  while (i < subs.length) {
    const s = subs[i]!;
    if (!sigs.has(s.sig)) {
      out.push(s);
      i++;
      continue;
    }
    let j = i;
    while (j < subs.length && subs[j]!.sig === s.sig) j++;
    out.push(...subs.slice(i, j).sort((a, b) => compareBytes(a.data, b.data)));
    i = j;
  }
  return out;
}

const SORTED_RUNS: Record<string, ReadonlySet<string>> = {
  NPC_: new Set(['SNAM', 'SPLO', 'PRKR', 'PNAM']),
  RACE: new Set(['SPLO']),
  LVLN: new Set(),
};

/** Per-record normalisation of fields xEdit treats as "ignore" for conflicts. */
const NORMALIZERS: Record<string, Normalizer> = {
  // Info count is maintained by the CK and irrelevant to the game.
  DIAL: (subs) => subs.filter((s) => s.sig !== 'TIFC'),
  // DNAM byte 3 is a form version stamp.
  QUST: (subs) => subs.map((s) => (s.sig === 'DNAM' ? { sig: s.sig, data: zeroBytes(s.data, 3, 4) } : s)),
  // ACBS "Disposition Base" is unused.
  NPC_: (subs) => subs.map((s) => (s.sig === 'ACBS' ? { sig: s.sig, data: zeroBytes(s.data, 16, 18) } : s)),
};

export function normalizeSubrecords(sig: string, subs: readonly Subrecord[]): Subrecord[] {
  let out = subs.map((s) => (s.sig === 'KWDA' ? { sig: s.sig, data: sortU32Array(s.data) } : s));
  const runs = SORTED_RUNS[sig];
  if (runs && runs.size) out = sortRuns(out, runs);
  const n = NORMALIZERS[sig];
  if (n) out = n(out);
  return out;
}

/**
 * True when FormIDs stored in `a` (from plugin A) and `b` (from plugin B) can be
 * compared byte-for-byte: every master index used by B means the same file in A.
 */
export function compatibleMasterIndices(a: Plugin, b: Plugin): boolean {
  const aList = [...a.masters, a.fileName].map((s) => s.toLowerCase());
  const bList = [...b.masters, b.fileName].map((s) => s.toLowerCase());
  // B's indices 0..bList.length-1 must refer to the same files in A.
  for (let i = 0; i < bList.length; i++) {
    if (aList[i] !== bList[i]) return false;
  }
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array) return bytesEqual(a, b);
  if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    return a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ka = Object.keys(a).filter((k) => k !== '__order');
  const kb = Object.keys(b).filter((k) => k !== '__order');
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export type CompareResult = 'identical' | 'different' | 'unknown';

/**
 * Compare a record in `pa` with the same form's record in `pb`.
 * Falls back to schema-based comparison when master indices differ.
 */
export function compareRecords(ra: PluginRecord, pa: Plugin, rb: PluginRecord, pb: Plugin): CompareResult {
  if (ra.sig !== rb.sig) return 'different';
  if (((ra.flags ^ rb.flags) & ~IGNORED_FLAGS) !== 0) return 'different';
  if (compatibleMasterIndices(pa, pb)) {
    const na = normalizeSubrecords(ra.sig, ra.subrecords);
    const nb = normalizeSubrecords(rb.sig, rb.subrecords);
    if (na.length !== nb.length) return 'different';
    for (let i = 0; i < na.length; i++) {
      if (na[i]!.sig !== nb[i]!.sig || !bytesEqual(na[i]!.data, nb[i]!.data)) return 'different';
    }
    return 'identical';
  }
  // Different master layouts: compare decoded values with FormIDs mapped to load-order independent keys.
  const ma = new FormIdMapper(pa.fileName, pa.masters);
  const mb = new FormIdMapper(pb.fileName, pb.masters);
  const da = decodeRecord(ra, { mapFormId: (id) => ma.toKey(id) });
  const db = decodeRecord(rb, { mapFormId: (id) => mb.toKey(id) });
  if (!da.hasSchema || !da.lossless || !db.lossless) return 'unknown';
  if (da.unknown.length || db.unknown.length) {
    // Unknown subrecords may contain FormIDs we can't map.
    return 'unknown';
  }
  return deepEqual(da.data, db.data) ? 'identical' : 'different';
}
