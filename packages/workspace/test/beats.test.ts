import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DialogueService,
  EnvironmentService,
  MemoryFileSystem,
  NpcService,
  QuestBuilder,
  QuestGraphService,
  QuestService,
  ScriptService,
  TriggerService,
  Workspace,
  beatOrder,
  checkBeats,
  compileBeats,
  createDemoData,
  findDialogue,
  parseScreenplay,
  splitQuestline,
  validatePlan,
  type BeatSheet,
} from '../src';

const CARTOGRAPHER = readFileSync(join(import.meta.dirname, '../../../apps/studio/test/models/questline-cartographer.md'), 'utf8');

/** Quest 1 of the Cartographer, as the AI should read it. */
function lines(): BeatSheet {
  return {
    title: 'Lines on a Map',
    editorId: 'LinesOnAMap',
    summary: "Hesta Coldwater's map pages were stolen; the player finds them in Embershard Mine.",
    start: { kind: 'read', target: 'notice' },
    people: [
      { key: 'hesta', name: 'Hesta Coldwater', existing: null, description: 'A Nord cartographer in her fifties', sex: 'female', race: 'Nord', place: 'inn', spot: 'the table by the fire', essential: true, hostile: false, quote: 'Hesta Coldwater: a Nord cartographer in her fifties.' },
      { key: 'lucan', name: 'Lucan Valerius', existing: 'LucanValerius', description: 'Runs the Riverwood Trader', sex: null, race: null, place: null, spot: null, essential: null, hostile: false, quote: 'Lucan Valerius (Riverwood Trader)' },
    ],
    places: [
      { key: 'inn', name: 'Sleeping Giant Inn', existing: 'RiverwoodSleepingGiantInn', description: 'The inn in Riverwood', quote: 'the Sleeping Giant Inn' },
      { key: 'mine', name: 'Embershard Mine', existing: 'EmbershardMine01', description: 'A mine full of bandits', quote: 'The thieves fled into Embershard Mine' },
    ],
    items: [
      { key: 'notice', name: 'Wanted Notice', kind: 'book', existing: null, place: 'inn', carriedBy: null, spot: 'on the bar', count: 1, text: 'WANTED: A sure-footed guide with a strong stomach.', lockedWith: null, quote: 'a notice pinned to the bar' },
      { key: 'pages', name: 'Torn Map Page', kind: 'misc', existing: null, place: 'mine', carriedBy: null, spot: 'by the forge; in a chest; on a table near the back', count: 3, text: null, lockedWith: null, quote: 'three Torn Map Pages are scattered in the mine' },
    ],
    groups: [],
    beats: [
      { id: 'job', does: 'talk', target: 'hesta', after: [], quote: 'When the player takes the job', journal: "Hesta Coldwater's maps were stolen and the thieves fled into Embershard Mine.", objective: null, ends: null, effects: {} },
      { id: 'find', does: 'pickup', target: 'pages', count: 3, after: ['job'], quote: 'The player has to find all three pages.', journal: "I've found all three of Hesta's map pages.", objective: "Find Hesta's three map pages", ends: null, effects: {} },
      { id: 'return', does: 'talk', target: 'hesta', after: ['find'], quote: 'Once they have all three, the objective changes to returning to Hesta.', journal: 'Hesta has her pages back, and paid me for my trouble.', objective: 'Return the pages to Hesta', ends: 'complete', effects: { takes: [{ item: 'pages', count: 3 }], gold: 150 } },
    ],
    dialogue: [
      {
        block: 1,
        when: null,
        lines: [
          { line: 6, beat: 'job' },
          { line: 8, beat: 'job', effects: { remembers: 'persuaded' } },
          { line: 16, beat: 'job' },
        ],
      },
      { block: 2, when: 'job', lines: [{ line: 3, effects: { remembers: 'promised' } }] },
      { block: 3, when: 'job', lines: [] },
      { block: 4, when: 'find', lines: [{ line: 3, beat: 'return', variants: [{ if: [{ kind: 'choice', name: 'persuaded' }], effects: { gold: 250 } }] }] },
      { block: 5, when: null, lines: [] },
    ],
    lines: [],
  };
}

const quest1 = () => findDialogue(splitQuestline(CARTOGRAPHER)!.parts[0]!.text).blocks;

describe('beat sheets', () => {
  it("turn into a plan whose stages, steps and dialogue tags all come from the same beats", () => {
    const sheet = lines();
    const blocks = quest1();
    expect(checkBeats(sheet, { blocks })).toEqual([]);
    const plan = compileBeats(sheet, blocks);
    expect(validatePlan(plan).filter((i) => i.severity === 'error')).toEqual([]);
    expect(plan.stages.map((s) => [s.index, s.completesQuest])).toEqual([
      [0, false],
      [10, false],
      [20, false],
      [30, true],
    ]);
    expect(plan.steps.map((s) => `${s.from}→${s.to} ${s.kind} ${s.targetKey ?? ''} ${s.count ?? ''}`.trim())).toEqual(['0→10 talk hesta', '10→20 pickup pages 3', '20→30 talk hesta']);
    expect(plan.startsWhen).toMatchObject({ kind: 'read', targetKey: 'notice' });
    expect(plan.objectives.map((o) => [o.text, o.shownAtStage, o.completedAtStage])).toEqual([
      ["Find Hesta's three map pages", 10, 20],
      ['Return the pages to Hesta', 20, 30],
    ]);
    // Every line the author wrote, word for word; the ones that do something carry it.
    const hesta = plan.conversations.find((c) => c.title === '✎ Hesta Coldwater')!.screenplay;
    expect(parseScreenplay(hesta).errors).toEqual([]);
    const row = (start: string) => hesta.split('\n').filter((r) => r.trim().startsWith(start));
    expect(row('HESTA: The case will be ruined')[0]).toMatch(/\[stage 10\]/);
    expect(row('HESTA: Ha. Fine. 250')[0]).toMatch(/\[stage 10\].*\[remember persuaded\]/);
    expect(row("HESTA: Good. I'll hold you to it.")[0]).toMatch(/\[remember promised\]/);
    expect(row('PLAYER: You have my word.')[0]).toMatch(/\[if stage 10\]/);
    expect(row('PLAYER: I found your map pages.')[0]).toMatch(/\[if stage 20\]/);
    // Paid 250 if persuaded, 150 otherwise; either way the pages are taken and the quest is done.
    const paid = parseScreenplay(hesta).topics.find((t) => t.text === 'I found your map pages.')!.responses;
    expect(paid.map((r) => [r.tags.if ?? null, r.tags.gives, r.tags.takes, r.tags.stage])).toEqual([
      ['chose persuaded', 'gold x250', 'pages x3', '30'],
      [null, 'gold x150', 'pages x3', '30'],
    ]);
    expect(plan.conversations.find((c) => c.title === '✎ Lucan Valerius')).toBeTruthy();
  });

  it('say what does not fit, one beat or line at a time', () => {
    const sheet = lines();
    sheet.beats[1]!.target = 'pagez';
    sheet.beats[2]!.after = ['nothing'];
    sheet.dialogue[3]!.lines[0]!.variants![0]!.if = [{ kind: 'choice', name: 'haggled' }];
    sheet.dialogue[0]!.lines = sheet.dialogue[0]!.lines.filter((l) => l.beat !== 'job');
    expect(checkBeats(sheet, { blocks: quest1() }).map((q) => q.message)).toEqual([
      '“The player has to find all three pages.”: the player does “pickup” to a item, but “pagez” isn\'t one. Which item (one of: notice, pages)?',
      '“Once they have all three, the objective changes to returning to Hesta.” comes after “nothing”, which isn\'t a beat.',
      'Line 3 of conversation 4 is said only if the player chose “haggled”, but nothing remembers that choice. Which one is it (promised), or which line or beat should remember it?',
      '“When the player takes the job” happens in a conversation: which line does it (or what\'s said, if the author didn\'t write it)?',
    ]);
  });

  it('order beats by what each needs first, and join branches', () => {
    const sheet = lines();
    // Two endings, then going back to Hesta either way.
    sheet.beats = [
      { id: 'meet', does: 'talk', target: 'hesta', after: [], quote: 'Hesta asks', journal: null, objective: null, ends: null, effects: {} },
      { id: 'report', does: 'talk', target: 'hesta', after: ['spared', 'killed'], quote: 'Either way the player goes back to Hesta', journal: null, objective: 'Return to Hesta', ends: 'complete', effects: {} },
      { id: 'spared', does: 'talk', target: 'lucan', after: ['meet'], quote: 'Lucan can be talked down', journal: 'Lucan left.', objective: null, ends: null, effects: { leaves: ['lucan'] } },
      { id: 'killed', does: 'kill', target: 'lucan', after: ['meet'], quote: 'or killed', journal: 'Lucan is dead.', objective: null, ends: null, effects: {} },
    ];
    sheet.dialogue = [];
    sheet.lines = [
      { beat: 'meet', player: 'What do you need?', answer: 'Deal with Lucan.' },
      { beat: 'spared', player: 'Leave.', answer: 'Fine.' },
      { beat: 'report', player: "It's done.", answer: 'Good.' },
    ];
    expect(beatOrder(sheet.beats)!.map((b) => b.id)).toEqual(['meet', 'spared', 'killed', 'report']);
    expect(checkBeats(sheet)).toEqual([]);
    const plan = compileBeats(sheet);
    expect(plan.steps.map((s) => `${s.from}→${s.to} ${s.kind}`)).toEqual(['0→10 talk', '10→20 talk', '10→30 death', '20→40 talk', '30→40 talk']);
    // Lucan leaving is said on his own line, not as an event as well.
    expect(plan.conversations.find((c) => c.title === 'Lucan Valerius')!.screenplay).toBe('PLAYER: Leave. [if stage 10]\nLUCAN: Fine. [stage 20] [leaves]');
    expect(plan.events).toEqual([]);
    expect(validatePlan(plan).filter((i) => i.severity === 'error')).toEqual([]);
    // A loop is said, not built.
    sheet.beats[0]!.after = ['report'];
    expect(beatOrder(sheet.beats)).toBeUndefined();
    expect(checkBeats(sheet).map((q) => q.message)).toContain('The beats loop: some beat comes, through others, after itself.');
  });

  it('build in the world like any plan', async () => {
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
    const builder = new QuestBuilder(ws, quests, graphs, new DialogueService(ws, quests), new NpcService(ws), new EnvironmentService(ws));
    // Brynja's ring, written loosely: no conversations of the author's, so the AI wrote a line for each talk beat.
    const sheet: BeatSheet = {
      title: "The Innkeeper's Ring",
      editorId: 'BeatRingQuest',
      summary: 'Find Brynja’s ring.',
      start: { kind: 'game' },
      people: [{ key: 'brynja', name: 'Brynja', existing: 'DemoInnkeeper', description: 'Runs the tavern', sex: null, race: null, place: null, spot: null, essential: null, hostile: false, quote: 'Brynja' }],
      places: [{ key: 'tavern', name: 'The Demo Tavern', existing: 'DemoTavern', description: 'Her tavern', quote: 'the tavern' }],
      items: [{ key: 'ring', name: "Brynja's Ring", kind: 'misc', existing: null, place: 'tavern', carriedBy: null, spot: 'on a table', count: 1, text: null, lockedWith: null, quote: 'her ring' }],
      groups: [],
      beats: [
        { id: 'ask', does: 'talk', target: 'brynja', after: [], quote: 'Brynja asks the player to find it', journal: 'Brynja lost her ring.', objective: null, ends: null, effects: {} },
        { id: 'find', does: 'pickup', target: 'ring', after: ['ask'], quote: 'The ring is on a table', journal: 'I found the ring.', objective: 'Find Brynja’s ring', ends: null, effects: {} },
        { id: 'back', does: 'talk', target: 'brynja', after: ['find'], quote: 'she pays 100 gold for it', journal: 'Brynja paid me.', objective: 'Return the ring', ends: 'complete', effects: { takes: [{ item: 'ring', count: 1 }], gold: 100 } },
      ],
      dialogue: [],
      lines: [
        { beat: 'ask', player: 'Need help?', answer: "I've lost my ring. Find it?" },
        { beat: 'back', player: "Here's your ring.", answer: 'Thank you! Take this.' },
      ],
    };
    expect(checkBeats(sheet)).toEqual([]);
    const plan = compileBeats(sheet);
    expect(validatePlan(plan).filter((i) => i.severity === 'error')).toEqual([]);
    const r = await builder.build(plan);
    expect(r.problems ?? []).toEqual([]);
    const g = await graphs.graph(r.quest!);
    expect(g.problems).toEqual([]);
  });
});
