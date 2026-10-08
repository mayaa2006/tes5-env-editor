import type { RecordDef } from '../types';
import { CLAS, CLFM, FACT, HDPT, LVLN, NPC_, OTFT, RACE, RELA, VTYP } from './actors';
import { ALCH, AMMO, APPA, ARMA, ARMO, BOOK, COBJ, INGR, KEYM, LVLI, MISC, SLGM, WEAP } from './items';
import { ENCH, LVSP, MGEF, PERK, SCRL, SHOU, SPEL, WOOP } from './magic';
import { DIAL, DLBR, DLVW, FLST, GLOB, GMST, IDLE, INFO, KYWD, LCTN, MESG, PACK, QUST, SCEN } from './quests';
import { ACHR, ACTI, CELL, CONT, DOOR, FLOR, FURN, LAND, LIGH, LTEX, MSTT, NAVM, REFR, SCOL, STAT, TREE, TXST, WRLD } from './world';

export * from './actors';
export * from './common';
export * from './items';
export * from './magic';
export * from './quests';
export * from './world';

const ALL: RecordDef[] = [
  NPC_, HDPT, VTYP, CLFM, OTFT, CLAS, FACT, LVLN, RACE, RELA,
  QUST, DIAL, INFO, DLBR, DLVW, MESG, GLOB, KYWD, FLST, GMST, PACK, SCEN, LCTN, IDLE,
  CELL, WRLD, REFR, ACHR, NAVM, LAND, STAT, MSTT, ACTI, DOOR, CONT, LIGH, FURN, FLOR, TREE, TXST, SCOL, LTEX,
  ARMO, WEAP, BOOK, MISC, KEYM, AMMO, ALCH, INGR, SLGM, ARMA, APPA, LVLI, COBJ,
  MGEF, SPEL, ENCH, SCRL, SHOU, WOOP, LVSP, PERK,
];

const REGISTRY = new Map<string, RecordDef>(ALL.map((d) => [d.sig, d]));

/** Typed definition for a record signature, if one exists. */
export function getRecordDef(sig: string): RecordDef | undefined {
  return REGISTRY.get(sig);
}

export function allRecordDefs(): RecordDef[] {
  return [...REGISTRY.values()];
}

/** Human-readable names for every Skyrim record type (typed or not). */
export const RECORD_NAMES: Record<string, string> = {
  AACT: 'Action', ACHR: 'Placed NPC', ACTI: 'Activator', ADDN: 'Addon Node', ALCH: 'Ingestible', AMMO: 'Ammunition',
  ANIO: 'Animated Object', APPA: 'Apparatus', ARMA: 'Armor Addon', ARMO: 'Armor', ARTO: 'Art Object', ASPC: 'Acoustic Space',
  ASTP: 'Association Type', AVIF: 'Actor Value Information', BOOK: 'Book', BPTD: 'Body Part Data', CAMS: 'Camera Shot',
  CELL: 'Cell', CLAS: 'Class', CLFM: 'Color', CLMT: 'Climate', COBJ: 'Constructible Object', COLL: 'Collision Layer',
  CONT: 'Container', CPTH: 'Camera Path', CSTY: 'Combat Style', DEBR: 'Debris', DIAL: 'Dialog Topic', DLBR: 'Dialog Branch',
  DLVW: 'Dialog View', DOBJ: 'Default Object Manager', DOOR: 'Door', DUAL: 'Dual Cast Data', ECZN: 'Encounter Zone',
  EFSH: 'Effect Shader', ENCH: 'Object Effect', EQUP: 'Equip Type', EXPL: 'Explosion', EYES: 'Eyes', FACT: 'Faction',
  FLOR: 'Flora', FLST: 'FormID List', FSTP: 'Footstep', FSTS: 'Footstep Set', FURN: 'Furniture', GLOB: 'Global',
  GMST: 'Game Setting', GRAS: 'Grass', HAZD: 'Hazard', HDPT: 'Head Part', IDLE: 'Idle Animation', IDLM: 'Idle Marker',
  IMAD: 'Image Space Adapter', IMGS: 'Image Space', INFO: 'Dialog Response', INGR: 'Ingredient', IPCT: 'Impact',
  IPDS: 'Impact Data Set', KEYM: 'Key', KYWD: 'Keyword', LAND: 'Landscape', LCRT: 'Location Reference Type',
  LCTN: 'Location', LENS: 'Lens Flare', LGTM: 'Lighting Template', LIGH: 'Light', LSCR: 'Load Screen',
  LTEX: 'Landscape Texture', LVLI: 'Leveled Item', LVLN: 'Leveled NPC', LVSP: 'Leveled Spell', MATO: 'Material Object',
  MATT: 'Material Type', MESG: 'Message', MGEF: 'Magic Effect', MISC: 'Misc. Item', MOVT: 'Movement Type',
  MSTT: 'Moveable Static', MUSC: 'Music Type', MUST: 'Music Track', NAVI: 'Navmesh Info Map', NAVM: 'Navmesh',
  NPC_: 'Non-Player Character', OTFT: 'Outfit', PACK: 'Package', PARW: 'Placed Arrow', PBAR: 'Placed Barrier',
  PBEA: 'Placed Beam', PCON: 'Placed Cone/Voice', PERK: 'Perk', PFLA: 'Placed Flame', PGRE: 'Placed Projectile',
  PHZD: 'Placed Hazard', PMIS: 'Placed Missile', PROJ: 'Projectile', QUST: 'Quest', RACE: 'Race', REFR: 'Placed Object',
  REGN: 'Region', RELA: 'Relationship', REVB: 'Reverb Parameters', RFCT: 'Visual Effect', SCEN: 'Scene', SCOL: 'Static Collection',
  SCPT: 'Script (unused)', SCRL: 'Scroll', SHOU: 'Shout', SLGM: 'Soul Gem', SMBN: 'Story Manager Branch Node',
  SMEN: 'Story Manager Event Node', SMQN: 'Story Manager Quest Node', SNCT: 'Sound Category', SNDR: 'Sound Descriptor',
  SOPM: 'Sound Output Model', SOUN: 'Sound Marker', SPEL: 'Spell', SPGD: 'Shader Particle Geometry', STAT: 'Static',
  TACT: 'Talking Activator', TES4: 'File Header', TREE: 'Tree', TXST: 'Texture Set', VOLI: 'Volumetric Lighting',
  VTYP: 'Voice Type', WATR: 'Water', WEAP: 'Weapon', WOOP: 'Word of Power', WRLD: 'Worldspace', WTHR: 'Weather',
};

export function recordTypeName(sig: string): string {
  return RECORD_NAMES[sig] ?? sig;
}
