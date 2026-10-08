/**
 * DDS textures. Parses headers (including DX10) into mip levels that can be
 * uploaded to the GPU as compressed textures, and decodes BC1–BC5 / RGBA
 * formats in software for thumbnails and fallbacks.
 */

export type DdsFormat = 'bc1' | 'bc2' | 'bc3' | 'bc4' | 'bc5' | 'bc7' | 'rgba8' | 'bgra8' | 'bgrx8' | 'bgr8' | 'rgb8' | 'r5g6b5' | 'l8' | 'unknown';

export interface DdsLevel {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface DdsImage {
  width: number;
  height: number;
  format: DdsFormat;
  srgb: boolean;
  isCubemap: boolean;
  /** Mip levels of the first face. */
  mipmaps: DdsLevel[];
  /** All six faces for cubemaps. */
  faces?: DdsLevel[][];
}

const FOURCC = (s: string) => s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24);

const DXGI: Record<number, { format: DdsFormat; srgb: boolean }> = {
  28: { format: 'rgba8', srgb: false },
  29: { format: 'rgba8', srgb: true },
  71: { format: 'bc1', srgb: false },
  72: { format: 'bc1', srgb: true },
  74: { format: 'bc2', srgb: false },
  75: { format: 'bc2', srgb: true },
  77: { format: 'bc3', srgb: false },
  78: { format: 'bc3', srgb: true },
  80: { format: 'bc4', srgb: false },
  83: { format: 'bc5', srgb: false },
  87: { format: 'bgra8', srgb: false },
  88: { format: 'bgrx8', srgb: false },
  91: { format: 'bgra8', srgb: true },
  98: { format: 'bc7', srgb: false },
  99: { format: 'bc7', srgb: true },
  61: { format: 'l8', srgb: false },
  85: { format: 'r5g6b5', srgb: false },
};

export function blockBytes(format: DdsFormat): number {
  return format === 'bc1' || format === 'bc4' ? 8 : 16;
}

export function isCompressed(format: DdsFormat): boolean {
  return format.startsWith('bc');
}

function levelSize(format: DdsFormat, w: number, h: number): number {
  if (isCompressed(format)) return Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * blockBytes(format);
  const bpp = format === 'r5g6b5' ? 2 : format === 'l8' ? 1 : format === 'bgr8' || format === 'rgb8' ? 3 : 4;
  return w * h * bpp;
}

export function parseDds(bytes: Uint8Array): DdsImage {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== FOURCC('DDS ')) throw new Error('Not a DDS file');
  const height = dv.getUint32(12, true);
  const width = dv.getUint32(16, true);
  const mipCount = Math.max(1, dv.getUint32(28, true));
  const pfFlags = dv.getUint32(80, true);
  const fourCC = dv.getUint32(84, true);
  const rgbBits = dv.getUint32(88, true);
  const rMask = dv.getUint32(92, true);
  const caps2 = dv.getUint32(112, true);
  let offset = 128;
  let format: DdsFormat = 'unknown';
  let srgb = false;
  if (pfFlags & 0x4) {
    if (fourCC === FOURCC('DXT1')) format = 'bc1';
    else if (fourCC === FOURCC('DXT2') || fourCC === FOURCC('DXT3')) format = 'bc2';
    else if (fourCC === FOURCC('DXT4') || fourCC === FOURCC('DXT5')) format = 'bc3';
    else if (fourCC === FOURCC('ATI1') || fourCC === FOURCC('BC4U')) format = 'bc4';
    else if (fourCC === FOURCC('ATI2') || fourCC === FOURCC('BC5U')) format = 'bc5';
    else if (fourCC === FOURCC('DX10')) {
      const dxgi = dv.getUint32(128, true);
      const f = DXGI[dxgi];
      if (f) {
        format = f.format;
        srgb = f.srgb;
      }
      offset += 20;
    }
  } else if (pfFlags & 0x40) {
    if (rgbBits === 32) format = rMask === 0x000000ff ? 'rgba8' : (pfFlags & 0x1) ? 'bgra8' : 'bgrx8';
    else if (rgbBits === 24) format = rMask === 0x000000ff ? 'rgb8' : 'bgr8'; // Skyrim's tint masks
    else if (rgbBits === 16) format = 'r5g6b5';
  } else if (pfFlags & 0x20000) {
    format = 'l8';
  }
  const isCubemap = (caps2 & 0x200) !== 0;
  const faces: DdsLevel[][] = [];
  const faceCount = isCubemap ? 6 : 1;
  for (let f = 0; f < faceCount; f++) {
    const levels: DdsLevel[] = [];
    let w = width;
    let h = height;
    for (let m = 0; m < mipCount; m++) {
      const size = levelSize(format, w, h);
      if (offset + size > bytes.byteLength) break;
      levels.push({ width: w, height: h, data: bytes.subarray(offset, offset + size) });
      offset += size;
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
    faces.push(levels);
  }
  return { width, height, format, srgb, isCubemap, mipmaps: faces[0] ?? [], faces: isCubemap ? faces : undefined };
}

// ------------------------------------------------------------------ software decoding

function rgb565(c: number): [number, number, number] {
  const r = (c >> 11) & 31;
  const g = (c >> 5) & 63;
  const b = c & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

function decodeColorBlock(src: Uint8Array, o: number, out: Uint8Array, w: number, x0: number, y0: number, h: number, allowAlpha: boolean): void {
  const c0 = src[o]! | (src[o + 1]! << 8);
  const c1 = src[o + 2]! | (src[o + 3]! << 8);
  const p0 = rgb565(c0);
  const p1 = rgb565(c1);
  const pal: number[][] = [
    [...p0, 255],
    [...p1, 255],
  ];
  if (c0 > c1 || !allowAlpha) {
    pal.push([(2 * p0[0] + p1[0]) / 3, (2 * p0[1] + p1[1]) / 3, (2 * p0[2] + p1[2]) / 3, 255]);
    pal.push([(p0[0] + 2 * p1[0]) / 3, (p0[1] + 2 * p1[1]) / 3, (p0[2] + 2 * p1[2]) / 3, 255]);
  } else {
    pal.push([(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2, 255]);
    pal.push([0, 0, 0, 0]);
  }
  const bits = (src[o + 4]! | (src[o + 5]! << 8) | (src[o + 6]! << 16) | (src[o + 7]! << 24)) >>> 0;
  for (let py = 0; py < 4; py++) {
    for (let px = 0; px < 4; px++) {
      const x = x0 + px;
      const y = y0 + py;
      if (x >= w || y >= h) continue;
      const idx = (bits >>> (2 * (py * 4 + px))) & 3;
      const c = pal[idx]!;
      const d = (y * w + x) * 4;
      out[d] = c[0]!;
      out[d + 1] = c[1]!;
      out[d + 2] = c[2]!;
      out[d + 3] = c[3]!;
    }
  }
}

function decodeAlphaBlock(src: Uint8Array, o: number): number[] {
  const a0 = src[o]!;
  const a1 = src[o + 1]!;
  const pal = [a0, a1];
  if (a0 > a1) for (let i = 1; i < 7; i++) pal.push(((7 - i) * a0 + i * a1) / 7);
  else {
    for (let i = 1; i < 5; i++) pal.push(((5 - i) * a0 + i * a1) / 5);
    pal.push(0, 255);
  }
  // 48 bits of 3-bit indices
  let lo = (src[o + 2]! | (src[o + 3]! << 8) | (src[o + 4]! << 16)) >>> 0;
  let hi = (src[o + 5]! | (src[o + 6]! << 8) | (src[o + 7]! << 16)) >>> 0;
  const out: number[] = [];
  for (let i = 0; i < 8; i++) {
    out.push(pal[lo & 7]!);
    lo >>>= 3;
  }
  for (let i = 0; i < 8; i++) {
    out.push(pal[hi & 7]!);
    hi >>>= 3;
  }
  return out;
}

/** Decode a mip level to RGBA8. Returns undefined for formats that need the GPU (BC7). */
export function decodeToRgba(level: DdsLevel, format: DdsFormat): Uint8Array | undefined {
  const { width: w, height: h, data } = level;
  const out = new Uint8Array(w * h * 4);
  switch (format) {
    case 'rgba8':
      out.set(data.subarray(0, w * h * 4));
      return out;
    case 'bgra8':
    case 'bgrx8':
      for (let i = 0; i < w * h; i++) {
        out[i * 4] = data[i * 4 + 2]!;
        out[i * 4 + 1] = data[i * 4 + 1]!;
        out[i * 4 + 2] = data[i * 4]!;
        out[i * 4 + 3] = format === 'bgrx8' ? 255 : data[i * 4 + 3]!;
      }
      return out;
    case 'bgr8':
    case 'rgb8':
      for (let i = 0; i < w * h; i++) {
        const [r, b] = format === 'bgr8' ? [data[i * 3 + 2]!, data[i * 3]!] : [data[i * 3]!, data[i * 3 + 2]!];
        out.set([r, data[i * 3 + 1]!, b, 255], i * 4);
      }
      return out;
    case 'r5g6b5':
      for (let i = 0; i < w * h; i++) {
        const [r, g, b] = rgb565(data[i * 2]! | (data[i * 2 + 1]! << 8));
        out.set([r, g, b, 255], i * 4);
      }
      return out;
    case 'l8':
      for (let i = 0; i < w * h; i++) out.set([data[i]!, data[i]!, data[i]!, 255], i * 4);
      return out;
  }
  if (!isCompressed(format) || format === 'bc7') return undefined;
  const bw = Math.max(1, Math.ceil(w / 4));
  const bh = Math.max(1, Math.ceil(h / 4));
  const bb = blockBytes(format);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const o = (by * bw + bx) * bb;
      const x0 = bx * 4;
      const y0 = by * 4;
      if (format === 'bc1') decodeColorBlock(data, o, out, w, x0, y0, h, true);
      else if (format === 'bc2') {
        decodeColorBlock(data, o + 8, out, w, x0, y0, h, false);
        for (let i = 0; i < 16; i++) {
          const x = x0 + (i % 4);
          const y = y0 + Math.floor(i / 4);
          if (x >= w || y >= h) continue;
          const nib = (data[o + (i >> 1)]! >> ((i & 1) * 4)) & 0xf;
          out[(y * w + x) * 4 + 3] = nib * 17;
        }
      } else if (format === 'bc3') {
        decodeColorBlock(data, o + 8, out, w, x0, y0, h, false);
        const a = decodeAlphaBlock(data, o);
        for (let i = 0; i < 16; i++) {
          const x = x0 + (i % 4);
          const y = y0 + Math.floor(i / 4);
          if (x < w && y < h) out[(y * w + x) * 4 + 3] = a[i]!;
        }
      } else if (format === 'bc4' || format === 'bc5') {
        const r = decodeAlphaBlock(data, o);
        const g = format === 'bc5' ? decodeAlphaBlock(data, o + 8) : r;
        for (let i = 0; i < 16; i++) {
          const x = x0 + (i % 4);
          const y = y0 + Math.floor(i / 4);
          if (x >= w || y >= h) continue;
          const d = (y * w + x) * 4;
          out[d] = r[i]!;
          out[d + 1] = format === 'bc5' ? g[i]! : r[i]!;
          out[d + 2] = format === 'bc5' ? 255 : r[i]!;
          out[d + 3] = 255;
        }
      }
    }
  }
  return out;
}

/** Build a minimal uncompressed RGBA8 DDS (used by tests and for generated tint masks). */
export function writeRgbaDds(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(128 + width * height * 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, FOURCC('DDS '), true);
  dv.setUint32(4, 124, true);
  dv.setUint32(8, 0x1 | 0x2 | 0x4 | 0x1000 | 0x8, true);
  dv.setUint32(12, height, true);
  dv.setUint32(16, width, true);
  dv.setUint32(20, width * 4, true);
  dv.setUint32(28, 1, true);
  dv.setUint32(76, 32, true);
  dv.setUint32(80, 0x40 | 0x1, true);
  dv.setUint32(88, 32, true);
  dv.setUint32(92, 0x000000ff, true);
  dv.setUint32(96, 0x0000ff00, true);
  dv.setUint32(100, 0x00ff0000, true);
  dv.setUint32(104, 0xff000000, true);
  dv.setUint32(108, 0x1000, true);
  out.set(rgba, 128);
  return out;
}

// ------------------------------------------------------------------ BC3 encoding

const to565 = (r: number, g: number, b: number) => (Math.round((Math.max(0, Math.min(255, r)) * 31) / 255) << 11) | (Math.round((Math.max(0, Math.min(255, g)) * 63) / 255) << 5) | Math.round((Math.max(0, Math.min(255, b)) * 31) / 255);

/** The four colours a BC1/BC3 colour block decodes to (as this module's decoder rounds them). */
function palette4(c0: number, c1: number): number[][] {
  const p0 = rgb565(c0);
  const p1 = rgb565(c1);
  return [p0, p1, p0.map((v, i) => Math.floor((2 * v + p1[i]!) / 3)), p0.map((v, i) => Math.floor((v + 2 * p1[i]!) / 3))];
}

function fitIndices(px: Float64Array, c0: number, c1: number): { bits: number; err: number } {
  const pal = palette4(c0, c1);
  let bits = 0;
  let err = 0;
  for (let i = 0; i < 16; i++) {
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < 4; k++) {
      const p = pal[k]!;
      const d = (px[i * 3]! - p[0]!) ** 2 + (px[i * 3 + 1]! - p[1]!) ** 2 + (px[i * 3 + 2]! - p[2]!) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    err += bestD;
    bits |= best << (2 * i);
  }
  return { bits: bits >>> 0, err };
}

const expand = (q: number, bits: number) => (bits === 5 ? (q << 3) | (q >> 2) : (q << 2) | (q >> 4));
const singleTables = new Map<number, Uint8Array>();
/** For each 0–255 value, the endpoint pair (a, b) whose ⅔a + ⅓b comes closest (packed a<<8|b in two bytes). */
function singleTable(bits: number): Uint8Array {
  let t = singleTables.get(bits);
  if (t) return t;
  t = new Uint8Array(512);
  const n = 1 << bits;
  for (let v = 0; v < 256; v++) {
    let best = Infinity;
    for (let a = 0; a < n; a++)
      for (let b = 0; b < n; b++) {
        const d = Math.abs(Math.floor((2 * expand(a, bits) + expand(b, bits)) / 3) - v);
        if (d < best) {
          best = d;
          t[v * 2] = a;
          t[v * 2 + 1] = b;
        }
      }
  }
  singleTables.set(bits, t);
  return t;
}

function writeColorBlock(out: Uint8Array, o: number, c0: number, c1: number, bits: number): void {
  out[o] = c0 & 255;
  out[o + 1] = c0 >> 8;
  out[o + 2] = c1 & 255;
  out[o + 3] = c1 >> 8;
  out[o + 4] = bits & 255;
  out[o + 5] = (bits >>> 8) & 255;
  out[o + 6] = (bits >>> 16) & 255;
  out[o + 7] = (bits >>> 24) & 255;
}

/** A block of one colour, matched exactly where possible through the ⅔/⅓ palette entry. */
function encodeSingleColor(r: number, g: number, b: number, out: Uint8Array, o: number): void {
  const t5 = singleTable(5);
  const t6 = singleTable(6);
  const a = (t5[r * 2]! << 11) | (t6[g * 2]! << 5) | t5[b * 2]!;
  const z = (t5[r * 2 + 1]! << 11) | (t6[g * 2 + 1]! << 5) | t5[b * 2 + 1]!;
  if (a > z) writeColorBlock(out, o, a, z, 0xaaaaaaaa); // every pixel uses entry 2 = ⅔a + ⅓z
  else if (a < z) writeColorBlock(out, o, z, a, 0xffffffff); // swapped: entry 3 = ⅓z + ⅔a
  else writeColorBlock(out, o, a === 0xffff ? a : a + 1, a === 0xffff ? a - 1 : a, a === 0xffff ? 0 : 0x55555555);
}

/** Encode 16 RGB pixels (row-major, 0–255) as a 4-colour BC1-style block. */
function encodeColorBlock(px: Float64Array, out: Uint8Array, o: number): void {
  let flat = true;
  for (let i = 1; i < 16 && flat; i++) flat = px[i * 3] === px[0] && px[i * 3 + 1] === px[1] && px[i * 3 + 2] === px[2];
  if (flat) return encodeSingleColor(Math.round(px[0]!), Math.round(px[1]!), Math.round(px[2]!), out, o);
  const mean = [0, 0, 0];
  for (let i = 0; i < 16; i++) for (let c = 0; c < 3; c++) mean[c]! += px[i * 3 + c]! / 16;
  // Principal axis of the colours (power iteration on the covariance).
  const cov = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 16; i++) {
    const r = px[i * 3]! - mean[0]!;
    const g = px[i * 3 + 1]! - mean[1]!;
    const b = px[i * 3 + 2]! - mean[2]!;
    cov[0]! += r * r;
    cov[1]! += r * g;
    cov[2]! += r * b;
    cov[3]! += g * g;
    cov[4]! += g * b;
    cov[5]! += b * b;
  }
  let axis = [1, 1, 1];
  for (let it = 0; it < 8; it++) {
    const n = [cov[0]! * axis[0]! + cov[1]! * axis[1]! + cov[2]! * axis[2]!, cov[1]! * axis[0]! + cov[3]! * axis[1]! + cov[4]! * axis[2]!, cov[2]! * axis[0]! + cov[4]! * axis[1]! + cov[5]! * axis[2]!];
    const len = Math.hypot(n[0]!, n[1]!, n[2]!);
    if (len < 1e-9) break;
    axis = n.map((v) => v / len);
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 16; i++) {
    const t = (px[i * 3]! - mean[0]!) * axis[0]! + (px[i * 3 + 1]! - mean[1]!) * axis[1]! + (px[i * 3 + 2]! - mean[2]!) * axis[2]!;
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  const inset = (hi - lo) / 16;
  const e0 = mean.map((m, c) => m + axis[c]! * (hi - inset));
  const e1 = mean.map((m, c) => m + axis[c]! * (lo + inset));
  let c0 = to565(e0[0]!, e0[1]!, e0[2]!);
  let c1 = to565(e1[0]!, e1[1]!, e1[2]!);
  let best = { c0, c1, ...fitIndices(px, Math.max(c0, c1), Math.min(c0, c1)) };
  // Least-squares refinement of the endpoints for the chosen indices.
  for (let pass = 0; pass < 2 && c0 !== c1; pass++) {
    const w = [1, 0, 2 / 3, 1 / 3];
    let aa = 0, bb = 0, ab = 0;
    const ax = [0, 0, 0], bx = [0, 0, 0];
    for (let i = 0; i < 16; i++) {
      const a = w[(best.bits >>> (2 * i)) & 3]!;
      const b = 1 - a;
      aa += a * a;
      bb += b * b;
      ab += a * b;
      for (let c = 0; c < 3; c++) {
        ax[c]! += a * px[i * 3 + c]!;
        bx[c]! += b * px[i * 3 + c]!;
      }
    }
    const det = aa * bb - ab * ab;
    if (Math.abs(det) < 1e-9) break;
    const p = ax.map((v, c) => (v * bb - bx[c]! * ab) / det);
    const q = bx.map((v, c) => (v * aa - ax[c]! * ab) / det);
    c0 = to565(p[0]!, p[1]!, p[2]!);
    c1 = to565(q[0]!, q[1]!, q[2]!);
    const fit = fitIndices(px, Math.max(c0, c1), Math.min(c0, c1));
    if (fit.err >= best.err) break;
    best = { c0, c1, ...fit };
  }
  let hiC = Math.max(best.c0, best.c1);
  let loC = Math.min(best.c0, best.c1);
  let bits = best.bits;
  if (hiC === loC) {
    // One colour: 4-colour mode needs c0 > c1, so nudge c1 down and use index 0 throughout.
    if (hiC > 0) loC = hiC - 1;
    else hiC = 1;
    bits = fitIndices(px, hiC, loC).bits;
  }
  writeColorBlock(out, o, hiC, loC, bits);
}

/** Encode 16 alpha values as a BC3 alpha block (8-value mode). */
function encodeAlphaBlock(a: Float64Array, out: Uint8Array, o: number): void {
  let mx = 0;
  let mn = 255;
  for (let i = 0; i < 16; i++) {
    mx = Math.max(mx, Math.round(a[i]!));
    mn = Math.min(mn, Math.round(a[i]!));
  }
  out[o] = mx;
  out[o + 1] = mn;
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < 16; i++) {
    let idx = 0;
    if (mx > mn) {
      // Palette: 0 → mx, 1 → mn, 2..7 → (7-k)/7 steps from mx to mn.
      const t = Math.round(((mx - a[i]!) / (mx - mn)) * 7);
      idx = t <= 0 ? 0 : t >= 7 ? 1 : t + 1;
    }
    if (i < 8) lo |= idx << (3 * i);
    else hi |= idx << (3 * (i - 8));
  }
  out[o + 2] = lo & 255;
  out[o + 3] = (lo >> 8) & 255;
  out[o + 4] = (lo >> 16) & 255;
  out[o + 5] = hi & 255;
  out[o + 6] = (hi >> 8) & 255;
  out[o + 7] = (hi >> 16) & 255;
}

function encodeBc3Level(w: number, h: number, rgba: Uint8Array): Uint8Array {
  const bw = Math.max(1, Math.ceil(w / 4));
  const bh = Math.max(1, Math.ceil(h / 4));
  const out = new Uint8Array(bw * bh * 16);
  const px = new Float64Array(48);
  const al = new Float64Array(16);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      for (let i = 0; i < 16; i++) {
        const x = Math.min(w - 1, bx * 4 + (i % 4));
        const y = Math.min(h - 1, by * 4 + (i >> 2));
        const s = (y * w + x) * 4;
        px[i * 3] = rgba[s]!;
        px[i * 3 + 1] = rgba[s + 1]!;
        px[i * 3 + 2] = rgba[s + 2]!;
        al[i] = rgba[s + 3]!;
      }
      const o = (by * bw + bx) * 16;
      encodeAlphaBlock(al, out, o);
      encodeColorBlock(px, out, o + 8);
    }
  return out;
}

/** Half-size box filter. */
function halve(w: number, h: number, rgba: Uint8Array): { w: number; h: number; rgba: Uint8Array } {
  const nw = Math.max(1, w >> 1);
  const nh = Math.max(1, h >> 1);
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++)
    for (let x = 0; x < nw; x++)
      for (let c = 0; c < 4; c++) {
        let s = 0;
        let n = 0;
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const sx = Math.min(w - 1, x * 2 + dx);
            const sy = Math.min(h - 1, y * 2 + dy);
            s += rgba[(sy * w + sx) * 4 + c]!;
            n++;
          }
        out[(y * nw + x) * 4 + c] = Math.round(s / n);
      }
  return { w: nw, h: nh, rgba: out };
}

/**
 * Build a BC3 (DXT5) DDS with mipmaps down to `minSize`, laid out like the
 * Creation Kit's face tints (512² → 2², 9 levels, legacy DXT5 header).
 */
export function writeBc3Dds(width: number, height: number, rgba: Uint8Array, opts: { minSize?: number } = {}): Uint8Array {
  const minSize = opts.minSize ?? 1;
  const levels: Uint8Array[] = [];
  let cur = { w: width, h: height, rgba };
  for (;;) {
    levels.push(encodeBc3Level(cur.w, cur.h, cur.rgba));
    if (cur.w <= minSize || cur.h <= minSize || (cur.w === 1 && cur.h === 1)) break;
    cur = halve(cur.w, cur.h, cur.rgba);
  }
  const total = levels.reduce((s, l) => s + l.length, 0);
  const out = new Uint8Array(128 + total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, FOURCC('DDS '), true);
  dv.setUint32(4, 124, true);
  dv.setUint32(8, 0x1 | 0x2 | 0x4 | 0x1000 | 0x20000 | 0x80000, true);
  dv.setUint32(12, height, true);
  dv.setUint32(16, width, true);
  dv.setUint32(20, levels[0]!.length, true);
  dv.setUint32(28, levels.length, true);
  dv.setUint32(76, 32, true);
  dv.setUint32(80, 0x4, true);
  dv.setUint32(84, FOURCC('DXT5'), true);
  dv.setUint32(108, 0x1000 | (levels.length > 1 ? 0x8 | 0x400000 : 0), true);
  let o = 128;
  for (const l of levels) {
    out.set(l, o);
    o += l.length;
  }
  return out;
}
