/**
 * World-building tools that automate the slow parts of set dressing:
 *  - drop objects onto the surface below (optionally tilted to the slope)
 *  - arrays (Blender's array modifier) and placement along a path (roads, fences)
 *  - scatter / erase brushes for plants, rocks and clutter
 *  - a lighting pass (lights for candles, torches and braziers; cell mood presets)
 *  - "clutter this room": themed items on tables and along the walls
 *  - a room builder from kit pieces and a tile plan
 *  - paired load doors with teleport markers kept in sync
 *  - a navmesh freshness check
 *
 * Everything works on the cell's real geometry (the same triangles the navmesh
 * generator uses), so it runs without a 3D view and is unit-testable.
 */
import { RecordFlags, type FormKey } from '@tes5/esp';
import type { flattenMeshes } from '@tes5/assets';
import { appendTerrain, cellGeometry, existingNavmeshes, rotationMatrix } from './automations';
import { WorkspaceError, type Workspace } from './engine';
import { joinPath } from './fs';
import { WorldService, type PlacedRef, type Transform, type Vec3 } from './world';

// ------------------------------------------------------------------ helpers

/** Small seeded PRNG so a brush stroke can be repeated exactly. */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const norm = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};

/** Apply a reference rotation to a local vector (local → world). */
export function rotateVector(rot: Vec3, v: Vec3): Vec3 {
  const R = rotationMatrix(rot);
  return { x: R[0]! * v.x + R[1]! * v.y + R[2]! * v.z, y: R[3]! * v.x + R[4]! * v.y + R[5]! * v.z, z: R[6]! * v.x + R[7]! * v.y + R[8]! * v.z };
}

/**
 * Rotation that keeps heading `yaw` but tilts the object's up axis onto `n`
 * (inverse of the Z·Y·X reference rotation applied to (0,0,1)).
 */
export function rotationForNormal(n: Vec3, yaw: number): Vec3 {
  const u = norm(n);
  const cz = Math.cos(yaw);
  const sz = Math.sin(yaw);
  const ux = cz * u.x - sz * u.y;
  const uy = sz * u.x + cz * u.y;
  return { x: Math.asin(Math.max(-1, Math.min(1, uy))), y: Math.atan2(-ux, u.z), z: yaw };
}

/** Bethesda yaw (clockwise, radians) that points local +X along a direction in the XY plane. */
export const yawAlong = (dx: number, dy: number) => -Math.atan2(dy, dx);

const wrapAngle = (a: number) => {
  const t = Math.PI * 2;
  a %= t;
  return a < 0 ? a + t : a;
};

export interface Bounds3 {
  min: Vec3;
  max: Vec3;
}

// ------------------------------------------------------------------ surfaces

export interface SurfaceHit {
  point: Vec3;
  /** Unit normal facing the ray origin. */
  normal: Vec3;
  /** Reference the triangle belongs to (null for terrain). */
  owner: FormKey | null;
  distance: number;
}

/** Triangles of a cell with a coarse XY grid for fast ray casts. */
export class Surfaces {
  private readonly grid = new Map<number, number[]>();
  private stamp: Uint32Array;
  private pass = 0;

  constructor(
    readonly vertices: number[],
    readonly triangles: number[],
    readonly owners: (FormKey | null)[],
    private readonly cellSize = 128,
  ) {
    const n = triangles.length / 3;
    this.stamp = new Uint32Array(n);
    for (let t = 0; t < n; t++) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const i = triangles[t * 3 + k]! * 3;
        x0 = Math.min(x0, vertices[i]!);
        x1 = Math.max(x1, vertices[i]!);
        y0 = Math.min(y0, vertices[i + 1]!);
        y1 = Math.max(y1, vertices[i + 1]!);
      }
      for (let gx = Math.floor(x0 / cellSize); gx <= Math.floor(x1 / cellSize); gx++)
        for (let gy = Math.floor(y0 / cellSize); gy <= Math.floor(y1 / cellSize); gy++) {
          const k = this.key(gx, gy);
          let list = this.grid.get(k);
          if (!list) this.grid.set(k, (list = []));
          list.push(t);
        }
    }
  }

  private key(gx: number, gy: number) {
    return (((gx + 0x8000) & 0xffff) * 0x10000 + ((gy + 0x8000) & 0xffff)) >>> 0;
  }

  get count() {
    return this.triangles.length / 3;
  }

  vertex(t: number, k: number): Vec3 {
    const i = this.triangles[t * 3 + k]! * 3;
    return { x: this.vertices[i]!, y: this.vertices[i + 1]!, z: this.vertices[i + 2]! };
  }

  /** Nearest hit along a ray (both triangle sides count). */
  raycast(origin: Vec3, dir: Vec3, maxDist: number, ignore?: (owner: FormKey | null) => boolean): SurfaceHit | undefined {
    const d = norm(dir);
    const end = { x: origin.x + d.x * maxDist, y: origin.y + d.y * maxDist };
    const cs = this.cellSize;
    const gx0 = Math.floor(Math.min(origin.x, end.x) / cs);
    const gx1 = Math.floor(Math.max(origin.x, end.x) / cs);
    const gy0 = Math.floor(Math.min(origin.y, end.y) / cs);
    const gy1 = Math.floor(Math.max(origin.y, end.y) / cs);
    if ((gx1 - gx0 + 1) * (gy1 - gy0 + 1) > 4096) throw new WorkspaceError('Ray too long for the surface grid');
    this.pass = (this.pass + 1) >>> 0 || 1;
    let best: SurfaceHit | undefined;
    for (let gx = gx0; gx <= gx1; gx++)
      for (let gy = gy0; gy <= gy1; gy++) {
        for (const t of this.grid.get(this.key(gx, gy)) ?? []) {
          if (this.stamp[t] === this.pass) continue;
          this.stamp[t] = this.pass;
          if (ignore?.(this.owners[t] ?? null)) continue;
          const a = this.vertex(t, 0);
          const e1 = sub(this.vertex(t, 1), a);
          const e2 = sub(this.vertex(t, 2), a);
          const p = cross(d, e2);
          const det = dot(e1, p);
          if (Math.abs(det) < 1e-9) continue;
          const inv = 1 / det;
          const s = sub(origin, a);
          const u = dot(s, p) * inv;
          if (u < -1e-6 || u > 1 + 1e-6) continue;
          const q = cross(s, e1);
          const v = dot(d, q) * inv;
          if (v < -1e-6 || u + v > 1 + 1e-6) continue;
          const dist = dot(e2, q) * inv;
          if (dist < 0 || dist > maxDist || (best && dist >= best.distance)) continue;
          let n = norm(cross(e1, e2));
          if (dot(n, d) > 0) n = { x: -n.x, y: -n.y, z: -n.z };
          best = { point: { x: origin.x + d.x * dist, y: origin.y + d.y * dist, z: origin.z + d.z * dist }, normal: n, owner: this.owners[t] ?? null, distance: dist };
        }
      }
    return best;
  }

  /** First surface straight below (x, y) starting at height `fromZ`. */
  down(x: number, y: number, fromZ: number, maxDist = 100_000, ignore?: (owner: FormKey | null) => boolean): SurfaceHit | undefined {
    return this.raycast({ x, y, z: fromZ }, { x: 0, y: 0, z: -1 }, maxDist, ignore);
  }
}

// ------------------------------------------------------------------ options

export interface PaletteItem {
  base: FormKey;
  /** Relative chance of being picked (default 1). */
  weight?: number;
}

export interface ScatterOptions {
  items: PaletteItem[];
  center: Vec3;
  radius: number;
  /** Number of objects to try to place. Default: from `density`. */
  count?: number;
  /** Objects per 1000×1000 units (default 8). */
  density?: number;
  /** Minimum distance between scattered objects (default 0.8 × the item's footprint). */
  spacing?: number;
  scale?: [number, number];
  randomYaw?: boolean;
  /** 0 = stay upright, 1 = fully follow the slope. */
  alignToSlope?: number;
  /** Steepest slope (degrees) to place on (default 40). */
  maxSlope?: number;
  /** Push objects into the ground by this fraction of their height (rocks, roots). */
  sink?: number;
  /** Only place on terrain (exteriors), not on other objects. */
  terrainOnly?: boolean;
  seed?: number;
}

export interface PathOptions {
  points: Vec3[];
  base: FormKey;
  /** Distance between pieces (default: the piece's length along its X axis). */
  spacing?: number;
  /** Extra yaw for pieces whose long side isn't their X axis (radians). */
  rotationOffset?: number;
  /** Offset to the left (+) or right (-) of the path. */
  sideOffset?: number;
  /** Mirror the offset to both sides (fences along a road). */
  bothSides?: boolean;
  followSurface?: boolean;
  alignToSlope?: boolean;
}

export interface ArrayOptions {
  count: number;
  offset: Vec3;
  /** Extra yaw added per copy (radians). */
  rotateZ?: number;
  dropToSurface?: boolean;
}

export type ClutterTheme = keyof typeof CLUTTER_THEMES;
export interface ClutterOptions {
  theme: ClutterTheme;
  amount?: 'light' | 'medium' | 'heavy';
  /** Override the automatically chosen items. */
  tableItems?: FormKey[];
  floorItems?: FormKey[];
  seed?: number;
}

export interface RoomKit {
  floor: FormKey;
  wall: FormKey;
  corner?: FormKey;
  doorway?: FormKey;
  ceiling?: FormKey;
  /** Grid size of one floor tile (default: the floor piece's width). */
  tile?: number;
  /** Height of a wall piece, for the ceiling (default: from its bounds). */
  wallHeight?: number;
  /** Extra yaw if the wall's long side runs along its Y axis (radians). */
  wallRotationOffset?: number;
}

export interface RoomPlan {
  /** Occupied grid tiles. */
  tiles: { x: number; y: number }[];
  /** Tile edges that get a doorway instead of a wall. */
  doorways?: { x: number; y: number; side: 'n' | 's' | 'e' | 'w' }[];
}

export const CELL_MOODS = {
  tavern: { label: 'Warm tavern / inn', ambient: [72, 60, 50], directional: [160, 130, 100], fog: [24, 20, 16], fogFar: 6000 },
  home: { label: 'Lived-in home', ambient: [62, 56, 50], directional: [140, 125, 110], fog: [20, 18, 16], fogFar: 6000 },
  castle: { label: 'Castle / hall', ambient: [58, 58, 64], directional: [140, 140, 150], fog: [18, 18, 22], fogFar: 9000 },
  dungeon: { label: 'Nordic ruin / crypt', ambient: [30, 34, 42], directional: [70, 80, 100], fog: [8, 10, 14], fogFar: 4500 },
  cave: { label: 'Cave', ambient: [32, 32, 28], directional: [80, 78, 70], fog: [10, 10, 8], fogFar: 4000 },
  mine: { label: 'Mine', ambient: [40, 34, 28], directional: [110, 90, 70], fog: [14, 12, 10], fogFar: 4500 },
  dwemer: { label: 'Dwemer ruin', ambient: [44, 38, 30], directional: [130, 105, 70], fog: [16, 13, 9], fogFar: 6000 },
  icy: { label: 'Ice cave', ambient: [44, 54, 66], directional: [110, 135, 160], fog: [16, 22, 30], fogFar: 5000 },
} satisfies Record<string, { label: string; ambient: [number, number, number]; directional: [number, number, number]; fog: [number, number, number]; fogFar: number }>;
export type CellMood = keyof typeof CELL_MOODS;

/** Keywords used to pick items from the load order for each room theme. */
export const CLUTTER_THEMES = {
  tavern: { label: 'Tavern / inn', table: ['tankard', 'plate', 'bowl', 'bottle', 'mead', 'ale', 'wine', 'goblet', 'cup', 'bread', 'cheese', 'apple', 'food'], floor: ['barrel', 'sack', 'crate', 'bucket', 'basket'] },
  home: { label: 'Home', table: ['bowl', 'plate', 'cup', 'basket', 'candle', 'book', 'bread', 'apple'], floor: ['basket', 'sack', 'bucket', 'barrel'] },
  storeroom: { label: 'Storeroom', table: ['sack', 'basket', 'jar', 'bowl', 'bottle'], floor: ['barrel', 'crate', 'sack', 'basket', 'bucket'] },
  study: { label: 'Study / library', table: ['book', 'scroll', 'inkwell', 'quill', 'candle', 'paper'], floor: ['book', 'chest', 'basket'] },
  alchemy: { label: 'Alchemy lab', table: ['bottle', 'potion', 'jar', 'bowl', 'mortar', 'ingredient', 'flower', 'herb'], floor: ['barrel', 'sack', 'basket'] },
  smithy: { label: 'Smithy', table: ['ingot', 'ore', 'tongs', 'hammer', 'leather', 'strip'], floor: ['ore', 'barrel', 'crate', 'bucket'] },
} as const;

const LIGHT_SOURCES = /candle|torch|brazier|lantern|campfire|fire|sconce|chandelier|lamp|hearth|firepit|cookpot/i;

export interface LightingReport {
  sources: number;
  placed: FormKey[];
  alreadyLit: number;
  createdBases: FormKey[];
}

// ------------------------------------------------------------------ service

export class EnvironmentService {
  readonly world: WorldService;
  private meshCache = new Map<string, ReturnType<typeof flattenMeshes>>();
  private surfaceCache = new Map<FormKey, { revision: number; surfaces: Surfaces }>();
  private revision = 0;

  constructor(readonly ws: Workspace) {
    this.world = new WorldService(ws);
    ws.on((e) => {
      if (e.type === 'changed' || e.type === 'loaded' || e.type === 'activeChanged') this.revision++;
    });
  }

  /** Cell geometry (placed objects + terrain), cached until the next edit. */
  async surfaces(cell: FormKey): Promise<Surfaces> {
    const c = this.surfaceCache.get(cell);
    if (c && c.revision === this.revision) return c.surfaces;
    const owners: (FormKey | null)[] = [];
    const refs = this.world.references(cell);
    const geo = await cellGeometry(this.ws, refs, owners, this.meshCache);
    const info = this.cellInfo(cell);
    if (!info.interior) {
      appendTerrain(geo, this.world.terrain(cell));
      while (owners.length < geo.triangles.length / 3) owners.push(null);
    }
    const surfaces = new Surfaces(geo.vertices, geo.triangles, owners);
    this.surfaceCache.set(cell, { revision: this.revision, surfaces });
    return surfaces;
  }

  private cellInfo(cell: FormKey) {
    const info = this.world.cells().find((c) => c.formKey === cell);
    if (!info) throw new WorkspaceError(`Cell ${cell} not found`);
    return info;
  }

  /** Object bounds of a base form (OBND), if it has any. */
  boundsOf(base: FormKey): Bounds3 | undefined {
    const b = (this.ws.view(base)?.data as { bounds?: Record<string, number> } | undefined)?.bounds;
    if (!b) return undefined;
    const box = { min: { x: b.x1 ?? 0, y: b.y1 ?? 0, z: b.z1 ?? 0 }, max: { x: b.x2 ?? 0, y: b.y2 ?? 0, z: b.z2 ?? 0 } };
    return box.max.x - box.min.x || box.max.y - box.min.y || box.max.z - box.min.z ? box : undefined;
  }

  private footprint(base: FormKey): number {
    const b = this.boundsOf(base);
    return b ? Math.max(b.max.x - b.min.x, b.max.y - b.min.y) : 32;
  }

  private cellOfRef(ref: FormKey): FormKey {
    const cell = this.ws.view(ref)?.parent.cell;
    if (!cell) throw new WorkspaceError(`${ref} isn't placed in a cell`);
    return cell;
  }

  private refInfo(ref: FormKey): PlacedRef {
    const cell = this.cellOfRef(ref);
    const r = this.world.references(cell).find((x) => x.formKey === ref);
    if (!r) throw new WorkspaceError(`${ref} not found`);
    return r;
  }

  /**
   * Where an object should sit on the surface below `pos`: returns the new
   * transform, or undefined if there is nothing below.
   */
  private rest(surfaces: Surfaces, base: FormKey | null, pos: Vec3, rot: Vec3, scale: number, opts: { align?: number; ignore?: (o: FormKey | null) => boolean; sink?: number; reach?: number }): { transform: Transform; hit: SurfaceHit } | undefined {
    const b = base ? this.boundsOf(base) : undefined;
    const height = b ? (b.max.z - b.min.z) * scale : 0;
    const startZ = pos.z + (opts.reach ?? Math.max(32, height * 0.6 + 16));
    const hit = surfaces.down(pos.x, pos.y, startZ, 100_000, opts.ignore);
    if (!hit) return undefined;
    let z = hit.point.z;
    // Without tilting, rest on the highest point under the footprint so nothing sinks in.
    if (b && !opts.align) {
      const R = rotationMatrix({ x: 0, y: 0, z: rot.z });
      for (const [lx, ly] of [
        [b.min.x * 0.7, b.min.y * 0.7],
        [b.max.x * 0.7, b.min.y * 0.7],
        [b.min.x * 0.7, b.max.y * 0.7],
        [b.max.x * 0.7, b.max.y * 0.7],
      ] as const) {
        const wx = pos.x + scale * (R[0]! * lx + R[1]! * ly);
        const wy = pos.y + scale * (R[3]! * lx + R[4]! * ly);
        const h = surfaces.down(wx, wy, startZ, startZ - z + 64, opts.ignore);
        if (h && h.point.z > z && h.point.z - z < Math.max(24, height)) z = h.point.z;
      }
    }
    const up = hit.normal.z < 0 ? { x: -hit.normal.x, y: -hit.normal.y, z: -hit.normal.z } : hit.normal;
    const tilt = opts.align ? norm({ x: up.x * opts.align, y: up.y * opts.align, z: 1 - opts.align + up.z * opts.align }) : { x: 0, y: 0, z: 1 };
    const rotation = opts.align ? rotationForNormal(tilt, rot.z) : { x: 0, y: 0, z: rot.z };
    const bottom = b ? b.min.z * scale : 0;
    const sink = (opts.sink ?? 0) * height;
    return { transform: { position: { x: pos.x, y: pos.y, z: z - bottom - sink }, rotation, scale }, hit };
  }

  /**
   * How far each reference sits above (+) or below (−) where it would rest on
   * the surface under it; skips references with nothing below.
   */
  async restingOffsets(cell: FormKey, refs: FormKey[]): Promise<{ ref: FormKey; offset: number; height: number }[]> {
    const surfaces = await this.surfaces(cell);
    const all = new Map(this.world.references(cell).map((r) => [r.formKey, r]));
    const ignore = new Set(refs);
    const out: { ref: FormKey; offset: number; height: number }[] = [];
    for (const key of refs) {
      const r = all.get(key);
      if (!r) continue;
      const b = r.base ? this.boundsOf(r.base) : undefined;
      const res = this.rest(surfaces, r.base, r.transform.position, r.transform.rotation, r.transform.scale, { ignore: (o) => o !== null && ignore.has(o) });
      if (!res) continue;
      out.push({ ref: key, offset: r.transform.position.z - res.transform.position.z, height: b ? (b.max.z - b.min.z) * r.transform.scale : 0 });
    }
    return out;
  }

  // ---------------------------------------------------------------- drop

  /** Drop references onto whatever is below them (one undo step). */
  async dropToSurface(refs: FormKey[], opts: { align?: boolean } = {}): Promise<{ moved: FormKey[]; missed: FormKey[] }> {
    const moved: { ref: FormKey; transform: Partial<Transform> }[] = [];
    const missed: FormKey[] = [];
    const ignoreSet = new Set(refs);
    for (const key of refs) {
      const r = this.refInfo(key);
      const surfaces = await this.surfaces(this.cellOfRef(key));
      const res = this.rest(surfaces, r.base, r.transform.position, r.transform.rotation, r.transform.scale, { align: opts.align ? 1 : 0, ignore: (o) => o !== null && ignoreSet.has(o) });
      if (!res) {
        missed.push(key);
        continue;
      }
      moved.push({ ref: key, transform: { position: res.transform.position, rotation: opts.align ? res.transform.rotation : r.transform.rotation } });
    }
    if (moved.length) this.world.transformReferences(moved, moved.length > 1 ? `Drop ${moved.length} objects to surface` : 'Drop to surface');
    return { moved: moved.map((m) => m.ref), missed };
  }

  // ---------------------------------------------------------------- array

  /** Copy references `count` times, each step offset (and optionally turned) further. */
  async array(refs: FormKey[], opts: ArrayOptions): Promise<FormKey[]> {
    if (opts.count < 1 || opts.count > 500) throw new WorkspaceError('Choose between 1 and 500 copies');
    const sources = refs.map((k) => ({ key: k, info: this.refInfo(k), cell: this.cellOfRef(k), view: this.ws.view(k)! }));
    const pivot = sources[0]!.info.transform.position;
    const out: FormKey[] = [];
    const surfaceFor = new Map<FormKey, Surfaces>();
    if (opts.dropToSurface) for (const s of sources) if (!surfaceFor.has(s.cell)) surfaceFor.set(s.cell, await this.surfaces(s.cell));
    this.ws.transaction(`Array ×${opts.count}`, () => {
      for (let i = 1; i <= opts.count; i++) {
        const turn = (opts.rotateZ ?? 0) * i;
        for (const s of sources) {
          const p = s.info.transform.position;
          // Turn around the first object, then offset.
          const dx = p.x - pivot.x;
          const dy = p.y - pivot.y;
          const c = Math.cos(-turn);
          const sn = Math.sin(-turn);
          let pos = { x: pivot.x + dx * c - dy * sn + opts.offset.x * i, y: pivot.y + dx * sn + dy * c + opts.offset.y * i, z: p.z + opts.offset.z * i };
          let rot = { ...s.info.transform.rotation, z: wrapAngle(s.info.transform.rotation.z + turn) };
          if (opts.dropToSurface) {
            const res = this.rest(surfaceFor.get(s.cell)!, s.info.base, pos, rot, s.info.transform.scale, {});
            if (res) ((pos = res.transform.position), (rot = { ...rot }));
          }
          const data = structuredClone(s.view.data) as Record<string, unknown>;
          delete data.editorId;
          data.placement = { position: pos, rotation: rot };
          out.push(this.ws.createRecord(s.view.sig, data, { cell: s.cell, persistent: s.view.parent.persistent }, s.view.flags & ~RecordFlags.Compressed));
        }
      }
    });
    return out;
  }

  // ---------------------------------------------------------------- scatter / erase

  /**
   * Brush-style scatter of a palette around a point, or around every point of
   * a brush stroke (`centers`); one undo step either way.
   */
  async scatter(cell: FormKey, opts: ScatterOptions & { centers?: Vec3[] }): Promise<FormKey[]> {
    const items = opts.items.filter((i) => (i.weight ?? 1) > 0);
    if (!items.length) throw new WorkspaceError('Pick at least one object to scatter');
    for (const i of items) if (!this.ws.exists(i.base)) throw new WorkspaceError(`${i.base} not found`);
    const random = rng(opts.seed ?? Date.now());
    const surfaces = await this.surfaces(cell);
    const area = Math.PI * opts.radius * opts.radius;
    const target = Math.max(1, Math.min(500, Math.round(opts.count ?? (area / 1_000_000) * (opts.density ?? 8))));
    const totalWeight = items.reduce((s, i) => s + (i.weight ?? 1), 0);
    const pick = () => {
      let r = random() * totalWeight;
      for (const i of items) if ((r -= i.weight ?? 1) <= 0) return i.base;
      return items[items.length - 1]!.base;
    };
    const minNz = Math.cos(((opts.maxSlope ?? 40) * Math.PI) / 180);
    const [s0, s1] = opts.scale ?? [0.8, 1.2];
    // Existing objects from the palette count towards spacing.
    const paletteBases = new Set(items.map((i) => i.base));
    const centers = opts.centers?.length ? opts.centers : [opts.center];
    const near = (p: Vec3) => centers.some((c) => Math.hypot(p.x - c.x, p.y - c.y) < opts.radius + 512);
    const taken: { x: number; y: number; r: number }[] = this.world
      .references(cell)
      .filter((r) => r.base && paletteBases.has(r.base) && !r.disabled && near(r.transform.position))
      .map((r) => ({ x: r.transform.position.x, y: r.transform.position.y, r: (this.footprint(r.base!) * r.transform.scale) / 2 }));
    const placements: { base: FormKey; t: Transform }[] = [];
    // Interiors have ceilings: only look a little above the brush; exteriors follow hills.
    const reach = this.cellInfo(cell).interior ? 96 : Math.max(128, opts.radius);
    for (const center of centers) {
      const goal = placements.length + target;
      for (let attempt = 0; attempt < target * 12 && placements.length < goal; attempt++) {
        const a = random() * Math.PI * 2;
        const d = Math.sqrt(random()) * opts.radius;
        const x = center.x + Math.cos(a) * d;
        const y = center.y + Math.sin(a) * d;
        const base = pick();
        const scale = s0 + (s1 - s0) * random();
        const radius = (opts.spacing ?? this.footprint(base) * 0.8) * scale * 0.5;
        if (taken.some((t) => Math.hypot(t.x - x, t.y - y) < t.r + radius)) continue;
        const yaw = opts.randomYaw === false ? 0 : random() * Math.PI * 2;
        const res = this.rest(surfaces, base, { x, y, z: center.z }, { x: 0, y: 0, z: yaw }, scale, {
          align: opts.alignToSlope ?? 0,
          sink: opts.sink,
          reach,
          ignore: opts.terrainOnly ? (o) => o !== null : undefined,
        });
        if (!res) continue;
        const up = Math.abs(res.hit.normal.z);
        if (up < minNz) continue;
        taken.push({ x, y, r: radius });
        placements.push({ base, t: res.transform });
      }
    }
    if (!placements.length) return [];
    return this.ws.transaction(`Scatter ${placements.length} object(s)`, () => placements.map((p) => this.world.placeReference(cell, p.base, p.t)));
  }

  /** Remove (or disable, for master references) palette objects inside a radius of any of the points. */
  erase(cell: FormKey, center: Vec3 | Vec3[], radius: number, bases: FormKey[]): number {
    const set = new Set(bases);
    const centers = Array.isArray(center) ? center : [center];
    const inside = (p: Vec3) => centers.some((c) => Math.hypot(p.x - c.x, p.y - c.y) <= radius && Math.abs(p.z - c.z) <= Math.max(radius, 256));
    const hits = this.world.references(cell).filter((r) => r.base && set.has(r.base) && !r.disabled && !r.deleted && inside(r.transform.position));
    if (!hits.length) return 0;
    this.ws.transaction(`Erase ${hits.length} object(s)`, () => {
      for (const h of hits) this.ws.deleteRecord(h.formKey);
    });
    return hits.length;
  }

  // ---------------------------------------------------------------- path

  /** Lay pieces along a polyline: roads, fences, walls, rows of lamp posts. */
  async alongPath(cell: FormKey, opts: PathOptions): Promise<FormKey[]> {
    const pts = opts.points;
    if (pts.length < 2) throw new WorkspaceError('Draw at least two points');
    const b = this.boundsOf(opts.base);
    const pieceLength = b ? b.max.x - b.min.x : 128;
    const spacing = Math.max(1, opts.spacing ?? pieceLength);
    const segs = pts.slice(1).map((p, i) => ({ a: pts[i]!, b: p, len: Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y) }));
    const total = segs.reduce((s, x) => s + x.len, 0);
    if (total < 1) throw new WorkspaceError('The path is too short');
    const n = Math.min(1000, Math.max(1, Math.ceil(total / spacing - 0.01)));
    const step = total / n;
    const surfaces = opts.followSurface ? await this.surfaces(cell) : undefined;
    const sides = opts.bothSides ? [1, -1] : [1];
    const out: { t: Transform }[] = [];
    for (let i = 0; i < n; i++) {
      let at = (i + 0.5) * step;
      let seg = segs[0]!;
      for (const s of segs) {
        seg = s;
        if (at <= s.len) break;
        at -= s.len;
      }
      const f = seg.len ? Math.min(1, at / seg.len) : 0;
      const dx = seg.b.x - seg.a.x;
      const dy = seg.b.y - seg.a.y;
      const l = Math.hypot(dx, dy) || 1;
      const yaw = wrapAngle(yawAlong(dx, dy) + (opts.rotationOffset ?? 0));
      for (const side of sides) {
        const off = (opts.sideOffset ?? 0) * side;
        const pos = { x: seg.a.x + dx * f + (-dy / l) * off, y: seg.a.y + dy * f + (dx / l) * off, z: seg.a.z + (seg.b.z - seg.a.z) * f };
        let t: Transform = { position: pos, rotation: { x: 0, y: 0, z: yaw }, scale: 1 };
        if (surfaces) {
          const res = this.rest(surfaces, opts.base, pos, t.rotation, 1, { align: opts.alignToSlope ? 1 : 0, reach: 256 });
          if (res) t = res.transform;
        }
        out.push({ t });
      }
    }
    return this.ws.transaction(`Place ${out.length} piece(s) along a path`, () => out.map((o) => this.world.placeReference(cell, opts.base, o.t)));
  }

  // ---------------------------------------------------------------- lighting

  /** Objects that look like they should give off light (candles, torches, braziers…). */
  lightSources(cell: FormKey): PlacedRef[] {
    return this.world.references(cell).filter((r) => r.baseSig !== 'LIGH' && !r.disabled && !r.deleted && LIGHT_SOURCES.test(`${r.baseEditorId ?? ''} ${r.model ?? ''}`));
  }

  /**
   * Put a light on every light-source object that has none nearby. Light bases
   * are picked from the load order by name (candle vs fire), or created.
   */
  lightingPass(cell: FormKey, opts: { candleLight?: FormKey; fireLight?: FormKey; radius?: number } = {}): LightingReport {
    const refs = this.world.references(cell);
    const lights = refs.filter((r) => r.baseSig === 'LIGH' && !r.disabled && !r.deleted);
    const sources = this.lightSources(cell);
    const near = opts.radius ?? 96;
    const createdBases: FormKey[] = [];
    const findLight = (kind: 'candle' | 'fire'): FormKey | undefined => {
      const words = kind === 'candle' ? /candle/i : /fire|torch|brazier|hearth/i;
      const all = this.ws.search({ sigs: ['LIGH'], limit: 5000 }).items.filter((i) => i.editorId && words.test(i.editorId));
      // Prefer a plain light (no model of its own), like the CK's light-only forms.
      return (all.find((i) => !(this.ws.view(i.formKey)?.data as { model?: unknown })?.model) ?? all[0])?.formKey;
    };
    const placed: FormKey[] = [];
    let alreadyLit = 0;
    this.ws.transaction('Lighting pass', () => {
      const bases: Record<'candle' | 'fire', FormKey | undefined> = { candle: opts.candleLight ?? findLight('candle'), fire: opts.fireLight ?? findLight('fire') };
      const ensure = (kind: 'candle' | 'fire') => {
        if (bases[kind]) return bases[kind]!;
        const warm = kind === 'candle' ? { r: 255, g: 200, b: 140 } : { r: 255, g: 160, b: 90 };
        const key = this.ws.createRecord('LIGH', {
          editorId: this.ws.uniqueEditorId(kind === 'candle' ? 'EnvCandleLight' : 'EnvFireLight'),
          bounds: { x1: 0, y1: 0, z1: 0, x2: 0, y2: 0, z2: 0 },
          data: { time: -1, radius: kind === 'candle' ? 256 : 512, color: { ...warm, unused: new Uint8Array(1) }, flags: kind === 'fire' ? 0x8 : 0, falloffExponent: 1, fov: 90, nearClip: 0, flickerPeriod: 0.4, flickerIntensityAmplitude: 0.2, flickerMovementAmplitude: 5, value: 0, weight: 0 },
          fadeValue: 1,
        });
        createdBases.push(key);
        return (bases[kind] = key);
      };
      for (const s of sources) {
        const p = s.transform.position;
        const b = s.base ? this.boundsOf(s.base) : undefined;
        const top = p.z + (b ? b.max.z * s.transform.scale : 32);
        if (lights.some((l) => Math.hypot(l.transform.position.x - p.x, l.transform.position.y - p.y) < near && Math.abs(l.transform.position.z - top) < near * 2)) {
          alreadyLit++;
          continue;
        }
        const kind = /candle|lantern|lamp|sconce|chandelier/i.test(`${s.baseEditorId ?? ''} ${s.model ?? ''}`) ? 'candle' : 'fire';
        const key = this.world.placeReference(cell, ensure(kind), { position: { x: p.x, y: p.y, z: top + 8 } });
        placed.push(key);
        lights.push({ ...s, formKey: key, baseSig: 'LIGH', transform: { position: { x: p.x, y: p.y, z: top + 8 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1 } });
      }
    });
    return { sources: sources.length, placed, alreadyLit, createdBases };
  }

  /** Guess a mood from the cell's name (inn → tavern, barrow → dungeon, …). */
  suggestMood(cell: FormKey): CellMood {
    const v = this.ws.view(cell);
    const text = `${v?.editorId ?? ''} ${v?.name ?? ''}`.toLowerCase();
    const rules: [RegExp, CellMood][] = [
      [/inn|tavern|mead|alehouse/, 'tavern'],
      [/ice|frost|glacier|frozen/, 'icy'],
      [/dwem|dwarven|nchu|mzinch|ark(ng|ngthamz)|raldbthar/, 'dwemer'],
      [/mine/, 'mine'],
      [/cave|grotto|den|lair|hollow/, 'cave'],
      [/barrow|crypt|tomb|ruin|dungeon|sanctum|catacomb/, 'dungeon'],
      [/castle|keep|palace|hall|fort|longhouse|jarl/, 'castle'],
      [/house|home|hut|cabin|shack|farm|lodge/, 'home'],
    ];
    return rules.find(([re]) => re.test(text))?.[1] ?? 'home';
  }

  /** Apply a mood's ambient, directional and fog colours to an interior cell. */
  setCellMood(cell: FormKey, mood: CellMood): void {
    const m = CELL_MOODS[mood];
    if (!m) throw new WorkspaceError(`Unknown mood ${mood}`);
    if (!this.cellInfo(cell).interior) throw new WorkspaceError('Lighting moods apply to interior cells (exteriors use weather)');
    const c = (rgb: readonly number[]) => ({ r: rgb[0]!, g: rgb[1]!, b: rgb[2]! });
    this.ws.editRecord(
      cell,
      (d) => {
        const cur = (d.lighting as Record<string, unknown> | undefined) ?? {};
        d.lighting = {
          fogNear: 0,
          directionalRotationXY: 45,
          directionalRotationZ: 45,
          directionalFade: 1,
          fogClipDistance: 0,
          fogPower: 1,
          ambientColors: new Uint8Array(32),
          fogMax: 1,
          lightFadeBegin: 0,
          lightFadeEnd: 0,
          ...cur,
          ambient: c(m.ambient),
          directional: c(m.directional),
          fogNearColor: c(m.fog),
          fogFarColor: c(m.fog),
          fogFar: m.fogFar,
          // Stop inheriting the colours we just set from a lighting template.
          inherits: ((cur.inherits as number | undefined) ?? 0) & ~(0x1 | 0x2 | 0x4 | 0x10),
        };
        return d;
      },
      `Lighting mood: ${m.label}`,
    );
  }

  // ---------------------------------------------------------------- clutter

  /** Items in the load order matching a theme's keywords. */
  themeItems(theme: ClutterTheme): { table: FormKey[]; floor: FormKey[] } {
    const t = CLUTTER_THEMES[theme];
    if (!t) throw new WorkspaceError(`Unknown theme ${theme}`);
    const find = (words: readonly string[], sigs: string[]) => {
      const re = new RegExp(words.join('|'), 'i');
      return this.ws
        .search({ sigs, limit: 20_000 })
        .items.filter((i) => !i.deleted && re.test(`${i.editorId ?? ''} ${i.name ?? ''}`) && !/^(dummy|test|xx|ck)/i.test(i.editorId ?? '') && this.boundsOf(i.formKey) && (this.ws.view(i.formKey)?.data as { model?: unknown })?.model)
        .map((i) => i.formKey)
        .slice(0, 60);
    };
    return { table: find(t.table, ['MISC', 'ALCH', 'INGR', 'BOOK', 'SCRL']), floor: find(t.floor, ['STAT', 'MISC', 'MSTT']) };
  }

  /** Dress a room: small items on tables and shelves, bigger ones along the walls. */
  async clutterRoom(cell: FormKey, opts: ClutterOptions): Promise<{ table: FormKey[]; floor: FormKey[] }> {
    const random = rng(opts.seed ?? Date.now());
    const auto = !opts.tableItems || !opts.floorItems ? this.themeItems(opts.theme) : undefined;
    const tableItems = opts.tableItems ?? auto!.table;
    const floorItems = opts.floorItems ?? auto!.floor;
    if (!tableItems.length && !floorItems.length) throw new WorkspaceError(`No items found for "${CLUTTER_THEMES[opts.theme].label}" in your load order; pick some by hand`);
    const amount = { light: 0.5, medium: 1, heavy: 1.8 }[opts.amount ?? 'medium'];
    const surfaces = await this.surfaces(cell);
    const refs = this.world.references(cell);
    const byKey = new Map(refs.map((r) => [r.formKey, r]));
    const doors = refs.filter((r) => r.baseSig === 'DOOR');
    const occupied: { x: number; y: number; z: number; r: number }[] = refs
      .filter((r) => r.baseSig && !['STAT', 'LIGH'].includes(r.baseSig))
      .map((r) => ({ ...r.transform.position, r: r.base ? (this.footprint(r.base) * r.transform.scale) / 2 : 16 }));
    const free = (x: number, y: number, z: number, r: number) => !occupied.some((o) => Math.abs(o.z - z) < 48 && Math.hypot(o.x - x, o.y - y) < o.r + r);

    // Group up-facing triangles by owner and height: tables/shelves are surfaces raised above the object's origin.
    type Patch = { owner: FormKey; z: number; tris: number[]; area: number; floor: boolean };
    const patches = new Map<string, Patch>();
    for (let t = 0; t < surfaces.count; t++) {
      const owner = surfaces.owners[t];
      if (!owner) continue;
      const a = surfaces.vertex(t, 0);
      const e1 = sub(surfaces.vertex(t, 1), a);
      const e2 = sub(surfaces.vertex(t, 2), a);
      const c = cross(e1, e2);
      const area = len(c) / 2;
      if (area < 1 || Math.abs(c.z) / (2 * area) < 0.97) continue;
      const z = (a.z + surfaces.vertex(t, 1).z + surfaces.vertex(t, 2).z) / 3;
      const ref = byKey.get(owner);
      // Only static furniture: chests, doors and activators animate, chairs and beds get used.
      if (!ref || !['STAT', 'SCOL', 'MSTT'].includes(ref.baseSig ?? '')) continue;
      const rise = z - ref.transform.position.z;
      const key = `${owner}|${Math.round(z)}`;
      let p = patches.get(key);
      if (!p) patches.set(key, (p = { owner, z, tris: [], area: 0, floor: rise < 20 }));
      p.tris.push(t);
      p.area += area;
    }
    const all = [...patches.values()];
    const floorZ = all.filter((p) => p.floor).reduce((m, p) => (p.area > m.area ? p : m), { z: 0, area: 0 } as { z: number; area: number }).z;
    const tops = all.filter((p) => !p.floor && p.z - floorZ > 20 && p.z - floorZ < 220 && p.area > 400);
    const floors = all.filter((p) => p.floor && Math.abs(p.z - floorZ) < 8);

    const samplePoint = (p: Patch): Vec3 => {
      let r = random() * p.area;
      let t = p.tris[0]!;
      for (const tt of p.tris) {
        const a = surfaces.vertex(tt, 0);
        const ar = len(cross(sub(surfaces.vertex(tt, 1), a), sub(surfaces.vertex(tt, 2), a))) / 2;
        t = tt;
        if ((r -= ar) <= 0) break;
      }
      let u = random();
      let v = random();
      if (u + v > 1) ((u = 1 - u), (v = 1 - v));
      const a = surfaces.vertex(t, 0);
      const b = surfaces.vertex(t, 1);
      const c = surfaces.vertex(t, 2);
      return { x: a.x + (b.x - a.x) * u + (c.x - a.x) * v, y: a.y + (b.y - a.y) * u + (c.y - a.y) * v, z: a.z + (b.z - a.z) * u + (c.z - a.z) * v };
    };
    // The same surface must continue `margin` units in every direction (not at an edge) with nothing on top.
    const solidAround = (pt: Vec3, margin: number, height: number) =>
      [
        [0, 0],
        [margin, 0],
        [-margin, 0],
        [0, margin],
        [0, -margin],
      ].every(([dx, dy]) => {
        // Look from at least 30 units up so the underside of a table top doesn't count as a surface.
        const clearance = Math.max(30, height * 1.5);
        const h = surfaces.down(pt.x + dx!, pt.y + dy!, pt.z + clearance, clearance + 8);
        return h && Math.abs(h.point.z - pt.z) < 1.5;
      });
    const nearWall = (pt: Vec3) =>
      [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].some(([dx, dy]) => surfaces.raycast({ x: pt.x, y: pt.y, z: pt.z + 120 }, { x: dx!, y: dy!, z: 0 }, 72)); // at 120 units only walls and tall furniture count

    const place: { base: FormKey; t: Transform; kind: 'table' | 'floor' }[] = [];
    const tryPlace = (patch: Patch, items: FormKey[], kind: 'table' | 'floor', attempts: number, want: number) => {
      let got = 0;
      for (let i = 0; i < attempts && got < want; i++) {
        const base = items[Math.floor(random() * items.length)]!;
        const b = this.boundsOf(base);
        if (!b) continue;
        const r = Math.max(b.max.x - b.min.x, b.max.y - b.min.y) / 2;
        const pt = samplePoint(patch);
        if (!free(pt.x, pt.y, pt.z, r)) continue;
        if (!solidAround(pt, r + (kind === 'table' ? 3 : 8), b.max.z - b.min.z)) continue;
        if (kind === 'floor' && (!nearWall(pt) || doors.some((d) => Math.hypot(d.transform.position.x - pt.x, d.transform.position.y - pt.y) < 160))) continue;
        occupied.push({ ...pt, r });
        place.push({ base, kind, t: { position: { x: pt.x, y: pt.y, z: pt.z - b.min.z }, rotation: { x: 0, y: 0, z: random() * Math.PI * 2 }, scale: 1 } });
        got++;
      }
    };
    if (tableItems.length) for (const p of tops) tryPlace(p, tableItems, 'table', 80, Math.max(1, Math.round((p.area / 1800) * amount)));
    if (floorItems.length) {
      const floorArea = floors.reduce((s, p) => s + p.area, 0);
      const want = Math.max(1, Math.round((floorArea / 120_000) * amount));
      const perPatch = floors.length ? Math.max(1, Math.ceil(want / floors.length)) : 0;
      let left = want;
      for (const p of floors.sort(() => random() - 0.5)) {
        if (left <= 0) break;
        const before = place.length;
        tryPlace(p, floorItems, 'floor', 60, Math.min(perPatch, left));
        left -= place.length - before;
      }
    }
    if (!place.length) return { table: [], floor: [] };
    const keys = this.ws.transaction(`Clutter: ${CLUTTER_THEMES[opts.theme].label}`, () => place.map((p) => this.world.placeReference(cell, p.base, p.t)));
    return { table: keys.filter((_, i) => place[i]!.kind === 'table'), floor: keys.filter((_, i) => place[i]!.kind === 'floor') };
  }

  // ---------------------------------------------------------------- room builder

  /** Build a room from kit pieces on a tile plan; the plan's (0,0) tile is centred on `origin`. */
  buildRoom(cell: FormKey, origin: Vec3, plan: RoomPlan, kit: RoomKit): FormKey[] {
    if (!plan.tiles.length) throw new WorkspaceError('Paint at least one floor tile');
    const fb = this.boundsOf(kit.floor);
    const tile = kit.tile ?? (fb ? Math.round(fb.max.x - fb.min.x) : 256);
    const wb = this.boundsOf(kit.wall);
    const wallHeight = kit.wallHeight ?? (wb ? wb.max.z - wb.min.z : 256);
    const has = new Set(plan.tiles.map((t) => `${t.x},${t.y}`));
    const doorway = new Set((plan.doorways ?? []).map((d) => `${d.x},${d.y},${d.side}`));
    const off = kit.wallRotationOffset ?? 0;
    const pieces: { base: FormKey; t: Transform }[] = [];
    const put = (base: FormKey, x: number, y: number, z: number, rz: number, rx = 0) => pieces.push({ base, t: { position: { x: origin.x + x, y: origin.y + y, z: origin.z + z }, rotation: { x: rx, y: 0, z: wrapAngle(rz) }, scale: 1 } });
    const sides = [
      { side: 's', dx: 0, dy: -1, yaw: 0 },
      { side: 'n', dx: 0, dy: 1, yaw: Math.PI },
      { side: 'w', dx: -1, dy: 0, yaw: Math.PI / 2 },
      { side: 'e', dx: 1, dy: 0, yaw: -Math.PI / 2 },
    ] as const;
    for (const t of plan.tiles) {
      const cx = t.x * tile;
      const cy = t.y * tile;
      put(kit.floor, cx, cy, 0, 0);
      if (kit.ceiling) put(kit.ceiling, cx, cy, wallHeight, 0, Math.PI);
      for (const s of sides) {
        if (has.has(`${t.x + s.dx},${t.y + s.dy}`)) continue;
        const isDoor = doorway.has(`${t.x},${t.y},${s.side}`);
        put(isDoor && kit.doorway ? kit.doorway : kit.wall, cx + (s.dx * tile) / 2, cy + (s.dy * tile) / 2, 0, s.yaw + off);
      }
    }
    if (kit.corner) {
      // A corner goes on every grid vertex where the wall line turns (outer and inner corners).
      const seen = new Set<string>();
      for (const t of plan.tiles)
        for (const [vx, vy] of [
          [t.x, t.y],
          [t.x + 1, t.y],
          [t.x, t.y + 1],
          [t.x + 1, t.y + 1],
        ] as const) {
          const k = `${vx},${vy}`;
          if (seen.has(k)) continue;
          seen.add(k);
          // Tiles around vertex (vx-0.5, vy-0.5) in tile-centre coordinates.
          const q = [has.has(`${vx - 1},${vy - 1}`), has.has(`${vx},${vy - 1}`), has.has(`${vx - 1},${vy}`), has.has(`${vx},${vy}`)];
          const n = q.filter(Boolean).length;
          const diagonal = n === 2 && q[0] === q[3];
          if (n === 1 || n === 3 || diagonal) put(kit.corner, (vx - 0.5) * tile, (vy - 0.5) * tile, 0, 0);
        }
    }
    return this.ws.transaction(`Build room (${plan.tiles.length} tiles)`, () => pieces.map((p) => this.world.placeReference(cell, p.base, p.t)));
  }

  // ---------------------------------------------------------------- doors

  /**
   * Where the player appears when arriving through `door`: in front of it,
   * facing away. "In front" is the side with floor and open space.
   */
  async teleportMarker(door: FormKey): Promise<{ position: Vec3; rotation: Vec3 }> {
    const r = this.refInfo(door);
    const p = r.transform.position;
    const yaw = r.transform.rotation.z;
    const surfaces = await this.surfaces(this.cellOfRef(door));
    const own = (o: FormKey | null) => o === door;
    const score = (dir: 1 | -1) => {
      const f = rotateVector({ x: 0, y: 0, z: yaw }, { x: 0, y: dir, z: 0 });
      const at = { x: p.x + f.x * 96, y: p.y + f.y * 96 };
      const floor = surfaces.down(at.x, at.y, p.z + 64, 192, own);
      const blocked = surfaces.raycast({ x: p.x, y: p.y, z: p.z + 100 }, f, 112, own);
      return (floor && Math.abs(floor.point.z - p.z) < 64 ? 2 : 0) + (blocked ? 0 : 1);
    };
    const dir = score(-1) > score(1) ? -1 : 1;
    const f = rotateVector({ x: 0, y: 0, z: yaw }, { x: 0, y: dir, z: 0 });
    const floor = surfaces.down(p.x + f.x * 96, p.y + f.y * 96, p.z + 64, 192, own);
    return { position: { x: p.x + f.x * 96, y: p.y + f.y * 96, z: floor ? floor.point.z : p.z }, rotation: { x: 0, y: 0, z: wrapAngle(yaw + (dir === 1 ? 0 : Math.PI)) } };
  }

  /**
   * A place for a new door in a cell: against a wall, facing into open floor,
   * away from other doors. Outdoors (or with no walls) it's on the ground near
   * the middle of what's there. Yaw turns the door's front (+Y) into the room.
   */
  async doorSpot(cell: FormKey, seed = 1): Promise<{ position: Vec3; yaw: number; onWall: boolean }> {
    const random = rng(seed);
    const surfaces = await this.surfaces(cell);
    const refs = this.world.references(cell).filter((r) => !r.deleted);
    const doors = refs.filter((r) => r.baseSig === 'DOOR').map((r) => r.transform.position);
    // Floor: the most common up-facing height.
    const floorPts: Vec3[] = [];
    for (let t = 0; t < surfaces.count; t++) {
      const a = surfaces.vertex(t, 0);
      const c = cross(sub(surfaces.vertex(t, 1), a), sub(surfaces.vertex(t, 2), a));
      const area = len(c) / 2;
      if (area < 200 || Math.abs(c.z) / (2 * area) < 0.97) continue;
      floorPts.push({ x: (a.x + surfaces.vertex(t, 1).x + surfaces.vertex(t, 2).x) / 3, y: (a.y + surfaces.vertex(t, 1).y + surfaces.vertex(t, 2).y) / 3, z: (a.z + surfaces.vertex(t, 1).z + surfaces.vertex(t, 2).z) / 3 });
    }
    const counts = new Map<number, number>();
    for (const p of floorPts) counts.set(Math.round(p.z / 8), (counts.get(Math.round(p.z / 8)) ?? 0) + 1);
    const floorZ = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const floor = floorZ === undefined ? [] : floorPts.filter((p) => Math.abs(Math.round(p.z / 8) - floorZ) <= 1);
    let best: { position: Vec3; yaw: number; score: number } | undefined;
    for (let i = 0; i < Math.min(200, floor.length * 4); i++) {
      const p = floor[Math.floor(random() * floor.length)]!;
      const free = surfaces.down(p.x, p.y, p.z + 200, 220);
      if (!free || Math.abs(free.point.z - p.z) > 4) continue; // something stands here
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const hit = surfaces.raycast({ x: p.x, y: p.y, z: p.z + 100 }, { x: dx, y: dy, z: 0 }, 400);
        if (!hit || hit.distance < 60) continue;
        const at = { x: p.x + dx * (hit.distance - 4), y: p.y + dy * (hit.distance - 4), z: p.z };
        // The wall must be tall and clear at head height and near the floor, and the floor must continue in front.
        const low = surfaces.raycast({ x: p.x, y: p.y, z: p.z + 30 }, { x: dx, y: dy, z: 0 }, hit.distance + 16);
        const high = surfaces.raycast({ x: p.x, y: p.y, z: p.z + 180 }, { x: dx, y: dy, z: 0 }, hit.distance + 16);
        if (!low || !high || Math.abs(low.distance - hit.distance) > 8 || Math.abs(high.distance - hit.distance) > 8) continue;
        const nearDoor = Math.min(Infinity, ...doors.map((d) => Math.hypot(d.x - at.x, d.y - at.y)));
        if (nearDoor < 200) continue;
        const score = Math.min(nearDoor, 1000) + random() * 50;
        if (!best || score > best.score) best = { position: at, yaw: wrapAngle(Math.atan2(dx, -dy)), score };
      }
    }
    if (best) return { position: best.position, yaw: best.yaw, onWall: true };
    const pts = refs.length ? refs.map((r) => r.transform.position) : [{ x: 0, y: 0, z: 0 }];
    const c = { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
    const ground = surfaces.down(c.x, c.y, 100_000, 200_000);
    return { position: { x: c.x, y: c.y, z: ground?.point.z ?? 0 }, yaw: 0, onWall: false };
  }

  /** Make two doors lead to each other (sets both teleport destinations and markers). */
  async linkDoors(a: FormKey, b: FormKey): Promise<void> {
    if (a === b) throw new WorkspaceError('Pick two different doors');
    for (const d of [a, b]) {
      const v = this.ws.view(d);
      if (!v || v.sig !== 'REFR' || this.ws.view(v.data.base as FormKey)?.sig !== 'DOOR') throw new WorkspaceError(`${this.ws.describeKey(d)} isn't a placed door`);
    }
    const ma = await this.teleportMarker(a);
    const mb = await this.teleportMarker(b);
    // Load doors must be persistent so the engine can find their partner.
    this.ws.transaction('Link doors', () => {
      for (const [door, other, marker] of [
        [a, b, mb],
        [b, a, ma],
      ] as const) {
        const view = this.ws.updateRecord(door, { ...this.ws.view(door)!.data, teleport: { door: other, placement: marker, noAlarm: 0 } }, { unknown: this.ws.view(door)!.unknown });
        if (!(view.flags & RecordFlags.Persistent) || !view.parent.persistent) this.ws.setPersistent(door, true);
      }
    });
  }

  /** Place a new door of the same kind in another cell and link the pair. */
  async createLinkedDoor(door: FormKey, targetCell: FormKey, position: Vec3, yaw = 0): Promise<FormKey> {
    const v = this.ws.view(door);
    if (!v) throw new WorkspaceError(`${door} not found`);
    const base = v.data.base as FormKey;
    const created = this.world.placeReference(targetCell, base, { position, rotation: { x: 0, y: 0, z: yaw } }, { persistent: true });
    await this.linkDoors(door, created);
    return created;
  }

  /**
   * After a linked door moves, the partner's teleport marker (where the player
   * arrives next to the moved door) is recomputed. Returns the partners updated.
   */
  async refreshTeleportMarkers(moved: FormKey[]): Promise<FormKey[]> {
    const updates: { partner: FormKey; marker: { position: Vec3; rotation: Vec3 } }[] = [];
    for (const d of moved) {
      const v = this.ws.view(d);
      const partner = (v?.data.teleport as { door?: FormKey } | undefined)?.door;
      if (!partner || !this.ws.exists(partner)) continue;
      const pv = this.ws.view(partner);
      if ((pv?.data.teleport as { door?: FormKey } | undefined)?.door !== d) continue;
      updates.push({ partner, marker: await this.teleportMarker(d) });
    }
    if (updates.length)
      this.ws.transaction('Update teleport markers', () => {
        for (const u of updates)
          this.ws.editRecord(u.partner, (data) => {
            const t = data.teleport as Record<string, unknown>;
            data.teleport = { ...t, placement: u.marker };
            return data;
          });
      });
    return updates.map((u) => u.partner);
  }

  // ---------------------------------------------------------------- navmesh freshness

  /** Fingerprint of everything that shapes the navmesh (solid objects, doors, terrain). */
  geometryFingerprint(cell: FormKey): string {
    const parts = this.world
      .references(cell)
      .filter((r) => r.model && !r.marker && r.baseSig && ['STAT', 'MSTT', 'FURN', 'CONT', 'ACTI', 'DOOR', 'TREE', 'SCOL'].includes(r.baseSig))
      .map((r) => {
        const t = r.transform;
        const f = (n: number) => Math.round(n);
        return `${r.formKey}:${r.base}:${r.disabled ? 0 : 1}:${f(t.position.x)},${f(t.position.y)},${f(t.position.z)}:${Math.round(t.rotation.x * 100)},${Math.round(t.rotation.y * 100)},${Math.round(t.rotation.z * 100)}:${Math.round(t.scale * 100)}`;
      })
      .sort();
    const land = this.world.terrain(cell);
    if (land) parts.push(`land:${Array.from(land.heights.subarray(0, 1089), Math.round).join(',')}`);
    let h = 2166136261;
    for (const s of parts) for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return `${parts.length}:${(h >>> 0).toString(16)}`;
  }

  private stampPath(): string {
    if (!this.ws.activeName) throw new WorkspaceError('No active plugin');
    return joinPath(this.ws.options.outputDir, 'TES5EnvEditor', `${this.ws.activeName}.navmesh.json`);
  }

  private async readStamps(): Promise<Record<string, string>> {
    try {
      return JSON.parse(new TextDecoder().decode(await this.ws.fs.readFile(this.stampPath()))) as Record<string, string>;
    } catch {
      return {};
    }
  }

  /** Remember the geometry a navmesh was generated from. */
  async stampNavmesh(cell: FormKey): Promise<void> {
    const stamps = await this.readStamps();
    stamps[cell] = this.geometryFingerprint(cell);
    await this.ws.fs.mkdir(joinPath(this.ws.options.outputDir, 'TES5EnvEditor'));
    await this.ws.fs.writeFile(this.stampPath(), new TextEncoder().encode(JSON.stringify(stamps, null, 1)));
  }

  /** Is this cell's navmesh (from the active plugin) older than its geometry? */
  async navmeshStatus(cell: FormKey): Promise<'none' | 'fresh' | 'stale' | 'unknown'> {
    const mine = existingNavmeshes(this.ws, cell);
    if (!mine.length) return 'none';
    if (!this.ws.activeName) return 'unknown';
    const stamp = (await this.readStamps())[cell];
    if (!stamp) return 'unknown';
    return stamp === this.geometryFingerprint(cell) ? 'fresh' : 'stale';
  }
}
