/**
 * Electron production preload (Phase 2 slice A).
 *
 * contextIsolation:true — bridges the Tauri IPC surface the frontend expects
 * (`window.__TAURI_INTERNALS__`, `window.__TAURI_OS_PLUGIN_INTERNALS__`) into
 * the renderer's isolated world via contextBridge, routing every call to the
 * main-process command router in electron/tauriHost.cjs.
 *
 * `__TAURI_OS_PLUGIN_INTERNALS__` is fetched SYNCHRONOUSLY (ipcRenderer.sendSync)
 * so it's present before any page script runs — @tauri-apps/plugin-os reads it
 * synchronously at module-eval time, and boot throws if it's missing.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

let cbId = 1;

// Guard against exotic/non-JSON-serializable args (functions, DOM nodes, etc.)
// so the structured-clone IPC boundary doesn't throw before we even dispatch.
function safeArgs(args) {
  try {
    return JSON.parse(JSON.stringify(args ?? null));
  } catch {
    return null;
  }
}

const invoke = (cmd, args) => ipcRenderer.invoke('tauri:invoke', { cmd, args: safeArgs(args) });

contextBridge.exposeInMainWorld('__TAURI_INTERNALS__', {
  invoke,
  transformCallback: () => cbId++,
  unregisterCallback: () => {},
  convertFileSrc: (p) => p,
  metadata: {
    currentWindow: { label: 'main' },
    currentWebview: { windowLabel: 'main', label: 'main' },
  },
});

contextBridge.exposeInMainWorld('__TAURI_OS_PLUGIN_INTERNALS__', ipcRenderer.sendSync('tauri:os-internals'));
