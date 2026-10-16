/**
 * The AI workspace's tools for changing dialogue that already exists: the
 * lines of a quest with their ids, then rewording a line, its delivery,
 * when it can be said, what it does to the quest, ending the conversation,
 * or removing it. They use the same plain-words rules as the Dialogue tab
 * (one ordinary condition for "when", one SetStage line for "after").
 */
import { z } from 'zod';
import { EMOTIONS, isFormKey, type FormKey } from '@tes5/esp';
import { WorkspaceError, type AgentTool } from '@tes5/workspace';
import type { EngineHost } from './host';
import { readSetsStage, readWhen, writeSetsStage, writeWhen, type Item, type When } from '../views/quest/stageConditions';
import type { QuestToolContext } from './aitools-quest';

const EMOTION_NAMES = Object.values(EMOTIONS).map((e) => e.toLowerCase());

function whenText(w: When): string {
  switch (w.kind) {
    case 'always':
      return 'any time';
    case 'at':
      return `only at stage ${w.stage}`;
    case 'from':
      return `from stage ${w.stage} on`;
    case 'before':
      return `before stage ${w.stage}`;
    case 'thisDone':
      return 'after the quest is completed';
    case 'otherDone':
      return `after ${w.quest} is completed`;
    default:
      return 'set by several conditions (see the Dialogue tab)';
  }
}

export function dialogueTools(host: EngineHost, ctx: QuestToolContext): AgentTool<any>[] {
  const ws = () => {
    if (!host.ws) throw new WorkspaceError('No game data is open');
    return host.ws;
  };
  const record = (ref: string, sig: 'INFO' | 'DIAL' | 'QUST'): FormKey => {
    const r = ref.trim();
    const key = (isFormKey(r) ? r : ws().byEditorId(r)) as FormKey | undefined;
    const v = key ? ws().view(key) : undefined;
    if (!key || v?.sig !== sig) throw new WorkspaceError(`${r} isn't ${sig === 'INFO' ? 'a dialogue line (response)' : sig === 'DIAL' ? 'a player line (topic)' : 'a quest'}. Use the ids from list_dialogue_lines.`);
    return key;
  };
  /** The quest a line belongs to (its topic's quest). */
  const questOfInfo = (info: FormKey): FormKey => {
    const topic = ws().view(info)?.parent?.topic;
    const quest = topic ? ((ws().view(topic)?.data as { quest?: FormKey } | undefined)?.quest ?? null) : null;
    if (!quest) throw new WorkspaceError(`Can't tell which quest ${info} belongs to`);
    return quest;
  };
  const name = (k: FormKey | null | undefined) => (k ? (ws().summary(k)?.name || ws().summary(k)?.editorId || k) : undefined);
  const link = (quest: FormKey) => ({ tab: 'quest' as const, key: quest, label: `${ws().summary(quest)?.editorId ?? quest}'s dialogue` });

  return [
    {
      name: 'list_dialogue_lines',
      group: 'read',
      writes: false,
      description:
        "A quest's dialogue line by line, with the ids needed to change it: each player line (topic id) and the answers to it (line ids), who says them, their words, when they can be said, which stage they move the quest to, and whether they end the conversation.",
      input: z.object({ quest: z.string().describe('Editor ID or FormKey of the quest') }),
      summary: (i) => `List the dialogue lines of ${i.quest}`,
      run: async (i) => {
        const quest = record(i.quest, 'QUST');
        const q = host.quest(quest);
        const topics = [];
        for (const t of q.topics) {
          const lines = [];
          for (const info of t.infos) {
            const conditions = ((ws().view(info.formKey)?.data as { conditions?: Item[] } | undefined)?.conditions ?? []) as Item[];
            const end = await host.infoFragment(info.formKey, 'end').catch(() => '');
            lines.push({
              id: info.formKey,
              speaker: name(info.speaker),
              says: info.responses.map((r) => r.text),
              emotion: EMOTIONS[info.responses[0]?.emotion ?? 0]?.toLowerCase(),
              when: whenText(readWhen(conditions, quest).when),
              movesQuestTo: readSetsStage(end) ?? undefined,
              endsConversation: (info.flags & 1) !== 0 || undefined,
            });
          }
          topics.push({ topic: t.formKey, editorId: t.editorId, playerSays: t.text || (t.subtype === 'HELO' ? '(greeting)' : t.subtype === 'IDLE' ? '(idle chatter)' : '(no player line)'), lines });
        }
        return { data: { quest: q.editorId, topics }, link: link(quest) };
      },
    },
    {
      name: 'edit_dialogue_line',
      group: 'quest',
      writes: true,
      description:
        "Change an existing answer line (id from list_dialogue_lines): its words (a list for several lines said in a row), its emotion, when it can be said (any time, only at a stage, from a stage on, before a stage, after the quest is completed), which stage it moves the quest to afterwards (null for none), and whether it ends the conversation. Only what you give changes; the rest of its conditions and script stay.",
      input: z.object({
        line: z.string().describe('The line id (an INFO FormKey)'),
        says: z.array(z.string()).min(1).nullable().optional(),
        emotion: z.enum(EMOTION_NAMES as [string, ...string[]]).nullable().optional(),
        when: z.object({ kind: z.enum(['always', 'at', 'from', 'before', 'thisDone']), stage: z.number().int().nullable().optional() }).nullable().optional(),
        movesQuestTo: z.number().int().nullable().optional().describe('A stage; null to stop it moving the quest. Leave out to keep it as it is'),
        endsConversation: z.boolean().nullable().optional(),
      }),
      summary: (i) => `Change the line ${i.line}`,
      run: async (i) => {
        const info = record(i.line, 'INFO');
        const quest = questOfInfo(info);
        ctx.touched.add(quest);
        if (i.when && i.when.kind !== 'always' && i.when.kind !== 'thisDone' && typeof i.when.stage !== 'number') throw new WorkspaceError(`“${i.when.kind}” needs a stage`);
        const emotion = i.emotion ? EMOTION_NAMES.indexOf(i.emotion.toLowerCase()) : null;
        ws().editRecord(
          info,
          (d: any) => {
            if (i.says) {
              const template = d.responses?.[0]?.data ?? { emotion: 0, emotionValue: 50, unused: new Uint8Array(4), responseNumber: 1, unused2: new Uint8Array(3), sound: null, useEmotionAnimation: 0, unused3: new Uint8Array(3) };
              d.responses = i.says.map((text: string, n: number) => ({ ...(d.responses?.[n] ?? {}), data: { ...(d.responses?.[n]?.data ?? template), responseNumber: n + 1 }, text }));
            }
            if (emotion !== null && emotion >= 0) for (const r of d.responses ?? []) r.data = { ...r.data, emotion };
            if (i.when) d.conditions = writeWhen(d.conditions ?? [], quest, (i.when.kind === 'always' || i.when.kind === 'thisDone' ? { kind: i.when.kind } : { kind: i.when.kind, stage: i.when.stage! }) as When);
            if (typeof i.endsConversation === 'boolean') d.data = { ...(d.data ?? {}), flags: ((d.data?.flags ?? 0) & ~1) | (i.endsConversation ? 1 : 0) };
          },
          'Edit dialogue line',
        );
        if (i.movesQuestTo !== undefined) {
          const code = await host.infoFragment(info, 'end').catch(() => '');
          await host.setInfoFragment(info, 'end', writeSetsStage(code, i.movesQuestTo));
        }
        return { data: { line: info, problems: await host.lintDialogue(quest) }, link: link(quest) };
      },
    },
    {
      name: 'edit_player_line',
      group: 'quest',
      writes: true,
      description: 'Reword what the player says (a topic id from list_dialogue_lines). Keep it short: it is shown in the dialogue menu.',
      input: z.object({ topic: z.string(), says: z.string().min(1) }),
      summary: (i) => `Reword the player line ${i.topic}`,
      run: (i) => {
        const topic = record(i.topic, 'DIAL');
        ws().editRecord(topic, (d: any) => void (d.name = i.says), 'Edit player line');
        const quest = (ws().view(topic)?.data as { quest?: FormKey } | undefined)?.quest;
        if (quest) ctx.touched.add(quest);
        return { data: 'Done.', ...(quest ? { link: link(quest) } : {}) };
      },
    },
    {
      name: 'remove_dialogue',
      group: 'quest',
      writes: true,
      description: 'Remove an answer line (line id), or a player line with all its answers (topic id). Lines from other plugins are reverted or disabled instead of deleted.',
      input: z.object({ id: z.string().describe('A line id (INFO) or topic id (DIAL)') }),
      summary: (i) => `Remove the dialogue ${i.id}`,
      run: async (i) => {
        const r = i.id.trim();
        const key = (isFormKey(r) ? r : ws().byEditorId(r)) as FormKey | undefined;
        const sig = key ? ws().view(key)?.sig : undefined;
        if (!key || (sig !== 'INFO' && sig !== 'DIAL')) throw new WorkspaceError(`${i.id} isn't a dialogue line or topic. Use the ids from list_dialogue_lines.`);
        const quest = sig === 'INFO' ? questOfInfo(key) : (ws().view(key)?.data as { quest?: FormKey } | undefined)?.quest;
        const how = host.deleteRecord(key);
        if (quest) ctx.touched.add(quest);
        return { data: { removed: i.id, how, ...(quest ? { problems: await host.lintDialogue(quest) } : {}) }, ...(quest ? { link: link(quest) } : {}) };
      },
    },
  ];
}
