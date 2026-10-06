/**
 * Text codecs. Skyrim stores strings as Windows-1252 (English and most western
 * languages). The codec below is bijective over all 256 byte values: the five
 * bytes that are undefined in cp1252 map to the C1 control code point with the
 * same value, so decode → encode always reproduces the original bytes.
 */

const HIGH: readonly number[] = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

const REVERSE = new Map<number, number>();
HIGH.forEach((cp, i) => REVERSE.set(cp, 0x80 + i));

export function decodeCp1252(bytes: Uint8Array): string {
  let out = '';
  // Build in chunks to avoid quadratic string concatenation on huge inputs.
  const CHUNK = 4096;
  const codes: number[] = [];
  for (let i = 0; i < bytes.byteLength; i++) {
    const b = bytes[i]!;
    codes.push(b >= 0x80 && b < 0xa0 ? HIGH[b - 0x80]! : b);
    if (codes.length === CHUNK) {
      out += String.fromCharCode(...codes);
      codes.length = 0;
    }
  }
  if (codes.length) out += String.fromCharCode(...codes);
  return out;
}

export function encodeCp1252(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out[i] = c;
    else out[i] = REVERSE.get(c) ?? 0x3f; // '?'
  }
  return out;
}

/** Characters of `s` that Windows-1252 can't represent (they would be saved as "?"). */
export function cp1252Unencodable(s: string): string[] {
  const bad = new Set<string>();
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (!(c < 0x80 || (c >= 0xa0 && c <= 0xff) || REVERSE.has(c))) bad.add(ch);
  }
  return [...bad];
}

const utf8Decoder = new TextDecoder('utf-8');
const utf8Encoder = new TextEncoder();

export function decodeUtf8(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

export function encodeUtf8(s: string): Uint8Array {
  return utf8Encoder.encode(s);
}

export type TextEncodingName = 'cp1252' | 'utf8';

export function decodeText(bytes: Uint8Array, enc: TextEncodingName = 'cp1252'): string {
  return enc === 'utf8' ? decodeUtf8(bytes) : decodeCp1252(bytes);
}

export function encodeText(s: string, enc: TextEncodingName = 'cp1252'): Uint8Array {
  return enc === 'utf8' ? encodeUtf8(s) : encodeCp1252(s);
}

/** Case-insensitive comparison used for file names and editor IDs. */
export function eqi(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
