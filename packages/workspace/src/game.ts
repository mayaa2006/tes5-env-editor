/**
 * Game installs, load orders and Mod Organizer 2 instances.
 */
import { readPluginHeader, type GameRelease } from '@tes5/esp';
import { findChild, joinPath, type FileSystem } from './fs';

export interface GameInstall {
  game: GameRelease;
  /** Folder containing SkyrimSE.exe / TESV.exe (may be unknown for a bare Data folder). */
  gameDir?: string;
  dataDir: string;
}

/** Plugins the game always loads first, in this order. */
export const IMPLICIT_PLUGINS: Record<GameRelease, readonly string[]> = {
  SkyrimSE: ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm'],
  SkyrimLE: ['Skyrim.esm', 'Update.esm'],
};

/** Default vanilla archive order (Skyrim.ini sResourceArchiveList + List2). */
export const VANILLA_ARCHIVES: Record<GameRelease, readonly string[]> = {
  SkyrimSE: [
    'Skyrim - Misc.bsa', 'Skyrim - Shaders.bsa', 'Skyrim - Interface.bsa', 'Skyrim - Animations.bsa', 'Skyrim - Meshes0.bsa',
    'Skyrim - Meshes1.bsa', 'Skyrim - Sounds.bsa', 'Skyrim - Voices_en0.bsa', 'Skyrim - Textures0.bsa', 'Skyrim - Textures1.bsa',
    'Skyrim - Textures2.bsa', 'Skyrim - Textures3.bsa', 'Skyrim - Textures4.bsa', 'Skyrim - Textures5.bsa', 'Skyrim - Textures6.bsa',
    'Skyrim - Textures7.bsa', 'Skyrim - Textures8.bsa', 'Skyrim - Patch.bsa',
  ],
  SkyrimLE: [
    'Skyrim - Misc.bsa', 'Skyrim - Shaders.bsa', 'Skyrim - Textures.bsa', 'Skyrim - Interface.bsa', 'Skyrim - Animations.bsa',
    'Skyrim - Meshes.bsa', 'Skyrim - Sounds.bsa', 'Skyrim - Voices.bsa', 'Skyrim - VoicesExtra.bsa', 'Update.bsa',
  ],
};

/** Detect the game from a game folder or its Data folder. */
export async function detectInstall(fs: FileSystem, path: string): Promise<GameInstall | undefined> {
  const tryGameDir = async (dir: string): Promise<GameInstall | undefined> => {
    const data = await findChild(fs, dir, 'Data');
    if (!data) return undefined;
    if (await findChild(fs, dir, 'SkyrimSE.exe')) return { game: 'SkyrimSE', gameDir: dir, dataDir: data };
    if (await findChild(fs, dir, 'TESV.exe')) return { game: 'SkyrimLE', gameDir: dir, dataDir: data };
    if (await findChild(fs, dir, 'SkyrimVR.exe')) return { game: 'SkyrimSE', gameDir: dir, dataDir: data };
    return undefined;
  };
  const direct = await tryGameDir(path);
  if (direct) return direct;
  // Maybe it is the Data folder itself.
  const skyrimEsm = await findChild(fs, path, 'Skyrim.esm');
  if (skyrimEsm) {
    const parent = path.replace(/[\\/]+[^\\/]+[\\/]*$/, '');
    const viaParent = parent && parent !== path ? await tryGameDir(parent) : undefined;
    if (viaParent) return viaParent;
    const header = readPluginHeader(await fs.readFile(skyrimEsm), 'Skyrim.esm');
    return { game: header.header.formVersion >= 44 ? 'SkyrimSE' : 'SkyrimLE', dataDir: path };
  }
  return undefined;
}

/** Folder names Steam and GOG install Skyrim under. */
const GAME_FOLDERS = ['Skyrim Special Edition', 'Skyrim Anniversary Edition', 'Skyrim', 'SkyrimVR', 'The Elder Scrolls V Skyrim Special Edition'];

/** Library folders listed in Steam's libraryfolders.vdf ("path" entries, or the old numbered form). */
export function parseSteamLibraries(vdf: string): string[] {
  const out: string[] = [];
  for (const m of vdf.matchAll(/"(?:path|\d+)"\s+"([^"]+)"/g)) {
    const p = m[1]!.replace(/\\\\/g, '\\');
    if (/[\\/]/.test(p)) out.push(p);
  }
  return out;
}

/**
 * Look for Skyrim installs in the usual places: every Steam library
 * (from Steam's own list), GOG's folders, and common install paths.
 * Returns each install once, Special Edition first.
 */
export async function findInstalls(fs: FileSystem, env: Record<string, string | undefined> = {}): Promise<GameInstall[]> {
  const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const pf = env.ProgramFiles ?? 'C:\\Program Files';
  const home = env.HOME ?? env.USERPROFILE;
  const steamRoots = [joinPath(pf86, 'Steam'), joinPath(pf, 'Steam'), ...(home ? [joinPath(home, '.steam', 'steam'), joinPath(home, '.local', 'share', 'Steam')] : [])];
  const libraries = new Set<string>();
  for (const root of steamRoots) {
    if (!(await fs.exists(root).catch(() => false))) continue;
    libraries.add(root);
    for (const vdf of [joinPath(root, 'steamapps', 'libraryfolders.vdf'), joinPath(root, 'config', 'libraryfolders.vdf')]) {
      try {
        for (const lib of parseSteamLibraries(new TextDecoder().decode(await fs.readFile(vdf)))) libraries.add(lib);
      } catch {
        // no list here
      }
    }
  }
  for (const drive of ['C:', 'D:', 'E:', 'F:']) libraries.add(`${drive}\\SteamLibrary`);
  const candidates: string[] = [];
  for (const lib of libraries) for (const g of GAME_FOLDERS) candidates.push(joinPath(lib, 'steamapps', 'common', g));
  for (const base of ['C:\\GOG Games', joinPath(pf86, 'GOG Galaxy', 'Games'), joinPath(pf86, 'GOG Games')]) for (const g of GAME_FOLDERS) candidates.push(joinPath(base, g));
  const found: GameInstall[] = [];
  const seen = new Set<string>();
  for (const dir of candidates) {
    if (seen.has(dir.toLowerCase())) continue;
    seen.add(dir.toLowerCase());
    if (!(await fs.exists(dir).catch(() => false))) continue;
    const install = await detectInstall(fs, dir).catch(() => undefined);
    if (install && !found.some((f) => f.dataDir.toLowerCase() === install.dataDir.toLowerCase())) found.push(install);
  }
  return found.sort((a, b) => (a.game === b.game ? 0 : a.game === 'SkyrimSE' ? -1 : 1));
}

// ------------------------------------------------------------------ load order

export interface LoadOrderEntry {
  name: string;
  active: boolean;
}

/** Parse plugins.txt (SSE style "*Plugin.esp" for active, or LE style where listed = active). */
export function parsePluginsTxt(text: string, style: 'asterisk' | 'listed' = 'asterisk'): LoadOrderEntry[] {
  const out: LoadOrderEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (style === 'asterisk') {
      const active = line.startsWith('*');
      out.push({ name: active ? line.slice(1) : line, active });
    } else out.push({ name: line, active: true });
  }
  return out;
}

export function writePluginsTxt(entries: readonly LoadOrderEntry[], implicit: readonly string[] = []): string {
  const skip = new Set(implicit.map((s) => s.toLowerCase()));
  const lines = ['# This file is used by Skyrim to keep track of your downloaded content.', '# Please do not modify this file.'];
  for (const e of entries) if (!skip.has(e.name.toLowerCase())) lines.push(`${e.active ? '*' : ''}${e.name}`);
  return lines.join('\r\n') + '\r\n';
}

/** Parse Skyrim.ccc (Creation Club plugin list, one per line). */
export function parseCcc(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/**
 * Build the effective load order: implicit plugins first (if present), then
 * the listed order. Plugins missing from disk are dropped; plugins on disk but
 * not listed are appended inactive.
 */
export function resolveLoadOrder(game: GameRelease, onDisk: readonly string[], listed: readonly LoadOrderEntry[], creationClub: readonly string[] = []): LoadOrderEntry[] {
  const disk = new Map(onDisk.map((n) => [n.toLowerCase(), n]));
  const out: LoadOrderEntry[] = [];
  const seen = new Set<string>();
  const add = (name: string, active: boolean) => {
    const real = disk.get(name.toLowerCase());
    if (!real || seen.has(real.toLowerCase())) return;
    seen.add(real.toLowerCase());
    out.push({ name: real, active });
  };
  for (const n of IMPLICIT_PLUGINS[game]) add(n, true);
  for (const n of creationClub) add(n, true);
  for (const e of listed) add(e.name, e.active);
  for (const n of onDisk) add(n, false);
  return sortMastersFirst(out);
}

/** Master files (.esm/.esl) must load before plain plugins; keep relative order otherwise. */
export function sortMastersFirst(entries: LoadOrderEntry[]): LoadOrderEntry[] {
  const isMaster = (n: string) => /\.(esm|esl)$/i.test(n);
  return [...entries.filter((e) => isMaster(e.name)), ...entries.filter((e) => !isMaster(e.name))];
}

export function isPluginFile(name: string): boolean {
  return /\.(esm|esp|esl)$/i.test(name);
}

// ------------------------------------------------------------------ Mod Organizer 2

export interface Mo2Instance {
  instanceDir: string;
  gamePath?: string;
  gameName?: string;
  baseDir: string;
  modsDir: string;
  profilesDir: string;
  overwriteDir: string;
  selectedProfile?: string;
}

export interface Mo2Profile {
  name: string;
  /** Enabled mods, lowest priority first. */
  mods: string[];
  plugins: LoadOrderEntry[];
  /** Folder roots in priority order (lowest first): game Data, mods..., overwrite. */
  roots: string[];
}

/** Parse a QSettings-style INI (as written by MO2). */
export function parseIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section = 'General';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const s = /^\[(.+)\]$/.exec(line);
    if (s) {
      section = s[1]!;
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const ba = /^@ByteArray\((.*)\)$/.exec(value);
    if (ba) value = ba[1]!;
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    value = value.replace(/\\\\/g, '\\');
    (out[section] ??= {})[key.replace(/\\\\/g, '\\')] = value;
  }
  return out;
}

export async function readMo2Instance(fs: FileSystem, instanceDir: string): Promise<Mo2Instance> {
  const iniPath = await findChild(fs, instanceDir, 'ModOrganizer.ini');
  if (!iniPath) throw new Error(`No ModOrganizer.ini in ${instanceDir}`);
  const ini = parseIni(new TextDecoder().decode(await fs.readFile(iniPath)));
  const general = ini.General ?? {};
  const settings = ini.Settings ?? {};
  const baseDir = (settings.base_directory || instanceDir).replace(/\\/g, '/');
  const sub = (key: string, def: string) => (settings[key] ? settings[key]!.replace(/%BASE_DIR%/gi, baseDir).replace(/\\/g, '/') : joinPath(baseDir, def));
  return {
    instanceDir,
    gamePath: general.gamePath?.replace(/\\/g, '/'),
    gameName: general.gameName,
    baseDir,
    modsDir: sub('mod_directory', 'mods'),
    profilesDir: sub('profiles_directory', 'profiles'),
    overwriteDir: sub('overwrite_directory', 'overwrite'),
    selectedProfile: general.selected_profile,
  };
}

/** modlist.txt lists the highest priority first; "+" enabled, "-" disabled, "*" unmanaged. */
export function parseModlist(text: string): { enabled: string[]; disabled: string[] } {
  const enabled: string[] = [];
  const disabled: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const flag = line[0];
    const name = line.slice(1);
    if (flag === '+') enabled.push(name);
    else if (flag === '-') disabled.push(name);
  }
  enabled.reverse();
  return { enabled, disabled };
}

export async function readMo2Profile(fs: FileSystem, inst: Mo2Instance, profileName?: string): Promise<Mo2Profile> {
  const name = profileName ?? inst.selectedProfile ?? 'Default';
  const dir = joinPath(inst.profilesDir, name);
  const read = async (file: string) => {
    const p = await findChild(fs, dir, file);
    return p ? new TextDecoder().decode(await fs.readFile(p)) : '';
  };
  const { enabled } = parseModlist(await read('modlist.txt'));
  const pluginsTxt = parsePluginsTxt(await read('plugins.txt'));
  const loadorderTxt = (await read('loadorder.txt'))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  // loadorder.txt carries the full order; plugins.txt the active flags.
  const active = new Set(pluginsTxt.filter((p) => p.active).map((p) => p.name.toLowerCase()));
  const ordered = loadorderTxt.length ? loadorderTxt.map((n) => ({ name: n, active: active.has(n.toLowerCase()) })) : pluginsTxt;
  const roots: string[] = [];
  if (inst.gamePath) roots.push(joinPath(inst.gamePath, 'Data'));
  for (const m of enabled) roots.push(joinPath(inst.modsDir, m));
  roots.push(inst.overwriteDir);
  return { name, mods: enabled, plugins: ordered, roots };
}
