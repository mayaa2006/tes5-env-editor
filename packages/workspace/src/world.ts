/**
 * Environment editing: worldspaces, cells and placed references, with
 * everything the 3D viewport needs (model paths, transforms, flags).
 */
import { GroupType, RecordFlags, decodeCp1252, isInteriorCell, parseFormKey, readCellGrid, type FormKey, type PluginRecord } from '@tes5/esp';
import { WorkspaceError, type PluginSlot, type Workspace } from './engine';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Transform {
  position: Vec3;
  /** Euler angles in radians (Skyrim applies Z, then Y, then X... stored as X, Y, Z). */
  rotation: Vec3;
  scale: number;
}

export interface CellSummary {
  formKey: FormKey;
  editorId?: string;
  name?: string;
  interior: boolean;
  worldspace?: FormKey;
  grid?: { x: number; y: number };
  owner: string;
  inActive: boolean;
  /** The worldspace's persistent cell: holds persistent outdoor references (doors, actors, markers) wherever they stand. */
  persistentCell?: boolean;
}

/** Terrain of one exterior cell. */
/** One quadrant of a cell's ground: base texture and painted layers (LTEX forms). */
export interface LandQuadrant {
  base?: FormKey | null;
  layers: { ltex: FormKey | null; layer: number; alpha: Float32Array }[];
}

export interface CellTerrain {
  cell: FormKey;
  origin: { x: number; y: number };
  heights: Float32Array;
  colors?: Uint8Array;
}

/** An outdoor area: a cell and the ones around it, as loaded together in the 3D view. */
export interface ExteriorArea {
  center: FormKey;
  worldspace?: FormKey;
  /** Grid bounds (inclusive) of the area. */
  min: { x: number; y: number };
  max: { x: number; y: number };
  cells: { formKey: FormKey; grid: { x: number; y: number }; editorId?: string; name?: string }[];
  refs: (PlacedRef & { cell: FormKey })[];
  terrain: CellTerrain[];
}

export interface PlacedRef {
  formKey: FormKey;
  sig: string;
  editorId?: string;
  base: FormKey | null;
  baseSig?: string;
  baseEditorId?: string;
  baseName?: string;
  /** Model path (relative to Data/meshes) of the base object, if any. */
  model?: string;
  transform: Transform;
  persistent: boolean;
  disabled: boolean;
  deleted: boolean;
  /** Plugin that provides this version. */
  source: string;
  /** Light properties for LIGH bases. */
  light?: { radius: number; color: [number, number, number] };
  /** Teleport destination door for load doors. */
  teleport?: FormKey;
  /** Is this a marker (editor-only) object? */
  marker: boolean;
}

const MARKER_MODELS = /(xmarker|markerx|marker_|\\markers\\|doormarker|northmarker|idlemarker|furnituremarker|collisionmarker|roommarker|portalmarker)/i;

function readTransform(rec: PluginRecord): Transform {
  const d = rec.get('DATA');
  const t: Transform = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1 };
  if (d && d.data.byteLength >= 24) {
    const v = new DataView(d.data.buffer, d.data.byteOffset, 24);
    t.position = { x: v.getFloat32(0, true), y: v.getFloat32(4, true), z: v.getFloat32(8, true) };
    t.rotation = { x: v.getFloat32(12, true), y: v.getFloat32(16, true), z: v.getFloat32(20, true) };
  }
  const s = rec.get('XSCL');
  if (s && s.data.byteLength >= 4) t.scale = new DataView(s.data.buffer, s.data.byteOffset, 4).getFloat32(0, true);
  return t;
}

function readFormIdSub(rec: PluginRecord, sig: string): number | undefined {
  const s = rec.get(sig);
  if (!s || s.data.byteLength < 4) return undefined;
  return new DataView(s.data.buffer, s.data.byteOffset, 4).getUint32(0, true);
}

function readModel(rec: PluginRecord): string | undefined {
  // Armor keeps its ground model in MOD2 (male) / MOD4 (female); its MODL entries link armor addons.
  const s = rec.sig === 'ARMO' ? (rec.get('MOD2') ?? rec.get('MOD4')) : rec.get('MODL');
  if (!s) return undefined;
  let end = s.data.indexOf(0);
  if (end < 0) end = s.data.byteLength;
  const p = decodeCp1252(s.data.subarray(0, end)).replace(/\//g, '\\');
  return p || undefined;
}

const cellCache = new WeakMap<Workspace, { revision: number; cells: CellSummary[] }>();

export class WorldService {
  constructor(readonly ws: Workspace) {}

  worldspaces(): { formKey: FormKey; editorId?: string; name?: string }[] {
    return this.ws.search({ sigs: ['WRLD'], limit: 10_000 }).items.map((i) => ({ formKey: i.formKey, editorId: i.editorId, name: i.name }));
  }

  /** All cells (winning versions), optionally only those of a worldspace or interiors. Cached until the data changes. */
  cells(filter: { worldspace?: FormKey; interiorOnly?: boolean } = {}): CellSummary[] {
    let cached = cellCache.get(this.ws);
    if (!cached || cached.revision !== this.ws.revision) cellCache.set(this.ws, (cached = { revision: this.ws.revision, cells: this.readCells() }));
    return cached.cells.filter((c) => (!filter.interiorOnly || c.interior) && (!filter.worldspace || c.worldspace === filter.worldspace));
  }

  private readCells(filter: { worldspace?: FormKey; interiorOnly?: boolean } = {}): CellSummary[] {
    const out = new Map<FormKey, CellSummary>();
    const activeIdx = this.ws.activeName ? this.ws.slots.findIndex((s) => s.name === this.ws.activeName) : -1;
    for (let i = this.ws.slots.length - 1; i >= 0; i--) {
      const s = this.ws.slots[i]!;
      if (!s.plugin) continue;
      for (const loc of s.plugin.cellLocations()) {
        const key = this.ws.keyOf(s, loc.record.formId)!;
        const prev = out.get(key);
        if (prev) {
          // Winner already recorded; just note that the active plugin overrides it.
          if (i === activeIdx) prev.inActive = true;
          continue;
        }
        const world = loc.worldspace !== undefined ? (this.ws.keyOf(s, loc.worldspace) ?? undefined) : undefined;
        const interior = isInteriorCell(loc.record);
        if (filter.interiorOnly && !interior) continue;
        if (filter.worldspace && world !== filter.worldspace) continue;
        out.set(key, {
          formKey: key,
          editorId: loc.record.editorId,
          name: loc.record.peek('FULL') ? this.ws.summary(key)?.name : undefined,
          interior,
          worldspace: world,
          grid: interior ? undefined : readCellGrid(loc.record),
          owner: parseFormKey(key).plugin,
          inActive: i === activeIdx,
          persistentCell: !interior && (loc.record.flags & RecordFlags.Persistent) !== 0 ? true : undefined,
        });
      }
    }
    return [...out.values()].sort((a, b) => ((a.editorId ?? '') < (b.editorId ?? '') ? -1 : (a.editorId ?? '') > (b.editorId ?? '') ? 1 : 0));
  }

  /** Placed references in a cell: merged across all plugins, winning versions only. */
  references(cell: FormKey): PlacedRef[] {
    const refs = new Map<FormKey, PlacedRef>();
    for (let i = this.ws.slots.length - 1; i >= 0; i--) {
      const s = this.ws.slots[i]!;
      if (!s.plugin || !s.mapper) continue;
      const local = s.mapper.toLocal(cell);
      if (local === undefined) continue;
      const cellRec = s.plugin.getRecord(local);
      if (!cellRec) continue;
      const children = s.plugin.childGroupOf(cellRec);
      if (!children) continue;
      for (const g of children.groups) {
        const persistent = g.type === GroupType.CellPersistentChildren;
        for (const r of g.records) {
          if (r.sig === 'NAVM' || r.sig === 'LAND') continue;
          const key = this.ws.keyOf(s, r.formId)!;
          if (refs.has(key)) continue;
          refs.set(key, this.describeRef(s, r, key, persistent));
        }
      }
    }
    return [...refs.values()];
  }

  /**
   * An exterior cell with the cells around it (`radius` rings: 1 = 3×3, 2 = 5×5),
   * their references and terrain. Persistent references (kept in the
   * worldspace's persistent cell) are included where they stand in the area.
   */
  area(center: FormKey, radius = 1): ExteriorArea {
    const all = this.cells();
    const c = all.find((x) => x.formKey === center);
    if (!c?.grid || c.interior) throw new WorkspaceError('Surrounding cells only exist outdoors');
    const r = Math.max(0, Math.min(3, Math.floor(radius)));
    const min = { x: c.grid.x - r, y: c.grid.y - r };
    const max = { x: c.grid.x + r, y: c.grid.y + r };
    const inWorld = all.filter((x) => x.worldspace === c.worldspace && !x.interior);
    const cells = inWorld
      .filter((x) => !x.persistentCell && x.grid && x.grid.x >= min.x && x.grid.x <= max.x && x.grid.y >= min.y && x.grid.y <= max.y)
      .map((x) => ({ formKey: x.formKey, grid: x.grid!, editorId: x.editorId, name: x.name }));
    const refs: (PlacedRef & { cell: FormKey })[] = [];
    const terrain: CellTerrain[] = [];
    for (const cell of cells) {
      for (const ref of this.references(cell.formKey)) refs.push({ ...ref, cell: cell.formKey });
      const t = this.terrain(cell.formKey, cell.grid);
      if (t) terrain.push({ cell: cell.formKey, ...t });
    }
    // Persistent references standing inside the area.
    const x0 = min.x * 4096;
    const x1 = (max.x + 1) * 4096;
    const y0 = min.y * 4096;
    const y1 = (max.y + 1) * 4096;
    for (const p of inWorld.filter((x) => x.persistentCell)) {
      for (const ref of this.references(p.formKey)) {
        const { x, y } = ref.transform.position;
        if (x >= x0 && x < x1 && y >= y0 && y < y1) refs.push({ ...ref, cell: p.formKey, persistent: true });
      }
    }
    return { center, worldspace: c.worldspace, min, max, cells, refs, terrain };
  }

  /** The exterior cell at a grid position in a worldspace, if it exists. */
  cellAt(worldspace: FormKey | undefined, grid: { x: number; y: number }): FormKey | undefined {
    return this.cells().find((x) => x.worldspace === worldspace && !x.interior && !x.persistentCell && x.grid?.x === grid.x && x.grid?.y === grid.y)?.formKey;
  }

  /**
   * Terrain of an exterior cell (winning LAND): 33×33 heights in game units,
   * rows south→north, columns west→east, 128 units apart; optional vertex colours.
   */
  terrain(cell: FormKey, knownGrid?: { x: number; y: number }): { origin: { x: number; y: number }; heights: Float32Array; colors?: Uint8Array } | undefined {
    const grid = knownGrid ?? this.cells().find((c) => c.formKey === cell)?.grid;
    if (!grid) return undefined;
    const info = { grid };
    const land = this.landRecord(cell);
    if (!land) return undefined;
    const r = land.record;
    const vhgt = r.get('VHGT')!;
    const dv = new DataView(vhgt.data.buffer, vhgt.data.byteOffset, vhgt.data.byteLength);
    const heights = new Float32Array(33 * 33);
    let rowStart = dv.getFloat32(0, true);
    for (let row = 0; row < 33; row++) {
      rowStart += dv.getInt8(4 + row * 33);
      let h = rowStart;
      heights[row * 33] = h * 8;
      for (let col = 1; col < 33; col++) {
        h += dv.getInt8(4 + row * 33 + col);
        heights[row * 33 + col] = h * 8;
      }
    }
    const vclr = r.get('VCLR');
    const colors = vclr && vclr.data.byteLength >= 33 * 33 * 3 ? vclr.data.slice(0, 33 * 33 * 3) : undefined;
    return { origin: { x: info.grid.x * 4096, y: info.grid.y * 4096 }, heights, colors };
  }

  /** The winning LAND record of an outdoor cell (with heights), and the plugin it's in. */
  landRecord(cell: FormKey): { slot: PluginSlot; record: PluginRecord } | undefined {
    for (let i = this.ws.slots.length - 1; i >= 0; i--) {
      const s = this.ws.slots[i]!;
      const local = s.plugin && s.mapper?.toLocal(cell);
      const cellRec = local !== undefined && local !== null ? s.plugin!.getRecord(local) : undefined;
      const children = cellRec ? s.plugin!.childGroupOf(cellRec) : undefined;
      if (!children) continue;
      for (const g of children.groups)
        for (const r of g.records) {
          if (r.sig !== 'LAND' || r.isDeleted) continue;
          const vhgt = r.get('VHGT');
          if (!vhgt || vhgt.data.byteLength < 4 + 33 * 33) continue;
          return { slot: s, record: r };
        }
    }
    return undefined;
  }

  /**
   * The ground's texture layers, per quadrant (0 south-west, 1 south-east,
   * 2 north-west, 3 north-east): a base landscape texture, then painted
   * layers in order, each with its opacity at the quadrant's 17×17 points.
   */
  landLayers(cell: FormKey): LandQuadrant[] | undefined {
    const land = this.landRecord(cell);
    if (!land) return undefined;
    const quads: LandQuadrant[] = [0, 1, 2, 3].map(() => ({ layers: [] }));
    let current: LandQuadrant['layers'][number] | undefined;
    for (const sub of land.record.subrecords) {
      const dv = new DataView(sub.data.buffer, sub.data.byteOffset, sub.data.byteLength);
      if ((sub.sig === 'BTXT' || sub.sig === 'ATXT') && sub.data.byteLength >= 8) {
        const id = dv.getUint32(0, true);
        const quadrant = sub.data[4]! & 3;
        const ltex = id ? (this.ws.keyOf(land.slot, id) ?? null) : null;
        if (sub.sig === 'BTXT') {
          quads[quadrant]!.base = ltex;
          current = undefined;
        } else {
          current = { ltex, layer: dv.getUint16(6, true), alpha: new Float32Array(17 * 17) };
          quads[quadrant]!.layers.push(current);
        }
      } else if (sub.sig === 'VTXT' && current) {
        for (let o = 0; o + 8 <= sub.data.byteLength; o += 8) {
          const pos = dv.getUint16(o, true);
          if (pos < 289) current.alpha[pos] = dv.getFloat32(o + 4, true);
        }
      }
    }
    for (const q of quads) q.layers.sort((a, b) => a.layer - b.layer);
    return quads;
  }

  private describeRef(s: PluginSlot, r: PluginRecord, key: FormKey, persistent: boolean): PlacedRef {
    const baseLocal = readFormIdSub(r, 'NAME');
    const base = baseLocal !== undefined ? this.ws.keyOf(s, baseLocal) : null;
    const baseWin = base ? this.ws.winner(base) : undefined;
    const model = baseWin ? readModel(baseWin.record) : undefined;
    const ref: PlacedRef = {
      formKey: key,
      sig: r.sig,
      editorId: r.editorId,
      base,
      baseSig: baseWin?.record.sig,
      baseEditorId: baseWin?.record.editorId,
      baseName: base ? this.ws.summary(base)?.name : undefined,
      model,
      transform: readTransform(r),
      persistent: persistent || r.isPersistent,
      disabled: r.isInitiallyDisabled,
      deleted: r.isDeleted,
      source: s.name,
      marker: !!(model && MARKER_MODELS.test(model)) || baseWin?.record.sig === 'STAT' && !!baseWin && (baseWin.record.flags & 0x00800000) !== 0,
    };
    if (baseWin?.record.sig === 'LIGH') {
      const d = baseWin.record.get('DATA');
      if (d && d.data.byteLength >= 12) {
        const v = new DataView(d.data.buffer, d.data.byteOffset, d.data.byteLength);
        ref.light = { radius: v.getUint32(4, true), color: [d.data[8]! / 255, d.data[9]! / 255, d.data[10]! / 255] };
      }
    }
    const xtel = r.get('XTEL');
    if (xtel && xtel.data.byteLength >= 4) ref.teleport = this.ws.keyOf(s, new DataView(xtel.data.buffer, xtel.data.byteOffset, 4).getUint32(0, true)) ?? undefined;
    return ref;
  }

  /** Place a new reference of `base` in `cell`. */
  placeReference(cell: FormKey, base: FormKey, transform: Partial<Transform> = {}, opts: { persistent?: boolean; editorId?: string } = {}): FormKey {
    const baseWin = this.ws.winner(base);
    if (!baseWin) throw new WorkspaceError(`Base object ${base} not found`);
    const sig = baseWin.record.sig === 'NPC_' ? 'ACHR' : 'REFR';
    const t: Transform = {
      position: transform.position ?? { x: 0, y: 0, z: 0 },
      rotation: transform.rotation ?? { x: 0, y: 0, z: 0 },
      scale: transform.scale ?? 1,
    };
    const data: Record<string, unknown> = {
      base,
      placement: { position: t.position, rotation: t.rotation },
    };
    if (opts.editorId) data.editorId = opts.editorId;
    if (Math.abs(t.scale - 1) > 1e-6) data.scale = t.scale;
    // Actors and quest-referenced objects are persistent; the engine needs them loaded.
    const persistent = opts.persistent ?? sig === 'ACHR';
    return this.ws.createRecord(sig, data, { cell, persistent }, persistent ? RecordFlags.Persistent : 0);
  }

  /** Move/rotate/scale references (one undo step). */
  transformReferences(changes: { ref: FormKey; transform: Partial<Transform> }[], label = 'Transform'): void {
    this.ws.transaction(label, () => {
      for (const c of changes) {
        const v = this.ws.view(c.ref);
        if (!v) throw new WorkspaceError(`${c.ref} not found`);
        const data = structuredClone(v.data) as Record<string, any>;
        const placement = data.placement ?? { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
        if (c.transform.position) placement.position = { ...c.transform.position };
        if (c.transform.rotation) placement.rotation = { ...c.transform.rotation };
        data.placement = placement;
        if (c.transform.scale !== undefined) {
          if (Math.abs(c.transform.scale - 1) < 1e-6) delete data.scale;
          else data.scale = c.transform.scale;
        }
        this.ws.updateRecord(c.ref, data, { unknown: v.unknown });
      }
    });
  }

  /**
   * A new interior laid out like an existing one: the cell's lighting, music
   * and sound, and its walls, furniture, lights and clutter are copied.
   * Characters, quest-controlled objects (initially disabled or with an enable
   * parent), scripts, ownership and links to other places are left out. Load
   * doors are kept but lead nowhere until linked; they're returned.
   */
  copyInterior(source: FormKey, editorId: string, name?: string): { cell: FormKey; refs: FormKey[]; loadDoors: FormKey[]; skipped: number } {
    const src = this.ws.view(source);
    if (!src || src.sig !== 'CELL') throw new WorkspaceError(`${source} isn't a cell`);
    if (!this.cells({ interiorOnly: true }).some((c) => c.formKey === source)) throw new WorkspaceError(`${src.editorId ?? source} is outdoors; only interiors can be copied`);
    return this.ws.transaction(`New place like ${src.editorId ?? source}`, () => {
      const data = structuredClone(src.data) as Record<string, any>;
      for (const k of ['ownership', 'location', 'encounterZone', 'regions', 'lockList', 'scripts']) delete data[k];
      data.editorId = editorId;
      if (name) data.name = name;
      else delete data.name;
      const cell = this.ws.createRecord('CELL', data);
      const map = new Map<FormKey, FormKey>();
      const loadDoors: FormKey[] = [];
      let skipped = 0;
      const made: { key: FormKey; data: Record<string, any>; unknown: unknown }[] = [];
      for (const r of this.references(source)) {
        const v = this.ws.view(r.formKey);
        if (!v || r.deleted || r.sig !== 'REFR' || !r.base) {
          if (r.sig !== 'REFR') skipped++;
          continue;
        }
        const d = structuredClone(v.data) as Record<string, any>;
        if (r.disabled || d.enableParent) {
          skipped++;
          continue;
        }
        const wasLoadDoor = !!d.teleport;
        for (const k of ['editorId', 'scripts', 'ownership', 'linkedRefs', 'activateParents', 'persistLocation', 'locationRefType', 'locationReference', 'encounterZone', 'navmeshDoorLink', 'teleport', 'teleportMessage', 'spawnContainer', 'enableParent', 'leveledItemBase']) delete d[k];
        const key = this.ws.createRecord('REFR', d, { cell, persistent: r.persistent || wasLoadDoor }, (v.flags & ~RecordFlags.Compressed & ~RecordFlags.InitiallyDisabled) | (wasLoadDoor ? RecordFlags.Persistent : 0));
        map.set(r.formKey, key);
        made.push({ key, data: d, unknown: v.unknown });
        if (wasLoadDoor) loadDoors.push(key);
      }
      // Links between copied objects (rooms, portals, multibounds) point at the copies.
      const remap = (x: unknown): unknown => {
        if (typeof x === 'string') return map.get(x as FormKey) ?? x;
        if (Array.isArray(x)) return x.map(remap);
        if (x && typeof x === 'object' && !(x instanceof Uint8Array)) return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, remap(y)]));
        return x;
      };
      for (const m of made) {
        const next = remap(m.data) as Record<string, any>;
        if (JSON.stringify(next) !== JSON.stringify(m.data)) this.ws.updateRecord(m.key, next, { unknown: this.ws.view(m.key)!.unknown });
      }
      return { cell, refs: [...map.values()], loadDoors, skipped };
    });
  }

  /** Create an interior cell. */
  createInteriorCell(editorId: string, name?: string, lighting?: { ambient: [number, number, number] }): FormKey {
    const data: Record<string, unknown> = {
      editorId,
      flags: 0x1,
      lighting: lighting
        ? {
            ambient: { r: lighting.ambient[0], g: lighting.ambient[1], b: lighting.ambient[2] },
            directional: { r: 128, g: 128, b: 128 },
            fogNearColor: { r: 0, g: 0, b: 0 },
            fogNear: 0,
            fogFar: 20000,
            directionalRotationXY: 0,
            directionalRotationZ: 0,
            directionalFade: 1,
            fogClipDistance: 0,
            fogPower: 1,
            ambientColors: new Uint8Array(32),
            fogFarColor: { r: 0, g: 0, b: 0 },
            fogMax: 1,
            lightFadeBegin: 0,
            lightFadeEnd: 0,
            inherits: 0,
          }
        : undefined,
    };
    if (name) data.name = name;
    return this.ws.createRecord('CELL', data);
  }
}
