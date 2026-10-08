/**
 * The AI quest planner: Claude reads a design document (or just a
 * conversation) and writes a quest plan (questplan.ts) for the builder.
 *
 * The author never has to add tags or structure: Claude works out the
 * characters, places, items, stages, journal, objectives, what moves the
 * quest on and the dialogue, and lists every decision it made on its own so
 * the author can check them before anything is built. A plan can be revised
 * by describing the change ("make Brynja the thief instead").
 *
 * The text is sent to Anthropic's API with the author's own API key.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { WorkspaceError, type Workspace } from './engine';
import { GESTURES } from './gestures';
import { z } from 'zod';
import type { JournalContext, JournalDraft } from './journal';
import { PLAN_EVENT_KINDS, QuestPlanSchema, type QuestPlan } from './questplan';
import { WorldService } from './world';

export const PLANNER_MODEL = 'claude-opus-5-5';

export type PlannerMode = 'document' | 'conversation';

/** What the planner needs back from the API (the subset of a message it reads). */
export interface PlannerReply {
  content: { type: string; text?: string }[];
  stop_reason: string | null;
}

/** Sends one request. The default streams it through the Anthropic SDK; tests pass their own. */
export type PlannerSend = (params: BetaMessageStreamParams) => Promise<PlannerReply>;

const RULES = `You turn a Skyrim mod author's writing into a quest plan that a tool builds into a working quest (records, scripts, dialogue). Return only the plan, in the given JSON format.

How to plan:
- Read everything the author wrote. Keep their names, lines and intent. Where they leave something out, decide it the way an experienced Skyrim quest designer would, and record each such decision in "assumptions" in one short sentence. Put real choices only the author can make in "questions" (at most five), and still make a sensible choice for each in the plan.
- Prefer characters, places and items that already exist in the load order (listed below) when the author names them or clearly means them; set "existing" to their Editor ID. Otherwise set "existing" to null and a new one is created.
- Keys are short lowercase identifiers ("brynja", "cellar", "ring") used to refer to entries inside the plan. Every key is unique across characters, locations and items.
- A new place (existing null) is a new interior. Set layoutLike to the Editor ID of an interior from the list below that fits it (an inn for an inn, a house for a home, a cave or ruin for a hideout): its rooms, furniture, lights and clutter are copied, so it's ready to use. Set doorFrom to where the player walks in from (a location key, or an existing cell's Editor ID), and a linked door is added there.
- New characters need a location to stand in (a location key); characters that already exist stay where they are (locationKey null).
- Characters can be changed as well as used. When the author says a character (new or existing) wears something, carries something, belongs to a group, has a class or level, can or can't die, or looks a certain way, put it in outfit, inventory, factions, className, level, essential and look. For existing characters, only fill in what the text asks to change and leave the rest null or empty. "Save it as an outfit" means outfit.saveAs gets an Editor ID.
- Describe every new character's look (build, height, hair, hair colour, facial hair, eyes, scars) from the text, choosing what fits their role when the text says nothing; for a new character that is "like" someone existing, set basedOn.
- Clothing, armour and weapons in an outfit or inventory are existing items named as in the load order (e.g. "Fine Clothes", "Iron Sword"). Only add new clothing or weapons to "items" (kind clothing/armor/weapon, basedOn the closest existing item) when the text describes something unique.
- Say where in a place characters stand and items lie when the text does or it matters ("behind the bar", "by the forge", "in the chest by the bed", "under the table"): characters.spot and items.spot. An item "in" a container is put inside it and can still be picked up for a quest step.
- Give characters a routine when the text says what they do or when it matters for the quest: new characters usually "sandbox" (go about their business) where they live by day and "sleep" there at night. Quest behaviour uses fromStage/untilStage: "follow" (the player) for companions or escorts, "forcegreet" (walk up to the player and say a line) for someone who should approach the player, "travel" to move someone to a place, "stay" to keep them put.
- If the text only asks to create or change characters, places or items and describes no quest, leave stages, objectives, steps, conversations, rewards, animations and events empty; nothing but those changes is built.
- Stages: start at 0 or 10, go up in steps of 10, and end on a stage that completes the quest (often 100 or 200). One stage has startsQuest true. Every stage after the first must be reachable: a step or a conversation line sets it.
- Journal entries are written in the past tense from the player's point of view, like Skyrim's ("Brynja asked me to find her stolen ring."). Write one for every stage the player should notice; the final stage gets a closing entry.
- Objectives are short instructions ("Find Brynja's ring", "Return the ring to Brynja"). Show each at the stage where it starts and complete it at the stage where it's done. Point the marker (targetKey) at the character, item or location involved.
- Steps say what moves the quest from one stage to the next: talk (a line in a conversation, see below), pickup/read/equip/drop/activate (an item key), death/activate (a character key), arrive (a location key), or script (immediately after the "from" stage).
- Items the player must pick up, read or activate must start in a location (startsWith "location"), so the game can tell when it happens. Items handed over in dialogue use the [gives …] and [takes …] tags instead.
- Rewards are gold and/or items given at a stage (usually the final one).
- Endings: when the player's choices lead to different outcomes, give each outcome its own stage with completesQuest true, its own closing journal entry and its own rewards; the conversation line that decides it sets that stage.
- Failure: when the quest can be lost, add a stage with failsQuest true and a journal entry saying what went wrong, and add a failure: "death" if it fails when a character dies (targetKey), "timeLimit" if it must be done within some in-game days (days, fromStage where the clock starts). At most one time limit.
- Events are what happens in the world when a stage is reached, outside dialogue: enemies appear (spawn, with an enemy type like "bandit" or "draugr" and how many), a character turns on the player or calms down (hostile / friendly), a door or chest unlocks or locks, something appears or vanishes (show / hide; shown things start hidden), someone moves somewhere (moveTo), someone dies (kill), the screen fades to black and back (fade, e.g. for time passing or being knocked out; moves at the same stage happen in the dark), a sound plays, the weather changes, a message shows, another quest starts (startQuest, for questlines), or the player is moved (movePlayer). Add one wherever the text says something happens ("bandits ambush you", "the door unlocks", "he draws his sword"). Pair a hostile character or spawned enemies with a death step when killing them moves the quest on.
- Set startsWithGame true when the quest begins by talking to someone (their opening dialogue only appears while the quest runs).
- When the quest begins some other way, set startsWithGame false and say what starts it in startsWhen: the player entering a place ("arrive", a location key), reading a note or book ("read", an item key; the item must start in a location), picking something up ("pickup"), using something ("activate"), or another quest reaching a stage ("afterQuest", that quest's Editor ID, and the stage or null for its end). Use afterQuest for questlines: part two starts when part one ends. A quest that begins with talking to someone keeps startsWithGame true and startsWhen null.

Conversations are written in this screenplay format. Each top-level PLAYER line is something the player can say; NPC lines under it are the answers; indent player choices under the NPC line they answer, and that NPC's answers under them:

PLAYER: Got any work?
BRYNJA: Someone stole my ring. Find it and I'll pay you. [if stage 0]
  PLAYER: I'll find it. [stage 10]
    BRYNJA: Thank you. Check the cellar first. [goodbye]
  PLAYER: Not now.
    BRYNJA: Suit yourself. [goodbye]
PLAYER: I found your ring. [if stage 20]
BRYNJA: My ring! Here, take this. [takes ring x1] [gives gold x100] [stage 100] [goodbye]

Speaker names are character keys in capitals (BRYNJA for the key "brynja"); the player is PLAYER.
Tags at the end of a line: [stage N] sets stage N once the line is said; [if stage N] only offers the line at stage N; [goodbye] ends the conversation; [emotion happy|sad|angry|fear|surprise|disgust|puzzled] sets the delivery; [gives KEY xN] / [takes KEY xN] move an item between the speaker and the player (KEY is an item key, or gold); [gesture NAME] makes the speaker play an animation as they say the line.
Gestures: ${GESTURES.map((g) => `${g.id} (${g.label.toLowerCase()})`).join(', ')}. Use them where a stage direction or the action calls for one (a wave in greeting, pointing the way, laughing, applause); don't put one on every line. For a character reacting when the quest reaches a stage outside dialogue, add it to "animations".
Choices the quest remembers: [remember NAME] on a line stores a choice (e.g. [remember spared] when the player spares someone), [forget NAME] clears it, and [if chose NAME] / [if not chose NAME] only offers a line when the choice was (not) made. Use them for later lines that react to what the player did. More tags: [once] says a line only once; [persuade N] on a player line makes the first answer under it the success of a Speech check (Speech N) and the next answer the failure. Conditions in plain words: [if stage N] (also >=, <), [if done N] (stage N has been reached), [if has KEY xN], [if gold N], [if speech N], [if level N], [if female], [if male], [if race Nord], [if quest EditorID done]; several [if] tags on one line must all be true.
Lines nobody prompts go in blocks: "GREETING:" then NPC lines said when the player comes up to them (put [if …] on the GREETING: line to apply to all), "IDLE:" then things they say to themselves, and "SCENE: name [at stage N]" then lines characters say to each other in order (use [start] instead of [at stage N] to play it when the quest starts). Use greetings to make characters react to how the quest is going ("Any luck with the ring?").
Put [if stage N] on lines that only make sense at one point of the quest, so they don't show up at the wrong time. When a conversation moves the quest on, add a talk step with the same "to" stage.`;

const MODES: Record<PlannerMode, string> = {
  document: 'Here is the quest design document. Plan the whole quest it describes.',
  conversation:
    "Here is a conversation the author wrote. There are no tags in it: work out the quest it implies (who is involved, what the player has to do, where, and what happens at the end), plan that whole quest, and use the conversation in it. Keep the author's lines word for word, split them into the player's choices and the answers, add the [stage]/[if stage]/[goodbye] tags where they belong, and write the extra lines the quest needs (for example what is said when the player comes back).",
};

/**
 * A summary of the load order for the planner: named characters, interiors,
 * voice types and races (your plugin's first), so it can reuse what exists.
 */
export function planCatalog(ws: Workspace, opts: { limit?: number } = {}): string {
  const limit = opts.limit ?? 300;
  const list = (sigs: string[], filter: (name?: string, edid?: string) => boolean = (n) => !!n) => {
    const items = ws.search({ sigs, limit: 100_000 }).items.filter((s) => !s.deleted && filter(s.name, s.editorId));
    items.sort((a, b) => Number(b.inActive) - Number(a.inActive));
    const shown = items.slice(0, limit).map((s) => (s.name && s.name !== s.editorId ? `${s.editorId ?? s.formKey} "${s.name}"` : (s.editorId ?? s.formKey)));
    return `${shown.join('\n') || '(none)'}${items.length > limit ? `\n…and ${items.length - limit} more` : ''}`;
  };
  const yours = ws
    .search({ sigs: ['QUST'], limit: 100_000 })
    .items.filter((s) => s.inActive && !s.deleted && s.editorId)
    .slice(0, limit)
    .map((s) => (s.name ? `${s.editorId} "${s.name}"` : s.editorId!));
  const world = new WorldService(ws);
  const cells = world
    .cells({ interiorOnly: true })
    .filter((c) => c.name)
    .sort((a, b) => Number(b.inActive) - Number(a.inActive))
    .slice(0, limit)
    .map((c) => `${c.editorId ?? c.formKey} "${c.name}"`);
  return [
    `Characters (Editor ID "Name"):\n${list(['NPC_'])}`,
    `Interior locations:\n${cells.join('\n') || '(none)'}`,
    `Voice types:\n${list(['VTYP'], (_, e) => !!e)}`,
    `Races:\n${list(['RACE'])}`,
    `Classes:\n${list(['CLAS'])}`,
    `Factions:\n${list(['FACT'])}`,
    `Outfits:\n${list(['OTFT'], (_, e) => !!e)}`,
    `Quests in your plugin (for questlines):\n${yours.join('\n') || '(none)'}`,
  ].join('\n\n');
}

export class QuestPlanner {
  private readonly send: PlannerSend;

  constructor(opts: { apiKey?: string; send?: PlannerSend; model?: string } = {}) {
    if (opts.send) this.send = opts.send;
    else {
      if (!opts.apiKey) throw new WorkspaceError('Add your Anthropic API key in Settings to plan quests with Claude');
      const client = new Anthropic({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true });
      this.send = async (params) => {
        try {
          return await client.beta.messages.stream(params).finalMessage();
        } catch (e) {
          if (e instanceof Anthropic.AuthenticationError) throw new WorkspaceError('Anthropic rejected the API key. Check it in Settings.');
          if (e instanceof Anthropic.RateLimitError) throw new WorkspaceError('Too many requests to Claude right now. Wait a minute and try again.');
          if (e instanceof Anthropic.APIConnectionError) throw new WorkspaceError("Couldn't reach Anthropic's API. Check your internet connection.");
          if (e instanceof Anthropic.APIError) throw new WorkspaceError(`Claude couldn't plan this: ${e.message}`);
          throw e;
        }
      };
    }
    this.model = opts.model ?? PLANNER_MODEL;
  }

  private readonly model: string;

  /** The request: the rules and the load order are cached; the author's text follows. */
  request(messages: BetaMessageStreamParams['messages'], catalog: string): BetaMessageStreamParams {
    return {
      model: this.model,
      max_tokens: 64000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: betaZodOutputFormat(QuestPlanSchema) },
      system: [
        { type: 'text', text: RULES },
        { type: 'text', text: `The load order (existing forms you can use):\n\n${catalog}`, cache_control: { type: 'ephemeral' } },
      ],
      messages,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    };
  }

  /** Plan a quest from a design document or a conversation. */
  async plan(source: string, mode: PlannerMode, catalog: string): Promise<QuestPlan> {
    if (!source.trim()) throw new WorkspaceError('Write or paste something to plan from');
    return this.run(this.request([{ role: 'user', content: `${MODES[mode]}\n\n<source>\n${source.trim()}\n</source>` }], catalog));
  }

  /** Change a plan as the author describes; returns the whole new plan. */
  async revise(plan: QuestPlan, feedback: string, catalog: string, source?: string): Promise<QuestPlan> {
    if (!feedback.trim()) throw new WorkspaceError('Say what to change');
    return this.run(
      this.request(
        [
          { role: 'user', content: source?.trim() ? `${MODES.document}\n\n<source>\n${source.trim()}\n</source>` : 'Plan a quest.' },
          { role: 'assistant', content: JSON.stringify(plan) },
          { role: 'user', content: `Change the plan as follows, keep everything else as it is, and return the whole plan:\n\n${feedback.trim()}` },
        ],
        catalog,
      ),
    );
  }

  /** Claude writes the journal entries and objectives in Skyrim's style. */
  async writeJournal(ctx: JournalContext, opts: { overwrite?: boolean } = {}): Promise<JournalDraft> {
    const params: BetaMessageStreamParams = {
      model: this.model,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: betaZodOutputFormat(JournalDraftSchema) },
      system: [{ type: 'text', text: JOURNAL_RULES, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: `${opts.overwrite ? 'Rewrite every journal entry and objective.' : 'Write the missing journal entries and objectives; keep the ones that are already written exactly as they are (leave them out of your answer).'}\n\n<quest>\n${JSON.stringify(ctx, null, 1)}\n</quest>`,
        },
      ],
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    };
    return this.run(params, JournalDraftSchema);
  }

  private async run<T>(params: BetaMessageStreamParams, schema: z.ZodType<T> = QuestPlanSchema as unknown as z.ZodType<T>, repair = true): Promise<T> {
    const reply = await this.send(params);
    if (reply.stop_reason === 'refusal') throw new WorkspaceError('Claude declined to plan this. Try rewording the text.');
    if (reply.stop_reason === 'max_tokens') throw new WorkspaceError('The plan got too long to finish. Try splitting the quest into smaller parts.');
    const text = reply.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    let json: unknown;
    try {
      json = normalize(JSON.parse(text));
      // Lists added to the plan format later may be left out.
      if (schema === (QuestPlanSchema as unknown) && json && typeof json === 'object' && !('events' in json)) (json as Record<string, unknown>).events = [];
      if (schema === (QuestPlanSchema as unknown) && json && typeof json === 'object' && !('startsWhen' in json)) (json as Record<string, unknown>).startsWhen = null;
      if (schema === (QuestPlanSchema as unknown) && json && typeof json === 'object' && !('failures' in json)) (json as Record<string, unknown>).failures = [];
    } catch {
      throw new WorkspaceError("Claude's answer wasn't in the expected format. Try again.");
    }
    const parsed = schema.safeParse(json);
    if (parsed.success) return parsed.data;
    const issues = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || 'plan'}: ${i.message}`);
    // One chance to fix it, told exactly what was wrong.
    if (repair)
      return this.run(
        {
          ...params,
          messages: [...params.messages, { role: 'assistant', content: text }, { role: 'user', content: `That plan doesn't match the format:\n${issues.join('\n')}\nReturn the whole corrected plan.` }],
        },
        schema,
        false,
      );
    throw new WorkspaceError(`Claude's plan was incomplete (${issues[0]}). Try again.`);
  }
}

const JournalDraftSchema = z.object({
  stages: z.array(z.object({ index: z.number().int(), journal: z.string() })),
  objectives: z.array(z.object({ index: z.number().int(), text: z.string(), shownAtStage: z.number().int(), completedAtStage: z.number().int().nullable() })),
});

const JOURNAL_RULES = `You write the quest journal and objectives for a Skyrim quest, in the style of the game's own quests.

Journal entries: written by the player in the first person and the past tense, one to three short sentences, saying what happened and what they mean to do next ("Brynja asked me to find her mother's ring. She thinks it was lost somewhere in the tavern."). No game terms (stages, aliases, triggers), no "you". The final stage of a completed quest gets a short closing entry. The opening stage is usually left empty unless the quest starts with something the player should read.
Objectives: short instructions in the imperative, at most about 50 characters, no full stop ("Find Brynja's ring", "Return the ring to Brynja"). Show each one at the stage where the task starts and complete it at the stage where it's done; use the stage number as the objective number unless the quest already has one there.
Use the names given. Only use what the quest data says; don't invent new events.`;

const ENUM_FIELDS = new Set(['sex', 'kind', 'startsWith']);

/** Lower-case the choice fields ("Female" → "female"); the format can't enforce them. */
function normalize(v: unknown, key?: string): unknown {
  if (Array.isArray(v)) return v.map((x) => normalize(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x, k)]));
  if (typeof v === 'string' && key && ENUM_FIELDS.has(key)) {
    const t = v.trim().toLowerCase();
    // Event kinds are camelCase ("moveTo").
    return PLAN_EVENT_KINDS.find((k) => k.toLowerCase() === t) ?? t;
  }
  return v;
}
