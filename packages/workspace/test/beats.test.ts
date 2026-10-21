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
  BeatReader,
  QuestPlanner,
  beatOrder,
  passages,
  checkBeats,
  compileBeats,
  createDemoData,
  findDialogue,
  parseScreenplay,
  splitQuestline,
  validatePlan,
  type BeatSheet,
  type PlannerReply,
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
      '“The player has to find all three pages.”: the player does “pickup” to an item, but “pagez” isn\'t one. Which item (one of: notice, pages)?',
      '“Once they have all three, the objective changes to returning to Hesta.” comes after “nothing”, which isn\'t a beat.',
      // (and so the pages lead nowhere)
      '“The player has to find all three pages.” leads nowhere: no beat comes after it, and it doesn\'t end the quest. What comes next?',
      'Line 3 of conversation 4 is said only if the player chose “haggled”, but nothing remembers that choice. Which one is it (promised), or which line or beat should remember it?',
      '“When the player takes the job” happens in a conversation: which line does it (or what\'s said, if the author didn\'t write it)?',
    ]);
    // Talking isn't asked again as a beat: its line gets written.
    expect(checkBeats(sheet, { blocks: quest1() }).filter((q) => q.unsaid).map((q) => q.about)).toEqual(['job']);
    // Killing an enemy group is clearing it: the question says what the target is and what fits it.
    sheet.groups = [{ key: 'bandit', what: 'bandit', count: 3, place: 'inn', spot: null, hidden: false, quote: '' }];
    sheet.beats[1] = { ...sheet.beats[1]!, does: 'kill', target: 'bandit' };
    // A group somewhere unknown is asked as a pick among the places there are.
    sheet.groups[0]!.place = 'at the inn';
    expect(checkBeats(sheet).find((q) => q.about === 'bandit')).toEqual({ about: 'bandit', message: 'The bandit are at “at the inn”, which isn\'t a place in the sheet.', pick: { field: 'place', kind: 'place' } });
    expect(checkBeats(sheet).map((q) => q.message)).toContain('“The player has to find all three pages.”: the player does “kill” to a person, but “bandit” isn\'t one (it\'s an enemy group, which the player can clear). Which person (one of: hesta, lucan), or is the action “clear”?');
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
    // 200 gold, or only 100 if Lucan was let go: the answer is said that way first.
    sheet.beats[1] = { ...sheet.beats[1]!, effects: { gold: 200 }, variants: [{ if: [{ kind: 'left', who: 'lucan' }], effects: { gold: 100 } }] };
    const paid = parseScreenplay(compileBeats(sheet).conversations.find((c) => c.title === 'Hesta Coldwater')!.screenplay).topics.find((t) => t.text === "It's done.")!.responses;
    expect(paid.map((r) => [r.tags.if ?? null, r.tags.gives, r.tags.stage])).toEqual([
      ['left lucan', 'gold x100', '40'],
      [null, 'gold x200', '40'],
    ]);
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

  it('are read from loose prose in small questions, the AI naming things and the code keeping the books', async () => {
    const doc = readFileSync(join(import.meta.dirname, '../../../apps/studio/test/models/beats/prose.md'), 'utf8');
    // Short enough to be asked about in one go.
    expect(passages(doc).map((p) => p.kind)).toEqual(['prose']);
    const asked: string[] = [];
    const reply = (o: unknown): PlannerReply => ({ content: [{ type: 'text', text: JSON.stringify(o) }], stop_reason: 'end_turn' });
    const none = { gold: null, gives: [], takes: [], remembers: null, attacks: [], leaves: [], follows: [], stopsFollowing: [], appears: [], moves: [] };
    const planner = new QuestPlanner({
      send: async (p) => {
        const user = String(p.messages.at(-1)!.content);
        asked.push(user.split('\n').at(-1)!);
        if (user.includes('List the people')) {
          return reply({
            summary: "An old woman's son never came back from Bleak Falls Barrow.",
            start: { how: 'talking', what: null },
            people: [{ name: 'Tilda Grey-Hand', description: 'An old woman', sex: 'female', race: null, where: "Tilda's house", spot: null, canDie: 'not said', hostile: false, quote: 'an old woman called Tilda Grey-Hand' }],
            places: [
              { name: "Tilda's house", description: 'A small house by the river', partOf: 'Riverwood', quote: 'a small house of her own by the river' },
              { name: 'Bleak Falls Barrow', description: 'An old tomb', partOf: null, quote: 'went up to Bleak Falls Barrow' },
            ],
            items: [
              { name: "Arn's Letter", kind: 'book', where: 'Bleak Falls Barrow', carriedBy: null, spot: 'just inside the entrance', count: 1, text: null, lockedWith: null, quote: 'a letter he never sent' },
              { name: "Tilda's Husband's Axe", kind: 'weapon', where: null, carriedBy: 'Tilda', spot: null, count: 1, text: null, lockedWith: null, quote: "her late husband's axe" },
            ],
            enemies: [],
          });
        }
        if (user.includes('<passage>'))
          return reply({
            beats: [
              { n: 1, does: 'talk', target: 'Tilda', count: null, hours: null, after: [], quote: 'she tells them about Arn and begs them to find out what happened to him', ends: 'no', then: null },
              // Misread: killing a letter, and the return to Tilda after nothing.
              { n: 2, does: 'kill', target: 'letter', count: null, hours: null, after: [1], quote: 'on him a letter he never sent', ends: 'no', then: null },
              { n: 3, does: 'talk', target: 'Tilda Grey-Hand', count: null, hours: null, after: [], quote: 'When the player brings the letter back', ends: 'complete', then: "she takes the letter and gives the player her late husband's axe" },
            ],
          });
        // The checks' closed questions: which reading fits, and what comes after the letter.
        if (user.includes('isn\'t one')) {
          expect(String(p.messages.at(-1)!.content)).toContain('“kill” to a person, but “arnLetter” isn\'t one (it\'s an item, which the player can pickup or read or use)');
          return reply({ answer: "pickup Arn's Letter" });
        }
        if (user.includes('leads nowhere')) return reply({ next: [3], ends: 'no' });
        if (user.includes('What else happens')) return reply({ beats: [{ n: 3, ...none, takes: [{ item: 'letter', count: 1 }], gives: [{ item: 'axe', count: 1 }, { item: "Arn's Ring", count: 1 }], instead: [] }] });
        if (user.includes('What kind of thing is “Arn\'s Ring”')) return reply({ kind: 'clothing' });
        if (user.includes('their journal entry'))
          return reply({
            beats: [
              { n: 1, objective: 'Talk to Tilda', journal: 'Tilda asked me to find out what happened to her son.' },
              { n: 2, objective: 'Find out what happened to Arn', journal: 'I found Arn and his letter.' },
              { n: 3, objective: 'Bring the letter to Tilda', journal: 'Tilda read the letter.' },
            ],
          });
        if (user.includes('what the player says to')) return reply(user.includes('(“When the player brings') ? { player: 'I found Arn.', answer: 'Then he is gone. Take this.' } : { player: 'Why the lantern?', answer: 'For my son. Will you look for him?' });
        throw new Error(`unexpected: ${user.slice(0, 80)}`);
      },
    });
    // Riverwood is on the world map; nothing else is in the game.
    const lookup = { person: () => null, place: (n: string) => (n === 'Riverwood' ? 'Riverwood' : n === 'Bleak Falls Barrow' ? 'Bleak Falls Barrow' : null), item: () => null };
    const steps: string[] = [];
    const { sheet, questions } = await new BeatReader(planner).read(doc, { title: 'The Lantern by the River', editorId: 'LanternByTheRiver', lookup, onStep: (s) => steps.push(s) });
    expect(questions).toEqual([]);
    expect(sheet.people.map((p) => [p.key, p.existing])).toEqual([['tilda', null]]);
    // "Tilda's house" is part of Riverwood: it's there, outside.
    expect(sheet.places.map((p) => [p.key, p.existing])).toEqual([
      ['tildaHouse', 'Riverwood'],
      ['bleakFallsBarrow', 'Bleak Falls Barrow'],
    ]);
    expect(sheet.items.map((i) => [i.key, i.place, i.carriedBy])).toEqual([
      ['arnLetter', 'bleakFallsBarrow', null],
      ['tildaHusbandAxe', null, 'tilda'],
      // Handed over but not in the first list: added, its kind asked.
      ['arnRing', null, null],
    ]);
    expect(sheet.items[2]!.kind).toBe('clothing');
    expect(sheet.beats.map((b) => `${b.id} ${b.does} ${b.target} after ${b.after.join(',')}`)).toEqual(['b1 talk tilda after ', 'b2 pickup arnLetter after b1', 'b3 talk tilda after b2']);
    // What else happens is the author's words, read into effects in a question of its own.
    expect(sheet.beats[2]!.effects).toEqual({ takes: [{ item: 'arnLetter', count: 1 }], gives: [{ item: 'tildaHusbandAxe', count: 1 }, { item: 'arnRing', count: 1 }] });
    expect(sheet.beats.map((b) => b.objective)).toEqual(['Talk to Tilda', 'Find out what happened to Arn', 'Bring the letter to Tilda']);
    // Nothing written out: the AI wrote one exchange for each talk beat.
    expect(sheet.lines.map((l) => l.beat)).toEqual(['b1', 'b3']);
    expect(steps).toContain('reading part 1 of 1');
    const plan = compileBeats(sheet);
    expect(validatePlan(plan).filter((i) => i.severity === 'error')).toEqual([]);
    expect(plan.conversations[0]!.screenplay).toBe("PLAYER: Why the lantern? [if stage 0]\nTILDA: For my son. Will you look for him? [stage 10]\nPLAYER: I found Arn. [if stage 20]\nTILDA: Then he is gone. Take this. [stage 30] [gives tildaHusbandAxe x1] [gives arnRing x1] [takes arnLetter x1]");
  });

  it('read written conversations by the lines that move the quest on, each one talking to its speaker', async () => {
    const doc = readFileSync(join(import.meta.dirname, '../../../apps/studio/test/models/beats/screenplay.md'), 'utf8');
    const reply = (o: unknown): PlannerReply => ({ content: [{ type: 'text', text: JSON.stringify(o) }], stop_reason: 'end_turn' });
    const planner = new QuestPlanner({
      send: async (p) => {
        const user = String(p.messages.at(-1)!.content);
        if (user.includes('List the people'))
          return reply({
            summary: 'Fetch a cask for Hulda.',
            start: { how: 'talking', what: null },
            people: [
              { name: 'Hulda', description: 'Runs the Bannered Mare', sex: 'female', race: null, where: 'The Bannered Mare', spot: 'behind the bar', canDie: 'not said', hostile: false, quote: '' },
              { name: 'Sabjorn', description: 'Owns the meadery', sex: 'male', race: null, where: 'Honningbrew Meadery', spot: null, canDie: 'not said', hostile: false, quote: '' },
            ],
            places: [
              { name: 'The Bannered Mare', description: '', partOf: null, quote: '' },
              { name: 'Honningbrew Meadery', description: '', partOf: null, quote: '' },
            ],
            items: [{ name: 'Cask of Honningbrew Mead', kind: 'misc', where: 'Honningbrew Meadery', carriedBy: null, spot: 'by the stairs', count: 1, text: null, lockedWith: null, quote: '' }],
            enemies: [{ what: 'skeever', count: 5, where: 'Honningbrew Meadery', appearLater: false, quote: '' }],
          });
        if (user.includes('<passage>\nQUEST:')) return reply({ beats: [] });
        if (user.includes('<passage>\nSCENE 3')) return reply({ beats: [{ n: 4, does: 'clear', target: 'skeever', count: null, hours: null, after: [2], quote: 'When the skeevers are dead:', ends: 'no', then: null }] });
        if (user.includes('Block 1 —')) return reply({ when: null, moves: [{ line: 3, words: 'Would you? Sabjorn', beat: null, ends: 'no' }] });
        // The agreement and the persuasion's success, both answers to the first line: both come after the job.
        if (user.includes('Block 2 —'))
          return reply({
            when: 1,
            moves: [
              { line: 4, words: 'You will? Then', beat: null, ends: 'no' },
              { line: 6, words: 'Fine, fine. Here.', beat: null, ends: 'no' },
            ],
          });
        if (user.includes('Block 3 —')) return reply({ when: 4, moves: [{ line: 2, words: "Shor's bones. Take", beat: null, ends: 'no' }] });
        if (user.includes('Block 4 —')) return reply({ when: 5, moves: [{ line: 2, words: 'Finally! Here, for', beat: null, ends: 'complete' }] });
        if (user.includes('For each line with a direction')) return reply({ lines: [] });
        if (user.includes('leads nowhere')) return reply({ next: [6], ends: 'no' });
        if (user.includes('their journal entry')) return reply({ beats: [] });
        throw new Error(`unexpected: ${user.slice(-200)}`);
      },
    });
    const { sheet, questions } = await new BeatReader(planner).read(doc, { title: 'A Drink for the Mare', editorId: 'ADrinkForTheMare' });
    expect(sheet.beats.map((b) => `${b.id} ${b.does} ${b.target} after ${b.after.join(',')}${b.ends ? ` ${b.ends}` : ''}`)).toEqual([
      'b1 talk hulda after ',
      'b2 talk sabjorn after b1',
      'b3 talk sabjorn after b1',
      'b4 clear skeever after b2',
      'b5 talk sabjorn after b4',
      // Persuaded, the player goes straight back to Hulda (asked: that beat led nowhere).
      'b6 talk hulda after b5,b3 complete',
    ]);
    expect(sheet.dialogue.map((d) => [d.block, d.when, d.lines.map((l) => `${l.line}:${l.beat}`).join(' ')])).toEqual([
      [1, null, '3:b1'],
      [2, 'b1', '4:b2 6:b3'],
      [3, 'b4', '2:b5'],
      [4, 'b5', '2:b6'],
    ]);
    expect(questions).toEqual([]);
  });
});
