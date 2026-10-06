/**
 * Script fragments: the small generated scripts the Creation Kit attaches to
 * quest stages (QF_), dialogue (TIF_), packages (PF_), scenes (SF_) and perks
 * (PRKF_). The text format below matches what the CK writes, so files round-trip
 * with the CK and existing mods.
 *
 * Unlike the CK, editing a fragment never depends on a successful compile: the
 * code lives in the model and the plugin binding is regenerated from it.
 */

export type FragmentHost = 'QUST' | 'INFO' | 'PACK' | 'SCEN' | 'PERK';

export const FRAGMENT_EXTENDS: Record<FragmentHost, string> = {
  QUST: 'Quest',
  INFO: 'TopicInfo',
  PACK: 'Package',
  SCEN: 'Scene',
  PERK: 'Perk',
};

const PREFIX: Record<FragmentHost, string> = { QUST: 'QF', INFO: 'TIF', PACK: 'PF', SCEN: 'SF', PERK: 'PRKF' };

/** Parameters each fragment function receives, and the auto-cast prologue the CK adds. */
const SIGNATURE: Record<FragmentHost, { params: string; prologue: string[] }> = {
  QUST: { params: '', prologue: [] },
  INFO: { params: 'ObjectReference akSpeakerRef', prologue: ['Actor akSpeaker = akSpeakerRef as Actor'] },
  PACK: { params: 'Actor akActor', prologue: [] },
  SCEN: { params: '', prologue: [] },
  PERK: { params: 'ObjectReference akTargetRef, Actor akActor', prologue: [] },
};

export interface FragmentAlias {
  /** Alias name as shown in the quest (property is Alias_<name>). */
  name: string;
  type: 'ReferenceAlias' | 'LocationAlias';
}

export interface Fragment {
  /** Function name, e.g. Fragment_3. */
  name: string;
  /** Body code (without the CK markers). */
  code: string;
}

export interface FragmentScript {
  host: FragmentHost;
  scriptName: string;
  extends: string;
  nextFragmentIndex: number;
  aliases: FragmentAlias[];
  fragments: Fragment[];
  /** Everything after the generated block (user-declared properties etc.), kept verbatim. */
  extraSource: string;
}

/** CK-style script name: QF_MyQuest_0100ABCD, TIF__0100ABCD, ... */
export function fragmentScriptName(host: FragmentHost, editorId: string | undefined, formId: number): string {
  const id = (formId >>> 0).toString(16).toUpperCase().padStart(8, '0');
  const ed = (editorId ?? '').replace(/[^A-Za-z0-9_]/g, '_');
  return `${PREFIX[host]}_${ed}_${id}`;
}

export function newFragmentScript(host: FragmentHost, scriptName: string): FragmentScript {
  return { host, scriptName, extends: FRAGMENT_EXTENDS[host], nextFragmentIndex: 0, aliases: [], fragments: [], extraSource: '' };
}

/** Add (or replace) a fragment; returns its function name. */
export function upsertFragment(script: FragmentScript, code: string, name?: string): string {
  if (name) {
    const existing = script.fragments.find((f) => f.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.code = code;
      return existing.name;
    }
  }
  const fname = name ?? `Fragment_${script.nextFragmentIndex}`;
  const m = /^Fragment_(\d+)$/i.exec(fname);
  if (m) script.nextFragmentIndex = Math.max(script.nextFragmentIndex, Number(m[1]) + 1);
  script.fragments.push({ name: fname, code });
  return fname;
}

const BEGIN_BLOCK = ';BEGIN FRAGMENT CODE - Do not edit anything between this and the end comment';
const END_BLOCK = ';END FRAGMENT CODE - Do not edit anything between this and the begin comment';

function normalizeCode(code: string): string {
  return code.replace(/\r\n/g, '\n').replace(/^\n+|\s+$/g, '');
}

export function generateFragmentSource(script: FragmentScript): string {
  const sig = SIGNATURE[script.host];
  const out: string[] = [];
  out.push(BEGIN_BLOCK);
  out.push(`;NEXT FRAGMENT INDEX ${script.nextFragmentIndex}`);
  out.push(`Scriptname ${script.scriptName} Extends ${script.extends} Hidden`);
  out.push('');
  for (const a of script.aliases) {
    out.push(`;BEGIN ALIAS PROPERTY ${a.name}`);
    out.push(`;ALIAS PROPERTY TYPE ${a.type}`);
    out.push(`${a.type} Property Alias_${a.name} Auto`);
    out.push(';END ALIAS PROPERTY');
    out.push('');
  }
  for (const f of script.fragments) {
    out.push(`;BEGIN FRAGMENT ${f.name}`);
    out.push(`Function ${f.name}(${sig.params})`);
    // Skyrim's CK writes the cast line directly (FO4 wraps it in AUTOCAST markers).
    out.push(...sig.prologue);
    out.push(';BEGIN CODE');
    const code = normalizeCode(f.code);
    if (code) out.push(code);
    out.push(';END CODE');
    out.push('EndFunction');
    out.push(';END FRAGMENT');
    out.push('');
  }
  out.push(END_BLOCK);
  const extra = script.extraSource.replace(/^\n+/, '');
  if (extra) {
    out.push('');
    out.push(extra.replace(/\s+$/, ''));
  }
  return out.join('\r\n') + '\r\n';
}

/** Parse a CK fragment script back into a model. Tolerates hand edits outside the markers. */
export function parseFragmentSource(source: string, host?: FragmentHost): FragmentScript {
  const text = source.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const header = /^\s*Scriptname\s+(\w+)\s+Extends\s+(\w+)/im.exec(text);
  const scriptName = header?.[1] ?? '';
  const ext = header?.[2] ?? '';
  const detectedHost = host ?? ((Object.entries(FRAGMENT_EXTENDS).find(([, v]) => v.toLowerCase() === ext.toLowerCase())?.[0] as FragmentHost | undefined) ?? 'QUST');
  const next = /^;NEXT FRAGMENT INDEX\s+(\d+)/im.exec(text);
  const script = newFragmentScript(detectedHost, scriptName);
  script.extends = ext || script.extends;
  script.nextFragmentIndex = next ? Number(next[1]) : 0;

  let i = 0;
  let endMarker = -1;
  while (i < lines.length) {
    const line = lines[i]!.trim();
    const alias = /^;BEGIN ALIAS PROPERTY\s+(.+)$/i.exec(line);
    if (alias) {
      const type = /^;ALIAS PROPERTY TYPE\s+(\w+)/i.exec(lines[i + 1]?.trim() ?? '');
      script.aliases.push({ name: alias[1]!.trim(), type: (type?.[1] as FragmentAlias['type']) ?? 'ReferenceAlias' });
      while (i < lines.length && !/^;END ALIAS PROPERTY/i.test(lines[i]!.trim())) i++;
      i++;
      continue;
    }
    const frag = /^;BEGIN FRAGMENT\s+(\w+)/i.exec(line);
    if (frag && !/^;BEGIN FRAGMENT CODE/i.test(line)) {
      let j = i + 1;
      while (j < lines.length && !/^;BEGIN CODE/i.test(lines[j]!.trim()) && !/^;END FRAGMENT\s*$/i.test(lines[j]!.trim())) j++;
      const codeLines: string[] = [];
      j++;
      while (j < lines.length && !/^;END CODE/i.test(lines[j]!.trim()) && !/^;END FRAGMENT\s*$/i.test(lines[j]!.trim())) {
        codeLines.push(lines[j]!);
        j++;
      }
      script.fragments.push({ name: frag[1]!, code: normalizeCode(codeLines.join('\n')) });
      while (j < lines.length && !/^;END FRAGMENT\s*$/i.test(lines[j]!.trim())) j++;
      i = j + 1;
      continue;
    }
    if (/^;END FRAGMENT CODE/i.test(line)) {
      endMarker = i;
      break;
    }
    i++;
  }
  if (endMarker >= 0) script.extraSource = lines.slice(endMarker + 1).join('\n').replace(/^\n+|\s+$/g, '');
  const maxIdx = script.fragments.reduce((m, f) => {
    const x = /^Fragment_(\d+)$/i.exec(f.name);
    return x ? Math.max(m, Number(x[1]) + 1) : m;
  }, 0);
  script.nextFragmentIndex = Math.max(script.nextFragmentIndex, maxIdx);
  return script;
}

/**
 * Papyrus types and the record signatures whose forms can fill them.
 * Used for property auto-fill and for the property editor's form picker.
 */
export const PROPERTY_TYPE_SIGNATURES: Record<string, readonly string[]> = {
  actor: ['ACHR'],
  actorbase: ['NPC_'],
  objectreference: ['REFR', 'ACHR', 'PGRE', 'PHZD', 'PMIS', 'PARW', 'PBAR', 'PBEA', 'PCON', 'PFLA'],
  quest: ['QUST'],
  globalvariable: ['GLOB'],
  keyword: ['KYWD'],
  locationreftype: ['LCRT'],
  faction: ['FACT'],
  spell: ['SPEL'],
  miscobject: ['MISC'],
  weapon: ['WEAP'],
  armor: ['ARMO'],
  message: ['MESG'],
  formlist: ['FLST'],
  location: ['LCTN'],
  scene: ['SCEN'],
  topic: ['DIAL'],
  topicinfo: ['INFO'],
  package: ['PACK'],
  static: ['STAT'],
  book: ['BOOK'],
  key: ['KEYM'],
  potion: ['ALCH'],
  perk: ['PERK'],
  race: ['RACE'],
  outfit: ['OTFT'],
  cell: ['CELL'],
  worldspace: ['WRLD'],
  sound: ['SNDR', 'SOUN'],
  voicetype: ['VTYP'],
  ingredient: ['INGR'],
  ammo: ['AMMO'],
  activator: ['ACTI'],
  container: ['CONT'],
  door: ['DOOR'],
  furniture: ['FURN'],
  light: ['LIGH'],
  leveleditem: ['LVLI'],
  leveledactor: ['LVLN'],
  leveledspell: ['LVSP'],
  effectshader: ['EFSH'],
  imagespacemodifier: ['IMAD'],
  idle: ['IDLE'],
  magiceffect: ['MGEF'],
  enchantment: ['ENCH'],
  shout: ['SHOU'],
  wordofpower: ['WOOP'],
  soulgem: ['SLGM'],
  explosion: ['EXPL'],
  hazard: ['HAZD'],
  projectile: ['PROJ'],
  class: ['CLAS'],
  textureset: ['TXST'],
  visualeffect: ['RFCT'],
  weather: ['WTHR'],
  encounterzone: ['ECZN'],
  associationtype: ['ASTP'],
  scroll: ['SCRL'],
  apparatus: ['APPA'],
  musictype: ['MUSC'],
  constructibleobject: ['COBJ'],
  headpart: ['HDPT'],
  colorform: ['CLFM'],
  form: [],
};
