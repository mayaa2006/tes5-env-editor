/**
 * Building NVNM navmesh data from plain triangle meshes: welding, triangle
 * adjacency, the spatial grid and bounds. Everything the Creation Kit computes
 * when you "finalize" a navmesh, except cover (which is left empty).
 */
import { NAVMESH_PATHING_CELL_CRC, NavTriFlags, type NavTriangle, type NavVertex, type Navmesh } from '@tes5/esp';

export interface TriangleMesh {
  /** x, y, z triples in Skyrim units (Z up). */
  vertices: number[];
  /** Vertex index triples. */
  triangles: number[];
}

export interface NavmeshParent {
  /** Worldspace FormID (file-local or mapped) for exterior navmeshes. */
  world?: unknown;
  /** Exterior grid coordinates. */
  grid?: { x: number; y: number };
  /** Interior parent cell. */
  cell?: unknown;
}

export interface BuildOptions {
  /** Merge vertices closer than this (Skyrim units). Default 1. */
  weldTolerance?: number;
  /**
   * Spatial grid divisor (1–12). Default 1, which is always correct; larger
   * values speed up lookups but rely on the engine's cell ordering.
   */
  gridDivisor?: number;
  /** Cell order for gridDivisor > 1: row = Y (default) or row = X. */
  gridOrder?: 'yx' | 'xy';
}

/** Weld vertices within `tolerance` and drop degenerate triangles. */
export function weld(mesh: TriangleMesh, tolerance = 1): TriangleMesh {
  const cell = Math.max(tolerance, 1e-6);
  const map = new Map<string, number[]>();
  const out: number[] = [];
  const remap: number[] = [];
  const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  const n = mesh.vertices.length / 3;
  for (let i = 0; i < n; i++) {
    const x = mesh.vertices[i * 3]!;
    const y = mesh.vertices[i * 3 + 1]!;
    const z = mesh.vertices[i * 3 + 2]!;
    let found = -1;
    const kx = Math.floor(x / cell);
    const ky = Math.floor(y / cell);
    const kz = Math.floor(z / cell);
    for (let dx = -1; dx <= 1 && found < 0; dx++)
      for (let dy = -1; dy <= 1 && found < 0; dy++)
        for (let dz = -1; dz <= 1 && found < 0; dz++) {
          const bucket = map.get(`${kx + dx},${ky + dy},${kz + dz}`);
          if (!bucket) continue;
          for (const j of bucket) {
            const ox = out[j * 3]! - x;
            const oy = out[j * 3 + 1]! - y;
            const oz = out[j * 3 + 2]! - z;
            if (ox * ox + oy * oy + oz * oz <= tolerance * tolerance) {
              found = j;
              break;
            }
          }
        }
    if (found < 0) {
      found = out.length / 3;
      out.push(x, y, z);
      const k = key(x, y, z);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(found);
    }
    remap.push(found);
  }
  const tris: number[] = [];
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const a = remap[mesh.triangles[t]!]!;
    const b = remap[mesh.triangles[t + 1]!]!;
    const c = remap[mesh.triangles[t + 2]!]!;
    if (a === b || b === c || a === c) continue;
    tris.push(a, b, c);
  }
  return { vertices: out, triangles: tris };
}

/** Make every triangle face up (+Z), counter-clockwise when viewed from above. */
export function orientUp(mesh: TriangleMesh): TriangleMesh {
  const v = mesh.vertices;
  const tris = mesh.triangles.slice();
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t]!;
    const b = tris[t + 1]!;
    const c = tris[t + 2]!;
    const nz = (v[b * 3]! - v[a * 3]!) * (v[c * 3 + 1]! - v[a * 3 + 1]!) - (v[b * 3 + 1]! - v[a * 3 + 1]!) * (v[c * 3]! - v[a * 3]!);
    if (nz < 0) {
      tris[t + 1] = c;
      tris[t + 2] = b;
    }
  }
  return { vertices: v, triangles: tris };
}

/** Neighbour triangle per edge (v0-v1, v1-v2, v2-v0), or -1. Edges shared by >2 triangles are left unlinked. */
export function computeAdjacency(triangles: readonly NavTriangle[]): Array<[number, number, number]> {
  const edges = new Map<string, { tri: number; edge: number }[]>();
  const k = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  triangles.forEach((t, ti) => {
    for (let e = 0; e < 3; e++) {
      const key = k(t.v[e]!, t.v[(e + 1) % 3]!);
      if (!edges.has(key)) edges.set(key, []);
      edges.get(key)!.push({ tri: ti, edge: e });
    }
  });
  const out: Array<[number, number, number]> = triangles.map(() => [-1, -1, -1]);
  for (const list of edges.values()) {
    if (list.length !== 2) continue;
    const [a, b] = list as [{ tri: number; edge: number }, { tri: number; edge: number }];
    out[a.tri]![a.edge] = b.tri;
    out[b.tri]![b.edge] = a.tri;
  }
  return out;
}

export function boundsOf(vertices: readonly NavVertex[]): { min: NavVertex; max: NavVertex } {
  if (!vertices.length) return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  const min = { ...vertices[0]! };
  const max = { ...vertices[0]! };
  for (const v of vertices) {
    min.x = Math.min(min.x, v.x);
    min.y = Math.min(min.y, v.y);
    min.z = Math.min(min.z, v.z);
    max.x = Math.max(max.x, v.x);
    max.y = Math.max(max.y, v.y);
    max.z = Math.max(max.z, v.z);
  }
  return { min, max };
}

/** Rebuild the spatial lookup grid. */
export function buildGrid(nav: Navmesh, divisor = 1, order: 'yx' | 'xy' = 'yx'): void {
  const d = Math.max(1, Math.min(12, Math.floor(divisor)));
  const { min, max } = boundsOf(nav.vertices);
  const sizeX = Math.max((max.x - min.x) / d, 1e-3);
  const sizeY = Math.max((max.y - min.y) / d, 1e-3);
  const cells: number[][] = Array.from({ length: d * d }, () => []);
  nav.triangles.forEach((t, ti) => {
    const vs = t.v.map((i) => nav.vertices[i]!);
    const x0 = Math.min(...vs.map((v) => v.x));
    const x1 = Math.max(...vs.map((v) => v.x));
    const y0 = Math.min(...vs.map((v) => v.y));
    const y1 = Math.max(...vs.map((v) => v.y));
    const cx0 = Math.max(0, Math.min(d - 1, Math.floor((x0 - min.x) / sizeX)));
    const cx1 = Math.max(0, Math.min(d - 1, Math.floor((x1 - min.x) / sizeX)));
    const cy0 = Math.max(0, Math.min(d - 1, Math.floor((y0 - min.y) / sizeY)));
    const cy1 = Math.max(0, Math.min(d - 1, Math.floor((y1 - min.y) / sizeY)));
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) cells[order === 'yx' ? cy * d + cx : cx * d + cy]!.push(ti);
  });
  nav.grid = { divisor: d, sizeX, sizeY, min, max, cells };
}

/** Recompute adjacency for internal edges, keeping existing edge links (portals). */
export function relinkInternalEdges(nav: Navmesh): void {
  const adj = computeAdjacency(nav.triangles);
  const linkFlags = [NavTriFlags.Edge01Link, NavTriFlags.Edge12Link, NavTriFlags.Edge20Link];
  nav.triangles.forEach((t, ti) => {
    for (let e = 0; e < 3; e++) {
      if (t.flags & linkFlags[e]!) continue; // external edge link stays
      t.e[e] = adj[ti]![e]!;
    }
  });
}

export function createNavmesh(mesh: TriangleMesh, parent: NavmeshParent, opts: BuildOptions = {}): Navmesh {
  const welded = orientUp(weld(mesh, opts.weldTolerance ?? 1));
  const vertices: NavVertex[] = [];
  for (let i = 0; i < welded.vertices.length; i += 3) vertices.push({ x: welded.vertices[i]!, y: welded.vertices[i + 1]!, z: welded.vertices[i + 2]! });
  const triangles: NavTriangle[] = [];
  for (let t = 0; t < welded.triangles.length; t += 3) {
    triangles.push({ v: [welded.triangles[t]!, welded.triangles[t + 1]!, welded.triangles[t + 2]!], e: [-1, -1, -1], flags: 0, coverFlags: 0 });
  }
  if (vertices.length > 0xffff || triangles.length > 0x7fff) {
    throw new Error(`Navmesh too large (${vertices.length} vertices, ${triangles.length} triangles); split it across cells`);
  }
  const nav: Navmesh = {
    version: 12,
    crc: NAVMESH_PATHING_CELL_CRC,
    world: parent.world ?? 0,
    parent: parent.grid ? { gridX: parent.grid.x, gridY: parent.grid.y } : { cell: parent.cell ?? 0 },
    vertices,
    triangles,
    edgeLinks: [],
    doorLinks: [],
    coverTriangles: [],
    grid: { divisor: 1, sizeX: 0, sizeY: 0, min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 }, cells: [[]] },
  };
  relinkInternalEdges(nav);
  buildGrid(nav, opts.gridDivisor ?? 1, opts.gridOrder);
  return nav;
}

// ------------------------------------------------------------------ validation

export interface NavmeshIssue {
  severity: 'error' | 'warning';
  message: string;
  triangle?: number;
}

export function validateNavmesh(nav: Navmesh): NavmeshIssue[] {
  const issues: NavmeshIssue[] = [];
  const nv = nav.vertices.length;
  const linkFlags = [NavTriFlags.Edge01Link, NavTriFlags.Edge12Link, NavTriFlags.Edge20Link];
  nav.triangles.forEach((t, i) => {
    if (t.v.some((v) => v < 0 || v >= nv)) issues.push({ severity: 'error', message: 'vertex index out of range', triangle: i });
    if (new Set(t.v).size < 3) issues.push({ severity: 'error', message: 'degenerate triangle', triangle: i });
    for (let e = 0; e < 3; e++) {
      const n = t.e[e]!;
      if (t.flags & linkFlags[e]!) {
        if (n < 0 || n >= nav.edgeLinks.length) issues.push({ severity: 'error', message: `edge ${e} link index ${n} out of range`, triangle: i });
      } else if (n >= nav.triangles.length) {
        issues.push({ severity: 'error', message: `edge ${e} neighbour ${n} out of range`, triangle: i });
      } else if (n >= 0 && !nav.triangles[n]!.e.includes(i)) {
        issues.push({ severity: 'warning', message: `edge ${e} neighbour ${n} does not link back`, triangle: i });
      }
    }
  });
  const g = nav.grid;
  if (g.divisor < 1 || g.divisor > 12) issues.push({ severity: 'error', message: `grid divisor ${g.divisor} must be 1-12` });
  if (g.cells.length !== g.divisor * g.divisor) issues.push({ severity: 'error', message: 'grid cell count does not match divisor' });
  const inGrid = new Set(g.cells.flat());
  nav.triangles.forEach((_, i) => {
    if (!inGrid.has(i)) issues.push({ severity: 'error', message: 'triangle missing from grid', triangle: i });
  });
  nav.doorLinks.forEach((d) => {
    if (d.triangle < 0 || d.triangle >= nav.triangles.length) issues.push({ severity: 'error', message: 'door link triangle out of range' });
  });
  // Islands (disconnected pieces) are legal but usually a mistake.
  const islands = countIslands(nav);
  if (islands > 1) issues.push({ severity: 'warning', message: `navmesh has ${islands} disconnected islands` });
  return issues;
}

export function countIslands(nav: Navmesh): number {
  const seen = new Uint8Array(nav.triangles.length);
  const linkFlags = [NavTriFlags.Edge01Link, NavTriFlags.Edge12Link, NavTriFlags.Edge20Link];
  let islands = 0;
  for (let i = 0; i < nav.triangles.length; i++) {
    if (seen[i]) continue;
    islands++;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const t = nav.triangles[stack.pop()!]!;
      t.e.forEach((n, e) => {
        if (t.flags & linkFlags[e]!) return;
        if (n >= 0 && n < seen.length && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      });
    }
  }
  return islands;
}

// ------------------------------------------------------------------ editing

/** Remove triangles (and unused vertices), fixing every index. */
export function deleteTriangles(nav: Navmesh, remove: Iterable<number>): void {
  const drop = new Set(remove);
  const triMap: number[] = [];
  const kept: NavTriangle[] = [];
  nav.triangles.forEach((t, i) => {
    if (drop.has(i)) triMap.push(-1);
    else {
      triMap.push(kept.length);
      kept.push(t);
    }
  });
  const linkFlags = [NavTriFlags.Edge01Link, NavTriFlags.Edge12Link, NavTriFlags.Edge20Link];
  for (const t of kept) {
    for (let e = 0; e < 3; e++) if (!(t.flags & linkFlags[e]!) && t.e[e]! >= 0) t.e[e] = triMap[t.e[e]!]!;
  }
  nav.triangles = kept;
  nav.doorLinks = nav.doorLinks.filter((d) => triMap[d.triangle]! >= 0).map((d) => ({ ...d, triangle: triMap[d.triangle]! }));
  nav.coverTriangles = nav.coverTriangles.filter((c) => triMap[c]! >= 0).map((c) => triMap[c]!);
  // drop unused vertices
  const used = new Set(kept.flatMap((t) => t.v));
  const vMap: number[] = [];
  const verts: NavVertex[] = [];
  nav.vertices.forEach((v, i) => {
    if (used.has(i)) {
      vMap.push(verts.length);
      verts.push(v);
    } else vMap.push(-1);
  });
  for (const t of kept) t.v = [vMap[t.v[0]]!, vMap[t.v[1]]!, vMap[t.v[2]]!];
  nav.vertices = verts;
  buildGrid(nav, nav.grid.divisor);
}

/** Append a triangle from three positions (welding to existing vertices). Returns its index. */
export function addTriangle(nav: Navmesh, a: NavVertex, b: NavVertex, c: NavVertex, tolerance = 1): number {
  const idx = (p: NavVertex) => {
    const i = nav.vertices.findIndex((v) => Math.hypot(v.x - p.x, v.y - p.y, v.z - p.z) <= tolerance);
    if (i >= 0) return i;
    nav.vertices.push({ ...p });
    return nav.vertices.length - 1;
  };
  const tri: NavTriangle = { v: [idx(a), idx(b), idx(c)], e: [-1, -1, -1], flags: 0, coverFlags: 0 };
  const nz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (nz < 0) tri.v = [tri.v[0], tri.v[2], tri.v[1]];
  nav.triangles.push(tri);
  relinkInternalEdges(nav);
  buildGrid(nav, nav.grid.divisor);
  return nav.triangles.length - 1;
}

/** Set or clear triangle flags (water, preferred, no large creatures...). */
export function setTriangleFlags(nav: Navmesh, tris: Iterable<number>, flag: number, on: boolean): void {
  for (const i of tris) {
    const t = nav.triangles[i];
    if (t) t.flags = on ? t.flags | flag : t.flags & ~flag;
  }
}

/** Horizontal distance from a point to a triangle (0 when inside). */
function distanceToTriangle2D(p: NavVertex, a: NavVertex, b: NavVertex, c: NavVertex): number {
  const seg = (u: NavVertex, v: NavVertex) => {
    const dx = v.x - u.x;
    const dy = v.y - u.y;
    const len2 = dx * dx + dy * dy || 1e-12;
    const t = Math.max(0, Math.min(1, ((p.x - u.x) * dx + (p.y - u.y) * dy) / len2));
    return Math.hypot(p.x - (u.x + t * dx), p.y - (u.y + t * dy));
  };
  const s1 = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const s2 = (c.x - b.x) * (p.y - b.y) - (c.y - b.y) * (p.x - b.x);
  const s3 = (a.x - c.x) * (p.y - c.y) - (a.y - c.y) * (p.x - c.x);
  if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return 0;
  return Math.min(seg(a, b), seg(b, c), seg(c, a));
}

/** Nearest triangle within `maxDistance` horizontally and `maxDz` vertically, or -1. */
export function findNearestTriangle(nav: Navmesh, p: NavVertex, maxDistance = 128, maxDz = 64): number {
  const inside = findTriangleAt(nav, p);
  if (inside >= 0) return inside;
  let best = -1;
  let bestD = maxDistance;
  nav.triangles.forEach((t, i) => {
    const [a, b, c] = t.v.map((k) => nav.vertices[k]!) as [NavVertex, NavVertex, NavVertex];
    const d = distanceToTriangle2D(p, a, b, c);
    const z = (a.z + b.z + c.z) / 3;
    if (d < bestD && Math.abs(z - p.z) <= maxDz) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** Index of the triangle containing (x, y) in plan view, preferring the one closest in Z. */
export function findTriangleAt(nav: Navmesh, p: NavVertex): number {
  let best = -1;
  let bestDz = Infinity;
  nav.triangles.forEach((t, i) => {
    const [a, b, c] = t.v.map((k) => nav.vertices[k]!) as [NavVertex, NavVertex, NavVertex];
    const d = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(d) < 1e-9) return;
    const l1 = ((b.y - c.y) * (p.x - c.x) + (c.x - b.x) * (p.y - c.y)) / d;
    const l2 = ((c.y - a.y) * (p.x - c.x) + (a.x - c.x) * (p.y - c.y)) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) return;
    const z = l1 * a.z + l2 * b.z + l3 * c.z;
    const dz = Math.abs(z - p.z);
    if (dz < bestDz) {
      bestDz = dz;
      best = i;
    }
  });
  return best;
}
