/** In-page engine on the synthetic demo data set (used when not running in Electron). */
import { MemoryFileSystem, createDemoData, type LocalAiControl, type LocalAiStatus } from '@tes5/workspace';
import type { HostBridge } from './client';
import { DEMO_GAME_DIR } from './constants';
import { EngineHost, type HostEvent } from './host';

export { DEMO_GAME_DIR };

export async function createDemoBridge(): Promise<HostBridge> {
  const fs = new MemoryFileSystem();
  createDemoData(fs, DEMO_GAME_DIR);
  const host = new EngineHost(fs);
  const listeners = new Set<(e: HostEvent) => void>();
  host.onEvent((e) => {
    for (const l of listeners) l(e);
  });
  // The built-in AI needs the desktop app (it downloads and runs a program); browser tests can stand in for it.
  const testLocalAi = (globalThis as { __tes5TestLocalAi?: (emit: (s: LocalAiStatus) => void) => LocalAiControl }).__tes5TestLocalAi;
  if (testLocalAi) host.localAi = testLocalAi((status) => listeners.forEach((l) => l({ type: 'localAi', status })));
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
