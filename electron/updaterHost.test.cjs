'use strict';

/**
 * updaterHost — the arming gate and check()'s three-state contract.
 *
 * Regression anchor (2026-08-22, v0.41.0 post-release): a non-official
 * Windows package (no embedded app-update.yml, officialBuild=false) silently
 * disabled the updater, check() returned bare null, and the About section
 * rendered "已是最新版本" — users concluded no newer version existed. check()
 * must therefore never answer a dead updater with the same null that means
 * "feed queried, up to date".
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resolveUpdaterGate } = require('./updaterHost.cjs');

test('gate: packaged build without the official marker stays unarmed', () => {
  assert.deepEqual(
    resolveUpdaterGate({ isPackaged: true }, {}, { isOfficial: () => false }),
    { armed: false, reason: 'unofficial-build' }
  );
  // The dev-only feed override must not resurrect a fork package's updater.
  assert.deepEqual(
    resolveUpdaterGate(
      { isPackaged: true },
      { ABU_UPDATER_FEED_URL: 'http://127.0.0.1:9/feed' },
      { isOfficial: () => false }
    ),
    { armed: false, reason: 'unofficial-build' }
  );
});

test('gate: official packaged build arms and ignores the env override', () => {
  assert.deepEqual(
    resolveUpdaterGate({ isPackaged: true }, {}, { isOfficial: () => true }),
    { armed: true, ignoredEnvOverride: false }
  );
  assert.deepEqual(
    resolveUpdaterGate(
      { isPackaged: true },
      { ABU_UPDATER_FEED_URL: 'http://127.0.0.1:9/feed' },
      { isOfficial: () => true }
    ),
    { armed: true, ignoredEnvOverride: true }
  );
});

test('gate: dev shell arms only with ABU_UPDATER_FEED_URL', () => {
  assert.deepEqual(resolveUpdaterGate({ isPackaged: false }, {}), {
    armed: false,
    reason: 'dev-unarmed',
  });
  assert.deepEqual(
    resolveUpdaterGate({ isPackaged: false }, { ABU_UPDATER_FEED_URL: 'http://127.0.0.1:9/feed' }),
    { armed: true, feedOverride: 'http://127.0.0.1:9/feed' }
  );
});

/**
 * Load a fresh updaterHost instance whose `require('electron')` resolves to a
 * fake app, so the real check() wiring (getUpdater → disabled marker) runs
 * under plain Node. The electron cache slot is restored immediately so other
 * test files in the same process are unaffected.
 */
function loadUpdaterHostWithFakeApp(fakeApp) {
  const electronId = require.resolve('electron');
  const hostId = require.resolve('./updaterHost.cjs');
  const prevElectron = require.cache[electronId];
  delete require.cache[hostId];
  require.cache[electronId] = {
    id: electronId,
    filename: electronId,
    loaded: true,
    exports: { app: fakeApp },
  };
  try {
    return require('./updaterHost.cjs');
  } finally {
    if (prevElectron) require.cache[electronId] = prevElectron;
    else delete require.cache[electronId];
    // Drop the fake-app-bound instance so later require() calls rebuild.
    delete require.cache[hostId];
  }
}

test('check(): non-official packaged build answers a disabled marker, not null', async () => {
  // Empty app path → no release manifest → isOfficialBuild(app) is false.
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-updater-test-'));
  const host = loadUpdaterHostWithFakeApp({
    isPackaged: true,
    getAppPath: () => appPath,
    getVersion: () => '0.41.0',
  });

  const result = await host.updaterDispatch('plugin:updater|check', {});
  assert.deepEqual(result, { status: 'disabled', reason: 'unofficial-build' });

  fs.rmSync(appPath, { recursive: true, force: true });
});

test('check(): dev shell without a feed answers a disabled marker, not null', async () => {
  const prevFeed = process.env.ABU_UPDATER_FEED_URL;
  delete process.env.ABU_UPDATER_FEED_URL;
  try {
    const host = loadUpdaterHostWithFakeApp({
      isPackaged: false,
      getVersion: () => '0.41.0',
    });
    const result = await host.updaterDispatch('plugin:updater|check', {});
    assert.deepEqual(result, { status: 'disabled', reason: 'dev-unarmed' });
  } finally {
    if (prevFeed !== undefined) process.env.ABU_UPDATER_FEED_URL = prevFeed;
  }
});
