import { describe, expect, it } from 'vitest';
import { conditionFunction, type FormKey } from '@tes5/esp';
import { DialogueService, MemoryFileSystem, QuestGraphService, QuestService, ScriptService, TriggerService, Workspace, createDemoData, lintScreenplay, parseIf, readScene } from '../src';

async function setup(withExtra = false) {
  const fs = new MemoryFileSystem();
  const demo = createDemoData(fs);
  const ws = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir], outputDir: demo.dataDir, loadOrder: [{ name: 'DemoWorld.esm', active: true }] });
  await ws.scan();
  await ws.load();
  // Another plugin that loads first and isn't a master of Rich.esp yet.
  let extra: FormKey | undefined;
  if (withExtra) {
    ws.createPlugin('Extra.esp');
    extra = ws.createRecord('MISC', { editorId: 'ExtraThing', name: 'Thing', data: { value: 1, weight: 1 } });
  }
  ws.createPlugin('Rich.esp');
  const scripts = new ScriptService(ws);
  scripts.refresh();
  const quests = new QuestService(ws, scripts);
  const graphs = new QuestGraphService(ws, quests, scripts, new TriggerService(ws, scripts));
  const dialogue = new DialogueService(ws, quests);
  const q = quests.createQuest('RichQuest', 'Rich', { startGameEnabled: true });
  for (const st of [0, 10, 20, 30]) quests.addStage(q, st, '', { startUp: st === 0 });
  const run = (text: string) => dialogue.importScreenplay(q, text, (info, code, which) => quests.setInfoFragment(info, which, code), { aliasFor: (qq, npc) => graphs.aliasFor(qq, npc), appendStageCode: (qq, st, lines) => graphs.appendStageCode(qq, st, lines) });
  return { fs, demo, ws, quests, graphs, dialogue, scripts, q, run, extra, k: (e: string) => ws.byEditorId(e)! };
}

const fn = (c: { function: number }) => conditionFunction(c.function)!.name;

describe('[if …] conditions', () => {
  it('reads plain-words conditions', () => {
    expect(parseIf('stage >= 10;has Ring x2;not done 20;gold 100;speech < 30;female;race Nord;quest MQ101 done')).toEqual([
      { kind: 'stage', op: '>=', value: 10 },
      { kind: 'has', item: 'Ring', count: 2, not: false },
      { kind: 'done', stage: 20, not: true },
      { kind: 'gold', op: '>=', value: 100 },
      { kind: 'speech', op: '<', value: 30 },
      { kind: 'sex', female: true },
      { kind: 'race', race: 'Nord' },
      { kind: 'questDone', quest: 'MQ101' },
    ]);
    expect(() => parseIf('raining')).toThrow(/isn't understood/);
  });

  it('turns them into Creation Kit conditions on the player', async () => {
    const { run, dialogue, quests, q, k } = await setup();
    await run('PLAYER: About that tankard [if has tankard x2] [if done 10] [if gold 50]\nDemoInnkeeper: Hand it over. [takes tankard x2] [gives gold x10] [once]');
    const info = dialogue.graph(q).infos[0]!;
    const conds = quests.infos(info.topic)[0]!.conditions;
    expect(conds.map(fn)).toEqual(['GetIsID', 'GetItemCount', 'GetStageDone', 'GetGold']);
    const has = conds.find((c) => fn(c) === 'GetItemCount')!;
    expect(has).toMatchObject({ param1: k('DemoTankard'), op: '>=', value: 2, runOn: 1 });
    expect(conds.find((c) => fn(c) === 'GetStageDone')).toMatchObject({ param1: q, param2: 10, value: 1 });
    expect(quests.infos(info.topic)[0]!.flags & 0x4).toBe(0x4);
  });

  it('[persuade N]: the first answer needs Speech, the next is the failure', async () => {
    const { run, dialogue, quests, q } = await setup();
    await run('PLAYER: Surely you can do better on the price. [persuade 40]\nDemoInnkeeper: Oh, fine. Half price.\nDemoInnkeeper: Nice try.');
    const g = dialogue.graph(q);
    expect(g.topics[0]!.text).toBe('(Persuade) Surely you can do better on the price.');
    const infos = quests.infos(g.topics[0]!.formKey);
    expect(infos.map((i) => i.responses[0]!.text)).toEqual(['Oh, fine. Half price.', 'Nice try.']);
    expect(infos[0]!.conditions.find((c) => fn(c) === 'GetActorValue')).toMatchObject({ param1: 17, op: '>=', value: 40, runOn: 1 });
    expect(infos[1]!.conditions.some((c) => fn(c) === 'GetActorValue')).toBe(false);
  });
});

describe('greetings, chatter and scenes', () => {
  it('greetings and idle chatter go into the quest’s Hello and Idle topics', async () => {
    const { run, dialogue, quests, q, ws } = await setup();
    const r = await run('GREETING: [if stage 10]\nDemoInnkeeper: Any luck with the ring?\nDemoInnkeeper: Back again?\nIDLE:\nDemoBlacksmith: Hot work, this.');
    expect(r).toMatchObject({ topics: 0, greetings: 3, scenes: 0 });
    const g = dialogue.graph(q);
    expect(g.topics.map((t) => t.kind).sort()).toEqual(['greeting', 'idle']);
    const hello = quests.topics(q).find((t) => t.subtype === 'HELO')!;
    expect(hello).toMatchObject({ category: 7 });
    expect((ws.view(hello.formKey)!.data as any).data.subtype).toBe(79);
    expect(hello.infos.map((i) => i.conditions.map(fn))).toEqual([['GetIsID', 'GetStage'], ['GetIsID', 'GetStage']]);
    // A second import reuses the same Hello topic.
    await run('GREETING:\nDemoGuard: Move along.');
    expect(quests.topics(q).filter((t) => t.subtype === 'HELO')).toHaveLength(1);
  });

  it('a scene: actors as aliases, one turn per phase, started at a stage', async () => {
    const { run, dialogue, quests, graphs, q, ws, k, fs, demo } = await setup();
    const r = await run('SCENE: Argument at the bar [at stage 20]\nDemoInnkeeper: You still owe me for last week.\nDemoInnkeeper: And the week before.\nDemoBlacksmith: I\'ll pay you tomorrow. [gesture laugh]\nDemoInnkeeper: You said that yesterday.');
    expect(r).toMatchObject({ scenes: 1, responses: 3 });
    const scene = ws.byEditorId('RichQuestSceneArgumentAtTheBar')!;
    const read = readScene(ws, scene)!;
    const aliases = quests.quest(q).aliases;
    const aliasOf = (npc: string) => aliases.find((a) => (a.fill as any).actor === k(npc))!.id;
    expect(read.quest).toBe(q);
    expect(read.turns.map((t) => t.alias)).toEqual([aliasOf('DemoInnkeeper'), aliasOf('DemoBlacksmith'), aliasOf('DemoInnkeeper')]);
    const sceneTopics = quests.topics(q).filter((t) => t.subtype === 'SCEN');
    expect(read.turns.map((t) => t.topic)).toEqual(sceneTopics.map((t) => t.formKey));
    expect(sceneTopics[0]!.infos[0]!.responses.map((x) => x.text)).toEqual(['You still owe me for last week.', 'And the week before.']);
    expect(dialogue.graph(q).topics.every((t) => t.kind === 'scene')).toBe(true);
    expect(await graphs.fragmentCode(q, 20)).toMatch(/^\(Game\.GetFormFromFile\(0x[0-9A-F]{6}, "Rich\.esp"\) as Scene\)\.Start\(\)$/);
    // Fully typed (so FormIDs inside are kept right when masters change).
    expect(ws.view(scene)!).toMatchObject({ hasSchema: true, lossless: true, unknown: [] });
    // Survives saving and loading.
    await ws.save();
    const ws2 = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir], outputDir: demo.dataDir, loadOrder: [{ name: 'DemoWorld.esm', active: true }, { name: 'Rich.esp', active: true }] });
    await ws2.scan();
    await ws2.load();
    expect(readScene(ws2, scene)!.turns).toEqual(read.turns);
  });

  it('keeps a scene pointing at the right forms when the plugin gains a master', async () => {
    const { run, ws, quests, q, extra } = await setup(true);
    await run('SCENE: Chat [start]\nDemoInnkeeper: Hello there.\nDemoBlacksmith: Hello yourself.');
    const scene = ws.byEditorId('RichQuestSceneChat')!;
    const before = readScene(ws, scene)!;
    expect(before.beginOnQuestStart).toBe(true);
    // Pointing at something in Extra.esp makes it a new master, which renumbers the plugin's own FormIDs.
    expect(ws.active!.plugin!.masters).not.toContain('Extra.esp');
    ws.createRecord('FLST', { editorId: 'RichList', forms: [extra!] });
    expect(ws.active!.plugin!.masters).toContain('Extra.esp');
    expect(readScene(ws, scene)).toEqual(before);
    expect(quests.topics(q).filter((t) => t.subtype === 'SCEN').map((t) => t.formKey)).toEqual(before.turns.map((t) => t.topic));
  });

  it('checks blocks: a scene that never starts, an unknown condition', () => {
    const m = lintScreenplay('SCENE: Quiet chat\nDemoInnkeeper: Hm.\nGREETING: [if raining]\nNPC: Hello.').map((l) => `${l.severity}:${l.line ?? ''}:${l.message}`);
    expect(m).toContain('warning:1:Scene “Quiet chat” never starts');
    expect(m).toContain('warning:1:Scene “Quiet chat” has only one speaker');
    expect(m.some((x) => /^error:3:\[if raining\] isn't understood/.test(x))).toBe(true);
  });
});

export type { FormKey };
