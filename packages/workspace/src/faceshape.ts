/**
 * Face shaping beyond the vanilla sliders, in the spirit of RaceMenu:
 *
 * - the 19 vanilla sliders, allowed past ±1;
 * - every other morph the head parts' TRI files carry (morph packs add these);
 * - region sliders — size, width, height, depth, move up/forward, apart and
 *   tilt — for the nose, eyes, brows, cheeks, mouth, jaw, chin, ears and the
 *   whole head.
 *
 * Regions are found from the vanilla morphs themselves (the vertices the
 * "nose" morphs move are the nose), so they work on any head that has a
 * chargen TRI, and the eyes, brows and beards follow the head because their
 * own TRIs carry the same morphs. Nothing near the neck seam moves, so heads
 * still meet their bodies.
 *
 * Pure geometry: used by the live preview and by the FaceGen baker, so what
 * you see is what gets written.
 */
import { FACE_MORPHS } from '@tes5/esp';
import { CHARGEN_SLIDER_MORPHS, SKINNY_MORPH, isPresetMorph, presetMorph, type TriFile } from '@tes5/assets';

export const FACE_REGIONS = ['head', 'nose', 'eyes', 'brows', 'cheeks', 'mouth', 'jaw', 'chin', 'ears'] as const;
export type FaceRegion = (typeof FACE_REGIONS)[number];

export const REGION_CONTROLS = ['size', 'width', 'height', 'depth', 'up', 'forward', 'apart', 'tilt'] as const;
export type RegionControl = (typeof REGION_CONTROLS)[number];

export const REGION_LABELS: Record<FaceRegion, string> = {
  head: 'Whole head',
  nose: 'Nose',
  eyes: 'Eyes',
  brows: 'Brows',
  cheeks: 'Cheeks',
  mouth: 'Mouth & lips',
  jaw: 'Jaw',
  chin: 'Chin',
  ears: 'Ears',
};

export const CONTROL_HELP: Record<RegionControl, string> = {
  size: 'Bigger or smaller, all directions',
  width: 'Wider or narrower (side to side)',
  height: 'Taller or shorter (up and down)',
  depth: 'Deeper or shallower (front to back)',
  up: 'Move up or down',
  forward: 'Move forward or back',
  apart: 'Move the two sides apart or together',
  tilt: 'Tilt the outer corners up or down',
};

/** Which controls make sense per region (paired regions get apart/tilt). */
export const REGION_CONTROLS_FOR: Record<FaceRegion, RegionControl[]> = {
  head: ['size', 'width', 'height', 'depth'],
  nose: ['size', 'width', 'height', 'depth', 'up', 'forward'],
  eyes: ['size', 'width', 'height', 'depth', 'up', 'forward', 'apart', 'tilt'],
  brows: ['size', 'width', 'height', 'depth', 'up', 'forward', 'apart', 'tilt'],
  cheeks: ['size', 'width', 'height', 'depth', 'up', 'forward', 'apart'],
  mouth: ['size', 'width', 'height', 'depth', 'up', 'forward'],
  jaw: ['size', 'width', 'height', 'depth', 'up', 'forward'],
  chin: ['size', 'width', 'height', 'depth', 'up', 'forward'],
  ears: ['size', 'width', 'height', 'depth', 'up', 'forward', 'apart', 'tilt'],
};

const PAIRED = new Set<FaceRegion>(['eyes', 'brows', 'cheeks', 'ears']);

/** The vanilla morphs that tell where each region is. */
const REGION_MORPHS: Partial<Record<FaceRegion, RegExp>> = {
  nose: /^nose/i,
  eyes: /^eyes/i,
  brows: /^brow/i,
  cheeks: /^cheeks/i,
  mouth: /^lip/i,
  jaw: /^jaw/i,
  chin: /^(chin|underbite|overbite)/i,
};

export type RegionShape = Partial<Record<RegionControl, number>>;

/** Everything about a face that the record can't hold (kept in the editor's sidecar, baked into FaceGen). */
export interface FaceSculpt {
  /** Vanilla sliders past ±1 (the record keeps the clamped value). −3…3. */
  extended: Partial<Record<(typeof FACE_MORPHS)[number][0], number>>;
  /** Other TRI morphs by name, 0…1 (up to 2 to exaggerate). */
  morphs: Record<string, number>;
  /** Region sliders, −1…1 each. */
  regions: Partial<Record<FaceRegion, RegionShape>>;
}

export const emptySculpt = (): FaceSculpt => ({ extended: {}, morphs: {}, regions: {} });

export function sculptIsEmpty(s: FaceSculpt | undefined): boolean {
  if (!s) return true;
  const nz = (o: Record<string, number | undefined>) => Object.values(o).some((v) => !!v);
  return !nz(s.extended) && !nz(s.morphs) && !Object.values(s.regions).some((r) => r && nz(r));
}

/** Morph names the vanilla sliders already drive (hidden from the "extra morphs" list). */
export const VANILLA_MORPH_NAMES: ReadonlySet<string> = new Set(CHARGEN_SLIDER_MORPHS.flat().filter(Boolean).map((n) => n.toLowerCase()));

/** One head part as the shaper sees it: model-space vertices and its TRI files (chargen, race). */
export interface ShaperPart {
  key: string;
  /** Head part type ('Face' for the head itself). */
  type: string;
  positions: Float32Array;
  tris: ShaperTri[];
}

export interface FaceLook {
  /** The 19 vanilla slider values (NAM9 order), with any extended values already merged in. */
  sliders: number[];
  sculpt?: FaceSculpt;
  /** The race's own head shape: a race-TRI morph named after the race (the first of these names a part has). */
  raceMorph?: string | string[];
  /** Body weight 0–100: the CK applies SkinnyMorph at 1 − weight/100 to every part that has it. */
  weight?: number;
  /** The race's preset nose, eyes, mouth and brows (NAMA; −1 = none): NoseType{n} etc. at full weight. */
  presets?: { nose: number; eyes: number; mouth: number; brows: number };
}

/** A TRI as the shaper sees it: which file kind it came from decides whether its morphs are offered as extra shapes. */
export type ShaperTri = TriFile & { kind?: 'race' | 'chargen' | 'expression' };

interface Region {
  /** Centre of each side (or of the whole, twice, for unpaired regions). */
  left: [number, number, number];
  right: [number, number, number];
  radius: number;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Shapes a set of head parts together. Masks and region centres are worked
 * out once (from the parts' unmorphed geometry); `shape` is then cheap
 * enough to run on every slider move.
 */
export class FaceShaper {
  private masks = new Map<string, Map<FaceRegion, Float32Array>>();
  private regions = new Map<FaceRegion, Region>();
  /** Height below which nothing moves (the neck seam), and the head's height. */
  private neck = { z0: -Infinity, span: 1 };
  private morphIndex = new Map<string, Map<string, Float32Array>[]>();

  constructor(readonly parts: ShaperPart[]) {
    // The first morph of a name wins, as in the CK (vanilla FemaleHeadCharGen.tri has two "NoseType9").
    for (const p of parts)
      this.morphIndex.set(
        p.key,
        p.tris.map((t) => {
          const m = new Map<string, Float32Array>();
          for (const x of t.morphs) if (!m.has(x.name.toLowerCase())) m.set(x.name.toLowerCase(), x.deltas);
          return m;
        }),
      );
    const head = parts.find((p) => p.type === 'Face') ?? parts[0];
    if (!head) return;
    const hp = head.positions;
    let zMin = Infinity;
    let zMax = -Infinity;
    for (let i = 2; i < hp.length; i += 3) {
      zMin = Math.min(zMin, hp[i]!);
      zMax = Math.max(zMax, hp[i]!);
    }
    this.neck = { z0: zMin, span: Math.max(1, zMax - zMin) };
    for (const p of parts) this.masks.set(p.key, this.morphMasks(p));
    // Region centres come from the head (fallback: the first part).
    const headMasks = this.masks.get(head.key)!;
    for (const r of FACE_REGIONS) {
      const m = r === 'head' ? undefined : headMasks.get(r);
      this.regions.set(r, this.regionOf(hp, m, PAIRED.has(r)));
    }
    // Ears have no vanilla morph: they're the sides of the head between eye and mouth height, behind the face.
    const eyes = this.regions.get('eyes')!;
    const mouth = this.regions.get('mouth')!;
    const center = this.regions.get('head')!.left;
    const zTop = (eyes.left[2] + eyes.right[2]) / 2 + this.neck.span * 0.04;
    const zBottom = (mouth.left[2] + mouth.right[2]) / 2 - this.neck.span * 0.02;
    const yFace = Math.min(eyes.left[1], eyes.right[1]);
    let maxX = 0;
    for (let i = 0; i < hp.length; i += 3) if (hp[i + 2]! > zBottom && hp[i + 2]! < zTop) maxX = Math.max(maxX, Math.abs(hp[i]! - center[0]));
    for (const p of parts) {
      const pos = p.positions;
      const m = new Float32Array(pos.length / 3);
      // Only the head itself has ears: hair and helmets-to-be stay put.
      if (maxX > 0 && p.type === 'Face')
        for (let v = 0; v < m.length; v++) {
          const x = Math.abs(pos[v * 3]! - center[0]) / maxX;
          const z = pos[v * 3 + 2]!;
          const band = smooth(zBottom - this.neck.span * 0.05, zBottom, z) * (1 - smooth(zTop, zTop + this.neck.span * 0.08, z));
          const behind = 1 - smooth(yFace - this.neck.span * 0.12, yFace, pos[v * 3 + 1]!);
          m[v] = smooth(0.72, 0.9, x) * band * behind;
        }
      this.masks.get(p.key)!.set('ears', m);
    }
    this.regions.set('ears', this.regionOf(hp, this.masks.get(head.key)!.get('ears'), true));
  }

  /** 0–1 per vertex: how much the region's vanilla morphs move it, relative to the most-moved vertex. */
  private morphMasks(p: ShaperPart): Map<FaceRegion, Float32Array> {
    const out = new Map<FaceRegion, Float32Array>();
    const n = p.positions.length / 3;
    for (const [region, re] of Object.entries(REGION_MORPHS) as [FaceRegion, RegExp][]) {
      const m = new Float32Array(n);
      for (const t of p.tris)
        for (const morph of t.morphs) {
          if (!re.test(morph.name) || morph.deltas.length !== p.positions.length) continue;
          for (let v = 0; v < n; v++) m[v] = Math.max(m[v]!, Math.hypot(morph.deltas[v * 3]!, morph.deltas[v * 3 + 1]!, morph.deltas[v * 3 + 2]!));
        }
      let max = 0;
      for (const x of m) max = Math.max(max, x);
      if (max > 0) for (let v = 0; v < n; v++) m[v] = smooth(0.02, 0.45, m[v]! / max);
      out.set(region, m);
    }
    return out;
  }

  private regionOf(pos: Float32Array, mask: Float32Array | undefined, paired: boolean): Region {
    const acc = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    let mid = 0;
    if (paired && mask) {
      let w = 0;
      for (let v = 0; v < mask.length; v++) {
        mid += pos[v * 3]! * mask[v]!;
        w += mask[v]!;
      }
      mid = w ? mid / w : 0;
    }
    for (let v = 0; v < pos.length / 3; v++) {
      const w = mask ? mask[v]! : 1;
      if (!w) continue;
      const side = paired && pos[v * 3]! < mid ? 0 : 1;
      const a = acc[paired ? side : 0]!;
      a[0] += pos[v * 3]! * w;
      a[1] += pos[v * 3 + 1]! * w;
      a[2] += pos[v * 3 + 2]! * w;
      a[3] += w;
    }
    const c = (a: number[]): [number, number, number] => (a[3] ? [a[0]! / a[3], a[1]! / a[3], a[2]! / a[3]] : [0, 0, 0]);
    const left = c(acc[0]!);
    const right = paired ? c(acc[1]!) : left;
    let radius = 0;
    let w = 0;
    for (let v = 0; v < pos.length / 3; v++) {
      const m = mask ? mask[v]! : 1;
      if (!m) continue;
      const cc = paired && pos[v * 3]! < mid ? left : right;
      radius += Math.hypot(pos[v * 3]! - cc[0], pos[v * 3 + 1]! - cc[1], pos[v * 3 + 2]! - cc[2]) * m;
      w += m;
    }
    return { left, right, radius: w ? radius / w : 1 };
  }

  /** Every TRI morph on these parts that the vanilla sliders don't already drive. */
  extraMorphs(): string[] {
    const names = new Map<string, string>();
    for (const p of this.parts)
      for (const t of p.tris) {
        // Race shapes, expressions and the presets are set elsewhere (race, weight, Head page).
        if (t.kind === 'race' || t.kind === 'expression') continue;
        for (const m of t.morphs) if (!VANILLA_MORPH_NAMES.has(m.name.toLowerCase()) && !isPresetMorph(m.name) && m.name !== SKINNY_MORPH && !/vampiremorph$/i.test(m.name)) names.set(m.name.toLowerCase(), m.name);
      }
    return [...names.values()].sort((a, b) => a.localeCompare(b));
  }

  /** The regions this head can shape (ones its morphs reveal, plus head and ears). */
  availableRegions(): FaceRegion[] {
    const head = this.parts.find((p) => p.type === 'Face') ?? this.parts[0];
    const masks = head && this.masks.get(head.key);
    return FACE_REGIONS.filter((r) => r === 'head' || (masks?.get(r)?.some((x) => x > 0) ?? false));
  }

  /** Model-space vertices of every part for a look. */
  shape(look: FaceLook): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    for (const p of this.parts) out.set(p.key, this.shapePart(p, look));
    return out;
  }

  private shapePart(p: ShaperPart, look: FaceLook): Float32Array {
    const pos = p.positions.slice();
    const tris = this.morphIndex.get(p.key) ?? [];
    const add = (name: string, w: number): boolean => {
      if (!w || !name) return false;
      for (const t of tris) {
        const d = t.get(name.toLowerCase());
        if (!d || d.length !== pos.length) continue;
        for (let i = 0; i < pos.length; i++) pos[i] += d[i]! * w;
        return true;
      }
      return false;
    };
    for (const name of typeof look.raceMorph === 'string' ? [look.raceMorph] : (look.raceMorph ?? [])) if (add(name, 1)) break;
    if (look.weight !== undefined) add(SKINNY_MORPH, 1 - Math.max(0, Math.min(100, look.weight)) / 100);
    if (look.presets) for (const k of ['nose', 'eyes', 'mouth', 'brows'] as const) add(presetMorph(k, look.presets[k]), 1);
    look.sliders.forEach((v, i) => {
      const pair = CHARGEN_SLIDER_MORPHS[i];
      if (pair && v) add(v < 0 ? pair[0] : pair[1], Math.abs(v));
    });
    for (const [name, w] of Object.entries(look.sculpt?.morphs ?? {})) add(name, w);

    const regions = look.sculpt?.regions ?? {};
    const masks = this.masks.get(p.key);
    const base = p.positions;
    const n = pos.length / 3;
    const disp = new Float32Array(pos.length);
    for (const r of FACE_REGIONS) {
      const s = regions[r];
      if (!s || !Object.values(s).some((v) => !!v)) continue;
      const reg = this.regions.get(r);
      const mask = r === 'head' ? undefined : masks?.get(r);
      if (!reg || (r !== 'head' && !mask)) continue;
      const k = (c: RegionControl) => s[c] ?? 0;
      const size = 1 + 0.35 * k('size');
      const sx = size * (1 + 0.35 * k('width'));
      const sy = size * (1 + 0.35 * k('depth'));
      const sz = size * (1 + 0.35 * k('height'));
      const move = reg.radius * 0.6;
      const tilt = (k('tilt') * 15 * Math.PI) / 180;
      for (let v = 0; v < n; v++) {
        // Measured on the unmorphed vertex so masks don't drift as sliders move.
        const w = (mask ? mask[v]! : 1) * smooth(0.06, 0.3, (base[v * 3 + 2]! - this.neck.z0) / this.neck.span);
        if (!w) continue;
        const left = PAIRED.has(r) && base[v * 3]! < (reg.left[0] + reg.right[0]) / 2;
        const c = left ? reg.left : reg.right;
        const side = left ? -1 : 1;
        let x = pos[v * 3]! - c[0];
        let y = pos[v * 3 + 1]! - c[1];
        let z = pos[v * 3 + 2]! - c[2];
        x *= sx;
        y *= sy;
        z *= sz;
        if (tilt) {
          // Outer corners up: rotate about the forward axis, mirrored per side.
          const a = tilt * side;
          const cx = Math.cos(a);
          const sn = Math.sin(a);
          [x, z] = [x * cx - z * sn, x * sn + z * cx];
        }
        x += side * k('apart') * move * (PAIRED.has(r) ? 1 : 0);
        y += k('forward') * move;
        z += k('up') * move;
        disp[v * 3] += (c[0] + x - pos[v * 3]!) * w;
        disp[v * 3 + 1] += (c[1] + y - pos[v * 3 + 1]!) * w;
        disp[v * 3 + 2] += (c[2] + z - pos[v * 3 + 2]!) * w;
      }
    }
    for (let i = 0; i < pos.length; i++) pos[i] += disp[i]!;
    return pos;
  }
}

/**
 * Everything the CK bakes for a character, as a look: sliders (vampire
 * races get the full vampire morph, as the CK does), the race's
 * own head shape, body weight and the nose/eyes/mouth/brow presets.
 */
export function faceLookFor(
  a: { morphs: Record<string, number>; weight: number; faceParts: { nose: number; unknown: number; eyes: number; mouth: number }; unsetSliders?: string[] },
  race: { editorId?: string; morphRace?: string; vampire?: boolean },
  sculpt?: FaceSculpt,
): FaceLook {
  const sliders = slidersWithExtended(a.morphs, sculpt);
  const vi = FACE_MORPHS.findIndex(([k]) => k === 'vampireMorph');
  // Vampire races get the full vampire morph unless the character sets one (vanilla vampires store 0 or nothing).
  if (race.vampire && !sliders[vi] && sculpt?.extended.vampireMorph === undefined) sliders[vi] = 1;
  const id = race.editorId ?? '';
  const names = [race.morphRace ?? '', id, id.replace(/Vampire$/i, ''), id.replace(/Child(Vampire)?$/i, ''), id.replace(/Race(Child)?(Vampire)?$/i, 'Race')].filter((n, i, all) => n && all.indexOf(n) === i);
  return {
    sliders,
    sculpt,
    raceMorph: names,
    weight: a.weight,
    presets: { nose: a.faceParts.nose, eyes: a.faceParts.eyes, mouth: a.faceParts.mouth, brows: a.faceParts.unknown },
  };
}

/** The 19 slider values with the sculpt's extended values taking over where set. */
export function slidersWithExtended(morphs: Record<string, number>, sculpt?: FaceSculpt): number[] {
  return FACE_MORPHS.map(([k]) => sculpt?.extended[k] ?? morphs[k] ?? 0);
}
