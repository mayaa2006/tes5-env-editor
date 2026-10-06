/** Quest, dialogue and story records. */
import { conditions } from '../conditions';
import {
  array,
  bytes,
  empty,
  enumList,
  enumOf,
  f32,
  flagList,
  flags,
  formid,
  fstring,
  lstring,
  rarray,
  record,
  rstruct,
  runion,
  s16,
  s32,
  struct,
  sub,
  u16,
  u32,
  u8,
  union,
  unused,
  zstring,
} from '../dsl';
import type { RecordDef } from '../types';
import { CONDITIONS, DESC, EDID, FULL, ITEMS, KEYWORDS, VMAD } from './common';

export const QUEST_FLAGS = flagList(
  'Start Game Enabled', 'Completed', 'Add Idle Topic to Hello', 'Allow Repeated Stages', 'Starts Enabled', 'Displayed In HUD',
  'Failed', 'Stage Wait', 'Run Once', 'Exclude from Dialogue Export', 'Warn on Alias Fill Failure', 'Active',
  'Repeats Conditions', 'Keep Instance', 'Want Dormant', 'Has Dialogue Data',
);

export const QuestFlag = {
  StartGameEnabled: 0x0001,
  AllowRepeatedStages: 0x0008,
  RunOnce: 0x0100,
  ExcludeFromDialogueExport: 0x0200,
  WarnOnAliasFillFailure: 0x0400,
} as const;

export const QUEST_TYPES = enumList(
  'None', 'Main Quest', 'Mages Guild', 'Thieves Guild', 'Dark Brotherhood', 'Companion Quests', 'Miscellaneous', 'Daedric',
  'Side Quest', 'Civil War', 'Vampire (Dawnguard)', 'Dragonborn',
);

export const REF_ALIAS_FLAGS = flagList(
  'Reserves Reference', 'Optional', 'Quest Object', 'Allow Reuse in Quest', 'Allow Dead', 'Matching Ref - In Loaded Area',
  'Essential', 'Allow Disabled', 'Stores Text', 'Allow Reserved', 'Protected', 'Forced By Aliases', 'Allow Destroyed',
  'Matching Ref - Closest', 'Uses Stored Text', 'Initially Disabled', null, 'Clear Names When Removed',
);

export const LOC_ALIAS_FLAGS: Record<number, string> = {
  0: 'Reserves Location',
  1: 'Optional',
  3: 'Allow Reuse in Quest',
  8: 'Stores Text',
  9: 'Allow Reserved',
  11: 'Forced by Aliases',
  16: 'Allow Cleared',
};

const PLACED = ['ACHR', 'PARW', 'PBAR', 'PBEA', 'PCON', 'PFLA', 'PGRE', 'PHZD', 'PLYR', 'PMIS', 'REFR'];

const refAlias = rstruct('ref', 'Reference Alias', [
  { ...sub('ALST', 'id', 'Alias ID', u32()), required: true },
  sub('ALID', 'name', 'Alias Name', zstring(), { required: true }),
  sub('FNAM', 'flags', 'Flags', flags('u32', REF_ALIAS_FLAGS), { required: true }),
  sub('ALFI', 'forceIntoAlias', 'Force Into Alias When Filled', s32()),
  runion('fill', 'Fill Type', [
    rstruct('specific', 'Specific Reference', [sub('ALFR', 'reference', 'Reference', formid(PLACED))]),
    rstruct('uniqueActor', 'Unique Actor', [sub('ALUA', 'actor', 'Actor', formid(['NPC_']))]),
    rstruct('locationAlias', 'Location Alias Reference', [
      sub('ALFA', 'alias', 'Location Alias', s32()),
      sub('ALRT', 'refType', 'Ref Type', formid(['LCRT'])),
    ]),
    rstruct('external', 'External Alias Reference', [
      sub('ALEQ', 'quest', 'Quest', formid(['QUST'])),
      sub('ALEA', 'alias', 'Alias', s32()),
    ]),
    rstruct('create', 'Create Reference to Object', [
      sub('ALCO', 'object', 'Object', formid()),
      sub(
        'ALCA',
        'at',
        'Create At/In Alias',
        struct([
          ['alias', 'Alias', s16()],
          ['create', 'Create (0 = At, 0x8000 = In)', u16()],
        ]),
      ),
      sub('ALCL', 'level', 'Level', enumOf('u32', enumList('Easy', 'Medium', 'Hard', 'Very Hard', 'None'))),
    ]),
    rstruct('findMatching', 'Find Matching Reference', [
      runion('match', 'Match Type', [
        rstruct('nearAlias', 'Near Alias', [
          sub('ALNA', 'alias', 'Alias', s32()),
          sub('ALNT', 'nearType', 'Near Type', enumOf('u32', enumList('Linked Ref Child'))),
        ]),
        rstruct('fromEvent', 'From Event', [
          sub('ALFE', 'event', 'Event', fstring(4)),
          sub('ALFD', 'data', 'Data', fstring(4)),
        ]),
      ]),
    ]),
  ]),
  conditions('conditions', 'Match Conditions'),
  KEYWORDS,
  ITEMS,
  sub('SPOR', 'spectatorOverride', 'Spectator Override Packages', formid(['FLST'])),
  sub('OCOR', 'observeDeadOverride', 'Observe Dead Body Override Packages', formid(['FLST'])),
  sub('GWOR', 'guardWarnOverride', 'Guard Warn Override Packages', formid(['FLST'])),
  sub('ECOR', 'combatOverride', 'Combat Override Packages', formid(['FLST'])),
  sub('ALDN', 'displayName', 'Display Name', formid(['MESG'])),
  rarray('spells', 'Alias Spells', sub('ALSP', 'spell', 'Spell', formid(['SPEL']))),
  rarray('factions', 'Alias Factions', sub('ALFC', 'faction', 'Faction', formid(['FACT']))),
  rarray('packages', 'Alias Packages', sub('ALPC', 'package', 'Package', formid(['PACK']))),
  sub('VTCK', 'voiceTypes', 'Voice Types', formid(['FLST', 'NPC_'])),
  sub('ALED', 'end', 'Alias End', empty({ hidden: true }), { required: true }),
]);

const locAlias = rstruct('loc', 'Location Alias', [
  { ...sub('ALLS', 'id', 'Alias ID', u32()), required: true },
  sub('ALID', 'name', 'Alias Name', zstring(), { required: true }),
  sub('FNAM', 'flags', 'Flags', flags('u32', LOC_ALIAS_FLAGS), { required: true }),
  sub('ALFI', 'forceIntoAlias', 'Force Into Alias When Filled', s32()),
  runion('fill', 'Fill Type', [
    rstruct('specific', 'Specific Location', [sub('ALFL', 'location', 'Location', formid(['LCTN']))]),
    rstruct('refAliasLocation', 'Reference Alias Location', [
      sub('ALFA', 'alias', 'Reference Alias', s32()),
      sub('KNAM', 'keyword', 'Keyword', formid(['KYWD'])),
    ]),
    rstruct('external', 'External Alias Location', [
      sub('ALEQ', 'quest', 'Quest', formid(['QUST'])),
      sub('ALEA', 'alias', 'Alias', s32()),
    ]),
    rstruct('fromEvent', 'Find Matching Location', [
      sub('ALFE', 'event', 'From Event', fstring(4)),
      sub('ALFD', 'data', 'Event Data', fstring(4)),
    ]),
  ]),
  conditions('conditions', 'Match Conditions'),
  sub('ALDN', 'displayName', 'Display Name', formid(['MESG'])),
  sub('ALED', 'end', 'Alias End', empty({ hidden: true }), { required: true }),
]);

export const QUST: RecordDef = record(
  'QUST',
  'Quest',
  [
    EDID,
    VMAD,
    FULL,
    sub(
      'DNAM',
      'general',
      'General',
      struct([
        ['flags', 'Flags', flags('u16', QUEST_FLAGS)],
        ['priority', 'Priority', u8()],
        ['formVersion', 'Form Version', u8({ hidden: true })],
        ['unknown', 'Unknown', bytes(4, { hidden: true })],
        ['type', 'Type', enumOf('u32', QUEST_TYPES)],
      ]),
      { required: true },
    ),
    sub('ENAM', 'event', 'Event', fstring(4, { help: 'Story Manager event (e.g. "SCPT" for Script Event); empty for none.' })),
    rarray('textDisplayGlobals', 'Text Display Globals', sub('QTGL', 'global', 'Global', formid(['GLOB']))),
    sub('FLTR', 'objectWindowFilter', 'Object Window Filter', zstring()),
    conditions('dialogueConditions', 'Quest Dialogue Conditions'),
    sub('NEXT', 'marker', 'Marker', empty({ hidden: true }), { required: true }),
    conditions('storyManagerConditions', 'Story Manager Conditions'),
    rarray(
      'stages',
      'Stages',
      rstruct('stage', 'Stage', [
        {
          ...sub(
            'INDX',
            'index',
            'Stage Index',
            struct([
              ['index', 'Index', u16()],
              ['flags', 'Flags', flags('u8', flagList(null, 'Start Up Stage', 'Shut Down Stage', 'Keep Instance Data From Here On'))],
              ['unknown', 'Unknown', u8({ hidden: true })],
            ]),
          ),
          required: true,
        },
        rarray(
          'logEntries',
          'Log Entries',
          rstruct('entry', 'Log Entry', [
            { ...sub('QSDT', 'flags', 'Stage Flags', flags('u8', flagList('Complete Quest', 'Fail Quest'))), required: true },
            CONDITIONS,
            sub('CNAM', 'text', 'Log Entry', lstring()),
            sub('NAM0', 'nextQuest', 'Next Quest', formid(['QUST'])),
            sub('SCHR', 'unusedSCHR', 'Unused', bytes(undefined, { hidden: true })),
            sub('SCTX', 'unusedSCTX', 'Unused', bytes(undefined, { hidden: true })),
            sub('QNAM', 'unusedQNAM', 'Unused', bytes(undefined, { hidden: true })),
          ]),
        ),
      ]),
    ),
    rarray(
      'objectives',
      'Objectives',
      rstruct('objective', 'Objective', [
        { ...sub('QOBJ', 'index', 'Objective Index', u16()), required: true },
        sub('FNAM', 'oredWithPrevious', 'ORed With Previous', u32()),
        sub('NNAM', 'text', 'Display Text', lstring(), { required: true }),
        rarray(
          'targets',
          'Targets',
          rstruct('target', 'Target', [
            {
              ...sub(
                'QSTA',
                'target',
                'Target',
                struct([
                  ['alias', 'Alias', s32()],
                  ['ignoresLocks', 'Compass Marker Ignores Locks', u8()],
                  ['unused', 'Unused', unused(3)],
                ]),
              ),
              required: true,
            },
            CONDITIONS,
          ]),
        ),
      ]),
    ),
    sub('ANAM', 'nextAliasId', 'Next Alias ID', u32(), { required: true }),
    rarray('aliases', 'Aliases', runion('alias', 'Alias', [refAlias, locAlias])),
    sub('NNAM', 'description', 'Description', lstring()),
    rarray(
      'targets',
      'Targets',
      rstruct('target', 'Target', [
        {
          ...sub(
            'QSTA',
            'target',
            'Target',
            struct([
              ['target', 'Target', formid(PLACED)],
              ['ignoresLocks', 'Compass Marker Ignores Locks', u8()],
              ['unknown', 'Unknown', bytes(3, { hidden: true })],
            ]),
          ),
          required: true,
        },
        CONDITIONS,
      ]),
    ),
  ],
  { category: 'Quests' },
);

export const DIALOGUE_CATEGORIES = enumList('Player', 'Favor', 'Scene', 'Combat', 'Favors', 'Detection', 'Service', 'Miscellaneous');

export const DIAL: RecordDef = record(
  'DIAL',
  'Dialog Topic',
  [
    EDID,
    FULL,
    sub('PNAM', 'priority', 'Priority', f32({ default: 50 }), { required: true }),
    sub('BNAM', 'branch', 'Branch', formid(['DLBR'])),
    sub('QNAM', 'quest', 'Quest', formid(['QUST'])),
    sub(
      'DATA',
      'data',
      'Data',
      struct([
        ['doAllBeforeRepeating', 'Do All Before Repeating', u8()],
        ['category', 'Category', enumOf('u8', DIALOGUE_CATEGORIES)],
        ['subtype', 'Subtype', u16()],
      ]),
    ),
    sub('SNAM', 'subtypeName', 'Subtype Name', fstring(4, { help: 'Four-letter subtype code, e.g. CUST for custom topics.' }), { required: true }),
    sub('TIFC', 'infoCount', 'Info Count', u32({ help: 'Kept up to date automatically when saving.' })),
  ],
  { category: 'Quests' },
);

export const INFO_RESPONSE_FLAGS = flagList(
  'Goodbye', 'Random', 'Say Once', 'Requires Player Activation', 'Info Refusal', 'Random End', 'Invisible Continue',
  'Walk Away', 'Walk Away Invisible In Menu', 'Force Subtitle', 'Can Move While Greeting', 'No LIP File',
  'Requires Post-Processing', 'Audio Output Override', 'Spends Favor Points',
);

export const EMOTIONS = enumList('Neutral', 'Anger', 'Disgust', 'Fear', 'Sad', 'Happy', 'Surprise', 'Puzzled');

export const INFO: RecordDef = record(
  'INFO',
  'Dialog Response',
  [
    EDID,
    VMAD,
    sub('DATA', 'oldData', 'Data (old)', bytes(undefined, { hidden: true })),
    sub(
      'ENAM',
      'data',
      'Data',
      struct([
        ['flags', 'Response Flags', flags('u16', INFO_RESPONSE_FLAGS)],
        ['resetHours', 'Reset Hours (× 2730.625)', u16({ help: 'Stored as hours × 2730.625.' })],
      ]),
    ),
    sub('TPIC', 'previousTopic', 'Previous Topic', formid(['DIAL'])),
    sub('PNAM', 'previousInfo', 'Previous INFO', formid(['INFO']), { help: 'Ordering within the topic. Maintained automatically.' }),
    sub('CNAM', 'favorLevel', 'Favor Level', enumOf('u8', enumList('None', 'Small', 'Medium', 'Large')), { required: true }),
    rarray('linkTo', 'Link To', sub('TCLT', 'topic', 'Topic', formid(['DIAL']))),
    sub('DNAM', 'sharedInfo', 'Shared Info', formid(['INFO'])),
    rarray(
      'responses',
      'Responses',
      rstruct('response', 'Response', [
        {
          ...sub(
            'TRDT',
            'data',
            'Response Data',
            struct([
              ['emotion', 'Emotion', enumOf('u32', EMOTIONS)],
              ['emotionValue', 'Emotion Value', u32({ default: 50 })],
              ['unused', 'Unused', unused(4)],
              ['responseNumber', 'Response Number', u8({ default: 1 })],
              ['unused2', 'Unused', unused(3)],
              ['sound', 'Sound', formid(['SNDR'])],
              ['useEmotionAnimation', 'Use Emotion Animation', u8()],
              ['unused3', 'Unused', unused(3)],
            ]),
          ),
          required: true,
        },
        sub('NAM1', 'text', 'Response Text', lstring()),
        sub('NAM2', 'scriptNotes', 'Script Notes (voice direction)', zstring()),
        sub('NAM3', 'edits', 'Edits', zstring()),
        sub('SNAM', 'speakerIdle', 'Speaker Idle', formid(['IDLE'])),
        sub('LNAM', 'listenerIdle', 'Listener Idle', formid(['IDLE'])),
      ]),
    ),
    CONDITIONS,
    rarray(
      'unusedScript',
      'Unused',
      rstruct('unused', 'Unused', [
        sub('SCHR', 'schr', 'Unused', bytes(undefined, { hidden: true })),
        sub('QNAM', 'qnam', 'Unused', bytes(undefined, { hidden: true })),
        { ...sub('NEXT', 'next', 'Marker', empty({ hidden: true })), required: true },
      ]),
    ),
    sub('RNAM', 'prompt', 'Prompt', lstring()),
    sub('ANAM', 'speaker', 'Speaker', formid(['NPC_'])),
    sub('TWAT', 'walkAwayTopic', 'Walk Away Topic', formid(['DIAL'])),
    sub('ONAM', 'audioOutputOverride', 'Audio Output Override', formid(['SOPM'])),
  ],
  { category: 'Quests' },
);

export const DLBR: RecordDef = record(
  'DLBR',
  'Dialog Branch',
  [
    EDID,
    sub('QNAM', 'quest', 'Quest', formid(['QUST']), { required: true }),
    sub('TNAM', 'category', 'Category', enumOf('u32', enumList('Player', 'Favor'))),
    sub('DNAM', 'flags', 'Flags', flags('u32', flagList('Top-Level', 'Blocking', 'Exclusive'))),
    sub('SNAM', 'startingTopic', 'Starting Topic', formid(['DIAL']), { required: true }),
  ],
  { category: 'Quests' },
);

export const DLVW: RecordDef = record(
  'DLVW',
  'Dialog View',
  [
    EDID,
    sub('QNAM', 'quest', 'Quest', formid(['QUST']), { required: true }),
    rarray('branches', 'Branches', sub('BNAM', 'branch', 'Branch', formid(['DLBR']))),
    rarray('topics', 'Topics', sub('TNAM', 'topic', 'Topic', formid(['DIAL']))),
    sub('ENAM', 'topicType', 'Topic Type', enumOf('u32', DIALOGUE_CATEGORIES), { required: true }),
    sub('DNAM', 'showAllText', 'Show All Text', u8(), { required: true }),
  ],
  { category: 'Quests' },
);

export const MESG: RecordDef = record(
  'MESG',
  'Message',
  [
    EDID,
    { ...DESC, required: true },
    FULL,
    sub('INAM', 'icon', 'Icon (unused)', formid([], { hidden: true }), { required: true }),
    sub('QNAM', 'ownerQuest', 'Owner Quest', formid(['QUST'])),
    sub('DNAM', 'flags', 'Flags', flags('u32', flagList('Message Box', 'Auto Display')), { required: true }),
    sub('TNAM', 'displayTime', 'Display Time', u32({ default: 2 })),
    rarray(
      'buttons',
      'Menu Buttons',
      rstruct('button', 'Menu Button', [{ ...sub('ITXT', 'text', 'Button Text', lstring()), required: true }, CONDITIONS]),
    ),
  ],
  { category: 'Miscellaneous' },
);

export const GLOB: RecordDef = record(
  'GLOB',
  'Global',
  [
    EDID,
    sub('FNAM', 'type', 'Type', enumOf('u8', { 115: 'Short', 108: 'Long', 102: 'Float' }, { default: 102 }), { required: true }),
    sub('FLTV', 'value', 'Value', f32(), { required: true }),
  ],
  { flags: { 6: 'Constant' }, category: 'Miscellaneous' },
);

export const KYWD: RecordDef = record(
  'KYWD',
  'Keyword',
  [
    EDID,
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
    ),
  ],
  { category: 'Miscellaneous' },
);

export const FLST: RecordDef = record('FLST', 'FormID List', [EDID, rarray('forms', 'Forms', sub('LNAM', 'form', 'Form', formid()))], {
  category: 'Miscellaneous',
});

export const GMST: RecordDef = record(
  'GMST',
  'Game Setting',
  [
    EDID,
    sub(
      'DATA',
      'value',
      'Value',
      union(
        (c) => {
          const id = String(c.record.editorId ?? '');
          switch (id.charAt(0)) {
            case 's':
              return 0;
            case 'i':
              return 1;
            case 'f':
              return 2;
            case 'b':
              return 3;
            default:
              return 4;
          }
        },
        [lstring(), s32(), f32(), u32(), bytes()],
      ),
      { required: true },
    ),
  ],
  { category: 'Gameplay' },
);

/** Packages are edited through the package wizard; their procedure data is preserved as-is. */
export const PACK: RecordDef = record(
  'PACK',
  'Package',
  [EDID, VMAD, sub('PKDT', 'data', 'Package Data', bytes()), sub('PSDT', 'schedule', 'Schedule', bytes()), CONDITIONS],
  { category: 'Character' },
);

export const SCEN: RecordDef = record('SCEN', 'Scene', [EDID, VMAD, sub('FNAM', 'flags', 'Flags', u32())], { category: 'Quests' });

export const LCTN: RecordDef = record(
  'LCTN',
  'Location',
  [EDID, FULL],
  { category: 'World Data' },
);

export { array, KEYWORDS };
