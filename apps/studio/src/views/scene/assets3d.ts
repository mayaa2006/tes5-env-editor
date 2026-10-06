/**
 * Turns engine mesh/texture payloads (parsed NIF/DDS) into three.js objects,
 * with caching so each file is fetched and uploaded once.
 */
import * as THREE from 'three';
import type { EngineClient } from '../../engine/client';
import type { MeshPayload, TexturePayload } from '../../engine/host';

type Shape = MeshPayload['shapes'][number];

export interface GpuCaps {
  s3tc: boolean;
  s3tcSrgb: boolean;
  bptc: boolean;
  rgtc: boolean;
}

export function gpuCaps(renderer: THREE.WebGLRenderer): GpuCaps {
  const has = (n: string) => renderer.extensions.has(n);
  return {
    s3tc: has('WEBGL_compressed_texture_s3tc'),
    s3tcSrgb: has('WEBGL_compressed_texture_s3tc_srgb'),
    bptc: has('EXT_texture_compression_bptc'),
    rgtc: has('EXT_texture_compression_rgtc'),
  };
}

const COMPRESSED: Record<string, { format: THREE.CompressedPixelFormat; cap: keyof GpuCaps }> = {
  bc1: { format: THREE.RGBA_S3TC_DXT1_Format, cap: 's3tc' },
  bc2: { format: THREE.RGBA_S3TC_DXT3_Format, cap: 's3tc' },
  bc3: { format: THREE.RGBA_S3TC_DXT5_Format, cap: 's3tc' },
  bc4: { format: THREE.RED_RGTC1_Format, cap: 'rgtc' },
  bc5: { format: THREE.RED_GREEN_RGTC2_Format, cap: 'rgtc' },
  bc7: { format: THREE.RGBA_BPTC_Format, cap: 'bptc' },
};

function normalizeTexturePath(p: string): string {
  return p
    .replace(/\//g, '\\')
    .replace(/^.*?\bdata\\/i, '')
    .replace(/^\\+/, '')
    .toLowerCase();
}

export class AssetCache {
  private meshes = new Map<string, Promise<THREE.Group | null>>();
  private textures = new Map<string, Promise<THREE.Texture | null>>();
  readonly caps: GpuCaps;
  /** Called when an asynchronously loaded texture arrives, so the view can redraw. */
  onLoad?: () => void;
  warnings = new Set<string>();

  constructor(
    private readonly client: EngineClient,
    renderer: THREE.WebGLRenderer,
  ) {
    this.caps = gpuCaps(renderer);
  }

  /** A template group for a mesh path (relative to Data\meshes); clone it per instance. */
  mesh(path: string): Promise<THREE.Group | null> {
    const key = path.toLowerCase();
    let p = this.meshes.get(key);
    if (!p) {
      p = this.client
        .call('mesh', path)
        .then((payload) => this.buildMesh(payload))
        .catch((e) => {
          this.warnings.add(`${path}: ${(e as Error).message}`);
          return null;
        });
      this.meshes.set(key, p);
    }
    return p;
  }

  texture(path: string, srgb = true): Promise<THREE.Texture | null> {
    const key = normalizeTexturePath(path);
    let p = this.textures.get(key);
    if (!p) {
      p = this.loadTexture(key, srgb).catch(() => null);
      this.textures.set(key, p);
    }
    return p;
  }

  private async loadTexture(path: string, srgb: boolean): Promise<THREE.Texture | null> {
    let payload: TexturePayload = await this.client.call('texture', path, false);
    const fmt = COMPRESSED[payload.format];
    let tex: THREE.Texture;
    if (fmt && this.caps[fmt.cap] && payload.mipmaps.length && !payload.rgba) {
      const mips = payload.mipmaps.map((m) => ({ data: m.data, width: m.width, height: m.height })) as unknown as ImageData[];
      const ct = new THREE.CompressedTexture(mips, payload.width, payload.height, fmt.format);
      const full = Math.floor(Math.log2(Math.max(payload.width, payload.height))) + 1;
      ct.minFilter = payload.mipmaps.length >= full ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
      ct.generateMipmaps = false;
      tex = ct;
      // sRGB variants of S3TC need their own extension; without it, show linear (slightly washed out).
      if (srgb && (fmt.cap !== 's3tc' || this.caps.s3tcSrgb)) tex.colorSpace = THREE.SRGBColorSpace;
    } else {
      if (!payload.rgba) payload = await this.client.call('texture', path, true);
      if (!payload.rgba) {
        this.warnings.add(`${path}: ${payload.format.toUpperCase()} textures need GPU support that isn't available`);
        return null;
      }
      const dt = new THREE.DataTexture(payload.rgba, payload.width, payload.height, THREE.RGBAFormat, THREE.UnsignedByteType);
      dt.generateMipmaps = true;
      dt.minFilter = THREE.LinearMipmapLinearFilter;
      dt.magFilter = THREE.LinearFilter;
      if (srgb) dt.colorSpace = THREE.SRGBColorSpace;
      tex = dt;
    }
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.flipY = false;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    this.onLoad?.();
    return tex;
  }

  private buildMesh(payload: MeshPayload): THREE.Group {
    const group = new THREE.Group();
    group.name = payload.path;
    for (const w of payload.warnings) this.warnings.add(`${payload.path}: ${w}`);
    for (const s of payload.shapes) group.add(this.buildShape(s));
    return group;
  }

  private buildShape(s: Shape): THREE.Mesh {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(s.positions, 3));
    if (s.uvs) geo.setAttribute('uv', new THREE.BufferAttribute(s.uvs, 2));
    if (s.colors && s.material.vertexColors) {
      const rgb = new Float32Array((s.colors.length / 4) * 3);
      for (let i = 0, j = 0; i < s.colors.length; i += 4, j += 3) {
        rgb[j] = s.colors[i]!;
        rgb[j + 1] = s.colors[i + 1]!;
        rgb[j + 2] = s.colors[i + 2]!;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    }
    geo.setIndex(new THREE.BufferAttribute(s.indices, 1));
    if (s.normals && !s.material.modelSpaceNormals) geo.setAttribute('normal', new THREE.BufferAttribute(s.normals, 3));
    else geo.computeVertexNormals();
    geo.computeBoundingBox();
    geo.computeBoundingSphere();

    const m = s.material;
    let mat: THREE.Material;
    if (m.shader === 'effect') {
      mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    } else {
      mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.85,
        metalness: 0,
        side: m.twoSided ? THREE.DoubleSide : THREE.FrontSide,
        vertexColors: !!geo.getAttribute('color'),
        transparent: m.alphaBlend,
        depthWrite: !m.alphaBlend,
        alphaTest: m.alphaTest ? Math.max(0.01, m.alphaThreshold / 255) : 0,
        opacity: m.alpha,
      });
      const std = mat as THREE.MeshStandardMaterial;
      if (m.emissiveMultiple > 0 && (m.emissive[0] || m.emissive[1] || m.emissive[2]) && m.shaderType === 2) {
        std.emissive = new THREE.Color(m.emissive[0], m.emissive[1], m.emissive[2]);
        std.emissiveIntensity = Math.min(2, m.emissiveMultiple);
      }
    }
    const diffuse = m.textures[0];
    if (diffuse) {
      void this.texture(diffuse).then((t) => {
        if (!t) return;
        const tex = t.clone();
        tex.offset.set(m.uvOffset[0], m.uvOffset[1]);
        tex.repeat.set(m.uvScale[0] || 1, m.uvScale[1] || 1);
        tex.needsUpdate = true;
        (mat as THREE.MeshStandardMaterial).map = tex;
        mat.needsUpdate = true;
        this.onLoad?.();
      });
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = s.name;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.fromArray(s.matrix);
    mesh.updateMatrixWorld(true);
    return mesh;
  }

  dispose(): void {
    const seen = new Set<unknown>();
    for (const p of this.meshes.values())
      void p.then((g) =>
        g?.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.geometry && !seen.has(mesh.geometry)) {
            seen.add(mesh.geometry);
            mesh.geometry.dispose();
          }
          const mat = mesh.material as THREE.MeshStandardMaterial | undefined;
          if (mat && !seen.has(mat)) {
            seen.add(mat);
            mat.map?.dispose();
            mat.dispose();
          }
        }),
      );
    for (const p of this.textures.values()) void p.then((t) => t?.dispose());
    this.meshes.clear();
    this.textures.clear();
  }
}

// ------------------------------------------------------------------ editor-only shapes

const markerMats = new Map<number, THREE.Material>();
function markerMat(color: number): THREE.Material {
  let m = markerMats.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.6, emissive: color, emissiveIntensity: 0.25 });
    markerMats.set(color, m);
  }
  return m;
}

const actorGeo = (() => {
  const g = new THREE.CapsuleGeometry(26, 76, 4, 12);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, 64);
  return g;
})();
const facingGeo = (() => {
  const g = new THREE.ConeGeometry(10, 26, 10);
  g.rotateX(-Math.PI / 2);
  g.rotateZ(Math.PI);
  g.translate(0, 34, 110);
  return g;
})();
const markerGeo = new THREE.OctahedronGeometry(14);
const lightGeo = new THREE.SphereGeometry(7, 12, 8);

/** Stand-in for objects without a renderable mesh (actors, markers, lights). */
export function placeholder(kind: 'actor' | 'marker' | 'light' | 'missing'): THREE.Object3D {
  if (kind === 'actor') {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(actorGeo, markerMat(0x3cb38c)));
    // Cone points along +Y (the direction a Skyrim actor faces at rotation 0).
    g.add(new THREE.Mesh(facingGeo, markerMat(0xe8e8e8)));
    return g;
  }
  if (kind === 'light') return new THREE.Mesh(lightGeo, markerMat(0xffd25a));
  const m = new THREE.Mesh(markerGeo, markerMat(kind === 'missing' ? 0xd04a4a : 0xff9a3c));
  m.position.z = 14;
  return m;
}
