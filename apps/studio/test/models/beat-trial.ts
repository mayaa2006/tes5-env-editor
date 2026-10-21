/**
 * The beat reader on the test documents (beats/*.md and the Cartographer questline), scored against the expected
 * readings (beats/expected.ts): who and what were found, which beats were read right and in the right order, the
 * endings, and the author's lines linked to the right beat. With SKYRIM_DATA, names are looked up in Skyrim's own
 * load order (who's already in the game, which places are on the map), and each reading is compiled and checked.
 *
 *   [SKYRIM_DATA=<Data folder>] npx tsx apps/studio/test/models/beat-trial.ts <base url> <model> [--docs prose,nexus] [--log-ai answers.jsonl] [--replay answers.jsonl] [--save sheets.json]
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NodeFileSystem, NodeProcessRunner } from '@tes5/workspace/node';
import { BeatReader, QuestPlanner, WorldService, compileBeats, splitQuestline, validatePlan, type AiProvider, type BeatLookup, type BeatSheet } from '@tes5/workspace';
import { EngineHost } from '../../src/engine/host';
import { EXPECTED } from './beats/expected';
import { scoreBeats, type BeatScore } from './beats/score';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const [url, model] = args;
if (!url || !model) throw new Error('usage: beat-trial.ts <base url> <model> [--docs a,b] [--log-ai file] [--replay file] [--save file]');
const only = flag('--docs')?.split(',');

// --log-ai: every request and answer, one JSON line each. --replay: answers from such a file where the request is the
// same (asked again, the same question gets the same answer), the live model otherwise.
const aiLog = flag('--log-ai');
const live = globalThis.fetch;
const replay = flag('--replay');
const recorded = replay
  ? readFileSync(replay, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { request: { messages: unknown[] } | null; answer: string })
  : [];
const used = new Set<number>();
const key = (body: unknown) => JSON.stringify((body as { messages?: unknown[] } | null)?.messages ?? null);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  const i = recorded.findIndex((r, n) => !used.has(n) && key(r.request) === key(body));
  if (i >= 0) {
    used.add(i);
    return new Response(recorded[i]!.answer, { status: 200, headers: { 'content-type': /^(data:|:)/m.test(recorded[i]!.answer) ? 'text/event-stream' : 'application/json' } });
  }
  const t = Date.now();
  const res = await live(input, init);
  if (aiLog) {
    const copy = res.clone();
    void copy.text().then((answer) => appendFileSync(aiLog, `${JSON.stringify({ seconds: Math.round((Date.now() - t) / 1000), request: body, answer })}\n`)).catch(() => undefined);
  }
  return res;
}) as typeof fetch;

// Names looked up in Skyrim's load order, when it's given.
let lookup: BeatLookup | undefined;
const DATA = process.env.SKYRIM_DATA;
if (DATA) {
  const ESMS = ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm'];
  const h = new EngineHost(new NodeFileSystem(), new NodeProcessRunner());
  await h.open({ kind: 'folder', path: DATA, loadOrder: ESMS.map((name) => ({ name, active: true })), outputDir: join(process.env.TMPDIR ?? tmpdir(), `beat-trial-${process.pid}`) });
  await h.loadPlugins(ESMS);
  const ws = h.ws!;
  const world = new WorldService(ws);
  const exact = (sigs: string[], name: string) => {
    const l = name.toLowerCase().replace(/^the\s+/, '');
    return ws.search({ sigs, query: name.replace(/^the\s+/i, ''), limit: 300 }).items.find((i) => !i.deleted && (i.name ?? '').toLowerCase().replace(/^the\s+/, '') === l)?.editorId ?? null;
  };
  const interiors = world.cells({ interiorOnly: true });
  lookup = {
    person: (n) => exact(['NPC_'], n),
    place: (n) => {
      const l = n.toLowerCase().replace(/^the\s+/, '');
      return interiors.find((c) => (c.name ?? '').toLowerCase().replace(/^the\s+/, '') === l)?.editorId ?? world.mapMarker(n)?.name ?? null;
    },
    item: (n) => exact(['WEAP', 'ARMO', 'MISC', 'BOOK', 'KEYM', 'ALCH', 'INGR'], n),
  };
}

const ai: AiProvider = { kind: 'openai', url, model };
const docs = [...new Set(EXPECTED.map((e) => e.doc))].filter((d) => !only || only.some((o) => d.includes(o)));
const total: BeatScore = { people: [0, 0], places: [0, 0], items: [0, 0], beats: [0, 0], extra: 0, order: [0, 0], endings: [0, 0], links: [0, 0], missing: [] };
const saved: Record<string, BeatSheet> = {};
const t0 = Date.now();
for (const doc of docs) {
  const text = readFileSync(join(import.meta.dirname, doc.startsWith('questline') ? doc : `beats/${doc}`), 'utf8');
  const line = splitQuestline(text);
  const parts = line ? line.parts.map((p, i) => ({ title: p.title, text: p.text, i })) : [{ title: /^#\s*(.+)$/m.exec(text)?.[1] ?? doc, text, i: 0 }];
  const earlier: BeatSheet[] = [];
  for (const part of parts) {
    const want = EXPECTED.find((e) => e.doc === doc && (e.part ?? 0) === part.i);
    const t = Date.now();
    const steps: string[] = [];
    const reader = new BeatReader(new QuestPlanner({ ai }));
    const editorId = part.title.replace(/^(quest|part)\s+\w+\s*[:.–-]\s*/i, '').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
    let result;
    try {
      result = await reader.read(part.text, { title: part.title, editorId, shared: line?.shared, earlier, lookup, onStep: (s) => steps.push(s) });
    } catch (e) {
      console.log(JSON.stringify({ doc, part: part.i, error: (e as Error).message.slice(0, 300) }));
      continue;
    }
    const { sheet, questions, blocks } = result;
    earlier.push(sheet);
    saved[`${doc}#${part.i}`] = sheet;
    const plan = compileBeats(sheet, blocks);
    const errors = validatePlan(plan).filter((i) => i.severity === 'error').map((i) => i.message);
    const out: Record<string, unknown> = { doc, part: part.i, title: part.title, minutes: Math.round((Date.now() - t) / 6000) / 10, asked: steps.length, questionsLeft: questions.map((q) => q.message), planErrors: errors };
    if (want) {
      const s = scoreBeats(sheet, want, part.text);
      for (const k of ['people', 'places', 'items', 'beats', 'order', 'endings', 'links'] as const) (total[k][0] += s[k][0]), (total[k][1] += s[k][1]);
      total.extra += s.extra;
      Object.assign(out, { score: Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'missing').map(([k, v]) => [k, Array.isArray(v) ? `${v[0]}/${v[1]}` : v])), missing: s.missing });
    }
    console.log(JSON.stringify(out));
  }
}
const save = flag('--save');
if (save) writeFileSync(save, JSON.stringify(saved, null, 1));
console.log(JSON.stringify({ total: Object.fromEntries(Object.entries(total).filter(([k]) => k !== 'missing').map(([k, v]) => [k, Array.isArray(v) ? `${v[0]}/${v[1]}` : v])), minutes: Math.round((Date.now() - t0) / 6000) / 10 }));
process.exit(0);
