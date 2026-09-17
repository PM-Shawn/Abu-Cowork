'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  QUIET_WINDOW_ENV,
  resolveWindowShowPolicy,
  revealWindow,
  withWindowInFront,
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

// The consequential-action dialog is asked while Abu is driving another app,
// which by then owns the foreground; the dialog is modal to Abu's window,
// behind it. Windows will not let a background process take the foreground,
// so the most consequential question of a run was the one most likely to be
// answered without being seen.
describe('withWindowInFront', () => {
  function fakeWindow(overrides = {}) {
    const calls = [];
    return {
      calls,
      alwaysOnTop: false,
      minimized: false,
      isAlwaysOnTop() { return this.alwaysOnTop; },
      isMinimized() { return this.minimized; },
      restore() { calls.push('restore'); this.minimized = false; },
      setAlwaysOnTop(value) { calls.push(`onTop:${value}`); this.alwaysOnTop = value; },
      show() { calls.push('show'); },
      ...overrides,
    };
  }

  test('raises the window, runs, and puts it back', async () => {
    const win = fakeWindow();
    const result = await withWindowInFront(win, async () => 'answered');
    assert.equal(result, 'answered');
    assert.deepEqual(win.calls, ['onTop:true', 'show', 'onTop:false']);
    assert.equal(win.alwaysOnTop, false);
  });

  // A dialog that throws must not leave the app pinned over everything the
  // user owns.
  test('puts it back when the dialog throws', async () => {
    const win = fakeWindow();
    await assert.rejects(
      withWindowInFront(win, async () => { throw new Error('dialog failed'); }),
      /dialog failed/,
    );
    assert.equal(win.alwaysOnTop, false);
  });

  test('respects a window the user had already pinned', async () => {
    const win = fakeWindow({ alwaysOnTop: true });
    await withWindowInFront(win, async () => null);
    assert.equal(win.alwaysOnTop, true, 'restored to pinned, not forced off');
  });

  test('un-minimizes before asking', async () => {
    const win = fakeWindow({ minimized: true });
    await withWindowInFront(win, async () => null);
    assert.ok(win.calls.includes('restore'));
  });

  // Asking from behind another window still beats not asking at all.
  test('still asks when the window cannot be raised', async () => {
    const win = fakeWindow({
      setAlwaysOnTop() { throw new Error('window destroyed'); },
    });
    assert.equal(await withWindowInFront(win, async () => 'asked'), 'asked');
  });

  test('asks without a window at all', async () => {
    assert.equal(await withWindowInFront(null, async () => 'asked'), 'asked');
  });
});
