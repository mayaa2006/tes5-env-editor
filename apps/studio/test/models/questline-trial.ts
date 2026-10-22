/**
 * A whole questline, already written, made by the AI on Skyrim SE's own data: the document is planned quest by quest
 * (Quests → From writing does the same), the plans are built together, and every quest is examined as the game would
 * care, plus what joins them: each later quest started by the one before, characters made once and reused, and the
 * author's dialogue kept word for word.
 *
 *   SKYRIM_DATA=<Data folder> npx tsx apps/studio/test/models/questline-trial.ts <base url> <model> [--doc FILE] [--save plan.json] [--log-ai requests.jsonl]
 *   SKYRIM_DATA=<Data folder> npx tsx apps/studio/test/models/questline-trial.ts --rebuild plan.json
 *   … <base url> <model> --replay requests.jsonl   (answers recorded by --log-ai first, the live model for the rest)
 *
 * Checks per quest: the quest map's problems, dialogue errors, every script the build wrote (the editor's Papyrus
 * checker), the release check's errors, and the plugin saved and read back with every record decoding exactly.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NodeFileSystem, NodeProcessRunner } from '@tes5/workspace/node';
import { findDialogue, splitQuestline, type AiProvider, type QuestlinePlan } from '@tes5/workspace';
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
if (!DATA || (!rebuild && (!url || !model))) throw new Error('usage: SKYRIM_DATA=<Data folder> questline-trial.ts <base url> <model> [--doc FILE] [--save plan.json]  |  --rebuild plan.json');
const docPath = flag('--doc') ?? join(import.meta.dirname, 'questline-cartographer.md');
const doc = readFileSync(docPath, 'utf8');
const ESMS = ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm'];
// --log-ai FILE: every request to the AI and its answer, one JSON line each (to see what the model wrote).
const aiLog = flag('--log-ai');
if (aiLog) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const t = Date.now();
    const res = await real(input, init);
    const copy = res.clone();
    void copy.text().then((answer) => appendFileSync(aiLog, `${JSON.stringify({ seconds: Math.round((Date.now() - t) / 1000), request: init?.body ? JSON.parse(String(init.body)) : null, answer })}\n`)).catch(() => undefined);
    return res;
  }) as typeof fetch;
}
// --replay FILE: answer from an earlier --log-ai recording where it has the same request (the plan of the same quest,
// the tags for the same character's lines), and ask the live model otherwise: a trial picks up where it stopped, and
// the editor's own handling of the model's answers can be tried again without waiting for them.
const replay = flag('--replay');
if (replay) {
  const recorded = readFileSync(replay, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { request: { messages: { role: string; content: unknown }[] } | null; answer: string });
  const text = (c: unknown) => (typeof c === 'string' ? c : JSON.stringify(c ?? ''));
  const signature = (req: { messages: { role: string; content: unknown }[] } | null) => {
    if (!req) return '';
    const system = text(req.messages[0]?.content);
    const user = req.messages.filter((m) => m.role === 'user').map((m) => text(m.content)).join('\n');
    const quest = /This is quest (\d+) of/.exec(user)?.[1] ?? '1';
    if (/into a quest plan/.test(system)) return `plan ${quest} ${req.messages.length}`;
    if (/You add tags to dialogue/.test(system)) {
      const speakers = [...new Set([...user.matchAll(/^\s*\d+\s+([A-Z][A-Z' .-]+):/gm)].map((m) => m[1]!.trim()).filter((x) => x !== 'PLAYER'))].sort();
      return `tags ${quest} ${speakers.join(',')} ${/Nothing moves the quest to/.test(user) ? 'stuck' : ''}`;
    }
    return `other ${system.slice(0, 40)} ${quest}`;
  };
  const used = new Set<number>();
  const live = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = init?.body ? JSON.parse(String(init.body)) : null;
    const key = signature(req);
    const i = recorded.findIndex((r, n) => !used.has(n) && signature(r.request) === key);
    if (i < 0 || !key) return live(input, init);
    used.add(i);
    console.log(JSON.stringify({ replayed: key }));
    const streamed = /^(data:|:)/m.test(recorded[i]!.answer);
    return new Response(recorded[i]!.answer, { status: 200, headers: { 'content-type': streamed ? 'text/event-stream' : 'application/json' } });
  }) as typeof fetch;
}
const outputDir = join(process.env.TMPDIR ?? tmpdir(), `questline-trial-out-${process.pid}`);

const h = new EngineHost(new NodeFileSystem(), new NodeProcessRunner());
await h.open({ kind: 'folder', path: DATA, loadOrder: ESMS.map((name) => ({ name, active: true })), outputDir });
await h.loadPlugins(ESMS);
h.createPlugin(`QuestlineTrial_${Date.now() % 1e6}.esp`, {});
const ws = h.ws!;
const modScripts = () => new Set((h.scriptList() as { name: string; origin: string }[]).filter((s) => s.origin === 'mod').map((s) => s.name.toLowerCase()));
const scriptsBefore = modScripts();
const log = (o: unknown) => console.log(JSON.stringify(o));

let line: QuestlinePlan;
const t0 = Date.now();
if (rebuild) line = JSON.parse(readFileSync(rebuild, 'utf8')).line ?? JSON.parse(readFileSync(rebuild, 'utf8'));
else {
  const ai: AiProvider = { kind: 'openai', url: url!, model: model! };
  h.onEvent((e) => e.type === 'planProgress' && log({ progress: e.message, minutes: Math.round((Date.now() - t0) / 6000) / 10 }));
  const r = await h.planQuestline(doc, ai);
  line = r.line;
  const save = flag('--save');
  if (save) writeFileSync(save, JSON.stringify({ line }, null, 1));
  log({ planned: line.quests.map((q) => q.plan.title), minutes: Math.round((Date.now() - t0) / 6000) / 10, links: r.links.length, questlineIssues: r.questlineIssues.map((x) => x.message) });
  r.reviews.forEach((rv, i) => log({ quest: i + 1, issues: rv.issues.map((x) => `${x.severity}: ${x.message}`), unresolved: rv.resolution.filter((x) => x.error).map((x) => x.error) }));
}

let built;
try {
  built = await h.buildQuestline(line);
  log({ built: built.quests.map((q) => q.editorId), links: built.links });
} catch (e) {
  log({ buildError: (e as Error).message.slice(0, 2000) });
  process.exit(1);
}

// The author's lines, quest by quest, and whether each is in that quest's dialogue word for word.
const split = splitQuestline(doc)!;
const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
const results: Record<string, unknown>[] = [];
for (const [i, report] of built.quests.entries()) {
  const quest = report.quest as FormKey;
  const out: Record<string, unknown> = { quest: i + 1, editorId: report.editorId, warnings: report.warnings, problems: report.problems };
  const m = h.quest(quest);
  out.shape = `${m.stages.length} stages, ${m.objectives.length} objectives, ${m.aliases.length} aliases, ${m.topics.length} topics`;
  const g = await h.questGraph(quest);
  out.questProblems = g.problems;
  out.starts = g.starts.map((s) => s.label);
  out.dialogueErrors = (await h.lintDialogue(quest)).filter((l) => l.severity === 'error').map((l) => l.message);
  const said = new Set(h.dialogue!.graph(quest).infos.flatMap((x) => x.lines).map(norm));
  const author = findDialogue(split.parts[i]!.text).blocks.flatMap((b) => b.lines).filter((l) => !l.player);
  const missing = author.filter((l) => !said.has(norm(l.text)));
  out.authorLines = `${author.length - missing.length} of ${author.length} kept word for word`;
  if (missing.length) out.missingAuthorLines = missing.map((l) => `${l.speaker}: ${l.text}`).slice(0, 12);
  results.push(out);
}
// Every script the build wrote, through the editor's checker.
const scriptErrors: string[] = [];
const written = [...modScripts()].filter((s) => !scriptsBefore.has(s));
for (const name of written) {
  const src = await h.scriptRead(name).then((r) => (typeof r === 'string' ? r : ((r as { source?: string }).source ?? ''))).catch(() => '');
  const diags = (await h.scriptCheck(src)) as { severity: string; message: string; range?: { start?: { line?: number } } }[];
  for (const d of diags.filter((x) => x.severity === 'error')) scriptErrors.push(`${name}:${(d.range?.start?.line ?? 0) + 1}: ${d.message}`);
}
const rel = h.releaseCheck() as unknown as { findings: { severity: string; category: string; message: string }[] };
const releaseErrors = (rel.findings ?? []).filter((f) => f.severity === 'error').map((f) => `${f.category}: ${f.message}`);
let saved: Record<string, unknown>;
try {
  await h.save({ generateFaces: false, compileScripts: false });
  const p = parsePlugin(new Uint8Array(readFileSync(join(outputDir, ws.activeName!))), ws.activeName!);
  let total = 0;
  const inexact: string[] = [];
  for (const r of p.records()) {
    total++;
    if (!decodeRecord(r, { localized: p.isLocalized }).lossless) inexact.push(`${r.sig} ${r.editorId ?? r.formId.toString(16)}`);
  }
  saved = { records: total, inexact: inexact.slice(0, 10) };
} catch (e) {
  saved = { error: (e as Error).message.slice(0, 300) };
}
for (const r of results) log(r);
const ok = results.every((r) => !(r.questProblems as string[]).length && !(r.dialogueErrors as string[]).length && !r.missingAuthorLines) && !scriptErrors.length && !releaseErrors.length && !saved.error && !(saved.inexact as string[] | undefined)?.length;
log({ ok, minutes: Math.round((Date.now() - t0) / 6000) / 10, scripts: written.length, scriptErrors: scriptErrors.slice(0, 20), releaseErrors: releaseErrors.slice(0, 20), saved });
process.exit(0);
