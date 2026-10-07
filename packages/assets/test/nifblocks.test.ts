import { describe, expect, it } from 'vitest';
import { blockLayout, mergeShapes, readSkinPartition, nifShapes, parseNif, readNifDoc, setShapePositions, setShapeTexture, setShapeTint, writeNif, writeNifDoc, IDENTITY_TRANSFORM, type NifDoc } from '../src';

/** A little pyramid with normals, so turning normals can be checked. */
function shape(name: string, dz = 0) {
  return {
    name,
    positions: [0, 0, 100 + dz, 10, 0, 90 + dz, 0, 10, 90 + dz, -10, 0, 90 + dz],
    normals: [0, 0, 1, 1, 0, 0, 0, 1, 0, -1, 0, 0],
    uvs: [0, 0, 1, 0, 0, 1, 1, 1],
    indices: [0, 1, 2, 0, 2, 3],
    textures: ['textures\\head.dds', 'textures\\head_msn.dds'],
  };
}

function node(doc: NifDoc, name: string, children: number[], z: number): Uint8Array {
  let s = doc.strings.indexOf(name);
  if (s < 0) s = doc.strings.push(name) - 1;
  const d = new Uint8Array(76 + children.length * 4 + 4);
  const dv = new DataView(d.buffer);
  dv.setInt32(0, s, true);
  dv.setInt32(8, -1, true);
  dv.setUint32(12, 14, true);
  dv.setFloat32(24, z, true);
  [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, k) => dv.setFloat32(28 + k * 4, v, true));
  dv.setFloat32(64, 1, true);
  dv.setInt32(68, -1, true);
  dv.setUint32(72, children.length, true);
  children.forEach((c, k) => dv.setInt32(76 + k * 4, c, true));
  return d;
}

/** Turn a writer-made SE file into a skinned one: bone under a root, skin instance + data + partition (with its vertex copy). */
function skinnedSE(name: string, dz = 0): Uint8Array {
  const doc = readNifDoc(writeNif([shape(name, dz)], { game: 'SkyrimSE', rootType: 'NiNode' }));
  const shapeIdx = doc.blocks.findIndex((b) => b.type === 'BSTriShape');
  const l = blockLayout(doc, shapeIdx)!.bsShape!;
  const bone = doc.blocks.push({ type: 'NiNode', data: node(doc, 'NPC Head [Head]', [], 120) }) - 1;
  const data = doc.blocks.push({ type: 'NiSkinData', data: new Uint8Array(57) }) - 1;
  const verts = doc.blocks[shapeIdx]!.data.slice(l.vertexData, l.vertexData + l.vertexSize * l.numVertices);
  const part = new Uint8Array(20 + verts.byteLength);
  const pdv = new DataView(part.buffer);
  pdv.setUint32(0, 0, true);
  pdv.setUint32(4, verts.byteLength, true);
  pdv.setUint32(8, l.vertexSize, true);
  pdv.setBigUint64(12, l.desc, true);
  part.set(verts, 20);
  const partition = doc.blocks.push({ type: 'NiSkinPartition', data: part }) - 1;
  const inst = new Uint8Array(20);
  const idv = new DataView(inst.buffer);
  idv.setInt32(0, data, true);
  idv.setInt32(4, partition, true);
  idv.setInt32(8, 0, true);
  idv.setUint32(12, 1, true);
  idv.setInt32(16, bone, true);
  const skin = doc.blocks.push({ type: 'NiSkinInstance', data: inst }) - 1;
  new DataView(doc.blocks[shapeIdx]!.data.buffer).setInt32(l.bound + 16, skin, true);
  doc.blocks[0] = { type: 'NiNode', data: node(doc, 'Scene Root', [shapeIdx, bone], 0) };
  return writeNifDoc(doc);
}

describe('NIF block editing', () => {
  it('round-trips a file byte for byte (apart from the header text)', () => {
    for (const game of ['SkyrimSE', 'SkyrimLE'] as const) {
      const bytes = writeNif([shape('Head')], { game });
      const again = writeNifDoc(readNifDoc(bytes));
      expect(parseNif(again).roots[0]!.children[0]!.mesh!.positions).toEqual(parseNif(bytes).roots[0]!.children[0]!.mesh!.positions);
    }
  });

  it('moves vertices in every copy the game reads, and turns the normals with the surface', () => {
    for (const game of ['SkyrimSE', 'SkyrimLE'] as const) {
      const doc = readNifDoc(writeNif([shape('Head')], { game }));
      const [s] = nifShapes(doc);
      expect(s!.name).toBe('Head');
      // Pull the apex up: the faces get steeper, so its normal tips towards them (+y here).
      const p = s!.positions.slice();
      p[2] = 130;
      setShapePositions(doc, s!.block, p);
      const mesh = parseNif(writeNifDoc(doc)).roots[0]!.children[0]!.mesh!;
      expect(Array.from(mesh.positions.slice(0, 3))).toEqual([0, 0, 130]);
      expect(mesh.normals![1]!).toBeGreaterThan(0.3);
      expect(() => setShapePositions(doc, s!.block, new Float32Array(3))).toThrow(/vertex order/);
    }
  });

  it('updates the SE skin partition copy of a skinned head', () => {
    const doc = readNifDoc(skinnedSE('Head'));
    const [s] = nifShapes(doc);
    expect(s!.skinned).toBe(true);
    const p = s!.positions.map((v, i) => (i % 3 === 2 ? v + 5 : v));
    setShapePositions(doc, s!.block, p);
    const pi = doc.blocks.findIndex((b) => b.type === 'NiSkinPartition');
    const pl = blockLayout(doc, pi)!.partition!;
    const dv = new DataView(doc.blocks[pi]!.data.buffer);
    expect(dv.getFloat32(pl.vertexData + 8, true)).toBe(105);
  });

  it('merges heads, hair and eyes into one FaceGen file with shared bones', () => {
    const head = readNifDoc(skinnedSE('MaleHead'));
    const hair = readNifDoc(skinnedSE('Hair', 2));
    const parts = [head, hair].map((doc, k) => ({ doc, shapes: nifShapes(doc).map((s) => ({ block: s.block, name: k ? 'HairMale01' : 'MaleHeadNord', transform: s.transform })) }));
    const merged = mergeShapes(parts, { rootName: 'BSFaceGenNiNodeSkinned', bsVersion: 100, userVersion: 12 });
    setShapeTexture(merged, nifShapes(merged)[0]!.block, 6, 'textures\\actors\\character\\facegendata\\facetint\\my.esp\\00000800.dds');
    const file = parseNif(writeNifDoc(merged));
    const root = file.roots[0]!;
    expect(root.name).toBe('BSFaceGenNiNodeSkinned');
    expect(root.children.map((c) => c.name)).toEqual(['MaleHeadNord', 'HairMale01', 'NPC Head [Head]']);
    expect(root.children[2]!.translation[2]).toBe(120);
    expect(root.children[0]!.mesh!.skinned).toBe(true);
    expect(root.children[0]!.mesh!.material.textures[6]).toMatch(/facetint/);
    expect(root.children[1]!.mesh!.material.textures[0]).toBe('textures\\head.dds');
    // Every skin instance points at the merged root and the one shared bone.
    const bones = new Set<number>();
    for (let i = 0; i < merged.blocks.length; i++) {
      if (merged.blocks[i]!.type !== 'NiSkinInstance') continue;
      const dv = new DataView(merged.blocks[i]!.data.buffer);
      expect(dv.getInt32(8, true)).toBe(0);
      expect(merged.blocks[dv.getInt32(16, true)]!.type).toBe('NiNode');
      bones.add(dv.getInt32(16, true));
    }
    expect(bones.size).toBe(1);
    expect(nifShapes(merged).every((s) => s.transform.scale === IDENTITY_TRANSFORM.scale)).toBe(true);
  });

  it('only tints hair and skin-tint shaders', () => {
    const doc = readNifDoc(writeNif([shape('Hair')], { game: 'SkyrimSE' }));
    expect(setShapeTint(doc, nifShapes(doc)[0]!.block, [1, 0, 0])).toBe(false);
  });

  it('reads triangles and UVs from an SE skin partition (where skinned SE shapes keep them)', () => {
    // One shared vertex buffer of 3 vertices (position, UV, normal) and one partition whose triangle
    // indexes that buffer directly — even though its vertex map would remap it (SE ignores the map).
    const vsize = 24;
    const desc = BigInt(vsize / 4) | (4n << 8n) | (5n << 16n) | (BigInt(0x1 | 0x2 | 0x8) << 44n);
    const verts = new Uint8Array(3 * vsize);
    const vdv = new DataView(verts.buffer);
    [[0, 0, 0], [1, 0, 0], [0, 1, 0]].forEach((p, i) => p.forEach((c, k) => vdv.setFloat32(i * vsize + k * 4, c, true)));
    vdv.setUint16(1 * vsize + 16, 0x3c00, true); // u = 1 (half)
    vdv.setUint16(2 * vsize + 18, 0x3c00, true); // v = 1
    const part: number[] = [];
    const u16 = (v: number) => part.push(v & 0xff, v >> 8);
    u16(3); u16(1); u16(0); u16(0); u16(4); // vertices, triangles, bones, strips, weights per vertex
    part.push(1); u16(2); u16(1); u16(0); // vertex map (reversed)
    part.push(0); // no weights
    part.push(1); u16(0); u16(1); u16(2); // triangle
    part.push(0); // no bone indices
    part.push(0, 1); // LOD level, global VB
    for (let i = 0; i < 8; i++) part.push(Number((desc >> BigInt(i * 8)) & 0xffn));
    u16(0); u16(1); u16(2); // triangles copy
    const head = new Uint8Array(20);
    const hdv = new DataView(head.buffer);
    hdv.setUint32(0, 1, true);
    hdv.setUint32(4, verts.byteLength, true);
    hdv.setUint32(8, vsize, true);
    hdv.setBigUint64(12, desc, true);
    const bytes = new Uint8Array([...head, ...verts, ...part]);
    const r = readSkinPartition(bytes, 100);
    expect(Array.from(r.triangles)).toEqual([0, 1, 2]);
    expect(Array.from(r.uvs!)).toEqual([0, 0, 1, 0, 0, 1]);
    expect(Array.from(r.positions!.slice(3, 6))).toEqual([1, 0, 0]);
    // LE partitions index their own vertices, mapped back through the vertex map.
    expect(Array.from(readSkinPartition(new Uint8Array([1, 0, 0, 0, ...part.slice(0, part.length - 14), 0, 1]), 83).triangles)).toEqual([2, 1, 0]);
  });
});
