/**
 * Turns engine mesh/texture payloads (parsed NIF/DDS) into three.js objects,
 * with caching so each file is fetched and uploaded once.
 */
import * as THREE from 'three';
import { gameTexturePath } from '@tes5/assets';
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

const normalizeTexturePath = gameTexturePath;

export class AssetCache {
  private meshes = new Map<string, Promise<THREE.Group | null>>();
  private textures = new Map<string, Promise<THREE.Texture | null>>();
  readonly caps: GpuCaps;
  /** Called when an asynchronously loaded texture arrives, so the view can redraw. */
  onLoad?: () => void;
  warnings = new Set<string>();
  /** Apply FaceGen face tints (off where the face texture is composed separately, as in the character creator). */
  faceTint = true;

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
    // Effects (mist, smoke, sparks) are particle systems the editor can't draw; their only shape is an editor box the game never shows.
    const effect = /^meshes\\effects\\/i.test(payload.path);
    for (const s of payload.shapes) {
      const mesh = this.buildShape(s);
      if (effect && mesh.userData.editorMarker) continue;
      group.add(mesh);
    }
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
    // Shapes only the editor shows: the box on effect meshes, furniture and idle markers.
    const editorMarker = /^(editormarker|marker)/i.test(s.name);
    if (editorMarker) {
      mat = MARKER_SHAPE_MAT;
    } else if (m.water) {
      mat = WATER_MAT;
    } else if (m.shader === 'effect') {
      // Glows, mist, sparks, webs: the texture tinted by the base colour, blended (often additively) over the scene.
      const base = new THREE.Color(m.emissive[0] || 1, m.emissive[1] || 1, m.emissive[2] || 1).multiplyScalar(Math.max(0.2, Math.min(m.emissiveMultiple || 1, 3)));
      mat = new THREE.MeshBasicMaterial({
        color: base,
        transparent: true,
        opacity: Math.max(0.05, Math.min(1, m.alpha || 1)),
        blending: m.additive || !m.alphaBlend ? THREE.AdditiveBlending : THREE.NormalBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        vertexColors: !!geo.getAttribute('color'),
        alphaTest: m.alphaTest ? Math.max(0.01, m.alphaThreshold / 255) : 0,
      });
      // With no texture an effect would be a flat bright sheet; keep it faint.
      if (!m.textures[0]) (mat as THREE.MeshBasicMaterial).opacity = 0.15;
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
      // The lighting shader type (4 face, 5 skin tint, 6 hair tint…) for previews that colour by it.
      std.userData.shaderType = m.shaderType;
      if (m.emissiveMultiple > 0 && (m.emissive[0] || m.emissive[1] || m.emissive[2]) && m.shaderType === 2) {
        std.emissive = new THREE.Color(m.emissive[0], m.emissive[1], m.emissive[2]);
        std.emissiveIntensity = Math.min(2, m.emissiveMultiple);
      }
    }
    // Textures arrive later; `userData.ready` settles once they're on the material (characters wait for it).
    const loading: Promise<unknown>[] = [];
    const diffuse = editorMarker || m.water ? undefined : m.textures[0];
    if (diffuse) {
      loading.push(this.texture(diffuse).then((t) => {
        if (!t) return;
        const tex = t.clone();
        tex.offset.set(m.uvOffset[0], m.uvOffset[1]);
        tex.repeat.set(m.uvScale[0] || 1, m.uvScale[1] || 1);
        tex.needsUpdate = true;
        (mat as THREE.MeshStandardMaterial).map = tex;
        mat.needsUpdate = true;
        this.onLoad?.();
      }));
    }
    // Normal map (texture slot 1): bumps and folds, and on skin the whole shading (skin meshes carry no vertex normals).
    const normalPath = m.shader === 'lighting' && !editorMarker && !m.water ? m.textures[1] : undefined;
    if (normalPath && mat instanceof THREE.MeshStandardMaterial) {
      const std = mat;
      loading.push(this.texture(normalPath, false).then((t) => {
        if (!t) return;
        const tex = t.clone();
        tex.offset.set(m.uvOffset[0], m.uvOffset[1]);
        tex.repeat.set(m.uvScale[0] || 1, m.uvScale[1] || 1);
        tex.needsUpdate = true;
        std.normalMap = tex;
        if (m.modelSpaceNormals) std.normalMapType = THREE.ObjectSpaceNormalMap;
        // Shine: the normal map's alpha is the game's specular mask, sharpened by the material's glossiness.
        const spec = !!m.specular && m.specularStrength > 0;
        std.roughness = spec ? Math.min(0.9, Math.max(0.3, Math.sqrt(2 / (Math.max(1, m.glossiness) + 2)) * 2.2)) : 0.9;
        // Model-space maps (skin, faces): red = X, blue = Y, green = Z in the shape's own space
        // (measured against vanilla bodies and heads), so green and blue are swapped when read.
        if (m.modelSpaceNormals) addShaderPatch(std, 'msn', (shader) => (shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', MSN_CHUNK)));
        if (spec)
          addShaderPatch(std, 'specmask', (shader) => {
            shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix( 1.0, roughnessFactor, texture2D( normalMap, vNormalMapUv ).a );');
          });
        std.needsUpdate = true;
        this.onLoad?.();
      }));
    }
    // FaceGen faces (shader type 4): the head texture times the character's face tint (slot 6), doubled in gamma
    // space as the game does: (2·t)^2.2 = 4.59·t in the linear space lighting happens in.
    const tintPath = this.faceTint && m.shader === 'lighting' && m.shaderType === 4 ? m.textures[6] : undefined;
    if (tintPath && mat instanceof THREE.MeshStandardMaterial) {
      const std = mat;
      loading.push(this.texture(tintPath.replace(/^data\\/i, '')).then((t) => {
        if (!t) return;
        const uniform = { value: t };
        addShaderPatch(std, 'facetint', (shader) => {
          shader.uniforms.faceTint = uniform;
          shader.fragmentShader = shader.fragmentShader
            .replace('void main() {', 'uniform sampler2D faceTint;\nvoid main() {')
            .replace('#include <map_fragment>', '#include <map_fragment>\n#ifdef USE_MAP\ndiffuseColor.rgb *= 4.59 * texture2D( faceTint, vMapUv ).rgb;\n#endif');
        });
        this.onLoad?.();
      }));
    }
    if (loading.length) mat.userData.ready = Promise.all(loading);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = s.name;
    if (editorMarker) mesh.userData.editorMarker = true;
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

/** Several shader tweaks on one material: each has a key (for the program cache) and an edit. */
function addShaderPatch(mat: THREE.MeshStandardMaterial, key: string, edit: (shader: THREE.WebGLProgramParametersWithUniforms) => void): void {
  const patches = ((mat.userData.patches ??= new Map()) as Map<string, typeof edit>);
  patches.set(key, edit);
  mat.onBeforeCompile = (shader) => {
    for (const p of patches.values()) p(shader);
  };
  mat.customProgramCacheKey = () => [...patches.keys()].sort().join('|');
  mat.needsUpdate = true;
}

/** three.js's normal-map chunk, reading model-space maps with Skyrim's channel order. */
const MSN_CHUNK = THREE.ShaderChunk.normal_fragment_maps.replace(
  'normal = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
  'normal = texture2D( normalMap, vNormalMapUv ).xzy * 2.0 - 1.0;',
);

// ------------------------------------------------------------------ body weight

/** The thin (weight 0) version of a body or armor mesh: "…_1.nif" → "…_0.nif". */
export function lightVariant(model: string): string | undefined {
  return /_1\.nif$/i.test(model) ? model.replace(/_1\.nif$/i, '_0.nif') : undefined;
}

/**
 * A copy of a body or armor mesh at a character's weight (0–100), blending the
 * heavy (_1) and thin (_0) meshes vertex by vertex the way the game does, so
 * the neck meets the head (which is shaped for the same weight). Geometry is
 * copied; materials stay shared. Without a matching thin mesh, the heavy one.
 */
export function atWeight(heavy: THREE.Group, light: THREE.Group | null | undefined, weight: number): THREE.Group {
  const out = heavy.clone();
  const meshesOf = (g: THREE.Object3D) => {
    const list: THREE.Mesh[] = [];
    g.traverse((o) => (o as THREE.Mesh).isMesh && list.push(o as THREE.Mesh));
    return list;
  };
  const target = meshesOf(out);
  const thin = light ? meshesOf(light) : [];
  const w = Math.max(0, Math.min(1, weight / 100));
  target.forEach((m, i) => {
    m.geometry = m.geometry.clone();
    const t = thin[i];
    if (!t || w >= 1) return;
    for (const name of ['position', 'normal'] as const) {
      const a = m.geometry.getAttribute(name) as THREE.BufferAttribute | undefined;
      const b = t.geometry.getAttribute(name) as THREE.BufferAttribute | undefined;
      if (!a || !b || a.count !== b.count) continue;
      const arr = a.array as Float32Array;
      const src = b.array as Float32Array;
      for (let k = 0; k < arr.length; k++) arr[k] = src[k]! + (arr[k]! - src[k]!) * w;
      a.needsUpdate = true;
    }
    if (m.geometry.getAttribute('normal')) {
      // Keep normals unit length after blending.
      const n = m.geometry.getAttribute('normal') as THREE.BufferAttribute;
      const v = new THREE.Vector3();
      for (let k = 0; k < n.count; k++) {
        v.fromBufferAttribute(n, k).normalize();
        n.setXYZ(k, v.x, v.y, v.z);
      }
    }
    m.geometry.computeBoundingBox();
    m.geometry.computeBoundingSphere();
  });
  return out;
}

// ------------------------------------------------------------------ editor-only shapes

const MARKER_SHAPE_MAT = new THREE.MeshBasicMaterial({ color: 0xff9a3c, transparent: true, opacity: 0.55, depthWrite: false, wireframe: true });
/** Water surfaces (rivers, troughs): the game's water shader is out of reach, so a calm translucent blue. */
const WATER_MAT = new THREE.MeshStandardMaterial({ color: 0x2f5f7a, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide });

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
