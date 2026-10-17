/**
 * The AI workspace's outdoor tools: worldspaces and outdoor cells, shaping
 * the ground (hills, hollows, flat spots, ridges and roads) and painting it
 * with landscape textures. Shapes are turned into brush strokes for the same
 * terrain service the World tab's brushes use, so each is one undo step and
 * the ground stays joined up with the cells around it.
 */
import { z } from 'zod';
import { isFormKey, type FormKey } from '@tes5/esp';
import { WorkspaceError, type AgentTool } from '@tes5/workspace';
import type { EngineHost } from './host';

/** Game units along a side of an outdoor cell. */
const CELL = 4096;
/** How much one full-strength brush dab raises or lowers the ground. */
const DAB = 64;

const SPOTS = {
  middle: [0.5, 0.5],
  north: [0.5, 0.8],
  south: [0.5, 0.2],
  east: [0.8, 0.5],
  west: [0.2, 0.5],
  northeast: [0.8, 0.8],
  northwest: [0.2, 0.8],
  southeast: [0.8, 0.2],
  southwest: [0.2, 0.2],
} as const;
type Spot = keyof typeof SPOTS;
const SPOT_NAMES = Object.keys(SPOTS) as [Spot, ...Spot[]];

const DIRS: Record<string, [number, number]> = { north: [0, 1], south: [0, -1], east: [1, 0], west: [-1, 0], northeast: [1, 1], northwest: [-1, 1], southeast: [1, -1], southwest: [-1, -1] };

/** Game units in a metre: what the AI is told in, since that's how people (and models) think of sizes. */
const M = 70;
/** A cell's side in metres (about 58.5). */
const CELL_M = Math.round((CELL / M) * 10) / 10;
const metres = (units: number | null) => (units === null ? null : Math.round((units / M) * 10) / 10);

const Where = {
  at: z.string().nullable().optional().describe(`Where in the cell: ${SPOT_NAMES.join(', ')} (default the middle), or "x,y" in metres from its south-west corner`),
  points: z
    .array(z.object({ x: z.number().min(0).max(CELL_M), y: z.number().min(0).max(CELL_M) }))
    .min(1)
    .max(20)
    .nullable()
    .optional()
    .describe(`Exact spots in the cell instead of at: metres from its south-west corner (x east, y north, 0–${CELL_M}; the middle is ${CELL_M / 2}, ${CELL_M / 2}). Several points make a line through them (a ridge, a valley, a road).`),
};

/** A spot in a cell, in game units from its corner: a compass name or "x,y" in metres. */
function spotOf(at: string | null | undefined): { x: number; y: number } {
  const a = (at ?? 'middle').trim().toLowerCase().replace(/[\s-]+/g, '');
  if (a in SPOTS) return { x: SPOTS[a as Spot][0] * CELL, y: SPOTS[a as Spot][1] * CELL };
  const m = /^\(?(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\)?$/.exec(a);
  if (m) return { x: Math.max(0, Math.min(CELL, Number(m[1]) * M)), y: Math.max(0, Math.min(CELL, Number(m[2]) * M)) };
  throw new WorkspaceError(`"${at}" isn't a spot in the cell. Use ${SPOT_NAMES.join(', ')}, or "x,y" in metres from the south-west corner (0–${CELL_M}).`);
}

export function terrainTools(host: EngineHost): AgentTool<any>[] {
  const ws = () => {
    if (!host.ws) throw new WorkspaceError('No game data is open');
    return host.ws;
  };
  const key = (ref: string) => {
    const r = ref.trim();
    return (isFormKey(r) ? r : ws().byEditorId(r)) as FormKey | undefined;
  };
  const worldspace = (ref: string): FormKey => {
    const k = key(ref);
    if (!k || ws().summary(k)?.sig !== 'WRLD') throw new WorkspaceError(`There's no worldspace "${ref}". list_worldspaces shows them.`);
    return k;
  };
  /** An outdoor cell and where it is. */
  const outdoor = (ref: string) => {
    const k = key(ref);
    const c = k ? host.cells().find((x) => x.formKey === k) : undefined;
    if (!c) throw new WorkspaceError(`There's no place "${ref}". Find outdoor cells with list_places.`);
    if (c.interior || !c.grid || !c.worldspace) throw new WorkspaceError(`${c.editorId ?? ref} is an interior; the ground can only be changed outdoors`);
    return { cell: c.formKey, grid: c.grid, worldspace: c.worldspace, label: c.name || c.editorId || c.formKey };
  };
  const texture = (ref: string): FormKey => {
    const k = key(ref);
    if (!k || ws().summary(k)?.sig !== 'LTEX') throw new WorkspaceError(`There's no landscape texture "${ref}". list_ground_textures shows them.`);
    return k;
  };
  const scene = (cell: FormKey, label: string) => ({ tab: 'scene' as const, key: cell, label: `${label} in World` });

  /** The brush stroke for a spot or a line, in world coordinates, with dabs close enough to blend. */
  const stroke = (c: { grid: { x: number; y: number } }, i: { at?: string | null; points?: { x: number; y: number }[] | null }, radius: number) => {
    const local = i.points?.length ? i.points.map((p) => ({ x: p.x * M, y: p.y * M })) : [spotOf(i.at)];
    const world = local.map((p) => ({ x: c.grid.x * CELL + p.x, y: c.grid.y * CELL + p.y }));
    const out = [world[0]!];
    const step = Math.max(32, radius / 3);
    for (let n = 1; n < world.length; n++) {
      const a = world[n - 1]!;
      const b = world[n]!;
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
      for (let s = 1; s <= steps; s++) out.push({ x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps });
    }
    return out;
  };
  /** The ground height at a point of a worldspace (nearest terrain vertex). */
  const heightAt = (w: FormKey, p: { x: number; y: number }) => {
    const gx = Math.floor(p.x / CELL);
    const gy = Math.floor(p.y / CELL);
    const cell = host.cells({ worldspace: w }).find((c) => !c.persistentCell && c.grid?.x === gx && c.grid?.y === gy);
    const t = cell ? host.terrain(cell.formKey) : null;
    if (!t) return null;
    const col = Math.round((p.x - gx * CELL) / 128);
    const row = Math.round((p.y - gy * CELL) / 128);
    return Math.round(t.heights[row * 33 + col]!);
  };
  /** Ground heights of a cell: lowest, highest and in the middle. */
  const heights = (cell: FormKey) => {
    const t = host.terrain(cell);
    if (!t) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const h of t.heights) (lo = Math.min(lo, h)), (hi = Math.max(hi, h));
    return { lowest: metres(lo), highest: metres(hi), middle: metres(t.heights[16 * 33 + 16]!) };
  };

  return [
    {
      name: 'list_worldspaces',
      group: 'read',
      writes: false,
      description: 'The worldspaces (outdoor maps such as Tamriel, or ones made in a mod) with how many outdoor cells each has.',
      input: z.object({}),
      summary: () => 'List the worldspaces',
      run: () => ({
        data: host.worldspaces().map((w) => ({ formKey: w.formKey, editorId: w.editorId, name: w.name, cells: host.cells({ worldspace: w.formKey }).filter((c) => !c.interior && !c.persistentCell).length })),
      }),
    },
    {
      name: 'ground_info',
      group: 'read',
      writes: false,
      description: `An outdoor cell (about ${CELL_M} m square): its worldspace and grid position, how high its ground is (lowest, highest, in the middle; metres above the game's zero) and which cells around it exist.`,
      input: z.object({ place: z.string().describe('Editor ID or FormKey of an outdoor cell') }),
      summary: (i) => `Look at the ground of ${i.place}`,
      run: (i) => {
        const c = outdoor(i.place);
        const taken = new Set(host.cells({ worldspace: c.worldspace }).filter((x) => x.grid && !x.persistentCell).map((x) => `${x.grid!.x},${x.grid!.y}`));
        const around = Object.fromEntries(Object.entries(DIRS).map(([d, [dx, dy]]) => [d, taken.has(`${c.grid.x + dx},${c.grid.y + dy}`)]));
        return { data: { cell: c.label, worldspace: ws().summary(c.worldspace)?.editorId, grid: c.grid, ground: heights(c.cell), cellsAround: around }, link: scene(c.cell, c.label) };
      },
    },
    {
      name: 'list_ground_textures',
      group: 'read',
      writes: false,
      description: 'Landscape textures to paint the ground with (grass, dirt, snow, rock, road…), found by words in their Editor ID or name.',
      input: z.object({ query: z.string().nullable().optional().describe('Words such as "grass", "road", "snow"; empty for all'), limit: z.number().int().min(1).max(200).nullable().optional() }),
      summary: (i) => `Find ground textures${i.query ? ` matching "${i.query}"` : ''}`,
      run: (i) => {
        const words: string[] = (i.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const all = host.landscapeTextures().filter((t) => words.every((w) => `${t.editorId ?? ''} ${t.name ?? ''}`.toLowerCase().includes(w)));
        return { data: { total: all.length, textures: all.slice(0, i.limit ?? 40).map((t) => ({ formKey: t.formKey, editorId: t.editorId })) } };
      },
    },
    {
      name: 'create_worldspace',
      group: 'world',
      writes: true,
      description: 'Create a new worldspace (an outdoor map of its own, reached through a door) with a square of flat outdoor cells. Its weather, water and music can be taken from an existing worldspace (like).',
      input: z.object({
        editorId: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Letters, digits and _ only'),
        name: z.string().nullable().optional().describe('Shown on the map and when the player enters'),
        size: z.number().int().min(1).max(9).nullable().optional().describe('Cells along each side (odd; default 3)'),
        groundHeight: z.number().nullable().optional().describe('Height of the flat ground (default 0)'),
        texture: z.string().nullable().optional().describe('Landscape texture for the ground (list_ground_textures)'),
        water: z.boolean().nullable().optional().describe('Water a little below the ground'),
        like: z.string().nullable().optional().describe('A worldspace to take weather, water and music from'),
      }),
      summary: (i) => `Create the worldspace ${i.name ?? i.editorId}`,
      run: (i) => {
        if (ws().byEditorId(i.editorId)) throw new WorkspaceError(`${i.editorId} is already used; pick another Editor ID`);
        const r = host.createWorldspace({
          editorId: i.editorId,
          ...(i.name ? { name: i.name } : {}),
          ...(i.size ? { size: i.size } : {}),
          ...(typeof i.groundHeight === 'number' ? { groundHeight: i.groundHeight } : {}),
          ...(i.texture ? { texture: texture(i.texture) } : {}),
          ...(i.water ? { water: true } : {}),
          ...(i.like ? { like: worldspace(i.like) } : {}),
        });
        return { data: { worldspace: r.worldspace, middleCell: r.center, cells: r.cells.length, note: 'Add a door to it from an existing place with add_linked_door (to the middle cell).' }, link: scene(r.center, i.name ?? i.editorId) };
      },
    },
    {
      name: 'create_outdoor_cell',
      group: 'world',
      writes: true,
      description: 'Add an outdoor cell to a worldspace, next to an existing cell (nextTo and direction) or at a free spot. Its ground meets the cells around it and takes their most used texture.',
      input: z.object({
        worldspace: z.string().nullable().optional().describe('Needed unless nextTo is given'),
        nextTo: z.string().nullable().optional().describe('An outdoor cell to add it beside'),
        direction: z.enum(Object.keys(DIRS) as [string, ...string[]]).nullable().optional().describe('Which side of nextTo (default: the nearest free spot)'),
        editorId: z.string().nullable().optional(),
        name: z.string().nullable().optional(),
        texture: z.string().nullable().optional().describe('Landscape texture for its ground'),
      }),
      summary: (i) => `Add an outdoor cell${i.nextTo ? ` ${i.direction ?? 'next to'}${i.direction ? ' of' : ''} ${i.nextTo}` : ''}`,
      run: (i) => {
        const near = i.nextTo ? outdoor(i.nextTo) : null;
        const w = near?.worldspace ?? (i.worldspace ? worldspace(i.worldspace) : null);
        if (!w) throw new WorkspaceError('Say which worldspace (worldspace) or which cell to add it next to (nextTo)');
        let grid: { x: number; y: number };
        if (near && i.direction) {
          const [dx, dy] = DIRS[i.direction]!;
          grid = { x: near.grid.x + dx, y: near.grid.y + dy };
          if (host.cells({ worldspace: w }).some((c) => !c.persistentCell && c.grid?.x === grid.x && c.grid?.y === grid.y)) throw new WorkspaceError(`There's already a cell ${i.direction} of ${near.label}; pick another side or leave direction out`);
        } else grid = host.freeCellSpot(w, near?.grid);
        if (i.editorId && ws().byEditorId(i.editorId)) throw new WorkspaceError(`${i.editorId} is already used`);
        const cell = host.createExteriorCell(w, grid, { ...(i.editorId ? { editorId: i.editorId } : {}), ...(i.name ? { name: i.name } : {}), ...(i.texture ? { texture: texture(i.texture) } : {}) });
        return { data: { cell, grid, worldspace: ws().summary(w)?.editorId }, link: scene(cell, i.name ?? i.editorId ?? 'New cell') };
      },
    },
    {
      name: 'shape_ground',
      group: 'world',
      writes: true,
      description:
        'Shape the ground of an outdoor cell: a hill (raise), a hollow (lower), a flat spot (flatten, to a height or the height there), or smooth out bumps. One spot makes a round shape; several points make a ridge, a valley or a flat road through them. The ground of neighbouring cells follows where it reaches them. Placed objects are not moved: drop_to_floor them afterwards.',
      input: z.object({
        place: z.string().describe('Editor ID or FormKey of an outdoor cell'),
        shape: z.enum(['hill', 'hollow', 'flatten', 'smooth']),
        ...Where,
        width: z.number().min(1).max(58).nullable().optional().describe('Radius in metres (default 9; a house is about 10 m across)'),
        height: z.number().nullable().optional().describe('hill/hollow: how much higher or lower, in metres (default 4, at most 40). flatten: the ground height to level to, in metres as ground_info gives it (default: the height there)'),
      }),
      summary: (i) => `Make a ${i.shape === 'flatten' ? 'flat spot' : i.shape === 'smooth' ? 'smoother ground' : i.shape} in ${i.place}`,
      run: (i) => {
        const c = outdoor(i.place);
        const radius = (i.width ?? 9) * M;
        const line = stroke(c, i, radius);
        const before = heights(c.cell);
        const mid = line[Math.floor(line.length / 2)]!;
        const at0 = heightAt(c.worldspace, mid);
        const changed = new Set<FormKey>();
        const sculpt = (points: { x: number; y: number }[], opts: Parameters<EngineHost['sculptTerrain']>[2]) => host.sculptTerrain(c.cell, points, opts).forEach((k) => changed.add(k));
        if (i.shape === 'hill' || i.shape === 'hollow') {
          const amount = Math.min(40, Math.abs(i.height ?? 4)) * M;
          const opts = { mode: i.shape === 'hill' ? ('raise' as const) : ('lower' as const), radius, strength: Math.min(1, amount / DAB) };
          // One pass, then as many more as it takes to reach the height asked for (dabs along a line overlap, so measure rather than guess).
          sculpt(line, opts);
          const step = Math.abs((heightAt(c.worldspace, mid) ?? 0) - (at0 ?? 0));
          const more = step > 0 ? Math.min(60, Math.round((amount - step) / step)) : 0;
          if (more > 0) sculpt(Array.from({ length: more }, () => line).flat(), opts);
        } else if (i.shape === 'flatten') sculpt([...line, ...line, ...line], { mode: 'flatten', radius, strength: 1, ...(typeof i.height === 'number' ? { flattenTo: i.height * M } : {}) });
        else sculpt([...line, ...line], { mode: 'smooth', radius, strength: 1 });
        const at1 = heightAt(c.worldspace, mid);
        return { data: { cellsChanged: changed.size, metresThereBefore: metres(at0), metresThereAfter: metres(at1), cellBefore: before, cellAfter: heights(c.cell) }, link: scene(c.cell, c.label) };
      },
    },
    {
      name: 'paint_ground',
      group: 'world',
      writes: true,
      description: 'Paint the ground of an outdoor cell with a landscape texture (list_ground_textures): at a spot, along a line of points (a road or a stream bed), or the whole cell.',
      input: z.object({
        place: z.string().describe('Editor ID or FormKey of an outdoor cell'),
        texture: z.string(),
        whole: z.boolean().nullable().optional().describe('Paint the whole cell'),
        ...Where,
        width: z.number().min(1).max(58).nullable().optional().describe('Radius in metres (default 6; a road is about 3)'),
      }),
      summary: (i) => `Paint ${i.whole ? 'all of ' : ''}${i.place} with ${i.texture}`,
      run: (i) => {
        const c = outdoor(i.place);
        const tex = texture(i.texture);
        const radius = i.whole ? 400 : (i.width ?? 6) * M;
        let points: { x: number; y: number }[];
        if (i.whole) {
          points = [];
          for (let y = 128; y < CELL; y += 256) for (let x = 128; x < CELL; x += 256) points.push({ x: c.grid.x * CELL + x, y: c.grid.y * CELL + y });
        } else points = stroke(c, i, radius);
        const r = host.paintGroundTexture(c.cell, points, { texture: tex, radius, strength: 1 });
        return { data: { cellsChanged: r.cells.length, ...(r.full ? { note: 'Some ground already had six painted textures (the most it can hold), so the new one could not be added everywhere.' } : {}) }, link: scene(c.cell, c.label) };
      },
    },
  ];
}
