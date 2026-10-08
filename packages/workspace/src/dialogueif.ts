/**
 * The [if …] tag in screenplays: when a line can be said, in plain words.
 *
 *   [if stage 10]          the quest is at stage 10 (also >=, >, <, <=, !=)
 *   [if done 20]           stage 20 has been reached ([if not done 20]: it hasn't)
 *   [if has Ring x2]       the player carries the item ([if not has Ring])
 *   [if gold 100]          the player has at least 100 gold (also < 100 …)
 *   [if speech 50]         the player's Speech skill is at least 50
 *   [if level 10]          the player is at least level 10
 *   [if female] / [if male]
 *   [if race Nord]         the player's race
 *   [if quest MQ101 done]  another quest is completed
 *
 * Several [if …] tags on one line must all be true. Each becomes a normal
 * Creation Kit condition, so it shows (and can be edited) in the condition list.
 */
import { conditionFunctionByName, newCondition, type CompareOp, type Condition, type FormKey } from '@tes5/esp';
import { resolveItem } from './dialogue';
import type { Workspace } from './engine';

export type IfClause =
  | { kind: 'stage'; op: CompareOp; value: number }
  | { kind: 'done'; stage: number; not: boolean }
  | { kind: 'has'; item: string; count: number; not: boolean }
  | { kind: 'gold' | 'speech' | 'level'; op: CompareOp; value: number }
  | { kind: 'sex'; female: boolean }
  | { kind: 'race'; race: string }
  | { kind: 'questDone'; quest: string }
  | { kind: 'choice'; name: string; not: boolean };

/** Run on the player (in dialogue, "Target" is the player). */
const TARGET = 1;
const SPEECHCRAFT = 17;
const OPS: CompareOp[] = ['>=', '<=', '!=', '==', '>', '<'];

function opAndNumber(rest: string, defaultOp: CompareOp): { op: CompareOp; value: number } | undefined {
  const m = /^(>=|<=|!=|==|=|>|<)?\s*(-?\d+(?:\.\d+)?)$/.exec(rest.trim());
  if (!m) return undefined;
  const op = m[1] === '=' ? '==' : ((m[1] as CompareOp | undefined) ?? defaultOp);
  return OPS.includes(op) ? { op, value: Number(m[2]) } : undefined;
}

/** Parse one [if …] value (several are joined with ";"). Throws with a plain message on nonsense. */
export function parseIf(value: string | undefined): IfClause[] {
  if (value === undefined) return [];
  const out: IfClause[] = [];
  for (const part of value.split(';').map((x) => x.trim()).filter(Boolean)) {
    const l = part.toLowerCase();
    let m: RegExpExecArray | null;
    if ((m = /^stage\s+(.+)$/i.exec(part))) {
      const r = opAndNumber(m[1]!, '==');
      if (!r) throw new Error(`[if ${part}]: say a stage number, e.g. [if stage 10] or [if stage >= 10]`);
      out.push({ kind: 'stage', ...r });
    } else if (/^\d+$/.test(l)) out.push({ kind: 'stage', op: '==', value: Number(l) });
    else if ((m = /^(not\s+)?(?:done|after|stage\s+done)\s+(\d+)$/i.exec(part))) out.push({ kind: 'done', stage: Number(m[2]), not: !!m[1] });
    else if ((m = /^(not\s+|no\s+)?has\s+(.+?)(?:\s*[x×]\s*(\d+))?$/i.exec(part))) out.push({ kind: 'has', item: m[2]!.trim(), count: m[3] ? Number(m[3]) : 1, not: !!m[1] });
    else if ((m = /^(gold|speech|level)\s+(.+)$/i.exec(part))) {
      const r = opAndNumber(m[2]!, '>=');
      if (!r) throw new Error(`[if ${part}]: say a number, e.g. [if ${m[1]!.toLowerCase()} 50]`);
      out.push({ kind: m[1]!.toLowerCase() as 'gold' | 'speech' | 'level', ...r });
    } else if (l === 'female' || l === 'male') out.push({ kind: 'sex', female: l === 'female' });
    else if ((m = /^race\s+(.+)$/i.exec(part))) out.push({ kind: 'race', race: m[1]!.trim() });
    else if ((m = /^quest\s+(\S+)\s+(?:done|completed|complete)$/i.exec(part))) out.push({ kind: 'questDone', quest: m[1]! });
    else if ((m = /^(not\s+)?(?:chose|remembered|remembers)\s+([A-Za-z][\w-]*)$/i.exec(part))) out.push({ kind: 'choice', name: m[2]!, not: !!m[1] });
    else throw new Error(`[if ${part}] isn't understood. Try: stage 10, done 20, has Ring, gold 100, speech 50, level 10, female, race Nord, quest MyQuest done, chose spared`);
  }
  return out;
}

/** The stage a line needs (GetStage == N), if any: what the quest map and the checks read. */
export function stageOf(clauses: IfClause[]): number | null {
  const s = clauses.find((c): c is Extract<IfClause, { kind: 'stage' }> => c.kind === 'stage' && c.op === '==');
  return s ? s.value : null;
}

function cond(name: string, init: Partial<Condition>): Condition {
  const fn = conditionFunctionByName(name);
  if (!fn) throw new Error(`Condition function ${name} is unknown`);
  return { ...newCondition(fn.index), ...init };
}

/**
 * The global that remembers a choice made in a quest ([remember spared] sets
 * it to 1, [forget spared] back to 0). Made on first use, named after the quest.
 */
export function choiceGlobal(ws: Workspace, quest: FormKey, name: string): FormKey {
  const qid = (ws.view(quest)?.editorId ?? 'Quest').replace(/[^A-Za-z0-9_]/g, '');
  const word = name.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
  if (!word) throw new Error(`“${name}” can't be used as a choice name; use letters and digits`);
  const editorId = `${qid}Chose${word}`;
  const found = ws.byEditorId(editorId);
  if (found) return found;
  return ws.createRecord('GLOB', { editorId, type: 115, value: 0 });
}

/** Choices a quest remembers: the globals made by choiceGlobal (name → global). */
export function questChoices(ws: Workspace, quest: FormKey): { name: string; global: FormKey }[] {
  const qid = (ws.view(quest)?.editorId ?? 'Quest').replace(/[^A-Za-z0-9_]/g, '');
  const prefix = `${qid}Chose`.toLowerCase();
  return ws
    .search({ sigs: ['GLOB'], query: `${qid}Chose`, limit: 500 })
    .items.filter((g) => !g.deleted && g.editorId?.toLowerCase().startsWith(prefix))
    .map((g) => ({ name: g.editorId!.slice(prefix.length).replace(/^./, (c) => c.toLowerCase()), global: g.formKey }));
}

/** Turn clauses into CK conditions (forms are looked up in the load order). */
export function clauseConditions(ws: Workspace, quest: FormKey, clauses: IfClause[]): Condition[] {
  const out: Condition[] = [];
  for (const c of clauses) {
    switch (c.kind) {
      case 'stage':
        out.push(cond('GetStage', { param1: quest, op: c.op, value: c.value }));
        break;
      case 'done':
        out.push(cond('GetStageDone', { param1: quest, param2: c.stage, op: '==', value: c.not ? 0 : 1 }));
        break;
      case 'has': {
        const item = resolveItem(ws, c.item);
        if (!item) throw new Error(`[if has ${c.item}]: no item called “${c.item}”`);
        out.push(cond('GetItemCount', { param1: item, op: c.not ? '<' : '>=', value: c.count, runOn: TARGET }));
        break;
      }
      case 'gold':
        out.push(cond('GetGold', { op: c.op, value: c.value, runOn: TARGET }));
        break;
      case 'speech':
        out.push(cond('GetActorValue', { param1: SPEECHCRAFT, op: c.op, value: c.value, runOn: TARGET }));
        break;
      case 'level':
        out.push(cond('GetLevel', { op: c.op, value: c.value, runOn: TARGET }));
        break;
      case 'sex':
        out.push(cond('GetIsSex', { param1: c.female ? 1 : 0, op: '==', value: 1, runOn: TARGET }));
        break;
      case 'race': {
        const l = c.race.toLowerCase();
        const race = ws.byEditorId(c.race) ?? ws.byEditorId(`${c.race}Race`) ?? ws.search({ sigs: ['RACE'], query: c.race, limit: 50 }).items.find((r) => r.name?.toLowerCase() === l || r.editorId?.toLowerCase() === l)?.formKey;
        if (!race || ws.summary(race)?.sig !== 'RACE') throw new Error(`[if race ${c.race}]: no race called “${c.race}”`);
        out.push(cond('GetIsRace', { param1: race, op: '==', value: 1, runOn: TARGET }));
        break;
      }
      case 'choice':
        out.push(cond('GetGlobalValue', { param1: choiceGlobal(ws, quest, c.name), op: '==', value: c.not ? 0 : 1 }));
        break;
      case 'questDone': {
        const q = ws.byEditorId(c.quest);
        if (!q || ws.summary(q)?.sig !== 'QUST') throw new Error(`[if quest ${c.quest} done]: no quest with that Editor ID`);
        out.push(cond('GetQuestCompleted', { param1: q, op: '==', value: 1 }));
        break;
      }
    }
  }
  return out;
}
