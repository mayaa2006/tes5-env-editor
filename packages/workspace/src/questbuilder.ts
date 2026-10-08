/**
 * Builds a whole quest from a plan (questplan.ts): characters, places and
 * items (found in the load order or made new), the quest with its stages,
 * journal and objectives, what moves it from stage to stage (triggers on
 * aliases), the conversations (through the screenplay importer) and the
 * rewards. It's one undo step; if anything fails, nothing is left behind.
 */
import { FACE_MORPHS, QuestFlag, RecordFlags, parseFormKey, type FormKey } from '@tes5/esp';
import { joinPath } from './fs';
import { WorkspaceError, type Workspace } from './engine';
import { CharacterEditor } from './characteredit';
import { ITEM_SIGS, formExpression, resolveItem, type DialogueService } from './dialogue';
import { rng, type EnvironmentService } from './environment';
import { emptyMorphs, FEMALE_FLAG, type NpcService } from './npc';
import type { QuestService } from './quest';
import type { NewQuestEdge, QuestGraphService } from './questgraph';
import { lintQuestDialogue } from './dialoguelint';
import { Placer } from './placement';
import { createPackage, stageConditions, type PackageSpec } from './routines';
import { normalizePlan, validatePlan, type PlanCharacter, type PlanEncounter, type PlanEvent, type PlanItem, type PlanLocation, type PlanStep, type QuestPlan } from './questplan';
import { WorldService } from './world';
import { generateCellNavmesh } from './automations';

const ESSENTIAL = 0x2;
const UNIQUE = 0x20;
const ITEM_TEMPLATE_SIG: Record<PlanItem['kind'], string> = { misc: 'MISC', other: 'MISC', book: 'BOOK', key: 'KEYM', gold: 'MISC', clothing: 'ARMO', armor: 'ARMO', weapon: 'WEAP', potion: 'ALCH' };

export type PlanEntryKind = 'character' | 'location' | 'item';

/** How each plan entry will be (or was) made: found in the load order, or new. */
export interface PlanResolution {
  kind: PlanEntryKind;
  key: string;
  name: string;
  /** The existing form it uses, when there is one. */
  existing: FormKey | null;
  /** What it's copied from, for new characters and items. */
  template: FormKey | null;
  /** Readable summary ("Uses Brynja (DemoInnkeeper)", "New, copied from Town Guard"). */
  text: string;
  /** For characters: what will change about them ("wears Fine Clothes", "joins Townsfolk"). */
  changes?: string[];
  error?: string;
}

export interface QuestBuildReport {
  /** The quest, or null for a plan that only changes characters, places and items. */
  quest: FormKey | null;
  editorId: string;
  created: { kind: PlanEntryKind | 'quest' | 'placed' | 'outfit' | 'package' | 'role'; formKey: FormKey; label: string }[];
  /** Existing characters that were changed. */
  changed: { formKey: FormKey; label: string; changes: string[] }[];
  reused: { kind: PlanEntryKind; formKey: FormKey; label: string }[];
  dialogue: { topics: number; responses: number; greetings: number; scenes: number };
  /** For updates: what was changed, in words. */
  updated: string[];
  /** Things worth knowing (what was assumed or left for you). */
  notes: string[];
  /** Things that may not work as the plan intended. */
  warnings: string[];
  /** Problems the quest map finds in the result. */
  problems: string[];
}

/** What a build made, kept next to the plugin so a revised plan can update the quest. */
export interface BuildRecord {
  version: 1;
  quest: FormKey;
  prefix: string;
  plan: QuestPlan;
  cells: Record<string, FormKey>;
  npcs: Record<string, FormKey>;
  items: Record<string, FormKey>;
  placedItems: Record<string, FormKey>;
  inContainer: Record<string, FormKey>;
  containerBases: Record<string, FormKey>;
  /** Conversation title → the topics, scenes and shared greeting/chatter responses it made. */
  conversations: Record<string, FormKey[]>;
  /** Lines added to stage scripts, and why (reward, gesture, player, conversation:<title>). */
  stageLines: { stage: number; line: string; why: string }[];
  /** Character key → packages made for their routine (and forcegreet topics). */
  packages: Record<string, { base: FormKey[]; alias: FormKey[] }>;
  /** What was added to start the quest (a trigger on a placed object, or a line in another quest's stage). */
  starts?: StartPlace[];
  /** Fail conditions added (death triggers on aliases, the time limit). */
  failParts?: FailPart[];
  /** Encounter key → the enemies placed for it. */
  encounters?: Record<string, FormKey[]>;
}

type FailPart = { alias: number; trigger: string } | { timeLimit: true };

type StartPlace = { ref: FormKey } | { quest: FormKey; stage: number; line: string };

interface BuildSession {
  plan: QuestPlan;
  resolution: PlanResolution[];
  random: () => number;
  prefix: string;
  quest: FormKey | null;
  placer: Placer;
  cells: Map<string, FormKey>;
  npcs: Map<string, FormKey>;
  items: Map<string, FormKey>;
  placedItems: Map<string, FormKey>;
  inContainer: Map<string, FormKey>;
  containerBases: Map<FormKey, FormKey>;
  perCell: Map<FormKey, number>;
  conversations: Map<string, FormKey[]>;
  stageLines: BuildRecord['stageLines'];
  packages: Map<string, { base: FormKey[]; alias: FormKey[] }>;
  starts: StartPlace[];
  failParts: FailPart[];
  encounters: Map<string, FormKey[]>;
  /** New interiors made in this build: their copied load doors (or empty). */
  newPlaces: Map<string, { loadDoors: FormKey[]; empty?: boolean }>;
  report: QuestBuildReport;
}

function startStageOf(plan: QuestPlan): number {
  const stages = [...plan.stages].sort((a, b) => a.index - b.index);
  return stages.find((x) => x.startsQuest)?.index ?? stages[0]?.index ?? 0;
}

/** What changed about a character between two plans, as a character entry carrying only the changes (null if nothing). */
function characterDelta(was: PlanCharacter, now: PlanCharacter): PlanCharacter | null {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const d: PlanCharacter = { ...now, spot: null, outfit: null, inventory: [], factions: [], className: null, level: null, look: null, essential: null, routine: [], combat: null, roles: null, relationships: [] };
  let changed = false;
  if (!same(was.combat ?? null, now.combat ?? null) && now.combat) (d.combat = now.combat), (changed = true);
  if (!same(was.roles ?? null, now.roles ?? null) && now.roles) (d.roles = now.roles), (changed = true);
  const newRels = (now.relationships ?? []).filter((r) => !(was.relationships ?? []).some((x) => same(x, r)));
  if (newRels.length) (d.relationships = newRels), (changed = true);
  if (!same(was.outfit, now.outfit) && now.outfit) (d.outfit = now.outfit), (changed = true);
  if (!same(was.factions, now.factions)) (d.factions = now.factions.filter((f) => !was.factions.some((x) => same(x, f)))), (changed ||= d.factions.length > 0);
  if (!same(was.inventory, now.inventory)) (d.inventory = now.inventory.filter((i) => !was.inventory.some((x) => same(x, i)))), (changed ||= d.inventory.length > 0);
  if (was.className !== now.className && now.className) (d.className = now.className), (changed = true);
  if (was.level !== now.level && now.level !== null) (d.level = now.level), (changed = true);
  if (was.essential !== now.essential && now.essential !== null) (d.essential = now.essential), (changed = true);
  if (!same(was.look, now.look) && now.look) {
    const l = { ...now.look };
    for (const k of Object.keys(l) as (keyof typeof l)[]) if (was.look && same(was.look[k], l[k])) (l as any)[k] = null;
    d.look = l;
    changed = true;
  }
  return changed ? { ...d, existing: d.existing ?? now.name } : null;
}

/** The differences between two plans, in words (for the update preview). */
export function describeDiff(old: QuestPlan, next: QuestPlan, fromRecord: boolean): string[] {
  const out: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (old.title !== next.title) out.push(`Rename the quest “${next.title}”`);
  if (old.startsWithGame !== next.startsWithGame) out.push(next.startsWithGame ? 'Start the quest with the game' : 'Stop starting the quest with the game');
  for (const st of old.stages) if (!next.stages.some((x) => x.index === st.index)) out.push(`Remove stage ${st.index} (and what leads to it)`);
  for (const st of next.stages) {
    const was = old.stages.find((x) => x.index === st.index);
    if (!was) out.push(`Add stage ${st.index}`);
    else if (was.journal !== st.journal) out.push(`Rewrite stage ${st.index}'s journal entry`);
  }
  for (const c of next.characters) {
    const was = old.characters.find((x) => x.key === c.key);
    if (!was) out.push(`Add ${c.name}`);
    else if (!same({ ...was, routine: [] }, { ...c, routine: [] })) out.push(`Change ${c.name}`);
    if (was && !same(was.routine, c.routine)) out.push(`Change ${c.name}'s routine`);
  }
  for (const i of next.items) if (!old.items.some((x) => x.key === i.key)) out.push(`Add the item ${i.name}`);
  for (const l of next.locations) if (!old.locations.some((x) => x.key === l.key)) out.push(`Add the place ${l.name}`);
  if (!same(old.objectives, next.objectives)) out.push('Update the objectives');
  const stepKey = (x: QuestPlan['steps'][number]) => `${x.from}|${x.to}|${x.kind}|${x.targetKey}`;
  for (const st of old.steps) if (st.kind !== 'talk' && !next.steps.some((x) => stepKey(x) === stepKey(st))) out.push(`Remove “${st.note}”`);
  for (const st of next.steps) if (st.kind !== 'talk' && !old.steps.some((x) => stepKey(x) === stepKey(st))) out.push(`Add “${st.note}”`);
  for (const c of next.conversations) {
    const was = old.conversations.find((x) => x.title === c.title);
    if (!was) out.push(`Add the conversation “${c.title}”`);
    else if (was.screenplay !== c.screenplay) out.push(fromRecord ? `Rewrite the conversation “${c.title}”` : `“${c.title}” changed, but the quest's own dialogue is kept (it wasn't made from a plan)`);
  }
  for (const c of old.conversations) if (!next.conversations.some((x) => x.title === c.title)) out.push(fromRecord ? `Remove the conversation “${c.title}”` : `“${c.title}” is kept (it wasn't made from a plan)`);
  if (!same(old.rewards, next.rewards)) out.push('Update the rewards');
  if (!same(old.animations, next.animations)) out.push('Update the animations at quest stages');
  if (!same(old.events ?? [], next.events ?? [])) out.push('Update the events at quest stages');
  if (!same(old.failures ?? [], next.failures ?? [])) out.push('Update how the quest fails');
  if (!same(old.startsWhen ?? null, next.startsWhen ?? null)) out.push(next.startsWhen && next.startsWhen.kind !== 'game' ? 'Change what starts the quest' : 'Remove what starts the quest');
  return out.length ? out : ['Nothing needs changing'];
}

function pascal(s: string): string {
  return (
    s
      .replace(/[^A-Za-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0]!.toUpperCase() + w.slice(1))
      .join('') || 'Thing'
  );
}

export class QuestBuilder {
  private readonly world: WorldService;
  readonly characters: CharacterEditor;

  constructor(
    readonly ws: Workspace,
    readonly quests: QuestService,
    readonly graphs: QuestGraphService,
    readonly dialogue: DialogueService,
    readonly npcs: NpcService,
    readonly env: EnvironmentService,
  ) {
    this.world = new WorldService(ws);
    this.characters = new CharacterEditor(ws, npcs);
  }

  // ---------------------------------------------------------------- finding forms

  /** A form of one of `sigs` by Editor ID or exact name (yours first). */
  findForm(sigs: readonly string[], text: string | null | undefined): FormKey | undefined {
    const t = text?.trim();
    if (!t) return undefined;
    const byId = this.ws.byEditorId(t);
    if (byId && sigs.includes(this.ws.summary(byId)?.sig ?? '')) return byId;
    const l = t.toLowerCase();
    const hits = this.ws.search({ sigs, query: t, limit: 200 }).items.filter((i) => !i.deleted && (i.editorId?.toLowerCase() === l || i.name?.toLowerCase() === l || i.formKey.toLowerCase() === l));
    return (hits.find((h) => h.inActive) ?? hits[0])?.formKey;
  }

  private label(key: FormKey): string {
    const s = this.ws.summary(key);
    if (s?.name && s.editorId && s.name !== s.editorId) return `${s.name} (${s.editorId})`;
    return s?.name ?? s?.editorId ?? key;
  }

  private race(text: string | null): FormKey | undefined {
    if (!text) return undefined;
    return this.findForm(['RACE'], text) ?? this.findForm(['RACE'], `${pascal(text)}Race`);
  }

  private voice(text: string | null): FormKey | undefined {
    if (!text) return undefined;
    return this.findForm(['VTYP'], text) ?? this.findForm(['VTYP'], pascal(text));
  }

  /** The character a new one is copied from: same sex and race, with a voice and a face, not built from a template. */
  private npcTemplate(c: PlanCharacter, cache: Map<string, FormKey | undefined>): FormKey | undefined {
    const race = this.race(c.race);
    const id = `${c.sex}|${race ?? ''}`;
    if (cache.has(id)) return cache.get(id);
    let best: { key: FormKey; score: number } | undefined;
    for (const s of this.ws.search({ sigs: ['NPC_'], limit: 100_000 }).items) {
      if (s.deleted) continue;
      const d = this.ws.view(s.formKey)?.data as Record<string, any> | undefined;
      if (!d) continue;
      const female = ((d.config?.flags ?? 0) & FEMALE_FLAG) !== 0;
      let score = 0;
      if (c.sex) score += (c.sex === 'female') === female ? 16 : -16;
      if (race) score += d.race === race ? 8 : -8;
      if (d.voice) score += 4;
      if (d.headParts?.length) score += 2;
      if (!d.template && !(d.config?.templateFlags ?? 0)) score += 2;
      if (!best || score > best.score || (score === best.score && s.formKey < best.key)) best = { key: s.formKey, score };
    }
    cache.set(id, best?.key);
    return best?.key;
  }

  private itemTemplate(kind: PlanItem['kind']): FormKey | undefined {
    for (const sig of [ITEM_TEMPLATE_SIG[kind], 'MISC']) {
      const hit = this.ws
        .search({ sigs: [sig], limit: 100_000 })
        .items.find((s) => !s.deleted && (this.ws.view(s.formKey)?.data as any)?.model?.file);
      if (hit) return hit.formKey;
    }
    return undefined;
  }

  /** What each character, place and item in the plan will use (for the review screen and the build). */
  resolve(plan: QuestPlan): PlanResolution[] {
    const out: PlanResolution[] = [];
    const cache = new Map<string, FormKey | undefined>();
    for (const c of plan.characters) {
      const changes = this.characters.describe(c);
      if (c.existing) {
        const k = this.findForm(['NPC_'], c.existing) ?? this.findForm(['NPC_'], c.name);
        out.push(k ? { kind: 'character', key: c.key, name: c.name, existing: k, template: null, text: `Uses ${this.label(k)}${changes.length ? ', changed' : ''}`, changes } : { kind: 'character', key: c.key, name: c.name, existing: null, template: null, text: `No character called “${c.existing}”`, error: `${c.name}: no character called “${c.existing}” in the load order` });
        continue;
      }
      const based = c.basedOn ? this.characters.findLoose(['NPC_'], c.basedOn) : undefined;
      const t = based ?? this.npcTemplate(c, cache);
      const note = c.basedOn && !based ? ` (no “${c.basedOn}” found)` : '';
      out.push(t ? { kind: 'character', key: c.key, name: c.name, existing: null, template: t, text: `New, copied from ${this.label(t)}${note}`, changes } : { kind: 'character', key: c.key, name: c.name, existing: null, template: null, text: 'No character to copy from', error: `${c.name}: there's no character in the load order to copy` });
    }
    for (const l of plan.locations) {
      if (l.existing) {
        const k = this.findForm(['CELL'], l.existing) ?? this.findForm(['CELL'], l.name);
        out.push(k ? { kind: 'location', key: l.key, name: l.name, existing: k, template: null, text: `Uses ${this.label(k)}` } : { kind: 'location', key: l.key, name: l.name, existing: null, template: null, text: `No cell called “${l.existing}”`, error: `${l.name}: no cell called “${l.existing}” in the load order` });
      } else {
        const like = l.layoutLike ? this.findForm(['CELL'], l.layoutLike) : undefined;
        const from = l.doorFrom ? (plan.locations.find((x) => x.key === l.doorFrom)?.name ?? (this.findForm(['CELL'], l.doorFrom) ? this.label(this.findForm(['CELL'], l.doorFrom)!) : undefined)) : undefined;
        const text = [like ? `New, laid out like ${this.label(like)} (walls, furniture, lights and clutter copied)` : l.layoutLike ? `New empty interior (no interior called “${l.layoutLike}” to copy)` : 'New empty interior', from ? `with a door from ${from}` : l.doorFrom ? `(no place called “${l.doorFrom}” for its door)` : like ? 'with no door in yet' : ''].filter(Boolean).join(' ');
        out.push({ kind: 'location', key: l.key, name: l.name, existing: null, template: like ?? null, text });
      }
    }
    for (const i of plan.items) {
      const k = i.kind === 'gold' ? resolveItem(this.ws, 'gold') : i.existing ? (resolveItem(this.ws, i.existing) ?? resolveItem(this.ws, i.name) ?? this.characters.findLoose(ITEM_SIGS, i.existing)) : undefined;
      if (k) {
        out.push({ kind: 'item', key: i.key, name: i.name, existing: k, template: null, text: i.kind === 'gold' ? 'Gold coins' : `Uses ${this.label(k)}` });
        continue;
      }
      if (i.existing) {
        out.push({ kind: 'item', key: i.key, name: i.name, existing: null, template: null, text: `No item called “${i.existing}”`, error: `${i.name}: no item called “${i.existing}” in the load order` });
        continue;
      }
      const based = i.basedOn ? this.characters.findLoose([ITEM_TEMPLATE_SIG[i.kind]], i.basedOn) ?? this.characters.findLoose(ITEM_SIGS, i.basedOn) : undefined;
      const t = based ?? this.itemTemplate(i.kind);
      out.push(t ? { kind: 'item', key: i.key, name: i.name, existing: null, template: t, text: `New, copied from ${this.label(t)}${i.basedOn && !based ? ` (no “${i.basedOn}” found)` : ''}` } : { kind: 'item', key: i.key, name: i.name, existing: null, template: null, text: 'No item to copy from', error: `${i.name}: there's no item in the load order to copy` });
    }
    return out;
  }

  // ---------------------------------------------------------------- building

  /** Build the quest. Throws (and changes nothing) if the plan has errors. */
  async build(plan: QuestPlan, opts: { seed?: number } = {}): Promise<QuestBuildReport> {
    const resolution = this.check(plan);
    return this.ws.transactionAsync(plan.stages.length ? `Build quest ${plan.editorId}` : `Build ${plan.title}`, async () => {
      const s = this.session(plan, resolution, opts.seed ?? 1);
      await this.buildAll(s);
      if (s.quest) await this.saveRecord(s);
      return s.report;
    });
  }

  /** Errors that stop a plan being built, and what each entry resolves to. */
  private check(plan: QuestPlan): PlanResolution[] {
    const errors = validatePlan(plan).filter((i) => i.severity === 'error').map((i) => i.message);
    const resolution = this.resolve(plan);
    errors.push(...resolution.filter((r) => r.error).map((r) => r.error!));
    if (errors.length) throw new WorkspaceError(`The plan can't be built yet:\n${errors.map((e) => `• ${e}`).join('\n')}`);
    if (!this.ws.active) throw new WorkspaceError('Open or create a plugin first');
    return resolution;
  }

  private session(plan: QuestPlan, resolution: PlanResolution[], seed: number, record?: BuildRecord): BuildSession {
    normalizePlan(plan);
    const random = rng(seed);
    return {
      plan,
      resolution,
      random,
      prefix: (record?.prefix ?? plan.editorId).replace(/[^A-Za-z0-9_]/g, ''),
      quest: record?.quest ?? null,
      placer: new Placer(this.env, this.world, random),
      cells: new Map(Object.entries(record?.cells ?? {})),
      npcs: new Map(Object.entries(record?.npcs ?? {})),
      items: new Map(Object.entries(record?.items ?? {})),
      placedItems: new Map(Object.entries(record?.placedItems ?? {})),
      inContainer: new Map(Object.entries(record?.inContainer ?? {})),
      containerBases: new Map(Object.entries(record?.containerBases ?? {})) as Map<FormKey, FormKey>,
      perCell: new Map(),
      conversations: new Map(Object.entries(record?.conversations ?? {})),
      stageLines: [...(record?.stageLines ?? [])],
      packages: new Map(Object.entries(record?.packages ?? {})),
      starts: [...(record?.starts ?? [])],
      failParts: [...(record?.failParts ?? [])],
      encounters: new Map(Object.entries(record?.encounters ?? {})),
      newPlaces: new Map(),
      report: { quest: record?.quest ?? null, editorId: record ? (this.ws.view(record.quest)?.editorId ?? plan.editorId) : '', created: [], changed: [], reused: [], updated: [], dialogue: { topics: 0, responses: 0, greetings: 0, scenes: 0 }, notes: [...plan.assumptions.map((a) => `Assumed: ${a}`)], warnings: [], problems: [] },
    };
  }

  private res(s: BuildSession, kind: PlanEntryKind, key: string): PlanResolution {
    return s.resolution.find((r) => r.kind === kind && r.key === key)!;
  }

  private async buildAll(s: BuildSession): Promise<void> {
    const { plan, report } = s;
    // The quest and its stages first (items the player starts with are given in a stage script).
    // A plan with no stages only changes characters, places and items.
    const stages = [...plan.stages].sort((a, b) => a.index - b.index);
    if (stages.length) {
      let editorId = plan.editorId;
      if (this.ws.byEditorId(editorId)) {
        editorId = this.ws.uniqueEditorId(editorId);
        report.notes.push(`The Editor ID ${plan.editorId} was taken, so the quest is ${editorId}`);
      }
      s.quest = this.quests.createQuest(editorId, plan.title, { startGameEnabled: plan.startsWithGame });
      report.quest = s.quest;
      report.editorId = editorId;
      report.created.push({ kind: 'quest', formKey: s.quest, label: `${plan.title} (${editorId})` });
      const start = startStageOf(plan);
      for (const st of stages) this.addStage(s.quest, st, start);
    }
    for (const l of plan.locations) this.buildLocation(s, l);
    await this.connectPlaces(s, plan.locations);
    for (const i of plan.items) this.buildItem(s, i);
    for (const c of plan.characters) this.buildCharacter(s, c);
    this.buildRelationships(s, plan.characters);
    for (const c of plan.characters) await this.placeCharacter(s, c);
    for (const e of plan.encounters) await this.placeEncounter(s, e);
    await this.placeItems(s, plan.items);
    if (!s.quest) {
      await this.buildRoutines(s, plan.characters);
      this.finishNotes(report);
      return;
    }
    const quest = s.quest;
    await this.buildObjectives(s);
    for (const conv of plan.conversations) await this.buildConversation(s, conv);
    for (const st of plan.steps) await this.buildStep(s, st);
    await this.buildStart(s);
    await this.buildFailures(s);
    await this.buildRoutines(s, plan.characters);
    await this.buildStageLines(s, 'gesture');
    await this.buildStageLines(s, 'reward');
    await this.buildStageLines(s, 'event');
    this.finishNotes(report);
    if (!plan.startsWithGame && !s.starts.length) report.notes.push('The quest doesn’t start with the game; start it from another quest or a trigger (Start Quest).');
    await this.finishChecks(s, quest);
  }

  private async finishChecks(s: BuildSession, quest: FormKey): Promise<void> {
    s.report.problems = (await this.graphs.graph(quest)).problems;
    for (const l of await lintQuestDialogue(quest, { quests: this.quests, dialogue: this.dialogue, graphs: this.graphs })) s.report.warnings.push(`Dialogue: ${l.message}`);
  }

  private addStage(quest: FormKey, st: QuestPlan['stages'][number], start: number): void {
    const log = st.journal.trim();
    this.quests.addStage(quest, st.index, log || st.completesQuest || st.failsQuest ? log : undefined, { startUp: st.index === start, completesQuest: st.completesQuest, failsQuest: st.failsQuest });
  }

  private buildLocation(s: BuildSession, l: PlanLocation): void {
    const r = this.res(s, 'location', l.key);
    if (r.existing) {
      s.cells.set(l.key, r.existing);
      s.report.reused.push({ kind: 'location', formKey: r.existing, label: this.label(r.existing) });
      return;
    }
    const editorId = this.ws.uniqueEditorId(`${s.prefix}${pascal(l.name)}`);
    const like = l.layoutLike ? this.findForm(['CELL'], l.layoutLike) : undefined;
    if (l.layoutLike && !like) s.report.warnings.push(`${l.name} should look like “${l.layoutLike}”, but there's no interior called that, so it's empty.`);
    if (like) {
      try {
        const copy = this.world.copyInterior(like, editorId, l.name);
        s.cells.set(l.key, copy.cell);
        s.newPlaces.set(l.key, { loadDoors: copy.loadDoors });
        s.report.created.push({ kind: 'location', formKey: copy.cell, label: `${l.name} (new interior, laid out like ${this.label(like)}: ${copy.refs.length} objects)` });
        return;
      } catch (e) {
        s.report.warnings.push(`${l.name} couldn't be laid out like ${this.label(like)} (${(e as Error).message}), so it's empty.`);
      }
    }
    const cell = this.world.createInteriorCell(editorId, l.name, { ambient: [60, 55, 50] });
    s.cells.set(l.key, cell);
    s.newPlaces.set(l.key, { loadDoors: [], empty: true });
    s.report.created.push({ kind: 'location', formKey: cell, label: `${l.name} (new interior)` });
    s.report.notes.push(`${l.name} is a new, empty interior. Build the room in World → Tools and connect a door to it.`);
  }

  /**
   * Doors into new places from where the plan says the player comes from, and
   * a navmesh for each furnished new place (so characters can walk in it).
   */
  private async connectPlaces(s: BuildSession, list: PlanLocation[]): Promise<void> {
    for (const l of list) {
      const place = s.newPlaces.get(l.key);
      if (!place) continue;
      const cell = s.cells.get(l.key)!;
      if (l.doorFrom && !place.empty) {
        const from = s.cells.get(l.doorFrom) ?? this.findForm(['CELL'], l.doorFrom);
        if (!from) s.report.warnings.push(`${l.name}'s door should be in “${l.doorFrom}”, but there's no place called that; link a door yourself in World → Tools → Doors.`);
        else {
          // Inside: the copied layout's own way out, or a new door against a wall.
          let inner = place.loadDoors[0];
          const doorBase = (inner ? ((this.ws.view(inner)?.data as any)?.base as FormKey) : undefined) ?? this.anyDoorBase();
          if (!doorBase) s.report.warnings.push(`No door in your load order to connect ${l.name} with.`);
          else {
            if (!inner) {
              const spot = await this.env.doorSpot(cell);
              inner = this.world.placeReference(cell, doorBase, { position: spot.position, rotation: { x: 0, y: 0, z: spot.yaw } }, { persistent: true });
            }
            const spot = await this.env.doorSpot(from, 7);
            const outer = this.world.placeReference(from, doorBase, { position: spot.position, rotation: { x: 0, y: 0, z: spot.yaw } }, { persistent: true, editorId: this.ws.uniqueEditorId(`${s.prefix}${pascal(l.name)}Door`) });
            await this.env.linkDoors(outer, inner);
            s.report.created.push({ kind: 'placed', formKey: outer, label: `A door to ${l.name} in ${this.label(from)}${spot.onWall ? '' : ' (no wall found: move it where it belongs)'}` });
            if (!spot.onWall) s.report.notes.push(`The door to ${l.name} stands in the middle of ${this.label(from)}; move it into place in the World tab (its link moves with it).`);
            if (parseFormKey(from).plugin !== this.ws.activeName && !this.world.cells().find((c) => c.formKey === from)?.interior) s.report.notes.push(`The door outside is in ${this.label(from)}, an outdoor cell: check it doesn't clash with other mods there.`);
          }
        }
      } else if (!l.doorFrom && !place.empty) s.report.notes.push(`${l.name} has no door in from anywhere yet; link one in World → Tools → Doors.`);
      const extra = place.loadDoors.length - (l.doorFrom ? 1 : 0);
      if (extra > 0) s.report.notes.push(`${l.name} has ${extra} more door${extra > 1 ? 's' : ''} from the layout it copies that lead${extra > 1 ? '' : 's'} nowhere yet: link or lock ${extra > 1 ? 'them' : 'it'} in the World tab.`);
      if (!place.empty) {
        try {
          const nav = await generateCellNavmesh(this.ws, cell, { preset: 'interior' });
          await this.env.stampNavmesh(cell);
          s.report.notes.push(`${l.name} got a navmesh (${nav.triangles} triangles) so characters can walk there.`);
        } catch (e) {
          s.report.warnings.push(`${l.name} has no navmesh yet (${(e as Error).message}); generate one in World → Navmesh.`);
        }
      }
    }
  }

  private anyDoorBase(): FormKey | undefined {
    return this.ws.search({ sigs: ['DOOR'], limit: 200 }).items.find((d) => !d.deleted && (this.ws.view(d.formKey)?.data as any)?.model)?.formKey;
  }

  private buildItem(s: BuildSession, i: PlanItem): void {
    const r = this.res(s, 'item', i.key);
    let item = r.existing;
    if (item) s.report.reused.push({ kind: 'item', formKey: item, label: this.label(item) });
    else item = this.createItem(i, r.template!, s.prefix, s.report);
    s.items.set(i.key, item);
  }

  private changeCtx(s: BuildSession, isNew: boolean) {
    return {
      items: s.items,
      prefix: s.prefix,
      random: s.random,
      isNew,
      created: (kind: 'outfit' | 'role', formKey: FormKey, label: string) => void s.report.created.push({ kind, formKey, label }),
      note: (t: string) => void s.report.notes.push(t),
      warn: (t: string) => void s.report.warnings.push(t),
    };
  }

  /** New characters copied and set up; existing ones changed as the plan says. */
  private buildCharacter(s: BuildSession, c: PlanCharacter): void {
    const r = this.res(s, 'character', c.key);
    if (r.existing) {
      s.npcs.set(c.key, r.existing);
      const changes = this.characters.describe(c);
      if (changes.length) {
        this.characters.apply(r.existing, c, this.changeCtx(s, false));
        s.report.changed.push({ formKey: r.existing, label: this.label(r.existing), changes });
      } else s.report.reused.push({ kind: 'character', formKey: r.existing, label: this.label(r.existing) });
      return;
    }
    const npc = this.createCharacter(c, r.template!, s.prefix, s.random, s.report);
    this.characters.apply(npc, c, this.changeCtx(s, true));
    s.npcs.set(c.key, npc);
  }

  /** How characters feel about each other and the player (after all of them exist). */
  private buildRelationships(s: BuildSession, list: PlanCharacter[]): void {
    for (const c of list)
      for (const r of c.relationships ?? []) {
        const npc = s.npcs.get(c.key);
        if (npc) this.characters.relate(npc, r.with, r.rank, c, this.changeCtx(s, false), (k) => s.npcs.get(k));
      }
  }

  private async placeCharacter(s: BuildSession, c: PlanCharacter): Promise<void> {
    const existing = this.res(s, 'character', c.key)?.existing;
    if (existing || !c.locationKey) {
      if (!existing) s.report.warnings.push(`${c.name} wasn't given a place, so they aren't in the world yet. Place them from the Objects tab.`);
      return;
    }
    const cell = s.cells.get(c.locationKey)!;
    const npc = s.npcs.get(c.key)!;
    const spot = await s.placer.actorSpot(cell, c.spot);
    if (c.spot && !spot.near) s.report.notes.push(`${c.name}: nothing like “${c.spot}” in ${this.label(cell)}, so they stand on open floor.`);
    const ref = this.world.placeReference(cell, npc, { position: spot.position, rotation: { x: 0, y: 0, z: spot.yaw } }, { persistent: true, editorId: this.ws.uniqueEditorId(`${this.ws.view(npc)?.editorId ?? s.prefix}Ref`) });
    s.report.created.push({ kind: 'placed', formKey: ref, label: `${c.name} in ${this.label(cell)}${spot.near ? `, ${c.spot}` : ''}` });
  }

  private nextSlot(s: BuildSession, cell: FormKey): number {
    const n = s.perCell.get(cell) ?? 0;
    s.perCell.set(cell, n + 1);
    return n;
  }

  /** Items where the plan says they start: in a place (on furniture or in a container), with a character, or with the player. */
  private async placeItems(s: BuildSession, list: PlanItem[]): Promise<void> {
    const dropMe: FormKey[] = [];
    const playerGets: string[] = [];
    for (const i of list) {
      const item = s.items.get(i.key)!;
      if (i.startsWith === 'location' && i.startsAtKey) {
        const cell = s.cells.get(i.startsAtKey)!;
        const where = s.placer.itemSpot(cell, i.spot, this.nextSlot(s, cell));
        if (where.kind === 'container') {
          // A container's contents belong to its base, so this one gets its own copy of the base.
          const ref = where.container;
          let base = s.containerBases.get(ref.formKey);
          if (!base) {
            base = this.ws.duplicateRecord(ref.base!, this.ws.uniqueEditorId(`${s.prefix}${pascal(ref.baseName ?? ref.baseEditorId ?? 'Container')}`));
            s.containerBases.set(ref.formKey, base);
            this.ws.editRecord(ref.formKey, (d: any) => void (d.base = base), 'Use its own container');
            s.report.created.push({ kind: 'item', formKey: base, label: `${this.label(base)}: a copy of ${ref.baseName ?? ref.baseEditorId} for the one in ${this.label(cell)}` });
          }
          this.ws.editRecord(base, (d: any) => void (d.items = [...(d.items ?? []), { item: { item, count: 1 } }]), 'Put in container');
          s.inContainer.set(i.key, ref.formKey);
          s.report.created.push({ kind: 'placed', formKey: ref.formKey, label: `${i.name} in the ${(ref.baseName ?? 'container').toLowerCase()} in ${this.label(cell)}` });
          continue;
        }
        if (i.spot && !where.on) s.report.notes.push(`${i.name}: nothing like “${i.spot}” in ${this.label(cell)}, so it's on the floor.`);
        const ref = this.world.placeReference(cell, item, { position: where.position, rotation: { x: 0, y: 0, z: s.random() * Math.PI * 2 } }, { persistent: true, editorId: this.ws.uniqueEditorId(`${s.prefix}${pascal(i.name)}Ref`) });
        s.placedItems.set(i.key, ref);
        dropMe.push(ref);
        s.report.created.push({ kind: 'placed', formKey: ref, label: `${i.name} ${where.on ? `on the ${(where.on.baseName ?? where.on.baseEditorId ?? 'table').toLowerCase()}` : 'on the floor'} in ${this.label(cell)}` });
      } else if (i.startsWith === 'character' && i.startsAtKey) {
        const npc = s.npcs.get(i.startsAtKey)!;
        this.ws.editRecord(npc, (d: any) => void (d.items = [...(d.items ?? []), { item: { item, count: 1 } }]), 'Add to inventory');
        if (parseFormKey(npc).plugin !== this.ws.activeName) s.report.warnings.push(`${i.name} was added to ${this.label(npc)}'s inventory, which changes a character from ${parseFormKey(npc).plugin} (other mods that change them will conflict).`);
      } else if (i.startsWith === 'player') playerGets.push(`Game.GetPlayer().AddItem(${formExpression(item)}, 1)`);
    }
    if (dropMe.length) {
      const { missed } = await this.env.dropToSurface(dropMe);
      if (missed.length) s.report.notes.push(`${missed.length} item(s) had nothing under them to rest on; check where they are in the World tab.`);
    }
    if (!playerGets.length) return;
    if (!s.quest) s.report.warnings.push('Items the player should start with need a quest to give them; they were left out.');
    else await this.addStageLines(s, startStageOf(s.plan), playerGets, 'player');
  }

  /** The quest alias a plan key's marker / trigger uses (items in containers get one created inside). */
  private aliasOf(s: BuildSession, key: string | null): number | undefined {
    const quest = s.quest!;
    if (!key) return undefined;
    if (s.npcs.has(key)) return this.graphs.aliasFor(quest, s.npcs.get(key)!);
    if (s.placedItems.has(key)) return this.graphs.aliasFor(quest, s.placedItems.get(key)!);
    if (s.inContainer.has(key)) return this.graphs.itemInContainerAlias(quest, s.items.get(key)!, s.inContainer.get(key)!);
    if (s.cells.has(key)) return this.graphs.aliasFor(quest, this.graphs.markerIn(quest, s.cells.get(key)!));
    return undefined;
  }

  private addObjective(s: BuildSession, o: QuestPlan['objectives'][number]): void {
    const alias = this.aliasOf(s, o.targetKey);
    if (o.targetKey && alias === undefined) s.report.notes.push(`Objective ${o.index} (“${o.text}”) has no quest marker: ${o.targetKey} isn't somewhere in the world the marker can point at.`);
    this.quests.addObjective(s.quest!, o.index, o.text, alias);
  }

  private async buildObjectives(s: BuildSession): Promise<void> {
    for (const o of [...s.plan.objectives].sort((a, b) => a.index - b.index)) this.addObjective(s, o);
    await this.syncStageObjectives(s);
  }

  /** Every stage's script shows/completes exactly the objectives the plan says (other script lines are kept). */
  private async syncStageObjectives(s: BuildSession): Promise<void> {
    const quest = s.quest!;
    for (const st of this.quests.quest(quest).stages) {
      const shows = s.plan.objectives.filter((o) => o.shownAtStage === st.index).map((o) => o.index);
      const completes = s.plan.objectives.filter((o) => o.completedAtStage === st.index).map((o) => o.index);
      const node = (await this.graphs.graph(quest)).nodes.find((n) => n.stage === st.index);
      if (shows.length || completes.length || node?.shows.length || node?.completes.length) await this.graphs.setStageObjectives(quest, st.index, shows, completes);
    }
  }

  /** Speakers and items in a screenplay → the Editor IDs that were built for them. */
  private screenplayIds(s: BuildSession): { speakers: Map<string, string>; items: Map<string, string> } {
    const speakers = new Map<string, string>();
    for (const c of s.plan.characters) {
      const id = s.npcs.has(c.key) ? this.ws.view(s.npcs.get(c.key)!)?.editorId : undefined;
      if (!id) continue;
      speakers.set(c.key.toLowerCase(), id);
      speakers.set(c.name.toLowerCase(), id);
      for (const w of c.name.split(/\s+/)) if (w.length > 2 && !speakers.has(w.toLowerCase())) speakers.set(w.toLowerCase(), id);
    }
    const items = new Map<string, string>();
    for (const i of s.plan.items) {
      const id = i.kind === 'gold' ? 'gold' : s.items.has(i.key) ? this.ws.view(s.items.get(i.key)!)?.editorId : undefined;
      if (!id) continue;
      items.set(i.key.toLowerCase(), id);
      items.set(i.name.toLowerCase(), id);
    }
    return { speakers, items };
  }

  /** A conversation: its topics, scenes and stage-script lines are recorded so an update can replace them. */
  private async buildConversation(s: BuildSession, conv: QuestPlan['conversations'][number]): Promise<void> {
    const quest = s.quest!;
    const ids = this.screenplayIds(s);
    const text = rewriteScreenplay(conv.screenplay, ids.speakers, ids.items);
    const topicsBefore = new Set(this.quests.topics(quest).map((t) => t.formKey));
    const scenesBefore = new Set(this.scenesOf(quest));
    const linesBefore = await this.stageCode(quest);
    try {
      const r = await this.dialogue.importScreenplay(quest, text, (info, code, which) => this.quests.setInfoFragment(info, which, code), this.sceneHooks());
      s.report.dialogue.topics += r.topics;
      s.report.dialogue.responses += r.responses;
      s.report.dialogue.greetings += r.greetings;
      s.report.dialogue.scenes += r.scenes;
    } catch (e) {
      throw new WorkspaceError(`The conversation “${conv.title}” couldn't be made: ${(e as Error).message}`);
    }
    const made = [...this.quests.topics(quest).map((t) => t.formKey).filter((k) => !topicsBefore.has(k)), ...this.scenesOf(quest).filter((k) => !scenesBefore.has(k))];
    // Greetings and chatter share one topic per quest, so their responses are recorded instead.
    const shared = this.quests
      .topics(quest)
      .filter((t) => topicsBefore.has(t.formKey) && (t.subtype === 'HELO' || t.subtype === 'IDLE'))
      .flatMap((t) => t.infos.map((i) => i.formKey));
    const sharedBefore = new Set(s.conversations.get(conv.title)?.filter((k) => this.ws.summary(k)?.sig === 'INFO') ?? []);
    s.conversations.set(conv.title, [...made, ...shared.filter((k) => !sharedBefore.has(k) && !this.ownedByOtherConversation(s, k, conv.title))]);
    for (const [stage, lines] of await this.newLines(quest, linesBefore)) for (const line of lines) s.stageLines.push({ stage, line, why: `conversation:${conv.title}` });
  }

  private ownedByOtherConversation(s: BuildSession, key: FormKey, title: string): boolean {
    for (const [t, keys] of s.conversations) if (t !== title && keys.includes(key)) return true;
    return false;
  }

  private scenesOf(quest: FormKey): FormKey[] {
    return this.ws
      .search({ sigs: ['SCEN'], limit: 100_000 })
      .items.filter((x) => (this.ws.view(x.formKey)?.data as any)?.quest === quest)
      .map((x) => x.formKey);
  }

  private async stageCode(quest: FormKey): Promise<Map<number, string[]>> {
    const out = new Map<number, string[]>();
    for (const st of this.quests.quest(quest).stages) out.set(st.index, (await this.graphs.fragmentCode(quest, st.index)).split('\n').map((l) => l.trim()).filter(Boolean));
    return out;
  }

  private async newLines(quest: FormKey, before: Map<number, string[]>): Promise<Map<number, string[]>> {
    const out = new Map<number, string[]>();
    for (const [stage, lines] of await this.stageCode(quest)) {
      const old = [...(before.get(stage) ?? [])];
      const added: string[] = [];
      for (const l of lines) {
        const i = old.indexOf(l);
        if (i >= 0) old.splice(i, 1);
        else added.push(l);
      }
      if (added.length) out.set(stage, added);
    }
    return out;
  }

  private async addStageLines(s: BuildSession, stage: number, lines: string[], why: string): Promise<void> {
    if (!lines.length) return;
    await this.graphs.appendStageCode(s.quest!, stage, lines);
    for (const line of lines) s.stageLines.push({ stage, line: line.trim(), why });
  }

  /** Gestures at quest events, rewards, or world events: lines in stage scripts. */
  private async buildStageLines(s: BuildSession, why: 'gesture' | 'reward' | 'event'): Promise<void> {
    const quest = s.quest!;
    if (why === 'event') {
      const byStage = new Map<number, PlanEvent[]>();
      for (const e of s.plan.events) byStage.set(e.atStage, [...(byStage.get(e.atStage) ?? []), e]);
      for (const [stage, events] of byStage) {
        // A fade goes to black first, everything else happens in the dark, then it fades back.
        const before: string[] = [];
        const lines: string[] = [];
        const after: string[] = [];
        for (const e of events) {
          if (e.kind === 'fade') {
            const secs = Math.max(0, Math.min(30, e.count ?? 2));
            if (!before.length) before.push('Game.FadeOutGame(True, True, 0.0, 1.0)', `Utility.Wait(${(1 + secs).toFixed(1)})`);
            if (!after.length) after.push('Game.FadeOutGame(False, True, 0.0, 1.0)');
            continue;
          }
          const made = this.eventLines(s, e);
          if (made) lines.push(...made);
        }
        await this.addStageLines(s, stage, [...before, ...lines, ...after], why);
      }
      this.hideUntilShown(s);
      return;
    }
    if (why === 'gesture') {
      for (const a of s.plan.animations) {
        const before = await this.stageCode(quest);
        await this.graphs.addStageGesture(quest, a.atStage, s.npcs.get(a.characterKey)!, a.gesture);
        for (const [stage, lines] of await this.newLines(quest, before)) for (const line of lines) s.stageLines.push({ stage, line, why });
      }
      return;
    }
    const byStage = new Map<number, string[]>();
    for (const r of s.plan.rewards) {
      const lines = byStage.get(r.atStage) ?? [];
      if (r.gold) lines.push(`Game.GetPlayer().AddItem(${formExpression(resolveItem(this.ws, 'gold')!)}, ${r.gold})`);
      if (r.itemKey) lines.push(`Game.GetPlayer().AddItem(${formExpression(s.items.get(r.itemKey)!)}, 1)`);
      byStage.set(r.atStage, lines);
    }
    for (const [stage, lines] of byStage) await this.addStageLines(s, stage, lines, why);
  }

  /**
   * A reference to a plan key (character, item, place) or something already in
   * the world, as a quest alias expression; null when it can't be found.
   */
  private refExpr(s: BuildSession, key: string | null, wantActor: boolean): { expr: string; target: FormKey } | null {
    const quest = s.quest!;
    if (!key?.trim()) return null;
    let alias = this.aliasOf(s, key);
    let target: FormKey | undefined = s.npcs.get(key) ?? s.placedItems.get(key) ?? s.cells.get(key);
    if (alias === undefined) {
      target = this.findForm(['ACHR', 'REFR', 'NPC_', 'CELL'], key);
      if (!target) return null;
      alias = this.ws.summary(target)?.sig === 'CELL' ? this.graphs.aliasFor(quest, this.graphs.markerIn(quest, target)) : this.graphs.aliasFor(quest, target);
    }
    const sig = target ? this.ws.summary(target)?.sig : undefined;
    const isActor = sig === 'NPC_' || sig === 'ACHR';
    if (wantActor && !isActor) return null;
    const name = this.quests.quest(quest).aliases.find((a) => a.id === alias)!.name;
    return { expr: `Alias_${name}.${isActor ? 'GetActorReference' : 'GetReference'}()`, target: target! };
  }

  /** A form by Editor ID or name, or failing that the closest match (leveled characters first, for enemies). */
  private findLoose(sigs: readonly string[], text: string | null): FormKey | undefined {
    const exact = this.findForm(sigs, text);
    if (exact || !text?.trim()) return exact;
    const words = text.trim().toLowerCase().replace(/s$/, '').split(/\s+/);
    const hits = this.ws
      .search({ sigs, query: words[0], limit: 2000 })
      .items.filter((i) => !i.deleted && words.every((w) => `${i.editorId ?? ''} ${i.name ?? ''}`.toLowerCase().includes(w)));
    const score = (i: (typeof hits)[number]) => (/^lvl/i.test(i.editorId ?? '') ? 0 : 1000) + (i.editorId?.length ?? 999);
    return hits.sort((a, b) => score(a) - score(b))[0]?.formKey;
  }

  /** The stage-script lines for one world event (null, with a warning, when it can't be made). */
  private eventLines(s: BuildSession, e: PlanEvent): string[] | null {
    const what = `“${e.note || e.kind}” (stage ${e.atStage})`;
    const skip = (why: string) => (s.report.warnings.push(`${what} was left out: ${why}.`), null);
    const actor = () => this.refExpr(s, e.targetKey, true);
    const thing = () => this.refExpr(s, e.targetKey, false);
    const quoted = (t: string) => `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
    switch (e.kind) {
      case 'spawn': {
        const enemy = this.findLoose(['NPC_'], e.what);
        if (!enemy) return skip(`no character like “${e.what}” in the load order`);
        const at = e.targetKey ? thing() : null;
        if (e.targetKey && !at) return skip(`can't find “${e.targetKey}” to spawn them at`);
        const n = Math.max(1, Math.min(10, e.count ?? 1));
        s.report.notes.push(`${what}: ${n} × ${this.label(enemy)} appear ${at ? `at ${e.targetKey}` : 'near the player'}.`);
        return Array.from({ length: n }, () => `${at?.expr ?? 'Game.GetPlayer()'}.PlaceActorAtMe(${formExpression(enemy)} as ActorBase)`);
      }
      case 'hostile':
      case 'friendly':
      case 'kill': {
        const a = actor();
        if (!a) return skip(`“${e.targetKey}” isn't a character in the plan or the world`);
        if (e.kind === 'kill') return [`${a.expr}.Kill()`];
        if (e.kind === 'hostile') return [`${a.expr}.SetRelationshipRank(Game.GetPlayer(), -4)`, `${a.expr}.SetActorValue("Aggression", 1)`, `${a.expr}.StartCombat(Game.GetPlayer())`];
        return [`${a.expr}.StopCombat()`, `${a.expr}.SetActorValue("Aggression", 0)`, `${a.expr}.SetRelationshipRank(Game.GetPlayer(), 0)`, 'Game.GetPlayer().StopCombatAlarm()'];
      }
      case 'unlock':
      case 'lock':
      case 'show':
      case 'hide': {
        const r = thing();
        if (!r) return skip(`can't find “${e.targetKey}”`);
        return [`${r.expr}.${{ unlock: 'Lock(False)', lock: 'Lock(True)', show: 'Enable()', hide: 'Disable()' }[e.kind]}`];
      }
      case 'moveTo':
      case 'movePlayer': {
        const dest = this.refExpr(s, e.toKey, false);
        if (!dest) return skip(`can't find “${e.toKey}” to go to`);
        if (e.kind === 'movePlayer') return [`Game.GetPlayer().MoveTo(${dest.expr})`];
        const a = actor();
        if (!a) return skip(`“${e.targetKey}” isn't a character in the plan or the world`);
        return [`${a.expr}.MoveTo(${dest.expr})`];
      }
      case 'sound': {
        const snd = this.findLoose(['SNDR'], e.what);
        if (!snd) return skip(`no sound like “${e.what}” in the load order`);
        const at = e.targetKey ? thing() : null;
        return [`(${formExpression(snd)} as Sound).Play(${at?.expr ?? 'Game.GetPlayer()'})`];
      }
      case 'weather': {
        if (/^(clear|normal|reset|default|none)$/i.test(e.what?.trim() ?? '')) return ['Weather.ReleaseOverride()'];
        const w = this.findLoose(['WTHR'], e.what);
        if (!w) return skip(`no weather like “${e.what}” in the load order`);
        return [`(${formExpression(w)} as Weather).ForceActive(True)`];
      }
      case 'message':
        return [`Debug.Notification(${quoted(e.what ?? '')})`];
      case 'startQuest': {
        const q = this.findForm(['QUST'], e.what);
        if (!q) return skip(`no quest called “${e.what}”`);
        return [`(${formExpression(q)} as Quest).Start()`];
      }
      case 'fade':
        return null;
    }
  }

  /** Things a plan first shows (rather than hides) start out hidden, so showing them means something. */
  private hideUntilShown(s: BuildSession): void {
    const firstByTarget = new Map<string, PlanEvent>();
    for (const e of [...s.plan.events].sort((a, b) => a.atStage - b.atStage))
      if ((e.kind === 'show' || e.kind === 'hide') && e.targetKey && !firstByTarget.has(e.targetKey)) firstByTarget.set(e.targetKey, e);
    for (const [key, e] of firstByTarget) {
      if (e.kind !== 'show') continue;
      const ref = this.placedRefOf(s, key);
      if (!ref) {
        s.report.notes.push(`${key} is shown at stage ${e.atStage}; make sure it starts hidden (Initially Disabled) so it can appear.`);
        continue;
      }
      if (this.ws.summary(ref) && !(this.ws.view(ref)!.flags & RecordFlags.InitiallyDisabled)) {
        this.ws.setFlags(ref, RecordFlags.InitiallyDisabled);
        s.report.notes.push(`${this.label(ref)} starts hidden and appears at stage ${e.atStage}.`);
      }
    }
  }

  /** The placed reference behind a plan key or Editor ID (the character's placed copy for characters). */
  private placedRefOf(s: BuildSession, key: string): FormKey | undefined {
    if (s.placedItems.has(key)) return s.placedItems.get(key);
    const base = s.npcs.get(key) ?? this.findForm(['NPC_'], key);
    if (base) return this.ws.search({ sigs: ['ACHR'], limit: 100_000 }).items.find((r) => (this.ws.view(r.formKey)?.data as any)?.base === base)?.formKey;
    const ref = this.findForm(['REFR', 'ACHR'], key);
    return ref && parseFormKey(ref).plugin === this.ws.activeName ? ref : undefined;
  }

  private encounterLabel(s: BuildSession, key: string): string {
    const e = s.plan.encounters.find((x) => x.key === key);
    return e ? `${e.count} ${e.what}` : key;
  }

  /** A group of enemies from the load order, spread around a place (persistent, so the quest can tell when they're all dead). */
  private async placeEncounter(s: BuildSession, e: PlanEncounter): Promise<void> {
    const cell = s.cells.get(e.locationKey) ?? this.findForm(['CELL'], e.locationKey);
    if (!cell) {
      s.report.warnings.push(`${e.count} ${e.what}: there's no place called “${e.locationKey}” to put them.`);
      return;
    }
    const base = this.findLoose(['NPC_'], e.what);
    if (!base) {
      s.report.warnings.push(`${e.count} ${e.what}: no character like “${e.what}” in the load order to place.`);
      return;
    }
    const refs: FormKey[] = [];
    const n = Math.max(1, Math.min(12, e.count));
    for (let i = 0; i < n; i++) {
      const spot = await s.placer.actorSpot(cell, e.spot);
      refs.push(this.world.placeReference(cell, base, { position: spot.position, rotation: { x: 0, y: 0, z: spot.yaw } }, { persistent: true }));
    }
    s.encounters.set(e.key, refs);
    s.report.created.push({ kind: 'placed', formKey: refs[0]!, label: `${n} × ${this.label(base)} in ${this.label(cell)}${e.spot ? `, ${e.spot}` : ''}` });
    if (!/^lvl/i.test(this.ws.summary(base)?.editorId ?? '')) s.report.notes.push(`${e.count} ${e.what} are ${this.label(base)}, a fixed character rather than a levelled one; pick a “Lvl…” character if they should match the player's level.`);
  }

  /** Ways the quest fails: a character dying, or a time limit. */
  private async buildFailures(s: BuildSession): Promise<void> {
    const quest = s.quest!;
    const endings = s.plan.stages.filter((x) => x.completesQuest).map((x) => x.index);
    for (const f of s.plan.failures) {
      if (f.kind === 'death') {
        const who = (f.targetKey && s.npcs.get(f.targetKey)) || this.findForm(['NPC_', 'ACHR'], f.targetKey);
        if (!who) {
          s.report.warnings.push(`“${f.note}” was left out: there's no character called “${f.targetKey}”.`);
          continue;
        }
        s.failParts.push(await this.graphs.addFailOnDeath(quest, who, f.failStage, endings));
        s.report.notes.push(`The quest fails (stage ${f.failStage}) if ${this.label(who)} dies before it's finished.`);
      } else {
        const from = f.fromStage ?? startStageOf(s.plan);
        await this.graphs.setTimeLimit(quest, { days: f.days ?? 1, fromStage: from, failStage: f.failStage, unlessDone: endings });
        s.failParts.push({ timeLimit: true });
        s.report.notes.push(`The quest fails (stage ${f.failStage}) if it isn't finished ${f.days} in-game day${f.days === 1 ? '' : 's'} after stage ${from}.`);
      }
    }
  }

  private async removeFailures(s: BuildSession): Promise<void> {
    for (const p of s.failParts) {
      if ('timeLimit' in p) await this.graphs.setTimeLimit(s.quest!, null);
      else await this.graphs.removeFailOnDeath(s.quest!, p);
    }
    s.failParts = [];
  }

  /** What starts the quest when it doesn't start with the game. */
  private async buildStart(s: BuildSession): Promise<void> {
    const sw = s.plan.startsWhen;
    if (!sw || sw.kind === 'game') return;
    const quest = s.quest!;
    if (s.plan.startsWithGame) {
      s.report.notes.push('The quest starts with the game, so “starts when…” was left out.');
      return;
    }
    if (sw.kind === 'afterQuest') {
      const other = this.findForm(['QUST'], sw.quest);
      if (!other) return void s.report.warnings.push(`The quest should start after “${sw.quest}”, but there's no quest called that. Start it from a trigger or another quest instead.`);
      if (parseFormKey(other).plugin !== this.ws.activeName) return void s.report.warnings.push(`${this.label(other)} comes from ${parseFormKey(other).plugin}; starting this quest from its stage would mean rewriting that quest's script, so it was left out. Start it from something in your plugin instead (a place, an item, or a quest of yours).`);
      const stages = this.quests.quest(other).stages;
      const stage = sw.stage ?? stages.find((x) => x.logEntries.some((l) => (l.flags & 1) !== 0))?.index ?? Math.max(...stages.map((x) => x.index));
      if (!stages.some((x) => x.index === stage)) return void s.report.warnings.push(`${this.label(other)} has no stage ${stage}, so nothing starts this quest yet.`);
      s.starts.push(await this.graphs.addStart(quest, { kind: 'afterQuest', quest: other, stage }));
      s.report.notes.push(`The quest starts when ${this.label(other)} reaches stage ${stage}.`);
      return;
    }
    const key = sw.targetKey ?? '';
    if (s.inContainer.has(key)) return void s.report.warnings.push(`${key} is inside a container, so picking it up or reading it can't start the quest (the quest that would create it isn't running yet). Put it on furniture instead.`);
    const target = s.placedItems.get(key) ?? s.cells.get(key) ?? this.findForm(['CELL', 'REFR', 'ACHR'], key);
    if (!target) return void s.report.warnings.push(`The quest should start when the player ${({ arrive: 'enters', read: 'reads', pickup: 'picks up', activate: 'uses' } as const)[sw.kind]} “${key}”, but it isn't placed anywhere, so nothing starts the quest yet.`);
    if (this.ws.summary(target)?.sig !== 'CELL' && parseFormKey(target).plugin !== this.ws.activeName) s.report.warnings.push(`The start trigger goes on ${this.label(target)} from ${parseFormKey(target).plugin}, which other mods that change it will conflict with.`);
    s.starts.push(await this.graphs.addStart(quest, { kind: sw.kind, target }));
    s.report.notes.push(`The quest starts when the player ${({ arrive: 'enters', read: 'reads', pickup: 'picks up', activate: 'uses' } as const)[sw.kind]} ${this.label(target)}.`);
  }

  /** What moves the quest on: one step. */
  private async buildStep(s: BuildSession, st: QuestPlan['steps'][number]): Promise<void> {
    const quest = s.quest!;
    if (st.kind === 'talk') {
      const said = s.plan.conversations.some((c) => new RegExp(`\\[stage\\s+${st.to}\\]`, 'i').test(c.screenplay));
      if (!said) s.report.warnings.push(`Nothing said in a conversation sets stage ${st.to} (“${st.note}”). Add [stage ${st.to}] to the line that should.`);
      return;
    }
    if (st.kind === 'script') {
      if (st.from === null) s.report.warnings.push(`“${st.note}” should happen right away, but it doesn't say after which stage; it was left out.`);
      else await this.graphs.addEdge(quest, { from: st.from, to: st.to, kind: 'script' });
      return;
    }
    if (st.kind === 'clear') {
      const refs = s.encounters.get(st.targetKey ?? '') ?? [];
      if (!refs.length) {
        s.report.warnings.push(`“${st.note}” can't be detected: the group “${st.targetKey}” wasn't placed.`);
        return;
      }
      await this.graphs.addClearEdge(quest, refs, { from: st.from, to: st.to, label: this.encounterLabel(s, st.targetKey!) });
      return;
    }
    if (st.targetKey && s.inContainer.has(st.targetKey)) {
      await this.graphs.addAliasEdge(quest, this.aliasOf(s, st.targetKey)!, { from: st.from, to: st.to, kind: st.kind });
      return;
    }
    const target = this.stepTarget(s, st);
    if (!target) {
      s.report.warnings.push(`“${st.note}” (${st.kind}) can't be detected: ${st.targetKey ?? 'its target'} isn't placed in the world. Set stage ${st.to} from a conversation instead (for example with [gives …] and [stage ${st.to}]).`);
      return;
    }
    await this.graphs.addEdge(quest, { from: st.from, to: st.to, kind: st.kind, target } as NewQuestEdge);
  }

  private stepTarget(s: BuildSession, st: QuestPlan['steps'][number]): FormKey | undefined {
    if (!st.targetKey) return undefined;
    return s.npcs.get(st.targetKey) ?? s.placedItems.get(st.targetKey) ?? (s.inContainer.has(st.targetKey) ? s.items.get(st.targetKey) : undefined) ?? s.cells.get(st.targetKey);
  }

  /**
   * Each routine activity becomes a package: everyday ones on the character,
   * quest-bound ones (follow, forcegreet, limited to some stages) on their quest alias.
   */
  private async buildRoutines(s: BuildSession, characters: PlanCharacter[]): Promise<void> {
    const quest = s.quest;
    for (const c of characters) {
      if (!c.routine?.length) continue;
      const npc = s.npcs.get(c.key)!;
      const base: FormKey[] = [];
      const alias: FormKey[] = [];
      for (const [n, r] of c.routine.entries()) {
        let location: PackageSpec['location'] = { kind: 'editor' };
        if (r.where) {
          const cell = s.cells.get(r.where) ?? this.findForm(['CELL'], r.where);
          if (cell) location = { kind: 'cell', cell };
          else s.report.notes.push(`${c.name}: no place called “${r.where}”, so they ${r.activity} around where they stand.`);
        }
        const questBound = !!quest && (r.fromStage !== null || r.untilStage !== null || r.activity === 'follow' || r.activity === 'forcegreet');
        let topic: FormKey | undefined;
        if (r.activity === 'forcegreet' && quest) {
          topic = this.quests.miscTopic(quest, 'forcegreet', `${s.prefix}${pascal(c.name)}ForceGreet`);
          this.quests.addResponse(topic, { text: r.line ?? '', speaker: npc, conditions: stageConditions(quest, r.fromStage, r.untilStage) });
        }
        try {
          const pk = createPackage(this.ws, {
            editorId: this.ws.uniqueEditorId(`${s.prefix}${pascal(c.name)}${pascal(r.activity)}${n + 1}`),
            activity: r.activity,
            hours: r.hours,
            conditions: questBound && quest ? stageConditions(quest, r.fromStage, r.untilStage) : [],
            location,
            topic,
            ownerQuest: questBound && quest ? quest : undefined,
          });
          (questBound ? alias : base).push(pk);
          if (topic) alias.push(topic);
          s.report.created.push({ kind: 'package', formKey: pk, label: `${c.name}: ${this.characters.describe({ ...c, spot: null, outfit: null, inventory: [], factions: [], className: null, level: null, look: null, essential: null, existing: null, routine: [r], combat: null, roles: null, relationships: [] }).join('')}` });
        } catch (e) {
          if (e instanceof WorkspaceError) s.report.warnings.push(`${c.name}: ${e.message}`);
          else throw e;
        }
      }
      const packs = alias.filter((k) => this.ws.summary(k)?.sig === 'PACK');
      s.packages.set(c.key, { base, alias });
      if (base.length) {
        // Timed activities first: a character does the first package whose time and conditions fit.
        const timed = (k: FormKey) => ((this.ws.view(k)!.data as any).schedule?.hour ?? -1) >= 0;
        const ordered = [...base.filter(timed), ...base.filter((k) => !timed(k))];
        this.ws.editRecord(npc, (d: any) => void (d.packages = [...ordered, ...(d.packages ?? [])]), `${c.name}'s routine`);
        if (parseFormKey(npc).plugin !== this.ws.activeName) s.report.notes.push(`${c.name}'s new routine comes before their old packages, and overrides them as a character from ${parseFormKey(npc).plugin}.`);
      }
      if (packs.length && quest) {
        const id = this.graphs.aliasFor(quest, npc);
        this.ws.editRecord(quest, (d: any) => {
          const a = (d.aliases ?? []).find((x: any) => x.value?.id === id);
          if (a) a.value.packages = [...(a.value.packages ?? []), ...packs];
        });
        s.report.notes.push(`${c.name}'s quest behaviour is on their quest alias, so it only applies while the quest runs.`);
      }
    }
  }

  /** Take a character's routine back out (their packages unlinked; forcegreet topics removed). */
  private removeRoutine(s: BuildSession, key: string): void {
    const rec = s.packages.get(key);
    if (!rec) return;
    const npc = s.npcs.get(key);
    if (npc && rec.base.length) this.ws.editRecord(npc, (d: any) => void (d.packages = (d.packages ?? []).filter((k: FormKey) => !rec.base.includes(k))));
    if (s.quest && rec.alias.length)
      this.ws.editRecord(s.quest, (d: any) => {
        for (const a of d.aliases ?? []) if (a.value?.packages) a.value.packages = a.value.packages.filter((k: FormKey) => !rec.alias.includes(k));
      });
    for (const k of [...rec.base, ...rec.alias]) if (this.ws.exists(k) && parseFormKey(k).plugin === this.ws.activeName) this.ws.deleteRecord(k);
    s.packages.delete(key);
  }

  // ---------------------------------------------------------------- updating

  private recordPath(): string {
    return joinPath(this.ws.options.outputDir, 'TES5EnvEditor', `${this.ws.activeName ?? 'plugin'}.plans.json`);
  }

  private async readRecords(): Promise<Record<string, BuildRecord>> {
    await this.ws.filesSettled();
    try {
      return JSON.parse(new TextDecoder().decode(await this.ws.fs.readFile(this.recordPath())));
    } catch {
      return {};
    }
  }

  private async saveRecord(s: BuildSession): Promise<void> {
    const all = await this.readRecords();
    const obj = <T>(m: Map<string, T>) => Object.fromEntries(m) as Record<string, T>;
    all[s.quest!] = {
      version: 1,
      quest: s.quest!,
      prefix: s.prefix,
      plan: s.plan,
      cells: obj(s.cells),
      npcs: obj(s.npcs),
      items: obj(s.items),
      placedItems: obj(s.placedItems),
      inContainer: obj(s.inContainer),
      containerBases: obj(s.containerBases),
      conversations: obj(s.conversations),
      stageLines: s.stageLines,
      packages: obj(s.packages),
      starts: s.starts,
      failParts: s.failParts,
      encounters: obj(s.encounters),
    };
    // Written as part of the edit, so undo and redo keep the record in step with the plugin.
    const path = this.recordPath();
    let before: Uint8Array | null = null;
    try {
      before = await this.ws.fs.readFile(path);
    } catch {
      before = null;
    }
    const after = new TextEncoder().encode(JSON.stringify(all, null, 1));
    await this.ws.fs.mkdir(joinPath(this.ws.options.outputDir, 'TES5EnvEditor'));
    await this.ws.fs.writeFile(path, after);
    this.ws.trackFileChange({ path, before, after });
  }

  /** The record of how a quest was built from a plan (null when it wasn't, or was undone). */
  async record(quest: FormKey): Promise<BuildRecord | null> {
    const r = (await this.readRecords())[quest];
    if (!r || !this.ws.exists(quest)) return null;
    return r;
  }

  /**
   * The plan for an existing quest: exactly as it was built when it came from
   * a plan, otherwise read from the quest (stages, journal, objectives, the
   * quest map's connections, its characters and its dialogue as a script).
   */
  async planFor(quest: FormKey): Promise<{ plan: QuestPlan; fromRecord: boolean }> {
    const r = await this.record(quest);
    if (r) return { plan: normalizePlan(structuredClone(r.plan)), fromRecord: true };
    return { plan: await this.planFromQuest(quest), fromRecord: false };
  }

  private async planFromQuest(quest: FormKey): Promise<QuestPlan> {
    const q = this.quests.quest(quest);
    const g = await this.graphs.graph(quest);
    const keyOf = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'thing';
    const characters: PlanCharacter[] = [];
    const items: PlanItem[] = [];
    const locations: PlanLocation[] = [];
    const keys = new Map<FormKey, string>();
    const unique = (base: string) => {
      let k = base;
      for (let i = 2; [...keys.values()].includes(k); i++) k = `${base}${i}`;
      return k;
    };
    for (const a of q.aliases) {
      const f = a.fill as Record<string, any>;
      const target: FormKey | undefined = f.actor ?? f.reference ?? f.object;
      if (!target || keys.has(target)) continue;
      const sum = this.ws.summary(target);
      const name = sum?.name ?? sum?.editorId ?? a.name;
      if (sum?.sig === 'NPC_') {
        const key = unique(keyOf(name));
        keys.set(target, key);
        characters.push({ key, name, existing: sum.editorId ?? target, basedOn: null, sex: null, race: null, role: a.name, appearance: '', look: null, voice: null, locationKey: null, spot: null, essential: null, className: null, level: null, outfit: null, factions: [], inventory: [], routine: [], combat: null, roles: null, relationships: [] });
      }
    }
    // People who speak in its dialogue are characters of the quest too.
    for (const i of this.dialogue.graph(quest).infos) {
      const sum = i.speaker ? this.ws.summary(i.speaker) : undefined;
      if (!i.speaker || !sum || sum.sig !== 'NPC_' || keys.has(i.speaker)) continue;
      const name = sum.name ?? sum.editorId ?? i.speaker;
      const key = unique(keyOf(name));
      keys.set(i.speaker, key);
      characters.push({ key, name, existing: sum.editorId ?? i.speaker, basedOn: null, sex: null, race: null, role: 'Speaks in the quest', appearance: '', look: null, voice: null, locationKey: null, spot: null, essential: null, className: null, level: null, outfit: null, factions: [], inventory: [], routine: [], combat: null, roles: null, relationships: [] });
    }
    const stages = g.nodes.map((n) => ({ index: n.stage, journal: n.text, startsQuest: n.startUp, completesQuest: n.completesQuest, failsQuest: n.failsQuest }));
    const objectives = g.objectives.map((o) => ({ index: o.index, text: o.text, shownAtStage: g.nodes.find((n) => n.shows.includes(o.index))?.stage ?? stages[0]?.index ?? 0, completedAtStage: g.nodes.find((n) => n.completes.includes(o.index))?.stage ?? null, targetKey: null }));
    const steps = g.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind === 'hit' || e.kind === 'load' ? ('script' as const) : (e.kind as PlanStep['kind']), targetKey: e.target ? (keys.get(e.target) ?? null) : null, note: e.label }));
    const screenplay = this.dialogue.toScreenplay(quest).trim();
    const first = g.starts.find((x) => x.kind !== 'game');
    const startsWhen: QuestPlan['startsWhen'] =
      first?.kind === 'afterQuest'
        ? { kind: 'afterQuest', targetKey: null, quest: this.ws.summary(first.quest)?.editorId ?? first.quest, stage: first.stage }
        : first?.kind === 'trigger' && ['arrive', 'read', 'pickup', 'activate'].includes(first.event)
          ? { kind: first.event as 'arrive', targetKey: this.ws.summary(first.ref)?.editorId ?? first.ref, quest: null, stage: null }
          : null;
    return {
      title: q.name ?? q.editorId ?? 'Quest',
      editorId: q.editorId ?? 'Quest',
      summary: '',
      startsWithGame: (q.flags & QuestFlag.StartGameEnabled) !== 0,
      startsWhen,
      characters,
      locations,
      items,
      encounters: [],
      stages,
      objectives,
      steps,
      conversations: screenplay ? [{ title: 'Existing dialogue', screenplay }] : [],
      rewards: [],
      animations: [],
      events: [],
      failures: g.timeLimit ? [{ kind: 'timeLimit', targetKey: null, days: g.timeLimit.days, fromStage: g.timeLimit.fromStage, failStage: g.timeLimit.failStage, note: 'Time limit' }] : [],
      assumptions: [],
      questions: [],
    };
  }

  /** What an update would change, in words (nothing is changed). */
  async previewUpdate(quest: FormKey, next: QuestPlan): Promise<string[]> {
    const { plan: old, fromRecord } = await this.planFor(quest);
    return describeDiff(old, next, fromRecord);
  }

  /**
   * Change an existing quest to match a revised plan, one undo step. Only the
   * differences are applied, so edits made by hand elsewhere are kept.
   * Dialogue is replaced only where it came from the plan.
   */
  async update(quest: FormKey, next: QuestPlan, opts: { seed?: number } = {}): Promise<QuestBuildReport> {
    const resolution = this.check(next);
    const record = await this.record(quest);
    const { plan: old, fromRecord } = await this.planFor(quest);
    return this.ws.transactionAsync(`Update quest ${this.ws.view(quest)?.editorId ?? ''}`, async () => {
      const base: BuildRecord = record ?? { version: 1, quest, prefix: old.editorId, plan: old, cells: {}, npcs: Object.fromEntries(old.characters.map((c) => [c.key, this.findForm(['NPC_'], c.existing)!])), items: {}, placedItems: {}, inContainer: {}, containerBases: {}, conversations: {}, stageLines: [], packages: {} };
      const s = this.session(next, resolution, opts.seed ?? 1, base);
      s.report.notes = next.assumptions.filter((a) => !old.assumptions.includes(a)).map((a) => `Assumed: ${a}`);
      await this.applyDiff(s, old, fromRecord);
      await this.saveRecord(s);
      await this.finishChecks(s, quest);
      return s.report;
    });
  }

  private async applyDiff(s: BuildSession, old: QuestPlan, fromRecord: boolean): Promise<void> {
    const quest = s.quest!;
    const next = s.plan;
    const say = (t: string) => s.report.updated.push(t);
    // The quest itself.
    if (next.title !== old.title) {
      this.ws.editRecord(quest, (d: any) => void (d.name = next.title));
      say(`Renamed the quest “${next.title}”`);
    }
    if (next.startsWithGame !== old.startsWithGame) {
      this.graphs.setStartGameEnabled(quest, next.startsWithGame);
      say(next.startsWithGame ? 'The quest now starts with the game' : 'The quest no longer starts with the game');
    }
    const startChanged = JSON.stringify(old.startsWhen ?? null) !== JSON.stringify(next.startsWhen ?? null) || next.startsWithGame !== old.startsWithGame;
    // Stages: removed ones lose their connections first.
    const oldStages = new Map(old.stages.map((x) => [x.index, x]));
    const newStages = new Map(next.stages.map((x) => [x.index, x]));
    for (const [index] of oldStages) {
      if (newStages.has(index)) continue;
      for (const e of (await this.graphs.graph(quest)).edges.filter((e) => e.from === index || e.to === index)) await this.graphs.removeEdge(quest, e);
      this.quests.removeStage(quest, index);
      say(`Removed stage ${index}`);
    }
    const start = startStageOf(next);
    for (const [index, st] of newStages) {
      const was = oldStages.get(index);
      if (!was) {
        this.addStage(quest, st, start);
        say(`Added stage ${index}`);
        continue;
      }
      if (was.journal !== st.journal) {
        this.quests.setStageLog(quest, index, 0, st.journal);
        say(`Rewrote stage ${index}'s journal entry`);
      }
      if (was.completesQuest !== st.completesQuest || was.failsQuest !== st.failsQuest || was.startsQuest !== st.startsQuest) {
        this.ws.editRecord(quest, (d: any) => {
          const x = d.stages.find((y: any) => y.index.index === index);
          x.index.flags = index === start ? x.index.flags | 2 : x.index.flags & ~2;
          x.logEntries ??= [];
          if (!x.logEntries[0]) x.logEntries.push({ flags: 0, text: '' });
          x.logEntries[0].flags = (st.completesQuest ? 1 : 0) | (st.failsQuest ? 2 : 0);
        });
        say(`Changed what stage ${index} does (starts, completes or fails the quest)`);
      }
    }
    // New places, items and characters; changed characters.
    const keysOf = <T extends { key: string }>(list: T[]) => new Map(list.map((x) => [x.key, x]));
    const oldChars = keysOf(old.characters);
    const addedPlaces = next.locations.filter((l) => !s.cells.has(l.key));
    for (const l of addedPlaces) {
      this.buildLocation(s, l);
      say(`Added the place ${l.name}`);
    }
    await this.connectPlaces(s, addedPlaces);
    const newItems = next.items.filter((i) => !s.items.has(i.key));
    for (const i of newItems) {
      this.buildItem(s, i);
      say(`Added the item ${i.name}`);
    }
    for (const c of next.characters) {
      const was = oldChars.get(c.key);
      if (!was || !s.npcs.has(c.key)) {
        this.buildCharacter(s, c);
        this.buildRelationships(s, [c]);
        await this.placeCharacter(s, c);
        say(`Added ${c.name}`);
        continue;
      }
      const delta = characterDelta(was, c);
      if (delta) {
        this.characters.apply(s.npcs.get(c.key)!, delta, this.changeCtx(s, false));
        this.buildRelationships(s, [delta]);
        say(`Changed ${c.name}: ${this.characters.describe(delta).join('; ')}`);
      }
      if (JSON.stringify(was.routine ?? []) !== JSON.stringify(c.routine ?? [])) {
        this.removeRoutine(s, c.key);
        await this.buildRoutines(s, [c]);
        say(`Changed ${c.name}'s routine`);
      }
    }
    for (const c of old.characters) if (!next.characters.some((x) => x.key === c.key)) s.report.notes.push(`${c.name} is no longer in the plan, but was left in the plugin (delete them yourself if they're not needed).`);
    for (const c of next.characters) if (!oldChars.has(c.key) && c.routine?.length) await this.buildRoutines(s, [c]);
    for (const e of next.encounters) if (!s.encounters.has(e.key)) {
      await this.placeEncounter(s, e);
      say(`Added ${e.count} ${e.what}`);
    }
    for (const e of old.encounters ?? []) if (!next.encounters.some((x) => x.key === e.key)) s.report.notes.push(`${e.count} ${e.what} are no longer in the plan, but were left where they are (delete them in the World tab if they're not needed).`);
    await this.placeItems(s, newItems);
    // Objectives.
    const oldObj = new Map(old.objectives.map((o) => [o.index, o]));
    const newObj = new Map(next.objectives.map((o) => [o.index, o]));
    for (const [index, o] of oldObj)
      if (!newObj.has(index)) {
        this.ws.editRecord(quest, (d: any) => void (d.objectives = (d.objectives ?? []).filter((x: any) => x.index !== index)));
        say(`Removed objective ${index} (“${o.text}”)`);
      }
    for (const [index, o] of newObj) {
      const was = oldObj.get(index);
      if (!was) {
        this.addObjective(s, o);
        say(`Added objective “${o.text}”`);
      } else if (was.text !== o.text || was.targetKey !== o.targetKey) {
        const alias = this.aliasOf(s, o.targetKey);
        this.ws.editRecord(quest, (d: any) => {
          const x = d.objectives.find((y: any) => y.index === index);
          x.text = o.text;
          x.targets = alias !== undefined ? [{ target: { alias, ignoresLocks: 0, unused: new Uint8Array(3) } }] : [];
        });
        say(`Changed objective ${index} to “${o.text}”`);
      }
    }
    if (JSON.stringify(old.objectives.map((o) => [o.index, o.shownAtStage, o.completedAtStage])) !== JSON.stringify(next.objectives.map((o) => [o.index, o.shownAtStage, o.completedAtStage]))) {
      await this.syncStageObjectives(s);
      say('Updated when objectives are shown and completed');
    }
    // Conversations: those from the plan are replaced when they change; dialogue made by hand is kept.
    const oldConv = new Map(old.conversations.map((c) => [c.title, c]));
    const newConv = new Map(next.conversations.map((c) => [c.title, c]));
    for (const [title, conv] of oldConv) {
      const now = newConv.get(title);
      if (now && now.screenplay === conv.screenplay) continue;
      if (!fromRecord || !s.conversations.has(title)) {
        if (!now) s.report.notes.push(`“${title}” was left as it is: it wasn't made from a plan, so it isn't removed automatically.`);
        continue;
      }
      await this.removeConversation(s, title);
      if (!now) say(`Removed the conversation “${title}”`);
    }
    for (const [title, conv] of newConv) {
      const was = oldConv.get(title);
      if (was && was.screenplay === conv.screenplay) continue;
      if (was && !fromRecord) {
        s.report.notes.push(`“${title}” was changed in the plan, but the quest's own dialogue was kept; add the new lines with Dialogue → Write as script.`);
        continue;
      }
      await this.buildConversation(s, conv);
      say(was ? `Rewrote the conversation “${title}”` : `Added the conversation “${title}”`);
    }
    // Steps.
    const stepKey = (x: QuestPlan['steps'][number]) => `${x.from}|${x.to}|${x.kind}|${x.targetKey}`;
    const oldSteps = new Map(old.steps.map((x) => [stepKey(x), x]));
    const newSteps = new Map(next.steps.map((x) => [stepKey(x), x]));
    for (const [k, st] of oldSteps) {
      if (newSteps.has(k) || st.kind === 'talk') continue;
      const g = await this.graphs.graph(quest);
      const target = this.stepTarget(s, st);
      const edge = g.edges.find((e) => e.from === st.from && e.to === st.to && e.kind === st.kind && (st.kind === 'script' || !target || e.target === target || e.target === undefined));
      if (edge) {
        await this.graphs.removeEdge(quest, edge);
        say(`Removed “${st.note}”`);
      }
    }
    for (const [k, st] of newSteps) {
      if (oldSteps.has(k)) continue;
      await this.buildStep(s, st);
      if (st.kind !== 'talk') say(`Added “${st.note}”`);
    }
    if (JSON.stringify(old.failures ?? []) !== JSON.stringify(next.failures ?? [])) {
      if (!s.failParts.length && (await this.graphs.timeLimit(quest))) s.failParts.push({ timeLimit: true });
      await this.removeFailures(s);
      await this.buildFailures(s);
      say('Updated how the quest fails');
    }
    if (startChanged) {
      // A quest made by hand: what starts it is read from the quest.
      if (!s.starts.length) s.starts = (await this.graphs.graph(quest)).starts.flatMap((x): StartPlace[] => (x.kind === 'trigger' ? [{ ref: x.ref }] : x.kind === 'afterQuest' ? [{ quest: x.quest, stage: x.stage, line: this.graphs.startLine(quest) }] : []));
      const had = s.starts.length;
      for (const w of s.starts) await this.graphs.removeStart(quest, w);
      s.starts = [];
      await this.buildStart(s);
      if (had || s.starts.length) say('Changed what starts the quest');
    }
    // Stage-script lines: gestures, rewards and world events.
    const listOf = (p: QuestPlan, why: 'gesture' | 'reward' | 'event') => JSON.stringify(why === 'gesture' ? p.animations : why === 'reward' ? p.rewards : (p.events ?? []));
    for (const why of ['gesture', 'reward', 'event'] as const) {
      if (listOf(old, why) === listOf(next, why)) continue;
      await this.removeStageLines(s, why);
      await this.buildStageLines(s, why);
      say({ gesture: 'Updated the animations at quest stages', reward: 'Updated the rewards', event: 'Updated the events at quest stages' }[why]);
    }
    if (!s.report.updated.length) say('Nothing needed changing');
  }

  private async removeStageLines(s: BuildSession, why: string): Promise<void> {
    for (const l of s.stageLines.filter((x) => x.why === why)) await this.graphs.removeStageLine(s.quest!, l.stage, l.line);
    s.stageLines = s.stageLines.filter((x) => x.why !== why);
  }

  private async removeConversation(s: BuildSession, title: string): Promise<void> {
    const keys = s.conversations.get(title) ?? [];
    // Scenes first (their stage-script start lines go with them), then infos and topics.
    for (const k of keys.filter((x) => this.ws.summary(x)?.sig === 'SCEN')) if (this.ws.exists(k)) this.ws.deleteRecord(k);
    await this.removeStageLines(s, `conversation:${title}`);
    for (const k of keys.filter((x) => this.ws.summary(x)?.sig === 'INFO')) if (this.ws.exists(k)) this.ws.deleteRecord(k);
    for (const k of keys.filter((x) => this.ws.summary(x)?.sig === 'DIAL')) {
      if (!this.ws.exists(k)) continue;
      for (const i of this.quests.infos(k)) this.ws.deleteRecord(i.formKey);
      const branch = (this.ws.view(k)?.data as any)?.branch as FormKey | undefined;
      this.ws.deleteRecord(k);
      if (branch && this.ws.exists(branch) && parseFormKey(branch).plugin === this.ws.activeName && (this.ws.view(branch)?.data as any)?.startingTopic === k) this.ws.deleteRecord(branch);
    }
    s.conversations.delete(title);
  }

  private sceneHooks() {
    return { aliasFor: (q: FormKey, npc: FormKey) => this.graphs.aliasFor(q, npc), appendStageCode: (q: FormKey, stage: number, lines: string[]) => this.graphs.appendStageCode(q, stage, lines) };
  }

  private finishNotes(report: QuestBuildReport): void {
    const created = report.created.filter((c) => c.kind === 'character');
    if (created.length) report.notes.push(`New characters get their face files (FaceGen) when you save, or from the Release tab's Character faces — no Creation Kit needed.`);
  }

  private createCharacter(c: PlanCharacter, template: FormKey, prefix: string, random: () => number, report: QuestBuildReport): FormKey {
    const editorId = this.ws.uniqueEditorId(`${prefix}${pascal(c.name)}`);
    const npc = this.ws.duplicateRecord(template, editorId);
    const voice = this.voice(c.voice);
    if (c.voice && !voice) report.notes.push(`${c.name}: no voice type called “${c.voice}”, so they use ${this.label(template)}'s.`);
    const tmpl = this.ws.view(template)!.data as Record<string, any>;
    const female = c.sex ? c.sex === 'female' : ((tmpl.config?.flags ?? 0) & FEMALE_FLAG) !== 0;
    if (c.sex && female !== (((tmpl.config?.flags ?? 0) & FEMALE_FLAG) !== 0)) report.warnings.push(`${c.name}: no ${c.sex} character to copy, so their head and hair come from ${this.label(template)}. Check their face in the Characters tab.`);
    const race = this.race(c.race);
    if (c.race && !race) report.notes.push(`${c.name}: no race called “${c.race}”, so they're ${this.label(tmpl.race)}.`);
    this.ws.editRecord(
      npc,
      (d: any) => {
        d.name = c.name;
        d.config = { ...(d.config ?? {}) };
        let flags = (d.config.flags ?? 0) | UNIQUE;
        flags = c.essential ? flags | ESSENTIAL : flags & ~ESSENTIAL;
        // The original's factions (a guard's crime faction, a family) don't belong to the copy; the plan adds its own.
        d.factions = [];
        flags = female ? flags | FEMALE_FLAG : flags & ~FEMALE_FLAG;
        d.config.flags = flags;
        if (voice) d.voice = voice;
        if (race) d.race = race;
        // A copy keeps the original's routine, which would walk them off to the original's home.
        delete d.packages;
        delete d.template;
        d.config.templateFlags = 0;
      },
      `Set up ${c.name}`,
    );
    const morphs = emptyMorphs();
    for (const [k] of FACE_MORPHS) morphs[k] = Math.round((random() - 0.5) * 0.8 * 100) / 100;
    this.npcs.setAppearance(npc, { morphs });
    report.created.push({ kind: 'character', formKey: npc, label: `${c.name} (${editorId}), copied from ${this.label(template)}` });
    report.notes.push(`${c.name} (“${c.appearance}”): hair, beard, build and colours were picked to match; the face shape is random — fine-tune it in the Characters tab. They stand where they're placed until you give them AI packages.`);
    return npc;
  }

  private createItem(i: PlanItem, template: FormKey, prefix: string, report: QuestBuildReport): FormKey {
    const editorId = this.ws.uniqueEditorId(`${prefix}${pascal(i.name)}`);
    const item = this.ws.duplicateRecord(template, editorId);
    this.ws.editRecord(
      item,
      (d: any) => {
        d.name = i.name;
        if (d.data && i.value !== null) d.data = { ...d.data, value: Math.max(0, Math.round(i.value)) };
        if (this.ws.summary(item)?.sig === 'BOOK') d.text = `<p align="center">${i.name}</p>`;
      },
      `Set up ${i.name}`,
    );
    const sig = this.ws.summary(item)?.sig;
    report.created.push({ kind: 'item', formKey: item, label: `${i.name} (${editorId}), copied from ${this.label(template)}` });
    if (sig !== ITEM_TEMPLATE_SIG[i.kind]) report.notes.push(`${i.name} should be a ${i.kind} but there's none to copy, so it's a misc item.`);
    if (sig === 'BOOK') report.notes.push(`${i.name}: write the book's text in the Objects tab.`);
    return item;
  }
}

/**
 * A planned conversation with the plan's keys and names replaced by Editor
 * IDs, so speakers and items resolve to exactly what was built.
 */
export function rewriteScreenplay(text: string, speakers: Map<string, string>, items: Map<string, string>): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      let out = line.replace(/^(\s*)([^:[\]]{1,60}?)(\s*:)/, (m, pad: string, who: string, colon: string) => {
        const id = speakers.get(who.trim().toLowerCase());
        return id ? `${pad}${id}${colon}` : m;
      });
      out = out.replace(/\[(gives|takes)\s+([^\]]*?)(\s*[x×]\s*\d+)?\]/gi, (m, verb: string, what: string, count?: string) => {
        const id = items.get(what.trim().toLowerCase());
        return id ? `[${verb} ${id}${count ?? ''}]` : m;
      });
      return out;
    })
    .join('\n');
}
