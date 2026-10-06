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
const LOCATION_TYPES = enumOf('u32', {
  0: 'Near Reference', 1: 'In Cell', 2: 'Near Package Start Location', 3: 'Near Editor Location', 4: 'Object ID', 5: 'Object Type', 6: 'Near Linked Reference', 7: 'At Package Location', 8: 'Alias (Reference)', 9: 'Alias (Location)', 10: 'Unknown 10', 11: 'Unknown 11', 12: 'Near Self',
});
/** Package location: what the value means depends on the type (a reference, a cell, an alias index…). */
const PACKAGE_LOCATION = struct([
  ['type', 'Type', LOCATION_TYPES],
  ['value', 'Location', union((c) => ([0, 1, 4, 6].includes(Number((c.parent as any)?.type)) ? 0 : 1), [formid(['REFR', 'ACHR', 'DOOR', 'CELL', 'ACTI', 'STAT', 'FURN', 'NPC_', 'CONT', 'KYWD', 'FLST', 'IDLM']), u32()])],
  ['radius', 'Radius', s32()],
]);
const PACKAGE_TARGET = struct([
  ['type', 'Type', enumOf('u32', { 0: 'Specific Reference', 1: 'Object ID', 2: 'Object Type', 3: 'Linked Reference', 4: 'Ref Alias', 5: 'Unknown 5', 6: 'Self' })],
  ['value', 'Target', union((c) => ([0, 1, 3].includes(Number((c.parent as any)?.type)) ? 0 : 1), [formid(['REFR', 'ACHR', 'PLYR', 'NPC_', 'ACTI', 'FURN', 'CONT', 'FLST', 'KYWD', 'IDLM']), u32()])],
  ['count', 'Count / Distance', s32()],
]);
const PACKAGE_TOPIC = sub(
  'PDTO',
  'topic',
  'Topic',
  struct([
    ['type', 'Type', enumOf('u32', { 0: 'Topic Ref', 1: 'Topic Subtype' })],
    ['value', 'Topic', union((c) => (Number((c.parent as any)?.type) === 0 ? 0 : 1), [formid(['DIAL']), fstring(4)])],
  ]),
);
const PACKAGE_EVENT = (marker: string, key: string, label: string) =>
  rstruct(key, label, [
    sub(marker, 'marker', 'Marker', empty({ hidden: true }), { required: true }),
    sub('INAM', 'idle', 'Idle', formid(['IDLE'])),
    sub('SCHR', 'unused1', 'Unused', bytes(undefined, { hidden: true })),
    sub('SCTX', 'unused2', 'Unused', bytes(undefined, { hidden: true })),
    sub('QNAM', 'unused3', 'Unused', bytes(undefined, { hidden: true })),
    sub('TNAM', 'unused4', 'Unused', bytes(undefined, { hidden: true })),
    rarray('topics', 'Topics', PACKAGE_TOPIC),
  ]);
const PACKAGE_INPUTS = rarray(
  'inputs',
  'Data Inputs',
  rstruct('input', 'Data Input', [
    sub('UNAM', 'index', 'Index', s8(), { required: true }),
    sub('BNAM', 'name', 'Name', zstring()),
    sub('PNAM', 'flags', 'Flags', flags('u32', flagList('Public'))),
  ]),
);

/**
 * AI package. Packages made from a template (Sandbox, Sleep, Travel…) store
 * the template, their values for its data inputs, schedule and conditions;
 * the behaviour tree itself lives in the template.
 */
export const PACK: RecordDef = record(
  'PACK',
  'Package',
  [
    EDID,
    VMAD,
    sub(
      'PKDT',
      'data',
      'Package Data',
      struct([
        ['flags', 'General Flags', u32()],
        ['type', 'Type', enumOf('u8', { 18: 'Package', 19: 'Package Template' }, { default: 18 })],
        ['interruptOverride', 'Interrupt Override', enumOf('u8', { 0: 'None', 1: 'Spectator', 2: 'Observe Dead', 3: 'Guard Warn', 4: 'Combat' })],
        ['speed', 'Preferred Speed', enumOf('u8', { 0: 'Walk', 1: 'Jog', 2: 'Run', 3: 'Fast Walk' })],
        ['unknown', 'Unknown', bytes(1, { hidden: true })],
        ['interruptFlags', 'Interrupt Flags', u16()],
        ['unknown2', 'Unknown', bytes(2, { hidden: true })],
      ]),
      { required: true },
    ),
    sub(
      'PSDT',
      'schedule',
      'Schedule',
      struct([
        ['month', 'Month (-1 any)', s8()],
        ['dayOfWeek', 'Day of Week (-1 any)', s8()],
        ['date', 'Date', u8()],
        ['hour', 'Hour (-1 any)', s8()],
        ['minute', 'Minute', s8()],
        ['unused', 'Unused', bytes(3, { hidden: true })],
        ['duration', 'Duration (minutes)', s32()],
      ]),
      { required: true },
    ),
    CONDITIONS,
    rstruct('idles', 'Idle Animations', [
      sub('IDLF', 'flags', 'Flags', u8(), { required: true }),
      sub('IDLC', 'count', 'Count', bytes()),
      sub('IDLT', 'timer', 'Timer', f32()),
      sub('IDLA', 'animations', 'Animations', array(formid(['IDLE']))),
      sub('IDLB', 'unknown', 'Unknown', bytes(undefined, { hidden: true })),
    ]),
    sub('CNAM', 'combatStyle', 'Combat Style', formid(['CSTY'])),
    sub('QNAM', 'ownerQuest', 'Owner Quest', formid(['QUST'])),
    sub(
      'PKCU',
      'counter',
      'Template',
      struct([
        ['inputCount', 'Data Input Count', u32()],
        ['template', 'Package Template', formid(['PACK'])],
        ['version', 'Version', u32()],
      ]),
      { required: true },
    ),
    rstruct('packageData', 'Data Input Values', [
      rarray(
        'values',
        'Values',
        rstruct('value', 'Value', [
          sub('ANAM', 'type', 'Type', zstring(), { required: true }),
          sub('CNAM', 'value', 'Value', bytes()),
          sub('BNAM', 'unknown', 'Unknown', bytes(undefined, { hidden: true })),
          rarray('topics', 'Topics', PACKAGE_TOPIC),
          sub('PLDT', 'location', 'Location', PACKAGE_LOCATION),
          sub('PTDA', 'target', 'Target', PACKAGE_TARGET),
          sub('TPIC', 'unknown2', 'Unknown', bytes(undefined, { hidden: true })),
        ]),
      ),
      PACKAGE_INPUTS,
    ]),
    sub('XNAM', 'marker', 'Marker', bytes(), { required: true }),
    rarray(
      'tree',
      'Procedure Tree',
      rstruct('branch', 'Branch', [
        sub('ANAM', 'type', 'Branch Type', zstring(), { required: true }),
        CONDITIONS,
        sub('PRCB', 'root', 'Root', struct([['count', 'Branch Count', u32()], ['flags', 'Flags', u32()]])),
        sub('PNAM', 'procedure', 'Procedure Type', zstring()),
        sub('FNAM', 'flags', 'Flags', u32()),
        rarray('inputIndexes', 'Data Input Indexes', sub('PKC2', 'index', 'Index', u8())),
        rarray('flagsOverride', 'Flags Override', sub('PFO2', 'data', 'Data', bytes())),
        rarray('unknown', 'Unknown', sub('PFOR', 'data', 'Data', bytes(undefined, { hidden: true }))),
      ]),
    ),
    { ...PACKAGE_INPUTS, key: 'treeInputs', label: 'Data Inputs (template)' },
    PACKAGE_EVENT('POBA', 'onBegin', 'On Begin'),
    PACKAGE_EVENT('POEA', 'onEnd', 'On End'),
    PACKAGE_EVENT('POCA', 'onChange', 'On Change'),
  ],
  { category: 'Character' },
);

/** Scene: actors (quest aliases), phases, and actions (a line of dialogue, a package, a timer) that run in phases. */
export const SCEN: RecordDef = record(
  'SCEN',
  'Scene',
  [
    EDID,
    VMAD,
    sub('FNAM', 'flags', 'Flags', flags('u32', flagList('Begin on Quest Start', 'Stop Quest on End', 'Show All Text', 'Repeat Conditions While True', 'Interruptible'))),
    rarray(
      'phases',
      'Phases',
      rstruct('phase', 'Phase', [
        sub('HNAM', 'start', 'Phase Start', empty({ hidden: true }), { required: true }),
        sub('NAM0', 'name', 'Name', zstring()),
        { ...CONDITIONS, key: 'startConditions', label: 'Start Conditions' },
        sub('NEXT', 'next1', 'Marker', empty({ hidden: true })),
        { ...CONDITIONS, key: 'completionConditions', label: 'Completion Conditions' },
        sub('NEXT', 'next2', 'Marker', empty({ hidden: true })),
        sub('WNAM', 'editorWidth', 'Editor Width', u32({ default: 200 })),
        sub('HNAM', 'end', 'Phase End', empty({ hidden: true })),
      ]),
    ),
    rarray(
      'actors',
      'Actors',
      rstruct('actor', 'Actor', [
        sub('ALID', 'alias', 'Actor (Alias ID)', u32(), { required: true }),
        sub('LNAM', 'flags', 'Flags', flags('u32', flagList('No Player Activation', 'Optional'))),
        sub('DNAM', 'behaviour', 'Behaviour Flags', flags('u32', flagList('Death Pause', 'Death End', 'Combat Pause', 'Combat End', 'Dialogue Pause', 'Dialogue End', 'OBS_COM Pause', 'OBS_COM End'))),
      ]),
    ),
    rarray(
      'actions',
      'Actions',
      rstruct('action', 'Action', [
        sub('ANAM', 'type', 'Type', enumOf('u16', { 0: 'Dialogue', 1: 'Package', 2: 'Timer' }), { required: true }),
        sub('NAM0', 'name', 'Name', zstring()),
        sub('ALID', 'actor', 'Actor (Alias ID)', s32()),
        sub('LNAM', 'unknown', 'Unknown', bytes(undefined, { hidden: true })),
        sub('INAM', 'index', 'Index', u32()),
        sub('FNAM', 'flags', 'Flags', u32()),
        sub('SNAM', 'startPhase', 'Start Phase', u32()),
        sub('ENAM', 'endPhase', 'End Phase', u32()),
        sub('SNAM', 'timer', 'Timer (seconds)', f32()),
        rarray('packages', 'Packages', sub('PNAM', 'package', 'Package', formid(['PACK']))),
        sub('DATA', 'topic', 'Topic', formid(['DIAL'])),
        sub('HTID', 'headtrack', 'Headtrack Actor ID', s32()),
        sub('DMAX', 'loopMax', 'Looping Max', f32()),
        sub('DMIN', 'loopMin', 'Looping Min', f32()),
        sub('DEMO', 'emotion', 'Emotion Type', u32()),
        sub('DEVA', 'emotionValue', 'Emotion Value', u32()),
        sub('ANAM', 'end', 'End Marker', empty({ hidden: true })),
      ]),
    ),
    sub('NEXT', 'next', 'Marker', empty({ hidden: true })),
    sub('PNAM', 'quest', 'Quest', formid(['QUST'])),
    sub('INAM', 'lastActionIndex', 'Last Action Index', u32()),
    sub('VNAM', 'unknown', 'Unknown', bytes(undefined, { hidden: true })),
    CONDITIONS,
  ],
  { category: 'Quests' },
);

export const LCTN: RecordDef = record(
  'LCTN',
  'Location',
  [EDID, FULL],
  { category: 'World Data' },
);

export { array, KEYWORDS };

export const IDLE: RecordDef = record(
  'IDLE',
  'Idle Animation',
  [
    EDID,
    CONDITIONS,
    sub('DNAM', 'behaviorGraph', 'Behavior Graph', zstring()),
    sub('ENAM', 'animationEvent', 'Animation Event', zstring()),
    sub('ANAM', 'related', 'Related Idles (parent, previous)', array(formid(['IDLE', 'AACT']))),
    sub(
      'DATA',
      'data',
      'Data',
      struct([
        ['loopMin', 'Looping Min', u8()],
        ['loopMax', 'Looping Max', u8()],
        ['flags', 'Flags', flags('u8', flagList('Parent', 'Sequence', 'No Attacking', 'Blocking'))],
        ['animationGroupSection', 'Animation Group Section', u8()],
        ['replayDelay', 'Replay Delay', u16()],
      ]),
    ),
  ],
  { category: 'Miscellaneous' },
);
