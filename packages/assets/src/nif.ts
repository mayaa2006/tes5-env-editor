/**
 * NIF reader for Skyrim LE (20.2.0.7 / BS 83) and SE (20.2.0.7 / BS 100).
 * Extracts the scene graph, geometry and material/texture information needed
 * to render meshes in the editor viewport. Every block's size is stored in the
 * header, so unknown blocks (collision, controllers, ...) are skipped safely.
 */

export interface NifMaterial {
  shader: 'lighting' | 'effect' | 'none';
  /** Texture slots from BSShaderTextureSet (0 diffuse, 1 normal, 2 glow/skin, 3 height, 4 env, 5 env mask, 6 multilayer/tint, 7 backlight/specular). */
  textures: string[];
  alpha: number;
  alphaBlend: boolean;
  alphaTest: boolean;
  alphaThreshold: number;
  twoSided: boolean;
  vertexColors: boolean;
  modelSpaceNormals: boolean;
  emissive: [number, number, number];
  emissiveMultiple: number;
  uvOffset: [number, number];
  uvScale: [number, number];
  glossiness: number;
  specularColor: [number, number, number];
  specularStrength: number;
  /** Lighting shader type (0 default, 1 env map, 5 face tint, 6 hair tint, 7 parallax occ...). */
  shaderType: number;
  /** Specular highlights on (shader flags 1, bit 0); the normal map's alpha masks them. */
  specular?: boolean;
  /** Blends by adding to what's behind (NiAlphaProperty destination ONE): glows, sparks, mist. */
  additive?: boolean;
  /** Drawn with the water shader (rivers, troughs); no texture set of its own. */
  water?: boolean;
}

/**
 * The texture path the game actually loads: vanilla meshes sometimes keep the
 * artist's absolute path ("skyrimhd\build\pc\data\textures\plants\x.dds");
 * the engine uses what follows "textures\".
 */
export function gameTexturePath(p: string): string {
  const n = p.trim().replace(/\//g, '\\').toLowerCase().replace(/^\\+/, '');
  if (n.startsWith('textures\\')) return n;
  const i = n.indexOf('\\textures\\');
  if (i >= 0) return n.slice(i + 1);
  return n.startsWith('data\\') ? gameTexturePath(n.slice(5)) : `textures\\${n}`;
}

export interface NifMesh {
  name: string;
  blockIndex: number;
  positions: Float32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  /** RGBA, 0–1. */
  colors?: Float32Array;
  indices: Uint16Array | Uint32Array;
  material: NifMaterial;
  skinned: boolean;
  /**
   * Skinned shapes only: skin space → file space in the bind pose (a bone's
   * world transform times its skin transform — the same for every bone).
   * Skinned vertices ignore the shape's own transform; use this instead.
   */
  bindMatrix?: Mat4;
}

export interface NifNode {
  name: string;
  type: string;
  blockIndex: number;
  translation: [number, number, number];
  /** Row-major 3×3 rotation. */
  rotation: [number, number, number, number, number, number, number, number, number];
  scale: number;
  flags: number;
  children: NifNode[];
  mesh?: NifMesh;
}

export interface NifFile {
  version: number;
  userVersion: number;
  bsVersion: number;
  game: 'SkyrimLE' | 'SkyrimSE' | 'other';
  blockTypes: string[];
  roots: NifNode[];
  warnings: string[];
}

class Reader {
  private dv: DataView;
  pos = 0;
  constructor(readonly b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  /** Throw instead of reading past the end (corrupt files must fail fast, not allocate gigabytes). */
  need(n: number): void {
    if (!(n >= 0) || this.pos + n > this.b.byteLength) throw new RangeError(`NIF data ends early (need ${n} bytes at ${this.pos})`);
  }
  /** A count read from the file, checked against the bytes left (each item takes at least `each` bytes). */
  count(n: number, each: number): number {
    this.need(n * each);
    return n;
  }
  u8() {
    this.need(1);
    return this.b[this.pos++]!;
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
  i32() {
    const v = this.dv.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f32() {
    const v = this.dv.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  u64() {
    const v = this.dv.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }
  half() {
    return halfToFloat(this.u16());
  }
  bytes(n: number) {
    this.need(n);
    const v = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  str(n: number) {
    this.need(n);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.b[this.pos + i]!);
    this.pos += n;
    return s.replace(/\0+$/, '');
  }
  sized() {
    return this.str(this.u32());
  }
  exportString() {
    return this.str(this.u8());
  }
  line() {
    const start = this.pos;
    while (this.pos < this.b.byteLength && this.b[this.pos] !== 0x0a) this.pos++;
    const out = String.fromCharCode(...this.b.subarray(start, Math.min(this.pos, start + 128)));
    this.pos++;
    return out;
  }
  vec3(): [number, number, number] {
    return [this.f32(), this.f32(), this.f32()];
  }
}

export function halfToFloat(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -1 : 1) * Infinity;
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

export const NODE_TYPES: ReadonlySet<string> = new Set([
  'NiNode', 'BSFadeNode', 'BSLeafAnimNode', 'BSTreeNode', 'BSMultiBoundNode', 'BSOrderedNode', 'BSValueNode', 'NiSwitchNode',
  'NiBillboardNode', 'BSBlastNode', 'BSDamageStage', 'BSMasterParticleSystem', 'NiLODNode', 'BSDebrisNode',
]);

function defaultMaterial(): NifMaterial {
  return {
    shader: 'none',
    textures: [],
    alpha: 1,
    alphaBlend: false,
    alphaTest: false,
    alphaThreshold: 128,
    twoSided: false,
    vertexColors: false,
    modelSpaceNormals: false,
    emissive: [0, 0, 0],
    emissiveMultiple: 1,
    uvOffset: [0, 0],
    uvScale: [1, 1],
    glossiness: 80,
    specularColor: [1, 1, 1],
    specularStrength: 1,
    shaderType: 0,
  };
}

interface Header {
  version: number;
  userVersion: number;
  bsVersion: number;
  numBlocks: number;
  blockTypes: string[];
  blockTypeIndex: number[];
  blockSizes: number[];
  strings: string[];
  dataStart: number;
}

function readHeader(r: Reader): Header {
  const headerLine = r.line();
  if (!/^Gamebryo File Format, Version 20\./.test(headerLine)) throw new Error(`Unsupported NIF header: ${headerLine.slice(0, 60)}`);
  const version = r.u32();
  if (version !== 0x14020007) throw new Error(`Unsupported NIF version 0x${version.toString(16)} (Skyrim uses 20.2.0.7)`);
  r.u8(); // endian
  const userVersion = r.u32();
  const numBlocks = r.u32();
  let bsVersion = 0;
  if (userVersion >= 10) {
    bsVersion = r.u32();
    r.exportString(); // author
    if (bsVersion > 130) r.u32();
    if (bsVersion < 131) r.exportString(); // process script
    r.exportString(); // export script
    if (bsVersion >= 103) r.exportString(); // max file path
  }
  const numBlockTypes = r.count(r.u16(), 4);
  const blockTypes: string[] = [];
  for (let i = 0; i < numBlockTypes; i++) blockTypes.push(r.sized());
  r.count(numBlocks, 6);
  const blockTypeIndex: number[] = [];
  for (let i = 0; i < numBlocks; i++) blockTypeIndex.push(r.u16() & 0x7fff);
  const blockSizes: number[] = [];
  for (let i = 0; i < numBlocks; i++) blockSizes.push(r.u32());
  const numStrings = r.count(r.u32(), 4);
  r.u32(); // max string length
  const strings: string[] = [];
  for (let i = 0; i < numStrings; i++) strings.push(r.sized());
  const numGroups = r.count(r.u32(), 4);
  for (let i = 0; i < numGroups; i++) r.u32();
  return { version, userVersion, bsVersion, numBlocks, blockTypes, blockTypeIndex, blockSizes, strings, dataStart: r.pos };
}

interface AVObject {
  name: string;
  flags: number;
  translation: [number, number, number];
  rotation: NifNode['rotation'];
  scale: number;
}

interface ParsedBlock {
  type: string;
  av?: AVObject;
  children?: number[];
  // geometry
  shaderRef?: number;
  alphaRef?: number;
  dataRef?: number;
  skinRef?: number;
  // skinning
  skin?: { dataRef: number; partitionRef: number; bones: number[] };
  partitionData?: Uint8Array;
  skinData?: { bones: { rotation: number[]; translation: [number, number, number]; scale: number; vertices: number }[] };
  mesh?: Omit<NifMesh, 'material' | 'name' | 'blockIndex'>;
  // shader/texture/alpha
  material?: Partial<NifMaterial> & { textureSetRef?: number };
  textures?: string[];
  alphaFlags?: number;
  alphaThreshold?: number;
}

function readObjectNET(r: Reader, h: Header, isLightingShader: boolean): string {
  if (isLightingShader && h.bsVersion >= 83 && h.bsVersion <= 130) r.u32(); // shader type, returned separately
  const nameIdx = r.i32();
  const n = r.count(r.u32(), 4);
  for (let i = 0; i < n; i++) r.i32();
  r.i32(); // controller
  return nameIdx >= 0 ? (h.strings[nameIdx] ?? '') : '';
}

function readAVObject(r: Reader, h: Header): AVObject {
  const name = readObjectNET(r, h, false);
  const flags = h.bsVersion > 26 ? r.u32() : r.u16();
  const translation = r.vec3();
  const rotation = [r.f32(), r.f32(), r.f32(), r.f32(), r.f32(), r.f32(), r.f32(), r.f32(), r.f32()] as NifNode['rotation'];
  const scale = r.f32();
  if (h.bsVersion <= 34) {
    const np = r.u32();
    for (let i = 0; i < np; i++) r.i32();
  }
  r.i32(); // collision object
  return { name, flags, translation, rotation, scale };
}

function readBSTriShape(r: Reader, h: Header, dynamic: boolean): ParsedBlock {
  const av = readAVObject(r, h);
  r.vec3();
  r.f32(); // bounding sphere
  const skinRef = r.i32();
  const shaderRef = r.i32();
  const alphaRef = r.i32();
  const desc = r.u64();
  const numTriangles = h.bsVersion >= 130 ? r.u32() : r.u16();
  const numVertices = r.u16();
  const dataSize = r.u32();
  const vertexSize = Number(desc & 0xfn) * 4;
  const uvOffset = Number((desc >> 8n) & 0xfn) * 4;
  const normalOffset = Number((desc >> 16n) & 0xfn) * 4;
  const colorOffset = Number((desc >> 24n) & 0xfn) * 4;
  const attrs = Number((desc >> 44n) & 0xfffn);
  const hasVertex = (attrs & 0x1) !== 0;
  const hasUV = (attrs & 0x2) !== 0;
  const hasNormal = (attrs & 0x8) !== 0;
  const hasColor = (attrs & 0x20) !== 0;
  const skinned = (attrs & 0x40) !== 0;
  const fullPrecision = h.bsVersion === 100 || (attrs & 0x400) !== 0;
  const positions = new Float32Array(numVertices * 3);
  const normals = hasNormal ? new Float32Array(numVertices * 3) : undefined;
  const uvs = hasUV ? new Float32Array(numVertices * 2) : undefined;
  const colors = hasColor ? new Float32Array(numVertices * 4) : undefined;
  let indices = new Uint16Array(0);
  if (dataSize > 0) {
    const base = r.pos;
    const dv = new DataView(r.b.buffer, r.b.byteOffset, r.b.byteLength);
    for (let v = 0; v < numVertices; v++) {
      const o = base + v * vertexSize;
      if (hasVertex) {
        if (fullPrecision) {
          positions[v * 3] = dv.getFloat32(o, true);
          positions[v * 3 + 1] = dv.getFloat32(o + 4, true);
          positions[v * 3 + 2] = dv.getFloat32(o + 8, true);
        } else {
          positions[v * 3] = halfToFloat(dv.getUint16(o, true));
          positions[v * 3 + 1] = halfToFloat(dv.getUint16(o + 2, true));
          positions[v * 3 + 2] = halfToFloat(dv.getUint16(o + 4, true));
        }
      }
      if (uvs) {
        uvs[v * 2] = halfToFloat(dv.getUint16(o + uvOffset, true));
        uvs[v * 2 + 1] = halfToFloat(dv.getUint16(o + uvOffset + 2, true));
      }
      if (normals) {
        for (let k = 0; k < 3; k++) normals[v * 3 + k] = (r.b[o + normalOffset + k]! / 255) * 2 - 1;
      }
      if (colors) {
        for (let k = 0; k < 4; k++) colors[v * 4 + k] = r.b[o + colorOffset + k]! / 255;
      }
    }
    r.pos = base + vertexSize * numVertices;
    indices = new Uint16Array(numTriangles * 3);
    for (let i = 0; i < numTriangles * 3; i++) indices[i] = r.u16();
  }
  if (h.bsVersion === 100) {
    const particleSize = r.u32();
    if (particleSize > 0) r.pos += numVertices * 12 + numTriangles * 6;
  }
  if (dynamic) {
    const dynSize = r.u32();
    const n = dynSize / 16;
    for (let v = 0; v < n && v < numVertices; v++) {
      positions[v * 3] = r.f32();
      positions[v * 3 + 1] = r.f32();
      positions[v * 3 + 2] = r.f32();
      r.f32();
    }
  }
  return { type: dynamic ? 'BSDynamicTriShape' : 'BSTriShape', av, shaderRef, alphaRef, skinRef, mesh: { positions, normals, uvs, colors, indices, skinned: skinned || skinRef >= 0 } };
}

function readNiGeometry(r: Reader, h: Header, type: string): ParsedBlock {
  const av = readAVObject(r, h);
  const dataRef = r.i32();
  const skinRef = r.i32();
  const numMaterials = r.count(r.u32(), 8);
  for (let i = 0; i < numMaterials; i++) r.i32();
  for (let i = 0; i < numMaterials; i++) r.i32();
  r.i32(); // active material
  r.u8(); // needs update
  let shaderRef = -1;
  let alphaRef = -1;
  if (h.bsVersion > 34) {
    shaderRef = r.i32();
    alphaRef = r.i32();
  }
  return { type, av, dataRef, skinRef, shaderRef, alphaRef };
}

function readGeometryData(r: Reader, h: Header, type: string): ParsedBlock {
  r.i32(); // group id
  const numVertices = r.u16();
  r.u8(); // keep flags
  r.u8(); // compress flags
  const hasVertices = r.u8() !== 0;
  const positions = new Float32Array(numVertices * 3);
  if (hasVertices) for (let i = 0; i < numVertices * 3; i++) positions[i] = r.f32();
  const dataFlags = r.u16();
  if (h.bsVersion > 34) r.u32(); // material CRC
  const hasNormals = r.u8() !== 0;
  let normals: Float32Array | undefined;
  if (hasNormals) {
    normals = new Float32Array(numVertices * 3);
    for (let i = 0; i < numVertices * 3; i++) normals[i] = r.f32();
    if (dataFlags & 4096) r.pos += numVertices * 24; // tangents + bitangents
  }
  r.vec3();
  r.f32(); // bounding sphere
  const hasColors = r.u8() !== 0;
  let colors: Float32Array | undefined;
  if (hasColors) {
    colors = new Float32Array(numVertices * 4);
    for (let i = 0; i < numVertices * 4; i++) colors[i] = r.f32();
  }
  const uvSets = h.bsVersion > 0 ? dataFlags & 1 : dataFlags & 63;
  let uvs: Float32Array | undefined;
  for (let s = 0; s < uvSets; s++) {
    const set = new Float32Array(numVertices * 2);
    for (let i = 0; i < numVertices * 2; i++) set[i] = r.f32();
    if (s === 0) uvs = set;
  }
  r.u16(); // consistency
  r.i32(); // additional data
  const numTriangles = r.u16();
  let indices: Uint16Array;
  if (type === 'NiTriShapeData') {
    r.u32(); // num triangle points
    const hasTriangles = r.u8() !== 0;
    indices = new Uint16Array(hasTriangles ? numTriangles * 3 : 0);
    if (hasTriangles) for (let i = 0; i < numTriangles * 3; i++) indices[i] = r.u16();
    const groups = r.u16();
    for (let g = 0; g < groups; g++) {
      const n = r.u16();
      r.pos += n * 2;
    }
  } else {
    // NiTriStripsData → triangle list
    const numStrips = r.count(r.u16(), 2);
    const lengths: number[] = [];
    for (let i = 0; i < numStrips; i++) lengths.push(r.u16());
    const hasPoints = r.u8() !== 0;
    const tris: number[] = [];
    if (hasPoints) {
      for (const len of lengths) {
        const pts: number[] = [];
        for (let i = 0; i < len; i++) pts.push(r.u16());
        for (let i = 2; i < pts.length; i++) {
          const a = pts[i - 2]!;
          const b = pts[i - 1]!;
          const c = pts[i]!;
          if (a === b || b === c || a === c) continue;
          if (i % 2 === 0) tris.push(a, b, c);
          else tris.push(a, c, b);
        }
      }
    }
    indices = new Uint16Array(tris);
  }
  return { type, mesh: { positions, normals, uvs, colors, indices, skinned: false } };
}

function readLightingShader(r: Reader, h: Header): ParsedBlock {
  const start = r.pos;
  const shaderType = h.bsVersion >= 83 && h.bsVersion <= 130 ? r.u32() : 0;
  r.pos = start;
  readObjectNET(r, h, true);
  const f1 = r.u32();
  const f2 = r.u32();
  const uvOffset: [number, number] = [r.f32(), r.f32()];
  const uvScale: [number, number] = [r.f32(), r.f32()];
  const textureSetRef = r.i32();
  const emissive = r.vec3();
  const emissiveMultiple = r.f32();
  r.u32(); // clamp mode
  const alpha = r.f32();
  r.f32(); // refraction
  const glossiness = r.f32();
  const specularColor = r.vec3();
  const specularStrength = r.f32();
  return {
    type: 'BSLightingShaderProperty',
    material: {
      shader: 'lighting',
      shaderType,
      twoSided: (f2 & 0x10) !== 0,
      vertexColors: (f2 & 0x20) !== 0,
      modelSpaceNormals: (f1 & 0x1000) !== 0,
      specular: (f1 & 0x1) !== 0,
      uvOffset,
      uvScale,
      textureSetRef,
      emissive,
      emissiveMultiple,
      alpha,
      glossiness,
      specularColor,
      specularStrength,
    },
  };
}

function readEffectShader(r: Reader, h: Header): ParsedBlock {
  readObjectNET(r, h, false);
  r.u32();
  const f2 = r.u32();
  const uvOffset: [number, number] = [r.f32(), r.f32()];
  const uvScale: [number, number] = [r.f32(), r.f32()];
  const source = r.sized();
  r.u32(); // clamp/lighting/env lod/unused bytes
  r.f32();
  r.f32();
  r.f32();
  r.f32();
  const base = [r.f32(), r.f32(), r.f32(), r.f32()];
  const baseScale = r.f32();
  return {
    type: 'BSEffectShaderProperty',
    material: {
      shader: 'effect',
      textures: [source],
      twoSided: (f2 & 0x10) !== 0,
      vertexColors: (f2 & 0x20) !== 0,
      uvOffset,
      uvScale,
      emissive: [base[0]!, base[1]!, base[2]!],
      emissiveMultiple: baseScale,
      alpha: base[3]!,
    },
  };
}

/** @internal Header and raw block bytes, for the block-level editor (nif-blocks.ts). */
export function splitNif(bytes: Uint8Array): { version: number; userVersion: number; bsVersion: number; strings: string[]; blocks: { type: string; data: Uint8Array }[]; roots: number[] } {
  const r = new Reader(bytes);
  const h = readHeader(r);
  const blocks: { type: string; data: Uint8Array }[] = [];
  let pos = h.dataStart;
  for (let i = 0; i < h.numBlocks; i++) {
    const size = h.blockSizes[i]!;
    if (pos + size > bytes.byteLength) throw new RangeError(`NIF block ${i} runs past the end of the file`);
    blocks.push({ type: h.blockTypes[h.blockTypeIndex[i]!] ?? 'Unknown', data: bytes.slice(pos, pos + size) });
    pos += size;
  }
  r.pos = pos;
  const roots: number[] = [];
  const n = r.count(r.u32(), 4);
  for (let i = 0; i < n; i++) roots.push(r.i32());
  return { version: h.version, userVersion: h.userVersion, bsVersion: h.bsVersion, strings: h.strings, blocks, roots };
}

/**
 * Triangles (as indices into the shape's vertices) from a NiSkinPartition:
 * skinned SE shapes keep them there instead of on the shape. On SE they index
 * the shared vertex buffer directly; on LE each partition's own vertex list,
 * mapped back through its vertex map (checked on vanilla SE heads).
 */
export function skinPartitionTriangles(data: Uint8Array, bsVersion: number): Uint16Array {
  return readSkinPartition(data, bsVersion).triangles;
}

/**
 * A NiSkinPartition's triangles and, on SE, its shared vertex buffer (UVs,
 * normals, positions) — skinned SE head parts keep their UVs only here.
 */
export function readSkinPartition(data: Uint8Array, bsVersion: number): { triangles: Uint16Array; uvs?: Float32Array; normals?: Float32Array; positions?: Float32Array } {
  const r = new Reader(data);
  const out: number[] = [];
  const numPartitions = r.count(r.u32(), 10);
  let uvs: Float32Array | undefined;
  let normals: Float32Array | undefined;
  let positions: Float32Array | undefined;
  if (bsVersion === 100) {
    const dataSize = r.u32();
    const vertexSize = r.u32();
    const desc = r.u64();
    if (dataSize > 0 && vertexSize > 0) {
      const n = Math.floor(dataSize / vertexSize);
      const attrs = Number((desc >> 44n) & 0xfffn);
      const uvOff = Number((desc >> 8n) & 0xfn) * 4;
      const nOff = Number((desc >> 16n) & 0xfn) * 4;
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const base = r.pos;
      if (attrs & 0x1) positions = new Float32Array(n * 3);
      if (attrs & 0x2) uvs = new Float32Array(n * 2);
      if (attrs & 0x8) normals = new Float32Array(n * 3);
      for (let v = 0; v < n; v++) {
        const o = base + v * vertexSize;
        if (positions) for (let k = 0; k < 3; k++) positions[v * 3 + k] = dv.getFloat32(o + k * 4, true);
        if (uvs) {
          uvs[v * 2] = halfToFloat(dv.getUint16(o + uvOff, true));
          uvs[v * 2 + 1] = halfToFloat(dv.getUint16(o + uvOff + 2, true));
        }
        if (normals) for (let k = 0; k < 3; k++) normals[v * 3 + k] = (data[o + nOff + k]! / 255) * 2 - 1;
      }
    }
    r.pos += dataSize;
  }
  for (let p = 0; p < numPartitions; p++) {
    const numVertices = r.u16();
    const numTriangles = r.u16();
    const numBones = r.u16();
    const numStrips = r.u16();
    const numWeights = r.u16();
    r.pos += numBones * 2;
    const vertexMap: number[] = [];
    if (r.u8()) for (let i = 0; i < numVertices; i++) vertexMap.push(r.u16());
    if (r.u8()) r.pos += numVertices * numWeights * 4;
    const stripLengths: number[] = [];
    for (let i = 0; i < numStrips; i++) stripLengths.push(r.u16());
    // SE (global vertex buffer): triangles already index the shape's vertices; LE: the partition's, via its map.
    const map = (i: number) => (bsVersion === 100 ? i : (vertexMap[i] ?? i));
    if (r.u8()) {
      if (numStrips) {
        for (const len of stripLengths) {
          const pts: number[] = [];
          for (let i = 0; i < len; i++) pts.push(r.u16());
          for (let i = 2; i < pts.length; i++) {
            const [a, b, c] = [pts[i - 2]!, pts[i - 1]!, pts[i]!];
            if (a === b || b === c || a === c) continue;
            if (i % 2 === 0) out.push(map(a), map(b), map(c));
            else out.push(map(a), map(c), map(b));
          }
        }
      } else for (let i = 0; i < numTriangles * 3; i++) out.push(map(r.u16()));
    }
    if (r.u8()) r.pos += numVertices * numWeights;
    if (bsVersion >= 83) r.pos += 2; // LOD level, global VB
    if (bsVersion === 100) r.pos += 8 + numTriangles * 6; // vertex desc, triangles copy
  }
  return { triangles: new Uint16Array(out), uvs, normals, positions };
}

/** @internal Geometry of one shape or shape-data block (positions are the stored, local ones). */
export function readGeometryBlock(type: string, data: Uint8Array, bsVersion: number, strings: string[]): Omit<NifMesh, 'material' | 'name' | 'blockIndex'> | undefined {
  const r = new Reader(data);
  const h = { bsVersion, strings } as Header;
  if (type === 'BSTriShape' || type === 'BSSubIndexTriShape') return readBSTriShape(r, h, false).mesh;
  if (type === 'BSDynamicTriShape') return readBSTriShape(r, h, true).mesh;
  if (type === 'NiTriShapeData' || type === 'NiTriStripsData') return readGeometryData(r, h, type).mesh;
  return undefined;
}

/** Parse a NIF and build its scene graph. */
export function parseNif(bytes: Uint8Array): NifFile {
  const r = new Reader(bytes);
  const h = readHeader(r);
  const warnings: string[] = [];
  const blocks: (ParsedBlock | undefined)[] = [];
  let pos = h.dataStart;
  for (let i = 0; i < h.numBlocks; i++) {
    const type = h.blockTypes[h.blockTypeIndex[i]!] ?? 'Unknown';
    const size = h.blockSizes[i]!;
    r.pos = pos;
    try {
      if (NODE_TYPES.has(type)) {
        const av = readAVObject(r, h);
        const n = r.u32();
        const children: number[] = [];
        for (let k = 0; k < n; k++) children.push(r.i32());
        blocks.push({ type, av, children });
      } else if (type === 'BSTriShape' || type === 'BSMeshLODTriShape' || type === 'BSSubIndexTriShape') {
        blocks.push(readBSTriShape(r, h, false));
      } else if (type === 'BSDynamicTriShape') {
        blocks.push(readBSTriShape(r, h, true));
      } else if (type === 'NiTriShape' || type === 'NiTriStrips' || type === 'BSLODTriShape') {
        blocks.push(readNiGeometry(r, h, type));
      } else if (type === 'NiTriShapeData' || type === 'NiTriStripsData') {
        blocks.push(readGeometryData(r, h, type));
      } else if (type === 'BSLightingShaderProperty') {
        blocks.push(readLightingShader(r, h));
      } else if (type === 'BSEffectShaderProperty') {
        blocks.push(readEffectShader(r, h));
      } else if (type === 'BSWaterShaderProperty') {
        blocks.push({ type, material: { water: true, twoSided: true } });
      } else if (type === 'BSShaderTextureSet') {
        const n = r.u32();
        const textures: string[] = [];
        for (let k = 0; k < n; k++) textures.push(r.sized());
        blocks.push({ type, textures });
      } else if (type === 'NiSkinInstance' || type === 'BSDismemberSkinInstance') {
        const dataRef = r.i32();
        const partitionRef = r.i32();
        r.i32(); // skeleton root
        const n = r.count(r.u32(), 4);
        const bones: number[] = [];
        for (let k = 0; k < n; k++) bones.push(r.i32());
        blocks.push({ type, skin: { dataRef, partitionRef, bones } });
      } else if (type === 'NiSkinPartition') {
        blocks.push({ type, partitionData: bytes.subarray(pos, pos + size) });
      } else if (type === 'NiSkinData') {
        r.pos += 52; // overall skin transform
        const n = r.count(r.u32(), 52);
        const hasWeights = r.u8() !== 0;
        const bones: { rotation: number[]; translation: [number, number, number]; scale: number; vertices: number }[] = [];
        for (let k = 0; k < n; k++) {
          const rotation = [r.f32(), r.f32(), r.f32(), r.f32(), r.f32(), r.f32(), r.f32(), r.f32(), r.f32()];
          const translation = r.vec3();
          const scale = r.f32();
          r.pos += 16; // bounding sphere
          const nv = r.u16();
          if (hasWeights) r.pos += nv * 6;
          bones.push({ rotation, translation, scale, vertices: hasWeights ? nv : 0 });
        }
        blocks.push({ type, skinData: { bones } });
      } else if (type === 'NiAlphaProperty') {
        readObjectNET(r, h, false);
        const flags = r.u16();
        const threshold = r.u8();
        blocks.push({ type, alphaFlags: flags, alphaThreshold: threshold });
      } else {
        blocks.push({ type });
      }
    } catch (e) {
      warnings.push(`Block ${i} (${type}): ${(e as Error).message}`);
      blocks.push({ type });
    }
    pos += size;
  }
  r.pos = pos;
  const roots: number[] = [];
  try {
    const n = r.count(r.u32(), 4);
    for (let i = 0; i < n; i++) roots.push(r.i32());
  } catch {
    roots.push(0);
  }

  const materialFor = (b: ParsedBlock): NifMaterial => {
    const m = defaultMaterial();
    const shader = b.shaderRef !== undefined && b.shaderRef >= 0 ? blocks[b.shaderRef] : undefined;
    if (shader?.material) {
      const { textureSetRef, ...rest } = shader.material;
      Object.assign(m, rest);
      if (textureSetRef !== undefined && textureSetRef >= 0) m.textures = blocks[textureSetRef]?.textures ?? [];
    }
    const alpha = b.alphaRef !== undefined && b.alphaRef >= 0 ? blocks[b.alphaRef] : undefined;
    if (alpha?.alphaFlags !== undefined) {
      m.alphaBlend = (alpha.alphaFlags & 0x1) !== 0;
      // Destination blend factor (bits 5–8): 0 is ONE, i.e. added on top of what's behind.
      m.additive = m.alphaBlend && ((alpha.alphaFlags >> 5) & 0xf) === 0;
      m.alphaTest = (alpha.alphaFlags & 0x200) !== 0;
      m.alphaThreshold = alpha.alphaThreshold ?? 128;
    }
    return m;
  };

  const build = (index: number, seen: Set<number>): NifNode | undefined => {
    const b = blocks[index];
    if (!b || !b.av || seen.has(index)) return undefined;
    seen.add(index);
    const node: NifNode = {
      name: b.av.name,
      type: b.type,
      blockIndex: index,
      translation: b.av.translation,
      rotation: b.av.rotation,
      scale: b.av.scale,
      flags: b.av.flags,
      children: [],
    };
    if (b.children) {
      for (const c of b.children) {
        if (c < 0) continue;
        const child = build(c, seen);
        if (child) node.children.push(child);
      }
    }
    let geom = b.mesh;
    if (!geom && b.dataRef !== undefined && b.dataRef >= 0) geom = blocks[b.dataRef]?.mesh;
    if (geom) {
      const skinned = geom.skinned || (b.skinRef ?? -1) >= 0;
      // SE skinned shapes keep their triangles in the skin partition.
      if (!geom.indices.length && skinned) {
        const skin = blocks[b.skinRef ?? -1]?.skin;
        const part = skin ? blocks[skin.partitionRef]?.partitionData : undefined;
        if (part) {
          try {
            const sp = readSkinPartition(part, h.bsVersion);
            // A shape with no vertex data of its own (numVertices 0) uses the partition's buffer for everything.
            const own = geom.positions.length / 3;
            const n = own || (sp.positions ? sp.positions.length / 3 : 0);
            const fits = (a: Float32Array | undefined, w: number) => (a && a.length === n * w ? a : undefined);
            geom = {
              ...geom,
              indices: sp.triangles,
              // The partition's buffer is the real one; the shape's own may be a zero-filled stub.
              uvs: fits(sp.uvs, 2) ?? (geom.uvs?.length ? geom.uvs : undefined),
              normals: fits(sp.normals, 3) ?? (geom.normals?.length ? geom.normals : undefined),
              positions: own ? geom.positions : (sp.positions ?? geom.positions),
            };
          } catch (e) {
            warnings.push(`Block ${index}: skin partition triangles: ${(e as Error).message}`);
          }
        }
      }
      node.mesh = { ...geom, name: b.av.name, blockIndex: index, material: materialFor(b), skinned, bindMatrix: skinned ? bindMatrixOf(b) : undefined };
    }
    return node;
  };

  // World transforms of every node, for placing skinned shapes in their bind pose.
  const world = new Map<number, Mat4>();
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const walkWorld = (i: number, parent: Mat4, seen: Set<number>) => {
    const b = blocks[i];
    if (!b?.av || seen.has(i)) return;
    seen.add(i);
    const m = multiply(parent, nodeMatrix(b.av));
    world.set(i, m);
    for (const c of b.children ?? []) if (c >= 0) walkWorld(c, m, seen);
  };
  for (const ri of roots) walkWorld(ri, identity, new Set());
  /**
   * Where a skinned shape sits in its rest pose: a bone's world transform times its skin offset. In a proper
   * bind pose every bone gives the same answer, but FaceGen heads store some bones (NPC Spine2) in another
   * pose, so the bone that moves the most vertices wins, then the head bone, then the first.
   */
  const bindMatrixOf = (b: ParsedBlock): Mat4 | undefined => {
    const skin = b.skinRef !== undefined && b.skinRef >= 0 ? blocks[b.skinRef]?.skin : undefined;
    const data = skin ? blocks[skin.dataRef]?.skinData : undefined;
    if (!skin || !data) return undefined;
    let best: { k: number; score: number } | undefined;
    for (let k = 0; k < skin.bones.length; k++) {
      if (!world.get(skin.bones[k]!) || !data.bones[k]) continue;
      const head = /\[head\]/i.test(blocks[skin.bones[k]!]?.av?.name ?? '') ? 0.5 : 0;
      const score = data.bones[k]!.vertices + head;
      if (!best || score > best.score) best = { k, score };
    }
    if (!best) return undefined;
    const bw = world.get(skin.bones[best.k]!)!;
    const bd = data.bones[best.k]!;
    return multiply(bw, nodeMatrix({ rotation: bd.rotation as NifNode['rotation'], translation: bd.translation, scale: bd.scale }));
  };

  const rootNodes: NifNode[] = [];
  for (const ri of roots) {
    const n = build(ri, new Set());
    if (n) rootNodes.push(n);
  }
  const game = h.bsVersion === 100 ? 'SkyrimSE' : h.bsVersion === 83 ? 'SkyrimLE' : 'other';
  return { version: h.version, userVersion: h.userVersion, bsVersion: h.bsVersion, game, blockTypes: h.blockTypes, roots: rootNodes, warnings };
}

/** 4×4 column-major matrix (three.js / WebGL convention). */
export type Mat4 = Float32Array;

export function nodeMatrix(n: Pick<NifNode, 'translation' | 'rotation' | 'scale'>): Mat4 {
  const [r00, r01, r02, r10, r11, r12, r20, r21, r22] = n.rotation;
  const s = n.scale;
  // NIF rotation is row-major; column-major layout for WebGL.
  return new Float32Array([r00 * s, r10 * s, r20 * s, 0, r01 * s, r11 * s, r21 * s, 0, r02 * s, r12 * s, r22 * s, 0, n.translation[0], n.translation[1], n.translation[2], 1]);
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

/** All meshes with their accumulated transform, skipping hidden nodes (flag bit 0). */
export function flattenMeshes(nif: NifFile): { mesh: NifMesh; matrix: Mat4 }[] {
  const out: { mesh: NifMesh; matrix: Mat4 }[] = [];
  const walk = (n: NifNode, parent: Mat4) => {
    if (n.flags & 1) return; // hidden
    const m = multiply(parent, nodeMatrix(n));
    if (n.mesh) out.push({ mesh: n.mesh, matrix: n.mesh.bindMatrix ?? m });
    for (const c of n.children) walk(c, m);
  };
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  for (const r of nif.roots) walk(r, identity);
  return out;
}

/** Axis-aligned bounds of all visible geometry (used for OBND and camera framing). */
export function nifBounds(nif: NifFile): { min: [number, number, number]; max: [number, number, number] } | undefined {
  let min: [number, number, number] | undefined;
  let max: [number, number, number] = [0, 0, 0];
  for (const { mesh, matrix: m } of flattenMeshes(nif)) {
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i]!;
      const y = p[i + 1]!;
      const z = p[i + 2]!;
      const wx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
      const wy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
      const wz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
      if (!min) {
        min = [wx, wy, wz];
        max = [wx, wy, wz];
      } else {
        min = [Math.min(min[0], wx), Math.min(min[1], wy), Math.min(min[2], wz)];
        max = [Math.max(max[0], wx), Math.max(max[1], wy), Math.max(max[2], wz)];
      }
    }
  }
  return min ? { min, max } : undefined;
}
