/**
 * The AI quest planner: Claude reads a design document (or just a
 * conversation) and writes a quest plan (questplan.ts) for the builder.
 *
 * The author never has to add tags or structure: Claude works out the
 * characters, places, items, stages, journal, objectives, what moves the
 * quest on and the dialogue, and lists every decision it made on its own so
 * the author can check them before anything is built. A plan can be revised
 * by describing the change ("make Brynja the thief instead").
 *
 * The text is sent to Anthropic's API with the author's own API key, or to
 * a free alternative the author picks (Ollama on their own computer, or an
 * OpenAI-style service): see aiproviders.ts.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { WorkspaceError, type Workspace } from './engine';
import type { FormKey } from '@tes5/esp';
import { GESTURES } from './gestures';
import { z } from 'zod';
import type { JournalContext, JournalDraft } from './journal';
import { PLAN_EVENT_KINDS, QuestPlanSchema, doubledRewards, keepAskedChanges, reportStages, talkThenDeed, normalizePlan, repairPlan, stagesSaid, validatePlan, type PlanIssue, type QuestPlan } from './questplan';
import { lintScreenplay } from './dialoguelint';
import { aiName, chatSend, type AiProvider } from './aiproviders';
import { WorldService } from './world';
import { pickPlanExample } from './demo/example-plan';
import { applyAnnotation, blocksFor, describeBlocks, directionTags, findDialogue, readableIf, similarity, writtenScreenplay, type DialogueAnnotation, type WrittenBlock } from './written';

export const PLANNER_MODEL = 'claude-opus-5-5';

export type PlannerMode = 'document' | 'conversation';

/** What the planner needs back from the API (the subset of a message it reads). */
export interface PlannerReply {
  content: { type: string; text?: string }[];
  stop_reason: string | null;
}

/** Sends one request. The default streams it through the Anthropic SDK; tests pass their own. */
export type PlannerSend = (params: BetaMessageStreamParams, signal?: AbortSignal) => Promise<PlannerReply>;

const RULES = `You turn a Skyrim mod author's writing into a quest plan that a tool builds into a working quest (records, scripts, dialogue). Return only the plan, in the given JSON format.

How to plan:
- Read everything the author wrote. Keep their names, lines and intent. Where they leave something out, decide it the way an experienced Skyrim quest designer would, and record each such decision in "assumptions" in one short sentence. Put real choices only the author can make in "questions" (at most five), and still make a sensible choice for each in the plan.
- Prefer characters, places and items that already exist in the load order (listed below) when the author names them or clearly means them; set "existing" to their Editor ID. Otherwise set "existing" to null and a new one is created.
- Keys are short lowercase identifiers ("brynja", "cellar", "ring") used to refer to entries inside the plan. Every key is unique across characters, locations and items.
- A new place (existing null) is a new interior. Set layoutLike to the Editor ID of an interior from the list below that fits it (an inn for an inn, a house for a home, a cave or ruin for a hideout): its rooms, furniture, lights and clutter are copied, so it's ready to use. Set doorFrom to where the player walks in from (a location key, an existing interior, or one of the outdoor places listed, e.g. a farm's exterior for a new farmhouse), and a linked door is added there.
- Outdoors: when the text puts someone or something outside (a camp, a road, by a river, standing stones, a ruin's entrance), add a location with existing set to one of the outdoor places listed below (an outdoor cell's Editor ID) and say where in it with spot ("by the campfire", "by the Warrior Stone"). Characters, enemy groups and items can all be outdoors, and an arrive step on that location means the player comes near them.
- New characters need a location to stand in (a location key); characters that already exist stay where they are (locationKey null).
- Characters can be changed as well as used. When the author says a character (new or existing) wears something, carries something, belongs to a group, has a class or level, can or can't die, or looks a certain way, put it in outfit, inventory, factions, className, level, essential and look. For existing characters, only fill in what the text asks to change and leave the rest null or empty. "Save it as an outfit" means outfit.saveAs gets an Editor ID.
- Describe every new character's look (build, height, hair, hair colour, facial hair, eyes, scars) from the text, choosing what fits their role when the text says nothing; for a new character that is "like" someone existing, set basedOn.
- Clothing, armour and weapons in an outfit or inventory are existing items named as in the load order (e.g. "Fine Clothes", "Iron Sword"). Only add new clothing or weapons to "items" (kind clothing/armor/weapon, basedOn the closest existing item) when the text describes something unique.
- Say where in a place characters stand and items lie when the text does or it matters ("behind the bar", "by the forge", "in the chest by the bed", "under the table"): characters.spot and items.spot. An item "in" a container is put inside it and can still be picked up for a quest step.
- Fighting: for characters who fight, fill combat: hostile true for anyone who attacks the player on sight (bandits, a villain), levelScaled so they stay a match for the player, skills (e.g. One-handed 60), spells and perks by name, and a combat style ("Archer", "Mage"). Groups of ordinary enemies (bandits in a cave, draugr in a tomb, wolves) are encounters, not characters: what (an enemy type from the load order, preferably a levelled "Lvl…" one), how many and where. A step of kind "clear" with the encounter key moves the quest on when they're all dead.
- Roles: roles.follower for someone who can join the player, roles.marriage for someone the player can marry, roles.merchant (what they sell, opening hours) for shopkeepers, roles.trainer (skill and the highest level they teach: 50, 75 or 90) for trainers, roles.innkeeper for innkeepers. relationships say how characters feel about each other or the player (friend, ally, rival, enemy, lover…).
- Give characters a routine when the text says what they do or when it matters for the quest: new characters usually "sandbox" (go about their business) where they live by day and "sleep" there at night. Quest behaviour uses fromStage/untilStage: "follow" (the player) for companions or escorts, "forcegreet" (walk up to the player and say a line) for someone who should approach the player, "travel" to move someone to a place, "stay" to keep them put.
- If the text only asks to create or change characters, places or items and describes no quest, leave stages, objectives, steps, conversations, rewards, animations and events empty; nothing but those changes is built.
- Stages: start at 0 or 10, go up in steps of 10, and end on a stage that completes the quest (often 100 or 200). One stage has startsQuest true. Every stage after the first must be reachable: a step or a conversation line sets it.
- Journal entries are written in the past tense from the player's point of view, like Skyrim's ("Brynja asked me to find her stolen ring."). Write one for every stage the player should notice; the final stage gets a closing entry.
- Objectives are short instructions ("Find Brynja's ring", "Return the ring to Brynja"). Show each at the stage where it starts and complete it at the stage where it's done. Point the marker (targetKey) at the character, item or location involved.
- Steps say what moves the quest from one stage to the next: talk (a line in a conversation, see below), pickup/read/equip/drop/activate (an item key), death/activate (a character key), arrive (a location key), or script (immediately after the "from" stage).
- Items the player must pick up, read or activate must start in a location (startsWith "location"), so the game can tell when it happens. Items handed over in dialogue use the [gives …] and [takes …] tags instead. An item a character carries that the player can take from them (pickpocket, loot) starts with that character and a pickup step still works.
- A book, note, letter or notice gets what it says in "text", copied word for word from the author. Several of one thing ("three torn pages") is one item with copies 3 and one spot per copy separated by ";", and a pickup step with count 3. Something inside a locked container (a strongbox) names the key that opens it in lockedWith.
- "Come back tomorrow" or "a day later" is a wait step (hours 24) from the stage where it's said.
- Rewards are gold, items and/or training in a skill (skill and how many levels, e.g. someone teaching the player Archery) given at a stage (usually the final one).
- Endings: when the player's choices lead to different outcomes, give each outcome its own stage with completesQuest true, its own closing journal entry and its own rewards; the conversation line that decides it sets that stage.
- Failure: when the quest can be lost, add a stage with failsQuest true and a journal entry saying what went wrong, and add a failure: "death" if it fails when a character dies (targetKey), "timeLimit" if it must be done within some in-game days (days, fromStage where the clock starts). At most one time limit.
- Events are what happens in the world when a stage is reached, outside dialogue: enemies appear (spawn, with an enemy type like "bandit" or "draugr" and how many), a character turns on the player or calms down (hostile / friendly), a door or chest unlocks or locks, something appears or vanishes (show / hide; shown things start hidden), someone moves somewhere (moveTo), someone dies (kill), the screen fades to black and back (fade, e.g. for time passing or being knocked out; moves at the same stage happen in the dark), a sound plays, the weather changes, a message shows, another quest starts (startQuest, for questlines), or the player is moved (movePlayer). Add one wherever the text says something happens ("bandits ambush you", "the door unlocks", "he draws his sword"). Pair a hostile character or spawned enemies with a death step when killing them moves the quest on. For an ambush the quest waits on, add an encounter and a show event on its key at the stage the enemies appear (they stay hidden until then), and a clear step for killing them all.
- Set startsWithGame true when the quest begins by talking to someone (their opening dialogue only appears while the quest runs).
- When the quest begins some other way, set startsWithGame false and say what starts it in startsWhen: the player entering a place ("arrive", a location key), reading a note or book ("read", an item key; the item must start in a location), picking something up ("pickup"), using something ("activate"), or another quest reaching a stage ("afterQuest", that quest's Editor ID, and the stage or null for its end). Use afterQuest for questlines: part two starts when part one ends. A quest that begins with talking to someone keeps startsWithGame true and startsWhen null.

Conversations are written in this screenplay format. Each top-level PLAYER line is something the player can say; NPC lines under it are the answers; indent player choices under the NPC line they answer, and that NPC's answers under them:

PLAYER: Got any work?
BRYNJA: Someone stole my ring. Find it and I'll pay you. [if stage 0]
  PLAYER: I'll find it. [stage 10]
    BRYNJA: Thank you. Check the cellar first. [goodbye]
  PLAYER: Not now.
    BRYNJA: Suit yourself. [goodbye]
PLAYER: I found your ring. [if stage 20]
BRYNJA: My ring! Here, take this. [takes ring x1] [gives gold x100] [stage 100] [goodbye]

Speaker names are character keys in capitals (BRYNJA for the key "brynja"); the player is PLAYER.
Tags at the end of a line: [stage N] sets stage N once the line is said; [if stage N] only offers the line at stage N; [goodbye] ends the conversation; [emotion happy|sad|angry|fear|surprise|disgust|puzzled] sets the delivery; [gives KEY xN] / [takes KEY xN] move an item between the speaker and the player (KEY is an item key, or gold); [gesture NAME] makes the speaker play an animation as they say the line; [skill NAME xN] trains the player's skill by N levels (e.g. [skill Archery x1] when someone teaches the player); [attacks] makes the speaker attack the player when the line ends; [leaves] makes the speaker leave for good (a bribed guard walking away).
Gestures: ${GESTURES.map((g) => `${g.id} (${g.label.toLowerCase()})`).join(', ')}. Use them where a stage direction or the action calls for one (a wave in greeting, pointing the way, laughing, applause); don't put one on every line. For a character reacting when the quest reaches a stage outside dialogue, add it to "animations".
Choices the quest remembers: [remember NAME] on a line stores a choice (e.g. [remember spared] when the player spares someone), [forget NAME] clears it, and [if chose NAME] / [if not chose NAME] only offers a line when the choice was (not) made. Use them for later lines that react to what the player did. More tags: [once] says a line only once; [persuade N] on a player line makes the first answer under it the success of a Speech check (Speech N) and the next answer the failure. Conditions in plain words: [if stage N] (also >=, <), [if done N] (stage N has been reached), [if has KEY xN], [if gold N], [if speech N], [if level N], [if female], [if male], [if race Nord], [if night], [if day], [if time 20-4], [if quest EditorID done], [if quest EditorID done N] (another quest reached stage N); several [if] tags on one line must all be true. A choice remembered in an earlier quest of a questline can be checked later with [if chose NAME].
Lines nobody prompts go in blocks: "GREETING:" then NPC lines said when the player comes up to them (put [if …] on the GREETING: line to apply to all), "IDLE:" then things they say to themselves, and "SCENE: name [at stage N]" then lines characters say to each other in order (use [start] instead of [at stage N] to play it when the quest starts). Use greetings to make characters react to how the quest is going ("Any luck with the ring?").
Put [if stage N] on lines that only make sense at one point of the quest, so they don't show up at the wrong time. When a conversation moves the quest on, add a talk step with the same "to" stage.`;

/**
 * Read last by free AIs, after the author's text: the mistakes smaller models
 * make most, as a check to run before answering. Models weigh the end of a
 * prompt most, and a short list is easier to follow than the long rules.
 */
const CHECKLIST = `Before you answer, check the plan:
1. Keys, not names: every locationKey, startsAtKey, targetKey, characterKey, itemKey, toKey, doorFrom and routine "where" is a key from characters, locations, items or encounters ("brynja", not "Brynja"), or an Editor ID from the load order list.
2. "existing" is an Editor ID or name copied from the load order list, or null. Never make one up.
3. Stages: one has startsQuest true, at least one has completesQuest true, and every other stage is set by a step or by a [stage N] tag in a conversation.
4. Every stage number used anywhere (steps, objectives, rewards, events, animations, routines, failures, [stage N], [if stage N]) is in "stages".
5. Every [stage N] tag in a conversation has a talk step with "to": N, and that line (or the line it answers) has an [if stage …] tag, so it's only offered at the right point.
6. Conversation speakers are character keys in capitals (BRYNJA) or PLAYER. A top-level PLAYER line is followed by the answer; choices under an answer are indented by two spaces.
7. Items the player picks up or reads have startsWith "location" and a location key in startsAtKey. Items handed over in dialogue are carried by the speaker (startsWith "character").
8. Starting: talking to someone → startsWithGame true and startsWhen null; anything else → startsWithGame false and startsWhen filled in.
9. Every field is there. Use null or [] where nothing applies, numbers without quotes, true/false without quotes.`;

/** The checklist for a document whose conversations are written out: the dialogue points are about talk steps instead. */
const WRITTEN_CHECKLIST = CHECKLIST.replace(/\n5\. [^\n]*\n6\. [^\n]*/, '\n5. Each thing a written conversation does (taking the job, agreeing to go, an ending) is a talk step to the stage it moves the quest to, with a note naming who and what. "conversations" holds only lines the author didn\'t write out, or nothing.').replace(/\n7\./, '\n6.').replace(/\n8\./, '\n7.').replace(/\n9\./, '\n8.');

/** The plan's keys and stage numbers, to fix references against. */
function planIndex(plan: QuestPlan): string {
  const keys = (list: { key?: string }[] | undefined) => (list ?? []).map((e) => e.key).filter(Boolean).join(', ') || 'none';
  return [
    `Keys in the plan: characters ${keys(plan.characters)}; locations ${keys(plan.locations)}; items ${keys(plan.items)}; encounters ${keys(plan.encounters)}.`,
    `Stage numbers: ${(plan.stages ?? []).map((s) => s.index).join(', ') || 'none'}.`,
  ].join('\n');
}

const MODES: Record<PlannerMode, string> = {
  document: 'Here is the quest design document. Plan the whole quest it describes.',
  conversation:
    "Here is a conversation the author wrote. There are no tags in it: work out the quest it implies (who is involved, what the player has to do, where, and what happens at the end), plan that whole quest, and use the conversation in it. Keep the author's lines word for word, split them into the player's choices and the answers, add the [stage]/[if stage]/[goodbye] tags where they belong, and write the extra lines the quest needs (for example what is said when the player comes back).",
};

const STOPWORDS = new Set('the and for with that this from they them their there then than what when where which who will would into onto your you she her his him has have had was were are not but all any can out its our over under about after before again also just like more most some such only very been being does did done each find give gives take takes make makes said says player quest'.split(' '));

/** One word, plural or not: wolves → wolf, bandits → bandit, berries → berry. */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ves')) return `${w.slice(0, -3)}f`;
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  return w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
}

/** The words in a text, lower case, without short and common ones (and the singular of each plural). */
export function textWords(text: string): Set<string> {
  const words = (text.toLowerCase().match(/[a-z][a-z']{2,}/g) ?? []).map((w) => w.replace(/'s$/, '')).filter((w) => !STOPWORDS.has(w));
  return new Set(words.flatMap((w) => [w, stem(w)]));
}

/** "WhiterunBanneredMare" "The Bannered Mare" → whiterun, bannered, mare. */
function entryWords(...names: (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const n of names) for (const w of (n ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z]{3,}/g) ?? []) if (!STOPWORDS.has(w)) out.add(w);
  return [...out];
}

/** Editor IDs of things made for one dungeon, DLC, quest or test, or for creatures. */
const SPECIFIC = /^(dun|dlc\d|cc[A-Z]{3}|cc_|MQ\d|MS\d|DA\d|C0\d|CW|DB\d|TG\d|MG\d|BYOH|Test|AAA|Favor|WE\d|WI|Cr[A-Z]|.*Creature)|Vampire|Child|Unique/i;
/** The races players pick from: what most characters are. */
const PLAYABLE_RACE = /^(Nord|Imperial|Breton|Redguard|HighElf|DarkElf|WoodElf|Orc|Argonian|Khajiit)Race$/i;

/** 2 for a playable race or a man's or woman's voice, 1 for other everyday entries, 0 for specific ones. */
function everyday(editorId?: string): number {
  if (!editorId || SPECIFIC.test(editorId)) return 0;
  return PLAYABLE_RACE.test(editorId) || /^(Male|Female)[A-Z]/.test(editorId) ? 2 : 1;
}

/** How strongly an entry matches the text: its full name in the text counts most, then shared words. */
function relevance(text: string, words: Set<string>, name?: string, editorId?: string): number {
  let score = 0;
  for (const n of [name, editorId]) if (n && n.length > 2 && text.includes(n.toLowerCase())) score += 10;
  for (const w of entryWords(name, editorId)) if (words.has(w) || words.has(stem(w))) score += 1;
  return score;
}

/**
 * "A new farmer called Eirik" planned as an existing character with another name (WEDL14Farmer, "Farmer") the text
 * never mentions: the AI meant someone like them, so it becomes a new character copied from them rather than a
 * renamed one from the game. Returns what was changed, in words (also added to the plan's assumptions).
 */
export function newWhenRenamed(ws: Workspace, plan: QuestPlan, text: string): string[] {
  const out: string[] = [];
  for (const c of plan.characters ?? []) {
    if (!c.existing) continue;
    const want = c.existing.toLowerCase();
    const key = ws.byEditorId(c.existing) ?? ws.search({ sigs: ['NPC_'], query: c.existing, limit: 200 }).items.find((i) => i.name?.toLowerCase() === want)?.formKey;
    const npc = key ? ws.summary(key) : undefined;
    if (!npc || npc.sig !== 'NPC_') continue;
    // Kept when the names share a word, or the text names them (a unique character, by their full name, capitalised).
    const theirs = entryWords(npc.name, npc.editorId);
    const unique = ((ws.view(key!)?.data as { config?: { flags?: number } } | undefined)?.config?.flags ?? 0) & 0x20;
    const named = !!npc.name && new RegExp(`\\b${npc.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text); // as a name: "Hulda", not "a farmer"
    // …unless the character has a name of their own in the text ("Hesta Coldwater" planned as Gerda, whom the text
    // names as someone else).
    const ownName = /^[A-Z]/.test(c.name ?? '') && new RegExp(`\\b${(c.name ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text);
    if (entryWords(c.name).some((w) => theirs.includes(w)) || (unique && named && !ownName)) continue;
    out.push(`${c.name} is a new character, copied from ${npc.name ?? npc.editorId} (${npc.editorId ?? key})`);
    c.basedOn = c.existing;
    c.existing = null;
  }
  if (out.length) plan.assumptions = [...(plan.assumptions ?? []), ...out];
  return out;
}

/**
 * What planning does to the characters in an AI's plan before anyone sees it: new characters planned as renamed
 * existing ones become new, and (for a free AI) changes the text doesn't ask for to characters already in the game
 * are taken out. Both go in the plan's assumptions.
 */
export function settleCharacters(ws: Workspace, plan: QuestPlan, text: string, free: boolean): string[] {
  return [...newWhenRenamed(ws, plan, text), ...(free ? keepAskedChanges(plan, text).map((n) => `Left ${n} as they are`) : [])];
}

/**
 * A summary of the load order for the planner: characters, interiors, voice
 * types, races and more, so it can reuse what exists. With the author's text,
 * entries it mentions come first (characters with their race, sex, voice,
 * class and factions), so a short list still holds what the quest is about.
 */
export function planCatalog(ws: Workspace, opts: { limit?: number; text?: string; short?: number } = {}): string {
  const limit = opts.limit ?? 300;
  // Voice types, races, classes, factions, outfits and enemies: what the text mentions comes first, and the builder
  // matches loose names ("Nord", "bandit") itself, so a free AI that reads slowly can be given fewer of them.
  const short = opts.short ?? limit;
  const text = (opts.text ?? '').toLowerCase();
  const words = textWords(text);
  const label = (s: { editorId?: string; name?: string; formKey: string }) => (s.name && s.name !== s.editorId ? `${s.editorId ?? s.formKey} "${s.name}"` : (s.editorId ?? s.formKey));
  const nameOf = (key: unknown) => (typeof key === 'string' && key ? (ws.summary(key as FormKey)?.editorId ?? ws.summary(key as FormKey)?.name) : undefined);
  const details = (key: FormKey): string => {
    const d = (ws.view(key)?.data ?? {}) as Record<string, any>;
    const parts = [nameOf(d.race), ((d.config?.flags ?? 0) & 1) !== 0 ? 'female' : 'male', d.voice && `voice ${nameOf(d.voice)}`, d.class && `class ${nameOf(d.class)}`];
    const factions = ((d.factions ?? []) as { faction?: string }[]).map((f) => nameOf(f.faction)).filter(Boolean).slice(0, 4);
    if (factions.length) parts.push(`factions ${factions.join(', ')}`);
    return parts.filter(Boolean).join(', ');
  };
  // After what the text mentions and what's in your plugin: everyday entries before ones made for a creature, a dungeon,
  // a DLC or one quest, so a list that's cut short still has Nord, MaleNord and Citizen rather than atronachs.
  const rank = <T extends { name?: string; editorId?: string; inActive?: boolean }>(items: T[]): (T & { score: number })[] =>
    items
      .map((s) => ({ ...s, score: text ? relevance(text, words, s.name, s.editorId) : 0, everyday: everyday(s.editorId) }))
      .sort((a, b) => b.score - a.score || Number(b.inActive) - Number(a.inActive) || b.everyday - a.everyday);
  const list = (sigs: string[], filter: (name?: string, edid?: string) => boolean = (n) => !!n, detail = false, max = short) => {
    const items = rank(ws.search({ sigs, limit: 100_000 }).items.filter((s) => !s.deleted && filter(s.name, s.editorId)));
    const shown = items.slice(0, max).map((s) => (detail && s.score > 0 ? `${label(s)} (${details(s.formKey)})` : label(s)));
    return `${shown.join('\n') || '(none)'}${items.length > max ? `\n…and ${items.length - max} more` : ''}`;
  };
  const yours = ws
    .search({ sigs: ['QUST'], limit: 100_000 })
    .items.filter((s) => s.inActive && !s.deleted && s.editorId)
    .slice(0, limit)
    .map((s) => (s.name ? `${s.editorId} "${s.name}"` : s.editorId!));
  const world = new WorldService(ws);
  const all = world.cells();
  const cells = rank(all.filter((c) => c.interior && c.name))
    .slice(0, limit)
    .map((c) => `${c.editorId ?? c.formKey} "${c.name}"`);
  // Outdoor cells have no names, only Editor IDs (PelagiaFarmExterior, RiverwoodEdge01) and the place they belong to
  // ("Riverwood"): the ones the text is about, for people, enemies and items outside, and the outside door of a new
  // interior ("a farmhouse outside Whiterun").
  const placeName = (cell: FormKey) => {
    const loc = (ws.view(cell)?.data as { location?: FormKey } | undefined)?.location;
    return loc ? ws.summary(loc)?.name : undefined;
  };
  const outside = text
    ? rank(all.filter((c) => !c.interior && c.editorId && !/^test/i.test(c.editorId)).map((c) => ({ ...c, name: placeName(c.formKey) })))
        .filter((c) => c.score > 0)
        .slice(0, 24)
        .map((c) => (c.name && c.name.replace(/\s+/g, '') !== c.editorId ? `${c.editorId!} (${c.name})` : c.editorId!))
    : [];
  // Places on the world map the text names ("the Guardian Stones"): outdoors, found by their map marker.
  const lower = (text ?? '').toLowerCase();
  const marked = text ? [...new Set(world.mapMarkers().map((m) => m.name))].filter((n) => n.length > 3 && lower.includes(n.toLowerCase().replace(/^the\s+/, ''))).slice(0, 12) : [];
  if (marked.length) outside.push(...marked.map((n) => `"${n}" (a place on the map: give this name as existing)`));
  return [
    `Characters (Editor ID "Name"${text ? ', with details for the ones your text seems to mention' : ''}):\n${list(['NPC_'], undefined, true, limit)}`,
    `Interior locations:\n${cells.join('\n') || '(none)'}`,
    ...(outside.length ? [`Outdoor places (Editor IDs of outdoor cells, with the place they're part of: for a location outside, and for doorFrom, where a new interior's door goes):\n${outside.join('\n')}`] : []),
    `Voice types:\n${list(['VTYP'], (_, e) => !!e, false, limit)}`,
    `Races:\n${list(['RACE'])}`,
    `Classes:\n${list(['CLAS'])}`,
    `Factions:\n${list(['FACT'])}`,
    `Outfits:\n${list(['OTFT'], (_, e) => !!e)}`,
    `Enemies (levelled characters for encounters):\n${list(['NPC_'], (_, e) => !!e && /^lvl/i.test(e))}`,
    `Quests in your plugin (for questlines):\n${yours.join('\n') || '(none)'}`,
  ].join('\n\n');
}

export class QuestPlanner {
  private readonly send: PlannerSend;

  /** What to call the AI in messages. */
  readonly name: string;

  /** Told what the planner is doing, for a progress message ("tagging Hesta's lines"). */
  private readonly onStep?: (what: string) => void;

  /**
   * `signal`: Stop in the AI tab ends a plan that's still being written (with the built-in AI that can take minutes).
   * `onStep` hears what it's doing at each step.
   */
  constructor(opts: { apiKey?: string; ai?: AiProvider; send?: PlannerSend; model?: string; signal?: AbortSignal; onStep?: (what: string) => void } = {}) {
    this.onStep = opts.onStep;
    const ai: AiProvider | undefined = opts.ai ?? (opts.apiKey ? { kind: 'claude', apiKey: opts.apiKey } : undefined);
    this.name = aiName(ai);
    const signal = opts.signal;
    if (opts.send) {
      const send = opts.send;
      this.send = (params) => send(params, signal);
    } else if (ai?.kind === 'local') throw new WorkspaceError('The built-in AI has to be started first');
    else if (ai && ai.kind !== 'claude') {
      const send = chatSend(ai);
      this.send = (params) => send(params, signal);
    } else {
      if (ai?.kind === 'claude') opts = { ...opts, apiKey: ai.apiKey };
      if (!opts.apiKey) throw new WorkspaceError('Add your Anthropic API key, or pick a free AI, to plan quests');
      const client = new Anthropic({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true });
      this.send = async (params) => {
        try {
          return await client.beta.messages.stream(params, signal ? { signal } : undefined).finalMessage();
        } catch (e) {
          if (signal?.aborted) throw new WorkspaceError('Stopped.');
          if (e instanceof Anthropic.AuthenticationError) throw new WorkspaceError('Anthropic rejected the API key. Check it in Settings.');
          if (e instanceof Anthropic.RateLimitError) throw new WorkspaceError('Too many requests to Claude right now. Wait a minute and try again.');
          if (e instanceof Anthropic.APIConnectionError) throw new WorkspaceError("Couldn't reach Anthropic's API. Check your internet connection.");
          if (e instanceof Anthropic.APIError) throw new WorkspaceError(`Claude couldn't plan this: ${e.message}`);
          throw e;
        }
      };
    }
    this.model = opts.model ?? PLANNER_MODEL;
    this.free = !!ai && ai.kind !== 'claude';
  }

  private readonly model: string;

  /** A free AI (smaller models): they also get a worked example to copy. */
  private readonly free: boolean;

  /**
   * The request: the rules and the load order are cached; the author's text follows.
   * `text` (the author's writing) picks the worked example a free AI gets.
   */
  request(messages: BetaMessageStreamParams['messages'], catalog: string, text = ''): BetaMessageStreamParams {
    const example = this.free ? pickPlanExample(text) : undefined;
    return {
      model: this.model,
      max_tokens: 64000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: betaZodOutputFormat(QuestPlanSchema) },
      system: [
        { type: 'text', text: RULES },
        // Smaller models copy an example far better than they follow long rules.
        ...(example
          ? [
              {
                type: 'text' as const,
                text: `A worked example, for a different quest. Follow its shape and level of detail, not its story. Its Editor IDs are only examples: use the ones in the load order list below.\n\nWhat that author wrote:\n<example_source>\n${example.document}\n</example_source>\n\nThe plan made from it:\n${JSON.stringify(example.plan())}`,
              },
            ]
          : []),
        { type: 'text', text: `The load order (existing forms you can use):\n\n${catalog}`, cache_control: { type: 'ephemeral' } },
      ],
      messages,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    };
  }

  /**
   * Plan a quest from a design document or a conversation. `context` says what the quest is part of (a questline's
   * earlier quests, whose characters, places and choices it can use).
   */
  async plan(source: string, mode: PlannerMode, catalog: string, opts: { context?: string } = {}): Promise<QuestPlan> {
    if (!source.trim()) throw new WorkspaceError('Write or paste something to plan from');
    // Conversations the author wrote out are kept word for word: the AI plans around them and only adds their tags.
    const written = mode === 'document' ? findDialogue(source).blocks : [];
    if (written.length) return this.planWritten(source, catalog, written, opts.context ?? '');
    const params = this.request([{ role: 'user', content: `${MODES[mode]}${opts.context ? `\n\n${opts.context}` : ''}\n\n<source>\n${source.trim()}\n</source>${this.free ? `\n\n${CHECKLIST}` : ''}` }], catalog, source);
    const plan = await this.fixLogic(params, await this.run<QuestPlan>(params));
    // Smaller models write better in small pieces: each conversation, then the journal, gets its own request.
    return this.free ? this.polish(plan, source) : plan;
  }

  /**
   * A document with its conversations written out: the plan comes first (without them), then each character's
   * conversations go in word for word, with the tags the AI reads from the author's directions; what still leaves the
   * quest stuck gets one more round, and (free AIs) missing exchanges and journal entries are written.
   */
  private async planWritten(source: string, catalog: string, blocks: WrittenBlock[], context: string): Promise<QuestPlan> {
    // The conversations go in as an outline (choices and directions): the AI plans around them without copying them.
    const params = this.request([{ role: 'user', content: `${MODES.document}${context ? `\n\n${context}` : ''}\n\n<source>\n${findDialogue(source).prose.trim()}\n</source>\n\n${WRITTEN_NOTE}${this.free ? `\n\n${WRITTEN_CHECKLIST}` : ''}` }], catalog, source);
    this.onStep?.('planning the stages, characters and places');
    let plan = normalizePlan(await this.run<QuestPlan>(params));
    addSpeakers(plan, blocks, catalog);
    await this.addWrittenDialogue(plan, blocks, context);
    // Stages a talk step says a conversation reaches, that no line reaches yet: ask which lines do it.
    const unsaid = plan.steps.filter((st) => st.kind === 'talk' && !stagesSaid(plan).has(st.to));
    if (unsaid.length) await this.addWrittenDialogue(plan, blocks, context, unsaid);
    // Stages the plan ran together (talking, then doing; doing, then reporting back) and gold paid twice, now the lines are in.
    const mended = [...doubledRewards(plan), ...reportStages(plan), ...talkThenDeed(plan)];
    if (mended.length) plan.assumptions = [...(plan.assumptions ?? []), ...mended.map((x) => x[0]!.toUpperCase() + x.slice(1))];
    const blocking = blockingIssues(validatePlan(plan));
    if (blocking.length) this.onStep?.(`fixing what would leave the quest stuck (${blocking[0]!.message}${blocking.length > 1 ? `, and ${blocking.length - 1} more` : ''})`);
    plan = await this.fixLogic(params, plan, true);
    if (this.free) {
      this.onStep?.('filling gaps in the dialogue and journal');
      const brief = planBrief(plan, source);
      const stages = plan.stages.map((x) => x.index);
      const speakers = plan.characters.flatMap((c) => [c.key, c.name, ...(c.existing ? [c.existing] : [])]);
      await this.writeMissingLines(plan, brief, (text) => lintScreenplay(text, { stages, speakers }).filter((l) => l.severity === 'error').length);
      await this.writeJournal2(plan, brief);
    }
    return plan;
  }

  /**
   * The author's conversations into the plan, one character at a time: the AI says which tags go on which numbered
   * lines (never the words), the tags are checked against the plan, and the lines go in as a screenplay. Lines the AI
   * wrote itself that repeat the author's are taken out of its own conversations. With `stuck`, only those stages are
   * asked about (which lines move the quest there), on top of the tags already in.
   */
  async addWrittenDialogue(plan: QuestPlan, all: WrittenBlock[], context = '', stuck: QuestPlan['steps'] = []): Promise<void> {
    const speakers = [...new Set(all.map((b) => b.speaker.toLowerCase()))];
    const authorLines = all.flatMap((b) => b.lines.map((l) => l.text));
    const notes: string[] = [];
    const made: QuestPlan['conversations'] = [];
    for (const speaker of speakers) {
      const blocks = blocksFor(all, speaker);
      const who = characterFor(plan, speaker);
      const title = who?.name ?? blocks[0]!.speaker;
      // Only someone whose lines carry directions can be what moves the quest on.
      const focus = stuck.length && blocks.some((b) => b.lines.some((l) => l.notes.length)) ? stuck : [];
      if (stuck.length && !focus.length) continue;
      this.onStep?.(stuck.length ? `finding which of ${title}'s lines move the quest on` : `tagging ${title}'s lines (${blocks.reduce((n, b) => n + b.lines.length, 0)} of them)`);
      try {
        const a = await this.annotate(plan, blocks, context, focus);
        notes.push(...checkAnnotation(plan, a, title));
        applyAnnotation(blocks, a);
      } catch {
        notes.push(`The directions in ${title}'s conversations weren't turned into tags (the AI's answer didn't come back right): check what their lines do`);
      }
      // What the directions say outright, where the AI said nothing.
      const earlier = [...context.matchAll(/choices it remembers: ([^;]+);/g)].flatMap((m) => m[1]!.split(/,\s*/)).filter((c) => c && c !== 'none');
      notes.push(...directionTags(blocks, plan, earlier).map((t) => `From your direction: ${t}`));
      notes.push(...followDirections(plan, blocks).map((t) => `From your direction: ${t}`));
      made.push({ title, screenplay: writtenScreenplay(structuredClone(blocks)) });
    }
    if (stuck.length && !made.length) return;
    // The AI's own conversations keep only what the author didn't write.
    const own = plan.conversations.filter((c) => !c.title.startsWith('✎ ')).map((c) => ({ ...c, screenplay: withoutAuthorLines(c.screenplay, authorLines) })).filter((c) => c.screenplay.trim());
    const kept = stuck.length ? plan.conversations.filter((c) => c.title.startsWith('✎ ') && !made.some((m) => `✎ ${m.title}` === c.title)) : [];
    plan.conversations = [...kept, ...made.map((m) => ({ title: `✎ ${m.title}`, screenplay: m.screenplay })), ...own];
    const note = 'Kept word for word from your text: ';
    plan.assumptions = [...(plan.assumptions ?? []).filter((x) => !x.startsWith(note) && !notes.includes(x)), `${note}${authorLines.length} lines in ${made.length} conversation(s) (marked ✎)`, ...new Set(notes)];
  }

  /** The tags for one character's written conversations, as the AI reads the author's directions. */
  private async annotate(plan: QuestPlan, blocks: WrittenBlock[], context: string, stuck: QuestPlan['steps']): Promise<DialogueAnnotation> {
    const ask = stuck.length
      ? `Nothing moves the quest to ${stuck.map((st) => `stage ${st.to} (${st.note})`).join(', ')} yet. Which of these lines do it? Give just those lines, with [stage N].`
      : 'Give the tags for these blocks and lines.';
    return this.run(
      {
        model: this.model,
        max_tokens: 4000,
        output_config: { effort: 'medium', format: betaZodOutputFormat(AnnotationSchema) },
        system: [{ type: 'text', text: `${ANNOTATE_RULES}\n\n${TAG_REFERENCE}` }],
        messages: [{ role: 'user', content: `${annotateBrief(plan)}${context ? `\n${context}` : ''}\n\nThe author's dialogue:\n\n${describeBlocks(blocks)}\n\n${ask}` }],
      },
      AnnotationAnswer as unknown as z.ZodType<DialogueAnnotation>,
    );
  }

  /** For free AIs: journal entries and objectives for stages that have none (the author's own are kept). */
  private async writeJournal2(plan: QuestPlan, brief: string): Promise<void> {
    const empty = plan.stages.filter((st) => !st.journal.trim() && !st.startsQuest);
    if (!empty.length) return;
    try {
      const draft = await this.run(
        {
          model: this.model,
          max_tokens: 3000,
          output_config: { effort: 'medium', format: betaZodOutputFormat(JournalDraftSchema) },
          system: [{ type: 'text', text: JOURNAL_RULES }],
          messages: [{ role: 'user', content: `${brief}\n\nWrite the journal entry for stages ${empty.map((x) => x.index).join(', ')} only (the others are written). Objectives: return the ones listed, unchanged.\nObjectives now: ${JSON.stringify(plan.objectives.map((o) => ({ index: o.index, text: o.text, shownAtStage: o.shownAtStage, completedAtStage: o.completedAtStage })))}` }],
        },
        JournalDraftSchema,
      );
      for (const st of empty) {
        const j = draft.stages.find((d) => d.index === st.index)?.journal.trim();
        if (j) st.journal = j;
      }
    } catch {
      // Left empty; the review shows it.
    }
  }

  /**
   * One round of fixing what would break the quest (a stage nothing reaches,
   * a key that isn't in the plan…), with the problems listed. The better of
   * the two plans is kept, so a worse answer never replaces a good one.
   */
  private async fixLogic(params: BetaMessageStreamParams, plan: QuestPlan, keepConversations = false): Promise<QuestPlan> {
    const problems = blockingIssues(validatePlan(plan));
    if (!problems.length) return plan;
    // The author's conversations (✎) stay as they are: the AI sees and fixes the rest.
    const theirs = keepConversations ? plan.conversations.filter((c) => c.title.startsWith('✎ ')) : [];
    const shown = keepConversations ? { ...plan, conversations: plan.conversations.filter((c) => !theirs.includes(c)) } : plan;
    try {
      const fixed = await this.run<QuestPlan>({
        ...params,
        messages: [
          ...params.messages,
          { role: 'assistant', content: JSON.stringify(shown) },
          {
            role: 'user',
            content: `The plan has these problems, which would stop the quest working:\n${problems.map((p) => `- ${p.message}`).join('\n')}\n\n${planIndex(plan)}\n\n${theirs.length ? "The author's written conversations are kept separately and aren't shown; fix the rest. " : ''}Fix them, keep everything else as it is, and return the whole corrected plan.`,
          },
        ],
      });
      if (keepConversations) fixed.conversations = [...theirs, ...fixed.conversations.filter((c) => !c.title.startsWith('✎ '))];
      return blockingIssues(validatePlan(fixed)).length < problems.length ? fixed : plan;
    } catch {
      return plan;
    }
  }

  /**
   * For free AIs: rewrite each conversation, then the journal and objectives,
   * one small request at a time, with the plan as context. A rewrite is only
   * kept when it's at least as sound as the first draft (same stage changes,
   * no new mistakes), so this can only improve the plan.
   */
  async polish(input: QuestPlan, source = ''): Promise<QuestPlan> {
    const plan = structuredClone(input);
    const brief = planBrief(plan, source);
    const stages = plan.stages.map((s) => s.index);
    const speakers = plan.characters.flatMap((c) => [c.key, c.name, ...(c.existing ? [c.existing] : [])]);
    const errors = (text: string) => lintScreenplay(text, { stages, speakers }).filter((l) => l.severity === 'error').length;
    const stageTags = (text: string) => [...text.matchAll(/\[stage\s+(-?\d+)\]/gi)].map((m) => Number(m[1])).sort((a, b) => a - b).join(',');
    await this.writeMissingLines(plan, brief, errors);
    for (const conv of plan.conversations) {
      try {
        const out = await this.run(
          {
            model: this.model,
            max_tokens: 8000,
            output_config: { effort: 'high', format: betaZodOutputFormat(ScreenplaySchema) },
            system: [{ type: 'text', text: `${DIALOGUE_RULES}\n\n${STYLE}` }],
            messages: [
              {
                role: 'user',
                content: `${brief}\n\nHere is the conversation "${conv.title}" as drafted:\n\n${conv.screenplay}\n\nRewrite it so it reads like Skyrim's own dialogue. Keep every [stage N] tag (on the same choice), every [if …], [gives …], [takes …] and [goodbye] tag, and the speakers. Improve the wording, give the player sensible choices, and add a line or two for when the player comes back before the task is done. Return the whole conversation.`,
              },
            ],
          },
          ScreenplaySchema,
        );
        const text = out.screenplay.trim();
        if (text && stageTags(text) === stageTags(conv.screenplay) && errors(text) <= errors(conv.screenplay)) conv.screenplay = text;
      } catch {
        // Keep the draft.
      }
    }
    if (plan.stages.length) {
      try {
        const draft = await this.run(
          {
            model: this.model,
            max_tokens: 6000,
            output_config: { effort: 'high', format: betaZodOutputFormat(JournalDraftSchema) },
            system: [{ type: 'text', text: JOURNAL_RULES }],
            messages: [
              {
                role: 'user',
                content: `${brief}\n\nWrite the journal entry for each stage (by its number) and the text of each objective (by its number; keep the stages it's shown and completed at).\nObjectives now: ${JSON.stringify(plan.objectives.map((o) => ({ index: o.index, text: o.text, shownAtStage: o.shownAtStage, completedAtStage: o.completedAtStage })))}`,
              },
            ],
          },
          JournalDraftSchema,
        );
        for (const st of plan.stages) {
          const j = draft.stages.find((d) => d.index === st.index)?.journal.trim();
          if (j) st.journal = j;
        }
        for (const o of plan.objectives) {
          const t = draft.objectives.find((d) => d.index === o.index)?.text.trim();
          if (t) o.text = t;
        }
      } catch {
        // Keep the draft.
      }
    }
    return plan;
  }

  /**
   * Steps that happen in a conversation with no line that makes them happen ("the player gives Proventus the
   * sword", and nobody says anything that sets the stage): each gets one small request for just that exchange,
   * added to the speaker's conversation. Small models manage this where rewriting the whole plan fails.
   */
  private async writeMissingLines(plan: QuestPlan, brief: string, errors: (text: string) => number): Promise<void> {
    const keys = plan.characters.map((c) => c.key.toUpperCase()).join(', ');
    for (const st of plan.steps.filter((x) => x.kind === 'talk')) {
      const tag = new RegExp(`\\[stage\\s+${st.to}\\]`, 'i');
      if (stagesSaid(plan).has(st.to)) continue;
      // Who it happens with, when the step names them ("Player gives the sword to Proventus").
      const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const named = plan.characters.find((c) => [c.key, c.name, c.name.split(/\s+/)[0]!].some((n) => n.length > 2 && new RegExp(`\\b${esc(n)}\\b`, 'i').test(st.note)));
      const answer = named ? `then ${named.key.toUpperCase()}'s answer` : 'then the answer from the character it happens with';
      try {
        const out = await this.run(
          {
            model: this.model,
            max_tokens: 3000,
            output_config: { effort: 'high', format: betaZodOutputFormat(ScreenplaySchema) },
            system: [{ type: 'text', text: `${DIALOGUE_RULES}\n\n${STYLE}` }],
            messages: [
              {
                role: 'user',
                content: `${brief}\n\nNothing in the dialogue makes this happen yet: “${st.note}” (${st.from === null ? '' : `stage ${st.from} → `}stage ${st.to}). Write just that short exchange: a PLAYER line${st.from === null ? '' : ` with [if stage ${st.from}]`}, ${answer}, ending with [stage ${st.to}] and [goodbye]. If an item changes hands, use [gives KEY x1] or [takes KEY x1] with the item's key. Speakers: PLAYER and ${keys}.`,
              },
            ],
          },
          ScreenplaySchema,
        );
        const text = out.screenplay.trim();
        if (!tag.test(text) || errors(text) > 0) continue;
        const who = [...text.matchAll(/^\s*([^:\n[\]]+?)\s*:/gm)].map((m) => m[1]!.trim().toLowerCase()).find((n) => n !== 'player');
        const c = plan.characters.find((x) => x.key.toLowerCase() === who || x.name.toLowerCase() === who);
        if (!c || (named && c !== named)) continue;
        const conv = plan.conversations.find((x) => x.title.toLowerCase() === c.name.toLowerCase());
        if (conv) conv.screenplay = `${conv.screenplay.trimEnd()}\n${text}`;
        else plan.conversations.push({ title: c.name, screenplay: text });
      } catch {
        // The step stays as it was; the plan review says nothing sets that stage.
      }
    }
  }

  /** Change a plan as the author describes; returns the whole new plan. */
  async revise(plan: QuestPlan, feedback: string, catalog: string, source?: string): Promise<QuestPlan> {
    if (!feedback.trim()) throw new WorkspaceError('Say what to change');
    return this.run<QuestPlan>(
      this.request(
        [
          { role: 'user', content: source?.trim() ? `${MODES.document}\n\n<source>\n${source.trim()}\n</source>` : 'Plan a quest.' },
          { role: 'assistant', content: JSON.stringify(plan) },
          { role: 'user', content: `Change the plan as follows, keep everything else as it is, and return the whole plan:\n\n${feedback.trim()}${this.free ? `\n\n${planIndex(plan)}\n\n${CHECKLIST}` : ''}` },
        ],
        catalog,
        `${source ?? ''}\n${feedback}`,
      ),
    );
  }

  /** Claude writes the journal entries and objectives in Skyrim's style. */
  async writeJournal(ctx: JournalContext, opts: { overwrite?: boolean } = {}): Promise<JournalDraft> {
    const params: BetaMessageStreamParams = {
      model: this.model,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: betaZodOutputFormat(JournalDraftSchema) },
      system: [{ type: 'text', text: JOURNAL_RULES, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: `${opts.overwrite ? 'Rewrite every journal entry and objective.' : 'Write the missing journal entries and objectives; keep the ones that are already written exactly as they are (leave them out of your answer).'}\n\n<quest>\n${JSON.stringify(ctx, null, 1)}\n</quest>`,
        },
      ],
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    };
    return this.run(params, JournalDraftSchema);
  }

  private async run<T>(params: BetaMessageStreamParams, schema: z.ZodType<T> = QuestPlanSchema as unknown as z.ZodType<T>, repair = true): Promise<T> {
    const reply = await this.send(params);
    if (reply.stop_reason === 'refusal') throw new WorkspaceError(`${this.name} declined to plan this. Try rewording the text.`);
    if (reply.stop_reason === 'max_tokens') throw new WorkspaceError('The plan got too long to finish. Try splitting the quest into smaller parts.');
    const text = reply.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    let json: unknown;
    try {
      json = normalize(JSON.parse(text));
      // Lists added to the plan format later may be left out.
      if (schema === (QuestPlanSchema as unknown) && json && typeof json === 'object' && !('events' in json)) (json as Record<string, unknown>).events = [];
      if (schema === (QuestPlanSchema as unknown) && json && typeof json === 'object' && !('startsWhen' in json)) (json as Record<string, unknown>).startsWhen = null;
      if (schema === (QuestPlanSchema as unknown) && json && typeof json === 'object' && !('failures' in json)) (json as Record<string, unknown>).failures = [];
      // Smaller models leave fields out: empty lists and "none" are filled in, so only real gaps count.
      json = fillMissing(schema, json);
      if (schema === (QuestPlanSchema as unknown) && json && typeof json === 'object') repairPlan(normalizePlan(json as QuestPlan));
    } catch {
      throw new WorkspaceError(`${this.name}'s answer wasn't in the expected format. Try again${this.name === 'Claude' ? '' : ', or try a bigger model'}.`);
    }
    const parsed = schema.safeParse(json);
    if (parsed.success) return parsed.data;
    const wrong = parsed.error.issues.slice(0, 10);
    const issues = wrong.map((i) => `${i.path.join('.') || 'plan'}: ${i.message}`);
    // One chance to fix it, told exactly what was wrong and what each field takes.
    const hinted = wrong.map((i, n) => {
      const hint = fieldHint(schema, i.path);
      return `${issues[n]}${hint ? ` (expected ${hint})` : ''}`;
    });
    if (repair)
      return this.run(
        {
          ...params,
          messages: [
            ...params.messages,
            { role: 'assistant', content: text },
            { role: 'user', content: `That plan doesn't match the format:\n${hinted.join('\n')}\nFill in every field, using null or [] where nothing applies. Return the whole corrected plan.` },
          ],
        },
        schema,
        false,
      );
    throw new WorkspaceError(`${this.name}'s plan was incomplete (${issues[0]}). Try again${this.name === 'Claude' ? '' : ', or try a bigger model'}.`);
  }
}

const ScreenplaySchema = z.object({ screenplay: z.string().describe('The whole conversation in screenplay format') });

const AnnotationSchema = z.object({
  blocks: z.array(z.object({ block: z.number().int(), tags: z.string().describe('Tags for every line of the block, e.g. "[if stage 10]"; for a scene "[at stage 100]"') })).describe('Blocks that need tags'),
  lines: z
    .array(z.object({ line: z.number().int(), words: z.string().describe('The first three words of that line, as written'), tags: z.string().describe('Tags for the line, e.g. "[stage 10] [remember promised]"; two ways of saying it are separated by |') }))
    .describe('Only the lines that need tags'),
});
/** The same, as it's read back: an answer without the words is still used, by number. */
const AnnotationAnswer = AnnotationSchema.extend({ lines: z.array(z.object({ line: z.number().int(), words: z.string().nullable().optional(), tags: z.string() })) });

/** Told to the planner when the author's conversations are written out. */
const WRITTEN_NOTE = `The conversations the author wrote out are shown above only as outlines "(Conversation N, with …)": they are added to the plan afterwards, word for word, with their tags. Don't write them into "conversations": write there only lines the author describes without writing them out (a greeting described in a sentence, what someone says during the day), or leave it empty. Plan the stages and the talk steps for what those conversations do (taking the job, agreeing to go, each ending); a talk step's note says which line does it.`;

/** How the AI turns an author's directions into tags. */
const ANNOTATE_RULES = `You add tags to dialogue a Skyrim quest's author has already written, so the quest works. The words stay exactly as they are: you only say which tags go on which numbered lines (with each line's first three words, to be sure which it is). Answer in the JSON format given.

Blocks: give each block the tags that say when its lines can be said, from its heading and the plan. Usually [if stage N] (the stage the quest is at then; [if stage >= N] when it stays available), also [if night], [if day], [if chose NAME]. A block that can be said any time while the quest runs needs nothing. A scene (characters talking to each other) gets [at stage N]: the stage that starts it.
Lines: turn the author's directions (after "—") into tags:
- the quest moving on ("the player takes the job", "Rulnik starts following", "the quest is done", an ending) → [stage N] with the stage from the plan;
- money or things changing hands → [gives gold x150] (the speaker gives the player), [takes KEY x3] (the speaker takes from the player), with item keys from the plan;
- a choice the quest should remember ("she remembers the promise", "he remembers the deal") → [remember NAME] with a short name; "only if the player promised…" → [if chose NAME] with the same name;
- other "only if …" / "if …" / "needs …" → [if …] (e.g. [if gold 300], [if done 40], [if not chose deal]);
- "he attacks" → [attacks]; "leaves for good" → [leaves]; a line said two ways ("pays 150 gold, or 250 if persuaded") → the two tag sets separated by |, the first with its [if …]: "[if chose persuaded] [gives gold x250] | [gives gold x150]".
Directions about objectives and the journal need no tag. Leave out blocks and lines that need nothing. Use only stage numbers, item keys and choice names from the plan and the questline.`;

/** The tags the AI may use on written dialogue (the reference part of the planner's rules). */
const TAG_REFERENCE = RULES.slice(RULES.indexOf('Tags at the end of a line:'), RULES.indexOf('Lines nobody prompts go in blocks'));

/** What the AI needs to tag a quest's written dialogue: its stages, what moves it on, items and characters. */
function annotateBrief(plan: QuestPlan): string {
  return [
    `Quest: ${plan.title}. ${plan.summary}`,
    `Stages: ${plan.stages.map((st) => `${st.index}${st.startsQuest ? ' (start)' : ''}${st.completesQuest ? ' (completes the quest)' : ''}${st.failsQuest ? ' (fails it)' : ''}: ${st.journal || '(no journal)'}`).join(' | ')}`,
    `What moves the quest on: ${plan.steps.map((st) => `${st.from ?? 'start'} → ${st.to} by ${st.kind}${st.targetKey ? ` ${st.targetKey}` : ''} (${st.note})`).join('; ') || 'dialogue only'}`,
    `Items (keys for [gives]/[takes]/[if has]): ${plan.items.map((i) => `${i.key} = ${i.name}`).join('; ') || 'none'}`,
    `Characters: ${plan.characters.map((c) => `${c.key.toUpperCase()} = ${c.name}`).join('; ')}`,
  ].join('\n');
}

/**
 * Someone who speaks in the author's dialogue but isn't in the plan ("LUCAN:" when the plan left Lucan out): added as
 * the character from the load order whose name starts that way ("Lucan Valerius"), when there's exactly one.
 */
export function addSpeakers(plan: QuestPlan, blocks: WrittenBlock[], catalog: string): string[] {
  const out: string[] = [];
  const people = (catalog.split('\n\n').find((x) => x.startsWith('Characters')) ?? '')
    .split('\n')
    .map((l) => /^(\S+) "([^"]+)"/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ editorId: m[1]!, name: m[2]! }));
  const speakers = new Set(blocks.flatMap((b) => b.lines.filter((l) => !l.player).map((l) => l.speaker.toLowerCase())));
  for (const sp of speakers) {
    if (characterFor(plan, sp)) continue;
    const hits = people.filter((p) => p.name.toLowerCase() === sp || p.name.toLowerCase().split(/\s+/)[0] === sp);
    if (hits.length !== 1) continue;
    const h = hits[0]!;
    const key = sp.replace(/[^a-z0-9]/g, '') || 'speaker';
    plan.characters.push({ key, name: h.name, existing: h.editorId, basedOn: null, sex: null, race: null, role: 'Speaks in the conversations you wrote', appearance: '', look: null, voice: null, locationKey: null, spot: null, essential: null, className: null, level: null, outfit: null, factions: [], inventory: [], routine: [], combat: null, roles: null, relationships: [] });
    out.push(`${h.name} (${h.editorId}) speaks in your dialogue, so they're in the quest as they are in the game`);
  }
  if (out.length) plan.assumptions = [...(plan.assumptions ?? []), ...out];
  return out;
}

/** The plan's character a written speaker is ("HESTA", "Varro" → hesta / Varro Tullius). */
export function characterFor(plan: QuestPlan, speaker: string): QuestPlan['characters'][number] | undefined {
  const s = speaker.toLowerCase();
  return plan.characters.find((c) => c.key.toLowerCase() === s || c.name.toLowerCase() === s) ?? plan.characters.find((c) => c.name.toLowerCase().split(/\s+/)[0] === s || c.key.toLowerCase().startsWith(s));
}

/**
 * The AI's tags, checked against the plan: stages that don't exist, items that aren't in it and conditions that don't
 * read are taken out. Returns what was taken out, in words.
 */
function checkAnnotation(plan: QuestPlan, a: DialogueAnnotation, who: string): string[] {
  const stages = new Set(plan.stages.map((st) => st.index));
  const items = new Set(plan.items.flatMap((i) => [i.key.toLowerCase(), i.name.toLowerCase()]));
  const out: string[] = [];
  const fix = (tags: string, where: string) =>
    tags.replace(/\[([a-z]+)((?:\s+[^\]]*)?)\]/gi, (m: string, tag: string, rest: string) => {
      const t = tag.toLowerCase();
      const v = rest.trim();
      let bad = '';
      const stage = /^(?:stage\s*)?(?:[<>=!]=?\s*)?(\d+)$/i.exec(v)?.[1];
      if ((t === 'stage' || t === 'at') && stage !== undefined && !stages.has(Number(stage))) bad = `there's no stage ${stage}`;
      if (t === 'if' && /^(stage|done|not done)\b/i.test(v) && !stages.has(Number(/(\d+)/.exec(v)?.[1]))) bad = `there's no such stage`;
      if (t === 'if' && !readableIf(m)) bad = 'the condition doesn’t read';
      const item = /^(?:not\s+|no\s+)?(?:has\s+)?(.*?)(?:\s*[x×]\s*\d+)?$/i.exec(v)?.[1]?.toLowerCase() ?? '';
      if ((t === 'gives' || t === 'takes' || (t === 'if' && /^(not\s+|no\s+)?has\b/i.test(v))) && item !== 'gold' && !items.has(item)) bad = `“${item}” isn't an item in the plan`;
      if (!bad) return m;
      out.push(`Left ${m} off ${where} (${bad})`);
      return '';
    });
  for (const b of a.blocks ?? []) b.tags = fix(b.tags ?? '', `${who}'s block ${b.block}`);
  for (const l of a.lines ?? []) l.tags = fix(l.tags ?? '', `${who}'s line ${l.line}`);
  return out;
}

/**
 * "(Rulnik starts following)" / "(he stops following)" on a line that moves the quest on: the character follows the
 * player from (or until) that line's stage. Returns what changed.
 */
function followDirections(plan: QuestPlan, blocks: WrittenBlock[]): string[] {
  const out: string[] = [];
  for (const l of blocks.flatMap((b) => b.lines)) {
    const stage = Number(/^\[stage\s+(\d+)\]$/i.exec(l.tags.find((t) => /^\[stage\s+\d+\]$/i.test(t)) ?? '')?.[1]);
    if (!Number.isFinite(stage)) continue;
    for (const n of l.notes) {
      const m = /\b([A-Z][\w'’-]*|he|she|they)\s+(starts?|begins?|stops?)\s+following\b/i.exec(n);
      if (!m) continue;
      const who = /^(he|she|they)$/i.test(m[1]!) ? characterFor(plan, l.speaker) : characterFor(plan, m[1]!);
      if (!who) continue;
      const start = /^(starts?|begins?)$/i.test(m[2]!);
      const follow = who.routine.find((r) => r.activity === 'follow');
      if (start) {
        if (follow?.fromStage === stage) continue;
        if (follow) follow.fromStage = stage;
        else who.routine.push({ activity: 'follow', where: null, hours: null, fromStage: stage, untilStage: null, line: null });
        out.push(`${who.name} follows the player from stage ${stage}`);
      } else if (follow && follow.untilStage !== stage) {
        follow.untilStage = stage;
        out.push(`${who.name} stops following the player at stage ${stage}`);
      }
    }
  }
  return out;
}

/** A screenplay without the topics and lines that repeat the author's own (an AI copying them out). */
function withoutAuthorLines(screenplay: string, author: string[]): string {
  const said = (line: string) => {
    const text = /^\s*[^:]+:\s*(.*)$/.exec(line)?.[1]?.replace(/\[[^\]]*\]/g, '').trim() ?? '';
    return !!text && author.some((a) => similarity(a, text) >= 0.6);
  };
  const out: string[] = [];
  let chunk: string[] = [];
  const flush = () => {
    if (chunk.length && !chunk.some(said)) out.push(...chunk);
    chunk = [];
  };
  let inBlock = false;
  for (const line of screenplay.split(/\r?\n/)) {
    if (/^(GREETINGS?|HELLO|IDLE|CHATTER|SCENE)\s*:/i.test(line.trim())) {
      flush();
      inBlock = true;
      out.push(line);
      continue;
    }
    if (inBlock && !/^\s*player\s*:/i.test(line)) {
      if (!said(line)) out.push(line);
      continue;
    }
    if (/^player\s*:/i.test(line)) {
      flush();
      inBlock = false;
    }
    chunk.push(line);
  }
  flush();
  // Blocks left with nothing under them go too (a tag on a line of its own isn't anything said).
  const kept = out.filter((l) => /^\s*[^\s:[\]][^:]*:/.test(l));
  const lines = kept.filter((l, i) => !(/^(GREETINGS?|HELLO|IDLE|CHATTER|SCENE)\s*:/i.test(l.trim()) && (i + 1 >= kept.length || /^(GREETINGS?|HELLO|IDLE|CHATTER|SCENE|PLAYER)\s*:/i.test(kept[i + 1]!.trim()))));
  return lines.join('\n').trim();
}

/** The dialogue part of the rules, for rewriting one conversation at a time. */
const DIALOGUE_RULES = RULES.slice(RULES.indexOf('Conversations are written in this screenplay format'));

/** How Skyrim's characters talk, for the dialogue pass. */
const STYLE = `How lines should sound:
- Short: one or two sentences a line, under about 150 characters. Split longer speeches into several lines by the same speaker.
- Plain, slightly old-fashioned words that fit a cold, rough land; no modern slang, no jokes about games, no "okay".
- Characters sound like who they are: a guard is curt, an innkeeper friendly and busy, a noble formal, a thief sly. They treat the player as a stranger until the quest gives them a reason not to.
- Player lines are short and say what the player would say: a helpful choice, a blunt or greedy one, and a way to refuse where it matters.
- Show feelings in the words and with [emotion …], not by describing them.

For example, instead of:
PLAYER: Okay, I will go and find the ring for you now.
BRYNJA: Great! You are a hero! The ring is very important to me because it belonged to my mother who died. [stage 10]
write:
PLAYER: I'll find your ring. [stage 10]
BRYNJA: Would you? It was my mother's. It's all I have left of her. [emotion sad]
BRYNJA: Try the tables. I was clearing them all morning. [goodbye]`;

/** What a free AI needs to know about the plan to write one part of it well. */
function planBrief(plan: QuestPlan, source: string): string {
  const lines = [
    `Quest: ${plan.title}. ${plan.summary}`,
    `Characters (speaker name in capitals = key): ${plan.characters.map((c) => `${c.key.toUpperCase()} = ${c.name}, ${c.role}`).join('; ') || 'none'}`,
    `Items (keys for [gives]/[takes]): ${plan.items.map((i) => `${i.key} = ${i.name}`).join('; ') || 'none'}`,
    `Places: ${plan.locations.map((l) => `${l.key} = ${l.name}`).join('; ') || 'none'}`,
    `Stages: ${plan.stages.map((s) => `${s.index}${s.completesQuest ? ' (completes the quest)' : s.failsQuest ? ' (fails the quest)' : ''}: ${s.journal || '(no journal entry yet)'}`).join(' | ')}`,
    `What moves the quest on: ${plan.steps.map((st) => `${st.from ?? 'start'} → ${st.to} by ${st.kind}${st.targetKey ? ` ${st.targetKey}` : ''}${st.note ? ` (${st.note})` : ''}`).join('; ') || 'dialogue only'}`,
  ];
  if (source.trim()) lines.push(`The author's text:\n<source>\n${source.trim().slice(0, 6000)}\n</source>`);
  return lines.join('\n');
}

/** Problems worth one more round with the AI: errors, and gaps that leave the quest stuck. */
export function blockingIssues(issues: PlanIssue[]): PlanIssue[] {
  return issues.filter((i) => i.severity === 'error' || /^(Nothing moves the quest|Nothing starts the quest|No stage completes|The player needs|The player loses|A line in .* sets stage|The quest starts with the game, so stage|.* fails the quest as soon as stage|.* whenever it's chosen, even before|The player has to pick up)/.test(i.message));
}

const JournalDraftSchema = z.object({
  stages: z.array(z.object({ index: z.number().int(), journal: z.string() })),
  objectives: z.array(z.object({ index: z.number().int(), text: z.string(), shownAtStage: z.number().int(), completedAtStage: z.number().int().nullable() })),
});

const JOURNAL_RULES = `You write the quest journal and objectives for a Skyrim quest, in the style of the game's own quests.

Journal entries: written by the player in the first person and the past tense, one to three short sentences, saying what happened and what they mean to do next ("Brynja asked me to find her mother's ring. She thinks it was lost somewhere in the tavern."). No game terms (stages, aliases, triggers), no "you". The final stage of a completed quest gets a short closing entry. The opening stage is usually left empty unless the quest starts with something the player should read.
Objectives: short instructions in the imperative, at most about 50 characters, no full stop ("Find Brynja's ring", "Return the ring to Brynja"). Show each one at the stage where the task starts and complete it at the stage where it's done; use the stage number as the objective number unless the quest already has one there.
Use the names given. Only use what the quest data says; don't invent new events.

Good journal entry: "I found Brynja's ring on a table in the tavern. I should return it to her."
Not: "Stage 20: You have found the ring. Return it to Brynja to complete the quest."
Good objective: "Return the ring to Brynja". Not: "I need to return the ring." or "Go back to Brynja and give her the ring so she pays you."`;

type ZodDef = { type: string; shape?: Record<string, z.ZodType>; element?: z.ZodType; innerType?: z.ZodType; entries?: Record<string, string> };
const defOf = (s: z.ZodType | undefined): ZodDef | undefined => (s as unknown as { _zod?: { def: ZodDef } } | undefined)?._zod?.def;

/** What a field takes, in words ("\"male\" | \"female\" or null — …"), for telling a model how to fix it. */
export function fieldHint(schema: z.ZodType, path: PropertyKey[]): string {
  let s: z.ZodType | undefined = schema;
  const unwrap = (x: z.ZodType | undefined) => {
    while (x && ['nullable', 'optional', 'default'].includes(defOf(x)!.type)) x = defOf(x)!.innerType;
    return x;
  };
  for (const seg of path) {
    const d = defOf(unwrap(s));
    s = d?.type === 'object' ? d.shape?.[String(seg)] : d?.type === 'array' ? d.element : undefined;
    if (!s) return '';
  }
  let desc = (s as unknown as { description?: string }).description;
  let nullable = false;
  let x: z.ZodType | undefined = s;
  while (x && ['nullable', 'optional', 'default'].includes(defOf(x)!.type)) {
    if (defOf(x)!.type === 'nullable') nullable = true;
    x = defOf(x)!.innerType;
    desc ??= (x as unknown as { description?: string }).description;
  }
  const d = defOf(x);
  const type =
    d?.type === 'enum'
      ? Object.values(d.entries ?? {})
          .map((v) => JSON.stringify(v))
          .join(' | ')
      : d?.type === 'object'
        ? 'an object with all its fields'
        : d?.type === 'array'
          ? 'a list ([] for none)'
          : d?.type === 'number'
            ? 'a number'
            : d?.type === 'boolean'
              ? 'true or false'
              : d?.type === 'string'
                ? 'text'
                : '';
  return [type && `${type}${nullable ? ' or null' : ''}`, desc].filter(Boolean).join(' — ');
}

/** Fill fields an answer left out: lists become [] and nullable fields null, all the way down. */
export function fillMissing(schema: z.ZodType, v: unknown): unknown {
  const def = (schema as unknown as { _zod?: { def: Record<string, any> } })._zod?.def;
  if (!def) return v;
  switch (def.type) {
    case 'object': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
      const o = v as Record<string, unknown>;
      for (const [k, s] of Object.entries(def.shape as Record<string, z.ZodType>)) {
        const t = (s as unknown as { _zod: { def: { type: string } } })._zod.def.type;
        // A list given as null means an empty list.
        if (!(k in o) || o[k] === undefined || (o[k] === null && t === 'array')) {
          if (t === 'array') o[k] = [];
          else if (t === 'nullable') o[k] = null;
        } else o[k] = fillMissing(s, o[k]);
      }
      return o;
    }
    case 'array':
      return Array.isArray(v) ? v.map((x) => fillMissing(def.element, x)) : v;
    case 'nullable':
      // "null" in quotes, or nothing at all, is meant as null.
      if (typeof v === 'string' && /^\s*(null)?\s*$/i.test(v)) return null;
      return v === null || v === undefined ? v : fillMissing(def.innerType, v);
    case 'optional':
    case 'default':
      return v === null || v === undefined ? v : fillMissing(def.innerType, v);
    // Smaller models quote numbers and true/false, and capitalise choices.
    case 'number':
      return typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v;
    case 'boolean':
      return typeof v === 'string' && /^\s*(true|false)\s*$/i.test(v) ? v.trim().toLowerCase() === 'true' : v;
    case 'enum':
      return typeof v === 'string' ? (Object.values(def.entries as Record<string, string>).find((e) => e.toLowerCase() === v.trim().toLowerCase()) ?? v) : v;
    default:
      return v;
  }
}

const ENUM_FIELDS = new Set(['sex', 'kind', 'startsWith']);

/** Lower-case the choice fields ("Female" → "female"); the format can't enforce them. */
function normalize(v: unknown, key?: string): unknown {
  if (Array.isArray(v)) return v.map((x) => normalize(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x, k)]));
  if (typeof v === 'string' && key && ENUM_FIELDS.has(key)) {
    const t = v.trim().toLowerCase();
    // Event kinds are camelCase ("moveTo").
    return PLAN_EVENT_KINDS.find((k) => k.toLowerCase() === t) ?? t;
  }
  return v;
}
