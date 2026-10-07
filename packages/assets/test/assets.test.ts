import { describe, expect, it } from 'vitest';
import {
  BsaArchive,
  applyMorphs,
  bsaHash,
  bufferSource,
  chargenMorphWeights,
  compressFrame,
  decodeToRgba,
  decompressFrame,
  flattenMeshes,
  halfToFloat,
  nifBounds,
  parseDds,
  parseNif,
  parseTri,
  writeBsa,
  writeNif,
  writeRgbaDds,
  writeTri,
  xxh32,
} from '../src';

function pseudoRandom(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

describe('LZ4', () => {
  it('computes xxh32 reference values', () => {
    expect(xxh32(new Uint8Array(0))).toBe(0x02cc5d05);
    expect(xxh32(new TextEncoder().encode('Nobody inspects the spammish repetition'))).toBe(0xe2293b2f);
  });

  it('round-trips compressible and incompressible data through frames', () => {
    const text = new TextEncoder().encode('Skyrim belongs to the Nords! '.repeat(5000));
    const c = compressFrame(text);
    expect(c.byteLength).toBeLessThan(text.byteLength / 10);
    expect(decompressFrame(c)).toEqual(text);
    const noise = pseudoRandom(100_000);
    expect(decompressFrame(compressFrame(noise))).toEqual(noise);
    expect(decompressFrame(compressFrame(new Uint8Array(0)))).toEqual(new Uint8Array(0));
  });
});

describe('BSA', () => {
  it('hashes names per the TES4/TES5 BSA algorithm', () => {
    // Expected values computed with an independent implementation of the UESP-documented algorithm.
    expect(bsaHash('meshes', true)).toBe(0x322f3a9a6d066573n);
    expect(bsaHash('textures', true)).toBe(0xd507789e74086573n);
    expect(bsaHash('box.nif', false)).toBe(0x92cd45fd6203ef78n);
    expect(bsaHash('Meshes/Clutter', true)).toBe(0x8948be786d0e6572n);
  });

  for (const version of [104, 105] as const) {
    it(`writes and reads v${version} archives`, () => {
      const files = {
        'meshes/clutter/box.nif': new TextEncoder().encode('box mesh '.repeat(200)),
        'textures/clutter/box.dds': pseudoRandom(5000, 7),
        'sound/fx/door.wav': pseudoRandom(300, 3),
        'scripts/myscript.pex': new Uint8Array([1, 2, 3]),
      };
      const bsa = writeBsa(files, { version });
      const a = new BsaArchive(bufferSource(bsa), 'test.bsa');
      expect(a.version).toBe(version);
      expect(a.files.length).toBe(4);
      for (const [p, data] of Object.entries(files)) {
        expect(a.has(p)).toBe(true);
        expect(a.read(p)).toEqual(data);
      }
      // Sounds are stored uncompressed even in compressed archives.
      expect(a.entry('sound\\fx\\door.wav')!.compressed).toBe(false);
      expect(a.entry('meshes\\clutter\\box.nif')!.compressed).toBe(true);
      expect(a.list('textures').map((f) => f.path)).toEqual(['textures\\clutter\\box.dds']);
    });
  }

  it('supports embedded file names', () => {
    const bsa = writeBsa({ 'textures/a.dds': new Uint8Array([9, 9, 9]) }, { embedFileNames: true, compress: false });
    expect(new BsaArchive(bufferSource(bsa)).read('textures/a.dds')).toEqual(new Uint8Array([9, 9, 9]));
  });
});

const QUAD = {
  name: 'Quad',
  positions: [0, 0, 0, 10, 0, 0, 10, 20, 0, 0, 20, 5],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
  textures: ['textures\\clutter\\box.dds', 'textures\\clutter\\box_n.dds'],
  translation: [100, 0, 0] as [number, number, number],
};

describe('NIF', () => {
  for (const game of ['SkyrimSE', 'SkyrimLE'] as const) {
    it(`reads ${game} geometry, textures and transforms`, () => {
      const bytes = writeNif([QUAD, { ...QUAD, name: 'Hidden', hidden: true }, { ...QUAD, name: 'Leaf', alphaTest: true, twoSided: true }], { game });
      const nif = parseNif(bytes);
      expect(nif.warnings).toEqual([]);
      expect(nif.game).toBe(game);
      expect(nif.roots[0]!.type).toBe('BSFadeNode');
      expect(nif.roots[0]!.children.map((c) => c.name)).toEqual(['Quad', 'Hidden', 'Leaf']);
      const meshes = flattenMeshes(nif);
      expect(meshes.map((m) => m.mesh.name)).toEqual(['Quad', 'Leaf']);
      const m = meshes[0]!.mesh;
      expect(Array.from(m.positions)).toEqual(QUAD.positions);
      expect(Array.from(m.indices)).toEqual(QUAD.indices);
      expect(m.uvs![4]).toBeCloseTo(1);
      expect(m.normals![2]).toBeCloseTo(1, 1);
      expect(m.material.textures.slice(0, 2)).toEqual(QUAD.textures);
      expect(m.material.shader).toBe('lighting');
      const leaf = meshes[1]!.mesh;
      expect(leaf.material.alphaTest).toBe(true);
      expect(leaf.material.twoSided).toBe(true);
      expect(meshes[0]!.matrix[12]).toBe(100);
      const b = nifBounds(nif)!;
      expect(b.min).toEqual([100, 0, 0]);
      expect(b.max).toEqual([110, 20, 5]);
    });
  }

  it('decodes half floats', () => {
    expect(halfToFloat(0x3c00)).toBe(1);
    expect(halfToFloat(0xc000)).toBe(-2);
    expect(halfToFloat(0x3555)).toBeCloseTo(0.333, 3);
  });
});

describe('DDS', () => {
  it('parses uncompressed textures', () => {
    const rgba = new Uint8Array(4 * 4 * 4).map((_, i) => i);
    const img = parseDds(writeRgbaDds(4, 4, rgba));
    expect(img.width).toBe(4);
    expect(img.format).toBe('rgba8');
    expect(decodeToRgba(img.mipmaps[0]!, img.format)).toEqual(rgba);
  });

  it('decodes a BC1 block', () => {
    const dds = new Uint8Array(128 + 8);
    const dv = new DataView(dds.buffer);
    dv.setUint32(0, 0x20534444, true);
    dv.setUint32(4, 124, true);
    dv.setUint32(12, 4, true);
    dv.setUint32(16, 4, true);
    dv.setUint32(28, 1, true);
    dv.setUint32(80, 0x4, true);
    dv.setUint32(84, 0x31545844, true); // DXT1
    // color0 = pure red (0xF800), color1 = pure blue (0x001F), all pixels index 0 except first row index 1
    dv.setUint16(128, 0xf800, true);
    dv.setUint16(130, 0x001f, true);
    dv.setUint32(132, 0x00000055, true);
    const img = parseDds(dds);
    expect(img.format).toBe('bc1');
    const px = decodeToRgba(img.mipmaps[0]!, 'bc1')!;
    expect(Array.from(px.subarray(0, 4))).toEqual([0, 0, 255, 255]);
    expect(Array.from(px.subarray(16 * 4 - 4))).toEqual([255, 0, 0, 255]);
  });
});

describe('TRI', () => {
  it('round-trips morphs and applies chargen sliders', () => {
    const vertices = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const tri = parseTri(
      writeTri({
        vertices,
        triangles: new Uint32Array([0, 1, 2]),
        uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
        morphs: [
          { name: 'NoseShort', deltas: new Float32Array([0, 0, 2, 0, 0, 0, 0, 0, 0]) },
          { name: 'NoseLong', deltas: new Float32Array([0, 0, -2, 0, 0, 0, 0, 0, 0]) },
        ],
      }),
    );
    expect(tri.morphs.map((m) => m.name)).toEqual(['NoseShort', 'NoseLong']);
    expect(tri.morphs[0]!.deltas[2]).toBeCloseTo(2, 3);
    const sliders = new Array(19).fill(0);
    sliders[0] = 0.5; // positive → NoseLong (as the CK does)
    const moved = applyMorphs(tri.vertices, chargenMorphWeights(tri, sliders));
    expect(moved[2]).toBeCloseTo(-1, 3);
    sliders[0] = -0.5; // negative → NoseShort
    expect(applyMorphs(tri.vertices, chargenMorphWeights(tri, sliders))[2]).toBeCloseTo(1, 3);
  });
});
