/**
 * The tools the AI workspace's assistant uses: each wraps engine calls the
 * UI already makes, takes Editor IDs or FormKeys, and returns compact data
 * (lists are trimmed, names come with keys) so it fits the AI's context.
 *
 * Tools that only read are always available; tools that change the plugin
 * are grouped (quests, characters, items, scripts, world) and are added as
 * each part of the workspace is built.
 */
import { z } from 'zod';
import { isFormKey, type FormKey } from '@tes5/esp';
import { WorkspaceError, type AgentTool, type RecordSummary } from '@tes5/workspace';
import type { EngineHost } from './host';
import { questTools, type QuestToolContext } from './aitools-quest';
import { moreTools } from './aitools-more';

/** Common record types, so the AI can narrow a search by kind in plain words. */
const KINDS: Record<string, string[]> = {
  character: ['NPC_'],
  quest: ['QUST'],
  place: ['CELL'],
  worldspace: ['WRLD'],
  location: ['LCTN'],
  dialogue: ['DIAL'],
  weapon: ['WEAP'],
  armor: ['ARMO'],
  book: ['BOOK'],
  misc: ['MISC'],
  key: ['KEYM'],
  potion: ['ALCH'],
  ingredient: ['INGR'],
  spell: ['SPEL'],
  effect: ['MGEF'],
  enchantment: ['ENCH'],
  perk: ['PERK'],
  shout: ['SHOU'],
  faction: ['FACT'],
  class: ['CLAS'],
  race: ['RACE'],
  outfit: ['OTFT'],
  'leveled list': ['LVLI', 'LVLN', 'LVSP'],
  container: ['CONT'],
  door: ['DOOR'],
  furniture: ['FURN'],
  static: ['STAT'],
  light: ['LIGH'],
  activator: ['ACTI'],
  'voice type': ['VTYP'],
  package: ['PACK'],
  recipe: ['COBJ'],
  global: ['GLOB'],
  message: ['MESG'],
  keyword: ['KYWD'],
};

const Form = z.string().describe('Editor ID (e.g. "WhiterunBanneredMare") or FormKey (e.g. "012E49:Skyrim.esm")');

/** A record in a line: its key, kind, Editor ID, name and where it comes from. */
function line(s: RecordSummary): Record<string, unknown> {
  return { formKey: s.formKey, type: s.sig, editorId: s.editorId, name: s.name || undefined, from: s.owner, ...(s.winner !== s.owner ? { changedBy: s.winner } : {}), ...(s.inActive ? { inYourPlugin: true } : {}), ...(s.base ? { placed: s.base } : {}) };
}

/** The tools for one conversation; with a context, the ones that change things too. */
export function aiTools(host: EngineHost, ctx?: QuestToolContext): AgentTool[] {
  const ws = () => {
    if (!host.ws) throw new WorkspaceError('No game data is open');
    return host.ws;
  };
  /** An Editor ID, FormKey or exact in-game name, as a FormKey. */
  const resolve = (ref: string, sigs?: string[]): FormKey => {
    const r = ref.trim();
    if (isFormKey(r)) {
      if (!ws().summary(r as FormKey)) throw new WorkspaceError(`Nothing in the load order has the FormKey ${r}`);
      return r as FormKey;
    }
    const byId = ws().byEditorId(r);
    if (byId) return byId;
    const named = ws()
      .search({ sigs, query: r, limit: 50 })
      .items.filter((s) => s.name?.toLowerCase() === r.toLowerCase() || s.editorId?.toLowerCase() === r.toLowerCase());
    if (named.length === 1) return named[0]!.formKey;
    if (named.length > 1) throw new WorkspaceError(`Several records are called "${r}": ${named.slice(0, 8).map((s) => `${s.editorId ?? s.formKey} (${s.sig})`).join(', ')}. Use one of these Editor IDs.`);
    throw new WorkspaceError(`Nothing is called "${r}". Search for it first and use the Editor ID or FormKey from the results.`);
  };
  const label = (k: FormKey) => {
    const s = ws().summary(k);
    return s?.name || s?.editorId || k;
  };

  const tools: AgentTool<any>[] = [
    {
      name: 'search_records',
      group: 'read',
      writes: false,
      description: `Find records in the load order by words in their Editor ID or in-game name, optionally of one kind (${Object.keys(KINDS).join(', ')}), or a record type code like "NPC_". Returns FormKeys, Editor IDs and names, best for using in other tools.`,
      input: z.object({
        query: z.string().describe('Words to look for, e.g. "bannered mare" or "Lydia"; empty lists everything of the kind'),
        kind: z.string().nullable().optional().describe('A kind from the list, or a record type code; null for any'),
        onlyMyPlugin: z.boolean().nullable().optional().describe('Only records in the plugin being edited'),
        limit: z.number().int().min(1).max(100).nullable().optional().describe('How many to return (default 25)'),
      }),
      summary: (i) => `Search for ${i.query ? `"${i.query}"` : 'everything'}${i.kind ? ` (${i.kind})` : ''}`,
      run: (i) => {
        const kind = i.kind?.trim();
        const sigs = kind ? (KINDS[kind.toLowerCase()] ?? (/^[A-Z_0-9]{4}$/.test(kind) ? [kind] : undefined)) : undefined;
        if (kind && !sigs) throw new WorkspaceError(`Unknown kind "${kind}". Use one of: ${Object.keys(KINDS).join(', ')}, or a 4-letter record type code.`);
        // Each word must match, so "bannered mare" finds "WhiterunBanneredMare".
        const words: string[] = i.query.toLowerCase().split(/\s+/).filter(Boolean);
        const first = ws().search({ sigs, query: words[0] ?? '', plugin: i.onlyMyPlugin ? ws().activeName : undefined, limit: 5000 });
        const hits = first.items.filter((s) => !s.deleted && words.every((w) => `${s.editorId ?? ''} ${s.name ?? ''} ${s.formKey}`.toLowerCase().includes(w)));
        const limit = i.limit ?? 25;
        return { data: { total: hits.length, results: hits.slice(0, limit).map(line), ...(hits.length > limit ? { more: `${hits.length - limit} more; narrow the search` } : {}) } };
      },
    },
    {
      name: 'read_record',
      group: 'read',
      writes: false,
      description: 'Read one record in full (every field, as the editor decodes it): a character, quest, item, cell, spell… Use search_records first to find it.',
      input: z.object({ form: Form, plugin: z.string().nullable().optional().describe("A plugin's version to read instead of the winning one (e.g. \"Skyrim.esm\")") }),
      summary: (i) => `Read ${i.form}`,
      run: (i) => {
        const key = resolve(i.form);
        const v = ws().view(key, i.plugin ?? undefined);
        if (!v) throw new WorkspaceError(`${i.form} has no version in ${i.plugin}`);
        return { data: { ...line(v), data: v.data }, link: { tab: 'records', key, label: `${label(key)} in Records` } };
      },
    },
    {
      name: 'load_order',
      group: 'read',
      writes: false,
      description: 'The plugins that are loaded, in order, and which one edits go into.',
      input: z.object({}),
      summary: () => 'Look at the load order',
      run: () => {
        const s = host.session();
        return { data: { game: s.game, editing: s.activePlugin ?? '(none chosen yet: edits will ask for a plugin)', unsavedChanges: s.dirty, plugins: s.loadOrder.filter((p) => p.loaded).map((p) => ({ name: p.name, master: p.isMaster || undefined, light: p.isLight || undefined, masters: p.masters.length ? p.masters : undefined })) } };
      },
    },
    {
      name: 'quest_overview',
      group: 'read',
      writes: false,
      description: "A quest's stages (with journal text), objectives, aliases, dialogue topics, scripts, and what moves it from stage to stage.",
      input: z.object({ quest: Form }),
      summary: (i) => `Look at the quest ${i.quest}`,
      run: async (i) => {
        const key = resolve(i.quest, ['QUST']);
        const q = host.quest(key);
        const flow = await host.questFlow(key).catch(() => null);
        return {
          data: {
            formKey: key,
            editorId: q.editorId,
            name: q.name,
            startsWithGame: (q.flags & 1) !== 0,
            stages: q.stages.map((s) => ({ stage: s.index, journal: s.logEntries.map((l) => l.text).filter(Boolean).join(' / ') || undefined, hasScript: s.logEntries.some((l) => l.fragment) || undefined })),
            objectives: q.objectives.map((o) => ({ index: o.index, text: o.text })),
            aliases: q.aliases.map((a) => ({ id: a.id, name: a.name, kind: a.kind === 'ref' ? 'reference' : 'location', fill: a.fillType })),
            topics: q.topics.map((t) => ({ editorId: t.editorId, playerSays: t.text || undefined, responses: t.infos.length })),
            scripts: q.scripts,
            whatMovesIt: flow,
          },
          link: { tab: 'quest', key, label: `${label(key)} in Quests` },
        };
      },
    },
    {
      name: 'quest_dialogue',
      group: 'read',
      writes: false,
      description: "A quest's dialogue as a screenplay (who says what, with [stage N], [if …] and other tags), and the editor's dialogue check (problems such as lines nobody answers or lines that can repeat).",
      input: z.object({ quest: Form }),
      summary: (i) => `Read the dialogue of ${i.quest}`,
      run: async (i) => {
        const key = resolve(i.quest, ['QUST']);
        const [screenplay, problems] = await Promise.all([Promise.resolve(host.dialogueScreenplay(key)), Promise.resolve(host.lintDialogue(key))]);
        return { data: { screenplay, problems }, link: { tab: 'quest', key, label: `${label(key)}'s dialogue` } };
      },
    },
    {
      name: 'list_places',
      group: 'read',
      writes: false,
      description: 'Find cells (places) by words in their name or Editor ID: interiors (inns, houses, caves…) and outdoor cells.',
      input: z.object({ query: z.string().describe('Words in the name or Editor ID; empty for all'), interiorOnly: z.boolean().nullable().optional(), limit: z.number().int().min(1).max(100).nullable().optional() }),
      summary: (i) => `Find places${i.query ? ` matching "${i.query}"` : ''}`,
      run: (i) => {
        const words: string[] = i.query.toLowerCase().split(/\s+/).filter(Boolean);
        const cells = host.cells({ interiorOnly: i.interiorOnly ?? false }).filter((c) => !c.persistentCell && words.every((w) => `${c.editorId ?? ''} ${c.name ?? ''}`.toLowerCase().includes(w)));
        const limit = i.limit ?? 25;
        return { data: { total: cells.length, places: cells.slice(0, limit).map((c) => ({ formKey: c.formKey, editorId: c.editorId, name: c.name, interior: c.interior, grid: c.grid, inYourPlugin: c.inActive || undefined })) } };
      },
    },
    {
      name: 'place_contents',
      group: 'read',
      writes: false,
      description: "What is placed in a cell: characters, doors (and where they lead), containers, furniture, lights and other objects, grouped by kind, with each object's reference FormKey.",
      input: z.object({ place: Form, kinds: z.array(z.string()).nullable().optional().describe('Only these base record types, e.g. ["NPC_", "DOOR", "CONT"]') }),
      summary: (i) => `Look inside ${i.place}`,
      run: (i) => {
        const key = resolve(i.place, ['CELL']);
        const refs = host.references(key).filter((r) => !r.deleted && (!i.kinds?.length || (r.baseSig && i.kinds.includes(r.baseSig))));
        const byKind = new Map<string, unknown[]>();
        for (const r of refs) {
          const k = r.baseSig ?? r.sig;
          if (!byKind.has(k)) byKind.set(k, []);
          byKind.get(k)!.push({ ref: r.formKey, base: r.baseEditorId ?? r.base, name: r.baseName, ...(r.teleport ? { leadsTo: label(r.teleport) } : {}), ...(r.disabled ? { disabled: true } : {}) });
        }
        // Statics are many and rarely matter: counted, not listed.
        const data: Record<string, unknown> = { place: label(key), total: refs.length };
        for (const [k, list] of byKind) data[k] = k === 'STAT' || k === 'MSTT' ? `${list.length} pieces` : list.slice(0, 60);
        return { data, link: { tab: 'scene', key, label: `${label(key)} in World` } };
      },
    },
    {
      name: 'character_routine',
      group: 'read',
      writes: false,
      description: "A character's AI packages (routine) in the order they're tried, in words: where they go and what they do at what hours.",
      input: z.object({ character: Form }),
      summary: (i) => `Look at ${i.character}'s routine`,
      run: (i) => {
        const key = resolve(i.character, ['NPC_']);
        return { data: host.npcRoutine(key), link: { tab: 'npc', key, label: `${label(key)} in Characters` } };
      },
    },
    {
      name: 'who_uses',
      group: 'read',
      writes: false,
      description: 'Which records refer to this one (for example: which quests use a character, which lists contain an item, where an object is placed).',
      input: z.object({ form: Form, limit: z.number().int().min(1).max(100).nullable().optional() }),
      summary: (i) => `Find what uses ${i.form}`,
      run: (i) => {
        const key = resolve(i.form);
        const refs = host.findReferences(key, true) as unknown as RecordSummary[];
        const limit = i.limit ?? 30;
        return { data: { total: refs.length, usedBy: refs.slice(0, limit).map(line) } };
      },
    },
    {
      name: 'list_scripts',
      group: 'read',
      writes: false,
      description: 'Papyrus scripts in the load order (sources the editor can read), optionally filtered by words in the name.',
      input: z.object({ query: z.string().describe('Words in the script name; empty for all'), limit: z.number().int().min(1).max(200).nullable().optional() }),
      summary: (i) => `List scripts${i.query ? ` matching "${i.query}"` : ''}`,
      run: (i) => {
        const q = i.query.toLowerCase();
        const all = (host.scriptList() as unknown as { name: string; mine?: boolean }[]).filter((s) => !q || s.name.toLowerCase().includes(q));
        return { data: { total: all.length, scripts: all.slice(0, i.limit ?? 50) } };
      },
    },
    {
      name: 'read_script',
      group: 'read',
      writes: false,
      description: 'Read the Papyrus source of a script.',
      input: z.object({ name: z.string().describe('Script name without .psc, e.g. "QF_MyQuest_01000D62"') }),
      summary: (i) => `Read the script ${i.name}`,
      run: async (i) => ({ data: await host.scriptRead(i.name), link: { tab: 'script', key: i.name, label: `${i.name} in Scripts` } }),
    },
    {
      name: 'check_script',
      group: 'checks',
      writes: false,
      description: "Check Papyrus source for errors with the editor's checker (types, functions, properties), without saving it.",
      input: z.object({ source: z.string().describe('The whole script source') }),
      summary: () => 'Check a script for errors',
      run: async (i) => ({ data: await host.scriptCheck(i.source) }),
    },
    {
      name: 'release_check',
      group: 'checks',
      writes: false,
      description: "The pre-release check of the plugin being edited: problems that would show in game (missing faces, uncompiled scripts, floating items, navmesh, dialogue without voice…), each with what to do.",
      input: z.object({}),
      summary: () => 'Run the release check',
      run: () => {
        const r = host.releaseCheck() as unknown as { findings: { severity: string; category: string; message: string; detail?: string; form?: FormKey }[] };
        const findings = r.findings ?? [];
        return {
          data: { problems: findings.length, findings: findings.slice(0, 60).map((f) => ({ severity: f.severity, area: f.category, problem: f.message, why: f.detail, form: f.form ? `${label(f.form)} (${f.form})` : undefined })) },
          link: { tab: 'release', label: 'Release check' },
        };
      },
    },
    {
      name: 'conflict_report',
      group: 'checks',
      writes: false,
      description: 'Records in the plugin being edited that other plugins also change (and which plugin wins).',
      input: z.object({}),
      summary: () => 'Look for conflicts with other mods',
      run: () => ({ data: host.conflictReport(), link: { tab: 'release', label: 'Conflict report' } }),
    },
    {
      name: 'items_and_magic',
      group: 'read',
      writes: false,
      description: 'The Items and Magic workspaces\' categories (weapons, armor, potions, loot lists, recipes, spells, perks…) with counts; with a category, the records in it.',
      input: z.object({ category: z.string().nullable().optional().describe('A category id from the list; null to list the categories'), query: z.string().nullable().optional(), limit: z.number().int().min(1).max(100).nullable().optional() }),
      summary: (i) => (i.category ? `List ${i.category}` : 'List item and magic categories'),
      run: (i) => {
        if (!i.category) return { data: { items: host.catalogCounts('items'), magic: host.catalogCounts('magic') } };
        const list = host.catalogList(i.category, i.query ?? '', i.limit ?? 30) as unknown;
        return { data: list };
      },
    },
  ];
  if (ctx) tools.push(...questTools(host, ctx), ...moreTools(host));
  return tools;
}

/** Tool names by group, for the settings and the docs. */
export function aiToolGroups(host: EngineHost): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of aiTools(host)) (out[t.group] ??= []).push(t.name);
  return out;
}
