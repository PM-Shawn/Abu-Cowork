'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  SENTINEL_FILENAME,
  collectKnownSecretKeys,
  collectValidatedItems,
  finalizeTauriLocalStorageMigration,
  hasLegacySourceEvidence,
  hasValidSentinel,
  isAllowedKey,
  isValidValue,
  migrateWindowsSecrets,
  prepareTauriLocalStorageMigration,
} = require('./tauriLocalStorageMigration.cjs');
const { runTauriMigration } = require('./tauriMigration.cjs');
const {
  isOfficialBuild,
  isTauriTransitionBuild,
  readReleaseMetadata,
} = require('./releaseMetadata.cjs');

test('migration is armed only by packaged boolean metadata', () => {
  const manifest = (value) => ({
    isPackaged: true,
    getAppPath: () => '/unused',
    value,
  });
  const readFileSync = (_path, _encoding) =>
    JSON.stringify({ abuRelease: { tauriMigration: current.value } });

  let current = manifest(true);
  assert.equal(isTauriTransitionBuild(current, { readFileSync }), true);
  assert.equal(isOfficialBuild(current, { readFileSync }), false);
  const readOfficialManifest = () =>
    JSON.stringify({ abuRelease: { officialBuild: true, tauriMigration: true } });
  assert.equal(
    isOfficialBuild(current, { readFileSync: readOfficialManifest }),
    true
  );
  current = manifest('true');
  assert.equal(isTauriTransitionBuild(current, { readFileSync }), false);
  current = { ...manifest(true), isPackaged: false };
  assert.equal(readReleaseMetadata(current, { readFileSync }), null);
});

test('release version helper rejects equal and older transition versions', async () => {
  const { assertNewerVersion, assertNotOlderTransitionVersion } = await import(
    '../scripts/validate-electron-transition-version.mjs'
  );
  assert.deepEqual(assertNewerVersion('v0.34.0', '0.33.0'), {
    candidateVersion: '0.34.0',
    currentVersion: '0.33.0',
  });
  assert.throws(() => assertNewerVersion('0.33.0', '0.33.0'), /must be newer/);
  assert.throws(() => assertNewerVersion('0.32.0', '0.33.0'), /must be newer/);
  assert.deepEqual(assertNotOlderTransitionVersion('v0.34.0', '0.34.0'), {
    candidateVersion: '0.34.0',
    currentVersion: '0.34.0',
  });
  assert.throws(
    () => assertNotOlderTransitionVersion('0.34.0', '0.35.0'),
    /must not replace newer/
  );
});

test('only validated Abu localStorage keys survive migration', () => {
  const settings = JSON.stringify({
    state: {
      providers: [{ id: 'custom-1' }],
      imageGeneration: { backends: [{ id: 'image-1' }] },
    },
    version: 42,
  });
  const collected = collectValidatedItems([
    { key: 'abu-settings', value: settings },
    { key: 'abu_device_id', value: 'device-1' },
    { key: 'other-app-token', value: 'must-not-cross' },
    { key: 'abu-chat', value: 'not-json' },
  ]);
  assert.deepEqual(
    collected.items.map((item) => item.key),
    ['abu-settings', 'abu_device_id']
  );
  assert.deepEqual(collected.rejectedKeys, ['abu-chat']);
  assert.equal(isAllowedKey('other-app-token'), false);
  assert.equal(isValidValue('abu-settings', settings), true);

  const secretKeys = collectKnownSecretKeys(collected.items);
  assert.equal(secretKeys.includes('provider:custom-1'), true);
  assert.equal(secretKeys.includes('imagegen:image-1'), true);
  assert.equal(secretKeys.includes('aux:webSearch'), true);
});

test('Windows secret migration requires live legacy source evidence', () => {
  assert.equal(
    hasLegacySourceEvidence(
      { sourceDatabase: null },
      { nothingToMigrate: true }
    ),
    false
  );
  assert.equal(
    hasLegacySourceEvidence(
      { sourceDatabase: null },
      {
        inventory: {
          conversations: { files: 0, bytes: 0 },
          notice: { files: 0, bytes: 0 },
        },
      }
    ),
    false
  );
  assert.equal(
    hasLegacySourceEvidence(
      { sourceDatabase: 'Local Storage/leveldb' },
      { nothingToMigrate: true }
    ),
    true
  );
  assert.equal(
    hasLegacySourceEvidence(
      { sourceDatabase: null },
      { inventory: { conversations: { files: 1, bytes: 0 } } }
    ),
    true
  );
  assert.equal(
    hasLegacySourceEvidence(
      { sourceDatabase: null },
      {
        skipped: 'already-migrated',
        inventory: { conversations: { files: 0, bytes: 0 } },
      }
    ),
    false
  );
  assert.equal(
    hasLegacySourceEvidence(
      { sourceDatabase: null },
      { skipped: 'already-migrated' }
    ),
    true
  );
});

test('deleted Windows legacy data skips stale Credential Manager probing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-transition-reset-'));
  let readerCalls = 0;
  try {
    const electronDir = path.join(root, 'electron');
    const fileMigrationResult = runTauriMigration({
      tauriDir: path.join(root, 'deleted-tauri-profile'),
      electronDir,
      secretHas: () => false,
      secretSet: () => {
        throw new Error('must not write when the Tauri profile is absent');
      },
    });
    assert.equal(fileMigrationResult.nothingToMigrate, true);
    assert.equal(fileMigrationResult.sentinelWritten, true);

    const plan = prepareTauriLocalStorageMigration({
      electronDir,
      platform: 'win32',
      storageRoot: path.join(root, 'deleted-webview2-profile'),
      readerPath: '/unused/tauri-transition-reader.exe',
    });
    assert.equal(plan.status, 'pending');
    assert.equal(plan.sourceDatabase, null);

    const hasLegacySource = hasLegacySourceEvidence(plan, fileMigrationResult);
    assert.equal(hasLegacySource, false);
    const summary = migrateWindowsSecrets(plan, {
      readerPath: '/unused/tauri-transition-reader.exe',
      hasLegacySource,
      runReader: () => {
        readerCalls += 1;
        return { entries: [], missing: [], failed: ['provider:openai'] };
      },
      secretHas: () => false,
      secretSet: () => {
        throw new Error('must not write without legacy source evidence');
      },
    });

    assert.equal(readerCalls, 0);
    assert.equal(summary.skippedReason, 'no-legacy-source-evidence');
    assert.deepEqual(summary.failed, []);
    assert.equal(plan.secretMigrationFailed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed Windows secret migration does not loop after an empty file migration completed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-transition-empty-retry-'));
  let readerCalls = 0;
  try {
    const tauriDir = path.join(root, 'empty-tauri-profile');
    const electronDir = path.join(root, 'electron');
    fs.mkdirSync(tauriDir, { recursive: true });

    const firstFileMigration = runTauriMigration({
      tauriDir,
      electronDir,
      secretHas: () => false,
      secretSet: () => {},
    });
    assert.equal(firstFileMigration.sentinelWritten, true);
    assert.equal(
      Object.values(firstFileMigration.inventory).some((entry) => entry.files > 0),
      false
    );

    const retriedFileMigration = runTauriMigration({
      tauriDir,
      electronDir,
      secretHas: () => false,
      secretSet: () => {},
    });
    assert.equal(retriedFileMigration.skipped, 'already-migrated');
    assert.deepEqual(retriedFileMigration.inventory, firstFileMigration.inventory);

    const plan = prepareTauriLocalStorageMigration({
      electronDir,
      platform: 'win32',
      storageRoot: path.join(root, 'deleted-webview2-profile'),
      readerPath: '/unused/tauri-transition-reader.exe',
    });
    assert.equal(plan.status, 'pending');
    const hasLegacySource = hasLegacySourceEvidence(plan, retriedFileMigration);
    assert.equal(hasLegacySource, false);

    const summary = migrateWindowsSecrets(plan, {
      readerPath: '/unused/tauri-transition-reader.exe',
      hasLegacySource,
      runReader: () => {
        readerCalls += 1;
        return { entries: [], missing: [], failed: ['provider:openai'] };
      },
      secretHas: () => false,
      secretSet: () => {},
    });
    assert.equal(readerCalls, 0);
    assert.equal(summary.skippedReason, 'no-legacy-source-evidence');
    assert.equal(plan.secretMigrationFailed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows secret writes still fail closed when legacy data exists', () => {
  const plan = {
    platform: 'win32',
    status: 'pending',
    items: [],
    secretMigrationFailed: false,
  };
  const summary = migrateWindowsSecrets(plan, {
    readerPath: '/unused/tauri-transition-reader.exe',
    hasLegacySource: true,
    runReader: () => ({
      entries: [{ key: 'provider:openai', value: 'legacy-secret' }],
      missing: [],
      failed: [],
    }),
    secretHas: () => false,
    secretSet: () => {
      throw new Error('safeStorage unavailable');
    },
  });

  assert.deepEqual(summary.failed, ['provider:openai']);
  assert.equal(plan.secretMigrationFailed, true);
});

test('sentinel is atomic, retryable, and never written on partial migration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-transition-test-'));
  const makePlan = () => ({
    status: 'pending',
    expectedKeys: ['abu-settings', 'abu_device_id'],
    rejectedKeys: [],
    electronDir: root,
    sourceDatabase: 'Local Storage/leveldb',
    sourceFingerprint: 'fixture-fingerprint',
    secretMigrationFailed: false,
  });
  try {
    let plan = makePlan();
    const partial = finalizeTauriLocalStorageMigration(plan, {
      imported: ['abu-settings'],
      overwritten: [],
      skippedExisting: [],
      failed: ['abu_device_id'],
      previous: [],
    });
    assert.equal(partial.retry, true);
    assert.equal(fs.existsSync(path.join(root, SENTINEL_FILENAME)), false);

    plan = makePlan();
    plan.secretMigrationFailed = true;
    const secretFailure = finalizeTauriLocalStorageMigration(plan, {
      imported: ['abu-settings', 'abu_device_id'],
      overwritten: [],
      skippedExisting: [],
      failed: [],
      previous: [],
    });
    assert.equal(secretFailure.reason, 'secret-migration-failed');
    assert.equal(fs.existsSync(path.join(root, SENTINEL_FILENAME)), false);

    plan = makePlan();
    const complete = finalizeTauriLocalStorageMigration(plan, {
      imported: ['abu-settings'],
      overwritten: [],
      skippedExisting: ['abu_device_id'],
      failed: [],
      previous: [],
    });
    assert.deepEqual(complete, { ok: true, retry: false });
    assert.equal(fs.existsSync(path.join(root, SENTINEL_FILENAME)), true);
    assert.equal(hasValidSentinel(root), true);
    assert.equal(
      fs.existsSync(path.join(root, `${SENTINEL_FILENAME}.tmp-${process.pid}`)),
      false
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a corrupt localStorage sentinel never suppresses a retry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-transition-sentinel-'));
  try {
    fs.writeFileSync(path.join(root, SENTINEL_FILENAME), '{"version":1');
    assert.equal(hasValidSentinel(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source-wins acknowledgement backs up replaced Electron localStorage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-transition-localstorage-backup-'));
  const electronDir = path.join(root, 'electron');
  const backupPath = path.join(root, 'backup');
  const plan = {
    status: 'pending',
    expectedKeys: ['abu-settings', 'abu-mcp-store'],
    rejectedKeys: [],
    electronDir,
    sourceDatabase: 'LocalStorage/localstorage.sqlite3',
    sourceFingerprint: 'backup-fixture-fingerprint',
    secretMigrationFailed: false,
    backupPath,
  };
  try {
    const result = finalizeTauriLocalStorageMigration(plan, {
      imported: ['abu-mcp-store'],
      overwritten: ['abu-settings'],
      skippedExisting: [],
      failed: [],
      previous: [
        {
          key: 'abu-settings',
          value: JSON.stringify({ state: { source: 'electron-test' }, version: 42 }),
        },
      ],
    });
    assert.deepEqual(result, { ok: true, retry: false });
    const backup = JSON.parse(
      fs.readFileSync(path.join(backupPath, 'electron-local-storage.json'), 'utf8')
    );
    assert.equal(backup.items[0].key, 'abu-settings');
    assert.match(backup.items[0].value, /electron-test/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
