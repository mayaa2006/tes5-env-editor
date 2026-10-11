import { create } from 'zustand';
import type { FormKey } from '@tes5/esp';
import type { EngineClient } from '../engine/client';
import type { SessionInfo } from '../engine/host';

export type WorkspaceTab = 'scene' | 'npc' | 'body' | 'items' | 'magic' | 'quest' | 'script' | 'records' | 'clean' | 'automations' | 'plugins' | 'release';

/** Where you are in the Items or Magic workspace: the category and the record open in it. */
export interface CatalogPlace {
  category: string;
  record?: FormKey;
}

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  text: string;
}

export interface CompileOutput {
  script: string;
  ok: boolean;
  messages: { file?: string; line?: number; col?: number; severity: string; message: string }[];
  output: string;
}

/** Background script compiling: progress plus the latest result for each script. */
export interface CompileState {
  running: boolean;
  done: number;
  total: number;
  report: CompileOutput[];
}

export interface LogEntry {
  time: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  text: string;
}

export interface Settings {
  /** The compiler chosen by hand; with no path the app picks one (Caprica, which comes with it). */
  compilerKind: 'papyrus-compiler' | 'caprica';
  compilerPath: string;
  /** Compile your changed scripts when saving (a script in the background, or the plugin), like the Creation Kit. */
  autoCompileOnSave: boolean;
  autoCleanOnSave: boolean;
  updateBoundsOnSave: boolean;
  generateSeqOnSave: boolean;
  /** Bake FaceGen for changed characters on save, so no Creation Kit is needed. */
  generateFacesOnSave: boolean;
  snapMove: number;
  snapRotateDeg: number;
  snapScale: number;
  showMarkers: boolean;
  /** Editor-only shapes inside furniture and props (lean, sit and landing markers). */
  showMarkerShapes: boolean;
  /** Rings of cells loaded around an outdoor cell: 0 = just the cell, 1 = 3×3, 2 = 5×5. */
  surroundingCells: number;
  /** Draw characters with their body, clothes and head (off: simple capsules). */
  actorModels: boolean;
  /** While moving (G), snap edges flush to nearby pieces. */
  kitSnap: boolean;
  /** Properties panel shown per workspace (designers have their own editors, so it starts hidden there). */
  inspector: Partial<Record<WorkspaceTab, boolean>>;
  textured: boolean;
  /** MO2 executable to start for test launches (as named in MO2). */
  mo2Executable: string;
  /** Path to ModOrganizer.exe when it isn't in the instance folder. */
  mo2Exe: string;
  /** Anthropic API key for planning quests with Claude (kept on this computer). */
  anthropicApiKey: string;
  /** Which AI plans quests and writes journals: Claude, Ollama on this computer, or an OpenAI-style service. */
  aiKind: 'claude' | 'ollama' | 'openai';
  ollamaUrl: string;
  ollamaModel: string;
  openaiUrl: string;
  openaiKey: string;
  openaiModel: string;
  /** Save everything into a folder of the user's choosing instead of Data / MO2 Overwrite. */
  saveToFolder: boolean;
  saveFolder: string;
}

const DEFAULT_SETTINGS: Settings = {
  compilerKind: 'caprica',
  compilerPath: '',
  autoCompileOnSave: true,
  autoCleanOnSave: true,
  updateBoundsOnSave: true,
  generateSeqOnSave: true,
  generateFacesOnSave: true,
  snapMove: 16,
  snapRotateDeg: 15,
  snapScale: 0.1,
  showMarkers: true,
  showMarkerShapes: false,
  surroundingCells: 1,
  actorModels: true,
  kitSnap: true,
  inspector: { npc: false, quest: false, items: false, magic: false },
  textured: true,
  mo2Executable: 'SKSE',
  mo2Exe: '',
  anthropicApiKey: '',
  aiKind: 'claude',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: '',
  openaiUrl: '',
  openaiKey: '',
  openaiModel: '',
  saveToFolder: false,
  saveFolder: '',
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
  catalog: { items: CatalogPlace; magic: CatalogPlace };
  /** Bumped whenever the engine reports a change; views re-query on change. */
  revision: number;
  /** A request (from an empty screen) for a list to open its New dialog; `n` changes on each request. */
  newRequest?: { kind: 'npc' | 'quest' | 'script'; n: number };
  requestNew(kind: 'npc' | 'quest' | 'script'): void;
  /** Take a pending New request for this kind (true if there was one). */
  takeNew(kind: 'npc' | 'quest' | 'script'): boolean;
  toasts: Toast[];
  log: LogEntry[];
  settings: Settings;
  busy?: string;
  compile: CompileState;
  /** Set when an edit needs a plugin to go into; the edit is retried once one exists. */
  pluginPrompt?: { retry?: () => Promise<unknown> };

  setClient(c: EngineClient): void;
  setSession(s: SessionInfo): void;
  setTab(t: WorkspaceTab): void;
  select(k?: FormKey): void;
  /** Show (or hide) the properties panel in the current workspace. */
  setInspector(open: boolean): void;
  /** Select a form and make sure the properties panel is visible. */
  showProperties(k: FormKey): void;
  setSceneSelection(keys: FormKey[]): void;
  setCell(k?: FormKey): void;
  setQuest(k?: FormKey): void;
  setNpc(k?: FormKey): void;
  /** Open a category (and optionally a record) in the Items or Magic workspace. */
  openCatalog(tab: 'items' | 'magic', place: Partial<CatalogPlace>): void;
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
  catalog: { items: { category: 'weapons' }, magic: { category: 'spells' } },
  revision: 0,
  toasts: [],
  log: [],
  settings: loadSettings(),

  setClient: (client) => set({ client }),
  setSession: (session) => set({ session }),
  setTab: (tab) => set({ tab }),
  select: (selected) => set({ selected }),
  setInspector: (open) => get().updateSettings({ inspector: { ...get().settings.inspector, [get().tab]: open } }),
  showProperties: (k) => {
    set({ selected: k });
    get().setInspector(true);
  },
  setSceneSelection: (sceneSelection) => set({ sceneSelection, selected: sceneSelection[sceneSelection.length - 1] ?? get().selected }),
  setCell: (cell) => set({ cell, sceneSelection: [] }),
  setQuest: (quest) => set({ quest, selected: quest }),
  setNpc: (npc) => set({ npc, selected: npc }),
  openCatalog: (tab, place) => {
    const cur = get().catalog[tab];
    const next = { ...cur, ...place };
    if (place.category && place.category !== cur.category && !('record' in place)) next.record = undefined;
    set({ catalog: { ...get().catalog, [tab]: next } });
  },
  setScript: (script) => set({ script }),
  requestNew: (kind) => set({ newRequest: { kind, n: (get().newRequest?.n ?? 0) + 1 } }),
  takeNew: (kind) => {
    if (get().newRequest?.kind !== kind) return false;
    set({ newRequest: undefined });
    return true;
  },
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
  compile: { running: false, done: 0, total: 0, report: [] },
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
