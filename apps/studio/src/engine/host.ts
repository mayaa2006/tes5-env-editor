/**
 * EngineHost: the single RPC surface between the UI and the editing engine.
 * The Electron main process runs it against the real file system; the browser
 * demo runs it in-page against an in-memory demo data set. Every method takes
 * and returns structured-clone friendly values.
 */
import { decodeToRgba, flattenMeshes, gameTexturePath, isCompressed, parseDds, parseNif, parseTri, type NifMaterial } from '@tes5/assets';
import { allConditionFunctions, isFormKey, newCondition, parseFormKey, recordTypeName, type FormKey, type Navmesh, type VmadProperty } from '@tes5/esp';
import { validateNavmesh } from '@tes5/navmesh';
import {
  CELL_MOODS,
  CLUTTER_THEMES,
  DialogueService,
  EnvironmentService,
  EXAMPLE_QUEST_DOCUMENT,
  createPackage,
  describePackage,
  findTemplate,
  type RoutineActivity,
  applyJournalToPlan,
  draftJournal,
  journalContextFromGraph,
  journalContextFromPlan,
  lintJournal,
  type JournalDraft,
  lintQuestDialogue,
  lintScreenplay,
  gestureCode,
  listGestures,
  parseGestureLine,
  QuestBuilder,
  QuestPlanner,
  exampleQuestPlan,
  planCatalog,
  validatePlan,
  type PlannerMode,
  type QuestPlan,
  ReleaseService,
  type FindingFix,
  type ArrayOptions,
  type CellMood,
  type ClutterOptions,
  type PathOptions,
  type RoomKit,
  type RoomPlan,
  type ScatterOptions,
  NpcService,
  FaceGenService,
  BodySlideService,
  type SliderValues,
  type FaceSculpt,
  QuestGraphService,
  QuestService,
  TRIGGER_EVENTS,
  TRIGGER_TEMPLATES,
  TriggerService,
  TEST_BAT_NAME,
  findLauncher,
  joinPath,
  testCommands,
  ScriptService,
  WorldService,
  Workspace,
  TerrainService,
  LandTextureBaker,
  ActorModels,
  type SculptMode,
  CREATABLE_TYPES,
  catalogCounts,
  catalogList,
  categoryFor,
  createInCategory,
  perkEntryPointTabs,
  WORKBENCHES,
  type CatalogTab,
  createBlankRecord,
  isCreatable,
  allUiSchemas,
  compactFormIds,
  setLightFlag,
  computeBounds,
  detectInstall,
  findInstalls,
  eslReport,
  generateCellNavmesh,
  readMo2Instance,
  readMo2Profile,
  uiSchema,
  updateBounds,
  type FileSystem,
  type LoadOrderEntry,
  type NpcAppearance,
  type ProcessRunner,
  type SaveOptions,
  type Transform,
  type NewQuestEdge,
  type QuestEdge,
  type TriggerHost,
  type TestLaunchOptions,
  type TriggerSpec,
  type WorkspaceEvent,
  WorldspaceService,
  type NewExteriorCellOptions,
  type NewWorldspaceOptions,
  ollamaModels,
  serviceModels,
  OLLAMA_URL,
  type AiProvider,
} from '@tes5/workspace';
import type { CleanOptions } from '@tes5/cleaner';

export interface SessionInfo {
  open: boolean;
  game?: string;
  source?: string;
  dataDir?: string;
  outputDir?: string;
  activePlugin?: string;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
  loadOrder: { name: string; active: boolean; loaded: boolean; isMaster: boolean; isLight: boolean; isLocalized: boolean; masters: string[]; isActivePlugin: boolean; error?: string }[];
}

export interface MeshPayload {
  path: string;
  shapes: {
    name: string;
    positions: Float32Array;
    normals?: Float32Array;
    uvs?: Float32Array;
    colors?: Float32Array;
    indices: Uint16Array | Uint32Array;
    matrix: Float32Array;
    material: NifMaterial;
    skinned: boolean;
  }[];
  warnings: string[];
}

export interface TexturePayload {
  path: string;
  width: number;
  height: number;
  format: string;
  srgb: boolean;
  mipmaps: { width: number; height: number; data: Uint8Array }[];
  /** Software-decoded RGBA of the top mip (when decodable), for formats the GPU can't take. */
  rgba?: Uint8Array;
}

export interface OpenOptions {
  kind: 'folder' | 'mo2' | 'demo';
  path?: string;
  profile?: string;
  loadOrder?: LoadOrderEntry[];
  outputDir?: string;
}

type Listener = (e: WorkspaceEvent) => void;

export class EngineHost {
  ws?: Workspace;
  world?: WorldService;
  terrainService?: TerrainService;
  worldspaceService?: WorldspaceService;
  landTextures?: LandTextureBaker;
  actorModels?: ActorModels;
  npcs?: NpcService;
  faces?: FaceGenService;
  bodies?: BodySlideService;
  quests?: QuestService;
  scripts?: ScriptService;
  triggers?: TriggerService;
  graphs?: QuestGraphService;
  dialogue?: DialogueService;
  env?: EnvironmentService;
  release?: ReleaseService;
  builder?: QuestBuilder;
  private source?: string;
  /** Game folder (where SkyrimSE.exe lives) and MO2 instance, for test launches. */
  private gameDir?: string;
  private mo2?: { instanceDir: string; profile?: string };
  private listeners = new Set<Listener>();
  private meshCache = new Map<string, MeshPayload>();

  /** The compiler chosen in the settings (kept across reopening); unset: Caprica that comes with the app, or the CK's. */
  private compilerChoice?: { kind: 'papyrus-compiler' | 'caprica'; executable: string; optimize?: boolean };

  constructor(
    readonly fs: FileSystem,
    readonly runner?: ProcessRunner,
    /** Caprica.exe shipped with the desktop app. */
    readonly bundledCaprica?: string,
  ) {}

  onEvent(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private requireWs(): Workspace {
    if (!this.ws) throw new Error('No game data open');
    return this.ws;
  }

  // ---------------------------------------------------------------- session

  /** Skyrim installs found in the usual places (Steam libraries, GOG), for the start screen. */
  findInstalls() {
    const env = typeof process !== 'undefined' && process.env ? (process.env as Record<string, string | undefined>) : {};
    return findInstalls(this.fs, env);
  }

  async open(opts: OpenOptions): Promise<SessionInfo> {
    let ws: Workspace;
    // Saving into a chosen folder (any mod manager, or none): make it, and read it as a mod folder so what was saved there loads again.
    const outputDir = opts.outputDir?.trim() || undefined;
    if (outputDir) await this.fs.mkdir(outputDir);
    const withOutput = (roots: string[]) => (outputDir && !roots.some((r) => r.replace(/[\\/]+$/, '').toLowerCase() === outputDir.replace(/[\\/]+$/, '').toLowerCase()) ? [...roots, outputDir] : roots);
    if (opts.kind === 'mo2') {
      if (!opts.path) throw new Error('Pick your Mod Organizer 2 instance folder');
      const inst = await readMo2Instance(this.fs, opts.path);
      const profile = await readMo2Profile(this.fs, inst, opts.profile);
      const install = inst.gamePath ? await detectInstall(this.fs, inst.gamePath) : undefined;
      ws = new Workspace(this.fs, {
        game: install?.game ?? 'SkyrimSE',
        roots: withOutput(profile.roots),
        outputDir: outputDir ?? inst.overwriteDir,
        loadOrder: profile.plugins,
      });
      this.source = `MO2: ${inst.instanceDir} (${profile.name})`;
      this.gameDir = install?.gameDir ?? inst.gamePath;
      this.mo2 = { instanceDir: inst.instanceDir, profile: profile.name };
    } else {
      if (!opts.path) throw new Error('Pick your Skyrim folder');
      const install = await detectInstall(this.fs, opts.path);
      if (!install) throw new Error(`No Skyrim installation found in ${opts.path}`);
      ws = new Workspace(this.fs, { game: install.game, roots: withOutput([install.dataDir]), outputDir: outputDir ?? install.dataDir, loadOrder: opts.loadOrder });
      this.source = opts.kind === 'demo' ? 'Demo data (in memory)' : install.gameDir ?? install.dataDir;
      this.gameDir = install.gameDir ?? install.dataDir.replace(/[\\/]+Data[\\/]*$/i, '');
      this.mo2 = undefined;
    }
    await ws.scan();
    this.attach(ws);
    return this.session();
  }

  private attach(ws: Workspace): void {
    this.ws = ws;
    this.world = new WorldService(ws);
    this.terrainService = new TerrainService(ws, this.world);
    this.worldspaceService = new WorldspaceService(ws, this.world, this.terrainService);
    this.landTextures = new LandTextureBaker(ws, this.world);
    this.npcs = new NpcService(ws);
    this.actorModels = new ActorModels(ws, this.npcs);
    this.faces = new FaceGenService(ws, this.npcs);
    this.bodies = new BodySlideService(ws);
    this.scripts = new ScriptService(ws);
    this.scripts.runner = this.runner;
    this.scripts.bundledCaprica = this.bundledCaprica;
    this.scripts.compiler = this.compilerChoice;
    this.quests = new QuestService(ws, this.scripts);
    this.triggers = new TriggerService(ws, this.scripts);
    this.graphs = new QuestGraphService(ws, this.quests, this.scripts, this.triggers);
    this.dialogue = new DialogueService(ws, this.quests);
    this.env = new EnvironmentService(ws);
    this.release = new ReleaseService(ws, this.scripts, this.npcs, this.quests, this.graphs, this.env, this.faces);
    this.builder = new QuestBuilder(ws, this.quests, this.graphs, this.dialogue, this.npcs, this.env);
    this.meshCache.clear();
    ws.on((e) => {
      if (e.type === 'filesRestored') return; // internal to the engine
      for (const l of this.listeners) l(e);
    });
  }

  async loadPlugins(active?: string[]): Promise<SessionInfo> {
    const ws = this.requireWs();
    if (active) for (const s of ws.slots) s.active = active.some((a) => a.toLowerCase() === s.name.toLowerCase());
    // Activating a plugin activates its masters.
    for (const s of ws.slots) if (s.active) for (const m of s.masters) ws.slot(m) && (ws.slot(m)!.active = true);
    await ws.load();
    await ws.loadAllStrings();
    this.scripts!.refresh();
    ws.warm();
    return this.session();
  }

  session(): SessionInfo {
    const ws = this.ws;
    if (!ws) return { open: false, dirty: false, canUndo: false, canRedo: false, loadOrder: [] };
    return {
      open: true,
      game: ws.game,
      source: this.source,
      dataDir: ws.options.roots[0],
      outputDir: ws.options.outputDir,
      activePlugin: ws.activeName,
      dirty: ws.isDirty,
      canUndo: ws.canUndo,
      canRedo: ws.canRedo,
      undoLabel: ws.undoLabel,
      redoLabel: ws.redoLabel,
      loadOrder: ws.slots.map((s) => ({
        name: s.name,
        active: s.active,
        loaded: !!s.plugin,
        isMaster: s.isMaster,
        isLight: s.isLight,
        isLocalized: s.isLocalized,
        masters: s.masters,
        isActivePlugin: s.name === ws.activeName,
        error: s.error,
      })),
    };
  }

  createPlugin(name: string, opts: { author?: string; description?: string; light?: boolean } = {}): SessionInfo {
    this.requireWs().createPlugin(name, opts);
    this.ws!.warm();
    return this.session();
  }

  setActivePlugin(name: string): SessionInfo {
    this.requireWs().setActivePlugin(name);
    this.ws!.warm();
    return this.session();
  }

  async save(opts: SaveOptions & { updateBounds?: boolean; generateFaces?: boolean; compileScripts?: boolean } = {}) {
    const ws = this.requireWs();
    const boundsChanged = opts.updateBounds === false ? [] : await updateBounds(ws);
    // Faces first, so the save that follows is the one that matches them.
    const faces = opts.generateFaces ? await this.faces!.generate() : [];
    const res = await ws.save(opts);
    const scripts = opts.compileScripts ? await this.compileChanged() : { compiled: 0, warnings: [] };
    return { ...res, warnings: [...res.warnings, ...faces.flatMap((f) => f.warnings), ...scripts.warnings], boundsChanged, facesGenerated: faces.length, scriptsCompiled: scripts.compiled, session: this.session() };
  }

  undo(): SessionInfo {
    this.requireWs().undo();
    return this.session();
  }

  redo(): SessionInfo {
    this.requireWs().redo();
    return this.session();
  }

  // ---------------------------------------------------------------- records

  search(opts: { sigs?: string[]; query?: string; plugin?: string; named?: boolean; limit?: number; offset?: number }) {
    return this.requireWs().search(opts);
  }

  recordTypes() {
    const ws = this.requireWs();
    const counts = new Map<string, number>();
    for (const { record } of ws.winners()) counts.set(record.sig, (counts.get(record.sig) ?? 0) + 1);
    // Types you can create are listed even when the load order has none yet.
    for (const sig of CREATABLE_TYPES) if (!counts.has(sig)) counts.set(sig, 0);
    return [...counts.entries()]
      .map(([sig, count]) => ({ sig, name: recordTypeName(sig), count, editable: !!uiSchema(sig), creatable: isCreatable(sig), category: uiSchema(sig)?.category ?? 'Other' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  view(key: FormKey, plugin?: string) {
    return this.requireWs().view(key, plugin) ?? null;
  }

  /** Every version of a form, decoded — for the conflict view. */
  conflicts(key: FormKey) {
    const ws = this.requireWs();
    return ws.versions(key).map((v) => ws.view(key, v.slot.name)!);
  }

  summaries(keys: FormKey[]) {
    const ws = this.requireWs();
    return Object.fromEntries(keys.filter((k) => k && isFormKey(k)).map((k) => [k, ws.summary(k) ?? null]));
  }

  uiSchema(sig: string) {
    return uiSchema(sig) ?? null;
  }

  allUiSchemas() {
    return allUiSchemas();
  }

  conditionFunctions() {
    return allConditionFunctions();
  }

  newCondition(fn = 0) {
    return newCondition(fn);
  }

  updateRecord(key: FormKey, data: Record<string, unknown>, opts: { unknown?: any[]; flags?: number; label?: string } = {}) {
    return this.requireWs().updateRecord(key, data, opts);
  }

  setFlags(key: FormKey, set: number, clear: number) {
    this.requireWs().setFlags(key, set, clear);
    return this.view(key);
  }

  createRecord(sig: string, data: Record<string, unknown>, where: { cell?: FormKey; topic?: FormKey; worldspace?: FormKey; persistent?: boolean } = {}) {
    return this.requireWs().createRecord(sig, data, where);
  }

  // ---------------------------------------------------------------- Items & Magic workspaces

  catalogCounts(tab: CatalogTab) {
    return catalogCounts(this.requireWs(), tab);
  }

  catalogList(category: string, query = '', limit = 300) {
    return catalogList(this.requireWs(), category, query, limit);
  }

  createInCategory(category: string) {
    return createInCategory(this.requireWs(), category);
  }

  /** Which Items/Magic category a form belongs to (null if it has none). */
  categoryOf(key: FormKey) {
    const v = this.requireWs().view(key);
    const c = v ? categoryFor(v.sig, v.data) : undefined;
    return c ? { id: c.id, tab: c.tab } : null;
  }

  /** Crafting stations: keyword FormKey and friendly name, for the recipe editor. */
  workbenches() {
    const ws = this.requireWs();
    return Object.entries(WORKBENCHES)
      .map(([edid, label]) => ({ key: ws.byEditorId(edid), label }))
      .filter((w): w is { key: FormKey; label: string } => !!w.key);
  }

  /** Condition tab count per perk entry point, as vanilla uses them. */
  perkEntryPointTabs() {
    return perkEntryPointTabs(this.requireWs());
  }

  /** FormKeys for Editor IDs (missing ones are left out). */
  formsByEditorId(ids: string[]) {
    const ws = this.requireWs();
    return Object.fromEntries(ids.map((id) => [id, ws.byEditorId(id) ?? null]));
  }

  /** A new record of the given type with sensible defaults (spell, perk, leveled list, recipe…). */
  createBlankRecord(sig: string, editorId?: string) {
    return createBlankRecord(this.requireWs(), sig, editorId);
  }

  duplicateRecord(key: FormKey, editorId?: string) {
    return this.requireWs().duplicateRecord(key, editorId);
  }

  deleteRecord(key: FormKey) {
    return this.requireWs().deleteRecord(key);
  }

  revertRecord(key: FormKey) {
    this.requireWs().revertRecord(key);
  }

  findReferences(key: FormKey, allPlugins = true) {
    return this.requireWs().findReferences(key, { allPlugins });
  }

  // ---------------------------------------------------------------- world

  worldspaces() {
    return this.world!.worldspaces();
  }

  cells(filter: { worldspace?: FormKey; interiorOnly?: boolean } = {}) {
    return this.world!.cells(filter);
  }

  references(cell: FormKey) {
    return this.world!.references(cell);
  }

  terrain(cell: FormKey) {
    return this.world!.terrain(cell) ?? null;
  }

  /** The model files that make up a placed character (body, armor, head), to draw it in the 3D view. */
  actorModel(base: FormKey) {
    return this.actorModels?.modelFor(base) ?? null;
  }

  /** Raise, lower, smooth or flatten the terrain along a brush stroke (one undo step). Returns the cells changed. */
  /** The cell's ground texture layers blended into one picture (rows south → north), or null when it has none. */
  async terrainTexture(cell: FormKey) {
    return (await this.landTextures!.bake(cell)) ?? null;
  }

  /** Landscape textures to paint the ground with (yours first). */
  landscapeTextures() {
    return this.requireWs()
      .search({ sigs: ['LTEX'], limit: 5000 })
      .items.filter((t) => !t.deleted)
      .sort((a, b) => Number(b.inActive) - Number(a.inActive) || (a.editorId ?? '').localeCompare(b.editorId ?? ''))
      .map((t) => ({ formKey: t.formKey, editorId: t.editorId, name: t.name }));
  }

  /** A small swatch of a landscape texture (average colour), for the picker. */
  async landscapeSwatch(ltex: FormKey) {
    return this.landTextures!.swatch(ltex);
  }

  paintGroundTexture(cell: FormKey, points: { x: number; y: number }[], opts: { texture: FormKey; radius: number; strength: number; erase?: boolean }) {
    return this.terrainService!.paintTexture(cell, points, opts);
  }

  sculptTerrain(cell: FormKey, points: { x: number; y: number }[], opts: { mode: SculptMode; radius: number; strength: number }) {
    return this.terrainService!.sculpt(cell, points, opts);
  }

  /** An outdoor cell and the ones around it (radius 1 = 3×3, 2 = 5×5), with references and terrain. */
  area(cell: FormKey, radius: number) {
    return this.world!.area(cell, radius);
  }

  cellLighting(cell: FormKey) {
    const v = this.view(cell);
    const l = (v?.data as any)?.lighting;
    if (!l) return null;
    return { ambient: l.ambient, directional: l.directional, fogNear: l.fogNear, fogFar: l.fogFar, fogColor: l.fogNearColor };
  }

  placeReference(cell: FormKey, base: FormKey, transform: Partial<Transform> = {}, opts: { persistent?: boolean } = {}) {
    return this.world!.placeReference(cell, base, transform, opts);
  }

  async transformReferences(changes: { ref: FormKey; transform: Partial<Transform> }[], label = 'Transform') {
    const ws = this.requireWs();
    // Moving a load door also moves where its partner door sends the player (same undo step).
    const doors = changes.map((c) => c.ref).filter((k) => (ws.view(k)?.data as { teleport?: unknown } | undefined)?.teleport);
    if (!doors.length) return this.world!.transformReferences(changes, label);
    await ws.transactionAsync(label, async () => {
      this.world!.transformReferences(changes, label);
      await this.env!.refreshTeleportMarkers(doors);
    });
  }

  duplicateReferences(refs: FormKey[], offset: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }): FormKey[] {
    const ws = this.requireWs();
    return ws.transaction('Duplicate', () =>
      refs.map((r) => {
        const v = ws.view(r);
        if (!v) throw new Error(`${r} not found`);
        const k = ws.duplicateRecord(r);
        if (offset.x || offset.y || offset.z) {
          const p = (v.data as any).placement;
          this.world!.transformReferences([{ ref: k, transform: { position: { x: p.position.x + offset.x, y: p.position.y + offset.y, z: p.position.z + offset.z } } }]);
        }
        return k;
      }),
    );
  }

  deleteReferences(refs: FormKey[]) {
    const ws = this.requireWs();
    return ws.transaction('Delete', () => refs.map((r) => ({ ref: r, result: ws.deleteRecord(r) })));
  }

  createInteriorCell(editorId: string, name?: string) {
    return this.world!.createInteriorCell(editorId, name, { ambient: [80, 70, 60] });
  }

  /** A new worldspace with a square of flat outdoor cells; returns its centre cell and the rest. */
  createWorldspace(opts: NewWorldspaceOptions) {
    return this.worldspaceService!.createWorldspace(opts);
  }

  /** A new outdoor cell whose ground meets the cells around it. */
  createExteriorCell(worldspace: FormKey, grid: { x: number; y: number }, opts: NewExteriorCellOptions = {}) {
    return this.worldspaceService!.createExteriorCell(worldspace, grid, opts);
  }

  /** The nearest free grid spot for a new outdoor cell. */
  freeCellSpot(worldspace: FormKey, near?: { x: number; y: number }) {
    return this.worldspaceService!.freeSpotNear(worldspace, near);
  }

  /**
   * Drag-and-drop helper: make (or reuse) a STAT base record for a mesh file,
   * with bounds computed from the mesh.
   */
  async baseForMesh(meshPath: string): Promise<FormKey> {
    const ws = this.requireWs();
    const rel = meshPath.replace(/^meshes[\\/]/i, '').replace(/\//g, '\\');
    for (const s of ws.search({ sigs: ['STAT', 'MSTT', 'FURN', 'ACTI', 'CONT', 'DOOR', 'LIGH', 'TREE', 'FLOR'], limit: 100000 }).items) {
      const m = (ws.view(s.formKey)?.data as any)?.model?.file as string | undefined;
      if (m && m.toLowerCase() === rel.toLowerCase()) return s.formKey;
    }
    const edid = rel
      .replace(/\.nif$/i, '')
      .split(/[\\/]/)
      .map((p) => p.replace(/[^A-Za-z0-9]/g, ''))
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join('');
    const key = ws.createRecord('STAT', {
      editorId: ws.uniqueEditorId(edid),
      bounds: { x1: 0, y1: 0, z1: 0, x2: 0, y2: 0, z2: 0 },
      model: { file: rel },
      directionalMaterial: { maxAngle: 90, material: null, consideredSnow: 0, unused: new Uint8Array(3) },
    });
    const b = await computeBounds(ws, key);
    if (b) ws.editRecord(key, (d) => ({ ...d, bounds: b }), 'Compute bounds');
    return key;
  }

  // ---------------------------------------------------------------- assets

  assetChildren(prefix: string) {
    const { folders, files } = this.requireWs().vfs.children(prefix);
    return { folders, files: files.map((f) => ({ path: f.path, source: f.source.kind === 'archive' ? f.source.archive : 'loose', overrides: f.overridden.length })) };
  }

  assetExists(path: string) {
    return this.requireWs().vfs.has(path);
  }

  async mesh(path: string): Promise<MeshPayload> {
    const key = path.toLowerCase().replace(/\//g, '\\');
    const cached = this.meshCache.get(key);
    if (cached) return cached;
    const full = key.startsWith('meshes\\') ? key : `meshes\\${key}`;
    const nif = parseNif(await this.requireWs().vfs.read(full));
    const payload: MeshPayload = {
      path: full,
      shapes: flattenMeshes(nif).map(({ mesh, matrix }) => ({
        name: mesh.name,
        positions: mesh.positions,
        normals: mesh.normals,
        uvs: mesh.uvs,
        colors: mesh.colors,
        indices: mesh.indices,
        matrix,
        material: mesh.material,
        skinned: mesh.skinned,
      })),
      warnings: nif.warnings,
    };
    if (this.meshCache.size > 300) this.meshCache.clear();
    this.meshCache.set(key, payload);
    return payload;
  }

  /**
   * Texture with its mip chain. Block-compressed data is passed through for the
   * GPU; `decode` adds a software-decoded RGBA copy of the top mip for GPUs
   * without S3TC/BPTC support. Uncompressed formats are always decoded.
   */
  async texture(path: string, decode = false): Promise<TexturePayload> {
    const full = gameTexturePath(path);
    const dds = parseDds(await this.requireWs().vfs.read(full));
    const top = dds.mipmaps[0];
    return {
      path: full,
      width: dds.width,
      height: dds.height,
      format: dds.format,
      srgb: dds.srgb,
      mipmaps: isCompressed(dds.format) ? dds.mipmaps.map((m) => ({ width: m.width, height: m.height, data: m.data.slice() })) : [],
      rgba: top && (decode || !isCompressed(dds.format)) ? decodeToRgba(top, dds.format) : undefined,
    };
  }

  async tri(path: string) {
    const p = path.toLowerCase().replace(/\//g, '\\');
    const full = p.startsWith('meshes\\') ? p : `meshes\\${p}`;
    const t = parseTri(await this.requireWs().vfs.read(full));
    return { morphs: t.morphs.map((m) => ({ name: m.name, deltas: m.deltas })), vertexCount: t.vertices.length / 3 };
  }

  // ---------------------------------------------------------------- BodySlide

  /** Every BodySlide slider set found in your Data folders (rescans). */
  bodySets() {
    return this.bodies!.list();
  }

  async bodySliders(set: string) {
    return { sliders: await this.bodies!.sliders(set), defaults: await this.bodies!.defaults(set), warnings: await this.bodies!.check(set).catch(() => [] as string[]) };
  }

  bodyPresets(set?: string) {
    return this.bodies!.presets(set);
  }

  /** The body at a weight (0–1) for the 3D view. */
  bodyPreview(set: string, values: SliderValues, weight: number) {
    return this.bodies!.preview(set, values, weight);
  }

  /** Write the 0 and 1 weight meshes into your mod. One undo step. */
  bodyBuild(set: string, values: SliderValues, output?: { folder?: string; file?: string }) {
    return this.bodies!.build(set, values, output);
  }

  bodySavePreset(name: string, set: string, values: SliderValues) {
    return this.bodies!.savePreset(name, set, values);
  }

  // ---------------------------------------------------------------- NPCs

  npcAppearance(npc: FormKey) {
    return this.npcs!.appearance(npc);
  }

  setNpcAppearance(npc: FormKey, a: Partial<NpcAppearance>) {
    this.npcs!.setAppearance(npc, a);
    return this.npcs!.appearance(npc);
  }

  headParts(filter: { race?: FormKey | null; female?: boolean; type?: string; includeNonPlayable?: boolean }) {
    return this.npcs!.headParts(filter as any);
  }

  hairColors() {
    return this.npcs!.hairColors();
  }

  races() {
    return this.npcs!.races();
  }

  faceGenProblems() {
    return this.npcs!.faceGenProblems();
  }

  /** The race's head data for one sex (default parts, face texture, hair colour, morph race, vampire). */
  raceHeadData(race: FormKey | null, female: boolean) {
    return this.npcs!.raceHeadData(race, female);
  }

  /** Every head part the face is made of (race defaults included), for the preview. */
  npcFaceParts(npc: FormKey) {
    return this.faces!.headPartsOf(npc);
  }

  /** The look the record can't hold: extended sliders, extra morphs, region shaping. */
  faceSculpt(npc: FormKey) {
    return this.faces!.sculpt(npc);
  }

  /** Change record look and sculpt together (one undo step). */
  async setNpcLook(npc: FormKey, a: Partial<NpcAppearance>, sculpt?: FaceSculpt) {
    await this.faces!.setLook(npc, a, sculpt);
    return { appearance: this.npcs!.appearance(npc), sculpt: await this.faces!.sculpt(npc) };
  }

  /** Whether this character's face files exist and match their look. */
  async faceStatus(npc: FormKey) {
    const paths = this.npcs!.faceGenPaths(npc);
    const canBake = this.faces!.headPartsOf(npc).some((p) => p.type === 'Face' && !!p.model);
    const present = this.ws!.vfs.has(paths.mesh) && this.ws!.vfs.has(paths.tint);
    const needing = await this.faces!.needingFaces();
    const template = this.npcs!.looksTemplate(npc);
    return { present, canBake, needed: needing.includes(npc), paths, template, templateName: template ? (this.ws!.summary(template)?.name ?? this.ws!.summary(template)?.editorId) : undefined };
  }

  facesNeeded() {
    return this.faces!.needingFaces();
  }

  /** Every character in the plugin with the state of its face files (for the export list). */
  faceFiles() {
    return this.faces!.faceFiles();
  }

  /** Bake and write FaceGen (default: every character that needs it). One undo step. */
  generateFaces(npcs?: FormKey[]) {
    return this.faces!.generate(npcs);
  }

  raceTintMasks(race: FormKey | null, female: boolean) {
    return this.faces!.raceTintMasks(race, female);
  }

  /** The face tint as it would be baked, small, for the Paint page. */
  async previewTint(a: NpcAppearance) {
    const dds = parseDds(await this.faces!.composeTint(a));
    const full = decodeToRgba(dds.mipmaps[0]!, dds.format)!;
    const size = 128;
    const step = dds.width / size;
    const rgba = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) rgba.set(full.subarray(((y * step) * dds.width + x * step) * 4, ((y * step) * dds.width + x * step) * 4 + 4), (y * size + x) * 4);
    return { width: size, height: size, rgba };
  }

  /**
   * The head's colour texture as the game shows it: the head part's diffuse
   * times the face tint, doubled (the face shader brightens the deliberately
   * dark head texture with the tint). For the 3D preview; 512² RGBA.
   */
  async previewFaceTexture(npc: FormKey, a: NpcAppearance) {
    const head = this.faces!.headPartsOf(npc).find((p) => p.type === 'Face' && p.model);
    if (!head?.model) return null;
    const nif = parseNif(await this.requireWs().vfs.read(`meshes\\${head.model.replace(/^meshes[\\/]/i, '')}`));
    const diffusePath = flattenMeshes(nif)[0]?.mesh.material.textures[0];
    const path = diffusePath ? (/^textures\\/i.test(diffusePath) ? diffusePath : `textures\\${diffusePath}`) : undefined;
    if (!path || !this.ws!.vfs.has(path)) return null;
    const d = parseDds(await this.ws!.vfs.read(path));
    const level = d.mipmaps.find((m) => m.width <= 512) ?? d.mipmaps[0]!;
    const diffuse = decodeToRgba(level, d.format);
    if (!diffuse) return null;
    const t = parseDds(await this.faces!.composeTint(a));
    const tint = decodeToRgba(t.mipmaps[0]!, t.format)!;
    const w = level.width;
    const h = level.height;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const to = (Math.floor((y * t.height) / h) * t.width + Math.floor((x * t.width) / w)) * 4;
        for (let c = 0; c < 3; c++) rgba[o + c] = Math.min(255, Math.round((2 * diffuse[o + c]! * tint[to + c]!) / 255));
        rgba[o + 3] = 255;
      }
    return { width: w, height: h, rgba };
  }

  // ---------------------------------------------------------------- quests

  quest(key: FormKey) {
    return this.quests!.quest(key);
  }

  createQuest(editorId: string, name: string, opts: { startGameEnabled?: boolean; runOnce?: boolean; priority?: number; type?: number } = {}) {
    return this.quests!.createQuest(editorId, name, opts);
  }

  addStage(quest: FormKey, index: number, logText?: string, opts: any = {}) {
    this.quests!.addStage(quest, index, logText, opts);
    return this.quest(quest);
  }

  setStageLog(quest: FormKey, index: number, logIndex: number, text: string) {
    this.quests!.setStageLog(quest, index, logIndex, text);
    return this.quest(quest);
  }

  removeStage(quest: FormKey, index: number) {
    this.quests!.removeStage(quest, index);
    return this.quest(quest);
  }

  addObjective(quest: FormKey, index: number, text: string, alias?: number) {
    this.quests!.addObjective(quest, index, text, alias);
    return this.quest(quest);
  }

  addReferenceAlias(quest: FormKey, name: string, fill: any = {}, flags = 0) {
    this.quests!.addReferenceAlias(quest, name, fill, flags);
    return this.quest(quest);
  }

  addLocationAlias(quest: FormKey, name: string, location?: FormKey) {
    this.quests!.addLocationAlias(quest, name, location);
    return this.quest(quest);
  }

  createTopic(quest: FormKey, opts: { editorId: string; text: string; topLevel?: boolean }) {
    this.quests!.createTopic(quest, opts);
    return this.quest(quest);
  }

  addResponse(topic: FormKey, opts: { text: string | string[]; speaker?: FormKey; emotion?: number; goodbye?: boolean }) {
    return this.quests!.addResponse(topic, opts);
  }

  async stageFragment(quest: FormKey, stage: number, logEntry = 0): Promise<string> {
    const q = this.quests!.quest(quest);
    const st = q.stages.find((s) => s.index === stage);
    const name = st?.logEntries[logEntry]?.fragment;
    if (!name || !q.fragmentScript || !this.scripts!.has(q.fragmentScript)) return '';
    const src = await this.scripts!.read(q.fragmentScript);
    const { parseFragmentSource } = await import('@tes5/papyrus');
    return parseFragmentSource(src, 'QUST').fragments.find((f) => f.name === name)?.code ?? '';
  }

  async setStageFragment(quest: FormKey, stage: number, code: string, logEntry = 0) {
    const name = await this.quests!.setStageFragment(quest, stage, code, logEntry);
    return { script: name, quest: this.quest(quest) };
  }

  /** Current code of a dialogue response's begin/end fragment ('' if none). */
  async infoFragment(info: FormKey, which: 'begin' | 'end'): Promise<string> {
    const frags = (this.view(info)?.data as any)?.scripts?.fragments;
    if (!frags || frags.kind !== 'INFO' || !this.scripts!.has(frags.fileName)) return '';
    const flag = which === 'begin' ? 1 : 2;
    if (!(frags.flags & flag)) return '';
    const frag = frags.fragments[flag === 1 ? 0 : frags.flags & 1 ? 1 : 0];
    const { parseFragmentSource } = await import('@tes5/papyrus');
    return parseFragmentSource(await this.scripts!.read(frags.fileName), 'INFO').fragments.find((f) => f.name === frag?.fragmentName)?.code ?? '';
  }

  async setInfoFragment(info: FormKey, which: 'begin' | 'end', code: string) {
    return this.quests!.setInfoFragment(info, which, code);
  }

  voiceFiles(quest: FormKey) {
    return this.quests!.voiceFiles(quest);
  }

  /** Stage-to-stage flow from fragments and dialogue (who calls SetStage where). */
  async questFlow(quest: FormKey) {
    const q = this.quests!.quest(quest);
    const edges: { from: string; to: number; via: string }[] = [];
    const scan = (code: string, from: string, via: string) => {
      for (const m of code.matchAll(/SetStage\s*\(\s*(\d+)\s*\)/gi)) edges.push({ from, to: Number(m[1]), via });
    };
    if (q.fragmentScript && this.scripts!.has(q.fragmentScript)) {
      const { parseFragmentSource } = await import('@tes5/papyrus');
      const frag = parseFragmentSource(await this.scripts!.read(q.fragmentScript), 'QUST');
      for (const st of q.stages) for (const le of st.logEntries) if (le.fragment) scan(frag.fragments.find((f) => f.name === le.fragment)?.code ?? '', `stage:${st.index}`, 'stage fragment');
    }
    for (const t of q.topics) {
      for (const info of t.infos) {
        const vm = (this.view(info.formKey)?.data as any)?.scripts;
        const file = vm?.fragments?.fileName;
        if (file && this.scripts!.has(file)) scan(await this.scripts!.read(file), `info:${info.formKey}`, 'dialogue');
      }
    }
    return edges;
  }

  // ---------------------------------------------------------------- quest map

  async questGraph(quest: FormKey) {
    return this.graphs!.graph(quest);
  }

  async addQuestEdge(quest: FormKey, edge: NewQuestEdge) {
    await this.graphs!.addEdge(quest, edge);
    return this.graphs!.graph(quest);
  }

  async removeQuestEdge(quest: FormKey, edge: QuestEdge) {
    await this.graphs!.removeEdge(quest, edge);
    return this.graphs!.graph(quest);
  }

  async setStageObjectives(quest: FormKey, stage: number, shows: number[], completes: number[]) {
    await this.graphs!.setStageObjectives(quest, stage, shows, completes);
    return this.graphs!.graph(quest);
  }

  setQuestStartGameEnabled(quest: FormKey, on: boolean) {
    this.graphs!.setStartGameEnabled(quest, on);
  }

  async saveQuestLayout(quest: FormKey, layout: Record<string, { x: number; y: number }>) {
    await this.graphs!.saveLayout(quest, layout);
  }

  // ---------------------------------------------------------------- dialogue graph

  /** The conversation map, with the stage each response moves the quest to (read from its end script). */
  async dialogueGraph(quest: FormKey) {
    const g = this.dialogue!.graph(quest);
    for (const i of g.infos) {
      const m = /^\s*GetOwningQuest\(\)\.SetStage\(\s*(\d+)\s*\)\s*$/im.exec(await this.infoFragment(i.formKey, 'end'));
      if (m) i.setsStage = Number(m[1]);
    }
    return g;
  }

  addDialogueChoice(info: FormKey, text: string) {
    return this.dialogue!.addChoice(info, text);
  }

  setDialogueChoice(info: FormKey, topic: FormKey, linked: boolean) {
    this.dialogue!.setChoice(info, topic, linked);
  }

  async importScreenplay(quest: FormKey, text: string) {
    return this.dialogue!.importScreenplay(quest, text, (info, code, which) => this.quests!.setInfoFragment(info, which, code), {
      aliasFor: (q, npc) => this.graphs!.aliasFor(q, npc),
      appendStageCode: (q, stage, lines) => this.graphs!.appendStageCode(q, stage, lines),
    });
  }

  /** Problems in a quest's dialogue (the Dialogue tab's check). */
  lintDialogue(quest: FormKey) {
    return lintQuestDialogue(quest, { quests: this.quests!, dialogue: this.dialogue!, graphs: this.graphs! });
  }

  /** Problems in a screenplay before it's imported into a quest. */
  lintScreenplay(quest: FormKey, text: string) {
    return lintScreenplay(text, { stages: this.quests!.quest(quest).stages.map((s) => s.index) });
  }

  dialogueScreenplay(quest: FormKey) {
    return this.dialogue!.toScreenplay(quest);
  }

  // ---------------------------------------------------------------- routines (AI packages)

  /** A character's packages, in the order they're tried, in words. */
  npcRoutine(npc: FormKey) {
    const ws = this.requireWs();
    const list = ((ws.view(npc)?.data as any)?.packages ?? []) as FormKey[];
    const activities = (['sandbox', 'stay', 'sleep', 'eat', 'travel'] as RoutineActivity[]).map((a) => ({ activity: a, available: !!findTemplate(ws, a) }));
    return { packages: list.map((k) => ({ formKey: k, text: describePackage(ws, k), editorId: ws.summary(k)?.editorId })), activities };
  }

  /** Add an everyday activity (a new package from the game's template) to a character. */
  addNpcRoutine(npc: FormKey, spec: { activity: RoutineActivity; cell: FormKey | null; hours: { from: number; to: number } | null }) {
    const ws = this.requireWs();
    return ws.transaction('Add to routine', () => {
      const id = (ws.view(npc)?.editorId ?? 'Npc').replace(/[^A-Za-z0-9_]/g, '');
      const pk = createPackage(ws, { editorId: ws.uniqueEditorId(`${id}${spec.activity[0]!.toUpperCase()}${spec.activity.slice(1)}`), activity: spec.activity, hours: spec.hours, conditions: [], location: spec.cell ? { kind: 'cell', cell: spec.cell } : { kind: 'editor' } });
      // Timed activities go first: the character does the first one whose time fits.
      ws.editRecord(npc, (d: any) => {
        const list: FormKey[] = d.packages ?? [];
        const timed = (k: FormKey) => ((ws.view(k)?.data as any)?.schedule?.hour ?? -1) >= 0;
        d.packages = spec.hours ? [pk, ...list] : [...list.filter(timed), pk, ...list.filter((k) => !timed(k))];
      });
      return pk;
    });
  }

  removeNpcPackage(npc: FormKey, pk: FormKey) {
    this.requireWs().editRecord(npc, (d: any) => void (d.packages = (d.packages ?? []).filter((k: FormKey) => k !== pk)), 'Remove from routine');
  }

  // ---------------------------------------------------------------- gestures

  gestures(query?: string) {
    return listGestures(this.requireWs(), { query });
  }

  /** The gesture a response's speaker plays as the line starts (its begin script), or null. */
  async responseGesture(info: FormKey): Promise<string | null> {
    for (const line of (await this.infoFragment(info, 'begin')).split('\n')) {
      const g = parseGestureLine(this.requireWs(), line);
      if (g && g.actor === 'akSpeaker') return g.gesture.id;
    }
    return null;
  }

  /** Set (or clear) the speaker's gesture; other begin-script lines are kept. */
  async setResponseGesture(info: FormKey, gesture: string | null) {
    const ws = this.requireWs();
    const kept = (await this.infoFragment(info, 'begin')).split('\n').filter((l) => l.trim() && parseGestureLine(ws, l)?.actor !== 'akSpeaker');
    const code = [...(gesture ? [gestureCode(ws, gesture, 'akSpeaker')] : []), ...kept].join('\n');
    return this.quests!.setInfoFragment(info, 'begin', code);
  }

  addStageGesture(quest: FormKey, stage: number, actor: FormKey, gesture: string) {
    return this.graphs!.addStageGesture(quest, stage, actor, gesture);
  }

  removeStageLine(quest: FormKey, stage: number, line: string) {
    return this.graphs!.removeStageLine(quest, stage, line);
  }

  // ---------------------------------------------------------------- journal & objective writer

  private async journalContext(quest: FormKey) {
    return journalContextFromGraph(this.requireWs(), await this.graphs!.graph(quest));
  }

  /** Drafts for the missing (or all) journal entries and objectives, plus wording problems in what's there. */
  async journalDraft(quest: FormKey, overwrite = false) {
    const context = await this.journalContext(quest);
    return { context, draft: draftJournal(context, { overwrite }), lint: lintJournal(context) };
  }

  /** The AI (Claude or a free one) writes the drafts instead of the templates. */
  async journalDraftWithClaude(quest: FormKey, ai: AiProvider | string, overwrite = false) {
    return new QuestPlanner({ ai: asAi(ai) }).writeJournal(await this.journalContext(quest), { overwrite });
  }

  /** Models installed in Ollama on this computer. */
  ollamaModels(url?: string) {
    return ollamaModels(url || OLLAMA_URL);
  }

  /** The models an online (OpenAI-style) service offers right now; also checks the key. */
  aiServiceModels(url: string, apiKey?: string) {
    return serviceModels({ url, apiKey });
  }

  /** Write the chosen drafts into the quest (one undo step). */
  async applyJournal(quest: FormKey, draft: JournalDraft) {
    const ws = this.requireWs();
    await ws.transactionAsync('Write journal and objectives', async () => {
      for (const s of draft.stages) this.quests!.setStageLog(quest, s.index, 0, s.journal);
      const have = new Set(this.quests!.quest(quest).objectives.map((o) => o.index));
      for (const o of draft.objectives) {
        if (have.has(o.index))
          ws.editRecord(quest, (d: any) => {
            const ob = d.objectives.find((x: any) => x.index === o.index);
            if (ob) ob.text = o.text;
          });
        else this.quests!.addObjective(quest, o.index, o.text);
      }
      const g = await this.graphs!.graph(quest);
      const stages = new Set([...draft.objectives.map((o) => o.shownAtStage), ...draft.objectives.flatMap((o) => (o.completedAtStage === null ? [] : [o.completedAtStage]))]);
      for (const st of stages) {
        const n = g.nodes.find((x) => x.stage === st);
        if (!n) continue;
        const shows = [...new Set([...n.shows, ...draft.objectives.filter((o) => o.shownAtStage === st).map((o) => o.index)])];
        const completes = [...new Set([...n.completes, ...draft.objectives.filter((o) => o.completedAtStage === st).map((o) => o.index)])];
        if (shows.length !== n.shows.length || completes.length !== n.completes.length) await this.graphs!.setStageObjectives(quest, st, shows, completes);
      }
    });
  }

  /** The writer on a plan: fill in the missing journal entries and objectives (templates, or Claude with a key). */
  async planJournal(plan: QuestPlan, ai?: AiProvider | string) {
    const ctx = journalContextFromPlan(plan);
    const draft = ai ? await new QuestPlanner({ ai: asAi(ai) }).writeJournal(ctx) : draftJournal(ctx);
    const next = applyJournalToPlan(plan, draft);
    return { plan: next, ...this.reviewQuestPlan(next) };
  }

  // ---------------------------------------------------------------- quest from writing

  /** The example design document and the plan Claude makes from it (for trying this without an API key). */
  questPlanExample() {
    return { document: EXAMPLE_QUEST_DOCUMENT, plan: exampleQuestPlan() };
  }

  /** What's wrong with a plan, and what each character, place and item will use. */
  reviewQuestPlan(plan: QuestPlan) {
    return { issues: validatePlan(plan), resolution: this.builder!.resolve(plan) };
  }

  /** Claude plans a quest from a design document or a conversation. */
  async planQuest(source: string, mode: PlannerMode, ai: AiProvider | string) {
    const a = asAi(ai);
    const plan = await new QuestPlanner({ ai: a }).plan(source, mode, planCatalog(this.requireWs(), { text: source, limit: catalogLimit(a) }));
    return { plan, ...this.reviewQuestPlan(plan) };
  }

  /** Claude changes a plan as described. */
  async reviseQuestPlan(plan: QuestPlan, feedback: string, ai: AiProvider | string, source?: string) {
    const a = asAi(ai);
    const text = `${source ?? ''}\n${feedback}\n${plan.characters.map((c) => `${c.name} ${c.existing ?? ''}`).join('\n')}\n${plan.locations.map((l) => `${l.name} ${l.existing ?? ''}`).join('\n')}`;
    const next = await new QuestPlanner({ ai: a }).revise(plan, feedback, planCatalog(this.requireWs(), { text, limit: catalogLimit(a) }), source);
    return { plan: next, ...this.reviewQuestPlan(next) };
  }

  buildQuestPlan(plan: QuestPlan) {
    return this.builder!.build(plan);
  }

  /** An existing quest as a plan (exactly as built, or read from the quest), ready to change. */
  async questPlanFor(quest: FormKey) {
    const { plan, fromRecord } = await this.builder!.planFor(quest);
    return { plan, fromRecord, ...this.reviewQuestPlan(plan) };
  }

  /** What updating a quest to a revised plan would change, in words. */
  previewQuestUpdate(quest: FormKey, plan: QuestPlan) {
    return this.builder!.previewUpdate(quest, plan);
  }

  updateQuestFromPlan(quest: FormKey, plan: QuestPlan) {
    return this.builder!.update(quest, plan);
  }

  // ---------------------------------------------------------------- test launch

  /**
   * Write the test batch file (travel, quest stages, items) to the game folder
   * and optionally start the game. Save the plugin first.
   */
  async testLaunch(opts: TestLaunchOptions & { launch?: boolean; mo2Executable?: string; mo2Exe?: string }) {
    const ws = this.requireWs();
    if (!this.gameDir) throw new Error('The game folder is unknown, so the test file can’t be written');
    const graph = opts.quest ? await this.graphs!.graph(opts.quest) : undefined;
    const lines = testCommands(ws, opts, graph);
    if (!lines.length) throw new Error('Choose a place, a quest stage or items to test');
    const batPath = joinPath(this.gameDir, `${TEST_BAT_NAME}.txt`);
    await this.fs.writeFile(batPath, new TextEncoder().encode(`${lines.join('\r\n')}\r\n`));
    let launched = false;
    let how: string | undefined;
    if (opts.launch) {
      if (!this.runner?.launch) throw new Error("Starting the game isn't available in the demo (the test file was written)");
      const target = await findLauncher(ws, { gameDir: this.gameDir, mo2: this.mo2 && { ...this.mo2, executable: opts.mo2Executable, exe: opts.mo2Exe || undefined } });
      if (!target) throw new Error(`Couldn’t find Mod Organizer, SKSE or the game in ${this.gameDir} (the test file was written)`);
      await this.runner.launch(target.command, target.args, { cwd: target.cwd });
      launched = true;
      how = target.how;
    }
    return { batPath, lines, consoleCommand: `bat ${TEST_BAT_NAME}`, launched, how, viaMo2: !!this.mo2 };
  }

  // ---------------------------------------------------------------- release

  releaseCheck() {
    return this.release!.check();
  }

  /** Apply the one-click fix offered with a pre-release finding. */
  async releaseFix(fix: FindingFix) {
    switch (fix.kind) {
      case 'autofill':
        return (await this.scripts!.autofill(fix.form)).length;
      case 'updateBounds':
        return (await updateBounds(this.requireWs())).length;
      case 'generateNavmesh':
        return (await this.generateNavmesh(fix.cell)).triangles;
      case 'dropToSurface':
        return (await this.env!.dropToSurface(fix.refs)).moved.length;
      case 'generateFaces':
        return (await this.faces!.generate(fix.npcs)).length;
      case 'compileScripts': {
        const res = await this.scripts!.compile(fix.scripts);
        const bad = res.find((r) => !r.ok);
        if (bad) throw new Error(`${bad.script} didn't compile${bad.messages[0] ? `: ${bad.messages[0].line ? `line ${bad.messages[0].line}: ` : ''}${bad.messages[0].message}` : ''}. Open it in the Scripts tab to fix it.`);
        return res.length;
      }
    }
  }

  /** Your records that other plugins also change (the Release tab's conflict report). */
  conflictReport() {
    return this.release!.conflicts();
  }

  packageFiles(opts: { scriptSources?: boolean } = {}) {
    return this.release!.packageFiles(opts);
  }

  async packBsa(opts: { scriptSources?: boolean } = {}) {
    const r = await this.release!.buildBsa(opts);
    await this.requireWs().vfs.build();
    return r;
  }

  packZip(opts: { bsa?: boolean; scriptSources?: boolean; returnData?: boolean } = {}) {
    return this.release!.buildZip(opts);
  }

  // ---------------------------------------------------------------- environment tools

  envDrop(refs: FormKey[], align = false) {
    return this.env!.dropToSurface(refs, { align });
  }

  envArray(refs: FormKey[], opts: ArrayOptions) {
    return this.env!.array(refs, opts);
  }

  envScatter(cell: FormKey, opts: ScatterOptions & { centers?: { x: number; y: number; z: number }[] }) {
    return this.env!.scatter(cell, opts);
  }

  envErase(cell: FormKey, centers: { x: number; y: number; z: number }[], radius: number, bases: FormKey[]) {
    return this.env!.erase(cell, centers, radius, bases);
  }

  envAlongPath(cell: FormKey, opts: PathOptions) {
    return this.env!.alongPath(cell, opts);
  }

  envLighting(cell: FormKey) {
    const env = this.env!;
    const interior = this.world!.cells().find((c) => c.formKey === cell)?.interior ?? false;
    return { sources: env.lightSources(cell).length, suggested: interior ? env.suggestMood(cell) : null, moods: Object.entries(CELL_MOODS).map(([id, m]) => ({ id: id as CellMood, label: m.label })) };
  }

  envLightingPass(cell: FormKey) {
    return this.env!.lightingPass(cell);
  }

  envSetMood(cell: FormKey, mood: CellMood) {
    this.env!.setCellMood(cell, mood);
  }

  envThemes() {
    return Object.entries(CLUTTER_THEMES).map(([id, t]) => ({ id: id as keyof typeof CLUTTER_THEMES, label: t.label }));
  }

  envThemeItems(theme: keyof typeof CLUTTER_THEMES) {
    const { table, floor } = this.env!.themeItems(theme);
    const ws = this.requireWs();
    const describe = (k: FormKey) => ({ formKey: k, label: ws.summary(k)?.name ?? ws.summary(k)?.editorId ?? k });
    return { table: table.map(describe), floor: floor.map(describe) };
  }

  envClutter(cell: FormKey, opts: ClutterOptions) {
    return this.env!.clutterRoom(cell, opts);
  }

  envBuildRoom(cell: FormKey, origin: { x: number; y: number; z: number }, plan: RoomPlan, kit: RoomKit) {
    return this.env!.buildRoom(cell, origin, plan, kit);
  }

  envLinkDoors(a: FormKey, b: FormKey) {
    return this.env!.linkDoors(a, b);
  }

  /** A new door in `targetCell` (at its middle, resting on the ground outdoors), linked to `door`. */
  async envCreateLinkedDoor(door: FormKey, targetCell: FormKey) {
    const ws = this.requireWs();
    const info = this.world!.cells().find((c) => c.formKey === targetCell);
    if (!info) throw new Error('Pick a cell');
    const position = info.grid ? { x: info.grid.x * 4096 + 2048, y: info.grid.y * 4096 + 2048, z: 20000 } : { x: 0, y: 0, z: 0 };
    return ws.transactionAsync('Create linked door', async () => {
      const key = await this.env!.createLinkedDoor(door, targetCell, position);
      if (info.grid) {
        await this.env!.dropToSurface([key]);
        await this.env!.refreshTeleportMarkers([key]);
      }
      return key;
    });
  }

  // ---------------------------------------------------------------- visual triggers

  triggerEvents() {
    return TRIGGER_EVENTS;
  }

  triggerTemplates() {
    return TRIGGER_TEMPLATES.map(({ id, label, description }) => ({ id, label, description }));
  }

  makeTrigger(templateId: string, host: FormKey | null): TriggerSpec {
    const t = TRIGGER_TEMPLATES.find((x) => x.id === templateId);
    if (!t) throw new Error(`Unknown template ${templateId}`);
    return t.make({ host });
  }

  async triggersOf(host: TriggerHost) {
    return this.triggers!.list(host);
  }

  async setTriggers(host: TriggerHost, specs: TriggerSpec[]) {
    return this.triggers!.set(host, specs);
  }

  previewTriggers(host: TriggerHost, specs: TriggerSpec[]) {
    return this.triggers!.preview(host, specs);
  }

  // ---------------------------------------------------------------- scripts

  scriptList() {
    return this.scripts!.list();
  }

  /** Is there a compiled .pex for this script (what the game actually runs)? */
  scriptCompiled(name: string) {
    return this.requireWs().vfs.has(`scripts\\${name.toLowerCase()}.pex`);
  }

  async scriptRead(name: string) {
    return this.scripts!.read(name);
  }

  async scriptWrite(name: string, source: string) {
    return this.scripts!.write(name, source);
  }

  async scriptCheck(source: string) {
    return this.scripts!.check(source);
  }

  async scriptComplete(source: string, offset: number) {
    return this.scripts!.complete(source, offset);
  }

  async scriptHover(source: string, offset: number) {
    return this.scripts!.hover(source, offset) ?? null;
  }

  async scriptSignature(source: string, offset: number) {
    return this.scripts!.signatureHelp(source, offset) ?? null;
  }

  scriptOutline(source: string) {
    return this.scripts!.language.outline(source);
  }

  async scriptCompile(names: string[]) {
    return this.scripts!.compile(names);
  }

  setCompiler(settings: { kind: 'papyrus-compiler' | 'caprica'; executable: string; optimize?: boolean } | null) {
    this.compilerChoice = settings ?? undefined;
    if (this.scripts) this.scripts.compiler = this.compilerChoice;
  }

  /**
   * Everything the Scripts tab needs to say whether compiling is ready: which
   * compiler will be used, whether the game's script sources are there (and
   * the Scripts.zip to unpack if not), and which of your scripts need compiling.
   */
  async scriptBuildStatus() {
    const s = this.scripts!;
    const compiler = await s.activeCompiler();
    return {
      desktop: !!this.runner,
      compiler: compiler ? { ...compiler, bundled: !!this.bundledCaprica && compiler.executable === this.bundledCaprica, chosen: !!this.compilerChoice } : null,
      bundled: !!this.bundledCaprica,
      sources: await s.sourcesState(),
      outOfDate: await s.outOfDate(),
    };
  }

  /** Unpack the Creation Kit's Scripts.zip (the game's script sources) into Data. */
  async scriptUnpackSources() {
    return this.scripts!.unpackSources();
  }

  /** Compile every one of your scripts whose .pex is missing or older than the source. */
  async scriptCompileOutOfDate() {
    return this.scripts!.compileOutOfDate();
  }

  /** Compile changed scripts if compiling is set up; never fails the caller. */
  private async compileChanged(): Promise<{ compiled: number; warnings: string[] }> {
    const s = this.scripts;
    if (!s || !this.runner) return { compiled: 0, warnings: [] };
    const names = await s.outOfDate();
    if (!names.length) return { compiled: 0, warnings: [] };
    if (!(await s.activeCompiler()) || !(await s.sourcesState()).ready)
      return { compiled: 0, warnings: [`${names.length} script(s) aren't compiled, so the game won't run them. Set up compiling in the Scripts tab.`] };
    try {
      const res = await s.compile(names);
      const failed = res.filter((r) => !r.ok);
      return {
        compiled: res.length - failed.length,
        warnings: failed.map((r) => {
          const m = r.messages.find((x) => x.severity === 'error');
          return `${r.script} didn't compile${m ? `: ${m.line ? `line ${m.line}: ` : ''}${m.message}` : ''}. Open it in the Scripts tab to fix it.`;
        }),
      };
    } catch (e) {
      return { compiled: 0, warnings: [`Scripts weren't compiled: ${(e as Error).message}`] };
    }
  }

  async attachScript(key: FormKey, script: string) {
    await this.scripts!.attach(key, script);
    return this.view(key);
  }

  detachScript(key: FormKey, script: string) {
    this.scripts!.detach(key, script);
    return this.view(key);
  }

  setScriptProperty(key: FormKey, script: string, prop: VmadProperty) {
    this.scripts!.setProperty(key, script, prop);
    return this.view(key);
  }

  async autofill(key: FormKey) {
    return this.scripts!.autofill(key);
  }

  // ---------------------------------------------------------------- cleaning / automations

  clean(plugin: string, opts: CleanOptions) {
    return this.requireWs().clean(plugin, opts);
  }

  /** Clean a non-active plugin and write it (with a backup). */
  async cleanAndSave(plugin: string, opts: CleanOptions) {
    const ws = this.requireWs();
    const s = ws.slot(plugin);
    if (!s?.plugin || !s.path) throw new Error(`${plugin} is not loaded`);
    const report = ws.clean(plugin, { ...opts, dryRun: false });
    if (!report.errors.length) {
      const bytes = s.plugin.serialize();
      if (await this.fs.exists(s.path)) await this.fs.writeFile(`${s.path}.backup-${Date.now()}`, await this.fs.readFile(s.path));
      await this.fs.writeFile(s.path, bytes);
    }
    return report;
  }

  eslReport() {
    return eslReport(this.requireWs());
  }

  setLightFlag(on: boolean) {
    setLightFlag(this.requireWs(), on);
  }

  compactFormIds() {
    return [...compactFormIds(this.requireWs()).entries()];
  }

  async updateBounds() {
    return updateBounds(this.requireWs());
  }

  async generateNavmesh(cell: FormKey, opts: { preset?: 'interior' | 'exterior' | 'detailed'; useRecast?: boolean } = {}) {
    const res = await generateCellNavmesh(this.requireWs(), cell, opts);
    await this.env!.stampNavmesh(cell);
    return res;
  }

  navmeshStatus(cell: FormKey) {
    return this.env!.navmeshStatus(cell);
  }

  navmeshes(cell: FormKey) {
    const ws = this.requireWs();
    const out: { formKey: FormKey; source: string; geometry: Navmesh; issues: ReturnType<typeof validateNavmesh> }[] = [];
    for (const s of ws.loaded()) {
      const local = s.mapper!.toLocal(cell);
      if (local === undefined) continue;
      const c = s.plugin!.getRecord(local);
      const g = c ? s.plugin!.childGroupOf(c) : undefined;
      if (!g) continue;
      for (const sub of g.groups)
        for (const r of sub.records) {
          if (r.sig !== 'NAVM' || r.isDeleted) continue;
          const key = ws.keyOf(s, r.formId)!;
          const v = ws.view(key);
          const geometry = (v?.data as any)?.geometry as Navmesh | undefined;
          if (geometry && !out.some((o) => o.formKey === key)) out.push({ formKey: key, source: v!.winner, geometry, issues: validateNavmesh(geometry) });
        }
    }
    return out;
  }

  updateNavmesh(key: FormKey, geometry: Navmesh) {
    this.requireWs().editRecord(key, (d) => ({ ...d, geometry }), 'Edit navmesh');
    return validateNavmesh(geometry);
  }

  runtimeFormId(key: FormKey) {
    return this.requireWs().runtimeFormId(key);
  }

  describeKey(key: FormKey) {
    return this.requireWs().describeKey(key);
  }

  uniqueEditorId(base: string) {
    return this.requireWs().uniqueEditorId(base);
  }

  ownerOf(key: FormKey) {
    return parseFormKey(key).plugin;
  }
}

export type EngineMethod = {
  [K in keyof EngineHost]-?: EngineHost[K] extends (...args: any[]) => any ? K : never;
}[keyof EngineHost];

/** An AI choice, or (as before) just a Claude API key. */
/** Free AIs have less room to read: a shorter load-order list (the entries your text mentions still come first). */
function catalogLimit(ai: AiProvider): number {
  return ai.kind === 'claude' ? 300 : 120;
}

function asAi(ai: AiProvider | string): AiProvider {
  return typeof ai === 'string' ? { kind: 'claude', apiKey: ai } : ai;
}
