/**
 * The journal and objective writer: drafts journal entries and objectives
 * in Skyrim's style from what moves the quest on ("I spoke with Brynja. I
 * should find her ring." / "Find Brynja's Ring"), and checks the wording of
 * what's there. Works on a quest in the plugin (its quest map) and on a
 * quest plan before it's built. Claude can polish the drafts (planner.ts).
 */
import { parseFormKey, type FormKey } from '@tes5/esp';
import { parseScreenplay } from './dialogue';
import type { Workspace } from './engine';
import type { QuestGraph } from './questgraph';
import type { QuestPlan } from './questplan';

export type JournalStepKind = 'talk' | 'pickup' | 'activate' | 'death' | 'arrive' | 'read' | 'equip' | 'drop' | 'hit' | 'load' | 'script' | 'clear';

/** A quest as the writer sees it. */
export interface JournalContext {
  title: string;
  summary?: string;
  stages: { index: number; journal: string; startsQuest: boolean; completesQuest: boolean; failsQuest: boolean }[];
  steps: { from: number | null; to: number; kind: JournalStepKind; target: string | null; note?: string }[];
  objectives: { index: number; text: string; shownAtStage: number | null; completedAtStage: number | null }[];
}

export interface JournalDraft {
  stages: { index: number; journal: string }[];
  objectives: { index: number; text: string; shownAtStage: number; completedAtStage: number | null }[];
}

export interface JournalLint {
  severity: 'warning';
  message: string;
  stage?: number;
  objective?: number;
}

/** Longer objectives wrap or are cut off in the HUD. */
export const OBJECTIVE_MAX = 60;

const OBJECTIVE: Record<JournalStepKind, (t: string) => string> = {
  talk: (t) => `Speak to ${t}`,
  pickup: (t) => `Find ${t}`,
  load: (t) => `Find ${t}`,
  read: (t) => `Read ${t}`,
  equip: (t) => `Put on ${t}`,
  drop: (t) => `Hand over ${t}`,
  activate: (t) => `Use ${t}`,
  death: (t) => `Kill ${t}`,
  clear: (t) => `Defeat ${t}`,
  hit: (t) => `Confront ${t}`,
  arrive: (t) => `Go to ${t}`,
  script: () => '',
};

const DONE: Record<JournalStepKind, (t: string) => string> = {
  clear: (t) => `I defeated ${t}.`,
  talk: (t) => `I spoke with ${t}.`,
  pickup: (t) => `I found ${t}.`,
  load: (t) => `I found ${t}.`,
  read: (t) => `I read ${t}.`,
  equip: (t) => `I put on ${t}.`,
  drop: (t) => `I handed over ${t}.`,
  activate: (t) => `I used ${t}.`,
  death: (t) => `I killed ${t}.`,
  hit: (t) => `I confronted ${t}.`,
  arrive: (t) => `I reached ${t}.`,
  script: () => '',
};

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Draft the missing journal entries and objectives (or all of them, with `overwrite`). */
export function draftJournal(ctx: JournalContext, opts: { overwrite?: boolean } = {}): JournalDraft {
  const stages = [...ctx.stages].sort((a, b) => a.index - b.index);
  const out: JournalDraft = { stages: [], objectives: [] };
  const into = (s: number) => ctx.steps.filter((x) => x.to === s && x.kind !== 'script' && x.target);
  const outOf = (s: number) => ctx.steps.filter((x) => x.from === s && x.kind !== 'script' && x.target);
  for (const s of stages) {
    if (s.journal.trim() && !opts.overwrite) continue;
    const before = into(s.index)[0];
    const next = s.completesQuest || s.failsQuest ? undefined : outOf(s.index)[0];
    const parts: string[] = [];
    if (before) parts.push(DONE[before.kind](before.target!));
    if (next) parts.push(`I should ${lower(OBJECTIVE[next.kind](next.target!))}.`);
    if (s.completesQuest && !parts.length) parts.push(`I have finished “${ctx.title}”.`);
    // The opening stage is usually silent; it only gets an entry when there's something to say.
    if (s.startsQuest && !before && !s.journal.trim()) continue;
    if (parts.length) out.stages.push({ index: s.index, journal: parts.join(' ') });
  }
  const used = new Set(ctx.objectives.map((o) => o.index));
  for (const s of stages) {
    const next = outOf(s.index)[0];
    if (!next || s.completesQuest || s.failsQuest) continue;
    const shownHere = ctx.objectives.filter((o) => o.shownAtStage === s.index);
    if (shownHere.length && !opts.overwrite) continue;
    const text = OBJECTIVE[next.kind](next.target!);
    const existing = shownHere[0];
    let index = existing?.index ?? s.index;
    while (!existing && used.has(index)) index++;
    used.add(index);
    out.objectives.push({ index, text, shownAtStage: s.index, completedAtStage: next.to });
  }
  return out;
}

/** Wording problems: journal written to "you", objectives with full stops or too long, a silent ending. */
export function lintJournal(ctx: JournalContext): JournalLint[] {
  const out: JournalLint[] = [];
  for (const s of ctx.stages) {
    const j = s.journal.trim();
    if (j && /(^|[.!?]\s+)you\b/i.test(j)) out.push({ severity: 'warning', message: `Stage ${s.index}: the journal speaks to “you”`, stage: s.index });
    if (j && !/\b(I|me|my|myself)\b/i.test(j)) out.push({ severity: 'warning', message: `Stage ${s.index}: the journal isn't written as the player (“I …”)`, stage: s.index });
    if (s.completesQuest && !j) out.push({ severity: 'warning', message: `Stage ${s.index} completes the quest but has no journal entry`, stage: s.index });
  }
  for (const o of ctx.objectives) {
    const t = o.text.trim();
    if (!t) out.push({ severity: 'warning', message: `Objective ${o.index} has no text`, objective: o.index });
    else {
      if (/[.!]$/.test(t)) out.push({ severity: 'warning', message: `Objective ${o.index} ends with a full stop (objectives don't)`, objective: o.index });
      if (t.length > OBJECTIVE_MAX) out.push({ severity: 'warning', message: `Objective ${o.index} is long (${t.length} characters) for the screen`, objective: o.index });
      if (/^I\b/.test(t)) out.push({ severity: 'warning', message: `Objective ${o.index} should be an instruction (“Find …”), not “I …”`, objective: o.index });
    }
    if (o.shownAtStage === null) out.push({ severity: 'warning', message: `Objective ${o.index} is never shown`, objective: o.index });
  }
  return out;
}

/** A readable name for a form: its name, or what a placed object is. */
function formName(ws: Workspace, key: FormKey | null | undefined): string | null {
  if (!key) return null;
  const s = ws.summary(key);
  if (s?.name) return s.name;
  if (s && (s.sig === 'REFR' || s.sig === 'ACHR')) {
    const v = ws.view(key);
    const base = (v?.data as { base?: FormKey } | undefined)?.base;
    const b = base ? ws.summary(base) : undefined;
    // "Arrive" steps listen on a marker in the cell: name the place, not the marker.
    if (/marker/i.test(b?.editorId ?? '') && v?.parent.cell) return formName(ws, v.parent.cell);
    if (b?.name) return b.name;
    if (b?.editorId) return b.editorId;
  }
  if (s?.sig === 'CELL') return s.name ?? s.editorId ?? null;
  return s?.editorId ?? (key.includes(':') ? `${parseFormKey(key).objectId.toString(16)}` : key);
}

export function journalContextFromGraph(ws: Workspace, g: QuestGraph): JournalContext {
  return {
    title: g.name ?? g.editorId ?? 'the quest',
    stages: g.nodes.map((n) => ({ index: n.stage, journal: n.text, startsQuest: n.startUp, completesQuest: n.completesQuest, failsQuest: n.failsQuest })),
    steps: g.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind as JournalStepKind, target: formName(ws, e.target ?? null) })),
    objectives: g.objectives.map((o) => {
      const shown = g.nodes.find((n) => n.shows.includes(o.index));
      const done = g.nodes.find((n) => n.completes.includes(o.index));
      return { index: o.index, text: o.text, shownAtStage: shown?.stage ?? null, completedAtStage: done?.stage ?? null };
    }),
  };
}

export function journalContextFromPlan(plan: QuestPlan): JournalContext {
  const names = new Map<string, string>([...plan.characters, ...plan.locations, ...plan.items].map((e) => [e.key, e.name]));
  // Who you talk to for a "talk" step: whoever says the line that sets that stage.
  const talker = (stage: number): string | null => {
    for (const c of plan.conversations) {
      const parsed = parseScreenplay(c.screenplay);
      const walk = (topics: typeof parsed.topics): string | null => {
        for (const p of topics)
          for (const r of p.responses) {
            if (Number(r.tags.stage ?? p.tags.stage) === stage) return r.speaker;
            const deeper = walk(r.choices);
            if (deeper) return deeper;
          }
        return null;
      };
      const who = walk(parsed.topics);
      if (who) return names.get(who.toLowerCase()) ?? plan.characters.find((ch) => ch.name.toLowerCase() === who.toLowerCase())?.name ?? who;
    }
    return null;
  };
  return {
    title: plan.title,
    summary: plan.summary,
    stages: plan.stages.map((s) => ({ index: s.index, journal: s.journal, startsQuest: s.startsQuest, completesQuest: s.completesQuest, failsQuest: s.failsQuest })),
    steps: plan.steps.map((s) => ({ from: s.from, to: s.to, kind: s.kind, target: s.kind === 'talk' ? talker(s.to) : s.targetKey ? (names.get(s.targetKey) ?? s.targetKey) : null, note: s.note })),
    objectives: plan.objectives.map((o) => ({ index: o.index, text: o.text, shownAtStage: o.shownAtStage, completedAtStage: o.completedAtStage })),
  };
}

/** Put a draft into a plan (journal text and objectives, adding new ones). */
export function applyJournalToPlan(plan: QuestPlan, draft: JournalDraft): QuestPlan {
  const next = structuredClone(plan);
  for (const s of draft.stages) {
    const st = next.stages.find((x) => x.index === s.index);
    if (st) st.journal = s.journal;
  }
  for (const o of draft.objectives) {
    const ex = next.objectives.find((x) => x.index === o.index);
    if (ex) Object.assign(ex, { text: o.text, shownAtStage: o.shownAtStage, completedAtStage: o.completedAtStage });
    else next.objectives.push({ index: o.index, text: o.text, shownAtStage: o.shownAtStage, completedAtStage: o.completedAtStage, targetKey: plan.steps.find((s) => s.from === o.shownAtStage)?.targetKey ?? null });
  }
  next.objectives.sort((a, b) => a.index - b.index);
  return next;
}
