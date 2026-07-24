/**
 * Electron main-side `@tauri-apps/plugin-global-shortcut` family.
 *
 * Backs `plugin:global-shortcut|register`/`unregister`/`unregister_all`/
 * `is_registered` with Electron's `globalShortcut` module (main-process only).
 * The only caller in src/ is `src/core/agent/computerUseStatus.ts`, which
 * registers `CommandOrControl+.` as a global abort hotkey for computer-use
 * (and unregisters it on cleanup) — Tauri's accelerator string format is
 * identical to Electron's, so it passes through unmodified.
 *
 * ## Wire contract (verified against
 * node_modules/@tauri-apps/plugin-global-shortcut/dist-js/index.js)
 *  - `register(shortcuts, handler)` sends
 *    `invoke('plugin:global-shortcut|register', { shortcuts: string[], handler: Channel })`
 *    — `shortcuts` is ALWAYS an array (the JS wrapper wraps a bare string
 *    itself); `handler` is a real `Channel` instance, which
 *    electron/preload.cjs's `serializeChannels` turns into the wire string
 *    `"__CHANNEL__:<id>"` before it crosses to main (same mechanism
 *    electron/fsWatchHost.cjs's `onEvent` uses — see its header comment).
 *  - `unregister(shortcuts)` sends `{ shortcuts: string[] }` (same
 *    always-an-array wrapping).
 *  - `unregister_all()` sends `{}`.
 *  - `is_registered(shortcut)` sends `{ shortcut: string }` (singular, NOT an
 *    array — this one command takes exactly one shortcut).
 *
 * ## Callback delivery (Channel, not plugin:event)
 * The registered `handler` is a `Channel`, so delivery must use the
 * `{ index, message }` reorder-by-index rawMessage shape `Channel`'s
 * constructor expects (node_modules/@tauri-apps/api/core.js), NOT the
 * `{event, id, payload}` shape `plugin:event|listen` uses — same distinction
 * fsWatchHost.cjs's header documents for `plugin:fs|watch`'s `onEvent`.
 * `message` here is a `ShortcutEvent` (node_modules/@tauri-apps/plugin-global-
 * shortcut/dist-js/index.d.ts): `{ shortcut: string; id: number; state:
 * 'Pressed' | 'Released' }`. Electron's `globalShortcut.register` callback
 * fires only on the hotkey being pressed (no separate release event at this
 * API level), so `state` is always reported as `'Pressed'` here — matching
 * the task brief and the only state the single caller (`computerUseStatus.ts`)
 * checks for in its own doc examples.
 *
 * Exports `globalShortcutDispatch(cmd, payload)` (`payload` is
 * `{args, event}` — needs the raw ipcMain event to resolve `event.sender`,
 * the renderer whose Channel callback registered the accelerator) +
 * `GLOBAL_SHORTCUT_MISS`, wired into electron/tauriHost.cjs's dispatch chain.
 * Also exports `teardownGlobalShortcuts()` — unregisters every OS-level
 * hotkey binding, called from tauriHost.cjs's `before-quit` handler (same
 * no-orphan intent as browserHost.cjs's `closeAllBrowserViews()` /
 * guiHost.cjs's `teardownGuiHost()`), since `globalShortcut` bindings are a
 * process-wide OS resource that outlives a destroyed BrowserWindow.
 */
'use strict';

const { globalShortcut } = require('electron');
const { parseChannelId, sendChannelMessage } = require('./channelBridge.cjs');

/** Sentinel returned when `cmd` isn't a global-shortcut command. */
const GLOBAL_SHORTCUT_MISS = Symbol('global-shortcut-dispatch-miss');

/**
 * accelerator -> { callbackId: number, sender: WebContents | null,
 *   shortcutIndex: number, nextMessageIndex: number }
 * `shortcutIndex` is a stable-per-accelerator numeric id reported as
 * `ShortcutEvent.id` (Tauri's plugin assigns one per registered shortcut;
 * nothing in src/ reads it, but it's cheap to report faithfully).
 */
const registrations = new Map();
let nextShortcutIndex = 0;

/** Normalize the JS plugin's shortcuts arg (always an array, but be defensive). */
function toShortcutList(v) {
  if (Array.isArray(v)) return v.filter((s) => typeof s === 'string' && s.length > 0);
  if (typeof v === 'string' && v.length > 0) return [v];
  return [];
}

/** Deliver one `ShortcutEvent` to `accel`'s registered Channel callback (shared wire contract: channelBridge.cjs). */
function deliverShortcutEvent(accel) {
  const reg = registrations.get(accel);
  if (!reg) return;
  const message = { shortcut: accel, id: reg.shortcutIndex, state: 'Pressed' };
  if (sendChannelMessage(reg.sender, reg.callbackId, reg.nextMessageIndex, message)) {
    reg.nextMessageIndex++;
  }
}

/**
 * @param {string} cmd
 * @param {{ args?: Record<string, unknown>; event?: import('electron').IpcMainInvokeEvent }} payload
 */
function globalShortcutDispatch(cmd, payload) {
  const { args, event } = payload || {};
  const a = args || {};

  switch (cmd) {
    case 'plugin:global-shortcut|register': {
      const shortcuts = toShortcutList(a.shortcuts);
      const callbackId = parseChannelId(a.handler);
      if (callbackId == null) {
        throw new Error('plugin:global-shortcut|register: args.handler is not a serialized channel');
      }
      const sender = event && event.sender;
      for (const accel of shortcuts) {
        // Re-registering an accelerator that's already bound (e.g. a second
        // setupAbortListener() call): drop the old binding first so a stale
        // registration entry can't linger pointing at a dead callback.
        if (registrations.has(accel)) {
          try {
            globalShortcut.unregister(accel);
          } catch {
            /* already unregistered */
          }
          registrations.delete(accel);
        }
        const ok = globalShortcut.register(accel, () => deliverShortcutEvent(accel));
        if (!ok) {
          // OS refused (already taken by another app/process) — matches
          // upstream Tauri's documented behavior ("the handler will not be
          // triggered"), not an error condition worth throwing over.
          continue;
        }
        registrations.set(accel, {
          callbackId,
          sender: sender || null,
          shortcutIndex: nextShortcutIndex++,
          nextMessageIndex: 0,
        });
      }
      return null;
    }

    case 'plugin:global-shortcut|unregister': {
      const shortcuts = toShortcutList(a.shortcuts);
      for (const accel of shortcuts) {
        try {
          globalShortcut.unregister(accel);
        } catch {
          /* not registered */
        }
        registrations.delete(accel);
      }
      return null;
    }

    case 'plugin:global-shortcut|unregister_all': {
      globalShortcut.unregisterAll();
      registrations.clear();
      return null;
    }

    case 'plugin:global-shortcut|is_registered': {
      const accel = a.shortcut;
      return typeof accel === 'string' && accel.length > 0 ? globalShortcut.isRegistered(accel) : false;
    }

    default:
      return GLOBAL_SHORTCUT_MISS;
  }
}

/** Unregister every OS-level hotkey binding — called on app quit (no leaks). */
function teardownGlobalShortcuts() {
  globalShortcut.unregisterAll();
  registrations.clear();
}

module.exports = { globalShortcutDispatch, GLOBAL_SHORTCUT_MISS, teardownGlobalShortcuts };
