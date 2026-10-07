/**
 * Magic: magic effects, spells, enchantments, scrolls, shouts, words of power,
 * perks and leveled spells. Layouts follow xEdit's TES5 definitions and are
 * checked for lossless round trips against the vanilla masters.
 */
import {
  array,
  bytes,
  counted,
  empty,
  enumList,
  enumOf,
  f32,
  flagList,
  flags,
  formid,
  lstring,
  rarray,
  record,
  rstruct,
  s8,
  struct,
  sub,
  u16,
  u32,
  u8,
  union,
  unused,
  zstring,
} from '../dsl';
import type { MemberDef, RecordDef } from '../types';
import { conditions } from '../conditions';
import { CASTING_TYPES, DELIVERY_TYPES, DESC, DEST, EDID, FULL, KEYWORDS, MODEL, OBND, OBND_STRUCT, SOUND_LEVEL, VMAD, actorValue } from './common';

/** Bounds on records that are never placed in the world (always zero); kept, but not shown. */
const OBND_UNPLACED = sub('OBND', 'bounds', 'Object Bounds', { ...OBND_STRUCT, hidden: true });

const MDOB = sub('MDOB', 'menuDisplayObject', 'Menu Display Object', formid(['STAT']));
const ETYP = sub('ETYP', 'equipType', 'Equip Type', formid(['EQUP']));

/** A list of magic effects with magnitude, area, duration and conditions (spells, enchantments, potions, ingredients, scrolls). */
export const EFFECTS: MemberDef = rarray(
  'effects',
  'Effects',
  rstruct('effect', 'Effect', [
    { ...sub('EFID', 'effect', 'Magic Effect', formid(['MGEF'])), required: true },
    {
      ...sub(
        'EFIT',
        'data',
        'Magnitude / Area / Duration',
        struct([
          ['magnitude', 'Magnitude', f32()],
          ['area', 'Area (feet)', u32()],
          ['duration', 'Duration (seconds)', u32()],
        ]),
      ),
      required: true,
    },
    conditions(),
  ]),
  { prominent: true, help: 'What the item or spell does. Each effect has a strength (magnitude), an area and a duration, and can have conditions.' },
);

export const ARCHETYPES = enumList(
  'Value Modifier', 'Script', 'Dispel', 'Cure Disease', 'Absorb', 'Dual Value Modifier', 'Calm', 'Demoralize', 'Frenzy', 'Disarm',
  'Command Summoned', 'Invisibility', 'Light', 'Unknown 13', 'Unknown 14', 'Lock', 'Open', 'Bound Weapon', 'Summon Creature',
  'Detect Life', 'Telekinesis', 'Paralysis', 'Reanimate', 'Soul Trap', 'Turn Undead', 'Guide', 'Werewolf Feed', 'Cure Paralysis',
  'Cure Addiction', 'Cure Poison', 'Concussion', 'Value and Parts', 'Accumulate Magnitude', 'Stagger', 'Peak Value Modifier',
  'Cloak', 'Werewolf', 'Slow Time', 'Rally', 'Enhance Weapon', 'Spawn Hazard', 'Etherealize', 'Banish', 'Spawn Scripted Ref',
  'Disguise', 'Grab Actor', 'Vampire Lord',
);

export const MGEF_FLAGS = flagList(
  'Hostile', 'Recover', 'Detrimental', 'Snap to Navmesh', 'No Hit Event', null, null, null, 'Dispel with Keywords', 'No Duration',
  'No Magnitude', 'No Area', 'FX Persist', null, 'Gory Visuals', 'Hide in UI', null, 'No Recast', null, null, null,
  'Power Affects Magnitude', 'Power Affects Duration', null, null, null, 'Painless', 'No Hit Effect', 'No Death Dispel',
);

export const MGEF: RecordDef = record(
  'MGEF',
  'Magic Effect',
  [
    EDID,
    VMAD,
    FULL,
    MDOB,
    KEYWORDS,
    sub(
      'DATA',
      'data',
      'Data',
      struct([
        ['flags', 'Flags', flags('u32', MGEF_FLAGS)],
        ['baseCost', 'Base Cost', f32()],
        ['associatedItem', 'Associated Item', formid([], { help: 'Depends on the archetype: the light, weapon, creature, hazard or keyword it uses.' })],
        ['magicSkill', 'Magic Skill', actorValue('The school this effect belongs to; casting it trains that skill.')],
        ['resistValue', 'Resist Value', actorValue('The actor value that resists this effect, such as FireResist.')],
        ['counterEffectCount', 'Counter Effect Count', u16({ hidden: true })],
        ['unused', 'Unused', unused(2)],
        ['castingLight', 'Casting Light', formid(['LIGH'])],
        ['taperWeight', 'Taper Weight', f32()],
        ['hitShader', 'Hit Shader', formid(['EFSH'])],
        ['enchantShader', 'Enchant Shader', formid(['EFSH'])],
        ['minimumSkillLevel', 'Minimum Skill Level', u32({ help: 'Spell level: 0 novice, 25 apprentice, 50 adept, 75 expert, 100 master.' })],
        ['spellmakingArea', 'Spellmaking Area', u32()],
        ['spellmakingCastingTime', 'Spellmaking Casting Time', f32()],
        ['taperCurve', 'Taper Curve', f32()],
        ['taperDuration', 'Taper Duration', f32()],
        ['secondActorValueWeight', 'Second Actor Value Weight', f32()],
        ['archetype', 'Archetype', enumOf('u32', ARCHETYPES, { help: 'What the effect does in the game engine (change a value, run a script, summon, …).' })],
        ['actorValue', 'Actor Value', actorValue('The value the effect changes, such as Health.')],
        ['projectile', 'Projectile', formid(['PROJ'])],
        ['explosion', 'Explosion', formid(['EXPL'])],
        ['castingType', 'Casting Type', enumOf('u32', CASTING_TYPES)],
        ['delivery', 'Delivery', enumOf('u32', DELIVERY_TYPES)],
        ['secondActorValue', 'Second Actor Value', actorValue()],
        ['castingArt', 'Casting Art', formid(['ARTO'])],
        ['hitEffectArt', 'Hit Effect Art', formid(['ARTO'])],
        ['impactData', 'Impact Data', formid(['IPDS'])],
        ['skillUsageMultiplier', 'Skill Usage Multiplier', f32()],
        ['dualCastingArt', 'Dual Casting Art', formid(['DUAL'])],
        ['dualCastingScale', 'Dual Casting Scale', f32()],
        ['enchantArt', 'Enchant Art', formid(['ARTO'])],
        ['hitVisuals', 'Hit Visuals', formid(['RFCT'])],
        ['enchantVisuals', 'Enchant Visuals', formid(['RFCT'])],
        ['equipAbility', 'Equip Ability', formid(['SPEL'])],
        ['imageSpaceModifier', 'Image Space Modifier', formid(['IMAD'])],
        ['perkToApply', 'Perk to Apply', formid(['PERK'])],
        ['castingSoundLevel', 'Casting Sound Level', enumOf('u32', SOUND_LEVEL)],
        ['scriptEffectAIScore', 'Script Effect AI Score', f32()],
        ['scriptEffectAIDelayTime', 'Script Effect AI Delay Time', f32()],
      ]),
      { required: true },
    ),
    rarray('counterEffects', 'Counter Effects', sub('ESCE', 'effect', 'Counter Effect', formid(['MGEF']))),
    sub(
      'SNDD',
      'sounds',
      'Sounds',
      array(
        struct([
          ['type', 'Type', enumOf('u32', enumList('Sheathe/Draw', 'Charge', 'Ready', 'Release', 'Concentration Cast Loop', 'On Hit'))],
          ['sound', 'Sound', formid(['SNDR'])],
        ]),
      ),
    ),
    sub('DNAM', 'description', 'Magic Item Description', lstring({ hint: 'text', help: 'Shown in the magic menu; <mag> and <dur> are replaced by the magnitude and duration.' })),
    conditions(),
  ],
  { category: 'Magic' },
);

export const SPELL_TYPES = { 0: 'Spell', 1: 'Disease', 2: 'Power', 3: 'Lesser Power', 4: 'Ability', 5: 'Poison', 10: 'Addiction', 11: 'Voice' };

const SPIT = sub(
  'SPIT',
  'data',
  'Data',
  struct([
    ['baseCost', 'Base Cost', u32()],
    ['flags', 'Flags', flags('u32', { 0: 'Manual Cost Calc', 17: 'PC Start Spell', 19: 'Area Effect Ignores LOS', 20: 'Ignore Resistance', 21: 'No Absorb/Reflect', 23: 'No Dual Cast Modification' })],
    ['type', 'Type', enumOf('u32', SPELL_TYPES)],
    ['chargeTime', 'Charge Time', f32()],
    ['castingType', 'Casting Type', enumOf('u32', CASTING_TYPES)],
    ['delivery', 'Delivery', enumOf('u32', DELIVERY_TYPES)],
    ['castDuration', 'Cast Duration', f32()],
    ['range', 'Range', f32()],
    ['halfCostPerk', 'Half-cost Perk', formid(['PERK'])],
  ]),
  { required: true },
);

export const SPEL: RecordDef = record(
  'SPEL',
  'Spell',
  [EDID, OBND_UNPLACED, FULL, KEYWORDS, MDOB, ETYP, { ...DESC, required: true }, SPIT, EFFECTS],
  { category: 'Magic' },
);

export const ENCH: RecordDef = record(
  'ENCH',
  'Object Effect',
  [
    EDID,
    OBND_UNPLACED,
    FULL,
    KEYWORDS,
    sub(
      'ENIT',
      'data',
      'Data',
      struct([
        ['enchantmentCost', 'Enchantment Cost', u32()],
        ['flags', 'Flags', flags('u32', flagList('Manual Cost Calc', null, 'Extend Duration On Recast'))],
        ['castingType', 'Casting Type', enumOf('u32', CASTING_TYPES)],
        ['enchantmentAmount', 'Enchantment Amount', u32()],
        ['delivery', 'Delivery', enumOf('u32', DELIVERY_TYPES)],
        ['enchantType', 'Enchant Type', enumOf('u32', { 6: 'Enchantment', 12: 'Staff Enchantment' })],
        ['chargeTime', 'Charge Time', f32()],
        ['baseEnchantment', 'Base Enchantment', formid(['ENCH'])],
        ['wornRestrictions', 'Worn Restrictions', formid(['FLST'])],
      ]),
      { required: true },
    ),
    EFFECTS,
  ],
  { category: 'Magic' },
);

export const SCRL: RecordDef = record(
  'SCRL',
  'Scroll',
  [
    EDID,
    OBND,
    FULL,
    KEYWORDS,
    MDOB,
    ETYP,
    DESC,
    MODEL,
    DEST,
    sub('YNAM', 'pickUpSound', 'Sound - Pick Up', formid(['SNDR'])),
    sub('ZNAM', 'putDownSound', 'Sound - Put Down', formid(['SNDR'])),
    sub('DATA', 'value', 'Value / Weight', struct([['value', 'Value', u32()], ['weight', 'Weight', f32()]])),
    SPIT,
    EFFECTS,
  ],
  { category: 'Magic' },
);

export const SHOU: RecordDef = record(
  'SHOU',
  'Shout',
  [
    EDID,
    FULL,
    MDOB,
    DESC,
    rarray(
      'words',
      'Words of Power',
      sub(
        'SNAM',
        'word',
        'Word',
        struct([
          ['word', 'Word of Power', formid(['WOOP'])],
          ['spell', 'Spell', formid(['SPEL'])],
          ['recoveryTime', 'Recovery Time (seconds)', f32()],
        ]),
      ),
      { prominent: true, help: 'The three words in order; each word casts its spell and needs its recovery time.' },
    ),
  ],
  { category: 'Magic' },
);

export const WOOP: RecordDef = record(
  'WOOP',
  'Word of Power',
  [EDID, FULL, sub('TNAM', 'translation', 'Translation', lstring({ help: 'The English meaning shown when the word is learned.' }))],
  { category: 'Magic' },
);

export const LVSP: RecordDef = record(
  'LVSP',
  'Leveled Spell',
  [
    EDID,
    OBND_UNPLACED,
    sub('LVLD', 'chanceNone', 'Chance None', u8(), { required: true }),
    sub('LVLF', 'flags', 'Flags', flags('u8', flagList('Calculate from all levels <= player level', 'Calculate for each item in count', 'Use All Spells')), { required: true }),
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
                ['reference', 'Spell', formid(['SPEL', 'LVSP'])],
                ['count', 'Count', u16({ default: 1 })],
                ['unused2', 'Unused', unused(2)],
              ]),
            ),
            required: true,
          },
        ]),
      ),
      { prominent: true, help: 'Spells the list picks from: each one is available from its level on.' },
    ),
  ],
  { category: 'Magic' },
);

// ------------------------------------------------------------------ perks

export const ENTRY_POINTS = enumList(
  'Calculate Weapon Damage', 'Calculate My Critical Hit Chance', 'Calculate My Critical Hit Damage', 'Calculate Mine Explode Chance',
  'Adjust Limb Damage', 'Adjust Book Skill Points', 'Mod Recovered Health', 'Get Should Attack', 'Mod Buy Prices', 'Add Leveled List On Death',
  'Get Max Carry Weight', 'Mod Addiction Chance', 'Mod Addiction Duration', 'Mod Positive Chem Duration', 'Activate', 'Ignore Running During Detection',
  'Ignore Broken Lock', 'Mod Enemy Critical Hit Chance', 'Mod Sneak Attack Mult', 'Mod Max Placeable Mines', 'Mod Bow Zoom', 'Mod Recover Arrow Chance',
  'Mod Skill Use', 'Mod Telekinesis Distance', 'Mod Telekinesis Damage Mult', 'Mod Telekinesis Damage', 'Mod Bashing Damage', 'Mod Power Attack Stamina',
  'Mod Power Attack Damage', 'Mod Spell Magnitude', 'Mod Spell Duration', 'Mod Secondary Value Weight', 'Mod Armor Weight', 'Mod Incoming Stagger',
  'Mod Target Stagger', 'Mod Attack Damage', 'Mod Incoming Damage', 'Mod Target Damage Resistance', 'Mod Spell Cost', 'Mod Percent Blocked',
  'Mod Shield Deflect Arrow Chance', 'Mod Incoming Spell Magnitude', 'Mod Incoming Spell Duration', 'Mod Player Intimidation', 'Mod Player Reputation',
  'Mod Favor Points', 'Mod Bribe Amount', 'Mod Detection Light', 'Mod Detection Movement', 'Mod Soul Gem Recharge', 'Set Sweep Attack',
  'Apply Combat Hit Spell', 'Apply Bash Hit Spell', 'Apply Reanimate Spell', 'Set Boolean Graph Variable', 'Mod Spell Casting Sound Event',
  'Mod Pickpocket Chance', 'Mod Detection Sneak Skill', 'Mod Falling Damage', 'Mod Lockpick Sweet Spot', 'Mod Sell Prices', 'Can Pickpocket Equipped Item',
  'Set Lockpick Starting Arc', 'Set Progression Picking', 'Make Lockpicks Unbreakable', 'Mod Alchemy Effectiveness', 'Apply Weapon Swing Spell',
  'Mod Commanded Actor Limit', 'Apply Sneaking Spell', 'Mod Player Magic Slowdown', 'Mod Ward Magicka Absorption Pct', 'Mod Initial Ingredient Effects Learned',
  'Purify Alchemy Ingredients', 'Filter Activation', 'Can Dual Cast Spell', 'Mod Tempering Health', 'Mod Enchantment Power', 'Mod Soul Pct Captured to Weapon',
  'Mod Soul Gem Enchanting', 'Mod # Applied Enchantments Allowed', 'Set Activate Label', 'Mod Shout OK', 'Mod Poison Dose Count', 'Should Apply Placed Item',
  'Mod Armor Rating', 'Mod Lockpicking Crime Chance', 'Mod Ingredients Harvested', 'Mod Spell Range (Target Loc.)', 'Mod Potions Created',
  'Mod Lockpicking Key Reward Chance', 'Allow Mount Actor',
);

export const ENTRY_FUNCTIONS = enumList(
  'Unknown 0', 'Set Value', 'Add Value', 'Multiply Value', 'Add Range To Value', 'Add Actor Value Mult', 'Absolute Value', 'Negative Absolute Value',
  'Add Leveled List', 'Add Activate Choice', 'Select Spell', 'Select Text', 'Set to Actor Value Mult', 'Multiply Actor Value Mult',
  'Multiply 1 + Actor Value Mult', 'Set Text',
);

const perkType = (group: Record<string, unknown> | undefined): number => Number((group?.header as { type?: number } | undefined)?.type ?? 0);
const functionDataType = (group: Record<string, unknown> | undefined): number => Number(group?.functionType ?? 0);

/** One perk effect: changes a quest stage, adds an ability, or changes an entry point (with conditions per tab). */
const PERK_EFFECT = rstruct('effect', 'Effect', [
  {
    ...sub(
      'PRKE',
      'header',
      'Effect',
      struct([
        ['type', 'Type', enumOf('u8', enumList('Quest Stage', 'Ability', 'Entry Point'))],
        ['rank', 'Rank', u8()],
        ['priority', 'Priority', u8()],
      ]),
    ),
    required: true,
  },
  sub(
    'DATA',
    'data',
    'Effect Data',
    union(({ codec }) => perkType(codec.group), [
      struct([
        ['quest', 'Quest', formid(['QUST'])],
        ['stage', 'Stage', u8()],
        ['unused', 'Unused', unused(3)],
      ]),
      struct([['ability', 'Ability', formid(['SPEL'])]]),
      struct([
        ['entryPoint', 'Entry Point', enumOf('u8', ENTRY_POINTS)],
        ['function', 'Function', enumOf('u8', ENTRY_FUNCTIONS)],
        ['conditionTabs', 'Condition Tabs', u8({ hidden: true })],
      ]),
    ]),
  ),
  rarray(
    'conditionTabs',
    'Conditions',
    rstruct('tab', 'Condition Tab', [
      { ...sub('PRKC', 'runOn', 'Run On (tab)', s8({ help: 'Which subject the conditions test: 0 = the perk owner, then the entry point\'s other subjects (target, weapon, spell…).' })), required: true },
      conditions(),
    ]),
  ),
  rstruct('function', 'Function Parameters', [
    sub('EPFT', 'functionType', 'Parameter Type', enumOf('u8', enumList('None', 'Float', 'Actor Value, Float', 'Leveled Item', 'Spell (with button label)', 'Spell', 'Text', 'Text (translated)'))),
    sub('EPF2', 'buttonLabel', 'Button Label', lstring()),
    sub('EPF3', 'scriptFlags', 'Script Flags', flags('u16', flagList('Run Immediately', 'Replace Default'))),
    sub(
      'EPFD',
      'data',
      'Parameters',
      union(({ codec }) => functionDataType(codec.group), [
        bytes(),
        struct([['value', 'Value', f32()]]),
        struct([['actorValue', 'Actor Value', f32()], ['value', 'Value', f32()]]),
        struct([['leveledItem', 'Leveled Item', formid(['LVLI'])]]),
        struct([['spell', 'Spell', formid(['SPEL'])]]),
        struct([['spell', 'Spell', formid(['SPEL'])]]),
        struct([['text', 'Text', zstring()]]),
        struct([['text', 'Text', lstring()]]),
      ]),
    ),
  ]),
  sub('PRKF', 'end', 'End Marker', empty({ hidden: true }), { required: true }),
]);

export const PERK: RecordDef = record(
  'PERK',
  'Perk',
  [
    EDID,
    VMAD,
    FULL,
    { ...DESC, required: true },
    sub('ICON', 'icon', 'Icon', zstring()),
    conditions(),
    sub(
      'DATA',
      'data',
      'Data',
      struct([
        ['trait', 'Trait', u8({ hidden: true })],
        ['level', 'Level', u8()],
        ['numRanks', 'Number of Ranks', u8()],
        ['playable', 'Playable', u8({ help: '1 if the player can pick it in the skill trees.' })],
        ['hidden', 'Hidden', u8()],
      ]),
      { required: true },
    ),
    sub('NNAM', 'nextPerk', 'Next Perk', formid(['PERK'])),
    rarray('effects', 'Effects', PERK_EFFECT, { prominent: true, help: 'What the perk does: start a quest stage, give an ability, or change a game calculation (an entry point).' }),
  ],
  { category: 'Character' },
);
