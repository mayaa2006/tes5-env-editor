/** The only API the UI gets: the engine bridge (see src/engine/client.ts). */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('tes5Host', {
  invoke: (method: string, args: unknown[]) => ipcRenderer.invoke('engine:invoke', method, args),
  onEvent: (cb: (e: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, ev: unknown) => cb(ev);
    ipcRenderer.on('engine:event', listener);
    return () => ipcRenderer.removeListener('engine:event', listener);
  },
  openFolder: (title: string) => ipcRenderer.invoke('dialog:openFolder', title),
  openFile: (title: string, filters?: { name: string; extensions: string[] }[]) => ipcRenderer.invoke('dialog:openFile', title, filters),
  showItemInFolder: (path: string) => ipcRenderer.send('shell:showItemInFolder', path),
  platform: process.platform,
});
