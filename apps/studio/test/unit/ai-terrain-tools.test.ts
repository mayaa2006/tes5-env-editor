import { describe, expect, it } from 'vitest';
import { MemoryFileSystem, createDemoData, type AgentTool } from '@tes5/workspace';
import { DEMO_GAME_DIR } from '../../src/engine/constants';
import { EngineHost } from '../../src/engine/host';
import { terrainTools } from '../../src/engine/aitools-terrain';

const ORDER = [{ name: 'DemoWorld.esm', active: true }];

async function demo() {
  const fs = new MemoryFileSystem();
  createDemoData(fs, DEMO_GAME_DIR);
  const host = new EngineHost(fs);
  await host.open({ kind: 'demo', path: DEMO_GAME_DIR, loadOrder: ORDER });
  await host.loadPlugins(['DemoWorld.esm']);
  host.createPlugin('MyMod.esp', {});
  const tools = new Map(terrainTools(host).map((t) => [t.name, t as AgentTool]));
  const run = async (name: string, input: unknown): Promise<any> => {
    const t = tools.get(name)!;
    return t.writes ? host.ws!.transactionAsync(`AI: ${name}`, async () => t.run(t.input.parse(input))) : t.run(t.input.parse(input));
  };
  return { host, run };
}

describe('the AI workspace outdoor tools', () => {
  it('lists worldspaces and ground textures, and describes a cell', async () => {
    const { run } = await demo();
    expect((await run('list_worldspaces', {})).data).toContainEqual(expect.objectContaining({ editorId: 'DemoWorld', cells: 2 }));
    const tex = (await run('list_ground_textures', { query: 'grass' })).data;
    expect(tex.textures.map((t: any) => t.editorId)).toEqual(['DemoLandGrass']);
    const info = await run('ground_info', { place: 'DemoValley1_0' });
    expect(info.data).toMatchObject({ worldspace: 'DemoWorld', grid: { x: 1, y: 0 }, cellsAround: { west: true, east: false } });
    expect(info.data.ground.highest).toBeGreaterThanOrEqual(info.data.ground.lowest);
    expect(info.link).toMatchObject({ tab: 'scene' });
    await expect(run('ground_info', { place: 'DemoTavern' })).rejects.toThrow(/interior/);
  });

  it('makes a hill as high as asked, a hollow, a flat spot and a ridge, each one undo step', async () => {
    const { host, run } = await demo();
    const hill = (await run('shape_ground', { place: 'DemoValley1_0', shape: 'hill', height: 400, width: 800 })).data;
    expect(hill.cellsChanged).toBeGreaterThan(0);
    const rise = hill.heightAtShapeAfter - hill.heightAtShapeBefore;
    expect(rise).toBeGreaterThan(300);
    expect(rise).toBeLessThan(500);
    const ridge = (await run('shape_ground', { place: 'DemoValley1_0', shape: 'hill', height: 200, points: [{ x: 500, y: 500 }, { x: 3500, y: 3500 }] })).data;
    const ridgeRise = ridge.heightAtShapeAfter - ridge.heightAtShapeBefore;
    expect(ridgeRise).toBeGreaterThan(120);
    expect(ridgeRise).toBeLessThan(320);
    const flat = (await run('shape_ground', { place: 'DemoValley1_0', shape: 'flatten', at: 'south', height: 0, width: 500 })).data;
    expect(Math.abs(flat.heightAtShapeAfter)).toBeLessThan(40);
    const hollow = (await run('shape_ground', { place: 'DemoValley1_0', shape: 'hollow', at: 'north', height: 150 })).data;
    expect(hollow.heightAtShapeAfter).toBeLessThan(hollow.heightAtShapeBefore);
    // Each shape is its own step.
    expect(host.session().undoLabel).toBe('AI: shape_ground');
    host.undo();
    host.undo();
    host.undo();
    host.undo();
    expect((await run('ground_info', { place: 'DemoValley1_0' })).data.ground.middle).toBe(hill.heightAtShapeBefore);
  });

  it('paints the ground, makes a worldspace and adds cells next to others', async () => {
    const { host, run } = await demo();
    expect((await run('paint_ground', { place: 'DemoValley1_0', texture: 'DemoLandRock', whole: true })).data.cellsChanged).toBeGreaterThan(0);
    expect((await run('paint_ground', { place: 'DemoValley1_0', texture: 'DemoLandDirt', points: [{ x: 0, y: 2048 }, { x: 4096, y: 2048 }], width: 200 })).data.cellsChanged).toBeGreaterThan(0);
    await expect(run('paint_ground', { place: 'DemoValley1_0', texture: 'DemoTavern' })).rejects.toThrow(/list_ground_textures/);

    const w = (await run('create_worldspace', { editorId: 'AshValley', name: 'Ash Valley', size: 3, texture: 'DemoLandGrass', like: 'DemoWorld' })).data;
    expect(w.cells).toBe(9);
    expect(host.ws!.byEditorId('AshValley')).toBe(w.worldspace);
    await expect(run('create_worldspace', { editorId: 'AshValley' })).rejects.toThrow(/already used/);

    const east = (await run('create_outdoor_cell', { nextTo: 'DemoValley1_0', direction: 'east', editorId: 'DemoValley2_0' })).data;
    expect(east.grid).toEqual({ x: 2, y: 0 });
    await expect(run('create_outdoor_cell', { nextTo: 'DemoValley1_0', direction: 'west' })).rejects.toThrow(/already a cell west/);
    const free = (await run('create_outdoor_cell', { worldspace: 'AshValley' })).data;
    expect(Math.max(Math.abs(free.grid.x), Math.abs(free.grid.y))).toBe(2);
    await expect(run('create_outdoor_cell', {})).rejects.toThrow(/Say which worldspace/);
  });
});
