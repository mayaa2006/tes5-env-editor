/**
 * Plain-words rules for when a dialogue line can be said, and what it does to the quest.
 * Each "when" is one ordinary Creation Kit condition, so lines edited here still show
 * up (and can be refined) in the full condition list.
 */
import { conditionFunctionByName, newCondition, type Condition, type FormKey } from '@tes5/esp';

export type When =
  | { kind: 'always' }
  | { kind: 'at'; stage: number }
  | { kind: 'from'; stage: number }
  | { kind: 'before'; stage: number }
  | { kind: 'thisDone' }
  | { kind: 'otherDone'; quest: FormKey | null }
  /** Several stage/quest rules at once: left to the full condition list. */
  | { kind: 'custom' };

export type WhenKind = When['kind'];
export interface Item {
  data: Condition;
  stringParam1?: string;
  stringParam2?: string;
}

const fnIndex = (name: string) => conditionFunctionByName(name)!.index;

/** The rule a condition stands for, if it is one this picker understands. */
function whenOf(c: Condition, quest: FormKey): When | null {
  const value = Number(c.value);
  if (c.function === fnIndex('GetStage') && c.param1 === quest) {
    if (c.op === '==') return { kind: 'at', stage: value };
    if (c.op === '>=') return { kind: 'from', stage: value };
    if (c.op === '<') return { kind: 'before', stage: value };
  }
  if (c.function === fnIndex('GetStageDone') && c.param1 === quest && c.op === '==' && (value === 0 || value === 1)) {
    return value === 1 ? { kind: 'from', stage: Number(c.param2) } : { kind: 'before', stage: Number(c.param2) };
  }
  if (c.function === fnIndex('GetQuestCompleted') && c.op === '==' && value === 1 && typeof c.param1 === 'string') {
    return c.param1 === quest ? { kind: 'thisDone' } : { kind: 'otherDone', quest: c.param1 as FormKey };
  }
  return null;
}

/** The "when" of a line (from its conditions), and how many other conditions it has (not counting the speaker). */
export function readWhen(items: Item[], quest: FormKey): { when: When; others: number } {
  const found = items.map((it) => whenOf(it.data, quest)).filter((w): w is When => w !== null);
  // The speaker (GetIsID) is shown as "Said by", so it isn't an "other condition" worth mentioning.
  const speaker = fnIndex('GetIsID');
  const others = items.filter((it) => it.data.function !== speaker).length - found.length;
  if (found.length === 0) return { when: { kind: 'always' }, others };
  if (found.length > 1) return { when: { kind: 'custom' }, others };
  return { when: found[0]!, others };
}

function make(name: string, init: Partial<Condition>): Item {
  return { data: { ...newCondition(fnIndex(name)), ...init } };
}

/** The condition for a rule ('always' and 'custom' have none). */
export function whenCondition(when: When, quest: FormKey): Item | null {
  switch (when.kind) {
    case 'at':
      return make('GetStage', { param1: quest, op: '==', value: when.stage });
    case 'from':
      return make('GetStageDone', { param1: quest, param2: when.stage, op: '==', value: 1 });
    case 'before':
      return make('GetStage', { param1: quest, op: '<', value: when.stage });
    case 'thisDone':
      return make('GetQuestCompleted', { param1: quest, op: '==', value: 1 });
    case 'otherDone':
      return when.quest ? make('GetQuestCompleted', { param1: when.quest, op: '==', value: 1 }) : null;
    default:
      return null;
  }
}

/** The conditions after changing the rule: the old rule is replaced, every other condition stays. */
export function writeWhen(items: Item[], quest: FormKey, when: When): Item[] {
  if (when.kind === 'custom') return items;
  const kept = items.filter((it) => whenOf(it.data, quest) === null);
  const c = whenCondition(when, quest);
  return c ? [...kept, c] : kept;
}

// ------------------------------------------------------------------ "moves the quest to stage"

const SET_STAGE_LINE = /^\s*GetOwningQuest\(\)\.SetStage\(\s*(\d+)\s*\)\s*$/i;

/** The stage a response's end script moves the quest to (the line this editor writes), if any. */
export function readSetsStage(code: string): number | null {
  for (const line of code.split('\n')) {
    const m = SET_STAGE_LINE.exec(line);
    if (m) return Number(m[1]);
  }
  return null;
}

/** The end script after choosing a stage (null = none): that one line changes, everything else stays. */
export function writeSetsStage(code: string, stage: number | null): string {
  const rest = code.split('\n').filter((l) => !SET_STAGE_LINE.test(l));
  const lines = stage === null ? rest : [`GetOwningQuest().SetStage(${stage})`, ...rest];
  return lines.join('\n').replace(/^\n+|\n+$/g, '');
}

/** "20 – Find the ring" for stage dropdowns and chips. */
export function stageLabel(index: number, text: string | undefined, max = 48): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t ? `${index} – ${t.length > max ? `${t.slice(0, max - 1)}…` : t}` : `${index}`;
}
