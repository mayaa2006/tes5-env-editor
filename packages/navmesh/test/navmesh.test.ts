import { describe, expect, it } from 'vitest';
import { NavTriFlags, PluginRecord, applyTyped, decodeRecord, type Navmesh } from '@tes5/esp';
import {
  NAVMESH_PRESETS,
  addTriangle,
  buildNavmeshInfo,
  countIslands,
  createNavmesh,
  decodeNavmeshInfo,
  deleteTriangles,
  encodeNavmeshInfo,
  findTriangleAt,
  generateWalkableMesh,
  linkDoors,
  linkNavmeshes,
  snapToCellBorder,
  validateNavmesh,
  walkableTriangles,
  weld,
  type TriangleMesh,
} from '../src';

/** A flat square grid of quads (2 triangles each), Z = z, CCW from above. */
function floor(x0: number, y0: number, size: number, n: number, z = 0): TriangleMesh {
  const vertices: number[] = [];
  const triangles: number[] = [];
  const step = size / n;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) vertices.push(x0 + i * step, y0 + j * step, z);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      const b = a + 1;
      const c = a + n + 1;
      const d = c + 1;
      triangles.push(a, b, d, a, d, c);
    }
  return { vertices, triangles };
}

/** Axis-aligned box as 12 triangles with outward-facing winding. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): TriangleMesh {
  const v = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const t = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { vertices: v, triangles: t };
}

function merge(...meshes: TriangleMesh[]): TriangleMesh {
  const out: TriangleMesh = { vertices: [], triangles: [] };
  for (const m of meshes) {
    const base = out.vertices.length / 3;
    out.vertices.push(...m.vertices);
    out.triangles.push(...m.triangles.map((i) => i + base));
  }
  return out;
}

describe('building navmeshes', () => {
  it('welds, orients and links triangles', () => {
    // Two triangles with duplicated vertices and one wrongly wound.
    const mesh = { vertices: [0, 0, 0, 100, 0, 0, 100, 100, 0, 0, 0, 0, 100, 100, 0.2, 0, 100, 0], triangles: [0, 1, 2, 3, 5, 4] };
    expect(weld(mesh, 1).vertices.length / 3).toBe(4);
    const nav = createNavmesh(mesh, { cell: 0x01000800 });
    expect(nav.vertices.length).toBe(4);
    expect(nav.triangles.length).toBe(2);
    expect(validateNavmesh(nav)).toEqual([]);
    expect(nav.triangles[0]!.e).toContain(1);
    expect(nav.triangles[1]!.e).toContain(0);
    expect(countIslands(nav)).toBe(1);
    expect(nav.grid.cells).toEqual([[0, 1]]);
  });

  it('builds a valid multi-cell grid', () => {
    const nav = createNavmesh(floor(0, 0, 1000, 10), { cell: 1 }, { gridDivisor: 4 });
    expect(nav.grid.divisor).toBe(4);
    expect(nav.grid.cells.length).toBe(16);
    expect(validateNavmesh(nav)).toEqual([]);
  });

  it('edits: delete and add triangles keep indices consistent', () => {
    const nav = createNavmesh(floor(0, 0, 400, 4), { cell: 1 });
    deleteTriangles(nav, [0, 1, 2, 3]);
    expect(nav.triangles.length).toBe(28);
    expect(validateNavmesh(nav).filter((i) => i.severity === 'error')).toEqual([]);
    const t = addTriangle(nav, { x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, { x: 100, y: 100, z: 0 });
    expect(validateNavmesh(nav).filter((i) => i.severity === 'error')).toEqual([]);
    expect(findTriangleAt(nav, { x: 90, y: 10, z: 0 })).toBe(t);
  });

  it('round-trips through the NAVM record schema', () => {
    const nav = createNavmesh(floor(0, 0, 200, 2), { world: 0x3c, grid: { x: 3, y: -2 } });
    const rec = PluginRecord.create('NAVM', 0x01000900, []);
    applyTyped(rec, { geometry: nav });
    const back = decodeRecord(rec).data.geometry as Navmesh;
    expect(back.parent).toEqual({ gridX: 3, gridY: -2 });
    expect(back.triangles).toEqual(nav.triangles);
  });
});

describe('linking', () => {
  it('links navmeshes across a shared cell border', () => {
    const a = createNavmesh(floor(0, 0, 4096, 4), { world: 0x3c, grid: { x: 0, y: 0 } });
    const b = createNavmesh(floor(4096, 0, 4096, 4), { world: 0x3c, grid: { x: 1, y: 0 } });
    const n = linkNavmeshes({ id: 0x01000a00, nav: a }, { id: 0x01000a01, nav: b });
    expect(n).toBe(4);
    expect(a.edgeLinks.every((l) => l.navmesh === 0x01000a01)).toBe(true);
    expect(validateNavmesh(a).filter((i) => i.severity === 'error')).toEqual([]);
    expect(validateNavmesh(b).filter((i) => i.severity === 'error')).toEqual([]);
    // Relinking is idempotent.
    expect(linkNavmeshes({ id: 0x01000a00, nav: a }, { id: 0x01000a01, nav: b })).toBe(4);
    expect(a.edgeLinks.length).toBe(4);
    const info = buildNavmeshInfo(0x01000a00, a);
    expect(info.edgeLinks).toEqual([0x01000a01]);
    const decoded = decodeNavmeshInfo(encodeNavmeshInfo(info));
    expect(decoded).toEqual(info);
  });

  it('snaps near-border vertices onto the border', () => {
    const nav = createNavmesh(floor(10, 0, 4070, 2), { world: 0x3c, grid: { x: 0, y: 0 } });
    expect(snapToCellBorder(nav, { x: 0, y: 0 })).toBeGreaterThan(0);
    expect(Math.min(...nav.vertices.map((v) => v.x))).toBe(0);
    expect(Math.max(...nav.vertices.map((v) => v.x))).toBe(4096);
  });

  it('links doors to the triangle beneath them', () => {
    const nav = createNavmesh(floor(0, 0, 400, 2), { cell: 1 });
    expect(linkDoors(nav, [{ ref: 0x01000b00, position: { x: 50, y: 50, z: 10 } }])).toBe(1);
    const tri = nav.doorLinks[0]!.triangle;
    expect(nav.triangles[tri]!.flags & NavTriFlags.Door).toBeTruthy();
  });
});

describe('generation', () => {
  it('keeps only walkable faces in fallback mode', () => {
    const geo = merge(floor(0, 0, 400, 1), box(100, 100, 0, 200, 200, 300));
    const walk = walkableTriangles(geo);
    // 2 floor triangles + 2 box top triangles; walls and the box bottom are excluded.
    expect(walk.triangles.length / 3).toBe(4);
  });

  it('generates a navmesh around an obstacle with Recast', async () => {
    const room = merge(floor(0, 0, 1024, 8), box(448, 448, 0, 576, 576, 256));
    const res = await generateWalkableMesh(room, { ...NAVMESH_PRESETS.interior, cellSize: 8, cellHeight: 4 });
    expect(res.error).toBeUndefined();
    expect(res.mesh.triangles.length).toBeGreaterThan(0);
    const nav = createNavmesh(res.mesh, { cell: 0x01000800 });
    expect(validateNavmesh(nav).filter((i) => i.severity === 'error')).toEqual([]);
    // Nothing walkable inside the pillar footprint (the pillar top is above the agent's reach but may be walkable on its own).
    const centerTri = findTriangleAt(nav, { x: 512, y: 512, z: 0 });
    expect(centerTri).toBe(-1);
    // The floor near a corner is walkable.
    expect(findTriangleAt(nav, { x: 100, y: 100, z: 0 })).toBeGreaterThanOrEqual(0);
    // Every vertex lies on the floor (Z ≈ 0) or the pillar top.
    expect(nav.vertices.every((v) => Math.abs(v.z) < 8 || Math.abs(v.z - 256) < 8)).toBe(true);
  });
});
