/**
 * EngineHost: the single RPC surface between the UI and the editing engine.
 * The Electron main process runs it against the real file system; the browser
 * demo runs it in-page against an in-memory demo data set. Every method takes
 * and returns structured-clone friendly values.
 */
import { decodeToRgba, flattenMeshes, isCompressed, parseDds, parseNif, parseTri, type NifMaterial } from '@tes5/assets';
import { allConditionFunctions, isFormKey, newCondition, parseFormKey, recordTypeName, type FormKey, type Navmesh, type VmadProperty } from '@tes5/esp';
import { validateNavmesh } from '@tes5/navmesh';
import {
  NpcService,
  QuestService,
  ScriptService,
  WorldService,
  Workspace,
  allUiSchemas,
  compactFormIds,
  computeBounds,
  detectInstall,
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
  type WorkspaceEvent,
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
  loadOrder: { name: string; active: boolean; loaded: boolean; isMaster: boolean; isLight: boolean; isLocalized: boolean; masters: string[]; isActivePlugin: boolean }[];
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
  npcs?: NpcService;
  quests?: QuestService;
  scripts?: ScriptService;
  private source?: string;
  private listeners = new Set<Listener>();
  private meshCache = new Map<string, MeshPayload>();

  constructor(
    readonly fs: FileSystem,
    readonly runner?: ProcessRunner,
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

  async open(opts: OpenOptions): Promise<SessionInfo> {
    let ws: Workspace;
    if (opts.kind === 'mo2') {
      if (!opts.path) throw new Error('Pick your Mod Organizer 2 instance folder');
      const inst = await readMo2Instance(this.fs, opts.path);
      const profile = await readMo2Profile(this.fs, inst, opts.profile);
      const install = inst.gamePath ? await detectInstall(this.fs, inst.gamePath) : undefined;
      ws = new Workspace(this.fs, {
        game: install?.game ?? 'SkyrimSE',
        roots: profile.roots,
        outputDir: opts.outputDir ?? inst.overwriteDir,
        loadOrder: profile.plugins,
      });
      this.source = `MO2: ${inst.instanceDir} (${profile.name})`;
    } else {
      if (!opts.path) throw new Error('Pick your Skyrim folder');
      const install = await detectInstall(this.fs, opts.path);
      if (!install) throw new Error(`No Skyrim installation found in ${opts.path}`);
      ws = new Workspace(this.fs, { game: install.game, roots: [install.dataDir], outputDir: opts.outputDir ?? install.dataDir, loadOrder: opts.loadOrder });
      this.source = opts.kind === 'demo' ? 'Demo data (in memory)' : install.gameDir ?? install.dataDir;
    }
    await ws.scan();
    this.attach(ws);
    return this.session();
  }

  private attach(ws: Workspace): void {
    this.ws = ws;
    this.world = new WorldService(ws);
    this.npcs = new NpcService(ws);
    this.scripts = new ScriptService(ws);
    this.scripts.runner = this.runner;
    this.quests = new QuestService(ws, this.scripts);
    this.meshCache.clear();
    ws.on((e) => {
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
      })),
    };
  }

  createPlugin(name: string, opts: { author?: string; description?: string; light?: boolean } = {}): SessionInfo {
    this.requireWs().createPlugin(name, opts);
    return this.session();
  }

  setActivePlugin(name: string): SessionInfo {
    this.requireWs().setActivePlugin(name);
    return this.session();
  }

  async save(opts: SaveOptions & { updateBounds?: boolean } = {}) {
    const ws = this.requireWs();
    const boundsChanged = opts.updateBounds === false ? [] : await updateBounds(ws);
    const res = await ws.save(opts);
    return { ...res, boundsChanged, session: this.session() };
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

  search(opts: { sigs?: string[]; query?: string; plugin?: string; limit?: number; offset?: number }) {
    return this.requireWs().search(opts);
  }

  recordTypes() {
    const ws = this.requireWs();
    const counts = new Map<string, number>();
    for (const { record } of ws.winners()) counts.set(record.sig, (counts.get(record.sig) ?? 0) + 1);
    return [...counts.entries()].map(([sig, count]) => ({ sig, name: recordTypeName(sig), count, editable: !!uiSchema(sig), category: uiSchema(sig)?.category ?? 'Other' })).sort((a, b) => a.name.localeCompare(b.name));
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

  cellLighting(cell: FormKey) {
    const v = this.view(cell);
    const l = (v?.data as any)?.lighting;
    if (!l) return null;
    return { ambient: l.ambient, directional: l.directional, fogNear: l.fogNear, fogFar: l.fogFar, fogColor: l.fogNearColor };
  }

  placeReference(cell: FormKey, base: FormKey, transform: Partial<Transform> = {}, opts: { persistent?: boolean } = {}) {
    return this.world!.placeReference(cell, base, transform, opts);
  }

  transformReferences(changes: { ref: FormKey; transform: Partial<Transform> }[], label?: string) {
    this.world!.transformReferences(changes, label);
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
      editorId: ws.byEditorId(edid) ? `${edid}${Date.now() % 10000}` : edid,
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
    const p = path.toLowerCase().replace(/\//g, '\\');
    const full = p.startsWith('textures\\') ? p : `textures\\${p}`;
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

  // ---------------------------------------------------------------- scripts

  scriptList() {
    return this.scripts!.list();
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
    this.scripts!.compiler = settings ?? undefined;
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

  compactFormIds() {
    return [...compactFormIds(this.requireWs()).entries()];
  }

  async updateBounds() {
    return updateBounds(this.requireWs());
  }

  async generateNavmesh(cell: FormKey, opts: { preset?: 'interior' | 'exterior' | 'detailed'; useRecast?: boolean } = {}) {
    return generateCellNavmesh(this.requireWs(), cell, opts);
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

  ownerOf(key: FormKey) {
    return parseFormKey(key).plugin;
  }
}

export type EngineMethod = {
  [K in keyof EngineHost]-?: EngineHost[K] extends (...args: any[]) => any ? K : never;
}[keyof EngineHost];
