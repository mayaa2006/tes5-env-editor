#!/usr/bin/env node
/**
 * tes5 — command line tools.
 *
 *   tes5 info <plugin>
 *   tes5 clean <plugin> [--data <dir>] [--mode safe|xedit] [--dry-run] [--fix-navmeshes] [--json]
 *   tes5 esl <plugin> [--data <dir>]
 *   tes5 bsa list <archive>
 *   tes5 bsa extract <archive> <outDir>
 *   tes5 bsa pack <folder> <out.bsa> [--le] [--no-compress]
 *   tes5 nif <file.nif>
 */
import { basename, dirname, join, relative, resolve } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { BsaArchive, flattenMeshes, nifBounds, parseNif, writeBsa } from '@tes5/assets';
import { MapMasterSource, cleanPlugin, crc32, summarizeReport, type CleanReport } from '@tes5/cleaner';
import { parsePlugin, recordTypeName, type Plugin } from '@tes5/esp';
import { NodeFileSystem } from '@tes5/workspace/node';

const fs = new NodeFileSystem();

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(`Usage:
  tes5 info <plugin>
  tes5 clean <plugin> [--data <dir>] [--mode safe|xedit] [--dry-run] [--fix-navmeshes] [--json]
  tes5 esl <plugin>
  tes5 bsa list <archive>
  tes5 bsa extract <archive> <outDir>
  tes5 bsa pack <folder> <out.bsa> [--le] [--no-compress]
  tes5 nif <file.nif>`);
  process.exit(msg ? 2 : 0);
}

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

async function loadPlugin(path: string): Promise<Plugin> {
  return parsePlugin(await fs.readFile(path), basename(path));
}

/** Load a plugin's masters (recursively) from the data folder. */
async function loadMasters(plugin: Plugin, dataDir: string): Promise<MapMasterSource> {
  const src = new MapMasterSource();
  const files = new Map(readdirSync(dataDir).map((f) => [f.toLowerCase(), join(dataDir, f)]));
  const queue = [...plugin.masters];
  while (queue.length) {
    const m = queue.shift()!;
    if (src.get(m)) continue;
    const p = files.get(m.toLowerCase());
    if (!p) throw new Error(`Master ${m} not found in ${dataDir}`);
    const mp = parsePlugin(await fs.readFile(p), basename(p));
    src.add(mp);
    queue.push(...mp.masters);
  }
  return src;
}

function printReport(r: CleanReport): void {
  const section = (title: string, list: { formId: string; sig: string; editorId?: string; detail?: string }[]) => {
    if (!list.length) return;
    console.log(`\n${title} (${list.length}):`);
    for (const e of list.slice(0, 200)) console.log(`  [${e.sig}:${e.formId}] ${e.editorId ?? ''}${e.detail ? ` — ${e.detail}` : ''}`);
    if (list.length > 200) console.log(`  ... and ${list.length - 200} more`);
  };
  section(r.dryRun ? 'Identical to master (would remove)' : 'Removed identical to master', r.itmsRemoved);
  section('Kept: identical to master but has children', r.itmsKept);
  section('Kept: intentional reverts of a later master', r.reverts);
  section(r.dryRun ? 'Deleted references (would undelete & disable)' : 'Undeleted & disabled references', r.undeleted);
  section('Deleted navmeshes', r.deletedNavmeshes);
  section('Navmeshes fixed (experimental)', r.navmeshesFixed);
  section('Skipped', r.skipped);
  if (r.errors.length) console.log(`\nErrors:\n  ${r.errors.join('\n  ')}`);
  console.log(`\n${summarizeReport(r)}`);
}

async function main(argv: string[]): Promise<void> {
  const args = [...argv];
  const cmd = args.shift();
  switch (cmd) {
    case undefined:
    case '-h':
    case '--help':
      usage();
    case 'info': {
      const file = args[0] ?? usage('missing plugin path');
      const bytes = await fs.readFile(file);
      const p = parsePlugin(bytes, basename(file));
      const counts = new Map<string, number>();
      for (const r of p.records()) counts.set(r.sig, (counts.get(r.sig) ?? 0) + 1);
      const own = [...p.records()].filter((r) => r.formId >>> 24 === p.masters.length).length;
      console.log(`${p.describe()}  CRC32 ${crc32(bytes).toString(16).toUpperCase().padStart(8, '0')}`);
      console.log(`Author: ${p.author || '-'}\nDescription: ${p.description || '-'}`);
      console.log(`HEDR: version ${p.hedr.version}, records ${p.hedr.numRecords}, next object ${p.hedr.nextObjectId.toString(16)}`);
      console.log(`Masters: ${p.masters.join(', ') || '(none)'}`);
      console.log(`New records: ${own}, overrides: ${[...counts.values()].reduce((a, b) => a + b, 0) - own}`);
      for (const [sig, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${sig}  ${String(n).padStart(6)}  ${recordTypeName(sig)}`);
      return;
    }
    case 'clean': {
      const dryRun = flag(args, '--dry-run');
      const json = flag(args, '--json');
      const fixNav = flag(args, '--fix-navmeshes');
      const mode = (option(args, '--mode') ?? 'safe') as 'safe' | 'xedit';
      const file = resolve(args[0] ?? usage('missing plugin path'));
      const dataDir = resolve(option(args, '--data') ?? dirname(file));
      const plugin = await loadPlugin(file);
      const masters = await loadMasters(plugin, dataDir);
      const report = cleanPlugin(plugin, masters, { itmMode: mode, dryRun, fixDeletedNavmeshes: fixNav });
      if (!dryRun && !report.errors.length) {
        const backup = `${file}.backup-${Date.now()}`;
        await fs.rename(file, backup);
        await fs.writeFile(file, plugin.serialize());
        if (!json) console.log(`Backup: ${backup}`);
      }
      if (json) console.log(JSON.stringify(report, null, 2));
      else printReport(report);
      process.exitCode = report.errors.length ? 1 : 0;
      return;
    }
    case 'esl': {
      const file = args[0] ?? usage('missing plugin path');
      const p = await loadPlugin(file);
      const self = p.masters.length;
      const own = [...p.records()].filter((r) => r.formId >>> 24 === self);
      const out = own.filter((r) => (r.formId & 0xffffff) < 0x800 || (r.formId & 0xffffff) > 0xfff);
      console.log(`${p.fileName}: ${own.length} new records, ${out.length} outside the ESL range (0x800-0xFFF)`);
      console.log(own.length > 2048 ? 'Not eligible: more than 2048 new records.' : out.length ? 'Eligible after compacting FormIDs (do this in the Studio; it updates references).' : 'Eligible: can be ESL-flagged as is.');
      return;
    }
    case 'bsa': {
      const sub = args.shift();
      if (sub === 'list') {
        const file = args[0] ?? usage('missing archive');
        const f = fs.openRandomAccess(file);
        const a = new BsaArchive({ size: f.size, read: f.read }, basename(file));
        console.log(`${basename(file)}: v${a.version}, ${a.files.length} files`);
        for (const e of a.files) console.log(`  ${e.path}  ${e.storedSize}${e.compressed ? ' (compressed)' : ''}`);
        f.close();
        return;
      }
      if (sub === 'extract') {
        const file = args[0] ?? usage('missing archive');
        const outDir = args[1] ?? usage('missing output folder');
        const f = fs.openRandomAccess(file);
        const a = new BsaArchive({ size: f.size, read: f.read }, basename(file));
        for (const e of a.files) {
          const target = join(outDir, ...e.path.split('\\'));
          await fs.mkdir(dirname(target));
          await fs.writeFile(target, a.read(e));
        }
        f.close();
        console.log(`Extracted ${a.files.length} files to ${outDir}`);
        return;
      }
      if (sub === 'pack') {
        const le = flag(args, '--le');
        const noCompress = flag(args, '--no-compress');
        const folder = resolve(args[0] ?? usage('missing folder'));
        const out = args[1] ?? usage('missing output archive');
        const files = new Map<string, Uint8Array>();
        const walk = async (dir: string) => {
          for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            if (statSync(p).isDirectory()) await walk(p);
            else files.set(relative(folder, p), await fs.readFile(p));
          }
        };
        await walk(folder);
        await fs.writeFile(out, writeBsa(files, { version: le ? 104 : 105, compress: !noCompress }));
        console.log(`Packed ${files.size} files into ${out}`);
        return;
      }
      usage('unknown bsa command');
    }
    case 'nif': {
      const file = args[0] ?? usage('missing nif');
      const nif = parseNif(await fs.readFile(file));
      console.log(`${basename(file)}: ${nif.game} (BS ${nif.bsVersion}), ${nif.blockTypes.length} block types`);
      for (const { mesh } of flattenMeshes(nif)) {
        console.log(`  ${mesh.name || '(unnamed)'}: ${mesh.positions.length / 3} vertices, ${mesh.indices.length / 3} triangles, textures: ${mesh.material.textures.filter(Boolean).join(', ') || '-'}`);
      }
      const b = nifBounds(nif);
      if (b) console.log(`  bounds: [${b.min.map((v) => v.toFixed(1)).join(', ')}] - [${b.max.map((v) => v.toFixed(1)).join(', ')}]`);
      for (const w of nif.warnings) console.log(`  warning: ${w}`);
      return;
    }
    default:
      usage(`unknown command ${cmd}`);
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
