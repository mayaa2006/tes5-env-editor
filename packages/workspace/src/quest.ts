/**
 * Quest and dialogue editing as one model: stages, objectives, aliases, the
 * quest's topics and responses, and script fragments. Housekeeping the CK makes
 * you do by hand is automatic here: alias IDs, response ordering (PNAM),
 * topic info counts, branches for new topics, fragment scripts and their VMAD
 * bindings, voice file names, and the SEQ file for start-game-enabled quests.
 */
import {
  QuestFlag,
  conditionFunctionByName,
  newCondition,
  newVmad,
  parseFormKey,
  type Condition,
  type FormKey,
  type Vmad,
} from '@tes5/esp';
import { fragmentScriptName, newFragmentScript, parseFragmentSource, upsertFragment, type FragmentScript } from '@tes5/papyrus';
import { WorkspaceError, type Workspace } from './engine';
import { joinPath } from './fs';
import type { ScriptService } from './scripts';

export interface QuestAliasModel {
  kind: 'ref' | 'loc';
  id: number;
  name: string;
  flags: number;
  fillType: string;
  fill: Record<string, unknown>;
}

export interface ResponseModel {
  text: string;
  emotion: number;
  emotionValue: number;
  responseNumber: number;
  scriptNotes?: string;
}

export interface InfoModel {
  formKey: FormKey;
  editorId?: string;
  prompt?: string;
  responses: ResponseModel[];
  conditions: Condition[];
  flags: number;
  speaker?: FormKey | null;
  hasBeginFragment: boolean;
  hasEndFragment: boolean;
  linkTo: FormKey[];
}

export interface TopicModel {
  formKey: FormKey;
  editorId?: string;
  /** Player line shown in the menu. */
  text?: string;
  category: number;
  subtype: string;
  branch?: FormKey | null;
  priority: number;
  infos: InfoModel[];
}

export interface QuestModel {
  formKey: FormKey;
  editorId?: string;
  name?: string;
  flags: number;
  priority: number;
  type: number;
  stages: { index: number; flags: number; logEntries: { flags: number; text: string; fragment?: string }[] }[];
  objectives: { index: number; text: string; targets: { alias: number }[] }[];
  aliases: QuestAliasModel[];
  topics: TopicModel[];
  fragmentScript?: string;
  scripts: string[];
}

const DIALOGUE_CATEGORY_PLAYER = 0;

/** Dialogue categories / subtypes (numbers and codes as in the game data: xEdit, Mutagen). */
export const MISC_TOPICS = {
  hello: { category: 7, subtype: 79, code: 'HELO', suffix: 'Hello' },
  idle: { category: 7, subtype: 94, code: 'IDLE', suffix: 'Idle' },
  scene: { category: 2, subtype: 14, code: 'SCEN', suffix: 'Scene' },
  forcegreet: { category: 0, subtype: 1, code: 'PFGT', suffix: 'ForceGreet' },
} as const;

export class QuestService {
  constructor(
    readonly ws: Workspace,
    readonly scripts?: ScriptService,
  ) {
    ws.preSaveHooks.push((w) => this.upkeep(w));
    ws.postSaveHooks.push(async () => this.writeSeqIfNeeded());
  }

  // ---------------------------------------------------------------- reading

  quest(key: FormKey): QuestModel {
    const v = this.ws.view(key);
    if (!v || v.sig !== 'QUST') throw new WorkspaceError(`${key} is not a quest`);
    const d = v.data as Record<string, any>;
    const vm = d.scripts as Vmad | undefined;
    const fragFor = (stage: number, log: number) => (vm?.fragments?.kind === 'QUST' ? vm.fragments.fragments.find((f) => f.stage === stage && f.logEntry === log)?.fragmentName : undefined);
    return {
      formKey: key,
      editorId: v.editorId,
      name: typeof d.name === 'string' ? d.name : v.name,
      flags: d.general?.flags ?? 0,
      priority: d.general?.priority ?? 0,
      type: d.general?.type ?? 0,
      stages: (d.stages ?? []).map((s: any) => ({
        index: s.index?.index ?? 0,
        flags: s.index?.flags ?? 0,
        logEntries: (s.logEntries ?? []).map((l: any, li: number) => ({ flags: l.flags ?? 0, text: typeof l.text === 'string' ? l.text : '', fragment: fragFor(s.index?.index ?? 0, li) })),
      })),
      objectives: (d.objectives ?? []).map((o: any) => ({ index: o.index, text: typeof o.text === 'string' ? o.text : '', targets: (o.targets ?? []).map((t: any) => ({ alias: t.target?.alias ?? -1 })) })),
      aliases: (d.aliases ?? []).map((a: any) => {
        const val = a.value ?? {};
        const fill = val.fill ?? { option: -1, value: {} };
        const refFills = ['specific', 'uniqueActor', 'locationAlias', 'external', 'create', 'findMatching'];
        const locFills = ['specific', 'refAliasLocation', 'external', 'fromEvent'];
        return {
          kind: a.option === 0 ? 'ref' : 'loc',
          id: val.id,
          name: val.name,
          flags: val.flags ?? 0,
          fillType: (a.option === 0 ? refFills : locFills)[fill.option] ?? 'none',
          fill: fill.value ?? {},
        } as QuestAliasModel;
      }),
      topics: this.topics(key),
      fragmentScript: vm?.fragments?.kind === 'QUST' ? vm.fragments.fileName : undefined,
      scripts: (vm?.scripts ?? []).map((s) => s.name),
    };
  }

  /** Topics owned by the quest (QNAM), with their responses in order. */
  topics(quest: FormKey): TopicModel[] {
    const out: TopicModel[] = [];
    for (const { key, slot, record } of this.ws.winners(['DIAL'])) {
      const v = this.ws.decode(slot, record);
      const d = v.data as Record<string, any>;
      if (d.quest !== quest) continue;
      out.push({
        formKey: key,
        editorId: record.editorId,
        text: typeof d.name === 'string' ? d.name : undefined,
        category: d.data?.category ?? 0,
        subtype: d.subtypeName ?? 'CUST',
        branch: d.branch ?? null,
        priority: d.priority ?? 50,
        infos: this.infos(key),
      });
    }
    return out.sort((a, b) => (a.editorId ?? '').localeCompare(b.editorId ?? ''));
  }

  /** Responses of a topic, ordered by their PNAM chain. */
  infos(topic: FormKey): InfoModel[] {
    const items: { key: FormKey; prev: FormKey | null; model: InfoModel }[] = [];
    const seen = new Set<FormKey>();
    for (let i = this.ws.slots.length - 1; i >= 0; i--) {
      const s = this.ws.slots[i]!;
      if (!s.plugin || !s.mapper) continue;
      const local = s.mapper.toLocal(topic);
      if (local === undefined) continue;
      const dial = s.plugin.getRecord(local);
      if (!dial) continue;
      const g = s.plugin.childGroupOf(dial);
      if (!g) continue;
      for (const r of g.records) {
        const key = this.ws.keyOf(s, r.formId)!;
        if (seen.has(key)) continue;
        seen.add(key);
        const d = this.ws.decode(s, r).data as Record<string, any>;
        const vm = d.scripts as Vmad | undefined;
        const fragFlags = vm?.fragments && 'flags' in vm.fragments ? vm.fragments.flags : 0;
        items.push({
          key,
          prev: d.previousInfo ?? null,
          model: {
            formKey: key,
            editorId: r.editorId,
            prompt: typeof d.prompt === 'string' ? d.prompt : undefined,
            responses: (d.responses ?? []).map((x: any) => ({
              text: typeof x.text === 'string' ? x.text : '',
              emotion: x.data?.emotion ?? 0,
              emotionValue: x.data?.emotionValue ?? 50,
              responseNumber: x.data?.responseNumber ?? 1,
              scriptNotes: x.scriptNotes,
            })),
            conditions: (d.conditions ?? []).map((c: any) => c.data as Condition),
            flags: d.data?.flags ?? 0,
            speaker: d.speaker ?? null,
            hasBeginFragment: (fragFlags & 1) !== 0,
            hasEndFragment: (fragFlags & 2) !== 0,
            linkTo: d.linkTo ?? [],
          },
        });
      }
    }
    // Order by PNAM chain; unchained ones keep their file order.
    const byPrev = new Map<string, typeof items>();
    for (const it of items) {
      const k = it.prev ?? '';
      if (!byPrev.has(k)) byPrev.set(k, []);
      byPrev.get(k)!.push(it);
    }
    const ordered: InfoModel[] = [];
    const used = new Set<FormKey>();
    const walk = (prev: string) => {
      for (const it of byPrev.get(prev) ?? []) {
        if (used.has(it.key)) continue;
        used.add(it.key);
        ordered.push(it.model);
        walk(it.key);
      }
    };
    walk('');
    for (const it of items) if (!used.has(it.key)) ordered.push(it.model);
    return ordered;
  }

  // ---------------------------------------------------------------- creating

  createQuest(editorId: string, name: string, opts: { startGameEnabled?: boolean; runOnce?: boolean; priority?: number; type?: number } = {}): FormKey {
    let flags = 0;
    if (opts.startGameEnabled) flags |= QuestFlag.StartGameEnabled;
    if (opts.runOnce) flags |= QuestFlag.RunOnce;
    return this.ws.createRecord('QUST', {
      editorId,
      name,
      general: { flags, priority: opts.priority ?? 50, formVersion: 0, unknown: new Uint8Array(4), type: opts.type ?? 0 },
      marker: true,
      nextAliasId: 0,
    });
  }

  addStage(quest: FormKey, index: number, logText?: string, opts: { startUp?: boolean; shutDown?: boolean; completesQuest?: boolean; failsQuest?: boolean } = {}): void {
    this.ws.editRecord(
      quest,
      (d: any) => {
        d.stages ??= [];
        if (d.stages.some((s: any) => s.index?.index === index)) throw new WorkspaceError(`Stage ${index} already exists`);
        const flags = (opts.startUp ? 2 : 0) | (opts.shutDown ? 4 : 0);
        const stage: any = { index: { index, flags, unknown: 0 }, logEntries: [] };
        if (logText !== undefined || opts.completesQuest || opts.failsQuest) {
          stage.logEntries.push({ flags: (opts.completesQuest ? 1 : 0) | (opts.failsQuest ? 2 : 0), text: logText ?? '' });
        }
        d.stages.push(stage);
        d.stages.sort((a: any, b: any) => a.index.index - b.index.index);
      },
      `Add stage ${index}`,
    );
  }

  setStageLog(quest: FormKey, index: number, logIndex: number, text: string): void {
    this.ws.editRecord(
      quest,
      (d: any) => {
        const stage = d.stages?.find((s: any) => s.index?.index === index);
        if (!stage) throw new WorkspaceError(`Stage ${index} not found`);
        stage.logEntries ??= [];
        while (stage.logEntries.length <= logIndex) stage.logEntries.push({ flags: 0, text: '' });
        stage.logEntries[logIndex].text = text;
      },
      `Edit stage ${index} log`,
    );
  }

  removeStage(quest: FormKey, index: number): void {
    this.ws.editRecord(
      quest,
      (d: any) => {
        d.stages = (d.stages ?? []).filter((s: any) => s.index?.index !== index);
        const vm = d.scripts as Vmad | undefined;
        if (vm?.fragments?.kind === 'QUST') vm.fragments.fragments = vm.fragments.fragments.filter((f) => f.stage !== index);
      },
      `Remove stage ${index}`,
    );
  }

  addObjective(quest: FormKey, index: number, text: string, targetAlias?: number): void {
    this.ws.editRecord(
      quest,
      (d: any) => {
        d.objectives ??= [];
        if (d.objectives.some((o: any) => o.index === index)) throw new WorkspaceError(`Objective ${index} already exists`);
        d.objectives.push({ index, oredWithPrevious: 0, text, targets: targetAlias !== undefined ? [{ target: { alias: targetAlias, ignoresLocks: 0, unused: new Uint8Array(3) } }] : [] });
        d.objectives.sort((a: any, b: any) => a.index - b.index);
      },
      `Add objective ${index}`,
    );
  }

  /** Add a reference alias. `fill` picks how it is filled. Returns the alias ID. */
  addReferenceAlias(
    quest: FormKey,
    name: string,
    fill: { uniqueActor?: FormKey; specificReference?: FormKey; createAt?: { object: FormKey; alias: number; inside?: boolean } } = {},
    flags = 0,
  ): number {
    let id = -1;
    this.ws.editRecord(
      quest,
      (d: any) => {
        id = this.nextAliasId(d);
        const alias: any = { id, name, flags, end: true };
        if (fill.uniqueActor) alias.fill = { option: 1, value: { actor: fill.uniqueActor } };
        else if (fill.specificReference) alias.fill = { option: 0, value: { reference: fill.specificReference } };
        else if (fill.createAt) alias.fill = { option: 4, value: { object: fill.createAt.object, at: { alias: fill.createAt.alias, create: fill.createAt.inside ? 0x8000 : 0 }, level: 4 } };
        d.aliases ??= [];
        d.aliases.push({ option: 0, value: alias });
        d.nextAliasId = id + 1;
      },
      `Add alias ${name}`,
    );
    return id;
  }

  addLocationAlias(quest: FormKey, name: string, location?: FormKey, flags = 0): number {
    let id = -1;
    this.ws.editRecord(
      quest,
      (d: any) => {
        id = this.nextAliasId(d);
        const alias: any = { id, name, flags, end: true };
        if (location) alias.fill = { option: 0, value: { location } };
        d.aliases ??= [];
        d.aliases.push({ option: 1, value: alias });
        d.nextAliasId = id + 1;
      },
      `Add location alias ${name}`,
    );
    return id;
  }

  private nextAliasId(d: any): number {
    const used = (d.aliases ?? []).map((a: any) => a.value?.id ?? -1);
    return Math.max(d.nextAliasId ?? 0, ...used.map((x: number) => x + 1), 0);
  }

  /**
   * Create a player dialogue topic for a quest. Top-level topics get their own
   * branch automatically (required for them to show up in conversation).
   */
  createTopic(quest: FormKey, opts: { editorId: string; text: string; topLevel?: boolean; branch?: FormKey; priority?: number }): FormKey {
    return this.ws.transaction(`Create topic ${opts.editorId}`, () => {
      const topic = this.ws.createRecord('DIAL', {
        editorId: opts.editorId,
        name: opts.text,
        priority: opts.priority ?? 50,
        quest,
        data: { doAllBeforeRepeating: 0, category: DIALOGUE_CATEGORY_PLAYER, subtype: 0 },
        subtypeName: 'CUST',
        infoCount: 0,
      });
      let branch = opts.branch;
      if (!branch && (opts.topLevel ?? true)) {
        branch = this.ws.createRecord('DLBR', {
          editorId: `${opts.editorId}Branch`,
          quest,
          category: 0,
          flags: 1, // top-level
          startingTopic: topic,
        });
      }
      if (branch) this.ws.editRecord(topic, (d: any) => void (d.branch = branch));
      return topic;
    });
  }

  /**
   * A quest's topic for lines that aren't answers to the player: greetings
   * ("Hello", said as the player approaches or starts talking), idle chatter,
   * or one line of a scene. Greetings and chatter reuse one topic per quest.
   */
  miscTopic(quest: FormKey, kind: 'hello' | 'idle' | 'scene' | 'forcegreet', editorId?: string): FormKey {
    const def = MISC_TOPICS[kind];
    if (kind === 'hello' || kind === 'idle') {
      const existing = this.topics(quest).find((t) => t.subtype === def.code && t.category === def.category);
      if (existing) return existing.formKey;
    }
    const qid = (this.ws.view(quest)?.editorId ?? 'Quest').replace(/[^A-Za-z0-9_]/g, '');
    return this.ws.createRecord('DIAL', {
      editorId: this.ws.uniqueEditorId(editorId ?? `${qid}${def.suffix}`),
      priority: 50,
      quest,
      data: { doAllBeforeRepeating: 0, category: def.category, subtype: def.subtype },
      subtypeName: def.code,
      infoCount: 0,
    });
  }

  /** Add an NPC response to a topic; ordering and counts are maintained automatically. */
  addResponse(topic: FormKey, opts: { text: string | string[]; speaker?: FormKey; emotion?: number; goodbye?: boolean; conditions?: Condition[]; prompt?: string }): FormKey {
    return this.ws.transaction('Add response', () => {
      const existing = this.infos(topic);
      const last = existing[existing.length - 1];
      const lines = Array.isArray(opts.text) ? opts.text : [opts.text];
      const conditions = [...(opts.conditions ?? [])];
      if (opts.speaker) {
        const isId = conditionFunctionByName('GetIsID')!;
        conditions.unshift({ ...newCondition(isId.index), param1: opts.speaker, value: 1 });
      }
      const info = this.ws.createRecord(
        'INFO',
        {
          data: { flags: opts.goodbye ? 1 : 0, resetHours: 0 },
          previousInfo: last?.formKey ?? null,
          favorLevel: 0,
          responses: lines.map((text, i) => ({
            data: { emotion: opts.emotion ?? 0, emotionValue: 50, unused: new Uint8Array(4), responseNumber: i + 1, unused2: new Uint8Array(3), sound: null, useEmotionAnimation: 0, unused3: new Uint8Array(3) },
            text,
          })),
          conditions: conditions.map((c) => ({ data: c })),
          ...(opts.prompt ? { prompt: opts.prompt } : {}),
        },
        { topic },
      );
      return info;
    });
  }

  // ---------------------------------------------------------------- fragments

  private async loadFragmentScript(name: string, host: 'QUST' | 'INFO'): Promise<FragmentScript> {
    if (this.scripts?.has(name)) return parseFragmentSource(await this.scripts.read(name), host);
    return newFragmentScript(host, name);
  }

  /** Set the code that runs when a quest stage is set. Writes the QF_ script and binds it. */
  async setStageFragment(quest: FormKey, stage: number, code: string, logEntry = 0): Promise<string> {
    if (!this.scripts) throw new WorkspaceError('Script service not available');
    const v = this.ws.view(quest)!;
    const d = v.data as any;
    const vm: Vmad = (d.scripts as Vmad | undefined) ?? newVmad();
    const existingName = vm.fragments?.kind === 'QUST' ? vm.fragments.fileName : undefined;
    const name = existingName || fragmentScriptName('QUST', v.editorId, this.runtimeLikeId(quest));
    const model = await this.loadFragmentScript(name, 'QUST');
    const existing = vm.fragments?.kind === 'QUST' ? vm.fragments.fragments.find((f) => f.stage === stage && f.logEntry === logEntry) : undefined;
    const fragmentName = upsertFragment(model, code, existing?.fragmentName);
    // Alias properties for every alias, so fragments can use Alias_<Name>.
    const aliases = this.quest(quest).aliases;
    model.aliases = aliases.map((a) => ({ name: a.name, type: a.kind === 'ref' ? 'ReferenceAlias' : 'LocationAlias' }));
    await this.scripts.writeFragment(model);
    this.ws.editRecord(
      quest,
      (data: any) => {
        const vmad: Vmad = data.scripts ?? newVmad();
        if (vmad.fragments?.kind !== 'QUST') vmad.fragments = { kind: 'QUST', extraBindVersion: 2, fileName: name, fragments: [] };
        vmad.fragments.fileName = name;
        const list = vmad.fragments.fragments.filter((f) => !(f.stage === stage && f.logEntry === logEntry));
        list.push({ stage, logEntry, unknown: 1, scriptName: name, fragmentName });
        list.sort((a, b) => a.stage - b.stage || a.logEntry - b.logEntry);
        vmad.fragments.fragments = list;
        let script = vmad.scripts.find((s) => s.name.toLowerCase() === name.toLowerCase());
        if (!script) {
          script = { name, flags: 0, properties: [] };
          vmad.scripts.unshift(script);
        }
        // Bind alias properties to the quest's aliases.
        for (const a of aliases) {
          const pname = `Alias_${a.name}`;
          const prop = { name: pname, type: 1, flags: 1, value: { form: quest, alias: a.id } };
          const i = script.properties.findIndex((p) => p.name.toLowerCase() === pname.toLowerCase());
          if (i >= 0) script.properties[i] = prop;
          else script.properties.push(prop);
        }
        data.scripts = vmad;
        // Make sure the stage and log entry exist.
        data.stages ??= [];
        let st = data.stages.find((s: any) => s.index?.index === stage);
        if (!st) {
          st = { index: { index: stage, flags: 0, unknown: 0 }, logEntries: [] };
          data.stages.push(st);
          data.stages.sort((a: any, b: any) => a.index.index - b.index.index);
        }
        st.logEntries ??= [];
        while (st.logEntries.length <= logEntry) st.logEntries.push({ flags: 0, text: '' });
      },
      `Set stage ${stage} fragment`,
    );
    return name;
  }

  /** Set the begin/end fragment of a dialogue response. */
  async setInfoFragment(info: FormKey, which: 'begin' | 'end', code: string): Promise<string> {
    if (!this.scripts) throw new WorkspaceError('Script service not available');
    const v = this.ws.view(info)!;
    const vm: Vmad = ((v.data as any).scripts as Vmad | undefined) ?? newVmad();
    const existingName = vm.fragments?.kind === 'INFO' ? vm.fragments.fileName : undefined;
    const name = existingName || fragmentScriptName('INFO', v.editorId, this.runtimeLikeId(info));
    const model = await this.loadFragmentScript(name, 'INFO');
    const flag = which === 'begin' ? 1 : 2;
    const current = vm.fragments?.kind === 'INFO' ? vm.fragments : undefined;
    // Fragments are stored in flag order (begin, then end).
    const idx = current ? (flag === 1 ? 0 : (current.flags & 1) ? 1 : 0) : 0;
    const existingFrag = current && current.flags & flag ? current.fragments[idx] : undefined;
    const fragmentName = upsertFragment(model, code, existingFrag?.fragmentName);
    await this.scripts.writeFragment(model);
    this.ws.editRecord(
      info,
      (data: any) => {
        const vmad: Vmad = data.scripts ?? newVmad();
        const prev = vmad.fragments?.kind === 'INFO' ? vmad.fragments : { kind: 'INFO' as const, extraBindVersion: 2, flags: 0, fileName: name, fragments: [] };
        const begin = prev.flags & 1 ? prev.fragments[0] : undefined;
        const end = prev.flags & 2 ? prev.fragments[prev.flags & 1 ? 1 : 0] : undefined;
        const frag = { unknown: 1, scriptName: name, fragmentName };
        const nb = which === 'begin' ? frag : begin;
        const ne = which === 'end' ? frag : end;
        vmad.fragments = { kind: 'INFO', extraBindVersion: 2, flags: (nb ? 1 : 0) | (ne ? 2 : 0), fileName: name, fragments: [nb, ne].filter((x): x is NonNullable<typeof x> => !!x) };
        if (!vmad.scripts.some((s) => s.name.toLowerCase() === name.toLowerCase())) vmad.scripts.unshift({ name, flags: 0, properties: [] });
        data.scripts = vmad;
      },
      `Set ${which} fragment`,
    );
    return name;
  }

  /** The FormID used in generated script names (current load order position). */
  private runtimeLikeId(key: FormKey): number {
    return parseInt(this.ws.runtimeFormId(key), 16) >>> 0;
  }

  // ---------------------------------------------------------------- voice files

  /**
   * The voice files the game will look for, per response and voice type:
   * Sound/Voice/<Plugin>/<VoiceType>/<Quest>_<Topic>_<InfoID>_<Response>.fuz
   */
  voiceFiles(quest: FormKey): { info: FormKey; response: number; text: string; voiceTypes: string[]; fileName: string; paths: string[] }[] {
    const q = this.quest(quest);
    const out: ReturnType<QuestService['voiceFiles']> = [];
    for (const t of q.topics) {
      for (const info of t.infos) {
        const voices = this.voiceTypesFor(info);
        for (const r of info.responses) {
          const fileName = voiceFileName(q.editorId ?? '', t.editorId ?? '', info.formKey, r.responseNumber);
          const plugin = parseFormKey(info.formKey).plugin;
          out.push({
            info: info.formKey,
            response: r.responseNumber,
            text: r.text,
            voiceTypes: voices,
            fileName,
            paths: (voices.length ? voices : ['<VoiceType>']).map((vt) => `Sound/Voice/${plugin}/${vt}/${fileName}.fuz`),
          });
        }
      }
    }
    return out;
  }

  /** Voice types that can speak a response, inferred from speaker/conditions. */
  voiceTypesFor(info: InfoModel): string[] {
    const out = new Set<string>();
    const npcVoice = (npc: FormKey | null | undefined) => {
      if (!npc) return;
      const v = this.ws.view(npc);
      const vt = (v?.data as any)?.voice as FormKey | undefined;
      const e = vt ? this.ws.summary(vt)?.editorId : undefined;
      if (e) out.add(e);
    };
    npcVoice(info.speaker ?? undefined);
    const isId = conditionFunctionByName('GetIsID')!.index;
    const isVoice = conditionFunctionByName('GetIsVoiceType')!.index;
    for (const c of info.conditions) {
      if (c.function === isId && typeof c.param1 === 'string') npcVoice(c.param1 as FormKey);
      if (c.function === isVoice && typeof c.param1 === 'string') {
        const s = this.ws.summary(c.param1 as FormKey);
        if (s?.sig === 'VTYP' && s.editorId) out.add(s.editorId);
        if (s?.sig === 'FLST') {
          const forms = ((this.ws.view(c.param1 as FormKey)?.data as any)?.forms ?? []) as FormKey[];
          for (const f of forms) {
            const e = this.ws.summary(f)?.editorId;
            if (e) out.add(e);
          }
        }
      }
    }
    return [...out].sort();
  }

  // ---------------------------------------------------------------- automations

  /** Pre-save upkeep for quests/dialogue in the active plugin. */
  private upkeep(ws: Workspace): string[] {
    const warnings: string[] = [];
    const a = ws.active;
    if (!a?.plugin) return warnings;
    // Topic info counts.
    for (const dial of a.plugin.recordsOfType('DIAL')) {
      const key = ws.keyOf(a, dial.formId)!;
      const count = this.infos(key).length;
      const d = ws.view(key, a.name);
      if (!d?.lossless) continue;
      if ((d.data as any).infoCount !== count) ws.updateRecord(key, { ...d.data, infoCount: count }, { unknown: d.unknown, label: 'Update topic info count' });
    }
    // Quest alias IDs.
    for (const q of a.plugin.recordsOfType('QUST')) {
      const key = ws.keyOf(a, q.formId)!;
      const d = ws.view(key, a.name);
      if (!d?.lossless) continue;
      const next = this.nextAliasId(d.data);
      if (((d.data as any).nextAliasId ?? 0) < next) ws.updateRecord(key, { ...d.data, nextAliasId: next }, { unknown: d.unknown, label: 'Update next alias ID' });
      const flags = (d.data as any).general?.flags ?? 0;
      if (flags & QuestFlag.StartGameEnabled && this.topics(key).length && !(flags & QuestFlag.RunOnce)) {
        // fine: SEQ written after save
      }
    }
    return warnings;
  }

  /** Quests needing an entry in SEQ/<plugin>.seq: start-game enabled and owning dialogue. */
  seqQuests(): FormKey[] {
    const a = this.ws.active;
    if (!a?.plugin) return [];
    const out: FormKey[] = [];
    for (const q of a.plugin.recordsOfType('QUST')) {
      if (q.isDeleted) continue;
      const dnam = q.get('DNAM');
      const flags = dnam && dnam.data.byteLength >= 2 ? dnam.data[0]! | (dnam.data[1]! << 8) : 0;
      if (!(flags & QuestFlag.StartGameEnabled)) continue;
      const key = this.ws.keyOf(a, q.formId)!;
      if (this.topics(key).length === 0) continue;
      out.push(key);
    }
    return out;
  }

  /** Build the SEQ file bytes (file-local FormIDs, little-endian u32 each). */
  buildSeq(): Uint8Array | undefined {
    const quests = this.seqQuests();
    if (!quests.length) return undefined;
    const a = this.ws.active!;
    const out = new Uint8Array(quests.length * 4);
    const dv = new DataView(out.buffer);
    quests.forEach((k, i) => dv.setUint32(i * 4, a.mapper!.toLocal(k)!, true));
    return out;
  }

  private async writeSeqIfNeeded(): Promise<string[]> {
    const bytes = this.buildSeq();
    const a = this.ws.active;
    if (!bytes || !a) return [];
    const dir = joinPath(this.ws.options.outputDir, 'SEQ');
    await this.ws.fs.mkdir(dir);
    const path = joinPath(dir, a.name.replace(/\.(esm|esp|esl)$/i, '.seq'));
    await this.ws.fs.writeFile(path, bytes);
    return [path];
  }
}

/**
 * CK voice file naming: quest and topic EditorIDs, the INFO's FormID with a
 * zero load-order byte, and the response number. When the two IDs together
 * exceed 25 characters the quest part is cut to 10 and the topic part to 15.
 */
export function voiceFileName(questEditorId: string, topicEditorId: string, info: FormKey, responseNumber: number): string {
  let q = questEditorId;
  let t = topicEditorId;
  if (q.length + t.length > 25) {
    q = q.slice(0, 10);
    t = t.slice(0, 15);
  }
  const id = parseFormKey(info).objectId.toString(16).toUpperCase().padStart(8, '0');
  return `${q}_${t}_${id}_${responseNumber}`;
}
