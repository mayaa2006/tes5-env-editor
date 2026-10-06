/** Record header flags that matter to tooling. Meaning of some bits depends on record type. */
export const RecordFlags = {
  /** TES4: file is a master (ESM). */
  ESM: 0x00000001,
  /** TES4: plugin is optimized (Oblivion only). */
  Optimized: 0x00000010,
  /** Any record: deleted. */
  Deleted: 0x00000020,
  /** TES4: strings are stored in external .STRINGS files. */
  Localized: 0x00000080,
  /** CELL: off limits; others: varies. */
  CellOffLimits: 0x00020000,
  /** TES4 (SSE): light plugin (ESL). */
  ESL: 0x00000200,
  /** REFR/ACHR/etc: persistent reference. */
  Persistent: 0x00000400,
  /** REFR/ACHR/etc: initially disabled. */
  InitiallyDisabled: 0x00000800,
  /** Any record: ignored by the engine. */
  Ignored: 0x00001000,
  /** REFR: visible when distant. */
  VisibleWhenDistant: 0x00008000,
  /** Any record: data is zlib-compressed. */
  Compressed: 0x00040000,
  /** NAVM: auto-generated. */
  NavmeshAutoGen: 0x04000000,
  /** NAVM: navmesh generation cell. */
  NavmeshGenCell: 0x80000000,
} as const;

export enum GroupType {
  Top = 0,
  WorldChildren = 1,
  InteriorCellBlock = 2,
  InteriorCellSubBlock = 3,
  ExteriorCellBlock = 4,
  ExteriorCellSubBlock = 5,
  CellChildren = 6,
  TopicChildren = 7,
  CellPersistentChildren = 8,
  CellTemporaryChildren = 9,
  CellVisibleDistantChildren = 10,
}

export type GameRelease = 'SkyrimLE' | 'SkyrimSE';

/** Form version written into record headers by each game's Creation Kit. */
export const FORM_VERSION: Record<GameRelease, number> = {
  SkyrimLE: 43,
  SkyrimSE: 44,
};

/** HEDR version written by each game's Creation Kit. 1.71 enables the extended ESL range. */
export const HEDR_VERSION: Record<GameRelease, number> = {
  SkyrimLE: 0.94,
  SkyrimSE: 1.7,
};

/** Signatures that may only live inside cell/world child groups (temporary or persistent). */
export const REFERENCE_SIGNATURES = new Set([
  'REFR',
  'ACHR',
  'PGRE',
  'PMIS',
  'PARW',
  'PBAR',
  'PBEA',
  'PCON',
  'PFLA',
  'PHZD',
]);

/** Records that live inside cell child groups (references plus navmeshes and landscape). */
export const CELL_CHILD_SIGNATURES = new Set([...REFERENCE_SIGNATURES, 'NAVM', 'LAND']);

/**
 * Overridden-form signatures recorded in the TES4 ONAM list of master files.
 * Mirrors what the Creation Kit / xEdit write for Skyrim.
 */
export const ONAM_SIGNATURES = new Set([...CELL_CHILD_SIGNATURES, 'CELL']);

/**
 * Canonical ordering of top-level groups in a Skyrim plugin
 * (same order the Creation Kit writes them).
 */
export const TOP_GROUP_ORDER: readonly string[] = [
  'GMST', 'KYWD', 'LCRT', 'AACT', 'TXST', 'GLOB', 'CLAS', 'FACT', 'HDPT', 'HAIR', 'EYES', 'RACE',
  'SOUN', 'ASPC', 'MGEF', 'SCPT', 'LTEX', 'ENCH', 'SPEL', 'SCRL', 'ACTI', 'TACT', 'ARMO', 'BOOK',
  'CONT', 'DOOR', 'INGR', 'LIGH', 'MISC', 'APPA', 'STAT', 'SCOL', 'MSTT', 'PWAT', 'GRAS', 'TREE',
  'CLDC', 'FLOR', 'FURN', 'WEAP', 'AMMO', 'NPC_', 'LVLN', 'KEYM', 'ALCH', 'IDLM', 'COBJ', 'PROJ',
  'HAZD', 'SLGM', 'LVLI', 'WTHR', 'CLMT', 'SPGD', 'RFCT', 'REGN', 'NAVI', 'CELL', 'WRLD', 'DIAL',
  'QUST', 'IDLE', 'PACK', 'CSTY', 'LSCR', 'LVSP', 'ANIO', 'WATR', 'EFSH', 'EXPL', 'DEBR', 'IMGS',
  'IMAD', 'FLST', 'PERK', 'BPTD', 'ADDN', 'AVIF', 'CAMS', 'CPTH', 'VTYP', 'MATT', 'IPCT', 'IPDS',
  'ARMA', 'ECZN', 'LCTN', 'MESG', 'RGDL', 'DOBJ', 'LGTM', 'MUSC', 'FSTP', 'FSTS', 'SMBN', 'SMQN',
  'SMEN', 'DLBR', 'MUST', 'DLVW', 'WOOP', 'SHOU', 'EQUP', 'RELA', 'SCEN', 'ASTP', 'OTFT', 'ARTO',
  'MATO', 'MOVT', 'SNDR', 'DUAL', 'SNCT', 'SOPM', 'COLL', 'CLFM', 'REVB', 'LENS', 'VOLI',
];

/** The hard-coded player reference, used e.g. as enable parent when disabling references. */
export const PLAYER_REF = 0x00000014;
/** The hard-coded player base actor. */
export const PLAYER_BASE = 0x00000007;
