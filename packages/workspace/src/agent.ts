/**
 * The AI workspace's assistant: a conversation in which the AI reads and
 * changes the author's plugin through tools (the same engine calls the UI
 * makes), one tool call at a time, and says what it did in plain words.
 *
 * - The loop here is provider-neutral. Claude uses Anthropic's tool use;
 *   Ollama and OpenAI-style services use their function calling; a model
 *   that can't call tools gets the tools in its instructions and answers in
 *   a small JSON format instead.
 * - Every change a tool makes is its own undo step labelled "AI: …"; at the
 *   end of a turn they're folded into one step, so Ctrl+Z (or Undo on the
 *   turn) takes the whole turn back.
 * - Changes can wait for the author's go-ahead (approve), and a turn is
 *   limited in how many tools it may call.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { BetaContentBlockParam, BetaMessageParam, BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { z } from 'zod';
import { WorkspaceError } from './engine';
import { OLLAMA_URL, aiName, cleanJson, contextWindow, estimateTokens, ollamaContextLength, readChat, streamFields, type AiProvider, type ChatProvider, type ChatResponse } from './aiproviders';
import { PLANNER_MODEL, fillMissing } from './planner';

export const AGENT_MODEL = PLANNER_MODEL;

/** What a tool can touch. Tools that change nothing run without asking. */
export type AgentToolGroup = 'read' | 'quest' | 'characters' | 'items' | 'scripts' | 'world' | 'checks';

/** Where a result can be opened in the editor. */
export interface AgentLink {
  /** 'people' is Characters → Factions, classes & more. */
  tab: 'scene' | 'npc' | 'items' | 'magic' | 'people' | 'quest' | 'script' | 'records' | 'release';
  key?: string;
  label: string;
}

export interface AgentTool<I = any> {
  name: string;
  description: string;
  group: AgentToolGroup;
  /** True when it changes the plugin (or files next to it). */
  writes: boolean;
  /** True when the same call again does more (places another copy, moves further), so a repeat isn't refused. */
  adds?: boolean;
  input: z.ZodType<I>;
  /** What the call does, in a few plain words ("Add stage 20 to MyQuest"). */
  summary(input: I): string;
  run(input: I): Promise<AgentToolOutput> | AgentToolOutput;
}

/** What a tool hands back: data for the AI, and optionally a short line and a link for the author. */
export interface AgentToolOutput {
  data: unknown;
  note?: string;
  link?: AgentLink;
}

export interface AgentToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface AgentToolResult {
  id: string;
  name: string;
  /** What the AI reads (JSON or a message), shortened to fit. */
  content: string;
  isError?: boolean;
  /** For the author: what was done, whether it changed anything, and where to look. */
  summary: string;
  writes: boolean;
  status: 'done' | 'error' | 'declined' | 'stopped';
  note?: string;
  link?: AgentLink;
}

export type AgentMessage =
  | { role: 'user'; text: string; context?: string }
  | { role: 'assistant'; text: string; calls: AgentToolCall[]; provider?: string; raw?: unknown }
  | { role: 'tool'; results: AgentToolResult[] };

/** One turn: what the author asked and what came of it (for the changes list and undo). */
export interface AgentTurn {
  /** Index of the user message that started it. */
  at: number;
  title: string;
  /** Undo label of the turn's changes once folded into one step; null when nothing changed. */
  undoLabel: string | null;
  changes: string[];
  undone?: boolean;
  error?: string;
  /** Tokens the turn used, and which AI answered (for the cost meter). */
  usage?: AgentUsage;
  provider?: string;
}

export interface AgentSession {
  id: string;
  title: string;
  created: number;
  updated: number;
  messages: AgentMessage[];
  turns: AgentTurn[];
  /** A bigger job worked through task by task (a questline, a whole area). */
  project?: AgentProject;
  /** Quest plans the AI made in this conversation, by id ("plan1"), kept so they can be revised and built later. */
  plans?: Record<string, { plan: unknown; source?: string; quest?: string }>;
}

export type AgentTaskStatus = 'todo' | 'doing' | 'done' | 'skipped';

export interface AgentProject {
  /** What the whole job is, in a few sentences: the author's goals and decisions so far. */
  brief: string;
  tasks: { id: number; title: string; status: AgentTaskStatus; note?: string }[];
}

/** Streamed to the UI while a turn runs. */
export type AgentEvent =
  | { type: 'text'; session: string; delta: string }
  | { type: 'call'; session: string; id: string; name: string; summary: string; writes: boolean; status: 'running' | 'waiting' }
  | { type: 'result'; session: string; result: AgentToolResult }
  | { type: 'done'; session: string; error?: string };

/** One request to the model: the conversation so far in, its reply out. */
export interface AgentReply {
  text: string;
  calls: AgentToolCall[];
  stop: 'end' | 'tools' | 'max_tokens' | 'refusal';
  /** Provider-specific content to send back unchanged next time (Claude's blocks, with thinking). */
  raw?: unknown;
  /** Tokens this request used, when the service says. */
  usage?: AgentUsage;
}

/** Tokens used: read in full, written out (thinking included), and read from or written to Claude's prompt cache. */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const emptyUsage = (): AgentUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function addUsage(a: AgentUsage, b: AgentUsage | undefined): AgentUsage {
  if (b) {
    a.input += b.input;
    a.output += b.output;
    a.cacheRead += b.cacheRead;
    a.cacheWrite += b.cacheWrite;
  }
  return a;
}

/** Claude's prices per million tokens (Opus 5.5): input, output, cache reads, 5-minute cache writes. */
export const CLAUDE_PRICES = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

/** What tokens cost in US dollars; free AIs cost nothing. */
export function usageCost(u: AgentUsage, provider: string | undefined): number {
  if (provider !== 'claude') return 0;
  return (u.input * CLAUDE_PRICES.input + u.output * CLAUDE_PRICES.output + u.cacheRead * CLAUDE_PRICES.cacheRead + u.cacheWrite * CLAUDE_PRICES.cacheWrite) / 1_000_000;
}

export interface AgentModel {
  /** Who answers, for messages ("Claude", "qwen3 (Ollama)"). */
  readonly name: string;
  /** Small models get fewer tools and shorter results. */
  readonly free: boolean;
  readonly provider: string;
  reply(req: { system: string; messages: AgentMessage[]; tools: AgentTool[]; onText?: (delta: string) => void; signal?: AbortSignal }): Promise<AgentReply>;
}

// ---------------------------------------------------------------- instructions

export const AGENT_RULES = `You are the assistant in TES5 Env Editor, a modern Creation Kit for Skyrim Special Edition. You help a mod author understand and build their mod by using the tools you're given, which act on the load order they have open and on the plugin they're editing.

How to work:
- Look before you answer or change anything: search for the records involved and read them. Never guess an Editor ID or FormKey; use ones a tool gave you.
- Forms are identified by FormKeys like "012E49:Skyrim.esm" (the form's ID within its plugin, then the plugin). Tools also take Editor IDs. Names in game (like "Lydia") are found with search.
- Only change things the author asked for, or that their request clearly needs. Changes go into the plugin they're editing; records from other plugins are overridden, never edited in place.
- Prefer one tool that does the whole job (building a quest from a plan) over many small edits.
- After changing things, check your work with the check tools when there is one for it, and fix problems your changes caused.
- If something can't be done with your tools, say so plainly and say how the author can do it in the editor (which tab).
- If a request is unclear and getting it wrong would waste the author's work, ask one short question first.

Bigger jobs:
- When the author asks for something too big for one go (a questline, several quests, a whole area or town, "a mod about…"), first make a project with set_project: a short brief of what they want and a to-do list of tasks in order, each one a piece you can finish and check in one go (plan and build quest 1; make the bandit camp; write the follow-up quest…). Show them the list and ask whether to start.
- Work on one task at a time: mark it doing, do it, check it, mark it done with a one-line note of what you made. Then stop and tell the author what's done and what's next, so they can look before you go on. Carry on when they say so.
- Keep the brief up to date with decisions the author makes along the way (names, places, tone), so later tasks fit the earlier ones.
- When every task is done, run review_mod and sum up what's left to fix.

Quests:
- For a whole new quest, plan it with plan_quest, tell the author the plan in a few lines (who, where, the stages and what moves them, any questions it raises) and build it with build_plan once they're happy, unless they asked you to just go ahead. The plan summary's mustFix has to be fixed before build_plan works (revise_plan, or edit_plan for an exact change). Try once to fix shouldFix (what would leave the quest stuck) with revise_plan; if it's still there, build anyway and tell the author. advice is for the author: mention what matters, but don't keep revising for it.
- For changes to an existing quest, small edits (a stage, a journal entry, an objective, a line of dialogue) have their own tools; bigger reworks go through quest_as_plan, revise_plan and update_quest_from_plan.
- To change dialogue that's already there, list_dialogue_lines gives each line's id; then edit_dialogue_line (words, emotion, when it's said, which stage it moves to, ending the conversation), edit_player_line or remove_dialogue. Add new lines with add_dialogue.
- Journal entries are first person, past tense ("Brynja asked me to find her ring."); objectives are short instructions ("Find Brynja's ring").
- After changing a quest, run check_quest on it and tell the author what it found. Fix a problem only if your change caused it and fixing it is part of what they asked; otherwise leave it (a new stage nothing leads to yet is normal until the author connects it).

Characters, items, magic and scripts:
- New characters: create_character with their name, race, sex, role and place; it picks a fitting character to copy, so don't search for one first. Changes to existing ones: change_character with only the fields that change. Clothing and items are named as they are in the load order.
- Items, spells, perks, lists and other records: copy_record a similar one and change it with update_record, or create_record a blank one. Read a similar record first to learn its field names; never invent fields.
- Scripts: write_script saves only checked-clean source; then compile_scripts, attach_script and set_script_property or autofill_properties. Keep scripts short and use the game's own functions.

Places and the world:
- A new interior: create_place, copying the layout of a fitting interior (layoutLike) and adding a linked door where the player comes from (doorFrom). Then light_room and make_navmesh.
- Objects: place_object puts items on surfaces and furniture or characters on open floor, next to what "where" names. Use place_contents to see what's there and to get reference FormKeys for move_objects, remove_objects and doors.
- dress_room adds clutter that fits the room's use; light_room sets the mood and lights candles and fires.
- Levers, secret doors, quest items, traps and rewards: add_trigger on the placed object (or on a quest alias for whoever fills it): when something happens to it, if conditions hold, do actions. list_triggers shows them with ids for change_trigger and remove_trigger. Then compile_scripts.
- Outdoors: list_worldspaces and ground_info show where things are; create_outdoor_cell adds a cell beside another, create_worldspace makes a new outdoor map (reach it with add_linked_door). shape_ground makes hills, hollows, flat spots (flatten before building) and, through several points, ridges, valleys and roads; paint_ground textures them (list_ground_textures). Sizes and heights for these tools are in metres (a cell is about 58 m across; a two-storey house is about 9 m tall). drop_to_floor objects after reshaping the ground under them.

How to answer:
- Plain, friendly words for someone who knows Skyrim but not the Creation Kit's jargon. Short paragraphs and lists. No JSON or code unless they ask for it (Papyrus scripts are fine when the task is a script).
- Say what you changed in a short list at the end, by name (characters, quests, items), so the author can find it.
- Don't repeat a tool's whole output; pick out what matters.`;

/** Instructions for a model that can't call tools: the tools in words, and the answer format. */
function jsonProtocol(tools: AgentTool[]): string {
  const list = tools.map((t) => `- ${t.name}: ${t.description}\n  input: ${JSON.stringify(toolSchema(t))}`).join('\n');
  return `You can use these tools:\n${list}\n\nAnswer with only one JSON object, no other text: {"say": "what to tell the author (can be empty while you're still working)", "calls": [{"tool": "tool name", "input": {…}}]}. Put the tools you want to use in "calls"; you'll get their results and can then call more or answer. When you're finished, leave "calls" empty and put your answer in "say".`;
}

// ---------------------------------------------------------------- tool helpers

const schemas = new WeakMap<AgentTool, Record<string, unknown>>();

/** A tool's input as JSON Schema (without the $schema line). */
export function toolSchema(t: AgentTool): Record<string, unknown> {
  let s = schemas.get(t);
  if (!s) {
    const { $schema: _, ...rest } = z.toJSONSchema(t.input, { unrepresentable: 'any' }) as Record<string, unknown>;
    s = rest;
    schemas.set(t, s);
  }
  return s;
}

/** Results are cut to fit: the AI reads the start and is told how much was left out. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(${(text.length - max).toLocaleString('en')} more characters left out; ask for less, e.g. with a narrower search or a smaller limit)`;
}

function stringify(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v, (_, x) => (x instanceof Uint8Array ? `(${x.length} bytes)` : typeof x === 'bigint' ? Number(x) : x));
}

let callIds = 0;
const newCallId = () => `call_${Date.now().toString(36)}_${(callIds++).toString(36)}`;

// ---------------------------------------------------------------- the loop

export interface AgentHooks {
  onEvent?: (e: AgentEvent) => void;
  /** Asked before a tool that changes something runs; false skips it. Not set: changes run without asking. */
  approve?: (call: AgentToolCall, tool: AgentTool, summary: string) => Promise<boolean>;
  /**
   * Runs a changing tool as one undo step. The host wraps it in a transaction
   * labelled with the summary; tests can run it directly.
   */
  transaction?: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  /** After the AI finishes a turn that changed something: problems to send back once (empty: none). */
  checkChanges?: () => Promise<string[]>;
  signal?: AbortSignal;
  /**
   * Show the model only some tools (small models read every tool's description
   * with each message): these first, and the rest by topic through more_tools.
   * Any tool can still be run by name.
   */
  offer?: ToolOffer;
}

export interface ToolOffer {
  tools: AgentTool[];
  topics: Record<string, { about: string; tools: AgentTool[] }>;
}

/** The tool that adds a topic's tools to what the model sees, for the rest of the turn. */
function moreToolsTool(offer: ToolOffer, offered: AgentTool[]): AgentTool<any> {
  const names = Object.keys(offer.topics) as [string, ...string[]];
  return {
    name: 'more_tools',
    group: 'read',
    writes: false,
    description: `Only the tools for this kind of job are listed, to keep things short. If you need tools for another kind of job, get them here: ${Object.entries(offer.topics)
      .map(([k, t]) => `${k} (${t.about})`)
      .join('; ')}.`,
    input: z.object({ topic: z.enum(names) }),
    summary: (i) => `Get the ${i.topic} tools`,
    run: (i) => {
      const add = offer.topics[i.topic]!.tools.filter((t) => !offered.includes(t));
      offered.push(...add);
      return { data: add.length ? `You can now also use: ${add.map((t) => t.name).join(', ')}.` : 'You already have these tools.' };
    },
  };
}

export interface AgentTurnResult {
  text: string;
  changes: string[];
  results: AgentToolResult[];
  error?: string;
  usage: AgentUsage;
}

/**
 * Run one turn: the author's message, then as many rounds of tool calls as
 * the AI needs (up to a limit), until it answers. The session is updated in
 * place, so what happened is kept even when the turn fails or is stopped.
 */
export async function runAgentTurn(
  model: AgentModel,
  session: AgentSession,
  input: { text: string; context?: string },
  tools: AgentTool[],
  hooks: AgentHooks = {},
): Promise<AgentTurnResult> {
  const sid = session.id;
  const emit = (e: AgentEvent) => hooks.onEvent?.(e);
  session.messages.push({ role: 'user', text: input.text, ...(input.context ? { context: input.context } : {}) });
  session.updated = Date.now();
  const offered = hooks.offer ? [...hooks.offer.tools] : tools;
  const more = hooks.offer ? moreToolsTool(hooks.offer, offered) : undefined;
  const byName = new Map([...tools, ...(more ? [more] : [])].map((t) => [t.name, t]));
  const usage = emptyUsage();
  const maxCalls = model.free ? 15 : 40;
  const maxRounds = model.free ? 10 : 25;
  const resultMax = model.free ? 4000 : 12000;
  const changes: string[] = [];
  const results: AgentToolResult[] = [];
  let calls = 0;
  let checked = false;
  /** Calls that failed this turn, by tool and input: small models repeat a failed call word for word. */
  const failed = new Map<string, string>();
  /** Reading calls already answered this turn: small models also repeat those instead of moving on. */
  const read = new Set<string>();
  /** Changes already made this turn: making the same one again does nothing. */
  const wrote = new Set<string>();
  /** Calls not run because they repeated one: a model that keeps doing it is stuck, and the turn ends. */
  let repeats = 0;
  let stuck = false;
  let text = '';
  const system = `${AGENT_RULES}`;
  try {
    for (let round = 0; round < maxRounds; round++) {
      if (hooks.signal?.aborted) throw new AgentStopped();
      const reply = await model.reply({ system, messages: session.messages, tools: more ? [...offered, more] : tools, onText: (d) => emit({ type: 'text', session: sid, delta: d }), signal: hooks.signal });
      addUsage(usage, reply.usage);
      session.messages.push({ role: 'assistant', text: reply.text, calls: reply.calls, provider: model.provider, ...(reply.raw !== undefined ? { raw: reply.raw } : {}) });
      session.updated = Date.now();
      if (reply.text) text = reply.text;
      if (reply.stop === 'refusal') {
        // Calls in a declined answer may be cut off: none are run.
        if (reply.calls.length) session.messages.push({ role: 'tool', results: reply.calls.map((c) => skipped(c, byName.get(c.name), 'Not run: the answer was declined.')) });
        throw new WorkspaceError(`${model.name} declined to answer this. Try rewording it.`);
      }
      if (reply.stop === 'max_tokens') {
        if (reply.calls.length) session.messages.push({ role: 'tool', results: reply.calls.map((c) => skipped(c, byName.get(c.name), 'Not run: the request was cut off.')) });
        throw new WorkspaceError(`${model.name}'s answer got too long and was cut off. Ask for less at once.`);
      }
      if (!reply.calls.length) {
        // Finished. Once per turn, problems its changes caused go back to it.
        if (changes.length && !checked && hooks.checkChanges) {
          checked = true;
          const problems = await hooks.checkChanges().catch(() => [] as string[]);
          if (problems.length) {
            session.messages.push({ role: 'user', text: `The editor's checks found these problems after your changes:\n${problems.map((p) => `- ${p}`).join('\n')}\nFix the ones your changes caused if fixing them is part of what the author asked for; otherwise don't change anything else: tell the author about them in your summary (for example, a new stage that nothing leads to yet). Then sum up again.` });
            continue;
          }
        }
        return { text, changes, results, usage };
      }
      const out: AgentToolResult[] = [];
      for (const call of reply.calls) {
        const tool = byName.get(call.name);
        if (hooks.signal?.aborted) {
          out.push(skipped(call, tool, 'Stopped by the author.', 'stopped'));
          continue;
        }
        if (++calls > maxCalls) {
          out.push(skipped(call, tool, `Not run: this turn has used its ${maxCalls} tool calls. Tell the author what is done and what is left, and they can ask you to go on.`));
          continue;
        }
        // Reading the same thing in other capitals ("Mead", "mead") is the same look.
        const sig = `${call.name} ${tool && !tool.writes ? JSON.stringify(call.input ?? {}).toLowerCase() : JSON.stringify(call.input ?? {})}`;
        const before = failed.get(sig);
        if ((before !== undefined || read.has(sig) || (wrote.has(sig) && !tool?.adds)) && ++repeats > 3) {
          out.push(skipped(call, tool, 'Not run: the turn ended because the same calls kept being repeated.'));
          stuck = true;
          continue;
        }
        if (before !== undefined) {
          out.push(skipped(call, tool, `Not run: you already made exactly this call this turn and it failed:\n${clip(before, 600)}\nDon't repeat it. Change the input, use another tool, or tell the author what's wrong.`));
          continue;
        }
        if (wrote.has(sig) && !tool?.adds) {
          out.push({ id: call.id, name: call.name, content: 'Not run again: this exact change was already made this turn. Go on to the next step, or tell the author what was done.', isError: true, summary: safeSummary(tool, call.input), writes: true, status: 'error' });
          continue;
        }
        if (read.has(sig)) {
          out.push({ id: call.id, name: call.name, content: `Not run again: you already made exactly this call this turn, and its result is above. Use what it returned to take the next step, or answer the author.`, isError: true, summary: safeSummary(tool, call.input), writes: false, status: 'error' });
          continue;
        }
        const r = await runTool(call, tool, model, hooks, resultMax, sid);
        if (r.status === 'error') failed.set(sig, r.content);
        else if (tool && !tool.writes) read.add(sig);
        // After a change, looking again is worth it.
        else if (tool?.writes) {
          read.clear();
          wrote.add(sig);
        }
        out.push(r);
        results.push(r);
        if (r.writes && r.status === 'done') changes.push(r.summary);
        emit({ type: 'result', session: sid, result: r });
      }
      session.messages.push({ role: 'tool', results: out });
      session.updated = Date.now();
      if (hooks.signal?.aborted) throw new AgentStopped();
      if (stuck) {
        const msg = `${model.name} kept repeating the same calls, so the turn was stopped. Try asking again in other words, or one step at a time.`;
        return { text: text || msg, changes, results, error: msg, usage };
      }
    }
    const msg = `Stopped after ${maxRounds} rounds of tool calls. Ask the AI to go on if there's more to do.`;
    return { text: text || msg, changes, results, error: msg, usage };
  } catch (e) {
    // Every call the AI made gets an answer, so the conversation can go on.
    const last = session.messages[session.messages.length - 1];
    if (last?.role === 'assistant' && last.calls.length) session.messages.push({ role: 'tool', results: last.calls.map((c) => skipped(c, byName.get(c.name), 'Stopped by the author.', 'stopped')) });
    const error = e instanceof AgentStopped ? 'Stopped.' : (e as Error).message;
    return { text, changes, results, error, usage };
  }
}

export class AgentStopped extends Error {
  constructor() {
    super('Stopped');
  }
}

function skipped(call: AgentToolCall, tool: AgentTool | undefined, why: string, status: AgentToolResult['status'] = 'error'): AgentToolResult {
  return { id: call.id, name: call.name, content: why, isError: true, summary: safeSummary(tool, call.input), writes: !!tool?.writes, status };
}

function safeSummary(tool: AgentTool | undefined, input: unknown): string {
  if (!tool) return 'Unknown tool';
  try {
    return tool.summary(input);
  } catch {
    return tool.name;
  }
}

/** Fix out-of-range numbers and empty lists where something is needed or nothing is meant; true if anything changed. */
export function mendInput(input: unknown, issues: readonly { code: string; path: PropertyKey[]; origin?: string; minimum?: unknown; maximum?: unknown }[]): boolean {
  let changed = false;
  for (const issue of issues) {
    if (!issue.path.length) continue;
    let parent = input as Record<PropertyKey, unknown>;
    for (const p of issue.path.slice(0, -1)) parent = (parent?.[p] ?? null) as Record<PropertyKey, unknown>;
    const key = issue.path[issue.path.length - 1]!;
    if (!parent || typeof parent !== 'object') continue;
    const v = parent[key];
    if (typeof v === 'number' && issue.origin === 'number') {
      if (issue.code === 'too_small' && typeof issue.minimum === 'number') (parent[key] = issue.minimum), (changed = true);
      if (issue.code === 'too_big' && typeof issue.maximum === 'number') (parent[key] = issue.maximum), (changed = true);
    } else if (Array.isArray(v) && !v.length && issue.code === 'too_small' && !Array.isArray(parent)) {
      parent[key] = null;
      changed = true;
    }
  }
  return changed;
}

async function runTool(call: AgentToolCall, tool: AgentTool | undefined, model: AgentModel, hooks: AgentHooks, max: number, sid: string): Promise<AgentToolResult> {
  if (!tool) return { id: call.id, name: call.name, content: `There is no tool called "${call.name}".`, isError: true, summary: `Unknown tool ${call.name}`, writes: false, status: 'error' };
  // Small models quote numbers and leave out empty fields: read them as meant, then check.
  const input = fillMissing(tool.input, structuredClone(call.input ?? {}));
  let parsed = tool.input.safeParse(input);
  // Then mend what is plainly meant: a number past a limit is taken as the limit, an empty list as none.
  if (!parsed.success && mendInput(input, parsed.error.issues)) parsed = tool.input.safeParse(input);
  if (!parsed.success) {
    const problems = parsed.error.issues.slice(0, 6).map((i) => `${i.path.join('.') || 'input'}: ${i.message}`);
    return { id: call.id, name: call.name, content: `The input doesn't fit this tool:\n${problems.join('\n')}\nIt takes: ${JSON.stringify(toolSchema(tool))}`, isError: true, summary: tool.name, writes: tool.writes, status: 'error' };
  }
  const summary = safeSummary(tool, parsed.data);
  if (tool.writes && hooks.approve) {
    hooks.onEvent?.({ type: 'call', session: sid, id: call.id, name: call.name, summary, writes: true, status: 'waiting' });
    if (!(await hooks.approve(call, tool, summary))) return { id: call.id, name: call.name, content: 'The author chose not to make this change. Ask them what they would like instead, or carry on without it.', isError: true, summary, writes: true, status: 'declined' };
  }
  hooks.onEvent?.({ type: 'call', session: sid, id: call.id, name: call.name, summary, writes: tool.writes, status: 'running' });
  try {
    const run = () => Promise.resolve(tool.run(parsed.data));
    const out = tool.writes && hooks.transaction ? await hooks.transaction(`AI: ${summary}`, run) : await run();
    return { id: call.id, name: call.name, content: clip(stringify(out.data ?? 'Done.'), max), summary, writes: tool.writes, status: 'done', ...(out.note ? { note: out.note } : {}), ...(out.link ? { link: out.link } : {}) };
  } catch (e) {
    return { id: call.id, name: call.name, content: `Failed: ${(e as Error).message}`, isError: true, summary, writes: tool.writes, status: 'error', note: (e as Error).message };
  }
}

// ---------------------------------------------------------------- models

/** The model behind an AI choice. */
export function agentModel(ai: AiProvider, fetchImpl?: Fetch): AgentModel {
  if (ai.kind === 'claude') return new ClaudeAgentModel(ai.apiKey);
  if (ai.kind === 'local') throw new WorkspaceError('The built-in AI has to be started first');
  return new ChatAgentModel(ai, fetchImpl);
}

/** Claude through Anthropic's API, streaming, with its own tool use. */
export class ClaudeAgentModel implements AgentModel {
  readonly name = 'Claude';
  readonly free = false;
  readonly provider = 'claude';
  private readonly client: Anthropic;

  constructor(apiKey: string, client?: Anthropic) {
    if (!apiKey && !client) throw new WorkspaceError('Add your Anthropic API key in the AI settings, or pick a free AI');
    this.client = client ?? new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  }

  async reply(req: { system: string; messages: AgentMessage[]; tools: AgentTool[]; onText?: (d: string) => void; signal?: AbortSignal }): Promise<AgentReply> {
    const tools: BetaToolUnion[] = req.tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: toolSchema(t) as { type: 'object' },
      eager_input_streaming: true,
      // The tool list and the rules don't change between requests: cache them.
      ...(i === req.tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }));
    try {
      const stream = this.client.beta.messages.stream(
        {
          model: AGENT_MODEL,
          max_tokens: 32000,
          thinking: { type: 'adaptive' },
          output_config: { effort: 'medium' },
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          tools,
          messages: claudeMessages(req.messages),
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        },
        { signal: req.signal },
      );
      if (req.onText) stream.on('text', (d) => req.onText!(d));
      const msg = await stream.finalMessage();
      const text = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('');
      const calls = msg.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: (b as { id: string }).id, name: (b as { name: string }).name, input: (b as { input: unknown }).input }));
      const stop = msg.stop_reason === 'refusal' ? 'refusal' : msg.stop_reason === 'max_tokens' ? 'max_tokens' : calls.length ? 'tools' : 'end';
      const u = msg.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | undefined;
      return { text, calls, stop, raw: msg.content, usage: { input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0, cacheRead: u?.cache_read_input_tokens ?? 0, cacheWrite: u?.cache_creation_input_tokens ?? 0 } };
    } catch (e) {
      if (req.signal?.aborted) throw new AgentStopped();
      if (e instanceof Anthropic.AuthenticationError) throw new WorkspaceError('Anthropic rejected the API key. Check it in the AI settings.');
      if (e instanceof Anthropic.RateLimitError) throw new WorkspaceError('Too many requests to Claude right now. Wait a minute and try again.');
      if (e instanceof Anthropic.APIConnectionError) throw new WorkspaceError("Couldn't reach Anthropic's API. Check your internet connection.");
      if (e instanceof Anthropic.APIError) throw new WorkspaceError(`Claude couldn't answer: ${e.message}`);
      throw e;
    }
  }
}

/** The conversation in Anthropic's format. Claude's own answers go back exactly as they came (with their thinking). */
export function claudeMessages(messages: AgentMessage[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.context ? `${m.text}\n\n<editor_context>\n${m.context}\n</editor_context>` : m.text });
    else if (m.role === 'assistant') {
      if (m.provider === 'claude' && Array.isArray(m.raw)) out.push({ role: 'assistant', content: m.raw as BetaContentBlockParam[] });
      else {
        const content: BetaContentBlockParam[] = [];
        if (m.text) content.push({ type: 'text', text: m.text });
        for (const c of m.calls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input ?? {} });
        if (content.length) out.push({ role: 'assistant', content });
      }
    } else out.push({ role: 'user', content: m.results.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })) });
  }
  return out;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<ChatResponse>;

/**
 * Ollama (its own API, so the context window can be sized) or an
 * OpenAI-style service, with function calling. Models that refuse tools are
 * given them in words and answer in a small JSON format instead.
 */
export class ChatAgentModel implements AgentModel {
  readonly name: string;
  readonly free = true;
  readonly provider: string;
  /** Set once the model has said it can't take tools. */
  jsonTools = false;
  private readonly fetch: Fetch;

  constructor(
    private readonly ai: ChatProvider,
    fetchImpl?: Fetch,
  ) {
    this.name = aiName(ai);
    this.provider = ai.kind;
    // Called as a plain function: a browser's fetch refuses to run as a method of another object ("Illegal invocation").
    this.fetch = fetchImpl ?? ((url, init) => (globalThis.fetch as unknown as Fetch)(url, init));
  }

  async reply(req: { system: string; messages: AgentMessage[]; tools: AgentTool[]; onText?: (d: string) => void; signal?: AbortSignal }): Promise<AgentReply> {
    // Text is shown as it streams in; a service that answers all at once has it shown at the end.
    let streamed = false;
    const onText = req.onText ? (d: string) => ((streamed = true), req.onText!(d)) : undefined;
    if (!this.jsonTools) {
      try {
        const r = await this.send({ ...req, onText }, false);
        if (r.text && !streamed) req.onText?.(r.text);
        return r;
      } catch (e) {
        // "does not support tools", "tool use is not supported"…: fall back to tools in words.
        if (!((e as { status?: number }).status === 400 && /tool|function/i.test((e as Error).message))) throw e;
        this.jsonTools = true;
      }
    }
    // In words, the answer is JSON: it's shown once read, not as it streams.
    const r = await this.send({ ...req, onText: undefined }, true);
    if (r.text) req.onText?.(r.text);
    return r;
  }

  private messages(req: { system: string; messages: AgentMessage[]; tools: AgentTool[] }, json: boolean): any[] {
    const ollama = this.ai.kind === 'ollama';
    const out: any[] = [{ role: 'system', content: json ? `${req.system}\n\n${jsonProtocol(req.tools)}` : req.system }];
    // Older tool results are trimmed: small models have little room.
    const lastUser = req.messages.map((m) => m.role).lastIndexOf('user');
    req.messages.forEach((m, i) => {
      if (m.role === 'user') out.push({ role: 'user', content: m.context ? `${m.text}\n\n(What the author has open: ${m.context})` : m.text });
      else if (m.role === 'assistant') {
        if (json) out.push({ role: 'assistant', content: JSON.stringify({ say: m.text, calls: m.calls.map((c) => ({ tool: c.name, input: c.input })) }) });
        else if (ollama) out.push({ role: 'assistant', content: m.text, ...(m.calls.length ? { tool_calls: m.calls.map((c) => ({ function: { name: c.name, arguments: c.input ?? {} } })) } : {}) });
        else out.push({ role: 'assistant', content: m.text || null, ...(m.calls.length ? { tool_calls: m.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) } : {}) });
      } else {
        const content = (r: AgentToolResult) => (i < lastUser ? clip(r.content, 600) : r.content);
        if (json) out.push({ role: 'user', content: `Tool results:\n${m.results.map((r) => `${r.name}: ${content(r)}`).join('\n\n')}` });
        else for (const r of m.results) out.push(ollama ? { role: 'tool', content: content(r), tool_name: r.name } : { role: 'tool', tool_call_id: r.id, content: content(r) });
      }
    });
    return out;
  }

  private async send(req: { system: string; messages: AgentMessage[]; tools: AgentTool[]; signal?: AbortSignal; onText?: (d: string) => void }, json: boolean): Promise<AgentReply> {
    const messages = this.messages(req, json);
    const tools = json ? undefined : req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: toolSchema(t) } }));
    if (this.ai.kind === 'ollama') {
      const base = (this.ai.url || OLLAMA_URL).replace(/\/+$/, '');
      const promptTokens = estimateTokens(JSON.stringify(messages) + JSON.stringify(tools ?? []));
      const max = await ollamaContextLength(base, this.ai.model, this.fetch);
      if (max && promptTokens + 2000 > max) throw new WorkspaceError(`The conversation is too long for ${this.ai.model} (it reads about ${max.toLocaleString('en')} tokens). Start a new conversation, or pick a model that reads more.`);
      const r = await this.call(`${base}/api/chat`, { model: this.ai.model, messages, stream: true, ...(tools ? { tools } : { format: 'json' }), options: { num_ctx: contextWindow(promptTokens, max), temperature: 0.2 } }, {}, req.signal, req.onText);
      const msg = r?.message ?? {};
      const usage = { input: Number(r?.prompt_eval_count ?? 0), output: Number(r?.eval_count ?? 0), cacheRead: 0, cacheWrite: 0 };
      if (json) return { ...this.fromJson(String(msg.content ?? ''), r?.done_reason === 'length'), usage };
      const calls: AgentToolCall[] = ((msg.tool_calls ?? []) as { function?: { name?: string; arguments?: unknown } }[]).map((c) => ({ id: newCallId(), name: String(c.function?.name ?? ''), input: parseArgs(c.function?.arguments) }));
      const fromText = calls.length ? null : textCalls(String(msg.content ?? ''), req.tools);
      if (fromText?.calls.length) return { text: fromText.text, calls: fromText.calls, stop: 'tools', usage };
      return { text: stripThinking(String(msg.content ?? '')), calls, stop: r?.done_reason === 'length' ? 'max_tokens' : calls.length ? 'tools' : 'end', usage };
    }
    const url = `${this.ai.url.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = this.ai.apiKey ? { authorization: `Bearer ${this.ai.apiKey}` } : {};
    const r = await this.call(url, { model: this.ai.model, messages, temperature: 0.2, max_tokens: 8000, ...streamFields(this.ai.url), ...(tools ? { tools } : { response_format: { type: 'json_object' } }) }, headers, req.signal, req.onText);
    const choice = r?.choices?.[0] ?? {};
    const cut = choice.finish_reason === 'length';
    const usage = { input: Number(r?.usage?.prompt_tokens ?? 0), output: Number(r?.usage?.completion_tokens ?? 0), cacheRead: 0, cacheWrite: 0 };
    if (json) return { ...this.fromJson(String(choice.message?.content ?? ''), cut), usage };
    const calls: AgentToolCall[] = ((choice.message?.tool_calls ?? []) as { id?: string; function?: { name?: string; arguments?: unknown } }[]).map((c) => ({ id: c.id || newCallId(), name: String(c.function?.name ?? ''), input: parseArgs(c.function?.arguments) }));
    const fromText = calls.length || cut ? null : textCalls(String(choice.message?.content ?? ''), req.tools);
    if (fromText?.calls.length) return { text: fromText.text, calls: fromText.calls, stop: 'tools', usage };
    return { text: stripThinking(String(choice.message?.content ?? '')), calls, stop: cut ? 'max_tokens' : calls.length ? 'tools' : 'end', usage };
  }

  private fromJson(content: string, cut: boolean): AgentReply {
    let j: { say?: unknown; calls?: unknown } = {};
    try {
      j = JSON.parse(cleanJson(content));
    } catch {
      // Not JSON at all: take it as the answer.
      return { text: stripThinking(content), calls: [], stop: cut ? 'max_tokens' : 'end' };
    }
    const calls = (Array.isArray(j.calls) ? j.calls : [])
      .filter((c): c is { tool: string; input?: unknown } => !!c && typeof c === 'object' && typeof (c as { tool?: unknown }).tool === 'string')
      .map((c) => ({ id: newCallId(), name: c.tool, input: parseArgs(c.input) }));
    return { text: typeof j.say === 'string' ? j.say : '', calls, stop: cut ? 'max_tokens' : calls.length ? 'tools' : 'end' };
  }

  private async call(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal, onText?: (d: string) => void): Promise<any> {
    let res;
    try {
      res = await this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
    } catch {
      if (signal?.aborted) throw new AgentStopped();
      throw new WorkspaceError(this.ai.kind === 'ollama' ? `Couldn't reach Ollama at ${this.ai.url || OLLAMA_URL}. Is it running?` : `Couldn't reach ${url}. Check the address and your internet connection.`);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      if (res.status === 401 || res.status === 403) throw new WorkspaceError('The service rejected the API key. Check it in the AI settings.');
      if (res.status === 404 && this.ai.kind === 'ollama') throw new WorkspaceError(`Ollama doesn't have the model "${this.ai.model}". Run "ollama pull ${this.ai.model}" first, or pick an installed model.`);
      if (res.status === 429) throw new WorkspaceError(`Too many requests to ${this.name} right now (free tiers have limits). Wait a minute and try again.`);
      const err = new WorkspaceError(`${this.name} couldn't answer (${res.status}): ${detail}`);
      (err as WorkspaceError & { status?: number }).status = res.status;
      throw err;
    }
    try {
      return await readChat(res, this.ai.kind === 'ollama' ? 'ollama' : 'openai', onText);
    } catch (e) {
      if (signal?.aborted) throw new AgentStopped();
      throw e;
    }
  }
}

function parseArgs(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? {};
  try {
    return JSON.parse(cleanJson(v));
  } catch {
    return {};
  }
}

/**
 * Tool calls a model wrote out as text instead of making them (small models
 * do: "<tool_call>{"name": …, "arguments": {…}}</tool_call>", the format many
 * were trained on). Only calls to tools it has are taken.
 */
export function textCalls(content: string, tools: AgentTool[]): { text: string; calls: AgentToolCall[] } | null {
  if (!/<tool_call>/i.test(content)) return null;
  const names = new Set(tools.map((t) => t.name));
  const calls: AgentToolCall[] = [];
  const text = content.replace(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/gi, (whole, body: string) => {
    try {
      const j = JSON.parse(cleanJson(body)) as { name?: unknown; arguments?: unknown; parameters?: unknown };
      if (typeof j.name === 'string' && names.has(j.name)) {
        calls.push({ id: newCallId(), name: j.name, input: parseArgs(j.arguments ?? j.parameters ?? {}) });
        return '';
      }
    } catch {
      // Not a call after all: leave the text as it is.
    }
    return whole;
  });
  return { text: stripThinking(text), calls };
}

function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// ---------------------------------------------------------------- projects

/** The project in a few lines, for the AI to keep in view at every turn. */
export function projectSummary(p: AgentProject | undefined): string {
  if (!p) return '';
  const mark: Record<AgentTaskStatus, string> = { todo: '[ ]', doing: '[>]', done: '[x]', skipped: '[-]' };
  return `Project brief: ${p.brief}\nTo-do:\n${p.tasks.map((t) => `${mark[t.status]} ${t.id}. ${t.title}${t.note ? ` — ${t.note}` : ''}`).join('\n')}`;
}

/** Tools that keep a conversation's project (its brief and to-do list). They change the conversation, not the plugin. */
export function projectTools(session: AgentSession): AgentTool<any>[] {
  const need = () => {
    if (!session.project) throw new WorkspaceError('There is no project in this conversation yet: make one with set_project');
    return session.project;
  };
  const show = () => ({ data: projectSummary(session.project) });
  return [
    {
      name: 'set_project',
      group: 'read',
      writes: false,
      description: 'Start (or replace) the project for a bigger job: a short brief and a to-do list of tasks in order, each small enough to finish and check in one go. The author sees the list beside the conversation.',
      input: z.object({ brief: z.string().describe("What the whole job is: the author's goals and decisions"), tasks: z.array(z.string()).min(1).max(40).describe('The tasks, in order') }),
      summary: (i) => `Plan the project (${i.tasks.length} tasks)`,
      run: (i) => {
        session.project = { brief: i.brief.trim(), tasks: i.tasks.map((t: string, n: number) => ({ id: n + 1, title: t.trim(), status: 'todo' as const })) };
        return show();
      },
    },
    {
      name: 'update_task',
      group: 'read',
      writes: false,
      description: "Mark a project task as doing, done (with a one-line note of what was made) or skipped, or rename it.",
      input: z.object({ id: z.number().int(), status: z.enum(['todo', 'doing', 'done', 'skipped']).nullable().optional(), note: z.string().nullable().optional(), title: z.string().nullable().optional() }),
      summary: (i) => `Task ${i.id}${i.status ? `: ${i.status}` : ''}`,
      run: (i) => {
        const t = need().tasks.find((x) => x.id === i.id);
        if (!t) throw new WorkspaceError(`There's no task ${i.id}`);
        if (i.status) t.status = i.status;
        if (i.note) t.note = i.note.trim();
        if (i.title) t.title = i.title.trim();
        return show();
      },
    },
    {
      name: 'add_tasks',
      group: 'read',
      writes: false,
      description: 'Add tasks to the project, at the end or after a given task.',
      input: z.object({ tasks: z.array(z.string()).min(1), after: z.number().int().nullable().optional().describe('Task id to insert after; null for the end') }),
      summary: (i) => `Add ${i.tasks.length} task${i.tasks.length === 1 ? '' : 's'}`,
      run: (i) => {
        const p = need();
        let next = Math.max(0, ...p.tasks.map((t) => t.id)) + 1;
        const made = i.tasks.map((t: string) => ({ id: next++, title: t.trim(), status: 'todo' as const }));
        const at = i.after ? p.tasks.findIndex((t) => t.id === i.after) + 1 : p.tasks.length;
        p.tasks.splice(at > 0 ? at : p.tasks.length, 0, ...made);
        return show();
      },
    },
    {
      name: 'update_brief',
      group: 'read',
      writes: false,
      description: "Rewrite the project's brief with the decisions made so far, so later tasks fit the earlier ones.",
      input: z.object({ brief: z.string() }),
      summary: () => 'Update the brief',
      run: (i) => {
        need().brief = i.brief.trim();
        return show();
      },
    },
  ];
}

// ---------------------------------------------------------------- sessions

/** A new, empty conversation. */
export function newAgentSession(title = 'New conversation'): AgentSession {
  const now = Date.now();
  return { id: `s${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, title, created: now, updated: now, messages: [], turns: [] };
}

/** A short title from the first thing the author asked. */
export function sessionTitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 57).replace(/\s+\S*$/, '')}…` : t || 'New conversation';
}
