import { hex } from './binary';

/**
 * A load-order independent reference to a form: the plugin that defines it plus
 * its 24-bit object ID. Rendered as `012E49:Skyrim.esm`.
 */
export type FormKey = string;

export function makeFormKey(objectId: number, plugin: string): FormKey {
  return `${hex(objectId & 0xffffff, 6)}:${plugin}`;
}

export function parseFormKey(key: FormKey): { objectId: number; plugin: string } {
  const i = key.indexOf(':');
  if (i < 0) throw new Error(`Invalid FormKey "${key}"`);
  return { objectId: parseInt(key.slice(0, i), 16) & 0xffffff, plugin: key.slice(i + 1) };
}

export function isFormKey(s: string): boolean {
  return /^[0-9A-Fa-f]{6}:.+\.(esm|esp|esl)$/i.test(s);
}

export function formatFormId(id: number): string {
  return hex(id, 8);
}

/** Accepts "0001A2B3", "1A2B3", "0x1A2B3" or "[0001A2B3]". */
export function parseFormId(s: string): number {
  const t = s.trim().replace(/^\[|\]$/g, '').replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{1,8}$/.test(t)) throw new Error(`Invalid FormID "${s}"`);
  return parseInt(t, 16) >>> 0;
}

/**
 * Converts between file-local FormIDs (as stored in one plugin) and FormKeys.
 * Every plugin has its own mapper because its master list defines the meaning
 * of the upper byte.
 */
export class FormIdMapper {
  private readonly masterIndex = new Map<string, number>();

  constructor(
    readonly fileName: string,
    readonly masters: readonly string[],
  ) {
    masters.forEach((m, i) => this.masterIndex.set(m.toLowerCase(), i));
  }

  /** Name of the plugin that owns a file-local FormID. */
  ownerOf(localId: number): string {
    const idx = localId >>> 24;
    return idx < this.masters.length ? this.masters[idx]! : this.fileName;
  }

  isOverride(localId: number): boolean {
    return localId >>> 24 < this.masters.length;
  }

  toKey(localId: number): FormKey | null {
    if (localId === 0) return null;
    return makeFormKey(localId & 0xffffff, this.ownerOf(localId));
  }

  /** Returns undefined if the owning plugin is not among this plugin's masters. */
  toLocal(key: FormKey): number | undefined {
    const { objectId, plugin } = parseFormKey(key);
    if (plugin.toLowerCase() === this.fileName.toLowerCase()) return ((this.masters.length << 24) | objectId) >>> 0;
    const i = this.masterIndex.get(plugin.toLowerCase());
    if (i === undefined) return undefined;
    return ((i << 24) | objectId) >>> 0;
  }

  /** Hard-coded engine forms (object IDs below 0x800 in Skyrim.esm) are valid with any index. */
  static isHardcoded(localId: number): boolean {
    return (localId & 0xffffff) < 0x800 && localId >>> 24 === 0;
  }
}

/** A plugin's slot in the active load order. */
export interface LoadOrderSlot {
  fileName: string;
  light: boolean;
  /** Full-plugin index (0x00–0xFD) or light index (0x000–0xFFF). */
  index: number;
}

/** Assign runtime slots like the game does: light plugins share 0xFE. */
export function assignLoadOrderSlots(plugins: readonly { fileName: string; light: boolean }[]): LoadOrderSlot[] {
  let full = 0;
  let light = 0;
  return plugins.map((p) => {
    if (p.light) return { fileName: p.fileName, light: true, index: light++ };
    return { fileName: p.fileName, light: false, index: full++ };
  });
}

/** The FormID the game shows in the console for a form. */
export function runtimeFormId(slot: LoadOrderSlot, objectId: number): number {
  if (slot.light) return ((0xfe << 24) | ((slot.index & 0xfff) << 12) | (objectId & 0xfff)) >>> 0;
  return ((slot.index << 24) | (objectId & 0xffffff)) >>> 0;
}
