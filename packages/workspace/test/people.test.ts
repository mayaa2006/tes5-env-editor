import { describe, expect, it } from 'vitest';
import type { FormKey } from '@tes5/esp';
import { DEFAULT_CRIME, MemoryFileSystem, Workspace, catalogCounts, catalogList, categoryFor, createDemoData, createInCategory, factionMembers, readCrimeValues, setFactionRank, writeCrimeValues } from '../src';

async function setup() {
  const fs = new MemoryFileSystem();
  const demo = createDemoData(fs);
  const ws = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir], outputDir: demo.dataDir, loadOrder: [{ name: 'DemoWorld.esm', active: true }] });
  await ws.scan();
  await ws.load();
  ws.createPlugin('People.esp');
  return ws;
}

describe('factions, classes, leveled characters and relationships', () => {
  it('lists them by category, and new ones start with values like Skyrim\'s', async () => {
    const ws = await setup();
    const before = Object.fromEntries(catalogCounts(ws, 'people').map((c) => [c.id, c]));
    expect(Object.keys(before)).toEqual(['factions', 'classes', 'leveledchars', 'relationships']);
    expect(Object.values(before).every((c) => c.creatable)).toBe(true);

    const faction = createInCategory(ws, 'factions');
    expect(ws.view(faction)!.data).toMatchObject({ name: 'New Faction', flags: 0 });
    const cls = createInCategory(ws, 'classes');
    expect((ws.view(cls)!.data as any).data).toMatchObject({ teaches: 0, maxTrainingLevel: 0, healthWeight: 1, magickaWeight: 1, staminaWeight: 1, bleedoutDefault: expect.closeTo(0.1, 5) });
    expect((ws.view(cls)!.data as any).data.skillWeights).toHaveLength(18);
    const rel = createInCategory(ws, 'relationships');
    expect((ws.view(rel)!.data as any).data).toMatchObject({ parent: null, child: null, rank: 3 });
    expect(categoryFor('RELA')?.tab).toBe('people');

    // Summaries in plain words.
    const npcs = ws.search({ sigs: ['NPC_'], limit: 2 }).items;
    ws.editRecord(rel, (d: any) => void (d.data = { ...d.data, parent: npcs[0]!.formKey, child: npcs[1]!.formKey, rank: 5, flags: 0x80 }));
    const row = catalogList(ws, 'relationships').items.find((i) => i.formKey === rel)!;
    expect(row.summary).toBe('rival · secret');
    expect(row.title).toBe(`${npcs[0]!.name} and ${npcs[1]!.name}`);
    // Found by who it's between.
    expect(catalogList(ws, 'relationships', npcs[1]!.name!.toLowerCase()).items.map((i) => i.formKey)).toContain(rel);

    ws.editRecord(cls, (d: any) => void (d.data = { ...d.data, skillWeights: d.data.skillWeights.map((_: number, i: number) => (i === 0 ? 3 : i === 5 ? 2 : 0)), teaches: 4, maxTrainingLevel: 75 }));
    expect(catalogList(ws, 'classes').items.find((i) => i.formKey === cls)!.summary).toBe('Best at One-handed, Heavy armor · trains Smithing to 75');
    ws.editRecord(faction, (d: any) => void Object.assign(d, { flags: 0x4040, ranks: [{ number: 0, maleTitle: 'Initiate', femaleTitle: 'Initiate' }], relations: [{ faction: null, modifier: 0, reaction: 1 }] }));
    expect(catalogList(ws, 'factions').items.find((i) => i.formKey === faction)!.summary).toBe('Shop · Tracks crime · 1 rank · 1 enemy');
  });

  it('finds who is in a faction, and puts people in, re-ranks them and takes them out', async () => {
    const ws = await setup();
    const town = ws.byEditorId('DemoTownFaction') as FormKey;
    const first = factionMembers(ws, town);
    expect(first.total).toBeGreaterThan(0);
    expect(first.members.every((m) => !m.inActive)).toBe(true);
    const merchants = ws.byEditorId('DemoMerchantFaction') as FormKey;
    expect(factionMembers(ws, merchants).total).toBe(0);
    const someone = first.members[first.members.length - 1]!.formKey;

    setFactionRank(ws, someone, merchants, 2);
    expect(factionMembers(ws, merchants).members).toEqual([expect.objectContaining({ formKey: someone, rank: 2, inActive: true })]);
    setFactionRank(ws, someone, merchants, 1);
    expect(factionMembers(ws, merchants).members[0]!.rank).toBe(1);
    // Overridden in your plugin, they're listed first in their other faction too, still there.
    let now = factionMembers(ws, town);
    expect(now.total).toBe(first.total);
    expect(now.members[0]).toMatchObject({ formKey: someone, inActive: true });

    // Taking someone from the master out overrides them in your plugin; undo puts them back.
    const member = first.members[0]!.formKey;
    setFactionRank(ws, member, town, null);
    now = factionMembers(ws, town);
    expect(now.members.map((m) => m.formKey)).not.toContain(member);
    ws.undo();
    expect(factionMembers(ws, town).members.map((m) => m.formKey)).toContain(member);
  });

  it('reads and writes crime gold the way Skyrim stores it', () => {
    // CrimeFactionWhiterun's block in Skyrim.esm.
    const whiterun = new Uint8Array([1, 1, 232, 3, 40, 0, 5, 0, 25, 0, 0, 63, 0, 0, 0, 63, 100, 0, 232, 3]);
    const c = readCrimeValues(whiterun)!;
    expect(c).toEqual({ ...DEFAULT_CRIME });
    // Bytes it doesn't know (10–11) are kept; values are written in place.
    const edited = writeCrimeValues({ ...c, murder: 2000, stealMult: 1.5 }, whiterun);
    expect(readCrimeValues(edited)).toMatchObject({ murder: 2000, stealMult: 1.5, assault: 40 });
    expect([...edited.slice(10, 12)]).toEqual([0, 63]);
    // A shorter, older block keeps its length and has no escape or werewolf bounty.
    const short = readCrimeValues(whiterun.slice(0, 16))!;
    expect(short.escape).toBeUndefined();
    expect(writeCrimeValues({ ...short, murder: 500 }, whiterun.slice(0, 16)).byteLength).toBe(16);
    // A new block starts with the holds' values.
    expect(readCrimeValues(writeCrimeValues({ ...DEFAULT_CRIME, assault: 10 }))).toMatchObject({ assault: 10, murder: 1000, escape: 100 });
  });
});
