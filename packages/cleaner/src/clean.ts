/**
 * Plugin cleaning, compatible with xEdit's "Quick Auto Clean":
 *   1. Undelete and disable deleted references (UDRs)
 *   2. Remove identical-to-master records (ITMs), bottom-up, then empty groups
 * Deleted navmeshes are reported (they cannot be undeleted safely).
 *
 * Differences from xEdit, all on the safe side:
 *  - Default "safe" ITM mode compares an override with the version that would
 *    win if it were removed (the last master that has the form). xEdit compares
 *    with the original master, which also flags intentional reverts of DLC or
 *    patch changes. Those are reported as "reverts" and kept.
 *  - When master lists differ in layout, records are compared through typed
 *    schemas with FormIDs resolved; if that is not possible the record is kept.
 */
import {
  BinaryReader,
  BinaryWriter,
  FormIdMapper,
  GroupType,
  NavTriFlags,
  PLAYER_REF,
  RecordFlags,
  REFERENCE_SIGNATURES,
  applyTyped,
  decodeRecord,
  hex,
  isChildGroupType,
  type Navmesh,
  type Plugin,
  type PluginGroup,
  type PluginNode,
  type PluginRecord,
  type Subrecord,
} from '@tes5/esp';
import { compareRecords, compatibleMasterIndices } from './compare';
import { missingMasters, versionsInMasters, type MasterSource } from './masters';

export type ItmMode = 'safe' | 'xedit';

export interface CleanOptions {
  /** See module docs. Default 'safe'. */
  itmMode?: ItmMode;
  removeItms?: boolean;
  undeleteReferences?: boolean;
  /**
   * Experimental: restore deleted navmeshes from their master and sink every
   * vertex to `disabledZ`, keeping triangle/edge-link data intact. Off by default.
   */
  fixDeletedNavmeshes?: boolean;
  /** Z height for disabled references and fixed navmeshes (xEdit default: -30000). */
  disabledZ?: number;
  /** Add an XESP pointing at the player with "opposite of parent" (xEdit default: true). */
  setEnableParent?: boolean;
  /** Only report; do not change the plugin. */
  dryRun?: boolean;
}

export interface CleanEntry {
  formId: string;
  sig: string;
  editorId?: string;
  detail?: string;
}

export interface CleanReport {
  plugin: string;
  mode: ItmMode;
  dryRun: boolean;
  itmsRemoved: CleanEntry[];
  /** ITMs that could not be removed because the record still has child records. */
  itmsKept: CleanEntry[];
  /** Overrides identical to the original master but not to the previous override (intentional reverts). */
  reverts: CleanEntry[];
  undeleted: CleanEntry[];
  deletedNavmeshes: CleanEntry[];
  navmeshesFixed: CleanEntry[];
  skipped: CleanEntry[];
  emptyGroupsRemoved: number;
  errors: string[];
}

function entry(rec: PluginRecord, detail?: string): CleanEntry {
  return { formId: hex(rec.formId), sig: rec.sig, editorId: rec.editorId, ...(detail ? { detail } : {}) };
}

function emptyReport(plugin: Plugin, mode: ItmMode, dryRun: boolean): CleanReport {
  return {
    plugin: plugin.fileName,
    mode,
    dryRun,
    itmsRemoved: [],
    itmsKept: [],
    reverts: [],
    undeleted: [],
    deletedNavmeshes: [],
    navmeshesFixed: [],
    skipped: [],
    emptyGroupsRemoved: 0,
    errors: [],
  };
}

/** Clean a plugin in place. All masters must be available from `masters`. */
export function cleanPlugin(plugin: Plugin, masters: MasterSource, options: CleanOptions = {}): CleanReport {
  const opts = {
    itmMode: options.itmMode ?? 'safe',
    removeItms: options.removeItms ?? true,
    undeleteReferences: options.undeleteReferences ?? true,
    fixDeletedNavmeshes: options.fixDeletedNavmeshes ?? false,
    disabledZ: options.disabledZ ?? -30000,
    setEnableParent: options.setEnableParent ?? true,
    dryRun: options.dryRun ?? false,
  };
  const report = emptyReport(plugin, opts.itmMode, opts.dryRun);
  const missing = missingMasters(plugin, masters);
  if (missing.length) {
    report.errors.push(`Missing masters: ${missing.join(', ')}. Load them before cleaning.`);
    return report;
  }

  if (opts.undeleteReferences || opts.fixDeletedNavmeshes) undeleteAndDisable(plugin, masters, opts, report);
  if (opts.removeItms) {
    // Repeat until stable: removing children can make their parent cell/topic removable.
    let notes: ItmNotes = { kept: [], reverts: [], skipped: [] };
    for (let pass = 0; pass < 4; pass++) {
      const before = report.itmsRemoved.length + report.emptyGroupsRemoved;
      notes = removeItms(plugin, masters, opts, report);
      if (report.itmsRemoved.length + report.emptyGroupsRemoved === before || opts.dryRun) break;
    }
    report.itmsKept = notes.kept;
    report.reverts = notes.reverts;
    report.skipped.push(...notes.skipped);
  }
  plugin.invalidateIndex();
  if (!opts.dryRun) plugin.updateHeaderBookkeeping();
  return report;
}

// ------------------------------------------------------------------ ITMs

export type OverrideStatus = 'new' | 'itm' | 'revert' | 'override' | 'injected' | 'unknown';

/** Classify one record of `plugin` against its masters. */
export function classifyOverride(plugin: Plugin, rec: PluginRecord, masters: MasterSource, mode: ItmMode = 'safe'): OverrideStatus {
  if (rec.formId >>> 24 >= plugin.masters.length) return 'new';
  const versions = versionsInMasters(plugin, rec, masters);
  if (versions.length === 0) return 'injected';
  const original = versions[0]!;
  const previous = versions[versions.length - 1]!;
  if (mode === 'xedit') {
    const r = compareRecords(rec, plugin, original.record, original.plugin);
    return r === 'identical' ? 'itm' : r === 'unknown' ? 'unknown' : 'override';
  }
  const r = compareRecords(rec, plugin, previous.record, previous.plugin);
  if (r === 'identical') return 'itm';
  if (r === 'unknown') return 'unknown';
  if (versions.length > 1 && compareRecords(rec, plugin, original.record, original.plugin) === 'identical') return 'revert';
  return 'override';
}

function hasNonEmptyChildGroup(list: PluginNode[], i: number, rec: PluginRecord): PluginGroup | undefined {
  const next = list[i + 1];
  if (next && next.kind === 'group' && next.label === rec.formId && isChildGroupType(next.type)) return next;
  return undefined;
}

interface ItmNotes {
  kept: CleanEntry[];
  reverts: CleanEntry[];
  skipped: CleanEntry[];
}

function removeItms(plugin: Plugin, masters: MasterSource, opts: Required<CleanOptions>, report: CleanReport): ItmNotes {
  const notes: ItmNotes = { kept: [], reverts: [], skipped: [] };
  const visit = (list: PluginNode[]): void => {
    for (let i = list.length - 1; i >= 0; i--) {
      const node = list[i]!;
      if (node.kind === 'group') {
        visit(node.children);
        if (node.children.length === 0 && !opts.dryRun) {
          list.splice(i, 1);
          report.emptyGroupsRemoved++;
        }
        continue;
      }
      const rec = node;
      let status: OverrideStatus;
      try {
        status = classifyOverride(plugin, rec, masters, opts.itmMode);
      } catch (e) {
        report.errors.push(`${rec.toString()}: ${(e as Error).message}`);
        continue;
      }
      if (status === 'revert') {
        notes.reverts.push(entry(rec, 'identical to the original master but reverts a later master; kept'));
        continue;
      }
      if (status === 'unknown') {
        notes.skipped.push(entry(rec, 'could not compare with master (different master layout and no typed schema); kept'));
        continue;
      }
      if (status !== 'itm') continue;
      const child = hasNonEmptyChildGroup(list, i, rec);
      if (child && child.children.length > 0) {
        notes.kept.push(entry(rec, 'identical to master but still has child records'));
        continue;
      }
      report.itmsRemoved.push(entry(rec));
      if (!opts.dryRun) {
        if (child) list.splice(i + 1, 1);
        list.splice(i, 1);
      }
    }
  };
  visit(plugin.groups);
  plugin.invalidateIndex();
  return notes;
}

// ------------------------------------------------------------------ UDRs

const UDR_SIGNATURES = new Set([...REFERENCE_SIGNATURES, 'NAVM']);

function setPositionZ(subs: Subrecord[], z: number): boolean {
  const i = subs.findIndex((s) => s.sig === 'DATA');
  if (i < 0 || subs[i]!.data.byteLength < 12) return false;
  const data = subs[i]!.data.slice();
  new DataView(data.buffer).setFloat32(8, z, true);
  subs[i] = { sig: 'DATA', data };
  return true;
}

/** Copy the data of the version that would be visible without this plugin, remapping FormIDs if needed. */
function restoreFromMaster(plugin: Plugin, rec: PluginRecord, masters: MasterSource): Subrecord[] | string {
  const versions = versionsInMasters(plugin, rec, masters);
  const source = [...versions].reverse().find((v) => !v.record.isDeleted);
  if (!source) return 'no undeleted version exists in the masters';
  if (compatibleMasterIndices(plugin, source.plugin)) return source.record.subrecords.map((s) => ({ sig: s.sig, data: s.data.slice() }));
  const from = new FormIdMapper(source.plugin.fileName, source.plugin.masters);
  const to = new FormIdMapper(plugin.fileName, plugin.masters);
  const typed = decodeRecord(source.record, { mapFormId: (id) => from.toKey(id) });
  if (!typed.hasSchema || !typed.lossless || typed.unknown.length) return 'master record uses a different master layout and cannot be remapped safely';
  let failed = false;
  const tmp = source.record.clone();
  applyTyped(tmp, typed.data, [], {
    unmapFormId: (v) => {
      if (v === null || v === undefined) return 0;
      const local = to.toLocal(String(v));
      if (local === undefined) failed = true;
      return local ?? 0;
    },
  });
  if (failed) return 'master record references a plugin that is not a master of this plugin';
  return tmp.subrecords;
}

function undeleteAndDisable(plugin: Plugin, masters: MasterSource, opts: Required<CleanOptions>, report: CleanReport): void {
  for (const rec of plugin.records()) {
    if (!rec.isDeleted || !UDR_SIGNATURES.has(rec.sig)) continue;
    const isOverride = rec.formId >>> 24 < plugin.masters.length;
    if (rec.sig === 'NAVM') {
      report.deletedNavmeshes.push(entry(rec, isOverride ? 'deleted navmesh — fix manually or enable the experimental fix' : 'deleted new navmesh'));
      if (opts.fixDeletedNavmeshes && isOverride) fixNavmesh(plugin, rec, masters, opts, report);
      continue;
    }
    if (!opts.undeleteReferences) continue;
    if (!isOverride) {
      report.skipped.push(entry(rec, 'deleted record that is new in this plugin; not a master edit'));
      continue;
    }
    const restored = restoreFromMaster(plugin, rec, masters);
    if (typeof restored === 'string') {
      report.skipped.push(entry(rec, restored));
      continue;
    }
    if (!restored.some((s) => s.sig === 'NAME')) {
      report.skipped.push(entry(rec, 'master record has no base object'));
      continue;
    }
    report.undeleted.push(entry(rec));
    if (opts.dryRun) continue;

    let subs = restored.filter((s) => s.sig !== 'XESP' && s.sig !== 'XTEL');
    const persistent = (rec.flags & RecordFlags.Persistent) !== 0;
    if (!persistent) setPositionZ(subs, opts.disabledZ);
    if (opts.setEnableParent) {
      const w = new BinaryWriter(8);
      w.u32(PLAYER_REF).u8(1).zeros(3); // "Set Enable State to Opposite of Parent"
      const xesp: Subrecord = { sig: 'XESP', data: w.toBytes() };
      subs = insertXesp(rec.sig, subs, xesp);
    }
    rec.isDeleted = false;
    rec.setFlag(RecordFlags.InitiallyDisabled, true);
    rec.subrecords = subs;
  }
}

/** XESP goes before linked refs / patrol / ownership-independent tail; DATA must stay last. */
function insertXesp(sig: string, subs: Subrecord[], xesp: Subrecord): Subrecord[] {
  const out = [...subs];
  const after = sig === 'ACHR' ? ['XFVC', 'XHTW', 'XHOR', 'XLRT', 'XIS2', 'XLRL', 'XLCN', 'XLOD'] : ['XLRL', 'XCHG', 'XCNT', 'XRNK', 'XOWN', 'XIS2', 'XLRT', 'XNDP', 'XEZN', 'XLOC'];
  for (const a of after) {
    let idx = -1;
    out.forEach((s, i) => {
      if (s.sig === a) idx = i;
    });
    if (idx >= 0) {
      out.splice(idx + 1, 0, xesp);
      return out;
    }
  }
  // Fall back to just before XSCL/DATA at the end.
  const tail = out.findIndex((s) => s.sig === 'XLKR' || s.sig === 'XSCL' || s.sig === 'DATA');
  out.splice(tail < 0 ? out.length : tail, 0, xesp);
  return out;
}

function fixNavmesh(plugin: Plugin, rec: PluginRecord, masters: MasterSource, opts: Required<CleanOptions>, report: CleanReport): void {
  const restored = restoreFromMaster(plugin, rec, masters);
  if (typeof restored === 'string') {
    report.skipped.push(entry(rec, restored));
    return;
  }
  const tmp = rec.clone();
  tmp.isDeleted = false;
  tmp.subrecords = restored;
  const typed = decodeRecord(tmp);
  const nav = typed.data.geometry as Navmesh | undefined;
  if (!typed.lossless || !nav) {
    report.skipped.push(entry(rec, 'navmesh geometry could not be decoded'));
    return;
  }
  for (const v of nav.vertices) v.z = opts.disabledZ;
  for (const t of nav.triangles) t.flags &= ~(NavTriFlags.Preferred | NavTriFlags.Door);
  nav.doorLinks = [];
  nav.coverTriangles = [];
  nav.grid.min.z = opts.disabledZ;
  nav.grid.max.z = opts.disabledZ;
  report.navmeshesFixed.push(entry(rec, 'restored from master with all vertices sunk below the world'));
  if (opts.dryRun) return;
  applyTyped(tmp, typed.data, typed.unknown);
  rec.isDeleted = false;
  rec.subrecords = tmp.subrecords;
}

// ------------------------------------------------------------------ helpers

/** One-line summary like xEdit's LOOT dirty info. */
export function summarizeReport(r: CleanReport): string {
  const parts = [
    `${r.itmsRemoved.length} ITM${r.dryRun ? ' found' : ' removed'}`,
    `${r.undeleted.length} UDR${r.dryRun ? ' found' : ' fixed'}`,
    `${r.deletedNavmeshes.length} deleted navmesh${r.deletedNavmeshes.length === 1 ? '' : 'es'}`,
  ];
  if (r.reverts.length) parts.push(`${r.reverts.length} intentional revert${r.reverts.length === 1 ? '' : 's'} kept`);
  if (r.itmsKept.length) parts.push(`${r.itmsKept.length} ITM parent${r.itmsKept.length === 1 ? '' : 's'} kept`);
  if (r.skipped.length) parts.push(`${r.skipped.length} skipped`);
  return `${r.plugin}: ${parts.join(', ')}`;
}

/** True if a group is a cell's persistent/temporary children group. */
export function isCellChildList(g: PluginGroup): boolean {
  return g.type === GroupType.CellPersistentChildren || g.type === GroupType.CellTemporaryChildren;
}

export function readPosition(rec: PluginRecord): { x: number; y: number; z: number } | undefined {
  const d = rec.get('DATA');
  if (!d || d.data.byteLength < 12) return undefined;
  const r = new BinaryReader(d.data);
  return { x: r.f32(), y: r.f32(), z: r.f32() };
}
