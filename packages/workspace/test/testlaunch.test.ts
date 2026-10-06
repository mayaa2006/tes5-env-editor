import { describe, expect, it } from 'vitest';
import { MemoryFileSystem, QuestGraphService, QuestService, ScriptService, TriggerService, Workspace, createDemoData, findLauncher, stagePath, testCommands } from '../src';

async function setup() {
  const fs = new MemoryFileSystem();
  const demo = createDemoData(fs);
  const ws = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir], outputDir: demo.dataDir, loadOrder: [{ name: 'DemoWorld.esm', active: true }] });
  await ws.scan();
  await ws.load();
  ws.createPlugin('Test.esp');
  const scripts = new ScriptService(ws);
  scripts.refresh();
  const quests = new QuestService(ws, scripts);
  const graph = new QuestGraphService(ws, quests, scripts, new TriggerService(ws, scripts));
  return { ws, fs, quests, graph };
}

describe('test launch', () => {
  it('follows the quest map to the chosen stage', async () => {
    const { ws, quests, graph } = await setup();
    const q = quests.createQuest('LaunchQuest', 'Launch');
    quests.addStage(q, 0, '', { startUp: true });
    await graph.addEdge(q, { from: 0, to: 10, kind: 'script' });
    await graph.addEdge(q, { from: 10, to: 50, kind: 'script' });
    await graph.addEdge(q, { from: 0, to: 20, kind: 'script' });
    await graph.addEdge(q, { from: 20, to: 30, kind: 'script' });
    const g = await graph.graph(q);
    expect(stagePath(g, 50)).toEqual([0, 10, 50]);
    expect(stagePath(g, 30)).toEqual([0, 20, 30]);

    const lines = testCommands(ws, { cell: ws.byEditorId('DemoTavern'), quest: q, stage: 30, replayStages: true, godMode: true, items: [{ item: ws.byEditorId('DemoChest')!, count: 2.4 }] }, g);
    expect(lines[0]).toBe('tgm');
    expect(lines[1]).toBe('coc DemoTavern');
    expect(lines.slice(2, 5)).toEqual(['setstage LaunchQuest 0', 'setstage LaunchQuest 20', 'setstage LaunchQuest 30']);
    expect(lines[5]).toMatch(/^player\.additem [0-9A-F]{8} 2$/);
    expect(testCommands(ws, { quest: q, stage: 30 }, g)).toEqual(['setstage LaunchQuest 30']);
    expect(testCommands(ws, { quest: q })).toEqual(['startquest LaunchQuest']);
  });

  it('uses cow for exterior cells and rejects non-cells', async () => {
    const { ws } = await setup();
    const ext = ws.byEditorId('DemoValley1_0')!;
    expect(testCommands(ws, { cell: ext })).toEqual(['coc DemoValley1_0']);
    expect(() => testCommands(ws, { cell: ws.byEditorId('DemoChest') })).toThrow(/cell/);
  });

  it('finds SKSE before the game exe', async () => {
    const { ws, fs } = await setup();
    expect(await findLauncher(ws, { gameDir: '/game' })).toBeUndefined();
    await fs.writeFile('/game/SkyrimSE.exe', new Uint8Array(1));
    expect((await findLauncher(ws, { gameDir: '/game' }))?.how).toBe('SkyrimSE.exe');
    await fs.writeFile('/game/skse64_loader.exe', new Uint8Array(1));
    expect((await findLauncher(ws, { gameDir: '/game' }))?.how).toBe('skse64_loader.exe');
    await fs.writeFile('/mo2/ModOrganizer.exe', new Uint8Array(1));
    const mo2 = await findLauncher(ws, { gameDir: '/game', mo2: { instanceDir: '/mo2', profile: 'Default' } });
    expect(mo2?.args).toEqual(['-p', 'Default', 'moshortcut://:SKSE']);
  });
});
