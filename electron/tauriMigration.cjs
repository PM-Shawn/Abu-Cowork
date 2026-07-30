/**
 * Recoverable Tauri -> Electron file/secret migration.
 *
 * v2 deliberately treats the installed Tauri profile as the authoritative
 * source for the framework transition. Existing Electron data is backed up
 * before any replacement, Electron-only files are retained, and conflicting
 * Electron files are copied to a recovery tree before the Tauri copy wins.
 *
 * The Tauri source is read-only. Symlinks are rejected instead of followed so
 * a profile cannot make the public migration engine copy arbitrary paths.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getMachineUuid, deriveTauriKey, readTauriSecrets } = require('./tauriSecretsReader.cjs');

const MIGRATION_VERSION = 2;
const SENTINEL_FILENAME = 'tauri-migration.json';
const BACKUP_DIRNAME = 'com.abu.app.electron-backups';
const DATA_DIRS = ['conversations', 'sessions', 'backups'];
const SECRET_STORE_FILENAME = 'secrets.enc.json';
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

function assertSafeEntry(entryPath, stat) {
  if (stat.isSymbolicLink()) {
    throw new Error(`symbolic links are not allowed in transition data: ${entryPath}`);
  }
  if (!stat.isDirectory() && !stat.isFile()) {
    throw new Error(`unsupported filesystem entry in transition data: ${entryPath}`);
  }
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

function inventoryTree(root) {
  if (!fs.existsSync(root)) {
    return { exists: false, files: 0, bytes: 0, fingerprint: 'absent' };
  }
  const aggregate = crypto.createHash('sha256');
  let files = 0;
  let bytes = 0;

  function visit(current, relative) {
    const stat = fs.lstatSync(current);
    assertSafeEntry(current, stat);
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

function sourceInventory(tauriDir) {
  const dirs = {};
  const aggregate = crypto.createHash('sha256');
  for (const name of DATA_DIRS) {
    const inventory = inventoryTree(path.join(tauriDir, name));
    dirs[name] = inventory;
    aggregate.update(`${name}\0${inventory.fingerprint}\n`);
  }
  const secretsPath = path.join(tauriDir, 'secrets.bin');
  const secrets = inventoryTree(secretsPath);
  aggregate.update(`secrets\0${secrets.fingerprint}\n`);
  return {
    dirs,
    secrets,
    fingerprint: aggregate.digest('hex'),
  };
}

function copyTreeSafe(source, destination) {
  const stat = fs.lstatSync(source);
  assertSafeEntry(source, stat);
  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    return;
  }
  fs.mkdirSync(destination, { recursive: false });
  const entries = fs.readdirSync(source, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    copyTreeSafe(path.join(source, entry.name), path.join(destination, entry.name));
  }
}

function copyTreeIfAbsent(source, destination) {
  if (!fs.existsSync(source) || fs.existsSync(destination)) return false;
  const staging = `${destination}.migrating`;
  removeStagingBestEffort(staging);
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    copyTreeSafe(source, staging);
    fs.renameSync(staging, destination);
    return true;
  } finally {
    removeStagingBestEffort(staging);
  }
}

function copyForRecovery(source, destination) {
  if (fs.existsSync(destination)) return;
  const stat = fs.lstatSync(source);
  assertSafeEntry(source, stat);
  if (stat.isDirectory()) {
    copyTreeSafe(source, destination);
  } else {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  }
}

function replaceFileAtomic(source, destination) {
  const staging = `${destination}.source-${process.pid}`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, staging);
  try {
    fs.renameSync(staging, destination);
  } finally {
    fs.rmSync(staging, { force: true });
  }
}

function mergeSourceAuthoritative(source, destination, recoveryRoot, relative = '') {
  const result = { copied: 0, identical: 0, replaced: 0, targetOnly: 0 };
  const sourceStat = fs.lstatSync(source);
  assertSafeEntry(source, sourceStat);

  if (!fs.existsSync(destination)) {
    if (sourceStat.isDirectory()) copyTreeSafe(source, destination);
    else {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    }
    result.copied += sourceStat.isFile() ? 1 : inventoryTree(source).files;
    return result;
  }

  const destinationStat = fs.lstatSync(destination);
  assertSafeEntry(destination, destinationStat);
  if (sourceStat.isFile()) {
    if (destinationStat.isFile() && fileDigest(source) === fileDigest(destination)) {
      result.identical += 1;
      return result;
    }
    copyForRecovery(destination, path.join(recoveryRoot, relative || path.basename(destination)));
    fs.rmSync(destination, { recursive: true, force: true });
    replaceFileAtomic(source, destination);
    result.replaced += 1;
    return result;
  }

  if (!destinationStat.isDirectory()) {
    copyForRecovery(destination, path.join(recoveryRoot, relative || path.basename(destination)));
    fs.rmSync(destination, { recursive: true, force: true });
    copyTreeSafe(source, destination);
    result.replaced += inventoryTree(source).files;
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
      childRelative
    );
    for (const key of Object.keys(result)) result[key] += child[key];
  }
  for (const entry of fs.readdirSync(destination, { withFileTypes: true })) {
    if (!sourceNames.has(entry.name)) {
      const targetOnlyPath = path.join(destination, entry.name);
      result.targetOnly += entry.isFile() ? 1 : inventoryTree(targetOnlyPath).files;
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

function backupExistingElectronData(electronDir, sourceFingerprint, dryRun) {
  const candidates = [...DATA_DIRS, SECRET_STORE_FILENAME];
  const present = candidates.filter((name) => fs.existsSync(path.join(electronDir, name)));
  const backupRoot = path.join(
    path.dirname(electronDir),
    BACKUP_DIRNAME,
    `migration-v${MIGRATION_VERSION}-${sourceFingerprint.slice(0, 16)}`
  );
  if (present.length === 0) return { path: backupRoot, items: [] };
  if (dryRun) return { path: backupRoot, items: present };
  fs.mkdirSync(backupRoot, { recursive: true });
  for (const name of present) {
    copyForRecovery(path.join(electronDir, name), path.join(backupRoot, name));
  }
  return { path: backupRoot, items: present };
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
    copyForRecovery(source, destination);
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

function estimateMigrationSpace(electronDir, inventory, userDataDir = null) {
  let existingBytes = 0;
  for (const name of [...DATA_DIRS, SECRET_STORE_FILENAME]) {
    const candidate = path.join(electronDir, name);
    if (fs.existsSync(candidate)) {
      existingBytes += inventoryTree(candidate).bytes;
    }
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
    ) + Number(inventory.secrets?.bytes || 0);
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
    };
  }

  const summary = {
    version: MIGRATION_VERSION,
    dryRun,
    sourceFingerprint: inventory.fingerprint,
    inventory: inventory.dirs,
    secrets: { migrated: [], overwritten: [], skippedExisting: [], decryptFailed: [], setFailed: [] },
    dirs: {},
    backup: { path: null, items: [] },
    sentinelWritten: false,
  };

  try {
    summary.backup = backupExistingElectronData(
      electronDir,
      inventory.fingerprint,
      dryRun
    );
  } catch (error) {
    summary.backup.error = error instanceof Error ? error.message : String(error);
    warn(`could not back up existing Electron data: ${summary.backup.error}`);
    return summary;
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
      const merged = mergeSourceAuthoritative(source, destination, recoveryRoot);
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

  const clean =
    !summary.inventoryError &&
    !summary.backup.error &&
    !summary.secrets.readError &&
    summary.secrets.setFailed.length === 0 &&
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
  SENTINEL_FILENAME,
  backupExistingElectronData,
  backupElectronChromiumState,
  estimateMigrationSpace,
  hasValidSentinel,
  inventoryTree,
  mergeSourceAuthoritative,
  resolveTauriAppDataDir,
  runTauriMigration,
  sourceInventory,
};
