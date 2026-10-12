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
import { lintScreenplay } from './dialoguelint';
import { journalContextFromPlan, lintJournal } from './journal';

export const RELATIONSHIP_RANKS = ['lover', 'ally', 'confidant', 'friend', 'acquaintance', 'rival', 'foe', 'enemy', 'archnemesis'] as const;

/** Short identifiers the plan uses to refer to its own characters, places and items. */
const Key = z.string().describe('Short identifier used to refer to this entry elsewhere in the plan, e.g. "brynja" or "cellar"');

export const PlanLookSchema = z.object({
  weight: z.number().nullable().describe('Build from 0 (thin) to 100 (heavy/muscular); null to leave or pick at random'),
  height: z.number().nullable().describe('Height multiplier, 0.9 (short) to 1.1 (tall); null to leave'),
  hair: z.string().nullable().describe('Hair style in a few words, e.g. "long braids", "short", "bald"'),
  hairColor: z.string().nullable().describe('e.g. "grey", "black", "red", "blonde"'),
  facialHair: z.string().nullable().describe('e.g. "full beard", "none"; null for women or to leave'),
  eyes: z.string().nullable().describe('Eye colour, e.g. "blue"'),
  scar: z.string().nullable().describe('A scar or war paint, e.g. "scar across left eye"; null for none'),
});

export const PlanCharacterSchema = z.object({
  key: Key,
  name: z.string().describe('Name shown in game'),
  existing: z.string().nullable().describe('Editor ID or name of an existing character from the load order to use (and change, if the text asks) instead of creating one; null to create a new character'),
  basedOn: z.string().nullable().describe('For a new character: an existing character to copy (Editor ID or name) when the text says they are like someone; null to pick one automatically'),
  sex: z.enum(['male', 'female']).nullable(),
  race: z.string().nullable().describe('Race name or Editor ID from the load order, e.g. "Nord"'),
  role: z.string().describe('What they do in the story, e.g. "innkeeper who gives the quest"'),
  appearance: z.string().describe('Short appearance notes, e.g. "middle-aged, grey braids, scar on cheek"'),
  look: PlanLookSchema.nullable().describe('The appearance as settings; for existing characters only set what the text asks to change, otherwise null'),
  voice: z.string().nullable().describe('Voice type Editor ID or description, e.g. "FemaleCommoner"'),
  locationKey: z.string().nullable().describe('Key of the location where they stand; null if they already exist in the world'),
  spot: z.string().nullable().describe('Where in that location, e.g. "behind the bar", "by the forge", "next to the fire"; null for anywhere sensible'),
  essential: z.boolean().nullable().describe("True: can't be killed. For existing characters null leaves it as it is"),
  className: z.string().nullable().describe('Class name or Editor ID (e.g. "Warrior", "Citizen"); null to leave or keep the copied one'),
  level: z.number().int().nullable(),
  outfit: z
    .object({
      items: z.array(z.string()).describe('What they wear: item keys from this plan (new clothing) or names/Editor IDs of existing clothing and armour'),
      saveAs: z.string().nullable().describe('Editor ID to save this set as a reusable outfit (e.g. "MyInnkeeperOutfit"); null to name it automatically'),
    })
    .nullable()
    .describe('Their worn clothing (their default outfit); null to leave it'),
  factions: z.array(z.object({ faction: z.string().describe('Faction name or Editor ID'), rank: z.number().int() })).describe('Factions to add them to'),
  inventory: z.array(z.object({ item: z.string().describe('Item key from this plan, or the name/Editor ID of an existing item'), count: z.number().int() })).describe('Extra things they carry (not quest items, which use items.startsWith)'),
  routine: z
    .array(
      z.object({
        activity: z.enum(['sandbox', 'sleep', 'eat', 'stay', 'travel', 'follow', 'forcegreet']).describe('sandbox: go about their business (sit, chat, work); stay: stay put; travel: go to a place; follow: follow the player; forcegreet: walk up to the player and speak'),
        where: z.string().nullable().describe('Location key from this plan or an existing cell name; null = around where they stand'),
        hours: z.object({ from: z.number().int(), to: z.number().int() }).nullable().describe('Hours of the day, e.g. 22 to 6 for sleeping; null = any time'),
        fromStage: z.number().int().nullable().describe('Only once the quest reaches this stage'),
        untilStage: z.number().int().nullable().describe('Only until the quest reaches this stage'),
        line: z.string().nullable().describe('For forcegreet: what they say when they reach the player'),
      }),
    )
    .describe('What they do: their daily routine, and what the quest makes them do (follow the player, come and talk). Empty to leave it'),
  combat: z
    .object({
      hostile: z.boolean().nullable().describe('True: attacks the player on sight (bandits, a villain); false: never starts fights; null to leave'),
      levelScaled: z.object({ min: z.number().int(), max: z.number().int() }).nullable().describe('Grows with the player between these levels instead of a fixed level; null to leave'),
      skills: z.array(z.object({ skill: z.string().describe('e.g. "One-handed", "Destruction", "Sneak"'), value: z.number().int() })).describe('Skill values to set'),
      spells: z.array(z.string()).describe('Spells or shouts they know, by name or Editor ID (e.g. "Firebolt", "Healing")'),
      perks: z.array(z.string()).describe('Perks, by name or Editor ID'),
      combatStyle: z.string().nullable().describe('How they fight: a combat style name or Editor ID (e.g. "Archer", "Mage", "Berserker"); null to leave'),
    })
    .nullable()
    .describe('How they fight; null to leave it'),
  roles: z
    .object({
      follower: z.boolean().describe('Can be asked to follow the player'),
      marriage: z.boolean().describe('Can be married'),
      innkeeper: z.boolean().describe('Runs an inn (sells food and drink, rents rooms)'),
      merchant: z.object({ sells: z.string().describe('What they sell: "general goods", "weapons", "armor", "potions", "food", "spells", "jewelry"…'), hours: z.object({ from: z.number().int(), to: z.number().int() }).nullable() }).nullable().describe('Buys and sells; null if not a merchant'),
      trainer: z.object({ skill: z.string(), maxLevel: z.number().int().describe('Highest level they train to: 50 (apprentice), 75 (expert), 90 (master)') }).nullable().describe('Trains a skill for gold; null if not a trainer'),
    })
    .nullable()
    .describe('Services and roles; null for none'),
  relationships: z
    .array(z.object({ with: z.string().describe('Character key from this plan, Editor ID of an existing character, or "player"'), rank: z.enum(RELATIONSHIP_RANKS) }))
    .describe('How they feel about other characters or the player'),
});

export const PlanEncounterSchema = z.object({
  key: Key,
  what: z.string().describe('The enemies: a type like "bandit", "draugr", "wolf", "skeever" or an Editor ID from the load order'),
  count: z.number().int().describe('How many (1–12)'),
  locationKey: z.string().describe('Location key from this plan or Editor ID of an existing interior where they wait'),
  spot: z.string().nullable().describe('Where in that place, e.g. "by the fire"; null for spread around'),
});

export const PlanLocationSchema = z.object({
  key: Key,
  name: z.string(),
  existing: z.string().nullable().describe('Editor ID or name of an existing cell; null to create a new interior'),
  description: z.string(),
  layoutLike: z.string().nullable().describe('For a new interior: Editor ID of an existing interior from the load order whose rooms, furniture, lights and clutter are copied (pick one that fits: an inn, a house, a cave, a shop…); null leaves it empty'),
  doorFrom: z.string().nullable().describe('For a new interior: location key or Editor ID of the place the player enters it from (a door is put there and linked); null for no door'),
});

export const PlanItemSchema = z.object({
  key: Key,
  name: z.string(),
  kind: z.enum(['misc', 'book', 'key', 'gold', 'clothing', 'armor', 'weapon', 'potion', 'other']),
  existing: z.string().nullable().describe('Editor ID or name of an existing item to use; null to create a new one'),
  basedOn: z.string().nullable().describe('For a new item: an existing item it is a variant of (e.g. "Fine Clothes", "Iron Sword"), copied for its model; null to pick one'),
  value: z.number().nullable(),
  startsWith: z.enum(['location', 'character', 'player', 'nowhere']).describe('Where the item is when the quest begins'),
  startsAtKey: z.string().nullable().describe('Location or character key for startsWith location/character'),
  spot: z.string().nullable().describe('Where in the location, e.g. "in the chest by the bed", "on the bar", "under the table"; null for a table'),
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
  kind: z.enum(['talk', 'pickup', 'activate', 'death', 'arrive', 'read', 'equip', 'drop', 'script', 'clear']),
  targetKey: z.string().nullable().describe('Item key (pickup/drop/read/equip/activate), character key (death/activate), location key (arrive) or encounter key (clear: every enemy in the group is dead); null for talk and script'),
  note: z.string().describe('What happens, in a few words'),
});

export const PlanConversationSchema = z.object({
  title: z.string(),
  screenplay: z.string().describe('The conversation in screenplay format (see the instructions): NAME: line, indentation for choices, tags like [stage 20], [if stage 10], [if has ring], [if speech 50], [goodbye], [once], [persuade 50], [emotion happy], [gives key x1], [takes key x1], [gesture point]; GREETING:, IDLE: and SCENE: name [at stage N] blocks for lines nobody prompts'),
});

export const PlanAnimationSchema = z.object({
  atStage: z.number().int(),
  characterKey: z.string(),
  gesture: z.string().describe('A gesture name from the instructions, e.g. "wave", "laugh", "pray"'),
});

export const PLAN_EVENT_KINDS = ['spawn', 'hostile', 'friendly', 'unlock', 'lock', 'show', 'hide', 'moveTo', 'kill', 'fade', 'sound', 'weather', 'message', 'startQuest', 'movePlayer'] as const;
export type PlanEventKind = (typeof PLAN_EVENT_KINDS)[number];

export const PlanEventSchema = z.object({
  atStage: z.number().int().describe('Stage at which it happens'),
  kind: z
    .enum(PLAN_EVENT_KINDS)
    .describe(
      'spawn: enemies appear (what = enemy type, count, at target or by the player); hostile / friendly: a character attacks the player or stops fighting; unlock / lock: a door or chest; show / hide: make something appear or vanish (shown things start hidden); moveTo: move a character (target) to a place or someone (to); kill: a character dies; fade: the screen fades to black and back (count = seconds of black); sound: play a sound (what); weather: change the weather (what, or "clear" to go back to normal); message: a notification on screen (what); startQuest: start another quest (what = its Editor ID); movePlayer: move the player to a place (to)',
    ),
  targetKey: z.string().nullable().describe('Who or what it happens to: a character, item or location key from this plan, or the Editor ID or name of something already in the world (a door, a character); null for the player or where not needed'),
  toKey: z.string().nullable().describe('For moveTo and movePlayer: the place or character to go to (key or Editor ID); otherwise null'),
  what: z.string().nullable().describe('spawn: enemy type, e.g. "bandit", "draugr", "wolf" or an Editor ID; sound / weather: name or Editor ID; message: the text; startQuest: the quest; otherwise null'),
  count: z.number().int().nullable().describe('spawn: how many (1–10); fade: seconds of black; otherwise null'),
  note: z.string().describe('What happens, in a few words'),
});

export const PlanStartSchema = z.object({
  kind: z
    .enum(['game', 'arrive', 'read', 'pickup', 'activate', 'afterQuest'])
    .describe('game: running from the start (needed when it begins by talking to someone); arrive: when the player enters a place (targetKey = location); read / pickup / activate: when the player reads, picks up or uses an item or object (targetKey); afterQuest: when another quest reaches a stage (quest, stage), for questlines'),
  targetKey: z.string().nullable().describe('arrive / read / pickup / activate: location or item key from this plan, or the Editor ID of an existing place or placed object; otherwise null'),
  quest: z.string().nullable().describe('afterQuest: Editor ID of the quest that comes before this one; otherwise null'),
  stage: z.number().int().nullable().describe('afterQuest: the stage of that quest that starts this one; null for its last stage'),
});

export const PlanFailureSchema = z.object({
  kind: z.enum(['death', 'timeLimit']).describe('death: the quest fails if this character dies before it is finished; timeLimit: it fails if not finished within some in-game days'),
  targetKey: z.string().nullable().describe('death: character key from this plan, or the Editor ID of an existing character; otherwise null'),
  days: z.number().nullable().describe('timeLimit: in-game days allowed (e.g. 3); otherwise null'),
  fromStage: z.number().int().nullable().describe('timeLimit: the stage at which the clock starts; null for the first stage'),
  failStage: z.number().int().describe('The stage set when it fails (a stage with failsQuest true and a journal entry saying what went wrong)'),
  note: z.string().describe('What happens, in a few words'),
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
  startsWhen: PlanStartSchema.nullable().describe('What starts the quest when it does not start with the game: entering a place, reading a note, picking something up, using something, or another quest reaching a stage; null when it starts with the game'),
  characters: z.array(PlanCharacterSchema),
  locations: z.array(PlanLocationSchema),
  items: z.array(PlanItemSchema),
  encounters: z.array(PlanEncounterSchema).describe('Groups of enemies waiting somewhere (bandits in a cave, draugr in a tomb), taken from the load order'),
  stages: z.array(PlanStageSchema),
  objectives: z.array(PlanObjectiveSchema),
  steps: z.array(PlanStepSchema),
  conversations: z.array(PlanConversationSchema),
  rewards: z.array(PlanRewardSchema),
  animations: z.array(PlanAnimationSchema).describe('Characters playing a gesture when the quest reaches a stage (outside dialogue)'),
  failures: z.array(PlanFailureSchema).describe('Ways the quest fails: someone dies, or time runs out'),
  events: z.array(PlanEventSchema).describe('Things that happen in the world when the quest reaches a stage: enemies appear, someone turns hostile, a door unlocks, something appears or vanishes, a fade to black, a sound, the weather'),
  assumptions: z.array(z.string()).describe('Every decision not stated in the source text, for the author to confirm'),
  questions: z.array(z.string()).describe('Things the author should decide that you could not'),
});

export type QuestPlan = z.infer<typeof QuestPlanSchema>;
export type PlanCharacter = z.infer<typeof PlanCharacterSchema>;
export type PlanLocation = z.infer<typeof PlanLocationSchema>;
export type PlanItem = z.infer<typeof PlanItemSchema>;
export type PlanLook = z.infer<typeof PlanLookSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
export type PlanEvent = z.infer<typeof PlanEventSchema>;
export type PlanStart = z.infer<typeof PlanStartSchema>;
export type PlanFailure = z.infer<typeof PlanFailureSchema>;
export type PlanEncounter = z.infer<typeof PlanEncounterSchema>;

/** Fill in lists added to the plan format later, so plans saved by older versions still load. */
export function normalizePlan(plan: QuestPlan): QuestPlan {
  plan.events ??= [];
  plan.failures ??= [];
  plan.encounters ??= [];
  for (const c of plan.characters ?? []) {
    if (c.combat === undefined) c.combat = null;
    if (c.roles === undefined) c.roles = null;
    c.relationships ??= [];
  }
  for (const l of plan.locations ?? []) {
    if (l.layoutLike === undefined) l.layoutLike = null;
    if (l.doorFrom === undefined) l.doorFrom = null;
  }
  if (plan.startsWhen === undefined) plan.startsWhen = null;
  plan.animations ??= [];
  plan.rewards ??= [];
  return plan;
}

export interface PlanIssue {
  severity: 'error' | 'warning';
  message: string;
}

const START_VERB = { arrive: 'enters', read: 'reads', pickup: 'picks up', activate: 'uses' } as const;

/** An empty plan to start from by hand. */
export function emptyPlan(): QuestPlan {
  return {
    title: 'New Quest',
    editorId: 'NewQuest',
    summary: '',
    startsWithGame: true,
    startsWhen: null,
    characters: [],
    locations: [],
    items: [],
    encounters: [],
    stages: [
      { index: 0, journal: '', startsQuest: true, completesQuest: false, failsQuest: false },
      { index: 100, journal: '', startsQuest: false, completesQuest: true, failsQuest: false },
    ],
    objectives: [],
    steps: [],
    conversations: [],
    rewards: [],
    animations: [],
    events: [],
    failures: [],
    assumptions: [],
    questions: [],
  };
}

/** Problems that would stop (errors) or weaken (warnings) a build. */
export function validatePlan(input: QuestPlan): PlanIssue[] {
  // Plans written before a field existed are checked as if it were empty.
  const plan = normalizePlan(structuredClone(input));
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
    ['encounter', plan.encounters ?? []],
  ] as const)
    for (const e of list ?? []) {
      if (!e.key) err(`A ${kind} has no key`);
      else if (keys.has(e.key)) err(`The key "${e.key}" is used twice`);
      else keys.set(e.key, kind);
    }
  const isKind = (key: string | null, ...kinds: string[]) => key !== null && kinds.includes(keys.get(key) ?? '');
  const stages = new Set((plan.stages ?? []).map((s) => s.index));
  if (stages.size !== (plan.stages ?? []).length) err('Two stages have the same number');
  if ((plan.stages ?? []).length && !(plan.stages ?? []).some((s) => s.completesQuest)) warn('No stage completes the quest');
  for (const c of plan.characters ?? []) {
    if (c.existing && c.basedOn) warn(`${c.name} already exists, so “based on ${c.basedOn}” is ignored`);
    for (const i of c.inventory ?? []) if (i.count < 1) err(`${c.name} carries ${i.count} × ${i.item}`);
    if (c.outfit && !c.outfit.items.length) err(`${c.name}'s outfit has nothing in it`);
    for (const r of c.routine ?? []) {
      if (r.activity === 'forcegreet' && !r.line?.trim()) err(`${c.name} walks up to the player but has nothing to say (forcegreet needs a line)`);
      if ((r.activity === 'follow' || r.activity === 'forcegreet') && !(plan.stages ?? []).length) err(`${c.name} can only ${r.activity === 'follow' ? 'follow the player' : 'walk up to the player'} as part of a quest`);
      for (const st of [r.fromStage, r.untilStage]) if (st !== null && !(plan.stages ?? []).some((x) => x.index === st)) err(`${c.name}'s routine mentions stage ${st}, which doesn't exist`);
      if (r.hours && (r.hours.from < 0 || r.hours.from > 23 || r.hours.to < 0 || r.hours.to > 24)) err(`${c.name}'s routine hours must be 0–23`);
    }
    if (c.outfit?.saveAs && !/^[A-Za-z][A-Za-z0-9_]*$/.test(c.outfit.saveAs)) err(`The outfit name “${c.outfit.saveAs}” must be an Editor ID (letters, digits and _)`);
  }
  for (const l of plan.locations ?? []) {
    if (l.existing && (l.layoutLike || l.doorFrom)) warn(`${l.name} already exists, so its layout and door are left as they are`);
    if (l.doorFrom && l.doorFrom === l.key) err(`${l.name} can't have its door in itself`);
  }
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
  for (const c of plan.characters ?? []) {
    const ls = c.combat?.levelScaled;
    if (ls && (ls.min < 1 || ls.max < ls.min)) err(`${c.name} levels with the player from ${ls.min} to ${ls.max}; the lowest must be at least 1 and not above the highest`);
    if (c.combat?.levelScaled && c.level !== null) warn(`${c.name} has both a fixed level and levels with the player; levelling with the player wins`);
    if (c.roles?.trainer && (c.roles.trainer.maxLevel < 1 || c.roles.trainer.maxLevel > 100)) err(`${c.name} trains up to level ${c.roles.trainer.maxLevel}; use 1 to 100`);
    if (c.roles?.merchant && !c.roles.merchant.sells.trim()) err(`${c.name} is a merchant but doesn't say what they sell`);
    for (const r of c.relationships ?? []) if (r.with === c.key) err(`${c.name} has a relationship with themselves`);
  }
  for (const e of plan.encounters ?? []) {
    if (e.count < 1 || e.count > 12) err(`${e.count} ${e.what}: use 1 to 12 enemies in a group`);
    if (!e.what.trim()) err(`An enemy group doesn't say what the enemies are`);
  }
  const need: Record<PlanStep['kind'], string[]> = { clear: ['encounter'], talk: [], script: [], pickup: ['item'], drop: ['item'], read: ['item'], equip: ['item'], activate: ['item', 'character'], death: ['character'], arrive: ['location'] };
  for (const s of plan.steps ?? []) {
    if (!stages.has(s.to)) err(`A step sets stage ${s.to}, which doesn't exist`);
    if (s.from !== null && !stages.has(s.from)) err(`A step starts from stage ${s.from}, which doesn't exist`);
    if (need[s.kind].length && !isKind(s.targetKey, ...need[s.kind])) err(`The "${s.note || s.kind}" step needs a ${need[s.kind].join(' or ')} key, but has "${s.targetKey ?? 'none'}"`);
  }
  for (const r of plan.rewards ?? []) {
    if (!stages.has(r.atStage)) err(`A reward is given at stage ${r.atStage}, which doesn't exist`);
    if (r.itemKey && !isKind(r.itemKey, 'item')) err(`A reward gives "${r.itemKey}", which isn't an item in the plan`);
  }
  // Every stage after the first must be reachable: a step, a line of dialogue or a failure sets it.
  const reached = new Set<number>([...(plan.steps ?? []).map((st) => st.to), ...(plan.failures ?? []).map((f) => f.failStage)]);
  for (const c of plan.conversations ?? []) for (const m of c.screenplay.matchAll(/\[stage\s+(-?\d+)\]/gi)) reached.add(Number(m[1]));
  const ordered = [...(plan.stages ?? [])].sort((a, b) => a.index - b.index);
  for (const st of ordered.slice(1)) if (!st.startsQuest && !reached.has(st.index)) warn(`Nothing moves the quest to stage ${st.index}: add a step, or a [stage ${st.index}] tag on a line of dialogue`);
  // The conversations, as they'll be imported.
  const speakers = (plan.characters ?? []).flatMap((c) => [c.key, c.name, ...(c.existing ? [c.existing] : [])]);
  for (const c of plan.conversations ?? [])
    for (const l of lintScreenplay(c.screenplay, { stages: [...stages], speakers })) issues.push({ severity: l.severity, message: `${c.title}${l.line ? ` (line ${l.line})` : ''}: ${l.message}` });
  // Journal and objective wording.
  if (parsed.success) for (const l of lintJournal(journalContextFromPlan(plan))) warn(l.message);
  for (const a of plan.animations ?? []) {
    if (!stages.has(a.atStage)) err(`An animation plays at stage ${a.atStage}, which doesn't exist`);
    if (!isKind(a.characterKey, 'character')) err(`An animation is played by "${a.characterKey}", who isn't a character in the plan`);
  }
  const sw = plan.startsWhen;
  if (sw && sw.kind !== 'game') {
    if (sw.kind === 'afterQuest' && !sw.quest?.trim()) err('The quest starts after another quest, but doesn’t say which');
    if (sw.kind !== 'afterQuest' && !sw.targetKey?.trim()) err(`The quest starts when the player ${START_VERB[sw.kind]} something, but doesn’t say what`);
    if ((sw.kind === 'read' || sw.kind === 'pickup') && sw.targetKey && keys.get(sw.targetKey) === 'item') {
      const i = (plan.items ?? []).find((x) => x.key === sw.targetKey)!;
      if (i.startsWith !== 'location') err(`${i.name} starts the quest when ${sw.kind === 'read' ? 'read' : 'picked up'}, so it must be placed in a location`);
    }
    if (plan.startsWithGame) warn('The quest starts with the game, so “starts when…” never matters; turn one of them off');
  }
  if (!plan.startsWithGame && (!sw || sw.kind === 'game') && (plan.stages ?? []).length) warn('Nothing starts the quest: it doesn’t start with the game and has no “starts when…”');
  for (const f of plan.failures ?? []) {
    const what = `“${f.note || (f.kind === 'death' ? 'Fails on death' : 'Time limit')}”`;
    const st = (plan.stages ?? []).find((x) => x.index === f.failStage);
    if (!st) err(`${what} sets stage ${f.failStage}, which doesn't exist`);
    else if (!st.failsQuest) warn(`${what} sets stage ${f.failStage}, which doesn't fail the quest; tick “Fails the quest” on it`);
    if (f.kind === 'death' && !f.targetKey?.trim()) err(`${what} needs the character who mustn't die`);
    if (f.kind === 'death' && f.targetKey && keys.has(f.targetKey) && keys.get(f.targetKey) !== 'character') err(`${what}: “${f.targetKey}” isn't a character`);
    if (f.kind === 'death') {
      const c = (plan.characters ?? []).find((x) => x.key === f.targetKey);
      if (c?.essential) warn(`${c.name} is essential (can't die), so ${what} never happens`);
    }
    if (f.kind === 'timeLimit') {
      if (!(f.days && f.days > 0)) err(`${what} needs a number of days`);
      if (f.fromStage !== null && !stages.has(f.fromStage)) err(`${what} starts the clock at stage ${f.fromStage}, which doesn't exist`);
    }
  }
  if ((plan.failures ?? []).filter((f) => f.kind === 'timeLimit').length > 1) err('A quest can have one time limit');
  const needTarget: PlanEventKind[] = ['hostile', 'friendly', 'unlock', 'lock', 'show', 'hide', 'moveTo', 'kill'];
  const needWhat: PlanEventKind[] = ['spawn', 'sound', 'weather', 'message', 'startQuest'];
  for (const e of plan.events ?? []) {
    const what = `The “${e.note || e.kind}” event`;
    if (!stages.has(e.atStage)) err(`${what} happens at stage ${e.atStage}, which doesn't exist`);
    if (needTarget.includes(e.kind) && !e.targetKey?.trim()) err(`${what} needs a target (who or what it happens to)`);
    if (needWhat.includes(e.kind) && !e.what?.trim()) err(`${what} needs ${e.kind === 'spawn' ? 'an enemy type' : e.kind === 'message' ? 'the text' : e.kind === 'startQuest' ? 'the quest to start' : `the ${e.kind}`}`);
    if ((e.kind === 'moveTo' || e.kind === 'movePlayer') && !e.toKey?.trim()) err(`${what} needs somewhere to go`);
    if (e.kind === 'spawn' && e.count !== null && (e.count < 1 || e.count > 10)) err(`${what} spawns ${e.count}; use 1 to 10`);
    if (e.kind === 'kill') {
      const c = (plan.characters ?? []).find((x) => x.key === e.targetKey);
      if (c?.essential) warn(`${c.name} is essential, so “${e.note || e.kind}” can't kill them`);
    }
  }
  return issues;
}
