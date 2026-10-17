/**
 * The AI workspace's tools for visual triggers: "when <event>, if
 * <conditions>, do <actions>" on a placed object or a quest alias, the same
 * blocks as the Triggers editor. They are written as one generated script
 * per object, so they read back exactly as the Triggers editor shows them.
 */
import { z } from 'zod';
import { isFormKey, type FormKey } from '@tes5/esp';
import { TRIGGER_EVENTS, WorkspaceError, newTriggerId, type AgentTool, type TriggerAction, type TriggerCondition, type TriggerHost, type TriggerSpec } from '@tes5/workspace';
import type { EngineHost } from './host';
import { placedCopy } from './aitools-world';
import { lookup } from './aitools-lookup';

const Form = (what: string) => z.string().describe(`Editor ID or FormKey of ${what}`);
const Stage = z.number().int().min(0);

const Condition = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('questStage'), quest: Form('a quest'), op: z.enum(['==', '!=', '>=', '<=', '>', '<']), stage: Stage }),
  z.object({ kind: z.literal('questStageDone'), quest: Form('a quest'), stage: Stage, done: z.boolean() }),
  z.object({ kind: z.literal('playerHasItem'), item: Form('an item'), count: z.number().int().min(1) }),
  z.object({ kind: z.literal('chance'), percent: z.number().min(0).max(100) }),
]);

const Action = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('setStage'), quest: Form('a quest'), stage: Stage }),
  z.object({ kind: z.literal('startQuest'), quest: Form('a quest') }),
  z.object({ kind: z.literal('showObjective'), quest: Form('a quest'), objective: z.number().int().min(0) }),
  z.object({ kind: z.literal('completeObjective'), quest: Form('a quest'), objective: z.number().int().min(0) }),
  z.object({ kind: z.literal('notification'), text: z.string().min(1).describe('A short message at the top left of the screen') }),
  z.object({ kind: z.literal('messageBox'), text: z.string().min(1).describe('A message box the player must close') }),
  z.object({ kind: z.literal('addItem'), item: Form('an item'), count: z.number().int().min(1) }),
  z.object({ kind: z.literal('removeItem'), item: Form('an item'), count: z.number().int().min(1) }),
  z.object({ kind: z.literal('enable'), ref: Form('a placed object (place_contents)') }),
  z.object({ kind: z.literal('disable'), ref: Form('a placed object (place_contents)') }),
  z.object({ kind: z.literal('lock'), ref: Form('a placed door or container'), locked: z.boolean() }),
  z.object({ kind: z.literal('movePlayerTo'), ref: Form('a placed object or marker') }),
  z.object({ kind: z.literal('kill'), ref: Form('a placed character') }),
  z.object({ kind: z.literal('addSpell'), spell: Form('a spell') }),
  z.object({ kind: z.literal('wait'), seconds: z.number().min(0).max(600) }),
]);

const On = {
  object: z.string().nullable().optional().describe('A placed object or character: reference FormKey from place_contents'),
  quest: z.string().nullable().optional().describe('With alias: the quest whose alias it is'),
  alias: z.string().nullable().optional().describe('With quest: the alias name (quest_overview lists them)'),
};

const EVENT_KINDS = TRIGGER_EVENTS.map((e) => e.kind) as [string, ...string[]];

export function triggerTools(host: EngineHost): AgentTool<any>[] {
  const ws = () => {
    if (!host.ws) throw new WorkspaceError('No game data is open');
    return host.ws;
  };
  const form = (ref: string, what: string): FormKey => lookup(ws(), ref, { what });
  const label = (k: FormKey) => ws().summary(k)?.editorId || ws().summary(k)?.name || k;

  /** The object or alias a tool is about, from its object / quest + alias fields. */
  const target = (i: { object?: string | null; quest?: string | null; alias?: string | null }): { host: TriggerHost; name: string; link: { tab: 'scene' | 'quest'; key: FormKey; label: string } } => {
    if (i.object) {
      const named = form(i.object, 'placed object');
      const sig0 = ws().summary(named)!.sig;
      if (sig0 === 'CELL' || sig0 === 'WRLD' || sig0 === 'QUST') throw new WorkspaceError(`${i.object} isn't a placed object. Triggers go on a placed object (place_contents) or a quest alias.`);
      // A base record (a chest, a character) stands for its placed copy.
      const ref = placedCopy(host, named, 'placed object');
      const cell = ws().view(ref)?.parent?.cell;
      return { host: { kind: 'ref', ref }, name: label(ref), link: cell ? { tab: 'scene', key: cell, label: `${label(cell)} in World` } : { tab: 'scene', key: ref, label: label(ref) } };
    }
    if (i.quest && i.alias) {
      const quest = form(i.quest, 'quest');
      if (ws().summary(quest)!.sig !== 'QUST') throw new WorkspaceError(`${i.quest} isn't a quest`);
      const aliases = host.quest(quest).aliases;
      const a = aliases.find((x) => x.name.toLowerCase() === i.alias!.trim().toLowerCase() || String(x.id) === i.alias!.trim());
      if (!a) throw new WorkspaceError(`${label(quest)} has no alias "${i.alias}". Its aliases: ${aliases.map((x) => x.name).join(', ') || 'none'}.`);
      if (a.kind !== 'ref') throw new WorkspaceError(`${a.name} is a location alias; triggers need a reference alias`);
      return { host: { kind: 'alias', quest, alias: a.id }, name: `${label(quest)}'s ${a.name}`, link: { tab: 'quest', key: quest, label: label(quest) } };
    }
    throw new WorkspaceError('Say which placed object (object) or which quest alias (quest and alias) the triggers are on');
  };

  /** Editor IDs in conditions and actions → FormKeys. */
  const resolveForms = <T extends object>(x: T): T => {
    const out = { ...x } as Record<string, unknown>;
    for (const [k, what] of [['quest', 'quest'], ['item', 'item'], ['ref', 'placed object'], ['spell', 'spell']] as const) if (typeof out[k] === 'string') out[k] = form(out[k] as string, what);
    return out as T;
  };
  const describe = (s: TriggerSpec) => {
    const name = (k: unknown) => (typeof k === 'string' && isFormKey(k) ? label(k as FormKey) : k);
    const words = (x: Record<string, unknown>) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, ['quest', 'item', 'ref', 'spell'].includes(k) ? name(v) : v]));
    return {
      id: s.id,
      name: s.name,
      when: TRIGGER_EVENTS.find((e) => e.kind === s.event.kind)?.label ?? s.event.kind,
      onlyIf: s.conditions.map((c) => words(c as Record<string, unknown>)),
      then: s.actions.map((a) => words(a as Record<string, unknown>)),
      ...(s.once ? { once: true } : {}),
    };
  };
  const spec = (i: { name?: string | null; when: string; onlyIf?: unknown[] | null; then: unknown[]; once?: boolean | null }, id = newTriggerId()): TriggerSpec => ({
    id,
    ...(i.name ? { name: i.name } : {}),
    event: { kind: i.when as TriggerSpec['event']['kind'] },
    conditions: (i.onlyIf ?? []).map((c) => resolveForms(c as object)) as TriggerCondition[],
    actions: i.then.map((a) => resolveForms(a as object)) as TriggerAction[],
    ...(i.once ? { once: true } : {}),
  });
  const save = async (t: ReturnType<typeof target>, specs: TriggerSpec[]) => {
    const r = await host.setTriggers(t.host, specs);
    return { data: { on: t.name, script: r.script, triggers: specs.map(describe), note: 'Compile scripts (compile_scripts) for the game to run them.' }, link: t.link };
  };

  const Trigger = {
    name: z.string().nullable().optional().describe('A short name, e.g. "Pull the lever"'),
    when: z.enum(EVENT_KINDS).describe(TRIGGER_EVENTS.map((e) => `${e.kind}: ${e.label} (${e.hint.replace(/\.$/, '')})${e.actorOnly ? ', characters only' : ''}`).join('; ')),
    onlyIf: z.array(Condition).nullable().optional().describe('All must be true'),
    then: z.array(Action).min(1).describe('Done in order'),
    once: z.boolean().nullable().optional().describe('Only the first time'),
  };

  return [
    {
      name: 'list_triggers',
      group: 'read',
      writes: false,
      description: 'The triggers on a placed object or quest alias ("when the player activates it, if the quest is at stage 10, set stage 20"), with their ids.',
      input: z.object(On),
      summary: (i) => `List the triggers on ${i.object ?? `${i.quest} ${i.alias}`}`,
      run: async (i) => {
        const t = target(i);
        const r = await host.triggersOf(t.host);
        return { data: { on: t.name, script: r.script, triggers: r.specs.map(describe) }, link: t.link };
      },
    },
    {
      name: 'add_trigger',
      group: 'world',
      writes: true,
      description:
        "Add a trigger to a placed object or a quest alias: when something happens to it (the player uses, picks up, drops, hits, equips or reads it, it dies, the player arrives nearby, its 3D loads), if conditions hold (quest stage, stage done, the player has an item, a chance), do actions in order (set a stage, start a quest, show or complete an objective, a message, give or take items, enable/disable/lock objects, move the player, kill, give a spell, wait). Objects are named by Editor ID or FormKey. Use it for levers, secret doors, quest items and traps; use connect_stages for a quest's own steps.",
      input: z.object({ ...On, ...Trigger }),
      summary: (i) => `Add a trigger (${i.when}) to ${i.object ?? `${i.quest} ${i.alias}`}`,
      run: async (i) => {
        const t = target(i);
        const now = (await host.triggersOf(t.host)).specs;
        return save(t, [...now, spec(i)]);
      },
    },
    {
      name: 'change_trigger',
      group: 'world',
      writes: true,
      description: 'Replace one trigger (id from list_triggers) with a new version: give all of it, not only what changes.',
      input: z.object({ ...On, id: z.string(), ...Trigger }),
      summary: (i) => `Change the trigger ${i.id}`,
      run: async (i) => {
        const t = target(i);
        const now = (await host.triggersOf(t.host)).specs;
        if (!now.some((s) => s.id === i.id)) throw new WorkspaceError(`There's no trigger ${i.id} on ${t.name}. Its triggers: ${now.map((s) => s.id).join(', ') || 'none'}.`);
        return save(t, now.map((s) => (s.id === i.id ? spec(i, i.id) : s)));
      },
    },
    {
      name: 'remove_trigger',
      group: 'world',
      writes: true,
      description: 'Remove a trigger (id from list_triggers). When the last one goes, its script is detached.',
      input: z.object({ ...On, id: z.string() }),
      summary: (i) => `Remove the trigger ${i.id}`,
      run: async (i) => {
        const t = target(i);
        const now = (await host.triggersOf(t.host)).specs;
        if (!now.some((s) => s.id === i.id)) throw new WorkspaceError(`There's no trigger ${i.id} on ${t.name}`);
        return save(t, now.filter((s) => s.id !== i.id));
      },
    },
  ];
}
