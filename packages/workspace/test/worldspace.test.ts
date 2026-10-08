import { describe, expect, it } from 'vitest';
import { GroupType, parsePlugin } from '@tes5/esp';
import { MemoryFileSystem, TerrainService, Workspace, WorldService, WorldspaceService, createDemoData } from '../src';

async function setup() {
  const fs = new MemoryFileSystem();
  const demo = createDemoData(fs);
  const ws = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir], outputDir: demo.dataDir, loadOrder: [{ name: 'DemoWorld.esm', active: true }] });
  await ws.scan();
  await ws.load();
  ws.createPlugin('NewLands.esp');
  const world = new WorldService(ws);
  const terrain = new TerrainService(ws, world);
  return { fs, demo, ws, world, terrain, worlds: new WorldspaceService(ws, world, terrain) };
}

describe('new worldspaces and outdoor cells', () => {
  it('creates a worldspace with its persistent cell and a square of flat cells, as one undo step', async () => {
    const { fs, demo, ws, world, terrain, worlds } = await setup();
    const grass = ws.byEditorId('DemoLandGrass')!;
    const r = worlds.createWorldspace({ editorId: 'MyIsland', name: 'My Island', size: 3, groundHeight: 512, texture: grass, water: true, noFastTravel: true });
    expect(r.cells).toHaveLength(9);
    const w = ws.view(r.worldspace)!;
    expect(w.lossless).toBe(true);
    expect(w.data.name).toBe('My Island');
    expect(w.data.landData).toEqual({ defaultLandHeight: 512, defaultWaterHeight: 312 });
    expect(Number(w.data.flags) & 0x2).toBe(0x2);
    expect(w.data.boundsMin).toEqual({ x: -4096, y: -4096 });
    expect(w.data.boundsMax).toEqual({ x: 8192, y: 8192 });
    const cells = world.cells({ worldspace: r.worldspace });
    expect(cells.filter((c) => c.persistentCell).map((c) => c.formKey)).toEqual([r.persistentCell]);
    expect(world.cellAt(r.worldspace, { x: 0, y: 0 })).toBe(r.center);
    expect(world.cellAt(r.worldspace, { x: -1, y: 1 })).toBeDefined();
    const t = world.terrain(r.center)!;
    expect(t.origin).toEqual({ x: 0, y: 0 });
    expect(new Set(t.heights)).toEqual(new Set([512]));
    expect(world.landLayers(r.center)!.map((q) => q.base)).toEqual([grass, grass, grass, grass]);
    expect(ws.view(terrain.landOf(r.center)!)!.lossless).toBe(true);
    ws.undo();
    expect(ws.view(r.worldspace)).toBeUndefined();
    expect(world.cells({ worldspace: r.worldspace })).toEqual([]);
    ws.redo();
    expect(world.cells({ worldspace: r.worldspace })).toHaveLength(10);
    // Saved the way the game reads it: the persistent cell first, right under the world, then the blocks.
    await ws.save();
    const saved = parsePlugin(await fs.readFile(`${demo.dataDir}/NewLands.esp`), 'NewLands.esp');
    const top = saved.groups.find((g) => g.labelSig === 'WRLD')!;
    const children = top.children.find((c) => c.kind === 'group' && c.type === GroupType.WorldChildren)!;
    expect(children.kind === 'group' && children.children[0]!.kind === 'record' && (children.children[0]! as { flags: number }).flags & 0x400).toBeTruthy();
    expect(children.kind === 'group' && children.children.filter((c) => c.kind === 'group' && c.type === GroupType.ExteriorCellBlock).length).toBeGreaterThan(0);
  });

  it('adds an outdoor cell whose ground meets its neighbours', async () => {
    const { ws, world, worlds } = await setup();
    const valley = world.cells().find((c) => c.editorId === 'DemoValley1_0')!;
    const spot = { x: 2, y: 0 };
    const free = worlds.freeSpotNear(valley.worldspace!, valley.grid);
    expect(Math.max(Math.abs(free.x - 1), Math.abs(free.y))).toBe(1);
    expect(world.cellAt(valley.worldspace, free)).toBeUndefined();
    const cell = worlds.createExteriorCell(valley.worldspace!, spot, { editorId: 'DemoValley2_0' });
    expect(world.cellAt(valley.worldspace, spot)).toBe(cell);
    const mine = world.terrain(cell)!.heights;
    const west = world.terrain(valley.formKey)!.heights;
    // The shared edge is the same; the far side is smooth (no big steps).
    for (let r = 0; r < 33; r++) expect(mine[r * 33]).toBe(west[r * 33 + 32]);
    for (let r = 0; r < 33; r++) for (let c = 1; c < 33; c++) expect(Math.abs(mine[r * 33 + c]! - mine[r * 33 + c - 1]!)).toBeLessThan(40);
    expect(() => worlds.createExteriorCell(valley.worldspace!, spot)).toThrow(/already a cell/);
    // The ground texture follows the cells next to it.
    const isle = worlds.createWorldspace({ editorId: 'Isle', size: 1, texture: ws.byEditorId('DemoLandRock')! });
    const east = worlds.createExteriorCell(isle.worldspace, { x: 1, y: 0 });
    expect(world.landLayers(east)!.map((q) => q.base)).toEqual(Array(4).fill(ws.byEditorId('DemoLandRock')));
    expect(world.landLayers(worlds.createExteriorCell(isle.worldspace, { x: 2, y: 0 }, { texture: null }))!.map((q) => q.base)).toEqual([undefined, undefined, undefined, undefined]);
    ws.undo();
    ws.undo();
    ws.undo();
    ws.undo();
    expect(world.cellAt(valley.worldspace, spot)).toBeUndefined();
  });

  it('keeps an edited vanilla-style persistent cell (which has a grid) directly under its worldspace', async () => {
    const { ws, world, worlds } = await setup();
    const r = worlds.createWorldspace({ editorId: 'Isle', size: 1 });
    await ws.save();
    ws.createPlugin('Patch.esp');
    ws.updateRecord(r.persistentCell, { ...ws.view(r.persistentCell)!.data, name: 'Isle (always loaded)' });
    const p = ws.slots.find((s) => s.name === 'Patch.esp')!.plugin!;
    const top = p.groups.find((g) => g.labelSig === 'WRLD')!;
    const children = top.children.find((c) => c.kind === 'group' && c.type === GroupType.WorldChildren)!;
    expect(children.kind === 'group' && children.children[0]!.kind).toBe('record');
    expect(world.cellAt(r.worldspace, { x: 0, y: 0 })).toBe(r.center);
  });
});
