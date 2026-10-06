import { describe, expect, it } from 'vitest';
import { DialogueService, MemoryFileSystem, QuestGraphService, QuestService, ScriptService, TriggerService, Workspace, createDemoData, exampleQuestPlan, lintQuestDialogue, lintScreenplay, validatePlan } from '../src';

const msgs = (src: string, ctx?: Parameters<typeof lintScreenplay>[1]) => lintScreenplay(src, ctx).map((l) => `${l.severity}:${l.line ?? ''}:${l.message}`);

describe('screenplay lint', () => {
  it('is quiet about a good conversation', () => {
    expect(msgs(`PLAYER: Got any work? [if stage 0]\nBRYNJA: Find my ring.\n  PLAYER: I will. [stage 10]\n    BRYNJA: Thanks. [goodbye]`, { stages: [0, 10], speakers: ['brynja'] })).toEqual([]);
  });

  it('finds what would go wrong in game', () => {
    const src = [
      'PLAYER: Got any work?',
      'BRYNJA: Find my ring. [goodbye]',
      '  PLAYER: I will. [stge 10]',
      '    BRYNJA: Thanks.',
      'PLAYER: Done! [if stage 30]',
      'BRYNJA: TODO write this [stage 5] [gesture bow',
      `PLAYER: ${'Very long player line '.repeat(5)}`,
      `GHOST: ${'word '.repeat(40)}`,
      'PLAYER: Got any work?',
      'BRYNJA: Again? [stage 20]',
    ].join('\n');
    const m = msgs(src, { stages: [0, 10, 20], speakers: ['Brynja'] });
    const has = (re: RegExp) => expect(m.some((x) => re.test(x)), `${re}\n${m.join('\n')}`).toBe(true);
    has(/^error:3:Unknown tag \[stge 10\]/);
    has(/^error:6:A tag is missing its closing \]/);
    has(/^error::Nobody called GHOST is in the quest/);
    has(/^error:2:“Find my ring\.” ends the conversation, so the choices after it never appear/);
    has(/^error:6:“TODO write this.*” is only said at stage 30, which doesn't exist/);
    has(/^error:6:“TODO write this.*” sets stage 5, which doesn't exist/);
    has(/^warning:6:“TODO write this.*” moves the quest back from stage 30 to 5/);
    has(/^warning:6:“TODO write this.*” looks like a placeholder/);
    has(/^warning:7:“Very long player line.*is too long for the dialogue menu/);
    has(/^warning:8:“word word.*” is long \(199 characters\)/);
    has(/^warning:9:“Got any work\?” is offered twice/);
    has(/^warning:9:“Got any work\?” can still be chosen after it moved the quest on/);
  });

  it('checks the conversations of a quest plan', () => {
    const p = exampleQuestPlan();
    p.conversations[1]!.screenplay += '\nPLAYER: Bye [stage 999]\nEIRIK: Bye.';
    expect(validatePlan(p).map((i) => i.message)).toContain('Eirik (line 4): “Bye.” sets stage 999, which doesn\'t exist');
  });
});

describe('quest dialogue lint', () => {
  it('lints the dialogue in the plugin', async () => {
    const fs = new MemoryFileSystem();
    const demo = createDemoData(fs);
    const ws = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir], outputDir: demo.dataDir, loadOrder: [{ name: 'DemoWorld.esm', active: true }] });
    await ws.scan();
    await ws.load();
    ws.createPlugin('Lint.esp');
    const scripts = new ScriptService(ws);
    scripts.refresh();
    const quests = new QuestService(ws, scripts);
    const graphs = new QuestGraphService(ws, quests, scripts, new TriggerService(ws, scripts));
    const dialogue = new DialogueService(ws, quests);
    const q = quests.createQuest('LintQuest', 'Lint', { startGameEnabled: true });
    quests.addStage(q, 0, '', { startUp: true });
    quests.addStage(q, 10);
    await dialogue.importScreenplay(q, 'PLAYER: Hello\nDemoInnkeeper: Hi. [stage 10]\n  PLAYER: Bye\n    DemoInnkeeper: Bye. [goodbye]', (info, code, which) => quests.setInfoFragment(info, which, code));
    // A player line nobody answers, and one nothing leads to.
    quests.createTopic(q, { editorId: 'LintOrphan', text: 'Lost line', topLevel: false, branch: (ws.view(dialogue.graph(q).topics[0]!.formKey)!.data as any).branch });
    const lint = await lintQuestDialogue(q, { quests, dialogue, graphs });
    const m = lint.map((l) => l.message);
    expect(m).toContain('“Hello” can still be chosen after it moved the quest on');
    expect(m).toContain('Nobody answers “Lost line”');
    expect(m).toContain('“Lost line” is never offered');
    expect(lint.find((l) => l.message.startsWith('Nobody answers'))!.form).toBe(ws.byEditorId('LintOrphan'));
  });
});
