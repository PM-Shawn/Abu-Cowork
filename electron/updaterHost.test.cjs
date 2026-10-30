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
const { EventEmitter } = require('node:events');
const { createMacUpdateReadiness } = require('./macUpdateReadiness.cjs');

test('Mac preparation waits for native staging after the download and reuses a prepared version', async () => {
  const native = new EventEmitter();
  const updater = new EventEmitter();
  updater.downloadUpdate = async () => [];
  const readiness = createMacUpdateReadiness(native);
  let completed = false;
  const pending = readiness.download(updater, '1.0.0').then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  native.emit('update-downloaded');
  await pending;
  await readiness.download(updater, '1.0.0');
  completed = false;
  const next = readiness.download(updater, '1.0.1').then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  native.emit('update-downloaded');
  await next;
  assert.equal(native.listenerCount('update-downloaded'), 1);
  assert.equal(updater.listenerCount('error'), 0);
});

test('Mac preparation accepts a native event emitted before download resolves', async () => {
  const native = new EventEmitter();
  const updater = new EventEmitter();
  updater.downloadUpdate = async () => { native.emit('update-downloaded'); return []; };
  await createMacUpdateReadiness(native).download(updater, '1.0.0');
});

test('Mac preparation timeout removes request listeners and a late ready event permits retry', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const native = new EventEmitter();
  const updater = new EventEmitter();
  updater.downloadUpdate = async () => [];
  const readiness = createMacUpdateReadiness(native, 100);
  const pending = readiness.download(updater, '1.0.0');
  const rejected = assert.rejects(pending, /ABU_UPDATE_PREPARATION_TIMEOUT/);
  await Promise.resolve();
  context.mock.timers.tick(100);
  await rejected;
  assert.equal(native.listenerCount('update-downloaded'), 1);
  assert.equal(updater.listenerCount('error'), 0);
  native.emit('update-downloaded');
  await readiness.download(updater, '1.0.0');
});

test('Mac preparation propagates a native error while download is pending and cleans up', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const native = new EventEmitter();
  const updater = new EventEmitter();
  let finish;
  updater.downloadUpdate = () => new Promise(resolve => { finish = resolve; });
  const readiness = createMacUpdateReadiness(native, 100);
  const pending = readiness.download(updater, '1.0.0');
  const rejected = assert.rejects(pending, /signature rejected/);
  native.emit('error', new Error('signature rejected'));
  await rejected;
  finish([]);
  await Promise.resolve();
  context.mock.timers.tick(100);
  assert.equal(native.listenerCount('error'), 1);
  assert.equal(updater.listenerCount('error'), 0);
});

test('Mac handoff is bounded when the native downloader never requests its ZIP, including retry', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const native = new EventEmitter();
  const updater = new EventEmitter();
  let finish;
  const download = new Promise(resolve => { finish = resolve; });
  let started = false;
  updater.downloadUpdate = () => {
    if (!started) { started = true; updater.emit('update-downloaded'); }
    return download;
  };
  const readiness = createMacUpdateReadiness(native, 100);
  let handoffs = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const rejected = assert.rejects(readiness.download(updater, '1.0.0', () => { handoffs++; }), /ABU_UPDATE_PREPARATION_TIMEOUT/);
    context.mock.timers.tick(100);
    await rejected;
    assert.equal(updater.listenerCount('update-downloaded'), 0);
  }
  assert.equal(handoffs, 2);
  native.emit('update-downloaded');
  finish([]);
  await readiness.download(updater, '1.0.0');
});

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
