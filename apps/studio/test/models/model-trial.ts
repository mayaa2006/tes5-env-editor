/**
 * Tries a model behind an OpenAI-style server (llama.cpp's llama-server, LM
 * Studio, a free online service…) on the AI tab's real work, against a real
 * Skyrim Data folder: each task runs in a fresh conversation with every
 * tool, and is checked by looking at the records afterwards, not at what the
 * model says.
 *
 *   SKYRIM_DATA=<Data folder> npx tsx apps/studio/test/models/model-trial.ts <base url> <model> [--only id,id] [--plan] [--key KEY] [--done results.jsonl]
 *
 * Prints one JSON line per task. Nothing is saved: the plugin stays in memory.
 */
import { existsSync, readFileSync } from 'node:fs';
import { NodeFileSystem, NodeProcessRunner } from '@tes5/workspace/node';
import type { AiProvider } from '@tes5/workspace';
import type { FormKey } from '@tes5/esp';
import { EngineHost } from '../../src/engine/host';
import { aiTools } from '../../src/engine/aitools';

const args = process.argv.slice(2);
const [url, model] = args;
const DATA = process.env.SKYRIM_DATA;
if (!url || !model || !DATA) throw new Error('usage: SKYRIM_DATA=<Data folder> model-trial.ts <base url> <model> [--only ids] [--plan] [--key KEY]');
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = flag('--only')?.split(',');
/** With --done FILE: tasks already in that results file for this model are skipped, so a cut-off run carries on. */
const doneFile = flag('--done');
const done = new Set<string>(
  doneFile && existsSync(doneFile)
    ? readFileSync(doneFile, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .map((l) => JSON.parse(l) as { model: string; task: string })
        .filter((r) => r.model === model)
        .map((r) => r.task)
    : [],
);
const ai: AiProvider = { kind: 'openai', url, model, ...(flag('--key') ? { apiKey: flag('--key') } : {}) };
const ESMS = ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm'];

let base: EngineHost | undefined;
/** The game data, loaded once; each task starts from a new empty plugin (the previous one's changes are undone). */
async function game() {
  if (!base) {
    base = new EngineHost(new NodeFileSystem(), new NodeProcessRunner());
    await base.open({ kind: 'folder', path: DATA!, loadOrder: ESMS.map((name) => ({ name, active: true })), outputDir: `${process.env.TMPDIR ?? '/tmp'}/model-trial-out` });
    await base.loadPlugins(ESMS);
  }
  while (base.session().canUndo) base.undo();
  base.createPlugin(`Trial${Date.now()}.esp`, {});
  return base;
}

const key = (h: EngineHost, edid: string) => h.ws!.byEditorId(edid) as FormKey | undefined;
const mine = (h: EngineHost, k: FormKey) => !!h.ws!.summary(k)?.inActive;
const MARE = 'WhiterunBanneredMare';
const mareRefs = (h: EngineHost) => h.references(key(h, MARE)!);
/** A wilderness cell just west of Whiterun. */
const HILL_CELL = '0095FE:Skyrim.esm' as FormKey;
const middleHeight = (h: EngineHost) => h.terrain(HILL_CELL)!.heights[16 * 33 + 16]!;

/** Quest tools run directly, to set up a quest for a task. */
async function tool(h: EngineHost, name: string, input: unknown) {
  const t = aiTools(h, { ai, plans: new Map(), touched: new Set() } as never).find((x) => x.name === name)!;
  return h.ws!.transactionAsync(`Setup: ${name}`, async () => t.run(t.input.parse(input)));
}
async function rumourQuest(h: EngineHost) {
  await tool(h, 'create_quest', { editorId: 'TrialRumors', name: 'Tavern Rumors' });
  await tool(h, 'set_stage', { quest: 'TrialRumors', stage: 0, startsQuest: true });
  await tool(h, 'set_stage', { quest: 'TrialRumors', stage: 10, journal: 'Hulda told me a rumor about a cave near Whiterun.' });
  await tool(h, 'connect_stages', { quest: 'TrialRumors', from: 0, to: 10, kind: 'talk', target: 'Hulda', playerSays: 'Heard any rumors?', answer: 'They say there is treasure in a cave near the river.' });
}
const linesOf = (h: EngineHost) => h.quest(key(h, 'TrialRumors')!).topics.flatMap((t) => t.infos.flatMap((i) => i.responses.map((r) => r.text)));

interface Task {
  id: string;
  text: string;
  before?: (h: EngineHost) => Promise<unknown> | unknown;
  check: (h: EngineHost, answer: string, before: any) => Promise<boolean> | boolean;
}

const TASKS: Task[] = [
  {
    id: 'read',
    text: 'Who works at the Bannered Mare in Whiterun? Give the Editor ID of its interior cell too.',
    check: (_h, a) => /Hulda/i.test(a) && /WhiterunBanneredMare/i.test(a),
  },
  {
    id: 'add-stage',
    text: 'Add stage 20 to my quest TrialRumors with the journal entry: "I found the cave Hulda told me about."',
    before: rumourQuest,
    check: (h) => !!h.quest(key(h, 'TrialRumors')!).stages.find((s) => s.index === 20)?.logEntries.some((l) => /cave/i.test(l.text)),
  },
  {
    id: 'new-item',
    text: 'Make a new war axe called "Brynja\'s Cleaver" with the Editor ID TrialCleaver: copy the Iron War Axe and give it 12 damage.',
    check: (h) => {
      const k = key(h, 'TrialCleaver');
      const d = k ? (h.ws!.view(k)?.data as any) : undefined;
      return !!k && mine(h, k) && h.ws!.view(k)!.sig === 'WEAP' && d.name === "Brynja's Cleaver" && d.data?.damage === 12;
    },
  },
  {
    id: 'place',
    text: 'Put two bottles of mead on a table in the Bannered Mare (WhiterunBanneredMare).',
    check: (h) => mareRefs(h).filter((r) => mine(h, r.formKey) && r.base && /mead/i.test(h.ws!.summary(r.base)?.name ?? '')).length >= 2,
  },
  {
    id: 'trigger',
    text: 'In the Bannered Mare, when the player opens Hulda\'s merchant chest (MerchantWhiterunBannerdMareChest), show the message "It smells of old cheese."',
    check: async (h) => {
      for (const r of mareRefs(h)) {
        if (r.baseSig !== 'CONT') continue;
        const t = await h.triggersOf({ kind: 'ref', ref: r.formKey });
        if (t.specs.some((s) => s.actions.some((a) => (a.kind === 'notification' || a.kind === 'messageBox') && /cheese/i.test(a.text)))) return true;
      }
      return false;
    },
  },
  {
    id: 'dialogue',
    text: "In my quest TrialRumors, make Hulda's lines sound grumpier. Change the existing lines; don't add new ones.",
    before: async (h) => {
      await rumourQuest(h);
      return linesOf(h);
    },
    check: (h, _a, before: string[]) => {
      const after = linesOf(h);
      return after.length === before.length && after.some((t, n) => t !== before[n]);
    },
  },
  {
    id: 'new-quest',
    text: 'Make a quest called "Rats in the Cellar" with the Editor ID TrialRats. It starts with the game. Stage 10 has the journal entry "Hulda asked me to clear the rats from the Bannered Mare\'s cellar." Stage 100 has "I cleared the rats from the cellar." and completes the quest. Add the objective "Clear the rats" shown at stage 10 and completed at stage 100.',
    check: (h) => {
      const k = key(h, 'TrialRats');
      if (!k || h.ws!.view(k)?.sig !== 'QUST') return false;
      const q = h.quest(k);
      const st = (n: number) => q.stages.find((s) => s.index === n);
      return !!st(10)?.logEntries.some((l) => /rats/i.test(l.text)) && !!st(100)?.logEntries.some((l) => /rats/i.test(l.text)) && q.objectives.some((o) => /rats/i.test(o.text));
    },
  },
  {
    id: 'character',
    text: 'Make a new character: Ingrid, a Redguard woman who is a blacksmith. She stands in the Bannered Mare (WhiterunBanneredMare).',
    check: (h) => mareRefs(h).some((r) => mine(h, r.formKey) && r.baseSig === 'NPC_' && /ingrid/i.test(h.ws!.summary(r.base!)?.name ?? '')),
  },
  {
    id: 'hill',
    text: `In the outdoor cell ${HILL_CELL} (just west of Whiterun), raise a hill about 5 metres high in the middle of the cell.`,
    before: (h) => middleHeight(h),
    check: (h, _a, before: number) => middleHeight(h) - before >= 150,
  },
];

for (const task of TASKS) {
  if ((only && !only.includes(task.id)) || done.has(task.id)) continue;
  const host = await game();
  const before = await task.before?.(host);
  const s = await host.aiNewSession();
  const t0 = Date.now();
  let r;
  let error: string | null = null;
  try {
    r = await host.aiSend(s.id, task.text, ai, {});
    error = r.error ?? null;
  } catch (e) {
    error = (e as Error).message;
  }
  const session = r?.session;
  const results = (session?.messages ?? []).filter((m: any) => m.role === 'tool').flatMap((m: any) => m.results) as { name: string; status: string; content: string }[];
  const inputs = (session?.messages ?? []).filter((m: any) => m.role === 'assistant').flatMap((m: any) => m.calls.map((c: any) => `${c.name} ${JSON.stringify(c.input ?? {})}`.slice(0, 160)));
  const answer = ([...(session?.messages ?? [])].reverse().find((m: any) => m.role === 'assistant' && m.text) as { text?: string } | undefined)?.text ?? '';
  let ok = false;
  try {
    ok = await task.check(host, answer, before);
  } catch {
    ok = false;
  }
  const usage = session?.turns.at(-1)?.usage;
  console.log(
    JSON.stringify({
      model,
      task: task.id,
      ok,
      seconds: Math.round((Date.now() - t0) / 1000),
      calls: results.map((x) => `${x.name}${x.status === 'done' ? '' : `!${x.status}`}`),
      failed: results.filter((x) => x.status !== 'done').map((x) => `${x.name}: ${x.content.slice(0, 200)}`),
      inputs,
      error: error?.slice(0, 300) ?? null,
      tokens: usage ? { in: usage.input, out: usage.output } : undefined,
      answer: answer.slice(0, 300),
    }),
  );
}

if (args.includes('--plan') && !done.has('plan')) {
  const host = await game();
  const doc = `The Innkeeper's Ring

Hulda, who runs the Bannered Mare in Whiterun, has lost her mother's ring. If the player asks her for work, she tells them about it and asks them to look around the inn.

Mikael the bard is in the inn. If the player asks him about the ring, he admits he saw it fall behind the bar and laughs about it.

The ring is on one of the tables. When the player picks it up, they should take it back to Hulda. She is overjoyed, takes the ring and pays 100 gold.`;
  const t0 = Date.now();
  try {
    const r = await host.planQuest(doc, 'document', ai);
    const errors = r.issues.filter((i) => i.severity === 'error');
    console.log(
      JSON.stringify({
        model,
        task: 'plan',
        ok: errors.length === 0,
        seconds: Math.round((Date.now() - t0) / 1000),
        errors: errors.map((e) => e.message).slice(0, 6),
        warnings: r.issues.length - errors.length,
        stages: r.plan.stages.map((s) => s.index),
        characters: r.plan.characters.map((c) => `${c.name}${c.existing ? ` (${c.existing})` : ''}`),
        items: r.plan.items?.map((i: any) => i.name),
      }),
    );
  } catch (e) {
    console.log(JSON.stringify({ model, task: 'plan', ok: false, seconds: Math.round((Date.now() - t0) / 1000), error: (e as Error).message.slice(0, 300) }));
  }
}
process.exit(0);
