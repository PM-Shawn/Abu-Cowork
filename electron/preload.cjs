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

// Tauri's real invoke serializer replaces any arg value exposing a
// [SERIALIZE_TO_IPC_FN] method (e.g. a `Channel` from @tauri-apps/api/core,
// which @tauri-apps/plugin-fs's watch()/watchImmediate() pass as `onEvent`)
// with the string it returns ("__CHANNEL__:<id>") BEFORE the value crosses
// the IPC boundary. Electron's ipcRenderer.invoke (structured-clone) does NOT
// call toJSON/SERIALIZE_TO_IPC_FN on its own — a Channel's real state lives in
// WeakMap-backed private fields (not own-enumerable properties), so an
// unconverted Channel would structured-clone into a near-empty object,
// losing the callback id the main process needs to route messages back.
// Verified against node_modules/@tauri-apps/api/core.js: `SERIALIZE_TO_IPC_FN
// = '__TAURI_TO_IPC_KEY__'`; `Channel[SERIALIZE_TO_IPC_FN]()` (and its
// `toJSON()`, which just calls the former) both return
// `` `__CHANNEL__:${this.id}` ``.
//
// ⚠️ There's an EARLIER clone boundary this same reasoning applies to, that
// bites BEFORE this function ever runs: `invoke` itself is a contextBridge-
// exposed function (see `contextBridge.exposeInMainWorld('__TAURI_INTERNALS__',
// {invoke, ...})` below), and Electron's contextBridge clones its arguments
// crossing from the page's main world into this isolated world too — and
// (empirically verified with a throwaway probe script) it ONLY proxies
// functions that are the argument itself or an OWN enumerable property; a
// real `Channel` instance's `[SERIALIZE_TO_IPC_FN]` is a class (prototype)
// method, so contextBridge silently drops it before `args` ever reaches this
// file. All that survives is Channel's own property, `id` (set in its
// constructor via `this.id = transformCallback(...)`) — so a genuine Channel
// arrives here as a bare `{ id: <number> }`, never carrying the method at
// all. The `typeof value[SERIALIZE_TO_IPC_FN] === 'function'` check below
// covers a value that never crossed that boundary as a class instance (e.g.
// a plain object literal built with the method as an own property — proxies
// fine, verified with the same probe); the `{ id: <number> }` branch covers
// the real-Channel case. `id` alone (no other keys) is a safe discriminator
// here: transformCallback's ids are numeric, and the only other single-key
// `{ id }` invoke payload in the vendored Tauri plugins
// (`plugin:notification|delete_channel` from @tauri-apps/plugin-notification)
// takes a STRING id, so `typeof value.id === 'number'` doesn't collide with it.
//
// Deep-walks objects/arrays only (Dates, typed arrays, etc. are left to
// safeArgs's own JSON round-trip) and is non-mutating — it builds a fresh
// tree rather than writing into the caller's args, so the frontend's own
// Channel instance / args object is untouched after the call.
const SERIALIZE_TO_IPC_FN = '__TAURI_TO_IPC_KEY__';
function serializeChannels(value) {
  if (value === null || typeof value !== 'object') return value;
  const toIpc = value[SERIALIZE_TO_IPC_FN];
  if (typeof toIpc === 'function') return toIpc.call(value);
  if (typeof value.id === 'number' && Object.keys(value).length === 1) {
    return `__CHANNEL__:${value.id}`;
  }
  if (Array.isArray(value)) return value.map(serializeChannels);
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = serializeChannels(value[key]);
  }
  return out;
}

const invoke = (cmd, args, options) => {
  // Tauri "raw request" form (e.g. @tauri-apps/plugin-fs writeTextFile/writeFile):
  // the bytes to write are passed as `args` (a Uint8Array/ArrayBuffer) and the
  // path + fs options travel in `options.headers`. JSON-stringifying the body
  // would corrupt it, and dropping the 3rd `options` arg loses the path — so
  // preserve the binary body (Electron structured-clone carries typed arrays
  // intact) and forward the headers.
  const isBinary = args instanceof ArrayBuffer || ArrayBuffer.isView(args);
  const headers = options && options.headers ? options.headers : undefined;
  if (isBinary || headers) {
    return ipcRenderer.invoke('tauri:invoke', {
      cmd,
      body: isBinary ? args : undefined,
      // isBinary args skip serializeChannels/safeArgs entirely (body carries
      // the raw bytes) — the existing raw-body detection path is untouched.
      args: isBinary ? undefined : safeArgs(serializeChannels(args)),
      headers,
    });
  }
  return ipcRenderer.invoke('tauri:invoke', { cmd, args: safeArgs(serializeChannels(args)) });
};

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
