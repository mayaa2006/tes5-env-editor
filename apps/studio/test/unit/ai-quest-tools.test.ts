import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryFileSystem, createDemoData, exampleQuestPlan, type AgentModel, type AgentReply } from '@tes5/workspace';
import { DEMO_GAME_DIR } from '../../src/engine/constants';
import { EngineHost, type HostEvent } from '../../src/engine/host';

const ORDER = [{ name: 'DemoWorld.esm', active: true }];

async function demo(plugin = true) {
  const fs = new MemoryFileSystem();
  createDemoData(fs, DEMO_GAME_DIR);
  const host = new EngineHost(fs);
  await host.open({ kind: 'demo', path: DEMO_GAME_DIR, loadOrder: ORDER });
  await host.loadPlugins(['DemoWorld.esm']);
  if (plugin) host.createPlugin('MyQuests.esp', {});
  return host;
}

/** A model that answers from a script and records what it was sent. */
function scripted(replies: AgentReply[], seen: any[] = []): AgentModel {
  return { name: 'Test AI', free: false, provider: 'test', reply: async (req) => (seen.push(structuredClone(req.messages)), replies.shift() ?? { text: 'Done.', calls: [], stop: 'end' }) };
}
const call = (name: string, input: unknown, id = `${name}_${Math.random().toString(36).slice(2, 6)}`) => ({ id, name, input });

afterEach(() => vi.unstubAllGlobals());

describe('the AI workspace quest tools', () => {
  it('builds a quest step by step as one undo step, which Undo on the turn takes back', async () => {
    const host = await demo();
    const seen: any[] = [];
    host.aiModel = () =>
      scripted(
        [
          { text: '', calls: [call('create_quest', { editorId: 'LostRing', name: 'The Lost Ring', startsWithGame: true })], stop: 'tools' },
          {
            text: '',
            calls: [
              call('set_stage', { quest: 'LostRing', stage: 0, startsQuest: true }),
              call('set_stage', { quest: 'LostRing', stage: 10, journal: 'Brynja asked me to find her ring.' }),
              call('set_stage', { quest: 'LostRing', stage: 100, journal: 'I returned the ring.', completesQuest: true }),
              call('set_objective', { quest: 'LostRing', index: 10, text: "Find Brynja's ring", shownAtStage: 10, completedAtStage: 100 }),
              call('connect_stages', { quest: 'LostRing', from: 0, to: 10, kind: 'talk', target: 'DemoInnkeeper', playerSays: 'Any work?', answer: 'Find my ring.' }),
              call('connect_stages', { quest: 'LostRing', from: 10, to: 100, kind: 'script' }),
              call('add_dialogue', { quest: 'LostRing', screenplay: 'GREETING: [if stage 10]\nDemoInnkeeper: Any luck with the ring?' }),
            ],
            stop: 'tools',
          },
          { text: 'Made **The Lost Ring**.', calls: [], stop: 'end' },
        ],
        seen,
      );
    const s = await host.aiNewSession();
    const before = host.session().canUndo;
    const r = await host.aiSend(s.id, 'Make a ring quest for Brynja', 'key');
    expect(r.error).toBeNull();
    const turn = r.session.turns[0]!;
    expect(turn.changes).toHaveLength(8);
    expect(turn.undoLabel).toBe('AI: Make a ring quest for Brynja');
    expect(host.session().undoLabel).toBe('AI: Make a ring quest for Brynja');
    const key = host.ws!.byEditorId('LostRing')!;
    const q = host.quest(key);
    expect(q.stages.map((x) => x.index)).toEqual([0, 10, 100]);
    expect(q.stages[1]!.logEntries[0]!.text).toBe('Brynja asked me to find her ring.');
    expect(q.objectives.map((o) => o.text)).toEqual(["Find Brynja's ring"]);
    const g = await host.questGraph(key);
    expect(g.edges.map((e) => `${e.from}->${e.to} ${e.kind}`).sort()).toEqual(['0->10 talk', '10->100 script']);
    expect(g.nodes.find((n) => n.stage === 10)!.shows).toEqual([10]);
    // Every tool reported back to the AI without errors.
    const results = r.session.messages.filter((m) => m.role === 'tool').flatMap((m: any) => m.results);
    expect(results.filter((x: any) => x.status !== 'done')).toEqual([]);
    // Undo the turn: the quest is gone, in one step.
    await host.aiUndoTurn(s.id, 0);
    expect(host.ws!.byEditorId('LostRing')).toBeUndefined();
    expect(host.session().canUndo).toBe(before);
    await expect(host.aiUndoTurn(s.id, 0)).rejects.toThrow(/nothing to undo/);
  });

  it("sends the quest's problems back once after changes, and the AI fixes them", async () => {
    const host = await demo();
    const seen: any[] = [];
    host.aiModel = () =>
      scripted(
        [
          { text: '', calls: [call('create_quest', { editorId: 'Gap', name: 'Gap' }), call('set_stage', { quest: 'Gap', stage: 0, startsQuest: true }), call('set_stage', { quest: 'Gap', stage: 20, completesQuest: true, journal: 'I did it.' })], stop: 'tools' },
          { text: 'Done.', calls: [], stop: 'end' },
          { text: '', calls: [call('connect_stages', { quest: 'Gap', from: 0, to: 20, kind: 'script' })], stop: 'tools' },
          { text: 'Fixed: stage 20 now follows stage 0.', calls: [], stop: 'end' },
        ],
        seen,
      );
    const s = await host.aiNewSession();
    const r = await host.aiSend(s.id, 'Make a quest', 'key');
    const fb = r.session.messages.find((m) => m.role === 'user' && m.text.startsWith("The editor's checks"));
    expect(fb).toBeDefined();
    expect((fb as any).text).toMatch(/Gap: .*20/);
    expect(r.session.turns[0]!.changes).toHaveLength(4);
    expect((await host.questGraph(host.ws!.byEditorId('Gap')!)).edges).toHaveLength(1);
  });

  it('asks before each change when told to, and a skipped change is not made', async () => {
    const host = await demo();
    const events: HostEvent[] = [];
    host.onEvent((e) => events.push(e));
    host.aiModel = () => scripted([{ text: '', calls: [call('create_quest', { editorId: 'AskMe', name: 'Ask me' }, 'c1')], stop: 'tools' }, { text: 'OK, I left it.', calls: [], stop: 'end' }]);
    const s = await host.aiNewSession();
    const pending = host.aiSend(s.id, 'Make a quest', 'key', { ask: true });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'ai' && e.event.type === 'call' && e.event.status === 'waiting')).toBe(true));
    expect(host.ws!.byEditorId('AskMe')).toBeUndefined();
    expect(host.aiApprove(s.id, 'c1', false)).toBe(true);
    const r = await pending;
    expect(host.ws!.byEditorId('AskMe')).toBeUndefined();
    expect(r.session.messages.find((m) => m.role === 'tool')).toMatchObject({ results: [{ status: 'declined' }] });
    expect(r.session.turns[0]!.undoLabel).toBeNull();
  });

  it('says plainly when there is no plugin to change', async () => {
    const host = await demo(false);
    host.aiModel = () => scripted([{ text: '', calls: [call('create_quest', { editorId: 'NoPlugin', name: 'x' })], stop: 'tools' }]);
    const s = await host.aiNewSession();
    const r = await host.aiSend(s.id, 'Make a quest', 'key');
    const res = (r.session.messages.find((m) => m.role === 'tool') as any).results[0];
    expect(res.status).toBe('error');
    expect(res.content).toMatch(/No plugin is chosen/);
  });

  it('plans a quest with the same planner, then builds it from the plan', async () => {
    const host = await demo();
    // The planner talks to a free AI (an OpenAI-style service, faked here).
    vi.stubGlobal('fetch', async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).endsWith('/models') ? { data: [] } : { choices: [{ message: { content: JSON.stringify(exampleQuestPlan()) }, finish_reason: 'stop' }] }),
      text: async () => '',
    }));
    let planId = '';
    host.aiModel = () => ({
      name: 'Test AI',
      free: false,
      provider: 'test',
      reply: async (req) => {
        const last = req.messages.at(-1)!;
        if (last.role === 'user') return { text: '', calls: [call('plan_quest', { text: 'Brynja lost her ring in the tavern.' }, 'p')], stop: 'tools' };
        const r = (last as any).results[0];
        if (r.name === 'plan_quest') {
          planId = JSON.parse(r.content).planId;
          return { text: '', calls: [call('build_plan', { planId }, 'b')], stop: 'tools' };
        }
        return { text: 'Built it.', calls: [], stop: 'end' };
      },
    });
    const s = await host.aiNewSession();
    const r = await host.aiSend(s.id, 'Make the ring quest', { kind: 'openai', url: 'https://x.test/v1', model: 'm' });
    expect(r.error).toBeNull();
    const results = r.session.messages.filter((m) => m.role === 'tool').flatMap((m: any) => m.results);
    const plan = JSON.parse(results[0].content);
    expect(plan).toMatchObject({ planId: 'plan1', title: "The Innkeeper's Ring" });
    expect(plan.cast.some((c: string) => c.includes('Brynja'))).toBe(true);
    expect(results[1]).toMatchObject({ status: 'done', writes: true, link: { tab: 'quest' } });
    expect(host.ws!.byEditorId('InnkeeperRingQuest')).toBeDefined();
    expect(r.session.turns[0]!.changes).toEqual(['Build the quest from plan1']);
  });

  it('building a revised plan again updates the quest it made, rather than making a second one', async () => {
    const host = await demo();
    // The planner (faked) returns the example plan, then the revision with a new journal entry for stage 10.
    let asked = 0;
    vi.stubGlobal('fetch', async () => {
      const plan = exampleQuestPlan();
      if (asked++ > 0) plan.stages.find((x) => x.index === 10)!.journal = 'Brynja begged me to find her ring.';
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(plan) }, finish_reason: 'stop' }] }), text: async () => '' };
    });
    const ai = { kind: 'openai' as const, url: 'https://x.test/v1', model: 'm' };
    host.aiModel = () =>
      scripted([
        { text: '', calls: [call('plan_quest', { text: 'Brynja lost her ring.' }, 'p')], stop: 'tools' },
        { text: '', calls: [call('build_plan', { planId: 'plan1' }, 'b1')], stop: 'tools' },
        { text: '', calls: [call('revise_plan', { planId: 'plan1', change: 'Brynja begs.' }, 'r')], stop: 'tools' },
        { text: '', calls: [call('build_plan', { planId: 'plan2' }, 'b2')], stop: 'tools' },
        { text: 'Done.', calls: [], stop: 'end' },
      ]);
    const s = await host.aiNewSession();
    const r = await host.aiSend(s.id, 'Make the ring quest', ai);
    expect(r.error).toBeNull();
    const results = r.session.messages.filter((m) => m.role === 'tool').flatMap((m: any) => m.results);
    expect(results.map((x: any) => `${x.name}:${x.status}`)).toEqual(['plan_quest:done', 'build_plan:done', 'revise_plan:done', 'build_plan:done']);
    expect(JSON.parse(results[3].content)).toMatchObject({ updatedExisting: true });
    // One quest, with the revised journal.
    const quests = host.ws!.search({ sigs: ['QUST'], plugin: host.ws!.activeName }).items.filter((q) => q.inActive);
    expect(quests.map((q) => q.editorId)).toEqual(['InnkeeperRingQuest']);
    expect(host.quest(quests[0]!.formKey).stages.find((x) => x.index === 10)!.logEntries[0]!.text).toBe('Brynja begged me to find her ring.');
  });

  it('keeps plans with the conversation, so one made before a restart can still be built', async () => {
    const host = await demo();
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(exampleQuestPlan()) }, finish_reason: 'stop' }] }), text: async () => '' }));
    const ai = { kind: 'openai' as const, url: 'https://x.test/v1', model: 'm' };
    host.aiModel = () => scripted([{ text: '', calls: [call('plan_quest', { text: 'Brynja lost her ring.' }, 'p')], stop: 'tools' }, { text: 'Here is the plan.', calls: [], stop: 'end' }]);
    const s = await host.aiNewSession();
    await host.aiSend(s.id, 'Plan the ring quest', ai);
    // The app restarts: a new host reads the saved conversation.
    const again = new EngineHost(host.fs);
    await again.open({ kind: 'demo', path: DEMO_GAME_DIR, loadOrder: ORDER });
    await again.loadPlugins(['DemoWorld.esm']);
    again.createPlugin('Again.esp', {});
    again.aiModel = () => scripted([{ text: '', calls: [call('build_plan', { planId: 'plan1' }, 'b')], stop: 'tools' }, { text: 'Built.', calls: [], stop: 'end' }]);
    const r = await again.aiSend(s.id, 'Build it', ai);
    const built = (r.session.messages.filter((m) => m.role === 'tool').at(-1) as any).results[0];
    expect(built).toMatchObject({ name: 'build_plan', status: 'done' });
    expect(again.ws!.byEditorId('InnkeeperRingQuest')).toBeDefined();
  });
});
