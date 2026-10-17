/**
 * The AI workspace's world tools: new places (copied layouts with a linked
 * door, as plans make them), placing and moving objects, dressing and
 * lighting rooms, linking doors and navmesh. They use the same services as
 * the World tab's tools, so objects land on real surfaces.
 */
import { z } from 'zod';
import { isFormKey, type FormKey } from '@tes5/esp';
import { CELL_MOODS, CLUTTER_THEMES, Placer, WorkspaceError, emptyPlan, validatePlan, type AgentTool, type CellMood, type ClutterTheme } from '@tes5/workspace';
import type { EngineHost } from './host';
import { lookup } from './aitools-lookup';

const Place = z.string().describe('Editor ID or FormKey of the cell (from list_places)');
const Refs = z.array(z.string()).min(1).describe('Placed objects: reference FormKeys from place_contents');

/** Base objects that are carried items (they go on tables and shelves rather than the floor). */
const ITEM_SIGS = new Set(['MISC', 'WEAP', 'ARMO', 'BOOK', 'ALCH', 'INGR', 'KEYM', 'SLGM', 'AMMO', 'SCRL', 'APPA']);

/**
 * A placed object for a record the AI named: a reference as it is, or the one
 * placed copy of a base record (a chest, a character…). Several copies are
 * listed with their cells so the AI can pick; none is an error.
 */
export function placedCopy(host: EngineHost, key: FormKey, what = 'object'): FormKey {
  const ws = host.ws!;
  const sig = ws.summary(key)?.sig;
  if (sig === 'REFR' || sig === 'ACHR') return key;
  const copies = (host.findReferences(key, true) as unknown as { formKey: FormKey; sig: string }[]).filter((r) => (r.sig === 'REFR' || r.sig === 'ACHR') && (ws.view(r.formKey)?.data as { base?: FormKey } | undefined)?.base === key);
  const name = ws.summary(key)?.editorId ?? key;
  if (copies.length === 1) return copies[0]!.formKey;
  if (!copies.length) throw new WorkspaceError(`${name} isn't placed anywhere, so there's no ${what} to use. Place it first (place_object), or pick a placed one (place_contents lists a cell's objects).`);
  const where = copies.slice(0, 12).map((c) => {
    const cell = ws.view(c.formKey)?.parent?.cell;
    return `${c.formKey} in ${cell ? (ws.summary(cell)?.editorId ?? cell) : 'the world'}`;
  });
  throw new WorkspaceError(`${name} is placed ${copies.length} times; say which one: ${where.join('; ')}${copies.length > 12 ? '…' : ''}.`);
}

export function worldTools(host: EngineHost): AgentTool<any>[] {
  const ws = () => {
    if (!host.ws) throw new WorkspaceError('No game data is open');
    return host.ws;
  };
  const resolve = (ref: string, what: string, sigs?: string[]): FormKey => {
    const r = ref.trim();
    // A base record where a placed one is wanted is looked up as any record, then swapped for its placed copy.
    const key = lookup(ws(), r, { what, ...(sigs && !sigs.includes('REFR') ? { sigs } : {}) });
    const sig = ws().summary(key)?.sig;
    // A base record where a placed one is wanted: its placed copy.
    if (key && sig && sigs?.includes('REFR') && !sigs.includes(sig)) return placedCopy(host, key, what);
    if (!key || !sig || (sigs && !sigs.includes(sig))) throw new WorkspaceError(`There's no ${what} "${r}". Find it with ${what === 'place' ? 'list_places' : 'search_records or place_contents'} first.`);
    return key;
  };
  const cell = (ref: string) => resolve(ref, 'place', ['CELL']);
  const label = (k: FormKey) => {
    const s = ws().summary(k);
    return s?.name || s?.editorId || k;
  };
  const scene = (k: FormKey) => ({ tab: 'scene' as const, key: k, label: `${label(k)} in World` });
  /** The cell a placed object is in. */
  const cellOf = (ref: FormKey): FormKey | undefined => ws().view(ref)?.parent?.cell;
  /** Where a placed object is now. */
  const transformOf = (ref: FormKey) => {
    const c = cellOf(ref);
    const t = c ? host.references(c).find((r) => r.formKey === ref)?.transform : undefined;
    if (!t) throw new WorkspaceError(`${ref} isn't a placed object in a cell`);
    return t;
  };

  return [
    {
      name: 'create_place',
      group: 'world',
      writes: true,
      description:
        'Create a new interior. With layoutLike (an existing interior that fits: an inn, a house, a cave…) its rooms, furniture, lights and clutter are copied, so it is ready to use; with doorFrom (a cell), a door is added there and linked to the new place. Characters, scripts and quest objects of the copied place are left out.',
      input: z.object({ name: z.string().describe('Name shown in game'), description: z.string().nullable().optional(), layoutLike: z.string().nullable().optional().describe('Editor ID of an interior to copy'), doorFrom: z.string().nullable().optional().describe('Editor ID of the cell the player enters from') }),
      summary: (i) => `Create the place ${i.name}`,
      run: async (i) => {
        if (i.layoutLike) cell(i.layoutLike);
        if (i.doorFrom) cell(i.doorFrom);
        const plan = emptyPlan();
        plan.title = i.name;
        plan.editorId = `${i.name.replace(/[^A-Za-z0-9]/g, '') || 'Place'}Changes`;
        plan.stages = [];
        plan.locations = [{ key: 'place', name: i.name, existing: null, description: i.description ?? '', layoutLike: i.layoutLike ?? null, doorFrom: i.doorFrom ?? null }];
        const errors = validatePlan(plan).filter((x) => x.severity === 'error');
        if (errors.length) throw new WorkspaceError(errors.map((e) => e.message).join('; '));
        const r = await host.buildQuestPlan(plan);
        const made = r.created.find((c) => c.kind === 'location');
        return { data: { place: made?.formKey, created: r.created.map((c) => `${c.kind}: ${c.label}`), notes: r.notes, warnings: r.warnings }, ...(made ? { link: scene(made.formKey) } : {}) };
      },
    },
    {
      name: 'place_object',
      group: 'world',
      writes: true,
      adds: true,
      description:
        "Place objects in a cell. An item goes on a table or shelf in the cell by itself, so there's no need to find the table first ('where' can name one in words, e.g. \"on the bar\"); furniture, a container, a light, a static or a character goes on open floor, or next to what 'where' names (\"by the fire\", \"behind the bar\"). They're dropped onto the surface below.",
      input: z.object({ place: Place, object: z.string().describe('Editor ID or FormKey of the base object to place (search_records)'), where: z.string().nullable().optional().describe('Next to or on what, in words'), count: z.number().int().min(1).max(20).nullable().optional() }),
      summary: (i) => `Place ${i.count && i.count > 1 ? `${i.count} × ` : ''}${i.object} in ${i.place}`,
      run: async (i) => {
        const c = cell(i.place);
        const base = resolve(i.object, 'object');
        const sig = ws().summary(base)!.sig;
        if (sig === 'CELL' || sig === 'WRLD' || sig === 'QUST') throw new WorkspaceError(`${i.object} can't be placed`);
        const placer = new Placer(host.env!, host.world!, Math.random);
        const placed: FormKey[] = [];
        for (let n = 0; n < (i.count ?? 1); n++) {
          let position;
          let yaw = Math.random() * Math.PI * 2;
          const item = ITEM_SIGS.has(sig) ? placer.itemSpot(c, i.where ?? null, n) : null;
          if (item?.kind === 'on') position = item.position;
          else {
            const spot = await placer.actorSpot(c, i.where ?? null);
            position = spot.position;
            yaw = spot.yaw;
          }
          placed.push(host.placeReference(c, base, { position, rotation: { x: 0, y: 0, z: yaw } }));
        }
        // Characters stand where they're put; everything else settles on what's below it.
        if (sig !== 'NPC_') await host.envDrop(placed);
        return { data: { placed, base: label(base), place: label(c) }, link: scene(c) };
      },
    },
    {
      name: 'move_objects',
      group: 'world',
      writes: true,
      adds: true,
      description: 'Move and/or turn placed objects: by an offset in game units (about 70 units = 1 m; z is up) and a turn in degrees, then drop them onto the surface below unless told not to.',
      input: z.object({ refs: Refs, offset: z.object({ x: z.number(), y: z.number(), z: z.number() }).nullable().optional(), turnDegrees: z.number().nullable().optional(), drop: z.boolean().nullable().optional() }),
      summary: (i) => `Move ${i.refs.length} object${i.refs.length === 1 ? '' : 's'}`,
      run: async (i) => {
        const refs = i.refs.map((r: string) => resolve(r, 'placed object', ['REFR', 'ACHR']));
        const changes = refs.map((ref: FormKey) => {
          const { position: p, rotation: r } = transformOf(ref);
          return { ref, transform: { position: { x: p.x + (i.offset?.x ?? 0), y: p.y + (i.offset?.y ?? 0), z: p.z + (i.offset?.z ?? 0) }, rotation: { ...r, z: r.z + ((i.turnDegrees ?? 0) * Math.PI) / 180 } } };
        });
        await host.transformReferences(changes, 'Move');
        if (i.drop !== false) await host.envDrop(refs);
        const c = cellOf(refs[0]!);
        return { data: { moved: refs.length }, ...(c ? { link: scene(c) } : {}) };
      },
    },
    {
      name: 'remove_objects',
      group: 'world',
      writes: true,
      description: "Remove placed objects. Objects from other plugins are disabled rather than deleted (deleting them can crash the game).",
      input: z.object({ refs: Refs }),
      summary: (i) => `Remove ${i.refs.length} object${i.refs.length === 1 ? '' : 's'}`,
      run: (i) => ({ data: host.deleteReferences(i.refs.map((r: string) => resolve(r, 'placed object', ['REFR', 'ACHR']))) }),
    },
    {
      name: 'dress_room',
      group: 'world',
      writes: true,
      adds: true,
      description: `Fill a room with clutter that fits its use, on its tables and along its floors: ${Object.entries(CLUTTER_THEMES)
        .map(([id, t]) => `${id} (${t.label})`)
        .join(', ')}.`,
      input: z.object({ place: Place, theme: z.enum(Object.keys(CLUTTER_THEMES) as [ClutterTheme, ...ClutterTheme[]]), amount: z.enum(['light', 'medium', 'heavy']).nullable().optional() }),
      summary: (i) => `Dress ${i.place} as a ${i.theme}`,
      run: async (i) => {
        const c = cell(i.place);
        const r = await host.envClutter(c, { theme: i.theme, amount: i.amount ?? 'medium' });
        return { data: { onTables: r.table.length, onFloor: r.floor.length }, link: scene(c) };
      },
    },
    {
      name: 'light_room',
      group: 'world',
      writes: true,
      description: `Light an interior: optionally set its mood (ambient, directional and fog colours: ${Object.entries(CELL_MOODS)
        .map(([id, m]) => `${id} (${m.label})`)
        .join(', ')}), then give every candle, torch, brazier and fire a matching light.`,
      input: z.object({ place: Place, mood: z.enum(Object.keys(CELL_MOODS) as [CellMood, ...CellMood[]]).nullable().optional() }),
      summary: (i) => `Light ${i.place}${i.mood ? ` (${i.mood})` : ''}`,
      run: (i) => {
        const c = cell(i.place);
        if (i.mood) host.envSetMood(c, i.mood);
        return { data: host.envLightingPass(c), link: scene(c) };
      },
    },
    {
      name: 'add_linked_door',
      group: 'world',
      writes: true,
      description: 'Add a door in another cell that leads to (and is linked with) an existing load door, so the player can go both ways. Outdoors it stands near the middle of the cell, to be moved by hand.',
      input: z.object({ door: z.string().describe('Reference FormKey of a placed door (place_contents lists doors)'), to: Place }),
      summary: (i) => `Add a door to ${i.to} linked with ${i.door}`,
      run: async (i) => {
        const door = resolve(i.door, 'placed object', ['REFR']);
        const target = cell(i.to);
        const key = await host.envCreateLinkedDoor(door, target);
        return { data: { door: key }, link: scene(target) };
      },
    },
    {
      name: 'link_doors',
      group: 'world',
      writes: true,
      description: 'Link two placed load doors to each other (each leads to the other), with arrival points on the open side.',
      input: z.object({ a: z.string(), b: z.string() }),
      summary: (i) => `Link the doors ${i.a} and ${i.b}`,
      run: async (i) => ({ data: await host.envLinkDoors(resolve(i.a, 'placed object', ['REFR']), resolve(i.b, 'placed object', ['REFR'])) }),
    },
    {
      name: 'make_navmesh',
      group: 'world',
      writes: true,
      description: 'Generate the navmesh of a cell (where characters can walk), replacing the one made here before. Do it after building or changing a place.',
      input: z.object({ place: Place }),
      summary: (i) => `Make the navmesh of ${i.place}`,
      run: async (i) => {
        const c = cell(i.place);
        const r = await host.generateNavmesh(c);
        return { data: { triangles: r.triangles, warnings: (r as { warnings?: string[] }).warnings }, link: scene(c) };
      },
    },
    {
      name: 'drop_to_floor',
      group: 'world',
      writes: true,
      description: 'Drop placed objects onto the surface below them (fixes floating or sunk items).',
      input: z.object({ refs: Refs }),
      summary: (i) => `Drop ${i.refs.length} object${i.refs.length === 1 ? '' : 's'} to the floor`,
      run: async (i) => ({ data: await host.envDrop(i.refs.map((r: string) => resolve(r, 'placed object', ['REFR', 'ACHR']))) }),
    },
  ];
}
