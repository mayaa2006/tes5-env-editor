import { describe, expect, it } from 'vitest';
import { MemoryFileSystem, createDemoData, type AgentTool } from '@tes5/workspace';
import type { FormKey } from '@tes5/esp';
import { DEMO_GAME_DIR } from '../../src/engine/constants';
import { EngineHost } from '../../src/engine/host';
import { questTools, type QuestToolContext } from '../../src/engine/aitools-quest';
import { dialogueTools } from '../../src/engine/aitools-dialogue';

const ORDER = [{ name: 'DemoWorld.esm', active: true }];

async function demo() {
  const fs = new MemoryFileSystem();
  createDemoData(fs, DEMO_GAME_DIR);
  const host = new EngineHost(fs);
  await host.open({ kind: 'demo', path: DEMO_GAME_DIR, loadOrder: ORDER });
  await host.loadPlugins(['DemoWorld.esm']);
  host.createPlugin('MyQuests.esp', {});
  const ctx: QuestToolContext = { ai: 'key', plans: new Map(), touched: new Set() } as unknown as QuestToolContext;
  const tools = new Map([...questTools(host, ctx), ...dialogueTools(host, ctx)].map((t) => [t.name, t as AgentTool]));
  const run = async (name: string, input: unknown): Promise<any> => {
    const t = tools.get(name)!;
    return t.writes ? host.ws!.transactionAsync(`AI: ${name}`, async () => t.run(t.input.parse(input))) : t.run(t.input.parse(input));
  };
  // A small quest with a conversation to change.
  await run('create_quest', { editorId: 'LostRing', name: 'The Lost Ring' });
  await run('set_stage', { quest: 'LostRing', stage: 0, startsQuest: true });
  await run('set_stage', { quest: 'LostRing', stage: 10, journal: 'Brynja asked me to find her ring.' });
  await run('set_stage', { quest: 'LostRing', stage: 20, journal: 'I found the ring.' });
  await run('connect_stages', { quest: 'LostRing', from: 0, to: 10, kind: 'talk', target: 'DemoInnkeeper', playerSays: 'Any work?', answer: 'Find my ring.' });
  return { host, run, ctx, quest: host.ws!.byEditorId('LostRing')! as FormKey };
}

describe('the AI workspace dialogue tools', () => {
  it('lists the lines of a quest with their ids, who says them and what they do', async () => {
    const { run } = await demo();
    const r = await run('list_dialogue_lines', { quest: 'LostRing' });
    const topic = r.data.topics.find((t: any) => t.playerSays === 'Any work?');
    expect(topic).toBeDefined();
    const line = topic.lines[0];
    expect(line.says).toEqual(['Find my ring.']);
    expect(line.movesQuestTo).toBe(10);
    expect(line.when).toBe('only at stage 0');
    expect(r.link).toMatchObject({ tab: 'quest' });
    await expect(run('list_dialogue_lines', { quest: 'NoSuchQuest' })).rejects.toThrow(/isn't a quest/);
  });

  it('rewords a line, changes when it is said, where it moves the quest and whether it ends the talk', async () => {
    const { host, run, ctx, quest } = await demo();
    const list = await run('list_dialogue_lines', { quest: 'LostRing' });
    const topic = list.data.topics.find((t: any) => t.playerSays === 'Any work?');
    const id = topic.lines[0].id as FormKey;
    await run('edit_dialogue_line', { line: id, says: ['I lost my ring.', 'Will you find it?'], emotion: 'sad', when: { kind: 'from', stage: 0 }, movesQuestTo: 20, endsConversation: true });
    expect(ctx.touched.has(quest)).toBe(true);
    const again = (await run('list_dialogue_lines', { quest: 'LostRing' })).data.topics.find((t: any) => t.topic === topic.topic).lines[0];
    expect(again).toMatchObject({ says: ['I lost my ring.', 'Will you find it?'], emotion: 'sad', when: 'from stage 0 on', movesQuestTo: 20, endsConversation: true });
    // Only what is given changes.
    await run('edit_dialogue_line', { line: id, movesQuestTo: null });
    const third = (await run('list_dialogue_lines', { quest: 'LostRing' })).data.topics.find((t: any) => t.topic === topic.topic).lines[0];
    expect(third.movesQuestTo).toBeUndefined();
    expect(third.says).toEqual(['I lost my ring.', 'Will you find it?']);
    expect(third.when).toBe('from stage 0 on');
    await expect(run('edit_dialogue_line', { line: id, when: { kind: 'at' } })).rejects.toThrow(/needs a stage/);
    await expect(run('edit_dialogue_line', { line: quest, says: ['x'] })).rejects.toThrow(/isn't a dialogue line/);
    // The player's words.
    await run('edit_player_line', { topic: topic.topic, says: 'Need a hand?' });
    expect((await run('list_dialogue_lines', { quest: 'LostRing' })).data.topics.some((t: any) => t.playerSays === 'Need a hand?')).toBe(true);
    // All of it is undone like any other change.
    while (host.session().undoLabel?.startsWith('AI: edit')) await host.undo();
    expect((await run('list_dialogue_lines', { quest: 'LostRing' })).data.topics.find((t: any) => t.topic === topic.topic).lines[0].says).toEqual(['Find my ring.']);
  });

  it('removes a line, or a player line with all its answers', async () => {
    const { host, run } = await demo();
    const list = await run('list_dialogue_lines', { quest: 'LostRing' });
    const topic = list.data.topics.find((t: any) => t.playerSays === 'Any work?');
    await run('remove_dialogue', { id: topic.lines[0].id });
    expect(host.ws!.view(topic.lines[0].id)).toBeUndefined();
    await run('remove_dialogue', { id: topic.topic });
    expect((await run('list_dialogue_lines', { quest: 'LostRing' })).data.topics.some((t: any) => t.topic === topic.topic)).toBe(false);
    await expect(run('remove_dialogue', { id: 'LostRing' })).rejects.toThrow(/isn't a dialogue line/);
  });
});
