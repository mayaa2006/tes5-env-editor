import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { BsaArchive, bufferSource } from '@tes5/assets';
import type { FormKey } from '@tes5/esp';
import { EnvironmentService, MemoryFileSystem, NpcService, QuestGraphService, QuestService, ReleaseService, ScriptService, TriggerService, WorldService, Workspace, createDemoData } from '../src';

async function setup(withPatch = false) {
  const fs = new MemoryFileSystem();
  const demo = createDemoData(fs);
  const loadOrder = [{ name: 'DemoWorld.esm', active: true }, ...(withPatch ? [{ name: 'DirtyPatch.esp', active: true }] : [])];
  const ws = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir], outputDir: demo.dataDir, loadOrder });
  await ws.scan();
  await ws.load();
  ws.createPlugin('Release.esp');
  const scripts = new ScriptService(ws);
  scripts.refresh();
  const quests = new QuestService(ws, scripts);
  const graphs = new QuestGraphService(ws, quests, scripts, new TriggerService(ws, scripts));
  const env = new EnvironmentService(ws);
  const release = new ReleaseService(ws, scripts, new NpcService(ws), quests, graphs, env);
  const k = (e: string) => ws.byEditorId(e)!;
  return { fs, demo, ws, release, world: new WorldService(ws), quests, k };
}

describe('pre-release check', () => {
  it('finds what would break in game, with fixes where possible', async () => {
    const { ws, release, world, quests, k } = await setup();
    const tavern = k('DemoTavern');
    // A static whose mesh doesn't exist, and one whose bounds are wrong.
    ws.createRecord('STAT', { editorId: 'BrokenStatic', bounds: { x1: -1, y1: -1, z1: 0, x2: 1, y2: 1, z2: 1 }, model: { file: 'mymod\\missing.nif' } });
    ws.createRecord('STAT', { editorId: 'WrongBounds', bounds: { x1: -1, y1: -1, z1: 0, x2: 1, y2: 1, z2: 1 }, model: { file: 'demo\\crate.nif' } });
    // A tankard floating above the table.
    const floating = world.placeReference(tavern, k('DemoTankard'), { position: { x: -160, y: 150, z: 140 } });
    // A quest whose alias points nowhere.
    const q = quests.createQuest('ReleaseQuest', 'Release');
    ws.editRecord(q, (d) => ({ ...d, aliases: [{ option: 0, value: { id: 0, name: 'Ghost', flags: 0, fill: { option: 1, value: { actor: '000FFF:DemoWorld.esm' } }, end: true } }] }));
    // A one-way door.
    const door = world.placeReference(tavern, k('DemoDoor'), { position: { x: 0, y: 400, z: 0 } }, { persistent: true });
    ws.editRecord(door, (d) => ({ ...d, teleport: { door: k('DemoTavernDoorRef'), placement: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }, noAlarm: 0 } }));
    // A new character with no voice type.
    ws.createRecord('NPC_', { editorId: 'SilentBob', name: 'Bob' });

    const r = await release.check();
    const text = r.findings.map((f) => `${f.severity}|${f.category}|${f.message}`);
    const has = (re: RegExp) => expect(text.some((t) => re.test(t)), `${re} in\n${text.join('\n')}`).toBe(true);
    has(/^error\|assets\|BrokenStatic uses meshes\\mymod\\missing\.nif/);
    has(/^warning\|plugin\|1 object\(s\) have bounds/);
    has(/^warning\|world\|1 item\(s\) float above the surface/);
    has(/^error\|quests\|ReleaseQuest: alias “Ghost” points to 000FFF:DemoWorld\.esm/);
    has(/^warning\|world\|Door .* doesn't lead back/);
    has(/^warning\|characters\|SilentBob has no voice type/);
    expect(r.counts.error).toBeGreaterThanOrEqual(2);
    expect(r.findings[0]!.severity).toBe('error');
    expect(r.findings.find((f) => /float/.test(f.message))!.fix).toEqual({ kind: 'dropToSurface', refs: [floating] });
    expect(r.findings.find((f) => /bounds/.test(f.message))!.fix).toEqual({ kind: 'updateBounds' });
  });

  it('is quiet about a clean plugin', async () => {
    const { release } = await setup();
    const r = await release.check();
    expect(r.counts.error).toBe(0);
    expect(r.counts.warning).toBe(0);
  });
});

describe('conflict report', () => {
  it('lists records other plugins also change, and who wins', async () => {
    const { ws, release, world, k } = await setup(true);
    const tavern = k('DemoTavern');
    // DirtyPatch moves a crate; we move the same crate too.
    const crates = world.references(tavern).filter((r) => r.baseEditorId === 'DemoCrate' && r.source === 'DirtyPatch.esp');
    expect(crates.length).toBeGreaterThan(0);
    const moved = crates.find((c) => c.transform.position.x === -300) ?? crates[0]!;
    world.transformReferences([{ ref: moved.formKey, transform: { position: { x: -250, y: -250, z: 0 } } }]);
    // A record only we change isn't a conflict.
    ws.editRecord(k('DemoBarrel'), (d) => ({ ...d, editorId: 'DemoBarrel' }));
    const c = release.conflicts();
    const mine = c.find((x) => x.formKey === moved.formKey)!;
    expect(mine).toBeDefined();
    expect(mine.plugins).toEqual(['DemoWorld.esm', 'DirtyPatch.esp', 'Release.esp']);
    expect(mine.mineWins).toBe(true);
    expect(mine.replaces).toEqual(['DirtyPatch.esp']);
    expect(c.some((x) => x.formKey === k('DemoBarrel'))).toBe(false);
    // The tavern cell was copied (unchanged) to hold the moved crate: not a conflict, even though DirtyPatch also copies it.
    expect(c.some((x) => x.formKey === tavern)).toBe(false);
  });
});

describe('packaging', () => {
  it('collects your files and packs them into a BSA or a ZIP', async () => {
    const { ws, fs, demo, release, world, k } = await setup();
    // A new static using a loose demo mesh: the mesh and its texture are "yours" (loose files).
    const stat = ws.createRecord('STAT', { editorId: 'MyCrate', bounds: { x1: -24, y1: -24, z1: 0, x2: 24, y2: 24, z2: 48 }, model: { file: 'demo\\crate.nif' } });
    world.placeReference(k('DemoTavern'), stat, { position: { x: 0, y: 200, z: 0 } });
    ws.createRecord('STAT', { editorId: 'Gone', bounds: { x1: 0, y1: 0, z1: 0, x2: 1, y2: 1, z2: 1 }, model: { file: 'mymod\\gone.nif' } });
    const files = await release.packageFiles();
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath['meshes\\demo\\crate.nif']).toMatchObject({ status: 'included', reason: 'used by MyCrate' });
    expect(byPath['textures\\demo\\wood.dds']).toMatchObject({ status: 'included' });
    expect(byPath['meshes\\mymod\\gone.nif']).toMatchObject({ status: 'missing' });

    const bsa = await release.buildBsa();
    expect(bsa.path).toBe(`${demo.dataDir}/Release.bsa`);
    const archive = new BsaArchive(bufferSource(await fs.readFile(bsa.path)));
    const names = archive.files.map((f) => f.path);
    expect(names).toContain('meshes\\demo\\crate.nif');
    expect(names).toContain('textures\\demo\\wood.dds');

    await expect(release.buildZip()).rejects.toThrow(/Save/);
    await ws.save();
    const zip = await release.buildZip({ returnData: true });
    const entries = unzipSync(zip.data!);
    expect(Object.keys(entries).sort()).toEqual(['Release.esp', 'meshes/demo/crate.nif', 'textures/demo/wood.dds']);
    const zipped = unzipSync((await release.buildZip({ bsa: true, returnData: true })).data!);
    expect(Object.keys(zipped).sort()).toEqual(['Release.bsa', 'Release.esp']);
  });
});
