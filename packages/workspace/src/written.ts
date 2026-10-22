/**
 * Dialogue an author has already written, kept word for word.
 *
 * Quest documents write conversations in many ways: "HESTA: line" with the
 * player's choices indented under what they answer, Markdown bullets with
 * bold names (- **Player:** "line"), quotes, and directions in brackets
 * ("(the player takes the job)", "*(he attacks)*", "[Persuade, Speech 50]").
 * findDialogue finds those blocks; writtenScreenplay turns one character's
 * blocks into the editor's screenplay format, with the tags each line needs
 * (from the directions, and from the AI where a direction needs the quest's
 * stages or items to mean anything). The words themselves are never
 * rewritten.
 */
import { leftChoice, parseIf } from './dialogueif';

export interface WrittenLine {
  /** Number within its conversation (1-based), for the AI to refer to. */
  n: number;
  /** Depth in the author's indentation (0 = not indented). */
  level: number;
  speaker: string;
  player: boolean;
  text: string;
  /** The author's directions on this line ("the player takes the job", "success"). */
  notes: string[];
  /** Screenplay tags it gets ("[stage 10]"). */
  tags: string[];
}

export interface WrittenBlock {
  id: number;
  /** The prose just before it, saying when it's said ("When the player comes back with all three pages:"). */
  header: string;
  /** A scene: characters talking to each other with nobody prompting them. */
  scene: boolean;
  /** Who the player talks to (the main speaker other than the player). */
  speaker: string;
  lines: WrittenLine[];
  /** Tags for the whole block (when it can be said). */
  tags: string[];
}

const PLAYER = /^(player|the player|pc|you|dragonborn)$/i;
/** Labels that look like "Name: text" but aren't anyone speaking. */
const LABELS = new Set(
  'journal objective objectives note notes reward rewards location locations quest quests stage stages summary setup characters character cast dialogue greeting greetings example starts start ends end endings ending epilogue hint description text title scene item items place places setting background mechanics requirements failure failures prerequisite prerequisites trigger triggers tags tag outcome outcomes result results step steps part act chapter book letter notice ledger wanted reads says'.split(' '),
);

/** "**Varro (success):** "Text" *(he attacks)*" and its kin, read into who, their notes and the words. */
function readLine(raw: string): { indent: number; bullet: boolean; speaker: string; notes: string[]; text: string } | null {
  const tabbed = raw.replace(/\t/g, '    ');
  const m = /^(\s*)((?:[-*+]|\d+[.)])\s+)?(.*)$/.exec(tabbed);
  if (!m) return null;
  const body = m[3]!.trim();
  if (!body || body.startsWith('>') || body.startsWith('#')) return null;
  // Name, an optional note in brackets right after it, then the colon (bold or not, on either side).
  const n = /^(?:\*\*|__)?([A-Za-z][A-Za-z'’ .-]{0,32}?)(?:\*\*|__)?\s*(?:[([]([^)\]]*)[)\]])?\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*)$/.exec(body);
  if (!n) return null;
  const speaker = n[1]!.trim().replace(/[’]/g, "'");
  const words = speaker.split(/\s+/);
  if (words.length > 3 || LABELS.has(speaker.toLowerCase()) || words.some((w) => LABELS.has(w.toLowerCase()) && words.length === 1)) return null;
  if (!PLAYER.test(speaker) && !words.every((w) => /^[A-Z]/.test(w) || /^(of|the|de|al|af)$/.test(w))) return null;
  const notes: string[] = [];
  if (n[2]?.trim()) notes.push(n[2].trim());
  let rest = n[3]!.trim();
  // Directions: *( … )*, ( … ) and [ … ] anywhere on the line, kept apart from the words.
  rest = rest.replace(/\*\(([^)]*)\)\*|_\(([^)]*)\)_|\(([^)]*)\)|\[([^\]]*)\]/g, (_m, a?: string, b?: string, c?: string, d?: string) => {
    const t = (a ?? b ?? c ?? d ?? '').trim();
    if (t) notes.push(t);
    return ' ';
  });
  let text = rest.replace(/\s+/g, ' ').trim();
  // Quotes around the words (straight or curly), and stray emphasis marks.
  const q = /^["“](.*)["”]$/.exec(text);
  if (q) text = q[1]!.trim();
  text = text.replace(/^\*+|\*+$/g, '').trim();
  // "Gerda:" on its own is a heading for what follows, not a line.
  if (!/[A-Za-z0-9]/.test(text)) return null;
  return { indent: m[1]!.length, bullet: !!m[2], speaker, notes, text };
}

const SCENE_HEADER = /^\s*(?:\*\*|__)?scene(?:\*\*|__)?\s*(?::|\b)\s*(.*)$/i;

/**
 * The conversations written out in a document, and the document without them. A block is a run of
 * "Name: line" lines with at least one line the player says (or a SCENE: between characters).
 */
export function findDialogue(text: string): { blocks: WrittenBlock[]; prose: string } {
  const rows = text.split(/\r?\n/);
  const blocks: WrittenBlock[] = [];
  const prose: string[] = [];
  let i = 0;
  let lastProse = '';
  while (i < rows.length) {
    const sceneHead = SCENE_HEADER.exec(rows[i]!);
    const first = readLine(rows[i]!);
    if (!sceneHead && !first) {
      if (rows[i]!.trim()) lastProse = rows[i]!.trim();
      prose.push(rows[i]!);
      i++;
      continue;
    }
    // Collect the run (blank lines inside are fine as long as dialogue carries on after them).
    const run: { row: number; line: NonNullable<ReturnType<typeof readLine>> }[] = [];
    let j = sceneHead ? i + 1 : i;
    while (j < rows.length) {
      const l = readLine(rows[j]!);
      if (l) {
        run.push({ row: j, line: l });
        j++;
        continue;
      }
      if (!rows[j]!.trim()) {
        let k = j;
        while (k < rows.length && !rows[k]!.trim()) k++;
        if (k < rows.length && readLine(rows[k]!) && !SCENE_HEADER.test(rows[k]!)) {
          j = k;
          continue;
        }
      }
      break;
    }
    const players = run.filter((r) => PLAYER.test(r.line.speaker));
    if (!run.length || (!sceneHead && !players.length)) {
      // "Journal: …" on its own, or lines nobody answers: prose.
      for (let k = i; k < Math.max(j, i + 1); k++) {
        if (rows[k]!.trim()) lastProse = rows[k]!.trim();
        prose.push(rows[k]!);
      }
      i = Math.max(j, i + 1);
      continue;
    }
    // Depth from indentation; a bulleted line sits one deeper than an unbulleted one at the same indent.
    const depthKey = (l: { indent: number; bullet: boolean }) => l.indent * 2 + (l.bullet ? 1 : 0);
    const keys = [...new Set(run.map((r) => depthKey(r.line)))].sort((a, b) => a - b);
    const npcCount = new Map<string, number>();
    for (const r of run) if (!PLAYER.test(r.line.speaker)) npcCount.set(r.line.speaker.toLowerCase(), (npcCount.get(r.line.speaker.toLowerCase()) ?? 0) + 1);
    const main = [...npcCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    const lines: WrittenLine[] = run.map((r) => ({
      n: 0,
      level: keys.indexOf(depthKey(r.line)),
      speaker: PLAYER.test(r.line.speaker) ? 'PLAYER' : r.line.speaker,
      player: PLAYER.test(r.line.speaker),
      text: r.line.text,
      notes: r.line.notes,
      tags: [],
    }));
    // "SCENE 2 — The meadery" over lines the player takes part in is a heading for a conversation, not a scene
    // between characters.
    const scene = !!sceneHead && !players.length;
    const header = sceneHead ? (scene ? [lastProse, sceneHead[1]].filter(Boolean).join(' ') : rows[i]!.trim()) : lastProse;
    blocks.push({ id: blocks.length + 1, header, scene, speaker: run.find((r) => r.line.speaker.toLowerCase() === main)?.line.speaker ?? main, lines, tags: [] });
    prose.push(outline(blocks[blocks.length - 1]!));
    i = j;
  }
  return { blocks, prose: prose.join('\n') };
}

/**
 * What stands in for a written conversation when the AI plans the quest around it: who it's with, how long it is, the
 * player's choices and every line with a direction (shortened), so the stages and talk steps can be planned without
 * the AI copying the words out.
 */
function outline(b: WrittenBlock): string {
  const short = (t: string) => (t.length > 70 ? `${t.slice(0, 67).trimEnd()}…` : t);
  const rows = b.lines.filter((l) => l.player || l.notes.length).map((l) => `  ${'  '.repeat(l.level)}${l.player ? 'PLAYER' : l.speaker.toUpperCase()}: "${short(l.text)}"${l.notes.length ? ` (${l.notes.join('; ')})` : ''}`);
  const who = b.scene ? `a scene with ${[...new Set(b.lines.map((l) => l.speaker))].join(', ')}` : `with ${b.speaker}`;
  return [`(Conversation ${b.id}, ${who}: ${b.lines.length} lines written out by the author, added to the plan word for word afterwards. The player's choices and the lines with directions:`, ...rows, ')'].join('\n');
}

/**
 * The blocks a character takes part in (their conversations with the player, and scenes they're in), numbered for the
 * AI, with the directions the editor understands by itself already turned into tags.
 */
export function blocksFor(blocks: WrittenBlock[], speaker: string): WrittenBlock[] {
  const want = speaker.toLowerCase();
  const mine = blocks.filter((b) => b.speaker.toLowerCase() === want);
  let n = 0;
  for (const b of mine) for (const l of b.lines) l.n = ++n;
  plainNotes(mine);
  return mine;
}

/** The blocks as the AI reads them: numbered lines, the author's directions after "—". */
export function describeBlocks(blocks: WrittenBlock[]): string {
  return blocks
    .map((b) => {
      const head = `Block ${b.id}${b.scene ? ' (a scene: characters talking to each other)' : ''}${b.header ? ` — ${b.header}` : ''}`;
      const rows = b.lines.map((l) => `${String(l.n).padStart(3)} ${'  '.repeat(l.level)}${l.player ? 'PLAYER' : l.speaker.toUpperCase()}: ${l.text}${l.notes.length ? `   — ${l.notes.join('; ')}` : ''}`);
      return [head, ...rows].join('\n');
    })
    .join('\n\n');
}

/** Tags that only make sense once on a line: the first of each is kept (and exact repeats of any tag go). */
const SINGLE = new Set(['persuade', 'goodbye', 'emotion', 'once', 'stage', 'gesture', 'attacks', 'leaves', 'or', 'at', 'start']);
function oneOfEach(tags: string[]): string[] {
  const seen = new Set<string>();
  return tags.filter((t) => {
    const name = /^\[([a-z]+)/i.exec(t)?.[1]?.toLowerCase() ?? t;
    const id = SINGLE.has(name) ? name : t.toLowerCase();
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Directions the editor understands without help: persuasion, success and failure, ending the conversation. */
function plainNotes(blocks: WrittenBlock[]): void {
  for (const b of blocks)
    for (const l of b.lines) {
      const keep: string[] = [];
      for (const note of l.notes) {
        const persuade = /\b(persuade|persuasion|intimidate|speech check|bribe check)\b/i.test(note);
        if (l.player && persuade) {
          const level = /\b(?:speech|level)\s*(\d+)/i.exec(note)?.[1] ?? /\b(\d{2,3})\b/.exec(note)?.[1] ?? '50';
          l.tags.push(`[persuade ${level}]`);
        } else if (/^(succe(ss|eds?)|passed?|win)$/i.test(note.trim())) l.tags.push('[success]');
        else if (/^(fail(ure|s|ed)?|lose)$/i.test(note.trim())) l.tags.push('[failure]');
        else if (/^(end(s)? the conversation|goodbye|conversation ends|the conversation ends|ends? conversation|exit)$/i.test(note.trim())) l.tags.push('[goodbye]');
        else if (/^otherwise$/i.test(note.trim())) l.tags.push('[otherwise]');
        else keep.push(note);
      }
      l.notes = keep;
    }
}

export interface DialogueAnnotation {
  /** Tags for every line of a block (when it can be said). */
  blocks: { block: number; tags: string }[];
  /** Tags for single lines (what saying them does, or when they're offered), with the line's first words. */
  lines: { line: number; words?: string; tags: string }[];
}

/** Only tags the editor knows, written the way the screenplay format reads them. */
function cleanTags(tags: string): string[] {
  return [...tags.matchAll(/\[([a-z]+)((?:\s+[^\]]*)?)\]/gi)].map((m) => `[${m[1]!.toLowerCase()}${m[2] ?? ''}]`);
}

const wordsOf = (t: string) => t.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);

/**
 * The line the AI meant. Smaller models get the number or the quoted words one line off (either one): where they
 * point at different lines, the one with the author's direction wins, then the one the character says (for tags that
 * do something), then the words.
 */
function lineFor<T extends { l: WrittenLine }>(all: T[], n: number, words: string | undefined, tags: string[]): T | undefined {
  const at = all.findIndex((x) => x.l.n === n);
  const w = wordsOf(words ?? '').slice(0, 5);
  if (!w.length) return all[at];
  const starts = (x: T | undefined) => !!x && (wordsOf(x.l.text).slice(0, w.length).join(' ') === w.join(' ') || wordsOf(x.l.text).join(' ').includes(w.join(' ')));
  if (at >= 0 && starts(all[at])) return all[at];
  let byWords: T | undefined;
  for (const d of [1, -1, 2, -2, 3, -3]) if (at >= 0 && starts(all[at + d])) (byWords ??= all[at + d]);
  byWords ??= all.find(starts);
  const byNumber = all[at];
  if (!byWords || !byNumber) return byWords ?? byNumber;
  const directed = (x: T) => x.l.notes.length > 0;
  if (directed(byNumber) !== directed(byWords)) return directed(byNumber) ? byNumber : byWords;
  const doing = tags.some((t) => /^\[(stage|gives|takes|remember|attacks|leaves)\b/i.test(t));
  if (doing && byNumber.l.player !== byWords.l.player) return byNumber.l.player ? byWords : byNumber;
  return byWords;
}

/** Put the AI's tags on the blocks and lines they're for. */
export function applyAnnotation(blocks: WrittenBlock[], a: DialogueAnnotation): void {
  for (const x of a.blocks ?? []) {
    const b = blocks.find((y) => y.id === x.block);
    // A scene's "[at stage N]" on a conversation with the player means when it's offered: [if stage N].
    const tags = cleanTags(x.tags ?? '').map((t) => (b && !b.scene ? t.replace(/^\[at\s+(?:stage\s+)?(\d+)\]$/i, '[if stage $1]') : t));
    if (b) b.tags.push(...tags.filter((t) => !b.tags.includes(t)));
  }
  const all = blocks.flatMap((b) => b.lines.map((l) => ({ l, b })));
  for (const x of a.lines ?? []) {
    if (!cleanTags(x.tags ?? '').length) continue;
    const hit = lineFor(all, x.line, x.words, cleanTags(x.tags ?? ''));
    if (!hit) continue;
    const { l, b } = hit;
    // "A | B": the line said two ways (paying 250 if persuaded, otherwise 150): a copy for each, the one with its own
    // condition first and the other said otherwise. Only where the author's direction says there are two ways.
    // "[at stage N]" starts a scene: it belongs on a block, never a line.
    const variants = (x.tags ?? '').split('|').map((v) => cleanTags(v).filter((t) => !/^\[at\s/i.test(t))).filter((v) => v.length);
    const common = variants[0]?.filter((t) => variants.every((v) => v.includes(t))) ?? [];
    const own = variants.map((v) => v.filter((t) => !common.includes(t)));
    const twoWays = variants.length > 1 && !l.player && l.notes.some((n) => /\b(or|otherwise|if|unless)\b/i.test(n)) && new Set(own.map((o) => o.join(' '))).size === own.length && own.some((o) => o.some(isIf));
    if (twoWays) {
      const order = own.map((_, i) => i).sort((i, j) => Number(!own[i]!.some(isIf)) - Number(!own[j]!.some(isIf)));
      const before = [...l.tags];
      const copies = order.slice(1).map((i) => ({ ...l, notes: [...l.notes], tags: [...before, ...common, ...own[i]!, ...(own[i]!.some(isIf) ? [] : ['[otherwise]'])] }));
      l.tags.push(...common, ...own[order[0]!]!);
      b.lines.splice(b.lines.indexOf(l) + 1, 0, ...copies);
      continue;
    }
    l.tags.push(...variants.flat().filter((t, i, xs) => !l.tags.includes(t) && xs.indexOf(t) === i));
  }
}

/** Words that say nothing about which step a direction or heading means. */
const STOP = new Set('the a an and or of to in on at for with by from his her their its him them she he they it is are was be been this that these those player players you your quest now then there here up out into onto as so just all right when while after once before until has have had who what'.split(' '));
/** The content words of a phrase, roughly stemmed ("takes the job" and "agrees to take the job" share take and job). */
function keyWords(t: string): Set<string> {
  return new Set(wordsOf(t).map((w) => w.replace(/'s$/, '')).filter((w) => w.length > 1 && !STOP.has(w)).map((w) => w.replace(/(?:ing|ed|es|e|s)$/, '') || w));
}
const shared = (a: Set<string>, b: Set<string>) => [...a].filter((w) => b.has(w)).length;

type DirectionPlan = {
  stages: { index: number; completesQuest: boolean; failsQuest: boolean }[];
  items: { key: string; name: string }[];
  characters?: { key: string; name: string }[];
  steps?: { from: number | null; to: number; kind: string; targetKey: string | null; note: string }[];
};

/**
 * Plain readings of explicit directions, where the AI left them out or (headings) got them wrong: "pays 100 gold"
 * gives gold, "the quest is done" sets the one stage that completes it, "takes the ledger" takes that item, "the
 * player takes the job" sets the stage of the talk step that says so, "she remembers the promise" remembers it, "he
 * attacks", "leaves for good"; a heading like "Right after the player takes the job" or "When the player comes back
 * with all three pages" says the stage its block is offered at. Returns what was added, in words.
 */
export function directionTags(blocks: WrittenBlock[], plan: DirectionPlan, choices: string[] = []): string[] {
  const out: string[] = [];
  const ends = plan.stages.filter((st) => st.completesQuest && !st.failsQuest);
  const steps = (plan.steps ?? []).filter((st) => typeof st.to === 'number');
  const has = (l: WrittenLine, tag: string) => l.tags.some((t) => t.toLowerCase().startsWith(`[${tag}`));
  const add = (l: WrittenLine, tag: string, why: string) => {
    l.tags.push(tag);
    out.push(`${tag} on “${l.text.slice(0, 40)}${l.text.length > 40 ? '…' : ''}” (${why})`);
  };
  const NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  /** The plan's item a phrase names ("the three pages" → the Torn Map Page). */
  const itemIn = (phrase: string) => {
    const words = phrase.split(/\s+/).map((w) => w.replace(/s$/, ''));
    return plan.items.find((i) => i.name.toLowerCase().replace(/['’]s\b/g, '').split(/\s+/).some((w) => w.length > 3 && words.includes(w.replace(/s$/, ''))) || words.includes(i.key.toLowerCase()));
  };
  /** The talk step a direction names ("the player takes the job" → 10 → 20 "Player agrees to take the job"), if just one does. */
  const talkStep = (note: string) => {
    const w = keyWords(note);
    if (!w.size) return undefined;
    const scored = steps.filter((st) => st.kind === 'talk' && st.note).map((st) => ({ st, hit: shared(w, keyWords(st.note)) }));
    const best = Math.max(0, ...scored.map((x) => x.hit));
    const top = scored.filter((x) => x.hit === best);
    if (best < Math.min(2, w.size) || best / w.size < 0.5 || new Set(top.map((x) => x.st.to)).size !== 1) return undefined;
    return top[0]!.st;
  };
  const REMEMBER = /\bremembers?\b\s+(?:the |that |this |his |her |your |their |what )?([a-z]+)/;
  const lines = blocks.flatMap((b) => b.lines);
  // A choice the AI remembered on a line the author gave no such direction: it belongs on the line that says it.
  const remembering = lines.filter((l) => l.notes.some((n) => REMEMBER.test(n.toLowerCase())));
  const chosen = new Set(lines.flatMap((l) => l.tags).map((t) => /^\[if\s+(?:not\s+)?chose\s+([^\]\s]+)\]/i.exec(t)?.[1]?.toLowerCase()).filter((x): x is string => !!x));
  const misplaced: string[] = [];
  // (With no such direction at all, one is kept only where a line here checks it.)
  for (const l of lines) {
      if (remembering.includes(l)) continue;
      const wrong = l.tags.filter((t) => /^\[remember\s/i.test(t) && (remembering.length > 0 || !chosen.has(/^\[remember\s+([^\]\s]+)/i.exec(t)![1]!.toLowerCase())));
      if (!wrong.length) continue;
      l.tags = l.tags.filter((t) => !wrong.includes(t));
      misplaced.push(...wrong.map((t) => /^\[remember\s+([^\]\s]+)/i.exec(t)![1]!));
    }
  // Choices remembered here or in earlier quests, for "only if the player promised Hesta in Quest 1".
  const known = [...new Set([...choices, ...lines.flatMap((l) => l.tags.map((t) => /^\[remember\s+([^\]\s]+)\]/i.exec(t)?.[1]).filter((x): x is string => !!x))].map((c) => c.toLowerCase()))];
  for (const l of lines) {
    for (const note of l.notes) {
      const n = note.toLowerCase();
      // (Not "150, or 250 if persuaded": that's the line said two ways, each way its own copy.)
      if (/\bif\b/.test(n) && !/\bor\s+\d+/.test(n) && !l.tags.includes('[otherwise]') && !l.tags.some((t) => /^\[if\s+(not\s+)?chose\b/i.test(t))) {
        const words = wordsOf(n);
        const choice = known.find((c) => c.length > 3 && words.some((w) => w.length > 3 && w.slice(0, 5) === c.slice(0, 5)));
        if (choice) add(l, `[if ${/\b(not|didn'?t|never|refused)\b/.test(n) ? 'not ' : ''}chose ${choice}]`, 'a choice made earlier');
      }
      const needs = /\bneeds?\s+(?:at least\s+)?(\d+)\s*(?:gold|septims?|coins?)\b/.exec(n);
      if (needs && !l.tags.some((t) => /^\[if\s+gold/i.test(t))) add(l, `[if gold ${needs[1]}]`, 'needs gold');
      const rem = REMEMBER.exec(n);
      if (rem && !has(l, 'remember')) add(l, `[remember ${misplaced.find((m) => m.slice(0, 4) === rem[1]!.slice(0, 4)) ?? (remembering.length === 1 && misplaced.length ? misplaced[0] : rem[1])}]`, 'remembers the choice');
      if (!/\bif\b/.test(n)) {
        // Each part of the direction in turn ("Rulnik starts following; the player agrees to take him").
        // (Not "objective: …": that's what the player is told next, not what the line does.)
        const st = n
          .split(/;/)
          .filter((part) => !/^\s*(new\s+)?objectives?\b/.test(part))
          .map((part) => talkStep(part))
          .find(Boolean);
        const given = l.tags.find((t) => /^\[stage\s+\d+\]$/i.test(t));
        const at = given ? Number(/(\d+)/.exec(given)![1]) : undefined;
        // The AI's own stage stays unless it's the one the step starts from (setting the stage the quest is at does
        // nothing) or no talk step reaches it.
        if (st && given && at !== st.to && (at === st.from || !steps.some((x) => x.kind === 'talk' && x.to === at))) {
          l.tags = l.tags.filter((t) => t !== given);
          add(l, `[stage ${st.to}]`, `“${st.note}”, not ${given}`);
        } else if (st && !given) add(l, `[stage ${st.to}]`, `“${st.note}”`);
      }
      if (l.player) continue;
      // One amount, said plainly (not "150, or 250 if persuaded": that's two ways of saying the line).
      const gold = /\b(?:pays?|gives?(?: the player)?|hands? over)\s+(\d+)\s*(?:gold|septims?|coins?)\b/.exec(n);
      if (gold && !/\bor\s+\d+/.test(n) && !l.tags.some((t) => /^\[gives gold/i.test(t))) add(l, `[gives gold x${gold[1]}]`, 'pays gold');
      const takesGold = /\btakes?\s+(\d+)\s*(?:gold|septims?|coins?)\b/.exec(n);
      if (takesGold && !l.tags.some((t) => /^\[takes\s+gold/i.test(t))) add(l, `[takes gold x${takesGold[1]}]`, 'takes gold');
      const takes = takesGold ? null : /\b(?:takes?|keeps?)\s+(?:the\s+|his\s+|her\s+)?(?:(a|an|one|two|three|four|five|six|\d+)\s+)?([a-z'’ -]+?)(?:\s+and\b|[;,.]|$)/.exec(n);
      const item = takes ? itemIn(takes[2]!) : undefined;
      if (takes && item && !l.tags.some((t) => /^\[takes\s/i.test(t))) add(l, `[takes ${item.key} x${NUMBERS[takes[1] ?? ''] ?? (Number(takes[1]) || 1)}]`, `takes ${item.name}`);
      const gives = /\b(?:gives?|hands? over)(?:\s+(?:the player|you|him|her))?\s+(?:the\s+|a\s+|an\s+|his\s+|her\s+|their\s+)?([a-z'’ -]+?)(?:\s+and\b|[;,.]|$)/.exec(n);
      const given = gives ? itemIn(gives[1]!) : undefined;
      if (given && !l.tags.some((t) => t.toLowerCase().startsWith(`[gives ${given.key.toLowerCase()}`))) add(l, `[gives ${given.key} x1]`, `gives ${given.name}`);
      if (/\b(the quest is (done|complete|finished|over)|quest ends|ends the quest|completes the quest)\b/.test(n) && !has(l, 'stage') && ends.length === 1) add(l, `[stage ${ends[0]!.index}]`, 'the quest is done');
      if (/\b(attacks?|draws? (his|her) (sword|weapon|blade))\b/.test(n) && !/\bif\b/.test(n) && !has(l, 'attacks')) add(l, '[attacks]', 'attacks');
      if (/\b(leaves? for good|walks? away|is gone|leaves skyrim|disappears?)\b/.test(n) && !has(l, 'leaves')) add(l, '[leaves]', 'leaves');
    }
  }
  // "(if Varro is dead)" and "(if Varro left)": whether that character died, or left (a line with [leaves] remembers
  // that they did, as the choice "varroleft").
  const characterNamed = (word: string) => (plan.characters ?? []).find((c) => [c.key, c.name, c.name.split(/\s+/)[0]].some((n) => n.toLowerCase() === word.toLowerCase()));
  const madeUp = (t: string) => /^\[if\s+(not\s+)?chose\s/i.test(t) && !known.includes(/chose\s+([^\]\s]+)/i.exec(t)![1]!.toLowerCase());
  for (const l of lines) {
    for (const note of l.notes) {
      const dead = /\bif\s+([A-Za-z][\w'’-]*)\s+(?:is|was|has been|gets?)\s+(?:dead|killed)\b|\bif\s+([A-Za-z][\w'’-]*)\s+died\b/i.exec(note);
      const left = /\bif\s+([A-Za-z][\w'’-]*)\s+(?:has\s+)?(?:left|leaves|fled|is gone|went away|walked away)\b/i.exec(note);
      const who = dead ? characterNamed(dead[1] ?? dead[2]!) : left ? characterNamed(left[1]!) : undefined;
      if (!who) continue;
      // A choice the AI made up for it ("[if chose dead]", remembered nowhere) gives way, however often it's asked.
      l.tags = l.tags.filter((t) => !madeUp(t));
      if (dead && !l.tags.some((t) => /^\[if\s+dead\s/i.test(t))) add(l, `[if dead ${who.key}]`, `${who.name} is dead`);
      else if (left && !l.tags.some((t) => /^\[if\s+left\s/i.test(t))) add(l, `[if left ${who.key}]`, `${who.name} left`);
    }
  }
  // A condition the AI put on a whole block that has alternatives ("only if the player took his money" / "otherwise")
  // belongs to the alternative it's about, not to every line.
  for (const b of blocks) {
    if (!b.lines.some((l) => l.tags.includes('[otherwise]'))) continue;
    const choices = b.tags.filter((t) => /^\[if\s+(not\s+)?chose\s/i.test(t));
    if (!choices.length) continue;
    const target = b.lines.find((l) => !l.player && !l.tags.includes('[otherwise]') && l.notes.some((n) => /\bif\b/i.test(n)) && !l.tags.some((t) => /^\[if\s+(not\s+)?chose\s/i.test(t)));
    b.tags = b.tags.filter((t) => !choices.includes(t));
    if (target) target.tags.push(...choices);
    out.push(`${choices.join(' ')} only on “${(target?.text ?? '').slice(0, 40)}”, not the whole conversation (it has an “otherwise”)`);
  }
  for (const l of lines.filter((x) => x.tags.includes('[leaves]'))) {
    const who = characterNamed(l.speaker);
    if (who && !l.tags.some((t) => t.toLowerCase() === `[remember ${leftChoice(who.key)}]`)) add(l, `[remember ${leftChoice(who.key)}]`, `remembers that ${who.name} left`);
  }
  // A choice nothing remembers, on a line whose direction asks for no condition ("(otherwise)", or none at all): the
  // AI made it up, and the line would never be said.
  for (const l of lines) {
    if (l.notes.some((n) => /\b(if|unless)\b/i.test(n))) continue;
    const gone = l.tags.filter(madeUp);
    if (!gone.length) continue;
    l.tags = l.tags.filter((t) => !gone.includes(t));
    out.push(`took ${gone.join(' ')} off “${l.text.slice(0, 40)}${l.text.length > 40 ? '…' : ''}” (nothing remembers that choice, and the line asks for no condition)`);
  }
  // "[if chose persuaded]" with nothing remembering it: a persuasion's success remembers it.
  for (const m of lines.flatMap((l) => l.tags).map((t) => /^\[if\s+chose\s+([^\]\s]+)\]/i.exec(t)?.[1]).filter((x): x is string => !!x && /persua|convinc|intimidat|bribe|haggl/i.test(x))) {
    if (lines.some((l) => l.tags.some((t) => t.toLowerCase() === `[remember ${m.toLowerCase()}]`))) continue;
    for (const l of lines.filter((x) => x.tags.includes('[success]') && !has(x, 'remember'))) add(l, `[remember ${m}]`, 'the persuasion worked');
  }
  // Headings that say when a block is offered: after a step → the stage it sets; while looking for something → the
  // stage it's looked for at; coming back with it → the stage that has it.
  for (const b of blocks) {
    const h = b.header.toLowerCase();
    // Only a heading that says when ("While the player is looking for the pages:"), not a paragraph of the story.
    if (!h || b.scene || !/:\s*$/.test(h) || h.length > 120 || !/\b(when|while|after|once|before|now that|as soon as|during|until|later|next day|tomorrow|dark|night|day)\b/.test(h)) continue;
    // "While the quest is running": whenever the quest runs (its dialogue is only there then), at no one stage.
    if (/\b(while|whenever|as long as) the (quest|job) is (running|on|active|going|open|under way)\b|\bduring the quest\b|\bany time\b/.test(h)) {
      const gate = b.tags.filter((t) => /^\[if\s+(?:stage\s*)?(?:==?\s*)?\d+\]$/i.test(t));
      if (gate.length) out.push(`no stage condition on the conversation “${b.header.slice(0, 50)}${b.header.length > 50 ? '…' : ''}” (said while the quest runs, not only at ${gate.join(' ')})`);
      b.tags = b.tags.filter((t) => !gate.includes(t));
      for (const l of b.lines) l.tags = l.tags.filter((t) => !/^\[if\s+(?:stage\s*)?(?:==?\s*)?\d+\]$/i.test(t));
      continue;
    }
    // The time of day: "after dark only", "during the day".
    const time = /\b(after dark|at night|by night|night only|at nightfall|in the evening)\b/.test(h) ? '[if night]' : /\b(during the day|by day|in the day(time)?|daytime|daylight)\b/.test(h) ? '[if day]' : '';
    if (time && !b.tags.some((t) => /^\[if\s+(night|day|time)\b/i.test(t))) {
      b.tags.push(time);
      out.push(`${time} on the conversation “${b.header.slice(0, 50)}${b.header.length > 50 ? '…' : ''}”`);
    }
    let stage: number | undefined;
    let why = '';
    const waits = steps.filter((st) => st.kind === 'wait');
    const item = itemIn(h.replace(/[^a-z0-9' ]+/g, ' '));
    const pickup = item ? steps.find((st) => st.kind === 'pickup' && st.targetKey === item.key) : undefined;
    if (waits.length === 1 && /\b(a day later|the next day|next morning|the day after|tomorrow|days? later|hours later|later that (day|night))\b/.test(h)) (stage = waits[0]!.to), (why = `after “${waits[0]!.note}”`);
    else if (pickup && /\b(with|has|have|got|brings?|found|finds|returns?|comes? back)\b/.test(h)) (stage = pickup.to), (why = `has ${item!.name}`);
    else if (pickup && typeof pickup.from === 'number' && /\b(looking|searching|search|finding|find|hunting|while)\b/.test(h)) (stage = pickup.from), (why = `looking for ${item!.name}`);
    else if (/\b(after|once|now that|having)\b/.test(h.replace(/\bafter dark\b/g, ''))) {
      const w = keyWords(h);
      const scored = steps.filter((st) => st.note).map((st) => ({ st, hit: shared(w, keyWords(st.note)) }));
      const best = Math.max(0, ...scored.map((x) => x.hit));
      const top = scored.filter((x) => x.hit === best);
      if (best >= 2 && new Set(top.map((x) => x.st.to)).size === 1) (stage = top[0]!.st.to), (why = `after “${top[0]!.st.note}”`);
    }
    if (stage === undefined || !plan.stages.some((st) => st.index === stage)) continue;
    const gate = b.tags.filter((t) => /^\[if\s+(?:stage\s*)?(?:[<>=!]=?\s*)?\d+\]$/i.test(t));
    if (gate.length === 1 && Number(/(\d+)/.exec(gate[0]!)![1]) === stage) continue;
    b.tags = [...b.tags.filter((t) => !gate.includes(t)), `[if stage ${stage}]`];
    out.push(`[if stage ${stage}] on the conversation “${b.header.slice(0, 50)}${b.header.length > 50 ? '…' : ''}” (${why}${gate.length ? `, not ${gate.join(' ')}` : ''})`);
  }
  // A line's own "[if stage N]" in a block offered at one stage only repeats the block's, or (another stage) would
  // never be said: the block's is what counts.
  const exact = /^\[if\s+(?:stage\s*)?(?:==?\s*)?\d+\]$/i;
  for (const b of blocks) if (b.tags.filter((t) => exact.test(t)).length === 1) for (const l of b.lines) l.tags = l.tags.filter((t) => !exact.test(t));
  return out;
}

interface Node {
  line: WrittenLine;
  children: Node[];
}

/** The author's lines as a tree: what each player line is answered with, what each answer offers the player next. */
function tree(lines: WrittenLine[]): Node[] {
  const roots: Node[] = [];
  const stack: Node[] = [];
  for (const line of lines) {
    const node: Node = { line, children: [] };
    // A player line hangs under the nearest answer above it at a smaller depth; an answer under the nearest player line at
    // its depth or less; an answer to nobody (the character speaks first) is a root.
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const fits = line.player ? !top.line.player && top.line.level < line.level : top.line.player ? top.line.level <= line.level : top.line.level < line.level;
      if (fits) break;
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

const isIf = (t: string) => /^\[if\s/i.test(t);

/** What a line's conditions are about (a stage, a choice, an item…), to tell groups of alternatives apart. */
function conditionKinds(tags: string[]): string {
  return tags
    .filter(isIf)
    .map((t) => /^\[if\s+(not\s+|no\s+)?(\w+)/i.exec(t)?.[2]?.toLowerCase() ?? '')
    // What became of someone (dead, alive, left) is one kind of thing: "(if Varro left)" / "(if Varro is dead)".
    .map((k) => (k === 'done' || k === 'stage' ? 'stage' : k === 'chose' || k === 'remembered' ? 'chose' : k === 'dead' || k === 'alive' || k === 'left' || k === 'killed' || k === 'gone' ? 'fate' : k))
    .sort()
    .join(',');
}

/** The opposite of a simple condition ([if chose deal] → [if not chose deal]), or undefined. */
function negate(tag: string): string | undefined {
  const m = /^\[if\s+(.*)\]$/i.exec(tag);
  if (!m || m[1]!.includes(';')) return undefined;
  const c = m[1]!.trim();
  const not = /^(not|no)\s+(.*)$/i.exec(c);
  if (not) return `[if ${not[2]}]`;
  if (/^(chose|remembered|done|has|dead|left)\b/i.test(c)) return `[if not ${c}]`;
  if (/^alive\b/i.test(c)) return `[if dead ${c.replace(/^alive\s+/i, '')}]`;
  const st = /^stage\s*(==?)?\s*(\d+)$/i.exec(c);
  if (st) return `[if stage != ${st[2]}]`;
  return undefined;
}

/**
 * One character's blocks as a screenplay. The character speaking first (with the player's choices under it) becomes
 * a greeting and the choices become things the player can say, with the opening's conditions; answers that depend on
 * something ("(if Varro left)", "(otherwise)") become alternative answers, combined where an answer has two parts.
 */
export function writtenScreenplay(blocks: WrittenBlock[]): string {
  plainNotes(blocks);
  const out: string[] = [];
  const greetings: string[] = [];
  const scenes: string[] = [];
  const tagText = (tags: string[]) => oneOfEach(tags.filter((t) => !/^\[(success|failure|otherwise)\]$/.test(t))).join(' ');
  const say = (indent: number, who: string, text: string, tags: string[]) => `${' '.repeat(indent)}${who}: ${text}${tags.length ? ` ${tagText(tags)}` : ''}`.trimEnd();

  /** Answers to one player line: runs of the same speaker, split into alternatives where lines are conditional. */
  const answers = (nodes: Node[], depth: number, inherited: string[]) => {
    const npcs = nodes.filter((x) => !x.line.player);
    // [persuade]: the success first, then the failure.
    const ordered = [...npcs.filter((x) => x.line.tags.includes('[success]')), ...npcs.filter((x) => !x.line.tags.includes('[success]') && !x.line.tags.includes('[failure]')), ...npcs.filter((x) => x.line.tags.includes('[failure]'))];
    // Groups of alternatives: consecutive conditional lines about the same kind of thing (how the quest went, a
    // choice, what the player has…), closed by an "otherwise"; plain lines are said every time. A group with no
    // "otherwise" may also say nothing ("(only if the player promised)" adds a line when it applies).
    type Part = { alts: (Node | null)[]; closed: boolean } | { fixed: Node };
    const parts: Part[] = [];
    const about = (x: Node) => conditionKinds(x.line.tags);
    for (const x of ordered) {
      const otherwise = x.line.tags.includes('[otherwise]');
      const alt = x.line.tags.some(isIf) || otherwise;
      const last = parts[parts.length - 1];
      const same = last && 'alts' in last && !last.closed && (otherwise || last.alts.some((y) => y && about(y) === about(x)));
      if (alt && same) {
        last.alts.push(x);
        if (otherwise) last.closed = true;
      } else parts.push(alt ? { alts: [x], closed: otherwise } : { fixed: x });
    }
    for (const p of parts) if ('alts' in p && !p.closed) p.alts.push(null);
    const persuade = ordered.some((x) => x.line.tags.includes('[success]') || x.line.tags.includes('[failure]'));
    if (persuade || !parts.some((p) => 'alts' in p)) {
      // Said in order (after a persuasion, each answer is its own: success then failure).
      for (const x of ordered) {
        out.push(say(depth === 0 ? 0 : depth * 4 + 2, x.line.speaker.toUpperCase(), x.line.text, x.line.tags));
        for (const c of x.children) topic(c, depth + 1, inherited.filter(isIf));
      }
      return;
    }
    // Every combination of one line from each group, in order: the first that applies is the one said.
    let combos: Node[][] = [[]];
    for (const p of parts) combos = 'fixed' in p ? combos.map((c) => [...c, p.fixed]) : combos.flatMap((c) => p.alts.map((a) => (a ? [...c, a] : c)));
    combos = combos.filter((c) => c.length);
    for (const combo of combos) {
      const ifs = combo.flatMap((x) => x.line.tags.filter(isIf));
      combo.forEach((x, k) => {
        const own = x.line.tags.filter((t) => !isIf(t));
        const tags = k === 0 ? [...ifs, ...own, ...(combos.indexOf(combo) > 0 ? ['[or]'] : [])] : own;
        out.push(say(depth === 0 ? 0 : depth * 4 + 2, x.line.speaker.toUpperCase(), x.line.text, tags));
      });
      for (const x of combo) for (const c of x.children) topic(c, depth + 1, ifs);
    }
  };
  const topic = (node: Node, depth: number, inherited: string[]) => {
    if (!node.line.player) return;
    const own = [...inherited.filter((t) => !node.line.tags.includes(t)), ...node.line.tags];
    out.push(say(depth * 4, 'PLAYER', node.line.text, own));
    answers(node.children, depth, own);
  };

  for (const b of blocks) {
    if (b.scene) {
      scenes.push(`SCENE: ${b.header.replace(/[:[\]]/g, ' ').trim().slice(0, 60) || 'Scene'} ${tagText(b.tags)}`.trimEnd());
      for (const l of b.lines) scenes.push(say(0, l.speaker.toUpperCase(), l.text, l.tags));
      continue;
    }
    const roots = tree(b.lines);
    for (const [k, root] of roots.entries()) {
      if (root.line.player) {
        topic(root, 0, b.tags);
        continue;
      }
      // An opening said over several lines ("Ah." then "Sit. Drink?", the choices under the last): one greeting.
      const next = roots[k + 1];
      if (!root.children.length && next && !next.line.player && next.line.speaker === root.line.speaker && !root.line.tags.some(isIf) && !root.line.tags.includes('[otherwise]')) {
        next.line = { ...next.line, text: `${root.line.text} ${next.line.text}`, tags: [...root.line.tags, ...next.line.tags] };
        continue;
      }
      // The character speaks first: a greeting (with the block's and its own conditions), then the choices under it.
      // An opening said "otherwise" offers its choices only when the other openings' conditions don't hold.
      const others = root.line.tags.includes('[otherwise]') ? tree(b.lines).filter((r) => r !== root && !r.line.player).flatMap((r) => r.line.tags.filter(isIf)) : [];
      const ifs = [...b.tags.filter(isIf), ...root.line.tags.filter(isIf), ...others.map(negate).filter((t): t is string => !!t)];
      greetings.push(say(0, root.line.speaker.toUpperCase(), root.line.text, [...ifs, ...root.line.tags.filter((t) => !isIf(t))]));
      for (const c of root.children) {
        if (c.line.player) topic(c, 0, [...b.tags.filter((t) => !isIf(t)), ...ifs]);
        // More lines the character says straight after (a run of lines): part of the greeting.
        else greetings.push(say(0, c.line.speaker.toUpperCase(), c.line.text, c.line.tags));
      }
    }
  }
  return [...out, ...(greetings.length ? ['GREETING:', ...greetings] : []), ...scenes].join('\n');
}

/** How alike two lines are (shared words over all words), for telling the author's lines from an AI's. */
export function similarity(a: string, b: string): number {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z']+/g) ?? []);
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.max(x.size, y.size);
}

/** Lines of the author's that a screenplay doesn't have word for word. */
export function missingLines(blocks: WrittenBlock[], screenplay: string): WrittenLine[] {
  const said = new Set(
    screenplay
      .split(/\r?\n/)
      .map((l) => /^\s*[^:]+:\s*(.*)$/.exec(l)?.[1] ?? '')
      .map((t) => t.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()),
  );
  return blocks.flatMap((b) => b.lines).filter((l) => l.text && !said.has(l.text.replace(/\s+/g, ' ').trim().toLowerCase()));
}

/** Whether an [if …] tag reads (for checking the AI's tags before they go in). */
export function readableIf(tag: string): boolean {
  const m = /^\[if\s+(.*)\]$/i.exec(tag);
  if (!m) return true;
  try {
    parseIf(m[1]);
    return true;
  } catch {
    return false;
  }
}
