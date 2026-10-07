import { describe, expect, it } from 'vitest';
import { nifShapes, parseBsd, parseOsd, readNifDoc, writeOsd } from '@tes5/assets';
import { BodySlideService, MemoryFileSystem, Workspace, createDemoData, parseXml, xmlAttr, xmlChildren } from '../src';

async function setup() {
  const fs = new MemoryFileSystem();
  const demo = createDemoData(fs);
  const ws = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir], outputDir: demo.dataDir, loadOrder: [{ name: 'DemoWorld.esm', active: true }] });
  await ws.scan();
  await ws.load();
  ws.createPlugin('Body.esp');
  return { ws, fs, body: new BodySlideService(ws) };
}

const maxAbs = (a: Float32Array, b: Float32Array) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i]!)), 0);

describe('xml reader', () => {
  it('reads attributes, entities, text and CDATA, and skips comments', () => {
    const x = parseXml('<?xml version="1.0"?><!-- hi --><A n="1 &amp; 2"><B x=\'q\'/><C><![CDATA[<raw>]]></C><C> t </C></A>');
    expect(xmlAttr(x, 'N')).toBe('1 & 2');
    expect(xmlChildren(x, 'c').map((c) => c.text)).toEqual(['<raw>', 't']);
    expect(xmlAttr(xmlChildren(x, 'B')[0]!, 'x')).toBe('q');
  });
});

describe('shape data files', () => {
  it('round-trips an .osd and reads an old .bsd', () => {
    const d = { indices: Uint32Array.from([1, 5]), deltas: Float32Array.from([1, 2, 3, -1, -2, -3]) };
    const back = parseOsd(writeOsd({ A: d }));
    expect([...back.get('A')!.indices]).toEqual([1, 5]);
    expect([...back.get('A')!.deltas]).toEqual([1, 2, 3, -1, -2, -3]);
    const bsd = new Uint8Array(4 + 2 * 14);
    const dv = new DataView(bsd.buffer);
    dv.setUint32(0, 2, true);
    dv.setUint16(4, 7, true);
    dv.setFloat32(6, 0.5, true);
    dv.setUint16(18, 9, true);
    const b = parseBsd(bsd);
    expect([...b.indices]).toEqual([7, 9]);
    expect(b.deltas[0]).toBe(0.5);
    expect(() => parseOsd(new Uint8Array(20))).toThrow(/osd/);
  });
});

describe('BodySlide', () => {
  it('finds the set, its sliders and its presets', async () => {
    const { body } = await setup();
    const sets = await body.list();
    expect(sets.map((s) => s.name)).toEqual(['Demo Body']);
    expect(sets[0]).toMatchObject({ sliders: 4, shapes: ['DemoBody'], output: { folder: 'meshes\\demo\\bodyslide', file: 'demobody' } });
    expect(sets[0]!.problem).toBeUndefined();
    expect((await body.sliders('demo body')).map((s) => s.label)).toEqual(['Breasts', 'Waist', 'Hips', 'Height']);
    expect(await body.defaults('Demo Body')).toMatchObject({ Breasts: { small: 0, big: 40 } });
    const presets = await body.presets('Demo Body');
    expect(presets.map((p) => p.name)).toEqual(['Demo Curvy', 'Demo Slim']);
    expect(presets[0]!.values.Breasts).toEqual({ small: 30, big: 100 });
    expect(await body.presets('Some Other Set')).toEqual([]);
  });

  it('shapes the body from slider values, with the small value at weight 0 and the big one at weight 1', async () => {
    const { body } = await setup();
    await body.list();
    const none = { Breasts: { small: 0, big: 0 }, Waist: { small: 0, big: 0 }, Hips: { small: 0, big: 0 }, Height: { small: 0, big: 0 } };
    const flat = (await body.preview('Demo Body', none, 1)).shapes[0]!;
    expect(flat.positions.length).toBe(flat.normals.length);
    const values = { ...none, Waist: { small: 0, big: 100 }, Hips: { small: 50, big: 100 } };
    const w0 = (await body.preview('Demo Body', values, 0)).shapes[0]!.positions;
    const w1 = (await body.preview('Demo Body', values, 1)).shapes[0]!.positions;
    const half = (await body.preview('Demo Body', values, 0.5)).shapes[0]!.positions;
    expect(maxAbs(w0, flat.positions)).toBeGreaterThan(0.5); // hips at 50%
    expect(maxAbs(w1, w0)).toBeGreaterThan(1);
    // The middle weight sits between the two.
    for (let i = 0; i < w0.length; i++) expect(half[i]!).toBeCloseTo((w0[i]! + w1[i]!) / 2, 3);
    // 200% of a morph goes twice as far as 100%.
    const one = (await body.preview('Demo Body', { ...none, Hips: { small: 100, big: 100 } }, 1)).shapes[0]!.positions;
    const two = (await body.preview('Demo Body', { ...none, Hips: { small: 200, big: 200 } }, 1)).shapes[0]!.positions;
    expect(maxAbs(two, flat.positions)).toBeCloseTo(2 * maxAbs(one, flat.positions), 3);
  });

  it('builds the _0 and _1 meshes, which one undo removes', async () => {
    const { ws, fs, body } = await setup();
    await body.list();
    const values = { Breasts: { small: 0, big: 100 }, Waist: { small: 0, big: 0 }, Hips: { small: 0, big: 0 }, Height: { small: 0, big: 0 } };
    const r = await body.build('Demo Body', values);
    expect(r.files).toEqual(['meshes\\demo\\bodyslide\\demobody_0.nif', 'meshes\\demo\\bodyslide\\demobody_1.nif']);
    const base = nifShapes(readNifDoc(await ws.vfs.read('meshes\\demo\\bodyslide\\demobody_1.nif')))[0]!.positions;
    const w0 = nifShapes(readNifDoc(await fs.readFile('/Demo/Skyrim Special Edition/Data/meshes/demo/bodyslide/demobody_0.nif')))[0]!;
    const w1 = nifShapes(readNifDoc(await fs.readFile('/Demo/Skyrim Special Edition/Data/meshes/demo/bodyslide/demobody_1.nif')))[0]!;
    expect(w0.positions.length).toBe(base.length);
    expect(maxAbs(w0.positions, w1.positions)).toBeGreaterThan(1);
    expect(ws.undoLabel).toBe('Build body Demo Body');
    ws.undo();
    await ws.filesSettled();
    expect(await fs.exists('/Demo/Skyrim Special Edition/Data/meshes/demo/bodyslide/demobody_0.nif')).toBe(false);
    ws.redo();
    await ws.filesSettled();
    expect(await fs.exists('/Demo/Skyrim Special Edition/Data/meshes/demo/bodyslide/demobody_0.nif')).toBe(true);
  });

  it('builds under another name, and refuses to leave the Data folder', async () => {
    const { ws, body } = await setup();
    await body.list();
    const r = await body.build('Demo Body', {}, { folder: 'meshes\\mybody', file: 'mine_1.nif' });
    expect(r.files[1]).toBe('meshes\\mybody\\mine_1.nif');
    expect(ws.vfs.has('meshes\\mybody\\mine_0.nif')).toBe(true);
    await expect(body.build('Demo Body', {}, { folder: '..\\..\\x' })).rejects.toThrow(/outside/);
  });

  it('saves a preset that reads back, as one undo step', async () => {
    const { ws, body } = await setup();
    await body.list();
    const p = await body.savePreset('My <Look>', 'Demo Body', { Waist: { small: 10, big: 80.4 }, Nope: { small: 1, big: 1 } });
    expect(p.name).toBe('My _Look_');
    expect(p.values).toEqual({ Waist: { small: 10, big: 80 } });
    expect((await body.presets('Demo Body')).map((x) => x.name)).toContain('My _Look_');
    ws.undo();
    await ws.filesSettled();
    expect((await body.presets('Demo Body')).map((x) => x.name)).not.toContain('My _Look_');
  });

  it('says why a set can’t be used', async () => {
    const { fs, body } = await setup();
    const sets = '/Demo/Skyrim Special Edition/Data/CalienteTools/BodySlide/SliderSets';
    const osp = new TextDecoder().decode(await fs.readFile(`${sets}/DemoBody.osp`));
    await fs.writeFile(`${sets}/Lost.osp`, new TextEncoder().encode(osp.replace('Demo Body', 'Lost Body').replace('demobody_1.nif', 'nothere_1.nif')));
    const found = await body.list();
    expect(found.find((s) => s.name === 'Lost Body')!.problem).toMatch(/nothere_1\.nif/);
    await expect(body.preview('Lost Body', {}, 1)).rejects.toThrow(/Lost Body/);
    // Missing morph data is a warning, not a failure: the slider just does nothing.
    await fs.remove('/Demo/Skyrim Special Edition/Data/CalienteTools/BodySlide/ShapeData/DemoBody/DemoBody.osd');
    await body.list();
    expect((await body.check('Demo Body')).some((w) => /no morph data/.test(w))).toBe(true);
  });
});
