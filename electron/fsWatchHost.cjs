/**
 * Electron main-side `@tauri-apps/plugin-fs` watch family (Phase 2 slice F4).
 *
 * Backs `plugin:fs|watch` (start) and the real unwatch path with Node's
 * `fs.watch`. Wired into electron/tauriHost.cjs's dispatch chain right after
 * fsDispatch (electron/fsHost.cjs) — same fs capability surface, so watched
 * paths go through the same `assertAllowed` scope guard.
 *
 * ## The unwatch command is `plugin:resources|close`, NOT `plugin:fs|unwatch`
 * Verified against node_modules/@tauri-apps/plugin-fs/dist-js/index.js
 * (`watchInternal`) + node_modules/@tauri-apps/api/core.js (`Resource`):
 * `watch()`/`watchImmediate()` return `() => void watcher.close()` where
 * `watcher` is a `Watcher extends Resource` wrapping the `rid` `plugin:fs|watch`
 * returned. `Resource.close()` is generic:
 *   `async close() { return invoke('plugin:resources|close', { rid: this.rid }); }`
 * So the real close call this codebase's Tauri SDK version makes is
 * `plugin:resources|close`, scoped only by `rid` — there is no per-plugin
 * `plugin:fs|unwatch` command in this call chain. This module owns
 * `plugin:resources|close` outright for now since no other rid-producing fs
 * command (FileHandle open/create — still deferred per fsHost.cjs's header)
 * is wired yet. If/when FileHandle rid ops land, `plugin:resources|close`
 * will need to dispatch by rid namespace instead of assuming fs-watch is the
 * only owner. `plugin:fs|unwatch` is also handled below as a defensive
 * synonym (unused by the current SDK version, cheap to keep).
 *
 * ## Delivery mechanism (channels ride the same 'tauri:callback' bridge)
 * `args.onEvent` arrives (via preload.cjs's serializeChannels, see preload
 * header) as the string `"__CHANNEL__:<id>"` — `<id>` is the callback id the
 * renderer's `Channel` already registered with preload's `transformCallback`
 * registry. Delivering a message to it uses the exact same
 * `sender.send('tauri:callback', { id, payload })` shape tauriHost.cjs's
 * `deliver()` uses for `plugin:event|*` — only the `payload` shape differs:
 * a Channel's registered callback is the raw reorder-by-index closure from
 * `Channel`'s constructor (node_modules/@tauri-apps/api/core.js), which reads
 * `payload.index` and `payload.message` — so `payload` here must be
 * `{ index: <int, incrementing per message per channel>, message: <event> }`,
 * not the `{event, id, payload}` shape used for `plugin:event|listen`.
 *
 * ## Event shape delivered as `message`
 * `{ type, paths: string[], attrs: {} }` matching plugin-fs's `WatchEvent`
 * (node_modules/@tauri-apps/plugin-fs/dist-js/index.d.ts `WatchEvent`/
 * `WatchEventKind`). `type` is the notify-rs-style OBJECT form consumers
 * already branch on (src/core/agent/fileWatcher.ts ~line 122 does
 * `'create' in kind` / `'modify' in kind`; src/core/trigger/triggerEngine.ts
 * ~line 588 also accepts the plain-string form, but the object form is what's
 * emitted here): `{ create: {} }` | `{ modify: { kind: 'data' } }` |
 * `{ remove: {} }`. Node's `fs.watch` only reports 'rename' (ambiguous:
 * create AND delete) and 'change' — 'rename' is disambiguated with an
 * `fs.existsSync` check at delivery time.
 *
 * ## Debounce
 * `options.delayMs` (default per plugin-fs: `watch()` passes 2000,
 * `watchImmediate()` passes `undefined` → treated as 0/immediate here).
 * Raw fs.watch events are bucketed by resolved type into a per-rid pending
 * set; a debounce timer (reset on each new raw event) flushes each non-empty
 * bucket as one channel message when it fires. `delayMs <= 0` flushes
 * synchronously (watchImmediate semantics).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertAllowed } = require('./fsHost.cjs');
const { parseChannelId, sendChannelMessage } = require('./channelBridge.cjs');
const { assertResourceOwner } = require('./securityBoundary.cjs');

/** Sentinel returned when `cmd` isn't one of the fs-watch family. */
const FS_WATCH_MISS = Symbol('fs-watch-dispatch-miss');

/**
 * rid -> {
 *   sender: WebContents | null,
 *   callbackId: number,
 *   nextIndex: number,
 *   watchers: fs.FSWatcher[],
 *   timer: NodeJS.Timeout | null,
 *   delayMs: number,
 *   pendingByType: Map<'create'|'modify'|'remove', Set<string>>,
 *   destroyedListener: (() => void) | null,
 * }
 */
const watchTable = new Map();
let nextRid = 1;


/**
 * Resolve a watch path against an optional Tauri BaseDirectory and enforce
 * the same capability-scope guard as fsHost.cjs's other commands (lazy
 * `require('./tauriHost.cjs')` for the same reason fsHost.cjs's
 * `resolveScoped` does — tauriHost.cjs requires this module's sibling at
 * top-level, so a module-scope require here would capture `undefined`).
 * @param {import('electron').App} app
 * @param {string} p
 * @param {number | undefined} baseDirNum
 */
function resolveWatchPath(app, p, baseDirNum) {
  let resolved = p;
  if (baseDirNum != null) {
    const { baseDir } = require('./tauriHost.cjs');
    resolved = path.join(baseDir(app, baseDirNum), p);
  }
  return assertAllowed(resolved);
}

/** Deliver one `{index, message}` rawMessage to a channel's registered callback (shared wire contract: channelBridge.cjs). */
function deliver(entry, message) {
  if (sendChannelMessage(entry.sender, entry.callbackId, entry.nextIndex, message)) {
    entry.nextIndex++;
  }
}

/** @param {'create'|'modify'|'remove'} typeKey @param {string[]} paths */
function buildEvent(typeKey, paths) {
  const type =
    typeKey === 'modify' ? { modify: { kind: 'data' } } : typeKey === 'create' ? { create: {} } : { remove: {} };
  return { type, paths, attrs: {} };
}

/** @param {number} rid */
function flush(rid) {
  const entry = watchTable.get(rid);
  if (!entry) return;
  entry.timer = null;
  for (const [typeKey, paths] of entry.pendingByType) {
    if (paths.size === 0) continue;
    deliver(entry, buildEvent(typeKey, [...paths]));
    paths.clear();
  }
}

/** @param {number} rid */
function scheduleFlush(rid) {
  const entry = watchTable.get(rid);
  if (!entry) return;
  if (entry.delayMs <= 0) {
    flush(rid);
    return;
  }
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => flush(rid), entry.delayMs);
}

/**
 * fs.watch's raw ('rename'|'change', filename) callback -> bucket into the
 * pending set for the next debounced flush.
 * @param {number} rid
 * @param {string} watchedPath absolute, already scope-checked
 * @param {boolean} isDir whether watchedPath is a directory (vs a single file)
 * @param {'rename' | 'change'} eventType
 * @param {string | Buffer | null} filename
 */
function onRawFsEvent(rid, watchedPath, isDir, eventType, filename) {
  const entry = watchTable.get(rid);
  if (!entry) return;
  // For a DIRECTORY watch, `filename` is the changed entry within the dir, so
  // join it. For a single-FILE watch, Node's fs.watch fires `filename` = the
  // watched file's OWN basename — joining would produce a bogus doubled path
  // (/x/todo.md/todo.md); notify-rs (the Rust backend) reports the real path,
  // so a file watch's event path is always the watched file itself.
  const absPath = isDir && filename ? path.join(watchedPath, filename.toString()) : watchedPath;
  // 'rename' fires for both create AND delete in Node's fs.watch — an
  // existence check at event time disambiguates, matching what notify-rs's
  // debouncer resolves to on the Rust side.
  const typeKey = eventType === 'rename' ? (fs.existsSync(absPath) ? 'create' : 'remove') : 'modify';
  if (!entry.pendingByType.has(typeKey)) entry.pendingByType.set(typeKey, new Set());
  entry.pendingByType.get(typeKey).add(absPath);
  scheduleFlush(rid);
}

/** @param {number | undefined} rid */
function cleanupRid(rid) {
  const entry = watchTable.get(rid);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  for (const w of entry.watchers) {
    try {
      w.close();
    } catch {
      /* already closed */
    }
  }
  if (entry.sender && entry.destroyedListener) {
    try {
      entry.sender.removeListener('destroyed', entry.destroyedListener);
    } catch {
      /* sender already gone */
    }
  }
  watchTable.delete(rid);
}

function cleanupFsWatchesForSender(sender) {
  for (const [rid, entry] of watchTable) {
    if (entry.sender === sender) cleanupRid(rid);
  }
}

/**
 * @param {import('electron').App} app
 * @param {string} cmd
 * @param {{ args?: Record<string, unknown>; event?: import('electron').IpcMainInvokeEvent }} payload
 */
function fsWatchDispatch(app, cmd, payload) {
  const { args, event } = payload || {};
  const a = args || {};

  switch (cmd) {
    case 'plugin:fs|watch': {
      const paths = Array.isArray(a.paths) ? a.paths : [];
      const options = a.options || {};
      const callbackId = parseChannelId(a.onEvent);
      if (callbackId == null) {
        throw new Error('plugin:fs|watch: args.onEvent is not a serialized channel');
      }
      const sender = event && event.sender;
      const rid = nextRid++;
      const entry = {
        sender: sender || null,
        callbackId,
        nextIndex: 0,
        watchers: [],
        timer: null,
        delayMs: options.delayMs == null ? 0 : Number(options.delayMs),
        pendingByType: new Map(),
        destroyedListener: null,
      };
      if (!Number.isFinite(entry.delayMs) || entry.delayMs < 0) {
        throw new Error('plugin:fs|watch: delayMs must be a non-negative finite number');
      }
      watchTable.set(rid, entry);

      try {
        for (const p of paths) {
          const resolved = resolveWatchPath(app, p, options.baseDir);
          // Distinguish a single-file target from a directory so onRawFsEvent
          // reports the right event path (see its comment). statSync is safe:
          // fs.watch below would itself throw if the path didn't exist.
          const isDir = fs.statSync(resolved).isDirectory();
          const watcher = fs.watch(resolved, { recursive: !!options.recursive }, (eventType, filename) =>
            onRawFsEvent(rid, resolved, isDir, eventType, filename)
          );
          // A watcher-level error (e.g. the watched path got removed) must
          // not crash the whole process — best-effort, matching Tauri's own
          // watcher resilience.
          watcher.on('error', () => {});
          entry.watchers.push(watcher);
        }
      } catch (err) {
        cleanupRid(rid); // don't leak watchers already opened for earlier paths[i]
        throw err;
      }

      if (sender) {
        entry.destroyedListener = () => cleanupRid(rid);
        sender.once('destroyed', entry.destroyedListener);
      }

      return rid;
    }

    case 'plugin:resources|close':
    case 'plugin:fs|unwatch': {
      assertResourceOwner(watchTable.get(a.rid), event && event.sender, 'fs watch');
      cleanupRid(a.rid);
      return null;
    }

    default:
      return FS_WATCH_MISS;
  }
}

module.exports = { fsWatchDispatch, FS_WATCH_MISS, cleanupFsWatchesForSender };
