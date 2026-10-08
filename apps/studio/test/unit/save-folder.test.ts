import { describe, expect, it } from 'vitest';
import { MemoryFileSystem, createDemoData } from '@tes5/workspace';
import { DEMO_GAME_DIR } from '../../src/engine/constants';
import { EngineHost } from '../../src/engine/host';

const ORDER = [
  { name: 'DemoWorld.esm', active: true },
  { name: 'DirtyPatch.esp', active: true },
];

async function openWith(outputDir?: string) {
  const fs = new MemoryFileSystem();
  createDemoData(fs, DEMO_GAME_DIR);
  const host = new EngineHost(fs);
  await host.open({ kind: 'demo', path: DEMO_GAME_DIR, loadOrder: ORDER, outputDir });
  await host.loadPlugins(ORDER.map((p) => p.name));
  return { fs, host };
}

describe('saving into a chosen folder', () => {
  it('writes the plugin to the new folder, and not to Data', async () => {
    const { fs, host } = await openWith('/Modding/MyNewMod');
    expect(host.session().outputDir).toBe('/Modding/MyNewMod');
    host.createPlugin('MyMod.esp', {});
    const r = await host.save();
    expect(r.path.replace(/\\/g, '/')).toBe('/Modding/MyNewMod/MyMod.esp');
    expect(await fs.exists('/Modding/MyNewMod/MyMod.esp')).toBe(true);
    expect(await fs.exists(`${DEMO_GAME_DIR}/Data/MyMod.esp`)).toBe(false);
  });

  it('finds the saved plugin again when the folder is chosen next time', async () => {
    const first = await openWith('/Modding/MyNewMod');
    first.host.createPlugin('MyMod.esp', {});
    await first.host.save();
    const again = new EngineHost(first.fs);
    await again.open({ kind: 'demo', path: DEMO_GAME_DIR, outputDir: '/Modding/MyNewMod' });
    expect(again.session().loadOrder.some((p) => p.name === 'MyMod.esp')).toBe(true);
  });

  it('keeps the usual place when no folder is chosen', async () => {
    const { host } = await openWith();
    expect(host.session().outputDir?.replace(/\\/g, '/')).toBe(`${DEMO_GAME_DIR}/Data`);
  });
});
