/**
 * NPC appearance editing, modelled on the in-game character creator:
 * race, sex, weight, head parts, colours, face sliders and tint layers.
 */
import { ACBS_FLAGS, FACE_MORPHS, HEAD_PART_TYPES, parseFormKey, type FormKey } from '@tes5/esp';
import { WorkspaceError, type Workspace } from './engine';

export type FaceMorphKey = (typeof FACE_MORPHS)[number][0];

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface TintLayer {
  index: number;
  color: { r: number; g: number; b: number; a: number };
  /** 0–100 */
  value: number;
  preset: number;
}

export interface NpcAppearance {
  race: FormKey | null;
  female: boolean;
  /** 0–100 */
  weight: number;
  /** Height multiplier, 1 = normal. */
  height: number;
  headParts: FormKey[];
  hairColor: FormKey | null;
  headTexture: FormKey | null;
  /** Skin tone (QNAM), 0–1 floats. */
  skinTone: Rgb;
  /** Face sliders, −1 … 1. */
  morphs: Record<FaceMorphKey, number>;
  faceParts: { nose: number; unknown: number; eyes: number; mouth: number };
  tints: TintLayer[];
  /** Sliders the CK left unset (FLT_MAX in the record), shown as 0. */
  unsetSliders?: FaceMorphKey[];
}

export interface HeadPartInfo {
  formKey: FormKey;
  editorId?: string;
  name?: string;
  type: (typeof HEAD_PART_TYPES)[number];
  playable: boolean;
  male: boolean;
  female: boolean;
  model?: string;
  validRaces?: FormKey | null;
  extraParts: FormKey[];
  /** TRI files: race morph, expression tri, chargen morph. */
  tris: { type: number; file: string }[];
  /** Texture set (TNAM) that replaces the mesh's textures, e.g. an eye colour. */
  textureSet?: FormKey | null;
}

export const FEMALE_FLAG = 0x1;

/** A real slider value (not NaN, and not the CK's FLT_MAX "unset" marker). */
export const isSliderValue = (v: number) => Number.isFinite(v) && Math.abs(v) <= 10;

export function emptyMorphs(): Record<FaceMorphKey, number> {
  return Object.fromEntries(FACE_MORPHS.map(([k]) => [k, 0])) as Record<FaceMorphKey, number>;
}

export class NpcService {
  constructor(readonly ws: Workspace) {}

  appearance(npc: FormKey): NpcAppearance {
    const v = this.ws.view(npc);
    if (!v || v.sig !== 'NPC_') throw new WorkspaceError(`${npc} is not an NPC`);
    const d = v.data as Record<string, any>;
    const morphs = emptyMorphs();
    // The CK stores FLT_MAX for sliders it never set (always the vampire morph on vanilla NPCs): read those as 0.
    const unsetSliders: FaceMorphKey[] = [];
    for (const [k] of FACE_MORPHS) {
      const v = d.faceMorph?.[k];
      // No slider data at all counts as unset too.
      if (typeof v === 'number' && isSliderValue(v)) morphs[k] = v;
      else unsetSliders.push(k);
    }
    return {
      race: d.race ?? null,
      female: ((d.config?.flags ?? 0) & FEMALE_FLAG) !== 0,
      weight: d.weight ?? 50,
      height: d.height ?? 1,
      headParts: [...(d.headParts ?? [])],
      hairColor: d.hairColor ?? null,
      headTexture: d.headTexture ?? null,
      skinTone: d.textureLighting ? { r: d.textureLighting.r, g: d.textureLighting.g, b: d.textureLighting.b } : { r: 0, g: 0, b: 0 },
      morphs,
      unsetSliders,
      faceParts: d.faceParts ? { nose: d.faceParts.nose, unknown: d.faceParts.unknown, eyes: d.faceParts.eyes, mouth: d.faceParts.mouth } : { nose: 0, unknown: 0, eyes: 0, mouth: 0 },
      tints: (d.tintLayers ?? []).map((t: any) => ({ index: t.index, color: { ...(t.color ?? { r: 0, g: 0, b: 0, a: 0 }) }, value: t.value ?? 100, preset: t.preset ?? 0 })),
    };
  }

  setAppearance(npc: FormKey, a: Partial<NpcAppearance>): void {
    const errors = this.validate(a);
    if (errors.length) throw new WorkspaceError(errors.join('; '));
    this.ws.editRecord(
      npc,
      (d: Record<string, any>) => {
        if (a.race !== undefined) d.race = a.race;
        if (a.female !== undefined) {
          d.config = { ...(d.config ?? {}) };
          d.config.flags = a.female ? (d.config.flags ?? 0) | FEMALE_FLAG : (d.config.flags ?? 0) & ~FEMALE_FLAG;
        }
        if (a.weight !== undefined) d.weight = Math.max(0, Math.min(100, a.weight));
        if (a.height !== undefined) d.height = a.height;
        if (a.headParts !== undefined) d.headParts = [...a.headParts];
        if (a.hairColor !== undefined) {
          if (a.hairColor) d.hairColor = a.hairColor;
          else delete d.hairColor;
        }
        if (a.headTexture !== undefined) {
          if (a.headTexture) d.headTexture = a.headTexture;
          else delete d.headTexture;
        }
        if (a.skinTone) d.textureLighting = { ...a.skinTone };
        if (a.morphs) {
          const prev: Record<string, number> = d.faceMorph ?? {};
          const next: Record<string, number> = { ...emptyMorphs(), ...prev, ...a.morphs };
          // Leave the CK's "unset" marker alone unless the slider was actually moved.
          for (const [k, v] of Object.entries(a.morphs)) if (v === 0 && typeof prev[k] === 'number' && !isSliderValue(prev[k])) next[k] = prev[k];
          d.faceMorph = next;
        }
        if (a.faceParts) d.faceParts = { ...a.faceParts };
        if (a.tints) d.tintLayers = a.tints.map((t) => ({ index: t.index, color: { ...t.color }, value: Math.round(t.value), preset: t.preset }));
      },
      'Edit NPC appearance',
    );
  }

  validate(a: Partial<NpcAppearance>): string[] {
    const errors: string[] = [];
    if (a.headParts) {
      const types = new Map<string, number>();
      for (const hp of a.headParts) {
        const info = this.headPart(hp);
        if (!info) {
          errors.push(`Head part ${hp} not found`);
          continue;
        }
        types.set(info.type, (types.get(info.type) ?? 0) + 1);
      }
      for (const [t, n] of types) if (n > 1 && t !== 'Misc' && t !== 'Scar') errors.push(`Only one ${t} head part is allowed (found ${n})`);
    }
    if (a.morphs) for (const [k, v] of Object.entries(a.morphs)) if (v < -1 || v > 1) errors.push(`Slider ${k} must be between -1 and 1`);
    return errors;
  }

  headPart(key: FormKey): HeadPartInfo | undefined {
    const v = this.ws.view(key);
    if (!v || v.sig !== 'HDPT') return undefined;
    const d = v.data as Record<string, any>;
    const flags = d.flags ?? 0;
    return {
      formKey: key,
      editorId: v.editorId,
      name: v.name ?? (typeof d.name === 'string' ? d.name : undefined),
      type: HEAD_PART_TYPES[d.type ?? 0] ?? 'Misc',
      playable: (flags & 1) !== 0,
      male: (flags & 2) !== 0,
      female: (flags & 4) !== 0,
      model: d.model?.file,
      validRaces: d.validRaces ?? null,
      extraParts: d.extraParts ?? [],
      tris: (d.parts ?? []).map((p: any) => ({ type: p.type ?? 0, file: p.file })),
      textureSet: d.textureSet ?? null,
    };
  }

  /**
   * The race's default head parts and face texture for one sex (RACE head
   * data: INDX/HEAD pairs and DFTM/DFTF after the MNAM or FNAM marker).
   * Vanilla characters only list what differs from these — usually not even
   * the head itself.
   */
  raceHeadData(race: FormKey | null, female: boolean): { parts: FormKey[]; faceTexture: FormKey | null; hairColor: FormKey | null; vampire: boolean; editorId?: string; morphRace?: string } {
    const out = { parts: [] as FormKey[], faceTexture: null as FormKey | null, hairColor: null as FormKey | null, vampire: false, editorId: undefined as string | undefined, morphRace: undefined as string | undefined };
    if (!race) return out;
    const versions = this.ws.versions(race);
    const v = versions[versions.length - 1];
    if (!v) return out;
    out.editorId = this.ws.summary(race)?.editorId;
    // A race can borrow another's head shape ("morph race", NAM8): vampire and special races do.
    const nam8 = v.record.subrecords.find((s) => s.sig === 'NAM8' && s.data.byteLength >= 4);
    const morphRace = nam8 ? this.ws.keyOf(v.slot, new DataView(nam8.data.buffer, nam8.data.byteOffset).getUint32(0, true)) : undefined;
    out.morphRace = morphRace ? this.ws.summary(morphRace)?.editorId : undefined;
    const kw = ((this.ws.view(race)?.data as any)?.keywords ?? []) as FormKey[];
    out.vampire = /vampire/i.test(out.editorId ?? '') || kw.some((k) => this.ws.summary(k)?.editorId === 'Vampire');
    let inHead = false;
    let sex: 'm' | 'f' | undefined;
    for (const s of v.record.subrecords) {
      // Default hair colours (male, female), outside the head data.
      if (s.sig === 'HCLF' && !inHead && s.data.byteLength >= 8) {
        const id = new DataView(s.data.buffer, s.data.byteOffset, s.data.byteLength).getUint32(female ? 4 : 0, true);
        out.hairColor = id ? (this.ws.keyOf(v.slot, id) ?? null) : null;
      }
      if (s.sig === 'NAM0') inHead = true;
      else if (inHead && s.sig === 'MNAM') sex = 'm';
      else if (inHead && s.sig === 'FNAM') sex = 'f';
      if (!inHead || sex !== (female ? 'f' : 'm') || s.data.byteLength < 4) continue;
      const id = new DataView(s.data.buffer, s.data.byteOffset, s.data.byteLength).getUint32(0, true);
      if (s.sig === 'HEAD' && id) {
        const k = this.ws.keyOf(v.slot, id);
        if (k) out.parts.push(k);
      } else if ((s.sig === 'DFTM' || s.sig === 'DFTF') && id) out.faceTexture = this.ws.keyOf(v.slot, id) ?? null;
    }
    return out;
  }

  /**
   * Every head part that makes up a character's face: the race's defaults,
   * replaced type by type by the character's own, each with its extra parts.
   */
  faceParts(npc: FormKey): HeadPartInfo[] {
    const a = this.appearance(npc);
    const own = a.headParts.map((k) => this.headPart(k)).filter((p): p is HeadPartInfo => !!p);
    // Misc and Scar parts stack; every other type replaces the race's part of that type.
    const ownTypes = new Set<string>(own.map((p) => p.type).filter((t) => t !== 'Misc' && t !== 'Scar'));
    const defaults = this.raceHeadData(a.race, a.female)
      .parts.map((k) => this.headPart(k))
      .filter((p): p is HeadPartInfo => !!p && !ownTypes.has(p.type));
    const out: HeadPartInfo[] = [];
    const seen = new Set<string>();
    const add = (p: HeadPartInfo) => {
      if (seen.has(p.formKey)) return;
      seen.add(p.formKey);
      out.push(p);
      for (const e of p.extraParts) {
        const x = this.headPart(e);
        if (x) add(x);
      }
    };
    for (const p of [...defaults, ...own]) add(p);
    return out;
  }

  /** Head parts usable by a race/sex (via the part's "valid races" form list). */
  headParts(filter: { race?: FormKey | null; female?: boolean; type?: HeadPartInfo['type']; includeNonPlayable?: boolean } = {}): HeadPartInfo[] {
    const out: HeadPartInfo[] = [];
    const listCache = new Map<string, Set<string>>();
    const raceIn = (list: FormKey | null | undefined): boolean => {
      if (!filter.race || !list) return true;
      let set = listCache.get(list);
      if (!set) {
        const fl = this.ws.view(list);
        set = new Set(((fl?.data as any)?.forms ?? []).map((x: unknown) => String(x)));
        listCache.set(list, set);
      }
      return set.has(filter.race);
    };
    for (const s of this.ws.search({ sigs: ['HDPT'], limit: 100_000 }).items) {
      const info = this.headPart(s.formKey);
      if (!info) continue;
      if (filter.type && info.type !== filter.type) continue;
      if (!filter.includeNonPlayable && !info.playable) continue;
      if (filter.female === true && !info.female) continue;
      if (filter.female === false && !info.male) continue;
      if (!raceIn(info.validRaces)) continue;
      out.push(info);
    }
    return out.sort((a, b) => (a.name ?? a.editorId ?? '').localeCompare(b.name ?? b.editorId ?? ''));
  }

  hairColors(): { formKey: FormKey; editorId?: string; name?: string; color: Rgb }[] {
    return this.ws.search({ sigs: ['CLFM'], limit: 10_000 }).items.map((s) => {
      const d = this.ws.view(s.formKey)?.data as any;
      return { formKey: s.formKey, editorId: s.editorId, name: s.name, color: { r: (d?.color?.r ?? 0) / 255, g: (d?.color?.g ?? 0) / 255, b: (d?.color?.b ?? 0) / 255 } };
    });
  }

  races(): { formKey: FormKey; editorId?: string; name?: string }[] {
    return this.ws.search({ sigs: ['RACE'], limit: 10_000 }).items.map((s) => ({ formKey: s.formKey, editorId: s.editorId, name: s.name }));
  }

  /**
   * The template this character takes its looks from ("Use Traits"), if any.
   * The game builds such faces from the template, and vanilla ships no face
   * files for them, so they never need their own.
   */
  looksTemplate(npc: FormKey): FormKey | undefined {
    const d = this.ws.view(npc)?.data as { template?: FormKey | null; config?: { templateFlags?: number } } | undefined;
    return d?.template && Number(d.config?.templateFlags ?? 0) & 1 ? d.template : undefined;
  }

  /** Paths of the FaceGen files the game loads for this NPC. */
  faceGenPaths(npc: FormKey): { mesh: string; tint: string } {
    const { objectId, plugin } = parseFormKey(npc);
    const id = objectId.toString(16).toUpperCase().padStart(8, '0');
    return {
      mesh: `meshes\\actors\\character\\facegendata\\facegeom\\${plugin}\\${id}.nif`.toLowerCase(),
      tint: `textures\\actors\\character\\facegendata\\facetint\\${plugin}\\${id}.dds`.toLowerCase(),
    };
  }

  /**
   * NPCs whose appearance is edited in the active plugin but whose FaceGen
   * files are missing — the cause of the infamous "dark face" bug.
   */
  faceGenProblems(): { npc: FormKey; editorId?: string; missing: string[] }[] {
    const a = this.ws.active;
    if (!a?.plugin) return [];
    const out: { npc: FormKey; editorId?: string; missing: string[] }[] = [];
    for (const r of a.plugin.recordsOfType('NPC_')) {
      const key = this.ws.keyOf(a, r.formId)!;
      const owner = parseFormKey(key).plugin;
      const paths = this.faceGenPaths(key);
      // Overrides only need FaceGen if they change the face; detect face subrecords.
      const changesFace = ['PNAM', 'NAM9', 'NAMA', 'QNAM', 'FTST', 'HCLF', 'TINI', 'RNAM'].some((sig) => r.has(sig));
      if (!changesFace || this.looksTemplate(key)) continue;
      if (owner !== a.name && !this.faceDiffersFromMaster(key)) continue;
      const missing = [paths.mesh, paths.tint].filter((p) => !this.ws.vfs.has(p));
      if (missing.length) out.push({ npc: key, editorId: r.editorId, missing });
    }
    return out;
  }

  private faceDiffersFromMaster(key: FormKey): boolean {
    const versions = this.ws.versions(key);
    if (versions.length < 2) return true;
    const mine = versions[versions.length - 1]!;
    const prev = versions[versions.length - 2]!;
    const face = (r: typeof mine.record) =>
      r.subrecords
        .filter((s) => ['PNAM', 'NAM9', 'NAMA', 'QNAM', 'FTST', 'HCLF', 'TINI', 'TINC', 'TINV', 'TIAS', 'RNAM'].includes(s.sig))
        .map((s) => `${s.sig}:${Array.from(s.data).join(',')}`)
        .join('|');
    return face(mine.record) !== face(prev.record);
  }

  /** The configured flags as names (for the inspector). */
  static flagNames(flags: number): string[] {
    return Object.entries(ACBS_FLAGS)
      .filter(([bit]) => flags & (1 << Number(bit)))
      .map(([, n]) => n);
  }
}
