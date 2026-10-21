import { describe, expect, it } from 'vitest';
import type { FormKey } from '@tes5/esp';
import {
  DialogueService,
  EXAMPLE_QUEST_DOCUMENT,
  EXAMPLE_RESCUE_DOCUMENT,
  EnvironmentService,
  MemoryFileSystem,
  NpcService,
  PLAN_EXAMPLES,
  QuestBuilder,
  QuestGraphService,
  QuestPlanSchema,
  QuestPlanner,
  QuestService,
  ScriptService,
  TriggerService,
  WorldService,
  Workspace,
  createDemoData,
  describePackage,
  exampleQuestPlan,
  fieldHint,
  keepAskedChanges,
  newWhenRenamed,
  normalizePlan,
  pickPlanExample,
  planCatalog,
  mendStages,
  repairPlan,
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
    p.steps.push({ from: 20, to: 300, kind: 'death', targetKey: 'ring', count: null, hours: null, note: 'Kill the ring' });
    p.characters.push({ ...p.characters[1]!, name: 'Twin' });
    const msgs = validatePlan(p).map((i) => i.message);
    expect(msgs).toContain('Brynja\'s Ring starts in "nowhere", which isn\'t a location in the plan');
    expect(msgs).toContain('A step sets stage 300, which doesn\'t exist');
    expect(msgs.some((m) => /Kill the ring.*character key/.test(m))).toBe(true);
    expect(msgs).toContain('The key "eirik" is used twice');
  });
});

describe('plans that would get stuck', () => {
  const messages = (p: ReturnType<typeof exampleQuestPlan>) => validatePlan(p).map((i) => i.message);

  it('a talk step that no line of dialogue sets', () => {
    const plan = exampleQuestPlan();
    // Eirik's step "tells the player where the ring is" is a talk step, but none of his lines has [stage 15].
    plan.stages.push({ index: 15, journal: 'Eirik told me where the ring is.', startsQuest: false, completesQuest: false, failsQuest: false });
    plan.steps.push({ from: 10, to: 15, kind: 'talk', targetKey: null, count: null, hours: null, note: 'Eirik tells the player where the ring is' });
    expect(messages(plan)).toContain('Nothing moves the quest to stage 15: “Eirik tells the player where the ring is” happens in a conversation, but no line has [stage 15]. Add [stage 15] to the line that does it');
    plan.conversations[1]!.screenplay += '\nPLAYER: Where is it? [if stage 10]\nEIRIK: Under the table. [stage 15]';
    expect(messages(plan).filter((m) => m.includes('stage 15'))).toEqual([]);
  });

  it('an item the player has to hand over but never gets, or loses on the way', () => {
    const plan = exampleQuestPlan();
    expect(validatePlan(plan).filter((i) => /^The player (needs|loses)/.test(i.message))).toEqual([]);
    // The ring is Eirik's and nobody gives it to the player, yet Brynja takes it from them.
    plan.items[0] = { ...plan.items[0]!, startsWith: 'character', startsAtKey: 'eirik', spot: null, copies: null, text: null, lockedWith: null };
    plan.steps = plan.steps.filter((st) => st.kind !== 'pickup');
    expect(messages(plan)).toContain("The player needs Brynja's Ring ([takes ring] or [if has ring]) but never gets it: put it somewhere to pick up (startsWith \"location\" and a pickup step), have its owner hand it over with [gives ring x1], or give it as a reward");
    // Eirik hands it over: fine.
    plan.conversations[1]!.screenplay += '\nPLAYER: Give me the ring. [if stage 10]\nEIRIK: Fine. [gives ring x1] [stage 20]';
    expect(messages(plan).filter((m) => m.startsWith('The player needs'))).toEqual([]);
    // Eirik takes it back on a line that doesn't move the quest on: the player can't finish.
    plan.conversations[1]!.screenplay += "\nPLAYER: Here, hold this. [if stage 20]\nEIRIK: Thanks. [takes ring x1]";
    expect(messages(plan).some((m) => m.startsWith("The player loses Brynja's Ring when Eirik takes it (Eirik, line"))).toBe(true);
  });
});

describe('plans that would play wrong', () => {
  it('a line that moves the quest on whenever it is chosen, and the stage it gets tied to', () => {
    const plan = exampleQuestPlan();
    // Two endings chosen at stage 20, written with nothing limiting when they're offered.
    plan.stages.push({ index: 110, journal: 'I kept the ring and Brynja trained me instead.', startsQuest: false, completesQuest: true, failsQuest: false });
    plan.steps.push({ from: 20, to: 110, kind: 'talk', targetKey: null, count: null, hours: null, note: 'The player asks for training instead' });
    plan.conversations[0]!.screenplay += '\nPLAYER: Teach me instead.\nBRYNJA: Very well. [skill Speech x1] [stage 110] [goodbye]';
    expect(validatePlan(plan).map((i) => i.message)).toContain("“Teach me instead.” (Brynja) moves the quest to stage 110 whenever it's chosen, even before the quest gets there, so the player can skip ahead. Add [if stage N] for the stage it belongs to");
    // An AI's plan is mended from its own step: offered at stage 20 only.
    expect(repairPlan(plan)).toContain('“Teach me instead.” in “Brynja” is offered only at stage 20');
    expect(plan.conversations[0]!.screenplay).toContain('PLAYER: Teach me instead. [if stage 20]');
    expect(validatePlan(plan).filter((i) => /whenever it's chosen/.test(i.message))).toEqual([]);
  });

  it('an item to pick up that someone carries and never lets go of', () => {
    const plan = exampleQuestPlan();
    // Brynja holds her own ring, yet the plan says the player picks it up.
    plan.items[0] = { ...plan.items[0]!, startsWith: 'character', startsAtKey: 'brynja', spot: null, copies: null, text: null, lockedWith: null };
    const msg = "The player has to pick up Brynja's Ring, but Brynja carries it and never hands it over or dies: put it on the character it should be taken from (one who fights or dies), somewhere to pick up, or have Brynja hand it over with [gives ring x1]";
    expect(validatePlan(plan).map((i) => i.message)).toContain(msg);
    // Eirik has it and dies for it: fine.
    plan.items[0]!.startsAtKey = 'eirik';
    plan.characters[1]!.combat = { hostile: true, levelScaled: null, skills: [], spells: [], perks: [], combatStyle: null };
    expect(validatePlan(plan).some((i) => i.message.startsWith('The player has to pick up'))).toBe(false);
  });

  it('mends extras that would stop an AI plan building, and a failure that would complete the quest', () => {
    const plan = exampleQuestPlan();
    plan.events = [{ atStage: 100, kind: 'startQuest', targetKey: null, toKey: null, what: null, count: null, note: 'Player receives gold' }];
    plan.animations = [{ atStage: 20, characterKey: 'nobody', gesture: 'wave' }];
    plan.failures = [{ kind: 'timeLimit', targetKey: null, days: 3, fromStage: 10, failStage: 100, note: 'Three days' }];
    expect(validatePlan(plan).some((i) => i.severity === 'error')).toBe(true);
    const changes = repairPlan(plan);
    expect(changes).toEqual(
      expect.arrayContaining([
        'left out the event “Player receives gold” (it doesn\'t say what it acts on, or its stage doesn\'t exist)',
        'left out 1 animation(s) by nobody in the plan, or at a stage that doesn\'t exist',
        '“Three days” sets the new stage 200, which fails the quest (stage 100 completes it)',
      ]),
    );
    expect(plan.stages.find((x) => x.index === 200)).toMatchObject({ failsQuest: true, completesQuest: false });
    expect(validatePlan(plan).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('has the holder hand over an item the player must deliver, when the job is taken', () => {
    const plan = exampleQuestPlan();
    // Brynja keeps the ring and Eirik takes it from the player: Brynja hands it over when the job is taken.
    plan.items[0] = { ...plan.items[0]!, startsWith: 'character', startsAtKey: 'brynja', spot: null, copies: null, text: null, lockedWith: null };
    plan.steps = plan.steps.filter((st) => st.kind !== 'pickup');
    plan.conversations[0]!.screenplay = plan.conversations[0]!.screenplay.replace('[takes ring x1] ', '');
    plan.conversations[1]!.screenplay += '\nPLAYER: Brynja sent this. [if stage 10]\nEIRIK: Ah, the ring. [takes ring x1] [stage 20] [goodbye]';
    expect(validatePlan(plan).some((i) => i.message.startsWith("The player needs Brynja's Ring"))).toBe(true);
    expect(repairPlan(plan)).toContain("Brynja hands over Brynja's Ring when the job is taken (Brynja)");
    expect(plan.conversations[0]!.screenplay).toContain("BRYNJA: Thank you. Try the tables, I was clearing them all morning. [goodbye] [gives ring x1]");
    expect(validatePlan(plan).some((i) => i.message.startsWith('The player needs'))).toBe(false);
  });

  it('a line only offered at the stage it sets moves nothing', () => {
    const plan = exampleQuestPlan();
    plan.conversations[0]!.screenplay = plan.conversations[0]!.screenplay.replace('PLAYER: I found your ring. [if stage 20]', 'PLAYER: I found your ring. [if stage 100]');
    expect(validatePlan(plan).map((i) => i.message)).toContain('Nothing moves the quest to stage 100: “The player returns the ring” happens in a conversation, but no line has [stage 100]. Add [stage 100] to the line that does it');
  });

  it('a “right away” step into a failing stage', () => {
    const plan = exampleQuestPlan();
    plan.stages.push({ index: 90, journal: 'I kept the ring.', startsQuest: false, completesQuest: false, failsQuest: true });
    plan.steps.push({ from: 20, to: 90, kind: 'script', targetKey: null, count: null, hours: null, note: 'The player keeps the ring' });
    expect(validatePlan(plan).map((i) => i.message)).toContain('“The player keeps the ring” fails the quest as soon as stage 20 is reached (a “right away” step into a failing stage). Use a failure instead (a time limit, or someone dying)');
    // With a time limit already failing it, the step is mended away.
    plan.failures.push({ kind: 'timeLimit', targetKey: null, days: 3, fromStage: 10, failStage: 90, note: 'Three days' });
    expect(repairPlan(plan)).toContain('left out 1 step(s) that would fail the quest right away (its failures already do that)');
    expect(plan.steps.some((st) => st.to === 90)).toBe(false);
  });

  it('mends tags the editor does not know in an AI plan, and trains skills from dialogue', async () => {
    const plan = exampleQuestPlan();
    plan.conversations[0]!.screenplay = plan.conversations[0]!.screenplay.replace('[gives gold x100]', '[give gold x100] [skill Archery levels 2] [wink]');
    const changes = repairPlan(plan);
    expect(changes).toEqual(expect.arrayContaining(['[give] → [gives] in “Brynja”', 'took [wink] out of “Brynja” (not a tag the editor knows)']));
    expect(validatePlan(plan).filter((i) => i.severity === 'error')).toEqual([]);
    const { builder, quests, scripts, ws } = await setup();
    const r = await builder.build(plan);
    const info = quests.quest(r.quest!).topics.flatMap((t) => t.infos).find((i) => i.responses.some((x) => x.text.includes('earned this')))!;
    const code = await scripts.read((ws.view(info.formKey)!.data as any).scripts.fragments.fileName);
    expect(code).toContain('Game.IncrementSkillBy("Marksman", 2)');
    expect(code).toContain('AddItem(Game.GetFormFromFile(0x00000F, "Skyrim.esm"), 100)');
  });

  it('mends dialogue slips in an AI plan: a tag left open, stages not in the plan, lines nobody answers', () => {
    const plan = exampleQuestPlan();
    plan.conversations[1]!.screenplay += '\nPLAYER: And the key? [if stage 70]\nEIRIK: Under the mat. [stage 80\nPLAYER: Anything else?\nthis is not a line';
    expect(validatePlan(plan).some((i) => i.severity === 'error')).toBe(true);
    const changes = repairPlan(plan);
    expect(changes).toEqual(expect.arrayContaining(['closed a tag left open in “Eirik”', 'took [if stage 70] out of “Eirik” (there\'s no stage 70)', 'took [stage 80] out of “Eirik” (there\'s no stage 80)']));
    expect(changes.some((c) => /took 2 line\(s\) out of “Eirik”/.test(c))).toBe(true);
    expect(plan.conversations[1]!.screenplay).toContain('PLAYER: And the key?\nEIRIK: Under the mat.');
    expect(validatePlan(plan).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('takes [goodbye] off an answer the player still has choices after', () => {
    const plan = exampleQuestPlan();
    plan.conversations[0]!.screenplay = plan.conversations[0]!.screenplay.replace("I swear it. [if stage 0] [emotion sad]", "I swear it. [if stage 0] [emotion sad] [goodbye]");
    expect(validatePlan(plan).some((i) => i.severity === 'error' && /ends the conversation, so the choices after it never appear/.test(i.message))).toBe(true);
    expect(repairPlan(plan)).toContain('took [goodbye] off a line in “Brynja” that the player still has choices after');
    expect(validatePlan(plan).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('joins a stage that leads nowhere to the completing stage nothing reaches', () => {
    const plan = exampleQuestPlan();
    // "Returned" at 100 no longer completes; a separate 200 does, and nothing gets there.
    plan.stages.find((x) => x.index === 100)!.completesQuest = false;
    plan.stages.push({ index: 200, journal: 'Brynja thanked me again.', startsQuest: false, completesQuest: true, failsQuest: false });
    expect(validatePlan(plan).map((i) => i.message)).toContain('Nothing moves the quest to stage 200: add a step, or a [stage 200] tag on a line of dialogue');
    expect(repairPlan(plan)).toContain('stage 100 led nowhere and nothing reached stage 200, which completes the quest: it now goes straight on from 100 to 200');
    expect(plan.steps.at(-1)).toMatchObject({ from: 100, to: 200, kind: 'script' });
    expect(validatePlan(plan).some((i) => i.message.includes('stage 200'))).toBe(false);
  });

  it('mends what a free AI wrote for a written quest: copies as separate items, the start as a step, a doubled spawn and reward', () => {
    // As Qwen3.5 4B planned "Lines on a Map": three page items in the mine, picked up 20 → 30, 30 → 30, 30 → 30; the
    // notice that starts the quest read again as its first step; bandits spawned where an encounter waits; gold paid
    // by a reward and by the line that ends the quest.
    const plan = exampleQuestPlan();
    plan.locations.push({ key: 'mine', name: 'Embershard Mine', existing: 'EmbershardMine01', description: 'A bandit mine', layoutLike: null, doorFrom: null });
    plan.items = [
      { key: 'notice', name: 'Wanted Notice', kind: 'book', existing: null, basedOn: null, value: null, startsWith: 'location', startsAtKey: 'tavern', spot: 'on the board', copies: null, text: 'Cartographer wanted.', lockedWith: null },
      // (Named "Torn Map Page 1", "2" and "3", as the model did on the next run.)
      ...['by the forge', 'in a chest', 'on a table near the back'].map((spot, n) => ({ key: `mapPage${n + 1}`, name: `Torn Map Page ${n + 1}`, kind: 'misc' as const, existing: null, basedOn: null, value: null, startsWith: 'location' as const, startsAtKey: 'mine', spot, copies: null, text: null, lockedWith: null })),
    ];
    plan.encounters = [{ key: 'bandits', what: 'LvlBanditMelee', count: 3, locationKey: 'mine', spot: null }];
    // The notice listed as a place too; the marker on all three pages at once.
    plan.locations.push({ key: 'notice', name: 'Wanted Notice', existing: null, description: 'Pinned to the bar', layoutLike: null, doorFrom: null });
    plan.startsWithGame = false;
    plan.startsWhen = { kind: 'read', targetKey: 'notice', quest: null, stage: null };
    plan.objectives = [
      { index: 10, text: 'Find the map pages', shownAtStage: 10, completedAtStage: 20, targetKey: 'mapPage1' },
      { index: 11, text: 'Find the map pages', shownAtStage: 10, completedAtStage: 20, targetKey: 'mapPage2;mapPage3' },
      { index: 20, text: 'Return to Brynja', shownAtStage: 20, completedAtStage: 100, targetKey: 'brynja' },
    ];
    plan.steps = [
      { from: 0, to: 10, kind: 'read', targetKey: 'notice', count: null, hours: null, note: 'The player reads the notice' },
      { from: 10, to: 20, kind: 'pickup', targetKey: 'mapPage1', count: null, hours: null, note: 'First page' },
      { from: 20, to: 20, kind: 'pickup', targetKey: 'mapPage2', count: null, hours: null, note: 'Second page' },
      { from: 20, to: 20, kind: 'pickup', targetKey: 'mapPage3', count: null, hours: null, note: 'Third page' },
      { from: 20, to: 100, kind: 'talk', targetKey: null, count: null, hours: null, note: 'The player returns' },
    ];
    plan.events = [{ atStage: 10, kind: 'spawn', targetKey: null, toKey: null, what: 'LvlBanditAmbushMeleeNordM', count: 3, note: 'Bandits appear in Embershard Mine' }];
    plan.rewards = [{ atStage: 100, gold: 100, itemKey: null, skill: null }];
    plan.conversations[0]!.screenplay = plan.conversations[0]!.screenplay.replace('[takes ring x1] ', '');
    const changes = [...repairPlan(plan), ...mendStages(plan)];
    expect(changes).toEqual(
      expect.arrayContaining([
        '3 items called “Torn Map Page” in one place are now one item with 3 copies, found by one step that counts them',
        'the step “The player reads the notice” is what starts the quest, so the quest goes straight on from stage 0 to 10',
        'the spawn “Bandits appear in Embershard Mine” now shows the plan\'s encounter “bandits” at stage 10 (it waits there hidden until then)',
        'the reward of 100 gold at stage 100 is left out: the line that reaches that stage already pays it',
        'left out the place “Wanted Notice”, which is the item of the same name',
        '"mapPage2;mapPage3" → "mapPage2"',
      ]),
    );
    expect(plan.locations.map((l) => l.key)).toEqual(['tavern', 'mine']);
    expect(plan.items.map((i) => i.key)).toEqual(['notice', 'mapPage1']);
    expect(plan.items[1]).toMatchObject({ name: 'Torn Map Page', copies: 3, spot: 'by the forge; in a chest; on a table near the back' });
    expect(plan.steps.map((s) => `${s.from}→${s.to} ${s.kind} ${s.targetKey ?? ''} ${s.count ?? ''}`.trim())).toEqual(['0→10 script', '10→20 pickup mapPage1 3', '20→100 talk']);
    expect(plan.objectives.map((o) => o.targetKey)).toEqual(['mapPage1', 'brynja']);
    expect(plan.events).toEqual([{ atStage: 10, kind: 'show', targetKey: 'bandits', toKey: null, what: null, count: null, note: 'Bandits appear in Embershard Mine' }]);
    expect(plan.rewards).toEqual([]);
    expect(validatePlan(plan).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('mends kinds of step and event a free AI makes up, and an ambush where the player arrives', () => {
    // As Qwen3.5 4B planned "The Apprentice's Road": escorting Rulnik to the stones as a "travel" step, and 4 bandits
    // spawned by the player as they arrive where the plan's encounter already waits.
    const plan = exampleQuestPlan();
    plan.locations.push({ key: 'stones', name: 'The Guardian Stones', existing: null, description: 'Outside', layoutLike: null, doorFrom: null });
    plan.encounters = [{ key: 'bandits', what: 'LvlBanditAmbushMeleeNordM', count: 4, locationKey: 'stones', spot: 'around the stones' }];
    plan.steps[1] = { from: 10, to: 20, kind: 'travel' as never, targetKey: 'stones', count: null, hours: null, note: 'Escort Rulnik to the stones' };
    plan.events = [{ atStage: 20, kind: 'appear' as never, targetKey: 'bandits', toKey: null, what: null, count: null, note: 'Bandits appear' }];
    expect(validatePlan(plan).map((i) => i.message)).toContain('The "Escort Rulnik to the stones" step is a kind of step there isn\'t (“travel”)');
    plan.events.push({ atStage: 20, kind: 'spawn', targetKey: null, toKey: null, what: 'LvlBanditAmbushMeleeNordM', count: 4, note: 'Bandits ambush the player and Rulnik' });
    const changes = repairPlan(plan);
    expect(changes).toEqual(expect.arrayContaining(['the step “Escort Rulnik to the stones” is an arrive step (“travel” isn\'t a kind of step)', 'the event “Bandits appear” is a show event', "left out the spawn “Bandits ambush the player and Rulnik”: the plan's encounter already has them there"]));
    expect(plan.steps[1]!.kind).toBe('arrive');
    expect(plan.events.map((e) => e.kind)).toEqual(['show']);
  });

  it('gives "agree to go, then get there" a stage between, so talking does not skip the walk', () => {
    // As Qwen3.5 4B planned it: Rulnik's "Lead the way" sets stage 20, which arriving at the stones is meant to set.
    const plan = exampleQuestPlan();
    plan.locations.push({ key: 'valley', name: 'Demo Valley', existing: 'DemoValley1_0', description: 'Outside', layoutLike: null, doorFrom: null });
    plan.steps[1] = { from: 10, to: 20, kind: 'arrive', targetKey: 'valley', count: null, hours: null, note: 'Escort Eirik to the valley' };
    plan.conversations[1]!.screenplay = "PLAYER: Brynja sent me. [if stage 10]\nEIRIK: Lead the way. [stage 20]";
    plan.characters[1]!.routine = [{ activity: 'follow', where: null, hours: null, fromStage: 20, untilStage: 100, line: null }];
    expect(validatePlan(plan).map((i) => i.message)).toContain('A line in “Eirik” sets stage 20, which “Escort Eirik to the valley” is meant to reach, so the player can skip it by talking. Take out that [stage 20], or add a talk step if saying it should count');
    expect([...repairPlan(plan), ...mendStages(plan)]).toContain('the line that set stage 20 now sets a stage of its own (15), so “Escort Eirik to the valley” still has to happen after it');
    expect(plan.conversations[1]!.screenplay).toBe('PLAYER: Brynja sent me. [if stage 10]\nEIRIK: Lead the way. [stage 15]');
    expect(plan.steps.map((x) => `${x.from}→${x.to} ${x.kind}`)).toEqual(['0→10 talk', '15→20 arrive', '20→100 talk', '10→15 talk']);
    expect(plan.characters[1]!.routine[0]!.fromStage).toBe(15);
    expect(validatePlan(plan).filter((i) => i.severity === 'error' || /skip it by talking/.test(i.message))).toEqual([]);
  });

  it("gives a failure its own stage when the AI named one the quest goes through, and drops a line's stage the quest is past", () => {
    // As Qwen3.5 4B planned it: "the quest fails if Rulnik dies", failing at stage 20 (arriving at the stones).
    const plan = exampleQuestPlan();
    plan.failures = [{ kind: 'death', targetKey: 'eirik', days: null, fromStage: null, failStage: 20, note: 'Rulnik is dead' }];
    plan.conversations[1]!.screenplay = 'PLAYER: Are you hurt? [if stage 100]\nEIRIK: Hesta needs to know. [stage 20]';
    const changes = [...repairPlan(plan), ...mendStages(plan)];
    expect(changes).toEqual(expect.arrayContaining(['“Rulnik is dead” sets the new stage 200, which fails the quest (stage 20 is one the quest goes through)', 'took [stage 20] off a line in “Eirik” offered at stage 100 (the quest is past it by then)']));
    expect(plan.stages.find((x) => x.index === 20)!.failsQuest).toBe(false);
    expect(plan.failures[0]!.failStage).toBe(200);
    expect(plan.conversations[1]!.screenplay).toBe('PLAYER: Are you hurt? [if stage 100]\nEIRIK: Hesta needs to know.');
  });

  it('gives "kill them, then report back" a stage between, so the report is said', () => {
    // As Qwen3.5 4B planned "The Apprentice's Road": clearing the bandits (20 → 30) completes the quest, and so does
    // the line where the player tells Hesta, offered at 20.
    const plan = exampleQuestPlan();
    plan.encounters = [{ key: 'bandits', what: 'bandit', count: 4, locationKey: 'tavern', spot: null }];
    plan.steps[2] = { from: 20, to: 100, kind: 'clear', targetKey: 'bandits', count: null, hours: null, note: 'All bandits are dead' };
    plan.objectives[1] = { index: 20, text: 'Kill the bandits', shownAtStage: 20, completedAtStage: 100, targetKey: 'bandits' };
    plan.conversations[0]!.screenplay = plan.conversations[0]!.screenplay.replace('[takes ring x1] ', '') + '\nGREETING:\nBRYNJA: They won\'t trouble us now. [if stage 100]';
    const changes = [...repairPlan(plan), ...mendStages(plan)];
    expect(changes).toContain('“All bandits are dead” now reaches a stage of its own (60), and the conversation that reaches stage 100 is offered from there, so the player reports back after it');
    expect(plan.stages.map((x) => x.index)).toEqual([0, 10, 20, 60, 100]);
    expect(plan.steps[2]).toMatchObject({ from: 20, to: 60, kind: 'clear' });
    expect(plan.objectives[1]!.completedAtStage).toBe(60);
    expect(plan.conversations[0]!.screenplay).toContain('PLAYER: I found your ring. [if stage 60]');
    expect(plan.conversations[0]!.screenplay).toContain("BRYNJA: They won't trouble us now. [if stage 60]");
    expect(validatePlan(plan).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('has the character a talk step names move the quest on, and lets a key be pickpocketed', () => {
    // As Qwen3.5 4B planned "Business After Dark": "Hulda tells the player Varro keeps strange hours" (0 → 10), with
    // nothing Hulda says tagged; Varro's key to be pickpocketed.
    const plan = exampleQuestPlan();
    plan.characters[1] = { ...plan.characters[1]!, key: 'hulda', name: 'Hulda' };
    plan.characters.push({ ...plan.characters[1]!, key: 'varro', name: 'Varro Tullius' });
    plan.steps[0] = { from: 0, to: 10, kind: 'talk', targetKey: null, count: null, hours: null, note: 'Hulda tells the player Varro keeps strange hours' };
    plan.conversations[1] = { title: '✎ Hulda', screenplay: "PLAYER: I'm looking for an Imperial called Varro. [if day]\nHULDA: The Imperial? He keeps strange hours." };
    plan.conversations.push({ title: '✎ Varro Tullius', screenplay: 'PLAYER: Who are you? [if night]\nVARRO: A collector.' });
    plan.conversations[0]!.screenplay = plan.conversations[0]!.screenplay.replace(' [stage 10]', '');
    plan.items.push({ key: 'key', name: "Varro's Strongbox Key", kind: 'key', existing: null, basedOn: null, value: null, startsWith: 'character', startsAtKey: 'varro', spot: null, copies: null, text: null, lockedWith: null });
    plan.steps[1] = { ...plan.steps[1]!, targetKey: 'key', note: 'Player pickpockets the key from Varro' };
    expect(mendStages(plan)).toContain('“Hulda tells the player Varro keeps strange hours”: what Hulda answers to “I\'m looking for an Imperial called Varro.” moves the quest to stage 10');
    expect(plan.conversations[1]!.screenplay).toBe("PLAYER: I'm looking for an Imperial called Varro. [if day] [if stage 0]\nHULDA: The Imperial? He keeps strange hours. [stage 10]");
    expect(validatePlan(plan).map((i) => i.message).filter((m) => /stage 10|pick up/.test(m))).toEqual([]);
  });

  it('has the plan\'s characters attack instead of spawning enemies, and lets the player walk back', () => {
    // As Qwen3.5 4B planned "Settling Accounts".
    const plan = exampleQuestPlan();
    plan.characters.push({ ...plan.characters[1]!, key: 'gerda', name: 'Gerda Stone-Arm' });
    plan.events = [
      { atStage: 20, kind: 'spawn', targetKey: null, toKey: null, what: 'LvlSilverHandMelee1H', count: 1, note: 'Gerda and Eirik attack the player' },
      { atStage: 100, kind: 'movePlayer', targetKey: null, toKey: 'tavern', what: null, count: null, note: 'The player moves to Brynja' },
      { atStage: 20, kind: 'spawn', targetKey: null, toKey: null, what: 'wolf', count: 2, note: 'Wolves attack on the road' },
    ];
    expect(repairPlan(plan)).toEqual(expect.arrayContaining(['“Gerda and Eirik attack the player” makes Eirik and Gerda Stone-Arm attack, instead of spawning enemies', 'left out “The player moves to Brynja”: the player walks there themselves']));
    expect(plan.events.map((e) => `${e.kind} ${e.targetKey ?? e.what}`)).toEqual(['hostile eirik', 'hostile gerda', 'spawn wolf']);
  });

  it('puts an item locked away with a key in a strongbox where its holder stays', () => {
    // As Qwen3.5 4B planned "Business After Dark": the ledger locked with Varro's key, but carried by Varro.
    const plan = exampleQuestPlan();
    plan.items.push(
      { key: 'strongboxKey', name: "Varro's Strongbox Key", kind: 'key', existing: null, basedOn: null, value: null, startsWith: 'character', startsAtKey: 'eirik', spot: null, copies: null, text: null, lockedWith: null },
      { key: 'ledger', name: "Varro's Ledger", kind: 'book', existing: null, basedOn: null, value: null, startsWith: 'character', startsAtKey: 'eirik', spot: null, copies: null, text: 'Paid half.', lockedWith: 'strongboxKey' },
    );
    plan.characters[1]!.inventory = [{ item: 'StrongboxKey', count: 1 }, { item: 'Bottle of Mead', count: 2 }];
    const changes = repairPlan(plan);
    expect(changes).toContain("Varro's Ledger is locked away with strongboxKey, so it lies in a strongbox where Eirik stays");
    // The key in Eirik's inventory is the plan's own key: it isn't looked for in the load order as well.
    expect(changes).toContain("Eirik carries Varro's Strongbox Key, the plan's own item");
    expect(plan.characters[1]!.inventory).toEqual([{ item: 'Bottle of Mead', count: 2 }]);
    expect(plan.items.at(-1)).toMatchObject({ startsWith: 'location', startsAtKey: 'tavern', spot: 'in a locked strongbox' });
    expect(validatePlan(plan).filter((i) => /locked|isn't put in a container/.test(i.message))).toEqual([]);
  });

  it('leaves alone items of one name in different places, an ambush away from the encounter, and gold no line pays', () => {
    const plan = exampleQuestPlan();
    plan.items.push({ ...plan.items[0]!, key: 'ring2', startsAtKey: 'cellar' });
    plan.locations.push({ key: 'cellar', name: 'Cellar', existing: null, description: 'Under the tavern', layoutLike: 'DemoTavern', doorFrom: 'tavern' });
    plan.encounters = [
      { key: 'rats', what: 'skeever', count: 2, locationKey: 'cellar', spot: null },
      { key: 'thugs', what: 'bandit', count: 2, locationKey: 'cellar', spot: null },
    ];
    // Bandits wait in the cellar; these come for the player wherever they are.
    plan.events = [{ atStage: 20, kind: 'spawn', targetKey: null, toKey: null, what: 'LvlBanditMelee', count: 2, note: 'Thieves come for the ring on the road' }];
    plan.rewards = [{ atStage: 20, gold: 25, itemKey: null, skill: null }];
    const changes = [...repairPlan(plan), ...mendStages(plan)];
    expect(changes.filter((c) => /copies|spawn|reward/.test(c))).toEqual([]);
    expect(plan.items).toHaveLength(2);
    expect(plan.events).toHaveLength(1);
    expect(plan.rewards).toHaveLength(1);
  });

  it('mends a key used twice in an AI plan: an item listed as a character too', () => {
    const plan = exampleQuestPlan();
    plan.characters.push({ ...plan.characters[1]!, key: 'ring', name: "Brynja's Ring", existing: 'Gold Ring', routine: [], outfit: null });
    plan.items.push({ ...plan.items[0]! });
    expect(validatePlan(plan).map((i) => i.message)).toContain('The key "ring" is used twice');
    expect(repairPlan(plan)).toEqual(expect.arrayContaining(["left out the character “Brynja's Ring”, which is the item of the same name", 'a second “ring” in items is now “ring2”']));
    expect(validatePlan(plan).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('mends the slips of a plan written out by hand: lists left out, [] for none', () => {
    const plan = exampleQuestPlan() as any;
    delete plan.events;
    delete plan.assumptions;
    plan.characters[1].roles = [];
    expect(QuestPlanSchema.safeParse(plan).success).toBe(false);
    expect(QuestPlanSchema.safeParse(normalizePlan(plan)).success).toBe(true);
  });

  it('a line that lets the player talk their way past something they should do', () => {
    const plan = exampleQuestPlan();
    plan.conversations[0]!.screenplay += '\nPLAYER: Never mind the ring.\nBRYNJA: Fine, call it found. [stage 20] [goodbye]';
    expect(validatePlan(plan).map((i) => i.message)).toContain('A line in “Brynja” sets stage 20, which “The player finds the ring” is meant to reach, so the player can skip it by talking. Take out that [stage 20], or add a talk step if saying it should count');
  });

  it('two endings in lines nobody chooses between', () => {
    const plan = exampleQuestPlan();
    plan.stages.push({ index: 110, journal: 'Brynja trained me instead.', startsQuest: false, completesQuest: true, failsQuest: false });
    // One speaker's lines in a row are one answer: only the last stage would count, and both gifts would happen.
    const answer = plan.conversations[0]!.screenplay.replace('[stage 100] [emotion happy] [goodbye]', '[stage 100]\nBRYNJA: Or I could train you. [skill Speech x1] [stage 110] [goodbye]');
    expect(validatePlan({ ...plan, conversations: [{ ...plan.conversations[0]!, screenplay: answer }, plan.conversations[1]!] }).some((i) => i.severity === 'error' && /BRYNJA's lines in a row are said as one answer, but they set two stages \(100, then 110\)/.test(i.message))).toBe(true);
    // A scene plays every line: both would happen.
    plan.conversations[0]!.screenplay += '\nSCENE: Reward [at stage 20]\nBRYNJA: Here, gold. [stage 100]\nEIRIK: Or training. [stage 110]';
    expect(validatePlan(plan).map((i) => i.message)).toContain('The scene “Reward” in “Brynja” set stages 100 and 110: lines nobody prompts all play, so all of it happens. Put choices on PLAYER lines instead');
  });

  it('a journal entry on the first stage of a quest that runs from the start', () => {
    const plan = exampleQuestPlan();
    expect(validatePlan(plan).filter((i) => i.message.startsWith('The quest starts with the game, so stage'))).toEqual([]);
    plan.stages[0]!.journal = 'I arrived at the tavern.';
    expect(validatePlan(plan).map((i) => i.message)).toContain("The quest starts with the game, so stage 0's journal entry shows in the journal from the very start, before the player has met anyone. Leave it empty and write the entry on the stage where the quest is given");
  });

  it('a new character planned as an existing one with another name is made new, copied from them', async () => {
    const { ws } = await setup();
    const plan = exampleQuestPlan();
    plan.characters[1] = { ...plan.characters[1]!, existing: 'DemoBlacksmith', basedOn: null };
    expect(newWhenRenamed(ws, plan, 'A new traveller called Eirik saw the ring fall.')).toEqual(['Eirik is a new character, copied from Halvar the Smith (DemoBlacksmith)']);
    expect(plan.characters[1]).toMatchObject({ existing: null, basedOn: 'DemoBlacksmith' });
    expect(plan.assumptions.at(-1)).toBe('Eirik is a new character, copied from Halvar the Smith (DemoBlacksmith)');
    // Named like them: kept.
    plan.characters[1] = { ...plan.characters[1]!, name: 'Halvar', existing: 'DemoBlacksmith', basedOn: null };
    expect(newWhenRenamed(ws, plan, 'Halvar saw the ring fall.')).toEqual([]);
    expect(plan.characters[1]!.existing).toBe('DemoBlacksmith');
    // The text names them, but as someone else: a character with a name of their own is new (Hesta Coldwater planned
    // as Gerda, on Skyrim's data).
    plan.characters[1] = { ...plan.characters[1]!, name: 'Eirik Coldwater', existing: 'Halvar the Smith', basedOn: null };
    expect(newWhenRenamed(ws, plan, 'Eirik Coldwater, a traveller, argues with Halvar the Smith.')).toEqual(['Eirik Coldwater is a new character, copied from Halvar the Smith (DemoBlacksmith)']);
  });
});

describe('changes to characters already in the game', () => {
  const text = "Hulda at the Bannered Mare has lost her mother's ring. The player brings it back to Hulda, who pays 100 gold.";
  const existing = () => {
    const plan = exampleQuestPlan();
    plan.characters[0] = {
      ...plan.characters[0]!,
      existing: 'Hulda',
      sex: 'female',
      race: 'NordRace',
      voice: 'FemaleNord',
      essential: true,
      className: 'VendorPawnbroker',
      level: 10,
      factions: [{ faction: 'ServicesWhiterunBanneredMare', rank: 0 }],
      routine: [
        { activity: 'sandbox', where: null, hours: null, fromStage: null, untilStage: null, line: null },
        { activity: 'forcegreet', where: null, hours: null, fromStage: 20, untilStage: null, line: 'You found it?' },
      ],
      roles: { follower: false, marriage: false, innkeeper: true, merchant: null, trainer: null },
      relationships: [{ with: 'player', rank: 'friend' }],
    };
    return plan;
  };

  it('a free AI only changes what the text asks for; quest behaviour stays', () => {
    const plan = existing();
    expect(keepAskedChanges(plan, text)).toEqual(['Brynja']);
    expect(plan.characters[0]).toMatchObject({ sex: null, race: null, voice: null, essential: null, className: null, level: null, factions: [], roles: null, relationships: [] });
    expect(plan.characters[0]!.routine.map((r) => r.activity)).toEqual(['forcegreet']);
    expect(plan.assumptions.at(-1)).toBe("Left as they are in the game, since the text doesn't ask to change them: Brynja");
    // New characters keep everything.
    expect(plan.characters[1]!.outfit).not.toBeNull();
  });

  it('keeps what the text does ask for', () => {
    const plan = existing();
    keepAskedChanges(plan, `${text} Make Hulda essential and level 30, and she's friends with the player.`);
    expect(plan.characters[0]).toMatchObject({ essential: true, level: 10, relationships: [{ with: 'player', rank: 'friend' }], className: null, roles: null });
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
    // His routine: about his business in the tavern by day, asleep there at night (the copied routine is gone).
    expect(ed.packages.map((k: FormKey) => describePackage(ws, k))).toEqual(['goes about their business in The Demo Tavern 08:00–22:00', 'sleeps in The Demo Tavern 22:00–08:00']);
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
    const g = await graphs.graph(report.quest!);
    expect(g.startGameEnabled).toBe(true);
    expect(g.nodes.map((n) => n.stage)).toEqual([0, 10, 20, 100]);
    expect(g.nodes.find((n) => n.stage === 10)!.text).toContain('lost her mother’s ring');
    expect(g.nodes.find((n) => n.stage === 100)!.completesQuest).toBe(true);
    expect(g.nodes.find((n) => n.stage === 20)).toMatchObject({ shows: [20], completes: [10] });
    expect(g.objectives.map((o) => o.text)).toEqual(['Find Brynja’s ring', 'Return the ring to Brynja']);
    const q = quests.quest(report.quest!);
    expect(q.aliases.map((a) => a.name).sort()).toEqual(['DemoInnkeeper', 'InnkeeperRingQuestBrynjaSRingRef', 'InnkeeperRingQuestEirik']);

    // What moves it on: Brynja's lines, then picking up the ring, then Brynja again.
    expect(g.edges.map((e) => `${e.from}->${e.to}:${e.kind}`).sort()).toEqual(['0->10:talk', '10->20:pickup', '20->100:talk']);
    expect(g.problems).toEqual([]);
    expect(report.problems).toEqual([]);

    // Dialogue: speakers resolved to the real characters, the ring and gold change hands.
    const d = dialogue.graph(report.quest!);
    expect(d.infos.some((i) => i.speaker === eirik && i.needsStage === 10)).toBe(true);
    const thanks = d.infos.find((i) => i.lines[0]?.startsWith('Oh, thank the gods'))!;
    expect(thanks.speaker).toBe(k('DemoInnkeeper'));
    const frag = (ws.view(thanks.formKey)!.data as any).scripts.fragments.fileName as string;
    const src = await scripts.read(frag);
    expect(src).toContain('GetOwningQuest().SetStage(100)');
    expect(src).toMatch(/Game\.GetPlayer\(\)\.RemoveItem\(Game\.GetFormFromFile\(0x[0-9A-F]{6}, "Built\.esp"\), 1\)/);
    expect(src).toContain('Game.GetPlayer().AddItem(Game.GetFormFromFile(0x00000F, "Skyrim.esm"), 100)');
    // Gestures: applause isn't in the demo, so it's sent as an animation event, as the line starts.
    expect(src).toContain('Debug.SendAnimationEvent(akSpeaker, "IdleApplaud2")');
    expect((ws.view(thanks.formKey)!.data as any).scripts.fragments.flags).toBe(3);
    // Eirik laughs (the demo has IdleLaugh, so it's played as the idle form) when the ring is found.
    expect(await graphs.fragmentCode(report.quest!, 20)).toMatch(/Alias_InnkeeperRingQuestEirik\.GetActorReference\(\)\.PlayIdle\(Game\.GetFormFromFile\(0x[0-9A-F]{6}, "DemoWorld\.esm"\) as Idle\)/);

    expect(report.created.map((c) => c.kind).sort()).toEqual(['character', 'item', 'outfit', 'package', 'package', 'placed', 'placed', 'quest']);
    // Eirik as described: outfit saved, faction, class, level, carried items, look.
    const outfit = ws.byEditorId('EirikTravelOutfit')!;
    const e2 = ed;
    expect(e2.defaultOutfit).toBe(outfit);
    expect((ws.view(outfit)!.data as any).items).toEqual([k('DemoClothesBlue'), k('DemoBootsLeather')]);
    expect(e2.factions.map((f: any) => f.faction)).toEqual([k('DemoTownFaction')]);
    expect(e2.class).toBe(k('DemoWarriorClass'));
    expect(e2.config.level).toBe(6);
    expect(e2.items).toEqual([{ item: { item: k('DemoBottle'), count: 2 } }]);
    expect(e2.weight).toBe(70);
    expect(e2.height).toBeCloseTo(1.02);
    expect(e2.hairColor).toBe(k('HairColorBrown'));
    expect(e2.headParts).toContain(k('DemoHairShort'));
    expect(e2.headParts).toContain(k('DemoBeardFull'));
    expect(e2.headParts).toContain(k('DemoHeadMale'));
    expect(report.reused.map((r) => r.label).sort()).toEqual(['Brynja (DemoInnkeeper)', 'The Demo Tavern (DemoTavern)']);
    expect(report.notes.some((n) => n.includes('face files'))).toBe(true);

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
    plan.locations.push({ key: 'cellar', name: 'Old Cellar', existing: null, description: 'Under the tavern', layoutLike: null, doorFrom: null });
    plan.characters[1]!.locationKey = 'cellar';
    plan.items.push({ key: 'note', name: 'Crumpled Note', kind: 'book', existing: null, basedOn: null, value: 1, startsWith: 'character', startsAtKey: 'eirik', spot: null, copies: null, text: null, lockedWith: null });
    plan.items.push({ key: 'charm', name: 'Lucky Charm', kind: 'misc', existing: null, basedOn: null, value: 10, startsWith: 'player', startsAtKey: null, spot: null, copies: null, text: null, lockedWith: null });
    plan.rewards.push({ atStage: 100, gold: 25, itemKey: 'charm', skill: { skill: 'Archery', levels: 2 } });
    plan.steps.push({ from: 10, to: 20, kind: 'read', targetKey: 'note', count: null, hours: null, note: 'Read the note' });
    plan.steps.push({ from: 0, to: 10, kind: 'talk', targetKey: null, count: null, hours: null, note: 'duplicate' });
    plan.steps.push({ from: 20, to: 20, kind: 'talk', targetKey: null, count: null, hours: null, note: 'Nobody says this' });
    plan.stages.push({ index: 50, journal: '', startsQuest: false, completesQuest: false, failsQuest: false });
    plan.steps.push({ from: 20, to: 50, kind: 'talk', targetKey: null, count: null, hours: null, note: 'Mention the cellar' });
    const r = await builder.build(plan, { seed: 7 });
    const cell = ws.byEditorId('CellarQuestOldCellar')!;
    expect(world.references(cell).map((x) => ws.summary(x.base!)?.name)).toEqual(['Eirik']);
    expect(r.notes.some((n) => n.includes('Old Cellar is a new, empty interior'))).toBe(true);
    const eirik = ws.byEditorId('CellarQuestEirik')!;
    const note = ws.byEditorId('CellarQuestCrumpledNote')!;
    // The note Eirik carries is one the quest follows (reading it moves it on): it's made in his inventory when
    // the quest starts, through an alias, rather than added to his own inventory.
    expect((ws.view(eirik)!.data as any).items).toEqual([{ item: { item: ws.byEditorId('DemoBottle'), count: 2 } }]);
    // Fallback: there's no book in the demo to copy, so it's a misc item.
    expect(ws.summary(note)!.sig).toBe('MISC');
    expect(r.notes.some((n) => n.includes('Crumpled Note should be a book'))).toBe(true);
    expect((await graphs.graph(r.quest!)).edges.find((e) => e.kind === 'read')).toMatchObject({ from: 10, to: 20, target: note });
    expect(r.warnings.some((w) => w.includes('Nothing said in a conversation sets stage 50'))).toBe(true);
    const start = await graphs.fragmentCode(r.quest!, 0);
    expect(start).toMatch(/Game\.GetPlayer\(\)\.AddItem\(Game\.GetFormFromFile\(0x[0-9A-F]{6}, "Built\.esp"\), 1\)/);
    const end = await graphs.fragmentCode(r.quest!, 100);
    expect(end).toContain('SetObjectiveCompleted(20)');
    expect(end).toContain('AddItem(Game.GetFormFromFile(0x00000F, "Skyrim.esm"), 25)');
    expect(end).toContain('Game.IncrementSkillBy("Marksman", 2)');
    expect(r.problems).toContain('Nothing leads to stage 50.');
    // A skill that isn't one is caught before building.
    plan.rewards[0]!.skill = { skill: 'Juggling', levels: 1 };
    expect(validatePlan(plan).map((i) => i.message)).toContain('A reward trains “Juggling”, which isn\'t a skill (try Archery, One-handed, Speech, Destruction…)');
  });

  it('copies a new item from one named like it, so it looks the part', async () => {
    const { builder } = await setup();
    const plan = exampleQuestPlan();
    plan.items[0] = { ...plan.items[0]!, name: "Brynja's Old Bowl", basedOn: null };
    const res = builder.resolve(plan).find((r) => r.kind === 'item')!;
    expect(res.text).toBe('New, copied from Bowl (DemoBowl)');
  });

  it('copies a key only from a key, so it can lock something', async () => {
    const { builder, ws } = await setup();
    ws.createRecord('KEYM', { editorId: 'DemoOldKey', name: 'Old Key', model: { file: 'clutter\\key01.nif' } });
    const plan = exampleQuestPlan();
    // As Qwen3.5 4B planned it: "Varro's Strongbox Key", based on Fine Clothes.
    plan.items[0] = { ...plan.items[0]!, kind: 'key', name: "Varro's Strongbox Key", basedOn: 'Blue Fine Clothes' };
    const res = builder.resolve(plan).find((r) => r.kind === 'item')!;
    expect(ws.summary(res.template!)?.sig).toBe('KEYM');
  });

  it('follows quest items characters carry: taken from their body, handed over, delivered', async () => {
    const { ws, builder, graphs, quests, scripts } = await setup();
    const plan = exampleQuestPlan();
    // Eirik has the ring; killing him and taking it moves the quest on, and Brynja takes it back.
    plan.items[0] = { ...plan.items[0]!, startsWith: 'character', startsAtKey: 'eirik', spot: null, copies: null, text: null, lockedWith: null };
    plan.steps = plan.steps.map((st) => (st.kind === 'pickup' ? { ...st, note: 'Take the ring from Eirik' } : st));
    plan.conversations = [
      { title: 'Brynja', screenplay: "PLAYER: Got any work for me? [if stage 0]\nBRYNJA: Eirik stole my ring. Get it back. [stage 10] [goodbye]\nPLAYER: Here's your ring. [if stage 20] [if has ring x1]\nBRYNJA: Thank you! [takes ring x1] [gives gold x100] [stage 100] [goodbye]" },
      { title: 'Eirik', screenplay: 'PLAYER: Hand over the ring. [if stage 10]\nEIRIK: Fine, take it. [gives ring x1] [goodbye]' },
    ];
    expect(validatePlan(plan).filter((i) => i.severity === 'error')).toEqual([]);
    const r = await builder.build(plan, { seed: 1 });
    expect(r.warnings.filter((w) => /can't be detected/.test(w))).toEqual([]);
    const eirik = ws.byEditorId('InnkeeperRingQuestEirik')!;
    const ring = ws.byEditorId('InnkeeperRingQuestBrynjaSRing')!;
    // Not added to his own inventory: made in it by an alias when the quest starts.
    expect(((ws.view(eirik)!.data as any).items ?? []).some((i: any) => i.item.item === ring)).toBe(false);
    const q = quests.quest(r.quest!);
    const ringAlias = q.aliases.find((a) => (a.fill as any).object === ring)!;
    const eirikAlias = q.aliases.find((a) => (a.fill as any).actor === eirik)!;
    expect(ringAlias.fill).toMatchObject({ object: ring, at: { alias: eirikAlias.id, create: 0x8000 } });
    expect((await graphs.graph(r.quest!)).edges.find((e) => e.kind === 'pickup')).toMatchObject({ from: 10, to: 20, target: ring });
    expect(r.created.some((c) => c.label === "Brynja's Ring, carried by Eirik (InnkeeperRingQuestEirik) (given to them when the quest starts)")).toBe(true);
    // He hands over that very ring, and Brynja takes it; [if has ring] is about it too.
    const code = async (said: string) => {
      const info = quests.quest(r.quest!).topics.flatMap((t) => t.infos).find((i) => i.responses.some((x) => x.text.includes(said)))!;
      return scripts.read((ws.view(info.formKey)!.data as any).scripts.fragments.fileName);
    };
    const ref = `(GetOwningQuest().GetAlias(${ringAlias.id}) as ReferenceAlias).GetReference()`;
    expect(await code('Fine, take it.')).toContain(`akSpeaker.RemoveItem(${ref}, 1, False, Game.GetPlayer())`);
    expect(await code('Thank you!')).toContain(`Game.GetPlayer().RemoveItem(${ref}, 1, False, akSpeaker)`);
    expect(await code('Thank you!')).toContain('AddItem(Game.GetFormFromFile(0x00000F, "Skyrim.esm"), 100)');
    const asks = quests.quest(r.quest!).topics.find((t) => t.text === "Here's your ring.")!;
    expect(asks.infos[0]!.conditions.some((c) => c.param1 === ring)).toBe(true);
  });

  it('lays out a new place like an existing one and puts a door to it', async () => {
    const { ws, builder, world } = await setup();
    const plan = exampleQuestPlan();
    plan.editorId = 'BackRoomQuest';
    plan.locations.push({ key: 'backroom', name: 'Back Room', existing: null, description: 'Behind the tavern', layoutLike: 'DemoTavern', doorFrom: 'tavern' });
    plan.characters[1]!.locationKey = 'backroom';
    expect(validatePlan(plan)).toEqual([]);
    const tavern = ws.byEditorId('DemoTavern')!;
    const before = world.references(tavern).length;
    const r = await builder.build(plan, { seed: 3 });
    const room = ws.byEditorId('BackRoomQuestBackRoom')!;
    const refs = world.references(room);
    // The tavern's statics, furniture and lights, without its people.
    const src = world.references(tavern).filter((x) => x.sig === 'REFR' && !x.disabled);
    expect(refs.filter((x) => x.sig === 'REFR').length).toBeGreaterThanOrEqual(src.length - 1);
    expect(refs.filter((x) => x.sig === 'ACHR').map((x) => ws.summary(x.base!)?.name)).toEqual(['Eirik']);
    expect(ws.view(room)!.data.lighting).toEqual(ws.view(tavern)!.data.lighting);
    // A new door in the tavern, linked both ways with the copied way out.
    const added = world.references(tavern).filter((x) => x.baseSig === 'DOOR' && x.source === 'Built.esp');
    expect(world.references(tavern).length).toBe(before + 2); // the door, and the ring on a table
    expect(added).toHaveLength(1);
    const outer = added[0]!;
    const inner = outer.teleport!;
    expect(ws.view(inner)!.parent.cell).toBe(room);
    expect((ws.view(inner)!.data as any).teleport.door).toBe(outer.formKey);
    expect(r.notes.some((n) => /Back Room got a navmesh/.test(n))).toBe(true);
    expect(ws.search({ sigs: ['NAVM'], limit: 100 }).items.some((n) => ws.view(n.formKey)?.parent.cell === room)).toBe(true);
    // The door is against a wall, with floor in front of it.
    expect(r.notes.some((n) => /stands in the middle/.test(n))).toBe(false);
  });

  it('refuses to copy an outdoor cell, and says so', async () => {
    const { builder } = await setup();
    const plan = exampleQuestPlan();
    plan.editorId = 'OutQuest';
    plan.locations.push({ key: 'yard', name: 'Yard', existing: null, description: '', layoutLike: 'NoSuchCell', doorFrom: null });
    const r = await builder.build(plan);
    expect(r.warnings).toContain('Yard should look like “NoSuchCell”, but there\'s no interior called that, so it\'s empty.');
  });

  it('changes existing characters, with no quest needed', async () => {
    const { ws, builder } = await setup();
    const k = (e: string) => ws.byEditorId(e)!;
    const plan = { ...exampleQuestPlan(), title: 'Halvar’s new look', editorId: 'HalvarChanges', stages: [], objectives: [], steps: [], conversations: [], rewards: [], animations: [], items: [], locations: [], assumptions: [], questions: [] };
    plan.characters = [
      {
        key: 'halvar', name: 'Halvar', existing: 'Halvar the Smith', basedOn: null, sex: null, race: null, role: 'Smith', appearance: 'Now in fine clothes with a hood',
        look: { weight: null, height: null, hair: null, hairColor: 'grey', facialHair: 'none', eyes: null, scar: null },
        voice: null, locationKey: null, spot: null, essential: false, className: null, level: null,
        outfit: { items: ['fine blue clothes', 'hood', 'Leather Boots', 'golden crown'], saveAs: 'HalvarSundayBest' },
        factions: [{ faction: 'Merchants', rank: 1 }], inventory: [{ item: 'tankard', count: 3 }], routine: [], combat: null, roles: null, relationships: [],
      },
    ];
    const res = builder.resolve(plan).find((r) => r.key === 'halvar')!;
    expect(res.text).toBe('Uses Halvar the Smith (DemoBlacksmith), changed');
    expect(res.changes).toEqual(['wears fine blue clothes, hood, Leather Boots, golden crown (saved as HalvarSundayBest)', 'carries 3 × tankard', 'joins Merchants', 'can be killed', 'grey hair colour, no beard']);
    const r = await builder.build(plan);
    expect(r.quest).toBeNull();
    expect(ws.byEditorId('HalvarChanges')).toBeUndefined();
    expect(r.changed.map((c) => c.label)).toEqual(['Halvar the Smith (DemoBlacksmith)']);
    const d = ws.view(k('DemoBlacksmith'))!.data as any;
    expect((ws.view(d.defaultOutfit)!.data as any)).toMatchObject({ editorId: 'HalvarSundayBest', items: [k('DemoClothesBlue'), k('DemoHoodBrown'), k('DemoBootsLeather')] });
    expect(r.warnings).toContain('Halvar: no clothing like “golden crown” in the load order, so it\'s left out of their outfit.');
    expect(d.factions.map((f: any) => [f.faction, f.rank])).toEqual([[k('DemoTownFaction'), 0], [k('DemoMerchantFaction'), 1]]);
    expect(d.items).toEqual([{ item: { item: k('DemoTankard'), count: 3 } }]);
    expect(d.config.flags & 2).toBe(0);
    expect(d.headParts).not.toContain(k('DemoBeardFull'));
    expect(d.headParts).toContain(k('DemoHairShort'));
    expect(r.notes.some((n) => n.includes('comes from DemoWorld.esm'))).toBe(true);
    expect(r.notes.some((n) => n.includes('face files are made again'))).toBe(true);
    expect(ws.undoLabel).toBe('Build Halvar’s new look');
  });

  it('copies a new character from the one the text names, and an existing outfit as is', async () => {
    const { ws, builder } = await setup();
    const plan = exampleQuestPlan();
    plan.characters[1]!.basedOn = 'Town Guard';
    plan.characters[1]!.outfit = { items: ['DemoFarmerOutfit'], saveAs: null };
    expect(builder.resolve(plan).find((r) => r.key === 'eirik')!.text).toBe('New, copied from Town Guard (DemoGuard)');
    await builder.build(plan);
    expect((ws.view(ws.byEditorId('InnkeeperRingQuestEirik')!)!.data as any).defaultOutfit).toBe(ws.byEditorId('DemoFarmerOutfit'));
  });

  it('quest behaviour goes on the alias: follow the player, walk up and speak', async () => {
    const { ws, builder, quests } = await setup();
    const plan = exampleQuestPlan();
    plan.characters[0]!.routine = [{ activity: 'forcegreet', where: null, hours: null, fromStage: 20, untilStage: 100, line: 'Did you find it? Tell me you found it!' }];
    plan.characters[1]!.routine = [{ activity: 'follow', where: null, hours: null, fromStage: 10, untilStage: 20, line: null }];
    const r = await builder.build(plan);
    const q = quests.quest(r.quest!);
    const aliasPk = (name: string) => ((ws.view(r.quest!)!.data as any).aliases.find((a: any) => a.value.name === name).value.packages ?? []) as FormKey[];
    expect(aliasPk('DemoInnkeeper').map((k) => describePackage(ws, k))).toEqual(['comes up to the player and speaks (while the quest is at certain stages)']);
    expect(aliasPk('InnkeeperRingQuestEirik').map((k) => describePackage(ws, k))).toEqual(['follows the player (while the quest is at certain stages)']);
    const fg = ws.view(aliasPk('DemoInnkeeper')[0]!)!;
    expect(fg).toMatchObject({ lossless: true, unknown: [] });
    const d = fg.data as any;
    expect(d.ownerQuest).toBe(r.quest);
    expect(d.counter.template).toBe(ws.byEditorId('ForceGreet'));
    expect(d.conditions.map((c: any) => [c.data.op, c.data.value])).toEqual([['>=', 20], ['<', 100]]);
    const topicValue = d.packageData.values.find((v: any) => v.type === 'Topic');
    const topic = quests.topics(r.quest!).find((t) => t.subtype === 'PFGT')!;
    expect(topicValue.topics).toEqual([{ type: 0, value: topic.formKey }]);
    expect(topic.infos[0]!.responses[0]!.text).toBe('Did you find it? Tell me you found it!');
    expect(d.packageData.values.find((v: any) => v.type === 'SingleRef').target.type).toBe(0);
    // Brynja's own packages are untouched (the quest behaviour lives on the alias).
    expect((ws.view(ws.byEditorId('DemoInnkeeper')!)!.data as any).packages ?? []).toEqual([]);
    expect(q.aliases.length).toBeGreaterThan(0);
  });

  it('places people at named spots or on open floor, and items in containers', async () => {
    const { ws, builder, graphs, world, quests } = await setup();
    const k = (e: string) => ws.byEditorId(e)!;
    const plan = exampleQuestPlan();
    plan.items[0]!.spot = 'in the chest';
    plan.characters.push({ ...plan.characters[1]!, key: 'gerd', name: 'Gerd', spot: null, outfit: null, routine: [] });
    const r = await builder.build(plan, { seed: 3 });
    const refs = world.references(k('DemoTavern'));
    const at = (base: FormKey) => refs.find((x) => x.base === base)!.transform;
    // Eirik by the barrels, facing them, on the floor.
    const eirik = at(k('InnkeeperRingQuestEirik'));
    const barrels = refs.filter((x) => x.baseEditorId === 'DemoBarrel').map((x) => x.transform.position);
    const nearest = barrels.reduce((a, b) => (Math.hypot(b.x - eirik.position.x, b.y - eirik.position.y) < Math.hypot(a.x - eirik.position.x, a.y - eirik.position.y) ? b : a));
    expect(Math.hypot(nearest.x - eirik.position.x, nearest.y - eirik.position.y)).toBeLessThan(160);
    expect(Math.abs(eirik.position.z)).toBeLessThan(5);
    const facing = { x: Math.sin(eirik.rotation.z), y: Math.cos(eirik.rotation.z) };
    const toward = { x: nearest.x - eirik.position.x, y: nearest.y - eirik.position.y };
    expect(facing.x * toward.x + facing.y * toward.y).toBeGreaterThan(0);
    // Gerd on open floor, inside the walls, clear of everyone else.
    const gerd = at(k('InnkeeperRingQuestGerd')).position;
    expect(Math.abs(gerd.x)).toBeLessThan(500);
    expect(Math.abs(gerd.y)).toBeLessThan(500);
    for (const other of refs.filter((x) => x.sig === 'ACHR' && x.base !== k('InnkeeperRingQuestGerd'))) expect(Math.hypot(other.transform.position.x - gerd.x, other.transform.position.y - gerd.y)).toBeGreaterThan(90);
    // The ring is in the chest: that chest has its own copy of the container, holding it.
    const chest = ws.view(k('DemoTavernChestRef'))!.data as any;
    expect(chest.base).not.toBe(k('DemoChest'));
    const ring = k('InnkeeperRingQuestBrynjaSRing');
    expect((ws.view(chest.base)!.data as any).items).toEqual([{ item: { item: ring, count: 1 } }]);
    expect(refs.some((x) => x.base === ring)).toBe(false);
    // Picking it up still moves the quest on, and the marker points at it, through an alias created in the chest.
    const q = quests.quest(r.quest!);
    const ringAlias = q.aliases.find((a) => (a.fill as any).object === ring)!;
    expect(ringAlias.fill).toMatchObject({ object: ring, at: { create: 0x8000 } });
    const g = await graphs.graph(r.quest!);
    expect(g.edges.find((e) => e.kind === 'pickup')).toMatchObject({ from: 10, to: 20, target: ring });
    expect((ws.view(r.quest!)!.data as any).objectives.find((o: any) => o.index === 10).targets[0].target.alias).toBe(ringAlias.id);
    expect(r.created.some((c) => c.label === "Brynja's Ring in the chest in The Demo Tavern (DemoTavern)")).toBe(true);
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

  it('makes things happen at stages: enemies, hostility, doors, appearing, fades', async () => {
    const { ws, builder, graphs } = await setup();
    const plan = exampleQuestPlan();
    plan.events = [
      { atStage: 20, kind: 'spawn', targetKey: 'tavern', toKey: null, what: 'Town Guard', count: 2, note: 'Guards burst in' },
      { atStage: 20, kind: 'hostile', targetKey: 'eirik', toKey: null, what: null, count: null, note: 'Eirik draws his sword' },
      { atStage: 20, kind: 'unlock', targetKey: 'DemoTavernDoorRef', toKey: null, what: null, count: null, note: 'The door unlocks' },
      { atStage: 10, kind: 'show', targetKey: 'ring', toKey: null, what: null, count: null, note: 'The ring appears' },
      { atStage: 100, kind: 'fade', targetKey: null, toKey: null, what: null, count: 3, note: 'Time passes' },
      { atStage: 100, kind: 'moveTo', targetKey: 'eirik', toKey: 'brynja', what: null, count: null, note: 'Eirik joins Brynja' },
      { atStage: 100, kind: 'message', targetKey: null, toKey: null, what: 'Some "time" later', count: null, note: 'Message' },
      { atStage: 100, kind: 'weather', targetKey: null, toKey: null, what: 'NoSuchStorm', count: null, note: 'A storm' },
    ];
    expect(validatePlan(plan)).toEqual([]);
    const report = await builder.build(plan);
    const q = report.quest!;
    const s20 = await graphs.fragmentCode(q, 20);
    expect(s20.match(/\.PlaceActorAtMe\(Game\.GetFormFromFile\(0x[0-9A-F]{6}, "DemoWorld\.esm"\) as ActorBase\)/g)).toHaveLength(2);
    expect(s20).toMatch(/^Alias_\w+\.GetReference\(\)\.PlaceActorAtMe/m);
    expect(s20).toContain('Alias_InnkeeperRingQuestEirik.GetActorReference().StartCombat(Game.GetPlayer())');
    expect(s20).toMatch(/Alias_DemoTavernDoorRef\w*\.GetReference\(\)\.Lock\(False\)/);
    expect(await graphs.fragmentCode(q, 10)).toMatch(/\.GetReference\(\)\.Enable\(\)/);
    // Shown at a stage, so it starts hidden.
    const ring = ws.search({ sigs: ['REFR'], query: 'InnkeeperRingQuestBrynjasRingRef', limit: 5 }).items[0]!.formKey;
    expect(ws.view(ring)!.flags & 0x800).toBe(0x800);
    // The fade wraps the other things that happen at that stage.
    const end = (await graphs.fragmentCode(q, 100)).split('\n').map((l) => l.trim());
    const at = (re: RegExp) => end.findIndex((l) => re.test(l));
    expect(at(/^Game\.FadeOutGame\(True/)).toBeLessThan(at(/MoveTo\(Alias_/));
    expect(at(/MoveTo\(Alias_/)).toBeLessThan(at(/^Game\.FadeOutGame\(False/));
    expect(end).toContain('Debug.Notification("Some \\"time\\" later")');
    expect(report.warnings.some((w) => /A storm.*no weather like “NoSuchStorm”/.test(w))).toBe(true);
  });

  it('starts quests when the player arrives, reads something, or another quest ends', async () => {
    const { ws, builder, graphs } = await setup();
    // Part one starts when the player walks into the tavern.
    const one = exampleQuestPlan();
    one.startsWithGame = false;
    one.startsWhen = { kind: 'arrive', targetKey: 'tavern', quest: null, stage: null };
    expect(validatePlan(one).filter((i) => i.severity === 'error')).toEqual([]);
    const r1 = await builder.build(one);
    const g1 = await graphs.graph(r1.quest!);
    expect(g1.startGameEnabled).toBe(false);
    expect(g1.starts).toEqual([expect.objectContaining({ kind: 'trigger', event: 'arrive' })]);
    expect(r1.notes.some((n) => /starts when the player enters/.test(n))).toBe(true);

    // Part two starts when part one ends (stage 100 completes it).
    const two = exampleQuestPlan();
    two.title = 'The Ring, Part Two';
    two.editorId = 'RingPartTwo';
    two.conversations = [];
    two.steps = two.steps.filter((x) => x.kind !== 'talk');
    two.startsWithGame = false;
    two.startsWhen = { kind: 'afterQuest', targetKey: null, quest: 'InnkeeperRingQuest', stage: null };
    const r2 = await builder.build(two);
    expect(await graphs.fragmentCode(r1.quest!, 100)).toContain(`${graphs.startLine(r2.quest!)}`);
    expect((await graphs.graph(r2.quest!)).starts).toEqual([{ kind: 'afterQuest', label: expect.stringContaining('reaches stage 100'), quest: r1.quest!, stage: 100 }]);

    // A vanilla quest can't start it (its script would have to be rewritten).
    const three = { ...two, editorId: 'RingPartThree', startsWhen: { kind: 'afterQuest' as const, targetKey: null, quest: 'NoSuchQuest', stage: null } };
    const r3 = await builder.build(three);
    expect(r3.warnings.some((w) => /no quest called that/.test(w))).toBe(true);

    // Changing it with a plan swaps the start: now reading the ring would start part one.
    const next = structuredClone(one);
    next.startsWhen = { kind: 'pickup', targetKey: 'ring', quest: null, stage: null };
    expect(await builder.previewUpdate(r1.quest!, next)).toContain('Change what starts the quest');
    await builder.update(r1.quest!, next);
    const starts = (await graphs.graph(r1.quest!)).starts;
    expect(starts).toEqual([expect.objectContaining({ kind: 'trigger', event: 'pickup' })]);
    expect(ws.summary((starts[0] as any).ref)!.sig).toBe('REFR');
  });

  it('says when nothing starts a quest', () => {
    const p = exampleQuestPlan();
    p.startsWithGame = false;
    expect(validatePlan(p).map((i) => i.message)).toContain('Nothing starts the quest: it doesn’t start with the game and has no “starts when…”');
    p.startsWhen = { kind: 'read', targetKey: null, quest: null, stage: null };
    expect(validatePlan(p).map((i) => i.message)).toContain('The quest starts when the player reads something, but doesn’t say what');
  });

  it('remembers choices, fails if someone dies or time runs out, and has two endings', async () => {
    const { ws, builder, graphs, dialogue, scripts } = await setup();
    const plan = exampleQuestPlan();
    plan.stages.push({ index: 110, journal: 'I kept the ring for myself.', startsQuest: false, completesQuest: true, failsQuest: false });
    plan.stages.push({ index: 200, journal: 'Brynja is dead. I will never return her ring now.', startsQuest: false, completesQuest: false, failsQuest: true });
    plan.stages.push({ index: 210, journal: 'I took too long. Brynja has given up on her ring.', startsQuest: false, completesQuest: false, failsQuest: true });
    plan.conversations[1]!.screenplay += `\nPLAYER: Keep quiet about the ring and I'll split it with you. [if stage 20]\nEIRIK: Deal. [remember bribed] [stage 110] [goodbye]\nPLAYER: Anything else? [if chose bribed]\nEIRIK: Not a word, friend. [goodbye]`;
    plan.steps.push({ from: 20, to: 110, kind: 'talk', targetKey: null, count: null, hours: null, note: 'Make a deal with Eirik' });
    plan.failures = [
      { kind: 'death', targetKey: 'brynja', days: null, fromStage: null, failStage: 200, note: 'Brynja dies' },
      { kind: 'timeLimit', targetKey: null, days: 3, fromStage: 10, failStage: 210, note: 'Three days' },
    ];
    expect(validatePlan(plan)).toEqual([]);
    const r = await builder.build(plan);
    const q = r.quest!;
    // The choice is a global that the line sets, and later lines check.
    const glob = ws.byEditorId('InnkeeperRingQuestChoseBribed')!;
    expect(ws.summary(glob)!.sig).toBe('GLOB');
    const deal = dialogue.graph(q).infos.find((i) => i.lines[0]?.startsWith('Deal.'))!;
    const frag = (ws.view(deal.formKey)!.data as any).scripts.fragments.fileName as string;
    expect(await scripts.read(frag)).toMatch(/\(Game\.GetFormFromFile\(0x[0-9A-F]{6}, "Built\.esp"\) as GlobalVariable\)\.SetValue\(1\)/);
    const later = dialogue.graph(q).infos.find((i) => i.lines[0]?.startsWith('Not a word'))!;
    expect(JSON.stringify(ws.view(later.formKey)!.data.conditions)).toContain(glob);
    // Dying fails it, unless it's finished; the map shows both ways to fail.
    const g = await graphs.graph(q);
    expect(g.edges.find((e) => e.kind === 'death' && e.to === 200)).toBeTruthy();
    expect(g.timeLimit).toEqual({ days: 3, fromStage: 10, failStage: 210 });
    expect(g.edges.find((e) => e.id === 'timelimit')).toMatchObject({ from: 10, to: 210, label: 'Time runs out (3 days)' });
    expect(await graphs.fragmentCode(q, 10)).toContain('RegisterForSingleUpdateGameTime(72)');
    expect(g.problems.filter((p) => /stage (200|210)/.test(p))).toEqual([]);
    // Updating removes the time limit.
    const next = structuredClone(plan);
    next.failures = next.failures.filter((f) => f.kind === 'death');
    expect(await builder.previewUpdate(q, next)).toContain('Update how the quest fails');
    await builder.update(q, next);
    const g2 = await graphs.graph(q);
    expect(g2.timeLimit).toBeUndefined();
    expect(await graphs.fragmentCode(q, 10)).not.toContain('RegisterForSingleUpdateGameTime');
    expect(g2.edges.filter((e) => e.kind === 'death' && e.to === 200)).toHaveLength(1);
  });

  it('checks fail conditions before building', () => {
    const plan = exampleQuestPlan();
    plan.failures = [
      { kind: 'death', targetKey: null, days: null, fromStage: null, failStage: 300, note: 'Dies' },
      { kind: 'timeLimit', targetKey: null, days: null, fromStage: 10, failStage: 100, note: 'Hurry' },
    ];
    const msgs = validatePlan(plan).map((i) => i.message);
    expect(msgs).toContain('“Dies” sets stage 300, which doesn\'t exist');
    expect(msgs).toContain('“Dies” needs the character who mustn\'t die');
    expect(msgs).toContain('“Hurry” sets stage 100, which doesn\'t fail the quest; tick “Fails the quest” on it');
    expect(msgs).toContain('“Hurry” needs a number of days');
  });

  it('makes fighters, followers, merchants and trainers, with relationships', async () => {
    const { ws, builder } = await setup();
    const plan = exampleQuestPlan();
    const eirik = plan.characters[1]!;
    eirik.combat = { hostile: true, levelScaled: { min: 5, max: 30 }, skills: [{ skill: 'One-handed', value: 60 }, { skill: 'Archery', value: 45 }, { skill: 'Juggling', value: 10 }], spells: [], perks: [], combatStyle: null };
    eirik.roles = { follower: true, marriage: false, innkeeper: false, merchant: { sells: 'general goods', hours: { from: 9, to: 18 } }, trainer: { skill: 'Sneak', maxLevel: 50 } };
    eirik.relationships = [{ with: 'brynja', rank: 'friend' }, { with: 'player', rank: 'ally' }];
    eirik.level = null;
    expect(validatePlan(plan)).toEqual([]);
    const r = await builder.build(plan);
    const npc = ws.byEditorId('InnkeeperRingQuestEirik')!;
    const d = ws.view(npc)!.data as any;
    expect(d.ai.aggression).toBe(2);
    expect(d.config.flags & 0x80).toBe(0x80);
    expect([d.config.level, d.config.calcMinLevel, d.config.calcMaxLevel]).toEqual([1000, 5, 30]);
    expect(d.skills.values[0]).toBe(60);
    expect(d.skills.values[2]).toBe(45);
    expect(r.warnings.some((w) => /“Juggling” isn't a skill/.test(w))).toBe(true);
    const factions = (d.factions as any[]).map((f) => ws.summary(f.faction)!.editorId);
    expect(factions).toEqual(expect.arrayContaining(['PotentialFollowerFaction', 'CurrentFollowerFaction', 'JobMerchantFaction', 'JobTrainerFaction', 'InnkeeperRingQuestEirikVendorFaction']));
    expect((d.factions as any[]).find((f) => ws.summary(f.faction)!.editorId === 'CurrentFollowerFaction').rank).toBe(-1);
    // The shop: vendor hours, the buy/sell list, and a chest in a cell nobody visits.
    const shop = ws.view(ws.byEditorId('InnkeeperRingQuestEirikVendorFaction')!)!.data as any;
    expect(shop.flags & (1 << 14)).toBeTruthy();
    expect(shop.vendor).toMatchObject({ startHour: 9, endHour: 18 });
    expect(ws.summary(shop.vendorList)!.editorId).toBe('VendorItemsGeneralStore');
    expect(ws.view(shop.merchantContainer)!.parent.cell).toBe(ws.byEditorId('InnkeeperRingQuestMerchantChests'));
    // Training lives on the class: their own copy teaches Sneak.
    const cls = ws.view(d.class)!;
    expect(cls.editorId).toBe('InnkeeperRingQuestEirikTrainerClass');
    expect((cls.data as any).data).toMatchObject({ teaches: 9, maxTrainingLevel: 50 });
    // Relationships: with Brynja made; with the player skipped (no Skyrim.esm in the demo).
    const rels = ws.search({ sigs: ['RELA'], limit: 10 }).items.map((x) => (ws.view(x.formKey)!.data as any).data);
    expect(rels).toEqual([expect.objectContaining({ parent: npc, child: ws.byEditorId('DemoInnkeeper'), rank: 3 })]);
    expect(r.warnings.some((w) => /relationship with player was left out/.test(w))).toBe(true);
    // The plugin still saves and reads back.
    expect(ws.view(ws.byEditorId('InnkeeperRingQuestEirikVendorFaction')!)!.lossless).toBe(true);
  });

  it('places groups of enemies and moves on when they are all dead', async () => {
    const { ws, builder, graphs, world } = await setup();
    const plan = exampleQuestPlan();
    plan.encounters = [{ key: 'guards', what: 'Town Guard', count: 3, locationKey: 'tavern', spot: null }];
    plan.stages.push({ index: 30, journal: 'I fought off the guards.', startsQuest: false, completesQuest: false, failsQuest: false });
    plan.steps.push({ from: 20, to: 30, kind: 'clear', targetKey: 'guards', count: null, hours: null, note: 'Defeat the guards' });
    plan.objectives.push({ index: 25, text: 'Defeat the guards', shownAtStage: 20, completedAtStage: 30, targetKey: 'guards' });
    expect(validatePlan(plan)).toEqual([]);
    const r = await builder.build(plan);
    expect(r.notes.filter((n) => /no quest marker/.test(n))).toEqual([]);
    const tavern = ws.byEditorId('DemoTavern')!;
    const guards = world.references(tavern).filter((x) => x.sig === 'ACHR' && x.base === ws.byEditorId('DemoGuard') && x.source === 'Built.esp');
    expect(guards).toHaveLength(3);
    expect(guards.every((g) => g.persistent)).toBe(true);
    const g = await graphs.graph(r.quest!);
    const edge = g.edges.filter((e) => e.to === 30);
    expect(edge).toEqual([expect.objectContaining({ from: 20, kind: 'death', label: 'Defeat 3 Town Guard' })]);
    expect(r.notes.some((n) => /fixed character rather than a levelled one/.test(n))).toBe(true);
  });

  it('checks events before building', () => {
    const plan = exampleQuestPlan();
    plan.events = [
      { atStage: 55, kind: 'unlock', targetKey: null, toKey: null, what: null, count: null, note: 'Open up' },
      { atStage: 10, kind: 'spawn', targetKey: null, toKey: null, what: null, count: 40, note: 'Ambush' },
      { atStage: 10, kind: 'movePlayer', targetKey: null, toKey: null, what: null, count: null, note: 'Away' },
    ];
    const msgs = validatePlan(plan).map((i) => i.message);
    expect(msgs).toContain('The “Open up” event happens at stage 55, which doesn\'t exist');
    expect(msgs).toContain('The “Open up” event needs a target (who or what it happens to)');
    expect(msgs).toContain('The “Ambush” event needs an enemy type');
    expect(msgs).toContain('The “Ambush” event spawns 40; use 1 to 10');
    expect(msgs).toContain('The “Away” event needs somewhere to go');
  });

  it('turns plan keys into Editor IDs in screenplays', () => {
    const out = rewriteScreenplay('PLAYER: Hi [if stage 10] [if has ring x1]\nBRYNJA: Here. [gives ring x2] [takes gold x5] [if not has Ring]\n  EIRIK: Hm. [gives Unknown]', new Map([['brynja', 'DemoInnkeeper'], ['eirik', 'QEirik']]), new Map([['ring', 'QRing']]));
    expect(out).toBe('PLAYER: Hi [if stage 10] [if has QRing x1]\nDemoInnkeeper: Here. [gives QRing x2] [takes gold x5] [if not has QRing]\n  QEirik: Hm. [gives Unknown]');
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

  it('puts what the text mentions first in the load-order list, with details, so a short list still has it', async () => {
    const { ws } = await setup();
    const catalog = planCatalog(ws, { text: 'Halvar the smith asks the player to find his hammer.', limit: 1 });
    const chars = catalog.split('\n\n')[0]!.split('\n');
    // One entry fits: the character the text names, with race, sex, voice and so on.
    expect(chars[1]).toMatch(/^DemoBlacksmith "Halvar the Smith" \(.*male/);
    expect(chars[2]).toMatch(/^…and \d+ more$/);
    // Without a text: the old order, and no details.
    expect(planCatalog(ws, { limit: 1 }).split('\n')[1]).not.toContain('(');
    // Outdoor places the text is about, for a new interior's door outside; none when it mentions none.
    const outside = planCatalog(ws, { text: 'A hunter builds a cabin in the valley.' }).split('\n\n').find((x) => x.startsWith('Outdoor places'));
    expect(outside?.split('\n').slice(1)).toEqual(expect.arrayContaining(['DemoValley1_0']));
    expect(catalog).not.toContain('Outdoor places');
    // Shorter secondary lists for a free AI; characters keep the main limit.
    const brief = planCatalog(ws, { limit: 50, short: 1 }).split('\n\n');
    expect(brief.find((x) => x.startsWith('Factions'))!.split('\n')).toEqual(['Factions:', expect.any(String), expect.stringMatching(/^…and \d+ more$/)]);
    expect(brief[0]!.split('\n').length).toBeGreaterThan(3);
  });

  it('gives a free AI a worked example to copy and a checklist; Claude does without', async () => {
    const sent: any[] = [];
    const ok = async (p: any) => (sent.push(p), reply(JSON.stringify(exampleQuestPlan())));
    await new QuestPlanner({ ai: { kind: 'ollama', model: 'qwen3' }, send: ok }).plan('x', 'document', 'catalog');
    await new QuestPlanner({ ai: { kind: 'claude', apiKey: 'k' }, send: ok }).plan('x', 'document', 'catalog');
    const free = sent[0].system.map((b: any) => b.text).join('\n');
    expect(free).toContain('A worked example');
    // The example comes with what its author wrote, so the model sees how writing turns into a plan.
    expect(free).toContain(EXAMPLE_QUEST_DOCUMENT);
    expect(free).toContain('use the ones in the load order list');
    expect(sent[0].messages[0].content).toContain('Before you answer, check the plan');
    expect(sent[1].system.map((b: any) => b.text).join('\n')).not.toContain('A worked example');
    expect(sent[1].messages[0].content).not.toContain('Before you answer');
  });

  it('picks the worked example closest to the text', async () => {
    expect(pickPlanExample('Brynja lost her ring. The player finds it and returns it for a reward.').id).toBe('ring');
    expect(pickPlanExample('Bandits in a cave have taken the jarl’s son. Kill their leader or spare him; the quest fails if the boy dies.').id).toBe('rescue');
    expect(pickPlanExample('Make a Khajiit merchant who sells potions, wears fine clothes and can be a follower.').id).toBe('characters');
    expect(pickPlanExample('').id).toBe('ring');
    const sent: any[] = [];
    await new QuestPlanner({ ai: { kind: 'ollama', model: 'qwen3' }, send: async (p: any) => (sent.push(p), reply(JSON.stringify(exampleQuestPlan()))) }).plan('Bandits hide in a cave; kill them all.', 'document', 'catalog');
    expect(sent[0].system.map((b: any) => b.text).join('\n')).toContain(EXAMPLE_RESCUE_DOCUMENT);
  });

  it('keeps every worked example a sound plan', () => {
    for (const e of PLAN_EXAMPLES) expect(validatePlan(e.plan()), e.id).toEqual([]);
    // Together they show the parts of the format small models leave out when they've never seen them.
    const all = PLAN_EXAMPLES.map((e) => e.plan());
    expect(all.some((p) => p.encounters.length && p.events.length && p.failures.length && p.startsWhen)).toBe(true);
    expect(all.some((p) => p.characters.some((c) => c.roles?.merchant && c.roles.trainer))).toBe(true);
    expect(all.some((p) => !p.stages.length)).toBe(true);
  });

  it('mends names used as keys, loose Editor IDs and quoted values in a free AI’s answer', async () => {
    const odd = exampleQuestPlan() as any;
    odd.editorId = "The Innkeeper's Ring";
    odd.items[0].startsAtKey = 'The Demo Tavern';
    odd.objectives[1].targetKey = 'Brynja';
    odd.steps[1].targetKey = 'RING';
    odd.stages[0].startsQuest = false;
    odd.stages[1].index = '10';
    odd.characters[1].essential = 'false';
    odd.characters[1].sex = 'Male';
    odd.characters[1].spot = 'null';
    odd.characters[1].factions = null;
    const ai = { kind: 'ollama' as const, model: 'qwen3' };
    const plan = await new QuestPlanner({ ai, send: async () => reply(JSON.stringify(odd)) }).plan('x', 'document', '');
    expect(plan.editorId).toBe('TheInnkeepersRing');
    expect(plan.items[0]!.startsAtKey).toBe('tavern');
    expect(plan.objectives[1]!.targetKey).toBe('brynja');
    expect(plan.steps[1]!.targetKey).toBe('ring');
    expect(plan.stages[0]!.startsQuest).toBe(true);
    expect(plan.stages[1]!.index).toBe(10);
    expect(plan.characters[1]).toMatchObject({ essential: false, sex: 'male', spot: null, factions: [] });
    // An Editor ID or name that isn't in the plan is left alone.
    const p = exampleQuestPlan();
    p.events = [{ atStage: 20, kind: 'unlock', targetKey: 'DemoCellarDoor', toKey: null, what: null, count: null, note: '' }];
    expect(repairPlan(p)).toEqual([]);
    expect(p.events[0]!.targetKey).toBe('DemoCellarDoor');
  });

  it('tells the AI what a wrong field takes, and the plan’s keys when fixing references', async () => {
    const sent: any[] = [];
    const bad = { ...exampleQuestPlan(), characters: [{ ...exampleQuestPlan().characters[0], sex: 'woman' }] } as any;
    const replies = [bad, exampleQuestPlan()];
    await new QuestPlanner({ send: async (p: any) => (sent.push(p), reply(JSON.stringify(replies.shift() ?? exampleQuestPlan()))) }).plan('x', 'document', '');
    expect(sent[1].messages.at(-1).content).toContain('characters.0.sex');
    expect(sent[1].messages.at(-1).content).toContain('(expected "male" | "female" or null');
    expect(fieldHint(QuestPlanSchema, ['steps', 0, 'kind'])).toMatch(/^"talk" \| "pickup".* — talk: a conversation line/);
    expect(fieldHint(QuestPlanSchema, ['characters', 0, 'level'])).toMatch(/^a number or null — Fixed level/);
    expect(fieldHint(QuestPlanSchema, ['nope'])).toBe('');
    // A step pointing at something that isn't in the plan: the keys are listed with the problem.
    const stuck = exampleQuestPlan();
    stuck.steps[1]!.targetKey = 'necklace';
    const again: any[] = [];
    const answers = [stuck, exampleQuestPlan()];
    await new QuestPlanner({ send: async (p: any) => (again.push(p), reply(JSON.stringify(answers.shift() ?? exampleQuestPlan()))) }).plan('x', 'document', '');
    expect(again[1].messages.at(-1).content).toContain('Keys in the plan: characters brynja, eirik; locations tavern; items ring; encounters none.');
    expect(again[1].messages.at(-1).content).toContain('Stage numbers: 0, 10, 20, 100.');
  });

  it('sends back what would leave the quest stuck, once, and keeps the better plan', async () => {
    const stuck = exampleQuestPlan();
    stuck.steps = stuck.steps.filter((x) => x.to !== 20); // nothing reaches stage 20 any more
    const sent: any[] = [];
    const replies = [stuck, exampleQuestPlan()];
    const planner = new QuestPlanner({ send: async (p) => (sent.push(p), reply(JSON.stringify(replies[sent.length - 1])) )});
    const plan = await planner.plan('Brynja lost her ring.', 'document', 'catalog');
    expect(sent).toHaveLength(2);
    expect(sent[1].messages.at(-1).content).toContain('Nothing moves the quest to stage 20');
    expect(plan.steps.some((x) => x.to === 20)).toBe(true);
    // A "fix" that is no better is not taken.
    const worse = { ...stuck, steps: [] };
    const sent2: any[] = [];
    const again = await new QuestPlanner({ send: async (p) => (sent2.push(p), reply(JSON.stringify(sent2.length === 1 ? stuck : worse))) }).plan('x', 'document', '');
    expect(again.steps).toHaveLength(stuck.steps.length);
  });

  it('lets a free AI rewrite each conversation and the journal in small steps, keeping only sound rewrites', async () => {
    const better = `PLAYER: Need a hand with anything?
BRYNJA: My mother's ring is gone. It was on the counter this morning. [if stage 0] [emotion sad]
  PLAYER: I'll find it. [stage 10]
    BRYNJA: Bless you. Check the tables first. [goodbye]
  PLAYER: Find it yourself.
    BRYNJA: Fine. I'll manage. [goodbye]
PLAYER: Any luck? [if stage 10]
BRYNJA: Not yet. Keep looking, please.
PLAYER: Here's your ring. [if stage 20]
BRYNJA: You found it! Take this, with my thanks. [takes ring x1] [gives gold x100] [stage 100] [emotion happy] [goodbye]`;
    // Eirik's rewrite drops nothing but invents a stage change: rejected.
    const sloppy = `PLAYER: Seen a ring? [if stage 10]\nEIRIK: Under the bench. [stage 20] [goodbye]`;
    const journal = {
      stages: [{ index: 10, journal: 'Brynja has lost her mother’s ring somewhere in the tavern. I offered to look for it.' }],
      objectives: [{ index: 10, text: 'Search the tavern for the ring', shownAtStage: 10, completedAtStage: 20 }],
    };
    const replies = [exampleQuestPlan(), { screenplay: better }, { screenplay: sloppy }, journal];
    const sent: any[] = [];
    const planner = new QuestPlanner({ ai: { kind: 'ollama', model: 'qwen3' }, send: async (p) => (sent.push(p), reply(JSON.stringify(replies[sent.length - 1]))) });
    const plan = await planner.plan('Brynja lost her ring.', 'document', 'catalog');
    expect(sent).toHaveLength(4);
    expect(sent[1].messages[0].content).toContain('BRYNJA = Brynja');
    expect(sent[1].messages[0].content).toContain('Keep every [stage N] tag');
    expect(sent[1].system[0].text).toContain('How lines should sound');
    expect(plan.conversations[0]!.screenplay).toBe(better);
    expect(plan.conversations[1]!.screenplay).toBe(exampleQuestPlan().conversations[1]!.screenplay);
    expect(plan.stages.find((x) => x.index === 10)!.journal).toMatch(/^Brynja has lost/);
    expect(plan.stages.find((x) => x.index === 20)!.journal).toBe(exampleQuestPlan().stages[2]!.journal);
    expect(plan.objectives[0]!.text).toBe('Search the tavern for the ring');
    expect(plan.objectives[0]!.completedAtStage).toBe(20);
    // Claude plans in one go.
    const one: any[] = [];
    await new QuestPlanner({ ai: { kind: 'claude', apiKey: 'k' }, send: async (p) => (one.push(p), reply(JSON.stringify(exampleQuestPlan()))) }).plan('x', 'document', '');
    expect(one).toHaveLength(1);
  });

  it('asks a free AI for just the lines a step needs when no line makes it happen', async () => {
    // The plan says Eirik hands over a key at stage 15, but nobody says anything that sets it.
    const first = exampleQuestPlan();
    first.stages.push({ index: 15, journal: 'Eirik gave me a key.', startsQuest: false, completesQuest: false, failsQuest: false });
    first.steps.push({ from: 10, to: 15, kind: 'talk', targetKey: null, count: null, hours: null, note: 'Eirik gives the player a key' });
    const lines = 'PLAYER: Do you know anything? [if stage 10]\nEIRIK: Take this key, it opens the cellar. [stage 15] [goodbye]';
    const sent: any[] = [];
    // The plan, the one round of fixing the whole plan (no better), then the lines on their own.
    const replies = [first, first, { screenplay: lines }];
    const planner = new QuestPlanner({ ai: { kind: 'ollama', model: 'qwen3' }, send: async (p) => (sent.push(p), sent.length <= 3 ? reply(JSON.stringify(replies[sent.length - 1])) : reply('not json')) });
    const plan = await planner.plan('Brynja lost her ring; Eirik has a key.', 'document', 'catalog');
    expect(sent[2].messages[0].content).toContain('Nothing in the dialogue makes this happen yet: “Eirik gives the player a key” (stage 10 → stage 15)');
    expect(sent[2].messages[0].content).toContain("then EIRIK's answer, ending with [stage 15]");
    expect(plan.conversations.find((c) => c.title === 'Eirik')!.screenplay.endsWith(lines)).toBe(true);
    expect(validatePlan(plan).filter((i) => i.message.includes('stage 15'))).toEqual([]);
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
    await expect(fail(reply('not json'))).rejects.toThrow(/wasn't in the expected format/);
    await expect(fail(reply('{"title":"x"}'))).rejects.toThrow(/incomplete/);
    expect(() => new QuestPlanner({})).toThrow(/API key/);
  });

  it('fixes small slips and asks once to repair a plan that does not fit', async () => {
    const odd = exampleQuestPlan() as any;
    odd.characters[1].sex = 'Male';
    odd.events = [{ atStage: 20, kind: 'MoveTo', targetKey: 'eirik', toKey: 'brynja', what: null, count: null, note: 'Eirik walks over' }];
    const sent: any[] = [];
    const broken = { ...exampleQuestPlan(), stages: 'none' };
    const answers = [JSON.stringify(broken), JSON.stringify(odd)];
    const planner = new QuestPlanner({ send: async (p) => (sent.push(p), reply(answers.shift()!)) });
    const plan = await planner.plan('doc', 'document', '');
    expect(plan.characters[1]!.sex).toBe('male');
    expect(plan.events[0]!.kind).toBe('moveTo');
    expect(sent).toHaveLength(2);
    expect(sent[1].messages.at(-1).content).toMatch(/^That plan doesn't match the format:\nstages:/);
  });
});

export type { FormKey };
