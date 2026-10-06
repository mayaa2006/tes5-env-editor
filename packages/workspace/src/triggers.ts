/**
 * Visual triggers: "when <event>, if <conditions>, do <actions>" blocks that
 * compile to a Papyrus script attached to a placed object or a quest alias.
 *
 * The block definitions are stored inside the generated script (a single
 * `;@studio-triggers` comment line), so the editor can always read them back
 * from what is actually in the mod — there is no separate project file to
 * lose or get out of sync.
 */
import { VmadPropertyType, isFormKey, newVmad, parseFormKey, type FormKey, type Vmad, type VmadProperty, type VmadScript } from '@tes5/esp';
import { WorkspaceError, type Workspace } from './engine';
import type { ScriptService } from './scripts';

// ------------------------------------------------------------------ model

export type TriggerEventKind = 'activate' | 'pickup' | 'drop' | 'death' | 'hit' | 'arrive' | 'load' | 'equip' | 'read';

export interface TriggerEvent {
  kind: TriggerEventKind;
}

export type TriggerCompareOp = '==' | '!=' | '>=' | '<=' | '>' | '<';

export type TriggerCondition =
  | { kind: 'questStage'; quest: FormKey; op: TriggerCompareOp; stage: number }
  | { kind: 'questStageDone'; quest: FormKey; stage: number; done: boolean }
  | { kind: 'playerHasItem'; item: FormKey; count: number }
  | { kind: 'chance'; percent: number };

export type TriggerAction =
  | { kind: 'setStage'; quest: FormKey; stage: number }
  | { kind: 'startQuest'; quest: FormKey }
  | { kind: 'showObjective'; quest: FormKey; objective: number }
  | { kind: 'completeObjective'; quest: FormKey; objective: number }
  | { kind: 'notification'; text: string }
  | { kind: 'messageBox'; text: string }
  | { kind: 'addItem'; item: FormKey; count: number }
  | { kind: 'removeItem'; item: FormKey; count: number }
  | { kind: 'enable'; ref: FormKey }
  | { kind: 'disable'; ref: FormKey }
  | { kind: 'lock'; ref: FormKey; locked: boolean }
  | { kind: 'movePlayerTo'; ref: FormKey }
  | { kind: 'kill'; ref: FormKey }
  | { kind: 'addSpell'; spell: FormKey }
  | { kind: 'wait'; seconds: number }
  | { kind: 'custom'; code: string };

export interface TriggerSpec {
  /** Stable id within the host (used by the quest map to address an edge). */
  id: string;
  name?: string;
  event: TriggerEvent;
  conditions: TriggerCondition[];
  actions: TriggerAction[];
  /** Fire only the first time. */
  once?: boolean;
}

export type TriggerHost = { kind: 'ref'; ref: FormKey } | { kind: 'alias'; quest: FormKey; alias: number };

export const TRIGGER_EVENTS: { kind: TriggerEventKind; label: string; hint: string; actorOnly?: boolean }[] = [
  { kind: 'activate', label: 'Player activates it', hint: 'Pressing E on it (open, talk to, pick up, use).' },
  { kind: 'pickup', label: 'Player picks it up', hint: 'It goes into the player’s inventory.' },
  { kind: 'drop', label: 'Player drops or gives it away', hint: 'It leaves the player’s inventory.' },
  { kind: 'death', label: 'It dies', hint: 'Actors only.', actorOnly: true },
  { kind: 'hit', label: 'Player hits it', hint: 'Weapon, spell or arrow hit by the player.' },
  { kind: 'arrive', label: 'Player arrives nearby', hint: 'Its cell loads around the player (entering an interior, or getting close outside).' },
  { kind: 'load', label: 'Its 3D loads', hint: 'Every time it becomes visible.' },
  { kind: 'equip', label: 'Player equips it', hint: 'Weapons, armor, clothing.' },
  { kind: 'read', label: 'Player reads it', hint: 'Books and notes.' },
];

// ------------------------------------------------------------------ code generation

const MARKER = ';@studio-triggers ';

interface Prop {
  name: string;
  type: 'Quest' | 'ObjectReference' | 'Form' | 'Spell';
  form: FormKey;
}

function papyrusString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

/** Name a property after its form (EditorID when known). */
class PropTable {
  private byKey = new Map<string, Prop>();
  private used = new Set<string>();
  constructor(private readonly nameOf: (k: FormKey) => string | undefined) {}

  ref(form: FormKey, type: Prop['type']): string {
    const k = `${type}:${form}`;
    const existing = this.byKey.get(k);
    if (existing) return existing.name;
    let base = (this.nameOf(form) ?? `Form${parseFormKey(form).objectId.toString(16).toUpperCase()}`).replace(/[^A-Za-z0-9_]/g, '');
    if (!/^[A-Za-z_]/.test(base)) base = `P${base}`;
    let name = base;
    for (let i = 2; this.used.has(name.toLowerCase()); i++) name = `${base}${i}`;
    this.used.add(name.toLowerCase());
    const p: Prop = { name, type, form };
    this.byKey.set(k, p);
    return name;
  }

  all(): Prop[] {
    return [...this.byKey.values()];
  }
}

const EVENT_SIGNATURES: Record<TriggerEventKind, { sig: string; playerCheck?: string }> = {
  activate: { sig: 'Event OnActivate(ObjectReference akActionRef)', playerCheck: 'akActionRef == Game.GetPlayer()' },
  pickup: { sig: 'Event OnContainerChanged(ObjectReference akNewContainer, ObjectReference akOldContainer)', playerCheck: 'akNewContainer == Game.GetPlayer()' },
  drop: { sig: 'Event OnContainerChanged(ObjectReference akNewContainer, ObjectReference akOldContainer)', playerCheck: 'akOldContainer == Game.GetPlayer()' },
  death: { sig: 'Event OnDeath(Actor akKiller)' },
  hit: { sig: 'Event OnHit(ObjectReference akAggressor, Form akSource, Projectile akProjectile, Bool abPowerAttack, Bool abSneakAttack, Bool abBashAttack, Bool abHitBlocked)', playerCheck: 'akAggressor == Game.GetPlayer()' },
  arrive: { sig: 'Event OnCellAttach()' },
  load: { sig: 'Event OnLoad()' },
  equip: { sig: 'Event OnEquipped(Actor akActor)', playerCheck: 'akActor == Game.GetPlayer()' },
  read: { sig: 'Event OnRead()' },
};

function conditionCode(c: TriggerCondition, props: PropTable): string {
  switch (c.kind) {
    case 'questStage':
      return `${props.ref(c.quest, 'Quest')}.GetStage() ${c.op} ${Math.round(c.stage)}`;
    case 'questStageDone':
      return `${c.done ? '' : '!'}${props.ref(c.quest, 'Quest')}.IsStageDone(${Math.round(c.stage)})`;
    case 'playerHasItem':
      return `Game.GetPlayer().GetItemCount(${props.ref(c.item, 'Form')}) >= ${Math.max(1, Math.round(c.count))}`;
    case 'chance':
      return `Utility.RandomInt(1, 100) <= ${Math.max(0, Math.min(100, Math.round(c.percent)))}`;
  }
}

function actionCode(a: TriggerAction, props: PropTable, self: string): string[] {
  const player = 'Game.GetPlayer()';
  switch (a.kind) {
    case 'setStage':
      return [`${props.ref(a.quest, 'Quest')}.SetStage(${Math.round(a.stage)})`];
    case 'startQuest':
      return [`${props.ref(a.quest, 'Quest')}.Start()`];
    case 'showObjective':
      return [`${props.ref(a.quest, 'Quest')}.SetObjectiveDisplayed(${Math.round(a.objective)})`];
    case 'completeObjective':
      return [`${props.ref(a.quest, 'Quest')}.SetObjectiveCompleted(${Math.round(a.objective)})`];
    case 'notification':
      return [`Debug.Notification(${papyrusString(a.text)})`];
    case 'messageBox':
      return [`Debug.MessageBox(${papyrusString(a.text)})`];
    case 'addItem':
      return [`${player}.AddItem(${props.ref(a.item, 'Form')}, ${Math.max(1, Math.round(a.count))})`];
    case 'removeItem':
      return [`${player}.RemoveItem(${props.ref(a.item, 'Form')}, ${Math.max(1, Math.round(a.count))})`];
    case 'enable':
      return [`${props.ref(a.ref, 'ObjectReference')}.Enable()`];
    case 'disable':
      return [`${props.ref(a.ref, 'ObjectReference')}.Disable()`];
    case 'lock':
      return [`${props.ref(a.ref, 'ObjectReference')}.Lock(${a.locked ? 'True' : 'False'})`];
    case 'movePlayerTo':
      return [`${player}.MoveTo(${props.ref(a.ref, 'ObjectReference')})`];
    case 'kill':
      return [`(${props.ref(a.ref, 'ObjectReference')} as Actor).Kill()`];
    case 'addSpell':
      return [`${player}.AddSpell(${props.ref(a.spell, 'Spell')})`];
    case 'wait':
      return [`Utility.Wait(${Math.max(0, a.seconds)})`];
    case 'custom':
      return a.code.split(/\r?\n/).map((l) => l.replace(/\bSelf\b/g, self));
  }
}

/** Papyrus source for a set of triggers. */
export function generateTriggerScript(scriptName: string, extendsType: string, specs: readonly TriggerSpec[], nameOf: (k: FormKey) => string | undefined): { source: string; properties: Prop[] } {
  const props = new PropTable(nameOf);
  const byEvent = new Map<string, { kind: TriggerEventKind; specs: { spec: TriggerSpec; index: number }[] }>();
  specs.forEach((spec, index) => {
    const sig = EVENT_SIGNATURES[spec.event.kind].sig;
    let g = byEvent.get(sig);
    if (!g) byEvent.set(sig, (g = { kind: spec.event.kind, specs: [] }));
    g.specs.push({ spec, index });
  });
  const body: string[] = [];
  const onceVars: string[] = [];
  const self = extendsType === 'ReferenceAlias' ? 'GetReference()' : 'Self';
  for (const [sig, g] of byEvent) {
    body.push('', sig);
    for (const { spec, index } of g.specs) {
      const check = EVENT_SIGNATURES[spec.event.kind].playerCheck;
      const conds = [check, ...spec.conditions.map((c) => conditionCode(c, props))].filter(Boolean) as string[];
      if (spec.once) {
        onceVars.push(`Bool Fired${index} = False`);
        conds.push(`!Fired${index}`);
      }
      body.push(`\t; ${spec.name ?? `Trigger ${index + 1}`}`);
      const indent = conds.length ? '\t\t' : '\t';
      if (conds.length) body.push(`\tIf ${conds.join(' && ')}`);
      if (spec.once) body.push(`${indent}Fired${index} = True`);
      for (const a of spec.actions) for (const line of actionCode(a, props, self)) body.push(`${indent}${line}`);
      if (!spec.actions.length) body.push(`${indent}; (no actions yet)`);
      if (conds.length) body.push('\tEndIf');
    }
    body.push('EndEvent');
  }
  const header = [
    `ScriptName ${scriptName} extends ${extendsType}`,
    '{Generated by TES5 Env Editor from visual triggers. Edit the triggers in the editor: changes made here are replaced.}',
    `${MARKER}${JSON.stringify(specs)}`,
    '',
    ...props.all().map((p) => `${p.type} Property ${p.name} Auto`),
    ...onceVars,
  ];
  return { source: `${[...header, ...body].join('\n')}\n`, properties: props.all() };
}

/** Trigger definitions stored in a generated script, or undefined if it isn't one. */
export function parseTriggerScript(source: string): TriggerSpec[] | undefined {
  const line = source.split(/\r?\n/).find((l) => l.startsWith(MARKER));
  if (!line) return undefined;
  try {
    const specs = JSON.parse(line.slice(MARKER.length)) as TriggerSpec[];
    return Array.isArray(specs) ? specs : undefined;
  } catch {
    return undefined;
  }
}

/** Every form a trigger points at (for validation and property binding). */
export function triggerForms(spec: TriggerSpec): FormKey[] {
  const out: FormKey[] = [];
  for (const x of [...spec.conditions, ...spec.actions] as Record<string, unknown>[]) for (const k of ['quest', 'item', 'ref', 'spell']) if (typeof x[k] === 'string' && isFormKey(x[k] as string)) out.push(x[k] as FormKey);
  return out;
}

const FORM_FIELD_LABEL: Record<string, string> = { quest: 'a quest', item: 'an item', ref: 'an object', spell: 'a spell' };

/** Blocks whose form hasn't been chosen yet, described for the user. */
export function missingForms(spec: TriggerSpec): string[] {
  const out: string[] = [];
  for (const x of [...spec.conditions, ...spec.actions] as Record<string, unknown>[])
    for (const k of Object.keys(FORM_FIELD_LABEL)) if (k in x && !(typeof x[k] === 'string' && isFormKey(x[k] as string))) out.push(`${FORM_FIELD_LABEL[k]} for “${String(x.kind)}”`);
  return out;
}

// ------------------------------------------------------------------ service

export class TriggerService {
  constructor(
    readonly ws: Workspace,
    readonly scripts: ScriptService,
  ) {}

  private hostRecordSig(host: TriggerHost): string {
    const v = this.ws.view(host.kind === 'ref' ? host.ref : host.quest);
    if (!v) throw new WorkspaceError(`${host.kind === 'ref' ? host.ref : host.quest} not found`);
    return v.sig;
  }

  /** The script type a host needs (Actor for placed actors so death/hit events compile). */
  extendsFor(host: TriggerHost): string {
    if (host.kind === 'alias') return 'ReferenceAlias';
    return this.hostRecordSig(host) === 'ACHR' ? 'Actor' : 'ObjectReference';
  }

  scriptNameFor(host: TriggerHost): string {
    const clean = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '');
    if (host.kind === 'alias') {
      const q = this.ws.view(host.quest)!;
      const alias = ((q.data as any).aliases ?? []).find((a: any) => a.value?.id === host.alias)?.value;
      return `${clean(q.editorId ?? 'Quest')}_${clean(alias?.name ?? `Alias${host.alias}`)}_Triggers`;
    }
    const v = this.ws.view(host.ref)!;
    const { objectId } = parseFormKey(host.ref);
    return `${clean(v.editorId ?? `Ref${objectId.toString(16).toUpperCase()}`)}_Triggers`;
  }

  private attachedScripts(host: TriggerHost): VmadScript[] {
    if (host.kind === 'ref') return ((this.ws.view(host.ref)?.data as any)?.scripts as Vmad | undefined)?.scripts ?? [];
    const vm = (this.ws.view(host.quest)?.data as any)?.scripts as Vmad | undefined;
    return vm?.aliases?.find((a) => a.object.alias === host.alias)?.scripts ?? [];
  }

  /** The triggers currently on a host (from its generated script). */
  async list(host: TriggerHost): Promise<{ script?: string; specs: TriggerSpec[] }> {
    for (const s of this.attachedScripts(host)) {
      if (!this.scripts.has(s.name)) continue;
      const specs = parseTriggerScript(await this.scripts.read(s.name));
      if (specs) return { script: s.name, specs };
    }
    return { specs: [] };
  }

  preview(host: TriggerHost, specs: readonly TriggerSpec[]): string {
    return generateTriggerScript(this.scriptNameFor(host), this.extendsFor(host), specs, (k) => this.ws.summary(k)?.editorId).source;
  }

  /** Replace a host's triggers: writes the script and attaches it with properties filled. */
  async set(host: TriggerHost, specs: readonly TriggerSpec[]): Promise<{ script: string; source: string }> {
    for (const spec of specs) {
      const missing = missingForms(spec);
      if (missing.length) throw new WorkspaceError(`Trigger "${spec.name ?? spec.id}": choose ${missing.join(', ')}`);
      for (const f of triggerForms(spec)) if (!this.ws.summary(f)) throw new WorkspaceError(`Trigger "${spec.name ?? spec.id}" points to ${f}, which doesn't exist`);
      if (spec.event.kind === 'death' && this.extendsFor(host) === 'ObjectReference') throw new WorkspaceError('"It dies" only works on actors');
    }
    const existing = (await this.list(host)).script;
    const name = existing ?? this.scriptNameFor(host);
    const { source, properties } = generateTriggerScript(name, this.extendsFor(host), specs, (k) => this.ws.summary(k)?.editorId);
    await this.scripts.write(name, source, { undoable: true });
    const vmadProps: VmadProperty[] = properties.map((p) => ({ name: p.name, type: VmadPropertyType.Object, flags: 1, value: { form: p.form, alias: -1 } }));
    const entry = (): VmadScript => ({ name, flags: 0, properties: vmadProps });
    const update = (list: VmadScript[]): VmadScript[] => {
      const rest = list.filter((s) => s.name.toLowerCase() !== name.toLowerCase());
      return specs.length ? [...rest, entry()] : rest;
    };
    this.ws.transaction('Edit triggers', () => {
      if (host.kind === 'ref') {
        this.ws.editRecord(host.ref, (d: any) => {
          const vm: Vmad = d.scripts ?? newVmad();
          vm.scripts = update(vm.scripts);
          if (vm.scripts.length || vm.fragments) d.scripts = vm;
          else delete d.scripts;
        });
      } else {
        this.ws.editRecord(host.quest, (d: any) => {
          const vm: Vmad = d.scripts ?? newVmad();
          vm.aliases ??= [];
          let a = vm.aliases.find((x) => x.object.alias === host.alias);
          if (!a) {
            a = { object: { form: host.quest, alias: host.alias }, version: vm.version, objectFormat: vm.objectFormat, scripts: [] };
            vm.aliases.push(a);
          }
          a.scripts = update(a.scripts);
          vm.aliases = vm.aliases.filter((x) => x.scripts.length);
          d.scripts = vm;
        });
      }
    });
    return { script: name, source };
  }
}

// ------------------------------------------------------------------ ready-made triggers ("snippets")

export interface TriggerTemplate {
  id: string;
  label: string;
  description: string;
  make(ctx: { host: FormKey | null }): TriggerSpec;
}

let seq = 0;
export function newTriggerId(): string {
  seq = (seq + 1) % 1e6;
  return `t${Date.now().toString(36)}${seq.toString(36)}`;
}

/** Common tasks as pre-filled triggers; every field stays editable afterwards. */
export const TRIGGER_TEMPLATES: TriggerTemplate[] = [
  {
    id: 'message-on-activate',
    label: 'Show a message when used',
    description: 'A notification appears when the player activates this.',
    make: () => ({ id: newTriggerId(), name: 'Message on use', event: { kind: 'activate' }, conditions: [], actions: [{ kind: 'notification', text: 'Something happens.' }] }),
  },
  {
    id: 'give-item-once',
    label: 'Give an item the first time it is used',
    description: 'Like a hidden stash or a reward lever.',
    make: () => ({ id: newTriggerId(), name: 'Give item once', event: { kind: 'activate' }, conditions: [], actions: [{ kind: 'addItem', item: '' as FormKey, count: 1 }], once: true }),
  },
  {
    id: 'advance-quest-on-pickup',
    label: 'Advance a quest when picked up',
    description: 'Picking this up sets a quest stage (only at the right stage).',
    make: () => ({ id: newTriggerId(), name: 'Quest item picked up', event: { kind: 'pickup' }, conditions: [{ kind: 'questStage', quest: '' as FormKey, op: '==', stage: 10 }], actions: [{ kind: 'setStage', quest: '' as FormKey, stage: 20 }] }),
  },
  {
    id: 'advance-quest-on-death',
    label: 'Advance a quest when killed',
    description: 'Killing this actor sets a quest stage.',
    make: () => ({ id: newTriggerId(), name: 'Target killed', event: { kind: 'death' }, conditions: [{ kind: 'questStage', quest: '' as FormKey, op: '==', stage: 10 }], actions: [{ kind: 'setStage', quest: '' as FormKey, stage: 20 }] }),
  },
  {
    id: 'teleport-on-activate',
    label: 'Teleport the player when used',
    description: 'A portal, ladder or secret passage: moves the player to a marker.',
    make: () => ({ id: newTriggerId(), name: 'Teleport', event: { kind: 'activate' }, conditions: [], actions: [{ kind: 'movePlayerTo', ref: '' as FormKey }] }),
  },
  {
    id: 'reveal-on-activate',
    label: 'Reveal hidden objects when used',
    description: 'Pull a lever and something appears (enable an initially disabled object).',
    make: () => ({ id: newTriggerId(), name: 'Reveal', event: { kind: 'activate' }, conditions: [], actions: [{ kind: 'enable', ref: '' as FormKey }], once: true }),
  },
  {
    id: 'unlock-after-stage',
    label: 'Unlock when a quest reaches a stage',
    description: 'Unlocks this door or chest the first time it’s used after a quest stage.',
    make: (ctx) => ({ id: newTriggerId(), name: 'Unlock after stage', event: { kind: 'activate' }, conditions: [{ kind: 'questStageDone', quest: '' as FormKey, stage: 10, done: true }], actions: [{ kind: 'lock', ref: (ctx.host ?? '') as FormKey, locked: false }], once: true }),
  },
  {
    id: 'welcome-on-arrive',
    label: 'Message when the player arrives',
    description: 'Shows a message the first time the player enters this area.',
    make: () => ({ id: newTriggerId(), name: 'Arrival message', event: { kind: 'arrive' }, conditions: [], actions: [{ kind: 'notification', text: 'You feel watched.' }], once: true }),
  },
];
