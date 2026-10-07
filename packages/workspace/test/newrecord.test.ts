import { describe, expect, it } from 'vitest';
import { CREATABLE_TYPES, MemoryFileSystem, Workspace, blankRecordData, createBlankRecord, createDemoData, isCreatable } from '../src';

async function setup() {
  const fs = new MemoryFileSystem();
  const demo = createDemoData(fs);
  const ws = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir], outputDir: demo.dataDir, loadOrder: [{ name: 'DemoWorld.esm', active: true }] });
  await ws.scan();
  await ws.load();
  ws.createPlugin('Magic.esp');
  return { ws, fs, demo };
}

describe('creating records from scratch', () => {
  it('creates every listed type with defaults that save and read back exactly', async () => {
    const { ws } = await setup();
    for (const sig of CREATABLE_TYPES) {
      expect(isCreatable(sig), sig).toBe(true);
      const key = createBlankRecord(ws, sig);
      const v = ws.view(key)!;
      expect(v.sig).toBe(sig);
      expect(v.lossless, `${sig} round trip`).toBe(true);
      expect(v.unknown, sig).toEqual([]);
      expect(String(v.data.editorId)).toMatch(/^New/);
    }
    // Unique Editor IDs, and one undo removes one record.
    const a = createBlankRecord(ws, 'SPEL');
    const b = createBlankRecord(ws, 'SPEL');
    expect(ws.view(a)!.data.editorId).not.toBe(ws.view(b)!.data.editorId);
    ws.undo();
    expect(ws.view(b)).toBeUndefined();
    expect(ws.view(a)).toBeDefined();
    expect(() => createBlankRecord(ws, 'REFR')).toThrow(/can't be created/);
  });

  it('builds a working spell, leveled list, recipe and perk that survive a save and reload', async () => {
    const { ws, fs, demo } = await setup();
    const effect = createBlankRecord(ws, 'MGEF', 'MyFireDamage');
    const effectData = ws.view(effect)!.data as any;
    ws.updateRecord(effect, { ...effectData, data: { ...effectData.data, archetype: 0, actorValue: 24, magicSkill: 20, resistValue: 41, flags: 0b101 } });
    const spell = createBlankRecord(ws, 'SPEL', 'MyFirebolt');
    const s = ws.view(spell)!.data as any;
    expect(s.data.castingType).toBe(1);
    ws.updateRecord(spell, { ...s, name: 'Firebolt', data: { ...s.data, baseCost: 41 }, effects: [{ effect, data: { magnitude: 25, area: 0, duration: 1 } }] });

    const misc = ws.byEditorId('DemoGoldCoin') ?? (ws.search({ sigs: ['MISC'], limit: 1 }).items[0]!.formKey as string);
    const list = createBlankRecord(ws, 'LVLI', 'MyLoot');
    ws.updateRecord(list, { ...(ws.view(list)!.data as any), entries: [{ entry: { level: 5, reference: misc, count: 3 } }] });
    const recipe = createBlankRecord(ws, 'COBJ', 'MyRecipe');
    ws.updateRecord(recipe, { ...(ws.view(recipe)!.data as any), items: [{ item: { item: misc, count: 2 } }], createdObject: misc, createdCount: 1 });

    const perk = createBlankRecord(ws, 'PERK', 'MyPerk');
    ws.updateRecord(perk, {
      ...(ws.view(perk)!.data as any),
      effects: [
        { header: { type: 2, rank: 0, priority: 0 }, data: { entryPoint: 35, function: 3, conditionTabs: 3 }, conditionTabs: [], function: { functionType: 1, data: { value: 1.2 } }, end: true },
        { header: { type: 1, rank: 0, priority: 0 }, data: { ability: spell }, end: true },
      ],
    });

    await ws.save();
    const ws2 = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir], outputDir: demo.dataDir, loadOrder: [{ name: 'DemoWorld.esm', active: true }, { name: 'Magic.esp', active: true }] });
    await ws2.scan();
    await ws2.load();
    const sp = ws2.view(ws2.byEditorId('MyFirebolt')!)!;
    expect(sp.lossless).toBe(true);
    expect((sp.data as any).name).toBe('Firebolt');
    expect((sp.data as any).data.baseCost).toBe(41);
    expect((sp.data as any).effects[0].effect).toBe(ws2.byEditorId('MyFireDamage'));
    expect((sp.data as any).effects[0].data.magnitude).toBe(25);
    const fx = ws2.view(ws2.byEditorId('MyFireDamage')!)!.data as any;
    expect([fx.data.actorValue, fx.data.magicSkill, fx.data.resistValue, fx.data.secondActorValue]).toEqual([24, 20, 41, -1]);
    expect((ws2.view(ws2.byEditorId('MyLoot')!)!.data as any).entries[0].entry).toMatchObject({ level: 5, count: 3 });
    expect((ws2.view(ws2.byEditorId('MyRecipe')!)!.data as any).items[0].item.count).toBe(2);
    const pk = ws2.view(ws2.byEditorId('MyPerk')!)!;
    expect(pk.lossless).toBe(true);
    const effects = (pk.data as any).effects;
    expect(effects[0].data).toMatchObject({ entryPoint: 35, function: 3 });
    expect(effects[0].function.data.value).toBeCloseTo(1.2);
    expect(effects[1].data.ability).toBe(ws2.byEditorId('MyFirebolt'));
  });

  it('gives a new spell the hand slot and sensible casting defaults', async () => {
    const { ws } = await setup();
    const d = blankRecordData(ws, 'SPEL') as any;
    expect(d.name).toBe('New Spell');
    expect(d.data).toMatchObject({ castingType: 1, delivery: 2 });
    expect(blankRecordData(ws, 'LVLI')).toMatchObject({ chanceNone: 0, flags: 1, entries: [] });
    expect(blankRecordData(ws, 'COBJ')).toMatchObject({ createdCount: 1 });
  });
});
