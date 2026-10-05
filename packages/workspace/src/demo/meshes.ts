/** Procedural meshes for the demo data set (and editor gizmos/markers). */
import type { WriteShape } from '@tes5/assets';

export interface MeshData {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

function empty(): MeshData {
  return { positions: [], normals: [], uvs: [], indices: [] };
}

export function merge(...parts: MeshData[]): MeshData {
  const out = empty();
  for (const p of parts) {
    const base = out.positions.length / 3;
    out.positions.push(...p.positions);
    out.normals.push(...p.normals);
    out.uvs.push(...p.uvs);
    out.indices.push(...p.indices.map((i) => i + base));
  }
  return out;
}

export function translate(m: MeshData, x: number, y: number, z: number): MeshData {
  const positions = m.positions.slice();
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] += x;
    positions[i + 1] += y;
    positions[i + 2] += z;
  }
  return { ...m, positions };
}

/** Axis-aligned box from (x0,y0,z0) to (x1,y1,z1); faces wound counter-clockwise from outside. */
export function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, uvScale = 1 / 128): MeshData {
  const m = empty();
  const face = (corners: number[][], n: number[], uAxis: number, vAxis: number) => {
    const base = m.positions.length / 3;
    for (const c of corners) {
      m.positions.push(c[0]!, c[1]!, c[2]!);
      m.normals.push(n[0]!, n[1]!, n[2]!);
      m.uvs.push(c[uAxis]! * uvScale, c[vAxis]! * uvScale);
    }
    m.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], 0, 1); // top
  face([[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]], [0, 0, -1], 0, 1); // bottom
  face([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], 0, 2); // front (-y)
  face([[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]], [0, 1, 0], 0, 2); // back (+y)
  face([[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]], [-1, 0, 0], 1, 2); // left
  face([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0], 1, 2); // right
  return m;
}

export function cylinder(radius: number, height: number, segments = 16, z0 = 0): MeshData {
  const m = empty();
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const x = Math.cos(a) * radius;
    const y = Math.sin(a) * radius;
    m.positions.push(x, y, z0, x, y, z0 + height);
    m.normals.push(Math.cos(a), Math.sin(a), 0, Math.cos(a), Math.sin(a), 0);
    m.uvs.push(i / segments, 1, i / segments, 0);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    m.indices.push(a, a + 2, a + 3, a, a + 3, a + 1);
  }
  const cap = (z: number, up: boolean) => {
    const center = m.positions.length / 3;
    m.positions.push(0, 0, z);
    m.normals.push(0, 0, up ? 1 : -1);
    m.uvs.push(0.5, 0.5);
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      m.positions.push(Math.cos(a) * radius, Math.sin(a) * radius, z);
      m.normals.push(0, 0, up ? 1 : -1);
      m.uvs.push(0.5 + Math.cos(a) / 2, 0.5 + Math.sin(a) / 2);
    }
    for (let i = 0; i < segments; i++) {
      if (up) m.indices.push(center, center + 1 + i, center + 2 + i);
      else m.indices.push(center, center + 2 + i, center + 1 + i);
    }
  };
  cap(z0 + height, true);
  cap(z0, false);
  return m;
}

/** UV sphere scaled by (sx, sy, sz), centred at (0, 0, cz). */
export function ellipsoid(sx: number, sy: number, sz: number, cz = 0, rings = 16, segments = 24): MeshData {
  const m = empty();
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    for (let s = 0; s <= segments; s++) {
      const th = (s / segments) * Math.PI * 2;
      const nx = Math.sin(phi) * Math.cos(th);
      const ny = Math.sin(phi) * Math.sin(th);
      const nz = Math.cos(phi);
      m.positions.push(nx * sx, ny * sy, cz + nz * sz);
      const l = Math.hypot(nx / sx, ny / sy, nz / sz) || 1;
      m.normals.push(nx / sx / l, ny / sy / l, nz / sz / l);
      m.uvs.push(s / segments, r / rings);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s;
      const b = a + segments + 1;
      m.indices.push(a, b + 1, a + 1, a, b, b + 1);
    }
  }
  return m;
}

/** Flat ground plane with gentle noise height (for exterior demo cells). */
export function terrain(size: number, n: number, amplitude: number, seed = 1): MeshData {
  const m = empty();
  const h = (x: number, y: number) => amplitude * (Math.sin((x + seed * 37) / 600) * Math.cos((y - seed * 13) / 500) + 0.3 * Math.sin((x * 1.7 + y) / 260));
  const step = size / n;
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      const x = i * step;
      const y = j * step;
      m.positions.push(x, y, h(x, y));
      m.normals.push(0, 0, 1);
      m.uvs.push(i / 4, j / 4);
    }
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      m.indices.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
    }
  return m;
}

export function stairs(width: number, depth: number, height: number, steps: number): MeshData {
  const parts: MeshData[] = [];
  for (let i = 0; i < steps; i++) {
    parts.push(box(0, (i * depth) / steps, 0, width, ((i + 1) * depth) / steps, ((i + 1) * height) / steps));
  }
  return merge(...parts);
}

export function shape(name: string, m: MeshData, textures: string[], extra: Partial<WriteShape> = {}): WriteShape {
  return { name, positions: m.positions, normals: m.normals, uvs: m.uvs, indices: m.indices, textures, ...extra };
}
