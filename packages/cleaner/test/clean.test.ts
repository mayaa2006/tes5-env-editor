import { describe, expect, it } from 'vitest';
import {
  BinaryReader,
  BinaryWriter,
  NAVMESH_PATHING_CELL_CRC,
  Plugin,
  PluginRecord,
  RecordFlags,
  applyTyped,
  decodeRecord,
  parsePlugin,
  placeRecord,
  zstringBytes,
  type Navmesh,
} from '@tes5/esp';
import { MapMasterSource, classifyOverride, cleanPlugin, crc32, summarizeReport } from '../src';

const edid = (s: string) => ({ sig: 'EDID', data: zstringBytes(s) });
const u32b = (v: number) => {
  const w = new BinaryWriter(4);
  w.u32(v);
  return w.toBytes();
};
const f32b = (v: number) => {
  const w = new BinaryWriter(4);
  w.f32(v);
  return w.toBytes();
};
const posRot = (x: number, y: number, z: number) => {
  const w = new BinaryWriter(24);
  w.f32(x).f32(y).f32(z).f32(0).f32(0).f32(0);
  return w.toBytes();
};
const interiorData = () => ({ sig: 'DATA', data: new Uint8Array([1, 0]) });

/** Builds Skyrim.esm-like master, an Update.esm-like second master, and a dirty plugin. */
function buildFixture() {
  const master = Plugin.create('Base.esm');
  const glob = PluginRecord.create('GLOB', 0x000801, [edid('MyGlobal'), { sig: 'FNAM', data: new Uint8Array([0x66]) }, { sig: 'FLTV', data: f32b(1) }]);
  placeRecord(master, glob);
  const glob2 = PluginRecord.create('GLOB', 0x000802, [edid('Patched'), { sig: 'FNAM', data: new Uint8Array([0x66]) }, { sig: 'FLTV', data: f32b(1) }]);
  placeRecord(master, glob2);
  const cell = PluginRecord.create('CELL', 0x000900, [edid('BaseCell'), interiorData()]);
  placeRecord(master, cell);
  const refA = PluginRecord.create('REFR', 0x000901, [{ sig: 'NAME', data: u32b(0x801) }, { sig: 'DATA', data: posRot(10, 20, 30) }]);
  placeRecord(master, refA, { cell: 0x900 });
  const refB = PluginRecord.create('REFR', 0x000902, [{ sig: 'NAME', data: u32b(0x801) }, { sig: 'DATA', data: posRot(1, 2, 3) }]);
  placeRecord(master, refB, { cell: 0x900 });
  const nav: Navmesh = {
    version: 12,
    crc: NAVMESH_PATHING_CELL_CRC,
    world: 0,
    parent: { cell: 0x900 },
    vertices: [
      { x: 0, y: 0, z: 5 },
      { x: 100, y: 0, z: 5 },
      { x: 0, y: 100, z: 5 },
    ],
    triangles: [{ v: [0, 1, 2], e: [-1, -1, -1], flags: 0, coverFlags: 0 }],
    edgeLinks: [],
    doorLinks: [],
    coverTriangles: [],
    grid: { divisor: 1, sizeX: 100, sizeY: 100, min: { x: 0, y: 0, z: 5 }, max: { x: 100, y: 100, z: 5 }, cells: [[0]] },
  };
  const navRec = PluginRecord.create('NAVM', 0x000903, []);
  applyTyped(navRec, { geometry: nav });
  placeRecord(master, navRec, { cell: 0x900 });

  // A patch master that changes "Patched" to 2.
  const update = Plugin.create('Patch.esm', { masters: ['Base.esm'] });
  placeRecord(update, PluginRecord.create('GLOB', 0x000802, [edid('Patched'), { sig: 'FNAM', data: new Uint8Array([0x66]) }, { sig: 'FLTV', data: f32b(2) }]));

  // The dirty plugin.
  const mod = Plugin.create('Dirty.esp', { masters: ['Base.esm', 'Patch.esm'] });
  // 1. ITM of MyGlobal
  placeRecord(mod, glob.clone());
  // 2. Intentional revert of "Patched" back to Base value 1
  placeRecord(mod, glob2.clone());
  // 3. ITM cell with an ITM reference and a deleted reference
  placeRecord(mod, cell.clone());
  placeRecord(mod, refA.clone(), { cell: 0x900 });
  const deleted = new PluginRecord({ sig: 'REFR', formId: 0x000902, flags: RecordFlags.Deleted }, new Uint8Array(0));
  placeRecord(mod, deleted, { cell: 0x900 });
  // 4. deleted navmesh
  const delNav = new PluginRecord({ sig: 'NAVM', formId: 0x000903, flags: RecordFlags.Deleted }, new Uint8Array(0));
  placeRecord(mod, delNav, { cell: 0x900 });
  // 5. a real edit
  const edited = glob.clone();
  edited.editorId = 'MyGlobal';
  edited.set('FLTV', f32b(42));
  edited.formId = 0x000801;
  // replace the ITM with an edit in a second plugin to compare
  // 6. a new record (never touched)
  placeRecord(mod, PluginRecord.create('GLOB', 0x02000800, [edid('NewGlobal'), { sig: 'FNAM', data: new Uint8Array([0x66]) }, { sig: 'FLTV', data: f32b(7) }]));
  return { master, update, mod: parsePlugin(mod.serialize(), 'Dirty.esp'), masters: new MapMasterSource([master, update]), edited };
}

describe('classifyOverride', () => {
  it('distinguishes ITMs, reverts, overrides and new records', () => {
    const { mod, masters } = buildFixture();
    expect(classifyOverride(mod, mod.getRecord(0x801)!, masters)).toBe('itm');
    expect(classifyOverride(mod, mod.getRecord(0x802)!, masters)).toBe('revert');
    expect(classifyOverride(mod, mod.getRecord(0x802)!, masters, 'xedit')).toBe('itm');
    expect(classifyOverride(mod, mod.getRecord(0x02000800)!, masters)).toBe('new');
  });
});

describe('cleanPlugin', () => {
  it('cleans like xEdit QAC but keeps intentional reverts in safe mode', () => {
    const { mod, masters } = buildFixture();
    const report = cleanPlugin(mod, masters);
    expect(report.errors).toEqual([]);
    expect(report.itmsRemoved.map((e) => e.formId).sort()).toEqual(['00000801', '00000901']);
    expect(report.reverts.map((e) => e.formId)).toEqual(['00000802']);
    expect(report.undeleted.map((e) => e.formId)).toEqual(['00000902']);
    expect(report.deletedNavmeshes.map((e) => e.formId)).toEqual(['00000903']);
    // The cell still has children (the undeleted ref + deleted navmesh), so it is kept.
    expect(report.itmsKept.map((e) => e.formId)).toEqual(['00000900']);
    expect(summarizeReport(report)).toContain('2 ITM removed');

    const out = parsePlugin(mod.serialize(), 'Dirty.esp');
    expect(out.getRecord(0x801)).toBeUndefined();
    expect(out.getRecord(0x802)).toBeDefined();
    expect(out.getRecord(0x02000800)).toBeDefined();
    const ref = out.getRecord(0x902)!;
    expect(ref.isDeleted).toBe(false);
    expect(ref.isInitiallyDisabled).toBe(true);
    // Data restored from the master, then sunk to Z = -30000.
    const pos = new BinaryReader(ref.get('DATA')!.data);
    expect([pos.f32(), pos.f32(), pos.f32()]).toEqual([1, 2, -30000]);
    const xesp = new BinaryReader(ref.get('XESP')!.data);
    expect(xesp.u32()).toBe(0x14);
    expect(xesp.u8()).toBe(1);
    expect(ref.subrecords.map((s) => s.sig)).toEqual(['NAME', 'XESP', 'DATA']);
  });

  it('removes reverts too in xEdit mode', () => {
    const { mod, masters } = buildFixture();
    const report = cleanPlugin(mod, masters, { itmMode: 'xedit' });
    expect(report.itmsRemoved.map((e) => e.formId).sort()).toEqual(['00000801', '00000802', '00000901']);
  });

  it('removes a now-empty ITM cell after its children are cleaned', () => {
    const { master, masters } = buildFixture();
    const mod = Plugin.create('OnlyCell.esp', { masters: ['Base.esm'] });
    placeRecord(mod, master.getRecord(0x900)!.clone());
    placeRecord(mod, master.getRecord(0x901)!.clone(), { cell: 0x900 });
    const report = cleanPlugin(mod, masters);
    expect(report.itmsRemoved.map((e) => e.formId).sort()).toEqual(['00000900', '00000901']);
    expect(mod.groups).toEqual([]);
  });

  it('only reports in dry-run mode', () => {
    const { mod, masters } = buildFixture();
    const before = mod.serialize();
    const report = cleanPlugin(mod, masters, { dryRun: true });
    expect(report.itmsRemoved.length).toBe(2);
    expect(report.undeleted.length).toBe(1);
    expect(crc32(mod.serialize())).toBe(crc32(before));
  });

  it('experimentally restores deleted navmeshes below the world', () => {
    const { mod, masters } = buildFixture();
    const report = cleanPlugin(mod, masters, { fixDeletedNavmeshes: true });
    expect(report.navmeshesFixed.map((e) => e.formId)).toEqual(['00000903']);
    const nav = decodeRecord(mod.getRecord(0x903)!).data.geometry as Navmesh;
    expect(nav.vertices.every((v) => v.z === -30000)).toBe(true);
    expect(mod.getRecord(0x903)!.isDeleted).toBe(false);
  });

  it('refuses to clean without masters', () => {
    const { mod } = buildFixture();
    const report = cleanPlugin(mod, new MapMasterSource([]));
    expect(report.errors[0]).toMatch(/Missing masters/);
  });

  it('compares through schemas when master layouts differ', () => {
    const { master, masters } = buildFixture();
    // Plugin lists masters in a different order than the record was saved with: Patch.esm first.
    const mod = Plugin.create('Reordered.esp', { masters: ['Patch.esm', 'Base.esm'] });
    const g = master.getRecord(0x801)!.clone();
    g.formId = 0x01000801; // Base.esm is index 1 here
    placeRecord(mod, g);
    expect(classifyOverride(mod, mod.getRecord(0x01000801)!, masters)).toBe('itm');
  });
});

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});
