/**
 * Reading an author's quest into a beat sheet (beats.ts) with any AI, free or not, in small questions:
 *
 *   1. who and what the quest involves (people, places, items, enemies), each with the sentence it comes from;
 *   2. passage by passage, in the author's order: what the player does that moves the quest on (beats), and for a
 *      written conversation, when it's offered and which of its lines do what;
 *   3. for the written lines with directions: when they're said, and what saying them does;
 *   4. what checkBeats finds that doesn't fit together, asked again about that one beat or line;
 *   5. what else happens along with the beats (the author's words for it, read into gold, items, people leaving…),
 *      and each beat's objective and journal entry;
 *   6. for talk beats the author only describes, the line that does it.
 *
 * The AI reads the language; this file only keeps the books: keys for names, beat numbers, what's already in the
 * game (looked up by exact name), and which answer goes where.
 */
import { z } from 'zod';
import {
  BEAT_ACTIONS,
  checkBeats,
  type Beat,
  type BeatCondition,
  type BeatDialogueLine,
  type BeatEffects,
  type BeatEntityKind,
  type BeatGroup,
  type BeatItem,
  type BeatPerson,
  type BeatPlace,
  type BeatQuestion,
  type BeatSheet,
  type BeatStart,
} from './beats';
import type { Workspace } from './engine';
import type { QuestPlanner } from './planner';
import { WorldService } from './world';
import { describeBlocks, findDialogue, type WrittenBlock } from './written';

/** What's already in the game, by exact name (the host looks it up in the load order). */
export interface BeatLookup {
  person(name: string): string | null;
  /** An interior with that name, or a place on the world map. */
  place(name: string): string | null;
  item(name: string): string | null;
}

/** Names looked up in a load order: characters and items by their exact in-game name, places as interiors or map markers. */
export function beatLookup(ws: Workspace): BeatLookup {
  const world = new WorldService(ws);
  const plain = (n: string) => n.trim().toLowerCase().replace(/^the\s+/, '');
  const exact = (sigs: string[], name: string) => ws.search({ sigs, query: name.replace(/^the\s+/i, ''), limit: 300 }).items.find((i) => !i.deleted && plain(i.name ?? '') === plain(name))?.editorId ?? null;
  let interiors: ReturnType<WorldService['cells']> | undefined;
  return {
    person: (n) => exact(['NPC_'], n),
    place: (n) => {
      interiors ??= world.cells({ interiorOnly: true });
      return interiors.find((c) => plain(c.name ?? '') === plain(n))?.editorId ?? world.mapMarker(n)?.name ?? null;
    },
    item: (n) => exact(['WEAP', 'ARMO', 'MISC', 'BOOK', 'KEYM', 'ALCH', 'INGR'], n),
  };
}

export interface BeatReadOptions {
  /** The quest's title (its heading). */
  title: string;
  editorId: string;
  /** What every quest of a questline shares (the cast list, the setting), read for who and what only. */
  shared?: string;
  /** Earlier quests of the questline: their people, places, items and the choices they remember. */
  earlier?: BeatSheet[];
  lookup?: BeatLookup;
  onStep?: (what: string) => void;
}

const ITEM_KINDS = ['misc', 'book', 'key', 'clothing', 'armor', 'weapon', 'potion', 'other'] as const;

const WRITE_RULES = `You write the words a Skyrim quest needs that its author didn't write, in the author's tone: short, plain, in the game's style, no game terms. Answer only in the JSON format given.`;

const READ_RULES = `You read a Skyrim quest an author has written, to help turn it into a working quest. Answer only from what the text says, in the JSON format given. Quote the author's sentence each answer comes from, word for word. Where the text doesn't say, use null or an empty list; don't invent.`;

const EntitiesSchema = z.object({
  summary: z.string().describe('The quest in one sentence'),
  start: z.object({
    how: z.enum(['talking', 'reading', 'picking up', 'arriving', 'using', 'previous quest']).describe('What starts the quest: talking to someone, reading a note, picking something up, arriving somewhere, using something, or the previous quest ending'),
    what: z.string().nullable().describe('The name of the thing read, picked up, used or arrived at; null for talking or the previous quest'),
  }),
  people: z.array(
    z.object({
      name: z.string().describe('As the author writes it'),
      description: z.string().describe('Who they are, in a few words'),
      sex: z.enum(['male', 'female']).nullable(),
      race: z.string().nullable().describe('e.g. "Nord", "Imperial"; null if not said'),
      where: z.string().nullable().describe('The name of the place they are when the quest begins; null if not said'),
      spot: z.string().nullable().describe('Where in that place, e.g. "by the fire"'),
      canDie: z.enum(['yes', 'no', 'not said']),
      hostile: z.boolean().describe('Attacks the player on sight'),
      quote: z.string(),
    }),
  ),
  places: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      partOf: z.string().nullable().describe('For a spot that is part of a bigger named place ("a camp by the river outside Riverwood"), that place\'s name ("Riverwood"); otherwise null'),
      quote: z.string(),
    }),
  ),
  items: z.array(
    z.object({
      name: z.string().describe('Its name, singular ("Torn Map Page", not "three pages")'),
      kind: z.enum(ITEM_KINDS),
      where: z.string().nullable().describe('The name of the place it lies when the quest begins'),
      carriedBy: z.string().nullable().describe('The name of the person who has it when the quest begins'),
      spot: z.string().nullable().describe('Where it lies; for several, one place each separated by ";"'),
      count: z.number().int().describe('How many there are'),
      text: z.string().nullable().describe('For a note, letter or book: its words, as the author gives them'),
      lockedWith: z.string().nullable().describe('If it is in something locked: the name of the key that opens it'),
      quote: z.string(),
    }),
  ).describe('Things the player finds, carries, reads, uses or is given (a reward item too). Not gold: gold the player is paid comes with what happens'),
  enemies: z.array(
    z.object({
      what: z.string().describe('e.g. "bandit", "skeever", "draugr"'),
      count: z.number().int(),
      where: z.string().describe('The name of the place they are'),
      appearLater: z.boolean().describe('True when they only appear when something happens (an ambush)'),
      quote: z.string(),
    }),
  ),
});

const EffectsShape = {
  gold: z.number().int().nullable().describe('Gold the player gets (negative: pays)'),
  gives: z.array(z.object({ item: z.string(), count: z.number().int() })).describe('Items the player is given, by name'),
  takes: z.array(z.object({ item: z.string(), count: z.number().int() })).describe('Items taken from the player, by name'),
  remembers: z.string().nullable().describe('A choice the quest remembers for later, as one short word ("promised", "deal")'),
  attacks: z.array(z.string()).describe('People who turn on the player'),
  leaves: z.array(z.string()).describe('People who leave for good'),
  follows: z.array(z.string()).describe('People who start following the player'),
  stopsFollowing: z.array(z.string()),
  appears: z.array(z.string()).describe('People or enemies who appear'),
  moves: z.array(z.object({ who: z.string(), to: z.string() })).describe('People who go somewhere else'),
};

const BeatShape = z.object({
  n: z.number().int().describe("This beat's number"),
  does: z.enum(BEAT_ACTIONS).describe('What the player does: talk (to someone, including bringing them something back), pickup, read, use, arrive (at a place), kill (someone), clear (every enemy in a group dead), wait (some in-game hours), immediately (right after the beats before)'),
  target: z.string().nullable().describe('The name of the person, item, place or enemies it is done to (from the lists); null for wait and immediately'),
  count: z.number().int().nullable().describe('pickup: how many'),
  hours: z.number().nullable().describe('wait: how many in-game hours'),
  after: z
    .array(z.number().int())
    .describe('The numbers of the beats that must happen just before this one: usually the beat before it. Two ways of going on each come after the same beat, and the beat where they meet again lists both. Empty only for the first thing the player does'),
  quote: z.string(),
  ends: z.enum(['complete', 'fail', 'no']).describe('Whether reaching it finishes the quest (complete) or fails it'),
  then: z.string().nullable().describe("Anything else that happens when it's done (the player is paid or given something, someone hands something over, leaves, attacks, follows or appears), in the author's words; null if nothing"),
});

/** What happens along with the beats that say "then": only those beats, by number. */
const thenSchema = (numbers: number[]) =>
  z.object({
    beats: z
      .array(
        z.object({
          n: z.number().int().describe(`The beat number {enum: ${JSON.stringify(numbers)}}`),
          ...EffectsShape,
          instead: z
            .array(z.object({ if: z.array(ConditionShape), gold: z.number().int().nullable() }))
            .describe('When the gold is different under a condition ("200 gold, or only 100 if he was let go"): that condition and amount'),
        }),
      )
      .describe(`One entry for each of beats ${numbers.join(', ')}`),
  });

/** What the player is told, and what the journal says, for each beat. */
const WordsSchema = z.object({
  beats: z.array(
    z.object({
      n: z.number().int().describe('The beat number'),
      objective: z.string().describe('What the player is told to do to make this beat happen: an order of a few words, e.g. "Talk to Gerdur", "Find the note", "Kill the bandits"'),
      journal: z.string().describe("The player's journal once it's done: one or two sentences, first person, past tense, e.g. \"Gerdur asked me to find out what happened to her lumber.\""),
    }),
  ),
});

const PassageSchema = z.object({
  beats: z.array(BeatShape).describe('New beats this passage adds (none if it adds none)'),
});

/** A written conversation: when it's offered, and which of its lines move the quest on (each one is talking to its speaker). */
/** A written conversation: when it's offered, and for each line that could move the quest on, what it does. */
const conversationSchema = (beats: number[], lines: number[], choices: string[]) =>
  z.object({
    when: z.number().int().nullable().describe(`The beat after which the player can have this conversation; null when they can have it from the start of the quest {enum: ${JSON.stringify(beats)}}`),
    lines: z
      .array(z.object({ line: z.number().int().describe(`{enum: ${JSON.stringify(lines)}}`), does: z.string().describe(`{enum: ${JSON.stringify(choices)}}`) }))
      .describe(`One entry for each of lines ${lines.join(', ')}: "only talk" when saying it moves nothing on (an answer, directions, a failed persuasion); a beat listed above that saying it does; or "a new step" when saying it moves the quest on and no beat above is it`),
  });

/** The author's prose, paragraph by paragraph: which paragraphs tell what happens. */
const paragraphsSchema = (n: number) =>
  z.object({
    paragraphs: z
      .array(z.object({ n: z.number().int(), is: z.enum(['what happens', 'journal', 'objectives', 'greetings or idle lines', 'a heading', 'notes']) }))
      .describe(`One entry for each paragraph, 1 to ${n}`),
  });

const ConditionShape = z.object({
  kind: z.enum(['chose', 'not chose', 'done', 'dead', 'alive', 'left', 'gold', 'night', 'day']).describe('chose: the player made a choice remembered earlier; done: a beat has happened; dead/alive/left: what became of someone; gold: the player has that much'),
  value: z.string().nullable().describe('chose: the choice; done: the beat number; dead/alive/left: the person; gold: the amount'),
});

const LinesSchema = z.object({
  lines: z.array(
    z.object({
      line: z.number().int(),
      words: z.string(),
      if: z.array(ConditionShape).describe('Only what the author says must hold outside this conversation ("only if…", "if Varro left", "if the player promised earlier"). Not which line it answers, and not a persuasion\'s success or failure: the conversation\'s order already says those'),
      ...EffectsShape,
      instead: z
        .array(z.object({ if: z.array(ConditionShape), gold: z.number().int().nullable() }))
        .describe('When the direction gives a different amount under a condition ("150 gold, or 250 if persuaded"): that condition and amount'),
    }),
  ),
});

const SayingSchema = z.object({ player: z.string().describe("The player's line"), answer: z.string().describe('What the character answers') });

/** A short identifier for a name (its first `words` words), made unique. */
function keyFor(name: string, taken: Set<string>, words = 3): string {
  const base =
    name
      .replace(/['’]s\b/g, '')
      .replace(/^(the|a|an)\s+/i, '')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
      .slice(0, words)
      .join('') || 'thing';
  let k = base;
  for (let n = 2; taken.has(k); n++) k = `${base}${n}`;
  taken.add(k);
  return k;
}

const norm = (t: string) =>
  t
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/s\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** The entry a name the AI wrote refers to: the same name, or one containing it ("Hesta" for "Hesta Coldwater"). */
function byName<T extends { name: string; key: string }>(list: T[], name: string | null | undefined): T | undefined {
  if (!name) return undefined;
  const n = norm(name);
  return list.find((x) => norm(x.name) === n || x.key.toLowerCase() === name.toLowerCase()) ?? list.find((x) => norm(x.name).split(' ')[0] === n.split(' ')[0] && n.length > 2 && (!n.includes(' ') || !norm(x.name).includes(' '))) ?? list.find((x) => norm(x.name).includes(n) || n.includes(norm(x.name)));
}

/** A quest's text in passages, in order: runs of prose, and each written conversation on its own. */
export function passages(text: string): ({ kind: 'prose'; text: string } | { kind: 'conversation'; block: WrittenBlock })[] {
  const { blocks, prose } = findDialogue(text);
  const out: ({ kind: 'prose'; text: string } | { kind: 'conversation'; block: WrittenBlock })[] = [];
  let buf: string[] = [];
  const flush = () => {
    const t = buf.join('\n').trim();
    if (t) out.push({ kind: 'prose', text: t });
    buf = [];
  };
  for (const row of prose.split('\n')) {
    const m = /^\(Conversation (\d+)\b/.exec(row.trim());
    if (m) {
      flush();
      const b = blocks.find((x) => x.id === Number(m[1]));
      if (b) out.push({ kind: 'conversation', block: b });
      continue;
    }
    // The outline of a conversation (its choices and directions) isn't prose.
    if (/^\s+(PLAYER|[A-Z][A-Z' .-]+):/.test(row) || row.trim() === ')') continue;
    buf.push(row);
    if (buf.join('\n').length > 900 && !row.trim()) flush();
  }
  flush();
  return out;
}

export class BeatReader {
  constructor(private readonly ai: QuestPlanner) {}

  /** Read one quest into a beat sheet (checked, with what didn't fit asked about again). */
  async read(text: string, opts: BeatReadOptions): Promise<{ sheet: BeatSheet; questions: BeatQuestion[]; blocks: WrittenBlock[] }> {
    const step = opts.onStep ?? (() => undefined);
    this.then.clear();
    this.unread.clear();
    this.notThings.clear();
    const blocks = findDialogue(text).blocks;
    step('finding who and what the quest involves');
    const sheet = await this.entities(text, opts);
    sheet.text = text;
    const parts = passages(text);
    const story = await this.story(parts);
    for (const [i, p] of parts.entries()) {
      step(`reading part ${i + 1} of ${parts.length}${p.kind === 'conversation' ? ` (a conversation with ${p.block.speaker})` : ''}`);
      if (p.kind === 'prose') {
        const told = story(p.text);
        if (told) await this.prose(sheet, told);
      } else await this.conversation(sheet, p.block);
    }
    for (const b of blocks.filter((x) => x.lines.some((l) => l.notes.length))) {
      step(`reading the directions in the conversation with ${b.speaker}`);
      await this.directions(sheet, b, opts);
    }
    this.dropUnremembered(sheet, opts);
    // What else happens, read before the checks so they see it (and items handed over that weren't listed).
    const happenings = async () => {
      if (this.unread.size) {
        step('reading what else happens along the way');
        await this.consequences(sheet);
      }
      this.dropUnremembered(sheet, opts);
      await this.newItems(sheet, text);
    };
    await happenings();
    let questions = checkBeats(sheet, { blocks, earlierChoices: earlierChoices(opts) });
    // Two rounds: an answer can bring up the next question (which beat ends the quest, then what leads nowhere).
    const asked = new Set<string>();
    for (let round = 0; round < 2; round++) {
      const fresh = questions.filter((q) => !q.unsaid && !asked.has(q.message));
      if (!fresh.length) break;
      step(`checking ${fresh.length} thing(s) that don't fit together yet`);
      for (const q of fresh) asked.add(q.message);
      await this.reask(sheet, fresh, text, blocks, opts);
      await happenings();
      questions = checkBeats(sheet, { blocks, earlierChoices: earlierChoices(opts) });
    }
    step('writing the objectives and journal');
    await this.words(sheet, text);
    const unsaid = sheet.beats.filter((b) => b.does === 'talk' && !sheet.dialogue.some((d) => d.lines.some((l) => l.beat === b.id)) && !sheet.lines.some((l) => l.beat === b.id));
    for (const b of unsaid) {
      step(`writing what's said for “${b.quote.slice(0, 40)}”`);
      await this.saying(sheet, b, text);
    }
    if (unsaid.length) questions = checkBeats(sheet, { blocks, earlierChoices: earlierChoices(opts) });
    return { sheet, questions, blocks };
  }

  // ---------------------------------------------------------------- 1. who and what

  private async entities(text: string, opts: BeatReadOptions): Promise<BeatSheet> {
    const known = (opts.earlier ?? []).flatMap((s) => [...s.people.map((p) => p.name), ...s.places.map((p) => p.name), ...s.items.map((p) => p.name)]);
    const a = await this.ai.ask(
      READ_RULES,
      `${opts.shared ? `What the whole questline shares:\n<shared>\n${opts.shared.trim()}\n</shared>\n\n` : ''}${known.length ? `Earlier quests already have: ${known.join(', ')}. Use the same names for them.\n\n` : ''}The quest:\n<quest>\n${text.trim()}\n</quest>\n\nList the people, places, items and enemy groups this quest involves (only the ones it uses), and say how it starts.`,
      EntitiesSchema,
      3000,
    );
    // A name written as "null" or "none" is an empty answer.
    const named = (n: string | null | undefined) => !!n?.trim() && !/^(null|none|n\/a|unknown|nobody|nothing)$/i.test(n.trim());
    a.people = a.people.filter((x) => named(x.name));
    a.places = a.places.filter((x) => named(x.name));
    a.items = a.items.filter((x) => named(x.name));
    a.enemies = a.enemies.filter((x) => named(x.what));
    const taken = new Set<string>();
    const earlier = opts.earlier ?? [];
    const lookup = opts.lookup;
    // Someone or something an earlier quest has keeps its key; anything else is looked up in the game by exact name.
    const reuse = <T extends { key: string; name: string }>(pick: (s: BeatSheet) => T[], name: string) => earlier.map((s) => byName(pick(s), name)).find(Boolean);
    const places: BeatPlace[] = a.places.map((p) => {
      const was = reuse((s) => s.places, p.name);
      const key = was?.key ?? keyFor(p.name, taken);
      taken.add(key);
      const existing = was?.existing ?? lookup?.place(p.name) ?? (p.partOf ? (lookup?.place(p.partOf) ?? null) : null);
      return { key, name: p.name, existing, description: p.description, quote: p.quote };
    });
    const placeKey = (name: string | null) => (name ? (byName(places, name)?.key ?? null) : null);
    const people: BeatPerson[] = a.people.map((p) => {
      const was = reuse((s) => s.people, p.name);
      // People by their first name, as their lines are written ("HESTA:").
      const key = was?.key ?? keyFor(p.name, taken, 1);
      taken.add(key);
      const existing = was?.existing ?? lookup?.person(p.name) ?? null;
      return { key, name: p.name, existing, description: p.description, sex: p.sex, race: p.race, place: placeKey(p.where), spot: p.spot, essential: p.canDie === 'no' ? true : p.canDie === 'yes' ? false : null, hostile: p.hostile, quote: p.quote };
    });
    // The same item named twice (singular and plural, or numbered) is one item.
    const items: BeatItem[] = [];
    for (const i of a.items) {
      const same = byName(items, i.name.replace(/\s*(#\s*)?\d+$/, ''));
      if (same && same.place === placeKey(i.where)) {
        same.count += Math.max(1, i.count);
        if (i.spot) same.spot = [same.spot, i.spot].filter(Boolean).join('; ');
        continue;
      }
      const was = reuse((s) => s.items, i.name);
      const key = was?.key ?? keyFor(i.name, taken);
      taken.add(key);
      items.push({ key, name: i.name.replace(/\s*(#\s*)?\d+$/, ''), kind: i.kind, existing: was?.existing ?? lookup?.item(i.name) ?? null, place: placeKey(i.where), carriedBy: i.carriedBy ? (byName(people, i.carriedBy)?.key ?? null) : null, spot: i.spot, count: Math.max(1, i.count), text: i.text, lockedWith: i.lockedWith, quote: i.quote });
    }
    for (const i of items) if (i.lockedWith) i.lockedWith = byName(items, i.lockedWith)?.key ?? i.lockedWith;
    const groups: BeatGroup[] = a.enemies.map((g) => ({ key: keyFor(g.what, taken), what: g.what, count: Math.max(1, g.count), place: placeKey(g.where) ?? g.where, spot: null, hidden: g.appearLater, quote: g.quote }));
    const all = [...people, ...places, ...items, ...groups.map((g) => ({ ...g, name: g.what }))];
    const startTarget = a.start.what ? byName(all, a.start.what)?.key : undefined;
    const start: BeatStart =
      a.start.how === 'previous quest' || (earlier.length && a.start.how === 'talking')
        ? earlier.length
          ? { kind: 'afterQuest', quest: earlier[earlier.length - 1]!.editorId }
          : { kind: 'game' }
        : a.start.how === 'talking' || !startTarget
          ? { kind: 'game' }
          : { kind: a.start.how === 'reading' ? 'read' : a.start.how === 'picking up' ? 'pickup' : a.start.how === 'arriving' ? 'arrive' : 'use', target: startTarget };
    return { title: opts.title, editorId: opts.editorId, summary: a.summary, start, people, places, items, groups, beats: [], dialogue: [], lines: [] };
  }

  // ---------------------------------------------------------------- 2. beats, passage by passage

  /** Who and what the AI can name, and the beats so far, numbered. */
  private context(sheet: BeatSheet): string {
    const names = (kind: string, list: { name: string }[]) => `${kind}: ${list.map((x) => x.name).join(', ') || 'none'}`;
    const beats = sheet.beats.map((b, i) => `${i + 1}. ${b.does}${b.target ? ` ${this.nameOf(sheet, b.target)}` : ''}${b.after.length ? ` (after ${b.after.map((a) => this.number(sheet, a)).join(', ')})` : ''}${b.ends ? ` — ${b.ends === 'complete' ? 'completes' : 'fails'} the quest` : ''}: “${b.quote}”`);
    return [names('People', sheet.people), names('Places', sheet.places), names('Items', sheet.items), names('Enemies', sheet.groups.map((g) => ({ name: g.what }))), `Beats so far:\n${beats.join('\n') || '(none yet)'}`].join('\n');
  }

  /** The beats as a short numbered list (what is done to whom, and after which), with one of them marked. */
  private outline(sheet: BeatSheet, mark?: string): string {
    return sheet.beats
      .map((b, i) => `${i + 1}. ${b.does}${b.target ? ` ${this.nameOf(sheet, b.target)}` : ''}${b.after.length ? ` (after ${b.after.map((a) => this.number(sheet, a)).join(' or ')})` : ''}${b.ends ? ` — ${b.ends === 'complete' ? 'completes' : 'fails'} the quest` : ''}${b.id === mark ? '   ← this one' : ''}`)
      .join('\n');
  }

  private nameOf(sheet: BeatSheet, key: string): string {
    return [...sheet.people, ...sheet.places, ...sheet.items].find((x) => x.key === key)?.name ?? sheet.groups.find((g) => g.key === key)?.what ?? key;
  }

  private number(sheet: BeatSheet, id: string): number {
    return sheet.beats.findIndex((b) => b.id === id) + 1;
  }

  /** The key a name the AI gave refers to, among the kinds that fit the action. */
  private target(sheet: BeatSheet, name: string | null, kinds: BeatEntityKind[]): string | null {
    if (!name) return null;
    const pools: Record<BeatEntityKind, { key: string; name: string }[]> = { person: sheet.people, place: sheet.places, item: sheet.items, group: sheet.groups.map((g) => ({ key: g.key, name: g.what })) };
    for (const k of kinds) {
      const hit = byName(pools[k], name);
      if (hit) return hit.key;
    }
    // Something of another kind (an enemy group where a person was expected): its key, for the checks to ask about.
    for (const k of ['person', 'place', 'item', 'group'] as const) {
      const hit = byName(pools[k], name);
      if (hit) return hit.key;
    }
    return name;
  }

  private effects(sheet: BeatSheet, e: Partial<z.infer<z.ZodObject<typeof EffectsShape>>>): BeatEffects {
    const person = (n: string) => this.target(sheet, n, ['person'])!;
    const item = (n: string) => this.target(sheet, n, ['item'])!;
    const out: BeatEffects = {};
    if (e.gold) out.gold = e.gold;
    if (e.gives?.length) out.gives = e.gives.map((g) => ({ item: item(g.item), count: Math.max(1, g.count) }));
    if (e.takes?.length) out.takes = e.takes.map((g) => ({ item: item(g.item), count: Math.max(1, g.count) }));
    if (e.remembers) out.remembers = e.remembers.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (e.attacks?.length) out.attacks = e.attacks.map(person);
    if (e.leaves?.length) out.leaves = e.leaves.map(person);
    if (e.follows?.length) out.follows = e.follows.map(person);
    if (e.stopsFollowing?.length) out.stopsFollowing = e.stopsFollowing.map(person);
    if (e.appears?.length) out.appears = e.appears.map((n) => this.target(sheet, n, ['group', 'person'])!);
    if (e.moves?.length) out.moves = e.moves.map((m) => ({ who: person(m.who), to: this.target(sheet, m.to, ['place'])! }));
    return out;
  }

  /** One of the AI's beats, with its names turned into keys and its "after" numbers into beat ids. */
  private toBeat(sheet: BeatSheet, b: z.infer<typeof BeatShape>, id: string, ids: Map<number, string>): Beat {
    const kinds: BeatEntityKind[] = b.does === 'talk' || b.does === 'kill' ? ['person'] : b.does === 'arrive' ? ['place'] : b.does === 'clear' ? ['group'] : b.does === 'use' ? ['item', 'person'] : ['item'];
    return {
      id,
      does: b.does,
      target: b.does === 'wait' || b.does === 'immediately' ? null : this.target(sheet, b.target, kinds),
      count: b.count,
      hours: b.hours,
      after: b.after.map((n) => ids.get(n)).filter((x): x is string => !!x && x !== id),
      quote: b.quote,
      journal: null,
      objective: null,
      ends: b.ends === 'no' ? null : b.ends,
      effects: {},
    };
  }

  /** What else happens along with each beat, in the author's words; read into effects once the beats are in. */
  private readonly then = new Map<string, string>();
  /** Names the AI said aren't things the player can carry ("the job"): not asked about again. */
  private readonly notThings = new Set<string>();
  /** Beats whose "then" isn't read into effects yet. */
  private readonly unread = new Set<string>();

  /** The AI's beats (numbered after the ones so far) into the sheet; returns every beat's id by number. */
  private addBeats(sheet: BeatSheet, beats: z.infer<typeof BeatShape>[]): Map<number, string> {
    const ids = new Map(sheet.beats.map((b, i) => [i + 1, b.id] as const));
    const first = sheet.beats.length + 1;
    // The AI's own numbers, when they number the new beats one each from where the list left off; by order otherwise.
    const own = beats.map((b) => b.n);
    const byOwn = new Set(own).size === own.length && own.every((n) => n >= first && n < first + beats.length);
    beats.forEach((b, i) => ids.set(byOwn ? b.n : first + i, `b${first + i}`));
    for (const [i, b] of beats.entries()) {
      const id = `b${first + i}`;
      sheet.beats.push(this.toBeat(sheet, b, id, ids));
      if (b.then?.trim()) (this.then.set(id, b.then.trim()), this.unread.add(id));
    }
    return ids;
  }

  /**
   * Which of the author's prose paragraphs tell what happens (the rest are journal entries, objectives, greetings,
   * headings or notes, which add no beats): asked once for the whole quest. Returns a passage's story paragraphs.
   */
  private async story(parts: ReturnType<typeof passages>): Promise<(passage: string) => string> {
    const split = (t: string) => t.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
    const all = parts.flatMap((p) => (p.kind === 'prose' ? split(p.text) : []));
    const keep = new Set(all);
    if (all.length > 1) {
      try {
        const a = await this.ai.ask(
          READ_RULES,
          `The author's text, paragraph by paragraph (written conversations left out):\n${all.map((x, i) => `[${i + 1}] ${x}`).join('\n\n')}\n\nWhich paragraphs tell what happens in the quest, and which are a journal, objectives, greetings or idle lines, a heading, or notes?`,
          paragraphsSchema(all.length),
          60 + all.length * 25,
        );
        for (const x of a.paragraphs) if (x.is !== 'what happens' && all[x.n - 1]) keep.delete(all[x.n - 1]!);
      } catch {
        // Read them all, then.
      }
    }
    return (passage) => split(passage).filter((x) => keep.has(x)).join('\n\n');
  }

  private async prose(sheet: BeatSheet, text: string): Promise<void> {
    const a = await this.ai.ask(
      READ_RULES,
      `${this.context(sheet)}\n\nThe next part of the quest:\n<passage>\n${text}\n</passage>\n\nWhat does the player do in this part that moves the quest on? Give each as a new beat (numbered after the beats so far), or none if it adds none (a description, or something already listed). A beat is something the player does: talking to someone (being asked for help, taking a job, talking someone down, bringing something back), picking up or reading something, going somewhere, killing. What others do in answer (someone pays, hands something over, leaves) goes in “then” of that beat. Where the player can do one thing or another (“kill them, or talk him down”), give each way as its own beat, both after the same beat. The last thing the player does completes the quest. Journal entries, objectives, rewards and summaries the author lists describe beats already there: they add none.`,
      PassageSchema,
      3500,
    );
    this.addBeats(sheet, a.beats);
  }

  private async conversation(sheet: BeatSheet, block: WrittenBlock): Promise<void> {
    const numbered = structuredClone(block);
    numbered.lines.forEach((l, i) => (l.n = i + 1));
    const beats = sheet.beats.map((_, i) => i + 1);
    // Lines that can move the quest on: what the others say; where the author put directions on some lines, only those.
    const others = numbered.lines.filter((l) => !l.player);
    const said = (others.some((l) => l.notes.length) ? others.filter((l) => l.notes.length) : others).map((l) => l.n);
    // Talk beats nothing says yet, with someone who speaks here: the ones a line can turn out to be.
    const sayers = new Set(sheet.dialogue.flatMap((d) => d.lines.map((x) => x.beat)));
    const speakers = new Set(others.map((l) => byName(sheet.people, l.speaker)?.key));
    const talks = sheet.beats.map((b, i) => [b, i + 1] as const).filter(([b]) => b.does === 'talk' && !sayers.has(b.id) && speakers.has(b.target ?? undefined));
    const label = (b: Beat, n: number) => `beat ${n}: talk ${this.nameOf(sheet, b.target!)}`;
    const choices = ['only talk', 'a new step', ...talks.map(([b, n]) => label(b, n))];
    const r = await this.ai.ask(
      READ_RULES,
      `${this.context(sheet)}\n\nA conversation the author wrote out (numbered lines; the author's directions after "—"):\n${describeBlocks([numbered])}\n\nAfter which beat can the player have this conversation? And for each of lines ${said.join(', ')}: does saying it only talk, do one of the beats above, or move the quest on in a new step?`,
      conversationSchema(beats, said, choices),
    );
    const a = {
      when: r.when,
      moves: r.lines.flatMap((x) => {
        const c = x.does.trim().toLowerCase();
        if (c === 'a new step') return [{ line: x.line, words: '', beat: null as number | null }];
        const hit = talks.find(([b, n]) => label(b, n).toLowerCase() === c || c === `beat ${n}`);
        return hit ? [{ line: x.line, words: '', beat: hit[1] as number | null }] : [];
      }),
    };
    const when = a.when ? (sheet.beats[a.when - 1]?.id ?? null) : null;
    // Each line that moves the quest on is talking to whoever says it. It comes after the nearest line above it in the
    // conversation that also moved the quest on (the author's indenting), or after the beat the conversation follows.
    const moved = new Map<number, string>();
    const lines: BeatDialogueLine[] = [];
    for (const m of [...a.moves].sort((x, y) => x.line - y.line)) {
      const n = lineFor(numbered, m.line, m.words);
      const l = n ? numbered.lines[n - 1] : undefined;
      if (!n || !l || l.player || moved.has(n) || !said.includes(n)) continue;
      // An earlier beat only when it's talking to this line's speaker and no line says it yet; a new beat otherwise.
      const speaker = byName(sheet.people, l.speaker)?.key;
      const earlier = m.beat ? sheet.beats[m.beat - 1] : undefined;
      const free = earlier && earlier.does === 'talk' && earlier.target === speaker && ![...sheet.dialogue.flatMap((d) => d.lines), ...lines].some((x) => x.beat === earlier.id);
      let id = free ? earlier.id : undefined;
      if (!id) {
        let above: string | undefined;
        for (let k = n - 1, level = l.level; k >= 1 && !above; k--) {
          const x = numbered.lines[k - 1]!;
          if (x.level < level) {
            level = x.level;
            above = moved.get(k);
          }
        }
        const who = byName(sheet.people, l.speaker);
        id = `b${sheet.beats.length + 1}`;
        // (Which beat ends the quest is asked once all of it is read.)
        // Its quote carries the author's direction ("the player agrees to clear the cellar"): what later beats follow.
        const quote = `${l.text}${l.notes.length ? ` (${l.notes.join('; ')})` : ''}`;
        sheet.beats.push({ id, does: 'talk', target: who?.key ?? l.speaker, after: above ? [above] : when ? [when] : [], quote, journal: null, objective: null, ends: null, effects: {} });
      }
      moved.set(n, id);
      lines.push({ line: n, beat: id });
    }
    sheet.dialogue.push({ block: block.id, when, lines });
  }


  // ---------------------------------------------------------------- 3. the directions on written lines

  private async directions(sheet: BeatSheet, block: WrittenBlock, opts: BeatReadOptions): Promise<void> {
    const numbered = structuredClone(block);
    numbered.lines.forEach((l, i) => (l.n = i + 1));
    const choices = [...earlierChoices(opts), ...rememberedIn(sheet)];
    const a = await this.ai.ask(
      READ_RULES,
      `${this.context(sheet)}\nChoices remembered so far: ${choices.join(', ') || 'none'}\n\nA conversation the author wrote out (numbered lines; directions after "—"):\n${describeBlocks([numbered])}\n\nFor each line with a direction: when is it said (conditions), and what does saying it do (gold, items, a choice remembered, someone attacking or leaving)? Leave out lines that need nothing.`,
      LinesSchema,
    );
    const d = sheet.dialogue.find((x) => x.block === block.id) ?? (sheet.dialogue.push({ block: block.id, when: null, lines: [] }), sheet.dialogue[sheet.dialogue.length - 1]!);
    for (const l of a.lines) {
      const n = lineFor(numbered, l.line, l.words);
      if (!n) continue;
      const entry = d.lines.find((x) => x.line === n) ?? (d.lines.push({ line: n }), d.lines[d.lines.length - 1]!);
      const conds = this.conditions(sheet, l.if);
      if (conds.length) entry.if = conds;
      const e = this.effects(sheet, l);
      if (Object.keys(e).length) entry.effects = { ...(entry.effects ?? {}), ...e };
      const instead = l.instead.map((v) => ({ if: this.conditions(sheet, v.if), effects: v.gold ? { gold: v.gold } : {} })).filter((v) => v.if.length);
      if (instead.length) entry.variants = instead;
    }
  }

  private conditions(sheet: BeatSheet, list: z.infer<typeof ConditionShape>[]): BeatCondition[] {
    const out: BeatCondition[] = [];
    for (const c of list) {
      const v = c.value?.trim() ?? '';
      if (c.kind === 'chose' || c.kind === 'not chose') v && out.push({ kind: 'choice', name: v.toLowerCase().replace(/[^a-z0-9]+/g, ''), ...(c.kind === 'not chose' ? { not: true } : {}) });
      else if (c.kind === 'done') {
        const id = sheet.beats[Number(v) - 1]?.id;
        if (id) out.push({ kind: 'done', beat: id });
      } else if (c.kind === 'dead' || c.kind === 'alive') v && out.push({ kind: 'dead', who: this.target(sheet, v, ['person'])!, ...(c.kind === 'alive' ? { not: true } : {}) });
      else if (c.kind === 'left') v && out.push({ kind: 'left', who: this.target(sheet, v, ['person'])! });
      else if (c.kind === 'gold') Number(v) > 0 && out.push({ kind: 'gold', amount: Number(v) });
      else out.push({ kind: 'time', when: c.kind });
    }
    return out;
  }

  // ---------------------------------------------------------------- 4. what doesn't fit, asked again

  private async reask(sheet: BeatSheet, questions: BeatQuestion[], text: string, blocks: WrittenBlock[], opts: BeatReadOptions): Promise<void> {
    const byBeat = new Map<string, BeatQuestion[]>();
    for (const q of questions.filter((x) => !x.unsaid)) byBeat.set(q.about, [...(byBeat.get(q.about) ?? []), q]);
    for (const [about, qs] of byBeat) {
      const i = sheet.beats.findIndex((b) => b.id === about);
      if (i >= 0) {
        // Closed questions first: which reading fits, what comes next.
        let open = qs;
        for (const q of qs.filter((x) => x.choose || x.next || x.endsEarly || x.same)) if (await this.closed(sheet, sheet.beats[i]!, q, text)) open = open.filter((x) => x !== q);
        if (!open.length) continue;
        // Otherwise the AI gives the beat again, corrected.
        const b = sheet.beats[i]!;
        try {
          const a = await this.ai.ask(
            READ_RULES,
            `${this.context(sheet)}\n\nThe quest:\n<quest>\n${text.trim()}\n</quest>\n\nBeat ${i + 1} (“${b.quote}”) doesn't fit yet:\n${open.map((q) => `- ${q.message}`).join('\n')}\n\nGive beat ${i + 1} again, corrected. If its action isn't what the quote describes, choose the one it does.`,
            BeatShape,
          );
          sheet.beats[i] = this.toBeat(sheet, a, b.id, new Map(sheet.beats.map((x, n) => [n + 1, x.id] as const)));
          if (a.then?.trim() && a.then.trim() !== this.then.get(b.id)) (this.then.set(b.id, a.then.trim()), this.unread.add(b.id));
          else if (!a.then?.trim()) this.then.delete(b.id);
        } catch {
          // Left as it was; the review shows the question.
        }
        continue;
      }
      const picks = qs.filter((q) => q.pick);
      if (picks.length) {
        // A person, item or group naming something missing: picked from what there is.
        const pools: Record<BeatEntityKind, { key: string; name: string }[]> = { person: sheet.people, place: sheet.places, item: sheet.items, group: sheet.groups.map((g) => ({ key: g.key, name: g.what })) };
        const owner = [...sheet.people, ...sheet.items, ...sheet.groups].find((x) => x.key === about) as Record<string, unknown> | undefined;
        for (const q of picks) {
          const pool = pools[q.pick!.kind];
          if (!owner || !pool.length) continue;
          try {
            const a = await this.ai.ask(
              READ_RULES,
              `The quest:\n<quest>\n${text.trim()}\n</quest>\n\n${q.message} Which ${q.pick!.kind} is meant?`,
              z.object({ answer: z.string().nullable().describe(`{enum: ${JSON.stringify(pool.map((x) => x.name))}} null if none of them`) }),
              200,
            );
            owner[q.pick!.field] = a.answer ? (byName(pool, a.answer)?.key ?? null) : null;
          } catch {
            // Left as it was.
          }
        }
        continue;
      }
      const ending = qs.find((q) => q.ending);
      if (ending) {
        try {
          const a = await this.ai.ask(
            READ_RULES,
            `The quest:\n<quest>\n${text.trim()}\n</quest>\n\nBeats, in order:\n${this.outline(sheet)}\n\n${ending.message}`,
            z.object({ beat: z.number().int().describe(`The beat that completes the quest {enum: ${JSON.stringify(sheet.beats.map((_, x) => x + 1))}}`) }),
            100,
          );
          const b = sheet.beats[a.beat - 1];
          if (b) b.ends = 'complete';
        } catch {
          // Left as it was; the review shows the question.
        }
        continue;
      }
      const block = /^block (\d+)$/.exec(about)?.[1];
      if (block) {
        const b = blocks.find((x) => x.id === Number(block));
        if (!b) continue;
        // A conversation's lines: read again with the question in view.
        const d = sheet.dialogue.find((x) => x.block === b.id);
        if (d) d.lines = d.lines.filter((l) => l.beat && sheet.beats.some((x) => x.id === l.beat));
        try {
          await this.directions(sheet, b, { ...opts, onStep: undefined });
        } catch {
          // Left as it was.
        }
      }
    }
  }

  /** A question with a closed answer about one beat: which of the readings fits, or what comes after it. */
  private async closed(sheet: BeatSheet, b: Beat, q: BeatQuestion, text: string): Promise<boolean> {
    const n = this.number(sheet, b.id);
    try {
      if (q.choose) {
        const labels = q.choose.map((c) => c.label);
        const a = await this.ai.ask(
          READ_RULES,
          `The quest:\n<quest>\n${text.trim()}\n</quest>\n\nBeats, in order:\n${this.outline(sheet, b.id)}\n\n${q.message}`,
          z.object({ answer: z.string().describe(`What the player does in beat ${n} {enum: ${JSON.stringify(labels)}}`) }),
          200,
        );
        const c = q.choose.find((x) => x.label.toLowerCase() === a.answer.trim().toLowerCase());
        if (!c) return false;
        b.does = c.does;
        b.target = c.target;
        return true;
      }
      if (q.same) {
        const a = await this.ai.ask(
          READ_RULES,
          `The quest:\n<quest>\n${text.trim()}\n</quest>\n\nBeats, in order:\n${this.outline(sheet, b.id)}\n\n${q.message}`,
          z.object({ same: z.boolean().describe(`True when beat ${n} is the same moment as the beat before it, read twice`) }),
          40,
        );
        if (a.same) mergeBeat(sheet, b.id, q.same, this.then);
        return true;
      }
      if (q.endsEarly) {
        const a = await this.ai.ask(
          READ_RULES,
          `The quest:\n<quest>\n${text.trim()}\n</quest>\n\nBeats, in order:\n${this.outline(sheet, b.id)}\n\n${q.message}`,
          z.object({ ends: z.enum(['complete', 'fail', 'no']).describe(`Whether beat ${n} finishes the quest (complete), fails it, or the quest goes on (no)`) }),
          60,
        );
        b.ends = a.ends === 'no' ? null : a.ends;
        return true;
      }
      if (q.next) {
        // Only beats that don't already come before it (anything else would loop).
        const before = new Set<string>([b.id]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const x of sheet.beats) if (before.has(x.id)) for (const a of x.after) if (!before.has(a)) (before.add(a), (grew = true));
        }
        const others = sheet.beats.map((x, i) => [x, i + 1] as const).filter(([x]) => !before.has(x.id)).map(([, i]) => i);
        if (!others.length) return false;
        const a = await this.ai.ask(
          READ_RULES,
          `The quest:\n<quest>\n${text.trim()}\n</quest>\n\nBeats, in order:\n${this.outline(sheet, b.id)}\n\n${q.message}`,
          z.object({
            next: z.number().int().nullable().describe(`The beat that comes right after beat ${n}; null if it ends the quest {enum: ${JSON.stringify(others)}}`),
            ends: z.enum(['complete', 'fail', 'no']).describe(`Whether beat ${n} itself finishes the quest (complete) or fails it`),
          }),
          200,
        );
        if (a.ends !== 'no') b.ends = a.ends;
        for (const x of [a.next].filter((y): y is number => y !== null && others.includes(y))) {
          const later = sheet.beats[x - 1];
          if (later && later !== b && !later.after.includes(b.id)) later.after.push(b.id);
        }
        return a.ends !== 'no' || (a.next !== null && others.includes(a.next));
      }
    } catch {
      // Asked again as a whole beat.
    }
    return false;
  }

  // ---------------------------------------------------------------- 5. what else happens, and the journal

  private async consequences(sheet: BeatSheet): Promise<void> {
    const list = sheet.beats.map((b, i) => [b, i + 1] as const).filter(([b]) => this.unread.has(b.id) && this.then.has(b.id));
    this.unread.clear();
    if (!list.length) return;
    try {
      const a = await this.ai.ask(
        READ_RULES,
        `${this.context(sheet)}\n\nWhat else happens along with these beats:\n${list.map(([b, n]) => `Beat ${n}: “${this.then.get(b.id)}”`).join('\n')}\n\nFor each, give what it does to the game: gold, items given or taken, a choice remembered, people attacking, leaving, following or appearing.`,
        thenSchema(list.map(([, n]) => n)),
      );
      for (const e of a.beats) {
        const b = sheet.beats[e.n - 1];
        if (!b || !list.some(([x]) => x === b)) continue;
        b.effects = this.effects(sheet, e);
        const instead = e.instead
          .filter((v) => v.gold !== null)
          .map((v) => ({ if: this.conditions(sheet, v.if), effects: { gold: v.gold! } }))
          .filter((v) => v.if.length);
        if (instead.length) b.variants = instead;
      }
    } catch {
      // Left without; the review shows what the author wrote.
    }
  }

  /**
   * A choice a line is said under that nothing in this quest or an earlier one remembers is a misreading of the
   * conversation's own branching (answering a player line): it's dropped.
   */
  private dropUnremembered(sheet: BeatSheet, opts: BeatReadOptions): void {
    const remembered = new Set([...earlierChoices(opts), ...rememberedIn(sheet)]);
    const keep = (c: BeatCondition) => c.kind !== 'choice' || remembered.has(c.name);
    for (const d of sheet.dialogue)
      for (const l of d.lines) {
        if (l.if) l.if = l.if.filter(keep);
        if (l.if && !l.if.length) delete l.if;
        if (l.variants) l.variants = l.variants.filter((v) => v.if.every(keep));
      }
  }

  /** Items handed over that aren't in the list yet (a reward the first reading left out): added, with their kind asked. */
  private async newItems(sheet: BeatSheet, text: string): Promise<void> {
    const known = new Set(sheet.items.map((i) => i.key));
    const effects = [...sheet.beats.flatMap((b) => [b.effects, ...(b.variants ?? []).map((v) => v.effects)]), ...sheet.dialogue.flatMap((d) => d.lines.flatMap((l) => [l.effects, ...(l.variants ?? []).map((v) => v.effects)]))];
    const names = [...new Set(effects.flatMap((e) => [...(e?.gives ?? []), ...(e?.takes ?? [])].map((g) => g.item)).filter((x) => !known.has(x)))];
    const taken = new Set([...sheet.people, ...sheet.places, ...sheet.items, ...sheet.groups].map((x) => x.key));
    const drop = (name: string) => {
      for (const e of effects) {
        if (e?.gives) e.gives = e.gives.filter((g) => g.item !== name);
        if (e?.takes) e.takes = e.takes.filter((g) => g.item !== name);
      }
    };
    for (const name of names) {
      if (this.notThings.has(name)) {
        drop(name);
        continue;
      }
      let kind: BeatItem['kind'] = 'misc';
      try {
        const a = await this.ai.ask(READ_RULES, `The quest:\n<quest>\n${text.trim()}\n</quest>\n\nWhat kind of thing is “${name}”, handed to or taken from the player?`, z.object({ kind: z.enum([...ITEM_KINDS, 'not a thing']).describe('"not a thing" when it is not something the player can carry (a job, a promise, a favour)') }), 60);
        if (a.kind === 'not a thing') {
          // Handed over in words only: no item.
          this.notThings.add(name);
          drop(name);
          continue;
        }
        kind = a.kind;
      } catch {
        // A misc item, then.
      }
      const key = keyFor(name, taken);
      taken.add(key);
      sheet.items.push({ key, name, kind, existing: null, place: null, carriedBy: null, spot: null, count: 1, text: null, lockedWith: null, quote: '' });
      for (const e of effects) for (const g of [...(e?.gives ?? []), ...(e?.takes ?? [])]) if (g.item === name) g.item = key;
    }
  }

  private async words(sheet: BeatSheet, text: string): Promise<void> {
    if (!sheet.beats.length) return;
    try {
      const a = await this.ai.ask(
        WRITE_RULES,
        `The quest:\n<quest>\n${text.trim()}\n</quest>\n\nIts beats, in order:\n${this.outline(sheet)}\n\nFor every beat: the objective the player is shown to make it happen, and their journal entry once it's done. Write them in your own words; where the author wrote an objective or journal entry, use it.`,
        WordsSchema,
        Math.min(4000, 400 + sheet.beats.length * 120),
      );
      for (const w of a.beats) {
        const b = sheet.beats[w.n - 1];
        if (!b) continue;
        b.objective = w.objective.trim() || null;
        b.journal = w.journal.trim() || null;
      }
    } catch {
      // Left without; the compiled quest falls back to its own words.
    }
  }

  // ---------------------------------------------------------------- 6. what's said, where the author didn't write it

  private async saying(sheet: BeatSheet, b: Beat, text: string): Promise<void> {
    const who = sheet.people.find((p) => p.key === b.target);
    try {
      const n = this.number(sheet, b.id);
      const a = await this.ai.ask(
        WRITE_RULES,
        `The quest:\n<quest>\n${text.trim()}\n</quest>\n\nIts beats, in order:\n${this.outline(sheet, b.id)}\n\nWrite beat ${n}: what the player says to ${who?.name ?? 'them'}, and the answer. It's said ${b.after.length ? `once ${b.after.map((x) => `beat ${this.number(sheet, x)}`).join(' or ')} has happened` : 'when the quest begins'}${b.ends === 'complete' ? ', and finishes the quest' : ''}; say only what belongs to this moment (“${b.quote}”).`,
        SayingSchema,
        600,
      );
      sheet.lines.push({ beat: b.id, player: a.player, answer: a.answer });
    } catch {
      // Left without; the review shows the question.
    }
  }
}

/** One beat folded into another (the same moment read twice): what follows it, says it or ends with it moves over. */
function mergeBeat(sheet: BeatSheet, from: string, into: string, then: Map<string, string>): void {
  const a = sheet.beats.find((x) => x.id === into);
  const b = sheet.beats.find((x) => x.id === from);
  if (!a || !b) return;
  a.ends ??= b.ends;
  a.effects = { ...b.effects, ...a.effects };
  if (b.variants?.length) a.variants ??= b.variants;
  const words = [then.get(into), then.get(from)].filter(Boolean).join(' ');
  if (words) then.set(into, words);
  then.delete(from);
  sheet.beats = sheet.beats.filter((x) => x !== b);
  for (const x of sheet.beats) x.after = [...new Set(x.after.map((y) => (y === from ? into : y)))].filter((y) => y !== x.id);
  for (const d of sheet.dialogue) {
    if (d.when === from) d.when = into;
    for (const l of d.lines) if (l.beat === from) l.beat = into;
  }
  sheet.lines = sheet.lines.filter((l) => l.beat !== from || !sheet.lines.some((x) => x.beat === into));
  for (const l of sheet.lines) if (l.beat === from) l.beat = into;
}

/** The line the AI meant: by number, unless its first words say another line nearby. */
function lineFor(block: WrittenBlock, n: number, words: string | undefined): number | undefined {
  const w = (words ?? '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').trim();
  const starts = (i: number) => {
    const l = block.lines[i - 1];
    return !!l && (!w || l.text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').trim().startsWith(w));
  };
  if (starts(n)) return n;
  for (const d of [1, -1, 2, -2]) if (starts(n + d)) return n + d;
  return block.lines[n - 1] ? n : undefined;
}

function earlierChoices(opts: BeatReadOptions): string[] {
  return (opts.earlier ?? []).flatMap(rememberedIn);
}

function rememberedIn(sheet: BeatSheet): string[] {
  return [...new Set([...sheet.beats.map((b) => b.effects?.remembers), ...sheet.dialogue.flatMap((d) => d.lines.flatMap((l) => [l.effects?.remembers, ...(l.variants ?? []).map((v) => v.effects?.remembers)]))].filter((x): x is string => !!x))];
}
