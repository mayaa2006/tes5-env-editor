/** World data and placeable objects: cells, worldspaces, references, navmeshes, statics... */
import {
  array,
  bytes,
  custom,
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
  struct,
  sub,
  u16,
  u32,
  u8,
  union,
  unused,
  vec3,
  zstring,
} from '../dsl';
import { nvnmCodec } from '../nvnm';
import type { RecordDef } from '../types';
import {
  BYTE_COLOR,
  DATA_POSROT,
  DEST,
  EDID,
  FULL,
  ITEMS,
  KEYWORDS,
  MODEL,
  OBND,
  OWNERSHIP,
  POS_ROT,
  VMAD,
  XESP,
  XLKR,
  XSCL,
} from './common';

export const CELL_FLAGS = flagList(
  'Is Interior Cell', 'Has Water', "Can't Travel From Here", 'No LOD Water', null, 'Public Area', 'Hand Changed', 'Show Sky',
  'Use Sky Lighting',
);

const LIGHTING = struct([
  ['ambient', 'Ambient Color', BYTE_COLOR],
  ['directional', 'Directional Color', BYTE_COLOR],
  ['fogNearColor', 'Fog Color Near', BYTE_COLOR],
  ['fogNear', 'Fog Near', f32()],
  ['fogFar', 'Fog Far', f32()],
  ['directionalRotationXY', 'Directional Rotation XY', s32()],
  ['directionalRotationZ', 'Directional Rotation Z', s32()],
  ['directionalFade', 'Directional Fade', f32()],
  ['fogClipDistance', 'Fog Clip Distance', f32()],
  ['fogPower', 'Fog Power', f32()],
  ['ambientColors', 'Ambient Colors (DALC)', bytes(32)],
  ['fogFarColor', 'Fog Color Far', BYTE_COLOR],
  ['fogMax', 'Fog Max', f32()],
  ['lightFadeBegin', 'Light Fade Begin', f32()],
  ['lightFadeEnd', 'Light Fade End', f32()],
  [
    'inherits',
    'Inherits From Template',
    flags(
      'u32',
      flagList(
        'Ambient Color', 'Directional Color', 'Fog Color', 'Fog Near', 'Fog Far', 'Directional Rotation', 'Directional Fade',
        'Clip Distance', 'Fog Power', 'Fog Max', 'Light Fade Distances',
      ),
    ),
  ],
]);

export const CELL: RecordDef = record(
  'CELL',
  'Cell',
  [
    EDID,
    FULL,
    sub(
      'DATA',
      'flags',
      'Flags',
      // Most cells store 2 bytes of flags; some older ones only 1. Remember which, so saving keeps the size.
      union(
        (c) => {
          if (c.remaining !== undefined) {
            if (c.remaining < 2) c.record.__flagsU8 = true;
            return c.remaining < 2 ? 0 : 1;
          }
          return c.record.__flagsU8 ? 0 : 1;
        },
        [flags('u8', CELL_FLAGS), flags('u16', CELL_FLAGS)],
      ),
      { required: true },
    ),
    sub(
      'XCLC',
      'grid',
      'Grid',
      struct([
        ['x', 'X', s32()],
        ['y', 'Y', s32()],
        ['forceHideLand', 'Force Hide Land (quads)', u32()],
      ]),
    ),
    sub('XCLL', 'lighting', 'Lighting', LIGHTING),
    sub('TVDT', 'occlusion', 'Occlusion Data', bytes(undefined, { hidden: true })),
    sub('MHDT', 'maxHeight', 'Max Height Data', bytes(undefined, { hidden: true })),
    sub('LTMP', 'lightingTemplate', 'Lighting Template', formid(['LGTM'])),
    sub('LNAM', 'unknownLNAM', 'Unknown', bytes(undefined, { hidden: true })),
    sub('XCLW', 'waterHeight', 'Water Height', f32()),
    sub('XNAM', 'waterNoiseTexture', 'Water Noise Texture', zstring()),
    sub('XCLR', 'regions', 'Regions', array(formid(['REGN']))),
    sub('XLCN', 'location', 'Location', formid(['LCTN'])),
    sub('XWCN', 'waterCurrentCount', 'Water Velocity Count', u32({ hidden: true })),
    sub('XWCS', 'waterCurrentCountOld', 'Water Velocity Count (old)', u32({ hidden: true })),
    sub('XWCU', 'waterCurrents', 'Water Velocities', bytes(undefined, { hidden: true })),
    sub('XCWT', 'water', 'Water', formid(['WATR'])),
    OWNERSHIP,
    sub('XILL', 'lockList', 'Lock List', formid(['FLST', 'NPC_'])),
    sub('XWEM', 'waterEnvironmentMap', 'Water Environment Map', zstring()),
    sub('XCCM', 'skyFromRegion', 'Sky/Weather from Region', formid(['REGN'])),
    sub('XCAS', 'acousticSpace', 'Acoustic Space', formid(['ASPC'])),
    sub('XEZN', 'encounterZone', 'Encounter Zone', formid(['ECZN'])),
    sub('XCMO', 'music', 'Music Type', formid(['MUSC'])),
    sub('XCIM', 'imageSpace', 'Image Space', formid(['IMGS'])),
  ],
  { unordered: true, category: 'World Data', flags: { 10: 'Persistent', 14: 'Partial Form', 17: 'Off Limits', 18: 'Compressed', 19: "Can't Wait" } },
);

export const WRLD: RecordDef = record(
  'WRLD',
  'Worldspace',
  [
    EDID,
    rarray('largeRefs', 'Large References', sub('RNAM', 'grid', 'Grid', bytes(undefined, { hidden: true }))),
    sub('MHDT', 'maxHeight', 'Max Height Data', bytes(undefined, { hidden: true })),
    FULL,
    sub('WCTR', 'fixedCenter', 'Fixed Dimensions Center Cell', struct([['x', 'X', s16()], ['y', 'Y', s16()]])),
    sub('LTMP', 'interiorLighting', 'Interior Lighting', formid(['LGTM'])),
    sub('XEZN', 'encounterZone', 'Encounter Zone', formid(['ECZN'])),
    sub('XLCN', 'location', 'Location', formid(['LCTN'])),
    rstruct('parent', 'Parent Worldspace', [
      sub('WNAM', 'world', 'World', formid(['WRLD'])),
      sub('PNAM', 'flags', 'Use Flags', flags('u16', flagList('Use Land Data', 'Use LOD Data', 'Use Map Data', 'Use Water Data', 'Use Climate Data', null, 'Use Sky Cell'))),
    ]),
    sub('CNAM', 'climate', 'Climate', formid(['CLMT'])),
    sub('NAM2', 'water', 'Water', formid(['WATR'])),
    sub('NAM3', 'lodWater', 'LOD Water Type', formid(['WATR'])),
    sub('NAM4', 'lodWaterHeight', 'LOD Water Height', f32()),
    sub('DNAM', 'landData', 'Land Data', struct([['defaultLandHeight', 'Default Land Height', f32()], ['defaultWaterHeight', 'Default Water Height', f32()]])),
    sub('ICON', 'mapImage', 'Map Image', zstring()),
    rstruct('cloudModel', 'Cloud Model', [
      { ...sub('MODL', 'file', 'Model File', zstring()), required: true },
      sub('MODT', 'info', 'Model Info', bytes(undefined, { hidden: true })),
      sub('MODS', 'alternateTextures', 'Alternate Textures', bytes(undefined, { hidden: true })),
    ]),
    sub('MNAM', 'mapData', 'Map Data', bytes()),
    sub('ONAM', 'mapOffset', 'Map Offset', bytes()),
    sub('NAMA', 'distantLodMultiplier', 'Distant LOD Multiplier', f32({ default: 1 })),
    sub('DATA', 'flags', 'Flags', flags('u8', flagList('Small World', "Can't Fast Travel", null, 'No LOD Water', 'No Landscape', 'No Sky', 'Fixed Dimensions', 'No Grass')), { required: true }),
    sub('NAM0', 'boundsMin', 'Object Bounds Min', struct([['x', 'X', f32()], ['y', 'Y', f32()]])),
    sub('NAM9', 'boundsMax', 'Object Bounds Max', struct([['x', 'X', f32()], ['y', 'Y', f32()]])),
    sub('ZNAM', 'music', 'Music', formid(['MUSC'])),
    sub('NNAM', 'canopyShadow', 'Canopy Shadow (unused)', zstring({ hidden: true })),
    sub('XNAM', 'waterNoiseTexture', 'Water Noise Texture', zstring()),
    sub('XWEM', 'waterEnvironmentMap', 'Water Environment Map', zstring()),
    sub('TNAM', 'hdLodDiffuse', 'HD LOD Diffuse Texture', zstring()),
    sub('UNAM', 'hdLodNormal', 'HD LOD Normal Texture', zstring()),
    sub('OFST', 'offsetData', 'Offset Data', bytes(undefined, { hidden: true })),
  ],
  { category: 'World Data' },
);

const REF_BASES = ['ACTI', 'ADDN', 'ALCH', 'AMMO', 'APPA', 'ARMO', 'ARTO', 'ASPC', 'BOOK', 'CONT', 'DOOR', 'FLOR', 'FURN', 'IDLM', 'INGR', 'KEYM', 'LIGH', 'MISC', 'MSTT', 'SCRL', 'SLGM', 'SOUN', 'STAT', 'TACT', 'TREE', 'TXST', 'WEAP'];

export const REFR: RecordDef = record(
  'REFR',
  'Placed Object',
  [
    EDID,
    VMAD,
    sub('NAME', 'base', 'Base Object', formid(REF_BASES), { required: true }),
    sub('XMBO', 'boundHalfExtents', 'Bound Half Extents', vec3()),
    sub(
      'XPRM',
      'primitive',
      'Primitive',
      struct([
        ['bounds', 'Bounds', vec3()],
        ['color', 'Color', struct([['r', 'Red', f32()], ['g', 'Green', f32()], ['b', 'Blue', f32()], ['a', 'Alpha', f32()]])],
        ['type', 'Type', enumOf('u32', enumList('None', 'Box', 'Sphere', 'Portal Box', 'Line'))],
      ]),
    ),
    sub('XORD', 'occlusionRefs', 'Linked Occlusion References', array(formid(['REFR']))),
    sub('XOCP', 'occlusionPlane', 'Occlusion Plane Data', bytes()),
    sub('XPOD', 'portalData', 'Portal Data', array(struct([['origin', 'Origin', formid(['REFR'])], ['destination', 'Destination', formid(['REFR'])]]))),
    sub('XPTL', 'roomPortal', 'Room Portal (unused)', bytes(undefined, { hidden: true })),
    rstruct('boundData', 'Bound Data', [
      sub('XRMR', 'header', 'Header', bytes(4)),
      sub('LNAM', 'lightingTemplate', 'Lighting Template', formid(['LGTM'])),
      sub('INAM', 'imageSpace', 'Image Space', formid(['IMGS'])),
      rarray('linkedRooms', 'Linked Rooms', sub('XLRM', 'room', 'Linked Room', formid(['REFR']))),
    ]),
    sub('XMBP', 'multiboundPrimitive', 'MultiBound Primitive Marker', empty()),
    sub('XRGD', 'ragdollData', 'Ragdoll Data', bytes(undefined, { hidden: true })),
    sub('XRGB', 'ragdollBipedData', 'Ragdoll Biped Data', bytes(undefined, { hidden: true })),
    sub('XRDS', 'radius', 'Radius', f32()),
    rarray('reflectedBy', 'Reflected/Refracted By', sub('XPWR', 'water', 'Water', struct([['reference', 'Reference', formid(['REFR'])], ['type', 'Type', flags('u32', flagList('Reflection', 'Refraction'))]]))),
    rarray('litWater', 'Lit Water', sub('XLTW', 'water', 'Water', formid(['REFR']))),
    sub('XEMI', 'emittance', 'Emittance', formid(['LIGH', 'REGN'])),
    sub('XLIG', 'lightData', 'Light Data', struct([['fov', 'FOV 90+/-', f32()], ['fade', 'Fade 1.35+/-', f32()], ['endDistanceCap', 'End Distance Cap', f32()], ['shadowDepthBias', 'Shadow Depth Bias', f32()], ['unknown', 'Unknown', bytes(4, { hidden: true })]])),
    sub('XALP', 'alpha', 'Alpha', struct([['cutoff', 'Cutoff', u8()], ['base', 'Base', u8()]])),
    sub(
      'XTEL',
      'teleport',
      'Teleport Destination',
      struct([
        ['door', 'Door', formid(['REFR'])],
        ['placement', 'Position / Rotation', POS_ROT],
        ['noAlarm', 'No Alarm', u32()],
      ]),
    ),
    sub('XTNM', 'teleportMessage', 'Teleport Message Box', formid(['MESG'])),
    sub('XMBR', 'multiboundRef', 'MultiBound Reference', formid(['REFR'])),
    sub('XWCN', 'waterCurrentCount', 'Water Velocity Count', u32({ hidden: true })),
    sub('XWCS', 'waterCurrentCountOld', 'Water Velocity Count (old)', u32({ hidden: true })),
    sub('XWCU', 'waterCurrents', 'Water Velocities', bytes(undefined, { hidden: true })),
    sub('XCVL', 'waterLinearVelocity', 'Water Current Linear Velocity', vec3()),
    sub('XCVR', 'waterRotationalVelocity', 'Water Current Rotational Velocity', vec3()),
    rarray(
      'waterCurrentData',
      'Water Current Data',
      rstruct('current', 'Current', [
        sub('XCZR', 'reference', 'Reference', formid()),
        sub('XCZC', 'cell', 'Cell', formid(['CELL'])),
        sub('XCZA', 'unknown', 'Unknown', bytes(undefined, { hidden: true })),
      ]),
    ),
    XSCL,
    sub('XSPC', 'spawnContainer', 'Spawn Container', formid(['REFR'])),
    rstruct('activateParents', 'Activate Parents', [
      sub('XAPD', 'parentActivateOnly', 'Parent Activate Only', u8()),
      rarray('refs', 'Activate Parent Refs', sub('XAPR', 'ref', 'Activate Parent Ref', struct([['reference', 'Reference', formid()], ['delay', 'Delay', f32()]]))),
    ]),
    sub('XLIB', 'leveledItemBase', 'Leveled Item Base Object', formid(['LVLI'])),
    sub('XLCM', 'levelModifier', 'Level Modifier', enumOf('s32', enumList('Easy', 'Medium', 'Hard', 'Very Hard'))),
    sub('XLCN', 'persistLocation', 'Persist Location', formid(['LCTN'])),
    sub('XTRI', 'collisionLayer', 'Collision Layer', u32()),
    sub(
      'XLOC',
      'lock',
      'Lock Data',
      struct([
        ['level', 'Level', enumOf('u8', { 1: 'Novice', 25: 'Apprentice', 50: 'Adept', 75: 'Expert', 100: 'Master', 255: 'Requires Key' })],
        ['unused', 'Unused', unused(3)],
        ['key', 'Key', formid(['KEYM'])],
        ['flags', 'Flags', flags('u8', flagList(null, null, 'Leveled Lock'))],
        ['unused2', 'Unused', unused(3)],
        ['unused3', 'Unused', unused(8)],
      ]),
    ),
    sub('XEZN', 'encounterZone', 'Encounter Zone', formid(['ECZN'])),
    sub('XNDP', 'navmeshDoorLink', 'Navmesh Door Link', struct([['navmesh', 'Navmesh', formid(['NAVM'])], ['triangle', 'Triangle', s16()], ['unused', 'Unused', unused(2)]]), {
      help: 'Generated automatically when navmeshes are finalized.',
    }),
    sub('XLRT', 'locationRefType', 'Location Ref Type', array(formid(['LCRT']))),
    sub('XIS2', 'ignoredBySandbox', 'Ignored by Sandbox', empty()),
    OWNERSHIP,
    sub('XCNT', 'itemCount', 'Item Count', s32()),
    sub('XCHG', 'charge', 'Charge', f32()),
    sub('XLRL', 'locationReference', 'Location Reference', formid(['LCRT', 'LCTN'])),
    XESP,
    XLKR,
    rarray(
      'patrol',
      'Patrol',
      rstruct('data', 'Patrol Data', [
        { ...sub('XPRD', 'idleTime', 'Idle Time', f32()), required: true },
        sub('XPPA', 'marker', 'Patrol Script Marker', empty({ hidden: true })),
        sub('INAM', 'idle', 'Idle', formid(['IDLE'])),
        sub('SCHR', 'unusedSCHR', 'Unused', bytes(undefined, { hidden: true })),
        sub('SCTX', 'unusedSCTX', 'Unused', bytes(undefined, { hidden: true })),
        rarray('topics', 'Topics', sub('PDTO', 'topic', 'Topic', bytes(8))),
      ]),
    ),
    sub('XACT', 'actionFlags', 'Action Flags', flags('u32', flagList('Use Default', 'Activate', 'Open', 'Open by Default'))),
    sub('XHTW', 'headTrackingWeight', 'Head-Tracking Weight', f32()),
    sub('XFVC', 'favorCost', 'Favor Cost', f32()),
    sub('ONAM', 'openByDefault', 'Open by Default', empty()),
    rstruct('mapMarker', 'Map Marker', [
      { ...sub('XMRK', 'marker', 'Map Marker', empty()), required: true },
      sub('FNAM', 'flags', 'Map Flags', flags('u8', flagList('Visible', 'Can Travel To', '"Show All" Hidden'))),
      sub('FULL', 'name', 'Name', lstring()),
      sub('TNAM', 'type', 'Type', struct([['type', 'Type', u8()], ['unused', 'Unused', unused(1)]])),
    ]),
    sub('XATR', 'attachRef', 'Attach Ref', formid()),
    sub('XLOD', 'distantLod', 'Distant LOD Data', bytes(undefined, { hidden: true })),
    DATA_POSROT,
  ],
  {
    unordered: true,
    category: 'World Data',
    flags: { 9: 'Hidden From Local Map', 10: 'Persistent', 11: 'Initially Disabled', 15: 'Visible When Distant', 16: 'Is Full LOD', 28: 'Reflected By Auto Water', 29: "Don't Havok Settle", 30: 'No Respawn', 31: 'Multibound' },
  },
);

export const ACHR: RecordDef = record(
  'ACHR',
  'Placed NPC',
  [
    EDID,
    VMAD,
    sub('NAME', 'base', 'Base NPC', formid(['NPC_']), { required: true }),
    sub('XEZN', 'encounterZone', 'Encounter Zone', formid(['ECZN'])),
    sub('XRGD', 'ragdollData', 'Ragdoll Data', bytes(undefined, { hidden: true })),
    sub('XRGB', 'ragdollBipedData', 'Ragdoll Biped Data', bytes(undefined, { hidden: true })),
    rstruct('patrol', 'Patrol Data', [
      { ...sub('XPRD', 'idleTime', 'Idle Time', f32()), required: true },
      sub('XPPA', 'marker', 'Patrol Script Marker', empty({ hidden: true })),
      sub('INAM', 'idle', 'Idle', formid(['IDLE'])),
      sub('SCHR', 'unusedSCHR', 'Unused', bytes(undefined, { hidden: true })),
      sub('SCDA', 'unusedSCDA', 'Unused', bytes(undefined, { hidden: true })),
      sub('SCTX', 'unusedSCTX', 'Unused', bytes(undefined, { hidden: true })),
      sub('QNAM', 'unusedQNAM', 'Unused', bytes(undefined, { hidden: true })),
      sub('SCRO', 'unusedSCRO', 'Unused', bytes(undefined, { hidden: true })),
      rarray('topics', 'Topics', sub('PDTO', 'topic', 'Topic', bytes(8))),
      sub('TNAM', 'topic', 'Topic', formid(['DIAL'])),
    ]),
    sub('XLCM', 'levelModifier', 'Level Modifier', enumOf('s32', enumList('Easy', 'Medium', 'Hard', 'Very Hard'))),
    sub('XMRC', 'merchantContainer', 'Merchant Container', formid(['REFR'])),
    sub('XCNT', 'count', 'Count', s32()),
    sub('XRDS', 'radius', 'Radius', f32()),
    sub('XHLP', 'health', 'Health', f32()),
    XLKR,
    rstruct('activateParents', 'Activate Parents', [
      sub('XAPD', 'parentActivateOnly', 'Parent Activate Only', u8()),
      rarray('refs', 'Activate Parent Refs', sub('XAPR', 'ref', 'Activate Parent Ref', struct([['reference', 'Reference', formid()], ['delay', 'Delay', f32()]]))),
    ]),
    sub('XCLP', 'linkColor', 'Linked Reference Color', bytes(8)),
    sub('XLOD', 'distantLod', 'Distant LOD Data', bytes(undefined, { hidden: true })),
    sub('XLCN', 'persistLocation', 'Persist Location', formid(['LCTN'])),
    sub('XLRL', 'locationReference', 'Location Reference', formid(['LCRT', 'LCTN'])),
    sub('XIS2', 'ignoredBySandbox', 'Ignored by Sandbox', empty()),
    sub('XLRT', 'locationRefType', 'Location Ref Type', array(formid(['LCRT']))),
    sub('XHOR', 'horse', 'Horse', formid(['ACHR'])),
    sub('XHTW', 'headTrackingWeight', 'Head-Tracking Weight', f32()),
    sub('XFVC', 'favorCost', 'Favor Cost', f32()),
    XESP,
    OWNERSHIP,
    sub('XEMI', 'emittance', 'Emittance', formid(['LIGH', 'REGN'])),
    sub('XMBR', 'multiboundRef', 'MultiBound Reference', formid(['REFR'])),
    sub('XIBS', 'ignoredBySandbox2', 'Ignored By Sandbox', empty()),
    XSCL,
    DATA_POSROT,
  ],
  {
    unordered: true,
    category: 'World Data',
    flags: { 9: 'Starts Dead', 10: 'Persistent', 11: 'Initially Disabled', 15: 'Visible When Distant', 25: 'No AI Acquire', 29: "Don't Havok Settle" },
  },
);

export const NAVM: RecordDef = record(
  'NAVM',
  'Navmesh',
  [
    EDID,
    sub('NVNM', 'geometry', 'Geometry', custom('Navmesh', nvnmCodec)),
    sub('ONAM', 'baseObjects', 'Base Objects', array(formid())),
    sub('PNAM', 'preferredConnectors', 'Preferred Connectors', array(u16())),
    sub('NNAM', 'nonConnectors', 'Non Connectors', array(u16())),
  ],
  { category: 'World Data', flags: { 11: 'Initially Disabled', 18: 'Compressed', 26: 'AutoGen', 31: 'Navmesh Gen Cell' } },
);

export const LAND: RecordDef = record(
  'LAND',
  'Landscape',
  [
    sub('DATA', 'flags', 'Flags', flags('u32', flagList('Has Vertex Normals/Height Map', 'Has Vertex Colours', 'Has Layers', null, 'Auto-Calc Normals', 'Has Hi-Res Heightfield'))),
    sub('VNML', 'normals', 'Vertex Normals', bytes(undefined, { hidden: true })),
    sub('VHGT', 'heights', 'Vertex Height Map', bytes(undefined, { hidden: true })),
    sub('VCLR', 'colors', 'Vertex Colours', bytes(undefined, { hidden: true })),
  ],
  { category: 'World Data' },
);

const DIR_MATERIAL = struct([
  ['maxAngle', 'Max Angle (30-120)', f32({ default: 90 })],
  ['material', 'Material', formid(['MATO'])],
  ['consideredSnow', 'Considered Snow', u8()],
  ['unused', 'Unused', unused(3)],
]);

export const STAT: RecordDef = record(
  'STAT',
  'Static',
  [EDID, OBND, MODEL, sub('DNAM', 'directionalMaterial', 'Directional Material', DIR_MATERIAL, { required: true }), sub('MNAM', 'distantLod', 'Distant LOD', bytes())],
  {
    category: 'World Objects',
    flags: { 2: 'Never Fades', 6: 'Has Tree LOD', 7: 'Add-On LOD Object', 9: 'Hidden From Local Map', 15: 'Has Distant LOD', 17: 'Uses HD LOD Texture', 19: 'Has Currents', 23: 'Is Marker', 25: 'Obstacle', 26: 'Navmesh - Filter', 27: 'Navmesh - Bounding Box', 28: 'Show In World Map', 30: 'Navmesh - Ground' },
  },
);

export const MSTT: RecordDef = record(
  'MSTT',
  'Moveable Static',
  [EDID, OBND, FULL, MODEL, DEST, sub('DATA', 'flags', 'Flags', flags('u8', flagList('On Local Map'))), sub('SNAM', 'loopingSound', 'Looping Sound', formid(['SNDR']))],
  { category: 'World Objects' },
);

export const ACTI: RecordDef = record(
  'ACTI',
  'Activator',
  [
    EDID,
    VMAD,
    OBND,
    FULL,
    MODEL,
    DEST,
    KEYWORDS,
    sub('PNAM', 'markerColor', 'Marker Color', BYTE_COLOR),
    sub('SNAM', 'loopingSound', 'Sound - Looping', formid(['SNDR'])),
    sub('VNAM', 'activationSound', 'Sound - Activation', formid(['SNDR'])),
    sub('WNAM', 'waterType', 'Water Type', formid(['WATR'])),
    sub('RNAM', 'activateTextOverride', 'Activate Text Override', lstring()),
    sub('FNAM', 'flags', 'Flags', flags('u16', flagList('No Displacement', 'Ignored by Sandbox'))),
    sub('KNAM', 'interactionKeyword', 'Interaction Keyword', formid(['KYWD'])),
  ],
  { category: 'World Objects' },
);

export const DOOR: RecordDef = record(
  'DOOR',
  'Door',
  [
    EDID,
    VMAD,
    OBND,
    FULL,
    MODEL,
    DEST,
    sub('SNAM', 'openSound', 'Sound - Open', formid(['SNDR'])),
    sub('ANAM', 'closeSound', 'Sound - Close', formid(['SNDR'])),
    sub('BNAM', 'loopSound', 'Sound - Loop', formid(['SNDR'])),
    sub('FNAM', 'flags', 'Flags', flags('u8', flagList(null, 'Automatic', 'Hidden', 'Minimal Use', 'Sliding', 'Do Not Open in Combat Search'))),
    rarray('randomTeleports', 'Random Teleport Destinations', sub('TNAM', 'destination', 'Destination', formid(['CELL', 'WRLD']))),
  ],
  { category: 'World Objects' },
);

export const CONT: RecordDef = record(
  'CONT',
  'Container',
  [
    EDID,
    VMAD,
    OBND,
    FULL,
    MODEL,
    ITEMS,
    DEST,
    sub('DATA', 'data', 'Data', struct([['flags', 'Flags', flags('u8', flagList('Allow Sounds When Animation', 'Respawns', 'Show Owner'))], ['weight', 'Weight', f32()]])),
    sub('SNAM', 'openSound', 'Sound - Open', formid(['SNDR'])),
    sub('QNAM', 'closeSound', 'Sound - Close', formid(['SNDR'])),
  ],
  { category: 'World Objects' },
);

export const LIGH: RecordDef = record(
  'LIGH',
  'Light',
  [
    EDID,
    VMAD,
    OBND,
    MODEL,
    DEST,
    FULL,
    sub('ICON', 'icon', 'Icon', zstring()),
    sub('MICO', 'smallIcon', 'Small Icon', zstring()),
    sub(
      'DATA',
      'data',
      'Data',
      struct([
        ['time', 'Time', s32()],
        ['radius', 'Radius', u32()],
        ['color', 'Color', BYTE_COLOR],
        [
          'flags',
          'Flags',
          flags(
            'u32',
            flagList('Dynamic', 'Can be Carried', 'Negative', 'Flicker', null, 'Off By Default', 'Flicker Slow', 'Pulse', 'Pulse Slow', 'Spot Light', 'Shadow Spotlight', 'Shadow Hemisphere', 'Shadow Omnidirectional', 'Portal-strict'),
          ),
        ],
        ['falloffExponent', 'Falloff Exponent', f32({ default: 1 })],
        ['fov', 'FOV', f32({ default: 90 })],
        ['nearClip', 'Near Clip', f32()],
        ['flickerPeriod', 'Flicker Period', f32()],
        ['flickerIntensityAmplitude', 'Flicker Intensity Amplitude', f32()],
        ['flickerMovementAmplitude', 'Flicker Movement Amplitude', f32()],
        ['value', 'Value', u32()],
        ['weight', 'Weight', f32()],
      ]),
      { required: true },
    ),
    sub('FNAM', 'fadeValue', 'Fade Value', f32({ default: 1 }), { required: true }),
    sub('SNAM', 'sound', 'Sound', formid(['SNDR'])),
  ],
  { category: 'World Objects' },
);

export const FURN: RecordDef = record(
  'FURN',
  'Furniture',
  [
    EDID,
    VMAD,
    OBND,
    FULL,
    MODEL,
    DEST,
    KEYWORDS,
    sub('PNAM', 'markerColor', 'Marker Color (Unused)', BYTE_COLOR),
    sub('FNAM', 'flags', 'Flags', u16()),
    sub('KNAM', 'interactionKeyword', 'Interaction Keyword', formid(['KYWD'])),
    sub('MNAM', 'activeMarkers', 'Active Markers / Flags', u32()),
    sub('WBDT', 'workbench', 'Workbench Data', bytes()),
    sub('NAM1', 'associatedSpell', 'Associated Spell', formid(['SPEL'])),
  ],
  { category: 'World Objects' },
);

export const FLOR: RecordDef = record(
  'FLOR',
  'Flora',
  [
    EDID,
    VMAD,
    OBND,
    FULL,
    MODEL,
    DEST,
    KEYWORDS,
    sub('PNAM', 'markerColor', 'Marker Color (Unused)', BYTE_COLOR),
    sub('RNAM', 'activateTextOverride', 'Activate Text Override', lstring()),
    sub('FNAM', 'flags', 'Flags', u16()),
    sub('PFIG', 'ingredient', 'Ingredient', formid()),
    sub('SNAM', 'harvestSound', 'Harvest Sound', formid(['SNDR'])),
    sub('PFPC', 'seasons', 'Seasonal Production', bytes(4)),
  ],
  { category: 'World Objects' },
);

export const TREE: RecordDef = record(
  'TREE',
  'Tree',
  [
    EDID,
    VMAD,
    OBND,
    MODEL,
    sub('PFIG', 'ingredient', 'Ingredient', formid()),
    sub('SNAM', 'harvestSound', 'Harvest Sound', formid(['SNDR'])),
    sub('PFPC', 'seasons', 'Seasonal Production', bytes(4)),
    FULL,
    sub('CNAM', 'treeData', 'Tree Data', bytes()),
  ],
  { category: 'World Objects' },
);

/** Landscape texture: what painted ground looks like (a texture set), its material and the grass that grows on it. */
export const LTEX: RecordDef = record(
  'LTEX',
  'Landscape Texture',
  [
    EDID,
    sub('TNAM', 'textureSet', 'Texture Set', formid(['TXST'])),
    sub('MNAM', 'material', 'Material Type', formid(['MATT'])),
    sub('HNAM', 'havok', 'Havok Data', struct([['friction', 'Friction', u8()], ['restitution', 'Restitution', u8()]])),
    sub('SNAM', 'specular', 'Texture Specular Exponent', u8()),
    rarray('grasses', 'Grasses', sub('GNAM', 'grass', 'Grass', formid(['GRAS']))),
    sub('INAM', 'flags', 'Flags', u32({ hidden: true })),
  ],
  { category: 'World Data' },
);

export const TXST: RecordDef = record(
  'TXST',
  'Texture Set',
  [
    EDID,
    OBND,
    rstruct('textures', 'Textures', [
      sub('TX00', 'diffuse', 'Diffuse', zstring()),
      sub('TX01', 'normal', 'Normal/Gloss', zstring()),
      sub('TX02', 'envMask', 'Environment Mask/Subsurface Tint', zstring()),
      sub('TX03', 'glow', 'Glow/Detail Map', zstring()),
      sub('TX04', 'height', 'Height', zstring()),
      sub('TX05', 'environment', 'Environment', zstring()),
      sub('TX06', 'multilayer', 'Multilayer', zstring()),
      sub('TX07', 'backlight', 'Backlight Mask/Specular', zstring()),
    ]),
    sub('DODT', 'decal', 'Decal Data', bytes()),
    sub('DNAM', 'flags', 'Flags', flags('u16', flagList('No Specular Map', 'Facegen Textures', 'Has Model Space Normal Map'))),
  ],
  { category: 'Special Effects' },
);

export const SCOL: RecordDef = record('SCOL', 'Static Collection', [EDID, OBND, MODEL], { category: 'World Objects' });

export { u32 };
