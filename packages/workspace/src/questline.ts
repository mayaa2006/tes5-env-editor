/**
 * Questlines: several quests written as one document ("Quest 1: …", "Quest 2: …"), planned one after another so
 * each later quest knows the characters, places, items and choices of the earlier ones, then built together as one
 * undo step. Characters, places and items keep their key from quest to quest: the first quest that has them makes
 * them, and later quests use those (a character who turns up somewhere else is moved there when the quest starts).
 * Each quest starts when the one before it ends, unless its plan says otherwise.
 */
import type { FormKey } from '@tes5/esp';
import { WorkspaceError, type Workspace } from './engine';
import { normalizePlan, validatePlan, type PlanCharacter, type PlanIssue, type QuestPlan } from './questplan';
import type { QuestBuildReport, QuestBuilder } from './questbuilder';
import type { QuestPlanner } from './planner';

export interface QuestlinePart {
  title: string;
  text: string;
}

export interface Questline {
  title: string;
  /** What every quest shares: the introduction, the cast, the setting. */
  shared: string;
  parts: QuestlinePart[];
}

export interface QuestlinePlan {
  title: string;
  quests: { title: string; source: string; plan: QuestPlan }[];
}

const QUEST_HEADING = /^(?:quest|part|chapter|act|mission|episode|stage)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|[ivxlc]+)\b\s*[:.)–—-]?\s*(.*)$/i;

/**
 * The quests in a document, by their headings ("## Quest 1: Lines on a Map", "Part two – …", or a line on its own
 * like "Quest 3: Business After Dark"). Null when there are fewer than two.
 */
export function splitQuestline(text: string): Questline | null {
  const rows = text.split(/\r?\n/);
  const heads: { row: number; level: number; title: string }[] = [];
  let title = '';
  rows.forEach((raw, row) => {
    const md = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(raw);
    const line = (md?.[2] ?? raw).replace(/^\*\*|\*\*$/g, '').trim();
    if (md && md[1]!.length === 1 && !title) title = line;
    if (QUEST_HEADING.test(line) && (md || line.length < 90)) heads.push({ row, level: md ? md[1]!.length : 9, title: line });
  });
  if (heads.length < 2) return null;
  // The quests are the headings at the most common level ("## Quest 1" … "## Quest 4", not "### Quest 1 dialogue").
  const counts = new Map<number, number>();
  for (const h of heads) counts.set(h.level, (counts.get(h.level) ?? 0) + 1);
  const level = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
  const quests = heads.filter((h) => h.level === level);
  if (quests.length < 2) return null;
  // A part ends at the next heading of its level or higher (other sections at that level after the last quest are shared).
  const endOf = (row: number) => {
    for (let r = row + 1; r < rows.length; r++) {
      const md = /^(#{1,4})\s/.exec(rows[r]!);
      if (level < 9 && md && md[1]!.length <= level) return r;
      if (level === 9 && quests.some((q) => q.row === r)) return r;
    }
    return rows.length;
  };
  const parts = quests.map((q) => ({ title: q.title, text: rows.slice(q.row + 1, endOf(q.row)).join('\n').trim() }));
  const used = new Set<number>();
  for (const q of quests) for (let r = q.row; r < endOf(q.row); r++) used.add(r);
  const shared = rows
    .filter((_, r) => !used.has(r))
    .join('\n')
    .trim();
  return { title: title || quests[0]!.title, shared, parts };
}

/** One quest of a questline as the planner reads it: what they all share, then this quest. */
export function questlineSource(line: Questline, i: number): string {
  const part = line.parts[i]!;
  // The cast as this quest needs it: someone the quest never names is only mentioned, so the AI doesn't plan them.
  const named = (name: string) => [name, name.split(/\s+/)[0]!].some((n) => n.length > 2 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(part.text));
  const absent: string[] = [];
  const rows = line.shared.split(/\r?\n/).flatMap((row) => {
    const who = /^\s*[-*+]\s+\*\*([^*:]+?)\*\*/.exec(row)?.[1]?.trim();
    if (!who || named(who)) return [row];
    absent.push(who);
    return absent.length === 1 ? ['\u0000'] : [];
  });
  const shared = rows.join('\n').replace('\u0000', `- Also in the questline, not in this quest: ${absent.join(', ')}.`);
  return `${shared}\n\n## ${part.title}\n\n${part.text}`.trim();
}

/** Choices a plan's dialogue remembers ([remember NAME]). */
export function rememberedChoices(plan: QuestPlan): string[] {
  const out = new Set<string>();
  for (const c of plan.conversations) for (const m of c.screenplay.matchAll(/\[remember\s+([A-Za-z][\w-]*)\]/gi)) out.add(m[1]!.toLowerCase());
  return [...out];
}

/** What the planner is told about the questline when it plans quest `i` (earlier quests already planned). */
export function questlineContext(line: Questline, i: number, earlier: QuestPlan[]): string {
  const titles = line.parts.map((p, n) => `${n + 1}. ${p.title}`).join('; ');
  const head = `This is quest ${i + 1} of ${line.parts.length} in the questline “${line.title}” (${titles}). Plan only this quest; the others are planned separately.`;
  if (!earlier.length) return head;
  const list = (xs: { key: string; name: string; existing: string | null }[]) => xs.map((x) => `${x.key} (${x.name}${x.existing ? `, ${x.existing}` : ''})`).join(', ') || 'none';
  const done = earlier.map((p, n) => {
    const end = p.stages.filter((st) => st.completesQuest).map((st) => st.index);
    return `- Quest ${n + 1} “${p.title}”, Editor ID ${p.editorId}: characters ${list(p.characters)}; places ${list(p.locations)}; items ${list(p.items)}; choices it remembers: ${rememberedChoices(p).join(', ') || 'none'}; it ends at stage ${end.join(' or ') || 'its last stage'}.`;
  });
  const prev = earlier[earlier.length - 1]!;
  return [
    head,
    'Earlier quests, already planned:',
    ...done,
    `Characters, places and items from earlier quests are made once, by the quest that first has them. Use the same key and name for them here (existing null is fine) and only say what changes: where they are now, what they do in this quest. Choices made earlier are checked with [if chose NAME] using the names above.`,
    `This quest starts when quest ${i} ends: startsWithGame false, startsWhen afterQuest with quest ${prev.editorId} and stage null, even when it begins with someone talking to the player.`,
  ].join('\n');
}

/**
 * After a questline's quest is planned: its Editor ID kept apart from the others', and (from the second quest on)
 * started by the one before when nothing else starts it.
 */
export function settleQuestlinePlan(plan: QuestPlan, earlier: QuestPlan[]): string[] {
  normalizePlan(plan);
  const out: string[] = [];
  // Someone an earlier quest makes, named as if they were already in the game: the same entry as there.
  const lists = [['characters', 'character'], ['locations', 'place'], ['items', 'item']] as const;
  for (const [field] of lists) {
    for (const x of plan[field] as { key: string; name: string; existing: string | null }[]) {
      if (!x.existing) continue;
      const hit = earlier.flatMap((p) => p[field] as { key: string; name: string; existing: string | null }[]).find((y) => !y.existing && (same(y.name, x.existing!) || same(y.key, x.existing!) || same(y.name, x.name)));
      if (!hit) continue;
      x.existing = null;
      if (x.key !== hit.key && !(plan[field] as { key: string }[]).some((z) => z.key === hit.key)) renameKey(plan, x.key, hit.key);
    }
  }
  const ids = new Set(earlier.map((p) => p.editorId.toLowerCase()));
  if (ids.has(plan.editorId.toLowerCase())) {
    let n = earlier.length + 1;
    while (ids.has(`${plan.editorId}${n}`.toLowerCase())) n++;
    out.push(`The Editor ID ${plan.editorId} is the same as an earlier quest's, so this one is ${plan.editorId}${n}`);
    plan.editorId = `${plan.editorId}${n}`;
  }
  const prev = earlier[earlier.length - 1];
  if (prev) {
    const sw = plan.startsWhen;
    const startsOtherwise = sw && sw.kind !== 'game' && sw.kind !== 'afterQuest';
    if (!startsOtherwise) {
      // Named by title or by the wrong ID: the quest before it.
      const named = sw?.kind === 'afterQuest' ? earlier.find((p) => [p.editorId, p.title].some((x) => x.toLowerCase() === (sw.quest ?? '').toLowerCase())) : undefined;
      const after = named ?? prev;
      if (plan.startsWithGame || sw?.kind !== 'afterQuest' || sw.quest !== after.editorId) out.push(`Starts when “${after.title}” ends`);
      plan.startsWithGame = false;
      plan.startsWhen = { kind: 'afterQuest', targetKey: null, quest: after.editorId, stage: sw?.kind === 'afterQuest' && named ? sw.stage : null };
    }
  }
  if (out.length) plan.assumptions = [...(plan.assumptions ?? []), ...out];
  return out;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Plan every quest of a questline, in order: each one is told what the earlier ones have (characters, places, items,
 * choices, Editor IDs), then settled (`settle`, e.g. characters as the text asks) and started by the one before.
 * `progress` is told which quest is being planned (with the built-in AI each can take a while).
 */
export async function planQuestline(
  planner: QuestPlanner | ((quest: number) => QuestPlanner),
  line: Questline,
  opts: { catalog: (text: string) => string; settle?: (plan: QuestPlan, source: string) => void; progress?: (i: number, n: number, title: string) => void },
): Promise<QuestlinePlan> {
  const quests: QuestlinePlan['quests'] = [];
  for (const [i, part] of line.parts.entries()) {
    opts.progress?.(i, line.parts.length, part.title);
    const source = questlineSource(line, i);
    const earlier = quests.map((q) => q.plan);
    const names = earlier.flatMap((p) => [...p.characters, ...p.locations].map((x) => x.name)).join('\n');
    const p = typeof planner === 'function' ? planner(i) : planner;
    const plan = await p.plan(source, 'document', opts.catalog(`${source}\n${names}`), { context: questlineContext(line, i, earlier) });
    opts.settle?.(plan, source);
    settleQuestlinePlan(plan, earlier);
    quests.push({ title: part.title, source, plan });
  }
  return { title: line.title, quests };
}
const firstName = (n: string) => n.trim().toLowerCase().split(/\s+/)[0]!;

/** The earlier plan's entry that a later plan's entry is (same key, or the same name). */
function earlierOf<T extends { key: string; name: string; existing: string | null }>(x: T, lists: T[][]): { quest: number; entry: T } | undefined {
  for (let q = 0; q < lists.length; q++) {
    const hit = lists[q]!.find((y) => !y.existing && (same(y.key, x.key) || same(y.name, x.name) || (x.name.includes(' ') || y.name.includes(' ') ? firstName(y.name) === firstName(x.name) && firstName(x.name).length > 2 && same(y.key, x.key) : false)));
    if (hit) return { quest: q, entry: hit };
  }
  return undefined;
}

/** What links a questline's quests: entries a later quest takes from an earlier one, for the review and the build. */
export interface QuestlineLink {
  quest: number;
  kind: 'character' | 'location' | 'item';
  key: string;
  from: number;
  fromKey: string;
  name: string;
}

export function questlineLinks(plans: QuestPlan[]): QuestlineLink[] {
  const out: QuestlineLink[] = [];
  for (let i = 1; i < plans.length; i++) {
    const before = plans.slice(0, i);
    for (const c of plans[i]!.characters) {
      if (c.existing) continue;
      const e = earlierOf(c, before.map((p) => p.characters));
      if (e) out.push({ quest: i, kind: 'character', key: c.key, from: e.quest, fromKey: e.entry.key, name: c.name });
    }
    for (const l of plans[i]!.locations) {
      if (l.existing) continue;
      const e = earlierOf(l, before.map((p) => p.locations));
      if (e) out.push({ quest: i, kind: 'location', key: l.key, from: e.quest, fromKey: e.entry.key, name: l.name });
    }
    for (const it of plans[i]!.items) {
      if (it.existing || it.kind === 'gold') continue;
      const e = earlierOf(it, before.map((p) => p.items));
      if (e) out.push({ quest: i, kind: 'item', key: it.key, from: e.quest, fromKey: e.entry.key, name: it.name });
    }
  }
  return out;
}

/** Problems that span the questline: choices checked before any quest remembers them, quests that start nothing. */
export function questlineIssues(plans: QuestPlan[]): PlanIssue[] {
  const out: PlanIssue[] = [];
  const remembered = new Set<string>();
  plans.forEach((p, i) => {
    for (const r of rememberedChoices(p)) remembered.add(r);
    const asked = new Set<string>();
    for (const c of p.conversations) for (const m of c.screenplay.matchAll(/\[if\s+(?:not\s+)?(?:chose|remembered|remembers)\s+([A-Za-z][\w-]*)\]/gi)) asked.add(m[1]!.toLowerCase());
    for (const a of asked) if (!remembered.has(a)) out.push({ severity: 'warning', message: `Quest ${i + 1} (${p.title}) checks the choice “${a}”, but no quest up to it remembers it ([remember ${a}])` });
  });
  for (let i = 1; i < plans.length; i++) {
    const sw = plans[i]!.startsWhen;
    if (!plans[i]!.startsWithGame && !sw) out.push({ severity: 'warning', message: `Nothing starts quest ${i + 1} (${plans[i]!.title})` });
  }
  return out;
}

/** Give a plan entry another key, everywhere the plan refers to it. */
function renameKey(plan: QuestPlan, from: string, to: string): void {
  const swap = (v: string | null) => (v === from ? to : v);
  for (const c of plan.characters) {
    if (c.key === from) c.key = to;
    c.locationKey = swap(c.locationKey);
    for (const r of c.routine ?? []) r.where = swap(r.where);
    for (const r of c.relationships ?? []) r.with = swap(r.with) ?? r.with;
  }
  for (const l of plan.locations) {
    if (l.key === from) l.key = to;
    l.doorFrom = swap(l.doorFrom);
  }
  for (const i of plan.items) {
    if (i.key === from) i.key = to;
    i.startsAtKey = swap(i.startsAtKey);
    i.lockedWith = swap(i.lockedWith);
  }
  for (const e of plan.encounters) e.locationKey = swap(e.locationKey) ?? e.locationKey;
  for (const o of plan.objectives) o.targetKey = swap(o.targetKey);
  for (const st of plan.steps) st.targetKey = swap(st.targetKey);
  for (const r of plan.rewards) r.itemKey = swap(r.itemKey);
  for (const a of plan.animations) a.characterKey = swap(a.characterKey) ?? a.characterKey;
  for (const e of plan.events) (e.targetKey = swap(e.targetKey)), (e.toKey = swap(e.toKey));
  for (const f of plan.failures) f.targetKey = swap(f.targetKey);
  if (plan.startsWhen) plan.startsWhen.targetKey = swap(plan.startsWhen.targetKey);
  // Speakers and item tags in the dialogue.
  const re = new RegExp(`(^\\s*)${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s*:)`, 'gim');
  for (const c of plan.conversations) c.screenplay = c.screenplay.replace(re, `$1${to.toUpperCase()}$2`).replace(new RegExp(`(\\[(?:gives|takes|if\\s+(?:not\\s+)?has)\\s+)${from}(\\b)`, 'gi'), `$1${to}$2`);
}

/** The parts of a character that a later quest doesn't redo (they were made by an earlier one): only where they go and what they do in this quest. */
function asExisting(c: PlanCharacter, editorId: string): void {
  c.existing = editorId;
  c.basedOn = null;
  c.sex = null;
  c.race = null;
  c.look = null;
  c.voice = null;
  c.essential = null;
  c.className = null;
  c.level = null;
  c.outfit = null;
  c.factions = [];
  c.inventory = [];
  c.combat = null;
  c.roles = null;
  c.relationships = [];
  c.spot = null;
  c.routine = (c.routine ?? []).filter((r) => r.fromStage !== null || r.untilStage !== null || r.activity === 'follow' || r.activity === 'forcegreet');
}

export interface QuestlineBuildReport {
  title: string;
  quests: QuestBuildReport[];
  /** What linking the quests did, in words. */
  links: string[];
}

/**
 * Build every quest of a questline in order, as one undo step. Before each quest is built, what it shares with the
 * quests before it is pointed at what they made: their characters (moved if this quest has them somewhere else),
 * their new places and their items.
 */
export async function buildQuestline(ws: Workspace, builder: QuestBuilder, line: QuestlinePlan): Promise<QuestlineBuildReport> {
  if (!line.quests.length) throw new WorkspaceError('The questline has no quests to build');
  return ws.transactionAsync(`Build questline ${line.title}`, async () => {
    const reports: QuestBuildReport[] = [];
    const notes: string[] = [];
    const built: { plan: QuestPlan; npcs: Record<string, FormKey>; cells: Record<string, FormKey>; items: Record<string, FormKey> }[] = [];
    for (const [i, q] of line.quests.entries()) {
      const plan = normalizePlan(structuredClone(q.plan));
      const start = ([...plan.stages].sort((a, b) => a.index - b.index).find((st) => st.startsQuest) ?? plan.stages[0])?.index ?? 0;
      const id = (key: FormKey | undefined) => (key ? (ws.view(key)?.editorId ?? key) : undefined);
      const links = questlineLinks([...built.map((b) => b.plan), plan]).filter((l) => l.quest === built.length);
      // Places and items first (a character may be moving to a place an earlier quest made).
      for (const link of links.filter((l) => l.kind !== 'character')) {
        const from = built[link.from]!;
        if (link.kind === 'location') {
          const l = plan.locations.find((x) => x.key === link.key)!;
          const cell = id(from.cells[link.fromKey]);
          if (!cell) continue;
          l.existing = cell;
          l.layoutLike = null;
          l.doorFrom = null;
        } else {
          const it = plan.items.find((x) => x.key === link.key)!;
          const item = id(from.items[link.fromKey]);
          if (!item) continue;
          it.existing = item;
          it.basedOn = null;
          it.text = null;
          it.copies = null;
          // Already in the world (or with someone) from the earlier quest: not put there a second time.
          if (it.startsWith === 'location') it.startsWith = 'nowhere';
        }
      }
      const cellOf = (key: string | null | undefined): FormKey | undefined => {
        const l = key ? plan.locations.find((x) => x.key === key) : undefined;
        return l?.existing ? builder.findForm(['CELL'], l.existing) : undefined;
      };
      for (const link of links.filter((l) => l.kind === 'character')) {
        const from = built[link.from]!;
        const c = plan.characters.find((x) => x.key === link.key)!;
        const npc = id(from.npcs[link.fromKey]);
        if (!npc) continue;
        // Somewhere else in this quest: moved there when it starts, and kept there while it runs.
        const was = from.plan.characters.find((x) => x.key === link.fromKey)?.locationKey;
        const wasCell = was ? from.cells[was] : undefined;
        const now = c.locationKey;
        const nowCell = cellOf(now);
        asExisting(c, npc);
        if (now && !(wasCell && nowCell === wasCell)) {
          const where = plan.locations.find((l) => l.key === now)?.name ?? now;
          c.routine = [{ activity: 'sandbox', where: now, hours: null, fromStage: start, untilStage: null, line: null }, ...c.routine];
          plan.events.push({ atStage: start, kind: 'moveTo', targetKey: c.key, toKey: now, what: null, count: null, note: `${c.name} goes to ${where}` });
          notes.push(`Quest ${i + 1}: ${c.name} (made in quest ${link.from + 1}) is moved to ${where} when it starts`);
        }
        c.locationKey = null;
      }
      // Started by the quest before, under the Editor ID it was actually given.
      const sw = plan.startsWhen;
      if (sw?.kind === 'afterQuest' && i > 0) {
        const before = line.quests.findIndex((x) => x.plan.editorId === sw.quest);
        const b = reports[before >= 0 && before < i ? before : i - 1]!;
        if (b.editorId) sw.quest = b.editorId;
      }
      const errors = validatePlan(plan).filter((x) => x.severity === 'error');
      if (errors.length) throw new WorkspaceError(`Quest ${i + 1} (${plan.title}) can't be built yet:\n${errors.map((e) => `• ${e.message}`).join('\n')}`);
      const report = await builder.build(plan, { seed: i + 1 });
      reports.push(report);
      const rec = report.quest ? await builder.record(report.quest) : null;
      built.push({ plan, npcs: rec?.npcs ?? {}, cells: rec?.cells ?? {}, items: rec?.items ?? {} });
    }
    return { title: line.title, quests: reports, links: notes };
  });
}
