/**
 * The editing engine. Owns the load order, resolves forms across plugins,
 * presents records as typed data with load-order independent FormKeys, and
 * applies edits to the active plugin — creating overrides, copying parent
 * cells/topics/worldspaces, and adding masters automatically.
 *
 * Every mutation goes through `transaction()`, which snapshots the active
 * plugin for undo. Records the user never touched are written back byte-for-
 * byte, so editing can't produce accidental "dirty edits".
 */
import {
  cp1252Unencodable,
  decodeCp1252,
  FormIdMapper,
  GroupType,
  MissingParentError,
  Plugin,
  PluginRecord,
  REFERENCE_SIGNATURES,
  RecordFlags,
  StringTable,
  applyTyped,
  decodeRecord,
  getRecordDef,
  hex,
  isFormKey,
  makeFormKey,
  parseFormKey,
  parsePlugin,
  parentOf,
  placeRecord,
  readCellGrid,
  readPluginHeader,
  recordTypeName,
  stringsFileNames,
  stringsKindFor,
  type CodecContext,
  type FormKey,
  type GameRelease,
  type PlaceOptions,
  type StringsKind,
  type TypedRecord,
  type UnknownSub,
} from '@tes5/esp';
import { MapMasterSource, cleanPlugin, type CleanOptions, type CleanReport } from '@tes5/cleaner';
import { basename, joinPath, type FileSystem } from './fs';
import { IMPLICIT_PLUGINS, isPluginFile, resolveLoadOrder, type LoadOrderEntry } from './game';
import { VirtualData } from './vfs';

export interface PluginSlot {
  name: string;
  active: boolean;
  /** Where the file lives (highest-priority root that has it). */
  path?: string;
  plugin?: Plugin;
  mapper?: FormIdMapper;
  isMaster: boolean;
  isLight: boolean;
  isLocalized: boolean;
  masters: string[];
  strings?: Partial<Record<StringsKind, StringTable>>;
  /** Why the plugin couldn't be read or loaded (it is skipped). */
  error?: string;
}

export interface WorkspaceOptions {
  game: GameRelease;
  /** Loose roots, lowest priority first (game Data, then mods..., overwrite). */
  roots: string[];
  /** Where saved plugins/scripts go (Data folder, or an MO2 mod/overwrite folder). */
  outputDir: string;
  /** Explicit load order; defaults to all plugins found, implicit ones active. */
  loadOrder?: LoadOrderEntry[];
  language?: string;
  /** Keep this many backup copies of saved plugins (default 5). */
  backups?: number;
}

const PLACED_SIGS = new Set(['REFR', 'ACHR', 'PGRE', 'PMIS', 'PHZD', 'PARW', 'PBAR', 'PBEA', 'PCON', 'PFLA']);

export interface RecordSummary {
  formKey: FormKey;
  sig: string;
  editorId?: string;
  name?: string;
  /** Plugin that defines the form. */
  owner: string;
  /** Plugin whose version wins. */
  winner: string;
  /** True if the active plugin contains (overrides or defines) it. */
  inActive: boolean;
  deleted: boolean;
  /** For placed objects (references): the name or EditorID of what's placed. */
  base?: string;
}

export interface RecordView extends RecordSummary {
  typeName: string;
  flags: number;
  formVersion: number;
  /** Plugins containing this form, in load order. */
  overrides: string[];
  /** Plugin the view was decoded from. */
  source: string;
  data: Record<string, unknown>;
  unknown: UnknownSub[];
  hasSchema: boolean;
  lossless: boolean;
  errors: string[];
  subrecords: { sig: string; size: number }[];
  /** Parent cell/topic/worldspace (as FormKeys) when the record lives in child groups. */
  parent: { cell?: FormKey; topic?: FormKey; worldspace?: FormKey; persistent?: boolean };
}

export interface SaveResult {
  path: string;
  bytes: number;
  clean?: CleanReport;
  warnings: string[];
  extraFiles: string[];
}

export interface SaveOptions {
  /** Remove identical-to-master records before saving (default true). */
  removeItms?: boolean;
  clean?: CleanOptions;
  /** Generate SEQ/<plugin>.seq when needed (default true). */
  generateSeq?: boolean;
}

export class WorkspaceError extends Error {}

const ZERO_KEY = null;

interface WinnerEntry {
  key: FormKey;
  slot: PluginSlot;
  slotIndex: number;
  record: PluginRecord;
  /** Cached EditorID / name (null = none); undefined until first read. */
  edid?: string | null;
  name?: string | null;
}

interface BaseIndex {
  entries: WinnerEntry[];
  byKey: Map<FormKey, WinnerEntry>;
  bySig: Map<string, WinnerEntry[]>;
  activeIdx: number;
  byEdid?: Map<string, WinnerEntry>;
}


export class Workspace {
  readonly slots: PluginSlot[] = [];
  readonly vfs: VirtualData;
  activeName?: string;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  /** Generated files (scripts) written since the last undo step; attached to the next one. */
  private pendingFiles: FileChange[] = [];
  /** File writes from undo/redo still in flight (save waits for them). */
  private io: Promise<unknown> = Promise.resolve();

  /** Wait for files restored by undo/redo to reach the disk. */
  async filesSettled(): Promise<void> {
    await this.io;
  }
  private dirty = false;
  private listeners = new Set<(e: WorkspaceEvent) => void>();
  /**
   * Winning records of every loaded plugin except the active one, built on
   * first use. The active plugin (small, constantly edited) is merged in at
   * query time, so edits never invalidate this index.
   */
  private baseIndex: BaseIndex | null = null;

  constructor(
    readonly fs: FileSystem,
    readonly options: WorkspaceOptions,
  ) {
    this.vfs = new VirtualData(fs, { game: options.game, roots: options.roots, plugins: [] });
  }

  get game(): GameRelease {
    return this.options.game;
  }

  get language(): string {
    return this.options.language ?? 'english';
  }

  // ---------------------------------------------------------------- events

  on(fn: (e: WorkspaceEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Goes up on every change to the loaded data (edits, undo, loading); lets services cache derived lists. */
  revision = 0;

  private emit(e: WorkspaceEvent): void {
    if (e.type === 'loaded' || e.type === 'loadOrder' || e.type === 'activeChanged') this.baseIndex = null;
    if (e.type !== 'warning' && e.type !== 'saved') this.revision++;
    for (const l of this.listeners) l(e);
  }

  // ---------------------------------------------------------------- loading

  /** Discover plugins in the roots, build the load order and read headers. */
  async scan(): Promise<void> {
    const onDisk = new Map<string, string>();
    for (const root of this.options.roots) {
      let entries: { name: string; isDirectory: boolean }[] = [];
      try {
        entries = await this.fs.readdir(root);
      } catch {
        continue;
      }
      for (const e of entries) if (!e.isDirectory && isPluginFile(e.name)) onDisk.set(e.name.toLowerCase(), joinPath(root, e.name));
    }
    // Also include files already written to the output dir.
    try {
      for (const e of await this.fs.readdir(this.options.outputDir)) if (!e.isDirectory && isPluginFile(e.name)) onDisk.set(e.name.toLowerCase(), joinPath(this.options.outputDir, e.name));
    } catch {
      // output dir may not exist yet
    }
    const names = [...onDisk.values()].map((p) => basename(p));
    const order = resolveLoadOrder(this.game, names, this.options.loadOrder ?? names.map((n) => ({ name: n, active: IMPLICIT_PLUGINS[this.game].some((i) => i.toLowerCase() === n.toLowerCase()) })));
    this.slots.length = 0;
    for (const e of order) {
      const path = onDisk.get(e.name.toLowerCase())!;
      let header: ReturnType<typeof readPluginHeader>;
      try {
        header = readPluginHeader(await this.readHeaderBytes(path), e.name);
        void header.masters; // parse the header now so a corrupt one is caught here
      } catch (err) {
        this.slots.push({ name: e.name, active: false, path, isMaster: /\.esm$/i.test(e.name), isLight: /\.esl$/i.test(e.name), isLocalized: false, masters: [], error: `Unreadable header: ${(err as Error).message}` });
        this.emit({ type: 'warning', message: `${e.name} can't be read and was skipped (${(err as Error).message})` });
        continue;
      }
      this.slots.push({
        name: e.name,
        active: e.active,
        path,
        isMaster: header.loadsAsMaster,
        isLight: header.isESL,
        isLocalized: header.isLocalized,
        masters: header.masters,
      });
    }
    this.emit({ type: 'loadOrder' });
  }

  private async readHeaderBytes(path: string): Promise<Uint8Array> {
    if (this.fs.openRandomAccess) {
      const f = this.fs.openRandomAccess(path);
      try {
        const head = f.read(0, 24);
        const size = new DataView(head.buffer, head.byteOffset, 24).getUint32(4, true);
        return f.read(0, Math.min(f.size, 24 + size)).slice();
      } finally {
        f.close();
      }
    }
    return this.fs.readFile(path);
  }

  /** Activate a plugin (and its masters) in the load order. */
  setActive(name: string, active: boolean): void {
    const slot = this.slot(name);
    if (!slot) throw new WorkspaceError(`Unknown plugin ${name}`);
    slot.active = active;
    if (active) for (const m of slot.masters) this.setActive(m, true);
    this.emit({ type: 'loadOrder' });
  }

  /** Parse every active plugin (record data stays lazy). */
  async load(onProgress?: (name: string, i: number, n: number) => void): Promise<void> {
    const active = this.slots.filter((s) => s.active);
    for (let i = 0; i < active.length; i++) {
      const s = active[i]!;
      onProgress?.(s.name, i, active.length);
      if (s.plugin || !s.path || !s.active) continue;
      // A broken plugin (or one whose masters are missing) is skipped, not fatal:
      // big load orders often contain one, and everything else should still open.
      const missing = s.masters.filter((m) => !this.slot(m)?.active);
      if (missing.length) {
        s.active = false;
        s.error = `Missing or skipped master(s): ${missing.join(', ')}`;
        this.emit({ type: 'warning', message: `${s.name} was skipped: it needs ${missing.join(', ')}` });
        continue;
      }
      try {
        s.plugin = parsePlugin(await this.fs.readFile(s.path), s.name);
        s.mapper = new FormIdMapper(s.name, s.plugin.masters);
        s.error = undefined;
      } catch (err) {
        s.plugin = undefined;
        s.active = false;
        s.error = `Corrupt: ${(err as Error).message}`;
        this.emit({ type: 'warning', message: `${s.name} is damaged and was skipped (${(err as Error).message})` });
      }
    }
    this.vfs.options.plugins = this.slots.filter((s) => s.active).map((s) => s.name);
    await this.vfs.build();
    this.emit({ type: 'loaded' });
  }

  slot(name: string): PluginSlot | undefined {
    const l = name.toLowerCase();
    return this.slots.find((s) => s.name.toLowerCase() === l);
  }

  loaded(): PluginSlot[] {
    return this.slots.filter((s) => s.plugin);
  }

  private slotIndex(name: string): number {
    const l = name.toLowerCase();
    return this.slots.findIndex((s) => s.name.toLowerCase() === l);
  }

  // ---------------------------------------------------------------- active plugin

  get active(): PluginSlot | undefined {
    return this.activeName ? this.slot(this.activeName) : undefined;
  }

  private requireActive(): PluginSlot & { plugin: Plugin; mapper: FormIdMapper } {
    const a = this.active;
    if (!a || !a.plugin || !a.mapper) throw new WorkspaceError('No active plugin. Create or open a plugin to edit first.');
    return a as PluginSlot & { plugin: Plugin; mapper: FormIdMapper };
  }

  /** Create a new plugin at the end of the load order and make it the active (edited) file. */
  createPlugin(name: string, opts: { author?: string; description?: string; light?: boolean } = {}): void {
    if (!isPluginFile(name)) throw new WorkspaceError('Plugin names must end in .esp, .esm or .esl');
    if (this.slot(name)) throw new WorkspaceError(`${name} already exists in the load order`);
    const masters = IMPLICIT_PLUGINS[this.game].filter((m) => this.slot(m)?.plugin).slice(0, 1);
    const plugin = Plugin.create(name, { game: this.game, masters, author: opts.author, description: opts.description });
    if (opts.light) plugin.isESL = true;
    const slot: PluginSlot = {
      name,
      active: true,
      path: joinPath(this.options.outputDir, name),
      plugin,
      mapper: new FormIdMapper(name, plugin.masters),
      isMaster: plugin.loadsAsMaster,
      isLight: plugin.isESL,
      isLocalized: false,
      masters: plugin.masters,
    };
    if (slot.isMaster) {
      const lastMaster = this.slots.reduce((acc, s, i) => (s.isMaster ? i : acc), -1);
      this.slots.splice(lastMaster + 1, 0, slot);
    } else this.slots.push(slot);
    this.activeName = name;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = true;
    this.emit({ type: 'loadOrder' });
    this.emit({ type: 'activeChanged' });
  }

  /** Make an existing, loaded plugin the edited file. */
  setActivePlugin(name: string): void {
    const s = this.slot(name);
    if (!s?.plugin) throw new WorkspaceError(`${name} is not loaded`);
    if (this.slotIndex(name) < this.slots.length - 1 && this.slots.slice(this.slotIndex(name) + 1).some((x) => x.plugin && x.masters.some((m) => m.toLowerCase() === name.toLowerCase()))) {
      // Editing a master of other loaded plugins is allowed but risky; the UI shows this.
      this.emit({ type: 'warning', message: `${name} is a master of other loaded plugins; FormIDs you remove may break them.` });
    }
    this.activeName = s.name;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.emit({ type: 'activeChanged' });
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  // ---------------------------------------------------------------- FormIDs

  /** FormKey for a FormID stored in `slot`'s file. */
  keyOf(slot: PluginSlot, localId: number): FormKey | null {
    if (localId === 0) return ZERO_KEY;
    const idx = localId >>> 24;
    const masters = slot.plugin?.masters ?? slot.masters;
    if (idx < masters.length) return makeFormKey(localId & 0xffffff, masters[idx]!);
    // Hard-coded engine forms (e.g. PlayerRef 0x14) are valid in any plugin.
    if ((localId & 0xffffff) < 0x800 && idx === 0) return makeFormKey(localId & 0xffffff, masters[0] ?? IMPLICIT_PLUGINS[this.game][0]!);
    return makeFormKey(localId & 0xffffff, slot.name);
  }

  /**
   * FormID to store in the active plugin for a FormKey. Adds the owning plugin
   * as a master when needed (appended, so existing FormIDs never shift).
   */
  localIdForActive(key: FormKey | null | undefined): number {
    if (!key) return 0;
    const a = this.requireActive();
    const { objectId, plugin } = parseFormKey(key);
    if (plugin.toLowerCase() === a.name.toLowerCase()) return ((a.plugin.masters.length << 24) | objectId) >>> 0;
    const existing = a.plugin.masters.findIndex((m) => m.toLowerCase() === plugin.toLowerCase());
    if (existing >= 0) return ((existing << 24) | objectId) >>> 0;
    const owner = this.slot(plugin);
    if (!owner) throw new WorkspaceError(`Cannot reference ${key}: ${plugin} is not in the load order`);
    if (this.slotIndex(plugin) > this.slotIndex(a.name)) throw new WorkspaceError(`Cannot reference ${key}: ${plugin} loads after ${a.name}`);
    if (a.plugin.masters.length >= 254) throw new WorkspaceError('Too many masters (max 254)');
    // Add the new master and its own masters first.
    for (const m of owner.masters) if (!a.plugin.masters.some((x) => x.toLowerCase() === m.toLowerCase())) this.addMaster(m);
    this.addMaster(owner.name);
    const idx = a.plugin.masters.findIndex((m) => m.toLowerCase() === plugin.toLowerCase());
    return ((idx << 24) | objectId) >>> 0;
  }

  private addMaster(name: string): void {
    const a = this.requireActive();
    // Records new to the plugin use index = masters.length; adding a master shifts that, so remap them.
    const oldSelf = a.plugin.masters.length;
    const masters = [...a.plugin.masters, name];
    a.plugin.setMasters(masters);
    a.masters = masters;
    a.mapper = new FormIdMapper(a.name, masters);
    this.remapSelfIndex(a.plugin, oldSelf, masters.length);
    this.emit({ type: 'warning', message: `Added ${name} as a master of ${a.name}` });
  }

  /** Rewrite FormIDs that use the plugin's own index after the master list grew. */
  private remapSelfIndex(plugin: Plugin, oldIndex: number, newIndex: number): void {
    if (oldIndex === newIndex) return;
    const oldMapper = new FormIdMapper(plugin.fileName, plugin.masters.slice(0, oldIndex));
    const newMapper = new FormIdMapper(plugin.fileName, plugin.masters);
    let hadSelf = false;
    for (const r of plugin.records()) if (r.formId >>> 24 === oldIndex) hadSelf = true;
    if (!hadSelf) return;
    const failures: string[] = [];
    for (const loc of [...plugin.walk()]) {
      const r = loc.record;
      const typed = decodeRecord(r, { mapFormId: (id) => oldMapper.toKey(id) });
      if (typed.hasSchema && typed.lossless && typed.unknown.length === 0) {
        applyTyped(r, typed.data, [], { unmapFormId: (v) => (v ? newMapper.toLocal(String(v)) ?? 0 : 0) });
      } else if (this.containsSelfRefs(r, oldIndex)) {
        failures.push(r.toString());
      }
      if (r.formId >>> 24 === oldIndex) r.formId = ((newIndex << 24) | (r.formId & 0xffffff)) >>> 0;
    }
    for (const g of walkGroups(plugin)) {
      if ([GroupType.CellChildren, GroupType.TopicChildren, GroupType.WorldChildren, GroupType.CellPersistentChildren, GroupType.CellTemporaryChildren].includes(g.type) && g.label >>> 24 === oldIndex) {
        g.label = ((newIndex << 24) | (g.label & 0xffffff)) >>> 0;
      }
    }
    plugin.invalidateIndex();
    if (failures.length) this.emit({ type: 'warning', message: `Could not remap FormIDs inside ${failures.length} record(s) without a typed schema: ${failures.slice(0, 5).join(', ')}` });
  }

  private containsSelfRefs(r: PluginRecord, index: number): boolean {
    for (const s of r.subrecords) {
      for (let i = 0; i + 4 <= s.data.byteLength; i++) if (s.data[i + 3] === index && (s.data[i] || s.data[i + 1] || s.data[i + 2])) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- lookup

  /** All versions of a form in load order (defining plugin first). */
  versions(key: FormKey): { slot: PluginSlot; record: PluginRecord }[] {
    const out: { slot: PluginSlot; record: PluginRecord }[] = [];
    const { plugin } = parseFormKey(key);
    const ownerIdx = this.slotIndex(plugin);
    if (ownerIdx < 0) return out;
    for (let i = ownerIdx; i < this.slots.length; i++) {
      const s = this.slots[i]!;
      if (!s.plugin || !s.mapper) continue;
      const local = s.mapper.toLocal(key);
      if (local === undefined) continue;
      const r = s.plugin.getRecord(local);
      if (r) out.push({ slot: s, record: r });
    }
    return out;
  }

  winner(key: FormKey): { slot: PluginSlot; record: PluginRecord } | undefined {
    const v = this.versions(key);
    return v[v.length - 1];
  }

  exists(key: FormKey): boolean {
    return !!this.winner(key);
  }

  private codecContext(slot: PluginSlot): Partial<CodecContext> {
    return {
      localized: slot.plugin?.isLocalized ?? false,
      mapFormId: (id) => this.keyOf(slot, id),
      lookupString: slot.plugin?.isLocalized ? (subSig, id) => this.lookupString(slot, subSig, id) : undefined,
    };
  }

  private lookupString(slot: PluginSlot, subSig: string, id: number): string | undefined {
    // ID 0 is the game's "no text" (e.g. a spell without a description).
    if (id === 0) return '';
    const kind = stringsKindFor(this.currentRecordSig ?? '', subSig);
    return slot.strings?.[kind]?.get(id);
  }

  private currentRecordSig?: string;

  /** Load localized string tables for a plugin (from loose files or archives). */
  async loadStrings(slot: PluginSlot): Promise<void> {
    if (!slot.isLocalized || slot.strings) return;
    slot.strings = {};
    const names = stringsFileNames(slot.name, this.language);
    for (const kind of ['STRINGS', 'DLSTRINGS', 'ILSTRINGS'] as const) {
      const p = names[kind];
      if (this.vfs.has(p)) {
        try {
          slot.strings[kind] = StringTable.parse(await this.vfs.read(p), kind);
        } catch {
          // corrupt table: leave missing
        }
      }
    }
  }

  async loadAllStrings(): Promise<void> {
    for (const s of this.loaded()) await this.loadStrings(s);
    this.baseIndex = null;
  }

  decode(slot: PluginSlot, record: PluginRecord): TypedRecord {
    this.currentRecordSig = record.sig;
    try {
      return decodeRecord(record, this.codecContext(slot));
    } finally {
      this.currentRecordSig = undefined;
    }
  }

  summary(key: FormKey): RecordSummary | undefined {
    const v = this.versions(key);
    const w = v[v.length - 1];
    if (!w) return undefined;
    const name = this.readName(w.slot, w.record);
    return {
      formKey: key,
      sig: w.record.sig,
      editorId: w.record.editorId,
      name,
      owner: parseFormKey(key).plugin,
      winner: w.slot.name,
      inActive: !!this.activeName && v.some((x) => x.slot.name === this.activeName),
      deleted: w.record.isDeleted,
    };
  }

  private readName(slot: PluginSlot, record: PluginRecord): string | undefined {
    const data = record.peek('FULL');
    if (!data) return undefined;
    if (slot.plugin?.isLocalized) {
      if (data.byteLength < 4) return undefined;
      const id = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true);
      return slot.strings?.STRINGS?.get(id);
    }
    let end = data.indexOf(0);
    if (end < 0) end = data.byteLength;
    return decodeCp1252(data.subarray(0, end));
  }

  view(key: FormKey, fromPlugin?: string): RecordView | undefined {
    const v = this.versions(key);
    const pick = fromPlugin ? v.find((x) => x.slot.name.toLowerCase() === fromPlugin.toLowerCase()) : v[v.length - 1];
    if (!pick) return undefined;
    const typed = this.decode(pick.slot, pick.record);
    const parentLocal = pick.slot.plugin ? parentOf(pick.slot.plugin, pick.record.formId) : {};
    const toKey = (id?: number) => (id === undefined ? undefined : (this.keyOf(pick.slot, id) ?? undefined));
    return {
      formKey: key,
      sig: pick.record.sig,
      typeName: recordTypeName(pick.record.sig),
      editorId: pick.record.editorId,
      name: this.readName(pick.slot, pick.record),
      owner: parseFormKey(key).plugin,
      winner: v[v.length - 1]!.slot.name,
      inActive: !!this.activeName && v.some((x) => x.slot.name === this.activeName),
      deleted: pick.record.isDeleted,
      flags: pick.record.flags,
      formVersion: pick.record.formVersion,
      overrides: v.map((x) => x.slot.name),
      source: pick.slot.name,
      data: typed.data,
      unknown: typed.unknown,
      hasSchema: typed.hasSchema,
      lossless: typed.lossless,
      errors: typed.errors,
      subrecords: pick.record.subrecords.map((s) => ({ sig: s.sig, size: s.data.byteLength })),
      parent: { cell: toKey(parentLocal.cell), topic: toKey(parentLocal.topic), worldspace: toKey(parentLocal.worldspace), persistent: parentLocal.persistent },
    };
  }

  private getBaseIndex(): BaseIndex {
    if (this.baseIndex) return this.baseIndex;
    const activeIdx = this.activeName ? this.slotIndex(this.activeName) : -1;
    const entries: WinnerEntry[] = [];
    const byKey = new Map<FormKey, WinnerEntry>();
    const bySig = new Map<string, WinnerEntry[]>();
    for (let i = this.slots.length - 1; i >= 0; i--) {
      const s = this.slots[i]!;
      if (!s.plugin || i === activeIdx) continue;
      for (const r of s.plugin.records()) {
        const key = this.keyOf(s, r.formId);
        if (!key || byKey.has(key)) continue;
        const e: WinnerEntry = { key, slot: s, slotIndex: i, record: r };
        byKey.set(key, e);
        entries.push(e);
        let list = bySig.get(r.sig);
        if (!list) bySig.set(r.sig, (list = []));
        list.push(e);
      }
    }
    this.baseIndex = { entries, byKey, bySig, activeIdx };
    return this.baseIndex;
  }

  /**
   * Build the lookup indexes now (winner index, per-plugin FormID maps) so the
   * first search or cell open doesn't pay for it. Call after loading.
   */
  warm(): void {
    for (const s of this.loaded()) void s.plugin!.index;
    this.getBaseIndex();
  }

  /** Winning records (optionally of some signatures), base index merged with the active plugin. */
  private winnerEntries(sigs?: readonly string[]): WinnerEntry[] {
    const base = this.getBaseIndex();
    const wanted = sigs?.length ? new Set(sigs) : undefined;
    const a = this.active;
    const fromActive = new Map<FormKey, WinnerEntry>();
    if (a?.plugin) {
      const iter = wanted && wanted.size === 1 ? a.plugin.recordsOfType([...wanted][0]!) : a.plugin.records();
      const ai = this.slotIndex(a.name);
      for (const r of iter) {
        if (wanted && !wanted.has(r.sig)) continue;
        const key = this.keyOf(a, r.formId);
        if (!key || fromActive.has(key)) continue;
        const b = base.byKey.get(key);
        if (b && b.slotIndex > ai) continue; // a later plugin overrides the active one
        fromActive.set(key, { key, slot: a, slotIndex: ai, record: r });
      }
    }
    const lists = wanted ? [...wanted].map((w) => base.bySig.get(w) ?? []) : [base.entries];
    const out: WinnerEntry[] = [];
    for (const list of lists) for (const e of list) if (!fromActive.has(e.key)) out.push(e);
    for (const e of fromActive.values()) out.push(e);
    return out;
  }

  /** Iterate winning records of the given signatures across the load order. */
  *winners(sigs?: readonly string[]): Generator<{ key: FormKey; slot: PluginSlot; record: PluginRecord }> {
    for (const e of this.winnerEntries(sigs)) yield e;
  }

  private edidOf(e: WinnerEntry): string | undefined {
    if (e.edid === undefined) e.edid = e.record.editorId ?? null;
    return e.edid ?? undefined;
  }

  private nameOf(e: WinnerEntry): string | undefined {
    if (e.name === undefined) e.name = this.readName(e.slot, e.record) ?? null;
    return e.name ?? undefined;
  }

  /** "Barrel" for a reference that places a barrel (its base's name, else EditorID). */
  private placedBaseLabel(e: WinnerEntry): string | undefined {
    if (!PLACED_SIGS.has(e.record.sig)) return undefined;
    const sub = e.record.get('NAME');
    if (!sub || sub.data.byteLength < 4) return undefined;
    const key = this.keyOf(e.slot, new DataView(sub.data.buffer, sub.data.byteOffset, 4).getUint32(0, true));
    const b = key ? this.getBaseIndex().byKey.get(key) : undefined;
    return b ? (this.nameOf(b) ?? this.edidOf(b)) : undefined;
  }

  /** Search winning records by EditorID / name / FormID text. */
  search(opts: { sigs?: readonly string[]; query?: string; plugin?: string; named?: boolean; limit?: number; offset?: number } = {}): { total: number; items: RecordSummary[] } {
    const q = opts.query?.trim().toLowerCase() ?? '';
    const plugin = opts.plugin?.toLowerCase();
    const matches: WinnerEntry[] = [];
    for (const e of this.winnerEntries(opts.sigs)) {
      if (plugin && e.slot.name.toLowerCase() !== plugin && parseFormKey(e.key).plugin.toLowerCase() !== plugin) continue;
      if (opts.named && !this.nameOf(e)?.trim()) continue;
      if (q) {
        const edid = this.edidOf(e);
        if (!(edid?.toLowerCase().includes(q) || this.nameOf(e)?.toLowerCase().includes(q) || e.key.toLowerCase().includes(q))) continue;
      }
      matches.push(e);
    }
    const sortKey = (e: WinnerEntry) => (this.edidOf(e) ?? '').toLowerCase();
    const keyed = matches.map((e) => ({ e, k: sortKey(e) }));
    keyed.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.e.key < b.e.key ? -1 : a.e.key > b.e.key ? 1 : 0));
    const offset = opts.offset ?? 0;
    const items = keyed.slice(offset, offset + (opts.limit ?? 500)).map(({ e }) => ({
      formKey: e.key,
      sig: e.record.sig,
      editorId: this.edidOf(e),
      name: this.nameOf(e),
      owner: parseFormKey(e.key).plugin,
      winner: e.slot.name,
      inActive: e.slot.name === this.activeName,
      deleted: e.record.isDeleted,
      base: this.placedBaseLabel(e),
    }));
    return { total: matches.length, items };
  }

  /** EditorID → FormKey of the winning record. */
  byEditorId(editorId: string): FormKey | undefined {
    const want = editorId.toLowerCase();
    const base = this.getBaseIndex();
    if (!base.byEdid) {
      const m = new Map<string, WinnerEntry>();
      for (const e of base.entries) {
        const ed = this.edidOf(e)?.toLowerCase();
        if (ed && !m.has(ed)) m.set(ed, e);
      }
      base.byEdid = m;
    }
    const a = this.active;
    if (a?.plugin) {
      for (const r of a.plugin.records()) {
        if (r.editorId?.toLowerCase() !== want) continue;
        const key = this.keyOf(a, r.formId);
        if (key) return key;
      }
    }
    const hit = base.byEdid.get(want);
    if (hit && a?.plugin) {
      // The active plugin may have renamed this form.
      const local = a.mapper?.toLocal(hit.key);
      const mine = local !== undefined ? a.plugin.getRecord(local) : undefined;
      if (mine && mine.editorId?.toLowerCase() !== want) return undefined;
    }
    return hit?.key;
  }

  // ---------------------------------------------------------------- transactions & undo

  /** Run a mutation with undo support. */
  transaction<T>(label: string, fn: () => T): T {
    // Nested transactions fold into the outermost one (one undo step), but
    // still count as a change, so cached lists (cells…) see what they made.
    if (this.txDepth > 0) {
      try {
        return fn();
      } finally {
        this.revision++;
      }
    }
    const a = this.requireActive();
    const before = a.plugin.serialize();
    this.txDepth++;
    try {
      const result = fn();
      this.undoStack.push({ label, bytes: before, files: this.takePendingFiles() });
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
      this.dirty = true;
        this.emit({ type: 'changed', label });
      return result;
    } catch (e) {
      this.restore(before);
      // Generated files written for this edit are rolled back too.
      const files = this.takePendingFiles();
      if (files) this.applyFiles(files, 'before');
      throw e;
    } finally {
      this.txDepth--;
    }
  }

  private txDepth = 0;

  /**
   * Like transaction(), for edits that await (writing generated scripts):
   * everything inside, including nested transactions and script writes,
   * becomes one undo step.
   */
  async transactionAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (this.txDepth > 0) {
      try {
        return await fn();
      } finally {
        this.revision++;
      }
    }
    const a = this.requireActive();
    const before = a.plugin.serialize();
    this.txDepth++;
    try {
      const result = await fn();
      this.undoStack.push({ label, bytes: before, files: this.takePendingFiles() });
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
      this.dirty = true;
      this.emit({ type: 'changed', label });
      return result;
    } catch (e) {
      this.restore(before);
      const files = this.takePendingFiles();
      if (files) this.applyFiles(files, 'before');
      throw e;
    } finally {
      this.txDepth--;
    }
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get undoLabel(): string | undefined {
    return this.undoStack[this.undoStack.length - 1]?.label;
  }
  get redoLabel(): string | undefined {
    return this.redoStack[this.redoStack.length - 1]?.label;
  }

  undo(): boolean {
    const a = this.requireActive();
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.redoStack.push({ label: entry.label, bytes: a.plugin.serialize(), files: entry.files });
    this.restore(entry.bytes);
    if (entry.files) this.applyFiles(entry.files, 'before');
    this.emit({ type: 'changed', label: `Undo ${entry.label}` });
    return true;
  }

  redo(): boolean {
    const a = this.requireActive();
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this.undoStack.push({ label: entry.label, bytes: a.plugin.serialize(), files: entry.files });
    this.restore(entry.bytes);
    if (entry.files) this.applyFiles(entry.files, 'after');
    this.emit({ type: 'changed', label: `Redo ${entry.label}` });
    return true;
  }

  /**
   * Record that a generated file (fragment or trigger script) was written as
   * part of the edit in progress, so undo/redo restore it with the plugin.
   */
  trackFileChange(change: FileChange): void {
    const prev = this.pendingFiles.find((f) => f.path.toLowerCase() === change.path.toLowerCase());
    if (prev) prev.after = change.after;
    else this.pendingFiles.push({ ...change });
  }

  private takePendingFiles(): FileChange[] | undefined {
    const files = this.pendingFiles;
    this.pendingFiles = [];
    return files.length ? files : undefined;
  }

  private applyFiles(files: FileChange[], which: 'before' | 'after'): void {
    const list = (which === 'before' ? [...files].reverse() : files).map((f) => ({ path: f.path, data: f[which] }));
    // Listeners (the script service) update their caches right away; disk follows.
    this.emit({ type: 'filesRestored', files: list });
    this.io = this.io.then(() =>
      Promise.all(list.map((f) => (f.data ? this.fs.writeFile(f.path, f.data) : this.fs.remove(f.path).catch(() => undefined)))),
    );
  }

  private restore(bytes: Uint8Array): void {
    const a = this.requireActive();
    a.plugin = parsePlugin(bytes, a.name);
    a.masters = a.plugin.masters;
    a.mapper = new FormIdMapper(a.name, a.masters);
    a.isLight = a.plugin.isESL;
    a.isMaster = a.plugin.loadsAsMaster;
  }

  // ---------------------------------------------------------------- editing

  /** Ensure the active plugin has a copy of `key` (creating an override). Returns the record there. */
  private ensureInActive(key: FormKey): PluginRecord {
    const a = this.requireActive();
    const localExisting = a.mapper.toLocal(key);
    if (localExisting !== undefined) {
      const r = a.plugin.getRecord(localExisting);
      if (r) return r;
    }
    const versions = this.versions(key);
    const prior = versions.filter((v) => this.slotIndex(v.slot.name) < this.slotIndex(a.name));
    const src = prior[prior.length - 1];
    if (!src) throw new WorkspaceError(`${key} does not exist in any plugin before ${a.name}`);
    const placement = this.placementFor(src.slot, src.record);
    // Parents first: copying them can add masters, which would shift this copy's FormIDs.
    this.ensureParents(src.record.sig, placement);
    const copy = this.copyRecordToActive(src.slot, src.record);
    this.placeInActive(copy, placement);
    return copy;
  }

  /** Copy a record from another plugin into the active one, remapping FormIDs. */
  private copyRecordToActive(from: PluginSlot, record: PluginRecord): PluginRecord {
    const a = this.requireActive();
    const typed = this.decode(from, record);
    const copy = new PluginRecord({ sig: record.sig, formId: 0, flags: record.flags & ~RecordFlags.Compressed, formVersion: record.formVersion, vc1: record.vc1, vc2: record.vc2 });
    copy.formId = this.localIdForActive(this.keyOf(from, record.formId));
    if (record.isCompressed) copy.setFlag(RecordFlags.Compressed, true);
    if (typed.hasSchema && typed.lossless && typed.unknown.length === 0) {
      this.prepareMasters(typed.data);
      copy.formId = this.localIdForActive(this.keyOf(from, record.formId));
      applyTyped(copy, typed.data, [], this.encodeContext());
      return copy;
    }
    // No (lossless) schema: copy raw bytes if the master layouts agree.
    const compatible = from.plugin!.masters.every((m, i) => a.plugin.masters[i]?.toLowerCase() === m.toLowerCase());
    if (!compatible) {
      // Make sure the source's masters come first in the same order (only possible if active has none yet beyond them).
      throw new WorkspaceError(`${record.toString()} from ${from.name} has no typed schema and its master list differs from ${a.name}'s; edit it in a plugin with a matching master order.`);
    }
    for (const m of from.plugin!.masters) this.localIdForActive(makeFormKey(0x800, m));
    copy.subrecords = record.subrecords.map((s) => ({ sig: s.sig, data: s.data.slice() }));
    return copy;
  }

  /**
   * Add every master the data needs *before* encoding. Adding a master shifts
   * the plugin's own index, so doing it mid-encode would corrupt FormIDs.
   */
  private prepareMasters(data: unknown): void {
    const visit = (v: unknown): void => {
      if (typeof v === 'string') {
        if (isFormKey(v)) this.localIdForActive(v);
        return;
      }
      if (!v || typeof v !== 'object' || v instanceof Uint8Array) return;
      if (Array.isArray(v)) v.forEach(visit);
      else for (const x of Object.values(v)) visit(x);
    };
    visit(data);
  }

  private encodeContext(): Partial<CodecContext> {
    const a = this.requireActive();
    return {
      localized: a.plugin.isLocalized,
      unmapFormId: (v) => this.localIdForActive(v === null || v === undefined || v === '' ? null : String(v)),
      storeString: a.plugin.isLocalized ? (subSig, text) => this.storeString(subSig, text) : undefined,
    };
  }

  private storeString(subSig: string, text: string): number {
    if (text === '') return 0;
    const a = this.requireActive();
    a.strings ??= {};
    const kind = stringsKindFor(this.currentRecordSig ?? '', subSig);
    const table = (a.strings[kind] ??= new StringTable(kind));
    for (const [id, v] of table.entries) if (v === text) return id;
    const id = Math.max(table.nextId(), ...Object.values(a.strings).map((t) => t?.nextId() ?? 1));
    table.set(id, text);
    return id;
  }

  /** Where a record lives (parent cell/topic/world) expressed as FormKeys. */
  private placementFor(slot: PluginSlot, record: PluginRecord): { cell?: FormKey; topic?: FormKey; worldspace?: FormKey; persistent?: boolean; worldCell?: boolean } {
    if (!slot.plugin) return {};
    const p = parentOf(slot.plugin, record.formId);
    const out: { cell?: FormKey; topic?: FormKey; worldspace?: FormKey; persistent?: boolean; worldCell?: boolean } = {};
    if (p.cell !== undefined) out.cell = this.keyOf(slot, p.cell) ?? undefined;
    if (p.topic !== undefined) out.topic = this.keyOf(slot, p.topic) ?? undefined;
    if (p.worldspace !== undefined) out.worldspace = this.keyOf(slot, p.worldspace) ?? undefined;
    if (p.persistent !== undefined) out.persistent = p.persistent;
    // The worldspace's persistent cell sits directly under the world (vanilla ones also carry a grid).
    if (record.sig === 'CELL' && p.worldspace !== undefined && (!readCellGrid(record) || (record.flags & RecordFlags.Persistent) !== 0)) out.worldCell = true;
    return out;
  }

  private ensureParents(sig: string, where: { cell?: FormKey; topic?: FormKey; worldspace?: FormKey }): void {
    if (sig === 'CELL' && where.worldspace) this.ensureInActive(where.worldspace);
    if (where.cell && (REFERENCE_SIGNATURES.has(sig) || sig === 'NAVM' || sig === 'LAND')) this.ensureInActive(where.cell);
    if (sig === 'INFO' && where.topic) this.ensureInActive(where.topic);
  }

  /** Insert a record into the active plugin, copying parent records it needs. */
  private placeInActive(rec: PluginRecord, where: { cell?: FormKey; topic?: FormKey; worldspace?: FormKey; persistent?: boolean; worldCell?: boolean }): void {
    const a = this.requireActive();
    const opts: PlaceOptions = {};
    if (rec.sig === 'CELL' && where.worldspace) {
      this.ensureInActive(where.worldspace);
      opts.worldspace = this.localIdForActive(where.worldspace);
      if (where.worldCell) opts.persistentWorldCell = true;
    }
    if (where.cell && (REFERENCE_SIGNATURES.has(rec.sig) || rec.sig === 'NAVM' || rec.sig === 'LAND')) {
      this.ensureInActive(where.cell);
      opts.cell = this.localIdForActive(where.cell);
      opts.persistent = where.persistent;
    }
    if (rec.sig === 'INFO') {
      if (!where.topic) throw new WorkspaceError('Dialogue responses need a topic');
      this.ensureInActive(where.topic);
      opts.topic = this.localIdForActive(where.topic);
    }
    try {
      placeRecord(a.plugin, rec, opts);
    } catch (e) {
      if (e instanceof MissingParentError) throw new WorkspaceError(e.message);
      throw e;
    }
  }

  /** Replace a record's typed data in the active plugin (creating an override if needed). */
  updateRecord(key: FormKey, data: Record<string, unknown>, opts: { unknown?: UnknownSub[]; flags?: number; label?: string } = {}): RecordView {
    return this.transaction(opts.label ?? `Edit ${key}`, () => {
      const rec = this.ensureInActive(key);
      if (!getRecordDef(rec.sig)) throw new WorkspaceError(`${rec.sig} has no typed schema; use setSubrecords`);
      this.checkEditorId(data.editorId, key, rec.editorId);
      this.warnUnencodable(data);
      if (opts.flags !== undefined) rec.flags = (opts.flags & ~RecordFlags.Compressed) | (rec.flags & RecordFlags.Compressed);
      this.prepareMasters(data);
      this.currentRecordSig = rec.sig;
      try {
        applyTyped(rec, data, this.unknownForActive(key, opts.unknown), this.encodeContext());
      } finally {
        this.currentRecordSig = undefined;
      }
      return this.view(key)!;
    });
  }

  /**
   * Editor IDs must be unique and use only letters, digits and underscores
   * (the Creation Kit enforces the same). Only checked when the ID changes,
   * so editing a record from another mod with an odd ID still works.
   */
  private checkEditorId(edid: unknown, key: FormKey | null, current: string | undefined): void {
    if (typeof edid !== 'string' || edid === current) return;
    if (!edid) return;
    if (!/^[A-Za-z0-9_]+$/.test(edid)) throw new WorkspaceError(`Editor ID "${edid}" can only contain letters, digits and underscores`);
    if (edid.length > 200) throw new WorkspaceError('Editor ID is too long (200 characters max)');
    const existing = this.byEditorId(edid);
    if (existing && existing !== key) throw new WorkspaceError(`Editor ID "${edid}" is already used by ${existing}`);
  }

  /** Non-localized plugins store text as Windows-1252; say so when something won't survive. */
  private warnUnencodable(data: unknown): void {
    if (this.active?.plugin?.isLocalized) return;
    const bad = new Set<string>();
    const visit = (v: unknown, depth: number): void => {
      if (depth > 8 || v === null || v === undefined) return;
      if (typeof v === 'string') for (const c of cp1252Unencodable(v)) bad.add(c);
      else if (Array.isArray(v)) for (const x of v) visit(x, depth + 1);
      else if (typeof v === 'object' && !(v instanceof Uint8Array)) for (const x of Object.values(v)) visit(x, depth + 1);
    };
    visit(data, 0);
    if (bad.size) this.emit({ type: 'warning', message: `These characters can't be stored in a non-localized plugin and will be saved as "?": ${[...bad].slice(0, 10).join(' ')}` });
  }

  /** `base`, or `base2`, `base3`… — the first Editor ID not in use. */
  uniqueEditorId(base: string): string {
    const clean = base.replace(/[^A-Za-z0-9_]/g, '') || 'Form';
    if (!this.byEditorId(clean)) return clean;
    for (let i = 2; ; i++) if (!this.byEditorId(`${clean}${i}`)) return `${clean}${i}`;
  }

  /** Unknown subrecords are copied raw; only allowed when they can't contain shifted FormIDs. */
  private unknownForActive(_key: FormKey, unknown: UnknownSub[] | undefined): UnknownSub[] {
    return unknown ?? [];
  }

  /** Edit via a callback on the current typed data. */
  editRecord(key: FormKey, mutate: (data: Record<string, unknown>) => Record<string, unknown> | void, label?: string): RecordView {
    const current = this.ensureViewForEdit(key);
    const draft = structuredClone(current.data);
    const result = mutate(draft) ?? draft;
    return this.updateRecord(key, result, { unknown: current.unknown, label: label ?? `Edit ${current.editorId ?? key}` });
  }

  private ensureViewForEdit(key: FormKey): RecordView {
    const v = this.view(key);
    if (!v) throw new WorkspaceError(`${key} not found`);
    if (!v.hasSchema) throw new WorkspaceError(`${v.sig} has no typed schema`);
    if (!v.lossless) throw new WorkspaceError(`${v.editorId ?? key} could not be decoded losslessly; edit it in the raw subrecord view to avoid data loss`);
    return v;
  }

  /** Raw subrecord editing (works for every record type). */
  setSubrecords(key: FormKey, subs: { sig: string; data: Uint8Array }[], label?: string): void {
    this.transaction(label ?? `Edit subrecords of ${key}`, () => {
      const rec = this.ensureInActive(key);
      rec.subrecords = subs.map((s) => ({ sig: s.sig, data: s.data }));
    });
  }

  setFlags(key: FormKey, set: number, clear = 0): void {
    this.transaction(`Change flags of ${key}`, () => {
      const rec = this.ensureInActive(key);
      rec.flags = ((rec.flags | set) & ~clear) >>> 0;
      rec.markModified();
    });
  }

  /**
   * Make a placed reference persistent (or temporary): sets the flag and moves
   * the active plugin's copy into the cell's matching child group.
   */
  setPersistent(key: FormKey, persistent: boolean): void {
    this.transaction(persistent ? `Make ${key} persistent` : `Make ${key} temporary`, () => {
      const a = this.requireActive();
      const rec = this.ensureInActive(key);
      const where = this.placementFor(a, rec);
      rec.setFlag(RecordFlags.Persistent, persistent);
      rec.markModified();
      if (where.cell && where.persistent !== persistent) {
        a.plugin.removeRecord(rec.formId);
        this.placeInActive(rec, { ...where, persistent });
      }
    });
  }

  /** Create a new record in the active plugin. */
  createRecord(sig: string, data: Record<string, unknown>, where: { cell?: FormKey; topic?: FormKey; worldspace?: FormKey; persistent?: boolean; worldCell?: boolean } = {}, flags = 0): FormKey {
    if (!getRecordDef(sig)) throw new WorkspaceError(`Creating ${sig} records is not supported yet (no schema)`);
    this.checkEditorId(data.editorId, null, undefined);
    this.warnUnencodable(data);
    return this.transaction(`Create ${sig}`, () => {
      const a = this.requireActive();
      this.prepareMasters(data);
      this.ensureParents(sig, where);
      const id = a.plugin.allocateFormId();
      const key = makeFormKey(id & 0xffffff, a.name);
      const rec = PluginRecord.create(sig, id, [], flags, this.game === 'SkyrimSE' ? 44 : 43);
      if (where.persistent) rec.setFlag(RecordFlags.Persistent, true);
      this.currentRecordSig = sig;
      try {
        applyTyped(rec, data, [], this.encodeContext());
      } finally {
        this.currentRecordSig = undefined;
      }
      // FormID may have shifted if masters were added while encoding.
      rec.formId = this.localIdForActive(key);
      this.placeInActive(rec, where);
      return key;
    });
  }

  /** Duplicate a record as a new form (references keep pointing at the same forms). */
  duplicateRecord(key: FormKey, newEditorId?: string): FormKey {
    const v = this.view(key);
    if (!v) throw new WorkspaceError(`${key} not found`);
    const data = structuredClone(v.data);
    if ((typeof data.editorId === 'string' && data.editorId) || newEditorId) data.editorId = newEditorId ?? this.uniqueEditorId(`${v.editorId ?? v.sig}Copy`);
    delete data.scripts; // fragments/script bindings are not shared between forms
    return this.createRecord(v.sig, data, { cell: v.parent.cell, topic: v.parent.topic, worldspace: v.parent.worldspace, persistent: v.parent.persistent }, v.flags & ~RecordFlags.Compressed);
  }

  /**
   * Delete a form, the safe way:
   *  - forms new to the active plugin are removed;
   *  - overrides in the active plugin are reverted (removed);
   *  - placed references from masters are disabled (never deleted — deleted
   *    references crash the game);
   *  - other master forms are refused.
   */
  deleteRecord(key: FormKey): 'removed' | 'reverted' | 'disabled' {
    const a = this.requireActive();
    const owner = parseFormKey(key).plugin;
    const local = a.mapper.toLocal(key);
    const inActive = local !== undefined ? a.plugin.getRecord(local) : undefined;
    if (owner.toLowerCase() === a.name.toLowerCase()) {
      const result = this.transaction(`Delete ${key}`, () => {
        const rec = a.plugin.getRecord(local!);
        if (rec?.sig === 'INFO') this.unlinkInfo(key);
        a.plugin.removeRecord(local!);
        return 'removed' as const;
      });
      const users = this.findReferences(key, { allPlugins: true, limit: 20 }).filter((r) => r.formKey !== key);
      if (users.length) this.emit({ type: 'warning', message: `${users.length >= 20 ? '20+' : users.length} record(s) still point to the deleted ${key}: ${users.slice(0, 4).map((u) => u.editorId ?? u.formKey).join(', ')}${users.length > 4 ? '…' : ''}` });
      return result;
    }
    const winner = this.winner(key);
    if (!winner) throw new WorkspaceError(`${key} not found`);
    if (REFERENCE_SIGNATURES.has(winner.record.sig)) {
      return this.transaction(`Disable ${key}`, () => {
        const rec = this.ensureInActive(key);
        rec.setFlag(RecordFlags.InitiallyDisabled, true);
        const subs = rec.subrecords.filter((s) => s.sig !== 'XESP');
        const xesp = new Uint8Array(8);
        new DataView(xesp.buffer).setUint32(0, 0x14, true);
        xesp[4] = 1;
        const dataIdx = subs.findIndex((s) => s.sig === 'DATA');
        subs.splice(dataIdx < 0 ? subs.length : dataIdx, 0, { sig: 'XESP', data: xesp });
        if (!rec.isPersistent && dataIdx >= 0) {
          const d = subs.find((s) => s.sig === 'DATA')!;
          const copy = d.data.slice();
          new DataView(copy.buffer).setFloat32(8, -30000, true);
          d.data = copy;
        }
        rec.subrecords = subs;
        return 'disabled' as const;
      });
    }
    if (inActive) {
      return this.transaction(`Revert ${key}`, () => {
        a.plugin.removeRecord(local!);
        return 'reverted' as const;
      });
    }
    throw new WorkspaceError(`Deleting ${recordTypeName(winner.record.sig)} records from masters breaks anything that uses them. Remove references to it instead, or edit it.`);
  }

  /** Keep a topic's response order intact when a response is removed (PNAM chain). */
  private unlinkInfo(key: FormKey): void {
    const v = this.view(key);
    const prev = (v?.data as { previousInfo?: FormKey | null } | undefined)?.previousInfo ?? null;
    const a = this.requireActive();
    for (const r of [...a.plugin.recordsOfType('INFO')]) {
      const k = this.keyOf(a, r.formId);
      if (!k || k === key) continue;
      const d = this.view(k)?.data as { previousInfo?: FormKey | null } | undefined;
      if (d?.previousInfo === key) this.editRecord(k, (x) => ({ ...x, previousInfo: prev }), 'Relink response order');
    }
  }

  /** Revert an override (drop the active plugin's version). */
  revertRecord(key: FormKey): void {
    const a = this.requireActive();
    const local = a.mapper.toLocal(key);
    if (local === undefined || !a.plugin.getRecord(local)) return;
    if (parseFormKey(key).plugin.toLowerCase() === a.name.toLowerCase()) throw new WorkspaceError('Cannot revert a record that is new in this plugin');
    this.transaction(`Revert ${key}`, () => {
      a.plugin.removeRecord(local);
    });
  }

  /** Find records in the active plugin (or all loaded) that reference `key`. */
  findReferences(key: FormKey, opts: { allPlugins?: boolean; limit?: number } = {}): RecordSummary[] {
    const out: RecordSummary[] = [];
    const limit = opts.limit ?? 200;
    const slots = opts.allPlugins ? this.loaded() : this.active ? [this.active] : [];
    for (const s of slots) {
      if (!s.plugin || !s.mapper) continue;
      const local = s.mapper.toLocal(key);
      if (local === undefined) continue;
      for (const r of s.plugin.records()) {
        if (r.formId === local) continue;
        const hit = r.containsU32(local);
        if (hit) {
          const k = this.keyOf(s, r.formId)!;
          out.push({ formKey: k, sig: r.sig, editorId: r.editorId, owner: parseFormKey(k).plugin, winner: s.name, inActive: s.name === this.activeName, deleted: r.isDeleted });
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- saving

  masterSource(): MapMasterSource {
    return new MapMasterSource(this.loaded().filter((s) => s.name !== this.activeName).map((s) => s.plugin!));
  }

  /** Bytes of the active plugin as it would be saved (after automations). */
  async save(opts: SaveOptions = {}): Promise<SaveResult> {
    await this.io;
    const a = this.requireActive();
    const warnings: string[] = [];
    const extraFiles: string[] = [];
    let clean: CleanReport | undefined;
    // Run pre-save automations inside a transaction so they can be undone.
    this.transaction('Save automations', () => {
      if (opts.removeItms ?? true) {
        clean = cleanPlugin(a.plugin, this.masterSource(), { undeleteReferences: false, ...opts.clean, removeItms: true });
        warnings.push(...clean.errors);
      }
      for (const hook of this.preSaveHooks) warnings.push(...hook(this));
      a.plugin.updateHeaderBookkeeping();
    });
    if (a.plugin.isESL) {
      const own = [...a.plugin.records()].filter((r) => r.formId >>> 24 === a.plugin.masters.length);
      if (own.length > 2048) warnings.push(`ESL-flagged plugin defines ${own.length} new records (max 2048)`);
      if (own.some((r) => (r.formId & 0xffffff) > 0xfff)) warnings.push('ESL-flagged plugin has FormIDs outside 0x800-0xFFF; it will not load correctly');
    }
    const bytes = a.plugin.serialize();
    const path = joinPath(this.options.outputDir, a.name);
    await this.fs.mkdir(this.options.outputDir);
    await this.backup(path);
    await this.fs.writeFile(path, bytes);
    a.path = path;
    if (a.plugin.isLocalized && a.strings) {
      const names = stringsFileNames(a.name, this.language);
      for (const kind of ['STRINGS', 'DLSTRINGS', 'ILSTRINGS'] as const) {
        const t = a.strings[kind] ?? new StringTable(kind);
        const p = joinPath(this.options.outputDir, names[kind]);
        await this.fs.mkdir(joinPath(this.options.outputDir, 'Strings'));
        await this.fs.writeFile(p, t.serialize());
        extraFiles.push(p);
      }
    }
    for (const hook of this.postSaveHooks) extraFiles.push(...(await hook(this)));
    this.dirty = false;
    this.emit({ type: 'saved', path });
    return { path, bytes: bytes.byteLength, clean, warnings, extraFiles };
  }

  /** Automations registered by feature modules (SEQ files, topic upkeep...). */
  readonly preSaveHooks: ((ws: Workspace) => string[])[] = [];
  readonly postSaveHooks: ((ws: Workspace) => Promise<string[]>)[] = [];

  private async backup(path: string): Promise<void> {
    if (!(await this.fs.exists(path))) return;
    const keep = this.options.backups ?? 5;
    if (keep <= 0) return;
    const dir = joinPath(this.options.outputDir, 'tes5-backups');
    await this.fs.mkdir(dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await this.fs.writeFile(joinPath(dir, `${basename(path)}.${stamp}.bak`), await this.fs.readFile(path));
    const mine = (await this.fs.readdir(dir)).filter((e) => e.name.startsWith(`${basename(path)}.`)).map((e) => e.name).sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - keep))) await this.fs.remove(joinPath(dir, old));
  }

  /** Clean any loaded plugin (dry run by default). */
  clean(name: string, opts: CleanOptions = { dryRun: true }): CleanReport {
    const s = this.slot(name);
    if (!s?.plugin) throw new WorkspaceError(`${name} is not loaded`);
    const masters = new MapMasterSource(this.loaded().filter((x) => x.name !== s.name).map((x) => x.plugin!));
    if (!opts.dryRun && s.name === this.activeName) return this.transaction('Clean plugin', () => cleanPlugin(s.plugin!, masters, opts));
    if (!opts.dryRun) this.baseIndex = null;
    return cleanPlugin(s.plugin, masters, opts);
  }

  describeKey(key: FormKey | null | undefined): string {
    if (!key) return 'NULL';
    const s = this.summary(key);
    return s ? `${s.editorId ?? s.name ?? ''} [${s.sig}:${key}]` : `[${key}]`;
  }

  /** FormID as the game would show it with the current load order. */
  runtimeFormId(key: FormKey): string {
    const { objectId, plugin } = parseFormKey(key);
    let full = 0;
    let light = 0;
    for (const s of this.slots) {
      if (!s.active) continue;
      if (s.name.toLowerCase() === plugin.toLowerCase()) {
        return s.isLight ? hex(((0xfe << 24) | (light << 12) | (objectId & 0xfff)) >>> 0) : hex(((full << 24) | objectId) >>> 0);
      }
      if (s.isLight) light++;
      else full++;
    }
    return hex(objectId);
  }
}

export type WorkspaceEvent =
  | { type: 'loadOrder' }
  | { type: 'loaded' }
  | { type: 'activeChanged' }
  | { type: 'changed'; label: string }
  | { type: 'saved'; path: string }
  | { type: 'warning'; message: string }
  | { type: 'filesRestored'; files: { path: string; data: Uint8Array | null }[] };

export interface FileChange {
  path: string;
  /** Content before the edit (null = the file didn't exist). */
  before: Uint8Array | null;
  after: Uint8Array | null;
}

interface UndoEntry {
  label: string;
  bytes: Uint8Array;
  files?: FileChange[];
}

function* walkGroups(plugin: Plugin) {
  const stack = [...plugin.groups];
  while (stack.length) {
    const g = stack.pop()!;
    yield g;
    for (const c of g.children) if (c.kind === 'group') stack.push(c);
  }
}
