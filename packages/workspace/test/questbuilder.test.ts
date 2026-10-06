import { describe, expect, it } from 'vitest';
import type { FormKey } from '@tes5/esp';
import {
  DialogueService,
  EnvironmentService,
  MemoryFileSystem,
  NpcService,
  QuestBuilder,
  QuestGraphService,
  QuestPlanner,
  QuestService,
  ScriptService,
  TriggerService,
  WorldService,
  Workspace,
  createDemoData,
  exampleQuestPlan,
  planCatalog,
  rewriteScreenplay,
  validatePlan,
  type PlannerReply,
} from '../src';

async function setup() {
  const fs = new MemoryFileSystem();
  const demo = createDemoData(fs);
  const ws = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir], outputDir: demo.dataDir, loadOrder: [{ name: 'DemoWorld.esm', active: true }] });
  await ws.scan();
  await ws.load();
  ws.createPlugin('Built.esp');
  const scripts = new ScriptService(ws);
  scripts.refresh();
  const quests = new QuestService(ws, scripts);
  const graphs = new QuestGraphService(ws, quests, scripts, new TriggerService(ws, scripts));
  const dialogue = new DialogueService(ws, quests);
  const builder = new QuestBuilder(ws, quests, graphs, dialogue, new NpcService(ws), new EnvironmentService(ws));
  return { ws, scripts, quests, graphs, dialogue, builder, world: new WorldService(ws) };
}

describe('quest plan', () => {
  it('the example plan is valid', () => {
    expect(validatePlan(exampleQuestPlan())).toEqual([]);
  });

  it('catches broken references', () => {
    const p = exampleQuestPlan();
    p.items[0]!.startsAtKey = 'nowhere';
    p.steps.push({ from: 20, to: 300, kind: 'death', targetKey: 'ring', note: 'Kill the ring' });
    p.characters.push({ ...p.characters[1]!, name: 'Twin' });
    const msgs = validatePlan(p).map((i) => i.message);
    expect(msgs).toContain('Brynja\'s Ring starts in "nowhere", which isn\'t a location in the plan');
    expect(msgs).toContain('A step sets stage 300, which doesn\'t exist');
    expect(msgs.some((m) => /Kill the ring.*character key/.test(m))).toBe(true);
    expect(msgs).toContain('The key "eirik" is used twice');
  });
});

describe('quest builder', () => {
  it('shows what each entry will use before building', async () => {
    const { builder } = await setup();
    const r = builder.resolve(exampleQuestPlan());
    expect(r.find((x) => x.key === 'brynja')).toMatchObject({ existing: expect.stringContaining('DemoWorld.esm'), text: 'Uses Brynja (DemoInnkeeper)' });
    expect(r.find((x) => x.key === 'eirik')!.text).toMatch(/^New, copied from (Halvar the Smith|Town Guard)/);
    expect(r.find((x) => x.key === 'tavern')!.existing).toBeTruthy();
    expect(r.find((x) => x.key === 'ring')!.text).toMatch(/^New, copied from/);
  });

  it('builds the whole quest from the example plan', async () => {
    const { ws, builder, graphs, quests, scripts, world, dialogue } = await setup();
    const report = await builder.build(exampleQuestPlan());
    const k = (e: string) => ws.byEditorId(e)!;
    expect(report.editorId).toBe('InnkeeperRingQuest');

    // A new character, copied from a man, renamed, placed in the tavern, with no routine from the original.
    const eirik = k('InnkeeperRingQuestEirik');
    const ed = ws.view(eirik)!.data as any;
    expect(ed.name).toBe('Eirik');
    expect(ed.config.flags & 1).toBe(0);
    expect(ed.config.flags & 0x20).toBe(0x20);
    expect(ed.packages).toBeUndefined();
    expect(ws.summary(ed.voice)!.editorId).toBe('MaleCommoner');
    const tavernRefs = world.references(k('DemoTavern'));
    expect(tavernRefs.some((r) => r.base === eirik)).toBe(true);

    // The ring, on a table, resting on it.
    const ring = k('InnkeeperRingQuestBrynjaSRing');
    expect((ws.view(ring)!.data as any).name).toBe("Brynja's Ring");
    const ringRef = tavernRefs.find((r) => r.base === ring)!;
    expect(ringRef.persistent).toBe(true);
    expect(ringRef.transform.position.z).toBeGreaterThan(70);
    expect(ringRef.transform.position.z).toBeLessThan(90);

    // Stages, journal, objectives.
    const g = await graphs.graph(report.quest);
    expect(g.startGameEnabled).toBe(true);
    expect(g.nodes.map((n) => n.stage)).toEqual([0, 10, 20, 100]);
    expect(g.nodes.find((n) => n.stage === 10)!.text).toContain('lost her mother’s ring');
    expect(g.nodes.find((n) => n.stage === 100)!.completesQuest).toBe(true);
    expect(g.nodes.find((n) => n.stage === 20)).toMatchObject({ shows: [20], completes: [10] });
    expect(g.objectives.map((o) => o.text)).toEqual(['Find Brynja’s ring', 'Return the ring to Brynja']);
    const q = quests.quest(report.quest);
    expect(q.aliases.map((a) => a.name).sort()).toEqual(['DemoInnkeeper', 'InnkeeperRingQuestBrynjaSRingRef']);

    // What moves it on: Brynja's lines, then picking up the ring, then Brynja again.
    expect(g.edges.map((e) => `${e.from}->${e.to}:${e.kind}`).sort()).toEqual(['0->10:talk', '10->20:pickup', '20->100:talk']);
    expect(g.problems).toEqual([]);
    expect(report.problems).toEqual([]);

    // Dialogue: speakers resolved to the real characters, the ring and gold change hands.
    const d = dialogue.graph(report.quest);
    expect(d.infos.some((i) => i.speaker === eirik && i.needsStage === 10)).toBe(true);
    const thanks = d.infos.find((i) => i.lines[0]?.startsWith('Oh, thank the gods'))!;
    expect(thanks.speaker).toBe(k('DemoInnkeeper'));
    const frag = (ws.view(thanks.formKey)!.data as any).scripts.fragments.fileName as string;
    const src = await scripts.read(frag);
    expect(src).toContain('GetOwningQuest().SetStage(100)');
    expect(src).toMatch(/Game\.GetPlayer\(\)\.RemoveItem\(Game\.GetFormFromFile\(0x[0-9A-F]{6}, "Built\.esp"\), 1\)/);
    expect(src).toContain('Game.GetPlayer().AddItem(Game.GetFormFromFile(0x00000F, "Skyrim.esm"), 100)');

    expect(report.created.map((c) => c.kind).sort()).toEqual(['character', 'item', 'placed', 'placed', 'quest']);
    expect(report.reused.map((r) => r.label).sort()).toEqual(['Brynja (DemoInnkeeper)', 'The Demo Tavern (DemoTavern)']);
    expect(report.notes.some((n) => n.includes('Ctrl+F4'))).toBe(true);

    // One undo step takes it all away.
    expect(ws.undoLabel).toBe('Build quest InnkeeperRingQuest');
    ws.undo();
    expect(ws.byEditorId('InnkeeperRingQuest')).toBeUndefined();
    expect(ws.byEditorId('InnkeeperRingQuestEirik')).toBeUndefined();
  });

  it('makes new places and items, rewards, and says what it could not do', async () => {
    const { ws, builder, graphs, world } = await setup();
    const plan = exampleQuestPlan();
    plan.editorId = 'CellarQuest';
    plan.locations.push({ key: 'cellar', name: 'Old Cellar', existing: null, description: 'Under the tavern' });
    plan.characters[1]!.locationKey = 'cellar';
    plan.items.push({ key: 'note', name: 'Crumpled Note', kind: 'book', existing: null, value: 1, startsWith: 'character', startsAtKey: 'eirik' });
    plan.items.push({ key: 'charm', name: 'Lucky Charm', kind: 'misc', existing: null, value: 10, startsWith: 'player', startsAtKey: null });
    plan.rewards.push({ atStage: 100, gold: 25, itemKey: 'charm' });
    plan.steps.push({ from: 10, to: 20, kind: 'read', targetKey: 'note', note: 'Read the note' });
    plan.steps.push({ from: 0, to: 10, kind: 'talk', targetKey: null, note: 'duplicate' });
    plan.steps.push({ from: 20, to: 20, kind: 'talk', targetKey: null, note: 'Nobody says this' });
    plan.stages.push({ index: 50, journal: '', startsQuest: false, completesQuest: false, failsQuest: false });
    plan.steps.push({ from: 20, to: 50, kind: 'talk', targetKey: null, note: 'Mention the cellar' });
    const r = await builder.build(plan, { seed: 7 });
    const cell = ws.byEditorId('CellarQuestOldCellar')!;
    expect(world.references(cell).map((x) => ws.summary(x.base!)?.name)).toEqual(['Eirik']);
    expect(r.notes.some((n) => n.includes('Old Cellar is a new, empty interior'))).toBe(true);
    const eirik = ws.byEditorId('CellarQuestEirik')!;
    const note = ws.byEditorId('CellarQuestCrumpledNote')!;
    expect((ws.view(eirik)!.data as any).items).toEqual([{ item: { item: note, count: 1 } }]);
    // Fallback: there's no book in the demo to copy, so it's a misc item.
    expect(ws.summary(note)!.sig).toBe('MISC');
    expect(r.notes.some((n) => n.includes('Crumpled Note should be a book'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('“Read the note” (read) can\'t be detected'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('Nothing said in a conversation sets stage 50'))).toBe(true);
    const start = await graphs.fragmentCode(r.quest, 0);
    expect(start).toMatch(/Game\.GetPlayer\(\)\.AddItem\(Game\.GetFormFromFile\(0x[0-9A-F]{6}, "Built\.esp"\), 1\)/);
    const end = await graphs.fragmentCode(r.quest, 100);
    expect(end).toContain('SetObjectiveCompleted(20)');
    expect(end).toContain('AddItem(Game.GetFormFromFile(0x00000F, "Skyrim.esm"), 25)');
    expect(r.problems).toContain('Nothing leads to stage 50.');
  });

  it('refuses plans that would not build, and changes nothing', async () => {
    const { ws, builder } = await setup();
    const undo = ws.undoLabel;
    const plan = exampleQuestPlan();
    plan.characters[0]!.existing = 'NoSuchPerson';
    plan.characters[0]!.name = 'Nobody';
    await expect(builder.build(plan)).rejects.toThrow(/Nobody: no character called “NoSuchPerson”/);
    expect(ws.byEditorId('InnkeeperRingQuest')).toBeUndefined();
    expect(ws.undoLabel).toBe(undo);
  });

  it('turns plan keys into Editor IDs in screenplays', () => {
    const out = rewriteScreenplay('PLAYER: Hi [if stage 10]\nBRYNJA: Here. [gives ring x2] [takes gold x5]\n  EIRIK: Hm. [gives Unknown]', new Map([['brynja', 'DemoInnkeeper'], ['eirik', 'QEirik']]), new Map([['ring', 'QRing']]));
    expect(out).toBe('PLAYER: Hi [if stage 10]\nDemoInnkeeper: Here. [gives QRing x2] [takes gold x5]\n  QEirik: Hm. [gives Unknown]');
  });
});

describe('quest planner', () => {
  const reply = (text: string, stop: string = 'end_turn'): PlannerReply => ({ content: [{ type: 'thinking' }, { type: 'text', text }], stop_reason: stop });

  it('asks Claude for a structured plan, with the rules and load order cached', async () => {
    const { ws } = await setup();
    const sent: any[] = [];
    const planner = new QuestPlanner({ send: async (p) => (sent.push(p), reply(JSON.stringify(exampleQuestPlan()))) });
    const catalog = planCatalog(ws);
    expect(catalog).toContain('DemoInnkeeper "Brynja"');
    expect(catalog).toContain('DemoTavern "The Demo Tavern"');
    expect(catalog).toContain('FemaleCommoner');
    const plan = await planner.plan('Brynja lost her ring.', 'conversation', catalog);
    expect(plan.title).toBe("The Innkeeper's Ring");
    const p = sent[0];
    expect(p.model).toBe('claude-opus-5-5');
    expect(p.thinking).toEqual({ type: 'adaptive' });
    expect(p.output_config.effort).toBe('high');
    expect(p.output_config.format.type).toBe('json_schema');
    expect(p.fallbacks).toBe('default');
    expect(p.system[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(p.system[1].text).toContain('DemoInnkeeper');
    expect(p.messages[0].content).toContain('There are no tags in it');
    expect(p.messages[0].content).toContain('<source>\nBrynja lost her ring.\n</source>');
  });

  it('revises a plan with the author’s feedback', async () => {
    const sent: any[] = [];
    const changed = { ...exampleQuestPlan(), title: 'The Stolen Ring' };
    const planner = new QuestPlanner({ send: async (p) => (sent.push(p), reply(JSON.stringify(changed))) });
    const plan = await planner.revise(exampleQuestPlan(), 'Eirik stole it', 'catalog', 'the doc');
    expect(plan.title).toBe('The Stolen Ring');
    expect(sent[0].messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(sent[0].messages[2].content).toContain('Eirik stole it');
  });

  it('explains failures in plain words', async () => {
    const fail = (r: PlannerReply) => new QuestPlanner({ send: async () => r }).plan('x', 'document', '');
    await expect(fail(reply('', 'refusal'))).rejects.toThrow(/declined/);
    await expect(fail(reply('{"title":', 'max_tokens'))).rejects.toThrow(/too long/);
    await expect(fail(reply('not json'))).rejects.toThrow(/wasn't a plan/);
    await expect(fail(reply('{"title":"x"}'))).rejects.toThrow(/incomplete/);
    expect(() => new QuestPlanner({})).toThrow(/API key/);
  });

  it('fixes small slips and asks once to repair a plan that does not fit', async () => {
    const odd = exampleQuestPlan() as any;
    odd.characters[1].sex = 'Male';
    const sent: any[] = [];
    const broken = { ...exampleQuestPlan(), stages: 'none' };
    const answers = [JSON.stringify(broken), JSON.stringify(odd)];
    const planner = new QuestPlanner({ send: async (p) => (sent.push(p), reply(answers.shift()!)) });
    const plan = await planner.plan('doc', 'document', '');
    expect(plan.characters[1]!.sex).toBe('male');
    expect(sent).toHaveLength(2);
    expect(sent[1].messages.at(-1).content).toMatch(/^That plan doesn't match the format:\nstages:/);
  });
});

export type { FormKey };
