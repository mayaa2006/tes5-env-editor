import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/** Corrupted inputs (plugins, NIF, DDS, BSA, TRI) must fail cleanly and quickly. */
import { parsePlugin } from '@tes5/esp';
import { BsaArchive, bufferSource, decodeToRgba, flattenMeshes, parseDds, parseNif, parseTri, writeBsa } from '@tes5/assets';
import { MemoryFileSystem, createDemoData } from '@tes5/workspace';
import { DEMO_GAME_DIR } from '../../src/engine/constants';

let seed = Number(process.env.SEED ?? 3);
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const fs = new MemoryFileSystem();
createDemoData(fs, DEMO_GAME_DIR);
const files = new Map<string, Uint8Array>();
for await (const p of (async function* () {
  const stack = [DEMO_GAME_DIR];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of await fs.readdir(d)) {
      const full = `${d}/${e.name}`;
      if (e.isDirectory) stack.push(full);
      else yield full;
    }
  }
})()) if (/\.(esm|esp|nif|dds|tri)$/i.test(p)) files.set(p, await fs.readFile(p));
const bsa = writeBsa(new Map([...files].filter(([p]) => /\.(nif|dds)$/.test(p)).slice(0, 20).map(([p, d]) => [p.split('/Data/')[1]!, d] as const)), { version: 105, compress: true });
console.log(`test archive: ${new BsaArchive(bufferSource(bsa)).files.length} files`);
files.set('test.bsa', bsa);

const parsers: Record<string, (b: Uint8Array) => unknown> = {
  esm: (b) => { const p = parsePlugin(b, 'x.esm'); for (const r of p.records()) void r.subrecords; return p; },
  esp: (b) => { const p = parsePlugin(b, 'x.esp'); for (const r of p.records()) void r.subrecords; return p; },
  nif: (b) => flattenMeshes(parseNif(b)),
  dds: (b) => { const d = parseDds(b); return d.mipmaps[0] && decodeToRgba(d.mipmaps[0], d.format); },
  tri: (b) => parseTri(b),
  bsa: (b) => { const a = new BsaArchive(bufferSource(b), 'x.bsa'); for (const f of a.files) a.read(f); },
};
let bad = 0;
const seen = new Set<string>();
const N = Number(process.env.ITER ?? 400);
for (const [path, orig] of files) {
  const ext = path.split('.').pop()!.toLowerCase();
  const parse = parsers[ext]!;
  for (let n = 0; n < N / files.size + 3; n++) {
    const b = orig.slice();
    const mode = rnd();
    let data = b;
    if (mode < 0.5) for (let k = 0; k < 1 + rnd() * 8; k++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
    else if (mode < 0.8) data = b.subarray(0, Math.floor(rnd() * b.length));
    else { const at = Math.floor(rnd() * (b.length - 4)); new DataView(b.buffer).setUint32(at, 0xfffffff0 >>> Math.floor(rnd() * 16), true); }
    if (process.env.TRACE) require('node:fs').writeFileSync('/tmp/claude-0/-home-user-tes5-env-editor/ee8d8574-b64c-5123-8295-60d16d977452/scratchpad/last-input.bin', data), require('node:fs').writeFileSync('/tmp/claude-0/-home-user-tes5-env-editor/ee8d8574-b64c-5123-8295-60d16d977452/scratchpad/last-input.txt', ext + ' ' + path);
    const t0 = performance.now();
    try {
      await parse(data);
    } catch (e) {
      const err = e as Error;
      if (err instanceof RangeError && /Array buffer allocation|Invalid typed array length|Maximum call stack/.test(err.message)) {
        bad++;
        const k = `${ext}: ${err.message}`;
        if (!seen.has(k)) (seen.add(k), console.log('BAD', k, err.stack?.split('\n')[1]?.trim()));
      }
    }
    const ms = performance.now() - t0;
    if (ms > 2000) {
      bad++;
      console.log(`SLOW ${ext} ${ms.toFixed(0)}ms (${path})`);
    }
  }
}
console.log(`${files.size} files fuzzed, ${bad} problem(s)`);
process.exitCode = bad ? 1 : 0;
