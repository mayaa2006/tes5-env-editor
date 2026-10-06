/**
 * LZ4 block and frame codec (pure TypeScript). Skyrim SE archives (BSA v105)
 * store compressed files as LZ4 frames.
 */

const FRAME_MAGIC = 0x184d2204;

// ------------------------------------------------------------------ xxHash32

const P1 = 2654435761;
const P2 = 2246822519;
const P3 = 3266489917;
const P4 = 668265263;
const P5 = 374761393;

function rotl(x: number, r: number): number {
  return ((x << r) | (x >>> (32 - r))) >>> 0;
}

function readU32(b: Uint8Array, i: number): number {
  return (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
}

export function xxh32(data: Uint8Array, seed = 0): number {
  const len = data.byteLength;
  let i = 0;
  let h: number;
  if (len >= 16) {
    let v1 = (seed + P1 + P2) >>> 0;
    let v2 = (seed + P2) >>> 0;
    let v3 = seed >>> 0;
    let v4 = (seed - P1) >>> 0;
    const limit = len - 16;
    while (i <= limit) {
      v1 = Math.imul(rotl((v1 + Math.imul(readU32(data, i), P2)) >>> 0, 13), P1) >>> 0;
      v2 = Math.imul(rotl((v2 + Math.imul(readU32(data, i + 4), P2)) >>> 0, 13), P1) >>> 0;
      v3 = Math.imul(rotl((v3 + Math.imul(readU32(data, i + 8), P2)) >>> 0, 13), P1) >>> 0;
      v4 = Math.imul(rotl((v4 + Math.imul(readU32(data, i + 12), P2)) >>> 0, 13), P1) >>> 0;
      i += 16;
    }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) >>> 0;
  } else {
    h = (seed + P5) >>> 0;
  }
  h = (h + len) >>> 0;
  while (i + 4 <= len) {
    h = Math.imul(rotl((h + Math.imul(readU32(data, i), P3)) >>> 0, 17), P4) >>> 0;
    i += 4;
  }
  while (i < len) {
    h = Math.imul(rotl((h + Math.imul(data[i]!, P5)) >>> 0, 11), P1) >>> 0;
    i++;
  }
  h ^= h >>> 15;
  h = Math.imul(h, P2) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, P3) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

// ------------------------------------------------------------------ block

/** Decode one LZ4 block into `out` starting at `outPos`. Returns the new output position. */
export function decodeBlock(src: Uint8Array, out: Uint8Array, outPos = 0): number {
  let ip = 0;
  let op = outPos;
  const n = src.byteLength;
  while (ip < n) {
    const token = src[ip++]!;
    let litLen = token >>> 4;
    if (litLen === 15) {
      let b: number;
      do {
        b = src[ip++]!;
        litLen += b;
      } while (b === 255 && ip < n);
    }
    if (op + litLen > out.byteLength) throw new Error('LZ4: output overflow');
    out.set(src.subarray(ip, ip + litLen), op);
    ip += litLen;
    op += litLen;
    if (ip >= n) break; // last sequence: literals only
    const offset = src[ip]! | (src[ip + 1]! << 8);
    ip += 2;
    if (offset === 0 || offset > op) throw new Error('LZ4: invalid match offset');
    let matchLen = (token & 15) + 4;
    if ((token & 15) === 15) {
      let b: number;
      do {
        b = src[ip++]!;
        matchLen += b;
      } while (b === 255 && ip < n);
    }
    if (op + matchLen > out.byteLength) throw new Error('LZ4: output overflow');
    let m = op - offset;
    if (offset >= matchLen) {
      out.copyWithin(op, m, m + matchLen);
      op += matchLen;
    } else {
      for (let k = 0; k < matchLen; k++) out[op++] = out[m++]!;
    }
  }
  return op;
}

/** Greedy LZ4 block compressor (fast, decent ratio). */
export function encodeBlock(src: Uint8Array): Uint8Array {
  const n = src.byteLength;
  const out = new Uint8Array(n + Math.ceil(n / 255) + 16);
  let op = 0;
  let anchor = 0;
  const HASH_BITS = 16;
  const table = new Int32Array(1 << HASH_BITS).fill(-1);
  const hash = (i: number) => (Math.imul(readU32(src, i), 2654435761) >>> (32 - HASH_BITS));
  const MFLIMIT = 12;
  const LAST_LITERALS = 5;
  let ip = 0;

  const writeLen = (len: number) => {
    while (len >= 255) {
      out[op++] = 255;
      len -= 255;
    }
    out[op++] = len;
  };

  if (n >= MFLIMIT + 1) {
    while (ip < n - MFLIMIT) {
      const h = hash(ip);
      const ref = table[h]!;
      table[h] = ip;
      if (ref >= 0 && ip - ref <= 0xffff && readU32(src, ref) === readU32(src, ip)) {
        // extend match
        let mlen = 4;
        const maxLen = n - LAST_LITERALS - ip;
        while (mlen < maxLen && src[ref + mlen] === src[ip + mlen]) mlen++;
        const litLen = ip - anchor;
        const tokenPos = op++;
        let token = (Math.min(litLen, 15) << 4) | Math.min(mlen - 4, 15);
        if (litLen >= 15) writeLen(litLen - 15);
        out.set(src.subarray(anchor, ip), op);
        op += litLen;
        const offset = ip - ref;
        out[op++] = offset & 0xff;
        out[op++] = offset >>> 8;
        if (mlen - 4 >= 15) writeLen(mlen - 4 - 15);
        out[tokenPos] = token;
        token = 0;
        ip += mlen;
        anchor = ip;
        continue;
      }
      ip++;
    }
  }
  // last literals
  const litLen = n - anchor;
  out[op++] = Math.min(litLen, 15) << 4;
  if (litLen >= 15) writeLen(litLen - 15);
  out.set(src.subarray(anchor), op);
  op += litLen;
  return out.slice(0, op);
}

// ------------------------------------------------------------------ frame

export function isLz4Frame(data: Uint8Array): boolean {
  return data.byteLength >= 4 && readU32(data, 0) === FRAME_MAGIC;
}

/** Decode an LZ4 frame. `sizeHint` is used when the frame has no content size. */
export function decompressFrame(data: Uint8Array, sizeHint?: number): Uint8Array {
  if (!isLz4Frame(data)) throw new Error('LZ4: bad frame magic');
  let p = 4;
  const flg = data[p++]!;
  const bd = data[p++]!;
  if ((flg >> 6) !== 1) throw new Error('LZ4: unsupported frame version');
  const blockChecksum = (flg & 0x10) !== 0;
  const hasContentSize = (flg & 0x08) !== 0;
  const contentChecksum = (flg & 0x04) !== 0;
  const hasDictId = (flg & 0x01) !== 0;
  let contentSize = sizeHint;
  if (hasContentSize) {
    const lo = readU32(data, p);
    const hi = readU32(data, p + 4);
    contentSize = hi * 0x100000000 + lo;
    p += 8;
  }
  if (hasDictId) p += 4;
  p++; // header checksum
  const blockMax = [0, 0, 0, 0, 1 << 16, 1 << 18, 1 << 20, 1 << 22][(bd >> 4) & 7] ?? 1 << 22;
  // A corrupt header can claim any size; never trust more than ~255:1 expansion of the input.
  if (contentSize !== undefined && contentSize > data.byteLength * 256 + 1024) throw new Error(`LZ4 frame claims ${contentSize} bytes from ${data.byteLength} (corrupt data)`);
  let out = new Uint8Array(contentSize ?? blockMax);
  let op = 0;
  for (;;) {
    const size = readU32(data, p);
    p += 4;
    if (size === 0) break;
    const uncompressed = (size & 0x80000000) !== 0;
    const len = size & 0x7fffffff;
    const block = data.subarray(p, p + len);
    p += len;
    if (blockChecksum) p += 4;
    if (op + blockMax > out.byteLength && contentSize === undefined) {
      const bigger = new Uint8Array(Math.max(out.byteLength * 2, op + blockMax));
      bigger.set(out.subarray(0, op));
      out = bigger;
    }
    if (uncompressed) {
      out.set(block, op);
      op += len;
    } else {
      op = decodeBlock(block, out, op);
    }
  }
  if (contentChecksum) p += 4;
  return op === out.byteLength ? out : out.slice(0, op);
}

/** Encode an LZ4 frame with independent 4 MiB blocks, content size and checksum. */
export function compressFrame(data: Uint8Array): Uint8Array {
  const BLOCK = 1 << 22;
  const parts: Uint8Array[] = [];
  const header = new Uint8Array(4 + 2 + 8 + 1);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, FRAME_MAGIC, true);
  header[4] = 0x60 | 0x08 | 0x04; // version 01, block independence, content size, content checksum
  header[5] = 0x70; // 4 MiB max block size
  dv.setUint32(6, data.byteLength >>> 0, true);
  dv.setUint32(10, Math.floor(data.byteLength / 0x100000000), true);
  header[14] = (xxh32(header.subarray(4, 14)) >>> 8) & 0xff;
  parts.push(header);
  for (let off = 0; off < data.byteLength; off += BLOCK) {
    const chunk = data.subarray(off, Math.min(off + BLOCK, data.byteLength));
    const enc = encodeBlock(chunk);
    const sizeBuf = new Uint8Array(4);
    if (enc.byteLength >= chunk.byteLength) {
      new DataView(sizeBuf.buffer).setUint32(0, (chunk.byteLength | 0x80000000) >>> 0, true);
      parts.push(sizeBuf, chunk);
    } else {
      new DataView(sizeBuf.buffer).setUint32(0, enc.byteLength, true);
      parts.push(sizeBuf, enc);
    }
  }
  const tail = new Uint8Array(8);
  new DataView(tail.buffer).setUint32(4, xxh32(data), true);
  parts.push(tail);
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}
