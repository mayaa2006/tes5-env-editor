/**
 * Minimal NIF writer for Skyrim LE/SE: a root node with textured, lit
 * triangle shapes. Used for generated meshes (markers, previews, merged
 * geometry) and to produce test fixtures for the reader.
 */

export interface WriteShape {
  name: string;
  positions: ArrayLike<number>;
  normals?: ArrayLike<number>;
  uvs?: ArrayLike<number>;
  indices: ArrayLike<number>;
  textures?: string[];
  alphaBlend?: boolean;
  alphaTest?: boolean;
  twoSided?: boolean;
  translation?: [number, number, number];
  hidden?: boolean;
}

export interface WriteNifOptions {
  game: 'SkyrimLE' | 'SkyrimSE';
  rootName?: string;
  rootType?: 'BSFadeNode' | 'NiNode';
}

class W {
  private buf = new Uint8Array(1024);
  private dv = new DataView(this.buf.buffer);
  pos = 0;
  private ensure(n: number) {
    if (this.pos + n <= this.buf.byteLength) return;
    let c = this.buf.byteLength * 2;
    while (c < this.pos + n) c *= 2;
    const nb = new Uint8Array(c);
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
    this.dv = new DataView(nb.buffer);
  }
  u8(v: number) {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
    return this;
  }
  u16(v: number) {
    this.ensure(2);
    this.dv.setUint16(this.pos, v, true);
    this.pos += 2;
    return this;
  }
  u32(v: number) {
    this.ensure(4);
    this.dv.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
    return this;
  }
  i32(v: number) {
    this.ensure(4);
    this.dv.setInt32(this.pos, v, true);
    this.pos += 4;
    return this;
  }
  f32(v: number) {
    this.ensure(4);
    this.dv.setFloat32(this.pos, v, true);
    this.pos += 4;
    return this;
  }
  u64(v: bigint) {
    this.ensure(8);
    this.dv.setBigUint64(this.pos, v, true);
    this.pos += 8;
    return this;
  }
  bytes(b: Uint8Array) {
    this.ensure(b.byteLength);
    this.buf.set(b, this.pos);
    this.pos += b.byteLength;
    return this;
  }
  ascii(s: string) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    return this;
  }
  sized(s: string) {
    return this.u32(s.length).ascii(s);
  }
  exportString(s: string) {
    return this.u8(s.length + 1).ascii(s).u8(0);
  }
  out() {
    return this.buf.slice(0, this.pos);
  }
}

function floatToHalf(v: number): number {
  const f32 = new Float32Array([v]);
  const u = new Uint32Array(f32.buffer)[0]!;
  const sign = (u >> 16) & 0x8000;
  let exp = ((u >> 23) & 0xff) - 127 + 15;
  let mant = u & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x800000) >> (1 - exp);
    return sign | (mant >> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | (mant >> 13);
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function writeNif(shapes: WriteShape[], opts: WriteNifOptions): Uint8Array {
  const se = opts.game === 'SkyrimSE';
  const bsVersion = se ? 100 : 83;
  const strings: string[] = [];
  const str = (s: string) => {
    let i = strings.indexOf(s);
    if (i < 0) {
      strings.push(s);
      i = strings.length - 1;
    }
    return i;
  };
  const blockTypes: string[] = [];
  const typeIndex = (t: string) => {
    let i = blockTypes.indexOf(t);
    if (i < 0) {
      blockTypes.push(t);
      i = blockTypes.length - 1;
    }
    return i;
  };
  const blocks: { type: string; data: Uint8Array }[] = [];
  const reserve = (type: string) => {
    blocks.push({ type, data: new Uint8Array(0) });
    return blocks.length - 1;
  };

  const writeNET = (w: W, name: string, shaderType?: number) => {
    if (shaderType !== undefined) w.u32(shaderType);
    w.i32(name ? str(name) : -1).u32(0).i32(-1);
  };
  const writeAV = (w: W, name: string, t: [number, number, number] = [0, 0, 0], hidden = false) => {
    writeNET(w, name);
    w.u32(hidden ? 0x8000f : 0x8000e);
    w.f32(t[0]).f32(t[1]).f32(t[2]);
    for (const v of IDENTITY) w.f32(v);
    w.f32(1);
    w.i32(-1); // collision
  };

  const rootIndex = reserve(opts.rootType ?? 'BSFadeNode');
  const childIndices: number[] = [];

  for (const s of shapes) {
    const nv = s.positions.length / 3;
    const nt = s.indices.length / 3;
    const shapeIdx = reserve(se ? 'BSTriShape' : 'NiTriShape');
    childIndices.push(shapeIdx);
    const dataIdx = se ? -1 : reserve('NiTriShapeData');
    const shaderIdx = reserve('BSLightingShaderProperty');
    const texIdx = reserve('BSShaderTextureSet');
    const alphaIdx = s.alphaBlend || s.alphaTest ? reserve('NiAlphaProperty') : -1;

    // shader
    {
      const w = new W();
      writeNET(w, '', 0);
      w.u32(0x82400301).u32(0x8021 | (s.twoSided ? 0x10 : 0));
      w.f32(0).f32(0).f32(1).f32(1);
      w.i32(texIdx);
      w.f32(0).f32(0).f32(0).f32(1);
      w.u32(3);
      w.f32(1).f32(0).f32(80);
      w.f32(1).f32(1).f32(1).f32(1);
      w.f32(0.3).f32(2);
      blocks[shaderIdx]!.data = w.out();
    }
    {
      const w = new W();
      const tex = [...(s.textures ?? [])];
      while (tex.length < 9) tex.push('');
      w.u32(tex.length);
      for (const t of tex) w.sized(t);
      blocks[texIdx]!.data = w.out();
    }
    if (alphaIdx >= 0) {
      const w = new W();
      writeNET(w, '');
      w.u16((s.alphaBlend ? 0x1 | (6 << 1) | (7 << 5) : 0) | (s.alphaTest ? 0x200 | (4 << 10) : 0));
      w.u8(128);
      blocks[alphaIdx]!.data = w.out();
    }

    if (se) {
      const w = new W();
      writeAV(w, s.name, s.translation, s.hidden);
      w.f32(0).f32(0).f32(0).f32(0); // bounding sphere
      w.i32(-1).i32(shaderIdx).i32(alphaIdx);
      const hasUV = !!s.uvs;
      const hasN = !!s.normals;
      let size = 16;
      const uvOff = hasUV ? size : 0;
      if (hasUV) size += 4;
      const nOff = hasN ? size : 0;
      if (hasN) size += 4;
      const attrs = 0x1 | (hasUV ? 0x2 : 0) | (hasN ? 0x8 : 0);
      const desc = BigInt(size / 4) | (BigInt(uvOff / 4) << 8n) | (BigInt(nOff / 4) << 16n) | (BigInt(attrs) << 44n);
      w.u64(desc);
      w.u16(nt).u16(nv).u32(size * nv + nt * 6);
      for (let i = 0; i < nv; i++) {
        w.f32(s.positions[i * 3]!).f32(s.positions[i * 3 + 1]!).f32(s.positions[i * 3 + 2]!).u32(0);
        if (hasUV) w.u16(floatToHalf(s.uvs![i * 2]!)).u16(floatToHalf(s.uvs![i * 2 + 1]!));
        if (hasN) {
          for (let k = 0; k < 3; k++) w.u8(Math.round(((s.normals![i * 3 + k]! + 1) / 2) * 255));
          w.u8(0);
        }
      }
      for (let i = 0; i < nt * 3; i++) w.u16(s.indices[i]!);
      w.u32(0); // particle data size
      blocks[shapeIdx]!.data = w.out();
    } else {
      const w = new W();
      writeAV(w, s.name, s.translation, s.hidden);
      w.i32(dataIdx).i32(-1);
      w.u32(0).i32(-1).u8(0); // material data
      w.i32(shaderIdx).i32(alphaIdx);
      blocks[shapeIdx]!.data = w.out();
      const d = new W();
      d.i32(0).u16(nv).u8(0).u8(0).u8(1);
      for (let i = 0; i < nv * 3; i++) d.f32(s.positions[i]!);
      d.u16(s.uvs ? 1 : 0);
      d.u32(0); // material crc
      d.u8(s.normals ? 1 : 0);
      if (s.normals) for (let i = 0; i < nv * 3; i++) d.f32(s.normals[i]!);
      d.f32(0).f32(0).f32(0).f32(0);
      d.u8(0); // vertex colors
      if (s.uvs) for (let i = 0; i < nv * 2; i++) d.f32(s.uvs[i]!);
      d.u16(0).i32(-1);
      d.u16(nt).u32(nt * 3).u8(1);
      for (let i = 0; i < nt * 3; i++) d.u16(s.indices[i]!);
      d.u16(0);
      blocks[dataIdx]!.data = d.out();
    }
  }

  {
    const w = new W();
    writeAV(w, opts.rootName ?? 'Scene Root');
    w.u32(childIndices.length);
    for (const c of childIndices) w.i32(c);
    w.u32(0); // effects
    blocks[rootIndex]!.data = w.out();
  }

  const h = new W();
  h.ascii('Gamebryo File Format, Version 20.2.0.7\n');
  h.u32(0x14020007).u8(1).u32(12).u32(blocks.length);
  h.u32(bsVersion).exportString('tes5-env-editor').exportString('').exportString('');
  const typeIdx = blocks.map((b) => typeIndex(b.type));
  h.u16(blockTypes.length);
  for (const t of blockTypes) h.sized(t);
  for (const t of typeIdx) h.u16(t);
  for (const b of blocks) h.u32(b.data.byteLength);
  h.u32(strings.length).u32(strings.reduce((m, s) => Math.max(m, s.length), 0));
  for (const s of strings) h.sized(s);
  h.u32(0);
  for (const b of blocks) h.bytes(b.data);
  h.u32(1).i32(rootIndex);
  return h.out();
}
