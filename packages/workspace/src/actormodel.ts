/**
 * What a placed character looks like, as model files to draw in its rest pose:
 * the race skin (or a creature's body), the outfit's armor in place of the
 * skin pieces it covers, and the head (the character's FaceGen file, or the
 * race's default head parts). Templates and leveled lists are followed the
 * way the game does for traits and inventory.
 */
import type { FormKey } from '@tes5/esp';
import type { Workspace } from './engine';
import type { NpcService } from './npc';

export interface ActorModelPart {
  /** Mesh path relative to Data\meshes. */
  model: string;
  kind: 'body' | 'armor' | 'head';
}

export interface ActorModel {
  parts: ActorModelPart[];
  /** The character's height multiplier. */
  scale: number;
  female: boolean;
  /** Body weight 0–100: heavy (_1) and thin (_0) meshes are blended by it. */
  weight: number;
  /** Skin tone (0–1, QNAM), for the skin shader; undefined when unset. */
  skinTone?: { r: number; g: number; b: number };
  /** Hair colour (0–1, sRGB) for hair, beards and brows: the character's own, else its race's default. */
  hairColor?: { r: number; g: number; b: number };
  /** Why something is missing, for the tooltip. */
  notes: string[];
}

type Data = Record<string, any>;

const USE_TRAITS = 1 << 0;
const USE_INVENTORY = 1 << 8;

const meshRel = (p: string) => p.replace(/\//g, '\\').replace(/^\\+/, '').replace(/^meshes\\/i, '');

export class ActorModels {
  private cache = new Map<string, ActorModel | null>();
  private cacheRevision = -1;

  constructor(
    readonly ws: Workspace,
    readonly npcs: NpcService,
  ) {}

  private data(key: FormKey | null | undefined): Data | undefined {
    return key ? (this.ws.view(key)?.data as Data | undefined) : undefined;
  }

  private sigOf(key: FormKey): string | undefined {
    return this.ws.summary(key)?.sig;
  }

  /** A leveled list's first entry, followed down to an actual form. */
  private firstEntry(key: FormKey, want: string[], depth = 0): FormKey | undefined {
    if (depth > 6) return undefined;
    const sig = this.sigOf(key);
    if (sig && want.includes(sig)) return key;
    if (sig !== 'LVLN' && sig !== 'LVLI') return undefined;
    for (const e of (this.data(key)?.entries ?? []) as Data[]) {
      const ref = e.entry?.reference as FormKey | undefined;
      const found = ref ? this.firstEntry(ref, want, depth + 1) : undefined;
      if (found) return found;
    }
    return undefined;
  }

  /** Follow templates while the given template flag says to use the template's data. */
  private source(npc: FormKey, flag: number): FormKey {
    let cur = npc;
    for (let i = 0; i < 8; i++) {
      const d = this.data(cur);
      const tpl = d?.template as FormKey | undefined;
      if (!tpl || !(Number(d?.config?.templateFlags ?? 0) & flag)) return cur;
      const next = this.firstEntry(tpl, ['NPC_']);
      if (!next) return cur;
      cur = next;
    }
    return cur;
  }

  /** The armor addon of an armor that fits a race, with its model for the sex. */
  private armatureModel(armo: FormKey, race: FormKey, armorRace: FormKey | undefined, female: boolean): { model: string; slots: number } | undefined {
    const armatures = ((this.data(armo)?.armatures ?? []) as (FormKey | null)[]).filter((a): a is FormKey => !!a);
    const info = armatures.map((a) => ({ a, ...this.readArma(a) })).filter((x) => x.male || x.female);
    const fits = (r: FormKey | undefined) => (r ? info.find((x) => x.race === r || x.extraRaces.includes(r)) : undefined);
    const pick = fits(race) ?? fits(armorRace) ?? info[0];
    if (!pick) return undefined;
    const model = (female ? pick.female : pick.male) ?? pick.male ?? pick.female;
    return model ? { model: meshRel(model), slots: pick.slots } : undefined;
  }

  /** ARMA fields the typed schema doesn't cover: models per sex (MOD2/MOD3) and extra races (MODL). */
  private readArma(arma: FormKey): { race?: FormKey; extraRaces: FormKey[]; male?: string; female?: string; slots: number } {
    const w = this.ws.winner(arma);
    if (!w) return { extraRaces: [], slots: 0 };
    const text = (sig: string) => {
      const s = w.record.get(sig);
      if (!s) return undefined;
      let end = s.data.indexOf(0);
      if (end < 0) end = s.data.byteLength;
      return new TextDecoder('latin1').decode(s.data.subarray(0, end)) || undefined;
    };
    const fid = (data: Uint8Array) => (data.byteLength >= 4 ? (this.ws.keyOf(w.slot, new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true)) ?? undefined) : undefined);
    const rnam = w.record.get('RNAM');
    // Body slots: BOD2, or the older BODT layout (also slots first).
    const bod2 = w.record.get('BOD2') ?? w.record.get('BODT');
    return {
      race: rnam ? fid(rnam.data) : undefined,
      extraRaces: w.record.subrecords.filter((s) => s.sig === 'MODL').map((s) => fid(s.data)).filter((k): k is FormKey => !!k),
      male: text('MOD2'),
      female: text('MOD3'),
      slots: bod2 && bod2.data.byteLength >= 4 ? new DataView(bod2.data.buffer, bod2.data.byteOffset, 4).getUint32(0, true) : 0,
    };
  }

  /** Armor worn by default: the outfit's pieces (leveled ones resolved to their first entry). */
  private outfitArmor(npc: FormKey): FormKey[] {
    const outfit = this.data(npc)?.defaultOutfit as FormKey | undefined;
    const items = ((this.data(outfit)?.items ?? []) as (FormKey | null)[]).filter((k): k is FormKey => !!k);
    return items.map((k) => this.firstEntry(k, ['ARMO'])).filter((k): k is FormKey => !!k);
  }

  /** Model files for a placed character's base (an NPC or a leveled list of them). */
  modelFor(base: FormKey): ActorModel | null {
    if (this.cacheRevision !== this.ws.revision) {
      this.cache.clear();
      this.cacheRevision = this.ws.revision;
    }
    if (this.cache.has(base)) return this.cache.get(base)!;
    const result = this.build(base);
    this.cache.set(base, result);
    return result;
  }

  private build(base: FormKey): ActorModel | null {
    const npc = this.firstEntry(base, ['NPC_']);
    if (!npc) return null;
    const notes: string[] = [];
    const traits = this.source(npc, USE_TRAITS);
    const inventory = this.source(npc, USE_INVENTORY);
    const t = this.data(traits) ?? {};
    const race = t.race as FormKey | undefined;
    if (!race) return null;
    const raceData = this.data(race) ?? {};
    const female = (Number(t.config?.flags ?? 0) & 1) !== 0;
    const armorRace = this.armorRaceOf(race);
    const parts: ActorModelPart[] = [];

    // Worn armor first: it decides which skin pieces are covered.
    let covered = 0;
    for (const armo of this.outfitArmor(inventory)) {
      const m = this.armatureModel(armo, race, armorRace, female);
      if (!m) continue;
      parts.push({ model: m.model, kind: 'armor' });
      covered |= m.slots;
    }
    const skin = (t.skin ?? raceData.skin) as FormKey | undefined;
    for (const arma of ((this.data(skin)?.armatures ?? []) as (FormKey | null)[]).filter((a): a is FormKey => !!a)) {
      const a = this.readArma(arma);
      if (!(a.race === race || a.extraRaces.includes(race) || (armorRace && (a.race === armorRace || a.extraRaces.includes(armorRace))))) continue;
      if (a.slots & covered) continue;
      const model = (female ? a.female : a.male) ?? a.male ?? a.female;
      if (model) parts.push({ model: meshRel(model), kind: 'body' });
    }
    if (!parts.length) notes.push('No body model found for its race');

    // Head: the character's own FaceGen file, else the race's head parts (creatures have their head in the body).
    const face = this.npcs.faceGenPaths(traits).mesh;
    if (this.ws.vfs.has(face)) parts.push({ model: meshRel(face), kind: 'head' });
    else {
      const heads = this.npcs.faceParts(traits).filter((p) => p.model);
      for (const h of heads) parts.push({ model: meshRel(h.model!), kind: 'head' });
      if (heads.length) notes.push('No face file yet: showing the race\'s default head');
    }
    const scale = typeof t.height === 'number' && t.height > 0 ? t.height : 1;
    const weight = typeof t.weight === 'number' ? Math.max(0, Math.min(100, t.weight)) : 50;
    const tl = t.textureLighting as { r: number; g: number; b: number } | undefined;
    const skinTone = tl && (tl.r || tl.g || tl.b) ? { r: tl.r, g: tl.g, b: tl.b } : undefined;
    const hairKey = (t.hairColor as FormKey | undefined) ?? this.npcs.raceHeadData(race, female).hairColor ?? undefined;
    const hc = hairKey ? (this.data(hairKey)?.color as { r: number; g: number; b: number } | undefined) : undefined;
    const hairColor = hc ? { r: hc.r / 255, g: hc.g / 255, b: hc.b / 255 } : undefined;
    return { parts, scale, female, weight, skinTone, hairColor, notes };
  }

  /** The race whose armor addons this race uses (RACE RNAM), e.g. vampire races wear Nord armor. */
  private armorRaceOf(race: FormKey): FormKey | undefined {
    const w = this.ws.winner(race);
    const s = w?.record.get('RNAM');
    return s && s.data.byteLength >= 4 && w ? (this.ws.keyOf(w.slot, new DataView(s.data.buffer, s.data.byteOffset, 4).getUint32(0, true)) ?? undefined) : undefined;
  }
}
