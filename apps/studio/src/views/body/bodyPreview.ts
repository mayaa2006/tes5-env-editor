/**
 * 3D view for the Body tab: draws the shaped body (flat skin colour) and
 * lets you turn it. Shapes arrive in file space, Z up.
 */
import * as THREE from 'three';
import type { BodyPreview as BodyShapes } from '@tes5/workspace';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export class BodyPreview {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 1, 5000);
  private group = new THREE.Group();
  private meshes = new Map<string, THREE.Mesh>();
  private material = new THREE.MeshStandardMaterial({ color: 0xd9b8a0, roughness: 0.8, metalness: 0, side: THREE.DoubleSide });
  private yaw = Math.PI / 2 - 0.5;
  private pitch = 0.1;
  private dist = 300;
  private target = new THREE.Vector3(0, 0, 64);
  private drag?: { x: number; y: number; pan: boolean };
  private ro: ResizeObserver;
  private raf = 0;
  private dirty = true;
  private framed = false;

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x1f2023);
    container.appendChild(this.renderer.domElement);
    const key = new THREE.DirectionalLight(0xfff4e8, 3);
    key.position.set(-0.6, 1, 0.6);
    const fill = new THREE.DirectionalLight(0xcfe0ff, 1.3);
    fill.position.set(0.8, 0.6, 0.1);
    const rim = new THREE.DirectionalLight(0xffffff, 0.8);
    rim.position.set(0, -1, 0.5);
    this.scene.add(key, fill, rim, new THREE.HemisphereLight(0xffffff, 0x404040, 1.2), this.group);
    const grid = new THREE.GridHelper(200, 10, 0x444850, 0x2c2f35);
    grid.rotateX(Math.PI / 2);
    this.scene.add(grid);
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
      if (this.drag.pan) this.target.z += dy * (this.dist / 600);
      else {
        this.yaw -= dx * 0.01;
        this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.01, -1.3, 1.3);
      }
      this.dirty = true;
    });
    el.addEventListener('pointerup', () => (this.drag = undefined));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.dist = THREE.MathUtils.clamp(this.dist * (e.deltaY > 0 ? 1.1 : 0.9), 30, 1500);
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

  /** Show these shapes (new positions for the same shapes are updated in place). */
  set(body: BodyShapes): void {
    const want = new Set(body.shapes.map((s) => s.name));
    for (const [k, m] of this.meshes) {
      if (want.has(k)) continue;
      this.group.remove(m);
      m.geometry.dispose();
      this.meshes.delete(k);
    }
    for (const s of body.shapes) {
      let m = this.meshes.get(s.name);
      const pos = m?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (m && pos && pos.count === s.positions.length / 3) {
        (pos.array as Float32Array).set(s.positions);
        pos.needsUpdate = true;
        const n = m.geometry.getAttribute('normal') as THREE.BufferAttribute;
        (n.array as Float32Array).set(s.normals);
        n.needsUpdate = true;
        m.geometry.computeBoundingSphere();
        continue;
      }
      if (m) {
        this.group.remove(m);
        m.geometry.dispose();
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(s.positions.slice(), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(s.normals.slice(), 3));
      geo.setIndex(new THREE.BufferAttribute(s.indices, 1));
      m = new THREE.Mesh(geo, this.material);
      this.meshes.set(s.name, m);
      this.group.add(m);
    }
    if (!this.framed) this.frame();
    this.dirty = true;
  }

  /** Forget the shapes (another set is coming), so the camera frames the next one. */
  clear(): void {
    this.set({ shapes: [] });
    this.framed = false;
  }

  frame(): void {
    const box = new THREE.Box3().setFromObject(this.group);
    if (box.isEmpty()) return;
    const s = box.getBoundingSphere(new THREE.Sphere());
    this.target.copy(s.center);
    this.dist = Math.max(60, s.radius * 4.2);
    this.framed = true;
    this.dirty = true;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    for (const m of this.meshes.values()) m.geometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
