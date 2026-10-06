/**
 * AI routines: what characters do with their day, and what a quest makes
 * them do. Each activity becomes an AI package made from the game's own
 * package template of that kind (Sandbox, Sleep, Eat, Travel, Follow,
 * ForceGreet): the template's data inputs are copied and the place, target
 * or topic filled in, with a schedule (hours) and conditions (quest stages).
 *
 * Everyday routines go on the character; quest-bound ones (follow the
 * player, forcegreet, anything limited to some stages) go on the character's
 * quest alias, so they stop when the quest does.
 */
import { conditionFunctionByName, newCondition, type Condition, type FormKey } from '@tes5/esp';
import { WorkspaceError, type Workspace } from './engine';

export type RoutineActivity = 'sandbox' | 'sleep' | 'eat' | 'stay' | 'travel' | 'follow' | 'forcegreet';

/** Template Editor IDs tried for each activity (vanilla names first). */
export const ROUTINE_TEMPLATES: Record<RoutineActivity, string[]> = {
  sandbox: ['Sandbox'],
  stay: ['Sandbox'],
  sleep: ['Sleep'],
  eat: ['Eat'],
  travel: ['Travel'],
  follow: ['Follow', 'FollowPlayer'],
  forcegreet: ['ForceGreet'],
};

export const ROUTINE_LABELS: Record<RoutineActivity, string> = {
  sandbox: 'goes about their business',
  stay: 'stays put',
  sleep: 'sleeps',
  eat: 'eats',
  travel: 'travels',
  follow: 'follows the player',
  forcegreet: 'comes up to the player and speaks',
};

export interface PackageSpec {
  editorId: string;
  activity: RoutineActivity;
  /** Hours of the day (0–23); null = all day. "from 22 to 6" wraps past midnight. */
  hours: { from: number; to: number } | null;
  conditions: Condition[];
  /** Where: a cell, or near where the character was placed. */
  location: { kind: 'cell'; cell: FormKey } | { kind: 'ref'; ref: FormKey } | { kind: 'editor' };
  radius?: number;
  /** The topic a forcegreet opens with. */
  topic?: FormKey;
  ownerQuest?: FormKey;
}

const PLAYER_REF = 0x14;
const LOCATION_NEAR_REF = 0;
const LOCATION_IN_CELL = 1;
const LOCATION_NEAR_EDITOR = 3;
const TARGET_SPECIFIC_REF = 0;

/** The package template for an activity, if the load order has one. */
export function findTemplate(ws: Workspace, activity: RoutineActivity): FormKey | undefined {
  for (const name of ROUTINE_TEMPLATES[activity]) {
    const k = ws.byEditorId(name);
    if (k && ws.summary(k)?.sig === 'PACK') return k;
  }
  return undefined;
}

/** Create one package (one undo step). */
export function createPackage(ws: Workspace, spec: PackageSpec): FormKey {
  const template = findTemplate(ws, spec.activity);
  if (!template) throw new WorkspaceError(`No “${ROUTINE_TEMPLATES[spec.activity][0]}” package template in the load order, so “${ROUTINE_LABELS[spec.activity]}” can't be made`);
  const tv = ws.view(template)!.data as any;
  const values: any[] = structuredClone(tv.packageData?.values ?? []);
  const inputs: any[] = structuredClone(tv.packageData?.inputs?.length ? tv.packageData.inputs : (tv.treeInputs ?? []));
  const radius = spec.radius ?? (spec.activity === 'stay' ? 128 : 1024);
  let placed = { location: false, target: false, topic: false };
  for (const v of values) {
    const type = String(v.type ?? '').toLowerCase();
    if (!placed.location && type === 'location') {
      v.location =
        spec.location.kind === 'cell'
          ? { type: LOCATION_IN_CELL, value: spec.location.cell, radius: 0 }
          : spec.location.kind === 'ref'
            ? { type: LOCATION_NEAR_REF, value: spec.location.ref, radius }
            : { type: LOCATION_NEAR_EDITOR, value: 0, radius };
      placed.location = true;
    } else if (!placed.target && /ref|target/.test(type) && (spec.activity === 'follow' || spec.activity === 'forcegreet')) {
      // The player (0x14 is the player reference in every plugin).
      v.target = { type: TARGET_SPECIFIC_REF, value: `${PLAYER_REF.toString(16).toUpperCase().padStart(6, '0')}:${ws.loaded()[0]?.name ?? 'Skyrim.esm'}`, count: 0 };
      placed.target = true;
    } else if (!placed.topic && type === 'topic' && spec.topic) {
      v.topics = [{ type: 0, value: spec.topic }];
      placed.topic = true;
    }
  }
  const pkdt = tv.data ?? {};
  return ws.createRecord('PACK', {
    editorId: spec.editorId,
    data: { flags: pkdt.flags ?? 0, type: 18, interruptOverride: 0, speed: 0, unknown: new Uint8Array(1), interruptFlags: pkdt.interruptFlags ?? 0, unknown2: new Uint8Array(2) },
    schedule: scheduleFor(spec.hours),
    conditions: spec.conditions.map((data) => ({ data })),
    ...(spec.ownerQuest ? { ownerQuest: spec.ownerQuest } : {}),
    counter: { inputCount: values.length, template, version: 0 },
    packageData: { values, inputs },
    marker: new Uint8Array(0),
    onBegin: { marker: new Uint8Array(0), idle: null, topics: [] },
    onEnd: { marker: new Uint8Array(0), idle: null, topics: [] },
    onChange: { marker: new Uint8Array(0), idle: null, topics: [] },
  });
}

/** PSDT: any month/day; start hour and duration in minutes (all day = -1 / 0). */
export function scheduleFor(hours: { from: number; to: number } | null) {
  if (!hours) return { month: -1, dayOfWeek: -1, date: 0, hour: -1, minute: -1, unused: new Uint8Array(3), duration: 0 };
  const from = ((Math.round(hours.from) % 24) + 24) % 24;
  const to = ((Math.round(hours.to) % 24) + 24) % 24;
  const length = (to - from + 24) % 24 || 24;
  return { month: -1, dayOfWeek: -1, date: 0, hour: from, minute: 0, unused: new Uint8Array(3), duration: length * 60 };
}

/** Conditions limiting a package to some stages of a quest. */
export function stageConditions(quest: FormKey, from: number | null, until: number | null): Condition[] {
  const gs = conditionFunctionByName('GetStage')!.index;
  const out: Condition[] = [];
  if (from !== null) out.push({ ...newCondition(gs), param1: quest, op: '>=', value: from });
  if (until !== null) out.push({ ...newCondition(gs), param1: quest, op: '<', value: until });
  return out;
}

/** What a package does, in words (for the review screen and the Characters tab). */
export function describePackage(ws: Workspace, key: FormKey): string {
  const v = ws.view(key);
  if (!v || v.sig !== 'PACK') return key;
  const d = v.data as any;
  const template = d.counter?.template ? ws.summary(d.counter.template)?.editorId : undefined;
  const activity = (Object.keys(ROUTINE_TEMPLATES) as RoutineActivity[]).find((a) => ROUTINE_TEMPLATES[a].includes(template ?? ''));
  const loc = (d.packageData?.values ?? []).find((x: any) => x.location)?.location;
  const where = loc ? (loc.type === LOCATION_IN_CELL ? ` in ${ws.summary(loc.value)?.name ?? ws.summary(loc.value)?.editorId ?? 'a cell'}` : loc.type === LOCATION_NEAR_EDITOR ? ' near where they were placed' : ' near a marker') : '';
  const s = d.schedule;
  const when = s && s.hour >= 0 && s.duration > 0 ? ` ${String(s.hour).padStart(2, '0')}:00–${String((s.hour + s.duration / 60) % 24).padStart(2, '0')}:00` : '';
  const what = activity ? ROUTINE_LABELS[activity] : `${template ?? 'custom'} package`;
  return `${what}${where}${when}${(d.conditions ?? []).length ? ' (while the quest is at certain stages)' : ''}`;
}
