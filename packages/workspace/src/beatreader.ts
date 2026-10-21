/**
 * Reading an author's quest into a beat sheet (beats.ts) with any AI, free or not, in small questions:
 *
 *   1. who and what the quest involves (people, places, items, enemies), each with the sentence it comes from;
 *   2. passage by passage, in the author's order: what the player does that moves the quest on (beats), and for a
 *      written conversation, when it's offered and which of its lines do what;
 *   3. for the written lines with directions: when they're said, and what saying them does;
 *   4. what checkBeats finds that doesn't fit together, asked again about that one beat or line;
 *   5. for talk beats the author only describes, the line that does it.
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
import type { QuestPlanner } from './planner';
import { describeBlocks, findDialogue, type WrittenBlock } from './written';

/** What's already in the game, by exact name (the host looks it up in the load order). */
export interface BeatLookup {
  person(name: string): string | null;
  /** An interior with that name, or a place on the world map. */
  place(name: string): string | null;
  item(name: string): string | null;
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

const ITEM_KINDS = ['misc', 'book', 'key', 'gold', 'clothing', 'armor', 'weapon', 'potion', 'other'] as const;

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
  ),
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
  does: z.enum(BEAT_ACTIONS).describe('What the player does: talk (to someone), pickup, read, use, arrive (at a place), kill (someone), clear (every enemy in a group dead), wait (some in-game hours), immediately (right after the beats before)'),
  target: z.string().nullable().describe('The name of the person, item, place or enemies it is done to (from the lists); null for wait and immediately'),
  count: z.number().int().nullable().describe('pickup: how many'),
  hours: z.number().nullable().describe('wait: how many in-game hours'),
  after: z.array(z.number().int()).describe('The numbers of the beats that must happen before this one; empty when it can happen from the start. Two endings each come after the same beat; the beat after them lists both'),
  quote: z.string(),
  journal: z.string().nullable().describe("The player's journal once it's done, in the first person; the author's words where given"),
  objective: z.string().nullable().describe('What the player is told to do for this beat, e.g. "Find the three pages"'),
  ends: z.enum(['complete', 'fail', 'no']).describe('Whether reaching it finishes the quest (complete) or fails it'),
  ...EffectsShape,
});

const PassageSchema = z.object({
  beats: z.array(BeatShape).describe('New beats this passage adds (none if it adds none)'),
});

const ConversationSchema = z.object({
  beats: z.array(BeatShape).describe('New beats this conversation adds, numbered after the ones listed'),
  when: z.number().int().nullable().describe('The number of the beat after which this conversation is offered; null when it is offered whenever the quest runs'),
  lines: z.array(z.object({ line: z.number().int(), words: z.string().describe('Its first three words'), beat: z.number().int().describe('The beat it completes') })).describe('The lines whose saying completes a beat (often the answer the author marks "takes the job", "the quest is done"…)'),
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
      if: z.array(ConditionShape).describe('When it is said, from the author\'s direction ("only if…", "if Varro left")'),
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
  return list.find((x) => norm(x.name) === n || x.key.toLowerCase() === name.toLowerCase()) ?? list.find((x) => norm(x.name).split(' ')[0] === n.split(' ')[0] && n.length > 2) ?? list.find((x) => norm(x.name).includes(n) || n.includes(norm(x.name)));
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
    const blocks = findDialogue(text).blocks;
    step('finding who and what the quest involves');
    const sheet = await this.entities(text, opts);
    const parts = passages(text);
    for (const [i, p] of parts.entries()) {
      step(`reading part ${i + 1} of ${parts.length}${p.kind === 'conversation' ? ` (a conversation with ${p.block.speaker})` : ''}`);
      if (p.kind === 'prose') await this.prose(sheet, p.text);
      else await this.conversation(sheet, p.block);
    }
    for (const b of blocks.filter((x) => x.lines.some((l) => l.notes.length))) {
      step(`reading the directions in the conversation with ${b.speaker}`);
      await this.directions(sheet, b, opts);
    }
    let questions = checkBeats(sheet, { blocks, earlierChoices: earlierChoices(opts) });
    if (questions.length) {
      step(`checking ${questions.length} thing(s) that don't fit together yet`);
      await this.reask(sheet, questions, text, blocks, opts);
      questions = checkBeats(sheet, { blocks, earlierChoices: earlierChoices(opts) });
    }
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
      journal: b.journal,
      objective: b.objective,
      ends: b.ends === 'no' ? null : b.ends,
      effects: this.effects(sheet, b),
    };
  }

  /** The AI's beats (numbered after the ones so far) into the sheet; returns every beat's id by number. */
  private addBeats(sheet: BeatSheet, beats: z.infer<typeof BeatShape>[]): Map<number, string> {
    const ids = new Map(sheet.beats.map((b, i) => [i + 1, b.id] as const));
    const first = sheet.beats.length + 1;
    beats.forEach((_, i) => ids.set(first + i, `b${first + i}`));
    for (const [i, b] of beats.entries()) sheet.beats.push(this.toBeat(sheet, b, `b${first + i}`, ids));
    return ids;
  }

  private async prose(sheet: BeatSheet, text: string): Promise<void> {
    const a = await this.ai.ask(
      READ_RULES,
      `${this.context(sheet)}\n\nThe next part of the quest:\n<passage>\n${text}\n</passage>\n\nWhat does the player do in this part that moves the quest on? Give each as a new beat (numbered after the beats so far), or none if it adds none (a description, or something already listed).`,
      PassageSchema,
    );
    this.addBeats(sheet, a.beats);
  }

  private async conversation(sheet: BeatSheet, block: WrittenBlock): Promise<void> {
    const numbered = structuredClone(block);
    numbered.lines.forEach((l, i) => (l.n = i + 1));
    const a = await this.ai.ask(
      READ_RULES,
      `${this.context(sheet)}\n\nA conversation the author wrote out (numbered lines; the author's directions after "—"):\n${describeBlocks([numbered])}\n\nWhich beats does this conversation complete (new ones numbered after the beats so far, or ones already listed)? Which lines complete them? After which beat is it offered?`,
      ConversationSchema,
    );
    const ids = this.addBeats(sheet, a.beats);
    const lines: BeatDialogueLine[] = [];
    for (const l of a.lines) {
      const n = lineFor(numbered, l.line, l.words);
      const beat = ids.get(l.beat);
      if (n && beat && !lines.some((x) => x.line === n)) lines.push({ line: n, beat });
    }
    sheet.dialogue.push({ block: block.id, when: a.when ? (ids.get(a.when) ?? null) : null, lines });
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
      const instead = l.instead.filter((v) => v.if.length).map((v) => ({ if: this.conditions(sheet, v.if), effects: v.gold ? { gold: v.gold } : {} }));
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
    for (const q of questions) byBeat.set(q.about, [...(byBeat.get(q.about) ?? []), q]);
    for (const [about, qs] of byBeat) {
      const i = sheet.beats.findIndex((b) => b.id === about);
      if (i >= 0) {
        // One beat: the AI gives it again, corrected.
        const b = sheet.beats[i]!;
        try {
          const a = await this.ai.ask(
            READ_RULES,
            `${this.context(sheet)}\n\nThe quest:\n<quest>\n${text.trim()}\n</quest>\n\nBeat ${i + 1} (“${b.quote}”) doesn't fit yet:\n${qs.map((q) => `- ${q.message}`).join('\n')}\n\nGive beat ${i + 1} again, corrected.`,
            BeatShape,
          );
          sheet.beats[i] = this.toBeat(sheet, a, b.id, new Map(sheet.beats.map((x, n) => [n + 1, x.id] as const)));
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

  // ---------------------------------------------------------------- 5. what's said, where the author didn't write it

  private async saying(sheet: BeatSheet, b: Beat, text: string): Promise<void> {
    const who = sheet.people.find((p) => p.key === b.target);
    try {
      const a = await this.ai.ask(
        `You write one exchange of dialogue for a Skyrim quest, in the author's tone: what the player says, and the answer. Short, plain, no game terms. Answer in the JSON format given.`,
        `The quest:\n<quest>\n${text.trim()}\n</quest>\n\nWrite what the player says to ${who?.name ?? 'them'}, and the answer, for this moment: “${b.quote}”.`,
        SayingSchema,
        600,
      );
      sheet.lines.push({ beat: b.id, player: a.player, answer: a.answer });
    } catch {
      // Left without; the review shows the question.
    }
  }
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
