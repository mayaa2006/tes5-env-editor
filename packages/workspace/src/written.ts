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
import { parseIf } from './dialogueif';

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
    blocks.push({ id: blocks.length + 1, header: sceneHead ? [lastProse, sceneHead[1]].filter(Boolean).join(' ') : lastProse, scene: !!sceneHead, speaker: run.find((r) => r.line.speaker.toLowerCase() === main)?.line.speaker ?? main, lines, tags: [] });
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
  /** Tags for single lines (what saying them does, or when they're offered). */
  lines: { line: number; tags: string }[];
}

/** Only tags the editor knows, written the way the screenplay format reads them. */
function cleanTags(tags: string): string[] {
  return [...tags.matchAll(/\[([a-z]+)((?:\s+[^\]]*)?)\]/gi)].map((m) => `[${m[1]!.toLowerCase()}${m[2] ?? ''}]`);
}

/** Put the AI's tags on the blocks and lines they're for. */
export function applyAnnotation(blocks: WrittenBlock[], a: DialogueAnnotation): void {
  for (const x of a.blocks ?? []) {
    const b = blocks.find((y) => y.id === x.block);
    if (b) b.tags.push(...cleanTags(x.tags ?? ''));
  }
  const byN = new Map(blocks.flatMap((b) => b.lines.map((l) => [l.n, { l, b }] as const)));
  for (const x of a.lines ?? []) {
    const hit = byN.get(x.line);
    if (!hit) continue;
    const { l, b } = hit;
    // "A | B": the line said two ways (paying 250 if persuaded, otherwise 150): a copy for each.
    const variants = (x.tags ?? '').split('|').map(cleanTags);
    if (variants.length > 1 && !l.player && variants[0]!.some(isIf)) {
      const at = b.lines.indexOf(l);
      const copies = variants.slice(1).map((v) => ({ ...l, notes: [], tags: [...l.tags, ...v, ...(v.some(isIf) ? [] : ['[otherwise]'])] }));
      l.tags.push(...variants[0]!);
      b.lines.splice(at + 1, 0, ...copies);
      continue;
    }
    l.tags.push(...variants.flat().filter((t) => !l.tags.includes(t)));
  }
}

/**
 * Plain readings of explicit directions, for lines the AI left without them: "pays 100 gold" gives gold, "the quest is
 * done" sets the one stage that completes it, "takes the ledger" takes that item, "he attacks", "leaves for good".
 * Returns what was added, in words.
 */
export function directionTags(blocks: WrittenBlock[], plan: { stages: { index: number; completesQuest: boolean; failsQuest: boolean }[]; items: { key: string; name: string }[] }): string[] {
  const out: string[] = [];
  const ends = plan.stages.filter((st) => st.completesQuest && !st.failsQuest);
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
  for (const b of blocks)
    for (const l of b.lines) {
      if (l.player) continue;
      for (const note of l.notes) {
        const n = note.toLowerCase();
        // One amount, said plainly (not "150, or 250 if persuaded": that's two ways of saying the line).
        const gold = /\b(?:pays?|gives?(?: the player)?|hands? over)\s+(\d+)\s*(?:gold|septims?|coins?)\b/.exec(n);
        if (gold && !/\bor\s+\d+/.test(n) && !l.tags.some((t) => /^\[gives gold/i.test(t))) add(l, `[gives gold x${gold[1]}]`, 'pays gold');
        const takes = /\b(?:takes?|keeps?)\s+(?:the\s+|his\s+|her\s+)?(?:(a|an|one|two|three|four|five|six|\d+)\s+)?([a-z'’ -]+?)(?:\s+and\b|[;,.]|$)/.exec(n);
        const item = takes ? itemIn(takes[2]!) : undefined;
        if (takes && item && !l.tags.some((t) => /^\[takes\s/i.test(t))) add(l, `[takes ${item.key} x${NUMBERS[takes[1] ?? ''] ?? (Number(takes[1]) || 1)}]`, `takes ${item.name}`);
        if (/\b(the quest is (done|complete|finished|over)|quest ends|ends the quest|completes the quest)\b/.test(n) && !has(l, 'stage') && ends.length === 1) add(l, `[stage ${ends[0]!.index}]`, 'the quest is done');
        if (/\b(attacks?|draws? (his|her) (sword|weapon|blade))\b/.test(n) && !/\bif\b/.test(n) && !has(l, 'attacks')) add(l, '[attacks]', 'attacks');
        if (/\b(leaves? for good|walks? away|is gone|leaves skyrim|disappears?)\b/.test(n) && !has(l, 'leaves')) add(l, '[leaves]', 'leaves');
      }
    }
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
    .map((k) => (k === 'done' || k === 'stage' ? 'stage' : k === 'chose' || k === 'remembered' ? 'chose' : k))
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
  if (/^(chose|remembered|done|has)\b/i.test(c)) return `[if not ${c}]`;
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
