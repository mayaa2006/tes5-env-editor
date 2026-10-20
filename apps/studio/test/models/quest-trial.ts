/**
 * Whole quests made by the AI tab on Skyrim SE's own data, checked as the game would care: a new
 * conversation asks for a quest the way an author would, says "build it" if the AI only planned, and
 * then the quest that was built is examined.
 *
 *   SKYRIM_DATA=<Data folder> npx tsx apps/studio/test/models/quest-trial.ts <base url> <model> [--only id,id] [--minutes N] [--done results.jsonl] [--plans DIR]
 *   SKYRIM_DATA=<Data folder> npx tsx apps/studio/test/models/quest-trial.ts --rebuild DIR [--only id,id] [--as-planned]
 *
 * Checks: a quest was built; the quest map's problems (stages nothing reaches, nothing starting or
 * completing it…); dialogue errors; every script the build wrote, through the editor's Papyrus checker;
 * the release check's errors; and the plugin saved and read back, every record decoding exactly.
 * One JSON line per quest. With --plans, each plan is saved so --rebuild can build it again without the AI.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NodeFileSystem, NodeProcessRunner } from '@tes5/workspace/node';
import { normalizePlan, repairPlan, settleCharacters, validatePlan, type AiProvider, type QuestPlan } from '@tes5/workspace';
import { decodeRecord, parsePlugin, type FormKey } from '@tes5/esp';
import { EngineHost } from '../../src/engine/host';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const DATA = process.env.SKYRIM_DATA;
const rebuild = flag('--rebuild');
const [url, model] = rebuild ? [] : args;
if (!DATA || (!rebuild && (!url || !model))) throw new Error('usage: SKYRIM_DATA=<Data folder> quest-trial.ts <base url> <model> [--only ids] [--minutes N] [--done FILE] [--plans DIR]  |  --rebuild DIR');
const only = flag('--only')?.split(',');
const plansDir = flag('--plans') ?? rebuild;
const doneFile = flag('--done');
const done = new Set<string>(doneFile && existsSync(doneFile) ? readFileSync(doneFile, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as { model: string; quest: string }).filter((r) => r.model === model).map((r) => r.quest) : []);
const ai: AiProvider | undefined = url && model ? { kind: 'openai', url, model, ...(flag('--key') ? { apiKey: flag('--key') } : {}) } : undefined;
const ESMS = ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm'];

/** Quests as an author would ask for them, from simple to involved. */
const QUESTS: { id: string; text: string }[] = [
  {
    id: 'ring',
    text: "Hulda at the Bannered Mare in Whiterun has lost her mother's ring. Mikael the bard saw where it fell. The ring is on a table in the inn; the player brings it back to Hulda, who pays 100 gold.",
  },
  {
    id: 'wolves',
    text: 'A new farmer called Eirik lives outside Whiterun. Wolves keep killing his chickens. He asks the player to kill the three wolves near his farm, and when they are dead he gives the player a hunting bow.',
  },
  {
    id: 'delivery',
    text: "Adrianne Avenicci at Warmaiden's in Whiterun asks the player to take a steel sword to her father Proventus at Dragonsreach. Proventus thanks the player and pays 50 gold. If the player sells the sword or keeps it for three days, the quest fails.",
  },
  {
    id: 'bandits',
    text: "Faendal in Riverwood says bandits stole his family's amulet and are hiding in a small cave north of the village. The player clears the cave, kills the bandit leader, takes the amulet from his body and brings it back. Faendal can either pay 200 gold or teach archery, the player chooses.",
  },
];

let base: EngineHost | undefined;
const outputDir = join(process.env.TMPDIR ?? tmpdir(), `quest-trial-out-${process.pid}`);
/** The game data, loaded once; each quest starts from a new empty plugin (the previous one's changes are undone). */
async function game(id: string) {
  if (!base) {
    base = new EngineHost(new NodeFileSystem(), new NodeProcessRunner());
    await base.open({ kind: 'folder', path: DATA!, loadOrder: ESMS.map((name) => ({ name, active: true })), outputDir });
    await base.loadPlugins(ESMS);
  }
  while (base.session().canUndo) base.undo();
  base.createPlugin(`QuestTrial_${id}_${Date.now() % 1e6}.esp`, {});
  return base;
}

const questsIn = (h: EngineHost) => h.ws!.search({ sigs: ['QUST'], plugin: h.ws!.activeName, limit: 50 }).items.filter((q) => q.formKey.endsWith(`:${h.ws!.activeName}`));
const modScripts = (h: EngineHost) => new Set((h.scriptList() as { name: string; origin: string }[]).filter((s) => s.origin === 'mod').map((s) => s.name.toLowerCase()));

/** Everything worth knowing about what was built. */
async function inspect(h: EngineHost, scriptsBefore: Set<string>) {
  const ws = h.ws!;
  const quests = questsIn(h);
  const out: Record<string, unknown> = { quests: quests.map((q) => q.editorId) };
  const problems: string[] = [];
  const dialogueErrors: string[] = [];
  const shape: string[] = [];
  for (const q of quests) {
    const m = h.quest(q.formKey);
    shape.push(`${q.editorId}: ${m.stages.length} stages, ${m.objectives.length} objectives, ${m.aliases.length} aliases, ${m.topics.length} topics`);
    const g = await h.questGraph(q.formKey).catch((e) => ({ problems: [`questGraph failed: ${(e as Error).message}`] }));
    problems.push(...(g.problems ?? []).map((p: string) => `${q.editorId}: ${p}`));
    for (const l of await h.lintDialogue(q.formKey)) if (l.severity === 'error') dialogueErrors.push(`${q.editorId}: ${l.message}`);
  }
  out.shape = shape;
  out.questProblems = problems;
  out.dialogueErrors = dialogueErrors;
  // Records the build made, by type.
  const mine = ws.search({ plugin: ws.activeName, limit: 100000 }).items;
  const byType: Record<string, number> = {};
  for (const r of mine) byType[r.sig] = (byType[r.sig] ?? 0) + 1;
  out.records = byType;
  // Every script the build wrote, through the editor's checker.
  const scriptErrors: string[] = [];
  const written = [...modScripts(h)].filter((s) => !scriptsBefore.has(s));
  for (const name of written) {
    const src = await h.scriptRead(name).then((r) => (typeof r === 'string' ? r : (r as { source?: string }).source ?? '')).catch(() => '');
    const diags = (await h.scriptCheck(src)) as { severity: string; message: string; range?: { start?: { line?: number } } }[];
    for (const d of diags.filter((x) => x.severity === 'error')) scriptErrors.push(`${name}:${(d.range?.start?.line ?? 0) + 1}: ${d.message}`);
  }
  out.scripts = written.length;
  out.scriptErrors = scriptErrors;
  // The release check's errors (warnings like missing voice files are expected).
  const rel = h.releaseCheck() as unknown as { findings: { severity: string; category: string; message: string }[] };
  out.releaseErrors = (rel.findings ?? []).filter((f) => f.severity === 'error').map((f) => `${f.category}: ${f.message}`).slice(0, 20);
  out.releaseWarnings = (rel.findings ?? []).filter((f) => f.severity === 'warning').length;
  // Saved and read back: every record decodes exactly.
  try {
    await h.save({ generateFaces: false, compileScripts: false });
    const file = join(outputDir, ws.activeName!);
    const p = parsePlugin(new Uint8Array(readFileSync(file)), ws.activeName!);
    let total = 0;
    const inexact: string[] = [];
    for (const r of p.records()) {
      total++;
      const t = decodeRecord(r, { localized: p.isLocalized });
      if (!t.lossless) inexact.push(`${r.sig} ${r.editorId ?? r.formId.toString(16)}`);
    }
    out.saved = { records: total, inexact: inexact.slice(0, 10) };
  } catch (e) {
    out.saved = { error: (e as Error).message.slice(0, 300) };
  }
  out.ok = quests.length > 0 && !problems.length && !dialogueErrors.length && !scriptErrors.length && !(out.releaseErrors as string[]).length && !(out.saved as { error?: string; inexact?: string[] }).error && !(out.saved as { inexact?: string[] }).inexact?.length;
  return out;
}

if (rebuild) {
  // The saved plans, built again without the AI (to fix the builder against a known plan).
  for (const f of readdirSync(rebuild).filter((x) => x.endsWith('.json')).sort()) {
    const id = f.replace(/\.json$/, '');
    if (only && !only.some((o) => id.startsWith(o))) continue;
    const plan = JSON.parse(readFileSync(join(rebuild, f), 'utf8')) as QuestPlan;
    const h = await game(id);
    // --as-planned: what planning does to a free AI's answer now (for plans saved by an older version).
    const text = QUESTS.find((q) => id.startsWith(q.id))?.text;
    const mended = args.includes('--as-planned') && text ? [...repairPlan(normalizePlan(plan)), ...settleCharacters(h.ws!, plan, text, true)] : [];
    const issues = validatePlan(plan).map((x) => `${x.severity}: ${x.message}`);
    const before = modScripts(h);
    const t0 = Date.now();
    let built: Record<string, unknown> = {};
    try {
      const r = await h.buildQuestPlan(plan);
      built = { warnings: r.warnings, notes: r.notes.slice(0, 12), created: r.created.map((c) => c.label).slice(0, 25), changed: r.changed.map((c) => `${c.label}: ${c.changes.join(', ')}`) };
    } catch (e) {
      built = { error: (e as Error).message.slice(0, 400) };
    }
    console.log(JSON.stringify({ plan: id, seconds: Math.round((Date.now() - t0) / 1000), mended, issues, build: built, ...(await inspect(h, before)) }));
  }
  process.exit(0);
}

if (plansDir) mkdirSync(plansDir, { recursive: true });
for (const q of QUESTS) {
  if ((only && !only.includes(q.id)) || done.has(q.id)) continue;
  const h = await game(q.id);
  const before = modScripts(h);
  const s = await h.aiNewSession();
  const t0 = Date.now();
  const turns: { said: string; calls: string[]; failed: string[]; error: string | null; answer: string; seconds: number }[] = [];
  let timedOut = false;
  const limit = setTimeout(() => ((timedOut = true), h.aiStop(s.id)), Number(flag('--minutes') ?? 60) * 60_000);
  // As an author would: ask, then say to build it if the AI only planned (twice at most).
  const say = [`Make a quest: ${q.text}`, 'That plan looks good. Build it now.', 'Please build the quest from the plan now (build_plan).'];
  let session: any;
  for (const text of say) {
    if (timedOut || (turns.length && questsIn(h).length)) break;
    const t1 = Date.now();
    const at = session?.messages.length ?? 0;
    let error: string | null = null;
    try {
      const r = await h.aiSend(s.id, text, ai!, {});
      session = r.session;
      error = timedOut ? 'timed out' : (r.error ?? null);
    } catch (e) {
      error = timedOut ? 'timed out' : (e as Error).message;
    }
    const msgs = (session?.messages ?? []).slice(at);
    const results = msgs.filter((m: any) => m.role === 'tool').flatMap((m: any) => m.results) as { name: string; status: string; content: string }[];
    const answer = ([...msgs].reverse().find((m: any) => m.role === 'assistant' && m.text) as { text?: string } | undefined)?.text ?? '';
    turns.push({
      said: text.slice(0, 60),
      calls: results.map((x) => `${x.name}${x.status === 'done' ? '' : `!${x.status}`}`),
      failed: results.filter((x) => x.status !== 'done').map((x) => `${x.name}: ${x.content.slice(0, 300)}`),
      error: error?.slice(0, 300) ?? null,
      answer: answer.slice(0, 400),
      seconds: Math.round((Date.now() - t1) / 1000),
    });
    if (error) break;
  }
  clearTimeout(limit);
  // The plans the conversation made, to build again without the AI.
  const plans = Object.entries((session?.plans ?? {}) as Record<string, { plan: QuestPlan }>);
  if (plansDir) for (const [pid, p] of plans) writeFileSync(join(plansDir, `${q.id}-${model}-${pid}.json`), JSON.stringify(p.plan, null, 1));
  console.log(JSON.stringify({ model, quest: q.id, seconds: Math.round((Date.now() - t0) / 1000), plans: plans.length, turns, ...(await inspect(h, before)) }));
}
process.exit(0);
