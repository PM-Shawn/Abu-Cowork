/**
 * Electron main-side `@tauri-apps/plugin-fs` command handlers (Phase 2 slice E
 * "fs family").
 *
 * Backs the frontend's plugin:fs commands with real Node `fs` calls. Most
 * commands (exists/read/read-dir/mkdir/remove/rename/copy-file) carry their
 * arguments in the normal JSON `args` object. The write commands
 * (`write_text_file`/`write_file`) use Tauri's RAW-BODY invoke form — the bytes
 * are the invoke `body` (a Uint8Array, not JSON) and the path+options ride in
 * `headers` (`{ path: encodeURIComponent(path), options: JSON.stringify(opts) }`).
 * preload.cjs forwards that shape and tauriHost.cjs passes `{args, body, headers}`.
 *
 * ## Capability scope (security — restored per slice-E review)
 * Under Tauri, plugin:fs was confined by src-tauri/capabilities/*.json to an
 * allowlist of roots ($HOME, /tmp, /private/tmp, /Volumes, $TEMP, $RESOURCE,
 * /Applications) with an explicit deny on removing the `.abu` data root. The
 * Node shell has no such boundary by default, so `assertAllowed()` re-imposes
 * it: every resolved path is realpath-normalized (collapsing `..`) and must sit
 * under an allowed root, or the command is refused — otherwise an agent-driven
 * readFile('/etc/passwd') or writeFile('/etc/...') would escape the sandbox
 * Tauri enforced. Windows capabilities were `**` (allow-all), so the guard is a
 * no-op there, matching Tauri's own windows-extras.json.
 *
 * A genuine fs error (ENOENT, EACCES, scope refusal) is left to THROW so the
 * invoke rejects — matching Tauri, which surfaces fs errors to the frontend.
 *
 * ## Custom write commands (Phase 2 F1a — data-loss stop)
 * Beyond plugin:fs|*, this module also backs the bare custom write commands that
 * the frontend's persistence layer calls directly: `append_file_text` (O(1)
 * message-JSONL append), `atomic_write_text`/`atomic_write_with_backup`/
 * `restore_from_backup`/`cleanup_old_backups` (settings/index.json/memdir atomic
 * writes + backup rotation). These were previously stubbed → returned null →
 * read as SUCCESS by the caller → messages/settings silently never hit disk
 * (empty conversation dirs after restart). They live here (not a separate
 * module) because they are file writes in the same security domain — they MUST
 * go through the same `assertAllowed` scope guard, or a compromised renderer
 * could use atomic_write_text to escape the plugin:fs sandbox. Semantics mirror
 * src-tauri/src/{append_file,atomic_write}.rs exactly (append mode; tempfile +
 * fsync + rename; `.{name}.backup.{unix_ms}` backups; EXDEV-fallback restore).
 *
 * Deferred: `plugin:fs|watch` (channel-streamed) and the FileHandle/rid ops
 * (open/create/read/write/seek/stat/lstat/read_text_file_lines).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** Sentinel returned when `cmd` isn't an fs command, so tauriHost.cjs falls through. */
const FS_MISS = Symbol('fs-dispatch-miss');

/** Monotonic suffix so concurrent atomic writes in one dir get distinct temp names. */
let tmpCounter = 0;

/**
 * Atomic write: tempfile (same dir) + fsync + rename. Mirrors
 * atomic_write.rs::write_atomic — a reader sees either fully-old or fully-new
 * content, never partial (rename is a single atomic syscall). Parent dirs are
 * created as needed. On any failure the temp file is cleaned up and the target
 * is left untouched.
 * @param {string} target absolute, already scope-checked
 * @param {Buffer | string} content
 */
function writeAtomic(target, content) {
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  // Temp in the SAME directory so the rename stays within one filesystem.
  const tmp = path.join(parent, `.${path.basename(target)}.tmp.${process.pid}.${tmpCounter++}`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, content);
    fs.fsyncSync(fd); // durable before the rename
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, target);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* temp may not exist */
    }
    throw err;
  }
}

/**
 * Backup path `/{dir}/.{filename}.backup.{unix_ms}` next to the target —
 * byte-for-byte the format atomic_write.rs::backup_path_for produces (Date.now()
 * is unix ms, matching Rust's duration_since(UNIX_EPOCH).as_millis()).
 * @param {string} target
 */
function backupPathFor(target) {
  return path.join(path.dirname(target), `.${path.basename(target)}.backup.${Date.now()}`);
}

/** Allowed root prefixes (macOS/Linux), mirroring capabilities/default.json. */
function allowedRoots() {
  return [
    os.homedir(), // $HOME/** (includes the app data dir under Application Support)
    os.tmpdir(), // $TEMP/**
    '/tmp',
    '/private/tmp',
    '/Volumes',
    '/Applications',
    process.resourcesPath, // $RESOURCE/** (approx)
  ]
    .filter((r) => typeof r === 'string' && r.length > 0)
    .map((r) => path.resolve(r));
}

/**
 * Refuse a resolved path that escapes the capability scope. `..` is collapsed
 * by path.resolve first, so a baseDir-relative `../../etc/passwd` can't slip
 * through. No-op on Windows (Tauri capabilities there were `**`).
 * @param {string} resolvedPath
 * @param {{ remove?: boolean }} [opts]
 */
function assertAllowed(resolvedPath, opts) {
  if (process.platform === 'win32') return; // windows-extras.json = ** (allow-all)
  const norm = path.resolve(resolvedPath);
  const underRoot = allowedRoots().some((root) => norm === root || norm.startsWith(root + path.sep));
  if (!underRoot) {
    throw new Error(`fs: path is outside the allowed scope: ${norm}`);
  }
  // remove had an explicit deny for the `.abu` data ROOT itself (its contents
  // are removable, the root dir is not) — protects all conversations/skills/
  // secrets from a single recursive wipe.
  if (opts && opts.remove && path.basename(norm) === '.abu') {
    throw new Error('fs: refusing to remove the .abu data root');
  }
}

/**
 * Resolve a frontend-supplied path against a Tauri BaseDirectory number (if
 * given) and enforce the capability scope. Lazily requires tauriHost.cjs
 * (which requires this module at its top level — a module-scope require here
 * would capture `undefined` for `baseDir` mid-load).
 * @param {import('electron').App} app
 * @param {string} p
 * @param {number | undefined} baseDirNum
 * @param {{ remove?: boolean }} [opts]
 */
function resolveScoped(app, p, baseDirNum, opts) {
  let resolved = p;
  if (baseDirNum != null) {
    const { baseDir } = require('./tauriHost.cjs');
    resolved = path.join(baseDir(app, baseDirNum), p);
  }
  assertAllowed(resolved, opts);
  return resolved;
}

/**
 * @param {import('electron').App} app
 * @param {string} cmd
 * @param {{ args?: Record<string, unknown>; body?: unknown; headers?: Record<string, string> }} payload
 */
function fsDispatch(app, cmd, payload) {
  const { args, body, headers } = payload || {};
  const a = args || {};
  const baseOf = (o) => (o && o.baseDir != null ? o.baseDir : undefined);

  switch (cmd) {
    case 'plugin:fs|exists':
      // exists is a probe — a path outside scope simply "doesn't exist" to the
      // caller rather than throwing (Tauri's scope denial also surfaces as a
      // rejected probe, but false is the safer, less-crashy answer for a boot
      // existence check like enterprise/binding.json).
      try {
        return fs.existsSync(resolveScoped(app, a.path, baseOf(a.options)));
      } catch {
        return false;
      }

    case 'plugin:fs|read_text_file':
    case 'plugin:fs|read_file':
      // Return the raw bytes as a Buffer (a Uint8Array) — the frontend api does
      // `Uint8Array.from(arr)` + (text) TextDecoder. Returning the Buffer
      // directly (vs spreading to a number[]) avoids the ~8× memory blow-up and
      // giant structured-clone of a big file. read_file (binary) shares this —
      // it was missing before (image rehydration / skill unzip / share bundle).
      return fs.readFileSync(resolveScoped(app, a.path, baseOf(a.options)));

    case 'plugin:fs|read_dir':
      return fs
        .readdirSync(resolveScoped(app, a.path, baseOf(a.options)), { withFileTypes: true })
        .map((d) => ({
          name: d.name,
          isDirectory: d.isDirectory(),
          isFile: d.isFile(),
          isSymlink: d.isSymbolicLink(),
        }));

    case 'plugin:fs|mkdir':
      fs.mkdirSync(resolveScoped(app, a.path, baseOf(a.options)), {
        recursive: !!(a.options && a.options.recursive),
      });
      return null;

    case 'plugin:fs|remove':
      fs.rmSync(resolveScoped(app, a.path, baseOf(a.options), { remove: true }), {
        recursive: !!(a.options && a.options.recursive),
        force: false,
      });
      return null;

    case 'plugin:fs|rename': {
      // RenameOptions carries oldPathBaseDir/newPathBaseDir — NOT baseDir.
      const o = a.options || {};
      const oldResolved = resolveScoped(app, a.oldPath, o.oldPathBaseDir);
      const newResolved = resolveScoped(app, a.newPath, o.newPathBaseDir);
      fs.renameSync(oldResolved, newResolved);
      return null;
    }

    case 'plugin:fs|copy_file': {
      // CopyFileOptions carries fromPathBaseDir/toPathBaseDir — NOT baseDir.
      const o = a.options || {};
      const fromResolved = resolveScoped(app, a.fromPath, o.fromPathBaseDir);
      const toResolved = resolveScoped(app, a.toPath, o.toPathBaseDir);
      fs.copyFileSync(fromResolved, toResolved);
      return null;
    }

    case 'plugin:fs|write_text_file':
    case 'plugin:fs|write_file': {
      // RAW-BODY form: path + options in headers, bytes in body.
      const h = headers || {};
      const p = decodeURIComponent(h.path);
      const options = JSON.parse(h.options || '{}');
      const resolved = resolveScoped(app, p, options.baseDir);
      const buf = Buffer.from(body);
      const exists = fs.existsSync(resolved);
      // Honor Tauri's create/createNew: create:false rejects a missing file
      // (used as an existence guard); createNew rejects an existing file.
      if (options.create === false && !exists) {
        throw new Error(`fs: file does not exist and create is false: ${resolved}`);
      }
      if (options.createNew && exists) {
        throw new Error(`fs: file already exists and createNew is set: ${resolved}`);
      }
      if (options.append) {
        fs.appendFileSync(resolved, buf);
      } else {
        fs.writeFileSync(resolved, buf);
      }
      return null;
    }

    // ── Custom write commands (F1a) — bare names, plain-JSON args, absolute
    // paths (no baseDir). Same scope guard as plugin:fs above. ──

    case 'append_file_text': {
      // Native O(1) append: mkdir parent + open in append mode + write only
      // `data`. Mirrors append_file.rs::append_sync. The message-JSONL hot path.
      const resolved = resolveScoped(app, a.path, undefined);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.appendFileSync(resolved, String(a.data));
      return null;
    }

    case 'atomic_write_text': {
      writeAtomic(resolveScoped(app, a.path, undefined), String(a.content));
      return null;
    }

    case 'atomic_write_with_backup': {
      // Copy any existing target to a timestamped backup, THEN atomic-write. If
      // the write fails the original is intact (we only copied) and we remove
      // the now-orphaned backup. Returns snake_case {wrote, backup_path} to match
      // the Rust struct the frontend's atomicFs.ts decodes.
      const resolved = resolveScoped(app, a.path, undefined);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      let backupPath = null;
      if (fs.existsSync(resolved)) {
        backupPath = backupPathFor(resolved);
        fs.copyFileSync(resolved, backupPath);
      }
      try {
        writeAtomic(resolved, String(a.content));
      } catch (err) {
        if (backupPath) {
          try {
            fs.rmSync(backupPath, { force: true });
          } catch {
            /* best-effort */
          }
        }
        throw err;
      }
      return { wrote: true, backup_path: backupPath };
    }

    case 'restore_from_backup': {
      // Restore target from a prior backup; the backup is consumed (renamed
      // away). Cross-device rename falls back to copy + unlink. Mirrors
      // atomic_write.rs::restore_from_backup.
      const targetPath = resolveScoped(app, a.target, undefined);
      const backupPath = resolveScoped(app, a.backup, undefined);
      if (!fs.existsSync(backupPath)) {
        throw new Error(`backup not found: ${a.backup}`);
      }
      try {
        fs.renameSync(backupPath, targetPath);
      } catch (err) {
        if (err && err.code === 'EXDEV') {
          fs.copyFileSync(backupPath, targetPath);
          fs.rmSync(backupPath, { force: true });
        } else {
          throw err;
        }
      }
      return null;
    }

    case 'cleanup_old_backups': {
      // Remove `.*.backup.*` files in `dir` older than ttl_hours. Only touches
      // files matching that pattern, so arbitrary user files are never removed.
      // A per-file removal error is logged and skipped, not fatal. Returns the
      // count removed. Mirrors atomic_write.rs::cleanup_old_backups.
      const dir = resolveScoped(app, a.dir, undefined);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return 0; // dir may not exist yet on first run — silent success
      }
      const ttlMs = (Number(a.ttl_hours) || 0) * 3600 * 1000;
      const now = Date.now();
      let removed = 0;
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith('.') || !name.includes('.backup.')) continue;
        const full = path.join(dir, name);
        let mtimeMs;
        try {
          mtimeMs = fs.statSync(full).mtimeMs;
        } catch {
          continue;
        }
        if (now - mtimeMs > ttlMs) {
          try {
            fs.rmSync(full, { force: true });
            removed++;
          } catch (err) {
            console.error(`[fsHost] backup cleanup skipped ${full}: ${err && err.message}`);
          }
        }
      }
      return removed;
    }

    default:
      return FS_MISS;
  }
}

module.exports = { fsDispatch, FS_MISS };
