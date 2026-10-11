/**
 * Automations that replace manual Creation Kit chores:
 *  - ESL eligibility report and FormID compaction
 *  - Object bounds (OBND) recomputed from the model on save
 *  - Navmesh generation for a cell from its placed geometry, with door
 *    links and cross-cell portal links
 */
import { flattenMeshes, nifBounds, parseNif } from '@tes5/assets';
import { RecordFlags, makeFormKey, parseFormKey, type FormKey, type Navmesh } from '@tes5/esp';
import {
  NAVMESH_PRESETS,
  createNavmesh,
  generateWalkableMesh,
  linkDoors,
  linkNavmeshes,
  snapToCellBorder,
  validateNavmesh,
  walkableTriangles,
  type GenerateSettings,
  type NavmeshIssue,
  type TriangleMesh,
} from '@tes5/navmesh';
import { WorkspaceError, type Workspace } from './engine';
import { WorldService, type PlacedRef } from './world';

// ------------------------------------------------------------------ ESL

export interface EslReport {
  plugin: string;
  /** The plugin already has the light (ESL) flag. */
  flagged: boolean;
  newRecords: number;
  /** Highest object ID in use. */
  maxObjectId: number;
  /** Records whose FormIDs fall outside 0x800–0xFFF. */
  outOfRange: number;
  /** Can be ESL-flagged as is. */
  eligible: boolean;
  /** Can be ESL-flagged after compacting FormIDs. */
  eligibleAfterCompaction: boolean;
  notes: string[];
}

export function eslReport(ws: Workspace): EslReport {
  const a = ws.active;
  if (!a?.plugin) throw new WorkspaceError('No active plugin');
  const self = a.plugin.masters.length;
  const own = [...a.plugin.records()].filter((r) => r.formId >>> 24 === self);
  const ids = own.map((r) => r.formId & 0xffffff);
  const outOfRange = ids.filter((id) => id < 0x800 || id > 0xfff).length;
  const notes: string[] = [];
  const hasNewCells = own.some((r) => r.sig === 'CELL');
  if (hasNewCells) notes.push('New cells in ESL plugins can lose references after saves in some game versions; test carefully.');
  if (own.length > 2048) notes.push(`${own.length} new records; ESL plugins can hold at most 2048.`);
  if (outOfRange) notes.push(`${outOfRange} FormID(s) outside 0x800-0xFFF; compaction renumbers them (breaks saves, FaceGen and voice files that use the old IDs).`);
  return {
    plugin: a.name,
    flagged: a.plugin.isESL,
    newRecords: own.length,
    maxObjectId: ids.length ? Math.max(...ids) : 0,
    outOfRange,
    eligible: own.length <= 2048 && outOfRange === 0,
    eligibleAfterCompaction: own.length <= 2048,
    notes,
  };
}

/**
 * Turn the light (ESL) flag on or off for the active plugin. Turning it on is
 * refused unless every new record fits (see eslReport); one undo step.
 */
export function setLightFlag(ws: Workspace, on: boolean): void {
  const a = ws.active;
  if (!a?.plugin) throw new WorkspaceError('No active plugin');
  if (a.plugin.isESL === on) return;
  if (on && !eslReport(ws).eligible) throw new WorkspaceError('This plugin has too many new records, or FormIDs outside 0x800-0xFFF, to be a light plugin. Compact FormIDs first.');
  ws.transaction(on ? 'Flag as light plugin (ESL)' : 'Remove light plugin (ESL) flag', () => {
    a.plugin!.isESL = on;
    a.isLight = on;
    a.isMaster = a.plugin!.loadsAsMaster;
  });
}

/**
 * Renumber the active plugin's new records into the ESL range and update every
 * reference inside the plugin. Returns old → new FormKeys.
 */
export function compactFormIds(ws: Workspace): Map<FormKey, FormKey> {
  const a = ws.active;
  if (!a?.plugin || !a.mapper) throw new WorkspaceError('No active plugin');
  const self = a.plugin.masters.length;
  const own = [...a.plugin.records()].filter((r) => r.formId >>> 24 === self);
  if (own.length > 2048) throw new WorkspaceError('Too many new records for an ESL plugin');
  const used = new Set(own.map((r) => r.formId & 0xffffff).filter((id) => id >= 0x800 && id <= 0xfff));
  const map = new Map<FormKey, FormKey>();
  let next = 0x800;
  for (const r of own) {
    const id = r.formId & 0xffffff;
    if (id >= 0x800 && id <= 0xfff) continue;
    while (used.has(next)) next++;
    used.add(next);
    map.set(makeFormKey(id, a.name), makeFormKey(next, a.name));
  }
  if (!map.size) return map;
  ws.transaction('Compact FormIDs', () => {
    const plugin = a.plugin!;
    // Decode everything first (with old keys), then rewrite with the mapping.
    const decoded = [...plugin.walk()].map((loc) => ({ rec: loc.record, typed: ws.decode(a, loc.record) }));
    for (const { rec, typed } of decoded) {
      const oldKey = ws.keyOf(a, rec.formId)!;
      const newKey = map.get(oldKey);
      if (typed.hasSchema && typed.lossless && typed.unknown.length === 0) {
        const remapped = JSON.parse(JSON.stringify(typed.data, (_k, v) => (typeof v === 'string' && map.has(v) ? map.get(v) : v instanceof Uint8Array ? { __bytes: Array.from(v) } : v)), (_k, v) =>
          v && typeof v === 'object' && Array.isArray(v.__bytes) ? new Uint8Array(v.__bytes) : v,
        );
        if (newKey) rec.formId = ((self << 24) | parseFormKey(newKey).objectId) >>> 0;
        ws.updateRecord(newKey ?? oldKey, remapped, { label: 'Compact FormIDs' });
      } else if (newKey) {
        rec.formId = ((self << 24) | parseFormKey(newKey).objectId) >>> 0;
      }
    }
    for (const g of groupsOf(plugin)) {
      const k = ws.keyOf(a, g.label);
      if (k && map.has(k) && [1, 6, 7, 8, 9].includes(g.type)) g.label = ((self << 24) | parseFormKey(map.get(k)!).objectId) >>> 0;
    }
    plugin.hedr = { ...plugin.hedr, nextObjectId: Math.max(...[...used], 0x7ff) + 1 };
    plugin.invalidateIndex();
  });
  return map;
}

function* groupsOf(plugin: NonNullable<Workspace['active']>['plugin']) {
  if (!plugin) return;
  const stack = [...plugin.groups];
  while (stack.length) {
    const g = stack.pop()!;
    yield g;
    for (const c of g.children) if (c.kind === 'group') stack.push(c);
  }
}

// ------------------------------------------------------------------ bounds

const BOUNDED = new Set(['STAT', 'MSTT', 'ACTI', 'DOOR', 'CONT', 'FURN', 'FLOR', 'TREE', 'MISC', 'WEAP', 'ARMO', 'BOOK', 'KEYM', 'AMMO', 'ALCH', 'INGR', 'SLGM', 'LIGH', 'SCOL', 'TXST']);

/** Compute OBND for a base object from its model (rounded outward like the CK). */
export async function computeBounds(ws: Workspace, key: FormKey): Promise<{ x1: number; y1: number; z1: number; x2: number; y2: number; z2: number } | undefined> {
  const v = ws.view(key);
  const model = (v?.data as any)?.model?.file as string | undefined;
  if (!model) return undefined;
  const path = `meshes\\${model.replace(/^meshes[\\/]/i, '')}`;
  if (!ws.vfs.has(path)) return undefined;
  const b = nifBounds(parseNif(await ws.vfs.read(path)));
  if (!b) return undefined;
  const clamp = (n: number) => Math.max(-32768, Math.min(32767, n));
  return { x1: clamp(Math.floor(b.min[0])), y1: clamp(Math.floor(b.min[1])), z1: clamp(Math.floor(b.min[2])), x2: clamp(Math.ceil(b.max[0])), y2: clamp(Math.ceil(b.max[1])), z2: clamp(Math.ceil(b.max[2])) };
}

/** Base objects in the active plugin whose OBND doesn't match their model, with the correct bounds. */
export async function boundsMismatches(ws: Workspace): Promise<{ key: FormKey; bounds: NonNullable<Awaited<ReturnType<typeof computeBounds>>> }[]> {
  const a = ws.active;
  if (!a?.plugin) return [];
  const out: { key: FormKey; bounds: NonNullable<Awaited<ReturnType<typeof computeBounds>>> }[] = [];
  for (const r of a.plugin.records()) {
    if (!BOUNDED.has(r.sig)) continue;
    const key = ws.keyOf(a, r.formId)!;
    const bounds = await computeBounds(ws, key);
    if (!bounds) continue;
    const cur = (ws.view(key)?.data as any)?.bounds;
    if (cur && ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'].every((k) => cur[k] === (bounds as any)[k])) continue;
    out.push({ key, bounds });
  }
  return out;
}

/** Recompute bounds of base objects in the active plugin whose OBND doesn't match their model. */
export async function updateBounds(ws: Workspace): Promise<FormKey[]> {
  const changed: FormKey[] = [];
  const updates = await boundsMismatches(ws);
  if (updates.length) {
    ws.transaction('Update object bounds', () => {
      for (const u of updates) {
        ws.editRecord(u.key, (d) => {
          d.bounds = u.bounds;
          return d;
        });
        changed.push(u.key);
      }
    });
  }
  return changed;
}

// ------------------------------------------------------------------ navmesh

export interface NavmeshGenerationResult {
  navmesh: FormKey;
  triangles: number;
  vertices: number;
  doors: number;
  portals: number;
  issues: NavmeshIssue[];
  usedRecast: boolean;
}

/** Row-major 3×3 matrix taking a reference's local axes to world axes. */
export function rotationMatrix(r: { x: number; y: number; z: number }): number[] {
  // Skyrim applies rotations in Z-Y-X order (extrinsic X, then Y, then Z), angles in radians.
  const cx = Math.cos(r.x);
  const sx = Math.sin(r.x);
  const cy = Math.cos(r.y);
  const sy = Math.sin(r.y);
  const cz = Math.cos(r.z);
  const sz = Math.sin(r.z);
  // R = Rz(-z) * Ry(-y) * Rx(-x): Bethesda angles rotate clockwise when viewed down the axis.
  const Rx = [1, 0, 0, 0, cx, sx, 0, -sx, cx];
  const Ry = [cy, 0, -sy, 0, 1, 0, sy, 0, cy];
  const Rz = [cz, sz, 0, -sz, cz, 0, 0, 0, 1];
  const mul = (a: number[], b: number[]) => {
    const o = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k]! * b[k * 3 + j]!;
    return o;
  };
  return mul(mul(Rz, Ry), Rx);
}

/**
 * World-space triangles of everything placed in a cell (render geometry).
 * `owners`, if given, receives the reference each triangle belongs to.
 */
export async function cellGeometry(ws: Workspace, refs: PlacedRef[], owners?: (FormKey | null)[], cache = new Map<string, ReturnType<typeof flattenMeshes>>()): Promise<TriangleMesh> {
  const out: TriangleMesh = { vertices: [], triangles: [] };
  for (const ref of refs) {
    if (!ref.model || ref.disabled || ref.deleted || ref.marker) continue;
    if (ref.baseSig && !['STAT', 'MSTT', 'FURN', 'CONT', 'ACTI', 'DOOR', 'TREE', 'SCOL'].includes(ref.baseSig)) continue;
    const path = `meshes\\${ref.model.replace(/^meshes[\\/]/i, '')}`.toLowerCase();
    let meshes = cache.get(path);
    if (!meshes) {
      if (!ws.vfs.has(path)) continue;
      try {
        meshes = flattenMeshes(parseNif(await ws.vfs.read(path)));
      } catch {
        continue;
      }
      cache.set(path, meshes);
    }
    const R = rotationMatrix(ref.transform.rotation);
    const s = ref.transform.scale;
    const p = ref.transform.position;
    for (const { mesh, matrix: m } of meshes) {
      if (mesh.material.alphaBlend) continue;
      const base = out.vertices.length / 3;
      const pos = mesh.positions;
      for (let i = 0; i < pos.length; i += 3) {
        const lx = m[0]! * pos[i]! + m[4]! * pos[i + 1]! + m[8]! * pos[i + 2]! + m[12]!;
        const ly = m[1]! * pos[i]! + m[5]! * pos[i + 1]! + m[9]! * pos[i + 2]! + m[13]!;
        const lz = m[2]! * pos[i]! + m[6]! * pos[i + 1]! + m[10]! * pos[i + 2]! + m[14]!;
        out.vertices.push(
          p.x + s * (R[0]! * lx + R[1]! * ly + R[2]! * lz),
          p.y + s * (R[3]! * lx + R[4]! * ly + R[5]! * lz),
          p.z + s * (R[6]! * lx + R[7]! * ly + R[8]! * lz),
        );
      }
      for (let i = 0; i < mesh.indices.length; i++) out.triangles.push(base + mesh.indices[i]!);
      if (owners) for (let i = 0; i < mesh.indices.length; i += 3) owners.push(ref.formKey);
    }
  }
  return out;
}

/** Add LAND terrain triangles (counter-clockwise from above, i.e. walkable side up). */
export function appendTerrain(out: TriangleMesh, land: ReturnType<WorldService['terrain']>): void {
  if (!land) return;
  const base = out.vertices.length / 3;
  for (let r = 0; r < 33; r++) for (let c = 0; c < 33; c++) out.vertices.push(land.origin.x + c * 128, land.origin.y + r * 128, land.heights[r * 33 + c]!);
  for (let r = 0; r < 32; r++)
    for (let c = 0; c < 32; c++) {
      const a = base + r * 33 + c;
      out.triangles.push(a, a + 1, a + 34, a, a + 34, a + 33);
    }
}

/**
 * Generate (or regenerate) the navmesh of a cell from its geometry, link doors
 * and neighbouring exterior navmeshes, and store it in the active plugin.
 */
export async function generateCellNavmesh(ws: Workspace, cell: FormKey, opts: { preset?: keyof typeof NAVMESH_PRESETS; settings?: Partial<GenerateSettings>; useRecast?: boolean } = {}): Promise<NavmeshGenerationResult> {
  const world = new WorldService(ws);
  const cellInfo = world.cells().find((c) => c.formKey === cell);
  if (!cellInfo) throw new WorkspaceError(`Cell ${cell} not found`);
  const refs = world.references(cell);
  const geometry = await cellGeometry(ws, refs);
  if (!cellInfo.interior) appendTerrain(geometry, world.terrain(cell));
  if (!geometry.triangles.length) throw new WorkspaceError('No solid geometry in this cell to build a navmesh from');
  const preset = NAVMESH_PRESETS[opts.preset ?? (cellInfo.interior ? 'interior' : 'exterior')];
  const settings: GenerateSettings = { ...preset, ...opts.settings };
  if (!cellInfo.interior && cellInfo.grid) {
    settings.clip = { minX: cellInfo.grid.x * 4096, minY: cellInfo.grid.y * 4096, maxX: (cellInfo.grid.x + 1) * 4096, maxY: (cellInfo.grid.y + 1) * 4096 };
  }
  let mesh: TriangleMesh;
  let usedRecast = opts.useRecast ?? true;
  if (usedRecast) {
    const res = await generateWalkableMesh(geometry, settings);
    if (res.error || !res.mesh.triangles.length) {
      usedRecast = false;
      mesh = walkableTriangles(geometry, settings.maxSlope);
    } else mesh = res.mesh;
  } else mesh = walkableTriangles(geometry, settings.maxSlope);
  if (!mesh.triangles.length) throw new WorkspaceError('Nothing walkable found');

  const nav: Navmesh = createNavmesh(mesh, cellInfo.interior ? { cell } : { world: cellInfo.worldspace, grid: cellInfo.grid });
  if (!cellInfo.interior && cellInfo.grid) snapToCellBorder(nav, cellInfo.grid);
  const doors = refs.filter((r) => r.baseSig === 'DOOR' && !r.disabled).map((r) => ({ ref: r.formKey, position: r.transform.position }));
  const doorCount = linkDoors(nav, doors);

  // Replace an existing navmesh of ours in this cell, or create a new one.
  const existing = existingNavmeshes(ws, cell).find((n) => parseFormKey(n).plugin === ws.activeName);
  let navKey: FormKey;
  let portals = 0;
  const result = ws.transaction('Generate navmesh', () => {
    if (existing) {
      ws.editRecord(existing, (d) => ({ ...d, geometry: nav }));
      navKey = existing;
    } else {
      navKey = ws.createRecord('NAVM', { geometry: nav }, { cell, persistent: false }, RecordFlags.NavmeshAutoGen);
    }
    // Exterior: connect to navmeshes of the 4 neighbouring cells.
    if (!cellInfo.interior && cellInfo.grid && cellInfo.worldspace) {
      for (const n of world.cells({ worldspace: cellInfo.worldspace })) {
        if (!n.grid || Math.abs(n.grid.x - cellInfo.grid.x) + Math.abs(n.grid.y - cellInfo.grid.y) !== 1) continue;
        for (const other of existingNavmeshes(ws, n.formKey)) {
          const ov = ws.view(other);
          const onav = (ov?.data as any)?.geometry as Navmesh | undefined;
          if (!onav) continue;
          const mine = (ws.view(navKey!)!.data as any).geometry as Navmesh;
          const linked = linkNavmeshes({ id: navKey!, nav: mine }, { id: other, nav: onav });
          if (linked) {
            portals += linked;
            ws.editRecord(navKey!, (d) => ({ ...d, geometry: mine }));
            ws.editRecord(other, (d) => ({ ...d, geometry: onav }));
          }
        }
      }
    }
    return navKey!;
  });
  const final = (ws.view(result)!.data as any).geometry as Navmesh;
  return { navmesh: result, triangles: final.triangles.length, vertices: final.vertices.length, doors: doorCount, portals, issues: validateNavmesh(final), usedRecast };
}

export function existingNavmeshes(ws: Workspace, cell: FormKey): FormKey[] {
  const out = new Set<FormKey>();
  for (const s of ws.loaded()) {
    const local = s.mapper!.toLocal(cell);
    if (local === undefined) continue;
    const c = s.plugin!.getRecord(local);
    if (!c) continue;
    const g = s.plugin!.childGroupOf(c);
    if (!g) continue;
    for (const sub of g.groups) for (const r of sub.records) if (r.sig === 'NAVM' && !r.isDeleted) out.add(ws.keyOf(s, r.formId)!);
  }
  return [...out];
}
