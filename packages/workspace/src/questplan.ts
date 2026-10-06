/**
 * A quest plan: everything needed to build a quest, in plain terms (who,
 * where, what, which stages, what moves the quest on, what's said, rewards).
 *
 * Plans come from the AI planner (a design document or a conversation turned
 * into this shape), from a hand edit in the review screen, or from code.
 * The builder (questbuilder.ts) turns a plan into records. The schema is
 * also the structured-output format the planner asks Claude for, so every
 * field is required (null when it doesn't apply) and nothing is recursive.
 */
import { z } from 'zod';

/** Short identifiers the plan uses to refer to its own characters, places and items. */
const Key = z.string().describe('Short identifier used to refer to this entry elsewhere in the plan, e.g. "brynja" or "cellar"');

export const PlanCharacterSchema = z.object({
  key: Key,
  name: z.string().describe('Name shown in game'),
  existing: z.string().nullable().describe('Editor ID or name of an existing character from the load order to use instead of creating one; null to create a new character'),
  sex: z.enum(['male', 'female']).nullable(),
  race: z.string().nullable().describe('Race name or Editor ID from the load order, e.g. "Nord"'),
  role: z.string().describe('What they do in the story, e.g. "innkeeper who gives the quest"'),
  appearance: z.string().describe('Short appearance notes, e.g. "middle-aged, grey braids, scar on cheek"'),
  voice: z.string().nullable().describe('Voice type Editor ID or description, e.g. "FemaleCommoner"'),
  locationKey: z.string().nullable().describe('Key of the location where they stand; null if they already exist in the world'),
  essential: z.boolean().describe('Can\'t be killed while the quest needs them'),
});

export const PlanLocationSchema = z.object({
  key: Key,
  name: z.string(),
  existing: z.string().nullable().describe('Editor ID or name of an existing cell; null to create a new interior'),
  description: z.string(),
});

export const PlanItemSchema = z.object({
  key: Key,
  name: z.string(),
  kind: z.enum(['misc', 'book', 'key', 'gold', 'other']),
  existing: z.string().nullable().describe('Editor ID or name of an existing item to use; null to create a new one'),
  value: z.number().nullable(),
  startsWith: z.enum(['location', 'character', 'player', 'nowhere']).describe('Where the item is when the quest begins'),
  startsAtKey: z.string().nullable().describe('Location or character key for startsWith location/character'),
});

export const PlanStageSchema = z.object({
  index: z.number().int().describe('Stage number: 0 or 10 to start, then steps of 10; the final stage is usually 100 or 200'),
  journal: z.string().describe('Journal text shown when this stage is reached, written in first person past tense; empty for silent stages'),
  startsQuest: z.boolean(),
  completesQuest: z.boolean(),
  failsQuest: z.boolean(),
});

export const PlanObjectiveSchema = z.object({
  index: z.number().int(),
  text: z.string().describe('Short instruction, e.g. "Find Brynja\'s ring"'),
  shownAtStage: z.number().int(),
  completedAtStage: z.number().int().nullable(),
  targetKey: z.string().nullable().describe('Character, item or location key the quest marker points at'),
});

export const PlanStepSchema = z.object({
  from: z.number().int().nullable().describe('Stage the player must be at (null = any time)'),
  to: z.number().int().describe('Stage this step sets'),
  kind: z.enum(['talk', 'pickup', 'activate', 'death', 'arrive', 'read', 'equip', 'drop', 'script']),
  targetKey: z.string().nullable().describe('Item key (pickup/drop/read/equip/activate), character key (death/activate) or location key (arrive); null for talk and script'),
  note: z.string().describe('What happens, in a few words'),
});

export const PlanConversationSchema = z.object({
  title: z.string(),
  screenplay: z.string().describe('The conversation in screenplay format (see the instructions): NAME: line, indentation for choices, tags like [stage 20], [if stage 10], [goodbye], [emotion happy], [gives key x1], [takes key x1], [gesture point]'),
});

export const PlanRewardSchema = z.object({
  atStage: z.number().int(),
  gold: z.number().int().nullable(),
  itemKey: z.string().nullable(),
});

export const QuestPlanSchema = z.object({
  title: z.string().describe('Quest name shown in the journal'),
  editorId: z.string().describe('Editor ID: letters and digits only, e.g. "MyRingQuest"'),
  summary: z.string(),
  startsWithGame: z.boolean().describe('True when the quest must be running from the start so its opening dialogue is available'),
  characters: z.array(PlanCharacterSchema),
  locations: z.array(PlanLocationSchema),
  items: z.array(PlanItemSchema),
  stages: z.array(PlanStageSchema),
  objectives: z.array(PlanObjectiveSchema),
  steps: z.array(PlanStepSchema),
  conversations: z.array(PlanConversationSchema),
  rewards: z.array(PlanRewardSchema),
  assumptions: z.array(z.string()).describe('Every decision not stated in the source text, for the author to confirm'),
  questions: z.array(z.string()).describe('Things the author should decide that you could not'),
});

export type QuestPlan = z.infer<typeof QuestPlanSchema>;
export type PlanCharacter = z.infer<typeof PlanCharacterSchema>;
export type PlanLocation = z.infer<typeof PlanLocationSchema>;
export type PlanItem = z.infer<typeof PlanItemSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;

export interface PlanIssue {
  severity: 'error' | 'warning';
  message: string;
}

/** An empty plan to start from by hand. */
export function emptyPlan(): QuestPlan {
  return {
    title: 'New Quest',
    editorId: 'NewQuest',
    summary: '',
    startsWithGame: true,
    characters: [],
    locations: [],
    items: [],
    stages: [
      { index: 0, journal: '', startsQuest: true, completesQuest: false, failsQuest: false },
      { index: 100, journal: '', startsQuest: false, completesQuest: true, failsQuest: false },
    ],
    objectives: [],
    steps: [],
    conversations: [],
    rewards: [],
    assumptions: [],
    questions: [],
  };
}

/** Problems that would stop (errors) or weaken (warnings) a build. */
export function validatePlan(plan: QuestPlan): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const err = (message: string) => issues.push({ severity: 'error', message });
  const warn = (message: string) => issues.push({ severity: 'warning', message });
  const parsed = QuestPlanSchema.safeParse(plan);
  if (!parsed.success) for (const i of parsed.error.issues.slice(0, 8)) err(`${i.path.join('.') || 'plan'}: ${i.message}`);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(plan.editorId ?? '')) err('The quest Editor ID must start with a letter and use only letters, digits and _');
  const keys = new Map<string, string>();
  for (const [kind, list] of [
    ['character', plan.characters],
    ['location', plan.locations],
    ['item', plan.items],
  ] as const)
    for (const e of list ?? []) {
      if (!e.key) err(`A ${kind} has no key`);
      else if (keys.has(e.key)) err(`The key "${e.key}" is used twice`);
      else keys.set(e.key, kind);
    }
  const isKind = (key: string | null, ...kinds: string[]) => key !== null && kinds.includes(keys.get(key) ?? '');
  const stages = new Set((plan.stages ?? []).map((s) => s.index));
  if (stages.size !== (plan.stages ?? []).length) err('Two stages have the same number');
  if (!(plan.stages ?? []).some((s) => s.completesQuest)) warn('No stage completes the quest');
  for (const c of plan.characters ?? []) if (c.locationKey && !isKind(c.locationKey, 'location')) err(`${c.name} stands in "${c.locationKey}", which isn't a location in the plan`);
  for (const i of plan.items ?? []) {
    if (i.startsWith === 'location' && !isKind(i.startsAtKey, 'location')) err(`${i.name} starts in "${i.startsAtKey}", which isn't a location in the plan`);
    if (i.startsWith === 'character' && !isKind(i.startsAtKey, 'character')) err(`${i.name} starts with "${i.startsAtKey}", who isn't a character in the plan`);
  }
  for (const o of plan.objectives ?? []) {
    if (!stages.has(o.shownAtStage)) err(`Objective ${o.index} is shown at stage ${o.shownAtStage}, which doesn't exist`);
    if (o.completedAtStage !== null && !stages.has(o.completedAtStage)) err(`Objective ${o.index} is completed at stage ${o.completedAtStage}, which doesn't exist`);
    if (o.targetKey && !keys.has(o.targetKey)) warn(`Objective ${o.index} points at "${o.targetKey}", which isn't in the plan`);
  }
  const need: Record<PlanStep['kind'], string[]> = { talk: [], script: [], pickup: ['item'], drop: ['item'], read: ['item'], equip: ['item'], activate: ['item', 'character'], death: ['character'], arrive: ['location'] };
  for (const s of plan.steps ?? []) {
    if (!stages.has(s.to)) err(`A step sets stage ${s.to}, which doesn't exist`);
    if (s.from !== null && !stages.has(s.from)) err(`A step starts from stage ${s.from}, which doesn't exist`);
    if (need[s.kind].length && !isKind(s.targetKey, ...need[s.kind])) err(`The "${s.note || s.kind}" step needs a ${need[s.kind].join(' or ')} key, but has "${s.targetKey ?? 'none'}"`);
  }
  for (const r of plan.rewards ?? []) {
    if (!stages.has(r.atStage)) err(`A reward is given at stage ${r.atStage}, which doesn't exist`);
    if (r.itemKey && !isKind(r.itemKey, 'item')) err(`A reward gives "${r.itemKey}", which isn't an item in the plan`);
  }
  return issues;
}
