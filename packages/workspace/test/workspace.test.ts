import { describe, expect, it } from 'vitest';
import { writeBsa } from '@tes5/assets';
import { parsePlugin, type FormKey, type Navmesh, type Vmad } from '@tes5/esp';
import {
  MemoryFileSystem,
  NpcService,
  QuestService,
  ScriptService,
  VirtualData,
  WorldService,
  Workspace,
  createDemoData,
  eslReport,
  compactFormIds,
  setLightFlag,
  generateCellNavmesh,
  parseModlist,
  readMo2Instance,
  readMo2Profile,
  uiSchema,
  voiceFileName,
  detectInstall,
  findInstalls,
  parseSteamLibraries,
} from '../src';

async function openDemo(withActive = true) {
  const fs = new MemoryFileSystem();
  const demo = createDemoData(fs);
  const ws = new Workspace(fs, {
    game: 'SkyrimSE',
    roots: [demo.dataDir],
    outputDir: demo.dataDir,
    loadOrder: [
      { name: 'DemoWorld.esm', active: true },
      { name: 'DirtyPatch.esp', active: true },
    ],
  });
  await ws.scan();
  await ws.load();
  if (withActive) ws.createPlugin('MyMod.esp', { author: 'Tester' });
  return { fs, ws, demo };
}

function key(ws: Workspace, edid: string): FormKey {
  const k = ws.byEditorId(edid);
  if (!k) throw new Error(`missing ${edid}`);
  return k;
}

describe('game detection and load order', () => {
  it('detects the demo install and builds the load order', async () => {
    const fs = new MemoryFileSystem();
    const demo = createDemoData(fs);
    const inst = await detectInstall(fs, demo.gameDir);
    expect(inst?.game).toBe('SkyrimSE');
    const { ws } = await openDemo(false);
    expect(ws.slots.map((s) => [s.name, s.active])).toEqual([
      ['DemoWorld.esm', true],
      ['DirtyPatch.esp', true],
    ]);
    expect(ws.vfs.has('meshes\\demo\\crate.nif')).toBe(true);
  });

  it('finds Skyrim in every Steam library without asking', async () => {
    expect(parseSteamLibraries('"libraryfolders"\n{\n "0"\n {\n  "path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n }\n "1"\n {\n  "path"\t\t"D:\\\\Games\\\\Steam"\n }\n}')).toEqual(['C:\\Program Files (x86)\\Steam', 'D:\\Games\\Steam']);
    const fs = new MemoryFileSystem();
    const steam = 'C:/Program Files (x86)/Steam';
    fs.writeFileSync(`${steam}/steamapps/libraryfolders.vdf`, new TextEncoder().encode('"libraryfolders" { "1" { "path" "D:\\\\Games\\\\Steam" } }'));
    const game = 'D:/Games/Steam/steamapps/common/Skyrim Special Edition';
    fs.writeFileSync(`${game}/SkyrimSE.exe`, new Uint8Array(1));
    fs.writeFileSync(`${game}/Data/placeholder.txt`, new Uint8Array(1));
    const found = await findInstalls(fs, {});
    expect(found.map((f) => [f.game, f.gameDir?.replace(/\\/g, '/')])).toEqual([['SkyrimSE', game]]);
    expect(await findInstalls(new MemoryFileSystem(), {})).toEqual([]);
  });
});

describe('records and editing', () => {
  it('finds and views records with load-order independent FormKeys', async () => {
    const { ws } = await openDemo();
    const smith = key(ws, 'DemoBlacksmith');
    expect(smith).toBe('000823:DemoWorld.esm'.replace('823', smith.slice(3, 6)));
    const v = ws.view(smith)!;
    expect(v.lossless).toBe(true);
    expect(v.data.name).toBe('Halvar the Smith');
    expect(ws.summary(v.data.race as FormKey)?.editorId).toBe('DemoHumanRace');
    const found = ws.search({ sigs: ['STAT'], query: 'crate' });
    expect(found.items.map((i) => i.editorId)).toEqual(['DemoCrate']);
    // The crate is overridden by the dirty patch.
    expect(ws.view(key(ws, 'DemoCrate'))!.overrides).toEqual(['DemoWorld.esm', 'DirtyPatch.esp']);
  });

  it('creates overrides, adds masters automatically and supports undo/redo', async () => {
    const { ws } = await openDemo();
    const smith = key(ws, 'DemoBlacksmith');
    // Masters are added automatically when the plugin first references a form.
    expect(ws.active!.plugin!.masters).toEqual([]);
    ws.editRecord(smith, (d) => {
      d.name = 'Halvar the Bold';
    });
    expect(ws.active!.plugin!.masters).toEqual(['DemoWorld.esm']);
    expect(ws.view(smith)!.data.name).toBe('Halvar the Bold');
    expect(ws.view(smith)!.winner).toBe('MyMod.esp');
    expect(ws.view(smith, 'DemoWorld.esm')!.data.name).toBe('Halvar the Smith');
    expect(ws.undo()).toBe(true);
    expect(ws.view(smith)!.data.name).toBe('Halvar the Smith');
    expect(ws.redo()).toBe(true);
    expect(ws.view(smith)!.data.name).toBe('Halvar the Bold');
  });

  it('creates new records that reference other plugins', async () => {
    const { ws } = await openDemo();
    const crate = key(ws, 'DemoCrate');
    const npc = ws.duplicateRecord(key(ws, 'DemoGuard'), 'MyGuardCaptain');
    expect(npc.endsWith(':MyMod.esp')).toBe(true);
    const v = ws.view(npc)!;
    expect(v.data.editorId).toBe('MyGuardCaptain');
    expect(v.data.race).toBe(key(ws, 'DemoHumanRace'));
    expect(ws.findReferences(crate)).toEqual([]);
  });

  it('refuses to delete master base records but disables master references', async () => {
    const { ws } = await openDemo();
    expect(() => ws.deleteRecord(key(ws, 'DemoCrate'))).toThrow(/breaks anything/);
    const world = new WorldService(ws);
    const tavern = key(ws, 'DemoTavern');
    const refs = world.references(tavern);
    const crateRef = refs.find((r) => r.baseEditorId === 'DemoBarrel')!;
    expect(ws.deleteRecord(crateRef.formKey)).toBe('disabled');
    const after = world.references(tavern).find((r) => r.formKey === crateRef.formKey)!;
    expect(after.disabled).toBe(true);
    expect(after.transform.position.z).toBe(-30000);
  });

  it('exposes serializable UI schemas', () => {
    const s = uiSchema('NPC_')!;
    expect(s.members.find((m) => m.key === 'faceMorph')).toBeDefined();
    expect(JSON.parse(JSON.stringify(s)).sig).toBe('NPC_');
  });
});

describe('world editing', () => {
  it('lists cells and references with models and transforms', async () => {
    const { ws } = await openDemo();
    const world = new WorldService(ws);
    const cells = world.cells();
    expect(cells.map((c) => c.editorId)).toEqual(expect.arrayContaining(['DemoTavern', 'DemoValley0_0', 'DemoValley1_0']));
    const ext = cells.find((c) => c.editorId === 'DemoValley1_0')!;
    expect(ext.interior).toBe(false);
    expect(ext.grid).toEqual({ x: 1, y: 0 });
    const refs = world.references(key(ws, 'DemoTavern'));
    expect(refs.length).toBeGreaterThan(30);
    const keeper = refs.find((r) => r.editorId === 'DemoInnkeeperRef')!;
    expect(keeper.sig).toBe('ACHR');
    expect(keeper.persistent).toBe(true);
    expect(refs.find((r) => r.baseEditorId === 'DemoPillar')!.model).toBe('demo\\pillar.nif');
    expect(refs.find((r) => r.baseEditorId === 'DemoTorchLight')!.light!.radius).toBe(512);
  });

  it('places and moves references, copying the parent cell into the plugin', async () => {
    const { ws } = await openDemo();
    const world = new WorldService(ws);
    const tavern = key(ws, 'DemoTavern');
    const ref = world.placeReference(tavern, key(ws, 'DemoBarrel'), { position: { x: 10, y: 20, z: 0 }, rotation: { x: 0, y: 0, z: 1 }, scale: 1.5 });
    expect(ws.view(tavern)!.overrides).toContain('MyMod.esp');
    const placed = world.references(tavern).find((r) => r.formKey === ref)!;
    expect(placed.transform.scale).toBeCloseTo(1.5);
    expect(placed.source).toBe('MyMod.esp');
    world.transformReferences([{ ref, transform: { position: { x: 100, y: 200, z: 0 }, scale: 1 } }]);
    const moved = world.references(tavern).find((r) => r.formKey === ref)!;
    expect(moved.transform.position).toEqual({ x: 100, y: 200, z: 0 });
    expect(moved.transform.scale).toBe(1);
    // Moving a master reference creates an override in the right cell group.
    const pillar = world.references(tavern).find((r) => r.baseEditorId === 'DemoPillar')!;
    world.transformReferences([{ ref: pillar.formKey, transform: { position: { x: 5, y: 5, z: 0 } } }]);
    expect(ws.view(pillar.formKey)!.parent.cell).toBe(tavern);
  });

  it('reads LAND terrain and builds exterior navmeshes on it', async () => {
    const { ws } = await openDemo();
    const world = new WorldService(ws);
    const cell = key(ws, 'DemoValley1_0');
    const land = world.terrain(cell)!;
    expect(land.origin).toEqual({ x: 4096, y: 0 });
    expect(land.heights).toHaveLength(33 * 33);
    const expected = 60 * (Math.sin((4096 + 128 * 5 + 37) / 600) * Math.cos((128 * 7 - 13) / 500) + 0.3 * Math.sin(((4096 + 128 * 5) * 1.7 + 128 * 7) / 260));
    expect(Math.abs(land.heights[7 * 33 + 5]! - expected)).toBeLessThanOrEqual(4);
    expect(land.colors).toHaveLength(33 * 33 * 3);
    expect(world.terrain(key(ws, 'DemoTavern'))).toBeUndefined();
    const res = await generateCellNavmesh(ws, cell);
    expect(res.triangles).toBeGreaterThan(20);
    const nav = ws.view(res.navmesh)!.data.geometry as Navmesh;
    for (const v of nav.vertices) {
      expect(v.x).toBeGreaterThanOrEqual(4096 - 1);
      expect(v.x).toBeLessThanOrEqual(8192 + 1);
    }
  });

  it('generates a navmesh for a cell', async () => {
    const { ws } = await openDemo();
    const res = await generateCellNavmesh(ws, key(ws, 'DemoTavern'));
    expect(res.usedRecast).toBe(true);
    expect(res.triangles).toBeGreaterThan(10);
    expect(res.doors).toBe(1);
    expect(res.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const nav = ws.view(res.navmesh)!.data.geometry as Navmesh;
    expect(nav.doorLinks).toHaveLength(1);
    expect(ws.view(res.navmesh)!.parent.cell).toBe(key(ws, 'DemoTavern'));
  });
});

describe('NPC appearance', () => {
  it('reads and writes the character-creator model', async () => {
    const { ws } = await openDemo();
    const npcs = new NpcService(ws);
    const keeper = key(ws, 'DemoInnkeeper');
    const a = npcs.appearance(keeper);
    expect(a.female).toBe(true);
    expect(a.morphs.cheeksUpDown).toBeCloseTo(0.4);
    const hair = npcs.headParts({ race: a.race, female: true, type: 'Hair' });
    expect(hair.map((h) => h.editorId)).toEqual(['DemoHairLong', 'DemoHairShort']);
    expect(npcs.headParts({ female: true, type: 'Facial Hair' })).toEqual([]);
    npcs.setAppearance(keeper, { weight: 80, morphs: { ...a.morphs, noseLongShort: 0.7 }, headParts: a.headParts.map((h) => (h === hair[0]!.formKey ? hair[1]!.formKey : h)) });
    const b = npcs.appearance(keeper);
    expect(b.weight).toBe(80);
    expect(b.morphs.noseLongShort).toBeCloseTo(0.7);
    expect(b.headParts).toContain(hair[1]!.formKey);
    expect(() => npcs.setAppearance(keeper, { headParts: [hair[0]!.formKey, hair[1]!.formKey] })).toThrow(/Only one Hair/);
    expect(npcs.faceGenProblems().map((p) => p.editorId)).toEqual(['DemoInnkeeper']);
  });
});

describe('quests, dialogue and scripts', () => {
  it('builds a quest with stages, aliases, dialogue and fragments', async () => {
    const { ws, fs, demo } = await openDemo();
    const scripts = new ScriptService(ws);
    scripts.refresh();
    const quests = new QuestService(ws, scripts);
    const q = quests.createQuest('MyQuest', 'My Quest', { startGameEnabled: true });
    quests.addStage(q, 0, undefined, { startUp: true });
    quests.addStage(q, 10, 'Talk to Brynja.');
    quests.addObjective(q, 10, 'Talk to Brynja');
    const alias = quests.addReferenceAlias(q, 'Brynja', { uniqueActor: key(ws, 'DemoInnkeeper') });
    expect(alias).toBe(0);
    expect(quests.addLocationAlias(q, 'Town')).toBe(1);
    const topic = quests.createTopic(q, { editorId: 'MyQuestHello', text: 'Hello there.' });
    const r1 = quests.addResponse(topic, { text: 'Welcome, traveller.', speaker: key(ws, 'DemoInnkeeper') });
    const r2 = quests.addResponse(topic, { text: ['Line one.', 'Line two.'], goodbye: true });
    const infos = quests.infos(topic);
    expect(infos.map((i) => i.formKey)).toEqual([r1, r2]);
    expect(infos[1]!.responses.map((r) => r.responseNumber)).toEqual([1, 2]);

    const scriptName = await quests.setStageFragment(q, 10, 'SetObjectiveDisplayed(10)\nAlias_Brynja.GetActorRef().EvaluatePackage()');
    expect(scriptName).toMatch(/^QF_MyQuest_[0-9A-F]{8}$/);
    const model = quests.quest(q);
    expect(model.stages.find((s) => s.index === 10)!.logEntries[0]!.fragment).toBe('Fragment_0');
    const vm = ws.view(q)!.data.scripts as Vmad;
    expect(vm.scripts[0]!.properties[0]).toEqual({ name: 'Alias_Brynja', type: 1, flags: 1, value: { form: q, alias: 0 } });
    // The generated fragment script is valid Papyrus.
    const src = await scripts.read(scriptName);
    expect((await scripts.check(src)).filter((d) => d.severity === 'error')).toEqual([]);

    const infoScript = await quests.setInfoFragment(r1, 'end', 'GetOwningQuest().SetStage(10)');
    expect(infoScript).toMatch(/^TIF__/);
    expect(quests.infos(topic)[0]!.hasEndFragment).toBe(true);

    const voice = quests.voiceFiles(q);
    expect(voice[0]!.voiceTypes).toEqual(['FemaleCommoner']);
    expect(voice[0]!.paths[0]).toMatch(/^Sound\/Voice\/MyMod\.esp\/FemaleCommoner\/MyQuest_MyQuestHello_[0-9A-F]{8}_1\.fuz$/);

    const saved = await ws.save();
    expect(saved.extraFiles.some((f) => f.endsWith('SEQ/MyMod.seq'))).toBe(true);
    const seq = await fs.readFile(`${demo.dataDir}/SEQ/MyMod.seq`);
    expect(seq.byteLength).toBe(4);
    const reparsed = parsePlugin(await fs.readFile(saved.path), 'MyMod.esp');
    expect([...reparsed.recordsOfType('INFO')].length).toBe(2);
    // Topic info count was kept up to date on save.
    expect(ws.view(topic)!.data.infoCount).toBe(2);
  });

  it('truncates long voice file names like the CK', () => {
    expect(voiceFileName('DialogueGenericVampire', 'HelloTopicForTheVampires', '00ABCD:Mod.esp', 1)).toBe('DialogueGe_HelloTopicForTh_0000ABCD_1');
    expect(voiceFileName('MQ101', 'Hello', '000801:Mod.esp', 2)).toBe('MQ101_Hello_00000801_2');
  });

  it('auto-fills script properties by EditorID', async () => {
    const { ws } = await openDemo();
    const scripts = new ScriptService(ws);
    scripts.refresh();
    expect(scripts.list().map((s) => s.name)).toEqual(['DemoChestScript', 'DemoQuestScript']);
    const quest = key(ws, 'DemoTavernQuest');
    const filled = await scripts.autofill(quest);
    expect(filled).toEqual([{ script: 'DemoQuestScript', property: 'DemoGoldReward', value: key(ws, 'DemoGoldReward') }]);
    const diags = await scripts.check(await scripts.read('DemoChestScript'));
    expect(diags.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('saving and cleaning', () => {
  it('cleans ITMs created while editing, keeps real edits, and writes backups', async () => {
    const { ws, fs, demo } = await openDemo();
    const crate = key(ws, 'DemoCrate');
    ws.editRecord(crate, (d) => d); // touched but unchanged → ITM
    const smith = key(ws, 'DemoBlacksmith');
    ws.editRecord(smith, (d) => {
      d.height = 1.1;
    });
    const r = await ws.save();
    expect(r.clean!.itmsRemoved.map((e) => e.formId)).toEqual([crate.slice(0, 6).padStart(8, '0')]);
    const p = parsePlugin(await fs.readFile(r.path), 'MyMod.esp');
    expect([...p.records()].map((x) => x.editorId)).toEqual(['DemoBlacksmith']);
    await ws.save();
    const backups = await fs.readdir(`${demo.dataDir}/tes5-backups`);
    expect(backups.length).toBe(1);
  });

  it('reports the dirty patch like xEdit would', async () => {
    const { ws } = await openDemo(false);
    const report = ws.clean('DirtyPatch.esp');
    expect(report.itmsRemoved.length).toBe(2); // crate STAT + crate reference
    expect(report.undeleted.length).toBe(1);
    expect(report.itmsKept.map((e) => e.sig)).toEqual(['CELL']);
  });

  it('reports ESL eligibility', async () => {
    const { ws } = await openDemo();
    ws.duplicateRecord(key(ws, 'DemoCrate'), 'MyCrate');
    const r = eslReport(ws);
    expect(r.newRecords).toBe(1);
    expect(r.eligible).toBe(true);
    expect(r.flagged).toBe(false);
  });

  it('flags and unflags a plugin as ESL, with undo', async () => {
    const { ws } = await openDemo();
    ws.duplicateRecord(key(ws, 'DemoCrate'), 'MyCrate');
    // The new record's ID may be outside 0x800-0xFFF; compact first if so.
    if (!eslReport(ws).eligible) compactFormIds(ws);
    setLightFlag(ws, true);
    expect(ws.active!.plugin!.isESL).toBe(true);
    expect(ws.active!.isLight).toBe(true);
    expect(eslReport(ws).flagged).toBe(true);
    expect(ws.undo()).toBe(true);
    expect(ws.active!.plugin!.isESL).toBe(false);
    expect(ws.active!.isLight).toBe(false);
    ws.redo();
    expect(ws.active!.plugin!.isESL).toBe(true);
    setLightFlag(ws, false);
    expect(ws.active!.plugin!.isESL).toBe(false);
  });
});

describe('Mod Organizer 2 and archives', () => {
  it('resolves an MO2 profile into roots with mod priority', async () => {
    const fs = new MemoryFileSystem();
    const demo = createDemoData(fs, '/Games/Skyrim Special Edition');
    fs.writeFileSync('/MO2/ModOrganizer.ini', `[General]\r\ngameName=Skyrim Special Edition\r\ngamePath=@ByteArray(/Games/Skyrim Special Edition)\r\nselected_profile=@ByteArray(Default)\r\n`);
    fs.writeFileSync('/MO2/profiles/Default/modlist.txt', '# generated\r\n+Better Crates\r\n-Disabled Mod\r\n+Base Retexture\r\n');
    fs.writeFileSync('/MO2/profiles/Default/plugins.txt', '*DemoWorld.esm\r\nDirtyPatch.esp\r\n*BetterCrates.esp\r\n');
    fs.writeFileSync('/MO2/profiles/Default/loadorder.txt', 'DemoWorld.esm\r\nDirtyPatch.esp\r\nBetterCrates.esp\r\n');
    fs.writeFileSync('/MO2/mods/Base Retexture/textures/demo/wood.dds', new Uint8Array([1]));
    fs.writeFileSync('/MO2/mods/Better Crates/textures/demo/wood.dds', new Uint8Array([2]));
    fs.writeFileSync('/MO2/mods/Better Crates/BetterCrates.esp', (await fs.readFile(`${demo.dataDir}/DirtyPatch.esp`)).slice());
    const inst = await readMo2Instance(fs, '/MO2');
    expect(inst.modsDir).toBe('/MO2/mods');
    const profile = await readMo2Profile(fs, inst);
    expect(profile.mods).toEqual(['Base Retexture', 'Better Crates']);
    expect(profile.plugins.map((p) => [p.name, p.active])).toEqual([
      ['DemoWorld.esm', true],
      ['DirtyPatch.esp', false],
      ['BetterCrates.esp', true],
    ]);
    const vfs = new VirtualData(fs, { game: 'SkyrimSE', roots: profile.roots, plugins: ['DemoWorld.esm', 'BetterCrates.esp'] });
    await vfs.build();
    expect(await vfs.read('textures/demo/wood.dds')).toEqual(new Uint8Array([2]));
    expect(vfs.entry('textures\\demo\\wood.dds')!.overridden).toHaveLength(2);
    expect(parseModlist('+A\r\n+B\r\n').enabled).toEqual(['B', 'A']);
  });

  it('reads files from plugin archives, with loose files winning', async () => {
    const fs = new MemoryFileSystem();
    fs.writeFileSync('/D/Mod.esp', new Uint8Array(0));
    fs.writeFileSync('/D/Mod.bsa', writeBsa({ 'meshes/a.nif': new Uint8Array([1]), 'meshes/b.nif': new Uint8Array([2]) }));
    fs.writeFileSync('/D/meshes/b.nif', new Uint8Array([9]));
    const vfs = new VirtualData(fs, { game: 'SkyrimSE', roots: ['/D'], plugins: ['Mod.esp'] });
    await vfs.build();
    expect(await vfs.read('meshes\\a.nif')).toEqual(new Uint8Array([1]));
    expect(await vfs.read('meshes\\b.nif')).toEqual(new Uint8Array([9]));
    expect(vfs.children('meshes').files.map((f) => f.path)).toEqual(['meshes\\a.nif', 'meshes\\b.nif']);
  });
});

describe('winner index', () => {
  it('reflects active-plugin edits immediately without a rebuild', async () => {
    const { ws } = await openDemo();
    const before = ws.search({ sigs: ['STAT'], query: 'DemoBarrel' });
    expect(before.items.map((i) => i.editorId)).toContain('DemoBarrel');
    const key = before.items.find((i) => i.editorId === 'DemoBarrel')!.formKey;
    ws.editRecord(key, (d) => ({ ...d, editorId: 'RenamedBarrel' }));
    expect(ws.search({ sigs: ['STAT'], query: 'RenamedBarrel' }).items[0]).toMatchObject({ formKey: key, inActive: true, winner: 'MyMod.esp' });
    expect(ws.byEditorId('RenamedBarrel')).toBe(key);
    const created = ws.createRecord('STAT', { editorId: 'BrandNewStatic', bounds: { x1: 0, y1: 0, z1: 0, x2: 0, y2: 0, z2: 0 }, directionalMaterial: { maxAngle: 90, material: null, consideredSnow: 0, unused: new Uint8Array(3) } });
    expect(ws.search({ query: 'BrandNewStatic' }).items.map((i) => i.formKey)).toEqual([created]);
    ws.undo();
    expect(ws.search({ query: 'BrandNewStatic' }).total).toBe(0);
  });
});

describe('regressions', () => {
  it('keeps FormID fields that are present but None (MESG INAM = 0) when re-saving', async () => {
    const { ws } = await openDemo();
    const k = key(ws, 'DemoWelcomeMsg');
    const v = ws.view(k)!;
    expect(v.data.icon).toBeNull();
    ws.updateRecord(k, v.data, { unknown: v.unknown });
    const mine = ws.versions(k).at(-1)!.record;
    expect(mine.subrecords.map((s) => s.sig)).toEqual(ws.versions(k)[0]!.record.subrecords.map((s) => s.sig));
    expect(ws.clean('MyMod.esp', { dryRun: true }).itmsRemoved.map((e) => e.editorId)).toContain('DemoWelcomeMsg');
  });

  it('keeps Editor IDs unique and valid', async () => {
    const { ws } = await openDemo();
    const crate = key(ws, 'DemoCrate');
    const a = ws.duplicateRecord(crate);
    const b = ws.duplicateRecord(crate);
    expect([ws.view(a)!.editorId, ws.view(b)!.editorId]).toEqual(['DemoCrateCopy', 'DemoCrateCopy2']);
    const v = ws.view(a)!;
    expect(() => ws.updateRecord(a, { ...v.data, editorId: 'DemoBarrel' }, { unknown: v.unknown })).toThrow(/already used/);
    expect(() => ws.updateRecord(a, { ...v.data, editorId: 'Bad Name!' }, { unknown: v.unknown })).toThrow(/letters, digits/);
    // A failed edit leaves nothing behind.
    expect(ws.view(a)!.editorId).toBe('DemoCrateCopy');
    // Renaming frees the old ID; editing other fields with an unchanged ID is fine.
    ws.updateRecord(a, { ...v.data, editorId: 'FreshName' }, { unknown: v.unknown });
    expect(ws.byEditorId('DemoCrateCopy')).toBeUndefined();
    expect(ws.byEditorId('FreshName')).toBe(a);
    const barrel = key(ws, 'DemoBarrel');
    const bv = ws.view(barrel)!;
    ws.updateRecord(barrel, bv.data, { unknown: bv.unknown });
    // Renaming a master form in the active plugin frees its old ID too.
    ws.updateRecord(barrel, { ...bv.data, editorId: 'BarrelRenamed' }, { unknown: bv.unknown });
    expect(ws.byEditorId('DemoBarrel')).toBeUndefined();
    expect(() => new WorldService(ws).createInteriorCell('DemoTavern')).toThrow(/already used/);
  });
});

describe('text encoding', () => {
  it('shows Windows-1252 punctuation in names and warns about unencodable text', async () => {
    const { ws } = await openDemo();
    const npc = key(ws, 'DemoGuard');
    const v = ws.view(npc)!;
    ws.updateRecord(npc, { ...v.data, name: 'Ñandú — “quoted” €' }, { unknown: v.unknown });
    expect(ws.view(npc)!.name).toBe('Ñandú — “quoted” €');
    expect(ws.search({ sigs: ['NPC_'], query: '“quoted”' }).total).toBe(1);
    const warnings: string[] = [];
    ws.on((e) => e.type === 'warning' && warnings.push(e.message));
    const v2 = ws.view(npc)!;
    ws.updateRecord(npc, { ...v2.data, name: 'Привет' }, { unknown: v2.unknown });
    expect(warnings.join()).toMatch(/can't be stored.*П/);
  });
});

describe('deleting forms', () => {
  it('relinks dialogue order and warns about remaining references', async () => {
    const { ws } = await openDemo();
    const quests = new QuestService(ws, new ScriptService(ws));
    const q = quests.createQuest('DelQuest', 'Del');
    const topic = quests.createTopic(q, { editorId: 'DelTopic', text: 'Hi?' });
    const i1 = quests.addResponse(topic, { text: 'one' });
    const i2 = quests.addResponse(topic, { text: 'two' });
    const i3 = quests.addResponse(topic, { text: 'three' });
    ws.deleteRecord(i2);
    expect((ws.view(i3)!.data as { previousInfo: unknown }).previousInfo).toBe(i1);
    expect(quests.topics(q)[0]!.infos.map((i) => i.responses[0]!.text)).toEqual(['one', 'three']);
    const warnings: string[] = [];
    ws.on((e) => e.type === 'warning' && warnings.push(e.message));
    const crateCopy = ws.duplicateRecord(key(ws, 'DemoCrate'));
    new WorldService(ws).placeReference(key(ws, 'DemoTavern'), crateCopy);
    ws.deleteRecord(crateCopy);
    expect(warnings.join()).toMatch(/still point to the deleted/);
  });
});

describe('damaged load orders', () => {
  it('skips corrupt plugins and plugins with missing masters instead of failing', async () => {
    const fs = new MemoryFileSystem();
    const demo = createDemoData(fs);
    // Corrupt one plugin's header and add one whose master doesn't exist.
    const dirty = `${demo.dataDir}/DirtyPatch.esp`;
    const b = await fs.readFile(dirty);
    b.fill(0xee, 60, 90);
    await fs.writeFile(dirty, b);
    const orphan = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir], outputDir: demo.dataDir, loadOrder: [{ name: 'DemoWorld.esm', active: true }] });
    await orphan.scan();
    await orphan.load();
    orphan.createPlugin('NeedsMissing.esp');
    orphan.active!.plugin!.setMasters(['Missing.esm']);
    await orphan.save();

    const ws = new Workspace(fs, {
      game: 'SkyrimSE',
      roots: [demo.dataDir],
      outputDir: demo.dataDir,
      loadOrder: [
        { name: 'DemoWorld.esm', active: true },
        { name: 'DirtyPatch.esp', active: true },
        { name: 'NeedsMissing.esp', active: true },
      ],
    });
    const warnings: string[] = [];
    ws.on((e) => e.type === 'warning' && warnings.push(e.message));
    await ws.scan();
    await ws.load();
    expect(ws.slot('DemoWorld.esm')!.plugin).toBeDefined();
    expect(ws.slot('DirtyPatch.esp')!.error).toMatch(/Unreadable|Corrupt/);
    expect(ws.slot('NeedsMissing.esp')!.error).toMatch(/Missing.esm/);
    expect(warnings.length).toBe(2);
    expect(ws.search({ sigs: ['STAT'] }).total).toBeGreaterThan(5);
  });
});
