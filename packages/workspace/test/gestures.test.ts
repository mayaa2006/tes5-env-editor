import { describe, expect, it } from 'vitest';
import { MemoryFileSystem, ScriptService, Workspace, createDemoData, findGesture, gestureCode, listGestures } from '../src';

async function setup() {
  const fs = new MemoryFileSystem();
  const demo = createDemoData(fs);
  const ws = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir], outputDir: demo.dataDir, loadOrder: [{ name: 'DemoWorld.esm', active: true }] });
  await ws.scan();
  await ws.load();
  return ws;
}

describe('gestures', () => {
  it('finds gestures by name, label or animation', () => {
    expect(findGesture('Wave').event).toBe('IdleWave');
    expect(findGesture('point (near)').event).toBe('IdlePointClose');
    expect(findGesture('IdleCiceroDance1')).toMatchObject({ event: 'IdleCiceroDance1' });
  });

  it('plays the idle form when the load order has it, else sends the animation event', async () => {
    const ws = await setup();
    const wave = ws.byEditorId('IdleWave')!;
    expect(ws.view(wave)!.data).toMatchObject({ animationEvent: 'IdleWave' });
    expect(gestureCode(ws, 'wave', 'akSpeaker')).toMatch(/^akSpeaker\.PlayIdle\(Game\.GetFormFromFile\(0x[0-9A-F]{6}, "DemoWorld\.esm"\) as Idle\)$/);
    expect(gestureCode(ws, 'salute', 'akSpeaker')).toBe('Debug.SendAnimationEvent(akSpeaker, "IdleSalute")');
    expect(() => gestureCode(ws, 'wave hello!', 'akSpeaker')).toThrow(/isn't a gesture/);
  });

  it('lists the common gestures, then other idles in the load order', async () => {
    const ws = await setup();
    const all = listGestures(ws);
    expect(all[0]).toMatchObject({ id: 'wave', label: 'Wave' });
    expect(all.filter((g) => g.label === 'IdleWave')).toEqual([]);
    expect(listGestures(ws, { query: 'pray' }).map((g) => g.id)).toEqual(['pray']);
  });

  it('generates code the Papyrus checker accepts', async () => {
    const ws = await setup();
    const src = `Scriptname T extends TopicInfo Hidden\nFunction F(ObjectReference akSpeakerRef)\nActor akSpeaker = akSpeakerRef as Actor\n${gestureCode(ws, 'wave', 'akSpeaker')}\n${gestureCode(ws, 'laugh', 'akSpeaker')}\n${gestureCode(ws, 'bow', 'akSpeaker')}\nEndFunction\n`;
    const scripts = new ScriptService(ws);
    scripts.refresh();
    expect((await scripts.check(src)).filter((d) => d.severity === 'error')).toEqual([]);
  });
});
