/**
 * Automatic navmesh generation from world geometry using Recast (WASM).
 * Skyrim is Z-up; Recast is Y-up. The mapping (x, y, z) → (x, z, -y) is a
 * proper rotation, so triangle winding (and therefore "which side is up") is
 * preserved.
 */
import type { TriangleMesh } from './build';

export interface GenerateSettings {
  /** Horizontal voxel size in Skyrim units. Smaller = more detail, slower. */
  cellSize: number;
  /** Vertical voxel size in Skyrim units. */
  cellHeight: number;
  /** Max walkable slope in degrees. */
  maxSlope: number;
  /** Actor height in units (player ≈ 128). */
  agentHeight: number;
  /** Max step height in units (stairs). */
  agentClimb: number;
  /** Clearance from walls in units. */
  agentRadius: number;
  /** Max edge length in units before splitting. */
  maxEdgeLength: number;
  /** Contour simplification error in units (bigger = fewer triangles). */
  maxSimplificationError: number;
  /** Discard regions smaller than this many square units. */
  minRegionArea: number;
  /** Clip output to these bounds (exterior cells: the 4096×4096 cell square). */
  clip?: { minX: number; minY: number; maxX: number; maxY: number };
}

/** Presets roughly matching what the Creation Kit produces for humanoid actors. */
export const NAVMESH_PRESETS: Record<'interior' | 'exterior' | 'detailed', GenerateSettings> = {
  interior: { cellSize: 8, cellHeight: 4, maxSlope: 45, agentHeight: 120, agentClimb: 40, agentRadius: 20, maxEdgeLength: 512, maxSimplificationError: 12, minRegionArea: 64 * 64 },
  exterior: { cellSize: 16, cellHeight: 8, maxSlope: 45, agentHeight: 120, agentClimb: 48, agentRadius: 24, maxEdgeLength: 1024, maxSimplificationError: 24, minRegionArea: 128 * 128 },
  detailed: { cellSize: 4, cellHeight: 2, maxSlope: 45, agentHeight: 120, agentClimb: 40, agentRadius: 16, maxEdgeLength: 256, maxSimplificationError: 6, minRegionArea: 32 * 32 },
};

export interface GenerateResult {
  mesh: TriangleMesh;
  /** Diagnostic message when generation failed. */
  error?: string;
}

let recastReady: Promise<typeof import('recast-navigation')> | undefined;

async function recast() {
  if (!recastReady) {
    recastReady = import('recast-navigation').then(async (m) => {
      await m.init();
      return m;
    });
  }
  return recastReady;
}

export function toRecast(v: ArrayLike<number>): Float32Array {
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 3) {
    out[i] = v[i]!;
    out[i + 1] = v[i + 2]!;
    out[i + 2] = -v[i + 1]!;
  }
  return out;
}

export function fromRecast(v: ArrayLike<number>): number[] {
  const out: number[] = new Array(v.length);
  for (let i = 0; i < v.length; i += 3) {
    out[i] = v[i]!;
    out[i + 1] = -v[i + 2]!;
    out[i + 2] = v[i + 1]!;
  }
  return out;
}

/**
 * Generate a walkable triangle mesh from collision/render geometry.
 * `geometry` is world-space triangles (Skyrim coordinates), upward faces CCW.
 */
export async function generateWalkableMesh(geometry: TriangleMesh, settings: GenerateSettings): Promise<GenerateResult> {
  const m = await recast();
  const { generateSoloNavMesh } = await import('recast-navigation/generators');
  const cs = settings.cellSize;
  const ch = settings.cellHeight;
  const positions = toRecast(geometry.vertices);
  const indices = Uint32Array.from(geometry.triangles);
  const res = generateSoloNavMesh(positions, indices, {
    cs,
    ch,
    walkableSlopeAngle: settings.maxSlope,
    walkableHeight: Math.max(3, Math.ceil(settings.agentHeight / ch)),
    walkableClimb: Math.floor(settings.agentClimb / ch),
    walkableRadius: Math.ceil(settings.agentRadius / cs),
    maxEdgeLen: Math.floor(settings.maxEdgeLength / cs),
    maxSimplificationError: settings.maxSimplificationError / cs,
    minRegionArea: Math.max(1, Math.floor(settings.minRegionArea / (cs * cs))),
    mergeRegionArea: Math.max(1, Math.floor((settings.minRegionArea * 4) / (cs * cs))),
    maxVertsPerPoly: 3,
    // Note: detailSampleDist 0 ("no detail sampling") crashes the WASM build; sample coarsely instead.
    detailSampleDist: cs * 6,
    detailSampleMaxError: ch,
  });
  if (!res.success) return { mesh: { vertices: [], triangles: [] }, error: res.error ?? 'Recast failed' };
  const [pos, idx] = m.getNavMeshPositionsAndIndices(res.navMesh);
  res.navMesh.destroy();
  let mesh: TriangleMesh = { vertices: fromRecast(pos), triangles: Array.from(idx) };
  if (settings.clip) mesh = clipToRect(mesh, settings.clip);
  return { mesh };
}

/** Keep triangles whose centroid lies inside the rectangle (cell ownership). */
export function clipToRect(mesh: TriangleMesh, r: { minX: number; minY: number; maxX: number; maxY: number }): TriangleMesh {
  const v = mesh.vertices;
  const tris: number[] = [];
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const [a, b, c] = [mesh.triangles[t]!, mesh.triangles[t + 1]!, mesh.triangles[t + 2]!];
    const cx = (v[a * 3]! + v[b * 3]! + v[c * 3]!) / 3;
    const cy = (v[a * 3 + 1]! + v[b * 3 + 1]! + v[c * 3 + 1]!) / 3;
    if (cx >= r.minX && cx < r.maxX && cy >= r.minY && cy < r.maxY) tris.push(a, b, c);
  }
  return { vertices: v, triangles: tris };
}

/**
 * Fallback generator without Recast: keeps up-facing triangles under the
 * slope limit. Produces dense meshes and ignores clearance, but works on any
 * geometry instantly (useful for simple interiors and previews).
 */
export function walkableTriangles(geometry: TriangleMesh, maxSlope = 45): TriangleMesh {
  const cos = Math.cos((maxSlope * Math.PI) / 180);
  const v = geometry.vertices;
  const tris: number[] = [];
  for (let t = 0; t < geometry.triangles.length; t += 3) {
    const a = geometry.triangles[t]!;
    const b = geometry.triangles[t + 1]!;
    const c = geometry.triangles[t + 2]!;
    const ux = v[b * 3]! - v[a * 3]!;
    const uy = v[b * 3 + 1]! - v[a * 3 + 1]!;
    const uz = v[b * 3 + 2]! - v[a * 3 + 2]!;
    const wx = v[c * 3]! - v[a * 3]!;
    const wy = v[c * 3 + 1]! - v[a * 3 + 1]!;
    const wz = v[c * 3 + 2]! - v[a * 3 + 2]!;
    const nx = uy * wz - uz * wy;
    const ny = uz * wx - ux * wz;
    const nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue;
    if (nz / len >= cos) tris.push(a, b, c);
  }
  return { vertices: v, triangles: tris };
}
