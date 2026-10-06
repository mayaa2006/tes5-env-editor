/**
 * Navmesh info map (NAVI/NVMI). The game uses one NVMI entry per navmesh for
 * long-distance pathing (which navmeshes connect, which doors lead where).
 * The Creation Kit rebuilds these on save; so does this editor.
 */
import { BinaryReader, BinaryWriter, NAVMESH_PATHING_CELL_CRC, NavTriFlags, type CodecContext, type CustomCodec, type Navmesh } from '@tes5/esp';
import { boundsOf } from './build';

export interface NavmeshInfo {
  navmesh: unknown;
  flags: number;
  approxLocation: { x: number; y: number; z: number };
  preferredPercent: number;
  edgeLinks: unknown[];
  preferredEdgeLinks: unknown[];
  doorLinks: { crc: number; door: unknown }[];
  island?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number }; triangles: [number, number, number][]; vertices: { x: number; y: number; z: number }[] };
  pathingCell: { crc: number; world: unknown; parent: { cell: unknown } | { gridX: number; gridY: number } };
  tail?: Uint8Array;
}

export const NVMI_FLAGS = { IsIsland: 1 << 5, NotEdited: 1 << 6 } as const;

export function readNavmeshInfo(r: BinaryReader, end: number, ctx: CodecContext): NavmeshInfo {
  const map = (id: number) => (ctx.mapFormId ? ctx.mapFormId(id) : id);
  const navmesh = map(r.u32());
  const flags = r.u32();
  const approxLocation = { x: r.f32(), y: r.f32(), z: r.f32() };
  const preferredPercent = r.f32();
  const list = () => {
    const n = r.u32();
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) out.push(map(r.u32()));
    return out;
  };
  const edgeLinks = list();
  const preferredEdgeLinks = list();
  const dn = r.u32();
  const doorLinks: NavmeshInfo['doorLinks'] = [];
  for (let i = 0; i < dn; i++) doorLinks.push({ crc: r.u32(), door: map(r.u32()) });
  const info: NavmeshInfo = { navmesh, flags, approxLocation, preferredPercent, edgeLinks, preferredEdgeLinks, doorLinks, pathingCell: { crc: 0, world: 0, parent: { cell: 0 } } };
  const hasIsland = r.u8() !== 0;
  if (hasIsland) {
    const min = { x: r.f32(), y: r.f32(), z: r.f32() };
    const max = { x: r.f32(), y: r.f32(), z: r.f32() };
    const tn = r.u32();
    const triangles: [number, number, number][] = [];
    for (let i = 0; i < tn; i++) triangles.push([r.u16(), r.u16(), r.u16()]);
    const vn = r.u32();
    const vertices: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < vn; i++) vertices.push({ x: r.f32(), y: r.f32(), z: r.f32() });
    info.island = { min, max, triangles, vertices };
  }
  const crc = r.u32();
  const worldRaw = r.u32();
  const world = map(worldRaw);
  const parent = worldRaw === 0 ? { cell: map(r.u32()) } : (() => {
    const gridY = r.i16();
    const gridX = r.i16();
    return { gridX, gridY };
  })();
  info.pathingCell = { crc, world, parent };
  if (r.pos < end) info.tail = r.bytesView(end - r.pos).slice();
  return info;
}

export function writeNavmeshInfo(w: BinaryWriter, info: NavmeshInfo, ctx: CodecContext): void {
  const unmap = (v: unknown) => (ctx.unmapFormId ? ctx.unmapFormId(v) : Number(v ?? 0));
  w.u32(unmap(info.navmesh)).u32(info.flags);
  w.f32(info.approxLocation.x).f32(info.approxLocation.y).f32(info.approxLocation.z).f32(info.preferredPercent);
  w.u32(info.edgeLinks.length);
  for (const e of info.edgeLinks) w.u32(unmap(e));
  w.u32(info.preferredEdgeLinks.length);
  for (const e of info.preferredEdgeLinks) w.u32(unmap(e));
  w.u32(info.doorLinks.length);
  for (const d of info.doorLinks) w.u32(d.crc).u32(unmap(d.door));
  if (info.island) {
    w.u8(1);
    const i = info.island;
    w.f32(i.min.x).f32(i.min.y).f32(i.min.z).f32(i.max.x).f32(i.max.y).f32(i.max.z);
    w.u32(i.triangles.length);
    for (const t of i.triangles) w.u16(t[0]).u16(t[1]).u16(t[2]);
    w.u32(i.vertices.length);
    for (const v of i.vertices) w.f32(v.x).f32(v.y).f32(v.z);
  } else w.u8(0);
  w.u32(info.pathingCell.crc);
  const worldId = info.pathingCell.world === 0 || info.pathingCell.world === null || info.pathingCell.world === undefined ? 0 : unmap(info.pathingCell.world);
  w.u32(worldId);
  const p = info.pathingCell.parent;
  if ('cell' in p) w.u32(unmap(p.cell));
  else w.i16(p.gridY).i16(p.gridX);
  if (info.tail) w.bytes(info.tail);
}

export const nvmiCodec: CustomCodec<NavmeshInfo> = {
  decode(r, size, ctx) {
    return readNavmeshInfo(r, r.pos + size, ctx);
  },
  encode(w, v, ctx) {
    writeNavmeshInfo(w, v, ctx);
  },
  describe(v) {
    return `${v.edgeLinks.length} edge links, ${v.doorLinks.length} doors`;
  },
};

/** Build the NVMI entry for a navmesh from its geometry and links. */
export function buildNavmeshInfo(navmeshId: unknown, nav: Navmesh): NavmeshInfo {
  const { min, max } = boundsOf(nav.vertices);
  const preferred = nav.triangles.filter((t) => t.flags & NavTriFlags.Preferred).length;
  const linked = [...new Set(nav.edgeLinks.map((l) => l.navmesh))];
  const preferredLinked = [
    ...new Set(
      nav.triangles.flatMap((t) =>
        [0, 1, 2]
          .filter((e) => t.flags & [NavTriFlags.Edge01Link, NavTriFlags.Edge12Link, NavTriFlags.Edge20Link][e]! && t.flags & NavTriFlags.Preferred)
          .map((e) => nav.edgeLinks[t.e[e]!]?.navmesh),
      ),
    ),
  ].filter((x) => x !== undefined);
  return {
    navmesh: navmeshId,
    flags: 0,
    approxLocation: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
    preferredPercent: nav.triangles.length ? preferred / nav.triangles.length : 0,
    edgeLinks: linked,
    preferredEdgeLinks: preferredLinked,
    doorLinks: nav.doorLinks.map((d) => ({ crc: d.crc, door: d.door })),
    pathingCell: { crc: NAVMESH_PATHING_CELL_CRC, world: nav.world, parent: nav.parent },
  };
}

export function encodeNavmeshInfo(info: NavmeshInfo, ctx: Partial<CodecContext> = {}): Uint8Array {
  const w = new BinaryWriter(128);
  writeNavmeshInfo(w, info, { localized: false, recordSig: 'NAVI', formVersion: 44, ...ctx });
  return w.toBytes();
}

export function decodeNavmeshInfo(data: Uint8Array, ctx: Partial<CodecContext> = {}): NavmeshInfo {
  const r = new BinaryReader(data);
  return readNavmeshInfo(r, data.byteLength, { localized: false, recordSig: 'NAVI', formVersion: 44, ...ctx });
}
