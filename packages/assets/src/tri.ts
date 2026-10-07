/**
 * FaceGen TRI files ("FRTRI003"): head meshes plus named morph targets. Skyrim
 * uses them for expressions/phonemes (*.tri), race morphs (*races.tri) and
 * character-creation sliders (*chargen.tri). Layout follows Outfit Studio's
 * TriHeadFile reader.
 */

export interface TriMorph {
  name: string;
  /** Per-vertex offsets (x, y, z) already scaled by the stored multiplier. */
  deltas: Float32Array;
}

export interface TriFile {
  version: string;
  vertices: Float32Array;
  triangles: Uint32Array;
  uvs: Float32Array;
  morphs: TriMorph[];
}

export function isTriFile(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 8 && String.fromCharCode(...bytes.subarray(0, 5)) === 'FRTRI';
}

export function parseTri(bytes: Uint8Array): TriFile {
  if (!isTriFile(bytes)) throw new Error('Not a FaceGen TRI file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 5;
  const version = String.fromCharCode(...bytes.subarray(p, p + 3));
  p += 3;
  const u32 = () => {
    const v = dv.getUint32(p, true);
    p += 4;
    return v;
  };
  const numVertices = u32();
  const numTriangles = u32();
  const numQuads = u32();
  u32();
  u32();
  const numUV = u32();
  u32(); // flags
  const numMorphs = u32();
  const numModifiers = u32();
  const numModVertices = u32();
  u32();
  u32();
  u32();
  u32();
  const vertices = new Float32Array(numVertices * 3);
  for (let i = 0; i < numVertices * 3; i++) {
    vertices[i] = dv.getFloat32(p, true);
    p += 4;
  }
  p += numModVertices * 12;
  const triangles = new Uint32Array(numTriangles * 3);
  for (let i = 0; i < numTriangles * 3; i++) triangles[i] = u32();
  p += numQuads * 16;
  const uvs = new Float32Array(numUV * 2);
  for (let i = 0; i < numUV * 2; i++) {
    uvs[i] = dv.getFloat32(p, true);
    p += 4;
  }
  p += numTriangles * 12; // texture triangles
  p += numQuads * 16;
  const morphs: TriMorph[] = [];
  for (let m = 0; m < numMorphs; m++) {
    const len = u32();
    const name = String.fromCharCode(...bytes.subarray(p, p + len)).replace(/\0.*$/, '');
    p += len;
    const mult = dv.getFloat32(p, true);
    p += 4;
    const deltas = new Float32Array(numVertices * 3);
    for (let i = 0; i < numVertices * 3; i++) {
      deltas[i] = dv.getInt16(p, true) * mult;
      p += 2;
    }
    morphs.push({ name, deltas });
  }
  void numModifiers; // statistical modifiers are not needed for previews
  return { version, vertices, triangles, uvs, morphs };
}

export function writeTri(t: Pick<TriFile, 'vertices' | 'triangles' | 'uvs' | 'morphs'>): Uint8Array {
  const nv = t.vertices.length / 3;
  const nt = t.triangles.length / 3;
  const nuv = t.uvs.length / 2;
  let size = 64 + nv * 12 + nt * 12 + nuv * 8 + nt * 12;
  const enc = new TextEncoder();
  const names = t.morphs.map((m) => enc.encode(m.name + '\0'));
  for (const n of names) size += 4 + n.byteLength + 4 + nv * 6;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out.set(enc.encode('FRTRI003'), 0);
  let p = 8;
  const u32 = (v: number) => {
    dv.setUint32(p, v, true);
    p += 4;
  };
  for (const v of [nv, nt, 0, 0, 0, nuv, 0, t.morphs.length, 0, 0, 0, 0, 0, 0]) u32(v);
  for (const v of t.vertices) {
    dv.setFloat32(p, v, true);
    p += 4;
  }
  for (const v of t.triangles) u32(v);
  for (const v of t.uvs) {
    dv.setFloat32(p, v, true);
    p += 4;
  }
  for (const v of t.triangles) u32(v);
  t.morphs.forEach((m, i) => {
    const n = names[i]!;
    u32(n.byteLength);
    out.set(n, p);
    p += n.byteLength;
    let max = 0;
    for (const d of m.deltas) max = Math.max(max, Math.abs(d));
    const mult = max > 0 ? max / 32767 : 1;
    dv.setFloat32(p, mult, true);
    p += 4;
    for (const d of m.deltas) {
      dv.setInt16(p, Math.round(d / mult), true);
      p += 2;
    }
  });
  return out;
}

/** Apply weighted morphs to base vertex positions. */
export function applyMorphs(base: Float32Array, morphs: readonly { deltas: Float32Array; weight: number }[]): Float32Array {
  const out = base.slice();
  for (const m of morphs) {
    if (!m.weight) continue;
    const n = Math.min(out.length, m.deltas.length);
    for (let i = 0; i < n; i++) out[i] = out[i]! + m.deltas[i]! * m.weight;
  }
  return out;
}

/**
 * Chargen sliders (NPC_ NAM9 order) and the TRI morph names they drive:
 * negative values use the first morph, positive the second, at |value|.
 * Names and directions were recovered by fitting the Creation Kit's own
 * FaceGen for vanilla characters against vanilla chargen TRIs (exact to
 * float precision), e.g. a negative "nose long/short" applies NoseShort.
 */
export const CHARGEN_SLIDER_MORPHS: readonly (readonly [string, string])[] = [
  ['NoseShort', 'NoseLong'],
  ['NoseDown', 'NoseUp'],
  ['JawUp', 'JawDown'],
  ['JawNarrow', 'JawWide'],
  ['JawBack', 'JawForward'],
  ['CheeksDown', 'CheeksUp'],
  ['CheeksIn', 'CheeksOut'],
  ['EyesMoveDown', 'EyesMoveUp'],
  ['EyesMoveIn', 'EyesMoveOut'],
  ['BrowDown', 'BrowUp'],
  ['BrowIn', 'BrowOut'],
  ['BrowBack', 'BrowForward'],
  ['LipMoveDown', 'LipMoveUp'],
  ['LipMoveIn', 'LipMoveOut'],
  ['ChinThin', 'ChinWide'],
  ['ChinMoveUp', 'ChinMoveDown'],
  ['Overbite', 'Underbite'],
  ['EyesBack', 'EyesForward'],
  ['', 'VampireMorph'],
];

/** Morphs the CK applies besides the sliders: the race's own head (named after the race), weight, and presets. */
export const SKINNY_MORPH = 'SkinnyMorph';
export const presetMorph = (kind: 'nose' | 'eyes' | 'mouth' | 'brows', n: number) => (n >= 0 ? `${{ nose: 'NoseType', eyes: 'EyesType', mouth: 'LipType', brows: 'BrowType' }[kind]}${n}` : '');
export const isPresetMorph = (name: string) => /^(Nose|Eyes|Lip|Brow)Type\d+$/i.test(name);

/** Resolve slider values to weighted morphs available in a chargen TRI. */
export function chargenMorphWeights(tri: TriFile, sliders: readonly number[]): { deltas: Float32Array; weight: number }[] {
  const byName = new Map(tri.morphs.map((m) => [m.name.toLowerCase(), m]));
  const out: { deltas: Float32Array; weight: number }[] = [];
  sliders.forEach((v, i) => {
    const pair = CHARGEN_SLIDER_MORPHS[i];
    if (!pair || !v) return;
    const name = v < 0 ? pair[0] : pair[1];
    const m = name ? byName.get(name.toLowerCase()) : undefined;
    if (m) out.push({ deltas: m.deltas, weight: Math.abs(v) });
  });
  return out;
}
