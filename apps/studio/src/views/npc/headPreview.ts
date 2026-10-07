/**
 * Live head preview for the character creator: loads each head part's mesh
 * and TRI morphs, shapes them together with the same FaceShaper the FaceGen
 * baker uses (sliders, extra morphs, region shaping), and tints hair/skin.
 */
import * as THREE from 'three';
import type { TriFile } from '@tes5/assets';
import { FaceShaper, type FaceLook, type ShaperTri } from '@tes5/workspace';
import type { EngineClient } from '../../engine/client';
import { AssetCache, atWeight, lightVariant } from '../scene/assets3d';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export interface PreviewPart {
  key: string;
  type: string;
  model?: string;
  /** TRI files with their kind (0 race, 1 expression — only its SkinnyMorph is used — 2 chargen). */
  tris: { type: number; file: string }[];
}

interface Loaded {
  part: PreviewPart;
  group: THREE.Group;
  /** Mesh the TRIs apply to, with its unmorphed positions. */
  morphTarget?: { mesh: THREE.Mesh; base: Float32Array; tris: TriFile[]; model: Float32Array };
}

export class HeadPreview {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 1, 2000);
  private assets: AssetCache;
  private loaded = new Map<string, Loaded>();
  /** Faces look down +Y, so the camera starts in front of them. */
  private yaw = Math.PI / 2 - 0.35;
  private pitch = 0.1;
  private dist = 70;
  private target = new THREE.Vector3(0, 0, 118);
  private drag?: { x: number; y: number; pan: boolean };
  private ro: ResizeObserver;
  private raf = 0;
  private dirty = true;
  private look: FaceLook = { sliders: [] };
  private shaper?: FaceShaper;
  /** Told when the shaper is rebuilt (new parts): which regions and extra morphs these parts offer. */
  onShaper?: (info: { regions: string[]; extraMorphs: string[] }) => void;
  private hair = new THREE.Color(0.25, 0.18, 0.12);
  private skin = new THREE.Color(1, 1, 1);
  /** The character's skin tone as stored (white when unset), for the body's skin shader. */
  private skinTone = new THREE.Color(0.5, 0.5, 0.5);
  private generation = 0;
  /** Body and worn armor (rest pose), shown under the head. */
  private body = new THREE.Group();
  private bodyKey = '';

  constructor(
    private readonly container: HTMLElement,
    private readonly client: EngineClient,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x1f2023);
    container.appendChild(this.renderer.domElement);
    this.assets = new AssetCache(client, this.renderer);
    // The face texture here already includes the tint (it follows edits live).
    this.assets.faceTint = false;
    // Textures arrive after the meshes: re-apply colours (and the face texture) when they do.
    this.assets.onLoad = () => this.applyColours();
    const key = new THREE.DirectionalLight(0xfff4e8, 3.2);
    // Faces look down +Y: key and fill light them from the front, the rim from behind.
    key.position.set(-0.6, 1, 0.6);
    const fill = new THREE.DirectionalLight(0xcfe0ff, 1.4);
    fill.position.set(0.8, 0.6, 0.1);
    const rim = new THREE.DirectionalLight(0xffffff, 0.8);
    rim.position.set(0, -1, 0.5);
    this.scene.add(key, fill, rim, new THREE.HemisphereLight(0xffffff, 0x404040, 1.3));
    this.scene.add(this.body);
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY, pan: e.button === 1 || e.button === 2 || e.shiftKey };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      if (this.drag.pan) this.target.z += dy * 0.08;
      else {
        this.yaw -= dx * 0.01;
        this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.01, -1.2, 1.2);
      }
      this.dirty = true;
    });
    el.addEventListener('pointerup', () => (this.drag = undefined));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.dist = THREE.MathUtils.clamp(this.dist * (e.deltaY > 0 ? 1.1 : 0.9), 20, 400);
        this.dirty = true;
      },
      { passive: false },
    );
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    const loop = () => {
      if (this.dirty) {
        this.dirty = false;
        const d = new THREE.Vector3(Math.cos(this.pitch) * Math.cos(this.yaw), Math.cos(this.pitch) * Math.sin(this.yaw), Math.sin(this.pitch));
        this.camera.position.copy(this.target).addScaledVector(d, this.dist);
        this.camera.up.set(0, 0, 1);
        this.camera.lookAt(this.target);
        this.renderer.render(this.scene, this.camera);
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  /** Replace the set of head parts shown. */
  async setParts(parts: PreviewPart[]): Promise<{ missing: string[] }> {
    const gen = ++this.generation;
    const missing: string[] = [];
    const want = new Set(parts.map((p) => p.key));
    for (const [k, l] of this.loaded) {
      if (want.has(k)) continue;
      this.scene.remove(l.group);
      this.loaded.delete(k);
    }
    for (const part of parts) {
      if (this.loaded.has(part.key) || !part.model) {
        if (!part.model) missing.push(`${part.type}: no model`);
        continue;
      }
      const tpl = await this.assets.mesh(part.model);
      if (gen !== this.generation) return { missing };
      if (!tpl) {
        missing.push(part.model);
        continue;
      }
      const group = tpl.clone();
      // Morphs write positions, so each preview owns its geometry.
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry = m.geometry.clone();
          // Materials stay shared with this preview's own asset cache, so textures that finish loading later
          // still show. Head meshes' vertex colours are black (the game doesn't use them for skin): drop them.
          m.geometry.deleteAttribute('color');
          const mat = m.material as THREE.MeshStandardMaterial;
          if (mat.vertexColors) {
            mat.vertexColors = false;
            mat.needsUpdate = true;
          }
        }
      });
      const l: Loaded = { part, group };
      const tris: ShaperTri[] = [];
      let count = -1;
      for (const { type, file } of part.tris) {
        try {
          const t = await this.client.call('tri', file);
          if (count < 0) count = t.vertexCount;
          else if (t.vertexCount !== count) continue;
          const morphs = t.morphs.filter((m) => type !== 1 || m.name === 'SkinnyMorph').map((m) => ({ name: m.name, deltas: m.deltas }));
          tris.push({ morphs, kind: type === 0 ? 'race' : type === 1 ? 'expression' : 'chargen' } as unknown as ShaperTri);
        } catch {
          missing.push(file);
        }
      }
      let target: THREE.Mesh | undefined;
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!target && m.isMesh && (count < 0 || m.geometry.getAttribute('position').count === count)) target = m;
      });
      if (target) {
        // Shape in one space for all parts: the mesh's own placement (the bind pose for skinned heads).
        const base = (target.geometry.getAttribute('position').array as Float32Array).slice();
        const model = base.slice();
        new THREE.BufferAttribute(model, 3).applyMatrix4(target.matrix);
        l.morphTarget = { mesh: target, base, tris, model };
      }
      else if (count >= 0) missing.push(`${part.tris[0]}: vertex count doesn't match the mesh`);
      if (gen !== this.generation) return { missing };
      this.loaded.set(part.key, l);
      this.scene.add(group);
    }
    this.rebuildShaper();
    this.applyAll();
    return { missing };
  }

  private rebuildShaper(): void {
    const parts = [...this.loaded.values()].filter((l) => l.morphTarget).map((l) => ({ key: l.part.key, type: l.part.type, positions: l.morphTarget!.model, tris: l.morphTarget!.tris }));
    this.shaper = parts.length ? new FaceShaper(parts) : undefined;
    this.onShaper?.({ regions: this.shaper?.availableRegions() ?? [], extraMorphs: this.shaper?.extraMorphs() ?? [] });
  }

  /** Show a look: the 19 sliders (extended values merged in) plus sculpt. */
  setLook(look: FaceLook): void {
    this.look = look;
    this.applyShape();
  }

  private applyShape(): void {
    if (!this.shaper) return;
    const shaped = this.shaper.shape(this.look);
    for (const l of this.loaded.values()) {
      const t = l.morphTarget;
      const pos = t && shaped.get(l.part.key);
      if (!t || !pos) continue;
      const attr = t.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const local = new THREE.BufferAttribute(pos.slice(), 3).applyMatrix4(t.mesh.matrix.clone().invert());
      (attr.array as Float32Array).set(local.array as Float32Array);
      attr.needsUpdate = true;
      t.mesh.geometry.computeVertexNormals();
    }
    this.dirty = true;
  }

  private faceTexture?: THREE.DataTexture;

  /** The head's colour as the game shows it (diffuse × tint, from the host); null to go back to the plain texture. */
  setFaceTexture(img: { width: number; height: number; rgba: Uint8Array } | null): void {
    this.faceTexture?.dispose();
    this.faceTexture = undefined;
    if (img) {
      const t = new THREE.DataTexture(img.rgba, img.width, img.height, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.colorSpace = THREE.SRGBColorSpace;
      t.flipY = false;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.needsUpdate = true;
      this.faceTexture = t;
    }
    this.applyAll();
  }

  setColors(hair: { r: number; g: number; b: number } | null, skin: { r: number; g: number; b: number } | null): void {
    if (hair) this.hair.setRGB(hair.r, hair.g, hair.b, THREE.SRGBColorSpace);
    // QNAM skin tone is a multiplier around mid-grey; keep it subtle for preview purposes.
    const hasTone = !!skin && (skin.r > 0 || skin.g > 0 || skin.b > 0);
    if (hasTone) this.skinTone.setRGB(skin!.r, skin!.g, skin!.b);
    else this.skinTone.setRGB(0.5, 0.5, 0.5);
    this.skin.setRGB(skin && (skin.r || skin.g || skin.b) ? 0.6 + skin.r * 0.4 : 1, skin && (skin.r || skin.g || skin.b) ? 0.6 + skin.g * 0.4 : 1, skin && (skin.r || skin.g || skin.b) ? 0.6 + skin.b * 0.4 : 1);
    this.applyAll();
  }

  private applyAll(): void {
    this.applyShape();
    this.applyColours();
  }

  private applyColours(): void {
    this.body.traverse((o) => {
      const m = o as THREE.Mesh;
      const mat = m.isMesh ? (m.material as THREE.MeshStandardMaterial) : undefined;
      // Skin-tint shader (the bare body, hands, feet): texture × skin tone × 2 in gamma space, as the game's skin
      // shader does (the same rule the face uses with its tint), so neck and hands match the face. Lighting here is
      // linear, so the gamma-space factor is raised to 2.2.
      if (mat?.color && mat.userData.shaderType === 5) mat.color.setRGB(...([this.skinTone.r, this.skinTone.g, this.skinTone.b].map((v) => Math.pow(2 * v, 2.2)) as [number, number, number]));
    });
    for (const l of this.loaded.values()) {
      const typeHair = l.part.type === 'Hair' || l.part.type === 'Facial Hair' || l.part.type === 'Eyebrows';
      l.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mat = m.material as THREE.MeshStandardMaterial;
        if (!mat.color) return;
        // Hair-tint shaders take the hair colour (hairlines and brows too, as in the game).
        const isHair = mat.userData.shaderType === 6 || (mat.userData.shaderType === undefined && typeHair);
        if (isHair) mat.color.copy(this.hair).multiplyScalar(2.2);
        else if (l.part.type === 'Face') {
          if (this.faceTexture) {
            // Already includes the skin tone and paint.
            if (mat.map !== this.faceTexture) {
              mat.map = this.faceTexture;
              mat.needsUpdate = true;
            }
            mat.color.setRGB(1, 1, 1);
          } else mat.color.copy(this.skin);
        }
      });
    }
    this.dirty = true;
  }

  /** Show the body and worn armor (model paths under Data\\meshes); empty to show only the head. */
  async setBody(models: string[], weight = 50): Promise<void> {
    const key = `${models.join('|')}@${weight}`;
    if (key === this.bodyKey) return;
    this.bodyKey = key;
    // Bodies and armor come in heavy (_1) and thin (_0) versions, blended by the character's weight.
    const groups = await Promise.all(
      models.map(async (m) => {
        const light = lightVariant(m);
        const [heavy, thin] = await Promise.all([this.assets.mesh(m), light ? this.assets.mesh(light) : null]);
        return heavy ? atWeight(heavy, thin, weight) : null;
      }),
    );
    if (key !== this.bodyKey) return;
    this.body.clear();
    for (const c of groups) {
      if (!c) continue;
      c.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        // Vertex colours aren't used on bodies and clothes: drop them.
        m.geometry.deleteAttribute('color');
        const mat = m.material as THREE.MeshStandardMaterial;
        if (mat.vertexColors) {
          mat.vertexColors = false;
          mat.needsUpdate = true;
        }
      });
      this.body.add(c);
    }
    this.applyColours();
  }

  /** Camera on the face, or on the whole figure. */
  view(mode: 'head' | 'body'): void {
    if (mode === 'body' && this.body.children.length) {
      this.scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(this.body, true);
      for (const l of this.loaded.values()) box.expandByObject(l.group);
      const sp = box.getBoundingSphere(new THREE.Sphere());
      this.target.copy(sp.center);
      this.dist = Math.max(200, sp.radius * 4.2);
      this.dirty = true;
    } else this.frame();
  }

  frame(): void {
    const box = new THREE.Box3();
    for (const l of this.loaded.values()) box.expandByObject(l.group);
    if (box.isEmpty()) return;
    const s = box.getBoundingSphere(new THREE.Sphere());
    this.target.copy(s.center);
    this.dist = Math.max(40, s.radius * 4.6);
    this.dirty = true;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.assets.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
