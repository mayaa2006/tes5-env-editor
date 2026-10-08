import { describe, expect, it } from 'vitest';
import type { FormKey } from '@tes5/esp';
import { DialogueService, EnvironmentService, MemoryFileSystem, NpcService, QuestBuilder, QuestGraphService, QuestService, ScriptService, TriggerService, Workspace, createDemoData, exampleQuestPlan } from '../src';

async function setup() {
  const fs = new MemoryFileSystem();
  const demo = createDemoData(fs);
  const ws = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir], outputDir: demo.dataDir, loadOrder: [{ name: 'DemoWorld.esm', active: true }] });
  await ws.scan();
  await ws.load();
  ws.createPlugin('Upd.esp');
  const scripts = new ScriptService(ws);
  scripts.refresh();
  const quests = new QuestService(ws, scripts);
  const graphs = new QuestGraphService(ws, quests, scripts, new TriggerService(ws, scripts));
  const dialogue = new DialogueService(ws, quests);
  const builder = new QuestBuilder(ws, quests, graphs, dialogue, new NpcService(ws), new EnvironmentService(ws));
  return { ws, quests, graphs, dialogue, builder, k: (e: string) => ws.byEditorId(e)! };
}

describe('updating a quest from a revised plan', () => {
  it('applies only the differences', async () => {
    const { ws, quests, graphs, dialogue, builder, k } = await setup();
    const built = await builder.build(exampleQuestPlan());
    const quest = built.quest!;
    const { plan, fromRecord } = await builder.planFor(quest);
    expect(fromRecord).toBe(true);
    expect(plan).toEqual(exampleQuestPlan());
    const eirikTopicsBefore = dialogue.graph(quest).topics.filter((t) => t.text === 'Have you seen a ring around here?').map((t) => t.formKey);

    // The revision: new journal text, a new stage reached right after 20, a new objective,
    // a reworded conversation, a new character, Eirik joins the merchants, and a gold reward.
    const next = structuredClone(plan);
    next.stages.find((s) => s.index === 10)!.journal = 'Brynja lost her ring somewhere in the tavern.';
    next.stages.push({ index: 30, journal: 'I should tell Brynja.', startsQuest: false, completesQuest: false, failsQuest: false });
    next.steps.push({ from: 20, to: 30, kind: 'script', targetKey: null, note: 'Straight after finding it' });
    next.objectives.push({ index: 30, text: 'Tell Brynja', shownAtStage: 30, completedAtStage: 100, targetKey: 'brynja' });
    next.conversations[0]!.screenplay = next.conversations[0]!.screenplay.replace('Got any work for me?', 'Anything I can help with?');
    next.characters.push({ ...next.characters[1]!, key: 'sigrid', name: 'Sigrid', sex: 'female', voice: 'FemaleCommoner', outfit: null, routine: [], spot: null, look: null, factions: [], inventory: [] });
    next.characters[1]!.factions = [...next.characters[1]!.factions, { faction: 'Merchants', rank: 0 }];
    next.rewards = [{ atStage: 100, gold: 50, itemKey: null }];

    const preview = await builder.previewUpdate(quest, next);
    expect(preview).toEqual(["Rewrite stage 10's journal entry", 'Add stage 30', 'Change Eirik', 'Add Sigrid', 'Update the objectives', 'Add “Straight after finding it”', 'Rewrite the conversation “Brynja”', 'Update the rewards']);
    const undoBefore = ws.undoLabel;
    const r = await builder.update(quest, next);
    expect(r.updated).toEqual([
      "Rewrote stage 10's journal entry",
      'Added stage 30',
      'Changed Eirik: joins Merchants',
      'Added Sigrid',
      'Added objective “Tell Brynja”',
      'Updated when objectives are shown and completed',
      'Rewrote the conversation “Brynja”',
      'Added “Straight after finding it”',
      'Updated the rewards',
    ]);
    const g = await graphs.graph(quest);
    expect(g.nodes.find((n) => n.stage === 10)!.text).toBe('Brynja lost her ring somewhere in the tavern.');
    expect(g.nodes.find((n) => n.stage === 30)).toMatchObject({ shows: [30] });
    expect(g.edges.some((e) => e.from === 20 && e.to === 30 && e.kind === 'script')).toBe(true);
    const texts = dialogue.graph(quest).topics.map((t) => t.text);
    expect(texts).toContain('Anything I can help with?');
    expect(texts).not.toContain('Got any work for me?');
    // Eirik's conversation didn't change, so it's the same records.
    expect(dialogue.graph(quest).topics.filter((t) => t.text === 'Have you seen a ring around here?').map((t) => t.formKey)).toEqual(eirikTopicsBefore);
    expect(ws.byEditorId('InnkeeperRingQuestSigrid')).toBeTruthy();
    expect((ws.view(k('InnkeeperRingQuestEirik'))!.data as any).factions.map((f: any) => f.faction)).toEqual([k('DemoTownFaction'), k('DemoMerchantFaction')]);
    expect(await graphs.fragmentCode(quest, 100)).toContain('AddItem(Game.GetFormFromFile(0x00000F, "Skyrim.esm"), 50)');
    expect(g.problems).toEqual([]);
    expect((await builder.planFor(quest)).plan).toEqual(next);

    // A second update with the same plan changes nothing.
    expect((await builder.update(quest, next)).updated).toEqual(['Nothing needed changing']);
    // Undo takes back the update (and the no-op), leaving the quest as built.
    ws.undo();
    ws.undo();
    expect(ws.undoLabel).toBe(undoBefore);
    expect(dialogue.graph(quest).topics.map((t) => t.text)).toContain('Got any work for me?');
    expect(quests.quest(quest).stages.map((s) => s.index)).toEqual([0, 10, 20, 100]);
    // The record went back too, so the next update compares against the quest as it really is.
    expect((await builder.planFor(quest)).plan).toEqual(exampleQuestPlan());
    ws.redo();
    expect((await builder.planFor(quest)).plan).toEqual(next);
  });

  it('removes stages, steps and conversations that left the plan', async () => {
    const { builder, graphs, dialogue } = await setup();
    const quest = (await builder.build(exampleQuestPlan())).quest!;
    const next = exampleQuestPlan();
    next.conversations = next.conversations.filter((c) => c.title !== 'Eirik');
    next.steps = next.steps.filter((s) => s.kind !== 'pickup');
    next.steps.push({ from: 10, to: 20, kind: 'script', targetKey: null, note: 'Found it' });
    next.animations = [];
    const r = await builder.update(quest, next);
    expect(r.updated).toEqual(['Removed the conversation “Eirik”', 'Removed “The player finds the ring”', 'Added “Found it”', 'Updated the animations at quest stages']);
    const g = await graphs.graph(quest);
    expect(g.edges.map((e) => `${e.from}->${e.to}:${e.kind}`).sort()).toEqual(['0->10:talk', '10->20:script', '20->100:talk']);
    expect(dialogue.graph(quest).topics.map((t) => t.text)).not.toContain('Have you seen a ring around here?');
    expect(g.nodes.find((n) => n.stage === 20)!.gestures).toEqual([]);
  });

  it('adds and removes events at stages', async () => {
    const { builder, graphs, ws } = await setup();
    const quest = (await builder.build(exampleQuestPlan())).quest!;
    const next = exampleQuestPlan();
    next.events = [{ atStage: 20, kind: 'hostile', targetKey: 'eirik', toKey: null, what: null, count: null, note: 'Eirik attacks' }];
    expect(await builder.previewUpdate(quest, next)).toEqual(['Update the events at quest stages']);
    expect((await builder.update(quest, next)).updated).toEqual(['Updated the events at quest stages']);
    expect(await graphs.fragmentCode(quest, 20)).toContain('StartCombat(Game.GetPlayer())');
    next.events = [];
    await builder.update(quest, next);
    expect(await graphs.fragmentCode(quest, 20)).not.toContain('StartCombat');
    // Plans saved before events existed still load.
    const { plan } = await builder.planFor(quest);
    expect(plan.events).toEqual([]);
    ws.undo();
    expect(await graphs.fragmentCode(quest, 20)).toContain('StartCombat(Game.GetPlayer())');
  });

  it('a quest made by hand: read as a plan, updated without losing its dialogue', async () => {
    const { ws, quests, dialogue, builder, k } = await setup();
    const q = quests.createQuest('HandQuest', 'Made by Hand', { startGameEnabled: true });
    quests.addStage(q, 0, '', { startUp: true });
    quests.addStage(q, 10, 'Talked to Brynja.');
    await dialogue.importScreenplay(q, 'PLAYER: Hello\nDemoInnkeeper: Hi. [stage 10]', (info, code, which) => quests.setInfoFragment(info, which, code));
    const { plan, fromRecord } = await builder.planFor(q);
    expect(fromRecord).toBe(false);
    expect(plan.conversations).toEqual([{ title: 'Existing dialogue', screenplay: expect.stringContaining('PLAYER: Hello') }]);
    expect(plan.characters.map((c) => c.existing)).toEqual(['DemoInnkeeper']);
    const next = structuredClone(plan);
    next.stages.push({ index: 100, journal: 'Done.', startsQuest: false, completesQuest: true, failsQuest: false });
    next.conversations = [];
    const r = await builder.update(q, next);
    expect(r.updated).toContain('Added stage 100');
    expect(r.notes).toContain('“Existing dialogue” was left as it is: it wasn\'t made from a plan, so it isn\'t removed automatically.');
    expect(dialogue.graph(q).topics.map((t) => t.text)).toEqual(['Hello']);
    expect((await builder.record(q))!.plan.stages.map((s) => s.index)).toEqual([0, 10, 100]);
    expect(k('HandQuest')).toBe(q);
  });
});

export type { FormKey };
