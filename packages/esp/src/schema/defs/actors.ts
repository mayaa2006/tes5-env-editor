/** Actor-related records: NPCs, races, head parts, voices, classes, factions, outfits. */
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
  s16,
  s32,
  s8,
  struct,
  sub,
  u16,
  u32,
  u8,
  unused,
  zstring,
} from '../dsl';
import type { RecordDef } from '../types';
import { ATTACKS, CONDITIONS, DEST, EDID, FLOAT_COLOR, FULL, ITEMS, KEYWORDS, MODEL, OBND, SOUND_LEVEL, SPELLS, VMAD, DESC } from './common';

const FACTION_FLAGS = flagList('Hidden From PC', 'Special Combat', '', '', '', '', 'Track Crime', 'Ignore Crimes: Murder', 'Ignore Crimes: Assault', 'Ignore Crimes: Stealing', 'Ignore Crimes: Trespass', 'Do Not Report Crimes Against Members', 'Crime Gold: Use Defaults', 'Ignore Crimes: Pickpocket', 'Vendor', 'Can Be Owner', 'Ignore Crimes: Werewolf');

export const SKILLS = [
  'OneHanded', 'TwoHanded', 'Marksman', 'Block', 'Smithing', 'HeavyArmor', 'LightArmor', 'Pickpocket', 'Lockpicking',
  'Sneak', 'Alchemy', 'Speechcraft', 'Alteration', 'Conjuration', 'Destruction', 'Illusion', 'Restoration', 'Enchanting',
] as const;

export const ACBS_FLAGS = flagList(
  'Female', 'Essential', 'Is CharGen Face Preset', 'Respawn', 'Auto-calc Stats', 'Unique', "Doesn't Affect Stealth Meter",
  'PC Level Mult', 'Use Template?', null, null, 'Protected', null, null, 'Summonable', null, "Doesn't Bleed", null,
  'Bleedout Override', 'Opposite Gender Anims', 'Simple Actor', 'Looped Script?', null, null, null, null, null, null,
  'Looped Audio?', 'Is Ghost', null, 'Invulnerable',
);

export const TEMPLATE_FLAGS = flagList(
  'Use Traits', 'Use Stats', 'Use Factions', 'Use Spell List', 'Use AI Data', 'Use AI Packages', 'Use Model/Animation?',
  'Use Base Data', 'Use Inventory', 'Use Script', 'Use Def Pack List', 'Use Attack Data', 'Use Keywords',
);

/** The 19 chargen face morph sliders stored in NPC_ NAM9, in file order. */
export const FACE_MORPHS = [
  ['noseLongShort', 'Nose Long/Short'],
  ['noseUpDown', 'Nose Up/Down'],
  ['jawUpDown', 'Jaw Up/Down'],
  ['jawNarrowWide', 'Jaw Narrow/Wide'],
  ['jawForwardBack', 'Jaw Forward/Back'],
  ['cheeksUpDown', 'Cheeks Up/Down'],
  ['cheeksForwardBack', 'Cheeks Forward/Back'],
  ['eyesUpDown', 'Eyes Up/Down'],
  ['eyesInOut', 'Eyes In/Out'],
  ['browsUpDown', 'Brows Up/Down'],
  ['browsInOut', 'Brows In/Out'],
  ['browsForwardBack', 'Brows Forward/Back'],
  ['lipsUpDown', 'Lips Up/Down'],
  ['lipsInOut', 'Lips In/Out'],
  ['chinNarrowWide', 'Chin Narrow/Wide'],
  ['chinUpDown', 'Chin Up/Down'],
  ['chinUnderbiteOverbite', 'Chin Underbite/Overbite'],
  ['eyesForwardBack', 'Eyes Forward/Back'],
  ['vampireMorph', 'Vampire Morph'],
] as const;

export const NPC_: RecordDef = record(
  'NPC_',
  'Non-Player Character',
  [
    EDID,
    VMAD,
    OBND,
    sub(
      'ACBS',
      'config',
      'Configuration',
      struct([
        ['flags', 'Flags', flags('u32', ACBS_FLAGS)],
        ['magickaOffset', 'Magicka Offset', s16()],
        ['staminaOffset', 'Stamina Offset', s16()],
        ['level', 'Level (or Level Mult × 1000)', u16({ help: 'When "PC Level Mult" is set this is the multiplier × 1000.' })],
        ['calcMinLevel', 'Calc Min Level', u16()],
        ['calcMaxLevel', 'Calc Max Level', u16()],
        ['speedMultiplier', 'Speed Multiplier', u16({ default: 100 })],
        ['dispositionBase', 'Disposition Base (unused)', s16({ hidden: true })],
        ['templateFlags', 'Template Flags', flags('u16', TEMPLATE_FLAGS)],
        ['healthOffset', 'Health Offset', s16()],
        ['bleedoutOverride', 'Bleedout Override', u16()],
      ]),
      { required: true },
    ),
    rarray(
      'factions',
      'Factions',
      sub(
        'SNAM',
        'faction',
        'Faction',
        struct([
          ['faction', 'Faction', formid(['FACT'])],
          ['rank', 'Rank', s8()],
          ['unused', 'Unused', unused(3)],
        ]),
      ),
    ),
    sub('INAM', 'deathItem', 'Death Item', formid(['LVLI'])),
    sub('VTCK', 'voice', 'Voice Type', formid(['VTYP'])),
    sub('TPLT', 'template', 'Template', formid(['LVLN', 'NPC_'])),
    sub('RNAM', 'race', 'Race', formid(['RACE']), { required: true }),
    SPELLS,
    DEST,
    sub('WNAM', 'skin', 'Skin', formid(['ARMO'])),
    sub('ANAM', 'farAwayModel', 'Far Away Model', formid(['ARMO'])),
    sub('ATKR', 'attackRace', 'Attack Race', formid(['RACE'])),
    ATTACKS,
    sub('SPOR', 'spectatorOverride', 'Spectator Override Packages', formid(['FLST'])),
    sub('OCOR', 'observeDeadOverride', 'Observe Dead Body Override Packages', formid(['FLST'])),
    sub('GWOR', 'guardWarnOverride', 'Guard Warn Override Packages', formid(['FLST'])),
    sub('ECOR', 'combatOverride', 'Combat Override Packages', formid(['FLST'])),
    counted(
      'PRKZ',
      'u32',
      'perks',
      'Perks',
      rarray(
        'perks',
        'Perks',
        sub(
          'PRKR',
          'perk',
          'Perk',
          struct([
            ['perk', 'Perk', formid(['PERK'])],
            ['rank', 'Rank', u8()],
            ['unused', 'Unused', unused(3)],
          ]),
        ),
      ),
    ),
    ITEMS,
    sub(
      'AIDT',
      'ai',
      'AI Data',
      struct([
        ['aggression', 'Aggression', enumOf('u8', enumList('Unaggressive', 'Aggressive', 'Very Aggressive', 'Frenzied'))],
        ['confidence', 'Confidence', enumOf('u8', enumList('Cowardly', 'Cautious', 'Average', 'Brave', 'Foolhardy'))],
        ['energy', 'Energy Level', u8()],
        ['responsibility', 'Responsibility', enumOf('u8', enumList('Any crime', 'Violence against enemies', 'Property crime only', 'No crime'))],
        ['mood', 'Mood', enumOf('u8', enumList('Neutral', 'Angry', 'Fear', 'Happy', 'Sad', 'Surprised', 'Puzzled', 'Disgusted'))],
        ['assistance', 'Assistance', enumOf('u8', enumList('Helps Nobody', 'Helps Allies', 'Helps Friends and Allies'))],
        ['aggroRadiusBehavior', 'Aggro Radius Behavior', u8()],
        ['unknown', 'Unknown', unused(1)],
        ['warn', 'Warn', u32()],
        ['warnAttack', 'Warn/Attack', u32()],
        ['attack', 'Attack', u32()],
      ]),
    ),
    rarray('packages', 'AI Packages', sub('PKID', 'package', 'Package', formid(['PACK']))),
    KEYWORDS,
    sub('CNAM', 'class', 'Class', formid(['CLAS']), { required: true }),
    FULL,
    sub('SHRT', 'shortName', 'Short Name', lstring()),
    sub('DATA', 'marker', 'Marker', empty({ hidden: true }), { required: true }),
    sub(
      'DNAM',
      'skills',
      'Player Skills',
      struct([
        ['values', 'Skill Values', array(u8(), SKILLS.length)],
        ['offsets', 'Skill Offsets', array(u8(), SKILLS.length)],
        ['health', 'Health', u16()],
        ['magicka', 'Magicka', u16()],
        ['stamina', 'Stamina', u16()],
        ['unused', 'Unused', unused(2)],
        ['farAwayDistance', 'Far Away Model Distance', f32()],
        ['gearedUpWeapons', 'Geared Up Weapons', u8()],
        ['unused2', 'Unused', unused(3)],
      ]),
    ),
    rarray('headParts', 'Head Parts', sub('PNAM', 'headPart', 'Head Part', formid(['HDPT']))),
    sub('HCLF', 'hairColor', 'Hair Color', formid(['CLFM'])),
    sub('ZNAM', 'combatStyle', 'Combat Style', formid(['CSTY'])),
    sub('GNAM', 'giftFilter', 'Gift Filter', formid(['FLST'])),
    sub('NAM5', 'unknownNAM5', 'Unknown', bytes(undefined, { hidden: true }), { required: true }),
    sub('NAM6', 'height', 'Height', f32({ default: 1 }), { required: true }),
    sub('NAM7', 'weight', 'Weight', f32({ default: 50 }), { required: true }),
    sub('NAM8', 'soundLevel', 'Sound Level', enumOf('u32', SOUND_LEVEL), { required: true }),
    rarray(
      'soundTypes',
      'Sound Types',
      rstruct('soundType', 'Sound Type', [
        { ...sub('CSDT', 'type', 'Type', u32()), required: true },
        rarray(
          'sounds',
          'Sounds',
          rstruct('sound', 'Sound', [
            { ...sub('CSDI', 'sound', 'Sound', formid(['SNDR', 'SOUN'])), required: true },
            sub('CSDC', 'chance', 'Chance', u8()),
          ]),
        ),
      ]),
    ),
    sub('CSCR', 'inheritsSoundsFrom', 'Inherits Sounds From', formid(['NPC_'])),
    sub('DOFT', 'defaultOutfit', 'Default Outfit', formid(['OTFT'])),
    sub('SOFT', 'sleepOutfit', 'Sleeping Outfit', formid(['OTFT'])),
    sub('DPLT', 'defaultPackageList', 'Default Package List', formid(['FLST'])),
    sub('CRIF', 'crimeFaction', 'Crime Faction', formid(['FACT'])),
    sub('FTST', 'headTexture', 'Head Texture', formid(['TXST'])),
    sub('QNAM', 'textureLighting', 'Texture Lighting (Skin Tone)', FLOAT_COLOR),
    sub(
      'NAM9',
      'faceMorph',
      'Face Morph',
      struct(FACE_MORPHS.map(([k, l]) => [k, l, f32()] as const)),
    ),
    sub(
      'NAMA',
      'faceParts',
      'Face Parts',
      struct([
        ['nose', 'Nose', u32()],
        ['unknown', 'Unknown', s32()],
        ['eyes', 'Eyes', u32()],
        ['mouth', 'Mouth', u32()],
      ]),
    ),
    rarray(
      'tintLayers',
      'Tint Layers',
      rstruct('layer', 'Tint Layer', [
        { ...sub('TINI', 'index', 'Tint Index', u16()), required: true },
        sub(
          'TINC',
          'color',
          'Tint Color',
          struct(
            [
              ['r', 'Red', u8()],
              ['g', 'Green', u8()],
              ['b', 'Blue', u8()],
              ['a', 'Alpha', u8()],
            ],
            { hint: 'color' },
          ),
        ),
        sub('TINV', 'value', 'Interpolation Value (0-100)', u32({ default: 100, hint: 'percent' })),
        sub('TIAS', 'preset', 'Preset', s16()),
      ]),
    ),
  ],
  { category: 'Actors' },
);

export const HDPT: RecordDef = record(
  'HDPT',
  'Head Part',
  [
    EDID,
    FULL,
    MODEL,
    sub('DATA', 'flags', 'Flags', flags('u8', flagList('Playable', 'Male', 'Female', 'Is Extra Part', 'Use Solid Tint')), { required: true }),
    sub('PNAM', 'type', 'Type', enumOf('u32', enumList('Misc', 'Face', 'Eyes', 'Hair', 'Facial Hair', 'Scar', 'Eyebrows')), { required: true }),
    rarray('extraParts', 'Extra Parts', sub('HNAM', 'part', 'Part', formid(['HDPT']))),
    rarray(
      'parts',
      'Parts',
      rstruct('part', 'Part', [
        sub('NAM0', 'type', 'Part Type', enumOf('u32', enumList('Race Morph', 'Tri', 'Chargen Morph'))),
        sub('NAM1', 'file', 'File', zstring(), { required: true }),
      ]),
    ),
    sub('TNAM', 'textureSet', 'Texture Set', formid(['TXST'])),
    sub('CNAM', 'color', 'Color', formid(['CLFM'])),
    sub('RNAM', 'validRaces', 'Valid Races', formid(['FLST'])),
  ],
  { category: 'Character' },
);

export const HEAD_PART_TYPES = ['Misc', 'Face', 'Eyes', 'Hair', 'Facial Hair', 'Scar', 'Eyebrows'] as const;

export const VTYP: RecordDef = record(
  'VTYP',
  'Voice Type',
  [EDID, sub('DNAM', 'flags', 'Flags', flags('u8', flagList('Allow Default Dialog', 'Female')), { required: true })],
  { category: 'Character' },
);

export const CLFM: RecordDef = record(
  'CLFM',
  'Color',
  [
    EDID,
    FULL,
    sub(
      'CNAM',
      'color',
      'Color',
      struct(
        [
          ['r', 'Red', u8()],
          ['g', 'Green', u8()],
          ['b', 'Blue', u8()],
          ['a', 'Alpha', u8()],
        ],
        { hint: 'color' },
      ),
      { required: true },
    ),
    sub('FNAM', 'playable', 'Playable', u32(), { required: true }),
  ],
  { category: 'Miscellaneous' },
);

export const OTFT: RecordDef = record('OTFT', 'Outfit', [EDID, sub('INAM', 'items', 'Items', array(formid(['ARMO', 'LVLI'])))], {
  category: 'Items',
});

export const CLAS: RecordDef = record(
  'CLAS',
  'Class',
  [
    EDID,
    FULL,
    DESC,
    sub('ICON', 'icon', 'Icon', zstring()),
    sub(
      'DATA',
      'data',
      'Data',
      struct([
        ['unknown', 'Unknown', u32({ hidden: true })],
        ['teaches', 'Teaches (skill index, -1 none)', s8()],
        ['maxTrainingLevel', 'Max Training Level', u8()],
        ['skillWeights', 'Skill Weights', array(u8(), 18)],
        ['bleedoutDefault', 'Bleedout Default', f32()],
        ['voicePoints', 'Voice Points', u32()],
        ['healthWeight', 'Health Weight', u8()],
        ['magickaWeight', 'Magicka Weight', u8()],
        ['staminaWeight', 'Stamina Weight', u8()],
        ['flags', 'Flags', u8()],
      ]),
    ),
  ],
  { category: 'Character' },
);

export const FACT: RecordDef = record(
  'FACT',
  'Faction',
  [
    EDID,
    FULL,
    rarray(
      'relations',
      'Relations',
      sub(
        'XNAM',
        'relation',
        'Relation',
        struct([
          ['faction', 'Faction', formid(['FACT', 'RACE'])],
          ['modifier', 'Modifier', s32()],
          ['reaction', 'Group Combat Reaction', enumOf('u32', enumList('Neutral', 'Enemy', 'Ally', 'Friend'))],
        ]),
      ),
    ),
    sub('DATA', 'flags', 'Flags', flags('u32', FACTION_FLAGS)),
    sub('JAIL', 'exteriorJailMarker', 'Exterior Jail Marker', formid(['REFR'])),
    sub('WAIT', 'followerWaitMarker', 'Follower Wait Marker', formid(['REFR'])),
    sub('STOL', 'stolenGoodsContainer', 'Stolen Goods Container', formid(['REFR'])),
    sub('PLCN', 'playerInventoryContainer', 'Player Inventory Container', formid(['REFR'])),
    sub('CRGR', 'sharedCrimeFactions', 'Shared Crime Faction List', formid(['FLST'])),
    sub('JOUT', 'jailOutfit', 'Jail Outfit', formid(['OTFT'])),
    sub('CRVA', 'crimeValues', 'Crime Values', bytes(undefined, { hidden: true })),
    rarray(
      'ranks',
      'Ranks',
      rstruct('rank', 'Rank', [
        { ...sub('RNAM', 'number', 'Rank', u32()), required: true },
        sub('MNAM', 'maleTitle', 'Male Title', lstring()),
        sub('FNAM', 'femaleTitle', 'Female Title', lstring()),
      ]),
    ),
    sub('VEND', 'vendorList', 'Vendor Buy/Sell List', formid(['FLST'])),
    sub('VENC', 'merchantContainer', 'Merchant Container', formid(['REFR'])),
    sub(
      'VENV',
      'vendor',
      'Vendor Values',
      struct([
        ['startHour', 'Start Hour', u16()],
        ['endHour', 'End Hour', u16()],
        ['radius', 'Radius', u32()],
        ['buysStolen', 'Buys Stolen Items', u8()],
        ['notBuySell', 'Buy/Sell Everything Not In List', u8()],
        ['buysNonStolen', 'Buys Non-Stolen Items', u8()],
        ['unused', 'Unused', unused(1)],
      ]),
    ),
    sub('PLVD', 'vendorLocation', 'Vendor Location', bytes(undefined, { hidden: true })),
    counted('CITC', 'u32', 'conditions', 'Vendor Conditions', CONDITIONS),
  ],
  { category: 'Actors' },
);

/** Relationship between two characters (how they feel about each other, and the player). */
export const RELA: RecordDef = record(
  'RELA',
  'Relationship',
  [
    EDID,
    sub(
      'DATA',
      'data',
      'Data',
      struct([
        ['parent', 'Parent', formid(['NPC_'])],
        ['child', 'Child', formid(['NPC_'])],
        ['rank', 'Rank', enumOf('u16', enumList('Lover', 'Ally', 'Confidant', 'Friend', 'Acquaintance', 'Rival', 'Foe', 'Enemy', 'Archnemesis'))],
        ['unknown', 'Unknown', u8({ hidden: true })],
        ['flags', 'Flags', flags('u8', { 7: 'Secret' })],
        ['associationType', 'Association Type', formid(['ASTP'])],
      ]),
      { required: true },
    ),
  ],
  { category: 'Actors' },
);

export const LVLN: RecordDef = record(
  'LVLN',
  'Leveled NPC',
  [
    EDID,
    OBND,
    sub('LVLD', 'chanceNone', 'Chance None', u8(), { required: true }),
    sub('LVLF', 'flags', 'Flags', flags('u8', flagList('Calculate from all levels <= player level', 'Calculate for each item in count')), { required: true }),
    sub('LVLG', 'global', 'Global', formid(['GLOB'])),
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
                ['level', 'Level', u16()],
                ['unused', 'Unused', unused(2)],
                ['reference', 'Reference', formid(['NPC_', 'LVLN'])],
                ['count', 'Count', u16({ default: 1 })],
                ['unused2', 'Unused', unused(2)],
              ]),
            ),
            required: true,
          },
          sub('COED', 'extra', 'Extra Data', bytes()),
        ]),
      ),
    ),
    rstruct('model', 'Model', [
      { ...sub('MODL', 'file', 'Model File', zstring()), required: true },
      sub('MODT', 'info', 'Model Info', bytes(undefined, { hidden: true })),
    ]),
  ],
  { category: 'Actors' },
);

/**
 * RACE is huge; only the parts the NPC editor needs are typed, everything
 * else is preserved verbatim.
 */
export const RACE: RecordDef = record(
  'RACE',
  'Race',
  [
    EDID,
    FULL,
    DESC,
    SPELLS,
    sub('WNAM', 'skin', 'Skin', formid(['ARMO'])),
    sub('BODT', 'bodyTemplate', 'Body Template', bytes()),
    sub('BOD2', 'bodyTemplate2', 'Body Template', bytes()),
    KEYWORDS,
    sub('DATA', 'data', 'Data', bytes()),
  ],
  { category: 'Character' },
);
