/**
 * NVNM — navmesh geometry (Skyrim, version 12). Layout per xEdit's wbNVNM.
 */
import type { BinaryReader, BinaryWriter } from '../binary';
import type { CodecContext, CustomCodec } from './types';

export const NAVMESH_PATHING_CELL_CRC = 0xa5e9a03c;
export const NAVMESH_PATHING_DOOR_CRC = 0xe48b73f3;

export const NavTriFlags = {
  Edge01Link: 0x0001,
  Edge12Link: 0x0002,
  Edge20Link: 0x0004,
  Deleted: 0x0008,
  NoLargeCreatures: 0x0010,
  Overlapping: 0x0020,
  Preferred: 0x0040,
  Water: 0x0200,
  Door: 0x0400,
  Found: 0x0800,
} as const;

export interface NavVertex {
  x: number;
  y: number;
  z: number;
}

export interface NavTriangle {
  /** Vertex indices. */
  v: [number, number, number];
  /**
   * Per edge (0-1, 1-2, 2-0): index of the neighbouring triangle in this mesh,
   * or of an edge link when the matching EdgeXXLink flag is set, or -1.
   */
  e: [number, number, number];
  flags: number;
  coverFlags: number;
}

export interface NavEdgeLink {
  /** 0 Portal, 1 Ledge Up, 2 Ledge Down, 3 Enable/Disable Portal. */
  type: number;
  navmesh: unknown;
  triangle: number;
}

export interface NavDoorLink {
  triangle: number;
  crc: number;
  door: unknown;
}

export interface NavGrid {
  divisor: number;
  sizeX: number;
  sizeY: number;
  min: NavVertex;
  max: NavVertex;
  /** divisor × divisor cells, each a list of triangle indices. */
  cells: number[][];
}

export interface Navmesh {
  version: number;
  crc: number;
  /** Worldspace (exterior navmeshes) or null/0. */
  world: unknown;
  /** Interior: parent cell FormID. Exterior: grid coordinates. */
  parent: { cell: unknown } | { gridX: number; gridY: number };
  vertices: NavVertex[];
  triangles: NavTriangle[];
  edgeLinks: NavEdgeLink[];
  doorLinks: NavDoorLink[];
  coverTriangles: number[];
  grid: NavGrid;
  tail?: Uint8Array;
}

function isNullForm(v: unknown): boolean {
  return v === 0 || v === null || v === undefined || v === '';
}

export function readNavmesh(r: BinaryReader, end: number, ctx: CodecContext): Navmesh {
  const map = (id: number) => (ctx.mapFormId ? ctx.mapFormId(id) : id);
  const version = r.u32();
  const crc = r.u32();
  const worldRaw = r.u32();
  let parent: Navmesh['parent'];
  if (worldRaw === 0) {
    parent = { cell: map(r.u32()) };
  } else {
    const gridY = r.i16();
    const gridX = r.i16();
    parent = { gridX, gridY };
  }
  const vcount = r.u32();
  const vertices: NavVertex[] = [];
  for (let i = 0; i < vcount; i++) vertices.push({ x: r.f32(), y: r.f32(), z: r.f32() });
  const tcount = r.u32();
  const triangles: NavTriangle[] = [];
  for (let i = 0; i < tcount; i++) {
    const v: [number, number, number] = [r.u16(), r.u16(), r.u16()];
    const e: [number, number, number] = [r.i16(), r.i16(), r.i16()];
    triangles.push({ v, e, flags: r.u16(), coverFlags: r.u16() });
  }
  const ecount = r.u32();
  const edgeLinks: NavEdgeLink[] = [];
  for (let i = 0; i < ecount; i++) edgeLinks.push({ type: r.u32(), navmesh: map(r.u32()), triangle: r.i16() });
  const dcount = r.u32();
  const doorLinks: NavDoorLink[] = [];
  for (let i = 0; i < dcount; i++) doorLinks.push({ triangle: r.i16(), crc: r.u32(), door: map(r.u32()) });
  const ccount = r.u32();
  const coverTriangles: number[] = [];
  for (let i = 0; i < ccount; i++) coverTriangles.push(r.i16());
  const divisor = r.u32();
  const sizeX = r.f32();
  const sizeY = r.f32();
  const min = { x: r.f32(), y: r.f32(), z: r.f32() };
  const max = { x: r.f32(), y: r.f32(), z: r.f32() };
  const cells: number[][] = [];
  const n = divisor >= 0 && divisor <= 12 ? divisor * divisor : 0;
  for (let i = 0; i < n; i++) {
    const c = r.u32();
    const list: number[] = [];
    for (let j = 0; j < c; j++) list.push(r.i16());
    cells.push(list);
  }
  const nav: Navmesh = {
    version,
    crc,
    world: map(worldRaw),
    parent,
    vertices,
    triangles,
    edgeLinks,
    doorLinks,
    coverTriangles,
    grid: { divisor, sizeX, sizeY, min, max, cells },
  };
  if (r.pos < end) nav.tail = r.bytesView(end - r.pos).slice();
  return nav;
}

export function writeNavmesh(w: BinaryWriter, nav: Navmesh, ctx: CodecContext): void {
  const unmap = (v: unknown) => (ctx.unmapFormId ? ctx.unmapFormId(v) : Number(v ?? 0));
  w.u32(nav.version).u32(nav.crc);
  const worldId = isNullForm(nav.world) ? 0 : unmap(nav.world);
  w.u32(worldId);
  if ('cell' in nav.parent) {
    w.u32(unmap(nav.parent.cell));
  } else {
    w.i16(nav.parent.gridY).i16(nav.parent.gridX);
  }
  w.u32(nav.vertices.length);
  for (const v of nav.vertices) w.f32(v.x).f32(v.y).f32(v.z);
  w.u32(nav.triangles.length);
  for (const t of nav.triangles) {
    w.u16(t.v[0]).u16(t.v[1]).u16(t.v[2]);
    w.i16(t.e[0]).i16(t.e[1]).i16(t.e[2]);
    w.u16(t.flags).u16(t.coverFlags);
  }
  w.u32(nav.edgeLinks.length);
  for (const l of nav.edgeLinks) w.u32(l.type).u32(unmap(l.navmesh)).i16(l.triangle);
  w.u32(nav.doorLinks.length);
  for (const d of nav.doorLinks) w.i16(d.triangle).u32(d.crc).u32(unmap(d.door));
  w.u32(nav.coverTriangles.length);
  for (const c of nav.coverTriangles) w.i16(c);
  const g = nav.grid;
  w.u32(g.divisor).f32(g.sizeX).f32(g.sizeY);
  w.f32(g.min.x).f32(g.min.y).f32(g.min.z).f32(g.max.x).f32(g.max.y).f32(g.max.z);
  for (const cell of g.cells) {
    w.u32(cell.length);
    for (const t of cell) w.i16(t);
  }
  if (nav.tail) w.bytes(nav.tail);
}

export const nvnmCodec: CustomCodec<Navmesh> = {
  decode(r, size, ctx) {
    return readNavmesh(r, r.pos + size, ctx);
  },
  encode(w, v, ctx) {
    writeNavmesh(w, v, ctx);
  },
  describe(v) {
    return `${v.vertices.length} vertices, ${v.triangles.length} triangles`;
  },
};
