/**
 * Live head preview for the character creator: loads each head part's mesh,
 * applies its chargen TRI morphs for the current sliders, and tints hair/skin.
 */
import * as THREE from 'three';
import { applyMorphs, chargenMorphWeights, type TriFile } from '@tes5/assets';
import type { EngineClient } from '../../engine/client';
import { AssetCache } from '../scene/assets3d';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export interface PreviewPart {
  key: string;
  type: string;
  model?: string;
  chargenTri?: string;
}

interface Loaded {
  part: PreviewPart;
  group: THREE.Group;
  /** Mesh the TRI applies to, with its unmorphed positions. */
  morphTarget?: { mesh: THREE.Mesh; base: Float32Array; tri: TriFile };
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
  private sliders: number[] = [];
  private hair = new THREE.Color(0.25, 0.18, 0.12);
  private skin = new THREE.Color(1, 1, 1);
  private generation = 0;

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
    this.assets.onLoad = () => (this.dirty = true);
    const key = new THREE.DirectionalLight(0xfff4e8, 2.2);
    key.position.set(-0.6, -1, 0.6);
    const fill = new THREE.DirectionalLight(0xcfe0ff, 0.9);
    fill.position.set(0.8, -0.6, 0.1);
    const rim = new THREE.DirectionalLight(0xffffff, 0.8);
    rim.position.set(0, 1, 0.5);
    this.scene.add(key, fill, rim, new THREE.HemisphereLight(0xffffff, 0x404040, 0.6));
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
          m.material = (m.material as THREE.Material).clone();
        }
      });
      const l: Loaded = { part, group };
      if (part.chargenTri) {
        try {
          const t = await this.client.call('tri', part.chargenTri);
          const tri = { morphs: t.morphs.map((m) => ({ name: m.name, deltas: m.deltas })) } as unknown as TriFile;
          let target: THREE.Mesh | undefined;
          group.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!target && m.isMesh && m.geometry.getAttribute('position').count === t.vertexCount) target = m;
          });
          if (target) l.morphTarget = { mesh: target, base: (target.geometry.getAttribute('position').array as Float32Array).slice(), tri };
          else missing.push(`${part.chargenTri}: vertex count doesn't match the mesh`);
        } catch {
          missing.push(part.chargenTri);
        }
      }
      if (gen !== this.generation) return { missing };
      this.loaded.set(part.key, l);
      this.scene.add(group);
    }
    this.applyAll();
    return { missing };
  }

  setSliders(values: number[]): void {
    this.sliders = values;
    for (const l of this.loaded.values()) this.applyMorph(l);
    this.dirty = true;
  }

  setColors(hair: { r: number; g: number; b: number } | null, skin: { r: number; g: number; b: number } | null): void {
    if (hair) this.hair.setRGB(hair.r, hair.g, hair.b, THREE.SRGBColorSpace);
    // QNAM skin tone is a multiplier around mid-grey; keep it subtle for preview purposes.
    this.skin.setRGB(skin && (skin.r || skin.g || skin.b) ? 0.6 + skin.r * 0.4 : 1, skin && (skin.r || skin.g || skin.b) ? 0.6 + skin.g * 0.4 : 1, skin && (skin.r || skin.g || skin.b) ? 0.6 + skin.b * 0.4 : 1);
    this.applyAll();
  }

  private applyAll(): void {
    for (const l of this.loaded.values()) {
      this.applyMorph(l);
      const isHair = l.part.type === 'Hair' || l.part.type === 'Facial Hair' || l.part.type === 'Eyebrows';
      l.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mat = m.material as THREE.MeshStandardMaterial;
        if (!mat.color) return;
        if (isHair) mat.color.copy(this.hair).multiplyScalar(2.2);
        else if (l.part.type === 'Face') mat.color.copy(this.skin);
      });
    }
    this.dirty = true;
  }

  private applyMorph(l: Loaded): void {
    const t = l.morphTarget;
    if (!t) return;
    const morphed = applyMorphs(t.base, chargenMorphWeights(t.tri, this.sliders));
    const attr = t.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    (attr.array as Float32Array).set(morphed);
    attr.needsUpdate = true;
    t.mesh.geometry.computeVertexNormals();
    this.dirty = true;
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
