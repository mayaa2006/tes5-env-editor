import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { MemoryFileSystem, ScriptService, Workspace, createDemoData, type ProcessRunner } from '../src';

/**
 * A stand-in for Caprica.exe: takes many files, writes <name>.pex to --output,
 * and reports errors the way Caprica does for sources containing BROKEN.
 * With `stopOnError`, files after a failing one are left uncompiled.
 */
function fakeCaprica(fs: MemoryFileSystem, stopOnError = false): ProcessRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(_cmd, args) {
      calls.push(args);
      const out = args[args.indexOf('--output') + 1]!;
      const flags = args[args.indexOf('--flags') + 1]!;
      if (!(await fs.exists(flags))) return { code: 1, stdout: `Unable to locate flags file '${flags}'.`, stderr: '' };
      const files = args.slice(args.indexOf('--flags') + 2);
      const errors: string[] = [];
      for (const file of files) {
        const src = new TextDecoder().decode(await fs.readFile(file));
        if (src.includes('BROKEN')) {
          errors.push(`${file} (2, 1:7): Error: mismatched input 'BROKEN'`, `Compilation of '${file}' failed; 0 warnings and 1 errors were encountered.`);
          if (stopOnError) break;
          continue;
        }
        const name = file.replace(/^.*[\\/]/, '').replace(/\.psc$/i, '');
        fs.writeFileSync(`${out}/${name}.pex`, new Uint8Array([0xfa, 0x57, 0xc0, 0xde]));
      }
      return { code: errors.length ? 1 : 0, stdout: 'Importing files...', stderr: errors.join('\n') };
    },
  };
}

async function setup() {
  const fs = new MemoryFileSystem();
  const demo = createDemoData(fs);
  // Your mod in its own folder (as with Mod Organizer), so the demo's own scripts are "game" scripts.
  fs.writeFileSync('/MyMod/meta.ini', new Uint8Array(0));
  const ws = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir, '/MyMod'], outputDir: '/MyMod', loadOrder: [{ name: 'DemoWorld.esm', active: true }] });
  await ws.scan();
  await ws.load();
  ws.createPlugin('Scripts.esp');
  const scripts = new ScriptService(ws);
  scripts.refresh();
  return { fs, demo, ws, scripts };
}

describe('compiling scripts with less work', () => {
  it('uses the Caprica that comes with the app, else finds the Creation Kit compiler', async () => {
    const { fs, demo, scripts } = await setup();
    expect(await scripts.findCompiler()).toBeNull();
    fs.writeFileSync(`${demo.gameDir}/Papyrus Compiler/PapyrusCompiler.exe`, new Uint8Array(0));
    expect(await scripts.findCompiler()).toEqual({ kind: 'papyrus-compiler', executable: `${demo.gameDir}/Papyrus Compiler/PapyrusCompiler.exe` });
    scripts.bundledCaprica = '/App/resources/caprica/Caprica.exe';
    expect((await scripts.findCompiler())!.kind).toBe('papyrus-compiler'); // not there (yet)
    fs.writeFileSync(scripts.bundledCaprica, new Uint8Array(0));
    expect(await scripts.activeCompiler()).toEqual({ kind: 'caprica', executable: '/App/resources/caprica/Caprica.exe' });
    // A compiler chosen in the settings wins.
    scripts.compiler = { kind: 'papyrus-compiler', executable: 'C:/CK/PapyrusCompiler.exe' };
    expect((await scripts.activeCompiler())!.executable).toBe('C:/CK/PapyrusCompiler.exe');
  });

  it("unpacks the CK's Scripts.zip when the game's sources aren't there yet, keeping files already there", async () => {
    const { fs, demo, scripts } = await setup();
    await fs.remove(`${demo.dataDir}/Source/Scripts/TESV_Papyrus_Flags.flg`);
    expect(await scripts.sourcesState()).toEqual({ ready: false, zip: null });
    fs.writeFileSync(
      `${demo.dataDir}/Scripts.zip`,
      zipSync({
        'Source/Scripts/TESV_Papyrus_Flags.flg': strToU8('Flag hidden 0\r\n'),
        'Source/Scripts/Utility.psc': strToU8('Scriptname Utility Hidden\r\n'),
        'Source/Scripts/DemoChestScript.psc': strToU8('Scriptname DemoChestScript extends ObjectReference ; from the zip\r\n'),
        'readme.txt': strToU8('not a script'),
      }),
    );
    expect(await scripts.sourcesState()).toEqual({ ready: false, zip: `${demo.dataDir}/Scripts.zip` });
    const before = new TextDecoder().decode(await fs.readFile(`${demo.dataDir}/Source/Scripts/DemoChestScript.psc`));
    expect(await scripts.unpackSources()).toBe(2);
    expect((await scripts.sourcesState()).ready).toBe(true);
    expect(scripts.has('Utility')).toBe(true);
    expect(new TextDecoder().decode(await fs.readFile(`${demo.dataDir}/Source/Scripts/DemoChestScript.psc`))).toBe(before);
    expect(await fs.exists(`${demo.dataDir}/readme.txt`)).toBe(false);
  });

  it('compiles only your scripts that changed, all in one Caprica run, and the .pex counts as part of the mod', async () => {
    const { fs, ws, scripts } = await setup();
    await scripts.write('MyGreeting', 'Scriptname MyGreeting extends ObjectReference\n');
    await scripts.write('MyDoor', 'Scriptname MyDoor extends ObjectReference\n');
    expect(await scripts.outOfDate()).toEqual(['MyDoor', 'MyGreeting']);
    const runner = fakeCaprica(fs);
    scripts.runner = runner;
    scripts.bundledCaprica = '/App/Caprica.exe';
    fs.writeFileSync('/App/Caprica.exe', new Uint8Array(0));
    const first = await scripts.compileOutOfDate();
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.slice(-2).map((f) => f.replace(/^.*\//, ''))).toEqual(['MyDoor.psc', 'MyGreeting.psc']);
    expect(first.map((r) => [r.script, r.ok])).toEqual([
      ['MyDoor', true],
      ['MyGreeting', true],
    ]);
    expect(ws.vfs.has('scripts\\mydoor.pex')).toBe(true);
    expect(await fs.exists('/MyMod/Scripts/MyDoor.pex')).toBe(true);
    expect(await scripts.outOfDate()).toEqual([]);
    expect(await scripts.compileOutOfDate()).toEqual([]);
    // Edit one: only that one is compiled again.
    await new Promise((r) => setTimeout(r, 5));
    await scripts.write('MyDoor', 'Scriptname MyDoor extends ObjectReference\nBROKEN\n');
    expect(await scripts.outOfDate()).toEqual(['MyDoor']);
    const second = await scripts.compileOutOfDate();
    expect(second).toHaveLength(1);
    expect(second[0]!.ok).toBe(false);
    expect(second[0]!.messages[0]).toMatchObject({ line: 2, severity: 'error' });
    expect(runner.calls).toHaveLength(2);
  });

  it("compiles the others alone when one script's failure stopped them", async () => {
    const { fs, scripts } = await setup();
    await scripts.write('AaBroken', 'Scriptname AaBroken\nBROKEN\n');
    await scripts.write('BbFine', 'Scriptname BbFine\n');
    const runner = fakeCaprica(fs, true);
    scripts.runner = runner;
    scripts.compiler = { kind: 'caprica', executable: 'Caprica.exe' };
    const r = await scripts.compileOutOfDate();
    expect(r.map((x) => [x.script, x.ok])).toEqual([
      ['AaBroken', false],
      ['BbFine', true],
    ]);
    expect(runner.calls).toHaveLength(2);
  });

  it('says what to do when there is nothing to compile with', async () => {
    const { fs, demo, scripts } = await setup();
    await scripts.write('MyDoor', 'Scriptname MyDoor\n');
    await expect(scripts.compile(['MyDoor'])).rejects.toThrow(/can't be compiled in the demo/);
    scripts.runner = fakeCaprica(fs);
    await expect(scripts.compile(['MyDoor'])).rejects.toThrow(/No Papyrus compiler found/);
    scripts.compiler = { kind: 'caprica', executable: 'Caprica.exe' };
    await fs.remove(`${demo.dataDir}/Source/Scripts/TESV_Papyrus_Flags.flg`);
    await expect(scripts.compile(['MyDoor'])).rejects.toThrow(/Unpack the game's script sources/);
  });
});
