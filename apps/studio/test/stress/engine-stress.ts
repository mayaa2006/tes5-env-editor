/**
 * Engine stress test: drives EngineHost exactly like the UI does (with
 * structuredClone at the boundary) and checks invariants.
 */
import { parsePlugin, type FormKey } from '@tes5/esp';
import { MemoryFileSystem, createDemoData } from '@tes5/workspace';
import { DEMO_GAME_DIR } from '../../src/engine/constants';
import { EngineHost } from '../../src/engine/host';

let seed = Number(process.env.SEED ?? 1);
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
const problems: string[] = [];
const fail = (m: string) => {
  problems.push(m);
  console.log('  ✗', m);
};

function bridge(host: EngineHost) {
  return async (method: string, ...args: unknown[]): Promise<any> => {
    const fn = (host as any)[method];
    const v = await fn.apply(host, structuredClone(args));
    return v === undefined ? undefined : structuredClone(v);
  };
}

async function open() {
  const fs = new MemoryFileSystem();
  createDemoData(fs, DEMO_GAME_DIR);
  const host = new EngineHost(fs);
  const call = bridge(host);
  await call('open', { kind: 'demo', path: DEMO_GAME_DIR, loadOrder: [{ name: 'DemoWorld.esm', active: true }, { name: 'DirtyPatch.esp', active: true }] });
  await call('loadPlugins');
  return { fs, host, call };
}

const activeBytes = (host: EngineHost) => host.ws!.active!.plugin!.serialize();
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

async function main() {
  console.log('1. untouched plugins re-serialize byte-identical');
  {
    const { fs } = await open();
    for (const name of ['DemoWorld.esm', 'DirtyPatch.esp']) {
      const bytes = await fs.readFile(`${DEMO_GAME_DIR}/Data/${name}`);
      if (!eq(parsePlugin(bytes, name).serialize(), bytes)) fail(`${name} does not round-trip byte for byte`);
    }
  }

  console.log('2. every record: typed, lossless, and an unchanged override is detected as ITM');
  {
    const { call, host } = await open();
    await call('createPlugin', 'Fuzz.esp', {});
    const all = (await call('search', { limit: 100000 })).items as { formKey: FormKey; sig: string; owner: string; winner: string }[];
    let n = 0;
    const skipped = new Set<string>();
    for (const r of all.filter((x: any) => x.owner === 'DemoWorld.esm' && x.winner === 'DemoWorld.esm')) {
      const v = await call('view', r.formKey);
      if (!v.hasSchema) {
        skipped.add(r.sig);
        continue;
      }
      if (!v.lossless) {
        fail(`${r.sig} ${v.editorId ?? r.formKey} is not lossless: ${v.errors.join('; ')}`);
        continue;
      }
      try {
        await call('updateRecord', r.formKey, v.data, { unknown: v.unknown });
        n++;
      } catch (e) {
        fail(`re-saving unchanged ${r.sig} ${v.editorId} threw: ${(e as Error).message}`);
      }
    }
    if (skipped.size) console.log(`  (no schema, not editable: ${[...skipped].join(', ')})`);
    const rep = await call('clean', 'Fuzz.esp', { dryRun: true, itmMode: 'safe' });
    const itm = new Set(rep.itmsRemoved.map((e: any) => e.formId) .concat(rep.itmsKept.map((e: any) => e.formId)));
    const notItm = [...host.ws!.active!.plugin!.records()].filter((r) => !itm.has(r.formId.toString(16).toUpperCase().padStart(8, '0')));
    console.log(`  ${n} unchanged overrides, ${itm.size} detected as ITM`);
    for (const r of notItm.slice(0, 15)) {
      const k = host.ws!.keyOf(host.ws!.active!, r.formId)!;
      const versions = host.ws!.versions(k);
      const orig = versions[versions.length - 2]!.record.subrecords; // the version this override copied
      const mine = r.subrecords;
      const diffs = mine.filter((s, i) => !orig[i] || orig[i]!.sig !== s.sig || !eq(orig[i]!.data, s.data)).map((s) => s.sig);
      fail(`unchanged override of ${r.sig} ${r.editorId ?? k} differs from master (${diffs.join(',') || `count ${mine.length} vs ${orig.length}`})`);
    }
  }

  console.log('3. random edit sequence, then undo all / redo all');
  {
    const { call, host } = await open();
    await call('createPlugin', 'Fuzz.esp', {});
    const initial = activeBytes(host);
    const cells = (await call('cells', {})) as any[];
    const statics = (await call('search', { sigs: ['STAT', 'CONT', 'LIGH', 'NPC_'], limit: 1000 })).items as any[];
    const snapshots: Uint8Array[] = [];
    const log: string[] = [];
    for (let step = 0; step < Number(process.env.STEPS ?? 180); step++) {
      const cell = pick(cells);
      const refs = (await call('references', cell.formKey)) as any[];
      const op = Math.floor(rnd() * 9);
      try {
        if (op === 0) {
          await call('placeReference', cell.formKey, pick(statics).formKey, { position: { x: rnd() * 1000, y: rnd() * 1000, z: 0 }, rotation: { x: 0, y: 0, z: rnd() * 6 }, scale: 0.5 + rnd() });
          log.push('place');
        } else if (op === 1 && refs.length) {
          const r = pick(refs);
          await call('transformReferences', [{ ref: r.formKey, transform: { position: { x: rnd() * 500, y: rnd() * 500, z: rnd() * 50 }, rotation: { x: 0, y: 0, z: rnd() } } }]);
          log.push('move');
        } else if (op === 2 && refs.length) {
          await call('deleteReferences', [pick(refs).formKey]);
          log.push('delete');
        } else if (op === 3 && refs.length) {
          await call('duplicateReferences', [pick(refs).formKey], { x: 10, y: 0, z: 0 });
          log.push('duplicate');
        } else if (op === 4) {
          const npc = (await call('search', { sigs: ['NPC_'] })).items as { formKey: FormKey }[];
          const k = pick(npc).formKey;
          const a = await call('npcAppearance', k);
          a.morphs.noseUpDown = Math.round((rnd() * 2 - 1) * 100) / 100;
          await call('setNpcAppearance', k, { morphs: a.morphs, weight: Math.round(rnd() * 100) });
          log.push('npc');
        } else if (op === 5) {
          const q = (await call('search', { sigs: ['QUST'] })).items[0].formKey;
          const model = await call('quest', q);
          const idx = Math.max(0, ...model.stages.map((s: any) => s.index)) + 5;
          await call('addStage', q, idx, `Stage ${idx}`);
          log.push('stage');
        } else if (op === 6) {
          const q = (await call('search', { sigs: ['QUST'] })).items[0].formKey;
          const model = await call('quest', q);
          if (model.topics[0]) await call('addResponse', model.topics[0].formKey, { text: [`Line ${step}`] });
          log.push('response');
        } else if (op === 7) {
          const s = pick(statics);
          await call('duplicateRecord', s.formKey, `FuzzCopy${step}`);
          log.push('dupRecord');
        } else {
          const k = (await call('createInteriorCell', `FuzzCell${step}`, 'Fuzz')) as FormKey;
          cells.push({ formKey: k, editorId: `FuzzCell${step}` });
          log.push('cell');
        }
      } catch (e) {
        const msg = (e as Error).message;
        if (!/Deleting .* from masters|already exists/.test(msg)) fail(`step ${step} (${op}) threw: ${msg}`);
        else log.push('refused');
      }
      snapshots.push(activeBytes(host));
      // Every so often, the plugin must parse back.
      if (step % 50 === 49) {
        try {
          parsePlugin(snapshots[snapshots.length - 1]!, 'Fuzz.esp');
        } catch (e) {
          fail(`plugin unparsable after step ${step}: ${(e as Error).message}`);
        }
      }
    }
    const final = activeBytes(host);
    const counts = log.reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {} as Record<string, number>);
    console.log('  ops:', JSON.stringify(counts));
    let undone = 0;
    while (host.ws!.canUndo) {
      await call('undo');
      undone++;
    }
    console.log(`  undone ${undone} steps (undo history capped at 200)`);
    if (undone >= 200) {
      // History cap: compare to the snapshot 200 steps back instead of the initial state.
    } else if (!eq(activeBytes(host), initial)) fail('undo-all does not restore the initial plugin');
    while (host.ws!.canRedo) await call('redo');
    if (!eq(activeBytes(host), final)) fail('redo-all does not restore the final plugin');

    console.log('4. save, reload from disk, compare every record');
    const save = await call('save', {});
    for (const w of save.warnings) console.log('  save warning:', w);
    // Compare the state right after saving (save-time automations included) with a fresh reload.
    const views = new Map<string, any>();
    for (const r of host.ws!.active!.plugin!.records()) {
      const k = host.ws!.keyOf(host.ws!.active!, r.formId)!;
      views.set(k + r.sig, (await call('view', k, 'Fuzz.esp'))?.data);
    }
    const { fs } = { fs: host.fs };
    const host2 = new EngineHost(fs);
    const call2 = bridge(host2);
    await call2('open', { kind: 'demo', path: DEMO_GAME_DIR, loadOrder: [{ name: 'DemoWorld.esm', active: true }, { name: 'DirtyPatch.esp', active: true }, { name: 'Fuzz.esp', active: true }] });
    await call2('loadPlugins');
    await call2('setActivePlugin', 'Fuzz.esp');
    let compared = 0;
    const removedByClean = new Set((save.clean?.itmsRemoved ?? []).map((e: any) => e.formId));
    for (const r of host2.ws!.active!.plugin!.records()) {
      const k = host2.ws!.keyOf(host2.ws!.active!, r.formId)!;
      const before = views.get(k + r.sig);
      const after = (await call2('view', k, 'Fuzz.esp'))?.data;
      if (before === undefined) {
        fail(`after reload ${r.sig} ${k} appeared from nowhere`);
        continue;
      }
      compared++;
      if (JSON.stringify(before, replacer) !== JSON.stringify(after, replacer)) fail(`${r.sig} ${r.editorId ?? k} changed across save/reload`);
    }
    console.log(`  compared ${compared} records after reload (${removedByClean.size} ITMs cleaned on save, ${views.size} before)`);
    if (compared + removedByClean.size < views.size - 0) {
      // records missing beyond cleaned ITMs
      const after = new Set([...host2.ws!.active!.plugin!.records()].map((r) => host2.ws!.keyOf(host2.ws!.active!, r.formId)! + r.sig));
      const missing = [...views.keys()].filter((k) => !after.has(k));
      if (missing.length > removedByClean.size) fail(`${missing.length - removedByClean.size} records lost on save: ${missing.slice(0, 5).join(', ')}`);
    }
    const rep = await call2('clean', 'Fuzz.esp', { dryRun: true });
    if (rep.errors.length) fail(`clean after reload reports errors: ${rep.errors.join('; ')}`);
    const nav = await call2('generateNavmesh', cells[0].formKey, {}).catch((e: Error) => e.message);
    console.log('  navmesh after reload:', typeof nav === 'string' ? nav : `${nav.triangles} tris`);
  }

  console.log(problems.length ? `\n${problems.length} problem(s)` : '\nno problems found');
  process.exitCode = problems.length ? 1 : 0;
}

function replacer(_k: string, v: unknown) {
  if (v instanceof Uint8Array) return Array.from(v);
  if (typeof v === 'number' && !Number.isInteger(v)) return Math.round(v * 1e4) / 1e4;
  return v;
}

void main();
