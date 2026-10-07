/**
 * Block-level NIF editing for Skyrim LE (BS 83) and SE (BS 100): read a file
 * as raw blocks, find the links (refs, pointers, string indices) inside the
 * block types character heads use, change vertex positions in place, and
 * copy shapes from several files into one. Everything not touched stays
 * byte-for-byte as the original modeller wrote it, which is what keeps
 * skinning, partitions and shader settings valid in game.
 *
 * Used to bake FaceGen head meshes (see workspace/facegen.ts).
 */
import { NODE_TYPES, parseNif, readGeometryBlock, skinPartitionTriangles, splitNif, type Mat4, type NifNode } from './nif';

export interface NifBlock {
  type: string;
  data: Uint8Array;
}

export interface NifDoc {
  userVersion: number;
  bsVersion: number;
  strings: string[];
  blocks: NifBlock[];
  roots: number[];
}

/** Where a link sits inside a block, and what it points at. */
export interface NifLink {
  offset: number;
  kind: 'ref' | 'child' | 'string' | 'skeleton' | 'bone';
}

export const NIF_NODE_TYPES: ReadonlySet<string> = new Set([...NODE_TYPES, 'BSFaceGenNiNode']);
const SHAPE_TYPES = new Set(['BSTriShape', 'BSDynamicTriShape', 'NiTriShape']);
const EXTRA_DATA_TYPES = new Set(['NiStringExtraData', 'NiIntegerExtraData', 'BSXFlags', 'NiFloatExtraData', 'NiBooleanExtraData', 'NiBinaryExtraData', 'NiStringsExtraData', 'NiIntegersExtraData']);

export function readNifDoc(bytes: Uint8Array): NifDoc {
  const s = splitNif(bytes);
  if (s.bsVersion !== 83 && s.bsVersion !== 100) throw new Error(`Only Skyrim LE and SE meshes can be edited (this one is Bethesda stream ${s.bsVersion})`);
  return { userVersion: s.userVersion, bsVersion: s.bsVersion, strings: [...s.strings], blocks: s.blocks, roots: s.roots };
}

export function writeNifDoc(doc: NifDoc): Uint8Array {
  const types: string[] = [];
  const typeIdx = doc.blocks.map((b) => {
    let i = types.indexOf(b.type);
    if (i < 0) i = types.push(b.type) - 1;
    return i;
  });
  const enc = (s: string) => Array.from(s, (c) => c.charCodeAt(0) & 0xff);
  const out: number[] = [];
  const u8 = (v: number) => out.push(v & 0xff);
  const u16 = (v: number) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v: number) => out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const sized = (s: string) => {
    u32(s.length);
    out.push(...enc(s));
  };
  const exportString = (s: string) => {
    u8(s.length + 1);
    out.push(...enc(s), 0);
  };
  out.push(...enc('Gamebryo File Format, Version 20.2.0.7\n'));
  u32(0x14020007);
  u8(1);
  u32(doc.userVersion);
  u32(doc.blocks.length);
  u32(doc.bsVersion);
  exportString('tes5-env-editor');
  exportString(''); // process script (BS < 131)
  exportString('');
  u16(types.length);
  for (const t of types) sized(t);
  for (const t of typeIdx) u16(t);
  for (const b of doc.blocks) u32(b.data.byteLength);
  u32(doc.strings.length);
  u32(doc.strings.reduce((m, s) => Math.max(m, s.length), 0));
  for (const s of doc.strings) sized(s);
  u32(0); // groups
  const head = new Uint8Array(out);
  const total = head.byteLength + doc.blocks.reduce((n, b) => n + b.data.byteLength, 0) + 4 + doc.roots.length * 4;
  const file = new Uint8Array(total);
  file.set(head, 0);
  let p = head.byteLength;
  for (const b of doc.blocks) {
    file.set(b.data, p);
    p += b.data.byteLength;
  }
  const dv = new DataView(file.buffer);
  dv.setUint32(p, doc.roots.length, true);
  p += 4;
  for (const r of doc.roots) {
    dv.setInt32(p, r, true);
    p += 4;
  }
  return file;
}

/** A forward-only cursor over one block's bytes. */
class Cursor {
  readonly dv: DataView;
  constructor(
    readonly data: Uint8Array,
    public pos = 0,
  ) {
    this.dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  u8() {
    return this.data[this.pos++]!;
  }
  u16() {
    const v = this.dv.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32() {
    const v = this.dv.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  skip(n: number) {
    this.pos += n;
  }
}

/** Offsets inside NiObjectNET / NiAVObject that later code needs. */
interface AvLayout {
  /** Offset of the translation (then rotation, then scale). */
  transform: number;
  end: number;
}

function net(c: Cursor, links: NifLink[], lighting: boolean): void {
  if (lighting) c.skip(4); // shader type
  links.push({ offset: c.pos, kind: 'string' });
  c.skip(4);
  const n = c.u32();
  for (let i = 0; i < n; i++) {
    links.push({ offset: c.pos, kind: 'ref' });
    c.skip(4);
  }
  links.push({ offset: c.pos, kind: 'ref' }); // controller
  c.skip(4);
}

function av(c: Cursor, links: NifLink[]): AvLayout {
  net(c, links, false);
  c.skip(4); // flags (BS > 26)
  const transform = c.pos;
  c.skip(12 + 36 + 4);
  links.push({ offset: c.pos, kind: 'ref' }); // collision
  c.skip(4);
  return { transform, end: c.pos };
}

/** Byte layout of a block, as far as editing needs it. */
export interface BlockLayout {
  links: NifLink[];
  av?: AvLayout;
  /** BSTriShape family: offsets of the bound, vertex data and dynamic vertices. */
  bsShape?: { bound: number; desc: bigint; vertexSize: number; numVertices: number; vertexData: number; hasData: boolean; dynamic?: number };
  /** NiTriShapeData: offsets of the arrays. */
  niData?: { numVertices: number; vertices: number; normals?: number; tangents?: number; bitangents?: number; bound: number };
  /** NiSkinPartition (SE): the copy of the vertex data the game skins from. */
  partition?: { desc: bigint; vertexSize: number; count: number; vertexData: number };
  /** BSLightingShaderProperty: shader type and where the type-specific colour starts. */
  shader?: { type: number; textureSet: number; typeSpecific: number };
}

/** The layout of block `i`, or undefined when the block type isn't understood (it is then dropped when copying). */
export function blockLayout(doc: NifDoc, i: number): BlockLayout | undefined {
  const b = doc.blocks[i];
  if (!b) return undefined;
  const c = new Cursor(b.data);
  const links: NifLink[] = [];
  const t = b.type;
  if (NIF_NODE_TYPES.has(t)) {
    const a = av(c, links);
    const n = c.u32();
    for (let k = 0; k < n; k++) {
      links.push({ offset: c.pos, kind: 'child' });
      c.skip(4);
    }
    const e = c.u32();
    for (let k = 0; k < e; k++) {
      links.push({ offset: c.pos, kind: 'ref' });
      c.skip(4);
    }
    return { links, av: a };
  }
  if (t === 'BSTriShape' || t === 'BSDynamicTriShape') {
    const a = av(c, links);
    const bound = c.pos;
    c.skip(16);
    links.push({ offset: c.pos, kind: 'ref' }, { offset: c.pos + 4, kind: 'ref' }, { offset: c.pos + 8, kind: 'ref' });
    c.skip(12);
    const desc = c.dv.getBigUint64(c.pos, true);
    c.skip(8);
    const numTriangles = c.u16();
    const numVertices = c.u16();
    const dataSize = c.u32();
    const vertexSize = Number(desc & 0xfn) * 4;
    const vertexData = c.pos;
    if (dataSize > 0) c.skip(vertexSize * numVertices + numTriangles * 6);
    let dynamic: number | undefined;
    if (doc.bsVersion === 100) {
      const particle = c.u32();
      if (particle > 0) c.skip(numVertices * 12 + numTriangles * 6);
    }
    if (t === 'BSDynamicTriShape') {
      c.skip(4);
      dynamic = c.pos;
    }
    return { links, av: a, bsShape: { bound, desc, vertexSize, numVertices, vertexData, hasData: dataSize > 0, dynamic } };
  }
  if (t === 'NiTriShape' || t === 'NiTriStrips') {
    const a = av(c, links);
    links.push({ offset: c.pos, kind: 'ref' }, { offset: c.pos + 4, kind: 'ref' }); // data, skin instance
    c.skip(8);
    const m = c.u32();
    for (let k = 0; k < m; k++) {
      links.push({ offset: c.pos, kind: 'string' });
      c.skip(4);
    }
    c.skip(m * 4 + 4 + 1); // material extra data, active material, dirty flag
    links.push({ offset: c.pos, kind: 'ref' }, { offset: c.pos + 4, kind: 'ref' }); // shader, alpha
    return { links, av: a };
  }
  if (t === 'NiTriShapeData' || t === 'NiTriStripsData') {
    c.skip(4);
    const numVertices = c.u16();
    c.skip(2);
    const hasVertices = c.u8() !== 0;
    const vertices = c.pos;
    if (hasVertices) c.skip(numVertices * 12);
    const flags = c.u16();
    c.skip(4); // material CRC
    const hasNormals = c.u8() !== 0;
    let normals: number | undefined;
    let tangents: number | undefined;
    let bitangents: number | undefined;
    if (hasNormals) {
      normals = c.pos;
      c.skip(numVertices * 12);
      if (flags & 4096) {
        tangents = c.pos;
        bitangents = c.pos + numVertices * 12;
        c.skip(numVertices * 24);
      }
    }
    const bound = c.pos;
    c.skip(16);
    if (c.u8() !== 0) c.skip(numVertices * 16);
    c.skip((flags & 1) * numVertices * 8);
    c.skip(2); // consistency
    links.push({ offset: c.pos, kind: 'ref' }); // additional data
    return { links, niData: { numVertices: hasVertices ? numVertices : 0, vertices, normals, tangents, bitangents, bound } };
  }
  if (t === 'NiSkinInstance' || t === 'BSDismemberSkinInstance') {
    links.push({ offset: 0, kind: 'ref' }, { offset: 4, kind: 'ref' }, { offset: 8, kind: 'skeleton' });
    c.skip(12);
    const n = c.u32();
    for (let k = 0; k < n; k++) {
      links.push({ offset: c.pos, kind: 'bone' });
      c.skip(4);
    }
    return { links };
  }
  if (t === 'NiSkinPartition') {
    if (doc.bsVersion !== 100) return { links };
    c.skip(4);
    const dataSize = c.u32();
    const vertexSize = c.u32();
    const desc = c.dv.getBigUint64(c.pos, true);
    c.skip(8);
    return { links, partition: { desc, vertexSize, count: vertexSize ? dataSize / vertexSize : 0, vertexData: c.pos } };
  }
  if (t === 'NiSkinData' || t === 'BSShaderTextureSet') return { links };
  if (t === 'BSLightingShaderProperty') {
    const type = c.dv.getUint32(0, true);
    net(c, links, true);
    c.skip(8 + 16);
    const textureSet = c.pos;
    links.push({ offset: c.pos, kind: 'ref' });
    c.skip(4);
    return { links, shader: { type, textureSet, typeSpecific: c.pos + 12 + 4 + 4 + 4 + 4 + 4 + 12 + 4 + 4 + 4 } };
  }
  if (t === 'BSEffectShaderProperty' || t === 'NiAlphaProperty') {
    net(c, links, false);
    return { links };
  }
  if (EXTRA_DATA_TYPES.has(t)) {
    links.push({ offset: 0, kind: 'string' });
    if (t === 'NiStringExtraData') links.push({ offset: 4, kind: 'string' });
    return { links };
  }
  return undefined;
}

export interface Transform {
  translation: [number, number, number];
  /** Row-major 3×3. */
  rotation: number[];
  scale: number;
}

export const IDENTITY_TRANSFORM: Transform = { translation: [0, 0, 0], rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], scale: 1 };

function readTransform(data: Uint8Array, at: number): Transform {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const f = (k: number) => dv.getFloat32(at + k * 4, true);
  return { translation: [f(0), f(1), f(2)], rotation: [f(3), f(4), f(5), f(6), f(7), f(8), f(9), f(10), f(11)], scale: f(12) };
}

function writeTransform(data: Uint8Array, at: number, t: Transform): void {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const v = [...t.translation, ...t.rotation, t.scale];
  v.forEach((x, k) => dv.setFloat32(at + k * 4, x, true));
}

/** parent ∘ child (child's transform expressed in parent's parent space). */
export function composeTransform(parent: Transform, child: Transform): Transform {
  const R = parent.rotation;
  const r = child.rotation;
  const rot: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) rot.push(R[i * 3]! * r[j]! + R[i * 3 + 1]! * r[3 + j]! + R[i * 3 + 2]! * r[6 + j]!);
  const t = child.translation;
  const tr: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) tr[i] = parent.translation[i]! + parent.scale * (R[i * 3]! * t[0] + R[i * 3 + 1]! * t[1] + R[i * 3 + 2]! * t[2]);
  return { translation: tr, rotation: rot, scale: parent.scale * child.scale };
}

export function applyTransform(t: Transform, p: ArrayLike<number>, out: Float32Array = new Float32Array(p.length)): Float32Array {
  const R = t.rotation;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!;
    const y = p[i + 1]!;
    const z = p[i + 2]!;
    out[i] = t.translation[0] + t.scale * (R[0]! * x + R[1]! * y + R[2]! * z);
    out[i + 1] = t.translation[1] + t.scale * (R[3]! * x + R[4]! * y + R[5]! * z);
    out[i + 2] = t.translation[2] + t.scale * (R[6]! * x + R[7]! * y + R[8]! * z);
  }
  return out;
}

export function invertTransform(t: Transform): Transform {
  const R = t.rotation;
  const rt = [R[0]!, R[3]!, R[6]!, R[1]!, R[4]!, R[7]!, R[2]!, R[5]!, R[8]!];
  const s = t.scale ? 1 / t.scale : 1;
  const tr: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) tr[i] = -s * (rt[i * 3]! * t.translation[0] + rt[i * 3 + 1]! * t.translation[1] + rt[i * 3 + 2]! * t.translation[2]);
  return { translation: tr, rotation: rt, scale: s };
}

const i32 = (data: Uint8Array, at: number) => new DataView(data.buffer, data.byteOffset, data.byteLength).getInt32(at, true);
const setI32 = (data: Uint8Array, at: number, v: number) => new DataView(data.buffer, data.byteOffset, data.byteLength).setInt32(at, v, true);

export function blockName(doc: NifDoc, i: number): string {
  const l = blockLayout(doc, i);
  const s = l?.links.find((x) => x.kind === 'string');
  if (!s) return '';
  const idx = i32(doc.blocks[i]!.data, s.offset);
  return idx >= 0 ? (doc.strings[idx] ?? '') : '';
}

/** The shapes in a file (reachable from the roots, not hidden), with their accumulated transform. */
export interface NifShapeInfo {
  block: number;
  type: string;
  name: string;
  /** Local → file space. */
  transform: Transform;
  positions: Float32Array;
  indices: Uint16Array | Uint32Array;
  skinned: boolean;
  /**
   * Where the vertices really are: for skinned shapes the bind pose (skin
   * space → file space, from the bones), otherwise the same as `transform`.
   * Use this to put several parts in one space.
   */
  placement: Transform;
}

/** A column-major 4×4 (rotation with uniform scale + translation) as a Transform. */
function matToTransform(m: Mat4): Transform {
  const sc = Math.hypot(m[0]!, m[1]!, m[2]!) || 1;
  return { translation: [m[12]!, m[13]!, m[14]!], rotation: [m[0]! / sc, m[4]! / sc, m[8]! / sc, m[1]! / sc, m[5]! / sc, m[9]! / sc, m[2]! / sc, m[6]! / sc, m[10]! / sc], scale: sc };
}

export function nifShapes(doc: NifDoc): NifShapeInfo[] {
  const out: NifShapeInfo[] = [];
  const seen = new Set<number>();
  const walk = (i: number, parent: Transform) => {
    if (i < 0 || seen.has(i)) return;
    seen.add(i);
    const b = doc.blocks[i];
    const l = b && blockLayout(doc, i);
    if (!b || !l?.av) return;
    const flags = new DataView(b.data.buffer, b.data.byteOffset).getUint32(l.av.transform - 4, true);
    if (flags & 1) return;
    const t = composeTransform(parent, readTransform(b.data, l.av.transform));
    if (SHAPE_TYPES.has(b.type)) {
      const g = geometryOf(doc, i);
      if (g) out.push({ block: i, type: b.type, name: blockName(doc, i), transform: t, positions: g.positions, indices: g.indices, skinned: g.skinned, placement: t });
      return;
    }
    for (const k of l.links) if (k.kind === 'child') walk(i32(b.data, k.offset), t);
  };
  for (const r of doc.roots) walk(r, IDENTITY_TRANSFORM);
  // Bind poses come from the full reader (it resolves skin instances, skin data and bones).
  if (out.some((x) => x.skinned)) {
    const binds = new Map<number, Mat4>();
    const visit = (n: NifNode) => {
      if (n.mesh?.bindMatrix) binds.set(n.blockIndex, n.mesh.bindMatrix);
      n.children.forEach(visit);
    };
    try {
      parseNif(writeNifDoc(doc)).roots.forEach(visit);
    } catch {
      // fall back to node transforms
    }
    for (const x of out) {
      const b = binds.get(x.block);
      if (b) x.placement = matToTransform(b);
    }
  }
  return out;
}

function linkTarget(doc: NifDoc, i: number, kind: NifLink['kind'], nth = 0): number {
  const l = blockLayout(doc, i);
  const k = l?.links.filter((x) => x.kind === kind)[nth];
  return k ? i32(doc.blocks[i]!.data, k.offset) : -1;
}

/** NiTriShape's data block, else -1. */
function dataBlockOf(doc: NifDoc, shape: number): number {
  const b = doc.blocks[shape]!;
  if (b.type !== 'NiTriShape') return -1;
  const l = blockLayout(doc, shape)!;
  return i32(b.data, l.av!.end);
}

function skinOf(doc: NifDoc, shape: number): number {
  const b = doc.blocks[shape]!;
  const l = blockLayout(doc, shape)!;
  if (b.type === 'NiTriShape') return i32(b.data, l.av!.end + 4);
  return i32(b.data, l.bsShape!.bound + 16);
}

function shaderOf(doc: NifDoc, shape: number): number {
  const b = doc.blocks[shape]!;
  const l = blockLayout(doc, shape)!;
  const refs = l.links.filter((x) => x.kind === 'ref');
  // Shader and alpha are the last two refs of every shape type.
  return i32(b.data, refs[refs.length - 2]!.offset);
}

function geometryOf(doc: NifDoc, shape: number) {
  const b = doc.blocks[shape]!;
  if (b.type === 'NiTriShape') {
    const d = dataBlockOf(doc, shape);
    const db = doc.blocks[d];
    const g = db ? readGeometryBlock(db.type, db.data, doc.bsVersion, doc.strings) : undefined;
    return g ? { ...g, skinned: skinOf(doc, shape) >= 0 } : undefined;
  }
  const g = readGeometryBlock(b.type, b.data, doc.bsVersion, doc.strings);
  // SE skinned shapes keep their triangles in the skin partition.
  if (g && !g.indices.length) {
    const skin = skinOf(doc, shape);
    const part = skin >= 0 && doc.blocks[skin] ? linkTarget(doc, skin, 'ref', 1) : -1;
    if (part >= 0 && doc.blocks[part]?.type === 'NiSkinPartition') {
      try {
        return { ...g, indices: skinPartitionTriangles(doc.blocks[part]!.data, doc.bsVersion) };
      } catch {
        // leave without triangles
      }
    }
  }
  return g;
}

/** Area-weighted vertex normals. */
export function vertexNormals(positions: ArrayLike<number>, indices: ArrayLike<number>): Float32Array {
  const n = new Float32Array(positions.length);
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const ux = positions[b]! - positions[a]!;
    const uy = positions[b + 1]! - positions[a + 1]!;
    const uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!;
    const vy = positions[c + 1]! - positions[a + 1]!;
    const vz = positions[c + 2]! - positions[a + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      n[v] += nx;
      n[v + 1] += ny;
      n[v + 2] += nz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!) || 1;
    n[i] /= l;
    n[i + 1] /= l;
    n[i + 2] /= l;
  }
  return n;
}

/** Per-vertex rotations (as 3×3 row-major) taking each old surface normal to the new one. */
function normalRotations(before: Float32Array, after: Float32Array): Float32Array {
  const out = new Float32Array((before.length / 3) * 9);
  for (let v = 0; v < before.length / 3; v++) {
    const ax = before[v * 3]!;
    const ay = before[v * 3 + 1]!;
    const az = before[v * 3 + 2]!;
    const bx = after[v * 3]!;
    const by = after[v * 3 + 1]!;
    const bz = after[v * 3 + 2]!;
    // Rodrigues: axis = a × b, cos = a·b.
    const kx = ay * bz - az * by;
    const ky = az * bx - ax * bz;
    const kz = ax * by - ay * bx;
    const c = ax * bx + ay * by + az * bz;
    const o = v * 9;
    if (c < -0.999 || !Number.isFinite(c)) {
      out.set([1, 0, 0, 0, 1, 0, 0, 0, 1], o);
      continue;
    }
    const f = 1 / (1 + c);
    out[o] = c + kx * kx * f;
    out[o + 1] = kx * ky * f - kz;
    out[o + 2] = kx * kz * f + ky;
    out[o + 3] = ky * kx * f + kz;
    out[o + 4] = c + ky * ky * f;
    out[o + 5] = ky * kz * f - kx;
    out[o + 6] = kz * kx * f - ky;
    out[o + 7] = kz * ky * f + kx;
    out[o + 8] = c + kz * kz * f;
  }
  return out;
}

const rot = (R: Float32Array, v: number, x: number, y: number, z: number): [number, number, number] => {
  const o = v * 9;
  return [R[o]! * x + R[o + 1]! * y + R[o + 2]! * z, R[o + 3]! * x + R[o + 4]! * y + R[o + 5]! * z, R[o + 6]! * x + R[o + 7]! * y + R[o + 8]! * z];
};
const toByte = (f: number) => Math.max(0, Math.min(255, Math.round(((f + 1) / 2) * 255)));
const fromByte = (b: number) => (b / 255) * 2 - 1;

function floatToHalf(v: number): number {
  const f32 = new Float32Array([v]);
  const u = new Uint32Array(f32.buffer)[0]!;
  const sign = (u >> 16) & 0x8000;
  const exp = ((u >> 23) & 0xff) - 127 + 15;
  let mant = u & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x800000) >> (1 - exp);
    return sign | (mant >> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | (mant >> 13);
}

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

/** Rewrite packed SE vertices: positions, and normals/tangents/bitangents turned with the surface. */
function patchPackedVertices(data: Uint8Array, at: number, desc: bigint, size: number, count: number, positions: Float32Array, R: Float32Array, fullPrecision: boolean): void {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const attrs = Number((desc >> 44n) & 0xfffn);
  const hasVertex = (attrs & 0x1) !== 0;
  const hasNormal = (attrs & 0x8) !== 0;
  const hasTangent = (attrs & 0x18) === 0x18;
  const normalOff = Number((desc >> 16n) & 0xfn) * 4;
  const tangentOff = Number((desc >> 20n) & 0xfn) * 4;
  for (let v = 0; v < count && v * 3 < positions.length; v++) {
    const o = at + v * size;
    let bx = 0;
    if (hasVertex) {
      if (fullPrecision) {
        for (let k = 0; k < 3; k++) dv.setFloat32(o + k * 4, positions[v * 3 + k]!, true);
        if (hasTangent) bx = dv.getFloat32(o + 12, true);
      } else {
        for (let k = 0; k < 3; k++) dv.setUint16(o + k * 2, floatToHalf(positions[v * 3 + k]!), true);
        if (hasTangent) bx = halfToFloat(dv.getUint16(o + 6, true));
      }
    }
    if (!hasNormal) continue;
    const n = rot(R, v, fromByte(data[o + normalOff]!), fromByte(data[o + normalOff + 1]!), fromByte(data[o + normalOff + 2]!));
    for (let k = 0; k < 3; k++) data[o + normalOff + k] = toByte(n[k]!);
    if (!hasTangent) continue;
    const t = rot(R, v, fromByte(data[o + tangentOff]!), fromByte(data[o + tangentOff + 1]!), fromByte(data[o + tangentOff + 2]!));
    for (let k = 0; k < 3; k++) data[o + tangentOff + k] = toByte(t[k]!);
    const b = rot(R, v, bx, fromByte(data[o + normalOff + 3]!), fromByte(data[o + tangentOff + 3]!));
    if (hasVertex) {
      if (fullPrecision) dv.setFloat32(o + 12, b[0], true);
      else dv.setUint16(o + 6, floatToHalf(b[0]), true);
    }
    data[o + normalOff + 3] = toByte(b[1]);
    data[o + tangentOff + 3] = toByte(b[2]);
  }
}

function patchFloatVectors(data: Uint8Array, at: number | undefined, count: number, R: Float32Array): void {
  if (at === undefined) return;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let v = 0; v < count; v++) {
    const o = at + v * 12;
    const r = rot(R, v, dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true));
    for (let k = 0; k < 3; k++) dv.setFloat32(o + k * 4, r[k]!, true);
  }
}

function writeBound(data: Uint8Array, at: number, positions: Float32Array): void {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, positions[i + k]!);
      max[k] = Math.max(max[k]!, positions[i + k]!);
    }
  if (!Number.isFinite(min[0]!)) return;
  const c = [0, 1, 2].map((k) => (min[k]! + max[k]!) / 2);
  let r = 0;
  for (let i = 0; i < positions.length; i += 3) r = Math.max(r, Math.hypot(positions[i]! - c[0]!, positions[i + 1]! - c[1]!, positions[i + 2]! - c[2]!));
  c.forEach((x, k) => dv.setFloat32(at + k * 4, x, true));
  dv.setFloat32(at + 12, r, true);
}

/**
 * Move a shape's vertices (local space, same count and order as stored),
 * updating every copy the game reads — the shape's own vertex data, the
 * dynamic vertices of a head shape, NiTriShapeData, and SE skin partitions —
 * and turning normals, tangents and bitangents with the changed surface.
 */
export function setShapePositions(doc: NifDoc, shape: number, positions: Float32Array): void {
  const b = doc.blocks[shape]!;
  const geo = geometryOf(doc, shape);
  if (!geo) throw new Error(`Block ${shape} (${b.type}) has no geometry`);
  if (geo.positions.length !== positions.length) throw new Error(`Vertex count changed (${geo.positions.length / 3} → ${positions.length / 3}); morphs must keep the vertex order`);
  const R = normalRotations(vertexNormals(geo.positions, geo.indices), vertexNormals(positions, geo.indices));
  const l = blockLayout(doc, shape)!;
  if (l.bsShape) {
    const s = l.bsShape;
    const attrs = Number((s.desc >> 44n) & 0xfffn);
    if (s.hasData) patchPackedVertices(b.data, s.vertexData, s.desc, s.vertexSize, s.numVertices, positions, R, doc.bsVersion === 100 || (attrs & 0x400) !== 0);
    if (s.dynamic !== undefined) {
      const dv = new DataView(b.data.buffer, b.data.byteOffset, b.data.byteLength);
      for (let v = 0; v < s.numVertices; v++) for (let k = 0; k < 3; k++) dv.setFloat32(s.dynamic + v * 16 + k * 4, positions[v * 3 + k]!, true);
    }
    writeBound(b.data, s.bound, positions);
  } else {
    const d = dataBlockOf(doc, shape);
    const db = doc.blocks[d]!;
    const dl = blockLayout(doc, d)!.niData!;
    const dv = new DataView(db.data.buffer, db.data.byteOffset, db.data.byteLength);
    for (let i = 0; i < dl.numVertices * 3; i++) dv.setFloat32(dl.vertices + i * 4, positions[i]!, true);
    patchFloatVectors(db.data, dl.normals, dl.numVertices, R);
    patchFloatVectors(db.data, dl.tangents, dl.numVertices, R);
    patchFloatVectors(db.data, dl.bitangents, dl.numVertices, R);
    writeBound(db.data, dl.bound, positions);
  }
  // SE skinned shapes keep a second copy of the vertices in their skin partition.
  const skin = skinOf(doc, shape);
  if (skin >= 0 && doc.blocks[skin] && doc.bsVersion === 100) {
    const part = linkTarget(doc, skin, 'ref', 1);
    const pl = part >= 0 ? blockLayout(doc, part)?.partition : undefined;
    if (pl && pl.count) patchPackedVertices(doc.blocks[part]!.data, pl.vertexData, pl.desc, pl.vertexSize, pl.count, positions, R, true);
  }
}

/** The texture paths of a shape's texture set ([] when it has none). */
export function shapeTextures(doc: NifDoc, shape: number): string[] {
  const sh = shaderOf(doc, shape);
  const sl = sh >= 0 ? blockLayout(doc, sh)?.shader : undefined;
  if (!sl) return [];
  const tb = doc.blocks[i32(doc.blocks[sh]!.data, sl.textureSet)];
  if (!tb || tb.type !== 'BSShaderTextureSet') return [];
  const c = new Cursor(tb.data);
  const n = c.u32();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const len = c.u32();
    out.push(String.fromCharCode(...tb.data.subarray(c.pos, c.pos + len)));
    c.skip(len);
  }
  return out;
}

/** Set texture slot `slot` of a shape's texture set (adding empty slots as needed). */
export function setShapeTexture(doc: NifDoc, shape: number, slot: number, path: string): boolean {
  const sh = shaderOf(doc, shape);
  const sl = sh >= 0 ? blockLayout(doc, sh)?.shader : undefined;
  if (!sl) return false;
  const ts = i32(doc.blocks[sh]!.data, sl.textureSet);
  const tb = doc.blocks[ts];
  if (!tb || tb.type !== 'BSShaderTextureSet') return false;
  const c = new Cursor(tb.data);
  const n = c.u32();
  const tex: string[] = [];
  for (let i = 0; i < n; i++) {
    const len = c.u32();
    tex.push(String.fromCharCode(...tb.data.subarray(c.pos, c.pos + len)));
    c.skip(len);
  }
  while (tex.length <= slot) tex.push('');
  tex[slot] = path;
  const size = 4 + tex.reduce((s, t) => s + 4 + t.length, 0);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, tex.length, true);
  let p = 4;
  for (const t of tex) {
    dv.setUint32(p, t.length, true);
    p += 4;
    for (let i = 0; i < t.length; i++) out[p++] = t.charCodeAt(i) & 0xff;
  }
  tb.data = out;
  return true;
}

/** The lighting shader's type (4 face, 5 skin tint, 6 hair tint …), or -1. */
export function shapeShaderType(doc: NifDoc, shape: number): number {
  const sh = shaderOf(doc, shape);
  return (sh >= 0 ? blockLayout(doc, sh)?.shader?.type : undefined) ?? -1;
}

/** Set the tint colour of a hair-tint (6) or skin-tint (5) shader. */
export function setShapeTint(doc: NifDoc, shape: number, color: [number, number, number]): boolean {
  const sh = shaderOf(doc, shape);
  const sl = sh >= 0 ? blockLayout(doc, sh)?.shader : undefined;
  if (!sl || (sl.type !== 5 && sl.type !== 6)) return false;
  const data = doc.blocks[sh]!.data;
  if (sl.typeSpecific + 12 > data.byteLength) return false;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  color.forEach((v, k) => dv.setFloat32(sl.typeSpecific + k * 4, v, true));
  return true;
}

export interface MergePart {
  doc: NifDoc;
  shapes: { block: number; name?: string; transform: Transform }[];
}

/**
 * Copy shapes from several files into one, under a single root node: each
 * shape keeps its skin, shader, textures and alpha; the bones its skin uses
 * become (shared, by name) children of the root, at their file-space
 * position; links to anything else are cut. This is the layout of a FaceGen
 * head (`BSFaceGenNiNodeSkinned`).
 */
export function mergeShapes(
  parts: MergePart[],
  opts: {
    rootName: string;
    bsVersion: number;
    userVersion: number;
    /**
     * 'facegen': the Creation Kit's FaceGen layout — a BSFadeNode root, then the
     * bones (position only, no rotation), then a "BSFaceGenNiNodeSkinned" node
     * holding the shapes. Default: shapes and bones straight under one NiNode.
     */
    layout?: 'flat' | 'facegen';
  },
): NifDoc {
  const facegen = opts.layout === 'facegen';
  const out: NifDoc = { userVersion: opts.userVersion, bsVersion: opts.bsVersion, strings: [], blocks: [], roots: [0] };
  const str = (s: string) => {
    let i = out.strings.indexOf(s);
    if (i < 0) i = out.strings.push(s) - 1;
    return i;
  };
  // Root: NiNode with name, no extra data/controller, flags 14, identity, no collision, children filled in last.
  out.blocks.push({ type: 'NiNode', data: new Uint8Array(0) });
  const children: number[] = [];
  const bones = new Map<string, number>();

  for (const part of parts) {
    const { doc } = part;
    // File-space transform of every node, to place the bones.
    const world = new Map<number, Transform>();
    const walk = (i: number, parent: Transform) => {
      const b = doc.blocks[i];
      const l = b && blockLayout(doc, i);
      if (!b || !l?.av || world.has(i)) return;
      const t = composeTransform(parent, readTransform(b.data, l.av.transform));
      world.set(i, t);
      for (const k of l.links) if (k.kind === 'child') walk(i32(b.data, k.offset), t);
    };
    for (const r of doc.roots) walk(r, IDENTITY_TRANSFORM);

    const map = new Map<number, number>();
    const boneFor = (src: number): number => {
      const name = blockName(doc, src);
      const have = bones.get(name);
      if (have !== undefined) return have;
      const b = doc.blocks[src]!;
      const l = blockLayout(doc, src)!;
      // A bare node: same name and file-space transform, no children, effects, extra data or controller.
      const head = 4 + 4 + 4 + 4 + 52 + 4 + 4 + 4; // name, 0 extra, controller, flags, transform, collision, 0 children, 0 effects
      const data = new Uint8Array(head);
      const dv = new DataView(data.buffer);
      dv.setInt32(0, str(name), true);
      dv.setUint32(4, 0, true);
      dv.setInt32(8, -1, true);
      dv.setUint32(12, new DataView(b.data.buffer, b.data.byteOffset).getUint32(l.av!.transform - 4, true), true);
      const w = world.get(src) ?? IDENTITY_TRANSFORM;
      writeTransform(data, 16, facegen ? { ...IDENTITY_TRANSFORM, translation: w.translation } : w);
      dv.setInt32(68, -1, true);
      const idx = out.blocks.push({ type: 'NiNode', data }) - 1;
      bones.set(name, idx);
      return idx;
    };
    const copy = (src: number): number => {
      if (src < 0) return -1;
      const have = map.get(src);
      if (have !== undefined) return have;
      const b = doc.blocks[src];
      const l = b && blockLayout(doc, src);
      if (!b || !l) return -1;
      const idx = out.blocks.push({ type: b.type, data: b.data.slice() }) - 1;
      map.set(src, idx);
      const data = out.blocks[idx]!.data;
      for (const k of l.links) {
        const v = i32(b.data, k.offset);
        if (k.kind === 'string') setI32(data, k.offset, v >= 0 ? str(doc.strings[v] ?? '') : -1);
        else if (k.kind === 'skeleton') setI32(data, k.offset, 0);
        else if (k.kind === 'bone') setI32(data, k.offset, v >= 0 && doc.blocks[v] && NIF_NODE_TYPES.has(doc.blocks[v]!.type) ? boneFor(v) : -1);
        else if (k.kind === 'child') setI32(data, k.offset, -1);
        else setI32(data, k.offset, NIF_NODE_TYPES.has(doc.blocks[v]?.type ?? '') ? -1 : copy(v));
      }
      return idx;
    };
    for (const s of part.shapes) {
      const idx = copy(s.block);
      if (idx < 0) continue;
      const b = out.blocks[idx]!;
      const l = blockLayout(out, idx)!;
      writeTransform(b.data, l.av!.transform, s.transform);
      if (s.name !== undefined) setI32(b.data, l.links[0]!.offset, str(s.name));
      children.push(idx);
    }
  }

  const node = (name: string, kids: number[]) => {
    const d = new Uint8Array(4 + 4 + 4 + 4 + 52 + 4 + 4 + kids.length * 4 + 4);
    const dv = new DataView(d.buffer);
    dv.setInt32(0, str(name), true);
    dv.setUint32(4, 0, true);
    dv.setInt32(8, -1, true);
    dv.setUint32(12, 14, true);
    writeTransform(d, 16, IDENTITY_TRANSFORM);
    dv.setInt32(68, -1, true);
    dv.setUint32(72, kids.length, true);
    kids.forEach((c, k) => dv.setInt32(76 + k * 4, c, true));
    dv.setUint32(76 + kids.length * 4, 0, true);
    return d;
  };
  let root: Uint8Array;
  if (facegen) {
    const faceNode = out.blocks.push({ type: 'NiNode', data: node('BSFaceGenNiNodeSkinned', children) }) - 1;
    root = node(opts.rootName, [...bones.values(), faceNode]);
    out.blocks[0]!.type = 'BSFadeNode';
  } else root = node(opts.rootName, [...children, ...bones.values()]);
  out.blocks[0]!.data = root;
  return out;
}
