import { describe, expect, it } from 'vitest';
import { DialogueService, MemoryFileSystem, QuestService, ScriptService, Workspace, createDemoData, parseScreenplay } from '../src';

const SCRIPT = `
PLAYER: Got any work?
Brynja: A crate of mead went missing.
Brynja: Find it and I'll pay you. [emotion puzzled]
    PLAYER: I'll look into it.
      DemoInnkeeper: Thank you! [goodbye] [stage 10]
    PLAYER: Not interested.
      Brynja: Suit yourself. [goodbye]
PLAYER: Seen anything strange? [if stage 10]
NPC: Not lately.
`;

async function setup() {
  const fs = new MemoryFileSystem();
  const demo = createDemoData(fs);
  const ws = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir], outputDir: demo.dataDir, loadOrder: [{ name: 'DemoWorld.esm', active: true }] });
  await ws.scan();
  await ws.load();
  ws.createPlugin('Talk.esp');
  const scripts = new ScriptService(ws);
  scripts.refresh();
  const quests = new QuestService(ws, scripts);
  return { ws, quests, dialogue: new DialogueService(ws, quests) };
}

describe('screenplay dialogue', () => {
  it('parses nesting, tags and errors', () => {
    const p = parseScreenplay(SCRIPT);
    expect(p.errors).toEqual([]);
    expect(p.topics.map((t) => t.text)).toEqual(['Got any work?', 'Seen anything strange?']);
    const r = p.topics[0]!.responses[0]!;
    expect(r.lines).toEqual(['A crate of mead went missing.', "Find it and I'll pay you."]);
    expect(r.tags.emotion).toBe('puzzled');
    expect(r.choices.map((c) => c.text)).toEqual(["I'll look into it.", 'Not interested.']);
    expect(r.choices[0]!.responses[0]).toMatchObject({ speaker: 'DemoInnkeeper', tags: { goodbye: '', stage: '10' } });
    expect(p.topics[1]!.tags.if).toBe('stage 10');
    const bad = parseScreenplay('Brynja: Hi\nPLAYER: Hello\n   PLAYER: nested?\nnonsense');
    expect(bad.errors.map((e) => e.line)).toEqual([1, 3, 4, 2]);
  });

  it('creates the conversation, reads it back as a graph and as a screenplay', async () => {
    const { ws, quests, dialogue } = await setup();
    const q = quests.createQuest('TalkQuest', 'Talk', { startGameEnabled: true });
    quests.addStage(q, 10);
    const res = await dialogue.importScreenplay(q, SCRIPT, (info, code) => quests.setInfoFragment(info, 'end', code));
    expect(res).toEqual({ topics: 4, responses: 4, greetings: 0, scenes: 0 });
    const g = dialogue.graph(q);
    const top = g.topics.filter((t) => t.topLevel).map((t) => t.text);
    expect(top).toEqual(expect.arrayContaining(['Got any work?', 'Seen anything strange?']));
    const work = g.topics.find((t) => t.text === 'Got any work?')!;
    const answer = g.infos.find((i) => i.topic === work.formKey)!;
    expect(answer.speaker).toBe(ws.byEditorId('DemoInnkeeper'));
    expect(answer.choices).toHaveLength(2);
    const look = g.topics.find((t) => t.text === "I'll look into it.")!;
    expect(look.topLevel).toBe(false);
    expect(look.branch).toBe(work.branch);
    expect(g.infos.find((i) => i.topic === look.formKey)).toMatchObject({ goodbye: true });
    expect(g.infos.find((i) => i.topic === g.topics.find((t) => t.text === 'Seen anything strange?')!.formKey)).toMatchObject({ speaker: null, needsStage: 10 });
    // Round trip through text.
    const text = dialogue.toScreenplay(q);
    const again = parseScreenplay(text);
    expect(again.errors).toEqual([]);
    expect(again.topics[0]!.responses[0]!.choices.map((c) => c.text)).toEqual(["I'll look into it.", 'Not interested.']);
    // One undo removes the whole conversation.
    ws.undo();
    expect(dialogue.graph(q).topics).toEqual([]);
  });

  it('refuses unknown speakers without creating anything', async () => {
    const { quests, dialogue } = await setup();
    const q = quests.createQuest('TalkQuest2', 'Talk');
    await expect(dialogue.importScreenplay(q, 'PLAYER: Hi\nNobodyAtAll: Hello', async () => undefined)).rejects.toThrow(/Unknown speaker: NobodyAtAll/);
    expect(dialogue.graph(q).topics).toEqual([]);
  });

  it('adds choices to responses', async () => {
    const { quests, dialogue } = await setup();
    const q = quests.createQuest('TalkQuest3', 'Talk');
    const t = quests.createTopic(q, { editorId: 'T3Hello', text: 'Hello' });
    const info = quests.addResponse(t, { text: 'Hi.' });
    const c = dialogue.addChoice(info, 'Who are you?');
    expect(dialogue.graph(q).infos[0]!.choices).toEqual([c]);
    dialogue.setChoice(info, c, false);
    expect(dialogue.graph(q).infos[0]!.choices).toEqual([]);
  });
});
