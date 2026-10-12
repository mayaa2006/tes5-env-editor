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
  describePackage,
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
    plan.items.push({ key: 'note', name: 'Crumpled Note', kind: 'book', existing: null, basedOn: null, value: 1, startsWith: 'character', startsAtKey: 'eirik', spot: null });
    plan.items.push({ key: 'charm', name: 'Lucky Charm', kind: 'misc', existing: null, basedOn: null, value: 10, startsWith: 'player', startsAtKey: null, spot: null });
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
    expect((ws.view(eirik)!.data as any).items).toEqual([{ item: { item: ws.byEditorId('DemoBottle'), count: 2 } }, { item: { item: note, count: 1 } }]);
    // Fallback: there's no book in the demo to copy, so it's a misc item.
    expect(ws.summary(note)!.sig).toBe('MISC');
    expect(r.notes.some((n) => n.includes('Crumpled Note should be a book'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('“Read the note” (read) can\'t be detected'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('Nothing said in a conversation sets stage 50'))).toBe(true);
    const start = await graphs.fragmentCode(r.quest!, 0);
    expect(start).toMatch(/Game\.GetPlayer\(\)\.AddItem\(Game\.GetFormFromFile\(0x[0-9A-F]{6}, "Built\.esp"\), 1\)/);
    const end = await graphs.fragmentCode(r.quest!, 100);
    expect(end).toContain('SetObjectiveCompleted(20)');
    expect(end).toContain('AddItem(Game.GetFormFromFile(0x00000F, "Skyrim.esm"), 25)');
    expect(r.problems).toContain('Nothing leads to stage 50.');
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
    plan.steps.push({ from: 20, to: 110, kind: 'talk', targetKey: null, note: 'Make a deal with Eirik' });
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
    plan.steps.push({ from: 20, to: 30, kind: 'clear', targetKey: 'guards', note: 'Defeat the guards' });
    expect(validatePlan(plan)).toEqual([]);
    const r = await builder.build(plan);
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

  it('puts what the text mentions first in the load-order list, with details, so a short list still has it', async () => {
    const { ws } = await setup();
    const catalog = planCatalog(ws, { text: 'Halvar the smith asks the player to find his hammer.', limit: 1 });
    const chars = catalog.split('\n\n')[0]!.split('\n');
    // One entry fits: the character the text names, with race, sex, voice and so on.
    expect(chars[1]).toMatch(/^DemoBlacksmith "Halvar the Smith" \(.*male/);
    expect(chars[2]).toMatch(/^…and \d+ more$/);
    // Without a text: the old order, and no details.
    expect(planCatalog(ws, { limit: 1 }).split('\n')[1]).not.toContain('(');
  });

  it('gives a free AI a worked example to copy; Claude does without', async () => {
    const sent: any[] = [];
    const ok = async (p: any) => (sent.push(p), reply(JSON.stringify(exampleQuestPlan())));
    await new QuestPlanner({ ai: { kind: 'ollama', model: 'qwen3' }, send: ok }).plan('x', 'document', 'catalog');
    await new QuestPlanner({ ai: { kind: 'claude', apiKey: 'k' }, send: ok }).plan('x', 'document', 'catalog');
    expect(sent[0].system.map((b: any) => b.text).join('\n')).toContain('An example of a complete plan');
    expect(sent[1].system.map((b: any) => b.text).join('\n')).not.toContain('An example of a complete plan');
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
