'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  QUIET_WINDOW_ENV,
  resolveWindowShowPolicy,
  configureWindowShowPolicy,
  getWindowShowPolicy,
  revealWindow,
} = require('./windowShowPolicy.cjs');

/** A window that records which reveal method was called. */
function recordingWindow(calls) {
  return {
    show: () => calls.push('show'),
    showInactive: () => calls.push('showInactive'),
  };
}

const QUIET_INPUT = { env: { [QUIET_WINDOW_ENV]: '1' }, allowE2E: true, platform: 'darwin' };
const NORMAL_INPUT = { env: {}, allowE2E: true, platform: 'darwin' };

test('normal launches (flag unset) reveal windows the user-facing way', () => {
  assert.deepEqual(
    resolveWindowShowPolicy({ env: {}, allowE2E: true, platform: 'darwin' }),
    { quiet: false, hideDock: false },
  );
  assert.deepEqual(
    resolveWindowShowPolicy({ env: undefined, allowE2E: true, platform: 'darwin' }),
    { quiet: false, hideDock: false },
  );
});

test('E2E launches on macOS reveal inactive and hide the Dock icon', () => {
  assert.deepEqual(
    resolveWindowShowPolicy({
      env: { [QUIET_WINDOW_ENV]: '1' },
      allowE2E: true,
      platform: 'darwin',
    }),
    { quiet: true, hideDock: true },
  );
});

test('E2E launches on Windows/Linux reveal inactive without a Dock to hide', () => {
  for (const platform of ['win32', 'linux']) {
    assert.deepEqual(
      resolveWindowShowPolicy({
        env: { [QUIET_WINDOW_ENV]: '1' },
        allowE2E: true,
        platform,
      }),
      { quiet: true, hideDock: false },
      platform,
    );
  }
});

test('the flag is ignored outside the E2E gate (packaged build without opt-in)', () => {
  assert.deepEqual(
    resolveWindowShowPolicy({
      env: { [QUIET_WINDOW_ENV]: '1' },
      allowE2E: false,
      platform: 'darwin',
    }),
    { quiet: false, hideDock: false },
  );
});

test('only the exact value "1" enables quiet mode', () => {
  for (const value of ['', '0', 'true', 'yes']) {
    assert.equal(
      resolveWindowShowPolicy({
        env: { [QUIET_WINDOW_ENV]: value },
        allowE2E: true,
        platform: 'darwin',
      }).quiet,
      false,
      JSON.stringify(value),
    );
  }
});

test('revealWindow picks showInactive() only under the quiet policy', () => {
  const calls = [];
  const win = {
    show: () => calls.push('show'),
    showInactive: () => calls.push('showInactive'),
  };

  revealWindow(win, { quiet: true });
  revealWindow(win, { quiet: false });

  assert.deepEqual(calls, ['showInactive', 'show']);
});

test('a process that never configured the policy reveals the user-facing way', () => {
  // Fresh module instance: the shared one may already have been configured by
  // an earlier test in this file.
  const id = require.resolve('./windowShowPolicy.cjs');
  const cached = require.cache[id];
  delete require.cache[id];
  try {
    const fresh = require('./windowShowPolicy.cjs');
    assert.deepEqual(fresh.getWindowShowPolicy(), { quiet: false, hideDock: false });
    const calls = [];
    fresh.revealWindow(recordingWindow(calls));
    assert.deepEqual(calls, ['show']);
  } finally {
    delete require.cache[id];
    if (cached) require.cache[id] = cached;
  }
});

test('configureWindowShowPolicy resolves once and revealWindow() without a policy reads that resolution', () => {
  const calls = [];
  const win = recordingWindow(calls);

  const quiet = configureWindowShowPolicy(QUIET_INPUT);
  assert.deepEqual(quiet, { quiet: true, hideDock: true });
  assert.equal(getWindowShowPolicy(), quiet);
  revealWindow(win);

  const normal = configureWindowShowPolicy(NORMAL_INPUT);
  assert.deepEqual(normal, { quiet: false, hideDock: false });
  assert.equal(getWindowShowPolicy(), normal);
  revealWindow(win);

  assert.deepEqual(calls, ['showInactive', 'show']);
});

test('an explicit policy argument still wins over the configured one', () => {
  const calls = [];
  const win = recordingWindow(calls);
  configureWindowShowPolicy(NORMAL_INPUT);
  revealWindow(win, { quiet: true });
  configureWindowShowPolicy(QUIET_INPUT);
  revealWindow(win, { quiet: false });
  configureWindowShowPolicy(NORMAL_INPUT);
  assert.deepEqual(calls, ['showInactive', 'show']);
});

test('the configured policy is frozen so a caller cannot flip it by mutation', () => {
  const policy = configureWindowShowPolicy(NORMAL_INPUT);
  assert.throws(() => {
    policy.quiet = true; // file is strict-mode, so writing a frozen property throws
  }, TypeError);
  assert.equal(getWindowShowPolicy().quiet, false);
});
