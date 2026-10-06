import { describe, expect, it } from 'vitest';
import { FaceGenService, MemoryFileSystem, NpcService, Workspace, buildFaceKit, compareFaceGen, createDemoData, formatComparisons } from '../src';

async function setup(roots?: string[], loadOrder?: string[]) {
  const fs = new MemoryFileSystem();
  const demo = createDemoData(fs);
  const ws = new Workspace(fs, { game: 'SkyrimSE', roots: roots ?? [demo.dataDir], outputDir: demo.dataDir, loadOrder: (loadOrder ?? ['DemoWorld.esm']).map((name) => ({ name, active: true })) });
  await ws.scan();
  await ws.load();
  const npcs = new NpcService(ws);
  return { ws, fs, demo, npcs, faces: new FaceGenService(ws, npcs) };
}

describe('comparing generated faces with reference ones', () => {
  it('reports a perfect match against files it wrote itself, and differences after a change', async () => {
    const { ws, npcs, faces } = await setup();
    ws.createPlugin('Faces.esp');
    const smith = ws.byEditorId('DemoBlacksmith')!;
    await faces.generate([smith]);
    const same = await compareFaceGen(ws, npcs, faces, smith);
    expect(same.skipped).toBeUndefined();
    expect(same.ref!.shapes.map((s) => s.name)).toEqual(same.ours!.shapes.map((s) => s.name));
    expect(same.vertexDiff.every((d) => d.max === 0)).toBe(true);
    expect(same.tint!.meanAbsDiff).toEqual([0, 0, 0]);
    await faces.setLook(smith, {}, { extended: {}, morphs: {}, regions: { nose: { size: 1 } } });
    const changed = await compareFaceGen(ws, npcs, faces, smith);
    expect(changed.vertexDiff.find((d) => d.name === 'DemoHeadMale')!.max).toBeGreaterThan(0.5);
    const text = formatComparisons([changed]);
    expect(text).toContain('=== DemoBlacksmith');
    expect(text).toContain('shape "DemoHeadMale"');
    expect(text).toMatch(/vertices: max diff [0-9.]+/);
    expect((await compareFaceGen(ws, npcs, faces, ws.byEditorId('DemoGuard')!)).skipped).toMatch(/no reference/);
  });

  it('packs only what the faces need, and the kit opens on its own', async () => {
    const { ws, npcs, faces, fs } = await setup();
    ws.createPlugin('Faces.esp');
    const keeper = ws.byEditorId('DemoInnkeeper')!;
    await faces.setLook(keeper, { morphs: { ...npcs.appearance(keeper).morphs, noseUpDown: -0.5 } }, { extended: {}, morphs: {}, regions: {} });
    await faces.generate([keeper]);
    await ws.save();
    const kit = await buildFaceKit(ws, npcs, faces, 'Faces.esp');
    expect(kit.npcs).toEqual([keeper]);
    expect(kit.plugins).toEqual(['DemoWorld.esm', 'Faces.esp']);
    const paths = [...kit.files.keys()];
    expect(paths).toContain('meshes\\demo\\head_female.nif');
    expect(paths).toContain('meshes\\demo\\head_female_chargen.tri');
    expect(paths.some((p) => p.includes('facegeom'))).toBe(true);
    // Only the masks her layers use.
    expect(paths.filter((p) => p.includes('tintmasks')).sort()).toEqual(['textures\\demo\\tintmasks\\lips.dds', 'textures\\demo\\tintmasks\\skintone.dds']);
    expect(paths.some((p) => p.includes('crate'))).toBe(false);

    // Unpack it somewhere else and compare there.
    for (const [p, b] of kit.files) {
      const full = `/kit/${p.replace(/\\/g, '/')}`;
      await fs.mkdir(full.slice(0, full.lastIndexOf('/')));
      await fs.writeFile(full, b);
    }
    const other = new Workspace(fs, { game: 'SkyrimSE', roots: ['/kit'], outputDir: '/kit-out', loadOrder: kit.plugins.map((name) => ({ name, active: true })) });
    await other.scan();
    await other.load();
    const n2 = new NpcService(other);
    const f2 = new FaceGenService(other, n2);
    const [res] = [await compareFaceGen(other, n2, f2, keeper)];
    expect(res!.skipped).toBeUndefined();
    expect(res!.vertexDiff.every((d) => d.max < 1e-3)).toBe(true);
  });
});
