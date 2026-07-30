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
import { writeTauriSecretsFile, encryptTauriEntries } from './tauriSecretsReader.cjs';
import {
  resolveTauriAppDataDir,
  runTauriMigration,
  estimateMigrationSpace,
  backupElectronChromiumState,
  SENTINEL_FILENAME,
  hasValidSentinel,
  sourceInventory,
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

  it('rejects source symlinks without writing a completion marker', () => {
    seedTauriDir();
    fs.symlinkSync(
      path.join(tauriDir, 'conversations', 'index.json'),
      path.join(tauriDir, 'conversations', 'linked-index.json'),
    );
    const store = fakeSecretStore();
    const summary = runWith(store);
    if ('skipped' in summary) throw new Error('unexpected skip');
    expect(summary.inventoryError).toMatch(/symbolic links are not allowed/);
    expect(summary.sentinelWritten).toBe(false);
  });
});
