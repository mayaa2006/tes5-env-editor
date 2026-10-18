/**
 * Electron main process: one window, and the editing engine in a worker
 * thread (so parsing a 250 MB master never freezes the UI). The renderer only
 * gets a narrow bridge: invoke an engine method, receive engine events, and
 * open native file dialogs.
 */
import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

let win: BrowserWindow | null = null;
let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (r: { ok: boolean; value?: unknown; error?: string }) => void>();

/**
 * Caprica.exe, the free Papyrus compiler that comes with the Windows app
 * (scripts/fetch-caprica.mjs puts it in resources/caprica), so scripts compile
 * without the Creation Kit.
 */
function bundledCaprica(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const exe = app.isPackaged ? join(process.resourcesPath, 'caprica', 'Caprica.exe') : join(app.getAppPath(), 'resources', 'caprica', 'Caprica.exe');
  return existsSync(exe) ? exe.replace(/\\/g, '/') : undefined;
}

/**
 * Where the built-in AI's runner and models go: beside the portable exe (so it
 * stays portable), otherwise in the app's data folder.
 */
function localAiDir(): string {
  const portable = process.env.PORTABLE_EXECUTABLE_DIR;
  return portable ? join(portable, 'TES5EnvEditor-AI') : join(app.getPath('userData'), 'local-ai');
}

/** The built-in AI's server processes, stopped when the app quits or the engine restarts. */
const children = new Set<number>();
function stopChildren(): void {
  for (const pid of children) {
    try {
      process.kill(pid);
    } catch {
      // Already gone.
    }
  }
  children.clear();
}

function startWorker(): Worker {
  const w = new Worker(join(__dirname, 'engine-worker.cjs'), { workerData: { caprica: bundledCaprica(), localAiDir: localAiDir() } });
  w.on('message', (m: { id?: number; type?: string; event?: unknown; ok?: boolean; value?: unknown; error?: string; pid?: number; running?: boolean }) => {
    if (m.type === 'child' && m.pid) {
      if (m.running) children.add(m.pid);
      else children.delete(m.pid);
      return;
    }
    if (m.type === 'event') {
      win?.webContents.send('engine:event', m.event);
      return;
    }
    const done = m.id !== undefined ? pending.get(m.id) : undefined;
    if (done) {
      pending.delete(m.id!);
      done({ ok: !!m.ok, value: m.value, error: m.error });
    }
  });
  const crashed = (why: string) => {
    if (worker !== w) return; // already replaced
    for (const [, done] of pending) done({ ok: false, error: `Engine crashed: ${why}` });
    pending.clear();
    stopChildren();
    worker = startWorker();
    // The new engine starts empty: tell the UI so it returns to the start screen.
    win?.webContents.send('engine:event', { type: 'engineRestarted', message: why });
  };
  w.on('error', (e) => crashed(e.message));
  w.on('exit', (code) => {
    if (code !== 0) crashed(`the engine process exited unexpectedly (code ${code}), possibly out of memory`);
  });
  return w;
}

/** Recent window recoveries, so a window that keeps crashing isn't reloaded forever. */
let recoveries: number[] = [];

/**
 * Load the app into the window. After a crash, the reason goes in the address (#recovered=…) so the page can
 * say what happened; the engine kept running, so the open game data and unsaved changes are still there.
 */
function loadApp(w: BrowserWindow, recovered?: 'gpu' | 'window'): void {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const hash = recovered ? `recovered=${recovered}` : undefined;
  if (devUrl) void w.loadURL(hash ? `${devUrl}#${hash}` : devUrl);
  else void w.loadFile(join(__dirname, '..', 'dist', 'index.html'), hash ? { hash } : undefined);
}

/**
 * The window's drawing stopped: its process crashed, or Windows reset the graphics card (which a long job on the
 * built-in AI can cause) and left the window black. Reload it, keep the AI off the graphics card, and say so.
 */
function recoverWindow(why: 'gpu' | 'window'): void {
  if (why === 'gpu') worker?.postMessage({ type: 'gpuLost' });
  if (!win || win.isDestroyed()) return;
  const now = Date.now();
  recoveries = recoveries.filter((t) => now - t < 60_000);
  if (recoveries.length >= 3) return;
  recoveries.push(now);
  const w = win;
  setTimeout(() => !w.isDestroyed() && loadApp(w, why), 500);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#1b1c1f',
    title: 'TES5 Env Editor',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  loadApp(win);
  win.on('closed', () => (win = null));
  win.webContents.on('render-process-gone', (_e, d) => {
    if (d.reason !== 'clean-exit') recoverWindow('window');
  });
  // Never navigate away from the app or open windows; external links go to the browser.
  win.webContents.on('will-navigate', (e, url) => {
    if (!devUrl || !url.startsWith(devUrl)) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

ipcMain.handle('engine:invoke', (_e, method: string, args: unknown[]) => {
  if (typeof method !== 'string' || !Array.isArray(args)) return { ok: false, error: 'Bad request' };
  return new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    worker!.postMessage({ id, method, args });
  });
});

ipcMain.handle('dialog:openFolder', async (_e, title: string) => {
  const r = await dialog.showOpenDialog(win!, { title, properties: ['openDirectory'] });
  return r.canceled ? null : (r.filePaths[0] ?? null);
});

ipcMain.handle('dialog:openFile', async (_e, title: string, filters?: OpenDialogOptions['filters']) => {
  const r = await dialog.showOpenDialog(win!, { title, properties: ['openFile'], filters });
  return r.canceled ? null : (r.filePaths[0] ?? null);
});

ipcMain.on('shell:showItemInFolder', (_e, path: string) => {
  if (typeof path === 'string') shell.showItemInFolder(path);
});

// Windows can reset the graphics card when a program keeps it busy too long; Chromium's graphics process goes down with it.
app.on('child-process-gone', (_e, d) => {
  if (d.type === 'GPU' && d.reason !== 'clean-exit') recoverWindow('gpu');
});

app.whenReady().then(() => {
  worker = startWorker();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', stopChildren);

app.on('window-all-closed', () => {
  stopChildren();
  void worker?.terminate();
  if (process.platform !== 'darwin') app.quit();
});
