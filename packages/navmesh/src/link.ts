/**
 * Connecting navmeshes: portal edge links across cell borders and door links.
 * In the Creation Kit these are created by "Finalize Navmesh"; here they are
 * recomputed automatically whenever a navmesh is saved.
 */
import { NAVMESH_PATHING_DOOR_CRC, NavTriFlags, type NavVertex, type Navmesh } from '@tes5/esp';
import { findNearestTriangle } from './build';

const EDGE_FLAGS = [NavTriFlags.Edge01Link, NavTriFlags.Edge12Link, NavTriFlags.Edge20Link] as const;

export interface LinkableNavmesh {
  /** Identifier written into the other navmesh's edge links (FormID/FormKey). */
  id: unknown;
  nav: Navmesh;
}

function boundaryEdges(nav: Navmesh): { tri: number; edge: number; a: NavVertex; b: NavVertex }[] {
  const out: { tri: number; edge: number; a: NavVertex; b: NavVertex }[] = [];
  nav.triangles.forEach((t, ti) => {
    for (let e = 0; e < 3; e++) {
      if (t.e[e] !== -1 && !(t.flags & EDGE_FLAGS[e]!)) continue;
      out.push({ tri: ti, edge: e, a: nav.vertices[t.v[e]!]!, b: nav.vertices[t.v[(e + 1) % 3]!]! });
    }
  });
  return out;
}

function close(p: NavVertex, q: NavVertex, tol: number, zTol: number): boolean {
  return Math.abs(p.x - q.x) <= tol && Math.abs(p.y - q.y) <= tol && Math.abs(p.z - q.z) <= zTol;
}

/** Remove all portal links that point at `otherId` (before relinking). */
export function unlinkFrom(nav: Navmesh, otherId: unknown): void {
  const removed = new Set<number>();
  nav.edgeLinks.forEach((l, i) => {
    if (l.navmesh === otherId) removed.add(i);
  });
  if (!removed.size) return;
  const remap: number[] = [];
  let k = 0;
  nav.edgeLinks.forEach((_, i) => remap.push(removed.has(i) ? -1 : k++));
  nav.edgeLinks = nav.edgeLinks.filter((_, i) => !removed.has(i));
  for (const t of nav.triangles) {
    for (let e = 0; e < 3; e++) {
      if (!(t.flags & EDGE_FLAGS[e]!)) continue;
      const ni = remap[t.e[e]!] ?? -1;
      if (ni < 0) {
        t.flags &= ~EDGE_FLAGS[e]!;
        t.e[e] = -1;
      } else t.e[e] = ni;
    }
  }
}

/**
 * Create portal links between open edges of two navmeshes that coincide
 * (same endpoints within tolerance, in either direction). Returns the number
 * of edge pairs linked.
 */
export function linkNavmeshes(a: LinkableNavmesh, b: LinkableNavmesh, tolerance = 2, zTolerance = 16): number {
  unlinkFrom(a.nav, b.id);
  unlinkFrom(b.nav, a.id);
  const ea = boundaryEdges(a.nav).filter((x) => !(a.nav.triangles[x.tri]!.flags & EDGE_FLAGS[x.edge]!));
  const eb = boundaryEdges(b.nav).filter((x) => !(b.nav.triangles[x.tri]!.flags & EDGE_FLAGS[x.edge]!));
  let linked = 0;
  const usedB = new Set<number>();
  for (const x of ea) {
    const j = eb.findIndex((y, i) => !usedB.has(i) && ((close(x.a, y.b, tolerance, zTolerance) && close(x.b, y.a, tolerance, zTolerance)) || (close(x.a, y.a, tolerance, zTolerance) && close(x.b, y.b, tolerance, zTolerance))));
    if (j < 0) continue;
    usedB.add(j);
    const y = eb[j]!;
    const ta = a.nav.triangles[x.tri]!;
    const tb = b.nav.triangles[y.tri]!;
    a.nav.edgeLinks.push({ type: 0, navmesh: b.id, triangle: y.tri });
    ta.e[x.edge] = a.nav.edgeLinks.length - 1;
    ta.flags |= EDGE_FLAGS[x.edge]!;
    b.nav.edgeLinks.push({ type: 0, navmesh: a.id, triangle: x.tri });
    tb.e[y.edge] = b.nav.edgeLinks.length - 1;
    tb.flags |= EDGE_FLAGS[y.edge]!;
    linked++;
  }
  return linked;
}

/**
 * Snap open edges that lie on a cell border exactly onto it, so neighbouring
 * cells' navmeshes meet (exterior cells are 4096 units).
 */
export function snapToCellBorder(nav: Navmesh, grid: { x: number; y: number }, tolerance = 32, cellSize = 4096): number {
  const minX = grid.x * cellSize;
  const minY = grid.y * cellSize;
  const maxX = minX + cellSize;
  const maxY = minY + cellSize;
  let moved = 0;
  const onEdge = new Set<number>();
  for (const e of boundaryEdges(nav)) {
    const t = nav.triangles[e.tri]!;
    onEdge.add(t.v[e.edge]!);
    onEdge.add(t.v[(e.edge + 1) % 3]!);
  }
  for (const i of onEdge) {
    const v = nav.vertices[i]!;
    for (const [axis, border] of [['x', minX], ['x', maxX], ['y', minY], ['y', maxY]] as const) {
      if (Math.abs(v[axis] - border) <= tolerance && v[axis] !== border) {
        v[axis] = border;
        moved++;
      }
    }
  }
  return moved;
}

export interface DoorPlacement {
  /** Door reference (FormID/FormKey) written into the door link. */
  ref: unknown;
  position: NavVertex;
}

/**
 * Link door references to the triangle under (or, since navmeshes stop short
 * of walls, nearest in front of) them and flag that triangle.
 */
export function linkDoors(nav: Navmesh, doors: readonly DoorPlacement[], maxDistance = 160): number {
  nav.doorLinks = [];
  for (const t of nav.triangles) t.flags &= ~NavTriFlags.Door;
  let n = 0;
  for (const d of doors) {
    const tri = findNearestTriangle(nav, d.position, maxDistance);
    if (tri < 0) continue;
    nav.doorLinks.push({ triangle: tri, crc: NAVMESH_PATHING_DOOR_CRC, door: d.ref });
    nav.triangles[tri]!.flags |= NavTriFlags.Door;
    n++;
  }
  nav.doorLinks.sort((x, y) => x.triangle - y.triangle);
  return n;
}
