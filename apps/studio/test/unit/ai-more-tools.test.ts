import { describe, expect, it } from 'vitest';
import { MemoryFileSystem, createDemoData, type AgentModel, type AgentReply, type AgentTool } from '@tes5/workspace';
import { DEMO_GAME_DIR } from '../../src/engine/constants';
import { EngineHost } from '../../src/engine/host';
import { moreTools, mergeChanges } from '../../src/engine/aitools-more';

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

function runner(host: EngineHost) {
  const tools = new Map(moreTools(host).map((t) => [t.name, t as AgentTool]));
  return async (name: string, input: unknown) => {
    const t = tools.get(name)!;
    return host.ws!.transactionAsync(`AI: ${name}`, async () => t.run(t.input.parse(input)));
  };
}

describe('the AI workspace character, record and script tools', () => {
  it('creates a character in a cell, copied and dressed like a planned one', async () => {
    const { host } = await demo();
    const run = runner(host);
    const r = await run('create_character', { name: 'Ingrid', sex: 'female', role: 'Travelling blacksmith', place: 'DemoTavern', level: 12, roles: { follower: true, marriage: false, innkeeper: false, merchant: null, trainer: null } });
    const key = (r.data as any).character;
    expect(key).toMatch(/:MyMod\.esp$/);
    expect(host.ws!.summary(key)!.name).toBe('Ingrid');
    expect(r.link).toMatchObject({ tab: 'npc', key });
    // Placed in the tavern.
    expect(host.references(host.ws!.byEditorId('DemoTavern')!).some((x) => x.base === key)).toBe(true);
  });

  it('changes only what it is told about an existing character, as an override', async () => {
    const { host } = await demo();
    const run = runner(host);
    const before = host.view(host.ws!.byEditorId('DemoInnkeeper')!)!.data as any;
    const r = await run('change_character', { character: 'DemoInnkeeper', essential: true, level: 20 });
    expect((r.data as any).changed.join(' ')).toMatch(/essential/);
    const v = host.view(host.ws!.byEditorId('DemoInnkeeper')!)!;
    expect(v.winner).toBe('MyMod.esp');
    expect((v.data as any).config.level).toBe(20);
    expect((v.data as any).race).toBe(before.race);
    await expect(run('change_character', { character: 'DemoTavern', level: 3 })).rejects.toThrow(/isn't a character/);
  });

  it('creates, copies, changes and deletes records', async () => {
    const { host } = await demo();
    const run = runner(host);
    const made = await run('create_record', { kind: 'weapons', editorId: 'AiBlade', name: 'Ai Blade' });
    const key = (made.data as any).formKey;
    expect(host.ws!.summary(key)).toMatchObject({ editorId: 'AiBlade', name: 'Ai Blade', sig: 'WEAP' });
    expect(made.link).toMatchObject({ tab: 'items', key });
    const copy = await run('copy_record', { form: 'AiBlade', editorId: 'AiBlade2', name: 'Second Blade' });
    const k2 = (copy.data as any).formKey;
    expect(host.ws!.summary(k2)).toMatchObject({ editorId: 'AiBlade2', name: 'Second Blade' });
    const value = (host.view(k2)!.data as any).data?.value;
    await run('update_record', { form: 'AiBlade2', changes: { data: { value: (value ?? 0) + 250 } } });
    expect((host.view(k2)!.data as any).data.value).toBe((value ?? 0) + 250);
    // Other fields of the merged object are kept.
    expect(Object.keys((host.view(k2)!.data as any).data).length).toBeGreaterThan(1);
    expect((await run('delete_record', { form: 'AiBlade2' })).data).toMatch(/removed/);
    expect(host.ws!.byEditorId('AiBlade2')).toBeUndefined();
    await expect(run('create_record', { kind: 'spaceships' })).rejects.toThrow(/isn't a category/);
    const glob = await run('create_record', { kind: 'GLOB', editorId: 'AiCounter' });
    expect(host.ws!.summary((glob.data as any).formKey)!.sig).toBe('GLOB');
  });

  it("saves a script only when it checks clean, attaches it and sets its properties", async () => {
    const { host } = await demo();
    const run = runner(host);
    await expect(run('write_script', { name: 'AiTestScript', source: 'ScriptName AiTestScript extends Quest\nEvent OnInit()\n  Int x = (1 +\nEndEvent' })).rejects.toThrow(/Not saved/);
    await expect(run('write_script', { name: 'AiTestScript', source: 'ScriptName Other extends Quest' })).rejects.toThrow(/ScriptName line says Other/);
    const src = 'ScriptName AiTestScript extends Quest\nInt Property Count Auto\nActorBase Property DemoInnkeeper Auto\n';
    const w = await run('write_script', { name: 'AiTestScript', source: src });
    expect((w.data as any).saved).toBe('AiTestScript');
    expect(await host.scriptRead('AiTestScript')).toContain('Int Property Count Auto');
    const q = host.createQuest('AiScriptQuest', 'Script quest');
    await run('attach_script', { form: 'AiScriptQuest', script: 'AiTestScript' });
    await run('set_script_property', { form: 'AiScriptQuest', script: 'AiTestScript', property: 'Count', kind: 'int', value: '3' });
    const filled = await run('autofill_properties', { form: 'AiScriptQuest' });
    const scripts = (host.view(q)!.data as any).scripts.scripts;
    const props = scripts.find((s: any) => s.name === 'AiTestScript').properties;
    expect(props.find((p: any) => p.name === 'Count')).toMatchObject({ type: 3, value: 3 });
    expect(JSON.stringify(filled.data)).toContain('DemoInnkeeper');
  });

  it('merges changes into objects and replaces lists and values', () => {
    expect(mergeChanges({ a: { b: 1, c: 2 }, l: [1, 2], n: 1 }, { a: { b: 5 }, l: [3], n: 2, x: 'new' })).toEqual({ a: { b: 5, c: 2 }, l: [3], n: 2, x: 'new' });
  });
});

describe('AI turns with the new tools', () => {
  it('a turn that writes a script and creates a record undoes in one step', async () => {
    const { host } = await demo();
    const replies: AgentReply[] = [
      { text: '', calls: [{ id: 'a', name: 'write_script', input: { name: 'AiUndoScript', source: 'ScriptName AiUndoScript extends ObjectReference\n' } }, { id: 'b', name: 'create_record', input: { kind: 'misc', editorId: 'AiTrinket', name: 'Trinket' } }], stop: 'tools' },
      { text: 'Done.', calls: [], stop: 'end' },
    ];
    host.aiModel = (): AgentModel => ({ name: 'T', free: false, provider: 'test', reply: async () => replies.shift() ?? { text: 'Done.', calls: [], stop: 'end' } });
    const s = await host.aiNewSession();
    const r = await host.aiSend(s.id, 'make things', 'k');
    expect(r.session.turns[0]!.changes).toEqual(['Write the script AiUndoScript', 'Create “Trinket”']);
    expect(host.ws!.byEditorId('AiTrinket')).toBeDefined();
    await host.aiUndoTurn(s.id, 0);
    expect(host.ws!.byEditorId('AiTrinket')).toBeUndefined();
    await host.ws!.filesSettled();
    expect(await host.fs.exists(`${DEMO_GAME_DIR}/Data/Source/Scripts/AiUndoScript.psc`)).toBe(false);
  });
});
