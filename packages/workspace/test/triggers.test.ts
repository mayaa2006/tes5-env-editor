import { describe, expect, it } from 'vitest';
import type { FormKey, Vmad } from '@tes5/esp';
import { MemoryFileSystem, QuestService, ScriptService, TriggerService, TRIGGER_TEMPLATES, Workspace, WorldService, createDemoData, generateTriggerScript, parseTriggerScript, type TriggerSpec } from '../src';

async function setup() {
  const fs = new MemoryFileSystem();
  const demo = createDemoData(fs);
  const ws = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir], outputDir: demo.dataDir, loadOrder: [{ name: 'DemoWorld.esm', active: true }] });
  await ws.scan();
  await ws.load();
  ws.createPlugin('Trig.esp');
  const scripts = new ScriptService(ws);
  scripts.refresh();
  return { ws, scripts, triggers: new TriggerService(ws, scripts), world: new WorldService(ws), quests: new QuestService(ws, scripts) };
}
const k = (ws: Workspace, e: string) => ws.byEditorId(e)!;

describe('visual triggers', () => {
  it('generate Papyrus that the language service accepts, and round-trip', async () => {
    const { ws, scripts, triggers } = await setup();
    const chest = k(ws, 'DemoTavernChestRef');
    const quest = k(ws, 'DemoTavernQuest');
    const specs: TriggerSpec[] = [
      {
        id: 'a',
        name: 'Open after the job',
        event: { kind: 'activate' },
        conditions: [{ kind: 'questStage', quest, op: '>=', stage: 10 }, { kind: 'chance', percent: 50 }],
        actions: [{ kind: 'notification', text: 'It "clicks" open.' }, { kind: 'setStage', quest, stage: 20 }, { kind: 'addItem', item: k(ws, 'DemoBarrel'), count: 2 }],
        once: true,
      },
      { id: 'b', event: { kind: 'arrive' }, conditions: [], actions: [{ kind: 'messageBox', text: 'Hi\nthere' }] },
    ];
    const { script, source } = await triggers.set({ kind: 'ref', ref: chest }, specs);
    expect(script).toBe('DemoTavernChestRef_Triggers');
    expect(source).toContain('Event OnActivate(ObjectReference akActionRef)');
    expect(source).toContain('If akActionRef == Game.GetPlayer() && DemoTavernQuest.GetStage() >= 10 && Utility.RandomInt(1, 100) <= 50 && !Fired0');
    expect(source).toContain('Debug.Notification("It \\"clicks\\" open.")');
    expect(source).toContain('Quest Property DemoTavernQuest Auto');
    const errors = (await scripts.check(source)).filter((d) => d.severity === 'error');
    expect(errors).toEqual([]);
    // Attached with properties filled.
    const vm = ws.view(chest)!.data.scripts as Vmad;
    const s = vm.scripts.find((x) => x.name === script)!;
    expect(s.properties.map((p) => [p.name, (p.value as { form: FormKey }).form])).toEqual(
      expect.arrayContaining([
        ['DemoTavernQuest', quest],
        ['DemoBarrel', k(ws, 'DemoBarrel')],
      ]),
    );
    expect((await triggers.list({ kind: 'ref', ref: chest })).specs).toEqual(specs);
    // Removing all triggers detaches the script.
    await triggers.set({ kind: 'ref', ref: chest }, []);
    expect(ws.view(chest)!.data.scripts).toBeUndefined();
  });

  it('works on quest aliases and refuses incomplete blocks', async () => {
    const { ws, triggers, quests } = await setup();
    const quest = k(ws, 'DemoTavernQuest');
    const alias = quests.addReferenceAlias(quest, 'Keeper', { specificReference: k(ws, 'DemoInnkeeperRef') });
    await triggers.set({ kind: 'alias', quest, alias }, [{ id: 'x', event: { kind: 'death' }, conditions: [], actions: [{ kind: 'setStage', quest, stage: 100 }] }]);
    const vm = ws.view(quest)!.data.scripts as Vmad;
    expect(vm.aliases!.find((a) => a.object.alias === alias)!.scripts[0]!.name).toBe('DemoTavernQuest_Keeper_Triggers');
    expect((await triggers.list({ kind: 'alias', quest, alias })).specs[0]!.event.kind).toBe('death');
    const tpl = TRIGGER_TEMPLATES.find((t) => t.id === 'teleport-on-activate')!.make({ host: null });
    await expect(triggers.set({ kind: 'ref', ref: k(ws, 'DemoTavernChestRef') }, [tpl])).rejects.toThrow(/choose an object/);
    await expect(triggers.set({ kind: 'ref', ref: k(ws, 'DemoTavernChestRef') }, [{ id: 'd', event: { kind: 'death' }, conditions: [], actions: [] }])).rejects.toThrow(/actors/);
  });

  it('every template compiles once its blanks are filled', async () => {
    const { ws, scripts } = await setup();
    const fill = (spec: TriggerSpec): TriggerSpec => JSON.parse(JSON.stringify(spec).replace(/""/g, JSON.stringify(k(ws, 'DemoTavernQuest'))));
    for (const t of TRIGGER_TEMPLATES) {
      const spec = fill(t.make({ host: k(ws, 'DemoTavernChestRef') }));
      const src = generateTriggerScript('T', t.id.includes('death') ? 'Actor' : 'ObjectReference', [spec], () => undefined).source;
      expect(parseTriggerScript(src)).toEqual([spec]);
      expect((await scripts.check(src)).filter((d) => d.severity === 'error'), t.id).toEqual([]);
    }
  });
});
