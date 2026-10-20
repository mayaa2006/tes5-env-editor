/**
 * The AI workspace's quest and dialogue tools: planning whole quests (the
 * same planner and builder as Quests → From writing), changing an existing
 * quest through a plan, and direct edits (stages, journal, objectives, what
 * moves the quest on, stage scripts, dialogue). Each change is one undo step.
 */
import { z } from 'zod';
import type { FormKey } from '@tes5/esp';
import { QuestPlanSchema, QuestPlanner, WorkspaceError, blockingIssues, lintScreenplay, normalizePlan, planCatalog, planQuestline, repairPlan, settleCharacters, splitQuestline, validatePlan, type AgentTool, type AiProvider, type PlanIssue, type PlanResolution, type QuestPlan } from '@tes5/workspace';
import type { EngineHost } from './host';

/** How much of the load order the planner lists: everything for Claude, less for a free AI (it reads it slowly). */
export function catalogLimits(ai: AiProvider): { limit: number; short: number } {
  return ai.kind === 'claude' ? { limit: 300, short: 300 } : { limit: 120, short: 40 };
}

/** What the quest tools share within one conversation: the AI to plan with, plans made so far, quests touched. */
export interface QuestToolContext {
  ai: AiProvider;
  plans: Map<string, { plan: QuestPlan; source?: string; quest?: FormKey }>;
  touched: Set<FormKey>;
  /** Revisions asked for in this turn: small models can revise in circles, minutes at a time. */
  revisions?: number;
  /** Questlines planned in this conversation: their title and the plans of their quests, in order. */
  questlines?: Map<string, { title: string; planIds: string[] }>;
}

/** Revisions of a plan allowed in one turn of the conversation. */
const MAX_REVISIONS = 2;

const Form = z.string().describe('Editor ID or FormKey of the quest');
const Stage = z.number().int().min(0).max(65535);

/** A plan in brief, with what the editor thinks of it: enough for the AI to describe it and fix it. */
function brief(id: string, plan: QuestPlan, issues: PlanIssue[], resolution: PlanResolution[]) {
  return {
    planId: id,
    title: plan.title,
    editorId: plan.editorId,
    summary: plan.summary,
    starts: plan.startsWithGame ? 'with the game (talking to someone)' : (plan.startsWhen ? `${plan.startsWhen.kind} ${plan.startsWhen.targetKey ?? plan.startsWhen.quest ?? ''}` : 'nothing yet'),
    cast: resolution.map((r) => `${r.kind} ${r.name}: ${r.text}${r.changes?.length ? ` (${r.changes.join(', ')})` : ''}${r.error ? ` — PROBLEM: ${r.error}` : ''}`),
    stages: plan.stages.map((s) => `${s.index}${s.startsQuest ? ' (start)' : ''}${s.completesQuest ? ' (completes)' : ''}${s.failsQuest ? ' (fails)' : ''}: ${s.journal || '(no journal)'}`),
    objectives: plan.objectives.map((o) => `${o.index}: ${o.text} (shown at ${o.shownAtStage}${o.completedAtStage !== null ? `, done at ${o.completedAtStage}` : ''})`),
    whatMovesIt: plan.steps.map((s) => `${s.from ?? 'any time'} → ${s.to}: ${s.kind}${s.targetKey ? ` ${s.targetKey}` : ''} (${s.note})`),
    conversations: plan.conversations.map((c) => `${c.title}: ${c.screenplay.split('\n').length} lines`),
    events: plan.events.map((e) => `at ${e.atStage}: ${e.kind} ${e.targetKey ?? e.what ?? ''}`),
    // What stops the build, what would leave the quest stuck, and the rest (for the author).
    mustFix: issues.filter((i) => i.severity === 'error').map((i) => i.message),
    shouldFix: blockingIssues(issues).filter((i) => i.severity !== 'error').map((i) => i.message),
    advice: issues.filter((i) => i.severity !== 'error' && !blockingIssues([i]).length).map((i) => i.message),
    readyToBuild: !issues.some((i) => i.severity === 'error'),
    questions: plan.questions,
  };
}

export function questTools(host: EngineHost, ctx: QuestToolContext): AgentTool<any>[] {
  const ws = () => {
    if (!host.ws) throw new WorkspaceError('No game data is open');
    return host.ws;
  };
  /** A quest by Editor ID or FormKey; `changing` marks it for the checks after the turn. */
  const quest = (ref: string, changing = true): FormKey => {
    const r = ref.trim();
    const key = (/^[0-9A-Fa-f]{6}:/.test(r) ? r : ws().byEditorId(r)) as FormKey | undefined;
    const v = key ? ws().view(key) : undefined;
    if (!key || v?.sig !== 'QUST') throw new WorkspaceError(`There's no quest "${r}". Search with kind "quest" to find its Editor ID.`);
    if (changing) ctx.touched.add(key);
    return key;
  };
  const planOf = (id: string) => {
    // By id, or by the plan's title or Editor ID (the latest one): small models pass what they've read.
    const want = id.trim().toLowerCase();
    const p = ctx.plans.get(id.trim()) ?? [...ctx.plans.values()].reverse().find((x) => x.plan.title.toLowerCase() === want || x.plan.editorId.toLowerCase() === want);
    if (!p) {
      const have = [...ctx.plans].map(([k, v]) => `${k} (“${v.plan.title}”)`).join(', ');
      throw new WorkspaceError(`There's no plan "${id}" in this conversation. ${have ? `Plans here: ${have}.` : 'Make one with plan_quest or quest_as_plan.'}`);
    }
    return p;
  };
  const keep = (plan: QuestPlan, extra: { source?: string; quest?: FormKey } = {}) => {
    const id = `plan${ctx.plans.size + 1}`;
    ctx.plans.set(id, { plan, ...extra });
    return id;
  };
  const review = (id: string) => {
    const p = planOf(id).plan;
    const r = host.reviewQuestPlan(p);
    return brief(id, p, r.issues, r.resolution);
  };
  const label = (k: FormKey) => ws().summary(k)?.editorId ?? k;
  const link = (k: FormKey) => ({ tab: 'quest' as const, key: k, label: `${label(k)} in Quests` });
  const planner = (signal?: AbortSignal) => new QuestPlanner({ ai: ctx.ai, signal });
  const catalog = (text: string) => planCatalog(ws(), { text, ...catalogLimits(ctx.ai) });
  const stageOf = (q: FormKey, s: number) => host.quest(q).stages.find((x) => x.index === s);

  return [
    {
      name: 'plan_quest',
      group: 'quest',
      writes: false,
      description:
        "Plan a whole new quest (characters, places, items, stages, journal, objectives, what moves it on, dialogue, events, rewards) from a description, the way Quests → From writing does. Nothing is built yet: you get a plan id and a summary with problems to check. Also plans creating or changing characters, places and items without a quest. Describe everything the author asked for in 'text', in your own words if they told you over several messages.",
      input: z.object({ text: z.string().describe('The quest as the author describes it: who, where, what the player does, how it ends'), mode: z.enum(['document', 'conversation']).nullable().optional().describe("'conversation' when the text is a conversation to build a quest around; otherwise 'document'") }),
      summary: () => 'Plan a quest',
      run: async (i, c) => {
        // Several quests, each under its own heading: a questline, planned quest by quest.
        const line = (i.mode ?? 'document') === 'document' ? splitQuestline(i.text) : null;
        if (line) {
          const free = ctx.ai.kind !== 'claude';
          const n = line.parts.length;
          const planned = await planQuestline((q) => new QuestPlanner({ ai: ctx.ai, signal: c?.signal, onStep: (what) => c?.progress?.(`quest ${q + 1} of ${n} (${line.parts[q]!.title}), ${what}…`) }), line, {
            catalog: (text) => planCatalog(ws(), { text, ...(free ? { limit: 60, short: 25 } : catalogLimits(ctx.ai)) }),
            settle: (p, text) => void settleCharacters(ws(), p, text, free),
          });
          const planIds = planned.quests.map((q) => keep(q.plan, { source: q.source }));
          ctx.questlines ??= new Map();
          const lineId = `questline${ctx.questlines.size + 1}`;
          ctx.questlines.set(lineId, { title: planned.title, planIds });
          const r = host.reviewQuestline(planned);
          return {
            data: { questlineId: lineId, title: planned.title, quests: planIds.map((id) => review(id)), linkedAcrossQuests: r.links.map((l) => `${l.name}: made in quest ${l.from + 1}, used in quest ${l.quest + 1}`), questlineProblems: r.questlineIssues.map((x) => x.message), next: 'Tell the author what each quest does and ask whether to build; build all of them with build_questline.' },
            note: `Planned the questline “${planned.title}” (${planIds.length} quests)`,
          };
        }
        const plan = await planner(c?.signal).plan(i.text, i.mode ?? 'document', catalog(i.text));
        settleCharacters(ws(), plan, i.text, ctx.ai.kind !== 'claude');
        const id = keep(plan, { source: i.text });
        return { data: review(id), note: `Planned “${plan.title}”` };
      },
    },
    {
      name: 'build_questline',
      group: 'quest',
      writes: true,
      description: 'Build every quest of a questline planned with plan_quest, in order, as one undo step: characters, places and items shared between the quests are made once, and each quest starts when the one before ends. Check the quests have no errors first (fix one with revise_plan or edit_plan on its plan id).',
      input: z.object({ questlineId: z.string().describe('The questline id plan_quest gave, e.g. "questline1"') }),
      summary: (i) => `Build ${i.questlineId}`,
      run: async (i) => {
        const l = ctx.questlines?.get(i.questlineId.trim()) ?? [...(ctx.questlines?.values() ?? [])].pop();
        if (!l) throw new WorkspaceError('There is no questline in this conversation yet: plan one with plan_quest (a text with a heading for each quest).');
        // The latest revision of each quest's plan.
        const plans = l.planIds.map((id) => {
          const p = planOf(id);
          const latest = [...ctx.plans.entries()].reverse().find(([, v]) => v.source === p.source && v.source);
          return latest?.[1] ?? p;
        });
        for (const [n, p] of plans.entries()) {
          const errors = validatePlan(p.plan).filter((x) => x.severity === 'error');
          if (errors.length) throw new WorkspaceError(`Quest ${n + 1} (${p.plan.title}) needs fixing first (revise_plan or edit_plan): ${errors.map((e) => e.message).join('; ')}`);
        }
        const r = await host.buildQuestline({ title: l.title, quests: plans.map((p) => ({ title: p.plan.title, source: p.source ?? '', plan: p.plan })) });
        r.quests.forEach((q, n) => {
          if (!q.quest) return;
          ctx.touched.add(q.quest);
          const id = [...ctx.plans].find(([, v]) => v === plans[n])?.[0];
          if (id) ctx.plans.set(id, { ...plans[n]!, quest: q.quest });
        });
        const first = r.quests[0]?.quest;
        return {
          data: { built: r.quests.map((q) => ({ quest: q.quest, editorId: q.editorId, created: q.created.length, dialogueLines: q.dialogue.responses, problems: q.problems, warnings: q.warnings.slice(0, 8) })), linked: r.links },
          ...(first ? { link: link(first) } : {}),
          note: `Built the questline ${l.title} (${r.quests.length} quests)`,
        };
      },
    },
    {
      name: 'revise_plan',
      group: 'quest',
      writes: false,
      description: 'Change a plan as described in words ("make Eirik the thief", "add a reward of 200 gold"). Returns the new plan id and summary.',
      input: z.object({ planId: z.string(), change: z.string().describe('What to change, in words') }),
      summary: (i) => `Revise ${i.planId}`,
      run: async (i, c) => {
        const p = planOf(i.planId);
        if ((ctx.revisions ?? 0) >= MAX_REVISIONS)
          throw new WorkspaceError(`That's ${MAX_REVISIONS} revisions in this turn. Don't revise again now: build the latest plan with build_plan if nothing in mustFix is left, or tell the author what's still wrong and let them decide.`);
        ctx.revisions = (ctx.revisions ?? 0) + 1;
        const next = await planner(c?.signal).revise(p.plan, i.change, catalog(`${p.source ?? ''}\n${i.change}`), p.source);
        settleCharacters(ws(), next, `${p.source ?? ''}\n${i.change}`, ctx.ai.kind !== 'claude');
        const id = keep(next, { source: p.source, quest: p.quest });
        const was = blockingIssues(validatePlan(p.plan)).map((x) => x.message).sort().join('|');
        const now = review(id);
        const same = JSON.stringify(next) === JSON.stringify(p.plan) || (was && [...now.mustFix, ...now.shouldFix].sort().join('|') === was);
        // A small model can revise in circles: say so, and what to do instead.
        return { data: same ? { ...now, next: now.readyToBuild ? 'The revision fixed nothing: build it now and tell the author what is left.' : 'The revision fixed nothing: use edit_plan for the exact change (show_plan gives the plan), or tell the author what is wrong.' } : now };
      },
    },
    {
      name: 'show_plan',
      group: 'quest',
      writes: false,
      description: 'A plan in full, as JSON (every field), to read it closely or to edit it with edit_plan.',
      input: z.object({ planId: z.string() }),
      summary: (i) => `Read ${i.planId}`,
      run: (i) => ({ data: planOf(i.planId).plan }),
    },
    {
      name: 'edit_plan',
      group: 'quest',
      writes: false,
      description: "Replace a plan with an edited version (the whole plan, same JSON format as show_plan returns) for exact changes revise_plan can't make. Returns the new plan id and its problems.",
      input: z.object({ planId: z.string(), plan: z.record(z.string(), z.unknown()).describe('The whole edited plan') }),
      summary: (i) => `Edit ${i.planId}`,
      run: (i) => {
        const p = planOf(i.planId);
        // The slips a model makes writing out a whole plan (a list left out, [] for "none") are mended first.
        const raw = normalizePlan(structuredClone(i.plan) as unknown as QuestPlan);
        repairPlan(raw);
        const parsed = QuestPlanSchema.safeParse(raw);
        if (!parsed.success) throw new WorkspaceError(`The plan doesn't match the format: ${parsed.error.issues.slice(0, 6).map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
        const id = keep(parsed.data, { source: p.source, quest: p.quest });
        return { data: review(id) };
      },
    },
    {
      name: 'build_plan',
      group: 'quest',
      writes: true,
      description:
        'Build the quest (and its characters, places, items, dialogue…) from a plan, as one undo step. Check the plan has no errors first. A plan of a quest that already exists (built from an earlier version of the plan, or read with quest_as_plan) updates that quest instead of making a second one.',
      input: z.object({ planId: z.string() }),
      summary: (i) => `Build the quest from ${i.planId}`,
      run: async (i) => {
        const p = planOf(i.planId);
        const errors = validatePlan(p.plan).filter((x) => x.severity === 'error');
        if (errors.length) throw new WorkspaceError(`Fix these first (revise_plan or edit_plan): ${errors.map((e) => e.message).join('; ')}`);
        // Built already (this plan, or the one it revises): change that quest rather than add a copy of it.
        if (p.quest && ws().exists(p.quest)) {
          const u = await host.updateQuestFromPlan(p.quest, p.plan);
          ctx.touched.add(p.quest);
          return { data: { quest: p.quest, updatedExisting: true, updated: u.updated, created: u.created.map((c) => `${c.kind}: ${c.label}`), warnings: u.warnings, notes: u.notes }, link: link(p.quest), note: `Updated ${label(p.quest)}` };
        }
        const r = await host.buildQuestPlan(p.plan);
        if (r.quest) {
          ctx.touched.add(r.quest);
          // Revisions of this plan now update the quest it made.
          const id = [...ctx.plans].find(([, v]) => v === p)?.[0] ?? i.planId;
          ctx.plans.set(id, { ...p, quest: r.quest });
        }
        return {
          data: { quest: r.quest, editorId: r.editorId, created: r.created.map((c) => `${c.kind}: ${c.label}`), changed: r.changed.map((c) => `${c.label}: ${c.changes.join(', ')}`), dialogue: r.dialogue, problems: r.problems, notes: r.notes, warnings: r.warnings },
          ...(r.quest ? { link: link(r.quest) } : {}),
          note: `Built ${p.plan.title}`,
        };
      },
    },
    {
      name: 'quest_as_plan',
      group: 'quest',
      writes: false,
      description: 'An existing quest as a plan, to change it with revise_plan or edit_plan and then update_quest_from_plan. Only what the plan format covers is changed by an update.',
      input: z.object({ quest: Form }),
      summary: (i) => `Read ${i.quest} as a plan`,
      run: async (i) => {
        const key = quest(i.quest, false);
        const r = await host.questPlanFor(key);
        const id = keep(r.plan, { quest: key });
        return { data: { ...review(id), readFromRecords: r.fromRecord } };
      },
    },
    {
      name: 'update_quest_from_plan',
      group: 'quest',
      writes: true,
      description: 'Change an existing quest to match a revised plan: only the differences are applied, as one undo step. Returns what changed.',
      input: z.object({ quest: Form, planId: z.string() }),
      summary: (i) => `Update ${i.quest} from ${i.planId}`,
      run: async (i) => {
        const key = quest(i.quest);
        const p = planOf(i.planId);
        const errors = validatePlan(p.plan).filter((x) => x.severity === 'error');
        if (errors.length) throw new WorkspaceError(`Fix these first: ${errors.map((e) => e.message).join('; ')}`);
        const r = await host.updateQuestFromPlan(key, p.plan);
        return { data: { updated: r.updated, created: r.created.map((c) => `${c.kind}: ${c.label}`), warnings: r.warnings, notes: r.notes }, link: link(key) };
      },
    },
    {
      name: 'create_quest',
      group: 'quest',
      writes: true,
      description: 'Create an empty quest (no stages yet). For a whole quest, plan_quest and build_plan do much more.',
      input: z.object({ editorId: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'letters, digits and _ only, starting with a letter'), name: z.string().describe('Name shown in the journal'), startsWithGame: z.boolean().nullable().optional().describe('Running from the start (needed when it begins by talking to someone)') }),
      summary: (i) => `Create the quest ${i.name}`,
      run: (i) => {
        const r = host.createQuest(ws().uniqueEditorId(i.editorId), i.name, { startGameEnabled: i.startsWithGame ?? true }) as unknown as FormKey | { formKey: FormKey };
        const key = (typeof r === 'string' ? r : r.formKey) as FormKey;
        ctx.touched.add(key);
        return { data: { quest: key, editorId: label(key) }, link: link(key) };
      },
    },
    {
      name: 'set_stage',
      group: 'quest',
      writes: true,
      description: "Add a stage to a quest, or change its journal entry. Journal entries are first person, past tense (\"Brynja asked me to find her ring.\"). completesQuest / failsQuest apply to a new stage.",
      input: z.object({ quest: Form, stage: Stage, journal: z.string().nullable().optional().describe('Journal text; null leaves it'), completesQuest: z.boolean().nullable().optional(), failsQuest: z.boolean().nullable().optional(), startsQuest: z.boolean().nullable().optional().describe('Runs when the quest starts') }),
      summary: (i) => `Set stage ${i.stage} of ${i.quest}`,
      run: (i) => {
        const key = quest(i.quest);
        if (!stageOf(key, i.stage)) host.addStage(key, i.stage, i.journal ?? undefined, { startUp: !!i.startsQuest, completesQuest: !!i.completesQuest, failsQuest: !!i.failsQuest });
        else if (i.journal !== null && i.journal !== undefined) host.setStageLog(key, i.stage, 0, i.journal);
        return { data: { stages: host.quest(key).stages.map((s) => ({ stage: s.index, journal: s.logEntries[0]?.text || undefined })) }, link: link(key) };
      },
    },
    {
      name: 'remove_stage',
      group: 'quest',
      writes: true,
      description: 'Remove a stage (and its stage script) from a quest.',
      input: z.object({ quest: Form, stage: Stage }),
      summary: (i) => `Remove stage ${i.stage} of ${i.quest}`,
      run: (i) => {
        const key = quest(i.quest);
        if (!stageOf(key, i.stage)) throw new WorkspaceError(`${i.quest} has no stage ${i.stage}`);
        host.removeStage(key, i.stage);
        return { data: { stages: host.quest(key).stages.map((s) => s.index) }, link: link(key) };
      },
    },
    {
      name: 'set_objective',
      group: 'quest',
      writes: true,
      description: 'Add an objective (a short instruction like "Find Brynja\'s ring") and set the stages where it is shown and completed.',
      input: z.object({ quest: Form, index: z.number().int().min(0).describe('Objective number (usually the stage that shows it)'), text: z.string(), shownAtStage: Stage.nullable().optional(), completedAtStage: Stage.nullable().optional() }),
      summary: (i) => `Set objective ${i.index} of ${i.quest}`,
      run: async (i) => {
        const key = quest(i.quest);
        const q = host.quest(key);
        if (!q.objectives.some((o) => o.index === i.index)) host.addObjective(key, i.index, i.text);
        else
          ws().editRecord(key, (d: any) => {
            const o = d.objectives.find((x: any) => x.index === i.index);
            o.text = i.text;
          }, `Edit objective ${i.index}`);
        const graph = await host.questGraph(key);
        for (const [stage, field] of [
          [i.shownAtStage, 'shows'],
          [i.completedAtStage, 'completes'],
        ] as const) {
          if (stage === null || stage === undefined) continue;
          const node = graph.nodes.find((n) => n.stage === stage);
          if (!node) throw new WorkspaceError(`${i.quest} has no stage ${stage}; add it with set_stage first`);
          const shows = field === 'shows' ? [...new Set([...node.shows, i.index])] : node.shows;
          const completes = field === 'completes' ? [...new Set([...node.completes, i.index])] : node.completes;
          await host.setStageObjectives(key, stage, shows, completes);
        }
        return { data: { objectives: host.quest(key).objectives.map((o) => `${o.index}: ${o.text}`) }, link: link(key) };
      },
    },
    {
      name: 'connect_stages',
      group: 'quest',
      writes: true,
      description:
        "Make something move the quest from one stage to another, as on the quest map: 'talk' (the player says playerSays to a character, who answers), 'script' (right away after the from stage), or an event on a character, object or place: activate, pickup, drop, death, hit, arrive (a cell), equip, read. Missing stages are added.",
      input: z.object({
        quest: Form,
        from: Stage.nullable().describe('Stage the quest must be at; null for any time'),
        to: Stage,
        kind: z.enum(['talk', 'script', 'activate', 'pickup', 'drop', 'death', 'hit', 'arrive', 'equip', 'read']),
        target: z.string().nullable().optional().describe('talk: the character; events: the placed object or character (reference FormKey from place_contents, or an Editor ID), or for arrive the cell'),
        playerSays: z.string().nullable().optional().describe('talk: what the player says'),
        answer: z.string().nullable().optional().describe('talk: what the character answers'),
      }),
      summary: (i) => `Move ${i.quest} from ${i.from ?? 'any stage'} to ${i.to} by ${i.kind}`,
      run: async (i) => {
        const key = quest(i.quest);
        const target = i.target ? ((/^[0-9A-Fa-f]{6}:/.test(i.target) ? i.target : ws().byEditorId(i.target)) as FormKey | undefined) : undefined;
        if (i.kind !== 'script' && !target) throw new WorkspaceError(`“${i.kind}” needs a target: search for it and use its Editor ID or FormKey`);
        const edge =
          i.kind === 'script'
            ? { from: i.from, to: i.to, kind: 'script' as const }
            : i.kind === 'talk'
              ? { from: i.from, to: i.to, kind: 'talk' as const, npc: target!, playerText: i.playerSays ?? '', npcText: i.answer ?? '', goodbye: true }
              : { from: i.from, to: i.to, kind: i.kind, target: target! };
        if (i.kind === 'talk' && (!i.playerSays?.trim() || !i.answer?.trim())) throw new WorkspaceError('“talk” needs playerSays and answer');
        const g = await host.addQuestEdge(key, edge as never);
        return { data: { connections: g.edges.map((e) => `${e.from ?? 'any'} → ${e.to}: ${e.label}`), problems: g.problems }, link: link(key) };
      },
    },
    {
      name: 'set_stage_script',
      group: 'quest',
      writes: true,
      description: "Replace the Papyrus code that runs when a quest reaches a stage (the stage fragment). Write only the lines inside the function (e.g. 'SetObjectiveDisplayed(10)'). Read the current code with read_stage_script first and keep what should stay.",
      input: z.object({ quest: Form, stage: Stage, code: z.string() }),
      summary: (i) => `Write the script of stage ${i.stage} in ${i.quest}`,
      run: async (i) => {
        const key = quest(i.quest);
        if (!stageOf(key, i.stage)) throw new WorkspaceError(`${i.quest} has no stage ${i.stage}; add it with set_stage first`);
        const r = await host.setStageFragment(key, i.stage, i.code);
        return { data: { script: r.script }, link: { tab: 'script', key: r.script, label: `${r.script} in Scripts` } };
      },
    },
    {
      name: 'read_stage_script',
      group: 'read',
      writes: false,
      description: 'The Papyrus code that runs when a quest reaches a stage.',
      input: z.object({ quest: Form, stage: Stage }),
      summary: (i) => `Read the script of stage ${i.stage} in ${i.quest}`,
      run: async (i) => ({ data: (await host.stageFragment(quest(i.quest, false), i.stage)) || '(no code)' }),
    },
    {
      name: 'add_dialogue',
      group: 'quest',
      writes: true,
      description:
        "Add dialogue to a quest in screenplay format (the same format plans use): top-level 'PLAYER:' lines are things the player can say, NPC lines under them are answers (speaker = character Editor ID or name, in capitals or not), indent choices by two spaces under the answer they follow. Tags at the end of a line: [stage N] (sets the stage after the line), [if stage N], [goodbye], [emotion happy], [gives ITEM xN], [takes ITEM xN], [once], [persuade N]. GREETING:, IDLE: and SCENE: name [at stage N] blocks for lines nobody prompts. The text is checked first and nothing is added if it has errors.",
      input: z.object({ quest: Form, screenplay: z.string() }),
      summary: (i) => `Add dialogue to ${i.quest}`,
      run: async (i) => {
        const key = quest(i.quest);
        const errors = lintScreenplay(i.screenplay, { stages: host.quest(key).stages.map((s) => s.index) }).filter((l) => l.severity === 'error');
        if (errors.length) throw new WorkspaceError(`Nothing was added; fix these: ${errors.map((e) => `${e.line ? `line ${e.line}: ` : ''}${e.message}`).join('; ')}`);
        const r = await host.importScreenplay(key, i.screenplay);
        return { data: { added: r, problems: await host.lintDialogue(key) }, link: { tab: 'quest', key, label: `${label(key)}'s dialogue` } };
      },
    },
    {
      name: 'set_starts_with_game',
      group: 'quest',
      writes: true,
      description: "Whether a quest runs from the start of the game (needed when it begins by talking to someone, so its opening dialogue is there).",
      input: z.object({ quest: Form, on: z.boolean() }),
      summary: (i) => `${i.on ? 'Start' : "Don't start"} ${i.quest} with the game`,
      run: (i) => {
        const key = quest(i.quest);
        host.setQuestStartGameEnabled(key, i.on);
        return { data: 'Done.', link: link(key) };
      },
    },
    {
      name: 'write_journal',
      group: 'quest',
      writes: true,
      description: "Fill in a quest's missing journal entries and objective texts, worded like Skyrim's (or rewrite all of them).",
      input: z.object({ quest: Form, rewriteAll: z.boolean().nullable().optional() }),
      summary: (i) => `Write the journal of ${i.quest}`,
      run: async (i) => {
        const key = quest(i.quest);
        const draft = await host.journalDraftWithClaude(key, ctx.ai, !!i.rewriteAll);
        await host.applyJournal(key, draft);
        return { data: draft, link: link(key) };
      },
    },
    {
      name: 'check_quest',
      group: 'checks',
      writes: false,
      description: "The editor's checks of a quest: things that stop it working (stages nothing reaches, no ending, dialogue that can't start) and dialogue problems (lines nobody answers, lines that can repeat, missing speakers).",
      input: z.object({ quest: Form }),
      summary: (i) => `Check ${i.quest}`,
      run: async (i) => {
        const key = quest(i.quest, false);
        const g = await host.questGraph(key);
        return { data: { problems: g.problems, dialogue: await host.lintDialogue(key) }, link: link(key) };
      },
    },
  ];
}

/** Problems in the quests a turn touched, for the AI to fix: the quest map's problems and dialogue errors. */
export async function questProblems(host: EngineHost, touched: Iterable<FormKey>): Promise<string[]> {
  const out: string[] = [];
  for (const key of touched) {
    if (host.ws?.view(key)?.sig !== 'QUST') continue;
    const name = host.ws.summary(key)?.editorId ?? key;
    const g = await host.questGraph(key).catch(() => null);
    for (const p of g?.problems ?? []) out.push(`${name}: ${p}`);
    for (const l of await host.lintDialogue(key)) if (l.severity === 'error') out.push(`${name} dialogue: ${l.message}`);
  }
  return out;
}
