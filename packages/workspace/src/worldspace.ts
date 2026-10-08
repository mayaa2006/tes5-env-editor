/**
 * New worldspaces and new outdoor cells, the way the CK makes them: a
 * worldspace with its persistent cell, map and water settings, and a square
 * of outdoor cells with flat ground; and single outdoor cells whose ground
 * meets the cells already around them without a step.
 */
import { RecordFlags, type FormKey } from '@tes5/esp';
import { WorkspaceError, type Workspace } from './engine';
import { HeightField, LAND_SIZE, computeNormals, encodeVhgt, type TerrainService } from './terrain';
import type { LandQuadrant, WorldService } from './world';

const CELL = 4096;

export interface NewWorldspaceOptions {
  editorId: string;
  /** Shown on the map and when the player enters. */
  name?: string;
  /** Cells along each side of the square made (odd, 1–9). Default 3. */
  size?: number;
  /** Height of the flat ground, in game units. Default 0. */
  groundHeight?: number;
  /** A landscape texture (LTEX) for the whole ground; otherwise the game's default. */
  texture?: FormKey;
  /** Water at `waterHeight` (default 200 below the ground). Default off. */
  water?: boolean;
  waterHeight?: number;
  /** Take the weather (climate), water type and music from this worldspace. */
  like?: FormKey;
  /** The player can't fast travel here. */
  noFastTravel?: boolean;
}

export interface NewExteriorCellOptions {
  editorId?: string;
  name?: string;
  /** A landscape texture (LTEX) for the new ground; by default the one most used by the cells next to it (null: the game's default). */
  texture?: FormKey | null;
  /** Height of the ground when no neighbour has any (defaults to the worldspace's land height). */
  groundHeight?: number;
}

export class WorldspaceService {
  constructor(
    readonly ws: Workspace,
    readonly world: WorldService,
    readonly terrain: TerrainService,
  ) {}

  /**
   * A new worldspace: its persistent cell, then a square of outdoor cells
   * centred on 0, 0, each with flat ground. One undo step.
   */
  createWorldspace(opts: NewWorldspaceOptions): { worldspace: FormKey; persistentCell: FormKey; cells: FormKey[]; center: FormKey } {
    const size = Math.max(1, Math.min(9, Math.floor(opts.size ?? 3)));
    const lo = -Math.floor((size - 1) / 2);
    const hi = lo + size - 1;
    const ground = opts.groundHeight ?? 0;
    const waterHeight = opts.water ? (opts.waterHeight ?? ground - 200) : ground - 2048;
    if (opts.texture && this.ws.summary(opts.texture)?.sig !== 'LTEX') throw new WorkspaceError('The ground texture must be a landscape texture');
    const like = opts.like ? this.ws.view(opts.like) : undefined;
    if (opts.like && like?.sig !== 'WRLD') throw new WorkspaceError('“Weather and music like” must be a worldspace');
    // Map data: usable size (0 = whole), north-west and south-east cells, camera heights and pitch (CK defaults).
    const map = new Uint8Array(28);
    const mdv = new DataView(map.buffer);
    mdv.setInt16(8, lo, true);
    mdv.setInt16(10, hi, true);
    mdv.setInt16(12, hi, true);
    mdv.setInt16(14, lo, true);
    mdv.setFloat32(16, 50000, true);
    mdv.setFloat32(20, 80000, true);
    mdv.setFloat32(24, 50, true);
    const mapOffset = new Uint8Array(16);
    new DataView(mapOffset.buffer).setFloat32(0, 1, true);
    const data: Record<string, unknown> = {
      editorId: opts.editorId,
      parent: {},
      landData: { defaultLandHeight: ground, defaultWaterHeight: waterHeight },
      mapData: map,
      mapOffset,
      distantLodMultiplier: 1,
      // Can't Fast Travel (0x2), No LOD Water (0x8).
      flags: (opts.noFastTravel ? 0x2 : 0) | (opts.water ? 0 : 0x8),
      boundsMin: { x: lo * CELL, y: lo * CELL },
      boundsMax: { x: (hi + 1) * CELL, y: (hi + 1) * CELL },
    };
    if (opts.name) data.name = opts.name;
    if (like) {
      for (const k of ['climate', 'music'] as const) if (like.data[k]) data[k] = like.data[k];
      if (opts.water && like.data.water) data.water = like.data.water;
    }
    if (opts.water) {
      if (data.water) data.lodWater = data.water;
      data.lodWaterHeight = waterHeight;
    }
    return this.ws.transaction(`Create worldspace ${opts.editorId}`, () => {
      const worldspace = this.ws.createRecord('WRLD', data);
      // The persistent cell holds references that must always be loaded (doors, map markers…).
      const persistentCell = this.ws.createRecord('CELL', { flags: opts.water ? 0x2 : 0, grid: { x: 0, y: 0, forceHideLand: 0 } }, { worldspace, worldCell: true }, RecordFlags.Persistent);
      const cells: FormKey[] = [];
      let center: FormKey | undefined;
      for (let y = lo; y <= hi; y++)
        for (let x = lo; x <= hi; x++) {
          const cell = this.createCellAt(worldspace, { x, y }, { texture: opts.texture }, !!opts.water, () => ground);
          cells.push(cell);
          if (x === 0 && y === 0) center = cell;
        }
      return { worldspace, persistentCell, cells, center: center ?? cells[0]! };
    });
  }

  /**
   * A new outdoor cell at a grid position. Its ground meets the edges of the
   * cells already around it and blends smoothly between them; with no
   * neighbours it is flat. One undo step.
   */
  createExteriorCell(worldspace: FormKey, grid: { x: number; y: number }, opts: NewExteriorCellOptions = {}): FormKey {
    const w = this.ws.view(worldspace);
    if (w?.sig !== 'WRLD') throw new WorkspaceError('Pick a worldspace for the new cell');
    const gx = Math.trunc(grid.x);
    const gy = Math.trunc(grid.y);
    if (this.world.cellAt(worldspace, { x: gx, y: gy })) throw new WorkspaceError(`There is already a cell at ${gx}, ${gy}`);
    if (opts.texture && this.ws.summary(opts.texture)?.sig !== 'LTEX') throw new WorkspaceError('The ground texture must be a landscape texture');
    const land = w.data.landData as { defaultLandHeight?: number; defaultWaterHeight?: number } | undefined;
    const base = opts.groundHeight ?? this.nearbyHeight(worldspace, gx, gy) ?? land?.defaultLandHeight ?? 0;
    if (opts.texture === undefined) opts = { ...opts, texture: this.neighbourTexture(worldspace, gx, gy) };
    // Water like the cells next to it; otherwise as the worldspace has it (No LOD Water = none).
    const water = this.neighbourHasWater(worldspace, gx, gy, (Number(w.data.flags ?? 0) & 0x8) === 0);
    return this.ws.transaction(`Create cell ${gx}, ${gy}`, () => this.createCellAt(worldspace, { x: gx, y: gy }, opts, water, (field) => this.blend(field, worldspace, gx, gy, base)));
  }

  /** The nearest free grid position next to `near` (or the worldspace's cells), for a new cell. */
  freeSpotNear(worldspace: FormKey, near?: { x: number; y: number }): { x: number; y: number } {
    const used = new Set(this.world.cells({ worldspace }).filter((c) => !c.interior && !c.persistentCell && c.grid).map((c) => `${c.grid!.x},${c.grid!.y}`));
    const start = near ?? { x: 0, y: 0 };
    for (let r = 0; r < 64; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const p = { x: start.x + dx, y: start.y + dy };
          if (!used.has(`${p.x},${p.y}`)) return p;
        }
    return start;
  }

  private createCellAt(worldspace: FormKey, grid: { x: number; y: number }, opts: NewExteriorCellOptions, water: boolean, heightsFor: (field: HeightField) => number | void): FormKey {
    const data: Record<string, unknown> = { flags: water ? 0x2 : 0, grid: { x: grid.x, y: grid.y, forceHideLand: 0 } };
    if (opts.editorId) data.editorId = opts.editorId;
    if (opts.name) data.name = opts.name;
    const cell = this.ws.createRecord('CELL', data, { worldspace });
    const field = new HeightField();
    const flat = heightsFor(field);
    if (typeof flat === 'number') for (let r = 0; r < LAND_SIZE; r++) for (let c = 0; c < LAND_SIZE; c++) field.set(grid.x * 32 + c, grid.y * 32 + r, flat);
    const heights = new Float32Array(LAND_SIZE * LAND_SIZE);
    for (let r = 0; r < LAND_SIZE; r++) for (let c = 0; c < LAND_SIZE; c++) heights[r * LAND_SIZE + c] = field.get(grid.x * 32 + c, grid.y * 32 + r)!;
    const enc = encodeVhgt(heights, Math.round(heights[0]! / 8));
    for (let r = 0; r < LAND_SIZE; r++) for (let c = 0; c < LAND_SIZE; c++) field.set(grid.x * 32 + c, grid.y * 32 + r, enc.heights[r * LAND_SIZE + c]!);
    const land = this.ws.createRecord('LAND', { flags: 0x1, normals: computeNormals(field, grid.x, grid.y), heights: enc.bytes }, { cell });
    if (opts.texture) {
      const quads: LandQuadrant[] = [0, 1, 2, 3].map(() => ({ base: opts.texture, layers: [] }));
      this.terrain.writeLayers(land, quads, 'Set ground texture');
    }
    return cell;
  }

  /** Average ground height of the cells around a grid position, if any have ground. */
  private nearbyHeight(worldspace: FormKey, gx: number, gy: number): number | undefined {
    let sum = 0;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const c = this.world.cellAt(worldspace, { x: gx + dx, y: gy + dy });
        const t = c ? this.world.terrain(c, { x: gx + dx, y: gy + dy }) : undefined;
        if (!t) continue;
        for (const h of t.heights) sum += h;
        n += t.heights.length;
      }
    return n ? sum / n : undefined;
  }

  /** The base ground texture most used by the cells next to a grid position. */
  private neighbourTexture(worldspace: FormKey, gx: number, gy: number): FormKey | null {
    const count = new Map<FormKey, number>();
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const c = this.world.cellAt(worldspace, { x: gx + dx, y: gy + dy });
      for (const q of (c && this.world.landLayers(c)) || []) if (q.base) count.set(q.base, (count.get(q.base) ?? 0) + 1);
    }
    return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }

  private neighbourHasWater(worldspace: FormKey, gx: number, gy: number, fallback: boolean): boolean {
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const c = this.world.cellAt(worldspace, { x: gx + dx, y: gy + dy });
      const flags = c ? Number(this.ws.view(c)?.data.flags ?? 0) : undefined;
      if (flags !== undefined) return (flags & 0x2) !== 0;
    }
    return fallback;
  }

  /**
   * Fill a new cell's heights: vertices shared with existing neighbours
   * (edges and corners) are fixed to theirs, and the rest relax smoothly
   * between them (starting from `base`). The field also gets the
   * neighbours' heights so normals at the edges match.
   */
  private blend(field: HeightField, worldspace: FormKey, gx: number, gy: number, base: number): void {
    const fixed = new Set<string>();
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const c = this.world.cellAt(worldspace, { x: gx + dx, y: gy + dy });
        const t = c ? this.world.terrain(c, { x: gx + dx, y: gy + dy }) : undefined;
        if (!t) continue;
        for (let r = 0; r < LAND_SIZE; r++)
          for (let col = 0; col < LAND_SIZE; col++) {
            const vx = (gx + dx) * 32 + col;
            const vy = (gy + dy) * 32 + r;
            field.set(vx, vy, t.heights[r * LAND_SIZE + col]!);
            if (vx >= gx * 32 && vx <= gx * 32 + 32 && vy >= gy * 32 && vy <= gy * 32 + 32) fixed.add(`${vx},${vy}`);
          }
      }
    const own = (c: number, r: number) => `${gx * 32 + c},${gy * 32 + r}`;
    for (let r = 0; r < LAND_SIZE; r++) for (let c = 0; c < LAND_SIZE; c++) if (!fixed.has(own(c, r))) field.set(gx * 32 + c, gy * 32 + r, base);
    if (!fixed.size) return;
    // Relax the free vertices towards the average of their neighbours (edges without a neighbour cell stay free).
    const h = new Float32Array(LAND_SIZE * LAND_SIZE);
    for (let r = 0; r < LAND_SIZE; r++) for (let c = 0; c < LAND_SIZE; c++) h[r * LAND_SIZE + c] = field.get(gx * 32 + c, gy * 32 + r)!;
    const free = (c: number, r: number) => !fixed.has(own(c, r));
    for (let it = 0; it < 400; it++)
      for (let r = 0; r < LAND_SIZE; r++)
        for (let c = 0; c < LAND_SIZE; c++) {
          if (!free(c, r)) continue;
          let s = 0;
          let n = 0;
          for (const [dc, dr] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
            const cc = c + dc;
            const rr = r + dr;
            if (cc < 0 || rr < 0 || cc >= LAND_SIZE || rr >= LAND_SIZE) continue;
            s += h[rr * LAND_SIZE + cc]!;
            n++;
          }
          h[r * LAND_SIZE + c] = s / n;
        }
    for (let r = 0; r < LAND_SIZE; r++) for (let c = 0; c < LAND_SIZE; c++) field.set(gx * 32 + c, gy * 32 + r, h[r * LAND_SIZE + c]!);
  }
}
