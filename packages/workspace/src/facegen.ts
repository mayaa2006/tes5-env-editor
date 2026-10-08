/**
 * FaceGen without the Creation Kit: bakes each character's head mesh and face
 * tint, the two files the game loads for an NPC's face —
 *
 *   meshes\actors\character\facegendata\facegeom\<plugin>\<id>.nif
 *   textures\actors\character\facegendata\facetint\<plugin>\<id>.dds
 *
 * The mesh is the NPC's head parts (and their extra parts) with every slider,
 * extra morph and region shape baked in, merged under one
 * `BSFaceGenNiNodeSkinned` root the way the CK exports it; vertex order is
 * kept so the game's expression morphs still line up. Hair, brow and beard
 * shaders get the hair colour; the head gets the NPC's face texture set and
 * points at its tint. The tint is the race's tint masks painted with the
 * NPC's tint layers over their skin tone.
 *
 * Things the record can't hold (sliders past ±1, extra morphs, region
 * shaping) are kept in the editor's sidecar `TES5EnvEditor/<plugin>.faces.json`
 * and change with undo like everything else.
 */
import { CHARGEN_SLIDER_MORPHS, SKINNY_MORPH, applyTransform, decodeToRgba, invertTransform, mergeShapes, nifShapes, parseDds, parseTri, readNifDoc, setShapePositions, setShapeTexture, setShapeTint, shapeShaderType, writeBc3Dds, writeNifDoc, type NifDoc, type TriFile } from '@tes5/assets';
import { parseFormKey, type FormKey } from '@tes5/esp';
import { WorkspaceError, type Workspace } from './engine';
import { FaceShaper, emptySculpt, faceLookFor, sculptIsEmpty, type FaceSculpt, type ShaperTri } from './faceshape';
import type { HeadPartInfo, NpcAppearance, NpcService } from './npc';
import { joinPath } from './fs';

export interface RaceTintMask {
  index: number;
  /** Texture path relative to Data (textures\…). */
  mask: string;
  /** A readable name from the mask file ("Cheeks", "Warpaint 03"). */
  name: string;
  /** TINP mask type (6 = skin tone). */
  type: number;
}

/** A character's face files, for the export list. */
export interface FaceFileStatus {
  npc: FormKey;
  editorId?: string;
  name?: string;
  /**
   * ok: files match the look · outdated: files are older than the look ·
   * missing: no files yet · template: looks come from a template (no files needed) ·
   * noHead: no head mesh, so there's nothing to build.
   */
  status: 'ok' | 'outdated' | 'missing' | 'template' | 'noHead';
  /** True when the plugin changes this face (new characters, or overrides that edit the look). */
  edited: boolean;
  template?: FormKey;
  mesh: string;
  tint: string;
}

export interface FaceGenOutput {
  npc: FormKey;
  mesh: string;
  tint: string;
  warnings: string[];
}

/** One head part ready for shaping and baking. */
interface LoadedPart {
  info: HeadPartInfo;
  doc: NifDoc;
  /** Main shape (the one the TRIs belong to) and every shape with its transform. */
  shapes: ReturnType<typeof nifShapes>;
  tris: ShaperTri[];
}

const SIDECAR_VERSION = 1;
const TINT_SIZE = 512;

function meshPath(p: string): string {
  const n = p.toLowerCase().replace(/\//g, '\\');
  return n.startsWith('meshes\\') ? n : `meshes\\${n}`;
}
function texturePath(p: string): string {
  const n = p.toLowerCase().replace(/\//g, '\\');
  return n.startsWith('textures\\') ? n : `textures\\${n}`;
}

/** "Actors\Character\Character Assets\TintMasks\MaleUpperEyeSocket.dds" → "Upper Eye Socket". */
export function tintMaskName(path: string): string {
  const file = (path.split(/[\\/]/).pop() ?? path).replace(/\.dds$/i, '');
  const name = file
    .replace(/^(male|female)/i, '')
    .replace(/^head(?=.)/i, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .trim();
  return name ? name[0]!.toUpperCase() + name.slice(1) : file;
}

export class FaceGenService {
  constructor(
    readonly ws: Workspace,
    readonly npcs: NpcService,
  ) {
    // Undo/redo of a generate puts the old files back (or removes new ones): keep Data's index in step.
    ws.on((e) => {
      if (e.type !== 'filesRestored') return;
      const root = this.ws.options.outputDir.replace(/\\/g, '/').replace(/\/+$/, '');
      for (const f of e.files) {
        const p = f.path.replace(/\\/g, '/');
        if (!p.toLowerCase().startsWith(`${root.toLowerCase()}/`) || !/facegendata/i.test(p)) continue;
        const rel = p.slice(root.length + 1).replace(/\//g, '\\');
        if (f.data) this.ws.vfs.addLoose(this.ws.options.outputDir, rel);
        else this.ws.vfs.removeLoose(this.ws.options.outputDir, rel);
      }
    });
  }

  // ---------------------------------------------------------------- sidecar

  private sidecarPath(): string {
    return joinPath(this.ws.options.outputDir, 'TES5EnvEditor', `${this.ws.activeName ?? 'plugin'}.faces.json`);
  }

  private async readSidecar(): Promise<{ version: number; sculpts: Record<string, FaceSculpt>; baked: Record<string, string> }> {
    await this.ws.filesSettled();
    try {
      const j = JSON.parse(new TextDecoder().decode(await this.ws.fs.readFile(this.sidecarPath())));
      return { version: SIDECAR_VERSION, sculpts: j.sculpts ?? {}, baked: j.baked ?? {} };
    } catch {
      return { version: SIDECAR_VERSION, sculpts: {}, baked: {} };
    }
  }

  private async writeSidecar(s: { version: number; sculpts: Record<string, FaceSculpt>; baked: Record<string, string> }): Promise<void> {
    const path = this.sidecarPath();
    let before: Uint8Array | null = null;
    try {
      before = await this.ws.fs.readFile(path);
    } catch {
      before = null;
    }
    const after = new TextEncoder().encode(JSON.stringify(s, null, 1));
    await this.ws.fs.mkdir(joinPath(this.ws.options.outputDir, 'TES5EnvEditor'));
    await this.ws.fs.writeFile(path, after);
    this.ws.trackFileChange({ path, before, after });
  }

  async sculpt(npc: FormKey): Promise<FaceSculpt> {
    const s = (await this.readSidecar()).sculpts[npc];
    return s ? { ...emptySculpt(), ...structuredClone(s) } : emptySculpt();
  }

  /**
   * Change a character's look — record fields and the extra shaping — as one
   * undo step. Sliders past ±1 are clamped in the record and kept in full in
   * the sidecar.
   */
  async setLook(npc: FormKey, appearance: Partial<NpcAppearance>, sculpt?: FaceSculpt): Promise<void> {
    await this.ws.transactionAsync('Edit character look', async () => {
      const a = { ...appearance };
      if (a.morphs) a.morphs = Object.fromEntries(Object.entries(a.morphs).map(([k, v]) => [k, Math.max(-1, Math.min(1, v))])) as NpcAppearance['morphs'];
      if (Object.keys(a).length) this.npcs.setAppearance(npc, a);
      if (sculpt) {
        const side = await this.readSidecar();
        const clean = this.cleanSculpt(sculpt);
        if (sculptIsEmpty(clean)) delete side.sculpts[npc];
        else side.sculpts[npc] = clean;
        await this.writeSidecar(side);
      }
    });
  }

  private cleanSculpt(s: FaceSculpt): FaceSculpt {
    const nz = <T extends Record<string, number | undefined>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => !!v && Number.isFinite(v))) as T;
    const regions: FaceSculpt['regions'] = {};
    for (const [r, shape] of Object.entries(s.regions ?? {})) {
      const c = nz(shape ?? {});
      if (Object.keys(c).length) regions[r as keyof FaceSculpt['regions']] = c;
    }
    // Extended values only matter outside ±1 (inside, the record holds them).
    const extended = Object.fromEntries(Object.entries(nz(s.extended ?? {})).filter(([, v]) => Math.abs(v!) > 1)) as FaceSculpt['extended'];
    return { extended, morphs: nz(s.morphs ?? {}), regions };
  }

  // ---------------------------------------------------------------- inputs

  /** Head parts the face is made of: the race defaults, replaced by the NPC's own, with extra parts. */
  headPartsOf(npc: FormKey): HeadPartInfo[] {
    return this.npcs.faceParts(npc);
  }

  /** The race's tint masks for one sex (from the RACE head data). */
  raceTintMasks(race: FormKey | null, female: boolean): RaceTintMask[] {
    if (!race) return [];
    const v = this.ws.versions(race);
    const rec = v[v.length - 1]?.record;
    if (!rec) return [];
    const out: RaceTintMask[] = [];
    let inHead = false;
    let sex: 'm' | 'f' | undefined;
    let cur: Partial<RaceTintMask> | undefined;
    const td = new TextDecoder('latin1');
    for (const s of rec.subrecords) {
      if (s.sig === 'NAM0') inHead = true;
      else if (inHead && s.sig === 'MNAM') sex = 'm';
      else if (inHead && s.sig === 'FNAM') sex = 'f';
      if (!inHead || sex !== (female ? 'f' : 'm')) continue;
      const dv = new DataView(s.data.buffer, s.data.byteOffset, s.data.byteLength);
      if (s.sig === 'TINI' && s.data.byteLength >= 2) {
        cur = { index: dv.getUint16(0, true), type: 0 };
      } else if (s.sig === 'TINT' && cur) {
        const raw = td.decode(s.data).replace(/\0+$/, '');
        cur.mask = texturePath(raw);
        cur.name = tintMaskName(raw);
        out.push(cur as RaceTintMask);
      } else if (s.sig === 'TINP' && cur && s.data.byteLength >= 2) {
        cur.type = dv.getUint16(0, true);
      }
    }
    return out;
  }

  private async loadPart(info: HeadPartInfo, warnings: string[]): Promise<LoadedPart | undefined> {
    if (!info.model) return undefined;
    const path = meshPath(info.model);
    if (!this.ws.vfs.has(path)) {
      warnings.push(`${info.editorId ?? info.formKey}: mesh ${path} not found`);
      return undefined;
    }
    let doc: NifDoc;
    try {
      doc = readNifDoc(await this.ws.vfs.read(path));
    } catch (e) {
      warnings.push(`${info.editorId ?? info.formKey}: ${(e as Error).message}`);
      return undefined;
    }
    const shapes = nifShapes(doc);
    if (!shapes.length) {
      warnings.push(`${info.editorId ?? info.formKey}: ${path} has no shapes`);
      return undefined;
    }
    const tris: ShaperTri[] = [];
    // Race morphs (0) and chargen morphs (2). Of the expression TRI (1) only SkinnyMorph is
    // baked (body weight, as the CK does); expressions stay live in game.
    for (const t of info.tris) {
      if (!t.file) continue;
      const tp = meshPath(t.file);
      if (!this.ws.vfs.has(tp)) {
        if (t.type !== 1) warnings.push(`${info.editorId ?? info.formKey}: ${tp} not found, its sliders won't apply`);
        continue;
      }
      try {
        const tri = parseTri(await this.ws.vfs.read(tp));
        if (t.type === 1) tris.push({ ...tri, morphs: tri.morphs.filter((m) => m.name === SKINNY_MORPH), kind: 'expression' });
        else tris.push({ ...tri, kind: t.type === 0 ? 'race' : 'chargen' });
      } catch (e) {
        warnings.push(`${tp}: ${(e as Error).message}`);
      }
    }
    return { info, doc, shapes, tris };
  }

  /** The shape a part's TRIs belong to: the first one with the TRI's vertex count. */
  private morphShape(p: LoadedPart) {
    const n = p.tris[0]?.vertices.length;
    return (n !== undefined ? p.shapes.find((s) => s.positions.length === n) : undefined) ?? p.shapes[0]!;
  }

  // ---------------------------------------------------------------- baking

  /** Bake one NPC's FaceGen mesh and tint (nothing is written). */
  async bake(npc: FormKey, look?: { appearance?: NpcAppearance; sculpt?: FaceSculpt }): Promise<{ nif: Uint8Array; dds: Uint8Array; warnings: string[] }> {
    const a = look?.appearance ?? this.npcs.appearance(npc);
    const sculpt = look?.sculpt ?? (await this.sculpt(npc));
    const warnings: string[] = [];
    const parts: LoadedPart[] = [];
    for (const info of this.headPartsOf(npc)) {
      const p = await this.loadPart(info, warnings);
      if (p) parts.push(p);
    }
    if (!parts.some((p) => p.info.type === 'Face')) throw new WorkspaceError(`${this.ws.summary(npc)?.editorId ?? npc} has no head (Face) part with a mesh, so there's nothing to bake. Pick a head on the Head page first.`);
    const game = parts[0]!.doc.bsVersion;
    for (const p of parts) if (p.doc.bsVersion !== game) warnings.push(`${p.info.editorId}: mixes ${p.doc.bsVersion === 100 ? 'SE' : 'LE'} and ${game === 100 ? 'SE' : 'LE'} meshes; the game may reject the face`);

    // Shape every part together, in file (model) space.
    const shaper = new FaceShaper(
      parts.map((p) => {
        const s = this.morphShape(p);
        return { key: p.info.formKey, type: p.info.type, positions: applyTransform(s.placement, s.positions), tris: p.tris.filter((t) => t.vertices.length === s.positions.length) };
      }),
    );
    const race = this.npcs.raceHeadData(a.race, a.female);
    const shaped = shaper.shape(faceLookFor(a, race, sculpt));
    for (const p of parts) {
      const s = this.morphShape(p);
      const model = shaped.get(p.info.formKey);
      if (model) setShapePositions(p.doc, s.block, applyTransform(invertTransform(s.placement), model));
    }

    // The CK's order: the race's parts in reverse, then the character's own in reverse, each part's extra parts just before it.
    const order = this.ckOrder(npc, parts);
    const paths = this.npcs.faceGenPaths(npc);
    const fileName = (paths.mesh.split('\\').pop() ?? '').toUpperCase();
    const merged = mergeShapes(
      order.map((p) => ({ doc: p.doc, shapes: p.shapes.map((s, i) => ({ block: s.block, transform: s.transform, name: i === 0 ? (p.info.editorId ?? s.name) : undefined })) })),
      { rootName: fileName, bsVersion: game, userVersion: parts[0]!.doc.userVersion, layout: 'facegen' },
    );

    // Colours and textures, as the CK writes them (texture set paths as stored, without "textures\").
    // No hair colour of their own: the race's default for their sex.
    const hairKey = a.hairColor ?? race.hairColor;
    const hair = hairKey ? (this.ws.view(hairKey)?.data as any)?.color : undefined;
    // The head's textures in layers: the race's default face, then the head part's own set, then the character's.
    const faceLayers = [race.faceTexture, parts.find((p) => p.info.type === 'Face')?.info.textureSet ?? null, a.headTexture].filter((k): k is FormKey => !!k);
    const shapeBlocks = this.mergedShapeBlocks(merged);
    let k = 0;
    for (const p of order) {
      const layered = (keys: FormKey[]) => {
        const sets = keys.map((x) => this.textureSet(x)).filter((x): x is string[] => !!x);
        return sets.length ? sets.reduce((acc, t) => acc.map((v, i) => t[i] || v)) : undefined;
      };
      const partTex = p.info.type === 'Face' ? layered(faceLayers) : p.info.textureSet ? this.textureSet(p.info.textureSet) : undefined;
      for (let i = 0; i < p.shapes.length; i++, k++) {
        const block = shapeBlocks[k];
        if (block === undefined) continue;
        const type = shapeShaderType(merged, block);
        // Hair tint shaders get the hair colour at twice its value; skin tint ones (scars) the skin tone.
        if (type === 6 && hair) setShapeTint(merged, block, [(hair.r ?? 0) / 127.5, (hair.g ?? 0) / 127.5, (hair.b ?? 0) / 127.5]);
        if (type === 5) setShapeTint(merged, block, [a.skinTone.r, a.skinTone.g, a.skinTone.b]);
        if (i === 0 && partTex) {
          // The head takes its colour, normal, skin and detail maps from the face texture set; other parts
          // only the maps that differ from the mesh's own (the CK's rules, checked against its FaceGen).
          partTex.forEach((t, slot) => {
            if (!t) return;
            // Which slots the CK copies depends on the shader: the head (face tint) colour, normal, skin and
            // detail; skin-tinted parts (scars) colour and normal; everything else just its colour.
            const slots = type === 4 ? 3 : type === 5 ? 1 : 0;
            if (slot <= slots) setShapeTexture(merged, block, slot, t);
          });
        }
        if (p.info.type === 'Face' && i === 0) setShapeTexture(merged, block, 6, `data\\${paths.tint}`);
      }
    }

    const dds = await this.composeTint(a, warnings);
    return { nif: writeNifDoc(merged), dds, warnings };
  }

  /** The shapes of a merged FaceGen file, in order (the children of its BSFaceGenNiNodeSkinned node). */
  private mergedShapeBlocks(doc: NifDoc): number[] {
    const i = doc.blocks.length - 1;
    const data = doc.blocks[i]!.data;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const n = dv.getUint32(72, true);
    return Array.from({ length: n }, (_, k) => dv.getInt32(76 + k * 4, true));
  }

  /** Parts in the order the CK writes them. */
  private ckOrder(npc: FormKey, parts: LoadedPart[]): LoadedPart[] {
    const byKey = new Map(parts.map((p) => [p.info.formKey, p]));
    const own = this.npcs.appearance(npc).headParts;
    const out: LoadedPart[] = [];
    const seen = new Set<string>();
    const add = (k: FormKey) => {
      const p = byKey.get(k);
      if (!p || seen.has(k)) return;
      seen.add(k);
      for (const e of p.info.extraParts) add(e);
      out.push(p);
    };
    const defaults = parts.filter((p) => !own.includes(p.info.formKey) && !parts.some((q) => q.info.extraParts.includes(p.info.formKey)));
    for (const p of [...defaults].reverse()) add(p.info.formKey);
    for (const k of [...own].reverse()) add(k);
    for (const p of parts) add(p.info.formKey);
    return out;
  }

  /** A TXST's textures in NIF slot order: TX00, TX01, TX03 (skin/glow), TX04 (detail/height), TX05 (environment), TX02 (environment mask), TX06, TX07. */
  private textureSet(key: FormKey): string[] | undefined {
    const d = this.ws.view(key)?.data as Record<string, any> | undefined;
    if (!d) return undefined;
    const t = d.textures ?? d;
    const names = ['diffuse', 'normal', 'glow', 'height', 'environment', 'envMask', 'multilayer', 'backlight'];
    const out = names.map((n) => (typeof t[n] === 'string' && t[n] ? String(t[n]) : ''));
    return out.some(Boolean) ? out : undefined;
  }

  /** Paint the tint: skin tone, then each tint layer through its race mask. */
  async composeTint(a: NpcAppearance, warnings: string[] = []): Promise<Uint8Array> {
    const size = TINT_SIZE;
    const px = new Float32Array(size * size * 3);
    const tone = a.skinTone.r || a.skinTone.g || a.skinTone.b ? a.skinTone : { r: 1, g: 1, b: 1 };
    for (let i = 0; i < size * size; i++) {
      px[i * 3] = tone.r;
      px[i * 3 + 1] = tone.g;
      px[i * 3 + 2] = tone.b;
    }
    const masks = new Map(this.raceTintMasks(a.race, a.female).map((m) => [m.index, m]));
    for (const layer of a.tints) {
      const m = masks.get(layer.index);
      const strength = Math.max(0, Math.min(100, layer.value)) / 100;
      if (!m || !strength) {
        if (!m && strength) warnings.push(`Tint layer ${layer.index} has no mask in the race, so it was skipped`);
        continue;
      }
      const mask = await this.readMask(m.mask, size, warnings);
      if (!mask) continue;
      const c = [layer.color.r / 255, layer.color.g / 255, layer.color.b / 255];
      for (let i = 0; i < size * size; i++) {
        const t = mask[i]! * strength;
        if (!t) continue;
        for (let ch = 0; ch < 3; ch++) px[i * 3 + ch] = px[i * 3 + ch]! * (1 - t) + c[ch]! * t;
      }
    }
    const rgba = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      for (let ch = 0; ch < 3; ch++) rgba[i * 4 + ch] = Math.round(Math.max(0, Math.min(1, px[i * 3 + ch]!)) * 255);
      rgba[i * 4 + 3] = 255;
    }
    // Like the CK: BC3 with mipmaps down to 2×2 (about a third of the uncompressed size).
    return writeBc3Dds(size, size, rgba, { minSize: 2 });
  }

  /** A mask texture as 0–1 coverage at `size`² (nearest sampling), or undefined when it can't be read. */
  private async readMask(path: string, size: number, warnings: string[]): Promise<Float32Array | undefined> {
    if (!this.ws.vfs.has(path)) {
      warnings.push(`Tint mask ${path} not found`);
      return undefined;
    }
    try {
      const dds = parseDds(await this.ws.vfs.read(path));
      const top = dds.mipmaps[0];
      const rgba = top ? decodeToRgba(top, dds.format) : undefined;
      if (!rgba) throw new Error(`unsupported format ${dds.format}`);
      const out = new Float32Array(size * size);
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const sx = Math.min(dds.width - 1, Math.floor((x * dds.width) / size));
          const sy = Math.min(dds.height - 1, Math.floor((y * dds.height) / size));
          const o = (sy * dds.width + sx) * 4;
          out[y * size + x] = Math.max(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!) / 255;
        }
      return out;
    } catch (e) {
      warnings.push(`Tint mask ${path}: ${(e as Error).message}`);
      return undefined;
    }
  }

  // ---------------------------------------------------------------- writing

  /** What the face is made from; when it changes, the FaceGen files are out of date. */
  async inputsHash(npc: FormKey): Promise<string> {
    const a = this.npcs.appearance(npc);
    const parts = this.headPartsOf(npc).map((p) => [p.formKey, p.model, p.tris.map((t) => t.file)]);
    const s = JSON.stringify([a, parts, await this.sculpt(npc), a.hairColor ? (this.ws.view(a.hairColor)?.data as any)?.color : null]);
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  /** Characters in the active plugin whose face needs (re)generating: edited face, missing or stale files. */
  async needingFaces(): Promise<FormKey[]> {
    return (await this.faceFiles()).filter((f) => f.edited && (f.status === 'missing' || f.status === 'outdated')).map((f) => f.npc);
  }

  /**
   * Every character in the active plugin with the state of its face files,
   * like the Creation Kit's character list before Ctrl+F4: edited faces
   * first, then the rest (which can still be exported on request).
   */
  async faceFiles(): Promise<FaceFileStatus[]> {
    const a = this.ws.active;
    if (!a?.plugin) return [];
    const side = await this.readSidecar();
    const out: FaceFileStatus[] = [];
    for (const r of a.plugin.recordsOfType('NPC_')) {
      const key = this.ws.keyOf(a, r.formId)!;
      const owned = parseFormKey(key).plugin.toLowerCase() === (a.name ?? '').toLowerCase();
      const changesFace = ['PNAM', 'NAM9', 'NAMA', 'QNAM', 'FTST', 'HCLF', 'TINI'].some((sig) => r.has(sig)) || !!side.sculpts[key];
      const edited = changesFace && (owned || r.has('PNAM') || !!side.sculpts[key]);
      const summary = this.ws.summary(key);
      const paths = this.npcs.faceGenPaths(key);
      const base = { npc: key, editorId: summary?.editorId, name: summary?.name, edited, mesh: paths.mesh, tint: paths.tint };
      const template = this.npcs.looksTemplate(key);
      if (template) {
        out.push({ ...base, edited: false, status: 'template', template });
        continue;
      }
      if (!this.headPartsOf(key).some((p) => p.type === 'Face' && !!p.model)) {
        out.push({ ...base, status: 'noHead' });
        continue;
      }
      const present = this.ws.vfs.has(paths.mesh) && this.ws.vfs.has(paths.tint);
      // An edited face needs files baked here from its current look (an override's files from the master show the old face).
      const stale = present && edited && side.baked[key] !== (await this.inputsHash(key));
      out.push({ ...base, status: !present ? 'missing' : stale ? 'outdated' : 'ok' });
    }
    const rank = (f: FaceFileStatus) => (f.edited ? 0 : 1) * 10 + ['missing', 'outdated', 'ok', 'noHead', 'template'].indexOf(f.status);
    return out.sort((x, y) => rank(x) - rank(y) || (x.name ?? x.editorId ?? '').localeCompare(y.name ?? y.editorId ?? ''));
  }

  /**
   * Bake and write FaceGen for these characters (default: every one that
   * needs it) into the mod's Data folder, as one undo step.
   */
  async generate(npcs?: FormKey[], onProgress?: (done: number, total: number, npc: FormKey) => void): Promise<FaceGenOutput[]> {
    const list = npcs ?? (await this.needingFaces());
    const out: FaceGenOutput[] = [];
    if (!list.length) return out;
    await this.ws.transactionAsync(list.length === 1 ? `Generate face for ${this.ws.summary(list[0]!)?.editorId ?? list[0]}` : `Generate faces (${list.length})`, async () => {
      const side = await this.readSidecar();
      for (const [i, npc] of list.entries()) {
        onProgress?.(i, list.length, npc);
        const { nif, dds, warnings } = await this.bake(npc);
        const paths = this.npcs.faceGenPaths(npc);
        await this.writeData(paths.mesh, nif);
        await this.writeData(paths.tint, dds);
        side.baked[npc] = await this.inputsHash(npc);
        out.push({ npc, mesh: paths.mesh, tint: paths.tint, warnings });
      }
      await this.writeSidecar(side);
    });
    return out;
  }

  private async writeData(rel: string, data: Uint8Array): Promise<void> {
    const parts = rel.split('\\');
    const path = joinPath(this.ws.options.outputDir, ...parts);
    let before: Uint8Array | null = null;
    try {
      before = await this.ws.fs.readFile(path);
    } catch {
      before = null;
    }
    await this.ws.fs.mkdir(joinPath(this.ws.options.outputDir, ...parts.slice(0, -1)));
    await this.ws.fs.writeFile(path, data);
    this.ws.trackFileChange({ path, before, after: data });
    this.ws.vfs.addLoose(this.ws.options.outputDir, rel);
  }
}

