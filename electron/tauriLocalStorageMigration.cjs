'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GET_CHANNEL = 'abu:tauri-local-storage:get';
const ACK_CHANNEL = 'abu:tauri-local-storage:ack';
const SENTINEL_FILENAME = 'tauri-local-storage-migration.json';
const MIGRATION_VERSION = 2;
const MAX_SCAN_ENTRIES = 20_000;
const MAX_ITEMS = 128;
const MAX_ITEM_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

const PERSISTED_STORE_KEYS = new Set([
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
]);
const EXTRA_KEYS = new Set([
  'abu_device_id',
  'abu_seen_announcements',
  'abu-pet-position',
  'wechat:ctx',
]);
const BUILTIN_PROVIDER_IDS = [
  'volcengine',
  'bailian',
  'anthropic',
  'openai',
  'deepseek',
  'moonshot',
  'zhipu',
  'minimax',
  'siliconflow',
  'qiniu',
  'xiaomi',
  'openrouter',
  'ollama',
  'lmstudio',
];

function isAllowedKey(key) {
  return (
    PERSISTED_STORE_KEYS.has(key) ||
    EXTRA_KEYS.has(key) ||
    key.startsWith('wechat:cursor:')
  );
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidValue(key, value) {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > MAX_ITEM_BYTES
  ) {
    return false;
  }
  try {
    if (PERSISTED_STORE_KEYS.has(key)) return isPlainRecord(JSON.parse(value));
    if (key === 'abu_seen_announcements' || key === 'wechat:ctx') {
      return Array.isArray(JSON.parse(value));
    }
    if (key === 'abu-pet-position') return isPlainRecord(JSON.parse(value));
    if (key === 'abu_device_id') return value.length > 0 && value.length <= 256;
    if (key.startsWith('wechat:cursor:')) return value.length <= 64 * 1024;
  } catch {
    return false;
  }
  return false;
}

function decodeWebKitValue(raw) {
  if (typeof raw === 'string') return raw;
  if (!Buffer.isBuffer(raw) && !ArrayBuffer.isView(raw)) return null;
  let value = Buffer.from(raw.buffer || raw, raw.byteOffset || 0, raw.byteLength);
  if (value.length >= 2 && value[0] === 0xff && value[1] === 0xfe) {
    value = value.subarray(2);
  }
  if (value.length % 2 !== 0) return null;
  return value.toString('utf16le');
}

function scanFor(root, predicate, maxDepth = 10) {
  if (!root || !fs.existsSync(root)) return { paths: [], incomplete: false };
  const paths = [];
  const stack = [{ dir: root, depth: 0 }];
  let visited = 0;
  let incomplete = false;
  while (stack.length > 0 && visited < MAX_SCAN_ENTRIES) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      incomplete = true;
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_SCAN_ENTRIES) break;
      const fullPath = path.join(current.dir, entry.name);
      if (predicate(fullPath, entry)) {
        try {
          paths.push({ path: fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs });
        } catch {
          incomplete = true;
        }
      } else if (entry.isDirectory()) {
        if (current.depth < maxDepth) {
          stack.push({ dir: fullPath, depth: current.depth + 1 });
        } else {
          incomplete = true;
        }
      }
    }
  }
  if (stack.length > 0 || visited >= MAX_SCAN_ENTRIES) incomplete = true;
  return {
    paths: paths.sort((a, b) => b.mtimeMs - a.mtimeMs).map((item) => item.path),
    incomplete,
  };
}

function resolveTauriStorageRoot(platform = process.platform, env = process.env) {
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'WebKit', 'com.abu.app');
  }
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || '', 'com.abu.app');
  }
  return null;
}

function findStorageDatabases(root, platform = process.platform) {
  if (platform === 'darwin') {
    return scanFor(
      root,
      (_fullPath, entry) => entry.isFile() && entry.name === 'localstorage.sqlite3'
    );
  }
  if (platform === 'win32') {
    return scanFor(
      root,
      (fullPath, entry) =>
        entry.isDirectory() &&
        entry.name.toLowerCase() === 'leveldb' &&
        path.basename(path.dirname(fullPath)).toLowerCase() === 'local storage' &&
        fs.existsSync(path.join(fullPath, 'CURRENT'))
    );
  }
  return { paths: [], incomplete: false };
}

function readWebKitRows(databasePath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db.prepare('SELECT key, value FROM ItemTable').all();
  } finally {
    db.close();
  }
}

function runReader(readerPath, request) {
  if (!readerPath || !fs.existsSync(readerPath)) {
    throw new Error('tauri-transition-reader is missing');
  }
  const result = spawnSync(readerPath, [], {
    encoding: 'utf8',
    input: JSON.stringify(request),
    maxBuffer: 70 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || 'transition reader failed').trim());
  }
  return JSON.parse(result.stdout);
}

function readWebView2Rows(databasePath, readerPath) {
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-webview2-migration-'));
  const stagedDatabase = path.join(stagingRoot, 'leveldb');
  try {
    // Never open the live WebView2 database. Opening LevelDB may create locks
    // and recover logs, so only the temporary copy is given to Rust.
    fs.cpSync(databasePath, stagedDatabase, { recursive: true });
    const response = runReader(readerPath, {
      operation: 'localStorage',
      database: stagedDatabase,
    });
    if (!Array.isArray(response?.items)) throw new Error('invalid reader response');
    return {
      rows: response.items,
      rejectedCount: Number(response.rejectedCount || 0),
    };
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function collectValidatedItems(rows, decodeValue = (value) => value) {
  const items = new Map();
  const rejectedKeys = [];
  let allowedCount = 0;
  let totalBytes = 0;
  for (const row of rows) {
    if (typeof row?.key !== 'string' || !isAllowedKey(row.key)) continue;
    allowedCount += 1;
    const value = decodeValue(row.value);
    const bytes = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
    if (
      value == null ||
      !isValidValue(row.key, value) ||
      items.size >= MAX_ITEMS ||
      totalBytes + bytes > MAX_TOTAL_BYTES
    ) {
      rejectedKeys.push(row.key);
      continue;
    }
    const previous = items.get(row.key);
    if (previous != null) totalBytes -= Buffer.byteLength(previous, 'utf8');
    items.set(row.key, value);
    totalBytes += bytes;
  }
  return {
    items: [...items].map(([key, value]) => ({ key, value })),
    rejectedKeys: [...new Set(rejectedKeys)],
    allowedCount,
  };
}

function collectKnownSecretKeys(items) {
  const keys = new Set([
    'aux:webSearch',
    'aux:imageGen',
    ...BUILTIN_PROVIDER_IDS.map((id) => `provider:${id}`),
  ]);
  const settings = items.find((item) => item.key === 'abu-settings');
  try {
    const state = JSON.parse(settings?.value || '{}')?.state;
    for (const provider of Array.isArray(state?.providers) ? state.providers : []) {
      if (typeof provider?.id === 'string' && provider.id.length <= 256) {
        keys.add(`provider:${provider.id}`);
      }
    }
    for (const backend of Array.isArray(state?.imageGeneration?.backends)
      ? state.imageGeneration.backends
      : []) {
      if (typeof backend?.id === 'string' && backend.id.length <= 256) {
        keys.add(`imagegen:${backend.id}`);
      }
    }
  } catch {
    // The value validator already records malformed settings as rejected.
  }
  return [...keys];
}

function hasLegacySourceEvidence(plan, fileMigrationResult) {
  // Windows Credential Manager outlives AppData. Do not let an unreadable
  // orphaned credential keep a clean reinstall in the transition retry loop.
  if (typeof plan?.sourceDatabase === 'string' && plan.sourceDatabase.length > 0) {
    return true;
  }
  // A trusted v2 completion record is upgraded by migrating Notice data only.
  // That result deliberately carries a partial inventory, so it cannot prove
  // that the earlier Windows credential migration completed.
  if (fileMigrationResult?.noticeOnlyUpgrade === true) {
    return true;
  }
  const inventory = fileMigrationResult?.inventory;
  if (inventory && typeof inventory === 'object' && !Array.isArray(inventory)) {
    return Object.values(inventory).some(
      (entry) => entry && typeof entry === 'object' && Number(entry.files || 0) > 0
    );
  }
  // Older completion records may not carry the source inventory. Preserve the
  // fail-closed retry in that unknown state; current records distinguish an
  // empty reset from a source that still contains migratable files.
  return fileMigrationResult?.skipped === 'already-migrated';
}

function writeSentinel(electronDir, record) {
  fs.mkdirSync(electronDir, { recursive: true });
  const sentinelPath = path.join(electronDir, SENTINEL_FILENAME);
  const staging = `${sentinelPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(staging, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(staging, sentinelPath);
  } finally {
    fs.rmSync(staging, { force: true });
  }
}

function hasValidSentinel(electronDir, sourceFingerprint) {
  try {
    const record = JSON.parse(
      fs.readFileSync(path.join(electronDir, SENTINEL_FILENAME), 'utf8')
    );
    return (
      record?.version === MIGRATION_VERSION &&
      record?.status === 'complete' &&
      typeof record?.migratedAt === 'string' &&
      Array.isArray(record?.imported) &&
      Array.isArray(record?.skippedExisting) &&
      typeof record?.sourceFingerprint === 'string' &&
      (sourceFingerprint === undefined || record.sourceFingerprint === sourceFingerprint)
    );
  } catch {
    return false;
  }
}

function storageStateFingerprint(paths, platform = process.platform) {
  const hash = crypto.createHash('sha256');
  let visited = 0;
  function add(candidate, root) {
    if (!fs.existsSync(candidate) || visited >= MAX_SCAN_ENTRIES) return;
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      throw new Error(`symbolic link in legacy localStorage path: ${candidate}`);
    }
    const relative = path.relative(root, candidate) || path.basename(candidate);
    hash.update(`${relative}\0${stat.size}\0${Math.trunc(stat.mtimeMs)}\n`);
    visited += 1;
    if (!stat.isDirectory()) return;
    for (const entry of fs.readdirSync(candidate).sort()) {
      add(path.join(candidate, entry), root);
    }
  }
  for (const candidate of [...paths].sort()) {
    if (platform === 'darwin') {
      add(candidate, path.dirname(candidate));
      add(`${candidate}-wal`, path.dirname(candidate));
      add(`${candidate}-shm`, path.dirname(candidate));
    } else {
      add(candidate, candidate);
    }
  }
  return hash.digest('hex');
}

function prepareTauriLocalStorageMigration(options) {
  const {
    electronDir,
    platform = process.platform,
    storageRoot = resolveTauriStorageRoot(platform),
    readerPath,
    dryRun = false,
    conflictPolicy = 'source-wins',
  } = options;
  if (platform !== 'darwin' && platform !== 'win32') {
    return { status: 'unsupported', reason: `unsupported-platform:${platform}` };
  }
  const scan = findStorageDatabases(storageRoot, platform);
  if (scan.incomplete) return { status: 'error', reason: 'storage-scan-incomplete' };
  const sourceFingerprint = storageStateFingerprint(scan.paths, platform);
  // A `complete` sentinel at the current MIGRATION_VERSION permanently ends
  // the migration — fingerprint drift must NOT re-arm it. The fingerprint
  // hashes file metadata (size/mtime) of live databases, and merely READING
  // those databases mutates their sidecar files (SQLite WAL `-shm` on macOS,
  // LevelDB LOCK/LOG on Windows), so requiring fingerprint equality here made
  // every completed migration invalid again by the next launch and re-imported
  // the stale Tauri snapshot with `source-wins` on every boot, wiping current
  // renderer stores. The fingerprint is still recorded for diagnostics; a
  // post-completion source change is reported via `sourceChangedSinceMigration`
  // for the host to log, never silently re-applied.
  if (hasValidSentinel(electronDir)) {
    return {
      status: 'skipped',
      reason: 'already-migrated',
      sourceFingerprint,
      sourceChangedSinceMigration: !hasValidSentinel(electronDir, sourceFingerprint),
    };
  }

  let selected = { items: [], rejectedKeys: [], allowedCount: 0 };
  let selectedPath = null;
  let lastError = null;
  for (const candidate of scan.paths) {
    try {
      const read = platform === 'darwin'
        ? { rows: readWebKitRows(candidate), rejectedCount: 0 }
        : readWebView2Rows(candidate, readerPath);
      const collected = collectValidatedItems(
        read.rows,
        platform === 'darwin' ? decodeWebKitValue : (value) => value
      );
      if (read.rejectedCount > 0) collected.rejectedKeys.push('__decode-failure__');
      if (
        !selectedPath ||
        collected.items.length > selected.items.length ||
        (collected.items.length === selected.items.length &&
          collected.allowedCount > selected.allowedCount)
      ) {
        selected = collected;
        selectedPath = candidate;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  if (scan.paths.length > 0 && !selectedPath) {
    return { status: 'error', reason: lastError || 'could-not-read-localstorage' };
  }
  return {
    status: dryRun ? 'dry-run' : 'pending',
    items: selected.items,
    expectedKeys: selected.items.map((item) => item.key),
    rejectedKeys: [...new Set(selected.rejectedKeys)],
    sourceDatabase: selectedPath ? path.relative(storageRoot, selectedPath) : null,
    sourceFingerprint,
    electronDir,
    platform,
    dryRun,
    conflictPolicy,
    backupPath: null,
    secretMigrationFailed: false,
  };
}

function migrateWindowsSecrets(plan, options) {
  if (!plan || plan.platform !== 'win32' || !['pending', 'dry-run'].includes(plan.status)) {
    return { migrated: [], overwritten: [], skippedExisting: [], missing: [], failed: [] };
  }
  if (options.hasLegacySource === false) {
    return {
      migrated: [],
      overwritten: [],
      skippedExisting: [],
      missing: [],
      failed: [],
      skippedReason: 'no-legacy-source-evidence',
    };
  }
  const keys = collectKnownSecretKeys(plan.items);
  let response;
  try {
    const reader = options.runReader || runReader;
    response = reader(options.readerPath, { operation: 'windowsSecrets', keys });
  } catch {
    plan.secretMigrationFailed = true;
    return { migrated: [], overwritten: [], skippedExisting: [], missing: [], failed: ['reader'] };
  }
  const summary = {
    migrated: [],
    overwritten: [],
    skippedExisting: [],
    missing: Array.isArray(response?.missing) ? response.missing : [],
    failed: Array.isArray(response?.failed) ? response.failed : [],
  };
  if (!Array.isArray(response?.entries)) summary.failed.push('invalid-response');
  for (const entry of Array.isArray(response?.entries) ? response.entries : []) {
    if (
      typeof entry?.key !== 'string' ||
      typeof entry?.value !== 'string' ||
      !keys.includes(entry.key)
    ) {
      summary.failed.push('invalid-entry');
      continue;
    }
    const existed = options.secretHas(entry.key);
    if (existed && options.sourceWins !== true) {
      summary.skippedExisting.push(entry.key);
    } else {
      if (!plan.dryRun) {
        try {
          options.secretSet(entry.key, entry.value);
        } catch {
          summary.failed.push(entry.key);
          continue;
        }
      }
      (existed ? summary.overwritten : summary.migrated).push(entry.key);
    }
  }
  plan.secretMigrationFailed = summary.failed.length > 0;
  return summary;
}

function stringArray(value) {
  return Array.isArray(value) &&
    value.length <= MAX_ITEMS &&
    value.every((item) => typeof item === 'string')
    ? value
    : null;
}

function finalizeTauriLocalStorageMigration(plan, acknowledgement) {
  if (!plan || plan.status !== 'pending') {
    return { ok: false, retry: false, reason: 'no-pending-migration' };
  }
  const imported = stringArray(acknowledgement?.imported);
  const overwritten = stringArray(acknowledgement?.overwritten);
  const skippedExisting = stringArray(acknowledgement?.skippedExisting);
  const failed = stringArray(acknowledgement?.failed);
  if (!imported || !overwritten || !skippedExisting || !failed) {
    return { ok: false, retry: true, reason: 'invalid-acknowledgement' };
  }
  const expected = new Set(plan.expectedKeys);
  const accounted = new Set([...imported, ...overwritten, ...skippedExisting, ...failed]);
  const invalid =
    accounted.size !== expected.size ||
    [...accounted].some((key) => !expected.has(key)) ||
    imported.length + overwritten.length + skippedExisting.length + failed.length !== accounted.size;
  if (invalid || failed.length > 0 || plan.secretMigrationFailed) {
    return {
      ok: false,
      retry: true,
      reason: plan.secretMigrationFailed
        ? 'secret-migration-failed'
        : invalid
          ? 'incomplete-acknowledgement'
          : 'renderer-write-failed',
    };
  }
  if (plan.rejectedKeys.length > 0) {
    return { ok: false, retry: true, reason: 'source-values-rejected' };
  }
  const previous = Array.isArray(acknowledgement?.previous)
    ? acknowledgement.previous
    : [];
  if (
    previous.length > MAX_ITEMS ||
    previous.some(
      (entry) =>
        !entry ||
        typeof entry.key !== 'string' ||
        typeof entry.value !== 'string' ||
        !overwritten.includes(entry.key) ||
        !isAllowedKey(entry.key) ||
        Buffer.byteLength(entry.value, 'utf8') > MAX_ITEM_BYTES
    ) ||
    previous.reduce((total, entry) => total + Buffer.byteLength(entry.value, 'utf8'), 0) >
      MAX_TOTAL_BYTES
  ) {
    return { ok: false, retry: true, reason: 'invalid-local-storage-backup' };
  }
  if (previous.length > 0 && typeof plan.backupPath === 'string' && plan.backupPath) {
    fs.mkdirSync(plan.backupPath, { recursive: true });
    const backupFile = path.join(plan.backupPath, 'electron-local-storage.json');
    const staging = `${backupFile}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(
        staging,
        JSON.stringify({ version: 1, backedUpAt: new Date().toISOString(), items: previous }, null, 2),
        'utf8'
      );
      fs.renameSync(staging, backupFile);
    } finally {
      fs.rmSync(staging, { force: true });
    }
  }
  writeSentinel(plan.electronDir, {
    version: MIGRATION_VERSION,
    migratedAt: new Date().toISOString(),
    status: 'complete',
    sourceDatabase: plan.sourceDatabase,
    sourceFingerprint: plan.sourceFingerprint,
    imported,
    overwritten,
    skippedExisting,
  });
  plan.status = 'complete';
  return { ok: true, retry: false };
}

module.exports = {
  GET_CHANNEL,
  ACK_CHANNEL,
  SENTINEL_FILENAME,
  MIGRATION_VERSION,
  isAllowedKey,
  isValidValue,
  decodeWebKitValue,
  resolveTauriStorageRoot,
  findStorageDatabases,
  storageStateFingerprint,
  collectValidatedItems,
  collectKnownSecretKeys,
  hasLegacySourceEvidence,
  hasValidSentinel,
  prepareTauriLocalStorageMigration,
  migrateWindowsSecrets,
  finalizeTauriLocalStorageMigration,
};
