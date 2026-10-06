/**
 * Performance check at Skyrim.esm scale: synthesizes a master with ~900k
 * records (statics, NPCs, interior cells full of references, compressed
 * records) and times what the editor does on open and during editing.
 *
 *   npm run bench            (from the repo root)
 *   BENCH_SCALE=0.25 npm run bench   for a quicker run
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GroupType, Plugin, PluginGroup, PluginRecord, RecordFlags, interiorBlock, parsePlugin, zstringBytes } from '@tes5/esp';
import { Workspace } from '../src/engine';
import { NodeFileSystem } from '../src/node';
import { WorldService } from '../src/world';

const scale = Number(process.env.BENCH_SCALE ?? 1);
const N_STAT = Math.round(250_000 * scale);
const N_NPC = Math.round(5_000 * scale);
const N_CELL = Math.round(20_000 * scale);
const REFS_PER_CELL = 30;

const u32 = (v: number) => new Uint8Array(new Uint32Array([v]).buffer);
const f32s = (...v: number[]) => new Uint8Array(new Float32Array(v).buffer);
const sub = (sig: string, data: Uint8Array) => ({ sig, data });

function time<T>(label: string, fn: () => T): T {
  const t = performance.now();
  const r = fn();
  console.log(`${label.padEnd(42)} ${(performance.now() - t).toFixed(0).padStart(7)} ms`);
  return r;
}
async function timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = performance.now();
  const r = await fn();
  console.log(`${label.padEnd(42)} ${(performance.now() - t).toFixed(0).padStart(7)} ms`);
  return r;
}

function build(): Plugin {
  const p = Plugin.create('Big.esm', { game: 'SkyrimSE' });
  let id = 0x800;
  const stat = PluginGroup.top('STAT');
  const statIds: number[] = [];
  for (let i = 0; i < N_STAT; i++) {
    const fid = id++;
    statIds.push(fid);
    stat.children.push(
      PluginRecord.create('STAT', fid, [
        sub('EDID', zstringBytes(`BenchStatic${i}`)),
        sub('OBND', new Uint8Array(12)),
        sub('MODL', zstringBytes(`bench\\static${i % 500}.nif`)),
        sub('DNAM', new Uint8Array([0, 0, 0xb4, 0x42, 0, 0, 0, 0, 0, 0, 0, 0])),
      ]),
    );
  }
  const npc = PluginGroup.top('NPC_');
  for (let i = 0; i < N_NPC; i++) {
    // NPCs in Skyrim.esm are compressed.
    const r = PluginRecord.create('NPC_', id++, [sub('EDID', zstringBytes(`BenchNpc${i}`)), sub('ACBS', new Uint8Array(24)), sub('FULL', zstringBytes(`Bench NPC ${i}`)), sub('DATA', new Uint8Array(0))], RecordFlags.Compressed);
    npc.children.push(r);
  }
  const cellTop = PluginGroup.top('CELL');
  const blocks = new Map<string, PluginGroup>();
  for (let c = 0; c < N_CELL; c++) {
    const cid = id++;
    const { block, subBlock } = interiorBlock(cid);
    let b = cellTop.children.find((g) => g.kind === 'group' && g.label === block) as PluginGroup | undefined;
    if (!b) cellTop.children.push((b = new PluginGroup(GroupType.InteriorCellBlock, block)));
    const key = `${block}/${subBlock}`;
    let sb = blocks.get(key);
    if (!sb) {
      sb = new PluginGroup(GroupType.InteriorCellSubBlock, subBlock);
      b.children.push(sb);
      blocks.set(key, sb);
    }
    sb.children.push(PluginRecord.create('CELL', cid, [sub('EDID', zstringBytes(`BenchCell${c}`)), sub('DATA', new Uint8Array([1, 0]))]));
    const temp = new PluginGroup(GroupType.CellTemporaryChildren, cid);
    for (let r = 0; r < REFS_PER_CELL; r++) {
      temp.children.push(PluginRecord.create('REFR', id++, [sub('NAME', u32(statIds[(c * 31 + r) % statIds.length]!)), sub('DATA', f32s(r * 64, c % 100, 0, 0, 0, r * 0.1))]));
    }
    sb.children.push(new PluginGroup(GroupType.CellChildren, cid, [temp]));
  }
  p.groups.push(stat, npc, cellTop);
  p.invalidateIndex();
  p.updateHeaderBookkeeping();
  return p;
}

const dir = join(tmpdir(), `tes5-bench-${process.pid}`);
const data = join(dir, 'Data');
mkdirSync(data, { recursive: true });
try {
  {
    const plugin = time('generate', build);
    const bytes = time('serialize', () => plugin.serialize());
    console.log(`  ${plugin.countRecordsAndGroups().toLocaleString()} records+groups, ${(bytes.length / 1048576).toFixed(1)} MB`);
    writeFileSync(join(data, 'Big.esm'), bytes);
    writeFileSync(join(dir, 'SkyrimSE.exe'), new Uint8Array(0));
    time('parsePlugin (raw)', () => parsePlugin(bytes, 'Big.esm'));
  }
  const ws = new Workspace(new NodeFileSystem(), { game: 'SkyrimSE', roots: [data], outputDir: data, loadOrder: [{ name: 'Big.esm', active: true }] });
  await timeAsync('workspace scan', () => ws.scan());
  await timeAsync('workspace load', () => ws.load());
  time('warm indexes', () => ws.warm());
  const world = new WorldService(ws);
  time('search STAT "Static12345" (builds index)', () => ws.search({ sigs: ['STAT'], query: 'Static12345', limit: 400 }));
  time('search STAT "Static999" (cached)', () => ws.search({ sigs: ['STAT'], query: 'Static999', limit: 400 }));
  time('search all types, no query (first 400)', () => ws.search({ limit: 400 }));
  time('search NPC_ by name', () => ws.search({ sigs: ['NPC_'], query: 'NPC 42', limit: 400 }));
  const cells = time('cells()', () => world.cells());
  const cell = cells[Math.floor(cells.length / 2)]!.formKey;
  time('references(cell) #1', () => world.references(cell));
  time('references(cell) #2', () => world.references(cell));
  time('winners() count', () => [...ws.winners()].length);
  const statKey = ws.search({ sigs: ['STAT'], limit: 1 }).items[0]!.formKey;
  time('view(STAT)', () => ws.view(statKey));
  time('findReferences(STAT) in all plugins', () => ws.findReferences(statKey, { allPlugins: true }));
  ws.createPlugin('BenchMod.esp');
  const ref = world.references(cell)[0]!.formKey;
  time('first edit (override + masters)', () => world.transformReferences([{ ref, transform: { position: { x: 1, y: 2, z: 3 } } }]));
  time('second edit', () => world.transformReferences([{ ref, transform: { position: { x: 4, y: 5, z: 6 } } }]));
  time('place reference', () => world.placeReference(cell, statKey, { position: { x: 0, y: 0, z: 0 } }));
  time('search STAT (rebuild after new plugin)', () => ws.search({ sigs: ['STAT'], query: 'Static4242', limit: 400 }));
  world.transformReferences([{ ref, transform: { position: { x: 7, y: 8, z: 9 } } }]);
  time('search STAT after another edit', () => ws.search({ sigs: ['STAT'], query: 'Static4243', limit: 400 }));
  time('undo', () => ws.undo());
  await timeAsync('save BenchMod.esp', () => ws.save());
  (globalThis as { gc?: () => void }).gc?.();
  const mem = process.memoryUsage();
  console.log(`heap after gc ${(mem.heapUsed / 1048576).toFixed(0)} MB, rss ${(mem.rss / 1048576).toFixed(0)} MB`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
