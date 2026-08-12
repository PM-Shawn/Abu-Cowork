/**
 * Recoverable Tauri -> Electron file/secret migration.
 *
 * v2 deliberately treats the installed Tauri profile as the authoritative
 * source for the framework transition. Existing Electron data is backed up
 * before any replacement, Electron-only files are retained, and conflicting
 * Electron files are copied to a recovery tree before the Tauri copy wins.
 *
 * The Tauri source is read-only. Relative symlinks are preserved only when
 * their canonical target remains inside the tree being copied. Absolute,
 * dangling, looping, and escaping links are rejected so a profile cannot make
 * the public migration engine copy arbitrary paths.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getMachineUuid, deriveTauriKey, readTauriSecrets } = require('./tauriSecretsReader.cjs');

// v3 adds the Tauri Notice System database. A complete, source-matching v2
// marker is upgraded through the narrowly scoped Notice-only path below; it
// must never replay old Tauri conversations or secrets over an Electron RC.
const MIGRATION_VERSION = 3;
const SENTINEL_FILENAME = 'tauri-migration.json';
const BACKUP_DIRNAME = 'com.abu.app.electron-backups';
const DATA_DIRS = ['conversations', 'sessions', 'backups'];
const SECRET_STORE_FILENAME = 'secrets.enc.json';
const NOTICE_DB_FILENAME = 'notice.sqlite';
const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm'];
const NOTICE_SCHEMA = {
  notice_audit: [
    'id', 'notice_id', 'type', 'tier', 'source', 'decision', 'reason',
    'delivered_to', 'timestamp',
  ],
  notice_inbox: [
    'id', 'notice_id', 'notice_json', 'tier', 'queued_at', 'expires_at', 'delivered',
  ],
};
const COMPLETE_V2_DIR_STATUSES = new Set(['absent', 'copied', 'merged-source-authoritative']);
const CHROMIUM_STATE_NAMES = [
  'Local Storage',
  'IndexedDB',
  'Session Storage',
  'WebStorage',
  'Network',
  'Cookies',
  'Preferences',
];

function readSentinel(sentinelPath) {
  try {
    return JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
  } catch {
    return null;
  }
}

function hasValidSentinel(sentinelPath, sourceFingerprint) {
  const record = readSentinel(sentinelPath);
  return Boolean(
    record?.version === MIGRATION_VERSION &&
    record?.status === 'complete' &&
    record?.summary?.sentinelWritten === true &&
    typeof record?.migratedAt === 'string' &&
    typeof record?.sourceFingerprint === 'string' &&
    (sourceFingerprint === undefined || record.sourceFingerprint === sourceFingerprint)
  );
}

function isTrustedV2Record(record, sourceFingerprint) {
  if (
    record?.version !== 2 ||
    record?.status !== 'complete' ||
    record?.summary?.sentinelWritten !== true ||
    typeof record?.migratedAt !== 'string' ||
    typeof record?.sourceFingerprint !== 'string' ||
    record.sourceFingerprint !== sourceFingerprint
  ) {
    return false;
  }
  const dirs = record.summary?.dirs;
  const secrets = record.summary?.secrets;
  return Boolean(
    dirs &&
    DATA_DIRS.every((name) => COMPLETE_V2_DIR_STATUSES.has(dirs[name]?.status)) &&
    secrets &&
    Array.isArray(secrets.setFailed) &&
    secrets.setFailed.length === 0 &&
    !secrets.readError
  );
}

function hasTrustedV2Sentinel(sentinelPath, sourceFingerprint) {
  return isTrustedV2Record(readSentinel(sentinelPath), sourceFingerprint);
}

function writeJsonAtomic(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const stagingPath = `${filePath}.tmp-${process.pid}`;
  try {
    const fd = fs.openSync(stagingPath, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(record, null, 2), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(stagingPath, filePath);
  } finally {
    fs.rmSync(stagingPath, { force: true });
  }
}

function removeStagingBestEffort(stagingPath) {
  try {
    fs.rmSync(stagingPath, { recursive: true, force: true });
  } catch {
    // The real migration error is reported by the caller.
  }
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function pathKey(candidatePath) {
  const resolved = path.resolve(candidatePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function inspectSafeSymlink(entryPath, treeRoot) {
  if (!treeRoot) {
    throw new Error(`symbolic link has no trusted transition root: ${entryPath}`);
  }
  const linkTarget = fs.readlinkSync(entryPath);
  if (path.isAbsolute(linkTarget)) {
    throw new Error(`absolute symbolic links are not allowed in transition data: ${entryPath}`);
  }
  let rootRealPath;
  let targetRealPath;
  try {
    rootRealPath = fs.realpathSync(treeRoot);
    targetRealPath = fs.realpathSync(path.resolve(path.dirname(entryPath), linkTarget));
  } catch {
    throw new Error(`dangling or looping symbolic links are not allowed in transition data: ${entryPath}`);
  }
  if (!isPathInside(rootRealPath, targetRealPath)) {
    throw new Error(`symbolic link escapes transition data: ${entryPath}`);
  }
  return {
    linkTarget,
    targetStat: fs.statSync(entryPath),
  };
}

function symlinkOverrideMap(repairs = []) {
  return new Map(repairs.map((repair) => [pathKey(repair.entryPath), repair]));
}

function assertSafeEntry(entryPath, stat, treeRoot, symlinkOverrides = null) {
  if (stat.isSymbolicLink()) {
    const override = symlinkOverrides?.get(pathKey(entryPath));
    if (override) {
      return {
        linkTarget: override.replacementRelativeTarget,
        targetStat: fs.statSync(override.localTargetPath),
      };
    }
    return inspectSafeSymlink(entryPath, treeRoot);
  }
  if (!stat.isDirectory() && !stat.isFile()) {
    throw new Error(`unsupported filesystem entry in transition data: ${entryPath}`);
  }
  return null;
}

/**
 * Node's old fs.cpSync default rewrote copied relative symlinks into absolute
 * links pointing back into the Tauri source tree. Early Electron transition
 * builds used that API, so a later safe v2 migration can encounter those links
 * in the Electron destination even though the installed Tauri source is valid.
 *
 * Accept only that exact, reproducible legacy shape:
 *  - the corresponding Tauri entry is a safe relative symlink;
 *  - the absolute Electron target is exactly the resolved Tauri target;
 *  - the replacement relative target already resolves inside Electron data.
 *
 * Every other absolute link remains a hard failure.
 */
function inspectLegacyElectronSymlinkRepairs(tauriDir, electronDir) {
  const repairs = [];

  for (const name of DATA_DIRS) {
    const sourceRoot = path.join(tauriDir, name);
    const electronRoot = path.join(electronDir, name);
    if (!fs.existsSync(electronRoot)) continue;

    const electronRootReal = fs.realpathSync(electronRoot);
    const sourceRootExists = fs.existsSync(sourceRoot);

    function visit(entryPath, relativePath) {
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        const originalTarget = fs.readlinkSync(entryPath);
        if (!path.isAbsolute(originalTarget)) {
          inspectSafeSymlink(entryPath, electronRoot);
          return;
        }

        const sourcePath = path.join(sourceRoot, relativePath);
        if (!sourceRootExists || !fs.existsSync(sourcePath)) {
          throw new Error(`absolute symbolic links are not allowed in transition data: ${entryPath}`);
        }
        const sourceStat = fs.lstatSync(sourcePath);
        if (!sourceStat.isSymbolicLink()) {
          throw new Error(`absolute symbolic links are not allowed in transition data: ${entryPath}`);
        }
        const sourceSymlink = inspectSafeSymlink(sourcePath, sourceRoot);
        const expectedLegacyTarget = path.resolve(
          path.dirname(sourcePath),
          sourceSymlink.linkTarget
        );
        if (pathKey(originalTarget) !== pathKey(expectedLegacyTarget)) {
          throw new Error(`absolute symbolic links are not allowed in transition data: ${entryPath}`);
        }

        let originalTargetReal;
        let sourceTargetReal;
        let localTargetReal;
        const localTargetPath = path.resolve(
          path.dirname(entryPath),
          sourceSymlink.linkTarget
        );
        try {
          originalTargetReal = fs.realpathSync(entryPath);
          sourceTargetReal = fs.realpathSync(sourcePath);
          localTargetReal = fs.realpathSync(localTargetPath);
        } catch {
          throw new Error(`legacy transition symbolic link cannot be repaired safely: ${entryPath}`);
        }
        if (
          pathKey(originalTargetReal) !== pathKey(sourceTargetReal) ||
          !isPathInside(electronRootReal, localTargetReal)
        ) {
          throw new Error(`legacy transition symbolic link cannot be repaired safely: ${entryPath}`);
        }

        repairs.push({
          entryPath,
          relativePath: path.join(name, relativePath),
          sourcePath,
          originalAbsoluteTarget: originalTarget,
          replacementRelativeTarget: sourceSymlink.linkTarget,
          localTargetPath,
          targetType: fs.statSync(localTargetPath).isDirectory() ? 'dir' : 'file',
        });
        return;
      }
      if (!stat.isDirectory() && !stat.isFile()) {
        throw new Error(`unsupported filesystem entry in transition data: ${entryPath}`);
      }
      if (!stat.isDirectory()) return;
      const entries = fs.readdirSync(entryPath, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        visit(
          path.join(entryPath, entry.name),
          relativePath ? path.join(relativePath, entry.name) : entry.name
        );
      }
    }

    visit(electronRoot, '');
  }

  return repairs.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function fileDigest(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function inventoryTree(root, treeRoot = root, symlinkOverrides = null) {
  if (!fs.existsSync(root)) {
    return { exists: false, files: 0, bytes: 0, fingerprint: 'absent' };
  }
  const aggregate = crypto.createHash('sha256');
  let files = 0;
  let bytes = 0;

  function visit(current, relative) {
    const stat = fs.lstatSync(current);
    const safeSymlink = assertSafeEntry(current, stat, treeRoot, symlinkOverrides);
    if (safeSymlink) {
      aggregate.update(`l\0${relative}\0${safeSymlink.linkTarget}\n`);
      files += 1;
      bytes += Buffer.byteLength(safeSymlink.linkTarget);
      return;
    }
    if (stat.isFile()) {
      const digest = fileDigest(current);
      aggregate.update(`f\0${relative}\0${stat.size}\0${digest}\n`);
      files += 1;
      bytes += stat.size;
      return;
    }
    aggregate.update(`d\0${relative}\n`);
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      visit(path.join(current, entry.name), relative ? path.join(relative, entry.name) : entry.name);
    }
  }

  visit(root, '');
  return { exists: true, files, bytes, fingerprint: aggregate.digest('hex') };
}

function legacySourceFingerprint(dirs, secrets) {
  const aggregate = crypto.createHash('sha256');
  for (const name of DATA_DIRS) {
    aggregate.update(`${name}\0${dirs[name].fingerprint}\n`);
  }
  aggregate.update(`secrets\0${secrets.fingerprint}\n`);
  return aggregate.digest('hex');
}

function sourceInventoryV2(tauriDir) {
  const dirs = {};
  for (const name of DATA_DIRS) {
    dirs[name] = inventoryTree(path.join(tauriDir, name));
  }
  const secrets = inventoryTree(path.join(tauriDir, 'secrets.bin'));
  return {
    dirs,
    secrets,
    fingerprint: legacySourceFingerprint(dirs, secrets),
  };
}

function sourceInventory(tauriDir) {
  const legacy = sourceInventoryV2(tauriDir);
  const aggregate = crypto.createHash('sha256');
  for (const name of DATA_DIRS) {
    aggregate.update(`${name}\0${legacy.dirs[name].fingerprint}\n`);
  }
  aggregate.update(`secrets\0${legacy.secrets.fingerprint}\n`);
  const notice = inventorySqliteBundle(path.join(tauriDir, NOTICE_DB_FILENAME));
  aggregate.update(`notice\0${notice.fingerprint}\n`);
  return {
    dirs: legacy.dirs,
    secrets: legacy.secrets,
    notice,
    fingerprint: aggregate.digest('hex'),
  };
}

function sqliteBundlePaths(databasePath) {
  return [databasePath, ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${databasePath}${suffix}`)];
}

// A WAL database is not represented by its main file alone.  Include the
// sidecars in the migration fingerprint/space estimate, while the actual copy
// below is a SQLite-consistent VACUUM snapshot rather than three racy copies.
function inventorySqliteBundle(databasePath) {
  const aggregate = crypto.createHash('sha256');
  let files = 0;
  let bytes = 0;
  const parts = {};
  for (const candidate of sqliteBundlePaths(databasePath)) {
    const name = path.basename(candidate);
    const entry = inventoryTree(candidate);
    parts[name] = entry;
    files += entry.files;
    bytes += entry.bytes;
    if (candidate === databasePath) {
      aggregate.update(`${name}\0${entry.fingerprint}\n`);
    } else if (candidate.endsWith('-wal')) {
      // A read-only SQLite connection may create an empty WAL bookkeeping
      // file.  It carries no rows, so it must not invalidate a completed
      // migration by itself; non-empty WAL contents remain fingerprinted.
      aggregate.update(`${name}\0${entry.bytes > 0 ? entry.fingerprint : 'empty-or-absent'}\n`);
    } else {
      // -shm is lock/index bookkeeping, not database content.  Keep it in
      // the inventory for disk-space reporting but never treat its volatile
      // bytes as a source-data mutation.
      aggregate.update(`${name}\0ignored\n`);
    }
  }
  return {
    exists: fs.existsSync(databasePath),
    files,
    bytes,
    parts,
    fingerprint: aggregate.digest('hex'),
  };
}

function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function validateNoticeDatabase(databasePath, label) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (error) {
    throw new Error(
      `cannot safely migrate ${label}: node:sqlite is unavailable (${error instanceof Error ? error.message : String(error)})`
    );
  }

  let db;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new Error(`SQLite integrity_check did not return ok for ${label}`);
    }
    for (const [table, expectedColumns] of Object.entries(NOTICE_SCHEMA)) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
      const missing = expectedColumns.filter((column) => !columns.includes(column));
      if (missing.length > 0) {
        throw new Error(`unsupported Notice SQLite schema in ${label}: ${table} missing ${missing.join(', ')}`);
      }
    }
  } finally {
    db?.close();
  }
}

/**
 * Produce a self-contained SQLite snapshot.  The transition shell runs only
 * after the old Tauri application has exited; this additionally handles a
 * leftover -wal/-shm pair correctly and fails closed if node:sqlite or the
 * schema/integrity checks are unavailable.  Never raw-copy a WAL database.
 */
function snapshotNoticeDatabase(sourcePath, destinationPath, label) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (error) {
    throw new Error(
      `cannot safely snapshot ${label}: node:sqlite is unavailable (${error instanceof Error ? error.message : String(error)})`
    );
  }
  validateNoticeDatabase(sourcePath, label);
  const stagingPath = `${destinationPath}.snapshot-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  removeStagingBestEffort(stagingPath);
  let sourceDb;
  let completed = false;
  try {
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    sourceDb = new DatabaseSync(sourcePath, { readOnly: true });
    // VACUUM INTO is SQLite's online-backup-equivalent for this synchronous
    // API: it reads the coherent WAL view into a new standalone database.
    sourceDb.exec(`VACUUM INTO ${sqlQuote(stagingPath)}`);
    sourceDb.close();
    sourceDb = null;
    validateNoticeDatabase(stagingPath, `${label} snapshot`);
    completed = true;
    return stagingPath;
  } catch (error) {
    throw new Error(
      `could not create a consistent Notice SQLite snapshot for ${label}: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    sourceDb?.close();
    // The caller owns a successfully returned staging file.  All failed
    // snapshots are removed here, including a partially created VACUUM file.
    if (!completed) removeStagingBestEffort(stagingPath);
  }
}

function installNoticeSnapshot(stagingPath, destinationPath) {
  for (const sidecarPath of SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${destinationPath}${suffix}`)) {
    fs.rmSync(sidecarPath, { force: true });
  }
  if (process.platform === 'win32' && fs.existsSync(destinationPath)) {
    // Windows cannot reliably replace an existing SQLite file with rename.
    // It has already been backed up as a validated snapshot, and the new
    // snapshot remains intact until this recoverable rename succeeds.
    fs.rmSync(destinationPath, { force: true });
  }
  fs.renameSync(stagingPath, destinationPath);
}

function migrateNoticeDatabase(sourcePath, destinationPath, dryRun) {
  if (!fs.existsSync(sourcePath)) {
    return { status: 'absent', copied: 0, replaced: 0, snapshot: false };
  }
  const replacing = fs.existsSync(destinationPath);
  if (dryRun) {
    validateNoticeDatabase(sourcePath, 'Tauri Notice database');
    return {
      status: replacing ? 'would-replace-source-authoritative' : 'would-copy-consistent-snapshot',
      copied: replacing ? 0 : 1,
      replaced: replacing ? 1 : 0,
      snapshot: false,
    };
  }

  const snapshotPath = snapshotNoticeDatabase(
    sourcePath,
    destinationPath,
    'Tauri Notice database'
  );
  try {
    // The full pre-migration Electron database was snapshotted into the
    // recovery tree before this point.  Tauri is authoritative for a
    // framework transition, so replace the one database atomically/staged
    // rather than attempting an unsafe row merge with a live WAL.
    installNoticeSnapshot(snapshotPath, destinationPath);
    validateNoticeDatabase(destinationPath, 'migrated Electron Notice database');
    return {
      status: replacing ? 'replaced-source-authoritative' : 'copied-consistent-snapshot',
      copied: replacing ? 0 : 1,
      replaced: replacing ? 1 : 0,
      snapshot: true,
    };
  } finally {
    removeStagingBestEffort(snapshotPath);
  }
}

function mergeNoticeDatabaseIntoElectron(sourcePath, destinationPath, dryRun) {
  if (!fs.existsSync(sourcePath)) {
    return { status: 'absent', auditImported: 0, auditDuplicates: 0, inboxImported: 0, inboxPreserved: 0, snapshot: false };
  }
  if (!fs.existsSync(destinationPath)) {
    return migrateNoticeDatabase(sourcePath, destinationPath, dryRun);
  }
  validateNoticeDatabase(sourcePath, 'Tauri Notice database');
  validateNoticeDatabase(destinationPath, 'existing Electron Notice database');
  if (dryRun) {
    return {
      status: 'would-merge-into-electron-baseline',
      auditImported: 0,
      auditDuplicates: 0,
      inboxImported: 0,
      inboxPreserved: 0,
      snapshot: false,
    };
  }

  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (error) {
    throw new Error(
      `cannot safely merge Notice databases: node:sqlite is unavailable (${error instanceof Error ? error.message : String(error)})`
    );
  }
  const snapshotPath = snapshotNoticeDatabase(
    sourcePath,
    `${destinationPath}.v2-import`,
    'Tauri Notice database for v2 upgrade'
  );
  let sourceDb;
  let destinationDb;
  try {
    sourceDb = new DatabaseSync(snapshotPath, { readOnly: true });
    destinationDb = new DatabaseSync(destinationPath);
    const auditRows = sourceDb.prepare(
      `SELECT notice_id, type, tier, source, decision, reason, delivered_to, timestamp
       FROM notice_audit ORDER BY id`,
    ).all();
    const inboxRows = sourceDb.prepare(
      `SELECT notice_id, notice_json, tier, queued_at, expires_at, delivered
      FROM notice_inbox ORDER BY id`,
    ).all();
    // Audit ids are per-database AUTOINCREMENT values, not portable identity.
    // The full immutable audit payload is the cross-version business key.
    const auditInsert = destinationDb.prepare(
      `INSERT INTO notice_audit (notice_id, type, tier, source, decision, reason, delivered_to, timestamp)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM notice_audit
         WHERE notice_id = ? AND type = ? AND tier = ? AND source = ?
           AND decision = ? AND reason IS ? AND delivered_to = ? AND timestamp = ?
       )`,
    );
    // Electron's notice_id may already be delivered or have newer payload
    // details; INSERT OR IGNORE preserves that live state exactly.
    const inboxInsert = destinationDb.prepare(
      `INSERT OR IGNORE INTO notice_inbox
       (notice_id, notice_json, tier, queued_at, expires_at, delivered)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const result = {
      status: 'merged-into-electron-baseline',
      auditImported: 0,
      auditDuplicates: 0,
      inboxImported: 0,
      inboxPreserved: 0,
      snapshot: true,
    };
    destinationDb.exec('BEGIN IMMEDIATE');
    try {
      for (const row of auditRows) {
        const change = auditInsert.run(
          row.notice_id, row.type, row.tier, row.source, row.decision,
          row.reason, row.delivered_to, row.timestamp,
          row.notice_id, row.type, row.tier, row.source, row.decision,
          row.reason, row.delivered_to, row.timestamp,
        );
        if (change.changes === 1) result.auditImported += 1;
        else result.auditDuplicates += 1;
      }
      for (const row of inboxRows) {
        const change = inboxInsert.run(
          row.notice_id, row.notice_json, row.tier, row.queued_at, row.expires_at, row.delivered,
        );
        if (change.changes === 1) result.inboxImported += 1;
        else result.inboxPreserved += 1;
      }
      destinationDb.exec('COMMIT');
    } catch (error) {
      try {
        destinationDb.exec('ROLLBACK');
      } catch {
        // Preserve the original failure; the pre-merge recovery snapshot is intact.
      }
      throw error;
    }
    destinationDb.close();
    destinationDb = null;
    sourceDb.close();
    sourceDb = null;
    validateNoticeDatabase(destinationPath, 'merged Electron Notice database');
    return result;
  } finally {
    destinationDb?.close();
    sourceDb?.close();
    removeStagingBestEffort(snapshotPath);
  }
}

function upgradeTrustedV2SentinelWithNotice(opts, inventory, v2Record, sentinelPath) {
  const { tauriDir, electronDir, dryRun = false } = opts;
  const log = opts.log || console;
  const warn = (msg) => log.warn(`[tauriMigration] ${msg}`);
  const summary = {
    version: MIGRATION_VERSION,
    upgradedFromVersion: 2,
    noticeOnlyUpgrade: true,
    dryRun,
    sourceFingerprint: inventory.fingerprint,
    legacySourceFingerprint: v2Record.sourceFingerprint,
    inventory: { notice: inventory.notice },
    // A trusted v2 marker proves these families completed against the same
    // Tauri source. Deliberately do not even read/copy them during v3 upgrade:
    // Electron RC activity after v2 owns its conversations and secrets.
    secrets: { migrated: [], overwritten: [], skippedExisting: [], decryptFailed: [], setFailed: [], skippedReason: 'preserved-from-v2' },
    dirs: Object.fromEntries(
      DATA_DIRS.map((name) => [name, { status: 'preserved-from-v2', copied: 0, identical: 0, replaced: 0, targetOnly: 0 }])
    ),
    notice: { status: 'pending', copied: 0, replaced: 0, snapshot: false },
    backup: { path: null, items: [] },
    sentinelWritten: false,
  };

  try {
    summary.backup = backupExistingElectronData(
      electronDir,
      inventory.fingerprint,
      dryRun,
      [],
      [NOTICE_DB_FILENAME]
    );
  } catch (error) {
    summary.backup.error = error instanceof Error ? error.message : String(error);
    warn(`could not back up existing Electron Notice data: ${summary.backup.error}`);
    return summary;
  }

  try {
    summary.notice = mergeNoticeDatabaseIntoElectron(
      path.join(tauriDir, NOTICE_DB_FILENAME),
      path.join(electronDir, NOTICE_DB_FILENAME),
      dryRun
    );
  } catch (error) {
    summary.notice = {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      copied: 0,
      replaced: 0,
      snapshot: false,
    };
  }

  if (!dryRun) {
    try {
      const finalInventory = sourceInventory(tauriDir);
      if (finalInventory.fingerprint !== inventory.fingerprint) {
        summary.sourceChangedDuringMigration = true;
      }
    } catch (error) {
      summary.sourceChangedDuringMigration =
        error instanceof Error ? error.message : String(error);
    }
  }

  const clean =
    !summary.backup.error &&
    summary.notice.status !== 'error' &&
    !summary.sourceChangedDuringMigration;
  if (clean && !dryRun) {
    summary.sentinelWritten = true;
    writeJsonAtomic(sentinelPath, {
      version: MIGRATION_VERSION,
      status: 'complete',
      migratedAt: new Date().toISOString(),
      sourceFingerprint: inventory.fingerprint,
      summary,
    });
    log.log(`[tauriMigration] upgraded trusted v2 marker to v${MIGRATION_VERSION} with Notice data`);
  } else if (!dryRun) {
    warn('Notice-only v2 upgrade incomplete; completion marker was not written');
  }
  return summary;
}

function copyTreeSafe(source, destination, treeRoot = source, symlinkOverrides = null) {
  const stat = fs.lstatSync(source);
  const safeSymlink = assertSafeEntry(source, stat, treeRoot, symlinkOverrides);
  if (safeSymlink) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.symlinkSync(
      safeSymlink.linkTarget,
      destination,
      safeSymlink.targetStat.isDirectory() ? 'dir' : 'file'
    );
    return;
  }
  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    return;
  }
  fs.mkdirSync(destination, { recursive: false });
  const entries = fs.readdirSync(source, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    copyTreeSafe(
      path.join(source, entry.name),
      path.join(destination, entry.name),
      treeRoot,
      symlinkOverrides
    );
  }
}

function copyTreeIfAbsent(source, destination) {
  if (!fs.existsSync(source) || fs.existsSync(destination)) return false;
  const staging = `${destination}.migrating`;
  removeStagingBestEffort(staging);
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    copyTreeSafe(source, staging, source);
    fs.renameSync(staging, destination);
    return true;
  } finally {
    removeStagingBestEffort(staging);
  }
}

function copyForRecovery(source, destination, treeRoot = source, symlinkOverrides = null) {
  if (fs.existsSync(destination)) return;
  const stat = fs.lstatSync(source);
  const safeSymlink = assertSafeEntry(source, stat, treeRoot, symlinkOverrides);
  const staging = `${destination}.recovering-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  removeStagingBestEffort(staging);
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (safeSymlink || stat.isDirectory()) {
      copyTreeSafe(source, staging, treeRoot, symlinkOverrides);
    } else {
      fs.copyFileSync(source, staging, fs.constants.COPYFILE_EXCL);
    }
    fs.renameSync(staging, destination);
  } finally {
    removeStagingBestEffort(staging);
  }
}

function applyLegacyElectronSymlinkRepairs(repairs) {
  let repaired = 0;
  for (const repair of repairs) {
    const staging = `${repair.entryPath}.repair-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    let removedForWindows = false;
    try {
      fs.symlinkSync(
        repair.replacementRelativeTarget,
        staging,
        repair.targetType
      );
      if (process.platform === 'win32') {
        fs.rmSync(repair.entryPath, { force: true });
        removedForWindows = true;
      }
      fs.renameSync(staging, repair.entryPath);
      repaired += 1;
    } catch (error) {
      if (removedForWindows && !fs.existsSync(repair.entryPath)) {
        try {
          fs.symlinkSync(
            repair.originalAbsoluteTarget,
            repair.entryPath,
            repair.targetType
          );
        } catch {
          // The full Electron backup and read-only Tauri source remain
          // available even if Windows cannot restore the legacy link.
        }
      }
      throw error;
    } finally {
      fs.rmSync(staging, { force: true });
    }
  }
  return repaired;
}

function replaceFileAtomic(source, destination) {
  const staging = `${destination}.source-${process.pid}`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, staging);
  try {
    if (process.platform === 'win32') {
      // Windows rename semantics are less reliable than POSIX when a file at
      // the destination was just removed or scanned by another process. The
      // pre-migration Electron tree and this individual conflict have already
      // been copied to the recovery root, while the Tauri source remains
      // read-only. Copying the fully staged bytes into place therefore keeps
      // the operation recoverable and retryable without depending on rename
      // replacement behavior.
      fs.copyFileSync(staging, destination);
    } else {
      fs.renameSync(staging, destination);
    }
  } finally {
    fs.rmSync(staging, { force: true });
  }
}

function mergeSourceAuthoritative(
  source,
  destination,
  recoveryRoot,
  relative = '',
  sourceRoot = source,
  destinationRoot = destination
) {
  const result = { copied: 0, identical: 0, replaced: 0, targetOnly: 0 };
  const sourceStat = fs.lstatSync(source);
  const sourceSymlink = assertSafeEntry(source, sourceStat, sourceRoot);

  if (!fs.existsSync(destination)) {
    if (sourceStat.isDirectory() || sourceSymlink) copyTreeSafe(source, destination, sourceRoot);
    else {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    }
    result.copied +=
      sourceStat.isFile() || sourceSymlink ? 1 : inventoryTree(source, sourceRoot).files;
    return result;
  }

  const destinationStat = fs.lstatSync(destination);
  const destinationSymlink = assertSafeEntry(destination, destinationStat, destinationRoot);
  if (sourceSymlink) {
    if (
      destinationSymlink &&
      destinationSymlink.linkTarget === sourceSymlink.linkTarget
    ) {
      result.identical += 1;
      return result;
    }
    copyForRecovery(
      destination,
      path.join(recoveryRoot, relative || path.basename(destination)),
      destinationRoot
    );
    fs.rmSync(destination, { recursive: true, force: true });
    copyTreeSafe(source, destination, sourceRoot);
    result.replaced += 1;
    return result;
  }
  if (sourceStat.isFile()) {
    if (destinationStat.isFile() && fileDigest(source) === fileDigest(destination)) {
      result.identical += 1;
      return result;
    }
    copyForRecovery(
      destination,
      path.join(recoveryRoot, relative || path.basename(destination)),
      destinationRoot
    );
    fs.rmSync(destination, { recursive: true, force: true });
    replaceFileAtomic(source, destination);
    result.replaced += 1;
    return result;
  }

  if (!destinationStat.isDirectory()) {
    copyForRecovery(
      destination,
      path.join(recoveryRoot, relative || path.basename(destination)),
      destinationRoot
    );
    fs.rmSync(destination, { recursive: true, force: true });
    copyTreeSafe(source, destination, sourceRoot);
    result.replaced += inventoryTree(source, sourceRoot).files;
    return result;
  }

  const sourceNames = new Set();
  const entries = fs.readdirSync(source, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    sourceNames.add(entry.name);
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const child = mergeSourceAuthoritative(
      path.join(source, entry.name),
      path.join(destination, entry.name),
      recoveryRoot,
      childRelative,
      sourceRoot,
      destinationRoot
    );
    for (const key of Object.keys(result)) result[key] += child[key];
  }
  for (const entry of fs.readdirSync(destination, { withFileTypes: true })) {
    if (!sourceNames.has(entry.name)) {
      const targetOnlyPath = path.join(destination, entry.name);
      result.targetOnly +=
        entry.isDirectory() ? inventoryTree(targetOnlyPath, destinationRoot).files : 1;
    }
  }
  return result;
}

function mergeConversationIndex(sourceIndexPath, destinationIndexPath, targetIndexBefore) {
  if (!fs.existsSync(sourceIndexPath)) return;
  let sourceIndex;
  try {
    sourceIndex = JSON.parse(fs.readFileSync(sourceIndexPath, 'utf8'));
  } catch {
    return;
  }
  const targetEntries =
    targetIndexBefore && typeof targetIndexBefore === 'object' && !Array.isArray(targetIndexBefore)
      ? targetIndexBefore.entries
      : null;
  if (!sourceIndex || typeof sourceIndex !== 'object' || Array.isArray(sourceIndex)) {
    return;
  }
  const sourceEntries =
    sourceIndex.entries &&
    typeof sourceIndex.entries === 'object' &&
    !Array.isArray(sourceIndex.entries)
      ? sourceIndex.entries
      : {};
  const merged = {
    version: 1,
    entries: {
      ...(targetEntries && typeof targetEntries === 'object' ? targetEntries : {}),
      ...sourceEntries,
    },
  };
  writeJsonAtomic(destinationIndexPath, merged);
}

function backupExistingElectronData(
  electronDir,
  sourceFingerprint,
  dryRun,
  legacySymlinkRepairs = [],
  candidateNames = [...DATA_DIRS, SECRET_STORE_FILENAME, NOTICE_DB_FILENAME]
) {
  const present = candidateNames.filter((name) => fs.existsSync(path.join(electronDir, name)));
  const baseBackupRoot = path.join(
    path.dirname(electronDir),
    BACKUP_DIRNAME,
    `migration-v${MIGRATION_VERSION}-${sourceFingerprint.slice(0, 16)}`
  );
  if (present.length === 0) return { path: baseBackupRoot, items: [] };
  if (dryRun) {
    return {
      path: baseBackupRoot,
      items: present,
      legacySymlinks: legacySymlinkRepairs.length,
    };
  }
  let backupRoot = baseBackupRoot;
  const completionMarker = path.join(backupRoot, 'file-backup-manifest.json');
  if (fs.existsSync(backupRoot) && !fs.existsSync(completionMarker)) {
    backupRoot = `${baseBackupRoot}-retry-${Date.now()}-${process.pid}`;
  }
  const overrides = symlinkOverrideMap(legacySymlinkRepairs);
  fs.mkdirSync(backupRoot, { recursive: true });
  for (const name of present) {
    if (name === NOTICE_DB_FILENAME) {
      const backupPath = path.join(backupRoot, name);
      if (fs.existsSync(backupPath)) continue;
      const snapshotPath = snapshotNoticeDatabase(
        path.join(electronDir, name),
        backupPath,
        'existing Electron Notice database'
      );
      try {
        fs.renameSync(snapshotPath, backupPath);
      } finally {
        removeStagingBestEffort(snapshotPath);
      }
      continue;
    }
    copyForRecovery(
      path.join(electronDir, name),
      path.join(backupRoot, name),
      electronDir,
      overrides
    );
  }
  let legacySymlinkManifest = null;
  if (legacySymlinkRepairs.length > 0) {
    legacySymlinkManifest = path.join(backupRoot, 'legacy-symlink-repairs.json');
    writeJsonAtomic(legacySymlinkManifest, {
      version: 1,
      recordedAt: new Date().toISOString(),
      items: legacySymlinkRepairs.map((repair) => ({
        relativePath: repair.relativePath,
        originalAbsoluteTarget: repair.originalAbsoluteTarget,
        replacementRelativeTarget: repair.replacementRelativeTarget,
      })),
    });
  }
  writeJsonAtomic(path.join(backupRoot, 'file-backup-manifest.json'), {
    version: 1,
    completedAt: new Date().toISOString(),
    sourceFingerprint,
    items: present,
    legacySymlinks: legacySymlinkRepairs.length,
  });
  return {
    path: backupRoot,
    items: present,
    legacySymlinks: legacySymlinkRepairs.length,
    legacySymlinkManifest,
  };
}

function backupElectronChromiumState(userDataDir, backupRoot) {
  if (!backupRoot || !fs.existsSync(userDataDir)) return { copied: [], absent: [] };
  const destinationRoot = path.join(backupRoot, 'chromium-user-data');
  const copied = [];
  const absent = [];
  fs.mkdirSync(destinationRoot, { recursive: true });
  for (const name of CHROMIUM_STATE_NAMES) {
    const source = path.join(userDataDir, name);
    const destination = path.join(destinationRoot, name);
    if (!fs.existsSync(source)) {
      absent.push(name);
      continue;
    }
    copyForRecovery(source, destination, userDataDir);
    copied.push(name);
  }
  writeJsonAtomic(path.join(destinationRoot, 'backup-manifest.json'), {
    version: 1,
    backedUpAt: new Date().toISOString(),
    copied,
    absent,
  });
  return { copied, absent, path: destinationRoot };
}

function estimateMigrationSpace(
  electronDir,
  inventory,
  userDataDir = null,
  legacySymlinkRepairs = []
) {
  const overrides = symlinkOverrideMap(legacySymlinkRepairs);
  let existingBytes = 0;
  for (const name of [...DATA_DIRS, SECRET_STORE_FILENAME]) {
    const candidate = path.join(electronDir, name);
    if (fs.existsSync(candidate)) {
      existingBytes += inventoryTree(candidate, candidate, overrides).bytes;
    }
  }
  const existingNoticePath = path.join(electronDir, NOTICE_DB_FILENAME);
  if (fs.existsSync(existingNoticePath)) {
    existingBytes += inventorySqliteBundle(existingNoticePath).bytes;
  }
  if (userDataDir && fs.existsSync(userDataDir)) {
    for (const name of CHROMIUM_STATE_NAMES) {
      const candidate = path.join(userDataDir, name);
      if (fs.existsSync(candidate)) {
        existingBytes += inventoryTree(candidate).bytes;
      }
    }
  }
  const sourceBytes =
    Object.values(inventory.dirs).reduce(
      (total, entry) => total + Number(entry.bytes || 0),
      0
    ) + Number(inventory.secrets?.bytes || 0) + Number(inventory.notice?.bytes || 0);
  // Source copy + full Electron recovery backup + staging/headroom. Keep a
  // fixed 64 MiB floor for sentinels, localStorage backup, SQLite rebuilds,
  // and filesystem allocation granularity.
  const requiredBytes = Math.ceil(
    (sourceBytes + existingBytes) * 1.2 + 64 * 1024 * 1024
  );
  let availableBytes = null;
  try {
    const stat = fs.statfsSync(path.dirname(electronDir));
    availableBytes = Number(stat.bavail) * Number(stat.bsize);
  } catch {
    // Unsupported filesystems are handled by actual staged writes; lack of a
    // statfs estimate must not be mistaken for zero available space.
  }
  return {
    sourceBytes,
    existingBytes,
    requiredBytes,
    availableBytes,
    enough: availableBytes === null || availableBytes >= requiredBytes,
  };
}

/**
 * The legacy Tauri app-data dir. v0.30-v0.33 all use com.abu.app in packaged
 * builds; development remains isolated under com.abu.app.dev.
 */
function resolveTauriAppDataDir(appDataParent, isPackaged) {
  return path.join(appDataParent, isPackaged ? 'com.abu.app' : 'com.abu.app.dev');
}

function runTauriMigration(opts) {
  const {
    tauriDir,
    electronDir,
    secretSet,
    secretHas,
    dryRun = false,
    machineKey,
    sourceWins = false,
  } = opts;
  const log = opts.log || console;
  const say = (msg) => log.log(`[tauriMigration] ${msg}`);
  const warn = (msg) => log.warn(`[tauriMigration] ${msg}`);
  const sentinelPath = path.join(electronDir, SENTINEL_FILENAME);

  if (!fs.existsSync(tauriDir)) {
    const summary = {
      version: MIGRATION_VERSION,
      dryRun,
      nothingToMigrate: true,
      sourceFingerprint: 'absent',
      secrets: { migrated: [], overwritten: [], skippedExisting: [], decryptFailed: [], setFailed: [] },
      dirs: {},
      notice: { status: 'absent', copied: 0, replaced: 0, snapshot: false },
      backup: { path: null, items: [] },
      sentinelWritten: false,
    };
    if (!dryRun) {
      summary.sentinelWritten = true;
      writeJsonAtomic(sentinelPath, {
        version: MIGRATION_VERSION,
        status: 'complete',
        migratedAt: new Date().toISOString(),
        sourceFingerprint: summary.sourceFingerprint,
        summary,
      });
    }
    return summary;
  }

  let inventory;
  try {
    inventory = opts.inventory || sourceInventory(tauriDir);
  } catch (error) {
    return {
      version: MIGRATION_VERSION,
      dryRun,
      sourceFingerprint: null,
      inventoryError: error instanceof Error ? error.message : String(error),
      secrets: { migrated: [], overwritten: [], skippedExisting: [], decryptFailed: [], setFailed: [] },
      dirs: {},
      notice: { status: 'not-inventoried', copied: 0, replaced: 0, snapshot: false },
      backup: { path: null, items: [] },
      sentinelWritten: false,
    };
  }
  if (hasValidSentinel(sentinelPath, inventory.fingerprint)) {
    const record = readSentinel(sentinelPath);
    return {
      skipped: 'already-migrated',
      sourceFingerprint: inventory.fingerprint,
      backup: record?.summary?.backup || null,
      inventory: record?.summary?.inventory || null,
    };
  }
  const legacyV2Record = readSentinel(sentinelPath);
  if (legacyV2Record && isTrustedV2Record(
    legacyV2Record,
    legacySourceFingerprint(inventory.dirs, inventory.secrets)
  )) {
    return upgradeTrustedV2SentinelWithNotice(
      opts,
      inventory,
      legacyV2Record,
      sentinelPath
    );
  }

  let legacySymlinkRepairs;
  try {
    legacySymlinkRepairs = inspectLegacyElectronSymlinkRepairs(
      tauriDir,
      electronDir
    );
  } catch (error) {
    return {
      version: MIGRATION_VERSION,
      dryRun,
      sourceFingerprint: inventory.fingerprint,
      legacySymlinkRepairError:
        error instanceof Error ? error.message : String(error),
      secrets: { migrated: [], overwritten: [], skippedExisting: [], decryptFailed: [], setFailed: [] },
      dirs: {},
      notice: { status: 'not-migrated', copied: 0, replaced: 0, snapshot: false },
      backup: { path: null, items: [] },
      sentinelWritten: false,
    };
  }

  const summary = {
    version: MIGRATION_VERSION,
    dryRun,
    sourceFingerprint: inventory.fingerprint,
    inventory: { ...inventory.dirs, notice: inventory.notice },
    secrets: { migrated: [], overwritten: [], skippedExisting: [], decryptFailed: [], setFailed: [] },
    dirs: {},
    notice: { status: 'pending', copied: 0, replaced: 0, snapshot: false },
    backup: { path: null, items: [] },
    legacySymlinks: {
      detected: legacySymlinkRepairs.length,
      repaired: 0,
    },
    sentinelWritten: false,
  };

  try {
    summary.backup = backupExistingElectronData(
      electronDir,
      inventory.fingerprint,
      dryRun,
      legacySymlinkRepairs
    );
  } catch (error) {
    summary.backup.error = error instanceof Error ? error.message : String(error);
    warn(`could not back up existing Electron data: ${summary.backup.error}`);
    return summary;
  }

  if (!dryRun && legacySymlinkRepairs.length > 0) {
    try {
      summary.legacySymlinks.repaired =
        applyLegacyElectronSymlinkRepairs(legacySymlinkRepairs);
    } catch (error) {
      summary.legacySymlinks.error =
        error instanceof Error ? error.message : String(error);
      warn(`could not repair legacy Electron symbolic links: ${summary.legacySymlinks.error}`);
      return summary;
    }
  }

  const secretsBin = path.join(tauriDir, 'secrets.bin');
  if (process.platform !== 'darwin') {
    summary.secrets.skippedReason =
      process.platform === 'win32'
        ? 'Windows keyring migration is handled by tauriLocalStorageMigration'
        : `non-darwin platform (${process.platform})`;
  } else if (!fs.existsSync(secretsBin)) {
    summary.secrets.skippedReason = 'no secrets.bin at source';
  } else {
    try {
      const key = machineKey || deriveTauriKey(getMachineUuid());
      const read = readTauriSecrets(secretsBin, key);
      if (read) {
        summary.secrets.decryptFailed = read.failed;
        for (const [secretKey, value] of read.entries) {
          const existed = secretHas(secretKey);
          if (existed && !sourceWins) {
            summary.secrets.skippedExisting.push(secretKey);
            continue;
          }
          if (!dryRun) {
            try {
              secretSet(secretKey, value);
            } catch (error) {
              summary.secrets.setFailed.push(secretKey);
              warn(`failed to store migrated secret "${secretKey}": ${error instanceof Error ? error.message : String(error)}`);
              continue;
            }
          }
          if (existed) summary.secrets.overwritten.push(secretKey);
          else summary.secrets.migrated.push(secretKey);
        }
      }
    } catch (error) {
      summary.secrets.readError = error instanceof Error ? error.message : String(error);
    }
  }

  for (const name of DATA_DIRS) {
    const source = path.join(tauriDir, name);
    const destination = path.join(electronDir, name);
    if (!fs.existsSync(source)) {
      summary.dirs[name] = { status: 'absent', copied: 0, identical: 0, replaced: 0, targetOnly: 0 };
      continue;
    }
    if (dryRun) {
      summary.dirs[name] = {
        status: fs.existsSync(destination) ? 'would-merge-source-authoritative' : 'would-copy',
        copied: inventory.dirs[name].files,
        identical: 0,
        replaced: 0,
        targetOnly: 0,
      };
      continue;
    }
    try {
      fs.mkdirSync(electronDir, { recursive: true });
      if (!fs.existsSync(destination)) {
        copyTreeIfAbsent(source, destination);
        summary.dirs[name] = {
          status: 'copied',
          copied: inventory.dirs[name].files,
          identical: 0,
          replaced: 0,
          targetOnly: 0,
        };
        continue;
      }

      let targetIndexBefore = null;
      if (name === 'conversations') {
        try {
          targetIndexBefore = JSON.parse(
            fs.readFileSync(path.join(destination, 'index.json'), 'utf8')
          );
        } catch {
          targetIndexBefore = null;
        }
      }
      const recoveryRoot = path.join(
        summary.backup.path ||
          path.join(path.dirname(electronDir), BACKUP_DIRNAME, `migration-v${MIGRATION_VERSION}-${inventory.fingerprint.slice(0, 16)}`),
        'conflicts',
        name
      );
      const merged = mergeSourceAuthoritative(
        source,
        destination,
        recoveryRoot,
        '',
        source,
        destination
      );
      if (name === 'conversations') {
        mergeConversationIndex(
          path.join(source, 'index.json'),
          path.join(destination, 'index.json'),
          targetIndexBefore
        );
      }
      summary.dirs[name] = { status: 'merged-source-authoritative', ...merged };
    } catch (error) {
      summary.dirs[name] = {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  try {
    summary.notice = migrateNoticeDatabase(
      path.join(tauriDir, NOTICE_DB_FILENAME),
      path.join(electronDir, NOTICE_DB_FILENAME),
      dryRun
    );
  } catch (error) {
    summary.notice = {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      copied: 0,
      replaced: 0,
      snapshot: false,
    };
  }

  // Tauri must be closed before transition (the Electron shell starts this
  // one-time path after upgrade).  A second inventory makes that operational
  // precondition observable: any source mutation during this synchronous pass
  // withholds the completion marker and forces a safe retry on next launch.
  if (!dryRun) {
    try {
      const finalInventory = sourceInventory(tauriDir);
      if (finalInventory.fingerprint !== inventory.fingerprint) {
        summary.sourceChangedDuringMigration = true;
      }
    } catch (error) {
      summary.sourceChangedDuringMigration =
        error instanceof Error ? error.message : String(error);
    }
  }

  const clean =
    !summary.inventoryError &&
    !summary.backup.error &&
    !summary.legacySymlinks.error &&
    !summary.secrets.readError &&
    summary.secrets.setFailed.length === 0 &&
    summary.notice.status !== 'error' &&
    !summary.sourceChangedDuringMigration &&
    !Object.values(summary.dirs).some((entry) => entry.status === 'error');
  if (clean && !dryRun) {
    summary.sentinelWritten = true;
    writeJsonAtomic(sentinelPath, {
      version: MIGRATION_VERSION,
      status: 'complete',
      migratedAt: new Date().toISOString(),
      sourceFingerprint: inventory.fingerprint,
      summary,
    });
    say(`migration v${MIGRATION_VERSION} completed`);
  } else if (!dryRun) {
    warn('migration incomplete; completion marker was not written');
  }
  return summary;
}

module.exports = {
  BACKUP_DIRNAME,
  CHROMIUM_STATE_NAMES,
  DATA_DIRS,
  MIGRATION_VERSION,
  NOTICE_DB_FILENAME,
  SENTINEL_FILENAME,
  backupExistingElectronData,
  backupElectronChromiumState,
  estimateMigrationSpace,
  hasValidSentinel,
  hasTrustedV2Sentinel,
  inspectLegacyElectronSymlinkRepairs,
  inventoryTree,
  inventorySqliteBundle,
  mergeSourceAuthoritative,
  migrateNoticeDatabase,
  resolveTauriAppDataDir,
  runTauriMigration,
  sourceInventory,
  sourceInventoryV2,
};
