import { contextBridge, ipcRenderer } from 'electron';
import type { AppApi, Command } from './shared.js';
const api: AppApi = Object.freeze({ execute: (command: Command) => ipcRenderer.invoke('auto-flow:execute', command) });
contextBridge.exposeInMainWorld('autoFlow', api);
