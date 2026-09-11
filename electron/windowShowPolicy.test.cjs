'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  QUIET_WINDOW_ENV,
  resolveWindowShowPolicy,
  revealWindow,
} = require('./windowShowPolicy.cjs');

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
