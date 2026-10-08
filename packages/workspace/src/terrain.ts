/**
 * Terrain sculpting: raise, lower, smooth and flatten brushes over the height
 * maps (LAND VHGT) of one or more exterior cells. Edges shared by neighbouring
 * cells stay identical because every edit is made on one height field in
 * world coordinates and written back to each cell it touches.
 */
import type { FormKey } from '@tes5/esp';
import { WorkspaceError, type Workspace } from './engine';
import type { LandQuadrant } from './world';
import type { WorldService } from './world';

/** Distance between terrain vertices, and vertices per cell side. */
export const LAND_STEP = 128;
export const LAND_SIZE = 33;
const CELL = 4096;

export type SculptMode = 'raise' | 'lower' | 'smooth' | 'flatten';

export interface SculptOptions {
  mode: SculptMode;
  /** Brush radius in game units. */
  radius: number;
  /** 0–1. */
  strength: number;
  /** Height flatten levels to (defaults to the height under the first dab). */
  flattenTo?: number;
}

/** Heights keyed by global vertex index (cells share their edge vertices). */
export class HeightField {
  readonly h = new Map<string, number>();
  key(gx: number, gy: number): string {
    return `${gx},${gy}`;
  }
  get(gx: number, gy: number): number | undefined {
    return this.h.get(`${gx},${gy}`);
  }
  set(gx: number, gy: number, v: number): void {
    this.h.set(`${gx},${gy}`, v);
  }
  /** Height at a world position (bilinear), if the vertices around it are loaded. */
  heightAt(x: number, y: number): number | undefined {
    const fx = x / LAND_STEP;
    const fy = y / LAND_STEP;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const a = this.get(x0, y0);
    const b = this.get(x0 + 1, y0);
    const c = this.get(x0, y0 + 1);
    const d = this.get(x0 + 1, y0 + 1);
    if (a === undefined || b === undefined || c === undefined || d === undefined) return a ?? b ?? c ?? d;
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
}

/** Smooth falloff: 1 at the centre, 0 at the edge. */
function falloff(d: number, r: number): number {
  if (d >= r) return 0;
  const t = d / r;
  return 0.5 * (1 + Math.cos(Math.PI * t));
}

/**
 * Apply one brush dab to the height field. Returns the vertices changed.
 * Raise/lower move up to 64 units per dab at full strength; smooth and
 * flatten blend toward the neighbours' average / the flatten height.
 */
export function sculptDab(field: HeightField, at: { x: number; y: number }, opts: SculptOptions): string[] {
  const changed: string[] = [];
  const r = Math.max(LAND_STEP, opts.radius);
  const s = Math.max(0, Math.min(1, opts.strength));
  const gx0 = Math.floor((at.x - r) / LAND_STEP);
  const gx1 = Math.ceil((at.x + r) / LAND_STEP);
  const gy0 = Math.floor((at.y - r) / LAND_STEP);
  const gy1 = Math.ceil((at.y + r) / LAND_STEP);
  const updates: [number, number, number][] = [];
  for (let gy = gy0; gy <= gy1; gy++)
    for (let gx = gx0; gx <= gx1; gx++) {
      const h = field.get(gx, gy);
      if (h === undefined) continue;
      const w = falloff(Math.hypot(gx * LAND_STEP - at.x, gy * LAND_STEP - at.y), r) * s;
      if (w <= 0) continue;
      let nh = h;
      if (opts.mode === 'raise') nh = h + 64 * w;
      else if (opts.mode === 'lower') nh = h - 64 * w;
      else if (opts.mode === 'flatten') nh = h + ((opts.flattenTo ?? h) - h) * w;
      else {
        let sum = 0;
        let n = 0;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const v = field.get(gx + dx, gy + dy);
          if (v !== undefined) (sum += v), n++;
        }
        if (n) nh = h + (sum / n - h) * w;
      }
      if (nh !== h) updates.push([gx, gy, nh]);
    }
  // Smoothing reads the neighbours before any of them change.
  for (const [gx, gy, v] of updates) {
    field.set(gx, gy, v);
    changed.push(field.key(gx, gy));
  }
  return changed;
}

// ------------------------------------------------------------------ LAND encoding

/** Heights (game units) from a VHGT subrecord: a base offset, then a byte per vertex as the change from the previous one. */
export function decodeVhgt(vhgt: Uint8Array): { heights: Float32Array; offset: number } {
  const dv = new DataView(vhgt.buffer, vhgt.byteOffset, vhgt.byteLength);
  const offset = dv.getFloat32(0, true);
  const heights = new Float32Array(LAND_SIZE * LAND_SIZE);
  let rowStart = offset;
  for (let row = 0; row < LAND_SIZE; row++) {
    rowStart += dv.getInt8(4 + row * LAND_SIZE);
    let h = rowStart;
    heights[row * LAND_SIZE] = h * 8;
    for (let col = 1; col < LAND_SIZE; col++) {
      h += dv.getInt8(4 + row * LAND_SIZE + col);
      heights[row * LAND_SIZE + col] = h * 8;
    }
  }
  return { heights, offset };
}

/**
 * Encode heights back to VHGT, keeping the base offset. Heights are stored in
 * steps of 8 units, and neighbouring vertices can differ by at most 127 steps
 * (about 1016 units per 128); steeper slopes are clamped. Returns the bytes and
 * the heights as the game will read them.
 */
export function encodeVhgt(heights: Float32Array, offset: number, tail: Uint8Array = new Uint8Array(3)): { bytes: Uint8Array; heights: Float32Array } {
  const out = new Uint8Array(4 + LAND_SIZE * LAND_SIZE + tail.byteLength);
  const dv = new DataView(out.buffer);
  dv.setFloat32(0, offset, true);
  const stored = new Float32Array(LAND_SIZE * LAND_SIZE);
  const clamp = (v: number) => Math.max(-128, Math.min(127, v));
  let rowStart = 0; // in steps, relative to offset
  for (let row = 0; row < LAND_SIZE; row++) {
    const want0 = Math.round(heights[row * LAND_SIZE]! / 8 - offset);
    const d0 = clamp(want0 - rowStart);
    dv.setInt8(4 + row * LAND_SIZE, d0);
    rowStart += d0;
    let h = rowStart;
    stored[row * LAND_SIZE] = (offset + h) * 8;
    for (let col = 1; col < LAND_SIZE; col++) {
      const want = Math.round(heights[row * LAND_SIZE + col]! / 8 - offset);
      const d = clamp(want - h);
      dv.setInt8(4 + row * LAND_SIZE + col, d);
      h += d;
      stored[row * LAND_SIZE + col] = (offset + h) * 8;
    }
  }
  out.set(tail, 4 + LAND_SIZE * LAND_SIZE);
  return { bytes: out, heights: stored };
}

/** Vertex normals (VNML: x, y, z as signed bytes ×127), using neighbours across cell edges when loaded. */
export function computeNormals(field: HeightField, cellX: number, cellY: number): Uint8Array {
  const out = new Uint8Array(LAND_SIZE * LAND_SIZE * 3);
  const dv = new DataView(out.buffer);
  for (let r = 0; r < LAND_SIZE; r++)
    for (let c = 0; c < LAND_SIZE; c++) {
      const gx = cellX * 32 + c;
      const gy = cellY * 32 + r;
      const h = field.get(gx, gy) ?? 0;
      const slope = (a: number | undefined, b: number | undefined) => (a !== undefined && b !== undefined ? (a - b) / (2 * LAND_STEP) : a !== undefined ? (a - h) / LAND_STEP : b !== undefined ? (h - b) / LAND_STEP : 0);
      const sx = slope(field.get(gx + 1, gy), field.get(gx - 1, gy));
      const sy = slope(field.get(gx, gy + 1), field.get(gx, gy - 1));
      const len = Math.hypot(sx, sy, 1);
      const i = (r * LAND_SIZE + c) * 3;
      dv.setInt8(i, Math.round((-sx / len) * 127));
      dv.setInt8(i + 1, Math.round((-sy / len) * 127));
      dv.setInt8(i + 2, Math.round((1 / len) * 127));
    }
  return out;
}

// ------------------------------------------------------------------ service

interface LoadedLand {
  cell: FormKey;
  land: FormKey;
  grid: { x: number; y: number };
  offset: number;
  tail: Uint8Array;
}

export class TerrainService {
  constructor(
    readonly ws: Workspace,
    readonly world: WorldService,
  ) {}

  /** The winning LAND record of an exterior cell. */
  landOf(cell: FormKey): FormKey | undefined {
    for (let i = this.ws.slots.length - 1; i >= 0; i--) {
      const s = this.ws.slots[i]!;
      const local = s.plugin && s.mapper?.toLocal(cell);
      const cellRec = local !== undefined && local !== null ? s.plugin!.getRecord(local) : undefined;
      const children = cellRec ? s.plugin!.childGroupOf(cellRec) : undefined;
      if (!children) continue;
      for (const g of children.groups)
        for (const r of g.records) if (r.sig === 'LAND' && !r.isDeleted) return this.ws.keyOf(s, r.formId) ?? undefined;
    }
    return undefined;
  }

  /** Height field of the cells around a point (those the brush can reach, plus one vertex beyond for normals). */
  private load(worldspace: FormKey | undefined, minX: number, minY: number, maxX: number, maxY: number): { field: HeightField; lands: LoadedLand[] } {
    const field = new HeightField();
    const lands: LoadedLand[] = [];
    for (let cy = minY; cy <= maxY; cy++)
      for (let cx = minX; cx <= maxX; cx++) {
        const cell = this.world.cellAt(worldspace, { x: cx, y: cy });
        const land = cell ? this.landOf(cell) : undefined;
        const v = land ? this.ws.view(land) : undefined;
        const vhgt = v?.data.heights;
        if (!cell || !land || !(vhgt instanceof Uint8Array) || vhgt.byteLength < 4 + LAND_SIZE * LAND_SIZE) continue;
        const { heights, offset } = decodeVhgt(vhgt);
        for (let r = 0; r < LAND_SIZE; r++) for (let c = 0; c < LAND_SIZE; c++) field.set(cx * 32 + c, cy * 32 + r, heights[r * LAND_SIZE + c]!);
        lands.push({ cell, land, grid: { x: cx, y: cy }, offset, tail: vhgt.slice(4 + LAND_SIZE * LAND_SIZE) });
      }
    return { field, lands };
  }

  /**
   * Sculpt along a brush stroke (one undo step). `cell` is any cell of the
   * worldspace being edited. Returns the cells whose terrain changed.
   */
  sculpt(cell: FormKey, points: { x: number; y: number }[], opts: SculptOptions): FormKey[] {
    if (!points.length) return [];
    const info = this.world.cells().find((c) => c.formKey === cell);
    if (!info || info.interior) throw new WorkspaceError('Terrain can only be sculpted outdoors');
    const r = opts.radius;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minX = Math.floor((Math.min(...xs) - r - LAND_STEP) / CELL);
    const maxX = Math.floor((Math.max(...xs) + r + LAND_STEP) / CELL);
    const minY = Math.floor((Math.min(...ys) - r - LAND_STEP) / CELL);
    const maxY = Math.floor((Math.max(...ys) + r + LAND_STEP) / CELL);
    const { field, lands } = this.load(info.worldspace, minX, minY, maxX, maxY);
    if (!lands.length) throw new WorkspaceError('There is no terrain here to sculpt');
    const flattenTo = opts.mode === 'flatten' ? (opts.flattenTo ?? field.heightAt(points[0]!.x, points[0]!.y)) : undefined;
    const touched = new Set<string>();
    for (const p of points) for (const k of sculptDab(field, p, { ...opts, flattenTo })) touched.add(k);
    if (!touched.size) return [];
    // A cell changes if any of its vertices (or a neighbour used for its normals) changed.
    const changed: FormKey[] = [];
    this.ws.transaction(`Sculpt terrain (${opts.mode})`, () => {
      for (const l of lands) {
        let hit = false;
        for (let r2 = -1; r2 <= LAND_SIZE && !hit; r2++) for (let c2 = -1; c2 <= LAND_SIZE && !hit; c2++) if (touched.has(field.key(l.grid.x * 32 + c2, l.grid.y * 32 + r2))) hit = true;
        if (!hit) continue;
        const heights = new Float32Array(LAND_SIZE * LAND_SIZE);
        for (let rr = 0; rr < LAND_SIZE; rr++) for (let cc = 0; cc < LAND_SIZE; cc++) heights[rr * LAND_SIZE + cc] = field.get(l.grid.x * 32 + cc, l.grid.y * 32 + rr)!;
        const enc = encodeVhgt(heights, l.offset, l.tail);
        // Keep the field as stored (8-unit steps), so neighbours' normals see the same heights.
        for (let rr = 0; rr < LAND_SIZE; rr++) for (let cc = 0; cc < LAND_SIZE; cc++) field.set(l.grid.x * 32 + cc, l.grid.y * 32 + rr, enc.heights[rr * LAND_SIZE + cc]!);
        (l as LoadedLand & { bytes?: Uint8Array }).bytes = enc.bytes;
        changed.push(l.cell);
      }
      for (const l of lands as (LoadedLand & { bytes?: Uint8Array })[]) {
        if (!l.bytes) continue;
        const v = this.ws.view(l.land)!;
        const flags = (Number(v.data.flags ?? 0) | 1) >>> 0;
        this.ws.updateRecord(l.land, { ...v.data, flags, heights: l.bytes, normals: computeNormals(field, l.grid.x, l.grid.y) }, { unknown: v.unknown, label: 'Sculpt terrain' });
      }
    });
    return changed;
  }

  /**
   * Paint a landscape texture along a brush stroke (one undo step), the way
   * the CK's landscape painting does: each quarter-cell has a base texture
   * and up to six painted layers, each with an opacity at 17×17 points.
   * Painting the base texture fades the layers on top of it; painting another
   * texture raises (or adds) its layer and fades the layers above it.
   * Returns the cells whose ground changed, and whether some ground already
   * had six painted textures (the most it can hold) so nothing new was added.
   */
  paintTexture(cell: FormKey, points: { x: number; y: number }[], opts: { texture: FormKey; radius: number; strength: number; erase?: boolean }): { cells: FormKey[]; full: boolean } {
    if (!points.length) return { cells: [], full: false };
    if (this.ws.summary(opts.texture)?.sig !== 'LTEX') throw new WorkspaceError('Pick a landscape texture to paint with');
    const info = this.world.cells().find((c) => c.formKey === cell);
    if (!info || info.interior) throw new WorkspaceError('Ground textures can only be painted outdoors');
    const r = opts.radius;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minX = Math.floor((Math.min(...xs) - r) / CELL);
    const maxX = Math.floor((Math.max(...xs) + r) / CELL);
    const minY = Math.floor((Math.min(...ys) - r) / CELL);
    const maxY = Math.floor((Math.max(...ys) + r) / CELL);
    const strength = Math.max(0, Math.min(1, opts.strength));
    const changed: FormKey[] = [];
    let full = false;
    this.ws.transaction('Paint ground texture', () => {
      for (let cy = minY; cy <= maxY; cy++)
        for (let cx = minX; cx <= maxX; cx++) {
          const c = this.world.cellAt(info.worldspace, { x: cx, y: cy });
          const land = c ? this.landOf(c) : undefined;
          const quads = c ? this.world.landLayers(c) : undefined;
          if (!c || !land || !quads) continue;
          let hit = false;
          for (let q = 0; q < 4; q++) {
            const quad = quads[q]!;
            const qx = q & 1;
            const qy = q >> 1;
            for (let row = 0; row < 17; row++)
              for (let col = 0; col < 17; col++) {
                const wx = cx * CELL + (qx * 16 + col) * LAND_STEP;
                const wy = cy * CELL + (qy * 16 + row) * LAND_STEP;
                // Strongest at the centre of the brush, nothing at its edge.
                let w = 0;
                for (const p of points) {
                  const d = Math.hypot(p.x - wx, p.y - wy);
                  if (d < r) w = Math.max(w, strength * (1 - (d / r) ** 2));
                }
                if (w <= 0.001) continue;
                hit = true;
                const i = row * 17 + col;
                // Ctrl+drag: fade this texture where it's painted.
                if (opts.erase) {
                  const own = quad.layers.find((l) => l.ltex === opts.texture);
                  if (own) own.alpha[i] = own.alpha[i]! * (1 - w);
                  continue;
                }
                // Bare ground (the game's default) gets a layer, so only the brushed area changes.
                if (quad.base === opts.texture) {
                  for (const l of quad.layers) l.alpha[i] = l.alpha[i]! * (1 - w);
                  continue;
                }
                let layer = quad.layers.find((l) => l.ltex === opts.texture);
                if (!layer) {
                  if (quad.layers.length >= 6) {
                    // Full: reuse the faintest layer.
                    const faintest = [...quad.layers].sort((a, b) => a.alpha.reduce((s, v) => s + v, 0) - b.alpha.reduce((s, v) => s + v, 0))[0]!;
                    if (faintest.alpha.some((v) => v > 0.02)) {
                      full = true;
                      continue;
                    }
                    quad.layers.splice(quad.layers.indexOf(faintest), 1);
                  }
                  layer = { ltex: opts.texture, layer: quad.layers.length, alpha: new Float32Array(289) };
                  quad.layers.push(layer);
                }
                layer.alpha[i] = layer.alpha[i]! + (1 - layer.alpha[i]!) * w;
                for (const l of quad.layers.slice(quad.layers.indexOf(layer) + 1)) l.alpha[i] = l.alpha[i]! * (1 - w);
              }
          }
          if (!hit) continue;
          this.writeLayers(land, quads);
          changed.push(c);
        }
    });
    return { cells: changed, full };
  }

  /** Write a LAND record's texture layers (BTXT, then ATXT + VTXT per layer, for each quarter-cell). */
  writeLayers(land: FormKey, quads: LandQuadrant[], label = 'Paint ground texture'): void {
    const v = this.ws.view(land)!;
    const layerSigs = new Set(['BTXT', 'ATXT', 'VTXT']);
    const keep = v.unknown.filter((u) => !layerSigs.has(u.sig));
    const old = v.unknown.filter((u) => layerSigs.has(u.sig));
    let index = old.length ? Math.min(...old.map((u) => u.index)) : 4;
    const subs: { index: number; sig: string; data: Uint8Array }[] = [];
    const head = (ltex: FormKey | null, quadrant: number, layer: number) => {
      const b = new Uint8Array(8);
      const dv = new DataView(b.buffer);
      dv.setUint32(0, ltex ? this.ws.localIdForActive(ltex) : 0, true);
      b[4] = quadrant;
      dv.setInt16(6, layer, true);
      return b;
    };
    for (let q = 0; q < 4; q++) {
      const quad = quads[q]!;
      if (quad.base !== undefined) subs.push({ index: index++, sig: 'BTXT', data: head(quad.base ?? null, q, -1) });
      const layers = quad.layers.filter((l) => l.alpha.some((a) => a > 0.002));
      layers.forEach((l, n) => {
        subs.push({ index: index++, sig: 'ATXT', data: head(l.ltex, q, n) });
        const points = [...l.alpha].map((a, pos) => ({ a, pos })).filter((p) => p.a > 0.002);
        const vt = new Uint8Array(points.length * 8);
        const dv = new DataView(vt.buffer);
        points.forEach((p, k) => {
          dv.setUint16(k * 8, p.pos, true);
          dv.setFloat32(k * 8 + 4, Math.min(1, p.a), true);
        });
        subs.push({ index: index++, sig: 'VTXT', data: vt });
      });
    }
    // Later fields keep their place after the layers.
    const shift = index - (old.length ? Math.min(...old.map((u) => u.index)) + old.length : 4);
    const after = keep.map((u) => (old.length && u.index > Math.max(...old.map((o) => o.index)) ? { ...u, index: u.index + shift } : u));
    this.ws.updateRecord(land, v.data, { unknown: [...after, ...subs].sort((a, b) => a.index - b.index), label });
  }
}
