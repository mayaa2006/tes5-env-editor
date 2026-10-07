/** Building blocks shared by many record definitions (mirrors xEdit's wbEDID, wbFULL, ...). */
import { conditions } from '../conditions';
import {
  array,
  bytes,
  counted,
  custom,
  enumList,
  f32,
  flagList,
  flags,
  formid,
  lstring,
  rarray,
  rstruct,
  s16,
  s32,
  struct,
  sub,
  u16,
  u32,
  u8,
  unused,
  vec3,
  zstring,
  empty,
} from '../dsl';
import type { MemberDef, StructDef } from '../types';
import { vmadCodec } from '../vmad';

export const EDID = sub('EDID', 'editorId', 'Editor ID', zstring());
export const FULL = sub('FULL', 'name', 'Name', lstring());
export const DESC = sub('DESC', 'description', 'Description', lstring());
export const VMAD = sub('VMAD', 'scripts', 'Scripts', custom('VMAD', vmadCodec));

export const OBND_STRUCT = struct([
  ['x1', 'X1', s16()],
  ['y1', 'Y1', s16()],
  ['z1', 'Z1', s16()],
  ['x2', 'X2', s16()],
  ['y2', 'Y2', s16()],
  ['z2', 'Z2', s16()],
]);
export const OBND = sub('OBND', 'bounds', 'Object Bounds', OBND_STRUCT, { help: 'Recomputed automatically from the model when you save.' });

/** Generic model: MODL + MODT (texture hashes) + MODS (alternate textures). */
export function model(sig = 'MODL', key = 'model', label = 'Model', infoSig = 'MODT', altSig = 'MODS'): MemberDef {
  return rstruct(key, label, [
    { ...sub(sig, 'file', 'Model File', zstring({ hint: 'text' })), required: true },
    sub(infoSig, 'info', 'Model Info', bytes(undefined, { hidden: true })),
    sub(altSig, 'alternateTextures', 'Alternate Textures', bytes(undefined, { hidden: true })),
  ]);
}

export const MODEL = model();

export const KEYWORDS = counted('KSIZ', 'u32', 'keywords', 'Keywords', sub('KWDA', 'keywords', 'Keywords', array(formid(['KYWD']))));

export const CONDITIONS = conditions();

export const DEST = rstruct('destructible', 'Destructible', [
  sub(
    'DEST',
    'header',
    'Header',
    struct([
      ['health', 'Health', s32()],
      ['stageCount', 'Stage Count', u8()],
      ['vatsTargetable', 'VATS Targetable', u8()],
      ['unknown', 'Unknown', bytes(2, { hidden: true })],
    ]),
  ),
  rarray(
    'stages',
    'Stages',
    rstruct('stage', 'Stage', [
      { ...sub('DSTD', 'data', 'Stage Data', bytes()), required: true },
      sub('DMDL', 'model', 'Model', zstring()),
      sub('DMDT', 'modelInfo', 'Model Info', bytes(undefined, { hidden: true })),
      sub('DMDS', 'alternateTextures', 'Alternate Textures', bytes(undefined, { hidden: true })),
      sub('DSTF', 'end', 'End Marker', empty({ hidden: true })),
    ]),
  ),
]);

export const ITEMS = counted(
  'COCT',
  'u32',
  'items',
  'Inventory',
  rarray(
    'items',
    'Items',
    rstruct('item', 'Item', [
      {
        ...sub(
          'CNTO',
          'item',
          'Item',
          struct([
            ['item', 'Item', formid(['ARMO', 'AMMO', 'APPA', 'MISC', 'WEAP', 'BOOK', 'LVLI', 'KEYM', 'ALCH', 'INGR', 'LIGH', 'SLGM', 'SCRL'])],
            ['count', 'Count', s32({ default: 1 })],
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
);

export const SPELLS = counted('SPCT', 'u32', 'spells', 'Spells', rarray('spells', 'Spells', sub('SPLO', 'spell', 'Spell', formid(['SPEL', 'SHOU', 'LVSP']))));

export const XESP_STRUCT = struct([
  ['reference', 'Reference', formid(['PLYR', 'ACHR', 'REFR', 'PGRE', 'PHZD', 'PMIS', 'PARW', 'PBAR', 'PBEA', 'PCON', 'PFLA'])],
  ['flags', 'Flags', flags('u8', flagList('Set Enable State to Opposite of Parent', 'Pop In'))],
  ['unused', 'Unused', unused(3)],
]);
export const XESP = sub('XESP', 'enableParent', 'Enable Parent', XESP_STRUCT);

export const POS_ROT: StructDef = struct([
  ['position', 'Position', vec3({ hint: 'position' })],
  ['rotation', 'Rotation', vec3({ hint: 'radians' })],
]);
export const DATA_POSROT = sub('DATA', 'placement', 'Position / Rotation', POS_ROT, { required: true });

export const XSCL = sub('XSCL', 'scale', 'Scale', f32({ hint: 'scale', default: 1 }));

export const OWNERSHIP = rstruct('ownership', 'Ownership', [
  sub('XOWN', 'owner', 'Owner', formid(['FACT', 'NPC_'])),
  sub('XRNK', 'rank', 'Faction Rank', s32()),
]);

export const XLKR = rarray(
  'linkedRefs',
  'Linked References',
  sub(
    'XLKR',
    'link',
    'Linked Reference',
    struct([
      ['keyword', 'Keyword', formid(['KYWD'])],
      ['ref', 'Reference', formid(['PLYR', 'ACHR', 'REFR', 'PGRE', 'PHZD', 'PMIS', 'PARW', 'PBAR', 'PBEA', 'PCON', 'PFLA'])],
    ]),
  ),
);

export const BYTE_COLOR = struct(
  [
    ['r', 'Red', u8()],
    ['g', 'Green', u8()],
    ['b', 'Blue', u8()],
    ['unused', 'Unused', unused(1)],
  ],
  { hint: 'color' },
);

export const FLOAT_COLOR = struct(
  [
    ['r', 'Red', f32()],
    ['g', 'Green', f32()],
    ['b', 'Blue', f32()],
  ],
  { hint: 'rgb' },
);

export const SOUND_LEVEL = enumList('Loud', 'Normal', 'Silent', 'Very Loud');

export const ATTACKS = rarray(
  'attacks',
  'Attacks',
  rstruct('attack', 'Attack', [
    { ...sub('ATKD', 'data', 'Attack Data', bytes()), required: true },
    sub('ATKE', 'event', 'Attack Event', zstring()),
  ]),
);

export { conditions, u16 };

const SKILL_NAMES = ['OneHanded', 'TwoHanded', 'Marksman', 'Block', 'Smithing', 'HeavyArmor', 'LightArmor', 'Pickpocket', 'Lockpicking', 'Sneak', 'Alchemy', 'Speechcraft', 'Alteration', 'Conjuration', 'Destruction', 'Illusion', 'Restoration', 'Enchanting'];

/** Actor value index → name (as the game's scripts call them). -1 is "none". */
export const ACTOR_VALUES: Record<number, string> = (() => {
  const names: string[] = [
    'Aggression', 'Confidence', 'Energy', 'Morality', 'Mood', 'Assistance',
    ...SKILL_NAMES,
    'Health', 'Magicka', 'Stamina', 'HealRate', 'MagickaRate', 'StaminaRate', 'SpeedMult', 'InventoryWeight', 'CarryWeight',
    'CritChance', 'MeleeDamage', 'UnarmedDamage', 'Mass', 'VoicePoints', 'VoiceRate', 'DamageResist', 'PoisonResist',
    'FireResist', 'ElectricResist', 'FrostResist', 'MagicResist', 'DiseaseResist',
    'Unknown46', 'Unknown47', 'Unknown48', 'Unknown49', 'Unknown50', 'Unknown51', 'Unknown52',
    'Paralysis', 'Invisibility', 'NightEye', 'DetectLifeRange', 'WaterBreathing', 'WaterWalking', 'Unknown59', 'Fame', 'Infamy',
    'JumpingBonus', 'WardPower', 'RightItemCharge', 'ArmorPerks', 'ShieldPerks', 'WardDeflection',
    'Variable01', 'Variable02', 'Variable03', 'Variable04', 'Variable05', 'Variable06', 'Variable07', 'Variable08', 'Variable09', 'Variable10',
    'BowSpeedBonus', 'FavorActive', 'FavorsPerDay', 'FavorsPerDayTimer', 'LeftItemCharge', 'AbsorbChance', 'Blindness',
    'WeaponSpeedMult', 'ShoutRecoveryMult', 'BowStaggerBonus', 'Telekinesis', 'FavorPointsBonus', 'LastBribedIntimidated',
    'LastFlattered', 'MovementNoiseMult', 'BypassVendorStolenCheck', 'BypassVendorKeywordCheck', 'WaitingForPlayer',
    ...SKILL_NAMES.map((s) => `${s}Mod`),
    ...SKILL_NAMES.map((s) => `${s}SkillAdvance`),
    'LeftWeaponSpeedMult', 'DragonSouls', 'CombatHealthRegenMult',
    ...SKILL_NAMES.map((s) => `${s}PowerMod`),
    'DragonRend', 'AttackDamageMult', 'HealRateMult', 'MagickaRateMult', 'StaminaRateMult', 'WerewolfPerks', 'VampirePerks',
    'GrabActorOffset', 'Grabbed', 'Unknown162', 'ReflectDamage',
  ];
  const out: Record<number, string> = { [-1]: 'None' };
  names.forEach((n, i) => (out[i] = n));
  return out;
})();

/** An actor value field (stored as a signed 32-bit index). */
export const actorValue = (help?: string) => s32Enum(ACTOR_VALUES, help);
function s32Enum(e: Record<number, string>, help?: string) {
  return { t: 'int' as const, size: 's32' as const, enum: e, ...(help ? { help } : {}) };
}

export const CASTING_TYPES = { 0: 'Constant Effect', 1: 'Fire and Forget', 2: 'Concentration', 3: 'Scroll' };
export const DELIVERY_TYPES = { 0: 'Self', 1: 'Touch', 2: 'Aimed', 3: 'Target Actor', 4: 'Target Location' };
