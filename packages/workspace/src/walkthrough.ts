/**
 * Playing a plan through before it's built: every way the player can go, as the built quest would run it.
 *
 * The quest starts at its first stage. From each situation the player can do whatever the plan offers there: a step
 * whose stage matches (pick something up, go somewhere, kill someone, wait…), or a line of dialogue whose conditions
 * hold, said to someone who is still there. Saying a line does what its tags say ([stage], [gives], [takes],
 * [remember], [leaves]…), and its choices are offered next. Setting a stage runs what happens at it (events, rewards,
 * scenes, steps that go on right away) and may end the quest. What the plan can't know about the player (their Speech,
 * level, race, the time of day, other quests) could go either way, so both are tried.
 *
 * The rules are the builder's: a step runs at exactly its "from" stage (GetStage == from), [if stage N] is the stage
 * now, [if done N] a stage reached at any time, and a stage already done isn't set again. Every situation reachable is
 * visited once; the report says which endings can be reached and how, where the player can get stuck, and which
 * stages and lines can never be reached.
 */
import { parseScreenplay, type ScriptNpcBlock, type ScriptPlayerLine } from './dialogue';
import { parseIf, type IfClause } from './dialogueif';
import type { QuestPlan } from './questplan';

export interface WalkPath {
  /** What the player does, in order, from the start. */
  steps: string[];
}

export interface Walkthrough {
  /** Each ending that can be reached, by its stage, with the shortest way there. */
  endings: { stage: number; fails: boolean; journal: string; path: WalkPath }[];
  /** Where the player can get stuck: the quest still running and nothing left that moves it on. */
  stuck: { stage: number; path: WalkPath }[];
  /** Stages no way through reaches. */
  unreached: number[];
  /** Lines that set a stage and can never be said ("Hesta: Here, as agreed."). */
  unsaid: string[];
  /** Lines that set a stage lower than the one the quest is at, when said. */
  backwards: { line: string; from: number; to: number }[];
  /** How many situations were tried, and whether that stopped at the limit (very large plans). */
  states: number;
  partial: boolean;
}

/** A line of dialogue that can be said: who says it, when, and what saying it does. */
interface Line {
  id: string;
  label: string;
  speaker: string;
  /** Conditions on the player line and its answer. */
  needs: IfClause[];
  stage: number | null;
  gives: { item: string; count: number }[];
  takes: { item: string; count: number }[];
  gold: number;
  remember: string[];
  forget: string[];
  leaves: boolean;
  once: boolean;
  /** Choices offered once it's said. */
  then: Topic[];
}

/** A player line and its answers (the first that applies is said; after a persuasion, success or failure). */
interface Topic {
  id: string;
  text: string;
  needs: IfClause[];
  answers: Line[];
  persuade: boolean;
}

interface State {
  stage: number;
  done: number[];
  chose: string[];
  dead: string[];
  gone: string[];
  hidden: string[];
  items: Record<string, number>;
  gold: number;
  said: string[];
  /** Choices on offer right now (after a line with choices under it). */
  offer: string[];
  ended: boolean;
}

const LIMIT = 20000;

export function walkPlan(plan: QuestPlan, opts: { limit?: number; ms?: number } = {}): Walkthrough {
  const limit = opts.limit ?? LIMIT;
  // (The review waits for it: past this, what's found so far is reported as partial.)
  const deadline = Date.now() + (opts.ms ?? 2000);
  const stageOf = new Map(plan.stages.map((s) => [s.index, s]));
  const people = plan.characters.map((c) => ({ key: c.key, names: [c.key, c.name, c.name.split(/\s+/)[0]!].map((n) => n.toLowerCase()) }));
  const personOf = (name: string) => people.find((p) => p.names.includes(name.trim().toLowerCase()))?.key ?? name.trim().toLowerCase();
  const itemNames = plan.items.map((i) => ({ key: i.key, names: [i.key, i.name].map((n) => n.toLowerCase()) }));
  const itemOf = (name: string) => {
    const n = name.trim().toLowerCase();
    return itemNames.find((i) => i.names.includes(n))?.key ?? n;
  };
  const parseCount = (v: string) => {
    const m = /^(.*?)(?:\s*[x×]\s*(\d+))?$/.exec(v.trim())!;
    return { item: itemOf(m[1]!), count: m[2] ? Number(m[2]) : 1 };
  };
  const ifs = (v: string | undefined): IfClause[] => {
    try {
      return parseIf(v);
    } catch {
      return [];
    }
  };

  // The dialogue, as lines that can be said.
  let n = 0;
  const topics: Topic[] = [];
  const greetings: Line[] = [];
  const scenes: { at: number; lines: Line[] }[] = [];
  const allLines: Line[] = [];
  const lineOf = (r: ScriptNpcBlock, needs: IfClause[], stageTag: string | undefined, label: string): Line => {
    const tags = r.tags;
    const list = (k: string) => (tags[k] ?? '').split(';').map((x) => x.trim()).filter(Boolean);
    const gives = list('gives').map(parseCount);
    const takes = list('takes').map(parseCount);
    const goldIn = gives.filter((g) => g.item === 'gold').reduce((a, g) => a + g.count, 0);
    const goldOut = takes.filter((g) => g.item === 'gold').reduce((a, g) => a + g.count, 0);
    const stageText = tags.stage ?? stageTag;
    const line: Line = {
      id: `l${n++}`,
      label,
      speaker: personOf(r.speaker),
      needs,
      stage: stageText !== undefined && /^\d+$/.test(stageText.trim()) ? Number(stageText) : null,
      gives: gives.filter((g) => g.item !== 'gold'),
      takes: takes.filter((g) => g.item !== 'gold'),
      gold: goldIn - goldOut,
      remember: list('remember').map((x) => x.toLowerCase()),
      forget: list('forget').map((x) => x.toLowerCase()),
      leaves: 'leaves' in tags,
      once: 'once' in tags,
      then: [],
    };
    allLines.push(line);
    return line;
  };
  const stageOnly = (c: IfClause[]) => c.filter((x) => x.kind === 'stage');
  const topicOf = (p: ScriptPlayerLine, inherited: IfClause[], speaker: string): Topic => {
    const own = [...inherited, ...ifs(p.tags.if)];
    const t: Topic = { id: `t${n++}`, text: p.text, needs: own, answers: [], persuade: p.tags.persuade !== undefined };
    for (const r of p.responses) {
      const needs = [...own, ...ifs(r.tags.if)];
      const who = r.speaker && !/^(npc|any|anyone|\?)$/i.test(r.speaker) ? r.speaker : speaker;
      const line = lineOf({ ...r, speaker: who }, needs, p.tags.stage, `${displayName(plan, personOf(who))}: “${r.lines.join(' ')}”`);
      line.then = r.choices.map((c) => topicOf(c, stageOnly(needs), who));
      t.answers.push(line);
    }
    return t;
  };
  for (const c of plan.conversations) {
    const parsed = parseScreenplay(c.screenplay);
    const fallback = c.title.replace(/^✎\s*/, '');
    for (const p of parsed.topics) topics.push(topicOf(p, [], p.responses[0]?.speaker ?? fallback));
    for (const b of parsed.blocks) {
      const outer = ifs(b.tags.if);
      const lines = b.lines.map((r) => {
        const l = lineOf(r, [...outer, ...ifs(r.tags.if)], undefined, `${displayName(plan, personOf(r.speaker))}: “${r.lines.join(' ')}”`);
        l.then = r.choices.map((ch) => topicOf(ch, stageOnly(l.needs), r.speaker));
        return l;
      });
      if (b.kind === 'scene') {
        const at = b.tags.at !== undefined ? Number(b.tags.at.replace(/^stage\s+/i, '')) : NaN;
        if (Number.isFinite(at)) scenes.push({ at, lines });
      } else greetings.push(...lines);
    }
  }
  const topicById = new Map<string, Topic>();
  const index = (ts: Topic[]) => {
    for (const t of ts) {
      if (topicById.has(t.id)) continue;
      topicById.set(t.id, t);
      for (const a of t.answers) index(a.then);
    }
  };
  index(topics);
  for (const g of greetings) index(g.then);

  // Conditions: true, false, or either (what the plan can't know about the player).
  type Truth = 'yes' | 'no' | 'maybe';
  const holds = (s: State, c: IfClause): Truth => {
    switch (c.kind) {
      case 'stage':
        return compare(s.stage, c.op, c.value) ? 'yes' : 'no';
      case 'done':
        return s.done.includes(c.stage) !== c.not ? 'yes' : 'no';
      case 'has': {
        const have = s.items[itemOf(c.item)] ?? 0;
        return (have >= c.count) !== c.not ? 'yes' : 'no';
      }
      case 'choice':
        return s.chose.includes(c.name.toLowerCase()) !== c.not ? 'yes' : 'no';
      case 'dead':
        return s.dead.includes(personOf(c.who)) !== c.not ? 'yes' : 'no';
      case 'left':
        return s.gone.includes(personOf(c.who)) !== c.not ? 'yes' : 'no';
      default:
        // Gold the player brings, Speech, level, sex, race, time of day, other quests.
        return 'maybe';
    }
  };
  const all = (s: State, cs: IfClause[]): Truth => {
    let out: Truth = 'yes';
    for (const c of cs) {
      const t = holds(s, c);
      if (t === 'no') return 'no';
      if (t === 'maybe') out = 'maybe';
    }
    return out;
  };
  const present = (s: State, who: string) => !s.dead.includes(who) && !s.gone.includes(who) && !s.hidden.includes(who);

  // What setting a stage does.
  const setStage = (s: State, stage: number, say: string[]): void => {
    if (s.ended || s.done.includes(stage)) return;
    s.stage = stage;
    s.done = [...s.done, stage].sort((a, b) => a - b);
    for (const e of plan.events ?? []) {
      if (e.atStage !== stage || !e.targetKey) continue;
      const who = e.targetKey;
      if (e.kind === 'kill') s.dead = add(s.dead, who);
      else if (e.kind === 'hide') s.hidden = add(s.hidden, who);
      else if (e.kind === 'show') s.hidden = s.hidden.filter((x) => x !== who);
    }
    for (const r of plan.rewards ?? []) {
      if (r.atStage !== stage) continue;
      if (r.gold) s.gold += r.gold;
      if (r.itemKey) s.items = { ...s.items, [r.itemKey]: (s.items[r.itemKey] ?? 0) + 1 };
    }
    const st = stageOf.get(stage);
    if (st?.completesQuest || st?.failsQuest) {
      s.ended = true;
      return;
    }
    for (const sc of scenes) if (sc.at === stage) for (const l of sc.lines) if (all(s, l.needs) !== 'no') applyLine(s, l, say);
    // Steps that go on right away.
    for (const p of plan.steps) if (p.kind === 'script' && p.from === stage && !s.ended) setStage(s, p.to, say);
  };
  const applyLine = (s: State, l: Line, say: string[]): void => {
    for (const g of l.gives) s.items = { ...s.items, [g.item]: (s.items[g.item] ?? 0) + g.count };
    for (const g of l.takes) s.items = { ...s.items, [g.item]: Math.max(0, (s.items[g.item] ?? 0) - g.count) };
    s.gold += l.gold;
    for (const r of l.remember) s.chose = add(s.chose, r);
    for (const r of l.forget) s.chose = s.chose.filter((x) => x !== r);
    if (l.leaves) {
      s.gone = add(s.gone, l.speaker);
      s.chose = add(s.chose, `${l.speaker.replace(/[^a-z0-9]/g, '')}left`);
    }
    if (l.once) s.said = add(s.said, l.id);
    s.offer = l.then.map((t) => t.id);
    if (l.stage !== null) {
      if (l.stage < s.stage && !s.done.includes(l.stage)) backwards.set(`${l.label}|${s.stage}`, { line: l.label, from: s.stage, to: l.stage });
      setStage(s, l.stage, say);
    }
    said.add(l.id);
  };

  // What the player can do in a situation: each a label and the situations it leads to.
  const moves = (s: State): { label: string; next: State }[] => {
    const out: { label: string; next: State }[] = [];
    const go = (label: string, fn: (t: State) => void) => {
      const t = clone(s);
      t.offer = [];
      fn(t);
      out.push({ label, next: t });
    };
    const name = (k: string | null) => displayName(plan, k ?? '');
    for (const p of plan.steps) {
      if (p.from !== null && p.from !== s.stage) continue;
      const to = p.to;
      const target = p.targetKey;
      switch (p.kind) {
        case 'pickup':
        case 'read':
        case 'equip':
        case 'activate':
          if (target && s.hidden.includes(target)) break;
          go(`${p.kind === 'pickup' ? 'Pick up' : p.kind === 'read' ? 'Read' : p.kind === 'equip' ? 'Equip' : 'Use'} ${name(target)}${(p.count ?? 1) > 1 ? ` ×${p.count}` : ''}`, (t) => {
            if (p.kind === 'pickup' && target) t.items = { ...t.items, [target]: Math.max(t.items[target] ?? 0, p.count ?? 1) };
            setStage(t, to, []);
          });
          break;
        case 'drop':
          go(`Drop ${name(target)}`, (t) => setStage(t, to, []));
          break;
        case 'arrive':
          go(`Go to ${name(target)}`, (t) => setStage(t, to, []));
          break;
        case 'clear':
          go(`Kill every one of ${name(target)}`, (t) => setStage(t, to, []));
          break;
        case 'wait':
          go(`Wait ${p.hours ?? 24} hours`, (t) => setStage(t, to, []));
          break;
        case 'death':
          if (target && !s.dead.includes(target) && !s.gone.includes(target))
            go(`Kill ${name(target)}`, (t) => {
              t.dead = add(t.dead, target);
              setStage(t, to, []);
            });
          break;
        default:
          break;
      }
    }
    // Someone a failure watches can die while the quest runs.
    for (const f of plan.failures ?? []) {
      if (f.kind === 'death' && f.targetKey && !s.dead.includes(f.targetKey) && !plan.steps.some((p) => p.kind === 'death' && p.targetKey === f.targetKey && (p.from === null || p.from === s.stage)))
        go(`${name(f.targetKey)} is killed`, (t) => {
          t.dead = add(t.dead, f.targetKey!);
          setStage(t, f.failStage, []);
        });
      if (f.kind === 'timeLimit' && (f.fromStage === null || s.done.includes(f.fromStage))) go(`Take longer than ${f.days ?? '?'} days`, (t) => setStage(t, f.failStage, []));
    }
    // Dialogue: the choices on offer, the top-level lines, and greetings.
    const offered = s.offer.length ? s.offer.map((id) => topicById.get(id)!).filter(Boolean) : [];
    for (const t of [...offered, ...topics]) {
      if (all(s, t.needs) === 'no') continue;
      // The first answer whose conditions hold is said; one that may or may not hold could go either way.
      for (const [i, a] of t.answers.entries()) {
        if (a.once && s.said.includes(a.id)) continue;
        if (!present(s, a.speaker)) break;
        const ok = t.persuade ? 'maybe' : all(s, a.needs);
        if (ok === 'no') continue;
        go(`Talk to ${displayName(plan, a.speaker)}: “${t.text}”${t.persuade ? (i === 0 ? ' (persuaded)' : ' (not persuaded)') : ''}`, (x) => applyLine(x, a, []));
        if (ok === 'yes') break;
      }
    }
    for (const g of greetings) {
      if (!present(s, g.speaker) || (g.once && s.said.includes(g.id)) || all(s, g.needs) === 'no') continue;
      go(`Talk to ${displayName(plan, g.speaker)} (they speak first)`, (x) => applyLine(x, g, []));
    }
    return out;
  };

  // Every situation reachable, once.
  const said = new Set<string>();
  const backwards = new Map<string, { line: string; from: number; to: number }>();
  const first = [...plan.stages].sort((a, b) => a.index - b.index).find((s) => s.startsQuest) ?? [...plan.stages].sort((a, b) => a.index - b.index)[0];
  const start: State = { stage: -1, done: [], chose: [], dead: [], gone: [], hidden: [...new Set((plan.events ?? []).filter((e) => e.kind === 'show' && e.targetKey).map((e) => e.targetKey!))].sort(), items: {}, gold: 0, said: [], offer: [], ended: false };
  if (first) setStage(start, first.index, []);
  const key = (s: State) => JSON.stringify([s.stage, s.done, s.chose, s.dead, s.gone, s.hidden, Object.entries(s.items).filter(([, v]) => v > 0).sort(), Math.sign(s.gold), s.said, s.offer, s.ended]);
  const from = new Map<string, { prev: string | null; label: string | null; state: State }>();
  const queue: string[] = [];
  const k0 = key(start);
  from.set(k0, { prev: null, label: null, state: start });
  queue.push(k0);
  const pathTo = (k: string): WalkPath => {
    const steps: string[] = [];
    for (let at: string | null = k; at; at = from.get(at)!.prev) {
      const l = from.get(at)!.label;
      if (l) steps.unshift(l);
    }
    return { steps };
  };
  const endings = new Map<number, WalkPath>();
  const stuck = new Map<number, WalkPath>();
  const reached = new Set<number>();
  let partial = false;
  while (queue.length) {
    if (from.size >= limit || Date.now() > deadline) {
      partial = true;
      break;
    }
    const k = queue.shift()!;
    const s = from.get(k)!.state;
    for (const d of s.done) reached.add(d);
    if (s.ended) {
      if (!endings.has(s.stage)) endings.set(s.stage, pathTo(k));
      continue;
    }
    const next = moves(s);
    let progressed = false;
    for (const m of next) {
      const nk = key(m.next);
      if (nk === k) continue;
      progressed ||= m.next.stage !== s.stage || m.next.ended;
      if (from.has(nk)) continue;
      from.set(nk, { prev: k, label: m.label, state: m.next });
      queue.push(nk);
    }
    // Stuck: nothing the player can do here ever sets another stage (only talk that changes nothing, or nothing).
    if (!progressed && !canProgress(s, moves, key)) if (!stuck.has(s.stage)) stuck.set(s.stage, pathTo(k));
  }

  return {
    endings: [...endings.entries()].sort((a, b) => a[0] - b[0]).map(([stage, path]) => ({ stage, fails: !!stageOf.get(stage)?.failsQuest, journal: stageOf.get(stage)?.journal ?? '', path })),
    stuck: partial ? [] : [...stuck.entries()].sort((a, b) => a[0] - b[0]).map(([stage, path]) => ({ stage, path })),
    unreached: partial ? [] : plan.stages.map((s) => s.index).filter((i) => !reached.has(i)),
    unsaid: partial ? [] : [...new Set(allLines.filter((l) => l.stage !== null && !said.has(l.id)).map((l) => l.label))],
    backwards: [...backwards.values()],
    states: from.size,
    partial,
  };
}

/** Whether anything reachable from here, through talk that doesn't set a stage, ever sets one. */
function canProgress(s: State, moves: (s: State) => { label: string; next: State }[], key: (s: State) => string): boolean {
  const seen = new Set<string>([key(s)]);
  const queue = [s];
  while (queue.length && seen.size < 500) {
    const x = queue.shift()!;
    for (const m of moves(x)) {
      if (m.next.stage !== s.stage || m.next.ended) return true;
      const k = key(m.next);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push(m.next);
    }
  }
  return false;
}

function compare(a: number, op: string, b: number): boolean {
  switch (op) {
    case '>=':
      return a >= b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '<':
      return a < b;
    case '!=':
      return a !== b;
    default:
      return a === b;
  }
}

function add(list: string[], x: string): string[] {
  return list.includes(x) ? list : [...list, x].sort();
}

function clone(s: State): State {
  return { ...s, done: [...s.done], chose: [...s.chose], dead: [...s.dead], gone: [...s.gone], hidden: [...s.hidden], items: { ...s.items }, said: [...s.said], offer: [...s.offer] };
}

function displayName(plan: QuestPlan, key: string): string {
  return plan.characters.find((c) => c.key === key)?.name ?? plan.items.find((i) => i.key === key)?.name ?? plan.locations.find((l) => l.key === key)?.name ?? plan.encounters?.find((e) => e.key === key)?.what ?? key;
}

/** The walkthrough's findings as plan problems: getting stuck and endings that can't be reached are worth a look. */
export function walkIssues(w: Walkthrough): { severity: 'warning'; message: string; detail?: string }[] {
  if (w.partial) return [];
  const out: { severity: 'warning'; message: string; detail?: string }[] = [];
  const how = (p: WalkPath) => (p.steps.length ? p.steps.join(' → ') : 'right at the start');
  for (const s of w.stuck) out.push({ severity: 'warning', message: `Played through, the quest can get stuck at stage ${s.stage}: nothing the player can do moves it on`, detail: `How: ${how(s.path)}` });
  if (!w.endings.some((e) => !e.fails)) out.push({ severity: 'warning', message: 'Played through, no way reaches an ending that completes the quest' });
  for (const b of w.backwards) out.push({ severity: 'warning', message: `${b.line} moves the quest back from stage ${b.from} to ${b.to}` });
  return out;
}
