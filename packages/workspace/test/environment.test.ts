import { describe, expect, it } from 'vitest';
import type { FormKey } from '@tes5/esp';
import { EnvironmentService, MemoryFileSystem, WorldService, Workspace, createDemoData, generateCellNavmesh, rotateVector, rotationForNormal } from '../src';

async function setup() {
  const fs = new MemoryFileSystem();
  const demo = createDemoData(fs);
  const ws = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir], outputDir: demo.dataDir, loadOrder: [{ name: 'DemoWorld.esm', active: true }] });
  await ws.scan();
  await ws.load();
  ws.createPlugin('Env.esp');
  const env = new EnvironmentService(ws);
  const k = (e: string) => ws.byEditorId(e)!;
  const world = new WorldService(ws);
  const ref = (key: FormKey) => world.references(ws.view(key)!.parent.cell!).find((r) => r.formKey === key)!;
  return { ws, env, k, world, ref };
}

const close = (a: number, b: number, eps = 0.5) => Math.abs(a - b) <= eps;

describe('environment tools', () => {
  it('turns a surface normal into a reference rotation', () => {
    for (const yaw of [0, 0.7, 2.5, -1.2])
      for (const n of [
        { x: 0, y: 0, z: 1 },
        { x: 0.3, y: 0, z: 0.95 },
        { x: -0.2, y: 0.4, z: 0.89 },
      ]) {
        const up = rotateVector(rotationForNormal(n, yaw), { x: 0, y: 0, z: 1 });
        const l = Math.hypot(n.x, n.y, n.z);
        expect(up.x).toBeCloseTo(n.x / l, 5);
        expect(up.y).toBeCloseTo(n.y / l, 5);
        expect(up.z).toBeCloseTo(n.z / l, 5);
      }
  });

  it('drops objects onto the floor and onto tables', async () => {
    const { ws, env, k, world, ref } = await setup();
    const cell = k('DemoTavern');
    const a = world.placeReference(cell, k('DemoCrate'), { position: { x: 300, y: -300, z: 140 } });
    const b = world.placeReference(cell, k('DemoBarrel'), { position: { x: -160, y: 150, z: 300 } }); // beside the candle
    const sunk = world.placeReference(cell, k('DemoCrate'), { position: { x: 300, y: 300, z: -20 } });
    const r = await env.dropToSurface([a, b, sunk]);
    expect(r.missed).toEqual([]);
    expect(ref(a).transform.position.z).toBeCloseTo(0, 1);
    expect(ref(b).transform.position.z).toBeCloseTo(78, 1); // table top
    expect(ref(sunk).transform.position.z).toBeCloseTo(0, 1);
    // One undo step for the whole drop.
    ws.undo();
    expect(ref(a).transform.position.z).toBeCloseTo(140, 1);
  });

  it('tilts objects to follow sloped terrain', async () => {
    const { env, k, world, ref } = await setup();
    const cell = k('DemoValley1_0');
    const surfaces = await env.surfaces(cell);
    // Find a sloped spot on the LAND.
    let spot = { x: 0, y: 0 };
    for (let x = 4200; x < 8000; x += 97) {
      const h = surfaces.down(x, 1500, 50_000, 200_000)!;
      if (h.normal.z < 0.99) {
        spot = { x, y: 1500 };
        break;
      }
    }
    const rock = world.placeReference(cell, k('DemoRock'), { position: { ...spot, z: 5000 }, rotation: { x: 0, y: 0, z: 0.4 } });
    await env.dropToSurface([rock], { align: true });
    const t = ref(rock).transform;
    const hit = surfaces.down(spot.x, spot.y, 50_000, 200_000)!;
    const up = rotateVector(t.rotation, { x: 0, y: 0, z: 1 });
    expect(up.x).toBeCloseTo(hit.normal.x, 3);
    expect(up.y).toBeCloseTo(hit.normal.y, 3);
    expect(t.rotation.z).toBeCloseTo(0.4, 5);
    expect(t.position.z).toBeCloseTo(hit.point.z, 1);
  });

  it('makes arrays', async () => {
    const { env, k, world, ref } = await setup();
    const cell = k('DemoTavern');
    const p = world.placeReference(cell, k('DemoPillar'), { position: { x: -300, y: 0, z: 0 } });
    const copies = await env.array([p], { count: 3, offset: { x: 150, y: 0, z: 0 } });
    expect(copies.map((c) => ref(c).transform.position.x)).toEqual([-150, 0, 150]);
  });

  it('scatters plants on terrain, respecting spacing and slope, and erases them', async () => {
    const { ws, env, k, ref } = await setup();
    const cell = k('DemoValley1_0');
    const center = { x: 6000, y: 2000, z: 0 };
    const placed = await env.scatter(cell, { items: [{ base: k('DemoBush') }, { base: k('DemoFern'), weight: 2 }], center, radius: 900, count: 25, seed: 7, alignToSlope: 0.5 });
    expect(placed.length).toBeGreaterThan(10);
    const surfaces = await env.surfaces(cell);
    const refs = placed.map(ref);
    const mine = new Set(placed);
    for (const r of refs) {
      expect(Math.hypot(r.transform.position.x - center.x, r.transform.position.y - center.y)).toBeLessThanOrEqual(900.01);
      const ground = (await env.surfaces(cell)).down(r.transform.position.x, r.transform.position.y, 50_000, 200_000, (o) => o !== null && mine.has(o))!;
      expect(Math.abs(r.transform.position.z - ground.point.z)).toBeLessThan(25);
    }
    for (let i = 0; i < refs.length; i++)
      for (let j = i + 1; j < refs.length; j++) expect(Math.hypot(refs[i]!.transform.position.x - refs[j]!.transform.position.x, refs[i]!.transform.position.y - refs[j]!.transform.position.y)).toBeGreaterThan(10);
    // Deterministic with a seed.
    ws.undo();
    const again = await env.scatter(cell, { items: [{ base: k('DemoBush') }, { base: k('DemoFern'), weight: 2 }], center, radius: 900, count: 25, seed: 7, alignToSlope: 0.5 });
    expect(again.map((a) => ref(a).transform.position)).toEqual(refs.map((r) => r.transform.position));
    // Erase half of the area.
    const erased = env.erase(cell, center, 450, [k('DemoBush'), k('DemoFern')]);
    expect(erased).toBeGreaterThan(0);
    expect(erased).toBeLessThan(again.length);
  });

  it('lays roads and fences along a path', async () => {
    const { env, k, ref } = await setup();
    const cell = k('DemoValley0_0');
    const road = await env.alongPath(cell, { base: k('DemoRoad'), points: [{ x: 500, y: 2000, z: 0 }, { x: 1524, y: 2000, z: 0 }, { x: 1524, y: 3024, z: 0 }], followSurface: true });
    expect(road).toHaveLength(8);
    const first = ref(road[0]!).transform;
    expect(first.position.x).toBeCloseTo(628, 0);
    expect(first.rotation.z).toBeCloseTo(0, 5);
    const last = ref(road[7]!).transform;
    expect(last.position.y).toBeCloseTo(2896, 0);
    // Heading north: local +X points to world +Y.
    const fwd = rotateVector(last.rotation, { x: 1, y: 0, z: 0 });
    expect(fwd.y).toBeCloseTo(1, 5);
    const fence = await env.alongPath(cell, { base: k('DemoFence'), points: [{ x: 500, y: 2000, z: 0 }, { x: 1524, y: 2000, z: 0 }], sideOffset: 90, bothSides: true, followSurface: true });
    expect(fence).toHaveLength(16);
    expect(new Set(fence.map((f) => Math.round(ref(f).transform.position.y)))).toEqual(new Set([2090, 1910]));
  });

  it('lights candles and torches, and sets a mood', async () => {
    const { ws, env, k, world } = await setup();
    const cell = k('DemoTavern');
    expect(env.lightSources(cell).map((s) => s.baseEditorId)).toEqual(['DemoCandleStick']);
    const r = env.lightingPass(cell);
    expect(r.placed).toHaveLength(1);
    const light = world.references(cell).find((x) => x.formKey === r.placed[0])!;
    expect(light.baseEditorId).toBe('DemoCandleLight');
    expect(light.transform.position.z).toBeCloseTo(78 + 16 + 8, 1);
    expect(env.lightingPass(cell)).toMatchObject({ placed: [], alreadyLit: 1 });
    // A brazier with no fire light in the load order gets a new light base.
    world.placeReference(cell, k('DemoBrazier'), { position: { x: 0, y: -300, z: 0 } });
    const r2 = env.lightingPass(cell, { fireLight: undefined });
    expect(r2.placed).toHaveLength(1);
    expect(r2.createdBases).toHaveLength(0); // DemoTorchLight matches "torch"
    expect(env.suggestMood(cell)).toBe('tavern');
    env.setCellMood(cell, 'dungeon');
    const lighting = ws.view(cell)!.data.lighting as { ambient: { r: number } };
    expect(lighting.ambient.r).toBe(30);
  });

  it('clutters a room: items on the tables, bigger things along the walls', async () => {
    const { env, k, ref } = await setup();
    const cell = k('DemoTavern');
    const items = env.themeItems('tavern');
    expect(items.table.length).toBeGreaterThanOrEqual(4);
    expect(items.floor.length).toBeGreaterThanOrEqual(2);
    const surfaces = await env.surfaces(cell);
    const r = await env.clutterRoom(cell, { theme: 'tavern', amount: 'heavy', seed: 3 });
    expect(r.table.length).toBeGreaterThan(2);
    for (const t of r.table) {
      // Resting on the top of a piece of furniture (table, crate or barrel), not on the floor.
      const p = ref(t).transform.position;
      const under = surfaces.down(p.x, p.y, p.z + 1, 4)!;
      expect(under).toBeDefined();
      expect(['DemoTable', 'DemoCrate', 'DemoBarrel']).toContain(ref(under.owner!).baseEditorId);
    }
    expect(r.floor.length).toBeGreaterThan(0);
    for (const f of r.floor) {
      const p = ref(f).transform.position;
      expect(p.z).toBeCloseTo(0, 0);
      // Along a wall (walls at ±512) or the pillar in the middle.
      expect(Math.max(Math.abs(p.x), Math.abs(p.y)) > 512 - 100 || Math.hypot(p.x, p.y) < 110).toBe(true);
    }
  });

  it('builds a room from kit pieces and navmeshes it', async () => {
    const { ws, env, k, world } = await setup();
    const cell = world.createInteriorCell('EnvTestRoom');
    const kit = { floor: k('DemoFloorWood'), wall: k('DemoWallPlaster'), corner: k('DemoWallCorner'), doorway: k('DemoWallDoorway') };
    const pieces = env.buildRoom(cell, { x: 0, y: 0, z: 0 }, { tiles: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], doorways: [{ x: 1, y: 0, side: 'e' }] }, kit);
    const refs = world.references(cell);
    const count = (e: string) => refs.filter((r) => r.baseEditorId === e).length;
    expect(pieces).toHaveLength(17);
    expect(count('DemoFloorWood')).toBe(3);
    expect(count('DemoWallPlaster')).toBe(7);
    expect(count('DemoWallDoorway')).toBe(1);
    expect(count('DemoWallCorner')).toBe(6);
    const door = refs.find((r) => r.baseEditorId === 'DemoWallDoorway')!;
    expect(door.transform.position).toMatchObject({ x: 384, y: 0 });
    const nav = await generateCellNavmesh(ws, cell, { useRecast: false });
    expect(nav.triangles).toBeGreaterThan(0);
  });

  it('links load doors with teleport markers on the open side, and keeps them in sync', async () => {
    const { ws, env, k, world, ref } = await setup();
    const tavernDoor = k('DemoTavernDoorRef');
    const outside = await env.createLinkedDoor(tavernDoor, k('DemoValley0_0'), { x: 1000, y: 1000, z: 0 }, 0);
    const a = ws.view(tavernDoor)!.data.teleport as { door: FormKey; placement: { position: { x: number; y: number; z: number } } };
    const b = ws.view(outside)!.data.teleport as typeof a;
    expect(a.door).toBe(outside);
    expect(b.door).toBe(tavernDoor);
    // Arriving in the tavern: inside the room (west of the door at x=512).
    expect(b.placement.position.x).toBeCloseTo(416, 0);
    expect(b.placement.position.y).toBeCloseTo(-128, 0);
    expect(ref(outside).persistent).toBe(true);
    expect(ref(tavernDoor).persistent).toBe(true);
    // Move the outside door: the tavern door's destination follows.
    world.transformReferences([{ ref: outside, transform: { position: { x: 1500, y: 1000, z: 0 } } }]);
    expect(await env.refreshTeleportMarkers([outside])).toEqual([tavernDoor]);
    const moved = ws.view(tavernDoor)!.data.teleport as typeof a;
    expect(Math.hypot(moved.placement.position.x - 1500, moved.placement.position.y - 1000)).toBeCloseTo(96, 0);
  });

  it('knows when a navmesh is out of date', async () => {
    const { ws, env, k, world } = await setup();
    const cell = k('DemoTavern');
    expect(await env.navmeshStatus(cell)).toBe('none');
    await generateCellNavmesh(ws, cell, { useRecast: false });
    expect(await env.navmeshStatus(cell)).toBe('unknown');
    await env.stampNavmesh(cell);
    expect(await env.navmeshStatus(cell)).toBe('fresh');
    world.placeReference(cell, k('DemoCrate'), { position: { x: 100, y: 100, z: 0 } });
    expect(await env.navmeshStatus(cell)).toBe('stale');
    ws.undo();
    expect(await env.navmeshStatus(cell)).toBe('fresh');
  });
});
