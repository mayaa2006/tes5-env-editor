/**
 * BodySlide / Outfit Studio shape data: the morphs ("diffs") behind each
 * slider. An `.osd` file holds many named diffs; each is a sparse list of
 * vertex index → offset, in the shape's own (stored vertex) space.
 *
 *   u32 magic 'OSD\0' (written by MSVC as the bytes 00 'D' 'S' 'O'), u32 version 1, u32 count,
 *   count × { u8 nameLength, name, u16 diffCount, diffCount × { u16 vertex, f32 x, y, z } }
 *
 * Older sets keep one diff per `.bsd` file: u32 count, then count × { index, f32 x, y, z },
 * the index being a u16 or a u32 depending on the tool version (told apart by the file size).
 */

export interface ShapeDiff {
  /** Vertex indices, ascending as stored. */
  indices: Uint32Array;
  /** x, y, z offset per entry in `indices`. */
  deltas: Float32Array;
}

export function isOsd(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  const tag = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  return tag === '\0DSO' || tag === 'OSD\0';
}

export function parseOsd(bytes: Uint8Array): Map<string, ShapeDiff> {
  if (!isOsd(bytes)) throw new Error('Not a BodySlide shape data (.osd) file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint32(4, true);
  if (version !== 1) throw new Error(`Unsupported .osd version ${version}`);
  const count = dv.getUint32(8, true);
  const out = new Map<string, ShapeDiff>();
  let p = 12;
  const need = (n: number) => {
    if (p + n > bytes.byteLength) throw new Error('The .osd file is cut short');
  };
  for (let i = 0; i < count; i++) {
    need(1);
    const len = bytes[p++]!;
    need(len + 2);
    const name = String.fromCharCode(...bytes.subarray(p, p + len));
    p += len;
    const n = dv.getUint16(p, true);
    p += 2;
    need(n * 14);
    const indices = new Uint32Array(n);
    const deltas = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      indices[k] = dv.getUint16(p, true);
      deltas[k * 3] = dv.getFloat32(p + 2, true);
      deltas[k * 3 + 1] = dv.getFloat32(p + 6, true);
      deltas[k * 3 + 2] = dv.getFloat32(p + 10, true);
      p += 14;
    }
    out.set(name, { indices, deltas });
  }
  return out;
}

export function writeOsd(diffs: ReadonlyMap<string, ShapeDiff> | Record<string, ShapeDiff>): Uint8Array {
  const entries = diffs instanceof Map ? [...diffs.entries()] : Object.entries(diffs);
  let size = 12;
  for (const [name, d] of entries) {
    if (name.length > 255) throw new Error(`Diff name too long: ${name}`);
    if (d.indices.length > 0xffff) throw new Error(`Too many changed vertices in ${name}`);
    size += 1 + name.length + 2 + d.indices.length * 14;
  }
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out.set([0, 0x44, 0x53, 0x4f], 0);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, entries.length, true);
  let p = 12;
  for (const [name, d] of entries) {
    out[p++] = name.length;
    for (let i = 0; i < name.length; i++) out[p++] = name.charCodeAt(i) & 0xff;
    dv.setUint16(p, d.indices.length, true);
    p += 2;
    for (let k = 0; k < d.indices.length; k++) {
      if (d.indices[k]! > 0xffff) throw new Error(`Vertex ${d.indices[k]} is past what .osd files can address`);
      dv.setUint16(p, d.indices[k]!, true);
      dv.setFloat32(p + 2, d.deltas[k * 3]!, true);
      dv.setFloat32(p + 6, d.deltas[k * 3 + 1]!, true);
      dv.setFloat32(p + 10, d.deltas[k * 3 + 2]!, true);
      p += 14;
    }
  }
  return out;
}

/** One diff from an old-style `.bsd` file. */
export function parseBsd(bytes: Uint8Array): ShapeDiff {
  if (bytes.byteLength < 4) throw new Error('The .bsd file is empty');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(0, true);
  const stride = bytes.byteLength === 4 + n * 16 ? 16 : bytes.byteLength === 4 + n * 14 ? 14 : 0;
  if (!stride) throw new Error('Unrecognised .bsd layout');
  const indices = new Uint32Array(n);
  const deltas = new Float32Array(n * 3);
  for (let k = 0, p = 4; k < n; k++, p += stride) {
    indices[k] = stride === 16 ? dv.getUint32(p, true) : dv.getUint16(p, true);
    const o = p + stride - 12;
    deltas[k * 3] = dv.getFloat32(o, true);
    deltas[k * 3 + 1] = dv.getFloat32(o + 4, true);
    deltas[k * 3 + 2] = dv.getFloat32(o + 8, true);
  }
  return { indices, deltas };
}
