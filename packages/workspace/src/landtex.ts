/**
 * The ground's look for the 3D view: each cell's landscape texture layers
 * (LAND BTXT/ATXT/VTXT → LTEX → TXST) blended into one picture per cell,
 * the way the game paints them. Vertex colours are applied on top by the view.
 */
import { decodeToRgba, gameTexturePath, parseDds } from '@tes5/assets';
import type { FormKey } from '@tes5/esp';
import type { Workspace } from './engine';
import type { WorldService } from './world';

/** Each landscape texture repeats this many times across a cell (3 per quadrant). */
const REPEATS = 6;
/** Size each landscape texture is sampled at. */
const TILE = 128;
/** Ground with no texture at all: plain dirt. */
const DEFAULT_RGB = [96, 84, 66];

export interface LandTexture {
  width: number;
  height: number;
  /** RGBA, rows south → north. */
  rgba: Uint8Array;
}

export class LandTextureBaker {
  private tiles = new Map<string, Promise<Uint8Array | null>>();
  /** Keyed on the record's subrecord list, which every edit replaces (so painting re-bakes). */
  private baked = new WeakMap<object, Promise<LandTexture | undefined>>();

  constructor(
    readonly ws: Workspace,
    readonly world: WorldService,
  ) {}

  /** The diffuse texture of a landscape texture form (its texture set's first texture). */
  private diffuseOf(ltex: FormKey | null | undefined): string | undefined {
    if (!ltex) return undefined;
    const w = this.ws.winner(ltex);
    const tnam = w?.record.get('TNAM');
    if (!w || !tnam || tnam.data.byteLength < 4) return undefined;
    const txst = this.ws.keyOf(w.slot, new DataView(tnam.data.buffer, tnam.data.byteOffset, 4).getUint32(0, true));
    const t = txst ? this.ws.winner(txst)?.record.get('TX00') : undefined;
    if (!t) return undefined;
    let end = t.data.indexOf(0);
    if (end < 0) end = t.data.byteLength;
    const p = new TextDecoder('latin1').decode(t.data.subarray(0, end)).trim();
    return p ? gameTexturePath(p) : undefined;
  }

  /** A texture as TILE² RGB, from the smallest mip level that is still at least that big. */
  private tile(path: string): Promise<Uint8Array | null> {
    let p = this.tiles.get(path);
    if (!p) {
      p = (async () => {
        if (!this.ws.vfs.has(path)) return null;
        const dds = parseDds(await this.ws.vfs.read(path));
        const level = [...dds.mipmaps].reverse().find((m) => m.width >= TILE && m.height >= TILE) ?? dds.mipmaps[0];
        const rgba = level ? decodeToRgba(level, dds.format) : undefined;
        if (!level || !rgba) return null;
        const out = new Uint8Array(TILE * TILE * 3);
        const sx = level.width / TILE;
        const sy = level.height / TILE;
        for (let y = 0; y < TILE; y++)
          for (let x = 0; x < TILE; x++) {
            // Box filter over the source pixels this tile pixel covers.
            let r = 0, g = 0, b = 0, n = 0;
            for (let yy = Math.floor(y * sy); yy < Math.floor((y + 1) * sy); yy++)
              for (let xx = Math.floor(x * sx); xx < Math.floor((x + 1) * sx); xx++) {
                const o = (yy * level.width + xx) * 4;
                r += rgba[o]!;
                g += rgba[o + 1]!;
                b += rgba[o + 2]!;
                n++;
              }
            const d = (y * TILE + x) * 3;
            out[d] = r / n;
            out[d + 1] = g / n;
            out[d + 2] = b / n;
          }
        return out;
      })().catch(() => null);
      this.tiles.set(path, p);
    }
    return p;
  }

  /** The average colour of a landscape texture (for a picker swatch), or null when its texture can't be read. */
  async swatch(ltex: FormKey): Promise<[number, number, number] | null> {
    const path = this.diffuseOf(ltex);
    const t = path ? await this.tile(path) : null;
    if (!t) return null;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < t.length; i += 3) (r += t[i]!), (g += t[i + 1]!), (b += t[i + 2]!);
    const n = t.length / 3;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  }

  /** The blended ground texture of an outdoor cell, or undefined when it has no land or no texture layers. */
  bake(cell: FormKey, size = 512): Promise<LandTexture | undefined> {
    const land = this.world.landRecord(cell);
    if (!land) return Promise.resolve(undefined);
    let p = this.baked.get(land.record.subrecords);
    if (!p) {
      p = this.bakeNow(cell, size);
      this.baked.set(land.record.subrecords, p);
    }
    return p;
  }

  private async bakeNow(cell: FormKey, size: number): Promise<LandTexture | undefined> {
    const quads = this.world.landLayers(cell);
    if (!quads || !quads.some((q) => q.base || q.layers.length)) return undefined;
    const tileFor = async (ltex: FormKey | null | undefined) => {
      const path = this.diffuseOf(ltex);
      return path ? this.tile(path) : null;
    };
    const loaded = await Promise.all(
      quads.map(async (q) => ({
        base: await tileFor(q.base),
        layers: (await Promise.all(q.layers.map(async (l) => ({ tile: await tileFor(l.ltex), alpha: l.alpha })))).filter((l) => l.tile),
      })),
    );
    const rgba = new Uint8Array(size * size * 4);
    const half = size / 2;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const qx = x < half ? 0 : 1;
        const qy = y < half ? 0 : 1;
        const q = loaded[qx + 2 * qy]!;
        // Position on the quadrant's 17×17 grid of opacity points.
        const gx = (((x - qx * half) + 0.5) / half) * 16;
        const gy = (((y - qy * half) + 0.5) / half) * 16;
        // Position in the repeating texture.
        const t = ((Math.floor((((y + 0.5) / size) * REPEATS * TILE)) % TILE) * TILE + (Math.floor((((x + 0.5) / size) * REPEATS * TILE)) % TILE)) * 3;
        let r = q.base ? q.base[t]! : DEFAULT_RGB[0]!;
        let g = q.base ? q.base[t + 1]! : DEFAULT_RGB[1]!;
        let b = q.base ? q.base[t + 2]! : DEFAULT_RGB[2]!;
        for (const l of q.layers) {
          const a = bilinear(l.alpha, gx, gy);
          if (a <= 0) continue;
          r += (l.tile![t]! - r) * a;
          g += (l.tile![t + 1]! - g) * a;
          b += (l.tile![t + 2]! - b) * a;
        }
        const o = (y * size + x) * 4;
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = 255;
      }
    return { width: size, height: size, rgba };
  }
}

function bilinear(grid: Float32Array, x: number, y: number): number {
  const x0 = Math.min(15, Math.floor(x));
  const y0 = Math.min(15, Math.floor(y));
  const fx = Math.min(1, x - x0);
  const fy = Math.min(1, y - y0);
  const at = (c: number, r: number) => grid[r * 17 + c]!;
  return Math.min(1, Math.max(0, (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy));
}
