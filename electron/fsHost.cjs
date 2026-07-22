/**
 * Electron main-side `@tauri-apps/plugin-fs` command handlers (Phase 2 slice E
 * "fs family").
 *
 * Backs the frontend's `plugin:fs|*` commands with real Node `fs` calls. Most
 * of these commands (exists/mkdir/read_dir/remove/rename/copy_file) carry
 * their arguments in the normal JSON `args` object, same as every other
 * dispatcher in this codebase. The two write commands
 * (`write_text_file`/`write_file`) are special: @tauri-apps/plugin-fs sends
 * them via Tauri's RAW-BODY invoke form — the actual bytes to write are the
 * invoke's `body` (a Uint8Array, not JSON), and the path + options travel in
 * `headers` (`{ path: encodeURIComponent(path), options: JSON.stringify(opts) }`)
 * instead of `args`. preload.cjs forwards that shape through untouched (see
 * its `invoke` override) and tauriHost.cjs passes `{ args, body, headers }`
 * straight through to `fsDispatch` below.
 *
 * A genuine fs error (ENOENT, EACCES, …) is left to THROW out of the sync fs
 * call — matching Tauri, which surfaces fs errors to the frontend via a
 * rejected invoke. Do not add a swallowing try/catch here.
 *
 * Deferred to a later slice: `plugin:fs|watch` (channel-streamed fs events)
 * and the FileHandle/rid-based ops (open/create/read/write/seek/stat/lstat/
 * read_text_file_lines) — those fall through to tauriHost.cjs's benign stub.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Sentinel returned when `cmd` isn't an fs command, so tauriHost.cjs falls through. */
const FS_MISS = Symbol('fs-dispatch-miss');

/**
 * Resolve a frontend-supplied path against a Tauri BaseDirectory number, if
 * one was given. Lazily requires tauriHost.cjs (rather than at module scope)
 * because tauriHost.cjs requires this module at its own top level — a
 * module-scope require here would see tauriHost's exports mid-load (still
 * `{}`) and capture `undefined` for `baseDir`. By the time any fs command is
 * actually dispatched, tauriHost.cjs has finished loading, so the lazy
 * require (cached, cheap) resolves to the real function.
 * @param {import('electron').App} app
 * @param {string} p
 * @param {{ baseDir?: number } | undefined} options
 */
function resolvePath(app, p, options) {
  if (options && options.baseDir != null) {
    const { baseDir } = require('./tauriHost.cjs');
    return path.join(baseDir(app, options.baseDir), p);
  }
  return p;
}

/**
 * @param {import('electron').App} app
 * @param {string} cmd
 * @param {{ args?: Record<string, unknown>; body?: unknown; headers?: Record<string, string> }} payload
 */
function fsDispatch(app, cmd, payload) {
  const { args, body, headers } = payload || {};
  const a = args || {};

  switch (cmd) {
    case 'plugin:fs|exists':
      return fs.existsSync(resolvePath(app, a.path, a.options));

    case 'plugin:fs|read_text_file':
      // The frontend api treats this result as raw bytes (Uint8Array.from(arr)
      // then TextDecoder) — return a plain byte array, NOT a decoded string.
      return [...fs.readFileSync(resolvePath(app, a.path, a.options))];

    case 'plugin:fs|read_dir':
      return fs
        .readdirSync(resolvePath(app, a.path, a.options), { withFileTypes: true })
        .map((d) => ({
          name: d.name,
          isDirectory: d.isDirectory(),
          isFile: d.isFile(),
          isSymlink: d.isSymbolicLink(),
        }));

    case 'plugin:fs|mkdir':
      fs.mkdirSync(resolvePath(app, a.path, a.options), { recursive: !!(a.options && a.options.recursive) });
      return null;

    case 'plugin:fs|remove':
      fs.rmSync(resolvePath(app, a.path, a.options), {
        recursive: !!(a.options && a.options.recursive),
        force: false,
      });
      return null;

    case 'plugin:fs|rename': {
      const oldResolved = resolvePath(app, a.oldPath, a.options);
      const newResolved = resolvePath(app, a.newPath, a.options);
      fs.renameSync(oldResolved, newResolved);
      return null;
    }

    case 'plugin:fs|copy_file': {
      const fromResolved = resolvePath(app, a.fromPath, a.options);
      const toResolved = resolvePath(app, a.toPath, a.options);
      fs.copyFileSync(fromResolved, toResolved);
      return null;
    }

    case 'plugin:fs|write_text_file':
    case 'plugin:fs|write_file': {
      // RAW-BODY form: path + options travel URI-encoded / JSON-stringified in
      // headers (see module doc comment), the bytes to write are `body`.
      const h = headers || {};
      const p = decodeURIComponent(h.path);
      const options = JSON.parse(h.options || '{}');
      const resolved = resolvePath(app, p, options);
      const buf = Buffer.from(body);
      if (options.append) {
        fs.appendFileSync(resolved, buf);
      } else {
        // Tauri's `create` defaults true, but that only governs whether the
        // FILE is created if missing (writeFileSync already does that) — it
        // does NOT recursively create the parent directory. Don't mkdir here.
        fs.writeFileSync(resolved, buf);
      }
      return null;
    }

    default:
      return FS_MISS;
  }
}

module.exports = { fsDispatch, FS_MISS };
