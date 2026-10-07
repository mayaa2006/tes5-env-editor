/**
 * The Items and Magic workspaces: records grouped the way a player thinks of
 * them (weapons, potions, spells, powers, perks…) instead of by four-letter
 * record type, each listed with a one-line summary.
 */
import { ACTOR_VALUES, type FormKey } from '@tes5/esp';
import type { Workspace } from './engine';
import { CATEGORY_PRESETS, createBlankRecord, isCreatable } from './newrecord';

export type CatalogTab = 'items' | 'magic';

export interface CatalogCategory {
  id: string;
  tab: CatalogTab;
  label: string;
  /** What the category holds, in a sentence (shown as help). */
  help: string;
  sigs: string[];
  /** For spells: which SPIT types belong here. */
  spellTypes?: number[];
  /** Name of one item, for "New …" buttons. */
  one: string;
}

export const CATALOG: CatalogCategory[] = [
  { id: 'weapons', tab: 'items', label: 'Weapons', one: 'weapon', sigs: ['WEAP'], help: 'Swords, axes, maces, daggers, bows, crossbows and staffs.' },
  { id: 'armor', tab: 'items', label: 'Armor & clothing', one: 'armor piece', sigs: ['ARMO'], help: 'Anything worn: armor, clothes, jewelry, shields. (Armor addons, the meshes per race, are under Records.)' },
  { id: 'potions', tab: 'items', label: 'Potions & food', one: 'potion', sigs: ['ALCH'], help: 'Potions, poisons, food and drink: anything consumed for its effects.' },
  { id: 'ingredients', tab: 'items', label: 'Ingredients', one: 'ingredient', sigs: ['INGR'], help: 'Alchemy ingredients and their four effects.' },
  { id: 'books', tab: 'items', label: 'Books & notes', one: 'book', sigs: ['BOOK'], help: 'Books, notes, letters and spell tomes; a book can teach a skill or a spell.' },
  { id: 'scrolls', tab: 'items', label: 'Scrolls', one: 'scroll', sigs: ['SCRL'], help: 'One-use spells carried as items.' },
  { id: 'ammo', tab: 'items', label: 'Arrows & bolts', one: 'arrow', sigs: ['AMMO'], help: 'Ammunition for bows and crossbows.' },
  { id: 'keys', tab: 'items', label: 'Keys', one: 'key', sigs: ['KEYM'], help: 'Keys that open locked doors and containers.' },
  { id: 'soulgems', tab: 'items', label: 'Soul gems', one: 'soul gem', sigs: ['SLGM'], help: 'Soul gems, empty or filled.' },
  { id: 'misc', tab: 'items', label: 'Misc items', one: 'item', sigs: ['MISC'], help: 'Everything else you can pick up: gold, gems, ingots, clutter, quest items.' },
  { id: 'apparatus', tab: 'items', label: 'Alchemy tools', one: 'tool', sigs: ['APPA'], help: 'Mortar and pestle, alembic, calcinator, retort.' },
  { id: 'loot', tab: 'items', label: 'Loot lists', one: 'loot list', sigs: ['LVLI'], help: 'Leveled item lists: what a chest, merchant or enemy can have, picked by the player\'s level.' },
  { id: 'recipes', tab: 'items', label: 'Crafting recipes', one: 'recipe', sigs: ['COBJ'], help: 'What can be made or improved at a forge, workbench, grindstone, tanning rack, smelter or cooking pot, and what it uses.' },
  { id: 'outfits', tab: 'items', label: 'Outfits', one: 'outfit', sigs: ['OTFT'], help: 'Sets of clothes and armor a character wears by default.' },

  { id: 'spells', tab: 'magic', label: 'Spells', one: 'spell', sigs: ['SPEL'], spellTypes: [0], help: 'Spells the player and characters cast with magicka.' },
  { id: 'powers', tab: 'magic', label: 'Powers', one: 'power', sigs: ['SPEL'], spellTypes: [2, 3], help: 'Greater powers (once a day) and lesser powers (any time), used from the Z key.' },
  { id: 'abilities', tab: 'magic', label: 'Abilities', one: 'ability', sigs: ['SPEL'], spellTypes: [4], help: 'Always-on effects: racial traits, standing stones, blessings, perk effects.' },
  { id: 'afflictions', tab: 'magic', label: 'Diseases & other', one: 'disease', sigs: ['SPEL'], spellTypes: [1, 5, 10, 11], help: 'Diseases, poisons, addictions, and the spells shouts cast.' },
  { id: 'effects', tab: 'magic', label: 'Magic effects', one: 'magic effect', sigs: ['MGEF'], help: 'The building blocks of spells, potions and enchantments: what actually happens (damage health, summon, paralyze…).' },
  { id: 'enchantments', tab: 'magic', label: 'Enchantments', one: 'enchantment', sigs: ['ENCH'], help: 'Effects on weapons (on hit) and on worn items (always on).' },
  { id: 'shouts', tab: 'magic', label: 'Shouts', one: 'shout', sigs: ['SHOU'], help: 'Dragon shouts: three words, each with its spell and cooldown.' },
  { id: 'words', tab: 'magic', label: 'Words of power', one: 'word', sigs: ['WOOP'], help: 'The words learned from word walls.' },
  { id: 'perks', tab: 'magic', label: 'Perks', one: 'perk', sigs: ['PERK'], help: 'Skill tree perks and hidden perks: what they need and what they change.' },
  { id: 'spelllists', tab: 'magic', label: 'Leveled spells', one: 'leveled spell', sigs: ['LVSP'], help: 'Spell lists picked by level, for enemies and followers.' },
];

export function catalogCategory(id: string): CatalogCategory | undefined {
  return CATALOG.find((c) => c.id === id);
}

/** Which catalog category a record belongs to (for "open in Items/Magic" links). */
export function categoryFor(sig: string, data?: Record<string, unknown>): CatalogCategory | undefined {
  const matches = CATALOG.filter((c) => c.sigs.includes(sig));
  if (matches.length <= 1) return matches[0];
  const type = Number((data?.data as { type?: number } | undefined)?.type ?? 0);
  return matches.find((c) => c.spellTypes?.includes(type)) ?? matches[0];
}

export interface CatalogItem {
  formKey: FormKey;
  sig: string;
  editorId?: string;
  name?: string;
  inActive: boolean;
  /** One line about what it is, e.g. "One-handed sword · 7 damage · 25 gold". */
  summary: string;
  /** What to call it in lists: its name, or for nameless records (recipes) what they make. */
  title: string;
}

export const SPELL_TYPE_NAMES: Record<number, string> = { 0: 'Spell', 1: 'Disease', 2: 'Greater power', 3: 'Lesser power', 4: 'Ability', 5: 'Poison', 10: 'Addiction', 11: 'Shout spell' };
const CASTING = ['Constant effect', 'Fire and forget', 'Concentration', 'Scroll'];
const DELIVERY = ['Self', 'Touch', 'Aimed', 'Target actor', 'Target location'];
const WEAPON_KIND = ['Hand to hand', 'One-handed sword', 'Dagger', 'One-handed axe', 'Mace', 'Two-handed sword', 'Two-handed axe / hammer', 'Bow', 'Staff', 'Crossbow'];
const ARMOR_KIND = ['Light armor', 'Heavy armor', 'Clothing'];
const SCHOOLS: Record<number, string> = { 18: 'Alteration', 19: 'Conjuration', 20: 'Destruction', 21: 'Illusion', 22: 'Restoration' };

/** Friendly names for the vanilla crafting stations' keywords. */
export const WORKBENCHES: Record<string, string> = {
  CraftingSmithingForge: 'Forge',
  CraftingSmithingSkyforge: 'Skyforge',
  CraftingSmithingArmorTable: 'Workbench (improve armor)',
  CraftingSmithingSharpeningWheel: 'Grindstone (improve weapons)',
  CraftingTanningRack: 'Tanning rack',
  CraftingSmelter: 'Smelter',
  CraftingCookpot: 'Cooking pot',
  isGrainMill: 'Grain mill',
  BYOHCraftingOven: 'Oven',
  BYOHCarpenterTable: "Carpenter's workbench",
  BYOHCraftingAnvil: 'Anvil',
  DLC1CraftingBloodChalice: 'Blood chalice',
  DLC2StaffEnchanter: 'Staff enchanter',
};

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round = (v: number) => Math.round(v * 100) / 100;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** One-line, plain-language description of a record. */
export function summarize(ws: Workspace, sig: string, data: Record<string, any>): string {
  const nameOf = (key: unknown) => (typeof key === 'string' && key ? (ws.summary(key)?.name ?? ws.summary(key)?.editorId ?? '?') : undefined);
  const gold = (v: unknown) => `${num(v)} gold`;
  switch (sig) {
    case 'WEAP': {
      const kind = WEAPON_KIND[num(data.stats?.animationType)] ?? 'Weapon';
      return [kind, `${num(data.data?.damage)} damage`, gold(data.data?.value), `weight ${round(num(data.data?.weight))}`].join(' · ');
    }
    case 'ARMO': {
      const kind = ARMOR_KIND[num(data.bodyTemplate?.armorType)] ?? 'Armor';
      const rating = num(data.armorRating) / 100;
      return [kind, rating ? `armor ${round(rating)}` : null, gold(data.data?.value), `weight ${round(num(data.data?.weight))}`].filter(Boolean).join(' · ');
    }
    case 'ALCH': {
      const f = num(data.data?.flags);
      const kind = f & 0x20000 ? 'Poison' : f & 2 ? 'Food' : 'Potion';
      return [kind, plural((data.effects ?? []).length, 'effect'), gold(data.data?.value)].join(' · ');
    }
    case 'INGR':
      return [plural((data.effects ?? []).length, 'effect'), gold(data.data?.value), `weight ${round(num(data.data?.weight))}`].join(' · ');
    case 'BOOK': {
      const f = num(data.data?.flags);
      const teaches = f & 1 ? `teaches ${ACTOR_VALUES[num(data.data?.teaches)] ?? 'a skill'}` : f & 4 ? `teaches ${nameOf(data.data?.teaches) ?? 'a spell'}` : null;
      return ['Book', teaches, gold(data.data?.value)].filter(Boolean).join(' · ');
    }
    case 'SCRL':
      return [DELIVERY[num(data.data?.delivery)] ?? '', plural((data.effects ?? []).length, 'effect'), gold(data.value?.value)].filter(Boolean).join(' · ');
    case 'AMMO':
      return [num(data.data?.flags) & 4 ? 'Arrow' : 'Bolt', `${num(data.data?.damage)} damage`, gold(data.data?.value)].join(' · ');
    case 'MISC':
    case 'KEYM':
    case 'SLGM':
    case 'APPA':
      return [gold(data.data?.value), `weight ${round(num(data.data?.weight))}`].join(' · ');
    case 'LVLI':
    case 'LVSP': {
      const n = (data.entries ?? []).length;
      const none = num(data.chanceNone);
      return [plural(n, 'entry').replace('entrys', 'entries'), none ? `${none}% chance of nothing` : null].filter(Boolean).join(' · ');
    }
    case 'COBJ': {
      const made = nameOf(data.createdObject) ?? 'nothing yet';
      const bench = typeof data.workbench === 'string' ? (WORKBENCHES[ws.summary(data.workbench)?.editorId ?? ''] ?? ws.summary(data.workbench)?.editorId) : undefined;
      const count = num(data.createdCount) > 1 ? ` ×${num(data.createdCount)}` : '';
      return [`Makes ${made}${count}`, bench ? `at ${bench}` : null, plural((data.items ?? []).length, 'component')].filter(Boolean).join(' · ');
    }
    case 'OTFT':
      return plural((data.items ?? []).length, 'piece');
    case 'SPEL': {
      const d = data.data ?? {};
      const type = SPELL_TYPE_NAMES[num(d.type)] ?? 'Spell';
      const parts = [type];
      if (num(d.type) !== 4) parts.push(CASTING[num(d.castingType)] ?? '', DELIVERY[num(d.delivery)] ?? '');
      if (num(d.type) === 0) parts.push(`${num(d.baseCost)} magicka`);
      return parts.filter(Boolean).join(' · ');
    }
    case 'MGEF': {
      const d = data.data ?? {};
      const school = SCHOOLS[num(d.magicSkill)];
      const av = num(d.actorValue) >= 0 ? ACTOR_VALUES[num(d.actorValue)] : undefined;
      return [school, av ? `changes ${av}` : null, CASTING[num(d.castingType)], DELIVERY[num(d.delivery)]].filter(Boolean).join(' · ');
    }
    case 'ENCH':
      return [num(data.data?.castingType) === 0 ? 'Worn (always on)' : 'On hit', plural((data.effects ?? []).length, 'effect')].join(' · ');
    case 'SHOU':
      return (data.words ?? []).map((w: any) => nameOf(w.word) ?? '?').join(' · ') || 'No words yet';
    case 'WOOP':
      return typeof data.translation === 'string' ? data.translation : '';
    case 'PERK': {
      const d = data.data ?? {};
      return [num(d.playable) ? 'In a skill tree' : 'Hidden perk', plural((data.effects ?? []).length, 'effect'), data.nextPerk ? `then ${nameOf(data.nextPerk)}` : null].filter(Boolean).join(' · ');
    }
  }
  return '';
}

export interface CatalogCount {
  id: string;
  label: string;
  help: string;
  one: string;
  count: number;
  creatable: boolean;
}

/**
 * Spell types of records that come from other plugins never change during a
 * session, so they're decoded once; the active plugin's are read fresh.
 */
const stableSpellTypes = new WeakMap<Workspace, Map<string, number>>();

function spellType(ws: Workspace, it: { formKey: FormKey; winner: string; inActive: boolean }): number {
  // SPIT: base cost, flags, then the type as a 32-bit number at byte 8.
  const read = () => {
    const v = ws.versions(it.formKey);
    const spit = v[v.length - 1]?.record.peek('SPIT');
    return spit && spit.byteLength >= 12 ? new DataView(spit.buffer, spit.byteOffset, spit.byteLength).getUint32(8, true) : 0;
  };
  if (it.inActive) return read();
  let cache = stableSpellTypes.get(ws);
  if (!cache) stableSpellTypes.set(ws, (cache = new Map()));
  const k = `${it.formKey}@${it.winner}`;
  let t = cache.get(k);
  if (t === undefined) cache.set(k, (t = read()));
  return t;
}

/** Spell type of every spell (spells are the only type split across categories). */
function spellTypes(ws: Workspace): Map<FormKey, number> {
  const out = new Map<FormKey, number>();
  for (const it of ws.search({ sigs: ['SPEL'], limit: 1e9 }).items) out.set(it.formKey, spellType(ws, it));
  return out;
}

/** The categories of one workspace with how many records each holds. */
export function catalogCounts(ws: Workspace, tab: CatalogTab): CatalogCount[] {
  const cats = CATALOG.filter((c) => c.tab === tab);
  const types = cats.some((c) => c.spellTypes) ? spellTypes(ws) : undefined;
  return cats.map((c) => {
    let count: number;
    if (c.spellTypes && types) count = [...types.values()].filter((t) => c.spellTypes!.includes(t)).length;
    else count = ws.search({ sigs: c.sigs, limit: 0 }).total;
    return { id: c.id, label: c.label, help: c.help, one: c.one, count, creatable: c.sigs.every(isCreatable) };
  });
}

/** Categories whose records have no name of their own: they're found by what their summary says (e.g. "Makes Iron Sword"). */
const NAMELESS = new Set(['recipes', 'loot', 'spelllists', 'outfits']);

/** Summaries of records from other plugins don't change during a session. */
const stableSummaries = new WeakMap<Workspace, Map<string, string>>();

function summaryOf(ws: Workspace, it: { formKey: FormKey; sig: string; winner: string; inActive: boolean }): string {
  const read = () => {
    const v = ws.view(it.formKey);
    return v ? summarize(ws, it.sig, v.data) : '';
  };
  if (it.inActive) return read();
  let cache = stableSummaries.get(ws);
  if (!cache) stableSummaries.set(ws, (cache = new Map()));
  const k = `${it.formKey}@${it.winner}`;
  let s = cache.get(k);
  if (s === undefined) cache.set(k, (s = read()));
  return s;
}

/** Records of a category matching a search, with summaries. Your own records come first, then by name. */
export function catalogList(ws: Workspace, categoryId: string, query = '', limit = 300): { total: number; items: CatalogItem[] } {
  const c = catalogCategory(categoryId);
  if (!c) return { total: 0, items: [] };
  const q = query.trim().toLowerCase();
  // "iron sword" also finds IronSword; nameless records are also found by their summary.
  const candidates = new Map<FormKey, ReturnType<Workspace['search']>['items'][number]>();
  const add = (items: ReturnType<Workspace['search']>['items']) => items.forEach((i) => candidates.set(i.formKey, i));
  add(ws.search({ sigs: c.sigs, query: q, limit: 1e9 }).items);
  if (q.includes(' ')) add(ws.search({ sigs: c.sigs, query: q.replace(/\s+/g, ''), limit: 1e9 }).items);
  if (q && NAMELESS.has(c.id)) {
    for (const it of ws.search({ sigs: c.sigs, limit: 1e9 }).items) {
      if (!candidates.has(it.formKey) && summaryOf(ws, it).toLowerCase().includes(q)) candidates.set(it.formKey, it);
    }
  }
  let found = [...candidates.values()];
  if (c.spellTypes) found = found.filter((it) => c.spellTypes!.includes(spellType(ws, it)));
  // Your own records first, then by the name players see.
  const label = (i: { name?: string; editorId?: string }) => (i.name || i.editorId || '').toLowerCase();
  found.sort((a, b) => Number(b.inActive) - Number(a.inActive) || (label(a) < label(b) ? -1 : label(a) > label(b) ? 1 : 0));
  const items = found.slice(0, limit).map((it) => {
    const summary = summaryOf(ws, it);
    return { formKey: it.formKey, sig: it.sig, editorId: it.editorId, name: it.name, inActive: it.inActive, summary, title: it.name || titleFromSummary(it.sig, summary) || it.editorId || it.formKey };
  });
  return { total: found.length, items };
}

/** A new record for a category, with that category's starting values. */
export function createInCategory(ws: Workspace, categoryId: string): FormKey {
  const c = catalogCategory(categoryId);
  if (!c) throw new Error(`Unknown category ${categoryId}`);
  const preset = CATEGORY_PRESETS[categoryId];
  const editorId = preset?.editorId ? ws.uniqueEditorId(preset.editorId) : undefined;
  return createBlankRecord(ws, c.sigs[0]!, editorId, { ...(preset?.name ? { name: preset.name } : {}), ...(preset?.patch ?? {}) });
}

const tabCountCache = new WeakMap<Workspace, Record<number, number>>();

/**
 * How many condition tabs each perk entry point has (the game expects a fixed
 * number per entry point), learned from the perks in the load order.
 */
export function perkEntryPointTabs(ws: Workspace): Record<number, number> {
  const cached = tabCountCache.get(ws);
  if (cached) return cached;
  const votes = new Map<number, Map<number, number>>();
  for (const it of ws.search({ sigs: ['PERK'], limit: 1e9 }).items) {
    const effects = (ws.view(it.formKey)?.data.effects ?? []) as { header?: { type?: number }; data?: { entryPoint?: number; conditionTabs?: number } }[];
    for (const e of effects) {
      if (e.header?.type !== 2 || e.data?.entryPoint === undefined) continue;
      const m = votes.get(e.data.entryPoint) ?? new Map<number, number>();
      m.set(e.data.conditionTabs ?? 1, (m.get(e.data.conditionTabs ?? 1) ?? 0) + 1);
      votes.set(e.data.entryPoint, m);
    }
  }
  const out: Record<number, number> = {};
  for (const [ep, m] of votes) out[ep] = [...m.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  tabCountCache.set(ws, out);
  return out;
}

/** A readable title for records without a name: recipes are called by what they make. */
export function titleFromSummary(sig: string, summary: string): string | undefined {
  if (sig !== 'COBJ') return undefined;
  const m = /^Makes (.+?)(?: ×\d+)?(?: · at (.+?))?(?: · |$)/.exec(summary);
  if (!m || m[1] === 'nothing yet') return undefined;
  return /improve/i.test(m[2] ?? '') ? `Improve ${m[1]}` : `${m[1]} recipe`;
}
