import { describe, expect, it } from 'vitest';
import { parseDds, parseNif, parseTri, readNifDoc, nifShapes, decodeToRgba } from '@tes5/assets';
import { FaceGenService, FaceShaper, MemoryFileSystem, NpcService, Workspace, createDemoData, emptySculpt, tintMaskName, type FaceSculpt } from '../src';

async function setup() {
  const fs = new MemoryFileSystem();
  const demo = createDemoData(fs);
  const ws = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir], outputDir: demo.dataDir, loadOrder: [{ name: 'DemoWorld.esm', active: true }] });
  await ws.scan();
  await ws.load();
  ws.createPlugin('Faces.esp');
  const npcs = new NpcService(ws);
  return { ws, fs, npcs, faces: new FaceGenService(ws, npcs) };
}

async function demoHead(ws: Workspace) {
  const nif = readNifDoc(await ws.vfs.read('meshes\\demo\\head_male.nif'));
  const tri = parseTri(await ws.vfs.read('meshes\\demo\\head_male_chargen.tri'));
  const eyes = readNifDoc(await ws.vfs.read('meshes\\demo\\eyes.nif'));
  return { head: nifShapes(nif)[0]!.positions, tri, eyes: nifShapes(eyes)[0]!.positions };
}

const centroid = (p: Float32Array, pick: (x: number, y: number, z: number) => boolean) => {
  let n = 0;
  const c = [0, 0, 0];
  for (let i = 0; i < p.length; i += 3)
    if (pick(p[i]!, p[i + 1]!, p[i + 2]!)) {
      c[0] += p[i]!;
      c[1] += p[i + 1]!;
      c[2] += p[i + 2]!;
      n++;
    }
  return c.map((v) => v / (n || 1));
};

describe('face shaping', () => {
  it('finds regions from the vanilla morphs and lists extra morphs', async () => {
    const { ws } = await setup();
    const { head, tri } = await demoHead(ws);
    const s = new FaceShaper([{ key: 'head', type: 'Face', positions: head, tris: [tri] }]);
    expect(s.extraMorphs()).toEqual(['CheekbonesHigh', 'EarsPointed', 'LipsFull', 'NoseHooked']);
    expect(s.availableRegions()).toEqual(['head', 'nose', 'eyes', 'brows', 'cheeks', 'mouth', 'jaw', 'chin', 'ears']);
  });

  it('shapes regions, keeps the neck seam, and pushes vanilla sliders past ±1', async () => {
    const { ws } = await setup();
    const { head, tri } = await demoHead(ws);
    const s = new FaceShaper([{ key: 'head', type: 'Face', positions: head, tris: [tri] }]);
    const zero = new Array(19).fill(0);
    const plain = s.shape({ sliders: zero }).get('head')!;
    expect(plain.every((v, i) => v === head[i])).toBe(true);

    const sculpt: FaceSculpt = { ...emptySculpt(), regions: { nose: { forward: 1 }, head: { size: 1 } } };
    const out = s.shape({ sliders: zero, sculpt }).get('head')!;
    // The nose tip (front-most vertex) moves forward.
    let tip = 0;
    for (let v = 0; v < head.length / 3; v++) if (head[v * 3 + 1]! > head[tip * 3 + 1]!) tip = v;
    expect(out[tip * 3 + 1]!).toBeGreaterThan(head[tip * 3 + 1]! + 1);
    // The bottom of the neck doesn't move, so the head still meets the body.
    let low = 0;
    for (let v = 0; v < head.length / 3; v++) if (head[v * 3 + 2]! < head[low * 3 + 2]!) low = v;
    for (let k = 0; k < 3; k++) expect(out[low * 3 + k]).toBeCloseTo(head[low * 3 + k]!, 6);

    // Sliders past 1 go further than 1 does.
    const one = zero.slice();
    one[0] = -1;
    const two = zero.slice();
    two[0] = -2.5;
    const y1 = s.shape({ sliders: one }).get('head')![tip * 3 + 1]!;
    const y2 = s.shape({ sliders: two }).get('head')![tip * 3 + 1]!;
    expect(y2 - head[tip * 3 + 1]!).toBeCloseTo((y1 - head[tip * 3 + 1]!) * 2.5, 4);
  });

  it('moves the eyes apart and tilts them, on both sides', async () => {
    const { ws } = await setup();
    const { head, tri, eyes } = await demoHead(ws);
    // The demo eyes have no TRI, so give them one with the head's eye morph shape (all vertices move) like vanilla eyes.
    const eyeTri = { ...tri, vertices: eyes, morphs: [{ name: 'EyesUp', deltas: new Float32Array(eyes.length).map((_, i) => (i % 3 === 2 ? 1 : 0)) }] };
    const s = new FaceShaper([
      { key: 'head', type: 'Face', positions: head, tris: [tri] },
      { key: 'eyes', type: 'Eyes', positions: eyes, tris: [eyeTri] },
    ]);
    const out = s.shape({ sliders: new Array(19).fill(0), sculpt: { ...emptySculpt(), regions: { eyes: { apart: 1 } } } }).get('eyes')!;
    const l0 = centroid(eyes, (x) => x < 0);
    const r0 = centroid(eyes, (x) => x > 0);
    const l1 = centroid(out, (x) => x < 0);
    const r1 = centroid(out, (x) => x > 0);
    expect(l1[0]!).toBeLessThan(l0[0]! - 0.5);
    expect(r1[0]!).toBeGreaterThan(r0[0]! + 0.5);
  });
});

describe('FaceGen', () => {
  it('reads the race tint masks and names them', async () => {
    const { ws, faces } = await setup();
    const race = ws.byEditorId('DemoHumanRace')!;
    const masks = faces.raceTintMasks(race, false);
    expect(masks.map((m) => [m.index, m.name])).toEqual([
      [1, 'Skin Tone'],
      [2, 'Cheeks'],
      [3, 'Lips'],
      [4, 'Eye Socket Upper'],
      [5, 'Warpaint 01'],
    ]);
    expect(tintMaskName('actors\\character\\character assets\\tintmasks\\femaleheadwarpaint_04.dds')).toBe('Warpaint 04');
    expect(tintMaskName('MaleHeadCheeks.dds')).toBe('Cheeks');
  });

  it('bakes and writes the head and tint for an edited character, with undo', async () => {
    const { ws, fs, faces, npcs } = await setup();
    const smith = ws.byEditorId('DemoBlacksmith')!;
    expect(await faces.needingFaces()).toEqual([]);
    await faces.setLook(smith, { morphs: { ...npcs.appearance(smith).morphs, noseLongShort: -2.5 } }, { extended: { noseLongShort: -2.5 }, morphs: { EarsPointed: 1 }, regions: { nose: { size: 0.5 } } });
    // The record keeps the in-game range; the sidecar keeps the rest.
    expect(npcs.appearance(smith).morphs.noseLongShort).toBe(-1);
    expect((await faces.sculpt(smith)).extended.noseLongShort).toBe(-2.5);
    expect(await faces.needingFaces()).toEqual([smith]);

    const [res] = await faces.generate();
    expect(res!.npc).toBe(smith);
    expect(res!.mesh).toMatch(/^meshes\\actors\\character\\facegendata\\facegeom\\demoworld\.esm\\[0-9a-f]{8}\.nif$/);
    expect(ws.vfs.has(res!.mesh)).toBe(true);
    const nif = parseNif(await ws.vfs.read(res!.mesh));
    // The CK's layout: a BSFadeNode named after the file, the bones, then the shapes under BSFaceGenNiNodeSkinned.
    expect(nif.roots[0]!.type).toBe('BSFadeNode');
    expect(nif.roots[0]!.name).toBe(res!.mesh.split('\\').pop()!.toUpperCase());
    const root = nif.roots[0]!.children.find((c) => c.name === 'BSFaceGenNiNodeSkinned')!;
    // The character's own parts in reverse order (as the CK writes them).
    expect(root.children.map((c) => c.name)).toEqual(['DemoBeardFull', 'DemoBrows', 'DemoEyesBrown', 'DemoHairShort', 'DemoHeadMale']);
    const headMesh = root.children.find((c) => c.name === 'DemoHeadMale')!.mesh!;
    expect(headMesh.material.textures[6]).toBe(`data\\${res!.tint}`); // as the CK writes it
    const orig = parseNif(await ws.vfs.read('meshes\\demo\\head_male.nif')).roots[0]!.children[0]!.mesh!;
    expect(headMesh.positions.length).toBe(orig.positions.length);
    // Pointed ears: the widest point is wider than before.
    const maxX = (p: Float32Array) => p.reduce((m, v, i) => (i % 3 === 0 ? Math.max(m, Math.abs(v)) : m), 0);
    expect(maxX(headMesh.positions)).toBeGreaterThan(maxX(orig.positions) + 0.5);

    // The tint is the skin-tone layer's colour everywhere (its mask is solid).
    const dds = parseDds(await ws.vfs.read(res!.tint));
    expect([dds.width, dds.height]).toEqual([512, 512]);
    // Compressed like the CK's tints: BC3 with mipmaps down to 2×2.
    expect(dds.format).toBe('bc3');
    expect(dds.mipmaps.length).toBe(9);
    const px = decodeToRgba(dds.mipmaps[0]!, dds.format)!;
    [230, 190, 160, 255].forEach((v, i) => expect(Math.abs(px[i]! - v)).toBeLessThanOrEqual(1));

    expect(await faces.needingFaces()).toEqual([]);
    // Undo removes the generated files.
    ws.undo();
    await ws.filesSettled();
    expect(ws.vfs.has(res!.mesh)).toBe(false);
    await expect(fs.readFile(`${ws.options.outputDir}/${res!.mesh.replace(/\\/g, '/')}`)).rejects.toThrow();
  });

  it("paints tint layers through the race's masks", async () => {
    const { ws, faces, npcs } = await setup();
    const keeper = ws.byEditorId('DemoInnkeeper')!;
    const dds = parseDds(await faces.composeTint(npcs.appearance(keeper)));
    const px = decodeToRgba(dds.mipmaps[0]!, dds.format)!;
    // Lips mask centre (u 0.25, v 0.61) is redder than the forehead.
    const at = (u: number, v: number) => Array.from(px.slice((Math.floor(v * 512) * 512 + Math.floor(u * 512)) * 4, (Math.floor(v * 512) * 512 + Math.floor(u * 512)) * 4 + 3));
    const lips = at(0.25, 0.61);
    const brow = at(0.25, 0.3);
    expect(lips[0]! - lips[1]!).toBeGreaterThan(brow[0]! - brow[1]! + 30);
  });

  it("uses the race's default head when a character lists none, and ignores the CK's unset slider marker", async () => {
    const { ws, faces, npcs } = await setup();
    const guard = ws.byEditorId('DemoGuard')!;
    expect(npcs.appearance(guard).headParts.map((k) => npcs.headPart(k)?.type)).toEqual(['Hair', 'Eyebrows']);
    expect(npcs.appearance(guard).morphs.vampireMorph).toBe(0);
    expect(faces.headPartsOf(guard).map((p) => p.editorId)).toEqual(['DemoHeadMale', 'DemoEyesBrown', 'DemoHairShort', 'DemoBrows']);
    const { nif } = await faces.bake(guard);
    const root = parseNif(nif).roots[0]!.children.find((c) => c.name === 'BSFaceGenNiNodeSkinned')!;
    // Race defaults (reversed), then the character's own (reversed).
    expect(root.children.map((c) => c.name)).toEqual(['DemoEyesBrown', 'DemoHeadMale', 'DemoBrows', 'DemoHairShort']);
    // Nothing moved: no sliders set, and the FLT_MAX marker wasn't applied as a weight.
    const orig = parseNif(await ws.vfs.read('meshes\\demo\\head_male.nif')).roots[0]!.children[0]!.mesh!;
    const head = root.children.find((c) => c.name === 'DemoHeadMale')!.mesh!;
    expect(head.positions.every((v, i) => Math.abs(v - orig.positions[i]!) < 1e-4)).toBe(true);
    // Editing other sliders keeps the marker in the record.
    npcs.setAppearance(guard, { morphs: { ...npcs.appearance(guard).morphs, noseUpDown: 0.5 } });
    expect((ws.view(guard)!.data as any).faceMorph.vampireMorph).toBeGreaterThan(1e38);
  });

  it('lists every character with the state of its face files, skips template looks, and re-exports on request', async () => {
    const { ws, faces, npcs } = await setup();
    expect(await faces.faceFiles()).toEqual([]);
    const smith = ws.byEditorId('DemoBlacksmith')!;
    const guard = ws.byEditorId('DemoGuard')!;
    await faces.setLook(smith, { morphs: { ...npcs.appearance(smith).morphs, noseLongShort: -0.5 } });
    // The guard takes its looks from the smith: the game builds that face from the template, so it needs no files.
    const g = ws.view(guard)!.data as Record<string, any>;
    ws.updateRecord(guard, { ...g, template: smith, config: { ...g.config, templateFlags: 1 } });
    npcs.setAppearance(guard, { morphs: { ...npcs.appearance(guard).morphs, noseLongShort: 0.5 } });
    expect(npcs.looksTemplate(guard)).toBe(smith);

    let list = await faces.faceFiles();
    expect(list.map((f) => [f.editorId, f.status, f.edited])).toEqual([
      ['DemoBlacksmith', 'missing', true],
      ['DemoGuard', 'template', false],
    ]);
    expect(list[1]!.template).toBe(smith);
    expect(await faces.needingFaces()).toEqual([smith]);
    expect(npcs.faceGenProblems().map((p) => p.npc)).not.toContain(guard);

    await faces.generate();
    list = await faces.faceFiles();
    expect(list[0]!.status).toBe('ok');
    // Changing the look makes the files out of date again.
    await faces.setLook(smith, { morphs: { ...npcs.appearance(smith).morphs, noseLongShort: 0.25 } });
    expect((await faces.faceFiles())[0]!.status).toBe('outdated');
    // Exporting a chosen character always rewrites its files (like the CK's Ctrl+F4), as one undo step.
    const out = await faces.generate([smith]);
    expect(out.map((o) => o.npc)).toEqual([smith]);
    expect((await faces.faceFiles())[0]!.status).toBe('ok');
    ws.undo();
    await ws.filesSettled();
    expect((await faces.faceFiles())[0]!.status).toBe('outdated');
  });

  it('explains when there is no head to bake', async () => {
    const { ws, faces, npcs } = await setup();
    const guard = ws.byEditorId('DemoGuard')!;
    npcs.setAppearance(guard, { race: null as never });
    await expect(faces.bake(guard)).rejects.toThrow(/no head/);
  });
});
