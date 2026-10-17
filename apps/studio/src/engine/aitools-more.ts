/**
 * The AI workspace's tools for characters, records (items, magic and every
 * other kind) and scripts.
 *
 * Characters are made and changed through a one-character plan, built by the
 * same builder as Quests → From writing, so a new character is copied from a
 * fitting one, placed in its cell and dressed exactly as a planned one is.
 */
import { z } from 'zod';
import { isFormKey, type FormKey, type VmadProperty } from '@tes5/esp';
import { PlanCharacterSchema, WorkspaceError, catalogCategory, emptyPlan, isCreatable, validatePlan, type AgentTool, type PlanCharacter, type QuestBuildReport } from '@tes5/workspace';
import type { EngineHost } from './host';
import { lookup } from './aitools-lookup';

const Form = z.string().describe('Editor ID or FormKey');

/** What can be said about a character: the plan format's fields, all optional. */
const CharacterFields = PlanCharacterSchema.pick({
  sex: true,
  race: true,
  role: true,
  appearance: true,
  look: true,
  voice: true,
  spot: true,
  essential: true,
  className: true,
  level: true,
  outfit: true,
  factions: true,
  inventory: true,
  routine: true,
  combat: true,
  roles: true,
  relationships: true,
  basedOn: true,
}).partial();

/** A plan character with nothing to change: the base the tools fill in. */
function blankCharacter(name: string): PlanCharacter {
  return { key: 'c', name, existing: null, basedOn: null, sex: null, race: null, role: '', appearance: '', look: null, voice: null, locationKey: null, spot: null, essential: null, className: null, level: null, outfit: null, factions: [], inventory: [], routine: [], combat: null, roles: null, relationships: [] };
}

/** Deep-merge `changes` into `data`: objects merge, everything else (lists included) is replaced. */
export function mergeChanges(data: Record<string, unknown>, changes: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(changes)) {
    const cur = data[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur) && !(cur instanceof Uint8Array)) mergeChanges(cur as Record<string, unknown>, v as Record<string, unknown>);
    else data[k] = v;
  }
  return data;
}

/** The leaf fields a change sets, with their values before and after. */
export function changedFields(before: Record<string, unknown>, changes: Record<string, unknown>, prefix = ''): { path: string; was: unknown; now: unknown }[] {
  const out: { path: string; was: unknown; now: unknown }[] = [];
  for (const [k, v] of Object.entries(changes)) {
    const path = prefix ? `${prefix}.${k}` : k;
    const was = before?.[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && was && typeof was === 'object' && !Array.isArray(was) && !(was instanceof Uint8Array)) out.push(...changedFields(was as Record<string, unknown>, v as Record<string, unknown>, path));
    else out.push({ path, was, now: v });
  }
  return out;
}

const short = (v: unknown) => (v === undefined ? '(none)' : JSON.stringify(v).slice(0, 80));

export function moreTools(host: EngineHost): AgentTool<any>[] {
  const ws = () => {
    if (!host.ws) throw new WorkspaceError('No game data is open');
    return host.ws;
  };
  const resolve = (ref: string, what = 'record'): FormKey => lookup(ws(), ref, { what });
  const label = (k: FormKey) => {
    const s = ws().summary(k);
    return s?.name || s?.editorId || k;
  };
  /** Build a one-character plan; returns the report in brief. */
  const buildCharacter = async (c: PlanCharacter, place: string | null | undefined) => {
    const plan = emptyPlan();
    plan.title = c.name;
    plan.editorId = `${c.name.replace(/[^A-Za-z0-9]/g, '') || 'Character'}Changes`;
    plan.stages = [];
    // On their own a character has no quest stages: routine entries apply all the time (small models fill in -1 or 0 for "none").
    for (const r of c.routine ?? []) Object.assign(r, { fromStage: null, untilStage: null });
    plan.characters = [c];
    if (place) {
      const cell = resolve(place, 'place');
      plan.locations = [{ key: 'place', name: label(cell), existing: ws().summary(cell)?.editorId ?? cell, description: '', layoutLike: null, doorFrom: null }];
      if (!c.existing) c.locationKey = 'place';
    }
    const errors = validatePlan(plan).filter((i) => i.severity === 'error');
    if (errors.length) throw new WorkspaceError(errors.map((e) => e.message).join('; '));
    const r: QuestBuildReport = await host.buildQuestPlan(plan);
    return r;
  };

  return [
    {
      name: 'create_character',
      group: 'characters',
      writes: true,
      description:
        "Create a new character, copied from a fitting existing one (or basedOn), and place them in a cell. Describe what you know: look (hair, beard, eyes, scars, build), outfit (existing clothing by name), inventory, factions, class, level, routine (sandbox/sleep/eat/stay/travel with hours), combat (hostile, skills, spells, perks, style), roles (follower, marriage, merchant, trainer, innkeeper) and relationships. For characters in a quest, plan_quest does this as part of the quest.",
      input: CharacterFields.extend({ name: z.string().describe('Name shown in game'), place: z.string().nullable().optional().describe('Editor ID of the cell they stand in (an interior from list_places); null to make them without placing them') }),
      summary: (i) => `Create the character ${i.name}`,
      run: async (i) => {
        const { name, place, ...rest } = i;
        const c = { ...blankCharacter(name), ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) } as PlanCharacter;
        const r = await buildCharacter(c, place);
        const made = r.created.find((x) => x.kind === 'character');
        return { data: { character: made?.formKey, created: r.created.map((x) => `${x.kind}: ${x.label}`), notes: r.notes, warnings: r.warnings }, ...(made ? { link: { tab: 'npc' as const, key: made.formKey, label: `${made.label} in Characters` } } : {}) };
      },
    },
    {
      name: 'change_character',
      group: 'characters',
      writes: true,
      description: "Change an existing character: only the fields you give change (look, outfit, inventory, factions, class, level, essential, routine, combat, roles, relationships). Characters from other plugins are overridden in the plugin being edited. Changed faces get new face files when the author saves.",
      input: CharacterFields.extend({ character: Form }),
      summary: (i) => `Change ${i.character}`,
      run: async (i) => {
        const { character, ...rest } = i;
        const key = resolve(character, 'character');
        if (ws().summary(key)?.sig !== 'NPC_') throw new WorkspaceError(`${character} isn't a character`);
        const c = { ...blankCharacter(label(key)), ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)), existing: ws().summary(key)?.editorId ?? key } as PlanCharacter;
        const r = await buildCharacter(c, null);
        return { data: { changed: r.changed.map((x) => `${x.label}: ${x.changes.join(', ')}`), created: r.created.map((x) => `${x.kind}: ${x.label}`), notes: r.notes, warnings: r.warnings }, link: { tab: 'npc', key, label: `${label(key)} in Characters` } };
      },
    },
    {
      name: 'create_record',
      group: 'items',
      writes: true,
      description:
        "Create a new record with sensible defaults: an Items or Magic category id from items_and_magic (e.g. a weapon, potion, book, leveled list, recipe, spell, perk) or a record type code (e.g. 'GLOB', 'FACT', 'KYWD', 'MESG'). Then set its fields with update_record (read a similar record first to see the field names). To make a variant of something that exists, copy_record is usually better.",
      input: z.object({ kind: z.string().describe('Category id or record type code'), editorId: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).nullable().optional(), name: z.string().nullable().optional().describe('Name shown in game, for things that have one') }),
      summary: (i) => `Create ${i.name ? `“${i.name}”` : `a new ${i.kind}`}`,
      run: (i) => {
        const cat = catalogCategory(i.kind);
        let key: FormKey;
        if (cat) key = host.createInCategory(i.kind);
        else if (/^[A-Z_0-9]{4}$/.test(i.kind) && isCreatable(i.kind)) key = host.createBlankRecord(i.kind, i.editorId ? ws().uniqueEditorId(i.editorId) : undefined);
        else throw new WorkspaceError(`“${i.kind}” isn't a category or a record type that can be made here. List the categories with items_and_magic.`);
        if (i.editorId || i.name)
          ws().editRecord(key, (d) => {
            if (i.editorId && d.editorId !== i.editorId) d.editorId = ws().uniqueEditorId(i.editorId);
            if (i.name) d.name = i.name;
          }, 'Name the new record');
        const v = ws().view(key)!;
        const c = host.categoryOf(key);
        return { data: { formKey: key, editorId: v.editorId, name: v.name, type: v.sig, fields: v.data }, link: c ? { tab: c.tab, key, label: `${label(key)} in ${c.tab === 'items' ? 'Items' : 'Magic'}` } : { tab: 'records', key, label: `${label(key)} in Records` } };
      },
    },
    {
      name: 'copy_record',
      group: 'items',
      writes: true,
      description: 'Make a copy of a record (an item, spell, character, list…) with a new Editor ID, to change it with update_record.',
      input: z.object({ form: Form, editorId: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/), name: z.string().nullable().optional() }),
      summary: (i) => `Copy ${i.form} as ${i.editorId}`,
      run: (i) => {
        const source = resolve(i.form);
        const editorId = ws().uniqueEditorId(i.editorId);
        const key = host.duplicateRecord(source, editorId) as unknown as FormKey;
        if (i.name) ws().editRecord(key, (d) => void (d.name = i.name), 'Name the copy');
        // Say what small models often miss: the Editor ID was taken, or the copy still has the original's name.
        const notes = [
          ...(editorId !== i.editorId ? [`${i.editorId} was already used, so the copy is ${editorId}.`] : []),
          ...(!i.name && ws().summary(source)?.name ? [`The copy is still called "${ws().summary(source)!.name}" in game; give name to rename it (or update_record with {"name": …}).`] : []),
        ];
        return { data: { formKey: key, editorId, name: ws().summary(key)?.name, ...(notes.length ? { note: notes.join(' ') } : {}) }, link: { tab: 'records', key, label: `${label(key)} in Records` } };
      },
    },
    {
      name: 'update_record',
      group: 'items',
      writes: true,
      description:
        "Change fields of a record: 'changes' is merged into the record's data as read_record shows it (objects merge, lists and values are replaced; FormKeys as strings). Read the record first. Records from other plugins are overridden in the plugin being edited. Works for any record with a typed form.",
      input: z.object({ form: Form, changes: z.record(z.string(), z.unknown()).describe('Fields to change, with the names read_record shows. For a weapon, {"data": {"damage": 12}} sets its damage and {"data": {"value": 500}} its price; {"name": "Ebony Dagger of Fire"} renames it') }),
      summary: (i) => `Change ${i.form} (${Object.keys(i.changes).join(', ')})`,
      run: (i) => {
        const key = resolve(i.form);
        const before = structuredClone(ws().view(key)?.data ?? {}) as Record<string, unknown>;
        const v = ws().editRecord(key, (d) => mergeChanges(d, structuredClone(i.changes)), `Edit ${label(key)}`);
        // What changed, field by field, so a wrong field name shows ("data.value: 30 → 12" when damage was meant).
        const changed = changedFields(before, i.changes);
        const added = changed.filter((c) => c.was === undefined).map((c) => c.path);
        return {
          data: {
            formKey: key,
            editorId: v.editorId,
            name: v.name,
            changed: changed.map((c) => `${c.path}: ${short(c.was)} → ${short(c.now)}`),
            ...(added.length ? { note: `The record had no ${added.join(', ')} before, so ${added.length === 1 ? 'it was' : 'they were'} added. If that wasn't meant, check the field names with read_record.` } : {}),
          },
          link: { tab: 'records', key, label: `${label(key)} in Records` },
        };
      },
    },
    {
      name: 'delete_record',
      group: 'items',
      writes: true,
      description: "Delete a record from the plugin being edited. A record from another plugin is disabled (placed objects) or reverted instead, which is safe for the game. Check who_uses first.",
      input: z.object({ form: Form }),
      summary: (i) => `Delete ${i.form}`,
      run: (i) => {
        const key = resolve(i.form);
        const name = label(key);
        const how = host.deleteRecord(key);
        return { data: `${name}: ${how}` };
      },
    },
    {
      name: 'write_script',
      group: 'scripts',
      writes: true,
      description: "Save a Papyrus script's source (a new script, or a whole new version of an existing one). It's checked first and not saved if it has errors. Compile it with compile_scripts and attach it with attach_script.",
      input: z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).describe('Script name (the ScriptName line must match)'), source: z.string() }),
      summary: (i) => `Write the script ${i.name}`,
      run: async (i) => {
        const header = /^\s*ScriptName\s+(\w+)/im.exec(i.source);
        if (!header) throw new WorkspaceError(`The source needs a “ScriptName ${i.name} extends …” line`);
        if (header[1]!.toLowerCase() !== i.name.toLowerCase()) throw new WorkspaceError(`The ScriptName line says ${header[1]}, but the script is called ${i.name}`);
        const problems = await host.scriptCheck(i.source);
        const errors = problems.filter((p) => p.severity === 'error');
        if (errors.length) throw new WorkspaceError(`Not saved; fix these: ${errors.slice(0, 10).map((e) => `line ${e.range.start.line + 1}: ${e.message}`).join('; ')}`);
        await host.scripts!.write(i.name, i.source, { undoable: true });
        return { data: { saved: i.name, warnings: problems.filter((p) => p.severity === 'warning').map((p) => `line ${p.range.start.line + 1}: ${p.message}`) }, link: { tab: 'script', key: i.name, label: `${i.name} in Scripts` } };
      },
    },
    {
      name: 'compile_scripts',
      group: 'scripts',
      writes: false,
      description: 'Compile scripts into what the game runs (.pex), with the compiler set up in the Scripts tab. Returns each script\'s errors.',
      input: z.object({ names: z.array(z.string()).min(1) }),
      summary: (i) => `Compile ${i.names.join(', ')}`,
      run: async (i) => {
        const res = await host.scriptCompile(i.names);
        return { data: res.map((r) => ({ script: r.script, ok: r.ok, messages: r.messages.slice(0, 10) })), link: { tab: 'script', key: i.names[0], label: 'Scripts' } };
      },
    },
    {
      name: 'attach_script',
      group: 'scripts',
      writes: true,
      description: 'Attach a script to a record (a quest, character, item, activator, placed object…). Its properties can then be set with set_script_property or filled automatically with autofill_properties.',
      input: z.object({ form: Form, script: z.string() }),
      summary: (i) => `Attach ${i.script} to ${i.form}`,
      run: async (i) => {
        const key = resolve(i.form);
        await host.attachScript(key, i.script);
        return { data: `Attached ${i.script} to ${label(key)}`, link: { tab: 'records', key, label: `${label(key)} in Records` } };
      },
    },
    {
      name: 'set_script_property',
      group: 'scripts',
      writes: true,
      description: "Set a property of a script attached to a record: an object (a record's Editor ID or FormKey), text, a whole number, a decimal number or true/false.",
      input: z.object({ form: Form, script: z.string(), property: z.string(), kind: z.enum(['object', 'string', 'int', 'float', 'bool']), value: z.union([z.string(), z.number(), z.boolean()]) }),
      summary: (i) => `Set ${i.script}.${i.property} on ${i.form}`,
      run: (i) => {
        const key = resolve(i.form);
        const prop: VmadProperty =
          i.kind === 'object'
            ? { name: i.property, type: 1, value: { form: resolve(String(i.value)), alias: -1 } }
            : i.kind === 'string'
              ? { name: i.property, type: 2, value: String(i.value) }
              : i.kind === 'int'
                ? { name: i.property, type: 3, value: Math.round(Number(i.value)) }
                : i.kind === 'float'
                  ? { name: i.property, type: 4, value: Number(i.value) }
                  : { name: i.property, type: 5, value: i.value === true || String(i.value).toLowerCase() === 'true' };
        host.setScriptProperty(key, i.script, prop);
        return { data: 'Done.', link: { tab: 'records', key, label: `${label(key)} in Records` } };
      },
    },
    {
      name: 'autofill_properties',
      group: 'scripts',
      writes: true,
      description: "Fill a record's script properties with the records whose Editor IDs match the property names (like the Creation Kit's Auto-Fill All).",
      input: z.object({ form: Form }),
      summary: (i) => `Auto-fill the script properties of ${i.form}`,
      run: async (i) => {
        const key = resolve(i.form);
        return { data: { filled: await host.autofill(key) }, link: { tab: 'records', key, label: `${label(key)} in Records` } };
      },
    },
  ];
}
