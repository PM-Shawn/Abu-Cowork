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

// Real callback registry (Phase 2 slice B) — transformCallback used to return
// an id but drop the callback; now it stores {cb, once} so main can deliver
// events/channel messages back to the exact page-world function the frontend
// registered (LLM streaming, event listeners, fs.watch, etc.).
const callbacks = new Map();

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

// Main delivers a callback invocation by id — see tauriHost.cjs `deliver()`.
ipcRenderer.on('tauri:callback', (_e, { id, payload } = {}) => {
  const c = callbacks.get(id);
  if (!c) return;
  try {
    c.cb(payload);
  } finally {
    if (c.once) callbacks.delete(id);
  }
});

// Main prunes a callback on unlisten (it holds the callbackId; the api's own
// synchronous unregisterListener only has the eventId). Without this the
// callbacks Map would leak across a session's listen/unlisten churn.
ipcRenderer.on('tauri:uncallback', (_e, { id } = {}) => {
  callbacks.delete(id);
});

contextBridge.exposeInMainWorld('__TAURI_INTERNALS__', {
  invoke,
  transformCallback: (cb, once = false) => {
    const id = cbId++;
    callbacks.set(id, { cb, once });
    return id;
  },
  unregisterCallback: (id) => callbacks.delete(id),
  // Raw path (not an asset:// URL) — fine until file-backed asset loading (image
  // previews) lands in a later slice; then this needs a custom protocol.
  convertFileSrc: (p) => p,
  metadata: {
    currentWindow: { label: 'main' },
    currentWebview: { windowLabel: 'main', label: 'main' },
  },
});

contextBridge.exposeInMainWorld('__TAURI_OS_PLUGIN_INTERNALS__', ipcRenderer.sendSync('tauri:os-internals'));

// unlisten() calls this SYNCHRONOUSLY before invoking `plugin:event|unlisten`
// — must exist or unlisten throws before the real unlisten reaches main. No-op:
// main is the authoritative registry (tauriHost.cjs `subscriptions`), removed
// there via the `plugin:event|unlisten` invoke that follows.
contextBridge.exposeInMainWorld('__TAURI_EVENT_PLUGIN_INTERNALS__', {
  unregisterListener: () => {},
});
