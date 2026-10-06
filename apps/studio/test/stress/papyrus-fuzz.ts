/** Fuzz the Papyrus language service: random edits of real scripts must never throw. */
import { MemoryFileSystem, createDemoData, Workspace, ScriptService } from '@tes5/workspace';
import { STUB_SOURCES } from '@tes5/papyrus';
import { DEMO_GAME_DIR } from '../../src/engine/constants';

let seed = Number(process.env.SEED ?? 7);
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const fs = new MemoryFileSystem();
const demo = createDemoData(fs, DEMO_GAME_DIR);
const ws = new Workspace(fs, { game: 'SkyrimSE', roots: [demo.dataDir], outputDir: demo.dataDir, loadOrder: [{ name: 'DemoWorld.esm', active: true }] });
await ws.scan();
await ws.load();
const scripts = new ScriptService(ws);
scripts.refresh();
const corpus: string[] = [...Object.values(STUB_SOURCES as Record<string, string>)];
for (const s of scripts.list()) corpus.push(await scripts.read(s.name));
const snippets = ['(', ')', '"', ';/', '/;', '{', '}', '\\\n', 'EndFunction', 'If x', 'EndIf', 'While', '.', ',', 'as', 'new Int[', ']', 'Property', 'Auto', 'State', 'EndState', '\n', '  ', 'Self.', 'Game.GetPlayer().', '0x', '1.5e', '"unterminated', 'Event OnInit()', 'Function F(Int a = '];
let crashes = 0;
const seen = new Set<string>();
const iterations = Number(process.env.ITER ?? 3000);
for (let n = 0; n < iterations; n++) {
  let src = corpus[Math.floor(rnd() * corpus.length)]!;
  const edits = 1 + Math.floor(rnd() * 6);
  for (let e = 0; e < edits; e++) {
    const at = Math.floor(rnd() * (src.length + 1));
    const r = rnd();
    if (r < 0.4) src = src.slice(0, at) + src.slice(Math.min(src.length, at + Math.floor(rnd() * 40)));
    else src = src.slice(0, at) + snippets[Math.floor(rnd() * snippets.length)] + src.slice(at);
  }
  const off = Math.floor(rnd() * (src.length + 1));
  for (const [what, fn] of [
    ['check', () => scripts.check(src)],
    ['complete', () => scripts.complete(src, off)],
    ['hover', () => scripts.hover(src, off)],
    ['signature', () => scripts.signatureHelp(src, off)],
    ['outline', () => scripts.language.outline(src)],
  ] as const) {
    try {
      await fn();
    } catch (e) {
      const msg = `${what}: ${(e as Error).message}`;
      crashes++;
      if (!seen.has(msg)) {
        seen.add(msg);
        console.log(`CRASH ${msg}\n  at ${(e as Error).stack?.split('\n')[1]?.trim()}\n  input (offset ${off}): ${JSON.stringify(src.slice(Math.max(0, off - 60), off + 60))}`);
      }
    }
  }
}
console.log(`${iterations} fuzzed sources, ${crashes} crash(es), ${seen.size} distinct`);
process.exitCode = crashes ? 1 : 0;
