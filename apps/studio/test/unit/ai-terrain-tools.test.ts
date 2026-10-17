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

  it('makes a hill as high as asked, a hollow, a flat spot and a ridge, in metres, each one undo step', async () => {
    const { host, run } = await demo();
    const hill = (await run('shape_ground', { place: 'DemoValley1_0', shape: 'hill', height: 6, width: 11 })).data;
    expect(hill.cellsChanged).toBeGreaterThan(0);
    const rise = hill.metresThereAfter - hill.metresThereBefore;
    expect(rise).toBeGreaterThan(4.3);
    expect(rise).toBeLessThan(7.2);
    const ridge = (await run('shape_ground', { place: 'DemoValley1_0', shape: 'hill', height: 3, points: [{ x: 7, y: 7 }, { x: 50, y: 50 }] })).data;
    const ridgeRise = ridge.metresThereAfter - ridge.metresThereBefore;
    expect(ridgeRise).toBeGreaterThan(1.7);
    expect(ridgeRise).toBeLessThan(4.6);
    const flat = (await run('shape_ground', { place: 'DemoValley1_0', shape: 'flatten', at: 'south', height: 0, width: 7 })).data;
    expect(Math.abs(flat.metresThereAfter)).toBeLessThan(0.6);
    // A spot as "x,y" in metres works as well as a compass name.
    const hollow = (await run('shape_ground', { place: 'DemoValley1_0', shape: 'hollow', at: '29, 47', height: 2 })).data;
    expect(hollow.metresThereAfter).toBeLessThan(hollow.metresThereBefore);
    await expect(run('shape_ground', { place: 'DemoValley1_0', shape: 'hill', at: 'behind the inn' })).rejects.toThrow(/isn't a spot in the cell.*metres from the south-west corner/);
    // Each shape is its own step.
    expect(host.session().undoLabel).toBe('AI: shape_ground');
    host.undo();
    host.undo();
    host.undo();
    host.undo();
    expect((await run('ground_info', { place: 'DemoValley1_0' })).data.ground.middle).toBe(hill.metresThereBefore);
  });

  it('paints the ground, makes a worldspace and adds cells next to others', async () => {
    const { host, run } = await demo();
    expect((await run('paint_ground', { place: 'DemoValley1_0', texture: 'DemoLandRock', whole: true })).data.cellsChanged).toBeGreaterThan(0);
    expect((await run('paint_ground', { place: 'DemoValley1_0', texture: 'DemoLandDirt', points: [{ x: 0, y: 29 }, { x: 58, y: 29 }], width: 3 })).data.cellsChanged).toBeGreaterThan(0);
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
