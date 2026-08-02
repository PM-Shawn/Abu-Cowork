// @vitest-environment node

/**
 * Unit tests for the one-time Tauri→Electron migration orchestrator.
 * Everything host-specific is injected (fake secret store callbacks, a fixed
 * machine key), so these run in plain Node with temp dirs — no Electron, no
 * ioreg. The safeStorage end of the pipeline is covered by the
 * electron/spike/migrationVerify.cjs harness instead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { writeTauriSecretsFile, encryptTauriEntries } from './tauriSecretsReader.cjs';
import {
  BACKUP_DIRNAME,
  MIGRATION_VERSION,
  NOTICE_DB_FILENAME,
  resolveTauriAppDataDir,
  runTauriMigration,
  estimateMigrationSpace,
  backupElectronChromiumState,
  SENTINEL_FILENAME,
  hasValidSentinel,
  inspectLegacyElectronSymlinkRepairs,
  sourceInventory,
  sourceInventoryV2,
} from './tauriMigration.cjs';
import { listFiles } from './spike/listFilesRecursive.cjs';

const FIXED_KEY = Buffer.alloc(32, 7);
const quietLog = { log: () => {}, warn: () => {} };

let root: string;
let tauriDir: string;
let electronDir: string;

/** In-memory stand-in for secretStore.cjs. */
function fakeSecretStore(preExisting: Record<string, string> = {}) {
  const stored = new Map(Object.entries(preExisting));
  return {
    stored,
    secretSet: vi.fn((key: string, value: string) => {
      stored.set(key, value);
    }),
    secretHas: vi.fn((key: string) => stored.has(key)),
  };
}

function runWith(store: ReturnType<typeof fakeSecretStore>, extra: Record<string, unknown> = {}) {
  return runTauriMigration({
    tauriDir,
    electronDir,
    secretSet: store.secretSet,
    secretHas: store.secretHas,
    machineKey: FIXED_KEY,
    log: quietLog,
    ...extra,
  });
}

function seedTauriDir() {
  fs.mkdirSync(path.join(tauriDir, 'conversations', 'conv1'), { recursive: true });
  fs.writeFileSync(path.join(tauriDir, 'conversations', 'index.json'), '{"version":1}');
  fs.writeFileSync(path.join(tauriDir, 'conversations', 'conv1', 'messages.jsonl'), '{"role":"user"}\n');
  fs.mkdirSync(path.join(tauriDir, 'sessions', 'conv1', 'results'), { recursive: true });
  fs.writeFileSync(path.join(tauriDir, 'sessions', 'conv1', 'results', 'tc1.txt'), 'result');
  fs.mkdirSync(path.join(tauriDir, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(tauriDir, 'backups', 'b1.json'), '{}');
  // Present at the source but deliberately NOT part of the migration set:
  fs.writeFileSync(path.join(tauriDir, 'catalog.sqlite'), 'sqlite');
  fs.mkdirSync(path.join(tauriDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(tauriDir, 'logs', 'app.log'), 'log');
  writeTauriSecretsFile(path.join(tauriDir, 'secrets.bin'), FIXED_KEY, {
    'provider:claude': 'sk-ant-123',
    'aux:webSearch': 'tvly-456',
  });
}

function seedNoticeDatabase(dir: string, label: string) {
  const databasePath = path.join(dir, NOTICE_DB_FILENAME);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE notice_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      notice_id TEXT NOT NULL, type TEXT NOT NULL, tier TEXT NOT NULL,
      source TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT,
      delivered_to TEXT NOT NULL DEFAULT '[]', timestamp INTEGER NOT NULL
    );
    CREATE TABLE notice_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      notice_id TEXT UNIQUE NOT NULL, notice_json TEXT NOT NULL, tier TEXT NOT NULL,
      queued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_audit_timestamp ON notice_audit(timestamp);
    CREATE INDEX idx_audit_type ON notice_audit(type, timestamp);
    CREATE INDEX idx_inbox_expires ON notice_inbox(expires_at);
  `);
  db.prepare(
    `INSERT INTO notice_audit (notice_id, type, tier, source, decision, reason, delivered_to, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`${label}-audit`, 'task_complete', 'L2', 'fixture', 'queue_inbox', label, '[]', 1000);
  db.prepare(
    `INSERT INTO notice_inbox (notice_id, notice_json, tier, queued_at, expires_at, delivered)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`${label}-inbox`, JSON.stringify({ label }), 'L2', 1000, 9999999999999, 0);
  return { db, databasePath };
}

function readNoticeRows(databasePath: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      audit: db.prepare('SELECT notice_id FROM notice_audit ORDER BY id').all(),
      inbox: db.prepare('SELECT notice_id, delivered FROM notice_inbox ORDER BY id').all(),
      integrity: db.prepare('PRAGMA integrity_check').all(),
    };
  } finally {
    db.close();
  }
}

function readNoticeMergeState(databasePath: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      audit: db.prepare('SELECT notice_id, type, tier, source, decision, reason, delivered_to, timestamp FROM notice_audit ORDER BY id').all(),
      inbox: db.prepare('SELECT notice_id, notice_json, tier, queued_at, expires_at, delivered FROM notice_inbox ORDER BY notice_id').all(),
    };
  } finally {
    db.close();
  }
}

function writeCompleteV2Sentinel(legacyFingerprint: string, overrides: Record<string, unknown> = {}) {
  fs.mkdirSync(electronDir, { recursive: true });
  fs.writeFileSync(
    path.join(electronDir, SENTINEL_FILENAME),
    JSON.stringify({
      version: 2,
      status: 'complete',
      migratedAt: '2026-08-01T00:00:00.000Z',
      sourceFingerprint: legacyFingerprint,
      summary: {
        sentinelWritten: true,
        dirs: Object.fromEntries(
          ['conversations', 'sessions', 'backups'].map((name) => [name, { status: 'copied' }]),
        ),
        secrets: { setFailed: [] },
      },
      ...overrides,
    }),
  );
}

// The secrets branch is darwin-gated on the REAL process.platform (secrets.bin
// only exists on macOS Tauri installs). Pin the platform to darwin so the
// suite behaves identically on Windows dev machines (repo convention §13);
// the dedicated non-darwin test overrides it to win32 itself.
let platformDesc: PropertyDescriptor;
beforeEach(() => {
  platformDesc = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tauri-migration-test-'));
  tauriDir = path.join(root, 'com.abu.app');
  electronDir = path.join(root, 'com.abu.app.electron');
  fs.mkdirSync(tauriDir, { recursive: true });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platformDesc);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveTauriAppDataDir', () => {
  it('maps packaged → com.abu.app and dev → com.abu.app.dev', () => {
    expect(resolveTauriAppDataDir('/appdata', true)).toBe(path.join('/appdata', 'com.abu.app'));
    expect(resolveTauriAppDataDir('/appdata', false)).toBe(path.join('/appdata', 'com.abu.app.dev'));
  });
});

describe('runTauriMigration', () => {
  it('accounts for source copy, Electron backup, and safety headroom before migration', () => {
    seedTauriDir();
    fs.mkdirSync(path.join(electronDir, 'conversations'), { recursive: true });
    fs.writeFileSync(
      path.join(electronDir, 'conversations', 'electron-only.jsonl'),
      'electron-only',
    );
    const chromiumDir = path.join(root, 'Abu');
    fs.mkdirSync(path.join(chromiumDir, 'Local Storage', 'leveldb'), { recursive: true });
    fs.writeFileSync(
      path.join(chromiumDir, 'Local Storage', 'leveldb', '000003.log'),
      'legacy-local-storage',
    );
    const estimate = estimateMigrationSpace(
      electronDir,
      sourceInventory(tauriDir),
      chromiumDir,
    );
    expect(estimate.sourceBytes).toBeGreaterThan(0);
    expect(estimate.existingBytes).toBeGreaterThan(0);
    expect(estimate.requiredBytes).toBeGreaterThan(
      estimate.sourceBytes + estimate.existingBytes,
    );
    expect(typeof estimate.enough).toBe('boolean');
  });

  it('backs up persistent Electron browser state but excludes disposable caches', () => {
    const chromiumDir = path.join(root, 'Abu');
    fs.mkdirSync(path.join(chromiumDir, 'Local Storage', 'leveldb'), { recursive: true });
    fs.writeFileSync(
      path.join(chromiumDir, 'Local Storage', 'leveldb', '000003.log'),
      'electron-local-storage',
    );
    fs.mkdirSync(path.join(chromiumDir, 'Cache'), { recursive: true });
    fs.writeFileSync(path.join(chromiumDir, 'Cache', 'cache.bin'), 'disposable');
    const backupRoot = path.join(root, 'migration-backup');

    const result = backupElectronChromiumState(chromiumDir, backupRoot);

    expect(result.copied).toContain('Local Storage');
    expect(
      fs.readFileSync(
        path.join(
          backupRoot,
          'chromium-user-data',
          'Local Storage',
          'leveldb',
          '000003.log',
        ),
        'utf8',
      ),
    ).toBe('electron-local-storage');
    expect(fs.existsSync(path.join(backupRoot, 'chromium-user-data', 'Cache'))).toBe(false);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(backupRoot, 'chromium-user-data', 'backup-manifest.json'),
          'utf8',
        ),
      ).copied,
    ).toContain('Local Storage');
  });

  it('migrates secrets and copies the data dirs on a fresh run', () => {
    seedTauriDir();
    const store = fakeSecretStore();
    const summary = runWith(store);

    expect('skipped' in summary).toBe(false);
    if ('skipped' in summary) return;
    expect(summary.secrets.migrated.sort()).toEqual(['aux:webSearch', 'provider:claude']);
    expect(store.stored.get('provider:claude')).toBe('sk-ant-123');
    expect(store.stored.get('aux:webSearch')).toBe('tvly-456');
    expect(summary.dirs.conversations).toMatchObject({ status: 'copied', copied: 2 });
    expect(summary.dirs.sessions).toMatchObject({ status: 'copied', copied: 1 });
    expect(summary.dirs.backups).toMatchObject({ status: 'copied', copied: 1 });

    // Copied file-by-file, and only the whitelisted dirs.
    expect(listFiles(path.join(electronDir, 'conversations'))).toEqual([
      path.join('conv1', 'messages.jsonl'),
      'index.json',
    ]);
    expect(listFiles(path.join(electronDir, 'sessions'))).toEqual([
      path.join('conv1', 'results', 'tc1.txt'),
    ]);
    expect(fs.existsSync(path.join(electronDir, 'catalog.sqlite'))).toBe(false);
    expect(fs.existsSync(path.join(electronDir, 'logs'))).toBe(false);
    expect(fs.existsSync(path.join(electronDir, 'secrets.bin'))).toBe(false);

    // Sentinel written; Tauri source untouched.
    expect(summary.sentinelWritten).toBe(true);
    expect(fs.existsSync(path.join(electronDir, SENTINEL_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(tauriDir, 'secrets.bin'))).toBe(true);
  });

  it('snapshots a real WAL Notice SQLite database with audit and pending inbox rows', () => {
    seedTauriDir();
    const source = seedNoticeDatabase(tauriDir, 'tauri');
    // Keep a read transaction only to retain the just-written WAL after the
    // fixture writer closes.  The migration itself has no legacy writer, the
    // same precondition as the packaged upgrade path.
    const reader = new DatabaseSync(source.databasePath, { readOnly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) AS count FROM notice_audit').get();
    source.db.close();
    expect(fs.existsSync(`${source.databasePath}-wal`)).toBe(true);

    const summary = runWith(fakeSecretStore());
    reader.exec('COMMIT');
    reader.close();
    if ('skipped' in summary) throw new Error('unexpected skip');

    expect(summary.inventory.notice).toMatchObject({ exists: true });
    expect(summary.notice).toMatchObject({
      status: 'copied-consistent-snapshot',
      copied: 1,
      snapshot: true,
    });
    const destination = path.join(electronDir, NOTICE_DB_FILENAME);
    expect(fs.existsSync(destination)).toBe(true);
    expect(fs.existsSync(`${destination}-wal`)).toBe(false);
    expect(readNoticeRows(destination)).toEqual({
      audit: [{ notice_id: 'tauri-audit' }],
      inbox: [{ notice_id: 'tauri-inbox', delivered: 0 }],
      integrity: [{ integrity_check: 'ok' }],
    });

    // The v3 marker was written only after the SQLite snapshot and final
    // source fingerprint check both succeeded.
    expect(summary.sentinelWritten).toBe(true);
  });

  it('backs up an existing Electron Notice database before source-authoritative replacement', () => {
    seedTauriDir();
    const source = seedNoticeDatabase(tauriDir, 'tauri');
    const electron = seedNoticeDatabase(electronDir, 'electron');
    source.db.close();
    electron.db.close();

    const summary = runWith(fakeSecretStore());
    if ('skipped' in summary) throw new Error('unexpected skip');

    expect(summary.notice).toMatchObject({
      status: 'replaced-source-authoritative',
      replaced: 1,
      snapshot: true,
    });
    expect(summary.backup.items).toContain(NOTICE_DB_FILENAME);
    expect(readNoticeRows(path.join(electronDir, NOTICE_DB_FILENAME)).audit).toEqual([
      { notice_id: 'tauri-audit' },
    ]);
    expect(readNoticeRows(path.join(summary.backup.path!, NOTICE_DB_FILENAME)).audit).toEqual([
      { notice_id: 'electron-audit' },
    ]);
    expect(readNoticeRows(path.join(summary.backup.path!, NOTICE_DB_FILENAME)).inbox).toEqual([
      { notice_id: 'electron-inbox', delivered: 0 },
    ]);
  });

  it('does not replay a closed real Notice SQLite fixture after a completed v3 migration', () => {
    seedTauriDir();
    const source = seedNoticeDatabase(tauriDir, 'closed');
    source.db.close();

    const first = runWith(fakeSecretStore());
    if ('skipped' in first) throw new Error('unexpected first-run skip');
    expect(first.sentinelWritten).toBe(true);
    expect(runWith(fakeSecretStore())).toMatchObject({ skipped: 'already-migrated' });
    expect(readNoticeRows(path.join(electronDir, NOTICE_DB_FILENAME)).audit).toEqual([
      { notice_id: 'closed-audit' },
    ]);
  });

  it('fails closed on an invalid Notice SQLite source and retries after it is repaired', () => {
    seedTauriDir();
    fs.writeFileSync(path.join(tauriDir, NOTICE_DB_FILENAME), 'not a sqlite database');

    const first = runWith(fakeSecretStore());
    if ('skipped' in first) throw new Error('invalid source must not skip migration');
    expect(first.notice).toMatchObject({ status: 'error' });
    expect(first.notice.error).toMatch(/consistent Notice SQLite snapshot|file is not a database/);
    expect(first.sentinelWritten).toBe(false);
    expect(fs.existsSync(path.join(electronDir, SENTINEL_FILENAME))).toBe(false);

    fs.rmSync(path.join(tauriDir, NOTICE_DB_FILENAME));
    const source = seedNoticeDatabase(tauriDir, 'repaired');
    source.db.close();
    const retry = runWith(fakeSecretStore());
    if ('skipped' in retry) throw new Error('repaired source must retry');
    expect(retry.notice).toMatchObject({ status: 'copied-consistent-snapshot' });
    expect(retry.sentinelWritten).toBe(true);
    expect(readNoticeRows(path.join(electronDir, NOTICE_DB_FILENAME)).inbox).toEqual([
      { notice_id: 'repaired-inbox', delivered: 0 },
    ]);
  });

  it('upgrades a trusted v2 marker by migrating only Notice data and preserves Electron RC data', () => {
    seedTauriDir();
    const legacyFingerprint = sourceInventoryV2(tauriDir).fingerprint;
    const sourceNotice = seedNoticeDatabase(tauriDir, 'v2-tauri');
    sourceNotice.db.close();
    fs.mkdirSync(path.join(electronDir, 'conversations', 'conv1'), { recursive: true });
    fs.writeFileSync(
      path.join(electronDir, 'conversations', 'conv1', 'messages.jsonl'),
      '{"role":"assistant","content":"new-electron-rc-data"}\n',
    );
    fs.writeFileSync(path.join(electronDir, 'conversations', 'index.json'), '{"version":1}');
    writeCompleteV2Sentinel(legacyFingerprint);
    const store = fakeSecretStore({ 'provider:claude': 'new-electron-rc-secret' });

    const summary = runWith(store, { sourceWins: true });
    if ('skipped' in summary) throw new Error('v2 marker needs a Notice-only upgrade');

    expect(summary).toMatchObject({
      upgradedFromVersion: 2,
      noticeOnlyUpgrade: true,
      sentinelWritten: true,
      dirs: { conversations: { status: 'preserved-from-v2' } },
      secrets: { skippedReason: 'preserved-from-v2' },
      notice: { status: 'copied-consistent-snapshot' },
    });
    expect(
      fs.readFileSync(path.join(electronDir, 'conversations', 'conv1', 'messages.jsonl'), 'utf8'),
    ).toContain('new-electron-rc-data');
    expect(store.stored.get('provider:claude')).toBe('new-electron-rc-secret');
    expect(readNoticeRows(path.join(electronDir, NOTICE_DB_FILENAME)).inbox).toEqual([
      { notice_id: 'v2-tauri-inbox', delivered: 0 },
    ]);
    expect(
      hasValidSentinel(path.join(electronDir, SENTINEL_FILENAME), sourceInventory(tauriDir).fingerprint),
    ).toBe(true);
    expect(runWith(store, { sourceWins: true })).toMatchObject({ skipped: 'already-migrated' });
  });

  it('merges trusted-v2 Notice data into the Electron baseline without replacing newer audit or inbox state', () => {
    seedTauriDir();
    const legacyFingerprint = sourceInventoryV2(tauriDir).fingerprint;
    const source = seedNoticeDatabase(tauriDir, 'tauri');
    const electron = seedNoticeDatabase(electronDir, 'electron');
    const insertAudit = (db: DatabaseSync) => db.prepare(
      `INSERT INTO notice_audit (notice_id, type, tier, source, decision, reason, delivered_to, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('shared-audit', 'task_complete', 'L2', 'fixture', 'queue_inbox', 'same-business-event', '[]', 2000);
    insertAudit(source.db);
    insertAudit(electron.db);
    source.db.prepare(
      `INSERT INTO notice_inbox (notice_id, notice_json, tier, queued_at, expires_at, delivered)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('shared-inbox', '{"origin":"tauri"}', 'L2', 2000, 3000, 0);
    electron.db.prepare(
      `INSERT INTO notice_inbox (notice_id, notice_json, tier, queued_at, expires_at, delivered)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('shared-inbox', '{"origin":"electron","updated":true}', 'L2', 2100, 4000, 1);
    source.db.close();
    electron.db.close();
    writeCompleteV2Sentinel(legacyFingerprint);

    const summary = runWith(fakeSecretStore());
    if ('skipped' in summary) throw new Error('trusted v2 marker needs a Notice merge');
    expect(summary.notice).toMatchObject({
      status: 'merged-into-electron-baseline',
      auditImported: 1,
      auditDuplicates: 1,
      inboxImported: 1,
      inboxPreserved: 1,
    });
    const state = readNoticeMergeState(path.join(electronDir, NOTICE_DB_FILENAME));
    expect(state.audit.map((row) => row.notice_id)).toEqual([
      'electron-audit',
      'shared-audit',
      'tauri-audit',
    ]);
    expect(state.inbox).toContainEqual({
      notice_id: 'shared-inbox',
      notice_json: '{"origin":"electron","updated":true}',
      tier: 'L2',
      queued_at: 2100,
      expires_at: 4000,
      delivered: 1,
    });
    expect(state.inbox.map((row) => row.notice_id)).toEqual([
      'electron-inbox',
      'shared-inbox',
      'tauri-inbox',
    ]);
  });

  it('retries a trusted v2 Notice-only upgrade without replaying files or secrets', () => {
    seedTauriDir();
    const legacyFingerprint = sourceInventoryV2(tauriDir).fingerprint;
    fs.mkdirSync(path.join(electronDir, 'conversations', 'conv1'), { recursive: true });
    fs.writeFileSync(
      path.join(electronDir, 'conversations', 'conv1', 'messages.jsonl'),
      'electron-rc-preserved',
    );
    writeCompleteV2Sentinel(legacyFingerprint);
    fs.writeFileSync(path.join(tauriDir, NOTICE_DB_FILENAME), 'invalid sqlite');
    const store = fakeSecretStore({ 'provider:claude': 'electron-rc-secret' });

    const failed = runWith(store, { sourceWins: true });
    if ('skipped' in failed) throw new Error('invalid Notice database must retry');
    expect(failed).toMatchObject({ noticeOnlyUpgrade: true, sentinelWritten: false });
    expect(failed.notice).toMatchObject({ status: 'error' });
    expect(store.stored.get('provider:claude')).toBe('electron-rc-secret');
    expect(
      fs.readFileSync(path.join(electronDir, 'conversations', 'conv1', 'messages.jsonl'), 'utf8'),
    ).toBe('electron-rc-preserved');

    fs.rmSync(path.join(tauriDir, NOTICE_DB_FILENAME));
    const repaired = seedNoticeDatabase(tauriDir, 'v2-repaired');
    repaired.db.close();
    const retry = runWith(store, { sourceWins: true });
    if ('skipped' in retry) throw new Error('trusted v2 marker must retry Notice-only migration');
    expect(retry).toMatchObject({ noticeOnlyUpgrade: true, sentinelWritten: true });
    expect(store.stored.get('provider:claude')).toBe('electron-rc-secret');
    expect(
      fs.readFileSync(path.join(electronDir, 'conversations', 'conv1', 'messages.jsonl'), 'utf8'),
    ).toBe('electron-rc-preserved');
  });

  it('does not shortcut an incomplete v2 marker', () => {
    seedTauriDir();
    const legacyFingerprint = sourceInventoryV2(tauriDir).fingerprint;
    const sourceNotice = seedNoticeDatabase(tauriDir, 'fallback');
    sourceNotice.db.close();
    fs.mkdirSync(path.join(electronDir, 'conversations', 'conv1'), { recursive: true });
    fs.writeFileSync(path.join(electronDir, 'conversations', 'conv1', 'messages.jsonl'), 'electron-rc');
    writeCompleteV2Sentinel(legacyFingerprint, {
      summary: { sentinelWritten: true, dirs: {}, secrets: { setFailed: [] } },
    });
    const store = fakeSecretStore({ 'provider:claude': 'electron-rc-secret' });

    const summary = runWith(store, { sourceWins: true });
    if ('skipped' in summary) throw new Error('incomplete v2 marker cannot skip migration');
    expect(summary.noticeOnlyUpgrade).not.toBe(true);
    expect(summary.dirs.conversations.status).toBe('merged-source-authoritative');
    expect(
      fs.readFileSync(path.join(electronDir, 'conversations', 'conv1', 'messages.jsonl'), 'utf8'),
    ).toContain('{"role":"user"}');
    expect(store.stored.get('provider:claude')).toBe('sk-ant-123');
  });

  it('does not shortcut a v2 marker whose legacy source fingerprint changed', () => {
    seedTauriDir();
    writeCompleteV2Sentinel('not-the-current-v2-source');
    const sourceNotice = seedNoticeDatabase(tauriDir, 'fingerprint-fallback');
    sourceNotice.db.close();
    fs.mkdirSync(path.join(electronDir, 'conversations', 'conv1'), { recursive: true });
    fs.writeFileSync(path.join(electronDir, 'conversations', 'conv1', 'messages.jsonl'), 'electron-rc');
    const store = fakeSecretStore({ 'provider:claude': 'electron-rc-secret' });

    const summary = runWith(store, { sourceWins: true });
    if ('skipped' in summary) throw new Error('stale v2 marker cannot skip migration');
    expect(summary.noticeOnlyUpgrade).not.toBe(true);
    expect(summary.dirs.conversations.status).toBe('merged-source-authoritative');
    expect(store.stored.get('provider:claude')).toBe('sk-ant-123');
  });

  it('is idempotent: the second run is a sentinel-gated no-op', () => {
    seedTauriDir();
    const store = fakeSecretStore();
    runWith(store);
    const callsAfterFirst = store.secretSet.mock.calls.length;

    const second = runWith(store);
    expect(second).toMatchObject({ skipped: 'already-migrated' });
    expect(store.secretSet.mock.calls.length).toBe(callsAfterFirst);
  });

  it('does not trust a corrupt or incomplete sentinel', () => {
    seedTauriDir();
    fs.mkdirSync(electronDir, { recursive: true });
    const sentinel = path.join(electronDir, SENTINEL_FILENAME);
    fs.writeFileSync(sentinel, '{"version":1');
    expect(hasValidSentinel(sentinel)).toBe(false);

    const store = fakeSecretStore();
    const summary = runWith(store);
    if ('skipped' in summary) throw new Error('corrupt sentinel must not skip migration');
    expect(summary.sentinelWritten).toBe(true);
    expect(hasValidSentinel(sentinel)).toBe(true);
    expect(fs.existsSync(`${sentinel}.tmp-${process.pid}`)).toBe(false);
  });

  it('backs up existing Electron data, preserves target-only files, and keeps source authoritative', () => {
    seedTauriDir();
    // Electron side already has its own conversation and one conflicting
    // index. The source index must win for shared ids while target-only files
    // remain available and the original Electron tree is recoverable.
    fs.mkdirSync(path.join(electronDir, 'conversations'), { recursive: true });
    fs.writeFileSync(path.join(electronDir, 'conversations', 'own.json'), 'electron-data');
    fs.writeFileSync(
      path.join(electronDir, 'conversations', 'index.json'),
      JSON.stringify({ version: 1, entries: { electronOnly: { id: 'electronOnly' } } }),
    );
    const store = fakeSecretStore({ 'provider:claude': 'already-set' });

    const summary = runWith(store);
    if ('skipped' in summary) throw new Error('unexpected skip');
    expect(summary.dirs.conversations).toMatchObject({
      status: 'merged-source-authoritative',
      targetOnly: 1,
    });
    expect(summary.dirs.sessions).toMatchObject({ status: 'copied' });
    expect(fs.readFileSync(path.join(electronDir, 'conversations', 'own.json'), 'utf8')).toBe('electron-data');
    expect(
      JSON.parse(fs.readFileSync(path.join(electronDir, 'conversations', 'index.json'), 'utf8')).entries
        .electronOnly.id,
    ).toBe('electronOnly');
    expect(summary.backup.path).toBeTruthy();
    expect(
      fs.readFileSync(path.join(summary.backup.path!, 'conversations', 'own.json'), 'utf8'),
    ).toBe('electron-data');

    expect(summary.secrets.skippedExisting).toEqual(['provider:claude']);
    expect(store.stored.get('provider:claude')).toBe('already-set');
    expect(summary.secrets.migrated).toEqual(['aux:webSearch']);
  });

  it('replaces a conflicting Electron file with the Tauri source on Windows', () => {
    seedTauriDir();
    const sourceFile = path.join(
      tauriDir,
      'conversations',
      'conv1',
      'messages.jsonl',
    );
    const destinationFile = path.join(
      electronDir,
      'conversations',
      'conv1',
      'messages.jsonl',
    );
    fs.mkdirSync(path.dirname(destinationFile), { recursive: true });
    fs.writeFileSync(destinationFile, '{"role":"user","content":"electron-conflict"}\n');
    const store = fakeSecretStore();
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    try {
      const summary = runWith(store, { sourceWins: true });
      if ('skipped' in summary) throw new Error('unexpected skip');
      expect(summary.dirs.conversations).toMatchObject({
        status: 'merged-source-authoritative',
        replaced: 1,
      });
      expect(fs.readFileSync(destinationFile, 'utf8')).toBe(
        fs.readFileSync(sourceFile, 'utf8'),
      );
      expect(
        fs.readFileSync(
          path.join(
            summary.backup.path!,
            'conflicts',
            'conversations',
            'conv1',
            'messages.jsonl',
          ),
          'utf8',
        ),
      ).toContain('electron-conflict');
      expect(summary.sentinelWritten).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('source-wins mode replaces an existing Electron secret after encrypted backup', () => {
    seedTauriDir();
    fs.mkdirSync(electronDir, { recursive: true });
    fs.writeFileSync(path.join(electronDir, 'secrets.enc.json'), '{"provider:claude":"ciphertext"}');
    const store = fakeSecretStore({ 'provider:claude': 'electron-test-value' });

    const summary = runWith(store, { sourceWins: true });
    if ('skipped' in summary) throw new Error('unexpected skip');
    expect(summary.secrets.overwritten).toEqual(['provider:claude']);
    expect(store.stored.get('provider:claude')).toBe('sk-ant-123');
    expect(
      fs.readFileSync(path.join(summary.backup.path!, 'secrets.enc.json'), 'utf8'),
    ).toContain('ciphertext');
  });

  it('dryRun computes the full summary with zero writes', () => {
    seedTauriDir();
    const store = fakeSecretStore();
    const summary = runWith(store, { dryRun: true });
    if ('skipped' in summary) throw new Error('unexpected skip');

    expect(summary.dryRun).toBe(true);
    expect(summary.secrets.migrated.sort()).toEqual(['aux:webSearch', 'provider:claude']);
    expect(summary.dirs.conversations).toMatchObject({ status: 'would-copy', copied: 2 });
    expect(summary.dirs.sessions).toMatchObject({ status: 'would-copy', copied: 1 });
    expect(summary.dirs.backups).toMatchObject({ status: 'would-copy', copied: 1 });
    expect(summary.sentinelWritten).toBe(false);

    expect(store.secretSet).not.toHaveBeenCalled();
    expect(fs.existsSync(electronDir)).toBe(false); // not even the dir, let alone a sentinel
  });

  it('records nothingToMigrate (and still writes the sentinel) when the Tauri dir is absent', () => {
    fs.rmSync(tauriDir, { recursive: true, force: true });
    const store = fakeSecretStore();
    const summary = runWith(store);
    if ('skipped' in summary) throw new Error('unexpected skip');

    expect(summary.nothingToMigrate).toBe(true);
    expect(summary.sentinelWritten).toBe(true);
    expect(fs.existsSync(path.join(electronDir, SENTINEL_FILENAME))).toBe(true);
    expect(store.secretSet).not.toHaveBeenCalled();
  });

  it('a secretSet failure keeps going but withholds the sentinel so the next boot retries', () => {
    seedTauriDir();
    const store = fakeSecretStore();
    store.secretSet.mockImplementation((key: string, value: string) => {
      if (key === 'provider:claude') throw new Error('safeStorage unavailable');
      store.stored.set(key, value);
    });

    const summary = runWith(store);
    if ('skipped' in summary) throw new Error('unexpected skip');
    expect(summary.secrets.setFailed).toEqual(['provider:claude']);
    expect(summary.secrets.migrated).toEqual(['aux:webSearch']);
    expect(store.stored.get('aux:webSearch')).toBe('tvly-456');

    // A store failure may be transient (e.g. safeStorage momentarily
    // unavailable) — the one-shot must NOT be burned.
    expect(summary.sentinelWritten).toBe(false);
    expect(fs.existsSync(path.join(electronDir, SENTINEL_FILENAME))).toBe(false);

    // Next boot retries: the failed key migrates, already-done work is skipped.
    store.secretSet.mockImplementation((key: string, value: string) => {
      store.stored.set(key, value);
    });
    const retry = runWith(store);
    if ('skipped' in retry) throw new Error('retry unexpectedly skipped');
    expect(retry.secrets.migrated).toEqual(['provider:claude']);
    expect(retry.secrets.skippedExisting).toEqual(['aux:webSearch']);
    expect(retry.dirs.conversations).toMatchObject({
      status: 'merged-source-authoritative',
      identical: 2,
    });
    expect(retry.sentinelWritten).toBe(true);
  });

  it('an undecryptable entry is reported, the rest migrate, and the sentinel IS written (retry cannot fix a machine change)', () => {
    seedTauriDir();
    const entries = encryptTauriEntries(FIXED_KEY, { good: 'v1', bad: 'v2' });
    const tampered = Buffer.from(entries.bad, 'base64');
    tampered[tampered.length - 1] ^= 0x01;
    entries.bad = tampered.toString('base64');
    fs.writeFileSync(path.join(tauriDir, 'secrets.bin'), JSON.stringify({ version: 1, entries }));

    const store = fakeSecretStore();
    const summary = runWith(store);
    if ('skipped' in summary) throw new Error('unexpected skip');
    expect(summary.secrets.decryptFailed).toEqual(['bad']);
    expect(summary.secrets.migrated).toEqual(['good']);
    expect(summary.sentinelWritten).toBe(true);
  });

  it('an unreadable secrets file still copies data dirs but withholds the sentinel', () => {
    seedTauriDir();
    fs.writeFileSync(path.join(tauriDir, 'secrets.bin'), JSON.stringify({ version: 99, entries: {} }));

    const store = fakeSecretStore();
    const summary = runWith(store);
    if ('skipped' in summary) throw new Error('unexpected skip');
    expect(summary.secrets.readError).toMatch(/unsupported.*version 99/);
    expect(summary.secrets.migrated).toEqual([]);
    expect(summary.dirs.conversations).toMatchObject({ status: 'copied' });
    expect(summary.sentinelWritten).toBe(false);
    expect(fs.existsSync(path.join(electronDir, SENTINEL_FILENAME))).toBe(false);
  });

  it('a dir-copy failure withholds the sentinel so the next boot retries', () => {
    seedTauriDir();
    // Make electronDir an unusable target: a FILE at that path makes mkdirSync
    // throw inside every copy branch.
    fs.writeFileSync(electronDir, 'not a dir');
    const store = fakeSecretStore();

    const summary = runWith(store);
    if ('skipped' in summary) throw new Error('unexpected skip');
    expect(summary.dirs.conversations.status).toBe('error');
    expect(summary.sentinelWritten).toBe(false);

    // Secrets still migrated (independent families) — retry skips them.
    expect(summary.secrets.migrated.length).toBe(2);
    fs.rmSync(electronDir); // unblock the target
    const retry = runWith(store);
    if ('skipped' in retry) throw new Error('retry unexpectedly skipped');
    expect(retry.dirs.conversations).toMatchObject({ status: 'copied' });
    expect(retry.secrets.skippedExisting.length).toBe(2);
    expect(retry.sentinelWritten).toBe(true);
  });

  it('cleans a leftover staging dir from a crashed run and completes the copy', () => {
    seedTauriDir();
    // Simulate a crash mid-copy from a previous run: staging exists, dest doesn't.
    const staging = path.join(electronDir, 'conversations.migrating');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'partial.jsonl'), 'truncated');

    const store = fakeSecretStore();
    const summary = runWith(store);
    if ('skipped' in summary) throw new Error('unexpected skip');
    expect(summary.dirs.conversations).toMatchObject({ status: 'copied' });
    expect(fs.existsSync(staging)).toBe(false);
    // The completed copy is the real source tree, not the stale partial one.
    expect(listFiles(path.join(electronDir, 'conversations'))).toEqual([
      path.join('conv1', 'messages.jsonl'),
      'index.json',
    ]);
  });

  it('skips secrets with a reason on non-darwin platforms but still copies dirs', () => {
    seedTauriDir();
    const store = fakeSecretStore();
    // process.platform is a plain data property — vi.spyOn(…, 'get') can't
    // intercept it, so swap the value directly and restore in finally.
    const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const summary = runWith(store);
      if ('skipped' in summary) throw new Error('unexpected skip');
      expect(summary.secrets.skippedReason).toMatch(/keyring/);
      expect(store.secretSet).not.toHaveBeenCalled();
      expect(summary.dirs.conversations).toMatchObject({ status: 'copied' });
    } finally {
      Object.defineProperty(process, 'platform', orig);
    }
  });

  it('reports skippedReason when there is no secrets.bin at the source', () => {
    seedTauriDir();
    fs.rmSync(path.join(tauriDir, 'secrets.bin'));
    const store = fakeSecretStore();
    const summary = runWith(store);
    if ('skipped' in summary) throw new Error('unexpected skip');
    expect(summary.secrets.skippedReason).toMatch(/no secrets\.bin/);
    expect(summary.dirs.conversations).toMatchObject({ status: 'copied' });
  });

  it('re-runs when the legacy source changes after a completed migration', () => {
    seedTauriDir();
    const store = fakeSecretStore();
    const first = runWith(store);
    if ('skipped' in first) throw new Error('unexpected skip');

    fs.appendFileSync(
      path.join(tauriDir, 'conversations', 'conv1', 'messages.jsonl'),
      '{"id":"late","role":"assistant"}\n',
    );
    const second = runWith(store);
    if ('skipped' in second) throw new Error('changed source must be rechecked');
    expect(second.sourceFingerprint).not.toBe(first.sourceFingerprint);
    expect(second.dirs.conversations).toMatchObject({
      status: 'merged-source-authoritative',
      replaced: 1,
    });
    expect(
      fs.readFileSync(
        path.join(electronDir, 'conversations', 'conv1', 'messages.jsonl'),
        'utf8',
      ),
    ).toContain('"id":"late"');
  });

  it('preserves safe relative npm bin symlinks whose targets stay inside session data', () => {
    seedTauriDir();
    const packageBin = path.join(
      tauriDir,
      'sessions',
      'conv1',
      'outputs',
      'node_modules',
      'image-size',
      'bin',
    );
    const binDir = path.join(
      tauriDir,
      'sessions',
      'conv1',
      'outputs',
      'node_modules',
      '.bin',
    );
    fs.mkdirSync(packageBin, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(packageBin, 'image-size.js'), '#!/usr/bin/env node\n');
    fs.symlinkSync(
      '../image-size/bin/image-size.js',
      path.join(binDir, 'image-size'),
      'file',
    );

    const summary = runWith(fakeSecretStore());
    if ('skipped' in summary) throw new Error('unexpected skip');
    const migratedLink = path.join(
      electronDir,
      'sessions',
      'conv1',
      'outputs',
      'node_modules',
      '.bin',
      'image-size',
    );
    expect(summary.sentinelWritten).toBe(true);
    expect(fs.lstatSync(migratedLink).isSymbolicLink()).toBe(true);
    expect(path.normalize(fs.readlinkSync(migratedLink))).toBe(
      path.normalize('../image-size/bin/image-size.js'),
    );
    expect(fs.readFileSync(migratedLink, 'utf8')).toContain('/usr/bin/env node');
  });

  it('repairs exact v1 absolute symlinks after rollback and re-upgrade without discarding partial backups', () => {
    seedTauriDir();
    const sourcePackageBin = path.join(
      tauriDir,
      'sessions',
      'conv1',
      'outputs',
      'node_modules',
      'image-size',
      'bin',
    );
    const sourceBinDir = path.join(
      tauriDir,
      'sessions',
      'conv1',
      'outputs',
      'node_modules',
      '.bin',
    );
    const electronPackageBin = path.join(
      electronDir,
      'sessions',
      'conv1',
      'outputs',
      'node_modules',
      'image-size',
      'bin',
    );
    const electronBinDir = path.join(
      electronDir,
      'sessions',
      'conv1',
      'outputs',
      'node_modules',
      '.bin',
    );
    const relativeTarget = '../image-size/bin/image-size.js';
    fs.mkdirSync(sourcePackageBin, { recursive: true });
    fs.mkdirSync(sourceBinDir, { recursive: true });
    fs.writeFileSync(path.join(sourcePackageBin, 'image-size.js'), '#!/usr/bin/env node\n');
    fs.symlinkSync(relativeTarget, path.join(sourceBinDir, 'image-size'), 'file');

    // Early transition builds copied the local target but rewrote the link to
    // the absolute source path. A later Tauri rollback left this v1 Electron
    // profile in place for the next v2 upgrade.
    fs.mkdirSync(electronPackageBin, { recursive: true });
    fs.mkdirSync(electronBinDir, { recursive: true });
    fs.writeFileSync(path.join(electronPackageBin, 'image-size.js'), '#!/usr/bin/env node\n');
    const legacyLink = path.join(electronBinDir, 'image-size');
    fs.symlinkSync(
      path.resolve(sourceBinDir, relativeTarget),
      legacyLink,
      'file',
    );
    fs.writeFileSync(
      path.join(electronDir, SENTINEL_FILENAME),
      JSON.stringify({ version: 1, status: 'complete' }),
    );

    const inventory = sourceInventory(tauriDir);
    const repairs = inspectLegacyElectronSymlinkRepairs(tauriDir, electronDir);
    expect(repairs).toHaveLength(1);
    expect(repairs[0].relativePath).toBe(
      path.join('sessions', 'conv1', 'outputs', 'node_modules', '.bin', 'image-size'),
    );
    expect(
      estimateMigrationSpace(electronDir, inventory, null, repairs).existingBytes,
    ).toBeGreaterThan(0);

    // Preserve a partial directory created by the failed RC backup. The retry
    // must choose a fresh destination rather than mistaking it for complete.
    const partialBackup = path.join(
      root,
      BACKUP_DIRNAME,
      `migration-v${MIGRATION_VERSION}-${inventory.fingerprint.slice(0, 16)}`,
    );
    fs.mkdirSync(path.join(partialBackup, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(partialBackup, 'sessions', 'partial.txt'), 'keep me');

    const summary = runWith(fakeSecretStore(), { inventory });
    if ('skipped' in summary) throw new Error('v1 marker must not skip v2 migration');
    expect(summary.legacySymlinks).toMatchObject({ detected: 1, repaired: 1 });
    expect(summary.sentinelWritten).toBe(true);
    expect(path.normalize(fs.readlinkSync(legacyLink))).toBe(
      path.normalize(relativeTarget),
    );
    expect(path.normalize(fs.readlinkSync(path.join(
      summary.backup.path!,
      'sessions',
      'conv1',
      'outputs',
      'node_modules',
      '.bin',
      'image-size',
    )))).toBe(path.normalize(relativeTarget));
    expect(summary.backup.path).not.toBe(partialBackup);
    expect(fs.readFileSync(
      path.join(partialBackup, 'sessions', 'partial.txt'),
      'utf8',
    )).toBe('keep me');
    expect(fs.existsSync(
      path.join(summary.backup.path!, 'file-backup-manifest.json'),
    )).toBe(true);
    expect(fs.existsSync(
      path.join(summary.backup.path!, 'legacy-symlink-repairs.json'),
    )).toBe(true);
    expect(path.normalize(fs.readlinkSync(path.join(sourceBinDir, 'image-size')))).toBe(
      path.normalize(relativeTarget),
    );
  });

  it('still rejects unrelated absolute symlinks already present in Electron data', () => {
    seedTauriDir();
    fs.mkdirSync(path.join(electronDir, 'sessions'), { recursive: true });
    fs.symlinkSync(
      path.join(tauriDir, 'conversations', 'index.json'),
      path.join(electronDir, 'sessions', 'untrusted-link'),
      'file',
    );

    const summary = runWith(fakeSecretStore());
    if ('skipped' in summary) throw new Error('unexpected skip');
    expect(summary.legacySymlinkRepairError).toMatch(
      /absolute symbolic links are not allowed/,
    );
    expect(summary.sentinelWritten).toBe(false);
    expect(summary.backup.path).toBeNull();
  });

  it('rejects absolute source symlinks without writing a completion marker', () => {
    seedTauriDir();
    fs.symlinkSync(
      path.join(tauriDir, 'conversations', 'index.json'),
      path.join(tauriDir, 'conversations', 'linked-index.json'),
    );
    const store = fakeSecretStore();
    const summary = runWith(store);
    if ('skipped' in summary) throw new Error('unexpected skip');
    expect(summary.inventoryError).toMatch(/absolute symbolic links are not allowed/);
    expect(summary.sentinelWritten).toBe(false);
  });

  it('rejects relative source symlinks that escape the migrated tree', () => {
    seedTauriDir();
    fs.writeFileSync(path.join(root, 'outside.txt'), 'outside');
    fs.symlinkSync(
      '../../outside.txt',
      path.join(tauriDir, 'sessions', 'outside-link'),
      'file',
    );
    const summary = runWith(fakeSecretStore());
    if ('skipped' in summary) throw new Error('unexpected skip');
    expect(summary.inventoryError).toMatch(/symbolic link escapes transition data/);
    expect(summary.sentinelWritten).toBe(false);
  });

  it('rejects dangling relative source symlinks', () => {
    seedTauriDir();
    fs.symlinkSync(
      './missing.txt',
      path.join(tauriDir, 'sessions', 'dangling-link'),
      'file',
    );
    const summary = runWith(fakeSecretStore());
    if ('skipped' in summary) throw new Error('unexpected skip');
    expect(summary.inventoryError).toMatch(/dangling or looping symbolic links/);
    expect(summary.sentinelWritten).toBe(false);
  });
});
