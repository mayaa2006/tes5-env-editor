import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  applyAnnotation,
  blocksFor,
  bookText,
  buildQuestline,
  clauseConditions,
  createDemoData,
  directionTags,
  exampleQuestPlan,
  findDialogue,
  generateTriggerScript,
  parseIf,
  parseScreenplay,
  questlineContext,
  questlineIssues,
  questlineLinks,
  settleQuestlinePlan,
  splitQuestline,
  validatePlan,
  writtenScreenplay,
  type PlannerReply,
  type QuestPlan,
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
  const triggers = new TriggerService(ws, scripts);
  const graphs = new QuestGraphService(ws, quests, scripts, triggers);
  const dialogue = new DialogueService(ws, quests);
  const builder = new QuestBuilder(ws, quests, graphs, dialogue, new NpcService(ws), new EnvironmentService(ws));
  return { ws, scripts, quests, triggers, graphs, dialogue, builder, world: new WorldService(ws) };
}

const reply = (text: string): PlannerReply => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });

const QUESTLINE = `# The Lost Ledger

## Characters

- **Brynja**: runs the Demo Tavern.
- **Sigrun**: a new traveller, a Nord woman, sharp-tongued. She waits in the tavern.

## Quest 1: The Ledger

Brynja's ledger is missing. The player finds it and brings it back.

BRYNJA: You there. Can you read?
  PLAYER: I can.
    BRYNJA: Then find my ledger. It's somewhere in this tavern. (the player takes the job)
  PLAYER: (Persuade, Speech 30) Depends what you're paying.
    BRYNJA: (success) Fifty, then. Find my ledger. (the player takes the job)
    BRYNJA: (failure) Nothing, if you keep that up.

When the player comes back with it:

PLAYER: Here's your ledger.
  BRYNJA: My ledger! Thank you. (she takes it; the quest is done)

## Quest 2: Sigrun's Price

Starts when Quest 1 ends. Sigrun is outside now, in the Demo Valley.

- **Player:** "Brynja says you know about the ledger."
  - **Sigrun** (only if the player was paid in Quest 1): "Paid, were you? Then you can pay me."
  - **Sigrun** (otherwise): "Maybe I do."
  - **Sigrun:** "Come back tomorrow." *(the quest is done)*
`;

describe('written dialogue', () => {
  it('finds conversations written in screenplay style and as bold bullet lists, word for word, with their directions', () => {
    const line = splitQuestline(QUESTLINE)!;
    const q1 = findDialogue(line.parts[0]!.text);
    expect(q1.blocks).toHaveLength(2);
    expect(q1.blocks[1]!.header).toBe('When the player comes back with it:');
    const lines = q1.blocks[0]!.lines;
    expect(lines[0]).toMatchObject({ speaker: 'BRYNJA', player: false, level: 0, text: 'You there. Can you read?' });
    expect(lines[2]).toMatchObject({ text: "Then find my ledger. It's somewhere in this tavern.", notes: ['the player takes the job'] });
    expect(lines[3]).toMatchObject({ player: true, text: "Depends what you're paying.", notes: ['Persuade, Speech 30'] });
    const q2 = findDialogue(line.parts[1]!.text);
    expect(q2.blocks).toHaveLength(1);
    expect(q2.blocks[0]!.lines.map((l) => [l.speaker, l.level, l.text, l.notes])).toEqual([
      ['PLAYER', 0, 'Brynja says you know about the ledger.', []],
      ['Sigrun', 1, 'Paid, were you? Then you can pay me.', ['only if the player was paid in Quest 1']],
      ['Sigrun', 1, 'Maybe I do.', ['otherwise']],
      ['Sigrun', 1, 'Come back tomorrow.', ['the quest is done']],
    ]);
    // "Journal: …" and a heading like "Gerda:" on its own aren't anyone speaking.
    expect(findDialogue('Journal: "I found a notice."\nObjectives: find the pages').blocks).toEqual([]);
    expect(findDialogue('Gerda:\n\n- **Gerda:** "Halt."\n  - **Player:** "Why?"\n    - **Gerda:** "Because."').blocks[0]!.lines).toHaveLength(3);
  });

  it('turns them into a screenplay: openings become greetings, persuasion and alternatives become tags, every word kept', () => {
    const line = splitQuestline(QUESTLINE)!;
    const blocks = blocksFor(findDialogue(line.parts[0]!.text).blocks, 'BRYNJA');
    applyAnnotation(blocks, { blocks: [{ block: 1, tags: '[if stage 0]' }, { block: 2, tags: '[if stage 20]' }], lines: [{ line: 3, tags: '[stage 10]' }, { line: 5, tags: '[stage 10] [remember paid]' }, { line: 8, tags: '[takes ledger x1] [stage 100]' }] });
    const text = writtenScreenplay(blocks);
    expect(parseScreenplay(text).errors).toEqual([]);
    expect(text).toBe(
      [
        'PLAYER: I can. [if stage 0]',
        "BRYNJA: Then find my ledger. It's somewhere in this tavern. [stage 10]",
        "PLAYER: Depends what you're paying. [if stage 0] [persuade 30]",
        'BRYNJA: Fifty, then. Find my ledger. [stage 10] [remember paid]',
        'BRYNJA: Nothing, if you keep that up.',
        "PLAYER: Here's your ledger. [if stage 20]",
        'BRYNJA: My ledger! Thank you. [takes ledger x1] [stage 100]',
        'GREETING:',
        'BRYNJA: You there. Can you read? [if stage 0]',
      ].join('\n'),
    );
    // After [persuade], the success and the failure stay two answers.
    const p = parseScreenplay(text);
    expect(p.topics[1]!.responses.map((r) => r.lines[0])).toEqual(['Fifty, then. Find my ledger.', 'Nothing, if you keep that up.']);
  });

  it('makes every combination of alternative lines, each its own answer, the first that applies being said', () => {
    const line = splitQuestline(QUESTLINE)!;
    const blocks = blocksFor(findDialogue(line.parts[1]!.text).blocks, 'Sigrun');
    applyAnnotation(blocks, { blocks: [], lines: [{ line: 2, tags: '[if chose paid]' }, { line: 4, tags: '[stage 100]' }] });
    const text = writtenScreenplay(blocks);
    const answers = parseScreenplay(text).topics[0]!.responses;
    expect(answers.map((r) => [r.lines, r.tags.if ?? null, r.tags.stage])).toEqual([
      [['Paid, were you? Then you can pay me.', 'Come back tomorrow.'], 'chose paid', '100'],
      [['Maybe I do.', 'Come back tomorrow.'], null, '100'],
    ]);
  });

  it('keeps an opening said over several lines as one greeting, with the choices after it', () => {
    const blocks = blocksFor(findDialogue('**Varro:** "Ah."\n**Varro:** "Sit. Drink?"\n- **Player:** "No."\n  - **Varro:** "Pity."').blocks, 'Varro');
    expect(writtenScreenplay(blocks)).toBe('PLAYER: No.\nVARRO: Pity.\nGREETING:\nVARRO: Ah. Sit. Drink?');
  });

  it('reads plain directions the AI left without tags', () => {
    const plan = { stages: [{ index: 0, completesQuest: false, failsQuest: false }, { index: 100, completesQuest: true, failsQuest: false }], items: [{ key: 'pages', name: 'Torn Map Page' }] };
    // "pays 300 gold, or 400 if persuaded" is two ways of saying the line: left to the AI.
    const all = findDialogue('PLAYER: Here.\n  HESTA: Thank you. (she takes the three pages and pays 150 gold; the quest is done)\nPLAYER: Fight me.\n  GERDA: Gladly. (she attacks)\nPLAYER: Go.\n  GERDA: Fine. (she pays 300 gold, or 400 if persuaded, and leaves for good)').blocks;
    expect(directionTags(all, plan)).toEqual([
      '[gives gold x150] on “Thank you.” (pays gold)',
      '[takes pages x3] on “Thank you.” (takes Torn Map Page)',
      '[stage 100] on “Thank you.” (the quest is done)',
      '[attacks] on “Gladly.” (attacks)',
      '[leaves] on “Fine.” (leaves)',
    ]);
  });

  it('says one line two ways when the AI gives two sets of tags', () => {
    const blocks = findDialogue('PLAYER: Pay me.\n  HESTA: Here, as agreed. (pays 150, or 250 if persuaded)').blocks;
    blocksFor(blocks, 'HESTA');
    applyAnnotation(blocks, { blocks: [], lines: [{ line: 2, tags: '[if chose persuaded] [gives gold x250] | [gives gold x150]' }] });
    const answers = parseScreenplay(writtenScreenplay(blocks)).topics[0]!.responses;
    expect(answers.map((r) => [r.tags.if ?? null, r.tags.gives])).toEqual([
      ['chose persuaded', 'gold x250'],
      [null, 'gold x150'],
    ]);
  });

  it("mends a small model's tags for the Cartographer's first quest: lines miscounted, the job taken, the promise, the persuasion", () => {
    const doc = readFileSync(join(import.meta.dirname, '../../../apps/studio/test/models/questline-cartographer.md'), 'utf8');
    const blocks = blocksFor(findDialogue(splitQuestline(doc)!.parts[0]!.text).blocks, 'HESTA');
    const plan = {
      stages: [0, 10, 20, 30, 40].map((index) => ({ index, completesQuest: index === 40, failsQuest: false })),
      items: [{ key: 'mapPage1', name: 'Torn Map Page' }, { key: 'wantedNotice', name: 'Wanted Notice' }],
      steps: [
        { from: 0, to: 10, kind: 'script', targetKey: null, note: 'Player reads the wanted notice on the bar' },
        { from: 10, to: 20, kind: 'talk', targetKey: null, note: 'Player agrees to take the job with Hesta' },
        { from: 20, to: 30, kind: 'pickup', targetKey: 'mapPage1', note: 'Player finds the first map page' },
        { from: 30, to: 40, kind: 'talk', targetKey: null, note: 'Player returns the pages to Hesta' },
      ],
    };
    // What Qwen3.5 4B answered (on the real run): the promise remembered on the wrong lines, nothing taking the job,
    // block 2 ("Right after the player takes the job") offered before it's taken.
    const on = (n: number, tags: string) => ({ line: n, tags });
    applyAnnotation(blocks, {
      blocks: [{ block: 1, tags: '[if stage 10]' }, { block: 2, tags: '[if stage 10]' }, { block: 3, tags: '[if stage 20]' }, { block: 4, tags: '[if stage 30]' }],
      lines: [on(6, '[if stage 10] [remember promised] | [if stage 10] [remember promised]'), on(7, '[if stage 10] [remember persuaded]'), on(8, '[if stage 10] [remember persuaded]'), on(16, '[if stage 10] [remember promised]'), on(24, '[if stage 10] [remember promised]'), on(31, '[if stage 30] [gives gold x150] | [if stage 30] [if chose persuaded] [gives gold x250]')],
    });
    directionTags(blocks, plan);
    // Its retry, one line off, with the words that show which line it meant.
    applyAnnotation(blocks, { blocks: [], lines: [{ line: 9, words: 'Ha. Fine. 250', tags: '[stage 20]' }] });
    const text = writtenScreenplay(blocks);
    expect(parseScreenplay(text).errors).toEqual([]);
    const row = (start: string) => text.split('\n').find((r) => r.trim().startsWith(start))!;
    expect(row("HESTA: The case will be ruined")).toMatch(/\[stage 20\]/);
    expect(row("HESTA: The case will be ruined")).not.toMatch(/remember/);
    expect(row('HESTA: Ha. Fine. 250')).toMatch(/\[stage 20\].*\[remember persuaded\]|\[remember persuaded\].*\[stage 20\]/);
    expect(row('HESTA: 150 is what I have')).not.toMatch(/stage/);
    expect(row('HESTA: Three pages. All three, mind.')).toMatch(/\[stage 20\]/);
    expect(row("HESTA: Good. I'll hold you to it.")).toMatch(/\[remember promised\]/);
    expect(row('PLAYER: You have my word.')).toMatch(/\[if stage 20\]|^HESTA/);
    // The line said at stage 20 isn't held back to stage 10 by the AI's own condition.
    expect(row("HESTA: Good. I'll hold you to it.")).not.toMatch(/if stage/);
    // Paid 250 if persuaded, otherwise 150; either way the pages are taken and the quest is done.
    const back = parseScreenplay(text).topics.find((t) => t.text === 'I found your map pages.')!;
    expect(back.tags.if).toBe('stage 30');
    expect(back.responses.map((r) => [r.tags.if ?? null, r.tags.gives, r.tags.takes, r.tags.stage])).toEqual([
      ['chose persuaded', 'gold x250', 'mapPage1 x3', '40'],
      [null, 'gold x150', 'mapPage1 x3', '40'],
    ]);
    expect(blocks.find((b) => b.id === 2)!.tags).toEqual(['[if stage 20]']);
  });

  it("reads the Cartographer's later directions with no AI: after dark, a day later, needing and taking gold, giving the survey, a promise from quest 1", () => {
    const parts = splitQuestline(readFileSync(join(import.meta.dirname, '../../../apps/studio/test/models/questline-cartographer.md'), 'utf8'))!.parts;
    // Each line named by its first words.
    const brief = (xs: string[]) => xs.map((x) => x.replace(/“(.{0,20})[^”]*”/, '“$1”'));
    const q3 = findDialogue(parts[2]!.text).blocks;
    const plan3 = {
      stages: [0, 10, 20, 30, 40, 50].map((index) => ({ index, completesQuest: index === 50, failsQuest: false })),
      items: [{ key: 'varroLedger', name: "Varro's Ledger" }, { key: 'strongboxKey', name: "Varro's Strongbox Key" }],
      steps: [
        { from: 10, to: 20, kind: 'read', targetKey: 'varroLedger', note: 'The player reads the ledger' },
        { from: 20, to: 30, kind: 'talk', targetKey: null, note: 'The player brings the ledger to Hesta' },
        { from: 30, to: 40, kind: 'wait', targetKey: null, note: 'A day passes' },
        { from: 40, to: 50, kind: 'talk', targetKey: null, note: 'Hesta has news' },
      ],
    };
    const varro = blocksFor(q3, 'Varro');
    expect(brief(directionTags(varro, plan3, ['promised', 'persuaded']))).toEqual(
      brief([
        '[remember deal] on “Sensible. Two hundred now, the rest when…” (remembers the choice)',
        '[gives gold x200] on “Sensible. Two hundred now, the rest when…” (pays gold)',
        '[if chose promised] on “Hesta told me nothing, if that\'s what yo…” (a choice made earlier)',
        '[if night] on the conversation “Varro, after dark only:”',
      ]),
    );
    expect(directionTags(blocksFor(q3, 'Hulda'), plan3)).toEqual(['[if day] on the conversation “Hulda, during the day:”']);
    const hesta = blocksFor(q3, 'Hesta');
    expect(brief(directionTags(hesta, plan3, ['promised']))).toEqual(
      brief(['[takes varroLedger x1] on “Give it here. Gods. He paid them in coin…” (takes Varro\'s Ledger)', '[if chose promised] on “And you kept your word, too. I won\'t for…” (a choice made earlier)', '[stage 50] on “Rest. You\'ll need it.” (the quest is done)', '[if stage 40] on the conversation “A day later:” (after “A day passes”)']),
    );
    const q4 = findDialogue(parts[3]!.text).blocks;
    const plan4 = { stages: [0, 100, 200].map((index) => ({ index, completesQuest: index === 200, failsQuest: false })), items: [{ key: 'survey', name: 'Coldwater Survey of the Rift' }], steps: [] };
    const gerda = blocksFor(q4, 'Gerda');
    expect(brief(directionTags(gerda, plan4, ['promised', 'deal']))).toEqual(brief(['[if gold 300] on “What if I paid you more?” (needs gold)', '[takes gold x300] on “More than Varro? He\'s tight with coin. Th…” (takes gold)', '[leaves] on “More than Varro? He\'s tight with coin. Th…” (leaves)', '[attacks] on “Suits me.” (attacks)']));
    const paid = directionTags(blocksFor(q4, 'Hesta'), plan4, ['promised', 'deal']);
    expect(brief(paid.filter((t) => t.startsWith('[gives')))).toEqual(brief(['[gives gold x100] on “His ledger had a new entry. Two hundred se…” (pays gold)', '[gives survey x1] on “His ledger had a new entry. Two hundred se…” (gives Coldwater Survey of the Rift)', '[gives gold x300] on “Here. Three hundred, and something better:…” (pays gold)', '[gives survey x1] on “Here. Three hundred, and something better:…” (gives Coldwater Survey of the Rift)']));
  });

  it('adds up what the lines of one answer give, and [or] starts another answer', () => {
    const p = parseScreenplay('PLAYER: Hi\nBRYNJA: Here. [gives gold x10]\nBRYNJA: And this. [gives ring x1]\nBRYNJA: Or nothing. [or]');
    expect(p.topics[0]!.responses.map((r) => r.tags.gives ?? '')).toEqual(['gold x10;ring x1', '']);
  });
});

describe('questlines', () => {
  it('splits a document into its quests, keeping what they share', () => {
    const line = splitQuestline(QUESTLINE)!;
    expect(line.title).toBe('The Lost Ledger');
    expect(line.parts.map((p) => p.title)).toEqual(['Quest 1: The Ledger', "Quest 2: Sigrun's Price"]);
    expect(line.shared).toContain('Sigrun**: a new traveller');
    expect(line.shared).not.toContain('Here is your ledger');
    // Plain lines work as headings too; one quest isn't a questline.
    expect(splitQuestline('Intro\n\nQuest 1: A\nfirst\n\nQuest 2: B\nsecond')!.parts.map((p) => [p.title, p.text])).toEqual([
      ['Quest 1: A', 'first'],
      ['Quest 2: B', 'second'],
    ]);
    expect(splitQuestline('## Quest 1: Only one\nText')).toBeNull();
  });

  it('starts each later quest when the one before ends, and keeps their Editor IDs apart', () => {
    const one = exampleQuestPlan();
    const two = exampleQuestPlan();
    two.title = 'Part Two';
    two.characters[1]!.existing = 'Eirik';
    settleQuestlinePlan(two, [one]);
    expect(two.editorId).toBe('InnkeeperRingQuest2');
    expect(two.startsWithGame).toBe(false);
    expect(two.startsWhen).toEqual({ kind: 'afterQuest', targetKey: null, quest: 'InnkeeperRingQuest', stage: null });
    // Eirik, whom quest 1 makes, isn't "existing" in quest 2: he's the same entry, linked when they're built.
    expect(two.characters[1]!.existing).toBeNull();
    expect(questlineLinks([one, two])).toContainEqual({ quest: 1, kind: 'character', key: 'eirik', from: 0, fromKey: 'eirik', name: 'Eirik' });
    expect(questlineContext(splitQuestline(QUESTLINE)!, 1, [one])).toContain('startsWhen afterQuest with quest InnkeeperRingQuest');
  });

  it('warns about a choice checked before any quest remembers it', () => {
    const one = exampleQuestPlan();
    const two = exampleQuestPlan();
    two.startsWithGame = false;
    two.conversations[1]!.screenplay += '\nPLAYER: Remember me? [if chose helped]\nEIRIK: Aye.';
    expect(questlineIssues([one, two]).map((x) => x.message)).toEqual(['Quest 2 (The Innkeeper\'s Ring) checks the choice “helped”, but no quest up to it remembers it ([remember helped])', 'Nothing starts quest 2 (The Innkeeper\'s Ring)']);
    one.conversations[0]!.screenplay = one.conversations[0]!.screenplay.replace('[stage 10]', '[stage 10] [remember helped]');
    two.startsWhen = { kind: 'afterQuest', targetKey: null, quest: 'InnkeeperRingQuest', stage: null };
    two.startsWithGame = false;
    expect(questlineIssues([one, two])).toEqual([]);
  });

  it('builds the quests together: a character made once, moved where the later quest has them, each quest started by the last', async () => {
    const { ws, builder, quests, graphs } = await setup();
    const one = exampleQuestPlan();
    const two = exampleQuestPlan();
    Object.assign(two, { title: 'Eirik Outside', editorId: 'EirikOutside', startsWithGame: false, startsWhen: { kind: 'afterQuest', targetKey: null, quest: 'InnkeeperRingQuest', stage: null } });
    two.locations = [{ key: 'valley', name: 'Demo Valley', existing: 'DemoValley1_0', description: 'Outside', layoutLike: null, doorFrom: null }];
    two.characters = [{ ...two.characters[1]!, locationKey: 'valley', routine: [] }];
    two.items = [];
    two.objectives = [{ index: 10, text: 'Find Eirik outside', shownAtStage: 0, completedAtStage: 100, targetKey: 'eirik' }];
    two.stages = [
      { index: 0, journal: 'Eirik went outside.', startsQuest: true, completesQuest: false, failsQuest: false },
      { index: 100, journal: 'I found him.', startsQuest: false, completesQuest: true, failsQuest: false },
    ];
    two.steps = [{ from: 0, to: 100, kind: 'arrive', targetKey: 'valley', count: null, hours: null, note: 'Reach the valley' }];
    two.conversations = [];
    two.animations = [];
    const npcsBefore = ws.search({ sigs: ['NPC_'], limit: 1000 }).items.length;
    const r = await buildQuestline(ws, builder, { title: 'Two Parts', quests: [{ title: 'One', source: '', plan: one }, { title: 'Two', source: '', plan: two }] });
    expect(r.quests.map((q) => q.editorId)).toEqual(['InnkeeperRingQuest', 'EirikOutside']);
    // Eirik was made once, by quest 1.
    expect(ws.search({ sigs: ['NPC_'], limit: 1000 }).items.length).toBe(npcsBefore + 1);
    expect(r.links).toEqual(['Quest 2: Eirik (made in quest 1) is moved to Demo Valley when it starts']);
    // Quest 2 moves him outside when it starts and keeps him there while it runs.
    const q2 = r.quests[1]!.quest as FormKey;
    expect(await graphs.fragmentCode(q2, 0)).toMatch(/\.MoveTo\(Alias_/);
    expect(quests.quest(q2).aliases.find((a) => (a.fill as { actor?: FormKey }).actor)).toBeTruthy();
    // Quest 1's last stage starts quest 2.
    expect(await graphs.fragmentCode(r.quests[0]!.quest as FormKey, 100)).toContain(graphs.startLine(q2));
    // One undo takes the whole questline back.
    ws.undo();
    expect(ws.byEditorId('EirikOutside')).toBeUndefined();
    expect(ws.byEditorId('InnkeeperRingQuest')).toBeUndefined();
  });

  it('plans a written quest around the author’s own lines: the AI gives tags, never the words', async () => {
    const plan = exampleQuestPlan();
    plan.conversations = [{ title: 'Brynja', screenplay: 'PLAYER: I can. [if stage 0]\nBRYNJA: Then find my ledger, it is in the tavern. [stage 10]\nPLAYER: Seen my sword?\nBRYNJA: No. [goodbye]' }];
    plan.items[0] = { ...plan.items[0]!, key: 'ledger', name: "Brynja's Ledger" };
    plan.objectives[0]!.targetKey = 'ledger';
    plan.steps[1]!.targetKey = 'ledger';
    const sent: any[] = [];
    const answers = [
      JSON.stringify(plan),
      JSON.stringify({ blocks: [{ block: 1, tags: '[if stage 0]' }, { block: 2, tags: '[if stage 20]' }], lines: [{ line: 3, tags: '[stage 10]' }, { line: 5, tags: '[stage 10] [stage 99]' }, { line: 8, tags: '[takes ledger x1] [stage 100]' }] }),
    ];
    const planner = new QuestPlanner({ send: async (p) => (sent.push(p), reply(answers[Math.min(sent.length - 1, answers.length - 1)]!)) });
    const line = splitQuestline(QUESTLINE)!;
    const out = await planner.plan(`${line.shared}\n\n${line.parts[0]!.title}\n${line.parts[0]!.text}`, 'document', 'catalog');
    // The plan request says the written conversations are added afterwards; the second asks only for tags.
    expect(sent[0].messages[0].content).toContain('are added to the plan afterwards, word for word');
    expect(sent[1].messages[0].content).toContain("  3     BRYNJA: Then find my ledger. It's somewhere in this tavern.   — the player takes the job");
    const brynja = out.conversations.find((c) => c.title === '✎ Brynja')!;
    expect(brynja.screenplay).toContain("BRYNJA: Then find my ledger. It's somewhere in this tavern. [stage 10]");
    expect(brynja.screenplay).toContain('BRYNJA: My ledger! Thank you. [takes ledger x1] [stage 100]');
    // A stage the plan doesn't have is left off, with a note; the AI's own copy of the author's lines is dropped,
    // its other lines kept.
    expect(brynja.screenplay).not.toContain('[stage 99]');
    expect(out.assumptions).toContain("Left [stage 99] off Brynja's line 5 (there's no stage 99)");
    expect(out.conversations.find((c) => c.title === 'Brynja')!.screenplay).toBe('PLAYER: Seen my sword?\nBRYNJA: No. [goodbye]');
    expect(validatePlan(out).filter((x) => x.severity === 'error')).toEqual([]);
  });

  it('gives a free AI a checklist about talk steps, not about writing the conversations', async () => {
    const sent: any[] = [];
    const planner = new QuestPlanner({ ai: { kind: 'ollama', model: 'qwen3' }, send: async (p) => (sent.push(p), reply(sent.length === 1 ? JSON.stringify(exampleQuestPlan()) : JSON.stringify({ blocks: [], lines: [] }))) });
    await planner.plan(QUESTLINE, 'document', 'catalog').catch(() => undefined);
    const text = sent[0].messages[0].content as string;
    expect(text).toContain('5. Each thing a written conversation does');
    expect(text).toContain('8. Every field is there.');
    expect(text).not.toContain('Every [stage N] tag in a conversation has a talk step');
  });
});

describe('questline mechanics', () => {
  it('reads time of day, other quests’ stages and choices remembered by an earlier quest', async () => {
    const { ws, quests } = await setup();
    expect(parseIf('night')).toEqual([{ kind: 'time', from: 20, to: 6 }]);
    expect(parseIf('time 8-17')).toEqual([{ kind: 'time', from: 8, to: 17 }]);
    expect(parseIf('quest DemoTavernQuest done 10')).toEqual([{ kind: 'questStage', quest: 'DemoTavernQuest', stage: 10, not: false }]);
    const q1 = quests.createQuest('FirstQuest', 'First');
    const q2 = quests.createQuest('SecondQuest', 'Second');
    // Quest 1 remembers "promised"; quest 2's [if chose promised] reads that same global.
    const promised = clauseConditions(ws, q1, parseIf('chose promised'))[0]!.param1;
    expect(clauseConditions(ws, q2, parseIf('chose promised'))[0]!.param1).toBe(promised);
    // Night runs past midnight: later than 20 OR earlier than 6.
    const night = clauseConditions(ws, q2, parseIf('night'));
    expect(night.map((c) => [c.op, c.value, c.or])).toEqual([
      ['>=', 20, true],
      ['<', 6, false],
    ]);
    expect(clauseConditions(ws, q2, parseIf('quest FirstQuest done 10'))[0]).toMatchObject({ param1: q1, param2: 10, value: 1 });
  });

  it('writes triggers that wait for the player to come near, collect items and let time pass', () => {
    const q = 'C00:Built.esp' as FormKey;
    const near = generateTriggerScript('T', 'ReferenceAlias', [{ id: 'a', event: { kind: 'arrive', within: 1750 }, conditions: [], actions: [{ kind: 'setStage', quest: q, stage: 20 }], once: true }], () => 'Q').source;
    expect(near).toContain('Event OnCellAttach()\n\tRegisterForSingleUpdate(1.0)');
    expect(near).toContain('If Game.GetPlayer().GetDistance(GetReference()) <= 1750.0');
    expect(near).toContain('If waiting && GetReference().GetParentCell() && GetReference().GetParentCell().IsAttached()');
    const collect = generateTriggerScript('T', 'ReferenceAlias', [{ id: 'b', event: { kind: 'collect' }, conditions: [{ kind: 'playerHasItem', item: 'D00:Built.esp' as FormKey, count: 3 }], actions: [{ kind: 'setStage', quest: q, stage: 30 }], once: true }], (k) => (k === q ? 'Q' : 'Page')).source;
    expect(collect).toContain('AddInventoryEventFilter(Page)');
    expect(collect).toContain('Event OnItemAdded(');
    expect(collect.match(/If Game\.GetPlayer\(\)\.GetItemCount\(Page\) >= 3 && !Fired0/g)).toHaveLength(2);
    const wait = generateTriggerScript('T', 'ReferenceAlias', [{ id: 'c', event: { kind: 'wait', hours: 24 }, conditions: [], actions: [{ kind: 'setStage', quest: q, stage: 40 }], once: true }], () => 'Q').source;
    expect(wait).toContain('Event OnUpdateGameTime()');
  });

  it('builds notes with their words, several copies, locked containers, waits, collecting and ambushes', async () => {
    const { ws, builder, graphs, world } = await setup();
    // The demo data has no Skyrim.esm: a stand-in for the player's reference.
    world.placeReference(ws.byEditorId('DemoTavern')!, ws.byEditorId('DemoGuard')!, {}, { persistent: true, editorId: 'PlayerRef' });
    // …and a note to copy (it has no books either).
    ws.createRecord('BOOK', { editorId: 'DemoOldNote', name: 'Old Note', model: { file: 'clutter\\note01.nif' }, text: 'x' });
    const plan = exampleQuestPlan();
    plan.items = [
      { key: 'page', name: 'Torn Page', kind: 'misc', existing: null, basedOn: null, value: 1, startsWith: 'location', startsAtKey: 'tavern', spot: 'on a table; on the bar', copies: 2, text: null, lockedWith: null },
      { key: 'note', name: 'Brynja’s Note', kind: 'book', existing: null, basedOn: null, value: 1, startsWith: 'location', startsAtKey: 'tavern', spot: 'on a table', copies: null, text: '> Meet me at dawn.\n> B.', lockedWith: null },
    ];
    plan.objectives[0]!.targetKey = 'page';
    plan.steps = [
      { from: 0, to: 10, kind: 'talk', targetKey: null, count: null, hours: null, note: 'Brynja asks' },
      { from: 10, to: 20, kind: 'pickup', targetKey: 'page', count: 2, hours: null, note: 'Find both pages' },
      { from: 20, to: 100, kind: 'wait', targetKey: null, count: null, hours: 24, note: 'Come back tomorrow' },
    ];
    plan.conversations = [{ title: 'Brynja', screenplay: plan.conversations[0]!.screenplay.replace('[takes ring x1] ', '') }];
    plan.encounters = [{ key: 'wolves', what: 'DemoGuard', count: 2, locationKey: 'tavern', spot: null }];
    plan.events = [{ atStage: 20, kind: 'show', targetKey: 'wolves', toKey: null, what: null, count: null, note: 'They burst in' }];
    plan.animations = [];
    expect(validatePlan(plan).filter((x) => x.severity === 'error')).toEqual([]);
    const r = await builder.build(plan);
    const quest = r.quest!;
    // The note says what the plan says, in the handwritten font.
    const note = ws.byEditorId('InnkeeperRingQuestBrynjasNote')!;
    expect((ws.view(note)!.data as { text: string }).text).toBe("<font face='$HandwrittenFont'>Meet me at dawn.\nB.</font>");
    expect(bookText('The Coldwater Survey', 'Roads.')).toBe('<p align="left">Roads.</p>');
    // Two pages on the tables, and having both moves the quest on; a day after stage 20 it's done.
    const page = ws.byEditorId('InnkeeperRingQuestTornPage')!;
    const tavern = ws.byEditorId('DemoTavern')!;
    expect(world.references(tavern).filter((x) => x.base === page)).toHaveLength(2);
    const edges = (await graphs.graph(quest)).edges;
    expect(edges.find((e) => e.kind === 'collect')).toMatchObject({ from: 10, to: 20, label: 'Collect 2 × Torn Page' });
    expect(edges.find((e) => e.kind === 'wait')).toMatchObject({ from: 20, to: 100, label: '24 in-game hours pass' });
    expect(await graphs.fragmentCode(quest, 20)).toMatch(/GetAlias\(\d+\)\.RegisterForSingleUpdateGameTime\(24\.0\)/);
    expect(await graphs.fragmentCode(quest, 10)).toMatch(/GetAlias\(\d+\)\.RegisterForSingleUpdate\(0\.5\)/);
    // The ambush waits hidden until stage 20 shows it.
    expect(r.notes).toContain('2 DemoGuard start hidden and appear at stage 20.');
    expect(await graphs.fragmentCode(quest, 20)).toContain('as ObjectReference).Enable()');
    // Taking the wait back out removes its line from stage 20 too.
    await graphs.removeEdge(quest, edges.find((e) => e.kind === 'wait')!);
    expect(await graphs.fragmentCode(quest, 20)).not.toContain('RegisterForSingleUpdateGameTime');
  });

  it('puts characters and enemies outdoors on the ground, together, with the arrival marker where they are', async () => {
    const { ws, builder, world, graphs } = await setup();
    const plan = exampleQuestPlan();
    plan.locations.push({ key: 'valley', name: 'Demo Valley', existing: 'DemoValley1_0', description: 'Outside', layoutLike: null, doorFrom: null });
    plan.characters[1]!.locationKey = 'valley';
    plan.characters[1]!.spot = null;
    plan.encounters = [{ key: 'bandits', what: 'DemoGuard', count: 2, locationKey: 'valley', spot: null }];
    plan.steps.push({ from: 20, to: 30, kind: 'arrive', targetKey: 'valley', count: null, hours: null, note: 'Reach the valley' });
    plan.stages.splice(3, 0, { index: 30, journal: 'I reached the valley.', startsQuest: false, completesQuest: false, failsQuest: false });
    plan.steps[2]!.from = 30;
    const r = await builder.build(plan);
    const cell = ws.byEditorId('DemoValley1_0')!;
    const eirik = world.references(cell).find((x) => x.sig === 'ACHR' && x.baseName === 'Eirik')!;
    const p = eirik.transform.position;
    // On the ground (the terrain's height there), inside the cell.
    expect(p.x).toBeGreaterThan(4096);
    expect(p.x).toBeLessThan(8192);
    expect(Math.abs(p.z - world.groundHeight(cell, p.x, p.y)!)).toBeLessThan(2);
    const bandits = world.references(cell).filter((x) => x.sig === 'ACHR' && x.formKey !== eirik.formKey);
    expect(bandits.map((b) => b.baseName)).toEqual(['Town Guard', 'Town Guard']);
    for (const b of bandits) expect(Math.hypot(b.transform.position.x - p.x, b.transform.position.y - p.y)).toBeLessThan(800);
    expect(r.created.find((c) => c.label.startsWith('Eirik in'))!.label).toContain('(outdoors)');
    // Arriving means coming within about 25 metres of the marker, which stands by Eirik.
    const marker = ws.byEditorId('InnkeeperRingQuestArriveDemoValley1_0Marker')!;
    const m = (ws.view(marker)!.data as { placement: { position: { x: number; y: number } } }).placement.position;
    expect(Math.hypot(m.x - p.x, m.y - p.y)).toBeLessThan(1);
    expect((await graphs.graph(r.quest!)).edges.find((e) => e.kind === 'arrive')).toMatchObject({ from: 20, to: 30 });
  });
});
