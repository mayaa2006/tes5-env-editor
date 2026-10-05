import { FormIdMapper, type FormKey, type Plugin, type PluginRecord } from '@tes5/esp';

/** Access to loaded master files by name (case-insensitive). */
export interface MasterSource {
  get(fileName: string): Plugin | undefined;
}

export class MapMasterSource implements MasterSource {
  private readonly map = new Map<string, Plugin>();
  constructor(plugins: Iterable<Plugin> = []) {
    for (const p of plugins) this.add(p);
  }
  add(p: Plugin): void {
    this.map.set(p.fileName.toLowerCase(), p);
  }
  get(fileName: string): Plugin | undefined {
    return this.map.get(fileName.toLowerCase());
  }
}

export interface MasterRecord {
  plugin: Plugin;
  record: PluginRecord;
}

/** Find a form inside one plugin by its FormKey. */
export function findInPlugin(plugin: Plugin, key: FormKey): PluginRecord | undefined {
  const local = new FormIdMapper(plugin.fileName, plugin.masters).toLocal(key);
  if (local === undefined) return undefined;
  return plugin.getRecord(local);
}

/**
 * All versions of a form among `plugin`'s masters, in master-list order
 * (first = defining file when present).
 */
export function versionsInMasters(plugin: Plugin, record: PluginRecord, masters: MasterSource): MasterRecord[] {
  const key = new FormIdMapper(plugin.fileName, plugin.masters).toKey(record.formId);
  if (!key) return [];
  const out: MasterRecord[] = [];
  for (const name of plugin.masters) {
    const m = masters.get(name);
    if (!m) continue;
    const r = findInPlugin(m, key);
    if (r) out.push({ plugin: m, record: r });
  }
  return out;
}

export function missingMasters(plugin: Plugin, masters: MasterSource): string[] {
  return plugin.masters.filter((m) => !masters.get(m));
}
