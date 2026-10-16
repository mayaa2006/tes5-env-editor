import { describe, expect, it } from 'vitest';
import { MemoryFileSystem, createDemoData, type AgentMessage, type AgentModel, type AgentReply } from '@tes5/workspace';
import { DEMO_GAME_DIR } from '../../src/engine/constants';
import { EngineHost } from '../../src/engine/host';
import { aiTools } from '../../src/engine/aitools';

const ORDER = [{ name: 'DemoWorld.esm', active: true }];

async function demo() {
  const fs = new MemoryFileSystem();
  createDemoData(fs, DEMO_GAME_DIR);
  const host = new EngineHost(fs);
  await host.open({ kind: 'demo', path: DEMO_GAME_DIR, loadOrder: ORDER });
  await host.loadPlugins(['DemoWorld.esm']);
  host.createPlugin('MyMod.esp', {});
  return { fs, host };
}

describe('AI projects', () => {
  it('makes a project, sends its to-do list with every message, and keeps it with the conversation', async () => {
    const { fs, host } = await demo();
    const seen: AgentMessage[][] = [];
    const replies: AgentReply[] = [
      { text: '', calls: [{ id: 'p', name: 'set_project', input: { brief: 'Two quests about a ring.', tasks: ['Make quest one', 'Make quest two'] } }], stop: 'tools' },
      { text: 'Here is the plan. Shall I start?', calls: [], stop: 'end' },
      { text: '', calls: [{ id: 'a', name: 'update_task', input: { id: 1, status: 'doing' } }, { id: 'b', name: 'create_quest', input: { editorId: 'RingOne', name: 'Ring One' } }, { id: 'c', name: 'update_task', input: { id: 1, status: 'done', note: 'Made RingOne' } }], stop: 'tools' },
      { text: 'Quest one is made. Next: quest two.', calls: [], stop: 'end' },
    ];
    host.aiModel = (): AgentModel => ({ name: 'T', free: false, provider: 'test', reply: async (req) => (seen.push(structuredClone(req.messages)), replies.shift()!) });
    const s = await host.aiNewSession();
    const first = await host.aiSend(s.id, 'Make me a ring questline', 'k');
    expect(first.session.project?.tasks.map((t) => t.status)).toEqual(['todo', 'todo']);
    const second = await host.aiSend(s.id, 'Carry on with the next task.', 'k', { context: 'Editing MyMod.esp' });
    // The second message carried the project.
    const sent = seen[2]!.at(-1) as Extract<AgentMessage, { role: 'user' }>;
    expect(sent.context).toContain('Editing MyMod.esp');
    expect(sent.context).toContain('Project brief: Two quests about a ring.');
    expect(sent.context).toContain('[ ] 1. Make quest one');
    expect(second.session.project?.tasks[0]).toMatchObject({ status: 'done', note: 'Made RingOne' });
    // Project changes aren't plugin changes: the turn lists only the quest.
    expect(second.session.turns[1]!.changes).toEqual(['Create the quest Ring One']);
    const saved = JSON.parse(new TextDecoder().decode(await fs.readFile(`${DEMO_GAME_DIR}/Data/TES5EnvEditor/ai-conversations.json`)));
    expect(saved[0].project.tasks).toHaveLength(2);
    const cleared = await host.aiClearProject(s.id);
    expect(cleared.project).toBeUndefined();
    expect(host.ws!.byEditorId('RingOne')).toBeDefined();
  });

  it('reviews the whole mod: release check, conflicts and every quest of the plugin', async () => {
    const { host } = await demo();
    const q = host.createQuest('LonelyQuest', 'Lonely');
    host.addStage(q, 0, undefined, { startUp: true });
    host.addStage(q, 50, 'I did it.', { completesQuest: true });
    const t = aiTools(host).find((x) => x.name === 'review_mod')!;
    const r = await t.run(t.input.parse({}));
    const data = r.data as any;
    expect(data.plugin).toBe('MyMod.esp');
    expect(data.quests).toEqual(['LonelyQuest']);
    expect(data.questProblems.join(' ')).toMatch(/LonelyQuest: .*50/);
    expect(Array.isArray(data.releaseCheck)).toBe(true);
  });
});
