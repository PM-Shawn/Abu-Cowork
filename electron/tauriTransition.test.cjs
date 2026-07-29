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
  hasValidSentinel,
  isAllowedKey,
  isValidValue,
} = require('./tauriLocalStorageMigration.cjs');
const {
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

test('sentinel is atomic, retryable, and never written on partial migration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-transition-test-'));
  const makePlan = () => ({
    status: 'pending',
    expectedKeys: ['abu-settings', 'abu_device_id'],
    rejectedKeys: [],
    electronDir: root,
    sourceDatabase: 'Local Storage/leveldb',
    secretMigrationFailed: false,
  });
  try {
    let plan = makePlan();
    const partial = finalizeTauriLocalStorageMigration(plan, {
      imported: ['abu-settings'],
      skippedExisting: [],
      failed: ['abu_device_id'],
    });
    assert.equal(partial.retry, true);
    assert.equal(fs.existsSync(path.join(root, SENTINEL_FILENAME)), false);

    plan = makePlan();
    plan.secretMigrationFailed = true;
    const secretFailure = finalizeTauriLocalStorageMigration(plan, {
      imported: ['abu-settings', 'abu_device_id'],
      skippedExisting: [],
      failed: [],
    });
    assert.equal(secretFailure.reason, 'secret-migration-failed');
    assert.equal(fs.existsSync(path.join(root, SENTINEL_FILENAME)), false);

    plan = makePlan();
    const complete = finalizeTauriLocalStorageMigration(plan, {
      imported: ['abu-settings'],
      skippedExisting: ['abu_device_id'],
      failed: [],
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
