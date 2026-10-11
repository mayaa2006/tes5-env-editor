/**
 * The editing engine, running in a worker thread of the main process with
 * real file system access. "Explore the demo" uses an in-memory data set so
 * nothing on disk is touched.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { MemoryFileSystem, createDemoData } from '@tes5/workspace';
import { NodeFileSystem, NodeProcessRunner } from '@tes5/workspace/node';
import { DEMO_GAME_DIR } from '../src/engine/constants';
import { EngineHost } from '../src/engine/host';

if (!parentPort) throw new Error('engine-worker must run as a worker thread');
const port = parentPort;

const real = new EngineHost(new NodeFileSystem(), new NodeProcessRunner(), (workerData as { caprica?: string } | null)?.caprica);
let demo: EngineHost | undefined;
let active = real;

function watch(host: EngineHost): void {
  host.onEvent((event) => {
    if (host === active) port.postMessage({ type: 'event', event });
  });
}
watch(real);

port.on('message', async (m: { id: number; method: string; args: unknown[] }) => {
  try {
    if (m.method === 'open') {
      const opts = m.args[0] as { kind?: string } | undefined;
      if (opts?.kind === 'demo') {
        if (!demo) {
          const fs = new MemoryFileSystem();
          createDemoData(fs, DEMO_GAME_DIR);
          demo = new EngineHost(fs);
          watch(demo);
        }
        active = demo;
      } else active = real;
    }
    const fn = (active as unknown as Record<string, unknown>)[m.method];
    if (typeof fn !== 'function' || m.method.startsWith('_') || m.method === 'constructor' || m.method === 'onEvent') throw new Error(`Unknown engine method ${m.method}`);
    const value = await (fn as (...a: unknown[]) => unknown).apply(active, m.args);
    port.postMessage({ id: m.id, ok: true, value });
  } catch (e) {
    port.postMessage({ id: m.id, ok: false, error: (e as Error).message ?? String(e) });
  }
});
