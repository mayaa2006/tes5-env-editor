import { describe, expect, it } from 'vitest';
import { HeightField, MemoryFileSystem, TerrainService, Workspace, WorldService, computeNormals, createDemoData, decodeVhgt, encodeVhgt, sculptDab } from '../src';

async function setup() {
  const fs = new MemoryFileSystem();
  const demo = createDemoData(fs);
  const ws = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir], outputDir: demo.dataDir, loadOrder: [{ name: 'DemoWorld.esm', active: true }] });
  await ws.scan();
  await ws.load();
  ws.createPlugin('Terrain.esp');
  const world = new WorldService(ws);
  return { ws, world, terrain: new TerrainService(ws, world), cell: world.cells().find((c) => c.editorId === 'DemoValley1_0')!.formKey };
}

describe('terrain', () => {
  it('encodes heights the way the game stores them (8-unit steps, byte deltas)', () => {
    const heights = new Float32Array(33 * 33).map((_, i) => Math.round(Math.sin(i / 40) * 300));
    const enc = encodeVhgt(heights, -10);
    expect(enc.bytes.byteLength).toBe(1096);
    const dec = decodeVhgt(enc.bytes);
    expect(dec.offset).toBe(-10);
    expect([...dec.heights]).toEqual([...enc.heights]);
    for (let i = 0; i < heights.length; i++) expect(Math.abs(dec.heights[i]! - heights[i]!)).toBeLessThanOrEqual(4);
    // Cliffs steeper than the format allows are clamped, not wrapped around.
    const cliff = new Float32Array(33 * 33);
    cliff[5] = 5000;
    expect(decodeVhgt(encodeVhgt(cliff, 0).bytes).heights[5]).toBe(127 * 8);
  });

  it('brushes raise, lower, smooth and flatten with a soft edge', () => {
    const f = new HeightField();
    for (let y = -10; y <= 10; y++) for (let x = -10; x <= 10; x++) f.set(x, y, 0);
    sculptDab(f, { x: 0, y: 0 }, { mode: 'raise', radius: 512, strength: 1 });
    expect(f.get(0, 0)).toBeCloseTo(64);
    expect(f.get(2, 0)!).toBeGreaterThan(0);
    expect(f.get(2, 0)!).toBeLessThan(64);
    expect(f.get(5, 0)).toBe(0);
    sculptDab(f, { x: 0, y: 0 }, { mode: 'smooth', radius: 512, strength: 1 });
    expect(f.get(0, 0)!).toBeLessThan(64);
    sculptDab(f, { x: 0, y: 0 }, { mode: 'flatten', radius: 512, strength: 1, flattenTo: 0 });
    expect(f.get(0, 0)).toBeCloseTo(0);
    const n = computeNormals(f, 0, 0);
    expect(new Int8Array(n.buffer)[(32 * 33 + 32) * 3 + 2]).toBe(127); // far corner is flat: straight up
  });

  it('sculpts a cell as one undo step and saves heights and normals', async () => {
    const { ws, world, terrain, cell } = await setup();
    const before = world.terrain(cell)!.heights.slice();
    const center = { x: 4096 + 2048, y: 2048 };
    const changed = terrain.sculpt(cell, [center], { mode: 'raise', radius: 800, strength: 1 });
    expect(changed).toEqual([cell]);
    const after = world.terrain(cell)!.heights;
    const i = 16 * 33 + 16;
    expect(after[i]! - before[i]!).toBe(64);
    const land = ws.view(terrain.landOf(cell)!)!;
    expect(land.inActive).toBe(true);
    expect(land.lossless).toBe(true);
    expect((land.data.normals as Uint8Array).byteLength).toBe(33 * 33 * 3);
    ws.undo();
    expect([...world.terrain(cell)!.heights]).toEqual([...before]);
    expect(() => terrain.sculpt(world.cells().find((c) => c.interior)!.formKey, [center], { mode: 'raise', radius: 100, strength: 1 })).toThrow(/outdoors/);
  });

  it('paints ground textures in layers, like the CK', async () => {
    const { ws, world, terrain, cell } = await setup();
    const grass = ws.byEditorId('DemoLandGrass')!;
    const rock = ws.byEditorId('DemoLandRock')!;
    // Bare ground: the paint becomes a layer over the game's default ground, only where the brush went.
    let r = terrain.paintTexture(cell, [{ x: 4096 + 1024, y: 1024 }], { texture: grass, radius: 600, strength: 1 });
    expect(r.cells).toEqual([cell]);
    let quads = world.landLayers(cell)!;
    expect(quads[0]!.base).toBeUndefined();
    expect(quads[0]!.layers[0]!.ltex).toBe(grass);
    expect(quads[0]!.layers[0]!.alpha[0]).toBe(0);
    expect(quads[3]!.layers).toEqual([]);
    // Ctrl+drag fades it again.
    terrain.paintTexture(cell, [{ x: 4096 + 1024, y: 1024 }], { texture: grass, radius: 600, strength: 1, erase: true });
    expect(world.landLayers(cell)![0]!.layers[0]!.alpha[8 * 17 + 8]).toBe(0);
    // With a base texture set (as vanilla ground has), other textures paint over it.
    const v0 = ws.view(terrain.landOf(cell)!)!;
    const btxt = (q: number) => {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setUint32(0, ws.localIdForActive(grass), true);
      b[4] = q;
      new DataView(b.buffer).setInt16(6, -1, true);
      return b;
    };
    ws.updateRecord(terrain.landOf(cell)!, v0.data, { unknown: [0, 1, 2, 3].map((q) => ({ index: 4 + q, sig: 'BTXT', data: btxt(q) })) });
    quads = world.landLayers(cell)!;
    expect(quads[0]!.base).toBe(grass);
    // Another texture becomes a painted layer: full strength at the brush centre, nothing past its edge.
    terrain.paintTexture(cell, [{ x: 4096 + 1024, y: 1024 }], { texture: rock, radius: 600, strength: 1 });
    quads = world.landLayers(cell)!;
    const layer = quads[0]!.layers.find((l) => l.ltex === rock)!;
    expect(layer.layer).toBe(0);
    expect(layer.alpha[8 * 17 + 8]).toBeCloseTo(1);
    expect(layer.alpha[0]).toBe(0);
    // Painting the base texture back fades the layer.
    terrain.paintTexture(cell, [{ x: 4096 + 1024, y: 1024 }], { texture: grass, radius: 600, strength: 0.5 });
    expect(world.landLayers(cell)![0]!.layers.find((l) => l.ltex === rock)!.alpha[8 * 17 + 8]).toBeCloseTo(0.5);
    // Written the way the game reads it: BTXT, then ATXT + VTXT, per quarter-cell; the record still reads back exactly.
    const land = terrain.landOf(cell)!;
    const v = ws.view(land)!;
    expect(v.lossless).toBe(true);
    expect(v.unknown.map((u) => u.sig).join(',')).toMatch(/^BTXT,ATXT,VTXT(,BTXT(,ATXT,VTXT)?)*$/);
    // One undo per stroke.
    ws.undo();
    expect(world.landLayers(cell)![0]!.layers.find((l) => l.ltex === rock)!.alpha[8 * 17 + 8]).toBeCloseTo(1);
    // Only landscape textures can be painted, and only outdoors.
    expect(() => terrain.paintTexture(cell, [{ x: 0, y: 0 }], { texture: ws.byEditorId('DemoLandGrassTX')!, radius: 100, strength: 1 })).toThrow(/landscape texture/);
  });

  it('keeps at most six painted layers per quarter-cell', async () => {
    const { ws, terrain, cell } = await setup();
    const ids = ['DemoLandGrass', 'DemoLandRock', 'DemoLandDirt'].map((e) => ws.byEditorId(e)!);
    // Make more landscape textures from the demo ones.
    for (let i = 0; i < 6; i++) ids.push(ws.duplicateRecord(ids[i % 3]!, `ExtraLand${i}`));
    let full = false;
    for (const t of ids) full = terrain.paintTexture(cell, [{ x: 4096 + 512, y: 512 }], { texture: t, radius: 400, strength: 1 }).full || full;
    expect(full).toBe(true);
    const v = ws.view(terrain.landOf(cell)!)!;
    const atxt = v.unknown.filter((u) => u.sig === 'ATXT' && u.data[4] === 0);
    expect(atxt.length).toBeLessThanOrEqual(6);
  });
});
