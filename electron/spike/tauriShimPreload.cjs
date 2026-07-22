/**
 * Frontend-boot spike — Tauri IPC capture shim (preload).
 *
 * THROWAWAY recon tooling (Phase 2 boot spike), not production. Loaded before
 * the real Abu frontend so isTauriEnv() sees a Tauri env and the app takes its
 * Tauri code paths — then every window.__TAURI_INTERNALS__.invoke(cmd, args)
 * (which is ALSO how @tauri-apps/api/event's listen() dispatches, as
 * invoke('plugin:event|listen', {event})) is logged to the main process. The
 * captured, ordered list is the empirical "what the frontend actually calls at
 * boot" work-list for the later capability slices.
 *
 * contextIsolation:false so this preload shares `window` with the page (the
 * shim must BE the page's __TAURI_INTERNALS__) and can require ipcRenderer.
 * Security is irrelevant here: throwaway harness loading our own build.
 */
'use strict';

const { ipcRenderer } = require('electron');

let cbId = 1;

function safeArgs(args) {
  try {
    return JSON.parse(JSON.stringify(args ?? null));
  } catch {
    return '<unserializable>';
  }
}

// Benign defaults so a boot path doesn't die the instant it awaits a result —
// we want the app to get as far as possible so we capture the full boot surface.
// Never reject: an error here would truncate an otherwise-independent boot path.
function defaultFor(cmd) {
  if (cmd === 'plugin:event|listen') return cbId++; // event id used for unlisten
  if (/(^|_)list$|failed_keys|_all$/i.test(cmd)) return [];
  if (/_has$|_exists$|^is_|^check_/i.test(cmd)) return false;
  return null;
}

const invoke = (cmd, args) => {
  try {
    ipcRenderer.send('spike:invoke', { cmd, args: safeArgs(args) });
  } catch {
    /* ignore */
  }
  return Promise.resolve(defaultFor(cmd));
};

window.__TAURI_INTERNALS__ = {
  invoke,
  transformCallback: () => cbId++,
  unregisterCallback: () => {},
  convertFileSrc: (p) => p,
  // Some plugins (getCurrentWindow/getCurrentWebview) read this synchronously.
  metadata: {
    currentWindow: { label: 'main' },
    currentWebview: { windowLabel: 'main', label: 'main' },
  },
};
