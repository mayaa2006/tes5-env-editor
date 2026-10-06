/**
 * Smarter placement for the quest builder: characters on real floor at the
 * level you walk in on, clear of walls and of each other, or at a named spot
 * ("behind the bar", "by the forge") facing it; items on tables or named
 * furniture, or inside a named container ("in the chest").
 *
 * Everything is worked out from the cell's real geometry (the same triangles
 * the World tools and the navmesh use), by casting rays.
 */
import type { FormKey } from '@tes5/esp';
import type { EnvironmentService, Surfaces } from './environment';
import type { PlacedRef, Vec3, WorldService } from './world';

export interface ActorSpot {
  position: Vec3;
  /** Yaw (radians) to face the spot they were put by, or the room. */
  yaw: number;
  /** What they were put next to, if anything. */
  near?: PlacedRef;
}

export type ItemSpot = { kind: 'container'; container: PlacedRef } | { kind: 'on'; position: Vec3; on?: PlacedRef };

const STOP = new Set(['the', 'a', 'an', 'of', 'by', 'near', 'next', 'to', 'at', 'in', 'on', 'under', 'behind', 'beside', 'inside', 'into', 'her', 'his', 'their']);
const SYNONYMS: Record<string, string[]> = { bar: ['counter', 'bar'], counter: ['counter', 'bar'], fire: ['fire', 'hearth', 'firepit', 'brazier', 'fireplace'], hearth: ['hearth', 'fire', 'firepit'], forge: ['forge', 'anvil', 'smelter', 'grindstone'], bed: ['bed', 'bedroll'], chest: ['chest', 'strongbox', 'coffer', 'trunk'], table: ['table', 'desk'], chair: ['chair', 'bench', 'stool', 'throne'], door: ['door'] };

function words(text: string): string[] {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(w);
    // Plurals: "barrels" should find a barrel, "shelves" a shelf.
    if (w.length > 4 && w.endsWith('ves')) out.add(`${w.slice(0, -3)}f`);
    else if (w.length > 4 && w.endsWith('es') && /(s|x|ch|sh)es$/.test(w)) out.add(w.slice(0, -2));
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) out.add(w.slice(0, -1));
    for (const s of SYNONYMS[w] ?? []) out.add(s);
  }
  return [...out];
}

const label = (r: PlacedRef) => `${r.baseName ?? ''} ${r.baseEditorId ?? ''} ${r.editorId ?? ''}`.toLowerCase();

export class Placer {
  private taken = new Map<FormKey, Vec3[]>();

  constructor(
    readonly env: EnvironmentService,
    readonly world: WorldService,
    readonly random: () => number,
  ) {}

  private refs(cell: FormKey): PlacedRef[] {
    return this.world.references(cell).filter((r) => !r.deleted && !r.disabled);
  }

  /** The placed object a description points at ("the bar", "the chest by the fire"). */
  findRef(cell: FormKey, text: string, filter: (r: PlacedRef) => boolean = () => true): PlacedRef | undefined {
    const want = words(text);
    if (!want.length) return undefined;
    let best: { r: PlacedRef; score: number } | undefined;
    for (const r of this.refs(cell)) {
      if (r.marker || !filter(r)) continue;
      const l = label(r);
      const score = want.reduce((n, w) => n + (l.includes(w) ? 1 : 0), 0);
      if (score && (!best || score > best.score)) best = { r, score };
    }
    return best?.r;
  }

  /** The floor height you arrive at: the load doors' level, else the lowest floor. */
  private entranceZ(cell: FormKey): number {
    const refs = this.refs(cell);
    const doors = refs.filter((r) => r.teleport);
    if (doors.length) return Math.min(...doors.map((d) => d.transform.position.z));
    return refs.length ? Math.min(...refs.map((r) => r.transform.position.z)) : 0;
  }

  /** Is there room for a person here (no wall within `radius` at chest height)? */
  private clear(s: Surfaces, p: Vec3, radius: number): boolean {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      if (s.raycast({ x: p.x, y: p.y, z: p.z + 60 }, { x: Math.cos(a), y: Math.sin(a), z: 0 }, radius)) return false;
    }
    // Nothing overhead too low (tables, shelves).
    return !s.raycast({ x: p.x, y: p.y, z: p.z + 10 }, { x: 0, y: 0, z: 1 }, 150);
  }

  private free(cell: FormKey, p: Vec3, min: number): boolean {
    const others = [...(this.taken.get(cell) ?? []), ...this.refs(cell).filter((r) => r.sig === 'ACHR').map((r) => r.transform.position)];
    return others.every((o) => Math.hypot(o.x - p.x, o.y - p.y) >= min || Math.abs(o.z - p.z) > 150);
  }

  private take(cell: FormKey, p: Vec3): void {
    this.taken.set(cell, [...(this.taken.get(cell) ?? []), p]);
  }

  /** Somewhere a character can stand: next to `near` if given, otherwise open floor at the entrance level. */
  async actorSpot(cell: FormKey, near: string | null): Promise<ActorSpot> {
    const s = await this.env.surfaces(cell);
    const refs = this.refs(cell);
    const target = near ? this.findRef(cell, near, (r) => r.sig !== 'ACHR') : undefined;
    if (target) {
      const c = target.transform.position;
      const b = target.base ? this.env.boundsOf(target.base) : undefined;
      const reach = b ? Math.max(b.max.x - b.min.x, b.max.y - b.min.y) / 2 * target.transform.scale + 50 : 70;
      for (const ring of [reach, reach + 40, reach + 90]) {
        const start = this.random() * Math.PI * 2;
        for (let i = 0; i < 12; i++) {
          const a = start + (i / 12) * Math.PI * 2;
          const x = c.x + Math.cos(a) * ring;
          const y = c.y + Math.sin(a) * ring;
          const hit = s.down(x, y, c.z + 120, 400);
          if (!hit || hit.normal.z < 0.8 || Math.abs(hit.point.z - c.z) > 80) continue;
          const p = hit.point;
          if (!this.clear(s, p, 35) || !this.free(cell, p, 80)) continue;
          this.take(cell, p);
          return { position: p, yaw: Math.atan2(c.x - p.x, c.y - p.y), near: target };
        }
      }
    }
    // Open floor: sample the room on a grid at the entrance level and pick a roomy spot.
    const floorZ = this.entranceZ(cell);
    const xs = refs.map((r) => r.transform.position.x);
    const ys = refs.map((r) => r.transform.position.y);
    const box = xs.length ? { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) } : { x0: -256, x1: 256, y0: -256, y1: 256 };
    const options: { p: Vec3; room: number }[] = [];
    for (let x = box.x0; x <= box.x1; x += 64)
      for (let y = box.y0; y <= box.y1; y += 64) {
        const hit = s.down(x, y, floorZ + 150, 400);
        if (!hit || hit.normal.z < 0.8 || Math.abs(hit.point.z - floorZ) > 64) continue;
        if (!this.clear(s, hit.point, 40) || !this.free(cell, hit.point, 100)) continue;
        options.push({ p: hit.point, room: this.clear(s, hit.point, 120) ? 2 : 1 });
      }
    const best = options.filter((o) => o.room === 2).length ? options.filter((o) => o.room === 2) : options;
    const pick = best[Math.floor(this.random() * best.length)];
    if (pick) {
      this.take(cell, pick.p);
      const centre = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
      return { position: pick.p, yaw: Math.atan2(centre.x - pick.p.x, centre.y - pick.p.y) };
    }
    // Nothing found (an empty cell): the middle, at the entrance level.
    const p = { x: (box.x0 + box.x1) / 2 + (this.taken.get(cell)?.length ?? 0) * 80, y: (box.y0 + box.y1) / 2, z: floorZ };
    this.take(cell, p);
    return { position: p, yaw: this.random() * Math.PI * 2 };
  }

  /** Where an item goes: inside a named container, on named furniture, on a table, or on the floor. */
  itemSpot(cell: FormKey, where: string | null, n: number): ItemSpot {
    if (where) {
      const container = this.findRef(cell, where, (r) => r.baseSig === 'CONT');
      if (container && /\b(in|inside|into)\b/i.test(where)) return { kind: 'container', container };
      const on = this.findRef(cell, where);
      if (on) {
        if (on.baseSig === 'CONT' && !/\b(on|top)\b/i.test(where)) return { kind: 'container', container: on };
        return { kind: 'on', position: this.topOf(on, n, /\bunder\b/i.test(where)), on };
      }
    }
    const tables = this.refs(cell).filter((r) => /table|desk|counter|shelf/i.test(label(r)));
    const t = tables[n % Math.max(1, tables.length)];
    if (t) return { kind: 'on', position: this.topOf(t, n, false), on: t };
    const refs = this.refs(cell);
    const z = refs.length ? Math.min(...refs.map((r) => r.transform.position.z)) : 0;
    return { kind: 'on', position: { x: n * 30, y: 0, z: z + 60 } };
  }

  /** A point above the top of an object (dropped onto it afterwards), or beside it on the floor ("under"). */
  private topOf(r: PlacedRef, n: number, under: boolean): Vec3 {
    const b = r.base ? this.env.boundsOf(r.base) : undefined;
    const p = r.transform.position;
    const jitter = { x: ((n * 17) % 30) - 15, y: ((n * 11) % 20) - 10 };
    if (under) return { x: p.x + jitter.x, y: p.y + jitter.y, z: p.z + 5 };
    return { x: p.x + jitter.x, y: p.y + jitter.y, z: p.z + (b ? b.max.z * r.transform.scale : 80) + 20 };
  }
}
