import { BinaryReader, BinaryWriter, hex } from './binary';
import { GroupType, HEDR_VERSION, ONAM_SIGNATURES, RecordFlags, TOP_GROUP_ORDER, type GameRelease, FORM_VERSION } from './constants';
import { GROUP_HEADER_SIZE, PluginGroup, labelToSig, sigToLabel, type PluginNode } from './group';
import { PluginRecord, RECORD_HEADER_SIZE, RecordParseError, readZString, zstringBytes, type Subrecord } from './record';

export interface PluginHeaderInfo {
  version: number;
  numRecords: number;
  nextObjectId: number;
}

export interface NodeLocation {
  record: PluginRecord;
  /** Chain of groups from the top-level group down to the record's direct parent. */
  path: PluginGroup[];
}

export interface ParseOptions {
  /** Called for records that fail structural checks; parsing continues when it returns. */
  onWarning?: (message: string) => void;
}

/**
 * An in-memory plugin (ESM/ESP/ESL). Holds the TES4 header record and the
 * top-level groups. FormIDs inside the plugin are file-local: the upper byte
 * indexes into `masters`, and index === masters.length means "this file".
 */
export class Plugin {
  fileName: string;
  header: PluginRecord;
  groups: PluginGroup[];
  private indexCache: Map<number, NodeLocation> | null = null;

  constructor(fileName: string, header: PluginRecord, groups: PluginGroup[] = []) {
    this.fileName = fileName;
    this.header = header;
    this.groups = groups;
  }

  /** Create an empty plugin with sensible defaults for the given game. */
  static create(fileName: string, opts: { game?: GameRelease; masters?: string[]; author?: string; description?: string } = {}): Plugin {
    const game = opts.game ?? 'SkyrimSE';
    const w = new BinaryWriter(12);
    w.f32(HEDR_VERSION[game]).i32(0).u32(0x800);
    const subs: Subrecord[] = [{ sig: 'HEDR', data: w.toBytes() }];
    subs.push({ sig: 'CNAM', data: zstringBytes(opts.author ?? 'DEFAULT') });
    if (opts.description) subs.push({ sig: 'SNAM', data: zstringBytes(opts.description) });
    for (const m of opts.masters ?? []) {
      subs.push({ sig: 'MAST', data: zstringBytes(m) }, { sig: 'DATA', data: new Uint8Array(8) });
    }
    subs.push({ sig: 'INTV', data: new Uint8Array([1, 0, 0, 0]) });
    subs.push({ sig: 'INCC', data: new Uint8Array(4) });
    const header = PluginRecord.create('TES4', 0, subs, 0, FORM_VERSION[game]);
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.esm')) header.setFlag(RecordFlags.ESM, true);
    if (lower.endsWith('.esl')) {
      header.setFlag(RecordFlags.ESM, true);
      header.setFlag(RecordFlags.ESL, true);
    }
    return new Plugin(fileName, header, []);
  }

  // ---------------------------------------------------------------- header

  get hedr(): PluginHeaderInfo {
    const s = this.header.get('HEDR');
    if (!s || s.data.byteLength < 12) return { version: 1.7, numRecords: 0, nextObjectId: 0x800 };
    const r = new BinaryReader(s.data);
    return { version: Math.round(r.f32() * 100) / 100, numRecords: r.i32(), nextObjectId: r.u32() };
  }

  set hedr(v: PluginHeaderInfo) {
    const w = new BinaryWriter(12);
    w.f32(v.version).i32(v.numRecords).u32(v.nextObjectId);
    this.header.set('HEDR', w.toBytes(), { insertBefore: ['*'] });
  }

  get masters(): string[] {
    return this.header.getAll('MAST').map((s) => readZString(s.data));
  }

  /**
   * Replace the master list. This does NOT remap FormIDs; use
   * `remapMasters` in the workspace package when the order changes.
   */
  setMasters(masters: readonly string[]): void {
    const subs = this.header.subrecords;
    const kept = subs.filter((s) => s.sig !== 'MAST' && s.sig !== 'DATA');
    const masterSubs: Subrecord[] = [];
    for (const m of masters) masterSubs.push({ sig: 'MAST', data: zstringBytes(m) }, { sig: 'DATA', data: new Uint8Array(8) });
    // Masters go after HEDR/OFST/DELE/CNAM/SNAM.
    let at = 0;
    for (let i = 0; i < kept.length; i++) if (['HEDR', 'OFST', 'DELE', 'CNAM', 'SNAM'].includes(kept[i]!.sig)) at = i + 1;
    kept.splice(at, 0, ...masterSubs);
    this.header.subrecords = kept;
  }

  get author(): string {
    const s = this.header.get('CNAM');
    return s ? readZString(s.data) : '';
  }
  set author(v: string) {
    this.header.set('CNAM', zstringBytes(v), { insertAfter: ['HEDR', 'OFST', 'DELE'] });
  }

  get description(): string {
    const s = this.header.get('SNAM');
    return s ? readZString(s.data) : '';
  }
  set description(v: string) {
    if (!v) this.header.remove('SNAM');
    else this.header.set('SNAM', zstringBytes(v), { insertAfter: ['HEDR', 'OFST', 'DELE', 'CNAM'] });
  }

  get isESM(): boolean {
    return (this.header.flags & RecordFlags.ESM) !== 0;
  }
  set isESM(v: boolean) {
    this.header.setFlag(RecordFlags.ESM, v);
  }
  get isESL(): boolean {
    return (this.header.flags & RecordFlags.ESL) !== 0 || this.fileName.toLowerCase().endsWith('.esl');
  }
  set isESL(v: boolean) {
    this.header.setFlag(RecordFlags.ESL, v);
  }
  get isLocalized(): boolean {
    return (this.header.flags & RecordFlags.Localized) !== 0;
  }
  set isLocalized(v: boolean) {
    this.header.setFlag(RecordFlags.Localized, v);
  }
  /** Master-like load behaviour: ESM flag, .esm/.esl extension, or ESL flag. */
  get loadsAsMaster(): boolean {
    const lower = this.fileName.toLowerCase();
    return this.isESM || this.isESL || lower.endsWith('.esm') || lower.endsWith('.esl');
  }

  /** Index used in file-local FormIDs for records new to this plugin. */
  get selfIndex(): number {
    return this.masters.length;
  }

  // ---------------------------------------------------------------- traversal

  /** Depth-first iteration over every record (excluding the TES4 header). */
  *records(): Generator<PluginRecord> {
    const stack: PluginNode[][] = [this.groups];
    const idx: number[] = [0];
    while (stack.length) {
      const level = stack[stack.length - 1]!;
      const i = idx[idx.length - 1]!;
      if (i >= level.length) {
        stack.pop();
        idx.pop();
        continue;
      }
      idx[idx.length - 1] = i + 1;
      const n = level[i]!;
      if (n.kind === 'record') yield n;
      else {
        stack.push(n.children);
        idx.push(0);
      }
    }
  }

  /** Depth-first iteration with the group path for each record. */
  *walk(): Generator<NodeLocation> {
    function* rec(nodes: PluginNode[], path: PluginGroup[]): Generator<NodeLocation> {
      for (const n of nodes) {
        if (n.kind === 'record') yield { record: n, path };
        else yield* rec(n.children, [...path, n]);
      }
    }
    yield* rec(this.groups, []);
  }

  /** Count of records and groups (what HEDR "Number of Records" stores). */
  countRecordsAndGroups(): number {
    let n = 0;
    const visit = (nodes: PluginNode[]) => {
      for (const c of nodes) {
        n++;
        if (c.kind === 'group') visit(c.children);
      }
    };
    visit(this.groups);
    return n;
  }

  topGroup(sig: string): PluginGroup | undefined {
    const label = sigToLabel(sig);
    return this.groups.find((g) => g.type === GroupType.Top && g.label === label);
  }

  /** Find or create a top-level group, keeping canonical group order. */
  ensureTopGroup(sig: string): PluginGroup {
    const existing = this.topGroup(sig);
    if (existing) return existing;
    const g = PluginGroup.top(sig);
    const order = topGroupOrder(sig);
    let at = this.groups.length;
    for (let i = 0; i < this.groups.length; i++) {
      if (topGroupOrder(this.groups[i]!.labelSig) > order) {
        at = i;
        break;
      }
    }
    this.groups.splice(at, 0, g);
    return g;
  }

  /** FormID → record location. Rebuilt after structural changes via `invalidateIndex()`. */
  get index(): Map<number, NodeLocation> {
    if (!this.indexCache) {
      const m = new Map<number, NodeLocation>();
      for (const loc of this.walk()) m.set(loc.record.formId, loc);
      this.indexCache = m;
    }
    return this.indexCache;
  }

  invalidateIndex(): void {
    this.indexCache = null;
  }

  getRecord(formId: number): PluginRecord | undefined {
    return this.index.get(formId >>> 0)?.record;
  }

  /** Records whose signature matches (searches the whole file, including cell children). */
  *recordsOfType(sig: string): Generator<PluginRecord> {
    const top = this.topGroup(sig);
    if (top && !['CELL', 'WRLD', 'DIAL'].includes(sig)) {
      for (const r of top.records) yield r;
      return;
    }
    if (sig === 'CELL') {
      for (const c of this.cellLocations()) yield c.record;
      return;
    }
    if (sig === 'WRLD' || sig === 'DIAL') {
      // These sit directly in their top group; their children are in child groups.
      if (top) for (const r of top.records) yield r;
      return;
    }
    for (const r of this.records()) if (r.sig === sig) yield r;
  }

  /**
   * Every CELL record with its worldspace (file-local FormID, exterior cells
   * only), without walking the references inside cells.
   */
  *cellLocations(): Generator<{ record: PluginRecord; worldspace?: number }> {
    function* visit(nodes: PluginNode[], worldspace?: number): Generator<{ record: PluginRecord; worldspace?: number }> {
      for (const n of nodes) {
        if (n.kind === 'record') {
          if (n.sig === 'CELL') yield { record: n, worldspace };
          continue;
        }
        if (n.type === GroupType.CellChildren || n.type === GroupType.CellPersistentChildren || n.type === GroupType.CellTemporaryChildren || n.type === GroupType.CellVisibleDistantChildren || n.type === GroupType.TopicChildren) continue;
        yield* visit(n.children, n.type === GroupType.WorldChildren ? n.label : worldspace);
      }
    }
    const cell = this.topGroup('CELL');
    if (cell) yield* visit(cell.children);
    const wrld = this.topGroup('WRLD');
    if (wrld) yield* visit(wrld.children);
  }

  /** Remove a record (and its child group, for CELL/WRLD/DIAL). Returns true if found. */
  removeRecord(formId: number): boolean {
    const loc = this.index.get(formId >>> 0);
    if (!loc) return false;
    const parent = loc.path[loc.path.length - 1];
    const list = parent ? parent.children : null;
    if (!list) return false;
    const i = list.indexOf(loc.record);
    if (i < 0) return false;
    list.splice(i, 1);
    // A child group belonging to the record immediately follows it.
    const next = list[i];
    if (next && next.kind === 'group' && next.label === loc.record.formId && isChildGroupType(next.type)) {
      list.splice(i, 1);
    }
    this.invalidateIndex();
    return true;
  }

  /** Find the child group (cell/world/topic children) that belongs to a record. */
  childGroupOf(record: PluginRecord): PluginGroup | undefined {
    const loc = this.index.get(record.formId);
    if (!loc) return undefined;
    const parent = loc.path[loc.path.length - 1];
    if (!parent) return undefined;
    const i = parent.children.indexOf(record);
    const next = parent.children[i + 1];
    if (next && next.kind === 'group' && next.label === record.formId && isChildGroupType(next.type)) return next;
    return undefined;
  }

  // ---------------------------------------------------------------- formids

  /** Highest object ID used by records new to this plugin. */
  maxOwnObjectId(): number {
    const self = this.selfIndex;
    let max = 0;
    for (const r of this.records()) {
      if (r.formId >>> 24 === self) max = Math.max(max, r.formId & 0xffffff);
    }
    return max;
  }

  /**
   * Allocate a new file-local FormID for a record defined by this plugin.
   * Honors the HEDR next-object-id counter and the ESL range when flagged light.
   */
  allocateFormId(): number {
    const h = this.hedr;
    let next = Math.max(h.nextObjectId, this.maxOwnObjectId() + 1, 0x800);
    if (this.isESL && next > 0xfff) {
      // Look for a hole in the compact range before giving up.
      const used = new Set<number>();
      for (const r of this.records()) if (r.formId >>> 24 === this.selfIndex) used.add(r.formId & 0xffffff);
      next = -1;
      for (let id = 0x800; id <= 0xfff; id++) {
        if (!used.has(id)) {
          next = id;
          break;
        }
      }
      if (next < 0) throw new Error(`${this.fileName}: ESL-flagged plugin is out of FormIDs (max 2048 new records)`);
    }
    this.hedr = { ...h, nextObjectId: next + 1 };
    return ((this.selfIndex << 24) | next) >>> 0;
  }

  // ---------------------------------------------------------------- serialize

  /**
   * Update header bookkeeping that the game and other tools rely on:
   * record count, interior cell count and (for masters) the ONAM override list.
   */
  updateHeaderBookkeeping(opts: { writeOnam?: boolean } = {}): void {
    const h = this.hedr;
    const numRecords = this.countRecordsAndGroups();
    if (h.numRecords !== numRecords) this.hedr = { ...h, numRecords };

    let interiorCells = 0;
    for (const r of this.recordsOfType('CELL')) {
      const d = r.get('DATA');
      if (d && d.data.byteLength >= 1 && (d.data[0]! & 1) === 1) interiorCells++;
    }
    const incc = this.header.get('INCC');
    const cur = incc && incc.data.byteLength >= 4 ? new DataView(incc.data.buffer, incc.data.byteOffset).getUint32(0, true) : -1;
    if (cur !== interiorCells) {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, interiorCells, true);
      this.header.set('INCC', b);
    }

    const writeOnam = opts.writeOnam ?? this.loadsAsMaster;
    if (writeOnam) {
      const self = this.selfIndex;
      const ids: number[] = [];
      for (const r of this.records()) {
        if (r.formId >>> 24 < self && ONAM_SIGNATURES.has(r.sig)) ids.push(r.formId);
      }
      ids.sort((a, b) => a - b);
      const existing = this.header.get('ONAM');
      const bytes = new Uint8Array(ids.length * 4);
      const dv = new DataView(bytes.buffer);
      ids.forEach((id, i) => dv.setUint32(i * 4, id, true));
      const same = existing && existing.data.byteLength === bytes.byteLength && existing.data.every((b, i) => b === bytes[i]);
      if (!same) {
        if (ids.length === 0) this.header.remove('ONAM');
        else this.header.set('ONAM', bytes, { insertAfter: ['HEDR', 'OFST', 'DELE', 'CNAM', 'SNAM', 'MAST', 'DATA'] });
      }
    }
  }

  serialize(): Uint8Array {
    const w = new BinaryWriter(1 << 16);
    this.header.writeTo(w);
    for (const g of this.groups) g.writeTo(w);
    return w.toBytes();
  }

  describe(): string {
    return `${this.fileName}${this.isESM ? ' [ESM]' : ''}${this.isESL ? ' [ESL]' : ''}${this.isLocalized ? ' [Localized]' : ''}`;
  }
}

export function isChildGroupType(t: GroupType): boolean {
  return t === GroupType.WorldChildren || t === GroupType.CellChildren || t === GroupType.TopicChildren;
}

export function topGroupOrder(sig: string): number {
  const i = TOP_GROUP_ORDER.indexOf(sig);
  return i < 0 ? TOP_GROUP_ORDER.length : i;
}

// ------------------------------------------------------------------ parsing

export function parsePlugin(bytes: Uint8Array, fileName = 'plugin.esp', opts: ParseOptions = {}): Plugin {
  const r = new BinaryReader(bytes);
  if (r.length < RECORD_HEADER_SIZE) throw new Error(`${fileName}: file too small to be a plugin`);
  const first = readRecord(r);
  if (first.sig !== 'TES4') throw new Error(`${fileName}: expected TES4 header, found "${first.sig}"`);
  const groups: PluginGroup[] = [];
  while (!r.eof) {
    const start = r.pos;
    const sig = new BinaryReader(bytes, start).sig();
    if (sig !== 'GRUP') {
      const msg = `${fileName}: unexpected top-level record "${sig}" at offset ${start}`;
      if (opts.onWarning) {
        opts.onWarning(msg);
        readRecord(r); // skip it
        continue;
      }
      throw new Error(msg);
    }
    groups.push(readGroup(r, fileName, opts));
  }
  return new Plugin(fileName, first, groups);
}

function readRecord(r: BinaryReader): PluginRecord {
  const offset = r.pos;
  const sig = r.sig();
  const size = r.u32();
  const flags = r.u32();
  const formId = r.u32();
  const vc1 = r.u32();
  const formVersion = r.u16();
  const vc2 = r.u16();
  if (size > r.remaining) {
    throw new RecordParseError(`${sig} [${hex(formId)}] at offset ${offset}: data size ${size} exceeds file`);
  }
  const data = r.bytesView(size);
  const rec = new PluginRecord({ sig, formId, flags, vc1, formVersion, vc2 }, data);
  rec.offset = offset;
  return rec;
}

function readGroup(r: BinaryReader, fileName: string, opts: ParseOptions): PluginGroup {
  const offset = r.pos;
  r.sig(); // GRUP
  const size = r.u32();
  const label = r.u32();
  const type = r.i32() as GroupType;
  const stamp = r.u32();
  const unknown = r.u32();
  const end = offset + size;
  if (size < GROUP_HEADER_SIZE || end > r.length) {
    throw new Error(`${fileName}: GRUP at offset ${offset} has invalid size ${size}`);
  }
  const g = new PluginGroup(type, label, [], stamp, unknown);
  g.offset = offset;
  while (r.pos < end) {
    const sig = new BinaryReader(r.bytes, r.pos).sig();
    if (sig === 'GRUP') g.children.push(readGroup(r, fileName, opts));
    else g.children.push(readRecord(r));
  }
  if (r.pos !== end) throw new Error(`${fileName}: GRUP at offset ${offset} overran its size`);
  if (type === GroupType.Top && opts.onWarning) {
    const sig = labelToSig(label);
    for (const c of g.children) {
      if (c.kind === 'record' && c.sig !== sig) opts.onWarning(`${fileName}: ${c.toString()} found in top group "${sig}"`);
    }
  }
  return g;
}

/** Read just the TES4 header (fast; used for load-order scans). */
export function readPluginHeader(bytes: Uint8Array, fileName = 'plugin.esp'): Plugin {
  const r = new BinaryReader(bytes);
  const first = readRecord(r);
  if (first.sig !== 'TES4') throw new Error(`${fileName}: expected TES4 header, found "${first.sig}"`);
  return new Plugin(fileName, first, []);
}
