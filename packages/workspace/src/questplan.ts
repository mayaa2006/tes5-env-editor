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
import { skillIndex } from './skills';
import { parseScreenplay, type ScriptPlayerLine } from './dialogue';
import { KNOWN_TAGS, lintScreenplay } from './dialoguelint';
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
  sex: z.enum(['male', 'female']).nullable().describe('For existing characters null leaves it as it is'),
  race: z.string().nullable().describe('Race name or Editor ID from the load order, e.g. "Nord"'),
  role: z.string().describe('What they do in the story, e.g. "innkeeper who gives the quest"'),
  appearance: z.string().describe('Short appearance notes, e.g. "middle-aged, grey braids, scar on cheek"'),
  look: PlanLookSchema.nullable().describe('The appearance as settings; for existing characters only set what the text asks to change, otherwise null'),
  voice: z.string().nullable().describe('Voice type Editor ID or description, e.g. "FemaleCommoner"'),
  locationKey: z.string().nullable().describe('Key of the location where they stand; null if they already exist in the world'),
  spot: z.string().nullable().describe('Where in that location, e.g. "behind the bar", "by the forge", "next to the fire"; null for anywhere sensible'),
  essential: z.boolean().nullable().describe("True: can't be killed. For existing characters null leaves it as it is"),
  className: z.string().nullable().describe('Class name or Editor ID (e.g. "Warrior", "Citizen"); null to leave or keep the copied one'),
  level: z.number().int().nullable().describe('Fixed level (e.g. 5 for a villager, 20 for a seasoned fighter); null to leave or copy'),
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
  name: z.string().describe('Name shown in game, e.g. "Riverside Cave"'),
  existing: z.string().nullable().describe('Editor ID of an existing interior from the load order list; null to create a new interior'),
  description: z.string().describe('What the place is, in a few words'),
  layoutLike: z.string().nullable().describe('For a new interior: Editor ID of an existing interior from the load order whose rooms, furniture, lights and clutter are copied (pick one that fits: an inn, a house, a cave, a shop…); null leaves it empty'),
  doorFrom: z.string().nullable().describe('For a new interior: location key or Editor ID of the place the player enters it from (a door is put there and linked); null for no door'),
});

export const PlanItemSchema = z.object({
  key: Key,
  name: z.string().describe('Name shown in game, e.g. "Brynja\'s Ring"'),
  kind: z.enum(['misc', 'book', 'key', 'gold', 'clothing', 'armor', 'weapon', 'potion', 'other']).describe('misc: a trinket or quest object (rings, letters to deliver); book: a note, letter or book the player can read; key: opens a locked door or chest'),
  existing: z.string().nullable().describe('Editor ID or name of an existing item to use; null to create a new one'),
  basedOn: z.string().nullable().describe('For a new item: an existing item it is a variant of (e.g. "Fine Clothes", "Iron Sword"), copied for its model; null to pick one'),
  value: z.number().nullable().describe('Price in gold; null to pick one'),
  startsWith: z.enum(['location', 'character', 'player', 'nowhere']).describe('Where the item is when the quest begins. location: lying somewhere (needed for anything the player must pick up or read); character: carried by a character (e.g. to hand over with [gives …]); player: the player has it; nowhere: given later'),
  startsAtKey: z.string().nullable().describe('Location or character key for startsWith location/character'),
  spot: z.string().nullable().describe('Where in the location, e.g. "in the chest by the bed", "on the bar", "under the table"; null for a table'),
});

export const PlanStageSchema = z.object({
  index: z.number().int().describe('Stage number: 0 or 10 to start, then steps of 10; the final stage is usually 100 or 200'),
  journal: z.string().describe('Journal text shown when this stage is reached, written in first person past tense; empty for silent stages'),
  startsQuest: z.boolean().describe('True on exactly one stage: the first'),
  completesQuest: z.boolean().describe('True on the final stage (on each final stage when there are several endings)'),
  failsQuest: z.boolean().describe('True on a stage that fails the quest (used by failures)'),
});

export const PlanObjectiveSchema = z.object({
  index: z.number().int().describe('Objective number: use the number of the stage that shows it'),
  text: z.string().describe('Short instruction, e.g. "Find Brynja\'s ring"'),
  shownAtStage: z.number().int().describe('Stage number at which it appears'),
  completedAtStage: z.number().int().nullable().describe('Stage number at which it is ticked off; null if never'),
  targetKey: z.string().nullable().describe('Character, item or location key the quest marker points at'),
});

export const PlanStepSchema = z.object({
  from: z.number().int().nullable().describe('Stage the player must be at (null = any time)'),
  to: z.number().int().describe('Stage this step sets'),
  kind: z.enum(['talk', 'pickup', 'activate', 'death', 'arrive', 'read', 'equip', 'drop', 'script', 'clear']).describe('talk: a conversation line with [stage N] does it (add the tag too); pickup / read / equip / drop: the player does this with an item; activate: the player uses an item or character; death: a character dies; arrive: the player enters a location; clear: every enemy in an encounter is dead; script: right away after the "from" stage'),
  targetKey: z.string().nullable().describe('Item key (pickup/drop/read/equip/activate), character key (death/activate), location key (arrive) or encounter key (clear: every enemy in the group is dead); null for talk and script'),
  note: z.string().describe('What happens, in a few words'),
});

export const PlanConversationSchema = z.object({
  title: z.string().describe('Who it is with, e.g. "Brynja"'),
  screenplay: z.string().describe('The conversation in screenplay format (see the instructions): NAME: line, indentation for choices, tags like [stage 20], [if stage 10], [if has ring], [if speech 50], [goodbye], [once], [persuade 50], [emotion happy], [gives key x1], [takes key x1], [gesture point]; GREETING:, IDLE: and SCENE: name [at stage N] blocks for lines nobody prompts'),
});

export const PlanAnimationSchema = z.object({
  atStage: z.number().int().describe('Stage number at which they play it'),
  characterKey: z.string().describe('Character key from this plan'),
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
  atStage: z.number().int().describe('Stage number at which the player gets it (usually the final one)'),
  gold: z.number().int().nullable().describe('Gold to give; null for none'),
  itemKey: z.string().nullable().describe('Item key from this plan to give; null for none'),
  skill: z
    .object({ skill: z.string().describe('The skill, e.g. "Archery", "One-handed", "Speech"'), levels: z.number().int().describe('How many levels it goes up: usually 1, at most 10') })
    .nullable()
    .describe('Training in a skill (someone teaches the player as a reward); null for none'),
});

export const QuestPlanSchema = z.object({
  title: z.string().describe('Quest name shown in the journal'),
  editorId: z.string().describe('Editor ID: letters and digits only, e.g. "MyRingQuest"'),
  summary: z.string().describe('The quest in one or two sentences'),
  startsWithGame: z.boolean().describe('True when the quest must be running from the start so its opening dialogue is available'),
  startsWhen: PlanStartSchema.nullable().describe('What starts the quest when it does not start with the game: entering a place, reading a note, picking something up, using something, or another quest reaching a stage; null when it starts with the game'),
  characters: z.array(PlanCharacterSchema).describe('Everyone who speaks, is changed, or matters to the quest'),
  locations: z.array(PlanLocationSchema).describe('Places the plan refers to: existing interiors, or new ones'),
  items: z.array(PlanItemSchema).describe('Quest items (to find, read, deliver or give as a reward) and new clothing or weapons'),
  encounters: z.array(PlanEncounterSchema).describe('Groups of enemies waiting somewhere (bandits in a cave, draugr in a tomb), taken from the load order'),
  stages: z.array(PlanStageSchema).describe('The quest\'s stages in order; empty when the text describes no quest'),
  objectives: z.array(PlanObjectiveSchema).describe('What the player is told to do, shown on screen'),
  steps: z.array(PlanStepSchema).describe('What moves the quest from one stage to the next; one for every stage after the first'),
  conversations: z.array(PlanConversationSchema).describe('Dialogue, one conversation per character who talks'),
  rewards: z.array(PlanRewardSchema).describe('Gold or items given at a stage, outside dialogue'),
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
    // [] written for "none" where a setting or null goes.
    for (const f of ['look', 'outfit', 'combat', 'roles'] as const) if (Array.isArray(c[f]) && !(c[f] as unknown[]).length) (c as Record<string, unknown>)[f] = null;
  }
  plan.assumptions ??= [];
  plan.questions ??= [];
  for (const l of plan.locations ?? []) {
    if (l.layoutLike === undefined) l.layoutLike = null;
    if (l.doorFrom === undefined) l.doorFrom = null;
  }
  if (plan.startsWhen === undefined) plan.startsWhen = null;
  plan.animations ??= [];
  plan.rewards ??= [];
  for (const r of plan.rewards) if (r.skill === undefined) r.skill = null;
  return plan;
}

/**
 * Mend the slips smaller models make, where the intent is clear:
 * - a name, or a key in the wrong case, where a key belongs ("Brynja" for "brynja");
 * - a quest or outfit Editor ID with spaces or punctuation ("The Lost Ring" → "TheLostRing");
 * - stages with no start (the first one starts the quest).
 * Returns what was changed, in words.
 */
export function repairPlan(plan: QuestPlan): string[] {
  const changes: string[] = [];
  // Called on raw answers before they're checked: anything not shaped as expected is left for the check to report.
  type Obj = Record<string, unknown>;
  const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter((x): x is Obj => !!x && typeof x === 'object') : []);
  const p = plan as unknown as Obj;
  // The same key twice: a "character" that is really one of the plan's items (it never speaks and stands nowhere) is
  // dropped; two entries in one list get told apart.
  {
    const itemKeys = new Set(list(p.items).map((i) => String(i.key)));
    const said = list(p.conversations).map((c) => (typeof c.screenplay === 'string' ? c.screenplay : '')).join('\n').toLowerCase();
    const speaks = (c: Obj) => [c.key, c.name].some((n) => typeof n === 'string' && new RegExp(`^\\s*${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'm').test(said));
    const before = list(p.characters);
    const kept = before.filter((c) => !(itemKeys.has(String(c.key)) && !speaks(c)));
    for (const c of before.filter((x) => !kept.includes(x))) changes.push(`left out the character “${String(c.name ?? c.key)}”, which is the item of the same name`);
    if (kept.length < before.length) p.characters = kept;
    for (const field of ['characters', 'locations', 'items', 'encounters'] as const) {
      const seen = new Set<string>();
      for (const e of list(p[field])) {
        const k = e.key;
        if (typeof k !== 'string') continue;
        let n = 1;
        while (seen.has(n === 1 ? k : `${k}${n}`)) n++;
        if (n > 1) {
          changes.push(`a second “${k}” in ${field} is now “${k}${n}”`);
          e.key = `${k}${n}`;
        }
        seen.add(n === 1 ? k : `${k}${n}`);
      }
    }
  }
  const entries = [...list(p.characters), ...list(p.locations), ...list(p.items), ...list(p.encounters)].filter((e) => typeof e.key === 'string' && e.key);
  const keys = new Set(entries.map((e) => e.key as string));
  const lookup = new Map(entries.map((e) => [(e.key as string).toLowerCase(), e.key as string]));
  // Names count only when they're unambiguous.
  const names = new Map<string, string | null>();
  for (const e of entries) {
    const n = typeof e.name === 'string' ? e.name.trim().toLowerCase() : '';
    if (n) names.set(n, names.has(n) && names.get(n) !== e.key ? null : (e.key as string));
  }
  const fix = (o: Obj | null | undefined, field: string) => {
    const v = o?.[field];
    if (!o || typeof v !== 'string' || keys.has(v)) return;
    const t = v.trim().toLowerCase();
    const key = lookup.get(t) ?? names.get(t);
    if (key) {
      o[field] = key;
      changes.push(`"${v}" → "${key}"`);
    }
  };
  for (const c of list(p.characters)) {
    fix(c, 'locationKey');
    for (const r of list(c.routine)) fix(r, 'where');
    for (const r of list(c.relationships)) fix(r, 'with');
  }
  for (const l of list(p.locations)) fix(l, 'doorFrom');
  for (const i of list(p.items)) fix(i, 'startsAtKey');
  for (const e of list(p.encounters)) fix(e, 'locationKey');
  for (const o of list(p.objectives)) fix(o, 'targetKey');
  for (const s of list(p.steps)) fix(s, 'targetKey');
  for (const r of list(p.rewards)) fix(r, 'itemKey');
  for (const a of list(p.animations)) fix(a, 'characterKey');
  for (const e of list(p.events)) (fix(e, 'targetKey'), fix(e, 'toKey'));
  for (const f of list(p.failures)) fix(f, 'targetKey');
  if (p.startsWhen && typeof p.startsWhen === 'object') fix(p.startsWhen as Obj, 'targetKey');
  const editorId = (v: string) => {
    const id = v
      .replace(/['’]/g, '')
      .split(/[^A-Za-z0-9_]+/)
      .filter(Boolean)
      .map((w) => w[0]!.toUpperCase() + w.slice(1))
      .join('');
    return /^[A-Za-z]/.test(id) ? id : `Q${id}`;
  };
  const valid = (v: string) => /^[A-Za-z][A-Za-z0-9_]*$/.test(v);
  if (typeof p.editorId === 'string' && p.editorId && !valid(p.editorId) && editorId(p.editorId).length > 1) {
    changes.push(`quest Editor ID "${p.editorId}" → "${editorId(p.editorId)}"`);
    p.editorId = editorId(p.editorId);
  }
  for (const c of list(p.characters)) {
    const outfit = c.outfit as Obj | null | undefined;
    if (outfit && typeof outfit.saveAs === 'string' && outfit.saveAs && !valid(outfit.saveAs)) {
      changes.push(`outfit "${outfit.saveAs}" → "${editorId(outfit.saveAs)}"`);
      outfit.saveAs = editorId(outfit.saveAs);
    }
  }
  // Tags the editor doesn't know would stop the build: near-misses are mended, inventions taken out.
  const NEAR: Record<string, string> = { give: 'gives', giving: 'gives', take: 'takes', taking: 'takes', stages: 'stage', emotions: 'emotion', gestures: 'gesture', teach: 'teaches', train: 'trains', skills: 'skill', bye: 'goodbye', end: 'goodbye' };
  for (const c of list(p.conversations)) {
    if (typeof c.screenplay !== 'string') continue;
    c.screenplay = c.screenplay.replace(/\[([a-z]+)((?:\s+[^\]]*)?)\]/gi, (m: string, tag: string, rest: string) => {
      const to = NEAR[tag.toLowerCase()];
      if (KNOWN_TAGS.has(tag.toLowerCase())) return m;
      changes.push(to ? `[${tag}] → [${to}] in “${c.title}”` : `took ${m} out of “${c.title}” (not a tag the editor knows)`);
      return to ? `[${to}${rest}]` : '';
    });
  }
  // A line that moves the quest on with nothing limiting when it's offered: tied to the stage the plan's own talk step
  // comes from ("The player chooses gold", 30 → 40, puts [if stage 30] on the line that sets 40).
  const talkFrom = new Map<number, Set<number>>();
  for (const st of list(p.steps))
    if (st.kind === 'talk' && typeof st.to === 'number' && typeof st.from === 'number') talkFrom.set(st.to, new Set([...(talkFrom.get(st.to) ?? []), st.from]));
  for (const c of list(p.conversations)) {
    if (typeof c.screenplay !== 'string') continue;
    const rows = c.screenplay.split(/\r?\n/);
    const before = rows.join('\n');
    const visit = (pl: ScriptPlayerLine, gated: boolean) => {
      const own = gated || 'if' in pl.tags;
      for (const r of pl.responses) {
        const g = own || 'if' in r.tags;
        const from = talkFrom.get(Number(r.tags.stage));
        if (!g && r.tags.stage && from?.size === 1 && rows[pl.line - 1] !== undefined) {
          const f = [...from][0]!;
          rows[pl.line - 1] = `${rows[pl.line - 1]!.trimEnd()} [if stage ${f}]`;
          changes.push(`“${pl.text}” in “${c.title}” is offered only at stage ${f}`);
        }
        for (const ch of r.choices) visit(ch, g || (!g && !!r.tags.stage && from?.size === 1));
      }
    };
    for (const t of parseScreenplay(before).topics) visit(t, false);
    if (rows.join('\n') !== before) c.screenplay = rows.join('\n');
  }
  // Extras that don't say what they need (an event with nothing to act on, an animation by nobody, a reward of an
  // item that isn't in the plan) would stop the build: they're left out, with a note.
  const stageSet = new Set(list(p.stages).map((x) => x.index).filter((x): x is number => typeof x === 'number'));
  const keyOf = (kind: Obj[]) => new Set(kind.map((x) => x.key).filter((x): x is string => typeof x === 'string'));
  const charKeys = keyOf(list(p.characters));
  const itemKeys = keyOf(list(p.items));
  const blank = (v: unknown) => typeof v !== 'string' || !v.trim();
  const NEEDS_TARGET = ['hostile', 'friendly', 'unlock', 'lock', 'show', 'hide', 'moveTo', 'kill'];
  const NEEDS_WHAT = ['spawn', 'sound', 'weather', 'message', 'startQuest'];
  if (Array.isArray(p.events)) {
    const ok = list(p.events).filter(
      (e) => stageSet.has(e.atStage as number) && !(NEEDS_TARGET.includes(e.kind as string) && blank(e.targetKey)) && !(NEEDS_WHAT.includes(e.kind as string) && blank(e.what)) && !((e.kind === 'moveTo' || e.kind === 'movePlayer') && blank(e.toKey)),
    );
    for (const e of list(p.events).filter((x) => !ok.includes(x))) changes.push(`left out the event “${(e.note as string) || (e.kind as string)}” (it doesn't say what it acts on, or its stage doesn't exist)`);
    p.events = ok;
  }
  if (Array.isArray(p.animations)) {
    const ok = list(p.animations).filter((a) => stageSet.has(a.atStage as number) && charKeys.has(a.characterKey as string));
    if (ok.length < list(p.animations).length) changes.push(`left out ${list(p.animations).length - ok.length} animation(s) by nobody in the plan, or at a stage that doesn't exist`);
    p.animations = ok;
  }
  for (const r of list(p.rewards)) if (typeof r.itemKey === 'string' && !itemKeys.has(r.itemKey)) (changes.push(`a reward of “${r.itemKey}”, which isn't an item in the plan, gives only its gold`), (r.itemKey = null));
  // A failure has to set a stage that fails the quest (one that completes it would hand out the reward instead).
  for (const f of list(p.failures)) {
    const st = list(p.stages).find((x) => x.index === f.failStage);
    if (st && st.failsQuest === true) continue;
    if (st && st.completesQuest !== true) {
      st.failsQuest = true;
      continue;
    }
    const index = Math.max(0, ...stageSet) + 100 - ((Math.max(0, ...stageSet) + 100) % 100);
    stageSet.add(index);
    (p.stages as Obj[]).push({ index, journal: f.kind === 'timeLimit' ? 'I took too long, and it was too late to finish what I was asked to do.' : 'Someone I needed is dead, and I can no longer finish what I was asked to do.', startsQuest: false, completesQuest: false, failsQuest: true });
    changes.push(`“${(f.note as string) || 'a failure'}” sets the new stage ${index}, which fails the quest${st ? ` (stage ${f.failStage} completes it)` : ''}`);
    f.failStage = index;
  }
  // An item a character holds that the player must hand on ([takes …] / [if has …] elsewhere), with no line where
  // the holder gives it: they hand it over on their first line that moves the quest on (taking the job).
  const convs = list(p.conversations).filter((c) => typeof c.screenplay === 'string');
  const all = convs.map((c) => c.screenplay as string).join('\n');
  const tagRe = (verbs: string, key: string) => new RegExp(`\\[(?:${verbs})\\s+${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s*[x×]\\s*\\d+)?\\]`, 'i');
  for (const i of list(p.items)) {
    if (i.startsWith !== 'character' || typeof i.key !== 'string' || typeof i.startsAtKey !== 'string') continue;
    if (!tagRe('takes|if\\s+has', i.key).test(all) || tagRe('gives', i.key).test(all)) continue;
    if (list(p.steps).some((st) => st.kind === 'pickup' && st.targetKey === i.key)) continue;
    const holder = list(p.characters).find((c) => c.key === i.startsAtKey);
    if (!holder) continue;
    const names = new Set([holder.key, holder.name].filter((n): n is string => typeof n === 'string').map((n) => n.toLowerCase()));
    // The holder's answer on the earliest exchange that moves the quest on (taking the job), not one that takes the item.
    let best: { conv: Obj; line: number; stage: number } | undefined;
    for (const c of convs) {
      const visit = (pl: ScriptPlayerLine) => {
        for (const r of pl.responses) {
          const stage = Number(r.tags.stage || pl.tags.stage);
          if (names.has(r.speaker.toLowerCase()) && Number.isFinite(stage) && !('takes' in r.tags) && (!best || stage < best.stage)) best = { conv: c, line: r.line, stage };
          for (const ch of r.choices) visit(ch);
        }
      };
      for (const t of parseScreenplay(c.screenplay as string).topics) visit(t);
    }
    if (!best) continue;
    const rows = (best.conv.screenplay as string).split(/\r?\n/);
    rows[best.line - 1] = `${rows[best.line - 1]!.trimEnd()} [gives ${i.key} x1]`;
    best.conv.screenplay = rows.join('\n');
    changes.push(`${holder.name as string} hands over ${(i.name as string) || i.key} when the job is taken (${best.conv.title as string})`);
  }
  // A completing stage nothing reaches, after a stage that leads nowhere ("delivered" at 30, "completes" at 100): the quest
  // goes straight on from that stage to the end.
  if (Array.isArray(p.stages) && Array.isArray(p.steps) && Array.isArray(p.conversations)) {
    const plan = p as unknown as QuestPlan;
    const said = stagesSaid(plan);
    const reached = new Set<number>([...said, ...plan.steps.map((st) => st.to), ...(plan.failures ?? []).map((f) => f.failStage)]);
    const stagesOf = plan.stages.filter((x) => typeof x.index === 'number');
    const start = (stagesOf.find((x) => x.startsQuest) ?? [...stagesOf].sort((a, b) => a.index - b.index)[0])?.index;
    const ends = stagesOf.filter((x) => x.completesQuest && !reached.has(x.index) && x.index !== start);
    const gatedAt = (stage: number) => plan.conversations.some((c) => new RegExp(`\\[if\\s+(?:stage\\s*)?(?:==?\\s*)?${stage}\\][^\\n]*(?:\\n\\s+[^\\n]*)*\\[stage\\s+\\d+\\]`, 'i').test(c.screenplay));
    const deadEnds = stagesOf.filter((x) => !x.completesQuest && !x.failsQuest && (reached.has(x.index) || x.index === start) && !plan.steps.some((st) => st.from === x.index) && !gatedAt(x.index));
    if (ends.length === 1 && deadEnds.length === 1 && deadEnds[0]!.index < ends[0]!.index) {
      plan.steps.push({ from: deadEnds[0]!.index, to: ends[0]!.index, kind: 'script', targetKey: null, note: 'Goes straight on to the end' });
      changes.push(`stage ${deadEnds[0]!.index} led nowhere and nothing reached stage ${ends[0]!.index}, which completes the quest: it now goes straight on from ${deadEnds[0]!.index} to ${ends[0]!.index}`);
    }
  }
  // "Fails if kept three days" written as a step that fails the quest right away, where a failure already does it.
  const failed = new Set(list(p.failures).map((f) => f.failStage));
  const steps = list(p.steps);
  const kept = steps.filter((st) => !(st.kind === 'script' && failed.has(st.to)));
  if (kept.length < steps.length) {
    p.steps = kept;
    changes.push(`left out ${steps.length - kept.length} step(s) that would fail the quest right away (its failures already do that)`);
  }
  const stages = list(p.stages).filter((s) => typeof s.index === 'number');
  if (stages.length && !stages.some((s) => s.startsQuest === true)) {
    const first = stages.reduce((a, b) => ((b.index as number) < (a.index as number) ? b : a));
    first.startsQuest = true;
    changes.push(`stage ${first.index} starts the quest`);
  }
  return changes;
}

/** Words that show the author asked to change this about a character who's already in the game. */
const ASKED: { field: keyof PlanCharacter; words: RegExp; what: string }[] = [
  { field: 'sex', words: /\b(sex|gender)\b/i, what: 'sex' },
  { field: 'race', words: /\b(race|nord|imperial|breton|redguard|elf|elven|orc|argonian|khajiit)\b/i, what: 'race' },
  { field: 'voice', words: /\bvoice/i, what: 'voice' },
  { field: 'essential', words: /\b(essential|immortal|protected|unkillable|killable|mortal|can'?t die|cannot die|can'?t be killed|can be killed)\b/i, what: 'whether they can die' },
  { field: 'className', words: /\bclass\b/i, what: 'class' },
  { field: 'level', words: /\blevel/i, what: 'level' },
  { field: 'outfit', words: /\b(wear\w*|dress\w*|cloth\w*|outfit|armou?r|robes?)\b/i, what: 'clothes' },
  { field: 'inventory', words: /\b(carr\w+|holds?|inventory|pocket\w*)\b/i, what: 'what they carry' },
  { field: 'factions', words: /\b(factions?|members?|joins?|guild|belongs?|ranks?)\b/i, what: 'factions' },
  { field: 'combat', words: /\b(fight\w*|attack\w*|hostile|combat|skills?|spells?|perks?|archer|mage|warrior)\b/i, what: 'how they fight' },
  { field: 'roles', words: /\b(follower|companion|marr\w+|merchant|sells?|shop\w*|trainer|trains?|teach\w*|innkeeper|rents?)\b/i, what: 'roles' },
  { field: 'relationships', words: /\b(friends?|enem(y|ies)|rivals?|lovers?|ally|allies|hates?|loves?|relationships?|likes?|dislikes?)\b/i, what: 'relationships' },
  { field: 'look', words: /\b(hair|beard|eyes?|scar\w*|tall|thin|fat|heavy|muscular|looks?|appearance|face|bald)\b/i, what: 'look' },
  { field: 'routine', words: /\b(routine|schedule|sleeps?|eats?|works? (at|in)|spends?|wanders?|patrols?)\b/i, what: 'daily routine' },
];

/**
 * A free AI tends to fill in every field of a character who's already in the game (copying what the load-order list
 * says about them), which would override them in the author's plugin. Changes the author's text doesn't ask for are
 * taken out: a field is kept only when the text talks about that kind of thing. Quest behaviour on stages (follow,
 * walk up and speak, anything from or until a stage) is kept: it lives on the quest. Returns who was left as they are.
 */
export function keepAskedChanges(plan: QuestPlan, text: string): string[] {
  const out: string[] = [];
  for (const c of plan.characters ?? []) {
    if (!c.existing) continue;
    const left: string[] = [];
    for (const a of ASKED) {
      const v = c[a.field];
      const set = Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined;
      if (!set || a.words.test(text)) continue;
      if (a.field === 'routine') {
        const quest = c.routine.filter((r) => r.fromStage !== null || r.untilStage !== null || r.activity === 'follow' || r.activity === 'forcegreet');
        if (quest.length === c.routine.length) continue;
        c.routine = quest;
      } else (c as Record<string, unknown>)[a.field] = Array.isArray(v) ? [] : null;
      left.push(a.what);
    }
    if (left.length) out.push(c.name);
  }
  const note = 'Left as they are in the game, since the text doesn\'t ask to change them: ';
  if (out.length) plan.assumptions = [...(plan.assumptions ?? []).filter((a) => !a.startsWith(note)), `${note}${out.join(', ')}`];
  return out;
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

/**
 * The stages lines of dialogue move the quest to. A line only offered at the stage it sets ("[if stage 20] … [stage 20]")
 * moves nothing, so it doesn't count.
 */
export function stagesSaid(plan: QuestPlan): Set<number> {
  const out = new Set<number>();
  const only = (v: string | undefined) => {
    for (const part of (v ?? '').split(';')) {
      const m = /^\s*(?:stage\s*)?(?:==?\s*)?(-?\d+)\s*$/i.exec(part);
      if (m) return Number(m[1]);
    }
    return undefined;
  };
  for (const c of plan.conversations ?? []) {
    const parsed = parseScreenplay(c.screenplay);
    const visit = (pl: ScriptPlayerLine, gate: number | undefined) => {
      const g = only(pl.tags.if) ?? gate;
      for (const r of pl.responses) {
        const rg = only(r.tags.if) ?? g;
        for (const v of [r.tags.stage, pl.tags.stage]) if (v && Number.isFinite(Number(v)) && Number(v) !== rg) out.add(Number(v));
        for (const ch of r.choices) visit(ch, rg);
      }
    };
    for (const t of parsed.topics) visit(t, undefined);
    // Greetings, chatter and scenes can set stages too.
    for (const b of parsed.blocks) for (const l of b.lines) if (l.tags.stage && Number.isFinite(Number(l.tags.stage)) && Number(l.tags.stage) !== (only(l.tags.if) ?? only(b.tags.if))) out.add(Number(l.tags.stage));
  }
  return out;
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
    if (r.skill && skillIndex(r.skill.skill) < 0) err(`A reward trains “${r.skill.skill}”, which isn't a skill (try Archery, One-handed, Speech, Destruction…)`);
    if (r.skill && !(r.skill.levels >= 1 && r.skill.levels <= 10)) err(`A reward trains ${r.skill.skill} by ${r.skill.levels} levels; use 1 to 10`);
  }
  // Every stage after the first must be reachable: a step, a line of dialogue or a failure sets it. A talk step
  // only says a line does it; without that line's [stage N] nothing does.
  const said = stagesSaid(plan);
  const reached = new Set<number>([...said, ...(plan.steps ?? []).filter((st) => st.kind !== 'talk').map((st) => st.to), ...(plan.failures ?? []).map((f) => f.failStage)]);
  const ordered = [...(plan.stages ?? [])].sort((a, b) => a.index - b.index);
  const startIndex = (ordered.find((x) => x.startsQuest) ?? ordered[0])?.index;
  for (const st of ordered.slice(1)) {
    if (st.startsQuest || reached.has(st.index)) continue;
    const talk = (plan.steps ?? []).find((x) => x.kind === 'talk' && x.to === st.index);
    warn(
      talk
        ? `Nothing moves the quest to stage ${st.index}: “${talk.note || 'talk'}” happens in a conversation, but no line has [stage ${st.index}]. Add [stage ${st.index}] to the line that does it`
        : `Nothing moves the quest to stage ${st.index}: add a step, or a [stage ${st.index}] tag on a line of dialogue`,
    );
  }
  // A line that sets a stage the plan reaches by something the player does (killing, picking up, arriving…)
  // lets them talk their way past it, unless the plan also says talking does it.
  for (const st of plan.steps ?? []) {
    if (st.kind === 'talk' || !said.has(st.to) || (plan.steps ?? []).some((x) => x.kind === 'talk' && x.to === st.to)) continue;
    const c = (plan.conversations ?? []).find((x) => new RegExp(`\\[stage\\s+${st.to}\\]`, 'i').test(x.screenplay));
    warn(`A line in “${c?.title ?? 'a conversation'}” sets stage ${st.to}, which “${st.note || st.kind}” is meant to reach, so the player can skip it by talking. Take out that [stage ${st.to}], or add a talk step if saying it should count`);
  }
  for (const st of plan.steps ?? [])
    if (st.kind === 'script' && st.from !== null && (plan.stages ?? []).find((x) => x.index === st.to)?.failsQuest)
      warn(`“${st.note || 'A step'}” fails the quest as soon as stage ${st.from} is reached (a “right away” step into a failing stage). Use a failure instead (a time limit, or someone dying)`);
  // A line that moves the quest further on, offered whenever the player talks to them (no [if …] on it or on the
  // answer), lets them skip ahead: "I'll take the gold. [stage 40]" chosen before the amulet is found.
  const opening = new Set((plan.steps ?? []).filter((x) => x.kind === 'talk' && (x.from === null || x.from === startIndex)).map((x) => x.to));
  for (const c of plan.conversations ?? []) {
    const visit = (p: ScriptPlayerLine, gated: boolean) => {
      const own = gated || 'if' in p.tags;
      for (const r of p.responses) {
        const g = own || 'if' in r.tags;
        const sets = Number(r.tags.stage);
        if (!g && Number.isFinite(sets) && r.tags.stage !== '' && !opening.has(sets) && stages.has(sets))
          warn(`“${p.text}” (${c.title}) moves the quest to stage ${sets} whenever it's chosen, even before the quest gets there, so the player can skip ahead. Add [if stage N] for the stage it belongs to`);
        for (const ch of r.choices) visit(ch, g);
      }
    };
    for (const t of parseScreenplay(c.screenplay).topics) visit(t, false);
  }
  // A quest running from the start shows its first journal entry before the player has met anyone.
  const first = ordered.find((x) => x.startsQuest) ?? ordered[0];
  if (plan.startsWithGame && first?.journal.trim() && !first.completesQuest)
    warn(`The quest starts with the game, so stage ${first.index}'s journal entry shows in the journal from the very start, before the player has met anyone. Leave it empty and write the entry on the stage where the quest is given`);
  // Items the player has to have ([takes …], [if has …]) must reach them somehow.
  const lines = (plan.conversations ?? []).map((c) => c.screenplay).join('\n');
  const tagged = (verbs: string, i: PlanItem, text = lines) => [i.key, i.name].some((n) => n && new RegExp(`\\[(?:${verbs})\\s+${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s*[x×]\\s*\\d+)?\\]`, 'i').test(text));
  // Something a character carries reaches the player when they hand it over or die (looted from their body).
  const released = (i: PlanItem) => {
    if (i.startsWith !== 'character') return true;
    const c = (plan.characters ?? []).find((x) => x.key === i.startsAtKey);
    if (!c) return true;
    const who = new RegExp(`^\\s*(${[c.key, c.name].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*:`, 'i');
    const hands = lines.split('\n').some((l) => who.test(l) && tagged('gives', i, l));
    const dies = (plan.steps ?? []).some((st) => st.kind === 'death' && st.targetKey === c.key) || (plan.events ?? []).some((e) => (e.kind === 'kill' || e.kind === 'hostile') && e.targetKey === c.key) || !!c.combat?.hostile;
    return hands || dies;
  };
  for (const i of plan.items ?? [])
    if ((plan.steps ?? []).some((st) => st.kind === 'pickup' && st.targetKey === i.key) && !released(i)) {
      const c = (plan.characters ?? []).find((x) => x.key === i.startsAtKey)!;
      warn(`The player has to pick up ${i.name}, but ${c.name} carries it and never hands it over or dies: put it on the character it should be taken from (one who fights or dies), somewhere to pick up, or have ${c.name} hand it over with [gives ${i.key} x1]`);
    }
  for (const i of plan.items ?? []) {
    if (i.kind === 'gold' || !tagged('takes|if\\s+has', i)) continue;
    const gets =
      i.startsWith === 'player' ||
      i.startsWith === 'location' ||
      tagged('gives', i) ||
      (plan.rewards ?? []).some((r) => r.itemKey === i.key) ||
      ((plan.steps ?? []).some((st) => st.kind === 'pickup' && st.targetKey === i.key) && released(i));
    if (!gets)
      warn(
        `The player needs ${i.name} ([takes ${i.key}] or [if has ${i.key}]) but never gets it: put it somewhere to pick up (startsWith "location" and a pickup step), have its owner hand it over with [gives ${i.key} x1], or give it as a reward`,
      );
  }
  // A quest item taken on a line that doesn't move the quest on is gone for the rest of the quest.
  for (const c of plan.conversations ?? [])
    for (const [n, line] of c.screenplay.split(/\r?\n/).entries()) {
      if (/\[stage\s+-?\d+\]/i.test(line)) continue;
      const speaker = /^\s*([^:[\]]+?)\s*:/.exec(line)?.[1]?.toLowerCase();
      const who = (plan.characters ?? []).find((x) => x.key.toLowerCase() === speaker || x.name.toLowerCase() === speaker)?.name ?? speaker ?? 'someone';
      for (const i of plan.items ?? [])
        if (i.kind !== 'gold' && tagged('takes', i, line))
          warn(`The player loses ${i.name} when ${who} takes it (${c.title}, line ${n + 1}) on a line that doesn't move the quest on, so they won't have it for the rest of the quest. Add the [stage N] that line leads to, or take out [takes ${i.key}]`);
    }
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
