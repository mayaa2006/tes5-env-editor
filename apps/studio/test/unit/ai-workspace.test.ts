import type { FormKey } from '@tes5/esp';
import { describe, expect, it } from 'vitest';
import { MemoryFileSystem, createDemoData, type AgentModel, type AgentReply } from '@tes5/workspace';
import { DEMO_GAME_DIR } from '../../src/engine/constants';
import { EngineHost, type HostEvent } from '../../src/engine/host';
import { aiTools } from '../../src/engine/aitools';

const ORDER = [{ name: 'DemoWorld.esm', active: true }];

async function demo() {
  const fs = new MemoryFileSystem();
  createDemoData(fs, DEMO_GAME_DIR);
  const host = new EngineHost(fs);
  await host.open({ kind: 'demo', path: DEMO_GAME_DIR, loadOrder: ORDER });
  await host.loadPlugins(ORDER.map((p) => p.name));
  return { fs, host };
}

function scripted(replies: AgentReply[]): AgentModel {
  return { name: 'Test AI', free: false, provider: 'test', reply: async (req) => (req.onText?.('…'), replies.shift() ?? { text: 'Done.', calls: [], stop: 'end' }) };
}

describe('the AI workspace tools on the demo data', () => {
  it('every read tool answers with compact data', async () => {
    const { host } = await demo();
    const tools = new Map(aiTools(host).map((t) => [t.name, t]));
    const run = async (name: string, input: unknown) => {
      const t = tools.get(name)!;
      return t.run(t.input.parse(input));
    };
    const found = (await run('search_records', { query: 'innkeeper', kind: 'character' })).data as any;
    expect(found.results[0]).toMatchObject({ editorId: 'DemoInnkeeper', type: 'NPC_' });
    // Every word must match, in any order.
    expect(((await run('search_records', { query: 'tavern demo', kind: 'place' })).data as any).results.some((r: any) => r.editorId === 'DemoTavern')).toBe(true);
    // Everyday words and plurals are understood; an unknown kind searches everything and says so.
    expect(((await run('search_records', { query: 'tavern', kind: 'cell' })).data as any).results.some((r: any) => r.editorId === 'DemoTavern')).toBe(true);
    expect(((await run('search_records', { query: 'innkeeper', kind: 'NPCs' })).data as any).results[0].editorId).toBe('DemoInnkeeper');
    expect(((await run('search_records', { query: 'tankard', kind: 'item' })).data as any).results[0].editorId).toBe('DemoTankard');
    const any = (await run('search_records', { query: 'innkeeper', kind: 'spaceship' })).data as any;
    expect(any.note).toMatch(/isn't a kind I know/);
    expect(any.results[0].editorId).toBe('DemoInnkeeper');
    // Nothing of that kind: what the words match instead, and where to look for who's in a place.
    const none = (await run('search_records', { query: 'tavern', kind: 'character' })).data as any;
    expect(none.total).toBe(0);
    expect(none.note).toMatch(/place_contents/);
    expect(none.otherKinds[0].editorId).toBe('DemoTavern');
    // The kind asked for has only near misses ("Bottle of Mead" as a misc item): records of other kinds with the name are offered too.
    host.createPlugin('Extra.esp', {});
    const potion = host.createBlankRecord('ALCH', 'TestMeadPotion') as FormKey;
    host.ws!.editRecord(potion, (d: any) => void (d.name = 'Mead'), 'Name it');
    const near = (await run('search_records', { query: 'mead', kind: 'misc' })).data as any;
    expect(near.results.map((r: any) => r.editorId)).toEqual(['DemoBottle']);
    expect(near.alsoOtherKinds.map((r: any) => r.editorId)).toContain('TestMeadPotion');
    // No record has every word: the ones with most of them.
    const some = (await run('search_records', { query: 'mead bottle flagon', kind: 'item' })).data as any;
    expect(some.note).toMatch(/Nothing has all the words/);
    expect(some.results[0].editorId).toBe('DemoBottle');
    // place_contents takes kinds in words too; words that aren't kinds are explained.
    const people = (await run('place_contents', { place: 'DemoTavern', kinds: ['characters'] })).data as any;
    expect(Object.keys(people)).toContain('NPC_');
    expect(Object.keys(people)).not.toContain('CONT');
    const tables = (await run('place_contents', { place: 'DemoTavern', kinds: ['TABLE'] })).data as any;
    expect(tables.note).toMatch(/"TABLE" isn't a kind of record.*place_object puts items on them/);
    const rec = await run('read_record', { form: 'DemoInnkeeper' });
    expect((rec.data as any).editorId).toBe('DemoInnkeeper');
    expect(rec.link).toMatchObject({ tab: 'records' });
    await expect(run('read_record', { form: 'NoSuchThing' })).rejects.toThrow(/There's no record "NoSuchThing".*search_records finds them/);
    expect(((await run('load_order', {})).data as any).plugins[0].name).toBe('DemoWorld.esm');
    const places = (await run('list_places', { query: 'tavern', interiorOnly: true })).data as any;
    expect(places.places[0].editorId).toBe('DemoTavern');
    const inside = (await run('place_contents', { place: 'DemoTavern' })).data as any;
    expect(inside.total).toBeGreaterThan(0);
    const quests = (await run('search_records', { query: '', kind: 'quest' })).data as any;
    if (quests.results[0]) {
      const q = await run('quest_overview', { quest: quests.results[0].formKey });
      expect((q.data as any).stages).toBeDefined();
      expect(((await run('quest_dialogue', { quest: quests.results[0].formKey })).data as any).problems).toBeDefined();
    }
    expect(((await run('who_uses', { form: 'DemoTavern' })).data as any).total).toBeGreaterThanOrEqual(0);
    expect(((await run('character_routine', { character: 'DemoInnkeeper' })).data as any)).toBeDefined();
    expect(((await run('list_scripts', { query: '' })).data as any).total).toBeGreaterThanOrEqual(0);
    expect(((await run('items_and_magic', {})).data as any).items).toBeDefined();
    host.createPlugin('Mine.esp', {});
    expect(((await run('release_check', {})).data as any).problems).toBeGreaterThanOrEqual(0);
    expect((await run('conflict_report', {})).data).toBeDefined();
    // Every tool's input can be described to the AI.
    for (const t of tools.values()) expect(() => JSON.stringify(t.input)).not.toThrow();
  });

  it('keeps conversations, streams progress, and saves them next to the plugins', async () => {
    const { fs, host } = await demo();
    const events: HostEvent[] = [];
    host.onEvent((e) => events.push(e));
    host.aiModel = () => scripted([{ text: '', calls: [{ id: 'c1', name: 'search_records', input: { query: 'innkeeper', kind: 'character' } }], stop: 'tools' }, { text: 'Brynja runs the tavern.', calls: [], stop: 'end' }]);
    const s = await host.aiNewSession();
    const r = await host.aiSend(s.id, 'Who runs the tavern?', { kind: 'claude', apiKey: 'k' }, { context: 'Quest open: none' });
    expect(r.error).toBeNull();
    expect(r.session.title).toBe('Who runs the tavern?');
    expect(r.session.turns).toEqual([{ at: 0, title: 'Who runs the tavern?', undoLabel: null, changes: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, provider: 'test' }]);
    const ai = events.filter((e): e is Extract<HostEvent, { type: 'ai' }> => e.type === 'ai').map((e) => e.event.type);
    expect(ai).toContain('result');
    expect(ai.at(-1)).toBe('done');
    const file = `${DEMO_GAME_DIR}/Data/TES5EnvEditor/ai-conversations.json`;
    expect(JSON.parse(new TextDecoder().decode(await fs.readFile(file)))[0].title).toBe('Who runs the tavern?');
    // Reopened: the conversation is still there.
    const again = new EngineHost(fs);
    await again.open({ kind: 'demo', path: DEMO_GAME_DIR, loadOrder: ORDER });
    await again.loadPlugins(['DemoWorld.esm']);
    expect((await again.aiSessionList()).map((x) => x.title)).toEqual(['Who runs the tavern?']);
    expect((await again.aiDeleteSession(s.id))).toEqual([]);
  });

  it("won't run two turns at once in a conversation, and stops when asked", async () => {
    const { host } = await demo();
    let release!: () => void;
    host.aiModel = () => ({ name: 'Slow', free: false, provider: 'test', reply: (req) => new Promise((res, rej) => { release = () => res({ text: 'ok', calls: [], stop: 'end' }); req.signal?.addEventListener('abort', () => rej(new Error('aborted'))); }) });
    const s = await host.aiNewSession();
    const first = host.aiSend(s.id, 'one', 'key');
    await new Promise((r) => setTimeout(r, 0));
    await expect(host.aiSend(s.id, 'two', 'key')).rejects.toThrow(/still working/);
    expect((await host.aiSessionList())[0]!.running).toBe(true);
    host.aiStop(s.id);
    const r = await first;
    expect(r.error).toBeTruthy();
    void release;
  });
});
