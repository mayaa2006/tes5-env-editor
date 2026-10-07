/**
 * BodySlide inside the editor: reads the slider sets, presets and shape data
 * mods ship in `CalienteTools\BodySlide\`, shapes a body from slider values,
 * previews it, and builds the meshes the game loads.
 *
 *   SliderSets\*.osp      XML: the source mesh, where the result goes, and each slider's morphs
 *   SliderPresets\*.xml   XML: named slider values (a small and a big value for each slider)
 *   ShapeData\<folder>\   the morphs themselves (.osd, or one .bsd per morph)
 *
 * Like BodySlide, a build writes two meshes: `<name>_0.nif` (every slider at
 * its "small" value, the 0 weight) and `<name>_1.nif` (at its "big" value,
 * the 100 weight); the game blends between them with the character's weight.
 * A slider's value is a percent of its morph (100 = the whole morph).
 *
 * Everything is written into the mod's output folder, as one undo step.
 */
import { applyTransform, nifShapes, parseBsd, parseOsd, readNifDoc, setShapePositions, vertexNormals, writeNifDoc, type NifDoc, type ShapeDiff, type Transform } from '@tes5/assets';
import { WorkspaceError, type Workspace } from './engine';
import { findChild, joinPath, type DirEntry } from './fs';
import { decodeXmlBytes, escapeXml, parseXml, xmlAttr, xmlChild, xmlChildren, type XmlElement } from './xml';

export interface SliderValue {
  small: number;
  big: number;
}
export type SliderValues = Record<string, SliderValue>;

export interface SliderInfo {
  name: string;
  /** What to show: "BreastsSmall" → "Breasts Small". */
  label: string;
  /** The slider acts backwards (100 = no morph). */
  invert: boolean;
  /** Values the set starts at (percent). */
  defaults: SliderValue;
  /** The slider has no morph data (it only exists in the file), so it does nothing. */
  empty: boolean;
}

export interface SliderSetInfo {
  name: string;
  /** Path of the .osp file. */
  file: string;
  sliders: number;
  /** Shapes the set changes. */
  shapes: string[];
  /** The mesh it starts from (relative to Data). */
  source: string;
  /** Where a build puts the result: folder and file name (without _0 / _1). */
  output: { folder: string; file: string };
  /** Why the set can't be used, if it can't. */
  problem?: string;
}

export interface PresetInfo {
  name: string;
  file: string;
  /** Sets it was made for (empty: any). */
  sets: string[];
  values: SliderValues;
}

export interface BodyPreview {
  /** Every shape, in file space (skin transforms applied), ready to draw. */
  shapes: { name: string; positions: Float32Array; normals: Float32Array; indices: Uint16Array | Uint32Array }[];
}

export interface BodyBuildResult {
  files: string[];
  warnings: string[];
}

interface SliderDef {
  info: SliderInfo;
  data: { name: string; target: string; local: boolean; file: string }[];
}

interface ParsedSet {
  info: SliderSetInfo;
  dataFolder: string;
  defs: SliderDef[];
}

interface LoadedSet extends ParsedSet {
  doc: NifDoc;
  source: Uint8Array;
  base: { name: string; positions: Float32Array; indices: Uint16Array | Uint32Array; placement: Transform }[];
  /** Slider → the diff to add on each shape. */
  diffs: Map<string, { shape: string; diff: ShapeDiff }[]>;
  warnings: string[];
}

const TOOL_DIR = ['CalienteTools', 'BodySlide'];

const num = (s: string | undefined, fallback: number) => {
  const v = s === undefined || s === '' ? NaN : Number(s);
  return Number.isFinite(v) ? v : fallback;
};
const truthy = (s: string | undefined) => s !== undefined && /^(true|1|yes)$/i.test(s.trim());

export function sliderLabel(name: string): string {
  return name
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

const normPath = (p: string) => p.replace(/\//g, '\\').replace(/^\\+/, '');

export class BodySlideService {
  private cache = new Map<string, LoadedSet>();
  private sets = new Map<string, ParsedSet>();

  constructor(readonly ws: Workspace) {
    ws.on((e) => {
      if (e.type !== 'filesRestored') return;
      const root = this.ws.options.outputDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      for (const f of e.files) {
        const p = f.path.replace(/\\/g, '/');
        if (!p.toLowerCase().startsWith(`${root}/`)) continue;
        const rel = p.slice(root.length + 1).replace(/\//g, '\\');
        if (!/\.nif$/i.test(rel)) continue;
        if (f.data) this.ws.vfs.addLoose(this.ws.options.outputDir, rel);
        else this.ws.vfs.removeLoose(this.ws.options.outputDir, rel);
      }
    });
  }

  // ---------------------------------------------------------------- finding files

  /** Every folder that can hold BodySlide data, highest priority first. */
  private roots(): string[] {
    const all = [...this.ws.options.roots];
    const out = this.ws.options.outputDir;
    if (!all.some((r) => r.toLowerCase() === out.toLowerCase())) all.push(out);
    return all.reverse();
  }

  private async dirIn(root: string, parts: string[]): Promise<string | undefined> {
    let cur = root;
    for (const p of parts) {
      const next = await findChild(this.ws.fs, cur, p);
      if (!next) return undefined;
      cur = next;
    }
    return cur;
  }

  /** The BodySlide folders for a sub-path, across every root, highest priority first. */
  private async toolDirs(...sub: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const r of this.roots()) {
      const d = await this.dirIn(r, [...TOOL_DIR, ...sub]);
      if (d) out.push(d);
    }
    return out;
  }

  /** Files by name across roots (a higher-priority copy hides a lower one). */
  private async toolFiles(sub: string, ext: RegExp): Promise<{ name: string; path: string }[]> {
    const seen = new Map<string, { name: string; path: string }>();
    for (const dir of await this.toolDirs(sub)) {
      let entries: DirEntry[] = [];
      try {
        entries = await this.ws.fs.readdir(dir);
      } catch {
        continue;
      }
      for (const e of entries) if (!e.isDirectory && ext.test(e.name) && !seen.has(e.name.toLowerCase())) seen.set(e.name.toLowerCase(), { name: e.name, path: joinPath(dir, e.name) });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------------------------------------------------------------- sets

  private parseSets(file: string, xml: XmlElement): ParsedSet[] {
    const out: ParsedSet[] = [];
    const nodes = xml.name.toLowerCase() === 'slidersetinfo' ? xml.children : [xml];
    for (const set of nodes.filter((n) => n.name.toLowerCase() === 'sliderset')) {
      const name = xmlAttr(set, 'name');
      if (!name) continue;
      const dataFolder = xmlChild(set, 'DataFolder')?.text ?? '';
      const source = normPath(xmlChild(set, 'SourceFile')?.text ?? '');
      const folder = normPath(xmlChild(set, 'OutputPath')?.text ?? '');
      const outFile = (xmlChild(set, 'OutputFile')?.text ?? '').replace(/_[01]$/, '');
      const shapes = [...new Set(xmlChildren(set, 'Shape').map((s) => xmlAttr(s, 'target') ?? s.text).filter(Boolean))];
      const defs: SliderDef[] = xmlChildren(set, 'Slider').map((s) => {
        const sname = xmlAttr(s, 'name') ?? '';
        const dflt = num(xmlAttr(s, 'default'), 0);
        const data = xmlChildren(s, 'Data').map((d) => ({ name: xmlAttr(d, 'name') ?? sname, target: xmlAttr(d, 'target') ?? '', local: truthy(xmlAttr(d, 'local')), file: d.text }));
        return {
          info: { name: sname, label: sliderLabel(sname), invert: truthy(xmlAttr(s, 'invert')), defaults: { small: num(xmlAttr(s, 'small'), dflt), big: num(xmlAttr(s, 'big'), xmlAttr(s, 'small') === undefined && dflt ? dflt : 0) }, empty: !data.length },
          data,
        };
      });
      let problem: string | undefined;
      if (!source) problem = 'The set names no source mesh';
      else if (!outFile) problem = 'The set names no output file';
      const info: SliderSetInfo = { name, file, sliders: defs.length, shapes, source, output: { folder, file: outFile }, problem };
      out.push({ info, dataFolder, defs });
    }
    return out;
  }

  /** Every slider set found (and whether it's usable). Rescans the folders. */
  async list(): Promise<SliderSetInfo[]> {
    await this.ws.filesSettled();
    this.cache.clear();
    this.sets.clear();
    for (const f of await this.toolFiles('SliderSets', /\.osp$/i)) {
      try {
        for (const s of this.parseSets(f.path, parseXml(decodeXmlBytes(await this.ws.fs.readFile(f.path))))) if (!this.sets.has(s.info.name.toLowerCase())) this.sets.set(s.info.name.toLowerCase(), s);
      } catch {
        // an unreadable .osp is skipped
      }
    }
    for (const s of this.sets.values()) if (!s.info.problem && !this.ws.vfs.has(meshPath(s.info.source))) s.info.problem = `The source mesh ${s.info.source} isn’t in your Data folder`;
    return [...this.sets.values()].map((s) => s.info).sort((a, b) => a.name.localeCompare(b.name));
  }

  private async parsed(setName: string): Promise<ParsedSet> {
    if (!this.sets.size) await this.list();
    const s = this.sets.get(setName.toLowerCase());
    if (!s) throw new WorkspaceError(`No BodySlide set called “${setName}”`);
    return s;
  }

  async sliders(setName: string): Promise<SliderInfo[]> {
    return (await this.parsed(setName)).defs.map((d) => d.info);
  }

  /** The values a set starts at. */
  async defaults(setName: string): Promise<SliderValues> {
    return Object.fromEntries((await this.parsed(setName)).defs.map((d) => [d.info.name, { ...d.info.defaults }]));
  }

  // ---------------------------------------------------------------- presets

  async presets(setName?: string): Promise<PresetInfo[]> {
    await this.ws.filesSettled();
    const out: PresetInfo[] = [];
    for (const f of await this.toolFiles('SliderPresets', /\.xml$/i)) {
      let xml: XmlElement;
      try {
        xml = parseXml(decodeXmlBytes(await this.ws.fs.readFile(f.path)));
      } catch {
        continue;
      }
      for (const p of xml.name.toLowerCase() === 'presets' || xml.name.toLowerCase() === 'sliderpresets' ? xmlChildren(xml, 'Preset') : [xml]) {
        const name = xmlAttr(p, 'name');
        if (!name) continue;
        const sets = [xmlAttr(p, 'set'), ...xmlChildren(p, 'Set').map((s) => xmlAttr(s, 'name'))].filter((x): x is string => !!x);
        if (setName && sets.length && !sets.some((s) => s.toLowerCase() === setName.toLowerCase())) continue;
        const values: SliderValues = {};
        for (const s of xmlChildren(p, 'SetSlider')) {
          const sname = xmlAttr(s, 'name');
          if (!sname) continue;
          const v = num(xmlAttr(s, 'value'), 0);
          const size = (xmlAttr(s, 'size') ?? '').toLowerCase();
          const cur = (values[sname] ??= { small: 0, big: 0 });
          if (size === 'small') cur.small = v;
          else if (size === 'big') cur.big = v;
          else {
            cur.small = v;
            cur.big = v;
          }
        }
        out.push({ name, file: f.path, sets, values });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Save values as a preset other BodySlide users (and this editor) can load. One undo step. */
  async savePreset(name: string, setName: string, values: SliderValues): Promise<PresetInfo> {
    const clean = name.trim().replace(/[\\/:*?"<>|]+/g, '_');
    if (!clean) throw new WorkspaceError('Give the preset a name');
    const parsed = await this.parsed(setName);
    const known = new Set(parsed.defs.map((d) => d.info.name));
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<SliderPresets>', `\t<Preset name="${escapeXml(clean)}" set="${escapeXml(parsed.info.name)}">`];
    for (const [sname, v] of Object.entries(values)) {
      if (!known.has(sname)) continue;
      lines.push(`\t\t<SetSlider name="${escapeXml(sname)}" size="small" value="${Math.round(v.small)}"/>`);
      lines.push(`\t\t<SetSlider name="${escapeXml(sname)}" size="big" value="${Math.round(v.big)}"/>`);
    }
    lines.push('\t</Preset>', '</SliderPresets>', '');
    const rel = ['CalienteTools', 'BodySlide', 'SliderPresets', `${clean}.xml`];
    const path = joinPath(this.ws.options.outputDir, ...rel);
    await this.ws.transactionAsync(`Save body preset ${clean}`, async () => {
      await this.writeTracked(path, new TextEncoder().encode(lines.join('\r\n')), rel.slice(0, -1));
    });
    const saved = (await this.presets(setName)).find((p) => p.name === clean);
    return saved ?? { name: clean, file: path, sets: [parsed.info.name], values };
  }

  // ---------------------------------------------------------------- shaping

  private async load(setName: string): Promise<LoadedSet> {
    const key = setName.toLowerCase();
    const hit = this.cache.get(key);
    if (hit) return hit;
    const parsed = await this.parsed(setName);
    if (parsed.info.problem) throw new WorkspaceError(`${parsed.info.name}: ${parsed.info.problem}`);
    const source = await this.ws.vfs.read(meshPath(parsed.info.source));
    const doc = readNifDoc(source);
    const warnings: string[] = [];
    const shapes = nifShapes(doc).map((s) => ({ name: s.name, positions: s.positions, indices: s.indices, placement: s.placement }));
    const shapeByName = new Map(shapes.map((s) => [s.name.toLowerCase(), s]));
    // Morph data: one .osd per set (or several in the folder), or a .bsd per morph.
    const osd = new Map<string, ShapeDiff>();
    const folders = await this.toolDirs('ShapeData', parsed.dataFolder);
    for (const dir of [...folders].reverse()) {
      let entries: DirEntry[] = [];
      try {
        entries = await this.ws.fs.readdir(dir);
      } catch {
        continue;
      }
      for (const e of entries)
        if (!e.isDirectory && /\.osd$/i.test(e.name))
          try {
            for (const [k, v] of parseOsd(await this.ws.fs.readFile(joinPath(dir, e.name)))) osd.set(k.toLowerCase(), v);
          } catch (err) {
            warnings.push(`${e.name}: ${(err as Error).message}`);
          }
    }
    const diffs = new Map<string, { shape: string; diff: ShapeDiff }[]>();
    for (const def of parsed.defs) {
      const list: { shape: string; diff: ShapeDiff }[] = [];
      for (const d of def.data) {
        let diff: ShapeDiff | undefined;
        if (d.file && /\.bsd$/i.test(d.file)) {
          for (const dir of folders) {
            const f = await findChild(this.ws.fs, dir, d.file);
            if (f)
              try {
                diff = parseBsd(await this.ws.fs.readFile(f));
                break;
              } catch (err) {
                warnings.push(`${d.file}: ${(err as Error).message}`);
              }
          }
        }
        diff ??= osd.get(d.name.toLowerCase()) ?? osd.get(`${d.name}${d.target}`.toLowerCase()) ?? osd.get(`${d.target}${d.name}`.toLowerCase());
        if (!diff) {
          warnings.push(`${def.info.name}: no morph data named “${d.name}” was found`);
          continue;
        }
        const target = d.target || parsed.info.shapes[0] || '';
        const shape = shapeByName.get(target.toLowerCase());
        if (!shape) {
          warnings.push(`${def.info.name}: the mesh has no shape called “${target}”`);
          continue;
        }
        const max = shape.positions.length / 3;
        if (diff.indices.some((i) => i >= max)) {
          warnings.push(`${def.info.name}: its morph doesn’t fit shape “${shape.name}” (it changes vertices the shape doesn’t have)`);
          continue;
        }
        list.push({ shape: shape.name, diff });
      }
      diffs.set(def.info.name, list);
    }
    const loaded: LoadedSet = { ...parsed, doc, source, base: shapes, diffs, warnings };
    if (this.cache.size > 8) this.cache.clear();
    this.cache.set(key, loaded);
    return loaded;
  }

  /** Warnings found while reading a set (missing morph data and the like). */
  async check(setName: string): Promise<string[]> {
    return (await this.load(setName)).warnings;
  }

  /** Shape positions (shape-local, as stored) for slider percentages. */
  private shape(set: LoadedSet, percent: (slider: string) => number): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    for (const b of set.base) out.set(b.name, b.positions.slice());
    for (const def of set.defs) {
      let f = percent(def.info.name) / 100;
      if (def.info.invert) f = 1 - f;
      if (!f) continue;
      for (const { shape, diff } of set.diffs.get(def.info.name) ?? []) {
        const pos = out.get(shape);
        if (!pos) continue;
        for (let k = 0; k < diff.indices.length; k++) {
          const v = diff.indices[k]! * 3;
          pos[v] += diff.deltas[k * 3]! * f;
          pos[v + 1] += diff.deltas[k * 3 + 1]! * f;
          pos[v + 2] += diff.deltas[k * 3 + 2]! * f;
        }
      }
    }
    return out;
  }

  /**
   * The body at one weight (0 = every slider at its small value, 1 = at its
   * big value, anything between mixes them), for the 3D view.
   */
  async preview(setName: string, values: SliderValues, weight = 1): Promise<BodyPreview> {
    const set = await this.load(setName);
    const w = Math.max(0, Math.min(1, weight));
    const pos = this.shape(set, (n) => {
      const v = values[n] ?? set.defs.find((d) => d.info.name === n)?.info.defaults ?? { small: 0, big: 0 };
      return v.small + (v.big - v.small) * w;
    });
    return {
      shapes: set.base.map((b) => {
        const local = pos.get(b.name)!;
        const placed = applyTransform(b.placement, local);
        return { name: b.name, positions: placed, normals: vertexNormals(placed, b.indices), indices: b.indices };
      }),
    };
  }

  // ---------------------------------------------------------------- building

  private async writeTracked(path: string, data: Uint8Array, dirParts: string[]): Promise<void> {
    let before: Uint8Array | null = null;
    try {
      before = await this.ws.fs.readFile(path);
    } catch {
      before = null;
    }
    await this.ws.fs.mkdir(joinPath(this.ws.options.outputDir, ...dirParts));
    await this.ws.fs.writeFile(path, data);
    this.ws.trackFileChange({ path, before, after: data });
  }

  /**
   * Build the 0 and 1 weight meshes into the mod's folder, as BodySlide does.
   * `output` overrides where they go (folder relative to Data, and file name
   * without _0 / _1).
   */
  async build(setName: string, values: SliderValues, output?: { folder?: string; file?: string }): Promise<BodyBuildResult> {
    const set = await this.load(setName);
    const folder = normPath(output?.folder ?? set.info.output.folder);
    const file = (output?.file ?? set.info.output.file).replace(/\.nif$/i, '').replace(/_[01]$/, '');
    if (!file) throw new WorkspaceError('Give the output file a name');
    if (/\.\./.test(folder) || /\.\./.test(file) || /[\\/]/.test(file)) throw new WorkspaceError('The output name can’t go outside the Data folder');
    const files: string[] = [];
    await this.ws.transactionAsync(`Build body ${set.info.name}`, async () => {
      for (const weight of [0, 1] as const) {
        const pos = this.shape(set, (n) => {
          const v = values[n] ?? set.defs.find((d) => d.info.name === n)?.info.defaults ?? { small: 0, big: 0 };
          return weight ? v.big : v.small;
        });
        const doc = readNifDoc(set.source);
        for (const s of nifShapes(doc)) {
          const p = pos.get(s.name);
          if (p) setShapePositions(doc, s.block, p);
        }
        const rel = joinPath(folder, `${file}_${weight}.nif`).replace(/\//g, '\\');
        const parts = rel.split('\\');
        await this.writeTracked(joinPath(this.ws.options.outputDir, ...parts), writeNifDoc(doc), parts.slice(0, -1));
        this.ws.vfs.addLoose(this.ws.options.outputDir, rel);
        files.push(rel);
      }
    });
    return { files, warnings: set.warnings };
  }
}

function meshPath(p: string): string {
  const n = normPath(p).toLowerCase();
  return n.startsWith('meshes\\') ? n : `meshes\\${n}`;
}
