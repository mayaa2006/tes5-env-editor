/**
 * The quest map: a quest as a graph of stages connected by "what makes the
 * quest move on" — talking to someone, picking something up, killing,
 * arriving somewhere, or a script. The graph is read from the real data
 * (stage scripts, dialogue scripts, trigger scripts), and every edit writes
 * real records and scripts, so the map and the plugin can never disagree.
 * Only node positions live outside the plugin (a small layout file).
 */
import { parseFragmentSource } from '@tes5/papyrus';
import { conditionFunctionByName, newCondition, newVmad, parseFormKey, type Condition, type FormKey, type Vmad } from '@tes5/esp';
import { WorkspaceError, type Workspace } from './engine';
import { joinPath } from './fs';
import { QuestFlag } from '@tes5/esp';
import type { QuestAliasModel, QuestService } from './quest';
import type { ScriptService } from './scripts';
import { newTriggerId, type TriggerEventKind, type TriggerHost, type TriggerService, type TriggerSpec } from './triggers';
import { WorldService } from './world';
import { gestureActorName, gestureCode, parseGestureLine } from './gestures';
import { formExpression } from './dialogue';

export type QuestEdgeKind = TriggerEventKind | 'talk' | 'script';

export type QuestEdgeSource =
  | { type: 'alias-trigger'; alias: number; triggerId: string }
  | { type: 'ref-trigger'; ref: FormKey; triggerId: string }
  | { type: 'info'; info: FormKey; topic: FormKey }
  | { type: 'fragment'; stage: number };

export interface QuestEdge {
  id: string;
  /** Stage the quest must be at, or null for "any time". */
  from: number | null;
  to: number;
  kind: QuestEdgeKind;
  /** Short human description ("Talk to Brynja: “Any work?”"). */
  label: string;
  /** The person/object/place involved, when there is one. */
  target?: FormKey | null;
  source: QuestEdgeSource;
}

export interface QuestStageNode {
  stage: number;
  text: string;
  startUp: boolean;
  shutDown: boolean;
  completesQuest: boolean;
  failsQuest: boolean;
  hasScript: boolean;
  /** Objectives shown / completed by this stage's script. */
  shows: number[];
  completes: number[];
  /** Animations the stage's script plays (line = the script line, to remove it). */
  gestures: { line: string; actor: string; gesture: string; label: string }[];
}

/** Something that starts a quest: the game itself, a trigger on a placed object, or another quest's stage. */
export type QuestStart =
  | { kind: 'game'; label: string }
  | { kind: 'trigger'; label: string; ref: FormKey; event: TriggerEventKind }
  | { kind: 'afterQuest'; label: string; quest: FormKey; stage: number };

/** What a quest can be started by, for "start when…" (cells, items or another quest). */
export type QuestStartWhen = { kind: 'arrive' | 'read' | 'pickup' | 'activate'; target: FormKey } | { kind: 'afterQuest'; quest: FormKey; stage: number };

export interface QuestGraph {
  quest: FormKey;
  /** The quest's time limit, if it has one (a timer script on the quest). */
  timeLimit?: { days: number; fromStage: number; failStage: number };
  /** What starts the quest. */
  starts: QuestStart[];
  editorId?: string;
  name?: string;
  startGameEnabled: boolean;
  nodes: QuestStageNode[];
  edges: QuestEdge[];
  objectives: { index: number; text: string }[];
  aliases: QuestAliasModel[];
  layout: Record<string, { x: number; y: number }>;
  /** Things that will stop the quest working in game. */
  problems: string[];
}

export type NewQuestEdge = {
  from: number | null;
  to: number;
} & (
  | { kind: 'talk'; npc: FormKey; playerText: string; npcText: string | string[]; goodbye?: boolean }
  | { kind: Exclude<TriggerEventKind, never>; target: FormKey }
  | { kind: 'script' }
);

const SET_STAGE = /\b(?:\w+\.)?SetStage\s*\(\s*(\d+)\s*\)/gi;
const OBJ = /^\s*(?:\w+\.)?SetObjective(Displayed|Completed)\s*\(\s*(\d+)\s*(?:,[^)]*)?\)\s*$/i;

export class QuestGraphService {
  constructor(
    readonly ws: Workspace,
    readonly quests: QuestService,
    readonly scripts: ScriptService,
    readonly triggers: TriggerService,
  ) {}

  // ---------------------------------------------------------------- reading

  async fragmentCode(quest: FormKey, stage: number): Promise<string> {
    const vm = (this.ws.view(quest)?.data as any)?.scripts as Vmad | undefined;
    const f = vm?.fragments?.kind === 'QUST' ? vm.fragments : undefined;
    const frag = f?.fragments.find((x) => x.stage === stage && x.logEntry === 0);
    if (!f || !frag || !this.scripts.has(f.fileName)) return '';
    return parseFragmentSource(await this.scripts.read(f.fileName), 'QUST').fragments.find((x) => x.name === frag.fragmentName)?.code ?? '';
  }

  private async infoCode(info: FormKey): Promise<string> {
    const frags = ((this.ws.view(info)?.data as any)?.scripts as Vmad | undefined)?.fragments;
    if (!frags || frags.kind !== 'INFO' || !this.scripts.has(frags.fileName)) return '';
    const parsed = parseFragmentSource(await this.scripts.read(frags.fileName), 'INFO');
    const names = new Set(frags.fragments.map((f) => f.fragmentName));
    return parsed.fragments
      .filter((f) => names.has(f.name))
      .map((f) => f.code)
      .join('\n');
  }

  /** A readable name: its name or Editor ID, or for unnamed placed objects, what they are. */
  private name(key: FormKey | null | undefined): string {
    if (!key) return 'nothing';
    const s = this.ws.summary(key);
    if (s?.name || s?.editorId) return (s.name ?? s.editorId)!;
    if (s && (s.sig === 'REFR' || s.sig === 'ACHR')) {
      const base = (this.ws.view(key)?.data as { base?: FormKey } | undefined)?.base;
      const b = base ? this.ws.summary(base) : undefined;
      if (b) return `${b.name ?? b.editorId ?? base} (${parseFormKey(key).objectId.toString(16).toUpperCase()})`;
    }
    return key;
  }

  private aliasTarget(a: QuestAliasModel): FormKey | null {
    const f = a.fill as Record<string, unknown>;
    return (f.reference ?? f.actor ?? f.location ?? f.object ?? null) as FormKey | null;
  }

  async graph(quest: FormKey): Promise<QuestGraph> {
    const q = this.quests.quest(quest);
    const edges: QuestEdge[] = [];
    const nodes: QuestStageNode[] = [];
    for (const st of q.stages) {
      const code = await this.fragmentCode(quest, st.index);
      const shows: number[] = [];
      const completes: number[] = [];
      const gestures: QuestStageNode['gestures'] = [];
      for (const line of code.split('\n')) {
        const m = OBJ.exec(line);
        if (m) (m[1]!.toLowerCase() === 'displayed' ? shows : completes).push(Number(m[2]));
        const gl = parseGestureLine(this.ws, line);
        if (gl) gestures.push({ line: line.trim(), actor: gestureActorName(gl.actor), gesture: gl.gesture.id, label: gl.gesture.label });
      }
      const le = st.logEntries[0];
      nodes.push({
        stage: st.index,
        text: le?.text ?? '',
        startUp: (st.flags & 0x02) !== 0,
        shutDown: (st.flags & 0x04) !== 0,
        completesQuest: !!le && (le.flags & 1) !== 0,
        failsQuest: !!le && (le.flags & 2) !== 0,
        hasScript: !!code.trim(),
        shows,
        completes,
        gestures,
      });
      for (const m of code.matchAll(SET_STAGE)) edges.push({ id: `frag:${st.index}:${m[1]}`, from: st.index, to: Number(m[1]), kind: 'script', label: 'Right away (stage script)', source: { type: 'fragment', stage: st.index } });
    }

    // Dialogue: responses whose scripts set a stage; the stage they need comes from a GetStage condition.
    const getStage = conditionFunctionByName('GetStage')!.index;
    for (const t of q.topics) {
      for (const info of t.infos) {
        const code = await this.infoCode(info.formKey);
        const from = info.conditions.find((c) => c.function === getStage && c.param1 === quest && c.op === '==');
        for (const m of code.matchAll(SET_STAGE)) {
          const speaker = info.conditions.find((c) => c.function === conditionFunctionByName('GetIsID')!.index)?.param1 as FormKey | undefined;
          edges.push({
            id: `info:${info.formKey}:${m[1]}`,
            from: from ? Number(from.value) : null,
            to: Number(m[1]),
            kind: 'talk',
            label: `Talk${speaker ? ` to ${this.name(speaker)}` : ''}: “${t.text ?? t.editorId ?? ''}”`,
            target: speaker ?? null,
            source: { type: 'info', info: info.formKey, topic: t.formKey },
          });
        }
      }
    }

    // Triggers on the quest's aliases and on placed objects in the active plugin.
    const starts: QuestStart[] = [];
    if ((q.flags & QuestFlag.StartGameEnabled) !== 0) starts.push({ kind: 'game', label: 'Starts with the game' });
    const fromTriggers = (spec: TriggerSpec, src: QuestEdgeSource, target: FormKey | null, where: string) => {
      // "Clear: …" — every enemy in a group dead (one edge for the whole group).
      if (src.type === 'ref-trigger' && spec.name?.startsWith('Clear: ')) {
        const own = `(${formExpression(quest)} as Quest).SetStage(`;
        for (const a of spec.actions) {
          if (a.kind !== 'custom') continue;
          const i = a.code.indexOf(own);
          if (i < 0) continue;
          const to = Number(/^(\d+)/.exec(a.code.slice(i + own.length))?.[1]);
          const cond = spec.conditions.find((c) => c.kind === 'questStage' && c.quest === quest && c.op === '==');
          const id = `clear:${spec.id}:${to}`;
          if (!edges.some((x) => x.id === id)) edges.push({ id, from: cond && cond.kind === 'questStage' ? cond.stage : null, to, kind: 'death', label: `Defeat ${spec.name.slice(7)}`, target, source: src });
        }
      }
      if (src.type === 'ref-trigger' && spec.actions.some((a) => a.kind === 'startQuest' && a.quest === quest)) {
        // Arriving is about the place, not the hidden marker that listens for it.
        const cell = spec.event.kind === 'arrive' ? this.ws.view(src.ref)?.parent.cell : undefined;
        starts.push({ kind: 'trigger', label: `${eventVerb(spec.event.kind)} ${cell ? this.name(cell) : where}`, ref: src.ref, event: spec.event.kind });
      }
      const cond = spec.conditions.find((c) => c.kind === 'questStage' && c.quest === quest && c.op === '==');
      for (const a of spec.actions) {
        if (a.kind !== 'setStage' || a.quest !== quest) continue;
        edges.push({ id: `${src.type}:${'alias' in src ? src.alias : 'ref' in src ? src.ref : ''}:${spec.id}:${a.stage}`, from: cond && cond.kind === 'questStage' ? cond.stage : null, to: a.stage, kind: spec.event.kind, label: `${eventVerb(spec.event.kind)} ${where}`, target, source: src });
      }
    };
    for (const a of q.aliases.filter((x) => x.kind === 'ref')) {
      const { specs } = await this.triggers.list({ kind: 'alias', quest, alias: a.id });
      for (const spec of specs) fromTriggers(spec, { type: 'alias-trigger', alias: a.id, triggerId: spec.id }, this.aliasTarget(a), this.name(this.aliasTarget(a)) || a.name);
    }
    const active = this.ws.active;
    if (active?.plugin) {
      for (const sig of ['REFR', 'ACHR']) {
        for (const r of active.plugin.recordsOfType(sig)) {
          if (!r.peek('VMAD')) continue;
          const key = this.ws.keyOf(active, r.formId)!;
          const { specs } = await this.triggers.list({ kind: 'ref', ref: key });
          for (const spec of specs) fromTriggers(spec, { type: 'ref-trigger', ref: key, triggerId: spec.id }, key, this.name(key));
        }
      }
    }

    for (const st of await this.startedBy(quest)) starts.push({ kind: 'afterQuest', label: `${this.name(st.quest)} reaches stage ${st.stage}`, quest: st.quest, stage: st.stage });

    const timeLimit = await this.timeLimit(quest);
    if (timeLimit) edges.push({ id: 'timelimit', from: timeLimit.fromStage, to: timeLimit.failStage, kind: 'script', label: `Time runs out (${timeLimit.days} day${timeLimit.days === 1 ? '' : 's'})`, source: { type: 'fragment', stage: timeLimit.fromStage } });

    const problems: string[] = [];
    const sge = (q.flags & QuestFlag.StartGameEnabled) !== 0;
    if (!sge && edges.some((e) => e.kind === 'talk' && e.from === null)) problems.push('Dialogue only appears while the quest is running. Turn on “Starts with the game” or start it from another quest.');
    for (const e of edges) if (!q.stages.some((s) => s.index === e.to)) problems.push(`Something sets stage ${e.to}, which doesn't exist.`);
    const reachable = new Set<number>();
    const start = nodes.filter((n) => n.startUp).map((n) => n.stage);
    if (!start.length && nodes[0]) start.push(nodes[0].stage);
    const stack = [...start];
    while (stack.length) {
      const s = stack.pop()!;
      if (reachable.has(s)) continue;
      reachable.add(s);
      for (const e of edges) if ((e.from === s || e.from === null) && !reachable.has(e.to)) stack.push(e.to);
    }
    for (const n of nodes) if (!reachable.has(n.stage)) problems.push(`Nothing leads to stage ${n.stage}.`);
    if (nodes.length && !nodes.some((n) => n.completesQuest || n.shutDown)) problems.push('No stage completes or shuts down the quest.');

    return {
      quest,
      timeLimit,
      starts,
      editorId: q.editorId,
      name: q.name,
      startGameEnabled: sge,
      nodes,
      edges,
      objectives: q.objectives.map((o) => ({ index: o.index, text: o.text })),
      aliases: q.aliases,
      layout: (await this.readLayout())[quest] ?? {},
      problems,
    };
  }

  // ---------------------------------------------------------------- editing

  private uniqueAliasName(quest: FormKey, base: string): string {
    const names = new Set(this.quests.quest(quest).aliases.map((a) => a.name.toLowerCase()));
    const clean = base.replace(/[^A-Za-z0-9_]/g, '') || 'Target';
    if (!names.has(clean.toLowerCase())) return clean;
    for (let i = 2; ; i++) if (!names.has(`${clean}${i}`.toLowerCase())) return `${clean}${i}`;
  }

  /** Reuse an alias already filled with this target, or make one. */
  aliasFor(quest: FormKey, target: FormKey): number {
    const v = this.ws.view(target);
    if (!v) throw new WorkspaceError(`${target} not found`);
    const existing = this.quests.quest(quest).aliases.find((a) => a.kind === 'ref' && this.aliasTarget(a) === target);
    if (existing) return existing.id;
    const base = v.editorId ?? (v.sig === 'NPC_' ? 'Actor' : 'Target');
    if (v.sig === 'NPC_') return this.quests.addReferenceAlias(quest, this.uniqueAliasName(quest, base), { uniqueActor: target });
    if (v.sig === 'REFR' || v.sig === 'ACHR') return this.quests.addReferenceAlias(quest, this.uniqueAliasName(quest, base), { specificReference: target });
    throw new WorkspaceError(`Pick a placed object or a character (got ${v.typeName})`);
  }

  /** "Player arrives in a cell" needs something in the cell to listen: a marker. */
  markerIn(quest: FormKey, cell: FormKey): FormKey {
    const world = new WorldService(this.ws);
    const qid = (this.ws.view(quest)?.editorId ?? 'Quest').replace(/[^A-Za-z0-9_]/g, '');
    const cid = (this.ws.view(cell)?.editorId ?? 'Cell').replace(/[^A-Za-z0-9_]/g, '');
    const want = `${qid}Arrive${cid}Marker`;
    const existing = this.ws.byEditorId(want);
    if (existing) return existing;
    const base = this.ws.byEditorId('XMarker') ?? this.ws.search({ sigs: ['STAT'], query: 'XMarker', limit: 1 }).items[0]?.formKey;
    if (!base) throw new WorkspaceError('No XMarker static found to mark the arrival point');
    const refs = world.references(cell).filter((r) => !r.deleted);
    const c = refs.reduce((acc, r) => ({ x: acc.x + r.transform.position.x / refs.length, y: acc.y + r.transform.position.y / refs.length, z: Math.min(acc.z, r.transform.position.z) }), { x: 0, y: 0, z: refs.length ? Infinity : 0 });
    const info = world.cells().find((x) => x.formKey === cell);
    if (!refs.length && info?.grid) Object.assign(c, { x: info.grid.x * 4096 + 2048, y: info.grid.y * 4096 + 2048, z: 0 });
    return world.placeReference(cell, base, { position: { x: c.x, y: c.y, z: Number.isFinite(c.z) ? c.z : 0 } }, { persistent: true, editorId: want });
  }

  /**
   * An item created inside a container when the quest starts (so it can be
   * picked up, read… and have a quest marker): its alias. The container
   * gets an alias of its own to say where.
   */
  itemInContainerAlias(quest: FormKey, item: FormKey, container: FormKey): number {
    const existing = this.quests.quest(quest).aliases.find((a) => a.kind === 'ref' && (a.fill as any).object === item);
    if (existing) return existing.id;
    const at = this.aliasFor(quest, container);
    const name = this.uniqueAliasName(quest, this.ws.view(item)?.editorId ?? 'Item');
    return this.quests.addReferenceAlias(quest, name, { createAt: { object: item, alias: at, inside: true } });
  }

  /** A connection whose trigger listens on an existing alias (e.g. an item created in a container). */
  async addAliasEdge(quest: FormKey, alias: number, e: { from: number | null; to: number; kind: Exclude<QuestEdgeKind, 'talk' | 'script'> }): Promise<void> {
    await this.ws.transactionAsync('Add connection', async () => {
      const q = this.quests.quest(quest);
      if (!q.stages.some((s) => s.index === e.to)) this.quests.addStage(quest, e.to);
      const host: TriggerHost = { kind: 'alias', quest, alias };
      const { specs } = await this.triggers.list(host);
      specs.push({
        id: newTriggerId(),
        name: `${e.from === null ? 'Any time' : `At stage ${e.from}`} → stage ${e.to}`,
        event: { kind: e.kind },
        conditions: e.from === null ? [] : [{ kind: 'questStage', quest, op: '==', stage: e.from }],
        actions: [{ kind: 'setStage', quest, stage: e.to }],
        once: true,
      });
      await this.triggers.set(host, specs);
    });
  }

  async addEdge(quest: FormKey, e: NewQuestEdge): Promise<void> {
    return this.ws.transactionAsync('Add connection', () => this.addEdgeInner(quest, e));
  }

  private async addEdgeInner(quest: FormKey, e: NewQuestEdge): Promise<void> {
    const q = this.quests.quest(quest);
    if (!q.stages.some((s) => s.index === e.to)) this.quests.addStage(quest, e.to);
    if (e.from !== null && !q.stages.some((s) => s.index === e.from)) this.quests.addStage(quest, e.from);
    if (e.kind === 'script') {
      if (e.from === null) throw new WorkspaceError('“Right away” needs a stage to start from');
      const code = await this.fragmentCode(quest, e.from);
      await this.quests.setStageFragment(quest, e.from, `${code.trim() ? `${code.trimEnd()}\n` : ''}SetStage(${e.to})`);
      return;
    }
    if (e.kind === 'talk') {
      const qid = (q.editorId ?? 'Quest').replace(/[^A-Za-z0-9_]/g, '');
      const topic = this.quests.createTopic(quest, { editorId: this.ws.uniqueEditorId(`${qid}Talk${e.to}`), text: e.playerText });
      const conditions: Condition[] = [];
      if (e.from !== null) conditions.push({ ...newCondition(conditionFunctionByName('GetStage')!.index), param1: quest, op: '==', value: e.from });
      const info = this.quests.addResponse(topic, { text: e.npcText, speaker: e.npc, goodbye: e.goodbye, conditions });
      await this.quests.setInfoFragment(info, 'end', `GetOwningQuest().SetStage(${e.to})`);
      return;
    }
    // Event triggers live on an alias that points at the target.
    let target = e.target;
    const tv = this.ws.view(target);
    if (!tv) throw new WorkspaceError(`${target} not found`);
    if (tv.sig === 'CELL') {
      if (e.kind !== 'arrive') throw new WorkspaceError('Pick an object or character for this, not a cell');
      target = this.markerIn(quest, target);
    }
    if (e.kind === 'death' && tv.sig !== 'NPC_' && tv.sig !== 'ACHR') throw new WorkspaceError('“Killed” needs a character');
    const alias = this.aliasFor(quest, target);
    const host: TriggerHost = { kind: 'alias', quest, alias };
    const { specs } = await this.triggers.list(host);
    specs.push({
      id: newTriggerId(),
      name: `${e.from === null ? 'Any time' : `At stage ${e.from}`} → stage ${e.to}`,
      event: { kind: e.kind },
      conditions: e.from === null ? [] : [{ kind: 'questStage', quest, op: '==', stage: e.from }],
      actions: [{ kind: 'setStage', quest, stage: e.to }],
      once: true,
    });
    await this.triggers.set(host, specs);
  }

  async removeEdge(quest: FormKey, edge: QuestEdge): Promise<void> {
    return this.ws.transactionAsync('Remove connection', () => this.removeEdgeInner(quest, edge));
  }

  private async removeEdgeInner(quest: FormKey, edge: QuestEdge): Promise<void> {
    const src = edge.source;
    if (src.type === 'fragment') {
      const code = await this.fragmentCode(quest, src.stage);
      const re = new RegExp(`^\\s*(?:\\w+\\.)?SetStage\\s*\\(\\s*${edge.to}\\s*\\)\\s*$`, 'im');
      await this.quests.setStageFragment(quest, src.stage, code.replace(re, '').replace(/\n{3,}/g, '\n\n').trim());
      return;
    }
    if (src.type === 'info') {
      this.ws.transaction('Remove dialogue', () => {
        this.ws.deleteRecord(src.info);
        if (!this.quests.infos(src.topic).length) {
          const branch = (this.ws.view(src.topic)?.data as any)?.branch as FormKey | undefined;
          if (parseFormKey(src.topic).plugin === this.ws.activeName) this.ws.deleteRecord(src.topic);
          if (branch && parseFormKey(branch).plugin === this.ws.activeName && (this.ws.view(branch)?.data as any)?.startingTopic === src.topic) this.ws.deleteRecord(branch);
        }
      });
      return;
    }
    const host: TriggerHost = src.type === 'alias-trigger' ? { kind: 'alias', quest, alias: src.alias } : { kind: 'ref', ref: src.ref };
    const { specs } = await this.triggers.list(host);
    await this.triggers.set(
      host,
      specs.filter((s) => s.id !== src.triggerId),
    );
  }

  /** Add lines to a stage's script (keeping what's there). */
  /**
   * Set a stage when every one of a group of placed enemies is dead: the same
   * run-once death trigger on each of them checks the others.
   */
  async addClearEdge(quest: FormKey, refs: FormKey[], e: { from: number | null; to: number; label: string }): Promise<void> {
    await this.ws.transactionAsync('Add connection', async () => {
      if (!this.quests.quest(quest).stages.some((s) => s.index === e.to)) this.quests.addStage(quest, e.to);
      const id = newTriggerId();
      const dead = refs.map((r) => `(${formExpression(r)} as Actor).IsDead()`).join(' && ');
      const code = [`If ${dead}`, `\t(${formExpression(quest)} as Quest).SetStage(${e.to})`, 'EndIf'].join('\n');
      for (const ref of refs) {
        const host: TriggerHost = { kind: 'ref', ref };
        const { specs } = await this.triggers.list(host);
        specs.push({ id, name: `Clear: ${e.label}`, event: { kind: 'death' }, conditions: e.from === null ? [] : [{ kind: 'questStage', quest, op: '==', stage: e.from }], actions: [{ kind: 'custom', code }], once: true });
        await this.triggers.set(host, specs);
      }
    });
  }

  // ---------------------------------------------------------------- failing

  /**
   * Fail the quest (set `failStage`) if `actor` dies before any of the
   * `unlessDone` stages (the endings) are reached. Shows on the map as a
   * "killed" arrow into the fail stage.
   */
  async addFailOnDeath(quest: FormKey, actor: FormKey, failStage: number, unlessDone: number[]): Promise<{ alias: number; trigger: string }> {
    return this.ws.transactionAsync('Fail if killed', async () => {
      if (!this.quests.quest(quest).stages.some((s) => s.index === failStage)) this.quests.addStage(quest, failStage);
      const v = this.ws.view(actor);
      if (v?.sig !== 'NPC_' && v?.sig !== 'ACHR') throw new WorkspaceError('Only characters can die');
      const alias = this.aliasFor(quest, actor);
      const host: TriggerHost = { kind: 'alias', quest, alias };
      const { specs } = await this.triggers.list(host);
      const id = newTriggerId();
      specs.push({
        id,
        name: `Fails if ${this.name(actor)} dies`,
        event: { kind: 'death' },
        conditions: [...new Set([...unlessDone, failStage])].map((stage) => ({ kind: 'questStageDone' as const, quest, stage, done: false })),
        actions: [{ kind: 'setStage', quest, stage: failStage }],
        once: true,
      });
      await this.triggers.set(host, specs);
      return { alias, trigger: id };
    });
  }

  /** Remove a trigger made by addFailOnDeath. */
  async removeFailOnDeath(quest: FormKey, where: { alias: number; trigger: string }): Promise<void> {
    const host: TriggerHost = { kind: 'alias', quest, alias: where.alias };
    if (!this.quests.quest(quest).aliases.some((a) => a.id === where.alias)) return;
    const { specs } = await this.triggers.list(host);
    const kept = specs.filter((sp) => sp.id !== where.trigger);
    if (kept.length !== specs.length) await this.triggers.set(host, kept);
  }

  private timerName(quest: FormKey): string {
    return `${(this.ws.view(quest)?.editorId ?? 'Quest').replace(/[^A-Za-z0-9_]/g, '')}TimeLimit`;
  }

  /**
   * Give the quest a time limit: when it reaches `fromStage` the clock starts,
   * and after `days` in-game days it fails (sets `failStage`) unless one of
   * the `unlessDone` stages was reached. A small script on the quest does the
   * waiting; null removes the time limit.
   */
  async setTimeLimit(quest: FormKey, limit: { days: number; fromStage: number; failStage: number; unlessDone: number[] } | null): Promise<void> {
    await this.ws.transactionAsync(limit ? 'Set time limit' : 'Remove time limit', async () => {
      const name = this.timerName(quest);
      const old = await this.timeLimit(quest);
      const startLine = (hours: number) => `RegisterForSingleUpdateGameTime(${hours})`;
      if (old) await this.removeStageLine(quest, old.fromStage, startLine(Math.round(old.days * 24 * 100) / 100));
      this.ws.editRecord(quest, (d: any) => {
        const vm: Vmad = d.scripts ?? newVmad();
        vm.scripts = vm.scripts.filter((x) => x.name.toLowerCase() !== name.toLowerCase());
        if (limit) vm.scripts.push({ name, flags: 0, properties: [] });
        d.scripts = vm;
      });
      if (!limit) return;
      for (const st of [limit.fromStage, limit.failStage]) if (!this.quests.quest(quest).stages.some((s) => s.index === st)) this.quests.addStage(quest, st);
      const hours = Math.round(limit.days * 24 * 100) / 100;
      const guard = [...new Set([...limit.unlessDone, limit.failStage])].map((s) => `!IsStageDone(${s})`).join(' && ');
      const source = [
        `Scriptname ${name} extends Quest`,
        `{Fails the quest when its time runs out. Made by TES5 Env Editor.}`,
        `;@studio-timelimit days=${limit.days} from=${limit.fromStage} fail=${limit.failStage}`,
        '',
        'Event OnUpdateGameTime()',
        `\tIf ${guard}`,
        `\t\tSetStage(${limit.failStage})`,
        '\tEndIf',
        'EndEvent',
        '',
      ].join('\n');
      await this.scripts.write(name, source, { undoable: true });
      await this.appendStageCode(quest, limit.fromStage, [startLine(hours)]);
    });
  }

  /** The time limit set with setTimeLimit, read back from its script. */
  async timeLimit(quest: FormKey): Promise<{ days: number; fromStage: number; failStage: number } | undefined> {
    const name = this.timerName(quest);
    const vm = (this.ws.view(quest)?.data as any)?.scripts as Vmad | undefined;
    if (!vm?.scripts.some((x) => x.name.toLowerCase() === name.toLowerCase()) || !this.scripts.has(name)) return undefined;
    const m = /;@studio-timelimit days=([\d.]+) from=(\d+) fail=(\d+)/.exec(await this.scripts.read(name));
    return m ? { days: Number(m[1]), fromStage: Number(m[2]), failStage: Number(m[3]) } : undefined;
  }

  /** The line in another quest's stage script that starts this one. */
  startLine(quest: FormKey): string {
    return `(${formExpression(quest)} as Quest).Start()`;
  }

  /** Stages of quests in your plugin whose scripts start this quest. */
  private async startedBy(quest: FormKey): Promise<{ quest: FormKey; stage: number }[]> {
    const out: { quest: FormKey; stage: number }[] = [];
    const active = this.ws.active;
    if (!active?.plugin) return out;
    const line = this.startLine(quest);
    for (const r of active.plugin.recordsOfType('QUST')) {
      if (!r.peek('VMAD')) continue;
      const other = this.ws.keyOf(active, r.formId)!;
      if (other === quest) continue;
      for (const st of this.quests.quest(other).stages) if ((await this.fragmentCode(other, st.index)).split('\n').some((l) => l.trim() === line)) out.push({ quest: other, stage: st.index });
    }
    return out;
  }

  /**
   * Start a quest when something happens: the player arrives in a cell, reads,
   * picks up or uses an object (a trigger on the placed object, which works
   * while the quest isn't running), or another quest reaches a stage (a line
   * in that stage's script). Returns where it went, to remove it again.
   */
  async addStart(quest: FormKey, when: QuestStartWhen): Promise<{ ref: FormKey } | { quest: FormKey; stage: number; line: string }> {
    return this.ws.transactionAsync('Start the quest', async () => {
      if (when.kind === 'afterQuest') {
        const line = this.startLine(quest);
        if (!this.quests.quest(when.quest).stages.some((s) => s.index === when.stage)) throw new WorkspaceError(`${this.name(when.quest)} has no stage ${when.stage}`);
        if (!(await this.fragmentCode(when.quest, when.stage)).split('\n').some((l) => l.trim() === line)) await this.appendStageCode(when.quest, when.stage, [line]);
        return { quest: when.quest, stage: when.stage, line };
      }
      let ref = when.target;
      const v = this.ws.view(ref);
      if (!v) throw new WorkspaceError(`${ref} not found`);
      if (v.sig === 'CELL') {
        if (when.kind !== 'arrive') throw new WorkspaceError('Pick an object for this, not a cell');
        ref = this.markerIn(quest, ref);
      } else if (v.sig !== 'REFR' && v.sig !== 'ACHR') throw new WorkspaceError(`Pick a placed object (got ${v.typeName})`);
      const host: TriggerHost = { kind: 'ref', ref };
      const { specs } = await this.triggers.list(host);
      specs.push({ id: newTriggerId(), name: `Start ${this.name(quest)}`, event: { kind: when.kind }, conditions: [], actions: [{ kind: 'startQuest', quest }], once: true });
      await this.triggers.set(host, specs);
      return { ref };
    });
  }

  /** Undo addStart: remove the triggers on `ref` that start this quest, or the line in the other quest's stage. */
  async removeStart(quest: FormKey, where: { ref: FormKey } | { quest: FormKey; stage: number; line: string }): Promise<void> {
    if ('line' in where) return this.removeStageLine(where.quest, where.stage, where.line);
    if (!this.ws.exists(where.ref)) return;
    const host: TriggerHost = { kind: 'ref', ref: where.ref };
    const { specs } = await this.triggers.list(host);
    const kept = specs.filter((sp) => !sp.actions.some((a) => a.kind === 'startQuest' && a.quest === quest));
    if (kept.length !== specs.length) await this.triggers.set(host, kept);
  }

  async appendStageCode(quest: FormKey, stage: number, lines: string[]): Promise<void> {
    if (!lines.length) return;
    const code = await this.fragmentCode(quest, stage);
    await this.quests.setStageFragment(quest, stage, [code.trimEnd(), ...lines].filter(Boolean).join('\n'));
  }

  /** Make a character play a gesture when the quest reaches a stage. */
  async addStageGesture(quest: FormKey, stage: number, actor: FormKey, gesture: string): Promise<void> {
    await this.ws.transactionAsync(`Stage ${stage} animation`, async () => {
      if (!this.quests.quest(quest).stages.some((s) => s.index === stage)) this.quests.addStage(quest, stage);
      const id = this.aliasFor(quest, actor);
      const alias = this.quests.quest(quest).aliases.find((a) => a.id === id)!;
      await this.appendStageCode(quest, stage, [gestureCode(this.ws, gesture, `Alias_${alias.name}.GetActorReference()`)]);
    });
  }

  /** Remove one line (e.g. a gesture) from a stage's script. */
  async removeStageLine(quest: FormKey, stage: number, line: string): Promise<void> {
    await this.ws.transactionAsync(`Stage ${stage} script`, async () => {
      const code = await this.fragmentCode(quest, stage);
      const lines = code.split('\n');
      const i = lines.findIndex((l) => l.trim() === line.trim());
      if (i < 0) return;
      lines.splice(i, 1);
      await this.quests.setStageFragment(quest, stage, lines.join('\n').trim());
    });
  }

  /** Which objectives a stage shows/completes (rewrites those lines of the stage script). */
  async setStageObjectives(quest: FormKey, stage: number, shows: number[], completes: number[]): Promise<void> {
    await this.ws.transactionAsync(`Stage ${stage} objectives`, async () => {
      const code = await this.fragmentCode(quest, stage);
      const kept = code.split('\n').filter((l) => !OBJ.test(l));
      const lines = [...shows.map((i) => `SetObjectiveDisplayed(${i})`), ...completes.map((i) => `SetObjectiveCompleted(${i})`), ...kept];
      await this.quests.setStageFragment(quest, stage, lines.join('\n').trim());
    });
  }

  setStartGameEnabled(quest: FormKey, on: boolean): void {
    this.ws.editRecord(quest, (d: any) => {
      d.general.flags = on ? d.general.flags | QuestFlag.StartGameEnabled : d.general.flags & ~QuestFlag.StartGameEnabled;
    }, on ? 'Start quest with the game' : 'Don’t start quest with the game');
  }

  // ---------------------------------------------------------------- layout (editor-only)

  private layoutPath(): string {
    return joinPath(this.ws.options.outputDir, 'TES5EnvEditor', `${this.ws.activeName ?? 'layout'}.layout.json`);
  }

  private async readLayout(): Promise<Record<string, Record<string, { x: number; y: number }>>> {
    try {
      return JSON.parse(new TextDecoder().decode(await this.ws.fs.readFile(this.layoutPath())));
    } catch {
      return {};
    }
  }

  async saveLayout(quest: FormKey, layout: Record<string, { x: number; y: number }>): Promise<void> {
    const all = await this.readLayout();
    all[quest] = layout;
    await this.ws.fs.mkdir(joinPath(this.ws.options.outputDir, 'TES5EnvEditor'));
    await this.ws.fs.writeFile(this.layoutPath(), new TextEncoder().encode(JSON.stringify(all, null, 1)));
  }
}

export function eventVerb(kind: QuestEdgeKind): string {
  switch (kind) {
    case 'talk':
      return 'Talk to';
    case 'activate':
      return 'Use';
    case 'pickup':
      return 'Pick up';
    case 'drop':
      return 'Drop / hand over';
    case 'death':
      return 'Kill';
    case 'hit':
      return 'Hit';
    case 'arrive':
      return 'Arrive at';
    case 'load':
      return 'See';
    case 'equip':
      return 'Equip';
    case 'read':
      return 'Read';
    case 'script':
      return 'Right away';
  }
}
