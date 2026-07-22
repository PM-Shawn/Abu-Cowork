/**
 * Minimal `window.__TAURI__` global shim for the overlay / stop-button
 * windows (Phase 2 GUI-families slice).
 *
 * `public/overlay.html` and `public/stop-button.html` are dumb, unbundled
 * static pages (no Vite/React, no `@tauri-apps/api` import) that rely on
 * Tauri's `withGlobalTauri: true` config (see tauri.conf.json) injecting a
 * `window.__TAURI__.event.{listen,emit}` global into EVERY webview — that's
 * how they talk to the outside world:
 *   - stop-button.html: `window.__TAURI__.event.emit('computer-use-abort')`
 *   - overlay.html:     `window.__TAURI__.event.listen('computer-use-status', cb)`
 *
 * This file is their Electron-side equivalent of that global — NOT a full
 * Tauri-API port (no invoke() of arbitrary commands, no path/fs/etc). It
 * round-trips through the SAME `tauri:invoke` handler + `plugin:event|*`
 * subscription registry that electron/tauriHost.cjs already runs for the
 * main window's real `@tauri-apps/api` usage (`listen()`/`emit()` in
 * computerUseStatus.ts), so delivery is already cross-window: tauriHost's
 * `deliver()` matches subscriptions by event name across every window's
 * subscriptions, regardless of which window is emitting/listening — no new
 * server-side plumbing needed here, just this client-side shim.
 *
 * Kept deliberately minimal (overlay/stop-button render Abu's OWN trusted
 * static HTML, but they don't need the full IPC surface the main window's
 * preload.cjs exposes) — only the two `event` methods these two pages
 * actually call.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

let cbId = 1;
/** callbackId -> the JS function passed to listen(). */
const callbacks = new Map();

function invoke(cmd, args) {
  return ipcRenderer.invoke('tauri:invoke', { cmd, args: args ?? null });
}

// Matches tauriHost.cjs's `deliver()` wire format exactly: `{id: callbackId,
// payload: {event, id: eventId, payload}}` — the inner object IS the Tauri
// Event shape (`event.payload` is what listen() callbacks read).
ipcRenderer.on('tauri:callback', (_e, { id, payload } = {}) => {
  const cb = callbacks.get(id);
  if (cb) cb(payload);
});

ipcRenderer.on('tauri:uncallback', (_e, { id } = {}) => {
  callbacks.delete(id);
});

/** @param {string} event @param {(ev: {event: string, id: number, payload: unknown}) => void} cb */
async function listen(event, cb) {
  const callbackId = cbId++;
  callbacks.set(callbackId, cb);
  const eventId = await invoke('plugin:event|listen', { event, handler: callbackId });
  return () => {
    callbacks.delete(callbackId);
    void invoke('plugin:event|unlisten', { event, eventId });
  };
}

/** @param {string} event @param {unknown} [payload] */
function emit(event, payload) {
  return invoke('plugin:event|emit', { event, payload });
}

contextBridge.exposeInMainWorld('__TAURI__', {
  event: { listen, emit },
});

// stop-button.html's inline <script> reads `window.__CU_I18N__.stopControl`
// for its localized caption — Tauri's Rust side (overlay.rs's
// `show_stop_button`) injects this via `initialization_script`, evaluated
// before ANY page script runs. A preload script has that exact same timing
// guarantee, but (unlike Tauri's initialization_script, which is literal JS
// text the Rust side builds fresh per show_screen_border call) has no way to
// receive per-invocation dynamic data directly — so the caption instead
// travels in via the loaded URL's query string (see guiHost.cjs's
// `showStopButton`, which calls `loadFile(..., {query: {stopLabel}})`).
// `location` is a real DOM/platform object, readable from a preload even
// under contextIsolation (isolation walls off JS globals/functions, not the
// document/location the page and preload share) — only `window` is split,
// which is exactly why this needs contextBridge to cross into the page's
// world at all. No-op (nothing exposed) if `stopLabel` is absent from the
// URL, e.g. when this preload is reused for overlay.html, which doesn't read
// `__CU_I18N__`.
try {
  const params = new URLSearchParams(location.search);
  if (params.has('stopLabel')) {
    contextBridge.exposeInMainWorld('__CU_I18N__', { stopControl: params.get('stopLabel') });
  }
} catch {
  /* URL parsing failure — harmless no-op */
}
