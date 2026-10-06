import { create } from 'zustand';
import type { FormKey } from '@tes5/esp';
import type { EngineClient } from '../engine/client';
import type { SessionInfo } from '../engine/host';

export type WorkspaceTab = 'scene' | 'npc' | 'quest' | 'script' | 'records' | 'clean' | 'automations' | 'plugins';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  text: string;
}

export interface LogEntry {
  time: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  text: string;
}

export interface Settings {
  compilerKind: 'papyrus-compiler' | 'caprica';
  compilerPath: string;
  autoCleanOnSave: boolean;
  updateBoundsOnSave: boolean;
  generateSeqOnSave: boolean;
  snapMove: number;
  snapRotateDeg: number;
  snapScale: number;
  showMarkers: boolean;
  textured: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  compilerKind: 'papyrus-compiler',
  compilerPath: '',
  autoCleanOnSave: true,
  updateBoundsOnSave: true,
  generateSeqOnSave: true,
  snapMove: 16,
  snapRotateDeg: 15,
  snapScale: 0.1,
  showMarkers: true,
  textured: true,
};

function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('tes5.settings') ?? '{}') };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

interface Store {
  client?: EngineClient;
  session: SessionInfo;
  tab: WorkspaceTab;
  /** Record shown in the properties/record editor. */
  selected?: FormKey;
  /** References selected in the viewport. */
  sceneSelection: FormKey[];
  cell?: FormKey;
  quest?: FormKey;
  npc?: FormKey;
  script?: string;
  /** Bumped whenever the engine reports a change; views re-query on change. */
  revision: number;
  toasts: Toast[];
  log: LogEntry[];
  settings: Settings;
  busy?: string;
  /** Set when an edit needs a plugin to go into; the edit is retried once one exists. */
  pluginPrompt?: { retry?: () => Promise<unknown> };

  setClient(c: EngineClient): void;
  setSession(s: SessionInfo): void;
  setTab(t: WorkspaceTab): void;
  select(k?: FormKey): void;
  setSceneSelection(keys: FormKey[]): void;
  setCell(k?: FormKey): void;
  setQuest(k?: FormKey): void;
  setNpc(k?: FormKey): void;
  setScript(n?: string): void;
  bump(): void;
  toast(kind: Toast['kind'], text: string): void;
  dismiss(id: number): void;
  addLog(kind: LogEntry['kind'], text: string): void;
  updateSettings(p: Partial<Settings>): void;
  setBusy(text?: string): void;
  setPluginPrompt(p?: { retry?: () => Promise<unknown> }): void;
}

let toastId = 1;

export const useStore = create<Store>((set, get) => ({
  session: { open: false, dirty: false, canUndo: false, canRedo: false, loadOrder: [] },
  tab: 'scene',
  sceneSelection: [],
  revision: 0,
  toasts: [],
  log: [],
  settings: loadSettings(),

  setClient: (client) => set({ client }),
  setSession: (session) => set({ session }),
  setTab: (tab) => set({ tab }),
  select: (selected) => set({ selected }),
  setSceneSelection: (sceneSelection) => set({ sceneSelection, selected: sceneSelection[sceneSelection.length - 1] ?? get().selected }),
  setCell: (cell) => set({ cell, sceneSelection: [] }),
  setQuest: (quest) => set({ quest, selected: quest }),
  setNpc: (npc) => set({ npc, selected: npc }),
  setScript: (script) => set({ script }),
  bump: () => set({ revision: get().revision + 1 }),
  toast: (kind, text) => {
    const id = toastId++;
    set({ toasts: [...get().toasts, { id, kind, text }] });
    get().addLog(kind, text);
    setTimeout(() => get().dismiss(id), kind === 'error' ? 8000 : 4000);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  addLog: (kind, text) => set({ log: [...get().log.slice(-499), { time: Date.now(), kind, text }] }),
  updateSettings: (p) => {
    const settings = { ...get().settings, ...p };
    try {
      localStorage.setItem('tes5.settings', JSON.stringify(settings));
    } catch {
      // storage unavailable
    }
    set({ settings });
  },
  setBusy: (busy) => set({ busy }),
  setPluginPrompt: (pluginPrompt) => set({ pluginPrompt }),
}));

/** Call the engine with error reporting; returns undefined on failure. */
export async function engine<T>(fn: (c: EngineClient) => Promise<T>, opts: { busy?: string; success?: string; refreshSession?: boolean } = {}): Promise<T | undefined> {
  const s = useStore.getState();
  const c = s.client;
  if (!c) return undefined;
  if (opts.busy) s.setBusy(opts.busy);
  try {
    const r = await fn(c);
    if (opts.success) s.toast('success', opts.success);
    if (opts.refreshSession ?? true) s.setSession(await c.call('session'));
    return r;
  } catch (e) {
    const msg = (e as Error).message;
    if (/^No active plugin/.test(msg)) {
      // Ask for a plugin to hold the change, then apply it.
      s.setPluginPrompt({ retry: () => engine(fn, opts) });
      return undefined;
    }
    s.toast('error', msg);
    return undefined;
  } finally {
    if (opts.busy) s.setBusy(undefined);
  }
}
