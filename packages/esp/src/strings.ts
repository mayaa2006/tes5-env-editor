import { BinaryReader, BinaryWriter } from './binary';
import { decodeText, encodeText, type TextEncodingName } from './text';

export type StringsKind = 'STRINGS' | 'DLSTRINGS' | 'ILSTRINGS';

/**
 * Localized string tables (`Strings/<Plugin>_<Language>.STRINGS` etc.).
 * STRINGS holds short names, DLSTRINGS descriptions, ILSTRINGS dialogue.
 */
export class StringTable {
  readonly entries = new Map<number, string>();

  constructor(readonly kind: StringsKind) {}

  get(id: number): string | undefined {
    return this.entries.get(id >>> 0);
  }

  set(id: number, value: string): void {
    this.entries.set(id >>> 0, value);
  }

  nextId(): number {
    let max = 0;
    for (const id of this.entries.keys()) if (id > max) max = id;
    return max + 1;
  }

  static parse(bytes: Uint8Array, kind: StringsKind, encoding: TextEncodingName = 'cp1252'): StringTable {
    const t = new StringTable(kind);
    const r = new BinaryReader(bytes);
    const count = r.u32();
    const dataSize = r.u32();
    const dirStart = 8;
    const dataStart = dirStart + count * 8;
    if (dataStart + dataSize > bytes.byteLength) throw new Error(`${kind}: string data exceeds file size`);
    for (let i = 0; i < count; i++) {
      const id = r.u32();
      const offset = r.u32();
      const at = dataStart + offset;
      if (kind === 'STRINGS') {
        let end = at;
        while (end < bytes.byteLength && bytes[end] !== 0) end++;
        t.entries.set(id, decodeText(bytes.subarray(at, end), encoding));
      } else {
        const len = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, true);
        let raw = bytes.subarray(at + 4, at + 4 + len);
        if (raw.byteLength && raw[raw.byteLength - 1] === 0) raw = raw.subarray(0, raw.byteLength - 1);
        t.entries.set(id, decodeText(raw, encoding));
      }
    }
    return t;
  }

  serialize(encoding: TextEncodingName = 'cp1252'): Uint8Array {
    const ids = [...this.entries.keys()].sort((a, b) => a - b);
    const data = new BinaryWriter(1024);
    const offsets: number[] = [];
    for (const id of ids) {
      offsets.push(data.pos);
      const enc = encodeText(this.entries.get(id)!, encoding);
      if (this.kind !== 'STRINGS') data.u32(enc.byteLength + 1);
      data.bytes(enc).u8(0);
    }
    const w = new BinaryWriter(8 + ids.length * 8 + data.pos);
    w.u32(ids.length).u32(data.pos);
    ids.forEach((id, i) => w.u32(id).u32(offsets[i]!));
    w.bytes(data.toBytes());
    return w.toBytes();
  }
}

/** File names of the three string tables for a plugin and language. */
export function stringsFileNames(pluginFileName: string, language = 'english'): Record<StringsKind, string> {
  const base = pluginFileName.replace(/\.(esm|esp|esl)$/i, '');
  return {
    STRINGS: `Strings/${base}_${language}.STRINGS`,
    DLSTRINGS: `Strings/${base}_${language}.DLSTRINGS`,
    ILSTRINGS: `Strings/${base}_${language}.ILSTRINGS`,
  };
}

/** Which table a localized subrecord's string lives in (same rules as the game / xEdit). */
export function stringsKindFor(recordSig: string, subSig: string): StringsKind {
  if (recordSig !== 'LSCR' && subSig === 'DESC') return 'DLSTRINGS';
  if (recordSig === 'QUST' && subSig === 'CNAM') return 'DLSTRINGS';
  if (recordSig === 'BOOK' && subSig === 'CNAM') return 'DLSTRINGS';
  if (recordSig === 'INFO' && subSig !== 'RNAM') return 'ILSTRINGS';
  return 'STRINGS';
}
