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
});
