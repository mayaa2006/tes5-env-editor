import { describe, expect, it } from 'vitest';
import { ActorModels, MemoryFileSystem, NpcService, Workspace, createDemoData } from '../src';

describe('character models for the world view', () => {
  it('carry the skin tone and the hair colour (for hair, beards and brows)', async () => {
    const fs = new MemoryFileSystem();
    const demo = createDemoData(fs);
    const ws = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir], outputDir: demo.dataDir, loadOrder: [{ name: 'DemoWorld.esm', active: true }] });
    await ws.scan();
    await ws.load();
    const models = new ActorModels(ws, new NpcService(ws));
    const smith = models.modelFor(ws.byEditorId('DemoBlacksmith')!)!;
    expect(smith.skinTone).toEqual({ r: expect.closeTo(0.85, 5), g: expect.closeTo(0.7, 5), b: expect.closeTo(0.6, 5) });
    expect(smith.hairColor).toEqual({ r: 92 / 255, g: 60 / 255, b: 38 / 255 });
    const keeper = models.modelFor(ws.byEditorId('DemoInnkeeper')!)!;
    expect(keeper.hairColor).toEqual({ r: 25 / 255, g: 22 / 255, b: 20 / 255 });
  });
});
