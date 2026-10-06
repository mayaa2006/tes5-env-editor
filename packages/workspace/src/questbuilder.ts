/**
 * Builds a whole quest from a plan (questplan.ts): characters, places and
 * items (found in the load order or made new), the quest with its stages,
 * journal and objectives, what moves it from stage to stage (triggers on
 * aliases), the conversations (through the screenplay importer) and the
 * rewards. It's one undo step; if anything fails, nothing is left behind.
 */
import { FACE_MORPHS, parseFormKey, type FormKey } from '@tes5/esp';
import { WorkspaceError, type Workspace } from './engine';
import { formExpression, resolveItem, type DialogueService } from './dialogue';
import { rng, type EnvironmentService } from './environment';
import { emptyMorphs, FEMALE_FLAG, type NpcService } from './npc';
import type { QuestService } from './quest';
import type { NewQuestEdge, QuestGraphService } from './questgraph';
import { validatePlan, type PlanCharacter, type PlanItem, type PlanLocation, type QuestPlan } from './questplan';
import { WorldService, type Vec3 } from './world';

const ESSENTIAL = 0x2;
const UNIQUE = 0x20;
const ITEM_TEMPLATE_SIG: Record<PlanItem['kind'], string> = { misc: 'MISC', other: 'MISC', book: 'BOOK', key: 'KEYM', gold: 'MISC' };

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
  error?: string;
}

export interface QuestBuildReport {
  quest: FormKey;
  editorId: string;
  created: { kind: PlanEntryKind | 'quest' | 'placed'; formKey: FormKey; label: string }[];
  reused: { kind: PlanEntryKind; formKey: FormKey; label: string }[];
  dialogue: { topics: number; responses: number };
  /** Things worth knowing (what was assumed or left for you). */
  notes: string[];
  /** Things that may not work as the plan intended. */
  warnings: string[];
  /** Problems the quest map finds in the result. */
  problems: string[];
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

  constructor(
    readonly ws: Workspace,
    readonly quests: QuestService,
    readonly graphs: QuestGraphService,
    readonly dialogue: DialogueService,
    readonly npcs: NpcService,
    readonly env: EnvironmentService,
  ) {
    this.world = new WorldService(ws);
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
      if (c.existing) {
        const k = this.findForm(['NPC_'], c.existing) ?? this.findForm(['NPC_'], c.name);
        out.push(k ? { kind: 'character', key: c.key, name: c.name, existing: k, template: null, text: `Uses ${this.label(k)}` } : { kind: 'character', key: c.key, name: c.name, existing: null, template: null, text: `No character called “${c.existing}”`, error: `${c.name}: no character called “${c.existing}” in the load order` });
        continue;
      }
      const t = this.npcTemplate(c, cache);
      out.push(t ? { kind: 'character', key: c.key, name: c.name, existing: null, template: t, text: `New, copied from ${this.label(t)}` } : { kind: 'character', key: c.key, name: c.name, existing: null, template: null, text: 'No character to copy from', error: `${c.name}: there's no character in the load order to copy` });
    }
    for (const l of plan.locations) {
      if (l.existing) {
        const k = this.findForm(['CELL'], l.existing) ?? this.findForm(['CELL'], l.name);
        out.push(k ? { kind: 'location', key: l.key, name: l.name, existing: k, template: null, text: `Uses ${this.label(k)}` } : { kind: 'location', key: l.key, name: l.name, existing: null, template: null, text: `No cell called “${l.existing}”`, error: `${l.name}: no cell called “${l.existing}” in the load order` });
      } else out.push({ kind: 'location', key: l.key, name: l.name, existing: null, template: null, text: 'New empty interior' });
    }
    for (const i of plan.items) {
      const k = i.kind === 'gold' ? resolveItem(this.ws, 'gold') : i.existing ? resolveItem(this.ws, i.existing) ?? resolveItem(this.ws, i.name) : undefined;
      if (k) {
        out.push({ kind: 'item', key: i.key, name: i.name, existing: k, template: null, text: i.kind === 'gold' ? 'Gold coins' : `Uses ${this.label(k)}` });
        continue;
      }
      if (i.existing) {
        out.push({ kind: 'item', key: i.key, name: i.name, existing: null, template: null, text: `No item called “${i.existing}”`, error: `${i.name}: no item called “${i.existing}” in the load order` });
        continue;
      }
      const t = this.itemTemplate(i.kind);
      out.push(t ? { kind: 'item', key: i.key, name: i.name, existing: null, template: t, text: `New, copied from ${this.label(t)}` } : { kind: 'item', key: i.key, name: i.name, existing: null, template: null, text: 'No item to copy from', error: `${i.name}: there's no item in the load order to copy` });
    }
    return out;
  }

  // ---------------------------------------------------------------- placing

  /** Somewhere sensible in a cell: characters on the floor around the middle, items on tables. */
  private spot(cell: FormKey, what: 'actor' | 'item', n: number): Vec3 {
    const refs = this.world.references(cell).filter((r) => !r.deleted && !r.disabled && !r.marker);
    if (!refs.length) return { x: n * 80, y: 0, z: what === 'item' ? 100 : 0 };
    if (what === 'item') {
      const tables = refs.filter((r) => /table|desk|counter|shelf/i.test(`${r.baseEditorId ?? ''} ${r.baseName ?? ''}`));
      const t = tables[n % Math.max(1, tables.length)];
      if (t) {
        const b = t.base ? this.env.boundsOf(t.base) : undefined;
        const top = t.transform.position.z + (b ? b.max.z * t.transform.scale : 80);
        return { x: t.transform.position.x + ((n * 17) % 30) - 15, y: t.transform.position.y + ((n * 11) % 20) - 10, z: top + 20 };
      }
    }
    const floor = Math.min(...refs.map((r) => r.transform.position.z));
    const c = refs.reduce((a, r) => ({ x: a.x + r.transform.position.x / refs.length, y: a.y + r.transform.position.y / refs.length }), { x: 0, y: 0 });
    const angle = n * 2.4 + (what === 'item' ? 1.2 : 0);
    const radius = what === 'item' ? 90 : 140 + 30 * Math.floor(n / 3);
    return { x: c.x + Math.cos(angle) * radius, y: c.y + Math.sin(angle) * radius, z: what === 'item' ? floor + 60 : floor };
  }

  // ---------------------------------------------------------------- building

  /** Build the quest. Throws (and changes nothing) if the plan has errors. */
  async build(plan: QuestPlan, opts: { seed?: number } = {}): Promise<QuestBuildReport> {
    const errors = validatePlan(plan).filter((i) => i.severity === 'error').map((i) => i.message);
    const resolution = this.resolve(plan);
    errors.push(...resolution.filter((r) => r.error).map((r) => r.error!));
    if (errors.length) throw new WorkspaceError(`The plan can't be built yet:\n${errors.map((e) => `• ${e}`).join('\n')}`);
    if (!this.ws.active) throw new WorkspaceError('Open or create a plugin first');
    return this.ws.transactionAsync(`Build quest ${plan.editorId}`, () => this.buildInner(plan, resolution, opts.seed ?? 1));
  }

  private async buildInner(plan: QuestPlan, resolution: PlanResolution[], seed: number): Promise<QuestBuildReport> {
    const random = rng(seed);
    const prefix = plan.editorId.replace(/[^A-Za-z0-9_]/g, '');
    const res = (kind: PlanEntryKind, key: string) => resolution.find((r) => r.kind === kind && r.key === key)!;
    const report: QuestBuildReport = { quest: '' as FormKey, editorId: '', created: [], reused: [], dialogue: { topics: 0, responses: 0 }, notes: [...plan.assumptions.map((a) => `Assumed: ${a}`)], warnings: [], problems: [] };

    // The quest and its stages first (items the player starts with are given in a stage script).
    let editorId = plan.editorId;
    if (this.ws.byEditorId(editorId)) {
      editorId = this.ws.uniqueEditorId(editorId);
      report.notes.push(`The Editor ID ${plan.editorId} was taken, so the quest is ${editorId}`);
    }
    const quest = this.quests.createQuest(editorId, plan.title, { startGameEnabled: plan.startsWithGame });
    report.quest = quest;
    report.editorId = editorId;
    report.created.push({ kind: 'quest', formKey: quest, label: `${plan.title} (${editorId})` });
    const stages = [...plan.stages].sort((a, b) => a.index - b.index);
    const startStage = stages.find((s) => s.startsQuest)?.index ?? stages[0]?.index ?? 0;
    for (const s of stages) {
      const log = s.journal.trim();
      this.quests.addStage(quest, s.index, log || s.completesQuest || s.failsQuest ? log : undefined, { startUp: s.index === startStage, completesQuest: s.completesQuest, failsQuest: s.failsQuest });
    }

    // Places.
    const cells = new Map<string, FormKey>();
    for (const l of plan.locations) {
      const r = res('location', l.key);
      if (r.existing) {
        cells.set(l.key, r.existing);
        report.reused.push({ kind: 'location', formKey: r.existing, label: this.label(r.existing) });
        continue;
      }
      const cell = this.world.createInteriorCell(this.ws.uniqueEditorId(`${prefix}${pascal(l.name)}`), l.name, { ambient: [60, 55, 50] });
      cells.set(l.key, cell);
      report.created.push({ kind: 'location', formKey: cell, label: `${l.name} (new interior)` });
      report.notes.push(`${l.name} is a new, empty interior. Build the room in World → Tools and connect a door to it.`);
    }

    // Characters.
    const npcs = new Map<string, FormKey>();
    const perCell = new Map<FormKey, number>();
    const nextSlot = (cell: FormKey) => {
      const n = perCell.get(cell) ?? 0;
      perCell.set(cell, n + 1);
      return n;
    };
    for (const c of plan.characters) {
      const r = res('character', c.key);
      if (r.existing) {
        npcs.set(c.key, r.existing);
        report.reused.push({ kind: 'character', formKey: r.existing, label: this.label(r.existing) });
        if (c.essential && !(((this.ws.view(r.existing)?.data as any)?.config?.flags ?? 0) & ESSENTIAL))
          report.warnings.push(`${c.name} can be killed before the quest is done. Mark them essential while the quest runs (their alias can do that) if the story needs them.`);
        continue;
      }
      npcs.set(c.key, this.createCharacter(c, r.template!, prefix, random, report));
    }

    // Items.
    const items = new Map<string, FormKey>();
    const placedItems = new Map<string, FormKey>();
    for (const i of plan.items) {
      const r = res('item', i.key);
      let item = r.existing;
      if (item) report.reused.push({ kind: 'item', formKey: item, label: this.label(item) });
      else item = this.createItem(i, r.template!, prefix, report);
      items.set(i.key, item);
    }

    // Put the characters and items where the plan says they start.
    const dropMe: FormKey[] = [];
    for (const c of plan.characters) {
      if (res('character', c.key).existing || !c.locationKey) {
        if (!res('character', c.key).existing) report.warnings.push(`${c.name} wasn't given a place, so they aren't in the world yet. Place them from the Objects tab.`);
        continue;
      }
      const cell = cells.get(c.locationKey)!;
      const npc = npcs.get(c.key)!;
      const ref = this.world.placeReference(cell, npc, { position: this.spot(cell, 'actor', nextSlot(cell)), rotation: { x: 0, y: 0, z: random() * Math.PI * 2 } }, { persistent: true, editorId: this.ws.uniqueEditorId(`${this.ws.view(npc)?.editorId ?? prefix}Ref`) });
      report.created.push({ kind: 'placed', formKey: ref, label: `${c.name} in ${this.label(cell)}` });
    }
    const playerGets: string[] = [];
    for (const i of plan.items) {
      const item = items.get(i.key)!;
      if (i.startsWith === 'location' && i.startsAtKey) {
        const cell = cells.get(i.startsAtKey)!;
        const ref = this.world.placeReference(cell, item, { position: this.spot(cell, 'item', nextSlot(cell)), rotation: { x: 0, y: 0, z: random() * Math.PI * 2 } }, { persistent: true, editorId: this.ws.uniqueEditorId(`${prefix}${pascal(i.name)}Ref`) });
        placedItems.set(i.key, ref);
        dropMe.push(ref);
        report.created.push({ kind: 'placed', formKey: ref, label: `${i.name} in ${this.label(cell)}` });
      } else if (i.startsWith === 'character' && i.startsAtKey) {
        const npc = npcs.get(i.startsAtKey)!;
        this.ws.editRecord(npc, (d: any) => void (d.items = [...(d.items ?? []), { item: { item, count: 1 } }]), 'Add to inventory');
        if (parseFormKey(npc).plugin !== this.ws.activeName) report.warnings.push(`${i.name} was added to ${this.label(npc)}'s inventory, which changes a character from ${parseFormKey(npc).plugin} (other mods that change them will conflict).`);
      } else if (i.startsWith === 'player') playerGets.push(`Game.GetPlayer().AddItem(${formExpression(item)}, 1)`);
    }
    if (dropMe.length) {
      const { missed } = await this.env.dropToSurface(dropMe);
      if (missed.length) report.notes.push(`${missed.length} item(s) had nothing under them to rest on; check where they are in the World tab.`);
    }
    if (playerGets.length) await this.graphs.appendStageCode(quest, startStage, playerGets);

    // Objectives and their quest markers.
    const markerFor = (key: string | null): FormKey | undefined => {
      if (!key) return undefined;
      if (npcs.has(key)) return npcs.get(key);
      if (placedItems.has(key)) return placedItems.get(key);
      if (cells.has(key)) return this.graphs.markerIn(quest, cells.get(key)!);
      return undefined;
    };
    for (const o of [...plan.objectives].sort((a, b) => a.index - b.index)) {
      const target = markerFor(o.targetKey);
      if (o.targetKey && !target) report.notes.push(`Objective ${o.index} (“${o.text}”) has no quest marker: ${o.targetKey} isn't somewhere in the world the marker can point at.`);
      this.quests.addObjective(quest, o.index, o.text, target ? this.graphs.aliasFor(quest, target) : undefined);
    }
    for (const s of stages) {
      const shows = plan.objectives.filter((o) => o.shownAtStage === s.index).map((o) => o.index);
      const completes = plan.objectives.filter((o) => o.completedAtStage === s.index).map((o) => o.index);
      if (shows.length || completes.length) await this.graphs.setStageObjectives(quest, s.index, shows, completes);
    }

    // Conversations (keys and names turned into the real Editor IDs).
    const speakerIds = new Map<string, string>();
    for (const c of plan.characters) {
      const id = this.ws.view(npcs.get(c.key)!)?.editorId;
      if (!id) continue;
      speakerIds.set(c.key.toLowerCase(), id);
      speakerIds.set(c.name.toLowerCase(), id);
      for (const w of c.name.split(/\s+/)) if (w.length > 2 && !speakerIds.has(w.toLowerCase())) speakerIds.set(w.toLowerCase(), id);
    }
    const itemIds = new Map<string, string>();
    for (const i of plan.items) {
      const id = i.kind === 'gold' ? 'gold' : this.ws.view(items.get(i.key)!)?.editorId;
      if (!id) continue;
      itemIds.set(i.key.toLowerCase(), id);
      itemIds.set(i.name.toLowerCase(), id);
    }
    for (const conv of plan.conversations) {
      const text = rewriteScreenplay(conv.screenplay, speakerIds, itemIds);
      try {
        const r = await this.dialogue.importScreenplay(quest, text, (info, code) => this.quests.setInfoFragment(info, 'end', code));
        report.dialogue.topics += r.topics;
        report.dialogue.responses += r.responses;
      } catch (e) {
        throw new WorkspaceError(`The conversation “${conv.title}” couldn't be made: ${(e as Error).message}`);
      }
    }

    // What moves the quest on.
    const said = new Set<number>();
    for (const conv of plan.conversations) for (const m of conv.screenplay.matchAll(/\[stage\s+(\d+)\]/gi)) said.add(Number(m[1]));
    for (const s of plan.steps) {
      if (s.kind === 'talk') {
        if (!said.has(s.to)) report.warnings.push(`Nothing said in a conversation sets stage ${s.to} (“${s.note}”). Add [stage ${s.to}] to the line that should.`);
        continue;
      }
      if (s.kind === 'script') {
        if (s.from === null) report.warnings.push(`“${s.note}” should happen right away, but it doesn't say after which stage; it was left out.`);
        else await this.graphs.addEdge(quest, { from: s.from, to: s.to, kind: 'script' });
        continue;
      }
      let target: FormKey | undefined;
      if (s.targetKey && npcs.has(s.targetKey)) target = npcs.get(s.targetKey);
      else if (s.targetKey && placedItems.has(s.targetKey)) target = placedItems.get(s.targetKey);
      else if (s.targetKey && cells.has(s.targetKey)) target = cells.get(s.targetKey);
      if (!target) {
        report.warnings.push(`“${s.note}” (${s.kind}) can't be detected: ${s.targetKey ?? 'its target'} isn't placed in the world. Set stage ${s.to} from a conversation instead (for example with [gives …] and [stage ${s.to}]).`);
        continue;
      }
      await this.graphs.addEdge(quest, { from: s.from, to: s.to, kind: s.kind, target } as NewQuestEdge);
    }

    // Rewards.
    const byStage = new Map<number, string[]>();
    for (const r of plan.rewards) {
      const lines = byStage.get(r.atStage) ?? [];
      if (r.gold) lines.push(`Game.GetPlayer().AddItem(${formExpression(resolveItem(this.ws, 'gold')!)}, ${r.gold})`);
      if (r.itemKey) lines.push(`Game.GetPlayer().AddItem(${formExpression(items.get(r.itemKey)!)}, 1)`);
      byStage.set(r.atStage, lines);
    }
    for (const [stage, lines] of byStage) await this.graphs.appendStageCode(quest, stage, lines);

    const created = report.created.filter((c) => c.kind === 'character');
    if (created.length) report.notes.push(`New characters need their faces exported from the Creation Kit before release (select them, Ctrl+F4), or they'll have dark faces. The Release tab lists them.`);
    if (!plan.startsWithGame) report.notes.push('The quest doesn’t start with the game; start it from another quest or a trigger (Start Quest).');
    report.problems = (await this.graphs.graph(quest)).problems;
    return report;
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
    this.npcs.setAppearance(npc, { morphs, weight: Math.round(20 + random() * 60) });
    report.created.push({ kind: 'character', formKey: npc, label: `${c.name} (${editorId}), copied from ${this.label(template)}` });
    report.notes.push(`${c.name} (“${c.appearance}”) got a random face; shape it in the Characters tab. They stand where they're placed until you give them AI packages.`);
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
