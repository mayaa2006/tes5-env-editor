import { describe, expect, it } from 'vitest';
import {
  NAVMESH_PATHING_CELL_CRC,
  PluginRecord,
  VmadPropertyType,
  applyTyped,
  conditionFunctionByName,
  decodeRecord,
  describeCondition,
  getPath,
  newCondition,
  setPath,
  type Condition,
  type Navmesh,
  type Vmad,
} from '../src';

function roundTrip(sig: string, data: Record<string, unknown>) {
  const rec = PluginRecord.create(sig, 0x01000800, []);
  applyTyped(rec, data);
  const decoded = decodeRecord(rec);
  return { rec, decoded };
}

describe('NPC_ schema', () => {
  it('encodes and decodes a full NPC losslessly', () => {
    const { decoded } = roundTrip('NPC_', {
      editorId: 'MyNPC',
      bounds: { x1: -22, y1: -14, z1: 0, x2: 22, y2: 14, z2: 128 },
      config: {
        flags: 0x1 | 0x20,
        magickaOffset: 0,
        staminaOffset: 0,
        level: 10,
        calcMinLevel: 1,
        calcMaxLevel: 0,
        speedMultiplier: 100,
        dispositionBase: 35,
        templateFlags: 0,
        healthOffset: 0,
        bleedoutOverride: 0,
      },
      factions: [{ faction: 0x0001bcc0, rank: 0, unused: new Uint8Array(3) }],
      voice: 0x00013adc,
      race: 0x00013746,
      spells: [0x0002f3b8],
      keywords: [0x00013794],
      class: 0x0001ce14,
      name: 'Lydia Jr.',
      marker: true,
      skills: { values: new Array(18).fill(15), offsets: new Array(18).fill(0), health: 50, magicka: 0, stamina: 0, unused: new Uint8Array(2), farAwayDistance: 0, gearedUpWeapons: 0, unused2: new Uint8Array(3) },
      headParts: [0x0001aa60, 0x00051571],
      unknownNAM5: new Uint8Array([0xff, 0x00]),
      height: 1.05,
      weight: 60,
      soundLevel: 1,
      textureLighting: { r: 0.5, g: 0.4, b: 0.3 },
      faceMorph: { noseLongShort: 0.25, noseUpDown: -0.5 },
      faceParts: { nose: 1, unknown: -1, eyes: 2, mouth: 3 },
      tintLayers: [
        { index: 1, color: { r: 200, g: 150, b: 120, a: 0 }, value: 100, preset: 0 },
        { index: 7, color: { r: 20, g: 20, b: 20, a: 0 }, value: 40, preset: 2 },
      ],
    });
    expect(decoded.errors).toEqual([]);
    expect(decoded.unknown).toEqual([]);
    expect(decoded.lossless).toBe(true);
    const d = decoded.data;
    expect(d.editorId).toBe('MyNPC');
    expect(d.name).toBe('Lydia Jr.');
    expect(getPath(d, 'config.level')).toBe(10);
    expect(d.headParts).toEqual([0x0001aa60, 0x00051571]);
    expect(d.keywords).toEqual([0x00013794]);
    expect(d.spells).toEqual([0x0002f3b8]);
    expect(getPath(d, 'tintLayers.1.preset')).toBe(2);
    expect(Math.abs((getPath(d, 'faceMorph.noseUpDown') as number) + 0.5)).toBeLessThan(1e-6);
    // Unset morph sliders default to 0 on encode.
    expect(getPath(d, 'faceMorph.chinUpDown')).toBe(0);
  });

  it('preserves unknown subrecords in place', () => {
    const rec = PluginRecord.create('NPC_', 0x800, [
      { sig: 'EDID', data: new TextEncoder().encode('X\0') },
      { sig: 'ZZZZ', data: new Uint8Array([1, 2, 3]) },
      { sig: 'FULL', data: new TextEncoder().encode('Name\0') },
    ]);
    const d = decodeRecord(rec);
    expect(d.unknown.map((u) => u.sig)).toEqual(['ZZZZ']);
    expect(d.lossless).toBe(true);
    applyTyped(rec, { ...d.data, name: 'Renamed' }, d.unknown);
    expect(rec.subrecords.map((s) => s.sig)).toEqual(['EDID', 'ZZZZ', 'FULL']);
  });

  it('keeps the stored order of unordered records', () => {
    const rec = PluginRecord.create('REFR', 0x800, [
      { sig: 'NAME', data: new Uint8Array([1, 0, 0, 0]) },
      { sig: 'DATA', data: new Uint8Array(24) },
      { sig: 'XSCL', data: new Uint8Array([0, 0, 0x80, 0x3f]) },
    ]);
    const d = decodeRecord(rec);
    expect(d.lossless).toBe(true);
    expect(d.data.scale).toBe(1);
    applyTyped(rec, setPath(d.data, 'scale', 2), d.unknown);
    expect(rec.subrecords.map((s) => s.sig)).toEqual(['NAME', 'DATA', 'XSCL']);
  });
});

describe('QUST schema', () => {
  it('round-trips stages, objectives, aliases and conditions', () => {
    const cond: Condition = { ...newCondition(conditionFunctionByName('GetStage')!.index), param1: 0x01000800, op: '>=', value: 10 };
    const { decoded } = roundTrip('QUST', {
      editorId: 'MQ_MyQuest',
      name: 'My Quest',
      general: { flags: 0x0001 | 0x0100, priority: 50, formVersion: 0, unknown: new Uint8Array(4), type: 8 },
      event: '',
      dialogueConditions: [{ data: cond }],
      marker: true,
      stages: [
        { index: { index: 0, flags: 2, unknown: 0 }, logEntries: [] },
        {
          index: { index: 10, flags: 0, unknown: 0 },
          logEntries: [{ flags: 0, text: 'I should talk to the Jarl.' }],
        },
        {
          index: { index: 100, flags: 4, unknown: 0 },
          logEntries: [{ flags: 1, text: 'Done.', conditions: [{ data: newCondition(0) }] }],
        },
      ],
      objectives: [{ index: 10, oredWithPrevious: 0, text: 'Talk to the Jarl', targets: [{ target: { alias: 0, ignoresLocks: 0, unused: new Uint8Array(3) } }] }],
      nextAliasId: 2,
      aliases: [
        { option: 0, value: { id: 0, name: 'Jarl', flags: 0x4, fill: { option: 1, value: { actor: 0x00013bbd } }, end: true } },
        { option: 1, value: { id: 1, name: 'Hold', flags: 0, fill: { option: 0, value: { location: 0x00018a56 } }, end: true } },
      ],
      description: '',
    });
    expect(decoded.errors).toEqual([]);
    expect(decoded.unknown).toEqual([]);
    expect(decoded.lossless).toBe(true);
    const d = decoded.data as Record<string, any>;
    expect(d.stages).toHaveLength(3);
    expect(d.stages[1].logEntries[0].text).toBe('I should talk to the Jarl.');
    expect(d.stages[2].logEntries[0].conditions).toHaveLength(1);
    expect(d.objectives[0].targets[0].target.alias).toBe(0);
    expect(d.aliases[0].option).toBe(0);
    expect(d.aliases[0].value.fill.value.actor).toBe(0x00013bbd);
    expect(d.aliases[1].value.name).toBe('Hold');
    const c = d.dialogueConditions[0].data as Condition;
    expect(c.op).toBe('>=');
    expect(c.param1).toBe(0x01000800);
    expect(describeCondition(c)).toContain('GetStage');
  });
});

describe('VMAD', () => {
  it('round-trips scripts, quest fragments and alias scripts', () => {
    const vmad: Vmad = {
      version: 5,
      objectFormat: 2,
      scripts: [
        {
          name: 'MyQuestScript',
          flags: 0,
          properties: [
            { name: 'PlayerRef', type: VmadPropertyType.Object, flags: 1, value: { form: 0x14, alias: -1 } },
            { name: 'Gold', type: VmadPropertyType.Int, flags: 1, value: 100 },
            { name: 'Ratio', type: VmadPropertyType.Float, flags: 1, value: 0.5 },
            { name: 'Greeting', type: VmadPropertyType.String, flags: 1, value: 'Hej – välkommen' },
            { name: 'Enabled', type: VmadPropertyType.Bool, flags: 1, value: true },
            { name: 'Items', type: VmadPropertyType.ObjectArray, flags: 1, value: [{ form: 0xf, alias: -1 }, { form: 0, alias: 3 }] },
            { name: 'Stages', type: VmadPropertyType.IntArray, flags: 1, value: [10, 20] },
          ],
        },
      ],
      fragments: {
        kind: 'QUST',
        extraBindVersion: 2,
        fileName: 'QF_MyQuest_01000800',
        fragments: [{ stage: 10, logEntry: 0, unknown: 1, scriptName: 'QF_MyQuest_01000800', fragmentName: 'Fragment_0' }],
      },
      aliases: [
        {
          object: { form: 0x01000800, alias: 0 },
          version: 5,
          objectFormat: 2,
          scripts: [{ name: 'MyAliasScript', flags: 0, properties: [] }],
        },
      ],
    };
    const { decoded } = roundTrip('QUST', { editorId: 'Q', scripts: vmad, general: { flags: 0, priority: 0, formVersion: 0, unknown: new Uint8Array(4), type: 0 }, marker: true, nextAliasId: 0 });
    expect(decoded.lossless).toBe(true);
    const v = decoded.data.scripts as Vmad;
    expect(v.scripts[0]!.properties.map((p) => p.value)).toEqual([
      { form: 0x14, alias: -1 },
      100,
      0.5,
      'Hej – välkommen',
      true,
      [{ form: 0xf, alias: -1 }, { form: 0, alias: 3 }],
      [10, 20],
    ]);
    expect(v.fragments?.kind).toBe('QUST');
    expect(v.aliases?.[0]?.scripts[0]?.name).toBe('MyAliasScript');
  });

  it('round-trips INFO begin/end fragments', () => {
    const vmad: Vmad = {
      version: 5,
      objectFormat: 2,
      scripts: [],
      fragments: {
        kind: 'INFO',
        extraBindVersion: 2,
        flags: 3,
        fileName: 'TIF__01000801',
        fragments: [
          { unknown: 1, scriptName: 'TIF__01000801', fragmentName: 'Fragment_0' },
          { unknown: 1, scriptName: 'TIF__01000801', fragmentName: 'Fragment_1' },
        ],
      },
    };
    const { decoded } = roundTrip('INFO', { scripts: vmad, favorLevel: 0 });
    expect(decoded.lossless).toBe(true);
    expect((decoded.data.scripts as Vmad).fragments).toEqual(vmad.fragments);
  });
});

describe('NVNM', () => {
  it('round-trips an interior navmesh', () => {
    const nav: Navmesh = {
      version: 12,
      crc: NAVMESH_PATHING_CELL_CRC,
      world: 0,
      parent: { cell: 0x01000800 },
      vertices: [
        { x: 0, y: 0, z: 0 },
        { x: 100, y: 0, z: 0 },
        { x: 100, y: 100, z: 0 },
        { x: 0, y: 100, z: 0 },
      ],
      triangles: [
        { v: [0, 1, 2], e: [-1, -1, 1], flags: 0, coverFlags: 0 },
        { v: [0, 2, 3], e: [0, -1, -1], flags: 0, coverFlags: 0 },
      ],
      edgeLinks: [],
      doorLinks: [],
      coverTriangles: [],
      grid: { divisor: 1, sizeX: 100, sizeY: 100, min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 100, z: 0 }, cells: [[0, 1]] },
    };
    const { decoded } = roundTrip('NAVM', { geometry: nav });
    expect(decoded.lossless).toBe(true);
    expect(decoded.data.geometry).toEqual(nav);
  });
});

describe('setPath', () => {
  it('copies on write', () => {
    const a = { x: { y: [1, 2, 3] } };
    const b = setPath(a, 'x.y.1', 9);
    expect(a.x.y[1]).toBe(2);
    expect(b.x.y).toEqual([1, 9, 3]);
  });
});

describe('magic, perk and crafting records', () => {
  const u32 = (...v: number[]) => new Uint8Array(new Uint32Array(v).buffer);
  const f32 = (...v: number[]) => new Uint8Array(new Float32Array(v).buffer);
  const cat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let o = 0;
    for (const p of parts) (out.set(p, o), (o += p.byteLength));
    return out;
  };

  it('reads a perk effect by its type: quest stage, ability and entry point with parameters', () => {
    const rec = PluginRecord.create('PERK', 0x800, [
      { sig: 'EDID', data: new TextEncoder().encode('P\0') },
      { sig: 'DESC', data: new Uint8Array([0]) },
      { sig: 'DATA', data: new Uint8Array([0, 0, 1, 1, 0]) },
      { sig: 'PRKE', data: new Uint8Array([0, 0, 0]) },
      { sig: 'DATA', data: cat(u32(0x123), new Uint8Array([10, 0, 0, 0])) },
      { sig: 'PRKF', data: new Uint8Array(0) },
      { sig: 'PRKE', data: new Uint8Array([1, 0, 0]) },
      { sig: 'DATA', data: u32(0x456) },
      { sig: 'PRKF', data: new Uint8Array(0) },
      { sig: 'PRKE', data: new Uint8Array([2, 0, 0]) },
      { sig: 'DATA', data: new Uint8Array([35, 3, 3]) },
      { sig: 'PRKC', data: new Uint8Array([0]) },
      { sig: 'EPFT', data: new Uint8Array([1]) },
      { sig: 'EPFD', data: f32(1.25) },
      { sig: 'PRKF', data: new Uint8Array(0) },
    ]);
    const t = decodeRecord(rec);
    expect(t.lossless).toBe(true);
    const fx = t.data.effects as any[];
    expect(fx[0].data).toMatchObject({ quest: 0x123, stage: 10 });
    expect(fx[1].data).toEqual({ ability: 0x456 });
    expect(fx[2].data).toMatchObject({ entryPoint: 35, function: 3 });
    expect(fx[2].function.data.value).toBeCloseTo(1.25);
  });

  it('keeps lists stored without their count, and 1-byte cell flags, exactly as they were', () => {
    const cell = PluginRecord.create('CELL', 0x800, [
      { sig: 'EDID', data: new TextEncoder().encode('C\0') },
      { sig: 'DATA', data: new Uint8Array([1]) },
    ]);
    const tc = decodeRecord(cell);
    expect(tc.lossless).toBe(true);
    expect(tc.data.flags).toBe(1);

    const recipe = PluginRecord.create('COBJ', 0x801, [
      { sig: 'EDID', data: new TextEncoder().encode('R\0') },
      { sig: 'CNTO', data: cat(u32(0x10), u32(2)) },
      { sig: 'CNAM', data: u32(0x20) },
      { sig: 'NAM1', data: new Uint8Array([1, 0]) },
    ]);
    const tr = decodeRecord(recipe);
    expect(tr.lossless).toBe(true);
    expect((tr.data.items as any[])[0].item).toEqual({ item: 0x10, count: 2 });
  });

  it('writes a spell with effects and reads it back', () => {
    const { decoded } = roundTrip('SPEL', {
      editorId: 'Firebolt',
      name: 'Firebolt',
      description: '',
      data: { baseCost: 41, flags: 0, type: 0, chargeTime: 0.5, castingType: 1, delivery: 2, castDuration: 0, range: 0, halfCostPerk: 0 },
      effects: [{ effect: 0x1234, data: { magnitude: 25, area: 0, duration: 1 } }],
    });
    expect(decoded.lossless).toBe(true);
    expect(decoded.unknown).toEqual([]);
    expect((decoded.data.effects as any[])[0]).toMatchObject({ effect: 0x1234, data: { magnitude: 25 } });
  });
});
