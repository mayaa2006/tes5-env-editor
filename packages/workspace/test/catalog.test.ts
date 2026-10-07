import { describe, expect, it } from 'vitest';
import { CATALOG, MemoryFileSystem, Workspace, catalogCounts, catalogList, categoryFor, createBlankRecord, createDemoData, createInCategory, summarize, titleFromSummary } from '../src';

async function setup() {
  const fs = new MemoryFileSystem();
  const demo = createDemoData(fs);
  const ws = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir], outputDir: demo.dataDir, loadOrder: [{ name: 'DemoWorld.esm', active: true }] });
  await ws.scan();
  await ws.load();
  ws.createPlugin('Catalog.esp');
  return ws;
}

describe('Items and Magic catalog', () => {
  it('splits spells by kind, and new records start with their category\'s values', async () => {
    const ws = await setup();
    const spell = createInCategory(ws, 'spells');
    const power = createInCategory(ws, 'powers');
    const ability = createInCategory(ws, 'abilities');
    expect((ws.view(power)!.data as any).data).toMatchObject({ type: 2, delivery: 0 });
    expect(ws.view(power)!.data.name).toBe('New Power');
    expect((ws.view(ability)!.data as any).data).toMatchObject({ type: 4, castingType: 0 });
    const counts = Object.fromEntries(catalogCounts(ws, 'magic').map((c) => [c.id, c.count]));
    expect(counts).toMatchObject({ spells: 1, powers: 1, abilities: 1, afflictions: 0 });
    expect(catalogList(ws, 'powers').items.map((i) => i.formKey)).toEqual([power]);
    expect(catalogList(ws, 'spells').items[0]).toMatchObject({ formKey: spell, title: 'New Spell', summary: 'Spell · Fire and forget · Aimed · 0 magicka' });
    expect(categoryFor('SPEL', ws.view(ability)!.data)?.id).toBe('abilities');
    // Every category belongs to a tab and has help.
    for (const c of CATALOG) expect(c.help.length).toBeGreaterThan(10);
  });

  it('finds recipes by what they make, and titles them that way', async () => {
    const ws = await setup();
    const misc = ws.search({ sigs: ['MISC'], limit: 1 }).items[0]!;
    const recipe = createBlankRecord(ws, 'COBJ', 'MyRecipe');
    ws.updateRecord(recipe, { ...(ws.view(recipe)!.data as any), createdObject: misc.formKey, items: [{ item: { item: misc.formKey, count: 2 } }] });
    const summary = summarize(ws, 'COBJ', ws.view(recipe)!.data);
    expect(summary).toContain(`Makes ${misc.name ?? misc.editorId}`);
    const found = catalogList(ws, 'recipes', (misc.name ?? misc.editorId!).toLowerCase());
    expect(found.items.map((i) => i.formKey)).toContain(recipe);
    expect(found.items.find((i) => i.formKey === recipe)!.title).toBe(`${misc.name ?? misc.editorId} recipe`);
    expect(titleFromSummary('COBJ', 'Makes Iron Sword · at Grindstone (improve weapons) · 1 component')).toBe('Improve Iron Sword');
    // Searching ignores spaces in Editor IDs: "my recipe" finds MyRecipe.
    expect(catalogList(ws, 'recipes', 'my recipe').items.map((i) => i.formKey)).toContain(recipe);
  });

  it('describes items in plain words', async () => {
    const ws = await setup();
    const list = createBlankRecord(ws, 'LVLI');
    expect(summarize(ws, 'LVLI', { ...ws.view(list)!.data, chanceNone: 25, entries: [{}, {}] })).toBe('2 entries · 25% chance of nothing');
    expect(summarize(ws, 'WEAP', { data: { value: 25, weight: 9, damage: 7 }, stats: { animationType: 1 } })).toBe('One-handed sword · 7 damage · 25 gold · weight 9');
    expect(summarize(ws, 'ALCH', { data: { flags: 2, value: 5 }, effects: [{}, {}] })).toBe('Food · 2 effects · 5 gold');
  });
});
