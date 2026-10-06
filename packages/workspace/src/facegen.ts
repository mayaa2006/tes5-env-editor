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
import { CHARGEN_SLIDER_MORPHS, applyTransform, decodeToRgba, invertTransform, mergeShapes, nifShapes, parseDds, parseTri, readNifDoc, setShapePositions, setShapeTexture, setShapeTint, shapeShaderType, writeNifDoc, writeRgbaDds, type NifDoc, type TriFile } from '@tes5/assets';
import { parseFormKey, type FormKey } from '@tes5/esp';
import { WorkspaceError, type Workspace } from './engine';
import { FaceShaper, emptySculpt, sculptIsEmpty, slidersWithExtended, type FaceSculpt } from './faceshape';
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
  tris: TriFile[];
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
    const tris: TriFile[] = [];
    // Race morphs (0) and chargen morphs (2); expressions (1) stay live in game.
    for (const t of info.tris) {
      if (t.type === 1 || !t.file) continue;
      const tp = meshPath(t.file);
      if (!this.ws.vfs.has(tp)) {
        warnings.push(`${info.editorId ?? info.formKey}: ${tp} not found, its sliders won't apply`);
        continue;
      }
      try {
        tris.push(parseTri(await this.ws.vfs.read(tp)));
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

  /** A race morph whose name matches the race (e.g. "NordRace" or "Nord"), if any TRI has one. */
  private raceMorphName(race: FormKey | null, parts: LoadedPart[]): string | undefined {
    const edid = race ? this.ws.summary(race)?.editorId : undefined;
    if (!edid) return undefined;
    const want = [edid, edid.replace(/Race(Vampire)?$/i, ''), edid.replace(/Vampire$/i, '')].map((s) => s.toLowerCase());
    for (const p of parts) for (const t of p.tris) for (const m of t.morphs) if (want.includes(m.name.toLowerCase()) && !CHARGEN_SLIDER_MORPHS.flat().includes(m.name)) return m.name;
    return undefined;
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
        return { key: p.info.formKey, type: p.info.type, positions: applyTransform(s.transform, s.positions), tris: p.tris.filter((t) => t.vertices.length === s.positions.length) };
      }),
    );
    const shaped = shaper.shape({ sliders: slidersWithExtended(a.morphs, sculpt), sculpt, raceMorph: this.raceMorphName(a.race, parts) });
    for (const p of parts) {
      const s = this.morphShape(p);
      const model = shaped.get(p.info.formKey);
      if (model) setShapePositions(p.doc, s.block, applyTransform(invertTransform(s.transform), model));
    }

    const merged = mergeShapes(
      parts.map((p) => ({ doc: p.doc, shapes: p.shapes.map((s, i) => ({ block: s.block, transform: s.transform, name: i === 0 ? (p.info.editorId ?? s.name) : undefined })) })),
      { rootName: 'BSFaceGenNiNodeSkinned', bsVersion: game, userVersion: parts[0]!.doc.userVersion },
    );

    // Colours and textures.
    const paths = this.npcs.faceGenPaths(npc);
    const hair = a.hairColor ? (this.ws.view(a.hairColor)?.data as any)?.color : undefined;
    const faceTexKey = a.headTexture ?? this.npcs.raceHeadData(a.race, a.female).faceTexture;
    const faceTex = faceTexKey ? this.textureSet(faceTexKey) : undefined;
    let k = 0;
    for (const p of parts) {
      for (let i = 0; i < p.shapes.length; i++, k++) {
        const block = this.mergedShapeBlock(merged, k);
        if (block === undefined) continue;
        if (hair && ['Hair', 'Facial Hair', 'Eyebrows'].includes(p.info.type) && shapeShaderType(merged, block) === 6) setShapeTint(merged, block, [(hair.r ?? 0) / 255, (hair.g ?? 0) / 255, (hair.b ?? 0) / 255]);
        if (p.info.type === 'Face' && i === 0) {
          if (faceTex) faceTex.forEach((t, slot) => t && setShapeTexture(merged, block, slot, t));
          setShapeTexture(merged, block, 6, paths.tint);
        }
      }
    }

    const dds = await this.composeTint(a, warnings);
    return { nif: writeNifDoc(merged), dds, warnings };
  }

  /** The k-th shape in the merged file (shapes come first among the root's children, in part order). */
  private mergedShapeBlock(doc: NifDoc, k: number): number | undefined {
    const root = doc.blocks[0]!.data;
    const dv = new DataView(root.buffer, root.byteOffset, root.byteLength);
    const n = dv.getUint32(72, true);
    if (k >= n) return undefined;
    const b = dv.getInt32(76 + k * 4, true);
    return doc.blocks[b]?.type === 'NiNode' ? undefined : b;
  }

  /** A face TXST as NIF texture slots: diffuse, normal, subsurface, detail, …, specular (slots 4–6 left alone). */
  private textureSet(key: FormKey): string[] | undefined {
    const d = this.ws.view(key)?.data as Record<string, any> | undefined;
    if (!d) return undefined;
    const t = d.textures ?? d;
    const names = ['diffuse', 'normal', 'envMask', 'glow', '', '', '', 'backlight'];
    const out = names.map((n) => (n && typeof t[n] === 'string' && t[n] ? texturePath(t[n]) : ''));
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
    return writeRgbaDds(size, size, rgba);
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
    const a = this.ws.active;
    if (!a?.plugin) return [];
    const side = await this.readSidecar();
    const out: FormKey[] = [];
    for (const r of a.plugin.recordsOfType('NPC_')) {
      const key = this.ws.keyOf(a, r.formId)!;
      const owned = parseFormKey(key).plugin.toLowerCase() === (a.name ?? '').toLowerCase();
      const changesFace = ['PNAM', 'NAM9', 'NAMA', 'QNAM', 'FTST', 'HCLF', 'TINI'].some((sig) => r.has(sig)) || !!side.sculpts[key];
      if (!changesFace || (!owned && !r.has('PNAM') && !side.sculpts[key])) continue;
      if (!this.headPartsOf(key).some((p) => p.type === 'Face')) continue;
      const paths = this.npcs.faceGenPaths(key);
      const present = this.ws.vfs.has(paths.mesh) && this.ws.vfs.has(paths.tint);
      if (!present || side.baked[key] !== (await this.inputsHash(key))) out.push(key);
    }
    return out;
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

