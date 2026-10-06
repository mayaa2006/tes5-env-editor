/**
 * Dialogue as a graph (player lines → NPC responses → player choices …) and
 * a screenplay importer that turns a written conversation into topics,
 * responses, branches, conditions and stage scripts.
 *
 *   PLAYER: Got any work?
 *   BRYNJA: A crate of mead went missing.
 *   BRYNJA: Find it and I'll pay you.
 *     PLAYER: I'll look into it. [stage 10]
 *       BRYNJA: Thank you! [goodbye]
 *     PLAYER: Not interested.
 *       BRYNJA: Suit yourself. [goodbye]
 *
 * Indentation nests choices under the response above them. Tags:
 * [goodbye] ends the conversation, [stage N] sets a quest stage when the
 * line has been said, [if stage N] only offers it at that stage,
 * [emotion happy] sets the emotion, [gives Item x2] / [takes Item x1] move
 * items between the speaker and the player (Item is an Editor ID or name;
 * "gold" means gold coins).
 */
import { EMOTIONS, conditionFunctionByName, newCondition, parseFormKey, type Condition, type FormKey } from '@tes5/esp';
import { WorkspaceError, type Workspace } from './engine';
import type { QuestService } from './quest';

export interface DialogueTopicNode {
  formKey: FormKey;
  editorId?: string;
  text: string;
  topLevel: boolean;
  branch: FormKey | null;
}

export interface DialogueInfoNode {
  formKey: FormKey;
  topic: FormKey;
  speaker: FormKey | null;
  lines: string[];
  goodbye: boolean;
  /** Stage this response requires (GetStage == N), if any. */
  needsStage: number | null;
  conditionCount: number;
  choices: FormKey[];
}

export interface DialogueGraph {
  quest: FormKey;
  topics: DialogueTopicNode[];
  infos: DialogueInfoNode[];
}

// ------------------------------------------------------------------ screenplay parsing

export interface ScriptPlayerLine {
  kind: 'player';
  line: number;
  indent: number;
  text: string;
  tags: Record<string, string>;
  responses: ScriptNpcBlock[];
}

export interface ScriptNpcBlock {
  kind: 'npc';
  line: number;
  indent: number;
  speaker: string;
  lines: string[];
  tags: Record<string, string>;
  choices: ScriptPlayerLine[];
}

export interface ParsedScreenplay {
  topics: ScriptPlayerLine[];
  errors: { line: number; message: string }[];
  speakers: string[];
}

const PLAYER_NAMES = new Set(['player', 'you', 'p', 'pc']);
const ANY_SPEAKER = new Set(['npc', 'any', 'anyone', '?']);

function parseTags(text: string): { text: string; tags: Record<string, string> } {
  const tags: Record<string, string> = {};
  const clean = text
    .replace(/\[([a-z]+)(?:\s+([^\]]*))?\]/gi, (_, k: string, v?: string) => {
      tags[k.toLowerCase()] = (v ?? '').trim();
      return '';
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { text: clean, tags };
}

export function parseScreenplay(source: string): ParsedScreenplay {
  const topics: ScriptPlayerLine[] = [];
  const errors: ParsedScreenplay['errors'] = [];
  const speakers = new Set<string>();
  const players: ScriptPlayerLine[] = [];
  const npcs: ScriptNpcBlock[] = [];
  source.split(/\r?\n/).forEach((raw, i) => {
    const lineNo = i + 1;
    if (!raw.trim() || raw.trim().startsWith('#') || raw.trim().startsWith('//')) return;
    const indent = raw.replace(/\t/g, '    ').search(/\S/);
    const m = /^\s*([^:]{1,60}?)\s*:\s*(.*)$/.exec(raw);
    if (!m) {
      errors.push({ line: lineNo, message: 'Expected “NAME: line” (for example “PLAYER: Hello”)' });
      return;
    }
    const who = m[1]!.trim();
    const { text, tags } = parseTags(m[2]!);
    if (!text && !Object.keys(tags).length) {
      errors.push({ line: lineNo, message: 'Empty line of dialogue' });
      return;
    }
    if (PLAYER_NAMES.has(who.toLowerCase())) {
      const node: ScriptPlayerLine = { kind: 'player', line: lineNo, indent, text, tags, responses: [] };
      if (indent === 0) topics.push(node);
      else {
        const parent = [...npcs].reverse().find((n) => n.indent < indent);
        if (!parent) {
          errors.push({ line: lineNo, message: 'This choice is indented but there is no NPC line above it to answer' });
          return;
        }
        parent.choices.push(node);
      }
      players.push(node);
      return;
    }
    speakers.add(who);
    const parent = [...players].reverse().find((p) => p.indent <= indent);
    if (!parent) {
      errors.push({ line: lineNo, message: 'An NPC line needs a PLAYER line before it (greetings are not supported yet)' });
      return;
    }
    // Consecutive lines by the same speaker (no choices in between) form one response.
    const last = parent.responses[parent.responses.length - 1];
    if (last && last.speaker.toLowerCase() === who.toLowerCase() && !last.choices.length && last.indent === indent) {
      if (text) last.lines.push(text);
      Object.assign(last.tags, tags);
      return;
    }
    const block: ScriptNpcBlock = { kind: 'npc', line: lineNo, indent, speaker: who, lines: text ? [text] : [], tags, choices: [] };
    parent.responses.push(block);
    npcs.push(block);
  });
  const walk = (p: ScriptPlayerLine) => {
    if (!p.responses.length) errors.push({ line: p.line, message: `Nobody answers “${p.text}”` });
    for (const r of p.responses) {
      if (!r.lines.length) errors.push({ line: r.line, message: `${r.speaker} has no line to say` });
      r.choices.forEach(walk);
    }
  };
  topics.forEach(walk);
  if (!topics.length && !errors.length) errors.push({ line: 1, message: 'Start with a PLAYER line' });
  return { topics, errors, speakers: [...speakers] };
}

// ------------------------------------------------------------------ service

export class DialogueService {
  constructor(
    readonly ws: Workspace,
    readonly quests: QuestService,
  ) {}

  private isTopLevel(topic: FormKey, branch: FormKey | null): boolean {
    if (!branch) return false;
    const b = this.ws.view(branch)?.data as { flags?: number; startingTopic?: FormKey } | undefined;
    return !!b && (b.flags ?? 0) & 1 ? b.startingTopic === topic : false;
  }

  graph(quest: FormKey): DialogueGraph {
    const getStage = conditionFunctionByName('GetStage')!.index;
    const getIsId = conditionFunctionByName('GetIsID')!.index;
    const topics: DialogueTopicNode[] = [];
    const infos: DialogueInfoNode[] = [];
    for (const t of this.quests.topics(quest)) {
      topics.push({ formKey: t.formKey, editorId: t.editorId, text: t.text ?? '', topLevel: this.isTopLevel(t.formKey, t.branch ?? null), branch: t.branch ?? null });
      for (const i of t.infos) {
        const need = i.conditions.find((c) => c.function === getStage && c.param1 === quest && c.op === '==');
        infos.push({
          formKey: i.formKey,
          topic: t.formKey,
          speaker: (i.conditions.find((c) => c.function === getIsId)?.param1 as FormKey | undefined) ?? i.speaker ?? null,
          lines: i.responses.map((r) => r.text),
          goodbye: (i.flags & 1) !== 0,
          needsStage: need ? Number(need.value) : null,
          conditionCount: i.conditions.length,
          choices: [...i.linkTo],
        });
      }
    }
    return { quest, topics, infos };
  }

  private topicId(quest: FormKey, text: string): string {
    const q = (this.ws.view(quest)?.editorId ?? 'Quest').replace(/[^A-Za-z0-9_]/g, '');
    const words = text
      .replace(/[^A-Za-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4)
      .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
      .join('');
    return this.ws.uniqueEditorId(`${q}${words || 'Topic'}`);
  }

  /** A player choice offered after a response (a linked topic in the same branch). */
  addChoice(info: FormKey, text: string): FormKey {
    const v = this.ws.view(info);
    if (!v || v.sig !== 'INFO') throw new WorkspaceError(`${info} is not a dialogue response`);
    const parentTopic = v.parent.topic!;
    const td = this.ws.view(parentTopic)!.data as { quest?: FormKey; branch?: FormKey };
    return this.ws.transaction('Add player choice', () => {
      const topic = this.quests.createTopic(td.quest!, { editorId: this.topicId(td.quest!, text), text, topLevel: false, branch: td.branch });
      this.ws.editRecord(info, (d: any) => {
        d.linkTo = [...(d.linkTo ?? []), topic];
      });
      return topic;
    });
  }

  /** Offer an existing topic as a choice after a response (or stop offering it). */
  setChoice(info: FormKey, topic: FormKey, linked: boolean): void {
    this.ws.editRecord(
      info,
      (d: any) => {
        const list: FormKey[] = (d.linkTo ?? []).filter((t: FormKey) => t !== topic);
        if (linked) list.push(topic);
        d.linkTo = list;
      },
      linked ? 'Link player choice' : 'Unlink player choice',
    );
  }

  /** "Ring x2" / "gold x100" / "MyRing" → the item and how many. */
  private itemTag(value: string, line: number): { item: FormKey; count: number } {
    const m = /^(.*?)(?:\s*[x×]\s*(\d+))?$/i.exec(value.trim());
    const name = (m?.[1] ?? '').trim();
    const count = m?.[2] ? Number(m[2]) : 1;
    if (!name) throw new WorkspaceError(`Line ${line}: say which item, e.g. [gives gold x100]`);
    const item = resolveItem(this.ws, name);
    if (!item) throw new WorkspaceError(`Line ${line}: no item called “${name}” (use its Editor ID or name)`);
    return { item, count };
  }

  private resolveSpeakers(names: string[]): Map<string, FormKey | null> {
    const npcs = this.ws.search({ sigs: ['NPC_'], limit: 100000 }).items;
    const out = new Map<string, FormKey | null>();
    const unknown: string[] = [];
    for (const n of names) {
      const l = n.toLowerCase();
      if (ANY_SPEAKER.has(l)) {
        out.set(l, null);
        continue;
      }
      const exact = npcs.filter((x) => x.editorId?.toLowerCase() === l || x.name?.toLowerCase() === l);
      const hit = exact.find((x) => parseFormKey(x.formKey).plugin === this.ws.activeName) ?? exact[0];
      if (hit) out.set(l, hit.formKey);
      else unknown.push(n);
    }
    if (unknown.length) throw new WorkspaceError(`Unknown speaker${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Use a character’s name or Editor ID, or NPC for anyone.`);
    return out;
  }

  /**
   * Create a whole conversation from a screenplay. Everything is one undo
   * step; stage scripts are written through `setInfoFragment`.
   */
  async importScreenplay(quest: FormKey, source: string, setInfoFragment: (info: FormKey, code: string) => Promise<unknown>): Promise<{ topics: number; responses: number }> {
    const parsed = parseScreenplay(source);
    if (parsed.errors.length) throw new WorkspaceError(parsed.errors.map((e) => `Line ${e.line}: ${e.message}`).join('\n'));
    const speakers = this.resolveSpeakers(parsed.speakers);
    const getStage = conditionFunctionByName('GetStage')!.index;
    let topics = 0;
    let responses = 0;
    const emotionIndex = (name?: string) => {
      if (!name) return 0;
      const i = Object.entries(EMOTIONS).find(([, v]) => v.toLowerCase() === name.toLowerCase())?.[0];
      return i === undefined ? 0 : Number(i);
    };
    const stageTag = (v: string | undefined, line: number): number | undefined => {
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw new WorkspaceError(`Line ${line}: [stage …] needs a number`);
      return n;
    };
    // Choices under a response gated on a stage are only offered at that stage, so they inherit it.
    const makeTopic = async (p: ScriptPlayerLine, branch: FormKey | undefined, inherited?: number): Promise<FormKey> => {
      const topic = this.quests.createTopic(quest, { editorId: this.topicId(quest, p.text), text: p.text, topLevel: !branch, branch });
      topics++;
      const myBranch = branch ?? ((this.ws.view(topic)!.data as { branch?: FormKey }).branch as FormKey);
      const ifStage = stageTag(p.tags.if?.replace(/^stage\s+/i, ''), p.line) ?? inherited;
      for (const r of p.responses) {
        const conditions: Condition[] = [];
        const need = stageTag((r.tags.if ?? p.tags.if)?.replace(/^stage\s+/i, ''), r.line) ?? ifStage;
        if (need !== undefined) conditions.push({ ...newCondition(getStage), param1: quest, op: '==', value: need });
        const speaker = speakers.get(r.speaker.toLowerCase()) ?? undefined;
        const info = this.quests.addResponse(topic, { text: r.lines, speaker: speaker ?? undefined, goodbye: 'goodbye' in r.tags, emotion: emotionIndex(r.tags.emotion), conditions });
        responses++;
        const stage = stageTag(r.tags.stage ?? p.tags.stage, r.line);
        // Everything the line does when said goes into one end fragment.
        const code: string[] = [];
        if (stage !== undefined) code.push(`GetOwningQuest().SetStage(${stage})`);
        for (const [tag, verb] of [
          ['gives', 'AddItem'],
          ['takes', 'RemoveItem'],
        ] as const) {
          const v = r.tags[tag];
          if (v === undefined) continue;
          const { item, count } = this.itemTag(v, r.line);
          code.push(`Game.GetPlayer().${verb}(${formExpression(item)}, ${count})`);
        }
        if (code.length) await setInfoFragment(info, code.join('\n'));
        const children: FormKey[] = [];
        for (const c of r.choices) children.push(await makeTopic(c, myBranch, need));
        if (children.length) this.ws.editRecord(info, (d: any) => void (d.linkTo = [...(d.linkTo ?? []), ...children]));
      }
      return topic;
    };
    await this.ws.transactionAsync('Import dialogue', async () => {
      for (const t of parsed.topics) await makeTopic(t, undefined);
    });
    return { topics, responses };
  }

  /** The screenplay for a quest's existing dialogue (so it can be edited as text and re-imported). */
  toScreenplay(quest: FormKey): string {
    const g = this.graph(quest);
    const out: string[] = [];
    const nameOf = (k: FormKey | null) => {
      if (!k) return 'NPC';
      const s = this.ws.summary(k);
      return (s?.name && !/[:[\]]/.test(s.name) ? s.name : s?.editorId) ?? 'NPC';
    };
    const seen = new Set<FormKey>();
    // Player lines at level*4 spaces; responses under nested choices 2 deeper (top level: 0).
    const writeTopic = (t: DialogueTopicNode, level: number) => {
      const pad = ' '.repeat(level * 4);
      if (seen.has(t.formKey)) {
        out.push(`${pad}# (links back to “${t.text}”)`);
        return;
      }
      seen.add(t.formKey);
      out.push(`${pad}PLAYER: ${t.text}`);
      const npcPad = level === 0 ? '' : ' '.repeat(level * 4 + 2);
      for (const i of g.infos.filter((x) => x.topic === t.formKey)) {
        const tags = `${i.goodbye ? ' [goodbye]' : ''}${i.needsStage !== null ? ` [if stage ${i.needsStage}]` : ''}`;
        i.lines.forEach((l, n) => out.push(`${npcPad}${nameOf(i.speaker)}: ${l}${n === i.lines.length - 1 ? tags : ''}`));
        for (const c of i.choices) {
          const ct = g.topics.find((x) => x.formKey === c);
          if (ct) writeTopic(ct, level + 1);
        }
      }
    };
    for (const t of g.topics.filter((x) => x.topLevel)) writeTopic(t, 0);
    return `${out.join('\n')}\n`;
  }
}

const ITEM_SIGS = ['MISC', 'BOOK', 'KEYM', 'WEAP', 'ARMO', 'ALCH', 'INGR', 'AMMO', 'SLGM', 'SCRL'];

/** An item by Editor ID or name ("gold" is the game's gold coins). */
export function resolveItem(ws: Workspace, name: string): FormKey | undefined {
  const l = name.toLowerCase();
  if (l === 'gold' || l === 'gold001' || l === 'septims') return ws.byEditorId('Gold001') ?? ('00000F:Skyrim.esm' as FormKey);
  const byId = ws.byEditorId(name);
  if (byId && ITEM_SIGS.includes(ws.summary(byId)?.sig ?? '')) return byId;
  const hits = ws.search({ sigs: ITEM_SIGS, query: name, limit: 50 }).items.filter((i) => i.editorId?.toLowerCase() === l || i.name?.toLowerCase() === l);
  return (hits.find((h) => h.inActive) ?? hits[0])?.formKey;
}

/** Papyrus that finds a form without a script property (works for any plugin). */
export function formExpression(key: FormKey): string {
  const { objectId, plugin } = parseFormKey(key);
  return `Game.GetFormFromFile(0x${objectId.toString(16).toUpperCase().padStart(6, '0')}, "${plugin}")`;
}
