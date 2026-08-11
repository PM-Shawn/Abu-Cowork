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

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const TAURI_LOCAL_STORAGE_GET = 'abu:tauri-local-storage:get';
const TAURI_LOCAL_STORAGE_ACK = 'abu:tauri-local-storage:ack';
const RUNTIME_EVENT_CHANNEL = 'abu:runtime-event';
const RUNTIME_DIAGNOSTICS_CHANNEL = 'abu:runtime-diagnostics';
const TAURI_STORE_KEYS = new Set([
  'abu-settings',
  'abu-chat',
  'abu-scratchpad-store',
  'abu-permissions',
  'abu-workspace',
  'abu-mcp-store',
  'abu-schedule',
  'abu-triggers',
  'abu-im-channel',
  'abu-projects',
  'abu-project-hint',
  'abu-diagnostic-store',
  'abu-usage-stats',
  'abu-discovered-caps',
  'abu-todos',
  'abu-inbox',
  'abu_device_id',
  'abu_seen_announcements',
  'abu-pet-position',
  'wechat:ctx',
]);

function isAllowedTauriStorageKey(key) {
  return TAURI_STORE_KEYS.has(key) || key.startsWith('wechat:cursor:');
}

// Import old Tauri WebView localStorage before any renderer module runs, so
// Zustand hydrates the migrated state on this first Electron launch. Transition
// builds use source-wins so a previously launched RC/test Electron profile
// cannot shadow the user's installed Tauri settings. Replaced Electron values
// are returned to main for a local recovery backup before completion is marked.
try {
  const payload = ipcRenderer.sendSync(TAURI_LOCAL_STORAGE_GET);
  if (payload?.version === 2 && Array.isArray(payload.items)) {
    const result = {
      imported: [],
      overwritten: [],
      skippedExisting: [],
      failed: [],
      previous: [],
    };
    for (const item of payload.items) {
      const key = item?.key;
      if (
        typeof key !== 'string' ||
        typeof item?.value !== 'string' ||
        !isAllowedTauriStorageKey(key)
      ) {
        if (typeof key === 'string') result.failed.push(key);
        continue;
      }
      try {
        const existing = globalThis.localStorage.getItem(key);
        if (existing !== null && payload.conflictPolicy !== 'source-wins') {
          result.skippedExisting.push(key);
        } else {
          if (existing !== null) {
            result.previous.push({ key, value: existing });
          }
          globalThis.localStorage.setItem(key, item.value);
          (existing === null ? result.imported : result.overwritten).push(key);
        }
      } catch {
        result.failed.push(key);
      }
    }
    ipcRenderer.sendSync(TAURI_LOCAL_STORAGE_ACK, result);
  }
} catch {
  // Migration must never make the app unbootable. No acknowledgement means
  // main leaves the sentinel absent and retries next launch.
}

let cbId = 1;

// Real callback registry (Phase 2 slice B) — transformCallback used to return
// an id but drop the callback; now it stores {cb, once} so main can deliver
// events/channel messages back to the exact page-world function the frontend
// registered (LLM streaming, event listeners, fs.watch, etc.).
const callbacks = new Map();
const MAX_ARGS_JSON_CHARS = 8 * 1024 * 1024;
const MAX_RAW_BODY_BYTES = 128 * 1024 * 1024;

// Guard against exotic/non-JSON-serializable args (functions, DOM nodes, etc.)
// so the structured-clone IPC boundary doesn't throw before we even dispatch.
function safeArgs(args) {
  try {
    const json = JSON.stringify(args ?? null);
    if (json === undefined) throw new Error('value is not JSON serializable');
    if (json.length > MAX_ARGS_JSON_CHARS) throw new Error('serialized args are too large');
    return JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Tauri invoke args are not JSON serializable: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
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
function serializeChannels(value, seen = new WeakSet(), depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 32) throw new Error('Tauri invoke args are too deeply nested');
  if (seen.has(value)) throw new Error('Tauri invoke args must not be cyclic');
  seen.add(value);
  const toIpc = value[SERIALIZE_TO_IPC_FN];
  if (typeof toIpc === 'function') {
    seen.delete(value);
    return toIpc.call(value);
  }
  // A contextBridge-degraded real Channel arrives as bare `{ id: <number> }`,
  // and — crucially — that id was registered in `callbacks` by the Channel's
  // constructor calling transformCallback() BEFORE this invoke runs. Requiring
  // `callbacks.has(id)` makes this a robust discriminator, not a shape guess: a
  // legit data arg shaped `{ id: 5 }` won't have 5 as a live callback, so it's
  // never corrupted into a channel string.
  if (
    typeof value.id === 'number' &&
    Object.keys(value).length === 1 &&
    callbacks.has(value.id)
  ) {
    seen.delete(value);
    return `__CHANNEL__:${value.id}`;
  }
  if (Array.isArray(value)) {
    const out = value.map((item) => serializeChannels(item, seen, depth + 1));
    seen.delete(value);
    return out;
  }
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = serializeChannels(value[key], seen, depth + 1);
  }
  seen.delete(value);
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
  if (isBinary && args.byteLength > MAX_RAW_BODY_BYTES) {
    throw new Error('Tauri invoke raw body is too large');
  }
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

// F1 host gate (src/core/sidecar/sidecarManager.ts) — tells the renderer the
// MAIN process already supervises sidecar liveness (electron/mcpBridge.cjs's
// heartbeat + `mcp-hung-*` event), so sidecarManager.ts must NOT also start
// its own renderer heartbeat. This global is exposed ONLY here (Electron) —
// under Tauri it's simply absent, which is exactly what tells sidecarManager
// to fall back to running its own renderer heartbeat.
// Edition + enterprise runtime config resolved by main at startup (see
// electron/enterpriseConfig.cjs). Fetched synchronously so the values exist
// before any renderer module evaluates; falls back to OSS posture if the
// handler is somehow absent (older main during a mixed-version dev reload).
const shellContext = (() => {
  try {
    return ipcRenderer.sendSync('abu:shell-context') || {};
  } catch {
    return {};
  }
})();

contextBridge.exposeInMainWorld('__ABU_SHELL__', {
  mainSupervisesSidecar: true,
  edition: shellContext.edition ?? 'oss',
  // Parsed abu-enterprise.json content (null when not deployed). Consumed
  // only by the enterprise-modules overlay; OSS renderers ignore it.
  enterpriseConfig: shellContext.enterpriseConfig ?? null,
  // Chromium no longer exposes File.path. Keep the bridge deliberately narrow:
  // the renderer can resolve only a File object the user already dragged in.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  recordRuntimeEvent: (event) => ipcRenderer.send(RUNTIME_EVENT_CHANNEL, safeArgs(event)),
  getRuntimeDiagnostics: () => ipcRenderer.invoke(RUNTIME_DIAGNOSTICS_CHANNEL),
});

// unlisten() calls this SYNCHRONOUSLY before invoking `plugin:event|unlisten`
// — must exist or unlisten throws before the real unlisten reaches main. No-op:
// main is the authoritative registry (tauriHost.cjs `subscriptions`), removed
// there via the `plugin:event|unlisten` invoke that follows.
contextBridge.exposeInMainWorld('__TAURI_EVENT_PLUGIN_INTERNALS__', {
  unregisterListener: () => {},
});
