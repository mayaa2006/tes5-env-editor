import { describe, expect, it } from 'vitest';
import {
  BinaryWriter,
  FormIdMapper,
  GroupType,
  Plugin,
  PluginRecord,
  RecordFlags,
  StringTable,
  assignLoadOrderSlots,
  bytesEqual,
  decodeCp1252,
  encodeCp1252,
  makeFormKey,
  parsePlugin,
  parseFormId,
  placeRecord,
  parentOf,
  pruneEmptyGroups,
  readPluginHeader,
  runtimeFormId,
  zstringBytes,
  readZString,
  compressPayload,
} from '../src';

function edid(s: string) {
  return { sig: 'EDID', data: zstringBytes(s) };
}

function posRot(x = 0, y = 0, z = 0): Uint8Array {
  const w = new BinaryWriter(24);
  w.f32(x).f32(y).f32(z).f32(0).f32(0).f32(0);
  return w.toBytes();
}

describe('cp1252 text codec', () => {
  it('round-trips every byte value', () => {
    const all = new Uint8Array(256).map((_, i) => i);
    const s = decodeCp1252(all);
    expect(bytesEqual(encodeCp1252(s), all)).toBe(true);
  });

  it('maps the euro sign', () => {
    expect(decodeCp1252(new Uint8Array([0x80]))).toBe('€');
    expect(encodeCp1252('€')[0]).toBe(0x80);
  });
});

describe('Plugin read/write', () => {
  it('creates, serializes and re-parses a plugin', () => {
    const p = Plugin.create('Test.esp', { masters: ['Skyrim.esm'], author: 'Me', description: 'Hello' });
    const id = p.allocateFormId();
    expect(id).toBe(0x01000800);
    const stat = PluginRecord.create('STAT', id, [edid('MyStatic'), { sig: 'MODL', data: zstringBytes('Clutter\\Box.nif') }]);
    placeRecord(p, stat);
    p.updateHeaderBookkeeping();
    const bytes = p.serialize();
    const q = parsePlugin(bytes, 'Test.esp');
    expect(q.masters).toEqual(['Skyrim.esm']);
    expect(q.author).toBe('Me');
    expect(q.description).toBe('Hello');
    expect(q.hedr.numRecords).toBe(2); // one group + one record
    expect(q.hedr.nextObjectId).toBe(0x801);
    const rec = q.getRecord(id)!;
    expect(rec.editorId).toBe('MyStatic');
    // Untouched plugin re-serializes byte-for-byte.
    expect(bytesEqual(q.serialize(), bytes)).toBe(true);
  });

  it('keeps compressed records byte-identical when untouched and decodes them', () => {
    const p = Plugin.create('C.esp');
    const subs = [edid('Compressed'), { sig: 'DATA', data: new Uint8Array(500).fill(7) }];
    const payload = new BinaryWriter();
    for (const s of subs) payload.sig(s.sig).u16(s.data.byteLength).bytes(s.data);
    const stored = compressPayload(payload.toBytes());
    const rec = new PluginRecord({ sig: 'NPC_', formId: 0x800, flags: RecordFlags.Compressed }, stored);
    p.ensureTopGroup('NPC_').children.push(rec);
    const bytes = p.serialize();
    const q = parsePlugin(bytes, 'C.esp');
    const r2 = q.getRecord(0x800)!;
    expect(r2.isCompressed).toBe(true);
    expect(r2.editorId).toBe('Compressed');
    expect(r2.get('DATA')!.data.byteLength).toBe(500);
    expect(bytesEqual(q.serialize(), bytes)).toBe(true);
    // Editing re-compresses and still decodes.
    r2.editorId = 'Changed';
    const q2 = parsePlugin(q.serialize(), 'C.esp');
    expect(q2.getRecord(0x800)!.editorId).toBe('Changed');
    expect(q2.getRecord(0x800)!.isCompressed).toBe(true);
  });

  it('handles subrecords larger than 64 KiB via XXXX', () => {
    const p = Plugin.create('Big.esp');
    const big = new Uint8Array(70000).map((_, i) => i & 0xff);
    const rec = PluginRecord.create('NAVM', 0x800, [{ sig: 'NVNM', data: big }]);
    p.ensureTopGroup('NAVM').children.push(rec);
    const q = parsePlugin(p.serialize(), 'Big.esp');
    const s = q.getRecord(0x800)!.get('NVNM')!;
    expect(s.data.byteLength).toBe(70000);
    expect(bytesEqual(s.data, big)).toBe(true);
  });

  it('places interior cells, references and dialogue in the right groups', () => {
    const p = Plugin.create('World.esp', { masters: ['Skyrim.esm'] });
    const cellId = p.allocateFormId();
    const cell = PluginRecord.create('CELL', cellId, [edid('MyCell'), { sig: 'DATA', data: new Uint8Array([1, 0]) }]);
    placeRecord(p, cell);
    const refId = p.allocateFormId();
    const ref = PluginRecord.create('REFR', refId, [{ sig: 'NAME', data: new Uint8Array([0x3b, 0x2e, 0x01, 0x00]) }, { sig: 'DATA', data: posRot(1, 2, 3) }]);
    placeRecord(p, ref, { cell: cellId });
    const persistentId = p.allocateFormId();
    const pref = PluginRecord.create('REFR', persistentId, [{ sig: 'DATA', data: posRot() }], RecordFlags.Persistent);
    placeRecord(p, pref, { cell: cellId });

    const dialId = p.allocateFormId();
    placeRecord(p, PluginRecord.create('DIAL', dialId, [edid('MyTopic')]));
    const infoId = p.allocateFormId();
    placeRecord(p, PluginRecord.create('INFO', infoId, []), { topic: dialId });

    const q = parsePlugin(p.serialize(), 'World.esp');
    const top = q.topGroup('CELL')!;
    const block = top.groups[0]!;
    expect(block.type).toBe(GroupType.InteriorCellBlock);
    expect(block.label).toBe((cellId & 0xffffff) % 10);
    expect(parentOf(q, refId)).toEqual({ cell: cellId, persistent: false });
    expect(parentOf(q, persistentId)).toEqual({ cell: cellId, persistent: true });
    expect(parentOf(q, infoId)).toEqual({ topic: dialId });
    // Persistent children come before temporary children.
    const children = q.childGroupOf(q.getRecord(cellId)!)!;
    expect(children.groups.map((g) => g.type)).toEqual([GroupType.CellPersistentChildren, GroupType.CellTemporaryChildren]);

    // Removing the cell removes its children group too; pruning cleans blocks.
    expect(q.removeRecord(cellId)).toBe(true);
    pruneEmptyGroups(q);
    expect(q.topGroup('CELL')).toBeUndefined();
  });

  it('places exterior cells into worldspace blocks', () => {
    const p = Plugin.create('Ext.esp');
    const wrldId = p.allocateFormId();
    placeRecord(p, PluginRecord.create('WRLD', wrldId, [edid('MyWorld')]));
    const cellId = p.allocateFormId();
    const xclc = new BinaryWriter(12);
    xclc.i32(-3).i32(40).u32(0);
    placeRecord(p, PluginRecord.create('CELL', cellId, [{ sig: 'DATA', data: new Uint8Array([0, 0]) }, { sig: 'XCLC', data: xclc.toBytes() }]), { worldspace: wrldId });
    const q = parsePlugin(p.serialize(), 'Ext.esp');
    const world = q.childGroupOf(q.getRecord(wrldId)!)!;
    expect(world.type).toBe(GroupType.WorldChildren);
    const block = world.groups[0]!;
    expect(block.type).toBe(GroupType.ExteriorCellBlock);
    expect(block.labelGrid).toEqual({ x: -1, y: 1 });
    expect(block.groups[0]!.labelGrid).toEqual({ x: -1, y: 5 });
  });

  it('reads only the header quickly', () => {
    const p = Plugin.create('Light.esp', { masters: ['Skyrim.esm', 'Update.esm'] });
    p.isESL = true;
    const h = readPluginHeader(p.serialize(), 'Light.esp');
    expect(h.masters).toEqual(['Skyrim.esm', 'Update.esm']);
    expect(h.isESL).toBe(true);
  });

  it('keeps new FormIDs inside the ESL range', () => {
    const p = Plugin.create('Small.esp');
    p.isESL = true;
    p.hedr = { ...p.hedr, nextObjectId: 0xfff };
    expect(p.allocateFormId() & 0xffffff).toBe(0xfff);
    p.ensureTopGroup('GLOB').children.push(PluginRecord.create('GLOB', 0xfff, []));
    // next one wraps to the first free compact ID
    expect(p.allocateFormId() & 0xffffff).toBe(0x800);
  });

  it('writes ONAM for master files', () => {
    const p = Plugin.create('Master.esm', { masters: ['Skyrim.esm'] });
    const cell = PluginRecord.create('CELL', 0x0000003c, [{ sig: 'DATA', data: new Uint8Array([1, 0]) }]);
    placeRecord(p, cell);
    placeRecord(p, PluginRecord.create('REFR', 0x00012345, [{ sig: 'DATA', data: posRot() }]), { cell: 0x3c });
    p.updateHeaderBookkeeping();
    const onam = p.header.get('ONAM')!;
    const dv = new DataView(onam.data.buffer, onam.data.byteOffset);
    expect([dv.getUint32(0, true), dv.getUint32(4, true)]).toEqual([0x3c, 0x12345]);
    const incc = p.header.get('INCC')!;
    expect(new DataView(incc.data.buffer, incc.data.byteOffset).getUint32(0, true)).toBe(1);
  });
});

describe('FormIDs', () => {
  it('maps file-local IDs to load-order independent keys', () => {
    const m = new FormIdMapper('Mod.esp', ['Skyrim.esm', 'Dawnguard.esm']);
    expect(m.toKey(0x00012e49)).toBe('012E49:Skyrim.esm');
    expect(m.toKey(0x01002345)).toBe('002345:Dawnguard.esm');
    expect(m.toKey(0x02000801)).toBe('000801:Mod.esp');
    expect(m.toLocal(makeFormKey(0x2345, 'dawnguard.esm'))).toBe(0x01002345);
    expect(m.toLocal('000801:Mod.esp')).toBe(0x02000801);
    expect(m.toLocal('000801:Other.esp')).toBeUndefined();
  });

  it('computes runtime FormIDs for light and full plugins', () => {
    const slots = assignLoadOrderSlots([
      { fileName: 'Skyrim.esm', light: false },
      { fileName: 'ccBGSSSE001-Fish.esm', light: true },
      { fileName: 'Mod.esp', light: false },
    ]);
    expect(runtimeFormId(slots[1]!, 0x801)).toBe(0xfe000801);
    expect(runtimeFormId(slots[2]!, 0x801)).toBe(0x01000801);
    expect(parseFormId('[01000801]')).toBe(0x01000801);
  });
});

describe('String tables', () => {
  it('round-trips all three kinds', () => {
    for (const kind of ['STRINGS', 'DLSTRINGS', 'ILSTRINGS'] as const) {
      const t = new StringTable(kind);
      t.set(1, 'Hello');
      t.set(5, 'Wörld – €');
      t.set(2, '');
      const u = StringTable.parse(t.serialize(), kind);
      expect(u.get(1)).toBe('Hello');
      expect(u.get(5)).toBe('Wörld – €');
      expect(u.get(2)).toBe('');
      expect(u.nextId()).toBe(6);
    }
  });
});

describe('PluginRecord.peek', () => {
  it('finds subrecords in raw and compressed records without caching a parse', () => {
    const p = Plugin.create('Peek.esp');
    const big = new Uint8Array(70000).fill(7);
    const plain = PluginRecord.create('STAT', 0x800, [
      { sig: 'EDID', data: zstringBytes('PeekPlain') },
      { sig: 'MODL', data: big },
      { sig: 'FULL', data: zstringBytes('Plain name') },
    ]);
    const packed = PluginRecord.create('NPC_', 0x801, [{ sig: 'EDID', data: zstringBytes('PeekPacked') }], RecordFlags.Compressed);
    p.ensureTopGroup('STAT').children.push(plain);
    p.ensureTopGroup('NPC_').children.push(packed);
    const back = parsePlugin(p.serialize(), 'Peek.esp');
    const [r1] = [...back.recordsOfType('STAT')];
    const [r2] = [...back.recordsOfType('NPC_')];
    expect(r1!.editorId).toBe('PeekPlain');
    expect(readZString(r1!.peek('FULL')!)).toBe('Plain name'); // after an XXXX-sized subrecord
    expect(r1!.peek('MODL')!.byteLength).toBe(70000);
    expect(r1!.peek('NONE')).toBeUndefined();
    expect(r2!.editorId).toBe('PeekPacked');
    // Still unmodified: writes back byte for byte.
    expect(r1!.isModified).toBe(false);
  });
});
