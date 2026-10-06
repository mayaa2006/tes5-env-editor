/**
 * Changing characters from a description: what they wear (saved as an
 * outfit), what they carry, their factions, class, level, whether they can
 * die, and how they look (build, height, hair, hair colour, facial hair,
 * eyes, scars). Used by the quest builder for new characters and for ones
 * that already exist. Words are matched to the load order loosely ("fine
 * blue clothes" finds "Fine Clothes"), and every guess is reported.
 */
import { parseFormKey, type FormKey } from '@tes5/esp';
import { ITEM_SIGS } from './dialogue';
import { WorkspaceError, type Workspace } from './engine';
import type { HeadPartInfo, NpcService } from './npc';
import { FEMALE_FLAG } from './npc';
import type { PlanCharacter, PlanLook } from './questplan';
import { ROUTINE_LABELS } from './routines';

const ESSENTIAL = 0x2;
const PC_LEVEL_MULT = 0x80;
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'with', 'set', 'some', 'pair', 'his', 'her', 'their']);
const SYNONYMS: Record<string, string[]> = { grey: ['gray'], gray: ['grey'], blond: ['blonde'], blonde: ['blond'], beard: ['facialhair'], clothes: ['clothing', 'outfit'], clothing: ['clothes'], shoes: ['boots'], boots: ['shoes'], hood: ['hat', 'cap'], hat: ['hood', 'cap'] };
const NONE = /^(none|no|nothing|bald|clean[- ]?shaven|shaved|-)$/i;

function words(text: string): string[] {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 2 || STOP.has(w)) continue;
    out.add(w);
    // Plurals: "barrels" should find a barrel, "shelves" a shelf.
    if (w.length > 4 && w.endsWith('ves')) out.add(`${w.slice(0, -3)}f`);
    else if (w.length > 4 && w.endsWith('es') && /(s|x|ch|sh)es$/.test(w)) out.add(w.slice(0, -2));
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) out.add(w.slice(0, -1));
    for (const s of SYNONYMS[w] ?? []) out.add(s);
  }
  return [...out];
}

/** How well a description matches a name / Editor ID (0 = not at all). */
function score(want: string[], name: string): number {
  const hay = name.toLowerCase();
  return want.reduce((n, w) => n + (hay.includes(w) ? (w.length > 3 ? 2 : 1) : 0), 0);
}

export interface CharacterChangeContext {
  /** Plan item keys → the forms built for them. */
  items: Map<string, FormKey>;
  /** Editor ID prefix for new records. */
  prefix: string;
  random: () => number;
  /** A character just created (so the look is filled in for everything the plan doesn't say). */
  isNew: boolean;
  created: (kind: 'outfit', key: FormKey, label: string) => void;
  note: (text: string) => void;
  warn: (text: string) => void;
}

export class CharacterEditor {
  constructor(
    readonly ws: Workspace,
    readonly npcs: NpcService,
  ) {}

  /** A form by Editor ID, exact name, or the closest name ("fine blue clothes" → "Fine Clothes"). */
  findLoose(sigs: readonly string[], text: string | null | undefined): FormKey | undefined {
    const t = text?.trim();
    if (!t) return undefined;
    const byId = this.ws.byEditorId(t);
    if (byId && sigs.includes(this.ws.summary(byId)?.sig ?? '')) return byId;
    const want = words(t);
    if (!want.length) return undefined;
    let best: { key: FormKey; score: number; mine: boolean; len: number } | undefined;
    // Candidates contain at least one of the words (searching each word keeps this fast on big load orders).
    const seen = new Set<FormKey>();
    for (const w of want.filter((x) => x.length > 2).slice(0, 4)) {
      for (const s of this.ws.search({ sigs, query: w, limit: 400 }).items) {
        if (s.deleted || seen.has(s.formKey)) continue;
        seen.add(s.formKey);
        const label = `${s.name ?? ''} ${s.editorId ?? ''}`;
        if (s.name?.toLowerCase() === t.toLowerCase()) return s.formKey;
        const sc = score(want, label);
        const len = label.length;
        if (!best || sc > best.score || (sc === best.score && (Number(s.inActive) > Number(best.mine) || (s.inActive === best.mine && len < best.len)))) best = { key: s.formKey, score: sc, mine: s.inActive, len };
      }
    }
    // At least half the words must match.
    return best && best.score >= Math.max(1, Math.ceil(want.length / 2)) ? best.key : undefined;
  }

  private label(key: FormKey): string {
    const s = this.ws.summary(key);
    return s?.name ?? s?.editorId ?? key;
  }

  /** The changes a plan entry asks for, in plain words (for the review screen). */
  describe(c: PlanCharacter): string[] {
    const out: string[] = [];
    if (c.spot && !c.existing) out.push(`stands ${c.spot}`);
    if (c.outfit) out.push(`wears ${c.outfit.items.join(', ')}${c.outfit.saveAs ? ` (saved as ${c.outfit.saveAs})` : ''}`);
    if (c.inventory.length) out.push(`carries ${c.inventory.map((i) => `${i.count > 1 ? `${i.count} × ` : ''}${i.item}`).join(', ')}`);
    if (c.factions.length) out.push(`joins ${c.factions.map((f) => f.faction).join(', ')}`);
    if (c.className) out.push(`class ${c.className}`);
    if (c.level !== null) out.push(`level ${c.level}`);
    if (c.essential !== null && c.existing) out.push(c.essential ? 'essential' : 'can be killed');
    for (const r of c.routine ?? []) {
      const bits = [ROUTINE_LABELS[r.activity], r.where && `at ${r.where}`, r.hours && `${String(r.hours.from).padStart(2, '0')}:00–${String(r.hours.to).padStart(2, '0')}:00`, (r.fromStage !== null || r.untilStage !== null) && `from stage ${r.fromStage ?? 'start'} until ${r.untilStage ?? 'the end'}`, r.line && `“${r.line}”`].filter(Boolean);
      out.push(bits.join(' '));
    }
    const l = c.look;
    if (l) {
      const bits = [l.hair && `${l.hair} hair`, l.hairColor && `${l.hairColor} hair colour`, l.facialHair && (NONE.test(l.facialHair) ? 'no beard' : l.facialHair), l.eyes && `${l.eyes} eyes`, l.scar, l.weight !== null && `build ${Math.round(l.weight)}`, l.height !== null && `height ${l.height}`].filter(Boolean);
      if (bits.length) out.push(bits.join(', '));
    }
    return out;
  }

  /** Apply everything the plan says about a character (one undo step when called on its own). */
  apply(npc: FormKey, c: PlanCharacter, ctx: CharacterChangeContext): void {
    this.ws.transaction(`Change ${c.name}`, () => {
      const owner = parseFormKey(npc).plugin;
      if (!ctx.isNew && owner !== this.ws.activeName && this.describe(c).length)
        ctx.note(`${c.name} comes from ${owner}, so your plugin now overrides them; other mods that change them will conflict (see Release → Conflicts).`);
      this.ws.editRecord(npc, (d: any) => {
        d.config = { ...(d.config ?? {}) };
        if (c.essential !== null) d.config.flags = c.essential ? (d.config.flags ?? 0) | ESSENTIAL : (d.config.flags ?? 0) & ~ESSENTIAL;
        if (c.level !== null) {
          d.config.flags = (d.config.flags ?? 0) & ~PC_LEVEL_MULT;
          d.config.level = Math.max(1, Math.min(255, c.level));
        }
        if (c.className) {
          const cls = this.findLoose(['CLAS'], c.className);
          if (cls) d.class = cls;
          else ctx.note(`${c.name}: no class like “${c.className}”, so it stays ${this.label(d.class)}.`);
        }
        if (c.factions.length) {
          const list: any[] = [...(d.factions ?? [])];
          for (const f of c.factions) {
            const fk = this.findLoose(['FACT'], f.faction);
            if (!fk) {
              ctx.warn(`${c.name}: no faction like “${f.faction}” in the load order.`);
              continue;
            }
            const have = list.find((x) => x.faction === fk);
            if (have) have.rank = f.rank;
            else list.push({ faction: fk, rank: f.rank, unused: new Uint8Array(3) });
          }
          d.factions = list;
        }
        if (c.inventory.length) {
          const inv: any[] = [...(d.items ?? [])];
          for (const it of c.inventory) {
            const k = ctx.items.get(it.item) ?? this.findLoose(ITEM_SIGS, it.item);
            if (!k) {
              ctx.warn(`${c.name}: no item like “${it.item}” to carry.`);
              continue;
            }
            inv.push({ item: { item: k, count: Math.max(1, it.count) } });
          }
          d.items = inv;
        }
      });
      if (c.outfit) this.applyOutfit(npc, c, ctx);
      this.applyLook(npc, c, ctx);
    });
  }

  private applyOutfit(npc: FormKey, c: PlanCharacter, ctx: CharacterChangeContext): void {
    const outfit = c.outfit!;
    // A single existing outfit is used as it is.
    if (outfit.items.length === 1 && !ctx.items.has(outfit.items[0]!)) {
      const existing = this.findLoose(['OTFT'], outfit.items[0]);
      if (existing && !outfit.saveAs) {
        this.ws.editRecord(npc, (d: any) => void (d.defaultOutfit = existing));
        return;
      }
    }
    const pieces: FormKey[] = [];
    for (const it of outfit.items) {
      const k = ctx.items.get(it) ?? this.findLoose(['ARMO', 'LVLI'], it);
      if (k) pieces.push(k);
      else ctx.warn(`${c.name}: no clothing like “${it}” in the load order, so it's left out of their outfit.`);
    }
    if (!pieces.length) {
      ctx.warn(`${c.name}'s outfit couldn't be made: none of its pieces were found.`);
      return;
    }
    const wanted = outfit.saveAs ?? `${ctx.prefix}${c.name.replace(/[^A-Za-z0-9]/g, '')}Outfit`;
    const editorId = this.ws.byEditorId(wanted) ? this.ws.uniqueEditorId(wanted) : wanted;
    if (editorId !== wanted) ctx.note(`The outfit name ${wanted} was taken, so it's ${editorId}.`);
    const otft = this.ws.createRecord('OTFT', { editorId, items: pieces });
    this.ws.editRecord(npc, (d: any) => void (d.defaultOutfit = otft));
    ctx.created('outfit', otft, `${editorId}: ${pieces.map((p) => this.label(p)).join(', ')} (worn by ${c.name})`);
  }

  private pick(parts: HeadPartInfo[], text: string | null, random: () => number): HeadPartInfo | undefined {
    if (!parts.length) return undefined;
    if (!text) return parts[Math.floor(random() * parts.length)];
    const want = words(text);
    let best: HeadPartInfo[] = [];
    let top = 0;
    for (const p of parts) {
      const sc = score(want, `${p.name ?? ''} ${p.editorId ?? ''}`);
      if (sc > top) {
        top = sc;
        best = [p];
      } else if (sc === top && sc > 0) best.push(p);
    }
    return best.length ? best[Math.floor(random() * best.length)] : undefined;
  }

  private applyLook(npc: FormKey, c: PlanCharacter, ctx: CharacterChangeContext): void {
    const look: PlanLook = c.look ?? { weight: null, height: null, hair: null, hairColor: null, facialHair: null, eyes: null, scar: null };
    if (!ctx.isNew && !c.look) return;
    const a = this.npcs.appearance(npc);
    const female = a.female;
    const filter = { race: a.race, female };
    const heads = a.headParts.map((k) => this.npcs.headPart(k)).filter((x): x is HeadPartInfo => !!x);
    const byType = new Map<HeadPartInfo['type'], HeadPartInfo | undefined>(heads.map((h) => [h.type, h]));
    const changed: string[] = [];
    // The face must suit the sex and race (a copy from someone else may not).
    const face = byType.get('Face');
    if (!face || (female ? !face.female : !face.male)) {
      const f = this.pick(this.npcs.headParts({ ...filter, type: 'Face', includeNonPlayable: true }), null, ctx.random);
      if (f) byType.set('Face', f);
    }
    const slots: [HeadPartInfo['type'], string | null, boolean][] = [
      ['Hair', look.hair, ctx.isNew],
      ['Facial Hair', female ? 'none' : look.facialHair, ctx.isNew && !female],
      ['Eyes', look.eyes, false],
      ['Scar', look.scar, false],
    ];
    for (const [type, text, randomIfUnset] of slots) {
      if (text === null && !randomIfUnset) continue;
      if (text !== null && NONE.test(text.trim()) && !(type === 'Hair' && /bald/i.test(text))) {
        if (byType.get(type)) changed.push(`no ${type.toLowerCase()}`);
        byType.set(type, undefined);
        continue;
      }
      const options = this.npcs.headParts({ ...filter, type });
      // New men get a beard about half the time when the text doesn't say.
      if (type === 'Facial Hair' && text === null && ctx.random() < 0.5) {
        byType.set(type, undefined);
        continue;
      }
      const p = this.pick(options, text, ctx.random);
      if (p) {
        byType.set(type, p);
        if (text) changed.push(`${type.toLowerCase()}: ${p.name ?? p.editorId}`);
      } else if (text) ctx.note(`${c.name}: no ${type.toLowerCase()} like “${text}” for their race and sex.`);
    }
    let hairColor = a.hairColor;
    if (look.hairColor) {
      const col = this.findLoose(['CLFM'], look.hairColor);
      if (col) hairColor = col;
      else ctx.note(`${c.name}: no hair colour like “${look.hairColor}”.`);
    } else if (ctx.isNew) {
      const all = this.npcs.hairColors();
      if (all.length) hairColor = all[Math.floor(ctx.random() * all.length)]!.formKey;
    }
    const headParts = [...byType.values()].filter((x): x is HeadPartInfo => !!x).map((h) => h.formKey);
    try {
      this.npcs.setAppearance(npc, {
        headParts,
        hairColor,
        ...(look.weight !== null ? { weight: look.weight } : ctx.isNew ? { weight: Math.round(20 + ctx.random() * 60) } : {}),
        ...(look.height !== null ? { height: Math.max(0.8, Math.min(1.2, look.height)) } : {}),
      });
    } catch (e) {
      if (e instanceof WorkspaceError) ctx.warn(`${c.name}'s look couldn't be set: ${e.message}`);
      else throw e;
    }
    if (!ctx.isNew && (c.look || changed.length)) ctx.note(`${c.name}'s face changed, so their FaceGen needs exporting again from the Creation Kit (Ctrl+F4).`);
  }
}

export { FEMALE_FLAG };
