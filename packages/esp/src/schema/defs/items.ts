/** Inventory items. Only fields the editor surfaces are typed; the rest is preserved verbatim. */
import { bytes, counted, enumList, enumOf, f32, flagList, flags, formid, lstring, rarray, record, rstruct, s32, struct, sub, u16, u32, u8, union, unused, zstring } from '../dsl';
import { conditions } from '../conditions';
import type { MemberDef, RecordDef } from '../types';
import { DESC, DEST, EDID, FULL, ITEMS, KEYWORDS, MODEL, OBND, SOUND_LEVEL, VMAD, actorValue, model } from './common';
import { EFFECTS } from './magic';

const ICON = sub('ICON', 'icon', 'Inventory Image', zstring());
const MICO = sub('MICO', 'messageIcon', 'Message Icon', zstring());
const YNAM = sub('YNAM', 'pickUpSound', 'Sound - Pick Up', formid(['SNDR']));
const ZNAM = sub('ZNAM', 'putDownSound', 'Sound - Put Down', formid(['SNDR']));
const ETYP = sub('ETYP', 'equipType', 'Equip Type', formid(['EQUP']));
const EITM = sub('EITM', 'enchantment', 'Object Effect', formid(['ENCH', 'SPEL']));
const EAMT = sub('EAMT', 'enchantmentAmount', 'Enchantment Amount', u16());
const SOUL_SIZES = enumList('None', 'Petty', 'Lesser', 'Common', 'Greater', 'Grand');

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

const WEAPON_ANIMATIONS = enumList('Hand to Hand', 'One-Handed Sword', 'One-Handed Dagger', 'One-Handed Axe', 'One-Handed Mace', 'Two-Handed Sword', 'Two-Handed Axe', 'Bow', 'Staff', 'Crossbow');

export const WEAP: RecordDef = record(
  'WEAP',
  'Weapon',
  [
    EDID,
    VMAD,
    OBND,
    FULL,
    MODEL,
    ICON,
    MICO,
    EITM,
    EAMT,
    DEST,
    ETYP,
    sub('BIDS', 'bashImpact', 'Block Bash Impact Data Set', formid(['IPDS'])),
    sub('BAMT', 'alternateBlockMaterial', 'Alternate Block Material', formid(['MATT'])),
    YNAM,
    ZNAM,
    KEYWORDS,
    DESC,
    model('MOD3', 'scopeModel', 'Has Scope Model', 'MO3T', 'MO3S'),
    sub('NNAM', 'embeddedNode', 'Embedded Weapon Node', zstring()),
    sub('INAM', 'impactDataSet', 'Impact Data Set', formid(['IPDS'])),
    sub('WNAM', 'firstPersonModel', '1st Person Model Object', formid(['STAT'])),
    sub('SNAM', 'attackSound', 'Attack Sound', formid(['SNDR'])),
    sub('XNAM', 'attackSound2D', 'Attack Sound 2D', formid(['SNDR'])),
    sub('NAM7', 'attackLoopSound', 'Attack Loop Sound', formid(['SNDR'])),
    sub('TNAM', 'attackFailSound', 'Attack Fail Sound', formid(['SNDR'])),
    sub('UNAM', 'idleSound', 'Idle Sound', formid(['SNDR'])),
    sub('NAM9', 'equipSound', 'Equip Sound', formid(['SNDR'])),
    sub('NAM8', 'unequipSound', 'Unequip Sound', formid(['SNDR'])),
    sub('DATA', 'data', 'Game Data', struct([['value', 'Value', u32()], ['weight', 'Weight', f32()], ['damage', 'Damage', u16()]])),
    sub(
      'DNAM',
      'stats',
      'Data',
      struct([
        ['animationType', 'Animation Type', enumOf('u8', WEAPON_ANIMATIONS)],
        ['unused', 'Unused', unused(3)],
        ['speed', 'Speed', f32()],
        ['reach', 'Reach', f32()],
        ['flags', 'Flags', flags('u16', flagList('Ignores Normal Weapon Resistance', 'Automatic (unused)', 'Has Scope (unused)', "Can't Drop", 'Hide Backpack (unused)', 'Embedded Weapon (unused)', "Don't Use 1st Person IS Anim (unused)", 'Non-playable'))],
        ['unused2', 'Unused', unused(2)],
        ['sightFOV', 'Sight FOV', f32()],
        ['unknown', 'Unknown', bytes(4, { hidden: true })],
        ['baseVATSToHitChance', 'Base VATS To-Hit Chance', u8()],
        ['attackAnimation', 'Attack Animation', u8()],
        ['projectiles', 'Number of Projectiles', u8()],
        ['embeddedWeaponAV', 'Embedded Weapon AV (unused)', u8({ hidden: true })],
        ['minRange', 'Range Min', f32()],
        ['maxRange', 'Range Max', f32()],
        ['onHit', 'On Hit', enumOf('u32', enumList('No formula behaviour', 'Dismember only', 'Explode only', 'No dismember/explode'))],
        ['flags2', 'Flags 2', flags('u32', flagList('Player Only', 'NPCs Use Ammo', 'No Jam After Reload (unused)', null, 'Minor Crime', 'Range Fixed', 'Not Used in Normal Combat', null, "Don't Use 3rd Person IS Anim (unused)", null, 'Rumble - Alternate', null, 'Non-hostile', 'Bound Weapon'))],
        ['animationAttackMult', 'Animation Attack Mult', f32()],
        ['unknown2', 'Unknown', f32({ hidden: true })],
        ['rumbleLeft', 'Rumble - Left Motor Strength', f32()],
        ['rumbleRight', 'Rumble - Right Motor Strength', f32()],
        ['rumbleDuration', 'Rumble - Duration', f32()],
        ['unknown3', 'Unknown', bytes(12, { hidden: true })],
        ['skill', 'Skill', actorValue('The skill this weapon uses and trains.')],
        ['unknown4', 'Unknown', bytes(8, { hidden: true })],
        ['resist', 'Resist', actorValue()],
        ['unknown5', 'Unknown', bytes(4, { hidden: true })],
        ['stagger', 'Stagger', f32()],
      ]),
    ),
    sub(
      'CRDT',
      'critical',
      'Critical Data',
      union(({ codec }) => (codec.formVersion >= 44 ? 0 : 1), [
        struct([
          ['damage', 'Damage', u16()],
          ['unused', 'Unused', unused(2)],
          ['multiplier', '% Mult', f32()],
          ['flags', 'Flags', flags('u8', flagList('On Death'))],
          ['unused2', 'Unused', unused(7)],
          ['effect', 'Effect', formid(['SPEL'])],
          ['unused3', 'Unused', unused(4)],
        ]),
        struct([
          ['damage', 'Damage', u16()],
          ['unused', 'Unused', unused(2)],
          ['multiplier', '% Mult', f32()],
          ['flags', 'Flags', flags('u8', flagList('On Death'))],
          ['unused2', 'Unused', unused(3)],
          ['effect', 'Effect', formid(['SPEL'])],
        ]),
      ]),
    ),
    sub('VNAM', 'detectionSoundLevel', 'Detection Sound Level', enumOf('u32', SOUND_LEVEL)),
    sub('CNAM', 'template', 'Template', formid(['WEAP'])),
  ],
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
        // A skill (actor value) for skill books, a spell for spell tomes.
        ['teaches', 'Skill / Spell', union(({ parent }) => (Number(parent?.flags ?? 0) & 4 ? 1 : 0), [u32(), formid(['SPEL'])])],
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
  [
    EDID,
    OBND,
    FULL,
    MODEL,
    ICON,
    MICO,
    DEST,
    YNAM,
    ZNAM,
    DESC,
    KEYWORDS,
    sub(
      'DATA',
      'data',
      'Data',
      struct([
        ['projectile', 'Projectile', formid(['PROJ'])],
        ['flags', 'Flags', flags('u32', flagList('Ignores Normal Weapon Resistance', 'Non-Playable', 'Non-Bolt'))],
        ['damage', 'Damage', f32()],
        ['value', 'Value', u32()],
        ['weight', 'Weight', f32()],
      ]),
    ),
    sub('ONAM', 'shortName', 'Short Name', lstring()),
  ],
  { category: 'Items' },
);

const VALUE_WEIGHT = struct([['value', 'Value', u32()], ['weight', 'Weight', f32()]]);

export const ALCH: RecordDef = record(
  'ALCH',
  'Ingestible',
  [
    EDID,
    VMAD,
    OBND,
    FULL,
    KEYWORDS,
    DESC,
    MODEL,
    DEST,
    ICON,
    MICO,
    YNAM,
    ZNAM,
    ETYP,
    sub('DATA', 'weight', 'Weight', f32(), { required: true }),
    sub(
      'ENIT',
      'data',
      'Data',
      struct([
        ['value', 'Value', s32()],
        ['flags', 'Flags', flags('u32', { 0: 'No Auto-Calc', 1: 'Food Item', 16: 'Medicine', 17: 'Poison' })],
        ['addiction', 'Addiction', formid(['SPEL'])],
        ['addictionChance', 'Addiction Chance', f32()],
        ['consumeSound', 'Sound - Consume', formid(['SNDR'])],
      ]),
      { required: true },
    ),
    EFFECTS,
  ],
  { category: 'Items' },
);

export const INGR: RecordDef = record(
  'INGR',
  'Ingredient',
  [
    EDID,
    VMAD,
    OBND,
    FULL,
    KEYWORDS,
    MODEL,
    ICON,
    MICO,
    DEST,
    ETYP,
    YNAM,
    ZNAM,
    sub('DATA', 'data', 'Value / Weight', VALUE_WEIGHT, { required: true }),
    sub(
      'ENIT',
      'ingredient',
      'Effect Data',
      struct([
        ['ingredientValue', 'Ingredient Value', s32()],
        ['flags', 'Flags', flags('u32', { 0: 'No Auto-Calculation', 1: 'Food Item', 8: 'References Persist' })],
      ]),
      { required: true },
    ),
    EFFECTS,
  ],
  { category: 'Items' },
);

export const SLGM: RecordDef = record(
  'SLGM',
  'Soul Gem',
  [
    EDID,
    OBND,
    FULL,
    MODEL,
    ICON,
    MICO,
    DEST,
    YNAM,
    ZNAM,
    KEYWORDS,
    sub('DATA', 'data', 'Value / Weight', VALUE_WEIGHT),
    sub('SOUL', 'soul', 'Contained Soul', enumOf('u8', SOUL_SIZES)),
    sub('SLCP', 'capacity', 'Maximum Capacity', enumOf('u8', SOUL_SIZES)),
    sub('NAM0', 'linkedTo', 'Linked To', formid(['SLGM'], { help: 'The empty version of this gem, used once its soul is spent.' })),
  ],
  { category: 'Items' },
);

export const APPA: RecordDef = record(
  'APPA',
  'Apparatus',
  [
    EDID,
    VMAD,
    OBND,
    FULL,
    MODEL,
    ICON,
    MICO,
    DEST,
    YNAM,
    ZNAM,
    sub('QUAL', 'quality', 'Quality', enumOf('u32', enumList('Novice', 'Apprentice', 'Journeyman', 'Expert', 'Master'))),
    DESC,
    sub('DATA', 'data', 'Value / Weight', VALUE_WEIGHT),
  ],
  { category: 'Items' },
);

export const LVLI: RecordDef = record(
  'LVLI',
  'Leveled Item',
  [
    EDID,
    { ...OBND, def: { ...OBND.def, hidden: true } } as typeof OBND,
    sub('LVLD', 'chanceNone', 'Chance None (%)', u8(), { required: true, help: 'The chance that the list gives nothing at all.' }),
    sub('LVLF', 'flags', 'Flags', flags('u8', flagList('Calculate from all levels <= player level', 'Calculate for each item in count', 'Use All', 'Special Loot')), { required: true }),
    sub('LVLG', 'global', 'Chance None Global', formid(['GLOB'])),
    counted(
      'LLCT',
      'u8',
      'entries',
      'Entries',
      rarray(
        'entries',
        'Entries',
        rstruct('entry', 'Entry', [
          {
            ...sub(
              'LVLO',
              'entry',
              'Entry',
              struct([
                ['level', 'Level', u16({ default: 1 })],
                ['unused', 'Unused', unused(2)],
                ['reference', 'Item', formid(['ARMO', 'AMMO', 'APPA', 'MISC', 'WEAP', 'BOOK', 'LVLI', 'KEYM', 'ALCH', 'INGR', 'LIGH', 'SLGM', 'SCRL'])],
                ['count', 'Count', u16({ default: 1 })],
                ['unused2', 'Unused', unused(2)],
              ]),
            ),
            required: true,
          },
          sub(
            'COED',
            'extra',
            'Extra Data',
            struct([
              ['owner', 'Owner', formid(['NPC_', 'FACT'])],
              ['globalOrRank', 'Global / Required Rank', u32()],
              ['condition', 'Item Condition', f32()],
            ]),
          ),
        ]),
      ),
      { prominent: true, help: 'Items the list picks from: each one is available from its level on.' },
    ),
  ],
  { category: 'Items' },
);

export const COBJ: RecordDef = record(
  'COBJ',
  'Constructible Object',
  [
    EDID,
    { ...ITEMS, label: 'Components', prominent: true, help: 'What making the item uses up.' },
    conditions(),
    sub('CNAM', 'createdObject', 'Created Object', formid([], { help: 'What is made.' })),
    sub('BNAM', 'workbench', 'Workbench Keyword', formid(['KYWD'], { help: 'Where it is made: CraftingSmithingForge, CraftingSmithingArmorTable, CraftingTanningRack, …' })),
    sub('NAM1', 'createdCount', 'Created Object Count', u16({ default: 1 })),
  ],
  { category: 'Items' },
);

export const ARMA: RecordDef = record(
  'ARMA',
  'Armor Addon',
  [EDID, BODT, BOD2, sub('RNAM', 'race', 'Race', formid(['RACE'])), sub('DNAM', 'data', 'Data', bytes())],
  { category: 'Items' },
);
