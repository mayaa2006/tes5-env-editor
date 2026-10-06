import { describe, expect, it } from 'vitest';
import { MemoryFileSystem, QuestGraphService, QuestPlanner, QuestService, ScriptService, TriggerService, Workspace, applyJournalToPlan, createDemoData, draftJournal, exampleQuestPlan, journalContextFromGraph, journalContextFromPlan, lintJournal, validatePlan, type JournalContext } from '../src';

const ctx = (): JournalContext => ({
  title: 'The Ring',
  stages: [
    { index: 0, journal: '', startsQuest: true, completesQuest: false, failsQuest: false },
    { index: 10, journal: '', startsQuest: false, completesQuest: false, failsQuest: false },
    { index: 20, journal: '', startsQuest: false, completesQuest: false, failsQuest: false },
    { index: 100, journal: '', startsQuest: false, completesQuest: true, failsQuest: false },
  ],
  steps: [
    { from: 0, to: 10, kind: 'talk', target: 'Brynja' },
    { from: 10, to: 20, kind: 'pickup', target: "Brynja's Ring" },
    { from: 20, to: 100, kind: 'talk', target: 'Brynja' },
  ],
  objectives: [],
});

describe('journal writer', () => {
  it('drafts entries and objectives from what moves the quest on', () => {
    const d = draftJournal(ctx());
    expect(d.stages).toEqual([
      { index: 10, journal: "I spoke with Brynja. I should find Brynja's Ring." },
      { index: 20, journal: "I found Brynja's Ring. I should speak to Brynja." },
      { index: 100, journal: 'I spoke with Brynja.' },
    ]);
    expect(d.objectives).toEqual([
      { index: 0, text: 'Speak to Brynja', shownAtStage: 0, completedAtStage: 10 },
      { index: 10, text: "Find Brynja's Ring", shownAtStage: 10, completedAtStage: 20 },
      { index: 20, text: 'Speak to Brynja', shownAtStage: 20, completedAtStage: 100 },
    ]);
  });

  it('keeps what is written unless asked to rewrite it', () => {
    const c = ctx();
    c.stages[1]!.journal = 'Brynja lost her ring.';
    c.objectives.push({ index: 10, text: 'Look for the ring', shownAtStage: 10, completedAtStage: 20 });
    const d = draftJournal(c);
    expect(d.stages.map((s) => s.index)).toEqual([20, 100]);
    expect(d.objectives.map((o) => o.shownAtStage)).toEqual([0, 20]);
    expect(draftJournal(c, { overwrite: true }).objectives.find((o) => o.shownAtStage === 10)).toMatchObject({ index: 10, text: "Find Brynja's Ring" });
  });

  it('checks the wording', () => {
    const c = ctx();
    c.stages[1]!.journal = 'You should find the ring.';
    c.stages[2]!.journal = 'Brynja asked me to look.';
    c.objectives.push({ index: 10, text: 'Find the ring.', shownAtStage: 10, completedAtStage: 20 }, { index: 20, text: 'I need to go back to Brynja and tell her all about the ring I found in the tavern', shownAtStage: null, completedAtStage: null });
    expect(lintJournal(c).map((l) => l.message)).toEqual([
      'Stage 10: the journal speaks to “you”',
      "Stage 10: the journal isn't written as the player (“I …”)",
      'Stage 100 completes the quest but has no journal entry',
      "Objective 10 ends with a full stop (objectives don't)",
      'Objective 20 is long (81 characters) for the screen',
      'Objective 20 should be an instruction (“Find …”), not “I …”',
      'Objective 20 is never shown',
    ]);
  });

  it('works on a plan: talk steps name whoever says the line', () => {
    const p = exampleQuestPlan();
    for (const s of p.stages) s.journal = '';
    p.objectives = [];
    const c = journalContextFromPlan(p);
    expect(c.steps[0]).toMatchObject({ kind: 'talk', target: 'Brynja' });
    const next = applyJournalToPlan(p, draftJournal(c));
    expect(next.stages.find((s) => s.index === 20)!.journal).toBe("I found Brynja's Ring. I should speak to Brynja.");
    expect(next.objectives.find((o) => o.index === 10)).toMatchObject({ text: "Find Brynja's Ring", targetKey: 'ring' });
    expect(validatePlan(next).filter((i) => i.severity === 'error')).toEqual([]);
    expect(validatePlan(p).map((i) => i.message)).toContain('Stage 100 completes the quest but has no journal entry');
  });

  it('works on a quest in the plugin', async () => {
    const fs = new MemoryFileSystem();
    const demo = createDemoData(fs);
    const ws = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir], outputDir: demo.dataDir, loadOrder: [{ name: 'DemoWorld.esm', active: true }] });
    await ws.scan();
    await ws.load();
    ws.createPlugin('J.esp');
    const scripts = new ScriptService(ws);
    scripts.refresh();
    const quests = new QuestService(ws, scripts);
    const graphs = new QuestGraphService(ws, quests, scripts, new TriggerService(ws, scripts));
    const q = quests.createQuest('JQuest', 'Journal Quest');
    quests.addStage(q, 0, '', { startUp: true });
    await graphs.addEdge(q, { from: 0, to: 10, kind: 'pickup', target: ws.byEditorId('DemoTavernChestRef')! });
    await graphs.addEdge(q, { from: 10, to: 20, kind: 'arrive', target: ws.byEditorId('DemoTavern')! });
    const c = journalContextFromGraph(ws, await graphs.graph(q));
    expect(c.title).toBe('Journal Quest');
    expect(draftJournal(c).stages).toEqual([
      { index: 10, journal: 'I found Chest. I should go to The Demo Tavern.' },
      { index: 20, journal: 'I reached The Demo Tavern.' },
    ]);
  });

  it('asks Claude to polish the wording', async () => {
    const sent: any[] = [];
    const planner = new QuestPlanner({ send: async (p) => (sent.push(p), { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ stages: [{ index: 10, journal: 'Brynja asked me to find her ring.' }], objectives: [] }) }] }) });
    const d = await planner.writeJournal(ctx());
    expect(d.stages[0]!.journal).toBe('Brynja asked me to find her ring.');
    expect(sent[0].system[0].text).toContain('first person');
    expect(sent[0].messages[0].content).toContain('"title": "The Ring"');
  });
});
