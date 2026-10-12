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

// ------------------------------------------------------------------ quest-wide availability

/**
 * The quest's own dialogue conditions (the Creation Kit's "Dialogue Conditions"): they apply to
 * every line of the quest, on top of each line's own rules. Two plain-words settings are managed
 * here; any other condition on the quest is left as it is.
 */
export interface Availability {
  /** Dialogue is only available once this stage has been reached (null: from the moment the quest runs). */
  from: number | null;
  /** Dialogue stops being offered once the quest is completed. */
  stopAtDone: boolean;
}

function availabilityOf(c: Condition, quest: FormKey): Partial<Availability> | null {
  const value = Number(c.value);
  if (c.function === fnIndex('GetStageDone') && c.param1 === quest && c.op === '==' && value === 1) return { from: Number(c.param2) };
  if (c.function === fnIndex('GetQuestCompleted') && c.param1 === quest && c.op === '==' && value === 0) return { stopAtDone: true };
  return null;
}

/** The availability settings in the quest's dialogue conditions, and how many other conditions it has. */
export function readAvailability(items: Item[], quest: FormKey): { availability: Availability; others: number } {
  const availability: Availability = { from: null, stopAtDone: false };
  let others = 0;
  for (const it of items) {
    const a = availabilityOf(it.data, quest);
    if (!a) others++;
    else if (a.from !== undefined && availability.from === null) availability.from = a.from;
    else if (a.stopAtDone) availability.stopAtDone = true;
    else others++; // a second "from" rule: left alone, listed as an other condition
  }
  return { availability, others };
}

/** The quest's dialogue conditions after changing the settings: other conditions stay. */
export function writeAvailability(items: Item[], quest: FormKey, a: Availability): Item[] {
  let seenFrom = false;
  const kept = items.filter((it) => {
    const m = availabilityOf(it.data, quest);
    if (!m) return true;
    if (m.from !== undefined && seenFrom) return true; // not managed here (a second "from")
    if (m.from !== undefined) seenFrom = true;
    return false;
  });
  if (a.from !== null) kept.push(make('GetStageDone', { param1: quest, param2: a.from, op: '==', value: 1 }));
  if (a.stopAtDone) kept.push(make('GetQuestCompleted', { param1: quest, op: '==', value: 0 }));
  return kept;
}

/** Where a line sits next to a stage: for the stage cards. */
export interface StageLine {
  info: FormKey;
  relation: 'only' | 'from' | 'until' | 'sets';
}

export interface LineLinks {
  formKey: FormKey;
  needsStage: number | null;
  fromStage: number | null;
  beforeStage: number | null;
  setsStage: number | null;
}

/** For each stage, the responses tied to it (needing it, from it, until it, or moving the quest to it). */
export function linesByStage(infos: LineLinks[]): Map<number, StageLine[]> {
  const out = new Map<number, StageLine[]>();
  const add = (stage: number | null, info: FormKey, relation: StageLine['relation']) => {
    if (stage === null) return;
    out.set(stage, [...(out.get(stage) ?? []), { info, relation }]);
  };
  for (const i of infos) {
    add(i.needsStage, i.formKey, 'only');
    if (i.needsStage === null) add(i.fromStage, i.formKey, 'from');
    add(i.beforeStage, i.formKey, 'until');
    add(i.setsStage, i.formKey, 'sets');
  }
  return out;
}
