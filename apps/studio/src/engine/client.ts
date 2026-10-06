/**
 * How the UI talks to the engine. In Electron the engine runs in a worker
 * thread of the main process (real files); in a plain browser it runs in-page
 * on the synthetic demo data set. Both look the same to the UI.
 */
import type { WorkspaceEvent } from '@tes5/workspace';
import type { EngineHost, EngineMethod } from './host';

/** Workspace events, plus the desktop host telling us the engine was restarted after a crash. */
export type EngineEvent = WorkspaceEvent | { type: 'engineRestarted'; message: string };

type Fn<M extends EngineMethod> = EngineHost[M] extends (...args: infer A) => infer R ? { args: A; result: Awaited<R> } : never;

export interface HostBridge {
  invoke(method: string, args: unknown[]): Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;
  onEvent(cb: (e: EngineEvent) => void): () => void;
  openFolder?(title: string): Promise<string | null>;
  openFile?(title: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
  showItemInFolder?(path: string): void;
  platform?: string;
}

declare global {
  interface Window {
    tes5Host?: HostBridge;
  }
}

export class EngineClient {
  private constructor(
    private readonly bridge: HostBridge,
    readonly mode: 'electron' | 'demo',
  ) {}

  static async create(): Promise<EngineClient> {
    if (window.tes5Host) return new EngineClient(window.tes5Host, 'electron');
    const { createDemoBridge } = await import('./demo-backend');
    return new EngineClient(await createDemoBridge(), 'demo');
  }

  async call<M extends EngineMethod>(method: M, ...args: Fn<M>['args']): Promise<Fn<M>['result']> {
    const res = await this.bridge.invoke(method, args as unknown[]);
    if (!res.ok) throw new EngineError(res.error, method);
    return res.value as Fn<M>['result'];
  }

  onEvent(cb: (e: EngineEvent) => void): () => void {
    return this.bridge.onEvent(cb);
  }

  get canPickFolders(): boolean {
    return !!this.bridge.openFolder;
  }

  openFolder(title: string): Promise<string | null> {
    return this.bridge.openFolder ? this.bridge.openFolder(title) : Promise.resolve(null);
  }

  openFile(title: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null> {
    return this.bridge.openFile ? this.bridge.openFile(title, filters) : Promise.resolve(null);
  }

  showItemInFolder(path: string): void {
    this.bridge.showItemInFolder?.(path);
  }
}

export class EngineError extends Error {
  constructor(
    message: string,
    readonly method: string,
  ) {
    super(message);
  }
}
