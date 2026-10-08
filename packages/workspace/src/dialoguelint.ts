/**
 * Dialogue linting: problems in a conversation that would show up in game —
 * lines nobody answers, choices that never appear, "goodbye" before choices,
 * lines still offered after the quest moved on, stages that don't exist,
 * mistyped tags, lines too long to read, placeholders left in.
 *
 * The same rules run on a quest's real dialogue (the Dialogue tab and the
 * Release check) and on a screenplay before it's imported or built (the
 * script editor and the quest-from-writing review).
 */
import type { FormKey } from '@tes5/esp';
import type { DialogueService } from './dialogue';
import { parseScreenplay, type ScriptPlayerLine } from './dialogue';
import { parseIf, stageOf } from './dialogueif';
import type { QuestService } from './quest';
import type { QuestGraphService } from './questgraph';

export interface DialogueLint {
  severity: 'error' | 'warning';
  message: string;
  /** Why it matters in game / how to fix it. */
  detail?: string;
  /** The response or player line it's about (real dialogue). */
  form?: FormKey;
  /** Screenplay line number (screenplays). */
  line?: number;
}

/** Player lines longer than this are cut off in the dialogue menu. */
export const PLAYER_LINE_MAX = 80;
/** Responses longer than this make a long, hard-to-read subtitle (and one long voice file). */
export const RESPONSE_LINE_MAX = 150;
const KNOWN_TAGS = new Set(['goodbye', 'stage', 'if', 'emotion', 'gives', 'takes', 'gesture', 'once', 'persuade', 'at', 'start', 'remember', 'forget']);
const PLACEHOLDER = /\b(TODO|TBD|FIXME|XXX|lorem ipsum)\b|\{\{|\}\}|<[A-Z ]+>/;

/** A conversation in a neutral shape, from records or from a screenplay. */
interface Topic {
  text: string;
  /** player lines, or lines NPCs say on their own (greetings, chatter, scenes). */
  kind: 'player' | 'greeting' | 'idle' | 'scene';
  topLevel: boolean;
  where: { form?: FormKey; line?: number };
  responses: Response[];
}
interface Response {
  lines: string[];
  speaker: string | null;
  hasConditions: boolean;
  goodbye: boolean;
  needsStage: number | null;
  setsStage: number[];
  choices: number[];
  where: { form?: FormKey; line?: number };
}

function lintModel(topics: Topic[], ctx: { stages?: number[] }): DialogueLint[] {
  const out: DialogueLint[] = [];
  const at = (w: Topic['where']) => ({ ...(w.form ? { form: w.form } : {}), ...(w.line ? { line: w.line } : {}) });
  const stages = ctx.stages ? new Set(ctx.stages) : undefined;
  const offered = new Set<number>();
  for (const t of topics) for (const r of t.responses) for (const c of r.choices) offered.add(c);
  const seen = new Map<string, number>();

  topics.forEach((t, ti) => {
    const said = `“${t.text}”`;
    if (t.kind !== 'player') {
      lintResponses(t, said, out, at, stages);
      return;
    }
    if (!t.responses.length) out.push({ severity: 'error', message: `Nobody answers ${said}`, detail: 'A player line with no response never appears in the dialogue menu.', ...at(t.where) });
    if (!t.topLevel && !offered.has(ti)) out.push({ severity: 'warning', message: `${said} is never offered`, detail: "It isn't a top-level line and no response leads to it, so the player can't choose it.", ...at(t.where) });
    if (t.text.length > PLAYER_LINE_MAX) out.push({ severity: 'warning', message: `${said} is too long for the dialogue menu (${t.text.length} characters)`, detail: `Player lines over about ${PLAYER_LINE_MAX} characters are cut off. Shorten it; the response can say the rest.`, ...at(t.where) });
    if (PLACEHOLDER.test(t.text)) out.push({ severity: 'warning', message: `${said} looks like a placeholder`, ...at(t.where) });
    if (t.topLevel) {
      const key = `${t.text.toLowerCase()}|${t.responses.map((r) => r.needsStage).join(',')}`;
      if (seen.has(key)) out.push({ severity: 'warning', message: `${said} is offered twice`, detail: 'Two top-level player lines with the same words show up side by side in the menu.', ...at(t.where) });
      seen.set(key, ti);
      // A top-level line that moves the quest on but isn't tied to a stage stays in the menu afterwards.
      const sets = t.responses.filter((r) => r.setsStage.length);
      if (sets.some((r) => r.needsStage === null)) {
        out.push({ severity: 'warning', message: `${said} can still be chosen after it moved the quest on`, detail: `Add [if stage N] (or a GetStage condition) so it's only offered at the right point; otherwise the player can repeat it.`, ...at(t.where) });
      }
    }
    lintResponses(t, said, out, at, stages);
  });
  return out;
}


function lintResponses(t: Topic, said: string, out: DialogueLint[], at: (w: Topic['where']) => Partial<DialogueLint>, stages: Set<number> | undefined): void {
  for (const r of t.responses) {
    const who = r.speaker ?? 'The response';
    const first = r.lines[0] ?? '';
    const what = first ? `“${first.length > 40 ? `${first.slice(0, 40)}…` : first}”` : `the answer to ${said}`;
    if (!r.lines.some((l) => l.trim())) out.push({ severity: 'error', message: `${who} has nothing to say in answer to ${said}`, ...at(r.where) });
    if (r.goodbye && r.choices.length) out.push({ severity: 'error', message: `${what} ends the conversation, so the choices after it never appear`, detail: 'Remove [goodbye] (the "Goodbye" flag) or the choices.', ...at(r.where) });
    if (r.speaker === null && !r.hasConditions) out.push({ severity: 'warning', message: `Anyone can say ${what}`, detail: 'The response has no speaker or conditions, so every character in the game can say it.', ...at(r.where) });
    for (const l of r.lines) {
      if (l.length > RESPONSE_LINE_MAX) out.push({ severity: 'warning', message: `${what} is long (${l.length} characters)`, detail: `Lines over about ${RESPONSE_LINE_MAX} characters make one long subtitle; split it into two lines by the same speaker.`, ...at(r.where) });
      if (PLACEHOLDER.test(l)) out.push({ severity: 'warning', message: `${what} looks like a placeholder`, ...at(r.where) });
    }
    if (stages && r.needsStage !== null && !stages.has(r.needsStage)) out.push({ severity: 'error', message: `${what} is only said at stage ${r.needsStage}, which doesn't exist`, detail: 'It will never be said.', ...at(r.where) });
    for (const s of r.setsStage) {
      if (stages && !stages.has(s)) out.push({ severity: 'error', message: `${what} sets stage ${s}, which doesn't exist`, ...at(r.where) });
      if (r.needsStage !== null && s < r.needsStage) out.push({ severity: 'warning', message: `${what} moves the quest back from stage ${r.needsStage} to ${s}`, detail: 'Quests normally only move forward; check the stage number.', ...at(r.where) });
    }
  }
}

/** Lint a screenplay before it's imported (stages: the quest's stages, if known). */
export function lintScreenplay(source: string, ctx: { stages?: number[]; speakers?: string[] } = {}): DialogueLint[] {
  const parsed = parseScreenplay(source);
  const out: DialogueLint[] = parsed.errors.map((e) => ({ severity: 'error' as const, message: e.message, line: e.line }));
  // Tags the importer doesn't know are silently dropped, so a typo loses the stage change.
  source.split(/\r?\n/).forEach((raw, i) => {
    for (const m of raw.matchAll(/\[([a-z]+)(?:\s+[^\]]*)?\]/gi)) {
      if (!KNOWN_TAGS.has(m[1]!.toLowerCase())) out.push({ severity: 'error', message: `Unknown tag ${m[0]}`, detail: 'Tags: [stage N], [if …], [goodbye], [once], [persuade N], [emotion …], [gives …], [takes …], [gesture …], [remember NAME], [forget NAME]; on a SCENE: line, [at stage N] or [start].', line: i + 1 });
    }
    if (/\[[^\]]*$/.test(raw)) out.push({ severity: 'error', message: 'A tag is missing its closing ]', line: i + 1 });
  });
  if (ctx.speakers) {
    const known = new Set(ctx.speakers.map((s) => s.toLowerCase()));
    for (const s of parsed.speakers) if (!known.has(s.toLowerCase()) && !['npc', 'any', 'anyone', '?'].includes(s.toLowerCase())) out.push({ severity: 'error', message: `Nobody called ${s} is in the quest`, detail: "Use a character's key, name or Editor ID." });
  }
  const topics: Topic[] = [];
  const stage = (v: string | undefined) => (v === undefined ? null : Number.isInteger(Number(v)) ? Number(v) : null);
  const ifStage = (v: string | undefined, line: number): number | null => {
    try {
      return stageOf(parseIf(v));
    } catch (e) {
      out.push({ severity: 'error', message: (e as Error).message, line });
      return null;
    }
  };
  const add = (p: ScriptPlayerLine, topLevel: boolean, inherited: number | null): number => {
    const idx = topics.length;
    const t: Topic = { text: p.text, kind: 'player', topLevel, where: { line: p.line }, responses: [] };
    topics.push(t);
    const own = ifStage(p.tags.if, p.line) ?? inherited;
    for (const r of p.responses) {
      const need = ifStage(r.tags.if, r.line) ?? own;
      const set = stage(r.tags.stage ?? p.tags.stage);
      const resp: Response = { lines: r.lines, speaker: r.speaker, hasConditions: false, goodbye: 'goodbye' in r.tags, needsStage: need, setsStage: set === null ? [] : [set], choices: [], where: { line: r.line } };
      t.responses.push(resp);
      for (const c of r.choices) resp.choices.push(add(c, false, need));
    }
    return idx;
  };
  for (const p of parsed.topics) add(p, true, null);
  for (const b of parsed.blocks) {
    const outer = ifStage(b.tags.if, b.line);
    const name = b.kind === 'scene' ? `Scene “${b.title || 'untitled'}”` : b.kind === 'greeting' ? 'Greeting' : 'Chatter';
    if (b.kind === 'scene' && b.tags.at === undefined && !('start' in b.tags)) out.push({ severity: 'warning', message: `${name} never starts`, detail: 'Add [at stage N] to start it when the quest reaches a stage, or [start] to play it when the quest starts.', line: b.line });
    if (b.kind === 'scene' && new Set(b.lines.map((l) => l.speaker.toLowerCase())).size < 2) out.push({ severity: 'warning', message: `${name} has only one speaker`, detail: 'A one-person scene is fine for a speech; for a conversation, give the other character lines too.', line: b.line });
    topics.push({
      text: name,
      kind: b.kind,
      topLevel: false,
      where: { line: b.line },
      responses: b.lines.map((r) => {
        const need = ifStage(r.tags.if, r.line) ?? outer;
        const set = stage(r.tags.stage);
        return { lines: r.lines, speaker: ['npc', 'any', 'anyone', '?'].includes(r.speaker.toLowerCase()) ? null : r.speaker, hasConditions: !!(r.tags.if || b.tags.if), goodbye: 'goodbye' in r.tags, needsStage: need, setsStage: set === null ? [] : [set], choices: [], where: { line: r.line } };
      }),
    });
  }
  return [...out, ...lintModel(topics, ctx)];
}

/** Lint a quest's dialogue as it is in the plugin. */
export async function lintQuestDialogue(quest: FormKey, services: { quests: QuestService; dialogue: DialogueService; graphs: QuestGraphService }): Promise<DialogueLint[]> {
  const g = services.dialogue.graph(quest);
  const qm = services.quests.quest(quest);
  const qg = await services.graphs.graph(quest);
  const sets = new Map<FormKey, number[]>();
  for (const e of qg.edges) if (e.source.type === 'info') sets.set(e.source.info, [...(sets.get(e.source.info) ?? []), e.to]);
  const index = new Map(g.topics.map((t, i) => [t.formKey, i]));
  const name = (k: FormKey | null) => (k ? (services.quests.ws.summary(k)?.name ?? services.quests.ws.summary(k)?.editorId ?? k) : null);
  const topics: Topic[] = g.topics.map((t) => ({
    text: t.kind === 'player' ? t.text : t.kind === 'greeting' ? 'Greeting' : t.kind === 'idle' ? 'Chatter' : `Scene line ${t.editorId ?? ''}`,
    kind: t.kind,
    topLevel: t.topLevel,
    where: { form: t.formKey },
    responses: g.infos
      .filter((i) => i.topic === t.formKey)
      .map((i) => ({
        lines: i.lines,
        speaker: name(i.speaker),
        hasConditions: i.conditionCount > 0,
        goodbye: i.goodbye,
        needsStage: i.needsStage,
        setsStage: sets.get(i.formKey) ?? [],
        choices: i.choices.map((c) => index.get(c)).filter((x): x is number => x !== undefined),
        where: { form: i.formKey },
      })),
  }));
  return lintModel(topics, { stages: qm.stages.map((s) => s.index) });
}
