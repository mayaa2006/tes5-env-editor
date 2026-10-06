/**
 * Checking generated FaceGen against the Creation Kit's, with real game data.
 *
 * - `compareFaceGen` bakes a character's face and compares it, piece by piece,
 *   with the face files the CK exported for them (as shipped in a mod): the
 *   file layout, each shape's vertices, textures and shader, the bones, and
 *   the tint. The report is short plain text, easy to paste back.
 * - `buildFaceKit` gathers only what those faces need from a full install —
 *   the mod's plugin, a cut-down copy of each master holding just the
 *   characters, races, head parts, texture sets and hair colours involved,
 *   the head part meshes and TRIs, the tint masks the characters use, and
 *   the mod's own face files — so the comparison can be run elsewhere
 *   without uploading Skyrim.esm or the game's archives.
 */
import { applyTransform, blockLayout, decodeToRgba, nifShapes, parseDds, parseNif, readNifDoc, writeNifDoc, type NifDoc } from '@tes5/assets';
import { Plugin, PluginRecord, placeRecord, parseFormKey, type FormKey } from '@tes5/esp';
import type { Workspace } from './engine';
import type { FaceGenService } from './facegen';
import type { NpcService } from './npc';

export interface ShapeReport {
  name: string;
  type: string;
  vertices: number;
  skinned: boolean;
  shaderType: number;
  flags: [number, number];
  textures: string[];
  /** Hair/skin tint colour of the shader, when it has one. */
  tint?: [number, number, number];
}

export interface FaceComparison {
  npc: FormKey;
  editorId?: string;
  skipped?: string;
  ref?: { root: string; rootType: string; game: string; shapes: ShapeReport[]; bones: string[]; blockTypes: Record<string, number> };
  ours?: { root: string; rootType: string; game: string; shapes: ShapeReport[]; bones: string[]; blockTypes: Record<string, number> };
  /** Per matched shape: how far our vertices are from the CK's (game units). */
  vertexDiff: { name: string; count: [number, number]; max: number; mean: number; refMovedFromBase?: number; oursMovedFromBase?: number }[];
  tint?: { ref: string; ours: string; meanAbsDiff?: [number, number, number]; note?: string };
  warnings: string[];
}

function shapesOf(doc: NifDoc): ShapeReport[] {
  const nif = parseNif(writeBack(doc));
  const mats = new Map<number, { textures: string[] }>();
  const walk = (n: (typeof nif.roots)[number]) => {
    if (n.mesh) mats.set(n.blockIndex, { textures: n.mesh.material.textures });
    n.children.forEach(walk);
  };
  nif.roots.forEach(walk);
  return nifShapes(doc).map((s) => {
    const b = doc.blocks[s.block]!;
    const l = blockLayout(doc, s.block)!;
    const refs = l.links.filter((k) => k.kind === 'ref');
    const shader = new DataView(b.data.buffer, b.data.byteOffset, b.data.byteLength).getInt32(refs[refs.length - 2]!.offset, true);
    const sl = shader >= 0 ? blockLayout(doc, shader)?.shader : undefined;
    let flags: [number, number] = [0, 0];
    let tint: [number, number, number] | undefined;
    if (sl) {
      const d = doc.blocks[shader]!.data;
      const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      flags = [dv.getUint32(sl.textureSet - 24, true) >>> 0, dv.getUint32(sl.textureSet - 20, true) >>> 0];
      if ((sl.type === 5 || sl.type === 6) && sl.typeSpecific + 12 <= d.byteLength) tint = [0, 1, 2].map((k) => Math.round(dv.getFloat32(sl.typeSpecific + k * 4, true) * 1000) / 1000) as [number, number, number];
    }
    return { name: s.name, type: s.type, vertices: s.positions.length / 3, skinned: s.skinned, shaderType: sl?.type ?? -1, flags, textures: (mats.get(s.block)?.textures ?? []).map((t) => t.toLowerCase()), tint };
  });
}

/** Re-serialise a doc only to reuse the scene-graph reader for materials. */
const writeBack = (doc: NifDoc) => writeNifDoc(doc);

function describeDoc(doc: NifDoc) {
  const root = doc.blocks[doc.roots[0] ?? 0];
  const nameIdx = root && root.data.byteLength >= 4 ? new DataView(root.data.buffer, root.data.byteOffset).getInt32(0, true) : -1;
  const blockTypes: Record<string, number> = {};
  for (const b of doc.blocks) blockTypes[b.type] = (blockTypes[b.type] ?? 0) + 1;
  const shapes = shapesOf(doc);
  const shapeNames = new Set(shapes.map((s) => s.name));
  const bones: string[] = [];
  const parsed = parseNif(writeNifDoc(doc));
  for (const r of parsed.roots) for (const c of r.children) if (!c.mesh && !shapeNames.has(c.name)) bones.push(c.name);
  return { root: nameIdx >= 0 ? (doc.strings[nameIdx] ?? '') : '', rootType: root?.type ?? '?', game: doc.bsVersion === 100 ? 'SE' : doc.bsVersion === 83 ? 'LE' : `BS ${doc.bsVersion}`, shapes, bones, blockTypes };
}

/** Bake one character and compare with the face files already in the data (the CK's). */
export async function compareFaceGen(ws: Workspace, npcs: NpcService, faces: FaceGenService, npc: FormKey): Promise<FaceComparison> {
  const out: FaceComparison = { npc, editorId: ws.summary(npc)?.editorId, vertexDiff: [], warnings: [] };
  const paths = npcs.faceGenPaths(npc);
  if (!ws.vfs.has(paths.mesh)) return { ...out, skipped: `no reference face mesh at ${paths.mesh}` };
  let refDoc: NifDoc;
  try {
    refDoc = readNifDoc(await ws.vfs.read(paths.mesh));
  } catch (e) {
    return { ...out, skipped: `reference mesh can't be read: ${(e as Error).message}` };
  }
  let baked: Awaited<ReturnType<FaceGenService['bake']>>;
  try {
    baked = await faces.bake(npc);
  } catch (e) {
    return { ...out, skipped: `can't bake: ${(e as Error).message}` };
  }
  out.warnings.push(...baked.warnings);
  const ourDoc = readNifDoc(baked.nif);
  out.ref = describeDoc(refDoc);
  out.ours = describeDoc(ourDoc);

  // Vertices, in file space, for shapes with the same name.
  const refShapes = nifShapes(refDoc);
  const ourShapes = nifShapes(ourDoc);
  const base = new Map<string, Float32Array>();
  for (const info of faces.headPartsOf(npc)) {
    if (!info.model || !info.editorId) continue;
    const p = `meshes\\${info.model.toLowerCase().replace(/\//g, '\\').replace(/^meshes\\/, '')}`;
    if (!ws.vfs.has(p)) continue;
    try {
      const s = nifShapes(readNifDoc(await ws.vfs.read(p)))[0];
      if (s) base.set(info.editorId.toLowerCase(), applyTransform(s.transform, s.positions));
    } catch {
      // reported by the bake
    }
  }
  for (const r of refShapes) {
    const o = ourShapes.find((s) => s.name.toLowerCase() === r.name.toLowerCase());
    if (!o) continue;
    const rp = applyTransform(r.transform, r.positions);
    const op = applyTransform(o.transform, o.positions);
    const n = Math.min(rp.length, op.length) / 3;
    let max = 0;
    let sum = 0;
    for (let v = 0; v < n; v++) {
      const d = Math.hypot(rp[v * 3]! - op[v * 3]!, rp[v * 3 + 1]! - op[v * 3 + 1]!, rp[v * 3 + 2]! - op[v * 3 + 2]!);
      max = Math.max(max, d);
      sum += d;
    }
    const b = base.get(r.name.toLowerCase());
    const moved = (p: Float32Array) => {
      if (!b || b.length !== p.length) return undefined;
      let m = 0;
      for (let v = 0; v < p.length / 3; v++) m = Math.max(m, Math.hypot(p[v * 3]! - b[v * 3]!, p[v * 3 + 1]! - b[v * 3 + 1]!, p[v * 3 + 2]! - b[v * 3 + 2]!));
      return Math.round(m * 1000) / 1000;
    };
    out.vertexDiff.push({ name: r.name, count: [rp.length / 3, op.length / 3], max: Math.round(max * 1000) / 1000, mean: n ? Math.round((sum / n) * 1000) / 1000 : 0, refMovedFromBase: moved(rp), oursMovedFromBase: moved(op) });
  }

  // Tint.
  if (ws.vfs.has(paths.tint)) {
    try {
      const ref = parseDds(await ws.vfs.read(paths.tint));
      const ours = parseDds(baked.dds);
      out.tint = { ref: `${ref.width}×${ref.height} ${ref.format}${ref.mipmaps.length > 1 ? ` +${ref.mipmaps.length - 1} mips` : ''}`, ours: `${ours.width}×${ours.height} ${ours.format}` };
      const ra = ref.mipmaps[0] && decodeToRgba(ref.mipmaps[0], ref.format);
      const oa = ours.mipmaps[0] && decodeToRgba(ours.mipmaps[0], ours.format);
      if (ra && oa) {
        const size = Math.min(ref.width, ours.width, ref.height, ours.height);
        const sum = [0, 0, 0];
        for (let y = 0; y < size; y++)
          for (let x = 0; x < size; x++) {
            const ri = (Math.floor((y * ref.height) / size) * ref.width + Math.floor((x * ref.width) / size)) * 4;
            const oi = (Math.floor((y * ours.height) / size) * ours.width + Math.floor((x * ours.width) / size)) * 4;
            for (let c = 0; c < 3; c++) sum[c] += Math.abs(ra[ri + c]! - oa[oi + c]!);
          }
        out.tint.meanAbsDiff = sum.map((s) => Math.round((s / (size * size)) * 10) / 10) as [number, number, number];
      } else out.tint.note = `can't decode ${ref.format} to compare colours`;
    } catch (e) {
      out.tint = { ref: 'unreadable', ours: '', note: (e as Error).message };
    }
  } else out.tint = { ref: 'missing', ours: '' };
  return out;
}

const hex = (n: number) => `0x${(n >>> 0).toString(16).padStart(8, '0')}`;

/** Plain-text report of a set of comparisons (what to paste back). */
export function formatComparisons(list: FaceComparison[]): string {
  const lines: string[] = [];
  for (const c of list) {
    lines.push(`=== ${c.editorId ?? ''} ${c.npc}`);
    if (c.skipped) {
      lines.push(`  skipped: ${c.skipped}`);
      continue;
    }
    const r = c.ref!;
    const o = c.ours!;
    lines.push(`  root   CK: ${r.rootType} "${r.root}" (${r.game})   ours: ${o.rootType} "${o.root}" (${o.game})`);
    const types = (t: Record<string, number>) => Object.entries(t).sort().map(([k, v]) => `${k}×${v}`).join(' ');
    lines.push(`  blocks CK: ${types(r.blockTypes)}`);
    lines.push(`         ours: ${types(o.blockTypes)}`);
    lines.push(`  bones  CK: ${r.bones.join(', ') || '-'}`);
    lines.push(`         ours: ${o.bones.join(', ') || '-'}`);
    const names = [...new Set([...r.shapes.map((s) => s.name), ...o.shapes.map((s) => s.name)])];
    for (const n of names) {
      const a = r.shapes.find((s) => s.name === n);
      const b = o.shapes.find((s) => s.name === n);
      lines.push(`  shape "${n}"${!a ? ' (only ours)' : !b ? ' (only CK)' : ''}`);
      const row = (label: string, s?: ShapeReport) => {
        if (!s) return;
        lines.push(`    ${label} ${s.type} v=${s.vertices}${s.skinned ? ' skinned' : ''} shader=${s.shaderType} flags=${hex(s.flags[0])}/${hex(s.flags[1])}${s.tint ? ` tint=${s.tint.join(',')}` : ''}`);
        s.textures.forEach((t, i) => t && lines.push(`        tex${i}: ${t}`));
      };
      row('CK  ', a);
      row('ours', b);
      const d = c.vertexDiff.find((x) => x.name === n);
      if (d) lines.push(`    vertices: max diff ${d.max}, mean ${d.mean}${d.count[0] !== d.count[1] ? ` (counts differ ${d.count[0]} vs ${d.count[1]})` : ''}; moved from the part's own mesh: CK ${d.refMovedFromBase ?? '?'}, ours ${d.oursMovedFromBase ?? '?'}`);
    }
    if (c.tint) lines.push(`  tint   CK: ${c.tint.ref}   ours: ${c.tint.ours}${c.tint.meanAbsDiff ? `   mean colour diff (0-255) r/g/b ${c.tint.meanAbsDiff.join('/')}` : ''}${c.tint.note ? `   (${c.tint.note})` : ''}`);
    for (const w of c.warnings) lines.push(`  warning: ${w}`);
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ kit

export interface FaceKit {
  /** Data-relative path → bytes (plugins at the top level). */
  files: Map<string, Uint8Array>;
  /** Load order for the kit. */
  plugins: string[];
  npcs: FormKey[];
  notes: string[];
}

const STRIP = new Set(['FULL', 'DESC', 'SHRT']);

/**
 * Collect what comparing these characters' faces needs. `plugin` is the mod
 * whose CK-made face files are the reference; with no `npcs`, its characters
 * that have face files are used (up to `limit`).
 */
export async function buildFaceKit(ws: Workspace, npcs: NpcService, faces: FaceGenService, plugin: string, opts: { npcs?: string[]; limit?: number } = {}): Promise<FaceKit> {
  const slot = ws.slot(plugin);
  if (!slot?.plugin) throw new Error(`${plugin} isn't loaded`);
  const notes: string[] = [];
  const files = new Map<string, Uint8Array>();
  const want = (opts.npcs ?? []).map((s) => s.toLowerCase());
  const chosen: FormKey[] = [];
  for (const r of slot.plugin.recordsOfType('NPC_')) {
    const key = ws.keyOf(slot, r.formId)!;
    const p = npcs.faceGenPaths(key);
    const name = (r.editorId ?? '').toLowerCase();
    if (want.length ? !want.includes(name) && !want.includes(key.toLowerCase()) : !ws.vfs.has(p.mesh)) continue;
    chosen.push(key);
    if (!want.length && chosen.length >= (opts.limit ?? 5)) break;
  }
  if (!chosen.length) throw new Error(want.length ? `None of ${opts.npcs!.join(', ')} are characters in ${plugin}` : `${plugin} has no characters with face files`);

  // Every form the faces depend on.
  const forms = new Set<FormKey>();
  const tintIdx = new Map<string, Set<number>>();
  for (const npc of chosen) {
    forms.add(npc);
    const a = npcs.appearance(npc);
    if (a.race) forms.add(a.race);
    if (a.hairColor) forms.add(a.hairColor);
    if (a.headTexture) forms.add(a.headTexture);
    for (const hp of faces.headPartsOf(npc)) forms.add(hp.formKey);
    if (a.race) {
      const k = `${a.race}|${a.female}`;
      const set = tintIdx.get(k) ?? new Set<number>();
      for (const t of a.tints) set.add(t.index);
      tintIdx.set(k, set);
    }
  }

  // Cut-down masters: each keeps its own versions of those forms (same FormIDs, same masters).
  const chain: string[] = [];
  const addChain = (name: string) => {
    const s = ws.slot(name);
    if (!s?.plugin || chain.some((c) => c.toLowerCase() === name.toLowerCase())) return;
    for (const m of s.plugin.masters) addChain(m);
    chain.push(s.name);
  };
  addChain(slot.name);
  for (const name of chain) {
    const s = ws.slot(name)!;
    if (s === slot) {
      files.set(s.name, await ws.fs.readFile(s.path!));
      continue;
    }
    const mini = Plugin.create(s.name, { game: ws.game, masters: s.plugin!.masters, description: 'Face test kit: only the forms some faces need.' });
    let n = 0;
    for (const key of forms) {
      const v = ws.versions(key).find((x) => x.slot.name === s.name);
      if (!v) continue;
      const subs = v.record.subrecords.filter((x) => !STRIP.has(x.sig)).map((x) => ({ sig: x.sig, data: x.data.slice() }));
      placeRecord(mini, PluginRecord.create(v.record.sig, v.record.formId, subs, v.record.flags & ~0x40000, v.record.formVersion));
      n++;
    }
    files.set(s.name, mini.serialize());
    notes.push(`${s.name}: ${n} form(s) kept`);
  }

  // Assets.
  const take = async (path: string, why: string) => {
    const p = path.toLowerCase().replace(/\//g, '\\');
    if (files.has(p)) return;
    if (!ws.vfs.has(p)) {
      notes.push(`missing ${p} (${why})`);
      return;
    }
    files.set(p, await ws.vfs.read(p));
  };
  for (const npc of chosen) {
    for (const hp of faces.headPartsOf(npc)) {
      if (hp.model) await take(`meshes\\${hp.model.replace(/^meshes[\\/]/i, '')}`, `${hp.editorId} mesh`);
      for (const t of hp.tris) if (t.file) await take(`meshes\\${t.file.replace(/^meshes[\\/]/i, '')}`, `${hp.editorId} morphs`);
    }
    const p = npcs.faceGenPaths(npc);
    await take(p.mesh, 'CK face mesh');
    await take(p.tint, 'CK face tint');
  }
  for (const [k, idx] of tintIdx) {
    const [race, female] = k.split('|') as [FormKey, string];
    for (const m of faces.raceTintMasks(race, female === 'true')) if (idx.has(m.index)) await take(m.mask, `tint mask ${m.name}`);
  }
  return { files, plugins: chain, npcs: chosen, notes };
}

/** The kit's characters' owning plugin name, for a header line. */
export function kitSummary(kit: FaceKit): string {
  const size = [...kit.files.values()].reduce((s, b) => s + b.byteLength, 0);
  return `${kit.npcs.length} character(s), ${kit.files.size} files, ${(size / 1048576).toFixed(1)} MB; load order: ${kit.plugins.join(', ')}; characters: ${kit.npcs.map((k) => parseFormKey(k).objectId.toString(16)).join(', ')}`;
}
