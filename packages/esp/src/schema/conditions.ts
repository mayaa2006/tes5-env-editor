/**
 * Conditions (CTDA + optional CIS1/CIS2). The parameter layout depends on the
 * condition function, so CTDA is implemented as a custom codec backed by the
 * engine's function table.
 */
import type { BinaryReader, BinaryWriter } from '../binary';
import { CONDITION_FUNCTION_TABLE } from './conditions-table';
import { custom, rarray, rstruct, sub, zstring } from './dsl';
import type { CodecContext, CustomCodec, RArrayMember } from './types';

export type ConditionParamType =
  | 'none'
  | 'float'
  | 'integer'
  | 'string'
  | 'alias'
  | 'event'
  | 'packdata'
  | 'questStage'
  | 'vatsValueParam'
  | 'actorValue'
  | 'alignment'
  | 'axis'
  | 'castingSource'
  | 'crimeType'
  | 'criticalStage'
  | 'formType'
  | 'furnitureAnim'
  | 'furnitureEntry'
  | 'miscStat'
  | 'playerAction'
  | 'sex'
  | 'vatsValueFunction'
  | 'wardState'
  | 'actor'
  | 'actorBase'
  | 'associationType'
  | 'baseObject'
  | 'cell'
  | 'class'
  | 'effectItem'
  | 'encounterZone'
  | 'equipType'
  | 'eventData'
  | 'faction'
  | 'factionNull'
  | 'formList'
  | 'furniture'
  | 'global'
  | 'idleForm'
  | 'inventoryObject'
  | 'keyword'
  | 'knowable'
  | 'location'
  | 'locationRefType'
  | 'magicEffect'
  | 'owner'
  | 'package'
  | 'perk'
  | 'quest'
  | 'race'
  | 'reference'
  | 'region'
  | 'scene'
  | 'shout'
  | 'voiceType'
  | 'weather'
  | 'worldspace';

/** Parameter kinds stored as FormIDs. */
export const FORM_PARAM_TYPES: ReadonlySet<ConditionParamType> = new Set<ConditionParamType>([
  'actor', 'actorBase', 'associationType', 'baseObject', 'cell', 'class', 'effectItem', 'encounterZone',
  'equipType', 'eventData', 'faction', 'factionNull', 'formList', 'furniture', 'global', 'idleForm',
  'inventoryObject', 'keyword', 'knowable', 'location', 'locationRefType', 'magicEffect', 'owner', 'package',
  'perk', 'quest', 'race', 'reference', 'region', 'scene', 'shout', 'voiceType', 'weather', 'worldspace',
]);

/** Record signatures each FormID parameter accepts (for pickers). */
export const PARAM_REFS: Partial<Record<ConditionParamType, readonly string[]>> = {
  actor: ['ACHR', 'PLYR', 'REFR'],
  actorBase: ['NPC_'],
  associationType: ['ASTP'],
  baseObject: ['ACTI', 'ALCH', 'AMMO', 'ARMA', 'ARMO', 'ASPC', 'BOOK', 'CONT', 'DOOR', 'ENCH', 'FLOR', 'FURN', 'GRAS', 'HAZD', 'IDLM', 'KEYM', 'LIGH', 'LVLI', 'LVSP', 'MISC', 'MSTT', 'NPC_', 'PROJ', 'SCRL', 'SHOU', 'SLGM', 'SOUN', 'SPEL', 'STAT', 'TACT', 'TREE', 'WEAP', 'FLST'],
  cell: ['CELL'],
  class: ['CLAS'],
  effectItem: ['ALCH', 'ENCH', 'INGR', 'SCRL', 'SPEL'],
  encounterZone: ['ECZN'],
  equipType: ['EQUP'],
  faction: ['FACT'],
  factionNull: ['FACT'],
  formList: ['FLST'],
  furniture: ['FLST', 'FURN'],
  global: ['GLOB'],
  idleForm: ['IDLE'],
  inventoryObject: ['ALCH', 'AMMO', 'ARMO', 'BOOK', 'COBJ', 'FLST', 'INGR', 'KEYM', 'LIGH', 'LVLI', 'MISC', 'SCRL', 'SLGM', 'WEAP'],
  keyword: ['KYWD'],
  knowable: ['ENCH', 'MGEF', 'WOOP'],
  location: ['LCTN'],
  locationRefType: ['LCRT'],
  magicEffect: ['MGEF'],
  owner: ['FACT', 'NPC_'],
  package: ['PACK'],
  perk: ['PERK'],
  quest: ['QUST'],
  race: ['RACE'],
  reference: ['ACHR', 'PARW', 'PBAR', 'PBEA', 'PCON', 'PFLA', 'PGRE', 'PHZD', 'PLYR', 'PMIS', 'REFR'],
  region: ['REGN'],
  scene: ['SCEN'],
  shout: ['SHOU'],
  voiceType: ['FLST', 'VTYP'],
  weather: ['WTHR'],
  worldspace: ['FLST', 'WRLD'],
};

export interface ConditionFunctionInfo {
  index: number;
  name: string;
  params: readonly ConditionParamType[];
}

const BY_INDEX = new Map<number, ConditionFunctionInfo>();
const BY_NAME = new Map<string, ConditionFunctionInfo>();
for (const [index, name, params] of CONDITION_FUNCTION_TABLE) {
  const info = { index, name, params };
  BY_INDEX.set(index, info);
  BY_NAME.set(name.toLowerCase(), info);
}

export function conditionFunction(index: number): ConditionFunctionInfo | undefined {
  return BY_INDEX.get(index);
}

export function conditionFunctionByName(name: string): ConditionFunctionInfo | undefined {
  return BY_NAME.get(name.toLowerCase());
}

export function allConditionFunctions(): ConditionFunctionInfo[] {
  return [...BY_INDEX.values()];
}

export type CompareOp = '==' | '!=' | '>' | '>=' | '<' | '<=';
const OPS: readonly CompareOp[] = ['==', '!=', '>', '>=', '<', '<='];

export const RUN_ON = ['Subject', 'Target', 'Reference', 'Combat Target', 'Linked Reference', 'Quest Alias', 'Package Data', 'Event Data'] as const;

export interface Condition {
  op: CompareOp;
  or: boolean;
  useAliases: boolean;
  useGlobal: boolean;
  usePackData: boolean;
  swapSubjectTarget: boolean;
  /** Raw high bits of the type byte when the operator is not one of the six known ones. */
  rawOpBits?: number;
  /** Float, or a GLOB reference when useGlobal is set. */
  value: unknown;
  function: number;
  param1: unknown;
  param2: unknown;
  /** Index into RUN_ON. */
  runOn: number;
  /** Only meaningful when runOn = Reference (2); otherwise the raw u32 is kept. */
  reference: unknown;
  /** Quest alias index (runOn = 5), event data member (7), else usually -1. */
  param3: number;
  unused1?: Uint8Array;
  unused2?: Uint8Array;
  /** Stored without parameter #3 (28-byte CTDA from old data). */
  noParam3?: boolean;
}

function readParam(r: BinaryReader, type: ConditionParamType | undefined, ctx: CodecContext): unknown {
  if (type === 'float') return r.f32();
  const raw = r.u32();
  if (type && FORM_PARAM_TYPES.has(type)) return ctx.mapFormId ? ctx.mapFormId(raw) : raw;
  if (type === 'integer' || type === 'alias' || type === 'questStage' || type === 'actorValue') return raw | 0;
  return raw;
}

function writeParam(w: BinaryWriter, type: ConditionParamType | undefined, v: unknown, ctx: CodecContext): void {
  if (type === 'float') {
    w.f32(Number(v ?? 0));
    return;
  }
  if (type && FORM_PARAM_TYPES.has(type)) {
    w.u32(ctx.unmapFormId ? ctx.unmapFormId(v) : Number(v ?? 0));
    return;
  }
  const n = Number(v ?? 0);
  if (n < 0) w.i32(n);
  else w.u32(n);
}

export const ctdaCodec: CustomCodec<Condition> = {
  decode(r, size, ctx) {
    const start = r.pos;
    const type = r.u8();
    const unused1 = r.bytesView(3).slice();
    const useGlobal = (type & 0x04) !== 0;
    const value = useGlobal ? (ctx.mapFormId ? ctx.mapFormId(r.u32()) : r.u32()) : r.f32();
    const fn = r.u16();
    const unused2 = r.bytesView(2).slice();
    const info = BY_INDEX.get(fn);
    const param1 = readParam(r, info?.params[0], ctx);
    const param2 = readParam(r, info?.params[1], ctx);
    const runOn = r.u32();
    const refRaw = r.u32();
    const reference = runOn === 2 ? (ctx.mapFormId ? ctx.mapFormId(refRaw) : refRaw) : refRaw;
    // Older data can omit parameter #3.
    const hasParam3 = r.pos - start + 4 <= size;
    const param3 = hasParam3 ? r.i32() : -1;
    const opBits = (type & 0xe0) >> 5;
    const c: Condition = {
      op: OPS[opBits] ?? '==',
      or: (type & 0x01) !== 0,
      useAliases: (type & 0x02) !== 0,
      useGlobal,
      usePackData: (type & 0x08) !== 0,
      swapSubjectTarget: (type & 0x10) !== 0,
      value,
      function: fn,
      param1,
      param2,
      runOn,
      reference,
      param3,
    };
    if (opBits > 5) c.rawOpBits = opBits;
    if (!hasParam3) c.noParam3 = true;
    if (unused1.some((b) => b !== 0)) c.unused1 = unused1;
    if (unused2.some((b) => b !== 0)) c.unused2 = unused2;
    return c;
  },
  encode(w, c, ctx) {
    const opBits = c.rawOpBits ?? Math.max(0, OPS.indexOf(c.op));
    const type =
      (opBits << 5) |
      (c.or ? 0x01 : 0) |
      (c.useAliases ? 0x02 : 0) |
      (c.useGlobal ? 0x04 : 0) |
      (c.usePackData ? 0x08 : 0) |
      (c.swapSubjectTarget ? 0x10 : 0);
    w.u8(type);
    w.bytes(c.unused1 ?? new Uint8Array(3));
    if (c.useGlobal) w.u32(ctx.unmapFormId ? ctx.unmapFormId(c.value) : Number(c.value ?? 0));
    else w.f32(Number(c.value ?? 0));
    w.u16(c.function);
    w.bytes(c.unused2 ?? new Uint8Array(2));
    const info = BY_INDEX.get(c.function);
    writeParam(w, info?.params[0], c.param1, ctx);
    writeParam(w, info?.params[1], c.param2, ctx);
    w.u32(c.runOn);
    if (c.runOn === 2) w.u32(ctx.unmapFormId ? ctx.unmapFormId(c.reference) : Number(c.reference ?? 0));
    else w.u32(Number(c.reference ?? 0));
    if (!c.noParam3) w.i32(c.param3 ?? -1);
  },
  describe(c) {
    return describeCondition(c);
  },
};

export function describeCondition(c: Condition, formatForm: (v: unknown) => string = (v) => String(v)): string {
  const info = BY_INDEX.get(c.function);
  const name = info?.name ?? `Function#${c.function}`;
  const params = [c.param1, c.param2]
    .slice(0, info?.params.length ?? 0)
    .map((p, i) => (info && FORM_PARAM_TYPES.has(info.params[i]!) ? formatForm(p) : String(p)));
  const runOn = RUN_ON[c.runOn] ?? `RunOn#${c.runOn}`;
  const target = c.runOn === 2 ? formatForm(c.reference) : runOn;
  const value = c.useGlobal ? formatForm(c.value) : String(Math.round(Number(c.value) * 1000) / 1000);
  return `${target}.${name}(${params.join(', ')}) ${c.op} ${value}${c.or ? ' OR' : ' AND'}`;
}

export function newCondition(fn = 0): Condition {
  return {
    op: '==',
    or: false,
    useAliases: false,
    useGlobal: false,
    usePackData: false,
    swapSubjectTarget: false,
    value: 1,
    function: fn,
    param1: 0,
    param2: 0,
    runOn: 0,
    reference: 0,
    param3: -1,
  };
}

/** The standard conditions member (CTDA with optional CIS1/CIS2 string params). */
export function conditions(key = 'conditions', label = 'Conditions'): RArrayMember {
  return rarray(
    key,
    label,
    rstruct('condition', 'Condition', [
      { ...sub('CTDA', 'data', 'Condition', custom('Condition', ctdaCodec as CustomCodec<unknown>)), required: true },
      sub('CIS1', 'stringParam1', 'Parameter #1 (string)', zstring()),
      sub('CIS2', 'stringParam2', 'Parameter #2 (string)', zstring()),
    ]),
  );
}
