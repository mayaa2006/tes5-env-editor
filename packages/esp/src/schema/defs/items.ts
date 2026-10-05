/** Inventory items. Only fields the editor surfaces are typed; the rest is preserved verbatim. */
import { bytes, f32, flagList, flags, formid, lstring, record, rstruct, s32, struct, sub, u32, zstring } from '../dsl';
import type { MemberDef, RecordDef } from '../types';
import { DESC, DEST, EDID, FULL, KEYWORDS, MODEL, OBND, VMAD } from './common';

const ICON = sub('ICON', 'icon', 'Inventory Image', zstring());
const MICO = sub('MICO', 'messageIcon', 'Message Icon', zstring());
const YNAM = sub('YNAM', 'pickUpSound', 'Sound - Pick Up', formid(['SNDR']));
const ZNAM = sub('ZNAM', 'putDownSound', 'Sound - Put Down', formid(['SNDR']));
const ETYP = sub('ETYP', 'equipType', 'Equip Type', formid(['EQUP']));
const EITM = sub('EITM', 'enchantment', 'Object Effect', formid(['ENCH', 'SPEL']));
const EAMT = sub('EAMT', 'enchantmentAmount', 'Enchantment Amount', bytes(2));

function biped(key: string, label: string, modelSig: string, infoSig: string, altSig: string, iconSig: string, micoSig: string): MemberDef {
  return rstruct(key, label, [
    sub(modelSig, 'file', 'Model File', zstring()),
    sub(infoSig, 'info', 'Model Info', bytes(undefined, { hidden: true })),
    sub(altSig, 'alternateTextures', 'Alternate Textures', bytes(undefined, { hidden: true })),
    sub(iconSig, 'icon', 'Icon', zstring()),
    sub(micoSig, 'messageIcon', 'Message Icon', zstring()),
  ]);
}

const BOD2 = sub(
  'BOD2',
  'bodyTemplate',
  'Biped Body Template',
  struct([
    ['slots', 'First Person Flags (Biped Slots 30-61)', u32()],
    ['armorType', 'Armor Type', u32()],
  ]),
);
const BODT = sub('BODT', 'bodyTemplateOld', 'Body Template (old)', bytes());

export const ARMO: RecordDef = record(
  'ARMO',
  'Armor',
  [
    EDID,
    VMAD,
    OBND,
    FULL,
    EITM,
    EAMT,
    biped('maleModel', 'Male World Model', 'MOD2', 'MO2T', 'MO2S', 'ICON', 'MICO'),
    biped('femaleModel', 'Female World Model', 'MOD4', 'MO4T', 'MO4S', 'ICO2', 'MIC2'),
    BODT,
    BOD2,
    DEST,
    YNAM,
    ZNAM,
    sub('BMCT', 'ragdollTemplate', 'Ragdoll Constraint Template', zstring()),
    ETYP,
    sub('BIDS', 'bashImpact', 'Bash Impact Data Set', formid(['IPDS'])),
    sub('BAMT', 'alternateBlockMaterial', 'Alternate Block Material', formid(['MATT'])),
    sub('RNAM', 'race', 'Race', formid(['RACE'])),
    KEYWORDS,
    { ...DESC, required: true },
    { m: 'rarray', key: 'armatures', label: 'Armature', of: sub('MODL', 'armature', 'Armor Addon', formid(['ARMA'])) },
    sub('DATA', 'data', 'Data', struct([['value', 'Value', s32()], ['weight', 'Weight', f32()]])),
    sub('DNAM', 'armorRating', 'Armor Rating (× 100)', s32()),
    sub('TNAM', 'template', 'Template Armor', formid(['ARMO'])),
  ],
  { category: 'Items' },
);

export const WEAP: RecordDef = record(
  'WEAP',
  'Weapon',
  [EDID, VMAD, OBND, FULL, MODEL, ICON, EITM, EAMT, DEST, ETYP, sub('BIDS', 'bashImpact', 'Block Bash Impact Data Set', formid(['IPDS'])), sub('BAMT', 'alternateBlockMaterial', 'Alternate Block Material', formid(['MATT'])), YNAM, ZNAM, KEYWORDS, DESC],
  { category: 'Items' },
);

export const BOOK: RecordDef = record(
  'BOOK',
  'Book',
  [
    EDID,
    VMAD,
    OBND,
    FULL,
    MODEL,
    ICON,
    MICO,
    sub('DESC', 'text', 'Book Text', lstring({ hint: 'text' }), { required: true }),
    DEST,
    YNAM,
    ZNAM,
    KEYWORDS,
    sub(
      'DATA',
      'data',
      'Data',
      struct([
        ['flags', 'Flags', flags('u8', flagList('Teaches Skill', "Can't be Taken", 'Teaches Spell'))],
        ['type', 'Type', bytes(3, { hidden: true })],
        ['teaches', 'Skill / Spell', u32()],
        ['value', 'Value', u32()],
        ['weight', 'Weight', f32()],
      ]),
    ),
    sub('INAM', 'inventoryArt', 'Inventory Art', formid(['STAT'])),
    sub('CNAM', 'description', 'Description', lstring()),
  ],
  { category: 'Items' },
);

export const MISC: RecordDef = record(
  'MISC',
  'Misc. Item',
  [EDID, VMAD, OBND, FULL, MODEL, ICON, MICO, DEST, YNAM, ZNAM, KEYWORDS, sub('DATA', 'data', 'Data', struct([['value', 'Value', s32()], ['weight', 'Weight', f32()]]))],
  { category: 'Items' },
);

export const KEYM: RecordDef = record(
  'KEYM',
  'Key',
  [EDID, VMAD, OBND, FULL, MODEL, ICON, MICO, DEST, YNAM, ZNAM, KEYWORDS, sub('DATA', 'data', 'Data', struct([['value', 'Value', s32()], ['weight', 'Weight', f32()]]))],
  { category: 'Items' },
);

export const AMMO: RecordDef = record(
  'AMMO',
  'Ammunition',
  [EDID, VMAD, OBND, FULL, MODEL, ICON, MICO, DEST, YNAM, ZNAM, DESC, KEYWORDS],
  { category: 'Items' },
);

export const ALCH: RecordDef = record('ALCH', 'Ingestible', [EDID, VMAD, OBND, FULL, KEYWORDS, DESC, MODEL], { category: 'Items' });

export const INGR: RecordDef = record('INGR', 'Ingredient', [EDID, VMAD, OBND, FULL, KEYWORDS, MODEL], { category: 'Items' });

export const SLGM: RecordDef = record('SLGM', 'Soul Gem', [EDID, OBND, FULL, MODEL, ICON, MICO, DEST, YNAM, ZNAM, KEYWORDS], { category: 'Items' });

export const ARMA: RecordDef = record(
  'ARMA',
  'Armor Addon',
  [EDID, BODT, BOD2, sub('RNAM', 'race', 'Race', formid(['RACE'])), sub('DNAM', 'data', 'Data', bytes())],
  { category: 'Items' },
);
