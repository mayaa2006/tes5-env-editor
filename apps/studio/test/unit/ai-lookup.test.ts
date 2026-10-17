import { describe, expect, it } from 'vitest';
import { MemoryFileSystem, createDemoData } from '@tes5/workspace';
import { DEMO_GAME_DIR } from '../../src/engine/constants';
import { EngineHost } from '../../src/engine/host';
import { lookup, wordsOf } from '../../src/engine/aitools-lookup';

async function ws() {
  const fs = new MemoryFileSystem();
  createDemoData(fs, DEMO_GAME_DIR);
  const host = new EngineHost(fs);
  await host.open({ kind: 'demo', path: DEMO_GAME_DIR, loadOrder: [{ name: 'DemoWorld.esm', active: true }] });
  await host.loadPlugins(['DemoWorld.esm']);
  return host.ws!;
}

describe('finding the record an AI means', () => {
  it('takes FormKeys, Editor IDs and in-game names', async () => {
    const w = await ws();
    const tankard = w.byEditorId('DemoTankard')!;
    expect(lookup(w, tankard, { what: 'item' })).toBe(tankard);
    expect(lookup(w, 'DemoTankard', { what: 'item' })).toBe(tankard);
    expect(lookup(w, 'tankard', { what: 'item' })).toBe(tankard);
    expect(lookup(w, '"Bottle of Mead"', { what: 'item' })).toBe(w.byEditorId('DemoBottle'));
    // A bare form ID, without its plugin, when only one plugin has it.
    const [hex] = tankard.split(':');
    expect(lookup(w, hex!, { what: 'item' })).toBe(tankard);
    expect(lookup(w, `0x00${hex}`, { what: 'item' })).toBe(tankard);
  });

  it('lists the closest records for a made-up Editor ID or a wrong type', async () => {
    const w = await ws();
    expect(wordsOf('WhiterunBanneredMareChest')).toEqual(['whiterun', 'bannered', 'mare', 'chest']);
    expect(() => lookup(w, 'DemoTavernChest', { what: 'container' })).toThrow(/There's no container "DemoTavernChest"\. Closest: .*DemoChest/);
    expect(() => lookup(w, 'DemoTankard', { what: 'place', sigs: ['CELL'] })).toThrow(/DemoTankard is a MISC record, not a place/);
  });
});
