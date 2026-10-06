import { describe, expect, it } from 'vitest';
import { MemoryFileSystem, QuestGraphService, QuestService, ScriptService, TriggerService, Workspace, createDemoData } from '../src';

async function setup() {
  const fs = new MemoryFileSystem();
  const demo = createDemoData(fs);
  const ws = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir], outputDir: demo.dataDir, loadOrder: [{ name: 'DemoWorld.esm', active: true }] });
  await ws.scan();
  await ws.load();
  ws.createPlugin('Map.esp');
  const scripts = new ScriptService(ws);
  scripts.refresh();
  const quests = new QuestService(ws, scripts);
  const triggers = new TriggerService(ws, scripts);
  return { ws, scripts, quests, triggers, graph: new QuestGraphService(ws, quests, scripts, triggers) };
}

describe('quest map', () => {
  it('builds a quest from connections and reads it back', async () => {
    const { ws, quests, graph, scripts } = await setup();
    const k = (e: string) => ws.byEditorId(e)!;
    const q = quests.createQuest('CellarQuest', 'The Missing Mead', { startGameEnabled: true });
    quests.addStage(q, 0, '', { startUp: true });
    quests.addObjective(q, 10, 'Find the cellar key');
    quests.addObjective(q, 20, 'Search the cellar');

    await graph.addEdge(q, { from: 0, to: 10, kind: 'talk', npc: k('DemoInnkeeper'), playerText: 'Any work?', npcText: ['A crate of mead went missing.', 'Find it.'] });
    await graph.addEdge(q, { from: 10, to: 20, kind: 'pickup', target: k('DemoTavernChestRef') });
    await graph.addEdge(q, { from: 20, to: 30, kind: 'arrive', target: k('DemoTavern') });
    await graph.addEdge(q, { from: 30, to: 40, kind: 'death', target: k('DemoGuard') });
    await graph.addEdge(q, { from: 40, to: 100, kind: 'script' });
    await graph.setStageObjectives(q, 10, [10], []);
    await graph.setStageObjectives(q, 20, [20], [10]);

    const g = await graph.graph(q);
    expect(g.nodes.map((n) => n.stage)).toEqual([0, 10, 20, 30, 40, 100]);
    const byTo = Object.fromEntries(g.edges.map((e) => [e.to, e]));
    expect(byTo[10]).toMatchObject({ from: 0, kind: 'talk' });
    expect(byTo[10]!.label).toContain('Any work?');
    expect(byTo[20]).toMatchObject({ from: 10, kind: 'pickup', target: k('DemoTavernChestRef') });
    expect(byTo[30]).toMatchObject({ from: 20, kind: 'arrive' });
    expect(byTo[40]).toMatchObject({ from: 30, kind: 'death', target: k('DemoGuard') });
    expect(byTo[100]).toMatchObject({ from: 40, kind: 'script' });
    expect(g.nodes.find((n) => n.stage === 20)).toMatchObject({ shows: [20], completes: [10] });
    // Aliases were created (and reused) for the targets.
    expect(g.aliases.map((a) => a.name)).toEqual(expect.arrayContaining(['DemoTavernChestRef', 'DemoGuard', 'CellarQuestArriveDemoTavernMarker']));
    expect(g.problems).toEqual(['No stage completes or shuts down the quest.']);

    // Everything generated is valid Papyrus as far as the language service can tell.
    for (const s of scripts.list().filter((x) => x.origin === 'mod' && /Cellar/.test(x.name))) {
      const errs = (await scripts.check(await scripts.read(s.name))).filter((d) => d.severity === 'error');
      expect(errs, s.name).toEqual([]);
    }

    // Removing connections removes what they created.
    await graph.removeEdge(q, byTo[20]!);
    await graph.removeEdge(q, byTo[10]!);
    await graph.removeEdge(q, byTo[100]!);
    const g2 = await graph.graph(q);
    expect(g2.edges.map((e) => e.to).sort()).toEqual([30, 40]);
    expect(quests.topics(q)).toEqual([]);
    expect(g2.problems).toEqual(expect.arrayContaining(['Nothing leads to stage 10.']));

    // Undo restores both the records and the generated scripts, step by step.
    ws.undo();
    expect((await graph.graph(q)).edges.find((e) => e.to === 100)).toMatchObject({ kind: 'script', from: 40 });
    ws.undo();
    expect((await graph.graph(q)).edges.some((e) => e.kind === 'talk')).toBe(true);
    ws.undo();
    expect((await graph.graph(q)).edges.find((e) => e.to === 20)?.kind).toBe('pickup');
    ws.redo();
    expect((await graph.graph(q)).edges.some((e) => e.to === 20)).toBe(false);
    await ws.save();
  });

  it('remembers node positions', async () => {
    const { ws, quests, graph } = await setup();
    const q = quests.createQuest('LayoutQuest', 'Layout');
    await graph.saveLayout(q, { 'stage:10': { x: 5, y: 6 } });
    expect((await graph.graph(q)).layout).toEqual({ 'stage:10': { x: 5, y: 6 } });
    void ws;
  });
});
