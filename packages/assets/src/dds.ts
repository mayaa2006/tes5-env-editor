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
