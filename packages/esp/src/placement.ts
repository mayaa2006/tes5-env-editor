/**
 * Placing records into the right GRUP. Cells live in block/sub-block groups,
 * references in their cell's persistent/temporary children, dialogue
 * responses in their topic's children. Getting this right by hand is one of
 * the classic Creation Kit-only chores; here it is automatic.
 */
import { BinaryReader } from './binary';
import { GroupType, REFERENCE_SIGNATURES, RecordFlags } from './constants';
import { PluginGroup, exteriorBlock, gridToLabel, interiorBlock } from './group';
import type { Plugin } from './plugin';
import type { PluginRecord } from './record';

export class MissingParentError extends Error {
  constructor(
    readonly parentSig: string,
    readonly parentFormId: number,
    message: string,
  ) {
    super(message);
  }
}

export interface PlaceOptions {
  /** References, navmeshes, landscape: parent cell (file-local FormID). */
  cell?: number;
  /** References: put in the persistent children group. Defaults to the record's Persistent flag. */
  persistent?: boolean;
  /** INFO: parent topic (file-local FormID). */
  topic?: number;
  /** CELL: worldspace for exterior cells (file-local FormID). */
  worldspace?: number;
  /** CELL: exterior grid; read from XCLC when omitted. */
  grid?: { x: number; y: number };
  /** CELL: this is the worldspace's persistent cell (no grid, no blocks). */
  persistentWorldCell?: boolean;
}

function findGroup(list: PluginGroup['children'], type: GroupType, label: number): PluginGroup | undefined {
  for (const c of list) if (c.kind === 'group' && c.type === type && c.label === label >>> 0) return c;
  return undefined;
}

function ensureGroup(list: PluginGroup['children'], type: GroupType, label: number, insertAt?: number): PluginGroup {
  const g = findGroup(list, type, label);
  if (g) return g;
  const n = new PluginGroup(type, label);
  if (insertAt === undefined) list.push(n);
  else list.splice(insertAt, 0, n);
  return n;
}

/** Find (or create) the child group that must directly follow `owner` in `list`. */
function ensureChildGroup(list: PluginGroup['children'], owner: PluginRecord, type: GroupType): PluginGroup {
  const i = list.indexOf(owner);
  if (i < 0) throw new Error(`${owner.toString()} is not in the expected group`);
  const next = list[i + 1];
  if (next && next.kind === 'group' && next.type === type && next.label === owner.formId) return next;
  const g = new PluginGroup(type, owner.formId);
  list.splice(i + 1, 0, g);
  return g;
}

function upsert(list: PluginGroup['children'], rec: PluginRecord): void {
  const i = list.findIndex((c) => c.kind === 'record' && c.formId === rec.formId);
  if (i >= 0) list[i] = rec;
  else list.push(rec);
}

export function readCellGrid(cell: PluginRecord): { x: number; y: number } | undefined {
  const s = cell.get('XCLC');
  if (!s || s.data.byteLength < 8) return undefined;
  const r = new BinaryReader(s.data);
  return { x: r.i32(), y: r.i32() };
}

export function isInteriorCell(cell: PluginRecord): boolean {
  const s = cell.get('DATA');
  return !!s && s.data.byteLength >= 1 && (s.data[0]! & 1) === 1;
}

/** Insert or replace `rec` in the correct location. */
export function placeRecord(plugin: Plugin, rec: PluginRecord, opts: PlaceOptions = {}): void {
  plugin.invalidateIndex();
  try {
    if (rec.sig === 'CELL') return placeCell(plugin, rec, opts);
    if (rec.sig === 'INFO') return placeInfo(plugin, rec, opts);
    if (REFERENCE_SIGNATURES.has(rec.sig) || rec.sig === 'NAVM' || rec.sig === 'LAND') return placeCellChild(plugin, rec, opts);
    if (rec.sig === 'WRLD' || rec.sig === 'DIAL') {
      const top = plugin.ensureTopGroup(rec.sig);
      upsert(top.children, rec);
      return;
    }
    upsert(plugin.ensureTopGroup(rec.sig).children, rec);
  } finally {
    plugin.invalidateIndex();
  }
}

function placeCell(plugin: Plugin, rec: PluginRecord, opts: PlaceOptions): void {
  const exterior = opts.worldspace !== undefined || (!isInteriorCell(rec) && !!readCellGrid(rec));
  if (!exterior) {
    const { block, subBlock } = interiorBlock(rec.formId);
    const top = plugin.ensureTopGroup('CELL');
    const b = ensureGroup(top.children, GroupType.InteriorCellBlock, block);
    const sb = ensureGroup(b.children, GroupType.InteriorCellSubBlock, subBlock);
    upsert(sb.children, rec);
    return;
  }
  if (opts.worldspace === undefined) throw new Error(`Exterior cell ${rec.toString()} needs a worldspace`);
  const wrld = plugin.getRecord(opts.worldspace);
  if (!wrld || wrld.sig !== 'WRLD') {
    throw new MissingParentError('WRLD', opts.worldspace, `Worldspace ${opts.worldspace.toString(16)} must be in the plugin before adding cells to it`);
  }
  const top = plugin.ensureTopGroup('WRLD');
  const children = ensureChildGroup(top.children, wrld, GroupType.WorldChildren);
  if (opts.persistentWorldCell) {
    // The persistent cell sits first, before any block.
    const existing = children.children.findIndex((c) => c.kind === 'record' && c.formId === rec.formId);
    if (existing >= 0) children.children[existing] = rec;
    else children.children.unshift(rec);
    rec.setFlag(RecordFlags.Persistent, true);
    return;
  }
  const grid = opts.grid ?? readCellGrid(rec);
  if (!grid) throw new Error(`Exterior cell ${rec.toString()} has no grid (XCLC)`);
  const { block, subBlock } = exteriorBlock(grid.x, grid.y);
  const b = ensureGroup(children.children, GroupType.ExteriorCellBlock, gridToLabel(block.x, block.y));
  const sb = ensureGroup(b.children, GroupType.ExteriorCellSubBlock, gridToLabel(subBlock.x, subBlock.y));
  upsert(sb.children, rec);
}

function locate(plugin: Plugin, formId: number): { record: PluginRecord; list: PluginGroup['children'] } | undefined {
  const loc = plugin.index.get(formId >>> 0);
  if (!loc) return undefined;
  const parent = loc.path[loc.path.length - 1];
  if (!parent) return undefined;
  return { record: loc.record, list: parent.children };
}

function placeInfo(plugin: Plugin, rec: PluginRecord, opts: PlaceOptions): void {
  if (opts.topic === undefined) throw new Error(`INFO ${rec.toString()} needs its parent topic`);
  const dial = locate(plugin, opts.topic);
  if (!dial || dial.record.sig !== 'DIAL') {
    throw new MissingParentError('DIAL', opts.topic, `Topic ${opts.topic.toString(16)} must be in the plugin before adding responses to it`);
  }
  const g = ensureChildGroup(dial.list, dial.record, GroupType.TopicChildren);
  upsert(g.children, rec);
}

function placeCellChild(plugin: Plugin, rec: PluginRecord, opts: PlaceOptions): void {
  if (opts.cell === undefined) throw new Error(`${rec.toString()} needs its parent cell`);
  const cell = locate(plugin, opts.cell);
  if (!cell || cell.record.sig !== 'CELL') {
    throw new MissingParentError('CELL', opts.cell, `Cell ${opts.cell.toString(16)} must be in the plugin before adding to it`);
  }
  const children = ensureChildGroup(cell.list, cell.record, GroupType.CellChildren);
  const persistent = REFERENCE_SIGNATURES.has(rec.sig) && (opts.persistent ?? rec.isPersistent);
  const type = persistent ? GroupType.CellPersistentChildren : GroupType.CellTemporaryChildren;
  let g = findGroup(children.children, type, cell.record.formId);
  if (!g) {
    g = new PluginGroup(type, cell.record.formId);
    if (type === GroupType.CellPersistentChildren) children.children.unshift(g);
    else children.children.push(g);
  }
  // Remove it from the other group if persistence changed.
  const other = findGroup(children.children, persistent ? GroupType.CellTemporaryChildren : GroupType.CellPersistentChildren, cell.record.formId);
  if (other) {
    const i = other.children.findIndex((c) => c.kind === 'record' && c.formId === rec.formId);
    if (i >= 0) other.children.splice(i, 1);
  }
  upsert(g.children, rec);
}

/** Parent cell / topic / worldspace of a record, derived from its group path. */
export function parentOf(plugin: Plugin, formId: number): { cell?: number; topic?: number; worldspace?: number; persistent?: boolean } {
  const loc = plugin.index.get(formId >>> 0);
  if (!loc) return {};
  const out: { cell?: number; topic?: number; worldspace?: number; persistent?: boolean } = {};
  for (const g of loc.path) {
    if (g.type === GroupType.CellChildren) out.cell = g.label;
    if (g.type === GroupType.TopicChildren) out.topic = g.label;
    if (g.type === GroupType.WorldChildren) out.worldspace = g.label;
    if (g.type === GroupType.CellPersistentChildren) out.persistent = true;
    if (g.type === GroupType.CellTemporaryChildren) out.persistent = false;
  }
  return out;
}

/** Remove groups that became empty (recursively). Returns the number removed. */
export function pruneEmptyGroups(plugin: Plugin): number {
  let removed = 0;
  const visit = (list: PluginGroup['children']): void => {
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i]!;
      if (c.kind !== 'group') continue;
      visit(c.children);
      if (c.children.length === 0) {
        list.splice(i, 1);
        removed++;
      }
    }
  };
  visit(plugin.groups);
  if (removed) plugin.invalidateIndex();
  return removed;
}
