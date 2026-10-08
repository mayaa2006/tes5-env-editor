/**
 * The 3D viewport: a framework-free controller around three.js that implements
 * Blender's interaction model for placed references.
 *
 *   Navigation  MMB orbit · Shift+MMB pan · Ctrl+MMB / wheel zoom
 *               Alt+LMB orbit · Alt+Shift+LMB pan (no middle button needed)
 *               RMB hold + WASD/QE fly · Numpad 1/3/7 (+Ctrl) views · Numpad 5 ortho
 *               Numpad . / F frame selected · Home frame all
 *   Selection   LMB click · Shift+LMB toggle · drag / B box · A all · Alt+A none · Ctrl+I invert
 *   Transform   G move · R rotate · S scale, then X/Y/Z (Shift = plane), type a value,
 *               hold Ctrl to snap, LMB/Enter confirm, RMB/Esc cancel
 *   Edit        Shift+D duplicate · X/Delete delete · H hide · Shift+H hide others · Alt+H reveal
 *
 * Skyrim is Z-up and measured in game units; the scene uses the same space.
 */
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { FormKey, Navmesh } from '@tes5/esp';
import { HeightField, sculptDab, type PlacedRef, type SculptOptions, type Transform } from '@tes5/workspace';
import { AssetCache, atWeight, lightVariant, placeholder } from './assets3d';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export type Tool = 'select' | 'move' | 'rotate' | 'scale';
type ModalKind = 'move' | 'rotate' | 'scale';
type Axis = 'x' | 'y' | 'z';

export interface ViewportCallbacks {
  select(keys: FormKey[]): void;
  commitTransforms(changes: { ref: FormKey; transform: Transform }[], label: string): void;
  duplicate(keys: FormKey[]): Promise<FormKey[] | undefined>;
  remove(keys: FormKey[]): void;
  status(text: string | null): void;
  hiddenChanged(): void;
  navPick?(triangles: number[], additive: boolean): void;
  navDelete?(): void;
  /** Draw tool: a new triangle from three world points (snapped to existing vertices). */
  navAddTriangle?(points: { x: number; y: number; z: number }[]): void;
  /** G in navmesh mode: new positions for vertices. */
  navMoveVertices?(moves: { index: number; x: number; y: number; z: number }[]): void;
  navDrawChanged?(on: boolean): void;
  /** Tab: toggle navmesh edit mode (Blender's edit-mode key). */
  tab?(): void;
  /** Paint brush: a finished stroke (all dab centres); `erase` when Ctrl was held. */
  brushStroke?(points: { x: number; y: number; z: number }[], erase: boolean): void;
  brushRadius?(radius: number): void;
  /** Path drawing finished (Enter, double-click or right-click). */
  pathDone?(points: { x: number; y: number; z: number }[]): void;
  /** A brush, path or point-pick mode was left with Esc. */
  toolCancelled?(): void;
}

export interface TerrainData {
  /** Cell the terrain belongs to (outdoor areas show several). */
  cell?: FormKey;
  origin: { x: number; y: number };
  heights: Float32Array;
  colors?: Uint8Array;
}

interface Entry {
  ref: PlacedRef;
  obj: THREE.Group;
  contentKey?: string;
  box?: THREE.BoxHelper;
}

interface ModalState {
  kind: ModalKind;
  keys: FormKey[];
  start: Map<FormKey, { pos: THREE.Vector3; quat: THREE.Quaternion; scale: number }>;
  pivot: THREE.Vector3;
  mouse0: THREE.Vector2;
  axis: Axis | null;
  plane: boolean;
  typed: string;
  /** Started from the gizmo rather than the keyboard. */
  gizmo?: boolean;
}

const AXES: Record<Axis, THREE.Vector3> = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const AXIS_COLORS: Record<Axis, number> = { x: 0xff3352, y: 0x8bdc00, z: 0x2890ff };

export function skyrimQuaternion(r: { x: number; y: number; z: number }): THREE.Quaternion {
  // Bethesda angles rotate clockwise; applied as Rz·Ry·Rx (see @tes5/workspace automations).
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(-r.x, -r.y, -r.z, 'ZYX'));
}

export function skyrimRotation(q: THREE.Quaternion): { x: number; y: number; z: number } {
  const e = new THREE.Euler().setFromQuaternion(q, 'ZYX');
  const norm = (a: number) => {
    const v = -a;
    return Math.abs(v) < 1e-7 ? 0 : v;
  };
  return { x: norm(e.x), y: norm(e.y), z: norm(e.z) };
}

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly assets: AssetCache;
  private readonly persp = new THREE.PerspectiveCamera(55, 1, 4, 600000);
  private readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -400000, 400000);
  private useOrtho = false;
  private target = new THREE.Vector3(0, 0, 0);
  private dist = 1600;
  private yaw = -Math.PI / 2 - 0.7;
  private pitch = 0.55;

  private readonly root = new THREE.Group();
  private readonly helpers = new THREE.Group();
  private readonly terrainGroup = new THREE.Group();
  private readonly navGroup = new THREE.Group();
  private readonly lights = new THREE.Group();
  private readonly editorLights: THREE.Light[];
  private readonly pointLights: THREE.PointLight[] = [];
  private readonly ambient = new THREE.AmbientLight(0xffffff, 0);
  private entries = new Map<FormKey, Entry>();
  private selection: FormKey[] = [];
  readonly hidden = new Set<FormKey>();
  private modal?: ModalState;
  private gizmo: TransformControls;
  private pivotProxy = new THREE.Object3D();
  private tool: Tool = 'select';
  /** Snapping toggled in the toolbar; holding Ctrl during a transform inverts it. */
  private snapToggle = false;
  private ctrlHeld = false;
  snap = { move: 16, rotateDeg: 15, scale: 0.1 };
  private showMarkers = true;
  private showMarkerShapes = false;
  private cellLighting = false;
  private cellAmbient = new THREE.Color(0.35, 0.33, 0.3);

  private drag?: { mode: 'orbit' | 'pan' | 'zoom' | 'look' | 'box' | 'click'; x: number; y: number; moved: boolean; shift: boolean };
  private boxEl: HTMLDivElement;
  private boxMode = false;
  private keysDown = new Set<string>();
  private flySpeed = 600;
  private mouse = new THREE.Vector2();
  private hovered = false;
  private needsRender = true;
  private raf = 0;
  private lastTime = performance.now();
  private pendingGrab?: FormKey[];
  private disposed = false;
  private ro: ResizeObserver;

  private navEdit?: { key: FormKey; nav: Navmesh; selected: Set<number> };
  private navDraw?: { points: THREE.Vector3[] };
  private navMove?: { verts: number[]; start: THREE.Vector3[]; pivot: THREE.Vector3; mouse0: THREE.Vector2; axis: Axis | null; plane: boolean; typed: string };
  private navMeshes: { key: FormKey; nav: Navmesh; mine: boolean }[] = [];
  /** Snap moved objects' bounding boxes to their neighbours' (kit pieces). */
  private kitSnap = false;
  /** Alt held during a move: skip kit snapping this time. */
  private altHeld = false;
  private kitTargets?: { key: FormKey; box: THREE.Box3 }[];
  private kitStart?: THREE.Box3;
  private brush?: {
    radius: number;
    ring: THREE.Line;
    painting: boolean;
    erase: boolean;
    points: THREE.Vector3[];
    /** Terrain brush: the ground is reshaped live while dragging (the same calculation the engine saves). */
    sculpt?: { mode: SculptOptions['mode']; strength: number };
    live?: { field: HeightField; verts: Map<string, [THREE.Mesh, number][]>; flattenTo?: number; dirty: Set<THREE.Mesh> };
  };
  private pathDraw?: { points: THREE.Vector3[] };
  private pointPick?: (p: { x: number; y: number; z: number } | null) => void;

  constructor(
    private readonly container: HTMLElement,
    private readonly client: import('../../engine/client').EngineClient,
    private readonly cb: ViewportCallbacks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x2b2b2e);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.tabIndex = 0;
    this.assets = new AssetCache(client, this.renderer);
    this.assets.onLoad = () => this.invalidate(true);

    this.scene.add(this.root, this.helpers, this.terrainGroup, this.navGroup, this.lights, this.ambient, this.pivotProxy);
    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x3a3428, 1.6);
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(0.4, -0.6, 1);
    this.editorLights = [hemi, sun];
    this.lights.add(hemi, sun);
    for (let i = 0; i < 8; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 512, 1);
      l.visible = false;
      this.pointLights.push(l);
      this.lights.add(l);
    }
    this.buildGrid(0, 0, false);

    this.gizmo = new TransformControls(this.persp, this.renderer.domElement);
    this.gizmo.setSpace('world');
    this.gizmo.setSize(0.9);
    this.scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('change', () => this.invalidate());
    this.gizmo.addEventListener('mouseDown', () => this.beginGizmo());
    this.gizmo.addEventListener('objectChange', () => this.updateGizmo());
    this.gizmo.addEventListener('mouseUp', () => this.endGizmo());

    this.boxEl = document.createElement('div');
    Object.assign(this.boxEl.style, { position: 'absolute', border: '1px dashed #fff', background: 'rgba(255,255,255,0.06)', pointerEvents: 'none', display: 'none' });
    container.appendChild(this.boxEl);

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerenter', () => (this.hovered = true));
    el.addEventListener('pointerleave', () => (this.hovered = false));
    // Capture phase, so an active transform sees keys before app-wide shortcuts (Ctrl+Z, Ctrl+S…).
    window.addEventListener('keydown', this.onKeyDown, { capture: true });
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.updateCamera();
    this.raf = requestAnimationFrame(this.tick);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    window.removeEventListener('keydown', this.onKeyDown, { capture: true });
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.gizmo.dispose();
    this.assets.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.boxEl.remove();
  }

  get camera(): THREE.Camera {
    return this.useOrtho ? this.ortho : this.persp;
  }

  invalidate(boxes = false): void {
    if (boxes) for (const k of this.selection) this.entries.get(k)?.box?.update();
    this.needsRender = true;
  }

  // ---------------------------------------------------------------- content

  setOptions(o: { showMarkerShapes?: boolean; showMarkers?: boolean; cellLighting?: boolean; ambient?: [number, number, number] | null; snap?: Viewport['snap'] }): void {
    if (o.snap) this.snap = o.snap;
    if (o.ambient) this.cellAmbient.setRGB(o.ambient[0] / 255, o.ambient[1] / 255, o.ambient[2] / 255, THREE.SRGBColorSpace);
    if ((o.showMarkers !== undefined && o.showMarkers !== this.showMarkers) || (o.showMarkerShapes !== undefined && o.showMarkerShapes !== this.showMarkerShapes)) {
      this.showMarkers = o.showMarkers ?? this.showMarkers;
      this.showMarkerShapes = o.showMarkerShapes ?? this.showMarkerShapes;
      for (const e of this.entries.values()) this.applyVisibility(e);
    }
    if (o.cellLighting !== undefined) this.cellLighting = o.cellLighting;
    this.updateLights();
    this.updateGizmoSnap();
    this.invalidate();
  }

  setRefs(refs: PlacedRef[]): void {
    // A transform in progress on objects that are going away (cell switch, undo) is cancelled.
    if (this.modal) {
      const keep = new Set(refs.filter((r) => !r.deleted).map((r) => r.formKey));
      if (this.modal.keys.some((k) => !keep.has(k))) {
        if (this.modal.gizmo) this.gizmo.detach();
        this.cancelModal();
      }
    }
    const seen = new Set<FormKey>();
    for (const ref of refs) {
      if (ref.deleted) continue;
      seen.add(ref.formKey);
      let e = this.entries.get(ref.formKey);
      if (!e) {
        const obj = new THREE.Group();
        obj.userData.formKey = ref.formKey;
        this.root.add(obj);
        e = { ref, obj };
        this.entries.set(ref.formKey, e);
      }
      e.ref = ref;
      const key = this.contentKeyOf(ref);
      if (e.contentKey !== key) this.loadContent(e, key);
      const inModal = this.modal?.keys.includes(ref.formKey);
      if (!inModal) this.applyTransform(e.obj, ref.transform);
      this.applyVisibility(e);
    }
    for (const [k, e] of this.entries) {
      if (seen.has(k)) continue;
      this.root.remove(e.obj);
      if (e.box) this.helpers.remove(e.box);
      this.entries.delete(k);
    }
    this.selection = this.selection.filter((k) => this.entries.has(k));
    this.refreshSelectionHelpers();
    this.updateLights();
    if (this.pendingGrab && this.pendingGrab.every((k) => this.entries.has(k))) {
      const keys = this.pendingGrab;
      this.pendingGrab = undefined;
      this.startModal('move', keys);
    }
    this.invalidate(true);
  }

  private contentKeyOf(ref: PlacedRef): string {
    if (ref.sig === 'ACHR' || ref.baseSig === 'NPC_') return 'actor';
    if (ref.model) return `mesh:${ref.model.toLowerCase()}`;
    if (ref.baseSig === 'LIGH') return 'light';
    return 'marker';
  }

  private loadContent(e: Entry, key: string): void {
    e.contentKey = key;
    for (const c of [...e.obj.children]) e.obj.remove(c);
    const set = (o: THREE.Object3D) => {
      if (e.contentKey !== key) return;
      for (const c of [...e.obj.children]) e.obj.remove(c);
      o.traverse((c) => {
        c.userData.formKey = e.ref.formKey;
        // Editor-only shapes inside meshes (the boxes on effects, markers on furniture) follow the markers toggle.
        if (c.userData.editorMarker) c.visible = this.markerShapeVisible(e, c);
      });
      e.obj.add(o);
      e.box?.setFromObject(e.obj);
      this.invalidate(true);
    };
    if (key === 'actor') {
      // A capsule while the character's body, armor and head load; then the real thing.
      set(placeholder('actor'));
      if (e.ref.base && this.showActors) void this.actorObject(e.ref.base).then((o) => o && set(o));
    }
    else if (key === 'light') set(placeholder('light'));
    else if (key === 'marker') set(placeholder('marker'));
    else {
      set(placeholder('marker'));
      void this.assets.mesh(e.ref.model!).then((tpl) => {
        if (this.disposed) return;
        // An effect (mist, smoke) has nothing drawable here: show its small marker instead of "missing".
        if (tpl && !tpl.children.length && /^effects[\\/]/i.test(e.ref.model!.replace(/^meshes[\\/]/i, ''))) {
          const mark = placeholder('marker');
          mark.userData.editorMarker = true;
          mark.userData.markerObject = true;
          set(mark);
        }
        else if (!tpl || !tpl.children.length) set(placeholder('missing'));
        else set(tpl.clone());
      });
    }
  }

  private actorTemplates = new Map<FormKey, Promise<THREE.Group | null>>();
  /** Draw characters with their real models (off: capsules, faster with many characters). */
  showActors = true;

  /** One template group per character base: its model pieces in rest pose, scaled to its height. */
  private actorObject(base: FormKey): Promise<THREE.Group | null> {
    let p = this.actorTemplates.get(base);
    if (!p) {
      p = this.client
        .call('actorModel', base)
        .then(async (m) => {
          if (!m || !m.parts.length) return null;
          // Bodies and armor: heavy (_1) and thin (_0) meshes blended by the character's weight, so necks meet heads.
          const meshes = await Promise.all(
            m.parts.map(async (part) => {
              const light = part.kind === 'head' ? undefined : lightVariant(part.model);
              const [heavy, thin] = await Promise.all([this.assets.mesh(part.model), light ? this.assets.mesh(light) : null]);
              return heavy && part.kind !== 'head' ? atWeight(heavy, thin, m.weight) : (heavy?.clone() ?? null);
            }),
          );
          const g = new THREE.Group();
          for (const t of meshes) if (t && t.children.length) g.add(t);
          if (!g.children.length) return null;
          // Keep the placeholder until the textures are on (half-loaded characters show white skin and black clothes).
          const ready: Promise<unknown>[] = [];
          g.traverse((o) => {
            const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
            if ((o as THREE.Mesh).isMesh && mat && !Array.isArray(mat) && mat.userData.ready) ready.push(mat.userData.ready as Promise<unknown>);
          });
          await Promise.race([Promise.all(ready).catch(() => undefined), new Promise((r) => setTimeout(r, 20000))]);
          // Skin takes this character's skin tone (texture × tone × 2 in gamma space, as in game), and hair, beards and
          // brows take their hair colour (as in the character creator): per-character copies of the shared materials
          // that follow them as their textures arrive.
          const tone = m.skinTone ? [m.skinTone.r, m.skinTone.g, m.skinTone.b].map((v) => Math.pow(2 * v, 2.2)) : undefined;
          const hair = m.hairColor ? new THREE.Color().setRGB(m.hairColor.r, m.hairColor.g, m.hairColor.b, THREE.SRGBColorSpace).multiplyScalar(2.2) : undefined;
          const skinCopies = new Map<THREE.Material, THREE.MeshStandardMaterial>();
          // Skin and clothes ignore their vertex colours in game (they're often black). These meshes are only used by
          // characters, so the shared materials are changed in place (copies would miss textures that load later).
          g.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals();
            for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
              if ((mat as THREE.MeshStandardMaterial).vertexColors) {
                (mat as THREE.MeshStandardMaterial).vertexColors = false;
                mat.needsUpdate = true;
              }
            }
            const src = mesh.material as THREE.MeshStandardMaterial;
            const isSkin = !!tone && src.userData.shaderType === 5;
            const isHair = !!hair && src.userData.shaderType === 6;
            if (!Array.isArray(mesh.material) && (isSkin || isHair)) {
              let copy = skinCopies.get(src);
              if (!copy) {
                copy = src.clone();
                if (isSkin) copy.color.setRGB(tone![0]!, tone![1]!, tone![2]!);
                else copy.color.copy(hair!);
                skinCopies.set(src, copy);
              }
              const c = copy;
              mesh.material = c;
              mesh.onBeforeRender = () => {
                if (c.map !== src.map || c.normalMap !== src.normalMap) {
                  c.map = src.map;
                  c.normalMap = src.normalMap;
                  c.normalMapType = src.normalMapType;
                  c.roughness = src.roughness;
                  c.onBeforeCompile = src.onBeforeCompile;
                  c.customProgramCacheKey = src.customProgramCacheKey;
                  c.needsUpdate = true;
                }
              };
            }
          });
          g.scale.setScalar(m.scale);
          g.userData.actorNotes = m.notes;
          return g;
        })
        .catch(() => null);
      this.actorTemplates.set(base, p);
    }
    return p.then((g) => {
      if (!g) return null;
      const c = g.clone();
      // clone() drops per-mesh render hooks: carry the skin-material sync over.
      const src: THREE.Mesh[] = [];
      g.traverse((o) => (o as THREE.Mesh).isMesh && src.push(o as THREE.Mesh));
      let i = 0;
      c.traverse((o) => {
        if (!(o as THREE.Mesh).isMesh) return;
        const from = src[i++];
        if (from) (o as THREE.Mesh).onBeforeRender = from.onBeforeRender;
      });
      return c;
    });
  }

  setShowActors(on: boolean): void {
    if (this.showActors === on) return;
    this.showActors = on;
    this.refreshActors();
  }

  /** Forget character models (after edits to looks or outfits), so they're rebuilt next time. */
  refreshActors(): void {
    this.actorTemplates.clear();
    for (const e of this.entries.values()) if (e.contentKey === 'actor') this.loadContent(e, 'actor');
  }

  private applyVisibility(e: Entry): void {
    e.obj.visible = !this.hidden.has(e.ref.formKey) && (this.showMarkers || !(e.ref.marker || e.contentKey === 'marker'));
    e.obj.traverse((c) => {
      if (c.userData.editorMarker) c.visible = this.markerShapeVisible(e, c);
    });
  }

  /** Marker objects (X markers, effects) show with the markers; marker shapes inside furniture and perches have their own switch. */
  private markerShapeVisible(e: Entry, c: THREE.Object3D): boolean {
    return e.ref.marker || c.userData.markerObject ? this.showMarkers : this.showMarkers && this.showMarkerShapes;
  }

  private applyTransform(obj: THREE.Object3D, t: Transform): void {
    obj.position.set(t.position.x, t.position.y, t.position.z);
    obj.quaternion.copy(skyrimQuaternion(t.rotation));
    obj.scale.setScalar(t.scale || 1);
    obj.updateMatrixWorld(true);
  }

  private readTransform(obj: THREE.Object3D): Transform {
    const r = (n: number, p = 1000) => Math.round(n * p) / p;
    const rot = skyrimRotation(obj.quaternion);
    return {
      position: { x: r(obj.position.x), y: r(obj.position.y), z: r(obj.position.z) },
      rotation: { x: r(rot.x, 1e6), y: r(rot.y, 1e6), z: r(rot.z, 1e6) },
      scale: r(obj.scale.x, 1e4),
    };
  }

  /** Ground textures per cell, kept across refreshes (the painted layers don't change while sculpting). */
  private landTextures = new Map<FormKey, Promise<THREE.Texture | null>>();

  /** Show newly painted ground: drop the cached textures of these cells and re-bake them. */
  refreshGround(cells: FormKey[]): void {
    for (const cell of cells) {
      this.landTextures.delete(cell);
      const mesh = this.terrainGroup.children.find((c) => c.userData.cell === cell) as THREE.Mesh | undefined;
      const mat = mesh?.material as THREE.MeshStandardMaterial | undefined;
      if (!mat) continue;
      void this.landTexture(cell).then((tex) => {
        if (!tex || this.disposed) return;
        mat.map?.dispose();
        mat.map = tex;
        mat.color.setRGB(1, 1, 1);
        mat.needsUpdate = true;
        this.invalidate();
      });
    }
  }

  private landTexture(cell: FormKey): Promise<THREE.Texture | null> {
    let p = this.landTextures.get(cell);
    if (!p) {
      p = this.client
        .call('terrainTexture', cell)
        .then((t) => {
          if (!t) return null;
          const tex = new THREE.DataTexture(t.rgba, t.width, t.height, THREE.RGBAFormat);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.magFilter = THREE.LinearFilter;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.generateMipmaps = true;
          tex.anisotropy = 4;
          tex.needsUpdate = true;
          return tex;
        })
        .catch(() => null);
      this.landTextures.set(cell, p);
    }
    return p;
  }

  setTerrain(lands: TerrainData[]): void {
    for (const c of [...this.terrainGroup.children]) {
      this.terrainGroup.remove(c);
      (c as THREE.Mesh).geometry.dispose();
    }
    for (const land of lands) {
      const pos = new Float32Array(33 * 33 * 3);
      const col = new Float32Array(33 * 33 * 3);
      const uv = new Float32Array(33 * 33 * 2);
      for (let r = 0; r < 33; r++)
        for (let c = 0; c < 33; c++) {
          const i = r * 33 + c;
          pos.set([land.origin.x + c * 128, land.origin.y + r * 128, land.heights[i]!], i * 3);
          // Vertex colours (VCLR) shade the ground texture, as in game.
          const k = land.colors ? [land.colors[i * 3]! / 255, land.colors[i * 3 + 1]! / 255, land.colors[i * 3 + 2]! / 255] : [1, 1, 1];
          col.set(k, i * 3);
          uv.set([c / 32, r / 32], i * 2);
        }
      const idx: number[] = [];
      for (let r = 0; r < 32; r++)
        for (let c = 0; c < 32; c++) {
          const a = r * 33 + c;
          idx.push(a, a + 1, a + 34, a, a + 34, a + 33);
        }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      // Grass green until the cell's own ground texture arrives (or when it has none).
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, color: new THREE.Color(0.42, 0.5, 0.32) });
      const m = new THREE.Mesh(g, mat);
      m.userData.terrain = true;
      m.userData.cell = land.cell;
      this.terrainGroup.add(m);
      if (land.cell)
        void this.landTexture(land.cell).then((tex) => {
          if (!tex || this.disposed) return;
          mat.map = tex;
          mat.color.setRGB(1, 1, 1);
          mat.needsUpdate = true;
          this.invalidate();
        });
    }
    this.invalidate();
  }

  setCellContext(c: { interior: boolean; grid?: { x: number; y: number } }): void {
    this.buildGrid(c.grid ? c.grid.x * 4096 + 2048 : 0, c.grid ? c.grid.y * 4096 + 2048 : 0, !c.interior);
  }

  private buildGrid(cx: number, cy: number, exterior: boolean): void {
    for (const c of [...this.helpers.children]) if (c.userData.grid) this.helpers.remove(c);
    const grid = new THREE.GridHelper(exterior ? 4096 : 8192, exterior ? 32 : 64, 0x55555a, 0x3a3a3e);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(cx, cy, 0);
    grid.userData.grid = true;
    (grid.material as THREE.Material).depthWrite = false;
    grid.renderOrder = -1;
    this.helpers.add(grid);
    for (const a of ['x', 'y'] as Axis[]) {
      const d = AXES[a].clone().multiplyScalar(exterior ? 2048 : 4096);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(cx, cy, 0).sub(d), new THREE.Vector3(cx, cy, 0).add(d)]), new THREE.LineBasicMaterial({ color: AXIS_COLORS[a], transparent: true, opacity: 0.55 }));
      line.userData.grid = true;
      this.helpers.add(line);
    }
  }

  setNavmeshes(list: { key: FormKey; nav: Navmesh; mine: boolean }[]): void {
    if (this.navMove) this.endNavMove(false);
    this.navMeshes = list;
    if (this.navEdit) {
      const cur = list.find((n) => n.key === this.navEdit!.key);
      if (cur) this.navEdit.nav = cur.nav;
      else this.navEdit = undefined;
    }
    this.rebuildNav();
  }

  setNavEdit(key: FormKey | null): void {
    const n = key ? this.navMeshes.find((m) => m.key === key) : undefined;
    this.navEdit = n ? { key: n.key, nav: n.nav, selected: new Set() } : undefined;
    if (!this.navEdit && this.navDraw) this.setNavDraw(false);
    if (this.navEdit) this.setSelection([]);
    this.rebuildNav();
  }

  get navSelection(): number[] {
    return [...(this.navEdit?.selected ?? [])];
  }

  setNavSelection(tris: number[]): void {
    if (!this.navEdit) return;
    this.navEdit.selected = new Set(tris);
    this.rebuildNav();
  }

  /** Toggle the navmesh draw tool (click three points to add a triangle; Esc stops). */
  // ---------------------------------------------------------------- environment tools

  setKitSnap(on: boolean): void {
    this.kitSnap = on;
  }

  /** Paint mode: a circle follows the cursor; drag to paint, Ctrl+drag to erase, [ and ] resize. */
  setBrush(opts: { radius: number; sculpt?: { mode: SculptOptions['mode']; strength: number }; hint?: string } | null): void {
    if (this.brush) this.helpers.remove(this.brush.ring);
    this.clearToolHelpers('brushDab');
    this.brush = undefined;
    if (opts) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 64; i++) pts.push(new THREE.Vector3(Math.cos((i / 64) * Math.PI * 2), Math.sin((i / 64) * Math.PI * 2), 0));
      const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x6ee7a8, depthTest: false }));
      ring.renderOrder = 13;
      ring.scale.setScalar(opts.radius);
      ring.visible = false;
      this.helpers.add(ring);
      this.brush = { radius: opts.radius, ring, painting: false, erase: false, points: [], sculpt: opts.sculpt };
      this.cb.status(
        opts.sculpt
          ? `Terrain: drag to ${opts.sculpt.mode}${opts.sculpt.mode === 'raise' ? ' · Ctrl+drag to lower' : opts.sculpt.mode === 'lower' ? ' · Ctrl+drag to raise' : ''} · [ ] brush size · Esc to stop`
          : (opts.hint ?? 'Paint: drag to paint · Ctrl+drag to erase · [ ] brush size · Esc to stop'),
      );
    } else this.cb.status(null);
    this.invalidate();
  }

  /** Change the terrain brush's mode or strength without leaving it. */
  setSculpt(sculpt: { mode: SculptOptions['mode']; strength: number }): void {
    if (this.brush?.sculpt) this.brush.sculpt = sculpt;
  }

  /** Point on the terrain under the cursor (falls back to anything under it). */
  private pickTerrain(clientX: number, clientY: number): THREE.Vector3 {
    const ray = this.rayAt(clientX, clientY);
    const hit = ray.intersectObjects([this.terrainGroup], true).find((h) => (h.object as THREE.Mesh).isMesh);
    return hit ? hit.point.clone() : this.pickPoint(clientX, clientY);
  }

  /** Build the live height field from the terrain meshes in view (cells share edge vertices). */
  private startSculpt(): void {
    const b = this.brush!;
    const field = new HeightField();
    const verts = new Map<string, [THREE.Mesh, number][]>();
    for (const m of this.terrainGroup.children as THREE.Mesh[]) {
      const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const gx = Math.round(pos.getX(i) / 128);
        const gy = Math.round(pos.getY(i) / 128);
        const k = field.key(gx, gy);
        field.set(gx, gy, pos.getZ(i));
        const list = verts.get(k);
        if (list) list.push([m, i]);
        else verts.set(k, [[m, i]]);
      }
    }
    b.live = { field, verts, dirty: new Set() };
  }

  private sculptLive(p: THREE.Vector3): void {
    const b = this.brush!;
    if (!b.sculpt || !b.live) return;
    const mode = b.erase && b.sculpt.mode === 'raise' ? 'lower' : b.erase && b.sculpt.mode === 'lower' ? 'raise' : b.sculpt.mode;
    if (mode === 'flatten' && b.live.flattenTo === undefined) b.live.flattenTo = b.live.field.heightAt(p.x, p.y);
    const changed = sculptDab(b.live.field, p, { mode, radius: b.radius, strength: b.sculpt.strength, flattenTo: b.live.flattenTo });
    for (const k of changed) {
      const [gx, gy] = k.split(',').map(Number) as [number, number];
      const h = b.live.field.get(gx, gy)!;
      for (const [m, i] of b.live.verts.get(k) ?? []) {
        (m.geometry.getAttribute('position') as THREE.BufferAttribute).setZ(i, h);
        b.live.dirty.add(m);
      }
    }
    for (const m of b.live.dirty) {
      m.geometry.getAttribute('position').needsUpdate = true;
      m.geometry.computeVertexNormals();
      m.geometry.computeBoundingSphere();
      m.geometry.computeBoundingBox();
    }
    b.live.dirty.clear();
    this.invalidate();
  }

  setBrushRadius(r: number): void {
    if (!this.brush) return;
    this.brush.radius = r;
    this.brush.ring.scale.setScalar(r);
    this.invalidate();
  }

  get isPainting(): boolean {
    return !!this.brush;
  }

  /** Path mode: click points; Enter, double-click or right-click to finish; Backspace undoes a point. */
  setPathDraw(on: boolean): void {
    this.pathDraw = on ? { points: [] } : undefined;
    this.drawToolPoints();
    this.cb.status(on ? 'Path: click points along the way · Enter / right-click to finish · Backspace removes the last point · Esc cancels' : null);
  }

  get isDrawingPath(): boolean {
    return !!this.pathDraw;
  }

  /** The next click in the view returns a point (Esc returns null). */
  pickPointOnce(message: string): Promise<{ x: number; y: number; z: number } | null> {
    this.pointPick?.(null);
    this.cb.status(`${message} · Esc to cancel`);
    return new Promise((resolve) => {
      this.pointPick = (p) => {
        this.pointPick = undefined;
        this.cb.status(null);
        resolve(p);
      };
    });
  }

  private clearToolHelpers(tag: string): void {
    for (const c of [...this.helpers.children]) if (c.userData[tag]) this.helpers.remove(c);
  }

  private drawToolPoints(): void {
    this.clearToolHelpers('pathDraw');
    const pts = this.pathDraw?.points ?? [];
    for (const p of pts) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(Math.max(4, this.dist / 250), 10, 8), new THREE.MeshBasicMaterial({ color: 0x6ee7a8, depthTest: false }));
      m.position.copy(p);
      m.renderOrder = 12;
      m.userData.pathDraw = true;
      this.helpers.add(m);
    }
    if (pts.length >= 2) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map((p) => p.clone().setZ(p.z + 4))), new THREE.LineBasicMaterial({ color: 0x6ee7a8, depthTest: false }));
      line.userData.pathDraw = true;
      line.renderOrder = 12;
      this.helpers.add(line);
    }
    this.invalidate();
  }

  private brushDab(p: THREE.Vector3): void {
    const b = this.brush!;
    b.points.push(p.clone());
    if (b.sculpt) {
      this.sculptLive(p);
      return;
    }
    const dot = new THREE.Mesh(new THREE.CircleGeometry(b.radius, 32), new THREE.MeshBasicMaterial({ color: b.erase ? 0xff6b6b : 0x6ee7a8, transparent: true, opacity: 0.18, depthTest: false }));
    dot.position.copy(p).setZ(p.z + 2);
    dot.renderOrder = 11;
    dot.userData.brushDab = true;
    this.helpers.add(dot);
    this.invalidate();
  }

  private endBrushStroke(): void {
    const b = this.brush;
    if (!b?.painting) return;
    b.painting = false;
    const pts = b.points.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    b.points = [];
    b.live = undefined;
    this.clearToolHelpers('brushDab');
    this.invalidate();
    if (pts.length) this.cb.brushStroke?.(pts, b.erase);
  }

  private finishPath(): void {
    const pts = this.pathDraw?.points.map((p) => ({ x: p.x, y: p.y, z: p.z })) ?? [];
    this.setPathDraw(false);
    if (pts.length >= 2) this.cb.pathDone?.(pts);
    else this.cb.toolCancelled?.();
  }

  /** Bounding boxes of other objects near the selection, for kit snapping during a move. */
  private prepareKitSnap(keys: FormKey[]): void {
    this.kitTargets = undefined;
    this.kitStart = undefined;
    if (!this.kitSnap) return;
    const start = new THREE.Box3();
    for (const k of keys) start.expandByObject(this.entries.get(k)!.obj);
    if (start.isEmpty()) return;
    const center = start.getCenter(new THREE.Vector3());
    const moving = new Set(keys);
    const targets: { key: FormKey; box: THREE.Box3 }[] = [];
    for (const e of this.entries.values()) {
      if (moving.has(e.ref.formKey) || !e.obj.visible || e.ref.marker) continue;
      if (e.obj.position.distanceTo(center) > 4000) continue;
      const box = new THREE.Box3().setFromObject(e.obj);
      if (!box.isEmpty()) targets.push({ key: e.ref.formKey, box });
    }
    this.kitStart = start;
    this.kitTargets = targets;
  }

  /** Nudge a move so the moved box's faces line up with a neighbour's (touching or flush). */
  private kitSnapDelta(delta: THREE.Vector3, axis: Axis | null, plane: boolean): { delta: THREE.Vector3; to?: FormKey } {
    if (!this.kitStart || !this.kitTargets?.length) return { delta };
    const moved = this.kitStart.clone().translate(delta);
    const threshold = Math.max(4, this.dist * 0.012);
    const axes: Axis[] = axis && !plane ? [axis] : (['x', 'y', 'z'] as Axis[]).filter((a) => !(axis && plane && a === axis));
    const out = delta.clone();
    let to: FormKey | undefined;
    for (const a of axes) {
      let best = threshold;
      let adj = 0;
      const others = (['x', 'y', 'z'] as Axis[]).filter((o) => o !== a);
      for (const t of this.kitTargets) {
        // Only neighbours that overlap (or nearly touch) on the other two axes.
        if (others.some((o) => t.box.min[o] > moved.max[o] + threshold || t.box.max[o] < moved.min[o] - threshold)) continue;
        for (const d of [t.box.min[a] - moved.max[a], t.box.max[a] - moved.min[a], t.box.min[a] - moved.min[a], t.box.max[a] - moved.max[a]]) {
          if (Math.abs(d) < best) {
            best = Math.abs(d);
            adj = d;
            to = t.key;
          }
        }
      }
      out[a] += adj;
    }
    return { delta: out, to };
  }

  setNavDraw(on: boolean): void {
    this.navDraw = on && this.navEdit ? { points: [] } : undefined;
    this.drawNavPoints();
    this.cb.navDrawChanged?.(!!this.navDraw);
    this.cb.status(this.navDraw ? 'Draw: click 3 points to add a triangle (snaps to existing vertices) · Esc to stop' : null);
  }

  get isNavDrawing(): boolean {
    return !!this.navDraw;
  }

  private drawNavPoints(): void {
    for (const c of [...this.helpers.children]) if (c.userData.navDraw) this.helpers.remove(c);
    for (const p of this.navDraw?.points ?? []) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(Math.max(4, this.dist / 250), 10, 8), new THREE.MeshBasicMaterial({ color: 0xffb340, depthTest: false }));
      m.position.copy(p);
      m.renderOrder = 12;
      m.userData.navDraw = true;
      this.helpers.add(m);
    }
    const pts = this.navDraw?.points ?? [];
    if (pts.length >= 2) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffb340, depthTest: false }));
      line.userData.navDraw = true;
      line.renderOrder = 12;
      this.helpers.add(line);
    }
    this.invalidate();
  }

  /** A point for navmesh drawing: geometry under the cursor, snapped to a nearby existing vertex. */
  private navPointAt(clientX: number, clientY: number): THREE.Vector3 {
    const ray = this.rayAt(clientX, clientY);
    const hits = ray.intersectObjects([this.root, this.terrainGroup, this.navGroup], true).filter((h) => h.object.visible && (h.object as THREE.Mesh).isMesh);
    const p = hits[0]?.point.clone() ?? this.pickPoint(clientX, clientY);
    const nav = this.navEdit?.nav;
    if (nav) {
      // Snap within ~12 screen pixels.
      const sp = new THREE.Vector2(clientX, clientY);
      let best: THREE.Vector3 | undefined;
      let bestD = 12;
      for (const v of nav.vertices) {
        const w = new THREE.Vector3(v.x, v.y, v.z);
        const d = this.toScreen(w).distanceTo(sp);
        if (d < bestD) {
          bestD = d;
          best = w;
        }
      }
      if (best) return best;
    }
    return p;
  }

  private startNavMove(): void {
    const ne = this.navEdit;
    if (!ne || !ne.selected.size) return;
    const verts = [...new Set([...ne.selected].flatMap((t) => ne.nav.triangles[t]?.v ?? []))];
    const start = verts.map((i) => new THREE.Vector3(ne.nav.vertices[i]!.x, ne.nav.vertices[i]!.y, ne.nav.vertices[i]!.z));
    const pivot = start.reduce((a, b) => a.add(b), new THREE.Vector3()).divideScalar(start.length);
    this.navMove = { verts, start, pivot, mouse0: this.mouse.clone(), axis: null, plane: false, typed: '' };
    this.updateNavMove();
  }

  private updateNavMove(): void {
    const m = this.navMove;
    const ne = this.navEdit;
    if (!m || !ne) return;
    const typed = m.typed !== '' && m.typed !== '-' && m.typed !== '.' ? Number(m.typed) : undefined;
    const delta = this.moveDelta(m.pivot, m.mouse0, m.axis, m.plane, typed);
    m.verts.forEach((vi, i) => {
      const p = m.start[i]!.clone().add(delta);
      ne.nav.vertices[vi] = { x: p.x, y: p.y, z: p.z };
    });
    this.rebuildNav();
    this.drawAxisGuide(m);
    this.cb.status(`Move ${m.verts.length} navmesh vertices  X ${delta.x.toFixed(1)}  Y ${delta.y.toFixed(1)}  Z ${delta.z.toFixed(1)}${m.axis ? `   ${m.plane ? 'plane ⟂ ' : 'along '}${m.axis.toUpperCase()}` : ''}${m.typed ? `   [${m.typed}]` : ''}`);
  }

  private endNavMove(confirm: boolean): void {
    const m = this.navMove;
    const ne = this.navEdit;
    this.navMove = undefined;
    this.drawAxisGuide(undefined);
    this.cb.status(null);
    if (!m || !ne) return;
    if (confirm) {
      const moves = m.verts.map((vi) => ({ index: vi, ...ne.nav.vertices[vi]! }));
      this.cb.navMoveVertices?.(moves);
    } else {
      m.verts.forEach((vi, i) => (ne.nav.vertices[vi] = { x: m.start[i]!.x, y: m.start[i]!.y, z: m.start[i]!.z }));
      this.rebuildNav();
    }
  }

  setNavVisible(v: boolean): void {
    this.navGroup.visible = v;
    this.invalidate();
  }

  private rebuildNav(): void {
    for (const c of [...this.navGroup.children]) {
      this.navGroup.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    }
    for (const n of this.navMeshes) {
      const editing = this.navEdit?.key === n.key;
      const nav = editing ? this.navEdit!.nav : n.nav;
      const pos = new Float32Array(nav.triangles.length * 9);
      const col = new Float32Array(nav.triangles.length * 9);
      nav.triangles.forEach((t, i) => {
        const sel = editing && this.navEdit!.selected.has(i);
        const color = sel ? [1, 0.55, 0.15] : t.flags & 0x0040 ? [0.25, 0.55, 1] : t.flags & 0x0200 ? [0.2, 0.8, 0.9] : t.flags & 0x0400 ? [0.95, 0.85, 0.2] : n.mine ? [0.3, 0.85, 0.35] : [0.55, 0.75, 0.55];
        for (let k = 0; k < 3; k++) {
          const v = nav.vertices[t.v[k]]!;
          pos.set([v.x, v.y, v.z + 3], i * 9 + k * 3);
          col.set(color, i * 9 + k * 3);
        }
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const fill = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: editing ? 0.5 : 0.32, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
      fill.userData.nav = n.key;
      const edges = new THREE.LineSegments(new THREE.WireframeGeometry(g), new THREE.LineBasicMaterial({ color: editing ? 0xc8ffc8 : 0x7fd88a, transparent: true, opacity: 0.45 }));
      this.navGroup.add(fill, edges);
    }
    this.invalidate();
  }

  // ---------------------------------------------------------------- selection

  setSelection(keys: FormKey[]): void {
    this.selection = keys.filter((k) => this.entries.has(k));
    this.refreshSelectionHelpers();
    this.invalidate();
  }

  getSelection(): FormKey[] {
    return [...this.selection];
  }

  private refreshSelectionHelpers(): void {
    for (const [k, e] of this.entries) {
      const idx = this.selection.indexOf(k);
      if (idx < 0) {
        if (e.box) {
          this.helpers.remove(e.box);
          e.box.dispose();
          e.box = undefined;
        }
        continue;
      }
      const color = idx === this.selection.length - 1 ? 0xffb340 : 0xe0701a;
      if (!e.box) {
        e.box = new THREE.BoxHelper(e.obj, color);
        (e.box.material as THREE.LineBasicMaterial).depthTest = false;
        e.box.renderOrder = 10;
        this.helpers.add(e.box);
      } else (e.box.material as THREE.LineBasicMaterial).color.setHex(color);
      e.box.update();
    }
    this.attachGizmo();
  }

  setTool(t: Tool): void {
    this.tool = t;
    this.attachGizmo();
    this.invalidate();
  }

  private attachGizmo(): void {
    const visible = this.selection.filter((k) => this.entries.get(k)?.obj.visible);
    if (this.tool === 'select' || !visible.length || this.navEdit) {
      this.gizmo.detach();
      return;
    }
    if (this.gizmo.dragging) return;
    this.gizmo.setMode(this.tool === 'move' ? 'translate' : this.tool === 'rotate' ? 'rotate' : 'scale');
    this.pivotProxy.position.copy(this.pivotOf(visible));
    this.pivotProxy.quaternion.identity();
    this.pivotProxy.scale.setScalar(1);
    this.pivotProxy.updateMatrixWorld(true);
    this.gizmo.attach(this.pivotProxy);
    this.updateGizmoSnap();
  }

  private get snapping(): boolean {
    return this.snapToggle !== this.ctrlHeld;
  }

  private updateGizmoSnap(): void {
    this.gizmo.setTranslationSnap(this.snapping ? this.snap.move : null);
    this.gizmo.setRotationSnap(this.snapping ? THREE.MathUtils.degToRad(this.snap.rotateDeg) : null);
    this.gizmo.setScaleSnap(this.snapping ? this.snap.scale : null);
  }

  setSnapping(on: boolean): void {
    this.snapToggle = on;
    this.updateGizmoSnap();
  }

  private pivotOf(keys: FormKey[]): THREE.Vector3 {
    const p = new THREE.Vector3();
    let n = 0;
    for (const k of keys) {
      const e = this.entries.get(k);
      if (!e) continue;
      p.add(e.obj.position);
      n++;
    }
    return n ? p.divideScalar(n) : p;
  }

  private emitSelect(keys: FormKey[]): void {
    this.setSelection(keys);
    this.cb.select(this.getSelection());
  }

  selectAll(): void {
    this.emitSelect([...this.entries.values()].filter((e) => e.obj.visible).map((e) => e.ref.formKey));
  }

  // ---------------------------------------------------------------- camera

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.updateCamera();
  }

  private dir(): THREE.Vector3 {
    return new THREE.Vector3(Math.cos(this.pitch) * Math.cos(this.yaw), Math.cos(this.pitch) * Math.sin(this.yaw), Math.sin(this.pitch));
  }

  private updateCamera(): void {
    const d = this.dir();
    const pos = this.target.clone().addScaledVector(d, this.dist);
    for (const cam of [this.persp, this.ortho]) {
      cam.position.copy(pos);
      cam.up.set(0, 0, 1);
      cam.lookAt(this.target);
    }
    const h = 2 * this.dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
    const w = h * this.persp.aspect;
    Object.assign(this.ortho, { left: -w / 2, right: w / 2, top: h / 2, bottom: -h / 2 });
    this.ortho.updateProjectionMatrix();
    this.persp.near = Math.max(1, this.dist / 2000);
    this.persp.updateProjectionMatrix();
    this.gizmo.camera = this.camera;
    this.invalidate();
  }

  /** Blender numpad views. */
  view(which: 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom', ortho = true): void {
    const views = { front: [-Math.PI / 2, 0], back: [Math.PI / 2, 0], right: [0, 0], left: [Math.PI, 0], top: [-Math.PI / 2, Math.PI / 2 - 1e-4], bottom: [-Math.PI / 2, -Math.PI / 2 + 1e-4] } as const;
    [this.yaw, this.pitch] = views[which];
    this.useOrtho = ortho;
    this.updateCamera();
  }

  toggleOrtho(): boolean {
    this.useOrtho = !this.useOrtho;
    this.updateCamera();
    return this.useOrtho;
  }

  get isOrtho(): boolean {
    return this.useOrtho;
  }

  frame(keys?: FormKey[], opts: { cell?: FormKey } = {}): void {
    const box = new THREE.Box3();
    const list = keys?.length ? keys.map((k) => this.entries.get(k)).filter((e): e is Entry => !!e) : [...this.entries.values()].filter((e) => e.obj.visible && !e.ref.marker);
    for (const e of list) box.expandByObject(e.obj);
    // Outdoors: frame the current cell's ground (not the whole loaded area).
    if (!keys?.length || opts.cell) for (const t of this.terrainGroup.children) if (!opts.cell || t.userData.cell === opts.cell) box.expandByObject(t);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    this.target.copy(sphere.center);
    this.dist = Math.max(80, (sphere.radius / Math.sin(THREE.MathUtils.degToRad(this.persp.fov / 2))) * 0.9);
    this.updateCamera();
  }

  /** World point under the cursor (geometry, terrain, or the ground plane). */
  pickPoint(clientX: number, clientY: number): THREE.Vector3 {
    const ray = this.rayAt(clientX, clientY);
    const hits = ray.intersectObjects([this.root, this.terrainGroup], true).filter((h) => h.object.visible && (h.object as THREE.Mesh).isMesh);
    if (hits[0]) return hits[0].point.clone();
    const p = new THREE.Vector3();
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -this.groundZ());
    return ray.ray.intersectPlane(plane, p) ?? this.target.clone();
  }

  private groundZ(): number {
    return this.terrainGroup.children.length ? this.target.z : 0;
  }

  private rayAt(clientX: number, clientY: number): THREE.Raycaster {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    return rc;
  }

  private toScreen(p: THREE.Vector3): THREE.Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const v = p.clone().project(this.camera);
    return new THREE.Vector2(rect.left + ((v.x + 1) / 2) * rect.width, rect.top + ((1 - v.y) / 2) * rect.height);
  }

  private pickRef(clientX: number, clientY: number): FormKey | undefined {
    const hits = this.rayAt(clientX, clientY).intersectObject(this.root, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      let visible = true;
      while (o && o !== this.root) {
        if (!o.visible) visible = false;
        o = o.parent;
      }
      if (visible && h.object.userData.formKey) return h.object.userData.formKey as FormKey;
    }
    return undefined;
  }

  private pickNav(clientX: number, clientY: number): number | undefined {
    if (!this.navEdit) return undefined;
    const fill = this.navGroup.children.find((c) => c.userData.nav === this.navEdit!.key);
    if (!fill) return undefined;
    const hit = this.rayAt(clientX, clientY).intersectObject(fill, false)[0];
    return hit?.faceIndex ?? undefined;
  }

  // ---------------------------------------------------------------- input

  private onPointerDown = (e: PointerEvent): void => {
    this.renderer.domElement.focus({ preventScroll: true });
    this.mouse.set(e.clientX, e.clientY);
    if (this.modal && !this.modal.gizmo) {
      if (e.button === 0) this.confirmModal();
      else if (e.button === 2) this.cancelModal();
      e.preventDefault();
      return;
    }
    if (this.navMove) {
      this.endNavMove(e.button === 0);
      e.preventDefault();
      return;
    }
    if (this.pointPick && !e.altKey && e.button === 0) {
      e.preventDefault();
      const p = this.pickPoint(e.clientX, e.clientY);
      this.pointPick({ x: p.x, y: p.y, z: p.z });
      return;
    }
    if (this.pathDraw && !e.altKey && (e.button === 0 || e.button === 2)) {
      e.preventDefault();
      if (e.button === 2) return this.finishPath();
      if (e.detail >= 2 && this.pathDraw.points.length >= 2) return this.finishPath();
      this.pathDraw.points.push(this.pickPoint(e.clientX, e.clientY));
      this.drawToolPoints();
      return;
    }
    if (this.brush && !e.altKey && e.button === 0) {
      e.preventDefault();
      const b = this.brush;
      b.painting = true;
      b.erase = e.ctrlKey || e.metaKey;
      b.points = [];
      if (b.sculpt) this.startSculpt();
      this.brushDab(b.sculpt ? this.pickTerrain(e.clientX, e.clientY) : this.pickPoint(e.clientX, e.clientY));
      this.renderer.domElement.setPointerCapture(e.pointerId);
      return;
    }
    if (this.navDraw && !e.altKey && (e.button === 0 || e.button === 2)) {
      e.preventDefault();
      if (e.button === 2) return this.setNavDraw(false);
      this.navDraw.points.push(this.navPointAt(e.clientX, e.clientY));
      if (this.navDraw.points.length === 3) {
        const pts = this.navDraw.points.map((p) => ({ x: p.x, y: p.y, z: p.z }));
        // Keep the last two points so the next click continues a strip.
        this.navDraw.points = this.navDraw.points.slice(1);
        this.cb.navAddTriangle?.(pts);
      }
      this.drawNavPoints();
      return;
    }
    if (e.button === 0 && !e.altKey && this.gizmo.axis) return; // the gizmo handles it
    const mode = e.button === 1 || (e.button === 0 && e.altKey) ? (e.shiftKey ? 'pan' : e.ctrlKey ? 'zoom' : 'orbit') : e.button === 2 ? 'look' : e.button === 0 ? (this.boxMode ? 'box' : 'click') : undefined;
    if (!mode) return;
    if (mode === 'orbit' && this.useOrtho && this.pitch !== 0) this.useOrtho = false;
    this.drag = { mode, x: e.clientX, y: e.clientY, moved: false, shift: e.shiftKey };
    this.renderer.domElement.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  private onPointerMove = (e: PointerEvent): void => {
    const dx = e.clientX - this.mouse.x;
    const dy = e.clientY - this.mouse.y;
    this.mouse.set(e.clientX, e.clientY);
    if (this.modal && !this.modal.gizmo) {
      this.ctrlHeld = e.ctrlKey;
      this.altHeld = e.altKey;
      this.updateModal();
      return;
    }
    if (this.navMove) {
      this.ctrlHeld = e.ctrlKey;
      this.updateNavMove();
      return;
    }
    if (this.brush) {
      const b = this.brush;
      const p = b.sculpt ? this.pickTerrain(e.clientX, e.clientY) : this.pickPoint(e.clientX, e.clientY);
      b.ring.position.copy(p).setZ(p.z + 3);
      b.ring.visible = true;
      (b.ring.material as THREE.LineBasicMaterial).color.set(e.ctrlKey || e.metaKey || b.erase ? 0xff6b6b : 0x6ee7a8);
      if (b.painting) {
        const last = b.points[b.points.length - 1];
        // Terrain dabs are closer together so the stroke is even; dabs are measured across the ground only.
        const spacing = b.sculpt ? b.radius * 0.25 : b.radius * 0.6;
        if (!last || Math.hypot(last.x - p.x, last.y - p.y) > spacing) this.brushDab(p);
      }
      this.invalidate();
      if (!this.drag) return;
    }
    const d = this.drag;
    if (!d) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) d.moved = true;
    switch (d.mode) {
      case 'orbit':
        if (this.useOrtho) this.useOrtho = false;
        this.yaw -= dx * 0.006;
        this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.006, -Math.PI / 2 + 1e-3, Math.PI / 2 - 1e-3);
        this.updateCamera();
        break;
      case 'pan': {
        const wpp = (2 * this.dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2))) / this.renderer.domElement.clientHeight;
        const cam = this.camera;
        const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
        this.target.addScaledVector(right, -dx * wpp).addScaledVector(up, dy * wpp);
        this.updateCamera();
        break;
      }
      case 'zoom':
        this.dist = THREE.MathUtils.clamp(this.dist * Math.pow(1.01, dy), 20, 300000);
        this.updateCamera();
        break;
      case 'look': {
        if (!d.moved) break;
        const camPos = this.target.clone().addScaledVector(this.dir(), this.dist);
        this.yaw -= dx * 0.004;
        this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.004, -Math.PI / 2 + 1e-3, Math.PI / 2 - 1e-3);
        this.target.copy(camPos).addScaledVector(this.dir(), -this.dist);
        if (this.useOrtho) this.useOrtho = false;
        this.updateCamera();
        break;
      }
      case 'click':
        if (d.moved) d.mode = 'box';
        break;
    }
    if (d.mode === 'box' && d.moved) {
      const rect = this.container.getBoundingClientRect();
      Object.assign(this.boxEl.style, {
        display: 'block',
        left: `${Math.min(d.x, e.clientX) - rect.left}px`,
        top: `${Math.min(d.y, e.clientY) - rect.top}px`,
        width: `${Math.abs(e.clientX - d.x)}px`,
        height: `${Math.abs(e.clientY - d.y)}px`,
      });
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.brush?.painting && e.button === 0) {
      this.endBrushStroke();
      return;
    }
    const d = this.drag;
    this.drag = undefined;
    if (!d) return;
    if (d.mode === 'click' && !d.moved) {
      if (this.navEdit) {
        const tri = this.pickNav(e.clientX, e.clientY);
        const sel = new Set(e.shiftKey ? this.navEdit.selected : []);
        if (tri !== undefined) sel.has(tri) && e.shiftKey ? sel.delete(tri) : sel.add(tri);
        this.navEdit.selected = sel;
        this.rebuildNav();
        this.cb.navPick?.([...sel], e.shiftKey);
        return;
      }
      const k = this.pickRef(e.clientX, e.clientY);
      if (e.shiftKey) {
        if (!k) return;
        const sel = this.selection.filter((s) => s !== k);
        // Shift-click on the active object deselects it; on others makes them active.
        if (!(this.selection.includes(k) && this.selection[this.selection.length - 1] === k)) sel.push(k);
        this.emitSelect(sel);
      } else this.emitSelect(k ? [k] : []);
    } else if (d.mode === 'box' && d.moved) {
      this.boxEl.style.display = 'none';
      this.boxMode = false;
      const x0 = Math.min(d.x, e.clientX);
      const x1 = Math.max(d.x, e.clientX);
      const y0 = Math.min(d.y, e.clientY);
      const y1 = Math.max(d.y, e.clientY);
      const inside = (p: THREE.Vector3) => {
        const s = this.toScreen(p);
        const v = p.clone().project(this.camera);
        return v.z < 1 && s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1;
      };
      if (this.navEdit) {
        const nav = this.navEdit.nav;
        const sel = new Set(d.shift ? this.navEdit.selected : []);
        nav.triangles.forEach((t, i) => {
          const c = new THREE.Vector3();
          for (const vi of t.v) c.add(new THREE.Vector3(nav.vertices[vi]!.x, nav.vertices[vi]!.y, nav.vertices[vi]!.z));
          if (inside(c.divideScalar(3))) sel.add(i);
        });
        this.navEdit.selected = sel;
        this.rebuildNav();
        this.cb.navPick?.([...sel], d.shift);
        return;
      }
      const picked: FormKey[] = [];
      for (const en of this.entries.values()) {
        if (!en.obj.visible) continue;
        const b = new THREE.Box3().setFromObject(en.obj);
        if (inside(b.isEmpty() ? en.obj.position : b.getCenter(new THREE.Vector3()))) picked.push(en.ref.formKey);
      }
      this.emitSelect(d.shift ? [...new Set([...this.selection, ...picked])] : picked);
    } else {
      this.boxEl.style.display = 'none';
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (this.drag?.mode === 'look') {
      this.flySpeed = THREE.MathUtils.clamp(this.flySpeed * (e.deltaY < 0 ? 1.25 : 0.8), 50, 20000);
      this.cb.status(`Fly speed ${Math.round(this.flySpeed)}`);
      setTimeout(() => !this.modal && this.cb.status(null), 900);
      return;
    }
    this.dist = THREE.MathUtils.clamp(this.dist * (e.deltaY > 0 ? 1.15 : 1 / 1.15), 20, 300000);
    this.updateCamera();
  };

  private onBlur = (): void => {
    this.keysDown.clear();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keysDown.delete(e.code);
    if (e.key === 'Control') {
      this.ctrlHeld = false;
      this.updateGizmoSnap();
      if (this.modal) this.updateModal();
    }
    if (e.key === 'Alt') {
      this.altHeld = false;
      if (this.modal) this.updateModal();
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (document.querySelector('.modal-backdrop')) return;
    if (!this.hovered && !this.modal && document.activeElement !== this.renderer.domElement) return;
    this.keysDown.add(e.code);
    if (this.drag?.mode === 'look' && ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'].includes(e.code)) {
      e.preventDefault();
      return;
    }
    if ((this.modal && !this.modal.gizmo) || this.navMove) {
      // Nothing else may act while a transform is in progress (e.g. undo underneath it).
      e.stopImmediatePropagation();
      if ((e.ctrlKey || e.metaKey) && e.key !== 'Control' && e.key !== 'Meta') {
        e.preventDefault();
        return;
      }
    }
    if (this.modal && !this.modal.gizmo) {
      this.modalKey(e);
      return;
    }
    if (this.navMove) {
      e.preventDefault();
      e.stopPropagation();
      const nm = this.navMove;
      const key = e.key.toLowerCase();
      if (key === 'escape') return this.endNavMove(false);
      if (key === 'enter') return this.endNavMove(true);
      if (key === 'x' || key === 'y' || key === 'z') {
        if (nm.axis === key && nm.plane === e.shiftKey) nm.axis = null;
        else {
          nm.axis = key;
          nm.plane = e.shiftKey;
        }
      } else if (/^[0-9.]$/.test(e.key)) nm.typed += e.key;
      else if (e.key === '-') nm.typed = nm.typed.startsWith('-') ? nm.typed.slice(1) : `-${nm.typed}`;
      else if (key === 'backspace') nm.typed = nm.typed.slice(0, -1);
      return this.updateNavMove();
    }
    if (this.navDraw && e.key === 'Escape') {
      this.setNavDraw(false);
      e.preventDefault();
      return;
    }
    if (this.pointPick && e.key === 'Escape') {
      e.preventDefault();
      this.pointPick(null);
      this.cb.toolCancelled?.();
      return;
    }
    if (this.pathDraw) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.setPathDraw(false);
        this.cb.toolCancelled?.();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        this.finishPath();
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        this.pathDraw.points.pop();
        this.drawToolPoints();
        return;
      }
    }
    if (this.brush) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.setBrush(null);
        this.cb.toolCancelled?.();
        return;
      }
      if (e.key === '[' || e.key === ']') {
        e.preventDefault();
        const b = this.brush;
        b.radius = THREE.MathUtils.clamp(Math.round(b.radius * (e.key === ']' ? 1.25 : 0.8)), 16, 8192);
        b.ring.scale.setScalar(b.radius);
        this.cb.brushRadius?.(b.radius);
        this.invalidate();
        return;
      }
    }
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    const handled = (): void => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === 'Control') {
      this.ctrlHeld = true;
      this.updateGizmoSnap();
      return;
    }
    // Numpad views
    if (e.code.startsWith('Numpad')) {
      const n = e.code.slice(6);
      const map: Record<string, [Parameters<Viewport['view']>[0], Parameters<Viewport['view']>[0]]> = { '1': ['front', 'back'], '3': ['right', 'left'], '7': ['top', 'bottom'] };
      if (map[n]) {
        this.view(map[n][ctrl ? 1 : 0]);
        return handled();
      }
      if (n === '5') {
        this.toggleOrtho();
        return handled();
      }
      if (n === 'Decimal') {
        this.frame(this.selection);
        return handled();
      }
      const step = Math.PI / 12;
      if (n === '4' || n === '6') {
        this.yaw += n === '4' ? step : -step;
        this.useOrtho = false;
        this.updateCamera();
        return handled();
      }
      if (n === '8' || n === '2') {
        this.pitch = THREE.MathUtils.clamp(this.pitch + (n === '2' ? step : -step), -Math.PI / 2 + 1e-3, Math.PI / 2 - 1e-3);
        this.useOrtho = false;
        this.updateCamera();
        return handled();
      }
    }
    if (e.key === 'Home') {
      this.frame();
      return handled();
    }
    if (e.key === 'Tab' && !ctrl) {
      this.cb.tab?.();
      return handled();
    }
    if (this.navEdit) {
      if ((k === 'x' || e.key === 'Delete') && this.navEdit.selected.size) {
        this.cb.navDelete?.();
        return handled();
      }
      if (k === 'a' && !ctrl) {
        this.navEdit.selected = e.altKey ? new Set() : new Set(this.navEdit.nav.triangles.map((_, i) => i));
        this.rebuildNav();
        this.cb.navPick?.([...this.navEdit.selected], false);
        return handled();
      }
      if (k === 'b') {
        this.boxMode = true;
        return handled();
      }
      if (k === 'f') {
        this.frameNav();
        return handled();
      }
      if (k === 'g' && !ctrl && this.navEdit.selected.size) {
        this.startNavMove();
        return handled();
      }
      if (k === 'd' && !ctrl && !e.shiftKey) {
        this.setNavDraw(!this.navDraw);
        return handled();
      }
      return;
    }
    if (ctrl) {
      if (k === 'i') {
        this.emitSelect([...this.entries.values()].filter((en) => en.obj.visible && !this.selection.includes(en.ref.formKey)).map((en) => en.ref.formKey));
        return handled();
      }
      return;
    }
    switch (k) {
      case 'g':
      case 'r':
      case 's':
        if (e.shiftKey || e.altKey) return;
        if (this.selection.length) this.startModal(k === 'g' ? 'move' : k === 'r' ? 'rotate' : 'scale', this.selection);
        return handled();
      case 'a':
        if (e.altKey) this.emitSelect([]);
        else this.selectAll();
        return handled();
      case 'b':
        this.boxMode = true;
        this.cb.status('Box select: drag a rectangle');
        setTimeout(() => !this.modal && this.cb.status(null), 1500);
        return handled();
      case 'f':
        this.frame(this.selection);
        return handled();
      case 'x':
      case 'delete':
        if (this.selection.length) this.cb.remove(this.getSelection());
        return handled();
      case 'd':
        if (e.shiftKey && this.selection.length) {
          void this.cb.duplicate(this.getSelection()).then((keys) => {
            if (keys?.length) this.pendingGrab = keys;
          });
          return handled();
        }
        return;
      case 'h':
        if (e.altKey) this.hidden.clear();
        else if (e.shiftKey) for (const en of this.entries.values()) !this.selection.includes(en.ref.formKey) && this.hidden.add(en.ref.formKey);
        else {
          for (const s of this.selection) this.hidden.add(s);
          this.emitSelect([]);
        }
        for (const en of this.entries.values()) this.applyVisibility(en);
        this.cb.hiddenChanged();
        this.attachGizmo();
        this.invalidate();
        return handled();
    }
  };

  setHidden(keys: FormKey[], hidden: boolean): void {
    for (const k of keys) hidden ? this.hidden.add(k) : this.hidden.delete(k);
    for (const en of this.entries.values()) this.applyVisibility(en);
    this.cb.hiddenChanged();
    this.invalidate();
  }

  private frameNav(): void {
    if (!this.navEdit) return;
    const nav = this.navEdit.nav;
    const sel = this.navEdit.selected.size ? [...this.navEdit.selected] : nav.triangles.map((_, i) => i);
    const box = new THREE.Box3();
    for (const i of sel) for (const v of nav.triangles[i]!.v) box.expandByPoint(new THREE.Vector3(nav.vertices[v]!.x, nav.vertices[v]!.y, nav.vertices[v]!.z));
    if (box.isEmpty()) return;
    const s = box.getBoundingSphere(new THREE.Sphere());
    this.target.copy(s.center);
    this.dist = Math.max(200, s.radius * 2.2);
    this.updateCamera();
  }

  // ---------------------------------------------------------------- modal transforms (G / R / S)

  startModal(kind: ModalKind, keys: FormKey[]): void {
    const list = keys.filter((k) => this.entries.get(k)?.obj.visible);
    if (!list.length) return;
    this.gizmo.detach();
    const start = new Map<FormKey, { pos: THREE.Vector3; quat: THREE.Quaternion; scale: number }>();
    for (const k of list) {
      const o = this.entries.get(k)!.obj;
      start.set(k, { pos: o.position.clone(), quat: o.quaternion.clone(), scale: o.scale.x });
    }
    this.modal = { kind, keys: list, start, pivot: this.pivotOf(list), mouse0: this.mouse.clone(), axis: null, plane: false, typed: '' };
    if (kind === 'move') this.prepareKitSnap(list);
    this.updateModal();
  }

  get inModal(): boolean {
    return !!this.modal;
  }

  private modalKey(e: KeyboardEvent): void {
    const m = this.modal!;
    e.preventDefault();
    e.stopPropagation();
    const k = e.key.toLowerCase();
    if (k === 'escape') return this.cancelModal();
    if (k === 'enter' || e.code === 'NumpadEnter') return this.confirmModal();
    if (e.key === 'Control') {
      this.ctrlHeld = true;
      return this.updateModal();
    }
    if (e.key === 'Alt') {
      this.altHeld = true;
      return this.updateModal();
    }
    if (k === 'x' || k === 'y' || k === 'z') {
      if (m.axis === k && m.plane === e.shiftKey) m.axis = null;
      else {
        m.axis = k;
        m.plane = e.shiftKey && m.kind === 'move';
      }
      return this.updateModal();
    }
    if (m.kind !== 'scale' && (k === 'g' || k === 'r')) {
      // Switch between move and rotate like Blender.
      this.restoreModal();
      m.kind = k === 'g' ? 'move' : 'rotate';
      return this.updateModal();
    }
    if (/^[0-9]$/.test(e.key) || e.key === '.' || e.key === '-') {
      if (e.key === '-') m.typed = m.typed.startsWith('-') ? m.typed.slice(1) : `-${m.typed}`;
      else m.typed += e.key;
      return this.updateModal();
    }
    if (k === 'backspace') {
      m.typed = m.typed.slice(0, -1);
      return this.updateModal();
    }
  }

  private restoreModal(): void {
    const m = this.modal!;
    for (const [k, s] of m.start) {
      const o = this.entries.get(k)?.obj;
      if (!o) continue;
      o.position.copy(s.pos);
      o.quaternion.copy(s.quat);
      o.scale.setScalar(s.scale);
      o.updateMatrixWorld(true);
    }
  }

  private planeIntersect(clientX: number, clientY: number, plane: THREE.Plane): THREE.Vector3 | null {
    return this.rayAt(clientX, clientY).ray.intersectPlane(plane, new THREE.Vector3());
  }

  private updateModal(): void {
    const m = this.modal;
    if (!m) return;
    this.restoreModal();
    const typed = m.typed !== '' && m.typed !== '-' && m.typed !== '.' ? Number(m.typed) : undefined;
    const viewDir = this.target.clone().sub(this.camera.position).normalize();
    let text = '';
    const axisName = m.axis ? `${m.plane ? 'plane ⟂ ' : 'along '}${m.axis.toUpperCase()}` : '';
    if (m.kind === 'move') {
      let delta = this.moveDelta(m.pivot, m.mouse0, m.axis, m.plane, typed);
      let snappedTo: FormKey | undefined;
      if (this.kitSnap && !this.altHeld && typed === undefined) ({ delta, to: snappedTo } = this.kitSnapDelta(delta, m.axis, m.plane));
      for (const [k, s] of m.start) {
        const o = this.entries.get(k)!.obj;
        o.position.copy(s.pos).add(delta);
        o.updateMatrixWorld(true);
      }
      text = `Move  X ${delta.x.toFixed(1)}  Y ${delta.y.toFixed(1)}  Z ${delta.z.toFixed(1)}`;
      if (snappedTo) text += `   snapped to ${this.entries.get(snappedTo)?.ref.editorId ?? this.entries.get(snappedTo)?.ref.baseEditorId ?? 'neighbour'}`;
    } else if (m.kind === 'rotate') {
      const towardViewer = viewDir.clone().negate();
      const axis = m.axis ? AXES[m.axis].clone() : towardViewer;
      let deg: number;
      if (typed !== undefined && Number.isFinite(typed)) deg = typed;
      else {
        const c = this.toScreen(m.pivot);
        const a0 = Math.atan2(-(m.mouse0.y - c.y), m.mouse0.x - c.x);
        const a1 = Math.atan2(-(this.mouse.y - c.y), this.mouse.x - c.x);
        let ang = THREE.MathUtils.radToDeg(a1 - a0);
        if (m.axis && axis.dot(towardViewer) < 0) ang = -ang;
        deg = this.snapping ? Math.round(ang / this.snap.rotateDeg) * this.snap.rotateDeg : ang;
      }
      const q = new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(deg));
      for (const [k, s] of m.start) {
        const o = this.entries.get(k)!.obj;
        o.position.copy(s.pos).sub(m.pivot).applyQuaternion(q).add(m.pivot);
        o.quaternion.copy(q).multiply(s.quat);
        o.updateMatrixWorld(true);
      }
      text = `Rotate ${deg.toFixed(1)}°`;
    } else {
      let f: number;
      if (typed !== undefined && Number.isFinite(typed)) f = typed;
      else {
        const c = this.toScreen(m.pivot);
        const d0 = Math.max(4, m.mouse0.distanceTo(c));
        f = this.mouse.distanceTo(c) / d0;
        if (this.snapping) f = Math.max(this.snap.scale, Math.round(f / this.snap.scale) * this.snap.scale);
      }
      for (const [k, s] of m.start) {
        const o = this.entries.get(k)!.obj;
        const ns = THREE.MathUtils.clamp(s.scale * f, 0.01, 10);
        o.position.copy(s.pos).sub(m.pivot).multiplyScalar(ns / s.scale).add(m.pivot);
        o.scale.setScalar(ns);
        o.updateMatrixWorld(true);
      }
      text = `Scale ${f.toFixed(3)}${m.axis ? ' (Skyrim scale is always uniform)' : ''}`;
    }
    if (m.typed) text += `   [${m.typed}]`;
    const kitHint = m.kind === 'move' && this.kitSnap ? (this.altHeld ? '   kit snap off (Alt)' : text.includes('snapped to') ? '' : '   kit snap on (hold Alt to skip)') : '';
    this.cb.status(`${text}${axisName ? `   ${axisName}` : ''}${this.snapping ? '   snap' : ''}${kitHint}`);
    this.drawAxisGuide(m);
    this.invalidate(true);
  }

  /** World-space translation for a move drag (or typed value), honouring axis/plane constraints and snapping. */
  private moveDelta(pivot: THREE.Vector3, mouse0: THREE.Vector2, axis: Axis | null, planeLock: boolean, typed: number | undefined): THREE.Vector3 {
    if (typed !== undefined && Number.isFinite(typed)) return AXES[axis && !planeLock ? axis : 'x'].clone().multiplyScalar(typed);
    const viewDir = this.target.clone().sub(this.camera.position).normalize();
    let normal: THREE.Vector3;
    if (axis && !planeLock) {
      const a = AXES[axis];
      normal = a.clone().cross(viewDir.clone().cross(a));
      if (normal.lengthSq() < 1e-6) normal = viewDir.clone();
    } else if (axis && planeLock) normal = AXES[axis].clone();
    else normal = viewDir.clone();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal.normalize(), pivot);
    const p0 = this.planeIntersect(mouse0.x, mouse0.y, plane);
    const p1 = this.planeIntersect(this.mouse.x, this.mouse.y, plane);
    let delta = new THREE.Vector3();
    if (p0 && p1) {
      delta = p1.sub(p0);
      if (axis && !planeLock) delta = AXES[axis].clone().multiplyScalar(delta.dot(AXES[axis]));
      if (axis && planeLock) delta.sub(AXES[axis].clone().multiplyScalar(delta.dot(AXES[axis])));
    }
    if (this.snapping) delta.set(Math.round(delta.x / this.snap.move) * this.snap.move, Math.round(delta.y / this.snap.move) * this.snap.move, Math.round(delta.z / this.snap.move) * this.snap.move);
    return delta;
  }

  private drawAxisGuide(m: { pivot: THREE.Vector3; axis: Axis | null } | undefined): void {
    for (const c of [...this.helpers.children]) if (c.userData.guide) this.helpers.remove(c);
    if (!m?.axis) return;
    const d = AXES[m.axis].clone().multiplyScalar(100000);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([m.pivot.clone().sub(d), m.pivot.clone().add(d)]), new THREE.LineBasicMaterial({ color: AXIS_COLORS[m.axis], depthTest: false }));
    line.userData.guide = true;
    line.renderOrder = 11;
    this.helpers.add(line);
  }

  private confirmModal(): void {
    const m = this.modal;
    if (!m) return;
    this.modal = undefined;
    this.drawAxisGuide(undefined);
    this.cb.status(null);
    const changes = m.keys.map((k) => ({ ref: k, transform: this.readTransform(this.entries.get(k)!.obj) }));
    const moved = changes.some((c) => {
      const s = m.start.get(c.ref)!;
      const o = this.entries.get(c.ref)!.obj;
      return !s.pos.equals(o.position) || !s.quat.equals(o.quaternion) || s.scale !== o.scale.x;
    });
    if (moved) this.cb.commitTransforms(changes, m.kind === 'move' ? 'Move' : m.kind === 'rotate' ? 'Rotate' : 'Scale');
    this.attachGizmo();
    this.invalidate(true);
  }

  private cancelModal(): void {
    if (!this.modal) return;
    this.restoreModal();
    this.modal = undefined;
    this.drawAxisGuide(undefined);
    this.cb.status(null);
    this.attachGizmo();
    this.invalidate(true);
  }

  // ---------------------------------------------------------------- gizmo

  private beginGizmo(): void {
    const keys = this.selection.filter((k) => this.entries.get(k)?.obj.visible);
    const start = new Map<FormKey, { pos: THREE.Vector3; quat: THREE.Quaternion; scale: number }>();
    for (const k of keys) {
      const o = this.entries.get(k)!.obj;
      start.set(k, { pos: o.position.clone(), quat: o.quaternion.clone(), scale: o.scale.x });
    }
    this.modal = { kind: this.tool === 'rotate' ? 'rotate' : this.tool === 'scale' ? 'scale' : 'move', keys, start, pivot: this.pivotProxy.position.clone(), mouse0: this.mouse.clone(), axis: null, plane: false, typed: '', gizmo: true };
  }

  private updateGizmo(): void {
    const m = this.modal;
    if (!m?.gizmo) return;
    const p = this.pivotProxy;
    const dpos = p.position.clone().sub(m.pivot);
    const sv = [p.scale.x, p.scale.y, p.scale.z];
    const f = sv.reduce((best, v) => (Math.abs(v - 1) > Math.abs(best - 1) ? v : best), 1);
    for (const [k, s] of m.start) {
      const o = this.entries.get(k)!.obj;
      if (m.kind === 'move') o.position.copy(s.pos).add(dpos);
      else if (m.kind === 'rotate') {
        o.position.copy(s.pos).sub(m.pivot).applyQuaternion(p.quaternion).add(m.pivot);
        o.quaternion.copy(p.quaternion).multiply(s.quat);
      } else {
        const ns = THREE.MathUtils.clamp(s.scale * f, 0.01, 10);
        o.position.copy(s.pos).sub(m.pivot).multiplyScalar(ns / s.scale).add(m.pivot);
        o.scale.setScalar(ns);
      }
      o.updateMatrixWorld(true);
    }
    this.cb.status(m.kind === 'move' ? `Move  X ${dpos.x.toFixed(1)}  Y ${dpos.y.toFixed(1)}  Z ${dpos.z.toFixed(1)}` : m.kind === 'rotate' ? 'Rotate' : `Scale ${f.toFixed(3)}`);
    this.invalidate(true);
  }

  private endGizmo(): void {
    if (!this.modal?.gizmo) return;
    this.confirmModal();
  }

  // ---------------------------------------------------------------- lights & render

  private updateLights(): void {
    for (const l of this.editorLights) l.visible = !this.cellLighting;
    this.ambient.intensity = this.cellLighting ? 2.2 : 0;
    this.ambient.color.copy(this.cellAmbient);
    const lit = [...this.entries.values()].filter((e) => e.ref.light && e.obj.visible && !e.ref.disabled);
    const c = this.target;
    lit.sort((a, b) => a.obj.position.distanceToSquared(c) - b.obj.position.distanceToSquared(c));
    this.pointLights.forEach((pl, i) => {
      const e = lit[i];
      pl.visible = !!e && this.cellLighting;
      if (!e) return;
      pl.position.copy(e.obj.position).add(new THREE.Vector3(0, 0, 40));
      pl.color.setRGB(...e.ref.light!.color, THREE.SRGBColorSpace);
      pl.distance = e.ref.light!.radius * 1.2;
      pl.intensity = e.ref.light!.radius * 0.9;
    });
  }

  private tick = (now: number): void => {
    if (this.disposed) return;
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    if (this.drag?.mode === 'look' && this.keysDown.size) {
      const fwd = this.dir().negate();
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 0, 1)).normalize();
      const mv = new THREE.Vector3();
      if (this.keysDown.has('KeyW')) mv.add(fwd);
      if (this.keysDown.has('KeyS')) mv.sub(fwd);
      if (this.keysDown.has('KeyD')) mv.add(right);
      if (this.keysDown.has('KeyA')) mv.sub(right);
      if (this.keysDown.has('KeyE')) mv.z += 1;
      if (this.keysDown.has('KeyQ')) mv.z -= 1;
      if (mv.lengthSq()) {
        const speed = this.flySpeed * (this.keysDown.has('ShiftLeft') || this.keysDown.has('ShiftRight') ? 3 : 1);
        this.target.addScaledVector(mv.normalize(), speed * dt);
        this.updateCamera();
      }
    }
    if (this.needsRender) {
      this.needsRender = false;
      if (this.cellLighting) this.updateLights();
      this.renderer.render(this.scene, this.camera);
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  /** Render now and return a PNG data URL (for thumbnails/tests). */
  snapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  stats(): { objects: number; selected: number; hidden: number; warnings: string[] } {
    return { objects: this.entries.size, selected: this.selection.length, hidden: this.hidden.size, warnings: [...this.assets.warnings] };
  }
}
