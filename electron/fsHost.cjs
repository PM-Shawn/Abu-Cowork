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
 * `plugin:fs|watch`/`plugin:fs|unwatch` (channel-streamed) are handled by the
 * sibling module electron/fsWatchHost.cjs (Phase 2 slice F4), which reuses
 * `assertAllowed` (exported below) for the same capability-scope guard.
 *
 * Deferred: the FileHandle/rid ops (open/create/read/write/seek/
 * read_text_file_lines). `stat`/`lstat` are implemented here because callers
 * use them for write-size guards and symlink-safe path inspection.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

/** Sentinel returned when `cmd` isn't an fs command, so tauriHost.cjs falls through. */
const FS_MISS = Symbol('fs-dispatch-miss');

function noFollowFlag() {
  return typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
}

function writeAll(fd, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('fs: write made no progress');
    offset += written;
  }
}

function openExclusiveSibling(parent, prefix) {
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    noFollowFlag();
  for (let attempt = 0; attempt < 32; attempt++) {
    const candidate = path.join(parent, `${prefix}.${crypto.randomBytes(16).toString('hex')}`);
    try {
      return { path: candidate, fd: fs.openSync(candidate, flags, 0o600) };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`fs: could not create an exclusive temporary file in ${parent}`);
}

function copyToExclusiveSibling(source, parent, prefix) {
  let sourceFd;
  let output;
  try {
    sourceFd = fs.openSync(source, fs.constants.O_RDONLY | noFollowFlag());
    if (!fs.fstatSync(sourceFd).isFile()) {
      throw new Error(`fs: restore source must be a regular file: ${source}`);
    }
    output = openExclusiveSibling(parent, prefix);
    const chunk = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const read = fs.readSync(sourceFd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      let offset = 0;
      while (offset < read) {
        const written = fs.writeSync(output.fd, chunk, offset, read - offset);
        if (written <= 0) throw new Error('fs: copy made no progress');
        offset += written;
      }
    }
    fs.fsyncSync(output.fd);
    fs.closeSync(output.fd);
    output.fd = undefined;
    fs.closeSync(sourceFd);
    sourceFd = undefined;
    return output.path;
  } catch (err) {
    if (output?.fd !== undefined) {
      try {
        fs.closeSync(output.fd);
      } catch {
        /* already closed */
      }
    }
    if (sourceFd !== undefined) {
      try {
        fs.closeSync(sourceFd);
      } catch {
        /* already closed */
      }
    }
    if (output?.path) {
      try {
        fs.rmSync(output.path, { force: true });
      } catch {
        /* best-effort */
      }
    }
    throw err;
  }
}

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
  // Random + O_EXCL prevents a pre-seeded symlink from redirecting the write.
  const tmp = openExclusiveSibling(parent, `.${path.basename(target)}.tmp.${process.pid}`);
  try {
    writeAll(tmp.fd, content);
    fs.fsyncSync(tmp.fd); // durable before the rename
    fs.closeSync(tmp.fd);
    tmp.fd = undefined;
    fs.renameSync(tmp.path, target);
  } catch (err) {
    if (tmp.fd !== undefined) {
      try {
        fs.closeSync(tmp.fd);
      } catch {
        /* already closed */
      }
    }
    try {
      fs.rmSync(tmp.path, { force: true });
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
  const declared = [
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

  // A root can itself live behind a symlink: on macOS `os.tmpdir()` is
  // `/var/folders/<…>/T` and `/var` links to `/private/var`. Callers hand us
  // the CANONICAL target of an approved path — the renderer pins every file
  // tool to `pathCheck.resolvedPath` — which is lexically OUTSIDE the
  // unresolved spelling of its own root, so the lexical gate below refused
  // reads and writes anywhere under the macOS temp dir. The hand-written
  // '/private/tmp' entry above patched exactly one instance of this; resolve
  // the rest instead. Both spellings name the same directory, so the canonical
  // containment check in assertAllowed() is unaffected.
  const resolved = declared.map((root) => {
    try {
      return fs.realpathSync.native(root);
    } catch {
      return root; // a root that does not exist cannot widen anything
    }
  });

  return [...new Set([...declared, ...resolved])];
}

function isPathWithin(candidate, root) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * Resolve every existing path component through the filesystem. For a
 * non-existent write target, resolve the nearest existing ancestor and append
 * only the still-missing lexical tail. A dangling symlink is rejected rather
 * than treated as a missing path: writing through it could otherwise create a
 * file outside the capability roots.
 *
 * `followFinalSymlink:false` is only for operations on the directory entry
 * itself (`lstat`, remove, rename). Parent components are always resolved.
 */
function canonicalizeForScope(resolvedPath, followFinalSymlink = true) {
  const norm = path.resolve(resolvedPath);
  let cursor = norm;
  const missingTail = [];

  if (!followFinalSymlink) {
    missingTail.unshift(path.basename(cursor));
    cursor = path.dirname(cursor);
  }

  for (;;) {
    let exists = false;
    try {
      fs.lstatSync(cursor);
      exists = true;
    } catch (err) {
      if (!err || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR')) throw err;
    }

    if (exists) {
      let real;
      try {
        real = fs.realpathSync.native(cursor);
      } catch (err) {
        throw new Error(
          `fs: cannot resolve path safely (dangling or inaccessible symlink): ${cursor}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
      return path.resolve(real, ...missingTail);
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(`fs: cannot resolve an existing ancestor for path: ${norm}`);
    }
    missingTail.unshift(path.basename(cursor));
    cursor = parent;
  }
}

function resolveValidatedPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new Error('fs: path must be a non-empty string');
  }
  if (rawPath.includes('\0')) throw new Error('fs: path must not contain NUL');
  if (Buffer.byteLength(rawPath, 'utf8') > 32 * 1024) {
    throw new Error('fs: path is too long');
  }
  return path.resolve(rawPath);
}

/**
 * Resolve a renderer policy-check path through every existing symlink while
 * preserving a missing write tail. The normal filesystem dispatcher still
 * performs its own independent check at operation time; this endpoint only
 * gives pathSafety the canonical value it needs to compare against the
 * narrower run/workspace authorization scope.
 */
function canonicalizeForPathPolicy(rawPath, followFinalSymlink = true) {
  const norm = resolveValidatedPath(rawPath);
  // Windows capabilities intentionally remain broad, but policy decisions must
  // still see junction/reparse-point targets rather than the lexical spelling.
  if (process.platform === 'win32') return canonicalizeForScope(norm, followFinalSymlink);
  return assertAllowed(norm, { followFinalSymlink });
}

/**
 * Refuse a path that escapes the capability scope either lexically or after
 * resolving symlinks. Checking only path.resolve() is insufficient: an allowed
 * `$HOME/link` can point at `/etc`, and `$HOME/link/passwd` remains lexically
 * under HOME while the actual file is not.
 *
 * No-op on Windows for scope parity with the existing Tauri
 * windows-extras.json (`**`). Windows OS confinement is handled by the
 * subsequent sandbox-launcher roadmap item.
 * @param {string} resolvedPath
 * @param {{ remove?: boolean; followFinalSymlink?: boolean }} [opts]
 * @returns {string} normalized absolute path
 */
function assertAllowed(resolvedPath, opts) {
  const norm = resolveValidatedPath(resolvedPath);
  if (process.platform === 'win32') return norm; // windows-extras.json = ** (allow-all)

  const roots = allowedRoots();
  if (!roots.some((root) => isPathWithin(norm, root))) {
    throw new Error(`fs: path is outside the allowed scope: ${norm}`);
  }

  const canonical = canonicalizeForScope(norm, opts?.followFinalSymlink !== false);
  const canonicalRoots = roots.map((root) => canonicalizeForScope(root, true));
  if (!canonicalRoots.some((root) => isPathWithin(canonical, root))) {
    throw new Error(`fs: path escapes the allowed scope through a symlink: ${norm}`);
  }

  // remove had an explicit deny for the `.abu` data ROOT itself (its contents
  // are removable, the root dir is not) — protects all conversations/skills/
  // secrets from a single recursive wipe.
  if (opts?.remove && (path.basename(norm) === '.abu' || path.basename(canonical) === '.abu')) {
    throw new Error('fs: refusing to remove the .abu data root');
  }
  // Use the same canonical operation path that passed the scope check. For
  // entry operations this is canonical-parent + original basename; for all
  // following operations it is the real target path.
  return canonical;
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
  return assertAllowed(resolved, opts);
}

function dateOrNull(value) {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

/** Convert Node's fs.Stats into @tauri-apps/plugin-fs FileInfo wire shape. */
function toFileInfo(info) {
  const unix = process.platform !== 'win32';
  return {
    isFile: info.isFile(),
    isDirectory: info.isDirectory(),
    isSymlink: info.isSymbolicLink(),
    size: info.size,
    mtime: dateOrNull(info.mtime),
    atime: dateOrNull(info.atime),
    birthtime: dateOrNull(info.birthtime),
    readonly: unix ? (info.mode & 0o222) === 0 : false,
    fileAttributes: null,
    dev: unix ? info.dev : null,
    ino: unix ? info.ino : null,
    mode: unix ? info.mode : null,
    nlink: unix ? info.nlink : null,
    uid: unix ? info.uid : null,
    gid: unix ? info.gid : null,
    rdev: unix ? info.rdev : null,
    blksize: unix ? info.blksize : null,
    blocks: unix ? info.blocks : null,
  };
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

    case 'plugin:fs|stat':
      return toFileInfo(fs.statSync(resolveScoped(app, a.path, baseOf(a.options))));

    case 'plugin:fs|lstat':
      return toFileInfo(
        fs.lstatSync(
          resolveScoped(app, a.path, baseOf(a.options), { followFinalSymlink: false })
        )
      );

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
      fs.rmSync(resolveScoped(app, a.path, baseOf(a.options), {
        remove: true,
        followFinalSymlink: false,
      }), {
        recursive: !!(a.options && a.options.recursive),
        force: false,
      });
      return null;

    case 'plugin:fs|rename': {
      // RenameOptions carries oldPathBaseDir/newPathBaseDir — NOT baseDir.
      const o = a.options || {};
      const noFollow = { followFinalSymlink: false };
      const oldResolved = resolveScoped(app, a.oldPath, o.oldPathBaseDir, noFollow);
      const newResolved = resolveScoped(app, a.newPath, o.newPathBaseDir, noFollow);
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
        const backupPrefix = path.basename(backupPathFor(resolved));
        backupPath = copyToExclusiveSibling(resolved, path.dirname(resolved), backupPrefix);
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
      const noFollow = { followFinalSymlink: false };
      const targetPath = resolveScoped(app, a.target, undefined, noFollow);
      const backupPath = resolveScoped(app, a.backup, undefined, noFollow);
      if (!fs.existsSync(backupPath)) {
        throw new Error(`backup not found: ${a.backup}`);
      }
      const backupInfo = fs.lstatSync(backupPath);
      if (backupInfo.isSymbolicLink() || !backupInfo.isFile()) {
        throw new Error(`restore source must be a regular file: ${a.backup}`);
      }
      try {
        fs.renameSync(backupPath, targetPath);
      } catch (err) {
        if (err && err.code === 'EXDEV') {
          const restoreTmp = copyToExclusiveSibling(
            backupPath,
            path.dirname(targetPath),
            `.${path.basename(targetPath)}.restore.${process.pid}`
          );
          try {
            // Rename replaces the target directory entry itself, so an existing
            // target symlink is removed rather than followed.
            fs.renameSync(restoreTmp, targetPath);
            fs.rmSync(backupPath, { force: true });
          } catch (copyErr) {
            try {
              fs.rmSync(restoreTmp, { force: true });
            } catch {
              /* best-effort */
            }
            throw copyErr;
          }
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
      // The frontend (atomicFs.ts:89) sends camelCase `ttlHours` — Tauri
      // auto-cased it to the Rust `ttl_hours` param, but Electron's raw IPC does
      // not, so read the wire key. (Reading `ttl_hours` gave undefined → NaN →
      // 0 → every .*.backup.* deleted on each cleanup — the restore safety net.)
      // Accept the snake_case form too for defensiveness.
      const ttlHours = Number(a.ttlHours ?? a.ttl_hours);
      if (!Number.isFinite(ttlHours) || ttlHours < 0) {
        throw new Error('cleanup_old_backups: ttlHours must be a non-negative finite number');
      }
      const ttlMs = ttlHours * 3600 * 1000;
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

module.exports = {
  fsDispatch,
  FS_MISS,
  assertAllowed,
  canonicalizeForScope,
  canonicalizeForPathPolicy,
  toFileInfo,
};
