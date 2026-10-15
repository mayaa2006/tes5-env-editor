import { describe, expect, it } from 'vitest';
import { MemoryFileSystem, createDemoData, type AgentTool } from '@tes5/workspace';
import type { FormKey } from '@tes5/esp';
import { DEMO_GAME_DIR } from '../../src/engine/constants';
import { EngineHost } from '../../src/engine/host';
import { worldTools } from '../../src/engine/aitools-world';

const ORDER = [{ name: 'DemoWorld.esm', active: true }];

async function demo() {
  const fs = new MemoryFileSystem();
  createDemoData(fs, DEMO_GAME_DIR);
  const host = new EngineHost(fs);
  await host.open({ kind: 'demo', path: DEMO_GAME_DIR, loadOrder: ORDER });
  await host.loadPlugins(['DemoWorld.esm']);
  host.createPlugin('MyMod.esp', {});
  const tools = new Map(worldTools(host).map((t) => [t.name, t as AgentTool]));
  const run = async (name: string, input: unknown) => {
    const t = tools.get(name)!;
    return host.ws!.transactionAsync(`AI: ${name}`, async () => t.run(t.input.parse(input)));
  };
  return { host, run };
}

describe('the AI workspace world tools', () => {
  it('places items on surfaces and furniture on the floor, moves, drops and removes them', async () => {
    const { host, run } = await demo();
    const tavern = host.ws!.byEditorId('DemoTavern')!;
    const misc = host.search({ sigs: ['MISC'], limit: 1 }).items[0]!;
    const r = await run('place_object', { place: 'DemoTavern', object: misc.formKey, where: 'table', count: 2 });
    const placed = (r.data as any).placed as FormKey[];
    expect(placed).toHaveLength(2);
    expect(r.link).toMatchObject({ tab: 'scene', key: tavern });
    const refs = host.references(tavern);
    for (const p of placed) expect(refs.find((x) => x.formKey === p)?.base).toBe(misc.formKey);
    const before = refs.find((x) => x.formKey === placed[0])!.transform;
    await run('move_objects', { refs: [placed[0]], offset: { x: 50, y: 0, z: 0 }, turnDegrees: 90, drop: false });
    const after = host.references(tavern).find((x) => x.formKey === placed[0])!.transform;
    expect(after.position.x).toBeCloseTo(before.position.x + 50);
    expect(after.rotation.z).toBeCloseTo(before.rotation.z + Math.PI / 2);
    expect((await run('drop_to_floor', { refs: placed })).data).toBeDefined();
    await run('remove_objects', { refs: [placed[1]] });
    expect(host.references(tavern).some((x) => x.formKey === placed[1])).toBe(false);
    await expect(run('place_object', { place: 'NoSuchCell', object: misc.formKey })).rejects.toThrow(/list_places/);
  });

  it('dresses and lights a room, and makes its navmesh', async () => {
    const { host, run } = await demo();
    const tavern = host.ws!.byEditorId('DemoTavern')!;
    const n = host.references(tavern).length;
    const dressed = (await run('dress_room', { place: 'DemoTavern', theme: 'tavern', amount: 'light' })).data as any;
    expect(dressed.onTables + dressed.onFloor).toBeGreaterThanOrEqual(0);
    expect(host.references(tavern).length).toBe(n + dressed.onTables + dressed.onFloor);
    const lit = (await run('light_room', { place: 'DemoTavern', mood: 'tavern' })).data as any;
    expect(lit.sources).toBeGreaterThanOrEqual(0);
    expect(((await run('make_navmesh', { place: 'DemoTavern' })).data as any).triangles).toBeGreaterThan(0);
  });

  it('creates a place copied from another, with a door from where the player comes in', async () => {
    const { host, run } = await demo();
    const r = await run('create_place', { name: 'The Copied Inn', layoutLike: 'DemoTavern', doorFrom: 'DemoTavern' });
    const place = (r.data as any).place as FormKey;
    expect(host.ws!.summary(place)).toMatchObject({ sig: 'CELL', name: 'The Copied Inn' });
    expect(host.references(place).length).toBeGreaterThan(5);
    // A door in the tavern leads there.
    const tavern = host.ws!.byEditorId('DemoTavern')!;
    expect(host.references(tavern).some((x) => x.teleport && host.ws!.view(x.teleport)?.parent?.cell === place)).toBe(true);
  });
});
