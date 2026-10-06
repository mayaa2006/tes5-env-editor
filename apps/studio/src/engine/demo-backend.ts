/** In-page engine on the synthetic demo data set (used when not running in Electron). */
import { MemoryFileSystem, createDemoData, type WorkspaceEvent } from '@tes5/workspace';
import type { HostBridge } from './client';
import { DEMO_GAME_DIR } from './constants';
import { EngineHost } from './host';

export { DEMO_GAME_DIR };

export async function createDemoBridge(): Promise<HostBridge> {
  const fs = new MemoryFileSystem();
  createDemoData(fs, DEMO_GAME_DIR);
  const host = new EngineHost(fs);
  const listeners = new Set<(e: WorkspaceEvent) => void>();
  host.onEvent((e) => {
    for (const l of listeners) l(e);
  });
  return {
    async invoke(method, args) {
      try {
        const fn = (host as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
        if (typeof fn !== 'function' || method.startsWith('_')) throw new Error(`Unknown engine method ${method}`);
        // Clone like Electron IPC would, so the UI never shares mutable state with the engine.
        const value = await fn.apply(host, structuredClone(args));
        return { ok: true, value: value === undefined ? undefined : structuredClone(value) };
      } catch (e) {
        console.error(`[engine] ${method} failed`, e);
        return { ok: false, error: (e as Error).message };
      }
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    platform: 'web',
  };
}
