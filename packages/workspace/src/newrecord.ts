/**
 * New, empty records of a chosen type with sensible defaults, so a spell,
 * perk, leveled list or recipe can be made from scratch (not only by
 * duplicating an existing one).
 */
import { getRecordDef, type FormKey, type MemberDef, type RecordDef, type ValueDef } from '@tes5/esp';
import type { Workspace } from './engine';

/**
 * Types that stand on their own (not placed in a cell, not part of a topic or
 * quest) and so can be created from the object list.
 */
export const CREATABLE_TYPES = [
  'STAT', 'MSTT', 'FURN', 'ACTI', 'CONT', 'DOOR', 'LIGH', 'TREE', 'FLOR', 'SCOL', 'TXST',
  'ARMO', 'ARMA', 'WEAP', 'AMMO', 'BOOK', 'MISC', 'KEYM', 'ALCH', 'INGR', 'SLGM', 'APPA', 'SCRL',
  'LVLI', 'LVLN', 'LVSP', 'COBJ', 'OTFT',
  'MGEF', 'SPEL', 'ENCH', 'SHOU', 'WOOP', 'PERK',
  'GLOB', 'KYWD', 'FLST', 'MESG', 'FACT', 'CLAS',
] as const;

export function isCreatable(sig: string): boolean {
  return (CREATABLE_TYPES as readonly string[]).includes(sig) && !!getRecordDef(sig);
}

function defaultValue(v: ValueDef): unknown {
  switch (v.t) {
    case 'int':
      return v.default ?? (v.enum && v.enum[-1] !== undefined ? -1 : 0);
    case 'float':
      return v.default ?? 0;
    case 'formid':
      return null;
    case 'zstring':
    case 'lstring':
    case 'fstring':
      return '';
    case 'bytes':
    case 'unused':
      return new Uint8Array(v.size ?? 0);
    case 'empty':
      return true;
    case 'struct':
      return Object.fromEntries(v.fields.map((f) => [f.key, defaultValue(f.def)]));
    case 'array':
      return typeof v.count === 'number' ? Array.from({ length: v.count }, () => defaultValue(v.of)) : [];
    case 'union':
    case 'custom':
      return undefined;
  }
}

function defaultMember(m: MemberDef): unknown {
  switch (m.m) {
    case 'sub':
      return defaultValue(m.def);
    case 'rarray':
    case 'counted':
      return [];
    case 'rstruct':
      return Object.fromEntries(m.members.filter((x) => x.required).map((x) => [x.key, defaultMember(x)]));
    case 'runion':
      return undefined;
  }
}

/** Defaults for the required fields of a record type. */
export function requiredDefaults(def: RecordDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of def.members) if (m.required) out[m.key] = defaultMember(m);
  return out;
}

const TYPE_LABEL: Record<string, string> = {
  MGEF: 'Magic Effect', SPEL: 'Spell', ENCH: 'Enchantment', SCRL: 'Scroll', SHOU: 'Shout', WOOP: 'Word', PERK: 'Perk',
  LVLI: 'Leveled Item', LVSP: 'Leveled Spell', LVLN: 'Leveled NPC', COBJ: 'Recipe', ALCH: 'Potion', INGR: 'Ingredient',
};

/** A ready-to-create record of the given type: required fields, a name, and per-type defaults that match vanilla. */
export function blankRecordData(ws: Workspace, sig: string, editorId?: string): Record<string, unknown> {
  const def = getRecordDef(sig);
  if (!def) throw new Error(`No schema for ${sig}`);
  const label = TYPE_LABEL[sig] ?? def.name;
  const data: Record<string, unknown> = { ...requiredDefaults(def), editorId: editorId ?? ws.uniqueEditorId(`New${label.replace(/[^A-Za-z]/g, '')}`) };
  const has = (key: string) => def.members.some((m) => m.key === key);
  if (has('name')) data.name = `New ${label}`;
  if (has('bounds') && sig !== 'COBJ') data.bounds = { x1: 0, y1: 0, z1: 0, x2: 0, y2: 0, z2: 0 };
  const form = (edid: string): FormKey | null => ws.byEditorId(edid) ?? null;
  const struct = (key: string) => (data[key] ?? {}) as Record<string, unknown>;
  switch (sig) {
    case 'SPEL':
      data.equipType = form('EitherHand');
      data.description = '';
      data.data = { ...struct('data'), castingType: 1, delivery: 2, chargeTime: 0.5 };
      data.effects = [];
      break;
    case 'SCRL':
      data.equipType = form('EitherHand');
      data.value = { value: 50, weight: 0.5 };
      data.data = { baseCost: 0, flags: 0, type: 0, chargeTime: 0.5, castingType: 3, delivery: 2, castDuration: 0, range: 0, halfCostPerk: null };
      data.effects = [];
      break;
    case 'MGEF':
      data.data = { ...struct('data'), castingType: 1, delivery: 2, dualCastingScale: 1, skillUsageMultiplier: 1, taperWeight: 0 };
      data.description = '';
      break;
    case 'ENCH':
      data.data = { ...struct('data'), castingType: 0, delivery: 0, enchantType: 6 };
      data.effects = [];
      break;
    case 'PERK':
      data.description = '';
      data.data = { trait: 0, level: 0, numRanks: 1, playable: 1, hidden: 0 };
      data.effects = [];
      break;
    case 'SHOU':
      data.description = '';
      data.words = [];
      break;
    case 'LVLI':
    case 'LVSP':
    case 'LVLN':
      data.chanceNone = 0;
      data.flags = 1;
      data.entries = [];
      break;
    case 'COBJ':
      data.items = [];
      data.createdObject = null;
      data.workbench = form('CraftingSmithingForge');
      data.createdCount = 1;
      break;
    case 'ALCH':
      data.weight = 0.5;
      data.data = { value: 10, flags: 0, addiction: null, addictionChance: 0, consumeSound: form('ITMPotionUse') };
      data.effects = [];
      break;
    case 'INGR':
      data.data = { value: 5, weight: 0.1 };
      data.ingredient = { ingredientValue: 0, flags: 0 };
      data.effects = [];
      break;
  }
  return data;
}

/** Shallow-merge `patch` into `data`, one level deep for nested objects. */
function mergeInto(data: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur) ? { ...(cur as object), ...(v as object) } : v;
  }
  return out;
}

/** Create a new record of the given type in the active plugin (one undo step). */
export function createBlankRecord(ws: Workspace, sig: string, editorId?: string, patch: Record<string, unknown> = {}): FormKey {
  if (!isCreatable(sig)) throw new Error(`New ${sig} records can't be created here yet; duplicate an existing one instead.`);
  return ws.createRecord(sig, mergeInto(blankRecordData(ws, sig, editorId), patch));
}

/** Starting values for a new record in a catalog category (e.g. a new power is a greater power cast on yourself). */
export const CATEGORY_PRESETS: Record<string, { name?: string; editorId?: string; patch: Record<string, unknown> }> = {
  powers: { name: 'New Power', editorId: 'NewPower', patch: { data: { type: 2, castingType: 1, delivery: 0, chargeTime: 0 } } },
  abilities: { name: 'New Ability', editorId: 'NewAbility', patch: { data: { type: 4, castingType: 0, delivery: 0, chargeTime: 0 }, equipType: null } },
  afflictions: { name: 'New Disease', editorId: 'NewDisease', patch: { data: { type: 1, castingType: 0, delivery: 1, chargeTime: 0 }, equipType: null } },
};
