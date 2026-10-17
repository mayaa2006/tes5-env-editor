import { describe, expect, it } from 'vitest';
import { MemoryFileSystem, createDemoData, toolSchema, type AgentTool } from '@tes5/workspace';
import type { FormKey } from '@tes5/esp';
import { DEMO_GAME_DIR } from '../../src/engine/constants';
import { EngineHost } from '../../src/engine/host';
import { triggerTools } from '../../src/engine/aitools-triggers';

const ORDER = [{ name: 'DemoWorld.esm', active: true }];

async function demo() {
  const fs = new MemoryFileSystem();
  createDemoData(fs, DEMO_GAME_DIR);
  const host = new EngineHost(fs);
  await host.open({ kind: 'demo', path: DEMO_GAME_DIR, loadOrder: ORDER });
  await host.loadPlugins(['DemoWorld.esm']);
  host.createPlugin('MyMod.esp', {});
  const tools = new Map(triggerTools(host).map((t) => [t.name, t as AgentTool]));
  const run = async (name: string, input: unknown): Promise<any> => {
    const t = tools.get(name)!;
    return t.writes ? host.ws!.transactionAsync(`AI: ${name}`, async () => t.run(t.input.parse(input))) : t.run(t.input.parse(input));
  };
  return { host, run, tools };
}

describe('the AI workspace trigger tools', () => {
  it('adds, changes and removes triggers on a placed object, written as its trigger script', async () => {
    const { host, run } = await demo();
    const tavern = host.ws!.byEditorId('DemoTavern')!;
    const chest = host.references(tavern).find((r) => r.base && host.ws!.summary(r.base)?.sig === 'CONT')!.formKey as FormKey;
    const gold = host.search({ sigs: ['MISC'], limit: 1 }).items[0]!;
    const r = await run('add_trigger', {
      object: chest,
      name: 'Stash',
      when: 'activate',
      onlyIf: [{ kind: 'questStage', quest: 'DemoTavernQuest', op: '>=', stage: 10 }],
      then: [
        { kind: 'notification', text: 'You find a hidden stash.' },
        { kind: 'addItem', item: gold.formKey, count: 5 },
        { kind: 'setStage', quest: 'DemoTavernQuest', stage: 20 },
      ],
      once: true,
    });
    expect(r.link).toMatchObject({ tab: 'scene', key: tavern });
    const listed = (await run('list_triggers', { object: chest })).data;
    expect(listed.triggers).toHaveLength(1);
    const t = listed.triggers[0];
    expect(t).toMatchObject({ name: 'Stash', when: 'Player activates it', once: true });
    expect(t.then[2]).toEqual({ kind: 'setStage', quest: 'DemoTavernQuest', stage: 20 });
    // The script the Triggers editor reads, attached to the chest with its properties.
    const { specs, script } = await host.triggersOf({ kind: 'ref', ref: chest });
    expect(script).toBe(listed.script);
    expect(specs[0]!.actions[2]).toMatchObject({ kind: 'setStage', quest: host.ws!.byEditorId('DemoTavernQuest') });
    const scripts = (host.ws!.view(chest)!.data as any).scripts.scripts.map((s: any) => s.name);
    expect(scripts).toContain(script);
    expect((await host.scriptCheck(await host.scriptRead(script!))).filter((d) => d.severity === 'error')).toEqual([]);

    await run('add_trigger', { object: chest, when: 'hit', then: [{ kind: 'messageBox', text: 'Ouch.' }] });
    const two = (await run('list_triggers', { object: chest })).data.triggers;
    expect(two).toHaveLength(2);
    await run('change_trigger', { object: chest, id: two[1].id, when: 'hit', then: [{ kind: 'notification', text: 'Careful.' }] });
    expect((await run('list_triggers', { object: chest })).data.triggers[1].then).toEqual([{ kind: 'notification', text: 'Careful.' }]);
    await run('remove_trigger', { object: chest, id: two[0].id });
    await run('remove_trigger', { object: chest, id: two[1].id });
    expect((await run('list_triggers', { object: chest })).data.triggers).toEqual([]);
    expect(((host.ws!.view(chest)!.data as any).scripts?.scripts ?? []).map((s: any) => s.name)).not.toContain(script);
  });

  it('takes a base record for its one placed copy, and says when it is not placed', async () => {
    const { host, run } = await demo();
    const tavern = host.ws!.byEditorId('DemoTavern')!;
    const chest = host.references(tavern).find((r) => r.base === host.ws!.byEditorId('DemoChest'))!.formKey;
    await run('add_trigger', { object: 'DemoChest', when: 'activate', then: [{ kind: 'notification', text: 'Locked.' }] });
    expect((await host.triggersOf({ kind: 'ref', ref: chest })).specs).toHaveLength(1);
    await expect(run('add_trigger', { object: 'DemoBottle', when: 'activate', then: [{ kind: 'notification', text: 'x' }] })).rejects.toThrow(/isn't placed anywhere/);
  });

  it('puts triggers on a quest alias and explains what is wrong', async () => {
    const { run } = await demo();
    // With nothing looked at yet, it has to be told what the trigger is on.
    await expect(run('add_trigger', { when: 'activate', then: [{ kind: 'notification', text: 'x' }] })).rejects.toThrow(/Say which placed object/);
    await run('add_trigger', { quest: 'DemoTavernQuest', alias: 'innkeeper', when: 'death', then: [{ kind: 'setStage', quest: 'DemoTavernQuest', stage: 100 }] });
    const r = await run('list_triggers', { quest: 'DemoTavernQuest', alias: 'Innkeeper' });
    expect(r.data.triggers[0].when).toBe('It dies');
    expect(r.link).toMatchObject({ tab: 'quest' });
    await expect(run('add_trigger', { quest: 'DemoTavernQuest', alias: 'Nobody', when: 'activate', then: [{ kind: 'notification', text: 'x' }] })).rejects.toThrow(/Its aliases: Innkeeper/);
    // Then a trigger without one goes on what was last looked at (here the alias).
    await run('add_trigger', { when: 'activate', then: [{ kind: 'notification', text: 'Hello.' }] });
    expect((await run('list_triggers', { quest: 'DemoTavernQuest', alias: 'Innkeeper' })).data.triggers).toHaveLength(2);
    await expect(run('add_trigger', { object: 'DemoTavern', when: 'activate', then: [{ kind: 'notification', text: 'x' }] })).rejects.toThrow(/isn't a placed object/);
    await expect(run('remove_trigger', { quest: 'DemoTavernQuest', alias: 'Innkeeper', id: 'nope' })).rejects.toThrow(/no trigger nope/);
  });

  it('describes its inputs to the AI as JSON schema', async () => {
    const { tools } = await demo();
    const s = toolSchema(tools.get('add_trigger')!) as any;
    expect(s.properties.then.items.oneOf ?? s.properties.then.items.anyOf).toBeDefined();
    expect(s.properties.when.enum).toContain('pickup');
  });
});
