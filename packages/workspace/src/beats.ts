/**
 * The beat sheet: a quest's spine as the AI reads it from the author's text, before anything is built.
 *
 * Reading language is the AI's job; keeping the books is this file's. The AI says, passage by passage, who and what
 * the quest involves and what the player does that moves it on (each beat with the author's sentence it comes from).
 * Here the beats become a quest plan: stages are numbered from the order the beats must happen in, every step,
 * objective, journal entry and dialogue tag comes from the same beats, so the plan and the dialogue can't disagree.
 * checkBeats says what doesn't fit together (a beat nothing can reach, a target that isn't in the sheet, a condition
 * on a choice nothing remembers), as questions the AI can be asked about one beat at a time. Nothing here interprets
 * the author's wording.
 */
import type { PlanCharacter, PlanEncounter, PlanEvent, PlanItem, PlanLocation, PlanStep, QuestPlan } from './questplan';
import { writtenScreenplay, type WrittenBlock, type WrittenLine } from './written';

/** What the player does that completes a beat. */
export const BEAT_ACTIONS = ['talk', 'pickup', 'read', 'use', 'arrive', 'kill', 'clear', 'wait', 'immediately'] as const;
export type BeatAction = (typeof BEAT_ACTIONS)[number];

/** Which kind of thing each action is done to (null: nothing). */
export const ACTION_TARGET: Record<BeatAction, BeatEntityKind | 'person|item' | null> = {
  talk: 'person',
  pickup: 'item',
  read: 'item',
  use: 'person|item',
  arrive: 'place',
  kill: 'person',
  clear: 'group',
  wait: null,
  immediately: null,
};

export type BeatEntityKind = 'person' | 'place' | 'item' | 'group';

export interface BeatPerson {
  key: string;
  name: string;
  /** Editor ID of a character already in the game (found by name in the load order), or null for a new one. */
  existing: string | null;
  /** Who they are, in the author's words. */
  description: string;
  sex: 'male' | 'female' | null;
  race: string | null;
  /** Place key where they are when the quest begins (null: where they already are in the game). */
  place: string | null;
  spot: string | null;
  /** True: can't be killed; false: can; null: leave it. */
  essential: boolean | null;
  /** Attacks the player on sight. */
  hostile: boolean;
  /** The author's sentence about them. */
  quote: string;
}

export interface BeatPlace {
  key: string;
  name: string;
  /** Editor ID of a cell, or the name of a place on the world map; null for a new interior. */
  existing: string | null;
  description: string;
  quote: string;
}

export interface BeatItem {
  key: string;
  name: string;
  kind: PlanItem['kind'];
  existing: string | null;
  /** Where it lies when the quest begins (place key), or who carries it (person key); both null: given later. */
  place: string | null;
  carriedBy: string | null;
  /** Where in the place; one per copy, separated by ";". */
  spot: string | null;
  count: number;
  /** A note's or book's words, from the author's text. */
  text: string | null;
  /** Item key of the key that locks the container it's in. */
  lockedWith: string | null;
  quote: string;
}

export interface BeatGroup {
  key: string;
  /** What the enemies are ("bandit", "draugr", or an Editor ID). */
  what: string;
  count: number;
  place: string;
  spot: string | null;
  /** Hidden until a beat shows them (an ambush). */
  hidden: boolean;
  quote: string;
}

/** A condition on a line of dialogue (when it can be said), from what the author's direction says. */
export type BeatCondition =
  | { kind: 'choice'; name: string; not?: boolean }
  | { kind: 'done'; beat: string; not?: boolean }
  | { kind: 'dead'; who: string; not?: boolean }
  | { kind: 'left'; who: string; not?: boolean }
  | { kind: 'gold'; amount: number }
  | { kind: 'time'; when: 'night' | 'day' };

/** What happens when a beat is reached. */
export interface BeatEffects {
  /** Gold the player gets (or loses, negative). */
  gold?: number;
  gives?: { item: string; count: number }[];
  takes?: { item: string; count: number }[];
  /** A choice the quest remembers, for later lines and quests ("promised"). */
  remembers?: string;
  /** People who turn on the player. */
  attacks?: string[];
  /** People who leave for good. */
  leaves?: string[];
  /** People who start following the player. */
  follows?: string[];
  /** People who stop following the player. */
  stopsFollowing?: string[];
  /** Hidden groups or people who appear. */
  appears?: string[];
  /** People who go somewhere else. */
  moves?: { who: string; to: string }[];
}

export interface Beat {
  id: string;
  /** What the player does that completes it, and to whom or what. */
  does: BeatAction;
  target: string | null;
  /** pickup: how many; wait: in-game hours. */
  count?: number | null;
  hours?: number | null;
  /** Beats that must happen first (any one of them, when several: the beat joins branches). Empty: from the start. */
  after: string[];
  /** The author's sentence it comes from. */
  quote: string;
  /** In the player's journal once it's done. */
  journal: string | null;
  /** What the player is told to do to complete it (shown once the beats before it are done). */
  objective: string | null;
  /** 'complete' or 'fail': reaching it ends the quest that way. */
  ends: 'complete' | 'fail' | null;
  effects: BeatEffects;
  /** Different effects when something holds ("200 gold, or 100 if he was let go"): tried first, in order. */
  variants?: { if: BeatCondition[]; effects: BeatEffects }[];
}

/** How the quest starts. */
export type BeatStart =
  | { kind: 'game' }
  | { kind: 'afterQuest'; quest: string }
  | { kind: 'read' | 'pickup' | 'arrive' | 'use'; target: string };

/** What one written line does, and when it's said. Lines are numbered within their conversation, from 1. */
export interface BeatDialogueLine {
  line: number;
  /** Saying it completes this beat: the quest reaches the beat's stage, and the beat's effects happen here. */
  beat?: string | null;
  /** What saying it does besides (or without completing a beat): a choice remembered, gold, an item. */
  effects?: BeatEffects;
  /** Said only when these hold. */
  if?: BeatCondition[];
  /** Said another way when something holds ("250 if persuaded"): tried first, with its own effects. */
  variants?: { if: BeatCondition[]; effects: BeatEffects }[];
}

/** A written conversation's place in the quest: when it's offered, and what its lines do. */
export interface BeatDialogue {
  /** The written block (its id in findDialogue). */
  block: number;
  /** Offered once this beat is done and until the next one (null: whenever the quest runs). */
  when: string | null;
  lines: BeatDialogueLine[];
}

/** A line written by the AI for a talk beat the author describes without writing it out. */
export interface BeatLine {
  beat: string;
  /** The player's line, and the answer. */
  player: string;
  answer: string;
}

export interface BeatSheet {
  title: string;
  editorId: string;
  summary: string;
  /** The author's text it was read from: its written conversations are the blocks the dialogue entries number. */
  text?: string;
  start: BeatStart;
  people: BeatPerson[];
  places: BeatPlace[];
  items: BeatItem[];
  groups: BeatGroup[];
  beats: Beat[];
  dialogue: BeatDialogue[];
  lines: BeatLine[];
}

export interface BeatQuestion {
  /** The beat, entity or dialogue block it's about. */
  about: string;
  message: string;
  /** A talk beat nothing says yet: answered by writing its line, not by reading the beat again. */
  unsaid?: true;
  /** A person's, item's or group's field that names something missing: answered by picking one of that kind. */
  pick?: { field: 'place' | 'carriedBy' | 'lockedWith'; kind: BeatEntityKind };
  /** A beat whose action doesn't fit its target: answered by choosing one of these readings. */
  choose?: { does: BeatAction; target: string; label: string }[];
  /** A beat nothing comes after that doesn't end the quest: answered by saying what comes next. */
  next?: true;
  /** No beat ends the quest: answered by saying which one does. */
  ending?: true;
  /** A beat that ends the quest with beats after it: answered by saying whether it really ends it. */
  endsEarly?: true;
  /** Talking to the same person twice, one right after the other: answered by saying whether it's one moment (merged). */
  same?: string;
  /** An item the player picks up that isn't anywhere: answered by saying who hands it over, or where it is. */
  nowhere?: string;
}

// ------------------------------------------------------------------ checks

/** Beats in the order they can happen (each after the ones it needs); undefined when they loop. */
export function beatOrder(beats: Beat[]): Beat[] | undefined {
  const byId = new Map(beats.map((b) => [b.id, b]));
  const out: Beat[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (b: Beat): boolean => {
    const s = state.get(b.id);
    if (s === 'done') return true;
    if (s === 'visiting') return false;
    state.set(b.id, 'visiting');
    for (const a of b.after) {
      const before = byId.get(a);
      if (before && !visit(before)) return false;
    }
    state.set(b.id, 'done');
    out.push(b);
    return true;
  };
  // Stable: in the sheet's own order wherever the order allows.
  for (const b of beats) if (!visit(b)) return undefined;
  return out;
}

/**
 * What doesn't fit together in a beat sheet, each as a question about one beat, person, place, item or conversation.
 * Only structure is checked: whether things exist, can be reached and agree with each other.
 */
export function checkBeats(sheet: BeatSheet, opts: { earlierChoices?: string[]; blocks?: WrittenBlock[] } = {}): BeatQuestion[] {
  const q: BeatQuestion[] = [];
  const ask = (about: string, message: string, unsaid?: true) => q.push({ about, message, ...(unsaid ? { unsaid } : {}) });
  const pick = (about: string, message: string, field: 'place' | 'carriedBy' | 'lockedWith', kind: BeatEntityKind) => q.push({ about, message, pick: { field, kind } });
  const kinds = new Map<string, BeatEntityKind>([
    ...sheet.people.map((x) => [x.key, 'person'] as const),
    ...sheet.places.map((x) => [x.key, 'place'] as const),
    ...sheet.items.map((x) => [x.key, 'item'] as const),
    ...sheet.groups.map((x) => [x.key, 'group'] as const),
  ]);
  const keys = [...sheet.people, ...sheet.places, ...sheet.items, ...sheet.groups].map((x) => x.key);
  for (const k of new Set(keys)) if (keys.filter((x) => x === k).length > 1) ask(k, `Two things are called “${k}”: give each its own key.`);
  const is = (key: string | null | undefined, kind: BeatEntityKind) => !!key && kinds.get(key) === kind;
  const beatIds = new Set(sheet.beats.map((b) => b.id));
  if (beatIds.size < sheet.beats.length) ask('beats', 'Two beats have the same id.');
  if (!sheet.beats.length) ask('beats', 'There are no beats: nothing the player does moves the quest on.');

  for (const b of sheet.beats) {
    const want = ACTION_TARGET[b.does];
    if (!want && b.target) ask(b.id, `“${b.quote}”: a ${b.does} beat doesn't act on anything, but it names “${b.target}”.`);
    if (want === 'person|item' && !(is(b.target, 'person') || is(b.target, 'item'))) ask(b.id, `“${b.quote}”: the player uses something here; which person or item (one of: ${[...sheet.people, ...sheet.items].map((x) => x.key).join(', ') || 'none yet'})?`);
    else if (want && want !== 'person|item' && !is(b.target, want)) {
      // Something of another kind: say which, and what can be done to it.
      const other = b.target ? kinds.get(b.target) : undefined;
      const fits = other ? BEAT_ACTIONS.filter((a) => ACTION_TARGET[a] === other || (ACTION_TARGET[a] === 'person|item' && (other === 'person' || other === 'item'))) : [];
      // The readings that would fit: this action on something of the right kind, or another action on this target.
      const choose = [...keysOf(sheet, want).map((k) => ({ does: b.does, target: k })), ...fits.map((a) => ({ does: a, target: b.target! }))].map((c) => ({ ...c, label: `${c.does} ${nameOf(sheet, c.target)}` }));
      q.push({
        about: b.id,
        message: `“${b.quote}”: the player does “${b.does}” to ${an(want)}, but “${b.target ?? 'nothing'}” isn't one${other ? ` (it's ${other === 'group' ? 'an enemy group' : an(other)}, which the player can ${fits.join(' or ')})` : ''}. Which ${want} (one of: ${keysOf(sheet, want).join(', ') || 'none yet'})${other ? `, or is the action “${fits.join('” or “')}”` : ''}?`,
        ...(choose.length ? { choose } : {}),
      });
    }
    if (b.does === 'wait' && !((b.hours ?? 0) > 0)) ask(b.id, `“${b.quote}”: how many in-game hours does the player wait?`);
    for (const a of b.after) if (!beatIds.has(a)) ask(b.id, `“${b.quote}” comes after “${a}”, which isn't a beat.`);
    const e = b.effects ?? {};
    for (const x of [...(e.gives ?? []), ...(e.takes ?? [])]) if (!is(x.item, 'item')) ask(b.id, `“${b.quote}” hands over “${x.item}”, which isn't an item in the sheet.`);
    for (const who of [...(e.attacks ?? []), ...(e.leaves ?? []), ...(e.follows ?? []), ...(e.stopsFollowing ?? [])]) if (!is(who, 'person')) ask(b.id, `“${b.quote}” names “${who}”, who isn't a person in the sheet.`);
    for (const who of e.appears ?? []) if (!is(who, 'group') && !is(who, 'person')) ask(b.id, `“${b.quote}”: “${who}” appears, but isn't a person or group in the sheet.`);
    for (const m of e.moves ?? []) if (!is(m.who, 'person') || !is(m.to, 'place')) ask(b.id, `“${b.quote}”: “${m.who}” goes to “${m.to}”; both need to be in the sheet (a person and a place).`);
  }
  const order = beatOrder(sheet.beats);
  if (!order) ask('beats', 'The beats loop: some beat comes, through others, after itself.');
  if (sheet.beats.length && !sheet.beats.some((b) => b.ends === 'complete')) q.push({ about: 'beats', message: 'No beat completes the quest: which one finishes it?', ending: true });
  // Talking to someone, then straight away to them again with nothing else in between, may be one moment read twice.
  const saidIn = new Set(sheet.dialogue.flatMap((d) => d.lines.map((l) => l.beat)));
  for (const b of sheet.beats) {
    const a = b.after.length === 1 ? sheet.beats.find((x) => x.id === b.after[0]) : undefined;
    if (!a || a.does !== 'talk' || b.does !== 'talk' || a.target !== b.target || (saidIn.has(a.id) && saidIn.has(b.id))) continue;
    if (sheet.beats.some((x) => x !== b && x.after.includes(a.id))) continue;
    q.push({ about: b.id, message: `“${a.quote}”, then right after it “${b.quote}”: both talking to ${nameOf(sheet, b.target!)}. Is that one moment (the same beat)?`, same: a.id });
  }
  // Every beat leads somewhere: to another beat, or to the quest's end.
  const followed = new Set(sheet.beats.flatMap((b) => b.after));
  // (Asked once some beat ends the quest; before that, which one does is the question.)
  if (sheet.beats.length > 1 && sheet.beats.some((b) => b.ends === 'complete')) for (const b of sheet.beats) if (!b.ends && !followed.has(b.id)) q.push({ about: b.id, message: `“${b.quote}” leads nowhere: no beat comes after it, and it doesn't end the quest. What comes next?`, next: true });
  // Every beat can happen: nothing it waits for ends the quest first.
  const ending = new Set(sheet.beats.filter((b) => b.ends).map((b) => b.id));
  for (const b of sheet.beats)
    if (b.after.length && b.after.every((a) => ending.has(a)))
      for (const a of b.after) {
        const e = sheet.beats.find((x) => x.id === a)!;
        if (!q.some((x) => x.about === a && x.endsEarly)) q.push({ about: a, message: `“${e.quote}” ${e.ends === 'fail' ? 'fails' : 'ends'} the quest, but “${b.quote}” comes after it. Does the quest end there?`, endsEarly: true });
      }

  // What's picked up or read has to be somewhere; what's used up in dialogue has to be given first.
  for (const i of sheet.items) {
    if (i.place && !is(i.place, 'place')) pick(i.key, `${i.name} lies in “${i.place}”, which isn't a place in the sheet.`, 'place', 'place');
    if (i.carriedBy && !is(i.carriedBy, 'person')) pick(i.key, `${i.name} is carried by “${i.carriedBy}”, who isn't a person in the sheet.`, 'carriedBy', 'person');
    if (i.lockedWith && !is(i.lockedWith, 'item')) pick(i.key, `${i.name} is locked with “${i.lockedWith}”, which isn't an item in the sheet.`, 'lockedWith', 'item');
    const needed = sheet.beats.some((b) => (b.does === 'pickup' || b.does === 'read') && b.target === i.key);
    const given = sheet.beats.some((b) => (b.effects?.gives ?? []).some((g) => g.item === i.key));
    if (needed && !i.place && !i.carriedBy && !given) {
      const b = sheet.beats.find((x) => (x.does === 'pickup' || x.does === 'read') && x.target === i.key)!;
      q.push({ about: b.id, message: `The player has to find ${i.name}, but it isn't anywhere: does someone hand it over, or where is it?`, nowhere: i.key });
    }
  }
  for (const p of sheet.people) if (p.place && !is(p.place, 'place')) pick(p.key, `${p.name} is at “${p.place}”, which isn't a place in the sheet.`, 'place', 'place');
  for (const g of sheet.groups) {
    if (!is(g.place, 'place')) pick(g.key, `The ${g.what} are at “${g.place}”, which isn't a place in the sheet.`, 'place', 'place');
    if (g.hidden && !sheet.beats.some((b) => (b.effects?.appears ?? []).includes(g.key))) ask(g.key, `The ${g.what} are hidden until something shows them, but no beat does: which beat makes them appear?`);
  }
  const start = sheet.start;
  if (start.kind !== 'game' && start.kind !== 'afterQuest') {
    if (!kinds.has(start.target)) ask('start', `The quest starts when the player does something to “${start.target}”, which isn't in the sheet.`);
    else if (!(start.kind === 'arrive' ? is(start.target, 'place') : start.kind === 'use' ? is(start.target, 'item') || is(start.target, 'person') : is(start.target, 'item')))
      ask('start', `The quest starts when the player does “${start.kind}” to “${start.target}”, which is ${an(kinds.get(start.target)!)}: ${start.kind === 'arrive' ? 'a place' : 'an item'} is needed.`);
  }

  // Dialogue: every talk beat is said somewhere; links point at real beats and lines; conditions at real things.
  const remembered = new Set(
    [...(opts.earlierChoices ?? []), ...sheet.beats.map((b) => b.effects?.remembers), ...sheet.dialogue.flatMap((d) => d.lines.flatMap((l) => [l.effects?.remembers, ...(l.variants ?? []).map((v) => v.effects?.remembers)]))]
      .filter((x): x is string => !!x)
      .map((x) => x.toLowerCase()),
  );
  const linesIn = (block: number) => opts.blocks?.find((b) => b.id === block)?.lines.length;
  for (const d of sheet.dialogue) {
    const n = linesIn(d.block);
    if (opts.blocks && n === undefined) ask(`block ${d.block}`, `There's no written conversation ${d.block}.`);
    if (d.when && !beatIds.has(d.when)) ask(`block ${d.block}`, `Conversation ${d.block} is offered after “${d.when}”, which isn't a beat.`);
    else if (d.when && d.lines.some((x) => x.beat === d.when)) ask(`block ${d.block}`, `Conversation ${d.block} does “${d.when}”, so it can't be offered only after it.`);
    for (const x of d.lines) {
      const where = `Line ${x.line} of conversation ${d.block}`;
      if (n !== undefined && (x.line < 1 || x.line > n)) ask(`block ${d.block}`, `Conversation ${d.block} has no line ${x.line}.`);
      if (x.beat && !beatIds.has(x.beat)) ask(`block ${d.block}`, `${where} completes “${x.beat}”, which isn't a beat.`);
      const effects = [x.effects ?? {}, ...(x.variants ?? []).map((v) => v.effects ?? {})];
      for (const e of effects) for (const g of [...(e.gives ?? []), ...(e.takes ?? [])]) if (!is(g.item, 'item')) ask(`block ${d.block}`, `${where} hands over “${g.item}”, which isn't an item in the sheet.`);
      for (const cond of [...(x.if ?? []), ...(x.variants ?? []).flatMap((v) => v.if ?? [])]) {
        if (cond.kind === 'choice' && !remembered.has(cond.name.toLowerCase())) ask(`block ${d.block}`, `${where} is said only if the player chose “${cond.name}”, but nothing remembers that choice. Which one is it (${[...remembered].join(', ') || 'none yet'}), or which line or beat should remember it?`);
        if (cond.kind === 'done' && !beatIds.has(cond.beat)) ask(`block ${d.block}`, `${where} depends on “${cond.beat}”, which isn't a beat.`);
        if ((cond.kind === 'dead' || cond.kind === 'left') && !is(cond.who, 'person')) ask(`block ${d.block}`, `${where} depends on what became of “${cond.who}”, who isn't a person in the sheet.`);
      }
    }
  }
  for (const l of sheet.lines) if (!beatIds.has(l.beat)) ask(l.beat, `A written line is for “${l.beat}”, which isn't a beat.`);
  for (const b of sheet.beats.filter((x) => x.does === 'talk')) {
    const said = sheet.dialogue.some((d) => d.lines.some((x) => x.beat === b.id)) || sheet.lines.some((l) => l.beat === b.id);
    if (!said) ask(b.id, `“${b.quote}” happens in a conversation: which line does it (or what's said, if the author didn't write it)?`, true);
  }
  return q;
}

const an = (word: string) => `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;

function nameOf(sheet: BeatSheet, key: string): string {
  return [...sheet.people, ...sheet.places, ...sheet.items].find((x) => x.key === key)?.name ?? sheet.groups.find((g) => g.key === key)?.what ?? key;
}

function keysOf(sheet: BeatSheet, kind: BeatEntityKind): string[] {
  const list = kind === 'person' ? sheet.people : kind === 'place' ? sheet.places : kind === 'item' ? sheet.items : sheet.groups;
  return list.map((x) => x.key);
}

// ------------------------------------------------------------------ compiling

/** Stage numbers: 0 for the start, then 10, 20… in the order the beats can happen. */
export function beatStages(sheet: BeatSheet): Map<string, number> {
  const order = beatOrder(sheet.beats) ?? sheet.beats;
  return new Map(order.map((b, i) => [b.id, (i + 1) * 10]));
}

const conditionTag = (c: BeatCondition, stages: Map<string, number>): string | undefined => {
  const not = 'not' in c && c.not ? 'not ' : '';
  switch (c.kind) {
    case 'choice':
      return `[if ${not}chose ${c.name}]`;
    case 'done':
      return stages.has(c.beat) ? `[if ${not}done ${stages.get(c.beat)}]` : undefined;
    case 'dead':
      return `[if ${c.not ? 'alive' : 'dead'} ${c.who}]`;
    case 'left':
      return `[if ${not}left ${c.who}]`;
    case 'gold':
      return `[if gold ${c.amount}]`;
    case 'time':
      return `[if ${c.when}]`;
  }
};

/** The tags for what happens when a line is said. */
function effectTags(e: BeatEffects, speaker: { key: string; name: string } | undefined): string[] {
  const tags: string[] = [];
  if (e.gold && e.gold > 0) tags.push(`[gives gold x${e.gold}]`);
  if (e.gold && e.gold < 0) tags.push(`[takes gold x${-e.gold}]`);
  for (const g of e.gives ?? []) tags.push(`[gives ${g.item} x${g.count}]`);
  for (const t of e.takes ?? []) tags.push(`[takes ${t.item} x${t.count}]`);
  if (e.remembers) tags.push(`[remember ${e.remembers}]`);
  // Only the speaker can turn on the player or leave from their own line; anyone else is an event.
  if (speaker && (e.attacks ?? []).includes(speaker.key)) tags.push('[attacks]');
  if (speaker && (e.leaves ?? []).includes(speaker.key)) tags.push('[leaves]');
  return tags;
}

/**
 * A beat sheet as a quest plan, ready for the usual review and build. The written conversations (`blocks`, from
 * findDialogue) go in word for word, with the tags their links to beats give them.
 */
export function compileBeats(sheet: BeatSheet, blocks: WrittenBlock[] = []): QuestPlan {
  const stages = beatStages(sheet);
  const stageOf = (id: string) => stages.get(id) ?? 0;
  const order = beatOrder(sheet.beats) ?? sheet.beats;
  const byId = new Map(sheet.beats.map((b) => [b.id, b]));
  // A stage is where the quest is once a beat is done; the start is 0.
  const fromStages = (b: Beat) => (b.after.length ? b.after.filter((a) => byId.has(a)).map(stageOf) : [0]);

  const characters: PlanCharacter[] = sheet.people.map((p) => ({
    key: p.key,
    name: p.name,
    existing: p.existing,
    basedOn: null,
    sex: p.sex,
    race: p.race,
    role: p.description,
    appearance: p.description,
    look: null,
    voice: null,
    locationKey: p.existing && !p.place ? null : p.place,
    spot: p.spot,
    essential: p.essential,
    className: null,
    level: null,
    outfit: null,
    factions: [],
    inventory: [],
    routine: [],
    combat: p.hostile ? { hostile: true, levelScaled: null, skills: [], spells: [], perks: [], combatStyle: null } : null,
    roles: null,
    relationships: [],
  }));
  const person = new Map(characters.map((c) => [c.key, c]));
  const locations: PlanLocation[] = sheet.places.map((l) => ({ key: l.key, name: l.name, existing: l.existing, description: l.description, layoutLike: null, doorFrom: null }));
  const items: PlanItem[] = sheet.items.map((i) => ({
    key: i.key,
    name: i.name,
    kind: i.kind,
    existing: i.existing,
    basedOn: null,
    value: null,
    startsWith: i.place ? 'location' : i.carriedBy ? 'character' : 'nowhere',
    startsAtKey: i.place ?? i.carriedBy,
    spot: i.spot,
    copies: i.count > 1 ? i.count : null,
    text: i.text,
    lockedWith: i.lockedWith,
  }));
  const encounters: PlanEncounter[] = sheet.groups.map((g) => ({ key: g.key, what: g.what, count: g.count, locationKey: g.place, spot: g.spot }));

  const planStages: QuestPlan['stages'] = [{ index: 0, journal: '', startsQuest: true, completesQuest: false, failsQuest: false }];
  for (const b of order) planStages.push({ index: stageOf(b.id), journal: b.journal ?? '', startsQuest: false, completesQuest: b.ends === 'complete', failsQuest: b.ends === 'fail' });

  // Steps: from each stage the beat can follow. Talk beats are done by their line ([stage N]); a failure by a death is
  // a failure, not a step.
  const steps: PlanStep[] = [];
  const failures: QuestPlan['failures'] = [];
  const KIND: Record<BeatAction, PlanStep['kind']> = { talk: 'talk', pickup: 'pickup', read: 'read', use: 'activate', arrive: 'arrive', kill: 'death', clear: 'clear', wait: 'wait', immediately: 'script' };
  for (const b of order) {
    if (b.ends === 'fail' && b.does === 'kill') {
      failures.push({ kind: 'death', targetKey: b.target, days: null, fromStage: null, failStage: stageOf(b.id), note: b.quote });
      continue;
    }
    for (const from of fromStages(b)) steps.push({ from, to: stageOf(b.id), kind: KIND[b.does], targetKey: ACTION_TARGET[b.does] ? b.target : null, count: b.does === 'pickup' && (b.count ?? 1) > 1 ? b.count! : null, hours: b.does === 'wait' ? (b.hours ?? 24) : null, note: b.quote });
  }

  // Objectives: what to do for each beat, shown once the beats before it are done.
  const objectives: QuestPlan['objectives'] = order
    .filter((b) => b.objective)
    .map((b) => ({ index: stageOf(b.id), text: b.objective!, shownAtStage: Math.min(...fromStages(b)), completedAtStage: stageOf(b.id), targetKey: b.target }));

  // What happens when a beat is reached outside dialogue: events, rewards, routines.
  const events: PlanEvent[] = [];
  const rewards: QuestPlan['rewards'] = [];
  const saidBy = new Set([...sheet.dialogue.flatMap((d) => d.lines.map((x) => x.beat)), ...sheet.lines.map((l) => l.beat)]);
  for (const b of order) {
    const at = stageOf(b.id);
    const e = b.effects ?? {};
    const inDialogue = b.does === 'talk' && saidBy.has(b.id);
    if (!inDialogue) {
      if (e.gold && e.gold > 0) rewards.push({ atStage: at, gold: e.gold, itemKey: null, skill: null });
      for (const g of e.gives ?? []) rewards.push({ atStage: at, gold: null, itemKey: g.item, skill: null });
    }
    // (A conversation that does the beat says these on its line instead: [attacks], [leaves].)
    for (const who of inDialogue ? [] : (e.attacks ?? [])) events.push({ atStage: at, kind: 'hostile', targetKey: who, toKey: null, what: null, count: null, note: `${person.get(who)?.name ?? who} attacks` });
    for (const who of inDialogue ? [] : (e.leaves ?? [])) events.push({ atStage: at, kind: 'hide', targetKey: who, toKey: null, what: null, count: null, note: `${person.get(who)?.name ?? who} leaves` });
    for (const who of e.appears ?? []) events.push({ atStage: at, kind: 'show', targetKey: who, toKey: null, what: null, count: null, note: `${who} appears` });
    for (const m of e.moves ?? []) {
      events.push({ atStage: at, kind: 'moveTo', targetKey: m.who, toKey: m.to, what: null, count: null, note: `${person.get(m.who)?.name ?? m.who} goes to ${m.to}` });
      person.get(m.who)?.routine.push({ activity: 'sandbox', where: m.to, hours: null, fromStage: at, untilStage: null, line: null });
    }
    for (const who of e.follows ?? []) {
      const until = order.find((x) => (x.effects?.stopsFollowing ?? []).includes(who) && stageOf(x.id) > at);
      person.get(who)?.routine.push({ activity: 'follow', where: null, hours: null, fromStage: at, untilStage: until ? stageOf(until.id) : null, line: null });
    }
  }

  // Written conversations: their words untouched, tags from the beats and effects they're linked to.
  const copy: WrittenBlock[] = structuredClone(blocks);
  const speakerOf = (name: string) => sheet.people.find((p) => [p.key, p.name, p.name.split(/\s+/)[0]!].some((n) => n.toLowerCase() === name.toLowerCase()));
  const conditionTags = (conds: BeatCondition[] | undefined) => (conds ?? []).map((c) => conditionTag(c, stages)).filter((t): t is string => !!t);
  for (const d of sheet.dialogue) {
    const block = copy.find((b) => b.id === d.block);
    if (!block) continue;
    if (d.when && stages.has(d.when)) block.tags.push(`[if stage ${stageOf(d.when)}]`);
    const original = [...block.lines];
    for (const x of d.lines) {
      const l = original[x.line - 1];
      if (!l) continue;
      const b = x.beat ? byId.get(x.beat) : undefined;
      const who = l.player ? undefined : speakerOf(l.speaker);
      const tagsFor = (extra: BeatEffects | undefined) => {
        const e: BeatEffects = { ...(b?.effects ?? {}), ...(extra ?? {}) };
        return [...(b ? [`[stage ${stageOf(b.id)}]`] : []), ...effectTags(e, who)];
      };
      l.tags.push(...conditionTags(x.if), ...tagsFor(x.effects));
      // Said another way when something holds: those copies first, this one otherwise.
      if (x.variants?.length) {
        const copies = x.variants.map((v) => ({ ...l, tags: [...l.tags.filter((t) => !/^\[(stage|gives|takes|remember|attacks|leaves)\b/i.test(t)), ...conditionTags(v.if), ...tagsFor({ ...(x.effects ?? {}), ...v.effects })] }));
        l.tags.push('[otherwise]');
        block.lines.splice(block.lines.indexOf(l), 0, ...copies);
      }
    }
  }
  const conversations: QuestPlan['conversations'] = [];
  const speakers = [...new Set(copy.map((b) => b.speaker.toLowerCase()))];
  for (const s of speakers) {
    const mine = copy.filter((b) => b.speaker.toLowerCase() === s);
    const who = sheet.people.find((p) => p.name.toLowerCase() === s || p.key.toLowerCase() === s || p.name.split(/\s+/)[0]!.toLowerCase() === s);
    conversations.push({ title: `✎ ${who?.name ?? mine[0]!.speaker}`, screenplay: writtenScreenplay(mine) });
  }
  // Lines the AI wrote for talk beats the author only describes: written like the author's, a player line and its
  // answer, said another way first where the beat's effects differ.
  const written = new Map<string, WrittenBlock[]>();
  for (const [i, l] of sheet.lines.entries()) {
    const b = byId.get(l.beat);
    if (!b) continue;
    const who = person.get(b.target ?? '');
    const key = (who?.key ?? 'npc').toUpperCase();
    const gate = fromStages(b).length === 1 ? [`[if stage ${fromStages(b)[0]}]`] : [];
    const answer = (tags: string[]): WrittenLine => ({ n: 0, level: 0, speaker: key, player: false, text: l.answer, notes: [], tags });
    const lines: WrittenLine[] = [{ n: 0, level: 0, speaker: 'PLAYER', player: true, text: l.player, notes: [], tags: gate }];
    for (const v of b.variants ?? []) lines.push(answer([...conditionTags(v.if), `[stage ${stageOf(b.id)}]`, ...effectTags({ ...(b.effects ?? {}), ...v.effects }, who)]));
    lines.push(answer([`[stage ${stageOf(b.id)}]`, ...effectTags(b.effects ?? {}, who), ...(b.variants?.length ? ['[otherwise]'] : [])]));
    lines.forEach((x, n) => (x.n = n + 1));
    const title = who?.name ?? 'NPC';
    written.set(title, [...(written.get(title) ?? []), { id: 10000 + i, header: '', scene: false, speaker: key, lines, tags: [] }]);
  }
  for (const [title, list] of written) {
    const text = writtenScreenplay(list);
    const conv = conversations.find((c) => c.title === title);
    if (conv) conv.screenplay += `\n${text}`;
    else conversations.push({ title, screenplay: text });
  }

  const start = sheet.start;
  return {
    title: sheet.title,
    editorId: sheet.editorId,
    summary: sheet.summary,
    startsWithGame: start.kind === 'game',
    startsWhen: start.kind === 'game' ? null : start.kind === 'afterQuest' ? { kind: 'afterQuest', targetKey: null, quest: start.quest, stage: null } : { kind: start.kind === 'use' ? 'activate' : start.kind, targetKey: start.target, quest: null, stage: null },
    characters,
    locations,
    items,
    encounters,
    stages: planStages,
    objectives,
    steps,
    conversations,
    rewards,
    animations: [],
    failures,
    events,
    assumptions: [],
    questions: [],
  };
}
